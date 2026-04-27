#!/usr/bin/env bash
# Verify a compiled gbrain binary can initialize and reopen a PGLite brain.
# This catches Bun --compile asset regressions for pglite.data, WASM files,
# and extension tarballs before a local PATH shim is updated.

set -euo pipefail

BIN="${1:-bin/gbrain}"

if [[ ! -x "$BIN" ]]; then
  echo "[smoke-compiled-pglite] FAIL: binary is not executable: $BIN" >&2
  exit 1
fi

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/gbrain-compiled-pglite.XXXXXX")"
cleanup() {
  rm -rf "$ROOT"
}
trap cleanup EXIT

export GBRAIN_HOME="$ROOT/home"
DB_PATH="$ROOT/brain.pglite"

"$BIN" init --pglite --path "$DB_PATH" --json >/dev/null
"$BIN" stats >/dev/null

echo "[smoke-compiled-pglite] OK - compiled binary opens PGLite."
