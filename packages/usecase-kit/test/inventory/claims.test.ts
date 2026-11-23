// packages/usecase-kit/test/inventory/claims.test.ts: the claim statements of the two agents of use case 1 (inventory reorder). The manifest of an agent, its claim document and the challenge of the other agent
// all use these constants, so a challenge names the text that the claim holds. The texts below are the golden texts: a change of a word shows here.
import { describe, expect, it } from 'vitest';
import { claimDocument, readClaimDocument } from '@vsa/usecase-kit/dispute';
import { MAX_STATEMENT_CHARS, buildClaim, parseClaim } from '@vsa/usecase-kit/manifest';
import { INVENTORY_CAPABILITIES, ORDER_DESK_CLAIM, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import { expectRefused, must } from './support.ts';

const REORDER_TEXTS = [
  'An order this agent places is the purchase order whose digest its hirer approved.',
  'This agent accepts only a confirmation that names the SKU and the lot of the purchase order it answers.',
  'This agent pays a supplier only from the vault of the delegation it was given.',
] as const;

const ORDER_DESK_TEXTS = [
  'A confirmation names the SKU, the lot and the quantity of the purchase order it answers.',
  'This agent places one order per purchase order number.',
  'This agent takes no purchase order without a valid approval by the buyer whose delegation paid for it.',
] as const;

const AGENT = `did:vector:${'ec'.repeat(32)}`;
const MANIFEST_SHA = 'ab'.repeat(32);

const CLAIMS = [
  ['the Reorder Agent', REORDER_CLAIM, REORDER_TEXTS, INVENTORY_CAPABILITIES.reorder],
  ['the Order Desk', ORDER_DESK_CLAIM, ORDER_DESK_TEXTS, INVENTORY_CAPABILITIES.order],
] as const;

describe('the capabilities', () => {
  it('are the capability of the Reorder Agent and the capability of the Order Desk', () => {
    expect(INVENTORY_CAPABILITIES).toStrictEqual({ reorder: 'supplychain.reorder.po.v1', order: 'supplychain.order.accept.v1' });
  });

  it('cannot be changed', () => {
    expect(Object.isFrozen(INVENTORY_CAPABILITIES)).toBe(true);
    expect(Reflect.set(INVENTORY_CAPABILITIES, 'order', 'other')).toBe(false);
    expect(Reflect.deleteProperty(INVENTORY_CAPABILITIES, 'reorder')).toBe(false);
    expect(INVENTORY_CAPABILITIES.order).toBe('supplychain.order.accept.v1');
  });
});

describe.each(CLAIMS)('the claim of %s', (_name, claim, texts, capability) => {
  it('has exactly three statements, with the ids S1, S2 and S3 in this order, and no claim reference', () => {
    expect(Object.keys(claim)).toStrictEqual(['statements']);
    expect(claim.statements).toHaveLength(3);
    expect(claim.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    for (const statement of claim.statements) expect(Object.keys(statement)).toStrictEqual(['id', 'text']);
  });

  it('holds the texts of the statements word for word', () => {
    expect(claim.statements.map((statement) => statement.text)).toStrictEqual([...texts]);
  });

  it('holds plain texts: one line, no control character, no space at either end, and the NFC form', () => {
    for (const { text } of claim.statements) {
      expect(text, text).toBe(text.trim());
      expect(text, text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(text, text).toBe(text.normalize('NFC'));
      expect(text.length, text).toBeGreaterThan(0);
      expect(text.endsWith('.'), text).toBe(true);
    }
  });

  it('holds texts that the manifest can hold: at most the longest statement, and three different texts', () => {
    for (const { text } of claim.statements) expect(text.length, text).toBeLessThanOrEqual(MAX_STATEMENT_CHARS);
    expect(new Set(claim.statements.map((statement) => statement.text)).size).toBe(3);
  });

  it('is taken by the claim parser of the manifest folder, and the copy is the claim', () => {
    expect(parseClaim(claim)).toStrictEqual({ ok: true, value: claim });
    expect(must(parseClaim(claim))).not.toBe(claim);
  });

  it('is the claim that the builder of the manifest folder makes from its three texts', () => {
    expect(buildClaim([...texts])).toStrictEqual({ ok: true, value: claim });
  });

  it('is taken by the claim document of the dispute folder, which writes one row for each statement, and the document reads back as the claim', () => {
    const document = must(claimDocument({ agent_did: AGENT, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim }));
    texts.forEach((text, index) => expect(document.text).toContain(`\nS${index + 1}: ${text}\n`));
    expect(must(readClaimDocument(document.bytes))).toStrictEqual({ agent_did: AGENT, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim });
  });

  it('cannot be changed: the claim, its list and each statement are frozen', () => {
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.isFrozen(claim.statements)).toBe(true);
    for (const statement of claim.statements) expect(Object.isFrozen(statement)).toBe(true);
    expect(Reflect.set(claim.statements[0], 'text', 'changed')).toBe(false);
    expect(Reflect.set(claim, 'statements', [])).toBe(false);
    expect(() => Array.prototype.push.call(claim.statements, { id: 'S4', text: 'a fourth statement' })).toThrow(TypeError);
    expect(claim.statements.map((statement) => statement.text)).toStrictEqual([...texts]);
  });
});

describe('the two claims', () => {
  it('share no text: a challenge that names one text cannot be read as a challenge of the other claim', () => {
    const all = [...REORDER_CLAIM.statements, ...ORDER_DESK_CLAIM.statements].map((statement) => statement.text);
    expect(new Set(all).size).toBe(6);
  });

  it('are two different claims, and each is used by the agent of its capability', () => {
    expect(REORDER_CLAIM).not.toStrictEqual(ORDER_DESK_CLAIM);
    expect(REORDER_CLAIM.statements[0].text).toContain('digest its hirer approved');
    expect(ORDER_DESK_CLAIM.statements[0].text).toContain('the SKU, the lot and the quantity');
  });

  it('refuses a claim with a line break in a text, in the claim document of the dispute folder, so that the rule of plain text is the rule that holds for these texts', () => {
    const broken: ManifestClaim = { statements: [{ id: 'S1', text: 'A text with a\nline break.' }, REORDER_CLAIM.statements[1], REORDER_CLAIM.statements[2]] };
    expectRefused(claimDocument({ agent_did: AGENT, capability_id: INVENTORY_CAPABILITIES.reorder, manifest_sha256: MANIFEST_SHA, claim: broken }), 'statements[0].text');
    expect(claimDocument({ agent_did: AGENT, capability_id: INVENTORY_CAPABILITIES.reorder, manifest_sha256: MANIFEST_SHA, claim: REORDER_CLAIM }).ok).toBe(true);
  });
});
