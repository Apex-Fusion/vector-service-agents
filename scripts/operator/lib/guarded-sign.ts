// scripts/operator/lib/guarded-sign.ts - the guards of the landing, for a flow that the kit drives.
// `createModule1Port` of the kit builds a transaction with a provider, calls a SYNC `sign`, submits, and waits for the confirmation by itself. One call of the kit can sign more than one
// transaction (a claim is a document transaction and then the claim transaction), so `landTransaction` cannot wrap it. Two helpers do it:
//   - `recordingProvider` wraps the provider that the builders read through. It keeps every output that a read returns, by reference, and every transaction hash for which `awaitTx` resolved true.
//   - `guardedSign` gives the kit its `sign`. For each transaction it reads the facts of the bytes, takes the spent outputs from that record (an input that no read returned stops it), runs the
//     guards with the network result that the runner keeps, and, in submit mode, checks the approval and the cap, reserves the net outflow, signs with the one key of the plan, proves that the
//     body is the body that it judged, and writes the signed bytes into the state file as the transaction in flight BEFORE it returns them.
// After the kit returns, the task calls `recordKitLanding`. A message of this file names a step, a guard or a reference. It never shows a key, a token or a seed.
import { keyCredentialOf } from '../../checks/lib/addresses.ts';
import { iso, units } from '../../checks/lib/format.ts';
import { failed, neededSigners, runGuards } from '../../checks/lib/guards.ts';
import type { GuardName, GuardResult, RingView, StepPlan } from '../../checks/lib/guards.ts';
import { DryStop } from '../../checks/lib/hire-types.ts';
import { recordLanded } from '../../checks/lib/inflight.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { netRegistryOutflow, requireGo } from './approval.ts';
import type { GuardedSignRequest, LandHost } from './contract.ts';

/** A dry run built and judged the first transaction that the kit asked it to sign, and signed nothing. The task reads it as a dry result. (It is the `DryStop` of the checks: one class.) */
export { DryStop };

/** What a recording provider knows. `Utxo` is the output of Lucid, as the builders hold it. */
export interface Recorder {
  /** The output that a read of the provider returned for the reference `<transaction hash>#<index>`, as it was returned, or undefined when no read returned it. */
  seen(ref: string): Utxo | undefined;
  /** True when `awaitTx` resolved true for this transaction hash: the provider saw the transaction confirmed. */
  confirmed(txHash: string): boolean;
}

/** What `recordLanding` of the task gives: the step, the last transaction of the call, what the state file records for the step, and what the evidence entry shows. */
export interface KitLanding {
  readonly step: string;
  readonly txHash: string;
  readonly refs: Record<string, string>;
  readonly facts: Record<string, unknown>;
  readonly shows: Record<string, unknown>;
}

const MAX_STEP = 200;
/** The slot length of Vector: one second. The slot clock of the buyer code sets the same length. */
const SLOT_MS = 1000;
/** A transaction ends after now and at most one hour after now, as the landing of the pack holds a build to. The builders of the kit make a window of at most 59 minutes. */
const MAX_VALID_AHEAD_MS = 3_600_000;
/** A read of outputs: `getUtxos`, `getUtxosByOutRef`, `getUtxosWithUnit` and `getUtxoByUnit` of Lucid, and any read of the same family. */
const OUTPUT_READ = /^getUtxo/;

const refOf = (txHash: string, outputIndex: number): string => `${txHash.toLowerCase()}#${outputIndex}`;

/** An output of a provider: it has a transaction hash and an index. Any other value that a read returns is left out of the record. */
function isOutput(value: unknown): value is Utxo {
  return typeof value === 'object' && value !== null && 'txHash' in value && typeof value.txHash === 'string' && 'outputIndex' in value && typeof value.outputIndex === 'number' && Number.isInteger(value.outputIndex);
}

/**
 * A proxy of the provider that the builders read through. Every output that a read returns is kept as a copy (a later change of the output by a builder does not change the record), by its
 * reference. The latest read of a reference decides. Each transaction hash for which `awaitTx` resolved true is noted. Every other member passes through, bound to the provider.
 * The result has the members `seen` and `confirmed` of a `Recorder`.
 */
export function recordingProvider<P extends { getUtxos(...a: never[]): Promise<Utxo[]>; getUtxosByOutRef(...a: never[]): Promise<Utxo[]>; awaitTx(...a: never[]): Promise<boolean> }>(inner: P): P & Recorder {
  const outputs = new Map<string, Utxo>();
  const waited = new Set<string>();
  const keep = (found: unknown): void => {
    for (const item of Array.isArray(found) ? found : [found]) {
      if (isOutput(item)) outputs.set(refOf(item.txHash, item.outputIndex), structuredClone(item));
    }
  };
  const recorder: Recorder = {
    seen: (ref) => outputs.get(ref.toLowerCase()),
    confirmed: (txHash) => waited.has(txHash.toLowerCase()),
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === 'seen') return recorder.seen;
      if (property === 'confirmed') return recorder.confirmed;
      const member: unknown = Reflect.get(target, property, target);
      if (typeof member !== 'function') return member;
      if (typeof property === 'string' && OUTPUT_READ.test(property)) {
        return async (...args: unknown[]): Promise<unknown> => {
          const found: unknown = await member.apply(target, args);
          keep(found);
          return found;
        };
      }
      if (property === 'awaitTx') {
        return (...args: unknown[]): Promise<unknown> => Promise.resolve(member.apply(target, args)).then((done: unknown) => {
          if (done === true && typeof args[0] === 'string') waited.add(args[0].toLowerCase());
          return done;
        });
      }
      return member.bind(target);
    },
  }) as P & Recorder;
}

// ---- the summary ----

/**
 * The end of the validity of a transaction in POSIX ms, from its `ttl` slot and the start of the chain, or the reason that it cannot be accepted: no end, no start of the chain, an end that is
 * not after now (the transaction cannot land), or an end more than one hour after now (a transaction that is lost would hold its reserve far too long, or the slot clock of the builder is wrong).
 */
function validityOf(facts: TxFacts, systemStartMs: number | null, nowMs: number): { readonly validTo: number } | { readonly problem: string; readonly validTo?: number } {
  if (facts.validityEndSlot === null) return { problem: 'the transaction has no end of validity (no ttl), so it could land at any time, and the cap could not count it' };
  if (systemStartMs === null) return { problem: 'the network settings give no start time of the chain, so the end of the validity cannot be placed in time' };
  if (!Number.isFinite(nowMs)) return { problem: 'the clock gave no valid time, so the end of the validity cannot be checked' };
  const validTo = systemStartMs + Number(facts.validityEndSlot) * SLOT_MS;
  if (!Number.isSafeInteger(validTo)) return { problem: 'the end of the validity of the transaction is not a time that can be read' };
  if (validTo <= nowMs) return { problem: `the transaction is valid until ${iso(validTo)}, which is not after now, so it cannot land`, validTo };
  if (validTo > nowMs + MAX_VALID_AHEAD_MS) return { problem: `the transaction is valid until ${iso(validTo)}, more than one hour after now: a lost transaction would hold its reserve far too long, or the slot clock of the builder is wrong`, validTo };
  return { validTo };
}

function ownerOf(address: string, plan: StepPlan | null, ring: RingView): string {
  const credential = keyCredentialOf(address);
  if (credential !== null && ring.keyHashes().has(credential)) return `the ${ring.roleOf(credential)} wallet`;
  return plan?.labels?.[address] ?? address;
}

interface Summary {
  readonly mode: 'dry' | 'submit';
  readonly step: string;
  readonly facts: TxFacts;
  readonly read: ReadonlyMap<string, Utxo>;
  readonly needed: readonly string[];
  readonly results: readonly GuardResult[];
  readonly plan: StepPlan | null;
  readonly validTo: number | null;
  readonly net: bigint | null;
  readonly ring: RingView;
  readonly notes: readonly string[];
}

/** The lines that `landTransaction` prints, for a transaction that the kit built: the hash, the fee, the end of the validity, the net outflow, each input and output, the signers, the notes and the guards. */
function summaryLines(summary: Summary): string[] {
  const { facts, plan, ring } = summary;
  const lines = [
    `step ${summary.step}: ${summary.mode === 'dry' ? 'dry mode, nothing is signed or submitted' : 'submit mode, the transaction is signed here and the kit submits it'}`,
    `transaction: ${facts.txHash}`,
    `fee: ${units(facts.feeLovelace)}`,
    `valid until: ${summary.validTo === null ? 'not known' : iso(summary.validTo)}`,
  ];
  if (summary.net !== null) lines.push(`net outflow of the registry: ${units(summary.net)}`);
  const input = (ref: string): string => {
    const found = summary.read.get(ref);
    if (found === undefined) return `  ${ref}  (not read)`;
    const why = plan?.explained.has(ref) === true ? ' (explained by the state file)' : '';
    return `  ${ref}  ${units(found.assets.lovelace ?? 0n)}  ${ownerOf(found.address, plan, ring)}${why}`;
  };
  lines.push(`inputs (${facts.inputs.length}):`, ...facts.inputs.map(input));
  if (facts.collateralInputs.length > 0) lines.push(`collateral inputs (${facts.collateralInputs.length}):`, ...facts.collateralInputs.map(input));
  lines.push(`outputs (${facts.outputs.length}):`);
  for (const output of facts.outputs) {
    const assets = Object.entries(output.assets).map(([unit, quantity]) => `${quantity} of ${unit}`);
    lines.push(`  ${output.index + 1}. ${units(output.lovelace)} to ${ownerOf(output.address, plan, ring)}${assets.length > 0 ? `, with ${assets.join(', ')}` : ''}${output.inlineDatum === null ? '' : ', with an inline datum'}`);
  }
  if (Object.keys(facts.mint).length > 0) lines.push(`mints and burns: ${Object.entries(facts.mint).map(([unit, quantity]) => `${quantity} of ${unit}`).join(', ')}`);
  lines.push(`signers: ${summary.needed.length === 0 ? 'none' : summary.needed.map((keyHash) => `${ring.roleOf(keyHash) ?? 'unknown'} key ${keyHash}`).join(', ')}`);
  lines.push(...summary.notes);
  lines.push('guards:', ...summary.results.map((result) => `  ${result.ok ? 'ok  ' : 'FAIL'}  ${result.guard.padEnd(13)} ${result.message}`));
  return lines;
}

// ---- the guarded sign ----

/**
 * False only when the state file on disk shows that this transaction is not in flight. A write of the state file that failed can have replaced the file before it failed, and a transaction that is in
 * the file may be submitted again by the next run, so its reserve must stay. A file that cannot be read counts as "may be in flight".
 */
function mayBeInFlight(state: StateFile, txHash: string): boolean {
  try { return StateFile.peek(state.path)?.in_flight?.tx_hash === txHash; } catch { return true; }
}

function stepOf(request: GuardedSignRequest, facts: TxFacts): string {
  const step = typeof request.step === 'function' ? request.step(facts) : request.step;
  if (typeof step !== 'string' || step === '' || step.length > MAX_STEP) throw new PreconditionError(`the step name of a guarded signature is text of 1 to ${MAX_STEP} characters`);
  return step;
}

/**
 * The `sign` that `createModule1Port` takes. Each call judges one transaction, in this order:
 *   1. The facts of the bytes. The spent outputs and the collateral inputs come from `recorder`: an input that no read returned is a GuardRefusal, and nothing is signed.
 *   2. The guards of `runGuards` with the plan (`request.plan`, or its answer for these facts: the plan of THIS transaction only), and the network result that the runner keeps. A result that is
 *      missing or not ok is a refusal, and so is a transaction with no end of validity, an end that is not after now, and an end more than one hour after now. A failed guard is a GuardRefusal.
 *   3. In the dry mode: the summary is printed and a DryStop is thrown. Nothing is signed, reserved or written.
 *   4. In the submit mode: (a) the approval for this task, run wallet and tag; (b) the net outflow of the registry and the cap; (c) the signers that the bytes need are exactly the one signer of the
 *      plan; (d) a transaction in flight must be an earlier transaction of this call that the provider saw confirmed, and its step must have a colon: it is recorded as a part and let go,
 *      and any other transaction in flight is a refusal ("settle it first"); (e) the net outflow is reserved in the cap, the registry signs, the body of the signed bytes must be the body that
 *      was judged, and the signed bytes are written into the state file as the transaction in flight BEFORE they are returned.
 * A failure after the reserve and before the bytes are returned gives the reserve back: no signed bytes left this function, so the transaction cannot land.
 * The step names of one call differ: a name that an earlier transaction of the call used is refused, and so is a transaction that the call signed already.
 */
export function guardedSign(host: LandHost, request: GuardedSignRequest, recorder: Recorder): (unsignedCborHex: string) => { signedCborHex: string; txHashHex: string } {
  /** The transactions that this call signed: the hash, and the step. */
  const signedHere = new Map<string, string>();
  return (unsignedCborHex) => {
    const facts = factsOf(unsignedCborHex);
    const step = stepOf(request, facts);
    const ring = host.registry.ring;
    const network = host.networkResult();
    const networkResult: GuardResult = network === null ? { guard: 'network', ok: false, message: 'the network guard has not run, so nothing is signed' } : network;
    const refuse = (results: readonly GuardResult[], guard: GuardName, message: string): GuardRefusal => new GuardRefusal(step, [...results, { guard, ok: false, message }]);

    // 1. The spent outputs and the collateral inputs come from what the builders read.
    const read = new Map<string, Utxo>();
    const unread: string[] = [];
    for (const ref of [...facts.inputs, ...facts.collateralInputs]) {
      const found = recorder.seen(ref);
      if (found === undefined) unread.push(ref);
      else read.set(ref, found);
    }
    const notes = request.notes ?? [];
    if (unread.length > 0) {
      const results: GuardResult[] = [networkResult];
      const refusal = refuse(results, 'inputs', `an input was not read: ${[...new Set(unread)].join(', ')} (no read of the provider of this call returned it, so no guard can judge it)`);
      for (const line of summaryLines({ mode: host.mode, step, facts, read, needed: neededSigners(facts, [...read.values()]), results: refusal.results, plan: null, validTo: null, net: null, ring, notes })) host.out.out(line);
      throw refusal;
    }

    // 2. The guards, the network result and the end of the validity.
    const plan = typeof request.plan === 'function' ? request.plan(facts) : request.plan;
    const utxos = [...read.values()];
    const needed = neededSigners(facts, utxos);
    const net = netRegistryOutflow(facts, new Map(utxos.map((utxo) => [refOf(utxo.txHash, utxo.outputIndex), { address: utxo.address, lovelace: utxo.assets.lovelace ?? 0n }])), ring);
    const validity = validityOf(facts, host.settings.network.systemStartMs, host.clock.now());
    const results: GuardResult[] = [
      networkResult, ...runGuards({ facts, claims: { txHash: facts.txHash, feeLovelace: facts.feeLovelace }, inputs: utxos, plan, ring }),
      'problem' in validity ? { guard: 'body', ok: false, message: validity.problem } : { guard: 'body', ok: true, message: `the transaction is valid until ${iso(validity.validTo)}` },
    ];
    const validTo = validity.validTo ?? null;
    for (const line of summaryLines({ mode: host.mode, step, facts, read, needed, results, plan, validTo, net, ring, notes })) host.out.out(line);
    if (failed(results).length > 0) throw new GuardRefusal(step, results);

    // 3. The dry mode stops here: no signature, no reserve, no state.
    if (host.mode === 'dry') throw new DryStop(step);

    // 4. The submit mode. A transaction that this call signed is not signed twice, and each transaction of a call has a step name of its own.
    if (signedHere.has(facts.txHash)) throw new PreconditionError(`the transaction ${facts.txHash} of the step ${step} was signed already in this call`);
    if ([...signedHere.values()].includes(step)) throw new PreconditionError(`the step name ${step} was used by an earlier transaction of this call: give each transaction of a call a step name of its own`);
    //    (a) The approval.
    requireGo(host.go, { task: host.task, runWallet: host.registry.has('run') ? host.registry.addressOf('run') : null, nowMs: host.clock.now(), irreversible: request.irreversible === undefined ? [] : [request.irreversible] });
    //    (b) The cap.
    host.exposure.refuseOver(net);
    //    (c) The one signer of the plan.
    if (!host.registry.has(request.signer)) throw refuse(results, 'signers', `the plan names the signer ${request.signer}, and the registry holds no key named ${request.signer}`);
    const signerHash = host.registry.hashOf(request.signer);
    if (needed.length !== 1 || needed[0] !== signerHash) {
      const names = needed.map((keyHash) => ring.roleOf(keyHash) ?? keyHash);
      throw refuse(results, 'signers', `the transaction needs the signature of ${names.length === 0 ? 'no key' : names.join(', ')}, and the plan names ${request.signer}: the port signs with one key, so the two must be one and the same`);
    }
    //    (d) A transaction in flight: the earlier transaction of this call, seen confirmed, becomes a part. Any other is for the next run to settle.
    const flight = host.state.snapshot().in_flight;
    if (flight !== null) {
      if (signedHere.get(flight.tx_hash) !== flight.step) {
        throw new PreconditionError(`the step ${flight.step} is in flight (${flight.tx_hash}) and it is no transaction of this call: settle it first, and run the task again`);
      }
      if (!recorder.confirmed(flight.tx_hash)) {
        throw new PreconditionError(`the earlier transaction ${flight.tx_hash} of this call is not seen confirmed: the kit may sign a second transaction only after the wait for the first said true`);
      }
      if (!flight.step.includes(':')) {
        throw new PreconditionError(`the step ${flight.step} of the earlier transaction has no colon, so it cannot be recorded as a part: name the first transaction of a call that signs more than one with a colon, for example claim:document`);
      }
      recordLanded(host.state, { step: flight.step, tx_hash: flight.tx_hash, refs: flight.refs, facts: flight.facts }, host.clock.now());
    }
    //    (e) The reserve, the signature, the proof of the body, and the transaction in flight, before the bytes leave this function.
    host.exposure.reserve({ step, txHash: facts.txHash, netLovelace: net, at: iso(host.clock.now()) });
    let signed: string;
    try {
      signed = ring.sign(signerHash, unsignedCborHex);
      const after = factsOf(signed);
      if (after.bodyHex !== facts.bodyHex) throw refuse(results, 'signed_body', 'the body after the signature is not the body that was judged');
      if (after.witnesses.length !== 1 || after.witnesses[0] !== signerHash) throw refuse(results, 'signed_body', `the witnesses of the signed transaction are not the one key of the plan (${request.signer})`);
      // The validity guard passed, so the end of the validity is known here.
      host.state.setInFlight({ step, tx_hash: facts.txHash, signed_cbor: signed, valid_to: validTo!, signed_at: host.clock.now(), refs: request.refs ?? {}, facts: request.facts ?? {} });
    } catch (err) {
      // The reserve goes back only when no signed bytes can be in the state file: nothing left this function, so the transaction cannot land. If the release fails, the reserve stays (the safe side), and the error to report is the first one.
      if (!mayBeInFlight(host.state, facts.txHash)) {
        try { host.exposure.release(facts.txHash); } catch { /* the reserve stays */ }
      }
      throw err;
    }
    signedHere.set(facts.txHash, step);
    host.out.out(`signed by ${request.signer}; the body is the body that was judged`);
    return { signedCborHex: signed, txHashHex: facts.txHash };
  };
}

/**
 * Records the step of a kit call that landed: the state file keeps the step (a step with a colon is kept as a part), the transaction in flight is let go, and the evidence file gets the entry that
 * says what the step shows. The task calls it after the kit returned. The transaction in flight, when there is one, must be the transaction that is recorded: the one that the call signed last.
 * The step must be the name that the request gives to that transaction, so that the next run records the same step when the task dies before this call.
 */
export function recordKitLanding(host: LandHost, landed: KitLanding): void {
  const flight = host.state.snapshot().in_flight;
  if (flight !== null && flight.tx_hash !== landed.txHash) {
    throw new PreconditionError(`the transaction in flight is ${flight.tx_hash} of the step ${flight.step}, and the landing to record is ${landed.txHash}: record the transaction in flight, or settle it first`);
  }
  recordLanded(host.state, { step: landed.step, tx_hash: landed.txHash, refs: landed.refs, facts: landed.facts }, host.clock.now());
  host.evidence.add({ step: landed.step, status: 'confirmed', tx_hash: landed.txHash, shows: landed.shows });
}
