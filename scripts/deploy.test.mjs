import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
// The deployment files of Agent History (Dockerfile, compose, env example, Caddy snippet, README, RUNBOOK, CI publish job) are read by a
// host administrator and an operator who act on them. Docker is not needed here: these tests parse the files and keep them equal to each
// other, to the service code, to the spec and to the design. docker build and caddy validate were run by hand. docker compose config runs here
// when docker compose is on the PATH, for the one variable of the compose files, and the text pins hold the same without it.
// The Document Pipeline (DEPLOYED since 2026-10-16) is held the same way: its four files, its section of the README and its CI lines are pinned in the
// last block of this file, and the walks above (names, dashes, the unit name, the status words) reach its files too.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const DESIGN = read('docs/superpowers/specs/2026-10-13-vector-service-agents-design.md');
const SPEC = read('specs/agent-history.md');
const compose = parseYaml(read('deploy/host/docker-compose.agent-history.yml'));
const exampleText = read('deploy/host/.env.agent-history.example');
const readme = read('deploy/host/README.md');
const runbook = read('deploy/host/RUNBOOK.md');
const snippet = read('deploy/host/Caddyfile.snippet');
const dockerfile = read('agents/agent-history/Dockerfile');
const ci = parseYaml(read('.github/workflows/ci.yml'));
const { agent, service } = compose.services;
// The external network of the host's reverse proxy is named nowhere in the repository: both compose files take its name from PROXY_NETWORK, which compose
// reads from .env next to them, and the :? form stops every compose command, the build of step 3 included, while it is unset or empty.
const PROXY_NETWORK_NAME = "${PROXY_NETWORK:?set PROXY_NETWORK in .env next to this compose file: the external network of the host's reverse proxy}";
// The example as a name to value map. A name listed twice is a mistake, not an override.
function parseEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert.ok(m, `not NAME=value: ${line}`);
    assert.ok(!(m[1] in env), `${m[1]} is listed twice`);
    env[m[1]] = m[2];
  }
  return env;
}
const example = parseEnv(exampleText);
// A value in angle brackets stands for something the operator supplies, so for every check below it is the same as a value that is not there.
const PLACEHOLDER = /^<.*>$/;
const withoutPlaceholders = (env) => Object.fromEntries(Object.entries(env).filter(([, v]) => !PLACEHOLDER.test(v)));
// OPERATOR_CONTACT has no default, so every manifest rendered here is given one. A fixed address on a reserved domain, never one that is used.
const TEST_CONTACT = 'ops@example.test';
const specNumber = (re) => Number(re.exec(SPEC)?.[1]);
const SPEC_TERMS = {
  price: specNumber(/\| Price \| (\d+) \|/), supplierBond: specNumber(/\| Supplier bond \| (\d+) \|/), buyerBond: specNumber(/\| Buyer bond \| (\d+) \|/),
  window: specNumber(/advert `max_processing_ms` \| (\d+) ms/), timeout: specNumber(/Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/),
};
// The manifest the service renders for a given environment, run through the real code (tsx), so that nothing here re-implements it.
function renderManifests(envs, dir = 'agents/agent-history') {
  const code = "import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((e) => manifestFromEnv(e))));";
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(envs)], { cwd: join(root, dir), encoding: 'utf8' });
  return JSON.parse(out);
}
// The names of the environment variables a source file reads: process.env.NAME, env.NAME, env['NAME'], envInt('NAME', ...) and { NAME, OTHER: alias, THIRD = 'x' } = process.env.
function envNamesIn(source) {
  const names = new Set();
  for (const m of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  for (const m of source.matchAll(/\benv\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g)) names.add(m[1]);
  for (const m of source.matchAll(/\benvInt\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)) names.add(m[1]);
  for (const m of source.matchAll(/\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/g)) for (const part of m[1].split(',')) { const n = /^\s*([A-Z][A-Z0-9_]*)\b/.exec(part); if (n) names.add(n[1]); }
  return names;
}
const sourceFiles = (dir) => readdirSync(join(root, dir), { recursive: true }).filter((f) => /\.(ts|mts|js|mjs)$/.test(f)).map((f) => `${dir}/${f.split(sep).join('/')}`);
// A secret name must have an empty value, and no value may be shaped like a key, a key hash or an address.
const SECRET_NAME = /PRIV_KEY|SECRET|TOKEN|PASSWORD|API_KEY|AUTH_HEADER/;
const KEY_SHAPED = [/^[0-9a-f]{64}$/i, /^[0-9a-f]{56}$/i, /^addr1/, /ed25519_sk/i];
const keyProblems = (vars) => Object.entries(vars).flatMap(([name, value]) => [
  ...(SECRET_NAME.test(name) && String(value) !== '' ? [`${name} must be empty`] : []),
  ...KEY_SHAPED.filter((re) => re.test(String(value))).map((re) => `${name} looks like key material (${re})`),
]);
// The values that the identity registry deployment on Vector mainnet published on 2026-11-03 (agents-marketplace 4c95c3f,
// contracts/identity-marketplace/deploy/mainnet/README.md). They are public chain data: the key check passes each name only with its published value.
const IDENTITY_MAINNET = {
  IDENTITY_POLICY_ID: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
  IDENTITY_ESCROW_REF_UTXO: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0',
  IDENTITY_ADVERT_REF_UTXO: '5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758#0',
  VECTOR_IDENTITY_LEGACY_ROOT: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  VECTOR_IDENTITY_CONFIG_SEED: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0',
  VECTOR_IDENTITY_ESCROW_REF_UTXO: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0',
};
// The address of the identity registry that the same deployment published: the address of IDENTITY_POLICY_ID, which the manifest gives as identity.registry_address.
const IDENTITY_MAINNET_ADDRESS = 'addr1w8v43wprl248d9mapgrmm93zap7cuty97e5j7luw3kmhwcs8vm9vk';
// The two names of the runtime for the escrow and the advert that carry an agent_id, in the chain block of every example.
const RUNTIME_IDENTITY = ['IDENTITY_ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO'];
const withoutPublished = (env) => Object.fromEntries(Object.entries(env).filter(([name, value]) => IDENTITY_MAINNET[name] !== value));
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
// Individual names stay off every public surface. Case-insensitive on purpose: an address such as first.last@host is lower case, and the
// first guard (capitalised names only) let one through into the manifest.
const NAMES = /\b(Filip|Blagojevi\w*|David|Cejtlin|Chris|Jerry|Armando|Andrej|Casl\w+|Nikola|Danielle|Tom Flynn)\b/i;
// A path into someone's home folder names its owner too. Either separator: C:\Users\x is as much a path as C:/Users/x.
const HOME_PATH = /C:[\\/]Users[\\/]|[\\/](Users|home)[\\/][A-Za-z]/;
// The Document Pipeline is DEPLOYED since 2026-10-16, so its files say DEPLOYED in their status lines and headers and LIVE nowhere. They sit in this list so that they get every rule below.
const PIPELINE_FILES = ['deploy/host/docker-compose.document-pipeline.yml', 'deploy/host/.env.document-pipeline.example', 'deploy/host/Caddyfile.document-pipeline.snippet', 'deploy/host/RUNBOOK-document-pipeline.md'];
// Audio Snippets is DEPLOYED since 2026-10-17: its four deploy files, read by the tests of the status words and of its stack.
const S_FILES = ['deploy/host/docker-compose.audio-snippets.yml', 'deploy/host/.env.audio-snippets.example', 'deploy/host/Caddyfile.audio-snippets.snippet', 'deploy/host/RUNBOOK-audio-snippets.md'];
// Advocate is DEPLOYED since 2026-10-20: its four deploy files, read by the tests of the status words and of its stack.
const A_FILES = ['deploy/host/docker-compose.advocate.yml', 'deploy/host/.env.advocate.example', 'deploy/host/Caddyfile.advocate.snippet', 'deploy/host/RUNBOOK-advocate.md'];
const PUBLIC_FILES = ['deploy/host/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/.env.agent-history.example', 'deploy/host/Caddyfile.snippet', 'agents/agent-history/Dockerfile', '.dockerignore', ...PIPELINE_FILES, 'agents/document-pipeline/Dockerfile'];
// The deploy packs of use case 1 (inventory reorder) on the agents host: four files for the Reorder Agent and five for the Order Desk. The README and the runbooks of the host are not in the lists.
const REORDER_PACK = ['deploy/server/docker-compose.reorder-agent.yml', 'deploy/server/.env.reorder-agent.example', 'deploy/server/Caddyfile.reorder-agent.snippet', 'deploy/server/RUNBOOK-reorder-agent.md'];
const ORDER_PACK = ['deploy/server/docker-compose.order-desk.yml', 'deploy/server/.env.order-desk.example', 'deploy/server/.env.order-desk-runtime.example', 'deploy/server/Caddyfile.order-desk.snippet', 'deploy/server/RUNBOOK-order-desk.md'];
const USE_CASE_1_FILES = [...REORDER_PACK, ...ORDER_PACK];

test('compose: two containers with fixed names, the runtime on loopback only, the service unpublished, both on the shared network', () => {
  assert.equal(compose.name, 'agent-history');
  assert.deepEqual(Object.keys(compose.services), ['agent', 'service']);
  assert.equal(agent.container_name, 'agent-history-agent');
  assert.equal(service.container_name, 'agent-history-service');
  assert.deepEqual(agent.ports, ['127.0.0.1:8083:8080']);
  assert.equal(service.ports, undefined);
  assert.deepEqual(agent.networks, ['proxy']);
  assert.deepEqual(service.networks, ['proxy']);
  assert.deepEqual(compose.networks, { proxy: { external: true, name: PROXY_NETWORK_NAME } }, 'one network, external, named by PROXY_NETWORK');
  assert.deepEqual(agent.depends_on, ['service']);
  for (const s of [agent, service]) assert.deepEqual(s.env_file, [{ path: './.env.agent-history', required: true }]);
  // The runtime of the template stops itself, with exit code 1, when its decoder library fails its own check. Only the restart policy starts it again.
  for (const [name, s] of [['agent', agent], ['service', service]]) assert.equal(s.restart, 'unless-stopped', name);
});

test('compose: the runtime is built from the pinned template commit, written in full because BuildKit does not resolve the short form', () => {
  assert.match(agent.build.context, /^https:\/\/github\.com\/Apex-Fusion\/vector-agent-template\.git#a05564c[0-9a-f]{33}$/);
  assert.equal(agent.build.dockerfile, 'agent/Dockerfile');
  assert.ok(SPEC.includes('pinned commit `a05564c`'), 'the spec names the same commit');
});

test('compose: SERVICE_URL names the service container, its port and the path /, and is not the shared alias "service"', () => {
  const url = new URL(agent.environment.SERVICE_URL);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, service.container_name, 'the container name is unique on the shared network; the alias "service" would match every agent');
  assert.equal(url.port, service.environment.PORT);
  assert.equal(url.pathname, '/', 'the service accepts POST on / only');
  assert.ok(agent.environment.SERVICE_URL.endsWith('/'), 'with the trailing slash');
  assert.equal(agent.environment.CAPABILITY_KIND, 'custom');
  assert.equal(agent.environment.SERVICE_CONTENT_TYPE, 'application/json');
});

test('compose: the service image is named by digest (a placeholder in the repository), and the runbook records the digest before the service starts', () => {
  // The manifest the service renders is hashed into the advert; a tag that moves would change the bytes behind the hash. A real digest is accepted too.
  assert.match(service.image, /^ghcr\.io\/apex-fusion\/vector-service-agents\/agent-history@sha256:(<digest>|[0-9a-f]{64})$/);
  assert.doesNotMatch(service.image, /:latest/);
  assert.match(read('deploy/host/docker-compose.agent-history.yml'), /# Pinned by digest, not by tag\./);
  const two = section(runbook, '2. Log in to the registry and get the service image');
  assert.ok(two.includes("docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/apex-fusion/vector-service-agents/agent-history:latest"));
  assert.ok(two.includes('`@sha256:<digest>`') && two.includes('`invalid reference format`'), 'the placeholder, and what compose says while it is there');
  assert.ok(two.includes("docker image inspect --format '{{.Id}}'"), 'the image ID, for a local build without a digest');
  assert.ok(two.indexOf('docker pull') < two.indexOf('Then pin the image.'), 'after the pull or the build');
  const nine = section(runbook, '9. Start the service');
  assert.ok(nine.includes("grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/agent-history@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.agent-history.yml"));
  assert.ok(nine.indexOf('First check the pin of step 2.') < nine.indexOf('up -d service'), 'checked before the service is started');
  // The check the runbook gives accepts a real digest line and an image ID, and refuses the placeholder.
  const check = /^    image: (ghcr[.]io\/apex-fusion\/vector-service-agents\/agent-history@sha256:|sha256:)[0-9a-f]{64}$/;
  assert.match(`    image: ghcr.io/apex-fusion/vector-service-agents/agent-history@sha256:${'ab'.repeat(32)}`, check);
  assert.match(`    image: sha256:${'ab'.repeat(32)}`, check);
  assert.doesNotMatch('    image: ghcr.io/apex-fusion/vector-service-agents/agent-history@sha256:<digest>', check);
  assert.match(section(runbook, 'If something goes wrong'), /\| `invalid reference format` for the service image \|/);
  assert.ok(readme.includes('(`@sha256:<digest>`, a placeholder in the repository)'), 'the host administrator is told');
});

test('compose: the runtime holds the key, the service gets it blanked', () => {
  assert.ok(!('SUPPLIER_PRIV_KEY_HEX' in agent.environment), 'the runtime reads the key from the env file');
  assert.equal(service.environment.SUPPLIER_PRIV_KEY_HEX, '', 'an empty string overrides the value from env_file');
});

test('compose: the processing window and the service timeout are the spec terms, and nest as the runtime requires', () => {
  assert.equal(Number(agent.environment.ADVERT_MAX_PROCESSING_MS), SPEC_TERMS.window);
  assert.equal(Number(agent.environment.SERVICE_TIMEOUT_MS), SPEC_TERMS.timeout);
  assert.ok(Number(agent.environment.SERVICE_TIMEOUT_MS) <= Number(agent.environment.ADVERT_MAX_PROCESSING_MS) - 60_000, 'the runtime refuses to boot otherwise');
  assert.equal(agent.environment.PORT, '8080');
  assert.equal(service.environment.PORT, '9091');
});

// The settings of the report (agents/agent-history/src/config.ts): the identity registry and the module addresses the report reads. IDENTITY_POLICY_ID holds
// the published policy of the identity registry on Vector mainnet; the other five stay empty in the example: empty keeps the default of the code, and an
// address there would be flagged as key material.
const REPORT = ['IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'M3_REPUTATION_ADDRESS', 'M3_ENDORSEMENT_ADDRESS', 'M1_ADDRESSES', 'M6_ADDRESSES'];
test('env example: known names only, each once; every secret is empty; nothing in the example or in the compose environment looks like key material but the published values of the identity registry', () => {
  const RUNTIME = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', ...RUNTIME_IDENTITY, 'ADVERT_REF'];
  const POST_ADVERT = ['ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
  const MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
  assert.deepEqual(Object.keys(example).filter((n) => ![...RUNTIME, ...POST_ADVERT, ...MANIFEST, ...REPORT].includes(n)), [], 'a name the runtime, the advert command and the service never read');
  assert.deepEqual(keyProblems(withoutPublished(example)), []);
  for (const name of ['IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY]) assert.equal(example[name], IDENTITY_MAINNET[name], `${name} is the published value`);
  assert.deepEqual(keyProblems(agent.environment), [], 'the compose environment of the runtime');
  assert.deepEqual(keyProblems(service.environment), [], 'the compose environment of the service');
  for (const name of ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(example[name], '', `${name} is filled by the runbook`);
  // The contact is the one value the operator types. It is a placeholder in angle brackets (never an address), and it says what goes there.
  assert.match(example.OPERATOR_CONTACT, PLACEHOLDER);
  assert.ok(example.OPERATOR_CONTACT.startsWith('<role address'), 'a role address is asked for');
});

test('env example: IDENTITY_POLICY_ID is the published policy and adds the identity registry, the other five settings of the report are empty and keep the default of the code, a value that breaks a rule stops the service at start and the error names it, and a policy ID changes the manifest', () => {
  for (const name of REPORT.filter((n) => n !== 'IDENTITY_POLICY_ID')) assert.equal(example[name], '', `${name} is empty`);
  assert.equal(example.IDENTITY_POLICY_ID, IDENTITY_MAINNET.IDENTITY_POLICY_ID);
  // Through the real code (tsx), as renderManifests does: the example, then the example with one bad value in each of the six.
  const code = "import { configFromEnv, DEFAULT_CONFIG } from './src/config.ts'; console.log(JSON.stringify([DEFAULT_CONFIG, ...JSON.parse(process.argv[1]).map((e) => { try { return configFromEnv(e); } catch (err) { return { error: err.message }; } })]));";
  const envs = [example, ...REPORT.map((name) => ({ ...example, [name]: 'x' }))];
  const [defaults, fromExample, ...refused] = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(envs)], { cwd: join(root, 'agents/agent-history'), encoding: 'utf8' }));
  assert.deepEqual(fromExample.registries.identity, { policy: IDENTITY_MAINNET.IDENTITY_POLICY_ID, address: IDENTITY_MAINNET_ADDRESS }, 'the published policy gives the published address');
  assert.deepEqual({ ...fromExample, registries: { ...fromExample.registries, identity: null } }, defaults, 'the empty lines keep the default of the code');
  assert.equal(defaults.registries.identity, null, 'the default has no identity registry');
  REPORT.forEach((name, i) => assert.match(refused[i].error ?? '', new RegExp(`^environment variable ${name} `), `${name}: the error names it`));
  assert.ok(exampleText.includes('\n# The service reads these values at start. A value that breaks a rule stops the service at start, and the error names the variable.\n'), 'the comment says so');
  // The manifest publishes the address of the policy, so the policy ID is part of the bytes the advert hashes, and the comment says so.
  const [base, withPolicy] = renderManifests([{ OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT, IDENTITY_POLICY_ID: 'ab'.repeat(28) }]);
  assert.equal(base.identity.registry_address, '');
  assert.match(withPolicy.identity.registry_address, /^addr1w/);
  assert.deepEqual({ ...withPolicy, identity: base.identity }, base, 'the policy ID changes the registry address and nothing else');
  assert.ok(exampleText.includes('\n# The manifest publishes the address of this policy as identity.registry_address, so the value must be final before the hash is taken (RUNBOOK.md step 11). A change afterwards means a retired advert and a new one.\n'));
});

test('key check: it flags a secret name with a value, a key-shaped value and an address, and passes what the compose file holds', () => {
  assert.deepEqual(keyProblems({ SUPPLIER_PRIV_KEY_HEX: 'x' }), ['SUPPLIER_PRIV_KEY_HEX must be empty']);
  assert.equal(keyProblems({ SOMETHING: 'ab'.repeat(32) }).length, 1, 'a 64-hex value');
  assert.equal(keyProblems({ SOMETHING: 'ab'.repeat(28) }).length, 1, 'a 56-hex value');
  assert.equal(keyProblems({ SOMETHING: 'addr1v' + 'q'.repeat(50) }).length, 1, 'an address');
  assert.deepEqual(keyProblems({ SUPPLIER_PRIV_KEY_HEX: '', SERVICE_URL: 'http://agent-history-service:9091/', ESCROW_REF_UTXO: 'ab'.repeat(32) + '#0' }), []);
});

test('env example: every name the service code reads is in the example, in the compose environment, or has a default in the code', () => {
  const files = [...sourceFiles('agents/agent-history/src'), ...sourceFiles('packages/vector-read/src')];
  assert.ok(files.length >= 15, `the scan reaches every source file, found ${files.length}`);
  for (const f of ['agents/agent-history/src/server.ts', 'agents/agent-history/src/index.ts', 'packages/vector-read/src/constants.ts']) assert.ok(files.includes(f), `the scan includes ${f}`);
  const names = new Set(files.flatMap((f) => [...envNamesIn(read(f))]));
  assert.ok(names.size >= 12, 'the scan found the settings');
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'KOIOS_URL', 'INDEXER_URL']; // left unset on purpose: a value here would pin a default that the code owns
  assert.deepEqual([...names].filter((n) => !(n in example) && !(n in service.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in example), `${n} stays unset in the example`);
  // OPERATOR_CONTACT has no default in the code: the service reads it, requires it, and the example carries the placeholder for it.
  assert.ok(names.has('OPERATOR_CONTACT') && 'OPERATOR_CONTACT' in example);
});

test('env scan: it finds every form of environment read the service code could use, and nothing else', () => {
  const sample = "const a = process.env.ONE; const b = env.TWO ?? 'x'; const c = env['THREE']; const d = envInt(\"FOUR\", env.FIVE, 1); const { SIX, SEVEN: alias, EIGHT = 'x' } = process.env; const { NINE } = env;";
  assert.deepEqual([...envNamesIn(sample)].sort(), ['EIGHT', 'FIVE', 'FOUR', 'NINE', 'ONE', 'SEVEN', 'SIX', 'THREE', 'TWO']);
  assert.deepEqual([...envNamesIn('const x = other.NAME; const { lower } = env; // env is mentioned')], []);
});

test('env example: the runtime gets every name the pinned template lists for CAPABILITY_KIND=custom', () => {
  // From .env.example of vector-agent-template at a05564c. The optional ones (SERVICE_AUTH_HEADER, WALLET_HEALTH_INTERVAL_MS, the self-test buyer's BUYER_PRIV_KEY_HEX,
  // INDEXER_URL and SWITCH_SLOT, and IDENTITY_REF_UTXO, IDENTITY_CONTROLLER_PUB_KEY_HEX and IDENTITY_ACCOUNTABLE_PARTY, which only register-record.ts build reads) are left out.
  // AGENT_ID is left out too: the step that makes the agent's record writes it into the env file.
  // SERVICE_PRECHECK_URL and RELEASE_WATCHER are left out on purpose: they stay unset (the tests of the four runtimes hold that). PUBLIC_ORIGIN is needed: it gives the runtime its agent card.
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY, 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'PORT', 'PUBLIC_ORIGIN'];
  assert.deepEqual(NEEDED.filter((n) => !(n in example) && !(n in agent.environment)), []);
  assert.equal(example.NETWORK_ID, '1');
  assert.equal(example.LIVE_CHAIN, '1');
  assert.ok(example.OGMIOS_URL.startsWith('https://'), 'https, not wss');
});

test('env example: the chain values and the advert terms are the design and the spec', () => {
  const [, escrowTx] = /`ESCROW_REF_UTXO` \/ `ADVERT_REF_UTXO` \| `([0-9a-f]{64})#0` \/ `…#1`/.exec(DESIGN);
  assert.equal(example.ESCROW_REF_UTXO, `${escrowTx}#0`);
  assert.equal(example.ADVERT_REF_UTXO, `${escrowTx}#1`);
  assert.equal(example.VECTOR_ZERO_TIME_MS, /Zero time[^|]*[|] `(\d+)`/.exec(DESIGN)[1]);
  assert.equal(example.OGMIOS_URL, /Ogmios `([^`]+)`/.exec(DESIGN)[1]);
  assert.equal(example.ADVERT_CAPABILITY_ID, 'identity.history.report.v1');
  assert.ok(SPEC.includes(`\`${example.ADVERT_CAPABILITY_ID}\``));
  assert.ok(SPEC.includes(`The model string in the advert and in every receipt is \`${example.ADVERT_MODEL}\`.`));
  assert.deepEqual([example.ADVERT_PRICE_LOVELACE, example.ADVERT_SUPPLIER_BOND_LOVELACE, example.ADVERT_BUYER_BOND_LOVELACE, example.ADVERT_MAX_PROCESSING_MS].map(Number), [SPEC_TERMS.price, SPEC_TERMS.supplierBond, SPEC_TERMS.buyerBond, SPEC_TERMS.window]);
  assert.equal(example.ADVERT_MAX_PROCESSING_MS, agent.environment.ADVERT_MAX_PROCESSING_MS);
  assert.equal(example.ADVERT_DETAIL_URI, `${example.ADVERT_ENDPOINT_URL}/agent.json`);
  assert.equal(new URL(example.ADVERT_ENDPOINT_URL).hostname, 'mp-suppliers-history.hal8.ai');
  assert.ok(SPEC.includes(`\`${example.ADVERT_ENDPOINT_URL}\``), 'the spec names the same public URL');
  assert.ok(DESIGN.includes('`mp-suppliers-history.hal8.ai`'));
});

test('env example: the status word is the spec status, and the manifest it produces is the default manifest with the published identity registry', () => {
  assert.ok(section(SPEC, 'Status').includes(`${example.AGENT_STATUS_CHIP.toUpperCase()} (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since ${example.AGENT_STATUS_SINCE}.`));
  assert.equal(example.AGENT_STATUS_CHIP, 'deployed', 'the advert is Active and one first-party job has settled (step 17), which shows that the path works and is not demand, so nothing may claim live');
  assert.equal(example.AGENT_STATUS_SINCE, '2026-10-15');
  // The comment says what the word is, who changes it, and what a first run starts with.
  assert.match(exampleText, /^# The status word the manifest carries, and since when: deployed since 2026-10-15, after the advert was Active and a first-party job had settled \(RUNBOOK\.md step 17, "Flip the status"\)\. A first-party run is not demand, so the word is not live\.$/m);
  assert.match(exampleText, /^# On a first run, before any job has settled, set proposed and today's date here; step 17 changes them\.$/m);
  // The service takes an empty string as given, so an empty AGENT_STATUS_SINCE would put since "" into the manifest.
  assert.notEqual(example.AGENT_STATUS_SINCE, '');
  // Placeholders are unset, and the one setting with no default is supplied for both.
  const [withExample, withNothing] = renderManifests([{ ...withoutPlaceholders(example), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }]);
  assert.equal(withExample.identity.registry_address, IDENTITY_MAINNET_ADDRESS, 'the published policy gives the published address');
  assert.deepEqual({ ...withExample, identity: withNothing.identity }, withNothing, 'the example changes nothing else in the manifest the advert will hash');
  assert.equal(withExample.operator.contact, TEST_CONTACT);
  assert.deepEqual(withExample.status, { chip: 'deployed', since: '2026-10-15' });
  assert.equal(withExample.links.explorer_advert, '');
});

test('Caddy snippet: the site block is the endpoint host, the manifest goes to the service, everything else to the runtime, and it is last in the file', () => {
  const lines = snippet.split('\n');
  const first = lines.findIndex((l) => !l.startsWith('#') && l.trim() !== '');
  const block = lines.slice(first).join('\n').trimEnd();
  assert.match(block, /^mp-suppliers-history\.hal8\.ai \{\n    handle \/agent\.json \{\n        reverse_proxy (\S+)\n    \}\n    handle \{\n        reverse_proxy (\S+)\n    \}\n\}$/);
  const [, toService, toAgent] = block.match(/reverse_proxy (\S+)[\s\S]*reverse_proxy (\S+)/);
  assert.equal(toService, `${service.container_name}:${service.environment.PORT}`);
  assert.equal(toAgent, `${agent.container_name}:${agent.environment.PORT}`);
  assert.equal(block.split('\n')[0], `${new URL(example.ADVERT_ENDPOINT_URL).hostname} {`);
  assert.ok(lines.slice(0, first).every((l) => l.startsWith('#') || l.trim() === ''), 'only comments before the block');
  const unindented = readme.split('\n').map((l) => l.replace(/^ {3}/, '')).join('\n'); // the README shows the block inside a numbered list
  assert.ok(unindented.includes('```\n' + block + '\n```'), 'the README shows the same block');
});

test('Dockerfile: builds from the repo root, installs the right workspace, runs the service on the port the compose file and healthcheck use', () => {
  const pkg = JSON.parse(read('agents/agent-history/package.json'));
  const rootPkg = JSON.parse(read('package.json'));
  assert.ok(dockerfile.includes(`--filter '${pkg.name}...'`));
  assert.ok(dockerfile.includes(`corepack prepare ${rootPkg.packageManager} --activate`));
  const bases = [...dockerfile.matchAll(/^FROM node:(\d+)-alpine/gm)].map((m) => m[1]);
  assert.deepEqual(bases, [read('.nvmrc').trim(), read('.nvmrc').trim()], 'two stages, both on the Node major of .nvmrc');
  const sources = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)].flatMap((m) => m[1].split(' '));
  assert.ok(sources.length >= 6);
  for (const src of sources) assert.ok(existsSync(join(root, src)), `COPY source exists: ${src}`);
  assert.match(dockerfile, /^ENV NODE_ENV=production PORT=9091 HOST=0\.0\.0\.0$/m);
  assert.match(dockerfile, /^EXPOSE 9091$/m);
  assert.match(dockerfile, /^HEALTHCHECK .* http:\/\/127\.0\.0\.1:9091\/healthz /m);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /^ENTRYPOINT \["\/sbin\/tini", "--"\]$/m);
  const cmd = /^CMD \["node_modules\/\.bin\/tsx", "([^"]+)"\]$/m.exec(dockerfile);
  assert.ok(cmd && existsSync(join(root, cmd[1])), 'the entry file exists');
  assert.ok(service.image.startsWith('ghcr.io/apex-fusion/vector-service-agents/'));
  assert.match(dockerfile, /^COPY --from=builder --chown=node:node \/repo \/repo$/m, 'one layer, owned by node');
  assert.doesNotMatch(dockerfile, /^RUN chown /m, 'a separate chown layer copies the whole tree a second time');
  const ignore = read('.dockerignore').split('\n');
  for (const line of ['node_modules', '**/node_modules', '**/.env', '**/.env.*']) assert.ok(ignore.includes(line), `.dockerignore has ${line}: a host node_modules or a key in an env file, at any depth, must never reach the build context`);
});

test('CI: the publish job runs on a push to main after the tests, logs in with GITHUB_TOKEN and pushes the compose image under both tags', () => {
  const job = ci.jobs.publish;
  assert.equal(job.needs, 'test');
  assert.match(job.if, /github\.event_name == 'push'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  const login = job.steps.find((s) => s.uses === 'docker/login-action@v3');
  const build = job.steps.find((s) => s.uses === 'docker/build-push-action@v6' && s.with.file === 'agents/agent-history/Dockerfile');
  assert.ok(login && build);
  assert.equal(login.with.registry, 'ghcr.io');
  assert.equal(login.with.password, '${{ secrets.GITHUB_TOKEN }}');
  assert.equal(build.with.context, '.');
  assert.equal(build.with.file, 'agents/agent-history/Dockerfile');
  assert.equal(build.with.push, true);
  const image = service.image.replace(/@sha256:.*$/, ''); // the compose file names the image by digest; CI pushes the two tags of the same repository
  assert.deepEqual(build.with.tags.trim().split('\n'), [`${image}:latest`, `${image}:\${{ github.sha }}`]);
  assert.equal(ci.jobs.test.steps.at(-1).run, 'pnpm test');
});

test('README, RUNBOOK, compose file and Caddy snippet: Agent History is DEPLOYED since 2026-10-15, the Document Pipeline since 2026-10-16, Audio Snippets since 2026-10-17 and Advocate since 2026-10-20, nothing is LIVE; no dash, no unit name, no person named', () => {
  const STATUS = 'Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE.';
  // The Pipeline is the second stack of the box: its section of the README and its runbook carry its own status line, DEPLOYED since 2026-10-16 (RUNBOOK-document-pipeline.md step 17).
  const P_README_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this section is LIVE.';
  const P_RUNBOOK_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this folder is LIVE.';
  // Audio Snippets is the third stack of the host, DEPLOYED since 2026-10-17 (RUNBOOK-audio-snippets.md step 17): its section of the README carries its own status line, which denies LIVE.
  const S_README_STATUS = 'Status: DEPLOYED since 2026-10-17. Nothing in this section is LIVE.';
  // Advocate is the fourth stack of the host, DEPLOYED since 2026-10-20 (RUNBOOK-advocate.md step 17): its section of the README carries its own status line, which denies LIVE.
  const A_README_STATUS = 'Status: DEPLOYED since 2026-10-20. Nothing in this section is LIVE.';
  const STATUS_LINES = { 'deploy/host/README.md': [STATUS, P_README_STATUS, S_README_STATUS, A_README_STATUS], 'deploy/host/RUNBOOK.md': [STATUS], 'deploy/host/RUNBOOK-document-pipeline.md': [P_RUNBOOK_STATUS] };
  // The second line of each compose file and Caddy snippet says what happened on the box, and so does the third line of the Pipeline's env example.
  const HEADER = {
    'deploy/host/docker-compose.agent-history.yml': '# DEPLOYED since 2026-10-15: installed and running on the box since 2026-10-14; one first-party job settled on 2026-10-15. ',
    'deploy/host/Caddyfile.snippet': '# DEPLOYED since 2026-10-15: installed and running on the box. It was installed on 2026-10-14 by ',
    'deploy/host/docker-compose.document-pipeline.yml': '# DEPLOYED since 2026-10-16: installed and running on the box since 2026-10-16; one first-party job settled on 2026-10-16. ',
    'deploy/host/Caddyfile.document-pipeline.snippet': '# DEPLOYED since 2026-10-16: installed and running on the box. It was installed on 2026-10-16, at step 10 of RUNBOOK-document-pipeline.md, by ',
    'deploy/host/.env.document-pipeline.example': '# Status: DEPLOYED since 2026-10-16. ',
  };
  for (const rel of PUBLIC_FILES) {
    const text = read(rel);
    assert.doesNotMatch(text, DASHES, `${rel}: no em or en dash`);
    assert.doesNotMatch(text, UNIT_NAME, `${rel}: the unit is called units`);
    assert.doesNotMatch(text, NAMES, `${rel}: roles, not people`);
    // LIVE is never claimed. DEPLOYED is said in the status lines of the READMEs and the RUNBOOKs, in the second line of each compose file and Caddy snippet and in the third line of the Pipeline's env example, and nowhere else.
    const rest = (STATUS_LINES[rel] ?? []).reduce((acc, line) => acc.replace(line, ''), text).replace(HEADER[rel] ?? '', '');
    assert.doesNotMatch(rest, /\b(LIVE|DEPLOYED)\b/, `${rel}: no status claim beyond the status line`);
  }
  for (const rel of ['deploy/host/README.md', 'deploy/host/RUNBOOK.md']) assert.ok(read(rel).includes(STATUS), rel);
  assert.ok(read('deploy/host/README.md').includes(`\n## Document Pipeline on the same box\n\n${P_README_STATUS} `), 'the section of the Pipeline opens with its own status line');
  assert.ok(read('deploy/host/RUNBOOK-document-pipeline.md').split('\n')[2].startsWith(`${P_RUNBOOK_STATUS} `), 'the runbook of the Pipeline opens with its status line');
  assert.ok(read('deploy/host/README.md').includes(`\n## Audio Snippets on the same host\n\n${S_README_STATUS} `), 'the section of Audio Snippets opens with its own status line');
  assert.ok(read('deploy/host/README.md').includes(`\n## Advocate on the same host\n\n${A_README_STATUS} `), 'the section of Advocate opens with its own status line');
  assert.equal(readme.split('\n')[2], `${STATUS} Steps 1 to 15 and 17 of the runbook were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).`);
  for (const [rel, header] of Object.entries(HEADER)) assert.ok(read(rel).split('\n')[rel.endsWith('.example') ? 2 : 1].startsWith(header), `${rel}: the line says what happened on the box`);
  assert.doesNotMatch(read('deploy/host/docker-compose.agent-history.yml') + snippet + read('deploy/host/docker-compose.document-pipeline.yml') + read('deploy/host/Caddyfile.document-pipeline.snippet'), /PROPOSED/);
});

// Ruling R-D25: a first-party run shows that the path works and is not demand, and nothing more is claimed of it; the vocabulary of the plan bans the word that a
// clause of the sentence used to add.
// The word is spelled in two parts, as the unit name is, so that a search for it finds no file.
const BANNED_CLAUSE = new RegExp('reve' + 'nue', 'i');
test('the first-party sentence: the README says it for each of the four stacks and the runbooks of the four agents say it, and no deploy file holds the word the clause added', () => {
  const SENTENCE = 'A first-party run shows that the path works. It is not demand.';
  assert.equal(readme.split(SENTENCE).length - 1, 4, 'the README, once for each stack');
  for (const rel of ['deploy/host/RUNBOOK.md', 'deploy/host/RUNBOOK-document-pipeline.md', 'deploy/host/RUNBOOK-audio-snippets.md', 'deploy/host/RUNBOOK-advocate.md']) assert.ok(read(rel).includes(SENTENCE), rel);
  for (const rel of [...PUBLIC_FILES, ...S_FILES, 'agents/audio-snippets/Dockerfile', ...A_FILES, 'agents/advocate/Dockerfile']) assert.doesNotMatch(read(rel), BANNED_CLAUSE, rel);
});

test('RUNBOOK: the status line says that steps 1 to 17 were run on 2026-10-14 and 2026-10-15, the step texts stay instructions, and a first run is told to start with the earlier word', () => {
  const status = runbook.split('\n')[2];
  assert.equal(status, `Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 15 and 17 were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).`);
  assert.equal(runbook.match(/Steps 1 to (9|14|15) were run|The rest has not been run|what will happen/), null);
  // Step 14 ends, in the order of the runbook, on the advert being Active: the status word stays as it was until step 17. It names no word, so it stays right after the flip too.
  // Step 12 still tells the operator what to record: it is an instruction, so it still quotes the words it replaces.
  const fourteen = section(runbook, '14. Check the advert on the indexer');
  assert.ok(fourteen.includes('From here the agent is advertised and the status word stays as it was until step 17.'));
  assert.doesNotMatch(fourteen, /PROPOSED|no job has settled/);
  assert.ok(section(runbook, '12. Post the advert').includes('Record the advert in the repository.'));
  // The example carries the word of today (the test of the env example pins it). A first run, before any job has settled, is told in step 4 to start with the earlier word, and step 9 pins no word.
  assert.ok(section(runbook, '4. Make the env file and generate the supplier key').includes('The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today\'s date: the status can honestly change only in step 17.'));
  const nine = section(runbook, '9. Start the service');
  assert.ok(nine.includes('`status.chip` and `status.since` as the env file sets them (step 4), and an empty `links.explorer_advert`.'));
  assert.doesNotMatch(nine, /status\.chip` `proposed`|2026-10-13/);
});

test('no individual name, and no personal address, on any public surface: the manifest template, the service source, the specs, the guides, both READMEs and the design spec', () => {
  // The design spec is tracked and goes public with the repository, so it is held to the same rule. The planning documents were archived outside the
  // repository before it went public; the design spec is the one document of docs/superpowers.
  const DESIGN_SPEC = 'docs/superpowers/specs/2026-10-13-vector-service-agents-design.md';
  const files = [
    ...PUBLIC_FILES, 'agents/agent-history/agent.json.template', 'agents/agent-history/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md',
    ...sourceFiles('agents/agent-history/src'),
    // Use case 1: the two Dockerfiles, the two manifest templates, the two READMEs, the nine files of the packs and the sources of the two agents.
    'agents/reorder-agent/Dockerfile', 'agents/order-desk/Dockerfile', 'agents/reorder-agent/agent.json.template', 'agents/order-desk/agent.json.template', 'agents/reorder-agent/README.md', 'agents/order-desk/README.md',
    ...USE_CASE_1_FILES, ...sourceFiles('agents/reorder-agent/src'), ...sourceFiles('agents/order-desk/src'),
    // Use case 2: the two Dockerfiles, the two manifest templates, the two READMEs, the eight files of the packs and the sources of the two agents.
    'agents/prior-authorization-agent/Dockerfile', 'agents/insurer-intake-agent/Dockerfile', 'agents/prior-authorization-agent/agent.json.template', 'agents/insurer-intake-agent/agent.json.template', 'agents/prior-authorization-agent/README.md', 'agents/insurer-intake-agent/README.md',
    ...USE_CASE_2_FILES, ...sourceFiles('agents/prior-authorization-agent/src'), ...sourceFiles('agents/insurer-intake-agent/src'),
    // Use case 3: the two Dockerfiles, the two manifest templates, the two READMEs, the three price lists, the ten files of the packs and the sources of the two agents.
    'agents/sourcing-agent/Dockerfile', 'agents/bid-desk/Dockerfile', 'agents/sourcing-agent/agent.json.template', 'agents/bid-desk/agent.json.template', 'agents/sourcing-agent/README.md', 'agents/bid-desk/README.md',
    ...BID_DESK_PRICE_LISTS, ...USE_CASE_3_FILES, ...sourceFiles('agents/sourcing-agent/src'), ...sourceFiles('agents/bid-desk/src'),
    ...readdirSync(join(root, 'specs')).map((f) => `specs/${f}`),
    DESIGN_SPEC,
  ];
  assert.ok(files.length >= 23 && new Set(files).size === files.length, `the list reaches every surface, found ${files.length}`);
  for (const must of [
    'agents/agent-history/agent.json.template', 'agents/agent-history/src/server.ts', 'specs/agent-history.md', 'specs/document-pipeline.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', DESIGN_SPEC,
    'agents/reorder-agent/Dockerfile', 'agents/order-desk/Dockerfile', 'agents/reorder-agent/agent.json.template', 'agents/order-desk/agent.json.template', 'agents/reorder-agent/README.md', 'agents/order-desk/README.md',
    'agents/reorder-agent/src/serve/start.ts', 'agents/order-desk/src/serve/start.ts', 'deploy/server/.env.reorder-agent.example', 'deploy/server/.env.order-desk-runtime.example', 'deploy/server/RUNBOOK-reorder-agent.md', 'deploy/server/RUNBOOK-order-desk.md',
    'agents/prior-authorization-agent/Dockerfile', 'agents/insurer-intake-agent/Dockerfile', 'agents/prior-authorization-agent/agent.json.template', 'agents/insurer-intake-agent/agent.json.template', 'agents/prior-authorization-agent/README.md', 'agents/insurer-intake-agent/README.md',
    'agents/prior-authorization-agent/src/serve/start.ts', 'agents/insurer-intake-agent/src/serve/start.ts', ...USE_CASE_2_FILES,
    'agents/sourcing-agent/Dockerfile', 'agents/bid-desk/Dockerfile', 'agents/sourcing-agent/agent.json.template', 'agents/bid-desk/agent.json.template', 'agents/sourcing-agent/README.md', 'agents/bid-desk/README.md',
    'agents/sourcing-agent/src/serve/start.ts', 'agents/bid-desk/src/serve/start.ts', ...BID_DESK_PRICE_LISTS, ...USE_CASE_3_FILES,
  ]) assert.ok(files.includes(must), `${must} is scanned`);
  for (const rel of files) assert.doesNotMatch(read(rel), NAMES, `${rel}: roles, not people`);
  // A path into someone's home folder names its owner too, and a reviewer's handle is a name.
  assert.doesNotMatch(read(DESIGN_SPEC), HOME_PATH, `${DESIGN_SPEC}: no path into a home folder`);
  assert.doesNotMatch(read(DESIGN_SPEC), /--reviewer [a-z0-9]+-[a-z]+\b/, `${DESIGN_SPEC}: no reviewer handle`);
});

test('the name guard: it finds a name in any case, inside an address too, and not a longer word', () => {
  for (const hit of ['Filip', 'filip.blagojevic@foundation.example', 'BLAGOJEVIC', 'David Cejtlin', 'chris', 'tom flynn', 'ask Jerry first']) assert.match(hit, NAMES, hit);
  for (const miss of ['Christmas', 'Davidson', 'a role address', 'ops@example.test', 'ecosystem@<foundation domain>']) assert.doesNotMatch(miss, NAMES, miss);
});

test('the home-path guard: it finds a path into a home folder with either separator', () => {
  for (const hit of ['C:/Users/someone/notes.md', 'C:\\Users\\someone\\notes.md', '/home/someone/notes.md', '\\home\\someone\\notes.md']) assert.match(hit, HOME_PATH, hit);
});

test('the service has no built-in contact address: the template carries a placeholder and the example asks for a role address', () => {
  const template = JSON.parse(read('agents/agent-history/agent.json.template'));
  assert.equal(template.operator.contact, '<OPERATOR_CONTACT>');
  assert.doesNotMatch(read('agents/agent-history/src/server.ts'), /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z]/, 'no address in the source');
  assert.match(exampleText, /^# OPERATOR_CONTACT is required: the service stops at start without it/m);
  assert.match(exampleText, /^OPERATOR_CONTACT=<role address, e\.g\. ecosystem@<foundation domain>; the Foundation confirms which>$/m);
});

test('RUNBOOK: the contact address is set in step 4 and checked in step 9, and the failure to start without it has a row in the failure table', () => {
  const four = section(runbook, '4. Make the env file and generate the supplier key');
  assert.ok(four.includes('`OPERATOR_CONTACT` is required'));
  assert.ok(four.includes("never a person's address"));
  assert.ok(four.includes("grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.agent-history"));
  assert.ok(section(runbook, '9. Start the service').includes('the role address of step 4 in `operator.contact`'));
  assert.match(section(runbook, 'If something goes wrong'), /environment variable OPERATOR_CONTACT is required/);
  assert.ok(readme.includes('`OPERATOR_CONTACT` is empty or missing'), 'the host administrator is told why the container restarts');
});

test('RUNBOOK step 9: the manifest check names the fields of the manifest v2 (the canonical DID, the listed supplier key, the registry address) and the key hash, and the service renders them from the legacy-form DID that step 7 writes', () => {
  const nine = section(runbook, '9. Start the service');
  for (const part of [
    '`vector.agent-manifest.v2` in `schema`',
    'the new DID of step 7 in its canonical form `did:vector:<identifier>` in `identity.did` (the env file holds the legacy form `did:vector:agent:<policy>:<identifier>` of the same identifier)',
    'the listed supplier key `<DID>#<key hash>` in `identity.supplier_key`', 'the key hash in `keys.supplier_pkh`', 'the public key in `keys.pub_key_hex`',
    'the address of the identity registry in `identity.registry_address` (empty while `IDENTITY_POLICY_ID` is empty in the env file)',
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
  assert.equal(runbook.includes('identity.controller_pkh'), false, 'the field that the manifest v2 removed');
  // Step 7 writes AGENT_DID in the legacy form, under the policy of the legacy registry; the service publishes the same identifier in the canonical form.
  assert.ok(section(runbook, '7. Register the identity').includes("grep -c '^AGENT_DID=did:vector:agent:'"));
  const policy = /^export const REGISTRY_POLICY = '([0-9a-f]{56})';$/m.exec(read('packages/vector-read/src/constants.ts'))[1];
  const id = 'ab'.repeat(32), pkh = 'cd'.repeat(28);
  const [legacy, canonical] = renderManifests([`did:vector:agent:${policy}:${id}`, `did:vector:${id}`].map((did) => ({ OPERATOR_CONTACT: TEST_CONTACT, AGENT_DID: did, SUPPLIER_PKH: pkh })));
  assert.equal(legacy.schema, 'vector.agent-manifest.v2');
  assert.deepEqual(legacy.identity, { did: `did:vector:${id}`, registry_address: '', supplier_key: `did:vector:${id}#${pkh}` });
  assert.equal(legacy.keys.supplier_pkh, pkh);
  assert.deepEqual(legacy, canonical, 'both forms of one identifier give the same manifest');
});

test('RUNBOOK: the seventeen steps in order, and the step numbers the other files quote are the right steps', () => {
  const STEPS = ['Put the files on the box', 'Log in to the registry and get the service image', 'Build the runtime image', 'Make the env file and generate the supplier key', 'Adapt the ops scripts', 'Supply the supplier wallet with its collateral and float', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
  assert.deepEqual([...runbook.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), STEPS.map((title, i) => [i + 1, title]));
  for (const m of runbook.matchAll(/\bsteps? (\d+)/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= STEPS.length, `step ${m[1]}`);
  const quoted = [...exampleText.matchAll(/RUNBOOK\.md step (\d+), "([^"]+)"/g)];
  assert.equal(quoted.length, 3, 'the example names steps 4, 7 and 17');
  for (const m of quoted) assert.equal(STEPS[Number(m[1]) - 1], m[2], `the example quotes step ${m[1]}`);
  assert.match(runbook, /does every step except three\. Step 2 \(the registry login and the service image\) and step 10 \(DNS and Caddy\) are the host administrator's, see \[README\.md\]\(README\.md\)\. Step 6 \(the collateral and float of the supplier wallet\) is the Foundation's\./);
  assert.match(section(runbook, '2. Log in to the registry and get the service image'), /^\nHost administrator\. /);
  assert.match(section(runbook, '6. Supply the supplier wallet with its collateral and float'), /^\nThe Foundation\. /);
  assert.match(section(runbook, '10. DNS and Caddy'), /^\nHost administrator, from/);
});

test('RUNBOOK: the manifest is final before it is hashed, and the hash is taken before the advert is posted', () => {
  const at = (needle) => { const i = runbook.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['./register-did.sh', './venv/bin/python m3-self-stake.py', 'up -d service', 'node scripts/manifest-hash.mjs', 'post-advert.ts --dry-run', 'ADVERT_REF=$(docker compose', 'up -d --force-recreate agent'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places, 'the commands appear in this order');
  const ups = runbook.match(/docker compose -f \S+ up -d[^\n`]*/g);
  assert.ok(ups.length >= 4, 'the runbook has the up commands');
  for (const cmd of ups) assert.match(cmd, /up -d (--force-recreate )?(service|agent)$/, `a bare up -d also starts the runtime: ${cmd}`);
  assert.doesNotMatch(runbook, /docker compose [^\n]*\brestart\b/);
});

test('RUNBOOK: the post-advert flags are the terms of the example and the spec, with the dry run and the real run identical', () => {
  const blocks = [...runbook.matchAll(/post-advert\.ts( --dry-run)? \x5c\n((?:  --[^\n]+\n)+)/g)];
  assert.equal(blocks.length, 2, 'a dry run and the real run');
  const flags = (body) => Object.fromEntries([...body.matchAll(/--([a-z-]+) (\S+?)(?: \x5c)?(?: \| tail -1\))?$/gm)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
  const [dry, real] = blocks.map((m) => flags(m[2]));
  assert.deepEqual(dry, real);
  assert.deepEqual(real, {
    'capability-id': example.ADVERT_CAPABILITY_ID, model: example.ADVERT_MODEL, 'max-output-tokens': '8192', 'price-lovelace': example.ADVERT_PRICE_LOVELACE,
    'max-processing-ms': example.ADVERT_MAX_PROCESSING_MS, 'endpoint-url': example.ADVERT_ENDPOINT_URL, 'detail-uri': example.ADVERT_DETAIL_URI, 'detail-hash': '$DETAIL_HASH',
  });
  assert.ok(blocks[0][1], 'the first block is the dry run');
});

test('RUNBOOK: the registry record is the manifest description, the spec capability and framework, and the public URL', () => {
  const desc = /^DESC="(.+)"$/m.exec(runbook)[1];
  const [{ description }] = renderManifests([{ OPERATOR_CONTACT: TEST_CONTACT }]);
  assert.equal(desc, description);
  assert.ok(desc.length <= 256, 'the registry takes 256 characters of description');
  assert.ok(runbook.includes('"capabilities":["identity.history.report.v1"]') && runbook.includes('CAPABILITIES = ["identity.history.report.v1"]'));
  assert.ok(runbook.includes('"framework":"vector-service-agents"') && SPEC.includes('framework `vector-service-agents`'));
  assert.ok(runbook.includes(`"endpoint":"${example.ADVERT_ENDPOINT_URL}"`));
  assert.ok(runbook.includes(`(this one is ${desc.length})`), 'the length the runbook quotes');
});

test('RUNBOOK: the collateral and float come in two transfers (5 alone, then 50), and the key is generated on the box and is the only copy', () => {
  assert.match(runbook, /exactly 5 units alone/);
  assert.match(runbook, /then 50 units/);
  assert.match(runbook, /this file is the only copy until step 7\. There is no recovery phrase/);
  // Step 7 writes a second plaintext copy of the key, and the runbook says so where it happens, where the key is generated and in Back out.
  assert.ok(section(runbook, '4. Make the env file and generate the supplier key').includes('Step 7 writes a second plaintext copy of the key to `$BASE/ops/wallet`'));
  assert.match(section(runbook, '7. Register the identity'), /That file is a second plaintext copy of the supplier key, next to the one in the env file\./);
  assert.ok(section(runbook, 'Back out').includes('4. Operator: remove the second plaintext copy of the supplier key that step 7 wrote, two files in a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory).'));
  assert.doesNotMatch(section(runbook, 'Back out'), /shred -u "\$BASE\/ops\/wallet"`/, 'shred does not take a directory');
  assert.match(runbook, /gen-keypair\.ts --network 1/);
  assert.match(runbook, /chmod 600 \.env\.agent-history/);
  assert.match(runbook, /read -rs GHCR_TOKEN/);
});

test('RUNBOOK: ends with the two gotchas of the README of the existing identity scripts, word for word', () => {
  assert.ok(runbook.includes("\n## Two gotchas that cost real transactions\n\nCopied from the README of the operator's existing identity scripts. Do not re-learn them.\n"), 'where they come from, without a stack or a path');
  const GOTCHAS = [
    '**1. Never re-serialize an MCP-built transaction.** `sign-tx.py` splices the',
    'signature in while preserving every original byte of both the body and the',
    "witness set. A decode/re-encode round-trip canonicalizes Plutus data's",
    'indefinite-length arrays (`d8799f…ff` → definite), which changes',
    '`script_data_hash` and the ledger rejects with `PPViewHashesDontMatch`',
    '(observed on the first registry attempt). Re-serializing the body alone',
    'changes the tx id and voids the signature.',
    '',
    '**2. The Module-3 SDK is testnet-pinned.** `constants.py` ships',
    '`SYSTEM_START_UNIX_S = 1752057484` (testnet genesis) plus testnet Ogmios and',
    'submit URLs. On mainnet you must pass mainnet endpoints explicitly AND patch',
    'the genesis constant to `1756485600`, or `StakeDatum.last_updated` lands ~51',
    'days off, fails Rule 6 of `validate_create_stake`, and the script aborts with',
    'an opaque "terminated with error". `m3-self-stake.py` patches it and asserts',
    'the result against wall clock before locking anything.',
  ].join('\n');
  assert.ok(runbook.trimEnd().endsWith(GOTCHAS), 'the gotchas are the last thing in the runbook');
});

test('README: the host administrator is told the DNS names, the ports, the registry login, the image tags, the env-file rule and the rollback', () => {
  for (const host of ['mp-suppliers-history.hal8.ai', 'mp-suppliers-pipeline.hal8.ai', 'mp-suppliers-snippets.hal8.ai', 'mp-suppliers-advocate.hal8.ai']) {
    assert.ok(readme.includes(`\`${host}\``), host);
    assert.ok(DESIGN.includes(host), `the design names ${host}`);
  }
  assert.ok(readme.includes('`127.0.0.1:8083`') && readme.includes('loopback'));
  assert.ok(readme.includes('docker login ghcr.io') && readme.includes('read:packages'));
  assert.ok(readme.includes(':latest') && readme.includes(':<full git commit sha>'));
  assert.ok(readme.includes('[RUNBOOK.md](RUNBOOK.md), under "Back out"'), 'the rollback note points at the runbook section');
  assert.ok(!readme.includes('retire-advert.ts'), 'the retire command lives in one place, the runbook');
  assert.ok(readme.includes('--force-recreate') && readme.includes('does not re-read it'));
  for (const container of [agent.container_name, service.container_name]) assert.ok(readme.includes(`\`${container}\``), container);
});

test('RUNBOOK step 17: the old advert is retired before the service restarts and before the new manifest is hashed', () => {
  const s17 = section(runbook, '17. Flip the status');
  const at = (needle) => { const i = s17.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['1. Check `curl', '2. Retire the old advert (Back out, point 1)', '3. In `.env.agent-history`', '4. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate service`', '5. Hash the new manifest (step 11)', '6. Post the new advert (step 12)', '7. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate agent`', '8. In the repository'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places, 'retire, edit, recreate the service, hash, post, recreate the runtime, update the repository');
  assert.match(s17, /no Active advert carries a stale `detail_hash` while the service restarts/);
});

// Every file of the repository, as a path with forward slashes, without the folders that hold other people's files or the design spec.
function repoFiles(dir = '', out = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!['node_modules', '.git', '.superpowers'].includes(e.name) && rel !== 'docs/superpowers') repoFiles(rel, out); } else out.push(rel);
  }
  return out;
}

test('RUNBOOK step 17: the last item names the files that said PROPOSED about Agent History before the flip, the code that carried the word, the advert reference, and only files that exist', () => {
  const s17 = section(runbook, '17. Flip the status');
  const item8 = s17.slice(s17.indexOf('8. In the repository'));
  // The files that said PROPOSED about Agent History, or carried the word as a value, until the flip of 2026-10-15. After the flip they no longer say it, so the list is pinned here; the test below finds a word that comes back.
  const FILES = ['specs/agent-history.md', 'agents/agent-history/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md', 'deploy/host/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/Caddyfile.snippet', 'deploy/host/.env.agent-history.example'];
  const CODE = ['agents/agent-history/src/server.ts', 'agents/agent-history/agent.json.template', 'agents/agent-history/test/server.test.ts', 'agents/agent-history/test/spec.test.ts', 'scripts/specs.test.mjs', 'scripts/deploy.test.mjs'];
  for (const f of [...FILES, ...CODE]) {
    assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  assert.match(item8, /regenerate it from the code, never by hand/);
  assert.match(item8, /The Identity and Links sections of the spec .* were refreshed after steps 7 and 12; check that they are still true\./);
  // The advert is posted again at the flip, so its reference changes: the runbook says where the new one goes and that the old one stays in the Links as history.
  assert.ok(item8.includes('The new advert has a new reference: replace the old one wherever it is given as the current advert (`specs/agent-history.md`, `docs/HIRE.md`, `docs/E2E.md` and the default of `ADVERT_REF` in `scripts/run-e2e-from-keyfile.sh`), and keep it in the Links section of the spec as the retired advert.'));
  assert.ok(existsSync(join(root, 'scripts/run-e2e-from-keyfile.sh')), 'the wrapper that item 8 names exists');
  for (const [, named] of item8.matchAll(/`([A-Za-z0-9_.\/-]+\.(?:md|yml|snippet|example|ts|mjs|template))`/g)) assert.ok(existsSync(join(root, named)), `item 8 names a file that exists: ${named}`);
});

// ---- The status words after the flips of 2026-10-15, 2026-10-16, 2026-10-17 and 2026-10-20 ----
// Agent History, Document Pipeline, Audio Snippets and Advocate are DEPLOYED. Nothing here is LIVE.
// A line that says PROPOSED has to be one of the lines below, so the word cannot come back for an agent that is deployed; a line that says LIVE has to deny it.
test('status words: no file says PROPOSED about Agent History, Document Pipeline, Audio Snippets or Advocate, and no file says LIVE except to deny it', () => {
  // The four deploy files of Audio Snippets and of Advocate, and their READMEs: since the flips of 2026-10-17 and 2026-10-20 they are held to the rule as the files of the other two are.
  const SNIPPETS_FILES = [...S_FILES, 'agents/audio-snippets/README.md'];
  const ADVOCATE_FILES = [...A_FILES, 'agents/advocate/README.md'];
  // What may still say PROPOSED: the rule that lists the three words, the marketplace tools in the Interface section of a spec (the tools, not the agent), the instructions of the four
  // runbooks that speak for the order of a first run, and the status line and README row of each use-case page.
  const PROPOSED_OK = {
    'agents/agent-history/README.md': [/`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./],
    'specs/agent-history.md': [/^The marketplace MCP tools \(PROPOSED\) and the template's buyer, /],
    'deploy/host/RUNBOOK.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Agent History/],
    'deploy/host/RUNBOOK-document-pipeline.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about the Document Pipeline/],
    'deploy/host/RUNBOOK-audio-snippets.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Audio Snippets/],
    'deploy/host/RUNBOOK-advocate.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Advocate/],
    'specs/reorder-agent.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-23\.$/],
    'specs/order-desk.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-23\.$/],
    'specs/prior-authorization-agent.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-24\.$/],
    'specs/insurer-intake-agent.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-24\.$/],
    'specs/sourcing-agent.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-24\.$/],
    'specs/bid-desk.md': [/^PROPOSED \(built, not deployed\)\. Since 2026-11-24\.$/],
    'README.md': [
      /^\| Reorder Agent \| `supplychain\.reorder\.po\.v1` \| PROPOSED \|$/, /^\| Order Desk \| `supplychain\.order\.accept\.v1` \| PROPOSED \|$/,
      /^\| Prior Authorization Agent \| `health\.priorauth\.draft\.v1` \| PROPOSED \|$/, /^\| Insurer Intake Agent \| `health\.priorauth\.intake\.v1` \| PROPOSED \|$/,
      /^\| \[Sourcing Agent\]\(specs\/sourcing-agent\.md\) \| `supplychain\.rfq\.evaluate\.v1` \| PROPOSED \|$/,
      /^\| \[Bid Desk\]\(specs\/bid-desk\.md\) \| `supplychain\.rfq\.quote\.v1` \| PROPOSED \|$/,
    ],
  };
  // What may say LIVE: the sentence that denies it, and the rule that lists the three words.
  const LIVE_OK = [/Nothing (on this page|in this guide|in this folder|in this section) is LIVE( or DEPLOYED)?\./, /`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./];
  const files = repoFiles().filter((f) => /(\.md|\.yml|Caddyfile\.snippet|Caddyfile\.[a-z-]+\.snippet|\.example|\.template)$/.test(f));
  for (const f of ['specs/agent-history.md', 'specs/advocate.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/README.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/Caddyfile.snippet', 'deploy/host/.env.agent-history.example', 'agents/agent-history/agent.json.template', ...PIPELINE_FILES, ...SNIPPETS_FILES, ...ADVOCATE_FILES, 'agents/advocate/agent.json.template']) assert.ok(files.includes(f), `${f} is walked`);
  for (const f of files) {
    const lines = read(f).split('\n');
    for (const line of lines.filter((l) => /\bPROPOSED\b/.test(l))) assert.ok((PROPOSED_OK[f] ?? []).some((re) => re.test(line)), `${f} says PROPOSED: ${line.slice(0, 110)}`);
    for (const line of lines.filter((l) => /\bLIVE\b/.test(l))) assert.ok(LIVE_OK.some((re) => re.test(line)), `${f} says LIVE: ${line.slice(0, 110)}`);
  }
  // The values the manifest and the env example carry are neither proposed nor live.
  assert.match(exampleText, /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/agent-history/agent.json.template')).status, { chip: 'deployed', since: '2026-10-15' });
  assert.match(read('deploy/host/.env.document-pipeline.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/document-pipeline/agent.json.template')).status, { chip: 'deployed', since: '2026-10-16' });
  assert.match(read('deploy/host/.env.audio-snippets.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/audio-snippets/agent.json.template')).status, { chip: 'deployed', since: '2026-10-17' });
  // Advocate is DEPLOYED since 2026-10-20, in the line of its spec, and its env example and its manifest carry the word deployed since that day. Document Pipeline is DEPLOYED since 2026-10-16
  // and Audio Snippets since 2026-10-17, each in the line of its spec.
  assert.match(read('specs/advocate.md'), /^DEPLOYED \(registered and staked 2026-10-19, advertised 2026-10-19, re-advertised 2026-10-20 at the status flip, one first-party job settled 2026-10-20\)\. Since 2026-10-20\.$/m);
  assert.match(read('deploy/host/.env.advocate.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/advocate/agent.json.template')).status, { chip: 'deployed', since: '2026-10-20' });
  assert.match(read('specs/audio-snippets.md'), /^DEPLOYED \(registered and staked 2026-10-17, advertised 2026-10-17, re-advertised 2026-10-17 at the status flip, one first-party job settled 2026-10-17\)\. Since 2026-10-17\.$/m);
  assert.match(read('specs/document-pipeline.md'), /^DEPLOYED \(registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16\)\. Since 2026-10-16\.$/m);
  // Only the use-case pages open with PROPOSED. Read the folder to check for extra pages.
  const proposed = readdirSync(join(root, 'specs')).filter((f) => /^PROPOSED \(/m.test(read(`specs/${f}`))).map((f) => `specs/${f}`).sort();
  assert.deepEqual(proposed, ['specs/bid-desk.md', 'specs/insurer-intake-agent.md', 'specs/order-desk.md', 'specs/prior-authorization-agent.md', 'specs/reorder-agent.md', 'specs/sourcing-agent.md'], 'only the six use-case pages say PROPOSED');
  assert.equal(readdirSync(join(root, 'specs')).filter((f) => /^DEPLOYED \(/m.test(read(`specs/${f}`))).length, 4, 'the four specs open their status line with DEPLOYED');
});

test('RUNBOOK: Back out retires the advert first with the supplier key, then stops the services, then the host administrator removes the Caddy block', () => {
  const back = section(runbook, 'Back out');
  const at = (needle) => { const i = back.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['1. Retire the advert.', 'Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted', 'agent/src/cli/retire-advert.ts', '--advert-ref', '2. Stop the containers', 'docker compose -f docker-compose.agent-history.yml down', '3. Host administrator: remove the Caddy block', '4. Operator: remove the second plaintext copy'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places);
  assert.match(back, /signed with the supplier key in the env file/);
  assert.ok(runbook.indexOf('\n## Back out\n') > runbook.indexOf('\n## 17.') && runbook.indexOf('\n## Back out\n') < runbook.indexOf('\n## If something goes wrong\n'), 'after step 17, before the failure table');
});

test('RUNBOOK: the spec is refreshed in a pull request after the identity (step 7) and after the advert (step 12), and the service is asked by key hash before the advert', () => {
  const seven = section(runbook, '7. Register the identity');
  assert.ok(seven.includes('Record the identity in the repository.') && seven.includes('the DID and the registration transaction into the Identity section of `specs/agent-history.md`') && seven.includes('`scripts/specs.test.mjs`'));
  // The record exists since 2026-10-14, so the spec no longer says it has none, and the runbook does not quote that sentence as what the spec still says.
  assert.ok(seven.includes('the "Registry record" row and the sentence that says the agent has a registry record'));
  assert.equal(seven.includes('This agent has no registry record yet.'), false);
  assert.equal(seven.includes('Registry record, planned'), false);
  assert.equal(SPEC.includes('This agent has no registry record yet.'), false);
  assert.ok(seven.indexOf('Record the identity in the repository.') > seven.indexOf("grep -c '^AGENT_DID=did:vector:agent:'"), 'after the identity is checked');
  const twelve = section(runbook, '12. Post the advert');
  assert.ok(twelve.includes('Record the advert in the repository.') && twelve.includes('"Advert on the explorer: none yet. The advert is not posted."'));
  // The explorer link is checked as the sentence the runbook gives it in, anchored on its words: a bare URL prefix in an includes() reads as a URL check to a scanner.
  assert.match(twelve, /The link is `https:\/\/explorer\.vector\.mainnet\.apexfusion\.org\/transaction\/hash\/` followed by the transaction id/);
  assert.ok(twelve.includes('The status word stays PROPOSED until step 17.'));
  assert.ok(twelve.indexOf('Record the advert in the repository.') > twelve.indexOf('ADVERT_REF=$(docker compose'), 'after the advert is posted');
  assert.match(section(runbook, '17. Flip the status'), /refreshed after steps 7 and 12/);
  const nine = section(runbook, '9. Start the service');
  assert.ok(nine.includes("KEY=$(sed -n 's/^SUPPLIER_PKH=//p' .env.agent-history)"), 'the key hash comes from the env file');
  assert.ok(nine.includes('`subject.kind` is `pkh`, `subject.candidates` lists the record of step 7, and `marketplace` is an object.'));
  assert.ok(nine.includes('docs/HIRE.md') && nine.includes('section 7 invites members to use'), 'why the key-hash query is asked');
  assert.ok(nine.indexOf('"$KEY"') > nine.indexOf('"$DID"'), 'after the query by DID');
  assert.ok(runbook.indexOf('"$KEY"') < runbook.indexOf('## 12.'), 'before the advert is posted');
});

test('RUNBOOK: the key is never sent anywhere, the registry login block is bash, the hash script runs on the machine of the operator from the root of a checkout, the marketplace tools are on the hosted mainnet server, the wallet monitor is named', () => {
  assert.match(section(runbook, '4. Make the env file and generate the supplier key'), /is never sent anywhere\./);
  assert.doesNotMatch(runbook, /never leaves/);
  assert.match(section(runbook, '2. Log in to the registry and get the service image'), /```bash\nread -rs GHCR_TOKEN/);
  // The box has no Node (2026-10-17): the script runs on the operator's machine, from the root of a checkout, and the box cross-checks the raw bytes with curl and sha256sum.
  assert.match(section(runbook, '11. Hash the manifest'), /```sh\nnode scripts\/manifest-hash\.mjs /);
  assert.ok(section(runbook, '11. Hash the manifest').includes("Operator. The script runs on the operator's machine, from the root of a checkout of the repository, with Node 22: the box has no Node. It only fetches public bytes:"));
  assert.ok(section(runbook, '11. Hash the manifest').includes('The box cross-checks the raw bytes with `curl -fsS https://mp-suppliers-history.hal8.ai/agent.json | sha256sum`: the two must agree.'));
  const s15 = section(runbook, '15. The first-party run');
  assert.ok(s15.includes('As of 2026-10-14 the nine marketplace tools the script needs are merged into `main` of Apex-Fusion/mcp-server (PR 1 as [#20](https://github.com/Apex-Fusion/mcp-server/pull/20), PR 2 as [#21](https://github.com/Apex-Fusion/mcp-server/pull/21) and PR 3 as [#23](https://github.com/Apex-Fusion/mcp-server/pull/23) with PR 2) and are on the hosted mainnet MCP server, which lists 33 tools.'));
  assert.ok(s15.includes('PR 4 ([#22](https://github.com/Apex-Fusion/mcp-server/pull/22)), the signer package with its `keygen` command, is merged too, and the package is published on npm (`@apexfusion/vector-mcp-signer`, version 2.0.0, on 2026-10-16).'));
  assert.doesNotMatch(s15, /package is not published/, 'the words of before the publication');
  assert.doesNotMatch(s15, /and PR 4 as/, 'PR 4 is the signer, not one of the nine marketplace tools');
  assert.ok(s15.includes('The default `BUILDER_URL` of the script is the hosted mainnet MCP server, so the run needs no local builder. E2E.md keeps the local build of `main` as the fallback for a builder that lacks the tools.'));
  assert.ok(s15.includes('Add the run to the Results table in E2E.md. Only a run that ends in the printed evidence counts. The first run, made on 2026-10-15, is recorded in E2E.md.'));
  assert.doesNotMatch(s15, /PR 2 is open|PR 3 and PR 4 follow|PRs 2 and 3 follow|are deployed|PR 3 branch/);
  assert.doesNotMatch(s15, /cutover|cuts it over|24 tools|none of them a marketplace tool|awaiting the|still serves/i, 'nothing waits for a cutover any more');
  const s16 = section(runbook, '16. Wallet monitor');
  assert.ok(s16.includes('`Apex-Fusion/agents-marketplace`') && s16.includes('`wallet-monitor/wallets.json`'));
  assert.doesNotMatch(s16, /upstream repository/);
});

test('agent README: the Image section says the publish job pushes on merge to main, that it has run since the repository went public on 2026-10-16 and the image is public, that the box still builds its own, and that the agent is running on the box with the status DEPLOYED since 2026-10-15', () => {
  const image = section(read('agents/agent-history/README.md'), 'Image');
  assert.ok(image.length > 300, 'the section exists');
  assert.ok(image.includes('docker build -f agents/agent-history/Dockerfile'));
  assert.ok(image.includes('pushes the image on merge to `main`'));
  assert.ok(image.includes('It has run on each merge to `main` since the repository went public on 2026-10-16, and the image is public; the box still builds the image itself.'));
  // The repository and the images on ghcr.io are public since 2026-10-16. The places that said private say what is true now, and no deploy file says private again.
  assert.ok(readme.includes('2. **Registry login.** The package is public since 2026-10-16, so the login is optional, and the host still builds the image itself (point 3).'));
  assert.ok(section(runbook, '1. Put the files on the box').includes('The repository is public since 2026-10-16, so the box needs no GitHub credentials to clone it.'));
  assert.ok(section(runbook, '2. Log in to the registry and get the service image').includes('The package is public since 2026-10-16: the login is optional, and its token needs `read:packages`. The host still builds the image itself (below).'));
  for (const rel of [...PUBLIC_FILES, 'agents/agent-history/README.md']) assert.doesNotMatch(read(rel), /repository is private|private repository|package is private/i, rel);
  assert.ok(image.includes('The agent is running on the box, and its status has been DEPLOYED since 2026-10-15.'));
  assert.equal(image.includes('Nothing is deployed yet.'), false);
});

// ======================================================================================================================================
// The Document Pipeline (DEPLOYED since 2026-10-16): the second stack on the same box.
// Built on 2026-10-15; steps 1 to 15 and 17 of its runbook were run on 2026-10-16. The four files, the section of the README and the CI lines are held to each other,
// to the service code, to the spec, and to the Agent History files they follow. docker compose config, docker build and caddy validate are run by hand.
// ======================================================================================================================================
const PSPEC = read('specs/document-pipeline.md');
const PREADME = read('agents/document-pipeline/README.md');
const START = read('agents/document-pipeline/src/start.ts');
const pComposeText = read('deploy/host/docker-compose.document-pipeline.yml');
const pCompose = parseYaml(pComposeText);
const pExampleText = read('deploy/host/.env.document-pipeline.example');
// The one quoted value in the Pipeline example is SERVICE_AUTH_HEADER="" : the value that step 4 writes in its place has a space in it, and the ops scripts read the file with
// the shell's ".", so it is quoted. The map the checks below read has the quotes off a quoted value, as the shell and Docker Compose take them off.
const pExampleRaw = parseEnv(pExampleText);
const pExample = Object.fromEntries(Object.entries(pExampleRaw).map(([name, value]) => [name, /^"(.*)"$/.exec(value)?.[1] ?? value]));
const pRunbook = read('deploy/host/RUNBOOK-document-pipeline.md');
const pSnippet = read('deploy/host/Caddyfile.document-pipeline.snippet');
const pDockerfile = read('agents/document-pipeline/Dockerfile');
const { agent: pAgent, service: pService } = pCompose.services;
const pSection = readme.split('\n## Document Pipeline on the same box\n')[1]?.split('\n## ')[0] ?? '';
const pSpecNumber = (re) => Number(re.exec(PSPEC)?.[1]);
const P_TERMS = {
  price: pSpecNumber(/\| Price \| (\d+) \|/), supplierBond: pSpecNumber(/\| Supplier bond \| (\d+) \|/), buyerBond: pSpecNumber(/\| Buyer bond \| (\d+) \|/),
  window: pSpecNumber(/advert `max_processing_ms` \| (\d+) ms/), timeout: pSpecNumber(/Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/),
};
// What the code of the service holds as its defaults: the example writes the same values, so that a change is visible and reviewed.
const OCR_DEFAULT = /export const OCR_SUPPLIER_PKH_DEFAULT = '([0-9a-f]{56})';/.exec(START)?.[1];
const LLM_DEFAULT = /export const LLM_MODELS_DEFAULT: readonly string\[\] = \[([^\]]+)\];/.exec(START)?.[1].split(',').map((m) => m.trim().slice(1, -1));
// The stop wait is packages/service-kit's (src/lifecycle.ts), and the Pipeline's start.ts re-exports it (the test of the grace period below holds both).
const WAIT_S = Number(/export const SHUTDOWN_WAIT_MS = ([\d_]+);/.exec(read('packages/service-kit/src/lifecycle.ts'))?.[1].replaceAll('_', '')) / 1000;
// A snippet run through the real code of the Pipeline (tsx), with its argument passed as JSON, so that nothing here re-implements the service.
function inPipeline(code, arg) {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(arg)], { cwd: join(root, 'agents/document-pipeline'), encoding: 'utf8' }));
}
const P_SUPPLIER = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'];
const P_BUYER = ['PIPELINE_BUYER_PRIV_KEY_HEX', 'PIPELINE_BUYER_PUB_KEY_HEX', 'PIPELINE_BUYER_PKH', 'PIPELINE_BUYER_ADDRESS'];
const P_TOKEN = ['SERVICE_AUTH_HEADER']; // the token between the two containers (ruling R50)
const P_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', ...RUNTIME_IDENTITY];
// The identity registry deployment that packages/buyer-core reads (BUYER_IDENTITY_SETTINGS): the values that the deployment on Vector mainnet published on 2026-11-03.
const P_IDENTITY = ['VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO'];
const P_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const P_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
const P_HIRES = ['OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST'];
const P_STEPS = ['Put the files on the box', 'Build the service image and pin it', 'Build the runtime image', 'Make the env file and generate the two keys', 'Adapt the ops scripts', 'Supply the two wallets with their collateral and float', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
const P_STATUS = 'DEPLOYED since 2026-10-16';

test('Pipeline compose: the project and two containers have fixed names, the runtime is on loopback port 8084, the service is published nowhere, both are on the shared network and need the env file', () => {
  assert.equal(pCompose.name, 'document-pipeline');
  assert.deepEqual(Object.keys(pCompose.services), ['agent', 'service']);
  assert.equal(pAgent.container_name, 'document-pipeline-agent');
  assert.equal(pService.container_name, 'document-pipeline-service');
  assert.deepEqual(pAgent.ports, ['127.0.0.1:8084:8080']);
  assert.notDeepEqual(pAgent.ports, agent.ports, 'not the port of Agent History');
  assert.equal(pService.ports, undefined, 'the service answers POST / only with the token of the runtime (R50), and no port is published all the same: the token is the second lock, and anything that holds it can post escrows from the buyer wallet');
  assert.deepEqual(pAgent.networks, ['proxy']);
  assert.deepEqual(pService.networks, ['proxy']);
  assert.deepEqual(pCompose.networks, { proxy: { external: true, name: PROXY_NETWORK_NAME } }, 'the network of Agent History, named the same way');
  assert.deepEqual(pAgent.depends_on, ['service']);
  for (const [name, s, history] of [['agent', pAgent, agent], ['service', pService, service]]) {
    assert.deepEqual(s.env_file, [{ path: './.env.document-pipeline', required: true }], name);
    assert.equal(s.restart, 'unless-stopped', name);
    assert.deepEqual(s.logging, history.logging, `${name}: the log rotation of Agent History`);
  }
});

test('Pipeline compose: the runtime is built from the template commit of Agent History, written in full', () => {
  assert.equal(pAgent.build.context, agent.build.context);
  assert.equal(pAgent.build.dockerfile, 'agent/Dockerfile');
  assert.match(pAgent.build.context, /^https:\/\/github\.com\/Apex-Fusion\/vector-agent-template\.git#a05564c[0-9a-f]{33}$/);
  assert.ok(PSPEC.includes('pinned commit `a05564c`'), 'the spec names the same commit');
});

test('Pipeline compose: SERVICE_URL names the service container, port 9092 and the path /, and is not the shared alias "service"', () => {
  const url = new URL(pAgent.environment.SERVICE_URL);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, pService.container_name, 'the container name is unique on the shared network; the alias "service" would match every agent');
  assert.equal(url.port, pService.environment.PORT);
  assert.equal(url.pathname, '/', 'the service accepts POST on / only');
  assert.equal(pAgent.environment.SERVICE_URL, 'http://document-pipeline-service:9092/');
  assert.equal(pAgent.environment.CAPABILITY_KIND, 'custom');
  assert.equal(pAgent.environment.SERVICE_CONTENT_TYPE, 'application/json');
});

test('Pipeline compose: the service image is named by digest (a placeholder in the repository), on one line that step 2 rewrites and step 9 checks', () => {
  assert.match(pService.image, /^ghcr\.io\/apex-fusion\/vector-service-agents\/document-pipeline@sha256:(<digest>|[0-9a-f]{64})$/);
  assert.doesNotMatch(pService.image, /:latest/);
  assert.match(pComposeText, /# Pinned by digest, not by tag\./);
  // The sed of step 2 rewrites the one line that starts with four spaces and "image: ", and the file still reads as a compose file afterwards.
  assert.equal(pComposeText.split('\n').filter((l) => /^    image: /.test(l)).length, 1);
  const pinned = pComposeText.replace(/^    image: .*$/m, `    image: sha256:${'ab'.repeat(32)}`);
  assert.equal(parseYaml(pinned).services.service.image, `sha256:${'ab'.repeat(32)}`);
  const two = section(pRunbook, '2. Build the service image and pin it');
  assert.match(two, /^\nOperator\. Nothing is pulled from a registry for this agent, so there is no login\./);
  for (const part of [
    'docker build -f agents/document-pipeline/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/document-pipeline:latest .',
    "docker image inspect --format '{{index .RepoDigests 0}}' \"$IMAGE:latest\" 2>/dev/null || docker image inspect --format '{{.Id}}' \"$IMAGE:latest\"",
    'sed -i "s|^    image: .*|    image: $PIN|" docker-compose.document-pipeline.yml',
    'grep -Eq "^($IMAGE@sha256:|sha256:)[0-9a-f]{64}\\$"',
    '`@sha256:<digest>`', '`invalid reference format`', '`docker image prune -a`',
  ]) assert.ok(two.includes(part), `step 2 says: ${part}`);
  assert.ok(existsSync(join(root, 'agents/document-pipeline/Dockerfile')), 'the Dockerfile the step builds');
  assert.ok(two.indexOf('docker build') < two.indexOf('docker image inspect'), 'the pin is taken after the build');
  const nine = section(pRunbook, '9. Start the service');
  assert.ok(nine.includes("grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/document-pipeline@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.document-pipeline.yml"));
  assert.ok(nine.indexOf('First check the pin of step 2.') < nine.indexOf('up -d service'), 'checked before the service is started');
  // The check the runbook gives accepts a real digest line and an image ID, and refuses the placeholder.
  const check = /^    image: (ghcr[.]io\/apex-fusion\/vector-service-agents\/document-pipeline@sha256:|sha256:)[0-9a-f]{64}$/;
  assert.match(`    image: ghcr.io/apex-fusion/vector-service-agents/document-pipeline@sha256:${'ab'.repeat(32)}`, check);
  assert.match(`    image: sha256:${'ab'.repeat(32)}`, check);
  assert.doesNotMatch('    image: ghcr.io/apex-fusion/vector-service-agents/document-pipeline@sha256:<digest>', check);
  assert.doesNotMatch(pComposeText, /agent-history/, 'nothing of Agent History is left in the file');
});

test('Pipeline compose: each container gets only its own key, the other one is blanked in its environment', () => {
  assert.equal(pAgent.environment.PIPELINE_BUYER_PRIV_KEY_HEX, '', 'the runtime must not hold the buyer key: an empty string overrides the value from env_file');
  assert.ok(!('SUPPLIER_PRIV_KEY_HEX' in pAgent.environment), 'the runtime reads the supplier key from the env file');
  assert.equal(pService.environment.SUPPLIER_PRIV_KEY_HEX, '', 'the service must not hold the supplier key');
  assert.ok(!('PIPELINE_BUYER_PRIV_KEY_HEX' in pService.environment), 'the service reads the buyer key from the env file');
});

test('Pipeline compose: the token between the containers (R50) is blanked in neither, so that both read the one value from the env file, and the comments say what each side does with it and when to recreate', () => {
  // The runtime sends SERVICE_AUTH_HEADER as the authorization header of every call (vector-agent-template a05564c, agent/src/executor/httpCallout.ts), and the service requires it on POST /.
  assert.ok(!('SERVICE_AUTH_HEADER' in pAgent.environment), 'the runtime reads the token from the env file: a blank here would send no header');
  assert.ok(!('SERVICE_AUTH_HEADER' in pService.environment), 'the service reads the token from the env file: a blank here would stop the start');
  assert.ok('SERVICE_AUTH_HEADER' in pExample, 'the env file has the line, so both containers get it');
  assert.ok(pComposeText.includes('# SERVICE_AUTH_HEADER is the one value both need, so neither blanks it: the runtime sends it as the authorization header of every call to the service (SERVICE_URL below), and the service requires it on POST / (ruling R50).'));
  assert.ok(pComposeText.includes('    # The service answers POST / only to a call that carries SERVICE_AUTH_HEADER, which the runtime sends, and no port is published: the network is shared with other stacks, and a job posts escrows from the buyer wallet.'));
  assert.doesNotMatch(pComposeText, /no authentication/i, 'the comment of before R50');
  // After any change to the env file the containers are recreated, and only while no job runs: a stop during a job is the one thing that can cut a job under escrow.
  // The runtime's /status exists from step 13 of the runbook: before it no job can run, and the precondition says so (C4).
  assert.ok(pComposeText.includes('# After any change to it, recreate the containers. Once the runtime runs (step 13 of RUNBOOK-document-pipeline.md), recreate only when its /status says free (curl -s http://127.0.0.1:8084/status): a stop during a job can cut a job under escrow. Before step 13 no job can run.'));
  assert.ok(pComposeText.includes('docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate <service>. restart does not re-read it.'));
  assert.ok(pComposeText.includes('A change to SERVICE_AUTH_HEADER needs both containers recreated.'));
  // The runtime sends the header only when its setting is not empty (the template's executor), so a service started without a token would refuse every call, or, if it did not check, answer anyone:
  // the service reads it as a required setting and stops at start without it.
  assert.ok(START.includes("requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER,"), 'the service refuses to start without the token');
});

test('Pipeline compose: the processing window and the service timeout are the spec terms and nest as the runtime requires; the ports are the ones of the image', () => {
  assert.equal(Number(pAgent.environment.ADVERT_MAX_PROCESSING_MS), P_TERMS.window);
  assert.equal(Number(pAgent.environment.SERVICE_TIMEOUT_MS), P_TERMS.timeout);
  assert.deepEqual([P_TERMS.window, P_TERMS.timeout], [1_800_000, 1_680_000]);
  assert.ok(Number(pAgent.environment.SERVICE_TIMEOUT_MS) <= Number(pAgent.environment.ADVERT_MAX_PROCESSING_MS) - 60_000, 'the runtime refuses to boot otherwise');
  assert.equal(pAgent.environment.PORT, '8080');
  assert.equal(pService.environment.PORT, '9092');
  assert.equal(pService.environment.HOST, '0.0.0.0');
  assert.match(pDockerfile, /^ENV NODE_ENV=production PORT=9092 HOST=0\.0\.0\.0$/m);
  assert.match(pDockerfile, /^EXPOSE 9092$/m);
  assert.match(pDockerfile, /^HEALTHCHECK .* http:\/\/127\.0\.0\.1:9092\/healthz /m);
  assert.ok(START.includes('export const PORT_DEFAULT = 9092;'));
});

test('Pipeline compose: the state is a named volume at /data, memory is limited, and the grace period covers the 300 s the service waits for a running job', () => {
  assert.deepEqual(pService.volumes, ['document-pipeline-state:/data']);
  assert.deepEqual(pCompose.volumes, { 'document-pipeline-state': { name: 'document-pipeline-state' } }, 'named, so that the volume has the name the runbook gives');
  assert.equal(pAgent.volumes, undefined, 'the runtime keeps no state');
  assert.equal(pService.environment.PIPELINE_STATE_DIR, '/data');
  assert.match(pDockerfile, /^VOLUME \/data$/m);
  assert.ok(START.includes("export const STATE_DIR_DEFAULT = '/data';"));
  assert.equal(pService.mem_limit, '1536m');
  assert.equal(WAIT_S, 300, 'the service waits up to 300 s for the job that is running');
  assert.match(START, /^export \{ SHUTDOWN_WAIT_MS \} from '@vsa\/service-kit';$/m, 'the wait of the kit, re-exported by the Pipeline');
  // The residual round: Docker allows 30 s more than the service waits, so that a job abandoned at the end of the wait is logged with its escrows and the
  // exit code is the service's 1, not Docker's 137.
  assert.equal(pService.stop_grace_period, '330s');
  assert.equal(Number(/^(\d+)s$/.exec(pService.stop_grace_period)?.[1]), WAIT_S + 30, 'the grace period is the wait and 30 s more');
  assert.ok(pComposeText.includes('# On SIGTERM the service takes no new job and waits up to 300 s for the one that is running; the 30 s more than that are for it to log a job it'));
  assert.match(pComposeText, /A grace period of 300 s or less kills a job under escrow mid-run, or the service before it can say what it left\./);
  assert.match(pComposeText, /renders every page at 150 dpi whatever its size/);
});

test('Pipeline env example: the blocks in order (supplier, buyer, token, chain, identity deployment, advert, manifest, hires), known names only, each once; every secret is empty and nothing looks like key material but the public key hash of the OCR supplier and the published values of the identity registry', () => {
  assert.deepEqual(Object.keys(pExample), [...P_SUPPLIER, ...P_BUYER, ...P_TOKEN, ...P_CHAIN, ...P_IDENTITY, ...P_ADVERT, ...P_MANIFEST, ...P_HIRES]);
  const { OCR_ALLOWLIST_SUPPLIER_PKH, ...rest } = pExample;
  assert.deepEqual(keyProblems(withoutPublished(rest)), []);
  assert.deepEqual(keyProblems(pAgent.environment), [], 'the compose environment of the runtime');
  assert.deepEqual(keyProblems(pService.environment), [], 'the compose environment of the service');
  for (const name of [...P_SUPPLIER, ...P_BUYER, ...P_TOKEN, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(pExample[name], '', `${name} is filled by the runbook`);
  for (const name of [...P_IDENTITY, 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY]) assert.equal(pExample[name], IDENTITY_MAINNET[name], `${name} is the value that the identity registry deployment published`);
  assert.equal(pExample.IDENTITY_ADDRESS, '', 'IDENTITY_ADDRESS stays empty: the address of IDENTITY_POLICY_ID');
  // The one key-shaped value is the key hash of the OCR supplier the Pipeline hires, which is public and not ours.
  assert.match(OCR_ALLOWLIST_SUPPLIER_PKH, /^[0-9a-f]{56}$/);
  assert.match(pExampleText, /^# The OCR supplier is one first-party key hash, which is public and not ours\./m);
  // The contact is the one value the operator types: a placeholder in angle brackets that asks for a role address.
  assert.match(pExample.OPERATOR_CONTACT, PLACEHOLDER);
  assert.equal(pExample.OPERATOR_CONTACT, example.OPERATOR_CONTACT, 'the same placeholder as Agent History');
  assert.match(pExampleText, /^# OPERATOR_CONTACT is required: the service stops at start without it/m);
});

test('Pipeline env example: the header says the copy holds two keys and the token and never enters git, and the .gitignore of the repository covers it', () => {
  const [first, second] = pExampleText.split('\n');
  assert.equal(first, '# Copy to .env.document-pipeline next to the compose file (mode 600). Names and placeholders only: this example holds no key, no secret and no usable token (SERVICE_AUTH_HEADER is empty here).');
  assert.equal(second, "# The copy holds two keys, the supplier key (the runtime's) and the buyer key (the service's), and the token between the two containers, and it never enters git: the repository's .gitignore covers .env.* except *.example.");
  const ignore = read('.gitignore').split('\n');
  assert.ok(ignore.includes('.env.*') && ignore.includes('!.env.*.example'), 'the rule the header quotes');
  // A file named .env.document-pipeline matches .env.*, and the example matches the exception.
  assert.ok(/^\.env\..*$/.test('.env.document-pipeline') && /^\.env\..*\.example$/.test('.env.document-pipeline.example'));
});

// The runbook's shell is run here, in bash, against stand-ins for docker and openssl. A machine without bash and GNU sed skips these tests; CI has both.
const HAVE_BASH = (() => { try { return execFileSync('bash', ['-c', 'sed --version | grep -q "GNU sed" && echo yes'], { encoding: 'utf8' }).trim() === 'yes'; } catch { return false; } })();
const NEEDS_BASH = { skip: HAVE_BASH ? false : 'needs bash and GNU sed' };
const runBash = (script, cwd) => { const r = spawnSync('bash', ['-s'], { input: script, cwd, encoding: 'utf8' }); return { status: r.status, stdout: r.stdout, stderr: r.stderr }; };

test('Pipeline env example: the token line (R50) is empty and in quotes, sits between the buyer block and the chain block, and its comments say who sends it, who requires it, why it is quoted and why it is empty', () => {
  const lines = pExampleText.split('\n');
  const at = lines.indexOf('SERVICE_AUTH_HEADER=""');
  assert.ok(at > 0, 'the line is there, empty, in quotes');
  assert.equal(lines.filter((l) => l.startsWith('SERVICE_AUTH_HEADER=')).length, 1);
  assert.equal(pExampleRaw.SERVICE_AUTH_HEADER, '""');
  assert.equal(pExample.SERVICE_AUTH_HEADER, '', 'taken off its quotes it is empty: the service stops at start with an empty token, so a step that was forgotten leaves no open service');
  assert.equal(lines[at - 5], 'PIPELINE_BUYER_ADDRESS=', 'after the buyer block');
  assert.equal(lines[at + 1], '# Chain', 'before the chain block');
  assert.deepEqual(lines.slice(at - 4, at), [
    '# The token between the two containers (ruling R50). The runtime sends this value, as it stands, as the authorization header of every call to the service, and the service answers POST / only to a call that carries it.',
    '# Both containers read it from this file and neither blanks it. Step 4 makes it with openssl rand -hex 32, in the form SERVICE_AUTH_HEADER="Bearer <64 hex>" (71 characters).',
    '# The quotes are needed: the ops scripts read this file with the shell\'s ".", and an unquoted value with a space in it would run the hex as a command and stop with exit 127. Docker Compose takes the quotes off.',
    '# Empty here on purpose: the service stops at start without it (environment variable SERVICE_AUTH_HEADER is required), so a step that was forgotten cannot leave a service that answers anyone.',
  ]);
  assert.equal('Bearer '.length + 64, 71, 'the length the runbook checks');
  // The example holds no token-shaped value anywhere: the one line is empty, and the form is only in a comment.
  assert.doesNotMatch(pExampleText, /^SERVICE_AUTH_HEADER="?Bearer/m);
  assert.doesNotMatch(pExampleText, /Bearer [0-9a-f]{16}/);
});

test('Pipeline env example: the quotes are what lets the ops scripts read the file with ".": a quoted token reads as one value, an unquoted one runs the hex as a command and stops with exit 127', NEEDS_BASH, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dp-token-'));
  try {
    const hex = 'ab'.repeat(32);
    writeFileSync(join(dir, 'quoted.env'), `FIRST=1\nSERVICE_AUTH_HEADER="Bearer ${hex}"\nLAST=2\n`);
    writeFileSync(join(dir, 'unquoted.env'), `FIRST=1\nSERVICE_AUTH_HEADER=Bearer ${hex}\nLAST=2\n`);
    // The ops scripts run with set -e, so a line of the file that fails ends them.
    const quoted = runBash('set -e\n. ./quoted.env\necho "length ${#SERVICE_AUTH_HEADER} last $LAST"\n', dir);
    assert.deepEqual([quoted.status, quoted.stdout.trim()], [0, 'length 71 last 2']);
    const unquoted = runBash('set -e\n. ./unquoted.env\necho reached\n', dir);
    assert.equal(unquoted.status, 127, 'the shell took "Bearer" for an assignment before a command that the hex names');
    assert.equal(unquoted.stdout, '', 'and went no further');
    assert.match(unquoted.stderr, /command not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Pipeline env example: a token of the form the runbook makes (Bearer and 64 hex digits, 71 characters) is accepted by the service at start, and an empty one is refused with the variable named', () => {
  const base = { OPERATOR_CONTACT: TEST_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX: '01'.repeat(32), SUPPLIER_PKH: 'a'.repeat(56) };
  const token = `Bearer ${'ab'.repeat(32)}`;
  const code = "import { loadConfig } from './src/start.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => { try { return { length: loadConfig(env).authHeader.length }; } catch (e) { return { error: e.message }; } })));";
  const [accepted, empty, absent] = inPipeline(code, [{ ...base, SERVICE_AUTH_HEADER: token }, { ...base, SERVICE_AUTH_HEADER: '' }, base]);
  assert.deepEqual(accepted, { length: 71 });
  for (const refused of [empty, absent]) assert.match(refused.error, /^environment variable SERVICE_AUTH_HEADER is required \(.+\) and is not set$/);
  assert.ok(!JSON.stringify([accepted, empty, absent]).includes(token), 'no answer shows the token');
});

test('Pipeline env example: every name the service code reads is in the example, in the compose environment, or has a default in the code', () => {
  const files = [...sourceFiles('agents/document-pipeline/src'), ...sourceFiles('packages/hire-kit/src'), ...sourceFiles('packages/service-kit/src'), ...sourceFiles('packages/buyer-core/src'), ...sourceFiles('packages/vector-read/src')];
  assert.ok(files.length >= 40, `the scan reaches every source file, found ${files.length}`);
  for (const f of ['agents/document-pipeline/src/start.ts', 'agents/document-pipeline/src/server.ts', 'packages/buyer-core/src/vendored/mcp-shared/config.ts', 'packages/vector-read/src/constants.ts']) assert.ok(files.includes(f), `the scan includes ${f}`);
  const names = new Set(files.flatMap((f) => [...envNamesIn(read(f))]));
  assert.ok(names.size >= 20, 'the scan found the settings');
  // Left unset on purpose: a value here would pin a default that the code owns (the chain endpoints of buyer-core are Vector mainnet's, the price
  // ceilings of ruling R56 are 1000000 lovelace each in agents/document-pipeline/src/start.ts). The two limits of the bonds of the chat advert have no default: there is no limit while they are not set.
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_KOIOS_URL', 'VECTOR_EXPLORER_URL', 'VECTOR_BLOCKFROST_URL', 'KOIOS_URL', 'INDEXER_URL', 'OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE'];
  assert.deepEqual([...names].filter((n) => !(n in pExample) && !(n in pService.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in pExample), `${n} stays unset in the example`);
  // The two ceilings are in the example all the same, commented, with the default of the code.
  assert.ok(START.includes('export const PRICE_CEILING_DEFAULT_LOVELACE = 1_000_000n;'));
  for (const name of ['OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE']) {
    assert.ok(names.has(name), `the service reads ${name}`);
    assert.match(pExampleText, new RegExp(`^# ${name}=1000000$`, 'm'), `${name} is in the example, commented, at its default`);
  }
  // The two limits of the bonds of the chat advert have no default: the example has them commented, at the value that the runbook recommends, and no compose file gives them a value (the operator sets them in the env file).
  for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
    assert.ok(names.has(name), `the service reads ${name}`);
    assert.ok(pExampleText.split('\n').includes(`# ${name}=2000000`), `${name} is in the example, commented, at the recommended value`);
    assert.ok(!(name in pService.environment) && !(name in pAgent.environment), `${name} has no value in the compose file`);
  }
  for (const n of ['OPERATOR_CONTACT', 'PIPELINE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SERVICE_AUTH_HEADER', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST', 'PIPELINE_STATE_DIR']) assert.ok(names.has(n), `the service reads ${n}`);
  assert.ok(!names.has('SUPPLIER_PRIV_KEY_HEX'), "no source of the service reads the supplier key: it is the runtime's");
});

test('Pipeline RUNBOOK step 4: one paragraph on the limits of the bonds of the chat advert names the two settings, the value of the example, the failure they give and that the OCR hop has none', () => {
  const four = section(pRunbook, '4. Make the env file and generate the two keys');
  const paragraphs = four.split('\n\n').filter((p) => p.includes('LLM_MAX_SUPPLIER_BOND_LOVELACE') || p.includes('LLM_MAX_BUYER_BOND_LOVELACE'));
  assert.equal(paragraphs.length, 1, 'one paragraph');
  for (const part of ['`LLM_MAX_SUPPLIER_BOND_LOVELACE`', '`LLM_MAX_BUYER_BOND_LOVELACE`', '`LLM_MAX_PRICE_LOVELACE`', '`2000000`', 'recreate the service', '`llm_supplier_unavailable` (503)', 'The OCR hop has no such limit']) assert.ok(paragraphs[0].includes(part), part);
  for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) assert.ok(pExampleText.split('\n').includes(`# ${name}=2000000`), `${name} has the value of the paragraph in the example`);
});

test('Pipeline env example: the runtime gets every name the pinned template lists for CAPABILITY_KIND=custom', () => {
  // The same list as for Agent History: from .env.example of vector-agent-template at a05564c.
  // SERVICE_AUTH_HEADER is optional in the template ("" sends no header); this pack sets it, so that the runtime sends the token the service requires (R50).
  // SERVICE_PRECHECK_URL and RELEASE_WATCHER stay unset on purpose, and PUBLIC_ORIGIN gives the runtime its agent card (the tests of the four runtimes).
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY, 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT', 'PUBLIC_ORIGIN'];
  assert.deepEqual(NEEDED.filter((n) => !(n in pExample) && !(n in pAgent.environment)), []);
  assert.equal(pExample.NETWORK_ID, '1');
  assert.equal(pExample.LIVE_CHAIN, '1');
  assert.ok(pExample.OGMIOS_URL.startsWith('https://'), 'https, not wss');
});

test('Pipeline env example: the chain values are those of Agent History, the advert terms are the spec, the endpoint is the second hostname, the allowlists are the defaults of the code', () => {
  for (const name of P_CHAIN) assert.equal(pExample[name], example[name], `${name} is the value of the Agent History example, which the design pins`);
  assert.equal(pExample.ADVERT_CAPABILITY_ID, 'document.pipeline.ocr-summary.v1');
  assert.ok(PSPEC.includes(`\`${pExample.ADVERT_CAPABILITY_ID}\``));
  assert.ok(PSPEC.includes(`The model string in the advert and in every receipt is \`${pExample.ADVERT_MODEL}\`.`));
  assert.equal(pExample.ADVERT_MODEL, 'document-pipeline-v1');
  assert.deepEqual([pExample.ADVERT_PRICE_LOVELACE, pExample.ADVERT_SUPPLIER_BOND_LOVELACE, pExample.ADVERT_BUYER_BOND_LOVELACE, pExample.ADVERT_MAX_PROCESSING_MS].map(Number), [P_TERMS.price, P_TERMS.supplierBond, P_TERMS.buyerBond, P_TERMS.window]);
  assert.deepEqual([P_TERMS.price, P_TERMS.supplierBond, P_TERMS.buyerBond], [5_000_000, 1_000_000, 1_000_000]);
  assert.equal(pExample.ADVERT_MAX_PROCESSING_MS, pAgent.environment.ADVERT_MAX_PROCESSING_MS);
  assert.equal(pExample.ADVERT_ENDPOINT_URL, 'https://mp-suppliers-pipeline.hal8.ai');
  assert.equal(pExample.ADVERT_DETAIL_URI, `${pExample.ADVERT_ENDPOINT_URL}/agent.json`);
  assert.equal(new URL(pExample.ADVERT_ENDPOINT_URL).hostname, 'mp-suppliers-pipeline.hal8.ai');
  assert.ok(PSPEC.includes(`\`${pExample.ADVERT_ENDPOINT_URL}\``), 'the spec names the same public URL');
  assert.ok(DESIGN.includes('`mp-suppliers-pipeline.hal8.ai`'));
  assert.equal(pExample.OCR_ALLOWLIST_SUPPLIER_PKH, '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9');
  assert.equal(pExample.OCR_ALLOWLIST_SUPPLIER_PKH, OCR_DEFAULT);
  assert.equal(pExample.LLM_MODEL_ALLOWLIST, 'deepseek/deepseek-v4-flash,deepseek-v4-pro,moonshotai/kimi-k2.6,Qwen/Qwen3.6-35B-A3B-FP8');
  assert.equal(pExample.LLM_MODEL_ALLOWLIST, LLM_DEFAULT.join(','));
  assert.ok(PREADME.includes(`| \`OCR_ALLOWLIST_SUPPLIER_PKH\` | the key hash of the one OCR supplier the Pipeline hires | \`${OCR_DEFAULT}\` |`), 'the README of the agent gives the same default');
});

test('Pipeline env example: the status word is deployed since 2026-10-16, and the manifest it produces is the default manifest of the service with the published identity registry', () => {
  assert.equal(pExample.AGENT_STATUS_CHIP, 'deployed', 'the advert is Active and one first-party job has settled (step 17), which shows that the path works and is not demand, so nothing may claim live');
  assert.equal(pExample.AGENT_STATUS_SINCE, '2026-10-16');
  assert.notEqual(pExample.AGENT_STATUS_SINCE, '', 'an empty AGENT_STATUS_SINCE is refused by the service');
  // The comment says what the word is, who changes it, and what a first run starts with.
  assert.match(pExampleText, /^# The status word the manifest carries, and since when: deployed since 2026-10-16, after the advert was Active and a first-party job had settled \(RUNBOOK-document-pipeline\.md step 17, "Flip the status"\)\. A first-party run is not demand, so the word is not live\.$/m);
  assert.match(pExampleText, /^# On a first run, before any job has settled, set proposed and today's date here; step 17 changes them\.$/m);
  const [withExample, withNothing] = renderManifests([{ ...withoutPlaceholders(pExample), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }], 'agents/document-pipeline');
  assert.equal(withExample.identity.registry_address, IDENTITY_MAINNET_ADDRESS, 'the published policy gives the published address');
  assert.deepEqual({ ...withExample, identity: withNothing.identity }, withNothing, 'the example changes nothing else in the manifest the advert will hash');
  assert.equal(withExample.operator.contact, TEST_CONTACT);
  assert.deepEqual(withExample.status, { chip: 'deployed', since: '2026-10-16' });
  assert.equal(withExample.links.explorer_advert, '');
  assert.equal(withExample.terms.price_lovelace, P_TERMS.price);
  assert.equal(withExample.terms.max_processing_ms, P_TERMS.window);
  assert.equal(withExample.capability_id, pExample.ADVERT_CAPABILITY_ID);
  assert.match(pExampleText, /^# Stays empty: the advert's own transaction id cannot be inside the manifest the advert hashes\.$/m);
});

test('Pipeline env example: the note on the manifest block names the two advert terms among the values that must be final before the hash, and they are in the manifest', () => {
  assert.ok(pExampleText.includes(
    '# Manifest (service). What the service serves at /agent.json is hashed into the advert, so every line in this block, ADVERT_PRICE_LOVELACE and ADVERT_MAX_PROCESSING_MS above (the manifest publishes both as its terms),\n'
    + '# and the identity lines above (the supplier key hash and public key, the buyer key hash), must be final before the hash is taken. A change afterwards means a retired advert and a new one.\n',
  ));
  // True to the code: each of the two values changes the bytes that are hashed.
  const [base, priced, windowed] = renderManifests([{ OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT, ADVERT_PRICE_LOVELACE: '7000000' }, { OPERATOR_CONTACT: TEST_CONTACT, ADVERT_MAX_PROCESSING_MS: '1900000' }], 'agents/document-pipeline');
  assert.equal(priced.terms.price_lovelace, 7_000_000);
  assert.equal(windowed.terms.max_processing_ms, 1_900_000);
  assert.notEqual(JSON.stringify(priced), JSON.stringify(base));
  assert.notEqual(JSON.stringify(windowed), JSON.stringify(base));
  // The note comes before the values it speaks of are read as part of the advert: the terms are in the advert block, above it.
  assert.ok(pExampleText.indexOf('ADVERT_PRICE_LOVELACE=') < pExampleText.indexOf('# Manifest (service).') && pExampleText.indexOf('ADVERT_MAX_PROCESSING_MS=') < pExampleText.indexOf('# Manifest (service).'));
});

test('Pipeline Caddy snippet: the site block is the second endpoint host, the manifest goes to the service, everything else to the runtime, and it is last in the file; the README shows the same block', () => {
  const lines = pSnippet.split('\n');
  const first = lines.findIndex((l) => !l.startsWith('#') && l.trim() !== '');
  const block = lines.slice(first).join('\n').trimEnd();
  assert.match(block, /^mp-suppliers-pipeline\.hal8\.ai \{\n    handle \/agent\.json \{\n        reverse_proxy (\S+)\n    \}\n    handle \{\n        reverse_proxy (\S+)\n    \}\n\}$/);
  const [, toService, toAgent] = block.match(/reverse_proxy (\S+)[\s\S]*reverse_proxy (\S+)/);
  assert.equal(toService, `${pService.container_name}:${pService.environment.PORT}`);
  assert.equal(toAgent, `${pAgent.container_name}:${pAgent.environment.PORT}`);
  assert.equal(block.split('\n')[0], `${new URL(pExample.ADVERT_ENDPOINT_URL).hostname} {`);
  assert.ok(lines.slice(0, first).every((l) => l.startsWith('#') || l.trim() === ''), 'only comments before the block');
  const comments = lines.slice(0, first).join('\n');
  assert.ok(comments.includes('The hostname must be DNS only (grey cloud),'), 'the DNS-only rule');
  assert.ok(comments.includes("The block must stay the last thing in this file: the host administrator's install script\n# takes everything from the hostname line to the end."));
  assert.ok(comments.includes("The runtime does not serve /agent.json, and the advert's detail_uri points at it, so that one path goes to the service."));
  assert.ok(block.indexOf('handle /agent.json') < block.indexOf('    handle {'), 'the /agent.json route goes first so that the default one does not catch it');
  assert.ok(pSection.split('\n').map((l) => l.replace(/^ {3}/, '')).join('\n').includes('```\n' + block + '\n```'), 'the README shows the same block');
  // It is not the block of Agent History.
  assert.doesNotMatch(block, /history/);
});

test('Pipeline files: each says DEPLOYED since 2026-10-16 in its own first lines, the compose file and the snippet say that the stack is installed and running, the runbook and the README section say which steps were run, and none says LIVE or that nothing is installed', () => {
  assert.ok(pComposeText.split('\n')[1].startsWith(`# ${P_STATUS}: installed and running on the box since 2026-10-16; one first-party job settled on 2026-10-16. The order of work is RUNBOOK-document-pipeline.md. The host administrator's part is README.md.`));
  assert.ok(pSnippet.split('\n')[1].startsWith(`# ${P_STATUS}: installed and running on the box. It was installed on 2026-10-16, at step 10 of RUNBOOK-document-pipeline.md, by a copy of the host administrator's install script (install-caddy-route.sh, from the ops folder of Agent History), which merges it and reloads Caddy (README.md).`));
  assert.equal(pExampleText.split('\n')[2], `# Status: ${P_STATUS}. The status word the manifest carries is AGENT_STATUS_CHIP below.`);
  assert.equal(pRunbook.split('\n')[2], `Status: ${P_STATUS}. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 15 and 17 were run on 2026-10-16, and the first stop was watched the same day (the service was idle, the stop took 1 s, the exit code was 0). Step 16, the wallet monitor, is not used for this agent, as for Agent History.`);
  assert.ok(pSection.split('\n')[1].startsWith(`Status: ${P_STATUS}. Nothing in this section is LIVE. Steps 1 to 15 and 17 of its runbook were run on 2026-10-16. Step 16, the wallet monitor, is not used for this agent, as for Agent History. The files are `));
  // DEPLOYED is said in those lines and nowhere else (the test of the status lines of the folder holds that); LIVE is only ever denied, and the words of before the flip are gone.
  for (const rel of PIPELINE_FILES) {
    const text = read(rel);
    assert.doesNotMatch(text.replace('Nothing in this folder is LIVE.', ''), /\bLIVE\b/, `${rel}: the Pipeline is never live`);
    assert.doesNotMatch(text, /Nothing of it is installed|Not installed:|No step of it has been run|built, not deployed|what will happen/, `${rel}: the words of before the flip`);
  }
  assert.doesNotMatch(pSection.replace('Nothing in this section is LIVE.', ''), /\bLIVE\b/);
  assert.doesNotMatch(pSection, /Nothing in this section is installed|built, not deployed/);
});

test('Pipeline README section: the second stack beside Agent History, with its two containers, the loopback port, the unpublished service port, the volume, the limits, the second hostname, the Caddy block and the way back', () => {
  assert.ok(pSection.length > 2500, 'the section exists');
  assert.ok(readme.indexOf('\n## Document Pipeline on the same box\n') > readme.indexOf('\n## Rollback\n'), 'after the Agent History sections, so that nothing of them moves');
  assert.ok(pSection.includes('[RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), which is the operator\'s order of work and follows [RUNBOOK.md](RUNBOOK.md) step for step'));
  const rows = pSection.split('\n').filter((l) => l.startsWith('| `'));
  assert.equal(rows.length, 2, 'the second table has the two containers');
  assert.ok(rows[0].startsWith(`| \`${pAgent.container_name}\` | built on the box from \`https://github.com/Apex-Fusion/vector-agent-template.git\` at the same pinned commit \`a05564c\` (\`CAPABILITY_KIND=custom\`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on \`127.0.0.1:8084\` only |`));
  assert.ok(rows[1].startsWith(`| \`${pService.container_name}\` | \`ghcr.io/apex-fusion/vector-service-agents/document-pipeline\`, built on the box and pinned by digest (\`@sha256:<digest>\`, a placeholder in the repository), or by image ID | 9092 | The runtime and Caddy, over the external network of the host's reverse proxy. Nothing on the host: 9092 is never published |`));
  for (const part of [
    'The working directory on the box is `<base path>/repo/deploy/host`',
    'the base path is the folder the operator chose for this agent (`BASE` in its runbook)',
    "Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for Agent History).",
    'The compose project is `document-pipeline`.',
    'inside a checkout of this repository that is shipped to the box as a git bundle, because the box has no GitHub credentials',
    'The runtime holds the supplier key. The service holds a second, separate key, the buyer key',
    '- **A token on the service.** The service answers `POST /` only to a call whose `authorization` header is the token in `SERVICE_AUTH_HEADER`, which the runtime sends with every call (ruling R50).',
    'Both containers read it from the env file, and the operator makes it in step 4 of the runbook.',
    'A `POST /` without that header, or with another value, gets 401 before its body is read. `GET /healthz` and `GET /agent.json` need no header, and any other path gets 404.',
    'Port 9092 is never published to the host all the same.',
    "reachable over the external network of the host's reverse proxy by every container on that network, so the host administrator keeps that network to stacks that are trusted",
    'the token is the second lock, and anything that holds it can start a job that posts escrows from the buyer wallet',
    'and while `PIPELINE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH` or `SERVICE_AUTH_HEADER` is not set',
    'After any change, recreate: once the runtime runs (step 13 of the runbook), only when `curl -s http://127.0.0.1:8084/status` says `free` (a stop during a job can cut a job under escrow), and before step 13 at once, since no job can run: ',
    'kills a job under escrow, so, once the runtime runs (step 13 of the runbook), restarts wait for `/status` on `127.0.0.1:8084` to say `free`. Before step 13 no job can run, and there is nothing to wait for.',
    'A change to `SERVICE_AUTH_HEADER` needs both containers recreated.',
    '`document-pipeline-state`, mounted at `/data`',
    '`docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it',
    '`mem_limit: 1536m`', '`stop_grace_period: 330s`',
    'because on a stop it waits up to 300 s for the job that is running, and Docker must leave it 30 s more to log a job it had to abandon and to exit with its own code',
    '`mp-suppliers-pipeline.hal8.ai`', 'DNS only (grey cloud)',
    'There is no registry login and no image to pull',
    'validate and reload', 'caddy validate --config /etc/caddy/Caddyfile', 'caddy reload --config /etc/caddy/Caddyfile',
    '`127.0.0.1:8084`', 'loopback', 'ss -ltnp', 'a clash on 8084',
    '`docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate <service>`', 'does not re-read it',
    'The service refuses to start while `OPERATOR_CONTACT` is empty or missing',
    '[RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), under "Back out"',
  ]) assert.ok(pSection.includes(part), `the section says: ${part}`);
  assert.ok(!pSection.includes('retire-advert.ts'), 'the retire command lives in one place, the runbook');
  assert.doesNotMatch(pSection, /no authentication|was shipped/i, 'the sentences of before R50 and before the Pipeline was said to be proposed: nothing has been shipped yet');
  // The part of the note that is about Agent History points at the second stack, so that a reader who opens it for the Pipeline finds the section.
  assert.ok(readme.includes('The Document Pipeline is a second stack on the same box. It has its own section after the Agent History part of this note and its own runbook, [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md).'));
  assert.ok(readme.indexOf('The Document Pipeline is a second stack on the same box.') < readme.indexOf('\n## What will land on the box\n'), 'said at the top, before the Agent History tables');
  // The Pipeline's section follows the Agent History part of the note, the section of Audio Snippets follows it, and the section of Advocate is the last, so "at the end of this note" is true of Advocate only.
  assert.ok(readme.includes('`mp-suppliers-pipeline.hal8.ai`, and its own section after the Agent History part of this note. The advert will carry the first name'), 'point 1 of the list of the host administrator');
  for (const sentence of readme.split(/(?<=\.)\s+/).filter((s) => s.includes('at the end of this note'))) assert.match(sentence, /Advocate|mp-suppliers-advocate/, `said of a section that is not the last: ${sentence.slice(0, 100)}`);
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]).slice(-3), ['Document Pipeline on the same box', 'Audio Snippets on the same host', 'Advocate on the same host'], 'the Pipeline section, then Audio Snippets, then the last one');
  // The Agent History part of the README is told the second name is no longer "later", and it still names the three others.
  assert.ok(!readme.includes('Three more come later'), 'the sentence of before the Pipeline');
  for (const host of ['mp-suppliers-snippets.hal8.ai', 'mp-suppliers-advocate.hal8.ai']) assert.ok(readme.slice(0, readme.indexOf('\n## Document Pipeline on the same box\n')).includes(`\`${host}\``), host);
  // The figures it quotes are those of the compose file and the code.
  assert.ok(pSection.includes(`\`mem_limit: ${pService.mem_limit}\``) && pSection.includes(`\`stop_grace_period: ${pService.stop_grace_period}\``));
  assert.equal(pSection.match(UNIT_NAME), null);
  assert.equal(pSection.match(DASHES), null);
  assert.doesNotMatch(pSection, /no job (has )?settled|no first-party run of the path is recorded/i);
});

test('Pipeline RUNBOOK: the twenty-two sections in order, the seventeen steps keep the numbers of the Agent History runbook, three titles differ, and "Watch the first stop" sits between steps 15 and 16', () => {
  const numbered = P_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...pRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Take a new runtime commit', 'Back out', 'If something goes wrong']);
  assert.deepEqual([...pRunbook.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), P_STEPS.map((title, i) => [i + 1, title]));
  const history = [...runbook.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[2]);
  assert.equal(history.length, P_STEPS.length, 'the same number of steps as the runbook it follows');
  const RENAMED = [1, 3, 5]; // no registry login (2); two keys (4); two wallets (6)
  P_STEPS.forEach((title, i) => { if (RENAMED.includes(i)) assert.notEqual(title, history[i], `step ${i + 1} is renamed`); else assert.equal(title, history[i], `step ${i + 1} keeps its title`); });
  for (const m of pRunbook.matchAll(/\bsteps? (\d+)/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= P_STEPS.length, `step ${m[1]}`);
  const quoted = [...pExampleText.matchAll(/RUNBOOK-document-pipeline\.md step (\d+), "([^"]+)"/g)];
  assert.equal(quoted.length, 3, 'the example names steps 4, 7 and 17');
  for (const m of quoted) assert.equal(P_STEPS[Number(m[1]) - 1], m[2], `the example quotes step ${m[1]}`);
  assert.match(pRunbook, /The operator holds the keys and does every step except two\. Step 6 \(the collateral and float of the two wallets\) is the Foundation's\. Step 10 \(DNS and Caddy\) is the host administrator's, see \[README\.md\]\(README\.md\)\. Step 2 is the operator's here, because nothing is pulled from a registry\./);
  assert.match(section(pRunbook, '2. Build the service image and pin it'), /^\nOperator\. /);
  assert.match(section(pRunbook, '6. Supply the two wallets with their collateral and float'), /^\nThe Foundation\. /);
  assert.match(section(pRunbook, '10. DNS and Caddy'), /^\nHost administrator, from/);
  // It follows the runbook of Agent History and says so, and it points at its gotchas instead of copying them.
  assert.ok(pRunbook.includes('This is [RUNBOOK.md](RUNBOOK.md), the runbook of Agent History, written for the Document Pipeline.'));
  assert.ok(pRunbook.includes('step N here is step N there'));
  assert.ok(pRunbook.includes('`$HISTORY_BASE/DEPLOY-NOTES.md`'));
  assert.ok(section(pRunbook, '7. Register the identity').includes('Read the first gotcha at the end of RUNBOOK.md'));
  assert.ok(section(pRunbook, '8. Stake in Module-3').includes('Read the second gotcha at the end of RUNBOOK.md'));
  assert.ok(runbook.includes('**1. Never re-serialize an MCP-built transaction.**') && runbook.includes('**2. The Module-3 SDK is testnet-pinned.**'), 'the gotchas it points at exist');
  assert.doesNotMatch(pRunbook, /Never re-serialize an MCP-built transaction/, 'not copied');
});

test('Pipeline RUNBOOK: the differences from Agent History are listed in one place, with the names table', () => {
  const head = pRunbook.slice(0, pRunbook.indexOf('\n## Collateral and float\n'));
  for (const part of [
    '- **Two keys.** The runtime holds the supplier key. The service holds a second, separate key, the buyer key,',
    '- **The service locks value.** Every job posts escrows from the buyer wallet. The service answers `POST /` only to a call that carries the token the runtime sends (`SERVICE_AUTH_HEADER`, made in step 4, ruling R50) and gives a `POST /` without it 401, because the network is shared with other stacks; any other path but `/healthz` and `/agent.json` gets 404. Its port 9092 is never published all the same, and a job is refused up front, locking nothing, when the buyer wallet cannot cover it.',
    '- **A window of 30 min where Agent History has 5.**', '`max_processing_ms` is 1800000', '`SERVICE_TIMEOUT_MS` is 1680000', 'up to 27 min', 'an interim `102 Processing` line to the runtime every 60 s',
    '- **State and a clean stop.**', '`stranded.json`', '`document-pipeline-state`', '`stop_grace_period: 330s`', 'a memory limit of 1536m',
    'A stop gives the service up to 300 s to finish the job that is running, and Docker 30 s more for it to log a job it abandoned and exit (`stop_grace_period: 330s`)',
    '- **No registry.**', 'the box has no GitHub credentials',
    '- **Price 5.**', 'The Foundation carries the gap between what the sub-jobs cost and that price on purpose',
    '| Base path on the box | `$BASE`, the folder the operator chose for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |',
    '| Base path of Agent History | `$HISTORY_BASE`, the `BASE` of RUNBOOK.md: its ops scripts, its install script and the notes of its deployment |',
    '| "This folder" | `$BASE/repo/deploy/host` |',
    "| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |",
    '```sh\nBASE=/opt/document-pipeline\nHISTORY_BASE=/opt/agent-history\n```',
    '| Compose file, env file | `docker-compose.document-pipeline.yml`, `.env.document-pipeline` |',
    '| Containers | `document-pipeline-agent` (the runtime), `document-pipeline-service` |',
    '| Ports | the runtime on `127.0.0.1:8084`, loopback only; the service on 9092, never published |',
    '| Public name | `mp-suppliers-pipeline.hal8.ai` |',
    '| State volume | `document-pipeline-state`, mounted at `/data` |',
    'adverts are immutable, so everything the manifest contains',
  ]) assert.ok(head.includes(part), `the head says: ${part}`);
  assert.doesNotMatch(head, /no authentication/i, 'the sentence of before R50');
  // The facts it quotes are the code's.
  const server = read('packages/service-kit/src/server.ts'); // the heartbeat is the shared server's since packages/service-kit
  assert.ok(server.includes('export const HEARTBEAT_MS = 60_000;'));
  assert.ok(read('agents/document-pipeline/src/budget.ts').includes('export const JOB_DEADLINE_MS = 1_620_000;'), '27 min');
  assert.ok(PREADME.includes('the runtime\'s fetch gives up after 300 s of silence'));
});

test('Pipeline RUNBOOK collateral and float: two keys, 5 alone then 50 for the supplier and 5 alone then 100 for the buyer, what the buyer float covers, and the third key of step 15', () => {
  const funds = section(pRunbook, 'Collateral and float');
  const rows = funds.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Key |'));
  assert.equal(rows.length, 2, 'two keys');
  const [supplier, buyer] = rows;
  assert.ok(supplier.startsWith("| Supplier key (the runtime's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral), then 50 units | As for Agent History:"));
  // The 5 alone is held back from every Post while the rest of the wallet covers that Post and its change, in the words of the Advocate runbook: the Pipeline posts through the same
  // code (packages/hire-kit on packages/buyer-core, the vendored marketplace-build.ts and fleet-build.ts), which draws on the whole wallet otherwise, so the 5 is not "never touched".
  assert.ok(buyer.startsWith("| Buyer key (the service's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral for the Accept and the Reclaim of the sub-jobs, held back from every Post while the rest of the wallet covers that Post and its change), then 100 units |"));
  assert.ok(section(read('deploy/host/RUNBOOK-advocate.md'), 'Collateral and float').includes('(collateral for the Accept and the Reclaim of the chat sub-job, held back from every Post while the rest of the wallet covers that Post and its change)'), 'the words of the Advocate runbook');
  assert.ok(read('packages/buyer-core/src/vendored/mcp/marketplace-build.ts').includes('return total >= lockLovelace + MARKETPLACE_MIN_FEE + MIN_UTXO_LOVELACE ? rest : undefined;'));
  assert.ok(JSON.parse(read('agents/document-pipeline/package.json')).dependencies['@vsa/hire-kit'] !== undefined, 'the Pipeline hires through packages/hire-kit');
  assert.equal(buyer.includes('never touched'), false, 'the words of before');
  assert.ok(funds.includes('The Foundation supplies two keys with their collateral and float. Nobody pastes either key into a chat.'));
  assert.ok(funds.includes('Two transfers, because a wallet supplied in one transfer can have its collateral spent as change by an ordinary transaction.'));
  assert.ok(buyer.includes('the OCR hops at about 2.2 net per page (price 0.2, supplier bond 1, fees about 1) plus the chat hop at about the same, so about 13 net for a job of five pages, against its price of 5.'));
  assert.ok(buyer.includes('The locks and fees in flight for such a job come to about 19, of which the buyer bonds and the lock excess return on Accept'));
  // Ruling R56: the figures are the ones of today's fleet price, and the ceilings bound what an advert may cost.
  assert.ok(buyer.includes("These figures hold at today's fleet price of 0.2 per sub-job; the service hires no advert priced above `OCR_MAX_PRICE_LOVELACE` or `LLM_MAX_PRICE_LOVELACE`"));
  assert.ok(PSPEC.includes("cost it about 13 net at today's fleet price of 0.2 per sub-job"));
  assert.doesNotMatch(buyer, /2\.3 net/, 'the figure of before it was given with its parts');
  assert.ok(buyer.includes('(max_pages + 1) x 4.5') && buyer.includes('27 for five pages') && buyer.includes('`insufficient_float` (503)'));
  // The figures are the spec's and the code's.
  assert.ok(PSPEC.includes("at five pages the Pipeline's six sub-jobs cost it about 13 net") && PSPEC.includes('the locks and fees in flight come to about 19'));
  assert.ok(read('agents/document-pipeline/src/budget.ts').includes('export const FLOAT_PER_SUB_JOB_LOVELACE = 4_500_000n;'));
  assert.ok(PREADME.includes('a float outside it of `(max_pages + 1) x 4500000` lovelace'));
  assert.ok(read('docs/HIRE.md').includes('| 5 (Document Pipeline) | 7 | 6 | 1 | about 1 | about 7 | 7 |'), 'what a job costs the hirer');
  // The supplier row is the Agent History row, and the third key is told apart.
  assert.ok(supplier.includes('the registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees.'));
  assert.ok(funds.includes('The key of the first-party run (step 15) is a third key and gets no collateral or float here'));
  assert.ok(funds.includes('A job of the Pipeline costs the hirer about 7 (`docs/HIRE.md`, section 3)'));
});

test('Pipeline RUNBOOK steps 1 to 3: the repository goes over as a git bundle and is cloned with --branch main; the image is built on the box; the runtime is built from the pinned template', () => {
  const one = section(pRunbook, '1. Put the files on the box');
  for (const part of [
    'The box has no GitHub credentials, so the repository goes over as a git bundle.',
    'git bundle create vector-service-agents.bundle main', 'git bundle verify vector-service-agents.bundle', 'scp vector-service-agents.bundle <user>@<box>:/tmp/',
    'mkdir -p "$BASE" && cd "$BASE"', 'git clone --branch main /tmp/vector-service-agents.bundle repo', 'cd repo/deploy/host', 'git log -1 --oneline',
    'a bundle of `main` alone has no `HEAD`', 'Check that the commit is the one that was reviewed.', '"This folder" below means `$BASE/repo/deploy/host`.',
  ]) assert.ok(one.includes(part), `step 1 says: ${part}`);
  assert.doesNotMatch(one, /git clone https:/, 'no clone from GitHub: the box has no credentials');
  const three = section(pRunbook, '3. Build the runtime image');
  assert.ok(three.includes('docker compose -f docker-compose.document-pipeline.yml build agent'));
  assert.ok(three.includes('`a05564c`') && three.includes('the full 40-character hash, because BuildKit does not resolve the short form'));
  assert.ok(three.includes('It ends with `Image document-pipeline-agent Built`.'));
});

test('Pipeline RUNBOOK step 4: the env file is made once and never over a file that is there, each key and the token go only into an empty line, the buyer key has a block of its own, nothing secret is printed, the lengths and the difference of the two keys are checked, the offline copy is refreshed after a regeneration, and the contact is set', () => {
  const four = section(pRunbook, '4. Make the env file and generate the two keys');
  for (const part of [
    'The two keys and the token between the two containers are generated on the box and are never sent anywhere.', 'Nothing secret is printed',
    'This step makes things once and replaces nothing.', 'A block that is run a second time says `refusing:` and changes nothing',
    'a copy of the example over the env file would replace both keys at once',
    'empty its four lines by hand (the failure table says how) and run only the block of that key',
    'umask 077', 'cp .env.document-pipeline.example .env.document-pipeline', 'chmod 600 .env.document-pipeline',
    'docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent \\\n    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1',
    'privateKeyHex:${1}_PRIV_KEY_HEX publicKeyHex:${1}_PUB_KEY_HEX pubKeyHash:${1}_PKH address:${1}_ADDRESS',
    "awk -F= '/^(SUPPLIER|PIPELINE_BUYER)_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/ { v = $2; gsub(/\"/, \"\", v); print $1, length(v) }' .env.document-pipeline",
    "grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.document-pipeline", "never a person's address", '`OPERATOR_CONTACT` is required',
    'The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today\'s date: the status can honestly change only in step 17.',
    'this file is the only copy of either until step 7. There is no recovery phrase',
    "Copy `.env.document-pipeline` to the operator's encrypted offline store now, before either address receives anything, and copy it again after any regeneration of a key or of the token: a copy made before holds the old key, and the new one has no copy at all.",
    'Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`',
    'The buyer key never has a second copy on the box.',
    // The token: what it is, who sends it, who requires it, and why it is written in quotes.
    'The token is the value of `SERVICE_AUTH_HEADER`. The runtime sends it as the `authorization` header of every call to the service, and the service answers `POST /` only to a call that carries exactly that value (ruling R50)',
    'Both containers read it from the env file, and neither blanks it.',
    'It is written in quotes, `SERVICE_AUTH_HEADER="Bearer <64 hex>"`: the ops scripts read the file with the shell\'s `.`, and without the quotes the shell would run the hex as a command and stop with exit 127.',
    'Docker Compose takes the quotes off, so the containers see `Bearer ` and the 64 hex digits, 71 characters.',
    'openssl rand -hex 32',
  ]) assert.ok(four.includes(part), `step 4 says: ${part}`);
  assert.equal(four.split('gen-keypair.ts --network 1').length - 1, 1, 'one call, inside the function that runs once for each key');
  for (const line of ['SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58', 'PIPELINE_BUYER_PRIV_KEY_HEX 64', 'PIPELINE_BUYER_PUB_KEY_HEX 64', 'PIPELINE_BUYER_PKH 56', 'PIPELINE_BUYER_ADDRESS 58', 'SERVICE_AUTH_HEADER 71']) assert.ok(four.includes('`' + line + '`'), `the lengths: ${line}`);
  assert.ok(four.includes('All nine are needed.'));
  // The names the function writes are exactly the names of the two key blocks of the example, in the order the blocks have them.
  const written = ['SUPPLIER', 'PIPELINE_BUYER'].flatMap((p) => [`${p}_PRIV_KEY_HEX`, `${p}_PUB_KEY_HEX`, `${p}_PKH`, `${p}_ADDRESS`]);
  assert.deepEqual(written, [...P_SUPPLIER, ...P_BUYER]);
  // The two keys must differ, and the runbook checks it from the public key hashes. If they do not, the way out is the buyer block alone, not step 4 again.
  assert.ok(four.includes("\"$(sed -n 's/^SUPPLIER_PKH=//p' .env.document-pipeline)\" != \"$(sed -n 's/^PIPELINE_BUYER_PKH=//p' .env.document-pipeline)\""));
  assert.ok(four.includes('THE TWO KEYS ARE THE SAME: stop, empty the four buyer lines and run the buyer block again'));
  // The blocks, in order: the file and the functions; the supplier key; the buyer key; the token; the lengths; the difference; the contact.
  const blocks = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 7);
  const [head, supplier, buyer, token, lengths, distinct, contact] = blocks;
  assert.ok(head.includes('keypair_into() {') && head.includes('token_into() {'));
  assert.equal(supplier, 'cd "$BASE/repo/deploy/host"\nkeypair_into SUPPLIER\n');
  assert.equal(buyer, 'cd "$BASE/repo/deploy/host"\nkeypair_into PIPELINE_BUYER\n', 'the buyer key has a block of its own, so that it can be made again alone');
  assert.equal(token, 'cd "$BASE/repo/deploy/host"\ntoken_into\n');
  assert.ok(lengths.startsWith("awk -F= '") && distinct.startsWith('[ "$(sed -n') && contact.startsWith("grep -c '^OPERATOR_CONTACT="));
  assert.doesNotMatch(four, /keypair_into SUPPLIER &&|&& keypair_into PIPELINE_BUYER/, 'no chain that makes both keys in one go');
  assert.equal(four.split('keypair_into PIPELINE_BUYER').length - 1, 1, 'the buyer key is made in one place');
  // The file is made only when there is none, after umask 077, and nowhere else: one cp, in the else of the test.
  assert.equal(four.split('cp .env.document-pipeline.example').length - 1, 1);
  assert.ok(head.endsWith('if [ -e .env.document-pipeline ]; then\n  echo "refusing: the env file exists, and it is kept as it is" >&2\nelse\n  cp .env.document-pipeline.example .env.document-pipeline && chmod 600 .env.document-pipeline\nfi\n'));
  assert.ok(head.indexOf('umask 077') < head.indexOf('cp .env.document-pipeline.example'), 'private from the first byte');
  // The functions write into an empty place only, and look before they make anything: a key is not made, and openssl not called, for a line that has a value.
  for (const guard of [
    'refusing: there is no .env.document-pipeline in this folder',
    'refusing: ${1}_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
    'refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first',
  ]) assert.ok(head.includes(guard), `the functions say: ${guard}`);
  assert.ok(head.indexOf('${1}_PRIV_KEY_HEX already has a value') < head.indexOf('gen-keypair.ts'), 'the key is looked for before gen-keypair is called');
  assert.ok(head.indexOf('SERVICE_AUTH_HEADER already has a value') < head.indexOf('openssl rand -hex 32'), 'the token is looked for before openssl is called');
  assert.ok(head.includes('sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\\"Bearer $value\\"|" .env.document-pipeline'), 'the token is written in quotes');
  assert.ok(head.includes('[ "${#value}" = 64 ]'), 'and only if openssl gave 64 characters');
  // Nothing prints the keypair or a value except into sed.
  assert.doesNotMatch(head, /\b(echo|printf)\b[^\n]*\$(json|value)\b(?![^\n]*\|)/, 'nothing prints the keypair or a value except into sed');
  assert.match(head, /printf '%s\\n' "\$json" \| sed -n /);
  assert.ok(four.indexOf('keypair_into SUPPLIER') < four.indexOf("grep -c '^OPERATOR_CONTACT="), 'the contact comes after the keys');
  assert.ok(four.indexOf('token_into\n') < four.indexOf("awk -F= '"), 'the lengths come after the keys and the token');
  // The contact: a role address, and no word about whose address another agent used.
  assert.doesNotMatch(four, /agent-history\/repo\/deploy\/host\/\.env\.agent-history|HISTORY_BASE|first candidate/);
});

// ---- Step 4 run in bash ----
// The blocks of step 4 are run as they stand (the cd lines are the box's, so they are taken out and the temporary folder is the working directory) with stand-ins for docker and openssl,
// which check the arguments they are called with. What is checked is what the step promises: it makes what is missing, it fills nothing that is filled, and it prints no secret.
const STUBS = String.raw`STUB_N="$PWD/.stub-n"
docker() {
  [ "$*" = "compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1" ] || { echo "unexpected docker call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '{\n  "privateKeyHex": "%064x",\n  "publicKeyHex": "%064x",\n  "pubKeyHash": "%056x",\n  "address": "addr1%053x"\n}\n' $((n * 1000003)) $((n * 7919)) $((n * 104729)) "$n"
}
openssl() {
  [ "$*" = "rand -hex 32" ] || { echo "unexpected openssl call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '%064x\n' $((n * 15485863))
}
`;
function step4Blocks() {
  const four = section(pRunbook, '4. Make the env file and generate the two keys');
  const [head, supplier, buyer, token, lengths, distinct] = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].replace(/^cd "\$BASE\/repo\/deploy\/host"\n/, ''));
  return { head, supplier, buyer, token, lengths, distinct };
}
function withStep4Folder(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dp-step4-'));
  try {
    copyFileSync(join(root, 'deploy/host/.env.document-pipeline.example'), join(dir, '.env.document-pipeline.example'));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const envOf = (dir) => readFileSync(join(dir, '.env.document-pipeline'), 'utf8');
const countOf = (dir) => Number(readFileSync(join(dir, '.stub-n'), 'utf8'));
const FILLED = /^(SUPPLIER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)|PIPELINE_BUYER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)|SERVICE_AUTH_HEADER)=/;
const apartFromTheNine = (text) => text.split('\n').filter((l) => !FILLED.test(l)).join('\n');

test('Pipeline RUNBOOK step 4 in bash: the blocks make the env file, the two keys and the token, print only names and lengths, and leave every other line of the example as it was', NEEDS_BASH, () => {
  const { head, supplier, buyer, token, lengths, distinct } = step4Blocks();
  withStep4Folder((dir) => {
    const run = runBash(`${STUBS}${head}${supplier}${buyer}${token}${lengths}${distinct}`, dir);
    assert.equal(run.stderr, '', 'nothing refused and nothing failed');
    assert.equal(run.status, 0);
    assert.equal(run.stdout, [
      'SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58',
      'PIPELINE_BUYER_PRIV_KEY_HEX 64', 'PIPELINE_BUYER_PUB_KEY_HEX 64', 'PIPELINE_BUYER_PKH 56', 'PIPELINE_BUYER_ADDRESS 58',
      'SERVICE_AUTH_HEADER 71', 'two different keys', '',
    ].join('\n'));
    assert.doesNotMatch(run.stdout + run.stderr, /[0-9a-f]{16}|Bearer/, 'no key, no hash and no token is printed');
    assert.equal(countOf(dir), 3, 'gen-keypair twice and openssl once');
    const written = parseEnv(envOf(dir));
    assert.match(written.SERVICE_AUTH_HEADER, /^"Bearer [0-9a-f]{64}"$/, 'in quotes, Bearer and 64 hex digits');
    assert.notEqual(written.SUPPLIER_PKH, written.PIPELINE_BUYER_PKH);
    for (const name of [...P_SUPPLIER, ...P_BUYER]) assert.notEqual(written[name], '', name);
    assert.equal(apartFromTheNine(envOf(dir)), apartFromTheNine(pExampleText), 'every other line is the example\'s');
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env.document-pipeline')).mode & 0o777, 0o600, 'mode 600');
  });
});

test('Pipeline RUNBOOK step 4 in bash: run again, in a new shell, nothing is made again and nothing is replaced: the file is the same bytes, no keypair is asked for, and every guard says so', NEEDS_BASH, () => {
  const { head, supplier, buyer, token } = step4Blocks();
  withStep4Folder((dir) => {
    const first = runBash(`${STUBS}${head}${supplier}${buyer}${token}`, dir);
    assert.equal(first.status, 0);
    const before = envOf(dir);
    const again = runBash(`${STUBS}${head}${supplier}${buyer}${token}`, dir);
    assert.equal(envOf(dir), before, 'byte for byte');
    assert.equal(countOf(dir), 3, 'no further call to gen-keypair or openssl');
    assert.equal(again.stdout, '');
    for (const refusal of [
      'refusing: the env file exists, and it is kept as it is',
      'refusing: SUPPLIER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
      'refusing: PIPELINE_BUYER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
      'refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first',
    ]) assert.ok(again.stderr.includes(refusal), refusal);
    assert.doesNotMatch(again.stdout + again.stderr, /[0-9a-f]{16}|Bearer/);
    // A block on its own does the same: the first block is only the file and the functions, and it leaves a file that is there.
    const alone = runBash(`${STUBS}${head}`, dir);
    assert.equal(envOf(dir), before);
    assert.match(alone.stderr, /^refusing: the env file exists, and it is kept as it is\n$/);
  });
});

test('Pipeline RUNBOOK step 4 in bash: the buyer key is made again alone, after its four lines were emptied by hand with the command of the failure table, and nothing else in the file moves', NEEDS_BASH, () => {
  const { head, supplier, buyer, token } = step4Blocks();
  const table = section(pRunbook, 'If something goes wrong');
  const emptyBuyer = String.raw`sed -i 's/^\(PIPELINE_BUYER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline`;
  assert.ok(table.includes('`' + emptyBuyer + '`'), 'the failure table gives the command that empties the buyer lines');
  withStep4Folder((dir) => {
    runBash(`${STUBS}${head}${supplier}${buyer}${token}`, dir);
    const before = parseEnv(envOf(dir));
    const emptied = runBash(`${emptyBuyer}\n`, dir);
    assert.equal(emptied.status, 0);
    const blank = parseEnv(envOf(dir));
    for (const name of P_BUYER) assert.equal(blank[name], '', `${name} emptied`);
    for (const name of [...P_SUPPLIER, ...P_TOKEN]) assert.equal(blank[name], before[name], `${name} untouched by the command`);
    const redo = runBash(`${STUBS}${head}${buyer}`, dir);
    assert.equal(redo.status, 0);
    assert.match(redo.stderr, /^refusing: the env file exists, and it is kept as it is\n$/, 'the first block, pasted to define the functions again, leaves the file alone');
    const after = parseEnv(envOf(dir));
    for (const name of P_BUYER) assert.match(after[name], /^[0-9a-z]+$/, `${name} made again`);
    for (const name of P_BUYER) assert.notEqual(after[name], before[name], `${name} is a new value`);
    for (const name of [...P_SUPPLIER, ...P_TOKEN]) assert.equal(after[name], before[name], `${name} untouched`);
    assert.equal(apartFromTheNine(envOf(dir)), apartFromTheNine(pExampleText));
  });
});

// C4: the supplier block refuses lines that have a value, so the failure table does not ask for the four supplier values to be filled again over them: a
// wrong line is restored from the offline copy, or, while the supplier address has received nothing, the four lines are emptied and the block made again.
test('Pipeline RUNBOOK step 4 in bash: the supplier block refuses while the supplier lines have values, and makes the key again alone after the command of the failure table emptied them', NEEDS_BASH, () => {
  const { head, supplier, buyer, token } = step4Blocks();
  const table = section(pRunbook, 'If something goes wrong');
  const emptySupplier = String.raw`sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline`;
  assert.ok(table.includes('`' + emptySupplier + '`'), 'the failure table gives the command that empties the supplier lines');
  withStep4Folder((dir) => {
    runBash(`${STUBS}${head}${supplier}${buyer}${token}`, dir);
    const before = parseEnv(envOf(dir));
    const refused = runBash(`${STUBS}${head}${supplier}`, dir);
    assert.match(refused.stderr, /refusing: SUPPLIER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced/);
    assert.deepEqual(parseEnv(envOf(dir)), before, 'the refused block changed nothing');
    const emptied = runBash(`${emptySupplier}\n`, dir);
    assert.equal(emptied.status, 0);
    const blank = parseEnv(envOf(dir));
    for (const name of P_SUPPLIER) assert.equal(blank[name], '', `${name} emptied`);
    for (const name of [...P_BUYER, ...P_TOKEN]) assert.equal(blank[name], before[name], `${name} untouched by the command`);
    const redo = runBash(`${STUBS}${head}${supplier}`, dir);
    assert.equal(redo.status, 0);
    const after = parseEnv(envOf(dir));
    for (const name of P_SUPPLIER) assert.match(after[name], /^[0-9a-z]+$/, `${name} made again`);
    for (const name of P_SUPPLIER) assert.notEqual(after[name], before[name], `${name} is a new value`);
    for (const name of [...P_BUYER, ...P_TOKEN]) assert.equal(after[name], before[name], `${name} untouched`);
    assert.equal(apartFromTheNine(envOf(dir)), apartFromTheNine(pExampleText));
  });
});

test('Pipeline RUNBOOK step 4 in bash: the token is made again alone after its line was emptied with the command of the failure table, and only while it is empty; the supplier key is the same', NEEDS_BASH, () => {
  const { head, supplier, buyer, token } = step4Blocks();
  const table = section(pRunbook, 'If something goes wrong');
  const emptyToken = `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.document-pipeline`;
  assert.ok(table.includes('`' + emptyToken + '`'), 'the failure table gives the command that empties the token line');
  withStep4Folder((dir) => {
    runBash(`${STUBS}${head}${supplier}${buyer}${token}`, dir);
    const before = parseEnv(envOf(dir));
    assert.equal(runBash(`${emptyToken}\n`, dir).status, 0);
    assert.equal(parseEnv(envOf(dir)).SERVICE_AUTH_HEADER, '""', 'empty, in quotes, as in the example');
    assert.equal(runBash(`${STUBS}${head}${token}`, dir).status, 0);
    const after = parseEnv(envOf(dir));
    assert.match(after.SERVICE_AUTH_HEADER, /^"Bearer [0-9a-f]{64}"$/);
    assert.notEqual(after.SERVICE_AUTH_HEADER, before.SERVICE_AUTH_HEADER, 'a new token');
    for (const name of [...P_SUPPLIER, ...P_BUYER]) assert.equal(after[name], before[name], `${name} untouched`);
    // The supplier key is refused while it has a value, whatever else is run.
    const refused = runBash(`${STUBS}${head}${supplier}`, dir);
    assert.equal(refused.status, 1);
    assert.equal(parseEnv(envOf(dir)).SUPPLIER_PRIV_KEY_HEX, before.SUPPLIER_PRIV_KEY_HEX);
  });
});

test('Pipeline RUNBOOK step 4 in bash: the functions make nothing where there is no env file and when gen-keypair fails, and say so', NEEDS_BASH, () => {
  const { head, supplier, token } = step4Blocks();
  const functionsOnly = head.slice(0, head.indexOf('if [ -e .env.document-pipeline ]; then'));
  assert.ok(functionsOnly.includes('keypair_into() {') && functionsOnly.includes('token_into() {') && !functionsOnly.includes('cp .env'));
  withStep4Folder((dir) => {
    const missing = runBash(`${STUBS}${functionsOnly}keypair_into SUPPLIER\nrc1=$?\ntoken_into\nrc2=$?\necho "rc $rc1 $rc2"\n`, dir);
    assert.equal(missing.stdout.trim(), 'rc 1 1');
    assert.equal(missing.stderr.match(/refusing: there is no \.env\.document-pipeline in this folder/g)?.length, 2);
    assert.equal(existsSync(join(dir, '.env.document-pipeline')), false, 'the functions do not make the file');
    assert.equal(existsSync(join(dir, '.stub-n')), false, 'and call neither gen-keypair nor openssl');
    // gen-keypair fails: nothing is written, and the block can be run again.
    const failing = 'docker() { return 1; }\n';
    const failed = runBash(`${STUBS}${failing}${head}${supplier}echo "rc $?"\n`, dir);
    assert.equal(failed.stdout.trim(), 'rc 1');
    assert.match(failed.stderr, /gen-keypair failed/);
    assert.equal(parseEnv(envOf(dir)).SUPPLIER_PRIV_KEY_HEX, '', 'the line is still empty');
    assert.equal(runBash(`${STUBS}${head}${supplier}`, dir).status, 0, 'run again, it makes the key');
    // openssl gives too little: nothing is written, and the line stays empty.
    const short = 'openssl() { echo abc; }\n';
    const bad = runBash(`${STUBS}${short}${head}${token}echo "rc $?"\n`, dir);
    assert.equal(bad.stdout.trim(), 'rc 1');
    assert.match(bad.stderr, /openssl rand failed/);
    assert.equal(parseEnv(envOf(dir)).SERVICE_AUTH_HEADER, '""');
  });
});

test('Pipeline RUNBOOK step 5: the ops scripts are copied from the adapted set of Agent History with the paths replaced; the registry record is the manifest description, the capability, the framework and the public URL', () => {
  const five = section(pRunbook, '5. Adapt the ops scripts');
  const desc = /^DESC="(.+)"$/m.exec(five)[1];
  const [{ description }] = renderManifests([{ OPERATOR_CONTACT: TEST_CONTACT }], 'agents/document-pipeline');
  assert.equal(desc, description);
  assert.ok(desc.length <= 256, 'the registry takes 256 characters of description');
  assert.ok(five.includes(`(this one is ${desc.length})`), 'the length the runbook quotes');
  for (const part of [
    'mkdir -p "$BASE/ops" && cd "$BASE/ops"',
    'for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do',
    'sed -e "s#$HISTORY_BASE/repo/deploy/host/\\.env\\.agent-history#$BASE/repo/deploy/host/.env.document-pipeline#g" \\',
    '-e "s#$HISTORY_BASE/ops#$BASE/ops#g" \\',
    '"$HISTORY_BASE/ops/$f" > "$f"',
    "sed -i 's#agent-history supplier#document-pipeline supplier#g' make-skey.py",
    "-e 's#^ \"name\":\"Agent History\",# \"name\":\"Document Pipeline\",#'",
    "-e 's#^ \"capabilities\":\\[.*\\],# \"capabilities\":[\"document.pipeline.ocr-summary.v1\"],#'",
    "-e 's#^ \"endpoint\":\"https://mp-suppliers-history.hal8.ai\"}# \"endpoint\":\"https://mp-suppliers-pipeline.hal8.ai\"}#'",
    "sed -i 's#^CAPABILITIES = \\[.*\\]#CAPABILITIES = [\"document.pipeline.ocr-summary.v1\"]#' m3-self-stake.py",
    "grep -il 'agent.history' *.sh *.py",
    "python3 -m venv venv", "./venv/bin/pip -q install 'cbor2==5.6.5'", './setup-venv.sh', "./venv/bin/pip show cbor2 | grep '^Version'", './venv/bin/python -c "import pycardano, reputation_staking"', '`setup-venv.sh` does not end with `venv ok` on this box', '`Version: 5.6.5`', 'breaks `cbor2pure`',
  ]) assert.ok(five.includes(part), `step 5 says: ${part}`);
  assert.ok(five.indexOf('python3 -m venv venv') < five.indexOf('./setup-venv.sh'), 'the venv is made and pinned before setup-venv.sh runs');
  // Each pattern the sed lines look for is what step 5 of the Agent History runbook leaves in the copies it made, so the second adaptation finds the first one's output.
  const h5 = section(runbook, '5. Adapt the ops scripts');
  for (const left of [
    String.raw`#$BASE/repo/deploy/host/.env.agent-history#g"`, String.raw`-e "s#$SRC#$BASE/ops#g"`, String.raw`#agent-history supplier#g"`,
    String.raw`# "name":"Agent History",#'`, String.raw`# \"description\":\"$DESC\",#"`, String.raw`# "capabilities":["identity.history.report.v1"],#'`,
    String.raw`# "endpoint":"https://mp-suppliers-history.hal8.ai"}#'`, String.raw`CAPABILITIES = ["identity.history.report.v1"]#'`,
  ]) assert.ok(h5.includes(left), `the copy of Agent History is made with: ${left}`);
  // The two adaptations are one chain: what the copy of Agent History writes under its BASE is what this copy looks for under HISTORY_BASE.
  for (const written of ['$BASE/repo/deploy/host/.env.agent-history', '$BASE/ops']) {
    assert.ok(h5.includes(`#${written}#g"`), `the copy of Agent History writes ${written}`);
    assert.ok(five.includes(`"s#${written.replace('$BASE', '$HISTORY_BASE').replaceAll('.', '\\.')}#`), `this copy looks for it under HISTORY_BASE: ${written}`);
  }
  assert.ok(five.includes(String.raw`-e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#"`), 'the description line is rewritten with the same pattern');
  assert.ok(runbook.includes('"framework":"vector-service-agents"') && PSPEC.includes('framework `vector-service-agents`'), 'the framework is the one the history copy already carries, and the spec');
  assert.ok(five.includes('Only the six scripts are copied; the venv and the wallet directory of Agent History stay where they are:'), 'nothing secret and nothing built is copied');
});

test('Pipeline RUNBOOK steps 6 to 8: two wallets supplied and checked, the identity of the supplier key registered and recorded in the repository, the stake on the one capability', () => {
  const six = section(pRunbook, '6. Supply the two wallets with their collateral and float');
  for (const part of [
    `grep -E '^(SUPPLIER|PIPELINE_BUYER)_ADDRESS=' "$BASE/repo/deploy/host/.env.document-pipeline"`,
    'The first is exactly 5 units, alone.', '50 units to the supplier address, 100 units to the buyer address',
    'for name in SUPPLIER_ADDRESS PIPELINE_BUYER_ADDRESS; do', '"$BASE/ops/mcp-call.sh" vector_get_utxos',
    'Each address must list two outputs: one of exactly 5 units and one for the second transfer.',
  ]) assert.ok(six.includes(part), `step 6 says: ${part}`);
  const seven = section(pRunbook, '7. Register the identity');
  for (const part of [
    `sed -i '/^AGENT_DID=$/d' "$BASE/repo/deploy/host/.env.document-pipeline"`, 'python3 make-skey.py', './register-did.sh',
    'the directory `$BASE/ops/wallet` (`payment.skey` and `payment.vkey`, mode 600)', '`payment.skey` is a second plaintext copy of the supplier key, next to the one in the env file',
    'remove it in Back out (point 5)', 'The buyer key is not touched by any step here and has no second copy on the box.',
    'The record has the name `Document Pipeline`, the capability `document.pipeline.ocr-summary.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-pipeline.hal8.ai` and the manifest\'s description.',
    `grep -c '^AGENT_DID=did:vector:agent:' "$BASE/repo/deploy/host/.env.document-pipeline"`, 'If it ends with `NOT CONFIRMED`',
    'Record the identity in the repository.', 'into the Identity section of `specs/document-pipeline.md`', '`scripts/specs.test.mjs`', 'The status word does not change here. Step 17 is the only place that flips it.',
  ]) assert.ok(seven.includes(part), `step 7 says: ${part}`);
  assert.ok(seven.indexOf('Record the identity in the repository.') > seven.indexOf("grep -c '^AGENT_DID=did:vector:agent:'"), 'after the identity is checked');
  // Step 7 was run on 2026-10-16 and the pull request it asks for changed those rows: the sentence says that the record exists, and the row is no longer "planned". The runbook still quotes the old words, as the instruction it was.
  assert.ok(PSPEC.includes('\nThis agent has had a registry record since 2026-10-16.\n') && /\n\| DID \| `did:vector:[0-9a-f]{64}` \|\n/.test(PSPEC) && PSPEC.includes('\n| Registry record | name `Document Pipeline`;'), 'the spec rows the pull request changed carry the record');
  assert.equal(PSPEC.includes('This agent has no registry record yet.') || PSPEC.includes('| Registry record, planned |'), false, 'and the words of before are gone');
  const eight = section(pRunbook, '8. Stake in Module-3');
  assert.ok(eight.includes('cd "$BASE/ops"\n./venv/bin/python m3-self-stake.py'));
  assert.ok(eight.includes('here both are the one capability `document.pipeline.ocr-summary.v1`'));
  assert.ok(eight.includes('`M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM`'));
});

test('Pipeline RUNBOOK step 9: the service is started by name after the pin is checked, and read: its log, /healthz, the manifest with both key hashes and the status, the limits, and the poppler probe', () => {
  const nine = section(pRunbook, '9. Start the service');
  for (const part of [
    'Start `service` by name. A bare `docker compose up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.',
    'docker compose -f docker-compose.document-pipeline.yml up -d service', 'docker logs document-pipeline-service',
    "docker exec document-pipeline-service node -e \"fetch('http://127.0.0.1:9092/healthz')", "fetch('http://127.0.0.1:9092/agent.json')",
    "docker inspect --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}}' document-pipeline-service", '`1610612736 330`',
    'the memory limit of 1536m in bytes and the stop timeout of 330 s, 30 s more than the service waits for a job',
    "docker exec document-pipeline-service sh -c 'pdfinfo -v 2>&1 | head -1; pdftoppm -v 2>&1 | head -1'",
    '`200 {"ok":true}`', '`503 {"ok":false,"reason":"insufficient_float"}`',
    '`vector.agent-manifest.v2` in `schema`', 'the role address of step 4 in `operator.contact`',
    'the new DID of step 7 in its canonical form `did:vector:<identifier>` in `identity.did` (the env file holds the legacy form `did:vector:agent:<policy>:<identifier>` of the same identifier)',
    'the listed supplier key `<DID>#<key hash>` in `identity.supplier_key`', 'the key hash in `keys.supplier_pkh`', 'the public key in `keys.pub_key_hex`',
    'the address of the identity registry in `identity.registry_address` (empty while `IDENTITY_POLICY_ID` is empty in the env file)',
    'the key hash of the buyer key in `keys.buyer_pkh`', '`status.chip` and `status.since`', 'an empty `links.explorer_advert`', "The advert's hash will cover exactly these bytes.",
    'asks `pdfinfo` and `pdftoppm` for their version before it listens', 'a `listening on` line means both ran',
    // R50: a call without the token is refused before its body is read, and the service does not start without a token.
    "docker exec document-pipeline-service node -e \"fetch('http://127.0.0.1:9092/', { method: 'POST', body: 'x' }).then(async (r) => console.log(r.status, await r.text()))\"",
    'A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`: the service refuses a call that does not carry the token of step 4 before it reads the body.',
    'The service does not start without that token (`environment variable SERVICE_AUTH_HEADER is required`, in the table at the end).',
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
  assert.ok(nine.indexOf("fetch('http://127.0.0.1:9092/agent.json')") < nine.indexOf("method: 'POST'") && nine.indexOf("method: 'POST'") < nine.indexOf('docker inspect --format'), 'the 401 check sits between the manifest and the limits');
  // 1536m is 1536 MiB; the first answer of /healthz is given before the first check of the wallet has finished.
  assert.equal(1536 * 1024 * 1024, 1610612736);
  assert.ok(nine.includes('before the first check of the buyer wallet has finished'));
  // The log lines it quotes are the ones the code writes, and the manifest keys it reads exist.
  const startup = START.match(/listening on \$\{config\.host\}:\$\{port\}; buyer address \$\{config\.buyer\.address\}; state directory \$\{config\.stateDir\}/);
  assert.ok(startup, 'the start line of the code');
  assert.ok(nine.includes('[document-pipeline] listening on 0.0.0.0:9092; buyer address <the buyer address of step 4>; state directory /data'));
  // The status the manifest must show is the env file's, whatever word it holds (a first run starts with proposed and step 17 flips it, ruling R52): step 9 pins no word and no date.
  assert.ok(nine.includes('`status.chip` and `status.since` as the env file sets them (step 4), and an empty `links.explorer_advert`.'));
  assert.doesNotMatch(nine, /status\.chip` `proposed`|2026-10-13/);
  assert.ok(read('agents/document-pipeline/src/server.ts').includes('console.log(`[document-pipeline] ${line}`)'));
  const [m] = renderManifests([{ OPERATOR_CONTACT: TEST_CONTACT }], 'agents/document-pipeline');
  assert.equal(m.schema, 'vector.agent-manifest.v2');
  for (const path of ['operator.contact', 'identity.did', 'identity.registry_address', 'identity.supplier_key', 'keys.supplier_pkh', 'keys.pub_key_hex', 'keys.buyer_pkh', 'status.chip', 'status.since', 'links.explorer_advert']) assert.ok(path.split('.').reduce((o, k) => o?.[k], m) !== undefined, `the manifest has ${path}`);
  assert.equal(pRunbook.includes('controller_pkh'), false, 'the field that the manifest v2 removed');
  assert.ok(read('agents/document-pipeline/src/render.ts').includes('poppler-utils (pdfinfo and pdftoppm) must be installed and on PATH'), 'the failure the runbook quotes');
});

test('Pipeline RUNBOOK steps 10 to 14: the Caddy script copy with the vhost and the snippet changed, the hash, the advert with the terms of the example and the spec, the runtime on 8084 with the heartbeat explained, the indexer', () => {
  const ten = section(pRunbook, '10. DNS and Caddy');
  for (const part of [
    "sed -e 's#^VHOST=.*#VHOST=mp-suppliers-pipeline.hal8.ai#' \\", '-e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.document-pipeline.snippet#" \\',
    '"$HISTORY_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh', 'chmod 755 install-caddy-route.sh', "grep -nE '^(VHOST|SNIPPET|MARKER)=' install-caddy-route.sh",
    "sed -i '/^MARKER=/s#agent-history#document-pipeline#g' install-caddy-route.sh",
    'refuses while the name does not resolve to the box', 'If a line does not show, the copy of Agent History names them differently: read the script, and change its vhost and its snippet path by hand.',
    "curl -fsS https://mp-suppliers-pipeline.hal8.ai/agent.json", 'It must return the manifest of step 9, byte for byte.',
    '`/healthz` on the public name answers only after step 13, because every other path goes to the runtime.',
    // Nothing of the other stack may be left in the copy, and what a wait or an exit code 2 before step 13 means.
    'Then check that nothing of Agent History is left in the copy:', '```sh\ngrep -in history install-caddy-route.sh\n```',
    "It may print a comment line of the copy: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of the other stack is what must not appear: change it by hand to this agent's before the script runs, because it would act on the wrong stack.",
    'The copy may poll `/healthz` on the public name after it has reloaded Caddy, and that route goes to the runtime, which does not exist before step 13. So before step 13 the script can wait on that poll, or end with exit code 2, with the block already in place.',
    'Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the box, the record is not there yet: wait for it and run the script again.',
  ]) assert.ok(ten.includes(part), `step 10 says: ${part}`);
  // In any case (C4): the other stack calls itself "Agent History" in its messages and comments, and a case-sensitive search would not see that.
  assert.equal(ten.includes('grep -n history'), false);
  assert.ok(ten.indexOf("sed -i '/^MARKER=/s#agent-history#document-pipeline#g'") < ten.indexOf('grep -in history install-caddy-route.sh') && ten.indexOf('grep -in history install-caddy-route.sh') < ten.indexOf('Run `./install-caddy-route.sh` once the record resolves to the box.'), 'the leftover check comes after the corrections and before the run');
  assert.ok(ten.indexOf('Run `./install-caddy-route.sh` once the record resolves to the box.') < ten.indexOf('The copy may poll `/healthz`') && ten.indexOf('The copy may poll `/healthz`') < ten.indexOf('curl -fsS https://mp-suppliers-pipeline.hal8.ai/agent.json'), 'the wait is explained between the run and the check from outside');
  assert.ok(existsSync(join(root, 'deploy/host/Caddyfile.document-pipeline.snippet')), 'the snippet the script merges exists');
  assert.ok(ten.includes('$BASE/repo/deploy/host/Caddyfile.document-pipeline.snippet'));
  const eleven = section(pRunbook, '11. Hash the manifest');
  assert.match(eleven, /```sh\nnode scripts\/manifest-hash\.mjs https:\/\/mp-suppliers-pipeline\.hal8\.ai\n```/);
  assert.ok(eleven.includes('curl -fsS https://mp-suppliers-pipeline.hal8.ai/agent.json | sha256sum'));
  // Step 12: the dry run and the real run are the same flags, and the flags are the terms of the example and the spec.
  const blocks = [...pRunbook.matchAll(/post-advert\.ts( --dry-run)? \x5c\n((?:  --[^\n]+\n)+)/g)];
  assert.equal(blocks.length, 2, 'a dry run and the real run');
  const flags = (body) => Object.fromEntries([...body.matchAll(/--([a-z-]+) (\S+?)(?: \x5c)?(?: \| tail -1\))?$/gm)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
  const [dry, real] = blocks.map((m) => flags(m[2]));
  assert.deepEqual(dry, real);
  assert.deepEqual(real, {
    'capability-id': pExample.ADVERT_CAPABILITY_ID, model: pExample.ADVERT_MODEL, 'max-output-tokens': '8192', 'price-lovelace': pExample.ADVERT_PRICE_LOVELACE,
    'max-processing-ms': pExample.ADVERT_MAX_PROCESSING_MS, 'endpoint-url': pExample.ADVERT_ENDPOINT_URL, 'detail-uri': pExample.ADVERT_DETAIL_URI, 'detail-hash': '$DETAIL_HASH',
  });
  assert.ok(blocks[0][1], 'the first block is the dry run');
  const twelve = section(pRunbook, '12. Post the advert');
  for (const part of [
    'the model `document-pipeline-v1`, `max_processing_ms` 1800000, the price 5000000 and both bonds at 1000000', 'ADVERT_REF=$(docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent',
    'sed -i "s|^ADVERT_REF=.*|ADVERT_REF=$ADVERT_REF|; s|^ADVERT_DETAIL_HASH=.*|ADVERT_DETAIL_HASH=$DETAIL_HASH|" .env.document-pipeline',
    '`--max-output-tokens` is required', 'Record the advert in the repository.', 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/', 'The status word stays PROPOSED until step 17.',
  ]) assert.ok(twelve.includes(part), `step 12 says: ${part}`);
  assert.ok(twelve.indexOf('Record the advert in the repository.') > twelve.indexOf('ADVERT_REF=$(docker compose'), 'after the advert is posted');
  const thirteen = section(pRunbook, '13. Start the runtime');
  for (const part of [
    'docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate agent', 'curl -s http://127.0.0.1:8084/healthz', 'curl -s http://127.0.0.1:8084/capability', 'curl -s http://127.0.0.1:8084/status',
    '`/capability` shows the advert, with `document.pipeline.ocr-summary.v1` and the public key', '`/status` says `free`', '`advert_unavailable`', 'on `https://mp-suppliers-pipeline.hal8.ai`',
    'the runtime calls the service with a plain `fetch` that gives up on a response that has not begun after 300 s', 'writes an interim `102 Processing` line every 60 s while a job runs',
    'A job that fails as `service_unreachable` at about the five-minute mark means those lines are not arriving',
    // R50: the runtime and the service hold one token, compared without printing it.
    'The runtime and the service must hold the same token. Compare them without printing it: the first figure is the length (71) and the second the first twelve hex digits of the sha256 of the value.',
    'for c in document-pipeline-agent document-pipeline-service; do\n  docker exec "$c" node -e "const v = process.env.SERVICE_AUTH_HEADER ?? \'\'; console.log(v.length, require(\'node:crypto\').createHash(\'sha256\').update(v).digest(\'hex\').slice(0, 12))"\ndone',
    'The two lines must be the same. `0 e3b0c44298fc` is an empty token, and two lines that differ mean that one container was created from another version of the env file (the table at the end, `service_http_401`).',
  ]) assert.ok(thirteen.includes(part), `step 13 says: ${part}`);
  assert.ok(thirteen.indexOf('curl -s http://127.0.0.1:8084/status') < thirteen.indexOf('The runtime and the service must hold the same token.') && thirteen.indexOf('The runtime and the service must hold the same token.') < thirteen.indexOf('One difference matters from here on.'), 'after the runtime answers, before the note on the long jobs');
  // The one-liner is run here, as the containers would run it: the length and twelve digits of the sha256, and never the value.
  const compare = /node -e "(const v = [^"]+)"/.exec(thirteen)?.[1];
  assert.ok(compare, 'the comparison');
  const token = `Bearer ${'ab'.repeat(32)}`;
  const printed = execFileSync(process.execPath, ['-e', compare], { env: { ...process.env, SERVICE_AUTH_HEADER: token }, encoding: 'utf8' });
  assert.equal(printed, `71 ${createHash('sha256').update(token).digest('hex').slice(0, 12)}\n`);
  assert.ok(!printed.includes(token) && !printed.includes('Bearer'), 'the value itself is not printed');
  const { SERVICE_AUTH_HEADER: _unset, ...withoutToken } = process.env;
  assert.equal(execFileSync(process.execPath, ['-e', compare], { env: withoutToken, encoding: 'utf8' }), `0 ${createHash('sha256').update('').digest('hex').slice(0, 12)}\n`);
  assert.equal(createHash('sha256').update('').digest('hex').slice(0, 12), 'e3b0c44298fc', 'the digest of an empty token, as the runbook says');
  const fourteen = section(pRunbook, '14. Check the advert on the indexer');
  assert.ok(fourteen.includes("ADVERT_REF=$(sed -n 's/^ADVERT_REF=//p' .env.document-pipeline) python3 -c '"));
  assert.ok(fourteen.includes('It must print `Active free document.pipeline.ocr-summary.v1` and the hash of step 11.'));
  assert.ok(fourteen.includes('From here the agent is advertised and the status word stays as it was until step 17.'));
  assert.doesNotMatch(fourteen, /PROPOSED|no job has settled/);
  assert.ok(fourteen.includes('The fetch uses `curl` on purpose'));
});

test('Pipeline RUNBOOK: the commands run in order (identity, stake, service, hash, dry run, advert, runtime), and every up -d names a service, never a bare up and never restart', () => {
  const at = (needle) => { const i = pRunbook.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['./register-did.sh', './venv/bin/python m3-self-stake.py', 'up -d service', 'node scripts/manifest-hash.mjs', 'post-advert.ts --dry-run', 'ADVERT_REF=$(docker compose', 'up -d --force-recreate agent'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places, 'the commands appear in this order');
  const ups = pRunbook.match(/docker compose -f \S+ up -d[^\n`]*/g);
  assert.ok(ups.length >= 5, 'the runbook has the up commands');
  for (const cmd of ups) assert.match(cmd, /^docker compose -f docker-compose\.document-pipeline\.yml up -d (--force-recreate )?(service|agent)$/, `a bare up -d also starts the runtime: ${cmd}`);
  assert.doesNotMatch(pRunbook, /docker compose [^\n]*\brestart\b/);
  // Every compose command names this agent's file and no other.
  for (const m of pRunbook.matchAll(/docker compose -f (\S+)/g)) assert.equal(m[1], 'docker-compose.document-pipeline.yml');
  assert.doesNotMatch(pRunbook, /8083|9091|agent-history-(agent|service)/, 'no port and no container of the Agent History stack is used here');
});

test('Pipeline RUNBOOK step 15: the settings of the first-party run, a request JSON the service accepts for one page, a poll pause for a job of minutes, a state file apart from Agent History\'s, and the capability the script takes as a setting', () => {
  const s15 = section(pRunbook, '15. The first-party run');
  const m = /`PAYLOAD` is the request JSON for one page of a public PDF: `(\{[^`]+\})`/.exec(s15);
  assert.ok(m, 'the PAYLOAD line');
  const requestJson = m[1].replace('<https URL of a one-page public PDF>', 'https://example.org/one-page.pdf');
  assert.deepEqual(JSON.parse(requestJson), { source: { url: 'https://example.org/one-page.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  // The service's own parser takes it: nothing is fetched and nothing is spent by parsing.
  const [parsed] = inPipeline("import { parseRequest } from './src/request.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((j) => parseRequest(j))));", [requestJson]);
  assert.deepEqual(parsed, { source: { url: 'https://example.org/one-page.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  for (const part of [
    "Operator, on the operator's own machine, with the test buyer key (Collateral and float).", 'The mechanics are those of step 15 of RUNBOOK.md and of [docs/E2E.md](../../docs/E2E.md)',
    '- `ADVERT_REF` is the Pipeline\'s advert from step 12.', 'Use a document that anyone may read: its page goes to the OCR agent, and Datalab behind it, and its text to the chat supplier and that supplier\'s model provider.',
    '- `E2E_POLL_MS=15000`.', 'about 120 times in 10 minutes', '- `E2E_STATE=./e2e-state-pipeline.json`.', 'so this run does not use the file of the Agent History run',
    '- Expect up to 10 minutes for one page.', 'Five pages take up to 27 min.',
    'docker logs --tail 20 document-pipeline-service', 'docker exec document-pipeline-service cat /data/stranded.json',
    '`[document-pipeline] job done in <ms> ms: 2 sub-jobs`', '`stranded.json` prints `[]`', 'a clean run leaves nothing for the janitor, because each Accept removes its own entry',
    'Add the run to the Results table in docs/E2E.md and keep the evidence of the run in docs/evidence/.', 'A first-party run is not demand.',
  ]) assert.ok(s15.includes(part), `step 15 says: ${part}`);
  // E2E_POLL_MS and E2E_STATE are settings of the script, and 120 is 10 minutes at the default pause of 5 s.
  const script = read('scripts/e2e-hire.mjs');
  assert.ok(script.includes('E2E_POLL_MS') && script.includes('E2E_STATE'));
  assert.match(script, /POLL_MS = env\.E2E_POLL_MS === undefined \? 5000 :/, 'the default pause is 5 s');
  assert.equal(10 * 60 * 1000 / 5000, 120);
  // The script takes the capability as a setting (ruling R49), the capability of Agent History by default, and the step names the value for the Pipeline: the capability of its spec and its env example.
  assert.match(script, /^const DEFAULT_CAPABILITY = 'identity\.history\.report\.v1';$/m);
  assert.match(script, /^const CAPABILITY = env\.CAPABILITY_ID \?\? DEFAULT_CAPABILITY;$/m);
  assert.ok(script.includes('is not among the free suppliers for ${CAPABILITY}'));
  const capabilityBullet = s15.split('\n').find((l) => l.startsWith('- `CAPABILITY_ID=')) ?? '';
  assert.ok(capabilityBullet.startsWith(`- \`CAPABILITY_ID=${pExample.ADVERT_CAPABILITY_ID}\`. The script looks the advert up among the free suppliers of this capability`), 'the setting, with the capability of the env example');
  assert.ok(capabilityBullet.includes('its default is the capability of Agent History, so without this setting it stops before it posts anything, with "is not among the free suppliers".'));
  assert.equal(s15.includes('Until the script takes the capability as a setting'), false, 'the workaround of before the setting is gone');
  assert.equal(s15.includes('in its `CAPABILITY` constant'), false);
  assert.ok(s15.includes('Run `node scripts/e2e-hire.mjs --dry-run` first, then `node scripts/e2e-hire.mjs`, with these settings, as in [docs/E2E.md](../../docs/E2E.md); its section "Hiring Document Pipeline" lists them. The checks below are the same.'));
  // docs/E2E.md carries the same settings: the request JSON, the pause and the state file are written alike in both.
  const e2eSection = section(read('docs/E2E.md'), 'Hiring Document Pipeline');
  for (const setting of [m[1], 'export CAPABILITY_ID=document.pipeline.ocr-summary.v1', 'export E2E_POLL_MS=15000', 'export E2E_STATE=./e2e-state-pipeline.json']) assert.ok(e2eSection.includes(setting), `docs/E2E.md has the setting: ${setting}`);
  assert.ok(e2eSection.includes('[deploy/host/RUNBOOK-document-pipeline.md](../deploy/host/RUNBOOK-document-pipeline.md) step 15'));
  // The log line it quotes is the code's.
  assert.ok(read('agents/document-pipeline/src/server.ts').includes('log(`job done in ${deps.clock() - arrivedAt} ms: ${result.accounting.sub_jobs} sub-jobs`);'));
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes("export const STRANDED_FILE = 'stranded.json';")); // the stranded store is packages/hire-kit's since the extraction
});

test('Pipeline RUNBOOK "Watch the first stop": one stop of the idle service is watched before step 17, and what to read is what the code logs', () => {
  const stop = section(pRunbook, 'Watch the first stop');
  for (const part of [
    'Operator, after step 15 and while no job is running.', 'On SIGTERM (`docker stop` sends it) the service takes no new job and waits up to 300 s for the one that is running, its Accept included, then exits 0, or 1 if it had to abandon that job.',
    'Docker allows 30 s more than the service waits (`stop_grace_period: 330s`), so that a job abandoned at the end of the wait is logged and the exit code is the service\'s.',
    // Ruling R61: the image runs node itself, with tsx as a hook, so there is no child that relays the signal.
    "That works only if the signal reaches the service through the image's `tini`, which runs it as one process, `node --import tsx`, with no child to relay the signal",
    'before step 17 stops the service for real',
    'curl -s http://127.0.0.1:8084/status', 'time docker compose -f docker-compose.document-pipeline.yml stop service', 'docker logs --tail 5 document-pipeline-service',
    "docker inspect --format '{{.State.ExitCode}}' document-pipeline-service", 'docker compose -f docker-compose.document-pipeline.yml up -d service',
    '`/status` must say `free`', 'With nothing running the stop returns in a few seconds.',
    'The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`.', 'An exit code of 137 means the container was killed.',
    "Any other code but 0 fails the check too (143 would mean the signal ended the process before the service's own handling of it).",
    'do not go on to step 17', 'When a job is running at a stop, the log also says `stopping: waiting up to 300000 ms for the job that is running`.',
    // What this check proves, and what it leaves open.
    'This proves that the signal is delivered to an idle service and handled. The wait for a job that is running is tested offline (`agents/document-pipeline/test/start.test.ts`), and the box has not shown it yet: until the first real stop that finds a job running shows it, a stop is made only when `/status` says `free`.',
    'A stop that had to abandon a job exits 1, and its log names the escrows the state directory holds for the janitor of the next start.',
  ]) assert.ok(stop.includes(part), `the first stop says: ${part}`);
  assert.equal(stop.includes('signal relay of `tsx`'), false, 'the caveat of the image that ran the tsx binary');
  assert.ok(stop.indexOf('When a job is running at a stop') < stop.indexOf('This proves that the signal is delivered to an idle service'), 'said after the reading of the log');
  assert.ok(read('agents/document-pipeline/Dockerfile').includes('CMD ["node", "--import", "tsx", "agents/document-pipeline/src/index.ts"]'), 'the image runs the service as one node process, as the text says');
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes('did not finish within ${waitMs} ms and is abandoned; the state directory holds ${refs.length}'), 'the line of an abandoned job is the code\'s'); // abandonedLine of packages/hire-kit
  assert.ok(stop.indexOf('stop service') < stop.indexOf('docker logs --tail 5') && stop.indexOf('docker logs --tail 5') < stop.indexOf('{{.State.ExitCode}}') && stop.indexOf('{{.State.ExitCode}}') < stop.indexOf('up -d service'), 'stop, read the log, read the exit code, start again');
  // The lines are the code's.
  const lifecycle = read('packages/service-kit/src/lifecycle.ts'); // the stop and the signals are the shared code's since packages/service-kit
  assert.ok(lifecycle.includes('log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);'));
  assert.ok(lifecycle.includes('log(`stopping: waiting up to ${waitMs} ms for the job that is running`);'));
  assert.ok(lifecycle.includes("const SIGNALS") || lifecycle.includes("for (const signal of ['SIGTERM', 'SIGINT'])"));
  assert.ok(pRunbook.indexOf('\n## Watch the first stop\n') > pRunbook.indexOf('\n## 15. ') && pRunbook.indexOf('\n## Watch the first stop\n') < pRunbook.indexOf('\n## 16. '));
  assert.ok(section(pRunbook, '17. Flip the status').includes('and the first stop has been watched'), 'step 17 waits for it');
});

test('Pipeline RUNBOOK step 16: the wallet monitor is not used for this agent either, and the two floats are read some other way', () => {
  const s16 = section(pRunbook, '16. Wallet monitor');
  for (const part of [
    'Not used for this agent, as for Agent History (step 16 of RUNBOOK.md)', 'The supplier float is read by hand with the check of step 6.', "The buyer float is watched by the service itself: `/healthz` answers 503 `insufficient_float`",
    '`Apex-Fusion/agents-marketplace`', '`wallet-monitor/wallets.json`', '"supplier-document-pipeline"', '"buyer-document-pipeline"', '<SUPPLIER_ADDRESS from the env file>', '<PIPELINE_BUYER_ADDRESS from the env file>',
  ]) assert.ok(s16.includes(part), `step 16 says: ${part}`);
  assert.doesNotMatch(s16, /upstream repository/);
});

test('Pipeline RUNBOOK step 17: the old advert is retired before the service restarts and before the new manifest is hashed, and the last item names the files and the code that carry the word, and only files that exist', () => {
  const s17 = section(pRunbook, '17. Flip the status');
  const at = (needle) => { const i = s17.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['1. Check `curl', '2. Retire the old advert (Back out, point 1)', '3. In `.env.document-pipeline`', '4. `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate service`', '5. Hash the new manifest (step 11)', '6. Post the new advert (step 12)', '7. `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate agent`', '8. In the repository'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places, 'retire, edit, recreate the service, hash, post, recreate the runtime, update the repository');
  assert.match(s17, /no Active advert carries a stale `detail_hash` while the service restarts/);
  assert.ok(s17.includes('`curl -s http://127.0.0.1:8084/status` says `free`'));
  assert.ok(s17.includes('waits up to 300 s for a job that is running'));
  const item8 = s17.slice(s17.indexOf('8. In the repository'));
  const FILES = ['specs/document-pipeline.md', 'agents/document-pipeline/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md', 'deploy/host/README.md', 'deploy/host/RUNBOOK-document-pipeline.md', 'deploy/host/docker-compose.document-pipeline.yml', 'deploy/host/Caddyfile.document-pipeline.snippet', 'deploy/host/.env.document-pipeline.example'];
  const CODE = ['agents/document-pipeline/src/server.ts', 'agents/document-pipeline/agent.json.template', 'agents/document-pipeline/test/server.test.ts', 'agents/document-pipeline/test/spec.test.ts', 'scripts/specs.test.mjs', 'scripts/deploy.test.mjs'];
  for (const f of [...FILES, ...CODE]) {
    assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  assert.match(item8, /regenerate it from the code with `pnpm --filter @vsa\/document-pipeline template`, never by hand/);
  assert.ok(PREADME.includes('regenerating it: `pnpm --filter @vsa/document-pipeline template`'), 'the command is the README of the agent\'s');
  assert.ok(item8.includes('The new advert has a new reference: replace the old one wherever it is given as the current advert, and keep it in the Links section of the spec as the retired advert.'));
  assert.ok(item8.includes('change every file that says PROPOSED about the Document Pipeline'));
  assert.ok(item8.includes('and leave the other three agents\' lines alone'));
  for (const [, named] of item8.matchAll(/`([A-Za-z0-9_.\/-]+\.(?:md|yml|snippet|example|ts|mjs|template))`/g)) assert.ok(existsSync(join(root, named)), `item 8 names a file that exists: ${named}`);
  // The word is carried as a default by the code, as the item says: deployed since the flip of 2026-10-16, given to the status rules of packages/service-kit.
  const pServer = read('agents/document-pipeline/src/server.ts');
  assert.ok(pServer.includes("statusChip(env.AGENT_STATUS_CHIP, 'deployed')") && pServer.includes("statusSince(env.AGENT_STATUS_SINCE, '2026-10-16')"));
  assert.equal(pServer.includes("'proposed'"), false);
});

test('Pipeline RUNBOOK: steps 1 to 15 and 17 were run on 2026-10-16 and step 16 is not used, the step texts stay instructions (step 7 quotes no row that is gone), and a first run is told to start with the earlier word', () => {
  assert.equal(pRunbook.match(/No step of it has been run|what will happen/), null);
  // The first stop was watched the same day (the section "Watch the first stop" says what to expect: the log line, and the exit code 0).
  assert.ok(pRunbook.split('\n')[2].includes('and the first stop was watched the same day (the service was idle, the stop took 1 s, the exit code was 0).'));
  assert.ok(section(pRunbook, 'Watch the first stop').includes('and the exit code is `0`.'));
  // Step 7 asks for the pull request that records the identity: it names the rows as they are after it (the Registry record row, and the sentence that says the agent has a registry record).
  const seven = section(pRunbook, '7. Register the identity');
  assert.ok(seven.includes('(the DID row, the "Registry record" row and the sentence that says the agent has a registry record)'));
  assert.equal(seven.includes('Registry record, planned') || seven.includes('no registry record yet'), false);
  // Step 12 asks for the explorer link of the advert and for the rows that still say "planned" or "not in service": an instruction, so it still names them. The status word stays PROPOSED until step 17.
  const twelve = section(pRunbook, '12. Post the advert');
  assert.ok(twelve.includes('refresh the rows of the Identity table that still say "planned" or "not in service"'));
  assert.ok(twelve.includes('The status word stays PROPOSED until step 17.'));
  assert.ok(section(pRunbook, '16. Wallet monitor').startsWith('\nNot used for this agent, as for Agent History'));
  // Step 14 names no word and no job, so it stays right after the flip too.
  assert.doesNotMatch(section(pRunbook, '14. Check the advert on the indexer'), /PROPOSED|no job has settled/);
});

test('Pipeline RUNBOOK Back out: the advert first with the supplier key, then the service finishes what it holds, then the containers stop with the state volume kept, then the Caddy block, then the keys', () => {
  const back = section(pRunbook, 'Back out');
  const at = (needle) => { const i = back.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['1. Retire the advert.', 'Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted', 'agent/src/cli/retire-advert.ts', '--advert-ref', '2. Let the service finish what it holds.', '3. Stop the containers', 'docker compose -f docker-compose.document-pipeline.yml down', '4. Host administrator: remove the Caddy block', '5. Operator: the keys.'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places);
  assert.match(back, /signed with the supplier key in the env file/);
  // The runtime's /status exists from step 13; an advert of step 12 with no runtime has no job to wait for (C4).
  assert.ok(back.includes('If the runtime runs, check that `curl -s http://127.0.0.1:8084/status` says `free` (`working` means a job is in flight: wait for it). Without the runtime, from step 12 to step 13, no job can run.'));
  for (const part of [
    'docker exec document-pipeline-service cat /data/stranded.json', 'the janitor reclaims each one 5 s after its `deliver_by`', 'janitor: reclaimed <escrow>: ...',
    'Never add `-v`, and never run `docker volume rm document-pipeline-state`', 'the volume holds `stranded.json`, the escrows that still lock the buyer\'s units, and the janitor of the next start reads it. `down` keeps it.', 'The stop waits up to 300 s for a job that is running, and Docker 30 s more for the service to log what it left and exit.',
    'two files of a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory, and `rmdir` refuses one that holds anything else)',
    'The env file still holds both keys, and so does the operator\'s offline store: keep both until both wallets are empty, because a wallet whose key is gone is gone.',
    'The buyer wallet is emptied last, with the buyer key, once `stranded.json` is empty (or was never written): its float and its collateral go back to the Foundation.',
    'No script of this pack does that: none signs with the buyer key, so the float stays in the wallet until the operator signs the transfer with the buyer key by other means (the byte-preserving signer pointed at a signing-key file made from the buyer key and shredded afterwards, as in the `store_write_failed` row of the table at the end).',
    'If `cat` says `No such file or directory`, no job has ever recorded an escrow and there is nothing to wait for.',
  ]) assert.ok(back.includes(part), `Back out says: ${part}`);
  assert.doesNotMatch(back, /rm -r /, 'the directory is removed with rmdir, after its two files are shredded');
  // The janitor's file is created by the first escrow a job records, so a missing file means there never was one.
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes("if (codeOf(err) === 'ENOENT') return;"), 'a store with no file starts empty and writes the file with its first entry');
  assert.ok(pRunbook.indexOf('\n## Back out\n') > pRunbook.indexOf('\n## 17.') && pRunbook.indexOf('\n## Back out\n') < pRunbook.indexOf('\n## If something goes wrong\n'), 'after step 17, before the failure table');
  // The janitor reclaims 5 s after deliver_by, as the code says.
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes('export const JANITOR_GRACE_MS = 5_000;'));
  // The stake is not refundable: the module keeps 10 units as the minimum (Module-3 spec section 6.2, stake_validation.ak). Only the identity is withdrawn, by deregistration.
  assert.ok(back.includes('The registry identity stays on the ledger until the operator deregisters it, and the deposit returns then. The stake is different. The owner cannot withdraw it: the module keeps 10 units as the minimum, and only stake above it can be decreased.'));
});

test('Back out of both runbooks: the second plaintext copy of the supplier key is shredded as two files and the directory is removed with rmdir; run as written, it leaves nothing, and shred on the directory itself fails', { skip: HAVE_BASH && spawnSync('bash', ['-c', 'command -v shred'], { encoding: 'utf8' }).status === 0 ? false : 'needs bash and shred' }, () => {
  const SHRED = /`(shred -u "\$BASE\/ops\/wallet\/payment\.skey" "\$BASE\/ops\/wallet\/payment\.vkey")`, then `(rmdir "\$BASE\/ops\/wallet")`/;
  for (const [name, text] of [['Agent History', section(runbook, 'Back out')], ['Document Pipeline', section(pRunbook, 'Back out')]]) {
    const m = SHRED.exec(text);
    assert.ok(m, `${name}: the two shreds and the rmdir`);
    const dir = mkdtempSync(join(tmpdir(), 'dp-wallet-'));
    try {
      // BASE is the folder the operator chose; here it is the temporary folder, and the commands run as the runbook gives them.
      const base = dir.split(sep).join('/');
      const wallet = join(dir, 'ops', 'wallet');
      const make = () => { runBash(`mkdir -p "${base}/ops/wallet" && echo skey > "${base}/ops/wallet/payment.skey" && echo vkey > "${base}/ops/wallet/payment.vkey"\n`, dir); };
      make();
      assert.ok(existsSync(join(wallet, 'payment.skey')), `${name}: the directory with its two files`);
      const done = runBash(`set -e\nBASE='${base}'\n${m[1]}\n${m[2]}\n`, dir);
      assert.equal(done.status, 0, `${name}: ${done.stderr}`);
      assert.equal(existsSync(wallet), false, `${name}: nothing is left`);
      // The form that was there before fails, and leaves the files: shred does not take a directory.
      make();
      const old = runBash(`shred -u "${base}/ops/wallet"\n`, dir);
      assert.notEqual(old.status, 0, `${name}: shred on a directory fails`);
      assert.ok(existsSync(join(wallet, 'payment.skey')), `${name}: and the key file is still there`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('Pipeline RUNBOOK failure table: the start-up refusals, the pipeline codes and the janitor lines, each as the code words it', () => {
  const table = section(pRunbook, 'If something goes wrong');
  const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| What you see |'));
  assert.ok(rows.length >= 20, `${rows.length} rows`);
  for (const row of rows) assert.equal(row.split(' | ').length, 3, `three columns: ${row.slice(0, 60)}`);
  const sources = {
    start: read('agents/document-pipeline/src/start.ts'), server: read('agents/document-pipeline/src/server.ts'), orchestrate: read('agents/document-pipeline/src/orchestrate.ts'),
    janitor: read('packages/hire-kit/src/janitor.ts'), render: read('agents/document-pipeline/src/render.ts'), result: read('agents/document-pipeline/src/result.ts'),
    kitEnv: read('packages/service-kit/src/env.ts'), kitServer: read('packages/service-kit/src/server.ts'), hireSelect: read('packages/hire-kit/src/select.ts'),
  };
  // Each message the table quotes is in the code that prints it; a reworded message breaks this pin before it breaks an operator's search.
  for (const [row, where, quote] of [
    ['`environment variable OPERATOR_CONTACT is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SERVICE_AUTH_HEADER is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['must be printable ASCII', 'kitEnv', 'must be printable ASCII (it is sent as an HTTP header)'],
    ['`request refused: unauthorized (<n> since the last line of this kind)`', 'kitServer', 'request refused: unauthorized (${refusals} since the last line of this kind)'],
    ['`holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone`', 'start', 'holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone'],
    ['`holds the service token, which belongs in SERVICE_AUTH_HEADER alone`', 'kitEnv', 'holds the service token, which belongs in SERVICE_AUTH_HEADER alone'],
    ['`is not the public key of SUPPLIER_PKH`', 'start', 'is not the public key of SUPPLIER_PKH'],
    ['`is not the key hash of the key in PIPELINE_BUYER_PRIV_KEY_HEX`', 'start', 'is not the key hash of the key in PIPELINE_BUYER_PRIV_KEY_HEX'],
    ['`poppler-utils (pdfinfo and pdftoppm) must be installed and on PATH`', 'render', 'poppler-utils (pdfinfo and pdftoppm) must be installed and on PATH'],
    ['`which cannot be written`', 'start', 'which cannot be written'],
    ['`is not a list of stranded escrows`', 'janitor', 'is not a list of stranded escrows'],
    ['`insufficient_float`', 'orchestrate', "'insufficient_float'"], ['`ocr_supplier_unavailable`', 'orchestrate', "'ocr_supplier_unavailable'"], ['`llm_supplier_unavailable`', 'orchestrate', "'llm_supplier_unavailable'"],
    ['`store_write_failed`', 'result', 'store_write_failed'],
    ['`wallet check failed: ...`', 'server', 'wallet check failed: ${failure}'], ['`wallet check passed again`', 'server', "'wallet check passed again'"],
    ['`janitor: reclaimed <escrow>: ...`', 'janitor', 'janitor: ${action.action} ${action.escrow_ref}: ${action.note}'],
    ['`janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest`', 'janitor', 'Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest'],
    ['`janitor: the pass failed`', 'janitor', 'janitor: the pass failed'],
    // Ruling R56: an advert above its price ceiling.
    ['`above the ceiling of`', 'hireSelect', 'above the ceiling of ${ceiling} lovelace (${setting})'],
    // A buyer wallet in one output: that output is the collateral, and the float outside it is 0.
    ['`wallet check failed: The buyer wallet holds 0 lovelace outside its collateral`', 'orchestrate', 'The buyer wallet holds ${wallet.floatLovelace} lovelace outside its collateral, less than the ${needed} that ${jobs} need.'],
  ]) {
    assert.ok(table.includes(row), `the table quotes ${row}`);
    assert.ok(sources[where].includes(quote), `${where} prints ${quote}`);
  }
  for (const part of [
    '| The runtime restarts and its log says `missing required env var ADVERT_REF` |', '| `/capability` shows an empty public key, or claims fail with `wrong_supplier` |', '| Jobs fail with `service_unreachable` |',
    "`docker exec document-pipeline-agent printenv SERVICE_URL` must print `http://document-pipeline-service:9092/`", 'the interim `102 Processing` lines of step 13 are not arriving',
    '| The env file changed and nothing happened |', '| `network <name> declared as external, but could not be found` |', '| `required variable PROXY_NETWORK is missing a value` |', '| `invalid reference format` for the service image |',
    '| `No such image: sha256:...` for the service image |', "| The served `/agent.json` hashes differently from the advert's `detail_hash` |",
    '(max_pages + 1) * 4.5', '27 for five pages', 'No script of this pack signs with the buyer key',
    // The collateral is the smallest pure output of at least 5 units (collateralOf in packages/buyer-core/src/chain.ts), so a wallet in one output has no float.
    '| `/healthz` of the service answers 503 `insufficient_float` though the buyer wallet holds enough, and the log says `wallet check failed: The buyer wallet holds 0 lovelace outside its collateral` |',
    'The buyer wallet is in one output: it was supplied in one transfer, or a transaction gathered its outputs into one. The service takes the smallest pure output of at least 5 units as the collateral and counts only what is outside it as the float, so a single output, however large, leaves a float of 0.',
    'Add an output of exactly 5 units: ask the Foundation to send 5 units alone, as in step 6, or send 5 units from the buyer wallet to its own address, signed with the buyer key by the manual means of the `store_write_failed` row. The 5 units become the collateral and the rest is float again. The log says `wallet check passed again` within a minute.',
    'While it lasts, `docker ps` shows the service as unhealthy, because its health check is `/healthz`.',
    // The second choice of the chat supplier is held to the float as well, after the page escrows are settled (the residual round of R56).
    'Nothing was locked, unless the message says `The page escrows are settled`: then the chat supplier was chosen again after the pages, and its advert takes more than the float held then.',
    // R50 and the step that never replaces a key.
    '| Jobs fail with `service_http_401`, and the log of the service says ',
    'The runtime did not send the token the service holds: the two containers were created from different versions of the env file, or the line was changed after one of them started.',
    'Run the comparison at the end of step 13: its two lines must be the same.',
    'The service logs this refusal once a minute at most, with the count since the last line, and never what the caller sent.',
    '| The same, and the log says `environment variable SERVICE_AUTH_HEADER is required`, or says that it must be printable ASCII |',
    'The service does not start without a token, so that it can never answer anyone.',
    'Run the token block of step 4 (the first block of that step first, in a new shell, to define the function). It refuses while the line has a value',
    'Then refresh the offline copy of the env file, and recreate the service, and the runtime too if it is running (with `/status` saying `free`), so that both hold the same value.',
    '| The same, and the log says `environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required` | The buyer lines of the env file are empty: the buyer key block of step 4 was not run, or did not finish. |',
    'Run only the buyer key block of step 4 (the first block of that step first, in a new shell, to define the function; it leaves the file alone).',
    'while the address has received nothing',
    'Never run the whole step again, and never copy the example over the env file: that replaces keys that hold units. Then refresh the offline copy and recreate.',
    // Ruling R60, refined: what each 503 of a supplier says about its /status.
    '| Jobs fail with `ocr_supplier_unavailable` (503) | The allowlisted OCR supplier has no single Active advert that the indexer lists and the ledger confirms, or its `/capability` cannot be read or serves another key, or its `/status` says `offline` or cannot be read (the message says which). A supplier at work is hired: the send waits for it. Nothing was locked. |',
    '| Jobs fail with `llm_supplier_unavailable` (503) | No Active advert of a model on `LLM_MODEL_ALLOWLIST` has a supplier that serves the Responses API at `/capability` and says `free` or `working` at `/status`, within the 120 s of the selection. A supplier at work counts, and the send waits for it; an offline one does not. Usually nothing was locked:',
    '| The env file changed and nothing happened | `restart` does not re-read it. | Once the runtime runs (step 13), check first that `curl -s http://127.0.0.1:8084/status` says `free`: a recreate stops the container, and a stop during a job can cut a job under escrow. Before step 13 no job can run. Then `up -d --force-recreate <service>`, and both containers after a change to `SERVICE_AUTH_HEADER`. |',
    // The supplier block of step 4 refuses a line that has a value (C4): a wrong supplier line is restored from the offline copy, or, while the supplier
    // address has received nothing, emptied with its three companions and made again by that block alone.
    '| `/capability` shows an empty public key, or claims fail with `wrong_supplier` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. | Restore the four supplier lines from the offline copy of the env file (step 4), which holds them from one key, then recreate. Without a good copy, and only while the supplier address has received nothing, empty the four lines with `'
      + String.raw`sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline` + '` and run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function). The block refuses a line that has a value, so it never replaces a key that holds units. Then refresh the offline copy and recreate. |',
    '| The same, and the log says `is not the public key of SUPPLIER_PKH` | The line of the supplier public key holds another value, a private key by mistake. | Restore the four supplier lines from the offline copy of the env file, as in the `/capability` row above, then recreate. |',
  ]) assert.ok(table.includes(part), `the table has: ${part}`);
  assert.doesNotMatch(table, /Finish step 4/, 'the row that invited a second run of step 4 over keys that hold units');
  // The commands that empty a key or the token by hand are in the table, and are the ones the tests of step 4 run.
  for (const command of [String.raw`sed -i 's/^\(PIPELINE_BUYER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline`, `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.document-pipeline`]) assert.ok(table.includes('`' + command + '`'), command);
  // The codes are those the README of the agent lists, with the statuses it gives.
  for (const code of ['insufficient_float', 'ocr_supplier_unavailable', 'llm_supplier_unavailable', 'store_write_failed']) assert.ok(PREADME.includes('`' + code + '`'), `${code} is in the README of the agent`);
  assert.ok(PREADME.includes('| 503, the service cannot take a job now | `insufficient_float`, `ocr_supplier_unavailable`, `llm_supplier_unavailable`, and `shutting_down`'));
  assert.ok(PREADME.includes('| 500, the service | `store_write_failed`, and `internal` |'));
});

test('CI: the test job installs poppler-utils before the tests and sets REQUIRE_POPPLER on the test step, so that a failed install fails the real-renderer test instead of skipping it', () => {
  const steps = ci.jobs.test.steps;
  assert.equal(ci.jobs.test['runs-on'], 'self-hosted');
  const install = steps.findIndex((s) => typeof s.run === 'string' && /apt-get install -y poppler-utils/.test(s.run));
  const tests = steps.findIndex((s) => s.run === 'pnpm test');
  assert.ok(install >= 0, 'a step installs poppler-utils');
  assert.equal(steps[install].run, 'sudo apt-get update && sudo apt-get install -y poppler-utils ffmpeg');
  assert.ok(install < tests, 'before the tests');
  assert.equal(tests, steps.length - 1, 'pnpm test is the last step');
  assert.equal(String(steps[tests].env?.REQUIRE_POPPLER), '1');
  // Only the value CI sets requires the tools: a REQUIRE_POPPLER of 0 or of an empty string asks for nothing.
  assert.match(read('agents/document-pipeline/test/render.test.ts'), /test\.skipIf\(process\.env\.REQUIRE_POPPLER !== '1'\)\('REQUIRE_POPPLER is set: pdftoppm and pdfinfo are installed'/);
  assert.ok(steps.findIndex((s) => s.run === 'pnpm typecheck') < tests);
});

test('CI: the publish job also pushes the Document Pipeline image under :latest and :<sha>, in the same job and so with the same conditions, after the same login', () => {
  const job = ci.jobs.publish;
  assert.equal(job.needs, 'test');
  assert.match(job.if, /github\.event_name == 'push'/);
  assert.match(job.if, /github\.ref == 'refs\/heads\/main'/);
  const builds = job.steps.filter((s) => s.uses === 'docker/build-push-action@v6');
  const history = builds.find((s) => s.with.file === 'agents/agent-history/Dockerfile');
  const pipeline = builds.find((s) => s.with.file === 'agents/document-pipeline/Dockerfile');
  assert.ok(history && pipeline);
  assert.ok(existsSync(join(root, pipeline.with.file)));
  assert.equal(pipeline.with.context, '.');
  assert.equal(pipeline.with.push, true);
  const image = pService.image.replace(/@sha256:.*$/, ''); // the compose file names the image by digest; CI pushes the two tags of the same repository
  assert.equal(image, 'ghcr.io/apex-fusion/vector-service-agents/document-pipeline');
  assert.deepEqual(pipeline.with.tags.trim().split('\n'), [`${image}:latest`, `${image}:\${{ github.sha }}`]);
  assert.equal(pipeline.with.labels, history.with.labels);
  assert.equal(pipeline.if, history.if, 'no condition of its own: the conditions are the job\'s');
  const login = job.steps.findIndex((s) => s.uses === 'docker/login-action@v3');
  assert.ok(login >= 0 && login < job.steps.indexOf(history) && login < job.steps.indexOf(pipeline), 'one login before both builds');
  assert.ok(job.steps.indexOf(history) < job.steps.indexOf(pipeline), 'Agent History first, as before');
  assert.deepEqual(job.permissions, { contents: 'read', packages: 'write' });
  assert.ok(readme.includes('`ghcr.io/apex-fusion/vector-service-agents/document-pipeline`') && pSection.includes('`:latest`') && pSection.includes('`:<full git commit sha>`'), 'the host administrator is told the two tags');
});

// ======================================================================================================================================
// The deployment host is not named. Its name, the stack of its reverse proxy and the other stacks it runs stay out of the repository: the folder is
// deploy/host, the external network is PROXY_NETWORK in .env next to the compose files, the paths on the box are BASE (and HISTORY_BASE) of the runbooks,
// and the existing identity scripts are named by the operator in step 5 of RUNBOOK.md.
// ======================================================================================================================================

test('the network: both compose files name it by PROXY_NETWORK, compose reads it from .env and not from the env files of the stacks, and both runbooks write .env in step 1, before the first compose command', () => {
  assert.match(PROXY_NETWORK_NAME, /^\$\{PROXY_NETWORK:\?[^{}]+\}$/, 'the required form: unset or empty stops every command with the message');
  for (const [rel, model] of [['deploy/host/docker-compose.agent-history.yml', compose], ['deploy/host/docker-compose.document-pipeline.yml', pCompose]]) {
    const text = read(rel);
    assert.deepEqual(model.networks, { proxy: { external: true, name: PROXY_NETWORK_NAME } }, rel);
    for (const s of Object.values(model.services)) assert.deepEqual(s.networks, ['proxy'], rel);
    assert.deepEqual(text.match(/\$\{[^}]*\}?/g), [PROXY_NETWORK_NAME], `${rel}: the one interpolation in the file`);
    assert.ok(text.includes('The name of that network is not in the repository: compose reads PROXY_NETWORK from .env next to this file'), `${rel}: the comment says where the name comes from`);
  }
  // Compose fills ${...} from the shell and from .env in the folder of the compose file. The env files of the stacks only fill the containers, and the
  // env file does not exist before step 4, while step 3 builds with compose: so the name is in .env, and the examples say so instead of carrying it.
  for (const [name, text, book, file] of [['Agent History', exampleText, runbook, 'RUNBOOK.md'], ['Document Pipeline', pExampleText, pRunbook, 'RUNBOOK-document-pipeline.md']]) {
    assert.equal(/^PROXY_NETWORK=/m.test(text), false, `${name}: the env example does not carry the name, compose would not read it there`);
    assert.ok(text.includes(`\n# The external network of the host's reverse proxy is not named here: compose reads PROXY_NETWORK from .env next to the compose file (${file} step 1).\n`), `${name}: the example points at .env`);
    const one = section(book, '1. Put the files on the box');
    assert.ok(one.includes("```sh\necho 'PROXY_NETWORK=<the network the host administrator names>' > .env\ndocker network inspect --format '{{.Name}}' \"$(sed -n 's/^PROXY_NETWORK=//p' .env)\"\n```"), `${name}: step 1 writes .env and checks that the network exists`);
    assert.ok(one.includes('The second line must print the name back. An error means that this host has no network of that name.'), name);
    assert.ok(book.indexOf("' > .env\n") > 0 && book.indexOf("' > .env\n") < book.indexOf('docker compose -f '), `${name}: before the first compose command`);
    assert.ok(section(book, 'If something goes wrong').includes('| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |'), `${name}: the failure table has the refusal`);
    assert.doesNotMatch(book, /`network [a-z0-9_.-]+ declared as external/, `${name}: the failure table names no network`);
  }
  // .env holds no secret, but it is the host's: it never enters git or a build context.
  assert.ok(read('.gitignore').split('\n').includes('.env'));
  assert.ok(read('.dockerignore').split('\n').includes('**/.env'));
  assert.ok(readme.includes('Its name is not in the repository: compose reads it as `PROXY_NETWORK` from `.env` next to the compose file, which the operator writes in step 1 of the runbook with the name the host administrator gives, and compose stops while it has no value.'));
});

const HAVE_COMPOSE = (() => { try { execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 30_000 }); return true; } catch { return false; } })();
test('the network in docker compose config: with PROXY_NETWORK in .env the external network has that name, and with no .env or an empty value compose stops and says where to set it', { skip: HAVE_COMPOSE ? false : 'needs docker compose' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-network-'));
  // A PROXY_NETWORK of the shell would win over .env, so the runs here have none.
  const { PROXY_NETWORK: _shell, ...env } = process.env;
  try {
    for (const f of ['docker-compose.agent-history.yml', 'docker-compose.document-pipeline.yml']) copyFileSync(join(root, 'deploy/host', f), join(dir, f));
    // Both compose files require their env file; the examples stand in for them, since compose reads them for the containers only.
    copyFileSync(join(root, 'deploy/host/.env.agent-history.example'), join(dir, '.env.agent-history'));
    copyFileSync(join(root, 'deploy/host/.env.document-pipeline.example'), join(dir, '.env.document-pipeline'));
    const config = (file) => spawnSync('docker', ['compose', '-f', file, 'config'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    for (const file of ['docker-compose.agent-history.yml', 'docker-compose.document-pipeline.yml']) {
      rmSync(join(dir, '.env'), { force: true });
      for (const dotenv of [null, 'PROXY_NETWORK=\n']) {
        if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv);
        const refused = config(file);
        assert.notEqual(refused.status, 0, `${file}: compose stops with ${dotenv === null ? 'no .env' : 'an empty value'}`);
        assert.ok(refused.stderr.includes('set PROXY_NETWORK in .env next to this compose file'), `${file}: and says where to set it: ${refused.stderr}`);
      }
      writeFileSync(join(dir, '.env'), 'PROXY_NETWORK=test_proxy_network\n');
      const run = config(file);
      assert.equal(run.status, 0, `${file}: ${run.stderr}`);
      const model = parseYaml(run.stdout);
      assert.deepEqual(model.networks, { proxy: { name: 'test_proxy_network', external: true } }, file);
      for (const [name, s] of Object.entries(model.services)) assert.deepEqual(Object.keys(s.networks), ['proxy'], `${file}: ${name}`);
      assert.equal(run.stdout.includes('PROXY_NETWORK'), false, `${file}: the name goes to the network, not into a container`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Step 5 of both runbooks, run in bash ----
// The copy of Agent History is made from the operator's existing identity scripts, which the repository does not name: its block opens with three settings
// for them. Stand-ins for the six scripts carry the folder, the env file, the label and the registry record of the agent they were written for. The copy of
// Agent History is made from them by the block of RUNBOOK.md, the copy of the Pipeline from that copy by the block of RUNBOOK-document-pipeline.md, and each
// copy must hold its own paths and values and nothing of what it was made from.
test('step 5 of both runbooks in bash: the copy of Agent History is made from stand-ins for the existing identity scripts, the copy of the Pipeline from it, and each holds only its own paths and values', NEEDS_BASH, () => {
  const ahBlock = /```sh\n([\s\S]*?)```/.exec(section(runbook, '5. Adapt the ops scripts'))?.[1] ?? '';
  const dpBlock = /```sh\n([\s\S]*?)```/.exec(section(pRunbook, '5. Adapt the ops scripts'))?.[1] ?? '';
  const SETTINGS = ['SRC=<the folder of the existing identity scripts>\n', 'SRC_ENV=<the env file those scripts read>\n', 'SRC_LABEL=<the supplier name in make-skey.py>\n'];
  assert.ok(ahBlock.startsWith(SETTINGS.join('')), 'the block of Agent History opens with the three settings the operator fills');
  assert.ok(dpBlock.startsWith('mkdir -p "$BASE/ops" && cd "$BASE/ops"\n'), 'the block of the Pipeline needs only BASE and HISTORY_BASE');
  const dir = mkdtempSync(join(tmpdir(), 'ops-step5-'));
  try {
    const at = (...parts) => [dir.split(sep).join('/'), ...parts].join('/');
    // The base paths have the shape the runbooks give them, so that the check of the Pipeline for a name of Agent History left in its copy has something to find.
    const AH = at('opt', 'agent-history');
    const DP = at('opt', 'document-pipeline');
    const SRC = at('existing', 'ops');
    const SRC_ENV = at('existing', 'supplier', '.env.existing');
    const LABEL = 'existing supplier';
    mkdirSync(join(dir, 'existing', 'ops'), { recursive: true });
    const header = `# the scripts of ${SRC}, for the env file ${SRC_ENV}\n`;
    const stand = {
      'setup-venv.sh': `#!/bin/sh\n${header}echo "venv ok"\n`,
      'make-skey.py': `${header}KEY_DESCRIPTION = "${LABEL} payment key"\nWALLET = "${SRC}/wallet"\n`,
      'mcp-call.sh': `#!/bin/sh\n${header}`,
      'sign-tx.py': header,
      'register-did.sh': `#!/bin/sh\n${header}. ${SRC_ENV}\nBODY='{\n "name":"Existing Agent",\n "description":"What the existing agent does.",\n "capabilities":["existing.capability.v1"],\n "framework":"existing-framework",\n "endpoint":"https://existing.example"}'\n`,
      'm3-self-stake.py': `${header}CAPABILITIES = ["existing.capability.v1"]\n`,
    };
    for (const [name, text] of Object.entries(stand)) writeFileSync(join(dir, 'existing', 'ops', name), text);
    const copyOf = (base) => Object.fromEntries(Object.keys(stand).map((name) => [name, readFileSync(`${base}/ops/${name}`, 'utf8')]));
    const descOf = (book) => /^DESC="(.+)"$/m.exec(section(book, '5. Adapt the ops scripts'))[1];
    const record = (copy, values) => { for (const line of values) assert.ok(copy['register-did.sh'].includes(line + '\n') || copy['register-did.sh'].includes(line + "'"), `register-did.sh has ${line}`); };

    const filled = ahBlock.replace(SETTINGS[0], `SRC='${SRC}'\n`).replace(SETTINGS[1], `SRC_ENV='${SRC_ENV}'\n`).replace(SETTINGS[2], `SRC_LABEL='${LABEL}'\n`);
    const ah = runBash(`set -e\nBASE='${AH}'\n${filled}`, dir);
    assert.equal(ah.status, 0, ah.stderr);
    assert.match(ah.stdout, /venv ok/, 'setup-venv.sh of the copy ran');
    const ahCopy = copyOf(AH);
    const ahText = Object.values(ahCopy).join('\n');
    for (const gone of [SRC, SRC_ENV, LABEL, 'Existing Agent', 'What the existing agent does.', 'existing.capability.v1', 'existing-framework', 'https://existing.example']) assert.equal(ahText.includes(gone), false, `the copy of Agent History keeps nothing of the scripts it was made from: ${gone}`);
    record(ahCopy, [' "name":"Agent History",', ` "description":"${descOf(runbook)}",`, ' "capabilities":["identity.history.report.v1"],', ' "framework":"vector-service-agents",', ' "endpoint":"https://mp-suppliers-history.hal8.ai"}']);
    assert.ok(ahCopy['m3-self-stake.py'].includes('CAPABILITIES = ["identity.history.report.v1"]\n'));
    assert.ok(ahCopy['make-skey.py'].includes('KEY_DESCRIPTION = "agent-history supplier payment key"\n') && ahCopy['make-skey.py'].includes(`WALLET = "${AH}/ops/wallet"\n`));
    assert.ok(ahCopy['register-did.sh'].includes(`. ${AH}/repo/deploy/host/.env.agent-history\n`), 'the scripts read the env file of Agent History');

    const dp = runBash(`BASE='${DP}'\nHISTORY_BASE='${AH}'\n${dpBlock}`, dir);
    assert.equal(dp.stderr, '');
    assert.equal(dp.status, 1, 'the last grep, for a name of Agent History, finds nothing');
    assert.doesNotMatch(dp.stdout, /^[\w-]+\.(sh|py)$/m, 'and prints no file');
    const dpCopy = copyOf(DP);
    assert.equal(/agent.history/i.test(Object.values(dpCopy).join('\n')), false, 'nothing of Agent History is left in the copy of the Pipeline');
    record(dpCopy, [' "name":"Document Pipeline",', ` "description":"${descOf(pRunbook)}",`, ' "capabilities":["document.pipeline.ocr-summary.v1"],', ' "framework":"vector-service-agents",', ' "endpoint":"https://mp-suppliers-pipeline.hal8.ai"}']);
    assert.ok(dpCopy['m3-self-stake.py'].includes('CAPABILITIES = ["document.pipeline.ocr-summary.v1"]\n'));
    assert.ok(dpCopy['make-skey.py'].includes('KEY_DESCRIPTION = "document-pipeline supplier payment key"\n') && dpCopy['make-skey.py'].includes(`WALLET = "${DP}/ops/wallet"\n`));
    assert.ok(dpCopy['register-did.sh'].includes(`. ${DP}/repo/deploy/host/.env.document-pipeline\n`), 'the scripts read the env file of the Pipeline');
    assert.deepEqual(copyOf(AH), ahCopy, 'the copy of Agent History is left as it was');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the paths on the box: each runbook sets its base paths once, at the top, as folders the operator chooses, and every path on the box below goes through them', () => {
  for (const [name, book, block] of [['Agent History', runbook, '```sh\nBASE=/opt/agent-history\n```'], ['Document Pipeline', pRunbook, '```sh\nBASE=/opt/document-pipeline\nHISTORY_BASE=/opt/agent-history\n```']]) {
    const top = book.slice(0, book.indexOf('\n## Collateral and float\n'));
    assert.ok(top.includes(block), `${name}: the variables are set at the top`);
    assert.equal(book.split('/opt/').length, block.split('/opt/').length, `${name}: no other absolute path on the box`);
    assert.ok(book.indexOf(block) < book.indexOf('"$BASE'), `${name}: before the first command that uses them`);
  }
  assert.ok(runbook.includes('The commands on the box use `BASE`: the folder the operator chose for this agent, with the checkout of this repository in `repo` and the ops scripts in `ops`. Any path works. Set it in every new shell on the box before the commands below:'));
  assert.ok(pRunbook.includes('The commands use the two base paths as variables. Set both in every new shell on the box before the commands below:'));
  // The note of the host administrator gives the folder as a placeholder, and the copy of Agent History names its source in three settings that the operator fills.
  assert.equal(readme.includes('/opt/'), false);
  assert.ok(section(runbook, '5. Adapt the ops scripts').includes("Operator. The identity steps use the operator's existing identity scripts (registration, stake, signing), kept outside the repository."));
});

// The host, the stack of its reverse proxy, the other stacks it runs (the activity decoder by its container on the host), a login and a key file.
// Built from parts, so that this file does not hold them either. No public hostname is among them: not the adverts', the indexer's or the hosted
// server's, and not the public hostname of the activity decoder, which the design spec names. Its container on the host is.
const HOST_WORDS = new RegExp(['apex' + '-web', 'uma' + 'mi', 'chandra' + '-supplier', 'activity' + '-api-mainnet', 'vector-agent' + '-dashboard', 'module3' + '-', 'module6' + '-', 'hetz' + 'ner', 'root' + '@', 'id_' + 'ed25519'].join('|'), 'i');
const TRACKED = (() => { try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return null; } })();
test('the deployment host is not named: no tracked file names it, the stack of its reverse proxy, its other stacks, a login or a key file', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  const files = TRACKED.filter((f) => f !== 'pnpm-lock.yaml' && !/\.(pdf|png)$/.test(f) && existsSync(join(root, f)));
  assert.ok(files.length > 150 && files.includes('deploy/host/RUNBOOK.md') && files.includes('docs/superpowers/specs/2026-10-13-vector-service-agents-design.md'), `the walk reaches every tracked file, found ${files.length}`);
  assert.deepEqual(files.filter((f) => HOST_WORDS.test(read(f))), []);
  for (const hit of ['the apex' + '-web box', 'uma' + 'mi_default', '/opt/chandra' + '-supplier/ops', 'docker logs activity' + '-api-mainnet']) assert.match(hit, HOST_WORDS, hit);
  for (const miss of ['mp-suppliers-history.hal8.ai', 'mp-suppliers-chandra.hal8.ai', 'ChandraOCR', 'mp-indexer.vector.apexfusion.org', 'https://activity' + '-api.vector.apexfusion.org', 'deploy/host']) assert.doesNotMatch(miss, HOST_WORDS, miss);
  // No public hostname that a tracked file names trips a pattern.
  const hostnames = new Set(files.flatMap((f) => read(f).match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:org|ai|io|com|net|dev|xyz)\b/gi) ?? []));
  assert.ok(hostnames.has('activity' + '-api.vector.apexfusion.org') && hostnames.has('mp-indexer.vector.apexfusion.org'), 'the scan finds the public hostnames');
  assert.deepEqual([...hostnames].filter((name) => HOST_WORDS.test(name)), []);
});

// ======================================================================================================================================
// The runtimes of the four agents on the template commit a05564c: the agent card, its route in Caddy, and the two settings that stay unset.
// From that commit the runtime serves GET /.well-known/agent-card.json, and a 200 on GET /, when PUBLIC_ORIGIN is set. The compose file of each agent sets it for the
// runtime: the https origin of the host that the agent record and the advert name as the endpoint, and that Caddy serves. The runtime stops at boot on a value that is not
// an https origin, so these tests hold the value before a host takes it. The check of the escrow against the advert, before the Claim, and the six context headers have no
// setting: every job gets them. SERVICE_PRECHECK_URL and RELEASE_WATCHER stay unset, so that the card and that check are all that changes for the four agents.
// ======================================================================================================================================
const CARD_PATH = '/.well-known/agent-card.json';
const CARD_STACKS = [
  ['Agent History', 'docker-compose.agent-history.yml', 'Caddyfile.snippet', '.env.agent-history.example', 'mp-suppliers-history.hal8.ai'],
  ['Document Pipeline', 'docker-compose.document-pipeline.yml', 'Caddyfile.document-pipeline.snippet', '.env.document-pipeline.example', 'mp-suppliers-pipeline.hal8.ai'],
  ['Audio Snippets', 'docker-compose.audio-snippets.yml', 'Caddyfile.audio-snippets.snippet', '.env.audio-snippets.example', 'mp-suppliers-snippets.hal8.ai'],
  ['Advocate', 'docker-compose.advocate.yml', 'Caddyfile.advocate.snippet', '.env.advocate.example', 'mp-suppliers-advocate.hal8.ai'],
].map(([name, composeFile, snippetFile, exampleFile, host]) => ({
  name, host, composeFile, snippetFile, exampleFile,
  compose: parseYaml(read(`deploy/host/${composeFile}`)), snippet: read(`deploy/host/${snippetFile}`), example: read(`deploy/host/${exampleFile}`),
}));
/** The environment of a compose service as a map, whether the file writes it as a map or as a list of NAME=value entries. */
const runtimeEnvironment = (service) => {
  const environment = service?.environment ?? {};
  return Array.isArray(environment) ? Object.fromEntries(environment.map((entry) => [entry.split('=')[0], entry.split('=').slice(1).join('=')])) : environment;
};
/** The host of the site block of a Caddy snippet, and its handle blocks: the matcher of each (null when it has none) and its upstream. */
function snippetRoutes(text) {
  const lines = text.split('\n');
  const block = lines.slice(lines.findIndex((l) => !l.startsWith('#') && l.trim() !== '')).join('\n');
  return {
    host: /^(\S+) \{$/m.exec(block)?.[1],
    handles: [...block.matchAll(/^    handle(?: (\S+))? \{\n        reverse_proxy (\S+)\n    \}$/gm)].map(([, matcher = null, upstream]) => ({ matcher, upstream })),
  };
}
/** What is wrong with the public origin of a runtime: nothing, when the list is empty. */
function cardOriginProblems({ compose, snippet, example, host }) {
  const value = runtimeEnvironment(compose.services?.agent).PUBLIC_ORIGIN;
  if (typeof value !== 'string' || value === '') return ['the runtime has no PUBLIC_ORIGIN'];
  let url;
  try { url = new URL(value); } catch { return [`PUBLIC_ORIGIN is not a URL: ${value}`]; }
  const problems = [];
  if (url.protocol !== 'https:') problems.push(`PUBLIC_ORIGIN is not https: ${value}`);
  else if (value !== url.origin) problems.push(`PUBLIC_ORIGIN is not an origin with no path, query, fragment, user name or closing slash: ${value}`);
  const caddyHost = snippetRoutes(snippet).host;
  const endpointHost = new URL(parseEnv(example).ADVERT_ENDPOINT_URL).host;
  if ([caddyHost, endpointHost, host].some((other) => other !== url.host)) {
    problems.push(`PUBLIC_ORIGIN has the host ${url.host}: the host of the Caddy block is ${caddyHost}, that of ADVERT_ENDPOINT_URL is ${endpointHost} and that of the agent is ${host}`);
  }
  if ('PUBLIC_ORIGIN' in runtimeEnvironment(compose.services?.service)) problems.push('the service has PUBLIC_ORIGIN: only the runtime serves the card');
  return problems;
}
/** The upstream that Caddy gives a path: the handle with that exact path (the match is exact, and the case of the letters does not count), else the handle with no matcher. */
const upstreamOf = (routes, path) => (routes.handles.find((h) => h.matcher !== null && h.matcher.toLowerCase() === path.toLowerCase()) ?? routes.handles.find((h) => h.matcher === null))?.upstream;
/** What is wrong with the routes of a Caddy block: the card, GET / and the job route that the card names go to the runtime, and /agent.json goes to the service. */
function cardRouteProblems(snippet, { runtime, service }) {
  const routes = snippetRoutes(snippet);
  const problems = [];
  for (const { matcher } of routes.handles) {
    if (matcher !== null && !/^\/([A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)?$/.test(matcher)) problems.push(`the matcher ${matcher} is not an exact path: this check does not read it`);
  }
  for (const [path, upstream, who] of [['/', runtime, 'the runtime'], [CARD_PATH, runtime, 'the runtime'], ['/v1/job', runtime, 'the runtime'], ['/agent.json', service, 'the service']]) {
    const got = upstreamOf(routes, path);
    if (got !== upstream) problems.push(`${path} goes to ${got ?? 'nobody'}, not to ${who} (${upstream})`);
  }
  return problems;
}
const UNSET_SETTINGS = ['SERVICE_PRECHECK_URL', 'RELEASE_WATCHER'];
/** The places where a compose file or an env example sets one of the two settings, for any container: a key of its environment, or a line NAME=value in an example. */
function unsetSettingProblems(composes, examples) {
  const problems = [];
  for (const [file, doc] of composes) {
    for (const [container, service] of Object.entries(doc.services ?? {})) {
      for (const name of UNSET_SETTINGS) if (name in runtimeEnvironment(service)) problems.push(`${file}: ${container} sets ${name}`);
    }
  }
  for (const [file, text] of examples) {
    for (const line of text.split('\n')) {
      const name = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line)?.[1];
      if (UNSET_SETTINGS.includes(name)) problems.push(`${file}: sets ${name}`);
    }
  }
  return problems;
}

test('the four runtimes: each compose file sets PUBLIC_ORIGIN for the runtime, as the https origin of its public host, the host that its Caddy block serves and that its advert names as the endpoint', () => {
  assert.equal(CARD_STACKS.length, 4);
  for (const stack of CARD_STACKS) {
    assert.deepEqual(cardOriginProblems(stack), [], stack.name);
    assert.equal(stack.compose.services.agent.environment.PUBLIC_ORIGIN, `https://${stack.host}`, stack.name);
  }
  assert.equal(new Set(CARD_STACKS.map((stack) => stack.compose.services.agent.environment.PUBLIC_ORIGIN)).size, 4, 'four runtimes, four origins');
});

test('the origin guard refuses a runtime with no origin, a value that is no URL, one that is not https, one with a path or a closing slash, a host other than the Caddy block, the endpoint or the agent has, and an origin on the service; each has an accepted twin', () => {
  const [base] = CARD_STACKS;
  const origin = `https://${base.host}`;
  const problemsOf = (change, snippet = base.snippet, example = base.example) => {
    const compose = structuredClone(base.compose);
    change(compose.services);
    return cardOriginProblems({ ...base, compose, snippet, example });
  };
  const hostMessage = (host, caddy = base.host, endpoint = base.host) => `PUBLIC_ORIGIN has the host ${host}: the host of the Caddy block is ${caddy}, that of ADVERT_ENDPOINT_URL is ${endpoint} and that of the agent is ${base.host}`;
  const NOT_AN_ORIGIN = (value) => `PUBLIC_ORIGIN is not an origin with no path, query, fragment, user name or closing slash: ${value}`;
  assert.deepEqual(problemsOf(() => {}), [], 'the twin: the file as it is');
  assert.deepEqual(problemsOf((s) => { s.agent.environment = Object.entries(s.agent.environment).map(([key, value]) => `${key}=${value}`); }), [], 'the twin: the same environment written as a list');
  assert.deepEqual(problemsOf((s) => { delete s.agent.environment.PUBLIC_ORIGIN; }), ['the runtime has no PUBLIC_ORIGIN'], 'no origin');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = ''; }), ['the runtime has no PUBLIC_ORIGIN'], 'an empty origin');
  assert.deepEqual(problemsOf((s) => { s.agent.environment = Object.entries(s.agent.environment).filter(([key]) => key !== 'PUBLIC_ORIGIN').map(([key, value]) => `${key}=${value}`); }), ['the runtime has no PUBLIC_ORIGIN'], 'no origin, in the list form');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = base.host; }), [`PUBLIC_ORIGIN is not a URL: ${base.host}`], 'a host with no scheme');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `http://${base.host}`; }), [`PUBLIC_ORIGIN is not https: http://${base.host}`], 'http');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `${origin}/v1/job`; }), [NOT_AN_ORIGIN(`${origin}/v1/job`)], 'a path');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `${origin}/`; }), [NOT_AN_ORIGIN(`${origin}/`)], 'a closing slash');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `${origin}?x=1`; }), [NOT_AN_ORIGIN(`${origin}?x=1`)], 'a query');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `https://user@${base.host}`; }), [NOT_AN_ORIGIN(`https://user@${base.host}`)], 'a user name');
  const other = CARD_STACKS[1].host;
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = `https://${other}`; }), [hostMessage(other)], 'the host of another agent');
  assert.deepEqual(problemsOf(() => {}, base.snippet.split(`${base.host} {`).join(`${other} {`)), [hostMessage(base.host, other)], 'a Caddy block that serves another host');
  assert.deepEqual(problemsOf(() => {}, base.snippet, base.example.split(`ADVERT_ENDPOINT_URL=${origin}\n`).join(`ADVERT_ENDPOINT_URL=https://${other}\n`)), [hostMessage(base.host, base.host, other)], 'an advert that names another endpoint');
  assert.deepEqual(problemsOf((s) => { s.service.environment.PUBLIC_ORIGIN = origin; }), ['the service has PUBLIC_ORIGIN: only the runtime serves the card'], 'an origin on the service');
});

test('Caddy: in the block of each agent the card, GET / and the job route that the card names go to the runtime, and only /agent.json goes to the service', () => {
  for (const stack of CARD_STACKS) {
    const { agent, service } = stack.compose.services;
    const targets = { runtime: `${agent.container_name}:${agent.environment.PORT}`, service: `${service.container_name}:${service.environment.PORT}` };
    assert.deepEqual(cardRouteProblems(stack.snippet, targets), [], stack.name);
    // What Caddy 2 answers for the real block (read with the upstreams replaced by an answer that names them): the match of a path is exact and does not count the case of the letters.
    const routes = snippetRoutes(stack.snippet);
    const table = [['/', 'runtime'], [CARD_PATH, 'runtime'], ['/agent.json', 'service'], ['/AGENT.JSON', 'service'], ['/agent.json/', 'runtime'], ['/v1/job', 'runtime'], ['/healthz', 'runtime']];
    for (const [path, who] of table) assert.equal(upstreamOf(routes, path), targets[who], `${stack.name}: ${path}`);
  }
});

test('the route guard refuses a block that sends the card, GET / or the job route to the service, a block with no default route and a matcher that it cannot read; each has an accepted twin', () => {
  const [{ snippet, compose, host }] = CARD_STACKS;
  const { agent, service } = compose.services;
  const targets = { runtime: `${agent.container_name}:${agent.environment.PORT}`, service: `${service.container_name}:${service.environment.PORT}` };
  const toRuntime = `reverse_proxy ${targets.runtime}`;
  const toService = `reverse_proxy ${targets.service}`;
  assert.equal(snippet.split(toRuntime).length - 1, 1, 'the default route of the block, the one that the guards below change');
  assert.deepEqual(cardRouteProblems(snippet, targets), [], 'the twin: the block as it is');
  const allToService = snippet.split(toRuntime).join(toService);
  assert.deepEqual(cardRouteProblems(allToService, targets), [
    `/ goes to ${targets.service}, not to the runtime (${targets.runtime})`,
    `${CARD_PATH} goes to ${targets.service}, not to the runtime (${targets.runtime})`,
    `/v1/job goes to ${targets.service}, not to the runtime (${targets.runtime})`,
  ], 'a default route to the service');
  const withHandle = (matcher, upstream) => snippet.split('    handle {\n').join(`    handle ${matcher} {\n        reverse_proxy ${upstream}\n    }\n    handle {\n`);
  assert.deepEqual(cardRouteProblems(withHandle(CARD_PATH, targets.service), targets), [`${CARD_PATH} goes to ${targets.service}, not to the runtime (${targets.runtime})`], 'the card to the service');
  assert.deepEqual(cardRouteProblems(withHandle('/', targets.service), targets), [`/ goes to ${targets.service}, not to the runtime (${targets.runtime})`], 'GET / to the service');
  assert.deepEqual(cardRouteProblems(withHandle('/v1/job', targets.service), targets), [`/v1/job goes to ${targets.service}, not to the runtime (${targets.runtime})`], 'the job route to the service');
  assert.deepEqual(cardRouteProblems(withHandle('/.well-known/*', targets.service), targets), ['the matcher /.well-known/* is not an exact path: this check does not read it'], 'a wildcard matcher');
  assert.deepEqual(cardRouteProblems(withHandle('@card', targets.service), targets), ['the matcher @card is not an exact path: this check does not read it'], 'a named matcher');
  assert.deepEqual(cardRouteProblems(withHandle('/agent.json', targets.service), targets), [], 'the twin: a second handle for /agent.json that goes to the service changes no answer');
  const noDefault = snippet.split(`    handle {\n        ${toRuntime}\n    }\n`).join('');
  assert.notEqual(noDefault, snippet, 'the default route is cut');
  assert.deepEqual(cardRouteProblems(noDefault, targets), [
    `/ goes to nobody, not to the runtime (${targets.runtime})`,
    `${CARD_PATH} goes to nobody, not to the runtime (${targets.runtime})`,
    `/v1/job goes to nobody, not to the runtime (${targets.runtime})`,
  ], 'no default route');
  const noService = snippet.split(`    handle /agent.json {\n        ${toService}\n    }\n`).join('');
  assert.notEqual(noService, snippet, 'the route of the manifest is cut');
  assert.deepEqual(cardRouteProblems(noService, targets), [`/agent.json goes to ${targets.runtime}, not to the service (${targets.service})`], 'the manifest to the runtime');
  assert.equal(snippetRoutes(snippet).host, host);
});

test('the four stacks leave SERVICE_PRECHECK_URL and RELEASE_WATCHER unset: no compose file and no env example of deploy/host sets either, for any container', () => {
  const names = readdirSync(join(root, 'deploy', 'host'));
  const composes = names.filter((f) => /^docker-compose\..+\.yml$/.test(f)).map((f) => [f, parseYaml(read(`deploy/host/${f}`))]);
  const examples = names.filter((f) => /^\.env\..+\.example$/.test(f)).map((f) => [f, read(`deploy/host/${f}`)]);
  assert.deepEqual([composes.length, examples.length], [4, 4], 'the scan reaches the four compose files and the four env examples');
  assert.deepEqual(unsetSettingProblems(composes, examples), []);
});

test('the unset guard refuses either setting in the environment of a container (as a map or as a list, empty or not) and on a line of an example, and accepts the twin of each', () => {
  const [{ compose, example, composeFile, exampleFile }] = CARD_STACKS;
  const problemsOf = (change, text = example) => {
    const copy = structuredClone(compose);
    change(copy.services);
    return unsetSettingProblems([[composeFile, copy]], [[exampleFile, text]]);
  };
  assert.deepEqual(problemsOf(() => {}), [], 'the twin: the files as they are');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.PUBLIC_ORIGIN = 'https://example.test'; s.service.environment.PORT = '9091'; }), [], 'the twin: other settings change nothing');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.RELEASE_WATCHER = '1'; }), [`${composeFile}: agent sets RELEASE_WATCHER`], 'the watcher on the runtime');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.RELEASE_WATCHER = ''; }), [`${composeFile}: agent sets RELEASE_WATCHER`], 'the watcher, empty');
  assert.deepEqual(problemsOf((s) => { s.agent.environment.SERVICE_PRECHECK_URL = 'http://agent-history-service:9091/precheck'; }), [`${composeFile}: agent sets SERVICE_PRECHECK_URL`], 'the hook on the runtime');
  assert.deepEqual(problemsOf((s) => { s.service.environment.SERVICE_PRECHECK_URL = ''; }), [`${composeFile}: service sets SERVICE_PRECHECK_URL`], 'the hook on the service');
  assert.deepEqual(problemsOf((s) => { s.agent.environment = ['CAPABILITY_KIND=custom', 'RELEASE_WATCHER=1']; }), [`${composeFile}: agent sets RELEASE_WATCHER`], 'the watcher in the list form');
  assert.deepEqual(problemsOf((s) => { s.agent.environment = ['CAPABILITY_KIND=custom', 'SERVICE_PRECHECK_URL']; }), [`${composeFile}: agent sets SERVICE_PRECHECK_URL`], 'the hook passed through from the shell');
  assert.deepEqual(problemsOf(() => {}, `${example}SERVICE_PRECHECK_URL=\n`), [`${exampleFile}: sets SERVICE_PRECHECK_URL`], 'the hook on a line of the example, empty');
  assert.deepEqual(problemsOf(() => {}, `${example}RELEASE_WATCHER=1\n`), [`${exampleFile}: sets RELEASE_WATCHER`], 'the watcher on a line of the example');
  assert.deepEqual(problemsOf(() => {}, `${example}# RELEASE_WATCHER=1 is not set here\n`), [], 'the twin: a comment that names the setting sets nothing');
});

// ---- The release steps: each runbook has a section for taking a new runtime commit -----------------------------------------------------
// A host takes a new commit of the runtime by a pull of its checkout, a build of the runtime image and a new runtime container. The pin of the service image is the one local
// change of the checkout (step 2 of each runbook), so the block that pulls puts it aside and back. The runtime keeps its jobs in memory: it is created again only while /status says free.
const RELEASE_TITLE = 'Take a new runtime commit';
const RELEASE_BOOKS = [
  [0, 'RUNBOOK.md', 'git pull --ff-only'],
  [1, 'RUNBOOK-document-pipeline.md', 'git pull --ff-only /tmp/vector-service-agents.bundle main'],
  [2, 'RUNBOOK-audio-snippets.md', 'git pull --ff-only /tmp/vector-service-agents.bundle main'],
  [3, 'RUNBOOK-advocate.md', 'git pull --ff-only /tmp/vector-service-agents.bundle main'],
].map(([stack, file, pull]) => {
  const { name, host, composeFile, compose, example, exampleFile } = CARD_STACKS[stack];
  const { agent, service } = compose.services;
  return {
    name, host, file, pull, composeFile, container: agent.container_name, port: agent.ports[0].split(':')[1], envFile: exampleFile.replace(/\.example$/, ''),
    image: /^ghcr\.io\/apex-fusion\/vector-service-agents\/([a-z-]+)@sha256:/.exec(service.image)[1], capability: parseEnv(example).ADVERT_CAPABILITY_ID, text: read(`deploy/host/${file}`),
  };
});
const releaseSection = (book) => section(book.text, RELEASE_TITLE);
const fencedBlocks = (text) => [...text.matchAll(/^```sh\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
/** The four blocks that a runbook gives for the release, as they read for this agent: the pull, the build, the new runtime and the check. */
function releaseBlocksOf(book) {
  const folder = 'cd "$BASE/repo/deploy/host"';
  const local = `http://127.0.0.1:${book.port}`;
  return [
    [
      folder, `IMAGE=ghcr.io/apex-fusion/vector-service-agents/${book.image}`, `PIN=$(sed -n 's/^    image: //p' ${book.composeFile})`,
      'if printf \'%s\\n\' "$PIN" | grep -Eq "^($IMAGE@sha256:|sha256:)[0-9a-f]{64}\\$"; then',
      `  git checkout ${book.composeFile}`, `  ${book.pull}`, `  sed -i "s|^    image: .*|    image: $PIN|" ${book.composeFile}`,
      'else', '  echo "the pin of step 2 is not in the compose file, do not continue" >&2', 'fi', 'git log -1 --oneline', `grep -n '^    image: ' ${book.composeFile}`, '',
    ],
    [folder, `docker compose -f ${book.composeFile} build agent`, ''],
    [
      folder, `if curl -s ${local}/status | grep -q '"status":"free"'; then`, `  docker compose -f ${book.composeFile} up -d --force-recreate agent`,
      'else', '  echo "the runtime is not free: wait, and run this block again" >&2', 'fi', '',
    ],
    [
      folder, `curl -s ${local}/healthz`, `curl -s ${local}/capability`, `curl -s ${local}/status`,
      `curl -fsS https://${book.host}/.well-known/agent-card.json`, `curl -fsS -o /dev/null -w '%{http_code}\\n' https://${book.host}/`, '',
    ],
  ].map((lines) => lines.join('\n'));
}

test('the four runbooks: after step 17 and before Back out each has the section "Take a new runtime commit", which says what the commit changes (the check before the Claim and its three codes, the card and its two routes, the headers, the two settings that stay unset) and gives four parts in order', () => {
  assert.equal(RELEASE_BOOKS.length, 4);
  for (const book of RELEASE_BOOKS) {
    const headings = [...book.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const at = headings.indexOf(RELEASE_TITLE);
    assert.ok(at > 0, `${book.name}: the section is there`);
    assert.match(headings[at - 1], /^17\. /, `${book.name}: after step 17`);
    assert.equal(headings[at + 1], 'Back out', `${book.name}: before Back out`);
    const text = releaseSection(book);
    assert.match(text, /^\nOperator\. Use this section when the pin of `vector-agent-template` in `/, book.name);
    for (const part of [
      `\`${book.composeFile}\``, 'Only the runtime changes.', 'so the advert and its hash stay as they are', 'and only while its `/status` says `free`.',
      'From the commit `a05564c` on, the runtime differs in four ways:',
      'compares each escrow with the advert that it serves, before it builds a Claim', 'refuses a job with 409 and one of three codes',
      '`wrong_advert`: the escrow names another advert', '`underpaid`: the quoted amount of the escrow is below the price of the advert, or the escrow holds less than that amount and both bonds',
      '`bond_mismatch`: a bond is below the bond of the advert', 'A refused job costs no Claim. The escrow stays Open, and the buyer can Reclaim it after `deliver_by`.',
      'An escrow that a buyer posts for the advert of this agent passes',
      `The compose file sets \`PUBLIC_ORIGIN: https://${book.host}\` for the runtime.`, 'serves `GET /.well-known/agent-card.json` and answers `GET /` with 200',
      'Caddy sends both to the runtime, because only `/agent.json` goes to the service', 'The runtime does not start when the value is not an https origin.',
      '**Six context headers.**', 'The service does not read them.',
      '`SERVICE_PRECHECK_URL` and `RELEASE_WATCHER` are in no compose file and in no env file', 'the runtime asks the service nothing before the Claim, and it runs no release watcher',
      `\`https://${book.host}/v1/job\``, `\`${book.capability}\``, `\`docker logs --tail 20 ${book.container}\``, `It ends with \`Image ${book.container} Built\`.`, `\`${book.envFile}\``,
    ]) assert.ok(text.includes(part), `${book.name}: ${part}`);
    assert.deepEqual([...text.matchAll(/^\*\*Part (\d)\. /gm)].map((m) => Number(m[1])), [1, 2, 3, 4], `${book.name}: four parts in order`);
  }
});

test('the release blocks: four in each runbook, each from the folder of the compose file; the first puts the pin of step 2 aside, pulls and puts it back, the second builds the runtime, the third creates it again only when /status says free, the fourth reads the runtime and the card', () => {
  for (const book of RELEASE_BOOKS) assert.deepEqual(fencedBlocks(releaseSection(book)), releaseBlocksOf(book), book.name);
  assert.equal(new Set(RELEASE_BOOKS.map((book) => fencedBlocks(releaseSection(book)).join('\n'))).size, 4, 'each agent has its own names, ports and hosts');
});

const HAVE_RELEASE_TOOLS = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return HAVE_BASH; } catch { return false; } })();
test('the first release block in git: it brings the new commit with its compose file, keeps the pin of step 2 and the two env files, and changes nothing when the compose file holds no pin of the service image of this agent', { skip: HAVE_RELEASE_TOOLS ? false : 'needs git, bash and GNU sed' }, () => {
  for (const book of RELEASE_BOOKS) {
    const scratch = mkdtempSync(join(tmpdir(), 'release-'));
    try {
      writeFileSync(join(scratch, 'gitconfig'), '');
      const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CEILING_DIRECTORIES: scratch, GIT_TERMINAL_PROMPT: '0',
      };
      const git = (cwd, ...args) => {
        const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env, encoding: 'utf8' });
        assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
        return r.stdout.trim();
      };
      // The compose file of the reviewed commit, and of the commit that the host runs: the same but for the pin of the runtime.
      const reviewed = read(`deploy/host/${book.composeFile}`);
      const contextLine = reviewed.split('\n').find((l) => /vector-agent-template\.git#[0-9a-f]{40}$/.test(l));
      const imageLine = reviewed.split('\n').find((l) => l.startsWith('    image: '));
      const older = reviewed.split(contextLine).join(contextLine.replace(/#[0-9a-f]{40}$/, `#${'1'.repeat(40)}`));
      assert.notEqual(older, reviewed, 'the older commit has another pin of the runtime');
      const PIN = `ghcr.io/apex-fusion/vector-service-agents/${book.image}@sha256:${'ab'.repeat(32)}`;
      const OTHER = `ghcr.io/apex-fusion/vector-service-agents/other@sha256:${'cd'.repeat(32)}`;
      const withImage = (text, value) => text.split(imageLine).join(`    image: ${value}`);
      const at = (repo) => join(repo, 'deploy', 'host', book.composeFile);
      const origin = join(scratch, 'origin');
      const bundle = join(scratch, 'tmp', 'vector-service-agents.bundle');
      mkdirSync(join(origin, 'deploy', 'host'), { recursive: true });
      mkdirSync(join(scratch, 'tmp'));
      writeFileSync(join(origin, '.gitignore'), read('.gitignore'));
      writeFileSync(at(origin), older);
      git(origin, 'init', '-b', 'main');
      git(origin, 'add', '-A');
      git(origin, 'commit', '-m', 'the commit the host runs');
      const ran = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'bundle', 'create', bundle, 'main');
      // Three hosts on that commit, as step 1 makes them (a clone, or a clone of the bundle): one with the pin of step 2, one with the placeholder of the repository, and one with the pin of another image.
      const hosts = {};
      for (const [kind, text] of [['pinned', withImage(older, PIN)], ['placeholder', older], ['other', withImage(older, OTHER)]]) {
        const base = join(scratch, kind);
        mkdirSync(base);
        git(base, ...(book.pull.includes('.bundle') ? ['clone', '--branch', 'main', bundle, 'repo'] : ['clone', origin, 'repo']));
        const here = join(base, 'repo', 'deploy', 'host');
        writeFileSync(at(join(base, 'repo')), text);
        writeFileSync(join(here, '.env'), 'PROXY_NETWORK=test_proxy_network\n');
        writeFileSync(join(here, book.envFile), 'OPERATOR_CONTACT=ops@example.test\n');
        hosts[kind] = { base, repo: join(base, 'repo'), here, text };
      }
      assert.equal(git(hosts.pinned.repo, 'status', '--porcelain'), `M deploy/host/${book.composeFile}`, 'the pin of step 2 is the one local change: git ignores the two env files');
      // The reviewed commit: its compose file, which has the new pin of the runtime. It reaches the bundle too.
      writeFileSync(at(origin), reviewed);
      git(origin, 'commit', '-a', '-m', 'the change that is reviewed');
      const next = git(origin, 'rev-parse', 'HEAD');
      git(origin, 'bundle', 'create', bundle, 'main');
      const block = fencedBlocks(releaseSection(book))[0].split('/tmp/vector-service-agents.bundle').join(bundle);
      const run = (host) => spawnSync('bash', ['-c', block], { cwd: scratch, env: { ...env, BASE: host.base }, encoding: 'utf8' });
      // A pull with no block stops on the pin of step 2 and moves nothing. That is why the block puts the pin aside.
      const plain = spawnSync('git', book.pull.split(' ').slice(1).map((word) => (word === '/tmp/vector-service-agents.bundle' ? bundle : word)), { cwd: hosts.pinned.here, env, encoding: 'utf8' });
      assert.notEqual(plain.status, 0, `${book.name}: a pull stops on the pin`);
      assert.equal(git(hosts.pinned.repo, 'rev-parse', 'HEAD'), ran);
      for (let again = 0; again < 2; again++) {
        const r = run(hosts.pinned);
        assert.equal(r.status, 0, `${book.name}: ${r.stderr}`);
        assert.doesNotMatch(r.stderr, /fatal|error|do not continue/i, `${book.name}: no complaint (git says what it did on stderr)`);
        assert.equal(git(hosts.pinned.repo, 'rev-parse', 'HEAD'), next, `${book.name}: the checkout is at the reviewed commit`);
        assert.equal(readFileSync(at(hosts.pinned.repo), 'utf8'), withImage(reviewed, PIN), `${book.name}: the compose file of the reviewed commit, with the pin of step 2`);
        assert.equal(readFileSync(join(hosts.pinned.here, '.env'), 'utf8'), 'PROXY_NETWORK=test_proxy_network\n', `${book.name}: .env stays`);
        assert.equal(readFileSync(join(hosts.pinned.here, book.envFile), 'utf8'), 'OPERATOR_CONTACT=ops@example.test\n', `${book.name}: the env file stays`);
        assert.ok(r.stdout.split('\n').some((line) => line.startsWith(next.slice(0, 7)) && line.endsWith(' the change that is reviewed')), `${book.name}: git log shows the reviewed commit: ${r.stdout}`);
        assert.ok(r.stdout.trimEnd().endsWith(`:    image: ${PIN}`), `${book.name}: grep shows the pin: ${r.stdout}`);
      }
      for (const kind of ['placeholder', 'other']) {
        const r = run(hosts[kind]);
        assert.match(r.stderr, /the pin of step 2 is not in the compose file, do not continue/, `${book.name}: ${kind}`);
        assert.equal(git(hosts[kind].repo, 'rev-parse', 'HEAD'), ran, `${book.name}: ${kind}: nothing is pulled`);
        assert.equal(readFileSync(at(hosts[kind].repo), 'utf8'), hosts[kind].text, `${book.name}: ${kind}: the compose file is as it was`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('the third release block: it creates the runtime again only when /status says free, and not while a job runs, while the runtime is offline, or when it gives no answer or an error page', { skip: HAVE_RELEASE_TOOLS ? false : 'needs bash' }, () => {
  for (const book of RELEASE_BOOKS) {
    const block = fencedBlocks(releaseSection(book))[2];
    const scratch = mkdtempSync(join(tmpdir(), 'release-'));
    try {
      const bin = join(scratch, 'bin');
      const log = join(scratch, 'calls.log');
      mkdirSync(bin);
      mkdirSync(join(scratch, 'base', 'repo', 'deploy', 'host'), { recursive: true });
      // The two commands are stand-ins that write down what they were asked. curl answers with STUB_STATUS, or fails like a refused connection.
      writeFileSync(join(bin, 'curl'), '#!/bin/bash\necho "curl $*" >> "$STUB_LOG"\n[ -z "$STUB_CURL_FAILS" ] || exit 7\nprintf \'%s\' "$STUB_STATUS"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'docker'), '#!/bin/bash\necho "docker $*" >> "$STUB_LOG"\n', { mode: 0o755 });
      const run = (status, fails = '') => {
        const r = spawnSync('bash', ['-c', block], { env: { PATH: `${bin}:${process.env.PATH}`, BASE: join(scratch, 'base'), STUB_STATUS: status, STUB_CURL_FAILS: fails, STUB_LOG: log }, encoding: 'utf8' });
        const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
        rmSync(log, { force: true });
        return { ...r, calls };
      };
      const answer = (status) => JSON.stringify({ status, last_seen: '2026-11-19T13:48:59.482Z', active_sessions: status === 'working' ? 1 : 0, max_sessions: 1 });
      const asked = `curl -s http://127.0.0.1:${book.port}/status`;
      const free = run(answer('free'));
      assert.equal(free.status, 0, `${book.name}: ${free.stderr}`);
      assert.deepEqual(free.calls, [asked, `docker compose -f ${book.composeFile} up -d --force-recreate agent`], `${book.name}: free`);
      for (const [what, result] of [['working', run(answer('working'))], ['offline', run(answer('offline'))], ['no answer', run('', '1')], ['an empty answer', run('')], ['an error page', run('<h1>Bad gateway</h1>')]]) {
        assert.deepEqual(result.calls, [asked], `${book.name}: ${what}: the status is asked and nothing is created again`);
        assert.match(result.stderr, /the runtime is not free: wait, and run this block again/, `${book.name}: ${what}`);
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
});

test('README: the Caddy paragraph of each of the four stacks says that the agent card and GET / need no route of their own', () => {
  const SENTENCE = 'The agent card at `/.well-known/agent-card.json` and `GET /` need no route of their own: the runtime serves both, and both take the default route.';
  const paragraphs = readme.split('\n').filter((line) => line.startsWith('   The second route matters'));
  assert.equal(paragraphs.length, 4, 'one for each stack');
  for (const paragraph of paragraphs) assert.ok(paragraph.endsWith(` ${SENTENCE}`), paragraph.slice(0, 80));
});

// ======================================================================================================================================
// Audio Snippets (DEPLOYED since 2026-10-17): the third stack on the same host.
// Built on 2026-10-16; steps 1 to 5, 9 and 10 of its runbook were run on 2026-10-16 and steps 6 to 15 and 17 on 2026-10-17 (step 16 is not used).
// The four files and the section of the README are held to each other, to the service code, to the spec, and to the files of the Document Pipeline they
// follow. docker build and caddy validate are run by hand at deployment. The files name no host and no other stack (HOST_WORDS above).
// ======================================================================================================================================
const SSPEC = read('specs/audio-snippets.md');
const S_START = read('agents/audio-snippets/src/start.ts');
const S_SERVER = read('agents/audio-snippets/src/server.ts');
const sComposeText = read('deploy/host/docker-compose.audio-snippets.yml');
const sCompose = parseYaml(sComposeText);
const sExampleText = read('deploy/host/.env.audio-snippets.example');
const sExampleRaw = parseEnv(sExampleText);
const sExample = Object.fromEntries(Object.entries(sExampleRaw).map(([name, value]) => [name, /^"(.*)"$/.exec(value)?.[1] ?? value]));
const sRunbook = read('deploy/host/RUNBOOK-audio-snippets.md');
const sSnippet = read('deploy/host/Caddyfile.audio-snippets.snippet');
const sDockerfile = read('agents/audio-snippets/Dockerfile');
const { agent: sAgent, service: sService } = sCompose.services;
const sSection = readme.split('\n## Audio Snippets on the same host\n')[1]?.split('\n## ')[0] ?? '';
const sSpecNumber = (re) => Number(re.exec(SSPEC)?.[1]);
const S_TERMS = {
  price: sSpecNumber(/\| Price \| (\d+) \|/), supplierBond: sSpecNumber(/\| Supplier bond \| (\d+) \|/), buyerBond: sSpecNumber(/\| Buyer bond \| (\d+) \|/),
  window: sSpecNumber(/advert `max_processing_ms` \| (\d+) ms/), timeout: sSpecNumber(/Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/),
};
const S_SUPPLIER = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'];
const S_TOKEN = ['SERVICE_AUTH_HEADER'];
const S_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', ...RUNTIME_IDENTITY];
const S_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const S_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
const S_STEPS = ['Put the files on the host', 'Build the service image and pin it', 'Build the runtime image', 'Make the env file and generate the supplier key', 'Adapt the ops scripts', 'Supply the supplier wallet with its collateral and float', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
const S_STATUS = 'DEPLOYED since 2026-10-17';
const DC = 'docker compose -f docker-compose.audio-snippets.yml';
// A snippet run through the real code of Audio Snippets (tsx), with its argument passed as JSON, so that nothing here re-implements the service.
function inSnippets(code, arg) {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(arg)], { cwd: join(root, 'agents/audio-snippets'), encoding: 'utf8' }));
}

test('Snippets compose: the project and two containers have fixed names, the runtime is on loopback port 8085, the service is published nowhere, both are on the network that PROXY_NETWORK names', () => {
  assert.equal(sCompose.name, 'audio-snippets');
  assert.deepEqual(Object.keys(sCompose.services), ['agent', 'service']);
  assert.equal(sAgent.container_name, 'audio-snippets-agent');
  assert.equal(sService.container_name, 'audio-snippets-service');
  assert.deepEqual(sAgent.ports, ['127.0.0.1:8085:8080']);
  assert.equal(sService.ports, undefined);
  assert.deepEqual(sCompose.networks, { proxy: { external: true, name: PROXY_NETWORK_NAME } }, 'the network of the other two, named the same way');
  for (const [name, s] of [['agent', sAgent], ['service', sService]]) {
    assert.deepEqual(s.networks, ['proxy'], name);
    assert.deepEqual(s.env_file, [{ path: './.env.audio-snippets', required: true }], name);
    assert.equal(s.restart, 'unless-stopped', name);
    assert.deepEqual(s.logging, pAgent.logging, `${name}: the log rotation of the other two`);
  }
  assert.deepEqual(sAgent.depends_on, ['service']);
  assert.deepEqual(sComposeText.match(/\$\{[^}]*\}?/g), [PROXY_NETWORK_NAME], 'the one interpolation in the file');
  assert.ok(sComposeText.includes('# The name of that network is not in the repository: compose reads PROXY_NETWORK from .env next to this file (RUNBOOK-audio-snippets.md step 1), and stops while it has no value.'));
});

test('Snippets compose: the runtime is the pinned template commit, SERVICE_URL names the service container on 9093 at /, the service holds no key, and the token is blanked in neither', () => {
  assert.equal(sAgent.build.context, pAgent.build.context, 'the template commit of the other two');
  assert.equal(sAgent.build.dockerfile, 'agent/Dockerfile');
  assert.deepEqual(sAgent.environment, {
    CAPABILITY_KIND: 'custom', SERVICE_URL: 'http://audio-snippets-service:9093/', SERVICE_CONTENT_TYPE: 'application/json', SERVICE_TIMEOUT_MS: '1380000', ADVERT_MAX_PROCESSING_MS: '1500000', PORT: '8080', PUBLIC_ORIGIN: 'https://mp-suppliers-snippets.hal8.ai',
  });
  assert.deepEqual(sService.environment, { PORT: '9093', HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '' }, "the supplier key is the runtime's and is blanked for the service, which reads no other key");
  assert.equal(new URL(sAgent.environment.SERVICE_URL).hostname, sService.container_name);
  assert.ok(!('SERVICE_AUTH_HEADER' in sAgent.environment) && !('SERVICE_AUTH_HEADER' in sService.environment), 'both read the token from the env file');
  assert.ok(S_START.includes("requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER,"), 'the service refuses to start without the token');
  assert.ok(S_START.includes('export const PORT_DEFAULT = 9093;'));
  assert.match(sDockerfile, /^ENV NODE_ENV=production PORT=9093 HOST=0\.0\.0\.0 /m);
  assert.match(sDockerfile, /^EXPOSE 9093$/m);
});

test('Snippets compose: the window and the timeout are the spec terms and nest as the runtime requires; the memory limit and the grace period; no volume', () => {
  assert.deepEqual([S_TERMS.window, S_TERMS.timeout], [1_500_000, 1_380_000]);
  assert.equal(Number(sAgent.environment.ADVERT_MAX_PROCESSING_MS), S_TERMS.window);
  assert.equal(Number(sAgent.environment.SERVICE_TIMEOUT_MS), S_TERMS.timeout);
  assert.ok(S_TERMS.timeout <= S_TERMS.window - 60_000, 'the runtime refuses to boot otherwise');
  assert.ok(read('agents/audio-snippets/src/budget.ts').includes('export const JOB_DEADLINE_MS = 1_320_000;'), 'the deadline is 60 s inside the timeout');
  assert.ok(S_SERVER.includes('export const MIN_PROCESSING_WINDOW_MS = 1_500_000;'));
  assert.equal(sService.mem_limit, '3072m');
  assert.equal(sService.stop_grace_period, '330s');
  assert.ok(read('packages/service-kit/src/lifecycle.ts').includes('export const SHUTDOWN_WAIT_MS = 300_000;'), 'the grace period is the wait of the service and 30 s more');
  assert.equal(sService.volumes, undefined);
  assert.equal(sCompose.volumes, undefined);
  assert.doesNotMatch(sDockerfile, /^VOLUME /m);
});

test('Snippets compose: the service image is named by digest (a placeholder in the repository), on one line that step 2 rewrites and step 9 checks', () => {
  assert.match(sService.image, /^ghcr\.io\/apex-fusion\/vector-service-agents\/audio-snippets@sha256:(<digest>|[0-9a-f]{64})$/);
  assert.equal(sComposeText.split('\n').filter((l) => /^    image: /.test(l)).length, 1);
  assert.equal(parseYaml(sComposeText.replace(/^    image: .*$/m, `    image: sha256:${'ab'.repeat(32)}`)).services.service.image, `sha256:${'ab'.repeat(32)}`);
  const two = section(sRunbook, '2. Build the service image and pin it');
  for (const part of [
    'docker build -f agents/audio-snippets/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest .',
    "docker image inspect --format '{{index .RepoDigests 0}}' \"$IMAGE:latest\" 2>/dev/null || docker image inspect --format '{{.Id}}' \"$IMAGE:latest\"",
    'sed -i "s|^    image: .*|    image: $PIN|" docker-compose.audio-snippets.yml', '`invalid reference format`', '`docker image prune -a`',
  ]) assert.ok(two.includes(part), `step 2 says: ${part}`);
  assert.ok(section(sRunbook, '9. Start the service').includes("grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/audio-snippets@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.audio-snippets.yml"));
});

test('Snippets env example: the blocks in order (supplier, token, chain, advert, manifest), known names only, each once; every secret empty, nothing key-shaped but the published values of the identity registry; the header says one key and a token, and where the network is named', () => {
  assert.deepEqual(Object.keys(sExample), [...S_SUPPLIER, ...S_TOKEN, ...S_CHAIN, ...S_ADVERT, ...S_MANIFEST]);
  assert.deepEqual(keyProblems(withoutPublished(sExample)), []);
  assert.deepEqual(keyProblems(sAgent.environment), []);
  assert.deepEqual(keyProblems(sService.environment), []);
  for (const name of [...S_SUPPLIER, ...S_TOKEN, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(sExample[name], '', `${name} is filled by the runbook`);
  for (const name of ['IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY]) assert.equal(sExample[name], IDENTITY_MAINNET[name], `${name} is the value that the identity registry deployment published`);
  assert.equal(sExample.IDENTITY_ADDRESS, '', 'IDENTITY_ADDRESS stays empty: the address of IDENTITY_POLICY_ID');
  assert.equal(sExampleRaw.SERVICE_AUTH_HEADER, '""', 'empty and in quotes');
  assert.match(sExample.OPERATOR_CONTACT, PLACEHOLDER);
  assert.equal(sExample.OPERATOR_CONTACT, example.OPERATOR_CONTACT, 'the same placeholder as the other two');
  const [first, second, third, fourth] = sExampleText.split('\n');
  assert.equal(first, '# Copy to .env.audio-snippets next to the compose file (mode 600). Names and placeholders only: this example holds no key, no secret and no usable token (SERVICE_AUTH_HEADER is empty here).');
  assert.equal(second, "# The copy holds one key, the supplier key (the runtime's), and the token between the two containers, and it never enters git: the repository's .gitignore covers .env.* except *.example.");
  assert.equal(third, `# Status: ${S_STATUS}. The status word the manifest carries is AGENT_STATUS_CHIP below.`);
  assert.equal(fourth, "# The external network of the host's reverse proxy is not named here: compose reads PROXY_NETWORK from .env next to the compose file (RUNBOOK-audio-snippets.md step 1).");
  assert.equal(/^PROXY_NETWORK=/m.test(sExampleText), false, 'compose would not read it here');
  assert.ok(sExampleText.includes('The service reads the public key and the key hash, publishes both in the manifest, and stops at start when the public key is empty or is not the one of the key hash.'), 'R-D21');
});

test('Snippets env example: every name the service code reads is in the example, in the compose environment, or has a default in the code; the runtime gets every name the template lists', () => {
  const files = [...sourceFiles('agents/audio-snippets/src'), ...sourceFiles('packages/service-kit/src'), ...sourceFiles('packages/vector-read/src')];
  const names = new Set(files.flatMap((f) => [...envNamesIn(read(f))]));
  // Left unset on purpose: the defaults of the code, and the four the image sets (ENV of agents/audio-snippets/Dockerfile).
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'KOIOS_URL', 'INDEXER_URL', 'WHISPER_MODEL', 'WHISPER_THREADS', 'WHISPER_MODEL_DIR', 'ASR_PYTHON', 'ASR_WORKER'];
  assert.deepEqual([...names].filter((n) => !(n in sExample) && !(n in sService.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in sExample), `${n} stays unset in the example`);
  for (const n of ['OPERATOR_CONTACT', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER', 'WHISPER_MODEL', 'WHISPER_THREADS']) assert.ok(names.has(n), `the service reads ${n}`);
  assert.ok(!names.has('SUPPLIER_PRIV_KEY_HEX'), "no source of the service reads the supplier key: it is the runtime's");
  assert.match(sDockerfile, /ASR_WORKER=\/app\/asr\/worker\.py WHISPER_MODEL=\$WHISPER_MODEL PATH=\/app\/asr\/venv\/bin:\$PATH$/m, 'the image sets what the example leaves out');
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY, 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT', 'PUBLIC_ORIGIN'];
  assert.deepEqual(NEEDED.filter((n) => !(n in sExample) && !(n in sAgent.environment)), []);
});

test('Snippets env example: the chain values are those of the Pipeline, the advert terms are the spec, the endpoint is the third hostname, the status word is deployed since 2026-10-17, and the manifest it produces is the default one with the published identity registry', () => {
  for (const name of S_CHAIN) assert.equal(sExample[name], pExample[name], name);
  assert.deepEqual([sExample.ADVERT_CAPABILITY_ID, sExample.ADVERT_MODEL], ['audio.transcript.snippets.v1', 'audio-snippets-v1']);
  assert.ok(SSPEC.includes(`The model string in the advert and in every receipt is \`${sExample.ADVERT_MODEL}\`.`));
  assert.deepEqual([sExample.ADVERT_PRICE_LOVELACE, sExample.ADVERT_SUPPLIER_BOND_LOVELACE, sExample.ADVERT_BUYER_BOND_LOVELACE, sExample.ADVERT_MAX_PROCESSING_MS].map(Number), [S_TERMS.price, S_TERMS.supplierBond, S_TERMS.buyerBond, S_TERMS.window]);
  assert.deepEqual([S_TERMS.price, S_TERMS.supplierBond, S_TERMS.buyerBond], [2_000_000, 1_000_000, 1_000_000]);
  assert.equal(sExample.ADVERT_ENDPOINT_URL, 'https://mp-suppliers-snippets.hal8.ai');
  assert.equal(sExample.ADVERT_DETAIL_URI, `${sExample.ADVERT_ENDPOINT_URL}/agent.json`);
  assert.ok(DESIGN.includes('`mp-suppliers-snippets.hal8.ai`'));
  assert.deepEqual([sExample.AGENT_STATUS_CHIP, sExample.AGENT_STATUS_SINCE], ['deployed', '2026-10-17'], 'the advert is Active, one first-party job has settled and the first stop was watched (step 17), which shows that the path works and is not demand, so nothing may claim live');
  // The comment says what the word is, who changes it, and what a first run starts with.
  assert.match(sExampleText, /^# The status word the manifest carries, and since when: deployed since 2026-10-17, after the advert was Active, a first-party job had settled and the first stop had been watched \(RUNBOOK-audio-snippets\.md step 17, "Flip the status"\)\. A first-party run is not demand, so the word is not live\.$/m);
  assert.match(sExampleText, /^# On a first run, before any job has settled, set proposed and today's date here; step 17 changes them\.$/m);
  const [withExample, withNothing] = inSnippets(
    "import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => manifestFromEnv(env))));",
    [{ ...withoutPlaceholders(sExample), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }],
  );
  assert.equal(withExample.identity.registry_address, IDENTITY_MAINNET_ADDRESS, 'the published policy gives the published address');
  assert.deepEqual({ ...withExample, identity: withNothing.identity }, withNothing, 'the example changes nothing else in the manifest the advert will hash');
  assert.deepEqual(withExample.status, { chip: 'deployed', since: '2026-10-17' });
  assert.equal(withExample.terms.price_lovelace, S_TERMS.price);
  assert.equal(withExample.terms.max_processing_ms, S_TERMS.window);
});

test('Snippets env example: a token of the form the runbook makes is accepted by the service at start, an empty one is refused with the variable named, and so are an empty public key and one that is not the key of SUPPLIER_PKH (R-D21)', () => {
  // The supplier lines are from one key, as gen-keypair makes them: the key hash is the blake2b-224 of the public key, computed here by the code of the service. The 64 hex
  // digits of the token are other digits than the key's, because the service refuses a token that it finds in any other setting.
  const publicKey = 'ab'.repeat(32);
  const [keyHash] = inSnippets("import { blake2b224Hex } from '@vsa/vector-read'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((hex) => blake2b224Hex(hex))));", [publicKey]);
  assert.match(keyHash, /^[0-9a-f]{56}$/);
  const base = { OPERATOR_CONTACT: TEST_CONTACT, SUPPLIER_PKH: keyHash, SUPPLIER_PUB_KEY_HEX: publicKey };
  const token = `Bearer ${'cd'.repeat(32)}`;
  const code = "import { loadConfig } from './src/start.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => { try { return { length: loadConfig(env).authHeader.length }; } catch (e) { return { error: e.message }; } })));";
  const [accepted, empty, noKey, otherKey] = inSnippets(code, [
    { ...base, SERVICE_AUTH_HEADER: token }, { ...base, SERVICE_AUTH_HEADER: '' },
    { ...base, SERVICE_AUTH_HEADER: token, SUPPLIER_PUB_KEY_HEX: '' }, { ...base, SERVICE_AUTH_HEADER: token, SUPPLIER_PUB_KEY_HEX: 'ef'.repeat(32) },
  ]);
  assert.deepEqual(accepted, { length: 71 });
  assert.match(empty.error, /^environment variable SERVICE_AUTH_HEADER is required \(.+\) and is not set$/);
  assert.match(noKey.error, /^environment variable SUPPLIER_PUB_KEY_HEX is required \(.+\) and is not set$/);
  assert.match(otherKey.error, /^environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: /);
  assert.doesNotMatch(JSON.stringify([noKey, otherKey]), /[0-9a-f]{16}/, 'a refusal names the settings and prints no value');
});

test('Snippets Caddy snippet: the site block is the third endpoint host, the manifest goes to the service and everything else to the runtime, the block is last, and the README shows the same block', () => {
  const lines = sSnippet.split('\n');
  const first = lines.findIndex((l) => !l.startsWith('#') && l.trim() !== '');
  const block = lines.slice(first).join('\n').trimEnd();
  assert.equal(block, 'mp-suppliers-snippets.hal8.ai {\n    handle /agent.json {\n        reverse_proxy audio-snippets-service:9093\n    }\n    handle {\n        reverse_proxy audio-snippets-agent:8080\n    }\n}');
  assert.equal(block.split('\n')[0], `${new URL(sExample.ADVERT_ENDPOINT_URL).hostname} {`);
  const comments = lines.slice(0, first).join('\n');
  assert.ok(lines.slice(0, first).every((l) => l.startsWith('#')), 'only comments before the block');
  assert.ok(comments.includes("The block must stay the last thing in this file: the host administrator's install script\n# takes everything from the hostname line to the end."));
  assert.ok(comments.includes("The runtime does not serve /agent.json, and the advert's detail_uri points at it, so that one path goes to the service."));
  assert.ok(sSection.split('\n').map((l) => l.replace(/^ {3}/, '')).join('\n').includes('```\n' + block + '\n```'), 'the README shows the same block');
});

test('Snippets files: each says DEPLOYED since 2026-10-17 in its own first lines, the compose file and the snippet say that the stack is installed and running, the runbook and the README section say which steps were run; none says LIVE or the words of before the flip, names the host or another stack, or holds a dash, the unit name, a person or a home path', () => {
  assert.equal(sComposeText.split('\n')[1], `# ${S_STATUS}: installed on the host since 2026-10-16 and running since 2026-10-17; one first-party job settled on 2026-10-17. The order of work is RUNBOOK-audio-snippets.md. The host administrator's part is README.md.`);
  assert.ok(sSnippet.split('\n')[1].startsWith(`# ${S_STATUS}: installed and running on the host. It was installed on 2026-10-16, at step 10 of RUNBOOK-audio-snippets.md, by a copy of the host administrator's install script (install-caddy-route.sh, from the ops folder of the Pipeline), which merges it and reloads Caddy (README.md).`));
  assert.equal(sRunbook.split('\n')[2], `Status: ${S_STATUS}. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 5, 9 and 10 were run on 2026-10-16 and steps 6 to 15 and 17 on 2026-10-17, and the first stop was watched on 2026-10-17 (the service was idle, the stop took 1 s, the log ended with the SIGTERM line and the exit code was 0). Step 6 was the Foundation's, and step 9 was first run as a smoke start before the wallet was supplied; the service was recreated after steps 7 and 8. Step 16, the wallet monitor, is not used for this agent, as for the other two.`);
  assert.ok(sSection.split('\n')[1].startsWith(`Status: ${S_STATUS}. Nothing in this section is LIVE. Steps 1 to 5, 9 and 10 of its runbook were run on 2026-10-16 and steps 6 to 15 and 17 on 2026-10-17. Step 16, the wallet monitor, is not used for this agent, as for the other two. The files are `));
  // The first stop the status line reports is the one the section "Watch the first stop" asks for: the SIGTERM line in the log, and the exit code 0.
  assert.ok(section(sRunbook, 'Watch the first stop').includes('The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`.'));
  // DEPLOYED is said in those lines and nowhere else (the third line of the env example and of the runbook, the second line of the compose file and of the snippet), and LIVE is only ever denied.
  const STATUS_AT = { 'deploy/host/docker-compose.audio-snippets.yml': `# ${S_STATUS}:`, 'deploy/host/Caddyfile.audio-snippets.snippet': `# ${S_STATUS}:`, 'deploy/host/.env.audio-snippets.example': `# Status: ${S_STATUS}.`, 'deploy/host/RUNBOOK-audio-snippets.md': `Status: ${S_STATUS}.` };
  for (const rel of [...S_FILES, 'agents/audio-snippets/Dockerfile']) {
    const text = read(rel);
    assert.doesNotMatch(text.replace(STATUS_AT[rel] ?? '', '').replace('Nothing in this folder is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/, `${rel}: no status claim beyond the status line`);
    assert.doesNotMatch(text, /Not installed:|No step of it has been run|no step of RUNBOOK-audio-snippets\.md has been run|has not been run|built, not deployed|what will happen/, `${rel}: the words of before the flip`);
    assert.doesNotMatch(text, HOST_WORDS, `${rel}: names no host and no other stack`);
    assert.doesNotMatch(text, DASHES, `${rel}: no em or en dash`);
    assert.doesNotMatch(text, UNIT_NAME, `${rel}: the unit is called units`);
    assert.doesNotMatch(text, NAMES, `${rel}: roles, not people`);
    assert.doesNotMatch(text, HOME_PATH, `${rel}: no path into a home folder`);
    assert.match(text, /^[\x09\x0a\x20-\x7e]*$/, `${rel}: ASCII`);
  }
  assert.doesNotMatch(sSection, HOST_WORDS);
  assert.doesNotMatch(sSection.replace(`Status: ${S_STATUS}.`, '').replace('Nothing in this section is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/);
  assert.doesNotMatch(sSection, /No step of its runbook has been run|built, not deployed/, 'the words of before the flip');
});

test('Snippets README section: the third stack, with its two containers, the loopback port, the unpublished service port, the network of .env, the limits, the hostname, the Caddy block and the way back', () => {
  assert.ok(sSection.length > 2500, 'the section exists');
  assert.ok(readme.indexOf('\n## Audio Snippets on the same host\n') > readme.indexOf('\n## Rollback\n') && readme.indexOf('\n## Audio Snippets on the same host\n') > readme.indexOf('\n### What the host administrator does for the Pipeline\n'), "after the Pipeline's section");
  const rows = sSection.split('\n').filter((l) => l.startsWith('| `'));
  assert.deepEqual(rows.map((r) => r.split(' | ')[0]), ['| `audio-snippets-agent`', '| `audio-snippets-service`']);
  for (const part of [
    "[RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), which is the operator's order of work and follows [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md) step for step",
    'The compose project is `audio-snippets`.', "Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for the other two).",
    'the base path is the folder the operator chose for this agent (`BASE` in its runbook)',
    '- **One key.**', 'The service holds no key and posts nothing',
    '- **A token on the service, as for the Pipeline.**', 'gets 401 before its body is read', 'Port 9093 is never published to the host all the same.',
    '`mem_limit: 3072m`', '`stop_grace_period: 330s`', '`127.0.0.1:8085`', 'ss -ltnp', 'a clash on 8085',
    '`mp-suppliers-snippets.hal8.ai`', 'DNS only (grey cloud)', 'There is no registry login and no image to pull',
    'docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile', 'docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile',
    `\`${DC} up -d --force-recreate <service>\``, 'A change to `SERVICE_AUTH_HEADER` needs both containers recreated.',
    'The service refuses to start while `OPERATOR_CONTACT`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` or `SERVICE_AUTH_HEADER` is not set, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`',
    'It also refuses to start when its temporary directory cannot be written.',
    '[RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), under "Back out"',
  ]) assert.ok(sSection.includes(part), `the section says: ${part}`);
  assert.ok(!sSection.includes('retire-advert.ts'), 'the retire command lives in one place, the runbook');
  // The section of Advocate comes after this one since Advocate was built (Plan E), so the two sentences that enumerate the stacks say where each section is.
  assert.ok(readme.includes("Audio Snippets is a third, with its own section after the Pipeline's, and its own runbook, [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md)."));
  assert.ok(readme.includes('Audio Snippets has its own name, `mp-suppliers-snippets.hal8.ai`, and its own section after the Pipeline\'s.'));
  assert.equal(readme.match(/Audio Snippets is a third, built and not deployed|Two more come later/), null, 'the words of before the flip of Audio Snippets');
  assert.ok(sSection.includes(`\`mem_limit: ${sService.mem_limit}\``) && sSection.includes(`\`stop_grace_period: ${sService.stop_grace_period}\``));
});

test('Snippets RUNBOOK: the twenty-two sections in order, the seventeen steps keep the numbers of the other runbooks, and the head lists what differs with the names table and the two base paths', () => {
  const numbered = S_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...sRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Take a new runtime commit', 'Back out', 'If something goes wrong']);
  assert.equal([...pRunbook.matchAll(/^## (\d+)\. /gm)].length, S_STEPS.length, 'as many steps as the runbook it follows');
  for (const m of sRunbook.matchAll(/\bsteps? (\d+)/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= S_STEPS.length, `step ${m[1]}`);
  const quoted = [...sExampleText.matchAll(/RUNBOOK-audio-snippets\.md step (\d+), "([^"]+)"/g)];
  assert.ok(quoted.length >= 2, 'the example names steps of the runbook');
  for (const m of quoted) assert.equal(S_STEPS[Number(m[1]) - 1], m[2], `the example quotes step ${m[1]}`);
  assert.match(sRunbook, /The operator holds the key and does every step except two\. Step 6 \(the collateral and float of the supplier wallet\) is the Foundation's\. Step 10 \(DNS and Caddy\) is the host administrator's, see \[README\.md\]\(README\.md\)\./);
  assert.match(section(sRunbook, '6. Supply the supplier wallet with its collateral and float'), /^\nThe Foundation\. /);
  assert.match(section(sRunbook, '10. DNS and Caddy'), /^\nHost administrator, from/);
  const head = sRunbook.slice(0, sRunbook.indexOf('\n## Collateral and float\n'));
  for (const part of [
    'This is [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), the runbook of the Document Pipeline, written for Audio Snippets.', 'step N here is step N there',
    '- **One key.**', '- **A token on the service, as for the Pipeline.**', '- **A window of 25 min.**', '`max_processing_ms` is 1500000', '`SERVICE_TIMEOUT_MS` is 1380000', '1320000 ms (22 min)', 'at most 900 s of it',
    '- **The speech model in the image.**', '- **No state, and a clean stop.**', '`low_disk`', '- **The network, as for the other two.**', '- **Price 2.**',
    '| Base path on the host | `$BASE`, the folder the operator chooses for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |',
    '| Base path of the Pipeline | `$PIPELINE_BASE`, the `BASE` of RUNBOOK-document-pipeline.md: its ops scripts and its install script |',
    '| "This folder" | `$BASE/repo/deploy/host` |', '| Compose file, env file | `docker-compose.audio-snippets.yml`, `.env.audio-snippets` |',
    '| Containers | `audio-snippets-agent` (the runtime), `audio-snippets-service` |',
    '| Ports | the runtime on `127.0.0.1:8085`, loopback only; the service on 9093, never published |', '| Public name | `mp-suppliers-snippets.hal8.ai` |',
    "| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |",
    'Set both again in every new shell on the host, before the commands below:',
    'Each block that works in a folder starts with its own `cd` to it, so that it also runs alone in a new shell once the two variables are set there.',
    'The `docker compose` commands in the running text (step 17, Back out, the table at the end) run in `$BASE/repo/deploy/host`.',
    'The few values that a block takes from an earlier one, the functions of step 4 and `DETAIL_HASH` in step 12, are named where they matter.',
  ]) assert.ok(head.includes(part), `the head says: ${part}`);
  // The paths on the host go through the two base paths, set once at the top, before the first command that uses them.
  const block = '```sh\nBASE=/opt/audio-snippets\nPIPELINE_BASE=/opt/document-pipeline\n```';
  assert.ok(head.includes(block));
  assert.equal(sRunbook.split('/opt/').length, block.split('/opt/').length, 'no other absolute path on the host');
  assert.ok(sRunbook.indexOf(block) < sRunbook.indexOf('"$BASE'));
  // The facts it quotes are the code's.
  assert.ok(read('packages/service-kit/src/server.ts').includes('export const HEARTBEAT_MS = 60_000;'));
  assert.ok(read('agents/audio-snippets/src/budget.ts').includes('export const ASR_MAX_MS = 900_000;'));
  assert.ok(read('agents/audio-snippets/src/disk.ts').includes('export const MIN_FREE_BYTES = 268_435_456;'));
});

test('Snippets RUNBOOK collateral and float: one key, 5 alone then 50, and the key of step 15 with the cost of a job from the guide', () => {
  const collateral = section(sRunbook, 'Collateral and float');
  const rows = collateral.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Key |'));
  assert.equal(rows.length, 1, 'one key');
  assert.ok(rows[0].startsWith("| Supplier key (the runtime's), generated on the host in step 4 | Two transfers to its address: exactly 5 units alone (collateral), then 50 units |"));
  assert.ok(collateral.includes('The service holds no key, so there is no second wallet.'));
  assert.ok(collateral.includes('A job of Audio Snippets costs the hirer about 4 (`docs/HIRE.md`, section 3)'));
  assert.ok(read('docs/HIRE.md').includes('| 2 (Audio Snippets) | 4 | 3 | 1 | about 1 | about 4 | 12 |'), 'what a job costs the hirer');
});

test('Snippets RUNBOOK steps 1 to 3: the bundle into $BASE and .env with the network, the image built and checked on the host with the real model, the runtime built', () => {
  const one = section(sRunbook, '1. Put the files on the host');
  for (const part of ['git bundle create vector-service-agents.bundle main', 'scp vector-service-agents.bundle <user>@<host>:/tmp/', 'mkdir -p "$BASE" && cd "$BASE"', 'git clone --branch main /tmp/vector-service-agents.bundle repo', 'cd repo/deploy/host']) assert.ok(one.includes(part), part);
  assert.ok(one.includes("```sh\ncd \"$BASE/repo/deploy/host\"\necho 'PROXY_NETWORK=<the network the host administrator names>' > .env\ndocker network inspect --format '{{.Name}}' \"$(sed -n 's/^PROXY_NETWORK=//p' .env)\"\n```"), 'step 1 writes .env in this folder and checks that the network exists, as the other runbooks do, with the cd of a block that may run in a new shell');
  assert.ok(one.includes('The second line must print the name back. An error means that this host has no network of that name.'));
  assert.ok(sRunbook.indexOf("' > .env\n") < sRunbook.indexOf('docker compose -f '), '.env before the first compose command');
  const two = section(sRunbook, '2. Build the service image and pin it');
  for (const part of [
    'docker run --rm --entrypoint python3 ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest -I /app/asr/worker.py --check /app/asr/models/base',
    "docker run --rm --entrypoint sh -e REQUIRE_ASR=1 -e WHISPER_MODEL_DIR=/app/asr/models/base -w /repo/agents/audio-snippets ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest -c 'node_modules/.bin/vitest run test/worker-contract.test.ts test/asr-real.test.ts'",
    '`{"ok":true,"faster_whisper":"1.2.1","ctranslate2":"4.8.2"}`', '`--build-arg WHISPER_MODEL=small`',
  ]) assert.ok(two.includes(part), `step 2 says: ${part}`);
  for (const file of ['agents/audio-snippets/test/worker-contract.test.ts', 'agents/audio-snippets/test/asr-real.test.ts', 'agents/audio-snippets/asr/worker.py']) assert.ok(existsSync(join(root, file)), file);
  assert.ok(two.indexOf('--check /app/asr/models/base') < two.indexOf('docker image inspect'), 'checked before it is pinned');
  assert.ok(two.includes('```sh\ncd "$BASE/repo/deploy/host"\nIMAGE=ghcr.io/apex-fusion/vector-service-agents/audio-snippets\n'), 'the block that pins starts in this folder: it may run in a new shell');
  const three = section(sRunbook, '3. Build the runtime image');
  assert.ok(three.includes(`${DC} build agent`) && three.includes('It ends with `Image audio-snippets-agent Built`.'));
});

test('Snippets RUNBOOK step 4: the env file once, the key and the token only into empty lines, the lengths, the contact, and the offline copy', () => {
  const four = section(sRunbook, '4. Make the env file and generate the supplier key');
  const blocks = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 5);
  const [head, supplier, token, lengths, contact] = blocks;
  assert.ok(head.includes('keypair_into() {') && head.includes('token_into() {') && head.includes('umask 077'));
  assert.ok(head.includes(`json=$(${DC} run --rm --no-deps -T agent \\\n    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1)`));
  assert.ok(head.endsWith('if [ -e .env.audio-snippets ]; then\n  echo "refusing: the env file exists, and it is kept as it is" >&2\nelse\n  cp .env.audio-snippets.example .env.audio-snippets && chmod 600 .env.audio-snippets\nfi\n'));
  assert.equal(supplier, 'cd "$BASE/repo/deploy/host"\nkeypair_into SUPPLIER\n');
  assert.equal(token, 'cd "$BASE/repo/deploy/host"\ntoken_into\n');
  assert.ok(lengths.startsWith("cd \"$BASE/repo/deploy/host\"\nawk -F= '/^SUPPLIER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/"));
  assert.equal(contact, "cd \"$BASE/repo/deploy/host\"\ngrep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.audio-snippets\n");
  for (const line of ['SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58', 'SERVICE_AUTH_HEADER 71']) assert.ok(four.includes('`' + line + '`'), line);
  assert.ok(four.includes("Copy `.env.audio-snippets` to the operator's encrypted offline store now, before the address receives anything"));
  assert.ok(four.includes('Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`'));
  assert.ok(four.includes('and the service stops at start without the token, without the public key, and with a public key that is not the one of the key hash, because it publishes both.'), 'R-D21');
  assert.ok(four.includes('It must print 1: a value that does not start with an angle bracket. The ops scripts read this file with the shell\'s `.`, which cannot read the placeholder of the example, `OPERATOR_CONTACT=<...>`, until it is replaced: its angle brackets are redirections to the shell, which stops at that line, so the check must print 1 before step 6.'));
});

// The blocks of step 4, run as they stand in bash (the cd lines are the host's, so they are taken out and the temporary folder is the working directory), with
// stand-ins for docker and openssl that check the arguments they are called with.
const S_STUBS = String.raw`STUB_N="$PWD/.stub-n"
docker() {
  [ "$*" = "compose -f docker-compose.audio-snippets.yml run --rm --no-deps -T agent node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1" ] || { echo "unexpected docker call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '{\n  "privateKeyHex": "%064x",\n  "publicKeyHex": "%064x",\n  "pubKeyHash": "%056x",\n  "address": "addr1%053x"\n}\n' $((n * 1000003)) $((n * 7919)) $((n * 104729)) "$n"
}
openssl() {
  [ "$*" = "rand -hex 32" ] || { echo "unexpected openssl call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '%064x\n' $((n * 15485863))
}
`;
function sStep4() {
  const four = section(sRunbook, '4. Make the env file and generate the supplier key');
  const [head, supplier, token, lengths] = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].replace(/^cd "\$BASE\/repo\/deploy\/host"\n/, ''));
  return { head, supplier, token, lengths };
}
function withSnippetsFolder(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'snippets-step4-'));
  try {
    copyFileSync(join(root, 'deploy/host/.env.audio-snippets.example'), join(dir, '.env.audio-snippets.example'));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const sEnvOf = (dir) => readFileSync(join(dir, '.env.audio-snippets'), 'utf8');
const S_FILLED = /^(SUPPLIER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)|SERVICE_AUTH_HEADER)=/;
const apartFromTheFive = (text) => text.split('\n').filter((l) => !S_FILLED.test(l)).join('\n');

test('Snippets RUNBOOK step 4 in bash: the blocks make the env file, the key and the token, print only names and lengths, and leave every other line of the example as it was', NEEDS_BASH, () => {
  const { head, supplier, token, lengths } = sStep4();
  withSnippetsFolder((dir) => {
    const run = runBash(`${S_STUBS}${head}${supplier}${token}${lengths}`, dir);
    assert.equal(run.stderr, '', 'nothing refused and nothing failed');
    assert.equal(run.stdout, ['SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58', 'SERVICE_AUTH_HEADER 71', ''].join('\n'));
    assert.doesNotMatch(run.stdout + run.stderr, /[0-9a-f]{16}|Bearer/, 'no key, no hash and no token is printed');
    assert.match(parseEnv(sEnvOf(dir)).SERVICE_AUTH_HEADER, /^"Bearer [0-9a-f]{64}"$/);
    assert.equal(apartFromTheFive(sEnvOf(dir)), apartFromTheFive(sExampleText), "every other line is the example's");
  });
});

test('Snippets RUNBOOK step 4 in bash: run again, nothing is made again and nothing is replaced; the key is made again alone after the command of the failure table emptied its lines', NEEDS_BASH, () => {
  const { head, supplier, token } = sStep4();
  const table = section(sRunbook, 'If something goes wrong');
  const emptySupplier = String.raw`sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.audio-snippets`;
  const emptyToken = `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.audio-snippets`;
  for (const command of [emptySupplier, emptyToken]) assert.ok(table.includes('`' + command + '`'), command);
  withSnippetsFolder((dir) => {
    assert.equal(runBash(`${S_STUBS}${head}${supplier}${token}`, dir).status, 0);
    const before = sEnvOf(dir);
    const again = runBash(`${S_STUBS}${head}${supplier}${token}`, dir);
    assert.equal(sEnvOf(dir), before, 'byte for byte');
    for (const refusal of ['refusing: the env file exists, and it is kept as it is', 'refusing: SUPPLIER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced', 'refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first']) assert.ok(again.stderr.includes(refusal), refusal);
    assert.equal(runBash(`${emptySupplier}\n`, dir).status, 0);
    assert.equal(runBash(`${S_STUBS}${head}${supplier}`, dir).status, 0);
    const after = parseEnv(sEnvOf(dir));
    for (const name of S_SUPPLIER) assert.notEqual(after[name], parseEnv(before)[name], `${name} is a new value`);
    assert.equal(after.SERVICE_AUTH_HEADER, parseEnv(before).SERVICE_AUTH_HEADER, 'the token is untouched');
  });
});

test('Snippets RUNBOOK step 4 in bash: run again, in a new shell, nothing is made again and nothing is replaced: the file is the same bytes, no keypair is asked for, and every guard says so', NEEDS_BASH, () => {
  const { head, supplier, token } = sStep4();
  withSnippetsFolder((dir) => {
    assert.equal(runBash(`${S_STUBS}${head}${supplier}${token}`, dir).status, 0);
    const before = sEnvOf(dir);
    const again = runBash(`${S_STUBS}${head}${supplier}${token}`, dir);
    assert.equal(sEnvOf(dir), before, 'byte for byte');
    assert.equal(countOf(dir), 2, 'gen-keypair once and openssl once, both in the first run');
    assert.equal(again.stdout, '');
    for (const refusal of [
      'refusing: the env file exists, and it is kept as it is',
      'refusing: SUPPLIER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
      'refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first',
    ]) assert.ok(again.stderr.includes(refusal), refusal);
    assert.doesNotMatch(again.stdout + again.stderr, /[0-9a-f]{16}|Bearer/);
    // The first block on its own is only the file and the functions, and it leaves a file that is there.
    const alone = runBash(`${S_STUBS}${head}`, dir);
    assert.equal(sEnvOf(dir), before);
    assert.match(alone.stderr, /^refusing: the env file exists, and it is kept as it is\n$/);
  });
});

test('Snippets RUNBOOK step 4 in bash: the token is made again alone after its line was emptied with the command of the failure table, and only while it is empty; the supplier key is the same', NEEDS_BASH, () => {
  const { head, supplier, token } = sStep4();
  const emptyToken = `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.audio-snippets`;
  assert.ok(section(sRunbook, 'If something goes wrong').includes('`' + emptyToken + '`'), 'the failure table gives the command that empties the token line');
  withSnippetsFolder((dir) => {
    runBash(`${S_STUBS}${head}${supplier}${token}`, dir);
    const before = parseEnv(sEnvOf(dir));
    assert.equal(runBash(`${emptyToken}\n`, dir).status, 0);
    assert.equal(parseEnv(sEnvOf(dir)).SERVICE_AUTH_HEADER, '""', 'empty, in quotes, as in the example');
    assert.equal(runBash(`${S_STUBS}${head}${token}`, dir).status, 0);
    const after = parseEnv(sEnvOf(dir));
    assert.match(after.SERVICE_AUTH_HEADER, /^"Bearer [0-9a-f]{64}"$/);
    assert.notEqual(after.SERVICE_AUTH_HEADER, before.SERVICE_AUTH_HEADER, 'a new token');
    for (const name of S_SUPPLIER) assert.equal(after[name], before[name], `${name} untouched`);
    // Once it has a value, the token block refuses again.
    const refused = runBash(`${S_STUBS}${head}${token}`, dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first/);
    assert.equal(parseEnv(sEnvOf(dir)).SERVICE_AUTH_HEADER, after.SERVICE_AUTH_HEADER);
  });
});

test('Snippets RUNBOOK step 4 in bash: the functions make nothing where there is no env file, and say so', NEEDS_BASH, () => {
  const { head } = sStep4();
  const functionsOnly = head.slice(0, head.indexOf('if [ -e .env.audio-snippets ]; then'));
  assert.ok(functionsOnly.includes('keypair_into() {') && functionsOnly.includes('token_into() {') && !functionsOnly.includes('cp .env'));
  withSnippetsFolder((dir) => {
    const missing = runBash(`${S_STUBS}${functionsOnly}keypair_into SUPPLIER\nrc1=$?\ntoken_into\nrc2=$?\necho "rc $rc1 $rc2"\n`, dir);
    assert.equal(missing.stdout.trim(), 'rc 1 1');
    assert.equal(missing.stderr.match(/refusing: there is no \.env\.audio-snippets in this folder/g)?.length, 2);
    assert.equal(existsSync(join(dir, '.env.audio-snippets')), false, 'the functions do not make the file');
    assert.equal(existsSync(join(dir, '.stub-n')), false, 'and call neither gen-keypair nor openssl');
  });
});

test('Snippets RUNBOOK step 4 in bash: a gen-keypair that fails writes nothing and the block can be run again, and an openssl that gives too little writes no token', NEEDS_BASH, () => {
  const { head, supplier, token } = sStep4();
  withSnippetsFolder((dir) => {
    const failed = runBash(`${S_STUBS}docker() { return 1; }\n${head}${supplier}echo "rc $?"\n`, dir);
    assert.equal(failed.stdout.trim(), 'rc 1');
    assert.match(failed.stderr, /gen-keypair failed/);
    for (const name of S_SUPPLIER) assert.equal(parseEnv(sEnvOf(dir))[name], '', `${name} is still empty`);
    assert.equal(runBash(`${S_STUBS}${head}${supplier}`, dir).status, 0, 'run again, it makes the key');
    assert.match(parseEnv(sEnvOf(dir)).SUPPLIER_PRIV_KEY_HEX, /^[0-9a-f]{64}$/);
    const bad = runBash(`${S_STUBS}openssl() { echo abc; }\n${head}${token}echo "rc $?"\n`, dir);
    assert.equal(bad.stdout.trim(), 'rc 1');
    assert.match(bad.stderr, /openssl rand failed/);
    assert.equal(parseEnv(sEnvOf(dir)).SERVICE_AUTH_HEADER, '""');
  });
});

test('Snippets RUNBOOK step 4 in bash: the ops scripts cannot read the env file with the shell\'s "." while OPERATOR_CONTACT holds the placeholder of the example, and can once the check of the step prints 1', NEEDS_BASH, () => {
  const { head } = sStep4();
  withSnippetsFolder((dir) => {
    runBash(`${S_STUBS}${head}`, dir);
    // The ops scripts run with set -e and read the file with ".", as the Pipeline's test of the quoted token has it.
    const read = runBash('set -e\n. ./.env.audio-snippets\necho "read $OPERATOR_CONTACT"\n', dir);
    assert.notEqual(read.status, 0, 'the shell stops at the placeholder');
    assert.equal(read.stdout, '');
    assert.match(read.stderr, /syntax error/);
    writeFileSync(join(dir, '.env.audio-snippets'), sEnvOf(dir).replace(/^OPERATOR_CONTACT=.*$/m, 'OPERATOR_CONTACT=ops@example.test'));
    assert.equal(runBash("grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.audio-snippets\n", dir).stdout.trim(), '1', 'the check of step 4 prints 1');
    const filled = runBash('set -e\n. ./.env.audio-snippets\necho "read $OPERATOR_CONTACT"\n', dir);
    assert.deepEqual([filled.status, filled.stdout.trim()], [0, 'read ops@example.test']);
  });
});

test('Snippets RUNBOOK step 5: the ops scripts are copied from the adapted set of the Pipeline; the registry record is the manifest description, the capability, the framework and the public URL', () => {
  const five = section(sRunbook, '5. Adapt the ops scripts');
  const desc = /^DESC="(.+)"$/m.exec(five)[1];
  const [manifest] = inSnippets("import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => manifestFromEnv(env))));", [{ OPERATOR_CONTACT: TEST_CONTACT }]);
  assert.equal(desc, manifest.description);
  assert.ok(five.includes(`(this one is ${desc.length})`) && desc.length <= 256);
  for (const part of [
    'mkdir -p "$BASE/ops" && cd "$BASE/ops"',
    'sed -e "s#[^\\"\' =]*/\\.env\\.document-pipeline#$BASE/repo/deploy/host/.env.audio-snippets#g" \\', '-e "s#$PIPELINE_BASE/ops#$BASE/ops#g" \\', '"$PIPELINE_BASE/ops/$f" > "$f"',
    "sed -i 's#document-pipeline supplier#audio-snippets supplier#g' make-skey.py", "-e 's#^ \"name\":\"Document Pipeline\",# \"name\":\"Audio Snippets\",#'",
    "-e 's#^ \"endpoint\":\"https://mp-suppliers-pipeline.hal8.ai\"}# \"endpoint\":\"https://mp-suppliers-snippets.hal8.ai\"}#'",
    "sed -i 's#^CAPABILITIES = \\[.*\\]#CAPABILITIES = [\"audio.transcript.snippets.v1\"]#' m3-self-stake.py", "grep -il 'pipeline\\|agent.history' *.sh *.py",
  ]) assert.ok(five.includes(part), `step 5 says: ${part}`);
  const [, venv] = [...five.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(venv.startsWith('cd "$BASE/ops"\npython3 -m venv venv\n'), 'the block of the Python environment starts in the ops folder: it may run in a new shell');
  assert.ok(venv.endsWith("./venv/bin/pip show cbor2 | grep '^Version'\n./venv/bin/python -c \"import pycardano, reputation_staking\"\n"), 'and ends with the two checks of the prose');
  // What the copy of the Pipeline holds is what this copy looks for: the label, the record and the capability its step 5 wrote.
  const p5 = section(pRunbook, '5. Adapt the ops scripts');
  for (const left of ['document-pipeline supplier#g', '# "name":"Document Pipeline",#\'', '# "endpoint":"https://mp-suppliers-pipeline.hal8.ai"}#\'', 'CAPABILITIES = ["document.pipeline.ocr-summary.v1"]#\'']) assert.ok(p5.includes(left), `the copy of the Pipeline is made with: ${left}`);
});

test('Snippets RUNBOOK step 5 in bash: the copy is made from a copy of the Pipeline whose env file sits in any folder of its checkout, and holds only the paths and values of Audio Snippets', NEEDS_BASH, () => {
  const block = /```sh\n([\s\S]*?)```/.exec(section(sRunbook, '5. Adapt the ops scripts'))?.[1] ?? '';
  assert.ok(block.startsWith('mkdir -p "$BASE/ops" && cd "$BASE/ops"\n'), 'the block needs only BASE and PIPELINE_BASE');
  const dir = mkdtempSync(join(tmpdir(), 'snippets-step5-'));
  try {
    const at = (...parts) => [dir.split(sep).join('/'), ...parts].join('/');
    const DP = at('opt', 'document-pipeline');
    const AS = at('opt', 'audio-snippets');
    mkdirSync(join(dir, 'opt', 'document-pipeline', 'ops'), { recursive: true });
    // A copy of the Pipeline as its step 5 left it, its env file in the folder of the checkout it was made from.
    const env = `${DP}/repo/deploy/older/.env.document-pipeline`;
    const header = `# the scripts of ${DP}/ops, for the env file ${env}\n`;
    const stand = {
      'setup-venv.sh': `#!/bin/sh\n${header}echo "venv ok"\n`,
      'make-skey.py': `${header}KEY_DESCRIPTION = "document-pipeline supplier payment key"\nWALLET = "${DP}/ops/wallet"\n`,
      'mcp-call.sh': `#!/bin/sh\n${header}. "${env}"\n`,
      'sign-tx.py': header,
      'register-did.sh': `#!/bin/sh\n${header}. ${env}\nBODY='{\n "name":"Document Pipeline",\n "description":"Reads a document.",\n "capabilities":["document.pipeline.ocr-summary.v1"],\n "framework":"vector-service-agents",\n "endpoint":"https://mp-suppliers-pipeline.hal8.ai"}'\n`,
      'm3-self-stake.py': `${header}CAPABILITIES = ["document.pipeline.ocr-summary.v1"]\n`,
    };
    for (const [name, text] of Object.entries(stand)) writeFileSync(join(dir, 'opt', 'document-pipeline', 'ops', name), text);
    const run = runBash(`BASE='${AS}'\nPIPELINE_BASE='${DP}'\n${block}`, dir);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /^register-did\.sh$/m, 'the last grep names the scripts that read the env file of Audio Snippets');
    const copy = Object.fromEntries(Object.keys(stand).map((name) => [name, readFileSync(`${AS}/ops/${name}`, 'utf8')]));
    const all = Object.values(copy).join('\n');
    assert.equal(/pipeline|agent.history/i.test(all), false, 'nothing of the Pipeline is left in the copy');
    assert.ok(copy['register-did.sh'].includes(`. ${AS}/repo/deploy/host/.env.audio-snippets\n`) && copy['mcp-call.sh'].includes(`. "${AS}/repo/deploy/host/.env.audio-snippets"\n`), 'the scripts read the env file of Audio Snippets');
    assert.ok(copy['make-skey.py'].includes('KEY_DESCRIPTION = "audio-snippets supplier payment key"\n') && copy['make-skey.py'].includes(`WALLET = "${AS}/ops/wallet"\n`));
    for (const line of [' "name":"Audio Snippets",', ' "capabilities":["audio.transcript.snippets.v1"],', ' "framework":"vector-service-agents",', ' "endpoint":"https://mp-suppliers-snippets.hal8.ai"}']) assert.ok(copy['register-did.sh'].includes(line), line);
    assert.ok(copy['m3-self-stake.py'].includes('CAPABILITIES = ["audio.transcript.snippets.v1"]\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Snippets RUNBOOK steps 6 to 9: the one wallet supplied and checked, the identity and the stake, the service started by name and read, with the model, the limits and the 401', () => {
  const six = section(sRunbook, '6. Supply the supplier wallet with its collateral and float');
  assert.ok(six.includes('"$BASE/ops/mcp-call.sh" vector_get_utxos') && six.includes('one of exactly 5 units and one of 50'));
  const seven = section(sRunbook, '7. Register the identity');
  for (const part of ["sed -i '/^AGENT_DID=$/d' \"$BASE/repo/deploy/host/.env.audio-snippets\"", 'python3 make-skey.py', './register-did.sh', 'The record has the name `Audio Snippets`, the capability `audio.transcript.snippets.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-snippets.hal8.ai`', 'into the Identity section of `specs/audio-snippets.md`', 'remove it in Back out (point 4)']) assert.ok(seven.includes(part), part);
  assert.ok(section(sRunbook, '8. Stake in Module-3').includes('here both are the one capability `audio.transcript.snippets.v1`'));
  const nine = section(sRunbook, '9. Start the service');
  for (const part of [
    `${DC} up -d service`, 'docker logs audio-snippets-service', "fetch('http://127.0.0.1:9093/healthz')", "fetch('http://127.0.0.1:9093/agent.json')", "fetch('http://127.0.0.1:9093/', { method: 'POST', body: 'x' })",
    '[audio-snippets] listening on 0.0.0.0:9093; speech model faster-whisper-base-int8 (faster-whisper 1.2.1, ctranslate2 4.8.2, 4 threads)', '`3221225472 330`', '`503 {"ok":false,"reason":"low_disk"}`',
    'A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`', 'nor with an empty `SUPPLIER_PUB_KEY_HEX` or one that is not the public key of `SUPPLIER_PKH`',
    // The manifest v2: the canonical DID, the listed supplier key and the address of the identity registry (agents/audio-snippets/src/server.ts).
    '`vector.agent-manifest.v2` in `schema`', 'the new DID of step 7 in its canonical form `did:vector:<identifier>` in `identity.did` (the env file holds the legacy form `did:vector:agent:<policy>:<identifier>` of the same identifier)',
    'the listed supplier key `<DID>#<key hash>` in `identity.supplier_key`', 'the key hash in `keys.supplier_pkh`', 'the public key in `keys.pub_key_hex`',
    'the address of the identity registry in `identity.registry_address` (empty while `IDENTITY_POLICY_ID` is empty in the env file)',
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
  assert.equal(sRunbook.includes('controller_pkh'), false, 'the field that the manifest v2 removed');
  assert.equal(3072 * 1024 * 1024, 3221225472);
  assert.ok(nine.includes('```sh\ncd "$BASE/repo/deploy/host"\n' + `${DC} up -d service\ndocker logs audio-snippets-service\n`), 'the block that starts the service starts in this folder: it may run in a new shell');
  assert.ok(S_START.includes('listening on ${config.host}:${port}; speech model ${config.model} (faster-whisper ${versions.faster_whisper}, ctranslate2 ${versions.ctranslate2}, ${config.asr.threads} threads)'), 'the line of the code');
});

test('Snippets RUNBOOK steps 10 to 14: the copy of the install script with the vhost, the snippet and the marker of Audio Snippets, the hash, the advert with the terms of the example and the spec, the runtime on 8085, the indexer', () => {
  const ten = section(sRunbook, '10. DNS and Caddy');
  for (const part of [
    "sed -e 's#^VHOST=.*#VHOST=mp-suppliers-snippets.hal8.ai#' \\", '-e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.audio-snippets.snippet#" \\',
    '"$PIPELINE_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh', "sed -i '/^MARKER=/s#document-pipeline#audio-snippets#g' install-caddy-route.sh",
    "grep -in 'pipeline\\|history' install-caddy-route.sh", 'curl -fsS https://mp-suppliers-snippets.hal8.ai/agent.json', 'It must return the manifest of step 9, byte for byte.',
  ]) assert.ok(ten.includes(part), `step 10 says: ${part}`);
  assert.ok(section(pRunbook, '10. DNS and Caddy').includes('"$HISTORY_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh'), 'the Pipeline made its copy in its ops folder');
  // The two sentences on the last line the script printed are the Pipeline's own, for the host: the poll before step 13 is the expected end, and a record that is not there yet means run it again.
  const LAST_LINE = 'Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the host, the record is not there yet: wait for it and run the script again.';
  assert.ok(ten.includes(LAST_LINE), 'step 10 tells the operator what to read in the last line of the script');
  assert.ok(section(pRunbook, '10. DNS and Caddy').includes(LAST_LINE.replace('to the host', 'to the box')), 'and the sentences are those of step 10 of the Pipeline');
  assert.ok(ten.indexOf(LAST_LINE) < ten.indexOf('Check from any machine:'), 'before the check from outside');
  assert.match(section(sRunbook, '11. Hash the manifest'), /```sh\nnode scripts\/manifest-hash\.mjs https:\/\/mp-suppliers-snippets\.hal8\.ai\n```/);
  const blocks = [...sRunbook.matchAll(/post-advert\.ts( --dry-run)? \x5c\n((?:  --[^\n]+\n)+)/g)];
  assert.equal(blocks.length, 2, 'a dry run and the real run');
  const flags = (body) => Object.fromEntries([...body.matchAll(/--([a-z-]+) (\S+?)(?: \x5c)?(?: \| tail -1\))?$/gm)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
  const [dry, real] = blocks.map((m) => flags(m[2]));
  assert.deepEqual(dry, real);
  assert.deepEqual(real, {
    'capability-id': sExample.ADVERT_CAPABILITY_ID, model: sExample.ADVERT_MODEL, 'max-output-tokens': '8192', 'price-lovelace': sExample.ADVERT_PRICE_LOVELACE,
    'max-processing-ms': sExample.ADVERT_MAX_PROCESSING_MS, 'endpoint-url': sExample.ADVERT_ENDPOINT_URL, 'detail-uri': sExample.ADVERT_DETAIL_URI, 'detail-hash': '$DETAIL_HASH',
  });
  const twelve = section(sRunbook, '12. Post the advert');
  assert.ok(twelve.includes('The status word stays PROPOSED until step 17.'));
  assert.ok(twelve.includes('```sh\ncd "$BASE/repo/deploy/host"\nprintf \'%s\' "$DETAIL_HASH" | grep -Eq \'^[0-9a-f]{64}$\' || echo "not a sha256 hash"\nADVERT_REF=$(' + `${DC} run --rm --no-deps -T agent \\\n`), 'the real run starts in this folder and checks the hash it takes from the block above: it may run in a new shell');
  assert.ok(twelve.includes('In a new shell, set `BASE` and `DETAIL_HASH` again first.'));
  const thirteen = section(sRunbook, '13. Start the runtime');
  for (const part of [`${DC} up -d --force-recreate agent`, 'curl -s http://127.0.0.1:8085/status', 'for c in audio-snippets-agent audio-snippets-service; do', '`0 e3b0c44298fc`', 'writes an interim `102 Processing` line every 60 s']) assert.ok(thirteen.includes(part), part);
  assert.ok(section(sRunbook, '14. Check the advert on the indexer').includes('It must print `Active free audio.transcript.snippets.v1` and the hash of step 11.'));
});

test('Snippets RUNBOOK: every block that works in a folder starts with its own cd to it, so that it runs alone in a new shell once BASE is set again; the few blocks that name no folder are listed', () => {
  // The fenced sh blocks of the runbook, those in the list of Back out too (indented), with the indent taken off.
  const blocks = [...sRunbook.matchAll(/^( *)```sh\n([\s\S]*?)^\1```$/gm)].map((m) => m[2].split('\n').map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l)).join('\n'));
  assert.equal(blocks.length, 35, 'a block added or taken away is seen here');
  // What names no folder and no file of one: the two variables, the bundle made and the manifest hashed on the operator's machine (the host has no Node), the two checks in the image, the public check
  // of the manifest, the comparison of the tokens, the log of the first run.
  const NO_FOLDER = [
    'BASE=/opt/audio-snippets\n', 'git bundle create ', 'node scripts/manifest-hash.mjs ', 'docker run --rm --entrypoint python3 ', 'curl -fsS https://mp-suppliers-snippets.hal8.ai/agent.json\n',
    'for c in audio-snippets-agent audio-snippets-service; do\n', 'docker logs --tail 20 audio-snippets-service\n',
  ];
  // A cd to the repository, to this folder or to the ops folder, or the mkdir of the one that does not exist yet and the cd into it.
  const IN_A_FOLDER = /^(cd "\$BASE\/(repo\/deploy\/host|repo|ops)"|mkdir -p "\$BASE(\/ops)?" && cd "\$BASE(\/ops)?")\n/;
  const listed = new Set();
  for (const b of blocks) {
    const free = NO_FOLDER.find((start) => b.startsWith(start));
    if (free === undefined) { assert.match(b, IN_A_FOLDER, `a block that works in a folder starts with its cd: ${b.split('\n')[0]}`); continue; }
    listed.add(free);
    assert.doesNotMatch(b, /\$BASE|\.env\.audio-snippets|docker-compose\.audio-snippets\.yml|(^|\s)\.\//m, `a block of the list names no folder: ${free.trim()}`);
  }
  assert.equal(listed.size, NO_FOLDER.length, 'every block of the list is there');
  // The blocks the rule was written for are among those that start with the cd.
  const cdBlocks = blocks.filter((b) => b.startsWith('cd "$BASE/'));
  for (const needle of ["echo 'PROXY_NETWORK=", 'IMAGE=ghcr.io/', 'awk -F= ', "grep -c '^OPERATOR_CONTACT=", 'python3 -m venv venv', `${DC} up -d service`, 'ADVERT_REF=$(', 'retire-advert.ts']) assert.ok(cdBlocks.some((b) => b.includes(needle)), `the block with ${needle} starts with a cd`);
});

test('Snippets RUNBOOK: every compose command names this agent\'s compose file, every up -d names a service, and nothing uses a port or a container of the other stacks', () => {
  for (const m of sRunbook.matchAll(/docker compose ([^\n`]*)/g)) assert.match(m[1], /^-f docker-compose\.audio-snippets\.yml( |$)/, m[0]);
  const ups = sRunbook.match(/docker compose [^\n`]* up -d[^\n`]*/g);
  assert.ok(ups.length >= 5);
  for (const cmd of ups) assert.match(cmd, / up -d (--force-recreate )?(service|agent)$/, cmd);
  assert.doesNotMatch(sRunbook, /docker compose [^\n]*\brestart\b/);
  assert.doesNotMatch(sRunbook, /8083|8084|9091|9092|agent-history-(agent|service)|document-pipeline-(agent|service)/);
});

test('Snippets RUNBOOK step 15 and the first stop: a request the service accepts, the settings of the script, the log line of the code; the stop watched before step 17', () => {
  const s15 = section(sRunbook, '15. The first-party run');
  const m = /`PAYLOAD` is the request JSON for a short public-domain recording: `(\{[^`]+\})`/.exec(s15);
  assert.ok(m, 'the PAYLOAD line');
  const requestJson = m[1].replace('<https URL of a short public-domain mp3>', 'https://example.org/preamble.mp3');
  const [parsed] = inSnippets("import { parseRequest } from './src/request.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((j) => parseRequest(j))));", [requestJson]);
  assert.deepEqual(parsed, { source: { url: 'https://example.org/preamble.mp3' }, language: 'en', quotes: ['All LibriVox recordings are in the public domain.'], return_clips: false, clip_format: 'mp3' });
  for (const part of ['- `CAPABILITY_ID=audio.transcript.snippets.v1`.', '- `E2E_POLL_MS=10000`.', '- `E2E_STATE=./e2e-state-snippets.json`.', 'its section "Hiring Audio Snippets" lists them', '`[audio-snippets] job done in <ms> ms: <s> s of media; matches 1, unmatched 0, clips 0`']) assert.ok(s15.includes(part), part);
  assert.ok(S_SERVER.includes('log(`job done in ${deps.clock() - arrivedAt} ms: ${result.source.duration_s} s of media; matches ${result.matches.length}, unmatched ${result.unmatched.length}, clips ${result.clips.length}`);'));
  // What a job takes is said as it was measured: the fixture on the implementers' machine, and the first-party run of 2026-10-17 on the host, whose wall clock and length of media are
  // those of the receipt and of the result in its evidence file. The 68469 ms are the service's own log line of that job, which the evidence does not carry.
  assert.ok(s15.includes("- `E2E_POLL_MS=10000`. A job takes longer than Agent History's: allow minutes for a ten-minute file. The speech recognition of the 25 s test fixture took 2.4 s on the implementers' machine. On the host, the first-party run of 2026-10-17 took a supplier wall clock of 68485 ms for 364.303 s of media (fetch, decode, speech recognition and matching; the service's own log line said 68469 ms)."));
  const run = JSON.parse(read('docs/evidence/2026-10-17-audio-snippets-run-1.json'));
  assert.ok(s15.includes(`a supplier wall clock of ${run.receipt.wallclock_ms} ms for ${JSON.parse(run.result).source.duration_s} s of media`), 'the numbers are those of the evidence');
  assert.doesNotMatch(sRunbook, /the host is not measured/, 'the words of before the run');
  assert.doesNotMatch(sRunbook, /a minute or more/);
  // docs/E2E.md carries the same settings: the request JSON, the pause and the state file are written alike in both.
  const e2e = section(read('docs/E2E.md'), 'Hiring Audio Snippets');
  for (const setting of [m[1], 'export CAPABILITY_ID=audio.transcript.snippets.v1', 'export E2E_POLL_MS=10000', 'export E2E_STATE=./e2e-state-snippets.json']) assert.ok(e2e.includes(setting), `docs/E2E.md has the setting: ${setting}`);
  const stop = section(sRunbook, 'Watch the first stop');
  for (const part of [`time ${DC} stop service`, 'docker logs --tail 5 audio-snippets-service', "docker inspect --format '{{.State.ExitCode}}' audio-snippets-service", 'The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`.']) assert.ok(stop.includes(part), part);
  assert.ok(read('packages/service-kit/src/lifecycle.ts').includes('opts.log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);'));
  assert.ok(sRunbook.indexOf('\n## Watch the first stop\n') > sRunbook.indexOf('\n## 15. ') && sRunbook.indexOf('\n## Watch the first stop\n') < sRunbook.indexOf('\n## 16. '));
});

test('Snippets RUNBOOK step 17 and Back out: the old advert retired before the restart, the last item names the files that carry the word; the advert first, then the containers, then Caddy, then the key', () => {
  const s17 = section(sRunbook, '17. Flip the status');
  const item8 = s17.slice(s17.indexOf('8. In the repository'));
  for (const f of ['specs/audio-snippets.md', 'agents/audio-snippets/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md', ...['README.md', 'RUNBOOK-audio-snippets.md', 'docker-compose.audio-snippets.yml', 'Caddyfile.audio-snippets.snippet', '.env.audio-snippets.example'].map((f) => `deploy/host/${f}`), 'agents/audio-snippets/src/server.ts', 'agents/audio-snippets/agent.json.template', 'agents/audio-snippets/test/server.test.ts', 'agents/audio-snippets/test/spec.test.ts', 'scripts/specs.test.mjs', 'scripts/deploy.test.mjs']) {
    assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  // The word is carried as a default by the code, as the item says: deployed since the flip of 2026-10-17.
  assert.ok(S_SERVER.includes("statusChip(env.AGENT_STATUS_CHIP, 'deployed')") && S_SERVER.includes("statusSince(env.AGENT_STATUS_SINCE, '2026-10-17')"), 'the code carries the word as a default, as the item says');
  assert.equal(S_SERVER.includes("statusChip(env.AGENT_STATUS_CHIP, 'proposed')") || S_SERVER.includes("'2026-10-13'"), false, 'the default of before the flip');
  const back = section(sRunbook, 'Back out');
  const at = (needle) => { const i = back.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = ['1. Retire the advert.', 'agent/src/cli/retire-advert.ts', '2. Stop the containers', `${DC} down`, '3. Host administrator: remove the Caddy block of this agent', '4. Operator: the key.'];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places);
  assert.ok(back.includes('`shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"`'));
  assert.ok(back.includes('   ```sh\n   cd "$BASE/repo/deploy/host"\n   ' + `${DC} run --rm --no-deps -T agent \\\n     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \\\n`), 'the block that retires the advert starts in this folder: it may run in a new shell');
});

test('Snippets RUNBOOK failure table: the refusals at start, the codes of a job, the network and the health check, each as the code words it', () => {
  const table = section(sRunbook, 'If something goes wrong');
  const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| What you see |'));
  assert.ok(rows.length >= 20, `${rows.length} rows`);
  for (const row of rows) assert.equal(row.split(' | ').length, 3, `three columns: ${row.slice(0, 60)}`);
  const sources = {
    kitEnv: read('packages/service-kit/src/env.ts'), kitServer: read('packages/service-kit/src/server.ts'), start: S_START, server: S_SERVER, model: read('agents/audio-snippets/src/model.ts'),
    media: read('agents/audio-snippets/src/media.ts'), asr: read('agents/audio-snippets/src/asr.ts'), disk: read('agents/audio-snippets/src/disk.ts'), result: read('agents/audio-snippets/src/result.ts'),
  };
  for (const [row, where, quote] of [
    ['`environment variable OPERATOR_CONTACT is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SUPPLIER_PKH is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SUPPLIER_PUB_KEY_HEX is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SERVICE_AUTH_HEADER is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['must be printable ASCII', 'kitEnv', 'must be printable ASCII (it is sent as an HTTP header)'],
    ['`request refused: unauthorized (<n> since the last line of this kind)`', 'kitServer', 'request refused: unauthorized (${refusals} since the last line of this kind)'],
    ['`holds the service token, which belongs in SERVICE_AUTH_HEADER alone`', 'kitEnv', 'holds the service token, which belongs in SERVICE_AUTH_HEADER alone'],
    ['`is not the public key of SUPPLIER_PKH`', 'start', 'is not the public key of SUPPLIER_PKH'],
    ['`ffmpeg and ffprobe must be installed and on PATH`', 'media', 'ffmpeg and ffprobe must be installed and on PATH'],
    ['`the speech model is not ready`', 'asr', 'the speech model is not ready'],
    ['`cannot be written` and names the temporary directory', 'start', 'the temporary directory ${dir} cannot be written'],
    ['`environment variable WHISPER_MODEL must be one of base, small`', 'model', "environment variable WHISPER_MODEL must be one of ${WHISPER_SIZES.join(', ')}"],
    ['`disk check failed: ...`', 'server', 'disk check failed: ${failure}'], ['`disk check passed again`', 'server', "'disk check passed again'"],
    ['`low_disk`', 'disk', "new SnippetsError('low_disk'"], ['`deadline` (422)', 'result', 'deadline: 422'], ['`asr_failed` (500)', 'result', 'asr_failed: 500'], ['`clip_failed` (500)', 'result', 'clip_failed: 500'],
  ]) {
    assert.ok(table.includes(row), `the table quotes ${row}`);
    assert.ok(sources[where].includes(quote), `${where} prints ${quote}`);
  }
  for (const part of [
    '| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |',
    '| `network <name> declared as external, but could not be found` |', '| The runtime restarts and its log says `missing required env var ADVERT_REF` |',
    '`docker exec audio-snippets-agent printenv SERVICE_URL` must print `http://audio-snippets-service:9093/`', '| `invalid reference format` for the service image |',
    '| `/capability` shows an empty public key, claims fail with `wrong_supplier`, or the service stops at start with `environment variable SUPPLIER_PUB_KEY_HEX is required` |',
    '| The same, and the log says `is not the public key of SUPPLIER_PKH` |',
  ]) assert.ok(table.includes(part), `the table has: ${part}`);
  assert.doesNotMatch(table, /`network [a-z0-9_.-]+ declared as external/, 'the table names no network');
});

test('Snippets compose in docker compose config: with PROXY_NETWORK in .env the network has that name, and without it compose stops and says where to set it', { skip: HAVE_COMPOSE ? false : 'needs docker compose' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-snippets-'));
  const { PROXY_NETWORK: _shell, ...env } = process.env;
  try {
    copyFileSync(join(root, 'deploy/host/docker-compose.audio-snippets.yml'), join(dir, 'docker-compose.audio-snippets.yml'));
    copyFileSync(join(root, 'deploy/host/.env.audio-snippets.example'), join(dir, '.env.audio-snippets'));
    const config = () => spawnSync('docker', ['compose', '-f', 'docker-compose.audio-snippets.yml', 'config'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    const refused = config();
    assert.notEqual(refused.status, 0, 'compose stops with no .env');
    assert.ok(refused.stderr.includes('set PROXY_NETWORK in .env next to this compose file'), refused.stderr);
    writeFileSync(join(dir, '.env'), 'PROXY_NETWORK=test_proxy_network\n');
    const run = config();
    assert.equal(run.status, 0, run.stderr);
    const model = parseYaml(run.stdout);
    assert.deepEqual(model.networks, { proxy: { name: 'test_proxy_network', external: true } });
    for (const [name, s] of Object.entries(model.services)) assert.deepEqual(Object.keys(s.networks), ['proxy'], name);
    assert.equal(String(model.services.service.mem_limit), String(3072 * 1024 * 1024), 'the 3072m of the compose file, as compose renders it, in bytes');
    assert.equal(model.services.service.stop_grace_period, '5m30s', 'the 330s of the compose file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI: the test job installs ffmpeg and the speech model of Audio Snippets before the tests, the model fetched once at its pinned revision, and sets REQUIRE_ASR, so that a missing piece fails the tests of the real model instead of skipping them', () => {
  const steps = ci.jobs.test.steps;
  const at = (find) => steps.findIndex(find);
  const tests = at((s) => s.run === 'pnpm test');
  const apt = at((s) => typeof s.run === 'string' && s.run.includes('apt-get install'));
  const python = at((s) => s.uses === 'actions/setup-python@v5');
  const pip = at((s) => s.run === 'python -m pip install --disable-pip-version-check -r agents/audio-snippets/asr/requirements.txt');
  const cache = at((s) => s.uses === 'actions/cache@v4');
  const fetch = at((s) => s.run === 'python -I agents/audio-snippets/asr/fetch_model.py base agents/audio-snippets/.models/base');
  assert.ok(steps[apt].run.split(' ').includes('ffmpeg'), 'ffmpeg and ffprobe');
  assert.deepEqual(steps[python].with, { 'python-version': '3.11' });
  // In this order, each step needing the one before it: the tools, Python, the requirements, the cache, the fetch, then the tests (ruling R-D26).
  assert.ok([apt, python, pip, cache, fetch].every((at) => at >= 0), 'every step is there');
  assert.ok(apt < python && python < pip && pip < cache && cache < fetch && fetch < tests, 'apt, python, pip, the cache, the fetch, the tests');
  // The key of the cache is the revision the fetch script pins, so a new revision fetches anew. The fetch runs every time, with no condition: on a hit it checks
  // the size and the sha256 of each of the four files and fetches nothing, and a cache that holds something else is fetched again before the tests.
  const revision = /"base": \("([0-9a-f]{40})"/.exec(read('agents/audio-snippets/asr/fetch_model.py'))?.[1];
  assert.deepEqual(steps[cache].with, { path: 'agents/audio-snippets/.models/base', key: `whisper-base-${revision}` });
  assert.equal(steps[fetch].if, undefined, 'the fetch has no condition');
  assert.equal(steps[cache].id, undefined, 'nothing reads the outcome of the cache');
  assert.ok(read('agents/audio-snippets/asr/fetch_model.py').includes('if not wrong_files(dest, files):'), 'the script leaves a folder that is as pinned as it is');
  assert.ok(existsSync(join(root, 'agents/audio-snippets/asr/requirements.txt')));
  assert.equal(String(steps[tests].env?.REQUIRE_ASR), '1');
  assert.equal(String(steps[tests].env?.REQUIRE_POPPLER), '1');
  // The default model directory of the tests is the one the fetch writes, and the model files stay out of git.
  assert.ok(read('agents/audio-snippets/test/support.ts').includes("new URL('../.models/base', import.meta.url)"));
  assert.ok(read('.gitignore').split('\n').includes('agents/audio-snippets/.models/'));
});

test('CI: the publish job also pushes the Audio Snippets image under :latest and :<sha>, in the same job and after the same login', () => {
  const job = ci.jobs.publish;
  const builds = job.steps.filter((s) => s.uses === 'docker/build-push-action@v6');
  const snippets = builds.find((s) => s.with.file === 'agents/audio-snippets/Dockerfile');
  assert.ok(snippets && existsSync(join(root, snippets.with.file)));
  const image = sService.image.replace(/@sha256:.*$/, '');
  assert.equal(image, 'ghcr.io/apex-fusion/vector-service-agents/audio-snippets');
  assert.deepEqual(snippets.with.tags.trim().split('\n'), [`${image}:latest`, `${image}:\${{ github.sha }}`]);
  assert.equal(snippets.with.context, '.');
  assert.equal(snippets.with.push, true);
  assert.equal(snippets.with.labels, builds.find((s) => s.with.file === 'agents/agent-history/Dockerfile')?.with.labels, 'the labels of the other two');
  assert.equal(snippets.if, undefined, 'no condition of its own');
  assert.equal(builds.indexOf(snippets), 2, 'after the other two');
  assert.ok(job.steps.indexOf(snippets) > job.steps.findIndex((s) => s.uses === 'docker/login-action@v3'), 'after the login');
  assert.ok(sSection.includes('`ghcr.io/apex-fusion/vector-service-agents/audio-snippets`') && sSection.includes('`:latest`') && sSection.includes('`:<full git commit sha>`'));
});

// The image of each agent is published by CI on every merge to main, and the host builds the one it runs (ruling R-D26).
test('the deploy notes and the runbooks: CI publishes each image on every merge to main and the host still builds its own; none waits for Actions to run', () => {
  assert.ok(pSection.includes('The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/document-pipeline` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for Agent History, and the box still builds its own.'));
  assert.ok(sSection.includes('The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/audio-snippets` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for the other two, and the host still builds its own.'));
  assert.ok(section(pRunbook, '2. Build the service image and pin it').includes('CI publishes the same image under `:latest` and `:<full git commit sha>` on every merge to `main`; the box still builds its own.'));
  assert.ok(section(sRunbook, '2. Build the service image and pin it').includes('CI publishes the same image under `:latest` and `:<full git commit sha>` on every merge to `main`; the host still builds its own.'));
  assert.ok(aSection.includes('The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/advocate` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for the other three, and the host still builds its own.'));
  assert.ok(section(aRunbook, '2. Build the service image and pin it').includes('CI publishes the same image under `:latest` and `:<full git commit sha>` on every merge to `main`; the host still builds its own.'));
  for (const rel of [...PUBLIC_FILES, ...S_FILES, ...A_FILES]) assert.doesNotMatch(read(rel), /once Actions can run|until it has, the (box|host) uses/, rel);
  assert.deepEqual(ci.jobs.publish.if, "github.event_name == 'push' && github.ref == 'refs/heads/main'");
});

// ---- The run of RUNBOOK-audio-snippets.md, 2026-10-16 and 2026-10-17 ----
// The status line of the runbook says what was run (the Snippets files test above pins it). The step texts stay instructions for a first run, as those of the Pipeline's runbook do after its flip.
test('Snippets RUNBOOK: the step texts stay instructions after the run (step 7 quotes no row that is gone, step 9 pins no word), and a first run is told to start with the earlier word', () => {
  assert.equal(sRunbook.match(/No step of it has been run|what will happen/), null);
  const four = section(sRunbook, '4. Make the env file and generate the supplier key');
  assert.ok(four.includes("The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today's date: the status can honestly change only in step 17."));
  assert.doesNotMatch(four, /`proposed` since 2026-10-13|They stay so until step 17/, 'the words of before the flip');
  // Step 7 asks for the pull request that records the identity: it names the rows as they are after it.
  const seven = section(sRunbook, '7. Register the identity');
  assert.ok(seven.includes('(the DID row, the "Registry record" row and the sentence that says the agent has a registry record)'));
  assert.equal(seven.includes('Registry record, planned') || seven.includes('no registry record yet'), false);
  // Step 9 reads the word and the date the env file sets, whatever they are; step 12 still names the rows of the Identity table that say "planned" or "not in service", as the instruction it is.
  const nine = section(sRunbook, '9. Start the service');
  assert.ok(nine.includes('`status.chip` and `status.since` as the env file sets them (step 4)'));
  assert.doesNotMatch(nine, /status\.chip` `proposed`|2026-10-13/);
  const twelve = section(sRunbook, '12. Post the advert');
  assert.ok(twelve.includes('refresh the rows of the Identity table that still say "planned" or "not in service"') && twelve.includes('The status word stays PROPOSED until step 17.'));
  // Step 14 names no word and no job, and step 16 is not used for this agent.
  assert.doesNotMatch(section(sRunbook, '14. Check the advert on the indexer'), /PROPOSED|no job has settled/);
  assert.ok(section(sRunbook, '16. Wallet monitor').startsWith('\nNot used for this agent, as for Agent History and the Pipeline'));
});

// ---- Four corrections of the runbooks, learned from the run of Audio Snippets ----
// Each is made in the sentence of RUNBOOK-audio-snippets.md that the run showed wrong, and in the same words where RUNBOOK-document-pipeline.md or RUNBOOK.md carries the same sentence.
test('the four corrections of the run of Audio Snippets: the hash script runs on the machine of the operator and the host cross-checks; setup-venv.sh ends with a traceback and two checks hold; a comment line of the copied install script is expected; the setup transactions used the 5 alone as an input', () => {
  const books = { 'Agent History': runbook, 'Document Pipeline': pRunbook, 'Audio Snippets': sRunbook };
  // 1. Step 11. The host has no Node: the script runs on the operator's machine, from the root of a checkout, and the host cross-checks the raw bytes. On 2026-10-17 the two agreed before the flip and after it.
  for (const [name, book] of Object.entries(books)) {
    const eleven = section(book, '11. Hash the manifest');
    const host = name === 'Audio Snippets' ? 'host' : 'box';
    assert.ok(eleven.includes(`The script runs on the operator's machine, from the root of a checkout of the repository, with Node 22: the ${host} has no Node. It only fetches public bytes:\n\n\`\`\`sh\nnode scripts/manifest-hash.mjs https://mp-suppliers-`), `${name}: step 11 runs on the machine of the operator`);
    assert.ok(eleven.includes(`It prints one JSON line with \`detail_uri\`, \`detail_hash\` and \`bytes\`. The ${host} cross-checks the raw bytes with \`curl -fsS https://mp-suppliers-`), `${name}: the ${host} cross-checks the raw bytes`);
    assert.ok(eleven.includes(' | sha256sum`: the two must agree.'), `${name}: the two must agree`);
    assert.doesNotMatch(eleven, /on any machine with Node 22|the root is `\$BASE\/repo`|cd "\$BASE\/repo"/, `${name}: the words of before`);
  }
  assert.ok(section(sRunbook, '11. Hash the manifest').includes('On 2026-10-17 both gave `84a9b9dfc8109be1144e9e70cedc5bbf2be3942ca7f6d7fd0570729037de843c` before the flip and `059b0f6f9826eec89cfd4f7e3177152403983b926d2892bf2a472145daef879b` after it.'));
  assert.ok(SSPEC.includes('manifest hash `84a9b9dfc8109be1144e9e70cedc5bbf2be3942ca7f6d7fd0570729037de843c` (the manifest before the status flip)') && SSPEC.includes('manifest hash `059b0f6f9826eec89cfd4f7e3177152403983b926d2892bf2a472145daef879b`, retired on 2026-11-03 after the escrow switch'), 'the two hashes are those of the two adverts of 2026-10-17 in the spec, the second retired at the escrow switch');
  // 2. Step 5. setup-venv.sh ends with a traceback from its last line after everything is installed, and the venv is complete all the same: the two checks that hold. RUNBOOK.md has no such sentence.
  const TRACE = '`setup-venv.sh` does not end with `venv ok` on this ';
  const REST = ": it ends with a traceback from its last line, `module 'pycardano' has no attribute '__version__'`, after everything is installed, and the venv is complete all the same (";
  const CHECK = "). The check that holds is the last two lines of the block: `./venv/bin/pip show cbor2 | grep '^Version'` prints `Version: 5.6.5`, and `./venv/bin/python -c \"import pycardano, reputation_staking\"` exits 0.";
  assert.ok(section(sRunbook, '5. Adapt the ops scripts').includes(`${TRACE}host${REST}its packages are identical to the Pipeline's, and steps 7 and 8 ran on it${CHECK}`));
  assert.ok(section(pRunbook, '5. Adapt the ops scripts').includes(`${TRACE}box${REST}it ended so for Audio Snippets on 2026-10-16, whose venv has the same packages as this one, and steps 7 and 8 of RUNBOOK-audio-snippets.md ran on that venv${CHECK}`));
  for (const book of [sRunbook, pRunbook]) assert.equal(book.includes('`setup-venv.sh` ends with `venv ok`, and the last command must print `Version: 5.6.5`.'), false, 'the sentence of before');
  // The block ends with the two checks the prose names: the version of cbor2, then the import of pycardano and of the SDK of Module-3.
  for (const book of [sRunbook, pRunbook]) assert.match(section(book, '5. Adapt the ops scripts'), /\.\/setup-venv\.sh\n\.\/venv\/bin\/pip show cbor2 \| grep '\^Version'\n\.\/venv\/bin\/python -c "import pycardano, reputation_staking"\n```/);
  // 3. Step 10. The grep that looks for the other stacks prints the first comment line of the copy, which names the Pipeline: a comment line is expected, and a path, a name or a message must not appear.
  assert.ok(section(sRunbook, '10. DNS and Caddy').includes("The first `grep` must show the vhost, the snippet and the marker of Audio Snippets. The second prints the first comment line of the copy, which names the Pipeline: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of another stack is what must not appear: change it by hand to this agent's before the script runs, because it would act on the wrong stack."));
  assert.ok(section(pRunbook, '10. DNS and Caddy').includes("It may print a comment line of the copy: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of the other stack is what must not appear: change it by hand to this agent's before the script runs, because it would act on the wrong stack."));
  for (const book of [sRunbook, pRunbook]) assert.doesNotMatch(section(book, '10. DNS and Caddy'), /must print nothing/, 'the instruction of before');
  // 4. Collateral and float. The two transfers stay, word for word, and a paragraph after them says that the setup transactions of 2026-10-17 used the 5 alone as an input and that the
  // supplier's Claim and Submit still found collateral, so that an operator who sees the 5 gone knows that nothing went wrong.
  const USED = "the setup transactions (steps 7, 8 and 12) used the 5-unit output as an input, so it did not stay alone; the supplier's Claim and Submit still found collateral in the change.";
  assert.ok(section(sRunbook, 'Collateral and float').includes(`by an ordinary transaction.\n\nOn 2026-10-17 ${USED}\n`));
  for (const book of [runbook, pRunbook]) assert.ok(section(book, 'Collateral and float').includes(`by an ordinary transaction.\n\nOn 2026-10-17, for Audio Snippets, ${USED}\n`));
  for (const book of Object.values(books)) {
    // The cell of the supplier key says collateral, and no longer that the 5 is never touched: the setup transactions of 2026-10-17 used it as an input.
    assert.ok(section(book, 'Collateral and float').includes('exactly 5 units alone (collateral), then 50 units'), 'the instruction of the two transfers stays');
    assert.equal(section(book, 'Collateral and float').includes('(collateral, never touched)'), false, 'the words of before the run');
    assert.ok(section(book, 'Collateral and float').includes('Two transfers, because a wallet supplied in one transfer can have its collateral '), 'and so does its reason');
  }
});

// ======================================================================================================================================
// Advocate (DEPLOYED since 2026-10-20): the fourth stack on the same host.
// The four files and the section of the README are held to each other, to the service code, to the spec, and to the files of Audio Snippets they follow.
// Since Plan E2 the service buys its model call first from a chat supplier on the Vector marketplace, with a buyer key of its own and a state volume, as the
// Pipeline does: the two-key parts are held as the Pipeline's are, above.
// docker build and caddy validate are run by hand at deployment. The files name no host and no other stack (HOST_WORDS above).
// ======================================================================================================================================
const ASPEC = read('specs/advocate.md');
// Every source file of the service, as one text: a line of the log is looked for in all of them, wherever the code writes it.
const A_SRC = sourceFiles('agents/advocate/src').map((f) => read(f)).join('\n');
const aComposeText = read('deploy/host/docker-compose.advocate.yml');
const aCompose = parseYaml(aComposeText);
const aExampleText = read('deploy/host/.env.advocate.example');
const aExampleRaw = parseEnv(aExampleText);
const aExample = Object.fromEntries(Object.entries(aExampleRaw).map(([name, value]) => [name, /^"(.*)"$/.exec(value)?.[1] ?? value]));
const aRunbook = read('deploy/host/RUNBOOK-advocate.md');
const aSnippet = read('deploy/host/Caddyfile.advocate.snippet');
const aDockerfile = read('agents/advocate/Dockerfile');
const { agent: aAgent, service: aService } = aCompose.services;
const aSection = readme.split('\n## Advocate on the same host\n')[1]?.split('\n## ')[0] ?? '';
const aSpecNumber = (re) => Number(re.exec(ASPEC)?.[1]);
const A_TERMS = {
  price: aSpecNumber(/\| Price \| (\d+) \|/), supplierBond: aSpecNumber(/\| Supplier bond \| (\d+) \|/), buyerBond: aSpecNumber(/\| Buyer bond \| (\d+) \|/),
  window: aSpecNumber(/advert `max_processing_ms` \| (\d+) ms/), timeout: aSpecNumber(/Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/),
};
const A_SUPPLIER = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'];
const A_BUYER = ['ADVOCATE_BUYER_PRIV_KEY_HEX', 'ADVOCATE_BUYER_PUB_KEY_HEX', 'ADVOCATE_BUYER_PKH', 'ADVOCATE_BUYER_ADDRESS'];
const A_TOKEN = ['SERVICE_AUTH_HEADER'];
const A_API_KEYS = ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY'];
const A_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', ...RUNTIME_IDENTITY];
const A_IDENTITY = P_IDENTITY;
const A_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const A_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
const A_HIRES = ['LLM_MODEL_ALLOWLIST'];
const A_STEPS = ['Put the files on the host', 'Build the service image and pin it', 'Build the runtime image', 'Make the env file, generate the two keys and enter the two API keys', 'Adapt the ops scripts', 'Supply the two wallets with their collateral and float', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
const A_STATUS = 'DEPLOYED since 2026-10-20';
const ADC = 'docker compose -f docker-compose.advocate.yml';
// The words of the content rules, built from parts so that this file does not hold them either. The two file names of the ops scripts that hold one of them
// (payment.skey and payment.vkey, which step 7 writes) are taken out before the search: they are names, not words of the text.
const A_BANNED = new RegExp('\\b(' + ['pa' + 'y(s|ing|er|ers|ment|ments)?', 'pa' + 'id', 'ea' + 'rn(s|ed|ing|ings)?', 'mo' + 'ney', 'fun' + 'd(s|ed|ing)?', 'spe' + 'n(d|ds|ding|t)', 'reve' + 'nues?', 'gover' + 'nance'].join('|') + ')\\b', 'i');
const withoutFileNames = (text) => text.replace(/payment\.[sv]key/g, '');
// A snippet run through the real code of Advocate (tsx), with its argument passed as JSON, so that nothing here re-implements the service.
function inAdvocate(code, arg) {
  return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(arg)], { cwd: join(root, 'agents/advocate'), encoding: 'utf8' }));
}
// The settings of a service that starts: one key pair (the key hash is the blake2b-224 of the public key, computed by the code of the service), a buyer key, a
// token and two API keys of the form step 4 writes, each made of other characters than the rest, because the service refuses a secret that it finds in another setting.
const A_PUBLIC_KEY = 'ab'.repeat(32);
const A_BUYER_KEY = '01'.repeat(32);
let aEnvMade;
function aFullEnv() {
  if (aEnvMade === undefined) {
    const [keyHash] = inAdvocate("import { blake2b224Hex } from '@vsa/vector-read'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((hex) => blake2b224Hex(hex))));", [A_PUBLIC_KEY]);
    aEnvMade = {
      OPERATOR_CONTACT: TEST_CONTACT, SUPPLIER_PKH: keyHash, SUPPLIER_PUB_KEY_HEX: A_PUBLIC_KEY, SERVICE_AUTH_HEADER: `Bearer ${'cd'.repeat(32)}`,
      BRAVE_SEARCH_API_KEY: 'BSAtestkey0123456789abcdefghij', OPENROUTER_API_KEY: `sk-or-v1-${'0123456789abcdef'.repeat(4)}`, ADVOCATE_BUYER_PRIV_KEY_HEX: A_BUYER_KEY,
    };
  }
  return aEnvMade;
}
// The seconds that the failure table states about the time the model is given (src/budget.ts): the least of the job that must be left to start it. The other edges
// are the code's own: the hire ends FALLBACK_RESERVE_MS before the deadline, and the receipt is read until receiptByMs.
const A_MODEL_TIME = { startWith: 20 };
// The numbers of the code that the pack states in its text, read once through tsx from the files that own them, so that no test here holds a copy of them. The time the model
// is given is asked of the real function at the edges the table states.
let aLimitsRead;
function aLimits() {
  if (aLimitsRead === undefined) {
    [aLimitsRead] = inAdvocate(
      "import * as budget from './src/budget.ts'; import { MIN_PAGE_CHARS } from './src/html.ts'; import { PAGE_MAX_BYTES } from './src/pages.ts'; " +
      "import { ANSWER_MAX_BYTES, OPENROUTER_ENDPOINT } from './src/model.ts'; import { BRAVE_ENDPOINT, MAX_RESULTS, dedupeResults } from './src/search.ts'; import { assertSafeUrl } from '@vsa/vector-read'; " +
      "const claim = JSON.parse(process.argv[1]); const { modelBudgetMs, fetchDeadlineMs, hopDeadlineMs, receiptByMs, ...times } = budget; " +
      "const result = (url) => ({ title: '', url, description: '' }); const endpoint = (e) => { const u = new URL(e); return { protocol: u.protocol, host: u.host, port: u.port }; }; " +
      "console.log(JSON.stringify([{ ...times, MIN_PAGE_CHARS, PAGE_MAX_BYTES, MAX_RESULTS, ANSWER_MAX_BYTES, " +
      "hopEnd: times.JOB_DEADLINE_MS - hopDeadlineMs(times.JOB_DEADLINE_MS), receiptEnd: times.JOB_DEADLINE_MS - receiptByMs(times.JOB_DEADLINE_MS), " +
      "model: { full: modelBudgetMs(times.FALLBACK_RESERVE_MS), lessAfter: modelBudgetMs(times.FALLBACK_RESERVE_MS - 1), atReceiptBy: modelBudgetMs(times.JOB_DEADLINE_MS - receiptByMs(times.JOB_DEADLINE_MS)), " +
      "none: modelBudgetMs(claim.startWith * 1000 - 1), started: modelBudgetMs(claim.startWith * 1000) }, " +
      "kept: dedupeResults([result('http://example.org/a'), result('https://example.org/b')]).map((r) => r.url), " +
      "endpoints: [endpoint(BRAVE_ENDPOINT), endpoint(OPENROUTER_ENDPOINT)], resultPort: assertSafeUrl('https://example.org:8443/page').port }]));", A_MODEL_TIME);
  }
  return aLimitsRead;
}

test('Advocate compose: the project and two containers have fixed names, the runtime is on loopback port 8086, the service is published nowhere, both are on the network that PROXY_NETWORK names', () => {
  assert.equal(aCompose.name, 'advocate');
  assert.deepEqual(Object.keys(aCompose.services), ['agent', 'service']);
  assert.equal(aAgent.container_name, 'advocate-agent');
  assert.equal(aService.container_name, 'advocate-service');
  assert.deepEqual(aAgent.ports, ['127.0.0.1:8086:8080']);
  assert.equal(aService.ports, undefined);
  assert.deepEqual(aCompose.networks, { proxy: { external: true, name: PROXY_NETWORK_NAME } }, 'the network of the other three, named the same way');
  for (const [name, s] of [['agent', aAgent], ['service', aService]]) {
    assert.deepEqual(s.networks, ['proxy'], name);
    assert.deepEqual(s.env_file, [{ path: './.env.advocate', required: true }], name);
    assert.equal(s.restart, 'unless-stopped', name);
    assert.deepEqual(s.logging, sAgent.logging, `${name}: the log rotation of the other three`);
  }
  assert.deepEqual(aAgent.depends_on, ['service']);
  assert.deepEqual(aComposeText.match(/\$\{[^}]*\}?/g), [PROXY_NETWORK_NAME], 'the one interpolation in the file');
  assert.ok(aComposeText.includes('# The name of that network is not in the repository: compose reads PROXY_NETWORK from .env next to this file (RUNBOOK-advocate.md step 1), and stops while it has no value.'));
  // The loopback port of the runtime and the port of the service are this agent's own, beside those of the other three stacks of the host.
  assert.deepEqual([agent, pAgent, sAgent, aAgent].map((a) => a.ports[0].split(':')[1]), ['8083', '8084', '8085', '8086']);
  assert.deepEqual([service, pService, sService, aService].map((s) => s.environment.PORT), ['9091', '9092', '9093', '9094']);
});

test('Advocate compose: the runtime is the pinned template commit, SERVICE_URL names the service container on 9094 at /, the service holds the buyer key and not the supplier key, the runtime holds neither the buyer key nor either API key, and the token is blanked in neither', () => {
  assert.equal(aAgent.build.context, sAgent.build.context, 'the template commit of the other three');
  assert.equal(aAgent.build.dockerfile, 'agent/Dockerfile');
  assert.deepEqual(aAgent.environment, {
    CAPABILITY_KIND: 'custom', SERVICE_URL: 'http://advocate-service:9094/', SERVICE_CONTENT_TYPE: 'application/json', SERVICE_TIMEOUT_MS: '360000', ADVERT_MAX_PROCESSING_MS: '480000', PORT: '8080', PUBLIC_ORIGIN: 'https://mp-suppliers-advocate.hal8.ai',
    ADVOCATE_BUYER_PRIV_KEY_HEX: '', BRAVE_SEARCH_API_KEY: '', OPENROUTER_API_KEY: '',
  }, 'an empty string overrides the value from env_file: the runtime holds neither the buyer key nor either API key');
  assert.deepEqual(aService.environment, { PORT: '9094', HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '', ADVOCATE_STATE_DIR: '/data' }, "the supplier key is the runtime's and is blanked for the service, which reads the buyer key, the token and the two API keys from the env file");
  assert.ok(!('ADVOCATE_BUYER_PRIV_KEY_HEX' in aService.environment), 'the service reads the buyer key from the env file');
  assert.ok(!('SUPPLIER_PRIV_KEY_HEX' in aAgent.environment), 'the runtime reads the supplier key from the env file');
  assert.equal(new URL(aAgent.environment.SERVICE_URL).hostname, aService.container_name);
  assert.ok(!('SERVICE_AUTH_HEADER' in aAgent.environment) && !('SERVICE_AUTH_HEADER' in aService.environment), 'both read the token from the env file');
  assert.ok(aComposeText.includes('# Both containers read the same file and each gets only its own key: the other one is blanked in its environment below (an empty string overrides the value from env_file).'));
  assert.ok(aComposeText.includes('# The service holds the two API keys, BRAVE_SEARCH_API_KEY and OPENROUTER_API_KEY, and reads them from the env file. The runtime needs neither, so both are blanked in its environment below.'));
  assert.ok(aComposeText.includes("    # This service holds the buyer key, which posts the escrow of the chat sub-job of a job, and not the supplier key, which is the runtime's: that one is blanked here."));
  assert.ok(aComposeText.includes('the network is shared with other stacks, and a job posts an escrow from the buyer wallet.'));
  assert.doesNotMatch(aComposeText, /holds no chain key|one key and two API keys/, 'the words of before the buyer key');
  const [port] = inAdvocate("import { PORT_DEFAULT } from './src/start.ts'; console.log(JSON.stringify([PORT_DEFAULT]));", null);
  assert.equal(port, 9094);
  assert.match(aDockerfile, /^ENV NODE_ENV=production PORT=9094 HOST=0\.0\.0\.0(?: |$)/m);
  assert.match(aDockerfile, /^EXPOSE 9094$/m);
  assert.match(aDockerfile, /^HEALTHCHECK .*127\.0\.0\.1:9094\/healthz/m);
});

test('Advocate compose: the window and the timeout are the spec terms and nest as the runtime requires; the deadline of a job, the memory limit and the grace period; the state volume', () => {
  assert.deepEqual([A_TERMS.window, A_TERMS.timeout], [480_000, 360_000]);
  assert.equal(Number(aAgent.environment.ADVERT_MAX_PROCESSING_MS), A_TERMS.window);
  assert.equal(Number(aAgent.environment.SERVICE_TIMEOUT_MS), A_TERMS.timeout);
  assert.ok(A_TERMS.timeout <= A_TERMS.window - 60_000, 'the runtime refuses to boot otherwise');
  const [deadline, minWindow, wait] = inAdvocate("import { JOB_DEADLINE_MS } from './src/budget.ts'; import { MIN_PROCESSING_WINDOW_MS } from './src/server.ts'; import { SHUTDOWN_WAIT_MS } from '@vsa/service-kit'; console.log(JSON.stringify([JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, SHUTDOWN_WAIT_MS]));", null);
  assert.deepEqual([deadline, minWindow, wait], [300_000, 480_000, 300_000]);
  assert.equal(minWindow, A_TERMS.window, 'the service refuses a window under the one of the spec');
  assert.ok(deadline <= A_TERMS.timeout - 60_000, 'the deadline of a job is 60 s inside the service timeout, the margin of the Pipeline');
  assert.ok(aComposeText.includes('# SERVICE_TIMEOUT_MS sits 120 s inside the 8 min window of the advert (the runtime refuses to boot unless it is at least 60 s inside), and the service'));
  assert.ok(aComposeText.includes('# answers a job within 300000 ms of its arrival, so a job ends with a result or a refusal before the runtime gives up on it; a hire in its Accept at that'));
  assert.equal(aService.mem_limit, '1024m');
  assert.equal(aService.stop_grace_period, '330s');
  assert.equal(Number(/^(\d+)s$/.exec(aService.stop_grace_period)?.[1]), wait / 1000 + 30, 'the grace period is the wait of the service and 30 s more');
  assert.ok(aComposeText.includes('# On SIGTERM the service takes no new job and waits up to 300 s for the one that is running, its Accept included; the 30 s more than that are for it to'));
  assert.match(aComposeText, /A grace period of 300 s or less kills a job under escrow mid-run, or the service before it can say what it left\./);
  // The memory the comment accounts for is the code's: the pages a job holds (the results it keeps) and the most of each.
  const L = aLimits();
  assert.ok(aComposeText.includes(`# One job at a time holds at most ${L.MAX_RESULTS} pages of at most ${L.PAGE_MAX_BYTES / 1_048_576} MB each and their text in memory`));
  // The state: a named volume at /data, which ADVOCATE_STATE_DIR names, the default of the code, and which the image makes its own.
  assert.deepEqual(aService.volumes, ['advocate-state:/data']);
  assert.deepEqual(aCompose.volumes, { 'advocate-state': { name: 'advocate-state' } }, 'named, so that the volume has the name the runbook gives');
  assert.equal(aAgent.volumes, undefined, 'the runtime keeps no state');
  const [stateDirDefault] = inAdvocate("import { STATE_DIR_DEFAULT } from './src/start.ts'; console.log(JSON.stringify([STATE_DIR_DEFAULT]));", null);
  assert.equal(aService.environment.ADVOCATE_STATE_DIR, stateDirDefault);
  assert.match(aDockerfile, /^VOLUME \/data$/m);
  assert.ok(aComposeText.includes('    # stranded.json, the escrows a job left behind for the janitor, lives here and outlives the container. docker compose down keeps the volume.'));
  assert.equal(aComposeText.includes('there is no volume'), false, 'the words of before the state');
});

test('Advocate compose: the service image is named by digest (a placeholder in the repository), on one line that step 2 rewrites and step 9 checks', () => {
  assert.match(aService.image, /^ghcr\.io\/apex-fusion\/vector-service-agents\/advocate@sha256:(<digest>|[0-9a-f]{64})$/);
  assert.equal(aComposeText.split('\n').filter((l) => /^    image: /.test(l)).length, 1);
  assert.equal(parseYaml(aComposeText.replace(/^    image: .*$/m, `    image: sha256:${'ab'.repeat(32)}`)).services.service.image, `sha256:${'ab'.repeat(32)}`);
  const two = section(aRunbook, '2. Build the service image and pin it');
  for (const part of [
    'docker build -f agents/advocate/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/advocate:latest .',
    "docker image inspect --format '{{index .RepoDigests 0}}' \"$IMAGE:latest\" 2>/dev/null || docker image inspect --format '{{.Id}}' \"$IMAGE:latest\"",
    'sed -i "s|^    image: .*|    image: $PIN|" docker-compose.advocate.yml', '`invalid reference format`', '`docker image prune -a`',
  ]) assert.ok(two.includes(part), `step 2 says: ${part}`);
  assert.ok(section(aRunbook, '9. Start the service').includes("grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/advocate@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.advocate.yml"));
});

test('Advocate env example: the blocks in order (supplier, buyer, token, API keys, chain, identity deployment, advert, manifest, hires), known names only, each once; every secret empty, nothing key-shaped but the published values of the identity registry; the header says two keys, a token and two API keys, and where the network is named', () => {
  assert.deepEqual(Object.keys(aExample), [...A_SUPPLIER, ...A_BUYER, ...A_TOKEN, ...A_API_KEYS, ...A_CHAIN, ...A_IDENTITY, ...A_ADVERT, ...A_MANIFEST, ...A_HIRES]);
  assert.deepEqual(keyProblems(withoutPublished(aExample)), []);
  assert.deepEqual(keyProblems(aAgent.environment), []);
  assert.deepEqual(keyProblems(aService.environment), []);
  for (const name of [...A_SUPPLIER, ...A_BUYER, ...A_TOKEN, ...A_API_KEYS, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(aExample[name], '', `${name} is filled by the runbook`);
  for (const name of [...A_IDENTITY, 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY]) assert.equal(aExample[name], IDENTITY_MAINNET[name], `${name} is the value that the identity registry deployment published`);
  assert.equal(aExample.IDENTITY_ADDRESS, '', 'IDENTITY_ADDRESS stays empty: the address of IDENTITY_POLICY_ID');
  // The two identity lines of the manifest have the same comments in the three examples, and the identity registry deployment the same in the two that hire.
  for (const text of [pExampleText, sExampleText, aExampleText]) {
    assert.match(text, /^# IDENTITY_POLICY_ID: the policy ID of the identity registry, 56 lowercase hex characters, as its deployment publishes it: here the policy that the deployment on\n# Vector mainnet published on 2026-11-03\. The runtime reads it too\. Empty: the identity registry is not configured\.\n# The manifest publishes the address of this policy as identity\.registry_address, empty while this line is empty\./m);
    assert.match(text, /^# IDENTITY_ADDRESS: the address of the identity registry\. Empty means the address of IDENTITY_POLICY_ID\. A value needs IDENTITY_POLICY_ID and must be the address of that policy\.\nIDENTITY_ADDRESS=$/m);
    assert.ok(text.includes('# The escrow and the advert that carry an agent_id (the runtime): the reference scripts that the identity registry deployment on Vector mainnet published\n# on 2026-11-03. Keep ESCROW_REF_UTXO and ADVERT_REF_UTXO above while legacy escrows exist.'), 'the runtime lines say what they are and that the legacy pair stays');
  }
  for (const text of [pExampleText, aExampleText]) {
    assert.ok(text.includes('are its two deployment values, under the names the MCP server reads: set both or neither.'), 'both deployment values or neither');
    assert.ok(text.includes('IDENTITY_POLICY_ID below must be the identity policy they give,\n# or the service stops at start and names the variables.'), 'the check at start');
    assert.ok(text.includes('They hold the values that the deployment\n# on Vector mainnet published on 2026-11-03; empty lines mean legacy adverts and escrows only.'), 'the published values');
    assert.match(text, /^# VECTOR_IDENTITY_ESCROW_REF_UTXO: the reference-script UTxO of the escrow of the identity marketplace, <64 hex>#<index>\. The Accept and the Reclaim of such an escrow need it, so it is required with the two values above\.\nVECTOR_IDENTITY_ESCROW_REF_UTXO=4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0$/m);
  }
  assert.equal(aExampleRaw.SERVICE_AUTH_HEADER, '""', 'empty and in quotes');
  for (const name of A_API_KEYS) assert.equal(aExampleRaw[name], '', `${name} is empty and has no quotes: a key is letters, digits, dots, hyphens and underscores`);
  assert.match(aExample.OPERATOR_CONTACT, PLACEHOLDER);
  assert.equal(aExample.OPERATOR_CONTACT, example.OPERATOR_CONTACT, 'the same placeholder as the other three');
  const [first, second, third, fourth] = aExampleText.split('\n');
  assert.equal(first, '# Copy to .env.advocate next to the compose file (mode 600). Names and placeholders only: this example holds no key, no secret and no usable token (SERVICE_AUTH_HEADER and the two API keys are empty here).');
  assert.equal(second, "# The copy holds two keys, the supplier key (the runtime's) and the buyer key (the service's), the token between the two containers and the two API keys of the service, and it never enters git: the repository's .gitignore covers .env.* except *.example.");
  assert.equal(third, `# Status: ${A_STATUS}. The status word the manifest carries is AGENT_STATUS_CHIP below.`);
  assert.equal(fourth, "# The external network of the host's reverse proxy is not named here: compose reads PROXY_NETWORK from .env next to the compose file (RUNBOOK-advocate.md step 1).");
  assert.equal(/^PROXY_NETWORK=/m.test(aExampleText), false, 'compose would not read it here');
  assert.ok(aExampleText.includes('The service reads the public key and the key hash, publishes both in the manifest, and stops at start when the public key is empty or is not the one of the key hash.'));
  assert.ok(read('.gitignore').split('\n').includes('.env.*') && /^\.env\..*$/.test('.env.advocate') && /^\.env\..*\.example$/.test('.env.advocate.example'), 'the copy is covered by the rule the header quotes');
  // The buyer block, in the words of the Pipeline's: what the key is for, why it is a key of its own, and what the start checks.
  const lines = aExampleText.split('\n');
  const at = lines.indexOf('ADVOCATE_BUYER_PRIV_KEY_HEX=');
  assert.equal(lines[at - 3], 'SUPPLIER_ADDRESS=', 'right after the supplier block');
  assert.deepEqual(lines.slice(at - 2, at), [
    '# The buyer (from the second gen-keypair, same step). The service posts the escrow of the chat sub-job of a job with this key. It is a separate key, so that the service\'s Posts and the supplier key\'s Claims never contend for the same outputs, and it is never the buyer key of another agent: two services that hold one wallet would contend for its outputs.',
    '# The runtime does not get it: the compose file blanks it there. The service derives the key hash and the address from the key and stops at start when ADVOCATE_BUYER_PKH or ADVOCATE_BUYER_ADDRESS says something else.',
  ]);
  assert.ok(pExampleText.includes('# The runtime does not get it: the compose file blanks it there. The service derives the key hash and the address from the key and stops at start when PIPELINE_BUYER_PKH or PIPELINE_BUYER_ADDRESS says something else.'), 'the words of the Pipeline, with the names of Advocate');
  assert.ok(aExampleText.includes('# and the identity lines above (the supplier key hash and public key, the buyer key hash), must be final before the hash is taken.'));
});

test('Advocate env example: the two API key lines are empty after the token, and their comments say that the operator enters each by hand on the host in step 4, that neither is pasted into a chat or printed, and that the service does not start without them; OPENROUTER_MODEL is optional and left unset', () => {
  const lines = aExampleText.split('\n');
  const at = lines.indexOf('BRAVE_SEARCH_API_KEY=');
  assert.ok(at > 0, 'the line is there, empty');
  assert.equal(lines[at + 1], 'OPENROUTER_API_KEY=');
  assert.equal(lines[at - 5], 'SERVICE_AUTH_HEADER=""', 'after the token');
  assert.equal(lines[at + 2], '# Chain', 'before the chain block');
  assert.deepEqual(lines.slice(at - 4, at), [
    '# The two API keys of the service: the key of the Brave Search API, sent with its two search queries, and the key of OpenRouter, sent with its one model call when the hire of a chat supplier fails. The compose file blanks both for the runtime.',
    '# The operator enters each by hand on the host (RUNBOOK-advocate.md step 4, "Make the env file, generate the two keys and enter the two API keys"), read with read -rs, so that it is on no screen and in no shell history.',
    '# Neither is ever pasted into a chat or printed. The service does not start without them (environment variable BRAVE_SEARCH_API_KEY is required, and the same for OPENROUTER_API_KEY).',
    '# Empty here on purpose. A key is letters, digits, dots, hyphens and underscores, so it needs no quotes; step 4 refuses any other character, and a value under 20 characters.',
  ]);
  // OPENROUTER_MODEL is described and not set, not even as a commented line: the default of the code holds, and the manifest the advert hashes names it.
  assert.equal(/^#?\s*OPENROUTER_MODEL=/m.test(aExampleText), false);
  assert.ok(aExampleText.includes('# Left unset on purpose: AGENT_VERSION (the service has its own default), VECTOR_MARKETPLACE_INDEXER_URL, VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL and VECTOR_SUBMIT_URL (the defaults of the code are Vector mainnet\'s),\n# and OPENROUTER_MODEL, which is optional: the model the service asks, as <provider>/<name>, deepseek/deepseek-v4-flash while it is not set. The manifest names it in a gap,\n# and so does the model of a result on the OpenRouter path, so a value set here changes the manifest the advert hashes.\n'));
  // The gap of the model names OPENROUTER_MODEL (src/gaps.ts), and a result names it on the OpenRouter path; on the marketplace path a result names the model of the
  // advert hired (src/inference.ts), so "every result" is not said.
  assert.equal(aExampleText.includes('every result names it'), false, 'the words of before the model row of the spec');
  const inferenceText = read('agents/advocate/src/inference.ts');
  assert.ok(inferenceText.includes("path: 'openrouter', model: deps.openRouterModel,") && inferenceText.includes("path: 'marketplace', model: supplier.model,"));
  const [modelGap] = inAdvocate("import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify([manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test', OPENROUTER_MODEL: 'example/another-model' }).gaps[4]]));", null);
  assert.ok(modelGap.includes('example/another-model'), `the gap of the model names it: ${modelGap}`);
  const [model] = inAdvocate("import { DEFAULT_MODEL } from './src/model.ts'; console.log(JSON.stringify([DEFAULT_MODEL]));", null);
  assert.equal(model, 'deepseek/deepseek-v4-flash');
});

test('Advocate env example: every name the service code reads is in the example, in the compose environment, or has a default in the code; the runtime gets every name the template lists', () => {
  // The service hires through packages/hire-kit on packages/buyer-core, which read the chain endpoints: their names are read too.
  const files = [...sourceFiles('agents/advocate/src'), ...sourceFiles('packages/service-kit/src'), ...sourceFiles('packages/vector-read/src'), ...sourceFiles('packages/buyer-core/src'), ...sourceFiles('packages/hire-kit/src')];
  const names = new Set(files.flatMap((f) => [...envNamesIn(read(f))]));
  // The start reads each API key through one function, as env[key.name], the name held by a constant of src/start.ts ({ name, what, why }): those names are read too.
  const keyNames = [...A_SRC.matchAll(/\{ name: '([A-Z][A-Z0-9_]*)', what: '/g)].map((m) => m[1]);
  assert.deepEqual(keyNames, A_API_KEYS, 'the constants of the two keys');
  for (const n of keyNames) names.add(n);
  // Left unset on purpose: the defaults of the code. OPENROUTER_MODEL is optional, deepseek/deepseek-v4-flash by default (the test above); the chain endpoints and the
  // indexer are Vector mainnet's in packages/buyer-core; the ceiling of the chat job is 1000000 lovelace in the code, and the example carries it commented. The two limits of the bonds of
  // the chat advert have no default: there is no limit while they are not set.
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'KOIOS_URL', 'INDEXER_URL', 'OPENROUTER_MODEL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_KOIOS_URL', 'VECTOR_EXPLORER_URL', 'VECTOR_BLOCKFROST_URL', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE'];
  assert.deepEqual([...names].filter((n) => !(n in aExample) && !(n in aService.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in aExample), `${n} stays unset in the example`);
  assert.match(aExampleText, /^# LLM_MAX_PRICE_LOVELACE=1000000$/m, 'the ceiling is in the example, commented, at the default of the code');
  // The two limits of the bonds are in the example too, commented, at the value that the runbook recommends, and no compose file gives them a value (the operator sets them in the env file).
  for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) {
    assert.ok(names.has(name), `the service reads ${name}`);
    assert.ok(aExampleText.split('\n').includes(`# ${name}=2000000`), `${name} is in the example, commented, at the recommended value`);
    assert.ok(!(name in aService.environment) && !(name in aAgent.environment), `${name} has no value in the compose file`);
  }
  for (const n of ['OPERATOR_CONTACT', 'ADVOCATE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER', ...A_API_KEYS, 'OPENROUTER_MODEL', 'ADVOCATE_STATE_DIR', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE']) assert.ok(names.has(n), `the service reads ${n}`);
  assert.ok(!names.has('SUPPLIER_PRIV_KEY_HEX'), "no source of the service reads the supplier key: it is the runtime's");
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', ...RUNTIME_IDENTITY, 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT', 'PUBLIC_ORIGIN'];
  assert.deepEqual(NEEDED.filter((n) => !(n in aExample) && !(n in aAgent.environment)), []);
});

test('Advocate RUNBOOK step 4: one paragraph on the limits of the bonds of the chat advert names the two settings, the value of the example and the fall back to OpenRouter that they give', () => {
  const four = section(aRunbook, '4. Make the env file, generate the two keys and enter the two API keys');
  const paragraphs = four.split('\n\n').filter((p) => p.includes('LLM_MAX_SUPPLIER_BOND_LOVELACE') || p.includes('LLM_MAX_BUYER_BOND_LOVELACE'));
  assert.equal(paragraphs.length, 1, 'one paragraph');
  for (const part of ['`LLM_MAX_SUPPLIER_BOND_LOVELACE`', '`LLM_MAX_BUYER_BOND_LOVELACE`', '`LLM_MAX_PRICE_LOVELACE`', '`2000000`', 'recreate the service', '`llm_supplier_unavailable`', 'gets its brief from OpenRouter']) assert.ok(paragraphs[0].includes(part), part);
  for (const name of ['LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE']) assert.ok(aExampleText.split('\n').includes(`# ${name}=2000000`), `${name} has the value of the paragraph in the example`);
});

test('Advocate env example: the chain values are those of the other three, the advert terms are the spec, the endpoint is the fourth hostname, the status word is deployed since 2026-10-20, and the manifest it produces is the default one with the published identity registry', () => {
  for (const name of A_CHAIN) assert.equal(aExample[name], sExample[name], name);
  assert.deepEqual([aExample.ADVERT_CAPABILITY_ID, aExample.ADVERT_MODEL], ['research.advocate.onesided.v1', 'advocate-v1']);
  assert.ok(ASPEC.includes(`The model string in the advert and in every receipt is \`${aExample.ADVERT_MODEL}\`.`));
  assert.deepEqual([aExample.ADVERT_PRICE_LOVELACE, aExample.ADVERT_SUPPLIER_BOND_LOVELACE, aExample.ADVERT_BUYER_BOND_LOVELACE, aExample.ADVERT_MAX_PROCESSING_MS].map(Number), [A_TERMS.price, A_TERMS.supplierBond, A_TERMS.buyerBond, A_TERMS.window]);
  assert.deepEqual([A_TERMS.price, A_TERMS.supplierBond, A_TERMS.buyerBond], [3_000_000, 1_000_000, 1_000_000]);
  assert.equal(aExample.ADVERT_ENDPOINT_URL, 'https://mp-suppliers-advocate.hal8.ai');
  assert.equal(aExample.ADVERT_DETAIL_URI, `${aExample.ADVERT_ENDPOINT_URL}/agent.json`);
  assert.ok(DESIGN.includes('`mp-suppliers-advocate.hal8.ai`'));
  assert.deepEqual([aExample.AGENT_STATUS_CHIP, aExample.AGENT_STATUS_SINCE], ['deployed', '2026-10-20'], 'the advert is Active, one first-party job has settled and the first stop was watched (step 17), which shows that the path works and is not demand, so nothing may claim live');
  // The comment says what the word is, who changes it, and what a first run starts with.
  assert.match(aExampleText, /^# The status word the manifest carries, and since when: deployed since 2026-10-20, after the advert was Active, a first-party job had settled and the first stop had been watched \(RUNBOOK-advocate\.md step 17, "Flip the status"\)\. A first-party run is not demand, so the word is not live\.$/m);
  assert.match(aExampleText, /^# On a first run, before any job has settled, set proposed and today's date here; step 17 changes them\.$/m);
  assert.doesNotMatch(aExampleText, /the day the agent was specified|proposed since 2026-10-13/, 'the words of before the flip');
  // The allowlist is the default of the code (ruling R-F6): the model of OPENROUTER_MODEL, so that both paths ask the same model; the start reads the example's line as that.
  const [byDefault, byExample] = inAdvocate(
    "import { loadConfig } from './src/start.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => { const c = loadConfig(env); return { allowlist: c.allowlist, ceiling: String(c.maxPriceLovelace), model: c.model }; })));",
    [aFullEnv(), { ...aFullEnv(), LLM_MODEL_ALLOWLIST: aExample.LLM_MODEL_ALLOWLIST }],
  );
  assert.deepEqual(byDefault, { allowlist: [byDefault.model], ceiling: '1000000', model: 'deepseek/deepseek-v4-flash' });
  assert.deepEqual(byExample, byDefault, 'the line of the example is the default, written out');
  // "with no space": the ops scripts read the file with the shell's ".", which runs what follows a space as a command (the test of it in bash is below).
  assert.ok(aExampleText.includes('# The chat models it may hire for the brief on the Vector marketplace, comma separated with no space, in order of preference (the ops scripts read this file with the\n# shell\'s ".", and a space after a comma would make the rest a command). The default is the model of OPENROUTER_MODEL, so that the chat supplier and OpenRouter are asked\n# the same model: a change of OPENROUTER_MODEL takes the same change here. The manifest names the first model of the list in a gap, beside the model of OPENROUTER_MODEL\n# when the two differ, so a change of either changes the manifest the advert hashes.\n'));
  // The ceiling: no advert above it is chosen or hired (the selection is given it, and the advert is checked against it on the ledger), and when the choice finds
  // none the job falls back to OpenRouter before anything is posted.
  assert.ok(aExampleText.includes('# The most the chat job may be priced at, in lovelace. An advert priced above it is not hired, and when no advert at or under it can be, the job gets its brief\n# from OpenRouter (llm_supplier_unavailable) and locks nothing.'));
  const select = read('packages/hire-kit/src/select.ts');
  assert.ok(select.includes('allowlist: query.allowlist, probe: true, maxPriceLovelace: ceiling, budgetMs, maxCandidates })') && select.includes('if (advert.price_lovelace > ceiling) throw unavailable('));
  assert.ok(read('agents/advocate/src/inference.ts').includes("} catch { return fallBack('llm_supplier_unavailable', 'choice'); }"));
  const [withExample, withNothing] = inAdvocate(
    "import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => manifestFromEnv(env))));",
    [{ ...withoutPlaceholders(aExample), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }],
  );
  assert.equal(withExample.identity.registry_address, IDENTITY_MAINNET_ADDRESS, 'the published policy gives the published address');
  assert.deepEqual({ ...withExample, identity: withNothing.identity }, withNothing, 'the example changes nothing else in the manifest the advert will hash');
  assert.deepEqual(withExample.status, { chip: 'deployed', since: '2026-10-20' });
  assert.equal(withExample.terms.price_lovelace, A_TERMS.price);
  assert.equal(withExample.terms.max_processing_ms, A_TERMS.window);
  assert.equal(withExample.capability_id, aExample.ADVERT_CAPABILITY_ID);
});

test('Advocate env example: settings of the form step 4 writes start the service; each of the seven it requires is refused, naming it, when it is not set; a public key that is not the key of SUPPLIER_PKH, a buyer key hash that is not the key\'s, and the buyer key or an API key found in another setting are refused, and no refusal shows a value', () => {
  const env = aFullEnv();
  const code = "import { loadConfig } from './src/start.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => { try { const c = loadConfig(env); return { token: c.authHeader.length, brave: c.braveApiKey.length, openRouter: c.openRouterApiKey.length, model: c.model, port: c.port, buyer: c.buyer.pkh, address: c.buyer.address, stateDir: c.stateDir }; } catch (e) { return { error: e.message }; } })));";
  const REQUIRED = ['OPERATOR_CONTACT', 'ADVOCATE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER', ...A_API_KEYS];
  const without = (name) => Object.fromEntries(Object.entries(env).filter(([n]) => n !== name));
  const [buyer] = inAdvocate("import { buyerIdentityOf } from '@vsa/buyer-core'; console.log(JSON.stringify([buyerIdentityOf(JSON.parse(process.argv[1]))]));", A_BUYER_KEY);
  const [accepted, ...refused] = inAdvocate(code, [
    env, ...REQUIRED.map(without), { ...env, SUPPLIER_PUB_KEY_HEX: 'ef'.repeat(32) }, { ...env, ADVOCATE_BUYER_PKH: 'a'.repeat(56) },
    { ...env, AGENT_DID: `did:${env.BRAVE_SEARCH_API_KEY}` }, { ...env, ADVERT_EXPLORER_URL: `https://example.test/${env.OPENROUTER_API_KEY}` }, { ...env, AGENT_DID: `did:${A_BUYER_KEY}` },
  ]);
  assert.deepEqual(accepted, {
    token: 71, brave: env.BRAVE_SEARCH_API_KEY.length, openRouter: env.OPENROUTER_API_KEY.length, model: 'deepseek/deepseek-v4-flash', port: 9094,
    buyer: buyer.buyerPkh, address: buyer.address, stateDir: '/data',
  });
  REQUIRED.forEach((name, i) => assert.match(refused[i].error ?? '', new RegExp(`^environment variable ${name} is required`), name));
  const [otherKey, otherBuyer, braveElsewhere, openRouterElsewhere, buyerElsewhere] = refused.slice(REQUIRED.length);
  assert.match(otherKey.error ?? '', /is not the public key of SUPPLIER_PKH/);
  assert.match(otherBuyer.error ?? '', /\bADVOCATE_BUYER_PKH\b.*is not the key hash of the key in ADVOCATE_BUYER_PRIV_KEY_HEX/);
  assert.match(braveElsewhere.error ?? '', /\bAGENT_DID\b/, 'the refusal names the setting that holds the key');
  assert.match(openRouterElsewhere.error ?? '', /\bADVERT_EXPLORER_URL\b/);
  assert.match(buyerElsewhere.error ?? '', /\bAGENT_DID\b.*holds the buyer key, which belongs in ADVOCATE_BUYER_PRIV_KEY_HEX alone/);
  const said = JSON.stringify(refused).toLowerCase();
  for (const secret of [env.SERVICE_AUTH_HEADER.slice('Bearer '.length), env.BRAVE_SEARCH_API_KEY, env.OPENROUTER_API_KEY, A_PUBLIC_KEY, 'ef'.repeat(32), A_BUYER_KEY]) assert.equal(said.includes(secret.toLowerCase()), false, 'a refusal names the settings and prints no value');
});

test('Advocate Caddy snippet: the site block is the fourth endpoint host, the manifest goes to the service and everything else to the runtime, the block is last, and the README shows the same block', () => {
  const lines = aSnippet.split('\n');
  const first = lines.findIndex((l) => !l.startsWith('#') && l.trim() !== '');
  const block = lines.slice(first).join('\n').trimEnd();
  assert.equal(block, 'mp-suppliers-advocate.hal8.ai {\n    handle /agent.json {\n        reverse_proxy advocate-service:9094\n    }\n    handle {\n        reverse_proxy advocate-agent:8080\n    }\n}');
  assert.equal(block.split('\n')[0], `${new URL(aExample.ADVERT_ENDPOINT_URL).hostname} {`);
  const comments = lines.slice(0, first).join('\n');
  assert.ok(lines.slice(0, first).every((l) => l.startsWith('#')), 'only comments before the block');
  assert.ok(comments.includes("The block must stay the last thing in this file: the host administrator's install script\n# takes everything from the hostname line to the end."));
  assert.ok(comments.includes("The runtime does not serve /agent.json, and the advert's detail_uri points at it, so that one path goes to the service."));
  assert.ok(aSection.split('\n').map((l) => l.replace(/^ {3}/, '')).join('\n').includes('```\n' + block + '\n```'), 'the README shows the same block');
});

test('Advocate files: each says DEPLOYED since 2026-10-20 in its own first lines, the compose file and the snippet say that the stack is installed and running, the runbook and the README section say which steps were run and when, with the two images; none says LIVE or the words of before the flip, names the host or another stack, or holds a dash, the unit name, a person, a home path or a word the content rules ban', () => {
  assert.equal(aComposeText.split('\n')[1], `# ${A_STATUS}: installed on the host since 2026-10-18 and running since 2026-10-19, on the image rebuilt from bd8e42d that day; one first-party job settled on 2026-10-20. The order of work is RUNBOOK-advocate.md: steps 1 to 15 and 17 ran from 2026-10-18 to 2026-10-20, as its first paragraph says. The host administrator's part is README.md.`);
  assert.ok(aSnippet.split('\n')[1].startsWith(`# ${A_STATUS}: installed and running on the host. It was installed on 2026-10-19, at step 10 of RUNBOOK-advocate.md, by a copy of the host administrator's install script (install-caddy-route.sh, from the ops folder of Audio Snippets), which merges it and reloads Caddy (README.md).`));
  assert.equal(aExampleText.split('\n')[2], `# Status: ${A_STATUS}. The status word the manifest carries is AGENT_STATUS_CHIP below.`);
  // The first paragraph of the runbook says what ran and when: the first image (ccbcb94), the identity, the rebuild from the merge of 2026-10-19 (bd8e42d) on the checkout of the host, the
  // advert before the buyer wallet was supplied, the run, the first stop and the flip of 2026-10-20. Its git commands are run in the test below.
  assert.equal(aRunbook.split('\n')[2], `Status: ${A_STATUS}. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 5 were run on 2026-10-18, all but the block of the two API keys of step 4. That block, step 6 for the supplier wallet and steps 7, 8, 9 and 10 were run on 2026-10-19, with the service image of \`ccbcb94\` (the OpenRouter-only build), and the identity was registered and staked on 2026-10-19 (steps 7 and 8). The image was then rebuilt from \`bd8e42d\` (the merge of the marketplace-inference change) on 2026-10-19, and steps 1, 2, 3 and 4 were run again on the checkout of the host, which was not cloned again: in this folder (\`$BASE/repo/deploy/host\`) \`git checkout docker-compose.advocate.yml\` set aside the pin of step 2, the one local change, on which a pull would stop, \`git pull --ff-only /tmp/vector-service-agents.bundle main\` brought the new commit, which \`git log -1 --oneline\` showed, and \`.env\` and \`.env.advocate\`, which are not in git, stayed as they were; step 2 made the new pin, step 4 ran the block for the env file of the earlier run and made the buyer key, and step 9 recreated the service. Steps 11 to 14 were run on 2026-10-19, before the buyer wallet was supplied, since the advert needs only the supplier key, and step 6 for the buyer wallet, step 15, the first stop and step 17 on 2026-10-20. The first stop was watched on 2026-10-20 (the service was idle, the stop took 1 s, the log ended with the SIGTERM line and the exit code was 0). Step 16, the wallet monitor, is not used for this agent, as for the other three.`);
  assert.doesNotMatch(aRunbook, /steps 1 and 2 again for its files and its image/, 'the words of before: step 1 cannot clone again on the checkout of the host');
  assert.ok(aSection.split('\n')[1].startsWith(`Status: ${A_STATUS}. Nothing in this section is LIVE. Steps 1 to 5 of its runbook were run on 2026-10-18, all but the block of the two API keys of step 4. That block, step 6 for the supplier wallet and steps 7, 8, 9 and 10 were run on 2026-10-19, with the service image of \`ccbcb94\`, and the identity was registered and staked on 2026-10-19. The image was rebuilt from \`bd8e42d\` on 2026-10-19, with steps 1, 2, 3 and 4 run again and step 9 again. Steps 11 to 14 were run on 2026-10-19, and step 6 for the buyer wallet and steps 15 and 17 on 2026-10-20. Step 16, the wallet monitor, is not used for this agent, as for the other three. The files are `));
  // The first stop the status line reports is the one the section "Watch the first stop" asks for: the SIGTERM line in the log, and the exit code 0.
  assert.ok(section(aRunbook, 'Watch the first stop').includes('The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`.'));
  // The part of step 4 the record dates 2026-10-19 is the block of the two API keys of step 4, and the advert needs only the supplier key: step 12 posts it with the supplier key alone,
  // through the runtime. The runbook numbers its steps 1 to 17 and has no step of a letter, so the record names the block, not a step 4b.
  assert.ok(section(aRunbook, '4. Make the env file, generate the two keys and enter the two API keys').includes('apikey_into BRAVE_SEARCH_API_KEY\napikey_into OPENROUTER_API_KEY\n'));
  assert.ok(section(aRunbook, 'If something goes wrong').includes('the block of the two API keys of step 4'), 'the name the failure table gives the block');
  assert.doesNotMatch(aRunbook + aSection, /\bsteps? \d+[a-z]\b/i, 'no step of a letter: the runbook has none');
  assert.ok(section(aRunbook, '12. Post the advert').includes(`${ADC} run --rm --no-deps -T agent \\\n  node_modules/.bin/tsx agent/src/cli/post-advert.ts \\\n`), 'the advert is posted by the runtime');
  assert.equal(aAgent.environment.ADVOCATE_BUYER_PRIV_KEY_HEX, '', 'which holds the supplier key and not the buyer key');
  // DEPLOYED is said in those lines and nowhere else (the third line of the env example and of the runbook, the second line of the compose file and of the snippet), and LIVE is only ever denied.
  const STATUS_AT = { 'deploy/host/docker-compose.advocate.yml': `# ${A_STATUS}:`, 'deploy/host/Caddyfile.advocate.snippet': `# ${A_STATUS}:`, 'deploy/host/.env.advocate.example': `# Status: ${A_STATUS}.`, 'deploy/host/RUNBOOK-advocate.md': `Status: ${A_STATUS}.` };
  for (const rel of [...A_FILES, 'agents/advocate/Dockerfile']) {
    const text = read(rel);
    assert.doesNotMatch(text.replace(STATUS_AT[rel] ?? '', '').replace('Nothing in this folder is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/, `${rel}: no status claim beyond the status line`);
    assert.doesNotMatch(text, /built, not deployed|what will happen|no advert is posted|is rebuilt from this change|Before step 11 the service image|Installed: steps 1 to 10/, `${rel}: the words of before the flip`);
    assert.doesNotMatch(text, HOST_WORDS, `${rel}: names no host and no other stack`);
    assert.doesNotMatch(text, DASHES, `${rel}: no em or en dash`);
    assert.doesNotMatch(text, UNIT_NAME, `${rel}: the unit is called units`);
    assert.doesNotMatch(text, NAMES, `${rel}: roles, not people`);
    assert.doesNotMatch(text, HOME_PATH, `${rel}: no path into a home folder`);
    assert.doesNotMatch(withoutFileNames(text), A_BANNED, `${rel}: no word the content rules ban`);
    assert.match(text, /^[\x09\x0a\x20-\x7e]*$/, `${rel}: ASCII`);
  }
  assert.doesNotMatch(aSection, HOST_WORDS);
  assert.doesNotMatch(aSection.replace(`Status: ${A_STATUS}.`, '').replace('Nothing in this section is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/);
  assert.doesNotMatch(aSection, /built, not deployed|no advert is posted|rebuilt from this change/, 'the words of before the flip');
  assert.doesNotMatch(aSection, A_BANNED);
  // The guard finds each word it is there for in each of its forms (spelled in parts here too), and lets the file names of the ops scripts and the words that
  // only look alike pass.
  for (const hit of ['you ' + 'pa' + 'y', 'it ' + 'pa' + 'ys', 'it was ' + 'pa' + 'id', 'the ' + 'pa' + 'yer', 'pa' + 'yments', 'ea' + 'rned', 'fun' + 'ded by', 'spe' + 'nding', 'spe' + 'nt as change', 'reve' + 'nues']) assert.match(hit, A_BANNED, hit);
  for (const miss of ['payment.skey', 'payment.vkey', 'the PAYLOAD of step 15', 'merged into change', 'refundable', 'learned']) assert.doesNotMatch(withoutFileNames(miss), A_BANNED, miss);
});

test('Advocate README section: the fourth stack, with its two containers, the loopback port, the unpublished service port, the network of .env, the two keys and the two API keys, the calls out of the host, the state volume, the limits, the hostname, the Caddy block and the way back', () => {
  assert.ok(aSection.length > 2500, 'the section exists');
  assert.ok(readme.indexOf('\n## Advocate on the same host\n') > readme.indexOf('\n## Audio Snippets on the same host\n'), "after the section of Audio Snippets, the last of the note");
  assert.deepEqual([...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]).at(-1), 'Advocate on the same host');
  const rows = aSection.split('\n').filter((l) => l.startsWith('| `'));
  assert.deepEqual(rows.map((r) => r.split(' | ')[0]), ['| `advocate-agent`', '| `advocate-service`']);
  for (const part of [
    "[RUNBOOK-advocate.md](RUNBOOK-advocate.md), which is the operator's order of work and follows [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md) step for step",
    'The compose project is `advocate`.', "Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for the other three).",
    'the base path is the folder the operator chose for this agent (`BASE` in its runbook)',
    '- **Two keys, and two API keys.**', 'The service holds a second, separate key, the buyer key, which posts the escrow of the one chat sub-job of a job', '`BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`, which the operator enters by hand in step 4 of the runbook',
    "The compose file blanks the supplier key in the service's environment, and the buyer key and the two API keys in the runtime's. The env file holds both keys.",
    '- **A token on the service, as for the Pipeline and Audio Snippets.**', 'gets 401 before its body is read', 'Port 9094 is never published to the host all the same.',
    'the token is the second lock, and anything that holds it can start a job that posts an escrow from the buyer wallet',
    '- **Calls out of the host.**', '`api.search.brave.com`', '`openrouter.ai`', '6. **Outbound https.**', 'a job would then fail with `no_sources` (502)',
    'It calls OpenRouter at `openrouter.ai` only when that hire fails.',
    'For the hire of a chat supplier it calls the marketplace indexer, Ogmios, Koios and the submit API of Vector mainnet, and the endpoint of the supplier it chose, all over https on port 443.',
    '- **The state volume.** `advocate-state`, mounted at `/data`, holds `stranded.json`', '`docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it. `down -v` is never run. `docker volume rm` is run only when the agent will not come back, after the buyer wallet is emptied, and not while the file lists an escrow, except a Submitted one that nothing can settle (the runbook\'s Back out, point 4).',
    'because on a stop it waits up to 300 s for the job that is running, its Accept included,', '- **A window of 8 min.** The advert gives a job 8 min, and one job holds the runtime for up to 6 min.',
    'Then the containers stop, and the state volume stays.', 'It also refuses to start when `/data` cannot be written.',
    'and what the janitor of the service asks of the chain about the escrows a job left behind.', "when a buyer line is not the buyer key's or the buyer key is the supplier key",
    '`mem_limit: 1024m`', '`stop_grace_period: 330s`', '`127.0.0.1:8086`', 'ss -ltnp', 'a clash on 8086',
    '`mp-suppliers-advocate.hal8.ai`', 'DNS only (grey cloud)', 'There is no registry login and no image to pull',
    'docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile', 'docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile',
    `\`${ADC} up -d --force-recreate <service>\``, 'A change to `SERVICE_AUTH_HEADER` needs both containers recreated, and a change to an API key the service alone.',
    'The service refuses to start while `OPERATOR_CONTACT`, `ADVOCATE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX`, `SERVICE_AUTH_HEADER`, `BRAVE_SEARCH_API_KEY` or `OPENROUTER_API_KEY` is not set',
    'The env file holds both keys, the token between the containers and the two API keys.',
    '[RUNBOOK-advocate.md](RUNBOOK-advocate.md), under "Back out"',
  ]) assert.ok(aSection.includes(part), `the section says: ${part}`);
  assert.ok(!aSection.includes('retire-advert.ts'), 'the retire command lives in one place, the runbook');
  // The rule of the state volume is the one of Back out: point 2 never adds -v, and point 4 removes the volume after the buyer wallet, only when the agent will not
  // come back, with an entry listed only when its janitor line is the one of a Submitted escrow that nothing can settle (packages/hire-kit/src/janitor.ts), as the
  // Back out pin holds it.
  const point4 = section(aRunbook, 'Back out').split('\n').find((l) => l.startsWith('4. Operator: the keys and the state volume.')) ?? '';
  assert.ok(point4.includes('once `stranded.json` is `[]` or lists only escrows whose janitor line reads `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest`') && point4.includes('`docker volume rm advocate-state`'), 'point 4 of Back out has the same carve-out');
  assert.ok(point4.includes('The volume goes after the buyer wallet, and only when the agent will not come back: `docker volume rm advocate-state`.') && section(aRunbook, 'Back out').includes('Never add `-v`'), 'down -v is never run, and the volume goes last');
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes("return did('kept', `Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest`);"));
  assert.equal(aSection.includes('Neither is run while the file lists an escrow.'), false, 'the words of before the carve-out');
  assert.equal(aSection.includes('Neither is run while'), false, 'the words that let down -v through');
  assert.ok(aSection.includes(`\`mem_limit: ${aService.mem_limit}\``) && aSection.includes(`\`stop_grace_period: ${aService.stop_grace_period}\``));
  // The numbers and names the section states are the code's: the pages a job holds, the two endpoints it calls (https, on the default port, 443), and the port a page is fetched on
  // (the one its URL names).
  const L = aLimits();
  assert.ok(aSection.includes(`because one job holds at most ${L.MAX_RESULTS} pages of at most ${L.PAGE_MAX_BYTES / 1_048_576} MB each and their text`));
  assert.deepEqual(L.endpoints.map((e) => [e.protocol, e.port]), [['https:', ''], ['https:', '']]);
  const [braveHost, openRouterHost] = L.endpoints.map((e) => e.host);
  assert.equal(L.resultPort, '8443');
  assert.ok(aSection.includes(`The service calls \`${braveHost}\`, \`${openRouterHost}\` and the hosts of the result pages, all over https, on port 443 or the port that a result names.`));
  assert.equal(aSection.includes('all on port 443'), false, 'the sentence of before');
  // The hosts of the hire the section names are the defaults of packages/buyer-core: Ogmios, Koios and the submit API of Vector mainnet, and the marketplace indexer.
  const config = read('packages/buyer-core/src/vendored/mcp-shared/config.ts');
  const constants = read('packages/buyer-core/src/vendored/mcp/marketplace-constants.ts');
  for (const [name, url, where] of [['Ogmios', 'https://ogmios.vector.mainnet.apexfusion.org', config], ['Koios', 'https://v2.koios.vector.mainnet.apexfusion.org/', config], ['the submit API', 'https://submit.vector.mainnet.apexfusion.org/api/submit/tx', config], ['the marketplace indexer', 'https://mp-indexer.vector.apexfusion.org', constants]]) {
    assert.ok(where.includes(`'${url}'`), `the default of ${name} in packages/buyer-core is ${url}`);
    assert.ok(aSection.includes(`${name} at \`${new URL(url).host}\``), `the section names ${name} with its host`);
  }
  assert.ok(aSection.includes('(the chat suppliers of the fleet answer at `mp-suppliers-<name>.vector.apexfusion.org`)'));
  assert.doesNotMatch(aSection, /holds no chain key|- \*\*No state\.\*\*|There is no volume|which ends within 150 s|A window of 5 min/, 'the words of before the buyer key');
  // The opening of the note and point 1 of the list of the host administrator name the fourth stack and say which section is the last.
  assert.ok(readme.includes('Advocate is a fourth, with its own section at the end of this note, after that of Audio Snippets, and its own runbook, [RUNBOOK-advocate.md](RUNBOOK-advocate.md).'));
  assert.equal(readme.match(/built and not deployed/), null, 'the words of before the flip of Advocate');
  assert.ok(readme.includes('Advocate has its own name, `mp-suppliers-advocate.hal8.ai`, and its own section at the end of this note.'), 'point 1 of the list of the host administrator, in the form of the other two names: the name resolves since step 10');
  assert.equal(readme.match(/for Advocate, which is not built yet/), null, 'the words of before the build of Advocate');
  assert.equal(readme.match(/One more comes later/), null, 'the words of before step 10');
});

test('Advocate RUNBOOK: the twenty-two sections in order, the seventeen steps keep the numbers of the other runbooks, and the head lists what differs with the names table and the two base paths', () => {
  const numbered = A_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...aRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Take a new runtime commit', 'Back out', 'If something goes wrong']);
  const snippets = [...sRunbook.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => m[2]);
  assert.equal(snippets.length, A_STEPS.length, 'as many steps as the runbook it follows');
  // Two titles differ: step 4 makes two keys and enters the two API keys too, and step 6 supplies two wallets, in the words of the Pipeline's step 6.
  A_STEPS.forEach((title, i) => { if (i === 3 || i === 5) assert.notEqual(title, snippets[i], `step ${i + 1} is renamed`); else assert.equal(title, snippets[i], `step ${i + 1} keeps its title`); });
  assert.equal(A_STEPS[5], P_STEPS[5], "step 6 is the Pipeline's, for two wallets");
  for (const m of aRunbook.matchAll(/\bsteps? (\d+)/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= A_STEPS.length, `step ${m[1]}`);
  const quoted = [...aExampleText.matchAll(/RUNBOOK-advocate\.md step (\d+), "([^"]+)"/g)];
  assert.ok(quoted.length >= 3, 'the example names steps of the runbook');
  for (const m of quoted) assert.equal(A_STEPS[Number(m[1]) - 1], m[2], `the example quotes step ${m[1]}`);
  assert.match(aRunbook, /The operator holds the keys and does every step except two\. Step 6 \(the collateral and float of the two wallets\) is the Foundation's\. Step 10 \(DNS and Caddy\) is the host administrator's, see \[README\.md\]\(README\.md\)\./);
  assert.match(section(aRunbook, '6. Supply the two wallets with their collateral and float'), /^\nThe Foundation\. /);
  assert.match(section(aRunbook, '10. DNS and Caddy'), /^\nHost administrator, from/);
  const head = aRunbook.slice(0, aRunbook.indexOf('\n## Collateral and float\n'));
  for (const part of [
    'This is [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), the runbook of Audio Snippets, written for Advocate.', 'step N here is step N there',
    '- **Two keys, and two API keys.**', '- **A token on the service, as for the Pipeline and Audio Snippets.**', '- **A window of 8 min.**', '`max_processing_ms` is 480000', '`SERVICE_TIMEOUT_MS` is 360000', '300000 ms (300 s)',
    'the search gets at most 15 s of it and the pages at most 45 s; the waits of the hire of the chat supplier stop 95 s before the deadline, so that the call through OpenRouter still has its 90 s when the hire fails by then; a send or a poll under way then is not cut and can end a hire that fails as late as about 280 s.',
    'A hire in its Accept at the deadline runs on.', 'because a job can take as long as the runtime\'s fetch waits on silence, 300 s (step 13)',
    'because the network is shared with other stacks and a job posts an escrow from the buyer wallet',
    'The service holds a second, separate key, the buyer key, which posts the escrow of the one chat sub-job of a job, so that its Posts and the supplier key\'s Claims never contend for the same outputs',
    "The compose file blanks the supplier key in the service's environment, and the buyer key and the two API keys in the runtime's.",
    '- **Calls out of the host, and no model in the image.**', 'It calls OpenRouter only when that hire fails.', '- **State, and a clean stop.**', 'in the volume `advocate-state`, and its janitor settles them', 'its Accept included', 'a memory limit of 1024m',
    '- **The network, as for the other three.**', '- **Price 3.**', 'The advert\'s price is 3000000 lovelace and each bond 1000000.',
    "The chat sub-job of a job costs the service about 2.2 on its buyer key at today's fleet price of 0.2, against the price of 3 its supplier key receives; nothing moves from the one wallet to the other by itself (Collateral and float).",
    '| State volume | `advocate-state`, mounted at `/data` |',
    '| Base path on the host | `$BASE`, the folder the operator chooses for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |',
    '| Base path of Audio Snippets | `$SNIPPETS_BASE`, the `BASE` of RUNBOOK-audio-snippets.md: its ops scripts and its install script |',
    '| "This folder" | `$BASE/repo/deploy/host` |', '| Compose file, env file | `docker-compose.advocate.yml`, `.env.advocate` |',
    '| Containers | `advocate-agent` (the runtime), `advocate-service` |',
    '| Ports | the runtime on `127.0.0.1:8086`, loopback only; the service on 9094, never published |', '| Public name | `mp-suppliers-advocate.hal8.ai` |',
    "| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |",
    'Set both again in every new shell on the host, before the commands below:',
    'Each block that works in a folder starts with its own `cd` to it, so that it also runs alone in a new shell once the two variables are set there.',
    'The few values that a block takes from an earlier one, the functions of step 4 and `DETAIL_HASH` in step 12, are named where they matter.',
  ]) assert.ok(head.includes(part), `the head says: ${part}`);
  // The paths on the host go through the two base paths, set once at the top, before the first command that uses them.
  const block = '```sh\nBASE=/opt/advocate\nSNIPPETS_BASE=/opt/audio-snippets\n```';
  assert.ok(head.includes(block));
  assert.equal(aRunbook.split('/opt/').length, block.split('/opt/').length, 'no other absolute path on the host');
  assert.ok(aRunbook.indexOf(block) < aRunbook.indexOf('"$BASE'));
  // The facts it quotes are the code's.
  const [budget] = inAdvocate("import * as b from './src/budget.ts'; console.log(JSON.stringify([[b.JOB_DEADLINE_MS, b.SEARCH_MAX_MS, b.FETCH_PHASE_MAX_MS, b.MODEL_MAX_MS, b.FALLBACK_RESERVE_MS]]));", null);
  assert.deepEqual(budget, [300_000, 15_000, 45_000, 90_000, 95_000]);
  // A send under way when the waits of the hire stop waits up to 75 s for the Claim (packages/buyer-core/src/fleet-clients.ts): 300 - 95 + 75 = 280 s.
  assert.ok(read('packages/buyer-core/src/fleet-clients.ts').includes('const SEND_TIMEOUT_MS = 75_000;') && budget[0] - budget[4] + 75_000 === 280_000);
  assert.doesNotMatch(aRunbook, /holds no chain key|There is no volume|no second wallet|ends within 150 s|A window of 5 min/, 'the words of before the buyer key');
  assert.ok(read('packages/service-kit/src/server.ts').includes('export const HEARTBEAT_MS = 60_000;'));
});

test('Advocate RUNBOOK collateral and float: two keys, 5 alone then 50 for the supplier and 5 alone then 30 for the buyer, what a sub-job costs and holds and what 30 covers, the paragraph on the run of Audio Snippets, the two API keys apart, and the third key of step 15 with the cost of a job from the guide', () => {
  const collateral = section(aRunbook, 'Collateral and float');
  const rows = collateral.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Key |'));
  assert.equal(rows.length, 2, 'two keys');
  const [supplier, buyer] = rows;
  assert.ok(supplier.startsWith("| Supplier key (the runtime's), generated on the host in step 4 | Two transfers to its address: exactly 5 units alone (collateral), then 50 units |"));
  assert.ok(buyer.startsWith("| Buyer key (the service's), generated on the host in step 4 | Two transfers to its address: exactly 5 units alone (collateral for the Accept and the Reclaim of the chat sub-job, held back from every Post while the rest of the wallet covers that Post and its change), then 30 units |"));
  // The Post holds the collateral output back only while the rest of the wallet covers the lock, the minimum fee and a change output, and draws on the whole wallet
  // otherwise (packages/buyer-core, vendored marketplace-build.ts and fleet-build.ts), so the 5 is not "never touched".
  assert.ok(read('packages/buyer-core/src/vendored/mcp/marketplace-build.ts').includes('return total >= lockLovelace + MARKETPLACE_MIN_FEE + MIN_UTXO_LOVELACE ? rest : undefined;'));
  assert.ok(read('packages/buyer-core/src/fleet-build.ts').includes('const inputs = reserveCollateralInputs(await lucid.wallet().getUtxos(), plan.lockLovelace);'));
  assert.equal(buyer.includes('never touched'), false, 'the words of before');
  assert.ok(collateral.includes('The Foundation supplies two keys with their collateral and float. Nobody pastes either key into a chat.'));
  for (const part of [
    "The chat sub-job of each job: the price of the chat supplier, 0.2 at today's fleet price, its supplier bond of 1 and fees of about 1 (a Post and an Accept), so about 2.2 net a job.",
    'with the two fee budgets of 0.5 the service holds 3.2 to it in flight, and up to 4.0 for an advert priced at the ceiling of 1 (`LLM_MAX_PRICE_LOVELACE`, 1000000 lovelace unless the env file says otherwise)',
    'a job it does not cover locks nothing, gets its brief from OpenRouter, and its line says `insufficient_float`',
    '30 covers about 12 jobs before that happens, or one in flight and about 9 hires that failed after their Post (each with 2.2 locked and 0.5 consumed in fees) while they wait for their reclaim, 63 minutes after the Post for an advert with a window of 60 minutes.',
  ]) assert.ok(buyer.includes(part), `the buyer row says: ${part}`);
  // The figures: (30 - 3.2) / 2.2 jobs, (30 - 3.2) / (2.2 + 0.5) hires waiting for their reclaim, the fee budget of a transaction of packages/buyer-core, and the
  // deliver_by of an advert of 60 minutes, which is its window and 180 s.
  assert.deepEqual([Math.floor((30 - 3.2) / 2.2), Math.floor((30 - 3.2) / 2.7)], [12, 9]);
  assert.ok(read('packages/buyer-core/src/fees.ts').includes('export const TX_FEE_BUDGET_LOVELACE: bigint = MARKETPLACE_MIN_FEE;') && read('packages/buyer-core/src/vendored/mcp/marketplace-constants.ts').includes('export const MARKETPLACE_MIN_FEE = 500_000n;'));
  assert.ok(read('packages/buyer-core/src/vendored/mcp/marketplace-constants.ts').includes('export const DELIVER_BY_BUFFER_MS = 180_000;'));
  assert.equal((3_600_000 + 180_000) / 60_000, 63);
  assert.ok(ASPEC.includes("Its one chat sub-job costs the service about 2.2 net at today's fleet price of 0.2 per sub-job"), 'the Economics line of the page');
  assert.equal(collateral.includes('there is no second wallet'), false, 'the words of before the buyer key');
  assert.ok(collateral.includes("by an ordinary transaction.\n\nOn 2026-10-17, for Audio Snippets, the setup transactions (steps 7, 8 and 12) used the 5-unit output as an input, so it did not stay alone; the supplier's Claim and Submit still found collateral in the change.\n"));
  assert.ok(collateral.includes('The two API keys are no part of the collateral and float'));
  assert.ok(collateral.includes('The key of the first-party run (step 15) is a third key and gets no collateral or float here'));
  assert.ok(collateral.includes('A job of Advocate costs the hirer about 5 (`docs/HIRE.md`, section 3), so that key needs its 5 alone and a float of at least 7 for the run, the lock of 5 and about 2 more'));
  assert.ok(read('docs/HIRE.md').includes('| 3 (Advocate) | 5 | 4 | 1 | about 1 | about 5 | 10 |'), 'what a job costs the hirer');
  assert.equal(collateral.includes('(collateral, never touched)'), false, 'the words of before the run of Audio Snippets');
});

test('Advocate RUNBOOK steps 1 to 3: the bundle into $BASE and .env with the network, the image built and checked for Node on the host with no Python and no model, the runtime built', () => {
  const one = section(aRunbook, '1. Put the files on the host');
  for (const part of ['git bundle create vector-service-agents.bundle main', 'scp vector-service-agents.bundle <user>@<host>:/tmp/', 'mkdir -p "$BASE" && cd "$BASE"', 'git clone --branch main /tmp/vector-service-agents.bundle repo', 'cd repo/deploy/host']) assert.ok(one.includes(part), part);
  assert.ok(one.includes("```sh\ncd \"$BASE/repo/deploy/host\"\necho 'PROXY_NETWORK=<the network the host administrator names>' > .env\ndocker network inspect --format '{{.Name}}' \"$(sed -n 's/^PROXY_NETWORK=//p' .env)\"\n```"), 'step 1 writes .env in this folder and checks that the network exists');
  assert.ok(one.includes('The second line must print the name back. An error means that this host has no network of that name.'));
  assert.ok(aRunbook.indexOf("' > .env\n") < aRunbook.indexOf('docker compose -f '), '.env before the first compose command');
  const two = section(aRunbook, '2. Build the service image and pin it');
  const check = 'docker run --rm --entrypoint node ghcr.io/apex-fusion/vector-service-agents/advocate:latest -e "console.log(process.version)"';
  assert.ok(two.includes('```sh\n' + check + '\n```'), 'the check of the image is the version of its Node');
  assert.ok(two.includes('It prints one line that starts with `v22.`, the version of Node 22.'));
  assert.equal(read('.nvmrc').trim(), '22', 'the Node of the image is the one of the repository');
  assert.match(aDockerfile, /^FROM node:22-bookworm-slim\b/m);
  assert.doesNotMatch(two, /python|whisper|REQUIRE_ASR|huggingface|vitest/i, 'no Python, no model and no test run in the image');
  assert.ok(two.indexOf(check) < two.indexOf('docker image inspect'), 'checked before it is pinned');
  assert.ok(two.includes('```sh\ncd "$BASE/repo/deploy/host"\nIMAGE=ghcr.io/apex-fusion/vector-service-agents/advocate\n'), 'the block that pins starts in this folder: it may run in a new shell');
  const three = section(aRunbook, '3. Build the runtime image');
  assert.ok(three.includes(`${ADC} build agent`) && three.includes('It ends with `Image advocate-agent Built`.'));
});

// The first paragraph records how step 1 ran again, on 2026-10-19, on the checkout of the host, which was there. Its git commands run here as the paragraph gives them, read
// from its backticks, on scratch repositories in a folder of the OS temp directory and never in this repository: no GIT_ variable of the process reaches them, no
// configuration of the machine is read, and git looks for no repository above that folder. A bundle of a first commit is cloned as step 1 clones it, the pin of
// step 2 is made in the clone and the two env files are written next to it; a second commit that rewrites the compose file comes as a new bundle in the same place.
// The configuration file of that folder is the only one git reads. It holds three settings that keep git from working in the background. Without them, git 2.54 and later
// start a detached repack after a commit, a fetch or a merge. That process can still write in the repository, and make its directories again, when the removal at the end
// runs. The removal then fails with ENOTEMPTY. The removal also retries a few times for an entry that goes away by itself. Any other error stops the test.
const HAVE_GIT = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('Advocate RUNBOOK first paragraph in git: step 1 cannot clone again and a pull stops on the pin of step 2; the checkout of the compose file and the pull the paragraph records bring the new commit with its placeholder, and .env and .env.advocate stay as they are', { skip: HAVE_GIT ? false : 'needs git' }, () => {
  const first = aRunbook.split('\n')[2];
  const ticks = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const commands = ticks.filter((t) => t.startsWith('git '));
  const [checkout, pull, log] = ['git checkout ', 'git pull ', 'git log '].map((verb) => commands.find((c) => c.startsWith(verb)));
  assert.deepEqual(commands, [checkout, pull, log], 'three git commands, in the order they are run');
  for (const command of commands) assert.match(command, /^git( [\w./-]+)+$/, `plain words, so that it runs here as it is split: ${command}`);
  assert.ok(checkout.endsWith(' docker-compose.advocate.yml'), 'the checkout sets aside the compose file of this folder');
  const folder = ticks.find((t) => t.startsWith('$BASE/'));
  assert.equal(folder, '$BASE/repo/deploy/host', 'the commands run in this folder');
  // The clone of step 1 and the bundle it reads, which the pull of the paragraph reads in the same place.
  const clone = section(aRunbook, '1. Put the files on the host').split('\n').find((l) => l.startsWith('git clone ')) ?? '';
  const bundleOnHost = clone.split(' ').find((word) => word.endsWith('.bundle'));
  assert.ok(bundleOnHost !== undefined && pull.split(' ').includes(bundleOnHost), `the pull reads the bundle where step 1 puts it: ${bundleOnHost}`);
  const scratch = mkdtempSync(join(tmpdir(), 'advocate-rerun-'));
  try {
    writeFileSync(join(scratch, 'gitconfig'), '[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n[core]\n\tfsmonitor = false\n');
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(scratch, 'gitconfig'), GIT_CEILING_DIRECTORIES: scratch, GIT_TERMINAL_PROMPT: '0',
    };
    const bundle = join(scratch, 'tmp', bundleOnHost.split('/').at(-1));
    const run = (cwd, command) => spawnSync('git', command.split(' ').slice(1).map((word) => (word === bundleOnHost ? bundle : word)), { cwd, env, encoding: 'utf8' });
    const git = (cwd, ...args) => {
      const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, env, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout;
    };
    const composeIn = (repo) => join(repo, 'deploy', 'host', 'docker-compose.advocate.yml');
    // The origin: a first commit with a compose file and the .gitignore of this repository, which covers the two env files; its bundle, copied to the host.
    const origin = join(scratch, 'origin');
    mkdirSync(join(origin, 'deploy', 'host'), { recursive: true });
    mkdirSync(join(scratch, 'tmp'));
    writeFileSync(join(origin, '.gitignore'), read('.gitignore'));
    writeFileSync(composeIn(origin), aComposeText.replace(aComposeText.split('\n')[1], '# the compose file of the commit the host runs'));
    git(origin, 'init', '-b', 'main');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-m', 'the commit the host runs');
    const ran = git(origin, 'rev-parse', 'HEAD').trim();
    git(origin, 'bundle', 'create', bundle, 'main');
    // Step 1 on the host, then the pin of step 2 and the two env files of steps 1 and 4.
    const base = join(scratch, 'base');
    mkdirSync(base);
    const cloned = run(base, clone);
    assert.equal(cloned.status, 0, cloned.stderr);
    const repo = join(base, 'repo');
    const here = join(base, ...folder.slice('$BASE/'.length).split('/'));
    const pinned = readFileSync(composeIn(repo), 'utf8').replace(/^    image: .*$/m, `    image: sha256:${'ab'.repeat(32)}`);
    writeFileSync(composeIn(repo), pinned);
    writeFileSync(join(here, '.env'), 'PROXY_NETWORK=test_proxy_network\n');
    writeFileSync(join(here, '.env.advocate'), 'OPERATOR_CONTACT=ops@example.test\n');
    assert.equal(git(repo, 'status', '--porcelain'), ' M deploy/host/docker-compose.advocate.yml\n', 'the pin of step 2 is the one local change: git ignores the two env files');
    // The change that is reviewed: a second commit that rewrites the compose file, bundled in the same place.
    writeFileSync(composeIn(origin), aComposeText);
    git(origin, 'commit', '-a', '-m', 'the change that is reviewed');
    const reviewed = git(origin, 'rev-parse', 'HEAD').trim();
    git(origin, 'bundle', 'create', bundle, 'main');
    // Step 1 as it stands refuses: the checkout is there. A pull without the checkout of the paragraph stops on the pin and moves nothing.
    assert.notEqual(run(base, clone).status, 0, 'step 1 cannot clone into the checkout that is there');
    const stopped = run(here, pull);
    assert.notEqual(stopped.status, 0, 'a pull stops on the pin of step 2');
    assert.match(stopped.stderr, /docker-compose\.advocate\.yml/, 'and names the compose file');
    assert.equal(git(here, 'rev-parse', 'HEAD').trim(), ran);
    assert.equal(readFileSync(composeIn(repo), 'utf8'), pinned, 'the pin is where it was');
    // The two commands of the paragraph, in its order: the new commit, its compose file with the placeholder that step 2 pins again, and the env files as they were.
    for (const command of [checkout, pull]) {
      const r = run(here, command);
      assert.equal(r.status, 0, `${command}: ${r.stderr}`);
    }
    assert.equal(git(here, 'rev-parse', 'HEAD').trim(), reviewed, 'the checkout is at the reviewed commit');
    assert.equal(readFileSync(composeIn(repo), 'utf8'), aComposeText, "the compose file is the reviewed commit's");
    assert.match(readFileSync(composeIn(repo), 'utf8'), /^    image: ghcr\.io\/apex-fusion\/vector-service-agents\/advocate@sha256:<digest>$/m, 'with the placeholder: step 2 pins the new image');
    assert.equal(readFileSync(join(here, '.env'), 'utf8'), 'PROXY_NETWORK=test_proxy_network\n', '.env stays as it is');
    assert.equal(readFileSync(join(here, '.env.advocate'), 'utf8'), 'OPERATOR_CONTACT=ops@example.test\n', '.env.advocate stays as it is');
    const shown = run(here, log);
    assert.equal(shown.status, 0, shown.stderr);
    assert.ok(shown.stdout.startsWith(reviewed.slice(0, 7)) && shown.stdout.trim().endsWith('the change that is reviewed'), `the last command shows the reviewed commit: ${shown.stdout}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('Advocate RUNBOOK step 4: the env file once, the two keys, the token and the two API keys only into empty lines, the buyer key in a block of its own, the nine lengths and the two keys told apart, the contact, and the offline copy that holds both keys and the API keys', () => {
  const four = section(aRunbook, '4. Make the env file, generate the two keys and enter the two API keys');
  const blocks = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 9);
  const [head, earlier, supplier, buyer, token, lengths, distinct, apiKeys, contact] = blocks;
  // The block for an env file made from an earlier example comes after the first block and before the key blocks (ruling R-F20): it refuses a file whose supplier lines are
  // empty, adds each line only when it is missing, and prints names and lengths of the buyer lines, never a value.
  assert.ok(earlier.startsWith('cd "$BASE/repo/deploy/host"\nif [ ! -f .env.advocate ]; then\n'));
  assert.ok(earlier.includes('echo "refusing: the supplier lines of .env.advocate are empty: this block is for an env file of an earlier example whose supplier key was made; a new one is made from the example" >&2'));
  assert.ok(earlier.includes("sed -i 's/^ADVERT_MAX_PROCESSING_MS=.*/ADVERT_MAX_PROCESSING_MS=480000/' .env.advocate") && earlier.includes("echo 'LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash' >> .env.advocate"));
  assert.ok(earlier.includes(`echo 'LLM_MODEL_ALLOWLIST=${aExample.LLM_MODEL_ALLOWLIST}'`), 'the line of the example');
  assert.doesNotMatch(earlier, /keypair_into|token_into|apikey_into|gen-keypair/, 'it makes no key');
  assert.ok(head.includes('keypair_into() {') && head.includes('token_into() {') && head.includes('apikey_into() {') && head.includes('umask 077'));
  assert.ok(head.includes(`json=$(${ADC} run --rm --no-deps -T agent \\\n    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1)`));
  assert.ok(head.endsWith('if [ -e .env.advocate ]; then\n  echo "refusing: the env file exists, and it is kept as it is" >&2\nelse\n  cp .env.advocate.example .env.advocate && chmod 600 .env.advocate\nfi\n'));
  // The function writes a keypair only into the four lines of its prefix, and refuses a file that lacks one of them: sed would write nothing into a missing line without a word.
  assert.ok(head.includes('  for part in PRIV_KEY_HEX PUB_KEY_HEX PKH ADDRESS; do\n    grep -q "^${1}_${part}=" .env.advocate || { echo "refusing: .env.advocate has no ${1}_${part} line: add the four ${1} lines of the example, empty, first" >&2; return 1; }\n  done\n'));
  assert.ok(head.indexOf('for part in PRIV_KEY_HEX') < head.indexOf('gen-keypair.ts'), 'the lines are looked for before gen-keypair is called');
  assert.equal(supplier, 'cd "$BASE/repo/deploy/host"\nkeypair_into SUPPLIER\n');
  assert.equal(buyer, 'cd "$BASE/repo/deploy/host"\nkeypair_into ADVOCATE_BUYER\n', 'the buyer key has a block of its own, so that it can be made again alone');
  assert.equal(token, 'cd "$BASE/repo/deploy/host"\ntoken_into\n');
  assert.ok(lengths.startsWith("cd \"$BASE/repo/deploy/host\"\nawk -F= '/^(SUPPLIER|ADVOCATE_BUYER)_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/"));
  assert.equal(distinct, 'cd "$BASE/repo/deploy/host"\n[ "$(sed -n \'s/^SUPPLIER_PKH=//p\' .env.advocate)" != "$(sed -n \'s/^ADVOCATE_BUYER_PKH=//p\' .env.advocate)" ] && echo "two different keys" || echo "THE TWO KEYS ARE THE SAME: stop, empty the four buyer lines and run the buyer block again"\n');
  // The names the function writes are the two key blocks of the example, in the order the blocks have them.
  assert.deepEqual(['SUPPLIER', 'ADVOCATE_BUYER'].flatMap((p) => [`${p}_PRIV_KEY_HEX`, `${p}_PUB_KEY_HEX`, `${p}_PKH`, `${p}_ADDRESS`]), [...A_SUPPLIER, ...A_BUYER]);
  assert.equal(four.split('keypair_into ADVOCATE_BUYER').length - 1, 1, 'the buyer key is made in one place');
  assert.doesNotMatch(four, /keypair_into SUPPLIER &&|&& keypair_into ADVOCATE_BUYER/, 'no chain that makes both keys in one go');
  assert.equal(apiKeys, "cd \"$BASE/repo/deploy/host\"\napikey_into BRAVE_SEARCH_API_KEY\napikey_into OPENROUTER_API_KEY\nunset key\nawk -F= '/^(BRAVE_SEARCH|OPENROUTER)_API_KEY=/ { print $1, length($2) }' .env.advocate\n");
  assert.equal(contact, "cd \"$BASE/repo/deploy/host\"\ngrep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.advocate\n");
  // The function reads with read -rs, writes with sed into an empty line only, and refuses a value it could not write safely.
  for (const part of [
    'IFS= read -rs key', 'sed -i "s|^${1}=.*|${1}=$key|" .env.advocate', 'refusing: ${1} already has a value; to replace it, empty the line first',
    '[ "${#key}" -lt 20 ]', "tr -d 'A-Za-z0-9._-'", "printf 'paste %s and press Enter (nothing is shown): ' \"$1\" >&2",
  ]) assert.ok(head.includes(part), `the function of the API keys has: ${part}`);
  assert.ok(head.indexOf('${1} already has a value; to replace it') < head.indexOf('IFS= read -rs key'), 'the line is looked at before anything is read');
  assert.doesNotMatch(head, /\b(echo|printf)\b[^\n]*\$(json|value|key)\b(?![^\n]*\|)/, 'nothing prints the keypair, the token or an API key except into sed or tr');
  for (const line of ['SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58', 'ADVOCATE_BUYER_PRIV_KEY_HEX 64', 'ADVOCATE_BUYER_PUB_KEY_HEX 64', 'ADVOCATE_BUYER_PKH 56', 'ADVOCATE_BUYER_ADDRESS 58', 'SERVICE_AUTH_HEADER 71']) assert.ok(four.includes('`' + line + '`'), line);
  assert.ok(four.includes('All nine are needed.') && four.includes('It must print `two different keys`.'));
  for (const part of [
    '`read -rs` reads it with nothing shown, so that it is on no screen and in no shell history, and `sed` writes it into its line.',
    'The block writes only into an empty line, and only a value of at least 20 characters made of letters, digits, dots, hyphens and underscores',
    'The last command must print `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`, each with a length of 20 or more.',
    '(`environment variable BRAVE_SEARCH_API_KEY is required`, and the same for `OPENROUTER_API_KEY`, in the table at the end), so step 9 can start it only once both are in the file.',
    "Copy `.env.advocate` to the operator's encrypted offline store now, before either address receives anything, and copy it again after any regeneration of a key or of the token, and after either API key is entered again",
    'The copy holds the two API keys too, so it is kept as the keys are.',
    'Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`',
    'The buyer key never has a second copy on the host.',
    'Both keys are raw keypairs, and this file is the only copy of either until step 7.',
    'a buyer line that is not the key\'s stops the service at start, and the service stops at start without the token, without the public key, and with a public key that is not the one of the key hash, because it publishes both.',
    'An env file made from an earlier example of this folder has no buyer lines, and the buyer block refuses it and writes nothing until the block for such a file, above, has added them.',
    'For that file run the next block, then the buyer block and the two checks after it; the supplier, token and API key blocks refuse, since their lines have values.',
    'It refuses a file whose supplier lines are empty: a new env file is made from the example, above, and needs no such block.',
    'On a file of an earlier example it prints `ADVERT_MAX_PROCESSING_MS=480000`, the four buyer lines with a length of 0 and `LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash`, in the order of the file, as it did on the host\'s file on 2026-10-19.',
    'An env file made from an earlier example of this folder, as the one of the host was until step 4 ran again on 2026-10-19 (steps 1 to 10 ran with it), holds the supplier key, the token, the two API keys and the contact, and has no buyer lines, a window of 300000 and no line for the hires.',
    'because other stacks share the network and a job posts an escrow from the buyer wallet',
    'It must print `two different keys`. The service also refuses to start with the supplier key in the buyer lines (the table at the end).',
    "The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today's date: the status can honestly change only in step 17.",
  ]) assert.ok(four.includes(part), `step 4 says: ${part}`);
  // The example carries the word of today (the test of the env example pins it), and a first run is told to start with the earlier word.
  assert.doesNotMatch(four, /`proposed` since 2026-10-13|They stay so until step 17/, 'the words of before the flip');
  // The env file of the host has had its buyer lines since step 4 ran again on 2026-10-19 (the first paragraph): step 4 describes it as it was until then, and what the block printed on it then.
  assert.doesNotMatch(four, /as the one of the host is \(|On the host's file it prints/, 'the present tense of before the run of 2026-10-19');
  assert.ok(aRunbook.split('\n')[2].includes('step 4 ran the block for the env file of the earlier run and made the buyer key'), 'the first paragraph records that run');
  assert.ok(four.indexOf('token_into\n') < four.indexOf('apikey_into BRAVE_SEARCH_API_KEY'), 'the API keys after the key and the token');
});

// The blocks of step 4, run as they stand in bash (the cd lines are the host's, so they are taken out and the temporary folder is the working directory), with
// stand-ins for docker and openssl that check the arguments they are called with. The block of the API keys reads its input: those runs read the script from a
// file, so that the input of the test is what read -rs gets.
const A_STUBS = String.raw`STUB_N="$PWD/.stub-n"
docker() {
  [ "$*" = "compose -f docker-compose.advocate.yml run --rm --no-deps -T agent node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1" ] || { echo "unexpected docker call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '{\n  "privateKeyHex": "%064x",\n  "publicKeyHex": "%064x",\n  "pubKeyHash": "%056x",\n  "address": "addr1%053x"\n}\n' $((n * 1000003)) $((n * 7919)) $((n * 104729)) "$n"
}
openssl() {
  [ "$*" = "rand -hex 32" ] || { echo "unexpected openssl call: $*" >&2; return 9; }
  n=$(( $(cat "$STUB_N" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STUB_N"
  printf '%064x\n' $((n * 15485863))
}
`;
function aStep4() {
  const four = section(aRunbook, '4. Make the env file, generate the two keys and enter the two API keys');
  const [head, earlier, supplier, buyer, token, lengths, distinct, apiKeys] = [...four.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1].replace(/^cd "\$BASE\/repo\/deploy\/host"\n/, ''));
  return { head, earlier, supplier, buyer, token, lengths, distinct, apiKeys };
}
function withAdvocateFolder(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'advocate-step4-'));
  try {
    copyFileSync(join(root, 'deploy/host/.env.advocate.example'), join(dir, '.env.advocate.example'));
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const runBashReading = (script, input, cwd) => {
  writeFileSync(join(cwd, '.block.sh'), script);
  const r = spawnSync('bash', ['.block.sh'], { input, cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const aEnvOf = (dir) => readFileSync(join(dir, '.env.advocate'), 'utf8');
const A_FILLED = /^((SUPPLIER|ADVOCATE_BUYER)_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)|SERVICE_AUTH_HEADER|BRAVE_SEARCH_API_KEY|OPENROUTER_API_KEY)=/;
const apartFromTheEleven = (text) => text.split('\n').filter((l) => !A_FILLED.test(l)).join('\n');
// Two keys of the form the accounts give: letters, digits and hyphens, longer than 20 characters.
const A_BRAVE_KEY = 'BSAtestkey0123456789abcdefghij';
const A_OPENROUTER_KEY = `sk-or-v1-${'0123456789abcdef'.repeat(4)}`;
const A_PROMPTS = 'paste BRAVE_SEARCH_API_KEY and press Enter (nothing is shown): \npaste OPENROUTER_API_KEY and press Enter (nothing is shown): \n';

test('Advocate RUNBOOK step 4 in bash: the blocks make the env file, the two keys, the token and the two API keys, print only names and lengths, tell the two keys apart, and leave every other line of the example as it was', NEEDS_BASH, () => {
  const { head, supplier, buyer, token, lengths, distinct, apiKeys } = aStep4();
  withAdvocateFolder((dir) => {
    const run = runBashReading(`${A_STUBS}${head}${supplier}${buyer}${token}${lengths}${distinct}${apiKeys}`, `${A_BRAVE_KEY}\n${A_OPENROUTER_KEY}\n`, dir);
    assert.equal(run.stderr, A_PROMPTS, 'the two prompts, and nothing refused and nothing failed');
    assert.equal(run.stdout, [
      'SUPPLIER_PRIV_KEY_HEX 64', 'SUPPLIER_PUB_KEY_HEX 64', 'SUPPLIER_PKH 56', 'SUPPLIER_ADDRESS 58', 'ADVOCATE_BUYER_PRIV_KEY_HEX 64', 'ADVOCATE_BUYER_PUB_KEY_HEX 64', 'ADVOCATE_BUYER_PKH 56', 'ADVOCATE_BUYER_ADDRESS 58',
      'SERVICE_AUTH_HEADER 71', 'two different keys', `BRAVE_SEARCH_API_KEY ${A_BRAVE_KEY.length}`, `OPENROUTER_API_KEY ${A_OPENROUTER_KEY.length}`, '',
    ].join('\n'));
    assert.doesNotMatch(run.stdout + run.stderr, /[0-9a-f]{16}|Bearer|BSAtestkey|sk-or-v1/, 'no key, no hash, no token and no API key is printed');
    assert.equal(countOf(dir), 3, 'gen-keypair twice and openssl once');
    const written = parseEnv(aEnvOf(dir));
    assert.match(written.SERVICE_AUTH_HEADER, /^"Bearer [0-9a-f]{64}"$/);
    assert.notEqual(written.SUPPLIER_PKH, written.ADVOCATE_BUYER_PKH);
    for (const name of [...A_SUPPLIER, ...A_BUYER]) assert.notEqual(written[name], '', name);
    assert.deepEqual([written.BRAVE_SEARCH_API_KEY, written.OPENROUTER_API_KEY], [A_BRAVE_KEY, A_OPENROUTER_KEY], 'each key in its line, as it was pasted, without quotes');
    assert.equal(apartFromTheEleven(aEnvOf(dir)), apartFromTheEleven(aExampleText), "every other line is the example's");
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, '.env.advocate')).mode & 0o777, 0o600, 'mode 600');
  });
});

test('Advocate RUNBOOK step 4 in bash: run again, in a new shell, nothing is made again and nothing is replaced: the file is the same bytes, no keypair is asked for, nothing is read, and every guard says so', NEEDS_BASH, () => {
  const { head, supplier, buyer, token, apiKeys } = aStep4();
  withAdvocateFolder((dir) => {
    assert.equal(runBashReading(`${A_STUBS}${head}${supplier}${buyer}${token}${apiKeys}`, `${A_BRAVE_KEY}\n${A_OPENROUTER_KEY}\n`, dir).status, 0);
    const before = aEnvOf(dir);
    const again = runBashReading(`${A_STUBS}${head}${supplier}${buyer}${token}${apiKeys}`, 'another-key-that-is-long-enough\nyet-another-key-that-is-long\n', dir);
    assert.equal(aEnvOf(dir), before, 'byte for byte');
    assert.equal(countOf(dir), 3, 'gen-keypair twice and openssl once, all in the first run');
    for (const refusal of [
      'refusing: the env file exists, and it is kept as it is',
      'refusing: SUPPLIER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
      'refusing: ADVOCATE_BUYER_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced',
      'refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first',
      'refusing: BRAVE_SEARCH_API_KEY already has a value; to replace it, empty the line first',
      'refusing: OPENROUTER_API_KEY already has a value; to replace it, empty the line first',
    ]) assert.ok(again.stderr.includes(refusal), refusal);
    assert.equal(again.stderr.includes('paste '), false, 'no prompt: a line that has a value is not asked for');
    assert.equal(again.stdout, `BRAVE_SEARCH_API_KEY ${A_BRAVE_KEY.length}\nOPENROUTER_API_KEY ${A_OPENROUTER_KEY.length}\n`, 'the lengths of what is there');
  });
});

test('Advocate RUNBOOK step 4 in bash: a value under 20 characters, or one with a character that the shell or sed would read, is refused and nothing is written; run again, the block asks only for the line that is still empty', NEEDS_BASH, () => {
  const { head, apiKeys } = aStep4();
  withAdvocateFolder((dir) => {
    const shortOne = runBashReading(`${head}${apiKeys}`, `short-key\n${A_OPENROUTER_KEY}\n`, dir);
    assert.match(shortOne.stderr, /refusing: what was pasted for BRAVE_SEARCH_API_KEY has 9 characters, or one that is not a letter, a digit, a dot, a hyphen or an underscore; nothing is written/);
    assert.equal(shortOne.stdout, `BRAVE_SEARCH_API_KEY 0\nOPENROUTER_API_KEY ${A_OPENROUTER_KEY.length}\n`);
    // A value that holds what a shell or sed would act on: it is refused whole, and nothing of it runs.
    for (const pasted of ['BSA$(touch pwned)aaaaaaaaaaaaaaaaaaaa', 'BSAtestkey0123456789 abcdefghij', 'BSAtestkey0123456789|abcdefghij', 'BSAtestkey0123456789&abcdefghij', 'BSAtestkey0123456789\\abcdefghij']) {
      const refused = runBashReading(`${head}${apiKeys}`, `${pasted}\n`, dir);
      assert.match(refused.stderr, /refusing: what was pasted for BRAVE_SEARCH_API_KEY has \d+ characters, or one that is not a letter/, pasted);
      assert.match(refused.stderr, /refusing: OPENROUTER_API_KEY already has a value/, pasted);
      assert.equal(parseEnv(aEnvOf(dir)).BRAVE_SEARCH_API_KEY, '', `${pasted}: nothing is written`);
      assert.equal(refused.stdout.includes(pasted), false);
    }
    assert.equal(existsSync(join(dir, 'pwned')), false, 'nothing that was pasted ran');
    const good = runBashReading(`${head}${apiKeys}`, `${A_BRAVE_KEY}\n`, dir);
    assert.equal(good.stdout, `BRAVE_SEARCH_API_KEY ${A_BRAVE_KEY.length}\nOPENROUTER_API_KEY ${A_OPENROUTER_KEY.length}\n`);
    assert.deepEqual([parseEnv(aEnvOf(dir)).BRAVE_SEARCH_API_KEY, parseEnv(aEnvOf(dir)).OPENROUTER_API_KEY], [A_BRAVE_KEY, A_OPENROUTER_KEY]);
  });
  // The least a key may have, 20 characters, is held at its edge, in a folder of its own: 19 of the right kind are refused and nothing is written, 20 are written.
  withAdvocateFolder((dir) => {
    const nineteen = runBashReading(`${head}${apiKeys}`, `${'k'.repeat(19)}\n`, dir);
    assert.match(nineteen.stderr, /refusing: what was pasted for BRAVE_SEARCH_API_KEY has 19 characters, or one that is not a letter/);
    assert.equal(parseEnv(aEnvOf(dir)).BRAVE_SEARCH_API_KEY, '', 'nineteen: nothing is written');
    const twenty = runBashReading(`${head}${apiKeys}`, `${'k'.repeat(20)}\n`, dir);
    assert.equal(parseEnv(aEnvOf(dir)).BRAVE_SEARCH_API_KEY, 'k'.repeat(20), 'twenty: written');
    assert.ok(twenty.stdout.startsWith('BRAVE_SEARCH_API_KEY 20\n'));
  });
});

test('Advocate RUNBOOK step 4 in bash: an API key is entered again alone after the command of the failure table emptied its line; the other key, the two keys and the token stay as they were', NEEDS_BASH, () => {
  const { head, supplier, buyer, token, apiKeys } = aStep4();
  const table = section(aRunbook, 'If something goes wrong');
  const emptyBrave = `sed -i 's/^BRAVE_SEARCH_API_KEY=.*/BRAVE_SEARCH_API_KEY=/' .env.advocate`;
  const emptyOpenRouter = `sed -i 's/^OPENROUTER_API_KEY=.*/OPENROUTER_API_KEY=/' .env.advocate`;
  for (const command of [emptyBrave, emptyOpenRouter]) assert.ok(table.includes('`' + command + '`'), command);
  withAdvocateFolder((dir) => {
    runBashReading(`${A_STUBS}${head}${supplier}${buyer}${token}${apiKeys}`, `${A_BRAVE_KEY}\n${A_OPENROUTER_KEY}\n`, dir);
    const before = parseEnv(aEnvOf(dir));
    assert.equal(runBash(`${emptyOpenRouter}\n`, dir).status, 0);
    assert.equal(parseEnv(aEnvOf(dir)).OPENROUTER_API_KEY, '', 'emptied');
    const newKey = `sk-or-v1-${'fedcba9876543210'.repeat(4)}`;
    const again = runBashReading(`${head}${apiKeys}`, `${newKey}\n`, dir);
    assert.match(again.stderr, /refusing: BRAVE_SEARCH_API_KEY already has a value/);
    const after = parseEnv(aEnvOf(dir));
    assert.equal(after.OPENROUTER_API_KEY, newKey, 'the new key, read from the first line of the input');
    for (const name of [...A_SUPPLIER, ...A_BUYER, ...A_TOKEN, 'BRAVE_SEARCH_API_KEY']) assert.equal(after[name], before[name], `${name} untouched`);
  });
});

test('Advocate RUNBOOK step 4 in bash: the buyer key is made again alone, after its four lines were emptied by hand with the command of the failure table, and nothing else in the file moves', NEEDS_BASH, () => {
  const { head, supplier, buyer, token, apiKeys } = aStep4();
  const table = section(aRunbook, 'If something goes wrong');
  const emptyBuyer = String.raw`sed -i 's/^\(ADVOCATE_BUYER_[A-Z_]*\)=.*/\1=/' .env.advocate`;
  assert.ok(table.includes('`' + emptyBuyer + '`'), 'the failure table gives the command that empties the buyer lines');
  withAdvocateFolder((dir) => {
    runBashReading(`${A_STUBS}${head}${supplier}${buyer}${token}${apiKeys}`, `${A_BRAVE_KEY}\n${A_OPENROUTER_KEY}\n`, dir);
    const before = parseEnv(aEnvOf(dir));
    assert.equal(runBash(`${emptyBuyer}\n`, dir).status, 0);
    const blank = parseEnv(aEnvOf(dir));
    for (const name of A_BUYER) assert.equal(blank[name], '', `${name} emptied`);
    for (const name of [...A_SUPPLIER, ...A_TOKEN, ...A_API_KEYS]) assert.equal(blank[name], before[name], `${name} untouched by the command`);
    const redo = runBash(`${A_STUBS}${head}${buyer}`, dir);
    assert.equal(redo.status, 0);
    assert.match(redo.stderr, /^refusing: the env file exists, and it is kept as it is\n$/, 'the first block, pasted to define the functions again, leaves the file alone');
    const after = parseEnv(aEnvOf(dir));
    for (const name of A_BUYER) assert.match(after[name], /^[0-9a-z]+$/, `${name} made again`);
    for (const name of A_BUYER) assert.notEqual(after[name], before[name], `${name} is a new value`);
    for (const name of [...A_SUPPLIER, ...A_TOKEN, ...A_API_KEYS]) assert.equal(after[name], before[name], `${name} untouched`);
    assert.equal(apartFromTheEleven(aEnvOf(dir)), apartFromTheEleven(aExampleText));
  });
});

test('Advocate RUNBOOK step 4 in bash: an env file made from the example of before the buyer key has no buyer lines; the buyer block refuses it, names the line, asks for no keypair and changes nothing; the block for such a file adds the four buyer lines in the order of the example, the window of 480000 and the hires, once, and refuses a file whose supplier lines are empty; the buyer block then makes the key', NEEDS_BASH, () => {
  const { head, earlier, buyer } = aStep4();
  const table = section(aRunbook, 'If something goes wrong');
  assert.ok(table.includes('| The buyer block of step 4 says `refusing: .env.advocate has no ADVOCATE_BUYER_PRIV_KEY_HEX line` | The env file was made from an earlier example of this folder, which had no buyer lines. | Run the block of step 4 for an env file made from an earlier example: it adds the four lines `ADVOCATE_BUYER_PRIV_KEY_HEX=`, `ADVOCATE_BUYER_PUB_KEY_HEX=`, `ADVOCATE_BUYER_PKH=` and `ADVOCATE_BUYER_ADDRESS=`, empty, sets `ADVERT_MAX_PROCESSING_MS=480000` and adds `LLM_MODEL_ALLOWLIST`. Then run the buyer block again'));
  assert.ok(table.includes('| Run the block of step 4 for an env file made from an earlier example, which sets `ADVERT_MAX_PROCESSING_MS=480000` and adds what else that file lacks, then recreate.'), 'the row of the window points at the same block');
  withAdvocateFolder((dir) => {
    // The example of before, as the host has it: the supplier key written, no buyer lines, the window of 300000 and no line for the hires.
    const supplier = { SUPPLIER_PRIV_KEY_HEX: '11'.repeat(32), SUPPLIER_PUB_KEY_HEX: '22'.repeat(32), SUPPLIER_PKH: '33'.repeat(28), SUPPLIER_ADDRESS: `addr1v${'q'.repeat(52)}` };
    let older = aExampleText.split('\n').filter((l) => !/^ADVOCATE_BUYER_|^LLM_MODEL_ALLOWLIST=|^# LLM_MAX_PRICE_LOVELACE=/.test(l)).join('\n').replace(/^ADVERT_MAX_PROCESSING_MS=480000$/m, 'ADVERT_MAX_PROCESSING_MS=300000');
    for (const [name, value] of Object.entries(supplier)) older = older.replace(new RegExp(`^${name}=$`, 'm'), `${name}=${value}`);
    writeFileSync(join(dir, '.env.advocate'), older);
    const refused = runBash(`${A_STUBS}${head}${buyer}`, dir);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /refusing: \.env\.advocate has no ADVOCATE_BUYER_PRIV_KEY_HEX line: add the four ADVOCATE_BUYER lines of the example, empty, first/);
    assert.equal(existsSync(join(dir, '.stub-n')), false, 'no keypair is asked for');
    assert.equal(aEnvOf(dir), older, 'nothing is written');
    // The block for such a file: the four buyer lines, empty and in the order of the example, at the end; the window of 480000; the hires; every other line as it was.
    const added = runBash(`${A_STUBS}${head}${earlier}`, dir);
    assert.equal(added.status, 0);
    assert.equal(added.stdout, ['ADVERT_MAX_PROCESSING_MS=480000', ...A_BUYER.map((name) => `${name} 0`), `LLM_MODEL_ALLOWLIST=${aExample.LLM_MODEL_ALLOWLIST}`, ''].join('\n'));
    const after = aEnvOf(dir);
    assert.equal(after, `${older.replace(/^ADVERT_MAX_PROCESSING_MS=300000$/m, 'ADVERT_MAX_PROCESSING_MS=480000')}${A_BUYER.map((name) => `${name}=`).join('\n')}\nLLM_MODEL_ALLOWLIST=${aExample.LLM_MODEL_ALLOWLIST}\n# LLM_MAX_PRICE_LOVELACE=1000000\n`);
    assert.ok(aExampleText.includes('\n# LLM_MAX_PRICE_LOVELACE=1000000\n'), 'the commented ceiling of the example');
    assert.equal(existsSync(join(dir, '.stub-n')), false, 'the block makes no key');
    // Run again, it changes nothing.
    assert.equal(runBash(`${A_STUBS}${head}${earlier}`, dir).status, 0);
    assert.equal(aEnvOf(dir), after, 'byte for byte');
    // The buyer block then makes the key, and nothing else moves.
    assert.equal(runBash(`${A_STUBS}${head}${buyer}`, dir).status, 0);
    const made = parseEnv(aEnvOf(dir));
    for (const name of A_BUYER) assert.match(made[name], /^[0-9a-z]+$/, `${name} made`);
    for (const [name, value] of Object.entries(supplier)) assert.equal(made[name], value, `${name} untouched`);
    assert.equal(countOf(dir), 1, 'one keypair');
  });
  withAdvocateFolder((dir) => {
    // A file whose supplier lines are empty is not the host's: the block refuses it and writes nothing, and a new env file is made from the example instead.
    const blank = aExampleText.split('\n').filter((l) => !/^ADVOCATE_BUYER_/.test(l)).join('\n');
    writeFileSync(join(dir, '.env.advocate'), blank);
    const refused = runBash(`${A_STUBS}${head}${earlier}`, dir);
    assert.match(refused.stderr, /refusing: the supplier lines of \.env\.advocate are empty: this block is for an env file of an earlier example whose supplier key was made/);
    assert.equal(refused.stdout, '');
    assert.equal(aEnvOf(dir), blank, 'nothing is written');
  });
});

test('Advocate RUNBOOK step 4 in bash: the functions make nothing where there is no env file, and say so; a gen-keypair that fails writes nothing', NEEDS_BASH, () => {
  const { head, supplier, buyer } = aStep4();
  const functionsOnly = head.slice(0, head.indexOf('if [ -e .env.advocate ]; then'));
  assert.ok(functionsOnly.includes('keypair_into() {') && functionsOnly.includes('token_into() {') && functionsOnly.includes('apikey_into() {') && !functionsOnly.includes('cp .env'));
  withAdvocateFolder((dir) => {
    const missing = runBashReading(`${A_STUBS}${functionsOnly}keypair_into SUPPLIER\nrc1=$?\ntoken_into\nrc2=$?\napikey_into BRAVE_SEARCH_API_KEY\nrc3=$?\necho "rc $rc1 $rc2 $rc3"\n`, `${A_BRAVE_KEY}\n`, dir);
    assert.equal(missing.stdout.trim(), 'rc 1 1 1');
    assert.equal(missing.stderr.match(/refusing: there is no \.env\.advocate in this folder/g)?.length, 3);
    assert.equal(existsSync(join(dir, '.env.advocate')), false, 'the functions do not make the file');
    assert.equal(existsSync(join(dir, '.stub-n')), false, 'and call neither gen-keypair nor openssl');
    const failed = runBash(`${A_STUBS}docker() { return 1; }\n${head}${supplier}echo "rc $?"\n`, dir);
    assert.equal(failed.stdout.trim(), 'rc 1');
    assert.match(failed.stderr, /gen-keypair failed/);
    for (const name of A_SUPPLIER) assert.equal(parseEnv(aEnvOf(dir))[name], '', `${name} is still empty`);
    const failedBuyer = runBash(`${A_STUBS}docker() { return 1; }\n${head}${buyer}echo "rc $?"\n`, dir);
    assert.equal(failedBuyer.stdout.trim(), 'rc 1');
    for (const name of A_BUYER) assert.equal(parseEnv(aEnvOf(dir))[name], '', `${name} is still empty`);
  });
});

test('Advocate RUNBOOK step 4 in bash: the ops scripts cannot read the env file with the shell\'s "." while OPERATOR_CONTACT holds the placeholder of the example, and can once the check of the step prints 1, the two API keys whole', NEEDS_BASH, () => {
  const { head, apiKeys } = aStep4();
  withAdvocateFolder((dir) => {
    runBashReading(`${head}${apiKeys}`, `${A_BRAVE_KEY}\n${A_OPENROUTER_KEY}\n`, dir);
    const stopped = runBash('set -e\n. ./.env.advocate\necho "read $OPERATOR_CONTACT"\n', dir);
    assert.notEqual(stopped.status, 0, 'the shell stops at the placeholder');
    assert.equal(stopped.stdout, '');
    writeFileSync(join(dir, '.env.advocate'), aEnvOf(dir).replace(/^OPERATOR_CONTACT=.*$/m, 'OPERATOR_CONTACT=ops@example.test'));
    assert.equal(runBash("grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.advocate\n", dir).stdout.trim(), '1', 'the check of step 4 prints 1');
    const filled = runBash('set -e\n. ./.env.advocate\necho "read $OPERATOR_CONTACT ${#BRAVE_SEARCH_API_KEY} ${#OPENROUTER_API_KEY}"\n', dir);
    assert.deepEqual([filled.status, filled.stdout.trim()], [0, `read ops@example.test ${A_BRAVE_KEY.length} ${A_OPENROUTER_KEY.length}`]);
  });
});

test('Advocate env example in bash: the ops scripts read the allowlist with the shell\'s "." as the comment says to write it, with no space after a comma; after a space the rest is a command, and the shell stops there', NEEDS_BASH, () => {
  withAdvocateFolder((dir) => {
    const filled = aExampleText.replace(/^OPERATOR_CONTACT=.*$/m, 'OPERATOR_CONTACT=ops@example.test');
    const sourced = (allowlist) => {
      writeFileSync(join(dir, '.env.advocate'), filled.replace(/^LLM_MODEL_ALLOWLIST=.*$/m, `LLM_MODEL_ALLOWLIST=${allowlist}`));
      return runBash('set -e\n. ./.env.advocate\necho "read $LLM_MODEL_ALLOWLIST"\n', dir);
    };
    const plain = sourced('deepseek/deepseek-v4-flash,example/another-model');
    assert.deepEqual([plain.status, plain.stdout.trim()], [0, 'read deepseek/deepseek-v4-flash,example/another-model']);
    const spaced = sourced('deepseek/deepseek-v4-flash, example/another-model');
    assert.notEqual(spaced.status, 0, 'the shell runs example/another-model as a command, and stops');
    assert.equal(spaced.stdout, '');
    assert.match(spaced.stderr, /example\/another-model/);
  });
});

test('Advocate RUNBOOK step 5: the ops scripts are copied from the adapted set of Audio Snippets; the registry record is the manifest description, the capability, the framework and the public URL', () => {
  const five = section(aRunbook, '5. Adapt the ops scripts');
  const desc = /^DESC="(.+)"$/m.exec(five)[1];
  const [manifest] = inAdvocate("import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => manifestFromEnv(env))));", [{ OPERATOR_CONTACT: TEST_CONTACT }]);
  assert.equal(desc, manifest.description);
  assert.ok(five.includes(`(this one is ${desc.length})`) && desc.length <= 256);
  for (const part of [
    'mkdir -p "$BASE/ops" && cd "$BASE/ops"',
    'sed -e "s#[^\\"\' =]*/\\.env\\.audio-snippets#$BASE/repo/deploy/host/.env.advocate#g" \\', '-e "s#$SNIPPETS_BASE/ops#$BASE/ops#g" \\', '"$SNIPPETS_BASE/ops/$f" > "$f"',
    "sed -i 's#audio-snippets supplier#advocate supplier#g' make-skey.py", "-e 's#^ \"name\":\"Audio Snippets\",# \"name\":\"Advocate\",#'",
    "-e 's#^ \"endpoint\":\"https://mp-suppliers-snippets.hal8.ai\"}# \"endpoint\":\"https://mp-suppliers-advocate.hal8.ai\"}#'",
    "sed -i 's#^CAPABILITIES = \\[.*\\]#CAPABILITIES = [\"research.advocate.onesided.v1\"]#' m3-self-stake.py", "grep -il 'snippets\\|pipeline\\|agent.history' *.sh *.py",
  ]) assert.ok(five.includes(part), `step 5 says: ${part}`);
  const [, venv] = [...five.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.ok(venv.startsWith('cd "$BASE/ops"\npython3 -m venv venv\n'), 'the block of the Python environment starts in the ops folder: it may run in a new shell');
  assert.ok(venv.endsWith("./venv/bin/pip show cbor2 | grep '^Version'\n./venv/bin/python -c \"import pycardano, reputation_staking\"\n"), 'and ends with the two checks of the prose');
  // What the copy of Audio Snippets holds is what this copy looks for: the label, the record and the capability its step 5 wrote.
  const s5 = section(sRunbook, '5. Adapt the ops scripts');
  for (const left of ['audio-snippets supplier#g', '# "name":"Audio Snippets",#\'', '# "endpoint":"https://mp-suppliers-snippets.hal8.ai"}#\'', 'CAPABILITIES = ["audio.transcript.snippets.v1"]#\'']) assert.ok(s5.includes(left), `the copy of Audio Snippets is made with: ${left}`);
});

test('Advocate RUNBOOK step 5 in bash: the copy is made from a copy of Audio Snippets whose env file sits in any folder of its checkout, and holds only the paths and values of Advocate', NEEDS_BASH, () => {
  const block = /```sh\n([\s\S]*?)```/.exec(section(aRunbook, '5. Adapt the ops scripts'))?.[1] ?? '';
  assert.ok(block.startsWith('mkdir -p "$BASE/ops" && cd "$BASE/ops"\n'), 'the block needs only BASE and SNIPPETS_BASE');
  const dir = mkdtempSync(join(tmpdir(), 'advocate-step5-'));
  try {
    const at = (...parts) => [dir.split(sep).join('/'), ...parts].join('/');
    const AS = at('opt', 'audio-snippets');
    const AD = at('opt', 'advocate');
    mkdirSync(join(dir, 'opt', 'audio-snippets', 'ops'), { recursive: true });
    // A copy of Audio Snippets as its step 5 left it, its env file in the folder of the checkout it was made from.
    const env = `${AS}/repo/deploy/older/.env.audio-snippets`;
    const header = `# the scripts of ${AS}/ops, for the env file ${env}\n`;
    const stand = {
      'setup-venv.sh': `#!/bin/sh\n${header}echo "venv ok"\n`,
      'make-skey.py': `${header}KEY_DESCRIPTION = "audio-snippets supplier key"\nWALLET = "${AS}/ops/wallet"\n`,
      'mcp-call.sh': `#!/bin/sh\n${header}. "${env}"\n`,
      'sign-tx.py': header,
      'register-did.sh': `#!/bin/sh\n${header}. ${env}\nBODY='{\n "name":"Audio Snippets",\n "description":"A word-timed transcript.",\n "capabilities":["audio.transcript.snippets.v1"],\n "framework":"vector-service-agents",\n "endpoint":"https://mp-suppliers-snippets.hal8.ai"}'\n`,
      'm3-self-stake.py': `${header}CAPABILITIES = ["audio.transcript.snippets.v1"]\n`,
    };
    for (const [name, text] of Object.entries(stand)) writeFileSync(join(dir, 'opt', 'audio-snippets', 'ops', name), text);
    const run = runBash(`BASE='${AD}'\nSNIPPETS_BASE='${AS}'\n${block}`, dir);
    assert.equal(run.stderr, '');
    assert.match(run.stdout, /^register-did\.sh$/m, 'the last grep names the scripts that read the env file of Advocate');
    const copy = Object.fromEntries(Object.keys(stand).map((name) => [name, readFileSync(`${AD}/ops/${name}`, 'utf8')]));
    const all = Object.values(copy).join('\n');
    assert.equal(/snippets|pipeline|agent.history/i.test(all), false, 'nothing of Audio Snippets or of the other two is left in the copy');
    assert.ok(copy['register-did.sh'].includes(`. ${AD}/repo/deploy/host/.env.advocate\n`) && copy['mcp-call.sh'].includes(`. "${AD}/repo/deploy/host/.env.advocate"\n`), 'the scripts read the env file of Advocate');
    assert.ok(copy['make-skey.py'].includes('KEY_DESCRIPTION = "advocate supplier key"\n') && copy['make-skey.py'].includes(`WALLET = "${AD}/ops/wallet"\n`));
    const desc = /^DESC="(.+)"$/m.exec(section(aRunbook, '5. Adapt the ops scripts'))[1];
    for (const line of [' "name":"Advocate",', ` "description":"${desc}",`, ' "capabilities":["research.advocate.onesided.v1"],', ' "framework":"vector-service-agents",', ' "endpoint":"https://mp-suppliers-advocate.hal8.ai"}']) assert.ok(copy['register-did.sh'].includes(line), line);
    assert.ok(copy['m3-self-stake.py'].includes('CAPABILITIES = ["research.advocate.onesided.v1"]\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Advocate RUNBOOK steps 6 to 9: the two wallets supplied and checked, the identity of the supplier key and the stake, the service started by name and read, with the model and its fallback, the buyer address and the state directory, the limits, the two API keys by length and the 401', () => {
  const six = section(aRunbook, '6. Supply the two wallets with their collateral and float');
  for (const part of [
    `grep -E '^(SUPPLIER|ADVOCATE_BUYER)_ADDRESS=' "$BASE/repo/deploy/host/.env.advocate"`,
    'The first is exactly 5 units, alone.', 'Send the second only after the first has confirmed: 50 units to the supplier address, 30 units to the buyer address.',
    'for name in SUPPLIER_ADDRESS ADVOCATE_BUYER_ADDRESS; do', '"$BASE/ops/mcp-call.sh" vector_get_utxos',
    'Each address must list two outputs: one of exactly 5 units, and one of 50 at the supplier address or of 30 at the buyer address. When the buyer wallet is supplied after the steps of the supplier key, as it was on 2026-10-20 (the first paragraph), the supplier address lists what those steps left of its 55, and only the buyer address is held to its two outputs.',
  ]) assert.ok(six.includes(part), `step 6 says: ${part}`);
  // The first paragraph records it: the buyer wallet was supplied on 2026-10-20, after the advert of 2026-10-19, which needs only the supplier key.
  assert.ok(aRunbook.split('\n')[2].includes('Steps 11 to 14 were run on 2026-10-19, before the buyer wallet was supplied, since the advert needs only the supplier key, and step 6 for the buyer wallet, step 15, the first stop and step 17 on 2026-10-20.'));
  assert.equal(six.includes('On the run before step 11'), false, 'the words of before the run of 2026-10-20');
  // The two second transfers are the floats of the rows of Collateral and float.
  const collateral = section(aRunbook, 'Collateral and float');
  assert.ok(collateral.includes('exactly 5 units alone (collateral), then 50 units') && collateral.includes('held back from every Post while the rest of the wallet covers that Post and its change), then 30 units'));
  const seven = section(aRunbook, '7. Register the identity');
  for (const part of ["sed -i '/^AGENT_DID=$/d' \"$BASE/repo/deploy/host/.env.advocate\"", 'python3 make-skey.py', './register-did.sh', 'The record has the name `Advocate`, the capability `research.advocate.onesided.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-advocate.hal8.ai`', 'into the Identity section of `specs/advocate.md`', '(the DID row, the "Registry record" row and the sentence that says the agent has a registry record)', 'remove it in Back out (point 4)', 'Operator. The same as step 7 of RUNBOOK.md, for the supplier key only.', 'The buyer key is not touched by any step here and has no second copy on the host.']) assert.ok(seven.includes(part), part);
  // Step 7 was run on 2026-10-19 and the pull request it asked for recorded it: the sentence says that the record exists, and the rows are no longer planned. The step names the rows as
  // they are since then, as the runbooks of Audio Snippets and the Pipeline do since their flips, and quotes no row that is gone.
  assert.equal(seven.includes('Registry record, planned') || seven.includes('no registry record yet'), false, 'the rows of before the registration');
  assert.ok(ASPEC.includes('\nThis agent has had a registry record since 2026-10-19.\n') && /\n\| DID \| `did:vector:[0-9a-f]{64}` \|\n/.test(ASPEC) && ASPEC.includes('\n| Registry record | name `Advocate`;'), 'the spec rows step 7 names carry the record');
  assert.equal(ASPEC.includes('This agent has no registry record yet.') || ASPEC.includes('| Registry record, planned |') || ASPEC.includes('| DID | not registered.'), false, 'and the words of before are gone');
  assert.ok(section(aRunbook, '8. Stake in Module-3').includes('here both are the one capability `research.advocate.onesided.v1`'));
  const nine = section(aRunbook, '9. Start the service');
  for (const part of [
    `${ADC} up -d service`, 'docker logs advocate-service', "fetch('http://127.0.0.1:9094/healthz')", "fetch('http://127.0.0.1:9094/agent.json')", "fetch('http://127.0.0.1:9094/', { method: 'POST', body: 'x' })",
    "docker exec advocate-service node -e \"for (const n of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) console.log(n, (process.env[n] ?? '').length)\"",
    '[advocate] listening on 0.0.0.0:9094; search Brave Search API; model deepseek/deepseek-v4-flash from the Vector marketplace, OpenRouter as the fallback; buyer address <the buyer address of step 4>; state directory /data',
    '`1073741824 330 advocate-state:/data`', 'model_gap: m.gaps[4]',
    "docker inspect --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}} {{range .Mounts}}{{.Name}}:{{.Destination}}{{end}}' advocate-service",
    'and the two API keys were all in the env file, and that `/data` is writable; that `/data` is the volume `advocate-state`, and not an anonymous volume of the image\'s `VOLUME /data`, is what the inspect line\'s last field shows.',
    'The `inspect` line prints `1073741824 330 advocate-state:/data`: the memory limit of 1024m in bytes, the stop timeout of 330 s, 30 s more than the service waits for a job, and its one mount, the volume `advocate-state` at `/data`.',
    'a key the Brave Search API refuses fails a job with `search_failed`, and one OpenRouter refuses fails the first job that falls back to it with `model_failed` (the table at the end).',
    'A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`', 'nor with an empty `SUPPLIER_PUB_KEY_HEX` or one that is not the public key of `SUPPLIER_PKH`, nor without the buyer key or either API key, nor with the supplier key in the buyer lines (the same table).',
    'The service starts only once the buyer key and the two API keys are in the env file (step 4)', 'a smoke start works only once all three are in', 'An empty buyer wallet does not stop it: a job it cannot cover gets its brief from OpenRouter.',
    'the key hash of the buyer key in `keys.buyer_pkh` (the service derives it from the key, and it must equal `ADVOCATE_BUYER_PKH` in the env file)',
    'The service checks its settings and proves its state directory writable before it listens',
    'When the first model of `LLM_MODEL_ALLOWLIST` is not the model of `OPENROUTER_MODEL`, the line names both, as the fifth gap of the manifest does.',
    // The manifest v2: the canonical DID, the listed supplier key and the address of the identity registry (agents/advocate/src/server.ts).
    '`vector.agent-manifest.v2` in `schema`', 'the new DID of step 7 in its canonical form `did:vector:<identifier>` in `identity.did` (the env file holds the legacy form `did:vector:agent:<policy>:<identifier>` of the same identifier)',
    'the listed supplier key `<DID>#<key hash>` in `identity.supplier_key`', 'the key hash in `keys.supplier_pkh`', 'the public key in `keys.pub_key_hex`',
    'the address of the identity registry in `identity.registry_address` (empty while `IDENTITY_POLICY_ID` is empty in the env file)',
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
  assert.equal(aRunbook.includes('controller_pkh'), false, 'the field that the manifest v2 removed');
  assert.equal(1024 * 1024 * 1024, 1073741824);
  // The last field of the inspect line: the one volume of the service, named in the compose file, at the state directory the service is given, which is the one
  // VOLUME of the image. Without the mount of the compose file that VOLUME would be an anonymous volume, writable too, which the reads of Back out would not see.
  assert.deepEqual([aService.volumes, aCompose.volumes['advocate-state'], aService.environment.ADVOCATE_STATE_DIR], [['advocate-state:/data'], { name: 'advocate-state' }, '/data']);
  assert.deepEqual(aDockerfile.match(/^VOLUME .*$/gm), ['VOLUME /data']);
  assert.deepEqual(['volumes', 'tmpfs', 'configs', 'secrets'].filter((key) => key in aService), ['volumes'], 'and the compose file gives the service no other mount');
  assert.equal(nine.includes('can hold the record of the escrows the service posts'), false, 'the words of before: the listening line proves /data writable, not which volume it is');
  // A key that OpenRouter refuses shows only in a job that falls back: the one call to OpenRouter is the fallback's (src/inference.ts), and a 401 is model_failed, 502.
  assert.equal(A_SRC.split('await callModel(').length, 2, 'one call to OpenRouter in the code of the service');
  const inference = read('agents/advocate/src/inference.ts');
  assert.ok(inference.indexOf('await callModel(') > inference.indexOf('async function viaOpenRouter('), 'and it is the fallback');
  const [refused] = inAdvocate(
    "import { callModel } from './src/model.ts'; let code = null; try { await callModel([], { fetchImpl: async () => new Response(JSON.stringify({ error: { code: 401, message: 'No auth credentials found' } }), { status: 401 }), " +
    "apiKey: 'k'.repeat(30), model: 'a/b', maxTokens: 10, timeoutMs: 5000, log: () => undefined }); } catch (e) { code = [e.code, e.status]; } console.log(JSON.stringify([code]));", null);
  assert.deepEqual(refused, ['model_failed', 502], 'a key OpenRouter refuses fails the job with model_failed');
  assert.ok(nine.includes('```sh\ncd "$BASE/repo/deploy/host"\n' + `${ADC} up -d service\ndocker logs advocate-service\n`), 'the block that starts the service starts in this folder: it may run in a new shell');
  // The fifth gap is the one that names the model, and the line the log shows is the one the code writes, with the prefix of the log of the service.
  const [gaps] = inAdvocate("import { gapsFor } from './src/gaps.ts'; import { DEFAULT_MODEL } from './src/model.ts'; console.log(JSON.stringify([gapsFor(DEFAULT_MODEL, DEFAULT_MODEL)]));", null);
  assert.ok(gaps[4].includes('deepseek/deepseek-v4-flash'), 'm.gaps[4] is the gap of the model');
  // The line the log shows is the one the code writes, read from a start of the real service on a state directory of its own (the buyer chain makes no call
  // to start, and the janitor's first pass finds nothing to do).
  const stateDir = mkdtempSync(join(tmpdir(), 'advocate-state-'));
  try {
    const started = JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "import { startService } from './src/start.ts'; const lines = []; const s = await startService({ ...JSON.parse(process.argv[1]), PORT: '0', HOST: '127.0.0.1' }, { log: (l) => lines.push(l) }); await s.stop(); console.log(JSON.stringify(lines));", JSON.stringify({ ...aFullEnv(), ADVOCATE_STATE_DIR: stateDir })], { cwd: join(root, 'agents/advocate'), encoding: 'utf8' }));
    const listening = started.find((line) => line.startsWith('listening on ')) ?? '';
    const [buyer] = inAdvocate("import { buyerIdentityOf } from '@vsa/buyer-core'; console.log(JSON.stringify([buyerIdentityOf(JSON.parse(process.argv[1]))]));", A_BUYER_KEY);
    assert.equal(listening.replace(/:\d+;/, ':<port>;'), `listening on 127.0.0.1:<port>; search Brave Search API; model deepseek/deepseek-v4-flash from the Vector marketplace, OpenRouter as the fallback; buyer address ${buyer.address}; state directory ${stateDir}`);
    // The start and the first pass of its janitor write no stranded.json: the file is made by the record of a Post (step 15, "No such file or directory").
    assert.equal(existsSync(join(stateDir, 'stranded.json')), false, 'no file before an escrow is posted');
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
  assert.ok(A_SRC.includes('[advocate] ${line}'), 'the prefix of every line of the log');
});

test('Advocate RUNBOOK steps 10 to 14: the copy of the install script with the vhost, the snippet and the marker of Advocate, the hash, the advert with the terms of the example and the spec, the runtime on 8086 with neither API key, the indexer', () => {
  const ten = section(aRunbook, '10. DNS and Caddy');
  for (const part of [
    "sed -e 's#^VHOST=.*#VHOST=mp-suppliers-advocate.hal8.ai#' \\", '-e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.advocate.snippet#" \\',
    '"$SNIPPETS_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh', "sed -i '/^MARKER=/s#audio-snippets#advocate#g' install-caddy-route.sh",
    "grep -in 'snippets\\|pipeline\\|history' install-caddy-route.sh", 'curl -fsS https://mp-suppliers-advocate.hal8.ai/agent.json', 'It must return the manifest of step 9, byte for byte.',
  ]) assert.ok(ten.includes(part), `step 10 says: ${part}`);
  assert.ok(section(sRunbook, '10. DNS and Caddy').includes("sed -i '/^MARKER=/s#document-pipeline#audio-snippets#g' install-caddy-route.sh"), 'the copy of Audio Snippets has its marker, which this copy replaces');
  assert.ok(ten.includes('Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the host, the record is not there yet: wait for it and run the script again.'));
  assert.match(section(aRunbook, '11. Hash the manifest'), /```sh\nnode scripts\/manifest-hash\.mjs https:\/\/mp-suppliers-advocate\.hal8\.ai\n```/);
  const blocks = [...aRunbook.matchAll(/post-advert\.ts( --dry-run)? \x5c\n((?:  --[^\n]+\n)+)/g)];
  assert.equal(blocks.length, 2, 'a dry run and the real run');
  const flags = (body) => Object.fromEntries([...body.matchAll(/--([a-z-]+) (\S+?)(?: \x5c)?(?: \| tail -1\))?$/gm)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')]));
  const [dry, real] = blocks.map((m) => flags(m[2]));
  assert.deepEqual(dry, real);
  assert.deepEqual(real, {
    'capability-id': aExample.ADVERT_CAPABILITY_ID, model: aExample.ADVERT_MODEL, 'max-output-tokens': '8192', 'price-lovelace': aExample.ADVERT_PRICE_LOVELACE,
    'max-processing-ms': aExample.ADVERT_MAX_PROCESSING_MS, 'endpoint-url': aExample.ADVERT_ENDPOINT_URL, 'detail-uri': aExample.ADVERT_DETAIL_URI, 'detail-hash': '$DETAIL_HASH',
  });
  const twelve = section(aRunbook, '12. Post the advert');
  assert.ok(twelve.includes('the model `advocate-v1`, `max_processing_ms` 480000, the price 3000000 and both bonds at 1000000'));
  assert.ok(twelve.includes('The status word stays PROPOSED until step 17.') && twelve.includes('in the Links section of `specs/advocate.md`, in place of the line that says the advert is not posted'));
  // Step 12 ran on 2026-10-19 and its advert is recorded as the step asks: the Links give the explorer link of its transaction in place of the line that said that no advert was posted.
  const prefix = /The link is `(https:\/\/[^`]+\/transaction\/hash\/)` followed by the transaction id/.exec(twelve)?.[1] ?? '';
  const firstAdvert = 'bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc';
  assert.ok(section(ASPEC, 'Links').includes(`- First advert \`${firstAdvert}#0\`, posted on 2026-10-19 in the confirmed transaction [\`${firstAdvert}\`](${prefix}${firstAdvert})`), 'the record step 12 asks for');
  assert.equal(section(ASPEC, 'Links').includes('The advert is not posted.'), false, 'the line step 12 replaced');
  assert.ok(twelve.includes('```sh\ncd "$BASE/repo/deploy/host"\nprintf \'%s\' "$DETAIL_HASH" | grep -Eq \'^[0-9a-f]{64}$\' || echo "not a sha256 hash"\nADVERT_REF=$(' + `${ADC} run --rm --no-deps -T agent \\\n`), 'the real run starts in this folder and checks the hash it takes from the block above');
  const thirteen = section(aRunbook, '13. Start the runtime');
  for (const part of [
    `${ADC} up -d --force-recreate agent`, 'curl -s http://127.0.0.1:8086/status', 'for c in advocate-agent advocate-service; do', '`0 e3b0c44298fc`',
    "docker exec advocate-agent node -e \"for (const n of ['ADVOCATE_BUYER_PRIV_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) console.log(n, (process.env[n] ?? '').length)\"", 'It prints the three names with the length 0.',
    'put its three blank lines back and recreate the runtime', 'writes an interim `102 Processing` line every 60 s',
    'A job that fails as `service_unreachable` at about the five-minute mark means those lines are not arriving (the table at the end).',
  ]) assert.ok(thirteen.includes(part), part);
  // The three names are the ones the compose file blanks for the runtime.
  assert.deepEqual(Object.entries(aAgent.environment).filter(([, value]) => value === '').map(([name]) => name), ['ADVOCATE_BUYER_PRIV_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']);
  assert.ok(section(aRunbook, '14. Check the advert on the indexer').includes('It must print `Active free research.advocate.onesided.v1` and the hash of step 11.'));
});

test('Advocate RUNBOOK: every block that works in a folder starts with its own cd to it, so that it runs alone in a new shell once BASE is set again; the few blocks that name no folder are listed', () => {
  const blocks = [...aRunbook.matchAll(/^( *)```sh\n([\s\S]*?)^\1```$/gm)].map((m) => m[2].split('\n').map((l) => (l.startsWith(m[1]) ? l.slice(m[1].length) : l)).join('\n'));
  assert.equal(blocks.length, 40, 'a block added or taken away is seen here');
  // What names no folder and no file of one: the two variables, the bundle made and the manifest hashed on the operator's machine, the check of the image, the public
  // check of the manifest, the comparison of the tokens, the API keys of the runtime, the log of the first run.
  const NO_FOLDER = [
    'BASE=/opt/advocate\n', 'git bundle create ', 'node scripts/manifest-hash.mjs ', 'docker run --rm --entrypoint node ', 'curl -fsS https://mp-suppliers-advocate.hal8.ai/agent.json\n',
    'for c in advocate-agent advocate-service; do\n', 'docker exec advocate-agent node -e ', 'docker logs --tail 20 advocate-service\n',
  ];
  const IN_A_FOLDER = /^(cd "\$BASE\/(repo\/deploy\/host|repo|ops)"|mkdir -p "\$BASE(\/ops)?" && cd "\$BASE(\/ops)?")\n/;
  const listed = new Set();
  for (const b of blocks) {
    const free = NO_FOLDER.find((start) => b.startsWith(start));
    if (free === undefined) { assert.match(b, IN_A_FOLDER, `a block that works in a folder starts with its cd: ${b.split('\n')[0]}`); continue; }
    listed.add(free);
    assert.doesNotMatch(b, /\$BASE|\.env\.advocate|docker-compose\.advocate\.yml|(^|\s)\.\//m, `a block of the list names no folder: ${free.trim()}`);
  }
  assert.equal(listed.size, NO_FOLDER.length, 'every block of the list is there');
  const cdBlocks = blocks.filter((b) => b.startsWith('cd "$BASE/'));
  for (const needle of ["echo 'PROXY_NETWORK=", 'IMAGE=ghcr.io/', 'awk -F= ', 'keypair_into ADVOCATE_BUYER', 'echo "two different keys"', 'for name in SUPPLIER_ADDRESS ADVOCATE_BUYER_ADDRESS', 'apikey_into BRAVE_SEARCH_API_KEY', "grep -c '^OPERATOR_CONTACT=", 'python3 -m venv venv', `${ADC} up -d service`, 'ADVERT_REF=$(', 'retire-advert.ts']) assert.ok(cdBlocks.some((b) => b.includes(needle)), `the block with ${needle} starts with a cd`);
});

test('Advocate RUNBOOK: every compose command names this agent\'s compose file, every up -d names a service, and nothing uses a port or a container of the other stacks', () => {
  for (const m of aRunbook.matchAll(/docker compose ([^\n`]*)/g)) assert.match(m[1], /^-f docker-compose\.advocate\.yml( |$)/, m[0]);
  const ups = aRunbook.match(/docker compose [^\n`]* up -d[^\n`]*/g);
  assert.ok(ups.length >= 5);
  for (const cmd of ups) assert.match(cmd, / up -d (--force-recreate )?(service|agent)$/, cmd);
  assert.doesNotMatch(aRunbook, /docker compose [^\n]*\brestart\b/);
  assert.doesNotMatch(aRunbook, /8083|8084|8085|9091|9092|9093|agent-history-(agent|service)|document-pipeline-(agent|service)|audio-snippets-(agent|service)/);
});

test('Advocate RUNBOOK step 15 and the first stop: the request of the spec, which the service accepts, the settings of the script, the log line of the code, the cost of the hire; the stop watched before step 17', () => {
  const s15 = section(aRunbook, '15. The first-party run');
  const m = /`PAYLOAD` is the request JSON of the example of `specs\/advocate\.md`: `(\{[^`]+\})`/.exec(s15);
  assert.ok(m, 'the PAYLOAD line');
  assert.equal(m[1], '{"subject":"Should a city ban cars from its centre?","side":"for","length":"short","language":"en"}');
  const [parsed] = inAdvocate("import { parseRequest } from './src/request.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((j) => parseRequest(j))));", [m[1]]);
  assert.deepEqual(parsed, { subject: 'Should a city ban cars from its centre?', side: 'for', audience: null, length: 'short', language: 'en' });
  // The request is the example of the Request section of the spec, word for word.
  const example = /Example:\n\n```json\n([\s\S]*?)\n```/.exec(section(ASPEC, 'Interface'))?.[1] ?? '';
  assert.deepEqual(JSON.parse(example), JSON.parse(m[1]));
  for (const part of [
    '- `CAPABILITY_ID=research.advocate.onesided.v1`.', '- `E2E_POLL_MS=10000`.', '- `E2E_STATE=./e2e-state-advocate.json`.', 'its section "Hiring Advocate" lists them',
    '`[advocate] job done in <ms> ms: results <n>, pages <k>, arguments <a> (dropped <d>), quotes dropped <q>, tokens <p>/<c>; inference marketplace`', 'as the receipt of the chat supplier counts them (`tokens -/-` when that receipt, or OpenRouter on the fallback, gave no count)',
    '`chosen chat supplier: advert <ref>, model <m>, price <p> lovelace, endpoint host <h>`', 'A line that ends `; inference openrouter after <code>` instead means that the hire failed with `<code>` and the brief came from OpenRouter',
    '`inference: marketplace <code> at <stage>, falling back`', '```sh\ndocker logs --tail 20 advocate-service\ndocker exec advocate-service cat /data/stranded.json\n```',
    '`stranded.json` prints `[]`: the hire leaves nothing for the janitor, because its Accept removes its own entry.',
    'The hire costs the hirer about 5: the price, 3, and the supplier bond, 1, which the supplier receives on Accept, and fees of about 1; the buyer bond comes back to the buyer.',
    'The sub-job of the service costs its buyer key about 2.2 on the marketplace path: the price of the chat supplier, 0.2, and its supplier bond, 1, which that supplier receives on Accept, and fees of about 1; the buyer bond of the sub-job comes back to the buyer key.',
    '- `E2E_POLL_MS=10000`. A job takes up to 300 s, its deadline, and longer when the hire of its chat supplier is in its Accept then (the runtime gives up at 360 s), where Agent History\'s takes seconds.',
  ]) assert.ok(s15.includes(part), part);
  // What the model is sent is said in the words of the third-parties entries of the manifest as built (rulings R-E27 and R-F12), read from the code: the prompt goes
  // to the chat supplier, and to OpenRouter only when that hire fails.
  const [parties] = inAdvocate("import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify([manifestFromEnv(JSON.parse(process.argv[1])).behaviour.third_parties]));", { OPERATOR_CONTACT: TEST_CONTACT });
  const sent = /^a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it \(the prompt: (.+)\)$/.exec(parties[2])?.[1] ?? '';
  assert.ok(sent.startsWith('the subject, the side, the audience, the language and the length'), 'the sentence of the manifest, as built');
  assert.equal(parties[3], 'OpenRouter and the model provider behind it (the same prompt), only when that hire fails');
  assert.ok(s15.includes(`and sends the prompt (${sent}) to the chat supplier it hires on the Vector marketplace and the model provider behind it, or, only when that hire fails, to OpenRouter and the model provider behind it.`), 'the step says what the manifest says');
  // The line of a job is the one the real server writes, on the marketplace path and on the fallback (a run stood in for, its outcome in the shape of RunOutcome).
  const [lines] = inAdvocate(
    "import { once } from 'node:events'; import { createServer, manifestFromEnv } from './src/server.ts'; const outcomes = JSON.parse(process.argv[1]); const found = []; " +
    "for (const outcome of outcomes) { const lines = []; const server = createServer({ manifest: manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' }), authHeader: 'Bearer test-token-of-sixteen', log: (l) => lines.push(l), deps: { clock: () => 0 }, runAdvocate: async () => outcome }); " +
    "server.listen(0, '127.0.0.1'); await once(server, 'listening'); const { port } = server.address(); " +
    "await (await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', headers: { authorization: 'Bearer test-token-of-sixteen', 'content-type': 'application/json' }, body: JSON.stringify([{ content: JSON.stringify({ subject: 'Cars in the centre', side: 'for' }), role: 'user' }]) })).text(); " +
    "server.close(); server.closeAllConnections(); found.push(lines.find((l) => l.startsWith('job done in ')) ?? ''); } console.log(JSON.stringify([found]));",
    ['marketplace', 'openrouter'].map((path) => ({
      result: { schema: 'vector.advocate.brief.v1', arguments: [] }, pagesKept: 3, resultsFound: 7, usage: { prompt_tokens: 4321, completion_tokens: 512 }, dropped: { quotes: 3, arguments: 1 },
      inference: { path, model: 'deepseek/deepseek-v4-flash', subJob: null, accepted: path === 'marketplace' ? 'confirmed' : null, fallbackFrom: path === 'marketplace' ? null : 'llm_send_lost' },
    })),
  );
  assert.deepEqual(lines, [
    'job done in 0 ms: results 7, pages 3, arguments 0 (dropped 1), quotes dropped 3, tokens 4321/512; inference marketplace',
    'job done in 0 ms: results 7, pages 3, arguments 0 (dropped 1), quotes dropped 3, tokens 4321/512; inference openrouter after llm_send_lost',
  ]);
  // The lines of the hire are the code's: the choice of the kit, and the line of the service about where the hire ended.
  assert.ok(read('packages/hire-kit/src/select.ts').includes('supplier: advert ${'), 'the kit writes the line of the choice');
  for (const part of ['inference: marketplace ', 'falling back']) assert.ok(A_SRC.includes(part), `the code writes: ${part}`);
  assert.ok(A_SRC.includes('usage: usageOf(hired.record.receipt)'), 'on the marketplace path the tokens of the line are the counts the receipt of the chat supplier names');
  assert.ok(s15.includes('A first-party run is not demand.'));
  // docs/E2E.md carries the same settings: the request JSON, the pause and the state file are written alike in both.
  const e2e = section(read('docs/E2E.md'), 'Hiring Advocate');
  for (const setting of [m[1], 'export CAPABILITY_ID=research.advocate.onesided.v1', 'export E2E_POLL_MS=10000', 'export E2E_STATE=./e2e-state-advocate.json']) assert.ok(e2e.includes(setting), `docs/E2E.md has the setting: ${setting}`);
  const stop = section(aRunbook, 'Watch the first stop');
  for (const part of [`time ${ADC} stop service`, 'docker logs --tail 5 advocate-service', "docker inspect --format '{{.State.ExitCode}}' advocate-service", 'The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`.']) assert.ok(stop.includes(part), part);
  assert.ok(read('packages/service-kit/src/lifecycle.ts').includes('opts.log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);'));
  assert.ok(aRunbook.indexOf('\n## Watch the first stop\n') > aRunbook.indexOf('\n## 15. ') && aRunbook.indexOf('\n## Watch the first stop\n') < aRunbook.indexOf('\n## 16. '));
});

test('Advocate RUNBOOK step 17 and Back out: the old advert retired before the restart, the last item names the files that carry the word; the advert first, then the service finishes what it holds and the containers stop with the volume kept, then Caddy, then the keys, the buyer wallet, the volume and the API keys', () => {
  const s17 = section(aRunbook, '17. Flip the status');
  const item8 = s17.slice(s17.indexOf('8. In the repository'));
  for (const f of ['specs/advocate.md', 'agents/advocate/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md', ...['README.md', 'RUNBOOK-advocate.md', 'docker-compose.advocate.yml', 'Caddyfile.advocate.snippet', '.env.advocate.example'].map((f) => `deploy/host/${f}`), 'agents/advocate/src/server.ts', 'agents/advocate/agent.json.template', 'agents/advocate/test/server.test.ts', 'agents/advocate/test/start.test.ts', 'agents/advocate/test/spec.test.ts', 'agents/advocate/test/readme.test.ts', 'scripts/specs.test.mjs', 'scripts/deploy.test.mjs']) {
    assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
    assert.ok(existsSync(join(root, f)), `${f} exists`);
  }
  assert.ok(item8.includes('`pnpm --filter @vsa/advocate template`') && JSON.parse(read('agents/advocate/package.json')).scripts.template === 'node --import tsx scripts/render-template.mjs');
  // The word is carried as a default by the code, as the item says: deployed since the flip of 2026-10-20, in the code and in the manifest the template holds.
  const server = read('agents/advocate/src/server.ts');
  assert.ok(server.includes("statusChip(env.AGENT_STATUS_CHIP, 'deployed')") && server.includes("statusSince(env.AGENT_STATUS_SINCE, '2026-10-20')"), 'the code carries the word as a default, as the item says');
  assert.equal(server.includes("statusChip(env.AGENT_STATUS_CHIP, 'proposed')") || server.includes("'2026-10-13'"), false, 'the default of before the flip');
  assert.deepEqual(JSON.parse(read('agents/advocate/agent.json.template')).status, { chip: 'deployed', since: '2026-10-20' });
  // Every test of the agent that pins the default word is named, so that a change of it is not found out by a test that fails: server.test.ts and start.test.ts hold it (the status of
  // /agent.json of a service started with no AGENT_STATUS_CHIP), and a test written later that holds it is found here and has to be named too.
  const pinning = sourceFiles('agents/advocate/test').filter((f) => read(f).includes("chip: 'deployed', since: '2026-10-20'"));
  assert.ok(pinning.includes('agents/advocate/test/server.test.ts') && pinning.includes('agents/advocate/test/start.test.ts'), `the files that pin the default word: ${pinning}`);
  for (const f of pinning) assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}, which pins the default word`);
  const back = section(aRunbook, 'Back out');
  const at = (needle) => { const i = back.indexOf(needle); assert.ok(i >= 0, needle); return i; };
  const order = [
    '1. Retire the advert.', 'agent/src/cli/retire-advert.ts', '2. Stop the containers, operator or host administrator, once the janitor has nothing left to settle:', 'docker exec advocate-service cat /data/stranded.json',
    'An escrow whose `deliver_by` has not come yet is waited for', `${ADC} down`,
    '3. Host administrator: remove the Caddy block of this agent', '4. Operator: the keys and the state volume.', 'The buyer wallet is emptied last, with the buyer key, once `stranded.json` is `[]`',
    'The volume goes after the buyer wallet, and only when the agent will not come back: `docker volume rm advocate-state`.', 'The two API keys stay valid on their accounts until the operator revokes them there',
  ];
  const places = order.map(at);
  assert.deepEqual([...places].sort((a, b) => a - b), places);
  assert.ok(back.includes('`shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"`'));
  for (const part of [
    'Then the service gets to finish what it holds, and only then do the containers stop.',
    '`docker exec advocate-service cat /data/stranded.json` prints `[]`, or lists only escrows whose janitor line reads `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` (the table at the end), which nothing can settle.',
    'An escrow whose line says `its Accept <tx> may still land until <time>` is waited for in the same way, or accepted again by hand (its row in the table at the end).',
    'An escrow whose `deliver_by` has not come yet is waited for: the janitor reclaims it 5 s after its `deliver_by`, logging `janitor: reclaimed <escrow>: ...`.',
    'The buyer wallet is emptied last, with the buyer key, once `stranded.json` is `[]` or lists only escrows whose janitor line reads `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` (or was never written;',
    'Never add `-v`: the volume `advocate-state` holds `stranded.json`, the escrows that still lock the buyer\'s units, and the janitor of the next start reads it. `down` keeps it.',
    'The env file still holds both keys, and so does the operator\'s offline store: keep both until both wallets are empty',
    'No script of this pack does that: none signs with the buyer key', 'docker run --rm -v advocate-state:/data alpine cat /data/stranded.json',
  ]) assert.ok(back.includes(part), `Back out says: ${part}`);
  assert.equal(back.includes('There is no volume to keep'), false, 'the words of before the state');
  assert.doesNotMatch(back, /once the service holds nothing|lists only escrows whose `deliver_by` has not come yet/, 'the words of before: a stop with escrows not yet due, and a wait for [] that a Submitted escrow never ends');
  assert.doesNotMatch(back, /lists only Submitted escrows/, 'the words of before: an Accept that may still land also begins its janitor line with Submitted');
  // The two lines Back out quotes are the janitor's (packages/hire-kit/src/janitor.ts), where a Submitted escrow is kept and never reclaimed; the table at the end has its row.
  const janitor = read('packages/hire-kit/src/janitor.ts');
  assert.ok(janitor.includes("return did('kept', `Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest`);"));
  assert.ok(janitor.includes('log(`janitor: ${action.action} ${action.escrow_ref}: ${action.note}`)'));
  assert.ok(section(aRunbook, 'If something goes wrong').includes('| `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` |'));
  // The line of an escrow whose Accept may still land is the janitor's too, and the table at the end has its row.
  assert.ok(janitor.includes("if (now < pending.valid_to) return did('kept', `Submitted: its Accept ${pending.tx_hash} may still land until ${iso(pending.valid_to)}`);"));
  assert.ok(section(aRunbook, 'If something goes wrong').includes('| `janitor: kept <escrow>: Submitted: its Accept <tx> may still land until <time>` |'));
  // The janitor reclaims 5 s after deliver_by, as the kit says.
  assert.ok(read('packages/hire-kit/src/janitor.ts').includes('export const JANITOR_GRACE_MS = 5_000;'));
  assert.ok(back.includes('   ```sh\n   cd "$BASE/repo/deploy/host"\n   ' + `${ADC} run --rm --no-deps -T agent \\\n     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \\\n`), 'the block that retires the advert starts in this folder: it may run in a new shell');
});

test('Advocate RUNBOOK step 15 and Back out in the code: stranded.json is not there until an escrow is recorded, the janitor logs nothing for an empty store or an escrow not yet due, reclaims one 5 s after its deliver_by, and keeps a Submitted one with no Reclaim', () => {
  const s15 = section(aRunbook, '15. The first-party run');
  for (const part of [
    'If `cat` says `No such file or directory`, no escrow has been posted from this volume yet, and the brief came from OpenRouter.',
    'The janitor writes a line only when it acts on an escrow (the table at the end), so a clean run has none.',
    'The check of step 6 shows the buyer wallet before and after.',
  ]) assert.ok(s15.includes(part), `step 15 says: ${part}`);
  // The check of step 6 reads the buyer address with the supplier's.
  const six = section(aRunbook, '6. Supply the two wallets with their collateral and float');
  assert.ok(six.includes('for name in SUPPLIER_ADDRESS ADVOCATE_BUYER_ADDRESS; do') && six.includes('"$BASE/ops/mcp-call.sh" vector_get_utxos'));
  // The code the sentences state: the janitor logs every action but waiting and deferred; the store writes its file only when an entry is added, changed or removed;
  // a brief of the marketplace comes only after a Post, whose record is the first write.
  const janitor = read('packages/hire-kit/src/janitor.ts');
  assert.ok(janitor.includes("for (const action of actions) if (action.action !== 'waiting' && action.action !== 'deferred') log(`janitor: ${action.action} ${action.escrow_ref}: ${action.note}`);"));
  assert.ok(janitor.includes('if (this.#entries.delete(canonicalRef(escrowRef))) this.#write();'), 'a remove of an escrow the store does not hold writes nothing');
  const hire = read('packages/hire-kit/src/hire.ts');
  assert.ok(hire.includes('const post = await postEscrow(deps, supplier, job, ledger, errors);'), 'a hire posts first');
  assert.ok(hire.includes("recorded(errors, factsOf('post', post.escrowRef, false), () => deps.stranded.add({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: supplier.hop }),"), 'and records the Post once it is confirmed');
  // And what they do, through the kit itself: a store in a folder of its own, and passes of the janitor at the moments that matter, against a stand-in of the chain.
  const [seen] = inAdvocate(
    "import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; " +
    "import { JANITOR_GRACE_MS, STRANDED_FILE, StrandedStore, startJanitor } from '@vsa/hire-kit'; " +
    "const dir = mkdtempSync(join(tmpdir(), 'advocate-stranded-')); const file = join(dir, STRANDED_FILE); const ref = (d) => `${d.repeat(64)}#0`; const due = 1_000_000; " +
    "try { const store = new StrandedStore(dir); const seen = { made: existsSync(file) }; const states = { [ref('1')]: 'Open', [ref('2')]: 'Submitted' }; const reclaims = []; " +
    "const chain = { escrowState: async (r) => states[r] ?? 'Open', reclaim: async (r) => { reclaims.push(r); return { txHash: 'f'.repeat(64) }; }, accept: async () => { throw new Error('no Accept here'); } }; " +
    "const pass = async (now) => { const lines = []; await startJanitor(store, chain, 60_000, { clock: () => now, log: (l) => lines.push(l) }).stop(); return lines; }; " +
    "seen.empty = await pass(due + JANITOR_GRACE_MS); store.remove(ref('3')); seen.afterNothing = existsSync(file); " +
    "store.add({ escrow_ref: ref('3'), deliver_by: due, posted_at: 0, kind: 'llm' }); seen.recorded = existsSync(file); seen.notDue = await pass(due + JANITOR_GRACE_MS - 1); " +
    "store.remove(ref('3')); seen.accepted = readFileSync(file, 'utf8'); " +
    "for (const d of ['1', '2']) store.add({ escrow_ref: ref(d), deliver_by: due, posted_at: 0, kind: 'llm' }); seen.due = await pass(due + JANITOR_GRACE_MS); seen.reclaims = reclaims; " +
    "seen.left = JSON.parse(readFileSync(file, 'utf8')).map((e) => e.escrow_ref); seen.grace = JANITOR_GRACE_MS; console.log(JSON.stringify([seen])); } finally { rmSync(dir, { recursive: true, force: true }); }",
    null,
  );
  const ref = (d) => `${d.repeat(64)}#0`;
  assert.deepEqual([seen.made, seen.afterNothing, seen.recorded], [false, false, true], 'no file until an escrow is recorded: cat says No such file or directory');
  assert.deepEqual([seen.empty, seen.notDue], [[], []], 'no line for an empty store, nor for an escrow before its deliver_by and 5 s: a clean run has none');
  assert.equal(seen.accepted, '[]\n', 'the Accept removes its own entry: cat prints []');
  assert.equal(seen.grace, 5_000, 'the 5 s of Back out');
  assert.equal(seen.due.length, 2, seen.due.join('\n'));
  assert.ok(seen.due[0].startsWith(`janitor: reclaimed ${ref('1')}: `), seen.due[0]);
  assert.ok(seen.due[1].startsWith(`janitor: kept ${ref('2')}: Submitted: it cannot be reclaimed, and its supplier may release it from `), seen.due[1]);
  assert.deepEqual(seen.reclaims, [ref('1')], 'the Submitted escrow gets no Reclaim');
  assert.deepEqual(seen.left, [ref('2')], 'and stays listed: Back out stops the containers with it');
});

test('Advocate RUNBOOK step 16: the wallet monitor is not used for this agent either, both floats are read by hand, and the buyer float falls with every job on the marketplace path while /healthz stays ok', () => {
  const s16 = section(aRunbook, '16. Wallet monitor');
  for (const part of [
    "Not used for this agent, as for the other three (step 16 of RUNBOOK.md): the fleet's wallet monitor does not watch these wallets, and this runbook does not change that.",
    'Both floats are read by hand with the check of step 6.',
    'The buyer float falls by about 2.2 with every job on the marketplace path, nothing tops it up, and the service does not say that it is low: its `/healthz` stays ok, and a job it cannot cover gets its brief from OpenRouter, its line ending `; inference openrouter after insufficient_float`.',
    'So read the buyer wallet after the first-party run and whenever jobs fall back for that reason, and ask the Foundation for a top-up.',
    '`Apex-Fusion/agents-marketplace`', '`wallet-monitor/wallets.json`', '"supplier-advocate"', '"buyer-advocate"', '<SUPPLIER_ADDRESS from the env file>', '<ADVOCATE_BUYER_ADDRESS from the env file>',
    'The monitor posts to Slack when a wallet drops below its threshold.',
  ]) assert.ok(s16.includes(part), `step 16 says: ${part}`);
  assert.doesNotMatch(s16, /upstream repository|503|watched by the service itself/, "the words of the Pipeline's step 16, whose service watches its float");
  // The 2.2 is the net of a job of the collateral row and of step 15.
  assert.ok(section(aRunbook, 'Collateral and float').includes('so about 2.2 net a job.') && section(aRunbook, '15. The first-party run').includes('The sub-job of the service costs its buyer key about 2.2 on the marketplace path'));
  // "does not say that it is low": the server of Advocate gives the kit no health check, and without one /healthz always answers ok; a job whose float is short
  // falls back with insufficient_float, and its line names the code.
  const server = read('agents/advocate/src/server.ts');
  assert.equal(server.includes('health:') || server.includes('HealthMonitor'), false, 'no health check is given to the server');
  assert.ok(read('packages/service-kit/src/server.ts').includes('if (health === undefined) return send(200, { ok: true });'));
  assert.ok(read('agents/advocate/src/inference.ts').includes("if (wallet.collateralLovelace === null || wallet.floatLovelace < subJobFloat(lock)) return fallBack('insufficient_float', 'float');"));
  assert.ok(server.includes("`openrouter after ${outcome.inference.fallbackFrom ?? '-'}`"));
  const [health] = inAdvocate(
    "import { once } from 'node:events'; import { createServer, manifestFromEnv } from './src/server.ts'; " +
    "const server = createServer({ manifest: manifestFromEnv({ OPERATOR_CONTACT: 'ops@example.test' }), authHeader: 'Bearer test-token-of-sixteen', log: () => undefined, deps: { clock: () => 0 }, runAdvocate: async () => { throw new Error('no job here'); } }); " +
    "server.listen(0, '127.0.0.1'); await once(server, 'listening'); const r = await fetch(`http://127.0.0.1:${server.address().port}/healthz`); const body = await r.text(); " +
    "server.close(); server.closeAllConnections(); console.log(JSON.stringify([[r.status, body]]));",
    null,
  );
  assert.deepEqual(health, [200, '{"ok":true}'], 'a service with no chain and no wallet at all answers /healthz ok');
});

test('Advocate RUNBOOK first stop: a stop during a job waits for it as long as the code waits, and a stop that kills a running job strands the escrow of its sub-job for the janitor of the next start', () => {
  const stop = section(aRunbook, 'Watch the first stop');
  const [wait] = inAdvocate("import { SHUTDOWN_WAIT_MS } from './src/start.ts'; console.log(JSON.stringify([SHUTDOWN_WAIT_MS]));", null);
  assert.equal(wait, 300_000);
  for (const part of [
    `On SIGTERM (\`docker stop\` sends it) the service takes no new job and waits up to ${wait / 1000} s for the one that is running, its Accept included,`,
    'and a stop that kills a running job fails it for the hirer and strands the escrow of its sub-job for the janitor.',
    `\`/status\` must say \`free\`: a stop during a job waits for the job, up to ${wait / 1000} s, which is what the grace period is for;`,
  ]) assert.ok(stop.includes(part), `the first stop says: ${part}`);
  // The entry of the service stops on the signals with the wait of the kit, and the grace period of the compose file is that wait and 30 s more.
  assert.ok(read('agents/advocate/src/index.ts').includes('stopOnSignals(await startService());'), 'with no wait of its own');
  assert.ok(read('packages/service-kit/src/lifecycle.ts').includes('const waitMs = opts.waitMs ?? SHUTDOWN_WAIT_MS;'));
  assert.equal(aService.stop_grace_period, `${wait / 1000 + 30}s`);
  // The escrow of a sub-job is in the state directory from its Post until its Accept, and the start reads the file the last process left.
  const hire = read('packages/hire-kit/src/hire.ts');
  const recordedAt = hire.indexOf('() => deps.stranded.add({ escrow_ref: post.escrowRef, deliver_by: post.deliverBy, posted_at: post.postedAt, kind: supplier.hop })');
  const removedAt = hire.indexOf('try { deps.stranded.remove(post.escrowRef); }');
  assert.ok(recordedAt > 0 && removedAt > recordedAt, 'recorded when its Post is confirmed, removed after its Accept');
  assert.ok(A_SRC.includes('const stranded = new StrandedStore(config.stateDir);'), 'the start reads stranded.json, for its janitor');
});

test('Advocate RUNBOOK failure table: the refusals at start, the API keys, the codes of a job with their statuses, the network, each as the code words it', () => {
  const table = section(aRunbook, 'If something goes wrong');
  const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| What you see |'));
  assert.ok(rows.length >= 40, `${rows.length} rows`);
  for (const row of rows) assert.equal(row.split(' | ').length, 3, `three columns: ${row.slice(0, 60)}`);
  const sources = {
    kitEnv: read('packages/service-kit/src/env.ts'), kitServer: read('packages/service-kit/src/server.ts'), search: read('agents/advocate/src/search.ts'), start: read('agents/advocate/src/start.ts'),
    server: read('agents/advocate/src/server.ts'), janitor: read('packages/hire-kit/src/janitor.ts'), inference: read('agents/advocate/src/inference.ts'), hire: read('packages/hire-kit/src/hire.ts'),
  };
  for (const [row, where, quote] of [
    ['`environment variable OPERATOR_CONTACT is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SUPPLIER_PKH is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SUPPLIER_PUB_KEY_HEX is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable SERVICE_AUTH_HEADER is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable BRAVE_SEARCH_API_KEY is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`environment variable OPENROUTER_API_KEY is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['must be printable ASCII', 'kitEnv', 'must be printable ASCII (it is sent as an HTTP header)'],
    ['`request refused: unauthorized (<n> since the last line of this kind)`', 'kitServer', 'request refused: unauthorized (${refusals} since the last line of this kind)'],
    ['`holds the service token, which belongs in SERVICE_AUTH_HEADER alone`', 'kitEnv', 'holds the service token, which belongs in SERVICE_AUTH_HEADER alone'],
    ['`search: the key was refused (HTTP <status>)`', 'search', 'the key was refused (HTTP '],
    ['`environment variable ADVOCATE_BUYER_PRIV_KEY_HEX is required`', 'kitEnv', 'environment variable ${name} is required'],
    ['`holds the buyer key, which belongs in ADVOCATE_BUYER_PRIV_KEY_HEX alone`', 'start', 'holds the buyer key, which belongs in ADVOCATE_BUYER_PRIV_KEY_HEX alone'],
    ['`is not the key hash of the key in ADVOCATE_BUYER_PRIV_KEY_HEX`', 'start', 'is not the key hash of the key in ADVOCATE_BUYER_PRIV_KEY_HEX'],
    ['`is not the address of the key in ADVOCATE_BUYER_PRIV_KEY_HEX`', 'start', 'is not the address of the key in ADVOCATE_BUYER_PRIV_KEY_HEX'],
    ['`environment variable ADVERT_MAX_PROCESSING_MS must be at least 480000`', 'server', 'environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS}'],
    ['`which cannot be written`', 'start', 'which cannot be written'],
    ['`is not a list of stranded escrows`', 'janitor', 'is not a list of stranded escrows'],
    ['`is not the public key of the key in ADVOCATE_BUYER_PRIV_KEY_HEX`', 'start', 'is not the public key of the key in ADVOCATE_BUYER_PRIV_KEY_HEX'],
    ['`holds the key of SUPPLIER_PKH`', 'start', 'holds the key of SUPPLIER_PKH'],
    ['`environment variable LLM_MODEL_ALLOWLIST must be a comma-separated list of models`', 'server', 'environment variable LLM_MODEL_ALLOWLIST must be a comma-separated list of models'],
    ['`environment variable LLM_MODEL_ALLOWLIST must name at least one model`', 'server', 'environment variable LLM_MODEL_ALLOWLIST must name at least one model'],
    ['`inference: marketplace llm_supplier_unavailable at choice, falling back`', 'inference', "fallBack('llm_supplier_unavailable', 'choice')"],
    ['the stranded store could not mark the Accept of the chat sub-job', 'inference', 'the stranded store could not mark the Accept of the chat sub-job at accept'],
    ['accept it again by hand at once, within 600 s of its Submit', 'inference', 'accept it again by hand at once, within 600 s of its Submit'],
    ['`janitor: kept <escrow>: Submitted: its Accept <tx> may still land until <time>`', 'janitor', 'Submitted: its Accept ${pending.tx_hash} may still land until ${iso(pending.valid_to)}'],
    ["`janitor: kept <escrow>: Submitted: its Accept <tx> did not land by <time> and the accept window may be over; lost to its supplier's release from <time> at the latest`", 'janitor', "; lost to its supplier's release from ${iso(lostAfter)} at the latest"],
    ['`escrow <escrow> was accepted for the brief in <tx> and could not be removed from the stranded store (<error>); ...`', 'hire', 'was accepted for ${job.label} in ${accepted.txHash} and could not be removed from the stranded store (${errorText(err)}); the janitor drops it once it reads it spent'],
    ['`janitor: reclaimed <escrow>: ...`', 'janitor', 'janitor: ${action.action} ${action.escrow_ref}: ${action.note}'],
    ['`janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest`', 'janitor', 'Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest'],
    ['`janitor: the pass failed`', 'janitor', 'janitor: the pass failed'],
  ]) {
    assert.ok(table.includes(row), `the table quotes ${row}`);
    assert.ok(sources[where].includes(quote), `${where} prints ${quote}`);
  }
  // A line of the service about a hire carries its code and its stage, never the reason the kit gave (ruling R-F8), with one exception: an advert that the choice refuses for a bond above a
  // limit of the operator gets a line that names the advert, the bond and the limit. The choice keeps no other reason of the kit, so the table quotes none of them.
  assert.ok(sources.inference.includes("return new HopFailed('llm_supplier_unavailable', null);") && sources.inference.includes('if (refusal !== null) log(refusal);'), 'the choice keeps no reason of the kit but the one of a bond');
  assert.equal(table.includes('above the ceiling of'), false, 'no line of the service quotes the reason of the kit');
  // The wait before a query that answered 429 is asked again, and the time of the model call, are the code's (src/search.ts, src/budget.ts).
  assert.ok(table.includes('a query that answers 429 is asked once more, 1100 ms later') && A_SRC.includes('export const QUERY_SPACING_MS = 1_100;'));
  assert.ok(table.includes('gave no answer within the full 90 s (with less time left, the job fails as `deadline`), or could not be made') && A_SRC.includes('export const MODEL_MAX_MS = 90_000;'));
  // The codes of a job, with the status each answers with, are those of src/errors.ts.
  const [statuses] = inAdvocate("import { JOB_STATUS } from './src/errors.ts'; console.log(JSON.stringify([JOB_STATUS]));", null);
  for (const code of ['search_failed', 'search_empty', 'no_sources', 'model_failed', 'model_output_invalid', 'no_supported_claims', 'deadline', 'inference_failed']) {
    assert.ok(rows.some((r) => r.startsWith(`| Jobs fail with \`${code}\` (${statuses[code]})`)), `a row for ${code} (${statuses[code]})`);
  }
  assert.ok(rows.some((r) => r.startsWith(`| A job fails with \`store_write_failed\` (${statuses.store_write_failed})`)), 'a row for store_write_failed');
  assert.deepEqual([statuses.inference_failed, statuses.store_write_failed], [502, 500]);
  // The fallback: a job's line ends with the code that sent it to OpenRouter, for each code of a hire that falls back, and the two that do not are rows of their own.
  for (const ending of ['insufficient_float', 'llm_supplier_unavailable', 'llm_<what>', 'marketplace_off']) assert.ok(rows.some((r) => r.startsWith(`| A job's line ends \`; inference openrouter after ${ending}\``)), `a row for ${ending}`);
  const fallbackRow = rows.find((r) => r.startsWith("| A job's line ends `; inference openrouter after llm_<what>`")) ?? '';
  for (const code of ['llm_post_failed', 'llm_out_of_time', 'llm_busy', 'llm_timeout', 'llm_refused', 'llm_send_lost', 'llm_failed', 'llm_receipt_unavailable', 'llm_bad_result', 'llm_receipt_failed', 'llm_incomplete', 'model_output_invalid']) assert.ok(fallbackRow.includes(`\`${code}\``), `the row names ${code}`);
  // Every failure of the kit's hire is llm_<what> (src/inference.ts), and all but the Accept fall back: the busy and the timeout of an advert whose window is short
  // enough are among them.
  for (const what of ['busy', 'timeout']) assert.ok(sources.hire.includes(`failure(errors, supplier, '${what}',`), `the kit fails a hire with ${what}`);
  assert.ok(sources.inference.includes('failure: (kind, what, _message, facts) => new HopFailed(`${kind}_${what}`, facts),'), 'as llm_<what>');
  assert.ok(rows.some((r) => r.startsWith('| Jobs fail with `inference_failed` (502), and the line before says `inference: marketplace llm_accept_failed at accept, not falling back` |')));
  for (const part of [
    'Until the service restarts it posts no escrow: every later job gets its brief from OpenRouter, and its line ends `; inference openrouter after marketplace_off`.',
    'the hire had under 60 s left to its end when it was to begin or to post (`llm_out_of_time`, at `start` or at `post`)',
    "No script of this pack signs with the buyer key, which is the service's, so the reclaim is manual: build it with `vector_build_marketplace_reclaim` on the hosted server and sign it with the buyer key on the host by the same byte-preserving means as the supplier's transactions",
    "The buyer wallet could not cover the chat sub-job: its float outside the collateral is under the lock of the advert chosen and two fee budgets of 0.5, which is 3.2 at today's fleet price of 0.2,",
    '`/healthz` stays ok, because the service can still answer.',
    'A brief of a chat supplier that the check empties is not asked of OpenRouter again: its sub-job was settled, and the code is the job\'s.',
    'A failure at about 300 s into a job is the silence limit: the interim `102 Processing` lines of step 13 are not arriving.',
    String.raw`with ` + "`" + String.raw`sed -i 's/^\(ADVOCATE_BUYER_[A-Z_]*\)=.*/\1=/' .env.advocate` + "`",
  ]) assert.ok(table.includes(part), `the table has: ${part}`);
  // The row of a kept Submitted escrow names the two ways a job leaves one after its supplier answered: an Accept that could not be made (llm_accept_failed, the job
  // fails inference_failed) and a mark of a sent Accept that could not be written (store_write_failed at accept), each in the words of the kit and of the service.
  const keptRow = rows.find((r) => r.startsWith('| `janitor: kept <escrow>: Submitted:')) ?? '';
  assert.ok(keptRow.includes('| The supplier submitted a receipt that the job did not accept (it failed a check, or the hire ran out of its time), or whose Accept did not land (the `inference_failed` row, and the failed mark of the `store_write_failed` row). A Submitted escrow cannot be reclaimed, and the lock goes to the supplier when it releases. |'));
  assert.ok(sources.hire.includes('Its escrow ${post.escrowRef} stays recorded for the janitor.`, at());'), 'an Accept that could not be made leaves its escrow recorded');
  assert.ok(sources.hire.includes('and the store does not say so: the janitor takes it for a Submitted escrow it cannot accept.'), 'a mark that could not be written leaves it as a Submitted escrow');
  assert.ok(sources.inference.includes("const NO_FALLBACK: ReadonlySet<string> = new Set(['llm_accept_failed', 'store_write_failed']);"));
  // An Accept that may still land: on the real chain it is valid to the end of the accept window (the vendored planAccept), so the operator does not wait for it to
  // fail. The row of the janitor's line waits for it and has the escrow accepted again by hand while it reads Submitted, within the window, and so does the row of
  // a mark that could not be written; after the window the janitor records it as lost (packages/hire-kit/src/janitor.ts).
  const landing = rows.find((r) => r.startsWith('| `janitor: kept <escrow>: Submitted: its Accept <tx> may still land until <time>` |')) ?? '';
  for (const part of [
    'the end of its validity, which on the real chain is the end of the 600 s accept window after the Submit', 'Wait for it as for an escrow not yet due',
    'If it has not landed with time left in the window, accept the escrow again by hand within 600 s of its Submit (`vector_build_marketplace_accept`, signed as the manual reclaim of the `store_write_failed` row is; an escrow is accepted once, so a second Accept fails if the first lands).',
    'After `<time>`, if it is still Submitted, the janitor records it as lost and its supplier may release it.',
  ]) assert.ok(landing.includes(part), `the row says: ${part}`);
  const storeRow = rows.find((r) => r.startsWith('| A job fails with `store_write_failed` (500) |')) ?? '';
  assert.ok(storeRow.includes('Submitted after a mark of its Accept that failed: that Accept may still land, so read it on chain now and, while it is still Submitted, accept it again by hand at once, within 600 s of its Submit (build the Accept with `vector_build_marketplace_accept`; an escrow is accepted once, so a second Accept fails if the first lands), after which its supplier may release it.'));
  assert.ok(read('packages/buyer-core/src/vendored/mcp/marketplace-build.ts').includes('const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;'), 'an Accept is valid to the end of the accept window');
  assert.ok(sources.janitor.includes("if (now >= entry.posted_at + ACCEPT_WINDOW_MS) return lost(' and the accept window may be over');"), 'past its validity the janitor records it as lost');
  assert.equal(table.includes('can no longer land'), false, 'the instruction that could not be followed: a wait for an Accept that is valid to the end of the window');
  // The one write of the file after a Post that fails no job (ruling R62): the removal of an entry once its Accept is confirmed, in the words of the kit, for the brief.
  const removal = rows.find((r) => r.startsWith('| `escrow <escrow> was accepted for the brief in <tx>')) ?? '';
  assert.ok(removal.includes('It is the one write of the file after a Post that fails no job: the job stands, and the service goes on posting escrows.') && sources.hire.includes('// The one write of the store that does not fail the run (ruling R62)'));
  assert.ok(sources.inference.includes("const BRIEF_LABEL = 'the brief';"), 'the job of the line is the brief');
  // The Next step of the R62 row and of the row of an Accept that may still land, whole (the review of Plan E2). The entry the removal of R62 leaves behind has no mark, so the janitor reads it
  // only from 5 s after its deliver_by (packages/hire-kit/src/janitor.ts); the hand Accept is made while the escrow reads Submitted with time left in the window.
  const nextStep = (r) => (r.split(' | ')[2] ?? '').replace(/ \|$/, '');
  assert.equal(nextStep(removal), 'Nothing for the escrow: the janitor drops its entry once two passes in a row, from 5 s after its `deliver_by`, find the escrow settled. Look at the disk and at the volume, as in the row above: the next write that fails after a Post fails its job.');
  assert.equal(nextStep(landing), 'Wait for it as for an escrow not yet due: once the Accept lands, the escrow is settled and the janitor drops its entry. If it has not landed with time left in the window, accept the escrow again by hand within 600 s of its Submit (`vector_build_marketplace_accept`, signed as the manual reclaim of the `store_write_failed` row is; an escrow is accepted once, so a second Accept fails if the first lands). After `<time>`, if it is still Submitted, the janitor records it as lost and its supplier may release it.');
  assert.ok(sources.janitor.includes("if (entry.accept_pending === undefined) {\n    const due = entry.deliver_by + JANITOR_GRACE_MS;\n    if (now < due) return did('waiting', `due at ${iso(due)}`);\n  }"), 'an entry with no mark is read from 5 s after its deliver_by');
  assert.ok(sources.hire.includes('try { deps.stranded.remove(post.escrowRef); } catch (err) {'), 'the removal of R62 changes nothing in the entry it could not remove');
  // The end of a hire the deadline row gives is the one of a hire that fails, as on the page (Time) and in the head of the runbook: a hire that is verified ends in its Accept. The sentence of
  // the row is held whole, with the numbers of the code, below.
  assert.equal(table.includes('can end the hire as late as'), false, 'the words of before');
  // The characters of an entry of LLM_MODEL_ALLOWLIST are those the start takes (src/server.ts).
  const allowRow = rows.find((r) => r.includes('`environment variable LLM_MODEL_ALLOWLIST must be a comma-separated list of models`')) ?? '';
  assert.ok(allowRow.includes('or an entry that is not letters, digits, dots, underscores, colons, slashes and hyphens alone.') && sources.server.includes('each of letters, digits, dots, underscores, colons, slashes and hyphens only, and its entry'), 'the characters of an entry');
  assert.ok(sources.inference.includes("super(hopCode === 'store_write_failed' ? 'store_write_failed' : 'inference_failed', hopDetail(hopCode, facts));"));
  // Ruling R-E26: the log shows words of an answer only when its status is not 200. A 200 is an answer of the model, which can quote a page or the request, so for a
  // 200 whose body or content cannot be read the line gives the reason and the length, never the text. Ruling R-E30: of an answer that is not 200 the line shows the
  // code and the first 200 characters of the message when it is the JSON of an error, never its metadata, and otherwise the first 200 characters of the answer. The
  // two rows say so, and the code does it (a call to the real code with stand-ins for OpenRouter, whose answers hold a text that must not reach the log).
  const failedRow = rows.find((r) => r.startsWith('| Jobs fail with `model_failed` (502)')) ?? '';
  const invalidRow = rows.find((r) => r.startsWith('| Jobs fail with `model_output_invalid` (502)')) ?? '';
  assert.ok(failedRow.includes('The log says which, with the HTTP status when there is one. When the status is not 200 it shows the error of the provider: its code and the first 200 characters of its message when the answer is the JSON of an error, never its metadata, which can hold a part of the request, and the first 200 characters of the answer when it is not. For a 200 whose body is not JSON or has no content it gives the reason and the length of the body in characters, never its text. Never the key.'));
  assert.ok(invalidRow.includes('The log line of the job gives the reason and the length of the content in characters, never its text.'));
  assert.doesNotMatch(table, /with the HTTP status and the first 200 characters of the answer|has the first 200 characters of it|only when the status is not 200 \(the error text of the provider\)/, 'the words of before the rulings');
  const bodies = {
    refused: `busy ${'x'.repeat(400)}`, notJson: `AN-ANSWER-TEXT ${'y'.repeat(100)}`, content: 'A-CONTENT-TEXT, no object',
    flagged: JSON.stringify({ error: { metadata: { flagged_input: 'A-REQUEST-TEXT' }, code: 403, message: `flagged ${'w'.repeat(300)}` } }),
  };
  const [logged] = inAdvocate(
    "import { callModel, parseBriefAnswer } from './src/model.ts'; const bodies = JSON.parse(process.argv[1]); const lines = []; " +
    "const call = async (status, body) => { lines.length = 0; try { await callModel([], { fetchImpl: async () => new Response(body, { status }), apiKey: 'k'.repeat(30), model: 'a/b', maxTokens: 10, timeoutMs: 5000, log: (l) => lines.push(l) }); } catch {} return lines.join(' | '); }; " +
    "let invalid = ''; try { parseBriefAnswer(bodies.content); } catch (e) { invalid = e.detail; } " +
    "console.log(JSON.stringify([[await call(503, bodies.refused), await call(200, bodies.notJson), invalid, await call(403, bodies.flagged)]]));", bodies);
  const [refusedLine, notJsonLine, invalidDetail, flaggedLine] = logged;
  assert.ok(refusedLine.endsWith(`HTTP 503: busy ${'x'.repeat(195)}...`), 'a status other than 200: the first 200 characters of the answer');
  assert.ok(flaggedLine.endsWith(`HTTP 403 with the error code 403: flagged ${'w'.repeat(192)}...`) && !/A-REQUEST-TEXT|metadata|flagged_input/.test(flaggedLine), 'the JSON of an error: its code and the first 200 characters of its message, never its metadata');
  assert.ok(notJsonLine.includes('HTTP 200') && notJsonLine.includes(`a body of ${bodies.notJson.length} characters`) && !notJsonLine.includes('ANSWER-TEXT'), 'a 200: the reason and the length, never the text');
  assert.ok(invalidDetail.includes(`a content of ${bodies.content.length} characters`) && !invalidDetail.includes('CONTENT-TEXT'), 'a content that is no brief: the reason and the length, never the text');
  // The rows say all that makes a job fail, and every number in them is the code's, read from it (aLimits), with the lines they quote.
  const L = aLimits();
  const rowOf = (code) => rows.find((r) => r.startsWith(`| Jobs fail with \`${code}\``)) ?? '';
  const sec = (ms) => ms / 1000;
  const MiB = 1_048_576;
  const REMINDER = '(the first block of that step first, in a new shell, to define the function';
  // Every row that sends the operator to a block of step 4 says to define the function first, in the words of the other runbooks: in a new shell the blocks need it.
  const toBlocks = rows.filter((r) => /block of the two API keys of step 4|supplier block of step 4|token block of step 4/.test(r));
  assert.ok(toBlocks.length >= 6, `${toBlocks.length} rows send the operator to a block of step 4`);
  for (const r of toBlocks) assert.ok(r.includes(REMINDER), `the row says to define the function first: ${r.slice(0, 90)}`);
  // deadline: the time OpenRouter is given is the time left less 5 s, 90 s at most, and it is not called with under 15 s. The waits of the hire stop FALLBACK_RESERVE_MS
  // before the deadline, which leaves the whole 90 s and not a millisecond more; a send under way then waits up to 75 s more (packages/buyer-core/src/fleet-clients.ts);
  // a receipt read until receiptByMs leaves 15 s; with under 20 s left it is not called.
  assert.deepEqual(L.model, { full: L.MODEL_MAX_MS, lessAfter: L.MODEL_MAX_MS - 1, atReceiptBy: L.MODEL_MIN_MS, none: null, started: L.MODEL_MIN_MS });
  assert.deepEqual([L.hopEnd, L.FALLBACK_RESERVE_MS, L.receiptEnd], [L.MODEL_MAX_MS + L.RESULT_RESERVE_MS, L.MODEL_MAX_MS + L.RESULT_RESERVE_MS, L.MODEL_MIN_MS + L.RESULT_RESERVE_MS]);
  const deadline = rowOf('deadline');
  assert.ok(deadline.includes(`The job ran out of its time: ${L.JOB_DEADLINE_MS} ms after its request arrived.`));
  assert.ok(deadline.includes(`OpenRouter is given the time left less ${sec(L.RESULT_RESERVE_MS)} s, ${sec(L.MODEL_MAX_MS)} s at most, and when it was given the whole ${sec(L.MODEL_MAX_MS)} s the same silence is \`model_failed\`.`));
  assert.ok(read('packages/buyer-core/src/fleet-clients.ts').includes('const SEND_TIMEOUT_MS = 75_000;'));
  assert.ok(deadline.includes(`The waits of the hire of a chat supplier stop ${sec(L.hopEnd)} s before the deadline, so a fallback after a hire that failed then has its ${sec(L.MODEL_MAX_MS)} s, but a send or a poll under way at that moment is not cut and can end a hire that fails as late as about ${sec(L.JOB_DEADLINE_MS - L.hopEnd + 75_000)} s, and a receipt that failed its check late, up to ${sec(L.receiptEnd)} s before the deadline, leaves the fallback ${sec(L.MODEL_MIN_MS)} s at the least.`));
  assert.ok(deadline.includes(`The job also fails this way when it has under ${A_MODEL_TIME.startWith} s left at the time the model was to start.`));
  assert.ok(deadline.includes('`inference: marketplace <code> at <stage>, falling back` says where the hire ended'));
  assert.ok(deadline.includes(`\`model: OpenRouter did not answer within <n> ms\` before \`job failed after <ms> ms: deadline (422)\` is the silent model, with an \`<n>\` under ${L.MODEL_MAX_MS} (with ${L.MODEL_MAX_MS} the job fails as \`model_failed\`).`));
  for (const part of ['const late = `OpenRouter did not answer within ${opts.timeoutMs} ms`;', 'if (opts.timeoutMs < MODEL_MAX_MS) {', 'opts.log(`model: ${late}`);']) assert.ok(A_SRC.includes(part), `the code writes: ${part}`);
  assert.ok(sources.kitServer.includes("log(`${refusal.kind === 'job' ? 'job failed' : 'request refused'} after ${took} ms: ${refusal.code} (${refusal.status})`);"), 'a 422 is logged with its code and status, and no detail');
  assert.ok(sources.kitServer.includes('log(`job failed after ${took} ms: ${refusal.code} (${refusal.status}): ${errorText(refusal.message, 1000)}`);'), 'a 502 is logged with its detail');
  // no_sources: what the phase of the pages drops, with the limits of the code, and the line that counts the pages by reason.
  const noSources = rowOf('no_sources');
  assert.ok(noSources.includes('No result page was kept: each one redirected, answered with a status other than 200, was not HTML or plain text, '));
  assert.ok(noSources.includes(`was over ${L.PAGE_MAX_BYTES / MiB} MB, had under ${L.MIN_PAGE_CHARS} characters of text, was refused or could not be reached (a host that resolves to a private or reserved address, a network error), did not answer within ${sec(L.PAGE_TIMEOUT_MS)} s, or was still being fetched when the phase ended, ${sec(L.FETCH_PHASE_MAX_MS)} s after it began.`));
  assert.ok(noSources.includes('Read the log line `pages: 0 kept of <m> (redirect <a>, status <b>, type <c>, thin <d>, failed <e>)` first: a high `status` count means that the sites refuse the service or lack the pages, and a high `failed` count points at the network. Then check that the service reaches the web over https:'));
  for (const part of ['opts.log(`pages: ${pages.length} kept of ${results.length} (${why})`);', 'const why = `redirect ${counts.redirect}, status ${counts.status}, type ${counts.type}, thin ${counts.thin}, failed ${counts.failed}`;']) assert.ok(A_SRC.includes(part), `the code writes: ${part}`);
  // search_empty and no_supported_claims.
  assert.deepEqual(L.kept, ['https://example.org/b'], 'only a result with an https URL is kept');
  assert.ok(rowOf('search_empty').includes('The two queries gave no usable result: none with an https URL.'));
  assert.ok(rowOf('no_supported_claims').includes('The check dropped every argument: no quote the model gave was found in the text of the page it names.'));
  // search_failed: the two rows, the reasons of a failed query and what to do for each.
  assert.equal(rows.filter((r) => r.startsWith('| Jobs fail with `search_failed` (502)')).length, 2);
  const bothFailed = rows.find((r) => r.startsWith('| Jobs fail with `search_failed` (502), with no such line')) ?? '';
  for (const part of [
    'gave no answer within its time, could not be made (a network error, or a redirect, which is not followed), could not start before the end of the search,',
    'Read the log line of the job, `job failed after <ms> ms: search_failed (502): both Brave queries failed: query 1 <why>, query 2 <why>`, which gives the reason of each query.',
    'A 429 or a 5xx: wait and let the next job try. A network error on both: check that the service reaches the web over https, as in the `no_sources` row. Another status of 400 to 499 on both: check the key and the account of the Brave Search API (the row above replaces the key).',
  ]) assert.ok(bothFailed.includes(part), `the row has: ${part}`);
  for (const part of ['both Brave queries failed: query 1 ${whyOf(first)}, query 2 ${whyOf(second)}', "'a network error'", "redirect: 'error',", "if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status };"]) assert.ok(sources.search.includes(part), `search.ts has: ${part}`);
  // model_failed: everything the code maps to it, and a step for the statuses that no other step covers.
  assert.ok(failedRow.includes(`gave a body over ${L.ANSWER_MAX_BYTES / MiB} MiB, gave a body that is not JSON or has no content, gave no answer within the full ${sec(L.MODEL_MAX_MS)} s (with less time left, the job fails as \`deadline\`), or could not be made (a network error, or a redirect, which is not followed).`));
  assert.ok(failedRow.includes('Any other status: read the text of the provider in the log line, its first 200 characters, and report it.'));
  for (const part of [
    '| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |',
    '| `network <name> declared as external, but could not be found` |', '| The runtime restarts and its log says `missing required env var ADVERT_REF` |',
    '`docker exec advocate-agent printenv SERVICE_URL` must print `http://advocate-service:9094/`', '| `invalid reference format` for the service image |',
    '| `/capability` shows an empty public key, claims fail with `wrong_supplier`, or the service stops at start with `environment variable SUPPLIER_PUB_KEY_HEX is required` |',
    '| The same, and the log says `is not the public key of SUPPLIER_PKH` |', '| The same, and the log names another setting that holds one of the two API keys |',
    "`docker exec advocate-service node -e \"fetch('https://example.org/').then((r) => console.log(r.status))\"` prints 200",
  ]) assert.ok(table.includes(part), `the table has: ${part}`);
  assert.doesNotMatch(table, /`network [a-z0-9_.-]+ declared as external/, 'the table names no network');
});

// The line of an Accept that did not land by the end of its validity (packages/hire-kit/src/janitor.ts): the janitor prints it once, at its first pass after that end, and records the escrow as
// lost; the entry then has no mark, waits for its deliver_by as any unmarked entry does, and from 5 s after it gets the line of a Submitted escrow that nothing can settle. Run here through the
// kit itself, against a stand-in of the chain on which the escrow stays Submitted, and held to the row of the table.
test('Advocate RUNBOOK failure table: the row of an Accept that did not land by the end of its validity, whole, beside the row of an Accept that may still land; the janitor of the kit prints its line once, then waits for the deliver_by and gives the line of a Submitted escrow', () => {
  const rows = section(aRunbook, 'If something goes wrong').split('\n').filter((l) => l.startsWith('| '));
  const LINE = "janitor: kept <escrow>: Submitted: its Accept <tx> did not land by <time> and the accept window may be over; lost to its supplier's release from <time> at the latest";
  const at = rows.findIndex((r) => r.startsWith(`| \`${LINE}\` |`));
  assert.ok(at > 0, 'the row is there');
  assert.ok(rows[at - 1].startsWith('| `janitor: kept <escrow>: Submitted: its Accept <tx> may still land until <time>` |'), 'right after the row of an Accept that may still land');
  const [, meaning, next] = rows[at].split(' | ');
  assert.equal(meaning, 'The Accept of the row above was not seen landing by the end of its validity, the first `<time>`, and the escrow still reads Submitted, so the window for an Accept may be over (on the real chain, where an Accept is valid to the end of the window, it is): the janitor records the escrow as lost, and its supplier may release it from the second `<time>` at the latest. The line is printed once, at the first pass after the first `<time>`. The entry then waits for its `deliver_by` like an unmarked one, and from 5 s after it gets the line `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` (its row, above).');
  assert.equal(next, 'Nothing to do: the lock goes to the supplier when it releases. |');
  assert.ok(rows.slice(0, at).some((r) => r.startsWith('| `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` |')), 'the row of the line it gets then, above');
  // The code that writes the line and records the escrow as lost, and the vendored Accept, valid to the end of the window.
  const janitor = read('packages/hire-kit/src/janitor.ts');
  for (const part of [
    'const notLanded = `Submitted: its Accept ${pending.tx_hash} did not land by ${iso(pending.valid_to)}`;',
    'store.update(ref, { accept_pending: undefined, lost_to_release_after: lostAfter });',
    "return did('kept', `${notLanded}${why}; lost to its supplier's release from ${iso(lostAfter)} at the latest`);",
    "if (now >= entry.posted_at + ACCEPT_WINDOW_MS) return lost(' and the accept window may be over');",
  ]) assert.ok(janitor.includes(part), `the janitor writes: ${part}`);
  assert.ok(read('packages/buyer-core/src/vendored/mcp/marketplace-build.ts').includes('const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;'), 'on the real chain an Accept is valid to the end of the window');
  // Through the kit: an escrow posted at 0 whose Accept was sent and is valid to 700 s (its Submit at 100 s), with a deliver_by of 63 minutes; the chain reads it Submitted throughout.
  const [seen] = inAdvocate(
    "import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path'; " +
    "import { JANITOR_GRACE_MS, StrandedStore, startJanitor } from '@vsa/hire-kit'; " +
    "const dir = mkdtempSync(join(tmpdir(), 'advocate-unlanded-')); const ref = `${'4'.repeat(64)}#0`; const tx = '5'.repeat(64); const validTo = 700_000; const due = 3_780_000; " +
    "try { const store = new StrandedStore(dir); const accepts = []; " +
    "store.add({ escrow_ref: ref, deliver_by: due, posted_at: 0, kind: 'llm', accept_pending: { tx_hash: tx, valid_to: validTo, by: 'run' } }); " +
    "const chain = { escrowState: async () => 'Submitted', reclaim: async () => { throw new Error('no Reclaim of a Submitted escrow'); }, accept: async (r) => { accepts.push(r); throw new Error('no Accept here'); } }; " +
    "const pass = async (now) => { const lines = []; await startJanitor(store, chain, 60_000, { clock: () => now, log: (l) => lines.push(l) }).stop(); return lines; }; " +
    "const seen = { before: await pass(validTo - 1), first: await pass(validTo), next: await pass(validTo + 60_000), lastWait: await pass(due + JANITOR_GRACE_MS - 1), due: await pass(due + JANITOR_GRACE_MS), " +
    "entry: store.get(ref), accepts, ref, tx, times: [new Date(validTo).toISOString(), new Date(due + 600_000).toISOString()] }; " +
    "console.log(JSON.stringify([seen])); } finally { rmSync(dir, { recursive: true, force: true }); }",
    null,
  );
  const template = (line) => line.replaceAll(seen.ref, '<escrow>').replaceAll(seen.tx, '<tx>').replaceAll(seen.times[0], '<time>').replaceAll(seen.times[1], '<time>');
  assert.deepEqual(seen.before.map(template), ['janitor: kept <escrow>: Submitted: its Accept <tx> may still land until <time>'], 'before the end of its validity: the row above');
  assert.deepEqual(seen.first.map(template), [LINE], 'at the first pass after it: this row, once');
  assert.ok(seen.first[0].includes(`did not land by ${seen.times[0]} `) && seen.first[0].endsWith(`release from ${seen.times[1]} at the latest`), 'the end of its validity, then its deliver_by and 600 s');
  assert.deepEqual([seen.next, seen.lastWait], [[], []], 'then no line: the entry waits for its deliver_by like an unmarked one');
  assert.deepEqual(seen.due.map(template), ['janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest'], 'from 5 s after its deliver_by: the line of a Submitted escrow');
  assert.deepEqual([seen.entry.accept_pending, seen.entry.lost_to_release_after, seen.accepts], [undefined, 3_780_000 + 600_000, []], 'the mark is gone, the escrow is lost from the deliver_by and 600 s, and no Accept is made again');
});

test('Advocate RUNBOOK: the four corrections of the run of Audio Snippets are in it: the hash script on the machine of the operator, the traceback of setup-venv.sh and the two checks, the comment line of the copied install script, and the collateral paragraph', () => {
  const eleven = section(aRunbook, '11. Hash the manifest');
  assert.ok(eleven.includes("The script runs on the operator's machine, from the root of a checkout of the repository, with Node 22: the host has no Node. It only fetches public bytes:\n\n```sh\nnode scripts/manifest-hash.mjs https://mp-suppliers-advocate.hal8.ai\n```"));
  assert.ok(eleven.includes('The host cross-checks the raw bytes with `curl -fsS https://mp-suppliers-advocate.hal8.ai/agent.json | sha256sum`: the two must agree.'));
  assert.doesNotMatch(eleven, /on any machine with Node 22|the root is `\$BASE\/repo`|cd "\$BASE\/repo"|On 2026-10-17 both gave/, 'the words of before, and the hashes of Audio Snippets');
  const five = section(aRunbook, '5. Adapt the ops scripts');
  assert.ok(five.includes("`setup-venv.sh` does not end with `venv ok` on this host: it ends with a traceback from its last line, `module 'pycardano' has no attribute '__version__'`, after everything is installed, and the venv is complete all the same (it ended so for Audio Snippets on 2026-10-16"));
  assert.ok(five.includes("The check that holds is the last two lines of the block: `./venv/bin/pip show cbor2 | grep '^Version'` prints `Version: 5.6.5`, and `./venv/bin/python -c \"import pycardano, reputation_staking\"` exits 0."));
  assert.equal(five.includes('`setup-venv.sh` ends with `venv ok`, and the last command must print `Version: 5.6.5`.'), false, 'the sentence of before');
  assert.ok(section(aRunbook, '10. DNS and Caddy').includes("The second prints the first comment line of the copy, which names the Pipeline or Audio Snippets: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of another stack is what must not appear"));
  assert.doesNotMatch(section(aRunbook, '10. DNS and Caddy'), /must print nothing/);
  // The fourth is pinned by the test of the collateral and float above.
});

test('Advocate compose in docker compose config: with PROXY_NETWORK in .env the network has that name, and without it compose stops and says where to set it', { skip: HAVE_COMPOSE ? false : 'needs docker compose' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-advocate-'));
  const { PROXY_NETWORK: _shell, ...env } = process.env;
  try {
    copyFileSync(join(root, 'deploy/host/docker-compose.advocate.yml'), join(dir, 'docker-compose.advocate.yml'));
    copyFileSync(join(root, 'deploy/host/.env.advocate.example'), join(dir, '.env.advocate'));
    const config = () => spawnSync('docker', ['compose', '-f', 'docker-compose.advocate.yml', 'config'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
    const refused = config();
    assert.notEqual(refused.status, 0, 'compose stops with no .env');
    assert.ok(refused.stderr.includes('set PROXY_NETWORK in .env next to this compose file'), refused.stderr);
    writeFileSync(join(dir, '.env'), 'PROXY_NETWORK=test_proxy_network\n');
    const run = config();
    assert.equal(run.status, 0, run.stderr);
    const model = parseYaml(run.stdout);
    assert.deepEqual(model.networks, { proxy: { name: 'test_proxy_network', external: true } });
    for (const [name, s] of Object.entries(model.services)) assert.deepEqual(Object.keys(s.networks), ['proxy'], name);
    assert.equal(String(model.services.service.mem_limit), String(1024 * 1024 * 1024), 'the 1024m of the compose file, as compose renders it, in bytes');
    assert.equal(model.services.service.stop_grace_period, '5m30s', 'the 330s of the compose file');
    assert.deepEqual([model.services.agent.environment.BRAVE_SEARCH_API_KEY, model.services.agent.environment.OPENROUTER_API_KEY], ['', ''], 'the runtime holds neither API key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CI: the publish job also pushes the Advocate image under :latest and :<sha>, in the same job and after the same login, with the labels of the other three, and the build job builds it', () => {
  const job = ci.jobs.publish;
  const builds = job.steps.filter((s) => s.uses === 'docker/build-push-action@v6');
  const advocate = builds.find((s) => s.with.file === 'agents/advocate/Dockerfile');
  assert.ok(advocate && existsSync(join(root, advocate.with.file)));
  const image = aService.image.replace(/@sha256:.*$/, ''); // the compose file names the image by digest; CI pushes the two tags of the same repository
  assert.equal(image, 'ghcr.io/apex-fusion/vector-service-agents/advocate');
  assert.deepEqual(advocate.with.tags.trim().split('\n'), [`${image}:latest`, `${image}:\${{ github.sha }}`]);
  assert.equal(advocate.with.context, '.');
  assert.equal(advocate.with.push, true);
  assert.equal(advocate.with.labels, builds.find((s) => s.with.file === 'agents/agent-history/Dockerfile')?.with.labels, 'the labels of the other three');
  assert.equal(advocate.if, undefined, 'no condition of its own');
  assert.equal(builds.indexOf(advocate), 3, 'after the other three');
  assert.ok(job.steps.indexOf(advocate) > job.steps.findIndex((s) => s.uses === 'docker/login-action@v3'), 'after the login');
  assert.ok(aSection.includes('`ghcr.io/apex-fusion/vector-service-agents/advocate`') && aSection.includes('`:latest`') && aSection.includes('`:<full git commit sha>`'));
  // The build job builds it too, with no push, and the test job has no step of its own for it: no tool, no model and no setting to install.
  assert.ok(ci.jobs.build.steps.some((s) => s.uses === 'docker/build-push-action@v6' && s.with.file === 'agents/advocate/Dockerfile' && s.with.push === false));
  assert.equal(JSON.stringify(ci.jobs.test).includes('advocate'), false, 'the tests of Advocate run in pnpm test, as they are');
});

// ======================================================================================================================================
// The agents host (deploy/server): one set-up script, one main Caddyfile, and the two host names of the mock systems.
// These tests parse the files, run the script in a sandbox against stand-ins for the programs of the system (no root and no network), and run
// the commands of the runbook that a test can run. Each guard has an accepted twin and refused copies. The local proof with the real Caddy is
// deploy/server/prove-mock-mtls.mjs. It needs Docker, so it runs by hand.
// ======================================================================================================================================
const SRV = 'deploy/server';
const srvRead = (name) => read(`${SRV}/${name}`);
// Escape a text for a RegExp.
const srvEscape = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
// Replace every copy of a part. Stop when the part is not there: a change that changes nothing proves nothing.
const srvReplace = (text, from, to) => {
  assert.ok(text.split(from).length > 1, `the text holds: ${from}`);
  return text.split(from).join(to);
};
const SRV_FOLDER = '/etc/caddy/agents';
const SRV_UPSTREAM = '127.0.0.1:9120';
const SRV_CERT = '{http.request.tls.client.certificate_der_base64}';

// A Caddyfile as a tree. A line that ends with "{" opens a block, and "}" closes it. A comment and a blank line are dropped.
function srvCaddyTree(text) {
  const top = [];
  const stack = [{ children: top }];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '}') {
      assert.ok(stack.length > 1, 'a closing brace has an opening brace');
      stack.pop();
      continue;
    }
    const opens = line.endsWith('{');
    const node = { head: opens ? line.slice(0, -1).trim() : line, children: opens ? [] : null };
    stack.at(-1).children.push(node);
    if (opens) stack.push(node);
  }
  assert.equal(stack.length, 1, 'every opening brace is closed');
  return top;
}
const srvLeaves = (nodes) => nodes.filter((n) => n.children === null).map((n) => n.head);
const srvBlocks = (nodes, head) => nodes.filter((n) => n.children !== null && n.head === head);
const srvFlat = (nodes) => nodes.flatMap((n) => [n.head, ...(n.children ? srvFlat(n.children) : [])]);
const srvCode = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

// The faults of a main Caddyfile. An empty list is a pass.
function srvCaddyfileProblems(text) {
  const problems = [];
  const nodes = srvCaddyTree(text);
  const imports = srvLeaves(nodes).filter((l) => l.startsWith('import '));
  if (imports.length !== 1 || imports[0] !== `import ${SRV_FOLDER}/*.snippet`) problems.push(`the one import line must read "import ${SRV_FOLDER}/*.snippet", found: ${imports.join(' | ') || 'none'}`);
  const sites = nodes.filter((n) => n.children !== null && n.head !== '');
  if (sites.length > 0) problems.push(`the main file has a site block: ${sites.map((s) => s.head).join(', ')}`);
  const globals = nodes.filter((n) => n.children !== null && n.head === '');
  if (globals.length !== 1 || nodes[0] !== globals[0]) return [...problems, 'the file must start with one global options block'];
  const options = globals[0].children;
  if (!srvLeaves(options).includes('admin localhost:2019')) problems.push('the admin API must listen on localhost:2019');
  const servers = srvBlocks(options, 'servers');
  if (servers.length !== 1 || !srvLeaves(servers[0].children).includes('protocols h1 h2')) problems.push('servers must set "protocols h1 h2": HTTP/3 needs UDP, and the firewall opens TCP only');
  if (/trusted_proxies|client_ip_headers|cloudflare/i.test(srvCode(text))) problems.push('no name of this host is behind a proxy, so the file has no proxy setting');
  return problems;
}

test('agents host: the main Caddyfile imports the snippet folder, has no site block, keeps the admin API on the loopback address and turns HTTP/3 off', () => {
  const text = srvRead('Caddyfile');
  assert.deepEqual(srvCaddyfileProblems(text), [], 'the real file passes');
  const faults = [
    ['no import line', srvReplace(text, `import ${SRV_FOLDER}/*.snippet\n`, ''), /one import line/],
    ['another folder', srvReplace(text, `import ${SRV_FOLDER}/`, 'import /etc/caddy/other/'), /one import line/],
    ['a second import line', `${text}import /etc/caddy/more/*.snippet\n`, /one import line/],
    ['a site block in the main file', `${text}example.test {\n\trespond "x"\n}\n`, /site block/],
    ['the admin API on a public address', srvReplace(text, 'admin localhost:2019', 'admin 0.0.0.0:2019'), /admin API/],
    ['HTTP/3 on', srvReplace(text, 'protocols h1 h2', 'protocols h1 h2 h3'), /protocols h1 h2/],
    ['a trusted proxy', srvReplace(text, '\tadmin localhost:2019\n', '\tadmin localhost:2019\n\tservers {\n\t\ttrusted_proxies static private_ranges\n\t}\n'), /proxy/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvCaddyfileProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

test('agents host: the Caddyfile and setup.sh name the same snippet folder, and the runbook and the README use it', () => {
  const importLine = /^import (\/\S+)\/\*\.snippet$/m.exec(srvRead('Caddyfile'));
  assert.equal(importLine?.[1], SRV_FOLDER);
  assert.equal(/^SNIPPET_FOLDER=(\S+)$/m.exec(srvRead('setup.sh'))?.[1], SRV_FOLDER);
  assert.match(srvRead('README.md'), new RegExp(`\`${srvEscape(SRV_FOLDER)}/\\*\\.snippet\``));
  assert.match(srvRead('RUNBOOK.md'), new RegExp(srvEscape(`${SRV_FOLDER}/mock-systems.snippet`)));
});

// The faults of the mock snippet. The first block is the normal host and the second is the client-certificate host.
function srvMockSnippetProblems(text) {
  const problems = [];
  const sites = srvCaddyTree(text);
  const heads = sites.map((s) => s.head);
  if (heads.join(' | ') !== '<mock-host> | <mock-mtls-host>') return [`the site blocks must be <mock-host> and <mock-mtls-host>, in this order; found: ${heads.join(' | ')}`];
  const [plain, mtls] = sites;
  for (const [name, site] of [['<mock-host>', plain], ['<mock-mtls-host>', mtls]]) {
    for (const header of ['Client-Cert', 'Client-Cert-Chain']) {
      if (!srvLeaves(site.children).includes(`request_header -${header}`)) problems.push(`${name}: the block does not remove the inbound ${header} header at its top level`);
    }
  }
  // The normal host asks for no certificate and sets no header of its own.
  if (srvBlocks(plain.children, 'tls').length > 0) problems.push('<mock-host>: the block has a tls setting, and it must ask for no certificate');
  if (srvFlat(plain.children).some((h) => h.startsWith('header_up'))) problems.push('<mock-host>: the block sets a request header, and it must not');
  if (!srvLeaves(plain.children).includes(`reverse_proxy ${SRV_UPSTREAM}`)) problems.push(`<mock-host>: the block must have the line "reverse_proxy ${SRV_UPSTREAM}"`);
  // The client-certificate host asks for a certificate, does not check it, and passes it on only when the client sent one.
  const tls = srvBlocks(mtls.children, 'tls');
  if (tls.length !== 1 || srvFlat(tls[0].children).join(' | ') !== 'client_auth | mode request') problems.push('<mock-mtls-host>: the tls block must hold client_auth with "mode request" and nothing else: no CA and no certificate to trust, because Caddy does not check the certificate');
  const matcher = `@clientcert expression \`${SRV_CERT} != ""\``;
  if (!srvLeaves(mtls.children).includes(matcher)) problems.push(`<mock-mtls-host>: the matcher must be: ${matcher}`);
  const setLine = `header_up Client-Cert ":${SRV_CERT}:"`;
  const withCert = srvBlocks(mtls.children, 'handle @clientcert');
  if (withCert.length !== 1 || srvFlat(withCert[0].children).join(' | ') !== `reverse_proxy ${SRV_UPSTREAM} | ${setLine}`) problems.push(`<mock-mtls-host>: "handle @clientcert" must hold one proxy that sets: ${setLine}`);
  const without = srvBlocks(mtls.children, 'handle');
  if (without.length !== 1 || srvFlat(without[0].children).join(' | ') !== `reverse_proxy ${SRV_UPSTREAM}`) problems.push('<mock-mtls-host>: the plain "handle" must hold one proxy that sets no header');
  // The whole file: one header line, and every proxy goes to the one upstream on the loopback address.
  const all = srvFlat(sites);
  if (all.filter((h) => h.startsWith('header_up')).length !== 1) problems.push('the file must have exactly one header_up line');
  const proxies = all.filter((h) => h.startsWith('reverse_proxy'));
  if (proxies.length !== 3 || proxies.some((h) => !h.startsWith(`reverse_proxy ${SRV_UPSTREAM}`))) problems.push(`the file must have three proxy lines, and each goes to ${SRV_UPSTREAM}`);
  return problems;
}

test('agents host: the mock snippet asks for a client certificate on the mTLS host, does not check it, passes it in Client-Cert, and removes the inbound header on both hosts', () => {
  const text = srvRead('Caddyfile.mock-systems.snippet');
  assert.deepEqual(srvMockSnippetProblems(text), [], 'the real file passes');
  const at = text.indexOf('\n<mock-mtls-host> {\n');
  assert.ok(at > 0);
  const [plain, mtls] = [text.slice(0, at), text.slice(at)];
  const tlsBlock = '\ttls {\n\t\tclient_auth {\n\t\t\tmode request\n\t\t}\n\t}\n';
  const faults = [
    ['<mock-host> keeps a forged Client-Cert', `${srvReplace(plain, '\trequest_header -Client-Cert\n', '')}${mtls}`, /<mock-host>: .* inbound Client-Cert header/],
    ['<mock-host> keeps a forged Client-Cert-Chain', `${srvReplace(plain, '\trequest_header -Client-Cert-Chain\n', '')}${mtls}`, /<mock-host>: .* inbound Client-Cert-Chain header/],
    ['<mock-mtls-host> keeps a forged Client-Cert', `${plain}${srvReplace(mtls, '\trequest_header -Client-Cert\n', '')}`, /<mock-mtls-host>: .* inbound Client-Cert header/],
    ['<mock-mtls-host> keeps a forged Client-Cert-Chain', `${plain}${srvReplace(mtls, '\trequest_header -Client-Cert-Chain\n', '')}`, /<mock-mtls-host>: .* inbound Client-Cert-Chain header/],
    ['the removal sits inside a handle only', `${plain}${srvReplace(srvReplace(mtls, '\trequest_header -Client-Cert\n', ''), '\thandle {\n', '\thandle {\n\t\trequest_header -Client-Cert\n')}`, /<mock-mtls-host>: .* inbound Client-Cert header/],
    ['Caddy requires the certificate', `${plain}${srvReplace(mtls, 'mode request', 'mode require')}`, /"mode request" and nothing else/],
    ['Caddy checks the certificate when one is given', `${plain}${srvReplace(mtls, 'mode request', 'mode verify_if_given')}`, /"mode request" and nothing else/],
    ['Caddy trusts a fixed CA', `${plain}${srvReplace(mtls, '\t\t\tmode request\n', '\t\t\tmode request\n\t\t\ttrust_pool file /etc/ssl/ca.pem\n')}`, /"mode request" and nothing else/],
    ['Caddy asks for no certificate', `${plain}${srvReplace(mtls, tlsBlock, '')}`, /"mode request" and nothing else/],
    ['the normal host asks for a certificate', `${srvReplace(plain, '\trequest_header -Client-Cert\n', `${tlsBlock}\trequest_header -Client-Cert\n`)}${mtls}`, /<mock-host>: the block has a tls setting/],
    ['the header goes without a certificate too', `${plain}${srvReplace(mtls, `${SRV_CERT} != ""`, 'true')}`, /matcher must be/],
    ['another header name', `${plain}${srvReplace(mtls, 'header_up Client-Cert ', 'header_up X-Client-Cert ')}`, /must hold one proxy that sets/],
    ['a value with no colons', `${plain}${srvReplace(mtls, `":${SRV_CERT}:"`, `"${SRV_CERT}"`)}`, /must hold one proxy that sets/],
    ['no plain handle', `${plain}${srvReplace(mtls, '\thandle {\n\t\treverse_proxy 127.0.0.1:9120\n\t}\n', '')}`, /plain "handle"/],
    ['the normal host sets the header', `${srvReplace(plain, '\treverse_proxy 127.0.0.1:9120\n', '\treverse_proxy 127.0.0.1:9120 {\n\t\theader_up Client-Cert x\n\t}\n')}${mtls}`, /sets a request header/],
    ['an upstream on a public address', srvReplace(text, SRV_UPSTREAM, '0.0.0.0:9120'), /each goes to/],
    ['the two blocks swapped', `${mtls.slice(1)}\n${plain}`, /in this order/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvMockSnippetProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

// ---- setup.sh: what the text of the script must and must not do ----
// The firewall opens TCP 22, 80 and 443, and nothing else.
function srvPortProblems(text) {
  const problems = [];
  const code = srvCode(text);
  const ports = /^OPEN_PORTS="([0-9 ]*)"$/m.exec(text)?.[1];
  if (ports !== '22 80 443') problems.push(`OPEN_PORTS must be "22 80 443", found: ${ports}`);
  // Two places say "ufw allow": the text that the script compares with the rules, and the one command that opens a port. Both read OPEN_PORTS.
  const allows = code.match(/\bufw\s+(?:allow|limit|reject|route|insert|prepend)\b/g) ?? [];
  if (allows.length !== 2) problems.push(`the script must have exactly two "ufw allow" places (the comparison and the one command), found ${allows.length}`);
  if (!code.includes('for port in $OPEN_PORTS; do ufw allow "$port/tcp" >/dev/null; done')) problems.push('the one ufw allow command must run in a loop over $OPEN_PORTS');
  if (!code.includes("printf 'ufw allow %s/tcp\\n' \"$port\"")) problems.push('the comparison must be made from $OPEN_PORTS');
  if (!code.includes('ufw default deny incoming') || /ufw\s+default\s+allow\s+incoming/.test(code)) problems.push('the default for incoming traffic must be deny');
  if (/\bufw\s+disable\b/.test(code)) problems.push('the script must not disable the firewall');
  if (!/\bufw --force enable\b/.test(code)) problems.push('the script must enable the firewall');
  if (/\b(?:iptables|ip6tables|nft|firewall-cmd)\b/.test(code)) problems.push('the script must set no firewall rule except through ufw');
  return problems;
}

test('agents host: setup.sh opens TCP 22, 80 and 443 only, denies the rest, and enables the firewall', () => {
  const text = srvRead('setup.sh');
  assert.deepEqual(srvPortProblems(text), [], 'the real file passes');
  const faults = [
    ['a fourth port in the list', srvReplace(text, 'OPEN_PORTS="22 80 443"', 'OPEN_PORTS="22 80 443 8080"'), /OPEN_PORTS must be/],
    ['a port taken out of the list', srvReplace(text, 'OPEN_PORTS="22 80 443"', 'OPEN_PORTS="22 443"'), /OPEN_PORTS must be/],
    ['a rule for one more port', srvReplace(text, '  ufw --force enable >/dev/null\n', '  ufw allow 8080/tcp >/dev/null\n  ufw --force enable >/dev/null\n'), /exactly two "ufw allow" places/],
    ['a rule with a limit', srvReplace(text, '  ufw --force enable >/dev/null\n', '  ufw limit 22/tcp >/dev/null\n  ufw --force enable >/dev/null\n'), /exactly two "ufw allow" places/],
    ['the command outside the loop', srvReplace(text, 'for port in $OPEN_PORTS; do ufw allow "$port/tcp" >/dev/null; done', 'ufw allow 22/tcp >/dev/null; ufw allow "$OPEN_PORTS" >/dev/null'), /in a loop over \$OPEN_PORTS/],
    ['incoming traffic allowed', srvReplace(text, 'ufw default deny incoming', 'ufw default allow incoming'), /default for incoming traffic/],
    ['the firewall disabled', srvReplace(text, '  ufw --force enable >/dev/null\n', '  ufw disable >/dev/null\n'), /must not disable|must enable/],
    ['the firewall never enabled', srvReplace(text, '  ufw --force enable >/dev/null\n', ''), /must enable the firewall/],
    ['a raw iptables rule', srvReplace(text, '  ufw --force enable >/dev/null\n', '  iptables -A INPUT -p tcp --dport 8080 -j ACCEPT\n  ufw --force enable >/dev/null\n'), /through ufw/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvPortProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

// No container port binds to a public address. The script starts no container. Its daemon.json makes the loopback address the default of a published port.
const srvDaemonJson = (text) => JSON.parse(/daemon_json\(\) \{\n  cat <<'EOF'\n([\s\S]*?)\nEOF\n\}/.exec(text)?.[1] ?? 'null');
function srvPublicPortProblems(text) {
  const problems = [];
  const code = srvCode(text);
  if (/\bdocker\s+(?:run|create|start|compose\s+(?:up|run|create|start))\b/.test(code)) problems.push('the script starts a container');
  if (/\bdocker\b[^\n]*(?:\s-[pP](?:\s|=|\d)|\s--publish(?:-all)?\b)|\bports:/.test(code)) problems.push('the script publishes a port');
  if (/0\.0\.0\.0|\[::\]|--network[ =]host|network_mode/.test(code)) problems.push('the script names a public address or the host network');
  const daemon = srvDaemonJson(text);
  if (daemon?.ip !== '127.0.0.1') problems.push('daemon.json must make 127.0.0.1 the default address of a published port');
  if (daemon?.['live-restore'] !== true) problems.push('daemon.json must set live-restore, so that a restart of the daemon keeps the containers');
  if (daemon?.['log-driver'] !== 'json-file' || JSON.stringify(daemon?.['log-opts']) !== JSON.stringify({ 'max-size': '10m', 'max-file': '3' })) problems.push('daemon.json must limit the log of each container to 3 files of 10m');
  return problems;
}
// A compose file of the host: each published port names the loopback address, and no service uses the host network.
function srvComposeProblems(text) {
  const problems = [];
  for (const [name, service] of Object.entries(parseYaml(text)?.services ?? {})) {
    if (service.network_mode === 'host') problems.push(`${name}: network_mode host`);
    for (const port of service.ports ?? []) {
      const loopback = typeof port === 'string' ? /^(?:127\.0\.0\.1|\[::1\]):\d+:\d+(?:\/(?:tcp|udp))?$/.test(port) : port?.host_ip === '127.0.0.1' || port?.host_ip === '::1';
      if (!loopback) problems.push(`${name}: the port ${JSON.stringify(port)} does not name the loopback address`);
    }
  }
  return problems;
}

test('agents host: setup.sh starts no container and binds no port to a public address, and daemon.json makes the loopback address the default', () => {
  const text = srvRead('setup.sh');
  assert.deepEqual(srvPublicPortProblems(text), [], 'the real file passes');
  const daemonBlock = /daemon_json\(\) \{\n  cat <<'EOF'\n[\s\S]*?\nEOF\n\}/.exec(text)[0];
  const faults = [
    ['a container started', srvReplace(text, '  ufw --force enable >/dev/null\n', '  docker run -d nginx\n  ufw --force enable >/dev/null\n'), /starts a container/],
    ['a compose start', srvReplace(text, '  ufw --force enable >/dev/null\n', '  docker compose up -d\n  ufw --force enable >/dev/null\n'), /starts a container/],
    ['a published port', srvReplace(text, '  ufw --force enable >/dev/null\n', '  docker x -p 8080:80\n  ufw --force enable >/dev/null\n'), /publishes a port/],
    ['a public address', srvReplace(text, '  ufw --force enable >/dev/null\n', '  echo 0.0.0.0:8080\n  ufw --force enable >/dev/null\n'), /public address/],
    ['the host network', srvReplace(text, '  ufw --force enable >/dev/null\n', '  docker x --network host\n  ufw --force enable >/dev/null\n'), /public address or the host network/],
    ['no default address', srvReplace(text, daemonBlock, daemonBlock.replace('  "ip": "127.0.0.1",\n', '')), /default address/],
    ['a public default address', srvReplace(text, '"ip": "127.0.0.1"', '"ip": "0.0.0.0"'), /default address/],
    ['no live-restore', srvReplace(text, daemonBlock, daemonBlock.replace('  "live-restore": true,\n', '')), /live-restore/],
    ['no log limit', srvReplace(text, '"max-size": "10m"', '"max-size": "1g"'), /log of each container/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvPublicPortProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

test('agents host: a compose file of the host publishes ports on the loopback address only; the guard refuses a short form, a public address and the host network, and passes the loopback forms', () => {
  // The compose files of the agents come later. The guard reads each one that is in the folder now, and it is tested on texts.
  for (const name of readdirSync(join(root, SRV)).filter((f) => /^docker-compose.*\.ya?ml$/.test(f))) assert.deepEqual(srvComposeProblems(srvRead(name)), [], name);
  const compose = (port) => `services:\n  agent:\n    image: example\n    ports: [${port}]\n`;
  for (const ok of ['"127.0.0.1:8101:8080"', '"[::1]:8101:8080"', '"127.0.0.1:9101:9091/tcp"']) assert.deepEqual(srvComposeProblems(compose(ok)), [], ok);
  assert.deepEqual(srvComposeProblems('services:\n  agent:\n    image: example\n'), [], 'no port at all');
  assert.deepEqual(srvComposeProblems('services:\n  agent:\n    image: example\n    ports:\n      - { target: 8080, published: 8101, host_ip: 127.0.0.1 }\n'), [], 'the long form with the loopback address');
  for (const bad of ['"8101:8080"', '"0.0.0.0:8101:8080"', '"[::]:8101:8080"', '"8101"', '"127.0.0.2:8101:8080"']) assert.equal(srvComposeProblems(compose(bad)).length, 1, bad);
  assert.equal(srvComposeProblems('services:\n  agent:\n    image: example\n    ports:\n      - { target: 8080, published: 8101 }\n').length, 1, 'the long form with no address');
  assert.equal(srvComposeProblems('services:\n  agent:\n    image: example\n    network_mode: host\n').length, 1, 'the host network');
});

// setup.sh makes no key, reads no key and holds no secret.
function srvSecretProblems(text) {
  const problems = [];
  const code = srvCode(text);
  // The assigned names and values, run through the key check of the compose files (a secret name needs an empty value; no value looks like a key).
  const assigned = Object.fromEntries([...code.matchAll(/^\s*(?:export |local |readonly )?([A-Za-z_][A-Za-z0-9_]*)=([^\n]*)$/gm)].map((m) => [m[1], m[2].replace(/^"(.*)"$/, '$1')]));
  problems.push(...keyProblems(assigned));
  if (/[0-9a-fA-F]{56,}/.test(code)) problems.push('a run of 56 or more hex characters looks like key material');
  if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|SECRET)|ed25519e?_sk|addr1[0-9a-z]{20,}/i.test(code)) problems.push('key material');
  if (/\b(?:ssh-keygen|age-keygen|wg\s+genkey|gen-keypair|keygen)\b|\bopenssl\s+(?:genpkey|genrsa|ecparam|req|rand)\b|\bgpg\b[^\n]*--(?:quick-)?(?:full-)?gen(?:erate)?-key|\bdocker\s+login\b/.test(code)) problems.push('the script makes a key, or logs in to a registry');
  if (/\.env\b|\bread\s+-[A-Za-z]*s|\b(?:chpasswd|passwd\s+[a-z]|--password)\b/.test(code)) problems.push('the script reads an env file or a secret, or sets a password');
  return problems;
}

test('agents host: setup.sh holds no secret, reads none and makes no key', () => {
  const text = srvRead('setup.sh');
  assert.deepEqual(srvSecretProblems(text), [], 'the real file passes');
  // The two pinned fingerprints are 40 hex characters and public. They are the fingerprints that the two vendors publish for their apt keys.
  // A change of the pin needs a change here: the operator checks the new value on the web site of the vendor first.
  assert.match(text, /^DOCKER_KEY_FPR=9DC858229FC7DD38854AE2D88D81803C0EBFCD88$/m);
  assert.match(text, /^CADDY_KEY_FPR=65760C51EDEA2017CEA2CA15155B6D79CA56EA34$/m);
  const insert = (line) => srvReplace(text, '  ufw --force enable >/dev/null\n', `  ${line}\n  ufw --force enable >/dev/null\n`);
  const faults = [
    ['a key written out', insert(`SUPPLIER_KEY=${'ab'.repeat(32)}`), /key material|looks like/],
    ['a secret name with a value', insert('API_TOKEN=abc'), /API_TOKEN must be empty/],
    ['a private key block', insert('echo "-----BEGIN PRIVATE KEY-----"'), /key material/],
    ['a signer key', insert(`echo ed25519${'_sk1'}${'q'.repeat(28)}`), /key material/],
    ['ssh-keygen', insert('ssh-keygen -t ed25519 -N "" -f /root/k'), /makes a key/],
    ['openssl genpkey', insert('openssl genpkey -algorithm ed25519'), /makes a key/],
    ['a key pair command of the agents', insert('gen-keypair --network 1'), /makes a key/],
    ['a registry login', insert('docker login ghcr.io'), /makes a key, or logs in/],
    ['a read of an env file', insert('. ./.env.agent'), /reads an env file/],
    ['a silent prompt', insert('read -rs SECRET_TEXT'), /reads an env file or a secret/],
    ['a password', insert('chpasswd < users.txt'), /sets a password/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvSecretProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

// setup.sh never restarts a container. It restarts Docker only on the branch where no container runs. It restarts nothing else but the journal.
function srvRestartProblems(text) {
  const problems = [];
  const code = srvCode(text);
  if (/\bdocker\s+(?:restart|kill|stop|rm|compose\s+(?:restart|stop|down|rm|kill))\b/.test(code)) problems.push('the script stops or restarts a container');
  const restarts = [...code.matchAll(/systemctl\s+restart\s+(\S+)/g)].map((m) => m[1]);
  if (restarts.some((unit) => !['docker', 'systemd-journald'].includes(unit))) problems.push(`the script restarts a unit that is not Docker or the journal: ${restarts.join(', ')}`);
  if (!/if \[ -z "\$\(docker ps --quiet\)" \]; then\n\s+systemctl restart docker\n/.test(code)) problems.push('Docker restarts only on the branch where "docker ps --quiet" lists no container');
  if (!/systemctl reload caddy/.test(code) || /systemctl\s+(?:restart|stop)\s+caddy/.test(code)) problems.push('Caddy reloads, and it never restarts');
  return problems;
}

test('agents host: setup.sh never restarts a container or Caddy, and restarts Docker only when no container runs', () => {
  const text = srvRead('setup.sh');
  assert.deepEqual(srvRestartProblems(text), [], 'the real file passes');
  const insert = (line) => srvReplace(text, '  ufw --force enable >/dev/null\n', `  ${line}\n  ufw --force enable >/dev/null\n`);
  const faults = [
    ['a container restart', insert('docker restart agent'), /stops or restarts a container/],
    ['a compose stop', insert('docker compose down'), /stops or restarts a container/],
    ['a Caddy restart', insert('systemctl restart caddy'), /not Docker or the journal|never restarts/],
    ['a restart of the container runtime', insert('systemctl restart containerd'), /not Docker or the journal/],
    ['a Docker restart with no condition', srvReplace(text, 'if [ -z "$(docker ps --quiet)" ]; then', 'if true; then'), /only on the branch/],
    ['no reload of Caddy', srvReplace(text, 'systemctl reload caddy', 'true'), /Caddy reloads/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = srvRestartProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

// The checks of the script run before it changes anything, in this order.
function srvOrderProblems(text) {
  const main = /\nmain\(\) \{\n([\s\S]*?)\n\}\n/.exec(text)?.[1];
  if (!main) return ['setup.sh has no main function'];
  const calls = main.split('\n').map((l) => l.trim().split(' ')[0]);
  const expected = ['check_agent_names', 'check_root_and_os', 'check_not_the_present_host', 'check_web_ports', 'check_ssh_port'];
  const problems = [];
  if (calls.slice(0, expected.length).join(' ') !== expected.join(' ')) problems.push(`main must start with the checks: ${expected.join(', ')}; it starts with: ${calls.slice(0, expected.length).join(', ')}`);
  const rest = calls.slice(expected.length).filter((c) => c.startsWith('install_') || c.startsWith('ensure_'));
  if (rest.length === 0 || rest[0] !== 'install_prerequisites') problems.push('the first change is install_prerequisites');
  if (!/\nmain "\$@"\s*$/.test(text)) problems.push('the script must end with: main "$@"');
  return problems;
}

test('agents host: setup.sh makes all its checks before its first change; it needs root, apt and a codename, pins two fingerprints and uses https only', () => {
  const text = srvRead('setup.sh');
  assert.deepEqual(srvOrderProblems(text), [], 'the real file passes');
  assert.ok(srvOrderProblems(srvReplace(text, '  check_not_the_present_host\n  check_web_ports\n', '  check_web_ports\n  check_not_the_present_host\n')).length > 0, 'the checks swapped');
  assert.ok(srvOrderProblems(srvReplace(text, '  check_not_the_present_host\n', '')).length > 0, 'a check taken out');
  assert.ok(srvOrderProblems(srvReplace(text, '  install_prerequisites\n', '  ensure_docker\n')).length > 0, 'a change before the first change');
  const code = srvCode(text);
  assert.ok(text.startsWith('#!/usr/bin/env bash\n'));
  assert.match(code, /^set -euo pipefail$/m);
  assert.match(code, /\[ "\$\(id -u\)" -eq 0 \] \|\| refuse 'run this script as root'/);
  assert.match(text, /^DOCKER_KEY_FPR=[0-9A-F]{40}$/m);
  assert.match(text, /^CADDY_KEY_FPR=[0-9A-F]{40}$/m);
  assert.match(code, /curl --fail --silent --show-error --location --proto '=https' --tlsv1\.2 /);
  assert.doesNotMatch(code, /\bhttp:\/\//, 'no plain http address');
  assert.match(code, /grep -Fq ":\$fingerprint:" <<<"\$listing"/, 'the key is checked against the pinned fingerprint before it is installed');
  assert.match(code, /https:\/\/download\.docker\.com\/linux\/\$OS_ID\/gpg/);
  assert.match(text, /^CADDY_KEY_URL=https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key$/m);
});

test('agents host: setup.sh lists the containers, the volumes and the folders of the present host, and the lists equal the compose files and the runbooks in deploy/host', () => {
  const listed = (text, name) => new RegExp(`^${name}="([^"]*)"$`, 'm').exec(text)?.[1]?.split(' ').sort();
  const fromHost = () => {
    const files = readdirSync(join(root, 'deploy/host'));
    const composes = files.filter((f) => /^docker-compose\..+\.yml$/.test(f)).map((f) => parseYaml(read(`deploy/host/${f}`)));
    assert.ok(composes.length >= 4, `the walk finds the compose files, found ${composes.length}`);
    return {
      PRESENT_CONTAINERS: composes.flatMap((c) => Object.values(c.services).map((s) => s.container_name)).sort(),
      PRESENT_VOLUMES: composes.flatMap((c) => Object.values(c.volumes ?? {}).map((v) => v.name)).sort(),
      PRESENT_FOLDERS: files.filter((f) => /^RUNBOOK.*\.md$/.test(f)).map((f) => /^BASE=(\/\S+)$/m.exec(read(`deploy/host/${f}`))?.[1]).sort(),
    };
  };
  const expected = fromHost();
  const text = srvRead('setup.sh');
  for (const [name, values] of Object.entries(expected)) assert.deepEqual(listed(text, name), values, `${name} equals deploy/host`);
  assert.equal(expected.PRESENT_CONTAINERS.length, 8);
  // A copy that forgets one container, or names one that deploy/host does not have, is refused.
  const without = srvReplace(text, ' advocate-service"', '"');
  assert.notDeepEqual(listed(without, 'PRESENT_CONTAINERS'), expected.PRESENT_CONTAINERS);
  assert.notDeepEqual(listed(srvReplace(text, 'PRESENT_VOLUMES="', 'PRESENT_VOLUMES="other-state '), 'PRESENT_VOLUMES'), expected.PRESENT_VOLUMES);
});

test('agents host: setup.sh passes bash -n, and shellcheck when it is installed', { skip: HAVE_BASH ? false : 'needs bash' }, () => {
  const syntax = spawnSync('bash', ['-n', join(root, SRV, 'setup.sh')], { encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
  const have = spawnSync('bash', ['-c', 'command -v shellcheck'], { encoding: 'utf8' });
  if (have.status !== 0) return;
  const check = spawnSync('shellcheck', ['-s', 'bash', join(root, SRV, 'setup.sh')], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout);
});

// ---- setup.sh run in a sandbox ----
// The script runs as the user of the test, with no root and no network. AGENTS_HOST_ROOT puts every path of the host under a temporary folder. The
// programs of the system (apt-get, systemctl, ufw, docker, caddy, curl, gpg, id, useradd and the others) are stand-ins that log each call and keep a
// little state. PATH holds the stand-ins and a few real tools, and nothing else, so that a program that the script calls and the sandbox does not
// know, a key generator for example, stops the script.
import { symlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
const SRV_NEEDS = { skip: HAVE_BASH && process.platform === 'linux' ? false : 'needs bash, GNU tools and Linux' };
const SRV_TOOLS = ['bash', 'dirname', 'basename', 'sed', 'tr', 'awk', 'grep', 'cmp', 'stat', 'cp', 'install', 'chmod', 'chown', 'mktemp', 'cat', 'rm', 'sort', 'head', 'ln', 'touch'];
const SRV_STUBBED = ['id', 'getent', 'useradd', 'usermod', 'dpkg', 'dpkg-query', 'apt-get', 'curl', 'gpg', 'systemctl', 'ss', 'sshd'];
const SRV_STUB = String.raw`#!/usr/bin/env bash
# A stand-in for the programs of the system that setup.sh calls. One file. It works by the name that calls it.
name=__NAME__
printf '%s' "$name" >> "$STUB_LOG"
for a in "$@"; do printf ' %s' "$a" >> "$STUB_LOG"; done
printf '\n' >> "$STUB_LOG"
state=$STUB_STATE
status=0
case "$name" in
  id)
    if [ "$1" = -u ]; then echo "$STUB_UID"
    elif [ "$1" = -nG ]; then echo "$2 $(cat "$state/groups" 2>/dev/null)"
    else echo "the stand-in for id knows two forms only: $*" >&2; status=2; fi ;;
  getent)
    if [ ! -e "$state/user-made" ] && [ -z "$STUB_USER_EXISTS" ]; then status=1; fi ;;
  useradd) touch "$state/user-made" ;;
  usermod) echo docker >> "$state/groups" ;;
  dpkg) echo amd64 ;;
  dpkg-query)
    for last; do :; done
    if grep -Fxq -- "$last" "$state/installed" 2>/dev/null; then printf 'install ok installed'; else status=1; fi ;;
  apt-get)
    cmd=''
    while [ $# -gt 0 ]; do
      a=$1; shift
      case "$a" in
        -o) shift ;;
        -*) ;;
        *)
          if [ -z "$cmd" ]; then cmd=$a
          elif [ "$cmd" = install ]; then
            echo "$a" >> "$state/installed"
            case "$a" in
              docker-ce) ln -sf "$STUB_PROGRAM" "$STUB_BIN/docker"; touch "$state/unit-docker" ;;
              caddy) ln -sf "$STUB_PROGRAM" "$STUB_BIN/caddy"; touch "$state/unit-caddy" ;;
              ufw) ln -sf "$STUB_PROGRAM" "$STUB_BIN/ufw" ;;
            esac
          fi ;;
      esac
    done ;;
  curl)
    out=''; url=''
    while [ $# -gt 0 ]; do
      case "$1" in
        --output) out=$2; shift 2 ;;
        -*) shift ;;
        *) url=$1; shift ;;
      esac
    done
    echo "stand-in key from $url" > "$out" ;;
  gpg)
    for last; do :; done
    if grep -q 'download.docker.com' "$last"; then fpr=$STUB_DOCKER_FPR; else fpr=$STUB_CADDY_FPR; fi
    echo 'pub:-:4096:1:AAAA:1:::-:::scESCA::::::23::0:'
    echo "fpr:::::::::$fpr:" ;;
  systemctl)
    case "$1" in
      enable) for a in "$@"; do case "$a" in enable|--now|-*) ;; *) touch "$state/unit-$a" ;; esac; done ;;
      is-enabled) if [ -e "$state/unit-$2" ]; then echo enabled; else echo disabled; status=1; fi ;;
      is-active) shift; if [ "$1" = --quiet ]; then shift; fi; if [ ! -e "$state/unit-$1" ]; then status=1; fi ;;
    esac ;;
  ufw)
    rules=$state/ufw.rules
    case "$*" in
      'status verbose')
        if [ -e "$state/ufw.active" ]; then printf 'Status: active\nLogging: on (low)\nDefault: %s\nNew profiles: skip\n' "$(cat "$state/ufw.defaults" 2>/dev/null)"; else echo 'Status: inactive'; fi ;;
      'show added')
        echo "Added user rules (see 'ufw status' for running firewall):"
        if [ -s "$rules" ]; then cat "$rules"; else echo '(None)'; fi ;;
      '--force reset') rm -f "$rules" "$state/ufw.active" "$state/ufw.defaults" ;;
      'default deny incoming') echo 'deny (incoming), allow (outgoing), disabled (routed)' > "$state/ufw.defaults" ;;
      '--force enable') touch "$state/ufw.active" ;;
      allow\ *) echo "ufw $*" >> "$rules" ;;
    esac ;;
  docker)
    case "$1" in
      --version) echo 'Docker version 0.0.0-stand-in' ;;
      compose) echo '0.0.0-stand-in' ;;
      ps)
        case "$*" in
          'ps -a --format {{.Names}}') for n in $STUB_CONTAINERS; do echo "$n"; done ;;
          'ps --quiet') for n in $STUB_RUNNING; do echo "$n"; done ;;
        esac ;;
      volume) for n in $STUB_VOLUMES; do echo "$n"; done ;;
    esac ;;
  caddy)
    case "$1" in
      version) echo 'v0.0.0-stand-in h1:stand-in' ;;
      validate) if [ -n "$STUB_CADDY_INVALID" ]; then echo 'Error: the stand-in says that the file is wrong' >&2; status=1; fi ;;
    esac ;;
  ss) if [ -n "$STUB_LISTEN" ]; then printf '%s\n' "$STUB_LISTEN"; fi ;;
  sshd) echo "port $STUB_SSHD_PORT" ;;
esac
exit $status
`.replace('name=__NAME__', 'name=$' + '{0##*/}');
const srvPin = (name) => new RegExp(`^${name}=([0-9A-F]{40})$`, 'm').exec(srvRead('setup.sh'))?.[1];
// A call of a program that changes the host: an install, an index update, a user, a download, a unit, a firewall rule.
const SRV_CHANGES = /^(?:useradd|usermod|curl) |^apt-get .* (?:install|update)(?: |$)|^systemctl (?:enable|restart|reload|start|stop) |^ufw (?:--force|default|allow) /;

// The real tools that the sandbox links, found one time for all sandboxes, and the group of the user of the test.
let srvToolList;
const srvToolPaths = () => (srvToolList ??= spawnSync('bash', ['-c', 'for t in "$@"; do command -v "$t"; done', 'find', ...SRV_TOOLS], { encoding: 'utf8' }).stdout.trim().split('\n'));
let SRV_GROUP = '';
try { SRV_GROUP = execFileSync('id', ['-gn'], { encoding: 'utf8' }).trim(); } catch { /* the tests that use it skip on a system with no id */ }
function srvSandbox({ docker = false, ufw = true, installed = ['ca-certificates', 'curl', 'gnupg'], osRelease = 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-host-'));
  const d = Object.fromEntries(['root', 'bin', 'tools', 'state', 'logs', 'tmp'].map((n) => [n, join(dir, n)]));
  for (const folder of Object.values(d)) mkdirSync(folder, { recursive: true });
  mkdirSync(join(d.root, 'etc'));
  writeFileSync(join(d.root, 'etc', 'os-release'), osRelease);
  const program = join(d.bin, '.stand-in');
  writeFileSync(program, SRV_STUB, { mode: 0o755 });
  for (const name of [...SRV_STUBBED, ...(ufw ? ['ufw'] : []), ...(docker ? ['docker'] : [])]) symlinkSync(program, join(d.bin, name));
  srvToolPaths().forEach((found, i) => symlinkSync(found, join(d.tools, SRV_TOOLS[i])));
  writeFileSync(join(d.state, 'installed'), `${[...installed, ...(docker ? ['docker-ce', 'docker-compose-plugin'] : [])].join('\n')}\n`);
  if (docker) writeFileSync(join(d.state, 'unit-docker'), '');
  const user = userInfo().username;
  const group = SRV_GROUP;
  let runs = 0;
  const box = {
    dir,
    fsRoot: d.root,
    state: d.state,
    user,
    seed(rel, text) { mkdirSync(join(d.root, rel, '..'), { recursive: true }); writeFileSync(join(d.root, rel), text); },
    seedState(name, text) { writeFileSync(join(d.state, name), text); },
    // Put a program of our own in place of a stand-in. The old link goes first: a write through it would change the stand-in.
    replaceProgram(name, script) { rmSync(join(d.bin, name), { force: true }); writeFileSync(join(d.bin, name), script, { mode: 0o755 }); },
    file(rel) { return readFileSync(join(d.root, rel), 'utf8'); },
    has(rel) { return existsSync(join(d.root, rel)); },
    run(args = [], env = {}) {
      runs += 1;
      const log = join(d.logs, `run-${runs}`);
      writeFileSync(log, '');
      const r = spawnSync(join(d.tools, 'bash'), [join(root, SRV, 'setup.sh'), ...args], {
        cwd: dir, encoding: 'utf8', timeout: 60_000,
        env: {
          PATH: `${d.bin}:${d.tools}`, HOME: dir, TMPDIR: d.tmp, AGENTS_HOST_ROOT: d.root, AGENTS_HOST_USER: user, AGENTS_HOST_GROUP: group,
          STUB_STATE: d.state, STUB_LOG: log, STUB_BIN: d.bin, STUB_PROGRAM: program, STUB_UID: '0', STUB_USER_EXISTS: '', STUB_CONTAINERS: '', STUB_RUNNING: '',
          STUB_VOLUMES: '', STUB_CADDY_INVALID: '', STUB_LISTEN: '', STUB_SSHD_PORT: '22', STUB_DOCKER_FPR: srvPin('DOCKER_KEY_FPR'), STUB_CADDY_FPR: srvPin('CADDY_KEY_FPR'), ...env,
        },
      });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    },
    // Every file and folder under the root of the host: kind, mode, path and the hash of the content.
    tree() {
      const out = [];
      const walk = (abs, rel) => {
        for (const entry of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const path = join(abs, entry.name);
          const name = rel === '' ? entry.name : `${rel}/${entry.name}`;
          const mode = (statSync(path).mode & 0o777).toString(8);
          if (entry.isDirectory()) {
            out.push(`d ${mode} ${name}`);
            walk(path, name);
          } else {
            out.push(`f ${mode} ${name} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
          }
        }
      };
      walk(d.root, '');
      return out;
    },
  };
  return box;
}
function withSrvSandbox(options, fn) {
  const box = srvSandbox(options);
  try {
    return fn(box);
  } finally {
    rmSync(box.dir, { recursive: true, force: true });
  }
}
const srvMode = (box, rel) => (statSync(join(box.fsRoot, rel)).mode & 0o777).toString(8);

test('agents host: setup.sh on a fresh host reads the two vendor keys over https, installs Docker and Caddy after the index update that follows each source, makes the user, writes its files and prints what it did', SRV_NEEDS, () => withSrvSandbox({}, (box) => {
  const r = box.run(['alpha', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^setup: result: \d+ changed, \d+ unchanged$/m);
  assert.match(r.stdout, /^setup: changed: installed Docker Engine and the compose plugin$/m);
  assert.match(r.stdout, /^setup: changed: installed Caddy$/m);
  assert.match(r.stdout, /^setup: keys: this script made no key\./m);
  // The order: key, index update, install, for Docker, and then for Caddy. A source that is added after the last update gives packages with no candidate.
  const steps = r.calls.filter((c) => /^(?:curl|apt-get) /.test(c)).map((c) => (c.startsWith('curl ') ? c.split(' ').at(-1) : c.endsWith(' update') ? 'update' : `install ${c.replace(/^.* install /, '')}`));
  assert.deepEqual(steps, [
    'https://download.docker.com/linux/ubuntu/gpg', 'update', 'install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
    'https://dl.cloudsmith.io/public/caddy/stable/gpg.key', 'update', 'install caddy',
  ]);
  for (const call of r.calls.filter((c) => c.startsWith('curl '))) assert.match(call, /^curl --fail --silent --show-error --location --proto =https --tlsv1\.2 --max-time 60 --output \S+ https:\/\/\S+$/);
  assert.equal(box.file('etc/apt/sources.list.d/docker.list'), 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu jammy stable\n');
  assert.equal(box.file('etc/apt/sources.list.d/caddy-stable.list'), 'deb [signed-by=/etc/apt/keyrings/caddy-stable.asc] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n');
  assert.ok(box.has('etc/apt/keyrings/docker.asc') && box.has('etc/apt/keyrings/caddy-stable.asc'));
  // The new Caddyfile is checked before it is written, and Caddy is reloaded after that, never restarted.
  const validate = r.calls.findIndex((c) => c.startsWith('caddy validate --config ') && c.endsWith('/deploy/server/Caddyfile --adapter caddyfile'));
  const reload = r.calls.indexOf('systemctl reload caddy');
  assert.ok(validate >= 0 && reload > validate, 'validate, then reload');
  assert.equal(r.calls.filter((c) => /^systemctl restart /.test(c)).map((c) => c.replace('systemctl restart ', '')).join(), 'systemd-journald');
  // The user is a system user with a shell, made with no password, and it joins the group docker.
  const useradd = r.calls.find((c) => c.startsWith('useradd '));
  assert.match(useradd, /^useradd --system --user-group --create-home --home-dir \S+\/srv\/agents --shell \/bin\/bash \S+$/);
  assert.ok(r.calls.includes(`usermod --append --groups docker ${box.user}`));
  assert.equal(r.calls.filter((c) => /password/i.test(c)).length, 0);
}));

test('agents host: setup.sh run two times gives the same result: the second run changes no file, no user, no unit and no rule, and its result line says 0 changed', SRV_NEEDS, () => withSrvSandbox({}, (box) => {
  const first = box.run(['alpha', 'beta']);
  assert.equal(first.status, 0, first.stderr);
  const treeAfterFirst = box.tree();
  assert.ok(first.calls.filter((c) => SRV_CHANGES.test(c)).length > 15, 'the first run changes a lot');
  const second = box.run(['alpha', 'beta']);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(box.tree(), treeAfterFirst, 'the files and folders are the same');
  assert.deepEqual(second.calls.filter((c) => SRV_CHANGES.test(c)), [], 'no call changes the host');
  assert.match(second.stdout, /^setup: result: 0 changed, \d+ unchanged$/m);
  assert.doesNotMatch(second.stdout, /^setup: changed:/m);
  // A third run with one more name changes that folder and nothing else.
  const third = box.run(['alpha', 'beta', 'gamma']);
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /^setup: result: 1 changed, \d+ unchanged$/m);
  assert.deepEqual(box.tree().filter((l) => !treeAfterFirst.includes(l)), ['d 750 srv/agents/gamma']);
}));

test('agents host: setup.sh stops on a host that runs the agents of the present host, with exit code 3 and no change; a host with other containers passes', SRV_NEEDS, () => {
  const refused = [
    ['a container of Agent History', { docker: true }, { STUB_CONTAINERS: 'unrelated agent-history-service' }, undefined, /container:agent-history-service/],
    ['a stopped container of the Pipeline', { docker: true }, { STUB_CONTAINERS: 'document-pipeline-agent' }, undefined, /container:document-pipeline-agent/],
    ['a container of Advocate', { docker: true }, { STUB_CONTAINERS: 'advocate-agent' }, undefined, /container:advocate-agent/],
    ['a volume', { docker: true }, { STUB_VOLUMES: 'advocate-state' }, undefined, /volume:advocate-state/],
    ['the volume of the Pipeline', { docker: true }, { STUB_VOLUMES: 'other document-pipeline-state' }, undefined, /volume:document-pipeline-state/],
    ['a folder', {}, {}, (box) => box.seed('opt/audio-snippets/.keep', ''), /folder:\/opt\/audio-snippets/],
    ['another folder', {}, {}, (box) => box.seed('opt/agent-history/.keep', ''), /folder:\/opt\/agent-history/],
  ];
  for (const [name, options, env, seed, expected] of refused) {
    withSrvSandbox(options, (box) => {
      seed?.(box);
      const before = box.tree();
      const r = box.run(['alpha'], env);
      assert.equal(r.status, 3, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /refused: this host runs the agents of the present host:/, name);
      assert.match(r.stderr, expected, name);
      assert.match(r.stderr, /nothing was changed/, name);
      assert.deepEqual(box.tree(), before, `${name}: no file changed`);
      assert.deepEqual(r.calls.filter((c) => SRV_CHANGES.test(c)), [], `${name}: no call changed the host`);
      assert.equal(r.stdout, '', `${name}: nothing was printed as done`);
    });
  }
  // The twin: containers, volumes and folders that are not the present host's pass.
  withSrvSandbox({ docker: true }, (box) => {
    box.seed('opt/something-else/.keep', '');
    const r = box.run(['alpha'], { STUB_CONTAINERS: 'reorder-agent reorder-service unrelated', STUB_VOLUMES: 'reorder-state' });
    assert.equal(r.status, 0, r.stderr);
  });
});

test('agents host: setup.sh sets the firewall to TCP 22, 80 and 443 and nothing else, also when the firewall had another rule; a firewall that is right is not touched', SRV_NEEDS, () => {
  const allowed = 'ufw allow 22/tcp\nufw allow 443/tcp\nufw allow 80/tcp\n';
  const defaults = 'deny (incoming), allow (outgoing), disabled (routed)\n';
  const writes = (calls) => calls.filter((c) => /^ufw (?:--force|default|allow) /.test(c)).map((c) => c.replace(/^ufw /, ''));
  const APPLY = ['--force reset', 'default deny incoming', 'default allow outgoing', 'allow 22/tcp', 'allow 80/tcp', 'allow 443/tcp', '--force enable'];
  const rules = (box) => readFileSync(join(box.state, 'ufw.rules'), 'utf8').trim().split('\n').sort();
  const seeded = (box, text, { active = true, policy = defaults } = {}) => {
    box.seedState('ufw.rules', text);
    box.seedState('ufw.defaults', policy);
    if (active) box.seedState('ufw.active', '');
  };
  const cases = [
    ['a fresh firewall', () => {}, APPLY],
    ['one more rule', (box) => seeded(box, `${allowed}ufw allow 8080/tcp\n`), APPLY],
    ['one rule missing', (box) => seeded(box, 'ufw allow 22/tcp\nufw allow 443/tcp\n'), APPLY],
    ['a rule for a port in the short form', (box) => seeded(box, `${allowed}ufw allow 9101\n`), APPLY],
    ['the rules right and the firewall off', (box) => seeded(box, allowed, { active: false }), APPLY],
    ['the rules right and incoming traffic allowed', (box) => seeded(box, allowed, { policy: 'allow (incoming), allow (outgoing), disabled (routed)\n' }), APPLY],
    ['a firewall that is right', (box) => seeded(box, allowed), []],
  ];
  for (const [name, seed, expected] of cases) {
    withSrvSandbox({}, (box) => {
      seed(box);
      const r = box.run(['alpha']);
      assert.equal(r.status, 0, `${name}: ${r.stderr}`);
      assert.deepEqual(writes(r.calls), expected, name);
      assert.deepEqual(rules(box), ['ufw allow 22/tcp', 'ufw allow 443/tcp', 'ufw allow 80/tcp'], `${name}: the rules at the end`);
      assert.ok(existsSync(join(box.state, 'ufw.active')), `${name}: the firewall is on at the end`);
    });
  }
  // IPv6 goes through the firewall: a file that says IPV6=no is corrected, and the firewall is applied again.
  withSrvSandbox({}, (box) => {
    box.seed('etc/default/ufw', 'IPV6=no\nDEFAULT_INPUT_POLICY="DROP"\n');
    seeded(box, allowed);
    const r = box.run(['alpha']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(box.file('etc/default/ufw'), /^IPV6=yes$/m);
    assert.deepEqual(writes(r.calls), APPLY);
  });
  // A host with no ufw gets it from apt first.
  withSrvSandbox({ ufw: false }, (box) => {
    const r = box.run(['alpha']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.calls.some((c) => /^apt-get .* install ufw$/.test(c)));
    assert.deepEqual(writes(r.calls), APPLY);
  });
});

test('agents host: setup.sh makes no key; the folder for keys is empty with mode 700, no file of the host holds key material, and the layout has the owners and modes of the README', SRV_NEEDS, () => withSrvSandbox({}, (box) => {
  const r = box.run(['alpha', 'beta']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(box.fsRoot, 'srv/agents/keys')), [], 'no key');
  const modes = Object.fromEntries(['srv/agents', 'srv/agents/keys', 'srv/agents/mock-systems', 'srv/agents/alpha', 'srv/agents/beta', 'etc/caddy/agents', 'etc/caddy/Caddyfile', 'etc/docker/daemon.json'].map((p) => [p, srvMode(box, p)]));
  assert.deepEqual(modes, { 'srv/agents': '750', 'srv/agents/keys': '700', 'srv/agents/mock-systems': '750', 'srv/agents/alpha': '750', 'srv/agents/beta': '750', 'etc/caddy/agents': '755', 'etc/caddy/Caddyfile': '644', 'etc/docker/daemon.json': '644' });
  // The README table says that the owner is the service user. The sandbox gives the user of the test that place.
  for (const rel of ['srv/agents', 'srv/agents/keys', 'srv/agents/mock-systems', 'srv/agents/alpha', 'srv/agents/beta']) assert.equal(statSync(join(box.fsRoot, rel)).uid, userInfo().uid, rel);
  for (const entry of box.tree().filter((l) => l.startsWith('f '))) {
    const text = box.file(entry.split(' ')[2]);
    assert.doesNotMatch(text, /[0-9a-fA-F]{56,}/, `${entry}: no run of hex that looks like a key`);
    assert.doesNotMatch(text, /PRIVATE KEY|ed25519e?_sk|addr1[0-9a-z]{20,}/i, entry);
  }
  // Only the stand-ins ran. A key generator is not in the sandbox, so a call to one would have stopped the script.
  assert.equal(r.calls.filter((c) => /keygen|genpkey|gen-keypair|openssl|--gen-key/.test(c)).length, 0);
  // The README table gives the same modes.
  const readme = srvRead('README.md');
  for (const row of ['| `/srv/agents` | `agents`, 750 |', '| `/srv/agents/<agent>` | `agents`, 750 |', '| `/srv/agents/mock-systems` | `agents`, 750 |', '| `/srv/agents/keys` | `agents`, 700 |', '| `/etc/caddy/Caddyfile` | `root`, 644 |', '| `/etc/caddy/agents/*.snippet` | `root`, 644 |']) assert.ok(readme.includes(row), row);
}));

test('agents host: setup.sh writes daemon.json with the log limits, live-restore and the loopback default, copies the Caddyfile whole, limits the journal, and keeps an old file one time', SRV_NEEDS, () => withSrvSandbox({}, (box) => {
  box.seed('etc/caddy/Caddyfile', ':80 {\n\trespond "welcome"\n}\n');
  box.seed('etc/docker/daemon.json', '{ "debug": true }\n');
  const r = box.run(['alpha']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(box.file('etc/docker/daemon.json')), { ip: '127.0.0.1', 'live-restore': true, 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m', 'max-file': '3' } });
  assert.equal(box.file('etc/caddy/Caddyfile'), srvRead('Caddyfile'), 'the file of the repository, byte for byte');
  assert.equal(box.file('etc/systemd/journald.conf.d/agents-host.conf'), '[Journal]\nSystemMaxUse=1G\nSystemMaxFileSize=100M\nMaxRetentionSec=1month\n');
  // The two old files are kept as they were, one time. A later change of the new file does not replace the copy.
  assert.equal(box.file('etc/caddy/Caddyfile.before-setup'), ':80 {\n\trespond "welcome"\n}\n');
  assert.equal(box.file('etc/docker/daemon.json.before-setup'), '{ "debug": true }\n');
  box.seed('etc/caddy/Caddyfile', '# edited by hand\n');
  const again = box.run(['alpha']);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(box.file('etc/caddy/Caddyfile'), srvRead('Caddyfile'), 'the file is put back');
  assert.equal(box.file('etc/caddy/Caddyfile.before-setup'), ':80 {\n\trespond "welcome"\n}\n', 'the first copy stays');
}));

test('agents host: setup.sh restarts Docker for a new daemon.json only when no container runs, and otherwise says pending', SRV_NEEDS, () => {
  for (const [running, restarts] of [['', true], ['0123456789ab', false]]) {
    withSrvSandbox({ docker: true }, (box) => {
      box.seed('etc/docker/daemon.json', '{ "log-driver": "json-file" }\n');
      const r = box.run([], { STUB_RUNNING: running });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.calls.includes('systemctl restart docker'), restarts, `containers running: ${JSON.stringify(running)}`);
      assert.equal(/^setup: pending: daemon\.json changed, and containers run\./m.test(r.stdout), !restarts);
      assert.equal(JSON.parse(box.file('etc/docker/daemon.json'))['live-restore'], true, 'the file is written in both cases');
    });
  }
  // A host that has no Docker yet starts it with the file already in place: no restart is needed, and none is made.
  withSrvSandbox({}, (box) => {
    const r = box.run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.includes('systemctl restart docker'), false);
    assert.ok(r.stdout.indexOf('etc/docker/daemon.json') > 0 && r.stdout.indexOf('etc/docker/daemon.json') < r.stdout.indexOf('installed Docker Engine'), 'daemon.json is written before Docker is installed');
  });
  // The same run again, with the file as the script writes it: nothing is pending and no restart is made.
  withSrvSandbox({ docker: true }, (box) => {
    box.run([]);
    const r = box.run([], { STUB_RUNNING: '0123456789ab' });
    assert.equal(r.calls.includes('systemctl restart docker'), false);
    assert.doesNotMatch(r.stdout, /pending/);
  });
});

test('agents host: setup.sh refuses a user that is not root, another system, an SSH session or sshd off port 22, a program on port 80, a bad agent name, a key with another fingerprint, a conflicting package and a bad Caddy file; the clean run is the twin of each', SRV_NEEDS, () => {
  const clean = withSrvSandbox({}, (box) => box.run(['alpha']));
  assert.equal(clean.status, 0, clean.stderr);
  const noChange = (box, r) => assert.deepEqual(r.calls.filter((c) => SRV_CHANGES.test(c)), []);
  const noFirewall = (box, r) => assert.deepEqual(r.calls.filter((c) => /^ufw (?:--force|default|allow)/.test(c)), []);
  const noCalls = (box, r) => assert.deepEqual(r.calls, []);
  // [name, sandbox options, environment, arguments, expected message, a check of what did not happen]
  const refusals = [
    ['a user that is not root', {}, { STUB_UID: '1000' }, ['alpha'], /run this script as root/, noChange],
    ['another system', { osRelease: 'ID=fedora\nVERSION_ID="40"\n' }, {}, ['alpha'], /needs Ubuntu or Debian \(apt\)\. This host runs 'fedora'/, noChange],
    ['an OS file with no codename', { osRelease: 'ID=ubuntu\nVERSION_ID="22.04"\n' }, {}, ['alpha'], /has no codename/, noChange],
    ['an SSH session on port 2222', {}, { SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 2222' }, ['alpha'], /this SSH session uses port 2222/, noFirewall],
    ['sshd on port 2222', {}, { STUB_SSHD_PORT: '2222' }, ['alpha'], /sshd listens on port 2222/, noFirewall],
    ['a web server on port 80', {}, { STUB_LISTEN: 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=412,fd=6))' }, ['alpha'], /another program holds TCP 80 or 443: 0\.0\.0\.0:80 users:/, noChange],
    ['a container proxy on port 443', {}, { STUB_LISTEN: 'LISTEN 0 4096 [::]:443 [::]:* users:(("docker-proxy",pid=7,fd=4))' }, ['alpha'], /another program holds TCP 80 or 443/, noChange],
    ['an agent name with a slash', {}, {}, ['../x'], /bad agent name '\.\.\/x'/, noCalls],
    ['an agent name in capitals', {}, {}, ['Alpha'], /bad agent name 'Alpha'/, noCalls],
    ['an agent name that is too long', {}, {}, ['a'.repeat(32)], /bad agent name/, noCalls],
    ['the name of the key folder', {}, {}, ['keys'], /the name 'keys' is for the set-up itself/, noCalls],
    ['the name of the mock folder', {}, {}, ['alpha', 'mock-systems'], /the name 'mock-systems' is for the set-up itself/, noCalls],
    ['a Docker key with another fingerprint', {}, { STUB_DOCKER_FPR: 'A'.repeat(40) }, ['alpha'], /the key from https:\/\/download\.docker\.com\/linux\/ubuntu\/gpg does not have the fingerprint [0-9A-F]{40}/, (box, r) => {
      assert.equal(box.has('etc/apt/sources.list.d/docker.list'), false, 'no source is written');
      assert.equal(box.has('etc/apt/keyrings/docker.asc'), false, 'no key is installed');
      assert.equal(r.calls.some((c) => / install docker-ce/.test(c)), false, 'no package is installed');
    }],
    ['a Caddy key with another fingerprint', { docker: true }, { STUB_CADDY_FPR: 'B'.repeat(40) }, ['alpha'], /the key from https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/gpg\.key does not have the fingerprint/, (box, r) => {
      assert.equal(box.has('etc/apt/sources.list.d/caddy-stable.list'), false);
      assert.equal(r.calls.some((c) => / install caddy/.test(c)), false);
    }],
    ['the Ubuntu Docker package', { installed: ['ca-certificates', 'curl', 'gnupg', 'docker.io'] }, {}, ['alpha'], /these packages conflict with Docker Engine\. Remove them first: docker\.io/, (box, r) => {
      assert.equal(r.calls.some((c) => / install docker-ce/.test(c)), false);
      assert.equal(box.has('etc/apt/sources.list.d/docker.list'), false);
    }],
    ['a Caddy file that does not validate', {}, { STUB_CADDY_INVALID: '1' }, ['alpha'], /caddy validate stops on the new Caddyfile or on a snippet in \/etc\/caddy\/agents: Error: the stand-in says/, (box) => {
      assert.equal(box.has('etc/caddy/Caddyfile'), false, 'the old file is not replaced');
      assert.equal(box.has('etc/systemd/journald.conf.d/agents-host.conf'), false, 'nothing runs after the refusal');
    }],
  ];
  for (const [name, options, env, args, expected, check] of refusals) {
    withSrvSandbox(options, (box) => {
      const r = box.run(args, env);
      assert.equal(r.status, 1, `${name}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, expected, name);
      assert.doesNotMatch(r.stderr, /stopped \(exit/, `${name}: a refusal gives no "stopped" line`);
      check(box, r);
    });
  }
});

test('agents host: setup.sh installs a missing prerequisite before Docker, reads the package lists again after each new source, and gives the line that says the script is safe to run again when apt fails', SRV_NEEDS, () => {
  withSrvSandbox({ installed: ['ca-certificates', 'curl'] }, (box) => {
    const r = box.run([]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^setup: changed: installed gnupg$/m);
    // The first index update serves the prerequisite. A source that comes after it needs an update of its own, or its packages have no candidate.
    const steps = r.calls.filter((c) => /^(?:curl|apt-get) /.test(c)).map((c) => (c.startsWith('curl ') ? c.split(' ').at(-1) : c.endsWith(' update') ? 'update' : `install ${c.replace(/^.* install /, '')}`));
    assert.deepEqual(steps, [
      'update', 'install gnupg',
      'https://download.docker.com/linux/ubuntu/gpg', 'update', 'install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin',
      'https://dl.cloudsmith.io/public/caddy/stable/gpg.key', 'update', 'install caddy',
    ]);
  });
  withSrvSandbox({}, (box) => {
    box.replaceProgram('apt-get', '#!/usr/bin/env bash\necho "E: Could not get lock" >&2\nexit 100\n');
    box.replaceProgram('dpkg-query', '#!/usr/bin/env bash\nexit 1\n');
    const r = box.run([]);
    assert.equal(r.status, 100, r.stderr);
    assert.match(r.stderr, /setup: stopped \(exit 100\)\. Fix the cause\. The script is safe to run again\./);
  });
});

// ---- The proof script, the README and the runbook ----
import { X509Certificate } from 'node:crypto';
import { AGENT_SNIPPET, ADMIN_LINE, HOST_PLACEHOLDER, MTLS_PLACEHOLDER, UPSTREAM, clientCertValue, fillAgentSnippet, fillSnippet, headerValues, proofCaddyfile } from '../deploy/server/prove-mock-mtls.mjs';

// One public test certificate (a self-signed client certificate with a SPIFFE ID). Its private key was destroyed when it was made. The tests use its bytes only.
const SRV_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBwzCCAWmgAwIBAgIUCebbW8qSmQrpDyc7gxgMjoHMH7owCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLdGVzdCBjbGllbnQwIBcNMjYxMTE5MTgxMDE1WhgPMjEyNjEw
MjYxODEwMTVaMBYxFDASBgNVBAMMC3Rlc3QgY2xpZW50MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEeg3wAO7KBWIZOd7osXm9mmL9Gisyem9EoXIwL7QMUWLkQHOB
/mQU8XT88Y/b1/GlzaAZEIUe2q77/YqdsYzt7KOBkjCBjzAdBgNVHQ4EFgQUcRDs
jowTYpWCKxL67+bXVW2aTgUwHwYDVR0jBBgwFoAUcRDsjowTYpWCKxL67+bXVW2a
TgUwDwYDVR0TAQH/BAUwAwEB/zAnBgNVHREEIDAehhxzcGlmZmU6Ly90ZXN0LmV4
YW1wbGUvY2xpZW50MBMGA1UdJQQMMAoGCCsGAQUFBwMCMAoGCCqGSM49BAMCA0gA
MEUCIQCmrOwslKJSBUSAT5Pne2a3qqXR8mGjSyj4tTaoK0PI7wIgP9b04ss0PcEu
dU2vOq5bnjiXwkW7gODMOWtbRp9woJU=
-----END CERTIFICATE-----
`;

test('agents host: the proof script fills the real snippet and the real main Caddyfile, and refuses a text that lacks a placeholder or the admin line', () => {
  const snippet = srvRead('Caddyfile.mock-systems.snippet');
  const filled = fillSnippet(snippet, { host: 'a.test:18443', mtlsHost: 'b.test:18443', upstream: '127.0.0.1:19120' });
  for (const part of [HOST_PLACEHOLDER, MTLS_PLACEHOLDER, UPSTREAM]) assert.equal(filled.split(part).length, 1, `${part} is gone`);
  const sites = srvCaddyTree(filled);
  assert.deepEqual(sites.map((s) => s.head), ['a.test:18443', 'b.test:18443']);
  assert.equal(srvFlat(sites).filter((h) => h.startsWith('reverse_proxy 127.0.0.1:19120')).length, 3, 'the three proxy lines go to the echo backend');
  for (const part of [HOST_PLACEHOLDER, MTLS_PLACEHOLDER, UPSTREAM]) {
    assert.throws(() => fillSnippet(snippet.split(part).join('x'), { host: 'a', mtlsHost: 'b', upstream: 'c' }), new RegExp(srvEscape(part)), part);
  }
  const main = srvRead('Caddyfile');
  const proof = proofCaddyfile(main, { httpPort: 18080, httpsPort: 18443 });
  const lines = proof.split('\n');
  assert.equal(lines.includes(ADMIN_LINE), false, 'the admin line is replaced');
  for (const line of ['\tadmin off', '\tlocal_certs', '\tskip_install_trust', '\thttp_port 18080', '\thttps_port 18443', '\tdefault_bind 127.0.0.1', '\t\tprotocols h1 h2', `import ${SRV_FOLDER}/*.snippet`]) assert.ok(lines.includes(line), line);
  assert.equal(srvCaddyTree(proof).length, 2, 'the global block and the import line');
  assert.throws(() => proofCaddyfile(srvReplace(main, ADMIN_LINE, '\tadmin off'), { httpPort: 1, httpsPort: 2 }), /admin line once/);
  assert.throws(() => proofCaddyfile(`${main}${ADMIN_LINE}\n`, { httpPort: 1, httpsPort: 2 }), /admin line once/);
  // The snippet of an agent, and the reader of the raw header list of a Node request.
  const agent = fillAgentSnippet(AGENT_SNIPPET, { host: 'agent.example.test', servicePort: 9101, runtimePort: 8101 });
  assert.deepEqual(srvFlat(srvCaddyTree(agent)), ['agent.example.test', 'handle /agent.json', 'reverse_proxy 127.0.0.1:9101', 'handle', 'reverse_proxy 127.0.0.1:8101']);
  for (const part of ['<agent-host>', '<service-port>', '<runtime-port>']) {
    assert.throws(() => fillAgentSnippet(AGENT_SNIPPET.split(part).join('x'), { host: 'a', servicePort: 1, runtimePort: 2 }), new RegExp(srvEscape(part)), part);
  }
  assert.deepEqual(headerValues(['Host', 'a', 'client-cert', ':X:', 'CLIENT-CERT', ':Y:', 'Client-Cert-Chain', ':Z:'], 'Client-Cert'), [':X:', ':Y:']);
  assert.deepEqual(headerValues(['Host', 'a'], 'Client-Cert'), []);
});

test('agents host: the README gives the counts, the memory and the plan of the ports, and the snippet shape of the README is the one that the proof validates', () => {
  const readme = srvRead('README.md');
  for (const part of ['The plan for the host is 19 containers: 8 services, 10 runtimes and 1 mock service.', '| Memory | 8 GiB |', '| Agent host names | 10 | A, DNS only |', '| Mock host names | 2 | A, DNS only |', '| Organisation checks | 9 | TXT |']) assert.ok(readme.includes(part), part);
  // The plan of the ports: the counts in the rows are the sizes of the ranges, and together they are the 19 containers. The rows of the two packs of use case 1, of the two packs of use case 2 and of the packs of use case 3
  // are the ports of their compose files, and no row is left for a later agent.
  const rows = [...section(readme, 'Folders and ports').matchAll(/^\| ([A-Za-z][^|]*?) \((\d+)\) \| (\d+)(?: to (\d+))? \|$/gm)].map((m) => ({ label: m[1], count: Number(m[2]), from: Number(m[3]), to: Number(m[4] ?? m[3]) }));
  assert.deepEqual(rows.map((row) => row.label), ['Reorder Agent runtime', 'Order Desk runtimes', 'Prior Authorization Agent runtime', 'Insurer Intake Agent runtime', 'Sourcing Agent runtime', 'Bid Desk runtimes', 'Reorder Agent service', 'Order Desk service', 'Prior Authorization Agent service', 'Insurer Intake Agent service', 'Sourcing Agent service', 'Bid Desk services', 'Mock service']);
  const plan = Object.fromEntries(rows.map((row) => [row.label, row]));
  for (const row of rows) assert.equal(row.to - row.from + 1, row.count, `${row.label}: the range has as many ports as the count`);
  const runtimeRows = rows.filter((row) => /runtime/i.test(row.label));
  const serviceRows = rows.filter((row) => /service/i.test(row.label) && row.label !== 'Mock service');
  assert.equal(runtimeRows.reduce((sum, row) => sum + row.count, 0), 10, 'ten runtimes');
  assert.equal(serviceRows.reduce((sum, row) => sum + row.count, 0), 8, 'eight services');
  assert.equal(rows.reduce((sum, row) => sum + row.count, 0), 19);
  // The opening and the memory text say the same of the 19 containers: the memory holds the mock service and the six of use case 1, and the four of use case 2 and the eight of use case 3 do not all pass the gate. No container is left over.
  const count = (...labels) => labels.reduce((sum, label) => sum + plan[label].count, 0);
  const useCase1 = count('Reorder Agent runtime', 'Order Desk runtimes', 'Reorder Agent service', 'Order Desk service');
  const useCase2 = count('Prior Authorization Agent runtime', 'Insurer Intake Agent runtime', 'Prior Authorization Agent service', 'Insurer Intake Agent service');
  const useCase3 = count('Sourcing Agent runtime', 'Bid Desk runtimes', 'Sourcing Agent service', 'Bid Desk services');
  assert.deepEqual([plan['Mock service'].count, useCase1, useCase2, useCase3], [1, 6, 4, 8], 'the mock service, six containers of use case 1, four of use case 2 and eight of use case 3: the 19 containers, and none is left over');
  assert.ok(readme.includes(`The memory of the host holds the mock service and the ${IMAGE_WORDS[useCase1]} containers of use case 1 at the planning sizes. The ${IMAGE_WORDS[useCase2]} containers of use case 2 do not all pass the gate at the planning sizes. The ${IMAGE_WORDS[useCase3]} containers of use case 3 do not all pass it either (section "The host").`), 'the opening says how many containers the memory holds');
  for (const group of [runtimeRows, serviceRows]) group.slice(1).forEach((row, i) => assert.equal(row.from, group[i].to + 1, `${row.label} follows ${group[i].label} with no gap`));
  const [runtimeFrom, runtimeTo, serviceFrom, serviceTo] = [runtimeRows[0].from, runtimeRows.at(-1).to, serviceRows[0].from, serviceRows.at(-1).to];
  assert.ok(runtimeTo < serviceFrom && serviceTo < plan['Mock service'].from, 'the ranges do not overlap');
  assert.equal(SRV_UPSTREAM, `127.0.0.1:${plan['Mock service'].from}`, 'the snippet proxies to the port of the mock service in the plan');
  const reorderPorts = PACK_PORTS[serverCompose('reorder-agent')];
  const orderPorts = PACK_PORTS[serverCompose('order-desk')];
  const orderRuntimes = ['runtime-small', 'runtime-medium', 'runtime-large'].map((name) => orderPorts[name][0]);
  assert.deepEqual([plan['Reorder Agent runtime'].from, plan['Reorder Agent runtime'].to], [reorderPorts.runtime[0], reorderPorts.runtime[0]], 'the runtime of the Reorder Agent');
  assert.deepEqual([plan['Order Desk runtimes'].from, plan['Order Desk runtimes'].to], [Math.min(...orderRuntimes), Math.max(...orderRuntimes)], 'the three runtimes of the Order Desk');
  assert.deepEqual([plan['Reorder Agent service'].from, plan['Order Desk service'].from], [reorderPorts.service[0], orderPorts.service[0]], 'the two services');
  const priorPorts = PACK_PORTS[serverCompose('prior-authorization-agent')];
  const intakePorts = PACK_PORTS[serverCompose('insurer-intake-agent')];
  assert.deepEqual([plan['Prior Authorization Agent runtime'].from, plan['Prior Authorization Agent runtime'].to, plan['Insurer Intake Agent runtime'].from, plan['Insurer Intake Agent runtime'].to], [priorPorts.runtime[0], priorPorts.runtime[0], intakePorts.runtime[0], intakePorts.runtime[0]], 'the two runtimes of use case 2');
  assert.deepEqual([plan['Prior Authorization Agent service'].from, plan['Insurer Intake Agent service'].from], [priorPorts.service[0], intakePorts.service[0]], 'the two services of use case 2');
  const sourcingPorts = PACK_PORTS[serverCompose('sourcing-agent')];
  const deskPorts = ['alfa', 'bravo', 'charlie'].map((name) => PACK_PORTS[serverCompose(`bid-desk-${name}`)]);
  const [deskRuntimes, deskServices] = [deskPorts.map((ports) => ports.runtime[0]), deskPorts.map((ports) => ports.service[0])];
  assert.deepEqual([plan['Sourcing Agent runtime'].from, plan['Sourcing Agent runtime'].to, plan['Sourcing Agent service'].from, plan['Sourcing Agent service'].to], [sourcingPorts.runtime[0], sourcingPorts.runtime[0], sourcingPorts.service[0], sourcingPorts.service[0]], 'the runtime and the service of the Sourcing Agent');
  assert.deepEqual([plan['Bid Desk runtimes'].from, plan['Bid Desk runtimes'].to], [Math.min(...deskRuntimes), Math.max(...deskRuntimes)], 'the three runtimes of the Bid Desks');
  assert.deepEqual([plan['Bid Desk services'].from, plan['Bid Desk services'].to], [Math.min(...deskServices), Math.max(...deskServices)], 'the three services of the Bid Desks');
  const runbook = srvRead('RUNBOOK.md');
  assert.ok(runbook.includes(`seq ${runtimeFrom} ${runtimeTo}`), 'the runbook checks each runtime port of the plan');
  assert.ok(runbook.includes(`range ${runtimeFrom} to ${runtimeTo}`) && runbook.includes(`range ${serviceFrom} to ${serviceTo}`));
  // The snippet shape of an agent.
  const block = /\n```\n(<agent-host> \{\n[\s\S]*?\n\})\n```\n/.exec(readme)?.[1];
  assert.equal(`${block}\n`, AGENT_SNIPPET);
});

test('agents host: the README gives the header Client-Cert as the snippet sets it, and its example code reads a real value and gives null for a bad one', () => {
  const readme = srvRead('README.md');
  const FORM = '^:[A-Za-z0-9+/]+={0,2}:$';
  for (const row of ['| Name | `Client-Cert` (the name of RFC 9440) |', '| Value | `:` + the standard base64 of the DER bytes of the certificate + `:` |', `| Form of the value | \`${FORM}\` |`]) assert.ok(readme.includes(row), row);
  assert.ok(srvRead('Caddyfile.mock-systems.snippet').includes(`header_up Client-Cert ":${SRV_CERT}:"`), 'the snippet sets that value');
  // The value of the proof is the value of the table, for a real certificate.
  const value = clientCertValue(SRV_TEST_CERT);
  assert.match(value, new RegExp(FORM));
  const der = new X509Certificate(SRV_TEST_CERT).raw;
  assert.equal(value, `:${der.toString('base64')}:`);
  assert.equal(Buffer.from(value.slice(1, -1), 'base64').equals(der), true, 'the value decodes to the DER bytes');
  // The example code of the README runs as written, in a child process, with the value and with bad values.
  const code = /```js\n([\s\S]*?)\n```/.exec(readme)?.[1];
  assert.ok(code, 'the README has the example');
  const codeLines = code.split('\n');
  const source = [
    ...codeLines.filter((l) => l.startsWith('import ')),
    'const run = (req) => {',
    ...codeLines.filter((l) => !l.startsWith('import ')),
    'return certificate;',
    '};',
    'const inputs = JSON.parse(process.argv[2]);',
    "console.log(JSON.stringify(inputs.map((h) => { const c = run({ headers: { 'client-cert': h ?? undefined } }); return c && { subject: c.subject, fingerprint: c.fingerprint256 }; })));",
  ].join('\n');
  const dir = mkdtempSync(join(tmpdir(), 'agents-host-example-'));
  try {
    writeFileSync(join(dir, 'example.mjs'), source);
    const bad = [null, value.slice(1, -1), `${value}, ${value}`, ':not base64!:', '::', `${value} `, `x${value}`, ':AAAA:', `:${Buffer.concat([der, Buffer.from([0])]).toString('base64')}:`, `:${Buffer.concat([der, der]).toString('base64')}:`];
    const out = JSON.parse(execFileSync(process.execPath, [join(dir, 'example.mjs'), JSON.stringify([value, ...bad])], { encoding: 'utf8' }));
    assert.deepEqual(out[0], { subject: 'CN=test client', fingerprint: new X509Certificate(SRV_TEST_CERT).fingerprint256 });
    assert.deepEqual(out.slice(1), bad.map(() => null), 'no header, no colons, two headers, no base64, an empty value, a space, a prefix, bytes that are not a certificate, a certificate and one more byte, and a certificate two times all give null');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agents host: the runbook has its steps in order, the README points at them, and the failure table uses the messages of the script', () => {
  const runbook = srvRead('RUNBOOK.md');
  const readme = srvRead('README.md');
  const setup = srvRead('setup.sh');
  assert.deepEqual([...runbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), [
    '1. Get the host', '2. Put the files on the host', '3. Run the script', '4. Check the host', '5. Make the DNS records', '6. Install the snippet of the mock systems',
    '7. Add an agent', '8. Remove an agent', 'Keys', 'The restart rule', 'Upgrade the host', 'The failure table',
  ]);
  assert.ok(readme.includes('(RUNBOOK, step 6)') && runbook.includes('\n## 6. Install the snippet of the mock systems\n'));
  assert.ok(readme.includes('See the RUNBOOK, section "Keys".') && runbook.includes('\n## Keys\n'));
  assert.ok(runbook.includes('(README, section "The local proof")') && readme.includes('\n### The local proof\n'));
  // A message in the failure table is a message that the script prints.
  for (const message of ['this host runs the agents of the present host', 'another program holds TCP 80 or 443', 'this SSH session uses port', 'does not have the fingerprint', 'conflict with Docker Engine', 'caddy validate stops on', 'pending: daemon.json changed', 'stopped (exit']) {
    assert.ok(runbook.includes(message), `the runbook says: ${message}`);
    assert.ok(setup.includes(message), `the script says: ${message}`);
  }
  // The rules that both documents give: the restart rule, the keys rule and the modes that the check of step 4 expects.
  for (const text of [readme, runbook]) assert.ok(text.includes('A restart during a run is forbidden.'));
  assert.ok(readme.includes('Reload Caddy. Do not restart it.') && runbook.includes('Never restart Caddy. Reload it.'));
  assert.ok(readme.includes('No key is made on another machine. No key leaves the host.'));
  for (const rule of ['Make each key on this host. Never make a key on another machine.', 'Make a key as the service user, in `/srv/agents/keys`, with `umask 077`. A key file has mode 600.', 'The key never leaves the host. Nobody signs on another machine.', 'The script makes no key and reads no key.']) assert.ok(runbook.includes(rule), rule);
  assert.ok(runbook.includes('`750 agents:agents /srv/agents`, `700 agents:agents /srv/agents/keys`, `750 agents:agents /srv/agents/mock-systems`'));
});

test('agents host: the commands of the runbook run as written: the check of the listeners, the change of the placeholders, the check for a public container port and the check of each runtime', NEEDS_BASH, () => {
  const runbook = srvRead('RUNBOOK.md');
  const lines = runbook.split('\n').map((l) => l.trim());
  const line = (start) => {
    const found = lines.find((l) => l.startsWith(start));
    assert.ok(found, `the runbook has a command that starts with: ${start}`);
    return found;
  };
  const dir = mkdtempSync(join(tmpdir(), 'agents-host-runbook-'));
  // The lines that a command reads from a program of the system are replaced by a sample.
  const sampled = (command, source, sample) => runBash(`SAMPLE=$'${sample.split('\n').join('\\n')}'\n${command.replace(source, 'printf \'%s\\n\' "$SAMPLE"')}\n`, dir);
  try {
    // 1. The listeners: the three public ports and the loopback addresses pass. Any other address is printed.
    const listeners = line('ss -ltnH');
    const fine = ['LISTEN 0 128 0.0.0.0:22 0.0.0.0:*', 'LISTEN 0 128 [::]:22 [::]:*', 'LISTEN 0 511 *:80 *:*', 'LISTEN 0 511 *:443 *:*', 'LISTEN 0 4096 127.0.0.1:2019 0.0.0.0:*', 'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*', 'LISTEN 0 4096 [::1]:8101 [::]:*', 'LISTEN 0 4096 127.0.0.1:9120 0.0.0.0:*'];
    assert.equal(sampled(listeners, 'ss -ltnH', fine.join('\n')).stdout, 'ok: no other public listener\n');
    for (const extra of ['LISTEN 0 4096 0.0.0.0:8101 0.0.0.0:*', 'LISTEN 0 4096 [::]:9101 [::]:*', 'LISTEN 0 4096 *:8080 *:*', 'LISTEN 0 4096 192.0.2.7:2019 0.0.0.0:*']) {
      const r = sampled(listeners, 'ss -ltnH', [...fine, extra].join('\n'));
      assert.equal(r.stdout, `${extra.split(' ')[3]}\n`, `the check prints ${extra}`);
    }
    // 2. The placeholders of the snippet: both are replaced, and the check says so. Copies that keep a placeholder fail the check.
    copyFileSync(join(root, SRV, 'Caddyfile.mock-systems.snippet'), join(dir, 'Caddyfile.mock-systems.snippet'));
    const sed = line('sed -e "s|<mock-host>|');
    const check = line('if grep -qF -e');
    const done = runBash(`MOCK_HOST=mock.example.test\nMOCK_MTLS_HOST=mock-mtls.example.test\n${sed}\n${check}\n`, dir);
    assert.equal(done.stdout, 'ok\n', done.stderr);
    assert.deepEqual(srvMockSnippetProblems(readFileSync(join(dir, 'mock-systems.snippet'), 'utf8').split('mock.example.test').join('<mock-host>').split('mock-mtls.example.test').join('<mock-mtls-host>')), [], 'the copy is the snippet with two names in place of the placeholders');
    assert.deepEqual(srvCaddyTree(readFileSync(join(dir, 'mock-systems.snippet'), 'utf8')).map((s) => s.head), ['mock.example.test', 'mock-mtls.example.test']);
    assert.equal(runBash(`cp Caddyfile.mock-systems.snippet mock-systems.snippet\n${check}\n`, dir).stdout, 'a placeholder is left\n', 'no placeholder replaced');
    assert.equal(runBash(`MOCK_HOST=mock.example.test\nsed -e "s|<mock-host>|$MOCK_HOST|g" Caddyfile.mock-systems.snippet > mock-systems.snippet\n${check}\n`, dir).stdout, 'a placeholder is left\n', 'one placeholder replaced');
    assert.ok(runbook.includes('sudo install -m 644 -o root -g root mock-systems.snippet /etc/caddy/agents/mock-systems.snippet'), 'the copy is installed with a mode that Caddy can read');
    // 3. The public container port: the loopback forms and a container with no port pass. A public address is found.
    const publicPorts = line("docker ps --format '{{.Names}} {{.Ports}}'");
    const source = "docker ps --format '{{.Names}} {{.Ports}}'";
    assert.equal(sampled(publicPorts, source, 'a-agent 127.0.0.1:8101->8080/tcp\na-service 127.0.0.1:9101->9091/tcp\nb-agent ').stdout, 'ok: no public container port\n');
    for (const bad of ['c-agent 0.0.0.0:8102->8080/tcp, [::]:8102->8080/tcp', 'c-agent 0.0.0.0:8102->8080/tcp', 'c-agent [::]:8102->8080/tcp']) {
      assert.match(sampled(publicPorts, source, `a-agent 127.0.0.1:8101->8080/tcp\n${bad}`).stdout, /PUBLIC PORT FOUND\n$/, bad);
    }
    // 4. The check of each runtime: ten ports, one answer or "no answer" for each.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'curl'), '#!/bin/bash\nfor last; do :; done\ncase "$last" in *:8105/status) exit 7 ;; esac\nprintf free\n', { mode: 0o755 });
    const loop = line('for port in $(seq');
    const r = runBash(`PATH="${join(dir, 'bin')}:$PATH"\n${loop}\n`, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split('\n'), Array.from({ length: 10 }, (_, i) => `${8101 + i}: ${8101 + i === 8105 ? 'no answer' : 'free'}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('agents host: no command of the runbook prints a key or an env file, and none makes a key', () => {
  const runbook = srvRead('RUNBOOK.md');
  const blocks = [...runbook.matchAll(/```[a-z]*\n([\s\S]*?)\n\s*```/g)].map((m) => m[1]).join('\n');
  assert.ok(blocks.length > 2000, `the guard reads the code blocks, found ${blocks.length} characters`);
  const danger = /keygen|genpkey|gen-keypair|openssl\s+(?:req|genpkey|rand)|\bcat\b[^\n]*(?:\.env|keys\/|\.key|\.skey)|\bprintenv\b|\bdocker\s+(?:compose\s+config|inspect)\b/i;
  assert.doesNotMatch(blocks, danger);
  for (const bad of ['ssh-keygen -t ed25519', 'cat /srv/agents/keys/service.key', 'cat .env.agent', 'docker compose config', 'docker inspect agent', 'printenv', 'gen-keypair --network 1', 'openssl genpkey -algorithm ed25519']) assert.match(bad, danger, bad);
});

// ======================================================================================================================================
// The mock service on the agents host (deploy/server): its compose file, its env example, its steps in the runbook and its CI lines.
// The service holds no key and no wallet, and it keeps its tenants in memory. These tests parse the files and keep them equal to the settings and the limits of the
// service (services/mock-systems/src), run the commands of the runbook that a test can run (with stand-ins for docker and curl), and send the tenant call of the
// runbook to the real code of the service on a loopback port. They read no Dockerfile: CI builds the image. Each guard has an accepted twin and refused copies.
// ======================================================================================================================================
import { createServer as createStubServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync } from 'node:fs';
const execFileAsync = promisify(execFile);
const MOCK = { image: 'ghcr.io/apex-fusion/vector-service-agents/mock-systems', name: 'mock-systems', port: 9120, composeFile: 'docker-compose.mock-systems.yml', exampleFile: '.env.mock-systems.example', envFile: '.env.mock-systems' };
const mockComposeText = srvRead(MOCK.composeFile);
const mockExampleText = srvRead(MOCK.exampleFile);
const mockExample = parseEnv(mockExampleText);
const mockRunbook = srvRead('RUNBOOK.md');
const mockReadme = srvRead('README.md');
const mockConfigSource = read('services/mock-systems/src/config.ts');
const mockTenantsSource = read('services/mock-systems/src/tenants.ts');
const inMockService = (code, arg) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(arg)], { cwd: join(root, 'services/mock-systems'), encoding: 'utf8' }));
// A name that would hold a key or a wallet. The service holds neither.
const MOCK_KEYLIKE = /PRIV|KEY|WALLET|PKH|ADDRESS/;
// The sizes of the limits of the service, as its source writes them.
const mockNumber = (source, name) => { const m = new RegExp(`export const ${name} = ([0-9_]+);`).exec(source); return m ? Number(m[1].replaceAll('_', '')) : NaN; };
const mockConstant = (name) => mockNumber(mockTenantsSource, name);
const mockDefault = (name) => new RegExp(`export const ${name} = '([^']+)';`).exec(mockConfigSource)?.[1];
// A size as compose writes it: 2048m, 1g, 512k.
const mockBytes = (text) => { const m = /^(\d+)([kmg])$/i.exec(String(text)); return m ? Number(m[1]) * { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()] : NaN; };
// What a full store takes in the heap: the most tenants with the most log lines each (src/tenants.ts). Measured with Node 22: 100 tenants of 5000 lines took 650 MiB of heap, about
// 1.2 KiB for each line (a short path and one actor), and an idle service holds about 80 MiB. A line with the longest path and two actors is about 1.5 KiB.
const MOCK_LINE_BYTES = 1536;
const MOCK_IDLE_HEAP = 80 * 1024 ** 2;
const mockStoreBytes = () => mockConstant('MAX_TENANTS') * mockConstant('MAX_LOG_LINES') * MOCK_LINE_BYTES + MOCK_IDLE_HEAP;
// No limit of the mock service may pass 3 GiB: the host has 8 GiB, and the mock service shares them with the containers of the agents (README, section "The host").
const MOCK_LIMIT_MAX = 3 * 1024 ** 3;
const mockSame = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mockSorted = (object) => JSON.stringify(Object.entries(object).sort());

// The faults of the compose file of the mock service. An empty list is a pass.
function mockComposeProblems(text, storeBytes = mockStoreBytes()) {
  const model = parseYaml(text);
  const names = Object.keys(model?.services ?? {});
  if (names.join() !== MOCK.name) return [`the file must have one service, ${MOCK.name}; it has: ${names.join() || 'none'}`];
  const s = model.services[MOCK.name];
  const problems = [...srvComposeProblems(text)];
  if (!new RegExp(`^${srvEscape(MOCK.image)}@sha256:(?:<digest>|[0-9a-f]{64})$`).test(String(s.image))) problems.push(`image must be ${MOCK.image}@sha256: and 64 hex digits, or the placeholder <digest>; found: ${s.image}`);
  if (s.container_name !== MOCK.name) problems.push(`container_name must be ${MOCK.name}`);
  if (s.restart !== 'unless-stopped') problems.push('restart must be unless-stopped');
  if (!mockSame(s.env_file, [{ path: `./${MOCK.envFile}`, required: true }])) problems.push(`env_file must be the one file ./${MOCK.envFile}, and it must be required`);
  if (!mockSame(s.ports, [`127.0.0.1:${MOCK.port}:${MOCK.port}`])) problems.push(`ports must be the one entry 127.0.0.1:${MOCK.port}:${MOCK.port}; found: ${JSON.stringify(s.ports)}`);
  const environment = runtimeEnvironment(s);
  const keyNames = Object.keys(environment).filter((name) => MOCK_KEYLIKE.test(name));
  if (keyNames.length > 0) problems.push(`the service holds no key and no wallet, and the file sets: ${keyNames.join(', ')}`);
  if (mockSorted(environment) !== mockSorted({ PORT: String(MOCK.port), HOST: '0.0.0.0' })) problems.push(`environment must be PORT "${MOCK.port}" and HOST "0.0.0.0" and nothing else: the other settings belong in the env file; found: ${JSON.stringify(environment)}`);
  if ('volumes' in s || 'volumes' in model) problems.push('the mock service has no volume: its tenants are in memory');
  // The hardening that the service permits: it writes nothing but the cache of tsx in /tmp.
  if (s.read_only !== true) problems.push('read_only must be true');
  if (!mockSame(s.cap_drop, ['ALL'])) problems.push('cap_drop must be [ALL]');
  if (!(s.security_opt ?? []).includes('no-new-privileges:true')) problems.push('security_opt must have no-new-privileges:true');
  if (!Array.isArray(s.tmpfs) || s.tmpfs.length !== 1 || !/^\/tmp(?::|$)/.test(s.tmpfs[0])) problems.push('tmpfs must be the one entry /tmp: tsx writes its cache there, and nothing else is writable');
  for (const key of ['privileged', 'cap_add', 'network_mode', 'pid', 'ipc', 'devices', 'volumes_from']) if (key in s) problems.push(`${key} is not allowed`);
  // The service listens on 0.0.0.0 inside its container. A network that another container shares would let that container send a forged Client-Cert header. With no networks key, compose puts
  // the service on the default network of its own project, which only the Caddy container joins, on a host whose proxy runs in a container.
  if ('networks' in s) problems.push('the service has no networks key: it stays on the default network of its own project, which only the Caddy container joins');
  if ('networks' in model) problems.push('the file has no top-level networks key: the service stays on the default network of its own project');
  if (s.logging?.driver !== 'json-file' || s.logging?.options?.['max-size'] !== '10m' || s.logging?.options?.['max-file'] !== '3') problems.push('logging must be json-file with 3 files of 10m, as the other compose files have it');
  const limit = mockBytes(s.mem_limit);
  if (!(limit > 0)) problems.push('mem_limit must be set, for example 2048m');
  else {
    if (limit / 2 < storeBytes) problems.push(`mem_limit ${s.mem_limit} is too small: Node keeps its heap below half of it, and a full store needs about ${Math.ceil(storeBytes / 1024 ** 2)} MiB of heap`);
    if (limit > MOCK_LIMIT_MAX) problems.push(`mem_limit ${s.mem_limit} is above the 3 GiB that the plan of the memory keeps free for growth`);
  }
  return problems;
}

test('mock service compose: one container with the image by digest, on 127.0.0.1:9120 only, no volume, no key and no wallet, the hardening, and a memory limit that a full store fits; the guard refuses each copy that breaks one of these', () => {
  assert.deepEqual(mockComposeProblems(mockComposeText), [], 'the real file passes');
  const text = mockComposeText;
  const faults = [
    ['a public port', srvReplace(text, '["127.0.0.1:9120:9120"]', '["9120:9120"]'), /ports must be the one entry/],
    ['the address of every interface', srvReplace(text, '"127.0.0.1:9120:9120"', '"0.0.0.0:9120:9120"'), /ports must be the one entry/],
    ['a second port', srvReplace(text, '["127.0.0.1:9120:9120"]', '["127.0.0.1:9120:9120", "127.0.0.1:9121:9121"]'), /ports must be the one entry/],
    ['another port on the host', srvReplace(text, '"127.0.0.1:9120:9120"', '"127.0.0.1:9121:9120"'), /ports must be the one entry/],
    ['the host network', srvReplace(text, '    read_only: true\n', '    read_only: true\n    network_mode: host\n'), /network_mode/],
    ['a network of the service', srvReplace(text, '    read_only: true\n', '    read_only: true\n    networks: [proxy]\n'), /the service has no networks key/],
    ['a network at the top', `${text}networks:\n  proxy:\n    name: shared\n`, /no top-level networks key/],
    ['the external network of the proxy, on the service and at the top', `${srvReplace(text, '    read_only: true\n', '    read_only: true\n    networks: [proxy]\n')}networks:\n  proxy:\n    external: true\n`, /the service has no networks key/],
    ['a volume', srvReplace(text, '    read_only: true\n', '    read_only: true\n    volumes: ["state:/data"]\n'), /no volume/],
    ['a named volume at the top', `${text}volumes:\n  state: {}\n`, /no volume/],
    ['the image by tag', srvReplace(text, '@sha256:<digest>', ':latest'), /image must be/],
    ['the image of another repository', srvReplace(text, '/mock-systems@sha256', '/agent-history@sha256'), /image must be/],
    ['a digest that is too short', srvReplace(text, '<digest>', 'abc123'), /image must be/],
    ['no read-only file system', srvReplace(text, '    read_only: true\n', ''), /read_only must be true/],
    ['a writable file system', srvReplace(text, 'read_only: true', 'read_only: false'), /read_only must be true/],
    ['capabilities kept', srvReplace(text, 'cap_drop: [ALL]', 'cap_drop: [NET_RAW]'), /cap_drop must be/],
    ['a capability added', srvReplace(text, '    read_only: true\n', '    read_only: true\n    cap_add: [NET_ADMIN]\n'), /cap_add is not allowed/],
    ['new privileges allowed', srvReplace(text, '    security_opt: ["no-new-privileges:true"]\n', ''), /no-new-privileges/],
    ['a privileged container', srvReplace(text, '    read_only: true\n', '    read_only: true\n    privileged: true\n'), /privileged is not allowed/],
    ['a second tmpfs', srvReplace(text, 'tmpfs: ["/tmp:size=64m"]', 'tmpfs: ["/tmp:size=64m", "/var/tmp"]'), /tmpfs must be/],
    ['no tmpfs', srvReplace(text, '    tmpfs: ["/tmp:size=64m"]\n', ''), /tmpfs must be/],
    ['a key variable', srvReplace(text, 'HOST: "0.0.0.0" }', 'HOST: "0.0.0.0", SUPPLIER_PRIV_KEY_HEX: "" }'), /no key and no wallet/],
    ['a wallet variable', srvReplace(text, 'HOST: "0.0.0.0" }', 'HOST: "0.0.0.0", BUYER_WALLET: "" }'), /no key and no wallet/],
    ['another setting in the compose file', srvReplace(text, 'HOST: "0.0.0.0" }', 'HOST: "0.0.0.0", MOCK_PUBLIC_BASE: "https://mock.example.test" }'), /nothing else/],
    ['a port that the mapping does not publish', srvReplace(text, 'PORT: "9120"', 'PORT: "9121"'), /environment must be PORT/],
    ['the loopback address inside the container', srvReplace(text, 'HOST: "0.0.0.0"', 'HOST: "127.0.0.1"'), /environment must be PORT/],
    ['restart always', srvReplace(text, 'restart: unless-stopped', 'restart: always'), /restart must be/],
    ['an env file that is not required', srvReplace(text, 'required: true', 'required: false'), /env_file must be/],
    ['no memory limit', srvReplace(text, '    mem_limit: 2048m\n', ''), /mem_limit must be set/],
    ['a limit under a full store', srvReplace(text, 'mem_limit: 2048m', 'mem_limit: 1024m'), /too small/],
    ['a limit above the plan', srvReplace(text, 'mem_limit: 2048m', 'mem_limit: 8192m'), /3 GiB/],
    ['no log limit', srvReplace(text, 'max-size: "10m"', 'max-size: "1g"'), /logging must be/],
    ['a second service', `${text}  other:\n    image: example\n`, /one service/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = mockComposeProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the image with a digest, a higher limit that the plan still holds, and a store that the limit fits or does not fit.
  assert.deepEqual(mockComposeProblems(srvReplace(text, '@sha256:<digest>', `@sha256:${'ab'.repeat(32)}`)), [], 'the image with a digest of 64 hex digits');
  assert.deepEqual(mockComposeProblems(srvReplace(text, 'mem_limit: 2048m', 'mem_limit: 3072m')), [], 'a limit of 3 GiB');
  assert.deepEqual(mockComposeProblems(text, 1_000_000_000), [], 'a store of 1 GB fits under half of 2 GiB');
  assert.ok(mockComposeProblems(text, 1_100_000_000).some((p) => /too small/.test(p)), 'a store of 1.1 GB does not');
  // The limit follows the limits of the service: the guard reads them from the source of the store.
  assert.ok(mockConstant('MAX_TENANTS') > 0 && mockConstant('MAX_LOG_LINES') > 0, 'the guard finds MAX_TENANTS and MAX_LOG_LINES');
});

test('mock service compose in docker compose config: it renders with its env file, the rendered service has the loopback port, the limit and the hardening and no volume, the compose file wins over PORT and HOST of the env file, and compose stops while the env file is missing', { skip: HAVE_COMPOSE ? false : 'needs docker compose' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mock-compose-'));
  // A COMPOSE_ variable of the shell (the project name, the file) would change what compose renders, so the runs here have none.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COMPOSE_')));
  const config = () => spawnSync('docker', ['compose', '-f', MOCK.composeFile, 'config'], { cwd: dir, env, encoding: 'utf8', timeout: 120_000 });
  try {
    copyFileSync(join(root, SRV, MOCK.composeFile), join(dir, MOCK.composeFile));
    const missing = config();
    assert.notEqual(missing.status, 0, 'compose stops while the env file is missing');
    assert.ok(missing.stderr.includes(MOCK.envFile), `and names the file: ${missing.stderr}`);
    copyFileSync(join(root, SRV, MOCK.exampleFile), join(dir, MOCK.envFile));
    const run = config();
    assert.equal(run.status, 0, run.stderr);
    const model = parseYaml(run.stdout);
    assert.equal(model.name, MOCK.name);
    assert.deepEqual(Object.keys(model.services), [MOCK.name]);
    const s = model.services[MOCK.name];
    assert.equal(s.image, `${MOCK.image}@sha256:<digest>`);
    assert.equal(s.container_name, MOCK.name);
    assert.equal(s.restart, 'unless-stopped');
    assert.deepEqual(s.ports, [{ mode: 'ingress', host_ip: '127.0.0.1', target: MOCK.port, published: String(MOCK.port), protocol: 'tcp' }]);
    assert.equal(s.mem_limit, String(mockBytes(/^ {4}mem_limit: (\S+)$/m.exec(mockComposeText)[1])));
    assert.equal(s.read_only, true);
    assert.deepEqual(s.cap_drop, ['ALL']);
    assert.deepEqual(s.security_opt, ['no-new-privileges:true']);
    assert.deepEqual(s.tmpfs, ['/tmp:size=64m']);
    assert.equal(s.volumes, undefined, 'no volume');
    assert.equal(model.volumes, undefined, 'no volume at the top');
    assert.ok(Object.values(model.networks ?? {}).every((network) => !network.external), 'no external network: Caddy reaches the service by the published port');
    // The env file is read: every name of the example is in the environment of the service.
    assert.deepEqual(Object.keys(s.environment).sort(), Object.keys(mockExample).sort());
    // The values that the port mapping needs are the compose file's. A line in the env file does not change them.
    writeFileSync(join(dir, MOCK.envFile), mockExampleText.replace('PORT=9120\n', 'PORT=9999\n').replace('HOST=0.0.0.0\n', 'HOST=127.0.0.1\n'));
    const overridden = config();
    assert.equal(overridden.status, 0, overridden.stderr);
    const environment = parseYaml(overridden.stdout).services[MOCK.name].environment;
    assert.deepEqual([environment.PORT, environment.HOST], [String(MOCK.port), '0.0.0.0']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The faults of the env example. The names that config.ts reads and the names of the example must be the same list.
const mockReadNames = [...envNamesIn(mockConfigSource)].sort();
const MOCK_FIXED = { PORT: String(MOCK.port), HOST: '0.0.0.0' };
const MOCK_URL_SETTINGS = { IDENTITY_GATEWAY_URL: 'GATEWAY_DEFAULT', VECTOR_OGMIOS_URL: 'OGMIOS_DEFAULT', VECTOR_KOIOS_URL: 'KOIOS_DEFAULT' };
function mockExampleProblems(text, readNames = mockReadNames) {
  let env;
  try { env = parseEnv(text); } catch (error) { return [`the example does not parse: ${error.message}`]; }
  const problems = [];
  for (const name of readNames) if (!(name in env)) problems.push(`${name} is read by config.ts and has no line in the example`);
  for (const name of Object.keys(env)) if (!readNames.includes(name)) problems.push(`${name} is in the example, and config.ts does not read it`);
  for (const [name, value] of Object.entries(env)) {
    if (!(value === '' || PLACEHOLDER.test(value) || value === MOCK_FIXED[name])) problems.push(`${name} must be empty or a placeholder in angle brackets${name in MOCK_FIXED ? ` or ${MOCK_FIXED[name]}` : ''}; found: ${value}`);
  }
  problems.push(...keyProblems(env));
  if (env.MOCK_OPERATOR_TOKEN !== '') problems.push('MOCK_OPERATOR_TOKEN must be empty: the service stops at start without it');
  const keyNames = Object.keys(env).filter((name) => MOCK_KEYLIKE.test(name));
  if (keyNames.length > 0) problems.push(`the service holds no key and no wallet, and the example names: ${keyNames.join(', ')}`);
  if (/\b[0-9a-f]{56,}\b/i.test(text)) problems.push('a run of 56 or more hex characters looks like key material or a published value; the example holds placeholders only');
  if (/addr1[0-9a-z]{20,}|ed25519_sk/i.test(text)) problems.push('an address or a signing key; the example holds placeholders only');
  for (const [name, constant] of Object.entries(MOCK_URL_SETTINGS)) {
    if (env[name] !== '') problems.push(`${name} must be empty, so that the default of the code applies`);
    if (!text.includes(`Default: ${mockDefault(constant)}`)) problems.push(`the comment of ${name} must give the default of the code: ${mockDefault(constant)}`);
  }
  if (env.PORT !== String(mockNumber(mockConfigSource, 'PORT_DEFAULT'))) problems.push(`PORT must be ${mockNumber(mockConfigSource, 'PORT_DEFAULT')}, the port that the compose file publishes`);
  if (env.HOST !== '0.0.0.0') problems.push('HOST must be 0.0.0.0: the published port reaches nothing when the service listens on the loopback address of the container');
  if (!/mode 600/.test(text)) problems.push('the example must say that the copy has mode 600');
  return problems;
}

test('mock service env example: each variable that config.ts reads has a line, each line is read by config.ts, the values are placeholders and empty lines, and no key, wallet or published value is in it; the guard refuses each copy that breaks one of these', () => {
  const listed = [...(/export const SETTINGS = \[([\s\S]*?)\] as const;/.exec(mockConfigSource)?.[1] ?? '').matchAll(/'([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, mockReadNames, 'the list SETTINGS of config.ts names the variables that config.ts reads');
  assert.ok(mockReadNames.length >= 11 && mockReadNames.includes('MOCK_OPERATOR_TOKEN') && mockReadNames.includes('PORT'), 'the guard finds the settings');
  assert.deepEqual(mockExampleProblems(mockExampleText), [], 'the real file passes');
  assert.deepEqual(Object.keys(mockExample).sort(), mockReadNames, 'both directions: the names of the example are the names that config.ts reads');
  assert.equal(mockNumber(mockConfigSource, 'PORT_DEFAULT'), MOCK.port, 'the default port of the code is the port of the compose file');
  // The compose file and the example give the same two values for the port mapping.
  const mockEnvOfCompose = parseYaml(mockComposeText).services[MOCK.name].environment;
  assert.deepEqual([mockEnvOfCompose.PORT, mockEnvOfCompose.HOST], [mockExample.PORT, mockExample.HOST]);
  const text = mockExampleText;
  const faults = [
    ['a variable that config.ts does not read', `${text}MOCK_DEBUG=1\n`, /MOCK_DEBUG is in the example/],
    ['a setting that has no line', srvReplace(text, 'HOST=0.0.0.0\n', ''), /HOST is read by config\.ts and has no line/],
    ['a host that is not a placeholder', srvReplace(text, 'MOCK_PUBLIC_BASE=<https origin of the mock host>', 'MOCK_PUBLIC_BASE=https://mock.example.test'), /MOCK_PUBLIC_BASE must be empty or a placeholder/],
    ['the operator token written in', srvReplace(text, 'MOCK_OPERATOR_TOKEN=\n', `MOCK_OPERATOR_TOKEN=${'Ab1'.repeat(16)}\n`), /MOCK_OPERATOR_TOKEN must be empty/],
    ['the published root written in', srvReplace(text, 'VECTOR_IDENTITY_LEGACY_ROOT=<64 hex characters>', `VECTOR_IDENTITY_LEGACY_ROOT=${IDENTITY_MAINNET.VECTOR_IDENTITY_LEGACY_ROOT}`), /looks like key material/],
    ['a key variable', `${text}SUPPLIER_PRIV_KEY_HEX=\n`, /holds no key and no wallet/],
    ['a wallet variable', `${text}BUYER_WALLET=\n`, /holds no key and no wallet/],
    ['a key in a comment', `${text}# ${'ab'.repeat(32)}\n`, /run of 56 or more hex/],
    ['an address in a comment', `${text}# addr1${'q'.repeat(30)}\n`, /an address or a signing key/],
    ['a gateway that is not empty', srvReplace(text, 'IDENTITY_GATEWAY_URL=\n', 'IDENTITY_GATEWAY_URL=https://id.example.test\n'), /IDENTITY_GATEWAY_URL must be empty/],
    ['a default that the comment gets wrong', srvReplace(text, 'Default: https://id.vector.apexfusion.org', 'Default: https://id.old.example.test'), /must give the default of the code/],
    ['a port that the compose file does not publish', srvReplace(text, 'PORT=9120\n', 'PORT=9121\n'), /PORT must be 9120/],
    ['the loopback address inside the container', srvReplace(text, 'HOST=0.0.0.0\n', 'HOST=127.0.0.1\n'), /HOST must be 0\.0\.0\.0/],
    ['no word about the mode of the copy', srvReplace(text, 'The copy has mode 600 on the host.', 'The copy is private.'), /mode 600/],
    ['a line that is not NAME=value', `${text}MOCK TOKEN\n`, /does not parse/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = mockExampleProblems(broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
});

// The settings of the service, read by loadConfig of the real code (tsx). Each case is an environment; the answer is the config or the error.
const MOCK_CONFIG_CODE = "import { loadConfig } from './src/config.ts'; " +
  "console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => { try { const c = loadConfig(env); return { ok: true, port: c.port, host: c.host, gatewayUrl: c.gatewayUrl, ogmiosUrl: c.ogmiosUrl, koiosUrl: c.koiosUrl, publicBase: c.publicBase, mtlsBase: c.mtlsBase }; } " +
  "catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; } })));";

test('mock service env example, filled: with sample values the example passes loadConfig of the service, the empty lines take the defaults of the code, and each line that is left as the example has it is refused by the name of its variable', () => {
  const sample = {
    MOCK_OPERATOR_TOKEN: 'Zk3'.repeat(16), MOCK_PUBLIC_BASE: 'https://mock.example.test', MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
    VECTOR_IDENTITY_LEGACY_ROOT: IDENTITY_MAINNET.VECTOR_IDENTITY_LEGACY_ROOT, VECTOR_IDENTITY_CONFIG_SEED: IDENTITY_MAINNET.VECTOR_IDENTITY_CONFIG_SEED, VECTOR_IDENTITY_POLICY_ID: IDENTITY_MAINNET.IDENTITY_POLICY_ID,
  };
  const pick = (...names) => Object.fromEntries(names.map((name) => [name, sample[name]]));
  // [name, the lines that the operator filled, the error that names the variable, or null for a start that works]
  const cases = [
    ['the example as it is copied', {}, /MOCK_OPERATOR_TOKEN is required/],
    ['the token made', pick('MOCK_OPERATOR_TOKEN'), /MOCK_PUBLIC_BASE must be an https origin/],
    ['the first host filled', pick('MOCK_OPERATOR_TOKEN', 'MOCK_PUBLIC_BASE'), /MOCK_MTLS_BASE must be an https origin/],
    ['the token and the two hosts', pick('MOCK_OPERATOR_TOKEN', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE'), /VECTOR_IDENTITY_LEGACY_ROOT must be 64 hex characters/],
    ['the two hosts the same', { ...sample, MOCK_MTLS_BASE: sample.MOCK_PUBLIC_BASE }, /MOCK_MTLS_BASE must name another host/],
    ['a policy that the two values do not give', { ...sample, VECTOR_IDENTITY_POLICY_ID: '0'.repeat(56) }, /VECTOR_IDENTITY_POLICY_ID is/],
    ['a token of 31 characters', { ...sample, MOCK_OPERATOR_TOKEN: 'a'.repeat(31) }, /MOCK_OPERATOR_TOKEN must have 32 to 128 characters/],
    ['a token with a space', { ...sample, MOCK_OPERATOR_TOKEN: 'a b'.repeat(16) }, /MOCK_OPERATOR_TOKEN must have 32 to 128 characters/],
    ['everything filled', sample, null],
    ['a token of 32 characters', { ...sample, MOCK_OPERATOR_TOKEN: 'a'.repeat(32) }, null],
    ['a token of 128 characters with every sign that is allowed', { ...sample, MOCK_OPERATOR_TOKEN: `${'a.b_c~d+e/f=g-'.repeat(9)}abcdefghijklm`.slice(0, 128) }, null],
  ];
  const answers = inMockService(MOCK_CONFIG_CODE, cases.map(([, filled]) => ({ ...mockExample, ...filled })));
  cases.forEach(([name, , expected], i) => {
    const answer = answers[i];
    if (expected === null) {
      assert.equal(answer.ok, true, `${name}: ${answer.message}`);
      assert.deepEqual([answer.port, answer.host], [MOCK.port, '0.0.0.0'], `${name}: the port and the address of the container`);
      assert.deepEqual([answer.gatewayUrl, answer.ogmiosUrl, answer.koiosUrl], ['GATEWAY_DEFAULT', 'OGMIOS_DEFAULT', 'KOIOS_DEFAULT'].map(mockDefault), `${name}: the empty lines take the defaults of the code`);
      assert.deepEqual([answer.publicBase, answer.mtlsBase], [sample.MOCK_PUBLIC_BASE, sample.MOCK_MTLS_BASE], name);
    } else {
      assert.equal(answer.ok, false, `${name}: the start must be refused`);
      assert.match(answer.message, expected, name);
      assert.equal(answer.message.includes(sample.MOCK_OPERATOR_TOKEN) || answer.message.includes('a'.repeat(31)), false, `${name}: the error never shows the token`);
    }
  });
});

// The one command of the example that makes the token. It is a comment line with three spaces after the hash.
const mockTokenCommand = /^#   (sed -i .*)$/m.exec(mockExampleText)?.[1];
const mockTokenForm = new RegExp(/const TOKEN_FORM = \/(.+)\/;/.exec(mockConfigSource)?.[1] ?? '$^');

test('mock service operator token: the command of the example writes a token that the service takes into its own line and nothing else, prints nothing, makes a new token each time, and the runbook gives the same command', NEEDS_BASH, () => {
  assert.ok(mockTokenCommand, 'the example has the command');
  assert.ok(mockRunbook.includes(`\n   ${mockTokenCommand}\n`), 'the runbook has the same command, in step 3');
  // The form of the service, as extracted: a twin and a refused copy at each edge.
  for (const good of ['a'.repeat(32), 'a'.repeat(128), 'aZ09._~+/=-'.repeat(4)]) assert.match(good, mockTokenForm, good);
  for (const bad of ['', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(31)} `, `<${'a'.repeat(40)}>`, `${'a'.repeat(40)}!`]) assert.doesNotMatch(bad, mockTokenForm, JSON.stringify(bad));
  const dir = mkdtempSync(join(tmpdir(), 'mock-token-'));
  try {
    const run = () => {
      writeFileSync(join(dir, MOCK.envFile), mockExampleText);
      chmodSync(join(dir, MOCK.envFile), 0o600);
      const r = runBash(mockTokenCommand, dir);
      const text = readFileSync(join(dir, MOCK.envFile), 'utf8');
      return { r, text, token: parseEnv(text).MOCK_OPERATOR_TOKEN };
    };
    const [first, second] = [run(), run()];
    for (const { r, token } of [first, second]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout + r.stderr, '', 'the command prints nothing');
      assert.match(token, mockTokenForm, 'a token that the service takes');
      assert.equal(token.length, 48);
    }
    assert.notEqual(first.token, second.token, 'a new token each time');
    const others = (text) => text.split('\n').filter((line) => !line.startsWith('MOCK_OPERATOR_TOKEN=')).join('\n');
    assert.equal(others(first.text), others(mockExampleText), 'every other line is as the example has it');
    assert.equal(first.text.split('\n').filter((line) => line.startsWith('MOCK_OPERATOR_TOKEN=')).length, 1, 'one line of the token');
    assert.equal(statSync(join(dir, MOCK.envFile)).mode & 0o777, 0o600, 'the file keeps mode 600: the command edits it in place');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The code blocks of the runbook, with the indent of their list item taken off.
const mockBlocks = [...mockRunbook.matchAll(/^( *)```sh\n([\s\S]*?)\n\1```$/gm)].map((m) => m[2].split('\n').map((line) => (line.startsWith(m[1]) ? line.slice(m[1].length) : line)).join('\n'));
const mockBlock = (part) => {
  const found = mockBlocks.filter((block) => block.includes(part));
  assert.equal(found.length, 1, `one code block of the runbook has: ${part}`);
  return found[0];
};

test('mock service RUNBOOK step 4: the three checks run as written; a mode that is not 600, a placeholder that is left and a token of the wrong form are each shown, and the files that are right pass', SRV_NEEDS, () => {
  const block = mockBlock("stat -c '%a %U:%G %n' .env.mock-systems");
  const dir = mkdtempSync(join(tmpdir(), 'mock-step4-'));
  const fill = (values) => mockExampleText.split('\n').map((line) => { const m = /^([A-Z][A-Z0-9_]*)=/.exec(line); return m && m[1] in values ? `${m[1]}=${values[m[1]]}` : line; }).join('\n');
  const filled = { MOCK_PUBLIC_BASE: 'https://mock.example.test', MOCK_MTLS_BASE: 'https://mock-mtls.example.test', VECTOR_IDENTITY_LEGACY_ROOT: 'a'.repeat(64), VECTOR_IDENTITY_CONFIG_SEED: `${'b'.repeat(64)}#0`, VECTOR_IDENTITY_POLICY_ID: 'c'.repeat(56) };
  const check = (text, mode = 0o600) => {
    writeFileSync(join(dir, MOCK.envFile), text);
    chmodSync(join(dir, MOCK.envFile), mode);
    const r = runBash(block, dir);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trimEnd().split('\n');
  };
  try {
    const placeholders = ['MOCK_PUBLIC_BASE=<https origin of the mock host>', 'MOCK_MTLS_BASE=<https origin of the mock mtls host>', 'VECTOR_IDENTITY_LEGACY_ROOT=<64 hex characters>', 'VECTOR_IDENTITY_CONFIG_SEED=<txid>#<index>', 'VECTOR_IDENTITY_POLICY_ID=<56 hex characters>'];
    const wrong = 'the token is missing or has a wrong form';
    const good = 'ok: the token has the right form';
    // The example as it is copied: the mode is right, the five placeholders are shown, and the token is missing.
    const raw = check(mockExampleText);
    assert.match(raw[0], /^600 \S+:\S+ \.env\.mock-systems$/);
    assert.deepEqual(raw.slice(1), [...placeholders, wrong]);
    // The file that is filled: nothing is left, and each token that the form allows passes.
    for (const token of ['a'.repeat(32), 'a'.repeat(128), 'aZ09._~+/=-'.repeat(4), 'Zk3'.repeat(16)]) {
      assert.deepEqual(check(fill({ ...filled, MOCK_OPERATOR_TOKEN: token })).slice(1), ['ok: no placeholder is left', good], token);
    }
    // Each token that the form refuses is shown.
    for (const token of ['', 'a'.repeat(31), 'a'.repeat(129), `${'a'.repeat(40)} ${'b'.repeat(5)}`, `<${'a'.repeat(40)}>`, `${'a'.repeat(40)}!`]) {
      assert.deepEqual(check(fill({ ...filled, MOCK_OPERATOR_TOKEN: token })).slice(1), ['ok: no placeholder is left', wrong], JSON.stringify(token));
    }
    // One placeholder that is left is shown, and only that one.
    assert.deepEqual(check(fill({ ...filled, MOCK_OPERATOR_TOKEN: 'a'.repeat(40), VECTOR_IDENTITY_POLICY_ID: '<56 hex characters>' })).slice(1), ['VECTOR_IDENTITY_POLICY_ID=<56 hex characters>', good]);
    // The mode: 644 is shown as it is, so that the operator sees it.
    assert.match(check(fill({ ...filled, MOCK_OPERATOR_TOKEN: 'a'.repeat(40) }), 0o644)[0], /^644 /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MOCK_DOCKER_STUB = String.raw`#!/bin/bash
printf '%s\n' "$*" >> "$STUB_OUT/docker-calls"
if [ "$1 $2" = 'image inspect' ]; then
  [ -n "$STUB_DIGEST" ] || exit 1
  printf 'ghcr.io/apex-fusion/vector-service-agents/mock-systems@sha256:%s\n' "$STUB_DIGEST"
fi
`;

test('mock service RUNBOOK step 5: the commands run as written against a stand-in for docker; the digest goes into the image line, an old digest is replaced, the rest of the file stays, and a failed pull changes nothing', NEEDS_BASH, () => {
  const block = mockBlock('IMAGE=ghcr.io/apex-fusion/vector-service-agents/mock-systems');
  const dir = mkdtempSync(join(tmpdir(), 'mock-step5-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'docker'), MOCK_DOCKER_STUB, { mode: 0o755 });
    const composePath = join(dir, MOCK.composeFile);
    writeFileSync(composePath, mockComposeText);
    const [one, two] = ['1234abcd'.repeat(8), 'fedcba98'.repeat(8)];
    // The last command of the block is the grep that shows the image line: it exits 1 when it shows nothing, and that is the signal of the runbook.
    const run = (digest, status) => {
      rmSync(join(dir, 'docker-calls'), { force: true });
      const r = runBash(`export PATH="${join(dir, 'bin')}:$PATH" STUB_OUT="${dir}" STUB_DIGEST="${digest}"\n${block}\n`, dir);
      assert.equal(r.status, status, r.stderr);
      return { stdout: r.stdout, text: readFileSync(composePath, 'utf8'), calls: existsSync(join(dir, 'docker-calls')) ? readFileSync(join(dir, 'docker-calls'), 'utf8').trimEnd().split('\n') : [] };
    };
    const imageLine = (digest) => `    image: ${MOCK.image}@sha256:${digest}`;
    // The file as shipped: the placeholder. A failed pull leaves it, and the check prints nothing and the runbook says so.
    const failed = run('', 1);
    assert.equal(failed.text, mockComposeText, 'no digest: the file is not changed');
    assert.match(failed.stdout, /^no digest: the compose file is not changed\n$/, 'and the check prints no image line');
    // The first pin.
    const pinned = run(one, 0);
    assert.equal(pinned.stdout, `${imageLine(one)}\n`);
    assert.equal(pinned.text, srvReplace(mockComposeText, '@sha256:<digest>', `@sha256:${one}`), 'only the image line changed');
    assert.deepEqual(pinned.calls, [`pull ${MOCK.image}:<full git commit sha>`, `image inspect --format {{index .RepoDigests 0}} ${MOCK.image}:<full git commit sha>`]);
    assert.deepEqual(mockComposeProblems(pinned.text), [], 'the pinned file passes the guard of the compose file');
    // An upgrade: the old digest is replaced, and a failed pull then leaves the digest that runs.
    const upgraded = run(two, 0);
    assert.equal(upgraded.stdout, `${imageLine(two)}\n`);
    assert.equal(upgraded.text, srvReplace(mockComposeText, '@sha256:<digest>', `@sha256:${two}`));
    const kept = run('', 0);
    assert.equal(kept.text, upgraded.text, 'a failed pull keeps the digest that runs');
    assert.match(kept.stdout, /^no digest: the compose file is not changed\n.*@sha256:fedcba98/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MOCK_CURL_STUB = String.raw`#!/bin/bash
: > "$STUB_OUT/args"
: > "$STUB_OUT/header-file"
for a in "$@"; do
  printf '%s\n' "$a" >> "$STUB_OUT/args"
  case "$a" in @*) cat "$(printf '%s' "$a" | cut -c2-)" >> "$STUB_OUT/header-file" ;; esac
done
printf '{"stub":true}'
`;
// The app of the service on a loopback port, with the host names of the example. The requests go to it with the Host header of the mock host. The identity and the approval
// check are never reached: the tenant call and the two reads need no credential of an agent.
const MOCK_REPLAY_CODE = `
import { createServer, request } from 'node:http';
import { createApp } from './src/app.ts';
const spec = JSON.parse(process.argv[1]);
const app = createApp({ config: { publicBase: 'https://' + spec.publicHost, publicHost: spec.publicHost, mtlsHost: spec.mtlsHost, operatorToken: spec.token }, identity: {}, approvalCheck: async () => ({ ok: true }), now: () => 1700000000000, writeLog: () => {} });
const server = createServer((req, res) => { void app.handle(req, res); });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const send = ({ method, path, headers = {}, body }) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { host: spec.publicHost, ...headers } }, (res) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
  });
  req.on('error', reject);
  req.end(body);
});
const answers = [];
for (const one of spec.requests) answers.push(await send(one));
console.log(JSON.stringify(answers));
process.exit(0);
`;

test('mock service RUNBOOK, the tenant call: run as written with a stand-in for curl it keeps the token out of the arguments and sends it in a header, with the body and the type that the service takes; the real service makes the tenant (201), makes it again (200), and refuses a wrong token, another type and a mistyped field', NEEDS_BASH, () => {
  const block = mockBlock('/admin/tenants');
  const token = 'Qx7'.repeat(16);
  const dir = mkdtempSync(join(tmpdir(), 'mock-tenant-call-'));
  try {
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'curl'), MOCK_CURL_STUB, { mode: 0o755 });
    writeFileSync(join(dir, MOCK.envFile), srvReplace(mockExampleText, 'MOCK_OPERATOR_TOKEN=\n', `MOCK_OPERATOR_TOKEN=${token}\n`));
    const r = runBash(`export PATH="${join(dir, 'bin')}:$PATH" STUB_OUT="${dir}"\n${srvReplace(srvReplace(block, 'cd /srv/agents/mock-systems', `cd "${dir}"`), '<mock host>', 'mock.example.test')}\n`, dir);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{"stub":true}', 'the answer of the call is printed as it is');
    const argsText = readFileSync(join(dir, 'args'), 'utf8');
    const args = argsText.trimEnd().split('\n');
    assert.equal(argsText.includes(token), false, 'the token is in no argument of the program, so ps does not show it');
    assert.ok(args.some((a) => /^@\/dev\/fd\/\d+$/.test(a)), 'the header comes from a file that holds no copy on the disk');
    assert.equal(readFileSync(join(dir, 'header-file'), 'utf8'), `Authorization: Bearer ${token}\n`, 'the header of the token');
    assert.ok(args.includes('Content-Type: application/json'));
    assert.equal(args.at(-1), 'https://mock.example.test/admin/tenants', 'the operator puts the name of the mock host in place of <mock host>');
    const body = JSON.parse(args[args.indexOf('--data') + 1]);
    assert.deepEqual(Object.keys(body).sort(), ['organisations', 'tenant']);
    // The service takes it. The same text, the same header and the same type go to the real code.
    const authorization = `Bearer ${token}`;
    const call = (overrides = {}) => ({ method: 'POST', path: '/admin/tenants', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body), ...overrides });
    const answers = inMockService(MOCK_REPLAY_CODE, {
      publicHost: 'mock.example.test', mtlsHost: 'mock-mtls.example.test', token,
      requests: [
        call(), call(),
        { method: 'GET', path: `/t/${body.tenant}/state` }, { method: 'GET', path: `/t/${body.tenant}/log` },
        call({ headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' } }),
        call({ headers: { authorization } }),
        call({ body: JSON.stringify({ tenant: body.tenant, organizations: body.organisations }) }),
        call({ body: JSON.stringify({ tenant: body.tenant.toUpperCase(), organisations: body.organisations }) }),
      ],
    });
    assert.deepEqual(answers.map((a) => a.status), [201, 200, 200, 200, 401, 415, 400, 400], 'new, again, the state, the log, and the four refusals');
    const [made, again, state, log] = answers.slice(0, 4).map((a) => JSON.parse(a.body));
    assert.deepEqual([made.created, again.created], [true, false]);
    assert.equal(made.base, `https://mock.example.test/t/${body.tenant}`);
    assert.deepEqual(Object.keys(made.resources).sort(), ['erp', 'guidelines', 'po', 'records', 'sourcing', 'vendors']);
    assert.equal(made.audiences.insurer, `https://mock.example.test/t/${body.tenant}/insurer`);
    assert.deepEqual([state.tenant, log.tenant, log.dropped, log.lines], [body.tenant, body.tenant, 0, []], 'the two reads need no credential, and a tenant that was made again has an empty log');
    assert.deepEqual(JSON.parse(answers[4].body).error, 'operator_token_invalid');
    assert.deepEqual(JSON.parse(answers[5].body).error, 'unsupported_media_type');
    assert.deepEqual(answers.slice(6).map((a) => JSON.parse(a.body).error), ['bad_request', 'bad_request']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mock service README and RUNBOOK: the two files, the health check, the tenant call, the loss at a restart and the mode 600 are written down, the sections stand in step 6, the failure rows give the codes and the statuses of the service, and every compose command names the one file', () => {
  const errors = read('services/mock-systems/src/errors.ts');
  const start = read('services/mock-systems/src/start.ts');
  // README: the two files, the folder, the limit, the port and the loss.
  for (const row of [`| \`${MOCK.composeFile}\` | `, `| \`${MOCK.exampleFile}\` | `, '| `/srv/agents/mock-systems` | `agents`, 750 | The folder of the mock service: its compose file and its env file. |']) assert.ok(mockReadme.includes(row), row);
  assert.ok(mockReadme.includes('\n## The mock service\n'));
  const gib = mockBytes(/^ {4}mem_limit: (\S+)$/m.exec(mockComposeText)[1]) / 1024 ** 3;
  assert.ok(mockReadme.includes(`its limit is ${gib} GiB`) && mockReadme.includes(`| Memory limit | ${gib} GiB.`), 'the README gives the limit of the compose file');
  assert.ok(mockReadme.includes(`| Port | \`127.0.0.1:${MOCK.port}\` on the host, and \`0.0.0.0:${MOCK.port}\` inside the container.`));
  assert.ok(mockReadme.includes('A restart of the mock service, or a reboot of the host, loses every tenant and its log.'));
  assert.ok(mockReadme.includes('The operator puts the same two names, as https origins, in the env file of the mock service'));
  assert.ok(mockReadme.includes('| Reads | The identity gateway, and the node and the indexer of the Vector ledger. The checks of a token and of an approval use them. The start needs none of them.'));
  // RUNBOOK: the sections stand in step 6, in this order, and the headings of the file are the ones of the test above.
  const step6 = section(mockRunbook, '6. Install the snippet of the mock systems');
  assert.deepEqual([...step6.matchAll(/^### (.+)$/gm)].map((m) => m[1]), ['Run the mock service', 'Make or reset a tenant', 'Read the state and the log of a tenant', 'What a restart loses, upgrade and stop']);
  for (const part of [
    MOCK.composeFile, MOCK.exampleFile, MOCK.envFile, '/srv/agents/mock-systems', 'with mode 600',
    `curl -fsS http://127.0.0.1:${MOCK.port}/healthz`, "docker ps --filter name='^mock-systems$' --format '{{.Names}} {{.Status}} {{.Ports}}'", 'curl -sS -w \'\\n%{http_code}\\n\' https://<mock host>/t/none/state',
    'https://<mock host>/admin/tenants', 'Authorization: Bearer', '"organisations"', 'docker logs --tail 20 mock-systems', 'https://<mock host>/t/demo-1/state', 'https://<mock host>/t/demo-1/log',
    'The service keeps every tenant and its log in memory. A restart loses all of them.', 'After a restart, make each tenant again with the call above.',
    'The mock service holds no job, so this check does not cover it.', 'The mock service starts again with no tenant: make each tenant again',
  ]) assert.ok(mockRunbook.includes(part), `the runbook says: ${part}`);
  // The failure table: the two rows of before stay (the first one tells the 421 of Caddy from the 421 of the service), and the rows of the service give the status and the code that the service answers with.
  const table = section(mockRunbook, 'The failure table');
  for (const row of ['| A request to the mock host gets `421`, and the body has no `wrong_host` | The TLS name and the Host header differ.', '| The mock service sees no `Client-Cert` header | The client sent no certificate']) assert.ok(table.includes(row), row);
  const rows = [
    ['| The mock container starts again and again (`docker ps` says `Restarting`) |', ['the error names the variable']],
    ['| A call to `POST /t/<tenant>/sourcing/rankings` gets `503`, and the body has `approval_unavailable` |', ['`approval.failed`', '`VECTOR_OGMIOS_URL`', '`VECTOR_KOIOS_URL`', 'The service wrote nothing.']],
    ['| A call gets `421`, and the JSON body has `wrong_host` |', ['`<mock host>`', '`<mock mtls host>`']],
    ['| A call gets `400`, and the body has `client_certificate_unexpected` |', ['`request_header -Client-Cert`']],
    ['| A call to a tenant gets `404`, and the body has `tenant_not_found` |', ['Make the tenant']],
    ['| `POST /admin/tenants` gets `401`, and the body has `operator_token_invalid` |', ['Send the token of the env file']],
  ];
  for (const [start6, parts] of rows) {
    const row = table.split('\n').find((line) => line.startsWith(start6));
    assert.ok(row, `a row of the failure table starts with: ${start6}`);
    assert.equal(row.split(/(?<!\\)\|/).length, 5, `three cells: ${start6}`);
    for (const part of parts) assert.ok(row.includes(part), `${start6} has: ${part}`);
  }
  for (const [code, status] of [['wrong_host', 421], ['client_certificate_unexpected', 400], ['tenant_not_found', 404], ['operator_token_invalid', 401], ['approval_unavailable', 503]]) {
    assert.ok(errors.includes(`${code}: ${status},`), `the service answers ${code} with ${status}`);
    assert.ok(table.includes(`\`${status}\``) && table.includes(`\`${code}\``), `the failure table has ${status} and ${code}`);
  }
  // The start wires the approval check of the use-case kit, so no image comes without one: the failure table has no row for it.
  const wiring = read('services/mock-systems/src/wiring.ts');
  assert.ok(wiring.includes("from '@vsa/usecase-kit/checks'") && start.includes("import { wireApprovalCheck } from './wiring.ts'"), 'the start of the service wires the approval check of the use-case kit');
  assert.ok(!mockRunbook.includes('not wired in this build'), 'the runbook has no row for an image with no approval check');
  // The compose commands of the steps: the one file, and only up -d, up -d --force-recreate and down. No restart command and no -v.
  const mine = mockBlocks.filter((block) => block.includes('docker-compose.mock-systems.yml')).join('\n');
  const commands = [...mine.matchAll(/docker compose ([^\n]*)/g)].map((m) => m[1]);
  assert.deepEqual(commands, ['-f docker-compose.mock-systems.yml up -d', '-f docker-compose.mock-systems.yml up -d --force-recreate mock-systems', '-f docker-compose.mock-systems.yml down']);
});

test('mock service image, the health check: run as the Dockerfile writes it against a stand-in for the service, it passes on a 200 and fails on a 503 and on a port that nobody listens on', async () => {
  // The image has the one health check of the service. The compose file sets none, so docker ps shows the state that the image reports.
  assert.equal('healthcheck' in parseYaml(mockComposeText).services[MOCK.name], false, 'the compose file has no second health check');
  const line = read('services/mock-systems/Dockerfile').split('\n').find((text) => text.startsWith('HEALTHCHECK '));
  assert.ok(line, 'the Dockerfile has a HEALTHCHECK');
  const [program, flag, script] = JSON.parse(line.slice(line.indexOf(' CMD ') + 5));
  assert.deepEqual([program, flag], ['node', '-e']);
  assert.ok(script.includes(`http://127.0.0.1:${MOCK.port}/healthz`), 'the check calls GET /healthz on the port of the service');
  const run = async (port) => {
    try {
      await execFileAsync(process.execPath, ['-e', script.replace(`127.0.0.1:${MOCK.port}`, `127.0.0.1:${port}`)], { timeout: 30_000 });
      return 0;
    } catch (error) {
      return error.code;
    }
  };
  const serve = (status) => new Promise((resolve) => { const server = createStubServer((req, res) => { res.statusCode = status; res.end('{"ok":true}'); }); server.listen(0, '127.0.0.1', () => resolve(server)); });
  const [ok, unwell, gone] = [await serve(200), await serve(503), await serve(200)];
  const goneTo = gone.address().port;
  await new Promise((resolve) => gone.close(resolve));
  try {
    assert.equal(await run(ok.address().port), 0, 'a 200 is healthy');
    assert.equal(await run(unwell.address().port), 1, 'a 503 is not healthy');
    assert.equal(await run(goneTo), 1, 'a port with no service is not healthy');
  } finally {
    for (const server of [ok, unwell]) { server.closeAllConnections(); server.close(); }
  }
});

// ======================================================================================================================================
// The images that CI builds and pushes. One table lists the thirteen: the ten agents of this repository, the runtime of the agent template, the mock service and the operator pack. The build job
// builds each image and pushes nothing, so that an image that no longer builds fails the pull request, and the publish job pushes each one, in the same order. A compose file names each
// image by its digest, and the host builds none. The operator pack is the one image that no compose file names: the host runs it with docker run, by its digest. One runtime image serves
// every runtime of the agents host, and CI builds it from the agent template at one pinned commit. The compose files of the four agents on the present host build their runtime on the host
// from the same commit, and they keep doing so. These tests parse the workflow and the compose files. Each guard has an accepted twin and refused copies.
// ======================================================================================================================================
import { isDeepStrictEqual } from 'node:util';
const RT = {
  repository: 'Apex-Fusion/vector-agent-template', folder: 'runtime-template', dockerfile: 'runtime-template/agent/Dockerfile',
  image: 'ghcr.io/apex-fusion/vector-service-agents/agent-runtime', commitLabel: 'vector-agent-template.commit',
  sourceLabel: 'org.opencontainers.image.source=${{ github.server_url }}/${{ github.repository }}',
};
const IMAGE_REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const hostCompose = (name) => `deploy/host/docker-compose.${name}.yml`;
const serverCompose = (name) => `deploy/server/docker-compose.${name}.yml`;
// The compose files of a folder: the name starts with docker-compose, and it ends in .yml or .yaml. Each guard that reads the compose files of the two hosts takes them through these two functions.
const COMPOSE_FILE = /^docker-compose.*\.ya?ml$/;
const composeFilesOf = (dir, base = root) => readdirSync(join(base, dir)).filter((f) => COMPOSE_FILE.test(f)).sort();
const composeTextsOf = (dirs, base = root) => Object.fromEntries(dirs.flatMap((dir) => composeFilesOf(dir, base).map((f) => [`${dir}/${f}`, readFileSync(join(base, dir, f), 'utf8')])));
// One row for each image, in the order of both jobs. `context` is the build context. `label` is the name of the label line that the image has besides the source line, or null.
// `named` lists each service of a compose file that names the image: the file and the name of the service. The operator image has no compose file, so its list is empty, and it is the one row with an empty list.
const CI_IMAGES = [
  { file: 'agents/agent-history/Dockerfile', image: `${IMAGE_REPOSITORY}/agent-history`, context: '.', label: null, named: [[hostCompose('agent-history'), 'service']] },
  { file: 'agents/document-pipeline/Dockerfile', image: `${IMAGE_REPOSITORY}/document-pipeline`, context: '.', label: null, named: [[hostCompose('document-pipeline'), 'service']] },
  { file: 'agents/audio-snippets/Dockerfile', image: `${IMAGE_REPOSITORY}/audio-snippets`, context: '.', label: null, named: [[hostCompose('audio-snippets'), 'service']] },
  { file: 'agents/advocate/Dockerfile', image: `${IMAGE_REPOSITORY}/advocate`, context: '.', label: null, named: [[hostCompose('advocate'), 'service']] },
  { file: 'agents/reorder-agent/Dockerfile', image: `${IMAGE_REPOSITORY}/reorder-agent`, context: '.', label: null, named: [[serverCompose('reorder-agent'), 'service']] },
  { file: 'agents/order-desk/Dockerfile', image: `${IMAGE_REPOSITORY}/order-desk`, context: '.', label: null, named: [[serverCompose('order-desk'), 'service']] },
  { file: 'agents/prior-authorization-agent/Dockerfile', image: `${IMAGE_REPOSITORY}/prior-authorization-agent`, context: '.', label: null, named: [[serverCompose('prior-authorization-agent'), 'service']] },
  { file: 'agents/insurer-intake-agent/Dockerfile', image: `${IMAGE_REPOSITORY}/insurer-intake-agent`, context: '.', label: null, named: [[serverCompose('insurer-intake-agent'), 'service']] },
  { file: 'agents/bid-desk/Dockerfile', image: `${IMAGE_REPOSITORY}/bid-desk`, context: '.', label: null, named: [[serverCompose('bid-desk-alfa'), 'service'], [serverCompose('bid-desk-bravo'), 'service'], [serverCompose('bid-desk-charlie'), 'service']] },
  { file: 'agents/sourcing-agent/Dockerfile', image: `${IMAGE_REPOSITORY}/sourcing-agent`, context: '.', label: null, named: [[serverCompose('sourcing-agent'), 'service']] },
  {
    file: RT.dockerfile, image: RT.image, context: RT.folder, label: RT.commitLabel,
    named: [
      [serverCompose('reorder-agent'), 'runtime'], [serverCompose('order-desk'), 'runtime-small'], [serverCompose('order-desk'), 'runtime-medium'], [serverCompose('order-desk'), 'runtime-large'],
      [serverCompose('prior-authorization-agent'), 'runtime'], [serverCompose('insurer-intake-agent'), 'runtime'],
      [serverCompose('bid-desk-alfa'), 'runtime'], [serverCompose('bid-desk-bravo'), 'runtime'], [serverCompose('bid-desk-charlie'), 'runtime'],
      [serverCompose('sourcing-agent'), 'runtime'],
    ],
  },
  { file: 'services/mock-systems/Dockerfile', image: `${IMAGE_REPOSITORY}/mock-systems`, context: '.', label: null, named: [[serverCompose('mock-systems'), 'mock-systems']] },
  { file: 'scripts/operator/Dockerfile', image: `${IMAGE_REPOSITORY}/operator`, context: '.', label: null, named: [] },
];
const imageRow = (name) => CI_IMAGES.find((row) => row.image === `${IMAGE_REPOSITORY}/${name}`);
const MOCK_FILE = imageRow('mock-systems').file;
const OPERATOR_FILE = imageRow('operator').file;
const IMAGE_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen'];
const ciText = read('.github/workflows/ci.yml');
// The commit that the compose file of each agent on the present host builds the runtime from: the end of the build context of its service agent, after the #.
const rtPins = () => Object.fromEntries(composeFilesOf('deploy/host')
  .map((f) => [f, /^https:\/\/github\.com\/Apex-Fusion\/vector-agent-template\.git#([0-9a-f]{40})$/.exec(parseYaml(read(`deploy/host/${f}`)).services.agent.build.context)?.[1]]));
// A step with its tags and labels as lists of lines, so that a block of lines and a list compare equal.
const rtLines = (step) => ({ ...step, with: Object.fromEntries(Object.entries(step?.with ?? {}).map(([key, value]) => [key, ['tags', 'labels'].includes(key) && typeof value === 'string' ? value.trim().split('\n') : value])) });
// Change one place of a text: the n-th copy of a part, the first by default. Stop when the part is not there: a change that changes nothing proves nothing.
function rtChange(text, from, to, n = 0) {
  let at = -1;
  for (let i = 0; i <= n; i += 1) { at = text.indexOf(from, at + 1); assert.ok(at >= 0, `the text holds copy ${i} of: ${from}`); }
  return text.slice(0, at) + to + text.slice(at + from.length);
}

// The faults of the workflow for the table of the images and for the commits that the compose files name. An empty list is a pass.
function ciImageProblems(text, rows, pins) {
  let model;
  try { model = parseYaml(text); } catch (error) { return [`the workflow does not parse (a key twice is an error): ${error.message}`]; }
  const problems = [];
  const commit = Object.values(pins)[0];
  if (!/^[0-9a-f]{40}$/.test(commit) || Object.values(pins).some((c) => c !== commit)) problems.push(`the compose files must name one commit of 40 hex digits; found: ${JSON.stringify(pins)}`);
  const stepsOf = (job) => model?.jobs?.[job]?.steps ?? [];
  const builds = (job) => stepsOf(job).filter((s) => s?.uses === 'docker/build-push-action@v6');
  for (const job of ['build', 'publish']) {
    const steps = stepsOf(job);
    const push = job === 'publish';
    const login = steps.findIndex((s) => String(s?.uses).startsWith('docker/login-action'));
    if (!push && login >= 0) problems.push('build: the job must have no registry login');
    // The Dockerfiles of the table, in its order, and no other.
    const found = builds(job);
    if (!isDeepStrictEqual(found.map((s) => s?.with?.file), rows.map((row) => row.file))) problems.push(`${job}: the Dockerfiles must be the ${IMAGE_WORDS[rows.length]} of the table, in its order; found: ${JSON.stringify(found.map((s) => s?.with?.file))}`);
    // Each step is exactly the step of its row: the context, the file and the push, and in the publish job the two tags and the label lines. The first label line is the source line of
    // every image, and the runtime has the commit of the template as a second line.
    for (const row of rows) {
      const step = found.find((s) => s?.with?.file === row.file);
      if (step === undefined) continue; // the problem above says so
      const labels = [RT.sourceLabel, ...(row.label === null ? [] : [`${row.label}=${commit}`])];
      const expected = { uses: 'docker/build-push-action@v6', with: { context: row.context, file: row.file, push, ...(push && { tags: [`${row.image}:latest`, `${row.image}:\${{ github.sha }}`], labels }) } };
      if (!isDeepStrictEqual(rtLines(step), expected)) problems.push(`${job}: the step of ${row.file} must be exactly ${JSON.stringify(expected)}; found: ${JSON.stringify(step)}`);
      if (push && !(login >= 0 && login < steps.indexOf(step))) problems.push(`publish: the push of ${row.file} must come after the login`);
    }
    // The last step of each job builds the last image of the table.
    if (steps.at(-1)?.with?.file !== rows.at(-1).file) problems.push(`${job}: the last step must build ${rows.at(-1).file}`);
    // The runtime of the template: the checkout at the pinned commit, the check of that commit, and then the build.
    const at = steps.findIndex((s) => s?.with?.repository === RT.repository);
    if (at < 0) { problems.push(`${job}: no step checks out ${RT.repository}`); continue; }
    const ref = steps[at].with.ref;
    if (!isDeepStrictEqual(steps[at], { uses: 'actions/checkout@v4', with: { repository: RT.repository, ref, path: RT.folder, 'persist-credentials': false } })) problems.push(`${job}: the checkout must be actions/checkout@v4 with the repository, a ref, the path ${RT.folder} and persist-credentials false, and nothing else; found: ${JSON.stringify(steps[at])}`);
    if (!/^[0-9a-f]{40}$/.test(String(ref))) problems.push(`${job}: the ref must be a commit of 40 hex digits; found: ${ref}`);
    else if (ref !== commit) problems.push(`${job}: the ref ${ref} is not the commit ${commit} of the compose files`);
    const check = { run: `test "$(git -C ${RT.folder} rev-parse HEAD)" = ${commit}` };
    if (!isDeepStrictEqual(steps[at + 1], check)) problems.push(`${job}: the step after the checkout must be exactly ${JSON.stringify(check)}; found: ${JSON.stringify(steps[at + 1])}`);
    if (steps[at + 2]?.with?.file !== RT.dockerfile) problems.push(`${job}: the step after the check must build ${RT.dockerfile}; found: ${JSON.stringify(steps[at + 2])}`);
  }
  // The comment above the build job counts the images that it builds.
  const comment = /^ {2}# (Every pull request[^\n]*\n {2}# [^\n]*)\n {2}build:$/m.exec(text)?.[1] ?? '';
  if (!comment.includes(`builds the ${IMAGE_WORDS[rows.length]} images`)) problems.push(`the comment above the build job must say that it builds the ${IMAGE_WORDS[rows.length]} images; found: ${comment}`);
  return problems;
}

test('CI: the thirteen images of the table are built with no push in the build job and pushed in the publish job, in one order, with the tags and the label of their rows, and the guard refuses each copy that breaks one rule', () => {
  const pins = rtPins();
  assert.deepEqual(Object.keys(pins), ['docker-compose.advocate.yml', 'docker-compose.agent-history.yml', 'docker-compose.audio-snippets.yml', 'docker-compose.document-pipeline.yml'], 'the four compose files of the present host');
  const [PIN] = Object.values(pins);
  const OTHER = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(CI_IMAGES.length, 13, 'the table lists thirteen images');
  assert.equal(new Set(CI_IMAGES.map((row) => row.image)).size, 13, 'each image once');
  assert.equal(CI_IMAGES.at(-1).file, OPERATOR_FILE, 'the operator image is the last row');
  assert.equal(ciText.split(PIN).length - 1, 5, 'the pin stands in five places of the workflow: two refs, two checks and one label');
  assert.deepEqual(ciImageProblems(ciText, CI_IMAGES, pins), [], 'the real file passes');
  // The build job runs on every event of the workflow, beside the tests, with the read-only permissions of the workflow, and it logs in nowhere.
  assert.deepEqual(ci.on, { push: { branches: ['main'] }, pull_request: null });
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const job = ci.jobs.build;
  assert.equal(job['runs-on'], 'self-hosted');
  assert.equal(job.if, undefined, 'on every event of the workflow');
  assert.equal(job.needs, undefined, 'beside the tests, not after them');
  assert.equal(job.permissions, undefined, 'the read-only permissions of the workflow');
  assert.equal(job.steps[0].uses, 'actions/checkout@v4');
  for (const row of CI_IMAGES.filter((r) => r.context === '.')) assert.ok(existsSync(join(root, row.file)), `${row.file} is in this repository`);
  // The label comparison is made on the first label line: it is the same for every image, and only the runtime has a second line.
  const pushed = ci.jobs.publish.steps.filter((s) => s.uses === 'docker/build-push-action@v6');
  const firstLabel = (step) => step.with.labels.trim().split('\n')[0];
  for (const step of pushed) assert.equal(firstLabel(step), firstLabel(pushed[0]), `the first label line of ${step.with.file}`);
  assert.equal(firstLabel(pushed[0]), RT.sourceLabel);
  assert.deepEqual(pushed.map((s) => s.with.labels.trim().split('\n').length), CI_IMAGES.map((row) => (row.label === null ? 1 : 2)), 'only the runtime has a second label line');
  assert.deepEqual(pushed.find((s) => s.with.file === RT.dockerfile).with.labels.trim().split('\n').slice(1), [`${RT.commitLabel}=${PIN}`]);
  // The parts of the real text that the faults change.
  const CHECKOUT = `      - uses: actions/checkout@v4\n        with:\n          repository: ${RT.repository}\n          ref: ${PIN}\n          path: ${RT.folder}\n          persist-credentials: false\n`;
  const CHECK = `      - run: test "$(git -C ${RT.folder} rev-parse HEAD)" = ${PIN}\n`;
  const STEP = (file) => `      - uses: docker/build-push-action@v6\n        with:\n          context: .\n          file: ${file}\n`;
  const BUILD = (file) => `${STEP(file)}          push: false\n`;
  const PUSH = (name, file) => `${STEP(file)}          push: true\n          tags: |\n            ${IMAGE_REPOSITORY}/${name}:latest\n            ${IMAGE_REPOSITORY}/${name}:\${{ github.sha }}\n          labels: ${RT.sourceLabel}\n`;
  const LOGIN = '      - uses: docker/login-action@v3\n';
  const RUNTIME = `file: ${RT.dockerfile}\n          push: `;
  const REORDER = 'agents/reorder-agent/Dockerfile';
  const ORDERS = 'agents/order-desk/Dockerfile';
  const PRIORAUTH = imageRow('prior-authorization-agent').file;
  const INTAKE = imageRow('insurer-intake-agent').file;
  const BIDDESK = imageRow('bid-desk').file;
  const SOURCING = imageRow('sourcing-agent').file;
  const OPERATOR = OPERATOR_FILE;
  const block = (from) => ciText.slice(from, ciText.indexOf(STEP(MOCK_FILE), from));
  const [b0, b1] = [block(ciText.indexOf(CHECKOUT)), block(ciText.lastIndexOf(CHECKOUT))];
  const change = (from, to, n) => rtChange(ciText, from, to, n);
  const other = (text) => text.split(PIN).join(OTHER);
  const moved = (part, before, n) => rtChange(change(part, ''), before, part + before, n);
  const exactly = (which, file) => new RegExp(`${which}: the step of ${srvEscape(file)} must be exactly`);
  const faults = [
    ['the ref of the build job on another commit', change(`ref: ${PIN}`, `ref: ${OTHER}`), /build: the ref \S+ is not the commit/],
    ['the ref of the publish job on another commit', change(`ref: ${PIN}`, `ref: ${OTHER}`, 1), /publish: the ref \S+ is not the commit/],
    ['a branch name in place of a commit', change(`ref: ${PIN}`, 'ref: main'), /build: the ref must be a commit of 40 hex digits/],
    ['a short commit', change(`ref: ${PIN}`, `ref: ${PIN.slice(0, 7)}`, 1), /publish: the ref must be a commit of 40 hex digits/],
    ['the check of the build job on another commit', change(CHECK, other(CHECK)), /build: the step after the checkout must be exactly/],
    ['the check of the publish job on another commit', change(CHECK, other(CHECK), 1), /publish: the step after the checkout must be exactly/],
    ['a check that never fails', change(CHECK, `${CHECK.trimEnd()} || true\n`), /build: the step after the checkout must be exactly/],
    ['no check in the publish job', change(CHECK, '', 1), /publish: the step after the checkout must be exactly/],
    ['a step between the checkout and the check', change(CHECKOUT, `${CHECKOUT}      - run: echo patch\n`, 1), /publish: the step after the checkout must be exactly/],
    ['a step between the check and the build', change(CHECK, `${CHECK}      - run: echo patch\n`), /build: the step after the check must build/],
    ['no checkout of the template', change(CHECKOUT, '', 1), /publish: no step checks out/],
    ['the checkout of another repository', change(`repository: ${RT.repository}`, `repository: ${RT.repository}-fork`), /build: no step checks out/],
    ['the checkout in another folder', change(`path: ${RT.folder}`, 'path: template', 1), /publish: the checkout must be actions\/checkout@v4/],
    ['a token for the checkout', change(`path: ${RT.folder}\n`, `path: ${RT.folder}\n          token: x\n`), /build: the checkout must be actions\/checkout@v4/],
    ['no persist-credentials in the checkout of the publish job', change('          persist-credentials: false\n', '', 1), /publish: the checkout must be actions\/checkout@v4/],
    ['persist-credentials left on in the checkout of the build job', change('persist-credentials: false', 'persist-credentials: true'), /build: the checkout must be actions\/checkout@v4/],
    ['a push in the build job', change(`${RUNTIME}false`, `${RUNTIME}true`), exactly('build', RT.dockerfile)],
    ['a tag in the build job', change(`${RUNTIME}false\n`, `${RUNTIME}false\n          tags: ${RT.image}:latest\n`), exactly('build', RT.dockerfile)],
    ['no push in the publish job', change(`${RUNTIME}true`, `${RUNTIME}false`), exactly('publish', RT.dockerfile)],
    ['a build argument', change(`${RUNTIME}true`, `file: ${RT.dockerfile}\n          build-args: NODE_VERSION=20\n          push: true`), exactly('publish', RT.dockerfile)],
    ['the context of this repository', change(`context: ${RT.folder}`, 'context: .'), exactly('build', RT.dockerfile)],
    ['the tag :latest only', change(`            ${RT.image}:\${{ github.sha }}\n`, ''), exactly('publish', RT.dockerfile)],
    ['the tag of the commit only', change(`            ${RT.image}:latest\n`, ''), exactly('publish', RT.dockerfile)],
    ['the tag of another image', change(`${RT.image}:latest`, `${IMAGE_REPOSITORY}/advocate:latest`), exactly('publish', RT.dockerfile)],
    ['no label of the commit', change(`            ${RT.commitLabel}=${PIN}\n`, ''), exactly('publish', RT.dockerfile)],
    ['the label of another commit', change(`${RT.commitLabel}=${PIN}`, `${RT.commitLabel}=${OTHER}`), exactly('publish', RT.dockerfile)],
    ['no label of the source', change(`            ${RT.sourceLabel}\n`, ''), exactly('publish', RT.dockerfile)],
    ['the steps of the runtime after the build of the operator image, in the build job', moved(b0, '  publish:\n'), /build: the Dockerfiles must be the thirteen of the table/],
    ['the steps of the runtime after the build of the operator image, in the publish job', `${change(b1, '')}${b1}`, /publish: the Dockerfiles must be the thirteen of the table/],
    ['the push of the runtime before the login', moved(b1, LOGIN), new RegExp(`publish: the push of ${srvEscape(RT.dockerfile)} must come after the login`)],
    ['the steps of the runtime in another place in one job', moved(b0, STEP('agents/agent-history/Dockerfile')), /build: the Dockerfiles must be the thirteen of the table/],
    ['a login in the build job', change(CHECKOUT, `      - uses: docker/login-action@v3\n${CHECKOUT}`), /build: the job must have no registry login/],
    ['an image left out of the build job', change(BUILD(REORDER), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['an image left out of the publish job', change(PUSH('order-desk', ORDERS), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the two new images in the other order in the build job', change(`${BUILD(REORDER)}${BUILD(ORDERS)}`, `${BUILD(ORDERS)}${BUILD(REORDER)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the two new images in the other order in the publish job', change(`${PUSH('reorder-agent', REORDER)}${PUSH('order-desk', ORDERS)}`, `${PUSH('order-desk', ORDERS)}${PUSH('reorder-agent', REORDER)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['an image that the table does not list, in the publish job', change(PUSH('order-desk', ORDERS), `${PUSH('order-desk', ORDERS)}${PUSH('extra', 'agents/extra/Dockerfile')}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Order Desk pushed under the name of the Reorder Agent', change(`${IMAGE_REPOSITORY}/order-desk:latest`, `${IMAGE_REPOSITORY}/reorder-agent:latest`), exactly('publish', ORDERS)],
    ['no tag of the commit for the Reorder Agent', change(`            ${IMAGE_REPOSITORY}/reorder-agent:\${{ github.sha }}\n`, ''), exactly('publish', REORDER)],
    ['a push in the build job for the Order Desk', change(`${STEP(ORDERS)}          push: false`, `${STEP(ORDERS)}          push: true`), exactly('build', ORDERS)],
    ['no push in the publish job for the Reorder Agent', change(`${STEP(REORDER)}          push: true`, `${STEP(REORDER)}          push: false`), exactly('publish', REORDER)],
    ['the context of the Reorder Agent in another folder', change(`context: .\n          file: ${REORDER}`, `context: agents\n          file: ${REORDER}`), exactly('build', REORDER)],
    ['a condition of its own on the build step of the Order Desk', change(BUILD(ORDERS), BUILD(ORDERS).replace('      - uses:', "      - if: github.event_name == 'push'\n        uses:")), exactly('build', ORDERS)],
    ['another source label for the Order Desk', change(PUSH('order-desk', ORDERS), PUSH('order-desk', ORDERS).replace(RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', ORDERS)],
    ['the label of the template commit on an image that has none', change(PUSH('reorder-agent', REORDER), PUSH('reorder-agent', REORDER).replace(`labels: ${RT.sourceLabel}`, `labels: |\n            ${RT.sourceLabel}\n            ${RT.commitLabel}=${PIN}`)), exactly('publish', REORDER)],
    ['the Prior Authorization Agent left out of the build job', change(BUILD(PRIORAUTH), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent left out of the publish job', change(PUSH('prior-authorization-agent', PRIORAUTH), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Order Desk and the Prior Authorization Agent in the other order in the build job', change(`${BUILD(ORDERS)}${BUILD(PRIORAUTH)}`, `${BUILD(PRIORAUTH)}${BUILD(ORDERS)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Order Desk and the Prior Authorization Agent in the other order in the publish job', change(`${PUSH('order-desk', ORDERS)}${PUSH('prior-authorization-agent', PRIORAUTH)}`, `${PUSH('prior-authorization-agent', PRIORAUTH)}${PUSH('order-desk', ORDERS)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent after the steps of the runtime, in the build job', moved(BUILD(PRIORAUTH), STEP(MOCK_FILE)), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent after the steps of the runtime, in the publish job', moved(PUSH('prior-authorization-agent', PRIORAUTH), STEP(MOCK_FILE), 1), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent pushed under the name of the Order Desk', change(`${IMAGE_REPOSITORY}/prior-authorization-agent:latest`, `${IMAGE_REPOSITORY}/order-desk:latest`), exactly('publish', PRIORAUTH)],
    ['the Prior Authorization Agent pushed under a name with one letter more', change(`${IMAGE_REPOSITORY}/prior-authorization-agent:latest`, `${IMAGE_REPOSITORY}/prior-authorization-agents:latest`), exactly('publish', PRIORAUTH)],
    ['no tag :latest for the Prior Authorization Agent', change(`            ${IMAGE_REPOSITORY}/prior-authorization-agent:latest\n`, ''), exactly('publish', PRIORAUTH)],
    ['no tag of the commit for the Prior Authorization Agent', change(`            ${IMAGE_REPOSITORY}/prior-authorization-agent:\${{ github.sha }}\n`, ''), exactly('publish', PRIORAUTH)],
    ['a push in the build job for the Prior Authorization Agent', change(`${STEP(PRIORAUTH)}          push: false`, `${STEP(PRIORAUTH)}          push: true`), exactly('build', PRIORAUTH)],
    ['no push in the publish job for the Prior Authorization Agent', change(`${STEP(PRIORAUTH)}          push: true`, `${STEP(PRIORAUTH)}          push: false`), exactly('publish', PRIORAUTH)],
    ['a build argument for the Prior Authorization Agent', change(`${STEP(PRIORAUTH)}          push: false`, `${STEP(PRIORAUTH)}          build-args: NODE_VERSION=20\n          push: false`), exactly('build', PRIORAUTH)],
    ['the context of the Prior Authorization Agent in its own folder', change(`context: .\n          file: ${PRIORAUTH}`, `context: agents/prior-authorization-agent\n          file: ${PRIORAUTH}`), exactly('build', PRIORAUTH)],
    ['another source label for the Prior Authorization Agent', change(PUSH('prior-authorization-agent', PRIORAUTH), rtChange(PUSH('prior-authorization-agent', PRIORAUTH), RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', PRIORAUTH)],
    ['the push of the Prior Authorization Agent before the login', moved(PUSH('prior-authorization-agent', PRIORAUTH), LOGIN), new RegExp(`publish: the push of ${srvEscape(PRIORAUTH)} must come after the login`)],
    ['the Insurer Intake Agent left out of the build job', change(BUILD(INTAKE), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent left out of the publish job', change(PUSH('insurer-intake-agent', INTAKE), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent and the Insurer Intake Agent in the other order in the build job', change(`${BUILD(PRIORAUTH)}${BUILD(INTAKE)}`, `${BUILD(INTAKE)}${BUILD(PRIORAUTH)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Prior Authorization Agent and the Insurer Intake Agent in the other order in the publish job', change(`${PUSH('prior-authorization-agent', PRIORAUTH)}${PUSH('insurer-intake-agent', INTAKE)}`, `${PUSH('insurer-intake-agent', INTAKE)}${PUSH('prior-authorization-agent', PRIORAUTH)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent after the steps of the runtime, in the build job', moved(BUILD(INTAKE), STEP(MOCK_FILE)), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent after the steps of the runtime, in the publish job', moved(PUSH('insurer-intake-agent', INTAKE), STEP(MOCK_FILE), 1), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent pushed under the name of the Prior Authorization Agent', change(`${IMAGE_REPOSITORY}/insurer-intake-agent:latest`, `${IMAGE_REPOSITORY}/prior-authorization-agent:latest`), exactly('publish', INTAKE)],
    ['the Insurer Intake Agent pushed under a name with one letter more', change(`${IMAGE_REPOSITORY}/insurer-intake-agent:latest`, `${IMAGE_REPOSITORY}/insurer-intake-agents:latest`), exactly('publish', INTAKE)],
    ['no tag :latest for the Insurer Intake Agent', change(`            ${IMAGE_REPOSITORY}/insurer-intake-agent:latest\n`, ''), exactly('publish', INTAKE)],
    ['no tag of the commit for the Insurer Intake Agent', change(`            ${IMAGE_REPOSITORY}/insurer-intake-agent:\${{ github.sha }}\n`, ''), exactly('publish', INTAKE)],
    ['a push in the build job for the Insurer Intake Agent', change(`${STEP(INTAKE)}          push: false`, `${STEP(INTAKE)}          push: true`), exactly('build', INTAKE)],
    ['no push in the publish job for the Insurer Intake Agent', change(`${STEP(INTAKE)}          push: true`, `${STEP(INTAKE)}          push: false`), exactly('publish', INTAKE)],
    ['a build argument for the Insurer Intake Agent', change(`${STEP(INTAKE)}          push: false`, `${STEP(INTAKE)}          build-args: NODE_VERSION=20\n          push: false`), exactly('build', INTAKE)],
    ['the context of the Insurer Intake Agent in its own folder', change(`context: .\n          file: ${INTAKE}`, `context: agents/insurer-intake-agent\n          file: ${INTAKE}`), exactly('build', INTAKE)],
    ['another source label for the Insurer Intake Agent', change(PUSH('insurer-intake-agent', INTAKE), rtChange(PUSH('insurer-intake-agent', INTAKE), RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', INTAKE)],
    ['the push of the Insurer Intake Agent before the login', moved(PUSH('insurer-intake-agent', INTAKE), LOGIN), new RegExp(`publish: the push of ${srvEscape(INTAKE)} must come after the login`)],
    ['the Bid Desk left out of the build job', change(BUILD(BIDDESK), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk left out of the publish job', change(PUSH('bid-desk', BIDDESK), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent and the Bid Desk in the other order in the build job', change(`${BUILD(INTAKE)}${BUILD(BIDDESK)}`, `${BUILD(BIDDESK)}${BUILD(INTAKE)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Insurer Intake Agent and the Bid Desk in the other order in the publish job', change(`${PUSH('insurer-intake-agent', INTAKE)}${PUSH('bid-desk', BIDDESK)}`, `${PUSH('bid-desk', BIDDESK)}${PUSH('insurer-intake-agent', INTAKE)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk after the steps of the runtime, in the build job', moved(BUILD(BIDDESK), STEP(MOCK_FILE)), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk after the steps of the runtime, in the publish job', moved(PUSH('bid-desk', BIDDESK), STEP(MOCK_FILE), 1), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk pushed under the name of the Insurer Intake Agent', change(`${IMAGE_REPOSITORY}/bid-desk:latest`, `${IMAGE_REPOSITORY}/insurer-intake-agent:latest`), exactly('publish', BIDDESK)],
    ['the Bid Desk pushed under a name with one letter more', change(`${IMAGE_REPOSITORY}/bid-desk:latest`, `${IMAGE_REPOSITORY}/bid-desks:latest`), exactly('publish', BIDDESK)],
    ['no tag :latest for the Bid Desk', change(`            ${IMAGE_REPOSITORY}/bid-desk:latest\n`, ''), exactly('publish', BIDDESK)],
    ['no tag of the commit for the Bid Desk', change(`            ${IMAGE_REPOSITORY}/bid-desk:\${{ github.sha }}\n`, ''), exactly('publish', BIDDESK)],
    ['a push in the build job for the Bid Desk', change(`${STEP(BIDDESK)}          push: false`, `${STEP(BIDDESK)}          push: true`), exactly('build', BIDDESK)],
    ['no push in the publish job for the Bid Desk', change(`${STEP(BIDDESK)}          push: true`, `${STEP(BIDDESK)}          push: false`), exactly('publish', BIDDESK)],
    ['a build argument for the Bid Desk', change(`${STEP(BIDDESK)}          push: false`, `${STEP(BIDDESK)}          build-args: NODE_VERSION=20\n          push: false`), exactly('build', BIDDESK)],
    ['the context of the Bid Desk in its own folder', change(`context: .\n          file: ${BIDDESK}`, `context: agents/bid-desk\n          file: ${BIDDESK}`), exactly('build', BIDDESK)],
    ['another source label for the Bid Desk', change(PUSH('bid-desk', BIDDESK), rtChange(PUSH('bid-desk', BIDDESK), RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', BIDDESK)],
    ['the push of the Bid Desk before the login', moved(PUSH('bid-desk', BIDDESK), LOGIN), new RegExp(`publish: the push of ${srvEscape(BIDDESK)} must come after the login`)],
    ['the Sourcing Agent left out of the build job', change(BUILD(SOURCING), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Sourcing Agent left out of the publish job', change(PUSH('sourcing-agent', SOURCING), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk and the Sourcing Agent in the other order in the build job', change(`${BUILD(BIDDESK)}${BUILD(SOURCING)}`, `${BUILD(SOURCING)}${BUILD(BIDDESK)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Bid Desk and the Sourcing Agent in the other order in the publish job', change(`${PUSH('bid-desk', BIDDESK)}${PUSH('sourcing-agent', SOURCING)}`, `${PUSH('sourcing-agent', SOURCING)}${PUSH('bid-desk', BIDDESK)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Sourcing Agent after the steps of the runtime, in the build job', moved(BUILD(SOURCING), STEP(MOCK_FILE)), /build: the Dockerfiles must be the thirteen of the table/],
    ['the Sourcing Agent after the steps of the runtime, in the publish job', moved(PUSH('sourcing-agent', SOURCING), STEP(MOCK_FILE), 1), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the Sourcing Agent pushed under the name of the Bid Desk', change(`${IMAGE_REPOSITORY}/sourcing-agent:latest`, `${IMAGE_REPOSITORY}/bid-desk:latest`), exactly('publish', SOURCING)],
    ['the Sourcing Agent pushed under a name with one letter more', change(`${IMAGE_REPOSITORY}/sourcing-agent:latest`, `${IMAGE_REPOSITORY}/sourcing-agents:latest`), exactly('publish', SOURCING)],
    ['no tag :latest for the Sourcing Agent', change(`            ${IMAGE_REPOSITORY}/sourcing-agent:latest\n`, ''), exactly('publish', SOURCING)],
    ['no tag of the commit for the Sourcing Agent', change(`            ${IMAGE_REPOSITORY}/sourcing-agent:\${{ github.sha }}\n`, ''), exactly('publish', SOURCING)],
    ['a push in the build job for the Sourcing Agent', change(`${STEP(SOURCING)}          push: false`, `${STEP(SOURCING)}          push: true`), exactly('build', SOURCING)],
    ['no push in the publish job for the Sourcing Agent', change(`${STEP(SOURCING)}          push: true`, `${STEP(SOURCING)}          push: false`), exactly('publish', SOURCING)],
    ['a build argument for the Sourcing Agent', change(`${STEP(SOURCING)}          push: false`, `${STEP(SOURCING)}          build-args: NODE_VERSION=20\n          push: false`), exactly('build', SOURCING)],
    ['the context of the Sourcing Agent in its own folder', change(`context: .\n          file: ${SOURCING}`, `context: agents/sourcing-agent\n          file: ${SOURCING}`), exactly('build', SOURCING)],
    ['another source label for the Sourcing Agent', change(PUSH('sourcing-agent', SOURCING), rtChange(PUSH('sourcing-agent', SOURCING), RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', SOURCING)],
    ['the push of the Sourcing Agent before the login', moved(PUSH('sourcing-agent', SOURCING), LOGIN), new RegExp(`publish: the push of ${srvEscape(SOURCING)} must come after the login`)],
    ['the operator image left out of the build job', change(BUILD(OPERATOR), ''), /build: the Dockerfiles must be the thirteen of the table/],
    ['the operator image left out of the publish job', change(PUSH('operator', OPERATOR), ''), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the operator image and the mock service in the other order in the build job', change(`${BUILD(MOCK_FILE)}${BUILD(OPERATOR)}`, `${BUILD(OPERATOR)}${BUILD(MOCK_FILE)}`), /build: the Dockerfiles must be the thirteen of the table/],
    ['the operator image and the mock service in the other order in the publish job', change(`${PUSH('mock-systems', MOCK_FILE)}${PUSH('operator', OPERATOR)}`, `${PUSH('operator', OPERATOR)}${PUSH('mock-systems', MOCK_FILE)}`), /publish: the Dockerfiles must be the thirteen of the table/],
    ['the operator image pushed under the name of the Order Desk', change(`${IMAGE_REPOSITORY}/operator:latest`, `${IMAGE_REPOSITORY}/order-desk:latest`), exactly('publish', OPERATOR)],
    ['no tag :latest for the operator image', change(`            ${IMAGE_REPOSITORY}/operator:latest\n`, ''), exactly('publish', OPERATOR)],
    ['no tag of the commit for the operator image', change(`            ${IMAGE_REPOSITORY}/operator:\${{ github.sha }}\n`, ''), exactly('publish', OPERATOR)],
    ['a push in the build job for the operator image', change(`${STEP(OPERATOR)}          push: false`, `${STEP(OPERATOR)}          push: true`), exactly('build', OPERATOR)],
    ['no push in the publish job for the operator image', change(`${STEP(OPERATOR)}          push: true`, `${STEP(OPERATOR)}          push: false`), exactly('publish', OPERATOR)],
    ['a build argument for the operator image', change(`${STEP(OPERATOR)}          push: false`, `${STEP(OPERATOR)}          build-args: SIGNING_KEY=x\n          push: false`), exactly('build', OPERATOR)],
    ['the context of the operator image in its own folder', change(`context: .\n          file: ${OPERATOR}`, `context: scripts/operator\n          file: ${OPERATOR}`), exactly('build', OPERATOR)],
    ['another source label for the operator image', change(PUSH('operator', OPERATOR), PUSH('operator', OPERATOR).replace(RT.sourceLabel, 'org.opencontainers.image.source=other')), exactly('publish', OPERATOR)],
    ['the push of the operator image before the login', moved(PUSH('operator', OPERATOR), LOGIN), new RegExp(`publish: the push of ${srvEscape(OPERATOR)} must come after the login`)],
    ['a step after the build of the operator image, in the publish job', `${ciText}      - run: echo late\n`, new RegExp(`publish: the last step must build ${srvEscape(OPERATOR_FILE)}`)],
    ['a step after the build of the operator image, in the build job', change('  publish:\n', '      - run: echo late\n  publish:\n'), new RegExp(`build: the last step must build ${srvEscape(OPERATOR_FILE)}`)],
    ['a comment that counts six images', change('builds the thirteen images', 'builds the six images'), /the comment above the build job must say that it builds the thirteen images/],
    ['a key twice', change(`path: ${RT.folder}\n`, `path: ${RT.folder}\n          path: ${RT.folder}\n`), /does not parse/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = ciImageProblems(broken, CI_IMAGES, pins);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  assert.ok(ciImageProblems(ciText, CI_IMAGES, { ...pins, 'docker-compose.audio-snippets.yml': OTHER }).some((p) => /compose files must name one commit/.test(p)), 'a compose file on another commit');
  // The twins: the pin moved to another commit in every place, a step that sits where it breaks nothing, a comment, and one label written as a block.
  const twins = [
    ['the pin on another commit in the workflow and in the four compose files', other(ciText), Object.fromEntries(Object.keys(pins).map((file) => [file, OTHER]))],
    ['a step between the Order Desk and the Prior Authorization Agent', change(STEP(PRIORAUTH), `      - run: echo ok\n${STEP(PRIORAUTH)}`, 1), pins],
    ['a step between the Prior Authorization Agent and the Insurer Intake Agent', change(STEP(INTAKE), `      - run: echo ok\n${STEP(INTAKE)}`, 1), pins],
    ['a step between the Insurer Intake Agent and the Bid Desk', change(STEP(BIDDESK), `      - run: echo ok\n${STEP(BIDDESK)}`, 1), pins],
    ['a step between the Bid Desk and the Sourcing Agent', change(STEP(SOURCING), `      - run: echo ok\n${STEP(SOURCING)}`, 1), pins],
    ['a step between the runtime and the mock service', change(STEP(MOCK_FILE), `      - run: echo ok\n${STEP(MOCK_FILE)}`, 1), pins],
    ['a step between the mock service and the operator image', change(STEP(OPERATOR), `      - run: echo ok\n${STEP(OPERATOR)}`, 1), pins],
    ['a step before the checkout, and a comment between the steps', change(CHECKOUT, `      - run: echo ok\n      # a note\n${CHECKOUT}`, 1), pins],
    ['the one label of the Order Desk written as a block', change(PUSH('order-desk', ORDERS), PUSH('order-desk', ORDERS).replace(`labels: ${RT.sourceLabel}`, `labels: |\n            ${RT.sourceLabel}`)), pins],
  ];
  for (const [name, text, given] of twins) assert.deepEqual(ciImageProblems(text, CI_IMAGES, given), [], name);
});

// The services of the compose files against the table: each service that names an image is a service that its row lists, with the name of that row (the digest or its placeholder after the
// @ does not count), and each service that a row lists names an image. Each row lists a service, except the row of the operator image: no compose file names that image, and the host runs it with docker run, by its digest.
function composeImageProblems(rows, texts) {
  const problems = [];
  const expected = new Map(rows.flatMap((row) => row.named.map(([file, service]) => [`${file}#${service}`, row.image])));
  const seen = new Set();
  for (const [file, text] of Object.entries(texts)) {
    for (const [service, body] of Object.entries(parseYaml(text)?.services ?? {})) {
      if (typeof body?.image !== 'string') continue; // a service that the host builds from the template commit names no image
      const key = `${file}#${service}`;
      seen.add(key);
      const name = body.image.split('@')[0];
      if (!expected.has(key)) problems.push(`${key} names the image ${name}, and no row of the table lists that service`);
      else if (expected.get(key) !== name) problems.push(`${key} names the image ${name}, and CI pushes ${expected.get(key)}`);
    }
  }
  for (const key of expected.keys()) if (!seen.has(key)) problems.push(`${key} is a row of the table, and no compose file names an image there`);
  for (const row of rows) if (row.named.length === 0 && row.image !== `${IMAGE_REPOSITORY}/operator`) problems.push(`${row.image} is a row of the table, and no service of a compose file is listed for it`);
  return problems;
}

test('CI: each compose file of the two hosts names the image that CI pushes, and CI pushes each image that a compose file names; the guard refuses a name that is not the one of the row, a service that no row lists, a row that no compose file names, and an empty row of any image but the operator image', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  assert.deepEqual(Object.keys(texts), [...['advocate', 'agent-history', 'audio-snippets', 'document-pipeline'].map(hostCompose), ...['bid-desk-alfa', 'bid-desk-bravo', 'bid-desk-charlie', 'insurer-intake-agent', 'mock-systems', 'order-desk', 'prior-authorization-agent', 'reorder-agent', 'sourcing-agent'].map(serverCompose)], 'the four compose files of the present host and the nine of the agents host');
  assert.deepEqual(composeImageProblems(CI_IMAGES, texts), [], 'the real files pass');
  // The compose files of the agents host that hold a runtime name the image of their service and the runtime image, as the workflow pushes them.
  for (const [file, names] of [
    [serverCompose('reorder-agent'), [`${IMAGE_REPOSITORY}/reorder-agent`, RT.image]],
    [serverCompose('order-desk'), [`${IMAGE_REPOSITORY}/order-desk`, RT.image]],
    [serverCompose('prior-authorization-agent'), [`${IMAGE_REPOSITORY}/prior-authorization-agent`, RT.image]],
    [serverCompose('insurer-intake-agent'), [`${IMAGE_REPOSITORY}/insurer-intake-agent`, RT.image]],
    [serverCompose('bid-desk-alfa'), [`${IMAGE_REPOSITORY}/bid-desk`, RT.image]],
    [serverCompose('bid-desk-bravo'), [`${IMAGE_REPOSITORY}/bid-desk`, RT.image]],
    [serverCompose('bid-desk-charlie'), [`${IMAGE_REPOSITORY}/bid-desk`, RT.image]],
    [serverCompose('sourcing-agent'), [`${IMAGE_REPOSITORY}/sourcing-agent`, RT.image]],
  ]) {
    const named = Object.values(parseYaml(texts[file]).services).map((service) => service.image.split('@')[0]);
    assert.deepEqual([...new Set(named)].sort(), names.sort(), file);
  }
  const tagged = ci.jobs.publish.steps.filter((s) => s.uses === 'docker/build-push-action@v6').flatMap((s) => s.with.tags.trim().split('\n'));
  for (const row of CI_IMAGES) assert.ok(tagged.includes(`${row.image}:latest`), `CI pushes ${row.image}`);
  const reorder = serverCompose('reorder-agent');
  const orders = serverCompose('order-desk');
  const priorauth = serverCompose('prior-authorization-agent');
  const intake = serverCompose('insurer-intake-agent');
  const desks = ['alfa', 'bravo', 'charlie'].map((name) => ({ name, file: serverCompose(`bid-desk-${name}`) }));
  const sourcing = serverCompose('sourcing-agent');
  const faults = [
    ['the service of the Reorder Agent under another name', { ...texts, [reorder]: srvReplace(texts[reorder], '/reorder-agent@sha256', '/reorder-agents@sha256') }, /reorder-agent\.yml#service names the image \S+\/reorder-agents, and CI pushes \S+\/reorder-agent$/],
    ['the service of the Order Desk by a tag', { ...texts, [orders]: srvReplace(texts[orders], '/order-desk@sha256:<digest>', '/order-desk:latest') }, /order-desk\.yml#service names the image \S+\/order-desk:latest, and CI pushes \S+\/order-desk$/],
    ['the runtime of the Order Desk from another repository', { ...texts, [orders]: rtChange(texts[orders], `${RT.image}@sha256`, 'ghcr.io/other/agent-runtime@sha256', 1) }, /order-desk\.yml#runtime-medium names the image ghcr\.io\/other\/agent-runtime, and CI pushes/],
    ['a service that no row lists', { ...texts, [orders]: srvReplace(texts[orders], 'services:\n', `services:\n  extra:\n    image: ${IMAGE_REPOSITORY}/extra@sha256:<digest>\n`) }, /order-desk\.yml#extra names the image \S+\/extra, and no row of the table lists that service/],
    ['a compose file that no row lists', { ...texts, 'deploy/server/docker-compose.extra.yml': `services:\n  x:\n    image: ${IMAGE_REPOSITORY}/extra@sha256:<digest>\n` }, /docker-compose\.extra\.yml#x names the image/],
    ['a runtime that names no image', { ...texts, [reorder]: srvReplace(texts[reorder], `    image: ${RT.image}@sha256:<digest>\n`, '    build: ./runtime\n') }, /reorder-agent\.yml#runtime is a row of the table, and no compose file names an image there/],
    ['a compose file of the table that is gone', Object.fromEntries(Object.entries(texts).filter(([file]) => file !== serverCompose('mock-systems'))), /mock-systems\.yml#mock-systems is a row of the table/],
    ['a compose file that names the operator image', { ...texts, 'deploy/server/docker-compose.operator.yml': `services:\n  x:\n    image: ${IMAGE_REPOSITORY}/operator@sha256:<digest>\n` }, /docker-compose\.operator\.yml#x names the image \S+\/operator, and no row of the table lists that service/],
    ['the service of the Prior Authorization Agent under another name', { ...texts, [priorauth]: srvReplace(texts[priorauth], '/prior-authorization-agent@sha256', '/prior-authorization-agents@sha256') }, /prior-authorization-agent\.yml#service names the image \S+\/prior-authorization-agents, and CI pushes \S+\/prior-authorization-agent$/],
    ['a runtime of the Prior Authorization Agent that names no image', { ...texts, [priorauth]: srvReplace(texts[priorauth], `    image: ${RT.image}@sha256:<digest>\n`, '    build: ./runtime\n') }, /prior-authorization-agent\.yml#runtime is a row of the table, and no compose file names an image there/],
    ['the compose file of the Prior Authorization Agent that is gone', Object.fromEntries(Object.entries(texts).filter(([file]) => file !== priorauth)), /prior-authorization-agent\.yml#service is a row of the table, and no compose file names an image there/],
    ['the service of the Insurer Intake Agent under another name', { ...texts, [intake]: srvReplace(texts[intake], '/insurer-intake-agent@sha256', '/insurer-intake-agents@sha256') }, /insurer-intake-agent\.yml#service names the image \S+\/insurer-intake-agents, and CI pushes \S+\/insurer-intake-agent$/],
    ['a runtime of the Insurer Intake Agent that names no image', { ...texts, [intake]: srvReplace(texts[intake], `    image: ${RT.image}@sha256:<digest>\n`, '    build: ./runtime\n') }, /insurer-intake-agent\.yml#runtime is a row of the table, and no compose file names an image there/],
    ['the compose file of the Insurer Intake Agent that is gone', Object.fromEntries(Object.entries(texts).filter(([file]) => file !== intake)), /insurer-intake-agent\.yml#service is a row of the table, and no compose file names an image there/],
    ...desks.flatMap(({ name, file }) => [
      [`the service of the Bid Desk ${name} under another name`, { ...texts, [file]: srvReplace(texts[file], '/bid-desk@sha256', '/bid-desks@sha256') }, new RegExp(`${srvEscape(file)}#service names the image \\S+/bid-desks, and CI pushes \\S+/bid-desk$`)],
      [`a runtime of the Bid Desk ${name} that names no image`, { ...texts, [file]: srvReplace(texts[file], `    image: ${RT.image}@sha256:<digest>\n`, '    build: ./runtime\n') }, new RegExp(`${srvEscape(file)}#runtime is a row of the table, and no compose file names an image there`)],
      [`the compose file of the Bid Desk ${name} that is gone`, Object.fromEntries(Object.entries(texts).filter(([path]) => path !== file)), new RegExp(`${srvEscape(file)}#service is a row of the table, and no compose file names an image there`)],
    ]),
    ['the service of the Sourcing Agent under another name', { ...texts, [sourcing]: srvReplace(texts[sourcing], '/sourcing-agent@sha256', '/sourcing-agents@sha256') }, /sourcing-agent\.yml#service names the image \S+\/sourcing-agents, and CI pushes \S+\/sourcing-agent$/],
    ['a runtime of the Sourcing Agent that names no image', { ...texts, [sourcing]: srvReplace(texts[sourcing], `    image: ${RT.image}@sha256:<digest>\n`, '    build: ./runtime\n') }, /sourcing-agent\.yml#runtime is a row of the table, and no compose file names an image there/],
    ['the compose file of the Sourcing Agent that is gone', Object.fromEntries(Object.entries(texts).filter(([file]) => file !== sourcing)), /sourcing-agent\.yml#service is a row of the table, and no compose file names an image there/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = composeImageProblems(CI_IMAGES, broken);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The operator image is the one row that lists no service: no compose file names it. A row of another image with an empty list is refused.
  assert.deepEqual(CI_IMAGES.filter((row) => row.named.length === 0).map((row) => row.image), [`${IMAGE_REPOSITORY}/operator`], 'the operator image is the one row with no service');
  const emptied = CI_IMAGES.map((row) => (row.image === `${IMAGE_REPOSITORY}/mock-systems` ? { ...row, named: [] } : row));
  assert.ok(composeImageProblems(emptied, texts).some((p) => /mock-systems is a row of the table, and no service of a compose file is listed for it/.test(p)), 'a row of the mock service with no service');
  // The twins: the digest of 64 hex digits in place of the placeholder, and a service that the host builds from the template commit.
  const digest = (text) => srvReplace(text, '@sha256:<digest>', `@sha256:${'ab'.repeat(32)}`);
  assert.deepEqual(composeImageProblems(CI_IMAGES, { ...texts, [reorder]: digest(texts[reorder]), [orders]: digest(texts[orders]), [priorauth]: digest(texts[priorauth]), [intake]: digest(texts[intake]), [sourcing]: digest(texts[sourcing]), ...Object.fromEntries(desks.map(({ file }) => [file, digest(texts[file])])) }), [], 'the images by digest');
  assert.deepEqual(composeImageProblems(CI_IMAGES, { ...texts, [hostCompose('advocate')]: srvReplace(texts[hostCompose('advocate')], 'build:\n', 'build:\n      args: {}\n') }), [], 'the build of the runtime on the present host names no image');
});

// A tag moves and a digest does not: a compose file names the runtime image by its digest (or by the placeholder of a file that the operator completes).
function runtimeReferenceProblems(text) {
  const problems = [];
  for (const [name, service] of Object.entries(parseYaml(text)?.services ?? {})) {
    const image = String(service?.image ?? '');
    if (image.startsWith(RT.image) && !new RegExp(`^${srvEscape(RT.image)}@sha256:(?:<digest>|[0-9a-f]{64})$`).test(image)) problems.push(`${name}: the runtime image is named by its digest, never by a tag; found: ${image}`);
  }
  return problems;
}

test('CI: the runtime image is named by its digest in every compose file of the repository; the guard refuses a tag and the bare name, and passes the digest and the placeholder', () => {
  const files = Object.keys(composeTextsOf(['deploy/host', 'deploy/server']));
  assert.ok(files.length >= 5 && files.includes('deploy/server/docker-compose.mock-systems.yml') && files.includes('deploy/host/docker-compose.advocate.yml'), `the walk reaches the compose files, found ${files.length}`);
  for (const file of files) assert.deepEqual(runtimeReferenceProblems(read(file)), [], file);
  const compose = (image) => `services:\n  runtime:\n    image: ${image}\n`;
  for (const twin of [`${RT.image}@sha256:<digest>`, `${RT.image}@sha256:${'ab'.repeat(32)}`, 'ghcr.io/apex-fusion/vector-service-agents/mock-systems:latest']) assert.deepEqual(runtimeReferenceProblems(compose(twin)), [], twin);
  for (const bad of [`${RT.image}:latest`, `${RT.image}:${'a'.repeat(40)}`, RT.image, `${RT.image}@sha256:abc`, `${RT.image}@sha256:${'AB'.repeat(32)}`]) assert.equal(runtimeReferenceProblems(compose(bad)).length, 1, bad);
});

test('CI: the runtime image: the README of deploy/server follows its section of the host with a section that names the image and its digest form, the places of the pin, and the package visibility', () => {
  const readme = srvRead('README.md');
  const text = section(readme, 'The runtime image');
  assert.ok(text.length > 0, 'the section is there');
  const at = (heading) => readme.indexOf(`\n## ${heading}\n`);
  assert.ok(at('The host') > 0 && at('The host') < at('The runtime image') && at('The runtime image') < at('What the script does'), 'after the host, before the script');
  for (const part of [`${RT.image}@sha256:<digest>`, '`:latest`', '`:<full git commit sha>`', RT.commitLabel, RT.repository, '`ref`', 'deploy/host', 'scripts/deploy.test.mjs', 'check that the package is public', `docker manifest inspect ${RT.image}:latest`, 'admin of the organisation']) assert.ok(text.includes(part), part);
});

// ======================================================================================================================================
// Use case 1 (inventory reorder): the Reorder Agent and the Order Desk. The tests of each pack hold its files on their own. These tests read more than one place: the tracked files of the
// repository, the compose files of both hosts, the README of the agents host, and the parsers that the two agents and the mock service use for the documents that they pass to each other.
// The drift tests run the real TypeScript of two packages in one child process, as the tests of the mock service do. Each guard has an accepted twin and refused copies.
// ======================================================================================================================================

// The files of a pack against the tracked files and the words of the host. A file that git does not track never reaches the host. A file that names the host, the stack of its reverse proxy, a
// login or a key file stays out of a public repository. The scan of the host words above reads every tracked file already: this guard names the nine files of the two packs.
function trackedFileProblems(files, tracked, textOf) {
  const problems = [];
  for (const file of files) {
    if (!tracked.includes(file)) problems.push(`${file} is not tracked by git`);
    else if (HOST_WORDS.test(textOf(file))) problems.push(`${file} names the host, the stack of its reverse proxy, a login or a key file`);
  }
  return problems;
}

test('use case 1 files: the nine files of the two deploy packs are tracked by git, and none names the host, the stack of its reverse proxy, a login or a key file; the guard refuses a file that is not tracked and a file that names the host', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  assert.equal(USE_CASE_1_FILES.length, 9, 'four files for the Reorder Agent and five for the Order Desk');
  assert.equal(new Set(USE_CASE_1_FILES).size, 9, 'each file once');
  for (const file of USE_CASE_1_FILES) assert.ok(existsSync(join(root, file)), `${file} is there`);
  assert.deepEqual(trackedFileProblems(USE_CASE_1_FILES, TRACKED, read), [], 'the real files pass');
  const [compose, , , runbook] = USE_CASE_1_FILES;
  assert.deepEqual(trackedFileProblems(USE_CASE_1_FILES, TRACKED.filter((file) => file !== runbook), read), [`${runbook} is not tracked by git`], 'a file that is not tracked');
  for (const part of ['the apex' + '-web box', 'uma' + 'mi_default', 'root' + '@host', 'id_' + 'ed25519']) {
    const text = (file) => (file === compose ? `${read(file)}# ${part}\n` : read(file));
    assert.deepEqual(trackedFileProblems(USE_CASE_1_FILES, TRACKED, text), [`${compose} names the host, the stack of its reverse proxy, a login or a key file`], part);
  }
  // The twin: a text with the names that a pack holds on purpose: a public host name of an agent, the folder of the pack and the word host.
  const twin = (file) => (file === compose ? `${read(file)}# mp-suppliers-reorder.vector.apexfusion.org in deploy/server on the agents host\n` : read(file));
  assert.deepEqual(trackedFileProblems(USE_CASE_1_FILES, TRACKED, twin), [], 'the names of the pack');
});

// The host ports that the services of a compose file publish: the short form "127.0.0.1:8101:8080" and the long form with published and target.
function publishedPorts(text) {
  return Object.entries(parseYaml(text)?.services ?? {}).flatMap(([service, body]) => (body?.ports ?? []).map((port) => {
    const host = typeof port === 'string' ? /^(?:(?:127\.0\.0\.1|\[::1\]):)?(\d+):\d+(?:\/(?:tcp|udp))?$/.exec(port)?.[1] : port?.published;
    return { service, host: Number(host) };
  }));
}
// The plan of the ports of the packs: each runtime and each service publishes exactly one port, as a list of one number, and no pack publishes another port. The three Bid Desks run one image in three compose files, and each has a pair of ports of its own.
const PACK_PORTS = {
  [serverCompose('reorder-agent')]: { runtime: [8101], service: [9101] },
  [serverCompose('order-desk')]: { 'runtime-small': [8102], 'runtime-medium': [8103], 'runtime-large': [8104], service: [9102] },
  [serverCompose('prior-authorization-agent')]: { runtime: [8105], service: [9103] },
  [serverCompose('insurer-intake-agent')]: { runtime: [8106], service: [9104] },
  [serverCompose('bid-desk-alfa')]: { runtime: [8108], service: [9106] },
  [serverCompose('bid-desk-bravo')]: { runtime: [8109], service: [9107] },
  [serverCompose('bid-desk-charlie')]: { runtime: [8110], service: [9108] },
  [serverCompose('sourcing-agent')]: { runtime: [8107], service: [9105] },
};
// The rows of the plan in the README of the agents host, in its section "Folders and ports": a label, a count in brackets and a port or a range.
const planRows = (readme) => [...section(readme, 'Folders and ports').matchAll(/^\| [A-Za-z][^|]*? \((\d+)\) \| (\d+)(?: to (\d+))? \|$/gm)].map((m) => ({ count: Number(m[1]), from: Number(m[2]), to: Number(m[3] ?? m[2]) }));
// The faults of the ports: the plan of the packs, a host port that stands once in all the compose files of the two hosts, and a row of the README plan for each port of the agents host.
function portProblems(texts, packPorts, readme) {
  const problems = [];
  for (const [file, expected] of Object.entries(packPorts)) {
    // The ports of each service as a list, in the order of the file: an extra port, listed first or last, is a fault.
    const found = {};
    for (const { service, host } of publishedPorts(texts[file] ?? '')) (found[service] ??= []).push(host);
    if (!isDeepStrictEqual(found, expected)) problems.push(`${file} must publish ${JSON.stringify(expected)} and no other port; found ${JSON.stringify(found)}`);
  }
  const owners = new Map();
  for (const [file, text] of Object.entries(texts)) for (const { service, host } of publishedPorts(text)) owners.set(host, [...(owners.get(host) ?? []), `${file}#${service}`]);
  for (const [port, users] of owners) if (users.length > 1) problems.push(`the port ${port} is published twice: ${users.join(', ')}`);
  const rows = planRows(readme);
  for (const row of rows) if (row.to - row.from + 1 !== row.count) problems.push(`a row of the plan in the README gives ${row.count} ports for the range ${row.from} to ${row.to}`);
  rows.forEach((row, i) => rows.slice(i + 1).forEach((next) => { if (row.from <= next.to && next.from <= row.to) problems.push(`two rows of the plan in the README overlap: ${row.from} to ${row.to} and ${next.from} to ${next.to}`); }));
  for (const [file, text] of Object.entries(texts)) {
    if (!file.startsWith('deploy/server/')) continue;
    for (const { service, host } of publishedPorts(text)) if (!rows.some((row) => row.from <= host && host <= row.to)) problems.push(`${file}#${service} publishes ${host}, and no row of the plan in the README holds that port`);
  }
  return problems;
}

test('agents host ports: the compose files of the two packs of use case 1, of the two packs of use case 2, of the three Bid Desks and of the Sourcing Agent publish exactly 8101 to 8110 and 9101 to 9108, no host port stands twice in the compose files of the two hosts, and the plan in the README of the agents host holds each port of the agents host; the guard refuses each copy that breaks one rule', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  const readme = srvRead('README.md');
  assert.deepEqual(Object.values(PACK_PORTS).flatMap((ports) => Object.values(ports).flat()).sort(), [8101, 8102, 8103, 8104, 8105, 8106, 8107, 8108, 8109, 8110, 9101, 9102, 9103, 9104, 9105, 9106, 9107, 9108], 'the runtimes on 8101 to 8110, and the services on 9101 to 9108');
  assert.deepEqual(portProblems(texts, PACK_PORTS, readme), [], 'the real files pass');
  const reorder = serverCompose('reorder-agent');
  const orders = serverCompose('order-desk');
  const mock = serverCompose('mock-systems');
  const [alfa, bravo, charlie] = ['alfa', 'bravo', 'charlie'].map((name) => serverCompose(`bid-desk-${name}`));
  const sourcing = serverCompose('sourcing-agent');
  const row8101 = readme.split('\n').find((line) => /^\| [A-Za-z][^|]*? \(\d+\) \| 8101(?: to \d+)? \|$/.test(line));
  assert.ok(row8101, 'the README plan has a row that holds 8101');
  const faults = [
    ['the runtime of the Reorder Agent on another port', texts, { [reorder]: srvReplace(texts[reorder], '127.0.0.1:8101:8080', '127.0.0.1:8105:8080') }, readme, /reorder-agent\.yml must publish/],
    ['the service of the Order Desk on another port', texts, { [orders]: srvReplace(texts[orders], '127.0.0.1:9102:9102', '127.0.0.1:9103:9102') }, readme, /order-desk\.yml must publish/],
    ['a second port on the service of the Order Desk', texts, { [orders]: srvReplace(texts[orders], '["127.0.0.1:9102:9102"]', '["127.0.0.1:9102:9102", "127.0.0.1:9109:9109"]') }, readme, /order-desk\.yml must publish/],
    ['an extra port listed first on the service of the Order Desk', texts, { [orders]: srvReplace(texts[orders], '["127.0.0.1:9102:9102"]', '["127.0.0.1:9109:9109", "127.0.0.1:9102:9102"]') }, readme, /order-desk\.yml must publish .* found .*"service":\[9109,9102\]/],
    ['an extra port listed first on the runtime of the Reorder Agent', texts, { [reorder]: srvReplace(texts[reorder], '["127.0.0.1:8101:8080"]', '["127.0.0.1:8110:8080", "127.0.0.1:8101:8080"]') }, readme, /reorder-agent\.yml must publish .* found .*"runtime":\[8110,8101\]/],
    ['a port that no pack of the plan uses', texts, { [reorder]: srvReplace(texts[reorder], 'services:\n', 'services:\n  extra:\n    image: example\n    ports: ["127.0.0.1:8110:8080"]\n') }, readme, /reorder-agent\.yml must publish/],
    ['a port that two runtimes of the Order Desk share', texts, { [orders]: srvReplace(texts[orders], '127.0.0.1:8103:8080', '127.0.0.1:8102:8080') }, readme, /the port 8102 is published twice/],
    ['a port of the Reorder Agent that the present host uses', texts, { [reorder]: srvReplace(texts[reorder], '127.0.0.1:8101:8080', '127.0.0.1:8083:8080') }, readme, /the port 8083 is published twice/],
    ['the port of the mock service that the plan in the README does not hold', texts, { [mock]: srvReplace(texts[mock], '127.0.0.1:9120:9120', '127.0.0.1:9200:9120') }, readme, /mock-systems\.yml#mock-systems publishes 9200, and no row of the plan/],
    ['the runtime of the Bid Desk alfa on another port', texts, { [alfa]: srvReplace(texts[alfa], '127.0.0.1:8108:8080', '127.0.0.1:8107:8080') }, readme, /bid-desk-alfa\.yml must publish/],
    ['a second port on the service of the Bid Desk bravo', texts, { [bravo]: srvReplace(texts[bravo], '["127.0.0.1:9107:9106"]', '["127.0.0.1:9107:9106", "127.0.0.1:9105:9105"]') }, readme, /bid-desk-bravo\.yml must publish/],
    ['an extra port listed first on the runtime of the Bid Desk charlie', texts, { [charlie]: srvReplace(texts[charlie], '["127.0.0.1:8110:8080"]', '["127.0.0.1:8107:8080", "127.0.0.1:8110:8080"]') }, readme, /bid-desk-charlie\.yml must publish .* found .*"runtime":\[8107,8110\]/],
    ['a port that two Bid Desks share', texts, { [bravo]: srvReplace(texts[bravo], '127.0.0.1:9107:9106', '127.0.0.1:9106:9106') }, readme, /the port 9106 is published twice: \S+bid-desk-alfa\.yml#service, \S+bid-desk-bravo\.yml#service/],
    ['the runtime of the Sourcing Agent on another port', texts, { [sourcing]: srvReplace(texts[sourcing], '127.0.0.1:8107:8080', '127.0.0.1:8111:8080') }, readme, /sourcing-agent\.yml must publish/],
    ['a second port on the service of the Sourcing Agent', texts, { [sourcing]: srvReplace(texts[sourcing], '["127.0.0.1:9105:9105"]', '["127.0.0.1:9105:9105", "127.0.0.1:9109:9109"]') }, readme, /sourcing-agent\.yml must publish/],
    ['the service of the Sourcing Agent on the port of a Bid Desk', texts, { [sourcing]: srvReplace(texts[sourcing], '127.0.0.1:9105:9105', '127.0.0.1:9106:9105') }, readme, /the port 9106 is published twice: \S+bid-desk-alfa\.yml#service, \S+sourcing-agent\.yml#service/],
    ['a README plan that leaves out the port of the Reorder Agent runtime', texts, {}, srvReplace(readme, `${row8101}\n`, ''), /reorder-agent\.yml#runtime publishes 8101, and no row of the plan/],
    ['two rows of the README plan that overlap', texts, {}, srvReplace(readme, `${row8101}\n`, `${row8101}\n| Overlap (1) | 8101 |\n`), /two rows of the plan in the README overlap/],
    ['a row of the README plan with a wrong count', texts, {}, srvReplace(readme, row8101, row8101.replace(/\((\d+)\)/, '(99)')), /a row of the plan in the README gives 99 ports/],
  ];
  for (const [name, base, changed, text, expected] of faults) {
    const problems = portProblems({ ...base, ...changed }, PACK_PORTS, text);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the long form of a port, with the same numbers, and the compose files of the two hosts in another order.
  const long = srvReplace(texts[reorder], '["127.0.0.1:8101:8080"]', '[{ target: 8080, published: 8101, host_ip: 127.0.0.1 }]');
  assert.deepEqual(portProblems({ ...texts, [reorder]: long }, PACK_PORTS, readme), [], 'the long form');
  assert.deepEqual(portProblems(Object.fromEntries(Object.entries(texts).reverse()), PACK_PORTS, readme), [], 'the files in another order');
});

test('use case 1 guards: the compose files that end in .yml and in .yaml are read in both folders by the guards of the images, the ports and the digests, and a file with another name is not a compose file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compose-names-'));
  try {
    const compose = (port, image) => `services:\n  x:\n    image: ${image}\n    ports: ["127.0.0.1:${port}:8080"]\n`;
    const files = {
      'deploy/host/docker-compose.a.yml': compose(8083, 'example'),
      'deploy/host/docker-compose.b.yaml': compose(8084, `${RT.image}:latest`),
      'deploy/server/docker-compose.yaml': compose(8083, `${IMAGE_REPOSITORY}/extra@sha256:<digest>`),
      'deploy/server/docker-compose.c.yml': compose(8101, 'example'),
      // Names that are not compose files: another ending, a backup, no docker-compose at the start, a prefix, and a note.
      'deploy/server/docker-compose.d.json': '{}', 'deploy/server/docker-compose.e.yml.bak': 'x', 'deploy/server/compose.f.yml': 'x', 'deploy/server/my-docker-compose.g.yml': 'x', 'deploy/server/README.md': 'x',
    };
    for (const folder of ['deploy/host', 'deploy/server']) mkdirSync(join(dir, folder), { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const texts = composeTextsOf(['deploy/host', 'deploy/server'], dir);
    assert.deepEqual(Object.keys(texts), ['deploy/host/docker-compose.a.yml', 'deploy/host/docker-compose.b.yaml', 'deploy/server/docker-compose.c.yml', 'deploy/server/docker-compose.yaml'], 'the four compose files, and none of the five other names');
    // Each guard finds the fault that sits in a file that ends in .yaml.
    assert.ok(composeImageProblems(CI_IMAGES, texts).some((p) => /deploy\/server\/docker-compose\.yaml#x names the image \S+\/extra, and no row/.test(p)), 'the guard of the images reads a .yaml file');
    assert.ok(portProblems(texts, {}, srvRead('README.md')).some((p) => /the port 8083 is published twice: deploy\/host\/docker-compose\.a\.yml#x, deploy\/server\/docker-compose\.yaml#x/.test(p)), 'the guard of the ports reads a .yaml file');
    const tagged = Object.entries(texts).filter(([, text]) => runtimeReferenceProblems(text).length > 0).map(([file]) => file);
    assert.deepEqual(tagged, ['deploy/host/docker-compose.b.yaml'], 'the guard of the digests reads a .yaml file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The purchase order read by the parser of the kit and by the reader of the purchase order store of the mock service, in one process. The store takes the tenant from the URL, and its router
// takes only a name of the form TENANT there, so an order whose tenant has another form never reaches the reader.
const PO_DRIFT_CODE = String.raw`
import { parsePurchaseOrder as store } from './src/documents.ts';
import { TENANT } from './src/validate.ts';
import { parsePurchaseOrder as kit } from '../../packages/usecase-kit/src/inventory/index.ts';
const verdict = (run) => { try { return { ok: true, value: run() }; } catch (error) { return { ok: false, message: String(error.message) }; } };
console.log(JSON.stringify(JSON.parse(process.argv[1]).map((order) => {
  const tenant = order !== null && typeof order === 'object' ? order.tenant : undefined;
  const mock = typeof tenant === 'string' && TENANT.test(tenant) ? verdict(() => store(order, tenant)) : { ok: false, message: 'the tenant is not a name for the URL' };
  const parsed = verdict(() => kit(order));
  return { mock, kit: parsed.ok && parsed.value.ok ? { ok: true, value: parsed.value.value } : { ok: false, message: parsed.ok ? parsed.value.detail : parsed.message } };
})));
`;

test('use case 1 drift: the purchase order is read in the same way by the parser of the kit and by the purchase order store of the mock service, for each golden order and for each edge of each member', () => {
  const golden = JSON.parse(read('packages/usecase-kit/test/inventory/golden/po.json'));
  const edit = (changes) => ({ ...golden, ...changes });
  const without = (member) => Object.fromEntries(Object.entries(golden).filter(([name]) => name !== member));
  const hex = (pair, times = 32) => pair.repeat(times);
  const goldens = [
    ['the golden of the kit', golden],
    ['the golden of the Reorder Agent, in the proposal', JSON.parse(read('agents/reorder-agent/test/propose/golden/po.json'))],
    ['the golden of the Reorder Agent, in the prompt of the model', JSON.parse(read('agents/reorder-agent/test/model/golden/po.json'))],
    // The order that the tests of the purchase order store send to it (services/mock-systems/test/documents.test.ts).
    ['the order of the tests of the mock service', { schema: 'vector.usecase.po.v1', po_number: 'run1-1', tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-01', supplier_did: `did:vector:${hex('a1')}`, advert_ref: `${hex('c3')}#0`, stock_reading_sha256: hex('d4') }],
  ];
  const ownProto = JSON.parse(`${JSON.stringify(golden).slice(0, -1)},"__proto__":{}}`);
  assert.ok(Object.hasOwn(ownProto, '__proto__'), 'the document has the key __proto__ of its own');
  // [name, order, true when both read it]
  const cases = [
    ...goldens.map(([name, order]) => [name, order, true]),
    ['the members in another order', Object.fromEntries(Object.entries(golden).reverse()), true],
    ['a po_number of 64 characters', edit({ po_number: `a${'0'.repeat(63)}` }), true],
    ['a po_number of 65 characters', edit({ po_number: `a${'0'.repeat(64)}` }), false],
    ['a po_number with a dot, a hyphen and an underscore', edit({ po_number: 'run1.a-b_c' }), true],
    ['a po_number with a space', edit({ po_number: 'run1 1' }), false],
    ['a po_number that starts with a dot', edit({ po_number: '.run1' }), false],
    ['a po_number with a letter that is not ASCII', edit({ po_number: 'run\u00e91' }), false],
    ['a po_number that is a number', edit({ po_number: 1 }), false],
    ['a sku in lower case', edit({ sku: 'glv-nit-m' }), true],
    ['a sku with the Kelvin sign, which NFC turns into K', edit({ sku: '\u212A-1' }), false],
    ['an empty sku', edit({ sku: '' }), false],
    ['a tenant of 48 characters', edit({ tenant: `a${'0'.repeat(47)}` }), true],
    ['a tenant of 49 characters', edit({ tenant: `a${'0'.repeat(48)}` }), false],
    ['a tenant in upper case', edit({ tenant: 'RUN1' }), false],
    ['a tenant with an underscore', edit({ tenant: 'run_1' }), false],
    ['a tenant that starts with a hyphen', edit({ tenant: '-run1' }), false],
    ['an empty tenant', edit({ tenant: '' }), false],
    ['the lot small', edit({ lot: 'lot-small' }), true],
    ['the lot large', edit({ lot: 'lot-large' }), true],
    ['a lot that is none of the three', edit({ lot: 'lot-huge' }), false],
    ['a lot name without its prefix', edit({ lot: 'medium' }), false],
    ['the least quantity', edit({ quantity: 1 }), true],
    ['the greatest quantity', edit({ quantity: 1_000_000 }), true],
    ['a quantity of 0', edit({ quantity: 0 }), false],
    ['a quantity over the greatest', edit({ quantity: 1_000_001 }), false],
    ['a negative quantity', edit({ quantity: -1 }), false],
    ['a fraction as the quantity', edit({ quantity: 1.5 }), false],
    ['the quantity as a text', edit({ quantity: '50' }), false],
    ['a date on the 29th of February in a leap year', edit({ needed_by: '2028-02-29' }), true],
    ['a date that does not exist', edit({ needed_by: '2026-02-30' }), false],
    ['a date in the 29th of February of a year that is not a leap year', edit({ needed_by: '2027-02-29' }), false],
    ['a date with one digit for the month', edit({ needed_by: '2026-1-01' }), false],
    ['a date with a time', edit({ needed_by: '2026-12-01T00:00:00Z' }), false],
    ['a date with a line break at the end', edit({ needed_by: '2026-12-01\n' }), false],
    ['a date in the year 0099', edit({ needed_by: '0099-01-01' }), false],
    ['a DID in upper case', edit({ supplier_did: `did:vector:${hex('D5')}` }), false],
    ['a DID of 63 hex digits', edit({ supplier_did: `did:vector:${hex('d5').slice(1)}` }), false],
    ['a DID of another method', edit({ supplier_did: `did:other:${hex('d5')}` }), false],
    ['an advert reference with the index 0', edit({ advert_ref: `${hex('a7')}#0` }), true],
    ['an advert reference with an index of 6 digits', edit({ advert_ref: `${hex('a7')}#123456` }), true],
    ['an advert reference with an index of 7 digits', edit({ advert_ref: `${hex('a7')}#1234567` }), false],
    ['an advert reference with a leading zero in the index', edit({ advert_ref: `${hex('a7')}#01` }), false],
    ['an advert reference with a hash in upper case', edit({ advert_ref: `${hex('A7')}#1` }), false],
    ['an advert reference with no index', edit({ advert_ref: hex('a7') }), false],
    ['a digest in upper case', edit({ stock_reading_sha256: hex('5E') }), false],
    ['a digest of 63 hex digits', edit({ stock_reading_sha256: hex('5e').slice(1) }), false],
    ['another schema', edit({ schema: 'vector.usecase.po.v2' }), false],
    ['a member that is not listed', edit({ carrier: 'x' }), false],
    ['a member that is missing', without('lot'), false],
    ['the key __proto__ of its own', ownProto, false],
    ['no document', null, false],
    ['a list', [], false],
    ['a text', 'x', false],
  ];
  const answers = inMockService(PO_DRIFT_CODE, cases.map(([, order]) => order));
  assert.equal(answers.length, cases.length);
  cases.forEach(([name, , both], i) => {
    const { mock, kit } = answers[i];
    assert.equal(kit.ok, both, `${name}: the kit ${both ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(kit)}`);
    assert.equal(mock.ok, both, `${name}: the purchase order store ${both ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(mock)}`);
    // Both read an order in one form: the same members, in the same order, with the same values.
    if (both) assert.equal(JSON.stringify(kit.value), JSON.stringify(mock.value), `${name}: both give one order`);
  });
  assert.ok(cases.filter(([, , both]) => both).length >= 10 && cases.filter(([, , both]) => !both).length >= 30, 'the table has the accepted twins and the refused copies');
});

// The lots file of the Order Desk against the default catalogue of the mock service: each SKU of the file has the lot sizes of the catalogue, and the file holds each SKU of the catalogue.
const LOTS_DRIFT_CODE = String.raw`
import { LOT_NAMES, defaultSeed } from './src/seed.ts';
import { LOT_NAMES as KIT_LOT_NAMES } from '../../packages/usecase-kit/src/inventory/index.ts';
console.log(JSON.stringify({ catalogue: defaultSeed().catalogue.map((entry) => ({ sku: entry.sku, lots: entry.lot_sizes })), names: [LOT_NAMES, KIT_LOT_NAMES] }));
`;
function lotsDriftProblems(file, catalogue) {
  const problems = [];
  const items = Array.isArray(file?.items) ? file.items : [];
  const sizes = new Map(catalogue.map((entry) => [entry.sku, entry.lots]));
  for (const item of items) {
    if (!sizes.has(item.sku)) problems.push(`the lots file holds ${item.sku}, and the catalogue of the mock service does not`);
    else if (!isDeepStrictEqual(item.lots, sizes.get(item.sku))) problems.push(`${item.sku}: the lots file gives ${JSON.stringify(item.lots)}, and the catalogue gives ${JSON.stringify(sizes.get(item.sku))}`);
  }
  for (const sku of sizes.keys()) if (!items.some((item) => item.sku === sku)) problems.push(`the catalogue holds ${sku}, and the lots file does not`);
  return problems;
}

test('use case 1 drift: the lots file of the Order Desk gives the lot sizes of each SKU of the default catalogue of the mock service, and holds each SKU of it; the guard refuses a size that changed, a SKU that is missing and a SKU that the catalogue does not hold', () => {
  const { catalogue, names } = inMockService(LOTS_DRIFT_CODE, null);
  assert.deepEqual(names[0], names[1], 'the mock service and the kit have the same lot names, in the same order');
  assert.ok(catalogue.length >= 3, `the catalogue has the SKUs of the seed, found ${catalogue.length}`);
  const file = JSON.parse(read('agents/order-desk/lots.json'));
  assert.deepEqual(lotsDriftProblems(file, catalogue), [], 'the real file passes');
  assert.deepEqual(file.items.map((item) => item.sku).sort(), catalogue.map((entry) => entry.sku).sort(), 'the same SKUs');
  const edited = (change) => { const copy = structuredClone(file); change(copy.items); return copy; };
  const faults = [
    ['a lot size that changed', edited((items) => { items[0].lots['lot-medium'] += 1; }), /lots file gives/],
    ['the largest lot of a SKU as the smallest', edited((items) => { items[1].lots['lot-small'] = items[1].lots['lot-large']; }), /lots file gives/],
    ['a lot that is missing from a SKU', edited((items) => { delete items[2].lots['lot-large']; }), /lots file gives/],
    ['a lot that the catalogue does not have', edited((items) => { items[0].lots['lot-huge'] = 5; }), /lots file gives/],
    ['a SKU that the file leaves out', edited((items) => { items.pop(); }), /the catalogue holds \S+, and the lots file does not/],
    ['a SKU that the catalogue does not hold', edited((items) => { items.push({ sku: 'EXTRA-1', lots: { 'lot-small': 1, 'lot-medium': 2, 'lot-large': 3 } }); }), /the lots file holds EXTRA-1, and the catalogue/],
    ['a SKU under another name', edited((items) => { items[0].sku = 'GLV-NIT-L'; }), /the lots file holds GLV-NIT-L/],
  ];
  for (const [name, broken, expected] of faults) {
    const problems = lotsDriftProblems(broken, catalogue);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the items in another order, and the lots of an item in another order.
  assert.deepEqual(lotsDriftProblems(edited((items) => { items.reverse(); }), catalogue), [], 'the items in another order');
  assert.deepEqual(lotsDriftProblems(edited((items) => { items[0].lots = Object.fromEntries(Object.entries(items[0].lots).reverse()); }), catalogue), [], 'the lots in another order');
});

// The order that the supplier portal of the mock service takes, as its reader names the members: the reader names the first member that is missing, so each name is added until it stops, and a
// member that it does not name is refused. The order that the Order Desk places is a part of its confirmation: the confirmation keeps its members.
const ORDER_MEMBERS_CODE = String.raw`
import { parseSupplierOrder } from './src/documents.ts';
const body = {};
const names = [];
for (let i = 0; i < 32; i += 1) {
  try { parseSupplierOrder(body); break; } catch (error) {
    const found = /^body\.([a-z_0-9]+) is required$/.exec(String(error.message));
    if (found === null) break;
    names.push(found[1]);
    body[found[1]] = null;
  }
}
const refusal = (run) => { try { run(); return 'accepted'; } catch (error) { return String(error.message); } };
const extra = refusal(() => parseSupplierOrder({ ...body, zz_probe: null }));
const orders = JSON.parse(process.argv[1]).map((confirmation) => refusal(() => parseSupplierOrder(Object.fromEntries(names.map((name) => [name, confirmation[name]])))));
console.log(JSON.stringify({ names, extra, orders }));
`;
// The members of a confirmation: the schema and the outcome, then the order that the portal takes, then what the Order Desk adds.
function confirmationDriftProblems(members, names) {
  const expected = ['schema', 'outcome', ...names, 'order_id', 'sender', 'approval', 'checks', 'decisions', 'fault_mode'];
  return isDeepStrictEqual(members, expected) ? [] : [`the confirmation must have the members ${expected.join(', ')}, with the order that the portal takes after the outcome; found: ${members.join(', ')}`];
}

test('use case 1 drift: the confirmation of the kit has the members of the order that the supplier portal of the mock service takes, and the members of the order in it are an order that the portal reads; the guard refuses a member that is added, one that is renamed and one that is missing', () => {
  const goldens = [
    ['packages/usecase-kit/test/inventory/golden/confirmation.json', JSON.parse(read('packages/usecase-kit/test/inventory/golden/confirmation.json'))],
    ['agents/order-desk/test/job/golden/confirmation.json', JSON.parse(read('agents/order-desk/test/job/golden/confirmation.json'))],
    ['agents/reorder-agent/test/model/golden/confirmation.json', JSON.parse(read('agents/reorder-agent/test/model/golden/confirmation.json'))],
  ];
  const { names, extra, orders } = inMockService(ORDER_MEMBERS_CODE, goldens.map(([, confirmation]) => confirmation));
  assert.deepEqual(names, ['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by'], 'the reader of the portal names six members');
  assert.match(extra, /^body\.zz_probe is not a field of this object$/, 'and refuses another member');
  goldens.forEach(([file, confirmation], i) => {
    assert.deepEqual(confirmationDriftProblems(Object.keys(confirmation), names), [], `${file}: the members`);
    assert.equal(orders[i], 'accepted', `${file}: the order in it is an order that the portal reads`);
  });
  const members = Object.keys(goldens[0][1]);
  const faults = [
    ['a member added to the confirmation', [...members, 'carrier'], names],
    ['a member added in the middle of the order', [...members.slice(0, 4), 'carrier', ...members.slice(4)], names],
    ['a member of the order renamed', members.map((name) => (name === 'ship_by' ? 'ship_date' : name)), names],
    ['a member of the order that is missing', members.filter((name) => name !== 'po_sha256'), names],
    ['a member added to the order of the portal', members, [...names, 'carrier']],
    ['a member of the order of the portal renamed', members, names.map((name) => (name === 'quantity' ? 'amount' : name))],
    ['the members of the order in another order', [...members.slice(0, 2), ...names.slice().reverse(), ...members.slice(2 + names.length)], names],
  ];
  for (const [name, given, accepted] of faults) {
    const problems = confirmationDriftProblems(given, accepted);
    assert.equal(problems.length, 1, `${name}: found ${JSON.stringify(problems)}`);
  }
  assert.deepEqual(confirmationDriftProblems(members, names), [], 'the twin: the members of the golden');
});

// ---- The README and the RUNBOOK of the agents host, and the ignore file of the build context, for the packs of use case 1 ----
test('use case 1 README: the table of the files has a row for each of the nine files of the two packs, and each file is there', () => {
  const readme = srvRead('README.md');
  for (const file of USE_CASE_1_FILES) {
    const name = file.slice(`${SRV}/`.length);
    assert.ok(readme.includes(`| \`${name}\` | `), `${name} has a row`);
    assert.ok(existsSync(join(root, file)), `${name} is there`);
  }
  assert.equal(section(readme, 'The files').split('\n').filter((line) => /^\| `[^`]*(?:order-desk|reorder-agent)[^`]*` \|/.test(line)).length, 9, 'nine rows for the two packs');
});

test('use case 1 README: the section of a host whose proxy runs in a container gives the one mounted Caddyfile, the markers of the blocks, the join of the network, the write in place, the check and the reload, and what a new Caddy container needs; the markers and the network are those of the two packs', () => {
  const readme = srvRead('README.md');
  const text = section(readme, 'A host whose proxy runs in a container');
  assert.ok(text.length > 0, 'the section is there');
  const at = (heading) => readme.indexOf(`\n## ${heading}\n`);
  assert.ok(at('The snippet of an agent') > 0 && at('The snippet of an agent') < at('A host whose proxy runs in a container') && at('A host whose proxy runs in a container') < at('DNS'), 'after the snippet of an agent, before DNS');
  // The markers of each snippet and the network of each project are the ones that the section gives, with the name of the agent in place of <agent> and <project>.
  for (const [snippet, composeFile] of [['Caddyfile.reorder-agent.snippet', 'docker-compose.reorder-agent.yml'], ['Caddyfile.order-desk.snippet', 'docker-compose.order-desk.yml']]) {
    const agent = /^# (\S+) vhosts \(BEGIN\)$/m.exec(srvRead(snippet))?.[1];
    assert.ok(agent, `${snippet} has its BEGIN marker`);
    assert.ok(srvRead(snippet).includes(`\n# ${agent} vhosts (END)\n`), `${snippet} has its END marker`);
    assert.equal(parseYaml(srvRead(composeFile)).name, agent, `the project of ${composeFile} is the name in the markers`);
    assert.ok(srvRead(snippet).includes(`docker network connect ${agent}_default <caddy container>`), `${snippet} gives the join`);
  }
  const parts = [
    '# <agent> vhosts (BEGIN)', '# <agent> vhosts (END)', 'docker network connect <project>_default <caddy container>', '`<caddy container>`', '`<caddyfile>`',
    'caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile', 'caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile', 'Valid configuration', 'in place', 'Never restart Caddy',
    'again after each new Caddy container', 'RUNBOOK-reorder-agent.md', 'RUNBOOK-order-desk.md', 'section "The Caddy block"',
  ];
  for (const part of parts) assert.ok(text.includes(part), part);
  assert.doesNotMatch(readme, HOST_WORDS, 'the README names no host, no proxy stack, no login and no key file');
  // The files of the host with the proxy in a container are in the one Caddyfile: the lines about the snippet folder say that they are for Caddy on the host.
  for (const part of ['when Caddy runs on the host', 'Caddy on the host reaches a container by its port on `127.0.0.1`', 'Caddy in a container reaches it by its container name']) assert.ok(readme.includes(part), part);
  // The packs fit a proxy in a container only. The mock service names its container there, and only the Caddy container joins the network of a project.
  for (const part of ['they fit no other: their upstreams are container names, and Caddy on the host cannot resolve them', 'Only the Caddy container joins it', '`127.0.0.1` in a Caddy container is the container itself', '`reverse_proxy mock-systems:9120`', 'the Caddy container joins `mock-systems_default`']) assert.ok(text.includes(part), part);
  const mockCompose = parseYaml(srvRead('docker-compose.mock-systems.yml'));
  assert.deepEqual([mockCompose.name, mockCompose.services['mock-systems'].container_name, mockCompose.services['mock-systems'].environment.PORT], ['mock-systems', 'mock-systems', '9120'], 'the project, the container and the port that the README names for the mock service');
  for (const part of ['On a host whose proxy runs in a container, the block of the mock service uses `mock-systems:9120`', 'or on `mock-systems:9120` when the proxy is a container', 'When the proxy is a container, only the Caddy container joins it.']) assert.ok(readme.includes(part), part);
  assert.doesNotMatch(readme, /no other container joins that network/, 'no line says that no container but the project joins the network, where the Caddy container joins it');
  // The agents of deploy/host build their runtime on the host, so the README does not say that the host builds no image: it says it of the agents of this folder.
  assert.doesNotMatch(readme, /The host builds no image/, 'no line denies the build of the agents of deploy/host');
  assert.equal(readme.split('The agents of this folder build no image on the host.').length - 1, 2, 'the opening and the rules say that the agents of this folder build no image on the host');
});

test('use case 1 README: the memory arithmetic of the six containers adds up, and the host stays above the gate of 1,024 MiB after the six containers start', () => {
  const text = section(srvRead('README.md'), 'The host');
  const number = (value) => Number(value.replaceAll(',', ''));
  const sizes = Object.fromEntries([...text.matchAll(/^\| ([A-Za-z][^|]*?) \| ([\d,]+) \|$/gm)].map((m) => [m[1], number(m[2])]));
  assert.deepEqual(Object.keys(sizes), ['Reorder Agent runtime', 'Reorder Agent service', 'Order Desk runtimes (3)', 'Order Desk service', 'The six containers', 'Prior Authorization Agent runtime', 'Prior Authorization Agent service', 'Insurer Intake Agent runtime', 'Insurer Intake Agent service', 'The four containers', 'Sourcing Agent runtime', 'Sourcing Agent service', 'Bid Desk runtimes (3)', 'Bid Desk services (3)', 'The eight containers']);
  assert.equal(sizes['Order Desk runtimes (3)'], 3 * sizes['Reorder Agent runtime'], 'three runtimes of one size');
  assert.equal(sizes['Reorder Agent service'], sizes['Order Desk service'], 'the two services have the planning size of a new service');
  const total = sizes['Reorder Agent runtime'] + sizes['Reorder Agent service'] + sizes['Order Desk runtimes (3)'] + sizes['Order Desk service'];
  assert.equal(sizes['The six containers'], total, 'the six containers are the sum of the rows');
  const after = Object.fromEntries([...text.matchAll(/^\| (The mock service runs|The six containers run) \| ([\d,]+) \| ([\d,]+) \| (.+) \|$/gm)].map((m) => [m[1], [number(m[2]), number(m[3]), m[4]]]));
  const [typical, lowest] = after['The mock service runs'];
  const [typicalAfter, lowestAfter, gate] = after['The six containers run'];
  assert.deepEqual([typicalAfter, lowestAfter], [typical - total, lowest - total], 'after the start, the memory is the memory before it less the six containers');
  assert.ok(lowestAfter >= 1024, 'the lowest case stays above the gate');
  assert.ok(gate.includes(`${lowestAfter - 1024} MiB of margin in the lowest case`), 'the margin is the lowest case less the gate');
  // The peaks: one job in each service adds 2 x (200 + 200) MiB, and 4 calls of the co-sign route add 4 x 100 MiB. The later containers (two runtimes and two services) do not pass the gate.
  const fmt = (value) => value.toLocaleString('en-US');
  for (const part of [`${fmt(typicalAfter - 800)} MiB in the typical case and ${fmt(lowestAfter - 800)} MiB in the lowest case`, `${fmt(typicalAfter - 1200)} MiB and ${fmt(lowestAfter - 1200)} MiB`, 'about 800 MiB', 'up to 4 calls', 'about 100 MiB for each call']) assert.ok(text.includes(part), part);
  const later = 2 * sizes['Reorder Agent runtime'] + 2 * sizes['Reorder Agent service'];
  assert.ok(typicalAfter - later < 1024 && lowestAfter - later < 1024, 'four more containers at the planning sizes do not pass the gate, in either case');
  assert.ok(text.includes('At the planning sizes, the fourth start fails the gate in the typical case'), 'and the README says so');
  for (const part of ['169 MiB in `docker stats`', '`MemAvailable` fell by 462 MiB', '4,074 MiB to 3,612 MiB', 'The gate is 1,024 MiB', 'The host builds none of the images of use case 1', 'The agents of `deploy/host` build their runtime on the host', '`mem_limit`', 'The gate is for a start, not for a peak']) assert.ok(text.includes(part), part);
  // The figures come from a host that also runs the agents of deploy/host, so a new host needs its own measurement, and the text does not deny the build of those agents.
  assert.ok(text.includes('The figures in this section were measured on a host that also runs the agents of `deploy/host`. A new host needs its own measurement.'), 'where the figures come from');
  assert.doesNotMatch(text, /no build counts here/, 'the text does not deny every build');
  // The plan holds the mock service, the six containers of use case 1, the four of use case 2 and the eight of use case 3, and no container after them (the test of the plan of the ports counts the 19).
  assert.ok(text.includes('The plan holds no container after these eighteen, and the mock service with them makes the 19. So the containers of use case 2 and of use case 3 need more memory, or a real size below the planning size, before all of them start. Measure the real size of each container at its first start.'), 'the memory text says what the opening says: no container comes after the eighteen');
  assert.doesNotMatch(text, /3\.3 GiB/, 'the old total of the 19 containers is gone');
});

test('use case 1 RUNBOOK: step 7 points to the runbooks of the two packs, and names the two ways to put a block in the proxy, the snippet folder and the marker block', () => {
  const runbook = srvRead('RUNBOOK.md');
  const step = section(runbook, '7. Add an agent');
  for (const file of ['RUNBOOK-reorder-agent.md', 'RUNBOOK-order-desk.md']) assert.ok(step.includes(`\`${file}\``) && existsSync(join(root, SRV, file)), file);
  for (const part of ['Snippet folder.', 'Marker block.', '/etc/caddy/agents/<agent>.snippet', 'section "A host whose proxy runs in a container"', 'in place', 'section "The Caddy block"']) assert.ok(step.includes(part), part);
  // The packs of use case 1 fit the marker block only: their upstreams are container names, and Caddy on the host cannot resolve them. The paragraph and the two ways say so.
  const [paragraph, ways] = step.split('\n1. ');
  assert.ok(paragraph.includes('They fit the marker block only: their upstreams are container names, and Caddy on the host cannot resolve them.'), 'the paragraph');
  const [snippetFolder, markerBlock] = ways.split('   - Marker block.');
  assert.ok(snippetFolder.includes('The packs of use case 1 do not fit this way.'), 'the snippet folder is not for the packs');
  assert.ok(markerBlock.includes('The packs of use case 1 use this way only.'), 'the marker block is for the packs');
  for (const snippet of ['Caddyfile.reorder-agent.snippet', 'Caddyfile.order-desk.snippet']) {
    const upstreams = srvRead(snippet).split('\n').filter((line) => /^\s*reverse_proxy /.test(line));
    assert.ok(upstreams.length > 0 && upstreams.every((line) => !/127\.0\.0\.1|localhost/.test(line)), `${snippet}: the upstreams are container names`);
  }
  // Step 8 takes a block out in the same two ways, each in its own order. With the snippet folder the containers stop first. With the marker block the block goes first, then the Caddy container
  // leaves the network of the project, and then the down command runs, as the Back out section of each pack says.
  const eight = section(runbook, '8. Remove an agent');
  for (const part of ['Snippet folder.', 'Marker block.', 'section "Back out"', 'Do not use `-v`']) assert.ok(eight.includes(part), `step 8: ${part}`);
  const [stopFirst, blockFirst] = eight.split('   - Marker block.');
  const down = 'docker compose -f <compose file> down';
  assert.ok(stopFirst.includes(down) && stopFirst.indexOf(down) < stopFirst.indexOf('sudo rm /etc/caddy/agents/<agent>.snippet'), 'snippet folder: the containers stop before the snippet is removed');
  const at = (part) => blockFirst.indexOf(part);
  const leave = 'docker network disconnect <project>_default <caddy container>';
  assert.ok(at('Take the block out first') >= 0 && at('Take the block out first') < at('reload Caddy') && at('reload Caddy') < at(leave) && at(leave) < at(down), 'marker block: the block goes, then the Caddy container leaves the network, then down');
  assert.ok(blockFirst.includes('Leave the network of the project before the `down` command, because the Caddy container is on it.'), 'and the text says why');
});

// The Dockerfiles that build from the repo root: each COPY of a folder takes the folder whole, with its test folders. The ignore file keeps every folder named test out of the context.
const copiedFolders = (dockerfile) => [...dockerfile.matchAll(/^COPY (?!--)(\S+) \S+$/gm)].map((m) => m[1]).filter((src) => existsSync(join(root, src)) && statSync(join(root, src)).isDirectory());
function folderNamesIn(dir, name, found = []) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    if (entry.name === name) found.push(`${dir}/${entry.name}`);
    else folderNamesIn(`${dir}/${entry.name}`, name, found);
  }
  return found;
}
// The ignore file as the Docker builders read it: each line is a rule, and the last rule that matches a path, or a folder above it, decides. A line with a leading ! puts the path back. `**` crosses
// folders, and `*` and `?` stop at a slash.
function ignoreRulesOf(text) {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).map((line) => {
    const exclusion = line.startsWith('!');
    const glob = (exclusion ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    let source = '';
    for (let at = 0; at < glob.length; at += 1) {
      const char = glob[at];
      if (char === '*' && glob[at + 1] === '*') {
        at += 1;
        if (glob[at + 1] === '/') at += 1;
        source += at + 1 >= glob.length ? '.*' : '(.*/)?';
      } else if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    }
    return { exclusion, pattern: new RegExp(`^${source}$`) };
  });
}
function reachesContext(rules, path) {
  const parts = path.split('/');
  const folders = parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'));
  let ignored = false;
  for (const rule of rules) {
    if (rule.exclusion !== ignored) continue;
    if (rule.pattern.test(path) || folders.some((folder) => rule.pattern.test(folder))) ignored = !rule.exclusion;
  }
  return !ignored;
}
// The folders that a COPY takes whole and that hold a test folder, which the ignore file does not keep out of the build context. The last line that matches the test folder decides: a re-include
// that stands below the line for every folder named test brings the test folders of the re-included folder back, unless a line below it puts them out again.
function dockerignoreProblems(ignoreText, folders) {
  const rules = ignoreRulesOf(ignoreText);
  return folders.flatMap((folder) => folderNamesIn(folder, 'test').filter((path) => reachesContext(rules, path)).map((path) => `${path} is copied into an image: the ignore file keeps no test folder out`));
}

test('dockerignore: no image holds a test folder, and the first comment line names the Dockerfiles that build from the repo root; the last line that matches decides, and the guard refuses an ignore file that leaves a test folder in', () => {
  const ignore = read('.dockerignore');
  const lines = ignore.split('\n');
  const rows = CI_IMAGES.filter((row) => row.context === '.');
  const folders = [...new Set(rows.flatMap((row) => copiedFolders(read(row.file))))];
  const withTests = folders.filter((folder) => folderNamesIn(folder, 'test').length > 0);
  // The kit packages are copied whole by the agent images, with their test folders. The two agents of use case 1 copy their source folder only.
  for (const folder of ['packages/usecase-kit', 'packages/hire-kit', 'packages/service-kit', 'packages/id-kit', 'agents/audio-snippets']) assert.ok(withTests.includes(folder), `${folder} is copied whole and holds a test folder: ${withTests.join(', ')}`);
  assert.deepEqual(['agents/reorder-agent', 'agents/order-desk'].filter((folder) => folders.includes(folder)), [], 'the two agents of use case 1 are not copied whole');
  const TEST_LINES = ['**/test', 'scripts/**/test'];
  assert.ok(TEST_LINES.every((line) => lines.includes(line)), 'the ignore file has the line for every folder named test, and the line that leaves them out again after the re-includes of the scripts folder');
  assert.deepEqual(dockerignoreProblems(ignore, folders), [], 'the real file passes');
  const tests = withTests.flatMap((folder) => folderNamesIn(folder, 'test'));
  const named = (path) => `${path} is copied into an image: the ignore file keeps no test folder out`;
  const text = (...dropped) => lines.filter((line) => !dropped.includes(line)).join('\n');
  const refused = dockerignoreProblems(text(...TEST_LINES), folders);
  assert.ok(refused.includes(named('packages/usecase-kit/test')), `a file with no line for the test folders is refused: ${JSON.stringify(refused)}`);
  assert.deepEqual(refused, tests.map(named), 'each test folder is named once');
  // The last line that matches decides. The re-includes of the scripts folder stand below `**/test`, so they bring the test folder of the pack back, and the line below them puts it out again.
  assert.deepEqual(dockerignoreProblems(text('scripts/**/test'), folders), [named('scripts/operator/test')], 'without the line below the re-includes, the test folder of the pack comes back');
  const above = lines.filter((line) => line !== 'scripts/**/test').flatMap((line) => (line === '!scripts/operator' ? ['scripts/**/test', line] : [line])).join('\n');
  assert.deepEqual(dockerignoreProblems(above, folders), [named('scripts/operator/test')], 'the line for the scripts folder above the re-includes does not hold');
  assert.deepEqual(dockerignoreProblems(text('**/test'), folders), tests.filter((path) => !path.startsWith('scripts/')).map(named), 'without the line for every folder, the test folders of the packages and the agents come back');
  // The twins: the path of each test folder in place of the lines, a line that leaves out more, and the line below the re-includes at depth one, where the test folder of the pack is.
  assert.deepEqual(dockerignoreProblems([text(...TEST_LINES), ...tests].join('\n'), folders), [], 'a path for each test folder');
  assert.equal(dockerignoreProblems([text(...TEST_LINES), ...tests.slice(1)].join('\n'), folders).length, 1, 'one test folder left out of the list');
  assert.deepEqual(dockerignoreProblems(`${ignore}*.tmp\n`, folders), [], 'a line that leaves out more');
  assert.deepEqual(dockerignoreProblems(rtChange(ignore, 'scripts/**/test\n', 'scripts/*/test\n'), folders), [], 'the line at depth one');
  // The first comment line names the Dockerfiles of the repo root context.
  for (const row of rows) assert.ok(lines[0].includes(row.file), `${row.file} is named in the first comment line`);
  assert.equal(lines[0].includes(RT.dockerfile), false, 'the runtime Dockerfile has another context');
});

// ======================================================================================================================================
// Use case 2 (prior authorization): the Prior Authorization Agent and the Insurer Intake Agent. The tests of each pack hold its files on their own (agents/*/test/deploy.test.ts). These tests read
// more than one place: the tracked files of the repository, the compose files of both hosts, the README of the agents host, the README of each agent, and the parsers that the kit, the two agents and
// the mock service use for the documents that they pass to each other. The drift tests run the real TypeScript of the kit and of the mock service in one child process, as the tests of use case 1 do.
// Each guard has an accepted twin and refused copies.
// ======================================================================================================================================
const PRIORAUTH_PACK = ['deploy/server/docker-compose.prior-authorization-agent.yml', 'deploy/server/.env.prior-authorization-agent.example', 'deploy/server/Caddyfile.prior-authorization-agent.snippet', 'deploy/server/RUNBOOK-prior-authorization-agent.md'];
const INTAKE_PACK = ['deploy/server/docker-compose.insurer-intake-agent.yml', 'deploy/server/.env.insurer-intake-agent.example', 'deploy/server/Caddyfile.insurer-intake-agent.snippet', 'deploy/server/RUNBOOK-insurer-intake-agent.md'];
const USE_CASE_2_FILES = [...PRIORAUTH_PACK, ...INTAKE_PACK];

test('use case 2 files: the eight files of the two deploy packs are tracked by git, and none names the host, the stack of its reverse proxy, a login or a key file; the guard refuses a file that is not tracked and a file that names the host', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  assert.equal(USE_CASE_2_FILES.length, 8, 'four files for each of the two agents');
  assert.equal(new Set([...USE_CASE_1_FILES, ...USE_CASE_2_FILES]).size, 17, 'none of the eight is a file of use case 1');
  for (const file of USE_CASE_2_FILES) assert.ok(existsSync(join(root, file)), `${file} is there`);
  assert.deepEqual(trackedFileProblems(USE_CASE_2_FILES, TRACKED, read), [], 'the real files pass');
  for (const pack of [PRIORAUTH_PACK, INTAKE_PACK]) {
    const [compose, , , runbook] = pack;
    assert.deepEqual(trackedFileProblems(pack, TRACKED.filter((file) => file !== runbook), read), [`${runbook} is not tracked by git`], 'a file that is not tracked');
    for (const part of ['the apex' + '-web box', 'uma' + 'mi_default', 'root' + '@host', 'id_' + 'ed25519']) {
      const text = (file) => (file === compose ? `${read(file)}# ${part}\n` : read(file));
      assert.deepEqual(trackedFileProblems(pack, TRACKED, text), [`${compose} names the host, the stack of its reverse proxy, a login or a key file`], part);
    }
    // The twin: the names that a pack holds on purpose: the public host name of the agent, the folder of the pack and the word host.
    const origin = /^ +PUBLIC_ORIGIN: https:\/\/(\S+)$/m.exec(read(compose))?.[1];
    assert.ok(origin, `${compose} gives the public origin of the runtime`);
    const twin = (file) => (file === compose ? `${read(file)}# ${origin} in deploy/server on the agents host\n` : read(file));
    assert.deepEqual(trackedFileProblems(pack, TRACKED, twin), [], 'the names of the pack');
  }
});

// The rows of the plan of the ports in the README of the agents host, with their labels: a label, a count in brackets and a port or a range.
const labelledRows = (readme) => [...section(readme, 'Folders and ports').matchAll(/^\| ([A-Za-z][^|]*?) \((\d+)\) \| (\d+)(?: to (\d+))? \|$/gm)].map((m) => ({ label: m[1], count: Number(m[2]), from: Number(m[3]), to: Number(m[4] ?? m[3]) }));

test('use case 2 ports: the compose files of the two packs publish exactly 8105, 8106, 9103 and 9104, no host port stands twice in the compose files of the two hosts, and the plan in the README of the agents host has a row for each of the four ports; the guard refuses each copy that breaks one rule', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  const readme = srvRead('README.md');
  const prior = serverCompose('prior-authorization-agent');
  const intake = serverCompose('insurer-intake-agent');
  const rows = Object.fromEntries(labelledRows(readme).map((row) => [row.label, row]));
  for (const [name, file, runtimePort, servicePort] of [['Prior Authorization Agent', prior, 8105, 9103], ['Insurer Intake Agent', intake, 8106, 9104]]) {
    assert.deepEqual(PACK_PORTS[file], { runtime: [runtimePort], service: [servicePort] }, `${name}: the ports that the guard expects of the compose file`);
    for (const [kind, port] of [['runtime', runtimePort], ['service', servicePort]]) {
      assert.deepEqual(rows[`${name} ${kind}`], { label: `${name} ${kind}`, count: 1, from: port, to: port }, `${name} ${kind}: the row of the plan in the README`);
    }
  }
  assert.deepEqual(portProblems(texts, PACK_PORTS, readme), [], 'the real files pass');
  const rowLine = (label) => readme.split('\n').find((line) => line.startsWith(`| ${label} (`));
  const faults = [
    ['the runtime of the Prior Authorization Agent on another port', { [prior]: srvReplace(texts[prior], '127.0.0.1:8105:8080', '127.0.0.1:8111:8080') }, readme, /prior-authorization-agent\.yml must publish/],
    ['the service of the Prior Authorization Agent on the port of the other service', { [prior]: srvReplace(texts[prior], '127.0.0.1:9103:9103', '127.0.0.1:9104:9103') }, readme, /the port 9104 is published twice/],
    ['the runtime of the Insurer Intake Agent on the port of the other runtime', { [intake]: srvReplace(texts[intake], '127.0.0.1:8106:8080', '127.0.0.1:8105:8080') }, readme, /the port 8105 is published twice/],
    ['the service of the Insurer Intake Agent on a port that the plan does not hold', { [intake]: srvReplace(texts[intake], '127.0.0.1:9104:9104', '127.0.0.1:9109:9104') }, readme, /insurer-intake-agent\.yml#service publishes 9109, and no row of the plan/],
    ['a second port on the service of the Insurer Intake Agent', { [intake]: srvReplace(texts[intake], '["127.0.0.1:9104:9104"]', '["127.0.0.1:9104:9104", "127.0.0.1:9108:9108"]') }, readme, /insurer-intake-agent\.yml must publish/],
    ['the runtime of the Prior Authorization Agent on a port of use case 1', { [prior]: srvReplace(texts[prior], '127.0.0.1:8105:8080', '127.0.0.1:8101:8080') }, readme, /the port 8101 is published twice/],
    ['a README plan that leaves out the row of the Insurer Intake Agent runtime', {}, srvReplace(readme, `${rowLine('Insurer Intake Agent runtime')}\n`, ''), /insurer-intake-agent\.yml#runtime publishes 8106, and no row of the plan/],
    ['a row of the README plan with a wrong count', {}, srvReplace(readme, rowLine('Prior Authorization Agent service'), rowLine('Prior Authorization Agent service').replace(/\((\d+)\)/, '(99)')), /a row of the plan in the README gives 99 ports/],
    ['two rows of the README plan that overlap', {}, srvReplace(readme, `${rowLine('Prior Authorization Agent runtime')}\n`, `${rowLine('Prior Authorization Agent runtime')}\n| Overlap (1) | 8105 |\n`), /two rows of the plan in the README overlap/],
  ];
  for (const [name, changed, text, expected] of faults) {
    const problems = portProblems({ ...texts, ...changed }, PACK_PORTS, text);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the long form of a port, with the same numbers, and the compose files of the two hosts in another order.
  const long = srvReplace(texts[prior], '["127.0.0.1:8105:8080"]', '[{ target: 8080, published: 8105, host_ip: 127.0.0.1 }]');
  assert.deepEqual(portProblems({ ...texts, [prior]: long }, PACK_PORTS, readme), [], 'the long form');
  assert.deepEqual(portProblems(Object.fromEntries(Object.entries(texts).reverse()), PACK_PORTS, readme), [], 'the files in another order');
});

// What the README of an agent says about its deploy pack, held to the pack. The Deploy section names the compose file, the env example and the runbook, in this order, and each is there. The README gives
// the port of the service twice, in the Image section and in the table of settings, and the compose file publishes that port on the host and in the container, and gives it to the service as PORT.
function readmePackProblems(readme, pack, composeText, exists) {
  const problems = [];
  const named = [...section(readme, 'Deploy').matchAll(/`(deploy\/server\/[^`]+)`/g)].map((m) => m[1]);
  const expected = pack.filter((file) => !file.includes('Caddyfile'));
  if (!isDeepStrictEqual(named, expected)) problems.push(`the Deploy section must name ${expected.join(', ')}, in this order; it names ${named.join(', ') || 'no file'}`);
  for (const file of named) if (!exists(file)) problems.push(`the Deploy section names ${file}, and no such file is there`);
  const service = parseYaml(composeText)?.services?.service;
  const mapping = service?.ports?.length === 1 ? service.ports[0] : null;
  const published = publishedPorts(composeText).filter((port) => port.service === 'service').map((port) => port.host);
  const inside = typeof mapping === 'string' ? Number(mapping.split(':').at(-1)) : mapping?.target;
  const given = Number(service?.environment?.PORT);
  const stated = [['the Image section', /listens on (\d+) and answers/.exec(readme)?.[1]], ['the table of settings', /^\| `PORT`, `HOST` \| .* \| `(\d+)`, `0\.0\.0\.0` \|$/m.exec(readme)?.[1]]];
  for (const [where, value] of stated) {
    if (value === undefined) problems.push(`the README does not give the port of the service in ${where}`);
    else if (!isDeepStrictEqual([published, inside, given], [[Number(value)], Number(value), Number(value)])) problems.push(`${where} of the README says that the service listens on ${value}, and the compose file publishes ${published.join(', ')}, maps it to ${inside} and sets PORT ${given}`);
  }
  return problems;
}

test('use case 2 README of each agent: the Deploy section names the three files of its pack, each file is there, and the port that the README gives for the service is the port that the compose file publishes; the guard refuses each copy that breaks one rule', () => {
  for (const [agent, pack, port] of [['prior-authorization-agent', PRIORAUTH_PACK, 9103], ['insurer-intake-agent', INTAKE_PACK, 9104]]) {
    const readme = read(`agents/${agent}/README.md`);
    const composeText = read(pack[0]);
    const there = (file) => existsSync(join(root, file));
    assert.deepEqual(readmePackProblems(readme, pack, composeText, there), [], `${agent}: the real files pass`);
    const faults = [
      ['the Image section gives another port', srvReplace(readme, `listens on ${port} and answers`, `listens on ${port + 6} and answers`), composeText, there, /the Image section of the README says that the service listens on/],
      ['the table of settings gives another port', srvReplace(readme, `\`${port}\`, \`0.0.0.0\``, `\`${port + 6}\`, \`0.0.0.0\``), composeText, there, /the table of settings of the README says that the service listens on/],
      ['the compose file publishes another port', readme, srvReplace(composeText, `127.0.0.1:${port}:${port}`, `127.0.0.1:${port + 6}:${port}`), there, /the Image section of the README says that the service listens on/],
      ['the compose file gives another PORT to the service', readme, srvReplace(composeText, `PORT: "${port}"`, `PORT: "${port + 6}"`), there, /sets PORT/],
      ['the runbook that the Deploy section names is not there', readme, composeText, (file) => !file.includes('RUNBOOK-') && there(file), /no such file is there/],
      ['the Deploy section names the example under another name', srvReplace(readme, `.env.${agent}.example`, '.env.example'), composeText, there, /the Deploy section must name/],
    ];
    for (const [name, readmeText, composeFile, exists, expected] of faults) {
      const problems = readmePackProblems(readmeText, pack, composeFile, exists);
      assert.ok(problems.some((p) => expected.test(p)), `${agent}, ${name}: found ${JSON.stringify(problems)}`);
    }
    // The twin: the long form of the port, with the same numbers.
    const long = srvReplace(composeText, `["127.0.0.1:${port}:${port}"]`, `[{ target: ${port}, published: ${port}, host_ip: 127.0.0.1 }]`);
    assert.deepEqual(readmePackProblems(readme, pack, long, there), [], `${agent}: the long form`);
  }
});

// The documents of use case 2 that the kit, the two agents and the mock service read. The mock service is the system on the other side: the insurer portal files a request, the records system takes a
// submission, and the seed of a tenant holds the record sets, the guidelines and the requirement sets. One child process loads the real TypeScript of the mock service and of the kit, so that nothing
// here re-implements a parser. The documents go in on the standard input: a long list does not fit in one argument of a command.
const jsonOf = (file) => JSON.parse(read(file));
const inMockServiceStdin = (code, arg) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: join(root, 'services/mock-systems'), encoding: 'utf8', input: JSON.stringify(arg), maxBuffer: 64 * 1024 ** 2 }));
const KIT_GOLDENS = 'packages/usecase-kit/test/priorauth/golden';
const PRIOR_TESTS = 'agents/prior-authorization-agent/test';
const REQUEST_GOLDENS = [`${KIT_GOLDENS}/request.json`, `${PRIOR_TESTS}/model/golden/request.json`, `${PRIOR_TESTS}/propose/golden/request.json`, `${PRIOR_TESTS}/execute/golden/request.json`];

// The request, as the kit reads it and as the mock service reads the members that it takes. The portal reads the schema, the tenant, the request number and the service code, and it keeps the rest of the
// request as it came. The tenant is the one of the URL, and the router takes a name of the form TENANT only. The records system reads the order of a record set and its records, and the guideline store
// reads the criteria of a guideline: the request copies the identifiers of the order, its diagnosis codes, the references of the records and the references of the criteria.
const REQUEST_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { parseIntake } from './src/documents.ts';
import { parseSeed } from './src/seed.ts';
import { TENANT } from './src/validate.ts';
import { parsePriorAuthRequest } from '../../packages/usecase-kit/src/priorauth/index.ts';
const accepted = (run) => { try { run(); return true; } catch (error) { if (error?.name !== 'Invalid') throw error; return false; } };
const ORDER = { order_id: 'ORD-1', patient_ref: 'SYN-PT-1', service_code: 'SYN-MRI-LS', service_description: 'Imaging', diagnosis_codes: ['M54.16'], ordering_clinician_ref: 'SYN-CL-1', ordered_at: '2026-10-22' };
const RECORD = { record_id: 'REC-1', type: 'note', recorded_at: '2026-10-22', summary: 'A note.' };
const GUIDELINE = { code: 'SYN-MRI-LS', title: 'Imaging', version: '1', criteria: [], documentation: [] };
const many = (count, make) => Array.from({ length: count }, (_, i) => make(i + 1));
const mock = {
  intake: (request) => typeof request?.tenant === 'string' && TENANT.test(request.tenant) && accepted(() => parseIntake({ request, status: 'complete', missing: [] }, request.tenant)),
  order: (_, member, value) => accepted(() => parseSeed('seed', { records: [{ order: { ...ORDER, [member]: value }, records: [RECORD] }] })),
  records: (_, count) => accepted(() => parseSeed('seed', { records: [{ order: ORDER, records: many(count, (n) => ({ ...RECORD, record_id: 'REC-' + n })) }] })),
  criteria: (_, count) => accepted(() => parseSeed('seed', { guidelines: [{ ...GUIDELINE, criteria: many(count, (n) => ({ id: 'C' + n, text: 'A criterion.' })) }] })),
};
console.log(JSON.stringify(JSON.parse(readFileSync(0, 'utf8')).map(([request, [reader, ...args]]) => ({ kit: parsePriorAuthRequest(request).ok, mock: mock[reader](request, ...args) }))));
`;

test('use case 2 drift: the authorization request is read in the same way by the parser of the kit and by the insurer portal and the records system of the mock service, for each golden request and for each edge of each member that the two read', () => {
  const golden = jsonOf(REQUEST_GOLDENS[0]);
  const edit = (changes) => ({ ...golden, ...changes });
  const fill = (count, char = 'a') => char.repeat(count);
  const codes = (count) => Array.from({ length: count }, (_, i) => `M${i}`);
  const refs = (count, prefix) => Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
  const portal = ['intake'];
  // [name, request, how the mock service reads the member, whether the kit takes it, whether the mock service takes it]
  const viaOrder = (name, member, value, both) => [name, edit({ [member]: value }), ['order', member, value], both, both];
  const cases = [
    ...REQUEST_GOLDENS.map((file) => [file, jsonOf(file), portal, true, true]),
    ['a request number of 64 characters', edit({ request_number: `a${fill(63, '0')}` }), portal, true, true],
    ['a request number of 65 characters', edit({ request_number: `a${fill(64, '0')}` }), portal, false, false],
    ['a request number with a dot, a hyphen and an underscore', edit({ request_number: 'run1.a-b_c' }), portal, true, true],
    ['a request number with a space', edit({ request_number: 'run1 1' }), portal, false, false],
    ['a request number that starts with a dot', edit({ request_number: '.run1' }), portal, false, false],
    ['a request number with a letter that is not ASCII', edit({ request_number: 'run\u00e91' }), portal, false, false],
    ['a request number that is a number', edit({ request_number: 1 }), portal, false, false],
    ['a service code of 64 characters', edit({ service_code: `A${fill(63, '0')}` }), portal, true, true],
    ['a service code of 65 characters', edit({ service_code: `A${fill(64, '0')}` }), portal, false, false],
    ['a service code with the Kelvin sign, which NFC turns into K', edit({ service_code: '\u212A-1' }), portal, false, false],
    ['a tenant of 48 characters', edit({ tenant: `a${fill(47, '0')}` }), portal, true, true],
    ['a tenant of 49 characters', edit({ tenant: `a${fill(48, '0')}` }), portal, false, false],
    ['a tenant in upper case', edit({ tenant: 'RUN1' }), portal, false, false],
    ['a tenant with an underscore', edit({ tenant: 'run_1' }), portal, false, false],
    ['another schema', edit({ schema: 'vector.usecase.priorauth-request.v2' }), portal, false, false],
    viaOrder('an order id of 64 characters', 'order_id', `A${fill(63, '0')}`, true),
    viaOrder('an order id of 65 characters', 'order_id', `A${fill(64, '0')}`, false),
    viaOrder('an order id that starts with a dot', 'order_id', '.ORD-1', false),
    viaOrder('a patient reference of 64 characters', 'patient_ref', `A${fill(63, '0')}`, true),
    viaOrder('a patient reference of 65 characters', 'patient_ref', `A${fill(64, '0')}`, false),
    viaOrder('a clinician reference of 64 characters', 'ordering_clinician_ref', `A${fill(63, '0')}`, true),
    viaOrder('a clinician reference of 65 characters', 'ordering_clinician_ref', `A${fill(64, '0')}`, false),
    viaOrder('8 diagnosis codes', 'diagnosis_codes', codes(8), true),
    viaOrder('9 diagnosis codes', 'diagnosis_codes', codes(9), false),
    viaOrder('no diagnosis code', 'diagnosis_codes', [], false),
    viaOrder('a diagnosis code of 16 characters', 'diagnosis_codes', [fill(16)], true),
    viaOrder('a diagnosis code of 17 characters', 'diagnosis_codes', [fill(17)], false),
    viaOrder('an empty diagnosis code', 'diagnosis_codes', [''], false),
    ['50 references to records', edit({ record_refs: refs(50, 'REC-') }), ['records', 50], true, true],
    ['51 references to records', edit({ record_refs: refs(51, 'REC-') }), ['records', 51], false, false],
    ['20 references to criteria', edit({ guideline_refs: refs(20, 'C') }), ['criteria', 20], true, true],
    ['21 references to criteria', edit({ guideline_refs: refs(21, 'C') }), ['criteria', 21], false, false],
  ];
  const answers = inMockServiceStdin(REQUEST_DRIFT_CODE, cases.map(([, request, probe]) => [request, probe]));
  assert.equal(answers.length, cases.length);
  cases.forEach(([name, , , kit, mock], i) => {
    assert.equal(answers[i].kit, kit, `${name}: the kit ${kit ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(answers[i])}`);
    assert.equal(answers[i].mock, mock, `${name}: the mock service ${mock ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(answers[i])}`);
  });
  assert.ok(cases.filter(([, , , kit]) => kit).length >= 15 && cases.filter(([, , , kit]) => !kit).length >= 15, 'the table has the accepted twins and the refused copies');
});

// The intake record and what follows from it: the portal files the request with the status and the missing requirements of the record, and the Prior Authorization Agent writes the number of the request,
// the id of the intake and the status to the records system. The words of a status are the words that the readers name when they refuse one, so a word that one side adds is seen.
const INTAKE_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { parseIntake, parseSubmission } from './src/documents.ts';
import { INTAKE_STATUSES, parseIntakeRecord } from '../../packages/usecase-kit/src/priorauth/index.ts';
const { request, records, submissions, ids: edges } = JSON.parse(readFileSync(0, 'utf8'));
const refusal = (run) => { try { run(); return null; } catch (error) { if (error?.name !== 'Invalid') throw error; return String(error.message); } };
const words = (message) => /^body\.status must be one of (.+)$/.exec(message ?? '')?.[1].split(', ') ?? null;
const missing = (count) => Array.from({ length: count }, (_, i) => 'R' + (i + 1));
const incomplete = (count) => ({ ...records[0], status: 'incomplete', missing: missing(count), decisions: [{ ...records[0].decisions[0], choice: { complete: false, missing: missing(count) } }] });
const largest = (accepts) => { let count = 0; while (count < 40 && accepts(count + 1)) count += 1; return count; };
const portal = (status, list) => refusal(() => parseIntake({ request, status, missing: list }, request.tenant)) === null;
const submit = (body) => refusal(() => parseSubmission(body)) === null;
console.log(JSON.stringify({
  words: { kit: [...INTAKE_STATUSES], portal: words(refusal(() => parseIntake({ request, status: 'x', missing: [] }, request.tenant))), records: words(refusal(() => parseSubmission({ request_number: 'r1', intake_id: 'i1', status: 'x' }))) },
  most: { kit: largest((count) => parseIntakeRecord(incomplete(count)).ok), portal: largest((count) => portal('incomplete', missing(count))) },
  records: records.map((record) => ({ kit: parseIntakeRecord(record).ok, portal: portal(record.status, record.missing), submission: submit({ request_number: record.request_number, intake_id: record.intake_id, status: record.status }) })),
  submissions: submissions.map((body) => submit(body)),
  ids: edges.map(([member, value]) => ({ kit: parseIntakeRecord({ ...records[0], [member]: value }).ok, submission: submit({ request_number: records[0].request_number, intake_id: records[0].intake_id, status: records[0].status, [member]: value }) })),
}));
`;

test('use case 2 drift: the intake record of the kit and the insurer portal and the records system of the mock service say the same of the status and of the list of missing requirements, and the submission of the Prior Authorization Agent is a submission that the records system takes', () => {
  const request = jsonOf(REQUEST_GOLDENS[0]);
  const records = [`${KIT_GOLDENS}/intake-record.json`, 'agents/insurer-intake-agent/test/job/golden/intake-record-complete.json', 'agents/insurer-intake-agent/test/job/golden/intake-record-incomplete.json'].map(jsonOf);
  const submissions = [jsonOf(`${PRIOR_TESTS}/execute/golden/submission-body.json`)];
  const fill = (count) => 'a'.repeat(count);
  // [name, member of the record and of the body, value, whether both read it]
  const edges = [
    ['a request number of 64 characters', 'request_number', fill(64), true], ['a request number of 65 characters', 'request_number', fill(65), false], ['a request number with a dot, a hyphen and an underscore', 'request_number', 'run1.a-b_c', true],
    ['a request number that starts with a dot', 'request_number', '.run1', false], ['a request number with a space', 'request_number', 'run 1', false], ['an empty request number', 'request_number', '', false],
    ['an intake id of 64 characters', 'intake_id', fill(64), true], ['an intake id of 65 characters', 'intake_id', fill(65), false], ['an intake id with a dot, a hyphen and an underscore', 'intake_id', 'INT-run1_0001.a', true],
    ['an intake id that starts with a hyphen', 'intake_id', '-INT', false], ['an intake id with a space', 'intake_id', 'INT 1', false], ['an empty intake id', 'intake_id', '', false],
  ];
  const answer = inMockServiceStdin(INTAKE_DRIFT_CODE, { request, records, submissions, ids: edges.map(([, member, value]) => [member, value]) });
  assert.ok(answer.words.kit.length >= 2, `the kit has the words of the status; found ${JSON.stringify(answer.words)}`);
  assert.deepEqual(answer.words.kit, answer.words.portal, 'the status words of the kit are the words of the insurer portal, in the same order');
  assert.deepEqual(answer.words.kit, answer.words.records, 'and the words of the submission to the records system');
  assert.deepEqual([answer.most.kit, answer.most.portal], [20, 20], 'the record and the portal take the same number of missing requirements: at most 20');
  records.forEach((record, i) => assert.deepEqual(answer.records[i], { kit: true, portal: true, submission: true }, `golden record ${i}: the kit reads it, the portal files its status and its missing list, and the records system takes its submission`));
  assert.deepEqual(answer.submissions, [true], 'the golden body that the Prior Authorization Agent sends to the records system');
  assert.deepEqual(submissions[0], { request_number: records[0].request_number, intake_id: records[0].intake_id, status: records[0].status }, 'the body is the request number, the intake id and the status of the record');
  edges.forEach(([name, , , both], i) => {
    assert.equal(answer.ids[i].kit, both, `${name}: the record of the kit ${both ? 'must read it' : 'must refuse it'}`);
    assert.equal(answer.ids[i].submission, both, `${name}: the records system ${both ? 'must take it' : 'must refuse it'}`);
  });
});

// The record set, the guideline and the requirement set, as the kit reads them and as the seed of a tenant reads them. A tenant can be seeded with every document that the kit reads, and the kit reads
// every document of the default seed. The kit refuses a text that NFC makes longer than its limit, which the seed takes: no case below has such a text.
const RECORDS_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { defaultSeed, parseSeed } from './src/seed.ts';
import { parseGuideline, parseRecordSet, parseRequirementSet } from '../../packages/usecase-kit/src/priorauth/index.ts';
const KIT = { records: parseRecordSet, guidelines: parseGuideline, requirements: parseRequirementSet };
const accepted = (part, document) => { try { parseSeed('seed', { [part]: [document] }); return true; } catch (error) { if (error?.name !== 'Invalid') throw error; return false; } };
const seed = defaultSeed();
console.log(JSON.stringify({
  seed: Object.fromEntries(Object.keys(KIT).map((part) => [part, seed[part].map((document) => { const read = KIT[part](document); return read.ok && isDeepStrictEqual(read.value, document); })])),
  cases: JSON.parse(readFileSync(0, 'utf8')).map(([part, document]) => ({ kit: KIT[part](document).ok, mock: accepted(part, document) })),
}));
`;

test('use case 2 drift: the record set, the guideline and the requirement set are read in the same way by the parsers of the kit and by the seed of the mock service: every document of the default seed is a document of the kit, and every golden of the kit and of the Prior Authorization Agent can seed a tenant', () => {
  const goldens = [
    ['records', `${KIT_GOLDENS}/record-set.json`], ['guidelines', `${KIT_GOLDENS}/guideline.json`], ['requirements', `${KIT_GOLDENS}/requirements.json`],
    ['records', `${PRIOR_TESTS}/evidence/golden/record-set.json`], ['records', `${PRIOR_TESTS}/evidence/golden/record-set-knee.json`], ['guidelines', `${PRIOR_TESTS}/evidence/golden/guideline.json`], ['guidelines', `${PRIOR_TESTS}/evidence/golden/guideline-knee.json`],
    ['records', `${PRIOR_TESTS}/propose/golden/record-set.json`], ['guidelines', `${PRIOR_TESTS}/propose/golden/guideline.json`], ['records', `${PRIOR_TESTS}/model/golden/record-set.json`], ['guidelines', `${PRIOR_TESTS}/model/golden/guideline.json`],
  ];
  const [set, guideline, requirements] = goldens.slice(0, 3).map(([, file]) => jsonOf(file));
  const text = (count) => 'x'.repeat(count);
  const items = (count, prefix, sample) => Array.from({ length: count }, (_, i) => ({ id: `${prefix}${i + 1}`, text: sample }));
  const withOrder = (changes) => ({ ...set, order: { ...set.order, ...changes } });
  const withRecord = (changes) => ({ ...set, records: [{ ...set.records[0], ...changes }, ...set.records.slice(1)] });
  const withRecords = (count) => ({ ...set, records: Array.from({ length: count }, (_, i) => ({ ...set.records[0], record_id: `REC-${i + 1}` })) });
  const withCriteria = (count) => ({ ...guideline, criteria: items(count, 'C', guideline.criteria[0].text) });
  const withRequirements = (count) => ({ ...requirements, requirements: items(count, 'R', requirements.requirements[0].text) });
  // [part, name, document, whether both read it]
  const cases = [
    ...goldens.map(([part, file]) => [part, file, jsonOf(file), true]),
    ['records', 'a summary of 2,000 characters', withRecord({ summary: text(2000) }), true], ['records', 'a summary of 2,001 characters', withRecord({ summary: text(2001) }), false],
    ['records', 'a type of 32 characters', withRecord({ type: text(32) }), true], ['records', 'a type of 33 characters', withRecord({ type: text(33) }), false],
    ['records', 'a description of 200 characters', withOrder({ service_description: text(200) }), true], ['records', 'a description of 201 characters', withOrder({ service_description: text(201) }), false],
    ['records', '8 diagnosis codes', withOrder({ diagnosis_codes: Array.from({ length: 8 }, (_, i) => `M${i}`) }), true], ['records', '9 diagnosis codes', withOrder({ diagnosis_codes: Array.from({ length: 9 }, (_, i) => `M${i}`) }), false],
    ['records', 'a diagnosis code of 16 characters', withOrder({ diagnosis_codes: [text(16)] }), true], ['records', 'a diagnosis code of 17 characters', withOrder({ diagnosis_codes: [text(17)] }), false],
    ['records', 'no diagnosis code', withOrder({ diagnosis_codes: [] }), false], ['records', 'a date that does not exist', withOrder({ ordered_at: '2026-02-30' }), false],
    ['records', 'a member of the order that is not listed', withOrder({ carrier: 'x' }), false], ['records', 'a member of the order that is missing', withOrder({ patient_ref: undefined }), false],
    ['records', '50 records', withRecords(50), true], ['records', '51 records', withRecords(51), false], ['records', 'no record', withRecords(0), false],
    ['records', 'a record id two times', { ...set, records: [set.records[0], set.records[0]] }, false],
    ['guidelines', '20 criteria', withCriteria(20), true], ['guidelines', '21 criteria', withCriteria(21), false], ['guidelines', 'no criterion', withCriteria(0), false],
    ['guidelines', 'a criterion of 500 characters', { ...guideline, criteria: items(1, 'C', text(500)) }, true], ['guidelines', 'a criterion of 501 characters', { ...guideline, criteria: items(1, 'C', text(501)) }, false],
    ['guidelines', 'a title of 200 characters', { ...guideline, title: text(200) }, true], ['guidelines', 'a title of 201 characters', { ...guideline, title: text(201) }, false],
    ['guidelines', 'a version of 32 characters', { ...guideline, version: text(32) }, true], ['guidelines', 'a version of 33 characters', { ...guideline, version: text(33) }, false],
    ['guidelines', '20 lines of documentation', { ...guideline, documentation: Array.from({ length: 20 }, () => text(500)) }, true], ['guidelines', '21 lines of documentation', { ...guideline, documentation: Array.from({ length: 21 }, () => 'x') }, false],
    ['guidelines', 'no documentation', { ...guideline, documentation: [] }, true], ['guidelines', 'a criterion id two times', { ...guideline, criteria: [guideline.criteria[0], guideline.criteria[0]] }, false],
    ['requirements', '20 requirements', withRequirements(20), true], ['requirements', '21 requirements', withRequirements(21), false], ['requirements', 'no requirement', withRequirements(0), false],
    ['requirements', 'a requirement of 500 characters', { ...requirements, requirements: items(1, 'R', text(500)) }, true], ['requirements', 'a requirement of 501 characters', { ...requirements, requirements: items(1, 'R', text(501)) }, false],
    ['requirements', 'a title of 200 characters', { ...requirements, title: text(200) }, true], ['requirements', 'a title of 201 characters', { ...requirements, title: text(201) }, false],
    ['requirements', 'a requirement id two times', { ...requirements, requirements: [requirements.requirements[0], requirements.requirements[0]] }, false],
  ];
  const answer = inMockServiceStdin(RECORDS_DRIFT_CODE, cases.map(([part, , document]) => [part, document]));
  for (const part of ['records', 'guidelines', 'requirements']) {
    assert.ok(answer.seed[part].length >= 2 && answer.seed[part].every(Boolean), `${part}: each document of the default seed is a document that the kit reads, and the kit gives it back as it is; found ${JSON.stringify(answer.seed[part])}`);
  }
  assert.equal(answer.cases.length, cases.length);
  cases.forEach(([, name, , both], i) => {
    assert.equal(answer.cases[i].kit, both, `${name}: the kit ${both ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(answer.cases[i])}`);
    assert.equal(answer.cases[i].mock, both, `${name}: the seed of the mock service ${both ? 'must read it' : 'must refuse it'}; found ${JSON.stringify(answer.cases[i])}`);
  });
  assert.ok(cases.filter(([, , , both]) => both).length >= 20 && cases.filter(([, , , both]) => !both).length >= 20, 'the table has the accepted twins and the refused copies');
});

// ---- The README and the RUNBOOK of the agents host, for the packs of use case 2 ----
test('use case 2 README: the table of the files has a row for each of the eight files of the two packs, and each file is there', () => {
  const readme = srvRead('README.md');
  for (const file of USE_CASE_2_FILES) {
    const name = file.slice(`${SRV}/`.length);
    assert.ok(readme.includes(`| \`${name}\` | `), `${name} has a row`);
    assert.ok(existsSync(join(root, file)), `${name} is there`);
  }
  assert.equal(section(readme, 'The files').split('\n').filter((line) => /^\| `[^`]*(?:prior-authorization-agent|insurer-intake-agent)[^`]*` \|/.test(line)).length, 8, 'eight rows for the two packs');
});

test('use case 2 README: the memory arithmetic of the four containers adds up: the sizes, the memory before and after each start, the gate, and the largest service that the fourth start takes', () => {
  const text = section(srvRead('README.md'), 'The host');
  const number = (value) => Number(value.replaceAll(',', ''));
  const fmt = (value) => value.toLocaleString('en-US');
  const sizes = Object.fromEntries([...text.matchAll(/^\| ([A-Za-z][^|]*?) \| ([\d,]+) \|$/gm)].map((m) => [m[1], number(m[2])]));
  const order = ['Prior Authorization Agent service', 'Prior Authorization Agent runtime', 'Insurer Intake Agent service', 'Insurer Intake Agent runtime'];
  const [service, runtime] = [sizes['Reorder Agent service'], sizes['Reorder Agent runtime']];
  for (const name of order) assert.equal(sizes[name], name.endsWith('service') ? service : runtime, `${name}: the planning size of ${name.endsWith('service') ? 'a new service' : 'a runtime'}`);
  assert.equal(sizes['The four containers'], order.reduce((sum, name) => sum + sizes[name], 0), 'the four containers are the sum of the rows');
  // The memory before the first start is the memory after the six containers of use case 1 run.
  const six = /^\| The six containers run \| ([\d,]+) \| ([\d,]+) \|/m.exec(text);
  assert.ok(six, 'the table of use case 1 gives the memory after the six containers run');
  const [typical, lowest] = [number(six[1]), number(six[2])];
  const GATE = 1024;
  assert.ok(text.includes(`A start needs ${fmt(GATE)} MiB of \`MemAvailable\` before it.`), 'the gate');
  assert.ok(text.includes(`\`MemAvailable\` is about ${fmt(typical)} MiB in the typical case and ${fmt(lowest)} MiB in the lowest case.`), 'the memory before the first start');
  assert.ok(text.includes('They are estimates until the first start of a service is measured.'), 'the sizes are estimates');
  // The table of the starts: each column is built from the sizes. The memory before a start is the memory after the start before it, and a start that the gate refuses ends the column.
  const cells = (line) => line.split('|').slice(1, -1).map((cell) => cell.trim());
  const rows = text.split('\n').filter((line) => line.startsWith('| ') && cells(line).length === 5 && order.includes(cells(line)[0])).map(cells);
  assert.deepEqual(rows.map((row) => row[0]), order, 'the table has the four starts in their order: the service first, then the runtime, for each agent');
  const stops = [[1, typical], [3, lowest]].map(([column, start]) => {
    let memory = start;
    let stop = null;
    order.forEach((name, i) => {
      const [before, after] = [rows[i][column], rows[i][column + 1]];
      if (stop !== null) assert.deepEqual([before, after], ['', ''], `${name}: nothing after a start that fails the gate`);
      else if (memory < GATE) {
        assert.deepEqual([before, after], [`${fmt(memory)}, fails the gate`, ''], `${name}: fails the gate`);
        stop = [i, memory];
      } else {
        assert.deepEqual([before, after], [fmt(memory), fmt(memory - sizes[name])], `${name}: the memory before and after the start`);
        memory -= sizes[name];
      }
    });
    return stop;
  });
  assert.ok(stops.every((stop) => stop !== null), 'a start fails the gate in each case');
  const [[typicalAt, typicalBefore], [lowestAt, lowestBefore]] = stops;
  assert.deepEqual([typicalAt, lowestAt], [3, 1], 'the fourth start fails the gate in the typical case, and the second start in the lowest case');
  const ordinal = ['first', 'second', 'third', 'fourth'];
  assert.ok(text.includes(`At the planning sizes, the ${ordinal[typicalAt]} start fails the gate in the typical case (${fmt(typicalBefore)} MiB before it), and the ${ordinal[lowestAt]} start fails it in the lowest case (${fmt(lowestBefore)} MiB before it).`), 'the sentence about the two starts that fail');
  // S is the size of one service, with the runtimes at their planning size. The fourth start has the memory of the case, less the first three starts (two services and one runtime), and it needs the gate.
  const room = (start) => start - GATE;
  const most = (start) => Math.floor((room(start) - runtime) / 2);
  assert.deepEqual([most(typical), most(lowest)], [357, 32], 'the most that one service may take');
  for (const part of [
    `In the typical case, the fourth start passes only when \`2S + ${runtime} <= ${room(typical)}\` (${fmt(typical)} less ${fmt(GATE)}), so S is at most ${most(typical)} MiB.`,
    `In the lowest case, it needs \`2S + ${runtime} <= ${room(lowest)}\` (${fmt(lowest)} less ${fmt(GATE)}), so S is at most ${most(lowest)} MiB: no real service size passes.`,
  ]) assert.ok(text.includes(part), part);
  assert.ok(text.split('\n').some((line) => line.endsWith('A start that would fail the gate stops, and the owner of the host decides.')), 'the paragraph ends with the sentence that a start that would fail the gate stops');
});

test('use case 2 README: the section of a host whose proxy runs in a container names the two packs of use case 2 and their runbooks; the markers, the join of the network and the container names in the upstreams are those of the two packs', () => {
  const text = section(srvRead('README.md'), 'A host whose proxy runs in a container');
  assert.ok(text.length > 0, 'the section is there');
  for (const [snippetFile, composeFile, runbookFile] of [['Caddyfile.prior-authorization-agent.snippet', 'docker-compose.prior-authorization-agent.yml', 'RUNBOOK-prior-authorization-agent.md'], ['Caddyfile.insurer-intake-agent.snippet', 'docker-compose.insurer-intake-agent.yml', 'RUNBOOK-insurer-intake-agent.md']]) {
    const snippet = srvRead(snippetFile);
    const agent = /^# (\S+) vhosts \(BEGIN\)$/m.exec(snippet)?.[1];
    assert.ok(agent, `${snippetFile} has its BEGIN marker`);
    assert.ok(snippet.includes(`\n# ${agent} vhosts (END)\n`), `${snippetFile} has its END marker`);
    assert.equal(parseYaml(srvRead(composeFile)).name, agent, `the project of ${composeFile} is the name in the markers`);
    assert.ok(snippet.includes(`docker network connect ${agent}_default <caddy container>`), `${snippetFile} gives the join`);
    const upstreams = snippet.split('\n').filter((line) => /^\s*reverse_proxy /.test(line));
    assert.ok(upstreams.length > 0 && upstreams.every((line) => !/127\.0\.0\.1|localhost/.test(line)), `${snippetFile}: the upstreams are container names`);
    assert.ok(text.includes(`\`${runbookFile}\``) && existsSync(join(root, SRV, runbookFile)), `${runbookFile} is named and is there`);
  }
  for (const part of ['The packs of use case 2 (the Prior Authorization Agent and the Insurer Intake Agent) are written for such a host in the same way.', 'The runbooks of the two packs of use case 2 give them in the same way']) assert.ok(text.includes(part), part);
});

test('use case 2 RUNBOOK: step 7 points to the runbooks of the two packs of use case 2, and says that they fit the marker block only, as the packs of use case 1 do', () => {
  const step = section(srvRead('RUNBOOK.md'), '7. Add an agent');
  for (const file of ['RUNBOOK-prior-authorization-agent.md', 'RUNBOOK-insurer-intake-agent.md']) assert.ok(step.includes(`\`${file}\``) && existsSync(join(root, SRV, file)), file);
  const [paragraph, ways] = step.split('\n1. ');
  assert.ok(paragraph.includes('The packs of use case 2 (prior authorization) are the Prior Authorization Agent, with `RUNBOOK-prior-authorization-agent.md`, and the Insurer Intake Agent, with `RUNBOOK-insurer-intake-agent.md`.'), 'the paragraph names the two packs');
  assert.ok(paragraph.indexOf('The packs of use case 2') < paragraph.indexOf('They fit the marker block only:'), 'the sentence about the marker block follows the lists of all four packs');
  const [snippetFolder, markerBlock] = ways.split('   - Marker block.');
  assert.ok(snippetFolder.includes('The packs of use case 2 do not fit this way either.'), 'the snippet folder is not for the packs of use case 2');
  assert.ok(markerBlock.includes('The packs of use case 2 use this way only.'), 'the marker block is for the packs of use case 2');
});

// ======================================================================================================================================
// The operator pack (scripts/operator) and the deploy packs of use case 1. The tests of the pack hold the pack to its own code. These tests read more than one place: the files of the pack against the tracked files and
// the rules of the public text, the two runbooks and the two env examples of use case 1 against the list of the tasks of the pack, and the README and the runbook of the agents host. Each guard has refused copies
// and an accepted twin.
// ======================================================================================================================================

const OPERATOR_FOLDER = 'scripts/operator';
// The files of the pack that a reader meets: the README, the Dockerfile and every script file, the tests included.
const OPERATOR_FILES = [`${OPERATOR_FOLDER}/README.md`, `${OPERATOR_FOLDER}/Dockerfile`, ...sourceFiles(OPERATOR_FOLDER)];
// The faults of the files of the pack: a file that git does not track, the host, the stack of its reverse proxy, a login or a key file (the guard of the packs above), the name of a person, a path into a home folder,
// and, in the README and the Dockerfile, an em or en dash and the name of the unit.
function operatorFileProblems(files, tracked, textOf) {
  const problems = trackedFileProblems(files, tracked, textOf);
  for (const file of files) {
    const text = textOf(file);
    if (NAMES.test(text)) problems.push(`${file} names a person`);
    if (HOME_PATH.test(text)) problems.push(`${file} names a path in a home folder`);
    if (/(?:README\.md|Dockerfile)$/.test(file) && DASHES.test(text)) problems.push(`${file} holds an em dash or an en dash`);
    if (/(?:README\.md|Dockerfile)$/.test(file) && UNIT_NAME.test(text)) problems.push(`${file} names the unit: it is called units`);
  }
  return problems;
}

test('operator pack files: the README, the Dockerfile and the sources are tracked by git, and none names the host, a person or a home folder; the README and the Dockerfile hold no em or en dash and no name of the unit; the guard refuses each copy', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  assert.ok(OPERATOR_FILES.length > 80 && new Set(OPERATOR_FILES).size === OPERATOR_FILES.length, `the list reaches the files of the pack, found ${OPERATOR_FILES.length}`);
  for (const must of ['README.md', 'Dockerfile', 'cli.ts', 'lib/registry.ts', 'tasks/env.ts', 'usecases/inventory-reorder.ts', 'test/integration.test.ts']) assert.ok(OPERATOR_FILES.includes(`${OPERATOR_FOLDER}/${must}`), `${must} is in the list`);
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, read), [], 'the real files pass');
  const [readme, dockerfile] = OPERATOR_FILES;
  const source = `${OPERATOR_FOLDER}/cli.ts`;
  const withText = (file, extra) => (name) => (name === file ? `${read(name)}\n${extra}\n` : read(name));
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED.filter((file) => file !== source), read), [`${source} is not tracked by git`], 'a file that is not tracked');
  for (const part of ['the apex' + '-web box', 'uma' + 'mi_default', 'root' + '@host', 'id_' + 'ed25519', 'hetz' + 'ner']) {
    assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, withText(source, `// ${part}`)), [`${source} names the host, the stack of its reverse proxy, a login or a key file`], part);
  }
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, withText(readme, `Ask ${'Dan' + 'ielle'}.`)), [`${readme} names a person`], 'a person');
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, withText(source, '// see /home/someone/keys')), [`${source} names a path in a home folder`], 'a home folder');
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, withText(readme, `One step ${String.fromCharCode(0x2014)} two steps.`)), [`${readme} holds an em dash or an en dash`], 'an em dash');
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, withText(dockerfile, `# ${'AP' + '3X'}`)), [`${dockerfile} names the unit: it is called units`], 'the unit');
  // The twin: a public host name of an agent and the word host in a script, and a dash in a script file, which the rule for the README and the Dockerfile does not cover.
  const twin = (name) => (name === source ? `${read(name)}// mp-suppliers-reorder.vector.apexfusion.org on the agents host, a dash ${String.fromCharCode(0x2014)} in a comment\n` : read(name));
  assert.deepEqual(operatorFileProblems(OPERATOR_FILES, TRACKED, twin), [], 'the names that the pack holds on purpose');
});

// The six tasks that make the results that the runbooks of use case 1 name, in the order of the work. The contact is the address that the live agents publish: the operator types it, and no file holds it.
const PACK_TASKS = ['keys', 'fund', 'register', 'stake', 'env', 'advert'];
const CONTACT_SENTENCE = '`OPERATOR_CONTACT` (the contact address that the live agents publish; the operator types it, and no file of the repository holds it)';
const CONTACT_COMMENT = 'OPERATOR_CONTACT is required and is published. It is the contact address that the live agents of the operator publish. The operator types it, and no file of the repository holds it.';
// The faults of a runbook of use case 1: it does not say that the operator pack makes the results, it says that the operator makes them outside the pack, its first table has not the six tasks in the order of the work,
// a task of its table is no task of the pack, or it gives the contact as a role address.
function runbookPackProblems(text, tasks) {
  const problems = [];
  const what = section(text, 'What it is');
  if (!what.includes('The operator pack (`scripts/operator`) makes the keys, ')) problems.push('the first section does not say that the operator pack makes the keys');
  if (/outside this pack/.test(text)) problems.push('the text says that the operator makes something outside this pack');
  const listed = [...what.matchAll(/^\| `([a-z-]+)` \|/gm)].map((hit) => hit[1]);
  if (listed.join(',') !== PACK_TASKS.join(',')) problems.push(`the first table lists the tasks ${listed.join(', ')}, and it must list ${PACK_TASKS.join(', ')} in this order`);
  for (const task of listed) if (!tasks.includes(task)) problems.push(`${task} is no task of the pack`);
  if (text.split(CONTACT_SENTENCE).length !== 2) problems.push('the runbook does not give the rule of the contact once');
  if (/role address|never a person/.test(text)) problems.push('the runbook still calls the contact a role address');
  return problems;
}
// The faults of an env example: the contact is no placeholder in angle brackets, it holds an address, or the comment above it gives no rule or the old rule.
function exampleContactProblems(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.startsWith('OPERATOR_CONTACT='));
  if (at < 0) return ['the example has no OPERATOR_CONTACT line'];
  const problems = [];
  if (!/^OPERATOR_CONTACT=<[^>@]+>$/.test(lines[at])) problems.push('the contact is a placeholder in angle brackets, and it holds no address');
  if (!lines.slice(0, at).filter((line) => line.startsWith('#')).join('\n').includes(CONTACT_COMMENT)) problems.push('the comment above the contact does not give the rule');
  if (/role address|never the address of a person/.test(text)) problems.push('the example still calls the contact a role address');
  return problems;
}

test('use case 1 runbooks and examples: the operator pack makes the keys, the records, the stakes, the env files and the adverts, the six tasks are named in the order of the work, and the contact is the address that the live agents publish, typed by the operator and held by no file; the guards refuse each copy that breaks a rule', () => {
  const tasks = [...read(`${OPERATOR_FOLDER}/tasks/names.ts`).matchAll(/'([a-z-]+)'/g)].map((hit) => hit[1]);
  assert.ok(tasks.length >= 17 && PACK_TASKS.every((task) => tasks.includes(task)), 'the six tasks are tasks of the pack');
  const [reorder, orders] = ['RUNBOOK-reorder-agent.md', 'RUNBOOK-order-desk.md'].map((file) => srvRead(file));
  const [reorderExample, ordersExample] = ['.env.reorder-agent.example', '.env.order-desk.example'].map((file) => srvRead(file));
  for (const text of [reorder, orders]) assert.deepEqual(runbookPackProblems(text, tasks), [], 'the real runbook passes');
  for (const text of [reorderExample, ordersExample]) assert.deepEqual(exampleContactProblems(text), [], 'the real example passes');
  const faults = [
    ['the old sentence', runbookPackProblems(`${reorder}\nThe operator makes three things outside this pack: the keys.\n`, tasks), /outside this pack/],
    ['a task row that is left out', runbookPackProblems(reorder.split('\n').filter((line) => !line.startsWith('| `fund` |')).join('\n'), tasks), /lists the tasks keys, register/],
    ['a task that is no task of the pack', runbookPackProblems(orders.split('| `fund` |').join('| `fond` |'), tasks), /fond is no task of the pack/],
    ['the rows in another order', runbookPackProblems(reorder.split('| `keys` |').join('| `stake` |').split('| `stake` | The Module-3').join('| `keys` | The Module-3'), tasks), /in this order/],
    ['the old rule of the contact', runbookPackProblems(reorder.split(CONTACT_SENTENCE).join('`OPERATOR_CONTACT` (a role address, never a person)'), tasks), /does not give the rule of the contact once/],
    ['the rule of the contact twice', runbookPackProblems(`${orders}\n- ${CONTACT_SENTENCE}\n`, tasks), /does not give the rule of the contact once/],
    ['a role address in the text', runbookPackProblems(`${reorder}\nThe contact is a role address.\n`, tasks), /still calls the contact a role address/],
    ['an address in the example', exampleContactProblems(reorderExample.split('\n').map((line) => (line.startsWith('OPERATOR_CONTACT=') ? 'OPERATOR_CONTACT=someone@example.test' : line)).join('\n')), /no address/],
    ['a comment of the old rule', exampleContactProblems(ordersExample.split(CONTACT_COMMENT).join('Write the role address that the operator confirms, never the address of a person.')), /does not give the rule/],
    ['an example with no contact line', exampleContactProblems(reorderExample.split('\n').filter((line) => !line.startsWith('OPERATOR_CONTACT=')).join('\n')), /no OPERATOR_CONTACT line/],
  ];
  for (const [name, problems, expected] of faults) assert.ok(problems.some((problem) => expected.test(problem)), `${name}: found ${JSON.stringify(problems)}`);
  // The twins: a new line of the runbook about another task of the pack, outside the first section, and a placeholder with other words in the example.
  assert.deepEqual(runbookPackProblems(`${reorder}\nThe task \`claim\` stakes a claim.\n`, tasks), [], 'a task named outside the table');
  assert.deepEqual(exampleContactProblems(ordersExample.split('<contact address that the live agents publish>').join('<the address of the live agents>')), [], 'a placeholder with other words');
});

test('the README of the agents host has a section about the operator image: its name, the run by digest with docker run --rm, the mounts, the memory limit, the gate and the rule that no task prints a key; the runbook of the host says which tasks make the results', () => {
  const readme = srvRead('README.md');
  const text = section(readme, 'The operator image');
  const at = (heading) => readme.indexOf(`\n## ${heading}\n`);
  assert.ok(at('The runtime image') > 0 && at('The runtime image') < at('The operator image') && at('The operator image') < at('What the script does'), 'after the runtime image, before the script');
  const image = CI_IMAGES.find((row) => row.file === `${OPERATOR_FOLDER}/Dockerfile`).image;
  assert.equal(image, `${IMAGE_REPOSITORY}/operator`, 'the image that CI builds');
  for (const part of [
    `${image}@sha256:<digest>`, '`docker run --rm`', 'by its digest, never by a tag', '`/keys`', '`/state`', '`/agents/<agent>`', '`/mock-env/.env.mock-systems`', 'read-only', 'for the task `keys` only', 'for the task `tenant` only',
    'for the tasks `env`, `allowlist` and `fault` only', '768 MiB', '1,792 MiB', 'No task prints a key or a token', 'scripts/operator/README.md', 'The agents host never mounts `/srv/agents` as a whole',
    'The task `env` plans both agents of use case 1 in one run, so it needs both folders and both records', 'and it runs again after `advert`, to write `ADVERT_REF`',
  ]) assert.ok(text.includes(part), part);
  const gate = /at least ([\d,]+) MiB: the gate of ([\d,]+) MiB plus the ([\d,]+) MiB of the image/.exec(text);
  assert.ok(gate, 'the sentence of the gate');
  const [total, base, limit] = gate.slice(1).map((value) => Number(value.replaceAll(',', '')));
  assert.equal(total, base + limit, 'the gate of a run is the gate of the host plus the limit of the image');
  assert.equal(limit, 768, 'the limit is the memory limit of the image');
  assert.equal(base, 1024, 'the gate of the host is the gate of the containers of the agents');
  assert.doesNotMatch(text, HOST_WORDS, 'no host, no proxy stack, no provider');
  assert.doesNotMatch(text, DASHES, 'no em or en dash');
  const runbook = srvRead('RUNBOOK.md');
  assert.ok(section(runbook, '7. Add an agent').includes('The runbook of each pack of use case 1 says which tasks of the operator pack make the keys, the records, the stakes, the env files and the advert.'), 'step 7 says which tasks make the results');
  assert.equal(runbook.includes('The runbook of an agent gives the keys, the registration and the advert.'), false, 'step 7 does not say that the runbook of every agent gives them');
  assert.ok(section(runbook, '7. Add an agent').includes('The runbooks of the other packs give the keys, the registration and the advert.'), 'step 7 says that the runbooks of the other packs still give them');
  assert.ok(section(runbook, 'Keys').includes('The task `keys` of the operator pack makes the keys on this host. It never prints a key.'), 'the keys are made by the task keys');
});

// ======================================================================================================================================
// Use case 3 (supplier bid evaluation): the Sourcing Agent and the three Bid Desks. The tests of each pack hold its files on their own (agents/*/test/deploy.test.ts). These tests read more than one
// place: the tracked files of the repository, the compose files of both hosts, the price lists of the Bid Desks, the README and the RUNBOOK of the agents host, and the parsers that the kit, the two agents
// and the mock service use for the documents that they pass to each other. The drift tests run the real TypeScript of the kit, of the two agents and of the mock service in one child process, as the tests
// of use case 1 and of use case 2 do. Each guard has an accepted twin and refused copies.
// ======================================================================================================================================
const SOURCING_PACK = ['deploy/server/docker-compose.sourcing-agent.yml', 'deploy/server/.env.sourcing-agent.example', 'deploy/server/Caddyfile.sourcing-agent.snippet', 'deploy/server/RUNBOOK-sourcing-agent.md'];
const BID_DESKS = ['alfa', 'bravo', 'charlie'];
// The three Bid Desks run one image in three compose files. They share one env example, one snippet file with three blocks and one runbook.
const BID_DESK_PACK = [...BID_DESKS.map((name) => `deploy/server/docker-compose.bid-desk-${name}.yml`), 'deploy/server/.env.bid-desk.example', 'deploy/server/Caddyfile.bid-desk.snippet', 'deploy/server/RUNBOOK-bid-desk.md'];
const USE_CASE_3_FILES = [...SOURCING_PACK, ...BID_DESK_PACK];
// The price list of each Bid Desk: the file that its instance selects, and that its manifest hashes.
const BID_DESK_PRICE_LISTS = BID_DESKS.map((name) => `agents/bid-desk/price-lists/${name}.json`);

test('use case 3 files: the ten files of the packs of the Sourcing Agent and of the three Bid Desks, and the three price lists, are tracked by git, and none names the host, the stack of its reverse proxy, a login or a key file; the guard refuses a file that is not tracked and a file that names the host', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  assert.equal(SOURCING_PACK.length, 4, 'four files for the Sourcing Agent');
  assert.equal(BID_DESK_PACK.length, 6, 'six files for the three Bid Desks: three compose files, one env example, one snippet and one runbook');
  assert.equal(new Set([...USE_CASE_1_FILES, ...USE_CASE_2_FILES, ...USE_CASE_3_FILES]).size, 9 + 8 + 10, 'none of the ten is a file of use case 1 or of use case 2');
  const files = [...USE_CASE_3_FILES, ...BID_DESK_PRICE_LISTS];
  for (const file of files) assert.ok(existsSync(join(root, file)), `${file} is there`);
  assert.deepEqual(trackedFileProblems(files, TRACKED, read), [], 'the real files pass');
  // [the files of a pack, the compose file that the test changes, the runbook that the test leaves out of the tracked files]
  for (const [pack, compose, runbook] of [[SOURCING_PACK, SOURCING_PACK[0], SOURCING_PACK[3]], [BID_DESK_PACK, BID_DESK_PACK[1], BID_DESK_PACK[5]]]) {
    assert.deepEqual(trackedFileProblems(pack, TRACKED.filter((file) => file !== runbook), read), [`${runbook} is not tracked by git`], 'a file that is not tracked');
    for (const part of ['the apex' + '-web box', 'uma' + 'mi_default', 'root' + '@host', 'id_' + 'ed25519']) {
      const text = (file) => (file === compose ? `${read(file)}# ${part}\n` : read(file));
      assert.deepEqual(trackedFileProblems(pack, TRACKED, text), [`${compose} names the host, the stack of its reverse proxy, a login or a key file`], part);
    }
    // The twin: the names that a pack holds on purpose: the public host name of the agent, the folder of the pack and the word host.
    const origin = /^ +PUBLIC_ORIGIN: https:\/\/(\S+)$/m.exec(read(compose))?.[1];
    assert.ok(origin, `${compose} gives the public origin of the runtime`);
    const twin = (file) => (file === compose ? `${read(file)}# ${origin} in deploy/server on the agents host\n` : read(file));
    assert.deepEqual(trackedFileProblems(pack, TRACKED, twin), [], 'the names of the pack');
  }
  // A price list that git does not track never reaches the image.
  const list = BID_DESK_PRICE_LISTS[0];
  assert.deepEqual(trackedFileProblems(files, TRACKED.filter((file) => file !== list), read), [`${list} is not tracked by git`], 'a price list that is not tracked');
});

// The names that a compose file claims on a host: its project, the name of each container and the name of each volume. Docker refuses a second container with a name that is in use, two projects with one name
// share their default network, and two volumes with one name share their data. So each name stands once in all the compose files of the two hosts. A volume has the name that its `name` gives, or
// `<project>_<key>` when it gives none. A service with no `container_name` gets a name from its project, and that is no claim here.
function composeNameProblems(texts) {
  const problems = [];
  const owners = { project: new Map(), container: new Map(), volume: new Map() };
  const claim = (kind, name, owner) => owners[kind].set(name, [...(owners[kind].get(name) ?? []), owner]);
  for (const [file, text] of Object.entries(texts)) {
    const parsed = parseYaml(text) ?? {};
    if (typeof parsed.name !== 'string' || parsed.name === '') {
      problems.push(`${file} has no project name`);
      continue;
    }
    claim('project', parsed.name, file);
    for (const [service, body] of Object.entries(parsed.services ?? {})) if (typeof body?.container_name === 'string') claim('container', body.container_name, `${file}#${service}`);
    for (const [key, body] of Object.entries(parsed.volumes ?? {})) claim('volume', typeof body?.name === 'string' ? body.name : `${parsed.name}_${key}`, `${file}#${key}`);
  }
  for (const [kind, names] of Object.entries(owners)) for (const [name, users] of names) if (users.length > 1) problems.push(`the ${kind} name ${name} is used twice: ${users.join(', ')}`);
  return problems;
}

test('use case 3 names: the project, each container and each volume of the compose files of the two hosts have one name, and the Sourcing Agent and the three Bid Desks have the names of the plan; the guard refuses a name that stands twice', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  assert.deepEqual(composeNameProblems(texts), [], 'the real files pass');
  const sourcing = serverCompose('sourcing-agent');
  const [alfa, bravo, charlie] = BID_DESKS.map((name) => serverCompose(`bid-desk-${name}`));
  // The names of the plan: the project, the runtime, the service and the volume of each pack.
  const plan = { [sourcing]: ['sourcing-agent', 'sourcing-runtime', 'sourcing-service', 'sourcing-state'], ...Object.fromEntries(BID_DESKS.map((name) => [serverCompose(`bid-desk-${name}`), [`bid-desk-${name}`, `bids-${name}-runtime`, `bids-${name}-service`, `bid-desk-${name}-state`]])) };
  assert.equal(Object.keys(plan).length, 4, 'the Sourcing Agent and the three Bid Desks');
  for (const [file, expected] of Object.entries(plan)) {
    const parsed = parseYaml(texts[file]);
    assert.deepEqual([parsed.name, parsed.services.runtime.container_name, parsed.services.service.container_name, Object.values(parsed.volumes).map((volume) => volume.name)], [expected[0], expected[1], expected[2], [expected[3]]], `${file}: the names of the plan`);
  }
  const extra = (name, body) => ({ [`deploy/server/docker-compose.${name}.yml`]: body });
  const faults = [
    ['two Bid Desks with one container name', { [bravo]: srvReplace(texts[bravo], 'container_name: bids-bravo-service', 'container_name: bids-alfa-service') }, /the container name bids-alfa-service is used twice: \S+bid-desk-alfa\.yml#service, \S+bid-desk-bravo\.yml#service/],
    ['two runtimes of the Bid Desks with one container name', { [charlie]: srvReplace(texts[charlie], 'container_name: bids-charlie-runtime', 'container_name: bids-bravo-runtime') }, /the container name bids-bravo-runtime is used twice: \S+bid-desk-bravo\.yml#runtime, \S+bid-desk-charlie\.yml#runtime/],
    ['the service of the Sourcing Agent with the name of a container of the present host', { [sourcing]: srvReplace(texts[sourcing], 'container_name: sourcing-service', 'container_name: advocate-service') }, /the container name advocate-service is used twice: \S+advocate\.yml#service, \S+sourcing-agent\.yml#service/],
    ['two projects with one name', { [charlie]: srvReplace(texts[charlie], '\nname: bid-desk-charlie\n', '\nname: bid-desk-bravo\n') }, /the project name bid-desk-bravo is used twice: \S+bid-desk-bravo\.yml, \S+bid-desk-charlie\.yml/],
    ['two volumes with one name', { [charlie]: srvReplace(texts[charlie], 'bid-desk-charlie-state', 'bid-desk-bravo-state') }, /the volume name bid-desk-bravo-state is used twice: \S+bid-desk-bravo\.yml#bid-desk-bravo-state, \S+bid-desk-charlie\.yml#bid-desk-bravo-state/],
    ['a volume with no name that has the name of a volume of another file', { ...extra('one', 'name: one\nservices: {}\nvolumes:\n  state: {}\n'), ...extra('two', 'name: two\nservices: {}\nvolumes:\n  data: { name: one_state }\n') }, /the volume name one_state is used twice/],
    ['a compose file with no project name', extra('three', 'services: {}\n'), /docker-compose\.three\.yml has no project name/],
  ];
  for (const [name, changed, expected] of faults) {
    const problems = composeNameProblems({ ...texts, ...changed });
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the files in another order, and two projects that each have a service with no container name and a volume with no name: their default names differ.
  assert.deepEqual(composeNameProblems(Object.fromEntries(Object.entries(texts).reverse())), [], 'the files in another order');
  const twins = { ...extra('one', 'name: one\nservices:\n  service:\n    image: example\nvolumes:\n  state: {}\n'), ...extra('two', 'name: two\nservices:\n  service:\n    image: example\nvolumes:\n  state: {}\n') };
  assert.deepEqual(composeNameProblems({ ...texts, ...twins }), [], 'two projects with the same service name and the same volume key');
});

test('use case 3 ports: the compose files of the Sourcing Agent and of the three Bid Desks publish exactly 8107 to 8110 for the runtimes and 9105 to 9108 for the services, one port for each container, and no host port stands twice in the compose files of the two hosts; the guard refuses each copy that breaks one rule', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  const readme = srvRead('README.md');
  const sourcing = serverCompose('sourcing-agent');
  const desks = BID_DESKS.map((name) => serverCompose(`bid-desk-${name}`));
  const packs = [sourcing, ...desks];
  const found = (kind) => packs.flatMap((file) => publishedPorts(texts[file]).filter((port) => port.service === kind).map((port) => port.host)).sort((a, b) => a - b);
  assert.deepEqual(found('runtime'), [8107, 8108, 8109, 8110], 'the four runtimes publish 8107 to 8110');
  assert.deepEqual(found('service'), [9105, 9106, 9107, 9108], 'the four services publish 9105 to 9108');
  assert.equal(packs.flatMap((file) => publishedPorts(texts[file])).length, 8, 'one port for each container, and no other port');
  assert.deepEqual(packs.map((file) => PACK_PORTS[file]), [{ runtime: [8107], service: [9105] }, { runtime: [8108], service: [9106] }, { runtime: [8109], service: [9107] }, { runtime: [8110], service: [9108] }], 'the ports that the guard expects of the four files');
  assert.deepEqual(portProblems(texts, PACK_PORTS, readme), [], 'the real files pass');
  const [alfa, bravo, charlie] = desks;
  const faults = [
    ['the runtime of Bid Desk charlie on the port of the Prior Authorization Agent', { [charlie]: srvReplace(texts[charlie], '127.0.0.1:8110:8080', '127.0.0.1:8105:8080') }, /the port 8105 is published twice(?=.*bid-desk-charlie\.yml#runtime)(?=.*prior-authorization-agent\.yml#runtime)/],
    ['the service of the Sourcing Agent on the port of the Insurer Intake Agent', { [sourcing]: srvReplace(texts[sourcing], '127.0.0.1:9105:9105', '127.0.0.1:9104:9105') }, /the port 9104 is published twice(?=.*insurer-intake-agent\.yml#service)(?=.*sourcing-agent\.yml#service)/],
    ['the runtime of Bid Desk alfa on the port of the third runtime of the Order Desk', { [alfa]: srvReplace(texts[alfa], '127.0.0.1:8108:8080', '127.0.0.1:8104:8080') }, /the port 8104 is published twice(?=.*bid-desk-alfa\.yml#runtime)(?=.*order-desk\.yml#runtime-large)/],
    ['the runtime of Bid Desk alfa on the port of the runtime of the Sourcing Agent', { [alfa]: srvReplace(texts[alfa], '127.0.0.1:8108:8080', '127.0.0.1:8107:8080') }, /the port 8107 is published twice(?=.*bid-desk-alfa\.yml#runtime)(?=.*sourcing-agent\.yml#runtime)/],
    ['the service of Bid Desk bravo on a port of the present host', { [bravo]: srvReplace(texts[bravo], '127.0.0.1:9107:9106', '127.0.0.1:8083:9106') }, /the port 8083 is published twice/],
    ['the runtime of Bid Desk alfa on a public address', { [alfa]: srvReplace(texts[alfa], '["127.0.0.1:8108:8080"]', '["0.0.0.0:8108:8080"]') }, /bid-desk-alfa\.yml must publish/],
    ['a third port on the runtime of the Sourcing Agent', { [sourcing]: srvReplace(texts[sourcing], '["127.0.0.1:8107:8080"]', '["127.0.0.1:8107:8080", "127.0.0.1:8111:8081"]') }, /sourcing-agent\.yml must publish/],
  ];
  for (const [name, changed, expected] of faults) {
    const problems = portProblems({ ...texts, ...changed }, PACK_PORTS, readme);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the long form of a port with the same numbers, and the compose files of the two hosts in another order.
  const long = srvReplace(texts[charlie], '["127.0.0.1:8110:8080"]', '[{ target: 8080, published: 8110, host_ip: 127.0.0.1 }]');
  assert.deepEqual(portProblems({ ...texts, [charlie]: long }, PACK_PORTS, readme), [], 'the long form');
  assert.deepEqual(portProblems(Object.fromEntries(Object.entries(texts).reverse()), PACK_PORTS, readme), [], 'the files in another order');
});

// The three Bid Desks are one code base in three compose files. Each file names one image of the service and one image of the runtime, and the same image as the other two: the digest that the operator writes
// in one file stands in the three. The instance of each file selects the price list of the same name, so the folder of the price lists holds one file for each instance and no other file.
function bidDeskProblems(texts, listFiles) {
  const problems = [];
  const images = { service: new Set(), runtime: new Set() };
  for (const name of BID_DESKS) {
    const file = serverCompose(`bid-desk-${name}`);
    if (texts[file] === undefined) {
      problems.push(`${file} is not there`);
      continue;
    }
    const services = parseYaml(texts[file])?.services ?? {};
    for (const kind of Object.keys(images)) images[kind].add(services[kind]?.image);
    const instance = services.service?.environment?.BID_DESK_INSTANCE;
    if (instance !== name) problems.push(`${file} gives the instance ${instance}, and it is the file of ${name}`);
    if (!listFiles.includes(`${instance}.json`)) problems.push(`${file} selects the price list ${instance}.json, and no such file is there`);
  }
  const wanted = { service: `${IMAGE_REPOSITORY}/bid-desk@sha256:`, runtime: `${RT.image}@sha256:` };
  for (const [kind, set] of Object.entries(images)) {
    if (set.size > 1) problems.push(`the three Bid Desks must name one image of the ${kind}, and they name ${set.size}`);
    for (const image of set) if (typeof image !== 'string' || !image.startsWith(wanted[kind])) problems.push(`the image of the ${kind} must be ${wanted[kind]}<digest>`);
  }
  const expected = BID_DESKS.map((name) => `${name}.json`);
  if (!isDeepStrictEqual([...listFiles].sort(), expected)) problems.push(`the folder of the price lists must hold ${expected.join(', ')} and no other file`);
  return problems;
}

test('use case 3 Bid Desks: the three compose files are there and name one image of the service and one image of the runtime, and the instance of each selects the price list of the same name; the guard refuses each copy that breaks one rule', () => {
  const texts = composeTextsOf(['deploy/server']);
  const listFiles = readdirSync(join(root, 'agents/bid-desk/price-lists'));
  assert.deepEqual(bidDeskProblems(texts, listFiles), [], 'the real files pass');
  const [alfa, bravo, charlie] = BID_DESKS.map((name) => serverCompose(`bid-desk-${name}`));
  const other = 'ab'.repeat(32);
  const without = (file) => Object.fromEntries(Object.entries(texts).filter(([path]) => path !== file));
  const faults = [
    ['the service of Bid Desk charlie under another digest', { ...texts, [charlie]: srvReplace(texts[charlie], `${IMAGE_REPOSITORY}/bid-desk@sha256:<digest>`, `${IMAGE_REPOSITORY}/bid-desk@sha256:${other}`) }, listFiles, /must name one image of the service, and they name 2/],
    ['the runtime of Bid Desk bravo under another digest', { ...texts, [bravo]: srvReplace(texts[bravo], `${RT.image}@sha256:<digest>`, `${RT.image}@sha256:${other}`) }, listFiles, /must name one image of the runtime, and they name 2/],
    ['the service of the three Bid Desks under the name of another agent', { ...texts, ...Object.fromEntries([alfa, bravo, charlie].map((file) => [file, srvReplace(texts[file], `${IMAGE_REPOSITORY}/bid-desk@sha256`, `${IMAGE_REPOSITORY}/sourcing-agent@sha256`)])) }, listFiles, /the image of the service must be \S+\/bid-desk@sha256:<digest>/],
    ['the compose file of Bid Desk charlie that is gone', without(charlie), listFiles, /bid-desk-charlie\.yml is not there/],
    ['an instance that names another Bid Desk', { ...texts, [bravo]: srvReplace(texts[bravo], 'BID_DESK_INSTANCE: bravo', 'BID_DESK_INSTANCE: alfa') }, listFiles, /bid-desk-bravo\.yml gives the instance alfa, and it is the file of bravo/],
    ['an instance that has no price list', { ...texts, [charlie]: srvReplace(texts[charlie], 'BID_DESK_INSTANCE: charlie', 'BID_DESK_INSTANCE: delta') }, listFiles, /bid-desk-charlie\.yml selects the price list delta\.json, and no such file is there/],
    ['a folder of price lists with a fourth file', texts, [...listFiles, 'delta.json'], /the folder of the price lists must hold alfa\.json, bravo\.json, charlie\.json and no other file/],
    ['a folder of price lists without the file of charlie', texts, listFiles.filter((name) => name !== 'charlie.json'), /bid-desk-charlie\.yml selects the price list charlie\.json, and no such file is there/],
  ];
  for (const [name, given, files, expected] of faults) {
    const problems = bidDeskProblems(given, files);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: one digest in the three files, for the service and for the runtime, and the files in another order.
  const digest = (text) => srvReplace(srvReplace(text, `${IMAGE_REPOSITORY}/bid-desk@sha256:<digest>`, `${IMAGE_REPOSITORY}/bid-desk@sha256:${other}`), `${RT.image}@sha256:<digest>`, `${RT.image}@sha256:${other}`);
  assert.deepEqual(bidDeskProblems({ ...texts, ...Object.fromEntries([alfa, bravo, charlie].map((file) => [file, digest(texts[file])])) }, listFiles), [], 'one digest in the three files');
  assert.deepEqual(bidDeskProblems(Object.fromEntries(Object.entries(texts).reverse()), [...listFiles].reverse()), [], 'the files in another order');
});

// The files of the two hosts that a reader meets: the compose files, the env examples, the snippets, the runbooks, the READMEs and the scripts. An env file of a host (`.env.<name>` with no `.example`) is no
// file of the repository, and the guard does not read it.
const deployFiles = () => ['deploy/host', 'deploy/server'].flatMap((dir) => readdirSync(join(root, dir))
  .filter((name) => /^(?:docker-compose.*\.ya?ml|\.env\..*\.example|Caddyfile.*|.*\.md|.*\.sh|.*\.mjs)$/.test(name) && statSync(join(root, dir, name)).isFile())
  .map((name) => `${dir}/${name}`));
// The addresses that a file of a pack holds on purpose: loopback, the address that means every interface inside a container, and the public resolver that the DNS check of a runbook asks. The address of the
// host is none of them, and it never enters the repository. A refusal gives the line and never the address.
const PACK_ADDRESSES = new Set(['127.0.0.1', '0.0.0.0', '1.1.1.1']);
function addressProblems(files, textOf) {
  const problems = [];
  for (const file of files) {
    textOf(file).split('\n').forEach((line, at) => {
      if ((line.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []).some((address) => !PACK_ADDRESSES.has(address))) problems.push(`${file}:${at + 1} holds an IPv4 address that no pack may hold`);
    });
  }
  return problems;
}

test('use case 3 addresses: no file of the packs of use case 1, of use case 2 and of use case 3, and no other file of the two hosts, holds an IPv4 address other than 127.0.0.1, 0.0.0.0 and 1.1.1.1; the guard refuses another address in each kind of file and passes the three addresses of a pack', () => {
  const files = deployFiles();
  for (const must of [...USE_CASE_1_FILES, ...USE_CASE_2_FILES, ...USE_CASE_3_FILES, 'deploy/server/README.md', 'deploy/server/RUNBOOK.md', 'deploy/host/README.md', 'deploy/host/docker-compose.agent-history.yml']) assert.ok(files.includes(must), `${must} is read`);
  assert.ok(files.length >= 30 && new Set(files).size === files.length, `the walk reaches the files of both hosts, found ${files.length}`);
  assert.deepEqual(addressProblems(files, read), [], 'the real files pass');
  // The addresses are of the ranges that RFC 5737 keeps for documentation, and a private address: no address of a real host is written here.
  const kinds = [['a compose file', SOURCING_PACK[0]], ['an env example', SOURCING_PACK[1]], ['a Caddy snippet', BID_DESK_PACK[4]], ['a runbook', BID_DESK_PACK[5]], ['a runbook of use case 1', USE_CASE_1_FILES[3]], ['a compose file of use case 2', USE_CASE_2_FILES[0]], ['the README of the agents host', 'deploy/server/README.md']];
  for (const [kind, file] of kinds) {
    for (const address of ['192.0.2.7', '198.51.100.23', '203.0.113.5', '10.0.0.1']) {
      const text = (name) => (name === file ? `${read(name)}\nThe host is at ${address} today.\n` : read(name));
      const problems = addressProblems(files, text);
      assert.equal(problems.length, 1, `${kind}, ${address}: found ${JSON.stringify(problems)}`);
      assert.ok(problems[0].startsWith(`${file}:`) && problems[0].endsWith('holds an IPv4 address that no pack may hold') && !problems[0].includes(address), `${kind}, ${address}: the refusal names the file and the line, and never the address`);
    }
  }
  // An address in a URL, with a port and with a prefix length is found too.
  for (const text of ['http://192.0.2.7:9105/', '192.0.2.0/24', 'addr=203.0.113.5,', '1.1.1.1 and 8.8.8.8']) assert.equal(addressProblems(['x'], () => text).length, 1, text);
  // The twins: the three addresses of a pack, a version of three parts, a date with dots, a port on loopback and a range that starts at 0.0.0.0.
  for (const text of ['127.0.0.1', '0.0.0.0', '1.1.1.1', 'listen 127.0.0.1:8108 and 0.0.0.0:9106', 'version 1.2.3', 'on 2026.11.24', '0.0.0.0/0']) assert.deepEqual(addressProblems(['x'], () => text), [], text);
});


// ---- The README and the RUNBOOK of the agents host, for the packs of use case 3 ----
test('use case 3 README: the table of the files has a row for each of the ten files of the packs of the Sourcing Agent and of the three Bid Desks, and each file is there, and the rows say what the compose files do', () => {
  const readme = srvRead('README.md');
  for (const file of USE_CASE_3_FILES) {
    const name = file.slice(`${SRV}/`.length);
    assert.ok(readme.includes(`| \`${name}\` | `), `${name} has a row`);
    assert.ok(existsSync(join(root, file)), `${name} is there`);
  }
  const rows = section(readme, 'The files').split('\n').filter((line) => /^\| `[^`]*(?:sourcing-agent|bid-desk)[^`]*` \|/.test(line));
  assert.equal(rows.length, 10, 'ten rows for the four packs');
  // The row of the compose file of the Sourcing Agent says how many keys the runtime does not get: the compose file blanks each key of the service in the environment of the runtime.
  const keys = (file, kind) => Object.entries(parseYaml(read(file)).services[kind].environment).filter(([name]) => name.endsWith('_PRIV_KEY_HEX'));
  const blanked = keys(SOURCING_PACK[0], 'runtime').filter(([, value]) => value === '');
  assert.equal(blanked.length, 9, 'the runtime of the Sourcing Agent gets none of the nine keys of the service');
  assert.ok(rows.some((row) => row.startsWith('| `docker-compose.sourcing-agent.yml` |') && row.includes(`The runtime gets none of the ${IMAGE_WORDS[blanked.length]} keys of the service.`)), 'the row of the Sourcing Agent says nine keys');
  for (const file of BID_DESK_PACK.slice(0, 3)) {
    const blankedKey = keys(file, 'runtime').filter(([, value]) => value === '').map(([name]) => name);
    assert.deepEqual(blankedKey, ['BID_DESK_SERVICE_PRIV_KEY_HEX'], `${file}: the runtime of a Bid Desk does not get the key of its service`);
  }
  assert.ok(rows.some((row) => row.startsWith('| `docker-compose.bid-desk-alfa.yml` |') && row.includes('The runtime does not get the key of the service.')), 'the row of Bid Desk alfa says that the runtime does not get the key of the service');
  for (const name of ['bravo', 'charlie']) {
    assert.ok(rows.some((row) => row.startsWith(`| \`docker-compose.bid-desk-${name}.yml\` |`) && row.includes('It is the file of alfa with the name of the instance, the two host ports, the host name and the organisation changed.')), `the row of Bid Desk ${name} says how it differs from alfa`);
  }
});

test('use case 3 README: the plan of the ports has a row for the runtime and the service of the Sourcing Agent and for the runtimes and the services of the Bid Desks, and each row holds the ports of its compose files; the guard refuses each copy that breaks one rule', () => {
  const texts = composeTextsOf(['deploy/host', 'deploy/server']);
  const readme = srvRead('README.md');
  const rows = Object.fromEntries(labelledRows(readme).map((row) => [row.label, row]));
  const expected = [['Sourcing Agent runtime', 1, 8107, 8107], ['Bid Desk runtimes', 3, 8108, 8110], ['Sourcing Agent service', 1, 9105, 9105], ['Bid Desk services', 3, 9106, 9108]];
  for (const [label, count, from, to] of expected) assert.deepEqual(rows[label], { label, count, from, to }, `${label}: the row of the plan in the README`);
  assert.deepEqual(portProblems(texts, PACK_PORTS, readme), [], 'the real files pass');
  const rowLine = (label) => section(readme, 'Folders and ports').split('\n').find((line) => line.startsWith(`| ${label} (`));
  const alfa = serverCompose('bid-desk-alfa');
  const faults = [
    ['a README plan that leaves out the row of the Bid Desk runtimes', srvReplace(readme, `${rowLine('Bid Desk runtimes')}\n`, ''), /bid-desk-alfa\.yml#runtime publishes 8108, and no row of the plan/],
    ['a README plan that leaves out the row of the Bid Desk services', srvReplace(readme, `${rowLine('Bid Desk services')}\n`, ''), /bid-desk-alfa\.yml#service publishes 9106, and no row of the plan/],
    ['a README plan that leaves out the row of the Sourcing Agent service', srvReplace(readme, `${rowLine('Sourcing Agent service')}\n`, ''), /sourcing-agent\.yml#service publishes 9105, and no row of the plan/],
    ['a row of the Bid Desk runtimes with a wrong count', srvReplace(readme, rowLine('Bid Desk runtimes'), rowLine('Bid Desk runtimes').replace(/\((\d+)\)/, '(99)')), /a row of the plan in the README gives 99 ports/],
    ['two rows of the README plan that overlap', srvReplace(readme, `${rowLine('Sourcing Agent runtime')}\n`, `${rowLine('Sourcing Agent runtime')}\n| Overlap (1) | 8108 |\n`), /two rows of the plan in the README overlap: 8108 to 8108 and 8108 to 8110/],
    ['a row of the Bid Desk services that stops one port short', srvReplace(readme, rowLine('Bid Desk services'), '| Bid Desk services (2) | 9106 to 9107 |'), /bid-desk-charlie\.yml#service publishes 9108, and no row of the plan/],
  ];
  for (const [name, text, expectedProblem] of faults) {
    const problems = portProblems(texts, PACK_PORTS, text);
    assert.ok(problems.some((p) => expectedProblem.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twin: the compose files of the two hosts in another order, and a Bid Desk on the long form of its ports.
  const long = srvReplace(texts[alfa], '["127.0.0.1:9106:9106"]', '[{ target: 9106, published: 9106, host_ip: 127.0.0.1 }]');
  assert.deepEqual(portProblems({ ...texts, [alfa]: long }, PACK_PORTS, readme), [], 'the long form');
  assert.deepEqual(portProblems(Object.fromEntries(Object.entries(texts).reverse()), PACK_PORTS, readme), [], 'the files in another order');
});

test('use case 3 README: the memory arithmetic of the eight containers adds up: the sizes, the memory that they need, the gate, the starts that pass it at the planning sizes, and the rule that a start that the gate refuses is not made', () => {
  const text = section(srvRead('README.md'), 'The host');
  const number = (value) => Number(value.replaceAll(',', ''));
  const fmt = (value) => value.toLocaleString('en-US');
  const sizes = Object.fromEntries([...text.matchAll(/^\| ([A-Za-z][^|]*?) \| ([\d,]+) \|$/gm)].map((m) => [m[1], number(m[2])]));
  const [runtime, service] = [sizes['Reorder Agent runtime'], sizes['Reorder Agent service']];
  assert.equal(sizes['Sourcing Agent runtime'], runtime, 'the planning size of a runtime');
  assert.equal(sizes['Sourcing Agent service'], service, 'the planning size of a service');
  assert.equal(sizes['Bid Desk runtimes (3)'], 3 * runtime, 'three runtimes of one size');
  assert.equal(sizes['Bid Desk services (3)'], 3 * service, 'three services of one size');
  const total = sizes['Sourcing Agent runtime'] + sizes['Sourcing Agent service'] + sizes['Bid Desk runtimes (3)'] + sizes['Bid Desk services (3)'];
  assert.equal(sizes['The eight containers'], total, 'the eight containers are the sum of the rows');
  assert.equal(total, 4 * runtime + 4 * service, 'four runtimes and four services');
  // The memory before the first start is the memory after the six containers of use case 1 run, with no container of use case 2.
  const six = /^\| The six containers run \| ([\d,]+) \| ([\d,]+) \|/m.exec(text);
  assert.ok(six, 'the table of use case 1 gives the memory after the six containers run');
  const [typical, lowest] = [number(six[1]), number(six[2])];
  const GATE = 1024;
  // The order of the starts: the service first, then the runtime, for the Sourcing Agent and then for each Bid Desk. A start that the gate refuses is not made, so the memory stays, and every start after it is refused too.
  const order = [service, runtime, ...BID_DESKS.flatMap(() => [service, runtime])];
  assert.equal(order.reduce((sum, size) => sum + size, 0), total, 'the eight starts are the eight containers');
  const starts = (first) => {
    let memory = first;
    let started = 0;
    let refused = null;
    order.forEach((size, at) => {
      if (memory >= GATE) {
        memory -= size;
        started += 1;
      } else refused ??= { at, before: memory };
    });
    return { started, refused };
  };
  const [inTypical, inLowest] = [starts(typical), starts(lowest)];
  assert.deepEqual([inTypical.started, inTypical.refused?.at, inTypical.refused?.before], [3, 3, 814], 'three starts pass in the typical case, and the fourth start has 814 MiB before it');
  assert.deepEqual([inLowest.started, inLowest.refused?.at, inLowest.refused?.before], [1, 1, 817], 'one start passes in the lowest case, and the second start has 817 MiB before it');
  const ordinal = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
  assert.ok(text.includes('The eight containers of use case 3 (supplier bid evaluation) have these planning sizes. They are estimates until the first start of a service is measured.'), 'the sizes are estimates');
  const paragraph = text.split('\n\n').find((part) => part.startsWith('The eight containers need '));
  assert.ok(paragraph, 'the paragraph of the memory arithmetic of use case 3 is there');
  for (const part of [
    `The eight containers need ${fmt(total)} MiB, and a start needs ${fmt(GATE)} MiB of \`MemAvailable\` before it.`,
    `With the six containers of use case 1 running, and none of use case 2, \`MemAvailable\` is about ${fmt(typical)} MiB in the typical case and ${fmt(lowest)} MiB in the lowest case.`,
    `So the eight containers need ${fmt(total - typical)} MiB more than the typical case holds, and ${fmt(total - lowest)} MiB more than the lowest case holds.`,
    'The service starts first, then the runtime, for the Sourcing Agent and then for each Bid Desk.',
    `At the planning sizes, the ${ordinal[inTypical.refused.at]} start fails the gate in the typical case (${fmt(inTypical.refused.before)} MiB before it), and the ${ordinal[inLowest.refused.at]} start fails it in the lowest case (${fmt(inLowest.refused.before)} MiB before it).`,
    `So ${IMAGE_WORDS[inTypical.started]} of the eight containers start in the typical case, and ${IMAGE_WORDS[inLowest.started]} in the lowest case.`,
  ]) assert.ok(paragraph.includes(part), part);
  assert.ok(paragraph.endsWith('A start that the gate refuses is not made.'), 'the paragraph ends with the rule that a refused start is not made');
  // The block follows the block of use case 2 and comes before the closing paragraph of the section.
  const at = (part) => text.indexOf(part);
  assert.ok(at('The four containers of use case 2') > 0 && at('The four containers of use case 2') < at('The eight containers of use case 3') && at('The eight containers of use case 3') < at('The plan holds no container after these eighteen'), 'the three blocks are in the order of the use cases');
});

test('use case 3 README: the section of a host whose proxy runs in a container names the packs of use case 3 and their runbooks; the markers, the joins and the container names in the upstreams are those of the Sourcing Agent and of the three Bid Desks', () => {
  const text = section(srvRead('README.md'), 'A host whose proxy runs in a container');
  assert.ok(text.length > 0, 'the section is there');
  const markersOf = (snippet) => [...snippet.matchAll(/^# (\S+) vhosts \(BEGIN\)$/gm)].map((hit) => hit[1]);
  const [sourcingSnippet, deskSnippet] = [srvRead('Caddyfile.sourcing-agent.snippet'), srvRead('Caddyfile.bid-desk.snippet')];
  // The Sourcing Agent has one project and one block. The three Bid Desks are three projects, and their snippet file has one pair of markers for each.
  assert.deepEqual(markersOf(sourcingSnippet), ['sourcing-agent']);
  assert.deepEqual(markersOf(deskSnippet), BID_DESKS.map((name) => `bid-desk-${name}`));
  const projects = [['sourcing-agent', 'docker-compose.sourcing-agent.yml', sourcingSnippet], ...BID_DESKS.map((name) => [`bid-desk-${name}`, `docker-compose.bid-desk-${name}.yml`, deskSnippet])];
  const names = new Set();
  for (const [agent, composeFile, snippet] of projects) {
    const compose = parseYaml(srvRead(composeFile));
    assert.ok(snippet.includes(`\n# ${agent} vhosts (END)\n`), `${agent} has its END marker`);
    assert.equal(compose.name, agent, `the project of ${composeFile} is the name in the markers`);
    assert.ok(snippet.includes(`docker network connect ${agent}_default <caddy container>`), `${agent}: the snippet gives the join`);
    for (const service of Object.values(compose.services)) names.add(service.container_name);
  }
  for (const [snippetFile, snippet] of [['Caddyfile.sourcing-agent.snippet', sourcingSnippet], ['Caddyfile.bid-desk.snippet', deskSnippet]]) {
    const upstreams = snippet.split('\n').filter((line) => /^\s*reverse_proxy /.test(line)).map((line) => line.trim().split(/\s+/)[1].split(':')[0]);
    assert.ok(upstreams.length > 0 && upstreams.every((name) => names.has(name)), `${snippetFile}: each upstream is the container name of a service of the pack`);
  }
  assert.ok(text.includes('The packs of use case 3 (the Sourcing Agent and the three Bid Desks) are written for such a host in the same way.'), 'the packs of use case 3 are written for such a host');
  assert.ok(text.includes('The runbooks of the packs of use case 3 give them in the same way: `RUNBOOK-sourcing-agent.md` and `RUNBOOK-bid-desk.md`. The second one has one block and one join for each of the three Bid Desks.'), 'the runbooks of the packs of use case 3');
  for (const file of ['RUNBOOK-sourcing-agent.md', 'RUNBOOK-bid-desk.md']) assert.ok(existsSync(join(root, SRV, file)), `${file} is there`);
  // The join: the three Bid Desks are three projects, so the Caddy container joins one network for each of them.
  const joinRow = text.split('\n').find((line) => line.startsWith('| The join |'));
  assert.ok(joinRow, 'the table has the row of the join');
  assert.ok(joinRow.includes('The three Bid Desks are three projects, so the Caddy container joins one network for each of them: `bid-desk-alfa_default`, `bid-desk-bravo_default` and `bid-desk-charlie_default`.'), 'the join names the networks of the three Bid Desks');
  for (const name of BID_DESKS) assert.ok(joinRow.includes(`\`bid-desk-${name}_default\``) && parseYaml(srvRead(`docker-compose.bid-desk-${name}.yml`)).name === `bid-desk-${name}`, `the network of the project of Bid Desk ${name}`);
});

test('use case 3 RUNBOOK: step 7 points to the runbooks of the packs of use case 3, and says that they fit the marker block only, as the packs of use case 1 and of use case 2 do', () => {
  const step = section(srvRead('RUNBOOK.md'), '7. Add an agent');
  for (const file of ['RUNBOOK-sourcing-agent.md', 'RUNBOOK-bid-desk.md']) assert.ok(step.includes(`\`${file}\``) && existsSync(join(root, SRV, file)), file);
  const [paragraph, ways] = step.split('\n1. ');
  assert.ok(paragraph.includes('The packs of use case 3 (supplier bid evaluation) are the Sourcing Agent, with `RUNBOOK-sourcing-agent.md`, and the three Bid Desks, with `RUNBOOK-bid-desk.md`.'), 'the paragraph names the packs');
  const at = (part) => paragraph.indexOf(part);
  assert.ok(at('The packs of use case 2') > 0 && at('The packs of use case 2') < at('The packs of use case 3') && at('The packs of use case 3') < at('They fit the marker block only:'), 'the sentence about the marker block follows the lists of all the packs');
  const [snippetFolder, markerBlock] = ways.split('   - Marker block.');
  assert.ok(snippetFolder.includes('The packs of use case 3 do not fit this way either.'), 'the snippet folder is not for the packs of use case 3');
  assert.ok(markerBlock.includes('The packs of use case 3 use this way only.'), 'the marker block is for the packs of use case 3');
});

// ======================================================================================================================================
// The documents of use case 3 that the kit, the two agents and the mock service read. The mock service is the system on the other side: the sourcing record takes a ranking with its salt and its approval, the vendor
// master gives the vendors, and the seed of a tenant holds the catalogue and the vendors. One child process loads the real TypeScript of the mock service, of the kit and of the two agents, so that nothing here
// re-implements a parser. The documents go in on the standard input. The rule of the kit holds one way: every ranking that its parser takes is a ranking that the sourcing record takes. The record reads only the members
// that it needs, so it takes more than the kit does, and the table says where.
// ======================================================================================================================================
const BIDS_GOLDENS = 'packages/usecase-kit/test/bids/golden';
const SOURCING_TESTS = 'agents/sourcing-agent/test';
const RANKING_GOLDENS = [`${BIDS_GOLDENS}/ranking.json`, `${SOURCING_TESTS}/execute/golden/ranking.json`, `${SOURCING_TESTS}/propose/golden/ranking.json`];

// The ranking, as the kit reads it and as the sourcing record reads it. The record reads the tenant, the request identifier, and the rank, the DID and the organisation of each ranked entry, and it keeps the rest of the
// ranking as it came: the approval check hashes it. The tenant is the one of the URL, and the router takes a name of the form TENANT only. The builder of the kit makes each ranking from the parts that the agent has.
const RANKING_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { parseRanking as store } from './src/documents.ts';
import { TENANT } from './src/validate.ts';
import { buildRanking, parseRanking as kit } from '../../packages/usecase-kit/src/bids/index.ts';
const SALT = '07'.repeat(32);
const verdict = (run) => { try { return run(); } catch (error) { if (error?.name !== 'Invalid') throw error; return null; } };
const mockRead = (ranking) => {
  if (typeof ranking?.tenant !== 'string' || !TENANT.test(ranking.tenant)) return null;
  return verdict(() => { const read = store({ ranking, salt: SALT, approval: null }, ranking.tenant); return { rfq_id: read.rfq_id, top: read.top, organisation: read.topOrganisation }; });
};
const { rankings, bodies, builds } = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify({
  rankings: rankings.map((ranking) => { const read = mockRead(ranking); return { kit: kit(ranking).ok, mock: read !== null, read }; }),
  bodies: bodies.map(([body, tenant]) => verdict(() => { store(body, tenant); return true; }) === true),
  builds: builds.map((input) => { const made = buildRanking(input); return made.ok ? { ok: true, ranking: made.value, mock: mockRead(made.value) !== null, again: kit(made.value).ok } : { ok: false, code: made.code }; }),
}));
`;

test('use case 3 drift: the ranking is read in the same way by the parser of the kit and by the sourcing record of the mock service: each ranking that the kit builds or takes is a ranking that the record takes, a broken ranking is refused by both, and the body of the record needs its approval member', () => {
  const golden = jsonOf(RANKING_GOLDENS[0]);
  const rfq = jsonOf(`${BIDS_GOLDENS}/rfq.json`);
  const weights = jsonOf(`${BIDS_GOLDENS}/weights.json`);
  const edit = (changes) => ({ ...golden, ...changes });
  const without = (member) => Object.fromEntries(Object.entries(golden).filter(([name]) => name !== member));
  const did = (n) => `did:vector:${n.toString(16).padStart(2, '0').repeat(32)}`;
  const entry = (rank, changes = {}) => ({ ...golden.ranked[0], rank, desk_did: did(rank), ...changes });
  const withRanked = (ranked, excluded = []) => edit({ ranked, excluded });
  const many = (count) => withRanked(Array.from({ length: count }, (_, i) => entry(i + 1)));
  const withFirst = (changes) => edit({ ranked: [{ ...golden.ranked[0], ...changes }, ...golden.ranked.slice(1)] });
  const domain = (organisation) => withFirst({ organisation });
  const fill = (count, char = 'a') => char.repeat(count);
  // [name, ranking, whether the kit takes it, whether the record takes it]
  const cases = [
    ...RANKING_GOLDENS.map((file) => [file, jsonOf(file), true, true]),
    ['a request identifier of 64 characters', edit({ rfq_id: `a${fill(63, '0')}` }), true, true],
    ['a request identifier of 65 characters', edit({ rfq_id: `a${fill(64, '0')}` }), false, false],
    ['a request identifier with a dot, a hyphen and an underscore', edit({ rfq_id: 'rfq.1-a_b' }), true, true],
    ['a request identifier that starts with a dot', edit({ rfq_id: '.rfq1' }), false, false],
    ['a request identifier with a space', edit({ rfq_id: 'rfq 1' }), false, false],
    ['a request identifier that is a number', edit({ rfq_id: 1 }), false, false],
    ['a tenant of 48 characters', edit({ tenant: `a${fill(47, '0')}` }), true, true],
    ['a tenant of 49 characters', edit({ tenant: `a${fill(48, '0')}` }), false, false],
    ['a tenant in upper case', edit({ tenant: 'RUN1' }), false, false],
    ['a tenant with an underscore', edit({ tenant: 'run_1' }), false, false],
    ['another schema', edit({ schema: 'vector.usecase.ranking.v2' }), false, false],
    ['one ranked entry', withRanked([entry(1)]), true, true],
    ['20 ranked entries', many(20), true, true],
    ['21 ranked entries', many(21), false, false],
    ['no ranked entry', withRanked([]), false, false],
    ['an entry with rank 0', withRanked([entry(0), entry(2)]), false, false],
    ['two entries with rank 1', withRanked([entry(1), entry(2, { rank: 1 })]), false, false],
    ['an organisation of 64 characters', domain(`${fill(31)}.${fill(32, 'b')}`), true, true],
    ['an organisation of 65 characters', domain(`${fill(31)}.${fill(33, 'b')}`), false, false],
    ['an organisation in upper case', domain('Alfa.example.org'), false, false],
    ['an organisation with one label', domain('alfa'), false, false],
    ['an organisation with a dot at the end', domain('alfa.example.org.'), false, false],
    ['an organisation with an empty label', domain('alfa..org'), false, false],
    ['an organisation with a label that starts with a hyphen', domain('-alfa.example.org'), false, false],
    ['an organisation with a label that ends with a hyphen', domain('alfa-.example.org'), false, false],
    ['an organisation with an underscore', domain('alfa_x.example.org'), false, false],
    ['an organisation with a hyphen inside a label', domain('al-fa.example.org'), true, true],
    ['an organisation that is null', domain(null), false, false],
    ['an organisation that is an empty text', domain(''), false, false],
    ['a desk DID of 63 hex digits', withFirst({ desk_did: `did:vector:${'a1'.repeat(32).slice(1)}` }), false, false],
    ['a desk DID in upper case', withFirst({ desk_did: `did:vector:${'A1'.repeat(32)}` }), false, false],
    ['a desk DID of another method', withFirst({ desk_did: `did:other:${'a1'.repeat(32)}` }), false, false],
    // The record reads less than the kit: it takes each of these, and the kit refuses each of them.
    ['ranks 1 and 3, in order', withRanked([entry(1), entry(2, { rank: 3 })]), false, true],
    ['a member of the ranking that is not listed', edit({ carrier: 'x' }), false, true],
    ['a ranking with no weights', without('weights'), false, true],
    ['a score of 101', withFirst({ score: 101 }), false, true],
    ['the same DID in two ranked entries', withRanked([entry(1), entry(2, { desk_did: entry(1).desk_did })]), false, true],
  ];
  // The builder of the kit: the golden ranking from its parts, with the rank of each entry given by its place, and two other rankings.
  const parts = golden.ranked.map(({ rank, ...part }) => part);
  const input = { rfq, tenant: golden.tenant, weights, entries: parts, excluded: golden.excluded };
  const noOrganisation = (n) => { const { organisation, ...part } = parts[0]; return { ...part, desk_did: did(n) }; };
  const builds = [
    ['the golden of the kit', input],
    ['one entry and no excluded bidder', { ...input, entries: parts.slice(0, 1), excluded: [] }],
    ['20 entries, none with an organisation', { ...input, entries: Array.from({ length: 20 }, (_, i) => noOrganisation(i + 1)), excluded: [] }],
  ];
  // The body of the record: the mock service only. The ranking is the golden one, for the tenant of the URL.
  const approval = { attestation: '22'.repeat(32), issuer_did: did(0xb2) };
  const body = (changes = {}) => ({ ranking: golden, salt: '07'.repeat(32), approval, ...changes });
  const bodyWithout = (member) => Object.fromEntries(Object.entries(body()).filter(([name]) => name !== member));
  // [name, body, tenant of the URL, whether the record takes it]
  const bodies = [
    ['a body with an approval', body(), golden.tenant, true],
    ['a body with a null approval', body({ approval: null }), golden.tenant, true],
    ['a body with no approval member', bodyWithout('approval'), golden.tenant, false],
    ['a body with no salt member', bodyWithout('salt'), golden.tenant, false],
    ['a body with no ranking member', bodyWithout('ranking'), golden.tenant, false],
    ['a body with a member that is not listed', body({ carrier: 'x' }), golden.tenant, false],
    ['a salt of 63 hex digits', body({ salt: '07'.repeat(32).slice(1) }), golden.tenant, false],
    ['a salt in upper case', body({ salt: 'AB'.repeat(32) }), golden.tenant, false],
    ['an approval with an attestation in upper case', body({ approval: { ...approval, attestation: 'AB'.repeat(32) } }), golden.tenant, false],
    ['an approval with no issuer', body({ approval: { attestation: approval.attestation } }), golden.tenant, false],
    ['an approval with a member that is not listed', body({ approval: { ...approval, carrier: 'x' } }), golden.tenant, false],
    ['an approval that is an empty object', body({ approval: {} }), golden.tenant, false],
    ['an approval that is a text', body({ approval: 'yes' }), golden.tenant, false],
    ['a ranking of another tenant than the one of the URL', body(), 'run2', false],
  ];
  const answers = inMockServiceStdin(RANKING_DRIFT_CODE, { rankings: cases.map(([, ranking]) => ranking), bodies: bodies.map(([, given, tenant]) => [given, tenant]), builds: builds.map(([, given]) => given) });
  assert.deepEqual([answers.rankings.length, answers.bodies.length, answers.builds.length], [cases.length, bodies.length, builds.length]);
  cases.forEach(([name, ranking, kit, mock], i) => {
    const said = answers.rankings[i];
    assert.equal(said.kit, kit, `${name}: the kit ${kit ? 'must take it' : 'must refuse it'}; found ${JSON.stringify(said)}`);
    assert.equal(said.mock, mock, `${name}: the sourcing record ${mock ? 'must take it' : 'must refuse it'}; found ${JSON.stringify(said)}`);
    // The rule of the kit: a ranking that its parser takes is a ranking that the record takes.
    assert.ok(!said.kit || said.mock, `${name}: the kit takes a ranking that the record refuses`);
    // The record picks the supplier of rank 1 and the request that the ranking names.
    if (said.mock) {
      const top = ranking.ranked.find((one) => one.rank === 1);
      assert.deepEqual(said.read, { rfq_id: ranking.rfq_id, top: top.desk_did, organisation: top.organisation ?? null }, `${name}: the record reads the request and the entry of rank 1`);
    }
  });
  builds.forEach(([name], i) => {
    const built = answers.builds[i];
    assert.deepEqual([built.ok, built.mock, built.again], [true, true, true], `${name}: the kit builds a ranking, its parser takes it, and the record takes it; found ${JSON.stringify(built)}`);
  });
  assert.deepEqual(answers.builds[0].ranking, golden, 'the builder of the kit makes the golden ranking from its parts');
  bodies.forEach(([name, , , taken], i) => assert.equal(answers.bodies[i], taken, `${name}: the record ${taken ? 'must take it' : 'must refuse it'}`));
  assert.ok(cases.filter(([, , kit, mock]) => kit && mock).length >= 10 && cases.filter(([, , kit, mock]) => !kit && !mock).length >= 20 && cases.filter(([, , kit, mock]) => !kit && mock).length >= 4, 'the table has the accepted twins, the refused copies and the cases that only the record takes');
});

// The identifiers and the domains of the documents of use case 3, through each parser that reads one. An identifier is read as the rule of the mock service says: the request identifier of a ranking (the kit and the sourcing
// record), the identifier of a vendor (the vendor parser of the Sourcing Agent and the seed of the mock service), and the SKU of an item of a price list (the kit and the catalogue of the seed). A domain is read as the
// organisation of a record: a lower-case name of at most 64 characters with at least two labels. It stands in a ranking (the kit and the record), in a vendor (the Sourcing Agent and the seed), in the file of a bidder
// (`domainOf` of the Sourcing Agent) and in the setting of a Bid Desk. Each parser must say the same of each edge.
const IDENTIFIER_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { defaultSeed, parseSeed } from './src/seed.ts';
import { parseRanking as store } from './src/documents.ts';
import { parsePriceList, parseRanking as kit } from '../../packages/usecase-kit/src/bids/index.ts';
import { parseVendors } from '../../agents/sourcing-agent/src/scoring/vendors.ts';
import { domainOf } from '../../agents/sourcing-agent/src/bidders/lineage.ts';
import { organisationOf } from '../../agents/bid-desk/src/serve/settings.ts';
const accepted = (run) => { try { run(); return true; } catch (error) { if (error?.name !== 'Invalid') throw error; return false; } };
const { ids, domains, ranking, priceList } = JSON.parse(readFileSync(0, 'utf8'));
const seed = defaultSeed();
const mockRanking = (document) => accepted(() => store({ ranking: document, salt: '07'.repeat(32), approval: null }, 'run1'));
const vendor = (changes) => ({ ...seed.vendors[0], ...changes });
const withFirst = (changes) => ({ ...ranking, ranked: [{ ...ranking.ranked[0], ...changes }, ...ranking.ranked.slice(1)] });
const desk = (value) => { if (typeof value !== 'string') return null; try { organisationOf({ BID_DESK_ORGANISATION: value }); return true; } catch { return false; } };
console.log(JSON.stringify({
  ids: ids.map(([, value]) => ({
    rfq: { kit: kit({ ...ranking, rfq_id: value }).ok, mock: mockRanking({ ...ranking, rfq_id: value }) },
    vendor: { agent: parseVendors({ vendors: [vendor({ vendor_id: value })] }).ok, mock: accepted(() => parseSeed('seed', { vendors: [vendor({ vendor_id: value })] })) },
    sku: { kit: parsePriceList({ ...priceList, items: [{ ...priceList.items[0], sku: value }, ...priceList.items.slice(1)] }).ok, mock: accepted(() => parseSeed('seed', { catalogue: [{ ...seed.catalogue[0], sku: value }] })) },
  })),
  domains: domains.map(([, value]) => ({
    ranking: { kit: kit(withFirst({ organisation: value })).ok, mock: mockRanking(withFirst({ organisation: value })) },
    vendor: { agent: parseVendors({ vendors: [vendor({ organisation: value })] }).ok, mock: accepted(() => parseSeed('seed', { vendors: [vendor({ organisation: value })] })) },
    lineage: domainOf(value) !== null,
    desk: desk(value),
  })),
}));
`;

test('use case 3 drift: an identifier and a domain have the same edges in every parser that reads them: the request identifier of a ranking, the identifier of a vendor, the SKU of a price list and the organisation of a bidder', () => {
  const ranking = jsonOf(RANKING_GOLDENS[0]);
  const priceList = jsonOf(BID_DESK_PRICE_LISTS[0]);
  const fill = (count, char = 'a') => char.repeat(count);
  // [name, value, whether the mock service and the kit take it, whether the vendor parser of the Sourcing Agent takes it when that differs]. The vendor parser turns the texts of the list into the NFC form before it checks the
  // identifier, and the kit and the mock service check the text as it is written. So the parser reads the Kelvin sign as the capital K and takes a vendor that the seed of the mock service never gives. The rule that matters
  // holds: a vendor identifier that the seed takes is one that the parser takes.
  const ids = [
    ['one character', 'a', true], ['64 characters', `a${fill(63, '0')}`, true], ['65 characters', `a${fill(64, '0')}`, false], ['a dot, a hyphen and an underscore inside', 'a.b-c_d', true], ['a digit first', '1a', true],
    ['a dot first', '.a', false], ['a hyphen first', '-a', false], ['an underscore first', '_a', false], ['a space inside', 'a b', false], ['a space at the end', 'a ', false], ['a slash', 'a/b', false], ['a colon', 'a:b', false],
    ['a letter that is not ASCII', 'a\u00e9', false], ['the Kelvin sign, which NFC turns into K', '\u212A-1', false, true], ['no character', '', false], ['a line break at the end', 'a\n', false], ['a number', 1, false], ['null', null, false],
  ];
  const domains = [
    ['two labels', 'a.b', true], ['a domain of 64 characters', `${fill(31)}.${fill(32, 'b')}`, true], ['a domain of 65 characters', `${fill(31)}.${fill(33, 'b')}`, false], ['a label of 62 characters', `${fill(62)}.b`, true],
    ['a label of 63 characters, and 65 characters in all', `${fill(63)}.b`, false], ['a hyphen inside a label', 'al-fa.example.org', true], ['digits only', '1.2', true], ['a label that starts with a hyphen', '-a.example.org', false],
    ['a label that ends with a hyphen', 'a-.example.org', false], ['upper case', 'Alfa.example.org', false], ['one label', 'alfa', false], ['a dot at the end', 'alfa.example.org.', false], ['an empty label', 'alfa..org', false],
    ['an underscore', 'a_b.example.org', false], ['a space', 'alfa .example.org', false], ['a letter that is not ASCII', 'alf\u00e9.example.org', false], ['the Kelvin sign, which NFC turns into the capital K', 'alf\u212A.example.org', false],
    ['no character', '', false], ['null', null, false], ['a number', 1, false],
  ];
  const answers = inMockServiceStdin(IDENTIFIER_DRIFT_CODE, { ids: ids.map(([name, value]) => [name, value]), domains: domains.map(([name, value]) => [name, value]), ranking, priceList });
  assert.deepEqual([answers.ids.length, answers.domains.length], [ids.length, domains.length]);
  ids.forEach(([name, , taken, parserTakes = taken], i) => {
    const said = answers.ids[i];
    for (const [member, pair, expected] of [['the request identifier of a ranking', said.rfq, [taken, taken]], ['the identifier of a vendor', said.vendor, [parserTakes, taken]], ['the SKU of a price list', said.sku, [taken, taken]]]) {
      assert.deepEqual(Object.values(pair), expected, `${name}, ${member}: the parsers must say ${JSON.stringify(expected)}; found ${JSON.stringify(pair)}`);
      if (pair === said.vendor) assert.ok(!pair.mock || pair.agent, `${name}: the seed takes a vendor identifier that the vendor parser refuses`);
    }
  });
  domains.forEach(([name, , taken], i) => {
    const said = answers.domains[i];
    // The setting of a Bid Desk takes a text only, so it says nothing of a value that is not one (null).
    const readers = [said.ranking.kit, said.ranking.mock, said.vendor.agent, said.vendor.mock, said.lineage, ...(said.desk === null ? [] : [said.desk])];
    assert.deepEqual(readers, readers.map(() => taken), `${name}: each reader ${taken ? 'must take it' : 'must refuse it'}; found ${JSON.stringify(said)}`);
  });
  for (const table of [ids, domains]) assert.ok(table.filter(([, , taken]) => taken).length >= 4 && table.filter(([, , taken]) => !taken).length >= 10, 'the table has the accepted twins and the refused copies');
});

// The body that the Sourcing Agent sends to the sourcing record. The real job `execute` runs in the world of its own tests, with a gateway that is a stub and a fake sourcing record that keeps each call, and the body
// of that call goes to the reader of the real mock service. So the test does not build the body itself.
const EXECUTE_DRIFT_CODE = String.raw`
import { parseRanking as store } from './src/documents.ts';
import { world } from '../../agents/sourcing-agent/test/execute/world.ts';
import { APPROVAL, SALT } from '../../agents/sourcing-agent/test/execute/fixtures.ts';
const read = (text) => { try { const found = store(JSON.parse(text), 'run1'); return { rfq_id: found.rfq_id, top: found.top, organisation: found.topOrganisation, salt: found.salt, approval: found.approval }; } catch (error) { if (error?.name !== 'Invalid') throw error; return null; } };
const runs = [];
for (const approval of [APPROVAL, null]) {
  const w = world();
  await w.run(w.request(w.document(), approval));
  runs.push({ calls: w.record.calls.map((call) => ({ method: call.method, url: call.url, body: call.body })), read: w.record.calls.length === 1 ? read(w.record.calls[0].body) : null });
}
console.log(JSON.stringify({ runs, approval: APPROVAL, salt: SALT }));
`;

test('use case 3 drift: the body that the Sourcing Agent sends to the sourcing record is a body that the record reads: the job makes one call with the ranking as the hirer holds it, the salt and the approval, and the record takes the supplier, the request, the salt and the approval of it', () => {
  const golden = jsonOf(`${SOURCING_TESTS}/execute/golden/ranking.json`);
  const answer = inMockServiceStdin(EXECUTE_DRIFT_CODE, null);
  assert.equal(answer.runs.length, 2, 'one run with an approval and one with none');
  const top = golden.ranked.find((one) => one.rank === 1);
  answer.runs.forEach(({ calls, read }, i) => {
    const name = i === 0 ? 'a request with an approval' : 'a request with no approval';
    assert.equal(calls.length, 1, `${name}: the job makes one call`);
    assert.deepEqual([calls[0].method, calls[0].url], ['POST', 'https://mock.example/t/run1/sourcing/rankings'], `${name}: the route of the record`);
    const sent = JSON.parse(calls[0].body);
    assert.deepEqual(Object.keys(sent), ['ranking', 'salt', 'approval'], `${name}: the members of the body, in order`);
    assert.equal(JSON.stringify(sent.ranking), JSON.stringify(golden), `${name}: the ranking is the document that the hirer approved, with its members in their order`);
    assert.deepEqual(read, { rfq_id: golden.rfq_id, top: top.desk_did, organisation: top.organisation ?? null, salt: answer.salt, approval: i === 0 ? answer.approval : null }, `${name}: the record reads the request, the supplier of rank 1, the salt and the approval`);
  });
});

// The price lists of the three Bid Desks against the default catalogue of the mock service: each SKU of a list is a SKU of the catalogue, the three lists together hold each SKU of it, and each unit price is at least
// 10, so that the fault of a Bid Desk, which lowers the price of the first line by a fifth rounded up, gives a whole number of at least 1. The kit reads each list as a price list, and the manifest of each Bid Desk
// holds the hash of the bytes of its list, so the three lists have three hashes.
const CATALOGUE_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { defaultSeed } from './src/seed.ts';
import { parsePriceList, priceListSha256 } from '../../packages/usecase-kit/src/bids/index.ts';
const { texts } = JSON.parse(readFileSync(0, 'utf8'));
const read = (text) => {
  const list = JSON.parse(text);
  const found = parsePriceList(list);
  return found.ok ? { ok: true, same: JSON.stringify(found.value) === JSON.stringify(list), skus: found.value.items.map((item) => item.sku), prices: found.value.items.flatMap((item) => item.breaks.map((step) => step.unit_price)) } : { ok: false };
};
console.log(JSON.stringify({
  catalogue: defaultSeed().catalogue.map((entry) => entry.sku),
  lists: Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, { ...read(text), sha256: priceListSha256(text) }])),
}));
`;
function priceListDriftProblems(lists, catalogue) {
  const problems = [];
  const held = new Set();
  for (const [name, list] of Object.entries(lists)) {
    if (!list.ok || !list.same) {
      problems.push(`the price list of ${name} is not a price list that the kit reads and gives back as it is`);
      continue;
    }
    for (const sku of list.skus) {
      held.add(sku);
      if (!catalogue.includes(sku)) problems.push(`the price list of ${name} holds ${sku}, and the catalogue of the mock service does not`);
    }
    for (const price of list.prices) if (price < 10) problems.push(`the price list of ${name} has a unit price of ${price}, and the least unit price is 10`);
  }
  for (const sku of catalogue) if (!held.has(sku)) problems.push(`the catalogue holds ${sku}, and no price list does`);
  const hashes = Object.values(lists).map((list) => list.sha256);
  if (new Set(hashes).size !== hashes.length) problems.push('two price lists have the same hash');
  return problems;
}

test('use case 3 drift: each SKU of the three price lists is a SKU of the default catalogue of the mock service, the three lists together hold each SKU of it, each unit price is at least 10, and the three lists have three hashes; the guard refuses a SKU that the catalogue lacks, a SKU that no list holds, a low price and two lists with one hash', () => {
  const texts = Object.fromEntries(BID_DESKS.map((name, i) => [name, read(BID_DESK_PRICE_LISTS[i])]));
  const answer = inMockServiceStdin(CATALOGUE_DRIFT_CODE, { texts });
  assert.ok(answer.catalogue.length >= 3, `the catalogue has the SKUs of the seed, found ${answer.catalogue.length}`);
  assert.deepEqual(Object.keys(answer.lists), BID_DESKS, 'one list for each Bid Desk');
  assert.deepEqual(priceListDriftProblems(answer.lists, answer.catalogue), [], 'the real lists pass');
  for (const name of BID_DESKS) assert.equal(answer.lists[name].sha256, createHash('sha256').update(texts[name], 'utf8').digest('hex'), `${name}: the hash is the SHA-256 of the bytes of the file`);
  const copy = () => JSON.parse(JSON.stringify(answer.lists));
  const faults = [
    ['a SKU that the catalogue lacks', (lists) => { lists.alfa.skus[0] = 'GLV-NIT-L'; }, /the price list of alfa holds GLV-NIT-L, and the catalogue of the mock service does not/],
    ['a SKU of the catalogue that no list holds', (lists) => { for (const name of BID_DESKS) lists[name].skus = lists[name].skus.filter((sku) => sku !== answer.catalogue[0]); }, /the catalogue holds \S+, and no price list does/],
    ['a unit price of 9', (lists) => { lists.bravo.prices[0] = 9; }, /the price list of bravo has a unit price of 9, and the least unit price is 10/],
    ['a list that the kit does not read', (lists) => { lists.charlie = { ok: false }; }, /the price list of charlie is not a price list that the kit reads/],
    ['a list that the kit reads and changes', (lists) => { lists.charlie.same = false; }, /the price list of charlie is not a price list that the kit reads and gives back as it is/],
    ['two lists with one hash', (lists) => { lists.bravo.sha256 = lists.alfa.sha256; }, /two price lists have the same hash/],
  ];
  for (const [name, change, expected] of faults) {
    const lists = copy();
    change(lists);
    const problems = priceListDriftProblems(lists, answer.catalogue);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the least price that the guard takes, the catalogue in another order, and a list that holds a SKU of the catalogue and no other.
  const lists = copy();
  lists.alfa.prices[0] = 10;
  assert.deepEqual(priceListDriftProblems(lists, [...answer.catalogue].reverse()), [], 'a price of 10, and the catalogue in another order');
});

// The vendors of the default seed of the mock service, as the vendor parser of the Sourcing Agent reads them. The route of the vendors gives the vendors of the seed of the tenant, so each vendor list that the seed
// takes must be a list that the parser takes, and the parser may take more. The organisation of each vendor is the key of the entry that a scorer reads: the entry whose organisation is the verified organisation of
// the bidder. The default seed names three example domains, and the seed that the operator gives a tenant names the domains of the three Bid Desks, so a vendor with each of those domains must be read too.
const VENDORS_DRIFT_CODE = String.raw`
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { defaultSeed, parseSeed } from './src/seed.ts';
import { parseVendors } from '../../agents/sourcing-agent/src/scoring/vendors.ts';
const accepted = (run) => { try { run(); return true; } catch (error) { if (error?.name !== 'Invalid') throw error; return false; } };
const { cases, desks } = JSON.parse(readFileSync(0, 'utf8'));
const seed = defaultSeed();
const base = seed.vendors[0];
const others = (count) => Array.from({ length: count }, (_, i) => ({ ...base, vendor_id: 'V-' + (2000 + i) }));
const vendorsOf = (op) => {
  switch (op.kind) {
    case 'default': return seed.vendors;
    case 'count': return others(op.count);
    case 'twice': return [base, { ...base }];
    case 'rename': { const { [op.from]: value, ...rest } = base; return [{ ...rest, [op.to]: value }]; }
    case 'drop': { const { [op.member]: gone, ...rest } = base; return [rest]; }
    default: return [{ ...base, [op.member]: op.value }];
  }
};
const both = (vendors) => ({ mock: accepted(() => parseSeed('seed', { vendors })), agent: parseVendors({ vendors: JSON.parse(JSON.stringify(vendors)) }).ok });
const body = { vendors: JSON.parse(JSON.stringify(seed.vendors)) };
const read = parseVendors(body);
console.log(JSON.stringify({
  seed: { ok: read.ok, same: read.ok && isDeepStrictEqual(JSON.parse(JSON.stringify(read.value)), body.vendors), organisations: seed.vendors.map((vendor) => vendor.organisation) },
  cases: cases.map(([, op]) => both(vendorsOf(op))),
  desks: desks.map((organisation) => ({ organisation, ...both([{ ...base, vendor_id: 'V-9999', organisation }]) })),
}));
`;

test('use case 3 drift: the default vendors of the mock service are a vendor list that the vendor parser of the Sourcing Agent reads, each vendor list that the seed takes is read by the parser, and a vendor with the organisation of each Bid Desk is read by both', (t) => {
  const desks = BID_DESKS.map((name) => parseYaml(read(`deploy/server/docker-compose.bid-desk-${name}.yml`)).services.service.environment.BID_DESK_ORGANISATION);
  const fill = (count, char = 'a') => char.repeat(count);
  const set = (member, value) => ({ kind: 'set', member, value });
  // [name, what to change in the first vendor of the seed, whether the seed takes it, whether the parser takes it]
  const cases = [
    ['the vendors of the default seed', { kind: 'default' }, true, true],
    ['one vendor', { kind: 'count', count: 1 }, true, true], ['50 vendors', { kind: 'count', count: 50 }, true, true], ['51 vendors', { kind: 'count', count: 51 }, false, false],
    ['a vendor identifier two times', { kind: 'twice' }, false, false], ['a member that is renamed', { kind: 'rename', from: 'defect_rate', to: 'defects' }, false, false],
    ['a member that is not listed', set('rating', 5), false, false], ['a member that is missing', { kind: 'drop', member: 'last_audit' }, false, false],
    ['a rate of 1', set('on_time_delivery_rate', 1), true, true], ['a rate of 1.01', set('on_time_delivery_rate', 1.01), false, false], ['a negative rate', set('defect_rate', -0.1), false, false],
    ['a rate as a text', set('defect_rate', '0.01'), false, false], ['200 years as a vendor', set('years_as_vendor', 200), true, true], ['201 years as a vendor', set('years_as_vendor', 201), false, false],
    ['payment terms of 365 days', set('payment_terms_days', 365), true, true], ['payment terms of 366 days', set('payment_terms_days', 366), false, false], ['payment terms of 0 days', set('payment_terms_days', 0), true, true],
    ['10 certifications', set('certifications', Array.from({ length: 10 }, (_, i) => `ISO ${i}`)), true, true], ['11 certifications', set('certifications', Array.from({ length: 11 }, (_, i) => `ISO ${i}`)), false, false],
    ['no certification', set('certifications', []), true, true], ['a certification of 64 characters', set('certifications', [fill(64)]), true, true], ['a certification of 65 characters', set('certifications', [fill(65)]), false, false],
    ['an empty certification', set('certifications', ['']), false, false], ['a date that does not exist', set('last_audit', '2026-02-30'), false, false], ['a date in the year 0099', set('last_audit', '0099-01-01'), false, false],
    ['a date with a time', set('last_audit', '2026-03-14T00:00:00Z'), false, false], ['a name of 200 characters', set('name', fill(200)), true, true],
    // The parser reads more than the seed takes: a name of 201 to 500 characters comes from no seed, and the parser takes it.
    ['a name of 201 characters', set('name', fill(201)), false, true],
  ];
  const answer = inMockServiceStdin(VENDORS_DRIFT_CODE, { cases: cases.map(([name, op]) => [name, op]), desks });
  assert.deepEqual(answer.seed, { ok: true, same: true, organisations: answer.seed.organisations }, `the vendors of the default seed are read by the parser and given back as they are; found ${JSON.stringify(answer.seed)}`);
  // The set of the vendor organisations of the default seed is reported: the tenant seed of the operator replaces it with the domains of the three Bid Desks.
  t.diagnostic(`vendor organisations of the default seed: ${answer.seed.organisations.join(', ')}; organisations of the three Bid Desks: ${desks.join(', ')}`);
  assert.ok(answer.seed.organisations.length >= 3 && new Set(answer.seed.organisations).size === answer.seed.organisations.length, 'the default seed has at least three vendors, each with an organisation of its own');
  assert.equal(answer.cases.length, cases.length);
  cases.forEach(([name, , mock, agent], i) => {
    assert.deepEqual(answer.cases[i], { mock, agent }, `${name}: the seed ${mock ? 'takes' : 'refuses'} it, and the parser ${agent ? 'takes' : 'refuses'} it; found ${JSON.stringify(answer.cases[i])}`);
    assert.ok(!answer.cases[i].mock || answer.cases[i].agent, `${name}: the seed takes a vendor list that the parser refuses`);
  });
  assert.ok(cases.filter(([, , mock, agent]) => mock && agent).length >= 10 && cases.filter(([, , mock, agent]) => !mock && !agent).length >= 15, 'the table has the accepted twins and the refused copies');
  assert.deepEqual(answer.desks, desks.map((organisation) => ({ organisation, mock: true, agent: true })), 'a vendor with the organisation of each Bid Desk is read by the seed and by the parser');
});

// The routes and the actions. A route that an agent calls with a token has an action, a system and a rule for the act chain of the token: one link for an agent, and two for a subagent. The kit holds the route table of
// the agents, and the mock service holds the routes that it serves. A route of one is a route of the other, with the same action, the same system and the same callers. The manifest of an agent lists the routes of the
// mock systems that it relies on: the Sourcing Agent relies on the vendor list and the sourcing record, and the Bid Desk on none.
const ROUTES_DRIFT_CODE = String.raw`
import { ROUTES as mock } from './src/routes.ts';
import { ROUTES as kit } from '../../packages/usecase-kit/src/access/index.ts';
console.log(JSON.stringify({ mock: mock.map((route) => ({ id: route.id, method: route.method, segments: route.segments, need: route.need })), kit }));
`;
// The faults of the routes: a route of the kit that the mock service lacks, a credential, an action, a system or a rule of callers that differ, a route of the mock service that the kit lacks, and a manifest that lists
// other routes than the ones that its agent uses.
function routeProblems({ mock, kit }, manifests) {
  const problems = [];
  const pathOf = (route) => `${route.method} /${route.segments.join('/')}`;
  const specPath = (spec) => `${spec.method} ${spec.template.replace(/\{(\w+)\}/g, ':$1')}`;
  const kinds = { token: 'token', 'x509-svid': 'x509', 'jwt-svid': 'jwt' };
  for (const [id, spec] of Object.entries(kit)) {
    const route = mock.find((one) => pathOf(one) === specPath(spec));
    if (route === undefined) {
      problems.push(`the route ${id} of the kit is no route of the mock service`);
      continue;
    }
    if (route.need.kind !== kinds[spec.credential]) problems.push(`${id}: the kit takes a ${spec.credential}, and the mock service needs ${route.need.kind}`);
    else if (spec.credential === 'token') {
      if (route.need.action !== spec.action) problems.push(`${id}: the kit asks for the action ${spec.action}, and the mock service needs ${route.need.action}`);
      if (route.need.system !== spec.system) problems.push(`${id}: the kit names the system ${spec.system}, and the mock service names ${route.need.system}`);
      if (route.need.maxActors !== (spec.callers === 'agent' ? 1 : 2)) problems.push(`${id}: the kit lets ${spec.callers} call, and the mock service takes an act chain of ${route.need.maxActors}`);
    }
  }
  for (const route of mock) {
    if (['open', 'admin'].includes(route.need.kind)) continue;
    if (!Object.values(kit).some((spec) => specPath(spec) === pathOf(route))) problems.push(`the route ${route.id} of the mock service is no route of the kit`);
  }
  for (const [agent, listed, ids] of manifests) {
    const wanted = ids.map((id) => `${kit[id].method} /t/{tenant}${kit[id].template}`);
    if (!isDeepStrictEqual([...listed].sort(), [...wanted].sort())) problems.push(`the manifest of the ${agent} lists ${JSON.stringify(listed)}, and its routes are ${JSON.stringify(wanted)}`);
  }
  return problems;
}

test('use case 3 drift: the route table of the kit and the routes of the mock service name the same routes, actions, systems and callers, and the manifests of the Sourcing Agent and of the Bid Desk list the routes that they use; the guard refuses each difference', () => {
  const answer = inMockServiceStdin(ROUTES_DRIFT_CODE, null);
  const manifestOf = (agent) => JSON.parse(read(`agents/${agent}/agent.json.template`)).behaviour.relying_on.mock_systems;
  const manifests = [['Sourcing Agent', manifestOf('sourcing-agent'), ['vendors.list', 'sourcing.rankings']], ['Bid Desk', manifestOf('bid-desk'), []]];
  assert.ok(Object.keys(answer.kit).length >= 11 && answer.mock.length >= 13, `both tables have their routes, found ${Object.keys(answer.kit).length} and ${answer.mock.length}`);
  // The two routes of the Sourcing Agent: the vendor list for a scorer (an agent or a subagent), and the write of the ranking for the agent only.
  assert.deepEqual([answer.kit['vendors.list'].action, answer.kit['vendors.list'].callers, answer.kit['sourcing.rankings'].action, answer.kit['sourcing.rankings'].callers], ['vendor.read', 'agent-or-subagent', 'sourcing.award.write', 'agent'], 'the actions of the Sourcing Agent');
  assert.deepEqual(routeProblems(answer, manifests), [], 'the real tables and manifests pass');
  const copy = () => JSON.parse(JSON.stringify(answer));
  const mockRoute = (data, id) => data.mock.find((route) => route.id === id);
  const faults = [
    ['an action of the vendor list that differs', (data) => { mockRoute(data, 'GET /vendors').need.action = 'vendor.view'; }, /vendors\.list: the kit asks for the action vendor\.read, and the mock service needs vendor\.view/],
    ['a system of the sourcing record that differs', (data) => { mockRoute(data, 'POST /sourcing/rankings').need.system = 'vendors'; }, /sourcing\.rankings: the kit names the system sourcing, and the mock service names vendors/],
    ['an act chain of the vendor list that is too short for a scorer', (data) => { mockRoute(data, 'GET /vendors').need.maxActors = 1; }, /vendors\.list: the kit lets agent-or-subagent call, and the mock service takes an act chain of 1/],
    ['an act chain of the sourcing record that takes a subagent', (data) => { mockRoute(data, 'POST /sourcing/rankings').need.maxActors = 2; }, /sourcing\.rankings: the kit lets agent call, and the mock service takes an act chain of 2/],
    ['a route of the kit that the mock service lacks', (data) => { data.mock = data.mock.filter((route) => route.id !== 'POST /sourcing/rankings'); }, /the route sourcing\.rankings of the kit is no route of the mock service/],
    ['a credential that differs', (data) => { mockRoute(data, 'POST /supplier/orders').need = { kind: 'jwt' }; }, /supplier\.orders: the kit takes a x509-svid, and the mock service needs jwt/],
    ['a route of the mock service that the kit lacks', (data) => { data.mock.push({ id: 'GET /x', method: 'GET', segments: ['x'], need: { kind: 'token', action: 'x.read', system: 'erp', maxActors: 1 } }); }, /the route GET \/x of the mock service is no route of the kit/],
  ];
  for (const [name, change, expected] of faults) {
    const data = copy();
    change(data);
    const problems = routeProblems(data, manifests);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  const manifestFaults = [
    ['a manifest of the Sourcing Agent that lists one route only', [['Sourcing Agent', manifests[0][1].slice(0, 1), manifests[0][2]]], /the manifest of the Sourcing Agent lists/],
    ['a manifest of the Sourcing Agent that lists a route of the kit that it does not use', [['Sourcing Agent', [...manifests[0][1], 'GET /t/{tenant}/erp/stock/{sku}'], manifests[0][2]]], /the manifest of the Sourcing Agent lists/],
    ['a manifest of the Bid Desk that lists a route', [['Bid Desk', manifests[0][1], []]], /the manifest of the Bid Desk lists/],
  ];
  for (const [name, given, expected] of manifestFaults) {
    const problems = routeProblems(answer, given);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: found ${JSON.stringify(problems)}`);
  }
  // The twins: the routes of the mock service in another order, and the routes of a manifest in another order.
  const reversed = copy();
  reversed.mock.reverse();
  assert.deepEqual(routeProblems(reversed, [['Sourcing Agent', [...manifests[0][1]].reverse(), manifests[0][2]], manifests[1]]), [], 'another order');
});
