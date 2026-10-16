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

test('README, RUNBOOK, compose file and Caddy snippet: Agent History is DEPLOYED since 2026-10-15 and the Document Pipeline since 2026-10-16, nothing is LIVE; no dash, no unit name, no person named', () => {
  const STATUS = 'Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE.';
  // The Pipeline is the second stack of the box: its section of the README and its runbook carry its own status line, DEPLOYED since 2026-10-16 (RUNBOOK-document-pipeline.md step 17).
  const P_README_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this section is LIVE.';
  const P_RUNBOOK_STATUS = 'Status: DEPLOYED since 2026-10-16. Nothing in this folder is LIVE.';
  const STATUS_LINES = { 'deploy/host/README.md': [STATUS, P_README_STATUS], 'deploy/host/RUNBOOK.md': [STATUS], 'deploy/host/RUNBOOK-document-pipeline.md': [P_RUNBOOK_STATUS] };
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
  assert.equal(readme.split('\n')[2], `${STATUS} Steps 1 to 15 and 17 of the runbook were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).`);
  for (const [rel, header] of Object.entries(HEADER)) assert.ok(read(rel).split('\n')[rel.endsWith('.example') ? 2 : 1].startsWith(header), `${rel}: the line says what happened on the box`);
  assert.doesNotMatch(read('deploy/host/docker-compose.agent-history.yml') + snippet + read('deploy/host/docker-compose.document-pipeline.yml') + read('deploy/host/Caddyfile.document-pipeline.snippet'), /PROPOSED/);
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

// ---- The status words after the flips of 2026-10-15 and 2026-10-16 ----
// Agent History and Document Pipeline are DEPLOYED. The two agents that are not built are PROPOSED. Nothing here is LIVE.
// A line that says PROPOSED has to be one of the lines below, so the word cannot come back for Agent History or Document Pipeline; a line that says LIVE has to deny it.
test('status words: no file says PROPOSED about Agent History or Document Pipeline, and no file says LIVE except to deny it', () => {
  const OTHER_AGENTS = ['specs/audio-snippets.md', 'specs/advocate.md'];
  // What may still say PROPOSED outside the specs of the agents that are not built: their rows in the table of the root README, the rule that lists the three words,
  // the marketplace tools in the Interface section of the spec (the tools, not the agent), and the instructions of the two runbooks that speak for the order of a first run.
  const PROPOSED_OK = {
    'README.md': [/^\| (Audio Snippets|Advocate) \| `[a-z.0-9-]+` \| PROPOSED \|$/],
    'agents/agent-history/README.md': [/`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./],
    'specs/agent-history.md': [/^The marketplace MCP tools \(PROPOSED\) and the template's buyer, /],
    'deploy/host/RUNBOOK.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about Agent History/],
    'deploy/host/RUNBOOK-document-pipeline.md': [/The status word stays PROPOSED until step 17\./, /change every file that says PROPOSED about the Document Pipeline/],
  };
  // What may say LIVE: the sentence that denies it, and the rule that lists the three words.
  const LIVE_OK = [/Nothing (on this page|in this guide|in this folder|in this section) is LIVE( or DEPLOYED)?\./, /`AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case\./];
  const files = repoFiles().filter((f) => /(\.md|\.yml|Caddyfile\.snippet|Caddyfile\.[a-z-]+\.snippet|\.example|\.template)$/.test(f));
  for (const f of ['specs/agent-history.md', 'specs/advocate.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', 'deploy/host/RUNBOOK.md', 'deploy/host/README.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/Caddyfile.snippet', 'deploy/host/.env.agent-history.example', 'agents/agent-history/agent.json.template', ...PIPELINE_FILES]) assert.ok(files.includes(f), `${f} is walked`);
  for (const f of files) {
    const lines = read(f).split('\n');
    if (!OTHER_AGENTS.includes(f)) for (const line of lines.filter((l) => /\bPROPOSED\b/.test(l))) assert.ok((PROPOSED_OK[f] ?? []).some((re) => re.test(line)), `${f} says PROPOSED: ${line.slice(0, 110)}`);
    for (const line of lines.filter((l) => /\bLIVE\b/.test(l))) assert.ok(LIVE_OK.some((re) => re.test(line)), `${f} says LIVE: ${line.slice(0, 110)}`);
  }
  // The values the manifest and the env example carry are neither proposed nor live.
  assert.match(exampleText, /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/agent-history/agent.json.template')).status, { chip: 'deployed', since: '2026-10-15' });
  assert.match(read('deploy/host/.env.document-pipeline.example'), /^AGENT_STATUS_CHIP=deployed$/m);
  assert.deepEqual(JSON.parse(read('agents/document-pipeline/agent.json.template')).status, { chip: 'deployed', since: '2026-10-16' });
  // Audio Snippets and Advocate are not built and are PROPOSED, each in its own spec. Document Pipeline is DEPLOYED since 2026-10-16, in the line of its spec.
  for (const f of ['specs/audio-snippets.md', 'specs/advocate.md']) assert.match(read(f), /^PROPOSED \(not built\)\. Since 2026-10-13\.$/m, f);
  assert.match(read('specs/document-pipeline.md'), /^DEPLOYED \(registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16\)\. Since 2026-10-16\.$/m);
  // The specs that open a line with PROPOSED are the two this test lets say it anywhere: read from the specs folder, so that a third spec, or a spec that drops the word, is seen.
  const proposed = readdirSync(join(root, 'specs')).filter((f) => /^PROPOSED \(/m.test(read(`specs/${f}`))).map((f) => `specs/${f}`).sort();
  assert.deepEqual(proposed, [...OTHER_AGENTS].sort(), 'the specs that say PROPOSED are the two that may say it anywhere');
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
  assert.ok(twelve.includes('https://explorer.vector.mainnet.apexfusion.org/transaction/hash/') && twelve.includes('The status word stays PROPOSED until step 17.'));
  assert.ok(twelve.indexOf('Record the advert in the repository.') > twelve.indexOf('ADVERT_REF=$(docker compose'), 'after the advert is posted');
  assert.match(section(runbook, '17. Flip the status'), /refreshed after steps 7 and 12/);
  const nine = section(runbook, '9. Start the service');
  assert.ok(nine.includes("KEY=$(sed -n 's/^SUPPLIER_PKH=//p' .env.agent-history)"), 'the key hash comes from the env file');
  assert.ok(nine.includes('`subject.kind` is `pkh`, `subject.candidates` lists the record of step 7, and `marketplace` is an object.'));
  assert.ok(nine.includes('docs/HIRE.md') && nine.includes('section 7 invites members to use'), 'why the key-hash query is asked');
  assert.ok(nine.indexOf('"$KEY"') > nine.indexOf('"$DID"'), 'after the query by DID');
  assert.ok(runbook.indexOf('"$KEY"') < runbook.indexOf('## 12.'), 'before the advert is posted');
});

test('RUNBOOK: the key is never sent anywhere, the registry login block is bash, the hash script runs from the repository root, the marketplace tools are on the hosted mainnet server, the wallet monitor is named', () => {
  assert.match(section(runbook, '4. Make the env file and generate the supplier key'), /is never sent anywhere\./);
  assert.doesNotMatch(runbook, /never leaves/);
  assert.match(section(runbook, '2. Log in to the registry and get the service image'), /```bash\nread -rs GHCR_TOKEN/);
  assert.match(section(runbook, '11. Hash the manifest'), /```sh\ncd "\$BASE\/repo"\nnode scripts\/manifest-hash\.mjs /);
  const s15 = section(runbook, '15. The first-party run');
  assert.ok(s15.includes('As of 2026-10-14 the nine marketplace tools the script needs are merged into `main` of Apex-Fusion/mcp-server (PR 1 as [#20](https://github.com/Apex-Fusion/mcp-server/pull/20), PR 2 as [#21](https://github.com/Apex-Fusion/mcp-server/pull/21) and PR 3 as [#23](https://github.com/Apex-Fusion/mcp-server/pull/23) with PR 2) and are on the hosted mainnet MCP server, which lists 33 tools.'));
  assert.ok(s15.includes('PR 4 ([#22](https://github.com/Apex-Fusion/mcp-server/pull/22)), the signer package with its `keygen` command, is merged too, and the package is not published.'));
  assert.doesNotMatch(s15, /and PR 4 as/, 'PR 4 is the signer, not one of the nine marketplace tools');
  assert.ok(s15.includes('The default `BUILDER_URL` of the script is the hosted mainnet MCP server, so the run needs no local builder. E2E.md keeps the local build of `main` as the fallback for a builder that lacks the tools.'));
  assert.ok(s15.includes('Add the run to the Results table in E2E.md. Only a run that ends in the printed evidence counts. The first run, made on 2026-10-15, is recorded in E2E.md.'));
  assert.doesNotMatch(s15, /PR 2 is open|PR 3 and PR 4 follow|PRs 2 and 3 follow|are deployed|PR 3 branch/);
  assert.doesNotMatch(s15, /cutover|cuts it over|24 tools|none of them a marketplace tool|awaiting the|still serves/i, 'nothing waits for a cutover any more');
  const s16 = section(runbook, '16. Wallet monitor');
  assert.ok(s16.includes('`Apex-Fusion/agents-marketplace`') && s16.includes('`wallet-monitor/wallets.json`'));
  assert.doesNotMatch(s16, /upstream repository/);
});

test('agent README: the Image section says the publish job pushes on merge to main, that it has not run yet, and that the agent is running on the box with the status DEPLOYED since 2026-10-15', () => {
  const image = section(read('agents/agent-history/README.md'), 'Image');
  assert.ok(image.length > 300, 'the section exists');
  assert.ok(image.includes('docker build -f agents/agent-history/Dockerfile'));
  assert.ok(image.includes('pushes the image on merge to `main`'));
  assert.ok(image.includes('It has not run yet: Actions is blocked on this private repository.'));
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
const WAIT_S = Number(/export const SHUTDOWN_WAIT_MS = ([\d_]+);/.exec(START)?.[1].replaceAll('_', '')) / 1000;
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
  const files = [...sourceFiles('agents/document-pipeline/src'), ...sourceFiles('packages/buyer-core/src'), ...sourceFiles('packages/vector-read/src')];
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
  assert.ok(readme.includes('The Document Pipeline is a second stack on the same box. It has its own section at the end of this note and its own runbook, [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md).'));
  assert.ok(readme.indexOf('The Document Pipeline is a second stack on the same box.') < readme.indexOf('\n## What will land on the box\n'), 'said at the top, before the Agent History tables');
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
  const server = read('agents/document-pipeline/src/server.ts');
  assert.ok(server.includes('export const HEARTBEAT_MS = 60_000;'));
  assert.ok(read('agents/document-pipeline/src/budget.ts').includes('export const JOB_DEADLINE_MS = 1_620_000;'), '27 min');
  assert.ok(PREADME.includes('the runtime\'s fetch gives up after 300 s of silence'));
});

test('Pipeline RUNBOOK collateral and float: two keys, 5 alone then 50 for the supplier and 5 alone then 100 for the buyer, what the buyer float covers, and the third key of step 15', () => {
  const funds = section(pRunbook, 'Collateral and float');
  const rows = funds.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Key |'));
  assert.equal(rows.length, 2, 'two keys');
  const [supplier, buyer] = rows;
  assert.ok(supplier.startsWith("| Supplier key (the runtime's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral, never touched), then 50 units | As for Agent History:"));
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
    'The box has no GitHub credentials, and the repository is private, so the repository goes over as a git bundle.',
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
    "python3 -m venv venv", "./venv/bin/pip -q install 'cbor2==5.6.5'", './setup-venv.sh', "./venv/bin/pip show cbor2 | grep '^Version'", '`setup-venv.sh` ends with `venv ok`', '`Version: 5.6.5`', 'breaks `cbor2pure`',
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
    "It must print nothing. A line it prints is a path, a name or a message of the other stack: change it by hand to this agent's before the script runs, because it would act on the wrong stack.",
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
  assert.match(eleven, /```sh\ncd "\$BASE\/repo"\nnode scripts\/manifest-hash\.mjs https:\/\/mp-suppliers-pipeline\.hal8\.ai\n```/);
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
  assert.ok(read('agents/document-pipeline/src/janitor.ts').includes("export const STRANDED_FILE = 'stranded.json';"));
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
  assert.ok(START.includes('did not finish within ${waitMs} ms and is abandoned; the state directory holds ${refs.length}'), 'the line of an abandoned job is the code\'s');
  assert.ok(stop.indexOf('stop service') < stop.indexOf('docker logs --tail 5') && stop.indexOf('docker logs --tail 5') < stop.indexOf('{{.State.ExitCode}}') && stop.indexOf('{{.State.ExitCode}}') < stop.indexOf('up -d service'), 'stop, read the log, read the exit code, start again');
  // The lines are the code's.
  assert.ok(START.includes('log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);'));
  assert.ok(START.includes('log(`stopping: waiting up to ${waitMs} ms for the job that is running`);'));
  assert.ok(START.includes("const SIGNALS") || START.includes("for (const signal of ['SIGTERM', 'SIGINT'])"));
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
  // The word is carried as a default by the code, as the item says: deployed since the flip of 2026-10-16.
  assert.ok(read('agents/document-pipeline/src/server.ts').includes("return 'deployed';") && read('agents/document-pipeline/src/server.ts').includes("return '2026-10-16';"));
  assert.equal(read('agents/document-pipeline/src/server.ts').includes("return 'proposed';"), false);
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
  assert.ok(read('agents/document-pipeline/src/janitor.ts').includes("if (codeOf(err) === 'ENOENT') return;"), 'a store with no file starts empty and writes the file with its first entry');
  assert.ok(pRunbook.indexOf('\n## Back out\n') > pRunbook.indexOf('\n## 17.') && pRunbook.indexOf('\n## Back out\n') < pRunbook.indexOf('\n## If something goes wrong\n'), 'after step 17, before the failure table');
  // The janitor reclaims 5 s after deliver_by, as the code says.
  assert.ok(read('agents/document-pipeline/src/janitor.ts').includes('export const JANITOR_GRACE_MS = 5_000;'));
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
    janitor: read('agents/document-pipeline/src/janitor.ts'), render: read('agents/document-pipeline/src/render.ts'), result: read('agents/document-pipeline/src/result.ts'),
  };
  // Each message the table quotes is in the code that prints it; a reworded message breaks this pin before it breaks an operator's search.
  for (const [row, where, quote] of [
    ['`environment variable OPERATOR_CONTACT is required`', 'server', 'environment variable ${name} is required'],
    ['`environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required`', 'server', 'environment variable ${name} is required'],
    ['`environment variable SERVICE_AUTH_HEADER is required`', 'server', 'environment variable ${name} is required'],
    ['must be printable ASCII', 'start', 'must be printable ASCII (it is sent as an HTTP header)'],
    ['`request refused: unauthorized (<n> since the last line of this kind)`', 'server', 'request refused: unauthorized (${refusals} since the last line of this kind)'],
    ['`holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone`', 'start', 'holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone'],
    ['`holds the service token, which belongs in SERVICE_AUTH_HEADER alone`', 'start', 'holds the service token, which belongs in SERVICE_AUTH_HEADER alone'],
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
    ['`above the ceiling of`', 'orchestrate', 'above the ceiling of ${ceiling} lovelace (${setting})'],
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
  assert.equal(steps[install].run, 'sudo apt-get update && sudo apt-get install -y poppler-utils');
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
  assert.equal(builds.length, 2, 'one image for each agent');
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

// The host, the stack of its reverse proxy, the other stacks it runs, a login and a key file, in the forms they had in the repository before it went public.
// Built from parts, so that this file does not hold them either. The public hostnames of the adverts, of the indexer and of the hosted server are not here.
const HOST_WORDS = new RegExp(['apex' + '-web', 'uma' + 'mi', 'chandra' + '-supplier', 'activity' + '-api', 'vector-agent' + '-dashboard', 'module3' + '-', 'module6' + '-', 'hetz' + 'ner', 'root' + '@', 'id_' + 'ed25519'].join('|'), 'i');
const TRACKED = (() => { try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { return null; } })();
test('the deployment host is not named: no tracked file names it, the stack of its reverse proxy, its other stacks, a login or a key file', { skip: TRACKED ? false : 'needs a git checkout' }, () => {
  const files = TRACKED.filter((f) => f !== 'pnpm-lock.yaml' && !/\.(pdf|png)$/.test(f) && existsSync(join(root, f)));
  assert.ok(files.length > 150 && files.includes('deploy/host/RUNBOOK.md') && files.includes('docs/superpowers/specs/2026-10-13-vector-service-agents-design.md'), `the walk reaches every tracked file, found ${files.length}`);
  assert.deepEqual(files.filter((f) => HOST_WORDS.test(read(f))), []);
  for (const hit of ['the apex' + '-web box', 'uma' + 'mi_default', '/opt/chandra' + '-supplier/ops']) assert.match(hit, HOST_WORDS, hit);
  for (const miss of ['mp-suppliers-history.hal8.ai', 'mp-suppliers-chandra.hal8.ai', 'ChandraOCR', 'mp-indexer.vector.apexfusion.org', 'deploy/host']) assert.doesNotMatch(miss, HOST_WORDS, miss);
});
