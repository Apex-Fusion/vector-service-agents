// packages/hire-kit/test/facts.test.ts
// The facts of every throw site of src/hire.ts: what each error of a hire tells the caller's factory besides its words (HireFacts), the stage the hire was
// at, the escrow, the state of the escrow as the phase of the site last read it, and whether the job was handed over. A service that falls back reads them
// (agents/advocate/src/inference.ts logs the stage of a hire that failed and names its escrow in the detail, and falls back or not by the code), so every site
// is driven here on the FakeChain and the chat supplier of test/stub-suppliers.ts, with a clock the test owns and a sleep that moves it, one row of the table
// or more each, and held to the facts it gives. src/hire.ts makes its errors at 27 sites: 18 failures, 6 deadlines and 3 writes of the stranded store
// (the closure that fails a receipt is one site with two throws, and both are driven). The last test counts them in the source, so that a site added there
// needs its row here. A row names its site, and shows that the site threw by the code the factory was asked for and words of the kit that only that site
// writes. The state of a fact is the last one its phase read, which can be the read of an earlier step of the same phase: the rows of a send and of a poll
// that read none, one at the throw, and one many steps before it show each case.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TxNotConfirmedError } from '@vsa/buyer-core';
import type { Chain } from '@vsa/buyer-core';
import { chatJob, hireOne } from '../src/hire.ts';
import type { HireDeps, HireErrors, HireFacts, HireLedger, HireOptions, HireSupplier } from '../src/hire.ts';
import { StrandedStore } from '../src/janitor.ts';
import { LLM_ADVERT, LLM_ADVERT_REF, LLM_ENDPOINT, LLM_KEY, T0, WINDOW_MS, chainWith, escrowNo, marketplace } from './stub-suppliers.ts';
import type { Marketplace } from './stub-suppliers.ts';

const INPUT = 'Answer in one sentence: what does a bonded escrow hold?';
/** The chat supplier as chooseChatSupplier gives it for the advert of the stub. */
const SUPPLIER: HireSupplier = {
  hop: 'llm', advertRef: LLM_ADVERT_REF, advert: LLM_ADVERT, capabilityId: LLM_ADVERT.capability_id, model: LLM_ADVERT.model, endpoint: LLM_ENDPOINT,
  pubKeyHex: LLM_KEY.pubKeyHex, windowMs: LLM_ADVERT.max_processing_ms,
};
/** The escrow of the first Post, its deliver_by, and the last moment a send of its job may start, 90 s before that. */
const REF = escrowNo(1);
const DELIVER_BY = T0 + WINDOW_MS + 180_000;
const SEND_UNTIL = DELIVER_BY - 90_000;
/** The deadline of a hire whose row does not set one, after T0: past every limit of a hire on the stub's adverts, so that a limit of the kit ends the hire. */
const FAR = 1_000_000;
/** The escrow of a Post that was signed and not seen confirmed, and the error of that Post: refused by the submit API, or one that may still land. */
const LOST = `${'ee'.repeat(32)}#0`;
const notConfirmed = (mayLand: boolean): TxNotConfirmedError => new TxNotConfirmedError('The Post was submitted, but Koios did not report it confirmed.', {
  txHash: 'ee'.repeat(32), escrowRef: LOST, deliverBy: DELIVER_BY, validTo: T0 + 180_000, mayLand,
});
const unseenAccept = (ref: string): TxNotConfirmedError => new TxNotConfirmedError('The Accept was submitted, but Koios did not report it confirmed.', {
  txHash: 'ac'.repeat(32), escrowRef: ref, deliverBy: null, validTo: T0 + 606_000, mayLand: true,
});

/** What the factory was asked for: the code (<hop>_<what>, deadline or store_write_failed), the kit's words (its message, or what the hire was doing), and the facts. */
class Asked extends Error {
  readonly code: string;
  readonly words: string;
  readonly facts: HireFacts;
  constructor(code: string, words: string, facts: HireFacts) {
    super(code);
    this.name = 'Asked';
    this.code = code;
    this.words = words;
    this.facts = facts;
  }
}
const ASKED: HireErrors<Asked> = {
  failure: (kind, what, message, facts) => new Asked(`${kind}_${what}`, message, facts),
  deadline: (doing, facts) => new Asked('deadline', doing, facts),
  storeWrite: (message, facts) => new Asked('store_write_failed', message, facts),
};
const UNCOUNTED: HireLedger = { posted: () => undefined, accepted: () => undefined };

// --- The harness -------------------------------------------------------------------------------------------------------------------
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A marketplace at T0, and an empty stranded store in a directory of its own. */
interface Run { m: Marketplace; stranded: StrandedStore }
/** What a row changes of the hire: the chain it is given, the fetch of its chat job (the stub's, with something done first), its options. */
interface Arranged { chain?: Chain; fetchImpl?: typeof fetch; options?: HireOptions }
interface Row {
  /** The throw site of src/hire.ts, in words: rows that drive the same site give it the same words. */
  site: string;
  /** What drives the hire there. */
  how: string;
  /** The deadline of the hire after T0; FAR when absent. */
  deadlineMs?: number;
  arrange: (run: Run) => Arranged | undefined;
  /** The code the factory is asked for, and words of the kit that only this site writes. */
  code: string;
  words: string;
  facts: HireFacts;
}

/** The stub's fetch, with `first` done as each send of the chat job comes, before the supplier answers it. */
const beforeEachSend = (m: Marketplace, first: (escrowRef: string) => void): typeof fetch => (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  if (init.method === 'POST' && new URL(String(input)).pathname === '/v1/responses') first(new Headers(init.headers).get('x-escrow-ref') ?? '');
  return m.fetchImpl(input, init);
}) as typeof fetch;
/** A chain on which the state of an escrow cannot be read. */
const unreadable = (m: Marketplace): Chain => chainWith(m, { escrowState: async () => { throw new Error('Could not read escrow: Koios answered 503'); } });
/** A chain on which the hash of a Submitted output is never listed. */
const unlisted = (m: Marketplace): Chain => chainWith(m, { onChainReceiptHash: async () => null });
const failingWrite = (): never => { throw new Error('ENOSPC: no space left on device'); };

/** The error the hire of a row rejects with. */
async function asked(row: Row): Promise<Asked> {
  const m = marketplace();
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-facts-'));
  dirs.push(dir);
  const stranded = new StrandedStore(dir);
  const arranged = row.arrange({ m, stranded }) ?? {};
  const deps: HireDeps = {
    chain: arranged.chain ?? m.chain, stranded, clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; }, deadlineMs: T0 + (row.deadlineMs ?? FAR),
  };
  const job = chatJob(LLM_ENDPOINT, INPUT, 'the brief', arranged.fetchImpl ?? m.fetchImpl);
  return hireOne(deps, SUPPLIER, job, UNCOUNTED, ASKED, arranged.options).then(
    () => { throw new Error('the hire succeeded'); },
    (e: unknown) => { if (e instanceof Asked) return e; throw e; },
  );
}

const atPost = (escrowRef: string | null): HireFacts => ({ stage: 'post', escrowRef, handedOver: false });
const atSend = (state?: HireFacts['escrowState']): HireFacts => (state === undefined ? { stage: 'send', escrowRef: REF, handedOver: false } : { stage: 'send', escrowRef: REF, escrowState: state, handedOver: false });
const atPoll = (state?: HireFacts['escrowState']): HireFacts => (state === undefined ? { stage: 'poll', escrowRef: REF, handedOver: true } : { stage: 'poll', escrowRef: REF, escrowState: state, handedOver: true });
const AT_ANSWER: HireFacts = { stage: 'answer', escrowRef: REF, handedOver: true };
const AT_RECEIPT: HireFacts = { stage: 'receipt', escrowRef: REF, handedOver: true };
const AT_ACCEPT: HireFacts = { stage: 'accept', escrowRef: REF, handedOver: true };

// --- The table: every site, in the order of a hire ---------------------------------------------------------------------------------
const ROWS: Row[] = [
  // The Post (postEscrow).
  {
    site: 'the record of a Post signed and not confirmed cannot be written', how: 'the Post may still land', code: 'store_write_failed',
    arrange: ({ m, stranded }) => { m.chain.failNextPost(notConfirmed(true)); stranded.add = failingWrite; return undefined; },
    words: 'its Post for the brief was not seen confirmed and may land until', facts: atPost(LOST),
  },
  {
    site: 'the record of a Post signed and not confirmed cannot be written', how: 'the submit API refused the Post', code: 'store_write_failed',
    arrange: ({ m, stranded }) => { m.chain.failNextPost(notConfirmed(false)); stranded.add = failingWrite; return undefined; },
    words: 'refused by the submit API after it was signed, and could land all the same', facts: atPost(LOST),
  },
  {
    site: 'a Post the submit API refused after its signature', how: 'recorded with its validity', code: 'llm_post_failed',
    arrange: ({ m }) => { m.chain.failNextPost(notConfirmed(false)); return undefined; },
    words: 'The submit API refused the Post for the brief after it was signed', facts: atPost(LOST),
  },
  {
    site: 'a Post signed and not seen confirmed', how: 'recorded with its validity', code: 'llm_post_failed',
    arrange: ({ m }) => { m.chain.failNextPost(notConfirmed(true)); return undefined; },
    words: 'It may still land until', facts: atPost(LOST),
  },
  {
    site: 'a Post that fails before its signature', how: 'nothing was signed', code: 'llm_post_failed',
    arrange: ({ m }) => ({ chain: chainWith(m, { postEscrow: async () => { throw new Error('Could not read advert: Koios answered 503'); } }) }),
    words: 'Nothing was locked for it.', facts: atPost(null),
  },
  {
    site: 'the record of a confirmed Post cannot be written', how: 'the store refuses the entry', code: 'store_write_failed',
    arrange: ({ stranded }) => { stranded.add = failingWrite; return undefined; },
    words: 'and the janitor does not know of it. Reclaim it by hand after its deliver_by', facts: atPost(REF),
  },
  // firstSendBy (hireOne).
  {
    site: 'a Post confirmed past firstSendBy', how: 'it is never sent', code: 'deadline',
    arrange: ({ m }) => ({
      chain: chainWith(m, { postEscrow: async (a) => { const post = await m.chain.postEscrow(a); m.clock.now = T0 + 10_001; return post; } }),
      options: { firstSendBy: T0 + 10_000 },
    }),
    words: 'the Post for the brief was being confirmed', facts: atSend(),
  },
  // The send (handOver).
  {
    site: 'the deadline while the state of the escrow cannot be read', how: 'a send with no answer', code: 'deadline', deadlineMs: 10_000,
    arrange: ({ m }) => { m.llm.lose = ['before-claim']; return { chain: unreadable(m) }; },
    words: 'the brief waited to read the state of its escrow', facts: atSend(null),
  },
  {
    site: 'a state that cannot be read until the send cutoff', how: 'a 404 escrow_not_found, then reads every 15 s', code: 'llm_send_lost',
    arrange: ({ m }) => { m.llm.notFound = 1; return { chain: unreadable(m) }; },
    words: 'could not be read until 90 s before its deliver_by', facts: atSend(null),
  },
  {
    site: 'a 404 escrow_not_found while the escrow is not Open', how: 'the supplier claimed it and answers it does not see it', code: 'llm_send_lost',
    arrange: ({ m }) => { m.llm.notFound = 1; return { fetchImpl: beforeEachSend(m, (ref) => { m.chain.markClaimed(ref); }) }; },
    words: 'answered 404 escrow_not_found: escrow UTxO not found on chain, and its escrow', facts: atSend('Claimed'),
  },
  {
    site: 'the deadline at the repeat of a send', how: 'a busy supplier: no state was read', code: 'deadline', deadlineMs: 10_000,
    arrange: ({ m }) => { m.llm.busy = 1_000; return undefined; },
    words: 'the brief waited for its supplier', facts: atSend(),
  },
  {
    site: 'the deadline at the repeat of a send', how: 'a 404 escrow_not_found: the escrow was read Open', code: 'deadline', deadlineMs: 10_000,
    arrange: ({ m }) => { m.llm.notFound = 1_000; return undefined; },
    words: 'the brief waited for its supplier', facts: atSend('Open'),
  },
  {
    site: 'a 404 escrow_not_found kept until the send cutoff', how: 'sent every 15 s', code: 'llm_refused',
    arrange: ({ m }) => { m.llm.notFound = 1_000; return undefined; },
    words: 'as if the escrow were not on chain: the brief was sent 27 times', facts: atSend('Open'),
  },
  {
    site: 'a supplier busy until the send cutoff', how: 'sent every 15 s', code: 'llm_busy',
    arrange: ({ m }) => { m.llm.busy = 1_000; return undefined; },
    words: 'stayed busy: the brief was sent 27 times', facts: atSend('Open'),
  },
  {
    site: 'a 4xx refusal in the supplier\'s own envelope', how: '409 prompt_mismatch', code: 'llm_refused',
    arrange: ({ m }) => { m.llm.refuse = { status: 409, reason: 'prompt_mismatch' }; return undefined; },
    words: 'refused the brief (409 prompt_mismatch', facts: atSend('Open'),
  },
  {
    site: 'no time for a second send', how: 'a send with no answer that ends past the send cutoff', code: 'llm_send_lost',
    arrange: ({ m }) => { m.llm.lose = ['before-claim']; return { fetchImpl: beforeEachSend(m, () => { m.clock.now = SEND_UNTIL + 1; }) }; },
    words: 'got no answer and there is no time to send it again', facts: atSend('Open'),
  },
  {
    site: 'the deadline at a second send', how: 'a send with no answer that ends past the deadline', code: 'deadline', deadlineMs: 10_000,
    arrange: ({ m }) => { m.llm.lose = ['before-claim']; return { fetchImpl: beforeEachSend(m, () => { m.clock.now = T0 + 10_001; }) }; },
    words: 'the brief was being sent', facts: atSend('Open'),
  },
  {
    site: 'a refusal that is no 4xx, twice', how: '503 both times', code: 'llm_refused',
    arrange: ({ m }) => { m.llm.refuse = { status: 503, reason: 'upstream_down' }; return undefined; },
    words: 'refused the brief twice (503 upstream_down', facts: atSend('Open'),
  },
  {
    site: 'no send can be made again', how: 'no answer twice', code: 'llm_send_lost',
    arrange: ({ m }) => { m.llm.lose = ['before-claim', 'before-claim']; return undefined; },
    words: 'got no answer twice', facts: atSend('Open'),
  },
  {
    site: 'no send can be made again', how: 'no answer after the Claim', code: 'llm_send_lost',
    arrange: ({ m }) => { m.llm.lose = ['after-claim']; return undefined; },
    words: `got no answer, and its escrow ${REF} is Claimed: the supplier may hold the job, but there is no job id`, facts: atSend('Claimed'),
  },
  // The polls (finished).
  {
    site: 'no result by the deliver_by', how: 'every poll running: no state was read', code: 'llm_timeout',
    arrange: ({ m }) => { m.llm.steps = ['running']; return undefined; },
    words: 'had not finished the brief by the deliver_by', facts: atPoll(),
  },
  {
    site: 'no result by the deliver_by', how: 'every poll a failure of the supplier\'s while the escrow reads Submitted', code: 'llm_timeout',
    arrange: ({ m }) => { m.llm.steps = [{ fail: 'upstream_failure', submitted: true }]; return undefined; },
    words: 'had not finished the brief by the deliver_by', facts: atPoll('Submitted'),
  },
  {
    site: 'no result by the deliver_by', how: 'one failure of the supplier\'s, the state unreadable, then polls running', code: 'llm_timeout',
    arrange: ({ m }) => { m.llm.steps = ['failed', 'running']; return { chain: unreadable(m) }; },
    words: 'had not finished the brief by the deliver_by', facts: atPoll(null),
  },
  {
    site: 'the deadline in the polls', how: 'the job still running', code: 'deadline', deadlineMs: 4_000,
    arrange: ({ m }) => { m.llm.steps = ['running']; return undefined; },
    words: 'the brief was being polled', facts: atPoll(),
  },
  {
    site: 'a supplier that failed its own Submit', how: 'submit_timeout while the escrow reads Submitted', code: 'llm_receipt_unavailable',
    arrange: ({ m }) => { m.llm.steps = [{ fail: 'submit_timeout', submitted: true }]; return undefined; },
    words: 'failed the brief at its own Submit (submit_timeout', facts: atPoll('Submitted'),
  },
  {
    site: 'the supplier\'s word that the job failed or is gone', how: 'failed while the escrow reads Claimed', code: 'llm_failed',
    arrange: ({ m }) => { m.llm.steps = ['failed']; return undefined; },
    words: 'failed the brief (upstream_failure: the upstream model did not answer)', facts: atPoll('Claimed'),
  },
  {
    site: 'the supplier\'s word that the job failed or is gone', how: 'gone while the escrow reads Claimed', code: 'llm_failed',
    arrange: ({ m }) => { m.llm.steps = ['gone']; return undefined; },
    words: 'failed the brief (it no longer knows the job (404))', facts: atPoll('Claimed'),
  },
  // The answer (hireOne).
  {
    site: 'an answer read cannot use', how: 'its output is not a list', code: 'llm_bad_result',
    arrange: ({ m }) => { m.llm.answerText = (body) => JSON.stringify({ ...body, output: 'text' }); return undefined; },
    words: 'cannot be used (its output is not a list)', facts: AT_ANSWER,
  },
  // The receipt (verified).
  {
    site: 'a check of the receipt fails', how: 'one of its own: another key signed it', code: 'llm_receipt_failed',
    arrange: ({ m }) => { m.llm.forge = true; return undefined; },
    words: 'failed signature_valid;', facts: AT_RECEIPT,
  },
  {
    site: 'a check of the receipt fails', how: 'the hash on chain is another', code: 'llm_receipt_failed',
    arrange: ({ m }) => ({ chain: chainWith(m, { onChainReceiptHash: async () => 'ab'.repeat(32) }) }),
    words: 'failed on_chain_hash_matches;', facts: AT_RECEIPT,
  },
  {
    site: 'the hash of the receipt not on chain within 120 s', how: 'never listed', code: 'llm_receipt_failed',
    arrange: ({ m }) => ({ chain: unlisted(m) }),
    words: 'could not be read on chain within 120 s of the supplier\'s answer', facts: AT_RECEIPT,
  },
  {
    site: 'the deadline in the reads of the hash', how: 'the deadline of the hire', code: 'deadline', deadlineMs: 20_000,
    arrange: ({ m }) => ({ chain: unlisted(m) }),
    words: 'the receipt for the brief was being checked', facts: AT_RECEIPT,
  },
  {
    site: 'the deadline in the reads of the hash', how: 'receiptBy, in its place', code: 'deadline',
    arrange: ({ m }) => ({ chain: unlisted(m), options: { receiptBy: T0 + 60_000 } }),
    words: 'the receipt for the brief was being checked', facts: AT_RECEIPT,
  },
  // The Accept (accept).
  {
    site: 'the mark of an Accept not seen confirmed cannot be written', how: 'the store refuses the update', code: 'store_write_failed',
    arrange: ({ m, stranded }) => { stranded.update = failingWrite; return { chain: chainWith(m, { accept: async (r) => { throw unseenAccept(r); } }) }; },
    words: 'and the store does not say so: the janitor takes it for a Submitted escrow it cannot accept', facts: AT_ACCEPT,
  },
  {
    site: 'an Accept that cannot be made', how: 'it keeps failing for 600 s after the answer', code: 'llm_accept_failed',
    arrange: ({ m }) => ({ chain: chainWith(m, { accept: async () => { throw new Error('Could not read the escrow reference script from the node: network error'); } }) }),
    words: 'the next one would start more than 600 s after the supplier\'s answer', facts: AT_ACCEPT,
  },
  {
    site: 'an Accept that cannot be made', how: 'the accept window has closed', code: 'llm_accept_failed',
    arrange: ({ m }) => { m.chain.closeAcceptWindow(); return undefined; },
    words: 'the accept window has closed. Its escrow', facts: AT_ACCEPT,
  },
];

describe('hireOne: the facts of every throw site', () => {
  it.each(ROWS.map((row) => [`${row.site}: ${row.how}`, row] as const))('%s', async (_title, row) => {
    const error = await asked(row);
    expect([error.code, error.facts]).toStrictEqual([row.code, row.facts]);
    expect(error.words).toContain(row.words);
  });

  it('an escrow is named in every fact but that of a Post that failed before its signature, and the job is handed over from the polls on', () => {
    expect(ROWS.filter((row) => row.facts.escrowRef === null).map((row) => row.site)).toStrictEqual(['a Post that fails before its signature']);
    const handedOver = new Set(ROWS.filter((row) => row.facts.handedOver).map((row) => row.facts.stage));
    expect([...handedOver].sort()).toStrictEqual(['accept', 'answer', 'poll', 'receipt']);
  });

  it('src/hire.ts makes its errors at 27 sites, and the table drives every one of them', () => {
    const source = readFileSync(new URL('../src/hire.ts', import.meta.url), 'utf8');
    const count = (needle: string): number => source.split(needle).length - 1;
    expect([count("failure(errors, supplier, '"), count('errors.deadline('), count('recorded(errors, ')]).toStrictEqual([18, 6, 3]);
    expect(new Set(ROWS.map((row) => row.site)).size).toBe(27);
  });
});
