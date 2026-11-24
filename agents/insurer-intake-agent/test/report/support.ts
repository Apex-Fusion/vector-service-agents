// agents/insurer-intake-agent/test/report/support.ts: what the tests of the report share. The report reads only through the four ports of `ReportDeps`, so a test gives fakes: the rows that a list holds, the
// attestations that a check calls valid, the Provider key of the sender and the root delegator. Each fake records its calls. The clock is a fake that only the test moves, so a read that never answers costs no time.
// Every record is synthetic. No test here uses the network.
import type { Clock } from '@vsa/usecase-kit/access';
import { didOfAgentId } from '@vsa/usecase-kit/protocol';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';
import { reportAttestations } from '../../src/report/index.ts';
import type { AttestationReport, ReportDeps, ReportExpectation, ReportInput, ReportRoot, ReportRow } from '../../src/report/index.ts';

/** Lets every promise that can go on, go on. It uses the real event loop, which no test moves. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A clock that only the test moves. A sleep ends when the test moves the time to it, or when its signal aborts. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers: { due: number; seq: number; resolve: () => void }[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { due: this.#now + ms, seq: (this.#seq += 1), resolve };
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

  /** Moves the time from sleep to sleep until `work` ends. It fails when no sleep waits and the work is not done: that is a wait with no end. */
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    work.then(() => (done = true), () => (done = true));
    for (let step = 0; ; step += 1) {
      await settle();
      if (done) return work;
      if (step >= 10_000) throw new Error('the fake clock ran 10,000 steps and the work did not end');
      const next = [...this.#timers].sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (next === undefined) throw new Error('nothing waits on the clock, and the work did not end: a wait with no end');
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = Math.max(this.#now, next.due);
      next.resolve();
    }
  }
}

/** The time at which a run starts, in milliseconds since 1970. */
export const T0 = 1_800_000_000_000;
/** The id of a thing of the n-th kind that a test makes: 64 lower-case hex characters. */
export const idOf = (n: number): string => n.toString(16).padStart(64, '0');
export const SENDER: Did = didOfAgentId(idOf(0xa1));
export const DELEGATION: DelegationId = idOf(0xd1);
/** The time of the check that the input names. */
export const AT = T0 + 60_000;
export const INPUT: ReportInput = { sender: SENDER, delegation: DELEGATION, atMs: AT };

/** The key hashes of the Provider of the sender, of the root delegator (a key principal) and of a stranger. */
export const PROVIDER_HASH = '1a'.repeat(28);
export const ROOT_HASH = '2b'.repeat(28);
export const STRANGER_HASH = '3c'.repeat(28);
/** The id of the record of the root delegator when that root is an agent, and the id of a record of another member. */
export const MEMBER_ID = idOf(0x44);
export const OTHER_ID = idOf(0x55);

export const KEY_ROOT: ReportRoot = { type: 'key', hash: ROOT_HASH };
export const AGENT_ROOT: ReportRoot = { type: 'agent', id: MEMBER_ID };

/** A row of a list. With no change it is an attestation of a stranger. */
export const row = (id: string, over: Partial<ReportRow> = {}): ReportRow => ({ id, issuer_key_hash: STRANGER_HASH, issuer_id: null, issued_at: T0, ...over });

/** The attestation types of the three kinds. */
export const TYPES = { provenance: 1, software: 2, principal_binding: 4 } as const;
export type Kind = keyof typeof TYPES;
export const KIND_NAMES: readonly Kind[] = ['provenance', 'software', 'principal_binding'];

/** One attestation of the right issuer for each kind: the accepted twin of every refusal below. */
export const GOOD_ROWS: Readonly<Record<number, readonly ReportRow[]>> = {
  1: [row(idOf(0x101), { issuer_key_hash: PROVIDER_HASH })],
  2: [row(idOf(0x102), { issuer_key_hash: PROVIDER_HASH })],
  4: [row(idOf(0x104), { issuer_key_hash: ROOT_HASH })],
};
export const GOOD_IDS: readonly string[] = [idOf(0x101), idOf(0x102), idOf(0x104)];

export interface Script {
  /** The rows that `list` gives, by attestation type. A type with no entry has no row. The default is GOOD_ROWS. */
  readonly rows?: Readonly<Record<number, readonly ReportRow[]>>;
  /** The ids that `check` calls valid. Any other id is not valid. The default is GOOD_IDS. */
  readonly valid?: readonly string[];
  /** The key hash of the Provider, or null for a record with no Provider party. The default is PROVIDER_HASH. */
  readonly provider?: string | null;
  /** The root delegator, or null for a delegation with no live chain. The default is KEY_ROOT. */
  readonly root?: ReportRoot | null;
  /** Replaces the answer of a port. The call is still recorded, and the time that the port takes is still spent. */
  readonly ports?: Partial<Pick<ReportDeps, 'check' | 'list' | 'providerKeyHashOf' | 'rootDelegatorOf'>>;
  /** The milliseconds of the fake clock that a port takes before it answers. */
  readonly takes?: Partial<Record<'check' | 'list' | 'provider' | 'root', number>>;
}

export interface Calls {
  readonly list: Array<{ subject: Did; attType: number }>;
  readonly check: Array<{ id: string; atMs: number; expect: ReportExpectation }>;
  readonly provider: Did[];
  readonly root: DelegationId[];
  /** The log lines of the report. */
  readonly lines: string[];
}

export interface Rig {
  readonly deps: ReportDeps;
  readonly calls: Calls;
  readonly clock: FakeClock;
}

/** The ports that a script can replace. */
export type PortName = 'check' | 'list' | 'providerKeyHashOf' | 'rootDelegatorOf';

/** A script that replaces one port by `answer`. A test uses it for a port that fails or that gives a value of the wrong type. */
export const replacing = (port: PortName, answer: (...args: never[]) => Promise<unknown>): NonNullable<Script['ports']> => ({ [port]: answer }) as unknown as NonNullable<Script['ports']>;

/**
 * Fake ports that answer as the script says and record what they were asked. A port is a plain function and not an `async` one, so a replacement can throw before it returns a promise, as a port
 * that fails at once does.
 */
export function rig(script: Script = {}): Rig {
  const clock = new FakeClock(T0);
  const calls: Calls = { list: [], check: [], provider: [], root: [], lines: [] };
  const rows = script.rows ?? GOOD_ROWS;
  const valid = script.valid ?? GOOD_IDS;
  const provider = script.provider === undefined ? PROVIDER_HASH : script.provider;
  const root = script.root === undefined ? KEY_ROOT : script.root;
  /** The answer of a port that the script does not replace, after the time that the script gives that port. */
  const answer = async <T>(port: 'check' | 'list' | 'provider' | 'root', value: T): Promise<T> => {
    const ms = script.takes?.[port];
    if (ms !== undefined) await clock.sleep(ms);
    return value;
  };
  const deps: ReportDeps = {
    clock,
    log: (line) => { calls.lines.push(line); },
    list(subject, attType) {
      calls.list.push({ subject, attType });
      return script.ports?.list === undefined ? answer('list', rows[attType] ?? []) : script.ports.list(subject, attType);
    },
    check(id, atMs, expect) {
      calls.check.push({ id, atMs, expect });
      return script.ports?.check === undefined ? answer('check', valid.includes(id)) : script.ports.check(id, atMs, expect);
    },
    providerKeyHashOf(sender) {
      calls.provider.push(sender);
      return script.ports?.providerKeyHashOf === undefined ? answer('provider', provider) : script.ports.providerKeyHashOf(sender);
    },
    rootDelegatorOf(delegation) {
      calls.root.push(delegation);
      return script.ports?.rootDelegatorOf === undefined ? answer('root', root) : script.ports.rootDelegatorOf(delegation);
    },
  };
  return { deps, calls, clock };
}

/** Runs the report on the fake clock: a read that never answers ends when the clock reaches its limit. */
export const go = (r: Rig, input: ReportInput = INPUT): Promise<AttestationReport> => r.clock.run(reportAttestations(r.deps, input));

/** The milliseconds of the fake clock that a run has spent. */
export const spent = (r: Rig): number => r.clock.now() - T0;

/** A port that fails the way a source fails: it rejects, it rejects with a text, it throws before it returns a promise, and it never answers. */
export const FAILURES: Readonly<Record<string, () => Promise<never>>> = {
  'rejects with an error': () => Promise.reject(new Error('the source failed')),
  'rejects with a text': () => Promise.reject('the source failed'),
  'throws at once': () => { throw new Error('the source failed'); },
  'never answers': () => new Promise<never>(() => undefined),
};

/** What a call of `report` gives when every kind is valid. */
export const ALL_VALID: AttestationReport = { provenance: 'valid', software: 'valid', principal_binding: 'valid' };
