// agents/reorder-agent/test/serve/server.test.ts
// The server of the Reorder Agent over HTTP: the token of the runtime on POST /, the intake of a request, `propose` and `execute` by their operation with the fake parts of their own tests, the result of each
// with the member `fault_mode` last, the refusals with their statuses, a caller that hangs up before the hire, and the open route POST /cosign/delegate: it takes no token, it signs only a Delegate that an
// allowlisted delegator signed first, and after a restart its register still holds the first body. Every refusal has an accepted twin. No test uses the network.
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { OpenRoute } from '@vsa/service-kit';
import type { CosignRoute } from '@vsa/usecase-kit/cosign';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { MAX_REQUEST_BYTES, refused } from '@vsa/usecase-kit/protocol';
import {
  AGENT_DID as KIT_AGENT_DID, DELEG_A, NOW, STRANGER, build, harness, hostedToolTakes, plainRequestOf, requestOf, world as cosignWorld,
} from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { keyOf } from '../../src/serve/keys.ts';
import { RequestError, createServer, parseJob, refusalOf } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { loadConfig } from '../../src/serve/start.ts';
import { wire } from '../../src/serve/wiring.ts';
import { ProposeRefusal } from '../../src/propose/index.ts';
import { ExecuteRefusal } from '../../src/execute/index.ts';
import { cleanWorlds, footprint, NOTHING, world as executeWorld } from '../execute/world.ts';
import { FakeClock, REQUEST as PROPOSE_REQUEST, expectEnded, world as proposeWorld } from '../propose/support.ts';
import { PRINCIPAL, TOKEN, cleanDirs, completeEnv, tempDir, withModule1 } from './support.ts';

afterEach(async () => {
  cleanWorlds();
  cleanDirs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
});

/** The route fits the open route of the kit: its handler is a handler that the server takes, and the compiler is the test. */
type Fits = CosignRoute['handle'] extends OpenRoute['handle'] ? true : false;
const FITS: Fits = true;

const servers: Server[] = [];

interface Running {
  readonly origin: string;
  readonly log: string[];
}

const noJob = (): never => { throw new Error('no job was expected'); };

/** A server of the agent on a free port, with the parts that a test gives and a route that has no use. */
async function serve(over: Partial<ServerOptions> = {}): Promise<Running> {
  const log: string[] = [];
  const server = createServer({
    manifestText: '{"name":"Reorder Agent"}', authHeader: TOKEN, fault: readFaultSwitch('reorder-agent', ''), cosign: harness().route, proposeDeps: noJob, executeDeps: noJob, clock: Date.now,
    log: (line) => { log.push(line); }, ...over,
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  servers.push(server);
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, log };
}

type Json = Record<string, unknown>;
interface Answer {
  readonly status: number;
  readonly body: Json;
}

/** One call to POST /: the wire message that the runtime posts, with the token unless a test gives another. */
async function post(origin: string, request: unknown, token: string | null = TOKEN, content: string = JSON.stringify(request)): Promise<Answer> {
  const res = await fetch(`${origin}/`, { method: 'POST', body: JSON.stringify([{ content, role: 'user' }]), headers: token === null ? {} : { authorization: token } });
  return { status: res.status, body: (await res.json()) as Json };
}

/** Polls until `condition` holds. A wait for a line of the log of a job, in real time and for seconds at most. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  for (const end = Date.now() + ms; !condition(); await new Promise<void>((resolve) => { setTimeout(resolve, 5); })) {
    if (Date.now() > end) throw new Error('the condition did not hold in time');
  }
}

/** Moves the fake clock of a job from sleep to sleep while `work` runs on real I/O: the clock moves only when something waits on it. */
async function drive<T>(clock: FakeClock, work: Promise<T>): Promise<T> {
  let done = false;
  work.then(() => { done = true; }, () => { done = true; });
  for (let step = 0; !done; step += 1) {
    if (step > 20_000) throw new Error('the job did not end');
    if (clock.waiting > 0) await clock.advance(1_000);
    else await new Promise<void>((resolve) => { setTimeout(resolve, 2); });
  }
  return work;
}

describe('the surface of the server', () => {
  test('the route of the kit fits the open route of the service kit', () => {
    expect(FITS).toBe(true);
  });

  test('GET /healthz answers ok, GET /agent.json answers the bytes it was given, and every other path is 404', async () => {
    const { origin } = await serve({ manifestText: '{"name":"Reorder Agent","x":1}' });
    expect(await (await fetch(`${origin}/healthz`)).json()).toStrictEqual({ ok: true });
    const manifest = await fetch(`${origin}/agent.json`);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe('{"name":"Reorder Agent","x":1}');
    expect((await fetch(`${origin}/other`)).status).toBe(404);
  });

  test('POST / needs the token of the runtime: a call with none, or with another, is 401 and runs nothing, and the right token is its twin', async () => {
    const w = await executeWorld();
    const { origin } = await serve({ executeDeps: () => w.deps, clock: () => w.m.clock.now });
    for (const token of [null, 'Bearer wrong', TOKEN.toUpperCase(), `${TOKEN}x`, '']) {
      const answered = await post(origin, w.request(), token);
      expect(answered.status).toBe(401);
      expect(answered.body).toStrictEqual({ error: 'unauthorized' });
    }
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect((await post(origin, w.request())).status).toBe(200);
  });

  test('POST /precheck takes the token, reserves the job slot for the escrow, and a second escrow finds it busy', async () => {
    const { origin } = await serve();
    const headers = (escrow: string): Record<string, string> => ({
      authorization: TOKEN, 'x-vector-escrow-ref': `${escrow.repeat(32)}#0`, 'x-vector-advert-ref': `${'11'.repeat(32)}#0`, 'x-vector-advert-model': 'reorder-agent-v1',
      'x-vector-buyer-pkh': keyOf(Buffer.alloc(32, 21).toString('hex')).pkh, 'x-vector-payment-lovelace': '5000000', 'x-vector-deliver-by-ms': String(Date.now() + 3_600_000),
    });
    const body = JSON.stringify([{ content: JSON.stringify(PROPOSE_REQUEST), role: 'user' }]);
    const atLimit = body + ' '.repeat(MAX_REQUEST_BYTES - Buffer.byteLength(body));
    const first = await fetch(`${origin}/precheck`, { method: 'POST', body: atLimit, headers: headers('aa') });
    expect(first.status).toBe(200);
    expect(await first.json()).toStrictEqual({ go: true, reserved_ms: 120_000 });
    for (const path of ['/', '/precheck']) {
      const over = await fetch(`${origin}${path}`, { method: 'POST', body: atLimit + ' ', headers: headers('aa') });
      expect(over.status, path).toBe(400);
      expect((await over.json() as Json).error, path).toBe('request_too_large');
    }
    const second = await fetch(`${origin}/precheck`, { method: 'POST', body, headers: headers('bb') });
    expect(second.status).toBe(409);
    expect(((await second.json()) as Json).error).toBe('busy');
    expect((await fetch(`${origin}/precheck`, { method: 'POST', body, headers: { ...headers('cc'), authorization: 'Bearer wrong' } })).status).toBe(401);
  });
});

describe('the intake', () => {
  const GOOD = { op: 'propose', authority: { principal_did: PROPOSE_REQUEST.authority.principal_did, delegation: PROPOSE_REQUEST.authority.delegation }, tenant: 'run1', sku: 'GLV-NIT-M', supplier_did: PROPOSE_REQUEST.supplier_did };

  test('refuses a request that breaks a rule with bad_shape (400) before any job runs, and a request of the intake is its twin', async () => {
    const { origin } = await serve();
    const wrong: [string, unknown][] = [
      ['an operation that does not exist', { ...GOOD, op: 'cancel' }],
      ['no operation', { authority: GOOD.authority, tenant: 'run1' }],
      ['a member that is not listed', { ...GOOD, extra: 1 }],
      ['no SKU', { op: 'propose', authority: GOOD.authority, tenant: 'run1', supplier_did: GOOD.supplier_did }],
      ['a SKU of a wrong form', { ...GOOD, sku: 'a b' }],
      ['a supplier that is no DID', { ...GOOD, supplier_did: 'nope' }],
      ['an execute with no approval member', { op: 'execute', authority: GOOD.authority, tenant: 'run1', proposal: { document: {}, salt: 'aa'.repeat(32), proposal_digest: 'bb'.repeat(32) } }],
    ];
    for (const [what, request] of wrong) {
      const answered = await post(origin, request);
      expect(answered.status, what).toBe(400);
      expect(answered.body.error, what).toBe('bad_shape');
    }
    const notJson = await post(origin, undefined, TOKEN, 'this is not json');
    expect(notJson).toMatchObject({ status: 400, body: { error: 'bad_shape' } });
    expect(parseJob(JSON.stringify(GOOD)).op).toBe('propose');
  });

  test('refuses a request of more than 900,000 bytes with request_too_large (400) before it reads the text, and a message that is no wire message with bad_wire', async () => {
    const { origin } = await serve();
    expect(await post(origin, undefined, TOKEN, 'x'.repeat(900_001))).toMatchObject({ status: 400, body: { error: 'request_too_large' } });
    const wire = await fetch(`${origin}/`, { method: 'POST', body: '{"not":"a list"}', headers: { authorization: TOKEN } });
    expect(wire.status).toBe(400);
    expect(((await wire.json()) as Json).error).toBe('bad_wire');
  });

  test('the errors of the intake and of the two jobs are read as refusals with the status of their code, and any other error is no refusal', () => {
    expect(refusalOf(new RequestError('bad_shape', 'x'))).toStrictEqual({ code: 'bad_shape', status: 400, message: 'x', kind: 'request' });
    expect(refusalOf(new RequestError('request_too_large', 'x'))).toMatchObject({ code: 'request_too_large', status: 400, kind: 'request' });
    expect(refusalOf(new ProposeRefusal('delegation_not_mine', 'x'))).toStrictEqual({ code: 'delegation_not_mine', status: 400, message: 'x', kind: 'request' });
    expect(refusalOf(new ExecuteRefusal('delegation_not_mine', 'x'))).toMatchObject({ status: 400, kind: 'request' });
    expect(refusalOf(new ExecuteRefusal('internal', 'x'))).toStrictEqual({ code: 'internal', status: 500, message: 'x', kind: 'job' });
    expect(refusalOf(new Error('boom'))).toBeNull();
    expect(refusalOf('boom')).toBeNull();
  });
});

describe('a job of execute', () => {
  test('runs through HTTP: the hire, the model, the order in the PO store, and a result with the member fault_mode last and empty', async () => {
    const w = await executeWorld();
    const { origin, log } = await serve({ executeDeps: (arrivedAt) => { expect(arrivedAt).toBeGreaterThan(0); return w.deps; }, clock: () => w.m.clock.now });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ schema: 'vector.usecase.result.v1', use_case: 'inventory-reorder', outcome: 'completed', reason: null, exit_state: 'Completed', fault_mode: '' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    expect(answered.body.writes).toStrictEqual([{ system: 'po-store', route: 'POST /po', status: 201, ref: 'PO-run1-0001' }]);
    expect(footprint(w)).toMatchObject({ paid: 1, poWrites: 1, challenges: 0 });
    expect(log.filter((line) => line.startsWith('execute done in '))).toHaveLength(1);
    expect(log.find((line) => line.startsWith('execute done in '))).toMatch(/: outcome completed, reason none, exit Completed, decisions 1$/);
  });

  test('a delegation that names another agent is refused with delegation_not_mine (400) before any Pay, and a delegation that names this agent is its twin', async () => {
    const w = await executeWorld();
    const { origin } = await serve({ executeDeps: () => ({ ...w.deps, reads: { delegation: async () => ({ delegate: 'ee'.repeat(32), chain_whole: true }), liveVaults: (id, at) => w.reads.liveVaults(id, at) } }), clock: () => w.m.clock.now });
    const refusedAnswer = await post(origin, w.request());
    expect(refusedAnswer.status).toBe(400);
    expect(refusedAnswer.body.error).toBe('delegation_not_mine');
    expect(footprint(w)).toStrictEqual(NOTHING);
    const second = await serve({ executeDeps: () => w.deps, clock: () => w.m.clock.now });
    expect((await post(second.origin, w.request())).status).toBe(200);
  });

  test('a setting of the agent that is wrong is a fault of the service: 500 with fixed text for the buyer, and the whole message in the log', async () => {
    const w = await executeWorld();
    const { origin, log } = await serve({ executeDeps: () => ({ ...w.deps, limits: { maxPriceLovelace: 5, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null } as never }), clock: () => w.m.clock.now });
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(500);
    expect(answered.body).toStrictEqual({ error: 'internal', message: "The service could not do this job (internal). The operator's log has the detail." });
    expect(log.some((line) => line.includes('maxPriceLovelace'))).toBe(true);
    expect(footprint(w)).toStrictEqual(NOTHING);
  });

  test('an error that no refusal reads is 500 internal with fixed text, and what it says reaches the log and never the answer', async () => {
    const { origin, log } = await serve({ executeDeps: () => { throw new Error('the secret detail of a fault'); } });
    const w = await executeWorld();
    const answered = await post(origin, w.request());
    expect(answered.status).toBe(500);
    expect(JSON.stringify(answered.body)).not.toContain('secret detail');
    expect(answered.body.error).toBe('internal');
    expect(log.some((line) => line.includes('the secret detail of a fault'))).toBe(true);
  });

  test('a caller that hangs up before the hire gets no Pay: the job reads the signal one time, before the hire, and ends as failed with aborted', async () => {
    const w = await executeWorld();
    const entered = { done: false };
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { origin, log } = await serve({
      executeDeps: () => ({ ...w.deps, reads: { delegation: async (id) => { entered.done = true; await gate; return w.reads.delegation(id); }, liveVaults: (id, at) => w.reads.liveVaults(id, at) } }),
      clock: () => w.m.clock.now,
    });
    const url = new URL(origin);
    const call = httpRequest({ host: url.hostname, port: url.port, method: 'POST', path: '/', headers: { authorization: TOKEN } });
    call.on('error', () => undefined);
    call.end(JSON.stringify([{ content: JSON.stringify(w.request()), role: 'user' }]));
    await until(() => entered.done);
    call.destroy();
    await until(() => log.some((line) => line.startsWith('job abandoned by the caller')));
    release();
    await until(() => log.some((line) => line.startsWith('execute done in ')));
    expect(log.find((line) => line.startsWith('execute done in '))).toMatch(/: outcome failed, reason aborted, exit Failed, decisions 0$/);
    expect(footprint(w)).toStrictEqual(NOTHING);
    expect(w.m.chain.vaults().filter((vault) => vault.consumed)).toHaveLength(0);
  });
});

describe('a job of propose', () => {
  test('runs through HTTP over the sub-delegation of the kit: the stock, the supplier, the model and the order, and a proposal with the member fault_mode last and empty', async () => {
    const w = proposeWorld();
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.now() });
    const answered = await drive(w.clock, post(origin, PROPOSE_REQUEST));
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(answered.body.document).toMatchObject({ schema: 'vector.usecase.po.v1', po_number: 'run1-1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, tenant: 'run1' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    await expectEnded(w);
  });

  test('a delegation that names another agent is refused with delegation_not_mine (400), and no sub-delegation is made', async () => {
    const w = proposeWorld();
    w.script.delegation = async () => ({ delegate: 'ee'.repeat(32), chain_whole: true });
    const { origin } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.now() });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(400);
    expect(answered.body.error).toBe('delegation_not_mine');
    expect(w.chain.log).toStrictEqual([]);
  });

  test('a supplier that is not listed is a failed proposal with its code, with the member fault_mode, and nothing is read from the chain', async () => {
    const w = proposeWorld();
    w.script.readSupplier = async () => refused('supplier_not_listed', 'no advert');
    const { origin, log } = await serve({ proposeDeps: () => w.deps, clock: () => w.clock.now() });
    const answered = await post(origin, PROPOSE_REQUEST);
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({ outcome: 'failed', exit_state: 'Failed', reason: 'supplier_not_listed', document: null, fault_mode: '' });
    expect(Object.keys(answered.body).at(-1)).toBe('fault_mode');
    expect(w.chain.log).toStrictEqual([]);
    expect(log.find((line) => line.startsWith('propose done in '))).toMatch(/: outcome failed, reason supplier_not_listed, exit Failed, decisions 0$/);
  });
});

describe('the open route POST /cosign/delegate', () => {
  /** A server whose route is the one that the wiring makes over the fixture world: the keys of the wiring sign, the register is a file of the state directory, and the clock is the clock of the fixture. */
  async function cosignServer(dir: string, env: NodeJS.ProcessEnv = {}): Promise<Running> {
    const config = loadConfig(completeEnv({ REORDER_STATE_DIR: dir, AGENT_DID: KIT_AGENT_DID, ...env }));
    const m = marketplace();
    const wired = await wire(config, {
      fetchImpl: withModule1(m.fetchImpl), clock: { now: () => NOW, sleep: async () => undefined }, provider: cosignWorld(),
      createChain: async (options) => vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(options.privateKeyHex).pkh }) }),
    });
    return serve({ cosign: wired.cosignRoute(config.cosign), proposeDeps: wired.proposeDeps, executeDeps: wired.executeDeps, clock: () => NOW });
  }

  const cosign = (origin: string, body: string, headers: Record<string, string> = {}) =>
    fetch(`${origin}/cosign/delegate`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }).then(async (res) => ({ status: res.status, body: (await res.json()) as Json }));

  test('refuses a Delegate that the delegator did not sign first with principal_not_allowed (403), and signs the Delegate that an allowlisted delegator signed, with the witness of the delegation key', async () => {
    const { origin } = await cosignServer(tempDir());
    const { hex } = await build();
    expect(await cosign(origin, plainRequestOf(hex))).toStrictEqual({ status: 403, body: { error: 'principal_not_allowed', message: expect.any(String) } });
    const signed = await cosign(origin, requestOf(hex));
    expect(signed.status).toBe(200);
    expect(Object.keys(signed.body)).toStrictEqual(['transaction']);
    const answer = hostedToolTakes(hex, signed.body.transaction as string, DELEG_A.keyHash);
    expect(answer.ok).toBe(true);
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

  test('keeps the register over a restart: after a new wiring and a new server on the same state directory, a second Delegate for the same delegation key is key_in_use (409)', async () => {
    const dir = tempDir();
    const first = await cosignServer(dir);
    const one = await build();
    expect((await cosign(first.origin, requestOf(one.hex))).status).toBe(200);
    // The service stops and starts again: the server and the wiring are new, and the register file is the one thing that they share.
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); })));
    const second = await cosignServer(dir);
    const other = await build({ notAfter: NOW + 6 * 86_400_000 });
    expect(other.hex).not.toBe(one.hex);
    expect(await cosign(second.origin, requestOf(other.hex))).toMatchObject({ status: 409, body: { error: 'key_in_use' } });
    // The first body is held, not refused: it is signed again for the same body, and a restart changes nothing for it.
    expect((await cosign(second.origin, requestOf(one.hex))).status).toBe(200);
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
