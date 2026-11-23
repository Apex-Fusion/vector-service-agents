// agents/reorder-agent/src/serve/start.ts
// How the Reorder Agent starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService). It is the one file of the service that names a key variable. It
// reads each of the five key variables one time, in the call that takes it, and hands the values to src/serve/keys.ts, which makes the signers. The identity names of the deployment come from
// VAULT_PAYER_IDENTITY_SETTINGS of buyer-core, so that no source of the service writes them.
//
// The five keys. `REORDER_SERVICE_PRIV_KEY_HEX` is the service key: it pays the model hires, signs the claims and the challenges, and signs the subject token of the agent. `REORDER_DELEGATION_1_PRIV_KEY_HEX` and
// `REORDER_DELEGATION_2_PRIV_KEY_HEX` are the delegation keys: a delegation of a hirer names one of them, and it signs the vault Pay, the Accept and the sub-delegation. `STOCK_READER_AUTH_PRIV_KEY_HEX` and
// `STOCK_READER_DELEGATION_PRIV_KEY_HEX` are the two keys of the subagent stock-reader. The supplier key is the runtime's and never reaches this service: the service holds its key hash and its public key, which the
// manifest publishes. Each key has a public cross-check variable, the key hash, and the service stops at the start when it is set and is not the hash of the key.
//
// Two kinds of setting hold a secret: the five keys and the token (SERVICE_AUTH_HEADER). Each key is looked for in every other setting, in its hex form and its bech32 form, in any case, inside a longer value too, as
// soon as its form is known, so before any check that could print the line that holds it. The token is looked for the same way. No message shows a value that is hex-shaped or long. The manifest is searched for all of
// them last. Everything is checked before anything is made: no directory is created and no chain is built for an environment that is refused. The state directory is proved writable before the first job could depend
// on it. FAULT_MODE is read one time, and the Reorder Agent has no fault value: any value stops the start.
import { rmSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { VAULT_PAYER_IDENTITY_SETTINGS, buyerVaultDeployment, rawHexToBech32 } from '@vsa/buyer-core';
import {
  JobSlot, assertHeaderValue, assertNoTokenIn, errorText, given, lifecycle, listen, refuseSecretIn, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals,
} from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import type { CosignSettings } from '@vsa/usecase-kit/cosign';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import type { RenderedManifest } from '@vsa/usecase-kit/manifest';
import { keyClashOf, keyOf } from './keys.ts';
import type { KeyMaterial, KeyRole } from './keys.ts';
import { manifestFromEnv } from './manifest.ts';
import { createServer, defaultLog } from './server.ts';
import {
  agentDidOf, cosignSettingsOf, disputeOf, endpointsFromEnv, faultOf, handoffLimitsOf, hostOf, limitsOf, mockBasesOf, module1SourceOf, portOf, priceOf, processingWindowOf, stateDirOf,
  stockReaderDidOf, supplierKeyOf,
} from './settings.ts';
import { wire } from './wiring.ts';
import type { WiringOptions, WiringSettings } from './wiring.ts';

export { SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
export type { ShutdownOutcome } from '@vsa/service-kit';

/** How often the janitors look at what the jobs left behind: the interval of the other services of this repository. */
export const JANITOR_INTERVAL_MS = 60_000;
/** How long a stop waits for a pass of a janitor that is in flight; a pass that hangs on a node call is abandoned then. */
export const JANITOR_STOP_WAIT_MS = 30_000;

/**
 * Every setting the service reads. Each secret belongs in its own line alone: in any other it would be printed by a check that finds fault with the line, or published (the manifest, which the advert hashes), or
 * handed to the runtime to send in a header with every call (SERVICE_AUTH_HEADER). The four identity names stand in VAULT_PAYER_IDENTITY_SETTINGS of buyer-core.
 */
export const SETTINGS = [
  'OPERATOR_CONTACT', 'AGENT_DID', 'IDENTITY_POLICY_ID', 'IDENTITY_ADDRESS', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE', 'ADVERT_EXPLORER_URL', 'SERVICE_AUTH_HEADER', 'FAULT_MODE', 'PORT', 'HOST',
  'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'VECTOR_MARKETPLACE_INDEXER_URL', ...VAULT_PAYER_IDENTITY_SETTINGS, 'VECTOR_MODULE1_MANIFEST', 'IDENTITY_GATEWAY_URL',
  'MOCK_PUBLIC_BASE', 'MOCK_MTLS_BASE',
  'LLM_MODEL_ALLOWLIST', 'LLM_MAX_PRICE_LOVELACE', 'LLM_MAX_SUPPLIER_BOND_LOVELACE', 'LLM_MAX_BUYER_BOND_LOVELACE',
  'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
  'REORDER_STATE_DIR', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'STOCK_READER_DID',
  'HANDOFF_MAX_PRICE_LOVELACE', 'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', 'HANDOFF_MAX_BUYER_BOND_LOVELACE',
  'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS',
  'REORDER_SERVICE_PRIV_KEY_HEX', 'REORDER_SERVICE_PKH', 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PKH', 'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'REORDER_DELEGATION_2_PKH',
  'STOCK_READER_AUTH_PRIV_KEY_HEX', 'STOCK_READER_AUTH_PKH', 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', 'STOCK_READER_DELEGATION_PKH',
] as const;

/** What a message says of each key, by the job of the key. */
const KEY_WORDS: Readonly<Record<KeyRole, string>> = {
  service: 'the service key',
  delegation1: 'the first delegation key',
  delegation2: 'the second delegation key',
  stockReaderAuthentication: 'the authentication key of stock-reader',
  stockReaderDelegation: 'the delegation key of stock-reader',
};

/** What the service runs on: every setting, read and checked, and the key material that the five keys make. */
export interface ServiceConfig extends WiringSettings {
  /** The bytes that `GET /agent.json` serves, and their SHA-256: the hash that the advert holds. */
  readonly manifest: RenderedManifest;
  /** The token that POST / and POST /precheck require as their authorization header. A secret: it is in no message, no log line and no manifest. */
  readonly authHeader: string;
  readonly host: string;
  readonly port: number;
  /** The fault switch, made one time. The Reorder Agent has no fault value, so its mode is the empty text. */
  readonly fault: FaultSwitch<'reorder-agent'>;
  /** The settings of the co-sign route. */
  readonly cosign: CosignSettings;
}

/** Throws, without printing it, when `published` (the manifest about to be served) holds a key in either of its forms, in any case. */
function assertNoKeyIn(published: string, key: string, what: string): void {
  const lower = published.toLowerCase();
  if (lower.includes(key) || lower.includes(rawHexToBech32(key))) {
    throw new Error(`the manifest would publish ${what}: a value that goes into it holds the key, and the service does not start with it`);
  }
}

/**
 * The configuration of the service from its environment. It throws, naming the variable, for a setting that is required and missing or that is given and wrong. In this order: OPERATOR_CONTACT; the five keys (each
 * form, then two keys that are one key, then each key looked for in every other setting); the token (its form, and the token looked for in every other setting); the DIDs, the fault switch, the listener and the state
 * directory; the endpoints and the two origins of the mock service; the window and the price of the advert; the supplier key; each key hash that the operator wrote down against its key, and a key that is the
 * supplier key; the limits of the two kinds of hire, the settings of the dispute code, the Module-1 manifest and the settings of the co-sign route; the identity deployment; and the manifest last, searched for every
 * secret. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => unknown = manifestFromEnv): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  // Each key is read here, one time, and never shown in a message: it is a secret.
  const serviceHex = requiredEnv('REORDER_SERVICE_PRIV_KEY_HEX', env.REORDER_SERVICE_PRIV_KEY_HEX, 'the service key: 64 lowercase hex characters, a raw Ed25519 key, which pays the model hires and signs the claims and the challenges');
  const delegation1Hex = requiredEnv('REORDER_DELEGATION_1_PRIV_KEY_HEX', env.REORDER_DELEGATION_1_PRIV_KEY_HEX, 'the first delegation key: 64 lowercase hex characters, a raw Ed25519 key, which signs the vault Pay and the Accept of a delegation that names it');
  const delegation2Hex = requiredEnv('REORDER_DELEGATION_2_PRIV_KEY_HEX', env.REORDER_DELEGATION_2_PRIV_KEY_HEX, 'the second delegation key: 64 lowercase hex characters, a raw Ed25519 key, which signs the vault Pay and the Accept of a delegation that names it');
  const readerAuthHex = requiredEnv('STOCK_READER_AUTH_PRIV_KEY_HEX', env.STOCK_READER_AUTH_PRIV_KEY_HEX, 'the authentication key of the subagent stock-reader: 64 lowercase hex characters, a raw Ed25519 key');
  const readerDelegationHex = requiredEnv('STOCK_READER_DELEGATION_PRIV_KEY_HEX', env.STOCK_READER_DELEGATION_PRIV_KEY_HEX, 'the delegation key of the subagent stock-reader: 64 lowercase hex characters, a raw Ed25519 key');
  const held: readonly { readonly role: KeyRole; readonly variable: string; readonly pkhVariable: string; readonly hex: string }[] = [
    { role: 'service', variable: 'REORDER_SERVICE_PRIV_KEY_HEX', pkhVariable: 'REORDER_SERVICE_PKH', hex: serviceHex },
    { role: 'delegation1', variable: 'REORDER_DELEGATION_1_PRIV_KEY_HEX', pkhVariable: 'REORDER_DELEGATION_1_PKH', hex: delegation1Hex },
    { role: 'delegation2', variable: 'REORDER_DELEGATION_2_PRIV_KEY_HEX', pkhVariable: 'REORDER_DELEGATION_2_PKH', hex: delegation2Hex },
    { role: 'stockReaderAuthentication', variable: 'STOCK_READER_AUTH_PRIV_KEY_HEX', pkhVariable: 'STOCK_READER_AUTH_PKH', hex: readerAuthHex },
    { role: 'stockReaderDelegation', variable: 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', pkhVariable: 'STOCK_READER_DELEGATION_PKH', hex: readerDelegationHex },
  ];
  for (const key of held) {
    if (!/^[0-9a-f]{64}$/.test(key.hex)) throw new Error(`environment variable ${key.variable} must be 64 lowercase hex characters (a raw Ed25519 key)`);
  }
  for (const [index, first] of held.entries()) {
    for (const second of held.slice(index + 1)) {
      if (first.hex === second.hex) throw new Error(`environment variable ${second.variable} holds the same key as ${first.variable}: each key of the service must be a key of its own`);
    }
  }
  for (const key of held) {
    refuseSecretIn(env, SETTINGS, [key.hex, rawHexToBech32(key.hex)], key.variable, (name) =>
      `environment variable ${name} holds ${KEY_WORDS[key.role]}, which belongs in ${key.variable} alone: it would be printed or published. Take it out of ${name}`);
  }
  // The token. It is compared with a header, so it is printable ASCII. Never shown in a message, only its length: it is a secret.
  const authHeader = requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER, 'the value the template runtime sends as the authorization header of every call, which POST / requires');
  assertHeaderValue('SERVICE_AUTH_HEADER', authHeader);
  refuseTokenIn(env, SETTINGS, authHeader);

  const agentDid = agentDidOf(env);
  const stockReaderDid = stockReaderDidOf(env);
  const fault = faultOf(env);
  const port = portOf(env);
  const host = hostOf(env);
  const stateDir = stateDirOf(env);
  const endpoints = endpointsFromEnv(env);
  const mock = mockBasesOf(env);
  processingWindowOf(env);
  priceOf(env);
  const supplier = supplierKeyOf(env);

  const keys: Readonly<Record<KeyRole, KeyMaterial>> = {
    service: keyOf(serviceHex), delegation1: keyOf(delegation1Hex), delegation2: keyOf(delegation2Hex), stockReaderAuthentication: keyOf(readerAuthHex), stockReaderDelegation: keyOf(readerDelegationHex),
  };
  // What was written is not shown, only how long it is: it may be a secret in the wrong line. What it is checked against is public.
  for (const key of held) {
    const written = given(env[key.pkhVariable]);
    if (written !== '' && written.toLowerCase() !== keys[key.role].pkh) {
      throw new Error(`environment variable ${key.pkhVariable} (${written.length} characters) is not the key hash of the key in ${key.variable} (the hash of that key is ${keys[key.role].pkh}); correct the line or remove it`);
    }
  }
  const clash = keyClashOf(keys, supplier.pkh);
  if (clash?.kind === 'supplier') {
    const variable = held.find((key) => key.role === clash.role)?.variable ?? 'a key variable';
    throw new Error(`environment variable ${variable} holds the key of SUPPLIER_PKH: the supplier key is the runtime's, and ${KEY_WORDS[clash.role]} must be a key of its own`);
  }
  if (clash?.kind === 'equal') {
    throw new Error(`${KEY_WORDS[clash.second]} and ${KEY_WORDS[clash.first]} are one key: each key of the service must be a key of its own`);
  }

  const modelLimits = limitsOf(env);
  const handoffLimits = handoffLimitsOf(env);
  const dispute = disputeOf(env);
  const module1Manifest = module1SourceOf(env);
  const cosign = cosignSettingsOf(env);
  const identityDeployment = buyerVaultDeployment(env);

  // The manifest comes last, from an environment with no secret in it and with the values as the checks above normalised them.
  const secrets = new Set<string>(['SERVICE_AUTH_HEADER', ...held.map((key) => key.variable)]);
  const published: NodeJS.ProcessEnv = {
    ...Object.fromEntries(SETTINGS.filter((name) => !secrets.has(name)).map((name) => [name, env[name]])),
    AGENT_DID: agentDid,
    SUPPLIER_PKH: supplier.pkh,
    SUPPLIER_PUB_KEY_HEX: supplier.pubKeyHex,
    REORDER_SERVICE_PKH: keys.service.pkh,
    REORDER_DELEGATION_1_PKH: keys.delegation1.pkh,
    REORDER_DELEGATION_2_PKH: keys.delegation2.pkh,
  };
  // The build gets the setting that `renderManifest` gives it, as FAULT_MODE of its environment, and never the live environment: the kit renders for each setting and refuses bytes that differ, and a build that
  // ignored its setting would let that check pass with no meaning.
  const rendered = renderManifest('reorder-agent', (setting) => makeManifest({ ...published, FAULT_MODE: setting }));
  if (!rendered.ok) throw new Error(`the manifest is refused (${rendered.code}): ${rendered.detail}`);
  for (const key of held) assertNoKeyIn(rendered.value.text, key.hex, KEY_WORDS[key.role]);
  assertNoTokenIn(rendered.value.text, authHeader);
  return {
    manifest: rendered.value, authHeader, host, port, fault, cosign, stateDir, agentDid, stockReaderDid, supplier, keys, endpoints, mock, identityDeployment, modelLimits, handoffLimits, dispute, module1Manifest,
  };
}

/** The parts of the service that a test replaces; the service itself uses the real ones. */
export interface StartOptions extends WiringOptions {
  readonly janitorIntervalMs?: number;
  /** How long a stop waits for the pass of a janitor that is in flight: JANITOR_STOP_WAIT_MS by default. */
  readonly janitorStopWaitMs?: number;
  /** How often a job that is running is sent an interim line: the kit's default. */
  readonly heartbeatMs?: number;
}

export interface RunningService {
  server: Server;
  /** The port it listens on, which is the one asked for unless that was 0. */
  port: number;
  /** Stops the janitors (a pass in flight has up to JANITOR_STOP_WAIT_MS) and closes the server and its connections, a job's included. Safe to call twice. */
  stop: () => Promise<void>;
  /**
   * The stop of a restart: no new job, no new connection, the janitors stopped at once, and up to `waitMs` (SHUTDOWN_WAIT_MS by default) for the job that is running, its hire included; then stop(). Past the wait
   * the job is abandoned, and the log names the escrows that the state directory holds for the janitors of the next start.
   */
  shutdown: (waitMs?: number) => Promise<ShutdownOutcome>;
}

/** The file that proves a directory can be written. */
export const WRITE_PROBE = '.write-probe';
/** Throws, naming REORDER_STATE_DIR, unless a file can be made in `dir` and removed again (a volume that the user of the service does not own fails here). */
function assertWritable(dir: string): void {
  const probe = join(dir, WRITE_PROBE);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (err) {
    throw new Error(`environment variable REORDER_STATE_DIR names ${dir}, which cannot be written (${errorText(err)}): the service keeps the record of its escrows, its challenges and its co-signatures there, so it does not start without a place to keep them`);
  }
}

/**
 * Starts the service on its environment: loadConfig, the state directory proved writable, the wiring (which fetches the pinned Module-1 manifest, the one file that the start fetches, asks the node and the chain,
 * and stops the start when they give no answer), the co-sign route, the server and the janitors, which make no transaction while their key is busy. Rejects with the reason when it cannot; nothing keeps running then.
 */
export async function startService(env: NodeJS.ProcessEnv = process.env, options: StartOptions = {}): Promise<RunningService> {
  const config = loadConfig(env);
  const log = options.log ?? defaultLog;
  const clock = options.clock;
  assertWritable(config.stateDir);
  const wired = await wire(config, { ...options, log });
  const cosign = wired.cosignRoute(config.cosign);
  const slot = new JobSlot();
  const server = createServer({
    manifestText: config.manifest.text, authHeader: config.authHeader, fault: config.fault, cosign, proposeDeps: wired.proposeDeps, executeDeps: wired.executeDeps,
    clock: () => (clock === undefined ? Date.now() : clock.now()), log, slot, ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
  });
  await listen(server, config.port, config.host);
  const port = (server.address() as AddressInfo).port;
  let janitors: { stop(): Promise<void> };
  try {
    janitors = wired.startJanitors(options.janitorIntervalMs ?? JANITOR_INTERVAL_MS, options.janitorStopWaitMs ?? JANITOR_STOP_WAIT_MS);
    const addresses = [config.keys.service, config.keys.delegation1, config.keys.delegation2].map((key) => key.address).join(', ');
    log(`listening on ${config.host}:${port}; manifest ${config.manifest.sha256}; wallets (service, delegation 1, delegation 2) ${addresses}; state directory ${config.stateDir}`);
  } catch (err) {
    // A start that fails after the port is open must not leave the server open: it would keep the process alive with nothing behind it.
    server.close();
    server.closeAllConnections();
    throw err;
  }
  const { stop, shutdown } = lifecycle({ server, slot, log, stopWork: () => janitors.stop(), abandonedLine: wired.abandonedLine });
  return { server, port, stop, shutdown };
}

/**
 * Stops the service on SIGTERM and SIGINT (`docker stop` sends the first): no new job, up to `waitMs` for the job that is running, then exit 0, or 1 when that job had to be abandoned or the stop failed. The first
 * signal takes both handlers off, so a second signal of either kind is the default action and ends the process at once. The handling is packages/service-kit's, with the log of this service.
 */
export function stopOnSignals(
  service: Pick<RunningService, 'shutdown'>,
  opts: { target?: EventEmitter; exit?: (code: number) => void; log?: (line: string) => void; waitMs?: number } = {},
): void {
  stopServiceOnSignals(service, { ...opts, log: opts.log ?? defaultLog });
}
