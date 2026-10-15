# Document Pipeline

Reads a document: OCR for each page, then a summary or a structured extraction, with every sub-receipt checked and one receipt over the whole bundle. Capability `document.pipeline.ocr-summary.v1`.

Status: PROPOSED (built, not deployed). Since 2026-10-15. The service is built and its tests replay an in-memory marketplace. It has no registry record and no advert, and no job has run on the ledger. `specs/document-pipeline.md` at the repository root is the specification; this page and the manifest describe the code.

The service sits behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). The runtime holds the supplier key, claims the escrow of the hirer and posts the job to this service as the body of `POST /`. The service buys the sub-jobs and answers with the bundle, which the runtime hashes into the one receipt it signs. The service holds the buyer key and no other. It is a separate key, so that the service's Posts and the supplier key's Claims never contend for the same outputs. For each page it posts an escrow to the allowlisted ChandraOCR advert, sends the page, polls, verifies the sub-receipt and accepts it. Then it does the same with one chat supplier from the model allowlist, for the summary or the extraction. An escrow that a run leaves behind is settled later by a janitor.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts and serves those bytes at `GET /agent.json`. It never serves the template itself. `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>` and `<PIPELINE_BUYER_PKH>` in the template stand for the values in the table below.

## Run it

A run spends real funds: it posts escrows on Vector mainnet from the buyer key. Fund that key only as far as you mean to spend.

```bash
pnpm install
cd agents/document-pipeline
OPERATOR_CONTACT=ops@example.test SUPPLIER_PKH=<56 hex> PIPELINE_BUYER_PRIV_KEY_HEX=<64 hex, from your key file> \
  PIPELINE_STATE_DIR=/tmp/pipeline-state PORT=9092 pnpm start
```

The service logs the buyer address it derived from the key; that is the address to fund. It stops at start, with the variable named, when `OPERATOR_CONTACT`, `PIPELINE_BUYER_PRIV_KEY_HEX` or `SUPPLIER_PKH` is not set, when a setting is not well formed, or when it cannot write to its state directory. A PDF source needs poppler-utils (`pdfinfo`, `pdftoppm`) on the path; the image has it.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}`, or 503 `{"ok":false,"reason":"insufficient_float"}` when the last check of the buyer wallet found that it cannot fund a job of the most pages (a pure output of at least 5000000 lovelace for collateral and 27000000 lovelace outside it) or could not read it. The check is made at most once a minute, in the background: a request is answered from the last one and never waits. Before the first check has answered it is `ok`. |
| `GET /agent.json` | the manifest, the bytes `JSON.stringify` gives |
| `POST /` | the wire message and nothing else |
| any other route | 404 `{"error":"not_found"}` |

The body of `POST /` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`. It is read up to 1000000 bytes. The request JSON is `{ "source": ..., "task": "summary" | "extract", "schema": {...}, "language": "en", "max_pages": 5 }`; the manifest publishes its schema under `interface.request_schema`, and the rules for an extraction schema under `interface.notes`. The answer to a job is `JSON.stringify(result)`, serialised once, exactly the bytes the runtime hashes.

The service does not authenticate its callers. It is meant to be reached only by the runtime, over a private network, and its port is not published: anything that can post to it can start a job that spends from the buyer wallet.

One job runs at a time, because the money of a job is the one buyer wallet's. A second job that arrives while one runs gets 409 `{"error":"busy"}` and nothing is started. A job has its own deadline, 1620000 ms after its request arrives, 60 s inside the runtime's `SERVICE_TIMEOUT_MS` of 1680000.

## Errors

A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table. Anything else is 500 `{"error":"internal"}` with no detail; the cause is in the log, by message only.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_json`, `bad_shape`, `schema_required`, `max_pages_range`, `base64_too_large`, `language_bad`, and `schema_invalid` (the extraction schema breaks a rule) |
| 422, the document | `source_fetch_failed`, `source_mime_mismatch`, `source_unsupported`, `source_too_large`, `unreadable_source`, `page_too_large` |
| 422, the hires | `deadline`, `llm_incomplete`, and for each of the two hops, `ocr_` and `llm_` followed by `post_failed`, `busy`, `refused`, `send_lost`, `failed`, `timeout`, `bad_result`, `receipt_failed`, `receipt_unavailable` or `accept_failed` |
| 503, the service cannot take a job now | `insufficient_float`, `ocr_supplier_unavailable`, `llm_supplier_unavailable` |
| 500, the service | `store_write_failed`, and `internal` |

A 400, a 422 for the document and a 503 are all given before the first escrow is posted, so they spend nothing; the one exception is `llm_supplier_unavailable` when the chat supplier is chosen again after the pages were paid (`src/result.ts` says so). The other 422s come from a hire and may follow money that has moved: `src/hire.ts` says when each of them is thrown.

## Funds, state and the janitor

Before it posts anything a job checks the buyer wallet: a pure output of at least 5000000 lovelace kept as collateral, and a float outside it of `(max_pages + 1) x 4500000` lovelace. A job that cannot be funded is refused with `insufficient_float` and spends nothing.

Every escrow a job posts is written to `stranded.json` in `PIPELINE_STATE_DIR` (default `/data`, a volume in the image) the moment its Post is confirmed, and removed once its Accept is confirmed. The janitor starts with the service and looks at the file every minute: from 5 s after an escrow's `deliver_by` it reclaims an Open or Claimed escrow, and it keeps a Submitted one that its supplier may release. A file that is not a list stops the start and is left as it is, because starting without it would forget escrows that hold funds. The file holds the bookkeeping of the escrows (references, times, the hop, a transaction hash), never a document or its text.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with the five placeholders. A test keeps the two equal, byte for byte, so change the template by changing `manifestFromEnv` and regenerating it: `pnpm --filter @vsa/document-pipeline template`.

| Variable | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `PIPELINE_BUYER_PRIV_KEY_HEX` | the buyer key, 64 lowercase hex characters. Never published, never logged | none. Required |
| `SUPPLIER_PKH` | `identity.controller_pkh` and `keys.supplier_pkh`, 56 hex characters | none. Required |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex`, 64 hex characters | empty |
| `AGENT_DID` | `identity.did` | empty |
| `PIPELINE_BUYER_PKH` | optional. `keys.buyer_pkh` is always the key hash derived from the buyer key; a value here that is not that hash stops the service at start | derived |
| `PIPELINE_BUYER_ADDRESS` | optional, as above, for the mainnet enterprise address of the buyer key | derived |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `5000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms` | `1800000` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-10-15` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `OCR_ALLOWLIST_SUPPLIER_PKH` | the key hash of the one OCR supplier the Pipeline hires | `401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9` |
| `LLM_MODEL_ALLOWLIST` | the chat models it may hire, comma separated, in order of preference | `deepseek/deepseek-v4-flash,deepseek-v4-pro,moonshotai/kimi-k2.6,Qwen/Qwen3.6-35B-A3B-FP8` |
| `PIPELINE_STATE_DIR` | where `stranded.json` is kept | `/data` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer the suppliers are found in | the default of `packages/buyer-core` |
| `PORT`, `HOST` | where the service listens | `9092`, `0.0.0.0` |

Numbers (and `PORT`) must be non-negative integers. `AGENT_STATUS_CHIP` must be live, deployed or proposed, in any case. A value that breaks a rule stops the service at start, and the error names the variable. The chain endpoints are Vector mainnet's; `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL` and `VECTOR_SUBMIT_URL` change them, and `packages/buyer-core` reads them.

The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there. Adverts are immutable, so a changed manifest means a retired advert and a new one. From the repository root, print the hash of a running agent with `node scripts/manifest-hash.mjs https://<host>`.

## Tests

```bash
pnpm --filter @vsa/document-pipeline test
```

The tests need no network and no key: the pipeline runs against the in-memory marketplace of `test/stub-suppliers.ts`, the keys of the service tests are made at run time, and the process tests start `src/index.ts` against a node that is not there. The tests that render a real PDF run only when `pdftoppm` and `pdfinfo` (poppler-utils) are on the path, and are skipped otherwise.

## Image

`Dockerfile` builds the service image. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/document-pipeline/Dockerfile -t vsa/document-pipeline:dev .`. The image runs as the `node` user under `tini`, listens on 9092 and answers `/healthz` for its health check. It installs `poppler-utils` with a base font (`fontconfig`, `ttf-dejavu`), because a PDF whose fonts are not embedded cannot be drawn without one. `/data` is a volume owned by `node`. The memory limit is set where the container is run, not in the image.
