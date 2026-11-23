// packages/usecase-kit/src/inventory/claims.ts
// The capabilities and the claim statements of the two agents of use case 1 (inventory reorder). The two agents are two packages and they do not import each other, so the kit holds what both read.
//
// The manifest of an agent, its claim document and the challenge of the other agent all use these constants. A challenge names the text of a statement, and the text must be the text that the claim
// document of the other agent holds, so there is one text for each statement and it stands here. A claim has three statements with the ids S1, S2 and S3 and no reference to a claim: a claim is staked
// for each run. Each text is plain: one line, no control character, and no space at either end.
//
// The constants are frozen, so that no code changes a text that two agents compare.
import type { ManifestClaim } from '../protocol/index.ts';

/** The capability of the Reorder Agent and the capability of the Order Desk. A job of the Reorder Agent hires the Order Desk, and a challenge names both. */
export const INVENTORY_CAPABILITIES = Object.freeze({ reorder: 'supplychain.reorder.po.v1', order: 'supplychain.order.accept.v1' } as const);

function claimOf(first: string, second: string, third: string): ManifestClaim {
  return Object.freeze({
    statements: Object.freeze([Object.freeze({ id: 'S1', text: first }), Object.freeze({ id: 'S2', text: second }), Object.freeze({ id: 'S3', text: third })] as const),
  });
}

/** The claim of the Reorder Agent. */
export const REORDER_CLAIM: ManifestClaim = claimOf(
  'An order this agent places is the purchase order whose digest its hirer approved.',
  'This agent accepts only a confirmation that names the SKU and the lot of the purchase order it answers.',
  'This agent pays a supplier only from the vault of the delegation it was given.',
);

/** The claim of the Order Desk. */
export const ORDER_DESK_CLAIM: ManifestClaim = claimOf(
  'A confirmation names the SKU, the lot and the quantity of the purchase order it answers.',
  'This agent places one order per purchase order number.',
  'This agent takes no purchase order without a valid approval by the buyer whose delegation paid for it.',
);
