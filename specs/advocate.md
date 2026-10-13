# Advocate

Capability `research.advocate.onesided.v1`. The strongest one-sided brief for a position, with citations. Its bias is declared in the advert's manifest, in its registry description and in every output, so the declaration can be checked against what the agent does.

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
| Registry record, planned | name `Advocate`; a description that states the declared bias; capabilities `research.advocate.onesided.v1`; framework `vector-service-agents`; endpoint the agent's public URL |
| Public URL, planned | `https://mp-suppliers-advocate.hal8.ai` (not in service) |
| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |

## Capability id

`research.advocate.onesided.v1`

The model string in the advert and in every receipt is `advocate-v1`. The output names the model it called separately, under `model`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds no chain key.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 3000000 | 3.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 5000000 | 5.000000 |

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 300000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 180000 ms |
| Search results | 8 to 12 |
| Fetched page text | 1 MB each |
| Length | `short` or `standard` |

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body. The service answers with the brief as the response body, and the runtime hashes that body into the receipt.

The marketplace MCP tools (PROPOSED) and the template's buyer, `try-it/src/buy-once.ts`, wrap the request JSON into the wire payload for you. On the raw routes you wrap it yourself, and you hash the wire payload, not the request JSON.

### Request

Shape:

```text
{ "subject": "...", "side": "for | against | <free-text position>", "audience": "optional", "length": "short | standard", "language": "en" }
```

Example:

```json
{ "subject": "Should a city ban cars from its centre?", "side": "for", "length": "short", "language": "en" }
```

### Response

`schema` is `vector.advocate.brief.v1`. Shape:

```text
{ "declared_bias": { "side": "...", "statement": "This brief argues one side only, by design, and omits counter-arguments." },
  "thesis": "...",
  "arguments": [ { "claim", "support", "sources": [ { "title", "url", "retrieved_at", "quote" } ] } ],
  "sources": [ ... ], "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API", "model": "deepseek/deepseek-v4-flash via OpenRouter" }
```

The declared-bias statement is always present and always reads: "This brief argues one side only, by design, and omits counter-arguments." The manifest carries the same declaration in `behaviour.declared_bias`, and the registry description states it too.

Example, for the request above. Illustrative: nothing is built, so every value is a placeholder and only the field names and nesting are the contract.

```json
{
  "schema": "vector.advocate.brief.v1",
  "declared_bias": { "side": "for", "statement": "This brief argues one side only, by design, and omits counter-arguments." },
  "thesis": "<one sentence>",
  "arguments": [
    {
      "claim": "<claim>",
      "support": "<support>",
      "sources": [{ "title": "<title>", "url": "https://example.org/source", "retrieved_at": "<time>", "quote": "<words found in the fetched text>" }]
    }
  ],
  "sources": [{ "title": "<title>", "url": "https://example.org/source", "retrieved_at": "<time>", "quote": "<words found in the fetched text>" }],
  "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API",
  "model": "deepseek/deepseek-v4-flash via OpenRouter"
}
```

### Backend (design)

None of this is built. The service searches with the Brave Search API (free tier) for 8 to 12 results and fetches the page text of each, through its own safe fetch, 1 MB at most per page. It then makes one model call through OpenRouter, with a fixed system prompt that forbids counter-arguments and requires every claim to cite a fetched source. A post-check drops any claim whose quote is not found in the fetched text.

## What the receipt commits to

The service signs nothing. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the brief exactly as the service returned them |
| `model` | `advocate-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none |
| `wallclock_ms` | how long the service call took |

The brief is the committed output, so the receipt commits the declared-bias block, the thesis, every argument and its sources with their quotes. The post-check means a quote in the brief was found in the page text the service fetched. The receipt does not commit to the page text itself, to the claims being true, or to the brief being balanced: it omits the other side by design.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the subject, the side, the audience, the length and the language. What leaves to third parties:

| Party | What it receives |
|---|---|
| Brave Search API | the search queries the service derives from the subject and the side |
| the host of each result page | the fetch of the page |
| OpenRouter, and the model provider behind it | the subject, the side and the fetched page texts |

Datalab is not used. On the ledger the escrow carries the sha256 of the wire payload, not the request.

## Known gaps

- Not built. Everything on this page is a design.
- One-sided by design. The brief leaves out counter-arguments and rebuttals, and says so in `declared_bias` and `omitted_by_design`. It is not a balanced answer and not a fairness guarantee.
- A quote found in the fetched text shows the source says it, not that the source is right.
- A page that cannot be fetched (blocked, paywalled, or over the 1 MB cap) cannot be cited. The quality of the brief depends on what the search returns.
- A Judge agent that hires two Advocates for opposite sides is a possible follow-up. It is not part of this agent.

## How to hire it

Not yet advertised. When live, the three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The request JSON is, for example, `{"subject":"Should a city ban cars from its centre?","side":"for","length":"short"}`. Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.

1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `research.advocate.onesided.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are PROPOSED.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload.
3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.

## Changelog

No releases. Nothing is built.

## Links

- Manifest: none. There is no service to serve one.
- Source: none. The planned folder is `agents/advocate`.
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- Advert on the explorer: none. The advert is not posted.
