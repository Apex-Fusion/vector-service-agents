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
export PIPELINE_BUYER_PRIV_KEY_HEX="$(cat /path/to/buyer-key.hex)"   # read from a file: a key typed on a command line stays in the shell's history
export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"           # the token a caller must send: made, not typed
OPERATOR_CONTACT=ops@example.test SUPPLIER_PKH=<56 hex> PIPELINE_STATE_DIR=/tmp/pipeline-state PORT=9092 pnpm start
```

The service logs the buyer address it derived from the key; that is the address to fund. It stops at start, with the variable named, when `OPERATOR_CONTACT`, `PIPELINE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH` or `SERVICE_AUTH_HEADER` is not set, when a setting is not well formed, when `ADVERT_MAX_PROCESSING_MS` is below 30 min, or when it cannot write to its state directory. It also asks `pdfinfo` and `pdftoppm` (poppler-utils) for their version before it listens, and does not start if either cannot be run, so that an image without them cannot answer `/healthz` ok and then fail every PDF. The image has them; a machine you run the service on needs them on the path.

A secret in the wrong line of an env file is the mistake the start guards against. The buyer key is looked for in every other setting the service reads, before any check can print that line, and found there it stops the start, naming the variable and not showing the value (a value that is published, such as `AGENT_DID`, would otherwise go out in `/agent.json`). No message of the service shows a setting that is hex-shaped or long, only its length. `SUPPLIER_PUB_KEY_HEX` must be the public key of `SUPPLIER_PKH`, which catches a private key put in its line. The manifest is searched for the buyer key once more before the service listens. The service token is a secret of the same kind: it is in no message, no log line and no answer, and the manifest is searched for it too, whole or by its credential (the part after `Bearer `).

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}`, or 503 `{"ok":false,"reason":"insufficient_float"}` when the last check of the buyer wallet found that it cannot fund a job of the most pages (a pure output of at least 5000000 lovelace for collateral and 27000000 lovelace outside it) or could not read it. The check is made at most once a minute, in the background: a request is answered from the last one and never waits. Before the first check has answered it is `ok`. |
| `GET /agent.json` | the manifest, the bytes `JSON.stringify` gives |
| `POST /` | the wire message and nothing else, with the `authorization` header of the runtime. Without it, 401 |
| any other route | 404 `{"error":"not_found"}` |

The body of `POST /` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`. It is read up to 1000000 bytes. The request JSON is `{ "source": ..., "task": "summary" | "extract", "schema": {...}, "language": "en", "max_pages": 5 }`; the manifest publishes its schema under `interface.request_schema`, and the rules for an extraction schema under `interface.notes`. The answer to a job is `JSON.stringify(result)`, serialised once, exactly the bytes the runtime hashes.

`POST /` requires the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`, the value the template runtime sends with every call to a custom service (`agent/src/executor/httpCallout.ts` of `vector-agent-template`). The runtime and the service read it from the same env file, and neither blanks it. A call without the header, or with another value, gets 401 `{"error":"unauthorized"}`, with no detail, before the body is read and before a job slot is taken: a stranger neither makes the service read a megabyte nor learns, from a 409, that a job is running. The two values are compared in constant time (`crypto.timingSafeEqual` on their sha256 digests, which are of one length whatever the values are), and a refusal is logged once a minute at most, with a count and nothing the caller sent. `GET /healthz` and `GET /agent.json` need no header: the image's health check sends none, and the manifest is public. The port is not published and the service is meant to be reached only by the runtime, over a private network, but other stacks share that network and a job spends from the buyer wallet, so the token is the second lock. It is made, not typed (`openssl rand -hex 32`), and kept in the env file and nowhere else.

One job runs at a time, because the money of a job is the one buyer wallet's. A second job that arrives while one runs gets 409 `{"error":"busy"}` and nothing is started. A job has its own deadline, 1620000 ms after its request arrives, 60 s inside the runtime's `SERVICE_TIMEOUT_MS` of 1680000.

While a job runs, the server writes an interim `102 Processing` line every 60 s to a client that speaks HTTP/1.1, ahead of the answer, which is the same 200 with the same body as it would be without them. The reason is that the runtime's fetch gives up after 300 s of silence (the headers timeout of undici, behind fetch) and a job takes up to 27 minutes: without the lines the runtime would report `service_unreachable` at the five minute mark while the service goes on hiring and paying, and holds its slot. An interim response counts as life, and a client reads past it. The lines stop when the job ends.

## Errors

A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table. A failure on the service's side (the 500 and the 503 rows) gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer and the detail (a path, an escrow, the text of a provider) is the operator's: the whole message is in the log. Anything else is 500 `{"error":"internal"}` with no detail; the cause is in the log, by message only. The 401 has no message at all: it says only that the call was not the runtime's.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_json`, `bad_shape`, `schema_required`, `max_pages_range`, `base64_too_large`, `language_bad`, and `schema_invalid` (the extraction schema breaks a rule) |
| 401, the caller | `unauthorized` (the call has no authorization header, or one that is not the token of the service) |
| 422, the document | `source_fetch_failed`, `source_mime_mismatch`, `source_unsupported`, `source_too_large`, `unreadable_source`, `page_too_large` |
| 422, the hires | `deadline`, `llm_incomplete`, and for each of the two hops, `ocr_` and `llm_` followed by `post_failed`, `busy`, `refused`, `send_lost`, `failed`, `timeout`, `bad_result`, `receipt_failed`, `receipt_unavailable` or `accept_failed` |
| 503, the service cannot take a job now | `insufficient_float`, `ocr_supplier_unavailable`, `llm_supplier_unavailable`, and `shutting_down` (the service is stopping) |
| 500, the service | `store_write_failed`, and `internal` |

A 400, a 401, a 422 for the document and a 503 are all given before the first escrow is posted, so they spend nothing; the one exception is `llm_supplier_unavailable` when the chat supplier is chosen again after the pages were paid (`src/result.ts` says so). The other 422s come from a hire and may follow money that has moved: `src/hire.ts` says when each of them is thrown.

## Funds, state and the janitor

Before it posts anything a job checks the buyer wallet: a pure output of at least 5000000 lovelace kept as collateral, and a float outside it of `(max_pages + 1) x 4500000` lovelace. That gate assumes adverts priced at or under the two ceilings with bonds of 1000000 each. Once both suppliers are chosen, and still before the first Post, the job looks at the float again: the lock each sub-job takes at the prices of the adverts chosen, and a Post and an Accept fee for each. A job that cannot be funded is refused with `insufficient_float` and spends nothing.

Every escrow a job posts is written to `stranded.json` in `PIPELINE_STATE_DIR` (default `/data`, a volume in the image) the moment its Post is confirmed, and removed once its Accept is confirmed. The janitor starts with the service and looks at the file every minute: from 5 s after an escrow's `deliver_by` it reclaims an Open or Claimed escrow, and it keeps a Submitted one that its supplier may release. A file that is not a list stops the start and is left as it is, because starting without it would forget escrows that hold funds. The file holds the bookkeeping of the escrows (references, times, the hop, a transaction hash), never a document or its text.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, waits up to 300 s for the job that is running to be answered, and exits 0. A job that is still running then has its connection closed, and the escrows it posted are in the state directory for the janitor of the next start. The container is killed when its grace period ends, so set `stop_grace_period` in the compose file to at least 300 s. A second signal ends the process at once.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with the five placeholders. A test keeps the two equal, byte for byte, so change the template by changing `manifestFromEnv` and regenerating it: `pnpm --filter @vsa/document-pipeline template`.

| Variable | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `PIPELINE_BUYER_PRIV_KEY_HEX` | the buyer key, 64 lowercase hex characters. Never published, never logged | none. Required |
| `SUPPLIER_PKH` | `identity.controller_pkh` and `keys.supplier_pkh`, 56 hex characters | none. Required |
| `SERVICE_AUTH_HEADER` | the `authorization` header the runtime sends with every call, which `POST /` requires: `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required: the service stops at start without it |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex`, 64 hex characters | empty |
| `AGENT_DID` | `identity.did` | empty |
| `PIPELINE_BUYER_PKH` | optional. `keys.buyer_pkh` is always the key hash derived from the buyer key; a value here that is not that hash stops the service at start | derived |
| `PIPELINE_BUYER_ADDRESS` | optional, as above, for the mainnet enterprise address of the buyer key | derived |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `5000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms`; at least 1800000, because the deadline of a job assumes the 30 min window | `1800000` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-10-15` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `OCR_ALLOWLIST_SUPPLIER_PKH` | the key hash of the one OCR supplier the Pipeline hires | `401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9` |
| `LLM_MODEL_ALLOWLIST` | the chat models it may hire, comma separated, in order of preference | `deepseek/deepseek-v4-flash,deepseek-v4-pro,moonshotai/kimi-k2.6,Qwen/Qwen3.6-35B-A3B-FP8` |
| `OCR_MAX_PRICE_LOVELACE` | the most an OCR page may be priced at, in lovelace: an advert priced above it is not hired, and the job is refused with `ocr_supplier_unavailable` (503) before it spends anything | `1000000` |
| `LLM_MAX_PRICE_LOVELACE` | the most the chat job may be priced at, in lovelace, the same way (`llm_supplier_unavailable`) | `1000000` |
| `PIPELINE_STATE_DIR` | where `stranded.json` is kept | `/data` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer the suppliers are found in | the default of `packages/buyer-core` |
| `PORT`, `HOST` | where the service listens | `9092`, `0.0.0.0` |

Numbers (and `PORT`) must be non-negative integers. `AGENT_STATUS_CHIP` must be live, deployed or proposed, in any case. A value that breaks a rule stops the service at start, and the error names the variable. The chain endpoints are Vector mainnet's; `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL` and `VECTOR_SUBMIT_URL` change them, and `packages/buyer-core` reads them.

The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there. Adverts are immutable, so a changed manifest means a retired advert and a new one. From the repository root, print the hash of a running agent with `node scripts/manifest-hash.mjs https://<host>`.

## Tests

```bash
pnpm --filter @vsa/document-pipeline test
```

The tests need no network and no key: the pipeline runs against the in-memory marketplace of `test/stub-suppliers.ts`, the keys of the service tests are made at run time, and the process tests start `src/index.ts` against a node that is not there, with stand-ins for `pdfinfo` and `pdftoppm` first on the path (the start asks them for their version). The tests that render a real PDF, and the one that runs the check on the real tools, run only when `pdftoppm` and `pdfinfo` (poppler-utils) are on the path, and are skipped otherwise. The interim lines of a long job are read off a raw socket, because fetch hides them; a real SIGTERM cannot be sent to a child process on Windows, so the signal handling is tested through the `process` object.

## Image

`Dockerfile` builds the service image. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/document-pipeline/Dockerfile -t vsa/document-pipeline:dev .`. The image runs as the `node` user under `tini`, listens on 9092 and answers `/healthz` for its health check. It installs `poppler-utils` with a base font (`fontconfig`, `ttf-dejavu`), because a PDF whose fonts are not embedded cannot be drawn without one. `/data` is a volume owned by `node`. The memory limit is set where the container is run, not in the image.
