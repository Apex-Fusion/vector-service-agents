// agents/prior-authorization-agent/test/execute/fault-run.test.ts: the fault `alter_after_approval` in the job `execute`. With the fault on, the handoff holds the request with another last sentence of the justification,
// and its digest is not the digest that the hirer approved. The digest of the proposal is checked before the change and not after it. The hash that the model compares is the hash of the document that was sent. With the
// setting empty the document is never touched, whichever way the job ends. The job reads the fault mode one time and nothing else of the switch, and only the exact value turns the fault on. The service stamps the
// value on every result. Each test has its twin.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALTERED_SENTENCE } from '../../src/execute/fault.ts';
import type * as Fault from '../../src/execute/fault.ts';
import type { PriorAuthRequest } from '@vsa/usecase-kit/priorauth';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { proposalDigest } from '@vsa/usecase-kit/protocol';
import { canonicalize } from '@vsa/vector-read';
import { APPROVAL, INSURER_DID, SALT, acceptDecision, golden, requestDocument, requestHash } from './fixtures.ts';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import type { World, WorldOptions } from './world.ts';
import { DELEGATION, LIMIT, T0, cleanWorlds, footprint, handoffSent, words, world } from './world.ts';

/** How many times the job called `alterJustification`. The real function runs all the same. */
const spy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../src/execute/fault.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Fault>();
  return {
    ...real,
    alterJustification: (document: PriorAuthRequest): PriorAuthRequest => {
      spy.calls += 1;
      return real.alterJustification(document);
    },
  };
});

beforeEach(() => { spy.calls = 0; });
afterEach(() => { cleanWorlds(); });

const FAULT: WorldOptions = { fault: 'alter_after_approval' };
const ORIGINAL = golden('request.json') as Record<string, unknown>;
const ALTERED = golden('request-altered.json') as Record<string, unknown>;
const OTHER_HASH = '00'.repeat(32);

/** The digest of a proposal for a document, with the salt of the tests. */
function digestOf(document: unknown): string {
  const digest = proposalDigest(SALT, document);
  if (!digest.ok) throw new Error(`the digest of the test is refused: ${digest.detail}`);
  return digest.value;
}

describe('the golden files', () => {
  it('differ in the justification only, and the justification differs in its last sentence only', () => {
    expect(ORIGINAL).toStrictEqual(requestDocument());
    for (const name of Object.keys(ORIGINAL)) {
      if (name === 'justification') continue;
      expect(ALTERED[name], name).toStrictEqual(ORIGINAL[name]);
    }
    expect(Object.keys(ALTERED)).toStrictEqual(Object.keys(ORIGINAL));
    const before = String(ORIGINAL.justification);
    const after = String(ALTERED.justification);
    const common = before.slice(0, before.lastIndexOf('. ') + 2);
    expect(after.startsWith(common)).toBe(true);
    expect(after.slice(common.length)).toBe(ALTERED_SENTENCE);
    expect(requestHash(ORIGINAL)).not.toBe(requestHash(ALTERED));
  });
});

describe('with the fault on', () => {
  it('sends the request with the last sentence changed, every other member as the hirer approved it, and a digest that is not the approved digest', async () => {
    const w = await world(FAULT);
    const request = w.request();
    await w.run(request);
    const sent = handoffSent(w);
    expect(sent.document).toStrictEqual(ALTERED);
    expect(sent).toStrictEqual({
      schema: 'vector.usecase.handoff.v1', use_case: 'prior-authorization', sender_did: w.agent.did, delegation: DELEGATION, document: ALTERED, salt: SALT, approval: APPROVAL,
    });
    // The digest that the hirer approved is the digest of the proposal, and the digest of the document that was sent is another one.
    expect(digestOf(request.proposal.document)).toBe(request.proposal.proposal_digest);
    expect(digestOf(sent.document)).not.toBe(request.proposal.proposal_digest);
    expect(spy.calls).toBe(1);
    expect(w.log.filter((line) => line.includes('alter_after_approval'))).toHaveLength(1);
  });

  it('gives the model the hash of the document that was sent, which is the altered document, and not the hash of the approved document', async () => {
    const w = await world(FAULT);
    await w.run();
    expect(w.accept.calls).toHaveLength(1);
    expect(w.accept.calls[0]!.sent).toStrictEqual({ request_number: 'run1-1', request_sha256: requestHash(ALTERED) });
    expect(w.accept.calls[0]!.sent.request_sha256).not.toBe(requestHash(ORIGINAL));
  });

  it('declines a record that names the hash of the ORIGINAL document: the model sees two hashes that differ, the challenge is filed, and the evidence shows both hashes and the altered request', async () => {
    const w = await world(FAULT);
    // The default record of the world names the hash of the approved document.
    const result = await w.runStamped();
    expect(words(result)).toBe('disputed none Escalated');
    expect(result.fault_mode).toBe('alter_after_approval');
    expect(w.accept.calls[0]!.received.request_sha256).toBe(requestHash(ORIGINAL));
    expect(w.dispute.calls).toHaveLength(1);
    expect(w.dispute.calls[0]!.evidence).toHaveProperty('request', ALTERED);
    const document = w.dispute.documents[0];
    const text = document?.ok === true ? document.value.text : '';
    expect(text).toContain(`The SHA-256 of the request that the challenger sent is ${requestHash(ALTERED)}.`);
    expect(text).toContain(`The intake record names the SHA-256 ${requestHash(ORIGINAL)} for the request that it received.`);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 1, asked: 1 });
  });

  it('accepts a record that names the hash of the document that it received, which is the altered document: the submission is written, and the result says that the fault was on', async () => {
    const w = await world(FAULT);
    w.answer(w.recordFor(ALTERED));
    const result = await w.runStamped();
    expect(words(result)).toBe('completed none Completed');
    expect(result.fault_mode).toBe('alter_after_approval');
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 1, challenges: 0, asked: 1 });
    expect(w.accept.calls[0]!.received.request_sha256).toBe(requestHash(ALTERED));
  });

  it('checks the digest of the proposal before the change: a proposal whose digest is wrong is refused with bad_document and nothing is sent, and the sentence is not changed', async () => {
    const w = await world(FAULT);
    const request = w.request();
    const tampered = { ...request, proposal: { ...request.proposal, proposal_digest: 'ab'.repeat(32) } };
    const result = await w.run(tampered);
    expect(words(result)).toBe('failed bad_document Failed');
    expect(result.handoff).toBeNull();
    expect(footprint(w)).toStrictEqual({ paid: 0, sends: 0, writes: 0, challenges: 0, asked: 0 });
    expect(spy.calls).toBe(0);
    // The twin: the same request with its own digest is carried out, and the sentence is changed one time.
    expect(words(await w.run(request))).toBe('disputed none Escalated');
    expect(spy.calls).toBe(1);
  });

  it('does not repeat the check of the digest after the change: the Insurer Intake Agent gets the altered document, and the refusal of its digest check is the answer', async () => {
    const w = await world(FAULT);
    w.m.agent.refuse = { status: 403, code: 'approval_digest_mismatch' };
    const result = await w.runStamped();
    expect(words(result)).toBe('refused_by_counterparty approval_digest_mismatch Escalated');
    expect(result.fault_mode).toBe('alter_after_approval');
    expect(handoffSent(w).document).toStrictEqual(ALTERED);
    expect(footprint(w)).toStrictEqual({ paid: 1, sends: 1, writes: 0, challenges: 0, asked: 0 });
  });

  it('changes the sentence for a request with no approval too: the approval is passed on as it came, and the document is the altered one', async () => {
    const w = await world(FAULT);
    await w.run(w.request(w.document(), null));
    expect(handoffSent(w)).toMatchObject({ approval: null, document: ALTERED });
  });

  it('changes the sentence one time for each job, and for no job that stops before the handoff', async () => {
    const stops: Array<[string, (w: World) => Promise<unknown>]> = [
      ['a request document that is not a request', (w) => w.run(w.request({ ...requestDocument(), note: 'extra' }))],
      ['a request of another tenant', (w) => w.run(w.request(w.document({ tenant: 'run2' })))],
      ['a delegation that names another agent', async (w) => { w.reads.delegations.set(DELEGATION, { delegate: 'c3'.repeat(32), chain_whole: true }); await w.run().catch(() => undefined); }],
      ['a delegate key that the agent does not hold', (w) => { w.delegateKey.hash = '77'.repeat(28); return w.run(); }],
      ['a ledger that cannot be read', (w) => { w.reads.failDelegation = new Error('down'); return w.run(); }],
      ['a request that names the tenant of the job in another case', (w) => w.run(w.request(w.document(), undefined, 'Run1'))],
    ];
    for (const [name, stop] of stops) {
      spy.calls = 0;
      const w = await world(FAULT);
      await stop(w);
      expect(spy.calls, `${name}: the sentence is changed only after the checks that come before the hire`).toBe(0);
    }
    spy.calls = 0;
    const w = await world(FAULT);
    await w.run();
    expect(spy.calls).toBe(1);
  });
});

describe('with the setting empty', () => {
  /** Each scenario ends in another way. In every one the job that sends a handoff sends the approved document, byte for byte. */
  const SCENARIOS: Array<[string, (w: World) => void, WorldOptions, unknown?]> = [
    ['a completed hire', () => undefined, {}],
    ['a request with no approval', () => undefined, {}, null],
    ['a model that does not accept the delivery', (w) => { w.answer({ request_sha256: OTHER_HASH }); }, {}],
    ['a model that says no for equal hashes', (w) => { w.accept.answer = () => ({ ok: true, decision: acceptDecision(false, ['request_sha256']), choice: { accept: false, mismatch: ['request_sha256'] } }); }, {}],
    ['a decision that failed', (w) => { w.accept.answer = () => ({ ok: false, code: 'model_output_invalid' }); }, {}],
    ['an answer that is no intake record', (w) => { w.answer('the request is filed'); }, {}],
    ['an intake record of another request number', (w) => { w.answer({ request_number: 'run1-2' }); }, {}],
    ['a refusal for the digest of the approval', (w) => { w.m.agent.refuse = { status: 403, code: 'approval_digest_mismatch' }; }, {}],
    ['a refusal for a sender that is not active', (w) => { w.m.agent.refuse = { status: 403, code: 'sender_not_active' }; }, {}],
    ['a job of the Insurer Intake Agent that fails', (w) => { w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }]; }, {}],
    ['a records system that refuses the submission', (w) => { w.store.answer = () => new Response('{"error":"duplicate_submission"}', { status: 409, headers: { 'content-type': 'application/json' } }); }, {}],
    ['a delivery that cannot be recorded', (w) => { w.receipt.depth = 40; }, {}],
    ['the second delegation key', () => undefined, { delegate: 'b' }],
    ['a Pay that the vault refuses', () => undefined, { limit: { ...LIMIT, perTx: 3_000_000n } }],
  ];
  for (const [name, arrange, options, approval] of SCENARIOS) {
    it(`never changes the document, and the result holds the empty fault mode: ${name}`, async () => {
      const w = await world(options);
      arrange(w);
      const request = w.request(w.document(), approval);
      const result = await w.runStamped(request);
      expect(result.fault_mode).toBe('');
      expect(spy.calls).toBe(0);
      expect(w.log.some((line) => line.includes('alter_after_approval'))).toBe(false);
      // A job that sent no handoff changed nothing, because no job changes a document before it sends one.
      if (w.m.agent.sends.length > 0) {
        const sent = handoffSent(w);
        expect(sent.document).toStrictEqual(request.proposal.document);
        expect(canonicalize(sent.document)).toBe(canonicalize(request.proposal.document));
        expect(digestOf(sent.document)).toBe(request.proposal.proposal_digest);
      }
    });
  }

  it('twin: the same scenario with the fault on changes the document', async () => {
    const w = await world(FAULT);
    const request = w.request();
    await w.run(request);
    expect(canonicalize(handoffSent(w).document)).not.toBe(canonicalize(request.proposal.document));
    expect(spy.calls).toBe(1);
  });
});

describe('the switch of the fault', () => {
  /** A switch that counts the reads of its members. The job must read `mode` one time and nothing else of it. */
  function switchOf(mode: unknown): { fault: FaultSwitch<'prior-authorization-agent'>; reads: { mode: number; other: number } } {
    const reads = { mode: 0, other: 0 };
    const fault = {
      get mode(): unknown { reads.mode += 1; return mode; },
      get kind(): string { reads.other += 1; return 'prior-authorization-agent'; },
    };
    // A test object that has the two members of a switch: the type of a switch is sealed, so only a cast makes one by hand.
    return { fault: fault as unknown as FaultSwitch<'prior-authorization-agent'>, reads };
  }

  it('is read one time for mode and not at all for anything else: with the value the document is changed, and with the empty text it is not', async () => {
    const on = await world();
    const live = switchOf('alter_after_approval');
    const deps: ExecuteDeps = { ...on.deps, fault: live.fault };
    await on.run(on.request(), T0, deps);
    expect(live.reads).toStrictEqual({ mode: 1, other: 0 });
    expect(handoffSent(on).document).toStrictEqual(ALTERED);
    const off = await world();
    const quiet = switchOf('');
    await off.run(off.request(), T0, { ...off.deps, fault: quiet.fault });
    expect(quiet.reads).toStrictEqual({ mode: 1, other: 0 });
    expect(handoffSent(off).document).toStrictEqual(ORIGINAL);
  });

  it('reads the switch for a job that stops before the handoff at most one time', async () => {
    const w = await world();
    const live = switchOf('alter_after_approval');
    await w.run(w.request({ ...requestDocument(), note: 'extra' }), T0, { ...w.deps, fault: live.fault });
    expect(live.reads.mode).toBeLessThanOrEqual(1);
    expect(live.reads.other).toBe(0);
  });

  const NOT_THE_VALUE: unknown[] = ['ALTER_AFTER_APPROVAL', 'alter_after_approval ', ' alter_after_approval', 'alter', 'invert_scores', 'true', undefined, null, 1, true, {}, ['alter_after_approval'], 'alter_after_approval\n'];
  for (const value of NOT_THE_VALUE) {
    it(`leaves the document alone for a mode that is not exactly the fault value: ${JSON.stringify(value) ?? String(value)}`, async () => {
      const w = await world();
      const request = w.request();
      await w.run(request, T0, { ...w.deps, fault: switchOf(value).fault });
      expect(handoffSent(w).document).toStrictEqual(request.proposal.document);
      expect(spy.calls).toBe(0);
    });
  }

  it('stamps the value of the switch on every result: the empty text in a clean run, and the fault value in a fault run, for the results that carry the job to its end', async () => {
    const clean = await world();
    expect((await clean.runStamped()).fault_mode).toBe('');
    const faulty = await world(FAULT);
    expect((await faulty.runStamped()).fault_mode).toBe('alter_after_approval');
    // A result that stops before the hire holds the value too.
    const early = await world(FAULT);
    const stopped = await early.runStamped(early.request({ ...requestDocument(), note: 'extra' }));
    expect(words(stopped)).toBe('failed bad_document Failed');
    expect(stopped.fault_mode).toBe('alter_after_approval');
  });

  it('is on in every form of result of a fault run, and the insurer is the one of the request', async () => {
    const forms: Array<[string, (w: World) => void, string]> = [
      ['completed', (w) => { w.answer(w.recordFor(ALTERED)); }, 'completed'],
      ['disputed', () => undefined, 'disputed'],
      ['refused_by_counterparty', (w) => { w.m.agent.refuse = { status: 403, code: 'approval_digest_mismatch' }; }, 'refused_by_counterparty'],
      ['refused_by_system', (w) => { w.answer(w.recordFor(ALTERED)); w.store.answer = () => new Response('{"error":"duplicate_submission"}', { status: 409, headers: { 'content-type': 'application/json' } }); }, 'refused_by_system'],
      ['failed', (w) => { w.m.agent.steps = ['running', { fail: 'upstream_failure', submitted: false }]; }, 'failed'],
    ];
    for (const [name, arrange, outcome] of forms) {
      const w = await world(FAULT);
      arrange(w);
      const result = await w.runStamped();
      expect(result.outcome, name).toBe(outcome);
      expect(result.fault_mode, name).toBe('alter_after_approval');
      expect(result.handoff?.counterparty_did, name).toBe(INSURER_DID);
    }
    const vault = await world({ ...FAULT, limit: { ...LIMIT, perTx: 3_000_000n } });
    const refused = await vault.runStamped();
    expect(refused.outcome).toBe('vault_refused');
    expect(refused.fault_mode).toBe('alter_after_approval');
  });
});
