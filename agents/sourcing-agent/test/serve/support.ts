// agents/sourcing-agent/test/serve/support.ts
// What the tests of the serve folder share: the nine keys of the tests, the supplier key, the DIDs of the agent and of its three scorers, a complete environment, the secrets of an environment, the Module-1 manifest
// of the fixture world and a fetch that serves it, the settings of the wiring that an environment gives, and a place for the state directory. A key of the tests is 32 bytes of one number, which is a raw Ed25519
// key, and it is the key of the same number in the fixture world of buyer-core, so the co-sign route reads the records that the fixture world holds for them. No test uses the network and no key is real.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buyerVaultDeployment, rawHexToBech32 } from '@vsa/buyer-core';
import { CONFIG_SEED, DEPLOYMENT, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import {
  agentDidOf, complianceIssuerOf, disputeOf, endpointsFromEnv, faultOf, limitsOf, mockBasesOf, module1SourceOf, quoteLimitsOf, scorerDidsOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import type { WiringSettings } from '../../src/serve/wiring.ts';

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
/** The Module-1 manifest of the fixture world of buyer-core: the file that a fetch stub serves at MODULE1_URL. */
export const MODULE1_FIXTURE = fileURLToPath(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url));

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

/** The settings of the wiring that an environment gives, as the start reads them: the nine keys are made from their variables, and every other value comes from its reader of the settings. */
export function wiringSettingsOf(env: NodeJS.ProcessEnv = completeEnv()): WiringSettings {
  return {
    stateDir: stateDirOf(env),
    agentDid: agentDidOf(env),
    scorerDids: scorerDidsOf(env),
    supplier: supplierKeyOf(env),
    keys: Object.fromEntries(KEY_ROLES.map((role) => [role, keyOf(String(env[KEY_VARIABLES[role]]))])) as WiringSettings['keys'],
    complianceIssuerPkh: complianceIssuerOf(env),
    endpoints: endpointsFromEnv(env),
    mock: mockBasesOf(env),
    identityDeployment: buyerVaultDeployment(env),
    modelLimits: limitsOf(env),
    quoteLimits: quoteLimitsOf(env),
    dispute: disputeOf(env),
    module1Manifest: module1SourceOf(env),
    fault: faultOf(env),
  };
}

const dirs: string[] = [];
/** A new folder for a state directory. Each test file calls `cleanDirs` in `afterEach`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sourcing-serve-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}
