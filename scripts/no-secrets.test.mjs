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

// The one key a service of this repository holds is the Document Pipeline's buyer key, which its start reads from one variable and hands to the chain
// (agents/document-pipeline/src/start.ts). Every other agent service holds none, and no service source names the supplier key, which is the runtime's.
// So in the sources of that one agent the name of the variable may stand in two ways only: read once, in the call that takes it, and named in prose (a comment
// or a message). Anything that would carry the key somewhere is refused: another read of the variable, the name used as the key of an object or assigned,
// a longer name that ends or begins with it, and any run of 64 hex characters, which is a key written out.
const AGENT_SRC = /(mnemonic|seed|PRIV_KEY_HEX)/i;
const BUYER_KEY_VARIABLE = 'PIPELINE_BUYER_PRIV_KEY_HEX';
const ID = '[A-Za-z0-9_$]';
// The name as a whole identifier: not the end or the start of a longer one.
const WHOLE = new RegExp(`(?<!${ID})${BUYER_KEY_VARIABLE}(?!${ID})`, 'g');
// The one read: the call that takes the value of the variable, and the name to report it by.
const THE_READ = `requiredEnv('${BUYER_KEY_VARIABLE}', env.${BUYER_KEY_VARIABLE},`;
// Any other read of it: env.NAME, process.env.NAME, env['NAME'].
const OTHER_READ = new RegExp(`\\benv\\s*(?:\\.\\s*${BUYER_KEY_VARIABLE}(?!${ID})|\\[\\s*['"\`]${BUYER_KEY_VARIABLE}['"\`]\\s*\\])`);
// The name used as a key or a binding, and not named in prose: NAME: NAME = NAME ??= NAME, NAME }
const BOUND = new RegExp(`(?<!${ID})${BUYER_KEY_VARIABLE}(?!${ID})\\s*(?:\\?\\?=|\\|\\|=|&&=|[:=,}])`);
// A key written out, in any case.
const KEY_RUN = /[0-9a-fA-F]{64}/;
const holdsBuyerKey = (path) => /^agents[\\/]document-pipeline[\\/]src[\\/]/.test(path);
function keyWords(path, text) {
  if (!holdsBuyerKey(path)) return AGENT_SRC.test(text);
  if (KEY_RUN.test(text)) return true;
  if (text.split(THE_READ).length - 1 > 1) return true; // the read is in one place
  const rest = text.replaceAll(THE_READ, 'requiredEnv(');
  if (OTHER_READ.test(rest) || BOUND.test(rest)) return true;
  return AGENT_SRC.test(rest.replace(WHOLE, ''));
}

test('no key handling in agent service sources', () => {
  const hits = walk('.').filter((p) => /^agents[\\/][^\\/]+[\\/]src[\\/]/.test(p)).filter((p) => keyWords(p, readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

test('the guard on service sources lets the Document Pipeline read its buyer key variable in one place and name it in prose, and nothing else', () => {
  const pipeline = join('agents', 'document-pipeline', 'src', 'start.ts');
  const NAME = BUYER_KEY_VARIABLE;
  const HEX = 'ab'.repeat(32); // a key written out
  const READ = `const privateKeyHex = requiredEnv('${NAME}', env.${NAME}, 'the buyer key');`;
  const passes = [
    READ, // the one read: the value, and the name for the error it raises
    `// ${NAME} is the buyer key`, // a comment that names it
    ` * the key in ${NAME} goes to the chain`, // a doc comment
    `throw new Error('environment variable ${NAME} must be 64 lowercase hex characters');`, // a message
    'a message that says the key in ' + NAME + ' has the key hash',
  ];
  const fails = [
    `${NAME} ??= '${HEX}'`, // assigned a key
    `process.env.${NAME} ??= '${HEX}'`, // the same through the environment
    `const env = { ${NAME}: '${HEX}' }`, // a key written out as a value
    `const env = { ${NAME}: key };`, // the name as the key of an object that carries a value
    `const { ${NAME} } = process.env;`, // taken out of the environment by destructuring
    `console.log(process.env.${NAME})`, // read to be printed
    `const key = env.${NAME};`, // read anywhere but in the one place
    `const key = process.env['${NAME}'];`,
    `const key = process.env["${NAME}"];`,
    `env.SUPPLIER_${NAME}`, // another name that ends in it
    `env.${NAME}S`, // another name that starts with it
    `env.${NAME}_COPY`,
    `const k = '${HEX}';`, // a run of 64 hex characters, a key in any form
    `const k = '${HEX.toUpperCase()}';`,
    `${READ}\n${READ}`, // two reads: the one place is one
    `${NAME} and a seed`,
    'the mnemonic',
    'env.SUPPLIER_PRIV_KEY_HEX', // the supplier key is the runtime's
  ];
  for (const line of passes) assert.equal(keyWords(pipeline, line), false, `may stand: ${line}`);
  for (const line of fails) assert.equal(keyWords(pipeline, line), true, `may not stand: ${line}`);
  // No other agent holds a key, and no other agent is held to the run of 64 hex characters (a registry asset name is one).
  assert.equal(keyWords(join('agents', 'agent-history', 'src', 'server.ts'), READ), true, 'no other agent holds a key');
  assert.equal(keyWords(join('agents', 'agent-history', 'src', 'report.ts'), `const asset = '${HEX}';`), false);
});
