#!/usr/bin/env bash
# scripts/run-e2e-from-keyfile.sh KEYFILE [--dry-run]
#
# Runs docs/E2E.md step 15 with the buyer key read from KEYFILE, a file with two lines:
#   VECTOR_SIGNER_PRIVATE_KEY=ed25519_sk1...
#   VECTOR_SIGNER_ADDRESS=addr1...
# The file is sourced into the environment of this shell and never printed. Only the signer process reads the key.
# Every line of output is passed through a redaction filter that blanks anything shaped like a signer key, as a belt
# and braces measure: the script and the signer print no settings, but a stack trace could.
# The evidence of a finished run goes to evidence.json in the repository root; it and the state file e2e-state.json are git-ignored.
# SIGNER_ENTRY (the built signer) is required; ADVERT_REF defaults to the Agent History advert and can be overridden.
set -euo pipefail
KEYFILE="${1:?usage: run-e2e-from-keyfile.sh KEYFILE [--dry-run]}"
MODE="${2:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${SIGNER_ENTRY:?set SIGNER_ENTRY to the built signer, <mcp-server checkout>/packages/signer/build/index.js}"
export SIGNER_ENTRY
export ADVERT_REF="${ADVERT_REF:-b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0}"
[ -f "$KEYFILE" ] || { echo "key file not found: $KEYFILE" >&2; exit 2; }
[ -f "$SIGNER_ENTRY" ] || { echo "signer build not found: $SIGNER_ENTRY" >&2; exit 2; }
# The file may come from an editor or PowerShell: UTF-16, a byte-order mark, CRLF line endings. Normalise in a pipe; nothing is printed.
keyfile_utf8() {
  node -e '
    const fs = require("fs"); const b = fs.readFileSync(process.argv[1]);
    let t;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) t = b.slice(2).toString("utf16le");
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) t = b.slice(2).swap16().toString("utf16le");
    else t = b.toString("utf8").replace(/^﻿/, "");
    process.stdout.write(t.split(/\r?\n/).filter((l) => l.trim() !== "").join("\n") + "\n");
  ' "$KEYFILE"
}
set -a; . <(keyfile_utf8); set +a
: "${VECTOR_SIGNER_PRIVATE_KEY:?KEYFILE must set VECTOR_SIGNER_PRIVATE_KEY}"
: "${VECTOR_SIGNER_ADDRESS:?KEYFILE must set VECTOR_SIGNER_ADDRESS}"
redact() { sed -E 's/ed25519_sk1[0-9a-z]+/ed25519_sk1<redacted>/g; s/(VECTOR_SIGNER_PRIVATE_KEY[=: ]+)[^ "]+/\1<redacted>/g'; }
cd "$REPO"
echo "buyer address: $VECTOR_SIGNER_ADDRESS"
echo "advert: $ADVERT_REF"
if [ "$MODE" = "--dry-run" ]; then
  node scripts/e2e-hire.mjs --dry-run 2>&1 | redact
  exit "${PIPESTATUS[0]}"
fi
rc=0
node scripts/e2e-hire.mjs 2> >(redact >&2) > evidence.json.tmp || rc=$?
if [ "$rc" -eq 0 ] && [ -s evidence.json.tmp ]; then
  mv evidence.json.tmp evidence.json
  echo "evidence written to evidence.json"
else
  rm -f evidence.json.tmp
  echo "run stopped with exit code $rc (state kept in e2e-state.json)" >&2
fi
exit "$rc"
