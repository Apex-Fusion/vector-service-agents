# Bid Desk

For a supplier: takes a request for quotation from a buyer's agent, checks who sent it, prices it from the supplier's published price list and returns a quote. The signed receipt of the job is the signed quote. Capability `supplychain.rfq.quote.v1`.

## What it is

The Bid Desk is the supplier side of use case 3 (supplier bid evaluation). The buyer side is the Sourcing Agent. It sends a request for quotation, and the Bid Desk answers with a quote.

One image serves three Bid Desks: `alfa`, `bravo` and `charlie`. They are one code base under three records of one operator, and they do not compete. `BID_DESK_INSTANCE` selects the price list file and the name of the desk. Each Bid Desk sits behind its own template runtime. The runtime holds the supplier key of the desk and has its own advert. It claims the escrow of a buyer, posts the job to this service as the body of `POST /`, and signs the one receipt that the answer gives.

Before a runtime claims an escrow, it asks this service. The question is `POST /precheck`, and this page calls it the hook. The hook makes 7 checks, one after the other: the sender, the delegation, the payment from a vault, and the request identifier. The first check that fails refuses the job with its code. The escrow stays open, nothing is claimed, and nothing is paid. When every check passes, the hook keeps the record of the checks for 300 s and reserves the job slot for that escrow for 120 s.

After the Claim, the runtime posts the job. The job takes the record of the hook by its escrow reference, and compares the hash of its own body with the hash that the hook checked. It asks one model to price the request from the price list. The service hires that model on the Vector marketplace through a bonded escrow that it posts with its service key. The job checks each line of the answer against the request, makes the line totals, the total and the longest lead time, and reads the book of answered requests again. It gets the credential of the desk from the identity gateway, records the request in the book and answers with the quote. A job with no record of passed checks for its own body fails closed: it makes no quote.

The desk prices from its price list file only. The only price data that the service gives the model is the entries of that file for the SKUs of the request. The service does not check the unit prices of the model against the list. A buyer's agent can, because the list and its hash are public. The fault switch makes the desk quote below its own list on purpose: see The fault switch.

The Bid Desk takes no approval and calls no mock system. It files no claim and no challenge: it has no dispute code and no dispute setting. The claim of the desk is the three statements in `behaviour.claim` of its manifest. An operator command stakes that claim, and this service never does.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its settings when it starts, and serves those bytes at `GET /agent.json`. It never serves the template itself. Each instance has its own manifest and its own advert, so the three manifests have three hashes. Change the template by changing `manifestFromEnv`, and write it again with `pnpm --filter @vsa/bid-desk template`.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs: it has no check of its own beyond answering |
| `GET /agent.json` | the manifest, the bytes that `JSON.stringify` gives |
| `GET /price-list.json` | the price list file of the instance, the exact bytes that the manifest hashes, with the header `content-type: application/json`. It takes no job slot |
| `POST /precheck` | the hook: the token, the body of a job and the six context headers. A go is 200 `{"go":true,"reserved_ms":120000}`. A refusal is `{"error":"<code>","message":"<words>"}` with its status |
| `POST /` | the job: the wire message and the six context headers, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| any other route | 404 `{"error":"not_found"}` |

`GET /healthz`, `GET /agent.json` and `GET /price-list.json` need no token. They are matched on their path, whatever the query string, and a `HEAD` of any of them gets the headers of the `GET` and no body. `POST /price-list.json` is a 404.

The body of `POST /` and of `POST /precheck` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`. It is read up to 1000000 bytes. The request JSON is the request for quotation of use case 3: see The request.

The runtime sends six headers of the context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. The hook needs all six. The job needs them too: a call with none, with some, or with a bad one gets 400 `bad_context`. The buyer key comes from `x-vector-buyer-pkh`, which the runtime read from the escrow. It never comes from the body.

`POST /` and `POST /precheck` require the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`, the value that the runtime sends with every call. A call without it, or with another value, gets 401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is taken. The values are compared in constant time, and a refusal is logged once a minute at most, with a count and nothing that the caller sent. The other routes need no header: the health check of the image sends none, and the manifest and the price list are public.

One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go of the hook for the escrow that holds the reservation reserves the slot again; a refusal of the hook reserves nothing. A go of the hook reserves the slot for its escrow for 120000 ms, and the job for that escrow takes the reservation.

A job whose caller hangs up is stopped at two points: before the service hires the model, and before the book records the quote. It ends with `deadline`, and it records nothing. A hire that has started is not stopped. A hang-up after the record does not stop the job: the quote is booked, the job gives it, and its log says that the caller hung up.

While a job runs, the server writes an interim `102 Processing` line every 60 s to a client that speaks HTTP/1.1, ahead of the answer. The reason is that the runtime's fetch gives up after 300 s of silence. The lines stop when the job ends.

## The three instances

One image serves the three Bid Desks, and `BID_DESK_INSTANCE` selects the price list file and the name of the desk. The container port is 9106 in all three: the image sets `PORT` to 9106 and its health check reads that port, so a deployment changes only the side of the host in the mapping.

| Instance | Name | Organisation | Price list file |
|---|---|---|---|
| `alfa` | Bid Desk Alfa | `alfa.<domain>` | `price-lists/alfa.json` |
| `bravo` | Bid Desk Bravo | `bravo.<domain>` | `price-lists/bravo.json` |
| `charlie` | Bid Desk Charlie | `charlie.<domain>` | `price-lists/charlie.json` |

The organisation of a desk is the domain that `BID_DESK_ORGANISATION` gives, and each quote holds it. The three deployments name it `<instance>.<domain>`, where `<domain>` is the domain of the operator. The service takes the value as it is. It checks the form of a domain name (lower case, at least two labels, at most 64 characters) and not the first label.

Each file lists the same three SKUs (`GLV-NIT-M`, `SYR-10ML` and `MSK-N95`) with a lead time and a unit price from the quantities 1, 100 and 500. The three files hold different numbers, and the numbers are synthetic. The service serves the file of its instance at `GET /price-list.json`. Its manifest holds the address of the file, `<BID_DESK_PUBLIC_ORIGIN>/price-list.json`, and the SHA-256 of its bytes. So the three manifests differ in the name and in the price list, and in the settings that each deployment gives. A change to a price list file changes the manifest of its instance, and so the hash that its advert holds.

The three share the terms of their adverts: price 1000000 lovelace, supplier bond 1000000 and buyer bond 1000000. The buyer locks 3000000.

## The request

The request JSON is one object with exactly four members: `schema`, `sender_did`, `delegation` and `rfq`. The `rfq` object has exactly three members: `rfq_id`, `items` and `needed_by`.

```json
{ "schema": "vector.usecase.rfq.v1", "sender_did": "did:vector:...", "delegation": "...", "rfq": { "rfq_id": "rfq-1", "items": [ { "sku": "GLV-NIT-M", "quantity": 100 } ], "needed_by": "2026-12-20" } }
```

| Member | Rule |
|---|---|
| `schema` | the text `vector.usecase.rfq.v1` |
| `sender_did` | the DID of the buyer's agent: `did:vector:` and 64 lowercase hex characters |
| `delegation` | the identifier of the delegation that names the sender as its delegate and paid for the job: 64 lowercase hex characters |
| `rfq_id` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. The service counts it as written, so `RFQ-7` and `rfq-7` are two requests |
| `items` | 1 to 20 items, each with a `sku` and a `quantity`, and each SKU once |
| `sku` | the same form as `rfq_id` |
| `quantity` | a whole number from 1 to 1000000 |
| `needed_by` | a date as `YYYY-MM-DD` that exists, in the year 0100 or later |

A request that breaks a rule is `bad_shape` (400) on both routes. The service reads each text as it was written: an identifier or a SKU that is valid only after Unicode normalisation, such as the Kelvin sign in place of the letter K, is `bad_shape`. The hook does not check the SKUs against the price list. The manifest asks a sender to keep the wire payload at or below 900000 bytes (`terms.input_limits.request_bytes`).

## The result

A job that does its work answers 200 with the quote, and the signed receipt of the job is the signed quote. The model chooses the lines (the SKU, the quantity, the unit price and the lead time of each), the last day on which the quote holds, and one note. The job checks that each line is an item of the request with its SKU and its quantity, that each SKU is there once, and that there is at least one line. It never adds, removes or changes a line, except with the fault switch on. It makes the line totals, the total and the longest lead time. A choice with no line is `model_output_invalid` (502) after the Claim. The instruction to the model says to leave an item that the price list does not carry out of the lines, so a request that holds no SKU of the list ends that way.

The members of the quote, in this order:

| Member | What it holds |
|---|---|
| `schema` | `vector.usecase.quote.v1` |
| `outcome` | always `done` |
| `rfq_id` | the identifier of the request |
| `rfq_sha256` | the SHA-256 of the request for quotation that the desk received |
| `desk_did` | the DID of the desk (`AGENT_DID`) |
| `organisation` | the organisation of the desk (`BID_DESK_ORGANISATION`) |
| `lines` | the lines: each has `sku`, `quantity`, `unit_price`, `line_total` and `lead_time_days` |
| `total` | the sum of the line totals |
| `lead_time_days` | the longest lead time of the lines |
| `valid_until` | the last day on which the quote holds, as the model gave it |
| `notes` | the note of the model: at most 500 characters |
| `price_list_sha256` | the SHA-256 of the price list file that the desk serves |
| `credential` | the credential of the desk from the identity gateway, a compact JWS |
| `sender` | the sender: `did`, `organisation` and `organisation_verified`. The organisation is the one that the covering Accountable Party names, or `null`. It is recorded and never a reason to refuse |
| `checks` | the 7 checks of the hook, each `true`: `sender_active`, `sender_accountable`, `sender_key`, `delegation`, `delegation_usable`, `vault_paid` and `not_duplicate` |
| `decisions` | the one decision `quote`: the choice of the model and the proof of the model hire |
| `fault_mode` | the setting of the fault switch, empty for a clean run. It is the last member |

The quote names the hash of the request and the hash of the price list, so a buyer's agent can check each unit price against the public list.

## The hook

The hook is `POST /precheck`. The runtime asks it before it claims an escrow, and it waits 10000 ms for the answer. The hook makes the checks of the table, one after the other, and the first one that fails ends it. A refusal is the status and the code of the table, with a message. A refusal comes before the Claim and never after it: the escrow stays open, and nothing is paid.

| Code | Status | Check | The rule |
|---|---|---|---|
| `sender_not_active` | 403 | `sender_active` | the identity gateway has a record of the sender, the record has not ended, and its status is active |
| `sender_unaccountable` | 403 | `sender_accountable` | an Accountable Party covers the record of the sender now |
| `sender_key_mismatch` | 403 | `sender_key` | the key of the escrow, the buyer key, is a key that the record of the sender lists with the delegation purpose |
| `delegation_invalid` | 403 | `delegation` | a live delegation with the identifier of the request exists, names the sender as its delegate, and names the key of the escrow as its delegate key |
| `delegation_ended` | 403 | `delegation_usable` | the delegation and each of its parents can be used now to hire |
| `not_vault_paid` | 403 | `vault_paid` | a vault of that delegation paid the escrow |
| `duplicate_rfq` | 403 | `not_duplicate` | the rfq book holds no answer to this `rfq_id` from this sender |
| `check_unavailable` | 503 | each check | the hook cannot read a source: the identity gateway, the ledger or the rfq book. It is never a pass |

The first six checks are the shared checks of the kit: the sender, the delegation and the payment from a vault. The seventh is the check of the Bid Desk. The Bid Desk takes no approval, so it has no check of one. A sender that the identity gateway suspends because no Accountable Party covers its record gets `sender_unaccountable` from the first check, and not `sender_not_active`. The hook reads the record of the sender, and never the record of the Bid Desk itself.

The hook makes 4 timed reads, one after the other: the identity gateway once and the ledger three times (the delegation, its use and the payment from a vault). Each read ends inside `CHECKS_READ_BUDGET_MS`. 4 times the largest budget that the service accepts is under 9000 ms, so the answer of the hook comes inside the wait of the runtime. The read of the rfq book is local and has no budget.

When every check passes, the hook answers 200 `{"go":true,"reserved_ms":120000}`. It reserves the job slot for the escrow of the call, and it puts the record of the checks in `PassedChecks` with the SHA-256 of the request that it checked. The record lives 300 s, and the store holds 64 of them. The job takes the record by its escrow reference, and `PassedChecks` removes it when it gives it. A job with no record, a record for another body, a record that lacks one of the 7 checks, and a record with a fact that cannot be read all end `precheck_missing` (500). The job fails closed: it calls no model and writes nothing.

## Settings

| Variable | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `AGENT_DID` | `identity.did`, in the canonical form `did:vector:<identifier>`. It is the desk of the quotes, and the agent whose credential the job asks for | none. Required |
| `IDENTITY_POLICY_ID` | `identity.registry_address`, the address of the identity registry derived from this policy: 56 lowercase hex characters. It must be the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, or the service stops at start | none. Required |
| `IDENTITY_ADDRESS` | the address of the identity registry. It may be left out. When it is set, it must be the address of `IDENTITY_POLICY_ID` | derived from the policy |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case. It must be live, deployed or proposed, in any case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-24` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms` of the advert. At least 480000, because the deadline of a job assumes the 8 min window. At most 86400000, the 24 h that a Post accepts | `480000` |
| `SERVICE_AUTH_HEADER` | the `authorization` header that the runtime sends with every call, which `POST /` and `POST /precheck` require. It must be printable ASCII, for example `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required: the service stops at start without it |
| `FAULT_MODE` | the fault switch of a failure run: empty, or `quote_off_price_list`. Any other value stops the start. With `quote_off_price_list` the job quotes one line below the price list. No manifest holds the value, and each quote names it | empty |
| `PORT` | the port that the service listens on | `9106` |
| `HOST` | the address that the service listens on | `0.0.0.0` |
| `BID_DESK_STATE_DIR` | where the state is kept | `/data` |
| `BID_DESK_INSTANCE` | which of the three Bid Desks this deployment is: `alfa`, `bravo` or `charlie`. It selects the price list file and the name of the desk | none. Required |
| `BID_DESK_ORGANISATION` | the domain of the organisation of this Bid Desk, as its record names it: lower case, at least two labels, at most 64 characters. Each quote holds it | none. Required |
| `BID_DESK_PUBLIC_ORIGIN` | the https origin of the host of this Bid Desk, with no user, path, query or fragment. The service serves the price list at `<origin>/price-list.json`, and the manifest names that address | none. Required |
| `SUPPLIER_PKH` | the key hash of the supplier key of the runtime, 56 hex characters. It is published in the manifest, and with `AGENT_DID` it is the listed supplier key `identity.supplier_key` | none. Required |
| `SUPPLIER_PUB_KEY_HEX` | the public key of the supplier key, 64 hex characters. The service stops at start unless its key hash is `SUPPLIER_PKH` | none. Required |
| `BID_DESK_SERVICE_PRIV_KEY_HEX` | the service key, 64 lowercase hex characters, a raw Ed25519 key. It pays for the model hire and signs the transactions of the janitor. Never published, never logged | none. Required: the service stops at start without it |
| `BID_DESK_SERVICE_PKH` | optional. `keys.service_pkh` is always the key hash that the service key derives. A value here that is not that hash stops the service at start | derived |
| `VECTOR_OGMIOS_URL` | the Ogmios endpoint of the Vector node. It must be an `https://` address | the default of `packages/buyer-core` |
| `VECTOR_KOIOS_URL` | the Koios endpoint | the default of `packages/buyer-core` |
| `VECTOR_SUBMIT_URL` | the endpoint that takes a signed transaction | the default of `packages/buyer-core` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the model suppliers are found | the default of `packages/buyer-core` |
| `VECTOR_IDENTITY_LEGACY_ROOT` | the Merkle root of the adoption allowlist of the identity registry, 64 hex characters. One of the four deployment values of the identity registry, under the names that the MCP server reads. `packages/buyer-core` reads them | none. Required |
| `VECTOR_IDENTITY_CONFIG_SEED` | the output of the configuration seal of the identity registry, `<transaction hash>#<index>` | none. Required |
| `VECTOR_IDENTITY_ESCROW_REF_UTXO` | the reference script output of the escrow of the identity marketplace, `<transaction hash>#<index>` | none. Required |
| `VECTOR_IDENTITY_VAULT_REF_UTXO` | the reference script output of the vault, `<transaction hash>#<index>` | none. Required |
| `IDENTITY_GATEWAY_URL` | the https origin of the identity gateway | `https://id.vector.apexfusion.org` |
| `CHECKS_READ_BUDGET_MS` | the most that one timed read of the hook may take, in milliseconds. A whole number from 500 to 2249: 4 reads must stay under 9000 ms | `1200` |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire for its decision, comma separated, in order of preference, each of letters, digits, dots, underscores, colons, slashes and hyphens. The manifest holds the list | none. Required |
| `LLM_MAX_PRICE_LOVELACE` | the most that a model hire may be priced at, in lovelace. The manifest holds the number | none. Required |
| `LLM_MAX_SUPPLIER_BOND_LOVELACE` | the most that the supplier bond of a model advert may be, in lovelace. A model advert with a larger supplier bond is not hired | none. Required: no limit is not an answer |
| `LLM_MAX_BUYER_BOND_LOVELACE` | the most that the buyer bond of a model advert may be, in lovelace. A model advert with a larger buyer bond is not hired | none. Required: no limit is not an answer |

Numbers (and `PORT`) must be non-negative integers. A value that breaks a rule stops the service at start, and the error names the variable and never shows a value that is hex-shaped or long. Each limit of the model hire is a number: the service never fills in a missing limit. The Bid Desk reads no mock base, no Module-1 manifest and no dispute setting.

## Keys

The service holds one key: the service key, `BID_DESK_SERVICE`. Its secret is `BID_DESK_SERVICE_PRIV_KEY_HEX`, and `BID_DESK_SERVICE_PKH` is the public cross-check. The service key pays for the model hire of the quote decision: the chain of the key builds, signs and submits the Post and the Accept of each hire. It also signs the transactions of the janitor, which settles the escrows that a hire leaves behind. The service reads the variable once, at start.

The supplier key is the key of the runtime. This service never holds it. It holds the key hash and the public key of the supplier key (`SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`), which the manifest publishes. The public key must hash to the key hash beside it, which catches a private key put in a public line. The service stops at start when the service key is the supplier key: a service that held the supplier key could sign as the runtime.

## The fault switch

`FAULT_MODE` is empty or `quote_off_price_list`. Any other value stops the start. The service reads the switch once, at start. The switch is for a test of the buyer: a failure run in which the buyer's agent must catch a quote that is below the published price list.

With `quote_off_price_list`, the job sets the unit price of the first line that the price list prices to `listed - ceil(listed / 5)`, where `listed` is the price of the list for the SKU and the quantity of that line. The totals follow the changed line. The new price is below the listed price and at least 1, because every price of the three files is 10 or more. The decision on record stays what the model said. When no line can take that price, the job ends `internal`: a run never says that a fault was on when it changed nothing.

The fault changes what the job writes and never a check: no check of the hook reads it. No manifest holds the active value. At start the service renders the manifest for each setting of the switch, and it refuses to start when the bytes change, so the manifest and the advert hash are the same with the fault on or off. The manifest lists the value in `behaviour.fault_modes`, and one of its gaps names it. Each quote holds the setting in its last member, `fault_mode`.

## Errors

A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table. The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log, by its message only. A refusal of status 500 or more gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer and the detail is the operator's. `shutting_down` has the fixed message `The service is stopping and takes no new job. Try again shortly.`, and the 409 `busy` of the hook has the fixed message `The service is working on another job. Try again shortly.`. The messages of `duplicate_rfq` and `deadline` are fixed texts that hold no value of the request.

A Bid Desk is the hired side. A job that fails answers with its HTTP status, and the runtime turns the error into the answer that the buyer reads.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that is not a request for quotation of use case 3), `bad_context` (the six headers of the context are missing, some are missing, or one is not well formed) |
| 401, the caller | `unauthorized` (no message) |
| 403, the hook, before the Claim | `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `duplicate_rfq` |
| 403, the job, after the Claim | `duplicate_rfq` (the book holds an answer to this request already: the hook passed two escrows of one request before the first job wrote the book) |
| 404, no such route | `not_found` (no message) |
| 409, the service is busy | `busy` (a job runs, or the slot is reserved for another escrow. The answer to a job has no message, and the answer of the hook has one) |
| 422, the job | `deadline` (the caller hung up before the model hire or before the record in the book, or less than 30 s are left before the runtime stops waiting for the job) |
| 500, the service | `precheck_missing` (the job has no record of passed checks for its body), `store_write_failed` (the rfq book or the record of the model hire cannot be written), `internal` (a fault of the service: a plain 500 with no message when nothing names it, and the fixed message when the job names it) |
| 502, a third party | `credential_failed` (the identity gateway gave no credential that a quote can hold), `inference_failed` (the model hire failed), `model_output_invalid` (the answer of the model cannot be used: it breaks the shape of the decision, or a line is not an item of the request, or there is no line) |
| 503, the service cannot answer now | `check_unavailable` (the hook could not read a source), `shutting_down` (the service is stopping) |

A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow claimed. The buyer reclaims it after the deadline, and nothing is paid for work that was not done. The Bid Desk calls no mock system, so a failed job can leave behind a model hire and nothing else. A job that fails after it accepted the model hire has paid the model supplier from the service key. A hire that stays unfinished is in the stranded file, and the janitor settles it.

## Times

| Time | Value | What it bounds |
|---|---|---|
| Deadline of a job | 300000 ms | a job ends with a quote or a refusal this long after its request arrives. The model hire has the same deadline |
| Timeout of the runtime for a job | 360000 ms | `SERVICE_TIMEOUT_MS` of the runtime: 60 s after the deadline of a job |
| Window of the advert | 480000 ms to 86400000 ms | `ADVERT_MAX_PROCESSING_MS`: at least 8 min, at most 24 h. The default is the least |
| Call for the credential | 20000 ms | the one timeout of the call to the identity gateway for the credential of the desk. It fits inside the deadline of a job |
| Read of the hook | 1200 ms, from 500 ms to 2249 ms | `CHECKS_READ_BUDGET_MS`: each of the 4 timed reads of the hook ends inside it |
| Wait of the runtime for the hook | 10000 ms | the runtime reads silence as a refusal |
| Reservation of the job slot | 120000 ms | a go of the hook holds the slot for its escrow this long |
| Record of the checks | 300000 ms | the record that the hook keeps for the job lives this long, in memory |
| Least time left before delivery | 30000 ms | the job records no quote when less than this is left before the runtime stops waiting for it |
| Interim line | 60000 ms | the server writes `102 Processing` this often while a job runs |
| Pass of the janitor | 60000 ms | the janitor of the service key looks at the stranded file this often. A pass that is still in flight at a stop is abandoned after 30 s |
| Wait of a stop | 300000 ms | a stop waits this long for the job that is running |

## State files

The service keeps its state in `BID_DESK_STATE_DIR` (default `/data`, a volume in the image):

| Path | What it holds |
|---|---|
| `rfq-book.json` | the rfq book: the sender, the request identifier and the hash of the quote of each request that the service answered. It holds at most 10000 entries and never drops one |
| `keys/<key hash>/stranded.json` | the bookkeeping of the escrows that a model hire posted: references, times and transaction hashes, never a request or a quote |

The first start makes `rfq-book.json` with an empty book, and makes the folder of the service key. `stranded.json` is made when a model hire first posts an escrow. The service proves at start that it can write to its state directory, and it stops when it cannot.

A sender cannot get a second quote for one `rfq_id`: the book never drops an entry, so the refusal stands for good. A book that holds 10000 entries cannot take a new entry. For a request that the book does not hold, the hook answers 503 `check_unavailable` and the escrow stays open. For one that the book holds, the hook still answers 403 `duplicate_rfq`.

The job writes the book after it has built and checked the quote. The book reads its file at each call. A file that is missing or damaged after the start makes the hook answer 503 `check_unavailable`, and it never reads as an empty book. A stranded file that is not a list stops the start and is left as it is, because starting without it would forget escrows that still hold a lock. The janitor of the service key starts with the service. Every 60 s it looks at the stranded file and settles the escrows that a model hire left behind, when their time has come. It makes no transaction while a hire holds the queue of the key. The record of the checks that the hook keeps for a job is in memory only. A restart loses it: a job after a restart fails closed with `precheck_missing`.

The log carries job outcomes, counts and codes, never a request, a quote, a credential or a key.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, stops its janitor, and waits up to 300 s for the job that is running to end. A pass of the janitor that is still in flight after 30 s is abandoned, with a log line. A job that ends in time is answered, if its caller is still there, and the service exits 0. A job still running after 300 s is abandoned: its connection is closed, the log names the escrows that the state directory holds for the janitor of the next start, and the service exits 1. The container is killed when its grace period ends, so the grace period (`stop_grace_period` in a compose file) must be 330 s: the 300 s of the wait and 30 s more, for the log line and the exit code of a job that the service had to abandon. A second signal ends the process at once.

## Run it

The service needs Node 22 or later, a service key, and the settings of a deployment. It needs no other program and no model of its own. A run uses real value. The model hire posts an escrow on Vector mainnet from the service key. Put on that key only what you mean to commit to escrows and fees. On a machine with the repository:

```bash
pnpm install
cd agents/bid-desk
set -a; . /path/to/bid-desk.env; set +a                                 # the settings of the table above, but not the two secrets
export BID_DESK_SERVICE_PRIV_KEY_HEX="$(cat /path/to/service-key.hex)"  # read from a file: a key typed on a command line stays in the history of the shell
export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"             # the token that a caller must send, made by openssl
mkdir -p /tmp/bid-desk-state                                            # where the rfq book and the record of the model hires are kept
BID_DESK_STATE_DIR=/tmp/bid-desk-state PORT=9106 pnpm start
```

The service logs the address that the service key derives. That address pays for the model hire, so it needs funds. The start makes no call of its own to a third party. After it, the hook reads the identity gateway and the ledger, a job asks the identity gateway for the credential and a model supplier on the marketplace for its answer, and the janitor reads the ledger for each escrow that the stranded file holds.

The service stops at start, with the variable named, when a required setting of the table is not set, when a setting is not well formed, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`, when `BID_DESK_SERVICE_PKH` is not the key hash of the service key, when the service key is the supplier key, when `IDENTITY_POLICY_ID` is not the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, when `FAULT_MODE` names a value that the Bid Desk does not list, when `BID_DESK_INSTANCE` is not `alfa`, `bravo` or `charlie`, when `BID_DESK_ORGANISATION` is not a domain name in lower case, when `BID_DESK_PUBLIC_ORIGIN` is not an https origin, when `VECTOR_OGMIOS_URL` is an http address, when `CHECKS_READ_BUDGET_MS` is not from 500 to 2249, when `ADVERT_MAX_PROCESSING_MS` is below 8 min or above 24 h, or when it cannot write to its state directory.

A secret in the wrong line of an env file is the mistake that the start guards against. The service key is looked for in every other setting that the service reads, in its raw and its bech32 form, in any case, and inside a longer value too, before any check can print that line. Found there, it stops the start, names the variable and does not show the value. The token (`SERVICE_AUTH_HEADER`) is looked for in the same way, whole or by its credential (the part after `Bearer `), when it has 16 characters or more. So neither is in a message, a log line or an answer, and the manifest is searched for both once more before the service listens. No message shows a setting that is hex-shaped or long, only its length.

`Dockerfile` builds the service image on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/bid-desk/Dockerfile -t vsa/bid-desk:dev .`. The image runs as the `node` user under `tini`, listens on 9106 and answers `/healthz` for its health check. `/data` is a volume that `node` owns. The image has no Python, no model and no env file. It copies the service in parts: its manifest, its `tsconfig.json`, its `src` folder and its `price-lists` folder, so it holds no test file of the service. The memory limit is set where the container runs.

The advert holds the SHA-256 of the bytes that `GET /agent.json` serves. `node scripts/manifest-hash.mjs <https origin>` prints the `detail_uri` and the `detail_hash` of a running service. To run the tests of the package, use `pnpm --filter @vsa/bid-desk test`. They need no network and no key.

## Deploy

`deploy/server/docker-compose.bid-desk-alfa.yml`, `deploy/server/docker-compose.bid-desk-bravo.yml` and `deploy/server/docker-compose.bid-desk-charlie.yml` run one Bid Desk each, with its runtime, from this one image.

The env example is `deploy/server/.env.bid-desk.example`, and the steps are in `deploy/server/RUNBOOK-bid-desk.md`.

The host builds no image: each compose file names the image by its digest.
