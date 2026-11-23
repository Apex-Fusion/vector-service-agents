// agents/reorder-agent/test/serve/support.ts
// What the tests of the serve folder share: the five keys of the tests, the supplier key, a complete environment, and a place for the state directory. A key of the tests is 32 bytes of one number, which is a raw
// Ed25519 key, and it is the key of the same number in the fixture world of buyer-core, so the co-sign route reads the records that the fixture world holds for them. No test uses the network and no key is real.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { CONFIG_SEED, DEPLOYMENT, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';

/** The raw key of the number `n`: 32 bytes that all hold `n`, as 64 lower-case hex characters. */
export const rawKey = (n: number): string => Buffer.alloc(32, n).toString('hex');

/** The five keys of the service, by the variable that holds each. The numbers are those of the fixture world of the co-sign route: delegation 1 is key 21, delegation 2 is 22 and the service key is 24. */
export const KEY_VARIABLES = {
  service: 'REORDER_SERVICE_PRIV_KEY_HEX',
  delegation1: 'REORDER_DELEGATION_1_PRIV_KEY_HEX',
  delegation2: 'REORDER_DELEGATION_2_PRIV_KEY_HEX',
  stockReaderAuthentication: 'STOCK_READER_AUTH_PRIV_KEY_HEX',
  stockReaderDelegation: 'STOCK_READER_DELEGATION_PRIV_KEY_HEX',
} as const;
export const PKH_VARIABLES = {
  service: 'REORDER_SERVICE_PKH',
  delegation1: 'REORDER_DELEGATION_1_PKH',
  delegation2: 'REORDER_DELEGATION_2_PKH',
  stockReaderAuthentication: 'STOCK_READER_AUTH_PKH',
  stockReaderDelegation: 'STOCK_READER_DELEGATION_PKH',
} as const;
export const KEY_NUMBERS = { service: 24, delegation1: 21, delegation2: 22, stockReaderAuthentication: 41, stockReaderDelegation: 42 } as const;
export type Role = keyof typeof KEY_VARIABLES;
export const ROLES = Object.keys(KEY_VARIABLES) as Role[];

/** The supplier key of the tests: a public key and its key hash. The private key is the runtime's, and no test has it. */
export const SUPPLIER = testKey(23);
/** The key of the member who delegates: the principal key that the allowlist holds. */
export const PRINCIPAL = testKey(31);

export const AGENT_DID = `did:vector:${'a1'.repeat(32)}`;
export const READER_DID = `did:vector:${'b2'.repeat(32)}`;
export const TOKEN = `Bearer ${'4f'.repeat(24)}`;
export const CONTACT = 'ops@example.test';
/** The Module-1 manifest of the fixture world of buyer-core: the file that a fetch stub serves at MODULE1_URL. */
export const MODULE1_FIXTURE = fileURLToPath(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url));
export const MODULE1_COMMIT = '1234567890abcdef1234567890abcdef12345678';
/**
 * The address of that manifest at a pinned commit. The host is an address of the range for documentation, so that the fetch of the kit needs no lookup of a name, and no test reaches it: a fetch stub answers it.
 * It is the one fetch that the start makes besides the calls to the node.
 */
export const MODULE1_URL = `https://198.51.100.7/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;
/** The Module-1 manifest of the fixture world, as the text that a fetch stub serves, with the identity registry of a deployment. The default is the deployment of the tests, so the manifest is the one of this service. */
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

/** Every secret of an environment, as the texts that must stand in no log, no manifest, no answer and no detail: each key in its hex and bech32 forms, and the token with its credential. */
export function secretsOf(env: NodeJS.ProcessEnv = completeEnv()): string[] {
  const keys = Object.values(KEY_VARIABLES).map((name) => String(env[name]));
  return [...keys, ...keys.map((key) => rawHexToBech32(key)), String(env.SERVICE_AUTH_HEADER), String(env.SERVICE_AUTH_HEADER).slice('Bearer '.length)];
}

/** A complete environment: every setting that the service requires, and the optional ones left out. A test changes the members it needs. */
export function completeEnv(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPERATOR_CONTACT: CONTACT,
    AGENT_DID,
    STOCK_READER_DID: READER_DID,
    SERVICE_AUTH_HEADER: TOKEN,
    IDENTITY_POLICY_ID: DEPLOYMENT.identity.hash,
    VECTOR_IDENTITY_LEGACY_ROOT: DEPLOYMENT.legacyRoot,
    VECTOR_IDENTITY_CONFIG_SEED: `${CONFIG_SEED.txHash}#${CONFIG_SEED.outputIndex}`,
    VECTOR_IDENTITY_ESCROW_REF_UTXO: `${'e0'.repeat(32)}#4`,
    VECTOR_IDENTITY_VAULT_REF_UTXO: `${'e0'.repeat(32)}#3`,
    VECTOR_MODULE1_MANIFEST: MODULE1_URL,
    MOCK_PUBLIC_BASE: 'https://mock.example',
    MOCK_MTLS_BASE: 'https://mock-mtls.example',
    SUPPLIER_PKH: SUPPLIER.keyHash,
    SUPPLIER_PUB_KEY_HEX: SUPPLIER.publicKey,
    LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
    LLM_MAX_PRICE_LOVELACE: '1000000',
    LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
    LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
    HANDOFF_MAX_PRICE_LOVELACE: '10000000',
    HANDOFF_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
    HANDOFF_MAX_BUYER_BOND_LOVELACE: '2000000',
    DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
    DISPUTE_MIN_WINDOW_LEFT_MS: '60000',
    DISPUTE_READ_TIMEOUT_MS: '20000',
    COSIGN_ALLOWLIST: PRINCIPAL.keyHash,
    PORT: '0',
    HOST: '127.0.0.1',
    ...Object.fromEntries(ROLES.map((role) => [KEY_VARIABLES[role], rawKey(KEY_NUMBERS[role])])),
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

const dirs: string[] = [];
/** A new folder for a state directory. Each test file calls `cleanDirs` in `afterEach`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'reorder-serve-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
