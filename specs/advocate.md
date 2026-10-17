# Advocate

Capability `research.advocate.onesided.v1`. The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output.

## Status

PROPOSED (built, not deployed). Since 2026-10-13.

The service is built. Its tests run the search, the pages, the model and the check against stand-ins for the Brave Search API, the result pages and OpenRouter, with no network. It is not deployed yet: it has no registry record and no advert, and no job has run. Nothing on this page is LIVE or DEPLOYED.

## Identity

This agent has no registry record yet.

| Field | Value |
|---|---|
| DID | not registered. When registered: `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:<asset name>` |
| Controller | the supplier key, the key that signs this agent's receipts. The manifest publishes its key hash as `identity.controller_pkh` and `keys.supplier_pkh`, and its public key as `keys.pub_key_hex`: the service does not start unless the public key hashes to the key hash |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Registry record, planned | name `Advocate`; description as in the manifest, which declares the bias; capabilities `research.advocate.onesided.v1`; framework `vector-service-agents`; endpoint the agent's public URL |
| Public URL, planned | `https://mp-suppliers-advocate.hal8.ai` (not in service) |
| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |

## Capability id

`research.advocate.onesided.v1`

The model string in the advert and in every receipt is `advocate-v1`. The result names the model the service asked separately, under `model`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds no chain key. It holds the two API keys of its third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`. Each is sent only to its own party, and neither reaches an answer, a log line or the manifest.

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
| Job deadline, set by the service when a request arrives | 150000 ms (30 s inside the service timeout) |
| Search | two queries, one after the other, the second at least 1100 ms after the first, each at most 10000 ms, and 15000 ms for both |
| Pages | four fetches at a time, at most 15000 ms each; the fetch of the pages ends 45000 ms after it begins, or 20000 ms before the deadline when that comes first |
| Model | the smaller of 90000 ms and the time the job has left less 5000 ms, and not called when that is under 15000 ms |
| Request | at most 900000 bytes of wire payload; `subject` 1 to 300 characters, `side` 1 to 120, `audience` 1 to 200 |
| Search results | at most 12, https only |
| Page | at most 1 MB (1048576 bytes) fetched and at least 200 characters of text; the first 12000 characters are read |
| Quote | 20 to 300 characters |
| Length | `short`, a thesis and 3 arguments asked for, or `standard`, a thesis and 5 to 7 arguments asked for; the check can leave fewer; `standard` by default |

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The wire payload is also the `payload` field of `POST /v1/job`, and the runtime claims the escrow and posts it unchanged to the service as the HTTP body. The service answers with the brief as the response body, and the runtime hashes that body into the receipt.

The marketplace MCP tools (on the hosted mainnet server since 2026-10-14) and the template's buyer, `try-it/src/buy-once.ts`, wrap the request JSON into the wire payload for you. On the raw routes you wrap it yourself, and the hash you put in the escrow is the hash of the wire payload.

A request names no page: the service finds the pages with the Brave Search API and fetches them itself, with the same rules as the MCP server (https only, no credentials in the URL, private and reserved addresses refused, redirects refused), at most 1 MB a page, so the brief can cite only what the service could fetch.

### Request

Shape:

```text
{ "subject": "...", "side": "for | against | <free-text position>", "audience": "optional", "length": "short | standard", "language": "en" }
```

Example:

```json
{ "subject": "Should a city ban cars from its centre?", "side": "for", "length": "short", "language": "en" }
```

The request is a JSON object with these keys and no other. A request that breaks a rule is refused with `bad_shape` (400) before anything is searched or fetched, so it locks nothing of the service's.

| Field | Rule |
|---|---|
| `subject`, required | 1 to 300 characters, with at least one letter or digit: the question or the position the brief is about. |
| `side`, required | `for` or `against`, in any case, or a position in words of 1 to 120 characters with at least one letter or digit. `for` and `against` are kept in lower case and a position as given, without the spaces around it; the side is returned in `declared_bias.side`. |
| `audience` | 1 to 200 characters: who the brief is for. The model is told it. |
| `length` | `short` or `standard`, default `standard`. |
| `language` | Default `en`. A language code of 2 to 16 characters: 2 to 8 letters, then any number of hyphen-separated subtags of 1 to 8 letters or digits, such as `en`, `en-GB` or `zh-Hant-TW`. The brief is written in it. The search is not told it. `auto` is refused, for it names no language. |

Then the job runs in this order, under its deadline:

- The search: two queries to the Brave Search API, made from the subject and the side, with no language parameter and no country, one after the other, the second at least 1100 ms after the first: the subject alone, and the subject followed by the words of the side (`arguments in favour` for `for`, `arguments against` for `against`, the position itself for a position in words), each cut at a word boundary to at most 400 characters and 50 words, 10 results each. A query that answers 429 is asked once more, 1100 ms later. The results of the second query come first; a result is kept once, by its scheme, host and path, and only when its URL is https; at most 12 are kept. One query that fails is enough to go on with the other. Both failing is `search_failed` (502), and so is a key that the Brave Search API refuses. No usable result is `search_empty` (502).
- The pages: each result is fetched by the service, four at a time. A page is kept only when it answers within 15 s with no redirect and no error, is HTML or plain text, is at most 1 MB and has at least 200 characters of text; its first 12000 characters are its excerpt, and the kept pages are numbered from 1 in the order of the results. No page kept is `no_sources` (502).
- The model: one call through OpenRouter with a fixed prompt, which asks for the strongest brief for the side, with no counter-argument, no rebuttal and no concession, every claim citing the numbered pages, each with a quote of 20 to 300 characters copied from that page. A call that fails is `model_failed` (502), and an answer that is not the JSON of a brief is `model_output_invalid` (502). With under 15 s left the model is not called, and the job fails with `deadline` (422).
- The check: see Check below. No argument left is `no_supported_claims` (502).

### Response

`schema` is `vector.advocate.brief.v1`. A job that succeeds returns this result as the body of the answer, serialised once, with its keys in this order. A job that fails returns an error (see Errors) and no result. Shape:

```text
{ "schema": "vector.advocate.brief.v1",
  "declared_bias": { "side": "...", "statement": "This brief argues one side only, by design, and omits counter-arguments." },
  "thesis": "...",
  "arguments": [ { "claim", "support", "sources": [ { "title", "url", "retrieved_at", "quote" } ] } ],
  "sources": [ { "title", "url", "retrieved_at", "quote" } ], "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API", "model": "deepseek/deepseek-v4-flash via OpenRouter" }
```

The declared-bias statement is always present and always reads: "This brief argues one side only, by design, and omits counter-arguments." The manifest carries the same declaration in `behaviour.declared_bias`, and the registry description, which is the manifest's, declares the bias too.

Example, for the request above. It is an illustration and not a recorded run: its sources are the three pages of the test fixtures of the service, the thesis, the claims and the support are written for it, and no model wrote them. Every quote in it is found in the text of its page, as the check requires. The `model` field reads as the service names its default model, `deepseek/deepseek-v4-flash via OpenRouter`.

```json
{
  "schema": "vector.advocate.brief.v1",
  "declared_bias": {
    "side": "for",
    "statement": "This brief argues one side only, by design, and omits counter-arguments."
  },
  "thesis": "A city should close its centre to cars: the streets that did so drew more shoppers, cleaner air at the school gate and calmer deliveries.",
  "arguments": [
    {
      "claim": "Shops in a car-free centre gain customers.",
      "support": "Footfall is the measure shops live by, and where centres were closed to cars the council's own count showed it rising within two years. Shopkeepers who had feared the change saw customers stay longer once the traffic had gone.",
      "sources": [
        {
          "title": "Car-free centres: what the evidence says",
          "url": "https://example.org/car-free-centres",
          "retrieved_at": "2026-10-17T09:00:00.000Z",
          "quote": "retail footfall rise by eleven percent within two years"
        }
      ]
    },
    {
      "claim": "Children breathe cleaner air on the way to school.",
      "support": "Closing a street to through traffic cut nitrogen dioxide at the school gate by a third within a year, on weekdays and at weekends alike, and the gain falls on the youngest first.",
      "sources": [
        {
          "title": "Clean air and the school run",
          "url": "https://example.net/clean-air",
          "retrieved_at": "2026-10-17T09:00:00.000Z",
          "quote": "fell by a third in the first year"
        }
      ]
    },
    {
      "claim": "Deliveries keep working when the centre closes to cars.",
      "support": "Freight moved to early-morning windows and the vans in the centre at noon halved, so the streets are freed at their busiest hour and the shops still get their goods, between six and ten in the morning.",
      "sources": [
        {
          "title": "Notes on urban freight",
          "url": "https://example.com/freight.txt",
          "retrieved_at": "2026-10-17T09:00:00.000Z",
          "quote": "the number of vans in the centre at noon halved"
        }
      ]
    }
  ],
  "sources": [
    {
      "title": "Car-free centres: what the evidence says",
      "url": "https://example.org/car-free-centres",
      "retrieved_at": "2026-10-17T09:00:00.000Z",
      "quote": "retail footfall rise by eleven percent within two years"
    },
    {
      "title": "Clean air and the school run",
      "url": "https://example.net/clean-air",
      "retrieved_at": "2026-10-17T09:00:00.000Z",
      "quote": "fell by a third in the first year"
    },
    {
      "title": "Notes on urban freight",
      "url": "https://example.com/freight.txt",
      "retrieved_at": "2026-10-17T09:00:00.000Z",
      "quote": "the number of vans in the centre at noon halved"
    }
  ],
  "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API",
  "model": "deepseek/deepseek-v4-flash via OpenRouter"
}
```

| Field | Content |
|---|---|
| `schema` | `vector.advocate.brief.v1` |
| `declared_bias` | `side`, the side the request gave, as the intake keeps it, and `statement`, the fixed sentence above |
| `thesis` | the thesis of the brief, as the model wrote it |
| `arguments[]` | the arguments the check kept, in the order the model gave them, each with its `claim`, its `support` and its `sources`: for each source the `title` and the `url` of the page, `retrieved_at`, the time the service fetched it (ISO 8601, UTC), and the `quote` that was found in its text |
| `sources[]` | every source that the kept arguments cite, once for each page and quote, in the order they are first cited |
| `omitted_by_design` | always `counter-arguments and rebuttals` |
| `search` | always `Brave Search API` |
| `model` | the model the service asked, `<model> via OpenRouter`: `deepseek/deepseek-v4-flash via OpenRouter` unless `OPENROUTER_MODEL` names another |

### Check

A source the model cites is a page number and a quote. The quote is kept when the number names a page the service kept, and the quote, normalised, is 20 to 300 characters long and is found in the normalised excerpt of that page. To normalise a text, the service takes its Unicode NFKC form in lower case, makes the apostrophes U+2019 and U+02BC into U+0027, the double quotes U+201C and U+201D into U+0022 and the dashes U+2013 and U+2014 into U+002D, and makes every run of whitespace one space, without the spaces at either end. A quote that fails is dropped. An argument left with no quote is dropped, and the thesis stays. A job whose every argument is dropped fails with `no_supported_claims` (502): the thesis never answers alone. A quote may be cited by more than one argument.

### Errors

A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.

- The 401 and `internal` have the code and no message.
- The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after `deliver_by`.
- A job that fails with a code of the 502 row answers with a fixed message: `The service could not do this job (<code>). The operator's log has the detail.` The codes of the 502 row are failures at a third party or of the check. `deadline` (422) keeps its words, which are about the time the job had and hold nothing of the request. `aborted` (499) is the answer to a caller that has hung up, which nobody reads.
- `shutting_down` says that the service is stopping.
- One job runs at a time. A second request while one runs gets 409 `{"error":"busy"}`, and nothing is started.
- `GET /healthz` and `GET /agent.json` are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. Any other route gets 404 `{"error":"not_found"}`, a `POST /` with a query string among them.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that does not parse, or one that breaks a rule of Request) |
| 401, the caller | `unauthorized` (the call has no authorization header, or one that is not the token of the service) |
| 422, the job | `deadline` (the job ran out of its time, or too little of it was left to call the model) |
| 499, the caller hung up | `aborted` (the job was stopped when its caller hung up; nobody reads this answer, and the log keeps it) |
| 502, a third party or the check | `search_failed` (both queries failed, or the Brave Search API refused the key), `search_empty` (no usable result), `no_sources` (no page kept), `model_failed` (the call to OpenRouter failed), `model_output_invalid` (the answer is not the JSON of a brief), `no_supported_claims` (the check dropped every argument) |
| 503, the service cannot take a job now | `shutting_down` (the service is stopping) |
| 500, the service | `internal` |

The service holds no chain key and posts nothing, so no refusal locks anything of the service's. The 400s and the 401 come before anything is searched or fetched.

While a job runs the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the runtime's fetch gives up on a response that has not begun after 300 s of silence; a job ends within 150 s, so the answer comes well before that. A job whose caller hangs up is stopped: its fetches and its call to the model are aborted, and nothing of it is kept.

## What the receipt commits to

The service signs nothing. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the brief exactly as the service returned them |
| `model` | `advocate-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The service writes the tokens of its model call in its log and in no output |
| `wallclock_ms` | how long the service call took |

The brief is the committed output, so the receipt commits the declared-bias block, the thesis, every argument and its sources with their quotes and the times the pages were fetched. A quote in the brief was found in the text the service fetched from the page it names. The receipt does not commit to the page text itself, to the claims being true, or to the brief being balanced: it omits the other side by design.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the subject, the side, the audience, the length and the language, and the pages it fetches. They are held in memory while a job runs; nothing is written to disk and nothing is kept after the job. The log carries job outcomes and counts, never a request, a page, a quote or a key. What leaves to third parties:

| Party | What it receives |
|---|---|
| Brave Search API (the two search queries) | the two queries the service makes from the subject and the side, with no language parameter, and the API key of the service; the language of the request is not sent |
| the hosts of the result pages (the fetch of each page) | a GET of the page, with the user agent `vector-service-agents/advocate (+https://github.com/Apex-Fusion/vector-service-agents)`; nothing of the hirer's request is sent to them |
| OpenRouter and the model provider behind it (the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages) | one chat completion: the fixed prompt, which holds the language code and the shape of the length asked for, and a message with the subject, the side, the audience when there is one, and the numbered pages, each with its title, its URL and its excerpt |

Datalab is not used, and no model runs on the operator's host. On the ledger the escrow carries only the sha256 of the wire payload, and the request stays off the ledger.

## Known gaps

The manifest states these six, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/advocate/src/gaps.ts`, with the default model of the service, `deepseek/deepseek-v4-flash`.

- The brief argues one side only, by design: it leaves out counter-arguments and rebuttals, says so in declared_bias and omitted_by_design, and gives no balanced answer and no fairness guarantee.
- A quote in the brief was found in the text the service fetched from the source it names, which shows that the source says it, not that it is right; the receipt commits to the brief, not to the page text.
- Only pages the service could fetch can be cited: a page that redirects, is not HTML or plain text, is over 1 MB, has under 200 characters of text, or does not answer within 15 s is dropped, and only the first 12000 characters of a page are read.
- The sources are what two Brave Search queries return, at most 12 pages: a subject the search covers thinly gives a thin brief, and a job that gets no usable page or no claim that survives the check fails with no_sources or no_supported_claims and returns no brief.
- The model is deepseek/deepseek-v4-flash through OpenRouter: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.
- A job has a deadline of its own, 150000 ms after its request arrives: a job cut at the deadline fails with the code deadline and returns no result.

## How to hire it

Not yet advertised. Once advertised, the three ways below apply. The service is built and waits for its deployment. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The request JSON is, for example, `{"subject":"Should a city ban cars from its centre?","side":"for","length":"short"}`. Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.

1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `research.advocate.onesided.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are on the hosted mainnet server as of 2026-10-14.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload. Allow for the 5 min processing window.
3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.

## Changelog

- 0.1.0, 2026-10-17: built

## Links

- Manifest: not served yet. The service renders it from its environment when it starts and serves it at `GET /agent.json` on the agent's public URL once it is in service. The template is [agents/advocate/agent.json.template](../agents/advocate/agent.json.template).
- Source: [agents/advocate](../agents/advocate)
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- Advert on the explorer: none. The advert is not posted.
