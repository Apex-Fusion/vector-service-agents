// agents/insurer-intake-agent/test/checks/extra.test.ts: the three checks of the Insurer Intake Agent that follow the shared checks of the kit. Each refusal has an accepted twin. The advert of a request is
// compared with the job context of the runtime and never with a member that the body chooses. A book that cannot be read is never a pass. The question: does a wrong insurer, a wrong advert or a request
// number that exists ever pass?
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CheckUnavailableError, SHARED_CHECK_NAMES } from '@vsa/usecase-kit/checks';
import type { ExtraCheck, StepResult } from '@vsa/usecase-kit/checks';
import type { Document, Handoff } from '@vsa/usecase-kit/protocol';
import { intakeChecks } from '../../src/checks/index.ts';
import type { BookReader } from '../../src/checks/index.ts';
import { CONTEXT, OTHER_ADVERT_REF, OTHER_DID, PRIOR_REQUEST, SELF, handoffOf, priorRequest } from './samples.ts';
import { ScriptedBook } from './support.ts';

interface Rig {
  readonly faults: Array<[string, unknown]>;
  readonly insurer: ExtraCheck<Handoff>;
  readonly advert: ExtraCheck<Handoff>;
  readonly duplicate: ExtraCheck<Handoff>;
}

/** The three checks over a book. The faults list gets each source and cause that the checks report. */
function rig(book: BookReader = new ScriptedBook(), self: string = SELF): Rig {
  const faults: Array<[string, unknown]> = [];
  const [insurer, advert, duplicate] = intakeChecks({ book, self, onFault: (source, cause) => { faults.push([source, cause]); } });
  return { faults, insurer: insurer!, advert: advert!, duplicate: duplicate! };
}

const ACCEPTED: StepResult = { ok: true, value: {} };
const refusalOf = (result: StepResult): { code: string; detail: string } => {
  if (result.ok) throw new Error('the check passed');
  return { code: result.code, detail: result.detail };
};

describe('the list of checks', () => {
  it('has the three checks of the page, with their names, in the order of the page, after the 12 shared checks', () => {
    const checks = intakeChecks({ book: new ScriptedBook(), self: SELF });
    expect(checks.map((check) => check.names)).toEqual([['for_this_insurer'], ['advert'], ['not_duplicate']]);
    // The names of the shared checks are 12, and the checks of the agent use none of them.
    expect(SHARED_CHECK_NAMES['insurer-intake-agent']).toHaveLength(12);
    for (const check of checks) expect(SHARED_CHECK_NAMES['insurer-intake-agent']).not.toContain(check.names[0]);
  });

  it('is a TypeError for a wrong input: an insurer that is no DID, a book that cannot answer, and a hook for faults that is no function', () => {
    const book = new ScriptedBook();
    expect(() => intakeChecks({ book, self: SELF })).not.toThrow();
    expect(() => intakeChecks({ book, self: 'did:vector:abc' })).toThrow(TypeError);
    expect(() => intakeChecks({ book, self: SELF.toUpperCase() })).toThrow(TypeError);
    expect(() => intakeChecks({ book: {} as unknown as BookReader, self: SELF })).toThrow(TypeError);
    expect(() => intakeChecks({ book: null as unknown as BookReader, self: SELF })).toThrow(TypeError);
    expect(() => intakeChecks(null as never)).toThrow(TypeError);
    expect(() => intakeChecks({ book, self: SELF, onFault: 'yes' as never })).toThrow(TypeError);
  });

  it('passes the golden request of the kit when the insurer and the advert are the ones that it names', async () => {
    const golden = JSON.parse(readFileSync(new URL('../../../../packages/usecase-kit/test/priorauth/golden/request.json', import.meta.url), 'utf8')) as Document;
    const checks = rig(new ScriptedBook(), String(golden.insurer_did));
    const context = { ...CONTEXT, advertRef: String(golden.advert_ref) };
    for (const check of [checks.insurer, checks.advert, checks.duplicate]) expect(await check.run(handoffOf(golden), context), check.names[0]).toEqual(ACCEPTED);
    // The twin: the same request for the samples is for another insurer and another advert.
    expect(refusalOf(await checks.insurer.run(handoffOf(), CONTEXT)).code).toBe('not_for_this_insurer');
    expect(refusalOf(await checks.advert.run(handoffOf(), context)).code).toBe('advert_mismatch');
  });
});

describe('check 13, for_this_insurer', () => {
  it('passes a request that names this insurer', async () => {
    expect(await rig().insurer.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });

  it('refuses a request that names another insurer with not_for_this_insurer, and the same request passes for the insurer that it names', async () => {
    const body = handoffOf(priorRequest({ insurer_did: OTHER_DID }));
    const refusal = refusalOf(await rig().insurer.run(body, CONTEXT));
    expect(refusal.code).toBe('not_for_this_insurer');
    expect(refusal.detail).not.toContain(OTHER_DID);
    expect(await rig(new ScriptedBook(), OTHER_DID).insurer.run(body, CONTEXT)).toEqual(ACCEPTED);
  });

  it('reads the insurer from the document and not from the sender of the handoff: a sender that is this insurer does not make the request for it', async () => {
    const body = handoffOf(priorRequest({ insurer_did: OTHER_DID }), { sender_did: SELF });
    expect(refusalOf(await rig().insurer.run(body, CONTEXT)).code).toBe('not_for_this_insurer');
  });
});

describe('check 14, advert', () => {
  it('passes a request for the advert that the escrow was posted on', async () => {
    expect(await rig().advert.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });

  it('refuses a body that names another advert than the context with advert_mismatch, and the same body passes when the escrow was posted on the advert that it names', async () => {
    const body = handoffOf(priorRequest({ advert_ref: OTHER_ADVERT_REF }));
    const refusal = refusalOf(await rig().advert.run(body, CONTEXT));
    expect(refusal.code).toBe('advert_mismatch');
    expect(refusal.detail).not.toContain(OTHER_ADVERT_REF);
    expect(await rig().advert.run(body, { ...CONTEXT, advertRef: OTHER_ADVERT_REF })).toEqual(ACCEPTED);
  });

  it('refuses a body that names the advert of the samples when the context names another advert: the context wins', async () => {
    const body = handoffOf();
    expect(body.document.advert_ref).toBe(CONTEXT.advertRef);
    expect(refusalOf(await rig().advert.run(body, { ...CONTEXT, advertRef: OTHER_ADVERT_REF })).code).toBe('advert_mismatch');
    // The twin: with the advert that the body names in the context, the same body passes.
    expect(await rig().advert.run(body, CONTEXT)).toEqual(ACCEPTED);
  });

  it('takes the advert from the context for each pair of body and context: it passes only when the two are one advert', async () => {
    const adverts = [CONTEXT.advertRef, OTHER_ADVERT_REF, `${'d6'.repeat(32)}#0`, `${'d4'.repeat(32)}#2`];
    for (const inBody of adverts) {
      const results = await Promise.all(adverts.map(async (inContext) => (await rig().advert.run(handoffOf(priorRequest({ advert_ref: inBody })), { ...CONTEXT, advertRef: inContext })).ok));
      expect(results, inBody).toEqual(adverts.map((inContext) => inContext === inBody));
    }
  });

  it('does not read the intake book', async () => {
    const book = new ScriptedBook();
    await rig(book).advert.run(handoffOf(), CONTEXT);
    await rig(book).advert.run(handoffOf(priorRequest({ advert_ref: OTHER_ADVERT_REF })), CONTEXT);
    expect(book.asked).toEqual([]);
  });
});

describe('check 15, not_duplicate', () => {
  it('passes a request number that the book does not hold, and refuses it with duplicate_request once the book holds it', async () => {
    const book = new ScriptedBook();
    const { duplicate } = rig(book);
    expect(await duplicate.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
    book.record('run1', 'run1-1');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_request');
  });

  it('counts a request number without regard to case, as the insurer portal does', async () => {
    const book = new ScriptedBook();
    const { duplicate } = rig(book);
    book.record('run1', 'RUN1-1');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_request');
    book.record('run1', 'run1-2');
    expect(refusalOf(await duplicate.run(handoffOf(priorRequest({ request_number: 'RUN1-2' })), CONTEXT)).code).toBe('duplicate_request');
    // The twin: another number passes.
    expect(await duplicate.run(handoffOf(priorRequest({ request_number: 'run1-3' })), CONTEXT)).toEqual(ACCEPTED);
  });

  it('keeps the tenants apart: the number of one tenant is a new number for another', async () => {
    const book = new ScriptedBook();
    const { duplicate } = rig(book);
    book.record('run2', 'run1-1');
    expect(await duplicate.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
    book.record('run1', 'run1-1');
    expect(refusalOf(await duplicate.run(handoffOf(), CONTEXT)).code).toBe('duplicate_request');
  });

  it('asks the book with the tenant and the number of the request, as it wrote them, and with nothing from the context or the sender', async () => {
    const book = new ScriptedBook();
    await rig(book).duplicate.run(handoffOf(priorRequest({ tenant: 'run7', request_number: 'Run7-4' })), CONTEXT);
    expect(book.asked).toEqual([['run7', 'Run7-4']]);
  });

  it('is check_unavailable and never a pass when the book cannot be read, and tells the service the cause', async () => {
    const cause = new Error('EIO: the disk of /data/requests.json failed, key=secret-token-123');
    const { duplicate, faults } = rig({ has: () => Promise.reject(cause) });
    const failure = await duplicate.run(handoffOf(), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(CheckUnavailableError);
    expect((failure as CheckUnavailableError).code).toBe('check_unavailable');
    expect((failure as CheckUnavailableError).message).toBe('the intake book could not be read');
    expect(faults).toEqual([['intake book', cause]]);
  });

  it('is check_unavailable when the book gives an answer that is not true or false: only false is a pass', async () => {
    for (const answer of [undefined, null, 0, 1, '', 'false', 'true', {}, []]) {
      const book = { has: () => Promise.resolve(answer) } as unknown as BookReader;
      const { duplicate, faults } = rig(book);
      await expect(duplicate.run(handoffOf(), CONTEXT), String(answer)).rejects.toBeInstanceOf(CheckUnavailableError);
      expect(faults).toHaveLength(1);
    }
  });

  it('is check_unavailable when the book throws at once, without a promise', async () => {
    const book = { has: () => { throw new Error('the book is closed'); } } as unknown as BookReader;
    await expect(rig(book).duplicate.run(handoffOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });

  it('is still check_unavailable when the hook for faults fails', async () => {
    const [, , duplicate] = intakeChecks({ book: { has: () => Promise.reject(new Error('no')) }, self: SELF, onFault: () => { throw new Error('the log is closed'); } });
    await expect(duplicate!.run(handoffOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
  });
});

describe('a book that is full', () => {
  /** A book with room for two entries, and both are taken. Its `has` follows the rule of a full book: a number that it holds reads as held, and a number that it lacks is a rejection. */
  const full = (): ScriptedBook => {
    const book = new ScriptedBook(2);
    book.record('run1', 'run1-8');
    book.record('run1', 'run1-9');
    return book;
  };

  it('is check_unavailable and never a pass for a request number that it lacks, and tells the service the cause', async () => {
    const { duplicate, faults } = rig(full());
    await expect(duplicate.run(handoffOf(), CONTEXT)).rejects.toBeInstanceOf(CheckUnavailableError);
    expect(faults).toHaveLength(1);
    expect(faults[0]![0]).toBe('intake book');
    expect(faults[0]![1]).toBeInstanceOf(RangeError);
  });

  it('still refuses a request number that it holds with duplicate_request, in any case', async () => {
    const { duplicate, faults } = rig(full());
    expect(refusalOf(await duplicate.run(handoffOf(priorRequest({ request_number: 'run1-9' })), CONTEXT)).code).toBe('duplicate_request');
    expect(refusalOf(await duplicate.run(handoffOf(priorRequest({ request_number: 'RUN1-8' })), CONTEXT)).code).toBe('duplicate_request');
    expect(faults).toEqual([]);
  });

  it('passes the same request when the book has room for it', async () => {
    const book = new ScriptedBook(3);
    book.record('run1', 'run1-8');
    book.record('run1', 'run1-9');
    expect(await rig(book).duplicate.run(handoffOf(), CONTEXT)).toEqual(ACCEPTED);
  });
});

describe('a document that is not an authorization request', () => {
  it('is a fault of the service in each check: a throw, never a pass and never a refusal of a rule', async () => {
    const { insurer, advert, duplicate } = rig();
    const broken = handoffOf(priorRequest({ justification: '' }));
    for (const check of [insurer, advert, duplicate]) {
      await expect(check.run(broken, CONTEXT), check.names[0]).rejects.toBeInstanceOf(TypeError);
      expect(await check.run(handoffOf(), CONTEXT).then((result) => result.ok, () => false), check.names[0]).toBe(true);
    }
  });

  it('is refused with a message that names the member and never repeats the value', async () => {
    const failure = await rig().insurer.run(handoffOf(priorRequest({ order_id: 'secret value?' })), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).not.toContain('secret value');
    expect((failure as TypeError).message).toContain('order_id');
  });

  it('is a document with a member that the request does not list, or without a member that it lists', async () => {
    const { advert } = rig();
    await expect(advert.run(handoffOf({ ...PRIOR_REQUEST, advert_model: 'insurer-intake-agent-v1' }), CONTEXT)).rejects.toBeInstanceOf(TypeError);
    const missing = Object.fromEntries(Object.entries(PRIOR_REQUEST).filter(([name]) => name !== 'advert_ref'));
    await expect(advert.run(handoffOf(missing), CONTEXT)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('a handoff for another use case', () => {
  it('is a fault of the service in each check: a throw, never a pass, also when the request that it carries passes the check', async () => {
    const { insurer, advert, duplicate } = rig();
    const other = handoffOf(PRIOR_REQUEST, { use_case: 'inventory-reorder' });
    for (const check of [insurer, advert, duplicate]) {
      await expect(check.run(other, CONTEXT), check.names[0]).rejects.toBeInstanceOf(TypeError);
      // The twin: the same request in a handoff for use case 2 (prior authorization) passes.
      expect(await check.run(handoffOf(), CONTEXT).then((result) => result.ok, () => false), check.names[0]).toBe(true);
    }
  });

  it('is refused with a message that names the use case that is right and not the value that came', async () => {
    const failure = await rig().insurer.run(handoffOf(PRIOR_REQUEST, { use_case: 'inventory-reorder' }), CONTEXT).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TypeError).message).toContain('use case 2 (prior authorization)');
    expect((failure as TypeError).message).not.toContain('inventory');
  });
});
