#!/usr/bin/env python3
"""Collect forwarded Gmail messages into the email-to-brain integration.

This uses an existing Google OAuth desktop client + token for a forwarding
mailbox. It writes deterministic JSON and a markdown digest under
~/.gbrain/integrations/email-to-brain/.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build


DEFAULT_ACCOUNT = os.environ.get("GBRAIN_GMAIL_ACCOUNT", "")
DEFAULT_AUTH_DIR = Path.home() / "Downloads" / "EmailExports"
DEFAULT_INTEGRATION_DIR = Path.home() / ".gbrain" / "integrations" / "email-to-brain"
DEFAULT_GBRAIN = Path.home() / ".bun" / "bin" / "gbrain"
MAX_PAGE_BYTES = 4_500_000
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

NOISE_SENDERS = (
    "noreply",
    "no-reply",
    "notifications@",
    "calendar-notification",
    "mailer-daemon",
    "postmaster",
    "donotreply",
)

SIGNATURE_PATTERNS = tuple(
    re.compile(pattern, re.I)
    for pattern in (
        "docusign",
        "dropbox sign",
        "hellosign",
        "pandadoc",
        "please sign",
        "signature needed",
        "ready for your signature",
        "everyone has signed",
        "you just signed",
    )
)


def iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def token_path(auth_dir: Path, account: str) -> Path:
    safe = account.replace("@", "_at_").replace(".", "_")
    return auth_dir / f"token_{safe}.json"


def client_secret_path(auth_dir: Path) -> Path:
    return auth_dir / "client_secret.json"


def ensure_dirs(root: Path) -> None:
    (root / "data" / "messages").mkdir(parents=True, exist_ok=True)
    (root / "data" / "digests").mkdir(parents=True, exist_ok=True)


def load_state(root: Path) -> dict:
    path = root / "data" / "state.json"
    if not path.exists():
        return {"known_ids": {}, "last_collect": None}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(root: Path, state: dict) -> None:
    path = root / "data" / "state.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_heartbeat(root: Path, event: str, status: str, details: dict | None = None, error: str | None = None) -> None:
    root.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": iso_now(),
        "event": event,
        "source_version": "0.7.0-gmail-forward",
        "status": status,
    }
    if details:
        entry["details"] = details
    if error:
        entry["error"] = error
    with (root / "heartbeat.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, sort_keys=True) + "\n")


def load_credentials(auth_dir: Path, account: str) -> Credentials:
    token = token_path(auth_dir, account)
    secret = client_secret_path(auth_dir)
    if not token.exists():
        raise FileNotFoundError(f"Missing token file: {token}")
    if not secret.exists():
        raise FileNotFoundError(f"Missing OAuth client secret: {secret}")

    creds = Credentials.from_authorized_user_file(str(token), SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        token.write_text(creds.to_json(), encoding="utf-8")
    if not creds.valid:
        raise RuntimeError(f"OAuth token is not valid: {token}")
    return creds


def authorize(args: argparse.Namespace) -> int:
    auth_dir = Path(args.auth_dir).expanduser()
    token = token_path(auth_dir, args.account)
    secret = client_secret_path(auth_dir)
    if not secret.exists():
        raise FileNotFoundError(f"Missing OAuth client secret: {secret}")

    flow = InstalledAppFlow.from_client_secrets_file(str(secret), SCOPES)
    creds = flow.run_local_server(
        port=0,
        open_browser=True,
        authorization_prompt_message=(
            "Opening Google OAuth for email-to-brain. If the browser does not open, visit:\n{url}\n"
        ),
        success_message="GBrain email-to-brain auth complete. You can close this tab.",
    )
    auth_dir.mkdir(parents=True, exist_ok=True)
    token.write_text(creds.to_json(), encoding="utf-8")

    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    profile = service.users().getProfile(userId="me").execute()
    print(json.dumps({
        "token": str(token),
        "emailAddress": profile.get("emailAddress"),
        "messagesTotal": profile.get("messagesTotal"),
        "threadsTotal": profile.get("threadsTotal"),
    }, indent=2, sort_keys=True))
    return 0


def gmail_link(account: str, message_id: str) -> str:
    return f"https://mail.google.com/mail/u/?authuser={quote(account)}#inbox/{message_id}"


def header_value(headers: list[dict], name: str) -> str:
    needle = name.lower()
    for h in headers:
        if h.get("name", "").lower() == needle:
            return h.get("value", "")
    return ""


def decode_part_data(data: str) -> str:
    if not data:
        return ""
    padding = "=" * (-len(data) % 4)
    raw = base64.urlsafe_b64decode(data + padding)
    return raw.decode("utf-8", errors="replace")


def strip_html(text: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\\1>", " ", text)
    text = re.sub(r"(?is)<br\\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p\\s*>", "\n\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return html.unescape(text)


def walk_parts(payload: dict) -> list[dict]:
    parts = [payload]
    out: list[dict] = []
    while parts:
        part = parts.pop()
        out.append(part)
        parts.extend(part.get("parts", []) or [])
    return out


def body_text(payload: dict) -> str:
    plain: list[str] = []
    html_parts: list[str] = []
    for part in walk_parts(payload):
        filename = part.get("filename") or ""
        if filename:
            continue
        mime = part.get("mimeType", "")
        data = (part.get("body") or {}).get("data", "")
        if not data:
            continue
        text = decode_part_data(data)
        if mime == "text/plain":
            plain.append(text)
        elif mime == "text/html":
            html_parts.append(strip_html(text))
    text = "\n\n".join(plain or html_parts)
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def attachment_names(payload: dict) -> list[str]:
    names: list[str] = []
    for part in walk_parts(payload):
        filename = part.get("filename") or ""
        if filename:
            names.append(filename)
    return names


def is_noise(record: dict) -> bool:
    sender = (record.get("from") or "").lower()
    return any(pattern in sender for pattern in NOISE_SENDERS)


def is_signature(record: dict) -> bool:
    text = f"{record.get('from', '')} {record.get('subject', '')}"
    return any(pattern.search(text) for pattern in SIGNATURE_PATTERNS)


def classify(record: dict) -> str:
    if is_signature(record):
        return "signature"
    if is_noise(record):
        return "noise"
    return "triage"


def message_to_record(account: str, message: dict) -> dict:
    payload = message.get("payload") or {}
    headers = payload.get("headers") or []
    text = body_text(payload)
    record = {
        "id": message["id"],
        "thread_id": message.get("threadId"),
        "account": account,
        "date": datetime.fromtimestamp(int(message.get("internalDate", "0")) / 1000, timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "from": header_value(headers, "From"),
        "to": header_value(headers, "To"),
        "cc": header_value(headers, "Cc"),
        "subject": header_value(headers, "Subject") or "(no subject)",
        "rfc_message_id": header_value(headers, "Message-ID").strip("<>"),
        "gmail_url": gmail_link(account, message["id"]),
        "labels": message.get("labelIds") or [],
        "attachments": attachment_names(payload),
        "snippet": re.sub(r"\s+", " ", text or message.get("snippet", ""))[:500],
        "body_text": text,
    }
    record["bucket"] = classify(record)
    return record


def build_service(auth_dir: Path, account: str):
    creds = load_credentials(auth_dir, account)
    return build("gmail", "v1", credentials=creds, cache_discovery=False)


def collect(args: argparse.Namespace) -> int:
    root = Path(args.integration_dir).expanduser()
    auth_dir = Path(args.auth_dir).expanduser()
    ensure_dirs(root)
    state = load_state(root)
    known: dict = state.setdefault("known_ids", {})

    service = build_service(auth_dir, args.account)
    profile = service.users().getProfile(userId="me").execute()
    actual_account = profile.get("emailAddress", args.account)

    response = service.users().messages().list(
        userId="me",
        q=args.query,
        maxResults=args.max_results,
        includeSpamTrash=False,
    ).execute()
    messages = response.get("messages", []) or []

    new_records: list[dict] = []
    duplicates = 0
    errors = 0
    for item in messages:
        msg_id = item["id"]
        if msg_id in known and not args.refresh_known:
            duplicates += 1
            continue
        try:
            msg = service.users().messages().get(userId="me", id=msg_id, format="full").execute()
            record = message_to_record(actual_account, msg)
            known[msg_id] = {
                "first_seen": known.get(msg_id, {}).get("first_seen") or iso_now(),
                "subject": record["subject"],
                "date": record["date"],
                "thread_id": record.get("thread_id"),
            }
            new_records.append(record)
        except Exception as exc:
            errors += 1
            if args.verbose:
                print(f"Error fetching {msg_id}: {exc}")

    new_records.sort(key=lambda r: r["date"], reverse=True)
    today = datetime.now(timezone.utc).date().isoformat()
    out_path = root / "data" / "messages" / f"{today}.json"
    existing: list[dict] = []
    if out_path.exists() and not args.overwrite:
        existing = json.loads(out_path.read_text(encoding="utf-8"))
    merged = existing + new_records
    out_path.write_text(json.dumps(merged, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    state["last_collect"] = iso_now()
    state["account"] = actual_account
    state["query"] = args.query
    state["auth_dir"] = str(auth_dir)
    save_state(root, state)

    details = {
        "account": actual_account,
        "query": args.query,
        "messages_file": str(out_path),
        "listed": len(messages),
        "new": len(new_records),
        "duplicates": duplicates,
        "errors": errors,
    }
    append_heartbeat(root, "collect", "ok" if errors == 0 else "warn", details=details)
    print(json.dumps(details, indent=2, sort_keys=True))
    return 0 if errors == 0 else 1


def load_digest_records(root: Path, date: str | None) -> list[dict]:
    messages_dir = root / "data" / "messages"
    if date:
        path = messages_dir / f"{date}.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    records: list[dict] = []
    for path in sorted(messages_dir.glob("*.json")):
        records.extend(json.loads(path.read_text(encoding="utf-8")))
    return records


def md_inline(text: str) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()


def yaml_quote(value: object) -> str:
    return json.dumps("" if value is None else str(value), ensure_ascii=False)


def slug_part(value: str) -> str:
    value = value.lower()
    value = re.sub(r"[^a-z0-9-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-")
    return value or "message"


def truncate_utf8(text: str, max_bytes: int = MAX_PAGE_BYTES) -> str:
    data = text.encode("utf-8")
    if len(data) <= max_bytes:
        return text
    truncated = data[:max_bytes].decode("utf-8", errors="ignore")
    return truncated + "\n\n[Truncated by email-to-brain collector: message exceeded page size limit.]\n"


def format_record(record: dict) -> str:
    attachments = record.get("attachments") or []
    attach = f" Attachments: {', '.join(attachments)}." if attachments else ""
    return (
        f"- **{md_inline(record.get('subject'))}** — {md_inline(record.get('from'))} — {record.get('date')}. "
        f"[Open in Gmail]({record.get('gmail_url')})\n"
        f"  {md_inline(record.get('snippet'))}{attach}"
    ).rstrip()


def render_digest(records: list[dict], digest_date: str) -> tuple[str, dict[str, list[dict]]]:
    buckets = {
        "signature": [r for r in records if r.get("bucket") == "signature"],
        "triage": [r for r in records if r.get("bucket") == "triage"],
        "noise": [r for r in records if r.get("bucket") == "noise"],
    }
    lines = [
        f"# Email-to-Brain Digest — {digest_date}",
        "",
        f"Records considered: {len(records)}",
        "",
    ]
    for key, title in (
        ("signature", "Signatures Pending"),
        ("triage", "Messages To Triage"),
        ("noise", "Noise"),
    ):
        lines.extend([f"## {title}", ""])
        if not buckets[key]:
            lines.extend(["_None._", ""])
            continue
        for record in buckets[key]:
            lines.append(format_record(record))
        lines.append("")
    return "\n".join(lines).rstrip() + "\n", buckets


def digest(args: argparse.Namespace) -> tuple[int, Path]:
    root = Path(args.integration_dir).expanduser()
    ensure_dirs(root)
    records = load_digest_records(root, args.date)
    records.sort(key=lambda r: r.get("date", ""), reverse=True)
    if args.limit > 0:
        records = records[: args.limit]

    digest_date = args.date or datetime.now(timezone.utc).date().isoformat()
    content, buckets = render_digest(records, digest_date)
    out_path = root / "data" / "digests" / f"{digest_date}.md"
    out_path.write_text(content, encoding="utf-8")
    append_heartbeat(root, "digest", "ok", details={
        "digest_file": str(out_path),
        "records": len(records),
        "signature": len(buckets["signature"]),
        "triage": len(buckets["triage"]),
        "noise": len(buckets["noise"]),
    })
    print(str(out_path))
    return 0, out_path


def digest_page_content(digest_path: Path, digest_date: str) -> str:
    body = digest_path.read_text(encoding="utf-8")
    return (
        "---\n"
        "type: source\n"
        f"title: Email-to-Brain Digest {digest_date}\n"
        "tags:\n"
        "  - email\n"
        "  - gmail\n"
        "  - forwarded-mail\n"
        "  - digest\n"
        "email_account: forwarded-mailbox\n"
        "---\n\n"
        f"Source digest file: `{digest_path}`\n\n"
        f"{body}"
    )


def message_page_relative_path(record: dict) -> Path:
    date = str(record.get("date") or datetime.now(timezone.utc).date().isoformat())[:10]
    msg_id = slug_part(str(record.get("id") or record.get("rfc_message_id") or "message"))
    return Path("email") / "messages" / date / f"{msg_id}.md"


def message_page_content(record: dict) -> str:
    subject = record.get("subject") or "(no subject)"
    date = record.get("date") or ""
    bucket = record.get("bucket") or "triage"
    tags = ["email", "gmail", "forwarded-mail", "message", f"email-{slug_part(bucket)}"]
    attachments = record.get("attachments") or []
    labels = record.get("labels") or []
    body = record.get("body_text") or record.get("snippet") or ""
    body = body.strip() or "_No text body extracted._"

    lines = [
        "---",
        "type: source",
        f"title: {yaml_quote('Email: ' + str(subject))}",
        "tags:",
        *[f"  - {yaml_quote(tag)}" for tag in tags],
        f"email_account: {yaml_quote(record.get('account'))}",
        f"email_message_id: {yaml_quote(record.get('id'))}",
        f"email_thread_id: {yaml_quote(record.get('thread_id'))}",
        f"email_rfc_message_id: {yaml_quote(record.get('rfc_message_id'))}",
        f"email_bucket: {yaml_quote(bucket)}",
        f"email_date: {yaml_quote(date)}",
        "---",
        "",
        f"# {subject}",
        "",
        f"- From: {record.get('from') or ''}",
        f"- To: {record.get('to') or ''}",
        f"- Cc: {record.get('cc') or ''}",
        f"- Date: {date}",
        f"- Gmail: [Open message]({record.get('gmail_url') or ''})",
        f"- Bucket: {bucket}",
    ]
    if labels:
        lines.append(f"- Labels: {', '.join(labels)}")
    if attachments:
        lines.append(f"- Attachments: {', '.join(attachments)}")
    lines.extend(["", "## Body", "", body, ""])
    return truncate_utf8("\n".join(lines))


def import_digest(args: argparse.Namespace, digest_path: Path | None = None) -> int:
    root = Path(args.integration_dir).expanduser()
    digest_date = args.date or datetime.now(timezone.utc).date().isoformat()
    if digest_path is None:
        digest_path = root / "data" / "digests" / f"{digest_date}.md"
    if not digest_path.exists():
        raise FileNotFoundError(f"Digest not found: {digest_path}")

    gbrain = Path(args.gbrain).expanduser()
    content = digest_page_content(digest_path, digest_date)
    slug = f"email/digests/{digest_date}"
    result = subprocess.run(
        [str(gbrain), "put", slug],
        input=content,
        text=True,
        capture_output=True,
        cwd=str(Path.cwd()),
    )
    details = {
        "slug": slug,
        "digest_file": str(digest_path),
        "gbrain": str(gbrain),
        "returncode": result.returncode,
    }
    if result.returncode == 0:
        append_heartbeat(root, "import", "ok", details=details)
        if result.stdout.strip():
            print(result.stdout.strip())
        print(json.dumps(details, indent=2, sort_keys=True))
        return 0

    append_heartbeat(root, "import", "error", details=details, error=result.stderr.strip())
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode


def import_message_pages(args: argparse.Namespace) -> int:
    root = Path(args.integration_dir).expanduser()
    records = load_digest_records(root, args.date)
    message_limit = getattr(args, "message_limit", 0)
    if message_limit > 0:
        records = sorted(records, key=lambda r: r.get("date", ""), reverse=True)[:message_limit]

    page_root = root / "data" / "page-import"
    written = 0
    for record in records:
        rel = message_page_relative_path(record)
        path = page_root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        content = message_page_content(record)
        if path.exists() and path.read_text(encoding="utf-8") == content:
            continue
        path.write_text(content, encoding="utf-8")
        written += 1

    gbrain = Path(args.gbrain).expanduser()
    result = subprocess.run(
        [str(gbrain), "import", str(page_root), "--no-embed"],
        text=True,
        capture_output=True,
        cwd=str(Path.cwd()),
    )
    details = {
        "page_root": str(page_root),
        "records": len(records),
        "written": written,
        "gbrain": str(gbrain),
        "returncode": result.returncode,
    }
    if result.returncode == 0:
        append_heartbeat(root, "import_messages", "ok", details=details)
        if result.stdout.strip():
            print(result.stdout.strip())
        print(json.dumps(details, indent=2, sort_keys=True))
        return 0

    append_heartbeat(root, "import_messages", "error", details=details, error=result.stderr.strip())
    if result.stdout.strip():
        print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr.strip())
    return result.returncode


def status(args: argparse.Namespace) -> int:
    root = Path(args.integration_dir).expanduser()
    auth_dir = Path(args.auth_dir).expanduser()
    state = load_state(root)
    data = {
        "integration_dir": str(root),
        "auth_dir": str(auth_dir),
        "account": state.get("account", args.account),
        "known_ids": len(state.get("known_ids", {})),
        "last_collect": state.get("last_collect"),
        "token_exists": token_path(auth_dir, args.account).exists(),
        "client_secret_exists": client_secret_path(auth_dir).exists(),
        "heartbeat_exists": (root / "heartbeat.jsonl").exists(),
    }
    print(json.dumps(data, indent=2, sort_keys=True))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Collect forwarded Gmail into gbrain email-to-brain")
    parser.add_argument("command", choices=["auth", "collect", "digest", "import", "import-messages", "run", "status"])
    parser.add_argument("--account", default=DEFAULT_ACCOUNT)
    parser.add_argument("--auth-dir", default=str(DEFAULT_AUTH_DIR))
    parser.add_argument("--integration-dir", default=str(DEFAULT_INTEGRATION_DIR))
    parser.add_argument("--query", default="newer_than:14d -in:spam -in:trash")
    parser.add_argument("--max-results", type=int, default=50)
    parser.add_argument("--date", help="Digest date YYYY-MM-DD; default writes today's digest from all stored records")
    parser.add_argument("--limit", type=int, default=80, help="Digest max records; 0 means no limit")
    parser.add_argument("--message-limit", type=int, default=0, help="Per-message page import max records; 0 means no limit")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--refresh-known", action="store_true")
    parser.add_argument("--no-import", action="store_true", help="For run: collect+digest only, do not import into gbrain")
    parser.add_argument("--no-message-pages", action="store_true", help="For run: import digest page only, not per-message pages")
    parser.add_argument("--gbrain", default=str(DEFAULT_GBRAIN), help="Path to gbrain executable")
    parser.add_argument("--verbose", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not args.account:
        raise SystemExit("Missing Gmail account. Pass --account or set GBRAIN_GMAIL_ACCOUNT.")
    if args.command == "auth":
        return authorize(args)
    if args.command == "collect":
        return collect(args)
    if args.command == "digest":
        code, _ = digest(args)
        return code
    if args.command == "import":
        return import_digest(args)
    if args.command == "import-messages":
        return import_message_pages(args)
    if args.command == "run":
        collect(args)
        code, digest_path = digest(args)
        if code != 0:
            return code
        if args.no_import:
            return 0
        code = import_digest(args, digest_path)
        if code != 0 or args.no_message_pages:
            return code
        return import_message_pages(args)
    if args.command == "status":
        return status(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    raise SystemExit(main())
