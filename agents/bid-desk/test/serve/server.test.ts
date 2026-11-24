// agents/bid-desk/test/serve/server.test.ts
// The service over HTTP, on a real port, with the stub gateway, the ledger fixtures and the stub marketplace with a FakeChain (test/serve/world.ts), for each of the three Bid Desks. The hook gives a go or the
// status and the code of the check, and a go keeps the record of the checks for the job. The job gives the quote only for the body that the hook checked: with no record, or with the record of another body, it
// writes nothing. The price list is served as the bytes that the manifest hashes. Nothing here uses the network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { createGatewayClient } from '@vsa/id-kit/client';
import { QUOTE_CHECKS, parseQuote } from '@vsa/usecase-kit/bids';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { isPlainObject } from '@vsa/usecase-kit/protocol';
import { FileRfqBook } from '../../src/checks/index.ts';
import { createServer } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { INSTANCES, INSTANCE_NAMES } from '../../src/serve/settings.ts';
import { serve, until } from './serve.ts';
import { PRICE_LIST_SHA256, SERVICE, TOKEN, priceListUrl } from './support.ts';
import { DESK_DID, PLAIN_ESCROW_REF, T, answerOf, cleanDirs, headersOf, makeWorld, wire } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanDirs(); });

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const FIXED = "The service could not do this job (precheck_missing). The operator's log has the detail.";
const BOOK = (world: World): string => join(world.stateDir, 'rfq-book.json');
/** The paths that the stub gateway was asked for the credential of a desk. */
const credentialAsks = (world: World): string[] => world.gateway.requests.map((request) => request.path).filter((path) => path.endsWith('/credential'));
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

describe.each(INSTANCES)('the Bid Desk %s: POST /precheck, the hook', (instance) => {
  test('a request that passes the 7 checks gets a go and the reservation of the job slot for its escrow', async () => {
    const world = makeWorld({ instance });
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json]).toStrictEqual([200, { go: true, reserved_ms: 120_000 }]);
      expect(world.logs.some((line) => line.startsWith(`pre-check go for ${world.context.escrowRef}`))).toBe(true);
      // The slot is held for this escrow: another escrow is busy until the job of this one has run.
      const other = await api.precheck(undefined, { ...world.context, escrowRef: `${'aa'.repeat(32)}#0` });
      expect([other.status, other.json?.error]).toStrictEqual([409, 'busy']);
    });
  });

  test('a request of a suspended sender is a 403 with the code of its check, and the same request of an active sender gets a go', async () => {
    const world = makeWorld({ instance });
    world.gateway.setStatus(world.sender, 'suspended');
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([403, 'sender_not_active']);
      expect(typeof reply.json?.message).toBe('string');
    });
    await serve(makeWorld({ instance }), async (api) => { expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: 120_000 }); });
  });

  test('a request for the same identifier of the same sender after a quote is a 403 duplicate_rfq', async () => {
    const world = makeWorld({ instance });
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      const again = await api.precheck();
      expect([again.status, again.json?.error]).toStrictEqual([403, 'duplicate_rfq']);
    });
  });
});

describe('POST /precheck: each check of the hook', () => {
  /** A request with one defect: the world that it is made in, and what is done before the service starts. */
  type Defect = readonly [code: string, make: () => { world: World; before?: (world: World) => Promise<void> }];
  const DEFECTS: readonly Defect[] = [
    ['sender_not_active', () => { const world = makeWorld(); world.gateway.setStatus(world.sender, 'suspended'); return { world }; }],
    ['sender_key_mismatch', () => { const world = makeWorld(); return { world: { ...world, context: { ...world.context, buyerPkh: 'ab'.repeat(28) } } }; }],
    ['not_vault_paid', () => { const world = makeWorld(); return { world: { ...world, context: { ...world.context, escrowRef: PLAIN_ESCROW_REF } } }; }],
    ['duplicate_rfq', () => ({ world: makeWorld(), before: (world) => new FileRfqBook(BOOK(world)).record(world.sender.did, 'run1-rfq-1', 'ab'.repeat(32)) })],
  ];

  test.each(DEFECTS)('%s is a 403 with its code, keeps no record for the job, and the same request with no defect gets a go', async (code, make) => {
    const { world, before } = make();
    // A book that holds a request must hold it before the service starts: the file is read at each call.
    if (before !== undefined) await before(world);
    await serve(world, async (api) => {
      const reply = await api.precheck(world.message, world.context);
      expect([reply.status, reply.json?.error]).toStrictEqual([403, code]);
      expect(typeof reply.json?.message).toBe('string');
      // No record of passed checks: the job for the same escrow and body is refused as one that the hook did not check.
      const job = await api.job(world.message, world.context);
      expect([job.status, job.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.m.llm.sends).toStrictEqual([]);
      expect(credentialAsks(world)).toStrictEqual([]);
    });
    await serve(makeWorld(), async (api) => { expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: 120_000 }); });
  });

  test('a source that cannot be read is 503 check_unavailable, never a go and never the code of a rule, and the answer shows nothing of the cause', async () => {
    const world = makeWorld();
    world.gateway.fault(`/1.0/identifiers/${world.sender.did}`, 'network');
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([503, 'check_unavailable']);
      expect(reply.text).not.toContain('did:vector');
      expect(world.m.llm.sends).toStrictEqual([]);
    });
  });

  test('a request that is no message of use case 3 is 400 bad_shape on both routes, and the same message with a request for quotation is taken', async () => {
    const world = makeWorld();
    const other = { ...world.message, schema: 'vector.usecase.handoff.v1' };
    const noRequest = { schema: world.message.schema, sender_did: world.message.sender_did, delegation: world.message.delegation };
    const noItems = { ...world.message, rfq: { ...world.message.rfq, items: [] } };
    const twice = { ...world.message, rfq: { ...world.message.rfq, items: [{ sku: 'GLV-NIT-M', quantity: 1 }, { sku: 'GLV-NIT-M', quantity: 2 }] } };
    await serve(world, async (api) => {
      for (const body of [other, noRequest, noItems, twice, 'not json', { schema: world.message.schema }]) {
        for (const reply of [await api.precheck(body), await api.job(body)]) {
          expect([reply.status, reply.json?.error], JSON.stringify(body).slice(0, 40)).toStrictEqual([400, 'bad_shape']);
          expect(reply.json?.message).not.toContain(world.sender.did);
        }
      }
      expect((await api.precheck(world.message)).status).toBe(200);
    });
  });

  test('an identifier or a SKU with the Kelvin sign is 400 bad_shape on both routes, and the same request with the letter K is taken', async () => {
    const world = makeWorld();
    const kelvinId = { ...world.message, rfq: { ...world.message.rfq, rfq_id: '\u212aRFQ' } };
    const kelvinSku = { ...world.message, rfq: { ...world.message.rfq, items: [{ sku: '\u212a-GLOVE', quantity: 10 }] } };
    const letterId = { ...world.message, rfq: { ...world.message.rfq, rfq_id: 'KRFQ' } };
    await serve(world, async (api) => {
      for (const body of [kelvinId, kelvinSku]) {
        for (const reply of [await api.precheck(body), await api.job(body)]) {
          expect([reply.status, reply.json?.error], JSON.stringify(body).slice(0, 60)).toStrictEqual([400, 'bad_shape']);
          expect(reply.text).not.toContain('\u212a');
        }
      }
      expect((await api.precheck(letterId)).status).toBe(200);
    });
  });

  test('a call that has not the six headers of the context is 400 bad_context, and a call that has all six is answered', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      for (const name of Object.keys(headersOf(world.context))) {
        const reply = await api.precheck(world.message, world.context, { [name]: null });
        expect([reply.status, reply.json?.error], name).toStrictEqual([400, 'bad_context']);
      }
      expect((await api.precheck()).status).toBe(200);
    });
  });

  test('a call with no token, or with another token, is 401 on both routes, before the body is read', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      for (const authorization of [null, 'Bearer nothing', TOKEN.toUpperCase()]) {
        for (const path of ['/precheck', '/']) {
          const reply = await api.request('POST', path, { body: 'this body is not read', headers: { ...headersOf(world.context), authorization } });
          expect([reply.status, reply.json], `${path} ${String(authorization)}`).toStrictEqual([401, { error: 'unauthorized' }]);
        }
      }
      expect(world.m.llm.sends).toStrictEqual([]);
      expect(world.gateway.requests).toStrictEqual([]);
    });
  });
});

describe.each(INSTANCES)('the Bid Desk %s: POST /, the job', (instance) => {
  test('after a go it gives the quote of the instance, priced by the model from the list, and it books the request', async () => {
    const world = makeWorld({ instance });
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      const quote = parseQuote(reply.json);
      expect(quote.ok, reply.text).toBe(true);
      if (!quote.ok) return;
      const value = quote.value;
      expect([value.outcome, value.rfq_id, value.desk_did, value.organisation, value.price_list_sha256, value.fault_mode]).toStrictEqual(
        ['done', 'run1-rfq-1', DESK_DID, `${instance}.example.test`, PRICE_LIST_SHA256[instance], ''],
      );
      expect(value.sender).toStrictEqual({ did: world.sender.did, organisation: 'buyer.example', organisation_verified: true });
      expect(Object.keys(value.checks)).toStrictEqual([...QUOTE_CHECKS]);
      expect(value.decisions.map((decision) => decision.name)).toStrictEqual(['quote']);
      expect(value.lines.map((line) => line.sku)).toStrictEqual(['GLV-NIT-M', 'SYR-10ML', 'MSK-N95']);
      expect(value.credential).toMatch(COMPACT_JWS);
      // One credential asked for the DID of the desk, one model hire from the marketplace, and the request in the book on the state volume.
      expect(credentialAsks(world)).toStrictEqual([`/agents/${DESK_DID.slice('did:vector:'.length)}/credential`]);
      expect(world.m.llm.sends).toHaveLength(1);
      const book = readFileSync(BOOK(world), 'utf8');
      expect([book.includes(world.sender.did), book.includes('run1-rfq-1')]).toStrictEqual([true, true]);
    });
  });
});

describe('POST /: the job and the record of the hook', () => {
  test('the quote of the first instance holds the prices of its list: the lines, the total and the longest lead time', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      const lines = (reply.json?.lines as Array<Record<string, unknown>>).map((line) => [line.sku, line.quantity, line.unit_price, line.lead_time_days]);
      expect(lines).toStrictEqual([['GLV-NIT-M', 100, 125, 14], ['SYR-10ML', 250, 28, 10], ['MSK-N95', 40, 60, 21]]);
      expect([reply.json?.total, reply.json?.lead_time_days]).toStrictEqual([21_900, 21]);
    });
  });

  test('with no record of passed checks it fails closed: 500 precheck_missing with the fixed text, and nothing is asked of the gateway, paid to a model or written to the book', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const reply = await api.job();
      expect([reply.status, reply.json]).toStrictEqual([500, { error: 'precheck_missing', message: FIXED }]);
      expect(credentialAsks(world)).toStrictEqual([]);
      expect(world.gateway.requests).toStrictEqual([]);
      expect(world.m.llm.sends).toStrictEqual([]);
      expect(readFileSync(BOOK(world), 'utf8')).not.toContain('run1-rfq-1');
      expect(world.logs.some((line) => line.includes('precheck_missing') && line.includes(world.context.escrowRef))).toBe(true);
    });
  });

  test('after a go for another body it fails closed too, and the same body passes: the record is for the body that the hook checked', async () => {
    const world = makeWorld();
    const another = { ...world.message, rfq: { ...world.message.rfq, needed_by: '2026-12-21' } };
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job(another);
      expect([reply.status, reply.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(credentialAsks(world)).toStrictEqual([]);
      expect(world.m.llm.sends).toStrictEqual([]);
      expect(readFileSync(BOOK(world), 'utf8')).not.toContain('run1-rfq-1');
    });
    const twin = makeWorld();
    await serve(twin, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      expect(readFileSync(BOOK(twin), 'utf8')).toContain('run1-rfq-1');
    });
  });

  test('the record serves one job: a second job for the same escrow and body finds none', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      const second = await api.job();
      expect([second.status, second.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.m.llm.sends).toHaveLength(1);
    });
  });

  test('a call with no context is 400 bad_context, and a call with part of it is refused by the kit with the same code', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const none = await api.request('POST', '/', { body: wire(world.message) });
      expect([none.status, none.json?.error]).toStrictEqual([400, 'bad_context']);
      const part = await api.request('POST', '/', { body: wire(world.message), headers: { 'x-vector-escrow-ref': world.context.escrowRef } });
      expect([part.status, part.json?.error]).toStrictEqual([400, 'bad_context']);
      expect(world.m.llm.sends).toStrictEqual([]);
      // The same job with its whole context is taken after a go.
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
    });
  });

  test('a model that prices a quantity that the request does not hold gives 502 model_output_invalid and books nothing, and the model supplier is paid for its answer', async () => {
    const world = makeWorld();
    const wrong = { ...world.message.rfq, items: [{ sku: 'GLV-NIT-M', quantity: 99 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }] };
    world.m.llm.answer = answerOf(world.config.priceList.list, wrong);
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect([reply.status, reply.json?.error]).toStrictEqual([502, 'model_output_invalid']);
      expect(world.m.llm.sends).toHaveLength(1);
      expect(credentialAsks(world)).toStrictEqual([]);
      expect(readFileSync(BOOK(world), 'utf8')).not.toContain('run1-rfq-1');
    });
  });

  test('a gateway that gives no credential is 502 credential_failed, books nothing, and leaves the request free for the next hook', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      world.gateway.fault(`/agents/${DESK_DID.slice('did:vector:'.length)}/credential`, 'network');
      const reply = await api.job();
      expect([reply.status, reply.json?.error]).toStrictEqual([502, 'credential_failed']);
      expect(readFileSync(BOOK(world), 'utf8')).not.toContain('run1-rfq-1');
      world.gateway.fault(`/agents/${DESK_DID.slice('did:vector:'.length)}/credential`, null);
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
    });
  });

  test('the fault switch changes the price of the first line and nothing a check does, and every result names the setting', async () => {
    const clean = makeWorld();
    await serve(clean, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      const first = (reply.json?.lines as Array<Record<string, unknown>>)[0];
      expect([first?.unit_price, reply.json?.total, reply.json?.fault_mode]).toStrictEqual([125, 21_900, '']);
    });
    const fault = makeWorld({ fault: 'quote_off_price_list' });
    await serve(fault, async (api) => {
      // The hook is the hook of a clean run: the request that the checks refuse in a clean run is refused here too.
      const refused = makeWorld({ fault: 'quote_off_price_list' });
      refused.gateway.setStatus(refused.sender, 'suspended');
      await serve(refused, async (other) => { expect((await other.precheck()).json?.error).toBe('sender_not_active'); });
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      const lines = reply.json?.lines as Array<Record<string, unknown>>;
      // The listed price is 125: the fault takes 25 off the first line, and the totals are made again from the changed line. The two other lines are the lines of the model.
      expect(lines.map((line) => line.unit_price)).toStrictEqual([100, 28, 60]);
      expect([reply.json?.total, reply.json?.fault_mode]).toStrictEqual([19_400, 'quote_off_price_list']);
    });
  });

  test('a caller that hangs up before the quote is booked gets no booking: the job sees it after the model hire and stops', async () => {
    const world = makeWorld();
    const hold = world.holdModel();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const controller = new AbortController();
      const pending = api.job(undefined, undefined, {}, controller.signal).then(() => 'answered', () => 'hung up');
      await hold.reached;
      controller.abort();
      await until(() => world.logs.some((line) => line.startsWith('job abandoned by the caller')), 'the server has seen the hang-up');
      hold.release();
      expect(await pending).toBe('hung up');
      await until(() => world.logs.some((line) => line.includes('the caller hung up, so the job stops before the record in the book')), 'the job has stopped');
      expect(readFileSync(BOOK(world), 'utf8')).not.toContain('run1-rfq-1');
      // The model was hired and paid: that part of the job had begun.
      expect(world.m.llm.sends).toHaveLength(1);
    });
  });

  test('no key and no token is in a log line or in an answer of a whole job, and no log line holds the credential', async () => {
    const world = makeWorld();
    const texts: string[] = [];
    let credential = '';
    await serve(world, async (api) => {
      const go = await api.precheck();
      const job = await api.job();
      credential = String(job.json?.credential ?? '');
      for (const reply of [go, await api.request('GET', '/agent.json'), await api.request('GET', '/price-list.json'), await api.request('GET', '/healthz'), await api.precheck()]) texts.push(reply.text);
      // The answer of the job holds the credential, which the service must give. The rest of it is searched.
      texts.push(job.text.split(credential).join('CREDENTIAL'));
    });
    texts.push(...world.logs);
    expect(credential).toMatch(COMPACT_JWS);
    for (const text of texts) {
      for (const secret of [SERVICE.privateKeyHex, rawHexToBech32(SERVICE.privateKeyHex), TOKEN.slice('Bearer '.length)]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(text).not.toContain('PRIVATE KEY');
    }
    // A line holds codes and counts: no part of the credential, of the request or of the price list.
    for (const line of world.logs) for (const part of [credential, ...credential.split('.'), 'run1-rfq-1', 'GLV-NIT-M', 'unit_price', 'min_quantity']) expect(line).not.toContain(part);
  });
});

describe.each(INSTANCES)('GET /price-list.json and GET /agent.json of the Bid Desk %s', (instance) => {
  test('the price list route gives the bytes of the file of the instance with the type of JSON, needs no token, and the hash of those bytes is the hash that the manifest holds', async () => {
    const world = makeWorld({ instance });
    await serve(world, async (api) => {
      const bytes = readFileSync(priceListUrl(instance));
      const list = await api.request('GET', '/price-list.json', { headers: { authorization: null } });
      expect([list.status, list.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
      expect(Buffer.from(list.text, 'utf8').equals(bytes)).toBe(true);
      const manifest = (await api.request('GET', '/agent.json', { headers: { authorization: null } })).json as { name: string; behaviour: { price_list: { uri: string; sha256: string } } };
      expect(sha256(list.text)).toBe(manifest.behaviour.price_list.sha256);
      expect(manifest.behaviour.price_list.sha256).toBe(PRICE_LIST_SHA256[instance]);
      expect(manifest.behaviour.price_list.uri).toBe(`https://bids-${instance}.example.test/price-list.json`);
      expect(manifest.name).toBe(INSTANCE_NAMES[instance]);
    });
  });
});

describe('GET /price-list.json', () => {
  test('the route answers HEAD with no body, takes a query, and gives 404 for a method that it does not list or a path that is not its own', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.request('HEAD', '/price-list.json')).text).toBe('');
      expect((await api.request('HEAD', '/price-list.json')).status).toBe(200);
      expect((await api.request('GET', '/price-list.json?version=1')).status).toBe(200);
      expect((await api.request('POST', '/price-list.json', { body: '{}' })).status).toBe(404);
      expect((await api.request('GET', '/price-list.json/x')).status).toBe(404);
      expect((await api.request('GET', '/price-list')).status).toBe(404);
    });
  });

  test('the route is not held off by a job that runs: it takes no job slot', async () => {
    const world = makeWorld();
    const hold = world.holdModel();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const pending = api.job();
      await hold.reached;
      expect((await api.request('GET', '/price-list.json')).status).toBe(200);
      expect((await api.request('GET', '/healthz')).json).toStrictEqual({ ok: true });
      hold.release();
      expect((await pending).status).toBe(200);
    });
  });

  test('the manifest is the bytes that the service rendered, the same for the empty fault setting and for the fault value', async () => {
    const clean = makeWorld({ fault: '' });
    const fault = makeWorld({ fault: 'quote_off_price_list' });
    const texts: string[] = [];
    for (const world of [clean, fault]) await serve(world, async (api) => { texts.push((await api.request('GET', '/agent.json', { headers: { authorization: null } })).text); });
    expect(texts[1]).toBe(texts[0]);
    const manifest = JSON.parse(texts[0]!) as { behaviour: { fault_modes: string[] } };
    expect(manifest.behaviour.fault_modes).toStrictEqual(['quote_off_price_list']);
  });
});

describe('createServer', () => {
  const base = {
    manifestText: '{}', authHeader: TOKEN, fault: readFaultSwitch('bid-desk', ''), jobDeps: () => { throw new Error('no job in this test'); }, priceListText: '{}', clock: () => T, log: () => undefined,
  };

  // A caller that ignores the types gives no hook, or one that is not a function: the server must refuse both. The casts stand for that caller.
  const noHook = { ...base } as unknown as ServerOptions;
  const wrongHook = { ...base, precheck: 'yes' } as unknown as ServerOptions;

  test('is never made with no hook: a service with no check would claim every escrow', () => {
    expect(() => createServer(noHook)).toThrow(/the hook of the Bid Desk is required/);
    expect(() => createServer(wrongHook)).toThrow(/the hook of the Bid Desk is required/);
    expect(createServer({ ...base, precheck: async () => ({ go: true }) })).toBeDefined();
  });

  test('is never made with no token', () => {
    expect(() => createServer({ ...base, authHeader: '', precheck: async () => ({ go: true }) })).toThrow(/authHeader/);
  });

  test('serves the price list text byte for byte: a byte order mark, a line break at the end and text beyond ASCII come out as they went in', async () => {
    const text = '\u{feff}{"schema":"x","note":"caf\u{e9}"}\n';
    const server = createServer({ ...base, priceListText: text, precheck: async () => ({ go: true }) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/price-list.json`)).arrayBuffer());
      expect(bytes.equals(Buffer.from(text, 'utf8'))).toBe(true);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe('the hook and the job do not meet before the Claim', () => {
  test('a go reserves the slot for the escrow, and the job of that escrow takes the reservation', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const other = await api.job(world.message, { ...world.context, escrowRef: `${'bb'.repeat(32)}#0` });
      expect([other.status, other.json?.error]).toStrictEqual([409, 'busy']);
      expect((await api.job()).status).toBe(200);
    });
  });
});

describe('the record of the Bid Desk itself', () => {
  const PREFIX = '/1.0/identifiers/';

  /** A fetch that adds a pending recovery to the metadata of the record of one DID, as the gateway does while a recovery waits for its days. */
  function withRecovery(next: typeof fetch, did: string): typeof fetch {
    return async (input, init) => {
      const reply = await next(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith(`${PREFIX}${did}`)) return reply;
      const body: unknown = await reply.json();
      if (!isPlainObject(body) || !isPlainObject(body.didDocumentMetadata)) throw new Error('the answer of the stub is not a DID resolution result');
      const changed = { ...body, didDocumentMetadata: { ...body.didDocumentMetadata, vectorRecovery: { pendingNewController: 'c3'.repeat(28) } } };
      return new Response(JSON.stringify(changed), { status: reply.status, headers: reply.headers });
    };
  }

  /** What the hook and the job answer for one world: the status and the code of each, and the quote without its credential, which the gateway signs anew at each call. */
  async function answers(world: World): Promise<unknown> {
    return serve(world, async (api) => {
      const hook = await api.precheck();
      const job = await api.job();
      const { credential, ...quote } = job.json ?? {};
      expect(String(credential)).toMatch(COMPACT_JWS);
      return { hook: [hook.status, hook.json], job: [job.status, quote] };
    });
  }

  test('the hook and the job give the same answers after the record of the Bid Desk changed: a recovery that waits and a key that the record does not list any more; the service never reads its own record', async () => {
    const as = makeWorld();
    const before = await answers(as);
    const changed = makeWorld();
    changed.gateway.removeKey(changed.desk, changed.desk.delegation);
    changed.gateway.setPurposes(changed.desk, changed.desk.authentication, 0);
    const recovering = withRecovery(changed.options.fetchImpl!, DESK_DID);
    const after = await answers({ ...changed, options: { ...changed.options, fetchImpl: recovering } });
    expect(after).toStrictEqual(before);
    for (const world of [as, changed]) {
      const asked = world.gateway.requests.map((request) => request.path);
      // The hook asks for the DID of the sender, once, and nothing asks for the DID of the Bid Desk. The job asks for the credential of the desk, which is no read of its record.
      expect(asked.filter((path) => path.startsWith(PREFIX)), 'the resolutions that the service asked for').toStrictEqual([`${PREFIX}${world.sender.did}`]);
      expect(asked.some((path) => path.includes(DESK_DID))).toBe(false);
    }
    // The twin: a read of the record of the Bid Desk shows the change, so a service that resolved it would have seen it.
    const client = createGatewayClient({ baseUrl: changed.gateway.baseUrl, fetch: recovering, now: changed.gateway.now });
    const resolved = await client.resolve(DESK_DID);
    if (!resolved.ok || resolved.value.kind !== 'resolved') throw new Error('the record of the Bid Desk does not resolve');
    expect(isPlainObject(resolved.value.metadata.vectorRecovery)).toBe(true);
    expect(resolved.value.keys.some((key) => key.keyHash === changed.desk.delegation.keyHash)).toBe(false);
  });
});
