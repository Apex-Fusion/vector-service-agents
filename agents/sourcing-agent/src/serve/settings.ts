// agents/sourcing-agent/src/serve/settings.ts
// The settings of the Sourcing Agent that name no key. Each reader takes the environment (or one value of it), checks what it reads, and throws an Error that names the variable. A message never shows a value
// that could be a secret: it shows a short plain value, or the length of the value (`shown` of the service kit). The settings that name a key are read in start.ts only.
//
// Two groups of limits are required, and none has a default. The model hire has four (the models, the price and the two bond limits), and the hire of a quote has three (the price and the two bond limits).
// Each limit is a bigint of more than 0. A wrong text stops the start: a limit that is not set is never "no limit".
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { envInt, given, hexOf, requiredEnv, shown } from '@vsa/service-kit';
import type { MockBases } from '@vsa/usecase-kit/access';
import { checkLimits as checkHireLimits } from '@vsa/usecase-kit/buyer';
import type { HireLimits } from '@vsa/usecase-kit/buyer';
import { COSIGN_SETTINGS, parseCosignSettings } from '@vsa/usecase-kit/cosign';
import type { CosignSettings } from '@vsa/usecase-kit/cosign';
import { checkLimits, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings } from '@vsa/usecase-kit/dispute';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex, manifestDid } from '@vsa/vector-read';

export const PORT_DEFAULT = 9105;
export const HOST_DEFAULT = '0.0.0.0';
/** Where the state is kept unless SOURCING_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';

/** The deadline of a job: 3,420,000 ms after its request arrives. The runtime waits 60 s longer (`SERVICE_TIMEOUT_MS` is 3,480,000), and the window of the advert is 3,600,000 ms. */
export const JOB_DEADLINE_MS = 3_420_000;
/** The least window of the advert (ADVERT_MAX_PROCESSING_MS) and its default: the deadline of a job and the timeout of the runtime fit inside it. */
export const MIN_PROCESSING_WINDOW_MS = 3_600_000;
/** The price of the advert unless ADVERT_PRICE_LOVELACE says another: 3 units. */
export const PRICE_DEFAULT_LOVELACE = 3_000_000;
/** The two bonds of the advert, in lovelace. The lock of the escrow is the price and both bonds: 5 units for the default price. */
export const SUPPLIER_BOND_LOVELACE = 1_000_000;
export const BUYER_BOND_LOVELACE = 1_000_000;

/** The least window left in the challenge window of a claim that the dispute code takes, as the dispute code holds it. */
const LEAST_WINDOW_LEFT_MS = 2_000;

// --- the identities, the fault switch, the listener and the state ----------------------------------------------------------------------------------------

/** A DID in its canonical form. The message gives the length of the value and never the value. */
function didOf(name: string, text: string, what: string): Did {
  let canonical = text;
  try {
    canonical = manifestDid(text);
  } catch {
    // The message of the helper repeats the value. The message below gives its length.
  }
  const parsed = parseDid(canonical, name);
  if (!parsed.ok) throw new Error(`environment variable ${name} must be did:vector: and 64 lowercase hex characters (${what}), and it has ${text.length} characters`);
  return parsed.value;
}

/** The DID of the Sourcing Agent: the delegate that the delegation of a hirer names. */
export function agentDidOf(env: NodeJS.ProcessEnv): Did {
  return didOf('AGENT_DID', requiredEnv('AGENT_DID', env.AGENT_DID, 'the DID of the Sourcing Agent: the delegate that the delegation of a hirer names'), 'the DID of the agent');
}

/** The variable of each scorer, in the order of the scorers. */
const SCORER_VARIABLES = ['SCORER_1_DID', 'SCORER_2_DID', 'SCORER_3_DID'] as const;

/**
 * The DIDs of the three subagents `scorer-1` to `scorer-3`, in the order of their variables. Each is in the canonical form (the legacy form of an identifier is read as the DID of that identifier), so two forms
 * of one DID are one DID. The three are three agents, and none is the agent itself: a scorer has a record of its own, with this agent as its parent, and a scorer that is another scorer or this agent would
 * make a sub-delegation from an agent to itself. The message names the variables and never shows a DID.
 */
export function scorerDidsOf(env: NodeJS.ProcessEnv): readonly [Did, Did, Did] {
  const agent = agentDidOf(env);
  const dids = SCORER_VARIABLES.map((name, index) =>
    didOf(name, requiredEnv(name, env[name], `the DID of the subagent scorer-${index + 1}, which scores one quote through a sub-delegation`), `the DID of the subagent scorer-${index + 1}`));
  for (const [index, did] of dids.entries()) {
    if (did === agent) throw new Error(`environment variable ${SCORER_VARIABLES[index]} holds the DID of AGENT_DID: a scorer is an agent of its own`);
    const same = dids.findIndex((other) => other === did);
    if (same < index) throw new Error(`environment variable ${SCORER_VARIABLES[index]} holds the same DID as ${SCORER_VARIABLES[same]}: each scorer is an agent of its own`);
  }
  return [dids[0], dids[1], dids[2]];
}

/** The fault switch, made one time at the start. The value is empty or `invert_scores`: any other value stops the start. */
export function faultOf(env: NodeJS.ProcessEnv): FaultSwitch<'sourcing-agent'> {
  return readFaultSwitch('sourcing-agent', env.FAULT_MODE);
}

export function portOf(env: NodeJS.ProcessEnv): number {
  const port = envInt('PORT', given(env.PORT), PORT_DEFAULT);
  if (port > 65_535) throw new Error(`environment variable PORT must be a port from 0 to 65535, got ${shown(String(env.PORT))}`);
  return port;
}

export function hostOf(env: NodeJS.ProcessEnv): string {
  const host = given(env.HOST) || HOST_DEFAULT;
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) throw new Error(`environment variable HOST must be an address or a host name, got ${shown(host)}`);
  return host;
}

export function stateDirOf(env: NodeJS.ProcessEnv): string {
  return given(env.SOURCING_STATE_DIR) || STATE_DIR_DEFAULT;
}

// --- the numbers of the advert ---------------------------------------------------------------------------------------------------------------------------

/** The window that the advert gives a job: at least MIN_PROCESSING_WINDOW_MS. The manifest publishes it. */
export function processingWindowOf(env: NodeJS.ProcessEnv): number {
  const ms = envInt('ADVERT_MAX_PROCESSING_MS', given(env.ADVERT_MAX_PROCESSING_MS), MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of ${MIN_PROCESSING_WINDOW_MS / 60_000} min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes), got ${ms}`);
  }
  return ms;
}

/** The price of the advert, in lovelace: a whole number of more than 0. The two bonds are fixed. */
export function priceOf(env: NodeJS.ProcessEnv): number {
  const price = envInt('ADVERT_PRICE_LOVELACE', given(env.ADVERT_PRICE_LOVELACE), PRICE_DEFAULT_LOVELACE);
  if (price < 1) throw new Error(`environment variable ADVERT_PRICE_LOVELACE must be a whole number of lovelace of more than 0, got ${price}`);
  return price;
}

// --- the supplier key and the issuer of the compliance attestations (public values) ----------------------------------------------------------------------

/** The public part of the supplier key: its key hash and its public key. The private key is the runtime's and never reaches this service. */
export interface SupplierKey {
  readonly pkh: string;
  readonly pubKeyHex: string;
}

/** The key hash and the public key of the supplier key. The public key must hash to the key hash beside it. */
export function supplierKeyOf(env: NodeJS.ProcessEnv): SupplierKey {
  const pkh = hexOf('SUPPLIER_PKH', requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key, published in the manifest'), 28);
  const pubKeyHex = hexOf('SUPPLIER_PUB_KEY_HEX', requiredEnv('SUPPLIER_PUB_KEY_HEX', env.SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key, published in the manifest'), 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip, and this is what stops it.
  if (blake2b224Hex(pubKeyHex) !== pkh) {
    throw new Error('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
  }
  return { pkh, pubKeyHex };
}

/**
 * The key hash of the issuer of the compliance attestations that the agent counts: 56 hex characters, as lower case. It is required, and it is public: the manifest names it, so a hirer sees whose attestations
 * the agent counts. An attestation of any other issuer is not counted, because anybody can make an attestation about any subject. A value of 64 characters is a key in the wrong line, and the message gives
 * its length and never the value.
 */
export function complianceIssuerOf(env: NodeJS.ProcessEnv): string {
  return hexOf('COMPLIANCE_ISSUER_PKH', requiredEnv('COMPLIANCE_ISSUER_PKH', env.COMPLIANCE_ISSUER_PKH, 'the key hash of the issuer of the compliance attestations that the agent counts, published in the manifest'), 28);
}

// --- the endpoints, the mock service, the Module-1 manifest ----------------------------------------------------------------------------------------------

/** An https origin: no user, no path, no query and no fragment. Gives the origin and its host (with the port when it is not the default one). */
export function httpsOriginOf(name: string, value: string): { readonly origin: string; readonly host: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`environment variable ${name} must be an https origin such as https://host.example, got ${shown(value)}`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || value.endsWith('//')) {
    throw new Error(`environment variable ${name} must be an https origin with no user, path, query or fragment, got ${shown(value)}`);
  }
  return { origin: url.origin, host: url.host };
}

/** An http or https address with no user and no password. The text stays as the operator wrote it. A message never repeats it: a provider can put a key in the address. */
function addressOf(name: string, value: string, fallback: string): string {
  const text = value === '' ? fallback : value;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`environment variable ${name} must be an http or https address, and it has ${text.length} characters`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw new Error(`environment variable ${name} must be an http or https address with no user and no password, and it has ${text.length} characters`);
  }
  return text;
}

/** The two origins of the mock service: the host of tokens and the host that asks for a client certificate. They are two hosts. */
export function mockBasesOf(env: NodeJS.ProcessEnv): MockBases {
  const publicBase = httpsOriginOf('MOCK_PUBLIC_BASE', requiredEnv('MOCK_PUBLIC_BASE', env.MOCK_PUBLIC_BASE, 'the https origin of the host of tokens of the mock service'));
  const mtlsBase = httpsOriginOf('MOCK_MTLS_BASE', requiredEnv('MOCK_MTLS_BASE', env.MOCK_MTLS_BASE, 'the https origin of the client-certificate host of the mock service'));
  if (publicBase.host === mtlsBase.host) throw new Error('environment variable MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE: the mock service tells the two hosts apart by the Host header');
  return { publicBase: publicBase.origin, mtlsBase: mtlsBase.origin };
}

export interface Endpoints {
  readonly gatewayUrl: string;
  readonly ogmiosUrl: string;
  readonly koiosUrl: string;
  readonly submitUrl: string;
  /** The marketplace indexer; the configured one when it is not set. */
  readonly indexerUrl: string | undefined;
}

/**
 * The endpoints of the chain, the identity gateway and the indexer. `VECTOR_OGMIOS_URL` must be an https address: the janitor makes its reader of the tip, `tipSlotOf`, from it at its first pass, and that reader
 * takes https only, so an http address would pass the start and fail at that pass, and a left sub-delegation would stay on the list for ever.
 */
export function endpointsFromEnv(env: NodeJS.ProcessEnv): Endpoints {
  const indexer = given(env.VECTOR_MARKETPLACE_INDEXER_URL);
  const ogmiosUrl = addressOf('VECTOR_OGMIOS_URL', given(env.VECTOR_OGMIOS_URL), VECTOR_OGMIOS_URL);
  if (new URL(ogmiosUrl).protocol !== 'https:') throw new Error(`environment variable VECTOR_OGMIOS_URL must be an https address: the tip reader of the janitor takes https only, and it has ${ogmiosUrl.length} characters`);
  return {
    gatewayUrl: httpsOriginOf('IDENTITY_GATEWAY_URL', given(env.IDENTITY_GATEWAY_URL) || GATEWAY_DEFAULT).origin,
    ogmiosUrl,
    koiosUrl: addressOf('VECTOR_KOIOS_URL', given(env.VECTOR_KOIOS_URL), VECTOR_KOIOS_URL),
    submitUrl: addressOf('VECTOR_SUBMIT_URL', given(env.VECTOR_SUBMIT_URL), VECTOR_SUBMIT_URL),
    indexerUrl: indexer === '' ? undefined : addressOf('VECTOR_MARKETPLACE_INDEXER_URL', indexer, indexer),
  };
}

/** A commit of git as a segment of a path: 40 lower-case hex characters. */
const COMMIT_SEGMENT = /^[0-9a-f]{40}$/;

/**
 * The https address of the Module-1 deployment manifest, pinned to a commit: its path holds a segment of 40 lower-case hex characters, the commit that the manifest was published at, so the manifest that the
 * service reads cannot change under it. The wiring fetches that one file one time, at the start: it is the one thing that the start fetches besides the node. A file path, an `http` address, an address with a user,
 * a password, a query or a fragment, and an address with no commit segment (a branch name moves) stop the start. A message names the variable and never repeats the value: an address can hold a secret.
 */
export function module1SourceOf(env: NodeJS.ProcessEnv): string {
  const source = requiredEnv('VECTOR_MODULE1_MANIFEST', env.VECTOR_MODULE1_MANIFEST, 'the https address of the Module-1 deployment manifest, pinned to a commit, which the service fetches one time at its start');
  let url: URL | null = null;
  try {
    url = source.startsWith('https://') ? new URL(source) : null;
  } catch {
    url = null;
  }
  if (url === null) throw new Error(`environment variable VECTOR_MODULE1_MANIFEST must be an https address, and it has ${source.length} characters: a file path and an http address are refused`);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('environment variable VECTOR_MODULE1_MANIFEST must be an https address with no user, no password, no query and no fragment');
  }
  if (!url.pathname.split('/').some((segment) => COMMIT_SEGMENT.test(segment))) {
    throw new Error('environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: its path must hold a segment of 40 lowercase hex characters, because an address with no commit can change under the service');
  }
  return source;
}

// --- the limits of the two kinds of hire, the dispute, the co-signature ----------------------------------------------------------------------------------

/** A whole number of lovelace, more than 0, written in digits. The message gives the length of the text and never the text: a value that is no number may be a secret in the wrong line. */
function lovelaceOf(name: string, value: string): bigint {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || BigInt(value) <= 0n) {
    throw new Error(`environment variable ${name} must be a whole number of lovelace of more than 0, written in digits, and it has ${value.length} characters`);
  }
  return BigInt(value);
}

/** A whole number of milliseconds of at least `least`, written in digits. */
function millisecondsOf(name: string, value: string, least: number): number {
  const ms = envInt(name, value, Number.NaN);
  if (!(ms >= least)) throw new Error(`environment variable ${name} must be a whole number of milliseconds of at least ${least}, and it has ${value.length} characters`);
  return ms;
}

/**
 * The two limits of a model hire that the manifest publishes: the models and the price ceiling. Both are required. The manifest publishes the ceiling as a number of lovelace of 1 or more, so a ceiling of 0
 * stops the start here.
 */
export function modelOf(env: NodeJS.ProcessEnv): { readonly allowlist: readonly string[]; readonly maxPriceLovelace: bigint } {
  const allowlist = parseModelAllowlist(requiredEnv('LLM_MODEL_ALLOWLIST', env.LLM_MODEL_ALLOWLIST, 'the models that the service may hire for its decisions, in order of preference'));
  if (!allowlist.ok) throw new Error(`environment variable ${allowlist.detail}`);
  const price = parseMaxPrice(requiredEnv('LLM_MAX_PRICE_LOVELACE', env.LLM_MAX_PRICE_LOVELACE, 'the most that a model hire may be priced at, in lovelace'));
  if (!price.ok) throw new Error(`environment variable ${price.detail}`);
  if (price.value < 1n) throw new Error('environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0');
  return { allowlist: allowlist.value, maxPriceLovelace: price.value };
}

/**
 * The four limits of a model hire: the allowlist, the price ceiling and the limit of each bond. All four are required. The service never fills in a limit and never gives `null`: an operator who sets no limit has a
 * service that hires nothing.
 */
export function limitsOf(env: NodeJS.ProcessEnv): ModelLimits {
  const model = modelOf(env);
  const supplierBond = lovelaceOf('LLM_MAX_SUPPLIER_BOND_LOVELACE', requiredEnv('LLM_MAX_SUPPLIER_BOND_LOVELACE', env.LLM_MAX_SUPPLIER_BOND_LOVELACE, 'the most that the supplier bond of a model advert may be, in lovelace'));
  const buyerBond = lovelaceOf('LLM_MAX_BUYER_BOND_LOVELACE', requiredEnv('LLM_MAX_BUYER_BOND_LOVELACE', env.LLM_MAX_BUYER_BOND_LOVELACE, 'the most that the buyer bond of a model advert may be, in lovelace'));
  const checked = checkLimits({ allowlist: model.allowlist, maxPriceLovelace: model.maxPriceLovelace, maxSupplierBondLovelace: supplierBond, maxBuyerBondLovelace: buyerBond });
  if (!checked.ok) throw new Error(`the limits of the model hire are refused: ${checked.detail}`);
  return checked.value;
}

/** The three limits of the hire of a quote: the price and each bond of the advert of a Bid Desk. All three are required, and each is a bigint of more than 0. */
export function quoteLimitsOf(env: NodeJS.ProcessEnv): HireLimits {
  const price = lovelaceOf('QUOTE_MAX_PRICE_LOVELACE', requiredEnv('QUOTE_MAX_PRICE_LOVELACE', env.QUOTE_MAX_PRICE_LOVELACE, 'the most that the price of the advert of a Bid Desk may be, in lovelace'));
  const supplierBond = lovelaceOf('QUOTE_MAX_SUPPLIER_BOND_LOVELACE', requiredEnv('QUOTE_MAX_SUPPLIER_BOND_LOVELACE', env.QUOTE_MAX_SUPPLIER_BOND_LOVELACE, 'the most that the supplier bond of the advert of a Bid Desk may be, in lovelace'));
  const buyerBond = lovelaceOf('QUOTE_MAX_BUYER_BOND_LOVELACE', requiredEnv('QUOTE_MAX_BUYER_BOND_LOVELACE', env.QUOTE_MAX_BUYER_BOND_LOVELACE, 'the most that the buyer bond of the advert of a Bid Desk may be, in lovelace'));
  const checked = checkHireLimits({ maxPriceLovelace: price, maxSupplierBondLovelace: supplierBond, maxBuyerBondLovelace: buyerBond });
  if (!checked.ok) throw new Error(`the limits of the hire of a quote are refused: ${checked.detail}`);
  return checked.value;
}

/**
 * The settings of the dispute code. The stake, the least window left and the bound of a read are required. The lease of an unfinished challenge and the resolution deadline are optional: the deadline must be
 * the one of the Module-1 deployment, and the dispute code checks that when it reads the deployment.
 */
export function disputeOf(env: NodeJS.ProcessEnv): DisputeSettings {
  const stake = lovelaceOf('DISPUTE_CHALLENGE_STAKE_LOVELACE', requiredEnv('DISPUTE_CHALLENGE_STAKE_LOVELACE', env.DISPUTE_CHALLENGE_STAKE_LOVELACE, 'the stake of a challenge, in lovelace'));
  const windowLeft = millisecondsOf('DISPUTE_MIN_WINDOW_LEFT_MS', requiredEnv('DISPUTE_MIN_WINDOW_LEFT_MS', env.DISPUTE_MIN_WINDOW_LEFT_MS, 'the least time left in the challenge window of a claim'), LEAST_WINDOW_LEFT_MS);
  const readTimeout = millisecondsOf('DISPUTE_READ_TIMEOUT_MS', requiredEnv('DISPUTE_READ_TIMEOUT_MS', env.DISPUTE_READ_TIMEOUT_MS, 'the most time that one read of the dispute code may take'), 1);
  const lease = given(env.DISPUTE_STARTED_LEASE_MS);
  const deadline = given(env.DISPUTE_RESOLUTION_DEADLINE_MS);
  return {
    challenge_stake_lovelace: stake,
    min_window_left_ms: windowLeft,
    read_timeout_ms: readTimeout,
    ...(lease === '' ? {} : { started_lease_ms: millisecondsOf('DISPUTE_STARTED_LEASE_MS', lease, 2 * readTimeout) }),
    ...(deadline === '' ? {} : { resolution_deadline_ms: millisecondsOf('DISPUTE_RESOLUTION_DEADLINE_MS', deadline, LEAST_RESOLUTION_DEADLINE_MS) }),
  };
}

/**
 * The settings of the co-sign route. The allowlist is required: the empty text is a list that holds nobody, and a setting that is not set is refused, so a route never signs for nobody by a slip. A limit that is
 * not set, or is blank, takes the default of the kit. The kit gives a typed refusal for a wrong value, and the start stops with its detail, which names the setting and never a key.
 */
export function cosignSettingsOf(env: NodeJS.ProcessEnv): CosignSettings {
  const limit = (name: string): string | undefined => (given(env[name]) === '' ? undefined : given(env[name]));
  const parsed = parseCosignSettings({
    [COSIGN_SETTINGS.allowlist]: env.COSIGN_ALLOWLIST,
    [COSIGN_SETTINGS.maxConcurrent]: limit('COSIGN_MAX_CONCURRENT'),
    [COSIGN_SETTINGS.maxFutureMs]: limit('COSIGN_MAX_FUTURE_MS'),
    [COSIGN_SETTINGS.ledgerTimeoutMs]: limit('COSIGN_LEDGER_TIMEOUT_MS'),
  });
  if (!parsed.ok) throw new Error(`the settings of the co-sign route are refused: ${parsed.detail}`);
  return parsed.value;
}
