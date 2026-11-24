// agents/sourcing-agent/test/bidders/surface.test.ts
// What the folder gives to the other parts of the agent: the names of `index.ts`, and the numbers of the bounds. The wiring joins the folder to the real ports and reads these names, so a change to one of them
// changes this test too.
import { expect, test } from 'vitest';
import * as bidders from '../../src/bidders/index.ts';

test('exports the reader, the parser of the catalog and the bounds, and no other value', () => {
  expect(Object.keys(bidders).sort()).toStrictEqual([
    'BIDDER_FETCH_TIMEOUT_MS', 'BIDDER_FILE_MAX_BYTES', 'BIDDER_READ_BUDGET_MS', 'FACT_READ_TIMEOUT_MS', 'MAX_CANDIDATES', 'MAX_PARALLEL_READS', 'parseArdCatalog', 'readBidders',
  ]);
});

test('has the bounds of the read', () => {
  expect(bidders.MAX_CANDIDATES).toBe(8);
  expect(bidders.MAX_PARALLEL_READS).toBe(4);
  expect(bidders.FACT_READ_TIMEOUT_MS).toBe(20_000);
  expect(bidders.BIDDER_READ_BUDGET_MS).toBe(120_000);
  expect(bidders.BIDDER_FILE_MAX_BYTES).toBe(262_144);
  expect(bidders.BIDDER_FETCH_TIMEOUT_MS).toBe(10_000);
});
