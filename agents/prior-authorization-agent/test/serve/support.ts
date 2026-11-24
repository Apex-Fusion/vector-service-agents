// agents/prior-authorization-agent/test/serve/support.ts
// What the tests of the serve folder share: the seven keys of the tests, the supplier key, an environment with every setting that the readers of this folder check, a clock that moves by hand, and a reader of the
// message of an error. A key of the tests is 32 bytes of one number, which is a raw Ed25519 key, and the numbers 21, 22 and 24 are those of the fixture world of buyer-core, so that a test of the co-sign route can
// read the records that the fixture world holds for them. No test uses the network and no key is real. The environment holds no key, no name of a key variable and no name of the identity deployment: the tests of the
// start add them, in members of their own.
import { DEPLOYMENT, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import type { KeyRole } from '../../src/serve/keys.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { CONFIG_SEED } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { KEY_ROLES } from '../../src/serve/keys.ts';

/** The raw key of the number `n`: 32 bytes that all hold `n`, as 64 lower-case hex characters. */
export const rawKey = (n: number): string => Buffer.alloc(32, n).toString('hex');

/** The number of the key of each role. The numbers 21, 22 and 24 are those of the fixture world of the co-sign route: delegation 1 is key 21, delegation 2 is 22 and the service key is 24. */
export const KEY_NUMBERS: Readonly<Record<KeyRole, number>> = {
  service: 24,
  delegation1: 21,
  delegation2: 22,
  recordReaderAuthentication: 41,
  recordReaderDelegation: 42,
  drafterAuthentication: 43,
  drafterDelegation: 44,
};

/** The variable that holds the public cross-check of each key: its key hash. The manifest publishes three of them, and the start checks all seven. */
export const PKH_VARIABLES: Readonly<Record<KeyRole, string>> = {
  service: 'PRIORAUTH_SERVICE_PKH',
  delegation1: 'PRIORAUTH_DELEGATION_1_PKH',
  delegation2: 'PRIORAUTH_DELEGATION_2_PKH',
  recordReaderAuthentication: 'RECORD_READER_AUTH_PKH',
  recordReaderDelegation: 'RECORD_READER_DELEGATION_PKH',
  drafterAuthentication: 'DRAFTER_AUTH_PKH',
  drafterDelegation: 'DRAFTER_DELEGATION_PKH',
};

/** The supplier key of the tests: a public key and its key hash. The private key is the runtime's, and no test has it. */
export const SUPPLIER = testKey(23);
/** The key of the member who delegates: the principal key that the allowlist of the co-sign route holds. */
export const PRINCIPAL = testKey(31);

/** The three agents of the service, as three different DIDs: the agent and its two subagents. */
export const AGENT_DID = `did:vector:${'a1'.repeat(32)}`;
export const READER_DID = `did:vector:${'b2'.repeat(32)}`;
export const DRAFTER_DID = `did:vector:${'c3'.repeat(32)}`;
export const TOKEN = `Bearer ${'4f'.repeat(24)}`;
export const CONTACT = 'ops@example.test';

/**
 * The address of a Module-1 deployment manifest at a pinned commit. The host is an address of the range for documentation, so that the fetch of the kit needs no lookup of a name, and no test reaches it. The
 * commit is the 40 lower-case hex characters that its path holds as one segment.
 */
export const MODULE1_COMMIT = '1234567890abcdef1234567890abcdef12345678';
export const MODULE1_URL = `https://198.51.100.7/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;

/**
 * An environment with every setting that the readers of src/serve/settings.ts and the manifest builder require, and the optional ones left out. A test changes the members it needs: a value of `undefined` takes
 * the setting away. The values are those of the example environment of the pack, so a limit here is a limit that an operator sets.
 */
export function completeEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPERATOR_CONTACT: CONTACT,
    AGENT_DID,
    RECORD_READER_DID: READER_DID,
    DRAFTER_DID,
    SERVICE_AUTH_HEADER: TOKEN,
    IDENTITY_POLICY_ID: DEPLOYMENT.identity.hash,
    VECTOR_MODULE1_MANIFEST: MODULE1_URL,
    MOCK_PUBLIC_BASE: 'https://mock.example',
    MOCK_MTLS_BASE: 'https://mock-mtls.example',
    SUPPLIER_PKH: SUPPLIER.keyHash,
    SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey,
    LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
    LLM_MAX_PRICE_LOVELACE: '1000000',
    LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
    LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
    HANDOFF_MAX_PRICE_LOVELACE: '2000000',
    HANDOFF_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
    HANDOFF_MAX_BUYER_BOND_LOVELACE: '2000000',
    DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
    DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
    DISPUTE_READ_TIMEOUT_MS: '20000',
    COSIGN_ALLOWLIST: PRINCIPAL.keyHash,
    PORT: '0',
    HOST: '127.0.0.1',
    ...over,
  };
}

/** The message of the error that `work` throws. The test fails when it throws nothing. */
export function messageOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the call did not throw');
}

/**
 * Does `text` show `value`? A value of digits only is shown when its number stands in the text as a whole number: the text "from 500 to 1499" does not show 499. A longer value is shown when any
 * run of 12 of its characters stands in the text, in any case, so a message that repeats a part of it is found too. A value of fewer than 3 characters is never counted: it stands in any text by chance.
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

  constructor(start = 1_790_000_000_000) {
    this.#now = start;
  }

  readonly now = (): number => this.#now;

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('a clock moves forward by a whole number of milliseconds');
    this.#now += ms;
  }
}

// --- what the tests of the start and of the wiring add: the key variables, the identity deployment, the Module-1 manifest and the state directories -------------

/** The variable that holds the private key of each role. Only the start names these variables, and the tests name them here so that an environment can be made. */
export const KEY_VARIABLES: Readonly<Record<KeyRole, string>> = {
  service: 'PRIORAUTH_SERVICE_PRIV_KEY_HEX',
  delegation1: 'PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX',
  delegation2: 'PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX',
  recordReaderAuthentication: 'RECORD_READER_AUTH_PRIV_KEY_HEX',
  recordReaderDelegation: 'RECORD_READER_DELEGATION_PRIV_KEY_HEX',
  drafterAuthentication: 'DRAFTER_AUTH_PRIV_KEY_HEX',
  drafterDelegation: 'DRAFTER_DELEGATION_PRIV_KEY_HEX',
};

/** The Module-1 manifest of the fixture world of buyer-core: the file that a fetch stub serves at MODULE1_URL. */
export const MODULE1_FIXTURE = fileURLToPath(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url));

/** The Module-1 manifest of the fixture world as the text that a fetch stub serves. The default names the identity registry of the deployment of the tests, so the manifest is the one of this service. */
export function module1ManifestText(identityHash: string = DEPLOYMENT.identity.hash): string {
  const manifest = JSON.parse(readFileSync(MODULE1_FIXTURE, 'utf8')) as { identity: { identity_hash: string } };
  manifest.identity.identity_hash = identityHash;
  return JSON.stringify(manifest, null, 2);
}
export const MODULE1_TEXT = module1ManifestText();

/** A fetch that answers MODULE1_URL with the fixture manifest, and gives every other call to `next`. */
export function withModule1(next: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => (String(input) === MODULE1_URL ? new Response(MODULE1_TEXT, { status: 200, headers: { 'content-type': 'application/json' } }) : next(input, init))) as typeof fetch;
}

/**
 * The environment of a whole service: `completeEnv`, the four settings of the identity deployment, and the seven keys. The deployment is the one of the fixture world, so its policy is the `IDENTITY_POLICY_ID`
 * of `completeEnv`. A test changes the members it needs: a value of `undefined` takes the setting away.
 */
export function startEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return completeEnv({
    VECTOR_IDENTITY_LEGACY_ROOT: DEPLOYMENT.legacyRoot,
    VECTOR_IDENTITY_CONFIG_SEED: `${CONFIG_SEED.txHash}#${CONFIG_SEED.outputIndex}`,
    VECTOR_IDENTITY_ESCROW_REF_UTXO: `${'e0'.repeat(32)}#4`,
    VECTOR_IDENTITY_VAULT_REF_UTXO: `${'e0'.repeat(32)}#3`,
    ...Object.fromEntries(KEY_ROLES.map((role) => [KEY_VARIABLES[role], rawKey(KEY_NUMBERS[role])])),
    ...over,
  });
}

/** Every secret of an environment, as the texts that must stand in no log, no manifest, no answer and no detail: each key in its hex and bech32 forms, and the token with its credential. */
export function secretsOf(env: NodeJS.ProcessEnv = startEnv()): string[] {
  const keys = KEY_ROLES.map((role) => String(env[KEY_VARIABLES[role]]));
  return [...keys, ...keys.map((key) => rawHexToBech32(key)), String(env.SERVICE_AUTH_HEADER), String(env.SERVICE_AUTH_HEADER).slice('Bearer '.length)];
}

const dirs: string[] = [];
/** A new folder for a state directory. Each test file calls `cleanDirs` in `afterEach`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'prior-serve-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
