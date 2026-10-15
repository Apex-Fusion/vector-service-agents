import { describe, test, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { replayFetch } from '@vsa/vector-read';
import type { Fetch } from '@vsa/vector-read';
import { createServer, manifestFromEnv, envInt } from '../src/server.ts';
import { BLIND_SPOTS, buildReport } from '../src/report.ts';
import { TEST_ENV, TEST_CONTACT } from './support.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const ASSET = '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
const K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
// The recorded /capability answer is replayed; the host lookup is stubbed so no test depends on DNS.
const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
async function call(body: string, method = 'POST', path = '/') {
  const srv = createServer({ fetchImpl: replayFetch(fx.store), manifest: manifestFromEnv({ ...TEST_ENV, AGENT_DID: 'did:test' }), lookup });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: method === 'POST' ? body : undefined, headers: { 'content-type': 'application/json' } });
  const text = await res.text(); srv.close();
  return { status: res.status, json: JSON.parse(text) };
}
describe('http surface', () => {
  test('healthz and agent.json', async () => {
    expect((await call('', 'GET', '/healthz')).json).toEqual({ ok: true });
    expect((await call('', 'GET', '/agent.json')).json.capability_id).toBe('identity.history.report.v1');
  });
  test('wire envelope produces a 200 report', async () => {
    const r = await call(JSON.stringify([{ content: JSON.stringify({ subject: ASSET, include: ['identity'] }), role: 'user' }]));
    expect(r.status).toBe(200); expect(r.json.schema).toBe('vector.agent-history.report.v1');
  });
  test('missing subject is a 400, not a 500', async () => {
    const r = await call(JSON.stringify([{ content: '{}', role: 'user' }]));
    expect(r.status).toBe(400); expect(r.json.reason).toBe('bad_request');
  });
  test('an unknown subject is a 200 with no identity', async () => {
    const store = { ...fx.store, [`POST ${K}/asset_utxos ` + JSON.stringify({ _asset_list: [['be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01', '11'.repeat(32)]], _extended: true })]: { status: 200, body: '[]' }, [`POST ${K}/asset_txs ` + JSON.stringify({ _asset_policy: 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01', _asset_name: '11'.repeat(32), _history: true })]: { status: 200, body: '[]' } };
    const srv = createServer({ fetchImpl: replayFetch(store), manifest: manifestFromEnv(TEST_ENV), lookup });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify([{ content: JSON.stringify({ subject: '11'.repeat(32), include: ['identity'] }), role: 'user' }]) });
    const j = await res.json(); srv.close();
    expect(res.status).toBe(200); expect(j.identity.registered).toBeNull(); expect(j.blind_spots[0]).toMatch(/No registry record/);
  });
});

// One server for several requests; the cache lives as long as the server does.
type Reply = { status: number; json: any };
async function withServer<T>(opts: Parameters<typeof createServer>[0], fn: (post: (body: string) => Promise<Reply>, get: (path: string) => Promise<Reply>) => Promise<T>): Promise<T> {
  const srv: Server = createServer({ manifest: manifestFromEnv(TEST_ENV), lookup, ...opts });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const post = async (body: string) => { const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body }); return { status: res.status, json: await res.json() }; };
  const get = async (path: string) => { const res = await fetch(`http://127.0.0.1:${port}${path}`); return { status: res.status, json: await res.json() }; };
  try { return await fn(post, get); } finally { srv.close(); srv.closeAllConnections(); }
}
const wire = (include: string[], subject = ASSET) => JSON.stringify([{ content: JSON.stringify({ subject, include }), role: 'user' }]);
// The recorded store behind a call log.
function counting(gate?: Promise<void>) {
  const calls: string[] = [];
  const replay = replayFetch(fx.store);
  const f = (async (u: any, i?: RequestInit) => { calls.push(String(u)); if (gate) await gate; return replay(u, i); }) as Fetch;
  return { calls, f };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('wire checks over http', () => {
  const pad = (n: number) => { // a well-formed message of exactly n bytes whose subject is not a valid subject
    const frame = (s: string) => JSON.stringify([{ content: JSON.stringify({ subject: s }), role: 'user' }]);
    return frame('x'.repeat(n - Buffer.byteLength(frame(''))));
  };
  test('the size limit is 64 KiB in bytes: the limit passes the size check, one byte more does not', async () => {
    const atLimit = await call(pad(65_536));
    expect(atLimit.status).toBe(400); expect(atLimit.json.message).toMatch(/subject must be a DID/); // got past the size check
    const over = await call(pad(65_537));
    expect(over.status).toBe(400); expect(over.json.message).toMatch(/too large/);
  });
  test('a body that is small in characters but over the limit in bytes is refused', async () => {
    const wide = 'é'.repeat(33_000); // 33,000 characters, 66,000 bytes
    const r = await call(wide);
    expect(r.status).toBe(400); expect(r.json).toMatchObject({ reason: 'bad_request', message: expect.stringMatching(/too large/) });
  });
  test('a message whose role is not user is a 400', async () => {
    const r = await call(JSON.stringify([{ content: JSON.stringify({ subject: ASSET }), role: 'assistant' }]));
    expect(r.status).toBe(400); expect(r.json.message).toMatch(/role/);
  });
  test('a DID under another policy is a 400, not a 500', async () => {
    const r = await call(wire(['identity'], `did:vector:agent:${'11'.repeat(28)}:${ASSET}`));
    expect(r.status).toBe(400); expect(r.json.message).toBe('DID policy is not the Vector agent registry');
  });
  test('anything but GET /healthz, GET /agent.json and POST is a 404', async () => {
    expect(await call('', 'PUT')).toEqual({ status: 404, json: { reason: 'not_found' } });
    expect(await call('', 'GET', '/nope')).toEqual({ status: 404, json: { reason: 'not_found' } });
  });
});

describe('report cache', () => {
  test('an identical request within the TTL is answered from the cache with no upstream call', async () => {
    const { calls, f } = counting();
    await withServer({ fetchImpl: f }, async (post) => {
      const a = await post(wire(['identity', 'marketplace']));
      expect(a.status).toBe(200);
      const upstream = calls.length;
      expect(upstream).toBeGreaterThan(0);
      const b = await post(wire(['marketplace', 'identity', 'identity'])); // same sections, other order, one repeated
      expect(b).toEqual(a);
      expect(calls.length).toBe(upstream);
      const c = await post(wire(['identity'])); // another section list is another report
      expect(c.status).toBe(200);
      expect(calls.length).toBeGreaterThan(upstream);
    });
  });
  test('the cached report is kept for 60 s and rebuilt after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(1_000_000);
    const { calls, f } = counting();
    await withServer({ fetchImpl: f }, async (post) => {
      await post(wire(['identity']));
      const built = calls.length;
      vi.setSystemTime(1_000_000 + 59_999);
      await post(wire(['identity']));
      expect(calls.length).toBe(built);
      vi.setSystemTime(1_000_000 + 60_000);
      await post(wire(['identity']));
      expect(calls.length).toBe(built * 2);
    });
  });
  test('identical requests that overlap share one build', async () => {
    const single = counting(); // how many upstream calls one build makes
    await withServer({ fetchImpl: single.f }, (post) => post(wire(['identity'])));
    let release!: () => void;
    const { calls, f } = counting(new Promise<void>((r) => { release = r; }));
    await withServer({ fetchImpl: f }, async (post) => {
      const first = post(wire(['identity']));
      for (let i = 0; i < 100 && calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(calls.length).toBe(1); // the first build is under way, held at its first upstream call
      const second = post(wire(['identity']));
      await new Promise((r) => setTimeout(r, 150)); // time for the second request to arrive and, if it could, start its own build
      expect(calls.length).toBe(1);
      release();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b).toEqual(a);
      expect(calls.length).toBe(single.calls.length);
    });
  });
  test('a failed build is not cached: the next identical request builds again', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const replay = replayFetch(fx.store);
    let failFirst = true;
    const flaky = (async (u: any, i?: RequestInit) => { if (failFirst) { failFirst = false; throw new Error('Koios is down'); } return replay(u, i); }) as Fetch;
    await withServer({ fetchImpl: flaky }, async (post) => {
      const bad = await post(wire(['identity']));
      expect(bad.status).toBe(500); expect(bad.json).toEqual({ reason: 'internal', message: 'Koios is down' });
      const good = await post(wire(['identity']));
      expect(good.status).toBe(200);
    });
    expect(errors).toHaveBeenCalledTimes(1); // the 500 is logged, by message
  });
});

describe('http surface hardening', () => {
  test('POST is accepted on / only: any other path is a 404', async () => {
    for (const path of ['/healthz', '/agent.json', '/v1/job', '/x']) {
      expect(await call(wire(['identity']), 'POST', path), path).toEqual({ status: 404, json: { reason: 'not_found' } });
    }
  });
  test('a report that cannot be serialised is a 500 JSON body, logged by message only, and the server keeps answering', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unserialisable = (async () => ({ schema: 'vector.agent-history.report.v1', total: 10n })) as any; // JSON.stringify throws on a BigInt
    await withServer({ fetchImpl: replayFetch({}), buildReport: unserialisable }, async (post, get) => {
      const r = await post(wire(['identity']));
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ reason: 'internal', message: expect.stringMatching(/BigInt/) });
      expect(await get('/healthz')).toEqual({ status: 200, json: { ok: true } }); // the process is still alive
    });
    expect(errors).toHaveBeenCalledTimes(1);
    const logged = errors.mock.calls.flat().join(' ');
    expect(logged).toMatch(/BigInt/);
    expect(logged).not.toContain(ASSET); // the message only, never the request body
  });
  test('a failure after the headers went out destroys the response and sends nothing more', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const srv = createServer({ fetchImpl: replayFetch({}), manifest: manifestFromEnv(TEST_ENV) });
    const res: any = {
      headersSent: false,
      writeHead: vi.fn(() => { res.headersSent = true; throw new Error('socket closed'); }),
      end: vi.fn(), destroy: vi.fn(),
    };
    srv.emit('request', { method: 'GET', url: '/healthz' }, res);
    await new Promise((r) => setImmediate(r));
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.writeHead).toHaveBeenCalledTimes(1); // no second try to send a 500: that would throw out of the handler
    expect(res.end).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/socket closed/);
  });
});

describe('degraded reports are answered but not cached', () => {
  // The recorded store, with a switch that makes the matching URLs fail.
  function switchable(fails: (url: string) => boolean) {
    const replay = replayFetch(fx.store);
    const calls: string[] = [];
    const state = { down: false };
    const f = (async (u: any, i?: RequestInit) => { calls.push(String(u)); if (state.down && fails(String(u))) throw new Error('upstream is down'); return replay(u, i); }) as Fetch;
    return { f, calls, state };
  }
  test('a report with a failed section is built again by the next request; a complete one is then kept', async () => {
    const { f, calls, state } = switchable((u) => u.endsWith('/suppliers'));
    await withServer({ fetchImpl: f }, async (post) => {
      state.down = true;
      const bad = await post(wire(['identity', 'marketplace']));
      expect(bad.status).toBe(200);
      expect(bad.json.marketplace).toEqual({ error: 'upstream is down' });
      const afterBad = calls.length;
      state.down = false;
      const good = await post(wire(['identity', 'marketplace']));
      expect(calls.length).toBeGreaterThan(afterBad); // built again, not served from the cache
      expect(good.json.marketplace.as_supplier.escrows.total).toBeGreaterThan(3000);
      const afterGood = calls.length;
      expect(await post(wire(['identity', 'marketplace']))).toEqual(good); // complete, so this one is kept
      expect(calls.length).toBe(afterGood);
    });
  });
  test('a report without a chain tip is built again by the next request', async () => {
    const { f, calls, state } = switchable((u) => u.endsWith('/tip'));
    await withServer({ fetchImpl: f }, async (post) => {
      state.down = true;
      const noTip = await post(wire(['identity']));
      expect(noTip.status).toBe(200);
      expect(noTip.json.as_of).toBeNull();
      const afterNoTip = calls.length;
      state.down = false;
      const withTip = await post(wire(['identity']));
      expect(calls.length).toBeGreaterThan(afterNoTip);
      expect(withTip.json.as_of).not.toBeNull();
    });
  });
  test('a section that never answers is cut at the report budget: the job is answered, with that section as an error, and the report is not kept', async () => {
    const replay = replayFetch(fx.store);
    const calls: string[] = [];
    const stuck = (async (u: any, i?: RequestInit) => { calls.push(String(u)); return String(u).endsWith('/suppliers') ? new Promise<Response>(() => {}) : replay(u, i); }) as Fetch;
    const shortBudget = ((req, f, o) => buildReport(req, f, { ...o, budgetMs: 200 })) as typeof buildReport; // the real builder, with a budget a test can wait for
    await withServer({ fetchImpl: stuck, buildReport: shortBudget }, async (post) => {
      const first = await post(wire(['identity', 'marketplace']));
      expect(first.status).toBe(200);
      expect(first.json.marketplace).toEqual({ error: 'time budget exceeded' });
      expect(first.json.identity.registered.block).toBe(7275113);
      const afterFirst = calls.length;
      await post(wire(['identity', 'marketplace']));
      expect(calls.length).toBeGreaterThan(afterFirst); // built again, not served from the cache
    });
  });
});

describe('manifest', () => {
  test('GET /agent.json serves exactly the bytes JSON.stringify gives for the manifest', async () => {
    const manifest = manifestFromEnv({ ...TEST_ENV, AGENT_DID: 'did:test', SUPPLIER_PKH: 'ab'.repeat(28), SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32) });
    const srv: Server = createServer({ manifest, fetchImpl: replayFetch({}) });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const res = await fetch(`http://127.0.0.1:${(srv.address() as any).port}/agent.json`);
    const bytes = await res.text(); srv.close(); srv.closeAllConnections();
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(bytes).toBe(JSON.stringify(manifest));
    expect(JSON.parse(bytes).keys).toEqual({ supplier_pkh: 'ab'.repeat(28), pub_key_hex: 'cd'.repeat(32) });
  });
  test('agent.json.template is the manifest with placeholders for the four fields the operator supplies', () => {
    const template = JSON.parse(readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8'));
    expect(template).toEqual(manifestFromEnv({ OPERATOR_CONTACT: '<OPERATOR_CONTACT>', AGENT_DID: '<AGENT_DID>', SUPPLIER_PKH: '<SUPPLIER_PKH>', SUPPLIER_PUB_KEY_HEX: '<SUPPLIER_PUB_KEY_HEX>' }));
  });
  test('OPERATOR_CONTACT is required: unset, empty and blank stop the service at start, and the error names the variable', () => {
    for (const v of [undefined, '', ' ', '\t\n']) {
      expect(() => manifestFromEnv(v === undefined ? {} : { OPERATOR_CONTACT: v }), JSON.stringify(v)).toThrow(/OPERATOR_CONTACT/);
    }
    expect(manifestFromEnv(TEST_ENV).operator).toEqual({ name: 'Apex Fusion Foundation', contact: TEST_CONTACT });
    expect(manifestFromEnv({ OPERATOR_CONTACT: `  ${TEST_CONTACT}\n` }).operator.contact).toBe(TEST_CONTACT);
  });
  test('no address is built into the code: the manifest holds exactly the contact it was given', () => {
    // A default address would be published by every deployment that forgot to set the variable, and it is hashed into the advert.
    expect(JSON.stringify(manifestFromEnv({ OPERATOR_CONTACT: 'a role' }))).not.toMatch(/@/);
    expect(readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });
  test('createServer without a manifest reads the environment and refuses to start without OPERATOR_CONTACT', () => {
    vi.stubEnv('OPERATOR_CONTACT', '');
    expect(() => createServer()).toThrow(/OPERATOR_CONTACT/);
    vi.stubEnv('OPERATOR_CONTACT', TEST_CONTACT);
    createServer().close(); // building the server does not listen
  });
  test('the process exits at start with the variable named when OPERATOR_CONTACT is not set', () => {
    const cwd = fileURLToPath(new URL('..', import.meta.url));
    const run = (contact: string) => spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, OPERATOR_CONTACT: contact, PORT: '0', HOST: '127.0.0.1' } });
    const blank = run('');
    expect(blank.status).toBe(1);
    expect(blank.stderr).toMatch(/environment variable OPERATOR_CONTACT is required/);
    expect(blank.stdout).not.toMatch(/listening/);
  });
  test('defaults: deployed since 2026-10-15, one unit price and two bonds in lovelace, 300 s, the request limit of the wire check', () => {
    const m = manifestFromEnv(TEST_ENV);
    expect(m).toMatchObject({ capability_id: 'identity.history.report.v1', status: { chip: 'deployed', since: '2026-10-15' }, terms: { price_lovelace: 1_000_000, supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: 300_000, input_limits: { request_bytes: 65_536 } } });
  });
  test('numeric settings: absent or empty means the default, a number is used', () => {
    expect(manifestFromEnv({ ...TEST_ENV, ADVERT_PRICE_LOVELACE: '' }).terms.price_lovelace).toBe(1_000_000);
    expect(manifestFromEnv({ ...TEST_ENV, ADVERT_PRICE_LOVELACE: '2000000', ADVERT_MAX_PROCESSING_MS: '120000' }).terms).toMatchObject({ price_lovelace: 2_000_000, max_processing_ms: 120_000 });
    expect(manifestFromEnv({ ...TEST_ENV, ADVERT_PRICE_LOVELACE: '0' }).terms.price_lovelace).toBe(0);
  });
  test('numeric settings must be non-negative integers, and the error names the variable', () => {
    for (const bad of ['one', '-1', '1.5', '1e6', ' 5', '0x10', '99999999999999999999']) {
      expect(() => manifestFromEnv({ ...TEST_ENV, ADVERT_PRICE_LOVELACE: bad }), bad).toThrow(/ADVERT_PRICE_LOVELACE/);
    }
    expect(() => manifestFromEnv({ ...TEST_ENV, ADVERT_MAX_PROCESSING_MS: '-300000' })).toThrow(/ADVERT_MAX_PROCESSING_MS/);
    expect(() => envInt('PORT', 'ninety', 9091)).toThrow(/PORT/);
    expect(envInt('PORT', undefined, 9091)).toBe(9091);
    expect(envInt('PORT', '0', 9091)).toBe(0);
  });
  test('AGENT_STATUS_CHIP must be LIVE, DEPLOYED or PROPOSED in any case; the manifest carries it in lower case, and the default is deployed, never live', () => {
    expect(manifestFromEnv(TEST_ENV).status).toEqual({ chip: 'deployed', since: '2026-10-15' });
    expect(manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_CHIP: '' }).status.chip).toBe('deployed');
    expect(manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_SINCE: '2027-01-02' }).status).toEqual({ chip: 'deployed', since: '2027-01-02' });
    expect(manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_CHIP: 'Proposed' }).status.chip).toBe('proposed'); // a first run, before any job has settled, starts with this word (RUNBOOK step 4)
    expect(manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_CHIP: 'LIVE' }).status.chip).toBe('live');
    expect(manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_CHIP: 'Deployed' }).status.chip).toBe('deployed');
    for (const bad of ['launched', 'live!', 'prod', 'PROPOSED ']) {
      expect(() => manifestFromEnv({ ...TEST_ENV, AGENT_STATUS_CHIP: bad }), bad).toThrow(/AGENT_STATUS_CHIP/);
    }
  });
  test('the texts frozen into the advert hash: the gaps are the blind-spot sentences, the description does not claim the service signs, the subject agent endpoint is a named third party, the cache wording is exact', () => {
    const m = manifestFromEnv(TEST_ENV);
    expect(m.gaps).toHaveLength(3);
    expect(m.gaps[0]).toBe(BLIND_SPOTS[1]); // the same sentences in the manifest and in every report
    expect(m.gaps[1]).toBe(`${BLIND_SPOTS[2]} ${BLIND_SPOTS[3]}`);
    expect(m.gaps[2]).toBe(BLIND_SPOTS[5]); // the module sections show the ledger as it is now
    expect(m.gaps[2]).toMatch(/A withdrawn stake, a closed claim or a spent proposal no longer appears/);
    expect(m.gaps[1]).not.toMatch(/v15-sim/); // both Module-1 deployments are read, so there is no gap to state
    expect(m.gaps[1]).toMatch(/the asset name for a DID or asset name and the key hash for a key hash/);
    expect(m.gaps[1]).toMatch(/An entry that names an agent only by its controller key is not found for a DID or asset name/);
    expect(m.gaps[1]).toMatch(/Module-3 endorsements, are matched generically/);
    expect(m.description).toBe("The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Read-only; no model cost.");
    expect(m.gaps[0]).toMatch(/one per escrow UTxO version/);
    expect(m.gaps[0]).toMatch(/never as Accepted, Released or Reclaimed/);
    expect(m.gaps[0]).toMatch(/no outcome counts/);
    expect(m.gaps[0]).toMatch(/by_indexer_state/);
    expect(m.behaviour.third_parties).toEqual(['Koios (Vector mainnet indexer)', 'marketplace indexer', "the subject agent's own endpoint (one GET /capability, 64 KiB cap, 20 s budget)"]);
    expect(m.behaviour.data_handling).toBe('Reads public ledger data only; the request subject is held in memory, and a report is served from cache for at most 60 s (expired entries are purged lazily).');
  });
});
