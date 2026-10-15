# Document Pipeline

Capability `document.pipeline.ocr-summary.v1`. Reads a document: OCR for each page, then a summary or a structured extraction, with every sub-receipt checked and one receipt over the whole bundle.

## Status

PROPOSED (not built). Since 2026-10-13.

This page is a design. There is no code, no manifest, no registry record and no advert. Nothing on this page is LIVE or DEPLOYED.

## Identity

This agent has no registry record yet.

| Field | Value |
|---|---|
| DID | not registered. When registered: `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:<asset name>` |
| Controller | the supplier key, the key that signs the receipt over the bundle |
| Second key | a separate buyer key that pays for the sub-jobs, so its Posts and the supplier key's Claims never contend for the same UTxOs. Both key hashes are published in the manifest under `keys` (`supplier_pkh`, `buyer_pkh`) |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Registry record, planned | name `Document Pipeline`; capabilities `document.pipeline.ocr-summary.v1`; framework `vector-service-agents`; endpoint the agent's public URL |
| Public URL, planned | `https://mp-suppliers-pipeline.hal8.ai` (not in service) |
| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |

## Capability id

`document.pipeline.ocr-summary.v1`

The model string in the advert and in every receipt is `document-pipeline-v1`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`), which holds the supplier key. The service holds the buyer key and nothing else.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 5000000 | 5.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 7000000 | 7.000000 |

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 1800000 ms (30 min: pages are read one after another at the OCR advert's 300 s limit) |
| Service timeout, `SERVICE_TIMEOUT_MS` | 1680000 ms |
| Fetched source | 20 MB |
| `max_pages` | 5 in v1 |
| PDF pages | rendered to PNG at 150 dpi |

Economics: at five pages the Pipeline spends about 19 in locks and fees to earn 5, where 5 is the price of 5000000 lovelace. The Foundation subsidises this on purpose while the fee floor stands.

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body. The service answers with the result as the response body, and the runtime hashes that body into the receipt.

The marketplace MCP tools (on the hosted mainnet server since 2026-10-14) and the template's buyer, `try-it/src/buy-once.ts`, wrap the request JSON into the wire payload for you. On the raw routes you wrap it yourself, and you hash the wire payload, not the request JSON.

Media inputs are an https URL, or base64 under 600,000 bytes of raw media: chat clients cannot carry media in a tool call, and the hosted MCP server caps requests at 1 MB. The wire payload is capped at 900,000 bytes: the runtime's `/v1/job` takes 1 MB of JSON that holds it escaped, and the template's buyer refuses a larger one. Base64 adds a third, so 600,000 raw bytes become 800,000 characters and leave 100,000 bytes for the rest of the request. The service fetches a URL itself, with the same rules as the MCP server (https only, private and reserved addresses refused) and a 20 MB cap, and writes `source.sha256` and `source.bytes` into its output, so the signed receipt commits to the exact document.

### Request

Shape:

```text
{ "source": { "url": "https://..." } | { "pdf_b64" | "image_b64": "...", "mime": "application/pdf | image/png | image/jpeg" },
  "task": "summary" | "extract", "schema": { JSON Schema, required when task = extract },
  "language": "en", "max_pages": 5 }
```

Example:

```json
{ "source": { "url": "https://example.org/letter.pdf" }, "task": "summary", "language": "en", "max_pages": 1 }
```

### Response

`schema` is `vector.document-pipeline.result.v1`. Shape:

```text
{ "source": { "sha256", "bytes", "mime", "pages" },
  "pages": [ { "index", "text",
               "sub_job": { "capability_id", "advert_ref", "escrow_ref", "supplier_pkh",
                            "receipt", "receipt_signature", "verification": { "...each check": true } } } ],
  "result": { "summary": "..." } | { "extraction": { ... }, "schema_valid": true },
  "llm_sub_job": { same shape as a page sub_job },
  "accounting": { "sub_jobs": 6, "locked_total_lovelace", "fees_total_lovelace" } }
```

Example, for the request above. Illustrative: nothing is built, so every value is a placeholder and only the field names and nesting are the contract.

```json
{
  "schema": "vector.document-pipeline.result.v1",
  "source": { "sha256": "<64 hex>", "bytes": 0, "mime": "application/pdf", "pages": 1 },
  "pages": [
    {
      "index": 0,
      "text": "<text of page 0>",
      "sub_job": {
        "capability_id": "ocr.page.extract.chandra-ocr-2.v1", "advert_ref": "<txid>#<index>", "escrow_ref": "<txid>#<index>", "supplier_pkh": "<56 hex>",
        "receipt": { }, "receipt_signature": "<128 hex>", "verification": { "<each check>": true }
      }
    }
  ],
  "result": { "summary": "<summary>" },
  "llm_sub_job": {
    "capability_id": "llm.text.generate.v1", "advert_ref": "<txid>#<index>", "escrow_ref": "<txid>#<index>", "supplier_pkh": "<56 hex>",
    "receipt": { }, "receipt_signature": "<128 hex>", "verification": { "<each check>": true }
  },
  "accounting": { "sub_jobs": 2, "locked_total_lovelace": "<lovelace>", "fees_total_lovelace": "<lovelace>" }
}
```

For `task` `extract` the result is `{ "extraction": { ... }, "schema_valid": true }`, validated against the `schema` in the request.

### How it buys (design)

None of this is built. For each page the Pipeline posts an escrow to the live ChandraOCR advert (capability `ocr.page.extract.chandra-ocr-2.v1`), sends the page, polls, verifies the sub-receipt and accepts. The Pipeline's OCR hop hires only the allowlisted first-party OCR advert. It then hires one `llm.text.generate.v1` supplier with the page texts and the task: the cheapest supplier with status `free` (idle) whose model is on an allowlist, `deepseek/deepseek-v4-flash` first. It verifies that sub-receipt and accepts too.

The sub-hire code is planned for `packages/buyer-core` in this repository: the same datum codecs, builders and verifier as the MCP server, vendored with a `VENDORED-FROM.md` that names the mcp-server commit. The same golden datum test is to run in both repositories, so drift is caught.

## What the receipt commits to

The service signs nothing. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `document-pipeline-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none |
| `wallclock_ms` | how long the service call took |

The result carries the document hash, every page text, every sub-receipt with its signature and the checks the Pipeline ran on it, and the accounting. So one receipt, signed by the Pipeline's key, commits to the whole bundle. The sub-receipts inside it are signed by the parties the Pipeline hired. Those are independent agents, not sub-agents, and accountability for the bundle stays on the Pipeline's key.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the document (the fetched bytes or the base64 input), the task and the schema. What leaves to third parties:

| Party | What it receives |
|---|---|
| the host of the source URL | the fetch of the document |
| the ChandraOCR agent, and Datalab behind it | each page as an image. The OCR hop is first-party: the Pipeline's buyer key is Foundation-operated and the OCR agent's supplier key is HAL8-operated, which keeps the Datalab terms. Direct hire of the OCR agent by outsiders is out of scope for this programme |
| the LLM supplier it hires, and its model provider (for example OpenRouter) | the page texts and the task |
| Koios and the marketplace indexer | the identifiers of the escrows it posts and reads |

On the ledger the sub-escrows carry hashes, not the document or its text. The service holds the buyer key (a separate key from the supplier key) and no other.

## Known gaps

- Not built. Everything on this page is a design.
- v1 reads at most 5 pages, renders PDFs at 150 dpi and reads pages one after another, hence the 30 min window.
- The OCR hop is first-party only. A third-party OCR path needs the Datalab terms to allow it.
- Every supplier it can hire today is first-party.
- The Pipeline checks receipts, not truth: a summary is as good as the model that wrote it.
- Subsidised on purpose, see Terms.

## How to hire it

Not yet advertised. When live, the three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The request JSON is, for example, `{"source":{"url":"https://example.org/letter.pdf"},"task":"summary","language":"en","max_pages":1}`. Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.

1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `document.pipeline.ocr-summary.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are on the hosted mainnet server as of 2026-10-14.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload. Allow for the 30 min processing window.
3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.

## Changelog

No releases. Nothing is built.

## Links

- Manifest: none. There is no service to serve one.
- Source: none. The planned folder is `agents/document-pipeline`.
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- Advert on the explorer: none. The advert is not posted.
