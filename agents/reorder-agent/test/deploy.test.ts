// agents/reorder-agent/test/deploy.test.ts
// The deploy pack of the Reorder Agent, in deploy/server: the compose file, the env example, the Caddy block and the runbook. Two containers run it: a runtime in front of a service. The runtime holds the supplier key, serves
// the advert and calls the service. The service does the work and holds the five keys of the agent. Both read one env file.
//
// A guard here takes a text and gives the list of what is wrong with it. The list is empty for the real file, and it names the rule for each copy that breaks one. Each refusal has an accepted twin.
// The question of the pack: can a container start with a key that it must not hold, on a public port, from an image that a tag can move, from a build on the host, or on a network that another container shares?
// No test here uses the network, Docker or the clock. The render of the compose file and the check of the Caddy block need Docker, so they run by hand (RUNBOOK-reorder-agent.md).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { testKey } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS, loadConfig } from '../src/serve/start.ts';
import { AGENT_DID, CONTACT, KEY_NUMBERS, KEY_VARIABLES as KEY_OF_ROLE, PRINCIPAL, READER_DID, ROLES, SUPPLIER, TOKEN, rawKey } from './serve/support.ts';

// --- the files ---------------------------------------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (name: string): string => readFileSync(join(root, 'deploy', 'server', name), 'utf8');
const START_TEXT = readFileSync(new URL('../src/serve/start.ts', import.meta.url), 'utf8');

const FILES = {
  compose: 'docker-compose.reorder-agent.yml',
  example: '.env.reorder-agent.example',
  snippet: 'Caddyfile.reorder-agent.snippet',
  runbook: 'RUNBOOK-reorder-agent.md',
} as const;
/** The env file that the service and the runtime both read. */
const ENV_FILE = '.env.reorder-agent';

const composeText = readPack(FILES.compose);

// --- what the pack says: names, ports, hosts, images ------------------------------------------------------------------------------------------------

const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const RUNTIME_IMAGE = `${REPOSITORY}/agent-runtime`;
const SERVICE_IMAGE = `${REPOSITORY}/reorder-agent`;
const RUNTIME_NAME = 'runtime';
const SERVICE_NAME = 'service';
const RUNTIME_CONTAINER = 'reorder-runtime';
const SERVICE_CONTAINER = 'reorder-service';
const RUNTIME_PORT = 8080;
const RUNTIME_HOST_PORT = 8101;
const SERVICE_HOST_PORT = PORT_DEFAULT;
const SERVICE_UPSTREAM = `${SERVICE_CONTAINER}:${PORT_DEFAULT}`;
const RUNTIME_UPSTREAM = `${RUNTIME_CONTAINER}:${RUNTIME_PORT}`;
const HOST = 'mp-suppliers-reorder.vector.apexfusion.org';
const NETWORK = 'reorder-agent_default';
const VOLUME = 'reorder-state';
/** The runtime waits this long for the service beyond the deadline of a job. */
const RUNTIME_EXTRA_WAIT_MS = 60_000;
const SERVICE_TIMEOUT_MS = JOB_DEADLINE_MS + RUNTIME_EXTRA_WAIT_MS;
/** The service stops a job at the end of its wait, and compose gives it this much more time to log what it abandoned and to exit. */
const STOP_GRACE = `${SHUTDOWN_WAIT_MS / 1000 + 30}s`;

/** The variables of the service that hold a key: the runtime blanks every one of them. The settings of the service name them, and the start file reads each one in the call that takes it. */
const KEY_VARIABLES = SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'));
const KEY_VARIABLES_OF_THE_START = [...START_TEXT.matchAll(/requiredEnv\('([A-Z0-9_]+_PRIV_KEY_HEX)', env\./g)].map((hit) => hit[1]);

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

/** The text of a copy of the compose file: parsed, changed by `change`, and written again. */
function composeWith(change: (compose: Model) => void): string {
  const copy = structuredClone(parse(composeText)) as Model;
  change(copy);
  return stringify(copy);
}

// --- the compose file ----------------------------------------------------------------------------------------------------------------------------------

/** What the runtime sets in its environment. The compose values win over the env file, so these are the values of the container. Every key variable of the service is blank. */
const RUNTIME_ENVIRONMENT: Readonly<Record<string, string>> = {
  CAPABILITY_KIND: 'custom',
  SERVICE_URL: `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/`,
  SERVICE_PRECHECK_URL: `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/precheck`,
  SERVICE_CONTENT_TYPE: 'application/json',
  SERVICE_TIMEOUT_MS: String(SERVICE_TIMEOUT_MS),
  ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
  PORT: String(RUNTIME_PORT),
  PUBLIC_ORIGIN: `https://${HOST}`,
  RELEASE_WATCHER: '1',
  ...Object.fromEntries(KEY_VARIABLES.map((name) => [name, ''])),
};
/** What the service sets: the listener, the folder of its state, and the one supplier key variable, blank. */
const SERVICE_ENVIRONMENT: Readonly<Record<string, string>> = { PORT: String(PORT_DEFAULT), HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '', REORDER_STATE_DIR: STATE_DIR_DEFAULT };
const LOGGING = { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } };
const KEYS_OF_EVERY_SERVICE = ['image', 'container_name', 'restart', 'env_file', 'environment', 'ports', 'mem_limit', 'cap_drop', 'security_opt', 'logging'];

interface Want {
  readonly isService: boolean;
  readonly repository: string;
  readonly container: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly environment: Readonly<Record<string, string>>;
  readonly memLimit: string;
}
const WANT: Readonly<Record<string, Want>> = {
  [RUNTIME_NAME]: { isService: false, repository: RUNTIME_IMAGE, container: RUNTIME_CONTAINER, hostPort: RUNTIME_HOST_PORT, containerPort: RUNTIME_PORT, environment: RUNTIME_ENVIRONMENT, memLimit: '768m' },
  [SERVICE_NAME]: { isService: true, repository: SERVICE_IMAGE, container: SERVICE_CONTAINER, hostPort: SERVICE_HOST_PORT, containerPort: PORT_DEFAULT, environment: SERVICE_ENVIRONMENT, memLimit: '1024m' },
};

/** What is wrong with the compose file, as text. An empty list is a pass. */
function composeProblems(text: string): string[] {
  let compose: unknown;
  try {
    compose = parse(text);
  } catch {
    return ['the file is not valid YAML, or a key stands twice in one map'];
  }
  const problems: string[] = [];
  const top: Model = isModel(compose) ? compose : {};
  const services: Model = isModel(top.services) ? top.services : {};
  if (top.name !== 'reorder-agent') problems.push(`the project name must be reorder-agent, so that the default network is ${NETWORK}`);
  if ('networks' in top) problems.push('the file has no top-level networks key: the containers stay on the default network of their own project, which no other container shares');
  for (const key of Object.keys(top)) if (!['name', 'services', 'volumes', 'networks'].includes(key)) problems.push(`the top-level key ${key} is not allowed`);
  if (!same(top.volumes, { [VOLUME]: { name: VOLUME } })) problems.push(`volumes must be the one volume ${VOLUME}, with that name`);
  const wanted = Object.keys(WANT);
  if (!same(Object.keys(services).sort(), [...wanted].sort())) problems.push(`the file must have the services ${wanted.join(', ')}; it has: ${Object.keys(services).join(', ') || 'none'}`);

  for (const [name, want] of Object.entries(WANT)) {
    const s: unknown = services[name];
    if (!isModel(s)) continue;
    const own = (message: string): void => { problems.push(`${name}: ${message}`); };
    const allowed = new Set(want.isService ? [...KEYS_OF_EVERY_SERVICE, 'volumes', 'stop_grace_period'] : [...KEYS_OF_EVERY_SERVICE, 'depends_on']);
    for (const key of Object.keys(s)) {
      if (key === 'build') own('build is not allowed: the host builds no image, CI builds it');
      else if (key === 'networks') own('networks is not allowed: the container stays on the default network of its own project, which no other container shares');
      else if (key === 'depends_on' && want.isService) own('depends_on is not allowed: the service waits for nobody');
      else if (!allowed.has(key)) own(`${key} is not allowed`);
    }
    const image = String(s.image ?? '');
    if (!new RegExp(`^${escapeRegExp(want.repository)}@sha256:(?:<digest>|[0-9a-f]{64})$`).test(image)) own(`image must be ${want.repository}@sha256: and 64 hex digits, or the placeholder <digest>; found: ${image}`);
    if (s.container_name !== want.container) own(`container_name must be ${want.container}`);
    if (s.restart !== 'unless-stopped') own('restart must be unless-stopped');
    if (!same(s.ports, [`127.0.0.1:${want.hostPort}:${want.containerPort}`])) own(`ports must be the one entry 127.0.0.1:${want.hostPort}:${want.containerPort}; found: ${JSON.stringify(s.ports)}`);
    if (!same(s.env_file, [{ path: `./${ENV_FILE}`, required: true }])) own(`env_file must be the one file ./${ENV_FILE}, and it must be required`);
    if (s.mem_limit !== want.memLimit) own(`mem_limit must be ${want.memLimit}`);
    if (!same(s.cap_drop, ['ALL'])) own('cap_drop must be [ALL]');
    if (!same(s.security_opt, ['no-new-privileges:true'])) own('security_opt must be ["no-new-privileges:true"]');
    if (!same(s.logging, LOGGING)) own('logging must be json-file with 3 files of 10m');
    if (want.isService) {
      if (!same(s.volumes, [`${VOLUME}:${STATE_DIR_DEFAULT}`])) own(`volumes must be the one entry ${VOLUME}:${STATE_DIR_DEFAULT}`);
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
      else if (!(variable in want.environment)) own(/PRIV_KEY_HEX$/.test(variable) ? `${variable} must not be set here: a container reads its own key from its env file` : `${variable} is not set by the compose file`);
    }
    for (const [variable, value] of Object.entries(want.environment)) {
      const found = environment[variable];
      if (value === '' && /PRIV_KEY_HEX$/.test(variable)) {
        if (found !== '') own(`${variable} must be blank (""): ${want.isService ? 'the service holds no supplier key' : 'the runtime holds no key of the service'}`);
      } else if (found !== value) {
        own(SECRET_NAME.test(variable) ? `${variable} must be ${JSON.stringify(value)}` : `${variable} must be ${JSON.stringify(value)}; found: ${JSON.stringify(found)}`);
      }
    }
  }
  return problems;
}

describe('deploy/server/docker-compose.reorder-agent.yml', () => {
  const real = parse(composeText) as Model;

  test('the real file passes: two containers, a runtime in front of a service, each one as the pack says', () => {
    expect(composeProblems(composeText)).toStrictEqual([]);
    expect(Object.keys(real.services)).toStrictEqual([RUNTIME_NAME, SERVICE_NAME]);
    expect([RUNTIME_HOST_PORT, SERVICE_HOST_PORT]).toStrictEqual([8101, 9101]);
    expect(KEY_VARIABLES).toStrictEqual(['REORDER_SERVICE_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX']);
  });

  test('the images are named by digest: the placeholder or 64 hex digits, never a tag', () => {
    const digest = 'ab'.repeat(32);
    const pinned = composeWith((c) => {
      for (const [name, want] of Object.entries(WANT)) c.services[name].image = `${want.repository}@sha256:${digest}`;
    });
    expect(composeProblems(pinned), 'the images with a digest of 64 hex digits').toStrictEqual([]);
    expect(composeText.match(/@sha256:<digest>/g)).toHaveLength(2);
    for (const bad of [`${RUNTIME_IMAGE}:latest`, `${RUNTIME_IMAGE}:${'a'.repeat(40)}`, RUNTIME_IMAGE, `${RUNTIME_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${'AB'.repeat(32)}`, `${SERVICE_IMAGE}@sha256:${digest}`]) {
      const problems = composeProblems(composeWith((c) => { c.services.runtime.image = bad; }));
      expect(problems.some((p) => /^runtime: image must be/.test(p)), bad).toBe(true);
    }
    for (const bad of [`${SERVICE_IMAGE}:latest`, `${SERVICE_IMAGE}:${'a'.repeat(40)}`, SERVICE_IMAGE, `${SERVICE_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${digest}`]) {
      const problems = composeProblems(composeWith((c) => { c.services.service.image = bad; }));
      expect(problems.some((p) => /^service: image must be/.test(p)), bad).toBe(true);
    }
  });

  // The faults. Each change breaks one rule, and the guard names it.
  const faults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    // A port that is public, or that points at the wrong place.
    ['a public port on the runtime', (t) => swap(t, '127.0.0.1:8101:8080', '8101:8080'), /^runtime: ports must be the one entry 127\.0\.0\.1:8101:8080/],
    ['the address of every interface', (t) => swap(t, '127.0.0.1:8101:8080', '0.0.0.0:8101:8080'), /^runtime: ports must be the one entry 127\.0\.0\.1:8101:8080/],
    ['a port on the address of every interface of version 6', (t) => swap(t, '127.0.0.1:8101:8080', '[::]:8101:8080'), /^runtime: ports must be/],
    ['a second port', (t) => composeWith((c) => { c.services.runtime.ports.push('127.0.0.1:8105:8080'); }), /^runtime: ports must be/],
    ['a port of the service on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:9101:8080']; }), /^runtime: ports must be/],
    ['the wrong port in the container', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8101:9101']; }), /^runtime: ports must be/],
    ['the long form of a port', (t) => composeWith((c) => { c.services.runtime.ports = [{ target: 8080, published: 8101, host_ip: '127.0.0.1' }]; }), /^runtime: ports must be/],
    ['a public port on the service', (t) => swap(t, '127.0.0.1:9101:9101', '9101:9101'), /^service: ports must be the one entry 127\.0\.0\.1:9101:9101/],
    ['the address of every interface on the service', (t) => swap(t, '127.0.0.1:9101:9101', '0.0.0.0:9101:9101'), /^service: ports must be the one entry 127\.0\.0\.1:9101:9101/],
    ['no port on the service', (t) => composeWith((c) => { delete c.services.service.ports; }), /^service: ports must be the one entry/],
    ['the host network', (t) => composeWith((c) => { c.services.runtime.network_mode = 'host'; }), /^runtime: network_mode is not allowed/],
    // A build, or a network that another container shares.
    ['a build on the runtime', (t) => composeWith((c) => { c.services.runtime.build = { context: '.' }; }), /^runtime: build is not allowed/],
    ['a build on the service', (t) => composeWith((c) => { c.services.service.build = '.'; }), /^service: build is not allowed/],
    ['a build from the template repository, as the live agents have it', (t) => composeWith((c) => { c.services.runtime.build = { context: 'https://github.com/Apex-Fusion/vector-agent-template.git', dockerfile: 'agent/Dockerfile' }; }), /^runtime: build is not allowed/],
    ['a networks key on the runtime', (t) => composeWith((c) => { c.services.runtime.networks = ['proxy']; }), /^runtime: networks is not allowed/],
    ['a networks key on the service', (t) => composeWith((c) => { c.services.service.networks = ['proxy']; }), /^service: networks is not allowed/],
    ['a networks key at the top', (t) => composeWith((c) => { c.networks = { proxy: { name: 'shared' } }; }), /no top-level networks key/],
    ['the external network of a proxy, on a service and at the top', (t) => composeWith((c) => { c.services.service.networks = ['proxy']; c.networks = { proxy: { external: true } }; }), /^service: networks is not allowed/],
    ['a wrong project name', (t) => swap(t, 'name: reorder-agent', 'name: reorder'), /the project name must be reorder-agent/],
    ['no project name', (t) => composeWith((c) => { delete c.name; }), /the project name must be reorder-agent/],
    // The image.
    ['an image by tag', (t) => swap(t, `${RUNTIME_IMAGE}@sha256:<digest>`, `${RUNTIME_IMAGE}:latest`), /^runtime: image must be/],
    ['the service image by tag', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:latest`), /^service: image must be/],
    ['a digest that is too short', (t) => swap(t, '<digest>', 'abc123'), /^(runtime|service): image must be/],
    ['an image of another repository', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/order-desk@sha256`), /^service: image must be/],
    ['the service image on the runtime', (t) => swap(t, `${RUNTIME_IMAGE}@sha256`, `${SERVICE_IMAGE}@sha256`), /^runtime: image must be/],
    // A key that a container must not hold.
    ...KEY_VARIABLES.flatMap((name): Array<readonly [string, (text: string) => string, RegExp]> => [
      [`a runtime that does not blank ${name}`, (t) => composeWith((c) => { delete c.services.runtime.environment[name]; }), new RegExp(`^runtime: ${name} must be blank`)],
      [`a runtime that gives ${name} a value`, (t) => composeWith((c) => { c.services.runtime.environment[name] = HEX; }), new RegExp(`^runtime: ${name} has a value`)],
      [`a service that sets its own key ${name}`, (t) => composeWith((c) => { c.services.service.environment[name] = ''; }), new RegExp(`^service: ${name} must not be set here`)],
      [`a service that writes its own key ${name}`, (t) => composeWith((c) => { c.services.service.environment[name] = HEX; }), new RegExp(`^service: ${name} has a value`)],
    ]),
    ['a runtime that sets its own supplier key', (t) => composeWith((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = ''; }), /^runtime: SUPPLIER_PRIV_KEY_HEX must not be set here/],
    ['a runtime that writes its supplier key', (t) => composeWith((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), /^runtime: SUPPLIER_PRIV_KEY_HEX has a value/],
    ['a service that does not blank the supplier key', (t) => composeWith((c) => { delete c.services.service.environment.SUPPLIER_PRIV_KEY_HEX; }), /^service: SUPPLIER_PRIV_KEY_HEX must be blank/],
    ['a service that gives the supplier key a value', (t) => composeWith((c) => { c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), /^service: SUPPLIER_PRIV_KEY_HEX has a value/],
    ['a key written in another variable', (t) => composeWith((c) => { c.services.service.environment.OTHER_PRIV_KEY_HEX = HEX; }), /^service: OTHER_PRIV_KEY_HEX has a value/],
    ['the token in the compose file', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), /^runtime: SERVICE_AUTH_HEADER is not set by the compose file/],
    ['the token in the service', (t) => composeWith((c) => { c.services.service.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), /^service: SERVICE_AUTH_HEADER is not set by the compose file/],
    // The env file: one file, read by both, and required.
    ['an env file that is not required', (t) => swap(t, 'required: true', 'required: false'), /^(runtime|service): env_file must be the one file/],
    ['the env file of another pack', (t) => swap(t, `./${ENV_FILE}`, './.env.order-desk'), /^(runtime|service): env_file must be the one file/],
    ['a second env file on the runtime', (t) => composeWith((c) => { c.services.runtime.env_file.push({ path: './.env.reorder-agent-runtime', required: true }); }), /^runtime: env_file must be the one file/],
    ['an env file as a plain name', (t) => composeWith((c) => { c.services.service.env_file = `./${ENV_FILE}`; }), /^service: env_file must be the one file/],
    ['no env file on the service', (t) => composeWith((c) => { delete c.services.service.env_file; }), /^service: env_file must be the one file/],
    // The address of the service, the check before the Claim, the windows, the card, the release watcher.
    ['a runtime that calls another port of the service', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = 'http://reorder-service:9102/'; }), /^runtime: SERVICE_URL must be/],
    ['the alias of the service in place of its container', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = 'http://service:9101/'; }), /^runtime: SERVICE_URL must be/],
    ['an address of the service on the host', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = 'http://127.0.0.1:9101/'; }), /^runtime: SERVICE_URL must be/],
    ['a runtime with no check before the Claim', (t) => composeWith((c) => { delete c.services.runtime.environment.SERVICE_PRECHECK_URL; }), /^runtime: SERVICE_PRECHECK_URL must be/],
    ['a check at another route', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = 'http://reorder-service:9101/check'; }), /^runtime: SERVICE_PRECHECK_URL must be/],
    ['a check at the route of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = 'http://reorder-service:9101/'; }), /^runtime: SERVICE_PRECHECK_URL must be/],
    ['a timeout that leaves the window', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '1780000'; }), /^runtime: SERVICE_TIMEOUT_MS must be "1680000"/],
    ['a timeout under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '1620000'; }), /^runtime: SERVICE_TIMEOUT_MS must be "1680000"/],
    ['a window under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '1620000'; }), /^runtime: ADVERT_MAX_PROCESSING_MS must be "1800000"/],
    ['the window of the Order Desk', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '480000'; }), /^runtime: ADVERT_MAX_PROCESSING_MS must be "1800000"/],
    ['a window as a number', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = 1800000; }), /^runtime: ADVERT_MAX_PROCESSING_MS must be quoted text/],
    ['a timeout as a number', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = 1680000; }), /^runtime: SERVICE_TIMEOUT_MS must be quoted text/],
    ['a port in the container that the mapping does not publish', (t) => composeWith((c) => { c.services.runtime.environment.PORT = '8081'; }), /^runtime: PORT must be "8080"/],
    ['the card of the runtime on another host name', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = 'https://mp-suppliers-orders-small.vector.apexfusion.org'; }), /^runtime: PUBLIC_ORIGIN must be/],
    ['an origin that is not https', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `http://${HOST}`; }), /^runtime: PUBLIC_ORIGIN must be/],
    ['an origin with a path', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `https://${HOST}/`; }), /^runtime: PUBLIC_ORIGIN must be/],
    ['no card origin', (t) => composeWith((c) => { delete c.services.runtime.environment.PUBLIC_ORIGIN; }), /^runtime: PUBLIC_ORIGIN must be/],
    ['no release watcher', (t) => composeWith((c) => { delete c.services.runtime.environment.RELEASE_WATCHER; }), /^runtime: RELEASE_WATCHER must be "1"/],
    ['a release watcher that is off', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = '0'; }), /^runtime: RELEASE_WATCHER must be "1"/],
    ['a release watcher as a number', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = 1; }), /^runtime: RELEASE_WATCHER must be quoted text/],
    ['the capability kind of another runtime', (t) => composeWith((c) => { c.services.runtime.environment.CAPABILITY_KIND = 'chat'; }), /^runtime: CAPABILITY_KIND must be "custom"/],
    ['a setting that the compose file does not set', (t) => composeWith((c) => { c.services.runtime.environment.LIVE_CHAIN = '1'; }), /^runtime: LIVE_CHAIN is not set by the compose file/],
    // The listener and the state of the service.
    ['a port of the service that the mapping does not publish', (t) => composeWith((c) => { c.services.service.environment.PORT = '9102'; }), /^service: PORT must be "9101"/],
    ['the loopback address inside the container of the service', (t) => composeWith((c) => { c.services.service.environment.HOST = '127.0.0.1'; }), /^service: HOST must be "0\.0\.0\.0"/],
    ['a state directory that is not the volume', (t) => composeWith((c) => { c.services.service.environment.REORDER_STATE_DIR = '/tmp/state'; }), /^service: REORDER_STATE_DIR must be "\/data"/],
    // The volume, the grace period, the order of the start.
    ['no volume on the service', (t) => composeWith((c) => { delete c.services.service.volumes; }), /^service: volumes must be/],
    ['a folder of the host as the state', (t) => composeWith((c) => { c.services.service.volumes = ['/srv/agents/reorder-agent:/data']; }), /^service: volumes must be/],
    ['a volume of another name', (t) => composeWith((c) => { c.services.service.volumes = ['state:/data']; }), /^service: volumes must be/],
    ['a volume in another folder', (t) => composeWith((c) => { c.services.service.volumes = ['reorder-state:/state']; }), /^service: volumes must be/],
    ['a volume on the runtime', (t) => composeWith((c) => { c.services.runtime.volumes = ['reorder-state:/data']; }), /^runtime: volumes is not allowed/],
    ['a volume that is external', (t) => composeWith((c) => { c.volumes['reorder-state'] = { name: 'reorder-state', external: true }; }), /^volumes must be the one volume/],
    ['a second volume', (t) => composeWith((c) => { c.volumes.other = {}; }), /^volumes must be the one volume/],
    ['a short grace period', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 30s'), /^service: stop_grace_period must be 330s/],
    ['a grace period that equals the wait', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 300s'), /^service: stop_grace_period must be 330s/],
    ['no grace period', (t) => composeWith((c) => { delete c.services.service.stop_grace_period; }), /^service: stop_grace_period must be 330s/],
    ['a runtime that does not wait for the service', (t) => composeWith((c) => { delete c.services.runtime.depends_on; }), /^runtime: depends_on must be \[service\]/],
    ['a service that waits for the runtime', (t) => composeWith((c) => { c.services.service.depends_on = ['runtime']; }), /^service: depends_on is not allowed/],
    // The shape of the container.
    ['restart always', (t) => swap(t, 'restart: unless-stopped', 'restart: always'), /^(runtime|service): restart must be unless-stopped/],
    ['no memory limit on the runtime', (t) => composeWith((c) => { delete c.services.runtime.mem_limit; }), /^runtime: mem_limit must be 768m/],
    ['a limit of 2 GiB on the runtime', (t) => composeWith((c) => { c.services.runtime.mem_limit = '2048m'; }), /^runtime: mem_limit must be 768m/],
    ['no memory limit on the service', (t) => composeWith((c) => { delete c.services.service.mem_limit; }), /^service: mem_limit must be 1024m/],
    ['a limit of 2 GiB on the service', (t) => composeWith((c) => { c.services.service.mem_limit = '2048m'; }), /^service: mem_limit must be 1024m/],
    ['the capabilities kept', (t) => composeWith((c) => { c.services.runtime.cap_drop = ['NET_RAW']; }), /^runtime: cap_drop must be \[ALL\]/],
    ['a capability added', (t) => composeWith((c) => { c.services.runtime.cap_add = ['NET_ADMIN']; }), /^runtime: cap_add is not allowed/],
    ['new privileges allowed', (t) => composeWith((c) => { delete c.services.service.security_opt; }), /^service: security_opt must be/],
    ['a privileged container', (t) => composeWith((c) => { c.services.service.privileged = true; }), /^service: privileged is not allowed/],
    ['the process space of the host', (t) => composeWith((c) => { c.services.runtime.pid = 'host'; }), /^runtime: pid is not allowed/],
    ['a device', (t) => composeWith((c) => { c.services.runtime.devices = ['/dev/fuse']; }), /^runtime: devices is not allowed/],
    ['the volumes of another container', (t) => composeWith((c) => { c.services.runtime.volumes_from = ['service']; }), /^runtime: volumes_from is not allowed/],
    ['a read-only file system that the runtime cannot use', (t) => composeWith((c) => { c.services.runtime.read_only = true; }), /^runtime: read_only is not allowed/],
    ['no log limit', (t) => composeWith((c) => { c.services.service.logging.options['max-size'] = '1g'; }), /^service: logging must be/],
    ['the wrong container name', (t) => swap(t, 'container_name: reorder-runtime', 'container_name: reorder-agent'), /^runtime: container_name must be reorder-runtime/],
    ['the wrong name of the service container', (t) => swap(t, 'container_name: reorder-service', 'container_name: service'), /^service: container_name must be reorder-service/],
    // The services of the file.
    ['a third service', (t) => composeWith((c) => { c.services.other = { image: 'example' }; }), /the file must have the services/],
    ['a missing runtime', (t) => composeWith((c) => { delete c.services.runtime; }), /the file must have the services/],
    ['a missing service', (t) => composeWith((c) => { delete c.services.service; }), /the file must have the services/],
    ['a key at the top that the file does not use', (t) => composeWith((c) => { c.secrets = {}; }), /the top-level key secrets is not allowed/],
    // The text itself.
    ['a text that is not YAML', (t) => `${t}\n  : : [\n`, /^the file is not valid YAML/],
    ['a key that stands twice in one map', (t) => swap(t, '    restart: unless-stopped\n', '    restart: unless-stopped\n    restart: always\n'), /^the file is not valid YAML/],
  ];

  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(110);
    for (const [what, change, expected] of faults) {
      const problems = composeProblems(change(composeText));
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a key names the variable and never shows its value', () => {
    const text = composeProblems(composeWith((c) => { c.services.runtime.environment.REORDER_SERVICE_PRIV_KEY_HEX = HEX; c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; })).join('\n');
    expect(text).toContain('REORDER_SERVICE_PRIV_KEY_HEX');
    expect(text).toContain('SUPPLIER_PRIV_KEY_HEX');
    expect(text).not.toContain(HEX);
    const wrongToken = composeProblems(composeWith((c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = `Bearer ${HEX}`; })).join('\n');
    expect(wrongToken).not.toContain(HEX);
  });

  test('the twins: a map in another key order, the file written again and a digest of 64 hex digits are accepted, and a list in place of a map is refused', () => {
    expect(composeProblems(stringify(parse(composeText))), 'the file written again').toStrictEqual([]);
    const reordered = composeWith((c) => {
      for (const name of [RUNTIME_NAME, SERVICE_NAME]) c.services[name].environment = Object.fromEntries(Object.entries(c.services[name].environment as Record<string, string>).reverse());
    });
    expect(composeProblems(reordered), 'the environment in the opposite order').toStrictEqual([]);
    const blockForm = swap(composeText, 'ports: ["127.0.0.1:8101:8080"]', 'ports:\n      - "127.0.0.1:8101:8080"');
    expect(composeProblems(blockForm), 'a port in the block form of a list').toStrictEqual([]);
    const asList = composeWith((c) => { c.services.runtime.environment = Object.entries(c.services.runtime.environment).map(([name, value]) => `${name}=${String(value)}`); });
    expect(composeProblems(asList)).toStrictEqual(['runtime: environment must be a map of names to quoted text']);
  });

  test('the key variables of the start file are the ones that the runtime blanks: a second key in the start file needs a second blank in the runtime', () => {
    expect(KEY_VARIABLES_OF_THE_START).toStrictEqual(KEY_VARIABLES);
    const environment = real.services.runtime.environment as Record<string, string>;
    for (const name of KEY_VARIABLES) expect(environment[name], `the runtime blanks ${name}`).toBe('');
    expect('SUPPLIER_PRIV_KEY_HEX' in environment, 'the runtime sets no supplier key').toBe(false);
    expect((real.services.service.environment as Record<string, string>).SUPPLIER_PRIV_KEY_HEX).toBe('');
    for (const name of KEY_VARIABLES) expect(name in real.services.service.environment, `the service does not set ${name}`).toBe(false);
    for (const service of Object.values(real.services) as Model[]) {
      for (const [name, value] of Object.entries(service.environment as Record<string, string>)) if (/PRIV_KEY_HEX$/.test(name)) expect(value, `no container writes ${name}`).toBe('');
    }
  });

  test('the windows nest: the deadline of a job is inside the timeout of the runtime, which is inside the window of the advert with 60 s to spare', () => {
    expect([MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]).toStrictEqual([1_800_000, 1_680_000, 1_620_000]);
    expect(JOB_DEADLINE_MS).toBeLessThan(SERVICE_TIMEOUT_MS);
    expect(SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
    const environment = real.services.runtime.environment as Record<string, string>;
    expect(Number(environment.SERVICE_TIMEOUT_MS)).toBeLessThanOrEqual(Number(environment.ADVERT_MAX_PROCESSING_MS) - 60_000);
    expect(Number(environment.SERVICE_TIMEOUT_MS)).toBeGreaterThan(JOB_DEADLINE_MS);
  });

  test('the runtime and the service read the one env file, and the runtime starts after the service', () => {
    for (const name of [RUNTIME_NAME, SERVICE_NAME]) expect(real.services[name].env_file).toStrictEqual([{ path: `./${ENV_FILE}`, required: true }]);
    expect(real.services.runtime.depends_on).toStrictEqual([SERVICE_NAME]);
    expect(real.services.runtime.environment.SERVICE_URL).toBe(`http://${SERVICE_UPSTREAM}/`);
    expect(real.services.runtime.environment.SERVICE_PRECHECK_URL).toBe(`http://${SERVICE_UPSTREAM}/precheck`);
  });

  test('the comment of the file says where the digests come from and that no network is joined', () => {
    expect(composeText).toContain(FILES.runbook);
    expect(composeText).toContain(NETWORK);
    expect(composeText.split('\n').filter((line) => /^\s*(networks|build):/.test(line))).toStrictEqual([]);
    expect(RUNTIME_UPSTREAM).toBe('reorder-runtime:8080');
  });
});

// --- the env example -----------------------------------------------------------------------------------------------------------------------------------

const exampleText = readPack(FILES.example);

/** The names of the tool that posts an advert. The operator posts the advert with the hosted tools, and the runtime reads the reference of its advert as ADVERT_REF. ADVERT_PRICE_LOVELACE is not among them: it is a setting of the service. */
const POST_ADVERT_NAMES = ['ADVERT_MODEL', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'] as const;
/** The four supplier lines: the runtime holds the key and the wallet, and the service reads the two public lines to publish them. */
const SUPPLIER_LINES = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'] as const;
/** The five keys of the service, each one followed by its key hash. */
const KEY_LINES = KEY_VARIABLES.flatMap((name) => [name, name.replace('_PRIV_KEY_HEX', '_PKH')]);
/** The names that the runtime reads from an env file (the template of the runtime). The last one is optional: the runtime has its own default. */
const RUNTIME_READS = [
  'SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS', 'NETWORK_ID', 'OGMIOS_URL', 'VECTOR_ZERO_TIME_MS', 'LIVE_CHAIN', 'ESCROW_REF_UTXO', 'ADVERT_REF_UTXO',
  'IDENTITY_ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_POLICY_ID', 'AGENT_ID', 'ADVERT_REF', 'CAPABILITY_KIND', 'SERVICE_URL', 'SERVICE_PRECHECK_URL', 'SERVICE_AUTH_HEADER',
  'SERVICE_CONTENT_TYPE', 'SERVICE_TIMEOUT_MS', 'ADVERT_MAX_PROCESSING_MS', 'PUBLIC_ORIGIN', 'RELEASE_WATCHER', 'PORT', 'WALLET_HEALTH_INTERVAL_MS',
] as const;
const OPTIONAL_NAMES: readonly string[] = ['WALLET_HEALTH_INTERVAL_MS'];
/** The values that are public chain data: the network, the node, the time of slot 0, the legacy scripts, and the identity registry that Vector mainnet published (the deployment of 2026-11-03). The example holds these and no other value of that shape. */
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
/** The values that this pack chooses: the terms of the advert, the model hire of the decisions as Advocate has it (one model, price 1, both bonds 2 at most), the hire of the Order Desk (price 10, both bonds 2 at most), and the stake of a challenge as the least stake of a claim. */
const CHOSEN: Readonly<Record<string, string>> = {
  AGENT_STATUS_CHIP: 'proposed',
  FAULT_MODE: '',
  ADVERT_PRICE_LOVELACE: String(PRICE_DEFAULT_LOVELACE),
  ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
  HANDOFF_MAX_PRICE_LOVELACE: '10000000',
  HANDOFF_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  HANDOFF_MAX_BUYER_BOND_LOVELACE: '2000000',
  DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
  DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
  DISPUTE_READ_TIMEOUT_MS: '20000',
};
/** The lines that an operator has to fill: a value in angle brackets stands for what the operator supplies. */
const PLACEHOLDER_NAMES = ['OPERATOR_CONTACT', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST'];
const MODULE1_MANIFEST = /^https:\/\/raw\.githubusercontent\.com\/Apex-Fusion\/vector-agent-modules\/(?:<commit>|[0-9a-f]{40})\/Module-1\/deploy\/identity\/mainnet\/manifest\.json$/;
/** Lines whose value stays empty in the example: a key, a key hash, a line that the operator fills later, and a line for which the code has a default. */
const EMPTY_LINES = [
  ...SUPPLIER_LINES, ...KEY_LINES, 'AGENT_ID', 'ADVERT_REF', 'IDENTITY_ADDRESS', 'AGENT_DID', 'STOCK_READER_DID', 'AGENT_VERSION', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'FAULT_MODE',
  'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL', 'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS',
  'COSIGN_LEDGER_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
];
/** The first line of each block, in the order of the blocks: the supplier key, the five keys, the token, the chain, the identity registry, the Module-1 manifest, the services that are read, the mock systems, the terms of the advert, the manifest, the hires, the co-sign route, the dispute code, the fault switch. */
const BLOCK_STARTS = [
  'SUPPLIER_PRIV_KEY_HEX', 'REORDER_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'NETWORK_ID', 'IDENTITY_POLICY_ID', 'VECTOR_MODULE1_MANIFEST', 'VECTOR_OGMIOS_URL', 'MOCK_PUBLIC_BASE', 'ADVERT_PRICE_LOVELACE',
  'OPERATOR_CONTACT', 'LLM_MODEL_ALLOWLIST', 'HANDOFF_MAX_PRICE_LOVELACE', 'COSIGN_ALLOWLIST', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'FAULT_MODE',
];
/** The names that stand in the compose file and in the example too: the window of the advert (the compose file gives it to the runtime, and the service reads it from the file), the supplier key line (the service blanks it) and the five key lines (the runtime blanks them). */
const BOTH = ['ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PRIV_KEY_HEX', ...KEY_VARIABLES];

/** The values that the guards of the other deploy files hold as the published values of the identity registry. */
const IDENTITY_MAINNET: Readonly<Record<string, string>> = Object.fromEntries(
  [...(/const IDENTITY_MAINNET = \{([\s\S]*?)\n\};/.exec(readFileSync(join(root, 'scripts', 'deploy.test.mjs'), 'utf8'))?.[1] ?? '').matchAll(/^\s*([A-Z_]+): '([^']+)',?$/gm)].map((hit) => [hit[1], hit[2]]),
);

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

/** What is wrong with the example. An empty list is a pass. */
function exampleProblems(text: string, compose: Model = parse(composeText) as Model): string[] {
  const { entries, problems: lineProblems } = entriesOf(text);
  const problems: string[] = [...lineProblems];
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (seen.has(name)) problems.push(`${name} is listed twice`);
    seen.add(name);
  }
  const value = (name: string): string | undefined => entries.find((entry) => entry.name === name)?.value;
  const allowed = new Set<string>([...SETTINGS, ...RUNTIME_READS]);
  // A name that the compose file sets wins over the env file, so the example does not repeat it. The names of BOTH are the exception.
  const setByCompose = composeSetNames(compose);
  for (const { name, value: given } of entries) {
    if ((POST_ADVERT_NAMES as readonly string[]).includes(name)) problems.push(`${name} is a name of the advert tool: the operator posts the advert, and the example holds no such name`);
    else if (!allowed.has(name)) problems.push(`${name} is no setting of the service and no setting of the runtime`);
    if (SECRET_NAME.test(name) && !emptyValue(given)) problems.push(`${name} must be empty`);
    const published = Object.hasOwn(PUBLISHED, name) && PUBLISHED[name] === given;
    if (!published && KEY_SHAPED.some((shape) => shape.test(given))) problems.push(`${name} looks like key material`);
    if (setByCompose.has(name) && !BOTH.includes(name)) problems.push(`${name} is set by the compose file, which wins: a line here would do nothing`);
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
  const manifest = value('VECTOR_MODULE1_MANIFEST');
  if (manifest !== undefined && !MODULE1_MANIFEST.test(manifest)) problems.push('VECTOR_MODULE1_MANIFEST must be an https address of the Module-1 manifest, pinned to a commit: the placeholder <commit> or 40 hex digits');
  const token = value('SERVICE_AUTH_HEADER');
  if (token !== undefined && token !== '""') problems.push('SERVICE_AUTH_HEADER must be "" (quoted and empty): the value has a space, so it needs quotes');
  const names = entries.map((entry) => entry.name);
  if (!same(names.slice(0, SUPPLIER_LINES.length + KEY_LINES.length), [...SUPPLIER_LINES, ...KEY_LINES])) problems.push('the example must start with the four supplier lines and then the five keys of the service, each one followed by its key hash');
  const starts = BLOCK_STARTS.map((name) => names.indexOf(name));
  if (starts.some((at, index) => at >= 0 && starts.slice(0, index).some((before) => before > at))) problems.push(`the blocks must follow this order: ${BLOCK_STARTS.join(', ')}`);
  return problems;
}

/** Appends one line at the end of a text. */
const withLine = (text: string, line: string): string => `${text.endsWith('\n') ? text : `${text}\n`}${line}\n`;
/** The text with the value of one name replaced. A name that the text does not hold stops the test. */
function withValue(text: string, name: string, value: string): string {
  const line = new RegExp(`^${name}=.*$`, 'm');
  expect(line.test(text), `the text has a line for ${name}`).toBe(true);
  return text.replace(line, () => `${name}=${value}`);
}
/** The text without the line of one name. */
function without(text: string, name: string): string {
  const line = new RegExp(`^${name}=.*\n`, 'm');
  expect(line.test(text), `the text has a line for ${name}`).toBe(true);
  return text.replace(line, '');
}

describe('deploy/server/.env.reorder-agent.example', () => {
  test('the real example passes: the settings of the service and the names of the runtime, each one once, every secret empty, the published values as published', () => {
    expect(exampleProblems(exampleText)).toStrictEqual([]);
    const { entries } = entriesOf(exampleText);
    expect(entries.length).toBeGreaterThan(60);
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(new Set<string>([...SETTINGS, ...RUNTIME_READS]).has(name), name).toBe(true);
    for (const name of [...SUPPLIER_LINES, ...KEY_LINES, 'SERVICE_AUTH_HEADER']) expect(emptyValue(entries.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example holds the four supplier lines first, then the five keys with their key hashes, and the lines of the runtime that stay empty: the reference of the advert and the agent identifier', () => {
    const names = entriesOf(exampleText).entries.map((entry) => entry.name);
    expect(names.slice(0, 14)).toStrictEqual([
      'SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS',
      'REORDER_SERVICE_PRIV_KEY_HEX', 'REORDER_SERVICE_PKH', 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PKH', 'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PKH',
      'STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_AUTH_PKH', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PKH',
    ]);
    expect(names[14]).toBe('SERVICE_AUTH_HEADER');
    expect(names.at(-1)).toBe('FAULT_MODE');
    const { entries } = entriesOf(exampleText);
    for (const name of ['ADVERT_REF', 'AGENT_ID']) expect(entries.find((entry) => entry.name === name)!.value, name).toBe('');
  });

  test('the names that the example leaves out of the settings of the service are the three that the compose file sets, and the names that it adds are the ones that only the runtime reads', () => {
    const names = new Set(entriesOf(exampleText).entries.map((entry) => entry.name));
    expect(SETTINGS.filter((name) => !names.has(name))).toStrictEqual(['PORT', 'HOST', 'REORDER_STATE_DIR']);
    expect([...names].filter((name) => !(SETTINGS as readonly string[]).includes(name)).sort()).toStrictEqual([
      'ADVERT_REF', 'ADVERT_REF_UTXO', 'AGENT_ID', 'ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_ESCROW_REF_UTXO', 'LIVE_CHAIN', 'NETWORK_ID', 'OGMIOS_URL', 'SUPPLIER_ADDRESS', 'SUPPLIER_PRIV_KEY_HEX',
      'VECTOR_ZERO_TIME_MS',
    ]);
  });

  test('a name of the advert tool is refused one at a time, and the unchanged example is accepted', () => {
    expect(exampleProblems(exampleText), 'the example as it is').toStrictEqual([]);
    for (const name of POST_ADVERT_NAMES) {
      const problems = exampleProblems(withLine(exampleText, `${name}=`));
      expect(problems.some((problem) => problem === `${name} is a name of the advert tool: the operator posts the advert, and the example holds no such name`), `${name}: ${JSON.stringify(problems)}`).toBe(true);
    }
    expect(exampleProblems(exampleText).some((problem) => /ADVERT_PRICE_LOVELACE/.test(problem)), 'the price of the advert is a setting of the service, so it stays').toBe(false);
  });

  const faults: ReadonlyArray<readonly [string, (text: string) => string, RegExp]> = [
    // A key, a token or an address in a line that must stay empty.
    ['a key in the line of the supplier key', (t) => withValue(t, 'SUPPLIER_PRIV_KEY_HEX', HEX), /^SUPPLIER_PRIV_KEY_HEX must be empty/],
    ...KEY_VARIABLES.map((name): readonly [string, (text: string) => string, RegExp] => [`a key in the line of ${name}`, (t) => withValue(t, name, HEX), new RegExp(`^${name} must be empty`)]),
    ['a token in the token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`), /^SERVICE_AUTH_HEADER must be empty/],
    ['an unquoted token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', ''), /^SERVICE_AUTH_HEADER must be "" \(quoted and empty\)/],
    ['a key in the line of a public key', (t) => withValue(t, 'SUPPLIER_PUB_KEY_HEX', HEX), /^SUPPLIER_PUB_KEY_HEX (must be empty|looks like key material)/],
    ['a key hash in the line of the supplier', (t) => withValue(t, 'SUPPLIER_PKH', 'cd'.repeat(28)), /^SUPPLIER_PKH (must be empty|looks like key material)/],
    ['a key hash in a line of the service', (t) => withValue(t, 'REORDER_SERVICE_PKH', 'cd'.repeat(28)), /^REORDER_SERVICE_PKH (must be empty|looks like key material)/],
    ['an address in the line of the wallet', (t) => withValue(t, 'SUPPLIER_ADDRESS', 'addr1qxyz'), /^SUPPLIER_ADDRESS (must be empty|looks like key material)/],
    ['a key in a line that is not its own', (t) => withValue(t, 'AGENT_DID', HEX), /^AGENT_DID (must be empty|looks like key material)/],
    ['a reference of an advert in the example', (t) => withValue(t, 'ADVERT_REF', `${HEX}#0`), /^ADVERT_REF (must be empty|looks like key material)/],
    ['an agent identifier in the example', (t) => withValue(t, 'AGENT_ID', HEX), /^AGENT_ID (must be empty|looks like key material)/],
    // A name that the compose file sets: its value wins, so a line here does nothing.
    ...['PORT=9101', 'HOST=0.0.0.0', 'REORDER_STATE_DIR=/data', 'CAPABILITY_KIND=custom', 'SERVICE_URL=http://reorder-service:9101/', 'SERVICE_PRECHECK_URL=http://reorder-service:9101/precheck', 'SERVICE_CONTENT_TYPE=application/json',
      'SERVICE_TIMEOUT_MS=1680000', `PUBLIC_ORIGIN=https://${HOST}`, 'RELEASE_WATCHER=1'].map((line): readonly [string, (text: string) => string, RegExp] => [
      `a line for a name that the compose file sets: ${line.split('=')[0]}`, (t) => withLine(t, line), new RegExp(`^${line.split('=')[0]} is set by the compose file, which wins`),
    ]),
    // A name that the example must not hold, and a line that is no setting.
    ['a name that is no setting', (t) => withLine(t, 'SOMETHING_ELSE=1'), /^SOMETHING_ELSE is no setting of the service and no setting of the runtime/],
    ['a name twice', (t) => withLine(t, 'FAULT_MODE='), /^FAULT_MODE is listed twice/],
    ['a line that is no NAME=value', (t) => withLine(t, 'name = value'), /is not a comment and not NAME=value/],
    // A line that is missing.
    ['a missing line of the mock systems', (t) => without(t, 'MOCK_MTLS_BASE'), /^MOCK_MTLS_BASE is missing/],
    ['a missing line of the runtime', (t) => without(t, 'LIVE_CHAIN'), /^LIVE_CHAIN is missing/],
    ['a missing line of the reference of the advert', (t) => without(t, 'ADVERT_REF'), /^ADVERT_REF is missing/],
    ['a missing supplier key line', (t) => without(t, 'SUPPLIER_PRIV_KEY_HEX'), /^SUPPLIER_PRIV_KEY_HEX is missing/],
    ['a missing key line of the service', (t) => without(t, 'STOCK_READER_AUTH_PRIV_KEY_HEX'), /^STOCK_READER_AUTH_PRIV_KEY_HEX is missing/],
    ['a missing line of the allowlist', (t) => without(t, 'COSIGN_ALLOWLIST'), /^COSIGN_ALLOWLIST is missing/],
    ['a missing line of the stock reader', (t) => without(t, 'STOCK_READER_DID'), /^STOCK_READER_DID is missing/],
    ['a missing limit of the hire of the Order Desk', (t) => without(t, 'HANDOFF_MAX_PRICE_LOVELACE'), /^HANDOFF_MAX_PRICE_LOVELACE is missing/],
    ['a missing fault switch', (t) => without(t, 'FAULT_MODE'), /^FAULT_MODE is missing/],
    // A value that the pack fixes.
    ['a fault switch that is on', (t) => withValue(t, 'FAULT_MODE', 'confirm_wrong_lot'), /^FAULT_MODE must be ""/],
    ['a status word of a live service', (t) => withValue(t, 'AGENT_STATUS_CHIP', 'live'), /^AGENT_STATUS_CHIP must be "proposed"/],
    ['a window under the deadline of a job', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '1620000'), /^ADVERT_MAX_PROCESSING_MS must be "1800000"/],
    ['the window of the Order Desk', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '480000'), /^ADVERT_MAX_PROCESSING_MS must be "1800000"/],
    ['another price of the advert', (t) => withValue(t, 'ADVERT_PRICE_LOVELACE', '5000000'), /^ADVERT_PRICE_LOVELACE must be "3000000"/],
    ['another policy of the identity registry', (t) => withValue(t, 'IDENTITY_POLICY_ID', '0'.repeat(56)), /^IDENTITY_POLICY_ID must be/],
    ['another vault script', (t) => withValue(t, 'VECTOR_IDENTITY_VAULT_REF_UTXO', `${HEX}#0`), /^VECTOR_IDENTITY_VAULT_REF_UTXO must be/],
    ['another escrow script of the runtime', (t) => withValue(t, 'IDENTITY_ESCROW_REF_UTXO', `${HEX}#0`), /^IDENTITY_ESCROW_REF_UTXO must be/],
    ['a runtime that cannot write to the chain', (t) => withValue(t, 'LIVE_CHAIN', '0'), /^LIVE_CHAIN must be "1"/],
    ['a placeholder where the pack gives a value', (t) => withValue(t, 'LLM_MAX_PRICE_LOVELACE', '<price>'), /^LLM_MAX_PRICE_LOVELACE must be "1000000"/],
    ['a limit that the model hire does not take', (t) => withValue(t, 'LLM_MAX_BUYER_BOND_LOVELACE', '5000000'), /^LLM_MAX_BUYER_BOND_LOVELACE must be "2000000"/],
    ['a limit that the hire of the Order Desk does not take', (t) => withValue(t, 'HANDOFF_MAX_PRICE_LOVELACE', '1000000'), /^HANDOFF_MAX_PRICE_LOVELACE must be "10000000"/],
    ['a stake that no claim reaches', (t) => withValue(t, 'DISPUTE_CHALLENGE_STAKE_LOVELACE', '1000000'), /^DISPUTE_CHALLENGE_STAKE_LOVELACE must be "50000000"/],
    ['a resolution deadline in the example', (t) => withValue(t, 'DISPUTE_RESOLUTION_DEADLINE_MS', '259200000'), /^DISPUTE_RESOLUTION_DEADLINE_MS must be empty in the example/],
    ['an allowlist with a principal in the example', (t) => withValue(t, 'COSIGN_ALLOWLIST', 'ab'.repeat(28)), /^COSIGN_ALLOWLIST (must be empty in the example|looks like key material)/],
    ['a limit of the co-sign route in the example', (t) => withValue(t, 'COSIGN_MAX_CONCURRENT', '64'), /^COSIGN_MAX_CONCURRENT must be empty in the example/],
    // A Module-1 manifest that is not pinned, and a placeholder that is not the pack's.
    ['a Module-1 manifest that no commit pins', (t) => swap(t, '/<commit>/', '/main/'), /^VECTOR_MODULE1_MANIFEST must be an https address of the Module-1 manifest, pinned to a commit/],
    ['a Module-1 manifest as a file', (t) => withValue(t, 'VECTOR_MODULE1_MANIFEST', '/etc/manifest.json'), /^VECTOR_MODULE1_MANIFEST must be an https address/],
    ['a Module-1 manifest on http', (t) => swap(t, 'VECTOR_MODULE1_MANIFEST=https://', 'VECTOR_MODULE1_MANIFEST=http://'), /^VECTOR_MODULE1_MANIFEST must be an https address/],
    ['a placeholder in another line', (t) => withValue(t, 'AGENT_DID', '<did>'), /^the lines with a placeholder must be/],
    ['no placeholder where the operator fills a value', (t) => withValue(t, 'OPERATOR_CONTACT', 'ops'), /^the lines with a placeholder must be/],
    // The order of the blocks.
    ['the token before the keys', (t) => exchange(t, '\nSERVICE_AUTH_HEADER=""\n', '\nREORDER_SERVICE_PRIV_KEY_HEX=\n'), /^the (blocks must follow this order|example must start with)/],
    ['the chain after the terms of the advert', (t) => exchange(t, '\nNETWORK_ID=1\n', '\nADVERT_PRICE_LOVELACE=3000000\n'), /^the blocks must follow this order/],
    ['the fault switch before the dispute code', (t) => exchange(t, '\nFAULT_MODE=\n', '\nDISPUTE_CHALLENGE_STAKE_LOVELACE=50000000\n'), /^the blocks must follow this order/],
    ['a key hash before its key', (t) => swap(t, '\nREORDER_SERVICE_PRIV_KEY_HEX=\nREORDER_SERVICE_PKH=\n', '\nREORDER_SERVICE_PKH=\nREORDER_SERVICE_PRIV_KEY_HEX=\n'), /^the example must start with/],
  ];
  test('each copy of the example that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(55);
    for (const [what, change, expected] of faults) {
      const problems = exampleProblems(change(exampleText));
      expect(problems.some((problem) => expected.test(problem)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a secret line never shows the value that it found', () => {
    const text = exampleProblems(withValue(withValue(exampleText, 'REORDER_SERVICE_PRIV_KEY_HEX', HEX), 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`)).join('\n');
    expect(text).toContain('REORDER_SERVICE_PRIV_KEY_HEX');
    expect(text).toContain('SERVICE_AUTH_HEADER');
    expect(text).not.toContain(HEX);
  });

  test('the published values are the ones that the guards of the other deploy files hold for the identity registry', () => {
    expect(Object.keys(IDENTITY_MAINNET).sort()).toStrictEqual(['IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_ESCROW_REF_UTXO', 'IDENTITY_POLICY_ID', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO', 'VECTOR_IDENTITY_LEGACY_ROOT']);
    const values = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value]));
    for (const [name, wanted] of Object.entries(IDENTITY_MAINNET)) {
      expect(PUBLISHED[name], `the pack holds ${name} as published`).toBe(wanted);
      expect(values[name], `the example holds ${name} as published`).toBe(wanted);
    }
  });

  test('no name of the compose file is repeated in the example with another value: the names in both are the window of the advert, the supplier key line and the five key lines', () => {
    const compose = parse(composeText) as Model;
    const both = entriesOf(exampleText).entries.filter((entry) => composeSetNames(compose).has(entry.name));
    expect(both.map((entry) => entry.name).sort()).toStrictEqual([...BOTH].sort());
    expect(compose.services.runtime.environment.ADVERT_MAX_PROCESSING_MS).toBe(both.find((entry) => entry.name === 'ADVERT_MAX_PROCESSING_MS')!.value);
    for (const name of ['SUPPLIER_PRIV_KEY_HEX', ...KEY_VARIABLES]) expect(emptyValue(both.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  // The proof that the example is the real thing: the example, filled in with the values that an operator gives, and joined with what the compose file sets for the service, is the environment that the service reads at
  // start. The real start code accepts it.
  const filled = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
    ...env,
    OPERATOR_CONTACT: CONTACT,
    AGENT_DID,
    STOCK_READER_DID: READER_DID,
    ...Object.fromEntries(ROLES.map((role) => [KEY_OF_ROLE[role], rawKey(KEY_NUMBERS[role])])),
    SERVICE_AUTH_HEADER: TOKEN,
    SUPPLIER_PKH: SUPPLIER.keyHash,
    SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey,
    MOCK_PUBLIC_BASE: 'https://mock.example.test',
    MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
    VECTOR_MODULE1_MANIFEST: swap(env.VECTOR_MODULE1_MANIFEST ?? '', '<commit>', 'a'.repeat(40)),
  });
  const exampleEnv = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value === '""' ? '' : entry.value]));
  const containerEnv = (service: string): Record<string, string> => (parse(composeText) as Model).services[service].environment as Record<string, string>;

  test('the example, filled in and joined with the environment that the compose file gives the service, starts the real configuration of the service', () => {
    const config = loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) });
    expect([config.port, config.host, config.stateDir, config.fault.mode]).toStrictEqual([9101, '0.0.0.0', '/data', '']);
    expect(config.agentDid).toBe(AGENT_DID);
    expect(config.stockReaderDid).toBe(READER_DID);
    expect(config.cosign.allowlist.size, 'the allowlist of the example holds nobody').toBe(0);
    expect(config.modelLimits).toMatchObject({ maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.modelLimits.allowlist).toStrictEqual(['deepseek/deepseek-v4-flash']);
    expect(config.handoffLimits).toMatchObject({ maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.dispute).toMatchObject({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    const manifest = JSON.parse(config.manifest.text) as { terms: Record<string, number>; status: { chip: string } };
    expect(manifest.terms).toMatchObject({ price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 1_800_000 });
    expect(manifest.status.chip).toBe('proposed');
  });

  test('the example as it is does not start the service: it stops at the first key, and at each line that the operator forgot', () => {
    expect(() => loadConfig({ ...exampleEnv, ...containerEnv(SERVICE_NAME) })).toThrow(/^environment variable REORDER_SERVICE_PRIV_KEY_HEX is required/);
    const forgotten: ReadonlyArray<readonly [string, string | undefined, RegExp]> = [
      ['SERVICE_AUTH_HEADER', '', /^environment variable SERVICE_AUTH_HEADER is required/],
      ['AGENT_DID', '', /^environment variable AGENT_DID is required/],
      ['STOCK_READER_DID', '', /^environment variable STOCK_READER_DID is required/],
      ['SUPPLIER_PKH', '', /^environment variable SUPPLIER_PKH is required/],
      ['MOCK_PUBLIC_BASE', exampleEnv.MOCK_PUBLIC_BASE, /^environment variable MOCK_PUBLIC_BASE must be an https origin/],
      ['MOCK_MTLS_BASE', exampleEnv.MOCK_MTLS_BASE, /^environment variable MOCK_MTLS_BASE must be an https origin/],
      ['VECTOR_MODULE1_MANIFEST', exampleEnv.VECTOR_MODULE1_MANIFEST, /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/],
      ['COSIGN_ALLOWLIST', undefined, /^the settings of the co-sign route are refused: COSIGN_ALLOWLIST is not set/],
    ];
    for (const [name, value, expected] of forgotten) {
      expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), [name]: value }), name).toThrow(expected);
    }
    expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), FAULT_MODE: 'confirm_wrong_lot' }), 'a fault value of the Order Desk').toThrow(/^environment variable FAULT_MODE must be empty/);
  });

  test('a principal on the allowlist is read as one, a key hash line that is not the hash of its key stops the start, and the right hash is accepted', () => {
    const config = loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), COSIGN_ALLOWLIST: PRINCIPAL.keyHash });
    expect(config.cosign.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    const own = testKey(KEY_NUMBERS.service).keyHash;
    expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), REORDER_SERVICE_PKH: 'cd'.repeat(28) })).toThrow(/^environment variable REORDER_SERVICE_PKH \(56 characters\) is not the key hash of the key in REORDER_SERVICE_PRIV_KEY_HEX/);
    expect(loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), REORDER_SERVICE_PKH: own }).keys.service.pkh).toBe(own);
  });

  test('the key of the runtime and a key of the service are two keys: the real code refuses a service key that is the supplier key', () => {
    const supplier = testKey(KEY_NUMBERS.service);
    const clash = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), SUPPLIER_PKH: supplier.keyHash, SUPPLIER_PUB_KEY_HEX: supplier.publicKey };
    expect(() => loadConfig(clash)).toThrow(/^environment variable REORDER_SERVICE_PRIV_KEY_HEX holds the key of SUPPLIER_PKH: the supplier key is the runtime's/);
  });

  test('the runtime gets what it needs to boot from the example and the compose file, but its key and the reference of its advert; it holds no key of the service', () => {
    const runtimeEnv: Record<string, string> = { ...exampleEnv, ...containerEnv(RUNTIME_NAME) };
    const empty = ['SUPPLIER_PRIV_KEY_HEX', 'OGMIOS_URL', 'ADVERT_REF', 'NETWORK_ID', 'SERVICE_URL', 'ADVERT_MAX_PROCESSING_MS'].filter((name) => (runtimeEnv[name] ?? '') === '');
    expect(empty).toStrictEqual(['SUPPLIER_PRIV_KEY_HEX', 'ADVERT_REF']);
    for (const name of KEY_VARIABLES) expect(runtimeEnv[name], `the runtime holds no ${name}`).toBe('');
    expect([runtimeEnv.LIVE_CHAIN, runtimeEnv.RELEASE_WATCHER], 'the release watcher needs LIVE_CHAIN').toStrictEqual(['1', '1']);
  });
});
