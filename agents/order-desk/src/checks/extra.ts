// agents/order-desk/src/checks/extra.ts
// The four checks of the Order Desk that follow the shared checks of the use-case kit (the sender, the delegation, the payment from a vault and the approval). They run in the order of the page of the Order
// Desk, and the first refusal is the answer:
//
//   12  for_this_supplier  the purchase order names this agent                                                 not_for_this_supplier
//   13  lot                the advert and the lot of the order are the advert and the lot that were paid for   lot_mismatch
//   14  quantity           the quantity is the size of that lot for the SKU, in the lots file                  quantity_mismatch
//   15  not_duplicate      the order book holds no order for the purchase order number of the tenant           duplicate_po
//
// The advert and the lot come from the job context of the runtime, which read them from the escrow on the ledger: the advert that the escrow was posted on, and the model of that advert, which is the lot. A
// member of the body never chooses them. The body names an advert and a lot too (a buyer says what it wants), and each check compares the body with the context. The quantity is the size of the lot of the
// advert, and not the size of the lot that the body names.
//
// A check answers a refusal of a rule as data: `{ ok: false, code, detail }` with a fixed sentence that names no value of the request. A source that cannot be read is another thing: the order book that
// rejects, and the order book that answers with something that is not true or false, are `CheckUnavailableError`, and the run turns it into `check_unavailable` (503). Only `false` is a pass. The document
// of the handoff is a purchase order after the parser of the service. A document that is not one is a fault of the service: the check throws a TypeError, and a throw is never a go.
import { CheckUnavailableError } from '@vsa/usecase-kit/checks';
import type { ExtraCheck } from '@vsa/usecase-kit/checks';
import { isLotName, lotSizeOf, parseLotsFile, parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { LotsFile, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import { accepted, isPlainObject, parseDid, refused } from '@vsa/usecase-kit/protocol';
import type { Did, Handoff } from '@vsa/usecase-kit/protocol';
import type { OrderBook } from './book.ts';

export interface OrderChecksDeps {
  /** The lots file that the Order Desk serves: the size of each lot for each SKU. The checks keep their own copy. */
  readonly lots: LotsFile;
  readonly book: OrderBook;
  /** The DID of this agent: the supplier that a purchase order must name. */
  readonly self: Did;
  /**
   * Called with the source and the cause of a read of the book that failed. The cause is for the log of the service and never for the buyer: the message of a failed read can name a path.
   * A function that throws changes nothing.
   */
  readonly onFault?: (source: string, cause: unknown) => void;
}

/** The purchase order of a handoff. A document that is not one is a fault of the service: the parser of the service refuses it before the hook. The message names the member and never repeats the value. */
function orderOf(request: Handoff): PurchaseOrder {
  const parsed = parsePurchaseOrder(request.document, 'handoff.document');
  if (!parsed.ok) throw new TypeError(`the document of the handoff is not a purchase order: ${parsed.detail}`);
  return parsed.value;
}

/**
 * The checks 12 to 15, in the order of the page. It throws a TypeError for input of the wrong form: a lots file that is not a lots file, a supplier that is no DID, a book that cannot answer, and a hook
 * for faults that is not a function.
 */
export function orderChecks(deps: OrderChecksDeps): readonly ExtraCheck<Handoff>[] {
  if (!isPlainObject(deps)) throw new TypeError('the checks of the Order Desk need the lots file, the order book and the DID of the agent');
  const parsedLots = parseLotsFile(deps.lots);
  if (!parsedLots.ok) throw new TypeError(`the lots file of the checks is wrong: ${parsedLots.detail}`);
  const lots = parsedLots.value;
  const parsedSelf = parseDid(deps.self, 'self');
  if (!parsedSelf.ok) throw new TypeError(`the DID of the agent is wrong: ${parsedSelf.detail}`);
  const self = parsedSelf.value;
  const { book, onFault } = deps;
  if (typeof book !== 'object' || book === null || typeof book.has !== 'function') throw new TypeError('the order book must have the function has');
  if (onFault !== undefined && typeof onFault !== 'function') throw new TypeError('onFault must be a function');
  const report = (cause: unknown): void => {
    try {
      onFault?.('order book', cause);
    } catch {
      // A hook that fails must not change the answer of a check.
    }
  };

  return [
    {
      names: ['for_this_supplier'],
      run: async (request) => (orderOf(request).supplier_did === self ? accepted({}) : refused('not_for_this_supplier', 'the purchase order is for another supplier')),
    },
    {
      names: ['lot'],
      run: async (request, context) => {
        const order = orderOf(request);
        if (order.advert_ref !== context.advertRef) return refused('lot_mismatch', 'the purchase order is not for the advert that the escrow was posted on');
        if (order.lot !== context.advertModel) return refused('lot_mismatch', 'the lot of the purchase order is not the lot that the escrow paid for');
        return accepted({});
      },
    },
    {
      names: ['quantity'],
      run: async (request, context) => {
        const order = orderOf(request);
        const size = isLotName(context.advertModel) ? lotSizeOf(lots, order.sku, context.advertModel) : null;
        if (size === null) return refused('quantity_mismatch', 'the lots file has no size for this SKU and this lot');
        return order.quantity === size ? accepted({}) : refused('quantity_mismatch', 'the quantity of the purchase order is not the size of the lot');
      },
    },
    {
      names: ['not_duplicate'],
      run: async (request) => {
        const order = orderOf(request);
        let known: unknown;
        try {
          known = await book.has(order.tenant, order.po_number);
        } catch (cause) {
          report(cause);
          throw new CheckUnavailableError('order book');
        }
        if (known === false) return accepted({});
        if (known === true) return refused('duplicate_po', 'the order book holds an order for this purchase order number');
        report(new TypeError('the order book answered with a value that is not true or false'));
        throw new CheckUnavailableError('order book');
      },
    },
  ];
}
