// scripts/checks/lib/inflight.ts - what a check does with a transaction that it signed and did not see confirmed.
// The signed bytes are in the state file (`in_flight`). Before any step is built again, a run settles them:
//   - the indexer shows the transaction confirmed: the step is recorded as it was planned, and the transaction is let go;
//   - the validity and grace period ended without confirmation: return the transaction for reconciliation when requested; otherwise clear it for the legacy checks;
//   - it may still land: a dry run says until when; a submit run submits the same bytes again (the ledger takes a transaction once, so this is harmless) and waits.
// A part of a step (the Pay of a hire, which a hire of the kit makes inside one step) has a name with a colon, like `hire:pay`, and is kept as a note, not as a step.
import { duration, iso } from './format.ts';
import type { Clock, NodeAccess } from './ports.ts';
import { blake2b256Hex, decodeTransaction } from './platform.ts';
import { StateError } from './state.ts';
import type { InFlight, StateFile } from './state.ts';

/** After the end of its validity a transaction is let go only when this time has passed too: a node that is behind could still hold it. */
export const GRACE_MS = 60_000;

export interface SettleContext {
  state: StateFile;
  node: NodeAccess;
  clock: Clock;
  out(line: string): void;
  mode: 'dry' | 'submit';
  awaitMs: number;
  pollMs: number;
  /** Return an expired, unconfirmed transaction without clearing its state. */
  onExpired?: 'reconcile';
  /** Checks the recorded action just before resend. A refusal leaves the flight and reserve in place. */
  beforeResubmit?(flight: Readonly<Pick<InFlight, 'step' | 'tx_hash' | 'refs' | 'facts'>>, inputRefs: readonly string[]): Promise<void>;
}

export type SettleResult =
  | { kind: 'none' }
  | { kind: 'recorded'; step: string; txHash: string }
  | { kind: 'cleared'; step: string; reason: string }
  | { kind: 'reconcile'; flight: InFlight }
  | { kind: 'wait'; step: string; txHash: string; untilMs: number; message: string };

/** What a confirmed transaction leaves in the state file: a step, or the note of a part of a step. */
export interface Landed {
  step: string;
  tx_hash: string;
  refs: Record<string, string>;
  facts: Record<string, unknown>;
}

/** Records a confirmed transaction, and lets go of the one in flight. A step that is recorded already stays as it is. */
export function recordLanded(state: StateFile, landed: Landed, nowMs: number): void {
  const record = { confirmed_at: iso(nowMs), tx_hash: landed.tx_hash, refs: landed.refs, facts: landed.facts };
  if (landed.step.includes(':')) state.setNote(`part.${landed.step}`, record);
  else if (!state.confirmed(landed.step)) state.recordStep(landed.step, record);
  if (state.snapshot().in_flight !== null) state.clearInFlight();
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The confirmations that the indexer counts for a transaction, or null: not known, or the indexer cannot be read. */
async function confirmationsOf(node: NodeAccess, txHash: string): Promise<number | null> {
  try { return (await node.txStatus(txHash)).confirmations; } catch { return null; }
}

export async function settleInFlight(context: SettleContext): Promise<SettleResult> {
  const { state, node, clock, out } = context;
  const flight = state.snapshot().in_flight;
  if (flight === null) return { kind: 'none' };
  const landed: Landed = { step: flight.step, tx_hash: flight.tx_hash, refs: flight.refs, facts: flight.facts };
  const confirmed = async (): Promise<boolean> => {
    const confirmations = await confirmationsOf(node, flight.tx_hash);
    return confirmations !== null && confirmations >= 1;
  };
  if (await confirmed()) {
    recordLanded(state, landed, clock.now());
    out(`the transaction ${flight.tx_hash} of the step ${flight.step} is confirmed: the step is recorded`);
    return { kind: 'recorded', step: flight.step, txHash: flight.tx_hash };
  }
  const releaseAt = flight.valid_to + GRACE_MS;
  if (clock.now() > releaseAt) {
    if (context.onExpired === 'reconcile') return { kind: 'reconcile', flight };
    state.clearInFlight();
    const reason = `the transaction ${flight.tx_hash} of the step ${flight.step} was not confirmed, and its validity ended at ${iso(flight.valid_to)}: it cannot land any more, and the step can be built again`;
    out(reason);
    return { kind: 'cleared', step: flight.step, reason };
  }
  const waiting = (message: string): SettleResult => ({ kind: 'wait', step: flight.step, txHash: flight.tx_hash, untilMs: releaseAt, message });
  const may = `the transaction ${flight.tx_hash} of the step ${flight.step} was signed at ${iso(flight.signed_at)} and is not confirmed: it may land until ${iso(flight.valid_to)}`;
  if (context.mode === 'dry') return waiting(`${may}. Run with --submit to submit it again and wait for it`);
  if (context.beforeResubmit !== undefined) {
    let inputRefs: string[];
    try {
      const tx = decodeTransaction(flight.signed_cbor);
      const body = tx.body();
      if (!tx.is_valid() || blake2b256Hex(Buffer.from(body.to_cbor_hex(), 'hex')) !== flight.tx_hash) throw new Error();
      const inputs = body.inputs();
      inputRefs = [];
      for (let i = 0; i < inputs.len(); i += 1) {
        const input = inputs.get(i);
        inputRefs.push(`${input.transaction_id().to_hex()}#${input.index()}`);
      }
    } catch {
      throw new StateError('invalid', 'the in-flight bytes do not match the recorded transaction hash and valid phase');
    }
    await context.beforeResubmit({ step: flight.step, tx_hash: flight.tx_hash, refs: flight.refs, facts: flight.facts }, inputRefs);
  }
  let submitNote = '';
  try { await node.submit(flight.signed_cbor); } catch (err) { submitNote = ` (the submit of the same bytes said: ${errorText(err)})`; }
  const deadline = clock.now() + context.awaitMs;
  while (clock.now() < deadline) {
    await clock.sleep(context.pollMs);
    if (await confirmed()) {
      recordLanded(state, landed, clock.now());
      out(`the transaction ${flight.tx_hash} of the step ${flight.step} is confirmed: the step is recorded`);
      return { kind: 'recorded', step: flight.step, txHash: flight.tx_hash };
    }
  }
  return waiting(`${may}; it was not confirmed in ${duration(context.awaitMs)}${submitNote}. Run the step again after ${iso(releaseAt)} at the latest`);
}
