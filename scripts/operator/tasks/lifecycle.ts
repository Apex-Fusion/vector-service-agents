import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { decodeClaimDatum, soleTokenName, utxoOfKoiosRow } from '../../../packages/buyer-core/src/index.ts';
// The package entry does not export the identity build window, guardian rules or datum encoder.
import { windowAt } from '../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';
import { activeKey, DAYS_7_MS, eligibleGuardian, tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { decodeIdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
import { encodeIdentityDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Module1Provider } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { duration, iso } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import { VerificationError } from '../../checks/lib/verify.ts';
import type { AgentSpec, LifecycleSpec, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { blake2b256Hex, createModule1Port, effectiveStatus, formatOutRef, keyHashOf, koiosUtxoInfo, module1FromManifest, PURPOSE, readManifest } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import { readRecord, recordFact, recordSpendStep, resolverReading } from '../lib/record-spend.ts';
import type { RecordSpendSpec } from '../lib/record-spend.ts';
import { FlagError, runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';
import { readLiveClaims } from './claim.ts';

const CHANGE = 'change-controller';
const START = 'recovery-start';
const WAIT = 'recovery-wait';
const COMPLETE = 'recovery-complete';
const RETIRE = 'retire';
const SUCCESSOR = 'set-successor';
const RECLAIM = 'reclaim';
const STEPS = [CHANGE, START, WAIT, COMPLETE, RETIRE, SUCCESSOR, RECLAIM] as const;
type Step = (typeof STEPS)[number];
type Action = Exclude<Step, typeof WAIT>;
const TOOLS = {
  [CHANGE]: 'vector_build_identity_change_controller', [START]: 'vector_build_identity_recovery_start',
  [COMPLETE]: 'vector_build_identity_recovery_complete', [RETIRE]: 'vector_build_identity_retire',
  [SUCCESSOR]: 'vector_build_identity_set_successor', [RECLAIM]: 'vector_build_identity_reclaim',
} as const;
const IRREVERSIBLE = { [CHANGE]: 'controller-change', [COMPLETE]: COMPLETE, [RETIRE]: RETIRE, [SUCCESSOR]: 'successor' } as const;
const EARLY = 'earlyRecoveryCompletion';
const EARLY_TIMEOUT_MS = 15_000;
const BUILD_LEAD_MS = 60_000;
const MANIFEST_BASE = 'https://raw.githubusercontent.com/Apex-Fusion/vector-agent-modules';
const HISTORY_BYTES = 512 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const REF = /^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/;

interface Target { readonly lifecycle: LifecycleSpec; readonly agent: AgentSpec }
type Session = TaskSession<Target>;
const refOf = ({ utxo }: RecordUtxo): string => formatOutRef(utxo.txHash, utxo.outputIndex);
const datumHashOf = (record: IdentityDatum): string => blake2b256Hex(Buffer.from(encodeIdentityDatum(record), 'hex'));
const lowerBound = (time: number): number => windowAt(time).lo;

function requireNetwork(session: Session): void {
  if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
}

/** Read only the slot clock of the checked node. Do not substitute the operator clock for a missing tip. */
async function nodeTime(session: Session): Promise<number> {
  requireNetwork(session);
  try {
    const start = session.settings.network.systemStartMs ?? (await session.node.networkFacts()).systemStartMs;
    const { slot } = await session.node.networkTip();
    if (start === null || !Number.isSafeInteger(start) || start <= 0 || start % 1_000 !== 0 || !Number.isSafeInteger(slot) || slot < 0) throw new Error();
    const time = start + slot * 1_000;
    if (!Number.isSafeInteger(time) || Number.isNaN(new Date(time).getTime())) throw new Error();
    return time;
  } catch {
    throw new PreconditionError('The node did not give a usable tip time.');
  }
}

function active(record: RecordUtxo, lo: number, hi: number): boolean {
  return record.record.lineage.type === 'Root' && effectiveStatus(record.record, new Map(), lo, hi) === 'Active';
}

function assertController(session: Session, record: IdentityDatum, name: string): void {
  if (record.controller !== session.registry.publicKeyOf(name)) throw new PreconditionError(`The record controller does not match ${name}.`);
}

/** Each verified step has its own fact and follows the exact output of the previous step. */
function lastStep(session: Session): Step | null {
  const facts = session.facts.read().lifecycle;
  let last: Step | null = null;
  let previous: StepRecord | undefined;
  let gap = false;
  for (const step of STEPS) {
    const saved = session.state.step(step);
    const fact = facts[step];
    if (saved === undefined) {
      if (fact !== undefined) throw new PreconditionError(`The lifecycle fact for ${step} has no matching state.`);
      gap = true;
      continue;
    }
    const named = step === WAIT ? saved.refs.recoveryStart : saved.tx_hash;
    const output = saved.refs.recordAfter;
    if (gap || previous?.verified_at === null || (previous !== undefined && saved.refs.recordBefore !== previous.refs.recordAfter)
      || typeof named !== 'string' || !HASH.test(named) || !REF.test(output)
      || (step === WAIT ? saved.tx_hash !== null || named !== previous?.tx_hash || output !== previous?.refs.recordAfter : !output.startsWith(`${named}#`))
      || (fact !== undefined && (fact.tx !== named || !Number.isFinite(Date.parse(fact.at))
        || (step !== START && step !== WAIT && step !== RETIRE && fact.at !== saved.confirmed_at)
        || (step === WAIT && fact.at !== facts[START]?.at))) || (saved.verified_at !== null && fact === undefined)) {
      throw new PreconditionError(`The lifecycle state does not prove the order and facts for ${step}.`);
    }
    previous = saved;
    last = step;
  }
  return last;
}

function verified(session: Session, step: Step): StepRecord {
  const part = session.state.step(step);
  if (part === undefined || part.verified_at === null || session.facts.read().lifecycle[step] === undefined) {
    throw new PreconditionError(`Verify ${step} in this lifecycle run first.`);
  }
  return part;
}

function assertOutput(session: Session, step: Action, current: RecordUtxo): StepRecord {
  const saved = verified(session, step);
  const { address, hash } = session.chain.deployment.identity;
  if (saved.facts.agent !== session.extra.agent.id || saved.facts.did !== `did:vector:${current.id}` || saved.refs.recordAfter !== refOf(current)
    || saved.facts.datumHash !== datumHashOf(current.record) || saved.facts.keptLovelace !== String(current.utxo.assets.lovelace)
    || current.utxo.address !== address || current.utxo.assets[`${hash}${current.id}`] !== 1n || Object.keys(current.utxo.assets).length !== 2
    || current.utxo.scriptRef != null || current.record.lineage.type !== 'Root') {
    throw new PreconditionError(`The node record does not match the verified output of ${step}.`);
  }
  return saved;
}

function pendingOf(session: Session, current: RecordUtxo) {
  const start = assertOutput(session, START, current);
  const { pendingRecovery: pending } = current.record;
  const [first, second] = session.extra.lifecycle.controllers;
  assertController(session, current.record, first);
  if (pending === null || pending.newController !== session.registry.publicKeyOf(second)
    || !Number.isSafeInteger(pending.effectiveAfter) || session.facts.read().lifecycle[START]?.at !== iso(pending.effectiveAfter)) {
    throw new PreconditionError('The node does not show the verified pending recovery for this run.');
  }
  return { pending, start };
}

function guardianIndices(session: Session, record: IdentityDatum, lo: number, hi: number): number[] | null {
  const { lifecycle, agent } = session.extra;
  if (record.guardianThreshold !== agent.guardianThreshold || record.guardianThreshold !== lifecycle.guardians.length) return null;
  const indices: number[] = [];
  for (const name of lifecycle.guardians) {
    const hash = session.registry.hashOf(name);
    const enrolled = agent.parties.find(({ role, signer }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name);
    if (enrolled === undefined) return null;
    const organisation = enrolled.organisation === null ? null : utf8Hex(enrolled.organisation);
    const found = record.parties.flatMap((party, index) => party.role === 'Guardian' && party.signer.type === 'KeyHash' && party.signer.hash === hash && party.organisation === organisation ? [index] : []);
    if (found.length !== 1 || indices.includes(found[0]!) || !eligibleGuardian(record.parties[found[0]!]!, lo, hi)) return null;
    indices.push(found[0]!);
  }
  return indices;
}

/** An absent node output must also have a historical row that proves what was spent. */
async function spentOutputs(session: Session, refs: string[]): Promise<Map<string, Awaited<ReturnType<typeof koiosUtxoInfo>>[number]>> {
  if (refs.some((ref) => !REF.test(ref)) || new Set(refs).size !== refs.length) throw new PreconditionError('The closeout facts do not identify distinct outputs.');
  if (refs.length === 0) return new Map();
  let rows: Awaited<ReturnType<typeof koiosUtxoInfo>>;
  try {
    if ((await session.node.resolveInputs(refs)).length !== 0) throw new PreconditionError('A recorded advert or claim output is still live on the node.');
    rows = await koiosUtxoInfo(session.chain.koiosUrl, refs, session.chain.fetchImpl, HISTORY_BYTES);
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The historical advert or claim outputs could not be read.');
  }
  const byRef = new Map(rows.map((row) => [`${row?.tx_hash}#${row?.tx_index}`, row]));
  if (rows.length !== refs.length || refs.some((ref) => byRef.get(ref)?.is_spent !== true)) {
    throw new PreconditionError('The ledger does not show every recorded advert and claim output as spent.');
  }
  return byRef;
}

async function requireClosed(session: Session, current: RecordUtxo): Promise<void> {
  const { agent } = session.extra;
  const facts = session.facts.read();
  const adverts = facts.adverts[agent.id] ?? {};
  if (agent.adverts.some(({ model }) => adverts[model] === undefined)) throw new PreconditionError('The facts do not identify every advert of the retiring agent.');
  const claims = Object.values(facts.claims).flatMap((byAgent) => byAgent[agent.id] === undefined ? [] : [byAgent[agent.id]!]);
  if (claims.some(({ claimRef, claimTx, claimToken, withdrawTx }) => !HASH.test(claimTx) || !claimRef.startsWith(`${claimTx}#`) || !HASH.test(claimToken)
    || (withdrawTx !== 'not open' && (withdrawTx === null || !HASH.test(withdrawTx))))) {
    throw new PreconditionError('A claim of the retiring agent has no valid closeout fact.');
  }
  const commit = session.settings.module1Commit;
  if (commit === null) throw new PreconditionError('Set OPERATOR_MODULE1_COMMIT to check the claim deployment before retirement.');
  const source = `${MANIFEST_BASE}/${commit}/${session.use.moduleManifestPath}`;
  const { chain } = session;
  const advertAddress = chain.deployment.advert.address;
  const rows = await spentOutputs(session, [...Object.values(adverts).map(({ ref }) => ref), ...claims.map(({ claimRef }) => claimRef)]);
  try {
    for (const [model, fact] of Object.entries(adverts)) {
      const row = rows.get(fact.ref);
      const datum = typeof row?.inline_datum?.bytes === 'string' ? decodeIdentityAdvertDatum(row.inline_datum.bytes) : null;
      if (row?.address !== advertAddress || !HASH.test(fact.tx) || !fact.ref.startsWith(`${fact.tx}#`) || datum === null || datum.agent_id !== current.id
        || datum.model !== model || datum.capability_id !== agent.capability || datum.detail_uri !== fact.detailUri || datum.detail_hash !== fact.detailHash
        || datum.endpoint_url !== fact.endpoint || datum.status !== 'Active' || !activeKey(current.record, datum.supplier_pkh, PURPOSE.transaction)) {
        throw new PreconditionError('A spent advert does not match the recorded advert of the retiring agent.');
      }
    }
    // A new advert can replace a spent output. Check every advert at the address, not only the references in the facts.
    for (const output of await chain.provider.getUtxos(advertAddress)) {
      if (output.address !== advertAddress) throw new Error();
      if (typeof output.datum !== 'string') continue;
      let datum: ReturnType<typeof decodeIdentityAdvertDatum>;
      try { datum = decodeIdentityAdvertDatum(output.datum); } catch { continue; }
      if (datum.agent_id === current.id && datum.status === 'Active') throw new PreconditionError('The retiring agent still has an Active advert on the node.');
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The node or archive did not give usable advert evidence.');
  }
  try {
    const module1 = module1FromManifest(await readManifest(source, 'The Module-1 manifest', session.fetchImpl), source);
    if (module1.identityHash !== chain.deployment.identity.hash) throw new PreconditionError('The claim deployment does not use this identity registry.');
    for (const claim of claims) {
      const original = utxoOfKoiosRow(rows.get(claim.claimRef));
      if (original === null || soleTokenName(original, module1.claim.address, module1.claim.hash) !== claim.claimToken
        || typeof original.datum !== 'string' || decodeClaimDatum(original.datum).claimerDid !== current.id) {
        throw new PreconditionError('A spent claim does not match its recorded agent and claim token.');
      }
    }
    const provider = chain.provider as Partial<Module1Provider>;
    if (typeof provider.getSystemStartMs !== 'function') throw new Error();
    const port = createModule1Port({ provider: provider as Module1Provider, module1, address: session.registry.addressOf('fee'), agent_id: current.id,
      sign: () => { throw new Error('The claim closeout check signs nothing.'); }, clock: () => session.clock.now(), sleep: (ms) => session.clock.sleep(ms),
      koios_url: chain.koiosUrl, fetch: chain.fetchImpl, identity_deployment: null });
    const tokens = new Set(claims.map(({ claimToken }) => claimToken));
    if ((await readLiveClaims(port)).some((claim) => claim.claimer === `did:vector:${current.id}` || tokens.has(claim.token))) {
      throw new PreconditionError('The retiring agent still has a live or moved claim on the node.');
    }
  } catch (error) {
    if (error instanceof PreconditionError) throw error;
    throw new PreconditionError('The node or archive did not give usable claim evidence.');
  }
}

const earlyMessage = (due: number): string => `The build tool refused recovery completion before ${iso(due)}. No transaction was signed.`;

/** Store the attempt before the call. Only the exact, bounded refusal clears the evidence gate. */
async function proveEarlyRefusal(session: Session, start: StepRecord, pending: NonNullable<IdentityDatum['pendingRecovery']>, tip: number): Promise<void> {
  const due = pending.effectiveAfter;
  const checkpoint = { tx: start.tx_hash, effectiveAfter: due };
  const message = earlyMessage(due);
  const note = session.state.note(EARLY);
  const proven = session.evidence.entries().some((entry) => entry.step === WAIT && entry.status === 'tool_refused' && entry.expected === true && entry.tool === TOOLS[COMPLETE] && entry.message === message);
  if (note !== undefined || proven) {
    if (proven && isDeepStrictEqual(note, checkpoint)) return;
    throw new PreconditionError('The early build attempt has no matching refusal evidence. It is not repeated.');
  }
  if (session.mode !== 'submit' || session.clock.now() >= due || tip >= due) {
    throw new PreconditionError('The early recovery check must run with --submit before the recovery opens. No build was requested.');
  }
  session.state.setNote(EARLY, checkpoint);
  const timeout = new AbortController();
  try {
    const answer = await Promise.race([
      session.hosted.call(TOOLS[COMPLETE], { changeAddress: session.registry.addressOf('fee'), did: recordFact(session, session.extra.agent.id).did }),
      delay(EARLY_TIMEOUT_MS, undefined, { signal: timeout.signal, ref: false }).then(() => { throw new Error('The early build timed out.'); }),
    ]);
    const expected = `Failed to build recovery completion: The recovery to the controller key ${keyHashOf(pending.newController)} opens at ${iso(due)}. The validity window must start at or after that time, so build it at or after ${iso(due + BUILD_LEAD_MS)}.`;
    if (!answer.failed || answer.json !== null || answer.text.length > 4_096 || answer.text.includes('```') || answer.text.split('\n', 1)[0] !== expected) {
      throw new VerificationError('The build tool did not give the expected early recovery refusal. Nothing was signed.');
    }
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('The early recovery build call did not return a usable refusal. Nothing was signed.');
  } finally {
    timeout.abort();
  }
  session.evidence.add({ step: WAIT, status: 'tool_refused', expected: true, tool: TOOLS[COMPLETE], message });
}

function waitStep(agent: AgentSpec): StepHandler<Target> {
  return {
    name: WAIT,
    async run(session) {
      const tip = await nodeTime(session);
      const fact = recordFact(session, agent.id);
      const record = await readRecord(session, fact.id);
      const { pending, start } = pendingOf(session, record);
      const due = pending.effectiveAfter;
      if (session.mode === 'submit') await proveEarlyRefusal(session, start, pending, tip);
      const remaining = Math.max(due - tip, due - lowerBound(session.clock.now()));
      if (remaining > 0) return { kind: 'wait', untilMs: due, message: `Recovery opens at ${iso(due)}. At least ${duration(remaining)} remain for the node and build window. Build from ${iso(due + BUILD_LEAD_MS)}.` };
      if (session.mode === 'dry') return { kind: 'dry' };
      const ref = refOf(record);
      session.state.recordStep(WAIT, { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: { recordBefore: ref, recordAfter: ref, recoveryStart: start.tx_hash! },
        facts: { agent: agent.id, effectiveAfter: due } });
      return { kind: 'done', message: `The recovery window that opens at ${iso(due)} has passed.` };
    },
    async verify(session, saved) {
      const tip = await nodeTime(session);
      const { pending, start } = pendingOf(session, await readRecord(session, recordFact(session, agent.id).id));
      const due = pending.effectiveAfter;
      if (saved.tx_hash !== null || saved.refs.recoveryStart !== start.tx_hash || saved.refs.recordBefore !== start.refs.recordAfter || saved.refs.recordAfter !== start.refs.recordAfter
        || saved.facts.agent !== agent.id || saved.facts.effectiveAfter !== due || tip < due || lowerBound(session.clock.now()) < due) {
        throw new VerificationError('The recorded wait does not match the pending recovery and the node time.');
      }
      await proveEarlyRefusal(session, start, pending, tip);
      if (!session.evidence.entries().some((entry) => entry.step === WAIT && entry.status === 'verified')) {
        session.evidence.add({ step: WAIT, status: 'verified', hosted: [], shows: {
          agent: agent.id, recoveryStart: start.tx_hash, record: saved.refs.recordAfter, effectiveAfter: iso(due), nodeAt: iso(tip),
        } });
      }
      session.facts.put('lifecycle', [WAIT], { tx: start.tx_hash, at: iso(due) });
    },
  };
}

function actionStep(target: Target, step: Action): StepHandler<Target> {
  const { agent, lifecycle } = target;
  const [first, second] = lifecycle.controllers;
  const from = { [CHANGE]: null, [START]: CHANGE, [COMPLETE]: START, [RETIRE]: COMPLETE, [SUCCESSOR]: RETIRE, [RECLAIM]: SUCCESSOR } as const;
  const signers = { [CHANGE]: ['controller', first], [START]: [...lifecycle.guardians, second], [COMPLETE]: [], [RETIRE]: [second],
    [SUCCESSOR]: [second, 'controller'], [RECLAIM]: [second] };
  const tag = step === CHANGE || step === COMPLETE || step === RETIRE || step === SUCCESSOR ? IRREVERSIBLE[step] : undefined;
  let successor: RecordUtxo | undefined;
  return recordSpendStep<Target>({
    step, agentId: agent.id, tool: TOOLS[step], expectSigners: [...signers[step], 'fee'], ...(tag === undefined ? {} : { irreversible: tag }),
    args(session) {
      if (step === CHANGE) return { new_controller: session.registry.publicKeyOf(first) };
      if (step === START) return { new_controller: session.registry.publicKeyOf(second), guardians: lifecycle.guardians.map((name) => session.registry.hashOf(name)) };
      if (step === SUCCESSOR) return { successor: recordFact(session, lifecycle.successor).did };
      return {};
    },
    async before(current, session) {
      const previous = from[step];
      if (previous !== null) assertOutput(session, previous, current);
      const record = current.record;
      const { lo, hi } = windowAt(session.clock.now());
      assertController(session, record, step === CHANGE ? 'controller' : step === START || step === COMPLETE ? first : second);
      if (step === SUCCESSOR || step === RECLAIM) {
        const next = step === RECLAIM ? recordFact(session, lifecycle.successor).id : null;
        if (record.status.type !== 'Retired' || record.status.successor !== next) throw new PreconditionError('The record is not the required retired tombstone.');
        if (step === SUCCESSOR) {
          successor = await readRecord(session, recordFact(session, lifecycle.successor).id);
          if (!active(successor, lo, hi)) throw new PreconditionError('The successor is not an Active root record for the build window.');
          assertController(session, successor.record, 'controller');
        }
        return;
      }
      if (!active(current, lo, hi)) throw new PreconditionError('The retiring agent record is not Active for the build window.');
      if (step === COMPLETE) {
        const wait = verified(session, WAIT);
        const { pending, start } = pendingOf(session, current);
        if (wait.refs.recoveryStart !== start.tx_hash || wait.facts.effectiveAfter !== pending.effectiveAfter
          || session.facts.read().lifecycle[WAIT]?.at !== iso(pending.effectiveAfter)
          || lo < pending.effectiveAfter || await nodeTime(session) < pending.effectiveAfter) {
          throw new PreconditionError('Recovery completion is not yet allowed by the node and the build window.');
        }
      } else if (record.pendingRecovery !== null) throw new PreconditionError('An unexpected recovery is pending on the record.');
      if (step === START && guardianIndices(session, record, lo, hi) === null) {
        throw new PreconditionError('The enrolled guardians do not meet the record threshold and recover rights for the build window.');
      }
      if (step === RETIRE) await requireClosed(session, current);
    },
    checkBuild(before, after, checked, session) {
      const { action, validFrom: lo, validTo: hi, referenceInputs } = checked;
      const record = before.record;
      let expected: IdentityDatum;
      if (step !== SUCCESSOR && step !== RECLAIM && !active(before, lo, hi)) return 'The agent is not Active for the transaction validity window.';
      switch (step) {
        case CHANGE:
          expected = { ...record, controller: session.registry.publicKeyOf(first), subagentEpoch: record.subagentEpoch + 1 };
          break;
        case START: {
          const guardians = guardianIndices(session, record, lo, hi);
          if (guardians === null || action.type !== 'RecoverInit' || action.guardians.length !== guardians.length
            || new Set(action.guardians).size !== guardians.length || action.guardians.some((index) => !guardians.includes(index))) return 'The recovery does not use exactly the enrolled guardians for the transaction validity window.';
          expected = { ...record, pendingRecovery: { newController: session.registry.publicKeyOf(second), effectiveAfter: hi + DAYS_7_MS } };
          break;
        }
        case COMPLETE:
          if (record.pendingRecovery === null || lo < record.pendingRecovery.effectiveAfter) return 'The signed validity window would start before recovery opens.';
          expected = { ...record, controller: session.registry.publicKeyOf(second), pendingRecovery: null, subagentEpoch: record.subagentEpoch + 1 };
          break;
        case RETIRE:
          expected = tombstone(record, { type: 'Retired', at: lo, successor: null });
          break;
        case SUCCESSOR:
          if (record.status.type !== 'Retired' || successor === undefined || !referenceInputs.includes(refOf(successor))
            || !active(successor, lo, hi) || successor.record.controller !== session.registry.publicKeyOf('controller')) return 'The transaction does not reference the verified Active successor and its controller.';
          expected = { ...record, status: { ...record.status, successor: successor.id } };
          break;
        case RECLAIM:
          return null; // The shared guard checks the unchanged tombstone, exact ledger minimum and positive credit.
      }
      return isDeepStrictEqual(after.record, expected) && after.utxo.assets.lovelace === before.utxo.assets.lovelace ? null : `The unsigned output does not make only the requested ${step} change and preserve the deposit.`;
    },
    after(record, session, before) {
      const { status, controller, pendingRecovery, subagentEpoch } = record.record;
      const expected = step === CHANGE || step === START ? first : second;
      if (controller !== session.registry.publicKeyOf(expected) || subagentEpoch !== before.subagentEpoch + (step === CHANGE || step === COMPLETE ? 1 : 0)) {
        return ['The node does not show the intended controller and subagent epoch.'];
      }
      if (step === START ? pendingRecovery?.newController !== session.registry.publicKeyOf(second) : pendingRecovery !== null) return ['The node does not show the intended recovery state.'];
      if (step === RETIRE || step === SUCCESSOR || step === RECLAIM) {
        const next = step === RETIRE ? null : recordFact(session, lifecycle.successor).id;
        if (status.type !== 'Retired' || status.successor !== next) return ['The node does not show the intended tombstone and successor.'];
      }
      return [];
    },
    facts(session, { txHash, at, record }) {
      const { pendingRecovery, status } = record.record;
      const time = step === START ? iso(pendingRecovery!.effectiveAfter) : step === RETIRE && status.type === 'Retired' ? iso(status.at) : at;
      session.facts.put('lifecycle', [step], { tx: txHash, at: time });
    },
    async evidence(session, _before, record) {
      const { pendingRecovery, status } = record.record;
      const detail = { controller: step === CHANGE || step === START ? first : second, effectiveAfter: pendingRecovery === null ? null : iso(pendingRecovery.effectiveAfter),
        successor: status.type === 'Retired' && status.successor !== null ? `did:vector:${status.successor}` : null };
      return { ...detail, resolver: await resolverReading(session, recordFact(session, agent.id).did),
        ...(step === SUCCESSOR ? { successorResolver: await resolverReading(session, recordFact(session, lifecycle.successor).did) } : {}) };
    },
  } satisfies RecordSpendSpec<Target>);
}

const task: TaskDefinition<Target> = {
  name: 'lifecycle', title: 'Change, recover and close an agent record', flags: [], valued: [],
  needs: { keys: (use) => [...new Set(['controller', 'fee', ...(use.lifecycle?.controllers ?? []), ...(use.lifecycle?.guardians ?? [])])],
    chain: true, hosted: [...Object.values(TOOLS), 'vector_resolve_did'], approval: 'submit' },
  steps: () => STEPS,
  parse(_env, _settings, use, flags) {
    if (flags.value('run') !== 'l1') throw new FlagError('The lifecycle task requires --run l1.');
    const lifecycle = use.lifecycle;
    if (lifecycle === null) throw new PreconditionError('This use case has no lifecycle run.');
    const agent = use.agents.find(({ id }) => id === lifecycle.agent);
    if (agent === undefined || agent.end.record !== 'retired' || agent.end.advert !== 'retired' || agent.end.successor !== lifecycle.successor
      || agent.adverts.length === 0 || use.subagents.some(({ parent }) => parent === agent.id) || !use.records.some(({ id }) => id === lifecycle.successor)
      || agent.id === lifecycle.successor || !use.runs.some(({ id, subject }) => id === 'lifecycle' && subject === agent.id) || lifecycle.waitMs !== DAYS_7_MS) {
      throw new PreconditionError('The lifecycle data does not identify one retirement and its successor.');
    }
    const authorities = [...lifecycle.controllers, ...lifecycle.guardians];
    if (new Set(authorities).size !== 4 || lifecycle.controllers.includes('controller') || !lifecycle.guardians.includes('controller')
      || agent.guardianThreshold !== 2 || authorities.some((name) => ['fee', 'run', 'provider'].includes(name) || !use.keys.some(({ name: key }) => key === name))
      || lifecycle.guardians.some((name) => !agent.parties.some(({ role, signer, rights }) => role === 'Guardian' && signer.kind === 'key' && signer.key === name && (rights === null || rights.includes('recover'))))) {
      throw new PreconditionError('The lifecycle data does not enroll two independent next controllers and two key guardians with the recover right.');
    }
    return { agent, lifecycle };
  },
  async next(session) {
    const last = lastStep(session);
    const { agent } = session.extra;
    if (last === RECLAIM && session.state.step(RECLAIM)?.verified_at !== null) {
      requireNetwork(session);
      assertOutput(session, RECLAIM, await readRecord(session, recordFact(session, agent.id).id));
    }
    return runSteps(session, STEPS.map((step) => step === WAIT ? waitStep(agent) : actionStep(session.extra, step)));
  },
  async status(session) {
    const last = lastStep(session);
    const facts = session.facts.read().lifecycle;
    const lines = STEPS.map((step) => {
      const fact = facts[step];
      return `${step}: ${fact === undefined || session.state.step(step)?.verified_at == null ? 'no verified fact' : `${fact.tx} at ${fact.at}`}`;
    });
    if (last === null || session.state.snapshot().in_flight !== null || session.state.step(last)?.verified_at === null) return lines;
    requireNetwork(session);
    const current = await readRecord(session, recordFact(session, session.extra.agent.id).id);
    if (last === START || last === WAIT) {
      const pending = pendingOf(session, current).pending;
      const remaining = Math.max(0, pending.effectiveAfter - await nodeTime(session), pending.effectiveAfter - lowerBound(session.clock.now()));
      lines.push(`Recovery opens at ${iso(pending.effectiveAfter)}. ${duration(remaining)} remain for the node and build window.`);
    } else assertOutput(session, last, current);
    return lines;
  },
  async cleanup() { return { kind: 'done', message: 'The steps of a lifecycle are permanent. There is nothing to take back.' }; },
  result: (session) => ({ agent: session.extra.agent.id, lifecycle: session.facts.read().lifecycle }),
};

export default task;
