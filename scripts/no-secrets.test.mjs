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

// The one key a service of this repository holds is the Document Pipeline's buyer key, which its start reads from this one variable and hands to the chain
// (agents/document-pipeline/src/start.ts). Every other agent service holds none, and no service source names the supplier key, which is the runtime's.
// So the guard strips that one name from the sources of that one agent before it looks for the words, and nothing else.
const AGENT_SRC = /(mnemonic|seed|PRIV_KEY_HEX)/i;
const BUYER_KEY_VARIABLE = 'PIPELINE_BUYER_PRIV_KEY_HEX';
const holdsBuyerKey = (path) => /^agents[\\/]document-pipeline[\\/]src[\\/]/.test(path);
const keyWords = (path, text) => AGENT_SRC.test(holdsBuyerKey(path) ? text.replaceAll(BUYER_KEY_VARIABLE, '') : text);

test('no key handling in agent service sources', () => {
  const hits = walk('.').filter((p) => /^agents[\\/][^\\/]+[\\/]src[\\/]/.test(p)).filter((p) => keyWords(p, readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

test('the guard on service sources lets through the name of the Document Pipeline\'s buyer key variable there, and nothing else', () => {
  const pipeline = join('agents', 'document-pipeline', 'src', 'start.ts');
  assert.equal(keyWords(pipeline, `env.${BUYER_KEY_VARIABLE}`), false, 'the buyer key variable, in the Document Pipeline');
  assert.equal(keyWords(pipeline, 'env.SUPPLIER_PRIV_KEY_HEX'), true, 'the supplier key is the runtime\'s');
  assert.equal(keyWords(pipeline, `env.${BUYER_KEY_VARIABLE}_COPY.PRIV_KEY_HEX`), true, 'only the name itself is let through');
  assert.equal(keyWords(pipeline, `${BUYER_KEY_VARIABLE} and a seed`), true);
  assert.equal(keyWords(pipeline, 'the mnemonic'), true);
  assert.equal(keyWords(join('agents', 'agent-history', 'src', 'server.ts'), `env.${BUYER_KEY_VARIABLE}`), true, 'no other agent holds a key');
});
