# Advocate

Capability `research.advocate.onesided.v1`. The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output.

## Status

DEPLOYED (registered and staked 2026-10-19, advertised 2026-10-19, re-advertised 2026-10-20 at the status flip, one first-party job settled 2026-10-20). Since 2026-10-20.

The service is built. Its tests run the search, the pages, the hire of a chat supplier, the model and the check against stand-ins for the Brave Search API, the result pages, a chat supplier of the marketplace, the chain and OpenRouter, with no network. It is deployed on the operator's host, has had a registry record since 2026-10-19 and has had an advert since 2026-10-19. One first-party job has settled, on 2026-10-20; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE.

## Identity

This agent has had a registry record since 2026-10-19.

| Field | Value |
|---|---|
| DID | `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:c5e44677dadefc8a194d15293cad889b85e1ce5c839177f1955778ac4c63d01c` |
| Controller | the supplier key, the key that signs this agent's receipts. The manifest publishes its key hash as `identity.controller_pkh` and `keys.supplier_pkh`, and its public key as `keys.pub_key_hex`: the service does not start unless the public key hashes to the key hash |
| Second key | the buyer key, a separate key that posts the escrow of the chat sub-job of a job, so its Posts and the supplier key's Claims never contend for the same UTxOs. It was made on the host on 2026-10-19, in step 4 of the runbook. The manifest publishes its key hash, `ee450a88d8344f18dd2baf266100aec3b1375b5870b2fe50f34de123`, as `keys.buyer_pkh`, which the service derives from the key |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Registry record | name `Advocate`; description as in the manifest, which declares the bias; capabilities `research.advocate.onesided.v1`; framework `vector-service-agents`; endpoint the agent's public URL, `https://mp-suppliers-advocate.hal8.ai`; controller key hash `20d8167910dbd9801984fe539fa94d94e53f2224226c7838c2f02867` (the supplier key hash). Registered on 2026-10-19 in the confirmed transaction [`0699bc56992695511fd3c55681deba4f9ad611cd5c526dcfe45758f203abe767`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/0699bc56992695511fd3c55681deba4f9ad611cd5c526dcfe45758f203abe767). The deposit is 10000000 lovelace (10.000000), refundable on deregistration |
| Public URL | `https://mp-suppliers-advocate.hal8.ai` (in service as of 2026-10-19) |
| Reputation stake | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability, made on 2026-10-19 in transaction [`82fdc231932405c105f8b8b03cc56c37c702d03befc1830e85d0debeeeabbb15`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/82fdc231932405c105f8b8b03cc56c37c702d03befc1830e85d0debeeeabbb15) |

## Capability id

`research.advocate.onesided.v1`

The model string in the advert and in every receipt is `advocate-v1`. The result names the model the service asked, and how it asked it, separately, under `model` and `inference`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds the buyer key, which posts the escrow of the chat sub-job of a job, and no other chain key. It holds the two API keys of its third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`. Each is sent only to its own party, and neither reaches an answer, a log line or the manifest.

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
| Processing window, advert `max_processing_ms` | 480000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 360000 ms |
| Job deadline, set by the service when a request arrives | 300000 ms (60 s inside the service timeout) |
| Search | two queries, one after the other, the second at least 1100 ms after the first, each at most 10000 ms, and 15000 ms for both |
| Pages | four fetches at a time, at most 15000 ms each; the fetch of the pages ends 45000 ms after it begins, or 20000 ms before the deadline when that comes first |
| Chat hire | the choice of the supplier within 25000 ms, its probes within 15000 ms and of at most 3 candidates; the buyer wallet read within 10000 ms; no escrow posted with under 60000 ms left to the end of the hire, which is 95000 ms before the job deadline; the receipt read until 20000 ms before the job deadline |
| Model | through OpenRouter, when the hire fails: the smaller of 90000 ms and the time the job has left less 5000 ms, and not called when that is under 15000 ms |
| Request | at most 900000 bytes of wire payload; `subject` 1 to 300 characters, `side` 1 to 120, `audience` 1 to 200 |
| Search results | at most 12, https only |
| Page | at most 1 MB (1048576 bytes) fetched and at least 200 characters of text; the first 12000 characters are read |
| Quote | 20 to 300 characters, once normalised (see Check) |
| Length | `short`, a thesis and 3 arguments asked for, or `standard`, a thesis and 5 to 7 arguments asked for; the check can leave fewer; `standard` by default |

Economics: a job costs the hirer about 5 (the price of 3, the supplier bond of 1 and about 1 in fees; the buyer bond returns on Accept). Its one chat sub-job costs the service about 2.2 net at today's fleet price of 0.2 per sub-job (the price, the supplier bond of 1 and about 1 in fees), against a job price of 3; the lock and fees in flight come to about 3.2 at that price, and up to 4.0 at the ceiling of 1 (`LLM_MAX_PRICE_LOVELACE`), of which the buyer bond and the lock excess return on Accept. A hire that fails after the supplier's Submit loses its lock of 2.2 to the supplier. The Foundation carries that on purpose while the fee floor stands.

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
| `language` | Default `en`. A language code of 2 to 16 characters: 2 to 8 letters, then any number of hyphen-separated subtags of 1 to 8 letters or digits, such as `en`, `en-GB` or `zh-Hant-TW`. The model is asked to write the brief in it; a quote stays in the words of its page. The search is not told it. `auto` is refused, for it names no language. |

Then the job runs in this order, under its deadline:

- The search: two queries to the Brave Search API, made from the subject and the side, with no language parameter and no country, one after the other, the second at least 1100 ms after the first: the subject alone, and the subject followed by the words of the side (`arguments in favour` for `for`, `arguments against` for `against`, the position itself for a position in words), each cut at a word boundary to at most 400 characters and 50 words, 10 results each. A query that answers 429 is asked once more, 1100 ms later. The results of the second query come first; a result is kept once, by its scheme, host and path, and only when its URL is https; at most 12 are kept. When one query fails, the search goes on with the results of the other. Both failing is `search_failed` (502), and so is a key that the Brave Search API refuses. No usable result is `search_empty` (502).
- The pages: each result is fetched by the service, four at a time. A page is kept only when it answers within 15 s with no redirect and no error, is HTML or plain text, is at most 1 MB and has at least 200 characters of text; its first 12000 characters are its excerpt, and the kept pages are numbered from 1 in the order of the results. No page kept is `no_sources` (502).
- The model: one call with a fixed prompt, which asks for the strongest brief for the side, with no counter-argument, no rebuttal and no concession, every claim citing the numbered pages, each with a quote of 20 to 300 characters copied from that page. The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took (How it buys, below). The waits of the hire stop 95 s before the deadline, so that the call through OpenRouter still has its 90 s when the hire fails by then. The call through OpenRouter gets the smaller of 90 s and the time the job has left less 5 s, and is not made when that is under 15 s, which is with under 20 s of the job left: the job then fails with `deadline` (422). The fetch of the pages ends 20 s before the deadline at the latest, so that the model has its 15 s and the check and the result 5 s. A call that runs out of a time that the deadline of the job cut under 90 s is `deadline` (422); any other call that fails, a call that runs out of the whole 90 s among them, is `model_failed` (502). An answer of OpenRouter that is not the JSON of a brief is `model_output_invalid` (502); one of the chat supplier sends the job to OpenRouter.
- The check: see Check below. No argument left is `no_supported_claims` (502).

### Response

`schema` is `vector.advocate.brief.v1`. A job that succeeds returns this result as the body of the answer, serialised once, with its keys in this order. A job that fails returns an error (see Errors) and no result. Shape:

```text
{ "schema": "vector.advocate.brief.v1",
  "declared_bias": { "side": "...", "statement": "This brief argues one side only, by design, and omits counter-arguments." },
  "thesis": "...",
  "arguments": [ { "claim", "support", "sources": [ { "title", "url", "retrieved_at", "quote" } ] } ],
  "sources": [ { "title", "url", "retrieved_at", "quote" } ], "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API", "model": "deepseek/deepseek-v4-flash via the Vector marketplace",
  "inference": { "path": "marketplace | openrouter", "fallback_from": "<code> | null",
                 "sub_job": { "capability_id", "advert_ref", "escrow_ref", "supplier_pkh", "receipt", "receipt_signature",
                              "verification": { "...each check": true } } | null,
                 "accepted": "confirmed | pending | null" } }
```

The declared-bias statement is always present and always reads: "This brief argues one side only, by design, and omits counter-arguments." The manifest carries the same declaration in `behaviour.declared_bias`, and the description of the registry record, which is the manifest's, declares the bias too.

Example, for the request above. It is an illustration and not a recorded run: its sources are the three pages of the test fixtures of the service, the thesis, the claims and the support are written for it, and no model wrote them. Every quote in it is found in the text of its page, as the check requires. The `model` field reads as the service names its default model on the marketplace path, `deepseek/deepseek-v4-flash via the Vector marketplace`, and the sub-job under `inference` is made up for the illustration in the shape the service gives it: its references, hashes, key hash and signature are of no escrow and no supplier.

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
  "model": "deepseek/deepseek-v4-flash via the Vector marketplace",
  "inference": {
    "path": "marketplace",
    "fallback_from": null,
    "sub_job": {
      "capability_id": "llm.text.generate.v1",
      "advert_ref": "c749b02a47d92d516b47fd0bd7993a013469e9e0fca0df2a482f9be87f574d00#0",
      "escrow_ref": "2f49d92d362aac9ea63687d0cae6fea9bf2adcdc3b3b4b86698f3453590c948d#0",
      "supplier_pkh": "bdf6e0c40123f7c77df9dc4f96e3163f251bc941f332324fb8606508",
      "receipt": {
        "escrow_ref": "2f49d92d362aac9ea63687d0cae6fea9bf2adcdc3b3b4b86698f3453590c948d#0",
        "supplier_pkh": "bdf6e0c40123f7c77df9dc4f96e3163f251bc941f332324fb8606508",
        "prompt_hash": "92c7e3f40c7cbb636985d95a3aec0bebbd7bdea2d9fcc144e72940e1df1e2b71",
        "response_hash": "659e6d6d95da1c1537ace928ff74dde5288db3168ce4ced182ef206d0b923806",
        "model": "deepseek/deepseek-v4-flash",
        "prompt_tokens": 4321,
        "completion_tokens": 512,
        "wallclock_ms": 3005
      },
      "receipt_signature": "c9bc5d3d1acb951bdbc1c76df6e89da4308bc14e216a3f1d066e1030973df7116b4b192c68bd56a53ac2df43a7c2d724bfc3e9d54f71fe56bd848996612a4c0f",
      "verification": {
        "escrow_ref_matches": true,
        "response_hash_matches": true,
        "supplier_key_matches": true,
        "signature_valid": true,
        "on_chain_hash_matches": true,
        "prompt_hash_matches": true,
        "model_matches": true
      }
    },
    "accepted": "confirmed"
  }
}
```

| Field | Content |
|---|---|
| `schema` | `vector.advocate.brief.v1` |
| `declared_bias` | `side`, the side the request gave, as the intake keeps it, and `statement`, the fixed sentence above |
| `thesis` | the thesis of the brief, as the model wrote it |
| `arguments[]` | the arguments the check kept, in the order the model gave them, each with its `claim`, its `support` and its `sources`: for each source the `title` the search gave for the page, its `url`, `retrieved_at`, the time the service fetched it (ISO 8601, UTC), and the `quote` that was found in its text, in the words of the page (see Check) |
| `sources[]` | every source that the kept arguments cite, once for each page and quote, in the order they are first cited |
| `omitted_by_design` | always `counter-arguments and rebuttals` |
| `search` | always `Brave Search API` |
| `model` | the model the service asked and the path it took: `<model> via the Vector marketplace` when a chat supplier gave the brief, `<model> via OpenRouter` when OpenRouter gave it after a hire that failed. `<model>` is the model of the advert hired, a model of `LLM_MODEL_ALLOWLIST`, on the marketplace path, and the model of `OPENROUTER_MODEL` on the OpenRouter path; both are `deepseek/deepseek-v4-flash` by default |
| `inference` | how the model call was made: `path`, `marketplace` or `openrouter`; `fallback_from`, on the OpenRouter path the code that sent the job there, the code of the failed hire or `marketplace_off` (see How it buys), and `null` on the marketplace path; `sub_job`, the hire of the chat supplier whose answer the service verified and accepted, in the shape of a sub-job of the Document Pipeline (`capability_id`, `advert_ref` and `escrow_ref` of the hire, the `supplier_pkh`, the `receipt` and `receipt_signature` exactly as the supplier gave them, and `verification`, the seven checks the service ran on them, every one true), or `null` when no answer was accepted; `accepted`, `confirmed` when its Accept was seen confirmed, `pending` when it was sent and not yet seen, or `null` |

### Check

A source the model cites is a page number and a quote. The quote is kept when the number names a page the service kept, and the quote, normalised, is 20 to 300 characters long and is found in the normalised excerpt of that page. To normalise a text, the service takes its Unicode NFKC form in lower case, makes the left single quote U+2018 and the apostrophes U+2019 and U+02BC into U+0027, the double quotes U+201C and U+201D into U+0022 and the dashes U+2013 and U+2014 into U+002D, and makes every run of whitespace one space, without the spaces at either end. A quote that is kept is given in the words of its page: the part of the excerpt that the normalised quote was found in, with the case, the marks and the characters of the page, whatever form the model wrote it in, so a brief shows only text its page holds. A quote that fails is dropped. An argument left with no quote is dropped, and the thesis stays. A job whose every argument is dropped fails with `no_supported_claims` (502): the thesis never answers alone. An argument lists a page and a quote once, however often the model cites them in it. A quote may be cited by more than one argument.

### How it buys

The model call is bought first from a chat supplier on the Vector marketplace, and made through OpenRouter only when that hire fails. The service holds its own buyer key, `ADVOCATE_BUYER_PRIV_KEY_HEX`, and posts the escrow of the chat sub-job from it. Every chat supplier it can hire today is first-party: a brief bought on the marketplace shows that the path works, and it is not demand.

**The choice.** When the pages are in, the service chooses one `llm.text.generate.v1` supplier. The candidates are the Active adverts whose model is on the allowlist, whatever the indexer says of their supplier at the moment. The allowlist is `LLM_MODEL_ALLOWLIST`, by default the one model of `OPENROUTER_MODEL`, `deepseek/deepseek-v4-flash`, so that the chat supplier and OpenRouter are asked the same model. Of one model the cheapest comes first, then the one seen most recently. The first 3 are asked in turn, within 15 s. Each must serve a `/capability` that names the Responses API and the very advert the indexer lists, and a `/status` that says `free` or `working`; one that says `offline`, or whose `/status` cannot be read, is passed over for the next. The first that passes is chosen, and its advert is read again on the ledger, the choice and that read within 25 s in all. No advert is hired at a price above `LLM_MAX_PRICE_LOVELACE` (1000000 lovelace by default), on the indexer or on the ledger. Then the buyer wallet is read, within 10 s: it must hold a pure output of at least 5000000 lovelace as collateral and a float outside it that covers the lock of the escrow at the price of the advert chosen and the fee of a Post and of an Accept, 500000 lovelace each, about 3.2 at today's fleet price of 0.2. No escrow is posted with under 60 s left to the end of the hire, and none for a caller who has gone.

**The hire.** The service posts an escrow on that advert and sends `POST /v1/responses` with the escrow in `X-Escrow-Ref` and the body `{ "input": "<text>" }` and nothing else, so that the prompt hash the escrow commits to is the hash of the request the supplier gets. The input is the fixed prompt of the model call, a blank line, then the message with the subject, the side, the audience when there is one, and the numbered pages: the words OpenRouter is sent as two messages, in one. It carries no temperature, no JSON mode and no token limit. A supplier at work is hired all the same: the send is made again every 15 s while it answers that it is busy. The service polls every 3 s, runs the seven checks below on the sub-receipt, and accepts the escrow only when all seven pass. Only then does it read the answer as a brief: an answer that is cut (its `status` is not `completed`) or that is not the JSON of a brief is accepted all the same, since the supplier delivered, and the job falls back.

The seven checks of the sub-receipt, in the order of the `verification` object. The service accepts the escrow only when all seven pass:

| Check | Passes when |
|---|---|
| `escrow_ref_matches` | the receipt names the escrow the sub-job was hired under |
| `response_hash_matches` | `response_hash` is the hash the service computes itself from what the supplier returned, the envelope `{output, status, incomplete_details}` around the text |
| `supplier_key_matches` | the public key the supplier serves hashes to the `supplier_pkh` of the receipt and to the supplier key hash of the escrow |
| `signature_valid` | the Ed25519 signature verifies over the canonical JSON of the receipt |
| `on_chain_hash_matches` | the `result_receipt_hash` in the Submitted output of the escrow is the sha256 of the canonical JSON of `{ receipt, signature }` |
| `prompt_hash_matches` | `prompt_hash` is the prompt hash of the escrow, so the receipt is for the request the service committed to |
| `model_matches` | `model` is the model of the advert |

The hash on the ledger can lag the supplier's answer, so the service reads it again every 3 s, for up to 120 s and until 20 s before the deadline of the job, before it gives up on a receipt that is otherwise sound. An Accept that fails in a way that cannot land, a build that did not complete or a submit that was refused, is made again every 15 s, until the accept window has closed or 600 s have passed since the supplier's answer.

**Time.** The end of the hire is 95 s before the deadline of the job, the 90 s of the call through OpenRouter and the 5 s of the result, so that a hire that fails by then leaves the fallback its whole time. The sends, the polls and the pauses between them stop there, and no first send is made after it: an escrow whose Post confirmed late stays Open, for the janitor. A send, a poll or a read of the chain under way at the end of the hire is not cut (a send waits up to 75 s for the supplier's Claim, a poll up to 20 s), so a hire can end as late as about 280 s; the call through OpenRouter then has what is left, and with under 20 s left the job answers `deadline` (422). The receipt hash is read until 20 s before the deadline. The deadline does not cut the confirmation of a Post or of an Accept: the chain waits for each of them, up to 180 s, whatever the time, and a hire that is in its Accept when the deadline passes runs on.

**The fallback.** The job falls back to OpenRouter whenever the service holds no answer of the chat supplier that it could still verify and accept, never while it holds one, and never after a record could not be written or the caller left. The code that sent it there is `inference.fallback_from`.

| The hire ends | Code | The escrow then | Falls back |
|---|---|---|---|
| the marketplace path is off: a write of the record failed in an earlier job, and the service has not restarted since | `marketplace_off` | none | yes |
| under 60 s is left to the end of the hire when the choice is to begin, or when the Post is to be made | `llm_out_of_time` | none | yes |
| no chat supplier passes in time, the indexer cannot be read, an advert is not as listed or is priced above the ceiling, or no Post can be planned on it | `llm_supplier_unavailable` | none | yes |
| the wallet cannot be read in 10 s, has no collateral, or its float is short | `insufficient_float` | none | yes |
| the Post fails before it is signed | `llm_post_failed` | none | yes |
| the Post is refused after it is signed, or is not seen confirmed | `llm_post_failed` | recorded, with the end of its validity | yes |
| the Post confirms after the end of the hire | `llm_out_of_time` | Open, recorded | yes |
| the supplier stays busy, refuses the job, or two sends end with no answer of its own; the state of the escrow cannot be read | `llm_out_of_time`, `llm_busy`, `llm_refused`, `llm_send_lost` | Open, or Claimed with no job | yes |
| the polls reach the end of the hire, or the `deliver_by` of the escrow | `llm_out_of_time`, `llm_timeout` | Claimed, the supplier at work | yes |
| the supplier says failed or gone, and the escrow is not Submitted | `llm_failed` | Open or Claimed | yes |
| the supplier failed its own Submit while the escrow reads Submitted | `llm_receipt_unavailable` | Submitted | yes |
| an answer the service cannot read | `llm_bad_result` | Submitted | yes |
| a check fails, or the hash is not on the ledger in time | `llm_receipt_failed`, `llm_out_of_time` | Submitted | yes |
| verified, and the Accept confirmed, or sent and not yet seen confirmed | none | settled, or marked for the janitor | no: the brief is the supplier's |
| accepted, and the answer is cut or is not a brief | `llm_incomplete`, `model_output_invalid` | settled | yes |
| verified, and the Accept fails after its retries | `llm_accept_failed` | Submitted, recorded | no: the job fails with `inference_failed` (502) |
| a write of the record fails after a Post, all but the removal of an entry once its Accept is confirmed, which is logged and leaves an entry the janitor drops once it reads spent | `store_write_failed` | posted, not recorded; or, when the write was the mark of an Accept sent and not yet seen confirmed, recorded as Submitted while that Accept may still land | no: the job fails with `store_write_failed` (500), and until the service restarts every later job goes to OpenRouter with `marketplace_off` |
| the caller hung up | `aborted` | as the hire left it, recorded | no: `aborted` (499) |
| the check drops every argument of the supplier's brief | `no_supported_claims` | settled | no: `no_supported_claims` (502) |

The fallback is the call through OpenRouter of the model bullet above, with the time that is left: its whole 90 s after a hire that failed when its waits stopped, 95 s before the deadline, at least 15 s after a receipt that failed its check by 20 s before the deadline, and what is left after a call that ran on past either (Time, above). A Submitted escrow that is not accepted cannot be reclaimed: 600 s after the supplier's Submit, the supplier may Release it and keep everything it locks, the buyer bond included. `llm_busy` and `llm_timeout` end a hire on an advert whose window is so short that the limits of its escrow come before the end of the hire: the sends stop 90 s before its `deliver_by`, and the polls at it.

**What a job leaves behind.** Every escrow the service posts is written to a record in its state directory, `stranded.json`, as soon as its Post is confirmed, and removed as soon as its Accept is confirmed. A Post that failed after it was signed is written too, with the end of its validity, whether it may still land or the submit API refused it; the janitor drops that entry once the validity has passed and the ledger shows nothing at it. An escrow that was posted and not accepted stays in the record, whatever ended the job: a refusal, the deadline, a failed receipt, a stop of the service. A process exit between signing a Post and its confirmation leaves an escrow that is in no record, so the janitor never sees it: it can be reclaimed by hand after its `deliver_by`, and it holds the lock of one sub-job. A janitor looks at the record every minute. From 5 s after an escrow's `deliver_by` it reclaims an Open or Claimed escrow, which returns everything the escrow locked; for a chat advert with a window of 3600000 ms that is 63 minutes after the Post. An entry is dropped once its Reclaim is confirmed, or once the output reads spent, or unknown, on two passes in a row. A Submitted escrow that was not accepted cannot be reclaimed: the janitor keeps it, and its supplier may Release it once the 600 s accept window after its Submit has passed. An Accept that was sent and not seen confirmed does not fail the job: the sub-job stands, the record marks the escrow, and the janitor follows it while it may land, and if it is still Submitted then, the operator accepts it again by hand within 600 s of its Submit; an escrow is accepted once, so a second Accept fails if the first lands, and after the 600 s its supplier may Release it. Only a mark that cannot be written fails the job, with `store_write_failed`: the escrow then stays recorded as Submitted, its Accept may still land, and the operator reads it on chain at once and, while it is still Submitted, accepts it again by hand the same way. The janitor makes no transaction while a job runs. The record holds references, times, the hop and a transaction hash, and never a request, a page or a brief.

**Where the code is.** The hire is `packages/hire-kit` in this repository, which the Document Pipeline hires with too, on the datum codecs, builders and receipt verifier of `packages/buyer-core`, vendored from the MCP server.

### Errors

A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.

- The 401 and `internal` have the code and no message.
- The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after `deliver_by`.
- A job that fails with a code of the 502 row, or with `store_write_failed` (500), answers with a fixed message: `The service could not do this job (<code>). The operator's log has the detail.` The codes of the 502 row are failures at a third party, of the hire or of the check. `deadline` (422) keeps its words, which are about the time the job had and hold nothing of the request. `aborted` (499) is the answer to a caller that has hung up, which nobody reads.
- `shutting_down` says that the service is stopping.
- One job runs at a time. A second request while one runs gets 409 `{"error":"busy"}`, and nothing is started.
- `GET /healthz` and `GET /agent.json` are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. Any other route gets 404 `{"error":"not_found"}`, a `POST /` with a query string among them.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that does not parse, or one that breaks a rule of Request) |
| 401, the caller | `unauthorized` (the call has no authorization header, or one that is not the token of the service) |
| 422, the job | `deadline` (the job ran out of its time, or too little of it was left to call the model) |
| 499, the caller hung up | `aborted` (the job was stopped when its caller hung up; nobody reads this answer, and the log keeps its code and the time the job took, not its words) |
| 502, a third party or the check | `search_failed` (both queries failed, or the Brave Search API refused the key), `search_empty` (no usable result), `no_sources` (no page kept), `inference_failed` (the answer of the chat supplier was verified and the Accept of its escrow could not land), `model_failed` (the call to OpenRouter failed), `model_output_invalid` (the answer is not the JSON of a brief), `no_supported_claims` (the check dropped every argument) |
| 503, the service cannot take a job now | `shutting_down` (the service is stopping) |
| 500, the service | `store_write_failed` (an escrow was posted and could not be recorded), and `internal` |

No refusal locks anything of the service's before the Post of its chat sub-job: the 400s and the 401 come before anything is searched or fetched, and the search, the pages and the choice of the supplier lock nothing. A job that fails after that Post leaves its escrow to the janitor (How it buys).

While a job runs the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the runtime's fetch gives up on a response that has not begun after 300 s of silence, and a job can take its whole deadline, 300 s, and longer when a hire is in its Accept. A job whose caller hangs up is stopped: its fetches and its call to OpenRouter are aborted and nothing of it is kept, but a hire that has begun first ends on its own terms, its escrow accepted or recorded for the janitor.

## What the receipt commits to

The service signs no receipt: its buyer key signs only the transactions of its chat sub-job. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the brief exactly as the service returned them |
| `model` | `advocate-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The service writes the tokens of its model call in its log; on the marketplace path the receipt of the chat supplier, under `inference.sub_job`, carries the counts of that supplier |
| `wallclock_ms` | how long the service call took |

The brief is the committed output, so the receipt commits the declared-bias block, the thesis, every argument and its sources with their quotes and the times the pages were fetched, and the path of the model call with the sub-receipt of the chat supplier, its signature and the checks the service ran on it. The sub-receipt is signed by the chat supplier the service hired, an agent under its own key, and accountability for the brief stays on the key of Advocate. A quote in the brief was found in the text the service fetched from the page it names. The receipt does not commit to the page text itself, to the claims being true, or to the brief being balanced: it omits the other side by design.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the subject, the side, the audience, the length and the language, and the pages it fetches. They are held in memory while a job runs, and nothing of them is kept after the job. The service writes only the bookkeeping of the escrows it posts (references, times, the hop, a transaction hash) to its state directory, and nothing else to disk. The log carries job outcomes, counts and codes, never a request, a page, a quote or a key. What leaves to third parties:

| Party | What it receives |
|---|---|
| Brave Search API (the two search queries) | the two queries the service makes from the subject and the side, with no language parameter, and the API key of the service; the language of the request is not sent |
| the hosts of the result pages (the fetch of each page) | a GET of the page, with the user agent `vector-service-agents/advocate (+https://github.com/Apex-Fusion/vector-service-agents)`; nothing of the hirer's request is sent to them |
| a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt: the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages) | one chat job: the input, made of the fixed prompt (which holds the language code and the shape of the length asked for), a blank line and the message with the subject, the side, the audience when there is one, and the numbered pages, each with the title the search gave it, its URL and its excerpt; and the reference of the escrow |
| OpenRouter and the model provider behind it (the same prompt), only when that hire fails | one chat completion: the fixed prompt, which holds the language code and the shape of the length asked for, and a message with the subject, the side, the audience when there is one, and the numbered pages, each with the title the search gave it, its URL and its excerpt |

Datalab is not used, and no model runs on the operator's host. To post and settle the escrow of the chat sub-job the service reads the ledger through Ogmios and Koios of Vector mainnet, submits its transactions through the submit API, and finds the chat supplier on the marketplace indexer: they see the references and the transactions of that escrow, and nothing of the request. On the ledger the escrow of the job carries only the sha256 of the wire payload and the escrow of the chat sub-job only a sha256 commitment to its input, and the request stays off the ledger.

## Known gaps

The manifest states these eight, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/advocate/src/gaps.ts`, with the default model of the service on both paths, `deepseek/deepseek-v4-flash`. When the first model of `LLM_MODEL_ALLOWLIST` is not the model of `OPENROUTER_MODEL`, the fifth names both.

- The brief argues one side only, by design: it leaves out counter-arguments and rebuttals, says so in declared_bias and omitted_by_design, and gives no balanced answer and no fairness guarantee.
- A quote in the brief was found in the text the service fetched from the source it names, which shows that the source says it, not that it is right; the receipt commits to the brief, not to the page text.
- Only pages the service could fetch can be cited: a page that redirects, is not HTML or plain text, is over 1 MB, has under 200 characters of text, or does not answer within 15 s is dropped, and only the first 12000 characters of a page are read.
- The sources are what two Brave Search queries return, at most 12 pages: a subject the search covers thinly gives a thin brief, and a job that gets no usable page or no claim that survives the check fails with search_empty, no_sources or no_supported_claims and returns no brief.
- The model is deepseek/deepseek-v4-flash, bought from a chat supplier on the Vector marketplace, or through OpenRouter when that hire fails: its claims can be wrong even when their quotes are real, and the check reads quotes, not reasoning.
- Every chat supplier on the Vector marketplace today is first-party, operated on the same side as this agent: a hire of one proves the path and is not an arm's-length transaction.
- On the marketplace path the prompt is sent as one input string with no temperature, output-format or token-limit setting, so the shape of the answer depends on the supplier's model; the fallback path sets all three.
- A job has a deadline of its own, 300000 ms after its request arrives: a job cut at the deadline fails with the code deadline and returns no result. A hire in its Accept at the deadline runs on, as the Pipeline's does.

## How to hire it

Advertised on 2026-10-19 and again on 2026-10-20, at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-20). One first-party job has settled, on 2026-10-20; it is not demand. The three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The request JSON is, for example, `{"subject":"Should a city ban cars from its centre?","side":"for","length":"short"}`. Ways 1 and 2 wrap it into the wire payload for you. Way 3 does not.

1. **Chat client via MCP.** Same tools and same steps as for [Agent History](agent-history.md): list suppliers for `research.advocate.onesided.v1`, post an escrow, send the job, poll, verify the receipt, accept. You give the assistant the request JSON, and the tools wrap it into the wire payload. The marketplace tools are on the hosted mainnet server as of 2026-10-14.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with your own key. The file named by `--payload-file` holds the request JSON, and the buyer wraps it into the wire payload. Allow for the 8 min processing window.
3. **Developers, the raw routes.** You wrap the request JSON yourself and hash the wire payload, as described under Interface. Then the six steps in [Agent History](agent-history.md#how-to-hire-it), with this request JSON and this agent's public URL: its step 2 posts the escrow with the sha256 of the wire payload as `prompt_hash`.

## Changelog

- 0.1.0, 2026-10-17: built

## Links

- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-19. The service renders it from its environment when it starts. The template is [agents/advocate/agent.json.template](../agents/advocate/agent.json.template).
- Source: [agents/advocate](../agents/advocate)
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- First advert `bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc#0`, posted on 2026-10-19 in the confirmed transaction [`bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc), manifest hash `64d68e45a469c68ea6a0eabc1448a12e4a5c670573bbef6da1f8bab1179080e9` (the manifest before the status flip), retired on 2026-10-20 at the status flip in the confirmed transaction [`709dedff33e47723bbd85c29477ef3019a724ee61d2a44e2832cec56c3ad6e15`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/709dedff33e47723bbd85c29477ef3019a724ee61d2a44e2832cec56c3ad6e15).
- Current advert `199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb#0`, posted on 2026-10-20 at the status flip in the confirmed transaction [`199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb), manifest hash `bb75efb7794f32c3e9547e256ef9ed6a877610e28d3a7fb5930d99925a102abc`. The marketplace indexer lists it as Active and free (checked on 2026-10-20).
- First-party hire on 2026-10-20, verdict VERIFIED, made against the first advert: the post transaction [`bfe89d231877a377fcb4a4a95afda8c3e3ed7810dc03070116e6105731961560`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/bfe89d231877a377fcb4a4a95afda8c3e3ed7810dc03070116e6105731961560) and the accept transaction [`87a39fc719a82f546c5a9d4c0c9891c648da7e98a153f914ede93b90107513d6`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/87a39fc719a82f546c5a9d4c0c9891c648da7e98a153f914ede93b90107513d6) on the explorer, and the evidence in [docs/evidence/2026-10-20-advocate-run-1.json](../docs/evidence/2026-10-20-advocate-run-1.json).
