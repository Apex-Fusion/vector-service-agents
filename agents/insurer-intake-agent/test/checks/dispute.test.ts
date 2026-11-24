// agents/insurer-intake-agent/test/checks/dispute.test.ts: the challenge of the hook through the real `Dispute` of the kit, over a scripted chain port and a journal in memory. The evidence that the hook gives
// passes the evidence builder of the kit, and its document is about the statement S1 of the claim of the sender. The challenge names the escrow, the buyer key of the context and the claim of the sender, and two
// refusals for one escrow give one challenge. The question: is a challenge ever filed with no evidence, for the escrow of another buyer, or against a claim that is not the claim of the Prior Authorization Agent?
import { describe, expect, it } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import { MemoryJournal, claimDocument } from '@vsa/usecase-kit/dispute';
import type { Dispute } from '@vsa/usecase-kit/dispute';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM } from '@vsa/usecase-kit/priorauth';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import {
  CHALLENGE_TX, EVIDENCE_TX, MANIFEST_SHA, ME_ID, REF_A, claimView, escrowJob, rig as kitRig,
} from '../../../../packages/usecase-kit/test/dispute/support.ts';
import type { ScriptedPort } from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { createPrecheck } from '../../src/checks/index.ts';
import { PRIOR_REQUEST, SELF } from './samples.ts';
import { RecordingSink, ScriptedBook, makeWorld, proposalOf } from './support.ts';
import type { World } from './support.ts';

const OTHER_DIGEST = proposalOf({ justification: 'Another synthetic text.' }).proposal_digest;
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/**
 * The sender has one open claim for `capability` that states `claim`, and the escrow of the job hired this agent for the intake capability and names `buyerPkh` as its buyer. The claim of the Prior Authorization
 * Agent is the claim that the hook challenges, so the defaults are its capability and its statements.
 */
function filing(world: World, options: { capability?: string; claim?: ManifestClaim; buyerPkh?: string } = {}): { port: ScriptedPort; dispute: Dispute } {
  const kit = kitRig({}, { journal: new MemoryJournal() });
  const document = claimDocument({
    agent_did: world.sender.did, capability_id: options.capability ?? PRIORAUTH_CAPABILITIES.draft, manifest_sha256: MANIFEST_SHA, claim: options.claim ?? PRIORAUTH_CLAIM,
  });
  if (!document.ok) throw new Error(document.detail);
  const claim = claimView({ claimer: world.sender.did });
  kit.port.documents.set(claim.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: 'text/plain' });
  kit.port.claims = [{ ...claim, claim_hash: document.value.hash }];
  kit.port.readEscrowAnswer = () => escrowJob({ capability_id: PRIORAUTH_CAPABILITIES.intake, agent_id: ME_ID, buyer_pkh: options.buyerPkh ?? world.context.buyerPkh });
  return { port: kit.port, dispute: kit.dispute };
}

/** The hook over a world that is refused for the digest of its approval, with the dispute that the test gives, and the tasks that the hook scheduled. */
function hookOver(world: World, challenger: Dispute) {
  const scheduled: Array<() => Promise<void>> = [];
  const logs: string[] = [];
  const hook = createPrecheck({
    ports: world.ports, book: new ScriptedBook(), self: SELF, passed: new RecordingSink(), dispute: challenger, schedule: (task) => { scheduled.push(task); }, log: (line) => { logs.push(line); },
  });
  return { scheduled, logs, run: () => hook(world.handoff, world.context) };
}

const mismatching = (): World => makeWorld({ attestation: { digest: OTHER_DIGEST } });

describe('the challenge of the hook through the real Dispute', () => {
  it('files the challenge: the evidence passes the builder of the kit and holds the two digests, and the log has the references', async () => {
    const world = mismatching();
    const { port, dispute: challenger } = filing(world);
    // The agent of the dispute is the Insurer Intake Agent: its DID is the insurer that the hook checks.
    expect(SELF).toBe(`did:vector:${ME_ID}`);
    const hook = hookOver(world, challenger);
    const answer = await hook.run();
    expect(answer).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    // Nothing is filed before the task runs: the answer came first.
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    await hook.scheduled[0]!();
    expect(port.published).toHaveLength(1);
    expect(port.published[0]!.type).toBe('evidence');
    const evidence = textOf(port.published[0]!.bytes);
    expect(evidence).toContain(OTHER_DIGEST);
    expect(evidence).toContain(world.proposal.proposal_digest);
    expect(evidence).toContain('The claimer is a prior authorization agent. The challenger is the insurer intake agent that received a request from the claimer.');
    expect(evidence).toContain('The challenger refused the request before it did any work.');
    expect(port.challenged).toHaveLength(1);
    expect(port.challenged[0]!.claim).toBe(REF_A);
    expect(hook.logs).toHaveLength(1);
    for (const reference of [world.context.escrowRef, REF_A, EVIDENCE_TX, `${CHALLENGE_TX}#0`]) expect(hook.logs[0], reference).toContain(reference);
    // The answer holds none of them.
    expect(JSON.stringify(answer)).not.toContain(EVIDENCE_TX);
    expect(JSON.stringify(answer)).not.toContain(CHALLENGE_TX);
  });

  it('writes a document about the statement S1 of the claim of the sender, with the text of that statement', async () => {
    const world = mismatching();
    const { port, dispute: challenger } = filing(world);
    const hook = hookOver(world, challenger);
    await hook.run();
    await hook.scheduled[0]!();
    const rows = textOf(port.published[0]!.bytes).split('\n');
    expect(rows[0]).toBe('Evidence about statement S1 of a claim on the Vector marketplace.');
    expect(rows[1]).toBe(`Statement S1 of the claim reads: "${PRIORAUTH_CLAIM.statements[0].text}"`);
    expect(PRIORAUTH_CLAIM.statements[0].id).toBe('S1');
  });

  it('holds no text of the request and no salt in the evidence: it has the two digests and the references', async () => {
    const world = mismatching();
    const { port, dispute: challenger } = filing(world);
    const hook = hookOver(world, challenger);
    await hook.run();
    await hook.scheduled[0]!();
    const evidence = textOf(port.published[0]!.bytes);
    for (const member of ['justification', 'patient_ref', 'ordering_clinician_ref', 'order_id', 'service_code', 'request_number']) {
      expect(evidence, member).not.toContain(String(PRIOR_REQUEST[member]));
    }
    expect(evidence).not.toContain(world.proposal.salt);
  });

  it('gives one challenge for two refusals of one escrow, whether the tasks run one after the other or together', async () => {
    const world = mismatching();
    const sequential = filing(world);
    const first = hookOver(world, sequential.dispute);
    await first.run();
    await first.run();
    expect(first.scheduled).toHaveLength(2);
    await first.scheduled[0]!();
    await first.scheduled[1]!();
    expect(sequential.port.challenged).toHaveLength(1);
    expect(sequential.port.published).toHaveLength(1);
    expect(first.logs).toHaveLength(2);
    expect(first.logs.every((line) => line.includes(`${CHALLENGE_TX}#0`))).toBe(true);

    const together = filing(world);
    const second = hookOver(world, together.dispute);
    await second.run();
    await second.run();
    await Promise.all(second.scheduled.map((task) => task()));
    expect(together.port.challenged).toHaveLength(1);
    expect(together.port.published).toHaveLength(1);
    expect(second.logs).toHaveLength(2);
    expect(second.logs.filter((line) => line.includes('job_already_disputed'))).toHaveLength(1);
  });

  it('files nothing when the sender has no open claim, and the log says no_open_claim', async () => {
    const world = mismatching();
    const { port, dispute: challenger } = filing(world);
    port.claims = [];
    const hook = hookOver(world, challenger);
    await hook.run();
    await hook.scheduled[0]!();
    expect(port.published).toEqual([]);
    expect(port.challenged).toEqual([]);
    expect(hook.logs).toHaveLength(1);
    expect(hook.logs[0]).toContain('no_open_claim');
  });

  it('takes the buyer key from the context: an escrow of another buyer is not the escrow of this job, and the same job files', async () => {
    const world = mismatching();
    const other = filing(world, { buyerPkh: ed25519Key('insurer intake test: another buyer').keyHash });
    const refused = hookOver(world, other.dispute);
    await refused.run();
    await refused.scheduled[0]!();
    expect(other.port.published).toEqual([]);
    expect(other.port.challenged).toEqual([]);
    expect(refused.logs[0]).toContain('bad_shape');
    const own = filing(world);
    const filed = hookOver(world, own.dispute);
    await filed.run();
    await filed.scheduled[0]!();
    expect(own.port.challenged).toHaveLength(1);
  });

  it('takes the capability of the escrow from this agent: an escrow that hired another capability is not the escrow of this job', async () => {
    const world = mismatching();
    const other = filing(world);
    other.port.readEscrowAnswer = () => escrowJob({ capability_id: PRIORAUTH_CAPABILITIES.draft, agent_id: ME_ID, buyer_pkh: world.context.buyerPkh });
    const refused = hookOver(world, other.dispute);
    await refused.run();
    await refused.scheduled[0]!();
    expect(other.port.published).toEqual([]);
    expect(other.port.challenged).toEqual([]);
    expect(refused.logs[0]).toContain('bad_shape');
    // The twin: the escrow of the intake capability is filed.
    const own = filing(world);
    const filed = hookOver(world, own.dispute);
    await filed.run();
    await filed.scheduled[0]!();
    expect(own.port.challenged).toHaveLength(1);
  });

  it('challenges the claim of the Prior Authorization Agent only: a claim of the sender for another capability, or with another statement S1, is not the target', async () => {
    const world = mismatching();
    for (const options of [{ capability: PRIORAUTH_CAPABILITIES.intake }, { claim: INTAKE_CLAIM }]) {
      const { port, dispute: challenger } = filing(world, options);
      const hook = hookOver(world, challenger);
      await hook.run();
      await hook.scheduled[0]!();
      expect(port.published, JSON.stringify(options)).toEqual([]);
      expect(port.challenged, JSON.stringify(options)).toEqual([]);
      expect(hook.logs[0]).toContain('no_open_claim');
    }
    const right = filing(world);
    const hook = hookOver(world, right.dispute);
    await hook.run();
    await hook.scheduled[0]!();
    expect(right.port.challenged).toHaveLength(1);
  });
});
