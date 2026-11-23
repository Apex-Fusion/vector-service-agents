// agents/order-desk/src/serve/start.ts
// How the Order Desk starts and stops: the environment read into a configuration (loadConfig), and the real parts put together and started (startService): the state directory proved writable, the chain of the
// service key, the hook and the job, the server, and the janitor of the paying key. This is the one file of the service that names the key variable, and it reads that variable one time. The service key is the
// key of the service: it pays for the model hire of the decision, signs the transactions of the claims and the challenges of the dispute code, and signs the request for the X.509-SVID. The three supplier keys
// are the keys of the three runtimes, and they never reach this service: it holds their key hashes and public keys, which its manifest publishes.
//
// Two settings hold a secret. The service key is looked for in every other setting, in its hex form and its bech32 form, in any case, inside a longer value too, as soon as it is known, so before any check
// that could print the line that holds it. The token (SERVICE_AUTH_HEADER) is looked for in the same way right after it. No message shows a value that is hex-shaped or long. The manifest is searched for both
// last. Everything is checked before anything is made: no directory is created and no chain is built for an environment that is refused. The state directory is proved writable before the first job could depend
// on it, because the order book, the journal of the dispute code and the record of the model hires are in it.
//
// The identity names of the deployment come from VAULT_PAYER_IDENTITY_SETTINGS of buyer-core, so that no source of the service writes them. FAULT_MODE is read one time, and a value that the Order Desk does not
// list stops the start. The start makes the one fetch of the Module-1 manifest, from its pinned https address: the dispute code needs the parameters of the deployment. Apart from that, the start asks a third
// party only what the janitor reads of the chain, in a pass of its own, for the escrows that a run left behind. The dispute code reads the chain when it files a challenge.
import { rmSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { VAULT_PAYER_IDENTITY_SETTINGS, buyerVaultDeployment, rawHexToBech32 } from '@vsa/buyer-core';
import type { IdentityDeployment } from '@vsa/buyer-core';
import { abandonedLine, stopJanitorWithin } from '@vsa/hire-kit';
import {
  JobSlot, assertHeaderValue, assertNoTokenIn, errorText, given, lifecycle, listen, refuseSecretIn, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals,
} from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import type { MockBases } from '@vsa/usecase-kit/access';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import type { DisputeSettings } from '@vsa/usecase-kit/dispute';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import type { Did } from '@vsa/usecase-kit/protocol';
import { loadLots } from '../checks/index.ts';
import type { LoadedLots } from '../checks/index.ts';
import { keyClashOf, serviceKeyOf } from './keys.ts';
import { manifestFromEnv } from './manifest.ts';
import { createServer, defaultLog } from './server.ts';
import {
  LOTS_FILE, SUPPLIER_PKH_VARIABLES, agentDidOf, checksBudgetOf, disputeOf, endpointsFromEnv, faultOf, hostOf, limitsOf, lotsOriginOf, mockBasesOf, module1SourceOf, portOf, processingWindowOf,
  stateDirOf, supplierKeysOf,
} from './settings.ts';
import type { Endpoints, SupplierKey } from './settings.ts';
import { wireService } from './wiring.ts';
import type { WireOptions } from './wiring.ts';

export { SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
export type { ShutdownOutcome } from '@vsa/service-kit';

/** How often the janitor of the paying key looks at the escrows that a run left behind: a minute. */
export const JANITOR_INTERVAL_MS = 60_000;
/** How long a stop waits for a pass of the janitor that is in flight; a pass that hangs on a node call is abandoned then. */
export const JANITOR_STOP_WAIT_MS = 30_000;

/**
 * Every setting the service reads. Each secret belongs in its own line alone: in any other it would be printed, or published (the manifest, which the three adverts hash), or handed to the runtimes to send in a
 * header with every call (SERVICE_AUTH_HEADER). The four identity names stand in VAULT_PAYER_IDENTITY_SETTINGS of buyer-core.
 */
export const SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'ADVERT_MAX_PROCESSING_MS',
  'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'PORT', 'HOST', 'ORDER_DESK_STATE_DIR',
  'LOTS_PUBLIC_ORIGIN', 'SMALL_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX', 'MEDIUM_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PUB_KEY_HEX', 'LARGE_SUPPLIER_PKH', 'LARGE_SUPPLIER_PUB_KEY_HEX',
  'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'ORDER_DESK_SERVICE_PKH',
  'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', ...VAULT_PAYER_IDENTITY_SETTINGS, 'VECTOR_MODULE1_MANIFEST',
  'IDENTITY_GATEWAY_URL', 'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE', 'CHECKS_READ_BUDGET_MS',
  'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE',
  'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
] as const;

/** The two settings that hold a secret. The manifest is made from an environment that has neither. */
const SECRET_SETTINGS: readonly string[] = ['ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'SERVICE_AUTH_HEADER'];

/** What the service runs on: every setting, read and checked. */
export interface ServiceConfig {
  /** The bytes that `GET /agent.json` serves, and their SHA-256: the hash of the three adverts. */
  readonly manifest: { readonly text: string; readonly sha256: string };
  /** The token that POST / and POST /precheck require as their authorization header. A secret: it is in no message, no log line and no manifest. */
  readonly authHeader: string;
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  /** The fault switch, made one time. */
  readonly fault: FaultSwitch<'order-desk'>;
  /** The DID of the Order Desk: the supplier that a purchase order names. */
  readonly agentDid: Did;
  /** The service key, 64 lower-case hex characters, which goes to the chain and the signer and nowhere else, and what it derives to: the key hash and the mainnet enterprise address. */
  readonly service: { readonly privateKeyHex: string; readonly pkh: string; readonly address: string };
  /** The public part of the key of each runtime. */
  readonly suppliers: Readonly<Record<LotName, SupplierKey>>;
  readonly limits: ModelLimits;
  readonly dispute: DisputeSettings;
  /** The https address of the Module-1 deployment manifest, pinned to a commit. The wiring fetches it one time at the start. */
  readonly module1Manifest: string;
  /** The budget of one timed read of the hook, in milliseconds. */
  readonly checksBudgetMs: number;
  readonly endpoints: Endpoints;
  readonly mock: MockBases;
  /** The identity registry deployment, with the reference scripts of the escrow and of the vault. */
  readonly identityDeployment: IdentityDeployment;
  /** The lots file as it was read: the service serves its text, and the manifest holds its hash. */
  readonly lots: LoadedLots;
}

/** Throws, without printing it, when `published` (the manifest about to be served) holds the service key in either of its forms, in any case. */
function assertNoKeyIn(published: string, key: string): void {
  const lower = published.toLowerCase();
  if (lower.includes(key) || lower.includes(rawHexToBech32(key))) {
    throw new Error('the manifest would publish the service key: a value that goes into it holds the key, and the service does not start with it');
  }
}

/**
 * The configuration of the service from its environment. It throws, naming the variable, for a setting that is required and missing or that is given and wrong. In this order: OPERATOR_CONTACT; the service key
 * (its form, and the key looked for in every other setting); the token (its form, and the token looked for in every other setting); the DID, FAULT_MODE, the listener and the state directory; the endpoints and the
 * two origins of the mock service; the origin of the first runtime and the hosts that it gives; the window of the adverts and the budget of the hook; the keys of the three runtimes, the key hash that the operator
 * wrote down against the service key, and the clash of two keys; the limits of the model hire, the settings of the dispute code and the Module-1 manifest; the identity deployment; and the manifest last, searched
 * for both secrets. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv, lots: LoadedLots) => unknown = manifestFromEnv): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  const privateKeyHex = requiredEnv('ORDER_DESK_SERVICE_PRIV_KEY_HEX', env.ORDER_DESK_SERVICE_PRIV_KEY_HEX, 'the service key: 64 lowercase hex characters, a raw Ed25519 key, which pays for the model hire and signs the claims, the challenges and the request for the X.509-SVID');
  // Never shown in a message: it is a secret.
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX must be 64 lowercase hex characters (a raw Ed25519 key)');
  refuseSecretIn(env, SETTINGS, [privateKeyHex, rawHexToBech32(privateKeyHex)], 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', (name) =>
    `environment variable ${name} holds the service key, which belongs in ORDER_DESK_SERVICE_PRIV_KEY_HEX alone: it would be printed or published. Take it out of ${name}`);
  const authHeader = requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER, 'the value the runtimes send as the authorization header of every call, which POST / and POST /precheck require');
  // It is compared with a header, so it is printable ASCII. Never shown in a message, only its length: it is a secret.
  assertHeaderValue('SERVICE_AUTH_HEADER', authHeader);
  refuseTokenIn(env, SETTINGS, authHeader);

  const agentDid = agentDidOf(env);
  const fault = faultOf(env);
  const port = portOf(env);
  const host = hostOf(env);
  const stateDir = stateDirOf(env);
  const endpoints = endpointsFromEnv(env);
  const mock = mockBasesOf(env);
  const lotsOrigin = lotsOriginOf(env);
  processingWindowOf(env);
  const checksBudgetMs = checksBudgetOf(env);

  const suppliers = supplierKeysOf(env);
  const service = serviceKeyOf(privateKeyHex);
  // What was written is not shown, only how long it is: it may be a secret in the wrong line. What it is checked against is public.
  const written = given(env.ORDER_DESK_SERVICE_PKH);
  if (written !== '' && written.toLowerCase() !== service.pkh) {
    throw new Error(`environment variable ORDER_DESK_SERVICE_PKH (${written.length} characters) is not the key hash of the key in ORDER_DESK_SERVICE_PRIV_KEY_HEX (the hash of that key is ${service.pkh}); correct the line or remove it`);
  }
  const clash = keyClashOf(service, suppliers);
  if (clash?.kind === 'service') {
    throw new Error(`environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX holds the key of ${SUPPLIER_PKH_VARIABLES[clash.lot]}: the supplier keys are the runtimes', and the service key must be a key of its own`);
  }
  if (clash?.kind === 'runtimes') {
    throw new Error(`environment variable ${SUPPLIER_PKH_VARIABLES[clash.second]} names the key of ${SUPPLIER_PKH_VARIABLES[clash.first]}: each runtime has a key of its own`);
  }

  const limits = limitsOf(env);
  const dispute = disputeOf(env);
  const module1Manifest = module1SourceOf(env);
  const identityDeployment = buyerVaultDeployment(env);

  // The manifest comes last, from an environment with no secret in it and with the values as the checks above normalised them. The kit renders it for each setting of the fault switch, and refuses a manifest
  // whose bytes change. So the builder gets the setting that the kit is trying in the member FAULT_MODE, and never the live value: a builder that read the live value would give one text for every setting.
  const lots = loadLots(LOTS_FILE);
  const published: NodeJS.ProcessEnv = {
    ...Object.fromEntries(SETTINGS.filter((name) => !SECRET_SETTINGS.includes(name)).map((name) => [name, env[name]])),
    AGENT_DID: agentDid,
    SMALL_SUPPLIER_PKH: suppliers['lot-small'].pkh,
    SMALL_SUPPLIER_PUB_KEY_HEX: suppliers['lot-small'].pubKeyHex,
    MEDIUM_SUPPLIER_PKH: suppliers['lot-medium'].pkh,
    MEDIUM_SUPPLIER_PUB_KEY_HEX: suppliers['lot-medium'].pubKeyHex,
    LARGE_SUPPLIER_PKH: suppliers['lot-large'].pkh,
    LARGE_SUPPLIER_PUB_KEY_HEX: suppliers['lot-large'].pubKeyHex,
    ORDER_DESK_SERVICE_PKH: service.pkh,
    LOTS_PUBLIC_ORIGIN: lotsOrigin,
  };
  const rendered = renderManifest('order-desk', (setting) => makeManifest({ ...published, FAULT_MODE: setting }, lots));
  if (!rendered.ok) throw new Error(`the manifest is refused (${rendered.code}): ${rendered.detail}`);
  assertNoKeyIn(rendered.value.text, privateKeyHex);
  assertNoTokenIn(rendered.value.text, authHeader);
  return {
    manifest: rendered.value, authHeader, host, port, stateDir, fault, agentDid, service: { privateKeyHex, pkh: service.pkh, address: service.address }, suppliers, limits, dispute, module1Manifest,
    checksBudgetMs, endpoints, mock, identityDeployment, lots,
  };
}

/** The parts of the service that a test replaces, and the interval of the janitor. The service itself uses the real ones. */
export interface StartOptions extends WireOptions {
  readonly janitorIntervalMs?: number;
  /** How long a stop waits for the pass of the janitor that is in flight: JANITOR_STOP_WAIT_MS by default. */
  readonly janitorStopWaitMs?: number;
}

export interface RunningService {
  readonly server: Server;
  /** The port it listens on, which is the one asked for unless that was 0. */
  readonly port: number;
  /** Stops the janitor (a pass in flight has up to JANITOR_STOP_WAIT_MS) and closes the server and its connections, a job's included. Safe to call twice. */
  readonly stop: () => Promise<void>;
  /**
   * The stop of a restart: no new job, no new connection, the janitor stopped at once, and up to `waitMs` (SHUTDOWN_WAIT_MS by default) for the job that is running; then stop(). Past the wait the job is
   * abandoned, and the log names the escrows that the state directory holds for the janitor of the next start.
   */
  readonly shutdown: (waitMs?: number) => Promise<ShutdownOutcome>;
}

/** The file that proves a directory can be written. */
export const WRITE_PROBE = '.write-probe';

/** Throws, naming ORDER_DESK_STATE_DIR, unless a file can be made in `dir` and removed again (a volume that the user of the service does not own fails here). */
function assertWritable(dir: string): void {
  const probe = join(dir, WRITE_PROBE);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (error) {
    throw new Error(`environment variable ORDER_DESK_STATE_DIR names ${dir}, which cannot be written (${errorText(error)}): the order book, the journal of the dispute code and the record of the model hires are kept there, so the service does not start without a place to keep them`);
  }
}

/**
 * Starts the service on its environment: loadConfig, the state directory proved writable, the real parts joined (wireService), the server and the janitor of the paying key, which makes no transaction while a hire
 * or a challenge holds the queue. It rejects with the reason when it cannot, and nothing keeps running then.
 */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const clock = options.clock ?? Date.now;
  assertWritable(config.stateDir);
  const wired = await wireService(config, { ...options, log });
  const slot = new JobSlot();
  const server = createServer({
    manifestText: config.manifest.text, authHeader: config.authHeader, fault: config.fault, precheck: wired.precheck, jobDeps: wired.jobDeps, lotsText: config.lots.text, clock, log, slot,
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  let janitor: { stop: () => Promise<void> };
  try {
    janitor = wired.key.startJanitor(options.janitorIntervalMs ?? JANITOR_INTERVAL_MS, { clock, log });
    log(`listening on ${config.host}:${port}; service address ${config.service.address}; state directory ${config.stateDir}`);
  } catch (error) {
    // A start that fails after the port is open must not leave the server open: it would keep the process alive with nothing behind it.
    server.close();
    server.closeAllConnections();
    throw error;
  }
  const janitorStopWaitMs = options.janitorStopWaitMs ?? JANITOR_STOP_WAIT_MS;
  // The stop of the service kit: no new job and no new connection, the janitor stopped with a bound, and up to the wait for the job that is running. An abandoned job leaves its escrows in the state directory,
  // and the line names them for the janitor of the next start.
  const { stop, shutdown } = lifecycle({
    server, slot, log, stopWork: () => stopJanitorWithin(janitor, janitorStopWaitMs, log), abandonedLine: (waitMs) => abandonedLine(wired.key.stranded, waitMs),
  });
  return { server, port, stop, shutdown };
}

/**
 * Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): no new job, up to `waitMs` for the job that is running, then exit 0, or 1 when that job had to be abandoned or the stop failed. The first
 * signal takes both handlers off, so a second signal of either kind is the default action and ends the process at once. The handling is the service kit's, with the log of this service.
 */
export function stopOnSignals(
  service: Pick<RunningService, 'shutdown'>,
  options: { target?: EventEmitter; exit?: (code: number) => void; log?: (line: string) => void; waitMs?: number } = {},
): void {
  stopServiceOnSignals(service, { ...options, log: options.log ?? defaultLog });
}
