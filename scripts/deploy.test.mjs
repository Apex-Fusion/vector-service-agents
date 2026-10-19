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
// Advocate is PROPOSED (built, not deployed) since 2026-10-13: its four deploy files, read by the tests of the status words and of its stack.
const A_FILES = ['deploy/host/docker-compose.advocate.yml', 'deploy/host/.env.advocate.example', 'deploy/host/Caddyfile.advocate.snippet', 'deploy/host/RUNBOOK-advocate.md'];
const PUBLIC_FILES = ['deploy/host/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/.env.agent-history.example', 'deploy/host/Caddyfile.snippet', 'agents/agent-history/Dockerfile', '.dockerignore', ...PIPELINE_FILES, 'agents/document-pipeline/Dockerfile'];

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
});

test('compose: the runtime is built from the pinned template commit, written in full because BuildKit does not resolve the short form', () => {
  assert.match(agent.build.context, /^https:\/\/github\.com\/Apex-Fusion\/vector-agent-template\.git#c4c378a[0-9a-f]{33}$/);
  assert.equal(agent.build.dockerfile, 'agent/Dockerfile');
  assert.ok(SPEC.includes('pinned commit `c4c378a`'), 'the spec names the same commit');
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

test('env example: known names only, each once; every secret is empty; nothing in the example or in the compose environment looks like key material', () => {
  const RUNTIME = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'ADVERT_REF'];
  const POST_ADVERT = ['ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
  const MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
  assert.deepEqual(Object.keys(example).filter((n) => ![...RUNTIME, ...POST_ADVERT, ...MANIFEST].includes(n)), [], 'a name the runtime, the advert command and the service never read');
  assert.deepEqual(keyProblems(example), []);
  assert.deepEqual(keyProblems(agent.environment), [], 'the compose environment of the runtime');
  assert.deepEqual(keyProblems(service.environment), [], 'the compose environment of the service');
  for (const name of ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(example[name], '', `${name} is filled by the runbook`);
  // The contact is the one value the operator types. It is a placeholder in angle brackets (never an address), and it says what goes there.
  assert.match(example.OPERATOR_CONTACT, PLACEHOLDER);
  assert.ok(example.OPERATOR_CONTACT.startsWith('<role address'), 'a role address is asked for');
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
  // From .env.example of vector-agent-template at c4c378a. The optional ones (SERVICE_AUTH_HEADER, WALLET_HEALTH_INTERVAL_MS, BUYER_PRIV_KEY_HEX) are left out.
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'PORT'];
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

test('env example: the status word is the spec status, and the manifest it produces is the default manifest', () => {
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
  assert.deepEqual(withExample, withNothing, 'the example changes nothing in the manifest the advert will hash');
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

test('README, RUNBOOK, compose file and Caddy snippet: Agent History is DEPLOYED since 2026-10-15, the Document Pipeline since 2026-10-16 and Audio Snippets since 2026-10-17, Advocate is PROPOSED (built, not deployed), nothing is LIVE; no dash, no unit name, no person named', () => {
  const STATUS = 'Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE.';
  // The Pipeline is the second stack of the box: its section of the README and its runbook carry its own status line, DEPLOYED since 2026-10-16 (RUNBOOK-document-pipeline.md step 17).
  const P_README_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this section is LIVE.';
  const P_RUNBOOK_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this folder is LIVE.';
  // Audio Snippets is the third stack of the host, DEPLOYED since 2026-10-17 (RUNBOOK-audio-snippets.md step 17): its section of the README carries its own status line, which denies LIVE.
  const S_README_STATUS = 'Status: DEPLOYED since 2026-10-17. Nothing in this section is LIVE.';
  // Advocate is the fourth stack of the host, PROPOSED (built, not deployed): its section of the README carries its own status line, which denies LIVE (RUNBOOK-advocate.md step 17 changes it).
  const A_README_STATUS = 'Status: PROPOSED (built, not deployed) since 2026-10-13. Nothing in this section is LIVE.';
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
    ...readdirSync(join(root, 'specs')).map((f) => `specs/${f}`),
    DESIGN_SPEC,
  ];
  assert.ok(files.length >= 23 && new Set(files).size === files.length, `the list reaches every surface, found ${files.length}`);
  for (const must of ['agents/agent-history/agent.json.template', 'agents/agent-history/src/server.ts', 'specs/agent-history.md', 'specs/document-pipeline.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', DESIGN_SPEC]) assert.ok(files.includes(must), `${must} is scanned`);
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

// ---- The status words after the flips of 2026-10-15, 2026-10-16 and 2026-10-17 ----
// Agent History, Document Pipeline and Audio Snippets are DEPLOYED. Advocate, which is built and not deployed, is PROPOSED. Nothing here is LIVE.
// A line that says PROPOSED has to be one of the lines below, so the word cannot come back for the three that are deployed; a line that says LIVE has to deny it.
test('status words: no file says PROPOSED about Agent History, Document Pipeline or Audio Snippets, and no file says LIVE except to deny it', () => {
  const OTHER_AGENTS = ['specs/advocate.md'];
  // The four deploy files of Audio Snippets and its README: since the flip of 2026-10-17 they are held to the rule as the files of the other two are.
  const SNIPPETS_FILES = [...S_FILES, 'agents/audio-snippets/README.md'];
  // Advocate is built and PROPOSED until step 17 of its runbook: its four deploy files and its README say the word in their status lines and their instructions.
  const ADVOCATE_FILES = [...A_FILES, 'agents/advocate/README.md'];
  // What may still say PROPOSED outside the spec of the agent that is PROPOSED: its row in the table of the root README, the rule that lists the three words,
  // the marketplace tools in the Interface section of the spec (the tools, not the agent), and the instructions of the three runbooks that speak for the order of a first run.
  const PROPOSED_OK = {
    'README.md': [/^\| Advocate \| `[a-z.0-9-]+` \| PROPOSED \|$/],
    'deploy/host/README.md': [/^Status: PROPOSED \(built, not deployed\) since 2026-10-13\. Nothing in this section is LIVE\. Steps 1 to 10 of its runbook were run on 2026-10-18 and 2026-10-19 /],
    'agents/agent-history/README.md': [/`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./],
    'specs/agent-history.md': [/^The marketplace MCP tools \(PROPOSED\) and the template's buyer, /],
    'deploy/host/RUNBOOK.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Agent History/],
    'deploy/host/RUNBOOK-document-pipeline.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about the Document Pipeline/],
    'deploy/host/RUNBOOK-audio-snippets.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Audio Snippets/],
  };
  // What may say LIVE: the sentence that denies it, and the rule that lists the three words.
  const LIVE_OK = [/Nothing (on this page|in this guide|in this folder|in this section) is LIVE( or DEPLOYED)?\./, /`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./];
  const files = repoFiles().filter((f) => /(\.md|\.yml|Caddyfile\.snippet|Caddyfile\.[a-z-]+\.snippet|\.example|\.template)$/.test(f));
  for (const f of ['specs/agent-history.md', 'specs/advocate.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/README.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/Caddyfile.snippet', 'deploy/host/.env.agent-history.example', 'agents/agent-history/agent.json.template', ...PIPELINE_FILES, ...SNIPPETS_FILES, ...ADVOCATE_FILES, 'agents/advocate/agent.json.template']) assert.ok(files.includes(f), `${f} is walked`);
  for (const f of files) {
    const lines = read(f).split('\n');
    if (!OTHER_AGENTS.includes(f) && !ADVOCATE_FILES.includes(f)) for (const line of lines.filter((l) => /\bPROPOSED\b/.test(l))) assert.ok((PROPOSED_OK[f] ?? []).some((re) => re.test(line)), `${f} says PROPOSED: ${line.slice(0, 110)}`);
    for (const line of lines.filter((l) => /\bLIVE\b/.test(l))) assert.ok(LIVE_OK.some((re) => re.test(line)), `${f} says LIVE: ${line.slice(0, 110)}`);
  }
  // The values the manifest and the env example carry are neither proposed nor live.
  assert.match(exampleText, /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/agent-history/agent.json.template')).status, { chip: 'deployed', since: '2026-10-15' });
  assert.match(read('deploy/host/.env.document-pipeline.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/document-pipeline/agent.json.template')).status, { chip: 'deployed', since: '2026-10-16' });
  assert.match(read('deploy/host/.env.audio-snippets.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/audio-snippets/agent.json.template')).status, { chip: 'deployed', since: '2026-10-17' });
  // Advocate is built and PROPOSED until step 17 of its runbook, in its spec, and its env example and its manifest carry the word proposed since 2026-10-13. Document Pipeline is DEPLOYED since 2026-10-16 and Audio Snippets since 2026-10-17, each in the line of its spec.
  assert.match(read('specs/advocate.md'), /^PROPOSED \(built, not deployed\)\. Since 2026-10-13\.$/m);
  assert.match(read('deploy/host/.env.advocate.example'), /^AGENT_STATUS_CHIP=proposed$/m);
  assert.deepEqual(JSON.parse(read('agents/advocate/agent.json.template')).status, { chip: 'proposed', since: '2026-10-13' });
  assert.match(read('specs/audio-snippets.md'), /^DEPLOYED \(registered and staked 2026-10-17, advertised 2026-10-17, re-advertised 2026-10-17 at the status flip, one first-party job settled 2026-10-17\)\. Since 2026-10-17\.$/m);
  assert.match(read('specs/document-pipeline.md'), /^DEPLOYED \(registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16\)\. Since 2026-10-16\.$/m);
  // The specs that open a line with PROPOSED are the one this test lets say it anywhere: read from the specs folder, so that a second spec, or a spec that drops the word, is seen.
  const proposed = readdirSync(join(root, 'specs')).filter((f) => /^PROPOSED \(/m.test(read(`specs/${f}`))).map((f) => `specs/${f}`).sort();
  assert.deepEqual(proposed, [...OTHER_AGENTS].sort(), 'the spec that says PROPOSED is the one that may say it anywhere');
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
const P_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO'];
const P_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const P_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
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
  assert.match(pAgent.build.context, /^https:\/\/github\.com\/Apex-Fusion\/vector-agent-template\.git#c4c378a[0-9a-f]{33}$/);
  assert.ok(PSPEC.includes('pinned commit `c4c378a`'), 'the spec names the same commit');
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
  // The runtime sends SERVICE_AUTH_HEADER as the authorization header of every call (vector-agent-template c4c378a, agent/src/executor/httpCallout.ts), and the service requires it on POST /.
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

test('Pipeline env example: the blocks in order (supplier, buyer, token, chain, advert, manifest, hires), known names only, each once; every secret is empty and nothing looks like key material but the public key hash of the OCR supplier', () => {
  assert.deepEqual(Object.keys(pExample), [...P_SUPPLIER, ...P_BUYER, ...P_TOKEN, ...P_CHAIN, ...P_ADVERT, ...P_MANIFEST, ...P_HIRES]);
  const { OCR_ALLOWLIST_SUPPLIER_PKH, ...rest } = pExample;
  assert.deepEqual(keyProblems(rest), []);
  assert.deepEqual(keyProblems(pAgent.environment), [], 'the compose environment of the runtime');
  assert.deepEqual(keyProblems(pService.environment), [], 'the compose environment of the service');
  for (const name of [...P_SUPPLIER, ...P_BUYER, ...P_TOKEN, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(pExample[name], '', `${name} is filled by the runbook`);
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
  // ceilings of ruling R56 are 1000000 lovelace each in agents/document-pipeline/src/start.ts).
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_KOIOS_URL', 'VECTOR_EXPLORER_URL', 'KOIOS_URL', 'INDEXER_URL', 'OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE'];
  assert.deepEqual([...names].filter((n) => !(n in pExample) && !(n in pService.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in pExample), `${n} stays unset in the example`);
  // The two ceilings are in the example all the same, commented, with the default of the code.
  assert.ok(START.includes('export const PRICE_CEILING_DEFAULT_LOVELACE = 1_000_000n;'));
  for (const name of ['OCR_MAX_PRICE_LOVELACE', 'LLM_MAX_PRICE_LOVELACE']) {
    assert.ok(names.has(name), `the service reads ${name}`);
    assert.match(pExampleText, new RegExp(`^# ${name}=1000000$`, 'm'), `${name} is in the example, commented, at its default`);
  }
  for (const n of ['OPERATOR_CONTACT', 'PIPELINE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SERVICE_AUTH_HEADER', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST', 'PIPELINE_STATE_DIR']) assert.ok(names.has(n), `the service reads ${n}`);
  assert.ok(!names.has('SUPPLIER_PRIV_KEY_HEX'), "no source of the service reads the supplier key: it is the runtime's");
});

test('Pipeline env example: the runtime gets every name the pinned template lists for CAPABILITY_KIND=custom', () => {
  // The same list as for Agent History: from .env.example of vector-agent-template at c4c378a.
  // SERVICE_AUTH_HEADER is optional in the template ("" sends no header); this pack sets it, so that the runtime sends the token the service requires (R50).
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT'];
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

test('Pipeline env example: the status word is deployed since 2026-10-16, and the manifest it produces is the default manifest of the service', () => {
  assert.equal(pExample.AGENT_STATUS_CHIP, 'deployed', 'the advert is Active and one first-party job has settled (step 17), which shows that the path works and is not demand, so nothing may claim live');
  assert.equal(pExample.AGENT_STATUS_SINCE, '2026-10-16');
  assert.notEqual(pExample.AGENT_STATUS_SINCE, '', 'an empty AGENT_STATUS_SINCE is refused by the service');
  // The comment says what the word is, who changes it, and what a first run starts with.
  assert.match(pExampleText, /^# The status word the manifest carries, and since when: deployed since 2026-10-16, after the advert was Active and a first-party job had settled \(RUNBOOK-document-pipeline\.md step 17, "Flip the status"\)\. A first-party run is not demand, so the word is not live\.$/m);
  assert.match(pExampleText, /^# On a first run, before any job has settled, set proposed and today's date here; step 17 changes them\.$/m);
  const [withExample, withNothing] = renderManifests([{ ...withoutPlaceholders(pExample), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }], 'agents/document-pipeline');
  assert.deepEqual(withExample, withNothing, 'the example changes nothing in the manifest the advert will hash');
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
  assert.ok(rows[0].startsWith(`| \`${pAgent.container_name}\` | built on the box from \`https://github.com/Apex-Fusion/vector-agent-template.git\` at the same pinned commit \`c4c378a\` (\`CAPABILITY_KIND=custom\`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on \`127.0.0.1:8084\` only |`));
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

test('Pipeline RUNBOOK: the twenty-one sections in order, the seventeen steps keep the numbers of the Agent History runbook, three titles differ, and "Watch the first stop" sits between steps 15 and 16', () => {
  const numbered = P_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...pRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Back out', 'If something goes wrong']);
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
  assert.ok(buyer.startsWith("| Buyer key (the service's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral for the Accept and the Reclaim of the sub-jobs, never touched), then 100 units |"));
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
  assert.ok(three.includes('`c4c378a`') && three.includes('the full 40-character hash, because BuildKit does not resolve the short form'));
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
  assert.ok(PSPEC.includes('\nThis agent has had a registry record since 2026-10-16.\n') && PSPEC.includes('\n| DID | `did:vector:agent:') && PSPEC.includes('\n| Registry record | name `Document Pipeline`;'), 'the spec rows the pull request changed carry the record');
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
    'the role address of step 4 in `operator.contact`', 'the new DID in `identity.did`', 'the key hash in `identity.controller_pkh` and `keys.supplier_pkh`', 'the public key in `keys.pub_key_hex`',
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
  for (const path of ['operator.contact', 'identity.did', 'identity.controller_pkh', 'keys.supplier_pkh', 'keys.pub_key_hex', 'keys.buyer_pkh', 'status.chip', 'status.since', 'links.explorer_advert']) assert.ok(path.split('.').reduce((o, k) => o?.[k], m) !== undefined, `the manifest has ${path}`);
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
  assert.ok(back.includes('The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them.'));
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
  assert.equal(ci.jobs.test['runs-on'], 'ubuntu-24.04');
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
  assert.equal(builds.length, 4, 'one image for each agent that is built');
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
const S_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO'];
const S_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const S_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
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
    CAPABILITY_KIND: 'custom', SERVICE_URL: 'http://audio-snippets-service:9093/', SERVICE_CONTENT_TYPE: 'application/json', SERVICE_TIMEOUT_MS: '1380000', ADVERT_MAX_PROCESSING_MS: '1500000', PORT: '8080',
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

test('Snippets env example: the blocks in order (supplier, token, chain, advert, manifest), known names only, each once; every secret empty, nothing key-shaped; the header says one key and a token, and where the network is named', () => {
  assert.deepEqual(Object.keys(sExample), [...S_SUPPLIER, ...S_TOKEN, ...S_CHAIN, ...S_ADVERT, ...S_MANIFEST]);
  assert.deepEqual(keyProblems(sExample), []);
  assert.deepEqual(keyProblems(sAgent.environment), []);
  assert.deepEqual(keyProblems(sService.environment), []);
  for (const name of [...S_SUPPLIER, ...S_TOKEN, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(sExample[name], '', `${name} is filled by the runbook`);
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
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT'];
  assert.deepEqual(NEEDED.filter((n) => !(n in sExample) && !(n in sAgent.environment)), []);
});

test('Snippets env example: the chain values are those of the Pipeline, the advert terms are the spec, the endpoint is the third hostname, the status word is deployed since 2026-10-17, and the manifest it produces is the default one', () => {
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
  assert.deepEqual(withExample, withNothing, 'the example changes nothing in the manifest the advert will hash');
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

test('Snippets RUNBOOK: the twenty-one sections in order, the seventeen steps keep the numbers of the other runbooks, and the head lists what differs with the names table and the two base paths', () => {
  const numbered = S_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...sRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Back out', 'If something goes wrong']);
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
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
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
  assert.equal(blocks.length, 31, 'a block added or taken away is seen here');
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

// Ruling R-D26: a stage of a Dockerfile that no longer builds fails on the push or the pull request that broke it, before main, with no registry login.
test('CI: the build job builds the four images of the publish job on every push and pull request, and pushes none and logs in nowhere', () => {
  assert.deepEqual(ci.on, ['push', 'pull_request']);
  assert.deepEqual(ci.permissions, { contents: 'read' });
  const job = ci.jobs.build;
  assert.ok(job, 'a build job');
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  assert.equal(job.if, undefined, 'on every event of the workflow');
  assert.equal(job.needs, undefined, 'beside the tests, not after them');
  assert.equal(job.permissions, undefined, 'the read-only permissions of the workflow');
  assert.equal(job.steps[0].uses, 'actions/checkout@v4');
  assert.equal(job.steps.some((s) => typeof s.uses === 'string' && s.uses.startsWith('docker/login-action')), false, 'no registry login');
  const builds = job.steps.filter((s) => s.uses === 'docker/build-push-action@v6');
  assert.equal(builds.length, 4);
  const published = ci.jobs.publish.steps.filter((s) => s.uses === 'docker/build-push-action@v6').map((s) => s.with.file);
  assert.deepEqual(builds.map((s) => s.with.file), published, 'the Dockerfiles of the publish job, in its order');
  for (const step of builds) {
    assert.deepEqual(step.with, { context: '.', file: step.with.file, push: false }, step.with.file);
    assert.equal(step.if, undefined, step.with.file);
    assert.ok(existsSync(join(root, step.with.file)), step.with.file);
  }
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
  assert.ok(SSPEC.includes('manifest hash `84a9b9dfc8109be1144e9e70cedc5bbf2be3942ca7f6d7fd0570729037de843c` (the manifest before the status flip)') && SSPEC.includes('manifest hash `059b0f6f9826eec89cfd4f7e3177152403983b926d2892bf2a472145daef879b`. The marketplace indexer lists it'), 'the two hashes are those of the two adverts in the spec');
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
// Advocate (PROPOSED, built and not deployed, since 2026-10-13): the fourth stack on the same host.
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
const A_CHAIN = ['NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO'];
const A_ADVERT = ['ADVERT_REF', 'ADVERT_CAPABILITY_ID', 'ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_SUPPLIER_BOND_LOVELACE', 'ADVERT_BUYER_BOND_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'];
const A_MANIFEST = ['OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL'];
const A_HIRES = ['LLM_MODEL_ALLOWLIST'];
const A_STEPS = ['Put the files on the host', 'Build the service image and pin it', 'Build the runtime image', 'Make the env file, generate the two keys and enter the two API keys', 'Adapt the ops scripts', 'Supply the two wallets with their collateral and float', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
const A_STATUS = 'PROPOSED (built, not deployed) since 2026-10-13';
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
    CAPABILITY_KIND: 'custom', SERVICE_URL: 'http://advocate-service:9094/', SERVICE_CONTENT_TYPE: 'application/json', SERVICE_TIMEOUT_MS: '360000', ADVERT_MAX_PROCESSING_MS: '480000', PORT: '8080',
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

test('Advocate env example: the blocks in order (supplier, buyer, token, API keys, chain, advert, manifest, hires), known names only, each once; every secret empty, nothing key-shaped; the header says two keys, a token and two API keys, and where the network is named', () => {
  assert.deepEqual(Object.keys(aExample), [...A_SUPPLIER, ...A_BUYER, ...A_TOKEN, ...A_API_KEYS, ...A_CHAIN, ...A_ADVERT, ...A_MANIFEST, ...A_HIRES]);
  assert.deepEqual(keyProblems(aExample), []);
  assert.deepEqual(keyProblems(aAgent.environment), []);
  assert.deepEqual(keyProblems(aService.environment), []);
  for (const name of [...A_SUPPLIER, ...A_BUYER, ...A_TOKEN, ...A_API_KEYS, 'ADVERT_REF', 'ADVERT_DETAIL_HASH', 'AGENT_DID', 'ADVERT_EXPLORER_URL']) assert.equal(aExample[name], '', `${name} is filled by the runbook`);
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
  assert.ok(aExampleText.includes('# Left unset on purpose: AGENT_VERSION (the service has its own default), VECTOR_MARKETPLACE_INDEXER_URL, VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL and VECTOR_SUBMIT_URL (the defaults of the code are Vector mainnet\'s),\n# and OPENROUTER_MODEL, which is optional: the model the service asks, as <provider>/<name>, deepseek/deepseek-v4-flash while it is not set. The manifest names the model in a gap and every result names it,\n# so a value set here changes the manifest the advert hashes.\n'));
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
  // indexer are Vector mainnet's in packages/buyer-core; the ceiling of the chat job is 1000000 lovelace in the code, and the example carries it commented.
  const DEFAULT_IN_CODE = ['AGENT_VERSION', 'KOIOS_URL', 'INDEXER_URL', 'OPENROUTER_MODEL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_KOIOS_URL', 'VECTOR_EXPLORER_URL', 'LLM_MAX_PRICE_LOVELACE'];
  assert.deepEqual([...names].filter((n) => !(n in aExample) && !(n in aService.environment) && !DEFAULT_IN_CODE.includes(n)), []);
  for (const n of DEFAULT_IN_CODE) assert.ok(!(n in aExample), `${n} stays unset in the example`);
  assert.match(aExampleText, /^# LLM_MAX_PRICE_LOVELACE=1000000$/m, 'the ceiling is in the example, commented, at the default of the code');
  for (const n of ['OPERATOR_CONTACT', 'ADVOCATE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SERVICE_AUTH_HEADER', ...A_API_KEYS, 'OPENROUTER_MODEL', 'ADVOCATE_STATE_DIR', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE']) assert.ok(names.has(n), `the service reads ${n}`);
  assert.ok(!names.has('SUPPLIER_PRIV_KEY_HEX'), "no source of the service reads the supplier key: it is the runtime's");
  const NEEDED = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ADVERT_REF', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'SERVICE_CONTENT_TYPE', 'SERVICE_AUTH_HEADER', 'PORT'];
  assert.deepEqual(NEEDED.filter((n) => !(n in aExample) && !(n in aAgent.environment)), []);
});

test('Advocate env example: the chain values are those of the other three, the advert terms are the spec, the endpoint is the fourth hostname, the status word is proposed since 2026-10-13, and the manifest it produces is the default one', () => {
  for (const name of A_CHAIN) assert.equal(aExample[name], sExample[name], name);
  assert.deepEqual([aExample.ADVERT_CAPABILITY_ID, aExample.ADVERT_MODEL], ['research.advocate.onesided.v1', 'advocate-v1']);
  assert.ok(ASPEC.includes(`The model string in the advert and in every receipt is \`${aExample.ADVERT_MODEL}\`.`));
  assert.deepEqual([aExample.ADVERT_PRICE_LOVELACE, aExample.ADVERT_SUPPLIER_BOND_LOVELACE, aExample.ADVERT_BUYER_BOND_LOVELACE, aExample.ADVERT_MAX_PROCESSING_MS].map(Number), [A_TERMS.price, A_TERMS.supplierBond, A_TERMS.buyerBond, A_TERMS.window]);
  assert.deepEqual([A_TERMS.price, A_TERMS.supplierBond, A_TERMS.buyerBond], [3_000_000, 1_000_000, 1_000_000]);
  assert.equal(aExample.ADVERT_ENDPOINT_URL, 'https://mp-suppliers-advocate.hal8.ai');
  assert.equal(aExample.ADVERT_DETAIL_URI, `${aExample.ADVERT_ENDPOINT_URL}/agent.json`);
  assert.ok(DESIGN.includes('`mp-suppliers-advocate.hal8.ai`'));
  assert.deepEqual([aExample.AGENT_STATUS_CHIP, aExample.AGENT_STATUS_SINCE], ['proposed', '2026-10-13']);
  assert.match(aExampleText, /^# The status word the manifest carries, and since when: proposed since 2026-10-13, the day the agent was specified\. Step 17 of RUNBOOK-advocate\.md \("Flip the status"\) changes both,$/m);
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
  assert.ok(read('agents/advocate/src/inference.ts').includes("if (error instanceof HopFailed || error instanceof OutOfTime) return fallBack('llm_supplier_unavailable', 'choice');"));
  const [withExample, withNothing] = inAdvocate(
    "import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((env) => manifestFromEnv(env))));",
    [{ ...withoutPlaceholders(aExample), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }],
  );
  assert.deepEqual(withExample, withNothing, 'the example changes nothing in the manifest the advert will hash');
  assert.deepEqual(withExample.status, { chip: 'proposed', since: '2026-10-13' });
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

test('Advocate files: each says PROPOSED (built, not deployed) since 2026-10-13 in its own first lines and what ran on the host, with the image of ccbcb94; none says LIVE or DEPLOYED, names the host or another stack, or holds a dash, the unit name, a person, a home path or a word the content rules ban', () => {
  assert.equal(aComposeText.split('\n')[1], `# ${A_STATUS}. Steps 1 to 10 of RUNBOOK-advocate.md ran on 2026-10-18 and 2026-10-19 with the service image of ccbcb94; the image is rebuilt from this change before step 11. The host administrator's part is README.md.`);
  assert.ok(aSnippet.split('\n')[1].startsWith(`# ${A_STATUS}. Installed: steps 1 to 10 of RUNBOOK-advocate.md, step 10 among them, ran on 2026-10-18 and 2026-10-19.`));
  assert.equal(aExampleText.split('\n')[2], `# Status: ${A_STATUS}. The status word the manifest carries is AGENT_STATUS_CHIP below.`);
  assert.equal(aRunbook.split('\n')[2], `Status: ${A_STATUS}. Nothing in this folder is LIVE. This runbook says what will happen, in order. Steps 1 to 10 were run on 2026-10-18 and 2026-10-19 with the service image of \`ccbcb94\` (the OpenRouter-only build), and the identity was registered and staked on 2026-10-19 (steps 7 and 8); no advert is posted. Before step 11 the service image is rebuilt from this change. Step 1 runs again with a bundle of the new \`main\` in \`/tmp\`, but the checkout is there and is not cloned again: in this folder (\`$BASE/repo/deploy/host\`) \`git checkout docker-compose.advocate.yml\` sets aside the pin of step 2, the one local change, on which a pull would stop; then \`git pull --ff-only /tmp/vector-service-agents.bundle main\`, and \`git log -1 --oneline\` must show the reviewed commit. \`.env\` and \`.env.advocate\` are not in git and stay as they are: never remove the checkout to clone it again. Then step 2 for the new image and its pin, step 4 for the buyer key (it has a block for the env file of that run), step 6 for the buyer wallet alone (the supplier address lists what steps 7 and 8 left of its 55, and only the buyer address is held to its two outputs), and step 9 to recreate the service.`);
  assert.doesNotMatch(aRunbook, /steps 1 and 2 again for its files and its image/, 'the words of before: step 1 cannot clone again on the checkout of the host');
  assert.ok(aSection.split('\n')[1].startsWith(`Status: ${A_STATUS}. Nothing in this section is LIVE. Steps 1 to 10 of its runbook were run on 2026-10-18 and 2026-10-19 with the service image of \`ccbcb94\`, and the identity was registered and staked on 2026-10-19; no advert is posted, and the image is rebuilt from this change before step 11. The files are `));
  for (const rel of [...A_FILES, 'agents/advocate/Dockerfile']) {
    const text = read(rel);
    assert.doesNotMatch(text.replace('Nothing in this folder is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/, `${rel}: no status claim beyond the status line`);
    assert.doesNotMatch(text, HOST_WORDS, `${rel}: names no host and no other stack`);
    assert.doesNotMatch(text, DASHES, `${rel}: no em or en dash`);
    assert.doesNotMatch(text, UNIT_NAME, `${rel}: the unit is called units`);
    assert.doesNotMatch(text, NAMES, `${rel}: roles, not people`);
    assert.doesNotMatch(text, HOME_PATH, `${rel}: no path into a home folder`);
    assert.doesNotMatch(withoutFileNames(text), A_BANNED, `${rel}: no word the content rules ban`);
    assert.match(text, /^[\x09\x0a\x20-\x7e]*$/, `${rel}: ASCII`);
  }
  assert.doesNotMatch(aSection, HOST_WORDS);
  assert.doesNotMatch(aSection.replace('Nothing in this section is LIVE.', ''), /\b(LIVE|DEPLOYED)\b/);
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
    '- **The state volume.** `advocate-state`, mounted at `/data`, holds `stranded.json`', '`docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it. Neither is run while the file lists an escrow.',
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
  assert.ok(readme.includes('Advocate is a fourth, built and not deployed, with its own section at the end of this note, after that of Audio Snippets, and its own runbook, [RUNBOOK-advocate.md](RUNBOOK-advocate.md).'));
  assert.ok(readme.includes('Advocate has its own name, `mp-suppliers-advocate.hal8.ai`, and its own section at the end of this note.'), 'point 1 of the list of the host administrator, in the form of the other two names: the name resolves since step 10');
  assert.equal(readme.match(/for Advocate, which is not built yet/), null, 'the words of before the build of Advocate');
  assert.equal(readme.match(/One more comes later/), null, 'the words of before step 10');
});

test('Advocate RUNBOOK: the twenty-one sections in order, the seventeen steps keep the numbers of the other runbooks, and the head lists what differs with the names table and the two base paths', () => {
  const numbered = A_STEPS.map((title, i) => `${i + 1}. ${title}`);
  assert.deepEqual([...aRunbook.matchAll(/^## (.+)$/gm)].map((m) => m[1]), ['Collateral and float', ...numbered.slice(0, 15), 'Watch the first stop', ...numbered.slice(15), 'Back out', 'If something goes wrong']);
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
    'the search gets at most 15 s of it and the pages at most 45 s; the hire of the chat supplier ends 95 s before the deadline, so that the call through OpenRouter still has its 90 s when the hire fails.',
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

// The first paragraph sends the operator back to step 1 on the checkout of the host, which is there. Its git commands run here as the paragraph gives them, read from
// its backticks, on scratch repositories in a folder of the OS temp directory and never in this repository: no GIT_ variable of the process reaches them, no
// configuration of the machine is read, and git looks for no repository above that folder. A bundle of a first commit is cloned as step 1 clones it, the pin of
// step 2 is made in the clone and the two env files are written next to it; a second commit that rewrites the compose file comes as a new bundle in the same place.
const HAVE_GIT = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
test('Advocate RUNBOOK first paragraph in git: step 1 cannot clone again and a pull stops on the pin of step 2; the checkout of the compose file and the pull of the paragraph bring the new commit with its placeholder, and .env and .env.advocate stay as they are', { skip: HAVE_GIT ? false : 'needs git' }, () => {
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
    writeFileSync(join(scratch, 'gitconfig'), '');
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
    rmSync(scratch, { recursive: true, force: true });
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
    'On the host\'s file it prints `ADVERT_MAX_PROCESSING_MS=480000`, the four buyer lines with a length of 0 and `LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash`, in the order of the file.',
    'because other stacks share the network and a job posts an escrow from the buyer wallet',
    'It must print `two different keys`. The service also refuses to start with the supplier key in the buyer lines (the table at the end).',
    'The example carries the status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`: `proposed` since 2026-10-13. They stay so until step 17, which is the only place that changes them.',
  ]) assert.ok(four.includes(part), `step 4 says: ${part}`);
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
    'Each address must list two outputs: one of exactly 5 units, and one of 50 at the supplier address or of 30 at the buyer address. On the run before step 11 (the first paragraph), the supplier address lists what steps 7 and 8 left of its 55, and only the buyer address is held to its two outputs.',
  ]) assert.ok(six.includes(part), `step 6 says: ${part}`);
  // The two second transfers are the floats of the rows of Collateral and float.
  const collateral = section(aRunbook, 'Collateral and float');
  assert.ok(collateral.includes('exactly 5 units alone (collateral), then 50 units') && collateral.includes('held back from every Post while the rest of the wallet covers that Post and its change), then 30 units'));
  const seven = section(aRunbook, '7. Register the identity');
  for (const part of ["sed -i '/^AGENT_DID=$/d' \"$BASE/repo/deploy/host/.env.advocate\"", 'python3 make-skey.py', './register-did.sh', 'The record has the name `Advocate`, the capability `research.advocate.onesided.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-advocate.hal8.ai`', 'into the Identity section of `specs/advocate.md`', '(the DID row, the "Registry record, planned" row and the sentence that says the agent has no registry record yet)', 'remove it in Back out (point 4)', 'Operator. The same as step 7 of RUNBOOK.md, for the supplier key only.', 'The buyer key is not touched by any step here and has no second copy on the host.']) assert.ok(seven.includes(part), part);
  // Step 7 was run on 2026-10-19 and this change records it, as the step asks: the sentence says that the record exists, and the rows are no longer planned. The runbook still
  // quotes the old words, as the instruction it was.
  assert.ok(ASPEC.includes('\nThis agent has had a registry record since 2026-10-19.\n') && ASPEC.includes('\n| DID | `did:vector:agent:') && ASPEC.includes('\n| Registry record | name `Advocate`;'), 'the spec rows step 7 names carry the record');
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
  ]) assert.ok(nine.includes(part), `step 9 says: ${part}`);
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
  assert.ok(section(ASPEC, 'Links').includes('- Advert on the explorer: none. The advert is not posted.'), 'the line step 12 replaces');
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
  assert.equal(blocks.length, 36, 'a block added or taken away is seen here');
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
    '- `E2E_POLL_MS=10000`. A job takes up to 300 s, its deadline, where Agent History\'s takes seconds.',
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
  // The word is carried as a default by the code, as the item says: proposed since 2026-10-13, in the manifest the template holds.
  assert.deepEqual(JSON.parse(read('agents/advocate/agent.json.template')).status, { chip: 'proposed', since: '2026-10-13' });
  // Every test of the agent that pins the default word is named, so that the flip is not found out by a test that fails: server.test.ts and start.test.ts hold it (the status of
  // /agent.json of a service started with no AGENT_STATUS_CHIP), and a test written later that holds it is found here and has to be named too.
  const pinning = sourceFiles('agents/advocate/test').filter((f) => read(f).includes("chip: 'proposed'"));
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
    '`docker exec advocate-service cat /data/stranded.json` prints `[]`, or lists only Submitted escrows, which nothing can reclaim (`janitor: kept <escrow>: Submitted: ...`, the table at the end).',
    'An escrow whose `deliver_by` has not come yet is waited for: the janitor reclaims it 5 s after its `deliver_by`, logging `janitor: reclaimed <escrow>: ...`.',
    'The buyer wallet is emptied last, with the buyer key, once `stranded.json` is `[]` or lists only Submitted escrows (or was never written;',
    'Never add `-v`: the volume `advocate-state` holds `stranded.json`, the escrows that still lock the buyer\'s units, and the janitor of the next start reads it. `down` keeps it.',
    'The env file still holds both keys, and so does the operator\'s offline store: keep both until both wallets are empty',
    'No script of this pack does that: none signs with the buyer key', 'docker run --rm -v advocate-state:/data alpine cat /data/stranded.json',
  ]) assert.ok(back.includes(part), `Back out says: ${part}`);
  assert.equal(back.includes('There is no volume to keep'), false, 'the words of before the state');
  assert.doesNotMatch(back, /once the service holds nothing|lists only escrows whose `deliver_by` has not come yet/, 'the words of before: a stop with escrows not yet due, and a wait for [] that a Submitted escrow never ends');
  // The two lines Back out quotes are the janitor's (packages/hire-kit/src/janitor.ts), where a Submitted escrow is kept and never reclaimed; the table at the end has its row.
  const janitor = read('packages/hire-kit/src/janitor.ts');
  assert.ok(janitor.includes("return did('kept', `Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest`);"));
  assert.ok(janitor.includes('log(`janitor: ${action.action} ${action.escrow_ref}: ${action.note}`)'));
  assert.ok(section(aRunbook, 'If something goes wrong').includes('| `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` |'));
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
    ['accept it by hand within 600 s of its Submit', 'inference', 'accept it by hand within 600 s of its Submit'],
    ['`janitor: reclaimed <escrow>: ...`', 'janitor', 'janitor: ${action.action} ${action.escrow_ref}: ${action.note}'],
    ['`janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest`', 'janitor', 'Submitted: it cannot be reclaimed, and its supplier may release it from ${iso(lostAfter)} at the latest'],
    ['`janitor: the pass failed`', 'janitor', 'janitor: the pass failed'],
  ]) {
    assert.ok(table.includes(row), `the table quotes ${row}`);
    assert.ok(sources[where].includes(quote), `${where} prints ${quote}`);
  }
  // A line of the service about a hire carries its code and its stage, never the reason the kit gave (ruling R-F8): the choice that fails keeps no words of the
  // kit, so the table quotes none of them.
  assert.ok(sources.inference.includes("() => new HopFailed('llm_supplier_unavailable', null)"), 'the choice keeps no reason of the kit');
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
  // deadline: the time OpenRouter is given is the time left less 5 s, 90 s at most, and it is not called with under 15 s. The hire ends FALLBACK_RESERVE_MS before the
  // deadline, which leaves the whole 90 s and not a millisecond more; a receipt read until receiptByMs leaves 15 s; with under 20 s left it is not called.
  assert.deepEqual(L.model, { full: L.MODEL_MAX_MS, lessAfter: L.MODEL_MAX_MS - 1, atReceiptBy: L.MODEL_MIN_MS, none: null, started: L.MODEL_MIN_MS });
  assert.deepEqual([L.hopEnd, L.FALLBACK_RESERVE_MS, L.receiptEnd], [L.MODEL_MAX_MS + L.RESULT_RESERVE_MS, L.MODEL_MAX_MS + L.RESULT_RESERVE_MS, L.MODEL_MIN_MS + L.RESULT_RESERVE_MS]);
  const deadline = rowOf('deadline');
  assert.ok(deadline.includes(`The job ran out of its time: ${L.JOB_DEADLINE_MS} ms after its request arrived.`));
  assert.ok(deadline.includes(`OpenRouter is given the time left less ${sec(L.RESULT_RESERVE_MS)} s, ${sec(L.MODEL_MAX_MS)} s at most, and when it was given the whole ${sec(L.MODEL_MAX_MS)} s the same silence is \`model_failed\`.`));
  assert.ok(deadline.includes(`The hire of a chat supplier ends ${sec(L.hopEnd)} s before the deadline, so a fallback after it has its ${sec(L.MODEL_MAX_MS)} s, but a receipt that failed its check late, up to ${sec(L.receiptEnd)} s before the deadline, leaves the fallback ${sec(L.MODEL_MIN_MS)} s at the least.`));
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
