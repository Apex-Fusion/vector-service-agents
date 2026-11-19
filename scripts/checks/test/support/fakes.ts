// The fakes that the tests of the checks share: a clock that moves when it sleeps, a node over a World, a screen that keeps its lines, and a signer that must never be asked.
import type { Clock, NetworkFacts, NodeAccess, Output, Signer, TxStatus } from '../../lib/ports.ts';
import type { Utxo } from '../../lib/platform.ts';
import { VECTOR_MAINNET } from '../../lib/settings.ts';
import { World } from './world.ts';

/** A clock that only moves when a test moves it or something sleeps. */
export class FakeClock implements Clock {
  t: number;
  readonly slept: number[] = [];

  constructor(start: number) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.t += ms;
  }
}

/** The screen of a script: the lines of the report and the lines of the refusals. */
export class MemoryOutput implements Output {
  readonly lines: string[] = [];
  readonly errors: string[] = [];

  out(line: string): void {
    this.lines.push(line);
  }

  err(line: string): void {
    this.errors.push(line);
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get errorText(): string {
    return this.errors.join('\n');
  }
}

/** A signer that fails when it is asked: it proves that a mode signs nothing. */
export class ThrowingSigner implements Signer {
  calls = 0;

  has(): boolean {
    return true;
  }

  sign(): string {
    this.calls += 1;
    throw new Error('a signature was asked for');
  }
}

/**
 * A node over a World. It answers the facts of its network, reads the outputs of the world, takes a submit (the world moves on), and reports a transaction confirmed after
 * `confirmAfterPolls` reads of its status. A test sets what goes wrong.
 */
export class FakeNode implements NodeAccess {
  readonly submitted: string[] = [];
  readonly polls = new Map<string, number>();
  facts: NetworkFacts = { magic: VECTOR_MAINNET.magic, systemStartMs: VECTOR_MAINNET.systemStartMs };
  /** How many reads of the status say that the transaction is not known, before it is confirmed. */
  confirmAfterPolls = 0;
  /** A transaction that is never confirmed. */
  neverConfirm = false;
  submitError: Error | null = null;
  statusError: Error | null = null;
  /** The confirmations that a confirmed transaction has. */
  confirmations = 1;
  readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  async networkFacts(): Promise<NetworkFacts> {
    return this.facts;
  }

  async resolveInputs(refs: readonly string[]): Promise<Utxo[]> {
    return this.world.chain.getUtxosByOutRef(refs.map((ref) => ({ txHash: ref.slice(0, 64), outputIndex: Number(ref.slice(65)) })));
  }

  async submit(signedCborHex: string): Promise<string> {
    if (this.submitError !== null) throw this.submitError;
    this.submitted.push(signedCborHex);
    return this.world.chain.apply(signedCborHex);
  }

  async txStatus(txHash: string): Promise<TxStatus> {
    if (this.statusError !== null) throw this.statusError;
    const known = this.world.chain.applied.some((tx) => this.world.hashOf(tx) === txHash);
    const polls = (this.polls.get(txHash) ?? 0) + 1;
    this.polls.set(txHash, polls);
    if (!known || this.neverConfirm || polls <= this.confirmAfterPolls) return { confirmations: null };
    return { confirmations: this.confirmations };
  }
}
