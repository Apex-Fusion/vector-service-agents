// agents/prior-authorization-agent/src/serve/settings.ts
// The settings of the Prior Authorization Agent that name no key. Each reader takes the environment (or one value of it), checks what it reads, and throws an Error that names the setting. A message never shows a
// value: it gives the length of the value, because a key or a token can stand in the wrong line of a file. The settings that name a key are read in start.ts only.
//
// The agent has no limit with a default. The three limits of a model hire (the price and each bond), the models, the three limits of the hire of the Insurer Intake Agent (the price and each bond), and the settings
// of the dispute code are required: a limit that is not set is never "no limit".
import { MAX_ESCROW_LOVELACE, VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { envInt, given, hexOf, requiredEnv } from '@vsa/service-kit';
import type { MockBases } from '@vsa/usecase-kit/access';
import { checkLimits as checkHireLimits } from '@vsa/usecase-kit/buyer';
import type { HireLimits } from '@vsa/usecase-kit/buyer';
import { COSIGN_SETTINGS, parseCosignSettings } from '@vsa/usecase-kit/cosign';
import type { CosignSettings } from '@vsa/usecase-kit/cosign';
import { checkLimits, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings } from '@vsa/usecase-kit/dispute';
import { parseFaultSetting, readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { FAULT_MODES, parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex, manifestDid } from '@vsa/vector-read';

export const PORT_DEFAULT = 9103;
export const HOST_DEFAULT = '0.0.0.0';
/** Where the state is kept unless PRIORAUTH_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';

/** The deadline of a job: 1,620,000 ms after its request arrives. The runtime waits 60 s longer (`SERVICE_TIMEOUT_MS` is 1,680,000), and the window of the advert is 1,800,000 ms. */
export const JOB_DEADLINE_MS = 1_620_000;
/** The least window of the advert (ADVERT_MAX_PROCESSING_MS) and its default: the deadline of a job and the timeout of the runtime fit inside it. */
export const MIN_PROCESSING_WINDOW_MS = 1_800_000;
/** The most window that the advert may give a job: 24 hours. A Post holds the lock of a buyer for the window of the advert, and it refuses an advert with a longer one. */
export const MAX_PROCESSING_WINDOW_MS = 86_400_000;
/** The price of the advert unless ADVERT_PRICE_LOVELACE says another: 3 units. */
export const PRICE_DEFAULT_LOVELACE = 3_000_000;
/** The two bonds of the advert, in lovelace. The lock of the escrow is the price and both bonds: 5 units for the default price. */
export const SUPPLIER_BOND_LOVELACE = 1_000_000;
export const BUYER_BOND_LOVELACE = 1_000_000;
/**
 * The highest price of the advert: with both bonds, the lock of an escrow stays inside its value cap (`MAX_ESCROW_LOVELACE` of buyer-core). A Post refuses an advert above the cap, so an advert with a higher price
 * could not be hired.
 */
export const MAX_PRICE_LOVELACE = Number(MAX_ESCROW_LOVELACE - BigInt(SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE));

/** The least window left in the challenge window of a claim that the dispute code takes, as the dispute code holds it. */
const LEAST_WINDOW_LEFT_MS = 2_000;

/** The kind of this agent in the tables of the kit. */
const KIND = 'prior-authorization-agent';

/** A whole number written in digits, as `envInt` of the service kit reads it. A text that is no number is refused with its length and never with itself: it may be a secret in the wrong line. */
function wholeNumberOf(name: string, value: string, fallback: number): number {
  try {
    return envInt(name, value, fallback);
  } catch {
    throw new Error(`environment variable ${name} must be a non-negative whole number written in digits, and it has ${value.length} characters`);
  }
}

/** A whole number of lovelace, more than 0, written in digits. */
function lovelaceOf(name: string, value: string): bigint {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || BigInt(value) <= 0n) {
    throw new Error(`environment variable ${name} must be a whole number of lovelace of more than 0, written in digits, and it has ${value.length} characters`);
  }
  return BigInt(value);
}

/** A whole number of milliseconds of at least `least`, written in digits. */
function millisecondsOf(name: string, value: string, least: number): number {
  const ms = wholeNumberOf(name, value, Number.NaN);
  if (!(ms >= least)) throw new Error(`environment variable ${name} must be a whole number of milliseconds of at least ${least}, and it has ${value.length} characters`);
  return ms;
}

// --- the three DIDs, the fault switch, the listener and the state ----------------------------------------------------------------------------------------

/** The canonical DID that a text names, or null when the text is no DID. A DID in its legacy form is the canonical DID of the same identifier. */
function readDid(text: string): Did | null {
  let canonical = text;
  try {
    canonical = manifestDid(text);
  } catch {
    // The message of the helper repeats the value. The caller says what is wrong, with the length of the value.
  }
  const parsed = parseDid(canonical, 'DID');
  return parsed.ok ? parsed.value : null;
}

/** A DID setting, in its canonical form. */
function didOf(name: string, text: string): Did {
  const did = readDid(text);
  if (did === null) throw new Error(`environment variable ${name} must be did:vector: and 64 lowercase hex characters, and it has ${text.length} characters`);
  return did;
}

/**
 * Refuses a DID that is the DID of another setting. The agent and its two subagents are three agents, with a record each, a key pair each and a token each, and a subagent that is the agent could sign its own
 * delegation. A setting that is not set, or holds no DID, is not compared: the reader of that setting refuses it by its own name.
 */
function refuseSameAgent(env: NodeJS.ProcessEnv, name: string, did: Did, others: readonly string[]): void {
  for (const other of others) {
    const text = given(env[other]);
    if (text !== '' && readDid(text) === did) throw new Error(`environment variable ${name} names the same agent as ${other}: the agent and its two subagents are three agents`);
  }
}

/** The DID of the Prior Authorization Agent: the delegate that the delegation of a hirer names. */
export function agentDidOf(env: NodeJS.ProcessEnv): Did {
  return didOf('AGENT_DID', requiredEnv('AGENT_DID', env.AGENT_DID, 'the DID of the Prior Authorization Agent: the delegate that the delegation of a hirer names'));
}

/** The DID of the subagent `record-reader`: the agent that reads the order and its records through a sub-delegation. It is not the agent. */
export function recordReaderDidOf(env: NodeJS.ProcessEnv): Did {
  const did = didOf('RECORD_READER_DID', requiredEnv('RECORD_READER_DID', env.RECORD_READER_DID, 'the DID of the subagent record-reader, which reads the records of an order through a sub-delegation'));
  refuseSameAgent(env, 'RECORD_READER_DID', did, ['AGENT_DID']);
  return did;
}

/** The DID of the subagent `drafter`: the agent that reads the guideline through a sub-delegation. It is neither the agent nor record-reader: the three DIDs are different. */
export function drafterDidOf(env: NodeJS.ProcessEnv): Did {
  const did = didOf('DRAFTER_DID', requiredEnv('DRAFTER_DID', env.DRAFTER_DID, 'the DID of the subagent drafter, which reads the guideline through a sub-delegation'));
  refuseSameAgent(env, 'DRAFTER_DID', did, ['AGENT_DID', 'RECORD_READER_DID']);
  return did;
}

/**
 * The fault switch, made one time at the start. The setting is empty or not set, or it is the one fault value of this agent: any other value stops the start. The kit decides what the kind accepts, and the
 * message gives the length of the value and never the value.
 */
export function faultOf(env: NodeJS.ProcessEnv): FaultSwitch<typeof KIND> {
  const value = env.FAULT_MODE;
  if (!parseFaultSetting(KIND, value).ok) {
    const allowed = FAULT_MODES[KIND].map((mode) => JSON.stringify(mode)).join(' or ');
    throw new Error(`environment variable FAULT_MODE must be empty or ${allowed} for ${KIND}, and it has ${typeof value === 'string' ? value.length : 0} characters`);
  }
  return readFaultSwitch(KIND, value);
}

export function portOf(env: NodeJS.ProcessEnv): number {
  const text = given(env.PORT);
  const port = wholeNumberOf('PORT', text, PORT_DEFAULT);
  if (port > 65_535) throw new Error(`environment variable PORT must be a port from 0 to 65535, and it has ${text.length} characters`);
  return port;
}

export function hostOf(env: NodeJS.ProcessEnv): string {
  const host = given(env.HOST) || HOST_DEFAULT;
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(host)) throw new Error(`environment variable HOST must be an address or a host name, and it has ${host.length} characters`);
  return host;
}

/**
 * The folder of the state: an absolute path. The default is the volume of the compose file. A relative path would stand inside the image, and a new image would lose the state: the keys of the paying wallets, the
 * counter of the request numbers, the list of sub-delegations that a job left, the journal of the challenges and the register of the transactions that the co-sign route signed.
 */
export function stateDirOf(env: NodeJS.ProcessEnv): string {
  const dir = given(env.PRIORAUTH_STATE_DIR) || STATE_DIR_DEFAULT;
  if (!dir.startsWith('/')) throw new Error(`environment variable PRIORAUTH_STATE_DIR must be an absolute path, and it has ${dir.length} characters`);
  return dir;
}

// --- the numbers of the advert ---------------------------------------------------------------------------------------------------------------------------

/** The window that the advert gives a job: from MIN_PROCESSING_WINDOW_MS to MAX_PROCESSING_WINDOW_MS. The manifest publishes it. */
export function processingWindowOf(env: NodeJS.ProcessEnv): number {
  const ms = wholeNumberOf('ADVERT_MAX_PROCESSING_MS', given(env.ADVERT_MAX_PROCESSING_MS), MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(
      `environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of ${MIN_PROCESSING_WINDOW_MS / 60_000} min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes)`,
    );
  }
  if (ms > MAX_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at most ${MAX_PROCESSING_WINDOW_MS} (24 h, the longest window that a Post accepts)`);
  }
  return ms;
}

/** The price of the advert, in lovelace: a whole number of more than 0, and at most MAX_PRICE_LOVELACE. The two bonds are fixed. */
export function priceOf(env: NodeJS.ProcessEnv): number {
  const text = given(env.ADVERT_PRICE_LOVELACE);
  if (text === '') return PRICE_DEFAULT_LOVELACE;
  const price = lovelaceOf('ADVERT_PRICE_LOVELACE', text);
  if (price > BigInt(MAX_PRICE_LOVELACE)) {
    throw new Error(`environment variable ADVERT_PRICE_LOVELACE must be at most ${MAX_PRICE_LOVELACE} (with both bonds, the lock of an escrow stays inside its value cap of ${MAX_ESCROW_LOVELACE} lovelace)`);
  }
  return Number(price);
}

// --- the supplier key (public values) --------------------------------------------------------------------------------------------------------------------

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
    throw new Error(
      'environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. '
      + 'Both are published, so they must come from the same key pair, and the public key line must not hold a private key',
    );
  }
  return { pkh, pubKeyHex };
}

// --- the endpoints, the mock service, the Module-1 manifest ----------------------------------------------------------------------------------------------

/** An https origin: no user, no path, no query and no fragment. Gives the origin and its host (with the port when it is not the default one). */
export function httpsOriginOf(name: string, value: string): { readonly origin: string; readonly host: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`environment variable ${name} must be an https origin such as https://host.example, and it has ${value.length} characters`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || value.endsWith('//')) {
    throw new Error(`environment variable ${name} must be an https origin with no user, path, query or fragment, and it has ${value.length} characters`);
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
 * The endpoints of the chain, the identity gateway and the indexer. `VECTOR_OGMIOS_URL` must be an https address: the janitor of each paying key makes its reader of the tip, `tipSlotOf`, from it at its first
 * pass, and that reader takes https only, so an http address would pass the start and fail at that pass, and a left sub-delegation would stay on the list for ever.
 */
export function endpointsFromEnv(env: NodeJS.ProcessEnv): Endpoints {
  const indexer = given(env.VECTOR_MARKETPLACE_INDEXER_URL);
  const ogmiosUrl = addressOf('VECTOR_OGMIOS_URL', given(env.VECTOR_OGMIOS_URL), VECTOR_OGMIOS_URL);
  if (new URL(ogmiosUrl).protocol !== 'https:') {
    throw new Error(`environment variable VECTOR_OGMIOS_URL must be an https address: the tip reader of the janitor takes https only, and it has ${ogmiosUrl.length} characters`);
  }
  return {
    gatewayUrl: httpsOriginOf('IDENTITY_GATEWAY_URL', given(env.IDENTITY_GATEWAY_URL) || GATEWAY_DEFAULT).origin,
    ogmiosUrl,
    koiosUrl: addressOf('VECTOR_KOIOS_URL', given(env.VECTOR_KOIOS_URL), VECTOR_KOIOS_URL),
    submitUrl: addressOf('VECTOR_SUBMIT_URL', given(env.VECTOR_SUBMIT_URL), VECTOR_SUBMIT_URL),
    indexerUrl: indexer === '' ? undefined : addressOf('VECTOR_MARKETPLACE_INDEXER_URL', indexer, indexer),
  };
}

/** A whole segment of 40 lowercase hex characters: the full commit of a Git host. */
const COMMIT_SEGMENT = /^[0-9a-f]{40}$/;

/**
 * The address of the Module-1 deployment manifest, which the wiring fetches one time at the start: an https URL pinned to a commit. One segment of its path is the 40 lowercase hex characters of the commit, as in
 * https://raw.githubusercontent.com/<owner>/<repository>/<commit>/<path>. The manifest sets the parameters that a challenge must agree with, and a branch or a tag can change after the operator checked it, so a
 * file path, an http address, an address with a user, a query or a fragment, and an address that names no commit are refused. The check reads the path that the fetch takes (`URL` takes the dot segments out). A
 * message names the setting and gives the length of the value, never the value: an address can carry a user, a password or a key in a query.
 */
export function module1SourceOf(env: NodeJS.ProcessEnv): string {
  const value = requiredEnv('VECTOR_MODULE1_MANIFEST', env.VECTOR_MODULE1_MANIFEST, 'the https URL of the Module-1 deployment manifest, pinned to a commit, which the dispute code fetches one time at start');
  let url: URL | null = null;
  if (value.startsWith('https://')) {
    try {
      url = new URL(value);
    } catch {
      // Not an address: the message below says so, and it never shows the value.
    }
  }
  if (url === null || url.username !== '' || url.password !== '' || /[?#]/.test(value)) {
    throw new Error(`environment variable VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment, and it has ${value.length} characters`);
  }
  if (!url.pathname.split('/').some((segment) => COMMIT_SEGMENT.test(segment))) {
    throw new Error(
      'environment variable VECTOR_MODULE1_MANIFEST must be pinned to a commit: one segment of its path must be the 40 lowercase hex characters of the commit, '
      + `because a branch or a tag can change after the manifest was checked. It has ${value.length} characters`,
    );
  }
  return value;
}

// --- the limits of the two kinds of hire, the dispute, the co-signature ----------------------------------------------------------------------------------

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

/** The three limits of the hire of the Insurer Intake Agent: the price and each bond. All three are required, and each is a bigint of more than 0. */
export function handoffLimitsOf(env: NodeJS.ProcessEnv): HireLimits {
  const price = lovelaceOf('HANDOFF_MAX_PRICE_LOVELACE', requiredEnv('HANDOFF_MAX_PRICE_LOVELACE', env.HANDOFF_MAX_PRICE_LOVELACE, 'the most that the price of the advert of the Insurer Intake Agent may be, in lovelace'));
  const supplierBond = lovelaceOf(
    'HANDOFF_MAX_SUPPLIER_BOND_LOVELACE',
    requiredEnv('HANDOFF_MAX_SUPPLIER_BOND_LOVELACE', env.HANDOFF_MAX_SUPPLIER_BOND_LOVELACE, 'the most that the supplier bond of the advert of the Insurer Intake Agent may be, in lovelace'),
  );
  const buyerBond = lovelaceOf(
    'HANDOFF_MAX_BUYER_BOND_LOVELACE',
    requiredEnv('HANDOFF_MAX_BUYER_BOND_LOVELACE', env.HANDOFF_MAX_BUYER_BOND_LOVELACE, 'the most that the buyer bond of the advert of the Insurer Intake Agent may be, in lovelace'),
  );
  const checked = checkHireLimits({ maxPriceLovelace: price, maxSupplierBondLovelace: supplierBond, maxBuyerBondLovelace: buyerBond });
  if (!checked.ok) throw new Error(`the limits of the hire of the Insurer Intake Agent are refused: ${checked.detail}`);
  return checked.value;
}

/**
 * The settings of the dispute code. The stake, the least window left and the bound of a read are required. The lease of an unfinished challenge and the resolution deadline are optional: the deadline must be
 * the one of the Module-1 deployment, and the wiring checks that when it reads the deployment.
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
 * not set, or is blank, takes the default of the kit. The kit gives a typed refusal for a wrong value, and the start stops with its detail, which names the setting and never shows a value. A detail about the
 * allowlist names the list, so the message adds the name of the setting.
 */
export function cosignSettingsOf(env: NodeJS.ProcessEnv): CosignSettings {
  const limit = (name: string): string | undefined => (given(env[name]) === '' ? undefined : given(env[name]));
  const parsed = parseCosignSettings({
    [COSIGN_SETTINGS.allowlist]: env.COSIGN_ALLOWLIST,
    [COSIGN_SETTINGS.maxConcurrent]: limit('COSIGN_MAX_CONCURRENT'),
    [COSIGN_SETTINGS.maxFutureMs]: limit('COSIGN_MAX_FUTURE_MS'),
    [COSIGN_SETTINGS.ledgerTimeoutMs]: limit('COSIGN_LEDGER_TIMEOUT_MS'),
  });
  if (!parsed.ok) {
    const named = parsed.detail.includes('COSIGN_') ? parsed.detail : `${parsed.detail}. The setting is ${COSIGN_SETTINGS.allowlist}`;
    throw new Error(`the settings of the co-sign route are refused: ${named}`);
  }
  return parsed.value;
}
