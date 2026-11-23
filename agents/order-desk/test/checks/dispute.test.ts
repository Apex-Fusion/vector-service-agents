// agents/order-desk/test/checks/dispute.test.ts: the challenge of the hook through the real `Dispute` of the kit, over a scripted chain port and a journal in memory. The evidence that the hook gives passes the
// evidence builder of the kit. The challenge names the escrow, the buyer key of the context and the claim of the sender, and two refusals for one escrow give one challenge. The question: is a challenge
// ever filed with no evidence, for the escrow of another buyer, or against a claim that is not the claim of the Reorder Agent?
import { describe, expect, it } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import { MemoryJournal, claimDocument } from '@vsa/usecase-kit/dispute';
import type { Dispute } from '@vsa/usecase-kit/dispute';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import {
  CHALLENGE_TX, EVIDENCE_TX, MANIFEST_SHA, ME_ID, REF_A, claimView, escrowJob, rig as kitRig,
} from '../../../../packages/usecase-kit/test/dispute/support.ts';
import type { ScriptedPort } from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { MemoryOrderBook, PassedChecks, createPrecheck, loadLots } from '../../src/checks/index.ts';
import { LOTS_PATH, SELF } from './samples.ts';
import { makeWorld, proposalOf } from './support.ts';
import type { World } from './support.ts';

const LOTS = loadLots(LOTS_PATH).file;
const OTHER_DIGEST = proposalOf({ quantity: 3 }).proposal_digest;
const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

/** The sender has one open claim for `capability` that states `claim`, and the escrow of the job hired this agent and names `buyerPkh` as its buyer. */
function filing(world: World, options: { capability?: string; claim?: ManifestClaim; buyerPkh?: string } = {}): { port: ScriptedPort; dispute: Dispute } {
  const kit = kitRig({}, { journal: new MemoryJournal() });
  const document = claimDocument({
    agent_did: world.sender.did, capability_id: options.capability ?? INVENTORY_CAPABILITIES.reorder, manifest_sha256: MANIFEST_SHA, claim: options.claim ?? REORDER_CLAIM,
  });
  if (!document.ok) throw new Error(document.detail);
  const claim = claimView({ claimer: world.sender.did });
  kit.port.documents.set(claim.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: 'text/plain' });
  kit.port.claims = [{ ...claim, claim_hash: document.value.hash }];
  kit.port.readEscrowAnswer = () => escrowJob({ agent_id: ME_ID, buyer_pkh: options.buyerPkh ?? world.context.buyerPkh });
  return { port: kit.port, dispute: kit.dispute };
}

/** The hook over a world that is refused for the digest of its approval, with the dispute that the test gives, and the tasks that the hook scheduled. */
function hookOver(world: World, challenger: Dispute) {
  const scheduled: Array<() => Promise<void>> = [];
  const logs: string[] = [];
  const hook = createPrecheck({
    ports: world.ports, lots: LOTS, book: new MemoryOrderBook(), self: SELF, passed: new PassedChecks(), dispute: challenger, schedule: (task) => { scheduled.push(task); }, log: (line) => { logs.push(line); },
  });
  return { scheduled, logs, run: () => hook(world.handoff, world.context) };
}

const mismatching = (): World => makeWorld({ attestation: { digest: OTHER_DIGEST } });

describe('the challenge of the hook through the real Dispute', () => {
  it('files the challenge: the evidence passes the builder of the kit and holds the two digests, and the log has the references', async () => {
    const world = mismatching();
    const { port, dispute: challenger } = filing(world);
    // The agent of the dispute is the Order Desk: its DID is the supplier that the hook checks.
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
    expect(evidence).toContain(REORDER_CLAIM.statements[0].text);
    expect(evidence).toContain('The challenger refused the purchase order before it did any work.');
    expect(evidence).not.toContain(world.proposal.salt);
    expect(port.challenged).toHaveLength(1);
    expect(port.challenged[0]!.claim).toBe(REF_A);
    expect(hook.logs).toHaveLength(1);
    for (const reference of [world.context.escrowRef, REF_A, EVIDENCE_TX, `${CHALLENGE_TX}#0`]) expect(hook.logs[0], reference).toContain(reference);
    // The answer holds none of them.
    expect(JSON.stringify(answer)).not.toContain(EVIDENCE_TX);
    expect(JSON.stringify(answer)).not.toContain(CHALLENGE_TX);
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
    const other = filing(world, { buyerPkh: ed25519Key('order desk test: another buyer').keyHash });
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

  it('challenges the claim of the Reorder Agent only: a claim of the sender for another capability, or with another statement S1, is not the target', async () => {
    const world = mismatching();
    for (const options of [{ capability: INVENTORY_CAPABILITIES.order }, { claim: ORDER_DESK_CLAIM }]) {
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
