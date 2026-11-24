import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
const FORBIDDEN = /(mnemonic|seed phrase|PRIV_KEY_HEX=[0-9a-f]{64}|ed25519_sk1[0-9a-z]{20,})/i;
function walk(dir, out = []) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === 'node_modules' || e === '.git' || e === '.superpowers' || p === join('docs', 'superpowers')) continue; statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
test('no key material in the repo', () => {
  const hits = walk('.').filter((p) => /\.(ts|js|mjs|json|md|yml|yaml|example)$/.test(p) && !p.endsWith('no-secrets.test.mjs')).filter((p) => FORBIDDEN.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

// A service of this repository holds the keys that its start reads from the environment and hands to the chain. It holds a service key. An agent with subagents also holds
// delegation keys and subagent keys. The Document Pipeline and Advocate each hold one key, the buyer key. Each key has a variable of its own, and
// the name of the variable ends in _PRIV_KEY_HEX. The supplier key is the runtime's: no service source names it.
// KEY_VARIABLES lists the variables that the start of each agent names. A start reads only these. The name of a variable may stand in that start alone, and there in two ways only:
// read once, in the call that takes it, and named in prose (a comment or a message). The guard refuses anything that would carry a key somewhere else: another read of the
// variable; the name as the key of an object, or assigned; a longer name that ends or begins with it; a key variable that the start does not name (the supplier key, the variable
// of another agent, a variable that no list names); the name in any other source; and, in every source of an agent that holds keys, any run of 64 hex characters, which is a key written out.
const AGENT_SRC = /(mnemonic|seed|PRIV_KEY_HEX)/i;
/**
 * The start of each agent that holds keys, and the variables that it reads them from: the service key, the delegation keys and the subagent keys.
 * A new agent that holds a key fails the tests until its start is listed here.
 */
const KEY_VARIABLES = new Map([
  [join('agents', 'document-pipeline', 'src', 'start.ts'), { service: 'PIPELINE_BUYER_PRIV_KEY_HEX', delegation: [], subagent: [] }],
  [join('agents', 'advocate', 'src', 'start.ts'), { service: 'ADVOCATE_BUYER_PRIV_KEY_HEX', delegation: [], subagent: [] }],
  [join('agents', 'order-desk', 'src', 'serve', 'start.ts'), { service: 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', delegation: [], subagent: [] }],
  [join('agents', 'reorder-agent', 'src', 'serve', 'start.ts'), { service: 'REORDER_SERVICE_PRIV_KEY_HEX', delegation: ['REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PRIV_KEY_HEX'], subagent: ['STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX'] }],
  [join('agents', 'prior-authorization-agent', 'src', 'serve', 'start.ts'), { service: 'PRIORAUTH_SERVICE_PRIV_KEY_HEX', delegation: ['PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX', 'PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX'], subagent: ['RECORD_READER_AUTH_PRIV_KEY_HEX', 'RECORD_READER_DELEGATION_PRIV_KEY_HEX', 'DRAFTER_AUTH_PRIV_KEY_HEX', 'DRAFTER_DELEGATION_PRIV_KEY_HEX'] }],
]);
const variablesOf = (keys) => [keys.service, ...keys.delegation, ...keys.subagent];
/** A source of an agent that holds keys: every source in the folder of its start is held to the run of 64 hex characters. */
const holdsKeys = (path, table) => [...table.keys()].some((start) => path.startsWith(`${dirname(start)}${sep}`));
const ID = '[A-Za-z0-9_$]';
// A key written out, in any case.
const KEY_RUN = /[0-9a-fA-F]{64}/;
const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
/** The one read of a variable: the call that takes the value of the variable, and the name to report it by. */
const readForm = (name) => `requiredEnv('${name}', env.${name},`;
function keyWords(path, text, table = KEY_VARIABLES) {
  if (holdsKeys(path, table) && KEY_RUN.test(text)) return true;
  const keys = table.get(path);
  if (keys === undefined) return AGENT_SRC.test(text);
  const names = variablesOf(keys);
  if (names.some((name) => text.split(readForm(name)).length - 1 > 1)) return true; // each read is in one place
  const rest = names.reduce((left, name) => left.replaceAll(readForm(name), 'requiredEnv('), text);
  // Any other read of a variable: env.NAME, process.env.NAME, env['NAME'], and each of them through optional chaining, env?.NAME and env?.['NAME'].
  const otherRead = (name) => new RegExp(`\\benv\\s*(?:\\??\\.\\s*${escapeRegExp(name)}(?!${ID})|(?:\\?\\.\\s*)?\\[\\s*['"\`]${escapeRegExp(name)}['"\`]\\s*\\])`);
  // A name used as a key or a binding, and not named in prose: NAME: NAME = NAME ??= NAME, NAME }
  const bound = (name) => new RegExp(`(?<!${ID})${escapeRegExp(name)}(?!${ID})\\s*(?:\\?\\?=|\\|\\|=|&&=|[:=,}])`);
  if (names.some((name) => otherRead(name).test(rest) || bound(name).test(rest))) return true;
  // Only the names of the start are taken out, each as a whole identifier: not the end or the start of a longer one. Any other key variable, read or named, is still refused here.
  const unnamed = names.reduce((left, name) => left.replace(new RegExp(`(?<!${ID})${escapeRegExp(name)}(?!${ID})`, 'g'), ''), rest);
  return AGENT_SRC.test(unnamed);
}

test('no key handling in agent service sources', () => {
  const hits = walk('.').filter((p) => /^agents[\\/][^\\/]+[\\/]src[\\/]/.test(p)).filter((p) => keyWords(p, readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});

const HEX = 'ab'.repeat(32); // a key written out
/** The one read of a variable, as a start makes it. */
const readOf = (name) => `const privateKeyHex = requiredEnv('${name}', env.${name}, 'the buyer key');`;
/** The lines that the start of an agent may have for one variable, and the lines that it may not. */
function casesOf(NAME) {
  const READ = readOf(NAME);
  return {
    passes: [
      READ, // the one read: the value, and the name for the error it raises
      `// ${NAME} is the buyer key`, // a comment that names it
      ` * the key in ${NAME} goes to the chain`, // a doc comment
      `throw new Error('environment variable ${NAME} must be 64 lowercase hex characters');`, // a message
      'a message that says the key in ' + NAME + ' has the key hash',
      `refuseSecretIn(env, SEARCHED, [key], '${NAME}', (name) => name);`, // the name given as the line a secret belongs in
    ],
    fails: [
      `${NAME} ??= '${HEX}'`, // assigned a key
      `process.env.${NAME} ??= '${HEX}'`, // the same through the environment
      `const env = { ${NAME}: '${HEX}' }`, // a key written out as a value
      `const env = { ${NAME}: key };`, // the name as the key of an object that carries a value
      `const { ${NAME} } = process.env;`, // taken out of the environment by destructuring
      `console.log(process.env.${NAME})`, // read to be printed
      `const key = env.${NAME};`, // read anywhere but in the one place
      `const key = process.env['${NAME}'];`,
      `const key = process.env["${NAME}"];`,
      `const key = env["${NAME}"];`,
      `const key = env?.${NAME};`, // read through optional chaining
      `const key = process.env?.${NAME};`,
      `const key = env?.['${NAME}'];`,
      `const key = process.env?.["${NAME}"];`,
      `env.SUPPLIER_${NAME}`, // another name that ends in it
      `env.${NAME}S`, // another name that starts with it
      `env.${NAME}_COPY`,
      `const k = '${HEX}';`, // a run of 64 hex characters, a key in any form
      `const k = '${HEX.toUpperCase()}';`,
      `${READ}\n${READ}`, // two reads: the one place is one
      `${NAME} and a seed`,
      'the mnemonic',
      'env.SUPPLIER_PRIV_KEY_HEX', // the supplier key is the runtime's
    ],
  };
}

test('the guard on service sources lets the start of the Document Pipeline and the start of Advocate each read its own buyer key variable in one place and name it in prose, and nothing else', () => {
  for (const [start, keys] of KEY_VARIABLES) {
    for (const NAME of variablesOf(keys)) {
      const { passes, fails } = casesOf(NAME);
      for (const line of passes) assert.equal(keyWords(start, line), false, `${start} may have: ${line}`);
      for (const line of fails) assert.equal(keyWords(start, line), true, `${start} may not have: ${line}`);
      // The name stands in the start alone: another source of the same agent may not name it, not even in prose, and holds no key written out either.
      const server = join(dirname(start), 'server.ts');
      assert.equal(keyWords(server, `// ${NAME} is the buyer key`), true, `${server} may not name ${NAME}`);
      assert.equal(keyWords(server, `const k = '${HEX}';`), true, `${server} may not hold a key written out`);
    }
  }
  // The variable of each agent is refused in the start of the other, read or named: both directions.
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

// ---- A service with several keys: the service key, the delegation keys and the subagent keys ----
// An agent with subagents has such a service. These two starts exist for the test only: a hub with a service key, two delegation keys and three subagent keys, and a spoke with a service key and one delegation key.
const HUB = join('agents', 'fixture-hub', 'src', 'start.ts');
const SPOKE = join('agents', 'fixture-spoke', 'src', 'start.ts');
const SEVERAL = new Map([
  [HUB, { service: 'HUB_SERVICE_PRIV_KEY_HEX', delegation: ['HUB_DELEGATION_1_PRIV_KEY_HEX', 'HUB_DELEGATION_2_PRIV_KEY_HEX'], subagent: ['HUB_SCORER_1_PRIV_KEY_HEX', 'HUB_SCORER_2_PRIV_KEY_HEX', 'HUB_SCORER_3_PRIV_KEY_HEX'] }],
  [SPOKE, { service: 'SPOKE_SERVICE_PRIV_KEY_HEX', delegation: ['SPOKE_DELEGATION_1_PRIV_KEY_HEX'], subagent: [] }],
]);

test('the guard lets the start of a service with several keys read the service key, the delegation keys and the subagent keys that it names, each in one place, and keeps for each of them every refusal of the start with one key', () => {
  for (const [start, keys] of SEVERAL) {
    const names = variablesOf(keys);
    assert.equal(keyWords(start, names.map(readOf).join('\n'), SEVERAL), false, `${start} may read all its variables, each in one place`);
    assert.equal(keyWords(start, names.map((name) => `// ${name} is a key`).join('\n'), SEVERAL), false, `${start} may name all its variables in prose`);
    for (const name of names) {
      const { passes, fails } = casesOf(name);
      for (const line of passes) assert.equal(keyWords(start, line, SEVERAL), false, `${start} may have: ${line}`);
      for (const line of fails) assert.equal(keyWords(start, line, SEVERAL), true, `${start} may not have: ${line}`);
    }
  }
});

test('a start reads only the key variables that it names: the supplier key, the keys of another agent and a key that no list names are refused, read or named, and the same lines pass where the variable is named', () => {
  const [hub, spoke] = [SEVERAL.get(HUB), SEVERAL.get(SPOKE)];
  const foreign = [
    ['a delegation key that the list does not name', 'HUB_DELEGATION_3_PRIV_KEY_HEX'],
    ['a subagent key that the list does not name', 'HUB_SCORER_4_PRIV_KEY_HEX'],
    ['the supplier key, which is the runtime\'s', 'SUPPLIER_PRIV_KEY_HEX'],
    ['the service key of the spoke', spoke.service],
    ['the delegation key of the spoke', spoke.delegation[0]],
    ['a key variable that no list names', 'SOMEONE_ELSE_PRIV_KEY_HEX'],
  ];
  for (const [what, name] of foreign) {
    assert.equal(keyWords(HUB, readOf(name), SEVERAL), true, `the hub may not read ${what}`);
    assert.equal(keyWords(HUB, `// ${name} is a key`, SEVERAL), true, `the hub may not name ${what}`);
  }
  // Both directions: each key of the hub is refused in the start of the spoke, read or named, and the key of the spoke is read where it is named.
  for (const name of variablesOf(hub)) {
    assert.equal(keyWords(SPOKE, readOf(name), SEVERAL), true, `the spoke may not read ${name}`);
    assert.equal(keyWords(SPOKE, `// ${name} is a key`, SEVERAL), true, `the spoke may not name ${name}`);
  }
  assert.equal(keyWords(SPOKE, readOf(spoke.delegation[0]), SEVERAL), false, 'the spoke reads its own delegation key');
  assert.equal(keyWords(HUB, readOf(hub.delegation[1]), SEVERAL), false, 'the hub reads its own delegation key');
  assert.equal(keyWords(HUB, readOf(hub.subagent[2]), SEVERAL), false, 'the hub reads its own subagent key');
  // The name stands in the start alone. Another source of the agent names none of the keys, even in prose, and holds no key written out.
  const server = join(dirname(HUB), 'server.ts');
  for (const name of variablesOf(hub)) assert.equal(keyWords(server, `// ${name} is a key`, SEVERAL), true, `${server} may not name ${name}`);
  assert.equal(keyWords(server, `const k = '${HEX}';`, SEVERAL), true, `${server} may not hold a key written out`);
  assert.equal(keyWords(join('agents', 'fixture-plain', 'src', 'report.ts'), `const asset = '${HEX}';`, SEVERAL), false, 'an agent that holds no key may have a registry asset name');
  // A new agent that holds a key fails until its start is listed. Once it is listed, the same read passes.
  const fresh = join('agents', 'fixture-new', 'src', 'start.ts');
  assert.equal(keyWords(fresh, readOf('NEW_SERVICE_PRIV_KEY_HEX'), SEVERAL), true, 'a start that no list names');
  const listed = new Map([...SEVERAL, [fresh, { service: 'NEW_SERVICE_PRIV_KEY_HEX', delegation: [], subagent: [] }]]);
  assert.equal(keyWords(fresh, readOf('NEW_SERVICE_PRIV_KEY_HEX'), listed), false, 'the same start, once it is listed');
});

/** What is wrong with a list of key variables: a start with no service key, a name that does not end in _PRIV_KEY_HEX, the supplier key in a list, a variable named twice. */
function tableProblems(table) {
  const problems = [];
  const seen = new Set();
  for (const [start, keys] of table) {
    if (typeof keys.service !== 'string' || keys.service === '') problems.push(`${start} names no service key`);
    for (const name of variablesOf(keys).filter((entry) => typeof entry === 'string' && entry !== '')) {
      if (!/^[A-Z][A-Z0-9_]*_PRIV_KEY_HEX$/.test(name)) problems.push(`${name} is not a name that ends in _PRIV_KEY_HEX`);
      if (name === 'SUPPLIER_PRIV_KEY_HEX') problems.push(`${start} names the supplier key, which is the runtime's`);
      if (seen.has(name)) problems.push(`${name} is named twice`);
      seen.add(name);
    }
  }
  return problems;
}
/** The variables that a start names and does not read in the one place: each one is read once. */
const unreadVariables = (text, keys) => variablesOf(keys).filter((name) => text.split(readForm(name)).length - 1 !== 1);

test('the list of key variables names a service key for each start, a name of its own for each key, and each start of the repository reads each variable that it names in the one place', () => {
  assert.deepEqual(tableProblems(KEY_VARIABLES), []);
  for (const [start, keys] of KEY_VARIABLES) assert.deepEqual(unreadVariables(readFileSync(start, 'utf8'), keys), [], `${start} reads each variable that it names`);
  assert.deepEqual(tableProblems(SEVERAL), [], 'the list of the several-key fixture');
  const one = (keys) => new Map([[HUB, keys]]);
  const twice = new Map([[HUB, SEVERAL.get(HUB)], [SPOKE, { service: 'HUB_SERVICE_PRIV_KEY_HEX', delegation: [], subagent: [] }]]);
  const refused = [
    ['a start with no service key', one({ service: '', delegation: ['HUB_DELEGATION_1_PRIV_KEY_HEX'], subagent: [] }), [`${HUB} names no service key`]],
    ['a name that does not end in _PRIV_KEY_HEX', one({ service: 'HUB_SERVICE_KEY', delegation: [], subagent: [] }), ['HUB_SERVICE_KEY is not a name that ends in _PRIV_KEY_HEX']],
    ['the supplier key in a list', one({ service: 'HUB_SERVICE_PRIV_KEY_HEX', delegation: ['SUPPLIER_PRIV_KEY_HEX'], subagent: [] }), [`${HUB} names the supplier key, which is the runtime's`]],
    ['a variable named twice in one start', one({ service: 'HUB_SERVICE_PRIV_KEY_HEX', delegation: ['HUB_SERVICE_PRIV_KEY_HEX'], subagent: [] }), ['HUB_SERVICE_PRIV_KEY_HEX is named twice']],
    ['a variable named by two starts', twice, ['HUB_SERVICE_PRIV_KEY_HEX is named twice']],
  ];
  for (const [what, table, problems] of refused) assert.deepEqual(tableProblems(table), problems, what);
  // A variable that a start names and does not read is found, and so is one that it reads twice.
  const keys = SEVERAL.get(HUB);
  const names = variablesOf(keys);
  assert.deepEqual(unreadVariables(names.map(readOf).join('\n'), keys), [], 'every variable read once');
  assert.deepEqual(unreadVariables(names.slice(0, -1).map(readOf).join('\n'), keys), [names.at(-1)], 'a variable that is named and not read');
  assert.deepEqual(unreadVariables([...names, names[1]].map(readOf).join('\n'), keys), [names[1]], 'a variable that is read twice');
});

// ---- The compose file of each agent: each container gets its own keys ----
// The runtime and the service of an agent read one env file. So the compose file gives each container its own keys: the others are blanked (an empty string in `environment` overrides the value from the env file).
// A runtime blanks every variable that its service reads a key from. The service blanks the supplier key. A runtime does not name the supplier key, and a service does not name its own keys:
// both read them from the env file. No container writes the value of a key in the file.
function composeKeyProblems(compose, { runtimes, service, start, holdsNoKey = false }, table = KEY_VARIABLES) {
  const keys = table.has(start) ? variablesOf(table.get(start)) : [];
  const environmentOf = (name) => {
    const environment = compose.services?.[name]?.environment ?? {};
    return Array.isArray(environment) ? Object.fromEntries(environment.map((entry) => [entry.split('=')[0], entry.split('=').slice(1).join('=')])) : environment;
  };
  const problems = [];
  for (const runtime of runtimes) {
    const environment = environmentOf(runtime);
    for (const key of keys) if (environment[key] !== '') problems.push(`the runtime ${runtime} does not blank ${key}`);
    if ('SUPPLIER_PRIV_KEY_HEX' in environment) problems.push(`the runtime ${runtime} sets SUPPLIER_PRIV_KEY_HEX: it reads its key from the env file`);
  }
  const own = environmentOf(service);
  // A service with no key (the mock service) names no key variable at all, not even a blank one: it has no supplier key to blank and no key of its own to read.
  if (holdsNoKey) for (const name of Object.keys(own)) if (/PRIV_KEY_HEX$/.test(name)) problems.push(`the service ${service} names ${name}: it holds no key`);
  if (!holdsNoKey && own.SUPPLIER_PRIV_KEY_HEX !== '') problems.push(`the service ${service} does not blank SUPPLIER_PRIV_KEY_HEX`);
  for (const key of keys) if (key in own) problems.push(`the service ${service} sets ${key}: it reads its keys from the env file`);
  for (const container of Object.keys(compose.services)) {
    for (const [name, value] of Object.entries(environmentOf(container))) if (/PRIV_KEY_HEX$/.test(name) && value !== '') problems.push(`${container} writes a value for ${name}`);
  }
  return problems;
}
/** The compose files of the host: the runtime containers, the service container, and the start of the service when it holds keys. */
const DEPLOYMENTS = [
  { compose: join('deploy', 'host', 'docker-compose.agent-history.yml'), runtimes: ['agent'], service: 'service' },
  { compose: join('deploy', 'host', 'docker-compose.document-pipeline.yml'), runtimes: ['agent'], service: 'service', start: join('agents', 'document-pipeline', 'src', 'start.ts') },
  { compose: join('deploy', 'host', 'docker-compose.audio-snippets.yml'), runtimes: ['agent'], service: 'service' },
  { compose: join('deploy', 'host', 'docker-compose.advocate.yml'), runtimes: ['agent'], service: 'service', start: join('agents', 'advocate', 'src', 'start.ts') },
  { compose: join('deploy', 'server', 'docker-compose.order-desk.yml'), runtimes: ['runtime-small', 'runtime-medium', 'runtime-large'], service: 'service', start: join('agents', 'order-desk', 'src', 'serve', 'start.ts') },
  { compose: join('deploy', 'server', 'docker-compose.reorder-agent.yml'), runtimes: ['runtime'], service: 'service', start: join('agents', 'reorder-agent', 'src', 'serve', 'start.ts') },
  { compose: join('deploy', 'server', 'docker-compose.prior-authorization-agent.yml'), runtimes: ['runtime'], service: 'service', start: join('agents', 'prior-authorization-agent', 'src', 'serve', 'start.ts') },
  { compose: join('deploy', 'server', 'docker-compose.mock-systems.yml'), runtimes: [], service: 'mock-systems', holdsNoKey: true },
];
/** What the list of deployments leaves out: a start that holds keys and has no compose file in it, a start that no list of keys names, and a compose file of the host that it does not list. */
function deploymentProblems(deployments, table, composeFiles) {
  const problems = [];
  for (const start of table.keys()) if (!deployments.some((deployment) => deployment.start === start)) problems.push(`${start} holds keys, and no compose file is listed for it`);
  for (const deployment of deployments) if (deployment.start !== undefined && !table.has(deployment.start)) problems.push(`${deployment.compose} names the start ${deployment.start}, which no list of keys names`);
  for (const file of composeFiles) if (!deployments.some((deployment) => deployment.compose === file)) problems.push(`${file} is a compose file that no deployment lists`);
  return problems;
}

/** The compose files of a folder: the name starts with docker-compose, and it ends in .yml or .yaml. */
const composeFilesIn = (folder) => readdirSync(folder).filter((file) => /^docker-compose.*\.ya?ml$/.test(file)).sort().map((file) => join(folder, file));

test('the compose files of the host give each container its own keys: the runtime blanks the keys of its service, the service blanks the supplier key, and no container writes a key', () => {
  const files = ['host', 'server'].flatMap((folder) => composeFilesIn(join('deploy', folder)));
  assert.ok(['docker-compose.mock-systems.yml', 'docker-compose.order-desk.yml', 'docker-compose.reorder-agent.yml'].every((name) => files.includes(join('deploy', 'server', name))), 'the folder of the agents host is read too');
  assert.deepEqual(deploymentProblems(DEPLOYMENTS, KEY_VARIABLES, files), []);
  for (const deployment of DEPLOYMENTS) assert.deepEqual(composeKeyProblems(parseYaml(readFileSync(deployment.compose, 'utf8')), deployment), [], deployment.compose);
});

test('the list of compose files takes the files that end in .yml and in .yaml, and no other file, and a .yaml file that no deployment lists is refused', () => {
  const folder = mkdtempSync(join(tmpdir(), 'compose-names-'));
  try {
    for (const name of ['docker-compose.a.yml', 'docker-compose.b.yaml', 'docker-compose.yaml', 'docker-compose.c.json', 'docker-compose.d.yml.bak', 'compose.e.yml', 'my-docker-compose.f.yml', 'README.md']) writeFileSync(join(folder, name), 'services: {}\n');
    const files = composeFilesIn(folder);
    assert.deepEqual(files.map((file) => file.slice(folder.length + 1)), ['docker-compose.a.yml', 'docker-compose.b.yaml', 'docker-compose.yaml'], 'the three compose files, and none of the five other names');
    const listed = [{ compose: join(folder, 'docker-compose.a.yml'), runtimes: [], service: 'x', holdsNoKey: true }];
    assert.deepEqual(deploymentProblems(listed, new Map(), files.slice(0, 1)), [], 'the file that is listed passes');
    assert.deepEqual(deploymentProblems(listed, new Map(), files), [`${join(folder, 'docker-compose.b.yaml')} is a compose file that no deployment lists`, `${join(folder, 'docker-compose.yaml')} is a compose file that no deployment lists`], 'a file that ends in .yaml and that no deployment lists is refused');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the compose check lets a service with several keys through, with three runtimes in front of it, and refuses a container that gets a key that is not its own, in the words of the rule that it breaks', () => {
  const blanked = Object.fromEntries(variablesOf(SEVERAL.get(HUB)).map((name) => [name, '']));
  const accepted = () => ({
    services: {
      'agent-small': { environment: { CAPABILITY_KIND: 'custom', ...blanked } },
      'agent-medium': { environment: { CAPABILITY_KIND: 'custom', ...blanked } },
      'agent-large': { environment: { CAPABILITY_KIND: 'custom', ...blanked } },
      service: { environment: { PORT: '9100', SUPPLIER_PRIV_KEY_HEX: '' } },
    },
  });
  const deployment = { runtimes: ['agent-small', 'agent-medium', 'agent-large'], service: 'service', start: HUB };
  const problemsOf = (change) => { const compose = accepted(); change(compose.services); return composeKeyProblems(compose, deployment, SEVERAL); };
  assert.deepEqual(problemsOf(() => {}), [], 'the accepted compose file');
  const refused = [
    ['a runtime that does not blank a delegation key', (s) => { delete s['agent-medium'].environment.HUB_DELEGATION_2_PRIV_KEY_HEX; }, ['the runtime agent-medium does not blank HUB_DELEGATION_2_PRIV_KEY_HEX']],
    ['a runtime that does not blank a subagent key', (s) => { delete s['agent-large'].environment.HUB_SCORER_3_PRIV_KEY_HEX; }, ['the runtime agent-large does not blank HUB_SCORER_3_PRIV_KEY_HEX']],
    ['a runtime that does not blank the service key', (s) => { delete s['agent-small'].environment.HUB_SERVICE_PRIV_KEY_HEX; }, ['the runtime agent-small does not blank HUB_SERVICE_PRIV_KEY_HEX']],
    ['a runtime that sets the supplier key', (s) => { s['agent-small'].environment.SUPPLIER_PRIV_KEY_HEX = ''; }, ['the runtime agent-small sets SUPPLIER_PRIV_KEY_HEX: it reads its key from the env file']],
    ['a service that does not blank the supplier key', (s) => { delete s.service.environment.SUPPLIER_PRIV_KEY_HEX; }, ['the service service does not blank SUPPLIER_PRIV_KEY_HEX']],
    ['a service that sets one of its own keys', (s) => { s.service.environment.HUB_DELEGATION_1_PRIV_KEY_HEX = ''; }, ['the service service sets HUB_DELEGATION_1_PRIV_KEY_HEX: it reads its keys from the env file']],
    ['a container that writes the value of a key', (s) => { s.mock = { environment: { OTHER_PRIV_KEY_HEX: HEX } }; }, ['mock writes a value for OTHER_PRIV_KEY_HEX']],
  ];
  for (const [what, change, problems] of refused) assert.deepEqual(problemsOf(change), problems, what);
  // The environment of a container can be a list of NAME=value entries: a blank key in that form is a blank key.
  const asList = accepted();
  for (const name of deployment.runtimes) asList.services[name].environment = Object.entries(asList.services[name].environment).map(([key, value]) => `${key}=${value}`);
  assert.deepEqual(composeKeyProblems(asList, deployment, SEVERAL), [], 'the accepted compose file, with the environment as lists');
  asList.services['agent-small'].environment = asList.services['agent-small'].environment.filter((entry) => !entry.startsWith('HUB_SCORER_1_PRIV_KEY_HEX='));
  assert.deepEqual(composeKeyProblems(asList, deployment, SEVERAL), ['the runtime agent-small does not blank HUB_SCORER_1_PRIV_KEY_HEX'], 'a missing blank key, with the environment as a list');
});

test('the list of deployments names the compose file of each start that holds keys and each compose file of the host, and a gap on either side is refused', () => {
  const table = new Map([[HUB, SEVERAL.get(HUB)]]);
  const deployments = [{ compose: 'deploy/x/a.yml', runtimes: ['agent'], service: 'service', start: HUB }, { compose: 'deploy/x/b.yml', runtimes: ['agent'], service: 'service' }];
  assert.deepEqual(deploymentProblems(deployments, table, ['deploy/x/a.yml', 'deploy/x/b.yml']), [], 'the accepted list');
  assert.deepEqual(deploymentProblems(deployments, SEVERAL, ['deploy/x/a.yml', 'deploy/x/b.yml']), [`${SPOKE} holds keys, and no compose file is listed for it`], 'a start with no compose file');
  assert.deepEqual(deploymentProblems(deployments, new Map(), ['deploy/x/a.yml', 'deploy/x/b.yml']), [`deploy/x/a.yml names the start ${HUB}, which no list of keys names`], 'a start that no list names');
  assert.deepEqual(deploymentProblems(deployments, table, ['deploy/x/a.yml', 'deploy/x/b.yml', 'deploy/x/c.yml']), ['deploy/x/c.yml is a compose file that no deployment lists'], 'a compose file that is not listed');
});

test('the compose check lets a service with no key through, and refuses one that names a key variable, blank or filled, and a listing that lacks the shape of a service with no key', () => {
  const deployment = { runtimes: [], service: 'mock-systems', holdsNoKey: true };
  const accepted = () => ({ services: { 'mock-systems': { environment: { PORT: '9120', HOST: '0.0.0.0' } } } });
  const problemsOf = (change) => { const compose = accepted(); change(compose.services['mock-systems'].environment); return composeKeyProblems(compose, deployment); };
  assert.deepEqual(problemsOf(() => {}), [], 'the accepted compose file');
  assert.deepEqual(problemsOf((environment) => { environment.SUPPLIER_PRIV_KEY_HEX = ''; }), ['the service mock-systems names SUPPLIER_PRIV_KEY_HEX: it holds no key'], 'a blank supplier key');
  assert.deepEqual(problemsOf((environment) => { environment.MOCK_PRIV_KEY_HEX = HEX; }), ['the service mock-systems names MOCK_PRIV_KEY_HEX: it holds no key', 'mock-systems writes a value for MOCK_PRIV_KEY_HEX'], 'a key written out');
  assert.deepEqual(composeKeyProblems(accepted(), { runtimes: [], service: 'mock-systems' }), ['the service mock-systems does not blank SUPPLIER_PRIV_KEY_HEX'], 'the same file listed as a service that holds keys');
  const asList = accepted();
  asList.services['mock-systems'].environment = ['PORT=9120', 'HOST=0.0.0.0', 'SUPPLIER_PRIV_KEY_HEX='];
  assert.deepEqual(composeKeyProblems(asList, deployment), ['the service mock-systems names SUPPLIER_PRIV_KEY_HEX: it holds no key'], 'a blank key in the environment as a list');
});
