// agents/insurer-intake-agent/src/serve/settings.ts
// The settings of the Insurer Intake Agent that name no key. Each reader takes the environment (or one value of it), checks what it reads, and throws an Error that names the setting. A message never shows a value:
// it gives the length of the value, because a key or a token can stand in the wrong line of a file. The settings that name a key are read in start.ts only.
//
// The time of the hook. The runtime asks the hook before it claims an escrow, and it waits 10 seconds for the answer. The hook makes six timed reads one after the other: the identity gateway once, and the
// ledger five times. Each read ends inside CHECKS_READ_BUDGET_MS, so the hook takes at most six times that. A budget whose six reads could last 9 seconds or more stops the start: the runtime would read the
// silence as a refusal, and a go would reach no one.
//
// The agent has no limit with a default. The three limits of a model hire (the price and each bond), the models, and the settings of the dispute code are required: a limit that is not set is never "no limit".
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { envInt, given, hexOf, requiredEnv } from '@vsa/service-kit';
import type { MockBases } from '@vsa/usecase-kit/access';
import { checkLimits, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings } from '@vsa/usecase-kit/dispute';
import { parseFaultSetting, readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex, manifestDid } from '@vsa/vector-read';

export const PORT_DEFAULT = 9104;
export const HOST_DEFAULT = '0.0.0.0';
/** Where the state is kept unless INTAKE_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';

/** The deadline of a job: 300 s after its request arrives. The runtime waits 60 s longer (`SERVICE_TIMEOUT_MS` is 360000), and the window of the advert is 480000 ms. */
export const JOB_DEADLINE_MS = 300_000;
/** The least window of the advert (ADVERT_MAX_PROCESSING_MS) and its default: the deadline of a job and the timeout of the runtime fit inside it. */
export const MIN_PROCESSING_WINDOW_MS = 480_000;
/** The longest time of one call to the insurer portal. The read of the requirements and the filing of the request fit the deadline of the job. */
export const CALL_TIMEOUT_MS = 20_000;

/** The price of the advert unless ADVERT_PRICE_LOVELACE says another: 2 units. */
export const PRICE_DEFAULT_LOVELACE = 2_000_000;
/** The two bonds of the advert, in lovelace. The lock of the escrow is the price and both bonds: 4 units for the default price. */
export const SUPPLIER_BOND_LOVELACE = 1_000_000;
export const BUYER_BOND_LOVELACE = 1_000_000;

/** How long the runtime waits for the hook, in milliseconds. */
export const RUNTIME_PRECHECK_WAIT_MS = 10_000;
/** The timed reads of the hook, one after the other: the gateway once and the ledger five times. */
export const HOOK_READS = 6;
/** The reads of the hook must add up to less than this: 9 seconds, which leaves a second of the 10 for the rest of the hook. */
export const HOOK_READS_LIMIT_MS = 9_000;
export const CHECKS_READ_BUDGET_DEFAULT_MS = 1_200;
export const CHECKS_READ_BUDGET_MIN_MS = 500;
/** The widest budget of one read whose six reads stay under HOOK_READS_LIMIT_MS: 1499. */
export const CHECKS_READ_BUDGET_MAX_MS = Math.floor((HOOK_READS_LIMIT_MS - 1) / HOOK_READS);

/** The least window left in the challenge window of a claim that the dispute code takes, as the dispute code holds it. */
const LEAST_WINDOW_LEFT_MS = 2_000;

/** The kind of this agent in the tables of the kit. */
const KIND = 'insurer-intake-agent';

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

// --- the DID, the fault switch, the listener and the state -----------------------------------------------------------------------------------------------

/** The DID of the Insurer Intake Agent, in its canonical form: the insurer that a request must name, and the agent whose key asks for the JWT-SVID. */
export function agentDidOf(env: NodeJS.ProcessEnv): Did {
  const text = requiredEnv('AGENT_DID', env.AGENT_DID, 'the DID of the Insurer Intake Agent: the insurer that a request must name');
  let canonical = text;
  try {
    canonical = manifestDid(text);
  } catch {
    // The message of the helper repeats the value. The message below gives its length.
  }
  const parsed = parseDid(canonical, 'AGENT_DID');
  if (!parsed.ok) throw new Error(`environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has ${text.length} characters`);
  return parsed.value;
}

/**
 * The fault switch, made one time at the start. The Insurer Intake Agent has no fault value, so the setting must be empty or not set: any other value stops the start. The kit decides what the kind accepts, and
 * the message gives the length of the value and never the value.
 */
export function faultOf(env: NodeJS.ProcessEnv): FaultSwitch<typeof KIND> {
  const value = env.FAULT_MODE;
  if (!parseFaultSetting(KIND, value).ok) {
    throw new Error(`environment variable FAULT_MODE must be empty (${KIND} has no fault value) for ${KIND}, and it has ${typeof value === 'string' ? value.length : 0} characters`);
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
 * The folder of the state: an absolute path. The default is the volume of the compose file. A relative path would stand inside the image, and a new image would lose the state: the book of the request numbers,
 * the keys of the paying wallet and the journal of the challenges.
 */
export function stateDirOf(env: NodeJS.ProcessEnv): string {
  const dir = given(env.INTAKE_STATE_DIR) || STATE_DIR_DEFAULT;
  if (!dir.startsWith('/')) throw new Error(`environment variable INTAKE_STATE_DIR must be an absolute path, and it has ${dir.length} characters`);
  return dir;
}

// --- the time of the hook, the numbers of the advert -----------------------------------------------------------------------------------------------------

/**
 * The budget of one timed read of the hook: a whole number of milliseconds from CHECKS_READ_BUDGET_MIN_MS to CHECKS_READ_BUDGET_MAX_MS. The upper end is the widest budget whose six reads stay under
 * HOOK_READS_LIMIT_MS, so one range holds both rules, and the message names that range. Any other value stops the start.
 */
export function checksReadBudgetOf(env: NodeJS.ProcessEnv): number {
  const ms = wholeNumberOf('CHECKS_READ_BUDGET_MS', given(env.CHECKS_READ_BUDGET_MS), CHECKS_READ_BUDGET_DEFAULT_MS);
  const range = `environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}`;
  if (ms < CHECKS_READ_BUDGET_MIN_MS) throw new Error(range);
  if (ms > CHECKS_READ_BUDGET_MAX_MS) {
    throw new Error(
      `${range}: the hook makes ${HOOK_READS} timed reads one after the other, and the runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for it, `
      + `so ${HOOK_READS} times the budget must be under ${HOOK_READS_LIMIT_MS} ms`,
    );
  }
  return ms;
}

/** The window that the advert gives a job: at least MIN_PROCESSING_WINDOW_MS. The manifest publishes it. */
export function processingWindowOf(env: NodeJS.ProcessEnv): number {
  const ms = wholeNumberOf('ADVERT_MAX_PROCESSING_MS', given(env.ADVERT_MAX_PROCESSING_MS), MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(
      `environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of ${MIN_PROCESSING_WINDOW_MS / 60_000} min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes)`,
    );
  }
  return ms;
}

/** The price of the advert, in lovelace: a whole number of more than 0. The two bonds are fixed. */
export function priceOf(env: NodeJS.ProcessEnv): number {
  const text = given(env.ADVERT_PRICE_LOVELACE);
  return text === '' ? PRICE_DEFAULT_LOVELACE : Number(lovelaceOf('ADVERT_PRICE_LOVELACE', text));
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

/** The two origins of the mock service: the host of tokens and JWT-SVIDs, and the host that asks for a client certificate. They are two hosts. */
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
 * The endpoints of the chain, the identity gateway and the indexer. `VECTOR_OGMIOS_URL` must be an https address: the janitor of the paying key makes its reader of the tip, `tipSlotOf`, from it at its first pass,
 * and that reader takes https only, so an http address would pass the start and fail at that pass, and an escrow that a run left would stay on the list for ever.
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

// --- the limits of the model hire, the dispute -----------------------------------------------------------------------------------------------------------

/**
 * The two limits of a model hire that the manifest publishes: the models and the price ceiling. Both are required. The manifest publishes the ceiling as a number of lovelace of 1 or more, so a ceiling of 0
 * stops the start here.
 */
export function modelOf(env: NodeJS.ProcessEnv): { readonly allowlist: readonly string[]; readonly maxPriceLovelace: bigint } {
  const allowlist = parseModelAllowlist(requiredEnv('LLM_MODEL_ALLOWLIST', env.LLM_MODEL_ALLOWLIST, 'the models that the service may hire for its decision, in order of preference'));
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
