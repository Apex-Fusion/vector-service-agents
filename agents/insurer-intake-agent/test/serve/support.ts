// agents/insurer-intake-agent/test/serve/support.ts
// What the tests of the serve folder share: the stand-in keys, a complete environment, a clock that moves by hand, and a few helpers. A key and a token are made at run time from a label, so that none is written in
// the repository. No test of this folder uses the network, and no key is real. The environment holds the settings that need no key and no identity deployment: the start adds the key and the identity names.
import { createHash } from 'node:crypto';
import { FakeChain } from '@vsa/buyer-core';
import { T0, stubKey } from '@vsa/hire-kit/testing';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A key made from `label`: its 32 raw bytes are the SHA-256 of the label, which is also how `stubKey` makes the public key and the key hash. */
export const standInKey = (label: string) => ({ privateKeyHex: sha256(label), ...stubKey(label) });

/** The service key of the tests: the key that the service pays with and that signs its requests for a JWT-SVID. */
export const SERVICE = standInKey('insurer intake settings test: the service key');
/** The supplier key of the tests. It is the key of the runtime, and the service holds its public values only. */
export const SUPPLIER = standInKey('insurer intake settings test: the supplier key of the runtime');
/** A key that is no key of the service. */
export const OTHER = standInKey('insurer intake settings test: another key');
/** The mainnet enterprise address of the service key. */
export const SERVICE_ADDRESS = new FakeChain({ buyerPkh: SERVICE.pkh }).address;

export const AGENT_DID = `did:vector:${sha256('insurer intake settings test: the agent')}`;
/** The value that the runtime sends as the authorization header of every call to the service: "Bearer " and 64 hex characters. */
export const TOKEN = `Bearer ${sha256('insurer intake settings test: the token of the runtime')}`;
/** An identity policy in its form (56 hex characters). It is the policy of no deployment. */
export const POLICY = sha256('insurer intake settings test: the identity policy').slice(0, 56);
export const CONTACT = 'ops@example.test';

/**
 * The pinned address of the Module-1 manifest that the tests give the service: an https URL with the 40 hex characters of a commit as a segment of its path. The host is an IP literal of the range for documentation,
 * so that a fetch of the manifest needs no lookup of a name.
 */
export const MODULE1_COMMIT = sha256('insurer intake settings test: the commit of the Module-1 manifest').slice(0, 40);
export const MODULE1_URL = `https://203.0.113.9/modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;

/** What an operator sets for a full deployment, and nothing else: every other setting has a default or is optional. */
export const FULL_ENV: Readonly<Record<string, string>> = {
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  IDENTITY_POLICY_ID: POLICY,
  SERVICE_AUTH_HEADER: TOKEN,
  SUPPLIER_PKH: SUPPLIER.pkh,
  SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex,
  INTAKE_SERVICE_PKH: SERVICE.pkh,
  VECTOR_MODULE1_MANIFEST: MODULE1_URL,
  MOCK_PUBLIC_BASE: 'https://mock.example.test',
  MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
  DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
  DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
  DISPUTE_READ_TIMEOUT_MS: '20000',
};

/** The environment with some settings replaced. A value of `undefined` takes the setting away. */
export function envWith(over: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...FULL_ENV };
  for (const [name, value] of Object.entries(over)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** The text of the error that `work` throws. A call that does not throw fails the test. */
export function message(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('it was accepted');
}

/**
 * Does `text` show `value`? A value of digits only is shown when its number stands in the text as a whole number: the text "from 500 to 1499" does not show 499. A longer value is shown when any run of 12 of its
 * characters stands in the text, in any case, so a message that repeats a part of it is found too. A value of fewer than 3 characters is never counted: it stands in any text by chance.
 */
export function shows(text: string, value: string): boolean {
  if (value.length < 3) return false;
  if (/^\d+$/.test(value)) {
    const numbers: string[] = text.match(/\d+/g) ?? [];
    return numbers.includes(value);
  }
  const lower = text.toLowerCase();
  const run = Math.min(value.length, 12);
  for (let at = 0; at + run <= value.length; at += 1) if (lower.includes(value.slice(at, at + run).toLowerCase())) return true;
  return false;
}

/** A clock that moves only when a test moves it, in milliseconds since the epoch. `now` is an arrow function, so a test can pass it as a bare function. */
export class FakeClock {
  #now: number;

  constructor(start: number = T0) {
    this.#now = start;
  }

  readonly now = (): number => this.#now;

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('a clock moves forward by a whole number of milliseconds');
    this.#now += ms;
  }

  /** Waits for no time at all: the clock moves by `ms` and the promise is done. */
  sleep(ms: number): Promise<void> {
    this.advance(ms);
    return Promise.resolve();
  }
}
