// agents/document-pipeline/test/janitor.test.ts
// The janitor and its store. Every sub-escrow the Pipeline posts is written to the stranded store first and removed only once it is accepted, so an
// escrow a failed job leaves behind is still known after a restart. The janitor takes each one whose deliver_by is 5 s behind it: an Open or Claimed
// escrow is reclaimed (everything locked comes back); a Submitted one cannot be (the supplier may still be paid by its Release) and is kept, with
// the time from which the supplier may release it, until it is spent. Nothing is dropped on one read: `spent` and `unknown` must be read on two passes
// in a row (ruling R16, a lagging indexer reads like a spent output), `unknown` only once the Post can no longer land, and a read that fails keeps
// the entry. Runs against FakeChain, whose clock the test moves.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DELIVER_BY_BUFFER_MS, FakeChain, TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain, ChainEscrowState } from '@vsa/buyer-core';
import { runJanitorOnce, startJanitor, StrandedStore } from '../src/janitor.ts';
import type { JanitorChain, StrandedEntry } from '../src/janitor.ts';
import { OCR_ADVERT, OCR_ADVERT_REF, T0, WINDOW_MS } from './stub-suppliers.ts';

const PROMPT = 'ab'.repeat(32);
const RECEIPT_HASH = 'cd'.repeat(32);
const LOCK = FakeChain.LOCK_LOVELACE;
const FEE = FakeChain.FEE_LOVELACE;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'pipeline-janitor-')); dirs.push(dir); return dir; };

/** A FakeChain over the OCR advert with a clock the test moves, an empty store, and a Post that records its escrow the way the orchestrator does. */
function setup() {
  const clock = { now: T0 };
  const chain = new FakeChain({ adverts: { [OCR_ADVERT_REF]: OCR_ADVERT }, clock: () => clock.now, prefix: 'janitor-test/' });
  const store = new StrandedStore(stateDir());
  const post = async (): Promise<StrandedEntry> => {
    const posted = await chain.postEscrow({ advertRef: OCR_ADVERT_REF, promptHash: PROMPT });
    const entry: StrandedEntry = { escrow_ref: posted.escrowRef, deliver_by: posted.deliverBy, posted_at: posted.postedAt, kind: 'ocr' };
    store.add(entry);
    return entry;
  };
  /** One pass at `at`, with the chain's clock there too. */
  const passAt = (at: number, on: JanitorChain = chain) => { clock.now = at; return runJanitorOnce(store, on, at); };
  return { clock, chain, store, post, passAt };
}

/** `chain` with its escrowState answered by `states`, one per call, then by the chain itself. */
function readsAs(chain: FakeChain, ...states: Array<ChainEscrowState | Error>): JanitorChain {
  return {
    escrowState: async (ref) => {
      const next = states.shift();
      if (next instanceof Error) throw next;
      return next ?? chain.escrowState(ref);
    },
    reclaim: (ref) => chain.reclaim(ref),
    accept: (ref) => chain.accept(ref),
  };
}

describe('runJanitorOnce', () => {
  it('leaves an escrow alone until 5 s after its deliver_by, then reclaims an Open one and removes it', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    expect(entry.deliver_by).toBe(T0 + WINDOW_MS + DELIVER_BY_BUFFER_MS);
    const float = (await chain.wallet()).floatLovelace;
    expect(await passAt(entry.deliver_by + 4_999)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'waiting', note: `due at ${new Date(entry.deliver_by + 5_000).toISOString()}` }]);
    expect(store.list()).toStrictEqual([entry]);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('Open');
    const done = await passAt(entry.deliver_by + 5_000);
    expect(done).toMatchObject([{ escrow_ref: entry.escrow_ref, action: 'reclaimed' }]);
    expect(store.list()).toStrictEqual([]);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('spent');
    // Everything locked came back, less the fee of the Reclaim.
    expect((await chain.wallet()).floatLovelace).toBe(float + LOCK - FEE);
  });

  it('reclaims a Claimed escrow too: the supplier took the job and never submitted', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    chain.markClaimed(entry.escrow_ref);
    expect(await passAt(entry.deliver_by + 5_000)).toMatchObject([{ action: 'reclaimed' }]);
    expect(store.list()).toStrictEqual([]);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('spent');
  });

  it('keeps a Submitted escrow, noting when the supplier may release it, and drops it once it reads spent on two passes in a row', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    chain.markClaimed(entry.escrow_ref);
    chain.markSubmitted(entry.escrow_ref, RECEIPT_HASH);
    const lostAfter = entry.deliver_by + 600_000;
    expect(await passAt(entry.deliver_by + 5_000)).toStrictEqual([{
      escrow_ref: entry.escrow_ref, action: 'kept', note: `Submitted: it cannot be reclaimed, and its supplier may release it from ${new Date(lostAfter).toISOString()} at the latest`,
    }]);
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: lostAfter }]);
    expect(await passAt(lostAfter + 1)).toMatchObject([{ action: 'kept' }]);
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: lostAfter }]);
    // FakeChain has no Release; an Accept spends the escrow the same way, which is all the janitor sees.
    await chain.accept(entry.escrow_ref);
    expect(await passAt(lostAfter + 2)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'kept', note: 'spent (first read): read again on the next pass before it is dropped' }]);
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: lostAfter, gone_reads: 1 }]);
    expect(await passAt(lostAfter + 3)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'dropped', note: 'spent on two passes in a row' }]);
    expect(store.list()).toStrictEqual([]);
  });

  it('starts the count of spent reads again when a read in between finds the escrow live (ruling R16: a lagging indexer reads like spent)', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    chain.markClaimed(entry.escrow_ref);
    chain.markSubmitted(entry.escrow_ref, RECEIPT_HASH);
    const at = entry.deliver_by + 5_000;
    const lagging = readsAs(chain, 'spent', 'Submitted', 'spent');
    await passAt(at, lagging);
    expect(store.list()[0].gone_reads).toBe(1);
    await passAt(at + 1, lagging);
    expect(store.list()[0].gone_reads).toBeUndefined();
    expect(await passAt(at + 2, lagging)).toMatchObject([{ action: 'kept' }]);
    expect(store.list()).toHaveLength(1);
  });

  it('starts the count again on a live read whose Reclaim fails, too', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    const at = entry.deliver_by + 5_000;
    const reads: Array<ChainEscrowState | Error> = ['spent', 'Open', 'spent'];
    const flaky: JanitorChain = { escrowState: async (ref) => { const next = reads.shift(); if (next instanceof Error) throw next; return next ?? chain.escrowState(ref); }, reclaim: async () => { throw new Error('no node'); }, accept: (ref) => chain.accept(ref) };
    await passAt(at, flaky);
    expect(store.list()[0].gone_reads).toBe(1);
    expect(await passAt(at + 1, flaky)).toMatchObject([{ action: 'kept', note: 'Open: the Reclaim failed (no node)' }]);
    expect(store.list()[0].gone_reads).toBeUndefined();
    expect(await passAt(at + 2, flaky)).toMatchObject([{ action: 'kept' }]);
    expect(store.list()).toHaveLength(1);
  });

  it('keeps an entry whose state cannot be read, unchanged (a throw is keep)', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    const failing = readsAs(chain, new Error('Could not read escrow: Koios answered 503'), new Error('Could not read escrow: Koios answered 503'));
    expect(await passAt(entry.deliver_by + 5_000, failing)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'kept', note: 'its state could not be read (Could not read escrow: Koios answered 503)' }]);
    expect(await passAt(entry.deliver_by + 6_000, failing)).toMatchObject([{ action: 'kept' }]);
    expect(store.list()).toStrictEqual([entry]);
    // Once it can be read it is reclaimed.
    expect(await passAt(entry.deliver_by + 7_000, failing)).toMatchObject([{ action: 'reclaimed' }]);
  });

  it('keeps an entry whose Reclaim fails, for the next pass', async () => {
    const { chain, store, post, passAt } = setup();
    const entry = await post();
    const refusing: JanitorChain = { escrowState: (ref) => chain.escrowState(ref), reclaim: async () => { throw new Error('The Reclaim was refused'); }, accept: (ref) => chain.accept(ref) };
    expect(await passAt(entry.deliver_by + 5_000, refusing)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'kept', note: 'Open: the Reclaim failed (The Reclaim was refused)' }]);
    expect(store.list()).toStrictEqual([entry]);
    expect(await passAt(entry.deliver_by + 65_000)).toMatchObject([{ action: 'reclaimed' }]);
  });

  it('drops a Post that never landed only after its validity has ended and two passes read nothing at the ref (ruling R16)', async () => {
    const { store, passAt } = setup();
    // A Post that was signed and may have landed: what the orchestrator records from a TxNotConfirmedError. FakeChain never saw it, so it reads unknown.
    const ref = `${'ee'.repeat(32)}#0`;
    const deliverBy = T0 + WINDOW_MS + DELIVER_BY_BUFFER_MS;
    const entry: StrandedEntry = { escrow_ref: ref, deliver_by: deliverBy, posted_at: T0, kind: 'llm', valid_to: deliverBy + 60_000 };
    store.add(entry);
    // Past deliver_by but before valid_to (only a test can make it so: a real Post's validity ends before its deliver_by): the read does not count.
    expect(await passAt(deliverBy + 5_000)).toStrictEqual([{ escrow_ref: ref, action: 'kept', note: `unknown: the Post may still land until ${new Date(deliverBy + 60_000).toISOString()}` }]);
    expect(store.list()).toStrictEqual([entry]);
    expect(await passAt(deliverBy + 60_000)).toStrictEqual([{ escrow_ref: ref, action: 'kept', note: 'unknown (first read): read again on the next pass before it is dropped' }]);
    expect(await passAt(deliverBy + 120_000)).toStrictEqual([{ escrow_ref: ref, action: 'dropped', note: 'unknown on two passes in a row' }]);
    expect(store.list()).toStrictEqual([]);
  });

  it('reclaims a Post that did land after all, though the orchestrator never saw it confirmed', async () => {
    const { store, post, passAt } = setup();
    const entry = await post();
    store.update(entry.escrow_ref, { valid_to: entry.posted_at + DELIVER_BY_BUFFER_MS });
    expect(await passAt(entry.deliver_by + 5_000)).toMatchObject([{ action: 'reclaimed' }]);
    expect(store.list()).toStrictEqual([]);
  });

  it('looks at every entry of the store in one pass', async () => {
    const { chain, store, post, passAt } = setup();
    const first = await post();
    const second = await post();
    chain.markClaimed(second.escrow_ref);
    chain.markSubmitted(second.escrow_ref, RECEIPT_HASH);
    const actions = await passAt(second.deliver_by + 5_000);
    expect(actions.map((a) => [a.escrow_ref, a.action])).toStrictEqual([[first.escrow_ref, 'reclaimed'], [second.escrow_ref, 'kept']]);
    expect(store.list().map((e) => e.escrow_ref)).toStrictEqual([second.escrow_ref]);
  });
});

// The run's Accept was signed and submitted but not seen confirmed, and may still land (ruling R33): the run kept its result and left the escrow here,
// marked. The janitor looks at it at once. Spent (on two passes) is the Accept that landed. Submitted while the Accept may still land is waited for.
// Submitted once it can no longer land: one more Accept while the accept window is still open, bounded here by posted_at + 600 s (the Chain gives no
// submitted_at, and the Submit came after the Post); otherwise, or when the run's Accept was already followed by the janitor's, the escrow is lost.
describe('runJanitorOnce: an Accept the run could not see confirmed (ruling R33)', () => {
  const TX = 'ac'.repeat(32);
  const TX2 = 'ad'.repeat(32);
  /** A Submitted escrow whose Accept, valid until `validTo`, the run saw neither land nor fail. */
  async function pendingAccept(validTo: number) {
    const s = setup();
    const entry = await s.post();
    s.chain.markClaimed(entry.escrow_ref);
    s.chain.markSubmitted(entry.escrow_ref, RECEIPT_HASH);
    s.store.update(entry.escrow_ref, { accept_pending: { tx_hash: TX, valid_to: validTo, by: 'run' } });
    let accepts = 0;
    const counted = (accept: JanitorChain['accept']): JanitorChain => ({ escrowState: (r) => s.chain.escrowState(r), reclaim: (r) => s.chain.reclaim(r), accept: (r) => { accepts += 1; return accept(r); } });
    return { ...s, entry, counted, accepts: () => accepts };
  }

  it('is looked at at once, not from deliver_by, and kept while its Accept may still land', async () => {
    const { chain, store, entry, passAt } = await pendingAccept(T0 + 60_000);
    expect(await passAt(T0 + 10_000)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'kept', note: `Submitted: its Accept ${TX} may still land until ${new Date(T0 + 60_000).toISOString()}` }]);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('Submitted');
    expect(store.list()).toHaveLength(1);
  });

  it('is dropped once its Accept landed: spent on two passes in a row', async () => {
    const { chain, store, entry, passAt } = await pendingAccept(T0 + 60_000);
    await chain.accept(entry.escrow_ref);
    expect(await passAt(T0 + 10_000)).toMatchObject([{ action: 'kept', note: 'spent (first read): read again on the next pass before it is dropped' }]);
    expect(await passAt(T0 + 20_000)).toMatchObject([{ action: 'dropped', note: 'spent on two passes in a row' }]);
    expect(store.list()).toStrictEqual([]);
  });

  it('is accepted once more when its Accept can no longer land and the window is still open, and removed once that Accept is confirmed', async () => {
    const { chain, store, entry, passAt, counted, accepts } = await pendingAccept(T0 + 60_000);
    let made = '';
    const on = counted(async (r) => { const accepted = await chain.accept(r); made = accepted.txHash; return accepted; });
    // At validTo itself the Accept can no longer land: a transaction lands only in the slots before the end of its validity.
    expect(await passAt(T0 + 60_000, on)).toStrictEqual([{
      escrow_ref: entry.escrow_ref, action: 'accepted', note: `Submitted: its Accept ${TX} did not land by ${new Date(T0 + 60_000).toISOString()}; accepted again in ${made}`,
    }]);
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(accepts()).toBe(1);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('spent');
    expect(store.list()).toStrictEqual([]);
  });

  it('is recorded as lost when its Accept can no longer land and posted_at + 600 s has passed: no Accept is made', async () => {
    const { chain, store, entry, passAt, counted, accepts } = await pendingAccept(T0 + 60_000);
    const on = counted((r) => chain.accept(r));
    const lostAfter = entry.deliver_by + 600_000;
    expect(await passAt(T0 + 600_000, on)).toStrictEqual([{
      escrow_ref: entry.escrow_ref, action: 'kept', note: `Submitted: its Accept ${TX} did not land by ${new Date(T0 + 60_000).toISOString()} and the accept window may be over; lost to its supplier's release from ${new Date(lostAfter).toISOString()} at the latest`,
    }]);
    expect(accepts()).toBe(0);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('Submitted');
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: lostAfter }]);
  });

  it('makes one more Accept and no more: when that one may land too, it is waited for, and if it does not land the escrow is lost', async () => {
    const { chain, store, entry, passAt, counted, accepts } = await pendingAccept(T0 + 60_000);
    const notSeen = new TxNotConfirmedError(`The Accept ${TX2} of escrow ${entry.escrow_ref} was submitted, but Koios did not report it confirmed.`, {
      txHash: TX2, escrowRef: entry.escrow_ref, deliverBy: null, validTo: T0 + 120_000, mayLand: true,
    });
    const on = counted(async () => { throw notSeen; });
    expect(await passAt(T0 + 60_001, on)).toMatchObject([{ action: 'kept', note: `Submitted: its Accept ${TX} did not land by ${new Date(T0 + 60_000).toISOString()}; accepted again in ${TX2}, which may land until ${new Date(T0 + 120_000).toISOString()}` }]);
    expect(store.list()).toStrictEqual([{ ...entry, accept_pending: { tx_hash: TX2, valid_to: T0 + 120_000, by: 'janitor' } }]);
    expect(await passAt(T0 + 90_000, on)).toMatchObject([{ action: 'kept', note: `Submitted: its Accept ${TX2} may still land until ${new Date(T0 + 120_000).toISOString()}` }]);
    expect(await passAt(T0 + 120_000, on)).toMatchObject([{ action: 'kept', note: expect.stringMatching(/did not land .* lost to its supplier's release/) }]);
    expect(accepts()).toBe(1);
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: entry.deliver_by + 600_000 }]);
  });

  it('records the escrow as lost when the one more Accept fails outright', async () => {
    const { store, entry, passAt, counted, accepts } = await pendingAccept(T0 + 60_000);
    const on = counted(async () => { throw new Error('Accept window closed'); });
    expect(await passAt(T0 + 60_000, on)).toMatchObject([{ action: 'kept', note: expect.stringMatching(/the Accept could not be made again \(Accept window closed\); lost to its supplier's release/) }]);
    expect(accepts()).toBe(1);
    expect(store.list()).toStrictEqual([{ ...entry, lost_to_release_after: entry.deliver_by + 600_000 }]);
  });

  it('reads Open or Claimed for an escrow it accepted as an indexer that lags the Submit: kept as it is until deliver_by + 5 s', async () => {
    const { chain, store, entry, passAt } = await pendingAccept(T0 + 60_000);
    const lagging = readsAs(chain, 'Claimed', 'Open');
    expect(await passAt(T0 + 30_000, lagging)).toMatchObject([{ action: 'kept', note: 'Claimed: an escrow whose Accept was sent reads Claimed while the indexer lags its Submit; read again on the next pass' }]);
    // The Accept can no longer land, but deliver_by + 5 s has not come: still kept.
    expect(await passAt(entry.deliver_by + 4_999, lagging)).toMatchObject([{ action: 'kept', note: 'Open: an escrow whose Accept was sent reads Open while the indexer lags its Submit; read again on the next pass' }]);
    expect(store.list()).toStrictEqual([{ ...entry, accept_pending: { tx_hash: TX, valid_to: T0 + 60_000, by: 'run' } }]);
    expect(await chain.escrowState(entry.escrow_ref)).toBe('Submitted');
  });

  it('falls back to the rule of any entry once its Accept can no longer land and deliver_by + 5 s has passed: an Open or Claimed escrow is reclaimed', async () => {
    const s = setup();
    const entry = await s.post();
    s.chain.markClaimed(entry.escrow_ref);
    s.store.update(entry.escrow_ref, { accept_pending: { tx_hash: TX, valid_to: entry.deliver_by + 60_000, by: 'run' } });
    // Past deliver_by + 5 s, but the Accept may still land: kept.
    expect(await s.passAt(entry.deliver_by + 5_000)).toMatchObject([{ action: 'kept', note: expect.stringMatching(/^Claimed: an escrow whose Accept was sent/) }]);
    expect(await s.chain.escrowState(entry.escrow_ref)).toBe('Claimed');
    // Both passed: the Reclaim of the normal rule.
    expect(await s.passAt(entry.deliver_by + 60_000)).toMatchObject([{ action: 'reclaimed', note: expect.stringMatching(/^Claimed: the Reclaim [0-9a-f]{64} returned everything it locked$/) }]);
    expect(await s.chain.escrowState(entry.escrow_ref)).toBe('spent');
    expect(s.store.list()).toStrictEqual([]);
  });

  it('keeps a marked entry whose fallback Reclaim fails, for the next pass', async () => {
    const s = setup();
    const entry = await s.post();
    s.store.update(entry.escrow_ref, { accept_pending: { tx_hash: TX, valid_to: T0, by: 'run' } });
    const refusing: JanitorChain = { escrowState: (r) => s.chain.escrowState(r), reclaim: async () => { throw new Error('The Reclaim was refused'); }, accept: (r) => s.chain.accept(r) };
    expect(await s.passAt(entry.deliver_by + 5_000, refusing)).toStrictEqual([{ escrow_ref: entry.escrow_ref, action: 'kept', note: 'Open: the Reclaim failed (The Reclaim was refused)' }]);
    expect(s.store.list()).toHaveLength(1);
  });
});

describe('StrandedStore', () => {
  const entry: StrandedEntry = { escrow_ref: `${'ab'.repeat(32)}#0`, deliver_by: T0 + 480_000, posted_at: T0, kind: 'ocr' };

  it('survives a reload: a new store on the same directory has the same entries, with what the janitor noted', () => {
    const dir = stateDir();
    const store = new StrandedStore(dir);
    expect(store.file).toBe(join(dir, 'stranded.json'));
    store.add(entry);
    store.add({ escrow_ref: `${'cd'.repeat(32)}#1`, deliver_by: T0 + 500_000, posted_at: T0 + 20_000, kind: 'llm', valid_to: T0 + 200_000 });
    store.update(entry.escrow_ref, { lost_to_release_after: T0 + 1_080_000, gone_reads: 1 });
    const reloaded = new StrandedStore(dir);
    expect(reloaded.list()).toStrictEqual(store.list());
    expect(reloaded.list()).toStrictEqual([
      { ...entry, lost_to_release_after: T0 + 1_080_000, gone_reads: 1 },
      { escrow_ref: `${'cd'.repeat(32)}#1`, deliver_by: T0 + 500_000, posted_at: T0 + 20_000, kind: 'llm', valid_to: T0 + 200_000 },
    ]);
    reloaded.remove(entry.escrow_ref);
    expect(new StrandedStore(dir).list().map((e) => e.escrow_ref)).toStrictEqual([`${'cd'.repeat(32)}#1`]);
  });

  it('starts empty in a new directory, which it creates, and writes nothing until there is something to write', () => {
    const dir = join(stateDir(), 'state', 'pipeline');
    const store = new StrandedStore(dir);
    expect(store.list()).toStrictEqual([]);
    expect(readdirSync(dir)).toStrictEqual([]);
  });

  it('writes the file whole through a rename: it is always a JSON list, and no temporary file is left behind', () => {
    const dir = stateDir();
    const store = new StrandedStore(dir);
    store.add(entry);
    expect(JSON.parse(readFileSync(store.file, 'utf8'))).toStrictEqual([entry]);
    store.remove(entry.escrow_ref);
    expect(JSON.parse(readFileSync(store.file, 'utf8'))).toStrictEqual([]);
    expect(readdirSync(dir)).toStrictEqual(['stranded.json']);
  });

  it('keeps refs in their canonical spelling, so an entry is found however its ref is written', () => {
    const store = new StrandedStore(stateDir());
    store.add({ ...entry, escrow_ref: `${'AB'.repeat(32)}#0` });
    expect(store.list()[0].escrow_ref).toBe(entry.escrow_ref);
    expect(store.get(` ${'Ab'.repeat(32)}#0 `)).toStrictEqual(entry);
    store.remove(`${'AB'.repeat(32)}#0`);
    expect(store.list()).toStrictEqual([]);
  });

  it('ignores an update or a removal of an entry that is not there (the orchestrator may have accepted it while a pass was reading)', () => {
    const store = new StrandedStore(stateDir());
    store.update(entry.escrow_ref, { gone_reads: 1 });
    store.remove(entry.escrow_ref);
    expect(store.list()).toStrictEqual([]);
  });

  it('refuses a file that is not a list of entries, rather than start empty and forget escrows that hold funds', () => {
    for (const text of ['not json', '{"entries":[]}', '[{"escrow_ref":"x#0","deliver_by":1,"posted_at":1,"kind":"ocr"}]', `[{"escrow_ref":"${'ab'.repeat(32)}#0","deliver_by":"soon","posted_at":1,"kind":"ocr"}]`, `[{"escrow_ref":"${'ab'.repeat(32)}#0","deliver_by":1,"posted_at":1,"kind":"tts"}]`]) {
      const dir = stateDir();
      writeFileSync(join(dir, 'stranded.json'), text);
      expect(() => new StrandedStore(dir), text).toThrow(/stranded\.json/);
    }
  });

  it('refuses an entry that cannot be written back: a malformed ref or a time that is not a whole number', () => {
    const store = new StrandedStore(stateDir());
    expect(() => store.add({ ...entry, escrow_ref: 'not-a-ref' })).toThrow(/Invalid out ref/);
    expect(() => store.add({ ...entry, deliver_by: Number.NaN })).toThrow(/deliver_by/);
    expect(store.list()).toStrictEqual([]);
  });

  it('refuses a field it does not know, on add and in the file, instead of dropping it: a marker it dropped could cost an escrow', () => {
    const store = new StrandedStore(stateDir());
    expect(() => store.add({ ...entry, note: 'x' } as StrandedEntry)).toThrow(/unknown field "note"/);
    expect(() => store.add({ ...entry, accept_pending: { tx_hash: 'ac'.repeat(32), valid_to: T0, by: 'run', extra: 1 } } as StrandedEntry)).toThrow(/unknown field "extra"/);
    expect(store.list()).toStrictEqual([]);
    const dir = stateDir();
    writeFileSync(join(dir, 'stranded.json'), JSON.stringify([{ ...entry, retries: 2 }]));
    expect(() => new StrandedStore(dir)).toThrow(/stranded\.json is not a list of stranded escrows \(unknown field "retries"/);
  });

  it('keeps the marker of an Accept that may land, and refuses one that is malformed', () => {
    const dir = stateDir();
    const store = new StrandedStore(dir);
    const marker = { tx_hash: 'ac'.repeat(32), valid_to: T0 + 606_000, by: 'run' as const };
    store.add({ ...entry, accept_pending: marker });
    expect(new StrandedStore(dir).list()).toStrictEqual([{ ...entry, accept_pending: marker }]);
    for (const bad of [{ ...marker, tx_hash: 'xyz' }, { ...marker, valid_to: 1.5 }, { ...marker, by: 'someone' }, { tx_hash: marker.tx_hash, by: 'run' }]) {
      expect(() => store.add({ ...entry, accept_pending: bad } as StrandedEntry), JSON.stringify(bad)).toThrow(/accept_pending/);
    }
  });
});

describe('startJanitor', () => {
  it('runs a pass at once and then one every interval, logs what it did, and stops', async () => {
    const { chain, store, post, clock } = setup();
    const entry = await post();
    clock.now = entry.deliver_by + 5_000;
    const lines: string[] = [];
    const janitor = startJanitor(store, chain, 5, { clock: () => clock.now, log: (line) => lines.push(line) });
    await expect.poll(() => store.list().length).toBe(0);
    // A second escrow, posted while the janitor runs, is picked up by a later pass.
    const second = await post();
    clock.now = second.deliver_by + 5_000;
    await expect.poll(() => store.list().length).toBe(0);
    await janitor.stop();
    expect(lines).toStrictEqual([
      expect.stringMatching(new RegExp(`^janitor: reclaimed ${entry.escrow_ref}: `)),
      expect.stringMatching(new RegExp(`^janitor: reclaimed ${second.escrow_ref}: `)),
    ]);
  });

  it('logs an escrow it could not reclaim and tries again on the next pass', async () => {
    const { store, post, clock } = setup();
    const entry = await post();
    clock.now = entry.deliver_by + 5_000;
    const lines: string[] = [];
    let calls = 0;
    const broken: JanitorChain = { escrowState: async () => { calls += 1; return 'Open'; }, reclaim: async () => { throw new Error('no node'); }, accept: async () => { throw new Error('no node'); } };
    const janitor = startJanitor(store, broken, 5, { clock: () => clock.now, log: (line) => lines.push(line) });
    await expect.poll(() => calls).toBeGreaterThanOrEqual(2);
    await janitor.stop();
    expect(lines[0]).toBe(`janitor: kept ${entry.escrow_ref}: Open: the Reclaim failed (no node)`);
    expect(store.list()).toHaveLength(1);
  });

  it('logs a pass that throws and runs the next one', async () => {
    const { chain, store, post, clock } = setup();
    const entry = await post();
    chain.markClaimed(entry.escrow_ref);
    chain.markSubmitted(entry.escrow_ref, RECEIPT_HASH);
    clock.now = entry.deliver_by + 5_000;
    const lines: string[] = [];
    let writes = 0;
    store.update = () => { writes += 1; throw new Error('disk full'); };
    const janitor = startJanitor(store, chain, 5, { clock: () => clock.now, log: (line) => lines.push(line) });
    await expect.poll(() => writes).toBeGreaterThanOrEqual(2);
    await janitor.stop();
    expect(lines[0]).toBe('janitor: the pass failed (disk full)');
  });

  it('refuses an interval that is not a positive number of milliseconds', () => {
    const { store, chain } = setup();
    for (const interval of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => startJanitor(store, chain, interval)).toThrow(/interval/);
  });
});
