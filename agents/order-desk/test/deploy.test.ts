// agents/order-desk/test/deploy.test.ts
// The deploy pack of the Order Desk, in deploy/server: the compose file, the two env examples, the Caddy block and the runbook. Four containers run it: three runtimes in front of one service. Each runtime serves
// one advert (one lot) and has a key, a wallet, an advert, a port and a host name of its own. The three share the one service, its address, its token and its check before the Claim.
//
// A guard here takes a text (or a parsed file) and gives the list of what is wrong with it. The list is empty for the real file, and it names the rule for each copy that breaks one. Each refusal has an accepted twin.
// The question of the pack: can a container start with a key that it must not hold, on a public port, from an image that a tag can move, from a build on the host, or on a network that another container shares?
// Can two runtimes share a supplier key? No test here uses the network, Docker or the clock. The render of the compose file and the check of the Caddy block need Docker, so they run by hand (RUNBOOK-order-desk.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { INVENTORY_CAPABILITIES, LOT_NAMES } from '@vsa/usecase-kit/inventory';
import { COUNTERPARTY_REFUSALS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { BOND_LOVELACE, LOT_PRICE_LOVELACE } from '../src/serve/manifest.ts';
import { JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, STATE_DIR_DEFAULT, SUPPLIER_PKH_VARIABLES, endpointsOf } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS, loadConfig } from '../src/serve/start.ts';
import { AGENT_DID, CONTACT, LARGE, MEDIUM, SERVICE as SERVICE_KEY, SMALL, TOKEN } from './serve/support.ts';

// --- the files ---------------------------------------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (name: string): string => readFileSync(join(root, 'deploy', 'server', name), 'utf8');
const START_TEXT = readFileSync(new URL('../src/serve/start.ts', import.meta.url), 'utf8');

const FILES = {
  compose: 'docker-compose.order-desk.yml',
  example: '.env.order-desk.example',
  runtimeExample: '.env.order-desk-runtime.example',
  snippet: 'Caddyfile.order-desk.snippet',
  runbook: 'RUNBOOK-order-desk.md',
} as const;
/** The env file that the service and the three runtimes read, and the env file of one runtime. */
const SHARED_ENV_FILE = '.env.order-desk';

const composeText = readPack(FILES.compose);
const exampleText = readPack(FILES.example);
const runtimeExampleText = readPack(FILES.runtimeExample);
const snippetText = readPack(FILES.snippet);
const runbookText = readPack(FILES.runbook);

// --- what the pack says: names, ports, hosts, images ------------------------------------------------------------------------------------------------

const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const RUNTIME_IMAGE = `${REPOSITORY}/agent-runtime`;
const SERVICE_IMAGE = `${REPOSITORY}/order-desk`;
const RUNTIME_PORT = 8080;
const SERVICE_NAME = 'service';
const SERVICE_CONTAINER = 'orders-service';
const SERVICE_UPSTREAM = `${SERVICE_CONTAINER}:${PORT_DEFAULT}`;
const NETWORK = 'order-desk_default';
/** The runtime waits this long for the service beyond the deadline of a job. */
const RUNTIME_EXTRA_WAIT_MS = 60_000;
const SERVICE_TIMEOUT_MS = JOB_DEADLINE_MS + RUNTIME_EXTRA_WAIT_MS;
/** The service stops a job at the end of its wait, and compose gives it this much more time to log what it abandoned and to exit. */
const STOP_GRACE = `${SHUTDOWN_WAIT_MS / 1000 + 30}s`;

/** One runtime for each lot of the kit, in the order of the lots: small, medium, large. */
const RUNTIMES = LOT_NAMES.map((lot, at) => {
  const size = lot.slice('lot-'.length);
  return { lot, size, service: `runtime-${size}`, container: `orders-${size}-runtime`, hostPort: 8102 + at, host: `mp-suppliers-orders-${size}.vector.apexfusion.org`, envFile: `.env.order-desk-${size}`, pkhName: SUPPLIER_PKH_VARIABLES[lot] };
});
type Runtime = (typeof RUNTIMES)[number];
const SERVICE_HOST_PORT = PORT_DEFAULT;

/** The variables of the start file that hold a key: each runtime blanks every one of them. The start reads each one time, as `requiredEnv('NAME', env.NAME,`. */
const KEY_VARIABLES = [...START_TEXT.matchAll(/requiredEnv\('([A-Z0-9_]+_PRIV_KEY_HEX)', env\./g)].map((hit) => hit[1]);

const HEX = 'ab'.repeat(32);

// --- small helpers -------------------------------------------------------------------------------------------------------------------------------------

type Model = Record<string, any>;
const isModel = (value: unknown): value is Model => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The same value in every key order. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, part: unknown) => (isModel(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a.localeCompare(b))) : part));
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
/** A name whose value is a secret: the text of a problem about it never shows the value. */
const SECRET_NAME = /PRIV_KEY|SECRET|TOKEN|PASSWORD|API_KEY|AUTH_HEADER/;

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

/** A copy of the parsed compose file, changed by `change`. */
function composeWith(change: (compose: Model) => void): Model {
  const copy = structuredClone(parse(composeText)) as Model;
  change(copy);
  return copy;
}

// --- the compose file ----------------------------------------------------------------------------------------------------------------------------------

/** What a runtime sets in its environment. The compose values win over the env files, so these are the values of every container of that runtime. */
function runtimeEnvironment(runtime: Runtime): Record<string, string> {
  return {
    CAPABILITY_KIND: 'custom',
    SERVICE_URL: `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/`,
    SERVICE_PRECHECK_URL: `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/precheck`,
    SERVICE_CONTENT_TYPE: 'application/json',
    SERVICE_TIMEOUT_MS: String(SERVICE_TIMEOUT_MS),
    ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
    PORT: String(RUNTIME_PORT),
    PUBLIC_ORIGIN: `https://${runtime.host}`,
    RELEASE_WATCHER: '1',
    ...Object.fromEntries(KEY_VARIABLES.map((name) => [name, ''])),
  };
}
/** What the service sets: the listener, the folder of its state, and the one supplier key variable, blank. */
const SERVICE_ENVIRONMENT: Record<string, string> = { PORT: String(PORT_DEFAULT), HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '', ORDER_DESK_STATE_DIR: STATE_DIR_DEFAULT };
const LOGGING = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
const KEYS_OF_EVERY_SERVICE = ['image', 'container_name', 'restart', 'env_file', 'environment', 'ports', 'depends_on', 'mem_limit', 'cap_drop', 'security_opt', 'logging'];

interface Want {
  readonly isService: boolean;
  readonly repository: string;
  readonly container: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly envFiles: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly memLimit: string;
}
const WANT: Readonly<Record<string, Want>> = {
  ...Object.fromEntries(RUNTIMES.map((runtime): [string, Want] => [runtime.service, {
    isService: false, repository: RUNTIME_IMAGE, container: runtime.container, hostPort: runtime.hostPort, containerPort: RUNTIME_PORT,
    envFiles: [SHARED_ENV_FILE, runtime.envFile], environment: runtimeEnvironment(runtime), memLimit: '768m',
  }])),
  [SERVICE_NAME]: {
    isService: true, repository: SERVICE_IMAGE, container: SERVICE_CONTAINER, hostPort: SERVICE_HOST_PORT, containerPort: PORT_DEFAULT,
    envFiles: [SHARED_ENV_FILE], environment: SERVICE_ENVIRONMENT, memLimit: '1024m',
  },
};

/** What is wrong with the compose file, parsed. An empty list is a pass. */
function composeProblems(compose: unknown): string[] {
  const problems: string[] = [];
  const top: Model = isModel(compose) ? compose : {};
  const services: Model = isModel(top.services) ? top.services : {};
  if (top.name !== 'order-desk') problems.push(`the project name must be order-desk, so that the default network is ${NETWORK}`);
  if ('networks' in top) problems.push('the file has no top-level networks key: the containers stay on the default network of their own project, which no other container shares');
  for (const key of Object.keys(top)) if (!['name', 'services', 'volumes', 'networks'].includes(key)) problems.push(`the top-level key ${key} is not allowed`);
  if (!same(top.volumes, { 'order-desk-state': { name: 'order-desk-state' } })) problems.push('volumes must be the one volume order-desk-state, with that name');
  const wanted = Object.keys(WANT);
  if (!same(Object.keys(services).sort(), [...wanted].sort())) problems.push(`the file must have the services ${wanted.join(', ')}; it has: ${Object.keys(services).join(', ') || 'none'}`);

  const runtimeImages = new Set<string>();
  for (const [name, want] of Object.entries(WANT)) {
    const s: unknown = services[name];
    if (!isModel(s)) continue;
    const own = (message: string): void => { problems.push(`${name}: ${message}`); };
    const allowed = new Set(want.isService ? [...KEYS_OF_EVERY_SERVICE, 'volumes', 'stop_grace_period'] : KEYS_OF_EVERY_SERVICE);
    for (const key of Object.keys(s)) {
      if (key === 'build') own('build is not allowed: the host builds no image, CI builds it');
      else if (key === 'networks') own('networks is not allowed: the container stays on the default network of its own project, which no other container shares');
      else if (!allowed.has(key)) own(`${key} is not allowed`);
    }
    const image = String(s.image ?? '');
    if (!new RegExp(`^${escapeRegExp(want.repository)}@sha256:(?:<digest>|[0-9a-f]{64})$`).test(image)) own(`image must be ${want.repository}@sha256: and 64 hex digits, or the placeholder <digest>; found: ${image}`);
    if (!want.isService) runtimeImages.add(image);
    if (s.container_name !== want.container) own(`container_name must be ${want.container}`);
    if (s.restart !== 'unless-stopped') own('restart must be unless-stopped');
    if (!same(s.ports, [`127.0.0.1:${want.hostPort}:${want.containerPort}`])) own(`ports must be the one entry 127.0.0.1:${want.hostPort}:${want.containerPort}; found: ${JSON.stringify(s.ports)}`);
    if (!same(s.env_file, want.envFiles.map((file) => ({ path: `./${file}`, required: true })))) own(`env_file must be ${want.envFiles.map((file) => `./${file}`).join(' and then ')}, each one required`);
    if (s.mem_limit !== want.memLimit) own(`mem_limit must be ${want.memLimit}`);
    if (!same(s.cap_drop, ['ALL'])) own('cap_drop must be [ALL]');
    if (!same(s.security_opt, ['no-new-privileges:true'])) own('security_opt must be ["no-new-privileges:true"]');
    if (!same(s.logging, LOGGING)) own('logging must be json-file with 3 files of 10m');
    if (want.isService) {
      if (!same(s.volumes, ['order-desk-state:/data'])) own('volumes must be the one entry order-desk-state:/data');
      if (s.stop_grace_period !== STOP_GRACE) own(`stop_grace_period must be ${STOP_GRACE}: the service waits up to ${SHUTDOWN_WAIT_MS / 1000} s for its job, and 30 s more are for the line of an abandoned job`);
      if ('depends_on' in s) own('depends_on is not allowed: the service waits for nobody');
    } else if (!same(s.depends_on, [SERVICE_NAME])) own(`depends_on must be [${SERVICE_NAME}]`);

    const environment: unknown = s.environment;
    if (!isModel(environment)) {
      own('environment must be a map of names to quoted text');
      continue;
    }
    for (const [variable, value] of Object.entries(environment)) {
      if (typeof value !== 'string') own(`${variable} must be quoted text`);
      else if (/PRIV_KEY_HEX$/.test(variable) && value !== '') own(`${variable} has a value: a key is never written in the compose file`);
      else if (!(variable in want.environment)) own(/PRIV_KEY_HEX$/.test(variable) ? `${variable} must not be set here: a container reads its own key from its env file` : `${variable} is not set by the compose file`);
    }
    for (const [variable, value] of Object.entries(want.environment)) {
      const found = environment[variable];
      if (value === '' && /PRIV_KEY_HEX$/.test(variable)) {
        if (found !== '') own(`${variable} must be blank (""): ${want.isService ? 'the service holds no supplier key' : 'a runtime holds no key of the service'}`);
      } else if (found !== value) {
        own(SECRET_NAME.test(variable) ? `${variable} must be ${JSON.stringify(value)}` : `${variable} must be ${JSON.stringify(value)}; found: ${JSON.stringify(found)}`);
      }
    }
  }
  if (runtimeImages.size > 1) problems.push('the three runtimes must run one image: they name different digests');
  return problems;
}

describe('deploy/server/docker-compose.order-desk.yml', () => {
  const real = parse(composeText) as Model;

  test('the real file passes: four containers, three runtimes in front of one service, each one as the pack says', () => {
    expect(composeProblems(real)).toStrictEqual([]);
    expect(RUNTIMES.map((runtime) => runtime.size)).toStrictEqual(['small', 'medium', 'large']);
    expect(RUNTIMES.map((runtime) => runtime.hostPort)).toStrictEqual([8102, 8103, 8104]);
    expect(SERVICE_HOST_PORT).toBe(9102);
    expect(Object.keys(real.services)).toStrictEqual(['runtime-small', 'runtime-medium', 'runtime-large', 'service']);
    expect(KEY_VARIABLES).toStrictEqual(['ORDER_DESK_SERVICE_PRIV_KEY_HEX']);
  });

  test('the images are named by digest: the placeholder or 64 hex digits, never a tag, and the three runtimes name one image', () => {
    const digest = 'ab'.repeat(32);
    const pinned = composeWith((c) => {
      for (const [name, want] of Object.entries(WANT)) c.services[name].image = `${want.repository}@sha256:${digest}`;
    });
    expect(composeProblems(pinned), 'the images with a digest of 64 hex digits').toStrictEqual([]);
    expect(composeText.match(/@sha256:<digest>/g)).toHaveLength(4);
    for (const bad of [`${RUNTIME_IMAGE}:latest`, `${RUNTIME_IMAGE}:${'a'.repeat(40)}`, RUNTIME_IMAGE, `${RUNTIME_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${'AB'.repeat(32)}`, `${SERVICE_IMAGE}@sha256:${digest}`]) {
      const problems = composeProblems(composeWith((c) => { c.services['runtime-medium'].image = bad; }));
      expect(problems.some((p) => /^runtime-medium: image must be/.test(p)), bad).toBe(true);
    }
    expect(composeProblems(composeWith((c) => { c.services.service.image = `${RUNTIME_IMAGE}@sha256:<digest>`; })).some((p) => /^service: image must be/.test(p))).toBe(true);
    const split = composeWith((c) => { c.services['runtime-large'].image = `${RUNTIME_IMAGE}@sha256:${digest}`; });
    expect(composeProblems(split)).toStrictEqual(['the three runtimes must run one image: they name different digests']);
  });

  // The faults. Each change breaks one rule, and the guard names it.
  const faults: ReadonlyArray<readonly [string, (c: Model) => void, RegExp]> = [
    // A port that is public, or that points at the wrong place.
    ['a public port on a runtime', (c) => { c.services['runtime-medium'].ports = ['8103:8080']; }, /^runtime-medium: ports must be the one entry 127\.0\.0\.1:8103:8080/],
    ['the address of every interface', (c) => { c.services['runtime-medium'].ports = ['0.0.0.0:8103:8080']; }, /^runtime-medium: ports must be/],
    ['a port on the address of every interface of version 6', (c) => { c.services['runtime-large'].ports = ['[::]:8104:8080']; }, /^runtime-large: ports must be/],
    ['a second port', (c) => { c.services['runtime-small'].ports.push('127.0.0.1:8105:8080'); }, /^runtime-small: ports must be/],
    ['the port of another runtime', (c) => { c.services['runtime-large'].ports = ['127.0.0.1:8103:8080']; }, /^runtime-large: ports must be the one entry 127\.0\.0\.1:8104:8080/],
    ['the wrong port in the container', (c) => { c.services['runtime-small'].ports = ['127.0.0.1:8102:9102']; }, /^runtime-small: ports must be/],
    ['the long form of a port', (c) => { c.services['runtime-small'].ports = [{ target: 8080, published: 8102, host_ip: '127.0.0.1' }]; }, /^runtime-small: ports must be/],
    ['a public port on the service', (c) => { c.services.service.ports = ['9102:9102']; }, /^service: ports must be the one entry 127\.0\.0\.1:9102:9102/],
    ['the host network', (c) => { c.services['runtime-small'].network_mode = 'host'; }, /^runtime-small: network_mode is not allowed/],
    // A build, or a network that another container shares.
    ['a build on a runtime', (c) => { c.services['runtime-small'].build = { context: '.' }; }, /^runtime-small: build is not allowed/],
    ['a build on the service', (c) => { c.services.service.build = '.'; }, /^service: build is not allowed/],
    ['a networks key on a runtime', (c) => { c.services['runtime-medium'].networks = ['proxy']; }, /^runtime-medium: networks is not allowed/],
    ['a networks key on the service', (c) => { c.services.service.networks = ['proxy']; }, /^service: networks is not allowed/],
    ['a networks key at the top', (c) => { c.networks = { proxy: { name: 'shared' } }; }, /no top-level networks key/],
    ['the external network of a proxy, on a service and at the top', (c) => { c.services.service.networks = ['proxy']; c.networks = { proxy: { external: true } }; }, /^service: networks is not allowed/],
    ['a wrong project name', (c) => { c.name = 'orders'; }, /the project name must be order-desk/],
    // The image.
    ['an image by tag', (c) => { c.services['runtime-small'].image = `${RUNTIME_IMAGE}:latest`; }, /^runtime-small: image must be/],
    ['the service image by tag', (c) => { c.services.service.image = `${SERVICE_IMAGE}:latest`; }, /^service: image must be/],
    ['an image of another repository', (c) => { c.services.service.image = `${REPOSITORY}/reorder-agent@sha256:<digest>`; }, /^service: image must be/],
    // A key that a container must not hold.
    ['a runtime that does not blank the key of the service', (c) => { delete c.services['runtime-medium'].environment.ORDER_DESK_SERVICE_PRIV_KEY_HEX; }, /^runtime-medium: ORDER_DESK_SERVICE_PRIV_KEY_HEX must be blank/],
    ['a runtime that gives the key of the service a value', (c) => { c.services['runtime-large'].environment.ORDER_DESK_SERVICE_PRIV_KEY_HEX = HEX; }, /^runtime-large: ORDER_DESK_SERVICE_PRIV_KEY_HEX has a value/],
    ['a runtime that sets its own supplier key', (c) => { c.services['runtime-small'].environment.SUPPLIER_PRIV_KEY_HEX = ''; }, /^runtime-small: SUPPLIER_PRIV_KEY_HEX must not be set here/],
    ['a runtime that writes its supplier key', (c) => { c.services['runtime-small'].environment.SUPPLIER_PRIV_KEY_HEX = HEX; }, /^runtime-small: SUPPLIER_PRIV_KEY_HEX has a value/],
    ['a service that does not blank the supplier key', (c) => { delete c.services.service.environment.SUPPLIER_PRIV_KEY_HEX; }, /^service: SUPPLIER_PRIV_KEY_HEX must be blank/],
    ['a service that gives the supplier key a value', (c) => { c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }, /^service: SUPPLIER_PRIV_KEY_HEX has a value/],
    ['a service that sets its own key', (c) => { c.services.service.environment.ORDER_DESK_SERVICE_PRIV_KEY_HEX = ''; }, /^service: ORDER_DESK_SERVICE_PRIV_KEY_HEX must not be set here/],
    ['the token in the compose file', (c) => { c.services['runtime-small'].environment.SERVICE_AUTH_HEADER = 'Bearer x'; }, /^runtime-small: SERVICE_AUTH_HEADER is not set by the compose file/],
    // The env files: each runtime has one of its own, and the service reads the shared one only.
    ['two runtimes on one env file', (c) => { c.services['runtime-medium'].env_file[1].path = './.env.order-desk-small'; }, /^runtime-medium: env_file must be/],
    ['a runtime with no env file of its own', (c) => { c.services['runtime-large'].env_file = [{ path: './.env.order-desk', required: true }]; }, /^runtime-large: env_file must be/],
    ['a runtime that reads the file of another runtime too', (c) => { c.services['runtime-small'].env_file.push({ path: './.env.order-desk-medium', required: true }); }, /^runtime-small: env_file must be/],
    ['a runtime that does not read the shared file', (c) => { c.services['runtime-small'].env_file.shift(); }, /^runtime-small: env_file must be/],
    ['an env file that is not required', (c) => { c.services['runtime-small'].env_file[1].required = false; }, /^runtime-small: env_file must be/],
    ['a service that reads the file of a runtime', (c) => { c.services.service.env_file.push({ path: './.env.order-desk-small', required: true }); }, /^service: env_file must be/],
    // The address of the service, the check before the Claim, the windows, the card, the release watcher.
    ['a runtime that calls another port of the service', (c) => { c.services['runtime-small'].environment.SERVICE_URL = 'http://orders-service:9103/'; }, /^runtime-small: SERVICE_URL must be/],
    ['the alias of the service in place of its container', (c) => { c.services['runtime-small'].environment.SERVICE_URL = 'http://service:9102/'; }, /^runtime-small: SERVICE_URL must be/],
    ['a runtime with no check before the Claim', (c) => { delete c.services['runtime-medium'].environment.SERVICE_PRECHECK_URL; }, /^runtime-medium: SERVICE_PRECHECK_URL must be/],
    ['a check at another route', (c) => { c.services['runtime-large'].environment.SERVICE_PRECHECK_URL = 'http://orders-service:9102/check'; }, /^runtime-large: SERVICE_PRECHECK_URL must be/],
    ['a timeout that leaves the window', (c) => { c.services['runtime-small'].environment.SERVICE_TIMEOUT_MS = '460000'; }, /^runtime-small: SERVICE_TIMEOUT_MS must be "360000"/],
    ['a window under the deadline of the job', (c) => { c.services['runtime-medium'].environment.ADVERT_MAX_PROCESSING_MS = '300000'; }, /^runtime-medium: ADVERT_MAX_PROCESSING_MS must be "480000"/],
    ['a window as a number', (c) => { c.services['runtime-medium'].environment.ADVERT_MAX_PROCESSING_MS = 480000; }, /^runtime-medium: ADVERT_MAX_PROCESSING_MS must be quoted text/],
    ['a port in the container that the mapping does not publish', (c) => { c.services['runtime-large'].environment.PORT = '8081'; }, /^runtime-large: PORT must be "8080"/],
    ['the card of a runtime on the host name of another', (c) => { c.services['runtime-medium'].environment.PUBLIC_ORIGIN = `https://${RUNTIMES[0].host}`; }, /^runtime-medium: PUBLIC_ORIGIN must be/],
    ['an origin that is not https', (c) => { c.services['runtime-small'].environment.PUBLIC_ORIGIN = `http://${RUNTIMES[0].host}`; }, /^runtime-small: PUBLIC_ORIGIN must be/],
    ['an origin with a path', (c) => { c.services['runtime-small'].environment.PUBLIC_ORIGIN = `https://${RUNTIMES[0].host}/`; }, /^runtime-small: PUBLIC_ORIGIN must be/],
    ['no release watcher', (c) => { delete c.services['runtime-large'].environment.RELEASE_WATCHER; }, /^runtime-large: RELEASE_WATCHER must be "1"/],
    ['a release watcher that is off', (c) => { c.services['runtime-large'].environment.RELEASE_WATCHER = '0'; }, /^runtime-large: RELEASE_WATCHER must be "1"/],
    ['the capability kind of another runtime', (c) => { c.services['runtime-small'].environment.CAPABILITY_KIND = 'chat'; }, /^runtime-small: CAPABILITY_KIND must be "custom"/],
    ['a setting that the compose file does not set', (c) => { c.services['runtime-small'].environment.LIVE_CHAIN = '1'; }, /^runtime-small: LIVE_CHAIN is not set by the compose file/],
    // The listener and the state of the service.
    ['a port of the service that the mapping does not publish', (c) => { c.services.service.environment.PORT = '9103'; }, /^service: PORT must be "9102"/],
    ['the loopback address inside the container of the service', (c) => { c.services.service.environment.HOST = '127.0.0.1'; }, /^service: HOST must be "0\.0\.0\.0"/],
    ['a state directory that is not the volume', (c) => { c.services.service.environment.ORDER_DESK_STATE_DIR = '/tmp/state'; }, /^service: ORDER_DESK_STATE_DIR must be "\/data"/],
    ['a key written in a container', (c) => { c.services.service.environment.OTHER_PRIV_KEY_HEX = HEX; }, /^service: OTHER_PRIV_KEY_HEX has a value/],
    // The volume, the grace period, the order of the start.
    ['no volume on the service', (c) => { delete c.services.service.volumes; }, /^service: volumes must be/],
    ['a folder of the host as the state', (c) => { c.services.service.volumes = ['/srv/agents/order-desk:/data']; }, /^service: volumes must be/],
    ['a volume of another name', (c) => { c.services.service.volumes = ['state:/data']; }, /^service: volumes must be/],
    ['a volume on a runtime', (c) => { c.services['runtime-small'].volumes = ['order-desk-state:/data']; }, /^runtime-small: volumes is not allowed/],
    ['a volume that is external', (c) => { c.volumes['order-desk-state'] = { name: 'order-desk-state', external: true }; }, /^volumes must be the one volume/],
    ['a second volume', (c) => { c.volumes.other = {}; }, /^volumes must be the one volume/],
    ['a short grace period', (c) => { c.services.service.stop_grace_period = '30s'; }, /^service: stop_grace_period must be 330s/],
    ['no grace period', (c) => { delete c.services.service.stop_grace_period; }, /^service: stop_grace_period must be 330s/],
    ['a runtime that does not wait for the service', (c) => { delete c.services['runtime-medium'].depends_on; }, /^runtime-medium: depends_on must be \[service\]/],
    ['a service that waits for a runtime', (c) => { c.services.service.depends_on = ['runtime-small']; }, /^service: depends_on is not allowed/],
    // The shape of the container.
    ['restart always', (c) => { c.services.service.restart = 'always'; }, /^service: restart must be unless-stopped/],
    ['no memory limit on a runtime', (c) => { delete c.services['runtime-small'].mem_limit; }, /^runtime-small: mem_limit must be 768m/],
    ['a limit of 2 GiB on the service', (c) => { c.services.service.mem_limit = '2048m'; }, /^service: mem_limit must be 1024m/],
    ['the capabilities kept', (c) => { c.services['runtime-small'].cap_drop = ['NET_RAW']; }, /^runtime-small: cap_drop must be \[ALL\]/],
    ['a capability added', (c) => { c.services['runtime-small'].cap_add = ['NET_ADMIN']; }, /^runtime-small: cap_add is not allowed/],
    ['new privileges allowed', (c) => { delete c.services['runtime-large'].security_opt; }, /^runtime-large: security_opt must be/],
    ['a privileged container', (c) => { c.services.service.privileged = true; }, /^service: privileged is not allowed/],
    ['the process space of the host', (c) => { c.services['runtime-small'].pid = 'host'; }, /^runtime-small: pid is not allowed/],
    ['a device', (c) => { c.services['runtime-small'].devices = ['/dev/fuse']; }, /^runtime-small: devices is not allowed/],
    ['the volumes of another container', (c) => { c.services['runtime-small'].volumes_from = ['service']; }, /^runtime-small: volumes_from is not allowed/],
    ['no log limit', (c) => { c.services.service.logging.options['max-size'] = '1g'; }, /^service: logging must be/],
    ['the wrong container name', (c) => { c.services['runtime-medium'].container_name = 'orders-medium'; }, /^runtime-medium: container_name must be orders-medium-runtime/],
    // The services of the file.
    ['a fourth runtime', (c) => { c.services['runtime-huge'] = structuredClone(c.services['runtime-large']); }, /the file must have the services/],
    ['a missing runtime', (c) => { delete c.services['runtime-medium']; }, /the file must have the services/],
    ['a second service', (c) => { c.services.other = { image: 'example' }; }, /the file must have the services/],
    ['a key at the top that the file does not use', (c) => { c.secrets = {}; }, /the top-level key secrets is not allowed/],
  ];

  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(60);
    for (const [what, change, expected] of faults) {
      const problems = composeProblems(composeWith(change));
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a key names the variable and never shows its value', () => {
    const text = composeProblems(composeWith((c) => { c.services['runtime-small'].environment.ORDER_DESK_SERVICE_PRIV_KEY_HEX = HEX; c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; })).join('\n');
    expect(text).toContain('ORDER_DESK_SERVICE_PRIV_KEY_HEX');
    expect(text).not.toContain(HEX);
    const wrongToken = composeProblems(composeWith((c) => { c.services['runtime-small'].environment.SERVICE_AUTH_HEADER = `Bearer ${HEX}`; })).join('\n');
    expect(wrongToken).not.toContain(HEX);
  });

  test('the twins: a runtime that lists its key variable in the form of a list is refused, and the order of the keys of a map changes nothing', () => {
    const asList = composeWith((c) => { c.services['runtime-small'].environment = Object.entries(c.services['runtime-small'].environment).map(([name, value]) => `${name}=${String(value)}`); });
    expect(composeProblems(asList)).toStrictEqual(['runtime-small: environment must be a map of names to quoted text']);
    const reordered = composeWith((c) => {
      const environment = c.services['runtime-small'].environment as Record<string, string>;
      c.services['runtime-small'].environment = Object.fromEntries(Object.entries(environment).reverse());
    });
    expect(composeProblems(reordered)).toStrictEqual([]);
  });

  test('the key variables of the start file are the ones that the runtimes blank: a second key in the start file needs a second blank in each runtime', () => {
    for (const runtime of RUNTIMES) {
      const environment = real.services[runtime.service].environment as Record<string, string>;
      for (const name of KEY_VARIABLES) expect(environment[name], `${runtime.service} blanks ${name}`).toBe('');
      expect('SUPPLIER_PRIV_KEY_HEX' in environment, `${runtime.service} sets no supplier key`).toBe(false);
    }
    expect((real.services.service.environment as Record<string, string>).SUPPLIER_PRIV_KEY_HEX).toBe('');
    for (const name of KEY_VARIABLES) expect(name in real.services.service.environment, `the service does not set ${name}`).toBe(false);
  });

  test('the windows nest: the deadline of a job is inside the timeout of the runtime, which is inside the window of the advert with 60 s to spare', () => {
    expect([MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    expect(JOB_DEADLINE_MS).toBeLessThan(SERVICE_TIMEOUT_MS);
    expect(SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
    for (const runtime of RUNTIMES) {
      const environment = real.services[runtime.service].environment as Record<string, string>;
      expect(Number(environment.SERVICE_TIMEOUT_MS)).toBeLessThanOrEqual(Number(environment.ADVERT_MAX_PROCESSING_MS) - 60_000);
    }
  });

  test('the three runtimes differ in their container, their port, their env file and their host name, and in nothing else', () => {
    const rest = (runtime: Runtime): unknown => {
      const copy = structuredClone(real.services[runtime.service]) as Model;
      delete copy.container_name;
      delete copy.ports;
      copy.env_file = copy.env_file.slice(0, 1);
      delete copy.environment.PUBLIC_ORIGIN;
      return copy;
    };
    expect(canonical(rest(RUNTIMES[1]))).toBe(canonical(rest(RUNTIMES[0])));
    expect(canonical(rest(RUNTIMES[2]))).toBe(canonical(rest(RUNTIMES[0])));
    expect(new Set(RUNTIMES.map((runtime) => real.services[runtime.service].ports[0])).size).toBe(3);
    expect(new Set(RUNTIMES.map((runtime) => real.services[runtime.service].env_file[1].path)).size).toBe(3);
    expect(new Set(RUNTIMES.map((runtime) => real.services[runtime.service].environment.PUBLIC_ORIGIN)).size).toBe(3);
  });

  test('the comment of the file says where the digests come from and that no network is joined', () => {
    expect(composeText).toContain('RUNBOOK-order-desk.md');
    expect(composeText).toContain(NETWORK);
    expect(composeText.split('\n').filter((line) => /^\s*(networks|build):/.test(line))).toStrictEqual([]);
  });
});

// --- the env examples ----------------------------------------------------------------------------------------------------------------------------------

/** The names of the tool that posts an advert. The operator posts the three adverts with the hosted tools, and a runtime reads the reference of its advert as ADVERT_REF. */
const POST_ADVERT_NAMES = ['ADVERT_MODEL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'] as const;
/** The four supplier lines, the reference of the advert and the identifier of the agent record: what the file of one runtime holds, and nothing else. */
const RUNTIME_ONLY = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'ADVERT_REF', 'AGENT_ID'] as const;
/** The other names that a runtime reads from an env file (the template of the runtime): its chain, the escrow and the advert scripts, and the settings that the compose file also sets. */
const RUNTIME_READS = [
  ...RUNTIME_ONLY, 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO', 'IDENTITY_ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID',
  'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_PRECHECK_URL', 'SERVICE_AUTH_HEADER', 'SERVICE_CONTENT_TYPE', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'PUBLIC_ORIGIN', 'RELEASE_WATCHER', 'PORT', 'WALLET_HEALTH_INTERVAL_MS',
] as const;
/** The values that are public chain data: the identity registry that Vector mainnet published, the legacy scripts, and the network. The examples hold these and no other value of that shape. */
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
/** The values that this pack chooses: the model hire of the decision as Advocate has it (one model, a price of 1 unit at most and both bonds of 2 units at most), and the stake of a challenge as the least stake of a claim. */
const CHOSEN: Readonly<Record<string, string>> = {
  AGENT_STATUS_CHIP: 'proposed',
  FAULT_MODE: '',
  ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
  LOTS_PUBLIC_ORIGIN: `https://${RUNTIMES[0].host}`,
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
  DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
  DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
  DISPUTE_READ_TIMEOUT_MS: '20000',
};
/** The lines that an operator has to fill: a value in angle brackets stands for what the operator supplies. */
const PLACEHOLDER_NAMES = ['OPERATOR_CONTACT', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST'];
const MODULE1_MANIFEST = /^https:\/\/raw\.githubusercontent\.com\/Apex-Fusion\/vector-agent-modules\/(?:<commit>|[0-9a-f]{40})\/Module-1\/deploy\/identity\/mainnet\/manifest\.json$/;
/** The lines that a service cannot start without, and the lines that a runtime needs from the shared file. The example holds each one. */
const MUST_HAVE = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ORDER_DESK_SERVICE_PKH', 'SERVICE_AUTH_HEADER', 'LOTS_PUBLIC_ORIGIN',
  'SMALL_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX', 'MEDIUM_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PUB_KEY_HEX', 'LARGE_SUPPLIER_PKH', 'LARGE_SUPPLIER_PUB_KEY_HEX',
  'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST', 'FAULT_MODE', 'AGENT_STATUS_CHIP', 'ADVERT_MAX_PROCESSING_MS',
  ...Object.keys(PUBLISHED), ...Object.keys(CHOSEN),
];
/** Lines whose value may stay empty: the service takes its default, or the line is filled later. The values below are all the empty lines of the shared example. */
const EMPTY_LINES = [
  'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ORDER_DESK_SERVICE_PKH', 'AGENT_DID', 'SMALL_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX', 'MEDIUM_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PUB_KEY_HEX', 'LARGE_SUPPLIER_PKH',
  'LARGE_SUPPLIER_PUB_KEY_HEX', 'IDENTITY_ADDRESS', 'AGENT_VERSION', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'FAULT_MODE', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL',
  'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL', 'CHECKS_READ_BUDGET_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
];

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

/** What the compose file sets for the containers: the names that an example must not repeat, because the compose value wins. */
function composeSetNames(compose: Model): Set<string> {
  return new Set(Object.values(compose.services as Model).flatMap((service) => Object.keys(isModel(service.environment) ? service.environment : {})));
}

/** What is wrong with an example: the shared one (`service`) or the one of a runtime (`runtime`). An empty list is a pass. */
function exampleProblems(text: string, kind: 'service' | 'runtime', compose: Model = parse(composeText) as Model): string[] {
  const { entries, problems: lineProblems } = entriesOf(text);
  const problems: string[] = [...lineProblems];
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (seen.has(name)) problems.push(`${name} is listed twice`);
    seen.add(name);
  }
  const value = (name: string): string | undefined => entries.find((entry) => entry.name === name)?.value;
  const allowed = new Set<string>([...SETTINGS, ...RUNTIME_READS]);
  // A name that the compose file sets wins over the env file, so an example must not repeat it. Two names are the exception: the window of the adverts (the compose file gives it to the runtimes, and the service reads it
  // from the file) and the key variables of the service (the service reads them from the file, and each runtime blanks them).
  const setByCompose = composeSetNames(compose);
  const exempt = new Set<string>(['ADVERT_MAX_PROCESSING_MS', ...KEY_VARIABLES]);
  for (const { name, value: given } of entries) {
    if ((POST_ADVERT_NAMES as readonly string[]).includes(name)) problems.push(`${name} is a name of the advert tool: the operator posts the adverts, and no example holds it`);
    else if (!allowed.has(name)) problems.push(`${name} is no setting of the service and no setting of a runtime`);
    if (SECRET_NAME.test(name) && !emptyValue(given)) problems.push(`${name} must be empty`);
    const published = Object.hasOwn(PUBLISHED, name) && PUBLISHED[name] === given;
    if (!published && KEY_SHAPED.some((shape) => shape.test(given))) problems.push(`${name} looks like key material`);
    if (kind === 'service') {
      if ((RUNTIME_ONLY as readonly string[]).includes(name)) problems.push(`${name} belongs in the env file of one runtime: in the shared file it would give the three runtimes one value`);
      else if (setByCompose.has(name) && !exempt.has(name)) problems.push(`${name} is set by the compose file, which wins: a line here would do nothing`);
    }
  }
  if (kind === 'runtime') {
    if (!same(entries.map((entry) => entry.name), [...RUNTIME_ONLY])) problems.push(`the file of a runtime must hold ${RUNTIME_ONLY.join(', ')} in that order, and nothing else`);
    for (const { name, value: given } of entries) if (!emptyValue(given)) problems.push(`${name} must be empty: the operator fills it for one runtime`);
    return problems;
  }
  for (const name of MUST_HAVE) if (value(name) === undefined) problems.push(`${name} is missing`);
  for (const [name, wanted] of Object.entries({ ...PUBLISHED, ...CHOSEN })) {
    const found = value(name);
    if (found !== undefined && found !== wanted) problems.push(SECRET_NAME.test(name) ? `${name} must be the value of the pack` : `${name} must be ${JSON.stringify(wanted)}; found: ${JSON.stringify(found)}`);
  }
  for (const name of EMPTY_LINES) {
    const found = value(name);
    if (found !== undefined && !emptyValue(found)) problems.push(`${name} must be empty in the example`);
  }
  const bracketed = entries.filter((entry) => entry.value.includes('<')).map((entry) => entry.name);
  if (!same(bracketed.sort(), [...PLACEHOLDER_NAMES].sort())) problems.push(`the lines with a placeholder must be ${PLACEHOLDER_NAMES.join(', ')}; found: ${bracketed.join(', ')}`);
  const manifest = value('VECTOR_MODULE1_MANIFEST');
  if (manifest !== undefined && !MODULE1_MANIFEST.test(manifest)) problems.push('VECTOR_MODULE1_MANIFEST must be an https address of the Module-1 manifest, pinned to a commit: the placeholder <commit> or 40 hex digits');
  const token = value('SERVICE_AUTH_HEADER');
  if (token !== undefined && token !== '""') problems.push('SERVICE_AUTH_HEADER must be "" (quoted and empty): the value has a space, so it needs quotes');
  return problems;
}

/** Appends one NAME=value line at the end of a text. */
const withLine = (text: string, line: string): string => `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`;

describe('the env examples', () => {
  test('the shared example passes: the settings of the service and the lines that the runtimes share, each one once, every secret empty, the published values as published', () => {
    expect(exampleProblems(exampleText, 'service')).toStrictEqual([]);
    const { entries } = entriesOf(exampleText);
    expect(entries.length).toBeGreaterThan(40);
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(new Set<string>([...SETTINGS, ...RUNTIME_READS]).has(name), name).toBe(true);
    for (const name of ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ORDER_DESK_SERVICE_PKH', 'SERVICE_AUTH_HEADER']) expect(emptyValue(entries.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example of a runtime passes: one set of supplier lines, the reference of the advert and the agent identifier, all empty', () => {
    expect(exampleProblems(runtimeExampleText, 'runtime')).toStrictEqual([]);
    expect(entriesOf(runtimeExampleText).entries.map((entry) => entry.name)).toStrictEqual([...RUNTIME_ONLY]);
  });

  test('the two examples share no name, and the supplier lines are only in the example of a runtime: no runtime can get the key of another from the shared file', () => {
    const shared = new Set(entriesOf(exampleText).entries.map((entry) => entry.name));
    const own = entriesOf(runtimeExampleText).entries.map((entry) => entry.name);
    expect(own.filter((name) => shared.has(name))).toStrictEqual([]);
    expect([...shared].filter((name) => /^SUPPLIER_/.test(name))).toStrictEqual([]);
    // The three runtime files are three copies of one example: the compose file gives each runtime the file of its own.
    expect(RUNTIMES.map((runtime) => runtime.envFile)).toStrictEqual(['.env.order-desk-small', '.env.order-desk-medium', '.env.order-desk-large']);
    for (const name of RUNTIME_ONLY.filter((n) => /^SUPPLIER_/.test(n))) expect(own.filter((n) => n === name), `${name} stands once`).toHaveLength(1);
  });

  test('a name of the advert tool is refused in either example, one at a time, and the unchanged examples are accepted', () => {
    for (const [text, kind] of [[exampleText, 'service'], [runtimeExampleText, 'runtime']] as const) {
      expect(exampleProblems(text, kind), `the ${kind} example as it is`).toStrictEqual([]);
      for (const name of POST_ADVERT_NAMES) {
        const problems = exampleProblems(withLine(text, `${name}=`), kind);
        expect(problems.some((problem) => problem === `${name} is a name of the advert tool: the operator posts the adverts, and no example holds it`), `${kind} example with ${name}: ${JSON.stringify(problems)}`).toBe(true);
      }
    }
  });

  const serviceFaults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    ['a supplier line in the shared file (one key for the three runtimes)', (t) => withLine(t, 'SUPPLIER_PRIV_KEY_HEX='), /^SUPPLIER_PRIV_KEY_HEX belongs in the env file of one runtime/],
    ['the supplier key hash in the shared file', (t) => withLine(t, 'SUPPLIER_PKH='), /^SUPPLIER_PKH belongs in the env file of one runtime/],
    ['the advert reference in the shared file', (t) => withLine(t, 'ADVERT_REF='), /^ADVERT_REF belongs in the env file of one runtime/],
    ['the agent identifier in the shared file', (t) => withLine(t, 'AGENT_ID='), /^AGENT_ID belongs in the env file of one runtime/],
    ['a key in the line of the service key', (t) => swap(t, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX=\n', `ORDER_DESK_SERVICE_PRIV_KEY_HEX=${HEX}\n`), /^ORDER_DESK_SERVICE_PRIV_KEY_HEX must be empty/],
    ['a token in the token line', (t) => swap(t, 'SERVICE_AUTH_HEADER=""', `SERVICE_AUTH_HEADER="Bearer ${HEX}"`), /^SERVICE_AUTH_HEADER must be empty/],
    ['a key in the line of a public key', (t) => swap(t, 'SMALL_SUPPLIER_PUB_KEY_HEX=\n', `SMALL_SUPPLIER_PUB_KEY_HEX=${HEX}\n`), /^SMALL_SUPPLIER_PUB_KEY_HEX (must be empty|looks like key material)/],
    ['a key hash in the line of the service', (t) => swap(t, 'ORDER_DESK_SERVICE_PKH=\n', `ORDER_DESK_SERVICE_PKH=${'cd'.repeat(28)}\n`), /^ORDER_DESK_SERVICE_PKH (must be empty|looks like key material)/],
    ['an unquoted token line', (t) => swap(t, 'SERVICE_AUTH_HEADER=""', 'SERVICE_AUTH_HEADER='), /^SERVICE_AUTH_HEADER must be "" \(quoted and empty\)/],
    ['a setting that the compose file sets', (t) => withLine(t, 'PORT=9102'), /^PORT is set by the compose file, which wins/],
    ['a state directory line', (t) => withLine(t, 'ORDER_DESK_STATE_DIR=/data'), /^ORDER_DESK_STATE_DIR is set by the compose file/],
    ['the address of the service for the runtimes', (t) => withLine(t, 'SERVICE_URL=http://orders-service:9102/'), /^SERVICE_URL is set by the compose file/],
    ['a name that is no setting', (t) => withLine(t, 'SOMETHING_ELSE=1'), /^SOMETHING_ELSE is no setting of the service and no setting of a runtime/],
    ['a name twice', (t) => withLine(t, 'FAULT_MODE='), /^FAULT_MODE is listed twice/],
    ['a line that is no NAME=value', (t) => withLine(t, 'name = value'), /is not a comment and not NAME=value/],
    ['a missing required line', (t) => swap(t, 'MOCK_MTLS_BASE=', '# MOCK_MTLS_BASE='), /^MOCK_MTLS_BASE is missing/],
    ['a fault switch that is on', (t) => swap(t, 'FAULT_MODE=\n', 'FAULT_MODE=confirm_wrong_lot\n'), /^FAULT_MODE must be ""/],
    ['a status word of a live service', (t) => swap(t, 'AGENT_STATUS_CHIP=proposed', 'AGENT_STATUS_CHIP=live'), /^AGENT_STATUS_CHIP must be "proposed"/],
    ['a window under the deadline of a job', (t) => swap(t, 'ADVERT_MAX_PROCESSING_MS=480000', 'ADVERT_MAX_PROCESSING_MS=300000'), /^ADVERT_MAX_PROCESSING_MS must be "480000"/],
    ['the lots host of the medium runtime', (t) => swap(t, `LOTS_PUBLIC_ORIGIN=https://${RUNTIMES[0].host}`, `LOTS_PUBLIC_ORIGIN=https://${RUNTIMES[1].host}`), /^LOTS_PUBLIC_ORIGIN must be/],
    ['another policy of the identity registry', (t) => swap(t, `IDENTITY_POLICY_ID=${PUBLISHED.IDENTITY_POLICY_ID}`, `IDENTITY_POLICY_ID=${'0'.repeat(56)}`), /^IDENTITY_POLICY_ID must be/],
    ['another vault script', (t) => swap(t, `VECTOR_IDENTITY_VAULT_REF_UTXO=${PUBLISHED.VECTOR_IDENTITY_VAULT_REF_UTXO}`, `VECTOR_IDENTITY_VAULT_REF_UTXO=${HEX}#0`), /^VECTOR_IDENTITY_VAULT_REF_UTXO must be/],
    ['a Module-1 manifest that no commit pins', (t) => swap(t, '/<commit>/', '/main/'), /^VECTOR_MODULE1_MANIFEST must be an https address of the Module-1 manifest, pinned to a commit/],
    ['a Module-1 manifest as a file', (t) => swap(t, /^VECTOR_MODULE1_MANIFEST=.*$/m.exec(t)![0], 'VECTOR_MODULE1_MANIFEST=/etc/manifest.json'), /^VECTOR_MODULE1_MANIFEST must be an https address/],
    ['a placeholder where the pack gives a value', (t) => swap(t, 'LLM_MAX_PRICE_LOVELACE=1000000', 'LLM_MAX_PRICE_LOVELACE=<price>'), /^LLM_MAX_PRICE_LOVELACE must be "1000000"/],
    ['a limit that the model hire does not take', (t) => swap(t, 'LLM_MAX_BUYER_BOND_LOVELACE=2000000', 'LLM_MAX_BUYER_BOND_LOVELACE=5000000'), /^LLM_MAX_BUYER_BOND_LOVELACE must be "2000000"/],
    ['a stake that no claim reaches', (t) => swap(t, 'DISPUTE_CHALLENGE_STAKE_LOVELACE=50000000', 'DISPUTE_CHALLENGE_STAKE_LOVELACE=1000000'), /^DISPUTE_CHALLENGE_STAKE_LOVELACE must be "50000000"/],
    ['a resolution deadline in the example', (t) => swap(t, 'DISPUTE_RESOLUTION_DEADLINE_MS=', 'DISPUTE_RESOLUTION_DEADLINE_MS=259200000'), /^DISPUTE_RESOLUTION_DEADLINE_MS must be empty in the example/],
  ];
  test('each copy of the shared example that breaks one rule is refused, in the words of that rule', () => {
    for (const [what, change, expected] of serviceFaults) {
      const problems = exampleProblems(change(exampleText), 'service');
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  const runtimeFaults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    ['a key in the line of the supplier key', (t) => swap(t, 'SUPPLIER_PRIV_KEY_HEX=\n', `SUPPLIER_PRIV_KEY_HEX=${HEX}\n`), /^SUPPLIER_PRIV_KEY_HEX must be empty/],
    ['a second set of supplier lines (a runtime with two keys)', (t) => withLine(t, 'SUPPLIER_PKH='), /^SUPPLIER_PKH is listed twice/],
    ['a chain line in the file of one runtime', (t) => withLine(t, 'LIVE_CHAIN=1'), /^the file of a runtime must hold/],
    ['a line of the service in the file of one runtime', (t) => withLine(t, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX='), /^the file of a runtime must hold/],
    ['the token in the file of one runtime', (t) => withLine(t, 'SERVICE_AUTH_HEADER=""'), /^the file of a runtime must hold/],
    ['a value that the operator fills for one runtime', (t) => swap(t, 'ADVERT_REF=\n', `ADVERT_REF=${HEX}#0\n`), /^ADVERT_REF must be empty/],
    ['the lines in another order', (t) => exchange(t, 'ADVERT_REF=\n', 'AGENT_ID=\n'), /^the file of a runtime must hold/],
  ];
  test('each copy of the example of a runtime that breaks one rule is refused', () => {
    for (const [what, change, expected] of runtimeFaults) {
      const problems = exampleProblems(change(runtimeExampleText), 'runtime');
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a secret line never shows the value that it found', () => {
    const text = exampleProblems(swap(exampleText, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX=\n', `ORDER_DESK_SERVICE_PRIV_KEY_HEX=${HEX}\n`), 'service').join('\n');
    expect(text).toContain('ORDER_DESK_SERVICE_PRIV_KEY_HEX');
    expect(text).not.toContain(HEX);
  });

  test('no name of the compose file is repeated in the shared example with another value: the names in both are the window of the adverts and the key variables of the service, and the values agree', () => {
    const compose = parse(composeText) as Model;
    const both = entriesOf(exampleText).entries.filter((entry) => composeSetNames(compose).has(entry.name));
    expect(both.map((entry) => entry.name).sort()).toStrictEqual(['ADVERT_MAX_PROCESSING_MS', ...KEY_VARIABLES].sort());
    // The window is one value for the service and the three runtimes. A key variable is empty in the example and blank in each runtime.
    for (const runtime of RUNTIMES) expect(compose.services[runtime.service].environment.ADVERT_MAX_PROCESSING_MS).toBe(both.find((entry) => entry.name === 'ADVERT_MAX_PROCESSING_MS')!.value);
    for (const name of KEY_VARIABLES) expect(emptyValue(both.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  // The proof that the example is the real thing: the shared example, filled in with the values that an operator gives, and joined with what the compose file sets for the service, is the environment that the service
  // reads at start. The real start code accepts it, and the manifest that it renders names the host of each runtime that the compose file and the Caddy block name.
  const filled = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
    ...env,
    OPERATOR_CONTACT: CONTACT,
    AGENT_DID,
    ORDER_DESK_SERVICE_PRIV_KEY_HEX: SERVICE_KEY.privateKeyHex,
    SERVICE_AUTH_HEADER: TOKEN,
    SMALL_SUPPLIER_PKH: SMALL.pkh,
    SMALL_SUPPLIER_PUB_KEY_HEX: SMALL.pubKeyHex,
    MEDIUM_SUPPLIER_PKH: MEDIUM.pkh,
    MEDIUM_SUPPLIER_PUB_KEY_HEX: MEDIUM.pubKeyHex,
    LARGE_SUPPLIER_PKH: LARGE.pkh,
    LARGE_SUPPLIER_PUB_KEY_HEX: LARGE.pubKeyHex,
    MOCK_PUBLIC_BASE: 'https://mock.example.test',
    MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
    VECTOR_MODULE1_MANIFEST: swap(env.VECTOR_MODULE1_MANIFEST ?? '', '<commit>', 'a'.repeat(40)),
  });
  const exampleEnv = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value === '""' ? '' : entry.value]));
  const serviceContainerEnv = (parse(composeText) as Model).services.service.environment as Record<string, string>;

  test('the shared example, filled in and joined with the environment that the compose file gives the service, starts the real configuration of the service', () => {
    const config = loadConfig({ ...filled(exampleEnv), ...serviceContainerEnv });
    expect(config.port).toBe(9102);
    expect(config.host).toBe('0.0.0.0');
    expect(config.stateDir).toBe('/data');
    expect(config.fault.mode).toBe('');
    const manifest = JSON.parse(config.manifest.text) as { terms: { tiers: Array<{ model: string; endpoint: string; max_processing_ms: number; price_lovelace: number }> }; behaviour: { lots: { uri: string } } };
    expect(manifest.terms.tiers.map((tier) => tier.model)).toStrictEqual(RUNTIMES.map((runtime) => runtime.lot));
    expect(manifest.terms.tiers.map((tier) => tier.endpoint), 'the endpoint of each tier is the card origin of its runtime').toStrictEqual(RUNTIMES.map((runtime) => `https://${runtime.host}`));
    expect(manifest.terms.tiers.map((tier) => tier.max_processing_ms)).toStrictEqual(RUNTIMES.map(() => MIN_PROCESSING_WINDOW_MS));
    expect(manifest.behaviour.lots.uri).toBe(`https://${RUNTIMES[0].host}/lots.json`);
    expect(config.endpoints.gatewayUrl).toMatch(/^https:\/\//);
  });

  test('the host of the medium and of the large runtime follow from the lots host of the example, as the compose file and the Caddy block name them', () => {
    const ends = endpointsOf(exampleEnv.LOTS_PUBLIC_ORIGIN);
    expect(LOT_NAMES.map((lot) => ends[lot])).toStrictEqual(RUNTIMES.map((runtime) => `https://${runtime.host}`));
  });

  test('the example as it is does not start the service: it stops at the key, so that a step that was forgotten leaves no service that answers', () => {
    expect(() => loadConfig({ ...exampleEnv, ...serviceContainerEnv })).toThrow(/^environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX is required/);
    expect(() => loadConfig({ ...filled(exampleEnv), ...serviceContainerEnv, SERVICE_AUTH_HEADER: '' })).toThrow(/^environment variable SERVICE_AUTH_HEADER is required/);
    expect(() => loadConfig({ ...filled(exampleEnv), ...serviceContainerEnv, SMALL_SUPPLIER_PKH: '' })).toThrow(/^environment variable SMALL_SUPPLIER_PKH is required/);
  });

  test('a start that names the service key in the supplier lines is refused by the real code: the key of the service and the key of a runtime are two keys', () => {
    const clash = { ...filled(exampleEnv), ...serviceContainerEnv, SMALL_SUPPLIER_PKH: SERVICE_KEY.pkh, SMALL_SUPPLIER_PUB_KEY_HEX: SERVICE_KEY.pubKeyHex };
    expect(() => loadConfig(clash)).toThrow(/ORDER_DESK_SERVICE_PRIV_KEY_HEX holds the key of SMALL_SUPPLIER_PKH/);
    const shared = { ...filled(exampleEnv), ...serviceContainerEnv, MEDIUM_SUPPLIER_PKH: SMALL.pkh, MEDIUM_SUPPLIER_PUB_KEY_HEX: SMALL.pubKeyHex };
    expect(() => loadConfig(shared)).toThrow(/MEDIUM_SUPPLIER_PKH names the key of SMALL_SUPPLIER_PKH: each runtime has a key of its own/);
  });
});

// --- the Caddy block -----------------------------------------------------------------------------------------------------------------------------------

const BEGIN = '# order-desk vhosts (BEGIN)';
const END = '# order-desk vhosts (END)';

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

/** What is wrong with the Caddy block. An empty list is a pass. */
function caddyProblems(text: string): string[] {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, at) => (line === BEGIN ? [at] : []));
  const ends = lines.flatMap((line, at) => (line === END ? [at] : []));
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) return [`the file must hold the line "${BEGIN}" one time, and after it the line "${END}" one time`];
  const problems: string[] = [];
  const outside = [...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)].filter((line) => line.trim() !== '' && !line.trim().startsWith('#'));
  if (outside.length > 0) problems.push('only comments stand outside the two markers: the lines between them are what a command adds, replaces and removes');
  const tree = caddyTree(lines.slice(begins[0] + 1, ends[0]));
  if (tree === null) return [...problems, 'the braces between the markers do not balance'];
  const hosts = RUNTIMES.map((runtime) => runtime.host);
  if (!same(tree.map((node) => node.head), hosts)) problems.push(`the blocks must be the three host names in this order: ${hosts.join(', ')}; found: ${tree.map((node) => node.head).join(', ')}`);
  for (const runtime of RUNTIMES) {
    const block = tree.find((node) => node.head === runtime.host);
    if (block === undefined) continue;
    const wanted = [['handle /agent.json', SERVICE_UPSTREAM], ['handle /lots.json', SERVICE_UPSTREAM], ['handle', `${runtime.container}:${RUNTIME_PORT}`]];
    const found = block.children.map((child) => [child.head, child.children.map((inner) => [inner.head, inner.children.length])]);
    if (!same(found, wanted.map(([head, upstream]) => [head, [[`reverse_proxy ${upstream}`, 0]]]))) {
      problems.push(`${runtime.host}: the block must send /agent.json and /lots.json to ${SERVICE_UPSTREAM} and every other path to ${runtime.container}:${RUNTIME_PORT}, with nothing else in it; found: ${JSON.stringify(found)}`);
    }
  }
  return problems;
}

describe('deploy/server/Caddyfile.order-desk.snippet', () => {
  test('the real block passes: three host names between the markers, each sending the manifest and the lots file to the service and the rest to its own runtime', () => {
    expect(caddyProblems(snippetText)).toStrictEqual([]);
    const lines = snippetText.split('\n');
    expect(lines.filter((line) => line === BEGIN)).toHaveLength(1);
    expect(lines.filter((line) => line === END)).toHaveLength(1);
  });

  test('the upstreams are the container names and the container ports of the compose file, and the hosts are the origins that the compose file and the example name', () => {
    const compose = parse(composeText) as Model;
    const tree = caddyTree(snippetText.split('\n').slice(snippetText.split('\n').indexOf(BEGIN) + 1, snippetText.split('\n').indexOf(END)))!;
    const upstreamOf = (block: CaddyNode, head: string): string => block.children.find((child) => child.head === head)!.children[0].head.replace(/^reverse_proxy /, '');
    for (const runtime of RUNTIMES) {
      const block = tree.find((node) => node.head === runtime.host)!;
      const service = compose.services[runtime.service] as Model;
      expect(upstreamOf(block, 'handle'), 'the runtime').toBe(`${service.container_name}:${String(service.ports[0]).split(':')[2]}`);
      expect(upstreamOf(block, 'handle /agent.json'), 'the manifest').toBe(`${compose.services.service.container_name}:${String(compose.services.service.ports[0]).split(':')[2]}`);
      expect(upstreamOf(block, 'handle /lots.json'), 'the lots file').toBe(`${compose.services.service.container_name}:${String(compose.services.service.ports[0]).split(':')[2]}`);
      expect(service.environment.PUBLIC_ORIGIN, 'the card of the runtime').toBe(`https://${runtime.host}`);
    }
    expect(entriesOf(exampleText).entries.find((entry) => entry.name === 'LOTS_PUBLIC_ORIGIN')!.value).toBe(`https://${tree[0].head}`);
  });

  const faults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    ['no begin marker', (t) => swap(t, `${BEGIN}\n`, ''), /^the file must hold the line/],
    ['no end marker', (t) => swap(t, `${END}\n`, ''), /^the file must hold the line/],
    ['the markers in the wrong order', (t) => exchange(t, BEGIN, END), /^the file must hold the line/],
    ['a marker twice', (t) => `${t}${BEGIN}\n`, /^the file must hold the line/],
    ['a marker with another name', (t) => swap(t, BEGIN, '# reorder-agent vhosts (BEGIN)'), /^the file must hold the line/],
    ['a block outside the markers', (t) => `${t}extra.example.org {\n    respond 200\n}\n`, /^only comments stand outside the two markers/],
    ['a host name missing', (t) => swap(t, `${RUNTIMES[1].host} {`, 'other.example.org {'), /^the blocks must be the three host names/],
    ['a fourth block', (t) => swap(t, END, `fourth.example.org {\n    handle {\n        reverse_proxy orders-small-runtime:8080\n    }\n}\n${END}`), /^the blocks must be the three host names/],
    ['the blocks in another order', (t) => exchange(t, RUNTIMES[0].host, RUNTIMES[2].host), /^the blocks must be the three host names in this order/],
    ['a host that sends its rest to another runtime', (t) => swap(t, 'reverse_proxy orders-medium-runtime:8080', 'reverse_proxy orders-small-runtime:8080'), new RegExp(`^${escapeRegExp(RUNTIMES[1].host)}: the block must send`)],
    ['the wrong port of a runtime', (t) => swap(t, 'reverse_proxy orders-large-runtime:8080', 'reverse_proxy orders-large-runtime:8104'), new RegExp(`^${escapeRegExp(RUNTIMES[2].host)}: the block must send`)],
    ['a runtime by its address on the host', (t) => swap(t, 'reverse_proxy orders-small-runtime:8080', 'reverse_proxy 127.0.0.1:8102'), new RegExp(`^${escapeRegExp(RUNTIMES[0].host)}: the block must send`)],
    ['the alias of the service in place of its container', (t) => swap(t, 'reverse_proxy orders-service:9102', 'reverse_proxy service:9102'), /: the block must send/],
    ['the wrong port of the service', (t) => swap(t, 'reverse_proxy orders-service:9102', 'reverse_proxy orders-service:9103'), /: the block must send/],
    ['no route for the manifest', (t) => swap(t, 'handle /agent.json {', 'handle /agent {'), /: the block must send/],
    ['no route for the lots file', (t) => swap(t, 'handle /lots.json {', 'handle /lots {'), /: the block must send/],
    ['every path to the service', (t) => swap(t, 'reverse_proxy orders-small-runtime:8080', 'reverse_proxy orders-service:9102'), new RegExp(`^${escapeRegExp(RUNTIMES[0].host)}: the block must send`)],
    ['a path of the job to the service', (t) => swap(t, 'handle /lots.json {', 'handle /precheck {'), /: the block must send/],
    ['a directive that changes the request', (t) => swap(t, '        reverse_proxy orders-small-runtime:8080\n', '        header_up Authorization x\n        reverse_proxy orders-small-runtime:8080\n'), /: the block must send/],
    ['options in the proxy block', (t) => swap(t, 'reverse_proxy orders-small-runtime:8080\n', 'reverse_proxy orders-small-runtime:8080 {\n            header_up X-Test 1\n        }\n'), /: the block must send/],
    ['a redirect before the handles', (t) => swap(t, `${RUNTIMES[0].host} {\n`, `${RUNTIMES[0].host} {\n    redir https://elsewhere.example.org\n`), /: the block must send/],
    ['braces that do not balance', (t) => swap(t, END, `}\n${END}`), /^the braces between the markers do not balance/],
  ];
  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    for (const [what, change, expected] of faults) {
      const problems = caddyProblems(change(snippetText));
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('the twins: tabs in place of spaces, a comment, a blank line and a changed header change nothing', () => {
    const lines = snippetText.split('\n');
    const inside = lines.slice(lines.indexOf(BEGIN), lines.indexOf(END) + 1).join('\n');
    expect(caddyProblems(inside), 'the block alone, with no header').toStrictEqual([]);
    expect(caddyProblems(inside.replace(/^ {4}/gm, '\t').replace(/^ {8}/gm, '\t\t')), 'tabs').toStrictEqual([]);
    expect(caddyProblems(swap(inside, 'handle /agent.json {', '# a note\n\n    handle /agent.json {')), 'a comment and a blank line').toStrictEqual([]);
    expect(caddyProblems(`# another header\n${inside}\n# a footer\n`)).toStrictEqual([]);
  });

  test('the header says how the block gets in: in place, validated, and then a reload; the Caddy container joins the network of the project, and joins again after a new container', () => {
    const header = snippetText.slice(0, snippetText.indexOf(BEGIN));
    for (const part of [NETWORK, 'docker network connect', 'in place', 'validate', 'reload', 'DNS-only', 'RUNBOOK-order-desk.md']) expect(header, part).toContain(part);
  });
});

// --- the runbook ---------------------------------------------------------------------------------------------------------------------------------------

const SECTIONS = [
  'What it is', 'The files', 'The memory gate', 'The DNS records', 'The folder', 'The env files', 'The images', 'Check the compose file', 'The start order', 'The checks', 'The Caddy block',
  'The restart rule', 'The fault switch', 'The failure table', 'Back out',
];

/** The text of a section: from its heading to the next heading of its level. */
function sectionOf(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return '';
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  return next < 0 ? rest : rest.slice(0, next);
}
/** The lines inside fenced blocks, each one trimmed. */
function codeLinesOf(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) inside = !inside;
    else if (inside) out.push(line.trim());
  }
  return out;
}
/** Every distinct match of a pattern in a text. */
const matchesOf = (text: string, pattern: RegExp): string[] => [...new Set([...text.matchAll(pattern)].map((hit) => hit[0]))];

const ENV_NAMES_IN_RUNBOOK = [SHARED_ENV_FILE, ...RUNTIMES.map((runtime) => runtime.envFile), FILES.example, FILES.runtimeExample];
const NAMED_FILES = [...Object.values(FILES), ...ENV_NAMES_IN_RUNBOOK, 'RUNBOOK.md', 'README.md'];
const SERVICE_NAMES = Object.keys(WANT);
const LOOPBACK_PORTS = [...RUNTIMES.map((runtime) => runtime.hostPort), SERVICE_HOST_PORT];
const HEX_RUN = /[0-9a-fA-F]{56,}/g;
const PUBLISHED_RUNS = new Set(Object.values(PUBLISHED).flatMap((value) => value.match(/[0-9a-f]{56,}/g) ?? []));

/** What is wrong with a file of the pack as to key material: a run of hex digits that is not a published value (it could be a key), and the value of a key variable that is written out. */
function keyProblems(text: string, allowed: ReadonlySet<string> = new Set()): string[] {
  const problems: string[] = [];
  if ((text.match(HEX_RUN) ?? []).some((run) => !allowed.has(run))) problems.push('the text has a run of hex digits that is not a published value: it could be a key');
  if (/PRIV_KEY_HEX=[0-9a-fA-F]{8,}/.test(text)) problems.push('the text writes the value of a key');
  return problems;
}

/** What is wrong with the runbook. An empty list is a pass. */
function runbookProblems(text: string): string[] {
  const problems: string[] = [];
  if (!text.startsWith('# Runbook: the Order Desk on the agents host\n')) problems.push('the title must be "Runbook: the Order Desk on the agents host"');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((hit) => hit[1]);
  if (!same(headings, SECTIONS)) problems.push(`the sections must be, in this order: ${SECTIONS.join(', ')}; found: ${headings.join(', ')}`);
  for (const name of matchesOf(text, /(?<![\w.-])(?:docker-compose\.[a-z0-9-]+\.yml|Caddyfile\.[a-z0-9-]+\.snippet|RUNBOOK(?:-[a-z0-9-]+)?\.md|README\.md|\.env\.[A-Za-z0-9._-]*[A-Za-z0-9])/g)) {
    if (!NAMED_FILES.includes(name)) problems.push(`the runbook names ${name}, which is no file of this pack`);
  }
  for (const name of [...Object.values(FILES), ...ENV_NAMES_IN_RUNBOOK]) if (!new RegExp(`(?<![\\w.-])${escapeRegExp(name)}(?![\\w-]|\\.[A-Za-z0-9])`).test(text)) problems.push(`the runbook never names ${name}`);
  const code = codeLinesOf(text);
  for (const line of code) {
    const compose = /\bdocker compose\b.*/.exec(line)?.[0];
    if (compose === undefined) continue;
    if (!compose.includes(`-f ${FILES.compose}`)) problems.push(`a docker compose command names no -f ${FILES.compose}: ${compose}`);
    const verb = /-f \S+ (up|stop|start|logs|ps|rm|config|down|pull)\b([^|)&;]*)/.exec(compose);
    for (const token of (verb?.[2] ?? '').split(/\s+/).filter((part) => part !== '' && !part.startsWith('-'))) {
      if (!SERVICE_NAMES.includes(token)) problems.push(`a docker compose command names the service ${token}, which is no service of this pack`);
    }
    if (/\bconfig\b/.test(compose) && !/--quiet|-q\b/.test(compose) && !line.includes('cd "$scratch" &&')) problems.push('docker compose config prints the environment: run it with --quiet, or in the scratch folder with the stand-in files');
  }
  for (const port of matchesOf(text, /(?:127\.0\.0\.1|localhost):\d+/g)) if (!LOOPBACK_PORTS.includes(Number(port.split(':')[1]))) problems.push(`the runbook names the loopback port ${port}, which is no port of this pack`);
  for (const port of LOOPBACK_PORTS) if (!new RegExp(`\\b${port}\\b`).test(text)) problems.push(`the runbook never names the port ${port}`);
  const containers = [...RUNTIMES.map((runtime) => runtime.container), SERVICE_CONTAINER];
  for (const name of matchesOf(text, /(?<![\w.-])orders-[a-z-]+/g)) if (!containers.includes(name)) problems.push(`the runbook names the container ${name}, which is no container of this pack`);
  for (const name of containers) if (!text.includes(name)) problems.push(`the runbook never names the container ${name}`);
  for (const name of matchesOf(text, /mp-suppliers-[a-z-]+\.vector\.apexfusion\.org/g)) if (!RUNTIMES.some((runtime) => runtime.host === name)) problems.push(`the runbook names the host ${name}, which is no host of this pack`);
  for (const runtime of RUNTIMES) if (!new RegExp(`(?<![\\w.-])${escapeRegExp(runtime.host)}(?![\\w-])`).test(text)) problems.push(`the runbook never names the host ${runtime.host}`);
  if (/\bdocker (?:build|run)\b|--build\b|\bdocker compose[^\n]* (?:build|run)\b/.test(code.join('\n'))) problems.push('the host builds no image and starts no container outside compose');
  if (/\bdown\b[^\n]*(?:\s-v\b|--volumes)/.test(code.join('\n'))) problems.push('down never takes -v: the volume holds the order book and the journal');
  const printing = [/\bcat\s+\S*\.env/, /\bprintenv\b/, /\bdocker inspect\b/, /\bdocker exec\b[^\n]*\b(?:env|printenv)\b/, /\becho\s+"?\$\{?[A-Z_]*PRIV_KEY/];
  for (const pattern of printing) if (code.some((line) => pattern.test(line))) problems.push(`a command prints an env file or an environment: ${pattern.source}`);
  problems.push(...keyProblems(text).map((problem) => `the runbook: ${problem}`));
  return problems;
}

describe('deploy/server/RUNBOOK-order-desk.md', () => {
  test('the real runbook passes: the sections in order, the files, the commands and the numbers of the pack', () => {
    expect(runbookProblems(runbookText)).toStrictEqual([]);
    expect([...runbookText.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(SECTIONS);
  });

  test('the table of the first section gives each runtime its container, port, host name, advert model, price, bonds and lock, as the code of the manifest has them', () => {
    const what = sectionOf(runbookText, 'What it is');
    for (const runtime of RUNTIMES) {
      const row = what.split('\n').find((line) => line.startsWith('|') && line.includes(runtime.container));
      expect(row, `a row for ${runtime.container}`).toBeDefined();
      const cells = row!.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
      const price = LOT_PRICE_LOVELACE[runtime.lot] / 1_000_000;
      const bond = BOND_LOVELACE / 1_000_000;
      expect(cells.slice(1), runtime.container).toStrictEqual([runtime.container, String(runtime.hostPort), runtime.host, runtime.lot, String(price), `${bond} and ${bond}`, String(price + 2 * bond)]);
    }
    expect(what).toContain(INVENTORY_CAPABILITIES.order);
    for (const part of ['480,000', '360,000', '300,000']) expect(what, part).toContain(part);
    expect(what).toContain(String(SERVICE_HOST_PORT));
  });

  test('the files named in the first table are the files of the pack, and the second section lists all of them', () => {
    const files = sectionOf(runbookText, 'The files');
    for (const name of [...Object.values(FILES), ...ENV_NAMES_IN_RUNBOOK]) expect(files, name).toContain(`\`${name}\``);
  });

  test('the memory gate is 1,024 MiB of MemAvailable before each start, and the folder is the one of the pack, owned by the service user with mode 750', () => {
    const gate = sectionOf(runbookText, 'The memory gate');
    for (const part of ['MemAvailable', '1,024 MiB', '/proc/meminfo']) expect(gate, part).toContain(part);
    const folder = sectionOf(runbookText, 'The folder');
    for (const part of ['/srv/agents/order-desk', '750', 'agents', 'sudo install -d -m 750 -o agents -g agents /srv/agents/order-desk']) expect(folder, part).toContain(part);
    expect(folder, 'the folder is made with install: no script of another runbook makes it').not.toContain('setup.sh');
    expect(sectionOf(runbookText, 'The DNS records')).toContain('DNS only');
    for (const runtime of RUNTIMES) expect(sectionOf(runbookText, 'The DNS records'), runtime.host).toContain(runtime.host);
  });

  test('the env files are made with mode 600, one for each runtime, and the keys are never typed or printed: the checks print names and lengths only', () => {
    const files = sectionOf(runbookText, 'The env files');
    for (const part of ['600', 'umask 077', SHARED_ENV_FILE, ...RUNTIMES.map((runtime) => runtime.envFile), '<commit>', 'SERVICE_AUTH_HEADER', 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ADVERT_REF', 'AGENT_ID']) expect(files, part).toContain(part);
    for (const runtime of RUNTIMES) expect(files, runtime.pkhName).toContain(runtime.pkhName);
    expect(files).toMatch(/one pure output of 5 units/);
    expect(files).toMatch(/three wallets/);
  });

  // The operator pack makes the keys, the record, the stakes, the env files and the adverts. The runbook names the task of each result, in the order of the work, and says who does the work.
  test('the first section says that the operator pack makes the keys, the record, the stakes, the env files and the three adverts, with one row for each of the six tasks in the order of the work', () => {
    const what = sectionOf(runbookText, 'What it is');
    expect(what).toContain('The operator pack (`scripts/operator`) makes the keys, the agent record, the stakes, the env files and the three adverts. It is not part of this deploy pack.');
    expect(what).not.toContain('outside this pack');
    expect([...what.matchAll(/^\| `([a-z]+)` \|/gm)].map((hit) => hit[1])).toStrictEqual(['keys', 'fund', 'register', 'stake', 'env', 'advert']);
    expect(what).toContain('The commands of this runbook that make the env files by hand stay as the manual way, and the task `env` does the same work.');
    expect(what.split('\n').find((line) => line.startsWith('| `advert` |'))).toContain('After the service runs and serves its manifest, and before the runtimes start.');
  });

  test('the env files section says that the task env does the same work, and the contact is the address that the live agents publish: the operator types it, and no file of the repository holds it', () => {
    const files = sectionOf(runbookText, 'The env files');
    expect(files).toContain('The task `env` of the operator pack makes these files and fills the same lines. The commands of this section are the manual way.');
    expect(files).toContain('`OPERATOR_CONTACT` (the contact address that the live agents publish; the operator types it, and no file of the repository holds it)');
    expect(runbookText).not.toMatch(/role address|never a person/);
  });

  test('the three adverts are posted with the task advert of the operator pack, and the manual way is the hosted tools', () => {
    const start = sectionOf(runbookText, 'The start order');
    expect(start).toContain('Post the three adverts with the task `advert` of the operator pack.');
    expect(start).not.toContain('This pack does not post them');
  });

  test('the example asks for the contact in angle brackets, and says that the live agents publish it, that the operator types it, and that no file of the repository holds it', () => {
    const lines = exampleText.split('\n');
    const at = lines.findIndex((line) => line.startsWith('OPERATOR_CONTACT='));
    expect(at).toBeGreaterThan(0);
    expect(lines[at]).toMatch(/^OPERATOR_CONTACT=<[^>@]+>$/);
    expect(lines.slice(0, at).filter((line) => line.startsWith('#')).join('\n')).toContain('OPERATOR_CONTACT is required and is published. It is the contact address that the live agents of the operator publish. The operator types it, and no file of the repository holds it.');
    expect(exampleText).not.toMatch(/role address|never the address of a person/);
  });

  test('both images are pulled by the tag of the reviewed commit and pinned by digest, and the three runtimes get one digest', () => {
    const images = sectionOf(runbookText, 'The images');
    for (const part of [SERVICE_IMAGE, RUNTIME_IMAGE, '<full git commit sha>', 'sha256', 'denied', 'read:packages', FILES.compose]) expect(images, part).toContain(part);
    expect(images).toMatch(/three runtimes/);
  });

  test('the compose file is rendered with stand-in files, never with the real env files that hold keys', () => {
    const check = sectionOf(runbookText, 'Check the compose file');
    for (const part of ['scratch', '--quiet', FILES.example, FILES.runtimeExample, 'config']) expect(check, part).toContain(part);
  });

  test('the start order is the service, then the Caddy block and the public checks, then the adverts, then the three runtimes one after the other, each after the memory gate and without its dependencies', () => {
    const start = sectionOf(runbookText, 'The start order');
    const at = (part: string): number => start.indexOf(part);
    const order = [`up -d ${SERVICE_NAME}`, 'The Caddy block', 'adverts', 'up -d --no-deps runtime-small', 'up -d --no-deps runtime-medium', 'up -d --no-deps runtime-large'];
    for (const part of order) expect(at(part), part).toBeGreaterThanOrEqual(0);
    expect(order.map(at)).toStrictEqual([...order.map(at)].sort((a, b) => a - b));
    expect(start).toContain('The memory gate');
    for (const part of [INVENTORY_CAPABILITIES.order, ...LOT_NAMES, '480,000']) expect(start, part).toContain(part);
    expect(start).toContain('detail_hash');
    expect(start).toContain('ADVERT_REF');
  });

  test('the checks cover the four loopback ports, the public ports of the pack, the one hash of the three adverts, the lots file, the card of each runtime and the blank keys', () => {
    const checks = sectionOf(runbookText, 'The checks');
    for (const part of ['/healthz', '/status', 'free', 'manifest-hash.mjs', '/lots.json', '/.well-known/agent-card.json', 'sha256sum', "name='^orders-'", 'docker stats', 'blank']) expect(checks, part).toContain(part);
    for (const runtime of RUNTIMES) expect(checks, runtime.host).toContain(runtime.host);
    for (const port of LOOPBACK_PORTS) expect(checks, String(port)).toContain(String(port));
  });

  test('the Caddy section gives the join of the network, the markers, the in-place append, the validation, the reload and the way back, and never a restart of Caddy', () => {
    const caddy = sectionOf(runbookText, 'The Caddy block');
    for (const part of [`docker network connect ${NETWORK} <caddy container>`, BEGIN, END, '<caddyfile>', 'caddy validate', 'caddy reload', FILES.snippet, 'inode', 'DNS only']) expect(caddy, part).toContain(part);
    expect(caddy).not.toMatch(/caddy restart|docker restart <caddy/);
    expect(caddy).not.toMatch(/\bsed -i\b[^\n]*<caddyfile>/);
  });

  test('the restart rule needs all three runtimes free, names every action that is a restart, and gives the waits of the service', () => {
    const rule = sectionOf(runbookText, 'The restart rule');
    for (const part of ['/status', 'free', 'working', 'docker restart', 'docker compose restart', '--force-recreate', '120', '300', '330', 'SERVICE_AUTH_HEADER', FILES.compose]) expect(rule, part).toContain(part);
    for (const runtime of RUNTIMES) expect(rule, String(runtime.hostPort)).toContain(String(runtime.hostPort));
    expect(rule).toMatch(/all three runtimes/);
    expect(rule).toMatch(/reload/);
    // The steps come in this order: the wait of 2 minutes, then the check of the three runtimes, then the command at once. A check before the wait leaves the whole wait to a new job.
    const steps = ['Wait 2 minutes after the last job', 'for port in 8102 8103 8104', 'up -d --no-deps --force-recreate service'].map((part) => rule.indexOf(part));
    expect(steps.every((at) => at >= 0), 'each step is there').toBe(true);
    expect(steps).toStrictEqual([...steps].sort((a, b) => a - b));
    expect(rule).toContain('at once');
  });

  test('the fault switch is empty, and a failure run sets confirm_wrong_lot in the shared file and creates the service again only when the three runtimes are free, never during a run', () => {
    const fault = sectionOf(runbookText, 'The fault switch');
    expect([...FAULT_MODES['order-desk']]).toStrictEqual(['confirm_wrong_lot']);
    for (const part of ['FAULT_MODE', 'confirm_wrong_lot', SHARED_ENV_FILE, 'up -d --no-deps --force-recreate service', 'free', 'fault_mode']) expect(fault, part).toContain(part);
    expect(fault).toMatch(/never during a run/i);
    expect(fault).toMatch(/empty/);
    // The same order in a failure run: the line first (it changes a file only), then the wait, the check and the command at once, and the same again to end the run.
    const at = (part: string): number => fault.indexOf(part);
    const start = ["sed -i 's/^FAULT_MODE=.*/FAULT_MODE=confirm_wrong_lot/'", 'Wait 2 minutes after the last job', 'up -d --no-deps --force-recreate service'].map(at);
    expect(start.every((place) => place >= 0), 'each step is there').toBe(true);
    expect(start).toStrictEqual([...start].sort((a, b) => a - b));
    expect(at('To end the run')).toBeGreaterThan(0);
    const ending = fault.slice(at('To end the run'));
    const end = ['wait 2 minutes after the last job', 'say `free`', 'at once'].map((part) => ending.indexOf(part));
    expect(end.every((place) => place >= 0), 'each step of the end is there').toBe(true);
    expect(end).toStrictEqual([...end].sort((a, b) => a - b));
  });

  test('the failure table names every refusal code of the hook, the codes after the Claim, the codes of the runtime for the hook, and the start refusals', () => {
    const table = sectionOf(runbookText, 'The failure table');
    const codes = [
      ...COUNTERPARTY_REFUSALS['order-desk'], 'check_unavailable', 'busy', 'supplier_busy', 'unauthorized', 'precheck_missing', 'svid_failed', 'mock_system_failed', 'inference_failed', 'model_output_invalid',
      'store_write_failed', 'deadline', 'internal', 'precheck_timeout', 'precheck_unreachable', 'precheck_failed', 'precheck_bad_status', 'bad_context', 'bad_wire', 'request_too_large', 'bad_shape', 'shutting_down',
    ];
    for (const code of codes) expect(table, code).toContain(`\`${code}\``);
    for (const part of ['cannot start', 'invalid reference format', 'denied', '502', 'order-desk_default', 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'LOTS_PUBLIC_ORIGIN', 'VECTOR_MODULE1_MANIFEST must be pinned to a commit', 'IDENTITY_POLICY_ID']) expect(table, part).toContain(part);
    for (const row of table.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Symptom'))) expect(row.split('|').length, row).toBe(5);
    const hashRow = table.split('\n').find((line) => line.startsWith('| The hash of `/agent.json` is not the `detail_hash` of an advert'));
    expect(hashRow, 'the row of a manifest that changed after the adverts').toBeDefined();
    for (const part of ['Retire the three adverts', '`ADVERT_REF` of its runtime file', 'say `free`', 'up -d --no-deps --force-recreate runtime-<size>']) expect(hashRow, part).toContain(part);
  });

  test('back out retires the three adverts first, waits for the runtimes, removes the Caddy block, stops the containers and keeps the volume', () => {
    const out = sectionOf(runbookText, 'Back out');
    const at = (part: string): number => out.indexOf(part);
    const order = ['Retire', 'free', 'Remove', 'stop', 'volume'];
    for (const part of order) expect(at(part), part).toBeGreaterThanOrEqual(0);
    expect(order.map(at)).toStrictEqual([...order.map(at)].sort((a, b) => a - b));
    expect(out).toContain('order-desk-state');
    expect(out).toContain('docker network disconnect');
  });

  const faults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    ['a section missing', (t) => swap(t, '\n## The fault switch\n', '\n## Another heading\n'), /^the sections must be, in this order/],
    ['the sections in another order', (t) => exchange(t, '\n## The checks\n', '\n## The Caddy block\n'), /^the sections must be, in this order/],
    ['a file of another pack', (t) => `${t}\nSee docker-compose.reorder-agent.yml.\n`, /^the runbook names docker-compose\.reorder-agent\.yml, which is no file of this pack/],
    ['an env file of another agent', (t) => `${t}\nRead .env.reorder-agent.\n`, /^the runbook names \.env\.reorder-agent, which is no file of this pack/],
    ['an env file with no runtime name', (t) => `${t}\nRead .env.order-desk-huge.\n`, /^the runbook names \.env\.order-desk-huge, which is no file of this pack/],
    ['a compose command without the file', (t) => `${t}\n\`\`\`sh\ndocker compose up -d service\n\`\`\`\n`, /a docker compose command names no -f docker-compose\.order-desk\.yml/],
    ['a service that the pack does not have', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.order-desk.yml up -d runtime-huge\n\`\`\`\n`, /names the service runtime-huge/],
    ['a compose config that prints the environment', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.order-desk.yml config\n\`\`\`\n`, /^docker compose config prints the environment/],
    ['a port of another pack', (t) => `${t}\ncurl http://127.0.0.1:8101/healthz\n`, /the loopback port 127\.0\.0\.1:8101/],
    ['a container of another pack', (t) => `${t}\ndocker logs orders-huge-runtime\n`, /the container orders-huge-runtime/],
    ['a host of another pack', (t) => `${t}\nhttps://mp-suppliers-reorder.vector.apexfusion.org\n`, /the host mp-suppliers-reorder\.vector\.apexfusion\.org/],
    ['a build on the host', (t) => `${t}\n\`\`\`sh\ndocker build -t x .\n\`\`\`\n`, /^the host builds no image/],
    ['a container started outside compose', (t) => `${t}\n\`\`\`sh\ndocker run --rm alpine true\n\`\`\`\n`, /^the host builds no image and starts no container outside compose/],
    ['a stop that removes the volume', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.order-desk.yml down -v\n\`\`\`\n`, /^down never takes -v/],
    ['a command that prints an env file', (t) => `${t}\n\`\`\`sh\ncat .env.order-desk-small\n\`\`\`\n`, /^a command prints an env file or an environment/],
    ['a command that prints the environment of a container', (t) => `${t}\n\`\`\`sh\ndocker exec orders-service printenv\n\`\`\`\n`, /^a command prints an env file or an environment/],
    ['a key', (t) => `${t}\nSUPPLIER_PRIV_KEY_HEX=${HEX}\n`, /^the runbook: the text has a run of hex digits/],
  ];
  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    for (const [what, change, expected] of faults) {
      const problems = runbookProblems(change(runbookText));
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('the twins: a command with --quiet, a command in the scratch folder and a comment about a file of the pack are accepted', () => {
    const accepted = `${runbookText}\n\`\`\`sh\ndocker compose -f ${FILES.compose} config --quiet\n(cd "$scratch" && docker compose -f ${FILES.compose} config | grep image)\ndocker compose -f ${FILES.compose} up -d --no-deps runtime-large\n\`\`\`\n`;
    expect(runbookProblems(accepted)).toStrictEqual([]);
    expect(runbookProblems(`${runbookText}\nThe file ${FILES.snippet} holds the block. See RUNBOOK.md and README.md.\n`)).toStrictEqual([]);
  });
});

// --- the whole pack ------------------------------------------------------------------------------------------------------------------------------------

describe('the pack as a whole', () => {
  test('no file of the pack holds key material: no run of hex digits except the published values, and no value written for a key variable', () => {
    for (const [name, text] of [[FILES.compose, composeText], [FILES.example, exampleText], [FILES.runtimeExample, runtimeExampleText], [FILES.snippet, snippetText], [FILES.runbook, runbookText]] as const) {
      expect(keyProblems(text, PUBLISHED_RUNS), name).toStrictEqual([]);
    }
  });

  test('the guard of key material refuses each fault and passes the clean text', () => {
    expect(keyProblems('A clean text with a published value ' + PUBLISHED.IDENTITY_POLICY_ID, PUBLISHED_RUNS)).toStrictEqual([]);
    expect(keyProblems(`A key ${HEX}`)).toStrictEqual(['the text has a run of hex digits that is not a published value: it could be a key']);
    expect(keyProblems(`A key ${HEX}`, new Set([HEX]))).toStrictEqual([]);
    expect(keyProblems('SUPPLIER_PRIV_KEY_HEX=abcdef0123')).toStrictEqual(['the text writes the value of a key']);
    expect(keyProblems('Use ghcr.io/x/y@sha256:<digest>')).toStrictEqual([]);
  });

  test('the hosts, the ports and the container names are the same in the compose file, the Caddy block, the examples and the runbook', () => {
    const compose = parse(composeText) as Model;
    for (const runtime of RUNTIMES) {
      const service = compose.services[runtime.service] as Model;
      expect(service.container_name).toBe(runtime.container);
      expect(service.ports).toStrictEqual([`127.0.0.1:${runtime.hostPort}:${RUNTIME_PORT}`]);
      expect(service.environment.PUBLIC_ORIGIN).toBe(`https://${runtime.host}`);
      expect(snippetText).toContain(`${runtime.host} {`);
      expect(snippetText).toContain(`reverse_proxy ${runtime.container}:${RUNTIME_PORT}`);
      expect(runbookText).toContain(runtime.host);
      expect(runbookText).toContain(runtime.container);
    }
    expect(compose.services.service.container_name).toBe(SERVICE_CONTAINER);
    expect(snippetText).toContain(`reverse_proxy ${SERVICE_UPSTREAM}`);
    expect(compose.services['runtime-small'].environment.SERVICE_URL).toBe(`http://${SERVICE_UPSTREAM}/`);
  });
});
