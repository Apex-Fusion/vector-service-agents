// agents/sourcing-agent/test/compliance/support.ts
// What the tests of the compliance folder share. The golden world is one active attestation of the compliance registry about the bidder, read at a fixed time. A test changes one thing in a copy of it, so each
// refusal has the golden world as its accepted twin. The attestations are built by hand as the views that `listAttestations` of buyer-core gives. A scripted list serves them and records the queries that it
// gets. The clock is moved by the test and never waits.
import { readFileSync } from 'node:fs';
import type { AttestationPage, AttestationQuery, AttestationView } from '@vsa/buyer-core';
import type { AttestationDatum } from '@vsa/vector-read/identity-codec';
import { testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { ISSUER_KEY, attestation } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { readCompliance } from '../../src/compliance/index.ts';
import type { ComplianceClock, ComplianceDeps, ComplianceFact } from '../../src/compliance/index.ts';

/** The bidder: the id of its agent and its DID. */
export const AGENT_ID = 'a1'.repeat(32);
export const DID = `did:vector:${AGENT_ID}`;
/** Another agent. */
export const OTHER_ID = 'b2'.repeat(32);
/** The key of the compliance registry: its public key is in the datum of its attestations, and its key hash is the setting of the agent. */
export const REGISTRY = ISSUER_KEY;
/** The key of a stranger, who can make an attestation about any subject. */
export const STRANGER = testKey(22);

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
/** The time of the reads: 2026-11-24T12:00:00Z. */
export const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);
/** The last millisecond of the year 9999: no time of a datum is later. */
export const LAST_TIME_MS = 253_402_300_799_999;

/** The identifier of an attestation: one byte, 32 times. */
export const id = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
/** The identifier of the golden attestation. */
export const ID = id(0xe1);

/**
 * The datum of an attestation of the registry about the bidder: type 0, issued ten days ago, valid for 80 more days, not solicited, with no reply. It is active. `over` changes members. The words of the other
 * members come from the fixture of buyer-core.
 */
export function datum(over: Partial<AttestationDatum> = {}): AttestationDatum {
  return attestation({ subject: AGENT_ID, issuer: REGISTRY.publicKey, attType: 0, issuedAt: NOW - 10 * DAY, validUntil: NOW + 80 * DAY, ...over });
}

/** A revoked status: the time of the revocation, and the reason as the number that the codec of the builders holds. */
export const revoked = (at: number, reason: number): Pick<AttestationDatum, 'status'> => ({ status: { type: 'AttRevoked', at, reason } });

/**
 * The view that `listAttestations` gives for an attestation: the identifier, the datum, and the exact reason of the revocation, which is null for an active attestation. Without `revokeReason`, the reason is
 * the one of the datum, so a datum whose reason is NaN needs its reason given. The output that carries the datum is a stand-in: the reader does not use it.
 */
export function view(attestationId: string, d: AttestationDatum, revokeReason?: bigint | null): AttestationView {
  let reason = revokeReason ?? null;
  if (revokeReason === undefined && d.status.type === 'AttRevoked') reason = BigInt(d.status.reason);
  return {
    id: attestationId, attestation: d,
    utxo: { txHash: attestationId, outputIndex: 0, address: 'addr_stand_in', assets: { lovelace: 5_000_000n } },
    ref: `${attestationId}#0`, lovelace: 5_000_000n, withdrawableFrom: null, revokeReason: reason,
  };
}

/** A view with members of the view replaced by values of any type, as a list with a fault would give. */
export const damagedView = (over: Readonly<Record<string, unknown>>): AttestationView => ({ ...view(ID, datum(), null), ...over }) as unknown as AttestationView;

/** A view whose datum has members replaced by values of any type. The exact reason is given, because the status may be damaged. */
export function damagedDatum(over: Readonly<Record<string, unknown>>, revokeReason: bigint | null = null, attestationId = ID): AttestationView {
  return view(attestationId, { ...datum(), ...over } as unknown as AttestationDatum, revokeReason);
}

/** A page of a list, with the members that `listAttestations` gives. */
export const page = (items: readonly AttestationView[], over: Partial<AttestationPage> = {}): AttestationPage => ({ items: [...items], total: items.length, offset: 0, limit: 20, nextOffset: null, ...over });

export interface ScriptedList {
  readonly list: ComplianceDeps['list'];
  /** The query of each call, in order. */
  readonly queries: AttestationQuery[];
}

/** A list that answers with what `answer` gives for the query (a value, or a promise), and keeps each query. */
export function scripted(answer: (query: AttestationQuery) => unknown): ScriptedList {
  const queries: AttestationQuery[] = [];
  return {
    queries,
    list: async (query) => {
      queries.push(query);
      return (await answer(query)) as AttestationPage;
    },
  };
}

/** A list that answers with one page of these items. */
export const listing = (items: readonly AttestationView[], over: Partial<AttestationPage> = {}): ScriptedList => scripted(() => page(items, over));

/** One tick of the event loop, with the microtasks that it holds. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock that only the test moves. A sleep ends when the test moves the time to it, or when its signal aborts. */
export class ManualClock implements ComplianceClock {
  #elapsed = 0;
  readonly #timers: { due: number; resolve: () => void }[] = [];

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { due: this.#elapsed + ms, resolve };
      this.#timers.push(timer);
      signal?.addEventListener('abort', () => {
        const at = this.#timers.indexOf(timer);
        if (at >= 0) this.#timers.splice(at, 1);
        resolve();
      }, { once: true });
    });
  }

  /** The number of sleeps that wait. */
  get waiting(): number {
    return this.#timers.length;
  }

  /** Moves the time forward by `ms`, and ends each sleep that falls due, in its order. */
  async advance(ms: number): Promise<void> {
    const target = this.#elapsed + ms;
    await settle();
    for (;;) {
      const due = this.#timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due)[0];
      if (due === undefined) break;
      this.#timers.splice(this.#timers.indexOf(due), 1);
      this.#elapsed = Math.max(this.#elapsed, due.due);
      due.resolve();
      await settle();
    }
    this.#elapsed = target;
    await settle();
  }
}

/** A promise with the functions that settle it. */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/** A promise that the test settles by hand. (Promise.withResolvers is not in the types of this package's target.) */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** The deps of a read: the list, the key hash of the registry and a clock that never moves. `over` changes members. */
export function depsOf(list: ComplianceDeps['list'], over: Partial<ComplianceDeps> = {}): ComplianceDeps {
  return { list, issuerPkh: REGISTRY.keyHash, clock: new ManualClock(), ...over };
}

/** The fact for a list that gives one page of these items, read at `at`. */
export const readItems = (items: readonly AttestationView[], at = NOW): Promise<ComplianceFact> => readCompliance(depsOf(listing(items).list), DID, at);

/** The members that a fact has when no attestation decides it. */
const NO_ATTESTATION = { attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null } as const;
export const ABSENT: ComplianceFact = { state: 'absent', ...NO_ATTESTATION };
export const UNREADABLE: ComplianceFact = { state: 'unreadable', ...NO_ATTESTATION };

/** The exact text of a golden file. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');
/** A fresh value of a golden JSON file. */
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>;
