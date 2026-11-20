// packages/usecase-kit/test/cosign/http.test.ts
// The handler of `POST /cosign/delegate`: the method, the content type, the size of the body before anything is parsed, the limit for requests at one time, and the answer. The handler takes the three
// parts of a request that a Node `IncomingMessage` has, and gives the status, the headers and the body of the answer. No socket is opened.
import { describe, expect, it } from 'vitest';
import { COSIGN_REFUSALS, COSIGN_SETTINGS, COSIGN_STATUS, MAX_COSIGN_REQUEST_BYTES } from '@vsa/usecase-kit/cosign';
import type { CosignCode, CosignHttpRequest, CosignLedger } from '@vsa/usecase-kit/cosign';
import { makeHandler } from '../../src/cosign/http.ts';
import {
  DELEG_A, DELEG_B, NOW, OTHER_AGENT_ID, OTHER_AGENT_KEY, PRINCIPAL, STRANGER, agentWallet, build, deferred, harness, hostedToolTakes, ledgerOf, liveDelegation, privateKeyOf, requestOf, signedBy, withInput, world,
} from './support.ts';

async function* chunksOf(...parts: (string | Uint8Array)[]): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) yield part;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A POST with a JSON body, as the hosted tool sends it. */
const post = (body: string | Uint8Array, headers: CosignHttpRequest['headers'] = JSON_HEADERS): CosignHttpRequest => ({ method: 'POST', headers, body: chunksOf(body) });

/** The text cut into `count` chunks of bytes, at any byte. */
function cut(text: string, count: number): Uint8Array[] {
  const data = Buffer.from(text, 'utf8');
  const size = Math.ceil(data.length / count);
  return Array.from({ length: count }, (_, i) => data.subarray(i * size, (i + 1) * size));
}

const parsedBody = (body: string): Record<string, unknown> => JSON.parse(body) as Record<string, unknown>;

describe('the answer of the handler', () => {
  it('is 200 with the transaction and no other member, as JSON that no cache keeps', async () => {
    const { hex } = await build();
    const response = await harness().route.handle(post(requestOf(hex)));
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    const body = parsedBody(response.body);
    expect(Object.keys(body)).toEqual(['transaction']);
    expect(hostedToolTakes(hex, body.transaction as string, DELEG_A.keyHash)).toMatchObject({ ok: true });
  });

  it('reads a body that comes in chunks, cut at any byte, and in chunks of text', async () => {
    const { hex } = await build();
    const text = requestOf(hex);
    for (const count of [1, 2, 7, 64]) {
      const response = await harness().route.handle({ method: 'POST', headers: JSON_HEADERS, body: chunksOf(...cut(text, count)) });
      expect(response.status, `${count} chunks`).toBe(200);
    }
    expect((await harness().route.handle({ method: 'POST', headers: JSON_HEADERS, body: chunksOf(text.slice(0, 100), text.slice(100)) })).status).toBe(200);
  });

  it('is the 4xx of the rule with `{ error, message }` for each refusal of the contract, and the status of the table', async () => {
    const good = await build();
    const cases: [string, () => Promise<{ status: number; body: string }>][] = [
      ['not_a_delegation', () => harness().route.handle(post(requestOf(signedBy(good.hex, DELEG_A))))],
      ['not_for_this_agent', async () => harness().route.handle(post(requestOf((await build({ delegate: OTHER_AGENT_ID, delegateKey: OTHER_AGENT_KEY.keyHash })).hex)))],
      ['key_in_use', () => harness({ ledger: ledgerOf(world([liveDelegation(DELEG_A.keyHash)])) }).route.handle(post(requestOf(good.hex)))],
      ['principal_not_allowed', () => harness({ allowed: [STRANGER.keyHash] }).route.handle(post(requestOf(good.hex)))],
      ['spends_agent_funds', () => harness().route.handle(post(requestOf(withInput(good.hex, agentWallet(DELEG_A, 1)))))],
      ['expired', () => harness({ now: good.hi }).route.handle(post(requestOf(good.hex)))],
    ];
    expect(cases.map(([code]) => code).sort()).toEqual(Object.keys(COSIGN_REFUSALS).sort());
    for (const [code, run] of cases) {
      const response = await run();
      expect(response.status, code).toBe(COSIGN_STATUS[code as CosignCode]);
      expect(response.status, code).toBeGreaterThanOrEqual(400);
      expect(response.status, code).toBeLessThan(500);
      const body = parsedBody(response.body);
      expect(Object.keys(body).sort(), code).toEqual(['error', 'message']);
      expect(body.error).toBe(code);
      expect(typeof body.message === 'string' && body.message.length > 0 && body.message.length < 200).toBe(true);
    }
  });

  it('is 503 `check_unavailable` for a ledger that cannot be read, and 500 `internal` for a key that signs a wrong value: a fault is never a 4xx', async () => {
    const { hex } = await build();
    const broken: CosignLedger = { outputs: async () => { throw new Error('down'); }, delegateKeysInUse: async () => new Set() };
    const unavailable = await harness({ ledger: broken }).route.handle(post(requestOf(hex)));
    expect([unavailable.status, parsedBody(unavailable.body).error]).toEqual([503, 'check_unavailable']);
    const internal = await harness({ sign: () => () => new Uint8Array(64) }).route.handle(post(requestOf(hex)));
    expect([internal.status, parsedBody(internal.body).error]).toEqual([500, 'internal']);
  });

  it('does not show the transaction, a key hash, or a key of the allowlist in any answer', async () => {
    const { hex } = await build();
    const secrets = [hex, hex.slice(100, 180), DELEG_A.keyHash, DELEG_B.keyHash, PRINCIPAL.keyHash, STRANGER.keyHash, DELEG_A.publicKey];
    const answers = [
      await harness({ allowed: [STRANGER.keyHash] }).route.handle(post(requestOf(hex))),
      await harness().route.handle(post(requestOf(signedBy(hex, DELEG_A)))),
      await harness({ ledger: ledgerOf(world([liveDelegation(DELEG_A.keyHash)])) }).route.handle(post(requestOf(hex))),
      await harness().route.handle(post(requestOf(withInput(hex, agentWallet(DELEG_A, 1))))),
      await harness({ sign: () => () => { throw new Error(`${DELEG_A.keyHash} ${privateKeyOf(DELEG_A).to_bech32()}`); } }).route.handle(post(requestOf(hex))),
      await harness().route.handle(post(JSON.stringify({ transaction: hex, extra: PRINCIPAL.keyHash }))),
    ];
    for (const answer of answers) {
      expect(answer.status).toBeGreaterThanOrEqual(400);
      for (const secret of secrets) expect(`${answer.body} ${JSON.stringify(answer.headers)}`).not.toContain(secret);
    }
  });
});

describe('the method, the content type and the size', () => {
  it.each([['GET'], ['PUT'], ['DELETE'], ['post'], [undefined]])('answers 405 with `allow: POST` for the method %s, and reads no body', async (method) => {
    let read = false;
    const body = (async function* () { read = true; yield 'x'; })();
    const response = await harness().route.handle({ method, headers: JSON_HEADERS, body });
    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('POST');
    expect(parsedBody(response.body).error).toBe('method_not_allowed');
    expect(read).toBe(false);
  });

  it.each([
    [{}], [{ 'content-type': 'text/plain' }], [{ 'content-type': 'application/x-www-form-urlencoded' }], [{ 'content-type': 'application/jsonp' }], [{ 'content-type': 'application/json5' }],
    [{ 'content-type': 'application/json/extra' }], [{ 'content-type': ['application/json', 'text/plain'] }],
  ])('answers 415 for the headers %j', async (headers) => {
    const { hex } = await build();
    const response = await harness().route.handle(post(requestOf(hex), headers as CosignHttpRequest['headers']));
    expect(response.status).toBe(415);
    expect(parsedBody(response.body).error).toBe('unsupported_media_type');
  });

  it.each([['application/json'], ['application/json; charset=utf-8'], ['APPLICATION/JSON'], ['application/json ;charset=UTF-8']])('takes the content type %s, and finds the header in any case', async (type) => {
    const { hex } = await build();
    expect((await harness().route.handle(post(requestOf(hex), { 'Content-Type': type }))).status).toBe(200);
  });

  it('answers 400 `request_too_large` from the length that the header declares, and closes the connection without reading the body', async () => {
    let read = false;
    const body = (async function* () { read = true; yield 'x'; })();
    const response = await harness().route.handle({ method: 'POST', headers: { ...JSON_HEADERS, 'content-length': String(MAX_COSIGN_REQUEST_BYTES + 1) }, body });
    expect([response.status, parsedBody(response.body).error, response.headers.connection]).toEqual([400, 'request_too_large', 'close']);
    expect(read).toBe(false);
  });

  it('takes the length that the header declares when it is at the limit, and ignores a header that is not a number', async () => {
    const { hex } = await build();
    const text = requestOf(hex);
    const at = await harness().route.handle(post(text, { ...JSON_HEADERS, 'content-length': String(MAX_COSIGN_REQUEST_BYTES) }));
    expect(at.status).toBe(200);
    const odd = await harness().route.handle(post(text, { ...JSON_HEADERS, 'content-length': 'many' }));
    expect(odd.status).toBe(200);
  });

  it('answers 400 `request_too_large` for a body that is over the limit by one byte, and takes a body of exactly the limit', async () => {
    const over = await harness().route.handle(post(' '.repeat(MAX_COSIGN_REQUEST_BYTES + 1)));
    expect([over.status, parsedBody(over.body).error]).toEqual([400, 'request_too_large']);
    // A body of the limit is read: the route refuses it as a request that is not JSON of the right form, and not as a request that is too large.
    const at = await harness().route.handle(post(' '.repeat(MAX_COSIGN_REQUEST_BYTES)));
    expect([at.status, parsedBody(at.body).error]).toEqual([400, 'bad_shape']);
  });

  it('counts the bytes of the body and not its characters', async () => {
    const response = await harness().route.handle(post('é'.repeat(MAX_COSIGN_REQUEST_BYTES / 2 + 1)));
    expect(parsedBody(response.body).error).toBe('request_too_large');
    expect(parsedBody((await harness().route.handle(post('é'.repeat(MAX_COSIGN_REQUEST_BYTES / 2)))).body).error).toBe('bad_shape');
  });

  it('reads and drops a body that is over the limit up to 1 MiB, so that the answer reaches the caller, and stops reading a body past that', async () => {
    const chunk = new Uint8Array(65_536).fill(0x20);
    let produced = 0;
    let closed = false;
    const source = (total: number) => (async function* () {
      try {
        for (let sent = 0; sent < total; sent += chunk.length) {
          produced += chunk.length;
          yield chunk;
        }
      } finally {
        closed = true;
      }
    })();
    const small = await harness().route.handle({ method: 'POST', headers: JSON_HEADERS, body: source(512 * 1024) });
    expect([small.status, parsedBody(small.body).error]).toEqual([400, 'request_too_large']);
    expect(produced).toBe(512 * 1024);
    produced = 0;
    closed = false;
    const huge = await harness().route.handle({ method: 'POST', headers: JSON_HEADERS, body: source(64 * 1024 * 1024) });
    expect([huge.status, parsedBody(huge.body).error]).toEqual([400, 'request_too_large']);
    expect(closed).toBe(true);
    expect(produced).toBeLessThanOrEqual(1_048_576 + 65_536);
  });

  it('never throws: a body that fails while it is read is an answer', async () => {
    const failing = (async function* () { yield '{"transa'; throw new Error('socket hang up at 10.0.0.1'); })();
    const response = await harness().route.handle({ method: 'POST', headers: JSON_HEADERS, body: failing });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toContain('10.0.0.1');
  });

  it('never throws: a function behind it that throws is an answer of 500', async () => {
    const handle = makeHandler(async () => { throw new Error('secret'); });
    const response = await handle(post('{}'));
    expect([response.status, parsedBody(response.body).error]).toEqual([500, 'internal']);
    expect(response.body).not.toContain('secret');
  });
});

describe('the limit for requests at one time', () => {
  /** A ledger that holds each read of the outputs at a gate. `second` is settled when the second read has come. */
  function gated() {
    const gate = deferred();
    const second = deferred();
    const inner = ledgerOf(world());
    let reads = 0;
    const ledger: CosignLedger = {
      outputs: async (refs) => {
        reads += 1;
        if (reads === 2) second.resolve();
        await gate.promise;
        return inner.outputs(refs);
      },
      delegateKeysInUse: () => inner.delegateKeysInUse(),
    };
    return { ledger, open: gate.resolve, second: second.promise, reads: () => reads };
  }

  it('answers `busy` at once to the request over the limit, without a read of the ledger, and lets the others finish', async () => {
    const { hex } = await build();
    const { ledger, open, second: secondRead, reads } = gated();
    const h = harness({ ledger, limits: { [COSIGN_SETTINGS.maxConcurrent]: '2' } });
    const first = h.route.handle(post(requestOf(hex)));
    const second = h.route.handle(post(requestOf(hex)));
    const third = await h.route.handle(post(requestOf(hex)));
    expect([third.status, parsedBody(third.body).error]).toEqual([COSIGN_STATUS.busy, 'busy']);
    // Only the two requests inside the limit reached the ledger.
    await secondRead;
    expect(reads()).toBe(2);
    open();
    expect([(await first).status, (await second).status]).toEqual([200, 200]);
  });

  it('counts a request that is over when it is over: a failed request frees its place, and so does a refused one', async () => {
    const { hex } = await build();
    let failures = 2;
    const inner = ledgerOf(world());
    const ledger: CosignLedger = { outputs: async (refs) => { if (failures-- > 0) throw new Error('down'); return inner.outputs(refs); }, delegateKeysInUse: () => inner.delegateKeysInUse() };
    const h = harness({ ledger, limits: { [COSIGN_SETTINGS.maxConcurrent]: '1' } });
    for (let i = 0; i < 2; i++) expect((await h.route.handle(post(requestOf(hex)))).status).toBe(503);
    expect((await h.route.handle(post('not json'))).status).toBe(400);
    expect((await h.route.handle(post(requestOf(hex)))).status).toBe(200);
  });

  it('does not count a request that the handler refuses before the function runs: a wrong method does not take a place', async () => {
    const { hex } = await build();
    const { ledger, open } = gated();
    const h = harness({ ledger, limits: { [COSIGN_SETTINGS.maxConcurrent]: '1' } });
    const running = h.route.handle(post(requestOf(hex)));
    expect((await h.route.handle({ method: 'GET', headers: JSON_HEADERS, body: chunksOf() })).status).toBe(405);
    expect((await h.route.handle(post(requestOf(hex)))).status).toBe(COSIGN_STATUS.busy);
    open();
    expect((await running).status).toBe(200);
    expect(NOW).toBeGreaterThan(0);
  });
});
