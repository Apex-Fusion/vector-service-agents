// packages/usecase-kit/test/buyer/hire-guards.test.ts: what stops a hire before the Pay. Each guard has a test with an accepted twin. After a guard stops a hire nothing is posted, sent or recorded,
// and no vault output is spent. The guards: the settings and the message, the limits that the caller must give, the authority of the job, the Live vault of the delegation, the size of the body of the
// call to the runtime, and the advert that the document names. The last tests are for two jobs at one time on one delegation key, and for the hire of a bidder with a request for quotation.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS } from '@vsa/hire-kit';
import { AGENT_ADVERT, INDEXER, LLM_ADVERT_REF } from '@vsa/hire-kit/testing';
import { MAX_REQUEST_BYTES, RFQ_SCHEMA, RUNTIME_BODY_LIMIT_BYTES, checkRequestSize, parseRfq } from '@vsa/usecase-kit/protocol';
import { hireCounterparty, requestText, runtimeBody } from '@vsa/usecase-kit/buyer';
import type { HireInput, RefusedCode } from '@vsa/usecase-kit/buyer';
import { wirePayloadFor } from '@vsa/vector-read';
import {
  AGENT_ADVERT_REF, BUYER_DID, DELEGATION, NO_LIMITS, OTHER_ID, T0, cleanWorlds, executeRequest, expectKind, go, handoffFor, input, purchaseOrder, untouched, words, world,
} from './support.ts';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); cleanWorlds(); });

/** What a hire that was stopped before the Pay leaves behind: no read of the vaults, and nothing spent, booked, sent or recorded. */
const NOTHING = { posted: 0, sends: 0, stranded: 0, spent: 0 };

describe('the settings and the message', () => {
  const noAdvert = (() => { const { advert_ref: _ignored, ...rest } = purchaseOrder(); return rest; })();
  const CASES: Array<[string, Partial<HireInput>, RefusedCode, string]> = [
    ['no limits at all', { limits: undefined as never }, 'internal', 'the limits must be an object'],
    ['a price limit that is missing', { limits: { maxSupplierBondLovelace: null, maxBuyerBondLovelace: null } as never }, 'internal', 'maxPriceLovelace must be a bigint or null, and it is missing'],
    ['a supplier bond limit that is missing', { limits: { maxPriceLovelace: null, maxBuyerBondLovelace: null } as never }, 'internal', 'maxSupplierBondLovelace must be a bigint or null, and it is missing'],
    ['a buyer bond limit that is missing', { limits: { maxPriceLovelace: null, maxSupplierBondLovelace: null } as never }, 'internal', 'maxBuyerBondLovelace must be a bigint or null, and it is missing'],
    ['a price limit that is a number', { limits: { ...NO_LIMITS, maxPriceLovelace: 500_000 } as never }, 'internal', 'maxPriceLovelace must be a bigint or null, and it is a number'],
    ['a supplier bond limit that is a text', { limits: { ...NO_LIMITS, maxSupplierBondLovelace: '2000000' } as never }, 'internal', 'maxSupplierBondLovelace must be a bigint or null, and it is a text'],
    ['a buyer bond limit that is undefined', { limits: { ...NO_LIMITS, maxBuyerBondLovelace: undefined } as never }, 'internal', 'maxBuyerBondLovelace must be a bigint or null, and it is missing'],
    ['a decision that is not a function', { decide: 'accept' as never }, 'internal', 'decide must be a function'],
    ['no capability', { capability_id: '' }, 'internal', 'capability_id must be a text'],
    ['a model that is not a text', { model: 7 as never }, 'internal', 'model must be a text'],
    ['a message of another schema', { message: { schema: 'vector.usecase.po.v1' } as never }, 'bad_shape', 'message.schema'],
    ['a counterparty that is no DID', { counterparty_did: 'did:vector:abc' }, 'bad_shape', 'counterparty_did'],
    ['an advert that the caller gives with a handoff', { advert_ref: AGENT_ADVERT_REF } as never, 'internal', 'advert_ref must be left out'],
    ['a document that names no advert', { message: handoffFor(noAdvert) }, 'bad_shape', 'document.advert_ref'],
    ['a document whose advert is no output reference', { message: handoffFor(purchaseOrder({ advert_ref: 'not a reference' })) }, 'bad_shape', 'document.advert_ref'],
  ];
  for (const [name, over, code, detail] of CASES) {
    it(`refuses ${name} as ${code}, before any read of the ledger and before any Pay`, async () => {
      const w = await world();
      const step = expectKind(await go(w, over), 'refused');
      expect([step.code, step.detail]).toStrictEqual([code, expect.stringContaining(detail)]);
      expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
      expect(untouched(w)).toStrictEqual(NOTHING);
      // The twin: the same world hires when nothing is wrong.
      expect(words(await go(w))).toBe('completed');
    });
  }

  it('takes a limit that the caller sets to null on purpose, and a limit that is a bigint: the hire is made', async () => {
    const w = await world();
    expect(words(await go(w, { limits: { maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null } }))).toBe('completed');
    const bounded = await world();
    expect(words(await go(bounded, { limits: { maxPriceLovelace: 200_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n } }))).toBe('completed');
  });

  it('refuses a limit that cannot be read as internal, with a step and no throw: a getter that throws', async () => {
    const w = await world();
    const limits = { get maxPriceLovelace(): bigint | null { throw new Error('SECRET-SETTING'); }, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };
    const step = expectKind(await go(w, { limits }), 'refused');
    expect([step.code, step.detail]).toStrictEqual(['internal', 'maxPriceLovelace cannot be read']);
    expect(JSON.stringify(step)).not.toContain('SECRET-SETTING');
    expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
    expect(untouched(w)).toStrictEqual(NOTHING);
    // The twin: limits that can be read are hired with.
    expect(words(await go(w))).toBe('completed');
  });

  it('refuses an input whose member cannot be read as internal, with a step and no throw', async () => {
    const w = await world();
    const unreadable = input();
    Object.defineProperty(unreadable, 'capability_id', { get: () => { throw new Error('SECRET-SETTING'); } });
    const step = expectKind(await hireCounterparty(w.deps, unreadable), 'refused');
    expect([step.code, step.detail]).toStrictEqual(['internal', 'the input of the hire cannot be read']);
    expect(JSON.stringify(step)).not.toContain('SECRET-SETTING');
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(words(await hireCounterparty(w.deps, input()))).toBe('completed');
  });

  it('refuses a paying key whose chain cannot pay from a vault as internal, and pays nothing', async () => {
    const w = await world({ plainChain: true });
    const step = expectKind(await go(w), 'refused');
    expect([step.code, step.detail]).toStrictEqual(['internal', 'the chain of the paying key cannot pay from a vault']);
    expect(w.reads.calls).toStrictEqual({ delegation: 0, liveVaults: 0 });
    expect(untouched(w)).toStrictEqual(NOTHING);
  });
});

describe('the authority of the job', () => {
  it('refuses a delegation that names another agent: delegation_not_mine, with no read of the vaults and no Pay', async () => {
    const w = await world();
    w.reads.delegations.set(DELEGATION, { delegate: OTHER_ID, chain_whole: true });
    const step = expectKind(await go(w), 'refused');
    expect(step.code).toBe('delegation_not_mine');
    expect(w.reads.calls).toStrictEqual({ delegation: 1, liveVaults: 0 });
    expect(untouched(w)).toStrictEqual(NOTHING);
    // The twin: a delegation that names this agent is hired from.
    const mine = await world();
    expect(words(await go(mine))).toBe('completed');
  });

  it('takes the sender of the message from the message: a handoff that names another agent as its sender is a handoff of that agent', async () => {
    const w = await world();
    const step = await go(w, { message: { ...handoffFor(), sender_did: `did:vector:${OTHER_ID}` } });
    expect(words(step)).toBe('refused delegation_not_mine');
    expect(untouched(w)).toStrictEqual(NOTHING);
  });

  it('does not read a delegation that cannot be read as "not found" or as "mine": ledger_unavailable, and no Pay', async () => {
    const w = await world();
    w.reads.failDelegation = new Error('koios answered 502');
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff]).toStrictEqual(['ledger_unavailable', null]);
    expect(w.reads.calls.liveVaults).toBe(0);
    expect(untouched(w)).toStrictEqual(NOTHING);
    w.reads.failDelegation = null;
    expect(words(await go(w))).toBe('completed');
  });
});

describe('the vault of the delegation', () => {
  it('refuses a delegation with no Live vault: no_live_vault, and nothing is paid', async () => {
    const w = await world({ vault: false });
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff, step.vault_ref]).toStrictEqual(['no_live_vault', null, null]);
    expect(untouched(w)).toStrictEqual(NOTHING);
    // The twin: a vault under the delegation is the vault to pay from.
    w.openVault();
    expect(words(await go(w))).toBe('completed');
  });

  it('refuses a delegation with two Live vaults: several_live_vaults, and nothing is paid from either', async () => {
    const w = await world();
    w.openVault();
    const step = expectKind(await go(w), 'failed');
    expect(step.reason).toBe('several_live_vaults');
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(w.m.chain.vaults().filter((vault) => vault.consumed)).toStrictEqual([]);
  });

  it('refuses a read of the vaults that stopped before its end, and a read that cannot be made', async () => {
    const stopped = await world();
    stopped.reads.complete = false;
    expect(words(await go(stopped))).toBe('failed several_live_vaults');
    expect(untouched(stopped)).toStrictEqual(NOTHING);
    const down = await world();
    down.reads.failVaults = new Error('the node is down');
    expect(words(await go(down))).toBe('failed ledger_unavailable');
    expect(untouched(down)).toStrictEqual(NOTHING);
    down.reads.failVaults = null;
    expect(words(await go(down))).toBe('completed');
  });

  it('reads the vaults at the time of its clock, and right before the Pay: the vault of the read is the vault that the Pay spends', async () => {
    const w = await world();
    const read = vi.spyOn(w.reads, 'liveVaults');
    const step = expectKind(await go(w), 'completed');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(DELEGATION, T0);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ consumed: true });
    expect(step.vault_ref).not.toBe(w.vault);
  });
});

describe('the size of the call', () => {
  /** The bytes of the wire payload that the hire kit sends for a document: the wire payload of the canonical text of its handoff. */
  const wireBytes = (document: Record<string, unknown>): number => Buffer.byteLength(wirePayloadFor(requestText(handoffFor(document))), 'utf8');

  /** A document whose wire payload is exactly `bytes` bytes when it is filled with plain letters: each letter is one byte at every level. */
  function documentForWire(bytes: number): Record<string, unknown> {
    return purchaseOrder({ note: 'a'.repeat(bytes - wireBytes(purchaseOrder({ note: '' }))) });
  }

  /**
   * A document whose body is exactly `bytes` bytes. A quote mark of the note is eight bytes in the body and four in the wire payload, so 60,000 of them keep the wire payload far below the limit of a
   * service, and the limit of the runtime is the one that binds.
   */
  function documentForBody(bytes: number): Record<string, unknown> {
    const quotes = '"'.repeat(60_000);
    const base = Buffer.byteLength(runtimeBody(requestText(handoffFor(purchaseOrder({ note: quotes })))), 'utf8');
    return purchaseOrder({ note: quotes + 'a'.repeat(bytes - base) });
  }

  it('hires with a body at the limit of the runtime, and the body that the flow computed is the body that the hire kit sent', async () => {
    const w = await world();
    const document = documentForBody(RUNTIME_BODY_LIMIT_BYTES);
    expect(wireBytes(document)).toBeLessThan(MAX_REQUEST_BYTES);
    const step = await go(w, { message: handoffFor(document) });
    expect(words(step)).toBe('completed');
    // The drift guard: the body of the real send has the size that the flow computed before the Pay.
    expect(Buffer.byteLength(w.m.agent.sends[0]!.body, 'utf8')).toBe(RUNTIME_BODY_LIMIT_BYTES);
  });

  it('refuses a body of one byte above the limit as request_too_large: no Pay is made, and nothing is locked until a reclaim', async () => {
    const w = await world();
    const document = documentForBody(RUNTIME_BODY_LIMIT_BYTES + 1);
    expect(wireBytes(document)).toBeLessThan(MAX_REQUEST_BYTES);
    const step = expectKind(await go(w, { message: handoffFor(document) }), 'refused');
    expect(step.code).toBe('request_too_large');
    expect(step.detail).toBe(`the call to the counterparty has ${RUNTIME_BODY_LIMIT_BYTES + 1} bytes, and the runtime takes at most ${RUNTIME_BODY_LIMIT_BYTES} bytes`);
    expect(w.reads.calls.liveVaults).toBe(0);
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
  });

  it('hires with a wire payload at the limit of a service, and the payload that the flow computed is the payload that the hire kit sent', async () => {
    const w = await world();
    const step = await go(w, { message: handoffFor(documentForWire(MAX_REQUEST_BYTES)) });
    expect(words(step)).toBe('completed');
    // The drift guard: the wire payload of the real send has the size that the flow computed before the Pay.
    expect(Buffer.byteLength(w.m.agent.sends[0]!.payload, 'utf8')).toBe(MAX_REQUEST_BYTES);
  });

  it('refuses a wire payload of one byte above the limit of a service as request_too_large, although the runtime would take its body: no Pay is made', async () => {
    const w = await world();
    const document = documentForWire(MAX_REQUEST_BYTES + 1);
    expect(Buffer.byteLength(runtimeBody(requestText(handoffFor(document))), 'utf8')).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    const step = expectKind(await go(w, { message: handoffFor(document) }), 'refused');
    expect(step.code).toBe('request_too_large');
    expect(step.detail).toBe(`the request has ${MAX_REQUEST_BYTES + 1} bytes, and a service takes at most ${MAX_REQUEST_BYTES} bytes`);
    expect(w.reads.calls.liveVaults).toBe(0);
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(w.m.chain.vault(w.vault)).toMatchObject({ kind: 'Live', consumed: false });
  });

  it('refuses a document that the service takes and the runtime does not: its quote marks are escaped two more times in the body', async () => {
    const w = await world();
    const document = purchaseOrder({ note: '"'.repeat(200_000) });
    // The request is under the limit of the service: its wire payload is below MAX_REQUEST_BYTES. So is the wire payload of the handoff.
    const request = executeRequest(document);
    const requestWire = wirePayloadFor(JSON.stringify({ op: 'execute', authority: request.authority, tenant: request.tenant, proposal: request.proposal, approval: request.approval }));
    expect(checkRequestSize(requestWire)).toMatchObject({ ok: true });
    expect(Buffer.byteLength(requestWire)).toBeLessThan(MAX_REQUEST_BYTES);
    expect(wireBytes(document)).toBeLessThan(MAX_REQUEST_BYTES);
    const step = expectKind(await go(w, { message: handoffFor(document) }), 'refused');
    expect(step.code).toBe('request_too_large');
    expect(step.detail).toContain('the runtime takes at most');
    expect(untouched(w)).toStrictEqual(NOTHING);
  });

  it('counts the wire payload that is sent and not the request that the agent got: the canonical form makes a text of the NFC form longer', async () => {
    const w = await world();
    // U+1D15E is four bytes. Its NFC form is two code points of four bytes each.
    const note = '\u{1D15E}'.repeat(115_000);
    const document = purchaseOrder({ note });
    expect(Buffer.byteLength(JSON.stringify(document), 'utf8')).toBeLessThan(MAX_REQUEST_BYTES);
    expect(wireBytes(document)).toBeGreaterThan(MAX_REQUEST_BYTES);
    expect(wireBytes(document)).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES - 1_000);
    const step = expectKind(await go(w, { message: handoffFor(document) }), 'refused');
    expect([step.code, step.detail]).toStrictEqual(['request_too_large', expect.stringContaining('a service takes at most')]);
    expect(untouched(w)).toStrictEqual(NOTHING);
    // The twin: plain letters of the same size in the request come to a wire payload under the limit, and the hire is made.
    expect(words(await go(w, { message: handoffFor(purchaseOrder({ note: 'a'.repeat(460_000) })) }))).toBe('completed');
  });
});

describe('the advert that the document names', () => {
  it('refuses an advert that is not on the chain: advert_unavailable, and nothing is paid', async () => {
    const w = await world();
    const step = expectKind(await go(w, { message: handoffFor(purchaseOrder({ advert_ref: `${'ee'.repeat(32)}#0` })) }), 'failed');
    expect([step.reason, step.handoff, step.vault_ref]).toStrictEqual(['advert_unavailable', null, null]);
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(words(await go(w))).toBe('completed');
  });

  it('refuses an advert that is on the chain and is not Active', async () => {
    const w = await world({ market: { agentAdvert: { ...AGENT_ADVERT, status: 'Retired' } } });
    expect(words(await go(w))).toBe('failed advert_unavailable');
    expect(untouched(w)).toStrictEqual(NOTHING);
  });

  it('refuses an advert of another capability than the caller asked for, and an advert of another model', async () => {
    const w = await world();
    expect(words(await go(w, { capability_id: 'llm.text.generate.v1' }))).toBe('failed advert_unavailable');
    expect(words(await go(w, { model: 'order-desk-large' }))).toBe('failed advert_unavailable');
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(words(await go(w, { model: 'order-desk-small' }))).toBe('completed');
  });

  it('refuses an advert that is Active on the chain and is another capability: the chain is read for the advert that the document names, and the indexer is not asked', async () => {
    const w = await world();
    const step = await go(w, { message: handoffFor(purchaseOrder({ advert_ref: LLM_ADVERT_REF })) });
    expect(words(step)).toBe('failed advert_unavailable');
    expect(untouched(w)).toStrictEqual(NOTHING);
    expect(w.m.calls.filter((call) => call.url.startsWith(INDEXER))).toStrictEqual([]);
  });

  const LIMITS: Array<[string, Partial<Record<'maxPriceLovelace' | 'maxSupplierBondLovelace' | 'maxBuyerBondLovelace', bigint>>, bigint]> = [
    ['the price', { maxPriceLovelace: 199_999n }, 200_000n],
    ['the supplier bond', { maxSupplierBondLovelace: 999_999n }, 1_000_000n],
    ['the buyer bond', { maxBuyerBondLovelace: 999_999n }, 1_000_000n],
  ];
  for (const [name, below, atLimit] of LIMITS) {
    it(`refuses an advert whose ${name} is above its limit by one lovelace, before any Pay, and hires at the limit`, async () => {
      const w = await world();
      const [limit] = Object.keys(below);
      expect(words(await go(w, { limits: { ...NO_LIMITS, ...below } }))).toBe('failed advert_unavailable');
      expect(untouched(w)).toStrictEqual(NOTHING);
      expect(words(await go(w, { limits: { ...NO_LIMITS, [limit!]: atLimit } }))).toBe('completed');
    });
  }
});

describe('two jobs at one time on one delegation key', () => {
  it('runs them one after the other: the second job reads the vault that the first Pay left, and both complete', async () => {
    const w = await world();
    const events: string[] = [];
    const read = w.reads.liveVaults.bind(w.reads);
    vi.spyOn(w.reads, 'liveVaults').mockImplementation(async (id, at) => { events.push('read'); return read(id, at); });
    const accepted = w.deps.hire.ledger.accepted.bind(w.deps.hire.ledger);
    w.deps.hire.ledger.accepted = (accept) => { events.push('accepted'); accepted(accept); };
    const [a, b] = await Promise.all([
      go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0001' })) }),
      go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) }),
    ]);
    const first = expectKind(a, 'completed');
    const second = expectKind(b, 'completed');
    expect(events).toStrictEqual(['read', 'accepted', 'read', 'accepted']);
    expect(first.handoff.escrow_ref).not.toBe(second.handoff.escrow_ref);
    // The vault chain is a line: the first Pay spent the vault of the world, the second spent the vault that the first left, and the vault of the second is the live one.
    expect(w.m.chain.vault(w.vault)).toMatchObject({ consumed: true });
    expect(w.m.chain.vault(first.vault_ref ?? '')).toMatchObject({ consumed: true });
    expect(w.m.chain.vault(second.vault_ref ?? '')).toMatchObject({ kind: 'Live', consumed: false });
    const documents = w.m.agent.sends.map((send) => (JSON.parse((JSON.parse(send.payload) as Array<{ content: string }>)[0]!.content) as { document: { po_number: string } }).document.po_number);
    expect(documents).toStrictEqual(['run1-0001', 'run1-0002']);
  });

  it('keeps the second job going when the first one fails: the lane is free after a failure', async () => {
    const w = await world();
    w.m.agent.refuse = { status: 403, code: 'sender_not_active' };
    const [a, b] = await Promise.all([go(w), go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) })]);
    expect(words(a)).toBe('refused_by_counterparty before_claim sender_not_active');
    expect(words(b)).toBe('refused_by_counterparty before_claim sender_not_active');
    expect(w.m.chain.vaults().filter((vault) => !vault.consumed)).toHaveLength(1);
  });

  it('does not pay for a second job whose deadline came while it waited for the lane: failed with the reason deadline, and its vault is not spent', async () => {
    const w = await world({ deadlineMs: 20_000 });
    w.m.agent.steps = ['running', 'running', 'running', 'running', 'running', 'running', 'running', 'running', 'done'];
    const [a, b] = await Promise.all([go(w), go(w, { message: handoffFor(purchaseOrder({ po_number: 'run1-0002' })) })]);
    expect(words(a)).toBe('interrupted deadline');
    const second = expectKind(b, 'failed');
    expect([second.reason, second.handoff, second.vault_ref]).toStrictEqual(['deadline', null, null]);
    expect(w.booked.posted).toHaveLength(1);
    expect(w.m.agent.sends).toHaveLength(1);
    // The vault that the first Pay left is live and unspent.
    expect(w.m.chain.vaults().filter((vault) => !vault.consumed)).toHaveLength(1);
  });
});

describe('the deadline of the job', () => {
  it('does not pay when the deadline has come: failed with the reason deadline, and nothing is spent, sent or recorded', async () => {
    const w = await world();
    w.deps.hire.deadlineMs = T0;
    const step = expectKind(await go(w), 'failed');
    expect([step.reason, step.handoff, step.vault_ref]).toStrictEqual(['deadline', null, null]);
    expect(untouched(w)).toStrictEqual(NOTHING);
    // The twin: a deadline after the clock lets the hire go on.
    w.deps.hire.deadlineMs = T0 + 1_000_000;
    expect(words(await go(w))).toBe('completed');
  });

  it('does not pay when the deadline leaves less time than the first poll of the hire kit, and pays when it leaves exactly that time', async () => {
    const short = await world();
    short.m.agent.steps = ['done'];
    short.deps.hire.deadlineMs = T0 + POLL_INTERVAL_MS - 1;
    expect(words(await go(short))).toBe('failed deadline');
    expect(untouched(short)).toStrictEqual(NOTHING);
    const exact = await world();
    exact.m.agent.steps = ['done'];
    exact.deps.hire.deadlineMs = T0 + POLL_INTERVAL_MS;
    expect(words(await go(exact))).toBe('completed');
  });
});

describe('the hire of a bidder with a request for quotation', () => {
  const rfq = parseRfq({ schema: RFQ_SCHEMA, sender_did: BUYER_DID, delegation: DELEGATION, rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 5 }] } });
  if (!rfq.ok) throw new Error('the request for quotation of the test is refused');

  it('hires the advert that the caller names, from the vault, with the request for quotation as the payload', async () => {
    const w = await world();
    const step = expectKind(await go(w, { message: rfq.value, advert_ref: AGENT_ADVERT_REF }), 'completed');
    expect(step.handoff).toMatchObject({ advert_ref: AGENT_ADVERT_REF, paid_from_vault: true });
    const content = (JSON.parse(w.m.agent.sends[0]!.payload) as Array<{ content: string }>)[0]!.content;
    expect(parseRfq(JSON.parse(content))).toStrictEqual(rfq);
    expect(content).toBe(requestText(rfq.value));
  });

  it('refuses a quote hire with no advert, or with an advert that is no output reference, as internal: the caller found the advert', async () => {
    for (const advert of [undefined, 'not a reference']) {
      const w = await world();
      const step = expectKind(await go(w, { message: rfq.value, advert_ref: advert as never }), 'refused');
      expect(step.code).toBe('internal');
      expect(untouched(w)).toStrictEqual(NOTHING);
    }
  });

  it('checks the authority for a quote in the same way: a delegation of another agent is refused', async () => {
    const w = await world();
    w.reads.delegations.set(DELEGATION, { delegate: OTHER_ID, chain_whole: true });
    expect(words(await go(w, { message: rfq.value, advert_ref: AGENT_ADVERT_REF }))).toBe('refused delegation_not_mine');
  });
});
