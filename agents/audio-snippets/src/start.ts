// agents/audio-snippets/src/start.ts
// How the service starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService): the media tools
// and the speech model asked whether they are there, and the server. And how it stops: shutdown, and the signals that call it. The settings helpers, the stop
// and the signals are packages/service-kit's.
//
// Three settings are required, and the service stops at start without them, naming the variable: OPERATOR_CONTACT (published in the manifest, so with no
// default), SUPPLIER_PKH (the supplier key hash, published in the manifest; the supplier key itself is the runtime's and never reaches this service) and
// SERVICE_AUTH_HEADER (the value the template runtime sends as the authorization header of every call, which POST / requires: a service without it would
// answer anyone who can reach its port). A SUPPLIER_PUB_KEY_HEX that is not the public key of SUPPLIER_PKH stops the start too. A token put in the wrong
// line of an env file is the mistake this guards against: the token is looked for in every other setting before any check can print the line that holds it,
// no message shows a value that is hex-shaped or long, and the manifest is searched for it last. ffmpeg, ffprobe and the speech model are asked for
// before the service listens, because an image without them would answer /healthz ok and fail every job.
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertHeaderValue, assertNoTokenIn, envInt, given, hexOf, lifecycle, listen, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals } from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import { blake2b224Hex } from '@vsa/vector-read';
import { WORKER_PATH, workerAsr } from './asr.ts';
import type { Asr, AsrSettings } from './asr.ts';
import { checkTools, mediaTools } from './media.ts';
import type { MediaTools } from './media.ts';
import { modelDirOf, modelName, whisperSize } from './model.ts';
import { JobSlot, createServer, defaultLog, manifestFromEnv } from './server.ts';
import type { AgentManifest } from './server.ts';

export { SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
export type { ShutdownOutcome } from '@vsa/service-kit';

export const PORT_DEFAULT = 9093;
export const WHISPER_THREADS_DEFAULT = 4;
export const ASR_PYTHON_DEFAULT = 'python3';

/**
 * Every setting the service reads. The token belongs in SERVICE_AUTH_HEADER alone: in any other it would be printed by a check that finds fault with the line,
 * or published (OPERATOR_CONTACT, AGENT_DID, AGENT_VERSION, ADVERT_EXPLORER_URL and the rest that go into the manifest the advert hashes).
 */
export const SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL',
  'SERVICE_AUTH_HEADER', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'WHISPER_MODEL', 'WHISPER_THREADS', 'WHISPER_MODEL_DIR', 'ASR_PYTHON', 'ASR_WORKER', 'PORT', 'HOST',
] as const;

export interface ServiceConfig {
  manifest: AgentManifest;
  /** The token POST / requires as its authorization header: the value of SERVICE_AUTH_HEADER. A secret: it is in no message, no log line and no manifest. */
  authHeader: string;
  host: string;
  port: number;
  /** The worker of the speech model and how it is run. */
  asr: AsrSettings;
  /** The result's model, faster-whisper-<size>-int8. */
  model: string;
}

/**
 * The configuration of the service from its environment; throws, naming the variable, for one that is required and missing or that is given and wrong. The
 * token is looked for in every other setting first, when it is given, before any check of another line can print that line; then the three required settings,
 * in the order the operator is likely to meet them; the manifest, and the last look at it, at the end. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => AgentManifest = manifestFromEnv): ServiceConfig {
  if (given(env.SERVICE_AUTH_HEADER) !== '') refuseTokenIn(env, SETTINGS, given(env.SERVICE_AUTH_HEADER));
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const supplierPkh = hexOf('SUPPLIER_PKH', requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key, published in the manifest'), 28);
  const authHeader = requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER, 'the value the template runtime sends as the authorization header of every call, which POST / requires');
  // It is compared with a header, so it is printable ASCII (a space to a tilde). Never shown in a message, only its length: it is a secret.
  assertHeaderValue('SERVICE_AUTH_HEADER', authHeader);
  const supplierPubKey = given(env.SUPPLIER_PUB_KEY_HEX) === '' ? '' : hexOf('SUPPLIER_PUB_KEY_HEX', given(env.SUPPLIER_PUB_KEY_HEX), 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip (the env file has both lines), and this is what stops it.
  if (supplierPubKey !== '' && blake2b224Hex(supplierPubKey) !== supplierPkh) {
    throw new Error('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
  }
  const size = whisperSize(env.WHISPER_MODEL);
  const threads = envInt('WHISPER_THREADS', given(env.WHISPER_THREADS), WHISPER_THREADS_DEFAULT);
  if (threads < 1 || threads > 64) throw new Error(`environment variable WHISPER_THREADS must be a whole number from 1 to 64, got ${threads}`);
  const port = envInt('PORT', given(env.PORT), PORT_DEFAULT);
  const host = given(env.HOST) || '0.0.0.0';
  const asr: AsrSettings = {
    python: given(env.ASR_PYTHON) || ASR_PYTHON_DEFAULT, worker: given(env.ASR_WORKER) || WORKER_PATH, modelDir: given(env.WHISPER_MODEL_DIR) || modelDirOf(size), threads, computeType: 'int8',
  };
  const manifest = makeManifest({ ...env, OPERATOR_CONTACT: given(env.OPERATOR_CONTACT), AGENT_DID: given(env.AGENT_DID), SUPPLIER_PKH: supplierPkh, SUPPLIER_PUB_KEY_HEX: supplierPubKey });
  assertNoTokenIn(JSON.stringify(manifest), authHeader);
  return { manifest, authHeader, host, port, asr, model: modelName(size) };
}

/** The parts of the service a test replaces; the service itself uses the real ones. */
export interface StartOptions {
  fetchImpl?: typeof fetch;
  /** ffmpeg and ffprobe, asked for their version before the service listens. */
  tools?: MediaTools;
  /** The speech model, asked to check itself before the service listens. Default: the worker of the configuration. */
  asr?: Asr;
  clock?: () => number;
  log?: (line: string) => void;
  /** Where the private directories of the jobs are made, and how free space is read (test seams). */
  scratchRoot?: string;
  freeBytes?: (dir: string) => Promise<number>;
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

/** Starts the service on its environment: loadConfig, the tools and the model asked for, the server. Rejects with the reason when it cannot; nothing keeps running then. */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const tools = options.tools ?? mediaTools();
  await checkTools(tools);
  const asr = options.asr ?? workerAsr(config.asr, { log });
  const versions = await asr.check();
  const slot = new JobSlot();
  const server = createServer({
    manifest: config.manifest, authHeader: config.authHeader, log, slot,
    deps: {
      fetchImpl: options.fetchImpl ?? globalThis.fetch, tools, asr, model: config.model, clock: options.clock ?? Date.now,
      ...(options.scratchRoot === undefined ? {} : { scratchRoot: options.scratchRoot }), ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
    },
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  log(`listening on ${config.host}:${port}; speech model ${config.model} (faster-whisper ${versions.faster_whisper}, ctranslate2 ${versions.ctranslate2}, ${config.asr.threads} threads)`);
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
