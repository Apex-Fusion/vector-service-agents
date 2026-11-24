// agents/sourcing-agent/test/deploy.test.ts
// The deploy pack of the Sourcing Agent, in deploy/server: the compose file, the env example, the Caddy block and the runbook. Two containers run it: a runtime in front of a service. The runtime holds the
// supplier key, serves the advert and calls the service. The service does the work and holds the nine keys of the agent. Both read one env file.
//
// A guard here takes a text and gives the list of what is wrong with it. The list is empty for the real file, and it names the rule for each copy that breaks one. Each refusal has an accepted twin.
// The question of the pack: can a container start with a key that it must not hold, on a public port, from an image that a tag can move, from a build on the host, or on a network that another container shares?
// No test here uses the network, Docker or the clock. The render of the compose file and the check of the Caddy block need Docker, so they run by hand (RUNBOOK-sourcing-agent.md).
//
// No pattern here is built from the host name, from an image name or from a file name: a constant that looks like a host never flows into `new RegExp`. A message is matched by a pattern literal or by its first words.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { MODULE1_MANIFEST_ENV } from '@vsa/buyer-core';
import { BID_CAPABILITIES, SOURCING_MODEL } from '@vsa/usecase-kit/bids';
import { COSIGN_STATUS } from '@vsa/usecase-kit/cosign';
import { ERROR_STATUS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import { testKey } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../../../scripts/operator/lib/claim-constants.ts';
import { USE_CASE_NAMES } from '../../../scripts/operator/usecases/names.ts';
import { EXECUTE_FAILURES } from '../src/execute/index.ts';
import { PROPOSE_FAILURES } from '../src/propose/index.ts';
import { QUOTE_CODES } from '../src/quotes/index.ts';
import { SCORING_FAILURES } from '../src/scoring/index.ts';
import { KEY_ROLES } from '../src/serve/keys.ts';
import { BUYER_BOND_LOVELACE, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE } from '../src/serve/settings.ts';
import { SETTINGS, SHUTDOWN_WAIT_MS, loadConfig, startService } from '../src/serve/start.ts';
import { AGENT_DID, CONTACT, ISSUER, KEY_NUMBERS, KEY_VARIABLES as KEY_OF_ROLE, PRINCIPAL, SCORER_DIDS, SUPPLIER, TOKEN, messageOf, rawKey } from './serve/support.ts';

// --- the files ---------------------------------------------------------------------------------------------------------------------------------------

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readPack = (name: string): string => readFileSync(join(root, 'deploy', 'server', name), 'utf8');
const START_TEXT = readFileSync(new URL('../src/serve/start.ts', import.meta.url), 'utf8');

const FILES = {
  compose: 'docker-compose.sourcing-agent.yml',
  example: '.env.sourcing-agent.example',
  snippet: 'Caddyfile.sourcing-agent.snippet',
  runbook: 'RUNBOOK-sourcing-agent.md',
} as const;
/** The env file that the service and the runtime both read. */
const ENV_FILE = '.env.sourcing-agent';

const composeText = readPack(FILES.compose);

// --- what the pack says: names, ports, hosts, images ------------------------------------------------------------------------------------------------

const REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const RUNTIME_IMAGE = `${REPOSITORY}/agent-runtime`;
const SERVICE_IMAGE = `${REPOSITORY}/sourcing-agent`;
const RUNTIME_NAME = 'runtime';
const SERVICE_NAME = 'service';
const RUNTIME_CONTAINER = 'sourcing-runtime';
const SERVICE_CONTAINER = 'sourcing-service';
const PROJECT = 'sourcing-agent';
const RUNTIME_PORT = 8080;
const RUNTIME_HOST_PORT = 8107;
const SERVICE_HOST_PORT = PORT_DEFAULT;
const SERVICE_UPSTREAM = `${SERVICE_CONTAINER}:${PORT_DEFAULT}`;
const RUNTIME_UPSTREAM = `${RUNTIME_CONTAINER}:${RUNTIME_PORT}`;
const HOST = 'mp-suppliers-sourcing.vector.apexfusion.org';
const NETWORK = `${PROJECT}_default`;
const VOLUME = 'sourcing-state';
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
const SERVICE_ENVIRONMENT: Readonly<Record<string, string>> = { PORT: String(PORT_DEFAULT), HOST: '0.0.0.0', SUPPLIER_PRIV_KEY_HEX: '', SOURCING_STATE_DIR: STATE_DIR_DEFAULT };
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
  const parts = image.split('@sha256:');
  return parts.length === 2 && parts[0] === repository && (parts[1] === '<digest>' || DIGEST_DIGITS.test(parts[1]));
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

describe('deploy/server/docker-compose.sourcing-agent.yml', () => {
  const real = parse(composeText) as Model;

  test('the real file passes: two containers, a runtime in front of a service, each one as the pack says', () => {
    expect(composeProblems(composeText)).toStrictEqual([]);
    expect(Object.keys(real.services)).toStrictEqual([RUNTIME_NAME, SERVICE_NAME]);
    expect([RUNTIME_HOST_PORT, SERVICE_HOST_PORT]).toStrictEqual([8107, 9105]);
    expect(KEY_VARIABLES).toStrictEqual([
      'SOURCING_SERVICE_PRIV_KEY_HEX', 'SOURCING_DELEGATION_1_PRIV_KEY_HEX', 'SOURCING_DELEGATION_2_PRIV_KEY_HEX', 'SCORER_1_AUTH_PRIV_KEY_HEX', 'SCORER_1_DELEGATION_PRIV_KEY_HEX',
      'SCORER_2_AUTH_PRIV_KEY_HEX', 'SCORER_2_DELEGATION_PRIV_KEY_HEX', 'SCORER_3_AUTH_PRIV_KEY_HEX', 'SCORER_3_DELEGATION_PRIV_KEY_HEX',
    ]);
    expect(KEY_VARIABLES, 'the nine keys: three paying keys and the six keys of the three scorers').toStrictEqual(KEY_ROLES.map((role) => KEY_OF_ROLE[role]));
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
    ['a public port on the runtime', (t) => swap(t, '127.0.0.1:8107:8080', '8107:8080'), 'runtime: ports must be the one entry 127.0.0.1:8107:8080'],
    ['the address of every interface', (t) => swap(t, '127.0.0.1:8107:8080', '0.0.0.0:8107:8080'), 'runtime: ports must be the one entry 127.0.0.1:8107:8080'],
    ['a port on the address of every interface of version 6', (t) => swap(t, '127.0.0.1:8107:8080', '[::]:8107:8080'), 'runtime: ports must be'],
    ['a second port', (t) => composeWith((c) => { c.services.runtime.ports.push('127.0.0.1:8111:8080'); }), 'runtime: ports must be'],
    ['a port of the service on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:9105:8080']; }), 'runtime: ports must be'],
    ['the wrong port in the container', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8107:9105']; }), 'runtime: ports must be'],
    ['the port of the Reorder Agent on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8101:8080']; }), 'runtime: ports must be'],
    ['the port of the Prior Authorization Agent on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8105:8080']; }), 'runtime: ports must be'],
    ['the port of a Bid Desk on the runtime', (t) => composeWith((c) => { c.services.runtime.ports = ['127.0.0.1:8108:8080']; }), 'runtime: ports must be'],
    ['the long form of a port', (t) => composeWith((c) => { c.services.runtime.ports = [{ target: 8080, published: 8107, host_ip: '127.0.0.1' }]; }), 'runtime: ports must be'],
    ['a public port on the service', (t) => swap(t, '127.0.0.1:9105:9105', '9105:9105'), 'service: ports must be the one entry 127.0.0.1:9105:9105'],
    ['the address of every interface on the service', (t) => swap(t, '127.0.0.1:9105:9105', '0.0.0.0:9105:9105'), 'service: ports must be the one entry 127.0.0.1:9105:9105'],
    ['the port of the Reorder Agent on the service', (t) => composeWith((c) => { c.services.service.ports = ['127.0.0.1:9101:9105']; }), 'service: ports must be'],
    ['the port of a Bid Desk on the service', (t) => composeWith((c) => { c.services.service.ports = ['127.0.0.1:9106:9105']; }), 'service: ports must be'],
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
    ['a wrong project name', (t) => swap(t, `name: ${PROJECT}`, 'name: sourcing'), `the project name must be ${PROJECT}`],
    ['the project name of another pack', (t) => swap(t, `name: ${PROJECT}`, 'name: reorder-agent'), `the project name must be ${PROJECT}`],
    ['no project name', (t) => composeWith((c) => { delete c.name; }), `the project name must be ${PROJECT}`],
    // The image.
    ['an image by tag', (t) => swap(t, `${RUNTIME_IMAGE}@sha256:<digest>`, `${RUNTIME_IMAGE}:latest`), 'runtime: image must be'],
    ['the service image by tag', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:latest`), 'service: image must be'],
    ['an image by the tag of a commit', (t) => swap(t, `${SERVICE_IMAGE}@sha256:<digest>`, `${SERVICE_IMAGE}:${'a1'.repeat(20)}`), 'service: image must be'],
    ['a digest that is too short', (t) => swap(t, '<digest>', 'abc123'), /^(runtime|service): image must be/],
    ['an image of another repository', (t) => swap(t, `${SERVICE_IMAGE}@sha256`, `${REPOSITORY}/bid-desk@sha256`), 'service: image must be'],
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
    ['a key variable of a Bid Desk in the runtime', (t) => composeWith((c) => { c.services.runtime.environment.BID_DESK_SERVICE_PRIV_KEY_HEX = ''; }), 'runtime: BID_DESK_SERVICE_PRIV_KEY_HEX must not be set here'],
    ['the token in the compose file', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'runtime: SERVICE_AUTH_HEADER is not set by the compose file'],
    ['the token in the service', (t) => composeWith((c) => { c.services.service.environment.SERVICE_AUTH_HEADER = 'Bearer x'; }), 'service: SERVICE_AUTH_HEADER is not set by the compose file'],
    // The env file: one file, read by both, and required.
    ['an env file that is not required', (t) => swap(t, 'required: true', 'required: false'), /^(runtime|service): env_file must be the one file/],
    ['the env file of another pack', (t) => swap(t, `./${ENV_FILE}`, './.env.reorder-agent'), /^(runtime|service): env_file must be the one file/],
    ['a second env file on the runtime', (t) => composeWith((c) => { c.services.runtime.env_file.push({ path: `./${ENV_FILE}-runtime`, required: true }); }), 'runtime: env_file must be the one file'],
    ['an env file as a plain name', (t) => composeWith((c) => { c.services.service.env_file = `./${ENV_FILE}`; }), 'service: env_file must be the one file'],
    ['no env file on the service', (t) => composeWith((c) => { delete c.services.service.env_file; }), 'service: env_file must be the one file'],
    // The address of the service, the check before the Claim, the windows, the card, the release watcher.
    ['a runtime that calls another port of the service', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://${SERVICE_CONTAINER}:9104/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime that calls the service of another pack', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = 'http://priorauth-service:9105/'; }), 'runtime: SERVICE_URL must be'],
    ['the alias of the service in place of its container', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://service:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['an address of the service on the host', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_URL = `http://127.0.0.1:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_URL must be'],
    ['a runtime with no check before the Claim', (t) => composeWith((c) => { delete c.services.runtime.environment.SERVICE_PRECHECK_URL; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at another route', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/check`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check at the route of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://${SERVICE_CONTAINER}:${PORT_DEFAULT}/`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a check on the container of another pack', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_PRECHECK_URL = `http://reorder-service:${PORT_DEFAULT}/precheck`; }), 'runtime: SERVICE_PRECHECK_URL must be'],
    ['a timeout that leaves the window', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '5380000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "5280000"'],
    ['a timeout under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '5220000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "5280000"'],
    ['the timeout of a Bid Desk', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '360000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "5280000"'],
    ['the timeout of the Reorder Agent', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = '1680000'; }), 'runtime: SERVICE_TIMEOUT_MS must be "5280000"'],
    ['a window under the deadline of the job', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '5220000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['a window of 60 minutes', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '3600000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['the window of a Bid Desk', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = '480000'; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['a window as a number', (t) => composeWith((c) => { c.services.runtime.environment.ADVERT_MAX_PROCESSING_MS = 5400000; }), 'runtime: ADVERT_MAX_PROCESSING_MS must be quoted text'],
    ['a timeout as a number', (t) => composeWith((c) => { c.services.runtime.environment.SERVICE_TIMEOUT_MS = 5280000; }), 'runtime: SERVICE_TIMEOUT_MS must be quoted text'],
    ['a port in the container that the mapping does not publish', (t) => composeWith((c) => { c.services.runtime.environment.PORT = '8081'; }), 'runtime: PORT must be "8080"'],
    ['the card of the runtime on another host name', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = 'https://mp-suppliers-priorauth.vector.apexfusion.org'; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin that is not https', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `http://${HOST}`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['an origin with a path', (t) => composeWith((c) => { c.services.runtime.environment.PUBLIC_ORIGIN = `https://${HOST}/`; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no card origin', (t) => composeWith((c) => { delete c.services.runtime.environment.PUBLIC_ORIGIN; }), 'runtime: PUBLIC_ORIGIN must be'],
    ['no release watcher', (t) => composeWith((c) => { delete c.services.runtime.environment.RELEASE_WATCHER; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher that is off', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = '0'; }), 'runtime: RELEASE_WATCHER must be "1"'],
    ['a release watcher as a number', (t) => composeWith((c) => { c.services.runtime.environment.RELEASE_WATCHER = 1; }), 'runtime: RELEASE_WATCHER must be quoted text'],
    ['the capability kind of another runtime', (t) => composeWith((c) => { c.services.runtime.environment.CAPABILITY_KIND = 'chat'; }), 'runtime: CAPABILITY_KIND must be "custom"'],
    ['a setting that the compose file does not set', (t) => composeWith((c) => { c.services.runtime.environment.LIVE_CHAIN = '1'; }), 'runtime: LIVE_CHAIN is not set by the compose file'],
    ['the switch of the fault in the runtime', (t) => composeWith((c) => { c.services.runtime.environment.FAULT_MODE = 'invert_scores'; }), 'runtime: FAULT_MODE is not set by the compose file'],
    // The listener and the state of the service.
    ['a port of the service that the mapping does not publish', (t) => composeWith((c) => { c.services.service.environment.PORT = '9104'; }), 'service: PORT must be "9105"'],
    ['the loopback address inside the container of the service', (t) => composeWith((c) => { c.services.service.environment.HOST = '127.0.0.1'; }), 'service: HOST must be "0.0.0.0"'],
    ['a state directory that is not the volume', (t) => composeWith((c) => { c.services.service.environment.SOURCING_STATE_DIR = '/tmp/state'; }), 'service: SOURCING_STATE_DIR must be "/data"'],
    ['the state directory of another pack', (t) => composeWith((c) => { delete c.services.service.environment.SOURCING_STATE_DIR; c.services.service.environment.REORDER_STATE_DIR = '/data'; }), /^service: (SOURCING_STATE_DIR must be|REORDER_STATE_DIR is not set)/],
    ['the switch of the fault in the service', (t) => composeWith((c) => { c.services.service.environment.FAULT_MODE = ''; }), 'service: FAULT_MODE is not set by the compose file'],
    // The volume, the grace period, the order of the start.
    ['no volume on the service', (t) => composeWith((c) => { delete c.services.service.volumes; }), 'service: volumes must be'],
    ['a folder of the host as the state', (t) => composeWith((c) => { c.services.service.volumes = ['/srv/agents/sourcing-agent:/data']; }), 'service: volumes must be'],
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
    expect(faults.length).toBeGreaterThan(130);
    for (const [what, change, expected] of faults) {
      const problems = composeProblems(change(composeText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a key names the variable and never shows its value', () => {
    const text = composeProblems(composeWith((c) => { c.services.runtime.environment.SCORER_2_AUTH_PRIV_KEY_HEX = HEX; c.services.service.environment.SUPPLIER_PRIV_KEY_HEX = HEX; })).join('\n');
    expect(text).toContain('SCORER_2_AUTH_PRIV_KEY_HEX');
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
    const blockForm = swap(composeText, 'ports: ["127.0.0.1:8107:8080"]', 'ports:\n      - "127.0.0.1:8107:8080"');
    expect(composeProblems(blockForm), 'a port in the block form of a list').toStrictEqual([]);
    const asList = composeWith((c) => { c.services.runtime.environment = Object.entries(c.services.runtime.environment).map(([name, value]) => `${name}=${String(value)}`); });
    expect(composeProblems(asList)).toStrictEqual(['runtime: environment must be a map of names to quoted text']);
  });

  test('the key variables of the start file are the ones that the runtime blanks: a second key in the start file needs a second blank in the runtime', () => {
    expect(KEY_VARIABLES_OF_THE_START).toStrictEqual(KEY_VARIABLES);
    expect(KEY_VARIABLES_OF_THE_START).toHaveLength(9);
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
    expect([MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]).toStrictEqual([5_400_000, 5_280_000, 5_220_000]);
    expect(JOB_DEADLINE_MS).toBeLessThan(SERVICE_TIMEOUT_MS);
    expect(SERVICE_TIMEOUT_MS).toBeLessThanOrEqual(MIN_PROCESSING_WINDOW_MS - 60_000);
    expect(MIN_PROCESSING_WINDOW_MS - SERVICE_TIMEOUT_MS, 'the window is 120 s beyond the timeout').toBe(120_000);
    const environment = real.services.runtime.environment as Record<string, string>;
    expect(Number(environment.SERVICE_TIMEOUT_MS)).toBeLessThanOrEqual(Number(environment.ADVERT_MAX_PROCESSING_MS) - 60_000);
    expect(Number(environment.SERVICE_TIMEOUT_MS)).toBeGreaterThan(JOB_DEADLINE_MS);
    expect(Number(environment.ADVERT_MAX_PROCESSING_MS)).toBe(MIN_PROCESSING_WINDOW_MS);
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
    expect(RUNTIME_UPSTREAM).toBe('sourcing-runtime:8080');
  });
});

// --- the env example -----------------------------------------------------------------------------------------------------------------------------------

const exampleText = readPack(FILES.example);

/** The names of the tool that posts an advert. The operator posts the advert with the hosted tools, and the runtime reads the reference of its advert as ADVERT_REF. ADVERT_PRICE_LOVELACE is not among them: it is a setting of the service. */
const POST_ADVERT_NAMES = ['ADVERT_MODEL', 'ADVERT_ENDPOINT_URL', 'ADVERT_DETAIL_URI', 'ADVERT_DETAIL_HASH'] as const;
/** The four supplier lines: the runtime holds the key and the wallet, and the service reads the two public lines to publish them. */
const SUPPLIER_LINES = ['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS'] as const;
/** The nine keys of the service, each one followed by its key hash. */
const KEY_LINES = KEY_VARIABLES.flatMap((name) => [name, name.replace('_PRIV_KEY_HEX', '_PKH')]);
/** The three lines of the scorers: each one holds the DID of the agent record of a scorer. */
const SCORER_LINES = ['SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID'] as const;
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
/** The values that this pack chooses: the terms of the advert, the model hire of the decisions as Advocate has it (one model, price 1, both bonds 2 at most), the hire of a quote (price 2, both bonds 2 at most: twice the terms of a Bid Desk advert), and the stake of a challenge as the least stake of a claim. */
const CHOSEN: Readonly<Record<string, string>> = {
  AGENT_STATUS_CHIP: 'proposed',
  FAULT_MODE: '',
  ADVERT_PRICE_LOVELACE: String(PRICE_DEFAULT_LOVELACE),
  ADVERT_MAX_PROCESSING_MS: String(MIN_PROCESSING_WINDOW_MS),
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
  QUOTE_MAX_PRICE_LOVELACE: '2000000',
  QUOTE_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  QUOTE_MAX_BUYER_BOND_LOVELACE: '2000000',
  DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
  DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
  DISPUTE_READ_TIMEOUT_MS: '20000',
};
/** The lines that an operator has to fill: a value in angle brackets stands for what the operator supplies. */
const PLACEHOLDER_NAMES = ['OPERATOR_CONTACT', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'VECTOR_MODULE1_MANIFEST', 'COMPLIANCE_ISSUER_PKH'];
const MODULE1_MANIFEST = /^https:\/\/raw\.githubusercontent\.com\/Apex-Fusion\/vector-agent-modules\/(?:<commit>|[0-9a-f]{40})\/Module-1\/deploy\/identity\/mainnet\/manifest\.json$/;
/** Lines whose value stays empty in the example: a key, a key hash, a line that the operator fills later, and a line for which the code has a default. */
const EMPTY_LINES = [
  ...SUPPLIER_LINES, ...KEY_LINES, 'AGENT_ID', 'ADVERT_REF', 'IDENTITY_ADDRESS', 'AGENT_DID', ...SCORER_LINES, 'AGENT_VERSION', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'FAULT_MODE',
  'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', 'IDENTITY_GATEWAY_URL', 'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS',
  'COSIGN_LEDGER_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
];
/** The first line of each block, in the order of the blocks: the supplier key, the nine keys, the token, the chain, the identity registry, the record and the advert, the Module-1 manifest, the services that are read, the mock systems, the compliance issuer, the scorers, the terms of the advert, the manifest, the hires, the co-sign route, the dispute code, the fault switch. */
const BLOCK_STARTS = [
  'SUPPLIER_PRIV_KEY_HEX', 'SOURCING_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER', 'NETWORK_ID', 'IDENTITY_POLICY_ID', 'AGENT_ID', 'VECTOR_MODULE1_MANIFEST', 'VECTOR_OGMIOS_URL', 'MOCK_PUBLIC_BASE',
  'COMPLIANCE_ISSUER_PKH', 'SCORER_1_DID', 'ADVERT_PRICE_LOVELACE', 'OPERATOR_CONTACT', 'LLM_MODEL_ALLOWLIST', 'COSIGN_ALLOWLIST', 'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'FAULT_MODE',
];
/** The names that stand in the compose file and in the example too: the window of the advert (the compose file gives it to the runtime, and the service reads it from the file), the supplier key line (the service blanks it) and the nine key lines (the runtime blanks them). */
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
  if (!same(names.slice(0, SUPPLIER_LINES.length + KEY_LINES.length), [...SUPPLIER_LINES, ...KEY_LINES])) problems.push('the example must start with the four supplier lines and then the nine keys of the service, each one followed by its key hash');
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
// start. The real start code accepts it. The tests of the example and the tests of the runbook both use these three.
const filled = (env: Readonly<Record<string, string>>): NodeJS.ProcessEnv => ({
  ...env,
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  SCORER_1_DID: SCORER_DIDS[0],
  SCORER_2_DID: SCORER_DIDS[1],
  SCORER_3_DID: SCORER_DIDS[2],
  COMPLIANCE_ISSUER_PKH: ISSUER.keyHash,
  ...Object.fromEntries(KEY_ROLES.map((role) => [KEY_OF_ROLE[role], rawKey(KEY_NUMBERS[role])])),
  SERVICE_AUTH_HEADER: TOKEN,
  SUPPLIER_PKH: SUPPLIER.keyHash,
  SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey,
  MOCK_PUBLIC_BASE: 'https://mock.example.test',
  MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
  VECTOR_MODULE1_MANIFEST: swap(env.VECTOR_MODULE1_MANIFEST ?? '', '<commit>', 'a'.repeat(40)),
});
const exampleEnv = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value === '""' ? '' : entry.value]));
const containerEnv = (service: string): Record<string, string> => (parse(composeText) as Model).services[service].environment as Record<string, string>;

/** The settings that the manifest of the service reads: a change of one of them changes the bytes of the manifest, and so the hash that the advert holds. The comment of the manifest block in the example names exactly these. */
const MANIFEST_SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'COMPLIANCE_ISSUER_PKH', 'IDENTITY_POLICY_ID',
  'IDENTITY_ADDRESS', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SOURCING_SERVICE_PKH', 'SOURCING_DELEGATION_1_PKH', 'SOURCING_DELEGATION_2_PKH', 'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE',
] as const;

describe('deploy/server/.env.sourcing-agent.example', () => {
  test('the real example passes: the settings of the service and the names of the runtime, each one once, every secret empty, the published values as published', () => {
    expect(exampleProblems(exampleText)).toStrictEqual([]);
    const { entries } = entriesOf(exampleText);
    expect(entries.length).toBeGreaterThan(70);
    const names = entries.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(new Set<string>([...SETTINGS, ...RUNTIME_READS]).has(name), name).toBe(true);
    for (const name of [...SUPPLIER_LINES, ...KEY_LINES, 'SERVICE_AUTH_HEADER']) expect(emptyValue(entries.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example holds the four supplier lines first, then the nine keys with their key hashes, and the lines of the runtime that stay empty: the reference of the advert and the agent identifier', () => {
    const names = entriesOf(exampleText).entries.map((entry) => entry.name);
    expect(names.slice(0, 22)).toStrictEqual([
      'SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PUB_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_ADDRESS',
      'SOURCING_SERVICE_PRIV_KEY_HEX', 'SOURCING_SERVICE_PKH', 'SOURCING_DELEGATION_1_PRIV_KEY_HEX', 'SOURCING_DELEGATION_1_PKH', 'SOURCING_DELEGATION_2_PRIV_KEY_HEX', 'SOURCING_DELEGATION_2_PKH',
      'SCORER_1_AUTH_PRIV_KEY_HEX', 'SCORER_1_AUTH_PKH', 'SCORER_1_DELEGATION_PRIV_KEY_HEX', 'SCORER_1_DELEGATION_PKH',
      'SCORER_2_AUTH_PRIV_KEY_HEX', 'SCORER_2_AUTH_PKH', 'SCORER_2_DELEGATION_PRIV_KEY_HEX', 'SCORER_2_DELEGATION_PKH',
      'SCORER_3_AUTH_PRIV_KEY_HEX', 'SCORER_3_AUTH_PKH', 'SCORER_3_DELEGATION_PRIV_KEY_HEX', 'SCORER_3_DELEGATION_PKH',
    ]);
    expect(names[22]).toBe('SERVICE_AUTH_HEADER');
    expect(names.at(-1)).toBe('FAULT_MODE');
    const { entries } = entriesOf(exampleText);
    for (const name of ['ADVERT_REF', 'AGENT_ID', 'AGENT_DID', ...SCORER_LINES, 'COSIGN_ALLOWLIST', 'FAULT_MODE']) expect(entries.find((entry) => entry.name === name)!.value, name).toBe('');
  });

  test('the names that the example leaves out of the settings of the service are the three that the compose file sets, and the names that it adds are the ones that only the runtime reads', () => {
    const names = new Set(entriesOf(exampleText).entries.map((entry) => entry.name));
    expect(SETTINGS.filter((name) => !names.has(name))).toStrictEqual(['PORT', 'HOST', 'SOURCING_STATE_DIR']);
    expect([...names].filter((name) => !(SETTINGS as readonly string[]).includes(name)).sort()).toStrictEqual([
      'ADVERT_REF', 'ADVERT_REF_UTXO', 'AGENT_ID', 'ESCROW_REF_UTXO', 'IDENTITY_ADVERT_REF_UTXO', 'IDENTITY_ESCROW_REF_UTXO', 'LIVE_CHAIN', 'NETWORK_ID', 'OGMIOS_URL', 'SUPPLIER_ADDRESS', 'SUPPLIER_PRIV_KEY_HEX',
      'VECTOR_ZERO_TIME_MS',
    ]);
    expect(SETTINGS, 'the service reads 67 settings').toHaveLength(67);
  });

  test('a name of the advert tool is refused one at a time, and the unchanged example is accepted', () => {
    expect(exampleProblems(exampleText), 'the example as it is').toStrictEqual([]);
    for (const name of POST_ADVERT_NAMES) {
      const problems = exampleProblems(withLine(exampleText, `${name}=`));
      expect(problems.some((problem) => problem === `${name} is a name of the advert tool: the operator posts the advert, and the example holds no such name`), `${name}: ${JSON.stringify(problems)}`).toBe(true);
    }
    expect(exampleProblems(exampleText).some((problem) => problem.includes('ADVERT_PRICE_LOVELACE')), 'the price of the advert is a setting of the service, so it stays').toBe(false);
    expect(entriesOf(exampleText).entries.some((entry) => entry.name === 'ADVERT_PRICE_LOVELACE')).toBe(true);
  });

  const faults: readonly Fault[] = [
    // A key, a token or an address in a line that must stay empty.
    ['a key in the line of the supplier key', (t) => withValue(t, 'SUPPLIER_PRIV_KEY_HEX', HEX), 'SUPPLIER_PRIV_KEY_HEX must be empty'],
    ...KEY_VARIABLES.map((name): Fault => [`a key in the line of ${name}`, (t) => withValue(t, name, HEX), `${name} must be empty`]),
    ['a token in the token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`), 'SERVICE_AUTH_HEADER must be empty'],
    ['an unquoted token line', (t) => withValue(t, 'SERVICE_AUTH_HEADER', ''), 'SERVICE_AUTH_HEADER must be "" (quoted and empty)'],
    ['a key in the line of a public key', (t) => withValue(t, 'SUPPLIER_PUB_KEY_HEX', HEX), /^SUPPLIER_PUB_KEY_HEX (must be empty|looks like key material)/],
    ['a key hash in the line of the supplier', (t) => withValue(t, 'SUPPLIER_PKH', 'cd'.repeat(28)), /^SUPPLIER_PKH (must be empty|looks like key material)/],
    ...KEY_VARIABLES.map((name): Fault => [`a key hash in the key hash line of ${name}`, (t) => withValue(t, name.replace('_PRIV_KEY_HEX', '_PKH'), 'cd'.repeat(28)), /_PKH (must be empty|looks like key material)/]),
    ['an address in the line of the wallet', (t) => withValue(t, 'SUPPLIER_ADDRESS', 'addr1qxyz'), /^SUPPLIER_ADDRESS (must be empty|looks like key material)/],
    ['a key in a line that is not its own', (t) => withValue(t, 'AGENT_DID', HEX), /^AGENT_DID (must be empty|looks like key material)/],
    ['a DID of a scorer in the example', (t) => withValue(t, 'SCORER_1_DID', `did:vector:${HEX}`), 'SCORER_1_DID must be empty in the example'],
    ['a DID of the second scorer in the example', (t) => withValue(t, 'SCORER_2_DID', `did:vector:${HEX}`), 'SCORER_2_DID must be empty in the example'],
    ['a DID of the third scorer in the example', (t) => withValue(t, 'SCORER_3_DID', `did:vector:${HEX}`), 'SCORER_3_DID must be empty in the example'],
    ['a reference of an advert in the example', (t) => withValue(t, 'ADVERT_REF', `${HEX}#0`), /^ADVERT_REF (must be empty|looks like key material)/],
    ['an agent identifier in the example', (t) => withValue(t, 'AGENT_ID', HEX), /^AGENT_ID (must be empty|looks like key material)/],
    ['a key hash where the placeholder of the compliance issuer stands', (t) => withValue(t, 'COMPLIANCE_ISSUER_PKH', 'cd'.repeat(28)), /^(COMPLIANCE_ISSUER_PKH looks like key material|the lines with a placeholder must be)/],
    // A name that the compose file sets: its value wins, so a line here does nothing.
    ...['PORT=9105', 'HOST=0.0.0.0', 'SOURCING_STATE_DIR=/data', 'CAPABILITY_KIND=custom', `SERVICE_URL=http://${SERVICE_UPSTREAM}/`, `SERVICE_PRECHECK_URL=http://${SERVICE_UPSTREAM}/precheck`, 'SERVICE_CONTENT_TYPE=application/json',
      'SERVICE_TIMEOUT_MS=5280000', `PUBLIC_ORIGIN=https://${HOST}`, 'RELEASE_WATCHER=1'].map((line): Fault => [
      `a line for a name that the compose file sets: ${line.slice(0, line.indexOf('='))}`, (t) => withLine(t, line), / is set by the compose file, which wins/,
    ]),
    // A name that the example must not hold, and a line that is no setting.
    ['a name that is no setting', (t) => withLine(t, 'SOMETHING_ELSE=1'), 'SOMETHING_ELSE is no setting of the service and no setting of the runtime'],
    ['a key variable of the Reorder Agent', (t) => withLine(t, 'REORDER_SERVICE_PRIV_KEY_HEX='), 'REORDER_SERVICE_PRIV_KEY_HEX is no setting of the service and no setting of the runtime'],
    ['a key variable of the Prior Authorization Agent', (t) => withLine(t, 'PRIORAUTH_SERVICE_PRIV_KEY_HEX='), 'PRIORAUTH_SERVICE_PRIV_KEY_HEX is no setting of the service and no setting of the runtime'],
    ['a key variable of a Bid Desk', (t) => withLine(t, 'BID_DESK_SERVICE_PRIV_KEY_HEX='), 'BID_DESK_SERVICE_PRIV_KEY_HEX is no setting of the service and no setting of the runtime'],
    ['the subagent of the Reorder Agent', (t) => withLine(t, 'STOCK_READER_DID='), 'STOCK_READER_DID is no setting of the service and no setting of the runtime'],
    ['a limit of the hire of another agent', (t) => withLine(t, 'HANDOFF_MAX_PRICE_LOVELACE=2000000'), 'HANDOFF_MAX_PRICE_LOVELACE is no setting of the service and no setting of the runtime'],
    ['the state folder of the Reorder Agent', (t) => withLine(t, 'REORDER_STATE_DIR=/data'), 'REORDER_STATE_DIR is no setting of the service and no setting of the runtime'],
    ['a name twice', (t) => withLine(t, 'FAULT_MODE='), 'FAULT_MODE is listed twice'],
    ['a scorer line twice', (t) => withLine(t, 'SCORER_2_DID='), 'SCORER_2_DID is listed twice'],
    ['a line that is no NAME=value', (t) => withLine(t, 'name = value'), /is not a comment and not NAME=value/],
    // A line that is missing.
    ['a missing line of the mock systems', (t) => without(t, 'MOCK_MTLS_BASE'), 'MOCK_MTLS_BASE is missing'],
    ['a missing line of the runtime', (t) => without(t, 'LIVE_CHAIN'), 'LIVE_CHAIN is missing'],
    ['a missing line of the reference of the advert', (t) => without(t, 'ADVERT_REF'), 'ADVERT_REF is missing'],
    ['a missing supplier key line', (t) => without(t, 'SUPPLIER_PRIV_KEY_HEX'), 'SUPPLIER_PRIV_KEY_HEX is missing'],
    ['a missing key line of the service', (t) => without(t, 'SOURCING_DELEGATION_2_PRIV_KEY_HEX'), 'SOURCING_DELEGATION_2_PRIV_KEY_HEX is missing'],
    ['a missing key line of a scorer', (t) => without(t, 'SCORER_2_AUTH_PRIV_KEY_HEX'), 'SCORER_2_AUTH_PRIV_KEY_HEX is missing'],
    ['a missing key line of the third scorer', (t) => without(t, 'SCORER_3_DELEGATION_PRIV_KEY_HEX'), 'SCORER_3_DELEGATION_PRIV_KEY_HEX is missing'],
    ['a missing line of the allowlist', (t) => without(t, 'COSIGN_ALLOWLIST'), 'COSIGN_ALLOWLIST is missing'],
    ['a missing line of the first scorer', (t) => without(t, 'SCORER_1_DID'), 'SCORER_1_DID is missing'],
    ['a missing line of the third scorer', (t) => without(t, 'SCORER_3_DID'), 'SCORER_3_DID is missing'],
    ['a missing line of the compliance issuer', (t) => without(t, 'COMPLIANCE_ISSUER_PKH'), 'COMPLIANCE_ISSUER_PKH is missing'],
    ['a missing limit of the hire of a quote', (t) => without(t, 'QUOTE_MAX_PRICE_LOVELACE'), 'QUOTE_MAX_PRICE_LOVELACE is missing'],
    ['a missing bond limit of the hire of a quote', (t) => without(t, 'QUOTE_MAX_BUYER_BOND_LOVELACE'), 'QUOTE_MAX_BUYER_BOND_LOVELACE is missing'],
    ['a missing fault switch', (t) => without(t, 'FAULT_MODE'), 'FAULT_MODE is missing'],
    // A value that the pack fixes.
    ['a fault switch that is on', (t) => withValue(t, 'FAULT_MODE', 'invert_scores'), 'FAULT_MODE must be ""'],
    ['a fault value of another agent', (t) => withValue(t, 'FAULT_MODE', 'alter_after_approval'), 'FAULT_MODE must be ""'],
    ['a status word of a live service', (t) => withValue(t, 'AGENT_STATUS_CHIP', 'live'), 'AGENT_STATUS_CHIP must be "proposed"'],
    ['a status word in upper case', (t) => withValue(t, 'AGENT_STATUS_CHIP', 'proposed'.toUpperCase()), 'AGENT_STATUS_CHIP must be "proposed"'],
    ['a window of 60 minutes', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '3600000'), 'ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['a window under the deadline of a job', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '5220000'), 'ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['the window of a Bid Desk', (t) => withValue(t, 'ADVERT_MAX_PROCESSING_MS', '480000'), 'ADVERT_MAX_PROCESSING_MS must be "5400000"'],
    ['another price of the advert', (t) => withValue(t, 'ADVERT_PRICE_LOVELACE', '5000000'), 'ADVERT_PRICE_LOVELACE must be "3000000"'],
    ['the price of a Bid Desk', (t) => withValue(t, 'ADVERT_PRICE_LOVELACE', '1000000'), 'ADVERT_PRICE_LOVELACE must be "3000000"'],
    ['another policy of the identity registry', (t) => withValue(t, 'IDENTITY_POLICY_ID', '0'.repeat(56)), 'IDENTITY_POLICY_ID must be'],
    ['another vault script', (t) => withValue(t, 'VECTOR_IDENTITY_VAULT_REF_UTXO', `${HEX}#0`), 'VECTOR_IDENTITY_VAULT_REF_UTXO must be'],
    ['another escrow script of the runtime', (t) => withValue(t, 'IDENTITY_ESCROW_REF_UTXO', `${HEX}#0`), 'IDENTITY_ESCROW_REF_UTXO must be'],
    ['a runtime that cannot write to the chain', (t) => withValue(t, 'LIVE_CHAIN', '0'), 'LIVE_CHAIN must be "1"'],
    ['a placeholder where the pack gives a value', (t) => withValue(t, 'LLM_MAX_PRICE_LOVELACE', '<price>'), 'LLM_MAX_PRICE_LOVELACE must be "1000000"'],
    ['a limit that the model hire does not take', (t) => withValue(t, 'LLM_MAX_BUYER_BOND_LOVELACE', '5000000'), 'LLM_MAX_BUYER_BOND_LOVELACE must be "2000000"'],
    ['a price limit of the hire of a quote under the price of a Bid Desk advert', (t) => withValue(t, 'QUOTE_MAX_PRICE_LOVELACE', '500000'), 'QUOTE_MAX_PRICE_LOVELACE must be "2000000"'],
    ['the limit of the hire of the Order Desk', (t) => withValue(t, 'QUOTE_MAX_PRICE_LOVELACE', '10000000'), 'QUOTE_MAX_PRICE_LOVELACE must be "2000000"'],
    ['a bond limit of the hire of a quote', (t) => withValue(t, 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE', '3000000'), 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE must be "2000000"'],
    ['a stake that no claim reaches', (t) => withValue(t, 'DISPUTE_CHALLENGE_STAKE_LOVELACE', '1000000'), 'DISPUTE_CHALLENGE_STAKE_LOVELACE must be "50000000"'],
    ['a resolution deadline in the example', (t) => withValue(t, 'DISPUTE_RESOLUTION_DEADLINE_MS', '259200000'), 'DISPUTE_RESOLUTION_DEADLINE_MS must be empty in the example'],
    ['a lease in the example', (t) => withValue(t, 'DISPUTE_STARTED_LEASE_MS', '600000'), 'DISPUTE_STARTED_LEASE_MS must be empty in the example'],
    ['an allowlist with a principal in the example', (t) => withValue(t, 'COSIGN_ALLOWLIST', 'ab'.repeat(28)), /^COSIGN_ALLOWLIST (must be empty in the example|looks like key material)/],
    ['a limit of the co-sign route in the example', (t) => withValue(t, 'COSIGN_MAX_CONCURRENT', '64'), 'COSIGN_MAX_CONCURRENT must be empty in the example'],
    // A Module-1 manifest that is not pinned, and a placeholder that is not the pack's.
    ['a Module-1 manifest that no commit pins', (t) => swap(t, '/<commit>/', '/main/'), 'VECTOR_MODULE1_MANIFEST must be an https address of the Module-1 manifest, pinned to a commit'],
    ['a Module-1 manifest as a file', (t) => withValue(t, 'VECTOR_MODULE1_MANIFEST', '/etc/manifest.json'), 'VECTOR_MODULE1_MANIFEST must be an https address'],
    ['a Module-1 manifest on http', (t) => swap(t, 'VECTOR_MODULE1_MANIFEST=https://', 'VECTOR_MODULE1_MANIFEST=http://'), 'VECTOR_MODULE1_MANIFEST must be an https address'],
    ['a placeholder in another line', (t) => withValue(t, 'AGENT_DID', '<did>'), 'the lines with a placeholder must be'],
    ['no placeholder where the operator fills a value', (t) => withValue(t, 'OPERATOR_CONTACT', 'ops'), 'the lines with a placeholder must be'],
    ['no placeholder where the operator fills the compliance issuer', (t) => withValue(t, 'COMPLIANCE_ISSUER_PKH', ''), 'the lines with a placeholder must be'],
    // The order of the blocks.
    ['the token before the keys', (t) => exchange(t, '\nSERVICE_AUTH_HEADER=""\n', '\nSOURCING_SERVICE_PRIV_KEY_HEX=\n'), /^the (blocks must follow this order|example must start with)/],
    ['the chain after the terms of the advert', (t) => exchange(t, '\nNETWORK_ID=1\n', '\nADVERT_PRICE_LOVELACE=3000000\n'), 'the blocks must follow this order'],
    ['the fault switch before the dispute code', (t) => exchange(t, '\nFAULT_MODE=\n', '\nDISPUTE_CHALLENGE_STAKE_LOVELACE=50000000\n'), 'the blocks must follow this order'],
    ['the scorers before the compliance issuer', (t) => exchange(t, '\nSCORER_1_DID=\n', '\nCOMPLIANCE_ISSUER_PKH=<key hash of the compliance registry>\n'), 'the blocks must follow this order'],
    ['a key hash before its key', (t) => swap(t, '\nSOURCING_SERVICE_PRIV_KEY_HEX=\nSOURCING_SERVICE_PKH=\n', '\nSOURCING_SERVICE_PKH=\nSOURCING_SERVICE_PRIV_KEY_HEX=\n'), 'the example must start with'],
    ['the keys of two scorers in another order', (t) => exchange(t, '\nSCORER_1_AUTH_PRIV_KEY_HEX=\n', '\nSCORER_3_AUTH_PRIV_KEY_HEX=\n'), 'the example must start with'],
  ];
  test('each copy of the example that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(90);
    for (const [what, change, expected] of faults) {
      const problems = exampleProblems(change(exampleText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('a problem about a secret line never shows the value that it found', () => {
    const text = exampleProblems(withValue(withValue(exampleText, 'SOURCING_SERVICE_PRIV_KEY_HEX', HEX), 'SERVICE_AUTH_HEADER', `"Bearer ${HEX}"`)).join('\n');
    expect(text).toContain('SOURCING_SERVICE_PRIV_KEY_HEX');
    expect(text).toContain('SERVICE_AUTH_HEADER');
    expect(text).not.toContain(HEX);
  });

  test('the published values are the ones that the example of the Reorder Agent holds for the chain and the identity registry', () => {
    const reorder = Object.fromEntries(entriesOf(readPack('.env.reorder-agent.example')).entries.map((entry) => [entry.name, entry.value]));
    const values = Object.fromEntries(entriesOf(exampleText).entries.map((entry) => [entry.name, entry.value]));
    expect(Object.keys(PUBLISHED)).toHaveLength(13);
    for (const [name, wanted] of Object.entries(PUBLISHED)) {
      expect(reorder[name], `the example of the Reorder Agent holds ${name}`).toBe(wanted);
      expect(values[name], `the example holds ${name} as published`).toBe(wanted);
    }
  });

  test('no name of the compose file is repeated in the example with another value: the names in both are the window of the advert, the supplier key line and the nine key lines', () => {
    const compose = parse(composeText) as Model;
    const both = entriesOf(exampleText).entries.filter((entry) => composeSetNames(compose).has(entry.name));
    expect(both.map((entry) => entry.name).sort()).toStrictEqual([...BOTH].sort());
    expect(compose.services.runtime.environment.ADVERT_MAX_PROCESSING_MS).toBe(both.find((entry) => entry.name === 'ADVERT_MAX_PROCESSING_MS')!.value);
    for (const name of ['SUPPLIER_PRIV_KEY_HEX', ...KEY_VARIABLES]) expect(emptyValue(both.find((entry) => entry.name === name)!.value), name).toBe(true);
  });

  test('the example, filled in and joined with the environment that the compose file gives the service, starts the real configuration of the service', () => {
    const config = loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) });
    expect([config.port, config.host, config.stateDir, config.fault.mode]).toStrictEqual([9105, '0.0.0.0', '/data', '']);
    expect([config.agentDid, ...config.scorerDids]).toStrictEqual([AGENT_DID, ...SCORER_DIDS]);
    expect(config.complianceIssuerPkh).toBe(ISSUER.keyHash);
    expect(config.cosign.allowlist.size, 'the allowlist of the example holds nobody').toBe(0);
    expect(config.modelLimits).toMatchObject({ maxPriceLovelace: 1_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.modelLimits.allowlist).toStrictEqual(['deepseek/deepseek-v4-flash']);
    expect(config.quoteLimits).toMatchObject({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(config.dispute).toMatchObject({ challenge_stake_lovelace: 50_000_000n, min_window_left_ms: 600_000, read_timeout_ms: 20_000 });
    expect(config.module1Manifest).toBe(`https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules/${'a'.repeat(40)}/Module-1/deploy/identity/mainnet/manifest.json`);
    const manifest = JSON.parse(config.manifest.text) as { terms: Record<string, number>; status: { chip: string } };
    expect(manifest.terms).toMatchObject({ price_lovelace: 3_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 5_400_000 });
    expect(manifest.status.chip).toBe('proposed');
  });

  test('the example as it is does not start the service: it stops at the first key, and at each line that the operator forgot', () => {
    expect(() => loadConfig({ ...exampleEnv, ...containerEnv(SERVICE_NAME) })).toThrow(/^environment variable SOURCING_SERVICE_PRIV_KEY_HEX is required/);
    const forgotten: ReadonlyArray<readonly [string, string | undefined, RegExp]> = [
      ['SERVICE_AUTH_HEADER', '', /^environment variable SERVICE_AUTH_HEADER is required/],
      ['AGENT_DID', '', /^environment variable AGENT_DID is required/],
      ['SCORER_1_DID', '', /^environment variable SCORER_1_DID is required/],
      ['SCORER_2_DID', '', /^environment variable SCORER_2_DID is required/],
      ['SCORER_3_DID', '', /^environment variable SCORER_3_DID is required/],
      ['SUPPLIER_PKH', '', /^environment variable SUPPLIER_PKH is required/],
      ['COMPLIANCE_ISSUER_PKH', exampleEnv.COMPLIANCE_ISSUER_PKH, /^environment variable COMPLIANCE_ISSUER_PKH must be 56 hex characters/],
      ['MOCK_PUBLIC_BASE', exampleEnv.MOCK_PUBLIC_BASE, /^environment variable MOCK_PUBLIC_BASE must be an https origin/],
      ['MOCK_MTLS_BASE', exampleEnv.MOCK_MTLS_BASE, /^environment variable MOCK_MTLS_BASE must be an https origin/],
      ['VECTOR_MODULE1_MANIFEST', exampleEnv.VECTOR_MODULE1_MANIFEST, /^environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit/],
      ['COSIGN_ALLOWLIST', undefined, /^the settings of the co-sign route are refused: COSIGN_ALLOWLIST is not set/],
    ];
    for (const [name, value, expected] of forgotten) {
      expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), [name]: value }), name).toThrow(expected);
    }
  });

  test('the fault switch of the example is empty, the one value of this agent starts the service, and a value of another agent stops it', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) };
    expect(FAULT_MODES['sourcing-agent']).toStrictEqual(['invert_scores']);
    expect(loadConfig(env).fault.mode, 'the empty switch of the example').toBe('');
    expect(loadConfig({ ...env, FAULT_MODE: 'invert_scores' }).fault.mode, 'the one value of the agent').toBe('invert_scores');
    expect(() => loadConfig({ ...env, FAULT_MODE: 'alter_after_approval' }), 'a value of the Prior Authorization Agent').toThrow(/^environment variable FAULT_MODE must be empty or "invert_scores" for sourcing-agent/);
    expect(() => loadConfig({ ...env, FAULT_MODE: 'quote_off_price_list' }), 'a value of a Bid Desk').toThrow(/^environment variable FAULT_MODE must be empty or "invert_scores" for sourcing-agent/);
  });

  test('a principal on the allowlist is read as one, a key hash line that is not the hash of its key stops the start, and the right hash is accepted', () => {
    const config = loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), COSIGN_ALLOWLIST: PRINCIPAL.keyHash });
    expect(config.cosign.allowlist.has(PRINCIPAL.keyHash)).toBe(true);
    for (const role of KEY_ROLES) {
      const hash = (name: string): string => name.replace('_PRIV_KEY_HEX', '_PKH');
      const line = hash(KEY_OF_ROLE[role]);
      const own = loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) }).keys[role].pkh;
      expect(() => loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), [line]: 'cd'.repeat(28) }), line).toThrow(`environment variable ${line} (56 characters) is not the key hash of the key in ${KEY_OF_ROLE[role]}`);
      expect(loadConfig({ ...filled(exampleEnv), ...containerEnv(SERVICE_NAME), [line]: own }).keys[role].pkh, line).toBe(own);
    }
  });

  test('the key of the runtime and a key of the service are two keys, and the agent and its three scorers are four agents: the real code refuses a service key that is the supplier key and a scorer that is another agent', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) };
    const own = loadConfig(env).keys.service;
    const clash = { ...env, SUPPLIER_PKH: own.pkh, SUPPLIER_PUB_KEY_HEX: own.publicKeyHex };
    expect(() => loadConfig(clash)).toThrow(/^environment variable SOURCING_SERVICE_PRIV_KEY_HEX holds the key of SUPPLIER_PKH: the supplier key is the runtime's/);
    expect(() => loadConfig({ ...env, SCORER_1_DID: AGENT_DID })).toThrow(/^environment variable SCORER_1_DID holds the DID of AGENT_DID/);
    expect(() => loadConfig({ ...env, SCORER_2_DID: SCORER_DIDS[0] })).toThrow(/^environment variable SCORER_2_DID holds the same DID as SCORER_1_DID/);
    expect(() => loadConfig({ ...env, SCORER_3_DID: SCORER_DIDS[1] })).toThrow(/^environment variable SCORER_3_DID holds the same DID as SCORER_2_DID/);
  });

  test('the node of the example is the default of the code, and the code takes an https address only: the janitor reads the tip of the node with it', () => {
    const env = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) };
    expect(exampleEnv.VECTOR_OGMIOS_URL, 'the line is empty: the code has its own default').toBe('');
    expect(loadConfig(env).endpoints.ogmiosUrl).toMatch(/^https:\/\//);
    expect(() => loadConfig({ ...env, VECTOR_OGMIOS_URL: 'http://node.example.test' })).toThrow(/^environment variable VECTOR_OGMIOS_URL must be an https address/);
    expect(loadConfig({ ...env, VECTOR_OGMIOS_URL: 'https://node.example.test' }).endpoints.ogmiosUrl).toBe('https://node.example.test');
  });

  test('the comment of the manifest block names the settings that the manifest reads: each one changes the hash of the manifest, and no other line of the example does', () => {
    const lines = exampleText.split('\n');
    const end = lines.findIndex((line) => line.startsWith('OPERATOR_CONTACT='));
    let start = end;
    while (start > 0 && lines[start - 1].startsWith('#')) start -= 1;
    const comment = lines.slice(start, end).join('\n');
    const names = new Set<string>([...SETTINGS, ...RUNTIME_READS]);
    const named = [...new Set(comment.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? [])].filter((name) => names.has(name));
    expect(named.sort(), 'the comment names the settings of the manifest and no other setting').toStrictEqual([...MANIFEST_SETTINGS].sort());

    const base = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) };
    const hashOf = (over: NodeJS.ProcessEnv): string => loadConfig({ ...base, ...over }).manifest.sha256;
    const before = hashOf({});
    // A setting of the manifest that the test world can change. The policy, the address of the identity registry and the list of models refuse any other value here, so they are named and not changed.
    const changes: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
      ['OPERATOR_CONTACT', { OPERATOR_CONTACT: 'other@example.test' }],
      ['AGENT_DID', { AGENT_DID: `did:vector:${'c5'.repeat(32)}` }],
      ['AGENT_VERSION', { AGENT_VERSION: '0.2.0' }],
      ['AGENT_STATUS_CHIP', { AGENT_STATUS_CHIP: 'deployed' }],
      ['AGENT_STATUS_SINCE', { AGENT_STATUS_SINCE: '2026-12-01' }],
      ['ADVERT_EXPLORER_URL', { ADVERT_EXPLORER_URL: 'https://explorer.example.test/advert' }],
      ['ADVERT_PRICE_LOVELACE', { ADVERT_PRICE_LOVELACE: '4000000' }],
      ['ADVERT_MAX_PROCESSING_MS', { ADVERT_MAX_PROCESSING_MS: '6000000' }],
      ['COMPLIANCE_ISSUER_PKH', { COMPLIANCE_ISSUER_PKH: PRINCIPAL.keyHash }],
      ['SUPPLIER_PKH and SUPPLIER_PUB_KEY_HEX', { SUPPLIER_PKH: PRINCIPAL.keyHash, SUPPLIER_PUB_KEY_HEX: PRINCIPAL.publicKey }],
      ['SOURCING_SERVICE_PKH', { SOURCING_SERVICE_PRIV_KEY_HEX: rawKey(61) }],
      ['SOURCING_DELEGATION_1_PKH', { SOURCING_DELEGATION_1_PRIV_KEY_HEX: rawKey(62) }],
      ['SOURCING_DELEGATION_2_PKH', { SOURCING_DELEGATION_2_PRIV_KEY_HEX: rawKey(63) }],
      ['LLM_MAX_PRICE_LOVELACE', { LLM_MAX_PRICE_LOVELACE: '900000' }],
    ];
    for (const [what, over] of changes) expect(hashOf(over), `${what} changes the manifest`).not.toBe(before);
    // A line that the manifest does not read: a change of it leaves the bytes of the manifest as they were.
    const unchanged: ReadonlyArray<readonly [string, NodeJS.ProcessEnv]> = [
      ['SCORER_1_DID', { SCORER_1_DID: `did:vector:${'c6'.repeat(32)}` }],
      ['SCORER_3_DID', { SCORER_3_DID: `did:vector:${'c7'.repeat(32)}` }],
      ['a key of a scorer', { SCORER_2_AUTH_PRIV_KEY_HEX: rawKey(64), SCORER_3_DELEGATION_PRIV_KEY_HEX: rawKey(65) }],
      ['LLM_MAX_SUPPLIER_BOND_LOVELACE', { LLM_MAX_SUPPLIER_BOND_LOVELACE: '1500000' }],
      ['QUOTE_MAX_PRICE_LOVELACE', { QUOTE_MAX_PRICE_LOVELACE: '2500000' }],
      ['DISPUTE_CHALLENGE_STAKE_LOVELACE', { DISPUTE_CHALLENGE_STAKE_LOVELACE: '60000000' }],
      ['COSIGN_ALLOWLIST', { COSIGN_ALLOWLIST: PRINCIPAL.keyHash }],
      ['MOCK_PUBLIC_BASE', { MOCK_PUBLIC_BASE: 'https://other-mock.example.test' }],
      ['FAULT_MODE', { FAULT_MODE: 'invert_scores' }],
    ];
    for (const [what, over] of unchanged) expect(hashOf(over), `${what} leaves the manifest as it was`).toBe(before);
  });

  test('the runtime gets what it needs to boot from the example and the compose file, but its key and the reference of its advert; it holds no key of the service', () => {
    const runtimeEnv: Record<string, string> = { ...exampleEnv, ...containerEnv(RUNTIME_NAME) };
    const empty = ['SUPPLIER_PRIV_KEY_HEX', 'OGMIOS_URL', 'ADVERT_REF', 'NETWORK_ID', 'SERVICE_URL', 'ADVERT_MAX_PROCESSING_MS'].filter((name) => (runtimeEnv[name] ?? '') === '');
    expect(empty).toStrictEqual(['SUPPLIER_PRIV_KEY_HEX', 'ADVERT_REF']);
    for (const name of KEY_VARIABLES) expect(runtimeEnv[name], `the runtime holds no ${name}`).toBe('');
    expect([runtimeEnv.LIVE_CHAIN, runtimeEnv.RELEASE_WATCHER], 'the release watcher needs LIVE_CHAIN').toStrictEqual(['1', '1']);
  });
});

// --- the Caddy block -----------------------------------------------------------------------------------------------------------------------------------

const snippetText = readPack(FILES.snippet);
const BEGIN = '# sourcing-agent vhosts (BEGIN)';
const END = '# sourcing-agent vhosts (END)';
/** What the guard says of a block of the host name of the pack that sends a path to another upstream. A pattern literal, with each dot of the host name escaped. */
const BLOCK_REFUSED = /^mp-suppliers-sourcing\.vector\.apexfusion\.org: the block must send/;

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

/** The lines between the two markers, and the lines of the block that is in the file. Null when the markers are not one pair. */
function blockOf(text: string): { readonly inside: string[]; readonly outside: string[] } | null {
  const lines = text.split('\n');
  const begins = lines.flatMap((line, at) => (line === BEGIN ? [at] : []));
  const ends = lines.flatMap((line, at) => (line === END ? [at] : []));
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) return null;
  return { inside: lines.slice(begins[0] + 1, ends[0]), outside: [...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)] };
}

/** The three routes of the block, in order: the manifest and the co-sign route go to the service, and every other path goes to the runtime. */
const ROUTES: ReadonlyArray<readonly [string, string]> = [['handle /agent.json', SERVICE_UPSTREAM], ['handle /cosign/delegate', SERVICE_UPSTREAM], ['handle', RUNTIME_UPSTREAM]];

/** What is wrong with the Caddy block. An empty list is a pass. */
function caddyProblems(text: string): string[] {
  const block = blockOf(text);
  if (block === null) return [`the file must hold the line "${BEGIN}" one time, and after it the line "${END}" one time`];
  const problems: string[] = [];
  if (block.outside.some((line) => line.trim() !== '' && !line.trim().startsWith('#'))) problems.push('only comments stand outside the two markers: the lines between them are what a command adds, replaces and removes');
  const tree = caddyTree(block.inside);
  if (tree === null) return [...problems, 'the braces between the markers do not balance'];
  if (!same(tree.map((node) => node.head), [HOST])) problems.push(`the one block must be the host name ${HOST}; found: ${tree.map((node) => node.head).join(', ') || 'none'}`);
  const host = tree.find((node) => node.head === HOST);
  if (host === undefined) return problems;
  const found = host.children.map((child) => [child.head, child.children.map((inner) => [inner.head, inner.children.length])]);
  if (!same(found, ROUTES.map(([head, upstream]) => [head, [[`reverse_proxy ${upstream}`, 0]]]))) {
    problems.push(`${HOST}: the block must send /agent.json and /cosign/delegate to ${SERVICE_UPSTREAM} and every other path to ${RUNTIME_UPSTREAM}, with nothing else in it; found: ${JSON.stringify(found)}`);
  }
  return problems;
}

describe('deploy/server/Caddyfile.sourcing-agent.snippet', () => {
  test('the real block passes: one host name between the markers, sending the manifest and the co-sign route to the service and the rest to the runtime', () => {
    expect(caddyProblems(snippetText)).toStrictEqual([]);
    const lines = snippetText.split('\n');
    expect(lines.filter((line) => line === BEGIN)).toHaveLength(1);
    expect(lines.filter((line) => line === END)).toHaveLength(1);
    expect(ROUTES.map(([head]) => head)).toStrictEqual(['handle /agent.json', 'handle /cosign/delegate', 'handle']);
  });

  test('the upstreams are the container names and the container ports of the compose file, and the host is the origin that the compose file names', () => {
    const compose = parse(composeText) as Model;
    const tree = caddyTree(blockOf(snippetText)!.inside)!;
    const upstreamOf = (head: string): string => tree[0].children.find((child) => child.head === head)!.children[0].head.replace(/^reverse_proxy /, '');
    const runtime = compose.services.runtime as Model;
    const service = compose.services.service as Model;
    expect(upstreamOf('handle'), 'the runtime').toBe(`${runtime.container_name}:${String(runtime.ports[0]).split(':')[2]}`);
    expect(upstreamOf('handle /agent.json'), 'the manifest').toBe(`${service.container_name}:${String(service.ports[0]).split(':')[2]}`);
    expect(upstreamOf('handle /cosign/delegate'), 'the co-sign route').toBe(`${service.container_name}:${String(service.ports[0]).split(':')[2]}`);
    expect(runtime.environment.PUBLIC_ORIGIN, 'the card of the runtime').toBe(`https://${tree[0].head}`);
    expect(runtime.environment.SERVICE_URL, 'the address of the service for the runtime').toBe(`http://${upstreamOf('handle /agent.json')}/`);
    expect(tree[0].head, 'the host of the block').toBe(HOST);
  });

  const faults: readonly Fault[] = [
    ['no begin marker', (t) => swap(t, `${BEGIN}\n`, ''), 'the file must hold the line'],
    ['no end marker', (t) => swap(t, `${END}\n`, ''), 'the file must hold the line'],
    ['the markers in the wrong order', (t) => exchange(t, BEGIN, END), 'the file must hold the line'],
    ['a marker twice', (t) => `${t}${BEGIN}\n`, 'the file must hold the line'],
    ['a marker with another name', (t) => swap(t, BEGIN, '# reorder-agent vhosts (BEGIN)'), 'the file must hold the line'],
    ['a marker with a space after it', (t) => swap(t, BEGIN, `${BEGIN} `), 'the file must hold the line'],
    ['a block outside the markers', (t) => `${t}extra.example.org {\n    respond 200\n}\n`, 'only comments stand outside the two markers'],
    ['a directive before the begin marker', (t) => swap(t, `${BEGIN}\n`, `encode gzip\n${BEGIN}\n`), 'only comments stand outside the two markers'],
    ['the host name of another pack', (t) => swap(t, `${HOST} {`, 'mp-suppliers-priorauth.vector.apexfusion.org {'), 'the one block must be the host name'],
    ['the host name of the Reorder Agent', (t) => swap(t, `${HOST} {`, 'mp-suppliers-reorder.vector.apexfusion.org {'), 'the one block must be the host name'],
    ['the host name of a Bid Desk', (t) => swap(t, `${HOST} {`, 'mp-suppliers-bids-alfa.vector.apexfusion.org {'), 'the one block must be the host name'],
    ['a second block', (t) => swap(t, END, `second.example.org {\n    handle {\n        reverse_proxy ${RUNTIME_UPSTREAM}\n    }\n}\n${END}`), 'the one block must be the host name'],
    ['no block', (t) => `${BEGIN}\n${END}\n`, 'the one block must be the host name'],
    ['a host that sends its rest to the service', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}`, `reverse_proxy ${SERVICE_UPSTREAM}`), BLOCK_REFUSED],
    ['the wrong port of the runtime', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}`, `reverse_proxy ${RUNTIME_CONTAINER}:${RUNTIME_HOST_PORT}`), BLOCK_REFUSED],
    ['the runtime by its address on the host', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}`, `reverse_proxy 127.0.0.1:${RUNTIME_HOST_PORT}`), BLOCK_REFUSED],
    ['the runtime of another pack', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}`, 'reverse_proxy reorder-runtime:8080'), BLOCK_REFUSED],
    ['the alias of the service in place of its container', (t) => swap(t, `reverse_proxy ${SERVICE_UPSTREAM}`, `reverse_proxy service:${PORT_DEFAULT}`), /: the block must send/],
    ['the alias of the runtime in place of its container', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}`, `reverse_proxy runtime:${RUNTIME_PORT}`), /: the block must send/],
    ['the wrong port of the service', (t) => swap(t, `reverse_proxy ${SERVICE_UPSTREAM}`, `reverse_proxy ${SERVICE_CONTAINER}:9104`), /: the block must send/],
    ['the service by its address on the host', (t) => swap(t, `reverse_proxy ${SERVICE_UPSTREAM}`, `reverse_proxy 127.0.0.1:${SERVICE_HOST_PORT}`), /: the block must send/],
    ['the service of another pack', (t) => swap(t, `reverse_proxy ${SERVICE_UPSTREAM}`, 'reverse_proxy priorauth-service:9103'), /: the block must send/],
    ['no route for the manifest', (t) => swap(t, 'handle /agent.json {', 'handle /agent {'), /: the block must send/],
    ['no route for the co-sign route', (t) => swap(t, 'handle /cosign/delegate {', 'handle /cosign {'), /: the block must send/],
    ['the co-sign route sent to the runtime', (t) => swap(t, `    handle /cosign/delegate {\n        reverse_proxy ${SERVICE_UPSTREAM}\n`, `    handle /cosign/delegate {\n        reverse_proxy ${RUNTIME_UPSTREAM}\n`), /: the block must send/],
    ['the manifest sent to the runtime', (t) => swap(t, `    handle /agent.json {\n        reverse_proxy ${SERVICE_UPSTREAM}\n`, `    handle /agent.json {\n        reverse_proxy ${RUNTIME_UPSTREAM}\n`), /: the block must send/],
    ['a path of the job sent to the service', (t) => swap(t, 'handle /cosign/delegate {', 'handle /precheck {'), /: the block must send/],
    ['a third public path of the service', (t) => swap(t, '    handle {\n', `    handle /status {\n        reverse_proxy ${SERVICE_UPSTREAM}\n    }\n    handle {\n`), /: the block must send/],
    ['a directive that changes the request', (t) => swap(t, `        reverse_proxy ${RUNTIME_UPSTREAM}\n`, `        header_up Authorization x\n        reverse_proxy ${RUNTIME_UPSTREAM}\n`), /: the block must send/],
    ['options in the proxy block', (t) => swap(t, `reverse_proxy ${RUNTIME_UPSTREAM}\n`, `reverse_proxy ${RUNTIME_UPSTREAM} {\n            header_up X-Test 1\n        }\n`), /: the block must send/],
    ['a redirect before the handles', (t) => swap(t, `${HOST} {\n`, `${HOST} {\n    redir https://elsewhere.example.org\n`), /: the block must send/],
    ['the routes in another order', (t) => exchange(t, 'handle /agent.json {', 'handle /cosign/delegate {'), /: the block must send/],
    ['braces that do not balance', (t) => swap(t, END, `}\n${END}`), 'the braces between the markers do not balance'],
  ];
  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(30);
    for (const [what, change, expected] of faults) {
      const problems = caddyProblems(change(snippetText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
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
    for (const part of [NETWORK, 'docker network connect', '<caddy container>', 'in place', 'inode', 'validate', 'reload', 'Never restart', 'DNS-only', 'joins again', FILES.runbook]) expect(header, part).toContain(part);
  });
});

// --- the runbook ---------------------------------------------------------------------------------------------------------------------------------------

const runbookText = readPack(FILES.runbook);

const SECTIONS = [
  'What it is', 'The files', 'The memory gate', 'The DNS record', 'The folder', 'The env file', 'The images', 'Check the compose file', 'The start order', 'The checks', 'The Caddy block', 'The restart rule',
  'The fault switch', 'The failure table', 'Back out',
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

const NAMED_FILES = [...Object.values(FILES), ENV_FILE, 'RUNBOOK.md', 'README.md'];
const SERVICE_NAMES = Object.keys(WANT);
const LOOPBACK_PORTS = [RUNTIME_HOST_PORT, SERVICE_HOST_PORT];
const CONTAINERS = [RUNTIME_CONTAINER, SERVICE_CONTAINER];
/** The names that start as the name of a container and are none: the volume and the project. */
const OTHER_NAMES = [VOLUME, PROJECT];
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
  if (!text.startsWith('# Runbook: the Sourcing Agent on the agents host\n')) problems.push('the title must be "Runbook: the Sourcing Agent on the agents host"');
  const headings = [...text.matchAll(/^## (.+)$/gm)].map((hit) => hit[1]);
  if (!same(headings, SECTIONS)) problems.push(`the sections must be, in this order: ${SECTIONS.join(', ')}; found: ${headings.join(', ')}`);
  for (const name of matchesOf(text, /(?<![\w.-])(?:docker-compose\.[a-z0-9-]+\.yml|Caddyfile\.[a-z0-9-]+\.snippet|RUNBOOK(?:-[a-z0-9-]+)?\.md|README\.md|\.env\.[A-Za-z0-9._-]*[A-Za-z0-9])/g)) {
    if (!NAMED_FILES.includes(name)) problems.push(`the runbook names ${name}, which is no file of this pack`);
  }
  for (const name of [...Object.values(FILES), ENV_FILE]) if (!mentions(text, name)) problems.push(`the runbook never names ${name}`);
  const code = blocksOf(text).flatMap((block) => block.split('\n').map((line) => line.trim()));
  for (const line of code) {
    const compose = /\bdocker compose\b.*/.exec(line)?.[0];
    if (compose === undefined) continue;
    if (/(?:^|\s)-f (\S+)/.exec(compose)?.[1] !== FILES.compose) problems.push(`a docker compose command names no -f ${FILES.compose}: ${compose}`);
    const verb = /-f \S+ (up|stop|start|logs|ps|rm|config|down|pull)\b([^|)&;]*)/.exec(compose);
    for (const token of (verb?.[2] ?? '').split(/\s+/).filter((part) => part !== '' && !part.startsWith('-'))) {
      if (!SERVICE_NAMES.includes(token)) problems.push(`a docker compose command names the service ${token}, which is no service of this pack`);
    }
    if (/\bconfig\b/.test(compose) && !/--quiet|-q\b/.test(compose) && !line.includes('cd "$scratch" &&')) problems.push('docker compose config prints the environment: run it with --quiet, or in the scratch folder with the stand-in files');
  }
  for (const port of matchesOf(text, /(?:127\.0\.0\.1|localhost):\d+/g)) if (!LOOPBACK_PORTS.includes(Number(port.split(':')[1]))) problems.push(`the runbook names the loopback port ${port}, which is no port of this pack`);
  const numbers = matchesOf(text, /\b\d{4}\b/g);
  for (const port of LOOPBACK_PORTS) if (!numbers.includes(String(port))) problems.push(`the runbook never names the port ${port}`);
  for (const name of matchesOf(text, /(?<![\w./-])sourcing-[a-z]+(?![\w-])/g)) if (![...CONTAINERS, ...OTHER_NAMES].includes(name)) problems.push(`the runbook names ${name}, which is no container of this pack`);
  for (const name of CONTAINERS) if (!text.includes(name)) problems.push(`the runbook never names the container ${name}`);
  for (const name of [...matchesOf(text, /(?<![\w./-])(?:reorder|orders|priorauth|intake)-(?:runtime|service|state)(?![\w-])/g), ...matchesOf(text, /(?<![\w./-])bids-[a-z]+-(?:runtime|service)(?![\w-])/g)]) {
    problems.push(`the runbook names ${name}, which is a name of another pack`);
  }
  for (const name of matchesOf(text, /mp-suppliers-[a-z-]+\.vector\.apexfusion\.org/g)) if (name !== HOST) problems.push(`the runbook names the host ${name}, which is no host of this pack`);
  if (!/(?<![\w.-])mp-suppliers-sourcing\.vector\.apexfusion\.org(?![\w-])/.test(text)) problems.push(`the runbook never names the host ${HOST}`);
  const commands = code.join('\n');
  if (/\bdocker (?:build|run)\b|--build\b|\bdocker compose[^\n]* (?:build|run)\b/.test(commands)) problems.push('the host builds no image and starts no container outside compose');
  if (/\bdown\b[^\n]*(?:\s-v\b|--volumes)/.test(commands)) problems.push('down never takes -v: the volume holds the records of the service');
  if (/\bsetup\.sh\b/.test(text)) problems.push('the folder is made with install -d: the set-up script refuses on a host that already runs agents');
  // A restart waits 2 minutes first, then checks that the runtime says free, then runs its command at once, all in one line. A check before the wait leaves a gap in which a job can start and be cut.
  const guarded = /^sleep 120; if curl -s --max-time 5 http:\/\/127\.0\.0\.1:8107\/status \| grep -q '"status":"free"'; then docker compose -f docker-compose\.sourcing-agent\.yml [^;]+; else echo '[^']+'; fi$/;
  for (const line of code) {
    if (/--force-recreate|\bdocker (?:restart|stop)\b|\bcompose restart\b/.test(line) && !guarded.test(line)) problems.push(`a restart waits 2 minutes, then checks that the runtime says free, then runs its command at once, in one line: ${line}`);
  }
  const printing = [/\bcat\s+\S*\.env/, /\bprintenv\b/, /\bdocker inspect\b/, /\bdocker exec\b[^\n]*\b(?:env|printenv)\b/, /\becho\s+"?\$\{?[A-Z_]*PRIV_KEY/];
  for (const pattern of printing) if (code.some((line) => pattern.test(line))) problems.push(`a command prints an env file or an environment: ${pattern.source}`);
  problems.push(...keyProblems(text).map((problem) => `the runbook: ${problem}`));
  return problems;
}

/** The folders that the tests of the commands make: each test removes its own at the end of the file. */
const folders: string[] = [];
/** What a shell script of the runbook does in a new folder: the folder, what it printed, and its status. The files are made first. A stub is a program that stands in front of the real one in the PATH. */
function runInFolder(script: string, files: Readonly<Record<string, string>>, stubs: Readonly<Record<string, string>> = {}): { readonly dir: string; readonly out: string; readonly err: string; readonly status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'sourcing-deploy-'));
  folders.push(dir);
  mkdirSync(join(dir, 'bin'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  for (const [name, content] of Object.entries(stubs)) {
    writeFileSync(join(dir, 'bin', name), `#!/bin/sh\n${content}\n`);
    chmodSync(join(dir, 'bin', name), 0o755);
  }
  const run = spawnSync('bash', ['-c', script], { cwd: dir, env: { PATH: `${join(dir, 'bin')}:${process.env.PATH ?? ''}`, HOME: dir }, encoding: 'utf8' });
  return { dir, out: run.stdout, err: run.stderr, status: run.status };
}
const LINUX = process.platform === 'linux';

/** What the service of the pack refuses at its start, each with the words of the refusal, as the real code says them, and the change of the environment that makes the code say them. */
const REFUSALS: ReadonlyArray<readonly [words: string, change: Readonly<Record<string, string | undefined>>]> = [
  ['SOURCING_SERVICE_PRIV_KEY_HEX is required', { SOURCING_SERVICE_PRIV_KEY_HEX: '' }],
  ['must be 64 hex characters', { SCORER_3_DELEGATION_PRIV_KEY_HEX: 'ab' }],
  ['holds the same key as', { SCORER_3_DELEGATION_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.service) }],
  ['each key of the service must be a key of its own', { SCORER_3_DELEGATION_PRIV_KEY_HEX: rawKey(KEY_NUMBERS.service) }],
  ["holds the key of SUPPLIER_PKH: the supplier key is the runtime's", { SUPPLIER_PKH: testKey(KEY_NUMBERS.service).keyHash, SUPPLIER_PUB_KEY_HEX: testKey(KEY_NUMBERS.service).publicKey }],
  ['which belongs in SOURCING_SERVICE_PRIV_KEY_HEX alone', { AGENT_VERSION: rawKey(KEY_NUMBERS.service) }],
  ['holds the service token, which belongs in SERVICE_AUTH_HEADER alone', { AGENT_VERSION: TOKEN }],
  ['SOURCING_SERVICE_PKH (56 characters) is not the key hash of the key in SOURCING_SERVICE_PRIV_KEY_HEX', { SOURCING_SERVICE_PKH: 'cd'.repeat(28) }],
  ['SERVICE_AUTH_HEADER is required', { SERVICE_AUTH_HEADER: '' }],
  ['must be printable ASCII', { SERVICE_AUTH_HEADER: 'Bearer \u00e9' }],
  ['SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH', { SUPPLIER_PUB_KEY_HEX: HEX }],
  ['AGENT_DID is required', { AGENT_DID: '' }],
  ['must be did:vector: and 64 lowercase hex characters', { AGENT_DID: 'did:vector:abc' }],
  ['SCORER_1_DID holds the DID of AGENT_DID', { SCORER_1_DID: AGENT_DID }],
  ['SCORER_2_DID holds the same DID as SCORER_1_DID', { SCORER_2_DID: SCORER_DIDS[0] }],
  ['COMPLIANCE_ISSUER_PKH is required', { COMPLIANCE_ISSUER_PKH: '' }],
  ['must be 56 hex characters', { COMPLIANCE_ISSUER_PKH: 'ab' }],
  ['MOCK_PUBLIC_BASE must be an https origin', { MOCK_PUBLIC_BASE: 'http://mock.example.test' }],
  ['MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE', { MOCK_MTLS_BASE: 'https://mock.example.test' }],
  ['VECTOR_MODULE1_MANIFEST must be an https address', { VECTOR_MODULE1_MANIFEST: 'http://example.test/manifest.json' }],
  ['VECTOR_MODULE1_MANIFEST must be pinned to a commit', { VECTOR_MODULE1_MANIFEST: 'https://example.test/main/manifest.json' }],
  ['IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give', { IDENTITY_POLICY_ID: '0'.repeat(56) }],
  ['VECTOR_OGMIOS_URL must be an https address', { VECTOR_OGMIOS_URL: 'http://node.example.test' }],
  ['FAULT_MODE must be empty or "invert_scores"', { FAULT_MODE: 'alter_after_approval' }],
  ['ADVERT_MAX_PROCESSING_MS must be at least 5400000', { ADVERT_MAX_PROCESSING_MS: '1000' }],
  ['ADVERT_MAX_PROCESSING_MS must be at most 86400000', { ADVERT_MAX_PROCESSING_MS: '86400001' }],
  ['LLM_MODEL_ALLOWLIST is required', { LLM_MODEL_ALLOWLIST: '' }],
  ['must be a whole number of lovelace of more than 0', { LLM_MAX_SUPPLIER_BOND_LOVELACE: 'abc' }],
  ['must be a whole number of lovelace of more than 0', { QUOTE_MAX_PRICE_LOVELACE: 'abc' }],
  ['must be a whole number of lovelace of more than 0', { DISPUTE_CHALLENGE_STAKE_LOVELACE: '0' }],
  ['DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000', { DISPUTE_MIN_WINDOW_LEFT_MS: '1999' }],
  ['DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at most 30000', { DISPUTE_READ_TIMEOUT_MS: '30001' }],
  ['the settings of the co-sign route are refused: COSIGN_ALLOWLIST is not set', { COSIGN_ALLOWLIST: undefined }],
];

describe('deploy/server/RUNBOOK-sourcing-agent.md', () => {
  test('the real runbook passes: the sections in order, the files, the commands and the numbers of the pack', () => {
    expect(runbookProblems(runbookText)).toStrictEqual([]);
    expect([...runbookText.matchAll(/^## (.+)$/gm)].map((hit) => hit[1])).toStrictEqual(SECTIONS);
  });

  test('the table of the first section gives the container, the port, the host name, the advert model, the price, the bonds and the lock, as the code has them', () => {
    const what = sectionOf(runbookText, 'What it is');
    const row = what.split('\n').find((line) => line.startsWith('|') && line.includes(RUNTIME_CONTAINER));
    expect(row, `a row for ${RUNTIME_CONTAINER}`).toBeDefined();
    const cells = row!.split('|').slice(1, -1).map((cell) => cell.trim().replaceAll('`', ''));
    const price = PRICE_DEFAULT_LOVELACE / 1_000_000;
    const bond = SUPPLIER_BOND_LOVELACE / 1_000_000;
    expect(BUYER_BOND_LOVELACE).toBe(SUPPLIER_BOND_LOVELACE);
    expect(cells.slice(1)).toStrictEqual([RUNTIME_CONTAINER, String(RUNTIME_HOST_PORT), HOST, SOURCING_MODEL, String(price), `${bond} and ${bond}`, String(price + 2 * bond)]);
    expect(what).toContain(BID_CAPABILITIES.evaluate);
    for (const ms of [MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]) expect(what, String(ms)).toContain(ms.toLocaleString('en-US'));
    expect(what, 'the window in minutes').toContain(`${MIN_PROCESSING_WINDOW_MS / 60_000} minutes`);
    for (const part of [SERVICE_CONTAINER, String(SERVICE_HOST_PORT), '/cosign/delegate', 'does one job at a time', 'scorer-1', 'scorer-2', 'scorer-3', 'use case 3 (supplier bid evaluation)', 'locked up to the window',
      'The Module-3 stake of the agent, under its service key.', 'never makes a stake and never makes a claim', 'it files a challenge only', 'COMPLIANCE_ISSUER_PKH']) expect(what, part).toContain(part);
    expect(what, 'the status word, in lower case, until the first live run').toContain('stays `proposed` until the first live run');
  });

  test('the operator claim task uses the agent service key and withdraws an unchallenged claim', () => {
    const what = sectionOf(runbookText, 'What it is');
    for (const part of [
      '`claim` task of the operator pack supports one Module-1 claim',
      'before each clean or failure run', 'signs with the service key',
      `${CLAIM_STAKE_LOVELACE / 1_000_000n} units (${CLAIM_STAKE_LOVELACE.toLocaleString('en-US')} lovelace)`,
      `challenge window is ${CLAIM_WINDOW_MS / 3_600_000} hours`, '`claim cleanup` withdraws the claim if nobody challenged it',
    ]) expect(what).toContain(part);
    expect(USE_CASE_NAMES).toContain('bid-evaluation');
    expect(sectionOf(runbookText, 'The env file')).toContain("The operator pack uses this key to sign the agent's claim.");
  });

  test('the files named in the first table are the files of the pack, and the second section lists all of them', () => {
    const files = sectionOf(runbookText, 'The files');
    for (const name of [...Object.values(FILES), ENV_FILE]) expect(files, name).toContain(`\`${name}\``);
  });

  test('the memory gate is 1,024 MiB of MemAvailable before each start, and a start that would fail it starts nothing and reports the line; the folder is made with install -d, owned by the service user with mode 750', () => {
    const gate = sectionOf(runbookText, 'The memory gate');
    for (const part of ['MemAvailable', '1,024 MiB', '/proc/meminfo', 'Start no container while it prints `stop`', 'no container starts: report the line that it printed', 'docker stats', 'during the first `propose` job']) expect(gate, part).toContain(part);
    const folder = sectionOf(runbookText, 'The folder');
    for (const part of ['/srv/agents/sourcing-agent', '750', 'agents', 'sudo install -d -m 750 -o agents -g agents /srv/agents/sourcing-agent', 'Make it with `install -d`']) expect(folder, part).toContain(part);
    expect(runbookText, 'the set-up script refuses on a host that already runs agents').not.toContain('setup.sh');
    expect(sectionOf(runbookText, 'The DNS record')).toContain('DNS only');
    expect(sectionOf(runbookText, 'The DNS record')).toContain(HOST);
  });

  test('the env file is made with mode 600, the keys are never typed or printed, and the checks print names and lengths only', () => {
    const file = sectionOf(runbookText, 'The env file');
    for (const part of ['600', 'umask 077', ENV_FILE, '<commit>', 'SERVICE_AUTH_HEADER', ...SUPPLIER_LINES, ...KEY_VARIABLES, 'ADVERT_REF', 'AGENT_ID', 'AGENT_DID', ...SCORER_LINES, 'COMPLIANCE_ISSUER_PKH', 'COSIGN_ALLOWLIST', 'OPERATOR_CONTACT',
      'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'operator pack', 'never typed', 'stays `proposed` until the first live run', 'FAULT_MODE', 'the compliance registry']) expect(file, part).toContain(part);
    expect(file).toMatch(/one pure output of 5 units/);
    expect(file).toMatch(/four wallets/);
    expect(file).toMatch(/ten keys, and all ten are different/);
    expect(file).toMatch(/The six keys of the three scorers pay nothing/);
  });

  test('the env file section names each setting that the service reads and each line that the runtime reads, as a whole name', () => {
    const file = sectionOf(runbookText, 'The env file');
    const setByCompose = composeSetNames(parse(composeText) as Model);
    for (const name of [...SETTINGS, ...RUNTIME_READS]) {
      if (OPTIONAL_NAMES.includes(name) || (setByCompose.has(name) && !BOTH.includes(name))) continue;
      expect(mentions(file, name), `the env file section names ${name}`).toBe(true);
    }
    for (const name of ['PORT', 'HOST', 'SOURCING_STATE_DIR']) expect(mentions(file, name), `the env file section says that the compose file sets ${name}`).toBe(true);
    expect(file).toContain('The compose file sets them. Do not write them in the env file.');
  });

  test('both images are pulled by the tag of the reviewed commit and pinned by digest', () => {
    const images = sectionOf(runbookText, 'The images');
    for (const part of [SERVICE_IMAGE, RUNTIME_IMAGE, '<full git commit sha>', 'sha256', 'denied', 'read:packages', FILES.compose, '<digest>']) expect(images, part).toContain(part);
  });

  test('the compose file is rendered with a stand-in file, never with the real env file that holds keys', () => {
    const check = sectionOf(runbookText, 'Check the compose file');
    for (const part of ['scratch', '--quiet', FILES.example, 'config', "grep -c '@sha256:<digest>'", '8107', '9105', VOLUME]) expect(check, part).toContain(part);
  });

  test('the start order is the service, then the Caddy block and the public checks, then the advert, then the runtime, each start after the memory gate and the runtime without its dependencies', () => {
    const start = sectionOf(runbookText, 'The start order');
    const at = (part: string): number => start.indexOf(part);
    const order = [`up -d ${SERVICE_NAME}`, 'The Caddy block', 'Post the advert', 'up -d --no-deps runtime'];
    for (const part of order) expect(at(part), part).toBeGreaterThanOrEqual(0);
    expect(order.map(at)).toStrictEqual([...order.map(at)].sort((a, b) => a - b));
    expect(start).toContain('The memory gate');
    expect(start, 'no start follows a stop of the gate').toContain('When the gate prints `stop`, start nothing, and stop the work at that step.');
    expect(start.split('Pass the memory gate').length - 1, 'the gate stands before the start of the service and before the start of the runtime').toBe(2);
    for (const part of [BID_CAPABILITIES.evaluate, SOURCING_MODEL, MIN_PROCESSING_WINDOW_MS.toLocaleString('en-US'), 'detail_hash', 'detail_uri', 'endpoint_url', 'ADVERT_REF', 'listening on', 'up -d --no-deps --force-recreate runtime', 'advert_not_active',
      ENV_FILE, `${PROJECT}_default`, VOLUME]) expect(start, part).toContain(part);
  });

  test('the checks cover the two loopback ports, the public ports of the pack, the hash of the manifest, the card of the runtime, the co-sign route and the blank keys of all nine key variables', () => {
    const checks = sectionOf(runbookText, 'The checks');
    for (const part of ['/healthz', '/status', 'free', 'manifest-hash.mjs', '/.well-known/agent-card.json', '/cosign/delegate', 'bad_shape', 'detail_hash', "name='^sourcing-'", 'docker stats', 'blank', HOST]) expect(checks, part).toContain(part);
    for (const port of LOOPBACK_PORTS) expect(checks, String(port)).toContain(String(port));
    const blank = blockWith(checks, `docker exec ${RUNTIME_CONTAINER}`);
    for (const name of KEY_VARIABLES) expect(blank, `the check of the runtime names ${name}`).toContain(`$${name}`);
    expect(blank, 'the check of the service names the supplier key').toContain(`docker exec ${SERVICE_CONTAINER} sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX"`);
  });

  test('the Caddy section gives the join of the network, the markers, the in-place append, the validation, the reload and the way back, and never a restart of Caddy', () => {
    const caddy = sectionOf(runbookText, 'The Caddy block');
    for (const part of [`docker network connect ${NETWORK} <caddy container>`, BEGIN, END, '<caddyfile>', 'caddy validate', 'caddy reload', FILES.snippet, 'inode', 'DNS only', 'Only this way works for this pack', 'container names', 'lists the runtime only after']) expect(caddy, part).toContain(part);
    expect(caddy).not.toMatch(/caddy restart|docker restart <caddy/);
    expect(caddy).not.toMatch(/\bsed -i\b[^\n]*<caddyfile>/);
  });

  test('the restart rule waits first, then checks that the runtime says free, then runs the command at once; it names every action that is a restart, says that the allowlist is an env line, gives the waits of the service, the lock of the escrow and the end of a job that the runtime hung up on', () => {
    const rule = sectionOf(runbookText, 'The restart rule');
    for (const part of ['/status', 'free', 'working', 'docker restart', 'docker compose restart', '--force-recreate', '120', '300', '330', 'SERVICE_AUTH_HEADER', FILES.compose, 'COSIGN_ALLOWLIST', 'env line', '2 minutes', String(RUNTIME_HOST_PORT), 'at once',
      'Never check first and then wait', 'cover that wait only', '5,220,000 ms', '5,400,000 ms (90 minutes)', 'stay locked up to the window of the advert', 'the service stops that job at its next step', 'a step that has started runs to its end', 'janitors',
      `docker logs --tail 20 ${SERVICE_CONTAINER}`]) expect(rule, part).toContain(part);
    expect(rule).toMatch(/reload/);
    const at = (part: string): number => rule.indexOf(part);
    const steps = ['1. Wait 2 minutes', '2. Check that the runtime says `free`', '3. Run the `up` command at once'];
    expect(steps.map(at).every((position) => position >= 0), 'the three steps').toBe(true);
    expect(steps.map(at)).toStrictEqual([...steps.map(at)].sort((a, b) => a - b));
    const command = blockWith(rule, 'sleep 120');
    expect(command.indexOf('sleep 120'), 'the wait comes first').toBe(0);
    expect(command.indexOf('sleep 120')).toBeLessThan(command.indexOf('/status'));
    expect(command.indexOf('/status')).toBeLessThan(command.indexOf('up -d --no-deps --force-recreate'));
    expect(command, 'the command runs only when the runtime says free').toContain(`grep -q '"status":"free"'; then docker compose`);
  });

  test('the fault switch section gives the one value of the agent, says that it is for a failure run only, that the service is created again only when the runtime says free and never during a run, that an env change needs a new container, that the check reads the switch from the running container, and that the result carries the value', () => {
    const fault = sectionOf(runbookText, 'The fault switch');
    const value = FAULT_MODES['sourcing-agent'][0];
    expect(value).toBe('invert_scores');
    for (const part of ['FAULT_MODE', value, 'failure run only', 'clean run', 'only when the runtime says `free`, and never during a run', 'An env change needs a new container', 'from the running container, never from the file', 'fault_mode', 'The restart rule', ENV_FILE,
      `docker exec ${SERVICE_CONTAINER}`, 'write `FAULT_MODE=` again', 'never changes the hash of the manifest']) expect(fault, part).toContain(part);
    expect(fault).toMatch(/The runtime does not read the switch/);
    expect(blocksOf(fault)).toHaveLength(1);
    expect(runbookText.indexOf('\n## The fault switch\n')).toBeGreaterThan(runbookText.indexOf('\n## The restart rule\n'));
    expect(runbookText.indexOf('\n## The fault switch\n')).toBeLessThan(runbookText.indexOf('\n## The failure table\n'));
  });

  test('the failure table names the refusals of the service in the words of the code, the codes of the runtime and of the co-sign route with their status, and the reasons that an operator sees in a result', () => {
    const table = sectionOf(runbookText, 'The failure table');
    const codes = [
      'busy', 'supplier_busy', 'unauthorized', 'shutting_down', 'bad_context', 'bad_wire', 'request_too_large', 'bad_shape', 'delegation_not_mine', 'internal', 'precheck_timeout', 'precheck_unreachable', 'precheck_failed',
      'precheck_bad_status', 'principal_not_allowed', 'spends_agent_funds', 'key_in_use', 'check_unavailable', 'not_a_delegation', 'not_for_this_agent', 'expired', 'advert_not_active',
      'ledger_unavailable', 'delegation_not_found', 'delegation_key_unknown', 'bidders_unavailable', 'no_bidders', 'shortlist_unknown_bidder', 'nobody_invited', 'ranking_invalid', 'decision_mismatch', 'bad_document', 'no_quotes',
      'deadline', 'aborted', 'duplicate_rfq', 'vault_refused', 'no_price_list', 'status_unreadable', 'quote_invalid', 'quote_not_from_bidder', 'quote_not_for_rfq', 'quote_not_from_list', 'suspended', 'revoked', 'retired', 'not_found',
      'decision_failed', 'decision_timeout', 'store_write_failed', 'sub_delegation_', 'scorer_token_failed', 'vendors_refused', 'vendors_failed', 'vendors_invalid', 'scorer_threw', 'scorer_timed_out', 'score_invalid', 'llm_',
      'hire_threw', 'model_output_invalid', 'token_failed', 'ranking_not_for_tenant', 'mock_system_failed',
    ];
    for (const code of codes) expect(table, code).toContain(`\`${code}\``);
    for (const part of ['cannot start', 'invalid reference format', 'denied', '502', NETWORK, ...KEY_VARIABLES, 'outcome refused_by_system', 'approval_expired', 'delegation_ended', 'outcome <outcome>', '8107', '9105',
      'The Module-1 manifest (VECTOR_MODULE1_MANIFEST)', 'the node gave no start time of the chain', 'SOURCING_STATE_DIR names /data, which cannot be written', '2,910,000 ms', '1,080,000 ms', '200 with its `reason`', ', bidders <count>, quotes <count>',
      'a new request with a new `rfq_id`']) expect(table, part).toContain(part);
    const rows = table.split('\n').filter((line) => line.startsWith('|') && !line.startsWith('|---') && !line.startsWith('| Symptom'));
    expect(rows.length).toBeGreaterThan(55);
    for (const row of rows) expect(row.split('|').length, row).toBe(5);
    // A status in the first cell is the status that the code gives. The runtime codes are those of the template runtime, and `bad_context` is the answer of the server of the service kit.
    const statusOf: Readonly<Record<string, number>> = { ...ERROR_STATUS, ...COSIGN_STATUS, precheck_timeout: 503, precheck_unreachable: 503, precheck_failed: 503, precheck_bad_status: 502, supplier_busy: 409, bad_context: 400, advert_not_active: 503 };
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
  });

  test('each reason that the table gives for a failed job or a bidder that was left out is a code that the service can give: a code of propose, of the quote hires, of the scoring or of execute, or a code of the model hire', () => {
    const table = sectionOf(runbookText, 'The failure table');
    const hire = readFileSync(join(root, 'packages', 'usecase-kit', 'src', 'decision', 'decide.ts'), 'utf8');
    for (const part of ["'hire_threw'", "'llm_out_of_time'", "'model_output_invalid'"]) expect(hire, `the code of the model hire has ${part}`).toContain(part);
    const known = new Set<string>([...PROPOSE_FAILURES, ...EXECUTE_FAILURES, ...SCORING_FAILURES, ...QUOTE_CODES, 'hire_threw', 'model_output_invalid']);
    const prefixes = ['sub_delegation_', 'llm_'];
    const rows = table.split('\n').filter((line) => line.startsWith('|') && /as the `?reason`?/.test(line.split('|')[1]));
    expect(rows.length).toBeGreaterThanOrEqual(14);
    const seen = new Set<string>();
    for (const row of rows) {
      for (const hit of row.split('|')[1].matchAll(/`([a-z0-9_]+)`/g)) {
        const code = hit[1];
        if (code === 'reason' || code === 'execute') continue;
        seen.add(code);
        if (code.endsWith('_')) expect(prefixes, `the prefix ${code}`).toContain(code);
        else expect(known.has(code), `${code} is a code of the service: ${row.slice(0, 80)}`).toBe(true);
      }
    }
    expect([...known].some((code) => code.startsWith('sub_delegation_')), 'the code has reasons that start with sub_delegation_').toBe(true);
    for (const code of ['bidders_unavailable', 'no_bidders', 'no_quotes', 'vault_refused', 'quote_invalid', 'not_found', 'sub_delegation_', 'scorer_token_failed', 'vendors_refused', 'token_failed', 'ranking_not_for_tenant', 'mock_system_failed', 'deadline', 'aborted', 'llm_']) {
      expect(seen.has(code), `the table has ${code}`).toBe(true);
    }
    // The one code that is named twice would be a row that says two things: each code stands in one row of reasons.
    const named = rows.flatMap((row) => [...row.split('|')[1].matchAll(/`([a-z0-9_]+)`/g)].map((hit) => hit[1])).filter((code) => code !== 'reason' && code !== 'execute');
    expect(named.filter((code, at) => named.indexOf(code) !== at), 'a code stands in one row only').toStrictEqual([]);
  });

  test('each start refusal in the table is said by the real start code in these words, and the table has the words', async () => {
    const table = sectionOf(runbookText, 'The failure table');
    const base = { ...filled(exampleEnv), ...containerEnv(SERVICE_NAME) };
    expect(loadConfig(base), 'the unchanged environment starts').toBeDefined();
    for (const [words, change] of REFUSALS) {
      expect(table, `the table has: ${words}`).toContain(words);
      expect(messageOf(() => loadConfig({ ...base, ...change })), `the code says: ${words}`).toContain(words);
    }
    // A state folder that cannot be written stops the start before the node is asked for anything.
    const message = await startService({ ...base, SOURCING_STATE_DIR: '/proc/no-such-folder' }).then(() => 'started', (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(message.replace('/proc/no-such-folder', '/data')).toContain('environment variable SOURCING_STATE_DIR names /data, which cannot be written');
    // The refusals of the wiring and of the manifest reader stand in their sources, with the name of the setting that the table gives.
    const wiring = readFileSync(new URL('../src/serve/wiring.ts', import.meta.url), 'utf8');
    const reader = readFileSync(join(root, 'packages', 'buyer-core', 'src', 'vendored', 'mcp', 'jury-deployment.ts'), 'utf8');
    expect(wiring).toContain('the node gave no start time of the chain');
    expect(wiring).toContain('names another identity registry than IDENTITY_POLICY_ID');
    expect(reader).toContain('cannot be fetched');
    expect(MODULE1_MANIFEST_ENV).toBe('VECTOR_MODULE1_MANIFEST');
    expect(table).toContain(`The Module-1 manifest (${MODULE1_MANIFEST_ENV})\` cannot be fetched`);
    expect(table).toContain(`the Module-1 manifest (${MODULE1_MANIFEST_ENV}) names another identity registry than IDENTITY_POLICY_ID`);
  });

  test('the messages of the template runtime in the table are the ones that the runbook of the Reorder Agent holds', () => {
    const table = sectionOf(runbookText, 'The failure table');
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
      `\`docker compose -f ${FILES.compose} stop service\``,
      'docker network disconnect', `docker compose -f ${FILES.compose} down`,
    ].map((part) => out.indexOf(part));
    expect(order[0]).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
    expect(blocksOf(runbookText).filter((block) => /\bdocker compose\b[^\n]* stop\b/.test(block))).toStrictEqual([running]);
    expect(out).toContain(VOLUME);
  });

  const faults: readonly Fault[] = [
    ['a title of another pack', (t) => swap(t, '# Runbook: the Sourcing Agent on the agents host\n', '# Runbook: the Prior Authorization Agent on the agents host\n'), 'the title must be'],
    ['a section missing', (t) => swap(t, '\n## The restart rule\n', '\n## Another heading\n'), 'the sections must be, in this order'],
    ['the fault switch missing', (t) => swap(t, '\n## The fault switch\n', '\n## Another heading\n'), 'the sections must be, in this order'],
    ['the sections in another order', (t) => exchange(t, '\n## The checks\n', '\n## The Caddy block\n'), 'the sections must be, in this order'],
    ['the fault switch before the restart rule', (t) => exchange(t, '\n## The restart rule\n', '\n## The fault switch\n'), 'the sections must be, in this order'],
    ['a file of another pack', (t) => `${t}\nSee docker-compose.prior-authorization-agent.yml.\n`, 'the runbook names docker-compose.prior-authorization-agent.yml, which is no file of this pack'],
    ['the runbook of another pack', (t) => `${t}\nSee RUNBOOK-reorder-agent.md.\n`, 'the runbook names RUNBOOK-reorder-agent.md, which is no file of this pack'],
    ['an env file of another agent', (t) => `${t}\nRead .env.prior-authorization-agent.\n`, 'the runbook names .env.prior-authorization-agent, which is no file of this pack'],
    ['an env file with another name', (t) => `${t}\nRead .env.sourcing-agent-huge.\n`, 'the runbook names .env.sourcing-agent-huge, which is no file of this pack'],
    ['a compose command without the file', (t) => `${t}\n\`\`\`sh\ndocker compose up -d service\n\`\`\`\n`, 'a docker compose command names no -f docker-compose.sourcing-agent.yml'],
    ['a compose command with the file of another pack', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.reorder-agent.yml up -d service\n\`\`\`\n`, 'a docker compose command names no -f docker-compose.sourcing-agent.yml'],
    ['a service that the pack does not have', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.sourcing-agent.yml up -d runtime-huge\n\`\`\`\n`, 'a docker compose command names the service runtime-huge'],
    ['a compose config that prints the environment', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.sourcing-agent.yml config\n\`\`\`\n`, 'docker compose config prints the environment'],
    ['a port of another pack', (t) => `${t}\ncurl http://127.0.0.1:8101/healthz\n`, 'the runbook names the loopback port 127.0.0.1:8101'],
    ['the port of a Bid Desk', (t) => `${t}\ncurl http://127.0.0.1:8108/healthz\n`, 'the runbook names the loopback port 127.0.0.1:8108'],
    ['a container of this pack that does not exist', (t) => `${t}\ndocker logs sourcing-huge\n`, 'the runbook names sourcing-huge, which is no container of this pack'],
    ['a container of another pack', (t) => `${t}\ndocker logs reorder-service\n`, 'the runbook names reorder-service, which is a name of another pack'],
    ['a container of a Bid Desk', (t) => `${t}\ndocker logs bids-alfa-service\n`, 'the runbook names bids-alfa-service, which is a name of another pack'],
    ['the host of another pack', (t) => `${t}\nhttps://mp-suppliers-priorauth.vector.apexfusion.org\n`, 'the runbook names the host mp-suppliers-priorauth.vector.apexfusion.org'],
    ['a build on the host', (t) => `${t}\n\`\`\`sh\ndocker build -t x .\n\`\`\`\n`, 'the host builds no image'],
    ['a container started outside compose', (t) => `${t}\n\`\`\`sh\ndocker run --rm alpine true\n\`\`\`\n`, 'the host builds no image and starts no container outside compose'],
    ['a stop that removes the volume', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.sourcing-agent.yml down -v\n\`\`\`\n`, 'down never takes -v'],
    ['a command that prints an env file', (t) => `${t}\n\`\`\`sh\ncat .env.sourcing-agent\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that prints the environment of a container', (t) => `${t}\n\`\`\`sh\ndocker exec sourcing-service printenv\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that prints the environment with env', (t) => `${t}\n\`\`\`sh\ndocker exec sourcing-service env\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a command that inspects a container', (t) => `${t}\n\`\`\`sh\ndocker inspect sourcing-runtime\n\`\`\`\n`, 'a command prints an env file or an environment'],
    ['a key', (t) => `${t}\nSOURCING_SERVICE_PRIV_KEY_HEX=${HEX}\n`, 'the runbook: the text has a run of hex digits'],
    ['the key of a scorer', (t) => `${t}\nSCORER_1_AUTH_PRIV_KEY_HEX=${HEX}\n`, 'the runbook: the text has a run of hex digits'],
    ['the folder made by the set-up script', (t) => `${t}\n\`\`\`sh\nsudo ./setup.sh sourcing-agent\n\`\`\`\n`, 'the folder is made with install -d'],
    ['a recreate with no wait and no check', (t) => `${t}\n\`\`\`sh\ndocker compose -f docker-compose.sourcing-agent.yml up -d --no-deps --force-recreate service\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['a check, then a wait, then the command', (t) => `${t}\n\`\`\`sh\ncurl -s http://127.0.0.1:8107/status; sleep 120; docker compose -f docker-compose.sourcing-agent.yml up -d --no-deps --force-recreate service\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['a restart with docker restart', (t) => `${t}\n\`\`\`sh\ndocker restart sourcing-runtime\n\`\`\`\n`, 'a restart waits 2 minutes, then checks'],
    ['the check before the wait, in the line of the command', (t) => swap(t, `sleep 120; if curl -s --max-time 5 http://127.0.0.1:8107/status | grep -q '"status":"free"'; then docker compose -f docker-compose.sourcing-agent.yml up -d`, `if curl -s --max-time 5 http://127.0.0.1:8107/status | grep -q '"status":"free"'; then sleep 120; docker compose -f docker-compose.sourcing-agent.yml up -d`), 'a restart waits 2 minutes, then checks'],
  ];
  test('each copy that breaks one rule is refused, in the words of that rule', () => {
    expect(faults.length).toBeGreaterThan(30);
    for (const [what, change, expected] of faults) {
      const problems = runbookProblems(change(runbookText));
      expect(problems.some((problem) => says(problem, expected)), `${what}: found ${JSON.stringify(problems)}`).toBe(true);
    }
  });

  test('the twins: a command with --quiet, a command in the scratch folder, a start without dependencies and a comment about a file of the pack are accepted', () => {
    const accepted = `${runbookText}\n\`\`\`sh\ndocker compose -f ${FILES.compose} config --quiet\n(cd "$scratch" && docker compose -f ${FILES.compose} config | grep image)\ndocker compose -f ${FILES.compose} up -d --no-deps runtime\n\`\`\`\n`;
    expect(runbookProblems(accepted)).toStrictEqual([]);
    expect(runbookProblems(`${runbookText}\nThe file ${FILES.snippet} holds the block. See RUNBOOK.md and README.md.\n`)).toStrictEqual([]);
    expect(runbookProblems(`${runbookText}\nThe volume ${VOLUME} and the project ${PROJECT} are names of this pack.\n`)).toStrictEqual([]);
  });

  test('a name stands in a text as a whole name only: a longer name and a name before a dot and a letter are not it', () => {
    expect(mentions('see .env.sourcing-agent here', ENV_FILE)).toBe(true);
    expect(mentions('see .env.sourcing-agent.', ENV_FILE)).toBe(true);
    expect(mentions('see .env.sourcing-agent.example', ENV_FILE)).toBe(false);
    expect(mentions('see x.env.sourcing-agent', ENV_FILE)).toBe(false);
    expect(mentions('see .env.sourcing-agent-huge', ENV_FILE)).toBe(false);
    expect(mentions('see .env.sourcing-agent.example', FILES.example)).toBe(true);
  });

  // The commands of the runbook run as written, on Linux, in a new folder. A stand-in takes the place of docker. No command reads a real file, and none prints a key.
  describe.skipIf(!LINUX)('the shell commands of the runbook', () => {
    const hex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
    const fill: Readonly<Record<string, string>> = {
      SUPPLIER_PRIV_KEY_HEX: hex(1), SUPPLIER_PUB_KEY_HEX: hex(2), SUPPLIER_PKH: hex(3).slice(0, 56), SUPPLIER_ADDRESS: `addr1${'q'.repeat(53)}`,
      ...Object.fromEntries(KEY_VARIABLES.map((name, at) => [name, hex(4 + at)])),
      SERVICE_AUTH_HEADER: `"Bearer ${hex(20)}"`, OPERATOR_CONTACT: 'ops', AGENT_DID: `did:vector:${hex(21)}`, SCORER_1_DID: `did:vector:${hex(22)}`, SCORER_2_DID: `did:vector:${hex(23)}`, SCORER_3_DID: `did:vector:${hex(24)}`,
      COMPLIANCE_ISSUER_PKH: hex(25).slice(0, 56), AGENT_ID: hex(21), MOCK_PUBLIC_BASE: 'https://mock.example.test', MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
    };
    /** The example with every line that the operator fills, filled in. */
    const filledFile = (extra: Readonly<Record<string, string>> = {}): string => Object.entries({ ...fill, ...extra }).reduce((text, [name, value]) => withValue(text, name, value), swap(exampleText, '/<commit>/', `/${'a1'.repeat(20)}/`));

    test('the memory gate command prints ok or stop, and the MiB that are available', () => {
      const run = runInFolder(blockWith(sectionOf(runbookText, 'The memory gate'), '/proc/meminfo'), {});
      expect([run.status, run.err]).toStrictEqual([0, '']);
      expect(run.out).toMatch(/^(ok|stop) \d+ MiB available\n$/);
    });

    test('the token command writes a token of the form "Bearer" and 64 hex digits into its line, prints nothing, and makes a new token each time', () => {
      const script = blockWith(sectionOf(runbookText, 'The env file'), 'SERVICE_AUTH_HEADER=\\"Bearer');
      const tokenOf = (): string => {
        const run = runInFolder(script, { [ENV_FILE]: exampleText });
        expect([run.status, run.out, run.err], 'the command prints nothing').toStrictEqual([0, '', '']);
        return /^SERVICE_AUTH_HEADER=(.*)$/m.exec(readFileSync(join(run.dir, ENV_FILE), 'utf8'))![1];
      };
      const [one, two] = [tokenOf(), tokenOf()];
      for (const token of [one, two]) expect(token).toMatch(/^"Bearer [0-9a-f]{64}"$/);
      expect(one).not.toBe(two);
    });

    test('the check commands of the env file print the placeholders and the empty lines of the example, nothing for a file that is filled in, and the names and lengths that the runbook says', () => {
      const section = sectionOf(runbookText, 'The env file');
      const placeholders = blockWith(section, "grep -nE '^[A-Z0-9_]+=.*<[^>]*>'");
      const empty = blockWith(section, 'empty: $name');
      const lengths = blockWith(section, 'length($2)');
      const twice = blockWith(section, 'uniq -d');
      const required = /for name in ([A-Z0-9_ ]+); do/.exec(empty)![1].split(' ');
      expect(required).toStrictEqual(expect.arrayContaining([...SUPPLIER_LINES, ...KEY_VARIABLES, 'SERVICE_AUTH_HEADER', 'OPERATOR_CONTACT', 'AGENT_DID', ...SCORER_LINES, 'COMPLIANCE_ISSUER_PKH', 'AGENT_ID', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE']));

      const raw = runInFolder([placeholders, empty, twice].join('\n'), { [ENV_FILE]: exampleText });
      const lines = raw.out.split('\n').filter((line) => line !== '');
      const listed = lines.filter((line) => /^\d+:/.test(line)).map((line) => line.replace(/^\d+:/, ''));
      expect(listed.sort(), 'the placeholders of the example').toStrictEqual([...PLACEHOLDER_NAMES].sort());
      expect(lines.filter((line) => line.startsWith('empty: ')), 'the empty lines of the example').toStrictEqual(required.filter((name) => exampleEnv[name] === '').map((name) => `empty: ${name}`));
      expect(lines.filter((line) => !/^\d+:/.test(line) && !line.startsWith('empty: ')), 'no key hash stands twice in the example').toStrictEqual([]);

      const done = runInFolder([placeholders, empty, twice].join('\n'), { [ENV_FILE]: filledFile() });
      expect([done.status, done.out, done.err], 'nothing is printed for a file that is filled in').toStrictEqual([0, '', '']);
      const measured = runInFolder(lengths, { [ENV_FILE]: filledFile() });
      expect(measured.out.split('\n').filter((line) => line !== '')).toStrictEqual([
        'SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 AGENT_ID=64 ADVERT_REF=0 COMPLIANCE_ISSUER_PKH=56 ',
        ...KEY_VARIABLES.flatMap((name) => [`${name}=64`, `${name.replace('_PRIV_KEY_HEX', '_PKH')}=0`]),
      ]);
      const hash = hex(30).slice(0, 56);
      const clash = runInFolder(twice, { [ENV_FILE]: filledFile({ SOURCING_SERVICE_PKH: hash, SCORER_1_AUTH_PKH: hash, SOURCING_DELEGATION_1_PKH: hex(31).slice(0, 56) }) });
      expect(clash.out, 'a key hash that stands twice').toBe(`${hash}\n`);
      const supplierClash = runInFolder(twice, { [ENV_FILE]: filledFile({ SCORER_3_DELEGATION_PKH: fill.SUPPLIER_PKH }) });
      expect(supplierClash.out, 'the key hash of a key of the service that is the supplier key hash').toBe(`${fill.SUPPLIER_PKH}\n`);
    });

    test('the pin command puts the digest of each image in the compose file, and the file then passes the guard; a digest that is not 64 characters changes nothing', () => {
      const script = swap(swap(blockWith(sectionOf(runbookText, 'The images'), 'docker pull'), '<full git commit sha>', 'a1'.repeat(20)), 'cd /srv/agents/sourcing-agent\n', '');
      const stub = (digest: string): string => `case "$1" in pull) ;; image) printf 'ghcr.io/example/image@sha256:${digest}\\n' ;; esac`;
      const pinned = runInFolder(script, { [FILES.compose]: composeText }, { docker: stub('ab'.repeat(32)) });
      expect(pinned.status).toBe(0);
      const text = readFileSync(join(pinned.dir, FILES.compose), 'utf8');
      expect(composeProblems(text)).toStrictEqual([]);
      expect(text.match(/@sha256:[0-9a-f]{64}/g)).toHaveLength(2);
      expect(text.match(/@sha256:<digest>/g), 'no placeholder is left in an image').toBeNull();
      expect(pinned.out.split('\n').filter((line) => line.startsWith('    image: '))).toHaveLength(2);
      const short = runInFolder(script, { [FILES.compose]: composeText }, { docker: stub('abc') });
      expect(short.out).toContain('no digest for sourcing-agent: the compose file is not changed');
      expect(short.out).toContain('no digest for agent-runtime: the compose file is not changed');
      expect(readFileSync(join(short.dir, FILES.compose), 'utf8'), 'the file is not changed').toBe(composeText);
    });

    test('the commands of the Caddy section add the block in place, show that it is there, and take it out again with the bytes that the file had', () => {
      const section = sectionOf(runbookText, 'The Caddy block');
      const own = (block: string): string => swap(block, '<caddyfile>', 'Caddyfile');
      const keep = own(blockWith(section, 'cp -p <caddyfile>'));
      const append = own(blockWith(section, '>> <caddyfile>'));
      const remove = own(blockWith(section, "/d' <caddyfile>"));
      const before = '{\n\tadmin localhost:2019\n}\n\nexisting.example.test {\n\trespond "ok"\n}\n';
      const script = [keep, 'before=$(stat -c %i Caddyfile)', append, 'after=$(stat -c %i Caddyfile)', 'echo "same inode: $([ "$before" = "$after" ] && echo yes || echo no)"', 'cp Caddyfile appended.copy',
        `grep -c '^${BEGIN}$' Caddyfile`, remove, `cmp Caddyfile Caddyfile.before-${PROJECT} && echo restored`].join('\n');
      const run = runInFolder(script, { Caddyfile: before, [FILES.snippet]: snippetText });
      expect(run.out.split('\n').filter((line) => line !== '')).toStrictEqual(['0', 'same inode: yes', '1', 'restored']);
      const appended = readFileSync(join(run.dir, 'appended.copy'), 'utf8');
      const lines = snippetText.split('\n');
      expect(appended).toBe(`${before}${lines.slice(lines.indexOf(BEGIN), lines.indexOf(END) + 1).join('\n')}\n`);
      expect(readFileSync(join(run.dir, 'Caddyfile'), 'utf8'), 'the block is gone').toBe(before);
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

    test('the restart command waits first, then checks that the runtime says free, and runs the up command only then: while a job runs, nothing is restarted', () => {
      const script = blockWith(sectionOf(runbookText, 'The restart rule'), 'sleep 120');
      const free = runInFolder(script, {}, standIns('free'));
      expect(free.status).toBe(0);
      expect(callsOf(free.dir), 'wait, check, then the command').toStrictEqual([
        'sleep 120', `curl -s --max-time 5 http://127.0.0.1:${RUNTIME_HOST_PORT}/status`, `docker compose -f ${FILES.compose} up -d --no-deps --force-recreate service`,
      ]);
      for (const status of ['working', 'offline']) {
        const held = runInFolder(script, {}, standIns(status));
        expect(callsOf(held.dir), `the runtime says ${status}`).toStrictEqual(['sleep 120', `curl -s --max-time 5 http://127.0.0.1:${RUNTIME_HOST_PORT}/status`]);
        expect(held.out).toContain('the runtime does not say free: nothing was restarted');
      }
    });

    test('after the ledger check, the stop refuses an occupied or unreadable runtime and can stop only the service', () => {
      const out = sectionOf(runbookText, 'Back out');
      const script = blockWith(out, '/status');
      const statusRead = `curl -fsS --max-time 5 http://127.0.0.1:${RUNTIME_HOST_PORT}/status`;
      const stop = `docker compose -f ${FILES.compose} stop`;
      const free = runInFolder(script, {}, standIns('free'));
      expect(free.status).toBe(0);
      expect(callsOf(free.dir)).toStrictEqual([statusRead, stop]);
      for (const [status, activeSessions, curlExit] of [['working', 1, 0], ['offline', 0, 0], ['free', 1, 0], ['free', 0, 22]] as const) {
        const held = runInFolder(script, {}, standIns(status, activeSessions, curlExit));
        expect(held.status).not.toBe(0);
        expect(callsOf(held.dir)).toStrictEqual([statusRead]);
      }
      const partial = out.match(/`(docker compose -f \S+ stop service)`/)?.[1];
      expect(partial).toBeDefined();
      const neverStarted = runInFolder(partial!, {}, standIns('offline'));
      expect(neverStarted.status).toBe(0);
      expect(callsOf(neverStarted.dir)).toStrictEqual([`${stop} service`]);
    });

    test('the command of the fault switch prints the value between brackets, and nothing else: empty in a clean run and the one value in a failure run', () => {
      const script = blockWith(sectionOf(runbookText, 'The fault switch'), `docker exec ${SERVICE_CONTAINER}`);
      // The stand-in for docker runs the command that follows `exec <container>` with the switch of the container in its environment.
      const container = (value: string): Record<string, string> => ({ docker: `shift 2\nFAULT_MODE=${value} "$@"` });
      expect(runInFolder(script, {}, container('')).out, 'a clean run').toBe('FAULT_MODE=[]\n');
      expect(runInFolder(script, {}, container(FAULT_MODES['sourcing-agent'][0])).out, 'a failure run').toBe('FAULT_MODE=[invert_scores]\n');
    });
  });
});

// --- the whole pack ------------------------------------------------------------------------------------------------------------------------------------

describe('the pack as a whole', () => {
  test('no file of the pack holds key material: no run of hex digits except the published values, and no value written for a key variable', () => {
    for (const [name, text] of [[FILES.compose, composeText], [FILES.example, exampleText], [FILES.snippet, snippetText], [FILES.runbook, runbookText]] as const) {
      expect(keyProblems(text, PUBLISHED_RUNS), name).toStrictEqual([]);
    }
  });

  test('the guard of key material refuses each fault and passes the clean text', () => {
    expect(keyProblems(`A clean text with a published value ${PUBLISHED.IDENTITY_POLICY_ID}`, PUBLISHED_RUNS)).toStrictEqual([]);
    expect(keyProblems(`A key ${HEX}`)).toStrictEqual(['the text has a run of hex digits that is not a published value: it could be a key']);
    expect(keyProblems(`A key ${HEX}`, new Set([HEX]))).toStrictEqual([]);
    expect(keyProblems('SUPPLIER_PRIV_KEY_HEX=abcdef0123')).toStrictEqual(['the text writes the value of a key']);
    expect(keyProblems('SCORER_2_DELEGATION_PRIV_KEY_HEX=abcdef0123')).toStrictEqual(['the text writes the value of a key']);
    expect(keyProblems('Use ghcr.io/x/y@sha256:<digest>')).toStrictEqual([]);
  });

  test('the host, the ports and the container names are the same in the compose file, the Caddy block, the example and the runbook', () => {
    const compose = parse(composeText) as Model;
    expect(compose.services.runtime.container_name).toBe(RUNTIME_CONTAINER);
    expect(compose.services.runtime.ports).toStrictEqual([`127.0.0.1:${RUNTIME_HOST_PORT}:${RUNTIME_PORT}`]);
    expect(compose.services.runtime.environment.PUBLIC_ORIGIN).toBe(`https://${HOST}`);
    expect(compose.services.service.container_name).toBe(SERVICE_CONTAINER);
    expect(compose.services.service.ports).toStrictEqual([`127.0.0.1:${SERVICE_HOST_PORT}:${PORT_DEFAULT}`]);
    expect(snippetText).toContain(`${HOST} {`);
    expect(snippetText).toContain(`reverse_proxy ${RUNTIME_UPSTREAM}`);
    expect(snippetText).toContain(`reverse_proxy ${SERVICE_UPSTREAM}`);
    expect(runbookText).toContain(HOST);
    expect(runbookText).toContain(RUNTIME_CONTAINER);
    expect(runbookText).toContain(SERVICE_CONTAINER);
    expect(compose.services.runtime.environment.SERVICE_URL).toBe(`http://${SERVICE_UPSTREAM}/`);
  });

  test('the windows are the same in the compose file, the example and the runbook: the deadline of a job, the timeout of the runtime and the window of the advert that the code has', () => {
    const compose = parse(composeText) as Model;
    expect(compose.services.runtime.environment.ADVERT_MAX_PROCESSING_MS).toBe(String(MIN_PROCESSING_WINDOW_MS));
    expect(compose.services.runtime.environment.SERVICE_TIMEOUT_MS).toBe(String(SERVICE_TIMEOUT_MS));
    expect(exampleEnv.ADVERT_MAX_PROCESSING_MS).toBe(String(MIN_PROCESSING_WINDOW_MS));
    for (const ms of [JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS]) expect(composeText, `the comments of the compose file name ${ms}`).toContain(ms.toLocaleString('en-US'));
    expect(composeText).toContain(`${MIN_PROCESSING_WINDOW_MS / 60_000} minutes`);
    expect(exampleText).toContain(String(MIN_PROCESSING_WINDOW_MS));
    expect(exampleText).toContain(`${MIN_PROCESSING_WINDOW_MS / 60_000} minutes`);
    for (const ms of [MIN_PROCESSING_WINDOW_MS, SERVICE_TIMEOUT_MS, JOB_DEADLINE_MS]) expect(runbookText, `the runbook names ${ms}`).toContain(ms.toLocaleString('en-US'));
  });

  test('the services of the compose file are the runtime and the service, and the start file that holds the keys of the service is the one of this package', () => {
    const compose = parse(composeText) as Model;
    expect(Object.keys(compose.services)).toStrictEqual(['runtime', 'service']);
    expect(compose.name).toBe(PROJECT);
    expect(existsSync(join(root, 'agents', 'sourcing-agent', 'src', 'serve', 'start.ts'))).toBe(true);
    expect(compose.services.service.image.split('@')[0]).toBe(SERVICE_IMAGE);
    expect(compose.services.runtime.image.split('@')[0]).toBe(RUNTIME_IMAGE);
  });

  test('the real env file never enters git: the ignore file covers .env.* and lets the examples through', () => {
    const ignore = readFileSync(join(root, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('.env.*');
    expect(ignore).toContain('!.env.*.example');
  });
});

afterAll(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});
