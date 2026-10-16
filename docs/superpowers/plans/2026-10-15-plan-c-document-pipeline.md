# Plan C: Document Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Document Pipeline agent (`document.pipeline.ocr-summary.v1`) so that it can be deployed on apex-web the way Agent History was: a service behind the template runtime that buys OCR per page from the live ChandraOCR agent and a summary or extraction from a fleet chat supplier, verifies every sub-receipt, and returns one bundle that the runtime signs.

**Architecture:** A new workspace package `packages/buyer-core` holds the chain-writing side: the mcp-server's marketplace modules vendored verbatim (datum codecs via `@vsa/vector-read`, builders, lineage, indexer, verifier, the Ogmios provider, the CML signer) plus the fleet pieces the mcp-server refuses on purpose (the OCR and Responses request commitments, the fleet send and poll routes, the envelope-hashed `response_hash`, a verifier that takes a recomputed hash). A `Chain` interface separates everything that signs and submits from the orchestration, so the service tests run against a `FakeChain` and stub suppliers while the real path uses Lucid, the vendored provider and the buyer key. The service `agents/document-pipeline` mirrors Agent History: the template wire contract on `POST /`, `GET /agent.json`, `GET /healthz`, a manifest rendered from the environment with both key hashes, and a Dockerfile; its own part is document intake (safeFetch or base64, PDF to PNG at 150 dpi through `pdftoppm`), the per-page and LLM orchestration with budgets, accounting, and a janitor that reclaims stranded sub-escrows after `deliver_by`.

**Tech Stack:** TypeScript, Node 22, pnpm workspace, vitest (packages and agents) and `node --test` (scripts), `@lucid-evolution/lucid` 0.4.29, `@noble/hashes`, `@anastasia-labs/cardano-multiplatform-lib-nodejs` 6.0.2-3, `ajv` for JSON Schema, `poppler-utils` (`pdftoppm`, `pdfinfo`) in the image, `node:22-alpine` with `tini`.

**Spec:** `specs/document-pipeline.md` and section 7.3 of `docs/superpowers/specs/2026-10-13-vector-service-agents-design.md`. The protocol facts below come from the mcp-server at `651ae93` (`<the mcp-server checkout>`), the chandra-supplier checkout at `bebea1f` (`<the chandra-supplier checkout>`) and `origin/main` of agents-marketplace at `e847a55` (`<the agents-marketplace checkout>`, read with `git show origin/main:<path>`; its working tree is a stale branch).

## Global Constraints

- Capability id `document.pipeline.ocr-summary.v1`; model string `document-pipeline-v1`; price 5000000 lovelace; supplier bond 1000000; buyer bond 1000000; `ADVERT_MAX_PROCESSING_MS` 1800000; `SERVICE_TIMEOUT_MS` 1680000; the orchestrator's own deadline is 1620000 ms after the request arrives.
- `max_pages` is 1 to 5 (default 5); PDFs render to PNG at 150 dpi; a fetched source is at most 20 MB (20971520 bytes); base64 inputs are at most 600000 raw bytes; the wire payload is at most 900000 bytes; the service body cap is 1 MB.
- Wire contract: the runtime POSTs `[{"content":"<request JSON as a string>","role":"user"}]` to `POST /`; the service parses `JSON.parse(body)[0].content` and then that string as JSON; the response body is the result exactly as the runtime will hash it.
- OCR hop: only the allowlisted first-party ChandraOCR supplier, identified by `supplier_pkh` `401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9` and capability `ocr.page.extract.chandra-ocr-2.v1`; its advert reference is resolved from the indexer at run time (today `87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0`, price 200000, bonds 1000000 and 1000000, window 300000 ms, model `historical-records-ocr-v1`); never any other OCR advert.
- LLM hop: capability `llm.text.generate.v1`; model allowlist in this order: `deepseek/deepseek-v4-flash`, `deepseek-v4-pro`, `moonshotai/kimi-k2.6`, `Qwen/Qwen3.6-35B-A3B-FP8`; the supplier must be `free` on the indexer and on a live `GET /status` probe (2 s), and its `GET /capability` must carry `inference_api: "responses"`; cheapest first, then most recent `last_seen`.
- Fleet protocol constants: header `X-Escrow-Ref`; OCR routes `POST /v1/ocr/extract` and `GET /v1/ocr/extract/:jobId`; chat routes `POST /v1/responses` and `GET /v1/responses/:jobId`; OCR body `{image_b64, mime, output_format}` with `output_format` `markdown`, `mime` one of `image/png`, `image/jpeg`, `image/webp`, `image_b64` plain base64 at most 12000000 characters; chat body `{input: <string>}` only; 202 `{job_id, status: "accepted", escrow_ref}` after the supplier's Claim (up to 60 s), 202 `{status, escrow_ref}` while running, 200 with the result, `receipt`, `receipt_signature` and `escrow_ref` when done, or `{status: "failed", reason, message, escrow_ref}`; 409 `supplier_busy` leaves the escrow Open; a POST that timed out may have claimed, so a retry is never blind.
- Commitments: `request_spec_hash` = sha256(canonicalize({capability_id, max_output_tokens, model})) from the advert; OCR `prompt_hash` = sha256(canonicalize({image_b64, mime, output_format})); OCR `response_hash` = sha256(canonicalize({content, output_format})); Responses `prompt_hash` = sha256(canonicalize(responseRequestCommitment(normalizeResponseRequest(body)))); Responses `response_hash` = sha256(canonicalize({output, status, incomplete_details})) over the parsed response object; receipt signature = Ed25519 over utf8(canonicalize(receipt)); `result_receipt_hash` = sha256(canonicalize({receipt, signature})). `canonicalize` is the one already in `@vsa/vector-read` (sorted keys, NFC strings, no whitespace).
- Escrow datum for a sub-job: the 14-field Constr0 datum of `@vsa/vector-read` (`encodeEscrowDatum`), `payment` equal to the advert price, both bonds 1000000, `deliver_by` = `posted_at` + `max_processing_ms` + 180000 (the mcp-server buffer `DELIVER_BY_BUFFER_MS`), lock = `escrowLockFloor(datum, price + both bonds)`.
- Accept: build and submit as soon as a sub-job's poll returns 200 (the supplier's Submit is already confirmed by then); the window is 600000 ms after the Submit; after it the supplier may Release and keep the lock.
- Keys: the service holds `PIPELINE_BUYER_PRIV_KEY_HEX` (64 hex, raw Ed25519) and nothing else; the runtime holds `SUPPLIER_PRIV_KEY_HEX`; the compose file blanks each key in the other container; both key hashes are published in the manifest under `keys` as `supplier_pkh` and `buyer_pkh`. No key material, mnemonic or seed phrase in the repository (`scripts/no-secrets.test.mjs`); the forbidden pattern `/(mnemonic|seed phrase|PRIV_KEY_HEX=[0-9a-f]{64}|ed25519_sk1...)/` stays.
- Wallet pre-flight before any sub-escrow: a pure output of at least 5000000 lovelace (collateral) plus a float of at least `(max_pages + 1) * 4500000` lovelace outside it; otherwise the job is refused before anything is claimed, with reason `insufficient_float`.
- safeFetch (from `@vsa/vector-read`) for every outbound fetch: https only, private and reserved addresses refused, no redirects, streamed byte cap, a timeout. Supplier endpoints come from on-chain adverts and are untrusted.
- Vendoring: files copied byte for byte into `packages/buyer-core/src/vendored/...` with a `VENDORED-FROM.md` naming the source path and commit for every file; modifications only in buyer-core's own files, never inside a vendored file (an import path rewrite is allowed and is listed in `VENDORED-FROM.md` per file).
- Status words: the Pipeline stays PROPOSED on every surface in this plan ("built, not deployed"); never LIVE or DEPLOYED here. Hyphens only, no em or en dashes. No individual names. The unit's name appears exactly once in the repository (`docs/HIRE.md` section 3) and nowhere new; say "units".
- Containers: `document-pipeline-agent` (runtime, loopback `127.0.0.1:8084:8080`) and `document-pipeline-service` (port 9092, not published), both on `umami_default`; `SERVICE_URL=http://document-pipeline-service:9092/`; public name `mp-suppliers-pipeline.hal8.ai`.
- Tests before code for every task; `pnpm test` and `pnpm typecheck` green at every commit; commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. A PDF with more pages than `max_pages`, with zero pages, or encrypted: the service reads the first `max_pages`, reports `source.pages` as the document's total, and refuses an unreadable file with reason `unreadable_source` before any escrow is posted (Task 6 tests).
2. A source URL that answers with a redirect, a non-document body, or more than 20 MB: refused before any escrow is posted, with `source_fetch_failed` and the reason; nothing is spent (Task 6 tests).
3. The OCR supplier answers 409 `supplier_busy` or the POST times out: a busy answer leaves the escrow Open and the service retries the send every 15 s until the page budget is spent, never posting a second escrow for the same page; a timed-out POST is followed by a lineage read, and a Claimed escrow is polled by job id only if one was received, otherwise the page fails and the escrow goes to the janitor (Task 7 tests).
4. The orchestrator's deadline: no page is started with less than 480000 ms left, no LLM job with less than 300000 ms left; a job that cannot finish fails with `deadline` and the sub-escrows already posted go to the janitor; the Accept of a finished sub-job is built within seconds of the 200 (Task 7 tests).
5. The LLM answer for `task: "extract"` is not JSON or does not validate: the result carries `schema_valid: false`, `extraction: null` and `raw_text`, the job still succeeds and the LLM sub-receipt is still verified (Task 7 tests).

---

### Task 1: `packages/buyer-core`, the vendored chain side

**Files:**
- Create: `packages/buyer-core/package.json`, `packages/buyer-core/tsconfig.json`, `packages/buyer-core/VENDORED-FROM.md`, `packages/buyer-core/src/index.ts`
- Create (verbatim copies, see the table): `packages/buyer-core/src/vendored/mcp/*.ts`, `packages/buyer-core/src/vendored/mcp-shared/*.ts`, `packages/buyer-core/src/vendored/signer/sign.ts`, `packages/buyer-core/test/fixtures/escrow-koios.fixture.ts`
- Modify: `pnpm-workspace.yaml` (if packages are listed by name), root `package.json` typecheck script if it enumerates packages, `.github/workflows/ci.yml` (test matrix picks the new package up through `pnpm -r`)
- Test: `packages/buyer-core/test/vendored.test.ts`, `packages/buyer-core/test/signing.test.ts`

**Interfaces:**
- Consumes: `@vsa/vector-read` (`encodeEscrowDatum`, `decodeAdvertDatum`, `decodeEscrowDatum`, `canonicalize`, `sha256Utf8Hex`, `requestSpecHash`, `escrowLockFloor`, `parseOutRef`, `formatOutRef`, `safeFetch`, constants).
- Produces: re-exports of the vendored modules under stable names: `planPostEscrow`, `buildPostEscrow`, `planAccept`, `buildAccept`, `planReclaim`, `buildReclaim`, `reserveCollateralInputs` (from `marketplace-build`), `resolveEscrowLineage`, `readEscrowOutput`, `readSubmittedOutput`, `submittedRefsOf` (lineage), `fetchSuppliers`, `fetchSupplier`, `readAdvert`, `koiosUtxoInfo`, `koiosTxInputCreds` (indexer), `verifyReceipt`, `verifyJob` (verify), `OgmiosProvider` (mcp-shared provider), `signTransaction(unsignedCborHex, privateKeyBech32)` (signer), `rawHexToBech32(privateKeyHex): string` (new, in `src/signing.ts`), `ensureSlotConfig`, `paymentKeyHashOf` (gov-build), and the constants `ESCROW_REF_UTXO`, `ACCEPT_WINDOW_MS`, `DELIVER_BY_BUFFER_MS`, `MARKETPLACE_MIN_FEE`, `VECTOR_KOIOS_URL`, `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL`.

Vendoring table (source → destination; every row goes into `VENDORED-FROM.md` with the commit):

| Source (mcp-server `651ae93`, under `packages/`) | Destination |
|---|---|
| `builder/src/vector/marketplace-constants.ts` | `src/vendored/mcp/marketplace-constants.ts` |
| `builder/src/vector/marketplace-shared.ts` | `src/vendored/mcp/marketplace-shared.ts` |
| `builder/src/vector/marketplace-indexer.ts` | `src/vendored/mcp/marketplace-indexer.ts` |
| `builder/src/vector/marketplace-lineage.ts` | `src/vendored/mcp/marketplace-lineage.ts` |
| `builder/src/vector/marketplace-build.ts` | `src/vendored/mcp/marketplace-build.ts` |
| `builder/src/vector/marketplace-verify.ts` | `src/vendored/mcp/marketplace-verify.ts` |
| `builder/src/vector/marketplace-transport.ts` | `src/vendored/mcp/marketplace-transport.ts` (needed for `isFleetCapability`, `parseJobResponse`, `checkBuyer`) |
| `builder/src/vector/marketplace-supplier.ts` | `src/vendored/mcp/marketplace-supplier.ts` (the pinned `ROUTES`) |
| `builder/src/vector/marketplace-datum.ts` | not copied: `@vsa/vector-read` carries it at `94b8f41`; add `sha256BytesHex` to buyer-core's `src/hashes.ts` if the HEAD version's one addition is needed |
| `builder/src/vector/gov-build.ts` | `src/vendored/mcp/gov-build.ts` (only if `ensureSlotConfig`, `paymentKeyHashOf`, `ChainClockError` cannot be split out; otherwise copy the whole file, verbatim is simpler) |
| `builder/src/vector/build.ts` | `src/vendored/mcp/build.ts` (`toBuildResult`) |
| `shared/src/provider.ts` | `src/vendored/mcp-shared/provider.ts` |
| `shared/src/config.ts`, `shared/src/types.ts` | `src/vendored/mcp-shared/config.ts`, `types.ts` |
| `signer/src/sign.ts` | `src/vendored/signer/sign.ts` |
| `builder/test/fixtures/escrow-koios.fixture.ts` | `test/fixtures/escrow-koios.fixture.ts` |

Import rewrites are the only edits inside copies: `@apexfusion/vector-mcp-shared/config` → `../mcp-shared/config.js`, `./marketplace-datum.js` → `@vsa/vector-read`, and so on. `VENDORED-FROM.md` lists each rewritten line. The mainnet endpoints are set in the vendored `config.ts` copy through environment variables with mainnet defaults (`VECTOR_KOIOS_URL` `https://v2.koios.vector.mainnet.apexfusion.org/api/v1` or the base the vendored indexer expects, read the file: the mcp-server's Koios base excludes `/api/v1`; keep the vendored expectation and document it), `VECTOR_OGMIOS_URL` `https://ogmios.vector.mainnet.apexfusion.org`, `VECTOR_SUBMIT_URL` `https://submit.vector.mainnet.apexfusion.org/api/submit/tx`.

- [ ] **Step 1: Write the failing vendoring test**

```ts
// packages/buyer-core/test/vendored.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readFileSync(join(root, 'VENDORED-FROM.md'), 'utf8');

describe('vendored files', () => {
  it('every vendored file is named in VENDORED-FROM.md with a source path, a commit and a sha256 of the copy', () => {
    const rows = manifest.split('\n').filter((l) => l.startsWith('| `src/vendored/') || l.startsWith('| `test/fixtures/'));
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      const [, dest, source, commit, sha] = row.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
      expect(existsSync(join(root, dest)), dest).toBe(true);
      expect(source).toMatch(/^(mcp-server|agents-marketplace):/);
      expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
      const actual = createHash('sha256').update(readFileSync(join(root, dest))).digest('hex');
      expect(actual, `${dest} changed since it was vendored`).toBe(sha);
    }
  });
  it('the public surface re-exports the builders, the lineage, the verifier, the provider and the signer', async () => {
    const m = await import('../src/index.ts');
    for (const name of ['planPostEscrow', 'buildPostEscrow', 'buildAccept', 'buildReclaim', 'resolveEscrowLineage', 'verifyReceipt', 'OgmiosProvider', 'signTransaction', 'rawHexToBech32', 'ESCROW_REF_UTXO', 'ACCEPT_WINDOW_MS', 'DELIVER_BY_BUFFER_MS']) expect(typeof (m as Record<string, unknown>)[name], name).not.toBe('undefined');
  });
});
```

- [ ] **Step 2: Run it to see it fail** (`pnpm --filter @vsa/buyer-core test`): fails because the package and the manifest do not exist.

- [ ] **Step 3: Create the package and copy the files**

`package.json`: name `@vsa/buyer-core`, `"type": "module"`, scripts `test: vitest run`, `typecheck: tsc --noEmit`; dependencies `@vsa/vector-read: workspace:*`, `@lucid-evolution/lucid: ^0.4.29`, `@noble/hashes: ^1.7.1`, `@anastasia-labs/cardano-multiplatform-lib-nodejs: 6.0.2-3`; devDependencies as in `packages/vector-read/package.json`. `tsconfig.json` extends `../../tsconfig.base.json` like vector-read's. Copy each file of the table with `cp` (never retype), apply only the import rewrites, and record the sha256 of the final copy in `VENDORED-FROM.md` as a table with the columns `destination | source | commit | sha256`, plus a section "Rewritten lines" listing each rewrite per file, and a section "Why vendored" (the mcp-server packages are not published; the same datum codecs, builders and verifier as the hosted server; drift is caught by `packages/vector-read/test/datum.test.ts` and by the sha256 column here).

`src/signing.ts`:

```ts
import { CML } from '@lucid-evolution/lucid';
/** A raw 64-hex Ed25519 key (the form gen-keypair prints and the env file holds) as the bech32 the signer takes. */
export function rawHexToBech32(privateKeyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(privateKeyHex)) throw new Error('private key must be 64 lowercase hex characters');
  return CML.PrivateKey.from_normal_bytes(Buffer.from(privateKeyHex, 'hex')).to_bech32();
}
```

`src/index.ts` re-exports everything in the Produces list.

- [ ] **Step 4: Write the failing signing test, then make it pass**

```ts
// packages/buyer-core/test/signing.test.ts
import { describe, it, expect } from 'vitest';
import { CML } from '@lucid-evolution/lucid';
import { rawHexToBech32, signTransaction } from '../src/index.ts';

describe('signing with a raw key', () => {
  it('rawHexToBech32 round-trips through CML and refuses anything but 64 hex', () => {
    const sk = CML.PrivateKey.generate_ed25519();
    const hex = Buffer.from(sk.to_raw_bytes()).toString('hex');
    expect(rawHexToBech32(hex)).toBe(sk.to_bech32());
    expect(() => rawHexToBech32('abc')).toThrow(/64 lowercase hex/);
  });
  it('signTransaction adds one vkey witness whose public key hashes to the signer and leaves the body bytes alone', () => {
    // Build a minimal unsigned transaction with CML: one input, one output, fee 500000, no scripts.
    // Then sign with a generated key, parse the signed CBOR, and assert: body cbor equal, witness count 1,
    // CML.Ed25519Signature verifies over hash_transaction(body).
    // (The implementer writes the CML construction; the assertions above are the contract.)
  });
});
```

Run: `pnpm --filter @vsa/buyer-core test` → PASS; `pnpm typecheck` → clean.

- [ ] **Step 5: Commit** `feat(buyer-core): vendor the marketplace builders, lineage, verifier, provider and signer from mcp-server 651ae93`

### Task 2: Fleet commitments and envelope hashes

**Files:**
- Create: `packages/buyer-core/src/vendored/fleet/responses.ts` (verbatim from agents-marketplace `origin/main` `e847a55`, `packages/shared/src/responses.ts`; add the row to `VENDORED-FROM.md`), `packages/buyer-core/src/vendored/fleet/types.ts` (only the `ChatMessage` type the file imports, copied from `packages/shared/src/tx/types.ts` of the same commit, the needed lines only, documented), `packages/buyer-core/src/commitments.ts`
- Test: `packages/buyer-core/test/commitments.test.ts`

**Interfaces:**
- Produces:
```ts
export function ocrPromptHash(req: { image_b64: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; output_format: 'markdown' | 'html' | 'json' }): string;
export function ocrResponseHash(res: { content: string; output_format: string }): string;
export function responsesPromptHash(body: { input: string }): string;            // normalizeResponseRequest + responseRequestCommitment, then sha256(canonicalize(...))
export function responsesResponseHash(response: unknown): string;               // sha256(canonicalize({output, status, incomplete_details})) of the parsed object
export function responsesOutputText(response: unknown): string;                 // responseOutputText(normalizeResponseOutput(response.output))
export { requestSpecHash } from '@vsa/vector-read';
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/buyer-core/test/commitments.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalize, sha256Utf8Hex, requestSpecHash } from '@vsa/vector-read';
import { ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash, responsesOutputText } from '../src/commitments.ts';

describe('commitments', () => {
  it('request_spec_hash of the live ChandraOCR advert reproduces the on-chain value', () => {
    expect(requestSpecHash({ capability_id: 'ocr.page.extract.chandra-ocr-2.v1', max_output_tokens: 8192, model: 'historical-records-ocr-v1' } as never))
      .toBe('f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e8');
  });
  it('the OCR prompt hash is sha256 of canonicalize({image_b64, mime, output_format}), over the base64 string as sent', () => {
    const req = { image_b64: 'iVBORw0KGgo=', mime: 'image/png' as const, output_format: 'markdown' as const };
    expect(ocrPromptHash(req)).toBe(sha256Utf8Hex(canonicalize({ image_b64: 'iVBORw0KGgo=', mime: 'image/png', output_format: 'markdown' })));
    expect(canonicalize(req)).toBe('{"image_b64":"iVBORw0KGgo=","mime":"image/png","output_format":"markdown"}');
  });
  it('the OCR response hash covers {content, output_format} and nothing else', () => {
    expect(ocrResponseHash({ content: 'Dear Sir', output_format: 'markdown' })).toBe(sha256Utf8Hex('{"content":"Dear Sir","output_format":"markdown"}'));
  });
  it('the Responses prompt hash commits to the normalized request: a string input becomes one user message', () => {
    // From the fleet code at e847a55: {input:"hello",max_output_tokens:100} commits to
    // {"input":[{"content":[{"text":"hello","type":"input_text"}],"role":"user","type":"message"}],"max_output_tokens":100}
    const expected = '{"input":[{"content":[{"text":"hello","type":"input_text"}],"role":"user","type":"message"}]}';
    expect(responsesPromptHash({ input: 'hello' })).toBe(sha256Utf8Hex(expected));
  });
  it('the Responses response hash covers output, status and incomplete_details of the parsed object', () => {
    const response = { id: 'resp_1', status: 'completed', incomplete_details: null, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A summary.' }] }], usage: { input_tokens: 10, output_tokens: 3 } };
    expect(responsesResponseHash(response)).toBe(sha256Utf8Hex(canonicalize({ output: response.output, status: 'completed', incomplete_details: null })));
    expect(responsesOutputText(response)).toBe('A summary.');
  });
});
```

The fourth test's expected string must be confirmed against the vendored functions: if `responseRequestCommitment` includes a clamped `max_output_tokens` even when the body has none, the implementer prints the commitment once, puts the printed string into the test as the pinned value, and notes in the test why. The pinned value is then the contract.

- [ ] **Step 2: Run, see them fail. Step 3: Vendor `responses.ts` and write `commitments.ts`. Step 4: Run, see them pass; `pnpm typecheck` clean. Step 5: Commit** `feat(buyer-core): fleet request and response commitments (OCR and Responses)`

### Task 3: Fleet post builder, the `Chain` interface, `RealChain` and `FakeChain`

**Files:**
- Create: `packages/buyer-core/src/fleet-build.ts`, `packages/buyer-core/src/chain.ts`, `packages/buyer-core/src/fake-chain.ts` (exported for the service tests), `packages/buyer-core/src/fees.ts`
- Test: `packages/buyer-core/test/fleet-build.test.ts`, `packages/buyer-core/test/fake-chain.test.ts`

**Interfaces:**
```ts
// src/fleet-build.ts
export interface FleetPostPlan { datum: EscrowDatum; lockLovelace: bigint; deliverBy: number; validTo: number; postedAt: number; }
export function planFleetPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, promptHash: string, nowMs: number): FleetPostPlan;
// mirrors planPostEscrow of the vendored builder with a precomputed prompt hash and no fleet refusal; deliver_by = now + advert.max_processing_ms + DELIVER_BY_BUFFER_MS; validTo = min(now + 180000, deliverBy - advert.max_processing_ms)
export function buildFleetPostEscrow(lucid: LucidEvolution, provider: Provider, args: { changeAddress: string; advertRef: string; promptHash: string; nowMs?: number }, fetchImpl?: typeof fetch): Promise<{ unsignedCborHex: string; escrowRef: string; lockLovelace: bigint; deliverBy: number; postedAt: number; datum: EscrowDatum }>;

// src/chain.ts
export interface PostResult { escrowRef: string; txHash: string; lockLovelace: bigint; feeLovelace: bigint; deliverBy: number; postedAt: number; supplierPkh: string; }
export interface Chain {
  wallet(): Promise<{ address: string; buyerPkh: string; collateralLovelace: bigint | null; floatLovelace: bigint }>;
  postEscrow(args: { advertRef: string; promptHash: string }): Promise<PostResult>;          // builds, signs, submits, awaits confirmation
  accept(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  reclaim(escrowRef: string): Promise<{ txHash: string; feeLovelace: bigint }>;
  escrowState(escrowRef: string): Promise<'Open' | 'Claimed' | 'Submitted' | 'spent' | 'unknown'>; // via the vendored lineage
  onChainReceiptHash(escrowRef: string): Promise<string | null>;                              // result_receipt_hash of the Submitted output, via lineage, or null
  readAdvert(advertRef: string): Promise<AdvertDatum>;
}
export function createRealChain(opts: { privateKeyHex: string; koiosUrl?: string; ogmiosUrl?: string; submitUrl?: string; fetchImpl?: typeof fetch; awaitTimeoutMs?: number }): Promise<Chain>;
// Lucid with the vendored OgmiosProvider, wallet from rawHexToBech32(privateKeyHex) through lucid.selectWallet.fromPrivateKey (never fromSeed),
// signTransaction from the vendored signer, provider.submitTx, then await by Koios tx_status (vendored provider awaitTx) and throw on timeout.

// src/fees.ts
export function feeOfSignedTx(signedCborHex: string): bigint;   // CML.Transaction.from_cbor_hex(hex).body().fee()
```

`FakeChain` (`src/fake-chain.ts`): an in-memory ledger of escrows keyed by ref with states, lock and fee constants (`lock 2261030n`, `fee 500000n`), `postEscrow` returning a deterministic ref `${sha256(prefix+n)}#0`, `accept` requiring state `Submitted`, `reclaim` requiring `Open|Claimed` and `now >= deliverBy`, plus test-only methods `markClaimed(ref)`, `markSubmitted(ref, resultReceiptHash)` that the stub supplier of later tasks calls, and `onChainReceiptHash` returning what `markSubmitted` stored.

- [ ] **Step 1: Failing tests**

`fleet-build.test.ts`: (a) `planFleetPostEscrow` on the live ChandraOCR advert fixture (`packages/vector-read/test/fixtures/marketplace.fixture.ts`) with the fixture's `prompt_hash`, `buyer_pkh` and `posted_at` produces a datum that `encodeEscrowDatum` encodes to the fixture's live escrow CBOR byte for byte, with `lockLovelace` 2261030n and `deliverBy` = `posted_at + 300000 + 180000` (note: the live sample used the fleet's 30000 buffer; assert the datum fields other than `deliver_by` are equal and that `deliver_by` follows this plan's rule; pin both numbers); (b) `validTo` is `min(now + 180000, deliverBy - 300000)`; (c) a non-fleet advert (capability `identity.history.report.v1`) is also accepted by `planFleetPostEscrow` (it is generic).

`fake-chain.test.ts`: state machine (post → Open; markClaimed → Claimed; markSubmitted → Submitted with the hash readable; accept only from Submitted and then `spent`; reclaim only Open or Claimed and only after deliverBy), wallet float decreases by lock + fee on post and increases by the returned bond and excess on accept.

- [ ] **Step 2: Run, fail. Step 3: Implement. Step 4: Run, pass; typecheck. Step 5: Commit** `feat(buyer-core): fleet post builder, Chain interface, RealChain and FakeChain`

### Task 4: Fleet clients (OCR, Responses) and supplier discovery

**Files:**
- Create: `packages/buyer-core/src/fleet-clients.ts`, `packages/buyer-core/src/select-supplier.ts`
- Test: `packages/buyer-core/test/fleet-clients.test.ts`, `packages/buyer-core/test/select-supplier.test.ts`

**Interfaces:**
```ts
export type FetchLike = typeof fetch;
export interface SupplierCapability { capability_id: string; model: string; advert_ref: string; supplier_pkh: string; pub_key_hex: string; inference_api?: string; max_output_tokens?: number; }
export function readCapability(endpoint: string, fetchImpl: FetchLike): Promise<SupplierCapability>;      // GET /capability, 20 s, 64 KiB
export function probeStatus(endpoint: string, fetchImpl: FetchLike): Promise<'free' | 'working' | 'offline' | 'unreachable'>; // GET /status, 2 s
export interface SendResult = { kind: 'accepted'; jobId: string } | { kind: 'busy' } | { kind: 'refused'; status: number; reason: string; message: string } | { kind: 'timeout' };
export function sendOcrJob(endpoint: string, escrowRef: string, body: { image_b64: string; mime: string; output_format: 'markdown' }, fetchImpl: FetchLike, timeoutMs: number): Promise<SendResult>;
export function sendResponsesJob(endpoint: string, escrowRef: string, body: { input: string }, fetchImpl: FetchLike, timeoutMs: number): Promise<SendResult>;
export type PollResult = { kind: 'running'; status: string } | { kind: 'done'; body: Record<string, unknown>; receipt: Receipt; receiptSignature: string; submittedRef?: string } | { kind: 'failed'; reason: string; message: string } | { kind: 'gone' };
export function pollOcrJob(endpoint: string, jobId: string, fetchImpl: FetchLike): Promise<PollResult>;        // GET /v1/ocr/extract/:id
export function pollResponsesJob(endpoint: string, jobId: string, fetchImpl: FetchLike): Promise<PollResult>;  // GET /v1/responses/:id
export function selectLlmSupplier(args: { fetchImpl: FetchLike; indexerUrl?: string; allowlist: readonly string[]; probe?: boolean }): Promise<{ advertRef: string; endpoint: string; model: string; supplierPkh: string; priceLovelace: bigint; capability: SupplierCapability } | null>;
export function findOcrAdvert(args: { fetchImpl: FetchLike; indexerUrl?: string; supplierPkh: string }): Promise<{ advertRef: string; endpoint: string; priceLovelace: bigint; maxProcessingMs: number } | null>;
```

Rules: every call sets `X-Escrow-Ref` on sends and `content-type: application/json`; the OCR send budget is `timeoutMs` (default 75000, the Claim takes up to 60 s); responses are parsed as JSON with a 1,000,000 byte cap for OCR (page text) and 1,000,000 for Responses; a 202 with `status` `accepted` on a send is `accepted`; a 409 with reason `supplier_busy` is `busy`; any other 4xx or 5xx is `refused` with the reason from the envelope `{reason, message}`; a fetch abort is `timeout`. `selectLlmSupplier`: `fetchSuppliers({capability_id: 'llm.text.generate.v1', onlyFree: true})` from the vendored indexer, keep rows whose `model` is in the allowlist, order by allowlist index, then price ascending, then `last_seen_iso` descending; for each candidate in order read `/capability` (must have `inference_api === 'responses'` and `advert_ref` equal to the row's) and, when `probe` is true, `/status` must be `free`; return the first that passes. `findOcrAdvert`: the free supplier rows of `ocr.page.extract.chandra-ocr-2.v1` whose `supplier_pkh` equals the allowlisted hash; exactly one expected; `null` otherwise.

- [ ] **Step 1: Failing tests** with an injected fake `fetch` (a function that returns `Response` objects by URL and method; see `packages/vector-read/src/fixture-fetch.ts` for the pattern): send 202 → accepted with the job id; 409 supplier_busy → busy; 409 prompt_mismatch → refused with the reason; abort → timeout; poll 202 → running; poll 200 with receipt → done with `submittedRef` when present; poll 404 → gone; the LLM selection picks `deepseek/deepseek-v4-flash` at 0.2 over `Qwen...` at 0.2 and skips a candidate whose `/capability` lacks `inference_api` or whose `/status` is `working`; `findOcrAdvert` returns the allowlisted supplier only and `null` when its row is missing or busy.

- [ ] **Step 2 to 5:** run, fail; implement; run, pass; typecheck; commit `feat(buyer-core): fleet OCR and Responses clients, supplier discovery`

### Task 5: Fleet receipt verification

**Files:**
- Create: `packages/buyer-core/src/fleet-verify.ts`
- Test: `packages/buyer-core/test/fleet-verify.test.ts`

**Interfaces:**
```ts
export interface FleetVerifyInput { escrowRef: string; receipt: Receipt; receiptSignature: string; responseHashHex: string; promptHashHex: string; supplierPubKeyHex: string; supplierPkhExpected: string; model: string; onChainReceiptHash: () => Promise<string | null>; }
export interface FleetVerification { verdict: 'VERIFIED' | 'FAILED' | 'INCOMPLETE'; checks: { escrow_ref_matches: 'pass' | 'fail'; response_hash_matches: 'pass' | 'fail'; supplier_key_matches: 'pass' | 'fail'; signature_valid: 'pass' | 'fail'; on_chain_hash_matches: 'pass' | 'fail' | 'skipped'; prompt_hash_matches: 'pass' | 'fail'; model_matches: 'pass' | 'fail' } }
export function verifyFleetReceipt(input: FleetVerifyInput): Promise<FleetVerification>;
```
Checks: (1) `receipt.escrow_ref === escrowRef`; (2) `receipt.response_hash === responseHashHex` (the recomputed envelope hash); (3) `blake2b-224(pubKey)` equals `receipt.supplier_pkh` and `supplierPkhExpected` (use the same hashing the vendored verifier uses, `CML.PublicKey.from_bytes(...).hash().to_hex()`); (4) Ed25519 signature over utf8(canonicalize(receipt)) with the public key; (5) `await onChainReceiptHash()` equals `sha256(canonicalize({receipt, signature}))`, `skipped` when it returns null; (6) `receipt.prompt_hash === promptHashHex`; (7) `receipt.model === model`. Verdict VERIFIED only when all seven pass; FAILED when any fails; INCOMPLETE when nothing fails and (5) is skipped.

- [ ] **Step 1: Failing tests** with a generated supplier key: a receipt signed by the key verifies; each check flips to `fail` when its input is wrong (seven cases); a null on-chain hash gives INCOMPLETE; the eight receipt fields are those of the spec's receipt table.
- [ ] **Step 2 to 5:** run, fail; implement; pass; typecheck; commit `feat(buyer-core): fleet receipt verification with a recomputed envelope hash`

### Task 6: `agents/document-pipeline` intake: request, source, rendering

**Files:**
- Create: `agents/document-pipeline/package.json`, `tsconfig.json`, `src/request.ts`, `src/source.ts`, `src/render.ts`, `test/fixtures/two-pages.pdf` (a real two-page PDF with the texts "Page one of the test document." and "Page two of the test document.", generated once by a script `test/fixtures/make-pdf.mjs` with `pdf-lib` as a devDependency, or hand-written as a minimal PDF; checked in), `test/fixtures/page-0.png`, `test/fixtures/page-1.png` (tiny PNGs, 8 by 8 pixels, generated by the same script with zlib, used by the fake renderer)
- Test: `test/request.test.ts`, `test/source.test.ts`, `test/render.test.ts`

**Interfaces:**
```ts
// src/request.ts
export type Task = 'summary' | 'extract';
export interface PipelineRequest { source: { url: string } | { pdf_b64: string; mime: 'application/pdf' } | { image_b64: string; mime: 'image/png' | 'image/jpeg' }; task: Task; schema?: Record<string, unknown>; language: string; max_pages: number; }
export function parseRequest(requestJson: string): PipelineRequest;   // throws RequestError(code, message) with codes: bad_json, bad_shape, schema_required, max_pages_range, base64_too_large (over 600000 raw bytes), language_bad (2 to 8 letters or a BCP-47 tag)
// src/source.ts
export interface SourceBytes { bytes: Uint8Array; mime: 'application/pdf' | 'image/png' | 'image/jpeg'; sha256: string; origin: 'url' | 'inline' }
export function loadSource(req: PipelineRequest, deps: { fetchImpl: typeof fetch; maxBytes?: number }): Promise<SourceBytes>;  // safeFetch rules for urls (https, no redirects, 20 MB streamed cap, 60 s); mime from magic bytes (%PDF-, PNG, JPEG), not from headers; mismatch is source_mime_mismatch
// src/render.ts
export interface Page { index: number; png: Uint8Array }
export interface Renderer { pageCount(pdf: Uint8Array): Promise<number>; render(pdf: Uint8Array, maxPages: number): Promise<Page[]> }
export function popplerRenderer(opts?: { pdftoppm?: string; pdfinfo?: string; dpi?: number; timeoutMs?: number }): Renderer;  // pdfinfo for the count (encrypted or broken → unreadable_source), pdftoppm -r 150 -png -f 1 -l maxPages into a mkdtemp dir, read page-N.png in order, delete the dir in finally
export function pagesOf(source: SourceBytes, maxPages: number, renderer: Renderer): Promise<{ total: number; pages: Page[]; mime: string }>;  // an image is one page, total 1
```

- [ ] **Step 1: Failing tests.** `request.test.ts`: the example request of the spec parses; `max_pages` 0 and 6 are refused; `extract` without `schema` is refused; `pdf_b64` of 600001 raw bytes is refused and 600000 passes; unknown keys are refused. `source.test.ts` with an injected fetch: a PDF by url is loaded with its sha256 and `origin: 'url'`; a 301 is refused (safeFetch); a body over 20 MB is refused; a png served as `application/pdf` is `source_mime_mismatch`; inline base64 decodes and hashes. `render.test.ts`: `pagesOf` with a fake renderer returning the two fixture PNGs reports `total 2`, two pages in order, and with `maxPages 1` one page and `total 2`; the real `popplerRenderer` test runs only when `pdftoppm` and `pdfinfo` are on PATH (`test.skipIf`) and then renders `two-pages.pdf` to two PNGs of 150 dpi whose sizes are above 1000 bytes, and reports an encrypted or truncated PDF as `unreadable_source`.
- [ ] **Step 2 to 5:** run, fail; implement; pass; typecheck; commit `feat(document-pipeline): request parsing, source loading, PDF rendering`

### Task 7: Orchestration, result, accounting, janitor

**Files:**
- Create: `agents/document-pipeline/src/orchestrate.ts`, `src/result.ts`, `src/llm-prompt.ts`, `src/janitor.ts`, `src/budget.ts`
- Test: `test/orchestrate.test.ts`, `test/stub-suppliers.ts` (an in-memory OCR supplier and an in-memory Responses supplier that speak the fleet protocol through the injected fetch, sign receipts with generated keys using the real commitment functions, and call `FakeChain.markClaimed` and `markSubmitted`), `test/janitor.test.ts`, `test/llm-prompt.test.ts`

**Interfaces:**
```ts
export interface Deps { chain: Chain; fetchImpl: typeof fetch; renderer: Renderer; clock: () => number; sleep: (ms: number) => Promise<void>; ocrAllowlistPkh: string; llmAllowlist: readonly string[]; indexerUrl?: string; stranded: StrandedStore; deadlineMs: number; }
export interface SubJob { capability_id: string; advert_ref: string; escrow_ref: string; supplier_pkh: string; receipt: Receipt; receipt_signature: string; verification: Record<string, boolean>; }
export interface PipelineResult { schema: 'vector.document-pipeline.result.v1'; source: { sha256: string; bytes: number; mime: string; pages: number }; pages: Array<{ index: number; text: string; sub_job: SubJob }>; result: { summary: string } | { extraction: unknown; schema_valid: boolean; raw_text?: string }; llm_sub_job: SubJob; accounting: { sub_jobs: number; locked_total_lovelace: string; fees_total_lovelace: string } }
export class PipelineError extends Error { constructor(public code: string, message: string, public status = 422) }
export function runPipeline(req: PipelineRequest, deps: Deps): Promise<PipelineResult>;
```
Flow of `runPipeline`: pre-flight `chain.wallet()` (collateral present, float ≥ `(max_pages+1) * 4500000` else `insufficient_float`, 503); `loadSource` → `pagesOf`; `findOcrAdvert` (else `ocr_supplier_unavailable`, 503); for each page in order: if `deadline - now < 480000` throw `deadline`; `promptHash = ocrPromptHash({image_b64, mime, output_format:'markdown'})`; `post = chain.postEscrow({advertRef, promptHash})`; record to `stranded` (escrowRef, deliverBy); send with retries on `busy` every 15 s until `post.deliverBy - 90000`; on `timeout`: read `chain.escrowState`; if `Claimed` and no job id → page fails (`ocr_send_lost`); on `accepted`: poll every 3 s until `done` or `failed` or `post.deliverBy`; on `done`: `responseHash = ocrResponseHash({content, output_format})`, verify with `verifyFleetReceipt` (pub key from `/capability`, model from the advert, `onChainReceiptHash: () => chain.onChainReceiptHash(escrowRef)`); if verdict is not VERIFIED → `ocr_receipt_failed` (the escrow stays with the janitor, which cannot reclaim a Submitted escrow and records it as `lost_to_release` after the window); else `chain.accept(escrowRef)`, remove from `stranded`, push the page with `text = content`; then the LLM job: `selectLlmSupplier` (else `llm_supplier_unavailable`); build the prompt with `src/llm-prompt.ts` (`summary`: instructions in the request's language asking for a plain-text summary of the pages; `extract`: instructions to answer with one JSON object valid against the schema and nothing else; the input carries the page texts with `=== page N ===` separators); `promptHash = responsesPromptHash({input})`; post, send (`{input}` only), poll, `responseHash = responsesResponseHash(body)`, verify, accept; `result` from `responsesOutputText(body)`: for `extract` parse JSON (strip a fenced block if present) and validate with ajv (draft-07 default), `schema_valid` false keeps `raw_text`; accounting sums every post lock and every post and accept fee. Every failure throws `PipelineError` with a stable code; posted but unaccepted escrows stay in the `stranded` store.

`src/janitor.ts`: `StrandedStore` (JSON file at `PIPELINE_STATE_DIR/stranded.json`, atomic write through rename, entries `{escrow_ref, deliver_by, posted_at, kind}`), `runJanitorOnce(store, chain, now)`: for each entry with `now >= deliver_by + 5000`: state `Open|Claimed` → `chain.reclaim`, remove on success; `Submitted` → leave (the supplier may release; record `lost_to_release_after` = deliver_by + 600000, remove once `spent`); `spent|unknown` → remove. `startJanitor(store, chain, intervalMs)` returns `{stop}`.

- [ ] **Step 1: Failing tests** with `FakeChain`, the stub suppliers and a fake renderer: (a) the golden run: two pages, `task summary` → the exact result object (snapshot the pinned JSON in the test with the stub's deterministic receipts; `accounting.sub_jobs` 3, `locked_total_lovelace` `"6783090"`, `fees_total_lovelace` `"3000000"`); (b) `extract` with a schema `{type:'object', required:['title'], properties:{title:{type:'string'}}}` and a stub answer `{"title":"A letter"}` → `schema_valid true`; a stub answer `not json` → `schema_valid false`, `extraction null`, `raw_text 'not json'`, job succeeds; (c) busy then accepted: the stub answers 409 twice, then 202; one escrow only, three sends; (d) a timed-out send with the stub having claimed → `ocr_send_lost`, the escrow is in the stranded store; (e) deadline: a clock that jumps past the budget after page 1 → `deadline`, page 1 accepted, nothing posted for page 2; (f) the receipt of a page tampered by the stub (wrong signature) → `ocr_receipt_failed`, no accept; (g) `insufficient_float` before anything is posted; (h) `llm-prompt.test.ts` pins the exact instructions and input strings for both tasks; (i) `janitor.test.ts`: an Open escrow past its deliver_by is reclaimed and removed; a Submitted one is kept until spent; the store survives a reload.
- [ ] **Step 2 to 5:** run, fail; implement; pass; typecheck; commit `feat(document-pipeline): orchestration, result bundle, accounting, janitor`

### Task 8: The service: manifest, routes, Dockerfile, README

**Files:**
- Create: `agents/document-pipeline/src/server.ts`, `src/index.ts`, `agents/document-pipeline/agent.json.template`, `agents/document-pipeline/Dockerfile`, `agents/document-pipeline/README.md`, `scripts/make-document-pipeline-template.mjs` (or the same mechanism Agent History uses to regenerate its template; read `agents/agent-history/README.md` and mirror it)
- Test: `test/server.test.ts`, `test/spec.test.ts` (mirrors `agents/agent-history/test/spec.test.ts`: the spec's terms and texts equal the manifest's)

Manifest (`manifestFromEnv`): `schema vector.agent-manifest.v1`, `name Document Pipeline`, `capability_id`, `version 0.1.0`, `description` (the spec's first sentence), `operator {name: 'Apex Fusion Foundation', contact: OPERATOR_CONTACT required}`, `identity {did, controller_pkh: SUPPLIER_PKH, registry_address}`, `keys {supplier_pkh, pub_key_hex, buyer_pkh: PIPELINE_BUYER_PKH}`, `interface` with the request schema of the spec and routes `{job: '/v1/job', status: '/status', capability: '/capability'}`, `terms {price_lovelace 5000000, supplier_bond_lovelace 1000000, buyer_bond_lovelace 1000000, max_processing_ms 1800000, input_limits {request_bytes 900000, source_bytes 20971520, inline_media_bytes 600000, max_pages 5}}`, `behaviour {data_handling, third_parties: ['the host of the source URL', 'the ChandraOCR agent, and Datalab behind it', 'the LLM supplier it hires, and its model provider', 'Koios (Vector mainnet indexer)', 'marketplace indexer']}`, `status {chip: AGENT_STATUS_CHIP default 'proposed', since: AGENT_STATUS_SINCE default '2026-10-15'}`, `gaps` (the spec's Known gaps as sentences, shared constants between spec test and code), `links {spec, source, explorer_advert: ADVERT_EXPLORER_URL or ''}`. Server: `GET /healthz` → `{ok:true}` or 503 `{ok:false, reason:'insufficient_float'}` when the last wallet check (cached 60 s) fails; `GET /agent.json`; `POST /` only with the wire contract, body cap 1 MB, `runPipeline` with the real deps (`createRealChain` from `PIPELINE_BUYER_PRIV_KEY_HEX`, safeFetch, popplerRenderer, the janitor started at boot with `PIPELINE_STATE_DIR` default `/data`), result as JSON text exactly as serialized once (`JSON.stringify(result)`), errors as `{error: code, message}` with the `PipelineError` status; everything else 404; exit at start with the variable named when `OPERATOR_CONTACT`, `PIPELINE_BUYER_PRIV_KEY_HEX` or `SUPPLIER_PKH` is missing. Dockerfile: like Agent History's plus `apk add --no-cache tini poppler-utils`, `VOLUME /data`, `PORT 9092`, healthcheck on `/healthz`.

- [ ] **Step 1: Failing tests** mirroring `agents/agent-history/test/server.test.ts`: the manifest from a full env; the template equals `manifestFromEnv` with the four placeholders; missing variables exit with the name; the wire contract (a body that is not the array shape is 400); `POST /` with `runPipeline` injected as a fake returns the exact bytes; a `PipelineError` maps to its status and `{error, message}`; `/healthz` 503 when the float check fails.
- [ ] **Step 2 to 5:** run, fail; implement; pass; typecheck; build the image locally if Docker is available (`docker build -f agents/document-pipeline/Dockerfile .`) and otherwise note it; commit `feat(document-pipeline): service, manifest, Dockerfile`

### Task 9: Deploy pack and CI

**Files:**
- Create: `deploy/apex-web/docker-compose.document-pipeline.yml`, `deploy/apex-web/.env.document-pipeline.example`, `deploy/apex-web/Caddyfile.document-pipeline.snippet`, `deploy/apex-web/RUNBOOK-document-pipeline.md`
- Modify: `deploy/apex-web/README.md` (a second table and the second hostname), `.github/workflows/ci.yml` (publish `ghcr.io/apex-fusion/vector-service-agents/document-pipeline`; `apt-get install -y poppler-utils` before tests so the real renderer test runs in CI), `.dockerignore` if needed
- Test: `scripts/deploy.test.mjs` (new pins for the Pipeline files, same style as the Agent History pins; the status word PROPOSED in all of them)

Compose: project `document-pipeline`; `agent` built from the template at `c4c378abdf2eb507ad454cbeb62b4f48bd5b46a6`, `container_name document-pipeline-agent`, `env_file .env.document-pipeline`, `CAPABILITY_KIND custom`, `SERVICE_URL http://document-pipeline-service:9092/`, `SERVICE_CONTENT_TYPE application/json`, `SERVICE_TIMEOUT_MS "1680000"`, `ADVERT_MAX_PROCESSING_MS "1800000"`, `PORT "8080"`, `PIPELINE_BUYER_PRIV_KEY_HEX: ""`, ports `127.0.0.1:8084:8080`; `service` image pinned by digest placeholder `ghcr.io/apex-fusion/vector-service-agents/document-pipeline@sha256:<digest>`, `container_name document-pipeline-service`, `environment {PORT: "9092", HOST: "0.0.0.0", SUPPLIER_PRIV_KEY_HEX: "", PIPELINE_STATE_DIR: /data}`, volume `document-pipeline-state:/data`. Env example: the supplier block (`SUPPLIER_PRIV_KEY_HEX`, `SUPPLIER_PUB_KEY_HEX`, `SUPPLIER_PKH`, `SUPPLIER_ADDRESS`), the buyer block (`PIPELINE_BUYER_PRIV_KEY_HEX`, `PIPELINE_BUYER_PUB_KEY_HEX`, `PIPELINE_BUYER_PKH`, `PIPELINE_BUYER_ADDRESS`), chain lines as Agent History's, advert lines with price 5000000 and `ADVERT_MAX_PROCESSING_MS=1800000`, `ADVERT_ENDPOINT_URL=https://mp-suppliers-pipeline.hal8.ai`, `ADVERT_DETAIL_URI=https://mp-suppliers-pipeline.hal8.ai/agent.json`, `OPERATOR_CONTACT=<role address>`, `AGENT_DID=`, `AGENT_STATUS_CHIP=proposed`, `AGENT_STATUS_SINCE=2026-10-15`, `OCR_ALLOWLIST_SUPPLIER_PKH=401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9`, `LLM_MODEL_ALLOWLIST=deepseek/deepseek-v4-flash,deepseek-v4-pro,moonshotai/kimi-k2.6,Qwen/Qwen3.6-35B-A3B-FP8`. The runbook: the Agent History runbook's structure with the differences only: two keys generated in step 4 (run `gen-keypair` twice, write the second set into the buyer block), funding of two addresses (supplier 5 then 50; buyer 5 then 100), the registry record name `Document Pipeline`, the stake capability, `/opt/document-pipeline` as the base path, the Caddy block, `--max-processing-ms 1800000 --price-lovelace 5000000` for the advert, the state volume, the first-party run with `PAYLOAD` set to a one-page public PDF URL and `E2E_POLL_MS=15000`, and the janitor's log line to check.

- [ ] **Step 1: Failing pins in `scripts/deploy.test.mjs`** (file exists, status word, container names, ports, `SERVICE_URL`, the two key blocks blanked crosswise, the allowlists, the runbook sections). **Step 2 to 5:** run, fail; write the files; pass; commit `feat(document-pipeline): deploy pack, runbook, CI image`

### Task 10: Documents and spec drift tests

**Files:**
- Modify: `specs/document-pipeline.md` (Status: `PROPOSED (built, not deployed). Since 2026-10-13.`; the Status paragraph: built, tests replay a stub marketplace, not deployed, no registry record, no advert; Identity unchanged; Interface: the response example replaced by the golden result of Task 7 with placeholder hashes marked as such; "How it buys" from design to built fact with the allowlists; Known gaps: the deadline rule, the first-party OCR hop, the subsidy, `schema_valid false` keeps `raw_text`; Changelog: `0.1.0, 2026-10-15: built`; Links: source `agents/document-pipeline`, manifest `none until deployed`), `README.md` (table row stays PROPOSED; one line under "Hire Agent History" that Document Pipeline is built and waits for its deployment), `docs/HIRE.md` (section 5: a second request JSON example for the Pipeline and the 30 min wait; the cost table row is already there), `docs/E2E.md` (the `PAYLOAD` row: the Pipeline's one-page example; a results table per agent or a Run column that names the agent), `scripts/specs.test.mjs` and `agents/document-pipeline/test/spec.test.ts` pins
- Test: `scripts/specs.test.mjs`, `agents/document-pipeline/test/spec.test.ts`

- [ ] **Step 1: Failing pins. Step 2 to 5:** run, fail; edit; pass; commit `docs(document-pipeline): built, not deployed; guide and E2E examples`

### Task 11: Final whole-branch review and PR

- [ ] Run `pnpm install --frozen-lockfile && pnpm typecheck && pnpm test` on the branch; run the real renderer test with poppler if available; build both images with Docker if available.
- [ ] Dispatch the final code reviewer on the most capable model with the full diff against `main`; fix round; open the PR `feat/document-pipeline` → `main` (the host administrator is not required; the operator merges).

Deployment (not a plan task; the operator's runbook): DNS from the host administrator, two keys generated on the box, funding by the operator, steps 7 to 15 of `RUNBOOK-document-pipeline.md`, then the status flip.
