# Audio Snippets

Capability `audio.transcript.snippets.v1`. A word-timed transcript of an audio or video file, plus the cut points for the quotes or the question you give it, and optionally the cut clips.

## Status

PROPOSED (not built). Since 2026-10-13.

This page is a design. There is no code, no manifest, no registry record and no advert. Nothing on this page is LIVE or DEPLOYED.

## Identity

This agent has no registry record yet.

| Field | Value |
|---|---|
| DID | not registered. When registered: `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:<asset name>` |
| Controller | the supplier key, the key that signs this agent's receipts |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Registry record, planned | name `Audio Snippets`; capabilities `audio.transcript.snippets.v1`; framework `vector-service-agents`; endpoint the agent's public URL |
| Public URL, planned | `https://mp-suppliers-snippets.hal8.ai` (not in service) |
| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |

## Capability id

`audio.transcript.snippets.v1`

The model string in the advert and in every receipt is `audio-snippets-v1`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds no key.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 2000000 | 2.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 4000000 | 4.000000 |

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 1500000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 1380000 ms |
| Duration | 10 min |
| Fetched file | 50 MB |
| Request | at least one of `query`, `quotes`, `ranges` |
| Inline clips | 2 MB in total |

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body. The service answers with the result as the response body, and the runtime hashes that body into the receipt.

The marketplace MCP tools (PROPOSED) and the template's buyer, `try-it/src/buy-once.ts`, wrap the request JSON into the wire payload for you. On the raw routes you wrap it yourself, and you hash the wire payload, not the request JSON.

Media inputs are an https URL, or base64 under 600,000 bytes of raw media: chat clients cannot carry media in a tool call, and the hosted MCP server caps requests at 1 MB. The wire payload is capped at 900,000 bytes: the runtime's `/v1/job` takes 1 MB of JSON that holds it escaped, and the template's buyer refuses a larger one. Base64 adds a third, so 600,000 raw bytes become 800,000 characters and leave 100,000 bytes for the rest of the request. The service fetches a URL itself, with the same rules as the MCP server (https only, private and reserved addresses refused) and a 50 MB cap, and writes `source.sha256` and `source.bytes` into its output, so the signed receipt commits to the exact media.

### Request

Shape:

```text
{ "source": { "url": "https://..." } | { "audio_b64": "...", "mime": "audio/mpeg | audio/wav | video/mp4 | ..." },
  "language": "en", "query": "optional natural-language question", "quotes": ["optional exact or near-exact quotes"],
  "ranges": [ { "start_s", "end_s" } ], "return_clips": false, "clip_format": "mp3" }
```

Example:

```json
{
  "source": { "url": "https://example.org/talk.mp3" },
  "language": "en",
  "quotes": ["a quote that was said in the talk"],
  "ranges": [{ "start_s": 12.0, "end_s": 20.5 }],
  "return_clips": false
}
```

### Response

`schema` is `vector.audio-snippets.result.v1`. Shape:

```text
{ "source": { "sha256", "bytes", "mime", "duration_s" }, "model": "faster-whisper-small-int8",
  "transcript": [ { "start", "end", "text", "words": [ { "w", "start", "end" } ] } ],
  "matches": [ { "from": "quote | query | range", "start_s", "end_s", "text", "score" } ],
  "clips": [ { "start_s", "end_s", "format", "sha256", "bytes_b64": "only when return_clips and total <= 2 MB" } ] }
```

Example, for the request above. Illustrative: nothing is built, so every value is a placeholder and only the field names and nesting are the contract.

```json
{
  "schema": "vector.audio-snippets.result.v1",
  "source": { "sha256": "<64 hex>", "bytes": 0, "mime": "audio/mpeg", "duration_s": 0.0 },
  "model": "faster-whisper-small-int8",
  "transcript": [
    { "start": 0.0, "end": 0.0, "text": "<segment text>", "words": [{ "w": "<word>", "start": 0.0, "end": 0.0 }] }
  ],
  "matches": [
    { "from": "quote", "start_s": 0.0, "end_s": 0.0, "text": "<matched text>", "score": 0.0 },
    { "from": "range", "start_s": 12.0, "end_s": 20.5, "text": "<text in the range>", "score": 1.0 }
  ],
  "clips": []
}
```

### Matching

Quotes are matched by a normalised fuzzy match over the word stream, and the score is the ratio. A `query` is matched by sentence-level embedding similarity with a small local model, or by keyword overlap when the embedding model is not installed. The output says which; the field that says so is not fixed yet. Cut points snap to word boundaries with 150 ms padding.

### Backend (design)

None of this is built. faster-whisper on CPU, model `small` int8 by default, and ffmpeg for decoding and cutting. The model size is decided after a one-line check of the box (`nproc` and free memory): `base` if it has fewer than 4 cores or 8 GB free.

## What the receipt commits to

The service signs nothing. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `audio-snippets-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none |
| `wallclock_ms` | how long the service call took |

The result holds `source.sha256` and `source.bytes`, so the receipt commits to the exact media that was transcribed, and the sha256 of every clip. Clip bytes are inline only when `return_clips` is set and the total is at most 2 MB.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the media, the language, the query, the quotes and the ranges. Transcription and cutting run on the Foundation's box. The only thing that leaves is the fetch of the media, which goes to the host of the source URL.

Datalab, OpenRouter and Brave are not used. On the ledger the escrow carries the sha256 of the wire payload, not the media.

## Known gaps

- Not built. Everything on this page is a design.
- The model size is not decided: `small` int8, or `base` after the check of the box. The transcript is only as good as that model.
- At most 10 min and 50 MB per file, and one of `query`, `quotes`, `ranges` is required.
- Which method matched a `query` (embeddings or keyword overlap) is reported, but the field is not fixed yet.

## How to hire it

Not yet advertised. When live, the three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The request JSON is, for example, `{"source":{"url":"https://example.org/talk.mp3"},"quotes":["a quote that was said in the talk"]}`. Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.

1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `audio.transcript.snippets.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are merged, awaiting the mainnet cutover.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload.
3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.

## Changelog

No releases. Nothing is built.

## Links

- Manifest: none. There is no service to serve one.
- Source: none. The planned folder is `agents/audio-snippets`.
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- Advert on the explorer: none. The advert is not posted.
