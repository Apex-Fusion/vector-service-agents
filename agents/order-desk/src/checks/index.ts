// agents/order-desk/src/checks/index.ts
// The hook of the Order Desk: what it checks before the runtime claims an escrow. The four checks that follow the shared checks of the use-case kit, the order book, the lots file, the record of the checks that
// passed (which the job takes later), and the pre-check itself, with the challenge that follows a refusal for `approval_digest_mismatch`. This folder imports neither the job nor the server.
export { orderChecks } from './extra.ts';
export type { OrderChecksDeps } from './extra.ts';
export { FileOrderBook, MemoryOrderBook, ORDER_BOOK_LIMIT } from './book.ts';
export type { BookFs, FileOrderBookOptions, OrderBook } from './book.ts';
export { loadLots } from './lots.ts';
export type { LoadedLots } from './lots.ts';
export { PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS, PassedChecks } from './passed.ts';
export type { PassedEntry } from './passed.ts';
