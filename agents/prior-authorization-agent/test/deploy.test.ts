// agents/prior-authorization-agent/test/deploy.test.ts
// The deploy pack of the Prior Authorization Agent, in deploy/server: the compose file, the env example, the Caddy block and the runbook. Two containers run it: a runtime in front of a service. The runtime holds the
// supplier key, serves the advert and calls the service. The service does the work and holds the seven keys of the agent. Both read one env file.
//
// A guard here takes a text and gives the list of what is wrong with it. The list is empty for the real file, and it names the rule for each copy that breaks one. Each refusal has an accepted twin.
// The question of the pack: can a container start with a key that it must not hold, on a public port, from an image that a tag can move, from a build on the host, or on a network that another container shares?
// No test here uses the network, Docker or the clock. The render of the compose file and the check of the Caddy block need Docker, so they run by hand (RUNBOOK-prior-authorization-agent.md). A few tests run the shell
// commands of the runbook on Linux, in a new folder, with a stand-in for docker: they use sed, awk and od, and they read no secret.
//
// No pattern here is built from the host name, from an image name or from a file name: a constant that looks like a host never flows into `new RegExp`. A message is matched by a pattern literal or by its first words.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { KEY_ROLES } from '../src/serve/keys.ts';
import { JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, STATE_DIR_DEFAULT } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS } from '../src/serve/start.ts';
import { KEY_VARIABLES as KEY_OF_ROLE } from './serve/support.ts';

// --- the files ---------------------------------------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (name: string): string => readFileSync(join(root, 'deploy', 'server', name), 'utf8');
const START_TEXT = readFileSync(new URL('../src/serve/start.ts', import.meta.url), 'utf8');

const FILES = {
  compose: 'docker-compose.prior-authorization-agent.yml',
  example: '.env.prior-authorization-agent.example',
  snippet: 'Caddyfile.prior-authorization-agent.snippet',
  runbook: 'RUNBOOK-prior-authorization-agent.md',
} as const;
/** The env file that the service and the runtime both read. */
const ENV_FILE = '.env.prior-authorization-agent';

const composeText = readPack(FILES.compose);

// --- what the pack says: names, ports, hosts, images ------------------------------------------------------------------------------------------------

const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const RUNTIME_IMAGE = `${REPOSITORY}/agent-runtime`;
const SERVICE_IMAGE = `${REPOSITORY}/prior-authorization-agent`;
const RUNTIME_NAME = 'runtime';
const SERVICE_NAME = 'service';
const RUNTIME_CONTAINER = 'priorauth-runtime';
const SERVICE_CONTAINER = 'priorauth-service';
const PROJECT = 'prior-authorization-agent';
const RUNTIME_PORT = 8080;
const RUNTIME_HOST_PORT = 8105;
const SERVICE_HOST_PORT = PORT_DEFAULT;
const SERVICE_UPSTREAM = `${SERVICE_CONTAINER}:${PORT_DEFAULT}`;
const RUNTIME_UPSTREAM = `${RUNTIME_CONTAINER}:${RUNTIME_PORT}`;
const HOST = 'mp-suppliers-priorauth.vector.apexfusion.org';
const NETWORK = `${PROJECT}_default`;
const VOLUME = 'priorauth-state';
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
const SERVICE_ENVIRONMENT: Readonly<Record<string, string>> = { PORT: String(PORT_DEFAULT), HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '', PRIORAUTH_STATE_DIR: STATE_DIR_DEFAULT };
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
const WANT: Readonly<Record<string, Want>> = {
  [RUNTIME_NAME]: { isService: false, repository: RUNTIME_IMAGE, container: RUNTIME_CONTAINER, hostPort: RUNTIME_HOST_PORT, containerPort: RUNTIME_PORT, environment: RUNTIME_ENVIRONMENT, memLimit: '768m' },
  [SERVICE_NAME]: { isService: true, repository: SERVICE_IMAGE, container: SERVICE_CONTAINER, hostPort: SERVICE_HOST_PORT, containerPort: PORT_DEFAULT, environment: SERVICE_ENVIRONMENT, memLimit: '1024m' },
};

/** True when an image is the repository, then `@sha256:`, then the placeholder or 64 hex digits. A tag, a short digest and the bare name are not. */
function isPinnedImage(image: string, repository: string): boolean {
  const prefix = `${repository}@sha256:`;
  if (!image.startsWith(prefix)) return false;
  const digest = image.slice(prefix.length);
  return digest === '<digest>' || DIGEST_DIGITS.test(digest);
}

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
  if (top.name !== PROJECT) problems.push(`the project name must be ${PROJECT}, so that the default network is ${NETWORK}`);
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
    if (!isPinnedImage(image, want.repository)) own(`image must be ${want.repository}@sha256: and 64 hex digits, or the placeholder <digest>; found: ${image}`);
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

describe('deploy/server/docker-compose.prior-authorization-agent.yml', () => {
  const real = parse(composeText) as Model;

  test('the real file passes: two containers, a runtime in front of a service, each one as the pack says', () => {
    expect(composeProblems(composeText)).toStrictEqual([]);
    expect(Object.keys(real.services)).toStrictEqual([RUNTIME_NAME, SERVICE_NAME]);
    expect([RUNTIME_HOST_PORT, SERVICE_HOST_PORT]).toStrictEqual([8105, 9103]);
    expect(KEY_VARIABLES).toStrictEqual([
      'PRIORAUTH_SERVICE_PRIV_KEY_HEX', 'PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX', 'PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX', 'RECORD_READER_AUTH_PRIV_KEY_HEX', 'RECORD_READER_DELEGATION_PRIV_KEY_HEX',
      'DRAFTER_AUTH_PRIV_KEY_HEX', 'DRAFTER_DELEGATION_PRIV_KEY_HEX',
    ]);
    expect(KEY_VARIABLES, 'the seven keys: three paying keys and the four keys of the two subagents').toStrictEqual(KEY_ROLES.map((role) => KEY_OF_ROLE[role]));
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
      expect(problems.some((p) => p.startsWith('runtime: image must be')), bad).toBe(true);
    }
    for (const bad of [`${SERVICE_IMAGE}:latest`, `${SERVICE_IMAGE}:${'a'.repeat(40)}`, SERVICE_IMAGE, `${SERVICE_IMAGE}@sha256:abc`, `${RUNTIME_IMAGE}@sha256:${digest}`]) {
      const problems = composeProblems(composeWith((c) => { c.services.service.image = bad; }));
      expect(problems.some((p) => p.startsWith('service: image must be')), bad).toBe(true);
    }
  });

  // The faults. Each change breaks one rule, and the guard names it.
  const faults: readonly Fault[] = [
    // A port that is public, or that points at the wrong place.
    ['a public port on the runtime', (t) => swap(t, '127.0.0.1:8105:8080', '8105:8080'), 'runtime: ports must be the one entry 127.0.0.1:8105:8080'],
    ['the address of every interface', (t) => swap(t, '127.0.0.1:8105:8080', '0.0.0.0:8105:8080'), 'runtime: ports must be the one entry 127.0.0.1:8105:8080'],
    ['a port on the address of every interface of version 6', (t) => swap(t, '127.0.0.1:8105:8080', '[::]:8105:8080'), 'runtime: ports must be'],
    ['a second port', (t) => composeWith((c) => { c.services.runtime.ports.push('127.0.0.1:8106:8080'); }), 'runtime: ports must be'],
    ['a port of the service on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:9103:8080']; }), 'runtime: ports must be'],
    ['the wrong port in the container', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8105:9103']; }), 'runtime: ports must be'],
    ['the port of another pack on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8101:8080']; }), 'runtime: ports must be'],
    ['the long form of a port', (t) => composeWith((c) => { c.services.runtime.ports = [{ target: 8080, published: 8105, host_ip: '127.0.0.1' }]; }), 'runtime: ports must be'],
    ['a public port on the service', (t) => swap(t, '127.0.0.1:9103:9103', '9103:9103'), 'service: ports must be the one entry 127.0.0.1:9103:9103'],
    ['the address of every interface on the service', (t) => swap(t, '127.0.0.1:9103:9103', '0.0.0.0:9103:9103'), 'service: ports must be the one entry 127.0.0.1:9103:9103'],
    ['the port of another pack on the service', (t) => composeWith((c) => { c.services.service.ports = ['127.0.0.1:9101:9103']; }), 'service: ports must be'],
    ['no port on the service', (t) => composeWith((c) => { delete c.services.service.ports; }), 'service: ports must be the one entry'],
    ['the host network', (t) => composeWith((c) => { c.services.runtime.network_mode = 'host'; }), 'runtime: network_mode is not allowed'],
    // A build, or a network that another container shares.
    ['a build on the runtime', (t) => composeWith((c) => { c.services.runtime.build = { context: '.' }; }), 'runtime: build is not allowed'],
    ['a build on the service', (t) => composeWith((c) => { c.services.service.build = '.'; }), 'service: build is not allowed'],
    ['a build from the template repository, as the live agents have it', (t) => composeWith((c) => { c.services.runtime.build = { context: 'https://github.com/Apex-Fusion/vector-agent-template.git', dockerfile: 'agent/Dockerfile' }; }), 'runtime: build is not allowed'],
    ['a networks key on the runtime', (t) => composeWith((c) => { c.services.runtime.networks = ['proxy']; }), 'runtime: networks is not allowed'],
    ['a networks key on the service', (t) => composeWith((c) => { c.services.service.networks = ['proxy']; }), 'service: networks is not allowed'],
    ['a networks key at the top', (t) => composeWith((c) => { c.networks = { proxy: { name: 'shared' } }; }), /no top-level networks key/],
    ['the external network of a proxy, on a service and at the top', (t) => composeWith((c) => { c.services.service.networks = ['proxy']; c.networks = { proxy: { external: true } }; }), 'service: networks is not allowed'],
    ['a wrong project name', (t) => swap(t, `name: ${PROJECT}`, 'name: prior-authorization'), `the project name must be ${PROJECT}`],
    ['the project name of another pack', (t) => swap(t, `name: ${PROJECT}`, 'name: reorder-agent'), `the project name must be ${PROJECT}`],
    ['no project name', (t) => composeWith((c) => { delete c.name; }), `the project name must be ${PROJECT}`],
    // The image.
    ['an image by tag', (t) => swap(t, `${RUNTIME_IMAGE}@sha256:<digest>`, `${RUNTIME_IMAGE}:latest`), 'runtime: image must be'],
    ['the service image by tag', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:latest`), 'service: image must be'],
    ['an image by the tag of a commit', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:${'a1'.repeat(20)}`), 'service: image must be'],
    ['a digest that is too short', (t) => swap(t, '<digest>', 'abc123'), /^(runtime|service): image must be/],
    ['an image of another repository', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/insurer-intake-agent@sha256`), 'service: image must be'],
    ['the image of the Reorder Agent', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/reorder-agent@sha256`), 'service: image must be'],
    ['the service image on the runtime', (t) => swap(t, `${RUNTIME_IMAGE}@sha256`, `${SERVICE_IMAGE}@sha256`), 'runtime: image must be'],
    // A key that a container must not hold.
    ...KEY_VARIABLES.flatMap((name): Fault[] => [
      [`a runtime that does not blank ${name}`, (t) => composeWith((c) => { delete c.services.runtime.environment[name]; }), `runtime: ${name} must be blank`],
      [`a runtime that gives ${name} a value`, (t) => composeWith((c) => { c.services.runtime.environment[name] = HEX; }), `runtime: ${name} has a value`],
      [`a service that sets its own key ${name}`, (t) => composeWith((c) => { c.services.service.environment[name] = ''; }), `service: ${name} must not be set here`],
      [`a service that writes its own key ${name}`, (t) => composeWith((c) => { c.services.service.environment[name] = HEX; }), `service: ${name} has a value`],
    ]),
    ['a runtime that sets its own supplier key', (t) => composeWith((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = ''; }), 'runtime: SUPPLIER_PRIV_KEY_HEX must not be set here'],
    ['a runtime that writes its supplier key', (t) => composeWith((c) => { c.services.runtime.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), 'runtime: SUPPLIER_PRIV_KEY_HEX has a value'],
    ['a service that does not blank the supplier key', (t) => composeWith((c) => { delete c.services.service.environment.SUPPLIER_PRIV_KEY_HEX; }), 'service: SUPPLIER_PRIV_KEY_HEX must be blank'],
    ['a service that gives the supplier key a value', (t) => composeWith((c) => { c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; }), 'service: SUPPLIER_PRIV_KEY_HEX has a value'],
    ['a key written in another variable', (t) => composeWith((c) => { c.services.service.environment.OTHER_PRIV_KEY_HEX = HEX; }), 'service: OTHER_PRIV_KEY_HEX has a value'],
    ['a key variable of the Reorder Agent in the runtime', (t) => composeWith((c) => { c.services.runtime.environment.REORDER_SERVICE_PRIV_KEY_HEX = ''; }), 'runtime: REORDER_SERVICE_PRIV_KEY_HEX must not be set here'],
    ['the token in the compose file', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'runtime: SERVICE_AUTH_HEADER is not set by the compose file'],
    ['the token in the service', (t) => composeWith((c) => { c.services.service.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'service: SERVICE_AUTH_HEADER is not set by the compose file'],
    // The env file: one file, read by both, and required.
    ['an env file that is not required', (t) => swap(t, 'required: true', 'required: false'), /^(runtime|service): env_file must be the one file/],
    ['the env file of another pack', (t) => swap(t, `./${ENV_FILE}`, './.env.insurer-intake-agent'), /^(runtime|service): env_file must be the one file/],
    ['a second env file on the runtime', (t) => composeWith((c) => { c.services.runtime.env_file.push({ path: `./${ENV_FILE}-runtime`, required: true }); }), 'runtime: env_file must be the one file'],
    ['an env file as a plain name', (t) => composeWith((c) => { c.services.service.env_file = `./${ENV_FILE}`; }), 'service: env_file must be the one file'],
    ['no env file on the service', (t) => composeWith((c) => { delete c.services.service.env_file; }), 'service: env_file must be the one file'],
    // The address of the service, the check before the Claim, the windows, the card, the release watcher.
    ['a runtime that calls another port of the service', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://${SERVICE_CONTAINER}:9104/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime that calls the service of another pack', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = 'http://intake-service:9103/'; }), 'runtime: SERVICE_URL must be'],
    ['the alias of the service in place of its container', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://service:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['an address of the service on the host', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://127.0.0.1:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime with no check before the Claim', (t) => composeWith((c) => { delete c.services.runtime.environment.SERVICE_PRECHECK_URL; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at another route', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/check`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at the route of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check on the container of another pack', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://reorder-service:${PORT_DEFAULT}/precheck`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a timeout that leaves the window', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '1780000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "1680000"'],
    ['a timeout under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '1620000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "1680000"'],
    ['the timeout of the Insurer Intake Agent', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '360000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "1680000"'],
    ['a window under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '1620000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "1800000"'],
    ['the window of the Insurer Intake Agent', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '480000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "1800000"'],
    ['a window as a number', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = 1800000; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be quoted text'],
    ['a timeout as a number', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = 1680000; }), 'runtime: SERVICE_TIMEOUT_MS must be quoted text'],
    ['a port in the container that the mapping does not publish', (t) => composeWith((c) => { c.services.runtime.environment.PORT = '8081'; }), 'runtime: PORT must be "8080"'],
    ['the card of the runtime on another host name', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = 'https://mp-suppliers-intake.vector.apexfusion.org'; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin that is not https', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `http://${HOST}`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin with a path', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `https://${HOST}/`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no card origin', (t) => composeWith((c) => { delete c.services.runtime.environment.PUBLIC_ORIGIN; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no release watcher', (t) => composeWith((c) => { delete c.services.runtime.environment.RELEASE_WATCHER; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher that is off', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = '0'; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher as a number', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = 1; }), 'runtime: RELEASE_WATCHER must be quoted text'],
    ['the capability kind of another runtime', (t) => composeWith((c) => { c.services.runtime.environment.CAPABILITY_KIND = 'chat'; }), 'runtime: CAPABILITY_KIND must be "custom"'],
    ['a setting that the compose file does not set', (t) => composeWith((c) => { c.services.runtime.environment.LIVE_CHAIN = '1'; }), 'runtime: LIVE_CHAIN is not set by the compose file'],
    ['the switch of the fault in the runtime', (t) => composeWith((c) => { c.services.runtime.environment.FAULT_MODE = 'alter_after_approval'; }), 'runtime: FAULT_MODE is not set by the compose file'],
    // The listener and the state of the service.
    ['a port of the service that the mapping does not publish', (t) => composeWith((c) => { c.services.service.environment.PORT = '9104'; }), 'service: PORT must be "9103"'],
    ['the loopback address inside the container of the service', (t) => composeWith((c) => { c.services.service.environment.HOST = '127.0.0.1'; }), 'service: HOST must be "0.0.0.0"'],
    ['a state directory that is not the volume', (t) => composeWith((c) => { c.services.service.environment.PRIORAUTH_STATE_DIR = '/tmp/state'; }), 'service: PRIORAUTH_STATE_DIR must be "/data"'],
    ['the state directory of another pack', (t) => composeWith((c) => { delete c.services.service.environment.PRIORAUTH_STATE_DIR; c.services.service.environment.REORDER_STATE_DIR = '/data'; }), /^service: (PRIORAUTH_STATE_DIR must be|REORDER_STATE_DIR is not set)/],
    ['the switch of the fault in the service', (t) => composeWith((c) => { c.services.service.environment.FAULT_MODE = ''; }), 'service: FAULT_MODE is not set by the compose file'],
    // The volume, the grace period, the order of the start.
    ['no volume on the service', (t) => composeWith((c) => { delete c.services.service.volumes; }), 'service: volumes must be'],
    ['a folder of the host as the state', (t) => composeWith((c) => { c.services.service.volumes = ['/srv/agents/prior-authorization-agent:/data']; }), 'service: volumes must be'],
    ['a volume of another name', (t) => composeWith((c) => { c.services.service.volumes = ['state:/data']; }), 'service: volumes must be'],
    ['the volume of another pack', (t) => composeWith((c) => { c.services.service.volumes = ['reorder-state:/data']; }), 'service: volumes must be'],
    ['a volume in another folder', (t) => composeWith((c) => { c.services.service.volumes = [`${VOLUME}:/state`]; }), 'service: volumes must be'],
    ['a volume on the runtime', (t) => composeWith((c) => { c.services.runtime.volumes = [`${VOLUME}:/data`]; }), 'runtime: volumes is not allowed'],
    ['a volume that is external', (t) => composeWith((c) => { c.volumes[VOLUME] = { name: VOLUME, external: true }; }), /^volumes must be the one volume/],
    ['a second volume', (t) => composeWith((c) => { c.volumes.other = {}; }), /^volumes must be the one volume/],
    ['a short grace period', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 30s'), 'service: stop_grace_period must be 330s'],
    ['a grace period that equals the wait', (t) => swap(t, 'stop_grace_period: 330s', 'stop_grace_period: 300s'), 'service: stop_grace_period must be 330s'],
    ['no grace period', (t) => composeWith((c) => { delete c.services.service.stop_grace_period; }), 'service: stop_grace_period must be 330s'],
    ['a grace period on the runtime', (t) => composeWith((c) => { c.services.runtime.stop_grace_period = '330s'; }), 'runtime: stop_grace_period is not allowed'],
    ['a runtime that does not wait for the service', (t) => composeWith((c) => { delete c.services.runtime.depends_on; }), 'runtime: depends_on must be [service]'],
    ['a service that waits for the runtime', (t) => composeWith((c) => { c.services.service.depends_on = ['runtime']; }), 'service: depends_on is not allowed'],
    // The shape of the container.
    ['restart always', (t) => swap(t, 'restart: unless-stopped', 'restart: always'), /^(runtime|service): restart must be unless-stopped/],
    ['no memory limit on the runtime', (t) => composeWith((c) => { delete c.services.runtime.mem_limit; }), 'runtime: mem_limit must be 768m'],
    ['a limit of 2 GiB on the runtime', (t) => composeWith((c) => { c.services.runtime.mem_limit = '2048m'; }), 'runtime: mem_limit must be 768m'],
    ['no memory limit on the service', (t) => composeWith((c) => { delete c.services.service.mem_limit; }), 'service: mem_limit must be 1024m'],
    ['a limit of 2 GiB on the service', (t) => composeWith((c) => { c.services.service.mem_limit = '2048m'; }), 'service: mem_limit must be 1024m'],
    ['the capabilities kept', (t) => composeWith((c) => { c.services.runtime.cap_drop = ['NET_RAW']; }), 'runtime: cap_drop must be [ALL]'],
    ['a capability added', (t) => composeWith((c) => { c.services.runtime.cap_add = ['NET_ADMIN']; }), 'runtime: cap_add is not allowed'],
    ['new privileges allowed', (t) => composeWith((c) => { delete c.services.service.security_opt; }), 'service: security_opt must be'],
    ['a privileged container', (t) => composeWith((c) => { c.services.service.privileged = true; }), 'service: privileged is not allowed'],
    ['the process space of the host', (t) => composeWith((c) => { c.services.runtime.pid = 'host'; }), 'runtime: pid is not allowed'],
    ['a device', (t) => composeWith((c) => { c.services.runtime.devices = ['/dev/fuse']; }), 'runtime: devices is not allowed'],
    ['the volumes of another container', (t) => composeWith((c) => { c.services.runtime.volumes_from = ['service']; }), 'runtime: volumes_from is not allowed'],
    ['a read-only file system that the runtime cannot use', (t) => composeWith((c) => { c.services.runtime.read_only = true; }), 'runtime: read_only is not allowed'],
    ['no log limit', (t) => composeWith((c) => { c.services.service.logging.options['max-size'] = '1g'; }), 'service: logging must be'],
    ['the wrong container name', (t) => swap(t, `container_name: ${RUNTIME_CONTAINER}`, `container_name: ${PROJECT}`), `runtime: container_name must be ${RUNTIME_CONTAINER}`],
    ['the wrong name of the service container', (t) => swap(t, `container_name: ${SERVICE_CONTAINER}`, 'container_name: service'), `service: container_name must be ${SERVICE_CONTAINER}`],
    ['the container name of another pack', (t) => swap(t, `container_name: ${SERVICE_CONTAINER}`, 'container_name: reorder-service'), `service: container_name must be ${SERVICE_CONTAINER}`],
    // The services of the file.
    ['a third service', (t) => composeWith((c) => { c.services.other = { image: 'example' }; }), /the file must have the services/],
    ['a missing runtime', (t) => composeWith((c) => { delete c.services.runtime; }), /the file must have the services/],
    ['a missing service', (t) => composeWith((c) => { delete c.services.service; }), /the file must have the services/],
    ['a key at the top that the file does not use', (t) => composeWith((c) => { c.secrets = {}; }), 'the top-level key secrets is not allowed'],
    // The text itself.
    ['a text that is not YAML', (t) => `${t}\n  : : [\n`, 'the file is not valid YAML'],
    ['a key that stands twice in one map', (t) => swap(t, '    restart: unless-stopped\n', '    restart: unless-stopped\n    restart: always\n'), 'the file is not valid YAML'],
  ];

  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(120);
    for (const [what, change, expected] of faults) {
      const problems = composeProblems(change(composeText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a key names the variable and never shows its value', () => {
    const text = composeProblems(composeWith((c) => { c.services.runtime.environment.PRIORAUTH_SERVICE_PRIV_KEY_HEX = HEX; c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; })).join('\n');
    expect(text).toContain('PRIORAUTH_SERVICE_PRIV_KEY_HEX');
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
    const blockForm = swap(composeText, 'ports: ["127.0.0.1:8105:8080"]', 'ports:\n      - "127.0.0.1:8105:8080"');
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
    expect(RUNTIME_UPSTREAM).toBe('priorauth-runtime:8080');
  });
});
