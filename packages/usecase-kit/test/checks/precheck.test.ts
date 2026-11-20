// packages/usecase-kit/test/checks/precheck.test.ts: the checks as the `precheck` option of service-kit. A refusal is the status and the code of the protocol with a message, and a go is the answer
// only when every check passed. The last part runs the option inside a real `createJobServer` on the loopback interface, with the context headers of the runtime.
import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, Refusal } from '@vsa/service-kit';
import { CheckUnavailableError, precheckOf } from '../../src/checks/index.ts';
import type { ChecksPorts, ExtraCheck } from '../../src/checks/index.ts';
import {
  AFTER_CLAIM_REFUSALS, APPROVAL_REFUSALS, COUNTERPARTY_REFUSALS, DELEGATION_REFUSALS, ERROR_STATUS, SENDER_REFUSALS, VAULT_REFUSALS, accepted, parseHandoff, parseJsonText, refused,
} from '../../src/protocol/index.ts';
import type { CounterpartyKind, Handoff, RfqMessage } from '../../src/protocol/index.ts';
import { DOCUMENT, T, failing, makeWorld, proposalOf, withLedger } from './support.ts';
import type { World } from './support.ts';

const STRANGER = 'c0'.repeat(28);
const noFacts = accepted({});
/** An extra check that passes and notes when it ran. */
const noting = (ran: string[], name: string): ExtraCheck<Handoff> => ({ names: [name], run: async () => { ran.push(name); return noFacts; } });
const SHARED_CODES: readonly string[] = [...SENDER_REFUSALS, ...DELEGATION_REFUSALS, ...VAULT_REFUSALS, ...APPROVAL_REFUSALS];

describe('the answer of the option', () => {
  it.each(['order-desk', 'insurer-intake-agent', 'bid-desk'] as const)('is { go: true } for the %s when every check passed', async (kind) => {
    const world = makeWorld();
    const answer = kind === 'bid-desk' ? await precheckOf({ kind, ports: world.ports })(world.rfq, world.context) : await precheckOf({ kind, ports: world.ports })(world.handoff, world.context);
    expect(answer).toEqual({ go: true });
  });

  it('is a refusal with the status and the code of the protocol, and the detail of the check as its message', async () => {
    const world = makeWorld({ delegation: { notAfter: T - 1 } });
    const answer = await precheckOf({ kind: 'order-desk', ports: world.ports })(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'delegation_ended', message: expect.stringContaining('cannot be used now') });
    expect(answer).toEqual({ go: false, status: ERROR_STATUS.delegation_ended, error: 'delegation_ended', message: expect.any(String) });
  });

  it('is the status of ERROR_STATUS for every code that the shared list can give', async () => {
    const worlds: Array<[string, () => Promise<unknown>]> = [];
    const answerOf = async (world: World, context: JobContext = world.context) => precheckOf({ kind: 'order-desk', ports: world.ports })(world.handoff, context);
    worlds.push(['sender_not_active', async () => { const w = makeWorld(); w.gateway.setStatus(w.sender, 'revoked'); return answerOf(w); }]);
    worlds.push(['sender_key_mismatch', async () => { const w = makeWorld(); return answerOf(w, { ...w.context, buyerPkh: STRANGER }); }]);
    worlds.push(['approval_wrong_type', async () => answerOf(makeWorld({ attestation: { attType: 15 } }))]);
    worlds.push(['approval_digest_mismatch', async () => answerOf(makeWorld({ attestation: { digest: proposalOf({ ...DOCUMENT, quantity: 9 }).proposal_digest } }))]);
    worlds.push(['check_unavailable', async () => { const w = makeWorld(); return precheckOf({ kind: 'order-desk', ports: withLedger(w, { readDelegation: failing }) })(w.handoff, w.context); }]);
    for (const [code, answer] of worlds) {
      expect(await answer(), code).toMatchObject({ go: false, error: code, status: ERROR_STATUS[code as keyof typeof ERROR_STATUS] });
    }
    expect(ERROR_STATUS.check_unavailable).toBe(503);
  });

  it('is a refusal with status 503 and the code check_unavailable for a read that fails, and the message holds no secret of the read', async () => {
    const world = makeWorld();
    const answer = await precheckOf({ kind: 'order-desk', ports: withLedger(world, { escrowPaid: failing }) })(world.handoff, world.context);
    expect(answer).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the vault payment could not be read' });
    expect(world.faults).toHaveLength(1);
  });

  it('is never a go for a fault of the checks: the answer is a rejection', async () => {
    const world = makeWorld();
    const broken: ChecksPorts = { ...world.ports, clock: () => Number.NaN };
    await expect(precheckOf({ kind: 'order-desk', ports: broken })(world.handoff, world.context)).rejects.toBeInstanceOf(TypeError);
    const garbage: ExtraCheck<Handoff> = { names: ['lot'], run: async () => ({}) as never };
    await expect(precheckOf({ kind: 'order-desk', ports: world.ports, extra: [garbage] })(world.handoff, world.context)).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a request of the wrong form for its kind: a handoff to a bid desk is an error and not a go', async () => {
    const world = makeWorld();
    const option = precheckOf({ kind: 'bid-desk', ports: world.ports }) as unknown as (request: Handoff, context: JobContext) => Promise<unknown>;
    await expect(option(world.handoff, world.context)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('the hooks', () => {
  it('calls onPass with the record, the request and the context when every check passed, and not when a check refused', async () => {
    const world = makeWorld();
    const seen: unknown[] = [];
    const option = precheckOf({ kind: 'order-desk', ports: world.ports, onPass: (record, request, context) => { seen.push([record.checks, request, context]); } });
    expect(await option(world.handoff, world.context)).toEqual({ go: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([expect.objectContaining({ sender_active: true, approval_digest: true }), world.handoff, world.context]);
    const refused = makeWorld({ organisation: null });
    expect(await precheckOf({ kind: 'order-desk', ports: refused.ports, onPass: () => { seen.push('again'); } })(refused.handoff, refused.context)).toMatchObject({ go: false });
    expect(seen).toHaveLength(1);
  });

  it('does not answer a go when onPass throws: the answer is a rejection', async () => {
    const world = makeWorld();
    const option = precheckOf({ kind: 'order-desk', ports: world.ports, onPass: () => { throw new Error('the store is full'); } });
    await expect(option(world.handoff, world.context)).rejects.toThrow('the store is full');
  });

  it('calls onRefused with the refusal, and the two digests when the approval does not match, and puts its text after the message', async () => {
    const other = proposalOf({ ...DOCUMENT, quantity: 9 });
    const world = makeWorld({ attestation: { digest: other.proposal_digest } });
    const calls: unknown[] = [];
    const option = precheckOf({
      kind: 'order-desk', ports: world.ports,
      onRefused: (refusal) => { calls.push(refusal); return 'challenge 12ab#0'; },
    });
    const answer = await option(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    expect(answer).toMatchObject({ message: expect.stringMatching(/ challenge 12ab#0$/) });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ ok: false, code: 'approval_digest_mismatch', digests: { expected_digest: other.proposal_digest, observed_digest: world.proposal.proposal_digest } });
    // The approval was the check that refused, so the six checks before it passed.
    expect(Object.keys((calls[0] as { record: { checks: object } }).record.checks)).toEqual(['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid']);
  });

  it('does not call onRefused for a go, and ignores a text that is empty or is not a text', async () => {
    const world = makeWorld();
    let called = 0;
    expect(await precheckOf({ kind: 'order-desk', ports: world.ports, onRefused: () => { called += 1; } })(world.handoff, world.context)).toEqual({ go: true });
    expect(called).toBe(0);
    const bad = makeWorld({ organisation: null });
    for (const note of ['', undefined, 5 as unknown as string]) {
      const answer = await precheckOf({ kind: 'order-desk', ports: bad.ports, onRefused: () => note })(bad.handoff, bad.context);
      expect(answer).toMatchObject({ go: false, error: 'sender_unaccountable', message: 'the record of the sender lists no Accountable Party' });
    }
  });

  it('answers the refusal when onRefused throws, and tells the service', async () => {
    const world = makeWorld({ organisation: null });
    const option = precheckOf({ kind: 'order-desk', ports: world.ports, onRefused: async () => { throw new Error('the challenge could not be filed: key=secret-token'); } });
    const answer = await option(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'sender_unaccountable' });
    expect(JSON.stringify(answer)).not.toContain('secret-token');
    expect(world.faults.map(([source]) => source)).toEqual(['refusal hook']);
  });
});

describe('the checks of the kind', () => {
  it('run after the shared checks, in their order, and their names and facts join the record', async () => {
    const world = makeWorld();
    const ran: string[] = [];
    const first: ExtraCheck<Handoff> = { names: ['for_this_supplier'], run: async (request, context) => { ran.push(`${request.sender_did === world.sender.did}:${context.escrowRef === world.context.escrowRef}`); return accepted({ supplier: 'ok' }); } };
    let record: unknown;
    const option = precheckOf({ kind: 'order-desk', ports: world.ports, extra: [first, noting(ran, 'lot'), noting(ran, 'quantity')], onPass: (checks) => { record = checks; } });
    expect(await option(world.handoff, world.context)).toEqual({ go: true });
    expect(ran).toEqual(['true:true', 'lot', 'quantity']);
    expect(record).toMatchObject({ facts: { supplier: 'ok', organisation: 'buyer.example' } });
    expect(Object.keys((record as { checks: object }).checks).slice(-4)).toEqual(['approval_digest', 'for_this_supplier', 'lot', 'quantity']);
  });

  it('do not run when a shared check refuses, and the shared refusal is the answer', async () => {
    const world = makeWorld({ organisation: null });
    const ran: string[] = [];
    const answer = await precheckOf({ kind: 'order-desk', ports: world.ports, extra: [noting(ran, 'lot')] })(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, error: 'sender_unaccountable' });
    expect(ran).toEqual([]);
  });

  it('do not run after a refusal of a check of the kind: the first refusal is the answer', async () => {
    const world = makeWorld();
    const ran: string[] = [];
    const refusing: ExtraCheck<Handoff> = { names: ['lot'], run: async () => refused('lot_mismatch', 'the lot is not the lot that was paid for') };
    const answer = await precheckOf({ kind: 'order-desk', ports: world.ports, extra: [noting(ran, 'supplier'), refusing, noting(ran, 'quantity')] })(world.handoff, world.context);
    expect(answer).toEqual({ go: false, status: 403, error: 'lot_mismatch', message: 'the lot is not the lot that was paid for' });
    expect(ran).toEqual(['supplier']);
  });

  const KINDS: CounterpartyKind[] = ['order-desk', 'insurer-intake-agent', 'bid-desk'];
  const own = (kind: CounterpartyKind): string[] => COUNTERPARTY_REFUSALS[kind].filter((code) => !SHARED_CODES.includes(code) && !(AFTER_CLAIM_REFUSALS as readonly string[]).includes(code));

  it.each(KINDS)('may refuse with each code of its own page that comes before the Claim, and with no other code (%s)', async (kind) => {
    const world = makeWorld();
    const request: Handoff | RfqMessage = kind === 'bid-desk' ? world.rfq : world.handoff;
    expect(own(kind).length).toBeGreaterThan(0);
    for (const code of own(kind)) {
      const check: ExtraCheck<Handoff | RfqMessage> = { names: ['kind_check'], run: async () => refused(code as 'duplicate_po', 'no') };
      const option = precheckOf({ kind, ports: world.ports, extra: [check] } as never) as unknown as (r: unknown, c: JobContext) => Promise<unknown>;
      expect(await option(request, world.context), code).toEqual({ go: false, status: 403, error: code, message: 'no' });
    }
    const forbidden = [...SHARED_CODES, ...AFTER_CLAIM_REFUSALS, 'token_invalid', 'nope', ...COUNTERPARTY_REFUSALS[kind === 'order-desk' ? 'insurer-intake-agent' : 'order-desk'].filter((code) => !own(kind).includes(code))];
    for (const code of forbidden) {
      const check: ExtraCheck<Handoff | RfqMessage> = { names: ['kind_check'], run: async () => ({ ok: false, code, detail: 'no' }) as never };
      const option = precheckOf({ kind, ports: world.ports, extra: [check] } as never) as unknown as (r: unknown, c: JobContext) => Promise<unknown>;
      await expect(option(request, world.context), code).rejects.toBeInstanceOf(TypeError);
    }
  });

  it('may answer check_unavailable, by a refusal or by CheckUnavailableError, and the answer is a 503', async () => {
    const world = makeWorld();
    const byAnswer: ExtraCheck<Handoff> = { names: ['lots'], run: async () => refused('check_unavailable', 'the lots file could not be read') };
    const byError: ExtraCheck<Handoff> = { names: ['lots'], run: async () => { throw new CheckUnavailableError('lots file'); } };
    expect(await precheckOf({ kind: 'order-desk', ports: world.ports, extra: [byAnswer] })(world.handoff, world.context)).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the lots file could not be read' });
    expect(await precheckOf({ kind: 'order-desk', ports: world.ports, extra: [byError] })(world.handoff, world.context)).toEqual({ go: false, status: 503, error: 'check_unavailable', message: 'the lots file could not be read' });
  });

  it('are a TypeError when they are wrong: a name that a shared check has, a name that two checks have, no function, and a kind that is not a counterparty kind', () => {
    const world = makeWorld();
    const ok = noting([], 'lot');
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [ok] })).not.toThrow();
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [noting([], 'sender_key')] })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [noting([], 'approval_digest')] })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [ok, noting([], 'lot')] })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [{ names: ['lot'] } as unknown as ExtraCheck<Handoff>] })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, extra: [{ names: [], run: async () => noFacts } as unknown as ExtraCheck<Handoff>] })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'reorder-agent' as unknown as 'order-desk', ports: world.ports })).toThrow(TypeError);
    expect(() => precheckOf({ kind: 'order-desk', ports: world.ports, onPass: 'yes' as unknown as () => void })).toThrow(TypeError);
    // The name of an approval check is free for a bid desk, which has none.
    expect(() => precheckOf({ kind: 'bid-desk', ports: world.ports, extra: [noting([], 'approval_digest') as unknown as ExtraCheck<RfqMessage>] })).not.toThrow();
  });
});

describe('inside createJobServer, as the runtime calls it', () => {
  const TOKEN = `Bearer ${'ab'.repeat(16)}`;

  class Bad extends Error { constructor(readonly refusal: Refusal) { super(refusal.message); } }
  const wire = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);
  const headers = (context: JobContext): Record<string, string> => ({
    authorization: TOKEN, 'x-vector-escrow-ref': context.escrowRef, 'x-vector-advert-ref': context.advertRef, 'x-vector-advert-model': context.advertModel, 'x-vector-buyer-pkh': context.buyerPkh,
    'x-vector-payment-lovelace': String(context.paymentLovelace), 'x-vector-deliver-by-ms': String(context.deliverByMs),
  });

  async function precheck(world: World, ports: ChecksPorts, body: unknown, context: JobContext = world.context): Promise<{ status: number; body: unknown }> {
    const server: Server = createJobServer<Handoff, { done: true }>({
      manifestText: '{}', authHeader: TOKEN, clock: () => T, log: () => undefined,
      parse: (json) => {
        const text = parseJsonText(json);
        const handoff = text.ok ? parseHandoff(text.value) : text;
        if (!handoff.ok) throw new Bad({ code: handoff.code, status: ERROR_STATUS[handoff.code], message: handoff.detail, kind: 'request' });
        return handoff.value;
      },
      run: async () => ({ done: true }), refusalOf: (error) => (error instanceof Bad ? error.refusal : null),
      precheck: precheckOf({ kind: 'order-desk', ports }),
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const reply = await fetch(`http://127.0.0.1:${port}/precheck`, { method: 'POST', body: wire(body), headers: headers(context) });
      return { status: reply.status, body: await reply.json() };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  it('answers 200 with go for a handoff that passes every check, and the slot is reserved', async () => {
    const world = makeWorld();
    expect(await precheck(world, world.ports, world.handoff)).toEqual({ status: 200, body: { go: true, reserved_ms: 120000 } });
  });

  it('answers 403 with the code and the message of the refusal, and the escrow stays open', async () => {
    const world = makeWorld();
    world.gateway.setStatus(world.sender, 'suspended');
    const reply = await precheck(world, world.ports, world.handoff);
    expect(reply).toEqual({ status: 403, body: { error: 'sender_not_active', message: 'the sender is not Active (suspended)' } });
  });

  it('takes the buyer key from the header of the runtime: a key that the record does not list is refused', async () => {
    const world = makeWorld();
    const reply = await precheck(world, world.ports, world.handoff, { ...world.context, buyerPkh: STRANGER });
    expect(reply).toMatchObject({ status: 403, body: { error: 'sender_key_mismatch' } });
  });

  it('refuses a body that names a buyer key before any check: the protocol knows no such member', async () => {
    const world = makeWorld();
    const reply = await precheck(world, world.ports, { ...world.handoff, buyer_pkh: world.delegateKey.keyHash });
    expect(reply).toMatchObject({ status: 400, body: { error: 'bad_shape' } });
  });

  it('answers 503 for a read that failed, and never 200', async () => {
    const world = makeWorld();
    const reply = await precheck(world, withLedger(world, { readDelegation: failing }), world.handoff);
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: 'check_unavailable' });
    expect(JSON.stringify(reply.body)).not.toContain('secret-token');
  });

  it('answers 500 and never a go for a fault of the checks: a clock that gives no time', async () => {
    const world = makeWorld();
    const reply = await precheck(world, { ...world.ports, clock: () => Number.NaN }, world.handoff);
    expect(reply).toEqual({ status: 500, body: { error: 'internal' } });
  });
});
