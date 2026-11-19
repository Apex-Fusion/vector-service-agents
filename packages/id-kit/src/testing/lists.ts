// packages/id-kit/src/testing/lists.ts
// The status lists of the stub gateway, in the two formats of the gateway. Each list has 131,072 entries. The entry of an agent is in list n = floor(index / 131,072), at
// position p = index mod 131,072.
// - Bitstring Status List (W3C, a credential `vc+jwt`): one list for both purposes. Its bitstring has 2 x 131,072 bits. Bit p is the revocation bit, and bit 131,072 + p is the
//   suspension bit. Bit 0 is the most significant bit of byte 0. The text is GZIP, then base64url with the multibase prefix `u`.
// - Token Status List (IETF, a token `statuslist+jwt`): 2 bits for each entry, packed from the least significant bit. 0 is valid, 1 is invalid and 2 is suspended. The text is ZLIB, then
//   base64url.
// Both are signed with ES256 by the P-256 key of the gateway, and both last one hour from the time that they are built.

import { deflateSync, gzipSync } from 'node:zlib';
import { LIST_SIZE } from '../common/constants.ts';
import type { ResolvedKey } from '../common/keys.ts';
import { b64url, signJws } from '../vendored/m4/jose.ts';
import type { StubState } from './state.ts';

/** The value of an entry of a Token Status List. */
export const STATUS = { valid: 0, invalid: 1, suspended: 2 } as const;

/** Signed lists last one hour from their build. */
export const LIST_VALIDITY_MS = 3_600_000;

/** `YYYY-MM-DDThh:mm:ssZ`, with the milliseconds cut off. */
export const formatTime = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export const listPosition = (index: number): { readonly n: number; readonly p: number } => ({ n: Math.floor(index / LIST_SIZE), p: index % LIST_SIZE });

function tokenStatusBytes(values: Uint8Array): Buffer {
  const bytes = Buffer.alloc((LIST_SIZE * 2) / 8);
  values.forEach((v, p) => {
    if (v !== 0) bytes[p >> 2]! |= (v & 0b11) << ((p & 3) * 2);
  });
  return bytes;
}

function bitstring(values: Uint8Array): Buffer {
  const bits = Buffer.alloc((2 * LIST_SIZE) / 8);
  const set = (i: number): void => {
    bits[i >> 3]! |= 0x80 >> (i & 7);
  };
  values.forEach((v, p) => {
    if (v === STATUS.invalid) set(p);
    else if (v === STATUS.suspended) set(LIST_SIZE + p);
  });
  return bits;
}

interface Snapshot {
  readonly builtAt: number;
  /** The values of each list for the Bitstring Status List. */
  readonly values: readonly Uint8Array[];
  /** The values of each list for the Token Status List: `values`, and the held entries as suspended. */
  readonly tokenValues: readonly Uint8Array[];
  readonly signed: Map<string, string>;
}

export interface ListSettings {
  readonly baseUrl: string;
  readonly gatewayDid: string;
  readonly key: ResolvedKey;
  readonly kid: string;
  /** The `ttl` of the lists, in milliseconds. */
  readonly refreshMs: number;
}

export class StubLists {
  /** While true, the lists stay as they are: a test moves the clock to age them, or changes an agent and still sees the old lists. */
  frozen = false;
  private snapshot: Snapshot | null = null;

  constructor(
    private readonly state: StubState,
    private readonly settings: ListSettings,
  ) {}

  private build(): Snapshot {
    const { state } = this;
    const listCount = [...state.agents.values()].reduce((count, a) => Math.max(count, listPosition(a.index).n + 1), 1);
    const values = Array.from({ length: listCount }, () => new Uint8Array(LIST_SIZE));
    for (const agent of state.agents.values()) {
      const { n, p } = listPosition(agent.index);
      const status = state.effective(agent).status;
      values[n]![p] = status === 'active' ? STATUS.valid : status === 'suspended' ? STATUS.suspended : STATUS.invalid;
    }
    const tokenValues = values.map((v) => Uint8Array.from(v));
    for (const id of state.heldEntries()) {
      const agent = state.agent(id);
      if (agent === null) continue;
      const { n, p } = listPosition(agent.index);
      if (tokenValues[n]![p] === STATUS.valid) tokenValues[n]![p] = STATUS.suspended;
    }
    return { builtAt: state.now(), values, tokenValues, signed: new Map() };
  }

  /** Builds the lists again from the state now. */
  rebuild(): void {
    this.snapshot = this.build();
  }

  private current(): Snapshot {
    if (this.snapshot === null || !this.frozen) this.snapshot = this.build();
    return this.snapshot;
  }

  /** The time that the lists in use were built (POSIX ms). */
  get builtAt(): number {
    return this.current().builtAt;
  }

  /** The signed list n of the kind, or null when there is no such list. */
  async signedList(kind: 'tsl' | 'bsl', n: number): Promise<string | null> {
    const snapshot = this.current();
    const values = (kind === 'tsl' ? snapshot.tokenValues : snapshot.values)[n];
    if (values === undefined) return null;
    const cacheKey = `${kind}:${n}`;
    const known = snapshot.signed.get(cacheKey);
    if (known !== undefined) return known;
    const { baseUrl, gatewayDid, key, kid, refreshMs } = this.settings;
    const iat = Math.floor(snapshot.builtAt / 1000);
    const ttlSeconds = Math.max(1, Math.round(refreshMs / 1000));
    let signed: string;
    if (kind === 'tsl') {
      signed = await signJws(
        { alg: 'ES256', kid, typ: 'statuslist+jwt' },
        { iss: baseUrl, sub: `${baseUrl}/status/tsl/${n}`, iat, exp: iat + LIST_VALIDITY_MS / 1000, ttl: ttlSeconds, status_list: { bits: 2, lst: b64url(deflateSync(tokenStatusBytes(values), { level: 9 })) } },
        key,
      );
    } else {
      const url = `${baseUrl}/status/bsl/${n}`;
      signed = await signJws(
        { alg: 'ES256', kid, typ: 'vc+jwt', cty: 'vc' },
        {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          id: url,
          type: ['VerifiableCredential', 'BitstringStatusListCredential'],
          issuer: gatewayDid,
          validFrom: formatTime(snapshot.builtAt),
          validUntil: formatTime(snapshot.builtAt + LIST_VALIDITY_MS),
          credentialSubject: { id: `${url}#list`, type: 'BitstringStatusList', statusPurpose: ['revocation', 'suspension'], encodedList: `u${b64url(gzipSync(bitstring(values), { level: 9 }))}`, ttl: ttlSeconds * 1000 },
        },
        key,
      );
    }
    snapshot.signed.set(cacheKey, signed);
    return signed;
  }
}
