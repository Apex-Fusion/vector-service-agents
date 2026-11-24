// agents/sourcing-agent/src/serve/start.ts
// How the Sourcing Agent starts: the environment read into a configuration (loadConfig), and the real parts put together and started (startService). It is the one file of the service that names a key variable. It
// reads each of the nine key variables one time, in the call that takes it, and hands the values to src/serve/keys.ts, which makes the signers. The identity names of the deployment come from
// VAULT_PAYER_IDENTITY_SETTINGS of buyer-core, so that no source of the service writes them.
//
// The nine keys. `SOURCING_SERVICE_PRIV_KEY_HEX` is the service key: it pays the model hires, signs the claims and the challenges, and signs the subject token of the agent. `SOURCING_DELEGATION_1_PRIV_KEY_HEX` and
// `SOURCING_DELEGATION_2_PRIV_KEY_HEX` are the delegation keys: a delegation of a hirer names one of them, and it signs the vault Pay and the Accept of each quote hire and the Delegate and the Undelegate of each
// sub-delegation. `SCORER_1_AUTH_PRIV_KEY_HEX` and `SCORER_1_DELEGATION_PRIV_KEY_HEX` are the two keys of scorer-1, `SCORER_2_AUTH_PRIV_KEY_HEX` and `SCORER_2_DELEGATION_PRIV_KEY_HEX` the two keys of scorer-2,
// and `SCORER_3_AUTH_PRIV_KEY_HEX` and `SCORER_3_DELEGATION_PRIV_KEY_HEX` the two keys of scorer-3. The supplier key is the runtime's and never reaches this service: the service holds its key hash and its public key,
// which the manifest publishes. Each key has a public cross-check variable, the key hash, and the service stops at the start when it is set and is not the hash of the key.
//
// Two kinds of setting hold a secret: the nine keys and the token (SERVICE_AUTH_HEADER). Each key is looked for in every other setting, in its hex form and its bech32 form, in any case, inside a longer value too.
// The token is looked for the same way. No message shows a value that is hex-shaped or long. The manifest is searched for all of them last. Everything is checked before anything is made: no directory is created and
// no chain is built for an environment that is refused. The state directory is proved writable before the first job could depend on it. FAULT_MODE is read one time: it is empty, or it is the one fault value of
// this agent, and any other value stops the start. The manifest is rendered with each setting that the kit gives the build, and never with the live environment, so the bytes of the manifest are the same for every
// fault value.
import { rmSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { VAULT_PAYER_IDENTITY_SETTINGS, buyerVaultDeployment, rawHexToBech32 } from '@vsa/buyer-core';
import {
  JobSlot, assertHeaderValue, assertNoTokenIn, errorText, given, hexOf, lifecycle, listen, refuseSecretIn, refuseTokenIn, requiredEnv, stopOnSignals as stopServiceOnSignals,
} from '@vsa/service-kit';
import type { ShutdownOutcome } from '@vsa/service-kit';
import type { CosignSettings } from '@vsa/usecase-kit/cosign';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import type { RenderedManifest } from '@vsa/usecase-kit/manifest';
import { KEY_ROLES, keyClashOf, keyOf } from './keys.ts';
import type { KeyMaterial, KeyRole } from './keys.ts';
import { manifestFromEnv } from './manifest.ts';
import { createServer, defaultLog } from './server.ts';
import {
  agentDidOf, complianceIssuerOf, cosignSettingsOf, disputeOf, endpointsFromEnv, faultOf, hostOf, limitsOf, mockBasesOf, module1SourceOf, portOf, priceOf, processingWindowOf, quoteLimitsOf, scorerDidsOf,
  stateDirOf, supplierKeyOf,
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
  'QUOTE_MAX_PRICE_LOVELACE', 'QUOTE_MAX_SUPPLIER_BOND_LOVELACE', 'QUOTE_MAX_BUYER_BOND_LOVELACE',
  'DISPUTE_CHALLENGE_STAKE_LOVELACE', 'DISPUTE_MIN_WINDOW_LEFT_MS', 'DISPUTE_READ_TIMEOUT_MS', 'DISPUTE_RESOLUTION_DEADLINE_MS', 'DISPUTE_STARTED_LEASE_MS',
  'SOURCING_STATE_DIR', 'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID', 'COMPLIANCE_ISSUER_PKH',
  'COSIGN_ALLOWLIST', 'COSIGN_MAX_CONCURRENT', 'COSIGN_MAX_FUTURE_MS', 'COSIGN_LEDGER_TIMEOUT_MS',
  'SOURCING_SERVICE_PRIV_KEY_HEX', 'SOURCING_SERVICE_PKH', 'SOURCING_DELEGATION_1_PRIV_KEY_HEX', 'SOURCING_DELEGATION_1_PKH', 'SOURCING_DELEGATION_2_PRIV_KEY_HEX', 'SOURCING_DELEGATION_2_PKH',
  'SCORER_1_AUTH_PRIV_KEY_HEX', 'SCORER_1_AUTH_PKH', 'SCORER_1_DELEGATION_PRIV_KEY_HEX', 'SCORER_1_DELEGATION_PKH',
  'SCORER_2_AUTH_PRIV_KEY_HEX', 'SCORER_2_AUTH_PKH', 'SCORER_2_DELEGATION_PRIV_KEY_HEX', 'SCORER_2_DELEGATION_PKH',
  'SCORER_3_AUTH_PRIV_KEY_HEX', 'SCORER_3_AUTH_PKH', 'SCORER_3_DELEGATION_PRIV_KEY_HEX', 'SCORER_3_DELEGATION_PKH',
] as const;

/** The variable of each key and the public variable that holds its key hash. */
const VARIABLES: Readonly<Record<KeyRole, { readonly variable: string; readonly pkhVariable: string }>> = {
  service: { variable: 'SOURCING_SERVICE_PRIV_KEY_HEX', pkhVariable: 'SOURCING_SERVICE_PKH' },
  delegation1: { variable: 'SOURCING_DELEGATION_1_PRIV_KEY_HEX', pkhVariable: 'SOURCING_DELEGATION_1_PKH' },
  delegation2: { variable: 'SOURCING_DELEGATION_2_PRIV_KEY_HEX', pkhVariable: 'SOURCING_DELEGATION_2_PKH' },
  scorer1Authentication: { variable: 'SCORER_1_AUTH_PRIV_KEY_HEX', pkhVariable: 'SCORER_1_AUTH_PKH' },
  scorer1Delegation: { variable: 'SCORER_1_DELEGATION_PRIV_KEY_HEX', pkhVariable: 'SCORER_1_DELEGATION_PKH' },
  scorer2Authentication: { variable: 'SCORER_2_AUTH_PRIV_KEY_HEX', pkhVariable: 'SCORER_2_AUTH_PKH' },
  scorer2Delegation: { variable: 'SCORER_2_DELEGATION_PRIV_KEY_HEX', pkhVariable: 'SCORER_2_DELEGATION_PKH' },
  scorer3Authentication: { variable: 'SCORER_3_AUTH_PRIV_KEY_HEX', pkhVariable: 'SCORER_3_AUTH_PKH' },
  scorer3Delegation: { variable: 'SCORER_3_DELEGATION_PRIV_KEY_HEX', pkhVariable: 'SCORER_3_DELEGATION_PKH' },
};

/** What a message says of each key, by the job of the key. */
const KEY_WORDS: Readonly<Record<KeyRole, string>> = {
  service: 'the service key',
  delegation1: 'the first delegation key',
  delegation2: 'the second delegation key',
  scorer1Authentication: 'the authentication key of scorer-1',
  scorer1Delegation: 'the delegation key of scorer-1',
  scorer2Authentication: 'the authentication key of scorer-2',
  scorer2Delegation: 'the delegation key of scorer-2',
  scorer3Authentication: 'the authentication key of scorer-3',
  scorer3Delegation: 'the delegation key of scorer-3',
};

/** What the service runs on: every setting, read and checked, and the key material that the nine keys make. The fault switch is the one that `faultOf` made. */
export interface ServiceConfig extends WiringSettings {
  /** The bytes that `GET /agent.json` serves, and their SHA-256: the hash that the advert holds. */
  readonly manifest: RenderedManifest;
  /** The token that POST / and POST /precheck require as their authorization header. A secret: it is in no message, no log line and no manifest. */
  readonly authHeader: string;
  readonly host: string;
  readonly port: number;
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
 * The configuration of the service from its environment. It throws, naming the variable, for a setting that is required and missing or that is given and wrong. In this order: OPERATOR_CONTACT; the nine keys (each
 * is required, then each form, then the key hash that the operator wrote down against its key, then two keys that are one key and a key that is the supplier key); the token; each key and the token looked for in
 * every other setting; the settings that name no key (the DIDs, the issuer of the compliance attestations, the fault switch, the listener, the state directory, the endpoints, the two origins of the mock service,
 * the window and the price of the advert, the limits of the two kinds of hire, the settings of the dispute code, the Module-1 manifest, the settings of the co-sign route and the identity deployment); and the
 * manifest last, searched for every secret. `makeManifest` is a seam for a test of that last look.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, makeManifest: (env: NodeJS.ProcessEnv) => unknown = manifestFromEnv): ServiceConfig {
  requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT, "the operator's contact address, published in the manifest");
  // Each key is read here, one time, and never shown in a message: it is a secret.
  const written: Readonly<Record<KeyRole, string>> = {
    service: requiredEnv('SOURCING_SERVICE_PRIV_KEY_HEX', env.SOURCING_SERVICE_PRIV_KEY_HEX, 'the service key: 64 hex characters, a raw Ed25519 key, which pays the model hires and signs the claims and the challenges'),
    delegation1: requiredEnv('SOURCING_DELEGATION_1_PRIV_KEY_HEX', env.SOURCING_DELEGATION_1_PRIV_KEY_HEX, 'the first delegation key: 64 hex characters, a raw Ed25519 key, which signs for a delegation that names it'),
    delegation2: requiredEnv('SOURCING_DELEGATION_2_PRIV_KEY_HEX', env.SOURCING_DELEGATION_2_PRIV_KEY_HEX, 'the second delegation key: 64 hex characters, a raw Ed25519 key, which signs for a delegation that names it'),
    scorer1Authentication: requiredEnv('SCORER_1_AUTH_PRIV_KEY_HEX', env.SCORER_1_AUTH_PRIV_KEY_HEX, 'the authentication key of scorer-1: 64 hex characters, a raw Ed25519 key'),
    scorer1Delegation: requiredEnv('SCORER_1_DELEGATION_PRIV_KEY_HEX', env.SCORER_1_DELEGATION_PRIV_KEY_HEX, 'the delegation key of scorer-1: 64 hex characters, a raw Ed25519 key'),
    scorer2Authentication: requiredEnv('SCORER_2_AUTH_PRIV_KEY_HEX', env.SCORER_2_AUTH_PRIV_KEY_HEX, 'the authentication key of scorer-2: 64 hex characters, a raw Ed25519 key'),
    scorer2Delegation: requiredEnv('SCORER_2_DELEGATION_PRIV_KEY_HEX', env.SCORER_2_DELEGATION_PRIV_KEY_HEX, 'the delegation key of scorer-2: 64 hex characters, a raw Ed25519 key'),
    scorer3Authentication: requiredEnv('SCORER_3_AUTH_PRIV_KEY_HEX', env.SCORER_3_AUTH_PRIV_KEY_HEX, 'the authentication key of scorer-3: 64 hex characters, a raw Ed25519 key'),
    scorer3Delegation: requiredEnv('SCORER_3_DELEGATION_PRIV_KEY_HEX', env.SCORER_3_DELEGATION_PRIV_KEY_HEX, 'the delegation key of scorer-3: 64 hex characters, a raw Ed25519 key'),
  };
  // The form of each key: 64 hex characters, which `hexOf` gives in lower case. The message of a value that is not a key gives its length and never the value.
  const hex = {} as Record<KeyRole, string>;
  for (const role of KEY_ROLES) hex[role] = hexOf(VARIABLES[role].variable, written[role], 32);
  const keys = Object.fromEntries(KEY_ROLES.map((role) => [role, keyOf(hex[role])])) as Record<KeyRole, KeyMaterial>;
  // What was written against a key is not shown, only how long it is: it may be a secret in the wrong line. What it is checked against is public.
  for (const role of KEY_ROLES) {
    const { variable, pkhVariable } = VARIABLES[role];
    const claimed = given(env[pkhVariable]);
    if (claimed !== '' && claimed.toLowerCase() !== keys[role].pkh) {
      throw new Error(`environment variable ${pkhVariable} (${claimed.length} characters) is not the key hash of the key in ${variable} (the hash of that key is ${keys[role].pkh}); correct the line or remove it`);
    }
  }
  const supplier = supplierKeyOf(env);
  const clash = keyClashOf(keys, supplier.pkh);
  if (clash?.kind === 'equal') {
    throw new Error(`environment variable ${VARIABLES[clash.second].variable} holds the same key as ${VARIABLES[clash.first].variable}: each key of the service must be a key of its own`);
  }
  if (clash?.kind === 'supplier') {
    throw new Error(`environment variable ${VARIABLES[clash.role].variable} holds the key of SUPPLIER_PKH: the supplier key is the runtime's, and ${KEY_WORDS[clash.role]} must be a key of its own`);
  }
  // The token. It is compared with a header, so it is printable ASCII. Never shown in a message, only its length: it is a secret.
  const authHeader = requiredEnv('SERVICE_AUTH_HEADER', env.SERVICE_AUTH_HEADER, 'the value the template runtime sends as the authorization header of every call, which POST / requires');
  assertHeaderValue('SERVICE_AUTH_HEADER', authHeader);
  // Each secret is looked for in every other setting, so a line that holds one stops the start before the line is read by a reader that could print it, or goes into the manifest.
  for (const role of KEY_ROLES) {
    refuseSecretIn(env, SETTINGS, [hex[role], rawHexToBech32(hex[role])], VARIABLES[role].variable, (name) =>
      `environment variable ${name} holds ${KEY_WORDS[role]}, which belongs in ${VARIABLES[role].variable} alone: it would be printed or published. Take it out of ${name}`);
  }
  refuseTokenIn(env, SETTINGS, authHeader);

  const agentDid = agentDidOf(env);
  const scorerDids = scorerDidsOf(env);
  const complianceIssuerPkh = complianceIssuerOf(env);
  const fault = faultOf(env);
  const port = portOf(env);
  const host = hostOf(env);
  const stateDir = stateDirOf(env);
  const endpoints = endpointsFromEnv(env);
  const mock = mockBasesOf(env);
  processingWindowOf(env);
  priceOf(env);
  const modelLimits = limitsOf(env);
  const quoteLimits = quoteLimitsOf(env);
  const dispute = disputeOf(env);
  const module1Manifest = module1SourceOf(env);
  const cosign = cosignSettingsOf(env);
  const identityDeployment = buyerVaultDeployment(env);

  // The manifest comes last, from an environment with no secret in it, with the values as the checks above normalised them, and with no FAULT_MODE of the live environment: the render gives each build its own.
  const secrets = new Set<string>(['SERVICE_AUTH_HEADER', ...KEY_ROLES.map((role) => VARIABLES[role].variable)]);
  const published: NodeJS.ProcessEnv = {
    ...Object.fromEntries(SETTINGS.filter((name) => !secrets.has(name) && name !== 'FAULT_MODE').map((name) => [name, env[name]])),
    AGENT_DID: agentDid,
    SUPPLIER_PKH: supplier.pkh,
    SUPPLIER_PUB_KEY_HEX: supplier.pubKeyHex,
    COMPLIANCE_ISSUER_PKH: complianceIssuerPkh,
    SOURCING_SERVICE_PKH: keys.service.pkh,
    SOURCING_DELEGATION_1_PKH: keys.delegation1.pkh,
    SOURCING_DELEGATION_2_PKH: keys.delegation2.pkh,
  };
  // The build gets the setting that `renderManifest` gives it, as FAULT_MODE of its environment: the kit renders for each setting and refuses bytes that differ, and a build that ignored its setting would let that
  // check pass with no meaning.
  const rendered = renderManifest('sourcing-agent', (setting) => makeManifest({ ...published, FAULT_MODE: setting }));
  if (!rendered.ok) throw new Error(`the manifest is refused (${rendered.code}): ${rendered.detail}`);
  for (const role of KEY_ROLES) assertNoKeyIn(rendered.value.text, hex[role], KEY_WORDS[role]);
  assertNoTokenIn(rendered.value.text, authHeader);
  return {
    manifest: rendered.value, authHeader, host, port, cosign, stateDir, agentDid, scorerDids, supplier, keys, complianceIssuerPkh, endpoints, mock, identityDeployment, modelLimits, quoteLimits, dispute,
    module1Manifest, fault,
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
/** Throws, naming SOURCING_STATE_DIR, unless a file can be made in `dir` and removed again (a volume that the user of the service does not own fails here). */
function assertWritable(dir: string): void {
  const probe = join(dir, WRITE_PROBE);
  try {
    writeFileSync(probe, '');
    rmSync(probe);
  } catch (err) {
    throw new Error(`environment variable SOURCING_STATE_DIR names ${dir}, which cannot be written (${errorText(err)}): the service keeps the record of its escrows, its challenges, its left sub-delegations and its co-signatures there, so it does not start without a place to keep them`);
  }
}

/**
 * Starts the service on its environment: loadConfig, the state directory proved writable, the wiring (which fetches the pinned Module-1 manifest, the one file that the start fetches, and asks the node for the
 * start time of the chain, and stops the start when it gives none), the co-sign route, the server and the janitors, which make no transaction while their key is busy. Rejects with the reason when it cannot; nothing
 * keeps running then.
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
