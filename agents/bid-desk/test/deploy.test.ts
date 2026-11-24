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
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { BOND_LOVELACE, INSTANCES, INSTANCE_NAMES, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_LIST_ROUTE, PRICE_LOVELACE, STATE_DIR_DEFAULT } from '../src/serve/settings.ts';
import type { Instance } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS, loadConfig } from '../src/serve/start.ts';
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
});
/** The three Bid Desks, in the order of the code. */
const BIDS: readonly Bid[] = [bidOf('alfa', 8108, 9106), bidOf('bravo', 8109, 9107), bidOf('charlie', 8110, 9108)];
const otherThan = (bid: Bid): Bid => BIDS[(BIDS.indexOf(bid) + 1) % BIDS.length];

const composeTexts: Readonly<Record<string, string>> = Object.fromEntries(BIDS.map((bid) => [bid.name, readPack(bid.composeFile)]));
const exampleText = readPack(FILES.example);

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
});
