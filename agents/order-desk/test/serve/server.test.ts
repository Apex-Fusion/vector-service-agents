// agents/order-desk/test/serve/server.test.ts
// The service over HTTP, on a real port, with the stub gateway, the ledger fixtures, the stub marketplace with a FakeChain, the fake supplier portal and a scripted Module-1 port (test/serve/world.ts). The hook
// gives a go or the status and the code of the check, and a go keeps the record of the checks for the job. The job takes the confirmation only for the body that the hook checked: with no record, or with the record
// of another body, it writes nothing. The lots file is served as the bytes that the manifest hashes. A digest mismatch is answered first, and the challenge starts after the answer. Nothing here uses the network.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { rawHexToBech32 } from '@vsa/buyer-core';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { CONFIRMATION_CHECKS, parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import { FileOrderBook } from '../../src/checks/index.ts';
import { createServer } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { LOTS_FILE } from '../../src/serve/settings.ts';
import { serve, until } from './serve.ts';
import { SERVICE, TOKEN, cleanDirs } from './support.ts';
import { DECLINES, OTHER_ADVERT_REF, PLAIN_ESCROW_REF, T, headersOf, makeWorld, proposalOf, wire } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanDirs(); });

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const FIXED = "The service could not do this job (precheck_missing). The operator's log has the detail.";
/** The digest of a purchase order that the hirer did not approve: the approval that holds it does not match the order that the sender sends. */
const OTHER_DIGEST = proposalOf({ quantity: 3 }).proposal_digest;

describe('POST /precheck: the hook', () => {
  test('a request that passes the 16 checks gets a go and the reservation of the job slot for its escrow', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json]).toStrictEqual([200, { go: true, reserved_ms: 120_000 }]);
      expect(world.logs.some((line) => line.startsWith(`pre-check go for ${world.context.escrowRef}`))).toBe(true);
      // The slot is held for this escrow: another escrow is busy until the job of this one has run.
      const other = await api.precheck(undefined, { ...world.context, escrowRef: `${'aa'.repeat(32)}#0` });
      expect([other.status, other.json?.error]).toStrictEqual([409, 'busy']);
    });
  });

  /** A request with one defect: the world that it is made in, and the context of the call. */
  type Defect = readonly [code: string, make: () => { world: World; before?: (world: World) => Promise<void> }];
  const DEFECTS: readonly Defect[] = [
    ['sender_not_active', () => { const world = makeWorld(); world.gateway.setStatus(world.sender, 'suspended'); return { world }; }],
    ['not_vault_paid', () => { const world = makeWorld(); return { world: { ...world, context: { ...world.context, escrowRef: PLAIN_ESCROW_REF } } }; }],
    ['not_for_this_supplier', () => ({ world: makeWorld({ order: { supplier_did: `did:vector:${'f2'.repeat(32)}` } }) })],
    ['lot_mismatch', () => ({ world: makeWorld({ order: { advert_ref: OTHER_ADVERT_REF } }) })],
    ['quantity_mismatch', () => ({ world: makeWorld({ order: { quantity: 51 } }) })],
    ['duplicate_po', () => ({ world: makeWorld(), before: (world) => new FileOrderBook(join(world.stateDir, 'orders.json')).record('run1', 'RUN1-0001', 'SO-run1-0001') })],
    ['approval_digest_mismatch', () => ({ world: makeWorld({ attestation: { digest: OTHER_DIGEST } }) })],
  ];

  test.each(DEFECTS)('%s is a 403 with its code, keeps no record for the job, and the same request with no defect gets a go', async (code, make) => {
    const { world, before } = make();
    // A book that holds an order must hold it before the service starts: the file is read at each call.
    if (before !== undefined) await before(world);
    await serve(world, async (api) => {
      const reply = await api.precheck(world.handoff, world.context);
      expect([reply.status, reply.json?.error]).toStrictEqual([403, code]);
      expect(typeof reply.json?.message).toBe('string');
      // No record of passed checks: the job for the same escrow and body is refused as one that the hook did not check.
      const job = await api.job(world.handoff, world.context);
      expect([job.status, job.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.portal.calls).toStrictEqual([]);
    });
    const good = makeWorld();
    await serve(good, async (api) => { expect((await api.precheck()).json).toStrictEqual({ go: true, reserved_ms: 120_000 }); });
  });

  test('a source that cannot be read is 503 check_unavailable, never a go and never the code of a rule, and the answer shows nothing of the cause', async () => {
    const world = makeWorld();
    world.gateway.fault(`/1.0/identifiers/${world.sender.did}`, 'network');
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([503, 'check_unavailable']);
      expect(reply.text).not.toContain('did:vector');
      expect(world.portal.calls).toStrictEqual([]);
    });
  });

  test('a handoff for another use case, a document that is not a purchase order and a request that is no handoff are 400 bad_shape on both routes, and the same handoff for use case 1 is taken', async () => {
    const world = makeWorld();
    const other = { ...world.handoff, use_case: 'prior-authorization' };
    const notAnOrder = { ...world.handoff, document: { schema: 'vector.usecase.priorauth-request.v1', note: 'not a purchase order' } };
    await serve(world, async (api) => {
      for (const body of [other, notAnOrder, 'not json', { schema: 'vector.usecase.handoff.v1' }]) {
        for (const reply of [await api.precheck(body), await api.job(body)]) {
          expect([reply.status, reply.json?.error], JSON.stringify(body).slice(0, 40)).toStrictEqual([400, 'bad_shape']);
          expect(reply.json?.message).not.toContain(world.sender.did);
        }
      }
      expect((await api.precheck(world.handoff)).status).toBe(200);
    });
  });

  test('a call that has not the six headers of the context is 400 bad_context, and a call that has all six is answered', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      for (const name of Object.keys(headersOf(world.context))) {
        const reply = await api.precheck(world.handoff, world.context, { [name]: null });
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
          const reply = await api.request('POST', path, { body: wire(world.handoff), headers: { ...headersOf(world.context), authorization } });
          expect([reply.status, reply.json], `${path} ${String(authorization)}`).toStrictEqual([401, { error: 'unauthorized' }]);
        }
      }
      expect(world.portal.calls).toStrictEqual([]);
    });
  });
});

describe('POST /: the job', () => {
  test('after a go it gives the confirmation of the order that the supplier portal took, and it books the order', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      const confirmation = parseOrderConfirmation(reply.json);
      expect(confirmation.ok, reply.text).toBe(true);
      if (!confirmation.ok) return;
      const value = confirmation.value;
      expect([value.po_number, value.sku, value.lot, value.quantity, value.order_id, value.ship_by, value.fault_mode]).toStrictEqual(['run1-0001', 'GLV-NIT-M', 'lot-medium', 50, 'SO-run1-0001', '2026-11-28', '']);
      expect(value.sender).toStrictEqual({ did: world.sender.did, organisation: 'buyer.example', organisation_verified: true });
      expect(Object.keys(value.checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
      expect(value.decisions.map((decision) => decision.name)).toStrictEqual(['availability']);
      // One order at the portal, one model hire from the marketplace, and the order in the book on the state volume.
      expect([...world.portal.orders.keys()]).toStrictEqual(['run1-0001']);
      expect(world.m.llm.sends).toHaveLength(1);
      expect(readFileSync(join(world.stateDir, 'orders.json'), 'utf8')).toContain('SO-run1-0001');
      // The same purchase order number is taken: the next hook for it is a duplicate.
      const again = await api.precheck();
      expect([again.status, again.json?.error]).toStrictEqual([403, 'duplicate_po']);
    });
  });

  test('with no record of passed checks it fails closed: 500 precheck_missing with the fixed text, and nothing is written to the portal, asked of the gateway or paid to a model', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const reply = await api.job();
      expect([reply.status, reply.json]).toStrictEqual([500, { error: 'precheck_missing', message: FIXED }]);
      expect(world.portal.calls).toStrictEqual([]);
      expect(world.gateway.requests).toStrictEqual([]);
      expect(world.m.llm.sends).toStrictEqual([]);
      expect(world.logs.some((line) => line.includes('precheck_missing') && line.includes(world.context.escrowRef))).toBe(true);
    });
  });

  test('after a go for another body it fails closed too, and the same body passes: the record is for the body that the hook checked', async () => {
    const world = makeWorld();
    const another = { ...world.handoff, approval: { ...world.handoff.approval, issuer_did: `did:vector:${'f3'.repeat(32)}` } };
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job(another);
      expect([reply.status, reply.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.portal.calls).toStrictEqual([]);
      expect(world.m.llm.sends).toStrictEqual([]);
    });
    const twin = makeWorld();
    await serve(twin, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      expect(twin.portal.orders.size).toBe(1);
    });
  });

  test('the record serves one job: a second job for the same escrow and body finds none', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      const second = await api.job();
      expect([second.status, second.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.portal.orders.size).toBe(1);
    });
  });

  test('a call with no context is 400 bad_context, and a call with part of it is refused by the kit with the same code', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const none = await api.request('POST', '/', { body: wire(world.handoff) });
      expect([none.status, none.json?.error]).toStrictEqual([400, 'bad_context']);
      const part = await api.request('POST', '/', { body: wire(world.handoff), headers: { 'x-vector-escrow-ref': world.context.escrowRef } });
      expect([part.status, part.json?.error]).toStrictEqual([400, 'bad_context']);
      expect(world.portal.calls).toStrictEqual([]);
      // The same job with its whole context is taken after a go.
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
    });
  });

  test('a model that does not confirm gives 403 cannot_supply and no order, and the model supplier is paid for its answer', async () => {
    const world = makeWorld();
    world.m.llm.answer = DECLINES;
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect([reply.status, reply.json?.error]).toStrictEqual([403, 'cannot_supply']);
      expect(world.portal.orders.size).toBe(0);
      expect(world.portal.calls.filter((call) => call.method === 'POST')).toStrictEqual([]);
      expect(world.m.llm.sends).toHaveLength(1);
    });
  });

  test('the fault switch changes what the order and the confirmation name and nothing a check does, and every result names the setting', async () => {
    const clean = makeWorld();
    await serve(clean, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect([reply.json?.lot, reply.json?.quantity, reply.json?.fault_mode]).toStrictEqual(['lot-medium', 50, '']);
    });
    const fault = makeWorld({ fault: 'confirm_wrong_lot' });
    await serve(fault, async (api) => {
      // The hook is the hook of a clean run: the request that the checks refuse in a clean run is refused here too.
      const refused = makeWorld({ fault: 'confirm_wrong_lot', order: { quantity: 51 } });
      await serve(refused, async (other) => { expect((await other.precheck()).json?.error).toBe('quantity_mismatch'); });
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      expect([reply.json?.lot, reply.json?.quantity, reply.json?.fault_mode]).toStrictEqual(['lot-small', 10, 'confirm_wrong_lot']);
      const order = JSON.parse(fault.portal.calls.filter((call) => call.method === 'POST').at(-1)?.body ?? 'null') as { lot: string; quantity: number };
      expect([order.lot, order.quantity]).toStrictEqual(['lot-small', 10]);
    });
  });

  test('a caller that hangs up before the order gets no order: the job sees it after the model hire and stops, and the order is never sent', async () => {
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
      await until(() => world.logs.some((line) => line.includes('the caller hung up, so the job stops before the order')), 'the job has stopped');
      expect(world.portal.orders.size).toBe(0);
      expect(world.portal.calls.filter((call) => call.method === 'POST')).toStrictEqual([]);
      // The catalogue was read and the model was hired: that part of the job had begun.
      expect(world.portal.calls.map((call) => call.method)).toStrictEqual(['GET']);
      expect(world.m.llm.sends).toHaveLength(1);
    });
  });

  test('no key, no token and no key of an X.509-SVID is in a log line or in an answer of a whole job', async () => {
    const world = makeWorld();
    const texts: string[] = [];
    await serve(world, async (api) => {
      for (const reply of [await api.precheck(), await api.job(), await api.request('GET', '/agent.json'), await api.request('GET', '/lots.json'), await api.request('GET', '/healthz'), await api.precheck()]) texts.push(reply.text);
    });
    texts.push(...world.logs);
    const pems = world.portal.calls.flatMap((call) => call.key.split('\n').filter((line) => line.length >= 16 && !line.startsWith('-----')));
    expect(pems.length).toBeGreaterThan(0);
    for (const text of texts) {
      for (const secret of [SERVICE.privateKeyHex, rawHexToBech32(SERVICE.privateKeyHex), TOKEN.slice('Bearer '.length), ...pems]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(text).not.toContain('PRIVATE KEY');
    }
  });
});

describe('GET /lots.json and GET /agent.json', () => {
  test('the lots route gives the bytes of the file with the type of JSON, needs no token, and the hash of those bytes is the hash that the manifest holds', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      const bytes = readFileSync(LOTS_FILE);
      const lots = await api.request('GET', '/lots.json', { headers: { authorization: null } });
      expect([lots.status, lots.headers.get('content-type')]).toStrictEqual([200, 'application/json']);
      expect(Buffer.from(lots.text, 'utf8').equals(bytes)).toBe(true);
      const manifest = (await api.request('GET', '/agent.json', { headers: { authorization: null } })).json as { behaviour: { lots: { uri: string; sha256: string } } };
      expect(sha256(lots.text)).toBe(manifest.behaviour.lots.sha256);
      expect(sha256(bytes)).toBe(manifest.behaviour.lots.sha256);
      expect(manifest.behaviour.lots.uri).toBe('https://orders-small.example.test/lots.json');
    });
  });

  test('the route answers HEAD with no body, takes a query, and gives 404 for a method that it does not list or a path that is not its own', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.request('HEAD', '/lots.json')).text).toBe('');
      expect((await api.request('HEAD', '/lots.json')).status).toBe(200);
      expect((await api.request('GET', '/lots.json?version=1')).status).toBe(200);
      expect((await api.request('POST', '/lots.json', { body: '{}' })).status).toBe(404);
      expect((await api.request('GET', '/lots.json/x')).status).toBe(404);
      expect((await api.request('GET', '/lots')).status).toBe(404);
    });
  });

  test('the route is not held off by a job that runs: it takes no job slot', async () => {
    const world = makeWorld();
    const hold = world.holdModel();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const pending = api.job();
      await hold.reached;
      const lots = await api.request('GET', '/lots.json');
      expect(lots.status).toBe(200);
      expect((await api.request('GET', '/healthz')).json).toStrictEqual({ ok: true });
      hold.release();
      expect((await pending).status).toBe(200);
    });
  });

  test('the manifest is the bytes that the service rendered, the same for the empty fault setting and for the fault value', async () => {
    const clean = makeWorld({ fault: '' });
    const fault = makeWorld({ fault: 'confirm_wrong_lot' });
    const texts: string[] = [];
    for (const world of [clean, fault]) await serve(world, async (api) => { texts.push((await api.request('GET', '/agent.json', { headers: { authorization: null } })).text); });
    expect(texts[1]).toBe(texts[0]);
    const manifest = JSON.parse(texts[0]!) as { name: string; behaviour: { fault_modes: string[]; lots: { sha256: string } } };
    expect([manifest.name, manifest.behaviour.fault_modes]).toStrictEqual(['Order Desk', ['confirm_wrong_lot']]);
    expect(manifest.behaviour.lots.sha256).toBe(sha256(readFileSync(LOTS_FILE)));
  });
});

describe('the challenge after a digest mismatch', () => {
  test('the hook answers 403 with no reference in the message, and the challenge is filed after the answer, with its references in the log', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    const publish = world.port.holdPublish();
    await serve(world, async (api) => {
      const reply = await api.precheck();
      expect([reply.status, reply.json?.error]).toStrictEqual([403, 'approval_digest_mismatch']);
      // The answer came while the evidence was not on the chain: the challenge starts after the answer and never holds it back.
      await until(() => world.port.events.some((event) => event.startsWith('publish')), 'the challenge has started');
      expect(world.port.challenged).toStrictEqual([]);
      for (const reference of [world.context.escrowRef]) expect(reply.text).not.toContain(reference);
      publish();
      await until(() => world.port.challenged.length === 1, 'the challenge is filed');
      expect(world.port.published).toHaveLength(1);
      expect(world.port.published[0]?.type).toBe('evidence');
      await until(() => world.logs.some((line) => line.startsWith('order desk: challenge filed')), 'the log has the challenge');
      const line = world.logs.find((entry) => entry.startsWith('order desk: challenge filed')) ?? '';
      expect(line).toContain(world.context.escrowRef);
      expect(reply.text).not.toContain('99'.repeat(32));
    });
  });

  test('the challenge runs in the queue of the service key, beside the hires, and its journal is on the state volume', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(403);
      await until(() => world.port.challenged.length === 1, 'the challenge is filed');
      const dir = join(world.stateDir, 'dispute');
      const [file] = readdirSync(dir);
      expect(readFileSync(join(dir, file ?? 'none'), 'utf8')).toContain(world.context.escrowRef);
    });
  });

  test('a request that passes the digest check starts no challenge', async () => {
    const world = makeWorld();
    world.armChallenge();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      // A round trip of the service comes after the turn of the event loop in which a scheduled task would start.
      expect((await api.request('GET', '/healthz')).status).toBe(200);
      expect(world.port.events.filter((event) => event.startsWith('publish') || event.startsWith('openChallenge'))).toStrictEqual([]);
    });
  });
});

describe('createServer', () => {
  const base = {
    manifestText: '{}', authHeader: TOKEN, fault: readFaultSwitch('order-desk', ''), jobDeps: () => { throw new Error('no job in this test'); }, lotsText: '{}', clock: () => T, log: () => undefined,
  };

  // A caller that ignores the types gives no hook, or one that is not a function: the server must refuse both. The casts stand for that caller.
  const noHook = { ...base } as unknown as ServerOptions;
  const wrongHook = { ...base, precheck: 'yes' } as unknown as ServerOptions;

  test('is never made with no hook: a service with no check would claim every escrow', () => {
    expect(() => createServer(noHook)).toThrow(/the hook of the Order Desk is required/);
    expect(() => createServer(wrongHook)).toThrow(/the hook of the Order Desk is required/);
    expect(createServer({ ...base, precheck: async () => ({ go: true }) })).toBeDefined();
  });

  test('is never made with no token', () => {
    expect(() => createServer({ ...base, authHeader: '', precheck: async () => ({ go: true }) })).toThrow(/authHeader/);
  });

  test('serves the lots text byte for byte: a byte order mark, a line break at the end and text beyond ASCII come out as they went in', async () => {
    const text = '\u{feff}{"schema":"x","note":"caf\u{e9}"}\n';
    const server = createServer({ ...base, lotsText: text, precheck: async () => ({ go: true }) });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const bytes = Buffer.from(await (await fetch(`http://127.0.0.1:${port}/lots.json`)).arrayBuffer());
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
      const other = await api.job(world.handoff, { ...world.context, escrowRef: `${'bb'.repeat(32)}#0` });
      expect([other.status, other.json?.error]).toStrictEqual([409, 'busy']);
      expect((await api.job()).status).toBe(200);
    });
  });
});
