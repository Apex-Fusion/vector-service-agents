// packages/usecase-kit/test/protocol/schemas.test.ts: the schema names of the three documents, one for each use case, and the use cases that have a handoff. Names only: the shape of each document
// belongs to the agent that writes it.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DOCUMENT_SCHEMAS, HANDOFF_USE_CASES, USE_CASES } from '@vsa/usecase-kit/protocol';
import type { DocumentSchema, HandoffUseCase, UseCase } from '@vsa/usecase-kit/protocol';

describe('DOCUMENT_SCHEMAS', () => {
  it('names the purchase order, the prior-authorization request and the ranking, keyed by the use case', () => {
    expect({ ...DOCUMENT_SCHEMAS }).toStrictEqual({
      'inventory-reorder': 'vector.usecase.po.v1',
      'prior-authorization': 'vector.usecase.priorauth-request.v1',
      'bid-evaluation': 'vector.usecase.ranking.v1',
    });
  });

  it('has a name for each use case and for no other key, and no name twice', () => {
    expect(Object.keys(DOCUMENT_SCHEMAS).sort()).toStrictEqual([...USE_CASES].sort());
    expect(new Set(Object.values(DOCUMENT_SCHEMAS)).size).toBe(USE_CASES.length);
  });

  it('has the form vector.usecase.<name>.v1 for each name, and none of them is the schema of a message', () => {
    for (const name of Object.values(DOCUMENT_SCHEMAS)) expect(name).toMatch(/^vector\.usecase\.[a-z-]+\.v1$/);
    for (const message of ['proposal', 'result', 'handoff', 'rfq']) expect(Object.values(DOCUMENT_SCHEMAS)).not.toContain(`vector.usecase.${message}.v1`);
  });

  it('has types that follow the table', () => {
    expectTypeOf<DocumentSchema>().toEqualTypeOf<'vector.usecase.po.v1' | 'vector.usecase.priorauth-request.v1' | 'vector.usecase.ranking.v1'>();
    expectTypeOf(DOCUMENT_SCHEMAS['bid-evaluation']).toEqualTypeOf<'vector.usecase.ranking.v1'>();
  });
});

describe('HANDOFF_USE_CASES', () => {
  it('are use case 1 and use case 2: use case 3 has no handoff, because a bid desk gets a request for quotation', () => {
    expect([...HANDOFF_USE_CASES]).toStrictEqual(['inventory-reorder', 'prior-authorization']);
    expect(HANDOFF_USE_CASES).not.toContain('bid-evaluation');
    for (const name of HANDOFF_USE_CASES) expect(USE_CASES).toContain(name);
  });

  it('has a type that leaves out bid-evaluation', () => {
    expectTypeOf<HandoffUseCase>().toEqualTypeOf<'inventory-reorder' | 'prior-authorization'>();
    expectTypeOf<HandoffUseCase>().toExtend<UseCase>();
    expectTypeOf<'bid-evaluation'>().not.toExtend<HandoffUseCase>();
  });
});
