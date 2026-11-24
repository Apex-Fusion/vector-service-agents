import { isDeepStrictEqual } from 'node:util';
// The package entry does not export these rules of the identity builder.
import { windowAt } from '../../../packages/buyer-core/src/vendored/mcp/identity-chain.ts';
import { covers, hasRight, MAX_RANGE_MS, REASON_DISPUTE_VERDICT, REASON_KEY_COMPROMISE, REVOKE_REASONS, RIGHT, terminal, tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Party, Status } from '../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec, OrganisationSpec, TaskDefinition } from '../lib/contract.ts';
import { formatOutRef } from '../lib/platform.ts';
import { recordFact, recordSpendStep, resolverReading } from '../lib/record-spend.ts';
import { FlagError, runSteps } from '../lib/runner.ts';

const REVOKE = 'vector_build_identity_revoke';
const RECLAIM = 'vector_build_identity_reclaim';
const VALID_REASONS = REVOKE_REASONS.filter((reason) => reason !== REASON_DISPUTE_VERDICT);
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

interface Target { agent: AgentSpec; organisation: OrganisationSpec }
interface Extra { target: Target | null; by: string | null; reason: number | null; invalidFrom: number | null }

function timeOf(value: string): number {
  const fields = ISO_TIME.exec(value);
  const ms = Date.parse(value);
  if (fields !== null && Number.isSafeInteger(ms) && ms >= 0) {
    const [year, month, day, hour, minute, second] = fields.slice(1, 7).map(Number);
    const local = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    if (local.getUTCFullYear() === year && local.getUTCMonth() === month - 1 && local.getUTCDate() === day && local.getUTCHours() === hour
      && local.getUTCMinutes() === minute && local.getUTCSeconds() === second) return ms;
  }
  throw new FlagError('--invalid-from must be an ISO 8601 time with a zone and no more than three decimal places.');
}

function isAccountable(party: Party, hash: string, domainHex: string, lo: number, hi: number): boolean {
  return party.role === 'Accountable' && party.signer.type === 'KeyHash' && party.signer.hash === hash && party.organisation === domainHex
    && hasRight(party.rights, RIGHT.revoke) && covers(party, lo, hi);
}

function revokeStep(target: Target, by: string, reason: number, invalidFrom: number | null) {
  const agentId = target.agent.id;
  const domain = utf8Hex(target.organisation.domain);
  return recordSpendStep<Extra>({
    step: 'revoke', agentId, tool: REVOKE, expectSigners: [by, 'fee'], irreversible: 'record-revoke',
    args(session) {
      return { actor: { role: 'Accountable', signer: session.registry.hashOf(by) }, reason, ...(invalidFrom === null ? {} : { invalid_from: invalidFrom }) };
    },
    before(current, session) {
      if (terminal(current.record.status)) throw new PreconditionError('The record has ended.');
      const { lo, hi } = windowAt(session.clock.now());
      if (invalidFrom !== null && (invalidFrom < current.record.createdAt - MAX_RANGE_MS || invalidFrom > lo)) {
        throw new PreconditionError(`--invalid-from must be between one hour before record creation and the start of the validity window (${iso(lo)}).`);
      }
      const hash = session.registry.hashOf(by);
      if (!current.record.parties.some((party) => isAccountable(party, hash, domain, lo, hi))) {
        throw new PreconditionError(`The record does not give ${by} the Accountable revoke right for the validity window.`);
      }
    },
    checkBuild(before, after, { action, validFrom, validTo }, session) {
      const author = session.registry.hashOf(by);
      const party = action.type === 'Revoke' && action.actor.type === 'ByParty' ? before.record.parties[action.actor.index] : undefined;
      const status: Status = { type: 'Revoked', by: { type: 'KeyHash', hash: author }, reason, at: validFrom, invalidFrom, successor: null };
      if (party === undefined || !isAccountable(party, author, domain, validFrom, validTo) || (invalidFrom !== null && invalidFrom > validFrom)
        || !isDeepStrictEqual(after.record, tombstone(before.record, status)) || after.utxo.assets.lovelace !== before.utxo.assets.lovelace) {
        return 'The unsigned transaction does not make the requested revocation.';
      }
      return null;
    },
    after(after, session) {
      const { status } = after.record;
      return status.type === 'Revoked' && status.by.type === 'KeyHash' && status.by.hash === session.registry.hashOf(by)
        && status.reason === reason && status.invalidFrom === invalidFrom && status.successor === null ? [] : ['The node does not show the requested revocation.'];
    },
    facts(session, { txHash, record }) {
      const { status } = record.record;
      if (status.type !== 'Revoked') throw new Error('The verified record is not Revoked.');
      session.facts.put('revocations', [agentId], { tx: txHash, reason, invalidFrom: invalidFrom === null ? null : iso(invalidFrom), revokedAt: iso(status.at) });
    },
    async evidence(session, _before, after) {
      const { status } = after.record;
      if (status.type !== 'Revoked') throw new Error('The verified record is not Revoked.');
      return { by, reason, invalidFrom: invalidFrom === null ? null : iso(invalidFrom), revokedAt: iso(status.at),
        resolver: await resolverReading(session, recordFact(session, agentId).did) };
    },
  });
}

function reclaimStep(agentId: string) {
  return recordSpendStep<Extra>({
    step: `reclaim:${agentId}`, agentId, tool: RECLAIM, expectSigners: ['controller', 'fee'], args: () => ({}),
    before(current, session) {
      const { status, controller } = current.record;
      if (status.type !== 'Revoked') throw new PreconditionError('The record is not Revoked. The lifecycle task reclaims retired records.');
      if (controller !== session.registry.publicKeyOf('controller')) throw new PreconditionError('The controller key does not control the selected record.');
      const facts = session.facts.read();
      const fact = facts.revocations[agentId];
      const invalidFrom = status.invalidFrom === null ? null : iso(status.invalidFrom);
      if (fact === undefined || fact.reason !== status.reason || fact.invalidFrom !== invalidFrom || fact.revokedAt !== iso(status.at)) {
        throw new PreconditionError(`The pack holds no matching revocation fact for ${agentId}.`);
      }
      const revocation = session.state.step('revoke');
      const ref = formatOutRef(current.utxo.txHash, current.utxo.outputIndex);
      if (revocation?.tx_hash !== fact.tx || revocation.verified_at === null || revocation.refs.recordAfter !== ref) {
        throw new PreconditionError('Verify this record output in the revocation state before reclaiming its deposit.');
      }
    },
    after(after, _session, before) {
      return after.record.status.type === before.effective && after.utxo.assets.lovelace < BigInt(before.lovelace) ? [] : ['The tombstone did not release its surplus.'];
    },
  });
}

const task: TaskDefinition<Extra> = {
  name: 'revoke-record', title: 'Revoke an agent record and reclaim its surplus deposit', flags: [], valued: ['agent', 'by', 'reason', 'invalid-from'],
  needs: {
    keys(_use, flags) {
      const by = flags.value('by');
      return by !== undefined ? [by, 'fee'] : flags.value('agent') === undefined ? [] : ['controller', 'fee'];
    },
    chain: true, hosted: [REVOKE, RECLAIM, 'vector_resolve_did'], approval: 'submit',
  },
  steps: () => ['revoke'],
  parse(_env, _settings, use, flags) {
    if (flags.has('run')) throw new FlagError('Record revocation and reclaim take no --run label.');
    const id = flags.value('agent');
    let target: Target | null = null;
    if (id !== undefined) {
      const agent = use.agents.find((candidate) => candidate.id === id);
      if (agent === undefined) throw new FlagError(`--agent must name an agent in ${use.name}.`);
      if (agent.end.record !== 'revoked') throw new FlagError('The use case does not mark the selected record for revocation.');
      const organisation = use.organisations.find((candidate) => candidate.id === agent.organisation);
      if (organisation === undefined) throw new PreconditionError(`The use case lists no organisation for ${id}.`);
      target = { agent, organisation };
    }
    const by = flags.value('by') ?? null;
    if (by !== null && (by !== target?.organisation.accountableKey || by === 'controller' || by === 'fee')) {
      throw new FlagError('--by must name the Accountable key of the organisation of the selected agent.');
    }
    const value = flags.value('reason');
    const reason = value === undefined ? null : VALID_REASONS.find((code) => String(code) === value);
    if (reason === undefined) throw new FlagError(`--reason must be one of ${VALID_REASONS.join(', ')}.`);
    const time = flags.value('invalid-from');
    if (reason === REASON_KEY_COMPROMISE && time === undefined) throw new FlagError('Reason 1 needs --invalid-from.');
    return { target, by, reason, invalidFrom: time === undefined ? null : timeOf(time) };
  },
  async next(session) {
    const { target, by, reason, invalidFrom } = session.extra;
    if (target === null) throw new FlagError('To revoke a record, specify --agent.');
    if (by === null) throw new FlagError('To revoke a record, specify --by with its Accountable key.');
    if (reason === null) throw new FlagError('To revoke a record, specify --reason.');
    const agentId = target.agent.id;
    const recorded = session.state.step('revoke');
    if (recorded?.verified_at || (recorded === undefined && session.facts.read().revocations[agentId] !== undefined)) {
      throw new PreconditionError(`The revocation of ${agentId} is already recorded.`);
    }
    return runSteps(session, [revokeStep(target, by, reason, invalidFrom)]);
  },
  async cleanup(session) {
    const { target, by, reason, invalidFrom } = session.extra;
    if (target === null) throw new FlagError('To reclaim a deposit, specify --agent.');
    if (by !== null || reason !== null || invalidFrom !== null) throw new FlagError('Use only --agent to select a record for reclaim.');
    return runSteps(session, [reclaimStep(target.agent.id)]);
  },
  result(session) {
    const id = session.extra.target?.agent.id;
    if (id === undefined) return {};
    const facts = session.facts.read();
    return { agent: id, did: facts.records[id]?.did ?? null, revocation: facts.revocations[id] ?? null };
  },
};

export default task;
