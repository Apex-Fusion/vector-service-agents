// scripts/checks/lib/check-attestations.ts - check 4: attestations about the test record, with salted digests, read back by the hosted tools.
//
//   issue_approval  The member key issues an attestation of type 5 (approval) about the test record. The digest is SHA-256(salt ++ document), with a salt of 32 random bytes.
//   issue_binding   The member key issues an attestation of type 4 (principal binding), the same way, with its own salt and document.
//   read_check      The hosted tools read both attestations, list the ones about the record, and check each against what the issuer said. A check with the salted digest must pass.
//                   A check with the digest of the document alone, with no salt, must fail: that is what the salt is for.
//
// The salt and the document stay off the chain. They are in the state file (mode 600), so that the owner can show them or delete them. Each attestation locks a deposit of 5 units.
// The ledger lets the issuer withdraw the deposit 90 days after `valid_until`. The step `cleanup` withdraws what is due and says the date for the rest.
import { createHash, randomBytes } from 'node:crypto';
import { iso, units } from './format.ts';
import type { StepPlan } from './guards.ts';
import { requireRecord } from './record.ts';
import { runSteps } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { commitStep, stepPlan } from './session.ts';
import type { Session, StepOutcome } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';
import { ATT_TYPES, buildAttest, buildWithdrawAttestation } from './platform.ts';
import { verifyWithTools } from './verify.ts';
import type { ToolCheck } from './verify.ts';

export interface AttestationSettings {
  /** How long each attestation is valid, in hours, from its issue. The ledger allows at most 366 days. */
  validHours: number;
}

const DAY_MS = 86_400_000;
/** The wait after `valid_until` before the issuer can withdraw (the rule of the attestation script). */
export const WITHDRAW_WAIT_MS = 90 * DAY_MS;

export function parseAttestationSettings(env: Env): AttestationSettings {
  const reader = new EnvReader(env);
  const validHours = Number(reader.whole('CHECKS_ATTESTATION_VALID_HOURS', 1n, 8760n, 48n));
  reader.done();
  return { validHours };
}

interface Kind {
  step: string;
  withdrawStep: string;
  /** The name of the type in the hosted tools and in the state file. */
  type: 'approval' | 'principal_binding';
  statement: string;
}

const KINDS: readonly Kind[] = [
  { step: 'issue_approval', withdrawStep: 'withdraw_approval', type: 'approval', statement: 'the member approves the test record for the mainnet checks' },
  { step: 'issue_binding', withdrawStep: 'withdraw_binding', type: 'principal_binding', statement: 'the member is the principal of the test record in the mainnet checks' },
];

/** What the issuer keeps off the chain for one attestation. */
interface Held { salt: string; document: string; digest: string }

export const saltedDigest = (salt: string, document: string): string => createHash('sha256').update(Buffer.from(salt, 'hex')).update(Buffer.from(document, 'utf8')).digest('hex');
export const plainDigest = (document: string): string => createHash('sha256').update(Buffer.from(document, 'utf8')).digest('hex');

const heldKey = (kind: Kind): string => `held.${kind.type}`;
const heldOf = (session: Session<AttestationSettings>, kind: Kind): Held | undefined => session.state.note(heldKey(kind)) as Held | undefined;
const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function issue(kind: Kind): StepHandler<AttestationSettings> {
  return {
    name: kind.step,
    async run(session) {
      const record = await requireRecord(session, {});
      const member = session.ring.get('member');
      const now = session.clock.now();
      const validUntil = now + session.extra.validHours * 3_600_000;
      const held: Held = heldOf(session, kind) ?? (() => {
        const salt = randomBytes(32).toString('hex');
        const document = JSON.stringify({ about: record.did, statement: kind.statement, issued: iso(now) });
        return { salt, document, digest: saltedDigest(salt, document) };
      })();
      const context = await session.chain.context(member.address);
      const built = await buildAttest(context, { changeAddress: member.address, nowMs: now, subject: record.id, issuer: member.publicKeyHex, attType: ATT_TYPES[kind.type], digest: held.digest, validUntil });
      const deployment = session.chain.deployment;
      const unit = `${deployment.attestation.hash}${built.id}`;
      const plan: StepPlan = stepPlan(session, {
        outflow: { member: built.depositLovelace + session.settings.maxFeeLovelace },
        destinations: new Set([deployment.attestation.address]), mint: { [unit]: 1n }, labels: { [deployment.attestation.address]: 'the attestation script' },
      });
      const facts = { att_type: kind.type, subject: record.id, issuer_key_hash: member.keyHash, digest: held.digest, valid_until: validUntil, deposit_lovelace: built.depositLovelace };
      const request = {
        step: kind.step, built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo }, plan,
        refs: { attestation_id: built.id, attestation_output: `${built.txHash}#${built.outputIndex}` }, facts,
        notes: [
          `the member key ${member.keyHash} issues an attestation of type ${kind.type} about ${record.did}`,
          `the digest ${held.digest} is SHA-256(salt ++ document): the salt and the document stay off the chain, in the state file`,
          `it is valid until ${iso(validUntil)}; the deposit of ${units(built.depositLovelace)} stays locked until the issuer withdraws it, from ${iso(validUntil + WITHDRAW_WAIT_MS)}`,
        ],
      };
      // The salt and the document are kept before the transaction is sent: the digest on the chain is useless without them.
      if (session.mode === 'submit') session.state.setNote(heldKey(kind), held);
      const landed = await session.land(request);
      if (landed.kind === 'dry') return { kind: 'dry' };
      commitStep(session, request, landed, { attestation: built.id, att_type: kind.type });
      return { kind: 'done', message: `the attestation ${built.id} (${kind.type}) is confirmed in ${landed.txHash}` };
    },
  };
}

/** The attestation as the hosted tool shows it must be the one that the step issued. */
function shown(kind: Kind, id: string, facts: Record<string, unknown>): ToolCheck {
  return {
    tool: 'vector_get_attestation', args: { attestation: id },
    problems: (answer) => {
      const problems: string[] = [];
      if (answer.found !== true) return [`the hosted tool does not find the attestation ${id}`];
      if (answer.subject !== facts.subject) problems.push('its subject is not the test record');
      if (answer.issuer_key_hash !== facts.issuer_key_hash) problems.push('its issuer key is not the member key');
      if (answer.digest !== facts.digest) problems.push('its digest is not the salted digest of the step');
      if (answer.att_type_code !== ATT_TYPES[kind.type]) problems.push(`its type is not ${kind.type}`);
      return problems;
    },
  };
}

/** The check call: with the right digest it must pass, and with the digest of the document alone it must fail. */
function checked(kind: Kind, id: string, recordDid: string, member: string, digest: string, expectPass: boolean): ToolCheck {
  return {
    tool: 'vector_check_attestation', args: { attestation: id, expected_type: kind.type, expected_subject: recordDid, expected_issuer: member, expected_digest: digest },
    problems: (answer) => {
      if (answer.valid === expectPass) return [];
      return [expectPass ? `the hosted tool says that the attestation ${id} does not pass with the salted digest: ${JSON.stringify(answer.details ?? answer.conditions ?? null)}` : `the hosted tool accepted the digest of the document with no salt for ${id}`];
    },
  };
}

const readCheck: StepHandler<AttestationSettings> = {
  name: 'read_check',
  async run(session) {
    const record = await requireRecord(session, {});
    const member = session.ring.get('member');
    const calls: ToolCheck[] = [];
    const shows: Record<string, unknown> = {};
    for (const kind of KINDS) {
      const done = session.state.step(kind.step);
      const held = heldOf(session, kind);
      if (done === undefined || held === undefined) return { kind: 'wait', message: `the step ${kind.step} is not confirmed: run it first`, untilMs: null };
      const id = done.refs.attestation_id!;
      calls.push(shown(kind, id, done.facts), checked(kind, id, record.did, member.keyHash, held.digest, true), checked(kind, id, record.did, member.keyHash, plainDigest(held.document), false));
      shows[kind.type] = { attestation: id, salted_digest_passes: true, unsalted_digest_fails: true };
    }
    calls.push({
      tool: 'vector_list_attestations', args: { subject: record.did, limit: 50 },
      problems: (answer) => {
        const listed = (Array.isArray(answer.attestations) ? answer.attestations : []).map((item) => String(asRecord(item).attestation));
        return KINDS.filter((kind) => !listed.includes(session.state.step(kind.step)!.refs.attestation_id!)).map((kind) => `the list of attestations about the record does not hold the ${kind.type} attestation`);
      },
    });
    session.out.out('the hosted tools would read both attestations, list the ones about the record, and check each with the salted digest (must pass) and with no salt (must fail)');
    if (session.mode === 'dry') return { kind: 'dry' };
    await verifyWithTools(session, 'read_check', calls, shows);
    session.state.recordStep('read_check', { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: {}, facts: shows });
    session.state.markVerified('read_check', iso(session.clock.now()));
    return { kind: 'done', message: 'the hosted tools read both attestations: the salted digests pass and the digests with no salt fail' };
  },
};

/** The deposits come back 90 days after `valid_until`. Each attestation that is due is withdrawn; for the others the date is printed. */
async function withdrawDue(session: Session<AttestationSettings>): Promise<StepOutcome> {
  let dry = false;
  const lines: string[] = [];
  for (const kind of KINDS) {
    const done = session.state.step(kind.step);
    if (done === undefined) { lines.push(`${kind.step} was not run: no ${kind.type} attestation to take back`); continue; }
    if (session.state.step(kind.withdrawStep) !== undefined) { lines.push(`the ${kind.type} deposit is back already`); continue; }
    const from = Number(done.facts.valid_until) + WITHDRAW_WAIT_MS;
    if (session.clock.now() < from + 60_000) { lines.push(`the deposit of the ${kind.type} attestation stays locked until ${iso(from)}: run the cleanup again after that date`); continue; }
    const member = session.ring.get('member');
    const id = done.refs.attestation_id!;
    const context = await session.chain.context(member.address);
    const built = await buildWithdrawAttestation(context, { changeAddress: member.address, nowMs: session.clock.now(), id });
    const unit = `${session.chain.deployment.attestation.hash}${id}`;
    const request = {
      step: kind.withdrawStep, built: { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo },
      plan: stepPlan(session, { outflow: { member: session.settings.maxFeeLovelace }, explained: new Set([done.refs.attestation_output!]), mint: { [unit]: -1n } }),
      refs: { attestation_id: id }, facts: { released_lovelace: built.releasedLovelace },
      notes: [`the member key withdraws the ${kind.type} attestation ${id}: ${units(built.releasedLovelace)} return to the member wallet, and the token is burned`],
    };
    const landed = await session.land(request);
    if (landed.kind === 'dry') { dry = true; continue; }
    commitStep(session, request, landed, { attestation: id, released_lovelace: built.releasedLovelace });
    lines.push(`the ${kind.type} deposit of ${units(built.releasedLovelace)} is back in the member wallet (${landed.txHash})`);
  }
  for (const line of lines) session.out.out(line);
  return dry ? { kind: 'dry' } : { kind: 'done', message: lines.join('; ') };
}

export const attestationsCheck: CheckDefinition<AttestationSettings> = {
  name: 'attestations',
  title: 'the member key issues a type 5 and a type 4 attestation about the test record, with salted digests, and the hosted tools read them',
  needs: { keys: ['controller', 'member'], chain: true, hosted: ['vector_get_attestation', 'vector_list_attestations', 'vector_check_attestation'] },
  steps: ['issue_approval', 'issue_binding', 'read_check'],
  parse: (env) => parseAttestationSettings(env),
  next: (session, flags) => runSteps(session, [issue(KINDS[0]!), issue(KINDS[1]!), readCheck], flags),
  cleanup: withdrawDue,
};
