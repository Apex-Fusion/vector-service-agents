import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
// The deployment files of Agent History (Dockerfile, compose, env example, Caddy snippet, README, RUNBOOK, CI publish job) are read by a
// host administrator and an operator who act on them. Docker is not needed here: these tests parse the files and keep them equal to each
// other, to the service code, to the spec and to the design. docker compose config, docker build and caddy validate were run by hand.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (rel) => readFileSync(join(root, rel), 'utf8');
const section = (text, heading) => (text.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const DESIGN = read('docs/superpowers/specs/2026-10-13-vector-service-agents-design.md');
const SPEC = read('specs/agent-history.md');
const compose = parseYaml(read('deploy/apex-web/docker-compose.agent-history.yml'));
const exampleText = read('deploy/apex-web/.env.agent-history.example');
const readme = read('deploy/apex-web/README.md');
const runbook = read('deploy/apex-web/RUNBOOK.md');
const snippet = read('deploy/apex-web/Caddyfile.snippet');
const dockerfile = read('agents/agent-history/Dockerfile');
const ci = parseYaml(read('.github/workflows/ci.yml'));
const { agent, service } = compose.services;
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
function renderManifests(envs) {
  const code = "import { manifestFromEnv } from './src/server.ts'; console.log(JSON.stringify(JSON.parse(process.argv[1]).map((e) => manifestFromEnv(e))));";
  const out = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, JSON.stringify(envs)], { cwd: join(root, 'agents/agent-history'), encoding: 'utf8' });
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
const PUBLIC_FILES = ['deploy/apex-web/README.md', 'deploy/apex-web/RUNBOOK.md', 'deploy/apex-web/docker-compose.agent-history.yml', 'deploy/apex-web/.env.agent-history.example', 'deploy/apex-web/Caddyfile.snippet', 'agents/agent-history/Dockerfile', '.dockerignore'];

test('compose: two containers with fixed names, the runtime on loopback only, the service unpublished, both on the shared network', () => {
  assert.equal(compose.name, 'agent-history');
  assert.deepEqual(Object.keys(compose.services), ['agent', 'service']);
  assert.equal(agent.container_name, 'agent-history-agent');
  assert.equal(service.container_name, 'agent-history-service');
  assert.deepEqual(agent.ports, ['127.0.0.1:8083:8080']);
  assert.equal(service.ports, undefined);
  assert.deepEqual(agent.networks, ['umami_default']);
  assert.deepEqual(service.networks, ['umami_default']);
  assert.deepEqual(compose.networks.umami_default, { external: true, name: 'umami_default' });
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
  assert.equal(url.hostname, service.container_name, 'the container name is unique on umami_default; the alias "service" would match every agent');
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
  assert.match(read('deploy/apex-web/docker-compose.agent-history.yml'), /# Pinned by digest, not by tag\./);
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
  assert.ok(section(SPEC, 'Status').includes(`${example.AGENT_STATUS_CHIP.toUpperCase()} (built, not yet advertised). Since ${example.AGENT_STATUS_SINCE}.`));
  assert.equal(example.AGENT_STATUS_CHIP, 'proposed', 'nothing is advertised, so nothing may claim more');
  // The service takes an empty string as given, so an empty AGENT_STATUS_SINCE would put since "" into the manifest.
  assert.notEqual(example.AGENT_STATUS_SINCE, '');
  // Placeholders are unset, and the one setting with no default is supplied for both.
  const [withExample, withNothing] = renderManifests([{ ...withoutPlaceholders(example), OPERATOR_CONTACT: TEST_CONTACT }, { OPERATOR_CONTACT: TEST_CONTACT }]);
  assert.deepEqual(withExample, withNothing, 'the example changes nothing in the manifest the advert will hash');
  assert.equal(withExample.operator.contact, TEST_CONTACT);
  assert.equal(withExample.status.chip, 'proposed');
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
  const build = job.steps.find((s) => s.uses === 'docker/build-push-action@v6');
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

test('README and RUNBOOK: PROPOSED, no LIVE or DEPLOYED claim, no dash, no unit name, no person named', () => {
  for (const rel of PUBLIC_FILES) {
    const text = read(rel);
    assert.doesNotMatch(text, DASHES, `${rel}: no em or en dash`);
    assert.doesNotMatch(text, UNIT_NAME, `${rel}: the unit is called units`);
    assert.doesNotMatch(text, NAMES, `${rel}: roles, not people`);
    assert.doesNotMatch(text.replace('Nothing in this folder is LIVE or DEPLOYED.', ''), /\b(LIVE|DEPLOYED)\b/, `${rel}: no status claim`);
  }
  for (const rel of ['deploy/apex-web/README.md', 'deploy/apex-web/RUNBOOK.md']) assert.ok(read(rel).includes('Status: PROPOSED. Nothing in this folder is LIVE or DEPLOYED.'), rel);
  assert.match(read('deploy/apex-web/docker-compose.agent-history.yml'), /PROPOSED/);
  assert.match(snippet, /PROPOSED/);
});

test('no individual name, and no personal address, on any public surface: the manifest template, the service source, the specs, the guides, both READMEs and the planning documents', () => {
  // The planning documents (docs/superpowers) are tracked and go public with the repository, so they are held to the same rule.
  const planning = readdirSync(join(root, 'docs/superpowers'), { recursive: true }).filter((f) => f.endsWith('.md')).map((f) => `docs/superpowers/${f.split(sep).join('/')}`);
  assert.equal(planning.length, 3, `the design spec and the two plans: ${planning.join(', ')}`);
  const files = [
    ...PUBLIC_FILES, 'agents/agent-history/agent.json.template', 'agents/agent-history/README.md', 'README.md', 'docs/HIRE.md', 'docs/E2E.md',
    ...sourceFiles('agents/agent-history/src'),
    ...readdirSync(join(root, 'specs')).map((f) => `specs/${f}`),
    ...planning,
  ];
  assert.ok(files.length >= 23 && new Set(files).size === files.length, `the list reaches every surface, found ${files.length}`);
  for (const must of ['agents/agent-history/agent.json.template', 'agents/agent-history/src/server.ts', 'specs/agent-history.md', 'specs/document-pipeline.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', ...planning]) assert.ok(files.includes(must), `${must} is scanned`);
  for (const rel of files) assert.doesNotMatch(read(rel), NAMES, `${rel}: roles, not people`);
  // A path into someone's home folder names its owner too, and a reviewer's handle is a name.
  for (const rel of planning) {
    assert.doesNotMatch(read(rel), HOME_PATH, `${rel}: no path into a home folder`);
    assert.doesNotMatch(read(rel), /--reviewer [a-z0-9]+-[a-z]+\b/, `${rel}: no reviewer handle`);
  }
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
  const STEPS = ['Put the files on the box', 'Log in to the registry and get the service image', 'Build the runtime image', 'Make the env file and generate the supplier key', 'Adapt the ops scripts', 'Fund the supplier wallet', 'Register the identity', 'Stake in Module-3', 'Start the service', 'DNS and Caddy', 'Hash the manifest', 'Post the advert', 'Start the runtime', 'Check the advert on the indexer', 'The first-party run', 'Wallet monitor', 'Flip the status'];
  assert.deepEqual([...runbook.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), STEPS.map((title, i) => [i + 1, title]));
  for (const m of runbook.matchAll(/\bsteps? (\d+)/g)) assert.ok(Number(m[1]) >= 1 && Number(m[1]) <= STEPS.length, `step ${m[1]}`);
  const quoted = [...exampleText.matchAll(/RUNBOOK\.md step (\d+), "([^"]+)"/g)];
  assert.equal(quoted.length, 3, 'the example names steps 4, 7 and 17');
  for (const m of quoted) assert.equal(STEPS[Number(m[1]) - 1], m[2], `the example quotes step ${m[1]}`);
  assert.match(runbook, /does every step except three\. Step 2 \(the registry login and the service image\) and step 10 \(DNS and Caddy\) are the host administrator's, see \[README\.md\]\(README\.md\)\. Step 6 \(funding the supplier wallet\) is the Foundation's\./);
  assert.match(section(runbook, '2. Log in to the registry and get the service image'), /^\nHost administrator\. /);
  assert.match(section(runbook, '6. Fund the supplier wallet'), /^\nThe Foundation\. /);
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

test('RUNBOOK: funding is two transfers (5 alone, then 50), and the key is generated on the box and is the only copy', () => {
  assert.match(runbook, /exactly 5 units alone/);
  assert.match(runbook, /then 50 units/);
  assert.match(runbook, /this file is the only copy until step 7\. There is no recovery phrase/);
  // Step 7 writes a second plaintext copy of the key, and the runbook says so where it happens, where the key is generated and in Back out.
  assert.match(section(runbook, '4. Make the env file and generate the supplier key'), /Step 7 writes a second plaintext copy of the key to `\/opt\/agent-history\/ops\/wallet`/);
  assert.match(section(runbook, '7. Register the identity'), /That file is a second plaintext copy of the supplier key, next to the one in the env file\./);
  assert.match(section(runbook, 'Back out'), /4\. Operator: remove the second plaintext copy of the supplier key that step 7 wrote: `shred -u \/opt\/agent-history\/ops\/wallet`/);
  assert.match(runbook, /gen-keypair\.ts --network 1/);
  assert.match(runbook, /chmod 600 \.env\.agent-history/);
  assert.match(runbook, /read -rs GHCR_TOKEN/);
});

test('RUNBOOK: ends with the two gotchas of the chandra ops README, word for word', () => {
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
    'the result against wall clock before spending anything.',
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

// Every file of the repository, as a path with forward slashes, without the folders that hold other people's files or planning notes.
function repoFiles(dir = '', out = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = dir === '' ? e.name : `${dir}/${e.name}`;
    if (e.isDirectory()) { if (!['node_modules', '.git', '.superpowers'].includes(e.name) && rel !== 'docs/superpowers') repoFiles(rel, out); } else out.push(rel);
  }
  return out;
}

test('RUNBOOK step 17: the last item names every file that says PROPOSED about Agent History, and only files that exist', () => {
  const s17 = section(runbook, '17. Flip the status');
  const item8 = s17.slice(s17.indexOf('8. In the repository'));
  const OTHER_AGENTS = ['specs/document-pipeline.md', 'specs/audio-snippets.md', 'specs/advocate.md'];
  const carriers = repoFiles().filter((f) => /(\.md|\.yml|Caddyfile\.snippet|\.example)$/.test(f) && !OTHER_AGENTS.includes(f))
    .filter((f) => /\bPROPOSED\b/.test(read(f)) || /^AGENT_STATUS_CHIP=proposed$/m.test(read(f)));
  assert.ok(carriers.length >= 10, `the walk found the files: ${carriers.join(', ')}`);
  for (const f of carriers) assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
  // The code says `proposed` too: the service default, the manifest template and the tests that pin it. Every file of the agent that carries the word as a value is named.
  const codeSide = [...sourceFiles('agents/agent-history/src'), ...sourceFiles('agents/agent-history/test'), 'agents/agent-history/agent.json.template'].filter((f) => /(['"])proposed\1/.test(read(f)));
  for (const must of ['agents/agent-history/src/server.ts', 'agents/agent-history/agent.json.template', 'agents/agent-history/test/server.test.ts']) assert.ok(codeSide.includes(must), `${must} carries the word as a value`);
  for (const f of codeSide) assert.ok(item8.includes('`' + f + '`'), `item 8 names ${f}`);
  assert.match(item8, /regenerate it from the code, never by hand/);
  assert.match(item8, /The Identity and Links sections of the spec .* were refreshed after steps 7 and 12; check that they are still true\./);
  for (const [, named] of item8.matchAll(/`([A-Za-z0-9_.\/-]+\.(?:md|yml|snippet|example|ts|mjs|template))`/g)) assert.ok(existsSync(join(root, named)), `item 8 names a file that exists: ${named}`);
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
  assert.ok(seven.includes('Record the identity in the repository.') && seven.includes('"This agent has no registry record yet."') && seven.includes('`scripts/specs.test.mjs`'));
  assert.ok(seven.indexOf('Record the identity in the repository.') > seven.indexOf("grep -c '^AGENT_DID=did:vector:agent:'"), 'after the identity is checked');
  const twelve = section(runbook, '12. Post the advert');
  assert.ok(twelve.includes('Record the advert in the repository.') && twelve.includes('"Advert on the explorer: none yet. The advert is not posted."'));
  assert.ok(twelve.includes('https://explorer.vector.mainnet.apexfusion.org/transaction/hash/') && twelve.includes('The status word stays PROPOSED until step 17.'));
  assert.ok(twelve.indexOf('Record the advert in the repository.') > twelve.indexOf('ADVERT_REF=$(docker compose'), 'after the advert is posted');
  assert.match(section(runbook, '17. Flip the status'), /refreshed after steps 7 and 12/);
  const nine = section(runbook, '9. Start the service');
  assert.ok(nine.includes("KEY=$(sed -n 's/^SUPPLIER_PKH=//p' .env.agent-history)"), 'the key hash comes from the env file');
  assert.ok(nine.includes('`subject.kind` is `pkh`, `subject.candidates` lists the record of step 7, and `marketplace` is an object, not null.'));
  assert.ok(nine.includes('docs/HIRE.md') && nine.includes('section 7 invites members to use'), 'why the key-hash query is asked');
  assert.ok(nine.indexOf('"$KEY"') > nine.indexOf('"$DID"'), 'after the query by DID');
  assert.ok(runbook.indexOf('"$KEY"') < runbook.indexOf('## 12.'), 'before the advert is posted');
});

test('RUNBOOK: the key is never sent anywhere, the registry login block is bash, the hash script runs from the repository root, the marketplace tools are on the hosted mainnet server, the wallet monitor is named', () => {
  assert.match(section(runbook, '4. Make the env file and generate the supplier key'), /is never sent anywhere\./);
  assert.doesNotMatch(runbook, /never leaves/);
  assert.match(section(runbook, '2. Log in to the registry and get the service image'), /```bash\nread -rs GHCR_TOKEN/);
  assert.match(section(runbook, '11. Hash the manifest'), /```sh\ncd \/opt\/agent-history\/repo\nnode scripts\/manifest-hash\.mjs /);
  const s15 = section(runbook, '15. The first-party run');
  assert.ok(s15.includes('As of 2026-10-14 the nine marketplace tools the script needs are merged into `main` of Apex-Fusion/mcp-server (PR 1 as [#20](https://github.com/Apex-Fusion/mcp-server/pull/20), PR 2 as [#21](https://github.com/Apex-Fusion/mcp-server/pull/21) and PR 3 as [#23](https://github.com/Apex-Fusion/mcp-server/pull/23) with PR 2) and are on the hosted mainnet MCP server, which lists 33 tools.'));
  assert.ok(s15.includes('PR 4 ([#22](https://github.com/Apex-Fusion/mcp-server/pull/22)), the signer package with its `keygen` command, is merged too, and the package is not published.'));
  assert.doesNotMatch(s15, /and PR 4 as/, 'PR 4 is the signer, not one of the nine marketplace tools');
  assert.ok(s15.includes('The default `BUILDER_URL` of the script is the hosted mainnet MCP server, so the run needs no local builder. E2E.md keeps the local build of `main` as the fallback for a builder that lacks the tools.'));
  assert.doesNotMatch(s15, /PR 2 is open|PR 3 and PR 4 follow|PRs 2 and 3 follow|are deployed|PR 3 branch/);
  assert.doesNotMatch(s15, /cutover|cuts it over|24 tools|none of them a marketplace tool|awaiting the|still serves/i, 'nothing waits for a cutover any more');
  const s16 = section(runbook, '16. Wallet monitor');
  assert.ok(s16.includes('`Apex-Fusion/agents-marketplace`') && s16.includes('`wallet-monitor/wallets.json`'));
  assert.doesNotMatch(s16, /upstream repository/);
});

test('agent README: the Image section says the publish job pushes on merge to main, that it has not run yet, and that nothing is deployed', () => {
  const image = section(read('agents/agent-history/README.md'), 'Image');
  assert.ok(image.length > 300, 'the section exists');
  assert.ok(image.includes('docker build -f agents/agent-history/Dockerfile'));
  assert.ok(image.includes('pushes the image on merge to `main`'));
  assert.ok(image.includes('It has not run yet: Actions is blocked on this private repository.'));
  assert.ok(image.includes('Nothing is deployed yet.'));
});
