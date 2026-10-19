// agents/advocate/src/start.ts
// How the service starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService): the chain of
// the buyer key, the stranded store in the state directory, the janitor on it, and the server. And how it stops: shutdown, and the signals that call it. The
// settings helpers, the stop and the signals are packages/service-kit's; the store, the janitor and its bounded stop are packages/hire-kit's, the Document
// Pipeline's own moved there.
//
// Seven settings are required, and the service stops at start without them, naming the variable: OPERATOR_CONTACT (published in the manifest, so with no
// default), ADVOCATE_BUYER_PRIV_KEY_HEX (the buyer key, which posts and accepts the escrow of the chat sub-job of a job; a key of its own, never the
// Pipeline's, so that two services never contend for the outputs of one wallet), SUPPLIER_PKH (the supplier key hash, published in the manifest; the supplier
// key itself is the runtime's and never reaches this service), SERVICE_AUTH_HEADER (the value the template runtime sends as the authorization header of every
// call, which POST / requires: a service without it would answer anyone who can reach its port, and a job posts escrows from the buyer wallet),
// SUPPLIER_PUB_KEY_HEX (the public key of the supplier key, published beside its key hash), and the two keys of the third parties, BRAVE_SEARCH_API_KEY and
// OPENROUTER_API_KEY. The buyer key, the token and the two API keys are the four secrets of the service. The key hash and the mainnet address of the buyer key
// are derived from the key, so the buyer key hash the manifest publishes is the key that signs, and an ADVOCATE_BUYER_PKH, ADVOCATE_BUYER_ADDRESS or
// ADVOCATE_BUYER_PUB_KEY_HEX the operator wrote down that is not the key's stops the start. A secret put in the wrong line of an env file is the mistake this
// guards against: the buyer key is looked for in every other setting, and in those the chain code reads and prints, as soon as it is known, the token right
// after it, and each API key after the checks that print no value, so before any check that could print the line that holds it; no message shows a value that
// is hex-shaped or long; and the manifest is searched for all four last. Everything is checked before anything is made: no directory is created and no chain is
// built for an environment that is refused. The state directory is proved writable before the first job could depend on it, because a job records the escrow
// it posts there and must not find out only then. The start asks no third party anything: a call to check a key would send it, and use the quota of the
// service, for nothing a job would not show.
import { rmSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buyerIdentityOf, createRealChain, rawHexToBech32 } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { StrandedStore, abandonedLine, startJanitor, stopJanitorWithin } from '@vsa/hire-kit';
import {
  assertHeaderValue, assertNoTokenIn, envInt, errorText, given, hexOf, lifecycle, listen, refuseSecretIn, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals, tokenForms,
} from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import { blake2b224Hex } from '@vsa/vector-read';
import { openRouterModel } from './model.ts';
import { SEARCH_NAME } from './result.ts';
import { JobSlot, createServer, defaultLog, manifestFromEnv, modelAllowlist, processingWindow } from './server.ts';
import type { AgentManifest } from './server.ts';

export { SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
export type { ShutdownOutcome } from '@vsa/service-kit';

export const PORT_DEFAULT = 9094;
/** Where the stranded store is kept unless ADVOCATE_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
/** How often the janitor looks at the escrows a job left behind: the Document Pipeline's interval. */
export const JANITOR_INTERVAL_MS = 60_000;
/** How long a stop waits for a pass of the janitor that is in flight (the Pipeline's ruling R61); a pass that hangs on a node call is abandoned then. */
export const JANITOR_STOP_WAIT_MS = 30_000;
/** The most the chat job may be priced at unless LLM_MAX_PRICE_LOVELACE says otherwise: an advert above it is not hired. */
export const PRICE_CEILING_DEFAULT_LOVELACE = 1_000_000n;

/**
 * Every setting the service reads. Each secret belongs in its own line alone: in any other it would be printed by a check that finds fault with the line, or
 * published (OPERATOR_CONTACT, AGENT_DID, AGENT_VERSION, ADVERT_EXPLORER_URL and the rest that go into the manifest the advert hashes), or handed to the
 * runtime to send in a header with every call (SERVICE_AUTH_HEADER).
 */
export const SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
  'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL',
  'ADVOCATE_BUYER_PRIV_KEY_HEX', 'ADVOCATE_BUYER_PUB_KEY_HEX', 'ADVOCATE_BUYER_PKH', 'ADVOCATE_BUYER_ADDRESS', 'ADVOCATE_STATE_DIR', 'LLM_MODEL_ALLOWLIST',
  'LLM_MAX_PRICE_LOVELACE', 'VECTOR_MARKETPLACE_INDEXER_URL', 'PORT', 'HOST',
] as const;
/** The settings that packages/buyer-core reads, and prints in its errors. */
export const CHAIN_SETTINGS = ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL'] as const;
/** The settings the secrets are looked for in: every one the service reads and every one the chain code reads, but the secret's own line. */
const SEARCHED: readonly string[] = [...SETTINGS, ...CHAIN_SETTINGS];

/** The two keys of the third parties: the setting of each, what it is in words, and what it is for. */
const BRAVE_KEY = { name: 'BRAVE_SEARCH_API_KEY', what: 'the Brave Search API key', why: 'the key of the Brave Search API, which the two search queries of a job send' };
const OPENROUTER_KEY = { name: 'OPENROUTER_API_KEY', what: 'the OpenRouter API key', why: 'the key of OpenRouter, which the model call of a job sends when it is made through OpenRouter' };
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
  /** The model of OpenRouter the fallback calls: OPENROUTER_MODEL, DEFAULT_MODEL when it is not set. */
  model: string;
  /** The buyer key, 64 lowercase hex characters, which goes to the chain and nowhere else, and what it derives to: the key hash and the mainnet enterprise address. */
  buyer: { privateKeyHex: string; pkh: string; address: string };
  /** Where the stranded store is kept: ADVOCATE_STATE_DIR, STATE_DIR_DEFAULT when it is not set. */
  stateDir: string;
  /**
   * The chat models the service hires, in order of preference (LLM_MODEL_ALLOWLIST): the model of OPENROUTER_MODEL unless set, so that both paths ask the same
   * model. The first is the market model the manifest and the listening line name (ruling R-F19).
   */
  allowlist: readonly string[];
  /** The most the chat job may be priced at, in lovelace (LLM_MAX_PRICE_LOVELACE). */
  maxPriceLovelace: bigint;
  /** The marketplace indexer (VECTOR_MARKETPLACE_INDEXER_URL); the configured one when absent. */
  indexerUrl?: string;
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
  refuseSecretIn(env, SEARCHED, tokenForms(value), key.name, (name) =>
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

/** Throws, naming the variable and not printing the key, when the buyer key is in any setting but its own: in either of its forms, in any case, inside a longer value too. */
function refuseBuyerKeyIn(env: NodeJS.ProcessEnv, key: string): void {
  refuseSecretIn(env, SEARCHED, [key, rawHexToBech32(key)], 'ADVOCATE_BUYER_PRIV_KEY_HEX', (name) =>
    `environment variable ${name} holds the buyer key, which belongs in ADVOCATE_BUYER_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
}

/** Throws, without printing it, when `published` (the manifest about to be published) holds the buyer key in either of its forms, in any case. */
function assertNoBuyerKeyIn(published: string, key: string): void {
  const lower = published.toLowerCase();
  if (lower.includes(key) || lower.includes(rawHexToBech32(key))) {
    throw new Error('the manifest would publish the buyer key: a value that goes into it holds the key, and the service does not start with it');
  }
}

/**
 * A price in lovelace: a whole number of at least 0, or `fallback` when the setting is absent or empty. Anything else is refused with the variable named and
 * the length of what was written, never with the value: a value that is no number may be a secret in the wrong line.
 */
function lovelaceOf(name: string, value: string, fallback: bigint): bigint {
  if (value === '') return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`environment variable ${name} must be a whole number of lovelace of at least 0, and it has ${value.length} characters`);
  return BigInt(value);
}

/**
 * The configuration of the service from its environment; throws, naming the variable, for one that is required and missing or that is given and wrong. In
 * this order: OPERATOR_CONTACT; the buyer key of ADVOCATE_BUYER_PRIV_KEY_HEX (its form, and the key looked for in every other setting); the token looked
 * for in every other setting, when it is given; SUPPLIER_PKH, SERVICE_AUTH_HEADER, SUPPLIER_PUB_KEY_HEX and its key hash; the two API keys, each checked and
 * looked for; OPENROUTER_MODEL; ADVERT_MAX_PROCESSING_MS; LLM_MODEL_ALLOWLIST and LLM_MAX_PRICE_LOVELACE; PORT, HOST, ADVOCATE_STATE_DIR and
 * VECTOR_MARKETPLACE_INDEXER_URL; the buyer key hash, address and public key the operator wrote down, each against the key; and the manifest last, searched
 * for the four secrets. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => AgentManifest = manifestFromEnv): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const privateKeyHex = requiredEnv('ADVOCATE_BUYER_PRIV_KEY_HEX', env.ADVOCATE_BUYER_PRIV_KEY_HEX, 'the buyer key: 64 lowercase hex characters, a raw Ed25519 key, which posts the escrow of the chat sub-job of a job');
  // Never shown in a message: it is a secret.
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('environment variable ADVOCATE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  refuseBuyerKeyIn(env, privateKeyHex);
  // The token is required after SUPPLIER_PKH, but looked for now, when it is given: the check of SUPPLIER_PKH, and every one after it, could print a line.
  if (given(env.SERVICE_AUTH_HEADER) !== '') refuseTokenIn(env, SEARCHED, given(env.SERVICE_AUTH_HEADER));
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
  // The chat models, in order of preference: the model of OPENROUTER_MODEL unless the operator names others, so that both paths ask the same model.
  const allowlist = modelAllowlist(env.LLM_MODEL_ALLOWLIST, model);
  const maxPriceLovelace = lovelaceOf('LLM_MAX_PRICE_LOVELACE', given(env.LLM_MAX_PRICE_LOVELACE), PRICE_CEILING_DEFAULT_LOVELACE);
  const port = envInt('PORT', given(env.PORT), PORT_DEFAULT);
  const host = given(env.HOST) || '0.0.0.0';
  const stateDir = given(env.ADVOCATE_STATE_DIR) || STATE_DIR_DEFAULT;
  const indexerUrl = given(env.VECTOR_MARKETPLACE_INDEXER_URL) || undefined;

  const buyer = buyerIdentityOf(privateKeyHex);
  // What was written is not shown, only how long it is: it may be a secret in the wrong line. What it is checked against is public.
  const writtenPkh = given(env.ADVOCATE_BUYER_PKH);
  if (writtenPkh !== '' && writtenPkh.toLowerCase() !== buyer.buyerPkh) {
    throw new Error(`environment variable ADVOCATE_BUYER_PKH (${writtenPkh.length} characters) is not the key hash of the key in ADVOCATE_BUYER_PRIV_KEY_HEX (the hash of that key is ${buyer.buyerPkh}); correct the line or remove it`);
  }
  const writtenAddress = given(env.ADVOCATE_BUYER_ADDRESS);
  if (writtenAddress !== '' && writtenAddress.toLowerCase() !== buyer.address) {
    throw new Error(`environment variable ADVOCATE_BUYER_ADDRESS (${writtenAddress.length} characters) is not the address of the key in ADVOCATE_BUYER_PRIV_KEY_HEX (the address of that key is ${buyer.address}); correct the line or remove it`);
  }
  const writtenPubKey = given(env.ADVOCATE_BUYER_PUB_KEY_HEX);
  if (writtenPubKey !== '' && blake2b224Hex(hexOf('ADVOCATE_BUYER_PUB_KEY_HEX', writtenPubKey, 32)) !== buyer.buyerPkh) {
    throw new Error(`environment variable ADVOCATE_BUYER_PUB_KEY_HEX is not the public key of the key in ADVOCATE_BUYER_PRIV_KEY_HEX (the key hash of that key is ${buyer.buyerPkh}); correct the line or remove it`);
  }

  const manifest = makeManifest({
    ...env, OPERATOR_CONTACT: given(env.OPERATOR_CONTACT), AGENT_DID: given(env.AGENT_DID), SUPPLIER_PKH: supplierPkh, SUPPLIER_PUB_KEY_HEX: supplierPubKey, OPENROUTER_MODEL: model,
    ADVOCATE_BUYER_PKH: buyer.buyerPkh,
  });
  const published = JSON.stringify(manifest);
  assertNoBuyerKeyIn(published, privateKeyHex);
  assertNoTokenIn(published, authHeader);
  assertNoKeyIn(published, braveApiKey, BRAVE_KEY);
  assertNoKeyIn(published, openRouterApiKey, OPENROUTER_KEY);
  return {
    manifest, authHeader, host, port, braveApiKey, openRouterApiKey, model, buyer: { privateKeyHex, pkh: buyer.buyerPkh, address: buyer.address }, stateDir, allowlist,
    maxPriceLovelace, ...(indexerUrl === undefined ? {} : { indexerUrl }),
  };
}

/** The parts of the service a test replaces; the service itself uses the real ones. */
export interface StartOptions {
  /** Makes the chain from the buyer key. Default createRealChain, which builds, signs and submits on Vector mainnet. */
  createChain?: (opts: { privateKeyHex: string }) => Promise<Chain>;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  janitorIntervalMs?: number;
  /** How long a stop waits for the janitor's pass in flight: JANITOR_STOP_WAIT_MS by default. */
  janitorStopWaitMs?: number;
}
export interface RunningService {
  server: Server;
  /** The port it listens on, which is the one asked for unless that was 0. */
  port: number;
  /** Stops the janitor (a pass in flight has up to JANITOR_STOP_WAIT_MS) and closes the server and its connections, a job's included. Safe to call twice. */
  stop: () => Promise<void>;
  /**
   * The stop of a restart: no new job, no new connection, the janitor stopped at once (a pass in flight has up to JANITOR_STOP_WAIT_MS), and up to `waitMs`
   * (SHUTDOWN_WAIT_MS by default) for the job that is running, its hire included; then stop(). Past the wait the job is abandoned, and the log names the
   * escrows the state directory holds for the janitor of the next start.
   */
  shutdown: (waitMs?: number) => Promise<ShutdownOutcome>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The file that proves a directory can be written. */
export const WRITE_PROBE = '.write-probe';
/** Throws, naming ADVOCATE_STATE_DIR, unless a file can be made in `dir` and removed again (a volume the service's user does not own fails here). */
function assertWritable(dir: string): void {
  const probe = join(dir, WRITE_PROBE);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (err) {
    throw new Error(`environment variable ADVOCATE_STATE_DIR names ${dir}, which cannot be written (${errorText(err)}): a job records the escrow it posts there, so the service does not start without a place to keep it`);
  }
}

/**
 * Starts the service on its environment: loadConfig, the stranded store (a file that is not a list stops the start, and is left as it is) in a state directory
 * that is proved writable, the chain, the server and the janitor, which makes no transaction while a job holds the slot. Rejects with the reason when it
 * cannot; nothing keeps running then.
 */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const stranded = new StrandedStore(config.stateDir);
  assertWritable(config.stateDir);
  const chain = await (options.createChain ?? createRealChain)({ privateKeyHex: config.buyer.privateKeyHex });
  const clock = options.clock ?? Date.now;
  const slot = new JobSlot();
  const server = createServer({
    manifest: config.manifest, authHeader: config.authHeader, log, slot,
    deps: {
      fetchImpl: options.fetchImpl ?? globalThis.fetch, clock, braveApiKey: config.braveApiKey, openRouterApiKey: config.openRouterApiKey, model: config.model, log,
      chain, stranded, sleep: options.sleep ?? defaultSleep, allowlist: config.allowlist, maxPriceLovelace: config.maxPriceLovelace,
      ...(config.indexerUrl === undefined ? {} : { indexerUrl: config.indexerUrl }), buyerPkh: config.buyer.pkh, marketplace: { on: true },
    },
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  let janitor: ReturnType<typeof startJanitor>;
  try {
    // The janitor makes no transaction while a job holds the slot: its Reclaim would hold the chain's queue in front of the job's Post or Accept.
    janitor = startJanitor(stranded, chain, options.janitorIntervalMs ?? JANITOR_INTERVAL_MS, { clock, log, busy: () => slot.busy });
    // The model of each path, as the gap of the model names them: the market model, and the model of OPENROUTER_MODEL only when it is another (ruling R-F19).
    const market = config.allowlist[0];
    const models = market === config.model
      ? `model ${market} from the Vector marketplace, OpenRouter as the fallback`
      : `model ${market} from the Vector marketplace, OpenRouter ${config.model} as the fallback`;
    log(`listening on ${config.host}:${port}; search ${SEARCH_NAME}; ${models}; buyer address ${config.buyer.address}; state directory ${config.stateDir}`);
  } catch (err) {
    // A start that fails after the port is open must not leave the server open: it would keep the process alive with nothing behind it.
    server.close();
    server.closeAllConnections();
    throw err;
  }
  const janitorStopWaitMs = options.janitorStopWaitMs ?? JANITOR_STOP_WAIT_MS;
  // The stop of a restart, from packages/service-kit: no new job and no new connection, the janitor stopped with a bound, and up to the wait for the job that
  // is running, its hire included. An abandoned job leaves its escrow in the state directory, and the line names it for the janitor of the next start.
  const { stop, shutdown } = lifecycle({
    server, slot, log, stopWork: () => stopJanitorWithin(janitor, janitorStopWaitMs, log), abandonedLine: (waitMs) => abandonedLine(stranded, waitMs),
  });
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
