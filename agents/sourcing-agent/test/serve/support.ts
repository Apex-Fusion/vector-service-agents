// agents/sourcing-agent/test/serve/support.ts
// What the tests of the serve folder share: the nine keys of the tests, the supplier key, the DIDs of the agent and of its three scorers, a complete environment, and the secrets of an environment. A key of the
// tests is 32 bytes of one number, which is a raw Ed25519 key, and it is the key of the same number in the fixture world of buyer-core, so the co-sign route reads the records that the fixture world holds for
// them. No test uses the network and no key is real.
import { rawHexToBech32 } from '@vsa/buyer-core';
import { CONFIG_SEED, DEPLOYMENT, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';

/** The raw key of the number `n`: 32 bytes that all hold `n`, as 64 lower-case hex characters. */
export const rawKey = (n: number): string => Buffer.alloc(32, n).toString('hex');

/** The nine keys of the service, by the variable that holds each. */
export const KEY_VARIABLES = {
  service: 'SOURCING_SERVICE_PRIV_KEY_HEX',
  delegation1: 'SOURCING_DELEGATION_1_PRIV_KEY_HEX',
  delegation2: 'SOURCING_DELEGATION_2_PRIV_KEY_HEX',
  scorer1Authentication: 'SCORER_1_AUTH_PRIV_KEY_HEX',
  scorer1Delegation: 'SCORER_1_DELEGATION_PRIV_KEY_HEX',
  scorer2Authentication: 'SCORER_2_AUTH_PRIV_KEY_HEX',
  scorer2Delegation: 'SCORER_2_DELEGATION_PRIV_KEY_HEX',
  scorer3Authentication: 'SCORER_3_AUTH_PRIV_KEY_HEX',
  scorer3Delegation: 'SCORER_3_DELEGATION_PRIV_KEY_HEX',
} as const;
/** The public cross-check variable of each key: the key hash. */
export const PKH_VARIABLES = {
  service: 'SOURCING_SERVICE_PKH',
  delegation1: 'SOURCING_DELEGATION_1_PKH',
  delegation2: 'SOURCING_DELEGATION_2_PKH',
  scorer1Authentication: 'SCORER_1_AUTH_PKH',
  scorer1Delegation: 'SCORER_1_DELEGATION_PKH',
  scorer2Authentication: 'SCORER_2_AUTH_PKH',
  scorer2Delegation: 'SCORER_2_DELEGATION_PKH',
  scorer3Authentication: 'SCORER_3_AUTH_PKH',
  scorer3Delegation: 'SCORER_3_DELEGATION_PKH',
} as const;
/** The numbers of the fixture world of the co-sign route: delegation 1 is key 21, delegation 2 is 22 and the service key is 24. The six keys of the scorers are 41 to 46. */
export const KEY_NUMBERS = {
  service: 24, delegation1: 21, delegation2: 22,
  scorer1Authentication: 41, scorer1Delegation: 42, scorer2Authentication: 43, scorer2Delegation: 44, scorer3Authentication: 45, scorer3Delegation: 46,
} as const;
export type Role = keyof typeof KEY_VARIABLES;
export const ROLES = Object.keys(KEY_VARIABLES) as Role[];

/** The supplier key of the tests: a public key and its key hash. The private key is the runtime's, and no test has it. */
export const SUPPLIER = testKey(23);
/** The key of the member who delegates: the principal key that the allowlist holds. */
export const PRINCIPAL = testKey(31);
/** The key of the issuer of the compliance attestations: a key with no record. Its key hash is public. */
export const ISSUER = testKey(51);

export const AGENT_DID = `did:vector:${'a1'.repeat(32)}`;
/** The DIDs of the three scorers, in the order of SCORER_1_DID to SCORER_3_DID. */
export const SCORER_DIDS = [`did:vector:${'b2'.repeat(32)}`, `did:vector:${'b3'.repeat(32)}`, `did:vector:${'b4'.repeat(32)}`] as const;
export const TOKEN = `Bearer ${'4f'.repeat(24)}`;
export const CONTACT = 'ops@example.test';
export const MODULE1_COMMIT = '1234567890abcdef1234567890abcdef12345678';
/** The address of the Module-1 manifest at a pinned commit. The host is an address of the range for documentation, and no test reaches it. */
export const MODULE1_URL = `https://198.51.100.7/Apex-Fusion/vector-agent-modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;

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
    SCORER_1_DID: SCORER_DIDS[0],
    SCORER_2_DID: SCORER_DIDS[1],
    SCORER_3_DID: SCORER_DIDS[2],
    COMPLIANCE_ISSUER_PKH: ISSUER.keyHash,
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
    QUOTE_MAX_PRICE_LOVELACE: '2000000',
    QUOTE_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
    QUOTE_MAX_BUYER_BOND_LOVELACE: '2000000',
    DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
    DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
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
