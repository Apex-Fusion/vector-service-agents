// agents/insurer-intake-agent/test/serve/server.test.ts
// The service over HTTP, on a real port, with the stub gateway, the ledger fixtures, the stub marketplace with a FakeChain, the fake insurer portal and a scripted Module-1 port (test/serve/world.ts). The hook gives a
// go or the status and the code of the check, and a go keeps the record of the checks for the job. The job takes the request only for the body that the hook checked: with no record, or with the record of another
// body, it writes nothing. A request of another use case never reaches the hook. A digest mismatch is answered first, and the challenge starts after the answer. Nothing here uses the network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DELIVER_BY_BUFFER_MS, planFleetPostEscrow } from '@vsa/buyer-core';
import { INTAKE_CHECKS, PRIORAUTH_MODELS, parseIntakeRecord } from '@vsa/usecase-kit/priorauth';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import type { AdvertDatum } from '@vsa/vector-read';
import { FileIntakeBook } from '../../src/store/index.ts';
import { createServer } from '../../src/serve/server.ts';
import type { ServerOptions } from '../../src/serve/server.ts';
import { loadConfig } from '../../src/serve/start.ts';
import { serve, until } from './serve.ts';
import { SERVICE, SUPPLIER, TOKEN, cleanDirs, secretsOf } from './support.ts';
import { ATTESTATION_ID, HOUR, INCOMPLETE, INTAKE_DID, OTHER_ADVERT_REF, PLAIN_ESCROW_REF, T, headersOf, makeWorld, proposalOf, wire } from './world.ts';
import type { World } from './world.ts';

afterEach(() => { cleanDirs(); });

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const FIXED = "The service could not do this job (precheck_missing). The operator's log has the detail.";
/** The digest of an authorization request that the hirer did not approve: the approval that holds it does not match the request that the sender sends. */
const OTHER_DIGEST = proposalOf({ request_number: 'run1-9' }).proposal_digest;
const hashOf = (value: unknown): string => {
  const hash = canonicalSha256(value);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
};

describe('POST /precheck: the hook', () => {
  test('a request that passes the 15 checks gets a go and the reservation of the job slot for its escrow', async () => {
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

  /** A request with one defect: the world that it is made in. A book that holds the number is made before the service starts. */
  type Defect = readonly [code: string, make: () => { world: World; before?: (world: World) => Promise<void> }];
  const DEFECTS: readonly Defect[] = [
    ['sender_not_active', () => { const world = makeWorld(); world.gateway.setStatus(world.sender, 'suspended'); return { world }; }],
    ['not_vault_paid', () => { const world = makeWorld(); return { world: { ...world, context: { ...world.context, escrowRef: PLAIN_ESCROW_REF } } }; }],
    ['not_for_this_insurer', () => ({ world: makeWorld({ request: { insurer_did: `did:vector:${'f2'.repeat(32)}` } }) })],
    ['advert_mismatch', () => ({ world: makeWorld({ request: { advert_ref: OTHER_ADVERT_REF } }) })],
    ['duplicate_request', () => ({ world: makeWorld(), before: (world) => new FileIntakeBook(join(world.stateDir, 'requests.json')).record('run1', 'RUN1-1', 'IN-run1-0000') })],
    ['approval_digest_mismatch', () => ({ world: makeWorld({ attestation: { digest: OTHER_DIGEST } }) })],
  ];

  test.each(DEFECTS)('%s is a 403 with its code, keeps no record for the job, and the same request with no defect gets a go', async (code, make) => {
    const { world, before } = make();
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

  test('a handoff for another use case, a document that is not an authorization request and a request that is no handoff are 400 bad_shape on both routes and never reach the hook; the same handoff for use case 2 is taken', async () => {
    const world = makeWorld();
    const other = { ...world.handoff, use_case: 'inventory-reorder' };
    const notARequest = { ...world.handoff, document: { schema: 'vector.usecase.po.v1', note: 'not an authorization request' } };
    await serve(world, async (api) => {
      for (const body of [other, notARequest, 'not json', { schema: 'vector.usecase.handoff.v1' }]) {
        for (const reply of [await api.precheck(body), await api.job(body)]) {
          expect([reply.status, reply.json?.error], JSON.stringify(body).slice(0, 40)).toStrictEqual([400, 'bad_shape']);
          expect(reply.json?.message).not.toContain(world.sender.did);
        }
      }
      // The hook reads the gateway first: no request of these bodies reached it, and none reached the portal.
      expect(world.gateway.requests).toStrictEqual([]);
      expect(world.portal.calls).toStrictEqual([]);
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
      expect(world.gateway.requests).toStrictEqual([]);
    });
  });
});

describe('POST /: the job', () => {
  test('after a go it gives the intake record of the request that the insurer portal took, with fault_mode as its last member, and it books the entry', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      const record = parseIntakeRecord(reply.json);
      expect(record.ok, reply.text).toBe(true);
      if (!record.ok) return;
      const value = record.value;
      expect([value.request_number, value.request_sha256, value.status, value.missing, value.intake_id, value.fault_mode])
        .toStrictEqual(['run1-1', hashOf(world.proposal.document), 'complete', [], 'IN-run1-0001', '']);
      expect(value.sender).toStrictEqual({ did: world.sender.did, organisation: 'clinic.example', organisation_verified: true });
      expect([value.approval.attestation, value.approval.valid_until]).toStrictEqual([ATTESTATION_ID, new Date(T + 4 * HOUR).toISOString()]);
      expect(value.attestations).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
      expect(Object.keys(value.checks)).toStrictEqual([...INTAKE_CHECKS]);
      expect(value.decisions.map((decision) => [decision.name, decision.choice, decision.inference.path])).toStrictEqual([['completeness', { complete: true, missing: [] }, 'marketplace']]);
      expect(Object.keys(reply.json ?? {}).at(-1)).toBe('fault_mode');
      // One entry at the insurer portal, filed once with the request and its status, one model hire from the marketplace, and the entry in the book on the state volume.
      expect([...world.portal.filed.keys()]).toStrictEqual(['run1-1']);
      const calls = world.portal.calls.map((call) => call.method);
      expect(calls).toStrictEqual(['GET', 'POST']);
      expect(JSON.parse(world.portal.calls[1]?.body ?? 'null')).toStrictEqual({ request: world.proposal.document, status: 'complete', missing: [] });
      expect(world.m.llm.sends).toHaveLength(1);
      expect(readFileSync(join(world.stateDir, 'requests.json'), 'utf8')).toContain('IN-run1-0001');
      // The same request number is taken: the next hook for it is a duplicate.
      const again = await api.precheck();
      expect([again.status, again.json?.error]).toStrictEqual([403, 'duplicate_request']);
    });
  });

  test('a request that the model finds incomplete is filed all the same, with the status incomplete and the ids that the model named: an intake decision, and no refusal', async () => {
    const world = makeWorld();
    world.m.llm.answer = INCOMPLETE;
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      expect([reply.json?.status, reply.json?.missing]).toStrictEqual(['incomplete', ['R4']]);
      expect(JSON.parse(world.portal.calls.filter((call) => call.method === 'POST')[0]?.body ?? 'null')).toMatchObject({ status: 'incomplete', missing: ['R4'] });
      expect(world.portal.filed.size).toBe(1);
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
      expect(twin.portal.filed.size).toBe(1);
    });
  });

  test('the record serves one job: a second job for the same escrow and body finds none', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      expect((await api.job()).status).toBe(200);
      const second = await api.job();
      expect([second.status, second.json?.error]).toStrictEqual([500, 'precheck_missing']);
      expect(world.portal.filed.size).toBe(1);
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

  test('an answer of the model that cannot be used is 502 model_output_invalid, and nothing is filed: the model supplier is paid for its answer, and the portal sees the read of the requirements only', async () => {
    const world = makeWorld();
    world.m.llm.answer = 'this is not the answer of the decision';
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect([reply.status, reply.json?.error]).toStrictEqual([502, 'model_output_invalid']);
      expect(world.portal.calls.map((call) => call.method)).toStrictEqual(['GET']);
      expect(world.portal.filed.size).toBe(0);
      expect(world.m.llm.sends).toHaveLength(1);
      expect(readFileSync(join(world.stateDir, 'requests.json'), 'utf8')).not.toContain('IN-run1');
    });
  });

  test('an entry that the portal holds already is 403 duplicate_request, and the book gets none: the portal is the second line after the book', async () => {
    const world = makeWorld();
    world.portal.prefile('run1-1');
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const reply = await api.job();
      expect([reply.status, reply.json?.error]).toStrictEqual([403, 'duplicate_request']);
      expect(world.portal.filed.size).toBe(1);
      expect(readFileSync(join(world.stateDir, 'requests.json'), 'utf8')).not.toContain('IN-run1-0000');
    });
  });

  test('a report that cannot be read changes no other member of the record: the three words are unreadable, and the rest is the record of the run with a readable ledger', async () => {
    const readable = makeWorld();
    let before: Record<string, unknown> = {};
    await serve(readable, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      before = (await api.job()).json ?? {};
    });
    const unreadable = makeWorld();
    let after: Record<string, unknown> = {};
    await serve(unreadable, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      // The hook has passed. From here every read of the ledger fails, and the job reads it only for the report.
      unreadable.ledgerDown(true);
      const reply = await api.job();
      expect(reply.status, reply.text).toBe(200);
      after = reply.json ?? {};
    });
    expect(after.attestations).toStrictEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });
    expect(before.attestations).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
    for (const member of ['schema', 'outcome', 'request_number', 'request_sha256', 'status', 'missing', 'intake_id', 'sender', 'approval', 'checks', 'fault_mode']) {
      expect(after[member], member).toStrictEqual(before[member]);
    }
    const choiceOf = (record: Record<string, unknown>): unknown => (record.decisions as Array<{ name: string; choice: unknown }>).map(({ name, choice }) => [name, choice]);
    expect(choiceOf(after)).toStrictEqual(choiceOf(before));
  });

  test('a caller that hangs up before the filing gets no filing: the job sees it after the model hire and stops, and the request is never sent', async () => {
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
      await until(() => world.logs.some((line) => line.includes('the caller hung up, so the job stops before the filing')), 'the job has stopped');
      expect(world.portal.filed.size).toBe(0);
      expect(world.portal.calls.filter((call) => call.method === 'POST')).toStrictEqual([]);
      // The requirements were read and the model was hired: that part of the job had begun.
      expect(world.portal.calls.map((call) => call.method)).toStrictEqual(['GET']);
      expect(world.m.llm.sends).toHaveLength(1);
    });
  });

  test('a caller that hangs up during the filing still gets the entry in the portal and in the book: the signal never goes into the call', async () => {
    const world = makeWorld();
    const hold = world.holdFiling();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const controller = new AbortController();
      const pending = api.job(undefined, undefined, {}, controller.signal).then(() => 'answered', () => 'hung up');
      await hold.reached;
      controller.abort();
      await until(() => world.logs.some((line) => line.startsWith('job abandoned by the caller')), 'the server has seen the hang-up');
      hold.release();
      expect(await pending).toBe('hung up');
      await until(() => world.logs.some((line) => line.includes('the caller hung up while the request was filed')), 'the job has booked the entry');
      expect(world.portal.filed.size).toBe(1);
      expect(readFileSync(join(world.stateDir, 'requests.json'), 'utf8')).toContain('IN-run1-0001');
    });
  });

  test('no key, no token, no JWT-SVID and no subject token is in a log line or in an answer of a whole job', async () => {
    const world = makeWorld();
    const texts: string[] = [];
    await serve(world, async (api) => {
      for (const reply of [await api.precheck(), await api.job(), await api.request('GET', '/agent.json'), await api.request('GET', '/healthz'), await api.precheck()]) texts.push(reply.text);
    });
    texts.push(...world.logs);
    const issued = world.gateway.requests.filter((call) => call.path === '/spiffe/jwt-svid');
    expect(issued.length).toBeGreaterThan(0);
    const bearers = world.portal.calls.map((call) => /^Bearer (\S+)$/.exec(call.headers.authorization ?? '')?.[1]).filter((token): token is string => token !== undefined);
    expect(bearers.length).toBeGreaterThan(0);
    for (const text of texts) {
      for (const secret of [...secretsOf(), ...bearers, ...bearers.flatMap((token) => token.split('.').filter((part) => part.length >= 12))]) expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain('Bearer ');
    }
  });
});

describe('the surface of the service', () => {
  test('has no open route: the lots route of another agent and the co-sign route are not here', async () => {
    const world = makeWorld();
    await serve(world, async (api) => {
      for (const [method, path] of [['GET', '/lots.json'], ['POST', '/cosign/delegate'], ['GET', '/v1/job'], ['GET', '/']] as const) {
        const reply = await api.request(method, path, { headers: { authorization: null } });
        expect([reply.status, reply.json], `${method} ${path}`).toStrictEqual([404, { error: 'not_found' }]);
      }
    });
  });

  test('GET /agent.json serves the bytes that the start rendered, with no token, and the hash of those bytes is stable: two starts give the same bytes', async () => {
    const texts: string[] = [];
    for (let run = 0; run < 2; run += 1) {
      const world = makeWorld();
      await serve(world, async (api) => { texts.push((await api.request('GET', '/agent.json', { headers: { authorization: null } })).text); });
    }
    expect(texts[1]).toBe(texts[0]);
    const config = loadConfig(makeWorld().env);
    expect(texts[0]).toBe(config.manifest.text);
    expect(sha256(texts[0] ?? '')).toBe(config.manifest.sha256);
    const manifest = JSON.parse(texts[0] ?? '{}') as { name: string; capability_id: string; behaviour: { fault_modes: string[] }; keys: { buyer_pkh: string }; identity: { did: string } };
    expect([manifest.name, manifest.capability_id, manifest.behaviour.fault_modes, manifest.keys.buyer_pkh, manifest.identity.did])
      .toStrictEqual(['Insurer Intake Agent', 'health.priorauth.intake.v1', [], SERVICE.pkh, INTAKE_DID]);
  });

  test('the terms of the served manifest are the terms of the lock of a Post: the price 2 and both bonds 1 give 4,000,000 lovelace', async () => {
    const world = makeWorld();
    let text = '';
    await serve(world, async (api) => { text = (await api.request('GET', '/agent.json', { headers: { authorization: null } })).text; });
    const manifest = JSON.parse(text) as { capability_id: string; terms: { price_lovelace: number; supplier_bond_lovelace: number; buyer_bond_lovelace: number; max_processing_ms: number } };
    const advert = {
      supplier_pkh: SUPPLIER.pkh, capability_id: manifest.capability_id, model: PRIORAUTH_MODELS.intake, max_output_tokens: 0, max_processing_ms: manifest.terms.max_processing_ms,
      price_lovelace: BigInt(manifest.terms.price_lovelace), supplier_bond_lovelace: BigInt(manifest.terms.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(manifest.terms.buyer_bond_lovelace),
      endpoint_url: 'https://intake.example.test', detail_uri: 'https://intake.example.test/agent.json', detail_hash: sha256(text), advertised_at: T, status: 'Active',
    } as AdvertDatum;
    const plan = planFleetPostEscrow(advert, `${'cc'.repeat(32)}#0`, SERVICE.pkh, 'dd'.repeat(32), T);
    expect(plan.lockLovelace).toBe(4_000_000n);
    expect(plan.lockLovelace).toBe(BigInt(manifest.terms.price_lovelace + manifest.terms.supplier_bond_lovelace + manifest.terms.buyer_bond_lovelace));
    expect(plan.deliverBy).toBe(T + manifest.terms.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });

  test('GET /healthz is not held off by a job that runs, and the job slot is taken by the job alone', async () => {
    const world = makeWorld();
    const hold = world.holdModel();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(200);
      const pending = api.job();
      await hold.reached;
      expect((await api.request('GET', '/healthz')).json).toStrictEqual({ ok: true });
      hold.release();
      expect((await pending).status).toBe(200);
    });
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
      expect(reply.text).not.toContain(world.context.escrowRef);
      publish();
      await until(() => world.port.challenged.length === 1, 'the challenge is filed');
      expect(world.port.published).toHaveLength(1);
      expect(world.port.published[0]?.type).toBe('evidence');
      await until(() => world.logs.some((line) => line.startsWith('insurer intake agent: challenge filed')), 'the log has the challenge');
      const line = world.logs.find((entry) => entry.startsWith('insurer intake agent: challenge filed')) ?? '';
      expect(line).toContain(world.context.escrowRef);
      for (const reference of line.match(/[0-9a-f]{64}/g) ?? []) expect(reply.text).not.toContain(reference);
    });
  });

  test('the challenge runs in the queue of the service key, and its journal is on the state volume', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    await serve(world, async (api) => {
      expect((await api.precheck()).status).toBe(403);
      await until(() => world.port.challenged.length === 1, 'the challenge is filed');
      const dir = join(world.stateDir, 'dispute');
      // The journal writes a temporary file whose name starts with a dot, then renames it over the file of the job: read only the files of jobs, until one holds the challenge.
      const holds = (name: string): boolean => { try { return readFileSync(join(dir, name), 'utf8').includes(world.context.escrowRef); } catch { return false; } };
      const held = (): boolean => existsSync(dir) && readdirSync(dir).some((name) => !name.startsWith('.') && holds(name));
      await until(held, 'the journal on the state volume holds the challenge');
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
  const base = { manifestText: '{}', authHeader: TOKEN, jobDeps: () => { throw new Error('no job in this test'); }, clock: () => T, log: () => undefined };

  // A caller that ignores the types gives no hook, or one that is not a function: the server must refuse both. The casts stand for that caller.
  const noHook = { ...base } as unknown as ServerOptions;
  const wrongHook = { ...base, precheck: 'yes' } as unknown as ServerOptions;

  test('is never made with no hook: a service with no check would claim every escrow', () => {
    expect(() => createServer(noHook)).toThrow(/the hook of the Insurer Intake Agent is required/);
    expect(() => createServer(wrongHook)).toThrow(/the hook of the Insurer Intake Agent is required/);
    expect(createServer({ ...base, precheck: async () => ({ go: true }) })).toBeDefined();
  });

  test('is never made with no token', () => {
    expect(() => createServer({ ...base, authHeader: '', precheck: async () => ({ go: true }) })).toThrow(/authHeader/);
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
