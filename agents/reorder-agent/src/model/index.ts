// agents/reorder-agent/src/model/index.ts
// What the Reorder Agent knows of its request, of the stock, of the two model decisions and of its supplier. Every source of data comes in through a port or a parameter: this folder reads no file,
// no environment variable and no key, and it does not import the folders of the flows (`propose`, `execute` and `serve`).
//
//   intake    the two fields of a `propose` request
//   stock     the stock reading of the ERP, and its hash
export { parseProposeFields } from './intake.ts';
export type { ProposeFields } from './intake.ts';
export { parseStockReading, stockReadingSha256 } from './stock.ts';
export type { StockReading } from './stock.ts';
