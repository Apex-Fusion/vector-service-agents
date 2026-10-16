// agents/document-pipeline/src/start.ts
// How the service starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService): the buyer
// chain from the buyer key, the stranded store in the state directory, the janitor on it, and the server. And how it stops: shutdown, and the signals that call it.
//
// Three settings are required, and the service stops at start without them, naming the variable: OPERATOR_CONTACT (published in the manifest, so with no
// default), PIPELINE_BUYER_PRIV_KEY_HEX (the buyer key) and SUPPLIER_PKH (the supplier key hash, published in the manifest; the supplier key itself is the
// runtime's and never reaches this service). The key hash and the mainnet address of the buyer key are derived from the key (ruling R44), so the buyer key hash
// the manifest publishes is the key that signs, and a PIPELINE_BUYER_PKH or PIPELINE_BUYER_ADDRESS the operator wrote down that is not the key's stops the
// start too, as does a SUPPLIER_PUB_KEY_HEX that is not the public key of SUPPLIER_PKH. A secret put in the wrong line of an env file is the mistake this
// guards against: the key is looked for in every other setting before any check can print the line that holds it, no message shows a value that is hex-shaped
// or long, and the manifest is searched for the key last. Everything is checked before anything is made: no directory is created and no chain is built for an
// environment that is refused. The state directory is proved writable before the first job could depend on it, because a job records each escrow it posts there
// and must not find out only then, and the poppler tools are asked for their version for the same reason: an image without them would answer /healthz ok.
import { rmSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buyerIdentityOf, createRealChain, rawHexToBech32 } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { blake2b224Hex } from '@vsa/vector-read';
import { errorText } from './format.ts';
import { StrandedStore, startJanitor } from './janitor.ts';
import { popplerRenderer } from './render.ts';
import type { Renderer } from './render.ts';
import { JobSlot, createServer, defaultLog, envInt, manifestFromEnv, requiredEnv } from './server.ts';
import type { AgentManifest } from './server.ts';

/** The ChandraOCR supplier the Pipeline hires for its pages: its supplier key hash. */
export const OCR_SUPPLIER_PKH_DEFAULT = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
/** The chat models the Pipeline hires for the summary or the extraction, in order of preference. */
export const LLM_MODELS_DEFAULT: readonly string[] = ['deepseek/deepseek-v4-flash', 'deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'Qwen/Qwen3.6-35B-A3B-FP8'];
export const PORT_DEFAULT = 9092;
export const STATE_DIR_DEFAULT = '/data';
/** How often the janitor looks at the escrows a run left behind. */
export const JANITOR_INTERVAL_MS = 60_000;
/**
 * How long a stopping service waits for the job that is running before it closes the connection and exits (the escrows of that job are in the state directory,
 * for the janitor of the next start). The compose file's stop_grace_period must be at least this, or the container is killed before the wait is over.
 */
export const SHUTDOWN_WAIT_MS = 300_000;
/** How often a stopping service closes the connections that have become idle (a keep-alive connection is idle once its answer is sent). */
const SWEEP_MS = 100;

/**
 * Every setting the service reads but the buyer key itself. The key belongs in its own variable alone: in any of these it would be printed by a check that finds
 * fault with the line, or published (OPERATOR_CONTACT, AGENT_DID, AGENT_VERSION, ADVERT_EXPLORER_URL and the rest that go into the manifest the advert hashes).
 */
export const OTHER_SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
  'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'PIPELINE_BUYER_PKH', 'PIPELINE_BUYER_ADDRESS', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST', 'PIPELINE_STATE_DIR',
  'VECTOR_MARKETPLACE_INDEXER_URL', 'PORT', 'HOST',
] as const;
/** The settings that packages/buyer-core reads, and prints in its errors. */
export const CHAIN_SETTINGS = ['VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL'] as const;

export interface ServiceConfig {
  manifest: AgentManifest;
  /** The buyer key, 64 lowercase hex characters. It goes to the chain and nowhere else. */
  privateKeyHex: string;
  /** What the key derives to: the key hash and the mainnet enterprise address. */
  buyer: { buyerPkh: string; address: string };
  host: string;
  port: number;
  stateDir: string;
  ocrAllowlistPkh: string;
  llmAllowlist: string[];
  indexerUrl?: string;
}

/** A setting as the operator wrote it: without the space or line break a file leaves around it; absent and empty are the same. */
const given = (value: string | undefined): string => (value ?? '').trim();

/**
 * `value` as lower-case hex of `bytes` bytes. One that is not that is refused with its length and never with itself: a hex-shaped value in the wrong line may be a
 * secret, and this message would print it.
 */
function hexOf(name: string, value: string, bytes: number): string {
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    const what = /^[0-9a-fA-F]*$/.test(value) ? `it has ${value.length} characters` : `some of its ${value.length} characters are not hex`;
    throw new Error(`environment variable ${name} must be ${bytes * 2} hex characters, and ${what}`);
  }
  return value.toLowerCase();
}

/** Throws, naming the variable and not printing the key, when `key` is in any setting but its own: in either of its forms, in any case, inside a longer value too. */
function refuseKeyIn(env: NodeJS.ProcessEnv, key: string): void {
  const forms = [key, rawHexToBech32(key)];
  for (const name of [...OTHER_SETTINGS, ...CHAIN_SETTINGS]) {
    const value = (env[name] ?? '').toLowerCase();
    if (forms.some((form) => value.includes(form))) {
      throw new Error(`environment variable ${name} holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
    }
  }
}

/** Throws, without printing it, when `text` (the manifest about to be published) holds the buyer key in either of its forms, in any case. The last line of defence. */
export function assertNoKeyIn(text: string, key: string): void {
  const lower = text.toLowerCase();
  if (lower.includes(key) || lower.includes(rawHexToBech32(key))) {
    throw new Error('the manifest would publish the buyer key: a value that goes into it holds the key, and the service does not start with it');
  }
}

/**
 * The configuration of the service from its environment; throws, naming the variable, for one that is required and missing or that is given and wrong. The
 * order of the checks is fixed: the three required settings first, in the order the operator is likely to meet them, with the key looked for in every other line
 * as soon as it is known; the manifest, and the last look at it, at the end. `makeManifest` is a seam for a test of that last look; the service uses the real one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => AgentManifest = manifestFromEnv): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const privateKeyHex = requiredEnv('PIPELINE_BUYER_PRIV_KEY_HEX', env.PIPELINE_BUYER_PRIV_KEY_HEX, 'the buyer key: 64 lowercase hex characters, a raw Ed25519 key');
  // Never shown in a message: it is the one secret the service holds.
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('environment variable PIPELINE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  refuseKeyIn(env, privateKeyHex);
  const supplierPkh = hexOf('SUPPLIER_PKH', requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key, published in the manifest'), 28);
  const supplierPubKey = given(env.SUPPLIER_PUB_KEY_HEX) === '' ? '' : hexOf('SUPPLIER_PUB_KEY_HEX', given(env.SUPPLIER_PUB_KEY_HEX), 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip (the env file has both lines), and this is what stops it.
  if (supplierPubKey !== '' && blake2b224Hex(supplierPubKey) !== supplierPkh) {
    throw new Error('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
  }

  const ocrAllowlistPkh = given(env.OCR_ALLOWLIST_SUPPLIER_PKH) === '' ? OCR_SUPPLIER_PKH_DEFAULT : hexOf('OCR_ALLOWLIST_SUPPLIER_PKH', given(env.OCR_ALLOWLIST_SUPPLIER_PKH), 28);
  let llmAllowlist: string[] = [...LLM_MODELS_DEFAULT];
  if (given(env.LLM_MODEL_ALLOWLIST) !== '') {
    llmAllowlist = given(env.LLM_MODEL_ALLOWLIST).split(',').map((model) => model.trim()).filter((model) => model !== '');
    if (llmAllowlist.length === 0) throw new Error('environment variable LLM_MODEL_ALLOWLIST must name at least one model, as a comma-separated list');
  }
  const port = envInt('PORT', given(env.PORT), PORT_DEFAULT);
  const host = given(env.HOST) || '0.0.0.0';
  const stateDir = given(env.PIPELINE_STATE_DIR) || STATE_DIR_DEFAULT;
  const indexerUrl = given(env.VECTOR_MARKETPLACE_INDEXER_URL) || undefined;

  const buyer = buyerIdentityOf(privateKeyHex);
  // What was written is not shown, only how long it is: it may be a secret in the wrong line. What it is checked against is public.
  const writtenPkh = given(env.PIPELINE_BUYER_PKH);
  if (writtenPkh !== '' && writtenPkh.toLowerCase() !== buyer.buyerPkh) {
    throw new Error(`environment variable PIPELINE_BUYER_PKH (${writtenPkh.length} characters) is not the key hash of the key in PIPELINE_BUYER_PRIV_KEY_HEX (the hash of that key is ${buyer.buyerPkh}); correct the line or remove it`);
  }
  const writtenAddress = given(env.PIPELINE_BUYER_ADDRESS);
  if (writtenAddress !== '' && writtenAddress.toLowerCase() !== buyer.address) {
    throw new Error(`environment variable PIPELINE_BUYER_ADDRESS (${writtenAddress.length} characters) is not the address of the key in PIPELINE_BUYER_PRIV_KEY_HEX (the address of that key is ${buyer.address}); correct the line or remove it`);
  }

  const manifest = makeManifest({
    ...env, OPERATOR_CONTACT: given(env.OPERATOR_CONTACT), AGENT_DID: given(env.AGENT_DID), SUPPLIER_PKH: supplierPkh, SUPPLIER_PUB_KEY_HEX: supplierPubKey,
    PIPELINE_BUYER_PKH: buyer.buyerPkh,
  });
  assertNoKeyIn(JSON.stringify(manifest), privateKeyHex);
  return { manifest, privateKeyHex, buyer, host, port, stateDir, ocrAllowlistPkh, llmAllowlist, ...(indexerUrl === undefined ? {} : { indexerUrl }) };
}

/** The parts of the service a test replaces; the service itself uses the real ones. */
export interface StartOptions {
  /** Makes the chain from the buyer key. Default createRealChain, which builds, signs and submits on Vector mainnet. */
  createChain?: (opts: { privateKeyHex: string }) => Promise<Chain>;
  fetchImpl?: typeof fetch;
  /** Default popplerRenderer(); its tools are asked for their version before the service listens. */
  renderer?: Renderer;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  janitorIntervalMs?: number;
}
export interface RunningService {
  server: Server;
  /** The port it listens on, which is the one asked for unless that was 0. */
  port: number;
  /** Stops the janitor and closes the server and its connections, at once. Safe to call twice. */
  stop: () => Promise<void>;
  /**
   * The stop of a restart: takes no new job and no new connection, waits up to `waitMs` (SHUTDOWN_WAIT_MS by default) for the job that is running to be
   * answered, then stops. Past the wait the connection of that job is closed and the escrows it posted are left to the janitor of the next start. Safe to call
   * twice.
   */
  shutdown: (waitMs?: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/** The file that proves a directory can be written. */
export const WRITE_PROBE = '.write-probe';
/** Throws, naming PIPELINE_STATE_DIR, unless a file can be made in `dir` and removed again (a volume the service's user does not own fails here). */
function assertWritable(dir: string): void {
  const probe = join(dir, WRITE_PROBE);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (err) {
    throw new Error(`environment variable PIPELINE_STATE_DIR names ${dir}, which cannot be written (${errorText(err)}): a job records every escrow it posts there, so the service does not start without a place to keep them`);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

/**
 * Starts the service on its environment: loadConfig, the stranded store (a file that is not a list stops the start, and is left as it is) in a state directory
 * that is proved writable, the renderer's tools asked for, the chain, the server and the janitor. Rejects with the reason when it cannot; nothing keeps running then.
 */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const stranded = new StrandedStore(config.stateDir);
  assertWritable(config.stateDir);
  const renderer = options.renderer ?? popplerRenderer();
  await renderer.check?.();
  const chain = await (options.createChain ?? createRealChain)({ privateKeyHex: config.privateKeyHex });
  const clock = options.clock ?? Date.now;
  const slot = new JobSlot();
  const server = createServer({
    manifest: config.manifest, log, slot,
    deps: {
      chain, fetchImpl: options.fetchImpl ?? globalThis.fetch, renderer, clock, sleep: options.sleep ?? defaultSleep,
      ocrAllowlistPkh: config.ocrAllowlistPkh, llmAllowlist: config.llmAllowlist, ...(config.indexerUrl === undefined ? {} : { indexerUrl: config.indexerUrl }), stranded,
    },
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  let janitor: ReturnType<typeof startJanitor>;
  try {
    janitor = startJanitor(stranded, chain, options.janitorIntervalMs ?? JANITOR_INTERVAL_MS, { clock, log });
    log(`listening on ${config.host}:${port}; buyer address ${config.buyer.address}; state directory ${config.stateDir}`);
  } catch (err) {
    // A start that fails after the port is open must not leave the server open: it would keep the process alive with nothing behind it.
    server.close();
    server.closeAllConnections();
    throw err;
  }
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopped ??= (async () => {
    await janitor.stop();
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  })());
  let shuttingDown: Promise<void> | undefined;
  const shutdown = (waitMs: number = SHUTDOWN_WAIT_MS): Promise<void> => (shuttingDown ??= (async () => {
    slot.drain(); // no new job, not even on a connection that is still open
    // No new connection either. The connection of the job that is running is not idle, so it stays; the others are closed as they fall idle (a connection that has
    // just been answered is idle, and the server's own close() looks at the connections only once).
    const closed = new Promise<'closed'>((resolve) => { server.close(() => resolve('closed')); });
    if (slot.busy) log(`stopping: waiting up to ${waitMs} ms for the job that is running`);
    const sweep = setInterval(() => server.closeIdleConnections(), SWEEP_MS);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), waitMs); });
    try {
      if ((await Promise.race([closed, late])) === 'late') {
        log('stopping: the job that is running did not finish in time; the escrows it posted are in the state directory for the janitor');
      }
    } finally {
      clearInterval(sweep);
      clearTimeout(timer);
    }
    await stop();
  })());
  return { server, port, stop, shutdown };
}

/**
 * Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): no new job, up to `waitMs` for the job that is running, then exit 0 (1 if the stop
 * failed). The first signal takes both handlers off, so a second signal of either kind is the default action and ends the process at once.
 */
export function stopOnSignals(
  service: Pick<RunningService, 'shutdown'>,
  opts: { target?: EventEmitter; exit?: (code: number) => void; log?: (line: string) => void; waitMs?: number } = {},
): void {
  const target = opts.target ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? defaultLog;
  const waitMs = opts.waitMs ?? SHUTDOWN_WAIT_MS;
  const handlers = new Map<string, () => void>();
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = (): void => {
      for (const [name, other] of handlers) target.off(name, other);
      log(`${signal}: stopping; no new job, and up to ${waitMs / 1000} s for the one that is running`);
      service.shutdown(waitMs).then(() => exit(0), (err: unknown) => { log(`stopping failed: ${errorText(err)}`); exit(1); });
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
}
