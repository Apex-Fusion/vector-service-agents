// packages/usecase-kit/src/inventory/index.ts
// The documents of use case 1 (inventory reorder) that the Reorder Agent and the Order Desk share: the purchase order, the lots file, the order confirmation, the lot names, and the claim statements and the
// capabilities of the two agents. The two agents are two packages and they do not import each other, so the kit holds what both read. Each document has a strict parser that returns a copy.
// Import it as `@vsa/usecase-kit/inventory`.
//
//   lots          the lot names, and the lots file that the Order Desk serves (its hash is the hash of its bytes)
//   order         the purchase order, which is the document of a proposal, and the number of a purchase order
//   confirmation  the order confirmation, with its 16 checks
//   claims        the capabilities of the two agents, and their claim statements
export { LOT_NAMES, LOTS_SCHEMA, isLotName, lotSizeOf, lotsFileSha256, parseLotsFile } from './lots.ts';
export type { LotName, LotsFile } from './lots.ts';
export { PO_SCHEMA, parsePurchaseOrder, poNumberOf } from './order.ts';
export type { PurchaseOrder } from './order.ts';
export { CONFIRMATION_CHECKS, CONFIRMATION_SCHEMA, parseOrderConfirmation } from './confirmation.ts';
export type { OrderConfirmation } from './confirmation.ts';
