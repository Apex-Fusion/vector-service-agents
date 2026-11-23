// packages/hire-kit/src/keys.ts
// The paying keys of a service. A key that signs payments has one chain (one queue of transactions), one stranded store and one janitor, and no other key shares any of them.
// A service that posts from its own wallet with its service key, and pays from the vault of a principal with a delegate key, holds two paying keys. A hire from a key goes
// through the chain and the store of that key. The janitor of a key tends only the escrows of its own store, with the chain of its own key: a Reclaim must be signed by the
// key that posted the escrow, and a Reclaim of an escrow that a vault paid returns the lock to that vault.
// Two things make the separation hold. The registry gives one PayingKey to one key hash and one directory, and refuses a second. And a PayingKey is the only source of the deps
// of a hire from its key (hireDeps), so that a hire has no way to take the chain of one key and the store of another.
// A hire waits in the lane for the hires before it, and the deadline of its caller may pass meanwhile. So the first thing a hire does at its turn is checkTurn, which ends a hire that is too late
// before it reads an advert or pays.
import { join, resolve } from 'node:path';
import type { Chain } from '@vsa/buyer-core';
import type { Clocked } from './budget.ts';
import type { HireDeps, HireErrors } from './hire.ts';
import { StrandedStore, startJanitor } from './janitor.ts';

/** The hash of a payment key: 28 bytes, 56 lowercase hex characters. */
const KEY_HASH = /^[0-9a-f]{56}$/;

/**
 * One hire at a time. A job starts when every job given to the lane before it has ended, whether that one ended well or not. `busy` says that a job runs or waits: the janitor
 * of the key does not start a transaction while it does, as the janitor of the Pipeline does not.
 */
export class HireLane {
  #tail: Promise<void> = Promise.resolve();
  #open = 0;

  run<T>(job: () => Promise<T>): Promise<T> {
    this.#open += 1;
    const result = this.#tail.then(job);
    const settled = result.then(() => undefined, () => undefined);
    this.#tail = settled;
    void settled.then(() => { this.#open -= 1; });
    return result;
  }

  /** True while a job runs or waits for the jobs before it. */
  get busy(): boolean { return this.#open > 0; }
}

/**
 * The least time left at the turn of a hire, from the request of the caller: absent is 0. A value that is not a finite number of 0 or more is refused with a TypeError, before the lane is used.
 */
export function minLeftAtTurn(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('minLeftAtTurnMs must be a finite number of milliseconds, 0 or more.');
  return value;
}

/**
 * The first check of a hire, made when the lane of its key gives it its turn, before it reads an advert, chooses a supplier, builds a transaction or pays. When the clock does not stand before the
 * deadline, or the time left until the deadline is less than `minLeftMs`, the hire ends with the deadline error of `errors` (`label` says which hire), and its facts name the stage `lane` and no
 * escrow: nothing was posted, and no vault was spent. A turn at the deadline is too late also with no margin: `fit` (src/budget.ts) takes that moment as in time for a wait, and a hire that has not
 * begun has no time left at it. A caller gives a margin when a hire that posts with less time left can only end at its first poll with a locked escrow. A turn in time goes on, and the waits and the
 * options of the hire (hireOne, src/hire.ts) cut it as before.
 */
export function checkTurn<E extends Error>(t: Clocked, label: string, errors: Pick<HireErrors<E>, 'deadline'>, minLeftMs = 0): void {
  const left = t.deadlineMs - t.clock();
  if (left > 0 && left >= minLeftMs) return;
  // The text is true also when the lane was free and the deadline had passed before the call: the hire had not begun when its turn came. A turn that the margin ends says so, with the time left.
  const why = left > 0 ? `: its turn came ${left} ms before the deadline, less than minLeftAtTurnMs (${minLeftMs} ms)` : '';
  throw errors.deadline(`${label} had not begun${why}`, { stage: 'lane', escrowRef: null, handedOver: false });
}

/** One key that pays, with its chain, its stranded store and its lane. Made by PayingKeys.add. */
export class PayingKey {
  /** The hash of the key that signs: 56 lowercase hex characters, as the wallet of the chain says, or as the caller of PayingKeys.add gave it. */
  readonly keyHash: string;
  readonly chain: Chain;
  /** The directory of the stranded file of this key. */
  readonly dir: string;
  readonly stranded: StrandedStore;
  readonly lane = new HireLane();

  /** @internal Use PayingKeys.add. */
  constructor(keyHash: string, chain: Chain, dir: string) {
    this.keyHash = keyHash;
    this.chain = chain;
    this.dir = dir;
    this.stranded = new StrandedStore(dir);
  }

  /** The deps of a hire from this key: its chain and its store, and the clock and the deadline of the caller. */
  hireDeps(clocked: Clocked, log?: (line: string) => void): HireDeps {
    return { clock: clocked.clock, sleep: clocked.sleep, deadlineMs: clocked.deadlineMs, chain: this.chain, stranded: this.stranded, ...(log === undefined ? {} : { log }) };
  }

  /** The janitor of this key: its store, its chain, paused while its lane works. Each line it logs starts with the first 8 characters of the key hash. */
  startJanitor(intervalMs: number, opts: { clock?: () => number; log?: (line: string) => void } = {}): { stop: () => Promise<void> } {
    const log = opts.log ?? ((line: string) => { console.log(line); });
    return startJanitor(this.stranded, this.chain, intervalMs, { ...(opts.clock === undefined ? {} : { clock: opts.clock }), log: (line) => { log(`key ${this.keyHash.slice(0, 8)}: ${line}`); }, busy: () => this.lane.busy });
  }
}

/** The paying keys of a service. It gives one PayingKey to one key hash and one directory. */
export class PayingKeys {
  readonly #byHash = new Map<string, PayingKey>();
  readonly #byDir = new Map<string, string>();
  readonly stateDir: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  /**
   * Adds the key of `chain`. Its hash is the one the wallet of the chain says, or the `keyHash` that the caller gives: with a `keyHash`, no wallet is read. A service that knows the hash of its key
   * (it derived it from the key that its chain signs with) gives it, so that a node that is down cannot stop it from starting, for the wallet of the real chain is a read of the node. The caller owns
   * the claim that the hash is the hash of the key of the chain. Its stranded file is in `dir` when the caller gives one (a service that keeps the file of its service key where it was before it held
   * more than one key), and in `keys/<hash>` of the state directory otherwise. Refuses a `keyHash` that is not 56 lowercase hex characters, a key hash that is held already, and a directory that
   * another key uses: two keys never share a store. These checks are the same with or without a `keyHash`.
   */
  async add(chain: Chain, opts: { dir?: string; keyHash?: string } = {}): Promise<PayingKey> {
    const given: unknown = opts.keyHash;
    let buyerPkh: string;
    if (given === undefined) {
      buyerPkh = (await chain.wallet()).buyerPkh;
      if (!KEY_HASH.test(buyerPkh)) throw new Error('The wallet of the chain gives no key hash of 56 lowercase hex characters, so the key has no name to keep its store under.');
    } else {
      // The value is never shown: a key given by mistake would be printed. Its kind and its length say enough.
      if (typeof given !== 'string' || !KEY_HASH.test(given)) {
        throw new Error(`The keyHash given to PayingKeys.add must be 56 lowercase hex characters, and it is ${typeof given === 'string' ? `a text of ${given.length} characters` : `of type ${given === null ? 'null' : typeof given}`}.`);
      }
      buyerPkh = given;
    }
    if (this.#byHash.has(buyerPkh)) throw new Error(`The key ${buyerPkh} is held already: a key has one chain, one stranded store and one janitor.`);
    const dir = resolve(opts.dir ?? join(this.stateDir, 'keys', buyerPkh));
    const user = this.#byDir.get(dir);
    if (user !== undefined) throw new Error(`The directory ${dir} holds the stranded store of the key ${user}: two keys never share a store.`);
    const key = new PayingKey(buyerPkh, chain, dir);
    this.#byHash.set(buyerPkh, key);
    this.#byDir.set(dir, buyerPkh);
    return key;
  }

  get(keyHash: string): PayingKey | undefined {
    return this.#byHash.get(keyHash);
  }

  /** Every key, in the order they were added. */
  list(): PayingKey[] {
    return [...this.#byHash.values()];
  }

  /** One janitor for each key, each with its own store and chain. `stop` ends them all. */
  startJanitors(intervalMs: number, opts: { clock?: () => number; log?: (line: string) => void } = {}): { stop: () => Promise<void> } {
    const janitors = this.list().map((key) => key.startJanitor(intervalMs, opts));
    return { stop: async () => { await Promise.all(janitors.map((janitor) => janitor.stop())); } };
  }
}
