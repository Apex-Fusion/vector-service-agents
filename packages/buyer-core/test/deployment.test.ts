// packages/buyer-core/test/deployment.test.ts
// buyerIdentityDeployment: the identity registry deployment a buyer's chain is given, read from three settings of the hosted MCP server (the two
// deployment values and the escrow reference script, through the vendored identityDeploymentFrom) and held to two more rules: the escrow reference script is set, and
// IDENTITY_POLICY_ID, which the manifest publishes, is the policy the deployment gives. The values are those of the vendored identity world.
import { describe, it, expect } from 'vitest';
import { buyerIdentityDeployment, BUYER_IDENTITY_SETTINGS } from '../src/index.ts';
import { CONFIG_SEED, DEPLOYMENT } from './fixtures/identity-world.ts';

const ROOT = DEPLOYMENT.legacyRoot;
const SEED = `${CONFIG_SEED.txHash}#${CONFIG_SEED.outputIndex}`;
const ESCROW_REF = `${'e0'.repeat(32)}#4`;
const POLICY = DEPLOYMENT.identity.hash;
/** The settings of a configured buyer: the two deployment values, the escrow reference script and the policy the manifest publishes. */
const CONFIGURED = { VECTOR_IDENTITY_LEGACY_ROOT: ROOT, VECTOR_IDENTITY_CONFIG_SEED: SEED, VECTOR_IDENTITY_ESCROW_REF_UTXO: ESCROW_REF, IDENTITY_POLICY_ID: POLICY };
const message = (env: Record<string, string | undefined>): string => {
  try { buyerIdentityDeployment(env); } catch (err) { return (err as Error).message; }
  throw new Error('no error');
};

describe('buyerIdentityDeployment', () => {
  it('is null when no setting of the deployment is set: the chain knows the legacy layout only, whatever IDENTITY_POLICY_ID says', () => {
    expect(buyerIdentityDeployment({})).toBeNull();
    expect(buyerIdentityDeployment({ VECTOR_IDENTITY_LEGACY_ROOT: '', VECTOR_IDENTITY_CONFIG_SEED: '  ' })).toBeNull();
    expect(buyerIdentityDeployment({ IDENTITY_POLICY_ID: POLICY })).toBeNull();
  });

  it('is the deployment the two values give, with the escrow reference script, when IDENTITY_POLICY_ID is its policy', () => {
    const deployment = buyerIdentityDeployment(CONFIGURED);
    expect(deployment?.identity.hash).toBe(POLICY);
    expect(deployment?.escrow.address).toBe(DEPLOYMENT.escrow.address);
    expect(deployment?.advert.address).toBe(DEPLOYMENT.advert.address);
    expect(deployment?.refs.escrow).toStrictEqual({ txHash: 'e0'.repeat(32), outputIndex: 4 });
    expect(buyerIdentityDeployment({ ...CONFIGURED, IDENTITY_POLICY_ID: ` ${POLICY.toUpperCase()} ` })?.identity.hash).toBe(POLICY);
  });

  it('needs IDENTITY_POLICY_ID with the deployment, and says which policy the two values give', () => {
    expect(message({ ...CONFIGURED, IDENTITY_POLICY_ID: undefined })).toBe(
      `environment variable IDENTITY_POLICY_ID is not set, but VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED are: set it to ${POLICY}, the identity policy those two give, so that the manifest names the registry the buyer posts to`,
    );
  });

  it('refuses an IDENTITY_POLICY_ID that is not the policy of the deployment, and does not show the value set', () => {
    const wrong = 'ab'.repeat(28);
    const text = message({ ...CONFIGURED, IDENTITY_POLICY_ID: wrong });
    expect(text).toBe(`environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give (${POLICY}): one of the three values is wrong`);
    expect(text).not.toContain(wrong);
  });

  it('needs the escrow reference script with the deployment: an identity-marketplace escrow is accepted and reclaimed through it', () => {
    expect(message({ ...CONFIGURED, VECTOR_IDENTITY_ESCROW_REF_UTXO: undefined })).toMatch(/^environment variable VECTOR_IDENTITY_ESCROW_REF_UTXO is not set: it names the UTxO that holds the escrow reference script/);
  });

  it('passes on the refusals of the vendored reader, each naming its variable and none showing the value', () => {
    expect(message({ VECTOR_IDENTITY_LEGACY_ROOT: ROOT })).toMatch(/^environment variable VECTOR_IDENTITY_LEGACY_ROOT is set, but VECTOR_IDENTITY_CONFIG_SEED is not: set both/);
    expect(message({ ...CONFIGURED, VECTOR_IDENTITY_LEGACY_ROOT: 'not hex' })).toBe('environment variable VECTOR_IDENTITY_LEGACY_ROOT must be 64 hex characters (the 32-byte Merkle root).');
    const seed = message({ ...CONFIGURED, VECTOR_IDENTITY_CONFIG_SEED: 'ab'.repeat(32) });
    expect(seed).toBe('environment variable VECTOR_IDENTITY_CONFIG_SEED must be <64 hex characters>#<output index>.');
    expect(message({ ...CONFIGURED, VECTOR_IDENTITY_ESCROW_REF_UTXO: 'nope' })).toBe('environment variable VECTOR_IDENTITY_ESCROW_REF_UTXO must be <64 hex characters>#<output index>.');
  });

  it('reads three settings and no other: the rest of the VECTOR_IDENTITY_* settings of the MCP server serve no buyer, and are not looked at', () => {
    expect([...BUYER_IDENTITY_SETTINGS]).toStrictEqual(['VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO']);
    const others = { VECTOR_IDENTITY_ALLOWLIST_URL: 'http://not-https.example', VECTOR_IDENTITY_POLICY_ID: 'not a policy', VECTOR_IDENTITY_REF_UTXO: 'nope' };
    expect(buyerIdentityDeployment(others)).toBeNull();
    expect(buyerIdentityDeployment({ ...CONFIGURED, ...others })?.identity.hash).toBe(POLICY);
    expect(message({ VECTOR_IDENTITY_ESCROW_REF_UTXO: ESCROW_REF })).toMatch(/^environment variable VECTOR_IDENTITY_ESCROW_REF_UTXO is set, but VECTOR_IDENTITY_LEGACY_ROOT is not: set both/);
  });
});
