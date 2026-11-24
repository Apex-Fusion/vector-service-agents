// agents/bid-desk/src/serve/settings.ts
// The settings of the Bid Desk that name no key. Each reader takes the environment (or one value of it), checks what it reads, and throws an Error that names the variable. A message never shows a value
// that could be a secret: it shows a short plain value, or the length of the value (`shown` of the service kit), and the readers of text settings that this file adds show the length only. The settings that
// name a key are read in start.ts only.
//
// One code base serves three Bid Desks. BID_DESK_INSTANCE says which of the three this deployment is: it selects the price list file and the name of the agent. The organisation, the DID, the keys and the
// public origin are settings of each deployment. A Bid Desk is not buyer-side: it reads no mock base, no Module-1 manifest and no dispute setting.
//
// The time of the hook. The runtime asks the hook before it claims an escrow, and it waits 10 seconds for the answer. The hook makes four timed reads one after the other: the identity gateway once, and the
// ledger three times. Each read ends inside CHECKS_READ_BUDGET_MS, so the hook takes at most four times that. A budget whose four reads could last 9 seconds or more stops the start: the runtime would read
// the silence as a refusal, and a go would reach no one.
import { fileURLToPath } from 'node:url';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@vsa/buyer-core';
import { envInt, given, hexOf, requiredEnv, shown } from '@vsa/service-kit';
import { checkLimits, parseMaxPrice, parseModelAllowlist } from '@vsa/usecase-kit/decision';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { parseDid } from '@vsa/usecase-kit/protocol';
import type { Did } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex, manifestDid } from '@vsa/vector-read';

export const PORT_DEFAULT = 9106;
export const HOST_DEFAULT = '0.0.0.0';
/** Where the state is kept unless BID_DESK_STATE_DIR says otherwise: the volume of the compose file. */
export const STATE_DIR_DEFAULT = '/data';
export const GATEWAY_DEFAULT = 'https://id.vector.apexfusion.org';

/** The three Bid Desks of this code base, in the order of the pages. */
export const INSTANCES = ['alfa', 'bravo', 'charlie'] as const;
export type Instance = (typeof INSTANCES)[number];
/** The name of each Bid Desk: the `name` of its manifest. */
export const INSTANCE_NAMES: Readonly<Record<Instance, string>> = { alfa: 'Bid Desk Alfa', bravo: 'Bid Desk Bravo', charlie: 'Bid Desk Charlie' };

/** The public route of the price list. The service serves the bytes of its file there, and its manifest holds their SHA-256. */
export const PRICE_LIST_ROUTE = '/price-list.json';

/** The price of a job and the supplier bond and the buyer bond of an advert, in lovelace. The buyer locks the price and both bonds: 3 million. */
export const PRICE_LOVELACE = 1_000_000;
export const BOND_LOVELACE = 1_000_000;

/** The deadline of a job: 300 s after its request arrives. The runtime waits 60 s longer (`SERVICE_TIMEOUT_MS` is 360000), and the window of the advert is 480000 ms. */
export const JOB_DEADLINE_MS = 300_000;
/** The least window of the advert (ADVERT_MAX_PROCESSING_MS) and its default: the deadline of a job and the timeout of the runtime fit inside it. */
export const MIN_PROCESSING_WINDOW_MS = 480_000;
/**
 * The longest window of the advert: 24 hours. A Post of the marketplace refuses an advert with a longer window (buyer-core does not export its ceiling, so the number is written here, and a test plans a Post at
 * this window and one millisecond above it). An advert that nobody can hire is no advert.
 */
export const MAX_PROCESSING_WINDOW_MS = 86_400_000;
/** The longest time of one call to the identity gateway for the credential of the desk. It is the one timeout of that read, and it fits the deadline of the job. */
export const CALL_TIMEOUT_MS = 20_000;

/** How long the runtime waits for the hook, in milliseconds. */
export const RUNTIME_PRECHECK_WAIT_MS = 10_000;
/** The timed reads of the hook, one after the other: the gateway once and the ledger three times. */
export const HOOK_READS = 4;
/** The reads of the hook must add up to less than this: 9 seconds, which leaves a second of the 10 for the rest of the hook. */
export const HOOK_READS_LIMIT_MS = 9_000;
export const CHECKS_READ_BUDGET_DEFAULT_MS = 1_200;
export const CHECKS_READ_BUDGET_MIN_MS = 500;
/** The widest budget of one read whose four reads stay under HOOK_READS_LIMIT_MS: 2249. */
export const CHECKS_READ_BUDGET_MAX_MS = Math.floor((HOOK_READS_LIMIT_MS - 1) / HOOK_READS);

const isInstance = (value: unknown): value is Instance => (INSTANCES as readonly unknown[]).includes(value);

/** A label of a domain name: lower-case letters, digits and hyphens, from 1 to 63 characters, with no hyphen at either end. */
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** An https origin: no user, no path, no query and no fragment. Gives the origin as the URL parser writes it. A message gives the length of the value and never the value. */
function httpsOriginOf(name: string, value: string): string {
  let url: URL | null = null;
  try {
    url = new URL(value);
  } catch {
    // Not an address: the message below says so, and it never shows the value.
  }
  if (url === null || url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.pathname !== '/' || /[?#]/.test(value)) {
    throw new Error(`environment variable ${name} must be an https origin with no user, path, query or fragment, and it has ${value.length} characters`);
  }
  return url.origin;
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

// --- the instance, its price list, its organisation and its host ---------------------------------------------------------------------------------------

/** Which of the three Bid Desks this deployment is. Any other value, and an empty value, stops the start. */
export function instanceOf(env: NodeJS.ProcessEnv): Instance {
  const value = requiredEnv('BID_DESK_INSTANCE', env.BID_DESK_INSTANCE, 'which of the three Bid Desks this deployment is: alfa, bravo or charlie');
  if (!isInstance(value)) throw new Error(`environment variable BID_DESK_INSTANCE must be alfa, bravo or charlie, and it has ${value.length} characters`);
  return value;
}

/** The price list file of an instance: `price-lists/<instance>.json` of the package. The file name is made from one of the three words only. */
export function priceListFileOf(instance: Instance): string {
  if (!isInstance(instance)) throw new TypeError('the instance of a Bid Desk is alfa, bravo or charlie');
  return fileURLToPath(new URL(`../../price-lists/${instance}.json`, import.meta.url));
}

/**
 * The domain of the organisation of this instance, as its record names it: a name in lower case of at most 64 characters with at least two labels, the form of the organisation in the sourcing record of the
 * mock service.
 */
export function organisationOf(env: NodeJS.ProcessEnv): string {
  const name = requiredEnv('BID_DESK_ORGANISATION', env.BID_DESK_ORGANISATION, 'the domain of the organisation of this Bid Desk, as its record names it');
  const labels = name.split('.');
  if (name.length > 64 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    throw new Error(`environment variable BID_DESK_ORGANISATION must be a domain name in lower case with at least two labels and at most 64 characters, and it has ${name.length} characters`);
  }
  return name;
}

/** The origin of the host of this instance. It serves the price list at `<origin>/price-list.json`, and the record of the agent names it as the endpoint. */
export function publicOriginOf(env: NodeJS.ProcessEnv): string {
  return httpsOriginOf('BID_DESK_PUBLIC_ORIGIN', requiredEnv('BID_DESK_PUBLIC_ORIGIN', env.BID_DESK_PUBLIC_ORIGIN, `the https origin of the host of this Bid Desk, which serves the price list at ${PRICE_LIST_ROUTE}`));
}

// --- the DID, the fault switch, the listener and the state -----------------------------------------------------------------------------------------------

/** The DID of this Bid Desk, in its canonical form: the desk of its quotes, and the agent whose credential the job asks for. */
export function agentDidOf(env: NodeJS.ProcessEnv): Did {
  const text = requiredEnv('AGENT_DID', env.AGENT_DID, 'the DID of this Bid Desk: the desk of its quotes, and the agent whose credential the job asks for');
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

/** The fault switch, made one time at the start. The value is empty or the one fault value of the Bid Desk. Any other value stops the start. */
export function faultOf(env: NodeJS.ProcessEnv): FaultSwitch<'bid-desk'> {
  return readFaultSwitch('bid-desk', env.FAULT_MODE);
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
  return given(env.BID_DESK_STATE_DIR) || STATE_DIR_DEFAULT;
}

// --- the time of the hook, the window of the advert --------------------------------------------------------------------------------------------------

/**
 * The budget of one timed read of the hook: a whole number of milliseconds from CHECKS_READ_BUDGET_MIN_MS to CHECKS_READ_BUDGET_MAX_MS. The upper end is the widest budget whose four reads stay under
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

/** The window that the advert gives a job: from MIN_PROCESSING_WINDOW_MS to MAX_PROCESSING_WINDOW_MS. The manifest publishes it. */
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

// --- the supplier key (public values) ----------------------------------------------------------------------------------------------------------------

/** The public part of the supplier key: its key hash and its public key. The private key is the runtime's and never reaches this service. */
export interface SupplierKey {
  readonly pkh: string;
  readonly pubKeyHex: string;
}

/** The key hash and the public key of the supplier key. The public key must hash to the key hash beside it. */
export function supplierKeyOf(env: NodeJS.ProcessEnv): SupplierKey {
  const pkh = requiredEnv('SUPPLIER_PKH', env.SUPPLIER_PKH, 'the key hash of the supplier key of the runtime, published in the manifest');
  const pub = requiredEnv('SUPPLIER_PUB_KEY_HEX', env.SUPPLIER_PUB_KEY_HEX, 'the public key of the supplier key of the runtime, published in the manifest');
  const hash = hexOf('SUPPLIER_PKH', pkh, 28);
  const publicKey = hexOf('SUPPLIER_PUB_KEY_HEX', pub, 32);
  // The two are published side by side. A private key in the line of the public one is a likely slip, and this is what stops it.
  if (blake2b224Hex(publicKey) !== hash) {
    throw new Error('environment variable SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH: the key hash of the one is not the other. Both are published, so they must come from the same key pair, and the public key line must not hold a private key');
  }
  return { pkh: hash, pubKeyHex: publicKey };
}

// --- the endpoints ---------------------------------------------------------------------------------------------------------------------------------------

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
    gatewayUrl: httpsOriginOf('IDENTITY_GATEWAY_URL', given(env.IDENTITY_GATEWAY_URL) || GATEWAY_DEFAULT),
    ogmiosUrl: addressOf('VECTOR_OGMIOS_URL', given(env.VECTOR_OGMIOS_URL), VECTOR_OGMIOS_URL),
    koiosUrl: addressOf('VECTOR_KOIOS_URL', given(env.VECTOR_KOIOS_URL), VECTOR_KOIOS_URL),
    submitUrl: addressOf('VECTOR_SUBMIT_URL', given(env.VECTOR_SUBMIT_URL), VECTOR_SUBMIT_URL),
    indexerUrl: indexer === '' ? undefined : addressOf('VECTOR_MARKETPLACE_INDEXER_URL', indexer, indexer),
  };
}

// --- the limits of the model hire ----------------------------------------------------------------------------------------------------------------------

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
