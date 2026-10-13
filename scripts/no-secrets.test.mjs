import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const FORBIDDEN = /(mnemonic|seed phrase|PRIV_KEY_HEX=[0-9a-f]{64}|ed25519_sk1[0-9a-z]{20,})/i;
function walk(dir, out = []) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === 'node_modules' || e === '.git' || e === '.superpowers' || p === join('docs', 'superpowers')) continue; statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
test('no key material in the repo', () => {
  const hits = walk('.').filter((p) => /\.(ts|js|mjs|json|md|yml|yaml|example)$/.test(p) && !p.endsWith('no-secrets.test.mjs')).filter((p) => FORBIDDEN.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});
