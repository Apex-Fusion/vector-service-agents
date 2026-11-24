// The real wiring of the approval check (src/wiring.ts). The service runs the check of the use-case kit on the ledger and the gateway that it has. These tests use the fixture world of
// packages/buyer-core and the stub gateway of @vsa/id-kit: the member approves a ranking as an attestation on the fixture ledger, and the real check reads it. No test touches a network.
// The question of these tests: does the service ever accept a ranking whose approval is wrong, and does it ever answer anything but 503 when the check cannot read its sources?
// Each refusal has the call that is accepted beside it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent } from '@vsa/id-kit/testing';
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import { APPROVAL_TIMEOUT_MS, decideApproval } from '../src/approval.ts';
import type { ApprovalInput } from '../src/approval.ts';
import { KOIOS_DEFAULT } from '../src/config.ts';
import { APPROVAL_CODES } from '../src/errors.ts';
import type { ApprovalCode, Outcome } from '../src/errors.ts';
import { NO_APPROVAL_CHECK, startService } from '../src/start.ts';
import { APPROVAL_READ_BUDGET_MS, wireApprovalCheck } from '../src/wiring.ts';
import type { ApprovalSources } from '../src/wiring.ts';
import { CHILD_PROBE_MS, CHILD_TEST_MS } from './support/child.ts';
import { freePort, listening, send as sendTo, startChild } from './support/net.ts';
import { callWithToken, delegateTo, rankingBody, rankingsOf, scenario } from './support/scenario.ts';
import type { RankingBody } from './support/scenario.ts';
import { APPROVAL_ID, HOUR, INSURER_ORG, OPERATOR_TOKEN, PUBLIC_BASE, SUPPLIER_ORG, T0, World, resourceOf, serviceEnvironment } from './support/world.ts';

const TENANT = 'run1';
const ROUTE = '/sourcing/rankings';
/** The name of an approval that a test issues as the one that is good, next to an approval that is wrong. */
const GOOD_ID = '09'.repeat(32);
/** An https address on the loopback interface at a port where nothing listens: the start must not need it, and a read of it fails at once. */
const nobody = async (): Promise<string> => `https://127.0.0.1:${await freePort()}`;

const refused = (reply: { status: number; json: Record<string, unknown> | null }, status: number, code: string) => {
  expect([reply.status, reply.json?.error]).toEqual([status, code]);
};

async function setup() {
  const s = await scenario(TENANT, {}, { realApproval: true });
  const agent = delegateTo(s, 'sourcing', [['sourcing.award.write', 'sourcing']]);
  const alfa = s.world.agent('desk-alfa');
  const bravo = s.world.agent('desk-bravo');
  const sent = rankingBody(TENANT, alfa.did, bravo.did);
  const send = (body: unknown) => callWithToken(s, agent, 'sourcing', 'POST', ROUTE, body);
  const lastRule = (): unknown => s.harness.logged().at(-1)?.rule;
  return { s, agent, alfa, bravo, sent, send, lastRule };
}

describe('the real approval check on the whole route', () => {
  it('writes the ranking that the member approved: the check reads the attestation and the delegation on the ledger and passes', async () => {
    const { s, agent, sent, send } = await setup();
    s.world.approve(agent.agent, sent.ranking, sent.salt);
    const reply = await send(sent);
    expect(reply.status, reply.text).toBe(201);
    expect(reply.json).toMatchObject({ ranking_id: 'RK-run1-0001', rfq_id: 'rfq-1' });
    expect(s.harness.logged().at(-1)).toMatchObject({ route: 'POST /sourcing/rankings', decision: 'allowed', status: 201 });
    expect(await rankingsOf(s)).toHaveLength(1);
  });

  const OTHER_HIRER = ed25519Key('another hirer');
  interface Wrong {
    readonly code: ApprovalCode;
    readonly what: string;
    /** Issues an approval that is wrong in this one way, and gives the name that the call uses for it. */
    readonly issue: (world: World, sender: StubAgent, other: StubAgent, sent: RankingBody) => string;
  }
  const wrong: readonly Wrong[] = [
    { code: 'approval_not_found', what: 'no output of the ledger holds the approval that the call names', issue: () => '08'.repeat(32) },
    { code: 'approval_wrong_type', what: 'the attestation is of another type', issue: (w, sender, _o, r) => w.approve(sender, r.ranking, r.salt, { attType: 15 }) },
    { code: 'approval_wrong_subject', what: 'the approval is for another agent', issue: (w, _s, other, r) => w.approve(other, r.ranking, r.salt) },
    { code: 'approval_wrong_issuer', what: 'the issuer is not the root delegator of the delegation', issue: (w, sender, _o, r) => w.approve(sender, r.ranking, r.salt, { issuer: OTHER_HIRER.publicKeyHex }) },
    { code: 'approval_revoked', what: 'the approval was revoked', issue: (w, sender, _o, r) => w.approve(sender, r.ranking, r.salt, { status: { type: 'AttRevoked', at: T0 - HOUR, reason: 0 } }) },
    { code: 'approval_expired', what: 'the approval ended before the call', issue: (w, sender, _o, r) => w.approve(sender, r.ranking, r.salt, { validUntil: T0 - 1 }) },
    { code: 'approval_issuer_invalid', what: 'the signature of its envelope does not verify', issue: (w, sender, _o, r) => w.approve(sender, r.ranking, r.salt, { envelopeSig: '01'.repeat(64) }) },
    { code: 'approval_digest_mismatch', what: 'the member approved another ranking', issue: (w, sender, _o, r) => w.approve(sender, { ...r.ranking, rfq_id: 'rfq-2' }, r.salt) },
  ];
  it('covers each of the eight codes of an approval, once', () => {
    expect(wrong.map((entry) => entry.code)).toEqual([...APPROVAL_CODES]);
  });
  it.each(wrong)('$code, $what: the call is 403 with that code and nothing is written, and the same call with a good approval is written', async ({ code, issue }) => {
    const { s, agent, bravo, sent, send, lastRule } = await setup();
    const named = issue(s.world, agent.agent, bravo, sent);
    const reply = await send({ ...sent, approval: { ...sent.approval!, attestation: named } });
    refused(reply, 403, code);
    expect(lastRule()).toBe(`approval.${code}`);
    expect(await rankingsOf(s)).toEqual([]);
    s.world.approve(agent.agent, sent.ranking, sent.salt, {}, GOOD_ID);
    const twin = await send({ ...sent, approval: { ...sent.approval!, attestation: GOOD_ID } });
    expect(twin.status, twin.text).toBe(201);
    expect(await rankingsOf(s)).toHaveLength(1);
  });

  it('refuses a salt that the member did not approve, and a ranking that differs in one value: the digest is of the ranking and the salt exactly as they were sent', async () => {
    const { s, agent, sent, send } = await setup();
    s.world.approve(agent.agent, sent.ranking, sent.salt);
    refused(await send({ ...sent, salt: 'a7'.repeat(32) }), 403, 'approval_digest_mismatch');
    refused(await send({ ...sent, ranking: { ...sent.ranking, rfq_sha256: '5b'.repeat(32) } }), 403, 'approval_digest_mismatch');
    expect(await rankingsOf(s)).toEqual([]);
    expect((await send(sent)).status).toBe(201);
  });

  const unreadable = [
    ['the attestation', 'attestation'],
    ['the delegation', 'delegation'],
    ['the attestation and the delegation', 'both'],
  ] as const;
  it.each(unreadable)('a ledger that cannot be read for %s is 503 approval_unavailable and nothing is written, and the same call is written when the ledger answers', async (_what, fault) => {
    const { s, agent, sent, send, lastRule } = await setup();
    s.world.approve(agent.agent, sent.ranking, sent.salt);
    s.world.approvalFault = fault;
    const reply = await send(sent);
    refused(reply, 503, 'approval_unavailable');
    expect(lastRule()).toBe('approval.failed');
    expect(reply.json?.message).toBe(`the approval check could not run: the ${fault === 'delegation' ? 'delegation' : 'attestation'} could not be read`);
    expect(await rankingsOf(s)).toEqual([]);
    s.world.approvalFault = null;
    expect((await send(sent)).status).toBe(201);
    expect(await rankingsOf(s)).toHaveLength(1);
  });

  /** A ranking that no digest can bind: the canonical form refuses it, so the check fails to run for it. The text of the body is what the caller sends. */
  const nested = (levels: number): Record<string, unknown> => (levels === 0 ? { end: true } : { down: nested(levels - 1) });
  const unbindable: ReadonlyArray<readonly [what: string, body: (sent: RankingBody) => string]> = [
    ['a key that is a whole number', (sent) => JSON.stringify({ ...sent, ranking: { ...sent.ranking, 7: 'x' } })],
    ['the key __proto__', (sent) => JSON.stringify(sent).replace('"rfq_id"', '"__proto__":1,"rfq_id"')],
    ['a key that is not in the NFC form', (sent) => JSON.stringify({ ...sent, ranking: { ...sent.ranking, 'e\u0301': 'x' } })],
    ['more than 32 levels of objects', (sent) => JSON.stringify({ ...sent, ranking: { ...sent.ranking, deep: nested(40) } })],
    ['a number that is not finite', (sent) => JSON.stringify(sent).replace('"price":0.4', '"price":1e999')],
  ];
  it.each(unbindable)('a ranking with %s makes the check fail to run: 503 approval_unavailable, nothing is written, and the ranking without it is written', async (_what, text) => {
    const { s, agent, sent, send, lastRule } = await setup();
    s.world.approve(agent.agent, sent.ranking, sent.salt);
    const reply = await send(text(sent));
    refused(reply, 503, 'approval_unavailable');
    expect(lastRule()).toBe('approval.failed');
    expect(reply.json?.message).toContain('the approval check could not run: the input of the approval check is wrong');
    expect(await rankingsOf(s)).toEqual([]);
    expect((await send(sent)).status).toBe(201);
  });
});

/** A world with one agent, its delegation from the member and the approval of one ranking. The wired check is bound to the ledger and the gateway of that world. */
function direct() {
  const world = new World();
  const sender = world.agent('sourcing');
  const delegation = world.delegate({ delegate: sender, actions: ['sourcing.award.write'], resources: [resourceOf(TENANT, 'sourcing')], remaining: 1 });
  const sent = rankingBody(TENANT, world.agent('desk-alfa').did, world.agent('desk-bravo').did);
  world.approve(sender, sent.ranking, sent.salt);
  const input: ApprovalInput = {
    sender: sender.did, delegation: delegation.id, attestation: sent.approval!.attestation, issuerDid: sent.approval!.issuer_did, document: sent.ranking, salt: sent.salt, atMs: world.now(),
  };
  const sources = (): ApprovalSources => ({ ledger: world.approvalLedgerEnv(), gateway: world.client, now: world.now });
  return { world, input, sources, check: wireApprovalCheck(sources()) };
}

describe('the wired check', () => {
  it('answers { ok: true } for an approval that is good, and nothing else: the facts of the kit do not go on', async () => {
    const { check, input } = direct();
    expect(await check(input)).toStrictEqual({ ok: true });
  });

  it('takes the time of the check from the call and not from its clock: the approval is in force for four hours from now, and ends after', async () => {
    const { world, check, input } = direct();
    expect(await check({ ...input, atMs: world.now() + 4 * HOUR })).toStrictEqual({ ok: true });
    expect(await check({ ...input, atMs: world.now() + 4 * HOUR + 1 })).toMatchObject({ ok: false, code: 'approval_expired' });
  });

  it('answers a refusal with its code and its sentence and with no other member: the two digests of a mismatch stay with the kit', async () => {
    const { check, input } = direct();
    const other = { ...input, document: { ...input.document, rfq_id: 'rfq-2' } };
    expect(await check(other)).toStrictEqual({ ok: false, code: 'approval_digest_mismatch', detail: expect.any(String) });
  });

  it('compares the subject of the approval with the sender of the call: the same approval is refused for another sender', async () => {
    const { world, check, input } = direct();
    expect(await check({ ...input, sender: world.agent('someone else').did })).toMatchObject({ ok: false, code: 'approval_wrong_subject' });
  });

  it('gives the issuer record of the reference to the check: a reference that names another record than the attestation does is refused, and the right name is accepted', async () => {
    const world = new World();
    const hirer = world.agent('hirer');
    const sender = world.agent('sourcing');
    const delegation = world.delegate({ delegate: sender, delegator: hirer, actions: ['sourcing.award.write'], resources: [resourceOf(TENANT, 'sourcing')], remaining: 1 });
    const sent = rankingBody(TENANT, world.agent('desk-alfa').did, world.agent('desk-bravo').did);
    world.approve(sender, sent.ranking, sent.salt, { issuer: hirer.authentication.publicKeyHex, issuerId: hirer.id });
    const check = wireApprovalCheck({ ledger: world.approvalLedgerEnv(), gateway: world.client, now: world.now });
    const input: ApprovalInput = { sender: sender.did, delegation: delegation.id, attestation: APPROVAL_ID, issuerDid: hirer.did, document: sent.ranking, salt: sent.salt, atMs: world.now() };
    expect(await check(input)).toStrictEqual({ ok: true });
    expect(await check({ ...input, issuerDid: world.agent('another').did })).toMatchObject({ ok: false, code: 'approval_wrong_issuer' });
  });

  it('does not catch a source that cannot be read: the exception of the kit comes out, and the decision of the service is 503 approval_unavailable', async () => {
    const { world, input, sources } = direct();
    world.approvalFault = 'attestation';
    const check = wireApprovalCheck(sources());
    await expect(check(input)).rejects.toBeInstanceOf(CheckUnavailableError);
    const decided = await decideApproval(check, input);
    expect(decided.ok).toBe(false);
    if (!decided.ok) expect([decided.refusal.status, decided.refusal.code, decided.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.failed']);
    world.approvalFault = null;
    expect(await wireApprovalCheck(sources())(input)).toStrictEqual({ ok: true });
  });
});

describe('the budget of the ledger reads of the check', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is less than half of the wait of the service: the check makes two reads in a row, and each read has its own budget', () => {
    expect(APPROVAL_READ_BUDGET_MS * 2).toBeLessThan(APPROVAL_TIMEOUT_MS);
  });

  /** A ledger that waits `attestationMs` before it answers the first request of the read of the attestation, and that never answers the read of the delegation chain. */
  function slowLedger(world: World, attestationMs: number): ApprovalSources {
    const env = world.ledgerEnv();
    const never = new Promise<never>(() => undefined);
    let waited = false;
    const provider = new Proxy(env.provider, {
      get(target, name) {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== 'function') return member;
        return async (...args: unknown[]) => {
          const text = JSON.stringify(args, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
          if (text.includes(env.deployment.delegation.address) || text.includes(env.deployment.delegation.hash)) return never;
          if (!waited && (text.includes(env.deployment.attestation.address) || text.includes(env.deployment.attestation.hash))) {
            waited = true;
            await new Promise((resolve) => setTimeout(resolve, attestationMs));
          }
          return member.apply(target, args);
        };
      },
    });
    return { ledger: { ...env, provider }, gateway: world.client, now: world.now };
  }

  it('ends a check by its own budget before the wait of the service ends, also when the first read takes almost all of its budget: the call is 503 with the rule approval.failed and not approval.timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { world, input } = direct();
    const check = wireApprovalCheck(slowLedger(world, APPROVAL_READ_BUDGET_MS - 1));
    const decided: Outcome<null>[] = [];
    void decideApproval(check, input).then((outcome) => decided.push(outcome));
    // The attestation answers 1 ms before the end of its budget. The read of the delegation chain then has a budget of its own, and the check ends 1 ms before the end of two budgets.
    await vi.advanceTimersByTimeAsync(2 * APPROVAL_READ_BUDGET_MS - 2);
    expect(decided).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(decided).toHaveLength(1);
    const [outcome] = decided;
    expect(outcome!.ok).toBe(false);
    if (!outcome!.ok) {
      expect([outcome.refusal.status, outcome.refusal.code, outcome.refusal.rule]).toEqual([503, 'approval_unavailable', 'approval.failed']);
      expect(outcome.refusal.message).toBe('the approval check could not run: the delegation could not be read');
    }
  });
});

describe('the start with the real wiring', () => {
  it('starts the real entry (node --import tsx src/index.ts) with a complete valid environment, answers the check of health, and stops on SIGTERM', async () => {
    // The gateway and the ledger are at an address that nothing answers: the start must not need them.
    const dead = await nobody();
    const { child, port } = await startChild('src/index.ts', (port) => serviceEnvironment(port, { IDENTITY_GATEWAY_URL: dead, VECTOR_OGMIOS_URL: dead, VECTOR_KOIOS_URL: dead }));
    try {
      const health = await sendTo(port, { path: '/healthz', host: '127.0.0.1', signal: AbortSignal.timeout(CHILD_PROBE_MS) });
      expect([health.status, health.json], child.diagnostics()).toEqual([200, { ok: true }]);
      expect(child.stderr).not.toContain('cannot start');
      child.signal('SIGTERM');
      expect(await child.waitForExit('exit after SIGTERM'), child.diagnostics()).toEqual({ code: 0, signal: null });
      expect(await listening(port)).toBe(false);
    } finally {
      await child.cleanup();
    }
  }, CHILD_TEST_MS);

  it('gives the wiring the ledger of its settings, the gateway client and the clock of the service', async () => {
    const world = new World();
    const agent = world.agent('probe');
    const port = await freePort();
    const seen: ApprovalSources[] = [];
    const wire = (sources: ApprovalSources) => { seen.push(sources); return async () => ({ ok: true as const }); };
    const started = await startService(serviceEnvironment(port), { fetch: world.gateway.fetch, now: world.now, writeLog: () => undefined, wire });
    try {
      expect(seen).toHaveLength(1);
      const [sources] = seen;
      expect(sources!.now()).toBe(T0);
      expect(sources!.ledger.koiosUrl).toBe(KOIOS_DEFAULT);
      expect(sources!.ledger.deployment.escrow.hash).toMatch(/^[0-9a-f]{56}$/);
      const resolved = await sources!.gateway.resolve(agent.did);
      expect(resolved.ok, JSON.stringify(resolved)).toBe(true);
    } finally {
      await started.shutdown();
    }
  });

  it('runs the real check when it is given no option: a ranking whose approval cannot be verified, because the node and the indexer give no answer, is 503 approval_unavailable and is not written', async () => {
    const world = new World();
    const port = await freePort();
    const dead = await nobody();
    const started = await startService(serviceEnvironment(port, { VECTOR_OGMIOS_URL: dead, VECTOR_KOIOS_URL: dead }), { fetch: world.gateway.fetch, now: world.now, ledger: world.ledger, writeLog: () => undefined });
    try {
      const made = await sendTo(port, { method: 'POST', path: '/admin/tenants', headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }, body: { tenant: TENANT, organisations: { supplier: SUPPLIER_ORG, insurer: INSURER_ORG } } });
      expect(made.status).toBe(201);
      const sender = world.agent('sourcing');
      const delegation = world.delegate({ delegate: sender, actions: ['sourcing.award.write'], resources: [resourceOf(TENANT, 'sourcing')], remaining: 1 });
      const sent = rankingBody(TENANT, world.agent('desk-alfa').did, world.agent('desk-bravo').did);
      // The approval is on the fixture ledger. The service does not read that ledger for the approval: it reads the node of its settings, and nobody answers there.
      world.approve(sender, sent.ranking, sent.salt);
      const credential = await world.token(sender, delegation, resourceOf(TENANT, 'sourcing'));
      const headers = await world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${TENANT}${ROUTE}`);
      const reply = await sendTo(port, { method: 'POST', path: `/t/${TENANT}${ROUTE}`, headers, body: sent });
      refused(reply, 503, 'approval_unavailable');
      const state = await sendTo(port, { path: `/t/${TENANT}/state` });
      expect(state.json).toMatchObject({ sourcing: { rankings: [] } });
    } finally {
      await started.shutdown();
    }
  });

  it('refuses a start for which the wiring gives no check, with the text of NO_APPROVAL_CHECK, and the start opens no port', async () => {
    const port = await freePort();
    await expect(startService(serviceEnvironment(port), { wire: () => null, writeLog: () => undefined })).rejects.toThrow(NO_APPROVAL_CHECK);
    expect(await listening(port)).toBe(false);
  });

  it('starts when the wiring gives a check: the same settings listen', async () => {
    const port = await freePort();
    const started = await startService(serviceEnvironment(port), { wire: () => async () => ({ ok: true }), writeLog: () => undefined });
    try {
      expect(await listening(port)).toBe(true);
    } finally {
      await started.shutdown();
    }
    expect(await listening(port)).toBe(false);
  });
});
