// packages/usecase-kit/src/live/keys.ts
// The key object of a raw Ed25519 key. The key tool of the agent template prints a key as 64 lower-case hex characters, and a service holds it in that form. The token client and the DPoP proof of `@vsa/id-kit`
// take a private key as a `KeyObject` of `node:crypto`, so this file makes one from the hex. It reads no key file and no environment variable.
//
// The key stays inside `node:crypto`. The object has no own member, so `inspect`, `JSON.stringify` and `toString` show nothing of it, and it gives the key away only to a caller that asks for it with `export`.
// A text that is not 64 lower-case hex characters, and a value that is not text, is a TypeError. Its message never repeats the value.
import { createPrivateKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** The PKCS#8 prefix of an Ed25519 private key. The 32 bytes of the raw key follow it. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RAW_KEY = /^[0-9a-f]{64}$/;

/**
 * The private Ed25519 key object of a raw key. A caller gives the 64 lower-case hex characters of the key. The check of the type comes first: a value that is not text could give a good key in its own `toString`.
 */
export function keyObjectOfRawKey(privateKeyHex: string): KeyObject {
  if (typeof privateKeyHex !== 'string' || !RAW_KEY.test(privateKeyHex)) throw new TypeError('the private key must be text of 64 lower-case hex characters');
  return createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(privateKeyHex, 'hex')]), format: 'der', type: 'pkcs8' });
}
