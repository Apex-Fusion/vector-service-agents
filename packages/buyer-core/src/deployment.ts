// packages/buyer-core/src/deployment.ts
// The identity registry deployment a buyer's chain posts to and settles with (Part 2 sections 2, 6.1 and 6.5). The vendored identityDeploymentFrom
// (vendored/mcp/identity-deployment.ts) reads the settings of the hosted MCP server, applies the parameters to the scripts of the identity-marketplace
// blueprint and gives their hashes and addresses. A buyer reads three of those settings and no other (BUYER_IDENTITY_SETTINGS): the two deployment
// values VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED, set both or neither, and the escrow reference script. Without the two values
// there is no deployment: the chain posts to legacy adverts and settles legacy escrows only. A service that buys reads the deployment once when it
// starts, and two more rules hold there, so that a setting that breaks one stops the start and names it:
// - the reference script of the identity-marketplace escrow is set (VECTOR_IDENTITY_ESCROW_REF_UTXO): every identity-marketplace escrow the service
//   posts is accepted or reclaimed through it;
// - IDENTITY_POLICY_ID, the identity registry the service publishes in its manifest, is the policy the deployment gives, so that the manifest names
//   the registry the buyer posts to.
// A chain that also pays an escrow from a vault (payFromVault, in chain.ts) needs a fourth setting: the reference script of the vault, which the Pay
// spends the vault with (VECTOR_IDENTITY_VAULT_REF_UTXO). buyerIdentityDeployment does not read it and its settings stay three, so a chain made with that
// loader cannot pay from a vault. buyerVaultDeployment is the loader of a chain that does: it reads the four settings, holds the same two rules, and
// requires the fourth and checks its form.
// No message shows a value that was set: the hash a message names is computed from the settings.
import { identityDeploymentFrom, refOf } from './vendored/mcp/identity-deployment.ts';
import type { IdentityDeployment, RefName } from './vendored/mcp/identity-deployment.ts';

/** The settings of the identity deployment that a buyer reads. The other VECTOR_IDENTITY_* settings of the MCP server serve no buyer and are not read. */
export const BUYER_IDENTITY_SETTINGS = ['VECTOR_IDENTITY_LEGACY_ROOT', 'VECTOR_IDENTITY_CONFIG_SEED', 'VECTOR_IDENTITY_ESCROW_REF_UTXO'] as const;

/** The settings of the identity deployment that a chain which pays from vaults reads: the three of a buyer, and the reference script of the vault. */
export const VAULT_PAYER_IDENTITY_SETTINGS = [...BUYER_IDENTITY_SETTINGS, 'VECTOR_IDENTITY_VAULT_REF_UTXO'] as const;

/** The deployment that the settings `names` describe, with the reference scripts `refs` set, held to the two rules of a service that buys; null when none of the settings is set. */
function deploymentOf(env: Record<string, string | undefined>, names: readonly string[], refs: readonly RefName[]): IdentityDeployment | null {
  const own = Object.fromEntries(names.map((name) => [name, env[name]]));
  let deployment: IdentityDeployment | null;
  try {
    deployment = identityDeploymentFrom(own);
    if (deployment !== null) for (const ref of refs) refOf(deployment, ref);
  } catch (err) {
    throw new Error(`environment variable ${err instanceof Error ? err.message : String(err)}`);
  }
  if (deployment === null) return null;
  const policy = (env.IDENTITY_POLICY_ID ?? '').trim().toLowerCase();
  const derived = deployment.identity.hash;
  if (policy === '') {
    throw new Error(`environment variable IDENTITY_POLICY_ID is not set, but VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED are: set it to ${derived}, the identity policy those two give, so that the manifest names the registry the buyer posts to`)
  }
  if (policy !== derived) {
    throw new Error(`environment variable IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give (${derived}): one of the three values is wrong`);
  }
  return deployment;
}

/** The deployment the settings describe, or null when none of BUYER_IDENTITY_SETTINGS is set. Throws an Error that starts `environment variable <NAME>`. */
export function buyerIdentityDeployment(env: Record<string, string | undefined>): IdentityDeployment | null {
  return deploymentOf(env, BUYER_IDENTITY_SETTINGS, ['escrow']);
}

/**
 * The deployment of a chain that pays from vaults: the four settings of VAULT_PAYER_IDENTITY_SETTINGS, with the escrow reference script and the vault reference script both
 * set, and IDENTITY_POLICY_ID the policy of the deployment. Throws an Error that starts `environment variable <NAME>` for a setting that is wrong, and one that names the four
 * settings when none is set, since a chain that pays from vaults has no use for no deployment.
 */
export function buyerVaultDeployment(env: Record<string, string | undefined>): IdentityDeployment {
  const deployment = deploymentOf(env, VAULT_PAYER_IDENTITY_SETTINGS, ['escrow', 'vault']);
  if (deployment === null) throw new Error(`none of ${VAULT_PAYER_IDENTITY_SETTINGS.join(', ')} is set: a chain that pays from vaults needs the identity deployment and the reference script of the vault`);
  return deployment;
}
