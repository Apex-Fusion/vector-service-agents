import { join } from 'node:path';
// These codecs and the minimum-output calculation are not exported by the package entries.
import { ledgerMinLovelace } from '../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
import { decodeIdentityDatum, decodeIdentitySpend, encodeIdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { IdentitySpend } from '../../../packages/vector-read/src/identity-codec.ts';
import { isCollateralOutput } from '../../checks/lib/collateral.ts';
import type { StepPlan } from '../../checks/lib/guards.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { VerificationError, VERIFY_WINDOW } from '../../checks/lib/verify.ts';
import type { IrreversibleTag } from './approval.ts';
import type { HostedBuild, LandHost, RecordFact, TaskSession } from './contract.ts';
import { readRunning, requireRuntimesFree, runtimesOf } from './free.ts';
import { landHosted } from './land-hosted.ts';
import { blake2b256Hex, decodeTransaction, effectiveStatus, findRecord, formatOutRef } from './platform.ts';
import type { RecordUtxo } from './platform.ts';
import { planOf } from './plan.ts';
import type { StepHandler } from './runner.ts';
import { holdsSecret } from './secrets.ts';

const ACTIONS = {
  vector_build_identity_end_subagents: 'BumpEpoch',
  vector_build_identity_revoke: 'Revoke',
  vector_build_identity_reclaim: 'Reclaim',
  vector_build_identity_change_controller: 'ChangeController',
  vector_build_identity_recovery_start: 'RecoverInit',
  vector_build_identity_recovery_complete: 'RecoverFinalize',
  vector_build_identity_retire: 'Retire',
  vector_build_identity_set_successor: 'SetSuccessor',
} as const satisfies Record<string, IdentitySpend['type']>;
const STATUSES = ['Active', 'Suspended', 'Revoked', 'Retired'] as const;
const IDENTIFIER = /^[0-9a-f]{64}$/;

type RecordReader = Pick<TaskSession, 'chain'>;

export async function readRecord(session: RecordReader, id: string): Promise<RecordUtxo> {
  const found = await findRecord(session.chain.provider, session.chain.deployment, id);
  if (found === null) throw new PreconditionError(`The record of did:vector:${id} is not on the node.`);
  return found;
}

/** Gives the first matching node result. A missing output is not a match. */
export async function awaitRecord(
  session: RecordReader & Pick<TaskSession, 'clock'>, id: string, predicate: (record: RecordUtxo) => boolean | Promise<boolean>,
  { windowMs = VERIFY_WINDOW.windowMs, pauseMs = VERIFY_WINDOW.pauseMs }: { windowMs?: number; pauseMs?: number } = {},
): Promise<RecordUtxo | null> {
  if (!Number.isSafeInteger(windowMs) || windowMs < 0 || !Number.isSafeInteger(pauseMs) || pauseMs < 1) throw new RangeError('Invalid record verification window.');
  const { clock, chain } = session;
  const deadline = clock.now() + windowMs;
  const boundedClock = { now: () => clock.now(), sleep: (ms: number) => clock.sleep(Math.min(ms, Math.max(0, deadline - clock.now()))) };
  const result = await eventually(boundedClock, { windowMs, pauseMs }, async () => {
    const found = await findRecord(chain.provider, chain.deployment, id);
    return { done: found !== null && await predicate(found) && clock.now() <= deadline, value: found };
  });
  return result.done ? result.value : null;
}

export function recordSpendPlan(
  session: Pick<LandHost, 'chain' | 'registry' | 'settings'>, { recordRef, extra }: { recordRef: string; extra?: { labels?: Readonly<Record<string, string>> } },
): StepPlan {
  return planOf(session, {
    destinations: [session.chain.deployment.identity.address], mint: {}, withdrawals: 0, explained: [recordRef],
    outflow: { fee: session.settings.maxFeeLovelace }, labels: extra?.labels,
  });
}

/** Identifies an enrolled record by its name in the data, not by its current output. */
export function recordFact(session: Pick<TaskSession, 'facts'>, name: string): RecordFact {
  const records = session.facts.read().records;
  const fact = records[name];
  if (fact === undefined) throw new PreconditionError(`The facts hold no record for ${name}. Register it first.`);
  if (!IDENTIFIER.test(fact.id) || fact.did !== `did:vector:${fact.id}` || Object.entries(records).some(([other, value]) => other !== name && value.id === fact.id)) {
    throw new PreconditionError(`The record fact for ${name} does not identify one DID.`);
  }
  return fact;
}

export interface RecordSpendBefore {
  readonly effective: (typeof STATUSES)[number];
  readonly subagentEpoch: number;
  readonly lovelace: string;
  readonly nowMs: number;
}

export interface VerifiedRecordSpend {
  readonly txHash: string;
  /** The time confirmation was first recorded. Use the datum for a time that the ledger fixes. */
  readonly at: string;
  readonly before: RecordSpendBefore;
  readonly record: RecordUtxo;
}

export interface RecordSpendSpec<Extra = unknown> {
  readonly step: string;
  readonly agentId: string;
  readonly tool: keyof typeof ACTIONS;
  readonly expectSigners: readonly string[];
  readonly irreversible?: IrreversibleTag;
  args(session: TaskSession<Extra>, record: RecordUtxo): Record<string, unknown>;
  before(record: RecordUtxo, session: TaskSession<Extra>): void | Promise<void>;
  after(record: RecordUtxo, session: TaskSession<Extra>, before: RecordSpendBefore): readonly string[] | Promise<readonly string[]>;
  /** Check the decoded unsigned output. Give a public reason to refuse it, or null. */
  checkBuild?(before: RecordUtxo, after: RecordUtxo, details: { action: IdentitySpend; validFrom: number; validTo: number }, session: TaskSession<Extra>): string | null;
  facts?(session: TaskSession<Extra>, landed: VerifiedRecordSpend): void;
  evidence(session: TaskSession<Extra>, before: RecordSpendBefore, after: RecordUtxo): Record<string, unknown> | Promise<Record<string, unknown>>;
}

const refOf = ({ utxo }: RecordUtxo): string => formatOutRef(utxo.txHash, utxo.outputIndex);

function snapshot(record: RecordUtxo, nowMs: number): RecordSpendBefore {
  return { effective: effectiveStatus(record.record, new Map(), nowMs, nowMs), subagentEpoch: record.record.subagentEpoch, lovelace: String(record.utxo.assets.lovelace), nowMs };
}

function isSnapshot(value: unknown): value is RecordSpendBefore {
  if (typeof value !== 'object' || value === null || !('effective' in value) || !('subagentEpoch' in value) || !('lovelace' in value) || !('nowMs' in value)) return false;
  return STATUSES.some((status) => status === value.effective) && typeof value.subagentEpoch === 'number' && Number.isSafeInteger(value.subagentEpoch) && value.subagentEpoch >= 0
    && typeof value.lovelace === 'string' && /^\d+$/.test(value.lovelace) && Number.isSafeInteger(value.nowMs);
}

function datumHashOf(record: RecordUtxo['record']): string {
  return blake2b256Hex(Buffer.from(encodeIdentityDatum(record), 'hex'));
}

function checkOutput(
  step: string, before: RecordUtxo, build: HostedBuild, facts: TxFacts,
  wanted: { action: IdentitySpend['type']; address: string; unit: string; fee: string; minimum: bigint | null },
) {
  const refuse = (message: string): never => { throw new GuardRefusal(step, [{ guard: 'body', ok: false, message }]); };
  const ref = refOf(before);
  if (!facts.inputs.includes(ref) || facts.collateralInputs.includes(ref)) refuse('The transaction does not spend the selected record as a regular input.');
  const outputs = facts.outputs.filter(({ address }) => address === wanted.address);
  if (outputs.length !== 1) refuse('A record spend must make exactly one output at the identity address.');
  const output = outputs[0]!;
  if (output.inlineDatum === null || output.hasScriptRef || output.assets[wanted.unit] !== 1n || Object.keys(output.assets).length !== 1) {
    return refuse('The record output does not hold only the selected identity token and an inline datum.');
  }
  if (facts.outputs.some((item) => item !== output && (item.address !== wanted.fee || item.inlineDatum !== null || item.datumHash !== null || item.hasScriptRef))
    || (facts.collateralReturn !== null && facts.collateralReturn.address !== wanted.fee)) {
    refuse('Payments outside the record output must return to the fee wallet.');
  }
  const record = decodeIdentityDatum(output.inlineDatum);
  if (record.lineage.type !== 'Root') refuse('The output of the selected root record is not a root record.');
  if (wanted.minimum === null) {
    if (output.lovelace < before.utxo.assets.lovelace) refuse('The record spend must keep its deposit.');
  } else if (output.lovelace !== wanted.minimum || datumHashOf(record) !== datumHashOf(before.record)) {
    refuse('A reclaim must keep the tombstone unchanged at the ledger minimum.');
  }
  const transaction = decodeTransaction(build.unsignedCbor);
  const redeemers = transaction.witness_set().redeemers()?.to_flat_format();
  if (redeemers === undefined || redeemers.len() !== 1) return refuse('A record spend must have one spend redeemer.');
  const redeemer = redeemers.get(0);
  // A spend index counts the normal inputs that precede the record by hash and output index.
  const index = facts.inputs.filter((input) => {
    const hash = input.slice(0, 64);
    return hash < before.utxo.txHash || (hash === before.utxo.txHash && Number(input.slice(65)) < before.utxo.outputIndex);
  }).length;
  if (redeemer.tag() !== 0 || redeemer.index() !== BigInt(index)) refuse('The selected record has no spend redeemer.');
  const action = decodeIdentitySpend(redeemer.data().to_cbor_hex());
  if (action.type !== wanted.action) refuse(`The record spend is not ${wanted.action}.`);
  const start = transaction.body().validity_interval_start();
  const end = facts.validityEndSlot;
  if (start === undefined || end === null || end <= start || end - start > 3_600n || build.validTo % 1_000 !== 0) {
    return refuse('The record spend has no valid time window.');
  }
  const found: RecordUtxo = { id: before.id, record, utxo: {
    txHash: facts.txHash, outputIndex: output.index, address: output.address, assets: { lovelace: output.lovelace, ...output.assets }, datum: output.inlineDatum,
  } };
  return { found, action, validFrom: build.validTo - Number(end - start) * 1_000, validTo: build.validTo };
}

/** Reads the resolver for evidence. It cannot confirm or refuse a spend. */
export async function resolverReading(session: Pick<TaskSession, 'hosted'>, did: string): Promise<Record<string, unknown>> {
  const message = (text: string): string => holdsSecret(text) || /[0-9a-f]{64,}|\b(?:authorization|token|password|api[_ -]?key)\b/i.test(text)
    ? 'The resolver message is not public.' : text.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300);
  try {
    const answer = await session.hosted.call('vector_resolve_did', { did });
    if (answer.failed) return { read: 'failed', message: message(answer.message) };
    const metadata = answer.json?.didDocumentMetadata;
    const status = metadata !== null && typeof metadata === 'object' && 'vectorStatus' in metadata ? metadata.vectorStatus : null;
    const effective = status !== null && typeof status === 'object' && 'effective' in status ? status.effective : null;
    const deactivated = metadata !== null && typeof metadata === 'object' && 'deactivated' in metadata ? metadata.deactivated : null;
    return { read: 'ok', effective: STATUSES.some((word) => typeof effective === 'string' && word.toLowerCase() === effective.toLowerCase()) ? effective : null,
      deactivated: typeof deactivated === 'boolean' ? deactivated : null };
  } catch (err) {
    return { read: 'unavailable', message: err instanceof Error ? message(err.message) : 'The resolver could not be read.' };
  }
}

/** The runner verifies a confirmed spend before another step can run. The saved output lets it resume without another build or signature. */
export function recordSpendStep<Extra>(spec: RecordSpendSpec<Extra>): StepHandler<Extra> {
  const { agentId, step, tool } = spec;
  return {
    name: step,
    async run(session) {
      if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
      if (session.state.snapshot().in_flight !== null) throw new PreconditionError('A transaction is in flight. Settle it before a record spend.');
      const agent = session.use.agents.find(({ id }) => id === agentId);
      if (agent === undefined) throw new PreconditionError(`The use case lists no agent ${agentId}.`);
      const fact = recordFact(session, agentId);
      const before = await readRecord(session, fact.id);
      if (before.record.lineage.type !== 'Root') throw new PreconditionError(`The record of ${agentId} is not a root record.`);
      await spec.before(before, session);
      const prior = snapshot(before, session.clock.now());
      const recordRef = refOf(before);
      const { address, hash } = session.chain.deployment.identity;
      const unit = `${hash}${fact.id}`;
      const fee = session.registry.addressOf('fee');
      const requireFree = () => requireRuntimesFree({
        fetchImpl: session.fetchImpl, runtimes: runtimesOf(agent), running: readRunning(join(session.settings.stateDir, 'running-images.json'), session.clock.now()), out: session.out,
      });
      await requireFree();
      const reclaim = ACTIONS[tool] === 'Reclaim';
      let minimum: bigint | null = null;
      if (reclaim) {
        if (prior.effective !== 'Revoked' && prior.effective !== 'Retired') throw new PreconditionError('The record is not Revoked or Retired.');
        const { lucid } = await session.chain.context(fee);
        minimum = ledgerMinLovelace(lucid, address, unit, encodeIdentityDatum(before.record));
        if (minimum >= before.utxo.assets.lovelace) throw new PreconditionError('The record has no deposit above the ledger minimum.');
      }
      if (!(await session.chain.provider.getUtxos(fee)).some(isCollateralOutput)) throw new PreconditionError('The fee wallet needs a pure collateral output of at least 5 units.');
      const notes = [`${step}: ${agentId} (${fact.did}); current status ${prior.effective}.`, `Expected signers: ${spec.expectSigners.join(', ')}.`];
      if (session.mode === 'dry') {
        for (const note of notes) session.out.out(note);
        session.out.out('No transaction was built.');
        return { kind: 'dry' };
      }
      let planned: RecordUtxo;
      const landed = await landHosted(session, {
        step, tool, args: { ...spec.args(session, before), changeAddress: fee, did: fact.did }, expectSigners: spec.expectSigners, irreversible: spec.irreversible, notes,
        beforeSign: async () => { await requireFree(); },
        plan: (build, facts) => {
          try {
            const checked = checkOutput(step, before, build, facts, { action: ACTIONS[tool], address, unit, fee, minimum });
            const problem = spec.checkBuild?.(before, checked.found, checked, session);
            if (problem) throw new GuardRefusal(step, [{ guard: 'body', ok: false, message: problem }]);
            planned = checked.found;
          } catch (err) {
            if (err instanceof GuardRefusal) throw err;
            throw new GuardRefusal(step, [{ guard: 'body', ok: false, message: 'The unsigned record spend could not be decoded.' }]);
          }
          return recordSpendPlan(session, { recordRef });
        },
        refs: () => ({ recordBefore: recordRef, recordAfter: refOf(planned) }),
        facts: () => ({ agent: agentId, did: fact.did, before: prior, datumHash: datumHashOf(planned.record), keptLovelace: String(planned.utxo.assets.lovelace) }),
      });
      return { kind: 'done', message: `${step} landed: ${landed.txHash}.` };
    },
    async verify(session, landed) {
      if (session.networkResult()?.ok !== true) throw new PreconditionError('The node did not pass the network guard.');
      const { did, id } = recordFact(session, agentId);
      const { agent, before, datumHash, keptLovelace } = landed.facts;
      const { recordAfter } = landed.refs;
      const txHash = landed.tx_hash;
      if (agent !== agentId || landed.facts.did !== did || !isSnapshot(before) || txHash === null || !IDENTIFIER.test(txHash)
        || typeof datumHash !== 'string' || !IDENTIFIER.test(datumHash) || typeof keptLovelace !== 'string' || !/^\d+$/.test(keptLovelace)
        || !recordAfter?.startsWith(`${txHash}#`)) {
        throw new VerificationError(`The state of ${step} does not describe a spend of the record of ${agentId}.`);
      }
      let problems: readonly string[] = ['The node does not show the confirmed record output.'];
      const after = await awaitRecord(session, id, async (record) => {
        if (refOf(record) !== recordAfter) return false;
        if (datumHashOf(record.record) !== datumHash || String(record.utxo.assets.lovelace) !== keptLovelace) {
          problems = ['The output on the node differs from the checked transaction.'];
          return false;
        }
        problems = await spec.after(record, session, before);
        return problems.length === 0;
      });
      if (after === null) throw new VerificationError(`${step}: ${problems.join(' ')} The step is not verified.`);
      spec.facts?.(session, { txHash, at: landed.confirmed_at, before, record: after });
      session.evidence.add({ step, status: 'verified', hosted: [], shows: {
        ...await spec.evidence(session, before, after), agent: agentId, did, txHash, before, after: snapshot(after, session.clock.now()),
      } });
    },
  };
}
