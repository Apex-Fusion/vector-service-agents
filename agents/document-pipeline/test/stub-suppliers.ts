// agents/document-pipeline/test/stub-suppliers.ts
// The marketplace the orchestrator tests run against, all in memory: the shared stubs of @vsa/hire-kit/testing in the world of these tests. A FakeChain that holds the adverts, an
// indexer that lists the OCR advert and the chat advert, and the two suppliers that speak the fleet protocol (Apex-Fusion/agents-marketplace at e847a55, supplier/src/server.ts)
// through the injected fetch: the allowlisted OCR supplier and a chat supplier on the Responses API. The suppliers and everything they can be told to do are the kit's. What is
// the Pipeline's is the world: the prefix of the escrow refs, the label of the keys, the text that the OCR supplier reads off the two fixture pages, and the summary that the chat
// supplier answers. They are pinned, so that the golden result of test/orchestrate.test.ts holds byte for byte: Ed25519 signs deterministically, and the receipts are made from
// these keys and these refs.
import { stubWorld, marketplace as sharedMarketplace } from '@vsa/hire-kit/testing';
import type { Marketplace as SharedMarketplace } from '@vsa/hire-kit/testing';
import type { FakeChainOptions } from '@vsa/buyer-core';
import type { AdvertDatum } from '@vsa/vector-read';
import { PAGE_0_PNG, PAGE_1_PNG, toBase64 } from './support.ts';

export {
  ALLOWLIST, INDEXER, LLM_ADVERT_REF, LLM_CAPABILITY, LLM_ENDPOINT, LLM_MODEL, OCR_ADVERT_REF, OCR_CAPABILITY, OCR_ENDPOINT, OCR_MODEL, T0, WINDOW_MS, stubKey,
} from '@vsa/hire-kit/testing';
export type { PollStep, StubKey, StubModelSupplier as StubChatSupplier, StubOcrSupplier } from '@vsa/hire-kit/testing';

/** What the OCR supplier reads off the two fixture pages. */
export const PAGE_TEXTS: Readonly<Record<string, string>> = {
  [toBase64(PAGE_0_PNG)]: 'Page one of the test document.',
  [toBase64(PAGE_1_PNG)]: 'Page two of the test document.',
};
export const SUMMARY = 'A two-page test document. The first page says it is page one and the second that it is page two.';

/** The world of the Pipeline's tests: its prefix, the label of its keys, the pages it reads and the summary it answers. */
const world = stubWorld({ prefix: 'document-pipeline-test/', label: 'document-pipeline test', answer: SUMMARY, pageTexts: PAGE_TEXTS });
export const { escrowNo, indexerRow, ocrFinished, chatFinished } = world;
export const OCR_KEY = world.ocrKey;
export const LLM_KEY = world.llmKey;
/** Not the key of any advert: what a forged receipt is signed with. */
export const FORGER_KEY = world.forgerKey;
export const OCR_ADVERT = world.ocrAdvert;
export const LLM_ADVERT = world.llmAdvert;

/** The shared marketplace, as the Pipeline's tests use it: the OCR advert and the chat advert listed, both free. */
export type Marketplace = SharedMarketplace;

/**
 * The FakeChain (the adverts, the clock at T0), the indexer listing both adverts free, and the two suppliers behind one fetch. `ocrAdvert` and `llmAdvert` replace the datum of
 * an advert, on the chain and in the indexer's row alike (a test of a price, for one).
 */
export function marketplace(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { ocrAdvert?: AdvertDatum; llmAdvert?: AdvertDatum } = {}): Marketplace {
  return sharedMarketplace({ ...opts, world, listed: ['ocr', 'llm'] });
}
