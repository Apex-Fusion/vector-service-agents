// agents/sourcing-agent/test/serve/server.test.ts
// The server of the Sourcing Agent over HTTP: the token of the runtime on POST / and POST /precheck, the one job slot (a second job is busy, and a pre-check answers with the state of the slot), the intake of a
// request, `propose` and `execute` by their operation with the scripted ports and the fake gateway and record of their own tests, the result of each with the member `fault_mode` last, the refusals with their
// statuses, a caller that hangs up before the first Pay, and the open route POST /cosign/delegate: it takes no token, it signs only a Delegate that an allowlisted delegator signed first, and after a restart its
// register still holds the first body. Every refusal has an accepted twin. No test uses the network.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { OpenRoute } from '@vsa/service-kit';
import { parseRanking } from '@vsa/usecase-kit/bids';
import type { CosignRoute } from '@vsa/usecase-kit/cosign';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { makeProposal, refused } from '@vsa/usecase-kit/protocol';
import {
  AGENT_DID as KIT_AGENT_DID, DELEG_A, NOW, STRANGER, build, hostedToolTakes, plainRequestOf, requestOf, world as cosignWorld,
} from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { ExecuteRefusal } from '../../src/execute/index.ts';
import { ProposeRefusal, TENANT_RULE } from '../../src/propose/index.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { REQUEST_SCHEMA } from '../../src/serve/manifest.ts';
import { RequestRefusal, parseJob, refusalOf } from '../../src/serve/server.ts';
import { cosignSettingsOf } from '../../src/serve/settings.ts';
import { wire } from '../../src/serve/wiring.ts';
import { DELEGATION as EXECUTE_DELEGATION, READ_ONLY, UNTOUCHED, footprint, world as executeWorld } from '../execute/world.ts';
import { SALT, golden as executeGolden, rankingDocument } from '../execute/fixtures.ts';
import { ALFA, NOW as PROPOSE_NOW, RFQ, REQUEST as PROPOSE_REQUEST, TENANT, WEIGHTS, goldenQuotes, readGolden, thrownBy, world as proposeWorld } from '../propose/support.ts';
import { closeAll, closeServers, gate, hangingCall, post, serve, until } from './serve.ts';
import type { Answer, Json, Running } from './serve.ts';
import { PRINCIPAL, TOKEN, cleanDirs, completeEnv, secretsOf, tempDir, withModule1, wiringSettingsOf } from './support.ts';

afterEach(async () => {
  cleanDirs();
  await closeAll();
});

/** The route fits the open route of the kit: its handler is a handler that the server takes, and the compiler is the test. */
type Fits = CosignRoute['handle'] extends OpenRoute['handle'] ? true : false;
const FITS: Fits = true;

/** The six headers of the context that the runtime sends for the escrow `escrow` (a byte as two hex characters). */
const contextOf = (escrow: string): Record<string, string> => ({
  'x-vector-escrow-ref': `${escrow.repeat(32)}#0`, 'x-vector-advert-ref': `${'11'.repeat(32)}#0`, 'x-vector-advert-model': 'sourcing-agent-v1',
  'x-vector-buyer-pkh': PRINCIPAL.keyHash, 'x-vector-payment-lovelace': '3000000', 'x-vector-deliver-by-ms': String(Date.now() + 3_600_000),
});

/** The wire message that the runtime posts for a request. */
const wireOf = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);

describe('the surface of the server', () => {
  test('the route of the kit fits the open route of the service kit', () => {
    expect(FITS).toBe(true);
  });

  test('GET /agent.json answers the bytes it was given, GET /healthz answers ok, and every other path is 404', async () => {
    const text = '{"name":"Sourcing Agent","x":1}';
    const { origin } = await serve({ manifestText: text });
    const manifest = await fetch(`${origin}/agent.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(text);
    expect(await (await fetch(`${origin}/healthz`)).json()).toStrictEqual({ ok: true });
    expect((await fetch(`${origin}/other`)).status).toBe(404);
  });

  test('POST / needs the token of the runtime: a call with none, or with another, is 401 and runs nothing, and the right token is its twin', async () => {
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    for (const token of [null, 'Bearer wrong', TOKEN.toUpperCase(), `${TOKEN}x`, '']) {
      const answered = await post(origin, PROPOSE_REQUEST, token);
      expect(answered.status).toBe(401);
      expect(answered.body).toStrictEqual({ error: 'unauthorized' });
    }
    expect(w.trace).toStrictEqual([]);
    expect((await post(origin, PROPOSE_REQUEST)).status).toBe(200);
  });

  test('checks the token before it reads the body: a body that is no wire message is 401 with no token and 400 bad_wire with the token', async () => {
    const { origin } = await serve();
    const stranger = await fetch(`${origin}/`, { method: 'POST', body: 'this is not a wire message' });
    expect(stranger.status).toBe(401);
    const runtime = await fetch(`${origin}/`, { method: 'POST', body: 'this is not a wire message', headers: { authorization: TOKEN } });
    expect(runtime.status).toBe(400);
    expect(((await runtime.json()) as Json).error).toBe('bad_wire');
  });

  test('takes one job at a time: a second job while one runs is 409 busy, a stranger still gets 401 and never learns that a job runs, and the slot is free when the job ends', async () => {
    const w = proposeWorld();
    const held = gate();
    const discover = w.script.discover;
    w.script.discover = async () => { await held.pass(); return discover(); };
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const running = post(origin, PROPOSE_REQUEST);
    await until(() => held.reached());
    expect(await post(origin, PROPOSE_REQUEST, null)).toStrictEqual({ status: 401, body: { error: 'unauthorized' } });
    expect(await post(origin, PROPOSE_REQUEST)).toStrictEqual({ status: 409, body: { error: 'busy' } });
    expect(w.trace.filter((name) => name === 'discover')).toHaveLength(1);
    held.open();
    expect((await running).status).toBe(200);
    expect((await post(origin, PROPOSE_REQUEST)).status).toBe(200);
    expect(log.filter((line) => line.startsWith('propose done in '))).toHaveLength(2);
  });

  test('POST /precheck has no check of its own and answers with the state of the slot: a go when it is free, busy while a job runs, and a go again when the job has ended', async () => {
    const w = proposeWorld();
    const held = gate();
    const discover = w.script.discover;
    w.script.discover = async () => { await held.pass(); return discover(); };
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const precheck = async (escrow: string, token: string = TOKEN): Promise<Answer> => {
      const res = await fetch(`${origin}/precheck`, { method: 'POST', body: wireOf(PROPOSE_REQUEST), headers: { authorization: token, ...contextOf(escrow) } });
      return { status: res.status, body: (await res.json()) as Json };
    };
    // Free: the slot is reserved for the escrow, and a call for another escrow finds it held.
    expect(await precheck('aa')).toStrictEqual({ status: 200, body: { go: true, reserved_ms: 120_000 } });
    expect(await precheck('bb')).toMatchObject({ status: 409, body: { error: 'busy' } });
    expect(log.some((line) => line.includes('the slot is held for another escrow'))).toBe(true);
    // The job of the escrow that holds the reservation takes it, and the slot is busy for every escrow while the job runs.
    const running = post(origin, PROPOSE_REQUEST, TOKEN, undefined, contextOf('aa'));
    await until(() => held.reached());
    for (const escrow of ['aa', 'bb']) expect(await precheck(escrow), escrow).toMatchObject({ status: 409, body: { error: 'busy' } });
    expect(log.some((line) => line.includes('a job is running'))).toBe(true);
    held.open();
    expect((await running).status).toBe(200);
    // The job has ended: the slot is free again, for any escrow.
    expect(await precheck('bb')).toStrictEqual({ status: 200, body: { go: true, reserved_ms: 120_000 } });
    // The token is checked first, and the pre-check reads the body and the context as a job does.
    expect((await precheck('cc', 'Bearer wrong')).status).toBe(401);
    const noContext = await fetch(`${origin}/precheck`, { method: 'POST', body: wireOf(PROPOSE_REQUEST), headers: { authorization: TOKEN } });
    expect(noContext.status).toBe(400);
    expect(((await noContext.json()) as Json).error).toBe('bad_context');
    const noRequest = await fetch(`${origin}/precheck`, { method: 'POST', body: wireOf({ op: 'cancel' }), headers: { authorization: TOKEN, ...contextOf('dd') } });
    expect(noRequest.status).toBe(400);
    expect(((await noRequest.json()) as Json).error).toBe('bad_shape');
  });
});

describe('the intake', () => {
  const { op: _op, ...WITHOUT_OP } = PROPOSE_REQUEST;
  const { rfq: _rfq, ...WITHOUT_RFQ } = PROPOSE_REQUEST;
  const { weights: _weights, ...WITHOUT_WEIGHTS } = PROPOSE_REQUEST;

  test('refuses a request that breaks a rule with bad_shape (400) before any job runs, and a request of the intake is its twin', async () => {
    const { origin } = await serve();
    const wrong: [string, unknown][] = [
      ['an operation that does not exist', { ...PROPOSE_REQUEST, op: 'cancel' }],
      ['no operation', WITHOUT_OP],
      ['a member that is not listed', { ...PROPOSE_REQUEST, extra: 1 }],
      ['no request for quotation', WITHOUT_RFQ],
      ['no weights', WITHOUT_WEIGHTS],
      ['weights that are not the four of the schema', { ...PROPOSE_REQUEST, weights: { price: 1 } }],
      ['a SKU that only the NFC form makes valid', { ...PROPOSE_REQUEST, rfq: { ...RFQ, items: [{ sku: 'GLV-NIT-\u212A', quantity: 1 }] } }],
      ['an identifier of a wrong form', { ...PROPOSE_REQUEST, rfq: { ...RFQ, rfq_id: 'a b' } }],
      ['a date that does not exist', { ...PROPOSE_REQUEST, rfq: { ...RFQ, needed_by: '2026-02-30' } }],
      ['an execute with no approval member', { op: 'execute', authority: PROPOSE_REQUEST.authority, tenant: TENANT, proposal: { document: {}, salt: 'aa'.repeat(32), proposal_digest: 'bb'.repeat(32) } }],
    ];
    for (const [what, request] of wrong) {
      const answered = await post(origin, request);
      expect(answered.status, what).toBe(400);
      expect(answered.body.error, what).toBe('bad_shape');
    }
    const notJson = await post(origin, undefined, TOKEN, 'this is not json');
    expect(notJson).toMatchObject({ status: 400, body: { error: 'bad_shape' } });
    expect(parseJob(JSON.stringify(PROPOSE_REQUEST)).op).toBe('propose');
    expect(parseJob(JSON.stringify({ ...PROPOSE_REQUEST, weights: WEIGHTS })).op).toBe('propose');
  });

  test('names the member in the message of a refusal and never repeats the value that was sent', async () => {
    const { origin } = await serve();
    const marker = 'MARKER-0123456789';
    const answered = await post(origin, { ...PROPOSE_REQUEST, rfq: { ...RFQ, rfq_id: `a b ${marker}` } });
    expect(answered.status).toBe(400);
    expect(String(answered.body.message)).toContain('rfq_id');
    expect(JSON.stringify(answered.body)).not.toContain(marker);
  });

  test('refuses a request of more than 900,000 bytes with request_too_large (400) before it reads the text', async () => {
    const { origin } = await serve();
    expect(await post(origin, undefined, TOKEN, 'x'.repeat(900_001))).toMatchObject({ status: 400, body: { error: 'request_too_large' } });
  });

  test('the errors of the intake and of the two jobs are read as refusals with the status of their code, and any other error is no refusal', () => {
    expect(refusalOf(new RequestRefusal('bad_shape', 'x'))).toStrictEqual({ code: 'bad_shape', status: 400, message: 'x', kind: 'request' });
    expect(refusalOf(new RequestRefusal('request_too_large', 'x'))).toMatchObject({ code: 'request_too_large', status: 400, kind: 'request' });
    expect(refusalOf(new ProposeRefusal('delegation_not_mine', 'x'))).toStrictEqual({ code: 'delegation_not_mine', status: 400, message: 'x', kind: 'request' });
    expect(refusalOf(new ProposeRefusal('bad_shape', 'x'))).toMatchObject({ status: 400, kind: 'request' });
    expect(refusalOf(new ExecuteRefusal('delegation_not_mine', 'x'))).toMatchObject({ status: 400, kind: 'request' });
    expect(refusalOf(new ExecuteRefusal('bad_shape', 'x'))).toMatchObject({ status: 400, kind: 'request' });
    expect(refusalOf(new ExecuteRefusal('internal', 'x'))).toStrictEqual({ code: 'internal', status: 500, message: 'x', kind: 'job' });
    expect(refusalOf(new Error('boom'))).toBeNull();
    expect(refusalOf('boom')).toBeNull();
  });
});

describe('the tenant of the schema', () => {
  /** A tenant and whether the schema of the manifest takes it: 1 to 48 lower-case letters, digits and hyphens, the first a letter or a digit. */
  const TENANTS: Array<[string, boolean]> = [
    ['run1', true], ['a', true], ['0', true], ['run-1', true], ['9-lives', true], ['a'.repeat(48), true],
    ['', false], ['a'.repeat(49), false], ['Acme', false], ['run_1', false], ['run.1', false], ['-run', false], ['run 1', false], ['run/1', false], ['r\u00fcn', false],
  ];
  /** The tenants that the protocol takes and the schema does not: the intake refuses them with the words of the tenant rule. */
  const PROTOCOL_ONLY = ['a'.repeat(49), 'Acme', 'run_1', 'run.1'];
  const made = makeProposal(rankingDocument(), SALT);
  if (!made.ok) throw new Error(made.detail);
  const proposeOf = (tenant: string): unknown => ({ ...PROPOSE_REQUEST, tenant });
  const executeOf = (tenant: string): unknown => ({ op: 'execute', authority: PROPOSE_REQUEST.authority, tenant, proposal: made.value, approval: null });
  /** What the intake throws for a request, or null when it takes it. */
  const intakeOf = (request: unknown): unknown => {
    try {
      parseJob(JSON.stringify(request));
      return null;
    } catch (error) {
      return error;
    }
  };

  test('the published pattern, the intake and the two jobs agree for each tenant, and the protocol takes more', async () => {
    const pattern = new RegExp(REQUEST_SCHEMA.oneOf[0].properties.tenant.pattern);
    expect(new RegExp(REQUEST_SCHEMA.oneOf[1].properties.tenant.pattern).source).toBe(pattern.source);
    for (const [tenant, holds] of TENANTS) {
      expect(pattern.test(tenant), `the published pattern for ${JSON.stringify(tenant)}`).toBe(holds);
      for (const [op, request] of [['propose', proposeOf(tenant)], ['execute', executeOf(tenant)]] as const) {
        const refusal = intakeOf(request);
        if (holds) expect(refusal, `${op} ${JSON.stringify(tenant)}`).toBeNull();
        else expect(refusal, `${op} ${JSON.stringify(tenant)}`).toBeInstanceOf(RequestRefusal);
      }
      // The jobs hold the same rule: `propose` refuses a tenant outside the form before it does anything, and the kit takes a ranking only for a tenant inside it.
      const job = await thrownBy(proposeWorld().front({ request: { tenant } }));
      if (holds) expect(job, `the job for ${JSON.stringify(tenant)}`).toBeNull();
      else expect(job, `the job for ${JSON.stringify(tenant)}`).toBeInstanceOf(ProposeRefusal);
      expect(parseRanking(rankingDocument({ tenant })).ok, `the ranking for ${JSON.stringify(tenant)}`).toBe(holds);
    }
    for (const tenant of PROTOCOL_ONLY) {
      for (const request of [proposeOf(tenant), executeOf(tenant)]) expect(intakeOf(request)).toMatchObject({ code: 'bad_shape', status: 400, message: TENANT_RULE });
    }
  });

  test('refuses a tenant outside the schema with bad_shape (400) on POST / and on POST /precheck, for both operations, so that no escrow is claimed for it, and a tenant inside the schema is the twin on both routes', async () => {
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const precheck = async (request: unknown, escrow: string): Promise<Answer> => {
      const res = await fetch(`${origin}/precheck`, { method: 'POST', body: wireOf(request), headers: { authorization: TOKEN, ...contextOf(escrow) } });
      return { status: res.status, body: (await res.json()) as Json };
    };
    const refusal = { status: 400, body: { error: 'bad_shape', message: TENANT_RULE } };
    for (const tenant of ['Acme', 'a_b', 'a'.repeat(49)]) {
      for (const [op, request] of [['propose', proposeOf(tenant)], ['execute', executeOf(tenant)]] as const) {
        expect(await post(origin, request), `${op} ${tenant} on POST /`).toStrictEqual(refusal);
        expect(await precheck(request, 'aa'), `${op} ${tenant} on POST /precheck`).toStrictEqual(refusal);
      }
    }
    expect(w.trace).toStrictEqual([]);
    // The refused pre-checks reserved nothing: another escrow gets its go, and the tenant that the schema takes is the twin on both routes.
    expect(await precheck(proposeOf('acme'), 'bb')).toStrictEqual({ status: 200, body: { go: true, reserved_ms: 120_000 } });
    expect((await post(origin, proposeOf('acme'), TOKEN, undefined, contextOf('bb'))).status).toBe(200);
  });
});

describe('a job of propose', () => {
  test('runs through HTTP over the scripted ports: the golden ranking, the members of the kit, then the files and the records, and the member fault_mode last and empty', async () => {
    const w = proposeWorld();
    const { origin, log } = await serve({ proposeDeps: (arrivedAt) => { expect(arrivedAt).toBe(PROPOSE_NOW); return w.deps; }, clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'bid-evaluation', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(Object.keys(answered.body).slice(-3)).toStrictEqual(['bidders', 'quotes', 'fault_mode']);
    const { document, salt: _salt, proposal_digest: _digest, ...rest } = answered.body;
    expect(document).toStrictEqual(readGolden('ranking'));
    expect(rest).toStrictEqual(readGolden('proposal'));
    expect(log).toStrictEqual(['propose done in 0 ms: outcome proposed, reason none, exit none, decisions 8, bidders 3, quotes 3']);
  });

  test('puts the line of a job in the log with counts and codes and nothing of the request, the bidders, the quotes or the keys', async () => {
    const w = proposeWorld();
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(200);
    const text = log.join('\n').toLowerCase();
    const parts = [RFQ.rfq_id, ...RFQ.items.map((item) => item.sku), ALFA, 'alfa.example', PROPOSE_REQUEST.authority.delegation, PROPOSE_REQUEST.authority.principal_did, ...secretsOf()];
    for (const part of parts) expect(text, part).not.toContain(part.toLowerCase());
    expect(log.some((line) => w.logs.includes(line))).toBe(false);
  });

  test('stamps the fault value on a proposal when the start set it, and the one value of the agent is the only one that the switch takes', async () => {
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, fault: readFaultSwitch('sourcing-agent', 'invert_scores'), clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.body).toMatchObject({ outcome: 'proposed', fault_mode: 'invert_scores' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    expect(() => readFaultSwitch('sourcing-agent', 'alter_after_approval')).toThrow(/FAULT_MODE/);
  });

  test('a delegation that names another agent is refused with delegation_not_mine (400), nothing is read after the authority, and a delegation that names this agent is its twin', async () => {
    const w = proposeWorld();
    w.script.delegation = async () => ({ delegate: 'ee'.repeat(32), chain_whole: true });
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(400);
    expect(answered.body.error).toBe('delegation_not_mine');
    expect(w.trace).toStrictEqual(['delegation']);
    const twin = proposeWorld();
    expect((await post((await serve({ proposeDeps: () => twin.deps, clock: () => twin.clock.ms })).origin, PROPOSE_REQUEST)).status).toBe(200);
  });

  test('a read of the bidders that fails is a failed proposal with its code and the member fault_mode, and nothing is hired', async () => {
    const w = proposeWorld();
    w.script.discover = async () => refused('no_bidders', 'no bidder quotes');
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'no_bidders', document: null, fault_mode: '' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    expect(w.calls.shortlist).toHaveLength(0);
    expect(w.calls.quotes).toHaveLength(0);
    expect(log).toStrictEqual(['propose done in 0 ms: outcome failed, reason no_bidders, exit Failed, decisions 0, bidders 0, quotes 0']);
  });

  test('a caller that hangs up before the first Pay gets no Pay: the job reads the signal before the fan-out, and ends as failed with aborted, and a caller that stays is its twin', async () => {
    const w = proposeWorld();
    const held = gate();
    const discover = w.script.discover;
    w.script.discover = async () => { await held.pass(); return discover(); };
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const call = hangingCall(origin, PROPOSE_REQUEST);
    await until(() => held.reached());
    call.hangUp();
    await until(() => log.some((line) => line.startsWith('job abandoned by the caller')));
    held.open();
    await until(() => log.some((line) => line.startsWith('propose done in ')));
    expect(log.find((line) => line.startsWith('propose done in '))).toMatch(/: outcome failed, reason aborted, exit Failed, decisions 0, bidders \d+, quotes 0$/);
    expect(w.calls.shortlist).toHaveLength(0);
    expect(w.calls.quotes).toHaveLength(0);
    expect(w.trace).not.toContain('quotes');
    const twin = proposeWorld();
    await post((await serve({ proposeDeps: () => twin.deps, clock: () => twin.clock.ms })).origin, PROPOSE_REQUEST);
    expect(twin.calls.quotes).toHaveLength(1);
  });

  test('a caller that hangs up while the quotes are hired reaches the fan-out as an aborted signal, and what was paid for stays in the failed result', async () => {
    const w = proposeWorld();
    const held = gate();
    w.script.quotes = async (input) => { await held.pass(); return goldenQuotes(input); };
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.ms });
    const call = hangingCall(origin, PROPOSE_REQUEST);
    await until(() => held.reached());
    expect(w.calls.quotes[0]!.signal?.aborted).toBe(false);
    call.hangUp();
    await until(() => w.calls.quotes[0]!.signal?.aborted === true);
    held.open();
    await until(() => log.some((line) => line.startsWith('propose done in ')));
    expect(log.find((line) => line.startsWith('propose done in '))).toBe('propose done in 0 ms: outcome failed, reason aborted, exit Failed, decisions 4, bidders 3, quotes 3');
    expect(w.calls.scoring).toHaveLength(0);
  });
});

describe('a job of execute', () => {
  test('runs through HTTP: one token and one call to the sourcing record, and the golden result with the member fault_mode last and empty', async () => {
    const w = executeWorld();
    const { origin, log } = await serve({ executeDeps: (arrivedAt) => { expect(arrivedAt).toBe(w.arrived); return w.deps; }, clock: () => w.gateway.now() });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual(executeGolden('completed'));
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    expect(footprint(w)).toMatchObject({ tokens: 1, calls: 1 });
    expect(w.record.written).toHaveLength(1);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(/^execute done in \d+ ms: outcome completed, reason none, exit Completed, decisions 0$/);
  });

  test('gives the refusal of the sourcing record as the result of the job: a request with no approval is refused_by_system with the code of the record, and nothing is written', async () => {
    const w = executeWorld();
    const { origin } = await serve({ executeDeps: () => w.deps, clock: () => w.gateway.now() });
    const answered = await post(origin, w.request(undefined, null));
    expect(answered.status).toBe(200);
    expect(answered.body).toStrictEqual(executeGolden('refused-null-approval'));
    expect(w.record.written).toHaveLength(0);
  });

  test('stamps the fault value on the result of an execute too: the server stamps the setting of the start, and no job writes it', async () => {
    const w = executeWorld();
    const { origin } = await serve({ executeDeps: () => w.deps, fault: readFaultSwitch('sourcing-agent', 'invert_scores'), clock: () => w.gateway.now() });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ outcome: 'completed', fault_mode: 'invert_scores' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
  });

  test('a delegation that names another agent is refused with delegation_not_mine (400) before any token, and a delegation that names this agent is its twin', async () => {
    const w = executeWorld();
    w.reads.delegations.set(EXECUTE_DELEGATION, { delegate: 'ee'.repeat(32), chain_whole: true });
    const { origin } = await serve({ executeDeps: () => w.deps, clock: () => w.gateway.now() });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(400);
    expect(answered.body.error).toBe('delegation_not_mine');
    expect(footprint(w)).toStrictEqual(READ_ONLY);
    const twin = executeWorld();
    expect((await post((await serve({ executeDeps: () => twin.deps, clock: () => twin.gateway.now() })).origin, twin.request())).status).toBe(200);
  });

  test('a setting of the agent that is wrong is a fault of the service: 500 with fixed text for the buyer, and the whole message in the log', async () => {
    const w = executeWorld();
    const { origin, log } = await serve({ executeDeps: () => ({ ...w.deps, agent: { ...w.deps.agent, did: 'not a did' } }), clock: () => w.gateway.now() });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(500);
    expect(answered.body).toStrictEqual({ error: 'internal', message: "The service could not do this job (internal). The operator's log has the detail." });
    expect(log.some((line) => line.includes('agent.did'))).toBe(true);
    expect(footprint(w)).toStrictEqual(UNTOUCHED);
  });

  test('an error that no refusal reads is 500 internal with no message, and what it says reaches the log and never the answer', async () => {
    const w = executeWorld();
    const { origin, log } = await serve({ executeDeps: () => { throw new Error('the secret detail of a fault'); } });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(500);
    expect(answered.body).toStrictEqual({ error: 'internal' });
    expect(log.some((line) => line.includes('the secret detail of a fault'))).toBe(true);
  });

  test('a caller that hangs up before the token gets no write: the job reads the signal before it asks for the token, and ends as failed with aborted', async () => {
    const w = executeWorld();
    const held = gate();
    const { origin, log } = await serve({
      executeDeps: () => ({ ...w.deps, reads: { delegation: async (id) => { await held.pass(); return w.reads.delegation(id); }, liveVaults: (id, at) => w.reads.liveVaults(id, at) } }),
      clock: () => w.gateway.now(),
    });
    const call = hangingCall(origin, w.request());
    await until(() => held.reached());
    call.hangUp();
    await until(() => log.some((line) => line.startsWith('job abandoned by the caller')));
    held.open();
    await until(() => log.some((line) => line.startsWith('execute done in ')));
    expect(log.find((line) => line.startsWith('execute done in '))).toMatch(/: outcome failed, reason aborted, exit Failed, decisions 0$/);
    expect(footprint(w)).toStrictEqual(READ_ONLY);
    expect(w.record.written).toHaveLength(0);
  });
});

describe('the open route POST /cosign/delegate', () => {
  /**
   * A server whose route is the one that the wiring makes over the fixture world: the keys of the wiring sign, the register is a file of the state directory, and the clock is the clock of the fixture. The agent is
   * the agent of that world. Each call makes a new wiring and a new route over the folder, so a second call over the same folder is a restart.
   */
  async function cosignServer(dir: string, env: NodeJS.ProcessEnv = {}): Promise<Running> {
    const full = completeEnv({ SOURCING_STATE_DIR: dir, AGENT_DID: KIT_AGENT_DID, ...env });
    const m = marketplace();
    const wired = await wire(wiringSettingsOf(full), {
      fetchImpl: withModule1(m.fetchImpl), clock: { now: () => NOW, sleep: async () => undefined }, provider: cosignWorld(), tipSlot: async () => 0,
      createChain: async (options) => vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(options.privateKeyHex).pkh }) }),
    });
    return serve({ cosign: wired.cosignRoute(cosignSettingsOf(full)), proposeDeps: wired.proposeDeps, executeDeps: wired.executeDeps, clock: () => NOW });
  }

  const cosign = (origin: string, body: string, headers: Record<string, string> = {}): Promise<Answer> =>
    fetch(`${origin}/cosign/delegate`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }).then(async (res) => ({ status: res.status, body: (await res.json()) as Json }));

  test('refuses a Delegate that the delegator did not sign first with principal_not_allowed (403), and signs the Delegate that an allowlisted delegator signed, with the witness of the delegation key', async () => {
    const { origin } = await cosignServer(tempDir());
    const { hex } = await build();
    expect(await cosign(origin, plainRequestOf(hex))).toStrictEqual({ status: 403, body: { error: 'principal_not_allowed', message: expect.any(String) } });
    const signed = await cosign(origin, requestOf(hex));
    expect(signed.status).toBe(200);
    expect(Object.keys(signed.body)).toStrictEqual(['transaction']);
    expect(hostedToolTakes(hex, signed.body.transaction as string, DELEG_A.keyHash).ok).toBe(true);
  });

  test('asks no token: a call with no authorization header reaches the route, while POST / answers 401 to the same call', async () => {
    const { origin } = await cosignServer(tempDir());
    const { hex } = await build();
    expect((await cosign(origin, requestOf(hex))).status).toBe(200);
    expect((await fetch(`${origin}/`, { method: 'POST', body: '[]' })).status).toBe(401);
  });

  test('signs for a principal key on the allowlist and for no other: a delegator that is not on the list, and an empty list, are refused, and the listed delegator is the twin', async () => {
    const { hex } = await build();
    const strangers = await cosignServer(tempDir(), { COSIGN_ALLOWLIST: STRANGER.keyHash });
    expect(await cosign(strangers.origin, requestOf(hex))).toMatchObject({ status: 403, body: { error: 'principal_not_allowed' } });
    const nobody = await cosignServer(tempDir(), { COSIGN_ALLOWLIST: '' });
    expect(await cosign(nobody.origin, requestOf(hex))).toMatchObject({ status: 403, body: { error: 'principal_not_allowed' } });
    const listed = await cosignServer(tempDir(), { COSIGN_ALLOWLIST: `${STRANGER.keyHash}\n${PRINCIPAL.keyHash}` });
    expect((await cosign(listed.origin, requestOf(hex))).status).toBe(200);
  });

  test('refuses a second Delegate for a delegation key that signed another body with key_in_use (409), and keeps the register over a restart: a new route on the same register file refuses it too', async () => {
    const dir = tempDir();
    const first = await cosignServer(dir);
    const one = await build();
    expect((await cosign(first.origin, requestOf(one.hex))).status).toBe(200);
    const other = await build({ notAfter: NOW + 6 * 86_400_000 });
    expect(other.hex).not.toBe(one.hex);
    expect(await cosign(first.origin, requestOf(other.hex))).toMatchObject({ status: 409, body: { error: 'key_in_use' } });
    // The service stops and starts again: the server, the wiring and the register object are new, and the register file is the one thing that they share.
    await closeServers();
    const second = await cosignServer(dir);
    expect(await cosign(second.origin, requestOf(other.hex))).toMatchObject({ status: 409, body: { error: 'key_in_use' } });
    // The first body is held, not refused: it is signed again for the same body, and a restart changes nothing for it.
    expect((await cosign(second.origin, requestOf(one.hex))).status).toBe(200);
    // A new state directory has an empty register, so the body that the register refused is signed there.
    const fresh = await cosignServer(tempDir());
    expect((await cosign(fresh.origin, requestOf(other.hex))).status).toBe(200);
  });

  test('signs nothing when the register file is damaged: a register that cannot be read frees no key, and the same Delegate is signed when the register is whole', async () => {
    const { hex } = await build();
    const damaged = tempDir();
    writeFileSync(join(damaged, 'cosign-register.json'), 'this is not a register');
    const refusedAnswer = await cosign((await cosignServer(damaged)).origin, requestOf(hex));
    expect(refusedAnswer.status).not.toBe(200);
    expect(Object.keys(refusedAnswer.body)).not.toContain('transaction');
    expect((await cosign((await cosignServer(tempDir())).origin, requestOf(hex))).status).toBe(200);
  });

  test('answers a method that is not POST with the 404 not_found of the service, and no signature', async () => {
    const { origin } = await cosignServer(tempDir());
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const answered = await fetch(`${origin}/cosign/delegate`, { method });
      expect([method, answered.status], method).toStrictEqual([method, 404]);
      expect(await answered.json(), method).toStrictEqual({ error: 'not_found' });
    }
  });
});
