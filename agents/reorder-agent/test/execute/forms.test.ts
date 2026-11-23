// agents/reorder-agent/test/execute/forms.test.ts: the result forms of the job `execute` that come from the payment and from the Order Desk. A hire that is paid and accepted writes the order once. Every
// other end is a typed result, and none of them writes the order. The exit state of each result is the state that `exitStateOf` gives. Each form has its twin.
import { afterEach, describe, expect, it } from 'vitest';
import { COUNTERPARTY_REFUSALS, exitStateOf } from '@vsa/usecase-kit/protocol';
import type { KeyObject } from 'node:crypto';
import { AGENT_ADVERT_REF, APPROVAL, SALT, SUPPLIER_DID, acceptDecision, confirmationOf } from './fixtures.ts';
import type { World } from './world.ts';
import { DELEGATION, LIMIT, NOTHING, T0, cleanWorlds, footprint, hireOf, inFrontOfPolls, jsonResponse, words, world } from './world.ts';

afterEach(() => { cleanWorlds(); });

/** The evaluation error that the FakeChain gives for a Pay that the vault script refuses: the text of the answer 3010 of the node. */
const EVALUATION_ERROR = '3010 Some scripts of the transactions terminated with error(s).';

/** The handoff that the Order Desk received, as it read it from the wire payload of the send. */
function handoffSent(w: World): unknown {
  const payload: unknown = JSON.parse(w.m.agent.sends[0]!.payload);
  const message = (payload as Array<{ content: string }>)[0]!;
  return JSON.parse(message.content);
}

/** The 32 bytes of the key, in hex: what no result and no log line may hold. */
function rawKeyHexOf(key: KeyObject): string {
  const der = key.export({ format: 'der', type: 'pkcs8' });
  return der.subarray(der.length - 32).toString('hex');
}

describe('a hire that is paid, accepted and recorded', () => {
  it('pays the advert of the order from the vault, accepts the delivery, writes the order once, and says completed', async () => {
    const w = await world();
    const request = w.request();
    const result = await w.run(request);
    expect(words(result)).toBe('completed none Completed');
    expect(result).toMatchObject({ schema: 'vector.usecase.result.v1', use_case: 'inventory-reorder', proposal_digest: request.proposal.proposal_digest, challenge: null, fault_mode: '' });
    expect(result.writes).toStrictEqual([{ system: 'po-store', route: 'POST /po', status: 201, ref: 'PO-run1-0001' }]);
    expect(result.decisions).toStrictEqual([acceptDecision(true)]);
    expect(hireOf(result)).toMatchObject({
      counterparty_did: SUPPLIER_DID, advert_ref: AGENT_ADVERT_REF, paid_from_vault: true, accepted: 'confirmed', result: confirmationOf(w.document()),
    });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 1, challenges: 0, asked: 1 });
    expect(w.booked).toStrictEqual({ posted: 1, accepted: 1 });
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('spent');
    // The key that the delegation names paid, from the one vault of the delegation.
    expect([w.a.pays, w.b.pays]).toStrictEqual([[w.vault], []]);
  });

  it('writes the purchase order that the hirer approved to the PO store of its tenant, with a token for the route po.write that the delegation key asked for', async () => {
    const w = await world();
    const request = w.request();
    await w.run(request);
    const [call] = w.store.calls;
    expect([call?.method, call?.url]).toStrictEqual(['POST', 'https://mock.example/t/run1/po']);
    expect(JSON.parse(call?.body ?? '')).toStrictEqual(request.proposal.document);
    expect(call?.headers.authorization).toMatch(/^DPoP /);
    expect(call?.headers.dpop).toBeTypeOf('string');
    expect(call?.headers['content-type']).toBe('application/json');
    expect(w.tokens).toHaveLength(1);
    const asked = w.tokens[0]!;
    expect(asked.answer.ok).toBe(true);
    expect(asked.request.subject.did).toBe(w.agent.did);
    expect(asked.request.resource).toBe(w.po.resource);
    expect(asked.request.delegation).toStrictEqual({ identifier: DELEGATION, actions: ['po.write'], locations: [w.po.resource] });
  });

  it('sends the handoff as the request gave it: the document, the salt, the delegation, its own DID as the sender, and the approval', async () => {
    const w = await world();
    await w.run();
    expect(handoffSent(w)).toStrictEqual({
      schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: w.agent.did, delegation: DELEGATION, document: w.document(), salt: SALT, approval: APPROVAL,
    });
  });

  it('passes a null approval on, and goes on: the Order Desk and the mock system refuse it, and this agent does not judge it', async () => {
    const w = await world();
    const result = await w.run(w.request(w.document(), null));
    expect(words(result)).toBe('completed none Completed');
    expect(handoffSent(w)).toMatchObject({ approval: null, salt: SALT });
  });

  it('puts no key, token or proof in the result or in the log', async () => {
    const w = await world();
    const result = await w.run();
    const call = w.store.calls[0]!;
    const issued = w.tokens[0]!.answer;
    const secrets = [
      issued.ok ? issued.value.accessToken : 'no token was issued', call.headers.authorization!, call.headers.dpop!, call.headers.authorization!.slice('DPoP '.length),
      rawKeyHexOf(w.agent.authentication.privateKey), rawKeyHexOf(w.a.testKey.privateKey), rawKeyHexOf(w.b.testKey.privateKey),
    ];
    const written = `${JSON.stringify(result)}\n${w.log.join('\n')}`;
    for (const secret of secrets) expect(written).not.toContain(secret);
    expect(w.log.length).toBeGreaterThan(0);
  });

  it('keeps the order written and says completed when the ledger cannot book the fee of the Accept: the Accept is on the chain, and the log names its hash and its fee', async () => {
    const w = await world();
    const deps = { ...w.deps, hire: { ...w.deps.hire, ledger: { posted: w.deps.hire.ledger.posted, accepted: () => { throw new Error('the ledger is closed'); } } } };
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('completed none Completed');
    expect(footprint(w).poWrites).toBe(1);
    const line = w.log.find((entry) => entry.includes('did not book the fee'));
    expect(line).toMatch(/accept transaction [0-9a-f]{64}, fee [0-9]+ lovelace/);
    expect(line).not.toContain('closed');
  });
});

describe('a Pay that the vault refuses', () => {
  it('is vault_refused for a lot above per_tx, with the evaluation error of the node as its reason, and nothing is paid, sent, written or asked: the vault output is still live', async () => {
    const large = await world({ lot: 'lot-large' });
    const result = await large.run();
    expect(result).toMatchObject({ outcome: 'vault_refused', reason: EVALUATION_ERROR, challenge: null, exit_state: 'Failed', handoff: null, writes: [], decisions: [] });
    expect(footprint(large)).toStrictEqual(NOTHING);
    expect(large.booked).toStrictEqual({ posted: 0, accepted: 0 });
    expect(large.m.chain.vault(large.vault)).toMatchObject({ kind: 'Live', consumed: false });
    // The twin: a lot that is exactly the limit of the delegation is paid.
    const medium = await world({ lot: 'lot-medium' });
    expect(words(await medium.run())).toBe('completed none Completed');
  });

  it('puts the draft of the refused Pay in the log, and never in the result', async () => {
    const w = await world({ lot: 'lot-large' });
    const result = await w.run();
    const line = w.log.find((entry) => entry.includes('the draft of the Pay that the vault refused'));
    const draft = line?.split(': ').pop() ?? '';
    expect(draft).toMatch(/^[0-9a-f]{40,}$/);
    expect(JSON.stringify(result)).not.toContain(draft);
    // The line before it says why the vault refused.
    expect(w.log.some((entry) => entry.includes('the vault refused the Pay (ledger)') && entry.includes(EVALUATION_ERROR))).toBe(true);
  });

  it('is vault_refused when the total of the period is spent: the same approved order, run again after one that was paid', async () => {
    const w = await world();
    const request = w.request();
    expect(words(await w.run(request))).toBe('completed none Completed');
    const again = await w.run(request);
    expect(again).toMatchObject({ outcome: 'vault_refused', reason: EVALUATION_ERROR, challenge: null, exit_state: 'Failed', handoff: null, writes: [], decisions: [] });
    // Nothing more was paid, sent, written or asked for the second run.
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 1, challenges: 0, asked: 1 });
  });

  it('is Cancelled when the hirer ended the delegation, and Failed when the delegation stands', async () => {
    const ended = await world();
    ended.endDelegation();
    const result = await ended.run();
    expect(result).toMatchObject({ outcome: 'vault_refused', reason: 'no_delegation', exit_state: 'Cancelled', handoff: null, challenge: null });
    expect(footprint(ended)).toStrictEqual(NOTHING);
    // The twin: a vault too small to pay, under a delegation that stands.
    const small = await world({ vault: false });
    small.m.chain.openVault({ delegation: DELEGATION, lovelace: 1_300_000n, limit: LIMIT });
    expect(await small.run()).toMatchObject({ outcome: 'vault_refused', reason: 'below_minimum', exit_state: 'Failed' });
    expect(footprint(small)).toStrictEqual(NOTHING);
  });
});

describe('an Order Desk that refuses', () => {
  const STATES: Readonly<Record<string, string>> = { approval_digest_mismatch: 'Escalated', approval_expired: 'Expired', delegation_ended: 'Cancelled' };

  for (const code of COUNTERPARTY_REFUSALS['order-desk'].filter((listed) => listed !== 'cannot_supply')) {
    it(`is refused_by_counterparty with ${code} when it refuses before its Claim: the escrow stays Open, and the model is not asked`, async () => {
      const w = await world();
      w.m.agent.refuse = { status: 403, code, message: 'words of the Order Desk that never reach the result' };
      const result = await w.run();
      expect(result).toMatchObject({ outcome: 'refused_by_counterparty', reason: code, challenge: null, writes: [], decisions: [] });
      expect(result.exit_state).toBe(STATES[code] ?? 'Rejected');
      expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_counterparty', reason: code, challenge_filed: false, delegation_ended: false }));
      expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null, result: null });
      expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Open');
      expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
      expect(JSON.stringify(result)).not.toContain('words of the Order Desk');
    });
  }

  /** The runtime copies the answer of the service into the failure of the job: the reason `service_http_<status>`, and the message with the start of the answer. */
  const failureWith = (message: string) => (reached: Response): Response | undefined => (reached.status === 502 ? jsonResponse(502, { status: 'failed', reason: 'service_http_403', message }) : undefined);

  it('is refused_by_counterparty with cannot_supply when it decides so after its Claim: the escrow is Claimed, nothing is accepted, and the model is not asked', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'service_http_403', submitted: false }];
    const deps = { ...w.deps, hire: { ...w.deps.hire, fetchImpl: inFrontOfPolls(w.m, failureWith('service returned HTTP 403: {"error":"cannot_supply","message":"the lot is gone"}')) } };
    const result = await w.run(w.request(), T0, deps);
    expect(result).toMatchObject({ outcome: 'refused_by_counterparty', reason: 'cannot_supply', exit_state: 'Rejected', challenge: null, writes: [], decisions: [] });
    expect(result.exit_state).toBe(exitStateOf({ outcome: 'refused_by_counterparty', reason: 'cannot_supply', challenge_filed: false, delegation_ended: false }));
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Claimed');
    expect(JSON.stringify(result)).not.toContain('the lot is gone');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });

  it('is a failure, and not a refusal, when the job fails after its Claim with another code: the same failed job, with its reason', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'service_http_403', submitted: false }];
    const deps = { ...w.deps, hire: { ...w.deps.hire, fetchImpl: inFrontOfPolls(w.m, failureWith('service returned HTTP 403: {"error":"duplicate_po","message":"seen"}')) } };
    const result = await w.run(w.request(), T0, deps);
    expect(words(result)).toBe('failed failed Failed');
    expect(await w.m.chain.escrowState(hireOf(result).escrow_ref)).toBe('Claimed');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });

  it('is a failure when the Order Desk fails its job with no code of its own: failed with the reason of the hire kit, and the escrow is Claimed', async () => {
    const w = await world();
    w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }];
    const result = await w.run();
    expect(words(result)).toBe('failed failed Failed');
    expect(hireOf(result)).toMatchObject({ paid_from_vault: true, accepted: null, receipt: null });
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, poWrites: 0, challenges: 0, asked: 0 });
  });
});
