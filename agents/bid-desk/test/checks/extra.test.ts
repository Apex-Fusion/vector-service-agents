// agents/bid-desk/test/checks/extra.test.ts: the check of the Bid Desk that follows the shared checks of the kit. The refusal has an accepted twin. The key is the sender of the request and the identifier of the
// request, each as it was written, and nothing from the job context. A book that cannot be read is never a pass. The question: does a request that the book holds ever pass, and does a request of another
// sender or with another identifier ever read as a duplicate?
import { describe, expect, it } from 'vitest';
import { CheckUnavailableError, SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import type { ExtraCheck, StepResult } from '@vsa/usecase-kit/checks';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { MemoryRfqBook, rfqChecks } from '../../src/checks/index.ts';
import type { RfqBook } from '../../src/checks/index.ts';
import { BUYER_PKH, CONTEXT, OTHER_SENDER, QUOTE_SHA256, RFQ, SENDER, messageOf, rfqOf } from './samples.ts';

interface Rig {
  readonly book: RfqBook;
  readonly faults: Array<[string, unknown]>;
  readonly duplicate: ExtraCheck<RfqMessage>;
}

/** The check over a book. The faults list gets each source and cause that the check reports. */
function rig(book: RfqBook = new MemoryRfqBook()): Rig {
  const faults: Array<[string, unknown]> = [];
  const [duplicate] = rfqChecks({ book, onFault: (source, cause) => { faults.push([source, cause]); } });
  if (duplicate === undefined) throw new Error('the list has no check');
  return { book, faults, duplicate };
}

const ACCEPTED: StepResult = { ok: true, value: {} };
const refusalOf = (result: StepResult): { code: string; detail: string } => {
  if (result.ok) throw new Error('the check passed');
  return { code: result.code, detail: result.detail };
};
/** The value that a call rejected with, or null when the call resolved. */
const failureOf = (call: Promise<unknown>): Promise<unknown> => call.then(() => null, (error: unknown) => error);

describe('the list of checks', () => {
  it('has the one check of the page, with its name, and the name is not the name of a shared check', () => {
    const checks = rfqChecks({ book: new MemoryRfqBook() });
    expect(checks.map((check) => check.names)).toEqual([['not_duplicate']]);
    expect(SHARED_CHECK_NAMES['bid-desk']).not.toContain('not_duplicate');
  });

  it('is a TypeError for a wrong input: a book that cannot answer, and a hook for faults that is not a function', () => {
    const book = new MemoryRfqBook();
    expect(() => rfqChecks({ book })).not.toThrow();
    expect(() => rfqChecks({ book, onFault: () => undefined })).not.toThrow();
    expect(() => rfqChecks({ book: {} as unknown as RfqBook })).toThrow(TypeError);
    expect(() => rfqChecks({ book: null as unknown as RfqBook })).toThrow(TypeError);
    expect(() => rfqChecks({ book: { has: 'yes' } as unknown as RfqBook })).toThrow(TypeError);
    expect(() => rfqChecks({} as unknown as { book: RfqBook })).toThrow(TypeError);
    expect(() => rfqChecks(null as never)).toThrow(TypeError);
    expect(() => rfqChecks({ book, onFault: 'yes' as never })).toThrow(TypeError);
  });
});

describe('not_duplicate', () => {
  it('passes a request that the book does not hold, and refuses it with duplicate_rfq once the book holds it', async () => {
    const { duplicate, book } = rig();
    expect(await duplicate.run(messageOf(), CONTEXT)).toEqual(ACCEPTED);
    await book.record(SENDER, 'run1-rfq-1', QUOTE_SHA256);
    expect(refusalOf(await duplicate.run(messageOf(), CONTEXT)).code).toBe('duplicate_rfq');
  });

  it('keeps the senders apart: the identifier of one sender is a new request for another sender', async () => {
    const { duplicate, book } = rig();
    await book.record(OTHER_SENDER, 'run1-rfq-1', QUOTE_SHA256);
    expect(await duplicate.run(messageOf(), CONTEXT)).toEqual(ACCEPTED);
    expect(refusalOf(await duplicate.run(messageOf(RFQ, { sender_did: OTHER_SENDER }), CONTEXT)).code).toBe('duplicate_rfq');
    await book.record(SENDER, 'run1-rfq-1', QUOTE_SHA256);
    expect(refusalOf(await duplicate.run(messageOf(), CONTEXT)).code).toBe('duplicate_rfq');
  });

  it('keys the request by the sender and the identifier only: the same identifier with other items and another date is the same request', async () => {
    const { duplicate, book } = rig();
    await book.record(SENDER, 'run1-rfq-1', QUOTE_SHA256);
    const changed = rfqOf({ items: [{ sku: 'MSK-N95', quantity: 7 }], needed_by: '2027-03-01' });
    expect(refusalOf(await duplicate.run(messageOf(changed), CONTEXT)).code).toBe('duplicate_rfq');
    // The twin: another identifier with the same items is a new request.
    expect(await duplicate.run(messageOf(rfqOf({ rfq_id: 'run1-rfq-2' })), CONTEXT)).toEqual(ACCEPTED);
  });

  it('counts the identifier as it is written: an identifier that differs in case is a new request, in both directions', async () => {
    const { duplicate, book } = rig();
    await book.record(SENDER, 'RUN1-RFQ-1', QUOTE_SHA256);
    expect(await duplicate.run(messageOf(rfqOf({ rfq_id: 'run1-rfq-1' })), CONTEXT)).toEqual(ACCEPTED);
    expect(refusalOf(await duplicate.run(messageOf(rfqOf({ rfq_id: 'RUN1-RFQ-1' })), CONTEXT)).code).toBe('duplicate_rfq');
    await book.record(SENDER, 'run1-rfq-2', QUOTE_SHA256);
    expect(await duplicate.run(messageOf(rfqOf({ rfq_id: 'RUN1-RFQ-2' })), CONTEXT)).toEqual(ACCEPTED);
  });

  it('says in the refusal that the book holds an answer, and never names the sender or the identifier', async () => {
    const { duplicate, book } = rig();
    await book.record(SENDER, 'run1-rfq-1', QUOTE_SHA256);
    const refusal = refusalOf(await duplicate.run(messageOf(), CONTEXT));
    expect(refusal.detail).toBe('the rfq book holds an answer to this request for quotation from this sender');
    expect(refusal.detail).not.toContain(SENDER);
    expect(refusal.detail).not.toContain('run1-rfq-1');
  });

  it('asks the book with the sender and the identifier of the request, and with nothing from the context', async () => {
    const asked: unknown[][] = [];
    const book: RfqBook = { has: async (...args) => { asked.push(args); return false; }, record: async () => undefined };
    const { duplicate } = rig(book);
    const request = messageOf(rfqOf({ rfq_id: 'Run7-RFQ-4' }), { sender_did: OTHER_SENDER });
    await duplicate.run(request, CONTEXT);
    await duplicate.run(request, { ...CONTEXT, buyerPkh: '0c'.repeat(28), escrowRef: `${'e8'.repeat(32)}#2` });
    expect(asked).toEqual([[OTHER_SENDER, 'Run7-RFQ-4'], [OTHER_SENDER, 'Run7-RFQ-4']]);
    expect(JSON.stringify(asked)).not.toContain(BUYER_PKH);
  });

  it('only reads the book: the check records nothing', async () => {
    const calls: string[] = [];
    const book: RfqBook = { has: async () => { calls.push('has'); return false; }, record: async () => { calls.push('record'); } };
    expect(await rig(book).duplicate.run(messageOf(), CONTEXT)).toEqual(ACCEPTED);
    expect(calls).toEqual(['has']);
  });

  it('is check_unavailable and never a pass when the book cannot be read, and tells the service the cause', async () => {
    const cause = new Error('EIO: the disk of /data/rfq-book.json failed, key=secret-token-123');
    const book: RfqBook = { has: () => Promise.reject(cause), record: async () => undefined };
    const { duplicate, faults } = rig(book);
    const failure = await failureOf(duplicate.run(messageOf(), CONTEXT));
    if (!(failure instanceof CheckUnavailableError)) throw new Error('the check did not reject with CheckUnavailableError');
    expect(failure.code).toBe('check_unavailable');
    expect(failure.message).toBe('the rfq book could not be read');
    expect(faults).toEqual([['rfq book', cause]]);
  });

  it('is check_unavailable when the book gives an answer that is not true or false: only false is a pass', async () => {
    for (const answer of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
      const book = { has: () => Promise.resolve(answer), record: async () => undefined } as unknown as RfqBook;
      const { duplicate, faults } = rig(book);
      await expect(duplicate.run(messageOf(), CONTEXT), String(answer)).rejects.toBeInstanceOf(CheckUnavailableError);
      expect(faults).toHaveLength(1);
    }
  });

  it('is check_unavailable when the book throws at once, without a promise', async () => {
    const book = { has: () => { throw new Error('the book is closed'); }, record: async () => undefined } as unknown as RfqBook;
    await expect(rig(book).duplicate.run(messageOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it('is still check_unavailable when the hook for faults fails', async () => {
    const book: RfqBook = { has: () => Promise.reject(new Error('no')), record: async () => undefined };
    const [duplicate] = rfqChecks({ book, onFault: () => { throw new Error('the log is closed'); } });
    await expect(duplicate?.run(messageOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });
});

describe('a message that is not a request for quotation', () => {
  const BROKEN: Array<[string, Record<string, unknown>]> = [
    ['no items', rfqOf({ items: [] })],
    ['a member that the request does not list', { ...RFQ, note: 'x' }],
    ['no date', Object.fromEntries(Object.entries(RFQ).filter(([name]) => name !== 'needed_by'))],
    ['a quantity of zero', rfqOf({ items: [{ sku: 'GLV-NIT-M', quantity: 0 }] })],
    ['an identifier with a space', rfqOf({ rfq_id: 'run1 rfq' })],
    ['a SKU that is listed two times', rfqOf({ items: [{ sku: 'GLV-NIT-M', quantity: 1 }, { sku: 'GLV-NIT-M', quantity: 2 }] })],
    ['a date that does not exist', rfqOf({ needed_by: '2026-02-30' })],
  ];

  it.each(BROKEN)('is a fault of the service with %s: a throw, never a pass and never a refusal of a rule, and the book is not asked', async (_name, rfq) => {
    const asked: string[] = [];
    const book: RfqBook = { has: async () => { asked.push('has'); return false; }, record: async () => undefined };
    const { duplicate } = rig(book);
    await expect(duplicate.run(messageOf(rfq as unknown as RfqMessage['rfq']), CONTEXT)).rejects.toBeInstanceOf(TypeError);
    expect(asked).toEqual([]);
    // The twin: the request of the samples passes.
    expect(await duplicate.run(messageOf(), CONTEXT)).toEqual(ACCEPTED);
  });

  it('is refused with a message that names the member and never repeats the value', async () => {
    const failure = await failureOf(rig().duplicate.run(messageOf(rfqOf({ rfq_id: 'secret value?' })), CONTEXT));
    if (!(failure instanceof TypeError)) throw new Error('the check did not reject with a TypeError');
    expect(failure.message).not.toContain('secret value');
    expect(failure.message).toContain('rfq_id');
  });

  it('is a fault of the service when the sender is not a DID, and when the schema is not the schema of a request for quotation', async () => {
    const { duplicate } = rig();
    await expect(duplicate.run(messageOf(RFQ, { sender_did: 'did:vector:abc' }), CONTEXT)).rejects.toBeInstanceOf(TypeError);
    await expect(duplicate.run(messageOf(RFQ, { sender_did: SENDER.toUpperCase() }), CONTEXT)).rejects.toBeInstanceOf(TypeError);
    await expect(duplicate.run({ ...messageOf(), schema: 'vector.usecase.handoff.v1' } as unknown as RfqMessage, CONTEXT)).rejects.toBeInstanceOf(TypeError);
    await expect(duplicate.run(null as unknown as RfqMessage, CONTEXT)).rejects.toBeInstanceOf(TypeError);
    // The twin: the message of the samples passes.
    expect(await duplicate.run(messageOf(), CONTEXT)).toEqual(ACCEPTED);
  });
});
