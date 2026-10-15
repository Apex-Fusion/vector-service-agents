// agents/document-pipeline/src/start.ts
// How the service starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService): the buyer
// chain from the buyer key, the stranded store in the state directory, the janitor on it, and the server.
//
// Three settings are required, and the service stops at start without them, naming the variable: OPERATOR_CONTACT (published in the manifest, so with no
// default), PIPELINE_BUYER_PRIV_KEY_HEX (the buyer key) and SUPPLIER_PKH (the supplier key hash, published in the manifest; the supplier key itself is the
// runtime's and never reaches this service). The key hash and the mainnet address of the buyer key are derived from the key (ruling R44), so the buyer key hash
// the manifest publishes is the key that signs, and a PIPELINE_BUYER_PKH or PIPELINE_BUYER_ADDRESS the operator wrote down that is not the key's stops the
// start too. Everything is checked before anything is made: no directory is created and no chain is built for an environment that is refused. The state
// directory is proved writable before the first job could depend on it, because a job records each escrow it posts there and must not find out only then.
import { rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { buyerIdentityOf, createRealChain } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { errorText } from './format.ts';
import { StrandedStore, startJanitor } from './janitor.ts';
import { popplerRenderer } from './render.ts';
import type { Renderer } from './render.ts';
import { createServer, defaultLog, envInt, manifestFromEnv, requiredEnv } from './server.ts';
import type { AgentManifest } from './server.ts';

/** The ChandraOCR supplier the Pipeline hires for its pages: its supplier key hash. */
export const OCR_SUPPLIER_PKH_DEFAULT = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
/** The chat models the Pipeline hires for the summary or the extraction, in order of preference. */
export const LLM_MODELS_DEFAULT: readonly string[] = ['deepseek/deepseek-v4-flash', 'deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'Qwen/Qwen3.6-35B-A3B-FP8'];
export const PORT_DEFAULT = 9092;
export const STATE_DIR_DEFAULT = '/data';
/** How often the janitor looks at the escrows a run left behind. */
export const JANITOR_INTERVAL_MS = 60_000;

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

const clip = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}...` : s);
/** A setting as the operator wrote it: without the space or line break a file leaves around it; absent and empty are the same. */
const given = (value: string | undefined): string => (value ?? '').trim();

/** `value` as a lower-case hex string of `bytes` bytes, or an error that names the variable and shows what was given (it is not a secret). */
function hexOf(name: string, value: string, bytes: number): string {
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) throw new Error(`environment variable ${name} must be ${bytes * 2} hex characters, got "${clip(value)}"`);
  return value.toLowerCase();
}

/**
 * The configuration of the service from its environment; throws, naming the variable, for one that is required and missing or that is given and wrong. The
 * order of the checks is fixed: the three required settings first, in the order the operator is likely to meet them.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const privateKeyHex = requiredEnv('PIPELINE_BUYER_PRIV_KEY_HEX', env.PIPELINE_BUYER_PRIV_KEY_HEX, 'the buyer key: 64 lowercase hex characters, a raw Ed25519 key');
  // Never shown in a message: it is the one secret the service holds.
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('environment variable PIPELINE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  const supplierPkh = hexOf('SUPPLIER_PKH', requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key, published in the manifest'), 28);
  const supplierPubKey = given(env.SUPPLIER_PUB_KEY_HEX) === '' ? '' : hexOf('SUPPLIER_PUB_KEY_HEX', given(env.SUPPLIER_PUB_KEY_HEX), 32);

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
  const writtenPkh = given(env.PIPELINE_BUYER_PKH);
  if (writtenPkh !== '' && writtenPkh.toLowerCase() !== buyer.buyerPkh) {
    throw new Error(`environment variable PIPELINE_BUYER_PKH is "${clip(writtenPkh)}", but the key in PIPELINE_BUYER_PRIV_KEY_HEX has the key hash ${buyer.buyerPkh}: correct the line or remove it`);
  }
  const writtenAddress = given(env.PIPELINE_BUYER_ADDRESS);
  if (writtenAddress !== '' && writtenAddress.toLowerCase() !== buyer.address) {
    throw new Error(`environment variable PIPELINE_BUYER_ADDRESS is "${clip(writtenAddress)}", but the key in PIPELINE_BUYER_PRIV_KEY_HEX has the address ${buyer.address}: correct the line or remove it`);
  }

  const manifest = manifestFromEnv({
    ...env, OPERATOR_CONTACT: given(env.OPERATOR_CONTACT), AGENT_DID: given(env.AGENT_DID), SUPPLIER_PKH: supplierPkh, SUPPLIER_PUB_KEY_HEX: supplierPubKey,
    PIPELINE_BUYER_PKH: buyer.buyerPkh,
  });
  return { manifest, privateKeyHex, buyer, host, port, stateDir, ocrAllowlistPkh, llmAllowlist, ...(indexerUrl === undefined ? {} : { indexerUrl }) };
}

/** The parts of the service a test replaces; the service itself uses the real ones. */
export interface StartOptions {
  /** Makes the chain from the buyer key. Default createRealChain, which builds, signs and submits on Vector mainnet. */
  createChain?: (opts: { privateKeyHex: string }) => Promise<Chain>;
  fetchImpl?: typeof fetch;
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
  /** Stops the janitor and closes the server and its connections. Safe to call twice. */
  stop: () => Promise<void>;
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
 * that is proved writable, the chain, the server and the janitor. Rejects with the reason when it cannot; nothing keeps running then.
 */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const stranded = new StrandedStore(config.stateDir);
  assertWritable(config.stateDir);
  const chain = await (options.createChain ?? createRealChain)({ privateKeyHex: config.privateKeyHex });
  const clock = options.clock ?? Date.now;
  const server = createServer({
    manifest: config.manifest, log,
    deps: {
      chain, fetchImpl: options.fetchImpl ?? globalThis.fetch, renderer: options.renderer ?? popplerRenderer(), clock, sleep: options.sleep ?? defaultSleep,
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
  return { server, port, stop };
}
