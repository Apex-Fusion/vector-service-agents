// packages/usecase-kit/test/protocol/request.test.ts: the two requests of a buyer-side agent, `propose` and `execute`, and the proposal. Each refusal has an accepted twin. No input makes a parser
// throw, and a refusal never repeats a value of the request.
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  accepted, checkMembers, makeProposal, parseAuthority, parseDid, parseProposal, parseRequest, parseTenantId, proposalDigest, refused,
} from '@vsa/usecase-kit/protocol';
import type { ExecuteRequest, ProposeFieldsParser, ProposeRequest, Proposal, ProtocolResult, UseCaseRequest } from '@vsa/usecase-kit/protocol';
import { APPROVAL, AUTHORITY, BAD_MARKER, DELEGATION, DID_A, DID_B, DOCUMENT, MARKER, SALT, TENANT, copy } from './support.ts';

interface ReorderFields {
  readonly sku: string;
  readonly supplier_did: string;
}

/** The use-case parser of the first buyer-side agent: a SKU of 1 to 64 characters and the DID of a supplier, and no other member. */
const parseReorderFields: ProposeFieldsParser<ReorderFields> = (fields) => {
  const members = checkMembers(fields, 'request', ['sku', 'supplier_did']);
  if (members !== null) return members;
  if (typeof fields.sku !== 'string' || fields.sku.length < 1 || fields.sku.length > 64) return refused('bad_shape', 'request.sku must be 1 to 64 characters');
  const supplier = parseDid(fields.supplier_did, 'request.supplier_did');
  if (!supplier.ok) return supplier;
  return accepted({ sku: fields.sku, supplier_did: supplier.value });
};

const made = makeProposal(DOCUMENT, SALT);
if (!made.ok) throw new Error('the sample proposal must be valid');
const PROPOSAL: Proposal = made.value;

const PROPOSE = { op: 'propose', authority: AUTHORITY, tenant: TENANT, sku: 'SKU-100', supplier_did: DID_B };
const EXECUTE = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: APPROVAL };

/** The refusal of a request, or a failed test when it was taken. */
function refusal(result: { ok: boolean; code?: string; detail?: string }): { code: string; detail: string } {
  expect(result.ok).toBe(false);
  return { code: result.code ?? '', detail: result.detail ?? '' };
}

describe('makeProposal', () => {
  it('makes the document, the salt and the digest of the proposal', () => {
    const expected = proposalDigest(SALT, DOCUMENT);
    expect(made).toStrictEqual({ ok: true, value: { document: DOCUMENT, salt: SALT, proposal_digest: expected.ok ? expected.value : 'no digest' } });
    expect(expected.ok).toBe(true);
  });

  it('makes a new salt when it is given none, and each salt is different', () => {
    const one = makeProposal(DOCUMENT);
    const two = makeProposal(DOCUMENT);
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) {
      expect(one.value.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(one.value.salt).not.toBe(two.value.salt);
      expect(one.value.proposal_digest).not.toBe(two.value.proposal_digest);
      expect(proposalDigest(one.value.salt, DOCUMENT)).toStrictEqual({ ok: true, value: one.value.proposal_digest });
    }
  });

  it('makes a proposal that parseProposal takes', () => {
    expect(parseProposal(made.ok ? made.value : null)).toStrictEqual(made);
  });

  it('refuses a salt that is not one, a document that is not one, and names the field', () => {
    expect(refusal(makeProposal(DOCUMENT, 'AB'.repeat(32))).detail).toContain('salt');
    expect(refusal(makeProposal([1], SALT)).detail).toContain('document');
    expect(refusal(makeProposal({ a: undefined }, SALT)).detail).toContain('document.a');
    expect(refusal(makeProposal(JSON.parse('{"__proto__":1}'), SALT)).code).toBe('bad_shape');
  });
});

describe('parseAuthority', () => {
  it('takes the DID of the principal and the delegation, and returns only these two members', () => {
    expect(parseAuthority({ ...AUTHORITY })).toStrictEqual({ ok: true, value: { principal_did: DID_A, delegation: DELEGATION } });
  });

  it.each([
    ['a vault, which the request does not have', { ...AUTHORITY, vault: `${'44'.repeat(32)}#0` }, 'authority has the member "vault", which is not allowed'],
    ['no delegation', { principal_did: DID_A }, 'authority has no member "delegation"'],
    ['no principal', { delegation: DELEGATION }, 'authority has no member "principal_did"'],
    ['a principal that is not a DID', { ...AUTHORITY, principal_did: 'ab'.repeat(32) }, 'authority.principal_did must be'],
    ['a delegation in upper case', { ...AUTHORITY, delegation: 'AB'.repeat(32) }, 'authority.delegation must be'],
    ['a short delegation', { ...AUTHORITY, delegation: '11'.repeat(31) }, 'authority.delegation must be'],
    ['an empty object', {}, 'authority has no member'],
  ])('refuses %s', (_name, value, expected) => {
    expect(refusal(parseAuthority(value))).toStrictEqual({ code: 'bad_shape', detail: expect.stringContaining(expected) });
  });

  it.each([null, undefined, [], 'text', 7, new Map()])('refuses %s as the authority', (value) => {
    expect(refusal(parseAuthority(value)).detail).toBe('authority must be a JSON object');
  });
});

describe('parseProposal', () => {
  it('takes a proposal whose digest is the digest of its document and its salt', () => {
    expect(parseProposal(copy(PROPOSAL))).toStrictEqual({ ok: true, value: PROPOSAL });
  });

  it('refuses a digest that is the right form and is not the digest of the document and the salt', () => {
    const wrong = { ...PROPOSAL, proposal_digest: '77'.repeat(32) };
    expect(refusal(parseProposal(wrong))).toStrictEqual({ code: 'bad_shape', detail: 'proposal.proposal_digest is not the digest of proposal.document and proposal.salt' });
  });

  it('refuses a digest that does not belong to the document, the salt or the order of the members of an array', () => {
    expect(refusal(parseProposal({ ...PROPOSAL, document: { ...DOCUMENT, quantity: 51 } })).detail).toContain('proposal.proposal_digest is not the digest');
    expect(refusal(parseProposal({ ...PROPOSAL, salt: '34'.repeat(32) })).detail).toContain('proposal.proposal_digest is not the digest');
    const ordered = makeProposal({ list: [1, 2] }, SALT);
    expect(ordered.ok && parseProposal(copy(ordered.value)).ok).toBe(true);
    expect(refusal(parseProposal({ ...(ordered.ok ? ordered.value : {}), document: { list: [2, 1] } })).detail).toContain('is not the digest');
  });

  it('takes the document with its keys in another order, because the digest is of the canonical form', () => {
    const shuffled = { ...PROPOSAL, document: Object.fromEntries(Object.entries(DOCUMENT).reverse()) };
    expect(parseProposal(shuffled).ok).toBe(true);
  });

  it.each([
    ['no document', { salt: SALT, proposal_digest: PROPOSAL.proposal_digest }, 'proposal has no member "document"'],
    ['no salt', { document: DOCUMENT, proposal_digest: PROPOSAL.proposal_digest }, 'proposal has no member "salt"'],
    ['no digest', { document: DOCUMENT, salt: SALT }, 'proposal has no member "proposal_digest"'],
    ['a fourth member', { ...PROPOSAL, extra: 1 }, 'proposal has the member "extra", which is not allowed'],
    ['a document that is an array', { ...PROPOSAL, document: [DOCUMENT] }, 'proposal.document must be a JSON object'],
    ['a document with the key __proto__', { ...PROPOSAL, document: JSON.parse('{"__proto__":{"a":1}}') }, 'proposal.document.__proto__'],
    ['a document with a value that JSON cannot hold', { ...PROPOSAL, document: { a: undefined } }, 'proposal.document.a'],
    ['a salt in upper case', { ...PROPOSAL, salt: 'AB'.repeat(32) }, 'proposal.salt must be'],
    ['a digest in upper case', { ...PROPOSAL, proposal_digest: PROPOSAL.proposal_digest.toUpperCase().replace(/[0-9]/g, 'A') }, 'proposal.proposal_digest must be'],
    ['a short digest', { ...PROPOSAL, proposal_digest: PROPOSAL.proposal_digest.slice(1) }, 'proposal.proposal_digest must be'],
  ])('refuses %s', (_name, value, expected) => {
    expect(refusal(parseProposal(value))).toStrictEqual({ code: 'bad_shape', detail: expect.stringContaining(expected) });
  });

  it.each([null, undefined, [], 'text', 7])('refuses %s as the proposal', (value) => {
    expect(refusal(parseProposal(value)).detail).toBe('proposal must be a JSON object');
  });
});

describe('parseRequest: propose', () => {
  it('takes a propose request and gives the shared members and the fields of the use case', () => {
    const result = parseRequest(copy(PROPOSE), parseReorderFields);
    expect(result).toStrictEqual({ ok: true, value: { op: 'propose', authority: AUTHORITY, tenant: TENANT, sku: 'SKU-100', supplier_did: DID_B } });
  });

  it('takes the members in any order', () => {
    const shuffled = { supplier_did: DID_B, tenant: TENANT, sku: 'SKU-100', authority: AUTHORITY, op: 'propose' };
    expect(parseRequest(shuffled, parseReorderFields).ok).toBe(true);
  });

  it('takes a propose request with no use-case fields when it is given no field parser, and refuses any other member', () => {
    expect(parseRequest({ op: 'propose', authority: AUTHORITY, tenant: TENANT })).toStrictEqual({ ok: true, value: { op: 'propose', authority: AUTHORITY, tenant: TENANT } });
    expect(refusal(parseRequest({ op: 'propose', authority: AUTHORITY, tenant: TENANT, sku: 'a' }))).toStrictEqual({ code: 'bad_shape', detail: 'request has the member "sku", which is not allowed' });
  });

  it('gives the field parser the members that are not op, authority and tenant, and no others', () => {
    let seen: string[] = [];
    const spy: ProposeFieldsParser<Record<never, never>> = (fields) => {
      seen = Object.keys(fields).sort();
      return accepted({});
    };
    parseRequest(copy(PROPOSE), spy);
    expect(seen).toStrictEqual(['sku', 'supplier_did']);
  });

  it('passes on the refusal of the field parser, as it is', () => {
    const result = parseRequest({ ...PROPOSE, sku: '' }, parseReorderFields);
    expect(refusal(result)).toStrictEqual({ code: 'bad_shape', detail: 'request.sku must be 1 to 64 characters' });
    expect(refusal(parseRequest({ ...PROPOSE, supplier_did: 'x' }, parseReorderFields)).detail).toContain('request.supplier_did must be');
    expect(refusal(parseRequest({ ...PROPOSE, extra: 1 }, parseReorderFields)).detail).toBe('request has the member "extra", which is not allowed');
  });

  it('keeps op, authority and tenant of the request, even when a field parser returns members with these names', () => {
    const cheat: ProposeFieldsParser<{ op: string; tenant: string; authority: string }> = () => accepted({ op: 'execute', tenant: 'other', authority: 'other' });
    const result = parseRequest({ op: 'propose', authority: AUTHORITY, tenant: TENANT }, cheat);
    expect(result.ok && result.value).toMatchObject({ op: 'propose', tenant: TENANT, authority: AUTHORITY });
  });

  it('refuses a missing authority or tenant, and names it', () => {
    const { authority: _authority, ...noAuthority } = PROPOSE;
    const { tenant: _tenant, ...noTenant } = PROPOSE;
    expect(refusal(parseRequest(noAuthority, parseReorderFields)).detail).toBe('authority must be a JSON object');
    expect(refusal(parseRequest(noTenant, parseReorderFields)).detail).toContain('tenant must be');
  });

  it.each([
    ['a vault in the authority', { ...PROPOSE, authority: { ...AUTHORITY, vault: `${'44'.repeat(32)}#0` } }, 'authority has the member "vault", which is not allowed'],
    ['an authority with no delegation', { ...PROPOSE, authority: { principal_did: DID_A } }, 'authority has no member "delegation"'],
    ['a delegation that is not 64 hex characters', { ...PROPOSE, authority: { ...AUTHORITY, delegation: 'abc' } }, 'authority.delegation must be'],
    ['a principal that is not a DID', { ...PROPOSE, authority: { ...AUTHORITY, principal_did: 'abc' } }, 'authority.principal_did must be'],
    ['a tenant with a slash', { ...PROPOSE, tenant: 'a/b' }, 'tenant must be'],
    ['an empty tenant', { ...PROPOSE, tenant: '' }, 'tenant must be'],
    ['a tenant that is a number', { ...PROPOSE, tenant: 7 }, 'tenant must be'],
  ])('refuses %s, and accepts the same request without it', (_name, request, expected) => {
    expect(refusal(parseRequest(request, parseReorderFields)).detail).toContain(expected);
    expect(parseRequest(copy(PROPOSE), parseReorderFields).ok).toBe(true);
  });

  it('refuses the key __proto__ as a member, so it cannot go round the field parser', () => {
    const request = JSON.parse(`{"op":"propose","authority":${JSON.stringify(AUTHORITY)},"tenant":"${TENANT}","sku":"a","supplier_did":"${DID_B}","__proto__":{"x":1}}`);
    expect(refusal(parseRequest(request, parseReorderFields)).detail).toBe('request has the member "__proto__", which is not allowed');
    expect(refusal(parseRequest(JSON.parse(`{"op":"propose","authority":${JSON.stringify(AUTHORITY)},"tenant":"${TENANT}","__proto__":1}`))).detail).toContain('__proto__');
  });
});

describe('parseRequest: execute', () => {
  it('takes an execute request with a proposal and an approval', () => {
    const result = parseRequest(copy(EXECUTE));
    expect(result).toStrictEqual({ ok: true, value: { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: APPROVAL } });
  });

  it('takes an execute request with no approval, which is null, and passes the null on', () => {
    const result = parseRequest({ ...copy(EXECUTE), approval: null });
    expect(result).toStrictEqual({ ok: true, value: { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: PROPOSAL, approval: null } });
  });

  it('refuses an execute request that leaves the approval out, and names the member', () => {
    const { approval: _approval, ...noApproval } = copy(EXECUTE);
    expect(refusal(parseRequest(noApproval))).toStrictEqual({ code: 'bad_shape', detail: 'request has no member "approval"' });
  });

  it('does not take the field parser into account for execute, and takes no member of a use case', () => {
    expect(parseRequest(copy(EXECUTE), parseReorderFields).ok).toBe(true);
    expect(refusal(parseRequest({ ...copy(EXECUTE), sku: 'SKU-100' }, parseReorderFields)).detail).toBe('request has the member "sku", which is not allowed');
  });

  it.each([
    ['a vault in the authority', { ...EXECUTE, authority: { ...AUTHORITY, vault: `${'44'.repeat(32)}#0` } }, 'authority has the member "vault", which is not allowed'],
    ['no proposal', { op: 'execute', authority: AUTHORITY, tenant: TENANT, approval: APPROVAL }, 'request has no member "proposal"'],
    ['a proposal that is a string', { ...EXECUTE, proposal: 'abc' }, 'proposal must be a JSON object'],
    ['a proposal with a digest that is not the digest of the document', { ...EXECUTE, proposal: { ...PROPOSAL, proposal_digest: '77'.repeat(32) } }, 'proposal.proposal_digest is not the digest'],
    ['a proposal with a fourth member', { ...EXECUTE, proposal: { ...PROPOSAL, extra: 1 } }, 'proposal has the member "extra", which is not allowed'],
    ['an approval that is a string', { ...EXECUTE, approval: 'abc' }, 'approval must be a JSON object'],
    ['an approval with no issuer', { ...EXECUTE, approval: { attestation: APPROVAL.attestation } }, 'approval has no member "issuer_did"'],
    ['an approval with a third member', { ...EXECUTE, approval: { ...APPROVAL, valid_until: 1 } }, 'approval has the member "valid_until", which is not allowed'],
    ['an approval with an attestation in upper case', { ...EXECUTE, approval: { ...APPROVAL, attestation: 'AB'.repeat(32) } }, 'approval.attestation must be'],
    ['an approval that is undefined', { ...EXECUTE, approval: undefined }, 'approval must be a JSON object'],
    ['a member of a use case', { ...EXECUTE, sku: 'SKU-100' }, 'request has the member "sku", which is not allowed'],
    ['a tenant that is not a tenant', { ...EXECUTE, tenant: 'a b' }, 'tenant must be'],
  ])('refuses %s', (_name, request, expected) => {
    expect(refusal(parseRequest(request)).detail).toContain(expected);
  });

  it('checks the members before it reads their values: an execute request with a missing member is refused for the member', () => {
    expect(refusal(parseRequest({ op: 'execute', authority: 'broken', tenant: TENANT, approval: null })).detail).toBe('request has no member "proposal"');
  });

  it('refuses the key __proto__ as a member of an execute request', () => {
    const request = JSON.parse(`{"op":"execute","authority":${JSON.stringify(AUTHORITY)},"tenant":"${TENANT}","proposal":${JSON.stringify(PROPOSAL)},"approval":null,"__proto__":{"x":1}}`);
    expect(refusal(parseRequest(request)).detail).toBe('request has the member "__proto__", which is not allowed');
  });
});

describe('parseRequest: the operation and the shape of the request', () => {
  it.each([
    ['an operation that is not known', { ...PROPOSE, op: 'cancel' }],
    ['an operation in upper case', { ...PROPOSE, op: 'PROPOSE' }],
    ['an operation with a space', { ...PROPOSE, op: 'propose ' }],
    ['an empty operation', { ...PROPOSE, op: '' }],
    ['an operation that is a number', { ...PROPOSE, op: 7 }],
    ['an operation that is null', { ...PROPOSE, op: null }],
    ['an operation that is a list', { ...PROPOSE, op: ['propose'] }],
    ['no operation', { authority: AUTHORITY, tenant: TENANT, sku: 'a', supplier_did: DID_B }],
  ])('refuses %s with bad_shape, and accepts the request with the operation propose', (_name, request) => {
    expect(refusal(parseRequest(request, parseReorderFields))).toStrictEqual({ code: 'bad_shape', detail: 'request.op must be "propose" or "execute"' });
    expect(parseRequest({ ...request, op: 'propose' }, parseReorderFields).ok).toBe(true);
  });

  it.each([null, undefined, [], [PROPOSE], 'propose', 7, true, () => 1, Symbol('s'), 10n, new Map(), new Date(0)])('refuses %s as the request', (value) => {
    expect(refusal(parseRequest(value, parseReorderFields))).toStrictEqual({ code: 'bad_shape', detail: 'request must be a JSON object' });
  });

  it('takes a request that JSON.parse made, and returns members that are checked', () => {
    const request = JSON.parse(JSON.stringify(PROPOSE));
    expect(parseRequest(request, parseReorderFields).ok).toBe(true);
    const execute = JSON.parse(JSON.stringify(EXECUTE));
    expect(parseRequest(execute).ok).toBe(true);
  });

  it('does not change the request that it is given', () => {
    const request = copy(EXECUTE);
    const before = JSON.stringify(request);
    parseRequest(request);
    expect(JSON.stringify(request)).toBe(before);
  });
});

describe('parseRequest never throws and never repeats a value', () => {
  const deep = JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`);
  const circular: Record<string, unknown> = { op: 'execute', authority: AUTHORITY, tenant: TENANT, approval: null };
  circular.proposal = { document: circular, salt: SALT, proposal_digest: PROPOSAL.proposal_digest };
  const inputs: ReadonlyArray<readonly [string, unknown]> = [
    ['a document 100,000 levels deep', { ...EXECUTE, proposal: { ...PROPOSAL, document: deep } }],
    ['a document that holds itself', circular],
    ['a request with a very long member name', { ...PROPOSE, ['m'.repeat(100_000)]: 1 }],
    ['a request with a very long tenant', { ...PROPOSE, tenant: 't'.repeat(1_000_000) }],
    ['a proposal with a symbol key', { ...EXECUTE, proposal: { ...PROPOSAL, [Symbol('s')]: 1 } }],
    ['an object with a getter that does not throw', Object.defineProperty({ op: 'propose', authority: AUTHORITY }, 'tenant', { get: () => TENANT, enumerable: true })],
  ];

  it.each(inputs)('does not throw on %s', (_name, input) => {
    expect(() => parseRequest(input, parseReorderFields)).not.toThrow();
    expect(() => parseRequest(input)).not.toThrow();
  });

  it('gives a refusal for the hostile documents', () => {
    for (const [name, input] of inputs.slice(0, 2)) expect(parseRequest(input).ok, name).toBe(false);
  });

  it('never repeats the value that failed, and keeps the detail short', () => {
    const values = [
      { ...PROPOSE, tenant: BAD_MARKER },
      { ...PROPOSE, authority: { ...AUTHORITY, delegation: BAD_MARKER } },
      { ...PROPOSE, op: BAD_MARKER },
      { ...EXECUTE, approval: { ...APPROVAL, issuer_did: BAD_MARKER } },
      { ...EXECUTE, proposal: { ...PROPOSAL, salt: BAD_MARKER } },
      { ...EXECUTE, proposal: { ...PROPOSAL, document: { a: [MARKER, undefined] } } },
    ];
    for (const value of values) {
      const result = parseRequest(value, parseReorderFields);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.detail).not.toContain(BAD_MARKER);
        expect(result.detail).not.toContain(MARKER);
        expect(result.detail.length).toBeLessThan(300);
      }
    }
    const longName = parseRequest({ ...PROPOSE, ['m'.repeat(100_000)]: 1 }, parseReorderFields);
    expect(!longName.ok && longName.detail.length).toBeLessThan(300);
  });
});

describe('the types of a request', () => {
  it('give propose the shared members and the fields of the use case, and execute the proposal and the approval', () => {
    const result = parseRequest(copy(PROPOSE), parseReorderFields);
    expectTypeOf(result).toEqualTypeOf<ProtocolResult<UseCaseRequest<ReorderFields>>>();
    if (result.ok) {
      const request: UseCaseRequest<ReorderFields> = result.value;
      if (request.op === 'propose') {
        expectTypeOf(request).toEqualTypeOf<ProposeRequest<ReorderFields>>();
        expect(request.sku).toBe('SKU-100');
      } else {
        expectTypeOf(request).toEqualTypeOf<ExecuteRequest>();
        expect.unreachable('the operation was propose');
      }
    }
  });

  it('let the approval of an execute request be null', () => {
    expectTypeOf<ExecuteRequest['approval']>().toEqualTypeOf<{ readonly attestation: string; readonly issuer_did: string } | null>();
  });

  it('give the authority a principal and a delegation and no vault', () => {
    expectTypeOf<ExecuteRequest['authority']>().toEqualTypeOf<{ readonly principal_did: string; readonly delegation: string }>();
    // @ts-expect-error the authority has no vault
    const withVault: ExecuteRequest['authority'] = { ...AUTHORITY, vault: 'x' };
    expect(withVault.delegation).toBe(DELEGATION);
  });

  it('check the tenant with parseTenantId', () => {
    expect(parseTenantId(TENANT).ok).toBe(true);
  });
});
