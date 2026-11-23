// agents/reorder-agent/src/model/index.ts
// What the Reorder Agent knows of its request, of the stock, of the two model decisions and of its supplier. Every source of data comes in through a port or a parameter: this folder reads no file,
// no environment variable and no key, and it does not import the folders of the flows (`propose`, `execute` and `serve`).
//
//   intake     the two fields of a `propose` request
//   stock      the stock reading of the ERP, and its hash
//   decisions  the decisions `reorder` and `accept_delivery`: the fixed text, the input and the parser of the choice
//   supplier   the reader of the supplier: the adverts of its Order Desk, its manifest and its lots file, each read on its source and checked against its hash
export { parseProposeFields } from './intake.ts';
export type { ProposeFields } from './intake.ts';
export { parseStockReading, stockReadingSha256 } from './stock.ts';
export type { StockReading } from './stock.ts';
export { ACCEPT_DECISION, REORDER_DECISION, acceptInput, reorderInput } from './decisions.ts';
export type { AcceptChoice, ReorderChoice } from './decisions.ts';
export { SUPPLIER_FAILURES, SUPPLIER_FETCH_TIMEOUT_MS, SUPPLIER_FILE_MAX_BYTES, SUPPLIER_READ_BUDGET_MS, readSupplier } from './supplier.ts';
export type { AdvertRead, FetchLimits, FetchedBytes, SupplierDeps, SupplierFailureCode, SupplierRow, SupplierView } from './supplier.ts';
