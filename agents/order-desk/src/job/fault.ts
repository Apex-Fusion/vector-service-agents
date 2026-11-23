// agents/order-desk/src/job/fault.ts
// The one fault of the Order Desk: `confirm_wrong_lot`. A fault makes an agent do one wrong thing on purpose in a failure run, so that the Reorder Agent and the checks can show how they answer. With this
// fault the order that the Order Desk places and the confirmation that it returns name another lot, and the size of that lot, than the purchase order.
//
// The fault changes WHAT the job sends, and never a check: no check of the Order Desk takes a fault value, and the hook does not know that the fault exists. The fault is on for the value
// `confirm_wrong_lot` and for no other value. The empty setting, and any text that is not exactly that value, is a clean run. The job reads the value from the switch that the service made at its start
// (`readFaultSwitch` of the kit refuses every other value there), and nothing else turns the fault on: not the body of a request, not the context of a call, not the environment.
import { lotSizeOf } from '@vsa/usecase-kit/inventory';
import type { LotName, LotsFile, PurchaseOrder } from '@vsa/usecase-kit/inventory';
import type { FaultMode, FaultSetting } from '@vsa/usecase-kit/protocol';

/** The one fault value of the Order Desk. The type holds it to a value that the kit lists for this kind of agent. */
const CONFIRM_WRONG_LOT: FaultMode<'order-desk'> = 'confirm_wrong_lot';

/** The wrong lot for a lot: `lot-small` gives `lot-medium`, and any other lot gives `lot-small`. It is never the lot that it was given. */
export function wrongLotOf(lot: LotName): LotName {
  return lot === 'lot-small' ? 'lot-medium' : 'lot-small';
}

/** The lot of an order and its quantity. */
export interface OrderedLot {
  readonly lot: LotName;
  readonly quantity: number;
}

/**
 * The lot and the quantity that the job orders and confirms. For a clean run they are the lot and the quantity of the purchase order. For the value `confirm_wrong_lot` they are the wrong lot of the
 * order and the size of that lot for the SKU in the lots file. The result is null when the fault is on and the lots file does not list the SKU: the job has no size to confirm, and it never makes one up.
 */
export function orderedOf(mode: FaultSetting<'order-desk'>, order: PurchaseOrder, lots: LotsFile): OrderedLot | null {
  if (mode !== CONFIRM_WRONG_LOT) return { lot: order.lot, quantity: order.quantity };
  const lot = wrongLotOf(order.lot);
  const quantity = lotSizeOf(lots, order.sku, lot);
  return quantity === null ? null : { lot, quantity };
}
