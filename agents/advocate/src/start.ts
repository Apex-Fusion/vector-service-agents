// agents/advocate/src/start.ts
// How the service starts: the environment read into a configuration (loadConfig), and the server put together and started (startService). And how it
// stops: shutdown, and the signals that call it. The settings helpers, the stop and the signals are packages/service-kit's.
//
// Six settings are required, and the service stops at start without them, naming the variable: OPERATOR_CONTACT (published in the manifest, so with no
// default), SUPPLIER_PKH (the supplier key hash, published in the manifest; the supplier key itself is the runtime's and never reaches this service),
// SERVICE_AUTH_HEADER (the value the template runtime sends as the authorization header of every call, which POST / requires: a service without it would
// answer anyone who can reach its port), SUPPLIER_PUB_KEY_HEX (the public key of the supplier key, published beside its key hash), and the two keys of the
// third parties, BRAVE_SEARCH_API_KEY and OPENROUTER_API_KEY. The token and the two keys are the three secrets of the service. A secret put in the wrong line
// of an env file is the mistake this guards against: the token is looked for in every other setting first, and each key after the checks that print no
// value, so before any check that could print the line that holds it; no message shows a value that is hex-shaped or long; and the manifest is searched for
// all three last. The start asks no third party anything: a call to check a key would send it, and use the quota of the service, for nothing a job would not
// show, and a key that is refused shows in the log of the first job (search: the key was refused).
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  assertHeaderValue, assertNoTokenIn, envInt, given, hexOf, lifecycle, listen, refuseSecretIn, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals, tokenForms,
} from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import { blake2b224Hex } from '@vsa/vector-read';
import { modelLabel, openRouterModel } from './model.ts';
import { SEARCH_NAME } from './result.ts';
import { JobSlot, createServer, defaultLog, manifestFromEnv, processingWindow } from './server.ts';
import type { AgentManifest } from './server.ts';

export { SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
export type { ShutdownOutcome } from '@vsa/service-kit';

export const PORT_DEFAULT = 9094;

/**
 * Every setting the service reads. The three secrets belong each in its own line alone: in any other they would be printed by a check that finds fault with
 * the line, or published (OPERATOR_CONTACT, AGENT_DID, AGENT_VERSION, ADVERT_EXPLORER_URL and the rest that go into the manifest the advert hashes).
 */
export const SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
  'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'PORT', 'HOST',
] as const;

/** The two keys of the third parties: the setting of each, what it is in words, and what it is for. */
const BRAVE_KEY = { name: 'BRAVE_SEARCH_API_KEY', what: 'the Brave Search API key', why: 'the key of the Brave Search API, which the two search queries of a job send' };
const OPENROUTER_KEY = { name: 'OPENROUTER_API_KEY', what: 'the OpenRouter API key', why: 'the key of OpenRouter, which the model call of a job sends' };
type ApiKey = typeof BRAVE_KEY;
/** A key as the env example and step 4 of the runbook state it (ruling R-E31): at least 20 characters of letters, digits, dots, hyphens and underscores. */
const API_KEY = /^[A-Za-z0-9._-]{20,}$/;

export interface ServiceConfig {
  manifest: AgentManifest;
  /** The token POST / requires as its authorization header: the value of SERVICE_AUTH_HEADER. A secret: it is in no message, no log line and no manifest. */
  authHeader: string;
  host: string;
  port: number;
  /** The two keys of the third parties. Secrets, like the token. */
  braveApiKey: string;
  openRouterApiKey: string;
  /** The model of OpenRouter a job calls: OPENROUTER_MODEL, DEFAULT_MODEL when it is not set. */
  model: string;
}

/**
 * A key of a third party: required; at least 20 characters of letters, digits, dots, hyphens and underscores (API_KEY, refused with its length only), so that
 * it can be sent as an HTTP header and a far end that echoes it, in a JSON text too, echoes it as it is written, which is the form the log cuts out; and looked
 * for in every other setting, whole, in any case, inside a longer value too, the refusal naming the line that holds it and never the key. Every key it takes
 * is longer than the kit's TOKEN_SEARCH_MIN, under which a secret is not looked for, so each is looked for.
 */
function apiKey(env: NodeJS.ProcessEnv, key: ApiKey): string {
  const value = requiredEnv(key.name, env[key.name], key.why);
  if (!API_KEY.test(value)) throw new Error(`environment variable ${key.name} must be at least 20 characters of letters, digits, dots, hyphens and underscores, and it has ${value.length} characters`);
  refuseSecretIn(env, SETTINGS, tokenForms(value), key.name, (name) =>
    `environment variable ${name} holds ${key.what}, which belongs in ${key.name} alone: it would be printed or published. Take it out of ${name}`);
  return value;
}

/** Throws, naming the key and never printing it, when `published` (the manifest about to be published) holds it: the kit's search, with the key's own words. */
function assertNoKeyIn(published: string, value: string, key: ApiKey): void {
  try {
    assertNoTokenIn(published, value);
  } catch {
    throw new Error(`the manifest would publish ${key.what}: a value that goes into it holds the key of ${key.name}, and the service does not start with it`);
  }
}

/**
 * The configuration of the service from its environment; throws, naming the variable, for one that is required and missing or that is given and wrong. In
 * this order: the token looked for in every other setting, when it is given; OPERATOR_CONTACT, SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX and
 * its key hash; the two keys, each checked and looked for; OPENROUTER_MODEL; ADVERT_MAX_PROCESSING_MS; PORT and HOST; and the manifest last, searched for the
 * token and the two keys. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => AgentManifest = manifestFromEnv): ServiceConfig {
  if (given(env.SERVICE_AUTH_HEADER) !== '') refuseTokenIn(env, SETTINGS, given(env.SERVICE_AUTH_HEADER));
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const supplierPkh = hexOf('SUPPLIER_PKH', requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key, published in the manifest'), 28);
  const authHeader = requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER, 'the value the template runtime sends as the authorization header of every call, which POST / requires');
  // It is compared with a header, so it is printable ASCII (a space to a tilde). Never shown in a message, only its length: it is a secret.
  assertHeaderValue('SERVICE_AUTH_HEADER', authHeader);
  // The public key of the supplier key, never the key itself: required, so that the manifest never publishes an empty one.
  const supplierPubKey = hexOf('SUPPLIER_PUB_KEY_HEX', requiredEnv('SUPPLIER_PUB_KEY_HEX', env.SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key, published in the manifest'), 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip (the env file has both lines), and this is what stops it.
  if (blake2b224Hex(supplierPubKey) !== supplierPkh) {
    throw new Error('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
  }
  const braveApiKey = apiKey(env, BRAVE_KEY);
  const openRouterApiKey = apiKey(env, OPENROUTER_KEY);
  const model = openRouterModel(env.OPENROUTER_MODEL);
  processingWindow(env.ADVERT_MAX_PROCESSING_MS);
  const port = envInt('PORT', given(env.PORT), PORT_DEFAULT);
  const host = given(env.HOST) || '0.0.0.0';
  const manifest = makeManifest({
    ...env, OPERATOR_CONTACT: given(env.OPERATOR_CONTACT), AGENT_DID: given(env.AGENT_DID), SUPPLIER_PKH: supplierPkh, SUPPLIER_PUB_KEY_HEX: supplierPubKey, OPENROUTER_MODEL: model,
  });
  const published = JSON.stringify(manifest);
  assertNoTokenIn(published, authHeader);
  assertNoKeyIn(published, braveApiKey, BRAVE_KEY);
  assertNoKeyIn(published, openRouterApiKey, OPENROUTER_KEY);
  return { manifest, authHeader, host, port, braveApiKey, openRouterApiKey, model };
}

/** The parts of the service a test replaces; the service itself uses the real ones. */
export interface StartOptions {
  fetchImpl?: typeof fetch;
  clock?: () => number;
  log?: (line: string) => void;
}
export interface RunningService {
  server: Server;
  /** The port it listens on, which is the one asked for unless that was 0. */
  port: number;
  /** Closes the server and its connections, a job's included. Safe to call twice. */
  stop: () => Promise<void>;
  /** The stop of a restart: no new job, no new connection, and up to `waitMs` (SHUTDOWN_WAIT_MS by default) for the job that is running; then stop(). */
  shutdown: (waitMs?: number) => Promise<ShutdownOutcome>;
}

/** Starts the service on its environment: loadConfig, then the server. Rejects with the reason when it cannot; nothing keeps running then. */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const slot = new JobSlot();
  const server = createServer({
    manifest: config.manifest, authHeader: config.authHeader, log, slot,
    deps: {
      fetchImpl: options.fetchImpl ?? globalThis.fetch, clock: options.clock ?? Date.now, braveApiKey: config.braveApiKey, openRouterApiKey: config.openRouterApiKey,
      model: config.model, log,
    },
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  log(`listening on ${config.host}:${port}; search ${SEARCH_NAME}; model ${modelLabel(config.model)}`);
  const { stop, shutdown } = lifecycle({ server, slot, log });
  return { server, port, stop, shutdown };
}

/**
 * Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): no new job, up to `waitMs` for the job that is running, then exit 0, or 1 when that
 * job had to be abandoned or the stop failed. The first signal takes both handlers off, so a second signal of either kind is the default action and ends the
 * process at once. The handling is packages/service-kit's, with the log of this service.
 */
export function stopOnSignals(
  service: Pick<RunningService, 'shutdown'>,
  opts: { target?: EventEmitter; exit?: (code: number) => void; log?: (line: string) => void; waitMs?: number } = {},
): void {
  stopServiceOnSignals(service, { ...opts, log: opts.log ?? defaultLog });
}
