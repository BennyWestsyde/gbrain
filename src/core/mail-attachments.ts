/**
 * Fork: on-demand Apple Mail attachment retrieval.
 *
 * Email pages written by platform/mail carry `email_account`,
 * `email_message_id` and `email_mailbox` frontmatter. These helpers find that
 * message in Mail.app over JXA (osascript) and list or save its attachments.
 * Nothing is downloaded until a caller asks for a specific attachment, and
 * nothing is stored in the brain.
 *
 * Attachment names and contents are untrusted email data: names are
 * sanitized to a single path component and files never overwrite.
 */

import { execFile } from 'child_process';
import { copyFileSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { extname, isAbsolute, join, resolve } from 'path';
import { createHash } from 'crypto';

export interface MailMessageRef {
  account: string;
  messageId: string;
  /** Mailbox the collector saw the message in; searched first. */
  mailbox?: string;
}

export interface MailAttachmentInfo {
  index: number;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  downloaded: boolean | null;
}

export interface MailMessageAttachments {
  subject: string;
  account: string;
  mailbox: string;
  /** Personal per `isPersonalMessage`; attachments must not be opened. */
  personal: boolean;
  attachments: MailAttachmentInfo[];
}

/** Envelope fields read from Mail.app, used for the personal-mail rule. */
export interface MailEnvelope {
  sender: string;
  /** To + Cc addresses. */
  recipients: string[];
  /** The account's own addresses. */
  accountAddresses: string[];
}

export interface SavedAttachment extends MailAttachmentInfo {
  path: string;
  sha256: string;
}

/** Runs a JXA script with one JSON argument and returns its stdout. */
export type JxaRunner = (script: string, arg: string, timeoutMs: number) => Promise<string>;

export class MailAttachmentError extends Error {
  constructor(message: string, readonly code: 'not_found' | 'invalid' | 'personal' | 'mail_error' = 'mail_error') {
    super(message);
    this.name = 'MailAttachmentError';
  }
}

export const DEFAULT_ATTACHMENT_DIR = join(tmpdir(), 'gbrain-mail-attachments');
const JXA_TIMEOUT_MS = 180_000;

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.key': 'application/x-iwork-keynote-sffkey',
  '.pages': 'application/x-iwork-pages-sffpages',
  '.numbers': 'application/x-iwork-numbers-sffnumbers',
  '.rtf': 'application/rtf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.ics': 'text/calendar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.eml': 'message/rfc822',
};

export function mimeTypeFor(name: string): string | null {
  return MIME_TYPES[extname(name).toLowerCase()] ?? null;
}

/** Pulls the Mail.app lookup keys out of a platform/mail email page. */
export function messageRefFromFrontmatter(frontmatter: Record<string, unknown>): MailMessageRef {
  const str = (key: string) => {
    const value = frontmatter[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const account = str('email_account');
  const messageId = str('email_rfc_message_id') ?? str('email_message_id');
  if (!account || !messageId) {
    throw new MailAttachmentError(
      'Page has no email_account / email_message_id frontmatter; it was not written by the Apple Mail collector.',
      'invalid',
    );
  }
  if (messageId.startsWith('synthetic-')) {
    throw new MailAttachmentError(
      'This email had no Message-ID header, so it cannot be located in Mail.app.',
      'not_found',
    );
  }
  return { account, messageId, mailbox: str('email_mailbox') };
}

export const PERSONAL_EMAIL_MESSAGE =
  'This is a personal email (sent from a personal-mail domain to only the account owner). ' +
  'Its attachments must not be opened by agents. Do not retry or work around this; ' +
  'if the user needs the file, they will open it themselves.';

function addressOf(value: string): string {
  const angle = /<([^>]+)>/.exec(value);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

/**
 * Personal mail: the sender's domain is one of `domains` (exact match, not
 * subdomains) and every To/Cc recipient is one of the account's own
 * addresses. Mail to a list, or with anyone else on To/Cc, is not personal.
 */
export function isPersonalMessage(envelope: MailEnvelope, domains: readonly string[]): boolean {
  if (domains.length === 0) return false;
  const sender = addressOf(envelope.sender);
  const at = sender.lastIndexOf('@');
  if (at < 0) return false;
  const domain = sender.slice(at + 1);
  if (!domains.some(d => d.trim().toLowerCase() === domain)) return false;
  const own = new Set(envelope.accountAddresses.map(addressOf));
  const recipients = envelope.recipients.map(addressOf).filter(Boolean);
  return recipients.length > 0 && recipients.every(r => own.has(r));
}

/** The flag platform/mail writes on personal email pages. */
export function isPersonalPage(frontmatter: Record<string, unknown>, tags: readonly string[] = []): boolean {
  const flag = frontmatter.email_personal;
  const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  return flag === true || flag === 'true' || tags.includes('email-personal') || fmTags.includes('email-personal');
}

/**
 * A single safe path component for an untrusted attachment name. Keeps
 * spaces and punctuation people use in filenames; drops separators, control
 * characters and leading dots.
 */
export function safeAttachmentFilename(name: string, index: number): string {
  let cleaned = (name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f/\\:]/g, '_')
    .replace(/^[\s.]+/, '')
    .trim();
  if (Buffer.byteLength(cleaned) > 200) {
    const ext = extname(cleaned).slice(0, 16);
    let stem = cleaned.slice(0, cleaned.length - ext.length);
    while (Buffer.byteLength(stem + ext) > 200) stem = stem.slice(0, -1);
    cleaned = stem + ext;
  }
  return cleaned || `attachment-${index}`;
}

/** `dir/name`, or `dir/name (1).ext`, … — never an existing file. */
function copyWithoutOverwrite(src: string, dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 1000; n++) {
    const candidate = join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      copyFileSync(src, candidate, constants.COPYFILE_EXCL);
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new MailAttachmentError(`Too many files named ${name} in ${dir}`);
}

/** Absolute destination directory; `~` expands to the home directory. */
export function resolveDestDir(destDir: string | undefined): string {
  if (!destDir) return DEFAULT_ATTACHMENT_DIR;
  const expanded = destDir === '~' || destDir.startsWith('~/') ? join(homedir(), destDir.slice(1)) : destDir;
  if (!isAbsolute(expanded)) {
    throw new MailAttachmentError(`dest_dir must be an absolute path (got ${destDir})`, 'invalid');
  }
  return resolve(expanded);
}

// ES5: JXA. Finds the account by name or address, looks in the hinted
// mailbox first, then every mailbox of the account (the message may have
// been archived or moved since collection).
const JXA_SCRIPT = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var app = Application('Mail');

  var account = null;
  var accounts = app.accounts();
  for (var ai = 0; ai < accounts.length; ai++) {
    var name = ''; try { name = accounts[ai].name(); } catch (e) {}
    var addrs = []; try { addrs = accounts[ai].emailAddresses(); } catch (e) {}
    if (name === p.account || addrs.indexOf(p.account) !== -1) { account = accounts[ai]; break; }
  }
  if (!account) return JSON.stringify({ error: 'not_found', message: 'Mail account not found: ' + p.account });

  var mailboxes = []; try { mailboxes = account.mailboxes(); } catch (e) {}
  var ordered = [];
  if (p.mailbox) {
    for (var hi = 0; hi < mailboxes.length; hi++) {
      var hn = ''; try { hn = mailboxes[hi].name(); } catch (e) {}
      if (hn.toLowerCase() === String(p.mailbox).toLowerCase()) ordered.push(mailboxes[hi]);
    }
  }
  for (var oi = 0; oi < mailboxes.length; oi++) {
    if (ordered.indexOf(mailboxes[oi]) === -1) ordered.push(mailboxes[oi]);
  }

  var ids = [p.messageId, '<' + p.messageId + '>'];
  var msg = null, foundIn = '';
  for (var mi = 0; mi < ordered.length && !msg; mi++) {
    for (var ii = 0; ii < ids.length && !msg; ii++) {
      var hits = [];
      try { hits = ordered[mi].messages.whose({ messageId: ids[ii] })(); } catch (e) {}
      if (hits.length) { msg = hits[0]; try { foundIn = ordered[mi].name(); } catch (e) {} }
    }
  }
  if (!msg) return JSON.stringify({ error: 'not_found', message: 'Message not found in Mail.app (deleted, or not synced on this Mac): ' + p.messageId });

  var subject = ''; try { subject = msg.subject() || ''; } catch (e) {}
  var sender = ''; try { sender = msg.sender() || ''; } catch (e) {}
  var recipients = [];
  var recipientLists = [];
  try { recipientLists.push(msg.toRecipients()); } catch (e) {}
  try { recipientLists.push(msg.ccRecipients()); } catch (e) {}
  for (var rl = 0; rl < recipientLists.length; rl++) {
    for (var ri = 0; ri < recipientLists[rl].length; ri++) {
      var addr = ''; try { addr = recipientLists[rl][ri].address() || ''; } catch (e) {}
      if (addr) recipients.push(addr);
    }
  }
  var accountAddresses = []; try { accountAddresses = account.emailAddresses(); } catch (e) {}
  var atts = []; try { atts = msg.mailAttachments(); } catch (e) {}
  var list = [];
  for (var i = 0; i < atts.length; i++) {
    var a = atts[i];
    var item = { index: i, name: '', size: null, downloaded: null };
    try { item.name = a.name() || ''; } catch (e) {}
    try { item.size = a.fileSize(); } catch (e) {}
    try { item.downloaded = a.downloaded(); } catch (e) {}
    list.push(item);
  }

  var saved = [];
  if (p.save && p.save.refuseIfPersonal) {
    var domain = sender.replace(/^.*<|>.*$/g, '').toLowerCase().split('@').pop();
    var own = accountAddresses.map(function (x) { return String(x).toLowerCase(); });
    var onlyOwn = recipients.length > 0 && recipients.every(function (r) { return own.indexOf(String(r).toLowerCase()) !== -1; });
    if (p.save.refuseIfPersonal.indexOf(domain) !== -1 && onlyOwn) {
      return JSON.stringify({ error: 'personal', message: 'personal email' });
    }
  }
  if (p.save) {
    for (var si = 0; si < p.save.indices.length; si++) {
      var idx = p.save.indices[si];
      if (idx < 0 || idx >= atts.length) continue;
      var out = p.save.dir + '/' + idx;
      try {
        app.save(atts[idx], { in: Path(out) });
        saved.push({ index: idx, path: out });
      } catch (e) {
        saved.push({ index: idx, error: String(e) });
      }
    }
  }
  return JSON.stringify({ subject: subject, mailbox: foundIn, sender: sender, recipients: recipients,
    accountAddresses: accountAddresses, attachments: list, saved: saved });
}
`;

export const osascriptRunner: JxaRunner = (script, arg, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      'osascript',
      ['-l', 'JavaScript', '-e', script, arg],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim();
          const hint = /-1743|not allowed|Not authorized/i.test(detail)
            ? ' Allow this app to control Mail in System Settings → Privacy & Security → Automation.'
            : '';
          reject(new MailAttachmentError(`osascript failed: ${detail}${hint}`));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });

interface JxaResult {
  error?: string;
  message?: string;
  subject: string;
  mailbox: string;
  sender?: string;
  recipients?: string[];
  accountAddresses?: string[];
  attachments: { index: number; name: string; size: number | null; downloaded: boolean | null }[];
  saved: { index: number; path?: string; error?: string }[];
}

async function callMail(
  ref: MailMessageRef,
  save: { indices: number[]; dir: string; refuseIfPersonal: string[] } | undefined,
  runner: JxaRunner,
): Promise<JxaResult> {
  const stdout = await runner(JXA_SCRIPT, JSON.stringify({ ...ref, save }), JXA_TIMEOUT_MS);
  let parsed: JxaResult;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new MailAttachmentError(`Unexpected osascript output: ${stdout.slice(0, 200)}`);
  }
  if (parsed.error === 'personal') throw new MailAttachmentError(PERSONAL_EMAIL_MESSAGE, 'personal');
  if (parsed.error) {
    throw new MailAttachmentError(parsed.message ?? parsed.error, parsed.error === 'not_found' ? 'not_found' : 'mail_error');
  }
  return parsed;
}

function toInfo(a: JxaResult['attachments'][number]): MailAttachmentInfo {
  return {
    index: a.index,
    name: a.name,
    size_bytes: typeof a.size === 'number' ? a.size : null,
    mime_type: mimeTypeFor(a.name),
    downloaded: typeof a.downloaded === 'boolean' ? a.downloaded : null,
  };
}

export async function listMailAttachments(
  ref: MailMessageRef,
  personalDomains: readonly string[] = [],
  runner: JxaRunner = osascriptRunner,
): Promise<MailMessageAttachments> {
  const result = await callMail(ref, undefined, runner);
  const envelope: MailEnvelope = {
    sender: result.sender ?? '',
    recipients: result.recipients ?? [],
    accountAddresses: result.accountAddresses ?? [],
  };
  return {
    subject: result.subject,
    account: ref.account,
    mailbox: result.mailbox,
    personal: isPersonalMessage(envelope, personalDomains),
    attachments: result.attachments.map(toInfo),
  };
}

export interface AttachmentSelector {
  /** Exact attachment name (case-insensitive). */
  name?: string;
  index?: number;
  all?: boolean;
}

export function selectAttachments(attachments: MailAttachmentInfo[], sel: AttachmentSelector): number[] {
  if (sel.all) return attachments.map(a => a.index);
  if (typeof sel.index === 'number') {
    if (!attachments.some(a => a.index === sel.index)) {
      throw new MailAttachmentError(`No attachment at index ${sel.index} (message has ${attachments.length}).`, 'not_found');
    }
    return [sel.index];
  }
  if (sel.name) {
    const wanted = sel.name.toLowerCase();
    const matches = attachments.filter(a => a.name.toLowerCase() === wanted);
    if (matches.length === 1) return [matches[0].index];
    if (matches.length > 1) {
      throw new MailAttachmentError(
        `${matches.length} attachments are named ${sel.name}; pass index instead (${matches.map(m => m.index).join(', ')}).`,
        'invalid',
      );
    }
    const names = attachments.map(a => a.name).join(', ') || '(none)';
    throw new MailAttachmentError(`No attachment named ${sel.name}. Attachments: ${names}`, 'not_found');
  }
  throw new MailAttachmentError('Choose an attachment: pass name, index, or all: true.', 'invalid');
}

export async function saveMailAttachments(
  ref: MailMessageRef,
  sel: AttachmentSelector,
  destDir: string | undefined,
  personalDomains: readonly string[] = [],
  runner: JxaRunner = osascriptRunner,
): Promise<{ message: MailMessageAttachments; saved: SavedAttachment[]; failed: { index: number; name: string; error: string }[] }> {
  const dir = resolveDestDir(destDir);
  const message = await listMailAttachments(ref, personalDomains, runner);
  if (message.personal) throw new MailAttachmentError(PERSONAL_EMAIL_MESSAGE, 'personal');
  const indices = selectAttachments(message.attachments, sel);

  mkdirSync(dir, { recursive: true });
  // Mail writes into a private staging dir; we copy out under a sanitized,
  // non-colliding name so an attachment name can never pick the path.
  const staging = mkdtempSync(join(tmpdir(), 'gbrain-mail-staging-'));
  try {
    // The save call re-checks inside Mail, so the message can't change
    // between the check above and the save.
    const domains = personalDomains.map(d => d.trim().toLowerCase()).filter(Boolean);
    const result = await callMail(ref, { indices, dir: staging, refuseIfPersonal: domains }, runner);
    const byIndex = new Map(message.attachments.map(a => [a.index, a]));
    const saved: SavedAttachment[] = [];
    const failed: { index: number; name: string; error: string }[] = [];
    for (const entry of result.saved) {
      const info = byIndex.get(entry.index);
      if (!info) continue;
      if (entry.error || !entry.path) {
        failed.push({ index: entry.index, name: info.name, error: entry.error ?? 'Mail did not save the file' });
        continue;
      }
      const staged = join(staging, String(entry.index));
      let size: number;
      try {
        size = statSync(staged).size;
      } catch {
        failed.push({ index: entry.index, name: info.name, error: 'Mail reported success but wrote no file' });
        continue;
      }
      const path = copyWithoutOverwrite(staged, dir, safeAttachmentFilename(info.name, entry.index));
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      saved.push({ ...info, size_bytes: size, downloaded: true, path, sha256 });
    }
    return { message, saved, failed };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
