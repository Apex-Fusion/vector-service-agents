// agents/document-pipeline/test/golden.ts
// The result of the two-page summary run of the stub marketplace (test/stub-suppliers.ts). test/orchestrate.test.ts pins a run of the code to it byte for byte,
// and test/spec.test.ts holds the example of the Response section of specs/document-pipeline.md to it, so the page shows what the code returns. Its values were
// computed from the stubs alone (what each supplier signs for the request the Pipeline must send), not from a run of the code under test. Every hash, reference,
// key hash and signature in it is the harness's, and so are the amounts, which are those of the fake chain; the shape and the field names are the contract.
import type { PipelineResult } from '../src/orchestrate.ts';
import { SUMMARY } from './stub-suppliers.ts';

/** The seven checks of verifyFleetReceipt, all passed: what the sub-job of every result that is delivered carries. */
export const ALL_PASS = {
  escrow_ref_matches: true, response_hash_matches: true, supplier_key_matches: true, signature_valid: true, on_chain_hash_matches: true,
  prompt_hash_matches: true, model_matches: true,
};

/** The result of the two-page summary run, computed from the stubs (see the head of this file). */
export const GOLDEN: PipelineResult = {
  schema: 'vector.document-pipeline.result.v1',
  source: { sha256: 'b81efed5987c7ecd75875885c774b8932df3d49aaded4a10c467cb543357f547', bytes: 927, mime: 'application/pdf', pages: 2 },
  pages: [
    {
      index: 0,
      text: 'Page one of the test document.',
      sub_job: {
        capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
        advert_ref: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1#0',
        escrow_ref: 'a5782bb76953802d31292675208f441f93ef14b3dcfa28cea9877711616070e7#0',
        supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
        receipt: {
          escrow_ref: 'a5782bb76953802d31292675208f441f93ef14b3dcfa28cea9877711616070e7#0',
          supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
          prompt_hash: 'bb0d1c8c08fbfaf43ad12ca4908bd52aa38a8c11bdbd6f09b91bf062d578b1a6',
          response_hash: '255451782018770be2711ca0132ef0fd1d43f892af57def595f6e6b24a7d9298',
          model: 'historical-records-ocr-v1',
          prompt_tokens: 812,
          completion_tokens: 9,
          wallclock_ms: 4210,
        },
        receipt_signature: '9eb6fa22f4d8c08bfd0325fabf06339ca7fa1455a31af81400521d0d75d3e77dc19ef02308168127e3c2779e550864c579c91f3f9ee2f0c2593d55e34d552e09',
        verification: ALL_PASS,
      },
    },
    {
      index: 1,
      text: 'Page two of the test document.',
      sub_job: {
        capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
        advert_ref: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1#0',
        escrow_ref: '2d8f75c78eab66b5cbe6d531e5721377ed77dcdb287cc14a8f50cb95fe8c89c5#0',
        supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
        receipt: {
          escrow_ref: '2d8f75c78eab66b5cbe6d531e5721377ed77dcdb287cc14a8f50cb95fe8c89c5#0',
          supplier_pkh: '11222e2867c74fb59111c65ad3338d6f5ae1060a07cd9118c8ae93e9',
          prompt_hash: 'b4c1430893768b40fcc6c79249355732ab4bdcdb70d3103ff03d2c05b7f834e8',
          response_hash: 'ae9bd16a398486065213dd48da81c38e122507a9323d499f23a85fbb766aebb8',
          model: 'historical-records-ocr-v1',
          prompt_tokens: 812,
          completion_tokens: 9,
          wallclock_ms: 4210,
        },
        receipt_signature: '4ba6446624467438cb65a11090fbf0e9716a5c0764a07744fb96889ecf10df652485bd3499d03d90f16518b3ee7e71bfef9cd008205fb3ea3481537b4bab1908',
        verification: ALL_PASS,
      },
    },
  ],
  result: { summary: SUMMARY },
  llm_sub_job: {
    capability_id: 'llm.text.generate.v1',
    advert_ref: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2#1',
    escrow_ref: '1f07d11f417efea663484e29efc9d348a64d9fc9816d97472e9187234702477d#0',
    supplier_pkh: 'a40f8784e101005a5daf6fb39e96c4ac63a2c204d31af76922b6481d',
    receipt: {
      escrow_ref: '1f07d11f417efea663484e29efc9d348a64d9fc9816d97472e9187234702477d#0',
      supplier_pkh: 'a40f8784e101005a5daf6fb39e96c4ac63a2c204d31af76922b6481d',
      prompt_hash: 'a0240ad4d68264b305c362e03b55808cf04e93001b11731df147df71b692d4f2',
      response_hash: '7b2e46c5680008869172db8bce13aed536f53c7ef803fa03fd4fdfaccb64b0d2',
      model: 'deepseek/deepseek-v4-flash',
      prompt_tokens: 96,
      completion_tokens: 24,
      wallclock_ms: 1830,
    },
    receipt_signature: 'de6eb7143976cd0dda7700ceef1ba7451dde1641eb8464936e6dfd19cd068e2748ab711d1da884b0f6ab5c2bd7bde73bd149033ee37fea4a28e4eb86ad0ce401',
    verification: ALL_PASS,
  },
  accounting: { sub_jobs: 3, locked_total_lovelace: '6783090', fees_total_lovelace: '3000000' },
};
