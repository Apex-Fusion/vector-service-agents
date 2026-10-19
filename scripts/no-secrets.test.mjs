import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
const FORBIDDEN = /(mnemonic|seed phrase|PRIV_KEY_HEX=[0-9a-f]{64}|ed25519_sk1[0-9a-z]{20,})/i;
function walk(dir, out = []) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === 'node_modules' || e === '.git' || e === '.superpowers' || p === join('docs', 'superpowers')) continue; statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
test('no key material in the repo', () => {
  const hits = walk('.').filter((p) => /\.(ts|js|mjs|json|md|yml|yaml|example)$/.test(p) && !p.endsWith('no-secrets.test.mjs')).filter((p) => FORBIDDEN.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

// The keys a service of this repository holds are buyer keys: the Document Pipeline's and Advocate's, each read by the start of its service from one variable
// of its own and handed to the chain (ruling R-F16 of Plan E2). Every other agent service holds none, and no service source names the supplier key, which is
// the runtime's. So the name of an agent's own variable may stand in the start of that agent alone, and there in two ways only: read once, in the call that
// takes it, and named in prose (a comment or a message). Anything that would carry the key somewhere is refused: another read of the variable, the name used
// as the key of an object or assigned, a longer name that ends or begins with it, the variable of the other agent, the name in any other source, and, in every
// source of the two agents, any run of 64 hex characters, which is a key written out.
const AGENT_SRC = /(mnemonic|seed|PRIV_KEY_HEX)/i;
/** The start of each agent that holds a buyer key, and the one variable it reads the key from. */
const BUYER_KEY_VARIABLES = new Map([
  [join('agents', 'document-pipeline', 'src', 'start.ts'), 'PIPELINE_BUYER_PRIV_KEY_HEX'],
  [join('agents', 'advocate', 'src', 'start.ts'), 'ADVOCATE_BUYER_PRIV_KEY_HEX'],
]);
/** A source of an agent that holds a buyer key: every one of them is held to the run of 64 hex characters. */
const holdsBuyerKey = (path) => /^agents[\\/](?:document-pipeline|advocate)[\\/]src[\\/]/.test(path);
const ID = '[A-Za-z0-9_$]';
// A key written out, in any case.
const KEY_RUN = /[0-9a-fA-F]{64}/;
function keyWords(path, text) {
  if (holdsBuyerKey(path) && KEY_RUN.test(text)) return true;
  const name = BUYER_KEY_VARIABLES.get(path);
  if (name === undefined) return AGENT_SRC.test(text);
  // The name as a whole identifier: not the end or the start of a longer one.
  const whole = new RegExp(`(?<!${ID})${name}(?!${ID})`, 'g');
  // The one read: the call that takes the value of the variable, and the name to report it by.
  const theRead = `requiredEnv('${name}', env.${name},`;
  // Any other read of it: env.NAME, process.env.NAME, env['NAME'].
  const otherRead = new RegExp(`\\benv\\s*(?:\\.\\s*${name}(?!${ID})|\\[\\s*['"\`]${name}['"\`]\\s*\\])`);
  // The name used as a key or a binding, and not named in prose: NAME: NAME = NAME ??= NAME, NAME }
  const bound = new RegExp(`(?<!${ID})${name}(?!${ID})\\s*(?:\\?\\?=|\\|\\|=|&&=|[:=,}])`);
  if (text.split(theRead).length - 1 > 1) return true; // the read is in one place
  const rest = text.replaceAll(theRead, 'requiredEnv(');
  if (otherRead.test(rest) || bound.test(rest)) return true;
  // Only the agent's own name is taken out: the variable of the other agent, read or named, is still refused here.
  return AGENT_SRC.test(rest.replace(whole, ''));
}

test('no key handling in agent service sources', () => {
  const hits = walk('.').filter((p) => /^agents[\\/][^\\/]+[\\/]src[\\/]/.test(p)).filter((p) => keyWords(p, readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

test('the guard on service sources lets the start of the Document Pipeline and the start of Advocate each read its own buyer key variable in one place and name it in prose, and nothing else (ruling R-F16)', () => {
  const HEX = 'ab'.repeat(32); // a key written out
  /** The one read of a variable, as a start makes it. */
  const readOf = (name) => `const privateKeyHex = requiredEnv('${name}', env.${name}, 'the buyer key');`;
  for (const [start, NAME] of BUYER_KEY_VARIABLES) {
    const READ = readOf(NAME);
    const passes = [
      READ, // the one read: the value, and the name for the error it raises
      `// ${NAME} is the buyer key`, // a comment that names it
      ` * the key in ${NAME} goes to the chain`, // a doc comment
      `throw new Error('environment variable ${NAME} must be 64 lowercase hex characters');`, // a message
      'a message that says the key in ' + NAME + ' has the key hash',
      `refuseSecretIn(env, SEARCHED, [key], '${NAME}', (name) => name);`, // the name given as the line a secret belongs in
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
    for (const line of passes) assert.equal(keyWords(start, line), false, `${start} may have: ${line}`);
    for (const line of fails) assert.equal(keyWords(start, line), true, `${start} may not have: ${line}`);
    // The name stands in the start alone: another source of the same agent may not name it, not even in prose, and holds no key written out either.
    const server = join(dirname(start), 'server.ts');
    assert.equal(keyWords(server, `// ${NAME} is the buyer key`), true, `${server} may not name ${NAME}`);
    assert.equal(keyWords(server, `const k = '${HEX}';`), true, `${server} may not hold a key written out`);
  }
  // The variable of each agent is refused in the start of the other, read or named: both directions (ruling R-F16).
  const pipeline = join('agents', 'document-pipeline', 'src', 'start.ts');
  const advocate = join('agents', 'advocate', 'src', 'start.ts');
  for (const [start, other] of [[pipeline, 'ADVOCATE_BUYER_PRIV_KEY_HEX'], [advocate, 'PIPELINE_BUYER_PRIV_KEY_HEX']]) {
    assert.equal(keyWords(start, readOf(other)), true, `${start} may not read ${other}`);
    assert.equal(keyWords(start, `// ${other} is the key of the other agent`), true, `${start} may not name ${other}`);
  }
  // No other agent holds a key, and no other agent is held to the run of 64 hex characters (a registry asset name is one).
  assert.equal(keyWords(join('agents', 'agent-history', 'src', 'server.ts'), readOf('PIPELINE_BUYER_PRIV_KEY_HEX')), true, 'no other agent holds a key');
  assert.equal(keyWords(join('agents', 'audio-snippets', 'src', 'start.ts'), readOf('ADVOCATE_BUYER_PRIV_KEY_HEX')), true, 'nor does Audio Snippets');
  assert.equal(keyWords(join('agents', 'agent-history', 'src', 'report.ts'), `const asset = '${HEX}';`), false);
});
