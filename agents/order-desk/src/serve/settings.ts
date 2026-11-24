// agents/order-desk/src/serve/settings.ts
// The settings of the Order Desk that name no key. Each reader takes the environment (or one value of it), checks what it reads, and throws an Error that names the variable. A message never shows a value
// that could be a secret: it shows a short plain value, or the length of the value (`shown` of the service kit). The settings that name a key are read in start.ts only.
//
// The time of the hook. The runtime asks the hook before it claims an escrow, and it waits 10 seconds for the answer. The hook makes six timed reads one after the other: the identity gateway once, and the
// ledger five times. Each read ends inside CHECKS_READ_BUDGET_MS, so the hook takes at most six times that. A budget whose six reads could last 9 seconds or more stops the start: the runtime would read the
// silence as a refusal, and a go would reach no one.
import { fileURLToPath } from 'node:url';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { envInt, given, hexOf, requiredEnv, shown } from '@vsa/service-kit';
import { checkLimits, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { LEAST_RESOLUTION_DEADLINE_MS } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings } from '@vsa/usecase-kit/dispute';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { LOT_NAMES } from '@vsa/usecase-kit/inventory';
import type { LotName } from '@vsa/usecase-kit/inventory';
import { parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex, manifestDid } from '@vsa/vector-read';

export const PORT_DEFAULT = 9102;
export const HOST_DEFAULT = '0.0.0.0';
/** Where the state is kept unless ORDER_DESK_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';

/** The data file of the package: the sizes of the three lots for each SKU. The service serves its bytes at LOTS_ROUTE, and its manifest holds their SHA-256. */
export const LOTS_FILE = fileURLToPath(new URL('../../lots.json', import.meta.url));
/** The public route of the lots file. */
export const LOTS_ROUTE = '/lots.json';

/** The deadline of a job: 300 s after its request arrives. The runtime waits 60 s longer (`SERVICE_TIMEOUT_MS` is 360000), and the window of the advert is 480000 ms. */
export const JOB_DEADLINE_MS = 300_000;
/** The least window of the advert (ADVERT_MAX_PROCESSING_MS) and its default: the deadline of a job and the timeout of the runtime fit inside it. */
export const MIN_PROCESSING_WINDOW_MS = 480_000;
/**
 * The longest window of the advert: 24 hours. A Post of the marketplace refuses an advert with a longer window (buyer-core does not export its ceiling, so the number is written here, and a test plans a Post at
 * this window and one millisecond above it). An advert that nobody can hire is no advert.
 */
export const MAX_PROCESSING_WINDOW_MS = 86_400_000;
/** The longest time of one call to the supplier portal. The catalogue read, the hire of the model and the order fit the deadline of the job. */
export const CALL_TIMEOUT_MS = 20_000;

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

/** The variable that holds the key hash of the runtime of each lot, for the messages of a clash of keys. */
export const SUPPLIER_PKH_VARIABLES = { 'lot-small': 'SMALL_SUPPLIER_PKH', 'lot-medium': 'MEDIUM_SUPPLIER_PKH', 'lot-large': 'LARGE_SUPPLIER_PKH' } as const satisfies Record<LotName, string>;

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

/** A whole number of lovelace, more than 0, written in digits. */
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

// --- the DID, the fault switch, the listener and the state -----------------------------------------------------------------------------------------------

/** The DID of the Order Desk, in its canonical form: the supplier that a purchase order must name, and the agent whose key asks for the X.509-SVID. */
export function agentDidOf(env: NodeJS.ProcessEnv): Did {
  const text = requiredEnv('AGENT_DID', env.AGENT_DID, 'the DID of the Order Desk: the supplier that a purchase order must name');
  let canonical = text;
  try {
    canonical = manifestDid(text);
  } catch {
    // The message of the helper repeats the value. This one gives its length.
  }
  const parsed = parseDid(canonical, 'AGENT_DID');
  if (!parsed.ok) throw new Error(`environment variable AGENT_DID must be did:vector: and 64 lowercase hex characters, and it has ${text.length} characters`);
  return parsed.value;
}

/** The fault switch, made one time at the start. The value is empty or the one fault value of the Order Desk. Any other value stops the start. */
export function faultOf(env: NodeJS.ProcessEnv): FaultSwitch<'order-desk'> {
  return readFaultSwitch('order-desk', env.FAULT_MODE);
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
  return given(env.ORDER_DESK_STATE_DIR) || STATE_DIR_DEFAULT;
}

// --- the time of the hook, the window of the adverts --------------------------------------------------------------------------------------------------

/**
 * The budget of one timed read of the hook: a whole number of milliseconds from CHECKS_READ_BUDGET_MIN_MS to CHECKS_READ_BUDGET_MAX_MS. The upper end is the widest budget whose six reads stay under
 * HOOK_READS_LIMIT_MS, so one range holds both rules, and the message names that range. Any other value stops the start.
 */
export function checksBudgetOf(env: NodeJS.ProcessEnv): number {
  const ms = envInt('CHECKS_READ_BUDGET_MS', given(env.CHECKS_READ_BUDGET_MS), CHECKS_READ_BUDGET_DEFAULT_MS);
  const range = `environment variable CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from ${CHECKS_READ_BUDGET_MIN_MS} to ${CHECKS_READ_BUDGET_MAX_MS}, got ${ms}`;
  if (ms < CHECKS_READ_BUDGET_MIN_MS) throw new Error(range);
  if (ms > CHECKS_READ_BUDGET_MAX_MS) {
    throw new Error(
      `${range}: the hook makes ${HOOK_READS} timed reads one after the other, so it can take ${ms * HOOK_READS} ms, and the runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for it. `
      + `${HOOK_READS} times the budget must be under ${HOOK_READS_LIMIT_MS} ms`,
    );
  }
  return ms;
}

/** The window that the adverts give a job: from MIN_PROCESSING_WINDOW_MS to MAX_PROCESSING_WINDOW_MS. The manifest publishes it for each tier. */
export function processingWindowOf(env: NodeJS.ProcessEnv): number {
  const ms = envInt('ADVERT_MAX_PROCESSING_MS', given(env.ADVERT_MAX_PROCESSING_MS), MIN_PROCESSING_WINDOW_MS);
  if (ms < MIN_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at least ${MIN_PROCESSING_WINDOW_MS} (the window of ${MIN_PROCESSING_WINDOW_MS / 60_000} min that the deadline of a job, ${JOB_DEADLINE_MS} ms, assumes), got ${ms}`);
  }
  if (ms > MAX_PROCESSING_WINDOW_MS) {
    throw new Error(`environment variable ADVERT_MAX_PROCESSING_MS must be at most ${MAX_PROCESSING_WINDOW_MS} (24 h, the longest window that a Post accepts), got ${ms}`);
  }
  return ms;
}

// --- the hosts of the three runtimes, the lots file ----------------------------------------------------------------------------------------------------

/**
 * The origin of the host of each runtime, from the origin of the small runtime. The first label of that host ends in `-small`, and the host of the medium and of the large runtime is the same host with `-medium`
 * and `-large` in place of `-small`. A host that does not fit stops the start: a guess would put the endpoint of one tier in the manifest of another.
 */
export function endpointsOf(origin: string): Readonly<Record<LotName, string>> {
  const { host } = httpsOriginOf('LOTS_PUBLIC_ORIGIN', origin);
  const fit = /^([a-z0-9-]+)-small(?=[.:]|$)/.exec(host);
  if (fit === null) {
    throw new Error(
      'environment variable LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime: the first label of its host name ends in -small, as in https://orders-small.example.org. '
      + `The host names of the medium and of the large runtime are the same name with -medium and -large in place of -small, and ${shown(origin)} does not fit`,
    );
  }
  const ends: Record<string, string> = {};
  for (const lot of LOT_NAMES) ends[lot] = `https://${host.replace(/^([a-z0-9-]+)-small/, `$1-${lot.slice('lot-'.length)}`)}`;
  return ends as Record<LotName, string>;
}

/** The origin of the host of the small runtime. It serves the lots file, and the record of the agent names it as the endpoint. */
export function lotsOriginOf(env: NodeJS.ProcessEnv): string {
  const origin = httpsOriginOf('LOTS_PUBLIC_ORIGIN', requiredEnv('LOTS_PUBLIC_ORIGIN', env.LOTS_PUBLIC_ORIGIN, 'the https origin of the host of the first (small) runtime, which serves the lots file at /lots.json'));
  // The derivation of the other two hosts is checked here, so that a host that does not fit stops the start by its own name.
  endpointsOf(origin.origin);
  return origin.origin;
}

// --- the keys of the three runtimes (public values) ---------------------------------------------------------------------------------------------------

/** The public part of the key of a runtime: its key hash and its public key. The private key is the runtime's and never reaches this service. */
export interface SupplierKey {
  readonly pkh: string;
  readonly pubKeyHex: string;
}

function supplierKey(pkhName: string, pubName: string, pkh: string, pubKeyHex: string): SupplierKey {
  const hash = hexOf(pkhName, pkh, 28);
  const pub = hexOf(pubName, pubKeyHex, 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip, and this is what stops it.
  if (blake2b224Hex(pub) !== hash) {
    throw new Error(`environment variable ${pubName} is not the public key of ${pkhName}: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key`);
  }
  return { pkh: hash, pubKeyHex: pub };
}

/** The key hash and the public key of each of the three runtimes. Each public key must hash to the key hash beside it. */
export function supplierKeysOf(env: NodeJS.ProcessEnv): Readonly<Record<LotName, SupplierKey>> {
  return {
    'lot-small': supplierKey('SMALL_SUPPLIER_PKH', 'SMALL_SUPPLIER_PUB_KEY_HEX',
      requiredEnv('SMALL_SUPPLIER_PKH', env.SMALL_SUPPLIER_PKH, 'the key hash of the supplier key of the small runtime, published in the manifest'),
      requiredEnv('SMALL_SUPPLIER_PUB_KEY_HEX', env.SMALL_SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key of the small runtime, published in the manifest')),
    'lot-medium': supplierKey('MEDIUM_SUPPLIER_PKH', 'MEDIUM_SUPPLIER_PUB_KEY_HEX',
      requiredEnv('MEDIUM_SUPPLIER_PKH', env.MEDIUM_SUPPLIER_PKH, 'the key hash of the supplier key of the medium runtime, published in the manifest'),
      requiredEnv('MEDIUM_SUPPLIER_PUB_KEY_HEX', env.MEDIUM_SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key of the medium runtime, published in the manifest')),
    'lot-large': supplierKey('LARGE_SUPPLIER_PKH', 'LARGE_SUPPLIER_PUB_KEY_HEX',
      requiredEnv('LARGE_SUPPLIER_PKH', env.LARGE_SUPPLIER_PKH, 'the key hash of the supplier key of the large runtime, published in the manifest'),
      requiredEnv('LARGE_SUPPLIER_PUB_KEY_HEX', env.LARGE_SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key of the large runtime, published in the manifest')),
  };
}

// --- the endpoints, the mock service, the Module-1 manifest -------------------------------------------------------------------------------------------

/** The two origins of the mock service: the host of tokens and the host that asks for a client certificate. They are two hosts. */
export function mockBasesOf(env: NodeJS.ProcessEnv): { readonly publicBase: string; readonly mtlsBase: string } {
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

export function endpointsFromEnv(env: NodeJS.ProcessEnv): Endpoints {
  const indexer = given(env.VECTOR_MARKETPLACE_INDEXER_URL);
  return {
    gatewayUrl: httpsOriginOf('IDENTITY_GATEWAY_URL', given(env.IDENTITY_GATEWAY_URL) || GATEWAY_DEFAULT).origin,
    ogmiosUrl: addressOf('VECTOR_OGMIOS_URL', given(env.VECTOR_OGMIOS_URL), VECTOR_OGMIOS_URL),
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
 * message names the variable and gives the length of the value, never the value: an address can carry a user, a password or a key in a query.
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

// --- the limits of the model hire, the dispute ------------------------------------------------------------------------------------------------------

/**
 * The four limits of a model hire: the allowlist, the price ceiling and the limit of each bond. All four are required, and each is a number or a list that the kit takes. The service never fills in a limit
 * and never gives `null`: an operator who sets no limit has no service that hires.
 */
export function limitsOf(env: NodeJS.ProcessEnv): ModelLimits {
  const allowlist = parseModelAllowlist(requiredEnv('LLM_MODEL_ALLOWLIST', env.LLM_MODEL_ALLOWLIST, 'the models that the service may hire for its decision, in order of preference'));
  if (!allowlist.ok) throw new Error(`environment variable ${allowlist.detail}`);
  const price = parseMaxPrice(requiredEnv('LLM_MAX_PRICE_LOVELACE', env.LLM_MAX_PRICE_LOVELACE, 'the most that a model hire may be priced at, in lovelace'));
  if (!price.ok) throw new Error(`environment variable ${price.detail}`);
  if (price.value < 1n) throw new Error('environment variable LLM_MAX_PRICE_LOVELACE must be a whole number of lovelace of more than 0');
  const supplierBond = lovelaceOf('LLM_MAX_SUPPLIER_BOND_LOVELACE', requiredEnv('LLM_MAX_SUPPLIER_BOND_LOVELACE', env.LLM_MAX_SUPPLIER_BOND_LOVELACE, 'the most that the supplier bond of a model advert may be, in lovelace'));
  const buyerBond = lovelaceOf('LLM_MAX_BUYER_BOND_LOVELACE', requiredEnv('LLM_MAX_BUYER_BOND_LOVELACE', env.LLM_MAX_BUYER_BOND_LOVELACE, 'the most that the buyer bond of a model advert may be, in lovelace'));
  const checked = checkLimits({ allowlist: allowlist.value, maxPriceLovelace: price.value, maxSupplierBondLovelace: supplierBond, maxBuyerBondLovelace: buyerBond });
  if (!checked.ok) throw new Error(`the limits of the model hire are refused: ${checked.detail}`);
  return checked.value;
}

/**
 * The settings of the dispute code. The stake, the least window left and the bound of a read are required. The lease of an unfinished challenge and the resolution deadline are optional: the deadline must be
 * the one of the Module-1 deployment, and the wiring checks that when it reads the deployment.
 */
export function disputeOf(env: NodeJS.ProcessEnv): DisputeSettings {
  const stake = lovelaceOf('DISPUTE_CHALLENGE_STAKE_LOVELACE', requiredEnv('DISPUTE_CHALLENGE_STAKE_LOVELACE', env.DISPUTE_CHALLENGE_STAKE_LOVELACE, 'the stake of a challenge, in lovelace'));
  const windowLeft = millisecondsOf('DISPUTE_MIN_WINDOW_LEFT_MS', given(requiredEnv('DISPUTE_MIN_WINDOW_LEFT_MS', env.DISPUTE_MIN_WINDOW_LEFT_MS, 'the least time left in the challenge window of a claim')), LEAST_WINDOW_LEFT_MS);
  const readTimeout = millisecondsOf('DISPUTE_READ_TIMEOUT_MS', given(requiredEnv('DISPUTE_READ_TIMEOUT_MS', env.DISPUTE_READ_TIMEOUT_MS, 'the most time that one read of the dispute code may take')), 1);
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
