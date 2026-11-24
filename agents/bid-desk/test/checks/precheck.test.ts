// agents/bid-desk/test/checks/precheck.test.ts: the hook of the Bid Desk, as the runtime asks it before it claims an escrow. A go is the answer only when the 7 checks passed, and then the record of the checks waits
// for the job with the hash of the request. A refusal is the status and the code of the protocol, and the escrow stays open. The question: does the hook ever give a go for a wrong sender, delegation or vault
// payment, or for a request that the book holds? Is the buyer key ever taken from the body? Does the hook read the record of the Bid Desk itself?
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient, Resolution } from '@vsa/id-kit/client';
import { ed25519Key } from '@vsa/id-kit/testing';
import { createJobServer } from '@vsa/service-kit';
import type { JobContext, PrecheckAnswer, Refusal } from '@vsa/service-kit';
import { SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { COUNTERPARTY_REFUSALS, ERROR_STATUS, canonicalSha256, isPlainObject, parseJsonText, parseRfq } from '@vsa/usecase-kit/protocol';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { FileRfqBook, HOOK_READS, MemoryRfqBook, PASSED_CHECKS_TTL_MS, PassedChecks, createPrecheck } from '../../src/checks/index.ts';
import type { PrecheckDeps, RfqBook } from '../../src/checks/index.ts';
import { QUOTE_SHA256, rfqOf } from './samples.ts';
import { PLAIN_ESCROW_REF, T, failing, makeWorld, withLedger } from './support.ts';
import type { World } from './support.ts';

const STRANGER = ed25519Key('bid desk test: a stranger').keyHash;
/** The seven checks that a go records, in the order of the page: the six shared checks of the kit for a bid desk, then the check of the Bid Desk. */
const CHECKS = ['sender_active', 'sender_accountable', 'sender_key', 'delegation', 'delegation_usable', 'vault_paid', 'not_duplicate'];

type Hook = (request: RfqMessage, context: JobContext) => Promise<PrecheckAnswer>;

interface RigOptions {
  readonly context?: JobContext;
  readonly ports?: ChecksPorts;
  readonly book?: RfqBook;
  readonly passed?: PrecheckDeps['passed'];
  readonly clock?: PrecheckDeps['clock'];
  readonly log?: PrecheckDeps['log'];
}

interface Rig {
  readonly world: World;
  readonly context: JobContext;
  readonly deps: PrecheckDeps;
  readonly hook: Hook;
  readonly book: RfqBook;
  readonly passed: PassedChecks;
  readonly logs: string[];
  /** The hook on the request and the context of the world. */
  run(): Promise<PrecheckAnswer>;
}

/** The hook over the world, with a book in memory, the real record of passed checks, a clock at the time of the checks, and a log that keeps its lines. */
function rigOf(world: World, over: RigOptions = {}): Rig {
  const logs: string[] = [];
  const book = over.book ?? new MemoryRfqBook();
  const passed = new PassedChecks();
  const deps: PrecheckDeps = {
    ports: over.ports ?? world.ports, book, passed: over.passed ?? passed, clock: over.clock ?? (() => T), log: over.log ?? ((line) => { logs.push(line); }),
  };
  const hook = createPrecheck(deps);
  const context = over.context ?? world.context;
  return { world, context, deps, hook, book, passed, logs, run: () => hook(world.rfq, context) };
}

/** The refusal of an answer: a test that expects a refusal fails when the answer is a go. */
function refusalOf(answer: PrecheckAnswer): { status: number; error: string; message: string } {
  if (answer.go) throw new Error('the hook gave a go');
  return { status: answer.status, error: answer.error, message: answer.message };
}

const hashOf = (request: RfqMessage): string => {
  const hash = canonicalSha256(request);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
};

describe('a request that passes every check', () => {
  it('gets { go: true }, and the record of passed checks holds the 7 checks with the hash of the request', async () => {
    const rig = rigOf(makeWorld());
    expect(await rig.run()).toEqual({ go: true });
    const entry = rig.passed.take(rig.context.escrowRef, T);
    if (entry === null) throw new Error('no record of the checks');
    expect(entry.request_sha256).toBe(hashOf(rig.world.rfq));
    expect(Object.keys(entry.record.checks)).toEqual(CHECKS);
    expect(Object.keys(entry.record.checks)).toEqual([...SHARED_CHECK_NAMES['bid-desk'], 'not_duplicate']);
    expect(Object.values(entry.record.checks).every((value) => value === true)).toBe(true);
    expect(entry.record.facts).toEqual({ organisation: 'buyer.example', organisation_verified: true });
    expect(rig.logs).toEqual([]);
  });

  it('holds the hash of the request as the job parses it, so the job finds the same hash for the same body', async () => {
    const rig = rigOf(makeWorld());
    await rig.run();
    const parsed = parseRfq(JSON.parse(JSON.stringify(rig.world.rfq)));
    if (!parsed.ok) throw new Error(parsed.detail);
    expect(rig.passed.take(rig.context.escrowRef, T)?.request_sha256).toBe(hashOf(parsed.value));
  });

  it('holds the hash of the body that it checked: two bodies that differ in a member of the request have two hashes', async () => {
    const world = makeWorld();
    const rig = rigOf(world);
    const other: RfqMessage = { ...world.rfq, rfq: rfqOf({ items: [{ sku: 'GLV-NIT-M', quantity: 99 }] }) };
    expect(await rig.hook(world.rfq, rig.context)).toEqual({ go: true });
    const first = rig.passed.take(rig.context.escrowRef, T)?.request_sha256;
    expect(await rig.hook(other, rig.context)).toEqual({ go: true });
    const second = rig.passed.take(rig.context.escrowRef, T)?.request_sha256;
    expect(first).toBe(hashOf(world.rfq));
    expect(second).toBe(hashOf(other));
    expect(first).not.toBe(second);
  });

  it('puts one record for each go, and the record of a refused request is none', async () => {
    const rig = rigOf(makeWorld({ organisation: null }));
    expect(refusalOf(await rig.run()).error).toBe('sender_unaccountable');
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });

  it('records nothing in the book: the job records the request after it gave the quote', async () => {
    const rig = rigOf(makeWorld());
    expect(await rig.run()).toEqual({ go: true });
    expect(await rig.book.has(rig.world.sender.did, 'run1-rfq-1')).toBe(false);
    // The same request gets a go again: nothing in the hook made it a duplicate.
    expect(await rig.run()).toEqual({ go: true });
  });

  it('is a rejection and never a go when the record cannot be put: the answer is a fault of the service', async () => {
    const rig = rigOf(makeWorld(), { passed: { put: () => { throw new Error('the store is broken'); } } });
    await expect(rig.run()).rejects.toThrow('the store is broken');
  });
});

describe('the 7 refusal codes of the hook', () => {
  const duplicate = async (): Promise<Rig> => {
    const rig = rigOf(makeWorld());
    await rig.book.record(rig.world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    return rig;
  };
  const CASES: Array<[string, () => Promise<Rig>]> = [
    ['sender_not_active', async () => { const w = makeWorld(); w.gateway.setStatus(w.sender, 'suspended'); return rigOf(w); }],
    ['sender_unaccountable', async () => rigOf(makeWorld({ organisation: null }))],
    ['sender_key_mismatch', async () => { const w = makeWorld(); return rigOf(w, { context: { ...w.context, buyerPkh: STRANGER } }); }],
    ['delegation_invalid', async () => rigOf(makeWorld({ delegation: { delegate: 'b7'.repeat(32) } }))],
    ['delegation_ended', async () => rigOf(makeWorld({ delegation: { notAfter: T - 1 } }))],
    ['not_vault_paid', async () => { const w = makeWorld(); return rigOf(w, { context: { ...w.context, escrowRef: PLAIN_ESCROW_REF } }); }],
    ['duplicate_rfq', duplicate],
  ];

  it('lists the codes of the page: every code of COUNTERPARTY_REFUSALS for the Bid Desk, and no code of an approval', () => {
    expect(CASES.map(([code]) => code)).toEqual([...COUNTERPARTY_REFUSALS['bid-desk']]);
    expect(CASES).toHaveLength(7);
  });

  it.each(CASES)('refuses with %s and its status, leaves no record, and the same request with no defect gets a go', async (code, refusing) => {
    const rig = await refusing();
    const refusal = refusalOf(await rig.run());
    expect(refusal.error).toBe(code);
    expect(refusal.status).toBe(ERROR_STATUS[code as keyof typeof ERROR_STATUS]);
    expect(refusal.status).toBe(403);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
    expect(await rigOf(makeWorld()).run()).toEqual({ go: true });
  });

  type Defect = 'status' | 'accountable' | 'key' | 'delegation' | 'ended' | 'vault' | 'duplicate';
  const ORDER: Defect[] = ['status', 'accountable', 'key', 'delegation', 'ended', 'vault', 'duplicate'];

  /** A world with each defect of the list and with no other. The order of the list is the order of the page. */
  async function withDefects(defects: readonly Defect[]): Promise<Rig> {
    const has = (defect: Defect): boolean => defects.includes(defect);
    const world = makeWorld({
      organisation: has('accountable') ? null : { domain: 'buyer.example', verified: true },
      delegation: { ...(has('delegation') ? { delegate: 'b7'.repeat(32) } : {}), ...(has('ended') ? { notAfter: T - 1 } : {}) },
    });
    if (has('status')) world.gateway.setStatus(world.sender, 'suspended');
    const rig = rigOf(world, { context: { ...world.context, ...(has('key') ? { buyerPkh: STRANGER } : {}), ...(has('vault') ? { escrowRef: PLAIN_ESCROW_REF } : {}) } });
    if (has('duplicate')) await rig.book.record(world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    return rig;
  }

  it('gives the codes in the order of the page, one defect fewer at a time, and then a go', async () => {
    const codes: string[] = [];
    for (let left = 0; left <= ORDER.length; left += 1) {
      const answer = await (await withDefects(ORDER.filter((_, index) => index >= left))).run();
      codes.push(answer.go ? 'go' : answer.error);
    }
    expect(codes.filter((_, index) => index < ORDER.length)).toEqual([...COUNTERPARTY_REFUSALS['bid-desk']]);
    expect(codes[ORDER.length]).toBe('go');
  });

  it('does not read the rfq book after an earlier refusal, and it reads it for a request that passes the six checks before it', async () => {
    const asked: string[] = [];
    const book: RfqBook = { has: async (sender, id) => { asked.push(`${sender}/${id}`); return false; }, record: async () => undefined };
    const refusing = rigOf(makeWorld({ organisation: null }), { book });
    expect(refusalOf(await refusing.run()).error).toBe('sender_unaccountable');
    expect(asked).toEqual([]);
    const passing = rigOf(makeWorld(), { book });
    expect(await passing.run()).toEqual({ go: true });
    expect(asked).toEqual([`${passing.world.sender.did}/run1-rfq-1`]);
  });

  it('keys the duplicate by the sender and the identifier: the same identifier for another sender, and another identifier for the same sender, get a go', async () => {
    const world = makeWorld();
    const rig = rigOf(world);
    await rig.book.record('did:vector:'.concat('f2'.repeat(32)), 'run1-rfq-1', QUOTE_SHA256);
    await rig.book.record(world.sender.did, 'RUN1-RFQ-1', QUOTE_SHA256);
    expect(await rig.run()).toEqual({ go: true });
    await rig.book.record(world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    expect(refusalOf(await rig.run()).error).toBe('duplicate_rfq');
  });
});

describe('the buyer key and the sender', () => {
  it('takes the buyer key from the job context and never from the body: a member of the body that looks like a buyer key is not read', async () => {
    const world = makeWorld();
    for (const name of ['buyer_pkh', 'buyerPkh', 'buyer_key', 'buyer', 'pkh']) {
      // The body names a key that is not the delegate key, and the context holds the right key: a go.
      const lying = { ...world.rfq, [name]: STRANGER } as unknown as RfqMessage;
      expect(await rigOf(world).hook(lying, world.context), name).toEqual({ go: true });
      // The twin: the context holds a key that is not the delegate key, and the body names the right key: a refusal.
      const wrong: JobContext = { ...world.context, buyerPkh: STRANGER };
      const naming = { ...world.rfq, [name]: world.delegateKey.keyHash } as unknown as RfqMessage;
      expect(refusalOf(await rigOf(world, { context: wrong }).hook(naming, wrong)).error, name).toBe('sender_key_mismatch');
    }
  });
});

describe('the record of the Bid Desk itself', () => {
  const PREFIX = '/1.0/identifiers/';
  /** What the stub gateway was asked for, in order: the DID of each resolution, and the path of any other request. */
  const askedFor = (world: World): string[] => world.gateway.requests.map((request) => (request.path.startsWith(PREFIX) ? request.path.substring(PREFIX.length) : request.path));

  /** A fetch that adds a pending recovery to the metadata of the record of one DID, as the gateway does while a recovery waits for its days. */
  function withRecovery(world: World, did: string): typeof fetch {
    return async (input, init) => {
      const reply = await world.gateway.fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith(`${PREFIX}${did}`)) return reply;
      const body: unknown = await reply.json();
      if (!isPlainObject(body) || !isPlainObject(body.didDocumentMetadata)) throw new Error('the answer of the stub is not a DID resolution result');
      const changed = { ...body, didDocumentMetadata: { ...body.didDocumentMetadata, vectorRecovery: { pendingNewController: 'c3'.repeat(28) } } };
      return new Response(JSON.stringify(changed), { status: reply.status, headers: reply.headers });
    };
  }

  const resolutionOf = async (client: Pick<GatewayClient, 'resolve'>, did: string): Promise<Resolution | null> => {
    const answer = await client.resolve(did);
    return answer.ok ? answer.value : null;
  };

  it('asks the gateway for the DID of the sender one time, and for nothing else', async () => {
    const world = makeWorld();
    expect(await rigOf(world).run()).toEqual({ go: true });
    expect(askedFor(world)).toEqual([world.sender.did]);
  });

  /** Each change of the record of the Bid Desk that the run of the lifecycle makes, with the gateway that the hook uses and the test that the resolution shows it. */
  const CHANGES: Array<[string, (world: World) => Pick<GatewayClient, 'resolve'>, (resolution: Resolution | null, world: World) => boolean]> = [
    ['a retired record', (w) => { w.gateway.setStatus(w.desk, 'retired'); return w.ports.gateway; }, (r) => r?.kind === 'deactivated' && r.effectiveStatus === 'retired'],
    ['a revoked record', (w) => { w.gateway.setStatus(w.desk, 'revoked'); return w.ports.gateway; }, (r) => r?.kind === 'deactivated' && r.effectiveStatus === 'revoked'],
    ['a suspended record', (w) => { w.gateway.setStatus(w.desk, 'suspended'); return w.ports.gateway; }, (r) => r?.kind === 'resolved' && r.effectiveStatus === 'suspended'],
    [
      'a key that the record does not list any more',
      (w) => { w.gateway.removeKey(w.desk, w.desk.delegation); return w.ports.gateway; },
      (r, w) => r?.kind === 'resolved' && !r.keys.some((key) => key.keyHash === w.desk.delegation.keyHash),
    ],
    [
      'a key with no purpose',
      (w) => { w.gateway.setPurposes(w.desk, w.desk.authentication, 0); return w.ports.gateway; },
      (r, w) => r?.kind === 'resolved' && r.keys.some((key) => key.keyHash === w.desk.authentication.keyHash && key.purposes.length === 0),
    ],
    [
      'a recovery that waits',
      (w) => createGatewayClient({ baseUrl: w.gateway.baseUrl, fetch: withRecovery(w, w.desk.did), now: w.gateway.now }),
      (r) => r?.kind === 'resolved' && isPlainObject(r.metadata.vectorRecovery),
    ],
    ['a gateway that fails for this DID', (w) => { w.gateway.fault(`${PREFIX}${w.desk.did}`, 'network'); return w.ports.gateway; }, (r) => r === null],
  ];

  it.each(CHANGES)('gives the same go and asks for the sender only when the Bid Desk has %s', async (_name, change, shows) => {
    const world = makeWorld();
    const gateway = change(world);
    const rig = rigOf(world, { ports: { ...world.ports, gateway } });
    expect(await rig.run()).toEqual({ go: true });
    expect(askedFor(world)).toEqual([world.sender.did]);
    expect(rig.passed.take(rig.context.escrowRef, T)?.request_sha256).toBe(hashOf(world.rfq));
    // The twin: a read of the record of the Bid Desk shows the change, so a hook that resolved it would have seen it.
    expect(shows(await resolutionOf(gateway, world.desk.did), world)).toBe(true);
  });
});

describe('the reads of the hook', () => {
  /** The ports of the world, each read recorded by name. */
  function counting(world: World): { ports: ChecksPorts; reads: string[] } {
    const reads: string[] = [];
    const real = world.ports;
    const ports: ChecksPorts = {
      ...real,
      gateway: { resolve: (did) => { reads.push('gateway'); return real.gateway.resolve(did); } },
      ledger: {
        hireResource: real.ledger.hireResource,
        readDelegation: (id) => { reads.push('delegation'); return real.ledger.readDelegation(id); },
        delegationUse: (id, at) => { reads.push('delegation use'); return real.ledger.delegationUse(id, at); },
        attestation: (id, at) => { reads.push('attestation'); return real.ledger.attestation(id, at); },
        escrowPaid: (ref, id) => { reads.push('vault payment'); return real.ledger.escrowPaid(ref, id); },
      },
    };
    return { ports, reads };
  }

  it('makes 4 timed reads for a go: the gateway one time, then the delegation, its use and the vault payment, and never the attestation', async () => {
    const world = makeWorld();
    const { ports, reads } = counting(world);
    expect(await rigOf(world, { ports }).run()).toEqual({ go: true });
    expect(reads).toEqual(['gateway', 'delegation', 'delegation use', 'vault payment']);
    expect(reads).toHaveLength(HOOK_READS);
    expect(HOOK_READS).toBe(4);
  });

  it('makes the 4 reads also for a request that the book holds, and not one more', async () => {
    const world = makeWorld();
    const { ports, reads } = counting(world);
    const rig = rigOf(world, { ports });
    await rig.book.record(world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    expect(refusalOf(await rig.run()).error).toBe('duplicate_rfq');
    expect(reads).toHaveLength(HOOK_READS);
  });

  it('stops reading at the first refusal: a sender that is not active costs one read, and a delegation that does not name the sender costs two', async () => {
    const inactive = makeWorld();
    inactive.gateway.setStatus(inactive.sender, 'suspended');
    const first = counting(inactive);
    expect(refusalOf(await rigOf(inactive, { ports: first.ports }).run()).error).toBe('sender_not_active');
    expect(first.reads).toEqual(['gateway']);
    const invalid = makeWorld({ delegation: { delegate: 'b7'.repeat(32) } });
    const second = counting(invalid);
    expect(refusalOf(await rigOf(invalid, { ports: second.ports }).run()).error).toBe('delegation_invalid');
    expect(second.reads).toEqual(['gateway', 'delegation']);
  });

  it('does not read the attestation: a ledger that cannot read it gives the same go', async () => {
    const world = makeWorld();
    expect(await rigOf(world, { ports: withLedger(world, { attestation: failing }) }).run()).toEqual({ go: true });
    expect(world.faults).toEqual([]);
  });
});

describe('the time of the hook', () => {
  /**
   * What one read costs in this test. The hook reads the gateway one time and the ledger three times, one after the other, and each read ends inside the budget that the caller gave it. The runtime waits 10
   * seconds, and the hook keeps 2 seconds of margin, so four reads share 8,000 ms: 2,000 ms for each read at most.
   */
  const READ_MS = 1_900;

  it('reads the gateway one time and the ledger three times, one after the other, then the rfq book: with 1,900 ms for a read it ends in 7,600 ms, and the record starts its time at the end', async () => {
    const world = makeWorld();
    const clock = { now: 0 };
    const reads: string[] = [];
    const timed = <V>(name: string, read: () => Promise<V>): Promise<V> => {
      reads.push(name);
      clock.now += READ_MS;
      return read();
    };
    const real = world.ports;
    const ports: ChecksPorts = {
      ...real,
      clock: () => T + clock.now,
      gateway: { resolve: (did) => timed('gateway', () => real.gateway.resolve(did)) },
      ledger: {
        hireResource: real.ledger.hireResource,
        readDelegation: (id) => timed('delegation', () => real.ledger.readDelegation(id)),
        delegationUse: (id, at) => timed('delegation use', () => real.ledger.delegationUse(id, at)),
        attestation: (id, at) => timed('attestation', () => real.ledger.attestation(id, at)),
        escrowPaid: (ref, id) => timed('vault payment', () => real.ledger.escrowPaid(ref, id)),
      },
    };
    const inner = new MemoryRfqBook();
    const book: RfqBook = { has: (sender, id) => { reads.push('book'); return inner.has(sender, id); }, record: (...args) => inner.record(...args) };
    const started = clock.now;
    const rig = rigOf(world, { ports, book, clock: () => T + clock.now });
    expect(await rig.run()).toEqual({ go: true });
    expect(reads).toEqual(['gateway', 'delegation', 'delegation use', 'vault payment', 'book']);
    const timedReads = reads.filter((name) => name !== 'book');
    expect(timedReads).toHaveLength(HOOK_READS);
    expect(clock.now - started).toBe(HOOK_READS * READ_MS);
    expect(clock.now - started).toBeLessThan(8_000);
    // The largest budget for a read is the share of one read in 8,000 ms.
    expect(Math.floor(8_000 / HOOK_READS)).toBe(2_000);
    // The record was put at the end of the hook: its time to live starts there.
    const end = T + HOOK_READS * READ_MS;
    expect(rig.passed.take(rig.context.escrowRef, end + PASSED_CHECKS_TTL_MS - 1)).not.toBeNull();
    rig.passed.put(rig.context.escrowRef, { record: { checks: {}, facts: {} }, request_sha256: QUOTE_SHA256 }, end);
    expect(rig.passed.take(rig.context.escrowRef, end + PASSED_CHECKS_TTL_MS)).toBeNull();
  });
});

describe('a source that cannot be read', () => {
  const unavailable = (answer: PrecheckAnswer, source: string): void => {
    expect(answer).toEqual({ go: false, status: 503, error: 'check_unavailable', message: `the ${source} could not be read` });
    expect(JSON.stringify(answer)).not.toContain('secret-token');
  };

  it('is 503 check_unavailable when the identity gateway fails, and the cause goes to the service and not to the buyer', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: failing } } });
    unavailable(await rig.run(), 'identity gateway');
    expect(world.faults.map(([source]) => source)).toEqual(['identity gateway']);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });

  it('is 503 check_unavailable when the gateway answers with no result', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: async () => ({ ok: false, rule: 'gateway.down', detail: 'key=secret-token-123' }) as never } } });
    unavailable(await rig.run(), 'identity gateway');
  });

  const READS: Array<[string, string, Partial<ChecksPorts['ledger']>]> = [
    ['delegation', 'delegation', { readDelegation: failing }],
    ['delegation use', 'delegation use', { delegationUse: failing }],
    ['vault payment', 'vault payment', { escrowPaid: failing }],
  ];
  it.each(READS)('is 503 check_unavailable when the read of the %s fails, and the same request with the read working gets a go', async (_name, source, ledger) => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: withLedger(world, ledger) });
    unavailable(await rig.run(), source);
    expect(world.faults.map(([name]) => name)).toEqual([source]);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
    expect(await rigOf(makeWorld()).run()).toEqual({ go: true });
  });

  it('is 503 check_unavailable when the rfq book fails, and the cause goes to the service', async () => {
    const world = makeWorld();
    const cause = new Error('EIO: the disk of /data/rfq-book.json failed, key=secret-token-123');
    const rig = rigOf(world, { book: { has: () => Promise.reject(cause), record: async () => undefined } });
    unavailable(await rig.run(), 'rfq book');
    expect(world.faults).toEqual([['rfq book', cause]]);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });

  it('is 503 check_unavailable when the rfq book answers with something that is not true or false', async () => {
    const world = makeWorld();
    const book = { has: () => Promise.resolve('false'), record: async () => undefined } as unknown as RfqBook;
    unavailable(await rigOf(world, { book }).run(), 'rfq book');
  });

  it('is 503 check_unavailable when the rfq book is a file that is damaged, and the file is not written over', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bid-desk-hook-'));
    try {
      const file = join(folder, 'rfq-book.json');
      const book = new FileRfqBook(file);
      writeFileSync(file, 'not json');
      unavailable(await rigOf(makeWorld(), { book }).run(), 'rfq book');
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('is 503 check_unavailable when the file of the book is deleted after the start, and a request that was answered is never a go', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'bid-desk-hook-'));
    try {
      const book = new FileRfqBook(join(folder, 'rfq-book.json'));
      const world = makeWorld();
      await book.record(world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
      // The twin: the book with its file refuses the request that it holds.
      expect(refusalOf(await rigOf(world, { book }).run()).error).toBe('duplicate_rfq');
      rmSync(join(folder, 'rfq-book.json'));
      const second = makeWorld();
      unavailable(await rigOf(second, { book }).run(), 'rfq book');
      expect(second.faults.map(([source]) => source)).toEqual(['rfq book']);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it('is never a refusal of a rule: a read that fails before the book is read gives 503 and not the code of a request that the book holds', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: withLedger(world, { escrowPaid: failing }) });
    await rig.book.record(world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    expect(refusalOf(await rig.run()).error).toBe('check_unavailable');
  });
});

describe('the clock and the log of the hook', () => {
  it('puts the record at the time of the clock of the hook, and not at the time of the clock of the ports', async () => {
    const later = T + 1_000_000;
    const rig = rigOf(makeWorld(), { clock: () => later });
    expect(await rig.run()).toEqual({ go: true });
    // The time to live of 300 seconds starts at `later`: the entry is there just before its end, and it was not put at T.
    expect(rig.passed.take(rig.context.escrowRef, later + PASSED_CHECKS_TTL_MS - 1)).not.toBeNull();
    const second = rigOf(makeWorld(), { clock: () => later });
    await second.run();
    expect(second.passed.take(second.context.escrowRef, later + PASSED_CHECKS_TTL_MS)).toBeNull();
  });

  it('is a rejection and never a go when the clock of the hook does not give a whole number of milliseconds', async () => {
    for (const bad of [Number.NaN, 1.5, -1, Number.POSITIVE_INFINITY]) {
      const rig = rigOf(makeWorld(), { clock: () => bad });
      await expect(rig.run(), String(bad)).rejects.toBeInstanceOf(TypeError);
      expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
    }
  });

  it('writes one line for each source that fails, with the kind of the cause, and never the message of the cause', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: failing } } });
    unavailableLine(await rig.run());
    expect(rig.logs).toEqual(['bid desk: the identity gateway failed (TypeError)']);
    expect(rig.logs.join('\n')).not.toContain('secret-token');
    const book = rigOf(makeWorld(), { book: { has: () => Promise.reject(new RangeError('the disk of /data/rfq-book.json failed, key=secret-token-123')), record: async () => undefined } });
    unavailableLine(await book.run());
    expect(book.logs).toEqual(['bid desk: the rfq book failed (RangeError)']);
    expect(book.logs.join('\n')).not.toContain('secret-token');
  });

  it('writes the kind of a cause that is not an error as its type', async () => {
    const rig = rigOf(makeWorld(), { book: { has: () => Promise.reject('secret-token-123'), record: async () => undefined } });
    unavailableLine(await rig.run());
    expect(rig.logs).toEqual(['bid desk: the rfq book failed (string)']);
  });

  it('writes no line for a go and none for a refusal of a rule', async () => {
    const passing = rigOf(makeWorld());
    await passing.run();
    const refusing = rigOf(makeWorld({ organisation: null }));
    await refusing.run();
    expect([passing.logs, refusing.logs]).toEqual([[], []]);
  });

  it('answers the same when the log fails, and the cause still goes to the ports', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: failing } }, log: () => { throw new Error('the log is closed'); } });
    unavailableLine(await rig.run());
    expect(world.faults.map(([source]) => source)).toEqual(['identity gateway']);
  });

  it('answers the same when the hook for faults of the ports fails', async () => {
    const world = makeWorld();
    const rig = rigOf(world, { ports: { ...world.ports, gateway: { resolve: failing }, onFault: () => { throw new Error('the hook is closed'); } } });
    unavailableLine(await rig.run());
    expect(rig.logs).toEqual(['bid desk: the identity gateway failed (TypeError)']);
  });

  it('works with ports that have no hook for faults', async () => {
    const world = makeWorld();
    const { onFault: _unused, ...bare } = world.ports;
    const rig = rigOf(world, { ports: { ...bare, gateway: { resolve: failing } } });
    unavailableLine(await rig.run());
    expect(rig.logs).toHaveLength(1);
    expect(await rigOf(world, { ports: bare }).run()).toEqual({ go: true });
  });

  function unavailableLine(answer: PrecheckAnswer): void {
    expect(refusalOf(answer)).toMatchObject({ status: 503, error: 'check_unavailable' });
  }
});

describe('a message that is not a request for quotation', () => {
  it('is a rejection and never a go, also when every shared check passes for it', async () => {
    const world = makeWorld();
    const rig = rigOf(world);
    const broken: RfqMessage = { ...world.rfq, rfq: rfqOf({ items: [] }) };
    await expect(rig.hook(broken, rig.context)).rejects.toBeInstanceOf(TypeError);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
    // The twin: the request of the samples gets a go.
    expect(await rig.hook(world.rfq, rig.context)).toEqual({ go: true });
  });

  it('is a rejection when the message has another schema, before any read', async () => {
    const world = makeWorld();
    const asked: string[] = [];
    const ports: ChecksPorts = { ...world.ports, gateway: { resolve: (did) => { asked.push(did); return world.ports.gateway.resolve(did); } } };
    const rig = rigOf(world, { ports });
    const other = { ...world.rfq, schema: 'vector.usecase.handoff.v1' } as unknown as RfqMessage;
    await expect(rig.hook(other, rig.context)).rejects.toBeInstanceOf(TypeError);
    expect(asked).toEqual([]);
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });
});

describe('the input of the hook', () => {
  it('is a TypeError when it is wrong, and it is checked before any request', () => {
    const { deps } = rigOf(makeWorld());
    expect(() => createPrecheck(deps)).not.toThrow();
    const noGateway: Record<string, unknown> = { ...deps.ports, gateway: {} };
    const noLedger: Record<string, unknown> = { ...deps.ports, ledger: null };
    const badHook: Record<string, unknown> = { ...deps.ports, onFault: 'yes' };
    const wrong: Array<Record<string, unknown>> = [
      { ...deps, ports: null }, { ...deps, ports: {} }, { ...deps, ports: noGateway }, { ...deps, ports: noLedger }, { ...deps, ports: badHook }, { ...deps, book: {} }, { ...deps, book: null },
      { ...deps, passed: {} }, { ...deps, passed: null }, { ...deps, clock: 'now' }, { ...deps, clock: undefined }, { ...deps, log: null }, { ...deps, log: undefined },
    ];
    for (const [index, bad] of wrong.entries()) expect(() => createPrecheck(bad as unknown as PrecheckDeps), String(index)).toThrow(TypeError);
    expect(() => createPrecheck(null as unknown as PrecheckDeps)).toThrow(TypeError);
  });
});

describe('inside createJobServer, as the runtime calls it', () => {
  const TOKEN = `Bearer ${'ab'.repeat(16)}`;

  class Bad extends Error {
    constructor(readonly refusal: Refusal) {
      super(refusal.message);
    }
  }
  const wire = (request: unknown): string => JSON.stringify([{ content: JSON.stringify(request), role: 'user' }]);
  const headers = (context: JobContext): Record<string, string> => ({
    authorization: TOKEN, 'x-vector-escrow-ref': context.escrowRef, 'x-vector-advert-ref': context.advertRef, 'x-vector-advert-model': context.advertModel, 'x-vector-buyer-pkh': context.buyerPkh,
    'x-vector-payment-lovelace': String(context.paymentLovelace), 'x-vector-deliver-by-ms': String(context.deliverByMs),
  });

  async function precheck(rig: Rig, body: RfqMessage = rig.world.rfq): Promise<{ status: number; body: unknown }> {
    const server: Server = createJobServer<RfqMessage, { done: true }>({
      manifestText: '{}', authHeader: TOKEN, clock: () => T, log: () => undefined,
      parse: (json) => {
        const text = parseJsonText(json);
        const message = text.ok ? parseRfq(text.value) : text;
        if (!message.ok) throw new Bad({ code: message.code, status: ERROR_STATUS[message.code], message: message.detail, kind: 'request' });
        return message.value;
      },
      run: async () => ({ done: true }), refusalOf: (error) => (error instanceof Bad ? error.refusal : null),
      precheck: rig.hook,
    });
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const reply = await fetch(`http://127.0.0.1:${port}/precheck`, { method: 'POST', body: wire(body), headers: headers(rig.context) });
      return { status: reply.status, body: await reply.json() };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  it('answers 200 with go for a request that passes, and the record waits for the job', async () => {
    const rig = rigOf(makeWorld());
    expect(await precheck(rig)).toEqual({ status: 200, body: { go: true, reserved_ms: 120000 } });
    expect(rig.passed.take(rig.context.escrowRef, T)?.request_sha256).toBe(hashOf(rig.world.rfq));
  });

  it('answers 403 with the code and the sentence of the check for a request that the book holds, and no go', async () => {
    const rig = rigOf(makeWorld());
    await rig.book.record(rig.world.sender.did, 'run1-rfq-1', QUOTE_SHA256);
    expect(await precheck(rig)).toEqual({ status: 403, body: { error: 'duplicate_rfq', message: 'the rfq book holds an answer to this request for quotation from this sender' } });
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });

  it('answers 403 with the code of a shared check, and the escrow stays open', async () => {
    const rig = rigOf(makeWorld({ delegation: { notAfter: T - 1 } }));
    const reply = await precheck(rig);
    expect(reply.status).toBe(403);
    expect(reply.body).toMatchObject({ error: 'delegation_ended' });
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
  });

  it('answers 500 and never a go when the request is not a request for quotation: a fault of the service', async () => {
    const world = makeWorld();
    const rig = rigOf(world);
    expect(await precheck(rig, { ...world.rfq, rfq: rfqOf({ items: [] }) })).toEqual({ status: 500, body: { error: 'internal' } });
    expect(rig.passed.take(rig.context.escrowRef, T)).toBeNull();
    // The twin: the request of the samples gets a go.
    expect(await precheck(rigOf(makeWorld()))).toEqual({ status: 200, body: { go: true, reserved_ms: 120000 } });
  });

  it('answers 503 for a read that failed, and never a go', async () => {
    const world = makeWorld();
    const reply = await precheck(rigOf(world, { ports: withLedger(world, { readDelegation: failing }) }));
    expect(reply.status).toBe(503);
    expect(reply.body).toMatchObject({ error: 'check_unavailable' });
    expect(JSON.stringify(reply.body)).not.toContain('secret-token');
  });
});
