// agents/prior-authorization-agent/src/serve/keys.ts
// What the service makes of a key, from its value. The value is read in start.ts, the one file that names a key variable, and given here as a parameter: no key is read in this file, and no file. A key becomes a
// signer of transactions (`txSignerOfRawKey` of the kit), a key object (`keyObjectOfRawKey` of the kit, for the token client and the proof of a call), the functions that sign a body hash and a Module-1
// transaction, and its public values (the key hash, the address of its wallet and its public key). The object that this file makes has no member that holds the key as text: the key stays in the closures of the
// signers and in the key object, which shows nothing of it to `JSON.stringify`, `inspect` or `toString`.
//
// The service holds seven keys, each with one job:
//   service                       pays the model hires, signs the claims and the challenges of the dispute code, and signs the subject token of its own token requests
//   delegation 1 and 2            each is the live delegation key of a hirer: it signs the vault Pay and the Accept, the Delegate and the Undelegate of a sub-delegation, and the proof of a call
//   record-reader authentication  signs the subject token of the subagent record-reader
//   record-reader delegation      is the delegate key of the sub-delegation of record-reader, and the key of the proof of its token
//   drafter authentication        signs the subject token of the subagent drafter
//   drafter delegation            is the delegate key of the sub-delegation of drafter, and the key of the proof of its token
// No key is the supplier key: that one is the key of the runtime.
import { createPublicKey, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import { txSignerOfRawKey } from '@vsa/usecase-kit/access';
import type { RawKeySigner } from '@vsa/usecase-kit/access';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';

/** The seven keys of the service, by the job of each. */
export const KEY_ROLES = ['service', 'delegation1', 'delegation2', 'recordReaderAuthentication', 'recordReaderDelegation', 'drafterAuthentication', 'drafterDelegation'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

export interface KeyMaterial {
  /** The key hash: 56 lower-case hex characters. */
  readonly pkh: string;
  /** The mainnet enterprise address of the wallet of the key. */
  readonly address: string;
  /** The public key: 64 lower-case hex characters. */
  readonly publicKeyHex: string;
  /** Signs a transaction: the Delegate and the Undelegate of a sub-delegation. Its key hash is `pkh`. */
  readonly signer: RawKeySigner;
  /** The key as a key object: the key of a token request and of the DPoP proof of a call. */
  readonly keyObject: KeyObject;
  /** The Ed25519 signature over the 32 bytes of the hash of a body. It is the sign function of a delegation key of the co-sign route. */
  signBodyHash(bodyHash: Uint8Array): Uint8Array;
  /** The transaction with the witness of the key added, and its hash. It is the signer of the Module-1 code. */
  signUnsigned(unsignedCborHex: string): { readonly signedCborHex: string; readonly txHashHex: string };
  /**
   * Gives the key, as 64 lower-case hex characters, to `use` and to nobody else. The chain of the buyer code takes a key in that form, and this is the one door through which the key leaves this object.
   * The object has no member that holds the key, so `JSON.stringify`, `inspect` and a log line of the object show none.
   */
  withKey<T>(use: (privateKeyHex: string) => T): T;
}

/** The public key of a key object, as 64 lower-case hex characters. */
function publicKeyOf(key: KeyObject): string {
  const x = createPublicKey(key).export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('the public key of the key cannot be read');
  return Buffer.from(x, 'base64url').toString('hex');
}

/** The key material of a raw key: 64 lower-case hex characters. A value that is not a key is refused with an error that never repeats it. */
export function keyOf(privateKeyHex: string): KeyMaterial {
  const signer = txSignerOfRawKey(privateKeyHex);
  const keyObject = keyObjectOfRawKey(privateKeyHex);
  const bech32 = rawHexToBech32(privateKeyHex);
  return {
    pkh: signer.keyHash,
    address: signer.address,
    publicKeyHex: publicKeyOf(keyObject),
    signer,
    keyObject,
    signBodyHash: (bodyHash) => Uint8Array.from(sign(null, Buffer.from(bodyHash), keyObject)),
    signUnsigned: (unsignedCborHex) => signTransaction(unsignedCborHex, bech32),
    withKey: (use) => use(privateKeyHex),
  };
}

/** Two keys that are one key, or a key that is the supplier key. */
export type KeyClash =
  | { readonly kind: 'equal'; readonly first: KeyRole; readonly second: KeyRole }
  | { readonly kind: 'supplier'; readonly role: KeyRole };

/**
 * The first clash among the seven keys: two of them with one key hash, or one with the key hash of the supplier key, or null when each key is a key of its own. Two keys that are one key come first, in the order
 * of the roles. The service never shares a key between two jobs, because each key has one wallet and one queue, and the supplier key is the key of the runtime. A key is known by its key hash, in any case.
 */
export function keyClashOf(keys: Readonly<Record<KeyRole, KeyMaterial>>, supplierPkh: string): KeyClash | null {
  for (const [index, first] of KEY_ROLES.entries()) {
    for (const second of KEY_ROLES.slice(index + 1)) {
      if (keys[first].pkh === keys[second].pkh) return { kind: 'equal', first, second };
    }
  }
  const supplier = supplierPkh.toLowerCase();
  const role = KEY_ROLES.find((name) => keys[name].pkh.toLowerCase() === supplier);
  return role === undefined ? null : { kind: 'supplier', role };
}
