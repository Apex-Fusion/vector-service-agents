// agents/bid-desk/test/deploy.test.ts
// The deploy pack of the three Bid Desks, in deploy/server: three compose files (one for each Bid Desk), one env example, and the Caddy snippet and the runbook that the three share. Each Bid Desk is a project
// of its own with two containers: a runtime in front of a service. It has its own runtime key, service key, wallet, advert, ports, host name, folder and volume. The three share one image of the service and one
// image of the runtime, and one env example, from which the operator makes three env files.
//
// A guard here takes a text and gives the list of what is wrong with it. The list is empty for the real file, and it names the rule for each copy that breaks one. Each refusal has an accepted twin. The tests
// run over the three Bid Desks in tables, so a rule that holds for one holds for all three.
// The question of the pack: can a container start with a key that it must not hold, on a public port, from an image that a tag can move, from a build on the host, or on a network that another container shares?
// Can two Bid Desks share a key, a port, a volume or a host name? Does the check before the Claim stay on for each Bid Desk? No test here uses the network, Docker or the clock. The render of the compose files
// and the check of the Caddy blocks need Docker, so they run by hand (RUNBOOK-bid-desk.md).
//
// No pattern here is built from a host name, from an image name or from a file name: a constant that looks like a host never flows into `new RegExp`. A message is matched by a pattern literal or by its first words.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { BID_CAPABILITIES, BID_DESK_MODEL } from '@vsa/usecase-kit/bids';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { USE_CASE_NAMES } from '../../../scripts/operator/usecases/names.ts';
import { QUOTE_REFUSAL_STATUS } from '../src/job/refusal.ts';
import { BOND_LOVELACE, INSTANCES, INSTANCE_NAMES, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_LIST_ROUTE, PRICE_LOVELACE, STATE_DIR_DEFAULT } from '../src/serve/settings.ts';
import type { Instance } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS, loadConfig, startService } from '../src/serve/start.ts';
import { AGENT_DID, CONTACT, PRICE_LIST_SHA256, SERVICE as SERVICE_KEY, SUPPLIER, TOKEN, message } from './serve/support.ts';

// --- the files ---------------------------------------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (name: string): string => readFileSync(join(root, 'deploy', 'server', name), 'utf8');
const START_TEXT = readFileSync(new URL('../src/serve/start.ts', import.meta.url), 'utf8');

const FILES = {
  example: '.env.bid-desk.example',
  snippet: 'Caddyfile.bid-desk.snippet',
  runbook: 'RUNBOOK-bid-desk.md',
} as const;

// --- what the pack says: names, ports, hosts, images ------------------------------------------------------------------------------------------------

const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const RUNTIME_IMAGE = `${REPOSITORY}/agent-runtime`;
const SERVICE_IMAGE = `${REPOSITORY}/bid-desk`;
const RUNTIME_NAME = 'runtime';
const SERVICE_NAME = 'service';
const RUNTIME_PORT = 8080;
const DOMAIN = 'vector.apexfusion.org';
/** The runtime waits this long for the service beyond the deadline of a job. */
const RUNTIME_EXTRA_WAIT_MS = 60_000;
const SERVICE_TIMEOUT_MS = JOB_DEADLINE_MS + RUNTIME_EXTRA_WAIT_MS;
/** The service stops a job at the end of its wait, and compose gives it this much more time to log what it abandoned and to exit. */
const STOP_GRACE = `${SHUTDOWN_WAIT_MS / 1000 + 30}s`;

/** One Bid Desk of the pack: everything that is its own. */
interface Bid {
  readonly name: Instance;
  readonly project: string;
  readonly composeFile: string;
  readonly envFile: string;
  readonly runtimeContainer: string;
  readonly serviceContainer: string;
  readonly runtimeHostPort: number;
  readonly serviceHostPort: number;
  readonly host: string;
  readonly organisation: string;
  readonly volume: string;
  readonly folder: string;
  readonly network: string;
  /** The two marker lines of the block of this Bid Desk in the Caddy snippet. */
  readonly begin: string;
  readonly end: string;
}
const bidOf = (name: Instance, runtimeHostPort: number, serviceHostPort: number): Bid => ({
  name,
  project: `bid-desk-${name}`,
  composeFile: `docker-compose.bid-desk-${name}.yml`,
  envFile: `.env.bid-desk-${name}`,
  runtimeContainer: `bids-${name}-runtime`,
  serviceContainer: `bids-${name}-service`,
  runtimeHostPort,
  serviceHostPort,
  host: `mp-suppliers-bids-${name}.${DOMAIN}`,
  organisation: `${name}.${DOMAIN}`,
  volume: `bid-desk-${name}-state`,
  folder: `/srv/agents/bid-desk-${name}`,
  network: `bid-desk-${name}_default`,
  begin: `# bid-desk-${name} vhosts (BEGIN)`,
  end: `# bid-desk-${name} vhosts (END)`,
});
/** The three Bid Desks, in the order of the code. */
const BIDS: readonly Bid[] = [bidOf('alfa', 8108, 9106), bidOf('bravo', 8109, 9107), bidOf('charlie', 8110, 9108)];
const otherThan = (bid: Bid): Bid => BIDS[(BIDS.indexOf(bid) + 1) % BIDS.length];

const composeTexts: Readonly<Record<string, string>> = Object.fromEntries(BIDS.map((bid) => [bid.name, readPack(bid.composeFile)]));
const exampleText = readPack(FILES.example);
const snippetText = readPack(FILES.snippet);
const runbookText = readPack(FILES.runbook);

/** The variables of the service that hold a key: each runtime blanks every one of them. The settings of the service name them, and the start file reads each one in the call that takes it. */
const KEY_VARIABLES = SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'));
const KEY_VARIABLES_OF_THE_START = [...START_TEXT.matchAll(/requiredEnv\('([A-Z0-9_]+_PRIV_KEY_HEX)', env\./g)].map((hit) => hit[1]);

const HEX = 'ab'.repeat(32);

// --- small helpers -------------------------------------------------------------------------------------------------------------------------------------

type Model = Record<string, any>;
const isModel = (value: unknown): value is Model => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The same value in every key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => (isModel(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part));
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
/** A name whose value is a secret: the text of a problem about it never shows the value. */
const SECRET_NAME = /PRIV_KEY|SECRET|TOKEN|PASSWORD|API_KEY|AUTH_HEADER/;

/** What a fault expects of a problem: a pattern that the problem matches, or the words that the problem starts with. */
type Expected = RegExp | string;
const says = (problem: string, expected: Expected): boolean => (typeof expected === 'string' ? problem.startsWith(expected) : expected.test(problem));
type Fault = readonly [what: string, change: (text: string) => string, expected: Expected];

/** Replaces every copy of a part. A part that the text does not hold stops the test: a change that changes nothing proves nothing. */
function swap(text: string, from: string, to: string): string {
  expect(text.split(from).length, `the text holds: ${from}`).toBeGreaterThan(1);
  return text.split(from).join(to);
}

/** Exchanges two parts of a text, every copy of each. */
function exchange(text: string, a: string, b: string): string {
  const mark = '\u0000';
  return swap(swap(swap(text, a, mark), b, a), mark, b);
}

/** The text of a copy of the compose file of a Bid Desk: parsed, changed by `change`, and written again. */
function composeWith(bid: Bid, change: (compose: Model) => void): string {
  const copy = structuredClone(parse(composeTexts[bid.name])) as Model;
  change(copy);
  return stringify(copy);
}

// --- the compose files ---------------------------------------------------------------------------------------------------------------------------------

/** What the runtime of a Bid Desk sets in its environment. The compose values win over the env file, so these are the values of the container. Every key variable of the service is blank. */
function runtimeEnvironment(bid: Bid): Record<string, string> {
  return {
    CAPABILITY_KIND: 'custom',
    SERVICE_URL: `http://${bid.serviceContainer}:${PORT_DEFAULT}/`,
    SERVICE_PRECHECK_URL: `http://${bid.serviceContainer}:${PORT_DEFAULT}/precheck`,
    SERVICE_CONTENT_TYPE: 'application/json',
    SERVICE_TIMEOUT_MS: String(SERVICE_TIMEOUT_MS),
    ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
    PORT: String(RUNTIME_PORT),
    PUBLIC_ORIGIN: `https://${bid.host}`,
    RELEASE_WATCHER: '1',
    ...Object.fromEntries(KEY_VARIABLES.map((name) => [name, ''])),
  };
}
/** What the service of a Bid Desk sets: the listener host, the folder of its state, the one supplier key variable (blank), and the three lines that name the Bid Desk. It sets no PORT: the image has 9106. */
function serviceEnvironment(bid: Bid): Record<string, string> {
  return {
    HOST: '0.0.0.0',
    SUPPLIER_PRIV_KEY_HEX: '',
    BID_DESK_STATE_DIR: STATE_DIR_DEFAULT,
    BID_DESK_INSTANCE: bid.name,
    BID_DESK_ORGANISATION: bid.organisation,
    BID_DESK_PUBLIC_ORIGIN: `https://${bid.host}`,
  };
}
const LOGGING = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
const KEYS_OF_EVERY_SERVICE = ['image', 'container_name', 'restart', 'env_file', 'environment', 'ports', 'mem_limit', 'cap_drop', 'security_opt', 'logging'];
const DIGEST_DIGITS = /^[0-9a-f]{64}$/;

interface Want {
  readonly isService: boolean;
  readonly repository: string;
  readonly container: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly memLimit: string;
}
const wantOf = (bid: Bid): Readonly<Record<string, Want>> => ({
  [RUNTIME_NAME]: { isService: false, repository: RUNTIME_IMAGE, container: bid.runtimeContainer, hostPort: bid.runtimeHostPort, containerPort: RUNTIME_PORT, environment: runtimeEnvironment(bid), memLimit: '768m' },
  [SERVICE_NAME]: { isService: true, repository: SERVICE_IMAGE, container: bid.serviceContainer, hostPort: bid.serviceHostPort, containerPort: PORT_DEFAULT, environment: serviceEnvironment(bid), memLimit: '1024m' },
});

/** True when an image is the repository, then `@sha256:`, then the placeholder or 64 hex digits. A tag, a short digest and the bare name are not. */
function isPinnedImage(image: string, repository: string): boolean {
  const parts = image.split('@sha256:');
  return parts.length === 2 && parts[0] === repository && (parts[1] === '<digest>' || DIGEST_DIGITS.test(parts[1]));
}

/** What is wrong with the compose file of one Bid Desk, as text. An empty list is a pass. */
function composeProblems(text: string, bid: Bid): string[] {
  let compose: unknown;
  try {
    compose = parse(text);
  } catch {
    return ['the file is not valid YAML, or a key stands twice in one map'];
  }
  const problems: string[] = [];
  const top: Model = isModel(compose) ? compose : {};
  const services: Model = isModel(top.services) ? top.services : {};
  if (top.name !== bid.project) problems.push(`the project name must be ${bid.project}, so that the default network is ${bid.network}`);
  if ('networks' in top) problems.push('the file has no top-level networks key: the containers stay on the default network of their own project, which no other container shares');
  for (const key of Object.keys(top)) if (!['name', 'services', 'volumes', 'networks'].includes(key)) problems.push(`the top-level key ${key} is not allowed`);
  if (!same(top.volumes, { [bid.volume]: { name: bid.volume } })) problems.push(`volumes must be the one volume ${bid.volume}, with that name`);
  const want = wantOf(bid);
  const wanted = Object.keys(want);
  if (!same(Object.keys(services).sort(), [...wanted].sort())) problems.push(`the file must have the services ${wanted.join(', ')}; it has: ${Object.keys(services).join(', ') || 'none'}`);

  for (const [name, expected] of Object.entries(want)) {
    const s: unknown = services[name];
    if (!isModel(s)) continue;
    const own = (text: string): void => { problems.push(`${name}: ${text}`); };
    const allowed = new Set(expected.isService ? [...KEYS_OF_EVERY_SERVICE, 'volumes', 'stop_grace_period'] : [...KEYS_OF_EVERY_SERVICE, 'depends_on']);
    for (const key of Object.keys(s)) {
      if (key === 'build') own('build is not allowed: the host builds no image, CI builds it');
      else if (key === 'networks') own('networks is not allowed: the container stays on the default network of its own project, which no other container shares');
      else if (key === 'depends_on' && expected.isService) own('depends_on is not allowed: the service waits for nobody');
      else if (!allowed.has(key)) own(`${key} is not allowed`);
    }
    const image = String(s.image ?? '');
    if (!isPinnedImage(image, expected.repository)) own(`image must be ${expected.repository}@sha256: and 64 hex digits, or the placeholder <digest>; found: ${image}`);
    if (s.container_name !== expected.container) own(`container_name must be ${expected.container}`);
    if (s.restart !== 'unless-stopped') own('restart must be unless-stopped');
    if (!same(s.ports, [`127.0.0.1:${expected.hostPort}:${expected.containerPort}`])) own(`ports must be the one entry 127.0.0.1:${expected.hostPort}:${expected.containerPort}; found: ${JSON.stringify(s.ports)}`);
    if (!same(s.env_file, [{ path: `./${bid.envFile}`, required: true }])) own(`env_file must be the one file ./${bid.envFile}, and it must be required`);
    if (s.mem_limit !== expected.memLimit) own(`mem_limit must be ${expected.memLimit}`);
    if (!same(s.cap_drop, ['ALL'])) own('cap_drop must be [ALL]');
    if (!same(s.security_opt, ['no-new-privileges:true'])) own('security_opt must be ["no-new-privileges:true"]');
    if (!same(s.logging, LOGGING)) own('logging must be json-file with 3 files of 10m');
    if (expected.isService) {
      if (!same(s.volumes, [`${bid.volume}:${STATE_DIR_DEFAULT}`])) own(`volumes must be the one entry ${bid.volume}:${STATE_DIR_DEFAULT}`);
      if (s.stop_grace_period !== STOP_GRACE) own(`stop_grace_period must be ${STOP_GRACE}: the service waits up to ${SHUTDOWN_WAIT_MS / 1000} s for its job, and 30 s more are for the line of an abandoned job`);
    } else if (!same(s.depends_on, [SERVICE_NAME])) own(`depends_on must be [${SERVICE_NAME}]`);

    const environment: unknown = s.environment;
    if (!isModel(environment)) {
      own('environment must be a map of names to quoted text');
      continue;
    }
    for (const [variable, value] of Object.entries(environment)) {
      if (typeof value !== 'string') own(`${variable} must be quoted text`);
      else if (/PRIV_KEY_HEX$/.test(variable) && value !== '') own(`${variable} has a value: a key is never written in the compose file`);
      else if (variable === 'PORT' && expected.isService) own(`PORT is not set by the compose file: the image sets PORT=${PORT_DEFAULT} and its health check reads that port`);
      else if (!(variable in expected.environment)) own(/PRIV_KEY_HEX$/.test(variable) ? `${variable} must not be set here: a container reads its own key from its env file` : `${variable} is not set by the compose file`);
    }
    for (const [variable, value] of Object.entries(expected.environment)) {
      const found = environment[variable];
      if (value === '' && /PRIV_KEY_HEX$/.test(variable)) {
        if (found !== '') own(`${variable} must be blank (""): ${expected.isService ? 'the service holds no supplier key' : 'the runtime holds no key of the service'}`);
      } else if (found !== value) {
        own(SECRET_NAME.test(variable) ? `${variable} must be ${JSON.stringify(value)}` : `${variable} must be ${JSON.stringify(value)}; found: ${JSON.stringify(found)}`);
      }
    }
  }
  return problems;
}

/** The text of a compose file with what is its own replaced by a placeholder: the host ports of its two mappings, then the name of the instance (in the project, the containers, the env file, the host, the organisation, the volume and the network). */
function normalised(text: string, bid: Bid): string {
  const parts: ReadonlyArray<readonly [string, string]> = [
    [`127.0.0.1:${bid.runtimeHostPort}:`, '127.0.0.1:<runtime port>:'],
    [`127.0.0.1:${bid.serviceHostPort}:`, '127.0.0.1:<service port>:'],
    [bid.name, '<name>'],
  ];
  return parts.reduce((out, [from, to]) => out.split(from).join(to), text);
}

/** What is wrong with the three compose files together. Each file passes its own guard, the three are one file after what is their own, and what must differ differs. An empty list is a pass. */
function packProblems(texts: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  const parsed: Model[] = [];
  for (const bid of BIDS) {
    const text = texts[bid.name] ?? '';
    problems.push(...composeProblems(text, bid).map((problem) => `${bid.name}: ${problem}`));
    try { parsed.push(parse(text) as Model); } catch { parsed.push({}); }
  }
  const first = normalised(texts[BIDS[0].name] ?? '', BIDS[0]);
  for (const bid of BIDS.slice(1)) {
    const text = normalised(texts[bid.name] ?? '', bid);
    if (text !== first) {
      const lines = text.split('\n');
      const at = first.split('\n').findIndex((line, index) => line !== lines[index]);
      problems.push(`${bid.name}: the file is not the file of ${BIDS[0].name} after the instance name and the host ports are replaced (first difference at line ${at < 0 ? lines.length : at + 1})`);
    }
  }
  const valuesOf = (read: (compose: Model) => unknown): string[] => parsed.map((compose) => JSON.stringify(read(compose)));
  const distinct: ReadonlyArray<readonly [string, (compose: Model) => unknown]> = [
    ['the project name', (c) => c.name],
    ['the container of the runtime', (c) => c.services?.runtime?.container_name],
    ['the container of the service', (c) => c.services?.service?.container_name],
    ['the port of the runtime on the host', (c) => c.services?.runtime?.ports],
    ['the port of the service on the host', (c) => String(c.services?.service?.ports?.[0]).split(':')[1]],
    ['the volume', (c) => c.volumes],
    ['the env file of the runtime', (c) => c.services?.runtime?.env_file],
    ['the env file of the service', (c) => c.services?.service?.env_file],
    ['the host name of the card', (c) => c.services?.runtime?.environment?.PUBLIC_ORIGIN],
    ['the address of the service for the runtime', (c) => c.services?.runtime?.environment?.SERVICE_URL],
    ['the address of the check before the Claim', (c) => c.services?.runtime?.environment?.SERVICE_PRECHECK_URL],
    ['the organisation', (c) => c.services?.service?.environment?.BID_DESK_ORGANISATION],
    ['the instance', (c) => c.services?.service?.environment?.BID_DESK_INSTANCE],
  ];
  for (const [what, read] of distinct) if (new Set(valuesOf(read)).size !== BIDS.length) problems.push(`${what} must be different in the three files`);
  // The container ports are equal on purpose: 8080 for a runtime, and the port of the image for a service.
  const containerPorts = parsed.map((c) => [String(c.services?.runtime?.ports?.[0]).split(':')[2], String(c.services?.service?.ports?.[0]).split(':')[2]].join(','));
  if (new Set(containerPorts).size !== 1 || containerPorts[0] !== `${RUNTIME_PORT},${PORT_DEFAULT}`) problems.push(`the container ports must be ${RUNTIME_PORT} for a runtime and ${PORT_DEFAULT} for a service in all three files`);
  return problems;
}

/** The faults of one compose file. Each change breaks one rule, and the guard names it. The same table runs for each of the three Bid Desks. */
function composeFaults(bid: Bid): readonly Fault[] {
  const other = otherThan(bid);
  const rt = `127.0.0.1:${bid.runtimeHostPort}:${RUNTIME_PORT}`;
  const sv = `127.0.0.1:${bid.serviceHostPort}:${PORT_DEFAULT}`;
  const edit = (change: (compose: Model) => void): string => composeWith(bid, change);
  return [
    // A port that is public, or that points at the wrong place.
    ['a public port on the runtime', (t) => swap(t, rt, `${bid.runtimeHostPort}:${RUNTIME_PORT}`), `runtime: ports must be the one entry ${rt}`],
    ['the address of every interface', (t) => swap(t, rt, `0.0.0.0:${bid.runtimeHostPort}:${RUNTIME_PORT}`), `runtime: ports must be the one entry ${rt}`],
    ['a port on the address of every interface of version 6', (t) => swap(t, rt, `[::]:${bid.runtimeHostPort}:${RUNTIME_PORT}`), 'runtime: ports must be'],
    ['a second port on the runtime', () => edit((c) => { c.services.runtime.ports.push(`127.0.0.1:8120:${RUNTIME_PORT}`); }), 'runtime: ports must be'],
    ['the port of the service on the runtime', () => edit((c) => { c.services.runtime.ports = [`127.0.0.1:${bid.serviceHostPort}:${RUNTIME_PORT}`]; }), 'runtime: ports must be'],
    ['the wrong port in the container of the runtime', () => edit((c) => { c.services.runtime.ports = [`127.0.0.1:${bid.runtimeHostPort}:${PORT_DEFAULT}`]; }), 'runtime: ports must be'],
    ['the host port of the runtime of another Bid Desk', () => edit((c) => { c.services.runtime.ports = [`127.0.0.1:${other.runtimeHostPort}:${RUNTIME_PORT}`]; }), 'runtime: ports must be'],
    ['the port of another pack on the runtime', () => edit((c) => { c.services.runtime.ports = [`127.0.0.1:8101:${RUNTIME_PORT}`]; }), 'runtime: ports must be'],
    ['the long form of a port', () => edit((c) => { c.services.runtime.ports = [{ target: RUNTIME_PORT, published: bid.runtimeHostPort, host_ip: '127.0.0.1' }]; }), 'runtime: ports must be'],
    ['a public port on the service', (t) => swap(t, sv, `${bid.serviceHostPort}:${PORT_DEFAULT}`), `service: ports must be the one entry ${sv}`],
    ['the address of every interface on the service', (t) => swap(t, sv, `0.0.0.0:${bid.serviceHostPort}:${PORT_DEFAULT}`), `service: ports must be the one entry ${sv}`],
    ['a port in the container of the service that the image does not listen on', () => edit((c) => { c.services.service.ports = [`127.0.0.1:${bid.serviceHostPort}:${bid.serviceHostPort + 1}`]; }), 'service: ports must be'],
    ['the host port of the service of another Bid Desk', () => edit((c) => { c.services.service.ports = [`127.0.0.1:${other.serviceHostPort}:${PORT_DEFAULT}`]; }), 'service: ports must be'],
    ['the port of another pack on the service', () => edit((c) => { c.services.service.ports = [`127.0.0.1:9101:${PORT_DEFAULT}`]; }), 'service: ports must be'],
    ['no port on the service', () => edit((c) => { delete c.services.service.ports; }), 'service: ports must be the one entry'],
    ['the host network', () => edit((c) => { c.services.runtime.network_mode = 'host'; }), 'runtime: network_mode is not allowed'],
    // A build, or a network that another container shares.
    ['a build on the runtime', () => edit((c) => { c.services.runtime.build = { context: '.' }; }), 'runtime: build is not allowed'],
    ['a build on the service', () => edit((c) => { c.services.service.build = '.'; }), 'service: build is not allowed'],
    ['a build from the template repository, as the live agents have it', () => edit((c) => { c.services.runtime.build = { context: 'https://github.com/Apex-Fusion/vector-agent-template.git', dockerfile: 'agent/Dockerfile' }; }), 'runtime: build is not allowed'],
    ['a networks key on the runtime', () => edit((c) => { c.services.runtime.networks = ['proxy']; }), 'runtime: networks is not allowed'],
    ['a networks key on the service', () => edit((c) => { c.services.service.networks = ['proxy']; }), 'service: networks is not allowed'],
    ['the network of another Bid Desk on the service', () => edit((c) => { c.services.service.networks = [other.network]; c.networks = { [other.network]: { external: true } }; }), 'service: networks is not allowed'],
    ['a networks key at the top', () => edit((c) => { c.networks = { proxy: { name: 'shared' } }; }), /no top-level networks key/],
    ['the external network of a proxy, on a service and at the top', () => edit((c) => { c.services.service.networks = ['proxy']; c.networks = { proxy: { external: true } }; }), 'service: networks is not allowed'],
    ['the project name of another Bid Desk', (t) => swap(t, `name: ${bid.project}`, `name: ${other.project}`), `the project name must be ${bid.project}`],
    ['a wrong project name', (t) => swap(t, `name: ${bid.project}`, 'name: bid-desk'), `the project name must be ${bid.project}`],
    ['no project name', () => edit((c) => { delete c.name; }), `the project name must be ${bid.project}`],
    // The image.
    ['an image by tag', (t) => swap(t, `${RUNTIME_IMAGE}@sha256:<digest>`, `${RUNTIME_IMAGE}:latest`), 'runtime: image must be'],
    ['the service image by tag', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:latest`), 'service: image must be'],
    ['an image by the tag of a commit', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:${'a1'.repeat(20)}`), 'service: image must be'],
    ['a digest that is too short', (t) => swap(t, '<digest>', 'abc123'), /^(runtime|service): image must be/],
    ['an image of another repository', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/sourcing-agent@sha256`), 'service: image must be'],
    ['the image of the Order Desk', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/order-desk@sha256`), 'service: image must be'],
    ['the service image on the runtime', (t) => swap(t, `${RUNTIME_IMAGE}@sha256`, `${SERVICE_IMAGE}@sha256`), 'runtime: image must be'],
    // A key that a container must not hold.
    ...KEY_VARIABLES.flatMap((name): Fault[] => [
      [`a runtime that does not blank ${name}`, () => edit((c) => { delete c.services.runtime.environment[name]; }), `runtime: ${name} must be blank`],
      [`a runtime that gives ${name} a value`, () => edit((c) => { c.services.runtime.environment[name] = HEX; }), `runtime: ${name} has a value`],
      [`a service that sets its own key ${name}`, () => edit((c) => { c.services.service.environment[name] = ''; }), `service: ${name} must not be set here`],
      [`a service that writes its own key ${name}`, () => edit((c) => { c.services.service.environment[name] = HEX; }), `service: ${name} has a value`],
    ]),
    ['a runtime that sets its own supplier key', () => edit((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = ''; }), 'runtime: SUPPLIER_PRIV_KEY_HEX must not be set here'],
    ['a runtime that writes its supplier key', () => edit((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), 'runtime: SUPPLIER_PRIV_KEY_HEX has a value'],
    ['a service that does not blank the supplier key', () => edit((c) => { delete c.services.service.environment.SUPPLIER_PRIV_KEY_HEX; }), 'service: SUPPLIER_PRIV_KEY_HEX must be blank'],
    ['a service that gives the supplier key a value', () => edit((c) => { c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), 'service: SUPPLIER_PRIV_KEY_HEX has a value'],
    ['a key written in another variable', () => edit((c) => { c.services.service.environment.OTHER_PRIV_KEY_HEX = HEX; }), 'service: OTHER_PRIV_KEY_HEX has a value'],
    ['a key variable of the Order Desk in the runtime', () => edit((c) => { c.services.runtime.environment.ORDER_DESK_SERVICE_PRIV_KEY_HEX = ''; }), 'runtime: ORDER_DESK_SERVICE_PRIV_KEY_HEX must not be set here'],
    ['the token in the runtime', () => edit((c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'runtime: SERVICE_AUTH_HEADER is not set by the compose file'],
    ['the token in the service', () => edit((c) => { c.services.service.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'service: SERVICE_AUTH_HEADER is not set by the compose file'],
    // The env file: one file of the Bid Desk, read by both, and required.
    ['an env file that is not required', (t) => swap(t, 'required: true', 'required: false'), /^(runtime|service): env_file must be the one file/],
    ['the env file of another Bid Desk', (t) => swap(t, `./${bid.envFile}`, `./${other.envFile}`), /^(runtime|service): env_file must be the one file/],
    ['the runtime on the env file of another Bid Desk', () => edit((c) => { c.services.runtime.env_file = [{ path: `./${other.envFile}`, required: true }]; }), 'runtime: env_file must be the one file'],
    ['the service on the env file of another Bid Desk', () => edit((c) => { c.services.service.env_file = [{ path: `./${other.envFile}`, required: true }]; }), 'service: env_file must be the one file'],
    ['the env file of another pack', (t) => swap(t, `./${bid.envFile}`, './.env.order-desk'), /^(runtime|service): env_file must be the one file/],
    ['a second env file on the runtime', () => edit((c) => { c.services.runtime.env_file.push({ path: `./${other.envFile}`, required: true }); }), 'runtime: env_file must be the one file'],
    ['an env file as a plain name', () => edit((c) => { c.services.service.env_file = `./${bid.envFile}`; }), 'service: env_file must be the one file'],
    ['no env file on the service', () => edit((c) => { delete c.services.service.env_file; }), 'service: env_file must be the one file'],
    // The address of the service, the check before the Claim, the windows, the card, the release watcher.
    ['a runtime that calls another port of the service', () => edit((c) => { c.services.runtime.environment.SERVICE_URL = `http://${bid.serviceContainer}:${PORT_DEFAULT + 1}/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime that calls the service of another Bid Desk', () => edit((c) => { c.services.runtime.environment.SERVICE_URL = `http://${other.serviceContainer}:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['the alias of the service in place of its container', () => edit((c) => { c.services.runtime.environment.SERVICE_URL = `http://service:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['an address of the service on the host', () => edit((c) => { c.services.runtime.environment.SERVICE_URL = `http://127.0.0.1:${bid.serviceHostPort}/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime with no check before the Claim', () => edit((c) => { delete c.services.runtime.environment.SERVICE_PRECHECK_URL; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check before the Claim that is empty', () => edit((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = ''; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at another route', () => edit((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${bid.serviceContainer}:${PORT_DEFAULT}/check`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at the route of the job', () => edit((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${bid.serviceContainer}:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check on the service of another Bid Desk', () => edit((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${other.serviceContainer}:${PORT_DEFAULT}/precheck`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check on the service of another pack', () => edit((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://orders-service:${PORT_DEFAULT}/precheck`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a timeout that leaves the window', () => edit((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '460000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "360000"'],
    ['a timeout under the deadline of the job', () => edit((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '300000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "360000"'],
    ['the timeout of the Sourcing Agent', () => edit((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '3480000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "360000"'],
    ['a window under the deadline of the job', () => edit((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '300000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "480000"'],
    ['the window of the Sourcing Agent', () => edit((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '3600000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "480000"'],
    ['a window as a number', () => edit((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = 480000; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be quoted text'],
    ['a timeout as a number', () => edit((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = 360000; }), 'runtime: SERVICE_TIMEOUT_MS must be quoted text'],
    ['a port in the container that the mapping does not publish', () => edit((c) => { c.services.runtime.environment.PORT = '8081'; }), 'runtime: PORT must be "8080"'],
    ['the card of the runtime on the host name of another Bid Desk', () => edit((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `https://${other.host}`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin that is not https', () => edit((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `http://${bid.host}`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin with a path', () => edit((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `https://${bid.host}/`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no card origin', () => edit((c) => { delete c.services.runtime.environment.PUBLIC_ORIGIN; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no release watcher', () => edit((c) => { delete c.services.runtime.environment.RELEASE_WATCHER; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher that is off', () => edit((c) => { c.services.runtime.environment.RELEASE_WATCHER = '0'; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher as a number', () => edit((c) => { c.services.runtime.environment.RELEASE_WATCHER = 1; }), 'runtime: RELEASE_WATCHER must be quoted text'],
    ['the capability kind of another runtime', () => edit((c) => { c.services.runtime.environment.CAPABILITY_KIND = 'chat'; }), 'runtime: CAPABILITY_KIND must be "custom"'],
    ['a setting that the compose file does not set', () => edit((c) => { c.services.runtime.environment.LIVE_CHAIN = '1'; }), 'runtime: LIVE_CHAIN is not set by the compose file'],
    ['the switch of the fault in the runtime', () => edit((c) => { c.services.runtime.environment.FAULT_MODE = 'quote_off_price_list'; }), 'runtime: FAULT_MODE is not set by the compose file'],
    // The listener, the state and the three lines of the service that name the Bid Desk.
    ['a port of the service in its environment', () => edit((c) => { c.services.service.environment.PORT = String(PORT_DEFAULT); }), `service: PORT is not set by the compose file: the image sets PORT=${PORT_DEFAULT}`],
    ['the port of another Bid Desk in the environment of the service', () => edit((c) => { c.services.service.environment.PORT = String(other.serviceHostPort); }), 'service: PORT is not set by the compose file'],
    ['the loopback address inside the container of the service', () => edit((c) => { c.services.service.environment.HOST = '127.0.0.1'; }), 'service: HOST must be "0.0.0.0"'],
    ['a state directory that is not the volume', () => edit((c) => { c.services.service.environment.BID_DESK_STATE_DIR = '/tmp/state'; }), 'service: BID_DESK_STATE_DIR must be "/data"'],
    ['the state directory of another pack', () => edit((c) => { delete c.services.service.environment.BID_DESK_STATE_DIR; c.services.service.environment.ORDER_DESK_STATE_DIR = '/data'; }), /^service: (BID_DESK_STATE_DIR must be|ORDER_DESK_STATE_DIR is not set)/],
    ['the instance of another Bid Desk', () => edit((c) => { c.services.service.environment.BID_DESK_INSTANCE = other.name; }), `service: BID_DESK_INSTANCE must be "${bid.name}"`],
    ['no instance', () => edit((c) => { delete c.services.service.environment.BID_DESK_INSTANCE; }), `service: BID_DESK_INSTANCE must be "${bid.name}"`],
    ['an instance in upper case', () => edit((c) => { c.services.service.environment.BID_DESK_INSTANCE = bid.name.toUpperCase(); }), 'service: BID_DESK_INSTANCE must be'],
    ['the organisation of another Bid Desk', () => edit((c) => { c.services.service.environment.BID_DESK_ORGANISATION = other.organisation; }), 'service: BID_DESK_ORGANISATION must be'],
    ['no organisation', () => edit((c) => { delete c.services.service.environment.BID_DESK_ORGANISATION; }), 'service: BID_DESK_ORGANISATION must be'],
    ['the public origin of another Bid Desk', () => edit((c) => { c.services.service.environment.BID_DESK_PUBLIC_ORIGIN = `https://${other.host}`; }), 'service: BID_DESK_PUBLIC_ORIGIN must be'],
    ['a public origin that is not https', () => edit((c) => { c.services.service.environment.BID_DESK_PUBLIC_ORIGIN = `http://${bid.host}`; }), 'service: BID_DESK_PUBLIC_ORIGIN must be'],
    ['a public origin with a path', () => edit((c) => { c.services.service.environment.BID_DESK_PUBLIC_ORIGIN = `https://${bid.host}/price-list.json`; }), 'service: BID_DESK_PUBLIC_ORIGIN must be'],
    ['a public origin that differs from the card of the runtime', () => edit((c) => { c.services.service.environment.BID_DESK_PUBLIC_ORIGIN = `https://${bid.host}:8443`; }), 'service: BID_DESK_PUBLIC_ORIGIN must be'],
    ['the switch of the fault in the service', () => edit((c) => { c.services.service.environment.FAULT_MODE = ''; }), 'service: FAULT_MODE is not set by the compose file'],
    // The volume, the grace period, the order of the start.
    ['no volume on the service', () => edit((c) => { delete c.services.service.volumes; }), 'service: volumes must be'],
    ['a folder of the host as the state', () => edit((c) => { c.services.service.volumes = [`${bid.folder}:/data`]; }), 'service: volumes must be'],
    ['a volume of another name', () => edit((c) => { c.services.service.volumes = ['state:/data']; }), 'service: volumes must be'],
    ['the volume of another Bid Desk', () => edit((c) => { c.services.service.volumes = [`${other.volume}:/data`]; }), 'service: volumes must be'],
    ['the volume of another pack', () => edit((c) => { c.services.service.volumes = ['order-desk-state:/data']; }), 'service: volumes must be'],
    ['a volume in another folder', () => edit((c) => { c.services.service.volumes = [`${bid.volume}:/state`]; }), 'service: volumes must be'],
    ['a volume on the runtime', () => edit((c) => { c.services.runtime.volumes = [`${bid.volume}:/data`]; }), 'runtime: volumes is not allowed'],
    ['a volume that is external', () => edit((c) => { c.volumes[bid.volume] = { name: bid.volume, external: true }; }), /^volumes must be the one volume/],
    ['the volume of another Bid Desk at the top', () => edit((c) => { c.volumes = { [other.volume]: { name: other.volume } }; }), /^volumes must be the one volume/],
    ['a second volume', () => edit((c) => { c.volumes.other = {}; }), /^volumes must be the one volume/],
    ['a short grace period', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 30s'), 'service: stop_grace_period must be 330s'],
    ['a grace period that equals the wait', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 300s'), 'service: stop_grace_period must be 330s'],
    ['no grace period', () => edit((c) => { delete c.services.service.stop_grace_period; }), 'service: stop_grace_period must be 330s'],
    ['a grace period on the runtime', () => edit((c) => { c.services.runtime.stop_grace_period = '330s'; }), 'runtime: stop_grace_period is not allowed'],
    ['a runtime that does not wait for the service', () => edit((c) => { delete c.services.runtime.depends_on; }), 'runtime: depends_on must be [service]'],
    ['a service that waits for the runtime', () => edit((c) => { c.services.service.depends_on = ['runtime']; }), 'service: depends_on is not allowed'],
    // The shape of the container.
    ['restart always', (t) => swap(t, 'restart: unless-stopped', 'restart: always'), /^(runtime|service): restart must be unless-stopped/],
    ['no memory limit on the runtime', () => edit((c) => { delete c.services.runtime.mem_limit; }), 'runtime: mem_limit must be 768m'],
    ['a limit of 2 GiB on the runtime', () => edit((c) => { c.services.runtime.mem_limit = '2048m'; }), 'runtime: mem_limit must be 768m'],
    ['no memory limit on the service', () => edit((c) => { delete c.services.service.mem_limit; }), 'service: mem_limit must be 1024m'],
    ['a limit of 2 GiB on the service', () => edit((c) => { c.services.service.mem_limit = '2048m'; }), 'service: mem_limit must be 1024m'],
    ['the capabilities kept', () => edit((c) => { c.services.runtime.cap_drop = ['NET_RAW']; }), 'runtime: cap_drop must be [ALL]'],
    ['a capability added', () => edit((c) => { c.services.runtime.cap_add = ['NET_ADMIN']; }), 'runtime: cap_add is not allowed'],
    ['new privileges allowed', () => edit((c) => { delete c.services.service.security_opt; }), 'service: security_opt must be'],
    ['a privileged container', () => edit((c) => { c.services.service.privileged = true; }), 'service: privileged is not allowed'],
    ['the process space of the host', () => edit((c) => { c.services.runtime.pid = 'host'; }), 'runtime: pid is not allowed'],
    ['a device', () => edit((c) => { c.services.runtime.devices = ['/dev/fuse']; }), 'runtime: devices is not allowed'],
    ['the volumes of another container', () => edit((c) => { c.services.runtime.volumes_from = ['service']; }), 'runtime: volumes_from is not allowed'],
    ['a read-only file system that the runtime cannot use', () => edit((c) => { c.services.runtime.read_only = true; }), 'runtime: read_only is not allowed'],
    ['no log limit', () => edit((c) => { c.services.service.logging.options['max-size'] = '1g'; }), 'service: logging must be'],
    ['the wrong container name', (t) => swap(t, `container_name: ${bid.runtimeContainer}`, `container_name: ${bid.project}`), `runtime: container_name must be ${bid.runtimeContainer}`],
    ['the wrong name of the service container', (t) => swap(t, `container_name: ${bid.serviceContainer}`, 'container_name: service'), `service: container_name must be ${bid.serviceContainer}`],
    ['the container name of another Bid Desk', (t) => swap(t, `container_name: ${bid.serviceContainer}`, `container_name: ${other.serviceContainer}`), `service: container_name must be ${bid.serviceContainer}`],
    ['the container name of another pack', (t) => swap(t, `container_name: ${bid.serviceContainer}`, 'container_name: orders-service'), `service: container_name must be ${bid.serviceContainer}`],
    // The services of the file.
    ['a third service', () => edit((c) => { c.services.other = { image: 'example' }; }), /the file must have the services/],
    ['a second runtime', () => edit((c) => { c.services['runtime-two'] = structuredClone(c.services.runtime); }), /the file must have the services/],
    ['a missing runtime', () => edit((c) => { delete c.services.runtime; }), /the file must have the services/],
    ['a missing service', () => edit((c) => { delete c.services.service; }), /the file must have the services/],
    ['a key at the top that the file does not use', () => edit((c) => { c.secrets = {}; }), 'the top-level key secrets is not allowed'],
    // The text itself.
    ['a text that is not YAML', (t) => `${t}\n  : : [\n`, 'the file is not valid YAML'],
    ['a key that stands twice in one map', (t) => swap(t, '    restart: unless-stopped\n', '    restart: unless-stopped\n    restart: always\n'), 'the file is not valid YAML'],
  ];
}

describe('the compose files of the three Bid Desks', () => {
  const reals = BIDS.map((bid) => [bid, parse(composeTexts[bid.name]) as Model] as const);

  test('the three Bid Desks of the pack are the three instances of the code, in order, with the ports, hosts and names that the pack gives', () => {
    expect(BIDS.map((bid) => bid.name)).toStrictEqual([...INSTANCES]);
    expect(BIDS.map((bid) => [bid.runtimeContainer, bid.serviceContainer])).toStrictEqual([['bids-alfa-runtime', 'bids-alfa-service'], ['bids-bravo-runtime', 'bids-bravo-service'], ['bids-charlie-runtime', 'bids-charlie-service']]);
    expect(BIDS.map((bid) => bid.runtimeHostPort)).toStrictEqual([8108, 8109, 8110]);
    expect(BIDS.map((bid) => bid.serviceHostPort)).toStrictEqual([9106, 9107, 9108]);
    expect(BIDS.map((bid) => bid.host)).toStrictEqual([`mp-suppliers-bids-alfa.${DOMAIN}`, `mp-suppliers-bids-bravo.${DOMAIN}`, `mp-suppliers-bids-charlie.${DOMAIN}`]);
    expect(BIDS.map((bid) => bid.composeFile)).toStrictEqual(['docker-compose.bid-desk-alfa.yml', 'docker-compose.bid-desk-bravo.yml', 'docker-compose.bid-desk-charlie.yml']);
    expect(PORT_DEFAULT, 'the container port of every service: the image sets it and its health check reads it').toBe(9106);
    expect(KEY_VARIABLES).toStrictEqual(['BID_DESK_SERVICE_PRIV_KEY_HEX']);
    expect(KEY_VARIABLES_OF_THE_START).toStrictEqual(KEY_VARIABLES);
    expect(Object.keys(composeTexts)).toStrictEqual([...INSTANCES]);
  });

  test('each real file passes its guard: two containers, a runtime in front of a service, each one as the pack says', () => {
    for (const [bid, real] of reals) {
      expect(composeProblems(composeTexts[bid.name], bid), bid.name).toStrictEqual([]);
      expect(Object.keys(real.services), bid.name).toStrictEqual([RUNTIME_NAME, SERVICE_NAME]);
      expect(Object.keys(real), bid.name).toStrictEqual(['name', 'services', 'volumes']);
    }
  });

  test('the three files together pass: each is the file of the first Bid Desk after the instance name and the host ports are replaced, and what must differ differs', () => {
    expect(packProblems(composeTexts)).toStrictEqual([]);
    const [alfa, bravo, charlie] = BIDS.map((bid) => normalised(composeTexts[bid.name], bid));
    expect(bravo).toBe(alfa);
    expect(charlie).toBe(alfa);
    expect(alfa).toContain('name: bid-desk-<name>');
    expect(alfa).toContain('127.0.0.1:<runtime port>:8080');
    expect(alfa).toContain('127.0.0.1:<service port>:9106');
  });

  test('the images are named by digest: the placeholder or 64 hex digits, never a tag', () => {
    const digest = 'ab'.repeat(32);
    for (const bid of BIDS) {
      const want = wantOf(bid);
      const pinned = composeWith(bid, (c) => {
        for (const [name, expected] of Object.entries(want)) c.services[name].image = `${expected.repository}@sha256:${digest}`;
      });
      expect(composeProblems(pinned, bid), `${bid.name} with a digest of 64 hex digits`).toStrictEqual([]);
      expect(composeTexts[bid.name].match(/@sha256:<digest>/g), bid.name).toHaveLength(2);
      for (const bad of [`${RUNTIME_IMAGE}:latest`, `${RUNTIME_IMAGE}:${'a'.repeat(40)}`, RUNTIME_IMAGE, `${RUNTIME_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${'AB'.repeat(32)}`, `${SERVICE_IMAGE}@sha256:${digest}`]) {
        const problems = composeProblems(composeWith(bid, (c) => { c.services.runtime.image = bad; }), bid);
        expect(problems.some((p) => p.startsWith('runtime: image must be')), `${bid.name}: ${bad}`).toBe(true);
      }
      for (const bad of [`${SERVICE_IMAGE}:latest`, `${SERVICE_IMAGE}:${'a'.repeat(40)}`, SERVICE_IMAGE, `${SERVICE_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${digest}`]) {
        const problems = composeProblems(composeWith(bid, (c) => { c.services.service.image = bad; }), bid);
        expect(problems.some((p) => p.startsWith('service: image must be')), `${bid.name}: ${bad}`).toBe(true);
      }
    }
  });

  test('each copy that breaks one rule is refused, in the words of that rule, for each of the three Bid Desks', () => {
    for (const bid of BIDS) {
      const faults = composeFaults(bid);
      expect(faults.length, bid.name).toBeGreaterThan(115);
      for (const [what, change, expected] of faults) {
        const problems = composeProblems(change(composeTexts[bid.name]), bid);
        expect(problems.some((problem) => says(problem, expected)), `${bid.name}, ${what}: found ${JSON.stringify(problems)}`).toBe(true);
      }
    }
  });

  test('the file of one Bid Desk does not pass as the file of another: the project, the containers, the ports, the host, the volume and the env file are its own', () => {
    for (const bid of BIDS) {
      const other = otherThan(bid);
      const problems = composeProblems(composeTexts[other.name], bid);
      for (const part of ['the project name must be', 'runtime: container_name must be', 'service: container_name must be', 'runtime: ports must be', 'service: ports must be', 'runtime: PUBLIC_ORIGIN must be', 'service: BID_DESK_INSTANCE must be', 'volumes must be the one volume', 'runtime: env_file must be']) {
        expect(problems.some((problem) => problem.startsWith(part)), `${other.name} as ${bid.name}: ${part}`).toBe(true);
      }
    }
  });

  test('a service on 9107 or 9108 inside its container stays unhealthy, so the host port changes and the container port stays 9106', () => {
    for (const bid of BIDS.filter((b) => b.serviceHostPort !== PORT_DEFAULT)) {
      const natural = swap(composeTexts[bid.name], `127.0.0.1:${bid.serviceHostPort}:${PORT_DEFAULT}`, `127.0.0.1:${bid.serviceHostPort}:${bid.serviceHostPort}`);
      expect(composeProblems(natural, bid), bid.name).toContain(`service: ports must be the one entry 127.0.0.1:${bid.serviceHostPort}:9106; found: ["127.0.0.1:${bid.serviceHostPort}:${bid.serviceHostPort}"]`);
    }
    for (const [bid, real] of reals) {
      expect(real.services.service.ports, bid.name).toStrictEqual([`127.0.0.1:${bid.serviceHostPort}:9106`]);
      expect(real.services.runtime.environment.SERVICE_URL, bid.name).toBe(`http://${bid.serviceContainer}:9106/`);
      expect('PORT' in real.services.service.environment, `${bid.name}: no PORT for a service`).toBe(false);
    }
  });

  const crossFaults: ReadonlyArray<readonly [string, (texts: Record<string, string>) => Record<string, string>, RegExp | string]> = [
    ['two Bid Desks on one runtime port', (x) => ({ ...x, bravo: swap(x.bravo, '127.0.0.1:8109:', '127.0.0.1:8108:') }), 'bravo: runtime: ports must be'],
    ['two Bid Desks on one service port', (x) => ({ ...x, charlie: swap(x.charlie, '127.0.0.1:9108:', '127.0.0.1:9107:') }), 'charlie: service: ports must be'],
    ['two Bid Desks on one volume', (x) => ({ ...x, bravo: swap(x.bravo, 'bid-desk-bravo-state', 'bid-desk-alfa-state') }), 'bravo: volumes must be the one volume'],
    ['two Bid Desks on one env file', (x) => ({ ...x, charlie: swap(x.charlie, '.env.bid-desk-charlie', '.env.bid-desk-bravo') }), 'charlie: runtime: env_file must be the one file'],
    ['two Bid Desks on one host name', (x) => ({ ...x, bravo: swap(x.bravo, 'mp-suppliers-bids-bravo', 'mp-suppliers-bids-alfa') }), 'bravo: runtime: PUBLIC_ORIGIN must be'],
    ['two Bid Desks on one project', (x) => ({ ...x, charlie: swap(x.charlie, 'name: bid-desk-charlie', 'name: bid-desk-alfa') }), 'charlie: the project name must be'],
    ['a runtime that calls the service of another Bid Desk', (x) => ({ ...x, bravo: swap(x.bravo, 'http://bids-bravo-service:9106/precheck', 'http://bids-alfa-service:9106/precheck') }), 'bravo: runtime: SERVICE_PRECHECK_URL must be'],
    ['the hook dropped from one runtime', (x) => ({ ...x, charlie: swap(x.charlie, '      SERVICE_PRECHECK_URL: http://bids-charlie-service:9106/precheck\n', '') }), 'charlie: runtime: SERVICE_PRECHECK_URL must be'],
    ['the key of the service not blanked in one runtime', (x) => ({ ...x, bravo: swap(x.bravo, '      BID_DESK_SERVICE_PRIV_KEY_HEX: ""\n', '') }), 'bravo: runtime: BID_DESK_SERVICE_PRIV_KEY_HEX must be blank'],
    ['a public port on one service', (x) => ({ ...x, charlie: swap(x.charlie, '"127.0.0.1:9108:9106"', '"9108:9106"') }), 'charlie: service: ports must be'],
    ['a tag in place of a digest in one file', (x) => ({ ...x, bravo: swap(x.bravo, 'agent-runtime@sha256:<digest>', 'agent-runtime:latest') }), 'bravo: runtime: image must be'],
    ['one file changed by one line (a limit)', (x) => ({ ...x, charlie: swap(x.charlie, 'mem_limit: 1024m', 'mem_limit: 2048m') }), 'charlie: service: mem_limit must be 1024m'],
    ['one file changed by one comment line', (x) => ({ ...x, bravo: `${x.bravo}# one more line\n` }), 'bravo: the file is not the file of alfa after the instance name and the host ports are replaced'],
    ['one file with a line moved', (x) => ({ ...x, charlie: exchange(x.charlie, '    restart: unless-stopped\n', '    mem_limit: 1024m\n') }), 'charlie: '],
  ];
  test('a change in one of the three files is refused by the guard of the three together, in the words of the rule that it breaks', () => {
    for (const [what, change, expected] of crossFaults) {
      const problems = packProblems(change({ ...composeTexts }));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('what must differ: two of the three compose files that give a value that must be its own to two Bid Desks are refused, whatever the per-file guard says', () => {
    const models = BIDS.map((bid) => structuredClone(parse(composeTexts[bid.name])) as Model);
    const texts = (list: readonly Model[]): Record<string, string> => Object.fromEntries(BIDS.map((bid, at) => [bid.name, stringify(list[at])]));
    expect(packProblems(texts(models))).toStrictEqual([]);
    const shared = structuredClone(models);
    for (const m of shared) {
      m.services.runtime.ports = ['127.0.0.1:8108:8080'];
      m.services.service.ports = ['127.0.0.1:9106:9106'];
    }
    const problems = packProblems(texts(shared));
    for (const part of ['the port of the runtime on the host must be different in the three files', 'the port of the service on the host must be different in the three files']) expect(problems, part).toContain(part);
    const moved = structuredClone(models);
    moved[1].services.service.ports = ['127.0.0.1:9107:9107'];
    expect(packProblems(texts(moved)), 'the container ports of the three files are equal').toContain('the container ports must be 8080 for a runtime and 9106 for a service in all three files');
  });

  test('a problem about a key names the variable and never shows its value', () => {
    for (const bid of BIDS) {
      const text = composeProblems(composeWith(bid, (c) => { c.services.runtime.environment.BID_DESK_SERVICE_PRIV_KEY_HEX = HEX; c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), bid).join('\n');
      expect(text).toContain('BID_DESK_SERVICE_PRIV_KEY_HEX');
      expect(text).toContain('SUPPLIER_PRIV_KEY_HEX');
      expect(text).not.toContain(HEX);
      const wrongToken = composeProblems(composeWith(bid, (c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = `Bearer ${HEX}`; }), bid).join('\n');
      expect(wrongToken).not.toContain(HEX);
    }
  });

  test('the twins: a map in another key order, the file written again and a port in the block form are accepted, and a list in place of a map is refused', () => {
    for (const bid of BIDS) {
      expect(composeProblems(stringify(parse(composeTexts[bid.name])), bid), `${bid.name} written again`).toStrictEqual([]);
      const reordered = composeWith(bid, (c) => {
        for (const name of [RUNTIME_NAME, SERVICE_NAME]) c.services[name].environment = Object.fromEntries(Object.entries(c.services[name].environment as Record<string, string>).reverse());
      });
      expect(composeProblems(reordered, bid), `${bid.name} with the environment in the opposite order`).toStrictEqual([]);
      const rt = `["127.0.0.1:${bid.runtimeHostPort}:8080"]`;
      const blockForm = swap(composeTexts[bid.name], `ports: ${rt}`, `ports:\n      - "127.0.0.1:${bid.runtimeHostPort}:8080"`);
      expect(composeProblems(blockForm, bid), `${bid.name} with a port in the block form of a list`).toStrictEqual([]);
      const asList = composeWith(bid, (c) => { c.services.runtime.environment = Object.entries(c.services.runtime.environment).map(([name, value]) => `${name}=${String(value)}`); });
      expect(composeProblems(asList, bid)).toStrictEqual(['runtime: environment must be a map of names to quoted text']);
    }
    const twin = Object.fromEntries(BIDS.map((bid) => [bid.name, normalised(composeTexts[BIDS[0].name], BIDS[0]).split('<name>').join(bid.name).split('127.0.0.1:<runtime port>:').join(`127.0.0.1:${bid.runtimeHostPort}:`).split('127.0.0.1:<service port>:').join(`127.0.0.1:${bid.serviceHostPort}:`)]));
    expect(packProblems(twin), 'the file of the first Bid Desk, written for the other two').toStrictEqual([]);
  });

  test('the key variables of the start file are the ones that each runtime blanks, and each service blanks the supplier key: a second key in the start file needs a second blank in each runtime', () => {
    for (const [bid, real] of reals) {
      const environment = real.services.runtime.environment as Record<string, string>;
      for (const name of KEY_VARIABLES) expect(environment[name], `${bid.name}: the runtime blanks ${name}`).toBe('');
      expect('SUPPLIER_PRIV_KEY_HEX' in environment, `${bid.name}: the runtime sets no supplier key`).toBe(false);
      expect((real.services.service.environment as Record<string, string>).SUPPLIER_PRIV_KEY_HEX, bid.name).toBe('');
      for (const name of KEY_VARIABLES) expect(name in real.services.service.environment, `${bid.name}: the service does not set ${name}`).toBe(false);
      for (const service of Object.values(real.services) as Model[]) {
        for (const [name, value] of Object.entries(service.environment as Record<string, string>)) if (/PRIV_KEY_HEX$/.test(name)) expect(value, `${bid.name}: no container writes ${name}`).toBe('');
      }
    }
  });

  test('the windows nest: the deadline of a job is inside the timeout of the runtime, which is inside the window of the advert with 60 s to spare, and the window is at least 480,000 ms', () => {
    expect([MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    expect(JOB_DEADLINE_MS).toBeLessThan(SERVICE_TIMEOUT_MS);
    expect(SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
    expect(MIN_PROCESSING_WINDOW_MS).toBeGreaterThanOrEqual(480_000);
    for (const [bid, real] of reals) {
      const environment = real.services.runtime.environment as Record<string, string>;
      expect(environment.SERVICE_TIMEOUT_MS, `${bid.name}: the timeout is a runtime setting of the pack`).toBe('360000');
      expect(Number(environment.SERVICE_TIMEOUT_MS), bid.name).toBeLessThanOrEqual(Number(environment.ADVERT_MAX_PROCESSING_MS) - 60_000);
      expect(Number(environment.SERVICE_TIMEOUT_MS), bid.name).toBeGreaterThan(JOB_DEADLINE_MS);
      expect(Number(environment.ADVERT_MAX_PROCESSING_MS), bid.name).toBeGreaterThanOrEqual(480_000);
    }
  });

  test('the lock of an advert is 3 units: the price and both bonds, read from the constants of the package', () => {
    expect([PRICE_LOVELACE, BOND_LOVELACE]).toStrictEqual([1_000_000, 1_000_000]);
    expect(PRICE_LOVELACE + 2 * BOND_LOVELACE).toBe(3_000_000);
  });

  test('the runtime and the service of a Bid Desk read its one env file, the runtime starts after the service, and the check before the Claim names the service of the same Bid Desk', () => {
    for (const [bid, real] of reals) {
      for (const name of [RUNTIME_NAME, SERVICE_NAME]) expect(real.services[name].env_file, `${bid.name} ${name}`).toStrictEqual([{ path: `./${bid.envFile}`, required: true }]);
      expect(real.services.runtime.depends_on, bid.name).toStrictEqual([SERVICE_NAME]);
      expect(real.services.runtime.environment.SERVICE_URL, bid.name).toBe(`http://${bid.serviceContainer}:9106/`);
      expect(real.services.runtime.environment.SERVICE_PRECHECK_URL, `${bid.name}: the hook is set, and it is the one of this service`).toBe(`http://${bid.serviceContainer}:9106/precheck`);
    }
    expect(new Set(reals.map(([, real]) => real.services.runtime.environment.SERVICE_PRECHECK_URL)).size, 'three hooks').toBe(3);
  });

  test('the comment of each file says where the digests come from, that no network is joined and that the file is one of three, and it names no other Bid Desk', () => {
    for (const bid of BIDS) {
      const text = composeTexts[bid.name];
      expect(text, bid.name).toContain('RUNBOOK-bid-desk.md');
      expect(text, bid.name).toContain(bid.network);
      expect(text, bid.name).toContain('Caddyfile.bid-desk.snippet');
      expect(text.split('\n').filter((line) => /^\s*(networks|build):/.test(line)), bid.name).toStrictEqual([]);
      for (const other of BIDS.filter((b) => b !== bid)) expect(text.includes(other.name), `${bid.name} does not name ${other.name}`).toBe(false);
    }
  });
});

// --- the env example -----------------------------------------------------------------------------------------------------------------------------------

/** The names of the tool that posts an advert. The operator posts the adverts with the hosted tools, and a runtime reads the reference of its advert as ADVERT_REF. The Bid Desk has no price line: its terms are constants. */
const POST_ADVERT_NAMES = ['ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'] as const;
/** The four supplier lines: the runtime holds the key and the wallet, and the service reads the two public lines to publish them. */
const SUPPLIER_LINES = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'] as const;
/** The service key and its key hash. */
const KEY_LINES = ['BID_DESK_SERVICE_PRIV_KEY_HEX', 'BID_DESK_SERVICE_PKH'] as const;
/** The three lines of the service that name its Bid Desk: they stand in each compose file and never in the example, so that a copy of the wrong env file cannot change an instance. */
const INSTANCE_LINES = ['BID_DESK_INSTANCE', 'BID_DESK_ORGANISATION', 'BID_DESK_PUBLIC_ORIGIN'] as const;
/** The names that the runtime reads from an env file (the template of the runtime). The last one is optional: the runtime has its own default. */
const RUNTIME_READS = [
  'SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO',
  'IDENTITY_ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', 'AGENT_ID', 'ADVERT_REF', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_PRECHECK_URL', 'SERVICE_AUTH_HEADER',
  'SERVICE_CONTENT_TYPE', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'PUBLIC_ORIGIN', 'RELEASE_WATCHER', 'PORT', 'WALLET_HEALTH_INTERVAL_MS',
] as const;
const OPTIONAL_NAMES: readonly string[] = ['WALLET_HEALTH_INTERVAL_MS'];
/** The values that are public chain data: the network, the node, the time of slot 0, the legacy scripts, and the identity registry that Vector mainnet published. The example holds these and no other value of that shape. */
const PUBLISHED: Readonly<Record<string, string>> = {
  NETWORK_ID: '1',
  OGMIOS_URL: 'https://ogmios.vector.mainnet.apexfusion.org',
  VECTOR_ZERO_TIME_MS: '1756485600000',
  LIVE_CHAIN: '1',
  ESCROW_REF_UTXO: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#0',
  ADVERT_REF_UTXO: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1',
  IDENTITY_POLICY_ID: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
  IDENTITY_ESCROW_REF_UTXO: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0',
  IDENTITY_ADVERT_REF_UTXO: '5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758#0',
  VECTOR_IDENTITY_LEGACY_ROOT: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  VECTOR_IDENTITY_CONFIG_SEED: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0',
  VECTOR_IDENTITY_ESCROW_REF_UTXO: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0',
  VECTOR_IDENTITY_VAULT_REF_UTXO: 'd0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b#0',
};
/** The values that this pack chooses: the window of the advert, and the model hire of the decision as Advocate has it (one model, a price of 1 unit at most and both bonds of 2 units at most). */
const CHOSEN: Readonly<Record<string, string>> = {
  AGENT_STATUS_CHIP: 'proposed',
  FAULT_MODE: '',
  ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
};
/** The lines that an operator has to fill: a value in angle brackets stands for what the operator supplies. */
const PLACEHOLDER_NAMES = ['OPERATOR_CONTACT'];
/** Lines whose value stays empty in the example: a key, a key hash, a line that the operator fills later, and a line for which the code has a default. */
const EMPTY_LINES = [
  ...SUPPLIER_LINES, ...KEY_LINES, 'AGENT_ID', 'ADVERT_REF', 'IDENTITY_ADDRESS', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'FAULT_MODE',
  'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL', 'CHECKS_READ_BUDGET_MS',
];
/** The first line of each block, in the order of the blocks: the supplier key, the service key, the token, the chain, the identity registry, the record and the advert, the services that are read, the window, the manifest, the model hire, the fault switch. */
const BLOCK_STARTS = [
  'SUPPLIER_PRIV_KEY_HEX', 'BID_DESK_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'NETWORK_ID', 'IDENTITY_POLICY_ID', 'AGENT_ID', 'VECTOR_OGMIOS_URL', 'ADVERT_MAX_PROCESSING_MS', 'OPERATOR_CONTACT',
  'LLM_MODEL_ALLOWLIST', 'FAULT_MODE',
];
/** The names that stand in the compose files and in the example too: the window of the advert (the compose file gives it to the runtime, and the service reads it from the file), the supplier key line (the service blanks it) and the key line of the service (the runtime blanks it). */
const BOTH = ['ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PRIV_KEY_HEX', ...KEY_VARIABLES];

interface Entry { readonly name: string; readonly value: string; readonly line: number }
/** The NAME=value lines of an example, with their line numbers, and what is wrong with a line that is none. */
function entriesOf(text: string): { readonly entries: readonly Entry[]; readonly problems: readonly string[] } {
  const entries: Entry[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((raw, at) => {
    if (raw.trim() === '' || raw.startsWith('#')) return;
    const hit = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw);
    if (hit === null) problems.push(`line ${at + 1} is not a comment and not NAME=value`);
    else entries.push({ name: hit[1], value: hit[2], line: at + 1 });
  });
  return { entries, problems };
}
const KEY_SHAPED = [/^[0-9a-f]{64}$/i, /^[0-9a-f]{56}$/i, /^addr1/, /ed25519_sk/i];
const emptyValue = (value: string): boolean => value === '' || value === '""';

/** What the compose files set for the containers: the names that an example must not repeat, because the compose value wins. */
function composeSetNames(composes: readonly Model[]): Set<string> {
  return new Set(composes.flatMap((compose) => Object.values(compose.services as Model).flatMap((service) => Object.keys(isModel(service.environment) ? service.environment : {}))));
}
const realComposes: readonly Model[] = BIDS.map((bid) => parse(composeTexts[bid.name]) as Model);

/** What is wrong with the example. An empty list is a pass. */
function exampleProblems(text: string, composes: readonly Model[] = realComposes): string[] {
  const { entries, problems: lineProblems } = entriesOf(text);
  const problems: string[] = [...lineProblems];
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (seen.has(name)) problems.push(`${name} is listed twice`);
    seen.add(name);
  }
  const value = (name: string): string | undefined => entries.find((entry) => entry.name === name)?.value;
  const allowed = new Set<string>([...SETTINGS, ...RUNTIME_READS]);
  // A name that a compose file sets wins over the env file, so the example does not repeat it. The names of BOTH are the exception. The three lines that name the Bid Desk and the port are refused with their own words.
  const setByCompose = composeSetNames(composes);
  for (const { name, value: given } of entries) {
    if ((POST_ADVERT_NAMES as readonly string[]).includes(name)) problems.push(`${name} is a name of the advert tool: the operator posts the advert, and the example holds no such name`);
    else if (!allowed.has(name)) problems.push(`${name} is no setting of the service and no setting of the runtime`);
    if (SECRET_NAME.test(name) && !emptyValue(given)) problems.push(`${name} must be empty`);
    const published = Object.hasOwn(PUBLISHED, name) && PUBLISHED[name] === given;
    if (!published && KEY_SHAPED.some((shape) => shape.test(given))) problems.push(`${name} looks like key material`);
    if ((INSTANCE_LINES as readonly string[]).includes(name)) problems.push(`${name} stands in the compose file of each Bid Desk: a line here would let a copy of the wrong env file change the instance`);
    else if (name === 'PORT') problems.push(`PORT must not stand in the example: the runtime has 8080 from its compose file, and a line here would reach the service, which listens on the port ${PORT_DEFAULT} of its image`);
    else if (setByCompose.has(name) && !BOTH.includes(name)) problems.push(`${name} is set by the compose file, which wins: a line here would do nothing`);
  }
  for (const name of allowed) {
    if (value(name) === undefined && !OPTIONAL_NAMES.includes(name) && (!setByCompose.has(name) || BOTH.includes(name))) problems.push(`${name} is missing`);
  }
  for (const [name, wanted] of Object.entries({ ...PUBLISHED, ...CHOSEN })) {
    const found = value(name);
    if (found !== undefined && found !== wanted) problems.push(SECRET_NAME.test(name) ? `${name} must be the value of the pack` : `${name} must be ${JSON.stringify(wanted)}; found: ${JSON.stringify(found)}`);
  }
  for (const name of EMPTY_LINES) {
    const found = value(name);
    if (found !== undefined && !emptyValue(found)) problems.push(`${name} must be empty in the example`);
  }
  const bracketed = entries.filter((entry) => entry.value.includes('<')).map((entry) => entry.name);
  if (!same([...bracketed].sort(), [...PLACEHOLDER_NAMES].sort())) problems.push(`the lines with a placeholder must be ${PLACEHOLDER_NAMES.join(', ')}; found: ${bracketed.join(', ')}`);
  const token = value('SERVICE_AUTH_HEADER');
  if (token !== undefined && token !== '""') problems.push('SERVICE_AUTH_HEADER must be "" (quoted and empty): the value has a space, so it needs quotes');
  const names = entries.map((entry) => entry.name);
  if (!same(names.slice(0, SUPPLIER_LINES.length + KEY_LINES.length), [...SUPPLIER_LINES, ...KEY_LINES])) problems.push('the example must start with the four supplier lines and then the service key and its key hash');
  const starts = BLOCK_STARTS.map((name) => names.indexOf(name));
  if (starts.some((at, index) => at >= 0 && starts.slice(0, index).some((before) => before > at))) problems.push(`the blocks must follow this order: ${BLOCK_STARTS.join(', ')}`);
  return problems;
}

/** Appends one line at the end of a text. */
const withLine = (text: string, line: string): string => `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`;
/** The place of the line of one name in a list of lines. A name that the text does not hold stops the test. */
function lineOf(lines: readonly string[], name: string): number {
  const at = lines.findIndex((line) => line.startsWith(`${name}=`));
  expect(at, `the text has a line for ${name}`).toBeGreaterThanOrEqual(0);
  return at;
}
/** The text with the value of one name replaced. */
function withValue(text: string, name: string, value: string): string {
  const lines = text.split('\n');
  lines[lineOf(lines, name)] = `${name}=${value}`;
  return lines.join('\n');
}
/** The text without the line of one name. */
function without(text: string, name: string): string {
  const lines = text.split('\n');
  lines.splice(lineOf(lines, name), 1);
  return lines.join('\n');
}

// The proof that the example is the real thing: the example, filled in with the values that an operator gives, and joined with what the compose file sets for the service, is the environment that the service reads at
// start. The real start code accepts it, for each of the three Bid Desks.
const filled = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...env,
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  BID_DESK_SERVICE_PRIV_KEY_HEX: SERVICE_KEY.privateKeyHex,
  SERVICE_AUTH_HEADER: TOKEN,
  SUPPLIER_PKH: SUPPLIER.pkh,
  SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex,
});
const exampleEnv = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value === '""' ? '' : entry.value]));
const containerEnv = (bid: Bid, service: string): Record<string, string> => (parse(composeTexts[bid.name]) as Model).services[service].environment as Record<string, string>;

describe('deploy/server/.env.bid-desk.example', () => {
  test('the real example passes: the settings of the service and the names of the runtime, each one once, every secret empty, the published values as published', () => {
    expect(exampleProblems(exampleText)).toStrictEqual([]);
    const { entries } = entriesOf(exampleText);
    expect(entries.length).toBeGreaterThan(38);
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(new Set<string>([...SETTINGS, ...RUNTIME_READS]).has(name), name).toBe(true);
    for (const name of [...SUPPLIER_LINES, ...KEY_LINES, 'SERVICE_AUTH_HEADER']) expect(emptyValue(entries.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example holds the four supplier lines first, then the service key with its key hash, and the lines of the runtime that stay empty: the reference of the advert and the agent identifier', () => {
    const { entries } = entriesOf(exampleText);
    const names = entries.map((entry) => entry.name);
    expect(names.slice(0, 7)).toStrictEqual(['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'BID_DESK_SERVICE_PRIV_KEY_HEX', 'BID_DESK_SERVICE_PKH', 'SERVICE_AUTH_HEADER']);
    expect(names.at(-1)).toBe('FAULT_MODE');
    for (const name of ['ADVERT_REF', 'AGENT_ID', 'AGENT_DID', 'CHECKS_READ_BUDGET_MS', 'FAULT_MODE']) expect(entries.find((entry) => entry.name === name)!.value, name).toBe('');
    expect(entries.find((entry) => entry.name === 'ADVERT_MAX_PROCESSING_MS')!.value).toBe('480000');
    expect(entries.find((entry) => entry.name === 'AGENT_STATUS_CHIP')!.value).toBe('proposed');
  });

  test('the names that the example leaves out of the settings of the service are the six that the compose files set, and the names that it adds are the ones that only the runtime reads', () => {
    const names = new Set(entriesOf(exampleText).entries.map((entry) => entry.name));
    expect(SETTINGS.filter((name) => !names.has(name)).sort()).toStrictEqual(['BID_DESK_INSTANCE', 'BID_DESK_ORGANISATION', 'BID_DESK_PUBLIC_ORIGIN', 'BID_DESK_STATE_DIR', 'HOST', 'PORT']);
    expect([...names].filter((name) => !(SETTINGS as readonly string[]).includes(name)).sort()).toStrictEqual([
      'ADVERT_REF', 'ADVERT_REF_UTXO', 'AGENT_ID', 'ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_ESCROW_REF_UTXO', 'LIVE_CHAIN', 'NETWORK_ID', 'OGMIOS_URL', 'SUPPLIER_ADDRESS', 'SUPPLIER_PRIV_KEY_HEX',
      'VECTOR_ZERO_TIME_MS',
    ]);
    // The Bid Desk reads no mock base, no Module-1 manifest, no dispute line, no compliance line and no co-sign line, so none of them stands in its example.
    for (const name of ['MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'COMPLIANCE_ISSUER_PKH', 'COSIGN_ALLOWLIST', 'ADVERT_PRICE_LOVELACE']) expect(names.has(name), name).toBe(false);
  });

  test('a name of the advert tool is refused one at a time, and the unchanged example is accepted', () => {
    expect(exampleProblems(exampleText), 'the example as it is').toStrictEqual([]);
    for (const name of POST_ADVERT_NAMES) {
      const problems = exampleProblems(withLine(exampleText, `${name}=`));
      expect(problems.some((problem) => problem === `${name} is a name of the advert tool: the operator posts the advert, and the example holds no such name`), `${name}: ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  const faults: readonly Fault[] = [
    // A key, a token or an address in a line that must stay empty.
    ['a key in the line of the supplier key', (t) => withValue(t, 'SUPPLIER_PRIV_KEY_HEX', HEX), 'SUPPLIER_PRIV_KEY_HEX must be empty'],
    ['a key in the line of the service key', (t) => withValue(t, 'BID_DESK_SERVICE_PRIV_KEY_HEX', HEX), 'BID_DESK_SERVICE_PRIV_KEY_HEX must be empty'],
    ['a token in the token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`), 'SERVICE_AUTH_HEADER must be empty'],
    ['an unquoted token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', ''), 'SERVICE_AUTH_HEADER must be "" (quoted and empty)'],
    ['a key in the line of a public key', (t) => withValue(t, 'SUPPLIER_PUB_KEY_HEX', HEX), /^SUPPLIER_PUB_KEY_HEX (must be empty|looks like key material)/],
    ['a key hash in the line of the supplier', (t) => withValue(t, 'SUPPLIER_PKH', 'cd'.repeat(28)), /^SUPPLIER_PKH (must be empty|looks like key material)/],
    ['a key hash in the key hash line of the service', (t) => withValue(t, 'BID_DESK_SERVICE_PKH', 'cd'.repeat(28)), /^BID_DESK_SERVICE_PKH (must be empty|looks like key material)/],
    ['an address in the line of the wallet', (t) => withValue(t, 'SUPPLIER_ADDRESS', 'addr1qxyz'), /^SUPPLIER_ADDRESS (must be empty|looks like key material)/],
    ['a key in a line that is not its own', (t) => withValue(t, 'AGENT_DID', HEX), /^AGENT_DID (must be empty|looks like key material)/],
    ['a reference of an advert in the example', (t) => withValue(t, 'ADVERT_REF', `${HEX}#0`), /^ADVERT_REF (must be empty|looks like key material)/],
    ['an agent identifier in the example', (t) => withValue(t, 'AGENT_ID', HEX), /^AGENT_ID (must be empty|looks like key material)/],
    ['a budget of the hook in the example', (t) => withValue(t, 'CHECKS_READ_BUDGET_MS', '1200'), 'CHECKS_READ_BUDGET_MS must be empty in the example'],
    // A name that the compose files set: its value wins, so a line here does nothing. The three lines that name the Bid Desk and the port have their own words.
    ...INSTANCE_LINES.map((name): Fault => [`the line ${name}, which names the Bid Desk`, (t) => withLine(t, `${name}=alfa`), `${name} stands in the compose file of each Bid Desk`]),
    ['a line for the port', (t) => withLine(t, 'PORT=9106'), 'PORT must not stand in the example'],
    ['a line for the port of the runtime', (t) => withLine(t, 'PORT=8080'), 'PORT must not stand in the example'],
    ...['HOST=0.0.0.0', 'BID_DESK_STATE_DIR=/data', 'CAPABILITY_KIND=custom', 'SERVICE_URL=http://bids-alfa-service:9106/', 'SERVICE_PRECHECK_URL=http://bids-alfa-service:9106/precheck', 'SERVICE_CONTENT_TYPE=application/json',
      'SERVICE_TIMEOUT_MS=360000', 'PUBLIC_ORIGIN=https://mp-suppliers-bids-alfa.vector.apexfusion.org', 'RELEASE_WATCHER=1'].map((line): Fault => [
      `a line for a name that the compose file sets: ${line.slice(0, line.indexOf('='))}`, (t) => withLine(t, line), / is set by the compose file, which wins/,
    ]),
    // A name that the example must not hold, and a line that is no setting.
    ['a name that is no setting', (t) => withLine(t, 'SOMETHING_ELSE=1'), 'SOMETHING_ELSE is no setting of the service and no setting of the runtime'],
    ['a key variable of the Order Desk', (t) => withLine(t, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX='), 'ORDER_DESK_SERVICE_PRIV_KEY_HEX is no setting of the service and no setting of the runtime'],
    ['the mock base of the Order Desk', (t) => withLine(t, 'MOCK_PUBLIC_BASE='), 'MOCK_PUBLIC_BASE is no setting of the service and no setting of the runtime'],
    ['the Module-1 manifest', (t) => withLine(t, 'VECTOR_MODULE1_MANIFEST='), 'VECTOR_MODULE1_MANIFEST is no setting of the service and no setting of the runtime'],
    ['a line of the dispute code', (t) => withLine(t, 'DISPUTE_CHALLENGE_STAKE_LOVELACE=50000000'), 'DISPUTE_CHALLENGE_STAKE_LOVELACE is no setting of the service and no setting of the runtime'],
    ['a line of the compliance issuer', (t) => withLine(t, 'COMPLIANCE_ISSUER_PKH='), 'COMPLIANCE_ISSUER_PKH is no setting of the service and no setting of the runtime'],
    ['a line of the co-sign route', (t) => withLine(t, 'COSIGN_ALLOWLIST='), 'COSIGN_ALLOWLIST is no setting of the service and no setting of the runtime'],
    ['a second key of the service', (t) => withLine(t, 'BID_DESK_DELEGATION_PRIV_KEY_HEX='), 'BID_DESK_DELEGATION_PRIV_KEY_HEX is no setting of the service and no setting of the runtime'],
    ['a name twice', (t) => withLine(t, 'FAULT_MODE='), 'FAULT_MODE is listed twice'],
    ['a line that is no NAME=value', (t) => withLine(t, 'name = value'), /is not a comment and not NAME=value/],
    // A line that is missing.
    ['a missing line of the runtime', (t) => without(t, 'LIVE_CHAIN'), 'LIVE_CHAIN is missing'],
    ['a missing line of the reference of the advert', (t) => without(t, 'ADVERT_REF'), 'ADVERT_REF is missing'],
    ['a missing supplier key line', (t) => without(t, 'SUPPLIER_PRIV_KEY_HEX'), 'SUPPLIER_PRIV_KEY_HEX is missing'],
    ['a missing key line of the service', (t) => without(t, 'BID_DESK_SERVICE_PRIV_KEY_HEX'), 'BID_DESK_SERVICE_PRIV_KEY_HEX is missing'],
    ['a missing budget of the hook', (t) => without(t, 'CHECKS_READ_BUDGET_MS'), 'CHECKS_READ_BUDGET_MS is missing'],
    ['a missing limit of the model hire', (t) => without(t, 'LLM_MAX_SUPPLIER_BOND_LOVELACE'), 'LLM_MAX_SUPPLIER_BOND_LOVELACE is missing'],
    ['a missing fault switch', (t) => without(t, 'FAULT_MODE'), 'FAULT_MODE is missing'],
    ['a missing contact', (t) => without(t, 'OPERATOR_CONTACT'), 'OPERATOR_CONTACT is missing'],
    // A value that the pack fixes.
    ['a fault switch that is on', (t) => withValue(t, 'FAULT_MODE', 'quote_off_price_list'), 'FAULT_MODE must be ""'],
    ['a fault value of another agent', (t) => withValue(t, 'FAULT_MODE', 'invert_scores'), 'FAULT_MODE must be ""'],
    ['a status word of a live service', (t) => withValue(t, 'AGENT_STATUS_CHIP', 'live'), 'AGENT_STATUS_CHIP must be "proposed"'],
    ['a status word in upper case', (t) => withValue(t, 'AGENT_STATUS_CHIP', 'proposed'.toUpperCase()), 'AGENT_STATUS_CHIP must be "proposed"'],
    ['a window under the deadline of a job', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '300000'), 'ADVERT_MAX_PROCESSING_MS must be "480000"'],
    ['the window of the Sourcing Agent', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '3600000'), 'ADVERT_MAX_PROCESSING_MS must be "480000"'],
    ['another policy of the identity registry', (t) => withValue(t, 'IDENTITY_POLICY_ID', '0'.repeat(56)), 'IDENTITY_POLICY_ID must be'],
    ['another vault script', (t) => withValue(t, 'VECTOR_IDENTITY_VAULT_REF_UTXO', `${HEX}#0`), 'VECTOR_IDENTITY_VAULT_REF_UTXO must be'],
    ['another escrow script of the runtime', (t) => withValue(t, 'IDENTITY_ESCROW_REF_UTXO', `${HEX}#0`), 'IDENTITY_ESCROW_REF_UTXO must be'],
    ['a runtime that cannot write to the chain', (t) => withValue(t, 'LIVE_CHAIN', '0'), 'LIVE_CHAIN must be "1"'],
    ['a placeholder where the pack gives a value', (t) => withValue(t, 'LLM_MAX_PRICE_LOVELACE', '<price>'), 'LLM_MAX_PRICE_LOVELACE must be "1000000"'],
    ['a limit that the model hire does not take', (t) => withValue(t, 'LLM_MAX_BUYER_BOND_LOVELACE', '5000000'), 'LLM_MAX_BUYER_BOND_LOVELACE must be "2000000"'],
    ['a bond limit of the supplier that is too wide', (t) => withValue(t, 'LLM_MAX_SUPPLIER_BOND_LOVELACE', '3000000'), 'LLM_MAX_SUPPLIER_BOND_LOVELACE must be "2000000"'],
    ['another model', (t) => withValue(t, 'LLM_MODEL_ALLOWLIST', 'other/model'), 'LLM_MODEL_ALLOWLIST must be'],
    ['a placeholder in another line', (t) => withValue(t, 'AGENT_DID', '<did>'), 'the lines with a placeholder must be'],
    ['no placeholder where the operator fills a value', (t) => withValue(t, 'OPERATOR_CONTACT', 'ops'), 'the lines with a placeholder must be'],
    // The order of the blocks.
    ['the token before the keys', (t) => exchange(t, '\nSERVICE_AUTH_HEADER=""\n', '\nBID_DESK_SERVICE_PRIV_KEY_HEX=\n'), /^the (blocks must follow this order|example must start with)/],
    ['the chain after the model hire', (t) => exchange(t, '\nNETWORK_ID=1\n', '\nLLM_MAX_PRICE_LOVELACE=1000000\n'), 'the blocks must follow this order'],
    ['the fault switch before the model hire', (t) => exchange(t, '\nFAULT_MODE=\n', '\nLLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash\n'), 'the blocks must follow this order'],
    ['a key hash before its key', (t) => swap(t, '\nBID_DESK_SERVICE_PRIV_KEY_HEX=\nBID_DESK_SERVICE_PKH=\n', '\nBID_DESK_SERVICE_PKH=\nBID_DESK_SERVICE_PRIV_KEY_HEX=\n'), 'the example must start with'],
  ];
  test('each copy of the example that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(55);
    for (const [what, change, expected] of faults) {
      const problems = exampleProblems(change(exampleText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a secret line never shows the value that it found', () => {
    const text = exampleProblems(withValue(withValue(exampleText, 'BID_DESK_SERVICE_PRIV_KEY_HEX', HEX), 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`)).join('\n');
    expect(text).toContain('BID_DESK_SERVICE_PRIV_KEY_HEX');
    expect(text).toContain('SERVICE_AUTH_HEADER');
    expect(text).not.toContain(HEX);
  });

  test('the published values are the ones that the examples of the other packs hold for the chain and the identity registry', () => {
    const order = Object.fromEntries(entriesOf(readPack('.env.order-desk.example')).entries.map((entry) => [entry.name, entry.value]));
    const values = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value]));
    expect(Object.keys(PUBLISHED)).toHaveLength(13);
    for (const [name, wanted] of Object.entries(PUBLISHED)) {
      expect(order[name], `the example of the Order Desk holds ${name}`).toBe(wanted);
      expect(values[name], `the example holds ${name} as published`).toBe(wanted);
    }
  });

  test('no name of the compose files is repeated in the example with another value: the names in both are the window of the advert, the supplier key line and the key line of the service', () => {
    const both = entriesOf(exampleText).entries.filter((entry) => composeSetNames(realComposes).has(entry.name));
    expect(both.map((entry) => entry.name).sort()).toStrictEqual([...BOTH].sort());
    for (const compose of realComposes) expect(compose.services.runtime.environment.ADVERT_MAX_PROCESSING_MS).toBe(both.find((entry) => entry.name === 'ADVERT_MAX_PROCESSING_MS')!.value);
    for (const name of ['SUPPLIER_PRIV_KEY_HEX', ...KEY_VARIABLES]) expect(emptyValue(both.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example, filled in and joined with the environment that the compose file gives the service, starts the real configuration of the service of each Bid Desk', () => {
    const manifestHashes: string[] = [];
    for (const bid of BIDS) {
      const config = loadConfig({ ...filled(exampleEnv), ...containerEnv(bid, SERVICE_NAME) });
      expect([config.port, config.host, config.stateDir, config.fault.mode], bid.name).toStrictEqual([9106, '0.0.0.0', '/data', '']);
      expect([config.instance, config.organisation, config.agentDid], bid.name).toStrictEqual([bid.name, bid.organisation, AGENT_DID]);
      expect(config.checksBudgetMs, `${bid.name}: the empty line keeps the default of the code`).toBe(1200);
      const manifest = JSON.parse(config.manifest.text) as { name: string; terms: Record<string, number>; status: { chip: string }; behaviour: { price_list: { uri: string; sha256: string } } };
      expect(manifest.name, bid.name).toBe(INSTANCE_NAMES[bid.name]);
      expect(manifest.terms, bid.name).toMatchObject({ price_lovelace: 1_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 480_000 });
      expect(manifest.status.chip, bid.name).toBe('proposed');
      expect(manifest.behaviour.price_list, `${bid.name}: the price list is served at the host of the compose file, and its hash is the one of its own file`).toStrictEqual({ uri: `https://${bid.host}${PRICE_LIST_ROUTE}`, sha256: PRICE_LIST_SHA256[bid.name] });
      manifestHashes.push(createHash('sha256').update(config.manifest.text).digest('hex'));
    }
    expect(new Set(manifestHashes).size, 'three Bid Desks, three manifests, three hashes for three adverts').toBe(3);
  });

  test('the example as it is does not start the service: it stops at the service key, and at each line that the operator forgot', () => {
    for (const bid of BIDS) {
      expect(() => loadConfig({ ...exampleEnv, ...containerEnv(bid, SERVICE_NAME) }), bid.name).toThrow(/^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX is required/);
    }
    const bid = BIDS[1];
    const forgotten: ReadonlyArray<readonly [string, string, RegExp]> = [
      ['BID_DESK_SERVICE_PRIV_KEY_HEX', '', /^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX is required/],
      ['SERVICE_AUTH_HEADER', '', /^environment variable SERVICE_AUTH_HEADER is required/],
      ['AGENT_DID', '', /^environment variable AGENT_DID is required/],
      ['SUPPLIER_PKH', '', /^environment variable SUPPLIER_PKH is required/],
      ['OPERATOR_CONTACT', '', /^environment variable OPERATOR_CONTACT is required/],
    ];
    for (const [name, value, expected] of forgotten) expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(bid, SERVICE_NAME), [name]: value }), name).toThrow(expected);
  });

  test('the instance lines of the compose file decide the Bid Desk: a service that is given the lines of another Bid Desk refuses a host that is not its own only in the manifest, so the env file never carries them', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(BIDS[0], SERVICE_NAME) };
    expect(loadConfig(env).instance).toBe('alfa');
    expect(loadConfig({ ...env, ...containerEnv(BIDS[2], SERVICE_NAME) }).instance, 'the lines of the third file win over the file of the first').toBe('charlie');
    for (const name of INSTANCE_LINES) expect(name in exampleEnv, `${name} is no line of the example`).toBe(false);
    expect(message(() => loadConfig({ ...env, BID_DESK_INSTANCE: 'delta' }))).toContain('BID_DESK_INSTANCE');
  });

  test('the fault switch of the example is empty, the one value of this agent starts the service, and a value of another agent stops it', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(BIDS[2], SERVICE_NAME) };
    expect(FAULT_MODES['bid-desk']).toStrictEqual(['quote_off_price_list']);
    expect(loadConfig(env).fault.mode, 'the empty switch of the example').toBe('');
    expect(loadConfig({ ...env, FAULT_MODE: 'quote_off_price_list' }).fault.mode, 'the one value of the agent').toBe('quote_off_price_list');
    expect(() => loadConfig({ ...env, FAULT_MODE: 'invert_scores' }), 'a value of the Sourcing Agent').toThrow(/^environment variable FAULT_MODE must be empty or "quote_off_price_list" for bid-desk/);
  });

  test('the key of the runtime and the key of the service are two keys: the real code refuses a service key that is the supplier key', () => {
    const clash = { ...filled(exampleEnv), ...containerEnv(BIDS[0], SERVICE_NAME), SUPPLIER_PKH: SERVICE_KEY.pkh, SUPPLIER_PUB_KEY_HEX: SERVICE_KEY.pubKeyHex };
    expect(() => loadConfig(clash)).toThrow(/^environment variable BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key: the supplier key is the runtime's/);
  });

  test('the node of the example is the default of the code: the line is empty, and the code gives an https address that the janitor can read the tip of the node with', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(BIDS[0], SERVICE_NAME) };
    expect(exampleEnv.VECTOR_OGMIOS_URL, 'the line is empty: the code has its own default').toBe('');
    expect(loadConfig(env).endpoints.ogmiosUrl).toMatch(/^https:\/\//);
    expect(loadConfig({ ...env, VECTOR_OGMIOS_URL: 'https://node.example.test' }).endpoints.ogmiosUrl).toBe('https://node.example.test');
  });

  test('the runtime of each Bid Desk gets what it needs to boot from the example and its compose file, but its key and the reference of its advert; it holds no key of the service', () => {
    for (const bid of BIDS) {
      const runtimeEnv: Record<string, string> = { ...exampleEnv, ...containerEnv(bid, RUNTIME_NAME) };
      const empty = ['SUPPLIER_PRIV_KEY_HEX', 'OGMIOS_URL', 'ADVERT_REF', 'AGENT_ID', 'NETWORK_ID', 'SERVICE_URL', 'SERVICE_PRECHECK_URL', 'ADVERT_MAX_PROCESSING_MS'].filter((name) => (runtimeEnv[name] ?? '') === '');
      expect(empty, bid.name).toStrictEqual(['SUPPLIER_PRIV_KEY_HEX', 'ADVERT_REF', 'AGENT_ID']);
      for (const name of KEY_VARIABLES) expect(runtimeEnv[name], `${bid.name}: the runtime holds no ${name}`).toBe('');
      expect([runtimeEnv.LIVE_CHAIN, runtimeEnv.RELEASE_WATCHER], `${bid.name}: the release watcher needs LIVE_CHAIN`).toStrictEqual(['1', '1']);
    }
  });

  test('the header of the example says that the operator makes three env files from it, each with keys and a token of its own, and that it never enters git', () => {
    const header = exampleText.split('\n').filter((line) => line.startsWith('#')).join('\n');
    for (const part of [...BIDS.map((bid) => bid.envFile), 'mode 600', 'own', 'token', 'never enters git', FILES.runbook, 'restart does not read it']) expect(header, part).toContain(part);
  });

  test('the comment of the manifest block names each setting that the manifest reads and the window of the advert, so that the operator knows which lines must be final before the hash of the advert is taken', () => {
    const source = readFileSync(new URL('../src/serve/manifest.ts', import.meta.url), 'utf8');
    const read = [...new Set([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map((hit) => hit[1]))];
    const comment = exampleText.split('\n').find((line) => line.startsWith('# The manifest.'));
    expect(comment, 'the comment of the manifest block').toBeDefined();
    expect(read, 'the manifest reads these settings').toEqual(expect.arrayContaining(['OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'SUPPLIER_PKH', 'BID_DESK_INSTANCE', 'BID_DESK_PUBLIC_ORIGIN']));
    for (const name of [...read, 'ADVERT_MAX_PROCESSING_MS']) expect(comment, name).toContain(name);
    for (const name of ['FAULT_MODE', 'SERVICE_AUTH_HEADER', 'CHECKS_READ_BUDGET_MS']) expect(read.includes(name), `${name} never reaches the manifest`).toBe(false);
  });
});

// --- the Caddy blocks ----------------------------------------------------------------------------------------------------------------------------------

interface CaddyNode { readonly head: string; readonly children: CaddyNode[] }
/** The lines of a Caddyfile as a tree: a line that ends with " {" opens a block, "}" closes it, and a comment or a blank line is dropped. Null when the braces do not balance. */
function caddyTree(lines: readonly string[]): CaddyNode[] | null {
  const top: CaddyNode[] = [];
  const stack: CaddyNode[][] = [top];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '}') {
      if (stack.length === 1) return null;
      stack.pop();
      continue;
    }
    const opens = line.endsWith(' {');
    const node: CaddyNode = { head: opens ? line.slice(0, -2) : line, children: [] };
    stack[stack.length - 1].push(node);
    if (opens) stack.push(node.children);
  }
  return stack.length === 1 ? top : null;
}

/** The three routes of the block of a Bid Desk, in order: the manifest and the price list go to its service, and every other path goes to its runtime. */
const routesOf = (bid: Bid): ReadonlyArray<readonly [string, string]> => [
  ['handle /agent.json', `${bid.serviceContainer}:${PORT_DEFAULT}`],
  ['handle /price-list.json', `${bid.serviceContainer}:${PORT_DEFAULT}`],
  ['handle', `${bid.runtimeContainer}:${RUNTIME_PORT}`],
];

/** What is wrong with the Caddy snippet. An empty list is a pass. */
function caddyProblems(text: string): string[] {
  const lines = text.split('\n');
  const problems: string[] = [];
  const spans: Array<{ readonly bid: Bid; readonly from: number; readonly to: number }> = [];
  for (const bid of BIDS) {
    const begins = lines.flatMap((line, at) => (line === bid.begin ? [at] : []));
    const ends = lines.flatMap((line, at) => (line === bid.end ? [at] : []));
    if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) problems.push(`the file must hold the line "${bid.begin}" one time, and after it the line "${bid.end}" one time`);
    else spans.push({ bid, from: begins[0], to: ends[0] });
  }
  if (problems.length > 0) return problems;
  for (let at = 1; at < spans.length; at += 1) {
    if (spans[at].from <= spans[at - 1].to) problems.push('the three pairs of markers must follow one another, in the order of the Bid Desks, and no pair stands inside another');
  }
  const inside = new Set(spans.flatMap(({ from, to }) => Array.from({ length: to - from + 1 }, (_, k) => from + k)));
  if (lines.some((line, at) => !inside.has(at) && line.trim() !== '' && !line.trim().startsWith('#'))) problems.push('only comments stand outside the pairs of markers: the lines between a pair are what a command adds, replaces and removes');
  for (const { bid, from, to } of spans) {
    const tree = caddyTree(lines.slice(from + 1, to));
    if (tree === null) {
      problems.push(`the braces between the markers of ${bid.name} do not balance`);
      continue;
    }
    if (!same(tree.map((node) => node.head), [bid.host])) {
      problems.push(`the block between the markers of ${bid.name} must be the host name ${bid.host}; found: ${tree.map((node) => node.head).join(', ') || 'none'}`);
      continue;
    }
    const routes = routesOf(bid);
    const found = tree[0].children.map((child) => [child.head, child.children.map((inner) => [inner.head, inner.children.length])]);
    if (!same(found, routes.map(([head, upstream]) => [head, [[`reverse_proxy ${upstream}`, 0]]]))) {
      problems.push(`${bid.host}: the block must send /agent.json and /price-list.json to ${routes[0][1]} and every other path to ${routes[2][1]}, with nothing else in it; found: ${JSON.stringify(found)}`);
    }
  }
  return problems;
}

/** The text with the lines of the pair of one Bid Desk, the markers included, changed by `change`. */
function withPair(text: string, bid: Bid, change: (pair: string) => string): string {
  const lines = text.split('\n');
  const from = lines.indexOf(bid.begin);
  const to = lines.indexOf(bid.end);
  return [...lines.slice(0, from), change(lines.slice(from, to + 1).join('\n')), ...lines.slice(to + 1)].join('\n');
}

/** The faults of the Caddy snippet. Each change breaks one rule, and the guard names it. The same table runs for each of the three Bid Desks. */
function caddyFaults(bid: Bid): readonly Fault[] {
  const other = otherThan(bid);
  const service = `${bid.serviceContainer}:${PORT_DEFAULT}`;
  const runtime = `${bid.runtimeContainer}:${RUNTIME_PORT}`;
  const refused = `${bid.host}: the block must send`;
  const inPair = (change: (pair: string) => string) => (t: string): string => withPair(t, bid, change);
  const notThisHost = `the block between the markers of ${bid.name} must be the host name`;
  return [
    ['no begin marker', (t) => swap(t, `${bid.begin}\n`, ''), 'the file must hold the line'],
    ['no end marker', (t) => swap(t, `${bid.end}\n`, ''), 'the file must hold the line'],
    ['the markers of the pair in the wrong order', (t) => exchange(t, bid.begin, bid.end), 'the file must hold the line'],
    ['a marker twice', (t) => `${t}${bid.begin}\n`, 'the file must hold the line'],
    ['a marker with another name', (t) => swap(t, bid.begin, '# bid-desk-delta vhosts (BEGIN)'), 'the file must hold the line'],
    ['a marker of the Order Desk', (t) => swap(t, bid.end, '# order-desk vhosts (END)'), 'the file must hold the line'],
    ['a marker with a space after it', (t) => swap(t, bid.begin, `${bid.begin} `), 'the file must hold the line'],
    ['the markers of two Bid Desks exchanged', (t) => exchange(exchange(t, bid.begin, other.begin), bid.end, other.end), 'the three pairs of markers must follow one another'],
    ['a block outside the markers', (t) => `${t}extra.example.org {\n    respond 200\n}\n`, 'only comments stand outside the pairs of markers'],
    ['a directive before the first marker', (t) => swap(t, `${BIDS[0].begin}\n`, `encode gzip\n${BIDS[0].begin}\n`), 'only comments stand outside the pairs of markers'],
    ['a copy of the block of this Bid Desk after the last marker', (t) => `${t}${bid.host} {\n    respond 200\n}\n`, 'only comments stand outside the pairs of markers'],
    ['the host name of another Bid Desk', (t) => swap(t, `${bid.host} {`, `${other.host} {`), notThisHost],
    ['the host name of another pack', (t) => swap(t, `${bid.host} {`, 'mp-suppliers-orders-small.vector.apexfusion.org {'), notThisHost],
    ['a second block in the pair', inPair((p) => swap(p, bid.end, `second.example.org {\n    handle {\n        reverse_proxy ${runtime}\n    }\n}\n${bid.end}`)), notThisHost],
    ['no block in the pair', inPair(() => `${bid.begin}\n${bid.end}`), notThisHost],
    // The routes: the manifest and the price list go to the service of the same Bid Desk, and the rest goes to its runtime.
    ['a host that sends its rest to the service', inPair((p) => swap(p, `reverse_proxy ${runtime}`, `reverse_proxy ${service}`)), refused],
    ['the wrong port of the runtime', inPair((p) => swap(p, `reverse_proxy ${runtime}`, `reverse_proxy ${bid.runtimeContainer}:${bid.runtimeHostPort}`)), refused],
    ['the runtime by its address on the host', inPair((p) => swap(p, `reverse_proxy ${runtime}`, `reverse_proxy 127.0.0.1:${bid.runtimeHostPort}`)), refused],
    ['the runtime of another Bid Desk', inPair((p) => swap(p, `reverse_proxy ${runtime}`, `reverse_proxy ${other.runtimeContainer}:${RUNTIME_PORT}`)), refused],
    ['the runtime of another pack', inPair((p) => swap(p, `reverse_proxy ${runtime}`, 'reverse_proxy orders-small-runtime:8080')), refused],
    ['the alias of the runtime in place of its container', inPair((p) => swap(p, `reverse_proxy ${runtime}`, `reverse_proxy runtime:${RUNTIME_PORT}`)), refused],
    ['the alias of the service in place of its container', inPair((p) => swap(p, `reverse_proxy ${service}`, `reverse_proxy service:${PORT_DEFAULT}`)), refused],
    ['the wrong port of the service', inPair((p) => swap(p, `reverse_proxy ${service}`, `reverse_proxy ${bid.serviceContainer}:${PORT_DEFAULT + 1}`)), refused],
    ['the service by its address on the host', inPair((p) => swap(p, `reverse_proxy ${service}`, `reverse_proxy 127.0.0.1:${bid.serviceHostPort}`)), refused],
    ['the service of another Bid Desk', inPair((p) => swap(p, `reverse_proxy ${service}`, `reverse_proxy ${other.serviceContainer}:${PORT_DEFAULT}`)), refused],
    ['the manifest sent to the service of another Bid Desk', inPair((p) => swap(p, `    handle /agent.json {\n        reverse_proxy ${service}\n`, `    handle /agent.json {\n        reverse_proxy ${other.serviceContainer}:${PORT_DEFAULT}\n`)), refused],
    ['the price list sent to the service of another Bid Desk', inPair((p) => swap(p, `    handle /price-list.json {\n        reverse_proxy ${service}\n`, `    handle /price-list.json {\n        reverse_proxy ${other.serviceContainer}:${PORT_DEFAULT}\n`)), refused],
    ['the service of another pack', inPair((p) => swap(p, `reverse_proxy ${service}`, 'reverse_proxy orders-service:9102')), refused],
    ['no route for the manifest', inPair((p) => swap(p, 'handle /agent.json {', 'handle /agent {')), refused],
    ['no route for the price list', inPair((p) => swap(p, 'handle /price-list.json {', 'handle /price-list {')), refused],
    ['the manifest sent to the runtime', inPair((p) => swap(p, `    handle /agent.json {\n        reverse_proxy ${service}\n`, `    handle /agent.json {\n        reverse_proxy ${runtime}\n`)), refused],
    ['the price list sent to the runtime', inPair((p) => swap(p, `    handle /price-list.json {\n        reverse_proxy ${service}\n`, `    handle /price-list.json {\n        reverse_proxy ${runtime}\n`)), refused],
    ['a path of the job sent to the service', inPair((p) => swap(p, 'handle /price-list.json {', 'handle /precheck {')), refused],
    ['a third public path of the service', inPair((p) => swap(p, '    handle {\n', `    handle /status {\n        reverse_proxy ${service}\n    }\n    handle {\n`)), refused],
    ['a directive that changes the request', inPair((p) => swap(p, `        reverse_proxy ${runtime}\n`, `        header_up Authorization x\n        reverse_proxy ${runtime}\n`)), refused],
    ['options in the proxy block', inPair((p) => swap(p, `reverse_proxy ${runtime}\n`, `reverse_proxy ${runtime} {\n            header_up X-Test 1\n        }\n`)), refused],
    ['a redirect before the handles', inPair((p) => swap(p, `${bid.host} {\n`, `${bid.host} {\n    redir https://elsewhere.example.org\n`)), refused],
    ['the routes in another order', inPair((p) => exchange(p, 'handle /agent.json {', 'handle /price-list.json {')), refused],
    ['braces that do not balance', inPair((p) => swap(p, bid.end, `}\n${bid.end}`)), `the braces between the markers of ${bid.name} do not balance`],
  ];
}

describe('deploy/server/Caddyfile.bid-desk.snippet', () => {
  test('the real snippet passes: three pairs of markers, a host block in each, sending the manifest and the price list to its own service and the rest to its own runtime', () => {
    expect(caddyProblems(snippetText)).toStrictEqual([]);
    const lines = snippetText.split('\n');
    const markers = BIDS.flatMap((bid) => [bid.begin, bid.end]);
    expect(new Set(markers).size, 'six distinct marker lines').toBe(6);
    for (const line of markers) expect(lines.filter((l) => l === line), line).toHaveLength(1);
    expect(routesOf(BIDS[0]).map(([head]) => head)).toStrictEqual(['handle /agent.json', 'handle /price-list.json', 'handle']);
    expect(PRICE_LIST_ROUTE).toBe('/price-list.json');
  });

  test('each block sits inside its own pair, and the pairs follow one another in the order of the Bid Desks', () => {
    const lines = snippetText.split('\n');
    let before = -1;
    for (const bid of BIDS) {
      const [from, to, at] = [lines.indexOf(bid.begin), lines.indexOf(bid.end), lines.indexOf(`${bid.host} {`)];
      expect(from, bid.name).toBeGreaterThan(before);
      expect(at, `${bid.name}: the block is in its pair`).toBeGreaterThan(from);
      expect(at, `${bid.name}: the block is in its pair`).toBeLessThan(to);
      before = to;
    }
  });

  test('the upstreams are the container names and the container ports of the compose file of the same Bid Desk, and the host is the origin that its compose file names', () => {
    for (const bid of BIDS) {
      const compose = parse(composeTexts[bid.name]) as Model;
      const lines = snippetText.split('\n');
      const tree = caddyTree(lines.slice(lines.indexOf(bid.begin) + 1, lines.indexOf(bid.end)))!;
      const upstreamOf = (head: string): string => tree[0].children.find((child) => child.head === head)!.children[0].head.replace(/^reverse_proxy /, '');
      const runtime = compose.services.runtime as Model;
      const service = compose.services.service as Model;
      expect(upstreamOf('handle'), `${bid.name}: the runtime`).toBe(`${runtime.container_name}:${String(runtime.ports[0]).split(':')[2]}`);
      expect(upstreamOf('handle /agent.json'), `${bid.name}: the manifest`).toBe(`${service.container_name}:${String(service.ports[0]).split(':')[2]}`);
      expect(upstreamOf('handle /price-list.json'), `${bid.name}: the price list`).toBe(`${service.container_name}:${String(service.ports[0]).split(':')[2]}`);
      expect(runtime.environment.PUBLIC_ORIGIN, `${bid.name}: the card of the runtime`).toBe(`https://${tree[0].head}`);
      expect(service.environment.BID_DESK_PUBLIC_ORIGIN, `${bid.name}: the origin of the price list`).toBe(`https://${tree[0].head}`);
      expect(runtime.environment.SERVICE_URL, `${bid.name}: the address of the service for the runtime`).toBe(`http://${upstreamOf('handle /agent.json')}/`);
      expect(tree[0].head, `${bid.name}: the host of the block`).toBe(bid.host);
    }
  });

  test('each copy that breaks one rule is refused, in the words of that rule, for each of the three Bid Desks', () => {
    for (const bid of BIDS) {
      const faults = caddyFaults(bid);
      expect(faults.length, bid.name).toBeGreaterThan(35);
      for (const [what, change, expected] of faults) {
        const problems = caddyProblems(change(snippetText));
        expect(problems.some((problem) => says(problem, expected)), `${bid.name}, ${what}: found ${JSON.stringify(problems)}`).toBe(true);
      }
    }
  });

  test('the twins: tabs in place of spaces, a comment, a blank line and a changed header change nothing, and the three blocks alone pass', () => {
    const lines = snippetText.split('\n');
    const inside = lines.slice(lines.indexOf(BIDS[0].begin), lines.indexOf(BIDS[2].end) + 1).join('\n');
    expect(caddyProblems(inside), 'the blocks alone, with no header').toStrictEqual([]);
    expect(caddyProblems(inside.replace(/^ {4}/gm, '\t').replace(/^ {8}/gm, '\t\t')), 'tabs').toStrictEqual([]);
    expect(caddyProblems(swap(inside, 'handle /agent.json {', '# a note\n\n    handle /agent.json {')), 'a comment and a blank line').toStrictEqual([]);
    expect(caddyProblems(`# another header\n${inside}\n# a footer\n`)).toStrictEqual([]);
    expect(caddyProblems(withPair(snippetText, BIDS[1], (pair) => `# a note about this block\n${pair}`)), 'a comment before a pair').toStrictEqual([]);
  });

  test('the header says how a block gets in: in place, validated, and then a reload; each Bid Desk joins its own network after its first start, and the Caddy container joins again after a new container', () => {
    const header = snippetText.slice(0, snippetText.indexOf(BIDS[0].begin));
    for (const bid of BIDS) for (const part of [`docker network connect ${bid.network} <caddy container>`, bid.composeFile, bid.host, bid.serviceContainer, bid.runtimeContainer]) expect(header, part).toContain(part);
    for (const part of ['<caddy container>', 'in place', 'inode', 'validate', 'reload', 'Never restart', 'DNS-only', 'joins again', 'after the first start of THAT Bid Desk', 'three pairs of markers', 'six markers', FILES.runbook]) expect(header, part).toContain(part);
  });
});

// --- the runbook ---------------------------------------------------------------------------------------------------------------------------------------

const SECTIONS = [
  'What it is', 'The files', 'The memory gate', 'The DNS records', 'The folders', 'The env files', 'The images', 'Check the compose files', 'The price lists', 'The adverts', 'The start order', 'The checks',
  'The Caddy block', 'The restart rule', 'The fault switch', 'The failure table', 'Back out', 'The operator pack',
];

/** The text of a section: from its heading to the next heading of its level. */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}
/** The fenced blocks of a text, each one as written, with the indent of a list item taken off. */
function blocksOf(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] | null = null;
  let indent = 0;
  for (const line of text.split('\n')) {
    const fence = /^(\s*)```/.exec(line);
    if (fence !== null) {
      if (current === null) {
        current = [];
        indent = fence[1].length;
      } else {
        blocks.push(current.join('\n'));
        current = null;
      }
    } else if (current !== null) {
      current.push(line.slice(Math.min(indent, line.length - line.trimStart().length)));
    }
  }
  return blocks;
}
/** The one fenced block of a section that holds a part. A section with no such block, or with two, stops the test. */
function blockWith(section: string, part: string): string {
  const found = blocksOf(section).filter((block) => block.includes(part));
  expect(found, `one block holds: ${part}`).toHaveLength(1);
  return found[0];
}
/** Every distinct match of a pattern in a text. */
const matchesOf = (text: string, pattern: RegExp): string[] => [...new Set([...text.matchAll(pattern)].map((hit) => hit[0]))];

/** True when a name stands in the text as a whole name: not inside a longer name, and not before a dot and a letter. A scan with `indexOf`: no pattern is built from the name. */
function mentions(text: string, name: string): boolean {
  for (let from = text.indexOf(name); from >= 0; from = text.indexOf(name, from + 1)) {
    const before = text[from - 1] ?? ' ';
    const after = text[from + name.length] ?? ' ';
    const next = text[from + name.length + 1] ?? ' ';
    if (!/[\w.-]/.test(before) && !/[\w-]/.test(after) && !(after === '.' && /[A-Za-z0-9]/.test(next))) return true;
  }
  return false;
}

const COMPOSE_FILE_NAMES = BIDS.map((bid) => bid.composeFile);
const ENV_FILE_NAMES = BIDS.map((bid) => bid.envFile);
const NAMED_FILES = [...COMPOSE_FILE_NAMES, ...ENV_FILE_NAMES, FILES.example, FILES.snippet, FILES.runbook, 'RUNBOOK.md', 'README.md'];
/** The forms of `-f` that a command of the runbook may use: the file of a Bid Desk, the placeholder of its name, and the variable of a loop. */
const COMPOSE_FILE_FORMS = [...COMPOSE_FILE_NAMES, 'docker-compose.bid-desk-<name>.yml', 'docker-compose.bid-desk-$name.yml'];
const SERVICE_NAMES = [RUNTIME_NAME, SERVICE_NAME];
const LOOPBACK_PORTS = BIDS.flatMap((bid) => [bid.runtimeHostPort, bid.serviceHostPort]);
const CONTAINERS = BIDS.flatMap((bid) => [bid.runtimeContainer, bid.serviceContainer]);
const HOSTS = BIDS.map((bid) => bid.host);
const HEX_RUN = /[0-9a-fA-F]{56,}/g;
const PUBLISHED_RUNS = new Set(Object.values(PUBLISHED).flatMap((value) => value.match(/[0-9a-f]{56,}/g) ?? []));

/** What is wrong with a file of the pack as to key material: a run of hex digits that is not a published value (it could be a key), and the value of a key variable that is written out. */
function keyProblems(text: string, allowed: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  if ((text.match(HEX_RUN) ?? []).some((run) => !allowed.has(run))) problems.push('the text has a run of hex digits that is not a published value: it could be a key');
  if (/PRIV_KEY_HEX=[0-9a-fA-F]{8,}/.test(text)) problems.push('the text writes the value of a key');
  return problems;
}

/** One line that waits, checks the status of the same Bid Desk, and recreates its containers. */
const GUARDED = /^sleep 120; if curl -s --max-time 5 http:\/\/127\.0\.0\.1:(\d{4})\/status \| grep -q '"status":"free"'; then docker compose -f docker-compose\.bid-desk-([a-z]+)\.yml up -d --no-deps --force-recreate (?:service|runtime|service runtime); else echo '[^']+'; fi$/;

/** What is wrong with the runbook. An empty list is a pass. */
function runbookProblems(text: string): string[] {
  const problems: string[] = [];
  if (!text.startsWith('# Runbook: the three Bid Desks on the agents host\n')) problems.push('the title must be "Runbook: the three Bid Desks on the agents host"');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((hit) => hit[1]);
  if (!same(headings, SECTIONS)) problems.push(`the sections must be, in this order: ${SECTIONS.join(', ')}; found: ${headings.join(', ')}`);
  for (const name of matchesOf(text, /(?<![\w.-])(?:docker-compose\.[a-z0-9-]+\.yml|Caddyfile\.[a-z0-9-]+\.snippet|RUNBOOK(?:-[a-z0-9-]+)?\.md|README\.md|\.env\.[A-Za-z0-9._-]*[A-Za-z0-9](?![\w$<-]))/g)) {
    if (!NAMED_FILES.includes(name)) problems.push(`the runbook names ${name}, which is no file of this pack`);
  }
  for (const name of [...COMPOSE_FILE_NAMES, ...ENV_FILE_NAMES, FILES.example, FILES.snippet, FILES.runbook]) if (!mentions(text, name)) problems.push(`the runbook never names ${name}`);
  const code = blocksOf(text).flatMap((block) => block.split('\n').map((line) => line.trim()));
  for (const line of code) {
    const compose = /\bdocker compose\b.*/.exec(line)?.[0];
    if (compose === undefined) continue;
    const file = /(?:^|\s)-f (\S+)/.exec(compose)?.[1]?.replaceAll('"', '');
    if (file === undefined || !COMPOSE_FILE_FORMS.includes(file)) problems.push(`a docker compose command names no -f file of this pack: ${compose}`);
    const verb = /-f \S+ (up|stop|start|logs|ps|rm|config|down|pull)\b([^|)&;]*)/.exec(compose);
    for (const token of (verb?.[2] ?? '').split(/\s+/).filter((part) => part !== '' && !part.startsWith('-'))) {
      if (!SERVICE_NAMES.includes(token)) problems.push(`a docker compose command names the service ${token}, which is no service of this pack`);
    }
    if (/\bconfig\b/.test(compose) && !/--quiet|-q\b/.test(compose) && !/cd "\$scratch[^"]*" &&/.test(line)) problems.push('docker compose config prints the environment: run it with --quiet, or in the scratch folder with the stand-in files');
  }
  for (const port of matchesOf(text, /(?:127\.0\.0\.1|localhost):\d+/g)) if (!LOOPBACK_PORTS.includes(Number(port.split(':')[1]))) problems.push(`the runbook names the loopback port ${port}, which is no port of this pack`);
  const numbers = matchesOf(text, /\b\d{4}\b/g);
  for (const port of LOOPBACK_PORTS) if (!numbers.includes(String(port))) problems.push(`the runbook never names the port ${port}`);
  for (const name of matchesOf(text, /(?<![\w./-])bids-[a-z]+-[a-z]+(?![\w-])/g)) if (!CONTAINERS.includes(name)) problems.push(`the runbook names ${name}, which is no container of this pack`);
  for (const name of CONTAINERS) if (!text.includes(name)) problems.push(`the runbook never names the container ${name}`);
  for (const name of matchesOf(text, /(?<![\w./-])(?:reorder|orders|intake|priorauth|sourcing)-(?:runtime|service|state)(?![\w-])/g)) problems.push(`the runbook names ${name}, which is a name of another pack`);
  for (const name of matchesOf(text, /mp-suppliers-[a-z-]+\.vector\.apexfusion\.org/g)) if (!HOSTS.includes(name)) problems.push(`the runbook names the host ${name}, which is no host of this pack`);
  for (const host of HOSTS) if (!mentions(text, host)) problems.push(`the runbook never names the host ${host}`);
  const commands = code.join('\n');
  if (/\bdocker (?:build|run)\b|--build\b|\bdocker compose[^\n]* (?:build|run)\b/.test(commands)) problems.push('the host builds no image and starts no container outside compose');
  if (/\bdown\b[^\n]*(?:\s-v\b|--volumes)/.test(commands)) problems.push('down never takes -v: the volume holds the book of the requests and the record of the model hires');
  if (/\bsetup\.sh\b/.test(text)) problems.push('the folders are made with install -d: the set-up script refuses on a host that already runs agents');
  // A restart waits 2 minutes first, then checks that the runtime of its own Bid Desk says free, then runs its command at once, all in one line. A check before the wait leaves a gap in which a job can start and be cut.
  for (const line of code) {
    if (!/--force-recreate|\bdocker (?:restart|stop)\b|\bcompose restart\b/.test(line)) continue;
    const hit = GUARDED.exec(line);
    const bid = BIDS.find((b) => b.name === hit?.[2]);
    if (hit === null || bid === undefined || String(bid.runtimeHostPort) !== hit[1]) problems.push(`a restart waits 2 minutes, then checks that the runtime of its own Bid Desk says free, then runs its command at once, in one line: ${line}`);
  }
  const printing = [/\bcat\s+\S*\.env/, /\bprintenv\b/, /\bdocker inspect\b/, /\bdocker exec\b[^\n]*\b(?:env|printenv)\b/, /\becho\s+"?\$\{?[A-Z_]*PRIV_KEY/];
  for (const pattern of printing) if (code.some((line) => pattern.test(line))) problems.push(`a command prints an env file or an environment: ${pattern.source}`);
  problems.push(...keyProblems(text).map((problem) => `the runbook: ${problem}`));
  return problems;
}

/** The folders that the tests of the commands make: each test removes its own at the end of the file. */
const folders: string[] = [];
/** What a shell script of the runbook does in a new folder: the folder, what it printed, and its status. The files are made first, with their folders. The commands name /srv/agents, and the run names its own folder in its place. A stub is a program that stands in front of the real one in the PATH. */
function runInFolder(script: string, files: Readonly<Record<string, string>>, stubs: Readonly<Record<string, string>> = {}): { readonly dir: string; readonly out: string; readonly err: string; readonly status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'bid-desk-deploy-'));
  folders.push(dir);
  mkdirSync(join(dir, 'bin'));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  for (const [name, content] of Object.entries(stubs)) {
    writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${content}\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const run = spawnSync('bash', ['-c', script.split('/srv/agents').join(join(dir, 'agents'))], { cwd: dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir }, encoding: 'utf8' });
  return { dir, out: run.stdout, err: run.stderr, status: run.status };
}
const LINUX = process.platform === 'linux';

/** What the service of the pack refuses at its start, each with the words of the refusal, as the real code says them, and the change of the environment that makes the code say them. */
const REFUSALS: ReadonlyArray<readonly [words: string, change: Readonly<Record<string, string | undefined>>]> = [
  ['BID_DESK_SERVICE_PRIV_KEY_HEX is required', { BID_DESK_SERVICE_PRIV_KEY_HEX: '' }],
  ['must be 64 lowercase hex characters', { BID_DESK_SERVICE_PRIV_KEY_HEX: 'ab' }],
  ['BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key', { SUPPLIER_PKH: SERVICE_KEY.pkh, SUPPLIER_PUB_KEY_HEX: SERVICE_KEY.pubKeyHex }],
  ['which belongs in BID_DESK_SERVICE_PRIV_KEY_HEX alone', { AGENT_VERSION: SERVICE_KEY.privateKeyHex }],
  ['holds the service token, which belongs in SERVICE_AUTH_HEADER alone', { AGENT_VERSION: TOKEN }],
  ['BID_DESK_SERVICE_PKH (56 characters) is not the key hash of the key in BID_DESK_SERVICE_PRIV_KEY_HEX', { BID_DESK_SERVICE_PKH: 'cd'.repeat(28) }],
  ['SERVICE_AUTH_HEADER is required', { SERVICE_AUTH_HEADER: '' }],
  ['must be printable ASCII', { SERVICE_AUTH_HEADER: 'Bearer \u00e9' }],
  ['SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH', { SUPPLIER_PUB_KEY_HEX: HEX }],
  ['AGENT_DID is required', { AGENT_DID: '' }],
  ['must be did:vector: and 64 lowercase hex characters', { AGENT_DID: 'did:vector:abc' }],
  ['BID_DESK_INSTANCE must be alfa, bravo or charlie', { BID_DESK_INSTANCE: 'delta' }],
  ['BID_DESK_ORGANISATION must be a domain name in lower case', { BID_DESK_ORGANISATION: 'Alfa' }],
  ['BID_DESK_PUBLIC_ORIGIN must be an https origin', { BID_DESK_PUBLIC_ORIGIN: 'http://bids.example.test' }],
  ['IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give', { IDENTITY_POLICY_ID: '0'.repeat(56) }],
  ['CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249', { CHECKS_READ_BUDGET_MS: '2250' }],
  ['FAULT_MODE must be empty or "quote_off_price_list"', { FAULT_MODE: 'invert_scores' }],
  ['ADVERT_MAX_PROCESSING_MS must be at least 480000', { ADVERT_MAX_PROCESSING_MS: '1000' }],
  ['LLM_MODEL_ALLOWLIST is required', { LLM_MODEL_ALLOWLIST: '' }],
  ['must be a whole number of lovelace', { LLM_MAX_SUPPLIER_BOND_LOVELACE: 'abc' }],
];

describe('deploy/server/RUNBOOK-bid-desk.md', () => {
  test('the real runbook passes: the sections in order, the files, the commands and the numbers of the pack', () => {
    expect(runbookProblems(runbookText)).toStrictEqual([]);
    expect([...runbookText.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(SECTIONS);
  });

  test('the table of the first section gives each Bid Desk its containers, ports, host name, folder, volume and organisation, and the second table gives its advert model, price, bonds and lock, as the code has them', () => {
    const what = sectionOf(runbookText, 'What it is');
    for (const bid of BIDS) {
      const row = what.split('\n').find((line) => line.startsWith('|') && line.includes(bid.runtimeContainer));
      expect(row, `a row for ${bid.name}`).toBeDefined();
      const cells = row!.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
      expect(cells, bid.name).toStrictEqual([bid.name, bid.runtimeContainer, bid.serviceContainer, String(bid.runtimeHostPort), String(bid.serviceHostPort), bid.host, bid.folder, bid.volume, bid.organisation]);
      const terms = what.split('\n').find((line) => line.startsWith(`| \`${bid.name}\` | \`${BID_DESK_MODEL}\``));
      expect(terms, `a row of terms for ${bid.name}`).toBeDefined();
      const price = PRICE_LOVELACE / 1_000_000;
      const bond = BOND_LOVELACE / 1_000_000;
      expect(terms!.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', '')), bid.name).toStrictEqual([bid.name, BID_DESK_MODEL, String(price), `${bond} and ${bond}`, String(price + 2 * bond)]);
    }
    expect(BID_DESK_MODEL).toBe('bid-desk-v1');
    expect(what).toContain(BID_CAPABILITIES.quote);
    for (const ms of [MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]) expect(what, String(ms)).toContain(ms.toLocaleString('en-US'));
    for (const part of ['use case 3 (supplier bid evaluation)', 'Sourcing Agent', 'do not compete', 'no two of them share a job slot', 'one image of the service and one image of the runtime', 'The container port is the same in the three Bid Desks, on purpose: 8080 for a runtime and 9106 for a service',
      'no compose file sets `PORT` for a service', 'The lock of an advert is its price plus both bonds', 'The key variable names carry no name of a Bid Desk', 'BID_DESK_SERVICE_PRIV_KEY_HEX', 'SUPPLIER_PRIV_KEY_HEX', 'SERVICE_PRECHECK_URL',
      'a runtime with no check claims every escrow', 'stays `proposed` until the first live run', 'The operator pack']) expect(what, part).toContain(part);
  });

  test('the files named in the second section are the files of the pack, and it lists all of them', () => {
    const files = sectionOf(runbookText, 'The files');
    for (const name of [...COMPOSE_FILE_NAMES, ...ENV_FILE_NAMES, FILES.example, FILES.snippet, FILES.runbook]) expect(files, name).toContain(`\`${name}\``);
    for (const name of [...COMPOSE_FILE_NAMES, FILES.example, FILES.snippet, FILES.runbook]) expect(existsSync(join(root, 'deploy', 'server', name)), `${name} is a file of deploy/server`).toBe(true);
    for (const name of ENV_FILE_NAMES) expect(existsSync(join(root, 'deploy', 'server', name)), `${name} is made on the host and never enters git`).toBe(false);
  });

  test('the memory gate is 1,024 MiB of MemAvailable before each of the six starts, and a start that would fail it is not made and is reported; the folders are made with install -d, owned by the service user with mode 750', () => {
    const gate = sectionOf(runbookText, 'The memory gate');
    for (const part of ['MemAvailable', '1,024 MiB', '/proc/meminfo', 'six starts', 'make no start, and report the figure', 'Start no container while it prints `stop`']) expect(gate, part).toContain(part);
    const folder = sectionOf(runbookText, 'The folders');
    for (const bid of BIDS) for (const part of [`sudo install -d -m 750 -o agents -g agents ${bid.folder}`, `sudo install -m 644 -o agents -g agents ${bid.composeFile} ${FILES.example} ${bid.folder}/`]) expect(folder, part).toContain(part);
    for (const part of ['750', 'agents', 'Make them with `install -d`', 'agents-server']) expect(folder, part).toContain(part);
    expect(runbookText, 'the set-up script refuses on a host that already runs agents').not.toContain('setup.sh');
    const dns = sectionOf(runbookText, 'The DNS records');
    expect(dns).toContain('DNS only');
    for (const bid of BIDS) expect(dns, bid.host).toContain(bid.host);
  });

  test('the env files are made with mode 600, one for each Bid Desk, with six keys that are all different and a token for each file; the keys are never typed or printed, and the checks print names and lengths only', () => {
    const files = sectionOf(runbookText, 'The env files');
    for (const part of ['600', 'umask 077', ...ENV_FILE_NAMES, 'SERVICE_AUTH_HEADER', 'SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', ...KEY_VARIABLES, 'BID_DESK_SERVICE_PKH', 'ADVERT_REF', 'AGENT_ID', 'AGENT_DID',
      'OPERATOR_CONTACT', 'operator pack', 'never typed in a shell', 'six keys, and all six are different', 'No two Bid Desks share a key, a wallet or a token', 'FAULT_MODE', 'the three lines that name its Bid Desk']) expect(files, part).toContain(part);
    expect(files).toMatch(/one pure output, alone, as collateral/);
    expect(files).toMatch(/two wallets/);
    expect(files).toMatch(/a new token for each file/);
    expect(files, 'the example is copied to three files').toContain('for name in alfa bravo charlie; do cp ');
  });

  test('both images are pulled by the tag of the reviewed commit and pinned by digest, and the three Bid Desks get one digest of each image', () => {
    const images = sectionOf(runbookText, 'The images');
    for (const part of [SERVICE_IMAGE, RUNTIME_IMAGE, '<full git commit sha>', 'sha256', 'denied', 'read:packages', 'for image in bid-desk agent-runtime', 'one digest', '<digest>', 'six `image:` lines']) expect(images, part).toContain(part);
    for (const bid of BIDS) expect(images, bid.composeFile).toContain(bid.composeFile);
  });

  test('the compose files are rendered with stand-in files, never with the real env files that hold keys, and the images are checked for a placeholder', () => {
    const check = sectionOf(runbookText, 'Check the compose files');
    for (const part of ['scratch', '--quiet', FILES.example, 'config', "grep -c '@sha256:<digest>'", ...BIDS.flatMap((bid) => [String(bid.runtimeHostPort), String(bid.serviceHostPort)]), 'target: /data', 'host_ip: 127.0.0.1']) expect(check, part).toContain(part);
    for (const bid of BIDS) expect(check, bid.name).toContain(`\`${bid.name}\``);
  });

  test('a price list is a file of the image, its hash is in the manifest and so in the advert, and a new list is a new image and a new advert', () => {
    const lists = sectionOf(runbookText, 'The price lists');
    for (const part of ['price-lists/alfa.json', 'price-lists/bravo.json', 'price-lists/charlie.json', PRICE_LIST_ROUTE, 'is in the image', 'SHA-256', 'A new price list is a new image', 'a new advert', 'price_list.sha256', 'sha256sum', 'Nobody changes a price list on the host']) expect(lists, part).toContain(part);
    for (const bid of BIDS) expect(lists, bid.host).toContain(bid.host);
    for (const bid of BIDS) expect(existsSync(join(root, 'agents', 'bid-desk', 'price-lists', `${bid.name}.json`)), `the price list of ${bid.name}`).toBe(true);
  });

  test('the three adverts have three hashes and the terms of the code: the capability, the model, the price, the bonds, the lock and the window; each reference goes into the env file of its own Bid Desk', () => {
    const adverts = sectionOf(runbookText, 'The adverts');
    for (const part of [BID_CAPABILITIES.quote, BID_DESK_MODEL, 'three hashes', 'detail_hash', 'detail_uri', 'endpoint_url', 'ADVERT_REF', 'advert_not_active', 'up -d --no-deps --force-recreate runtime', 'so the lock is 3 units', '480,000 ms',
      'never with the hash of another', 'its own manifest', 'AGENT_ID', 'needs retirement and a new advert for that desk', 'confirm retirement of the old advert before you post again']) expect(adverts, part).toContain(part);
    expect(adverts).toContain(`the price ${PRICE_LOVELACE / 1_000_000} unit, with a supplier bond of ${BOND_LOVELACE / 1_000_000} unit and a buyer bond of ${BOND_LOVELACE / 1_000_000} unit`);
  });

  test('the start order is, for each Bid Desk in turn: the service, then the Caddy block and the public checks, then the advert, then the runtime, each start after the memory gate and the runtime without its dependencies', () => {
    const start = sectionOf(runbookText, 'The start order');
    const at = (part: string): number => start.indexOf(part);
    const order = [`up -d ${SERVICE_NAME}`, 'The Caddy block', 'Post the advert of this Bid Desk', 'up -d --no-deps runtime'];
    for (const part of order) expect(at(part), part).toBeGreaterThanOrEqual(0);
    expect(order.map(at)).toStrictEqual([...order.map(at)].sort((a, b) => a - b));
    for (const part of ['The memory gate', '`alfa` first, then `bravo`, then `charlie`', 'Finish the steps for one Bid Desk before you start the next', 'bid-desk-<name>_default', 'bid-desk-<name>-state', 'listening on 0.0.0.0:9106', 'state directory /data', 'ADVERT_REF',
      'The option `--no-deps` keeps compose from touching the service', 'The adverts']) expect(start, part).toContain(part);
  });

  test('the checks cover the six loopback ports, the public ports of the pack, the three hashes, the price lists, the card of each runtime, the check before the Claim and the blank keys', () => {
    const checks = sectionOf(runbookText, 'The checks');
    for (const part of ['/healthz', '/status', 'free', 'manifest-hash.mjs', '/.well-known/agent-card.json', "name='^bids-'", 'docker stats', 'blank', 'hook set', 'NO HOOK', '401', '/precheck', 'sort -u | wc -l', 'prints `3`']) expect(checks, part).toContain(part);
    for (const bid of BIDS) for (const part of [bid.host, String(bid.runtimeHostPort), String(bid.serviceHostPort), bid.runtimeContainer, bid.serviceContainer]) expect(checks, `${bid.name} ${part}`).toContain(part);
    const blank = blockWith(checks, 'docker exec "bids-$name-runtime"');
    for (const name of KEY_VARIABLES) expect(blank, `the check of the runtimes names ${name}`).toContain(`$${name}`);
    expect(blank, 'the check of the services names the supplier key').toContain('docker exec "bids-$name-service" sh -c \'test -z "$SUPPLIER_PRIV_KEY_HEX"');
    expect(blank, 'the check of the hook of each runtime prints no value').toContain('test -n "$SERVICE_PRECHECK_URL" && echo hook set || echo NO HOOK');
  });

  test('the Caddy section gives the join of the network, the markers of each Bid Desk, the in-place append, the validation, the reload and the way back, and never a restart of Caddy', () => {
    const caddy = sectionOf(runbookText, 'The Caddy block');
    for (const part of ['docker network connect bid-desk-<name>_default <caddy container>', '<caddyfile>', 'caddy validate', 'caddy reload', FILES.snippet, 'inode', 'DNS only', 'Only this way works for this pack', 'container names', 'lists the runtime only after',
      'One pair of markers belongs to each Bid Desk', 'and the other two blocks stay', 'work on one Bid Desk at a time', '# bid-desk-<name> vhosts (BEGIN)', '# bid-desk-<name> vhosts (END)']) expect(caddy, part).toContain(part);
    for (const bid of BIDS) for (const part of [bid.begin, bid.end]) expect(caddy, part).toContain(part);
    expect(caddy).not.toMatch(/caddy restart|docker restart <caddy/);
    expect(caddy).not.toMatch(/\bsed -i\b[^\n]*<caddyfile>/);
  });

  test('the restart rule waits first, then checks that the runtime of the Bid Desk says free, then runs the command at once, for one Bid Desk and no other; it names every action that is a restart', () => {
    const rule = sectionOf(runbookText, 'The restart rule');
    for (const part of ['/status', 'free', 'working', 'docker restart', 'docker compose restart', '--force-recreate', '120', '300', '330', 'SERVICE_AUTH_HEADER', '2 minutes', 'at once', 'Never check first and then wait', 'The Bid Desks share no job slot',
      'asks nothing of the other two', 'service runtime', 'one Bid Desk after the other']) expect(rule, part).toContain(part);
    expect(rule).toMatch(/reload/);
    const at = (part: string): number => rule.indexOf(part);
    const steps = ['1. Wait 2 minutes', '2. Check that the runtime of this Bid Desk says `free`', '3. Run the `up` command at once'];
    expect(steps.map(at).every((position) => position >= 0), 'the three steps').toBe(true);
    expect(steps.map(at)).toStrictEqual([...steps.map(at)].sort((a, b) => a - b));
    const blocks = blocksOf(rule).filter((block) => block.includes('sleep 120'));
    expect(blocks, 'one command for each Bid Desk').toHaveLength(3);
    for (const bid of BIDS) {
      const own = blocks.filter((block) => block.includes(`:${bid.runtimeHostPort}/status`));
      expect(own, `${bid.name}: one command`).toHaveLength(1);
      expect(own[0].startsWith('sleep 120; if curl'), `${bid.name}: the wait comes first`).toBe(true);
      expect(own[0].indexOf('sleep 120')).toBeLessThan(own[0].indexOf('/status'));
      expect(own[0].indexOf('/status')).toBeLessThan(own[0].indexOf('up -d --no-deps --force-recreate'));
      expect(own[0], `${bid.name}: the command runs only when the runtime says free, for its own compose file`).toContain(`grep -q '"status":"free"'; then docker compose -f ${bid.composeFile} up -d`);
      expect(rule, `${bid.name}: the folder of the command`).toContain(bid.folder);
    }
  });

  test('the fault switch section gives the one value of the agent, says that it is for a failure run of one Bid Desk only, that an env change needs a new container, that the switch is read from the running containers, and that the result and the evidence carry the value', () => {
    const fault = sectionOf(runbookText, 'The fault switch');
    const value = FAULT_MODES['bid-desk'][0];
    expect(value).toBe('quote_off_price_list');
    for (const part of ['FAULT_MODE', value, 'failure run only, and for one Bid Desk', 'The switch of one Bid Desk never changes another', 'An env change needs a new container', 'from the running containers, never from the file', 'fault_mode', 'evidence', 'The restart rule',
      'FAULT_MODE=[]', `FAULT_MODE=[${value}]`, 'in no other', 'and only that one', 'checks that the runtime of that Bid Desk says `free`', 'Never do it during a run', 'The runtime does not read the switch', 'the manifest and its hash are the same']) {
      expect(fault, part).toContain(part);
    }
    expect(blocksOf(fault)).toHaveLength(2);
    expect(runbookText.indexOf('\n## The fault switch\n')).toBeGreaterThan(runbookText.indexOf('\n## The restart rule\n'));
    expect(runbookText.indexOf('\n## The fault switch\n')).toBeLessThan(runbookText.indexOf('\n## The failure table\n'));
  });

  test('the failure table names every refusal code of the hook and of the job, the codes of the runtime for the hook, and the start refusals, with the status that the code gives', () => {
    const table = sectionOf(runbookText, 'The failure table');
    const codes = new Set<string>([
      ...COUNTERPARTY_REFUSALS['bid-desk'], ...Object.keys(QUOTE_REFUSAL_STATUS), 'busy', 'unauthorized', 'shutting_down', 'bad_context', 'bad_wire', 'request_too_large', 'bad_shape', 'check_unavailable', 'supplier_busy', 'precheck_failed',
      'precheck_timeout', 'precheck_unreachable', 'precheck_bad_status', 'advert_not_active',
    ]);
    expect(codes.size).toBeGreaterThan(25);
    for (const code of codes) expect(table, code).toContain(`\`${code}\``);
    for (const part of ['cannot start', 'invalid reference format', 'denied', '502', 'unhealthy', ...KEY_VARIABLES, 'BID_DESK_STATE_DIR names /data, which cannot be written', 'loadConfig: missing required env var ADVERT_REF', 'loadConfig: PUBLIC_ORIGIN must be an https origin',
      ...BIDS.flatMap((bid) => [String(bid.runtimeHostPort), String(bid.serviceHostPort)]), 'bid-desk-<name>_default', 'rfq-book.json', 'a new request with a new `rfq_id`']) expect(table, part).toContain(part);
    const rows = table.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Symptom'));
    expect(rows.length).toBeGreaterThan(40);
    for (const row of rows) expect(row.split('|').length, row).toBe(5);
    // A status in the first cell is the status that the code gives. The runtime codes are those of the template runtime, and `bad_context` is the answer of the server of the service kit.
    const statusOf: Readonly<Record<string, number>> = { ...ERROR_STATUS, precheck_timeout: 503, precheck_unreachable: 503, precheck_failed: 503, precheck_bad_status: 502, supplier_busy: 409, bad_context: 400, advert_not_active: 503 };
    let checked = 0;
    for (const row of rows) {
      const symptom = row.split('|')[1];
      const status = /\((\d{3})\b/.exec(symptom)?.[1];
      if (status === undefined) continue;
      for (const hit of symptom.matchAll(/`([a-z]+(?:_[a-z]+)*)`/g)) {
        expect(statusOf[hit[1]], `${hit[1]} in: ${symptom}`).toBe(Number(status));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(18);
    for (const [code, status] of Object.entries(QUOTE_REFUSAL_STATUS)) expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS], `${code} has the status of the protocol`).toBe(status);
  });

  test('each start refusal in the table is said by the real start code in these words, and the table has the words', async () => {
    const table = sectionOf(runbookText, 'The failure table');
    const base = { ...filled(exampleEnv), ...containerEnv(BIDS[1], SERVICE_NAME) };
    expect(loadConfig(base), 'the unchanged environment starts').toBeDefined();
    for (const [words, change] of REFUSALS) {
      expect(table, `the table has: ${words}`).toContain(words);
      expect(message(() => loadConfig({ ...base, ...change })), `the code says: ${words}`).toContain(words);
    }
    // A state folder that cannot be written stops the start before the node is asked for anything.
    const refused = await startService({ ...base, BID_DESK_STATE_DIR: '/proc/no-such-folder' }).then(() => 'started', (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(refused.split('/proc/no-such-folder').join('/data')).toContain('environment variable BID_DESK_STATE_DIR names /data, which cannot be written');
    // The messages of the template runtime stand in the runbooks of the other packs too.
    const reorder = readPack('RUNBOOK-reorder-agent.md');
    for (const words of ['loadConfig: missing required env var ADVERT_REF', 'loadConfig: PUBLIC_ORIGIN must be an https origin']) {
      expect(table, words).toContain(words);
      expect(reorder, words).toContain(words);
    }
  });

  test('both rollback paths follow advert retirement and the shared ledger check', () => {
    const out = sectionOf(runbookText, 'Back out');
    const running = blockWith(out, '/status');
    const order = [
      '`vector_build_marketplace_advert_retire`', '`vector_await_transaction`',
      'RUNBOOK.md#check-the-ledger-before-a-use-case-3-stop', running.split('\n')[0],
      '`docker compose -f docker-compose.bid-desk-<name>.yml stop service`',
      'docker network disconnect', 'docker compose -f docker-compose.bid-desk-<name>.yml down',
    ].map((part) => out.indexOf(part));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(blocksOf(runbookText).filter((block) => /\bdocker compose\b[^\n]* stop\b/.test(block))).toStrictEqual([running]);
    for (const part of ['bid-desk-<name>-state', 'rfq-book.json']) expect(out).toContain(part);
  });

  test('the operator claim task uses the separate service key of each Bid Desk', () => {
    const note = sectionOf(runbookText, 'The operator pack');
    for (const part of [
      '`claim` task of the operator pack supports one Module-1 claim for each Bid Desk',
      'before each clean or failure run', 'signs with the service key of that Bid Desk',
      `${CLAIM_STAKE_LOVELACE / 1_000_000n} units (${CLAIM_STAKE_LOVELACE.toLocaleString('en-US')} lovelace)`,
      `challenge window is ${CLAIM_WINDOW_MS / 3_600_000} hours`, '`claim cleanup` withdraws the claim if nobody challenged it',
      'the claim document transaction and then the stake transaction, one Bid Desk at a time',
      'The service has no claim code and no dispute code', 'Sourcing Agent', 'It never makes a stake, a claim or a record', 'behaviour.claim',
    ]) expect(note).toContain(part);
    expect(USE_CASE_NAMES).toContain('bid-evaluation');
  });

  const faults: readonly Fault[] = [
    ['a title of another pack', (t) => swap(t, '# Runbook: the three Bid Desks on the agents host\n', '# Runbook: the Order Desk on the agents host\n'), 'the title must be'],
    ['a section missing', (t) => swap(t, '\n## The restart rule\n', '\n## Another heading\n'), 'the sections must be, in this order'],
    ['the price lists missing', (t) => swap(t, '\n## The price lists\n', '\n## Another heading\n'), 'the sections must be, in this order'],
    ['the operator pack missing', (t) => swap(t, '\n## The operator pack\n', '\n## Another heading\n'), 'the sections must be, in this order'],
    ['the sections in another order', (t) => exchange(t, '\n## The checks\n', '\n## The Caddy block\n'), 'the sections must be, in this order'],
    ['the fault switch before the restart rule', (t) => exchange(t, '\n## The restart rule\n', '\n## The fault switch\n'), 'the sections must be, in this order'],
    ['a file of another pack', (t) => `${t}\nSee docker-compose.order-desk.yml.\n`, 'the runbook names docker-compose.order-desk.yml, which is no file of this pack'],
    ['a compose file of a fourth Bid Desk', (t) => `${t}\nSee docker-compose.bid-desk-delta.yml.\n`, 'the runbook names docker-compose.bid-desk-delta.yml, which is no file of this pack'],
    ['the runbook of another pack', (t) => `${t}\nSee RUNBOOK-order-desk.md.\n`, 'the runbook names RUNBOOK-order-desk.md, which is no file of this pack'],
    ['an env file of another agent', (t) => `${t}\nRead .env.order-desk.\n`, 'the runbook names .env.order-desk, which is no file of this pack'],
    ['an env file of a fourth Bid Desk', (t) => `${t}\nRead .env.bid-desk-delta.\n`, 'the runbook names .env.bid-desk-delta, which is no file of this pack'],
    ['a compose command without the file', (t) => `${t}\n\`\`\`sh\ndocker compose up -d service\n\`\`\`\n`, 'a docker compose command names no -f file of this pack'],
    ['a compose command with the file of another pack', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.reorder-agent.yml up -d service\n\`\`\`\n`, 'a docker compose command names no -f file of this pack'],
    ['a service that the pack does not have', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.bid-desk-alfa.yml up -d runtime-huge\n\`\`\`\n`, 'a docker compose command names the service runtime-huge'],
    ['a compose config that prints the environment', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.bid-desk-alfa.yml config\n\`\`\`\n`, 'docker compose config prints the environment'],
    ['a port of another pack', (t) => `${t}\ncurl http://127.0.0.1:8101/healthz\n`, 'the runbook names the loopback port 127.0.0.1:8101'],
    ['the port of the Sourcing Agent', (t) => `${t}\ncurl http://127.0.0.1:8107/healthz\n`, 'the runbook names the loopback port 127.0.0.1:8107'],
    ['a container of this pack that does not exist', (t) => `${t}\ndocker logs bids-delta-service\n`, 'the runbook names bids-delta-service, which is no container of this pack'],
    ['a container of another pack', (t) => `${t}\ndocker logs orders-service\n`, 'the runbook names orders-service, which is a name of another pack'],
    ['the host of another pack', (t) => `${t}\nhttps://mp-suppliers-orders-small.vector.apexfusion.org\n`, 'the runbook names the host mp-suppliers-orders-small.vector.apexfusion.org'],
    ['a build on the host', (t) => `${t}\n\`\`\`sh\ndocker build -t x .\n\`\`\`\n`, 'the host builds no image'],
    ['a container started outside compose', (t) => `${t}\n\`\`\`sh\ndocker run --rm alpine true\n\`\`\`\n`, 'the host builds no image and starts no container outside compose'],
    ['a stop that removes the volume', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.bid-desk-alfa.yml down -v\n\`\`\`\n`, 'down never takes -v'],
    ['a command that prints an env file', (t) => `${t}\n\`\`\`sh\ncat .env.bid-desk-alfa\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that prints the environment of a container', (t) => `${t}\n\`\`\`sh\ndocker exec bids-alfa-service printenv\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that prints the environment with env', (t) => `${t}\n\`\`\`sh\ndocker exec bids-alfa-service env\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that inspects a container', (t) => `${t}\n\`\`\`sh\ndocker inspect bids-alfa-runtime\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a key', (t) => `${t}\nBID_DESK_SERVICE_PRIV_KEY_HEX=${HEX}\n`, 'the runbook: the text has a run of hex digits'],
    ['the folders made by the set-up script', (t) => `${t}\n\`\`\`sh\nsudo ./setup.sh bid-desk-alfa\n\`\`\`\n`, 'the folders are made with install -d'],
    ['a recreate with no wait and no check', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.bid-desk-alfa.yml up -d --no-deps --force-recreate service\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['a check, then a wait, then the command', (t) => `${t}\n\`\`\`sh\ncurl -s http://127.0.0.1:8108/status; sleep 120; docker compose -f docker-compose.bid-desk-alfa.yml up -d --no-deps --force-recreate service\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['a restart with docker restart', (t) => `${t}\n\`\`\`sh\ndocker restart bids-alfa-runtime\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['a restart that checks the runtime of another Bid Desk', (t) => swap(t, 'http://127.0.0.1:8109/status | grep -q \'"status":"free"\'; then docker compose -f docker-compose.bid-desk-bravo.yml up', 'http://127.0.0.1:8108/status | grep -q \'"status":"free"\'; then docker compose -f docker-compose.bid-desk-bravo.yml up'), 'a restart waits 2 minutes, then checks'],
    ['the check before the wait, in the line of the command', (t) => swap(t, 'sleep 120; if curl -s --max-time 5 http://127.0.0.1:8108/status | grep -q \'"status":"free"\'; then docker compose -f docker-compose.bid-desk-alfa.yml up -d', 'if curl -s --max-time 5 http://127.0.0.1:8108/status | grep -q \'"status":"free"\'; then sleep 120; docker compose -f docker-compose.bid-desk-alfa.yml up -d'), 'a restart waits 2 minutes, then checks'],
  ];
  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    for (const [what, change, expected] of faults) {
      const problems = runbookProblems(change(runbookText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('the twins: a command with --quiet, a command in the scratch folder, a start without dependencies, the placeholder of a name and a comment about a file of the pack are accepted', () => {
    const accepted = `${runbookText}\n\`\`\`sh\ndocker compose -f ${BIDS[0].composeFile} config --quiet\n(cd "$scratch/alfa" && docker compose -f ${BIDS[0].composeFile} config | grep image)\ndocker compose -f ${BIDS[2].composeFile} up -d --no-deps runtime\ndocker compose -f docker-compose.bid-desk-<name>.yml down\n\`\`\`\n`;
    expect(runbookProblems(accepted)).toStrictEqual([]);
    expect(runbookProblems(`${runbookText}\nThe file ${FILES.snippet} holds the blocks. See RUNBOOK.md and README.md.\n`)).toStrictEqual([]);
    expect(runbookProblems(`${runbookText}\nThe volume ${BIDS[1].volume} and the project ${BIDS[1].project} are names of this pack.\n`)).toStrictEqual([]);
  });

  test('a name stands in a text as a whole name only: a longer name and a name before a dot and a letter are not it', () => {
    expect(mentions('see .env.bid-desk-alfa here', BIDS[0].envFile)).toBe(true);
    expect(mentions('see .env.bid-desk-alfa.', BIDS[0].envFile)).toBe(true);
    expect(mentions('see .env.bid-desk-alfa.example', BIDS[0].envFile)).toBe(false);
    expect(mentions('see x.env.bid-desk-alfa', BIDS[0].envFile)).toBe(false);
    expect(mentions('see .env.bid-desk-alfa-huge', BIDS[0].envFile)).toBe(false);
    expect(mentions('see .env.bid-desk.example', FILES.example)).toBe(true);
  });

  // The commands of the runbook run as written, on Linux, in a new folder. A stand-in takes the place of docker. No command reads a real file, and none prints a key.
  describe.skipIf(!LINUX)('the shell commands of the runbook', () => {
    const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
    /** The lines that the operator fills in one env file, with values of their own for each Bid Desk. */
    const fill = (n: number): Readonly<Record<string, string>> => ({
      SUPPLIER_PRIV_KEY_HEX: hex(n), SUPPLIER_PUB_KEY_HEX: hex(n + 1), SUPPLIER_PKH: hex(n + 2).slice(0, 56), SUPPLIER_ADDRESS: `addr1${'q'.repeat(53)}`, BID_DESK_SERVICE_PRIV_KEY_HEX: hex(n + 3),
      SERVICE_AUTH_HEADER: `"Bearer ${hex(n + 4)}"`, OPERATOR_CONTACT: 'ops', AGENT_DID: `did:vector:${hex(n + 5)}`, AGENT_ID: hex(n + 5),
    });
    /** The example with every line that the operator fills, filled in. The first number gives the values of one Bid Desk. */
    const filledFile = (n: number, extra: Readonly<Record<string, string>> = {}): string => Object.entries({ ...fill(n), ...extra }).reduce((text, [name, value]) => withValue(text, name, value), exampleText);
    const envPath = (bid: Bid): string => `agents/bid-desk-${bid.name}/${bid.envFile}`;
    const envFiles = (make: (bid: Bid, at: number) => string): Record<string, string> => Object.fromEntries(BIDS.map((bid, at) => [envPath(bid), make(bid, at)]));

    test('the memory gate command prints ok or stop, and the MiB that are available', () => {
      const run = runInFolder(blockWith(sectionOf(runbookText, 'The memory gate'), '/proc/meminfo'), {});
      expect([run.status, run.err]).toStrictEqual([0, '']);
      expect(run.out).toMatch(/^(ok|stop) \d+ MiB available\n$/);
    });

    test('the token command writes a token of its own into each of the three files, in the form "Bearer" and 64 hex digits, prints nothing, and changes no other line', () => {
      const script = blockWith(sectionOf(runbookText, 'The env files'), 'SERVICE_AUTH_HEADER=\\"Bearer');
      const run = runInFolder(script, envFiles(() => exampleText));
      expect([run.status, run.out, run.err], 'the command prints nothing').toStrictEqual([0, '', '']);
      const tokens = BIDS.map((bid) => /^SERVICE_AUTH_HEADER=(.*)$/m.exec(readFileSync(join(run.dir, envPath(bid)), 'utf8'))![1]);
      for (const token of tokens) expect(token).toMatch(/^"Bearer [0-9a-f]{64}"$/);
      expect(new Set(tokens).size, 'three tokens, three different values').toBe(3);
      for (const bid of BIDS) expect(readFileSync(join(run.dir, envPath(bid)), 'utf8').replace(/^SERVICE_AUTH_HEADER=.*$/m, 'SERVICE_AUTH_HEADER=""'), `${bid.name}: no other line changed`).toBe(exampleText);
    });

    test('the example is copied to one env file for each Bid Desk, with mode 600 under the umask of the runbook', () => {
      const make = blockWith(sectionOf(runbookText, 'The env files'), 'umask 077');
      const script = make.split('\n').filter((line) => line !== 'sudo -u agents -H bash').join('\n');
      const run = runInFolder(script, Object.fromEntries(BIDS.map((bid) => [`agents/bid-desk-${bid.name}/${FILES.example}`, exampleText])));
      expect([run.status, run.err]).toStrictEqual([0, '']);
      for (const bid of BIDS) {
        expect(readFileSync(join(run.dir, envPath(bid)), 'utf8'), bid.name).toBe(exampleText);
        expect((statSync(join(run.dir, envPath(bid))).mode & 0o777).toString(8), `${bid.name}: mode`).toBe('600');
      }
    });

    test('the check commands of the env files print the placeholders and the empty lines of the example, nothing for files that are filled in, and the names and lengths that the runbook says', () => {
      const section = sectionOf(runbookText, 'The env files');
      const placeholders = blockWith(section, "grep -nE '^[A-Z0-9_]+=.*<[^>]*>'");
      const empty = blockWith(section, 'empty: $name');
      const lengths = blockWith(section, 'length($2)');
      const shared = blockWith(section, 'sort | uniq -d | wc -l');
      const twice = blockWith(section, 'SUPPLIER_PKH\\|BID_DESK_SERVICE_PKH');
      const required = /for key in ([A-Z0-9_ ]+); do/.exec(empty)![1].split(' ');
      expect(required).toStrictEqual(expect.arrayContaining([...SUPPLIER_LINES, ...KEY_VARIABLES, 'SERVICE_AUTH_HEADER', 'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_ID']));

      const raw = runInFolder([placeholders, empty, shared, twice].join('\n'), envFiles(() => exampleText));
      const lines = raw.out.split('\n').filter((line) => line !== '');
      const listed = lines.filter((line) => /:\d+:[A-Z_]+$/.test(line)).map((line) => line.replace(/^.*:\d+:/, ''));
      expect(listed, 'the placeholder of each example').toStrictEqual(['OPERATOR_CONTACT', 'OPERATOR_CONTACT', 'OPERATOR_CONTACT']);
      expect(lines.filter((line) => line.startsWith('empty: ')), 'the empty lines of each example').toStrictEqual(BIDS.flatMap((bid) => required.filter((key) => exampleEnv[key] === '').map((key) => `empty: ${bid.name} ${key}`)));
      expect(lines.filter((line) => !/:\d+:[A-Z_]+$/.test(line) && !line.startsWith('empty: ')), 'no value stands twice in the empty examples, so the count is 0').toStrictEqual(['0']);

      const done = runInFolder([placeholders, empty, shared, twice].join('\n'), envFiles((_, at) => filledFile(10 * (at + 1))));
      expect([done.status, done.out, done.err], 'nothing but the count is printed for files that are filled in').toStrictEqual([0, '0\n', '']);
      const measured = runInFolder(lengths, envFiles((_, at) => filledFile(10 * (at + 1))));
      expect(measured.out.split('\n').filter((line) => line !== '')).toStrictEqual(BIDS.map((bid) => `${bid.name}: SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 BID_DESK_SERVICE_PRIV_KEY_HEX=64 BID_DESK_SERVICE_PKH=0 AGENT_ID=64 ADVERT_REF=0 `));
      // Two Bid Desks that share a key or a token are counted, and two that share a key hash are listed. The count prints no value.
      const clash = runInFolder(shared, envFiles((bid, at) => filledFile(10 * (at + 1), bid.name === 'alfa' ? {} : { BID_DESK_SERVICE_PRIV_KEY_HEX: hex(99), SERVICE_AUTH_HEADER: `"Bearer ${hex(98)}"` })));
      expect(clash.out, 'two values stand twice: the key and the token').toBe('2\n');
      const pkh = hex(97).slice(0, 56);
      const hashes = runInFolder(twice, envFiles((bid, at) => filledFile(10 * (at + 1), bid.name === 'charlie' ? { SUPPLIER_PKH: pkh } : bid.name === 'bravo' ? { BID_DESK_SERVICE_PKH: pkh } : {})));
      expect(hashes.out, 'a key hash that stands twice').toBe(`${pkh}\n`);
    });

    test('the pin command puts the digest of each image in the three compose files, and each file then passes its guard; a digest that is not 64 characters changes nothing', () => {
      const script = swap(blockWith(sectionOf(runbookText, 'The images'), 'docker pull'), '<full git commit sha>', 'a1'.repeat(20));
      const files = Object.fromEntries(BIDS.map((bid) => [`agents/bid-desk-${bid.name}/${bid.composeFile}`, composeTexts[bid.name]]));
      const stub = (digest: string): string => `case "$1" in pull) ;; image) printf 'ghcr.io/example/image@sha256:${digest}\\n' ;; esac`;
      const pinned = runInFolder(script, files, { docker: stub('ab'.repeat(32)) });
      expect(pinned.status).toBe(0);
      const texts: Record<string, string> = {};
      for (const bid of BIDS) {
        texts[bid.name] = readFileSync(join(pinned.dir, `agents/bid-desk-${bid.name}/${bid.composeFile}`), 'utf8');
        expect(composeProblems(texts[bid.name], bid), bid.name).toStrictEqual([]);
        expect(texts[bid.name].match(/@sha256:[0-9a-f]{64}/g), bid.name).toHaveLength(2);
        expect(texts[bid.name].match(/@sha256:<digest>/g), `${bid.name}: no placeholder is left in an image`).toBeNull();
      }
      expect(packProblems(texts), 'the three pinned files are still one file').toStrictEqual([]);
      expect(pinned.out.split('\n').filter((line) => line.startsWith('    image: ')), 'six image lines').toHaveLength(6);
      const short = runInFolder(script, files, { docker: stub('abc') });
      expect(short.out).toContain('no digest for bid-desk: no compose file is changed');
      expect(short.out).toContain('no digest for agent-runtime: no compose file is changed');
      for (const bid of BIDS) expect(readFileSync(join(short.dir, `agents/bid-desk-${bid.name}/${bid.composeFile}`), 'utf8'), `${bid.name}: the file is not changed`).toBe(composeTexts[bid.name]);
    });

    test('the check of the placeholders prints the number of placeholders of each compose file: 2 before the pin and 0 after it', () => {
      const script = blockWith(sectionOf(runbookText, 'Check the compose files'), 'config --quiet');
      const stubs = { docker: 'exit 0' };
      const files = (text: (bid: Bid) => string): Record<string, string> => Object.fromEntries(BIDS.flatMap((bid) => [[`agents/bid-desk-${bid.name}/${bid.composeFile}`, text(bid)], [envPath(bid), exampleText]]));
      expect(runInFolder(script, files((bid) => composeTexts[bid.name]), stubs).out).toBe('2\n2\n2\n');
      expect(runInFolder(script, files((bid) => composeTexts[bid.name].split('@sha256:<digest>').join(`@sha256:${'ab'.repeat(32)}`)), stubs).out).toBe('0\n0\n0\n');
    });

    test('the commands of the Caddy section add the block of one Bid Desk in place, leave the blocks of the other two as they are, and take it out again with the bytes that the file had', () => {
      const section = sectionOf(runbookText, 'The Caddy block');
      const forBid = (block: string, bid: Bid): string => swap(swap(block, '<caddyfile>', 'Caddyfile'), '<name>', bid.name);
      const keep = blockWith(section, 'cp -p <caddyfile>');
      const append = blockWith(section, '>> <caddyfile>');
      const remove = blockWith(section, "/d' <caddyfile>");
      const before = '{\n\tadmin localhost:2019\n}\n\nexisting.example.test {\n\trespond "ok"\n}\n';
      const pair = (bid: Bid): string => {
        const lines = snippetText.split('\n');
        return lines.slice(lines.indexOf(bid.begin), lines.indexOf(bid.end) + 1).join('\n');
      };
      const script = [
        'before=$(stat -c %i Caddyfile)',
        ...BIDS.flatMap((bid) => [forBid(keep, bid), forBid(append, bid), `echo "${bid.name}: $(grep -c '^${bid.begin}$' Caddyfile) $(grep -c '^${bid.end}$' Caddyfile)"`]),
        'after=$(stat -c %i Caddyfile)',
        'echo "same inode: $([ "$before" = "$after" ] && echo yes || echo no)"',
        'cp Caddyfile all.copy',
        forBid(remove, BIDS[1]),
        'cp Caddyfile without-bravo.copy',
      ].join('\n');
      const run = runInFolder(script, { Caddyfile: before, [FILES.snippet]: snippetText });
      expect(run.out.split('\n').filter((line) => line !== ''), 'each check before an append says 0, and each block is there once after it').toStrictEqual(['0', 'alfa: 1 1', '0', 'bravo: 1 1', '0', 'charlie: 1 1', 'same inode: yes']);
      expect(readFileSync(join(run.dir, 'all.copy'), 'utf8'), 'the three blocks, appended in place').toBe(`${before}${BIDS.map(pair).join('\n')}\n`);
      expect(readFileSync(join(run.dir, 'without-bravo.copy'), 'utf8'), 'the block of bravo is gone, and the other two stay').toBe(`${before}${[pair(BIDS[0]), pair(BIDS[2])].join('\n')}\n`);
      expect(readFileSync(join(run.dir, 'Caddyfile.before-bid-desk-alfa'), 'utf8'), 'the copy that was kept holds the file as it was').toBe(before);
      expect(statSync(join(run.dir, 'Caddyfile')).isFile()).toBe(true);
    });

    /** The calls that the stand-ins record, in order. */
    const callsOf = (dir: string): string[] => readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter((line) => line !== '');
    /** Stand-ins record the commands. Curl can fail even when it returns a body. */
    const standIns = (status: string, activeSessions = 0, curlExit = 0): Record<string, string> => ({
      sleep: 'echo "sleep $*" >> calls',
      curl: `echo "curl $*" >> calls; echo '{"status":"${status}","active_sessions":${activeSessions}}'; exit ${curlExit}`,
      docker: 'echo "docker $*" >> calls',
    });

    test('the restart command of each Bid Desk waits first, then checks the runtime of that Bid Desk, and runs the up command only then: while a job runs, nothing is restarted', () => {
      const blocks = blocksOf(sectionOf(runbookText, 'The restart rule')).filter((block) => block.includes('sleep 120'));
      for (const bid of BIDS) {
        const script = blocks.find((block) => block.includes(`:${bid.runtimeHostPort}/status`))!;
        const free = runInFolder(script, {}, standIns('free'));
        expect(free.status, bid.name).toBe(0);
        expect(callsOf(free.dir), `${bid.name}: wait, check, then the command`).toStrictEqual(['sleep 120', `curl -s --max-time 5 http://127.0.0.1:${bid.runtimeHostPort}/status`, `docker compose -f ${bid.composeFile} up -d --no-deps --force-recreate service`]);
        for (const status of ['working', 'offline']) {
          const held = runInFolder(script, {}, standIns(status));
          expect(callsOf(held.dir), `${bid.name}: the runtime says ${status}`).toStrictEqual(['sleep 120', `curl -s --max-time 5 http://127.0.0.1:${bid.runtimeHostPort}/status`]);
          expect(held.out).toContain('the runtime does not say free: nothing was restarted');
        }
      }
    });

    test('the ledger check reads the current outputs of both script addresses in one request', () => {
      const proof = sectionOf(readPack('RUNBOOK.md'), '8. Remove an agent');
      const ledger = blockWith(proof, 'queryLedgerState/utxo')
        .replace('<advert address>', 'advert-example').replace('<escrow address>', 'escrow-example').replace('<Ogmios URL>', 'https://ledger.example.test');
      const read = runInFolder(ledger, {}, { curl: 'printf "%s\\n" "$@"' });
      expect(read.status).toBe(0);
      const args = read.out.trimEnd().split('\n');
      expect(args.at(-1)).toBe('https://ledger.example.test');
      expect(JSON.parse(args[args.indexOf('--data') + 1])).toMatchObject({
        jsonrpc: '2.0', method: 'queryLedgerState/utxo', params: { addresses: ['advert-example', 'escrow-example'] },
      });
      for (const part of ['queryNetwork/tip', 'decodeIdentityAdvertDatum', 'decodeIdentityEscrowDatum', '`Open`', '`Claimed`', '`Submitted`']) expect(proof).toContain(part);
    });

    test('after the ledger check, each stop targets only its own desk and refuses an occupied or unreadable runtime', () => {
      const out = sectionOf(runbookText, 'Back out');
      const running = blockWith(out, '/status');
      const partial = out.match(/`(docker compose -f \S+ stop service)`/)?.[1];
      expect(partial).toBeDefined();
      for (const bid of BIDS) {
        const script = running.replace('<runtime port>', String(bid.runtimeHostPort)).replace('<name>', bid.name);
        const statusRead = `curl -fsS --max-time 5 http://127.0.0.1:${bid.runtimeHostPort}/status`;
        const stop = `docker compose -f ${bid.composeFile} stop`;
        const free = runInFolder(script, {}, standIns('free'));
        expect(free.status, bid.name).toBe(0);
        expect(callsOf(free.dir), bid.name).toStrictEqual([statusRead, stop]);
        for (const [status, activeSessions, curlExit] of [['working', 1, 0], ['offline', 0, 0], ['free', 1, 0], ['free', 0, 22]] as const) {
          const held = runInFolder(script, {}, standIns(status, activeSessions, curlExit));
          expect(held.status, bid.name).not.toBe(0);
          expect(callsOf(held.dir), bid.name).toStrictEqual([statusRead]);
        }
        const neverStarted = runInFolder(partial!.replace('<name>', bid.name), {}, standIns('offline'));
        expect(neverStarted.status, bid.name).toBe(0);
        expect(callsOf(neverStarted.dir), bid.name).toStrictEqual([`${stop} service`]);
      }
    });

    test('the command that sets the fault switch changes the env file of one Bid Desk and no other, and the command of the check prints the value between brackets for each Bid Desk: empty in a clean run, and the one value only for the Bid Desk of the failure run', () => {
      const fault = sectionOf(runbookText, 'The fault switch');
      const set = swap(blockWith(fault, 'sed -i'), '<name>', 'charlie');
      const run = runInFolder(set, envFiles(() => exampleText));
      expect([run.status, run.out, run.err]).toStrictEqual([0, '', '']);
      for (const bid of BIDS) {
        expect(readFileSync(join(run.dir, envPath(bid)), 'utf8'), bid.name).toBe(bid.name === 'charlie' ? swap(exampleText, '\nFAULT_MODE=\n', '\nFAULT_MODE=quote_off_price_list\n') : exampleText);
      }
      const check = blockWith(fault, 'docker exec');
      // The stand-in for docker runs the command that follows `exec <container>` with the switch of that container in its environment.
      const containers = (on: string): Record<string, string> => ({ docker: `case "$2" in ${on}) value=quote_off_price_list ;; *) value= ;; esac\nshift 2\nFAULT_MODE=$value "$@"` });
      expect(runInFolder(check, {}, containers('none')).out.split('\n').filter((line) => line !== ''), 'a clean run').toStrictEqual(['alfa: FAULT_MODE=[]', 'bravo: FAULT_MODE=[]', 'charlie: FAULT_MODE=[]']);
      expect(runInFolder(check, {}, containers('bids-charlie-service')).out.split('\n').filter((line) => line !== ''), 'a failure run on one Bid Desk').toStrictEqual(['alfa: FAULT_MODE=[]', 'bravo: FAULT_MODE=[]', 'charlie: FAULT_MODE=[quote_off_price_list]']);
    });
  });
});

// --- the whole pack ------------------------------------------------------------------------------------------------------------------------------------

describe('the pack as a whole', () => {
  const packTexts: ReadonlyArray<readonly [string, string]> = [...BIDS.map((bid): [string, string] => [bid.composeFile, composeTexts[bid.name]]), [FILES.example, exampleText], [FILES.snippet, snippetText], [FILES.runbook, runbookText]];

  test('no file of the pack holds key material: no run of hex digits except the published values, and no value written for a key variable', () => {
    expect(packTexts).toHaveLength(6);
    for (const [name, text] of packTexts) expect(keyProblems(text, PUBLISHED_RUNS), name).toStrictEqual([]);
  });

  test('the guard of key material refuses each fault and passes the clean text', () => {
    expect(keyProblems(`A clean text with a published value ${PUBLISHED.IDENTITY_POLICY_ID}`, PUBLISHED_RUNS)).toStrictEqual([]);
    expect(keyProblems(`A key ${HEX}`)).toStrictEqual(['the text has a run of hex digits that is not a published value: it could be a key']);
    expect(keyProblems(`A key ${HEX}`, new Set([HEX]))).toStrictEqual([]);
    expect(keyProblems('SUPPLIER_PRIV_KEY_HEX=abcdef0123')).toStrictEqual(['the text writes the value of a key']);
    expect(keyProblems('BID_DESK_SERVICE_PRIV_KEY_HEX=abcdef0123')).toStrictEqual(['the text writes the value of a key']);
    expect(keyProblems('Use ghcr.io/x/y@sha256:<digest>')).toStrictEqual([]);
  });

  test('the hosts, the ports and the container names are the same in the compose files, the Caddy snippet, the example and the runbook, for each Bid Desk', () => {
    for (const bid of BIDS) {
      const compose = parse(composeTexts[bid.name]) as Model;
      expect(compose.services.runtime.container_name, bid.name).toBe(bid.runtimeContainer);
      expect(compose.services.runtime.ports, bid.name).toStrictEqual([`127.0.0.1:${bid.runtimeHostPort}:${RUNTIME_PORT}`]);
      expect(compose.services.runtime.environment.PUBLIC_ORIGIN, bid.name).toBe(`https://${bid.host}`);
      expect(compose.services.service.container_name, bid.name).toBe(bid.serviceContainer);
      expect(compose.services.service.ports, bid.name).toStrictEqual([`127.0.0.1:${bid.serviceHostPort}:${PORT_DEFAULT}`]);
      expect(compose.services.service.volumes, bid.name).toStrictEqual([`${bid.volume}:${STATE_DIR_DEFAULT}`]);
      expect(snippetText, bid.name).toContain(`${bid.host} {`);
      expect(snippetText, bid.name).toContain(`reverse_proxy ${bid.runtimeContainer}:${RUNTIME_PORT}`);
      expect(snippetText, bid.name).toContain(`reverse_proxy ${bid.serviceContainer}:${PORT_DEFAULT}`);
      for (const part of [bid.host, bid.runtimeContainer, bid.serviceContainer, bid.folder, bid.volume, bid.organisation, bid.envFile, bid.composeFile, String(bid.runtimeHostPort), String(bid.serviceHostPort)]) expect(runbookText, `${bid.name} ${part}`).toContain(part);
      expect(compose.services.runtime.environment.SERVICE_URL, bid.name).toBe(`http://${bid.serviceContainer}:${PORT_DEFAULT}/`);
      expect(compose.services.service.environment.BID_DESK_ORGANISATION, bid.name).toBe(bid.organisation);
    }
    expect(new Set(BIDS.map((bid) => bid.folder)).size, 'three folders').toBe(3);
    expect(new Set(BIDS.map((bid) => bid.host)).size, 'three hosts').toBe(3);
    expect(new Set(BIDS.flatMap((bid) => [bid.runtimeHostPort, bid.serviceHostPort])).size, 'six ports on the host').toBe(6);
    expect(new Set(BIDS.map((bid) => bid.volume)).size, 'three volumes').toBe(3);
    expect(new Set(BIDS.flatMap((bid) => [bid.runtimeContainer, bid.serviceContainer])).size, 'six containers').toBe(6);
    expect(BIDS.map((bid) => bid.folder), 'the folders of the host').toStrictEqual(['/srv/agents/bid-desk-alfa', '/srv/agents/bid-desk-bravo', '/srv/agents/bid-desk-charlie']);
  });

  test('the services of each compose file are the runtime and the service, and the start file that holds the key of the service is the one of this package', () => {
    for (const bid of BIDS) {
      const compose = parse(composeTexts[bid.name]) as Model;
      expect(Object.keys(compose.services), bid.name).toStrictEqual(['runtime', 'service']);
      expect(compose.name, bid.name).toBe(bid.project);
      expect(compose.services.service.image.split('@')[0], bid.name).toBe(SERVICE_IMAGE);
      expect(compose.services.runtime.image.split('@')[0], bid.name).toBe(RUNTIME_IMAGE);
    }
    expect(existsSync(join(root, 'agents', 'bid-desk', 'src', 'serve', 'start.ts'))).toBe(true);
    expect(existsSync(join(root, 'agents', 'bid-desk', 'Dockerfile'))).toBe(true);
  });

  test('the Deploy section of the README names the five files of the pack, and each one is there', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const deploy = readme.slice(readme.indexOf('\n## Deploy\n'));
    const named = ['deploy/server/docker-compose.bid-desk-alfa.yml', 'deploy/server/docker-compose.bid-desk-bravo.yml', 'deploy/server/docker-compose.bid-desk-charlie.yml', 'deploy/server/.env.bid-desk.example', 'deploy/server/RUNBOOK-bid-desk.md'];
    for (const path of named) {
      expect(deploy, path).toContain(`\`${path}\``);
      expect(existsSync(join(root, path)), `${path} is there`).toBe(true);
    }
    expect(named.map((path) => path.split('/').at(-1))).toStrictEqual([...COMPOSE_FILE_NAMES, FILES.example, FILES.runbook]);
  });

  test('the real env files never enter git: the ignore file covers .env.* and lets the examples through', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.env.*');
    expect(ignore).toContain('!.env.*.example');
  });
});

afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
