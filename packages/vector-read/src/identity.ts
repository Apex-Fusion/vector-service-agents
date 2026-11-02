// The identity registry helpers that the services share. The record codecs, the DID strings and the purpose values are vendored from
// agents-marketplace packages/shared (src/vendored/shared, see VENDORED-FROM.md) and re-exported here; the rest is local: the two registries
// (did:vector Part 1, section 4), the authenticity test of a record output, and active_key of the vector_identity library (Part 2, section 3.10).
import { plutusAddressToBech32 } from './vendored/shared/cbor/address.ts';
import { keyHash } from './vendored/shared/identity/id.ts';
import { PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION } from './vendored/shared/identity/constants.ts';
import type { IdentityDatum, Key } from './vendored/shared/cbor/IdentityDatum.ts';
import { REGISTRY_POLICY, REGISTRY_ADDRESS } from './constants.ts';

export type { IdentityDatum, LegacyDatum, Key, KeyType, Signer, Role, Party, Lineage, Status, Hold, PendingRecovery } from './vendored/shared/cbor/IdentityDatum.ts';
export { KEY_TYPES, ROLES, decodeIdentityDatum, encodeIdentityDatum, decodeLegacyDatum, encodeLegacyDatum } from './vendored/shared/cbor/IdentityDatum.ts';
export type { PlutusData } from './vendored/shared/cbor/plutus-data.ts';
export { decodePlutusDataHex, encodePlutusDataHex } from './vendored/shared/cbor/plutus-data.ts';
export type { PlutusAddress, PlutusCredential } from './vendored/shared/cbor/address.ts';
export { plutusAddressFromBech32, plutusAddressToBech32 } from './vendored/shared/cbor/address.ts';
export type { ParsedVectorDid } from './vendored/shared/identity/id.ts';
export { isVectorId, vectorIdFromSeed, dnsSafe, keyHash, vectorDid, legacyVectorDid, parseVectorDid, utf8ToHex, utf8FromHex } from './vendored/shared/identity/id.ts';
export {
  PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION, ED25519_PURPOSES, P256_PURPOSES,
  RIGHT_SUSPEND, RIGHT_REVOKE, RIGHT_RECOVER, ROLE_MAX_RIGHTS,
} from './vendored/shared/identity/constants.ts';

/** A registry: its minting policy (the script hash) and the exact address of its records. */
export interface Registry { policy: string; address: string }
/** The registries a service reads. `identity` is null until the identity registry is deployed and configured. */
export interface Registries { legacy: Registry; identity: Registry | null }
export const LEGACY_REGISTRY: Registry = { policy: REGISTRY_POLICY, address: REGISTRY_ADDRESS };

const POLICY_ID = /^[0-9a-f]{56}$/;
/** The Vector mainnet address of a script with no stake credential: where a registry holds its records (Part 1, section 4). */
export function scriptAddress(scriptHash: string): string {
  if (!POLICY_ID.test(scriptHash)) throw new Error(`a script hash is 56 lowercase hex characters, got "${scriptHash}"`);
  return plutusAddressToBech32({ paymentCredential: { type: 'Script', hash: scriptHash }, stakeCredential: null }, 1);
}
/**
 * The identity registry from the two deployment values the services are configured with (the names the gateway and the indexer use too):
 * IDENTITY_POLICY_ID, and IDENTITY_ADDRESS, which may be left out and must otherwise be the address of that policy. Absent, empty and blank
 * mean not given; no policy means no identity registry (null), the state before its deployment. A value that breaks a rule throws, naming it.
 */
export function identityRegistryOf(policyId: string | undefined, address: string | undefined): Registry | null {
  const policy = policyId?.trim() ?? '', given = address?.trim() ?? '';
  if (policy === '') {
    if (given !== '') throw new Error('IDENTITY_ADDRESS is set but IDENTITY_POLICY_ID is not');
    return null;
  }
  if (!POLICY_ID.test(policy)) throw new Error(`IDENTITY_POLICY_ID must be 56 lowercase hex characters, got "${policy}"`);
  if (policy === LEGACY_REGISTRY.policy) throw new Error('IDENTITY_POLICY_ID is the policy of the legacy registry, not of the identity registry');
  const derived = scriptAddress(policy);
  if (given !== '' && given !== derived) throw new Error(`IDENTITY_ADDRESS ${given} is not the address of IDENTITY_POLICY_ID (${derived})`);
  return { policy, address: derived };
}

/** One asset of an output as Koios lists it. */
export interface ListedAsset { policy_id: string; asset_name: string; quantity: string }
/**
 * An authentic record output for an identifier (Part 1, section 4): at the exact address of its registry, holding exactly one token of the
 * registry's policy, named by the identifier, with quantity 1. An output with a second token of the policy is not authentic.
 */
export function isAuthenticRecord(address: string, assets: readonly ListedAsset[] | null | undefined, registry: Registry, id: string): boolean {
  if (address !== registry.address) return false;
  const ofPolicy = (assets ?? []).filter((a) => a.policy_id === registry.policy);
  return ofPolicy.length === 1 && ofPolicy[0].asset_name === id && ofPolicy[0].quantity === '1';
}

// The purpose check of active_key: authentication and assertion count for every key, transaction and delegation only for an Ed25519 key, and any
// other value for none. The purposes are a sum of powers of two, read as bits (purposes / purpose % 2 == 1, as the library computes it).
function keyHasPurpose(key: Key, purpose: number): boolean {
  const allowed = purpose === PURPOSE_AUTHENTICATION || purpose === PURPOSE_ASSERTION ? true
    : purpose === PURPOSE_TRANSACTION || purpose === PURPOSE_DELEGATION ? key.keyType === 'Ed25519'
    : false;
  return allowed && (BigInt(key.purposes) / BigInt(purpose)) % 2n === 1n;
}
/**
 * active_key of the vector_identity library (Part 2, section 3.10): true when the record lists a key whose blake2b-224 hash is `keyHashHex` and
 * whose purposes contain `purpose`. The controller key counts only when it is also a listed key.
 */
export function activeKey(record: Pick<IdentityDatum, 'keys'>, keyHashHex: string, purpose: number): boolean {
  return record.keys.some((key) => keyHasPurpose(key, purpose) && keyHash(key.key) === keyHashHex);
}
