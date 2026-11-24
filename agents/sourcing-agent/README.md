# Sourcing Agent

For a buying organisation: finds the suppliers that quote on the marketplace, asks each for a signed quote on a request for quotation, scores the quotes against price, lead time, reliability and compliance, and returns a ranked comparison. Once the organisation has approved the ranking, it writes it to the organisation's sourcing record. Capability `supplychain.rfq.evaluate.v1`.

## What it is

The Sourcing Agent is the buyer side of use case 3 (supplier bid evaluation). The supplier side is the Bid Desk. A buying organisation hires the Sourcing Agent with a request for quotation. The agent finds the Bid Desks that quote on the marketplace, hires the ones that the model invites for a signed quote each, scores the quotes that the model accepts, and returns a ranking for the organisation to approve.

The service sits behind the template runtime. The runtime holds the supplier key, claims the escrow of the hirer, and posts the job to this service as the body of `POST /`. The job is `propose` or `execute`.

`propose` takes these steps, in this order:

1. It checks the delegation of the hirer: a delegation that names another agent as its delegate is refused with 400 `delegation_not_mine`. It finds the delegation key that the delegation names. The job ends `failed` when the ledger shows no such delegation or when this agent holds no such key.
2. It reads the candidates: the Bid Desks that the indexer lists and the chain shows, at most 8. For each one it reads a file of facts: its status and lineage, its place in the catalog, its stake, the challenges against it, its price list, its compliance attestation and its credential.
3. The model chooses the bidders to invite, at most 3.
4. The agent hires the invited bidders one after the other, and it pays each quote from the vault of the delegation. Before it pays a bidder, it reads the status of the record again, and it needs a price list that it can check. Three checks in code come before the model: the quote is from the bidder, it answers this request, and it names the price list that the agent read. Then the model decides whether to accept the quote.
5. For each accepted quote, one scorer reads the vendor master through a sub-delegation, and the model scores the quote. The three scorers are used one for each accepted quote, in the order of the quotes.
6. The model gives the order of the ranking. The job builds the ranking from the quotes that the agent accepted. The model never writes a quote.
7. The job answers with the ranking, its salt and its digest. It writes nothing to the sourcing record.

`execute` writes the ranking that the hirer approved to the sourcing record of the tenant. It makes no model call, no hire and no payment. It checks the delegation, asks the identity gateway for one token for the route `sourcing.rankings`, and makes one call to the sourcing record. The service does not check an approval. It passes the reference of the request on, or `null`, and the sourcing record checks it. The refusal of the record is the result of the job.

The call to the sourcing record is made one time. The service never repeats it, also after a failure, because a failed call can have written the ranking. The sourcing record has no rule of one ranking for each request. A hirer who sends `execute` again after a `failed` result can write a second ranking. Read the sourcing record before you send `execute` again.

The claim of the agent is the three statements in `behaviour.claim` of its manifest. An operator command stakes that claim, and this service never does. The service files a challenge against a bidder only after a decision of the model that did not accept a quote, and only for a unit price: the evidence is the first line that the model named whose quoted unit price differs from the listed price of the bidder.

The escrow and the vault payment of a hirer stay locked up to the window of the advert, 5400000 ms (90 minutes) by default, when a job runs to its end. The jobs are in memory, so a restart ends the job that runs. A restart waits until the runtime says `free` at its `/status` route.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its settings when it starts, and it serves those bytes at `GET /agent.json`. It never serves the template. The placeholders `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>`, `<SOURCING_SERVICE_PKH>`, `<SOURCING_DELEGATION_1_PKH>`, `<SOURCING_DELEGATION_2_PKH>` and `<COMPLIANCE_ISSUER_PKH>` stand for the settings of the same name. Change the template by changing `manifestFromEnv`, and write it again with `pnpm --filter @vsa/sourcing-agent template`.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs. It has no check of its own beyond answering |
| `GET /agent.json` | the manifest: the bytes that the start rendered. The advert holds their SHA-256 |
| `POST /` | the job: the wire message, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| `POST /precheck` | the question that the runtime asks before it claims an escrow. A go is 200 `{"go":true,"reserved_ms":120000}` |
| `POST /cosign/delegate` | the co-sign route. It takes no token and no job slot. It signs one Delegate transaction for a principal key that the allowlist of the operator names |
| any other route | 404 `{"error":"not_found"}` |

`GET /healthz` and `GET /agent.json` need no token. They match on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. `POST /` and `POST /precheck` match on their path only: with a query string they are a 404. The co-sign route takes `POST` only.

`POST /` and `POST /precheck` need the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`. A call without it, or with another value, gets 401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is looked at.

The body of `POST /` and `POST /precheck` is the wire message: a one-element array whose `content` is the request JSON as a string and whose `role` is `user`. The service accepts at most 900000 bytes of wire payload, including the framing and escapes. The manifest publishes this limit as `terms.input_limits.request_bytes`. The shared HTTP reader stops at 1000000 bytes. A sender puts the wire payload inside a second JSON object. Escaping it again can make that body too large even if the payload fits. The runtime takes at most 1048576 bytes for the whole body.

The runtime sends six headers of the context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. `POST /precheck` needs all six. A call with none of them, with some of them, or with a bad one gets 400 `bad_context`. `POST /` takes a call with none of the six; a call with some of them, or with a bad one, gets 400 `bad_context`. The service uses the escrow reference to match a job to the reservation of its escrow, and it reads no other header.

`POST /precheck` has no check of its own. It answers with the state of the slot. It reads and parses the body as a job does: a request that breaks a rule of the intake gets its 400 before the slot is looked at, so the runtime never claims an escrow for a request that the job would refuse. When the slot is free, it reserves the slot for the escrow of the call for 120000 ms and answers the go.

One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. `POST /precheck` answers 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go for the escrow that holds the reservation reserves the slot again. The job of that escrow takes the reservation. A service that stops answers 503 `shutting_down` to both routes.

While a job runs, the server writes an interim `102 Processing` line every 60 s to a client that speaks HTTP/1.1, ahead of the answer. The runtime then does not give up on the silence. The lines stop when the job ends.

A job whose caller hangs up is stopped. `propose` reads the signal before each step. The quote fan-out reads it before each Pay, and the scoring reads it before each Delegate and each model call. So a caller that is gone starts nothing new, and what the job paid for before stays in the result. `execute` reads the signal before the token and before the call, and never gives it to the call: a call that was sent runs to its end.

The log has one line for each job: the operation, the time that it took, the outcome, the reason, the exit state and the number of decisions. A proposal adds the number of bidder files and of quote records. The line names counts and codes. It never holds a request, a bidder, a quote, a price list, a ranking or a key.

## The request

The request JSON is one object with the member `op` set to `propose` or `execute`. Each operation has its own members and no other. A request that breaks a rule is refused with 400 `bad_shape` before any job runs, on `POST /` and on `POST /precheck`. The manifest publishes the schema of both operations under `interface.request_schema`.

`propose` has these members:

| Member | Rule |
|---|---|
| `op` | the text `propose` |
| `authority` | an object with exactly two members |
| `authority.principal_did` | the DID of the principal who gave the delegation: `did:vector:` and 64 lowercase hex characters |
| `authority.delegation` | the identifier of the delegation that names this agent as its delegate: 64 lowercase hex characters |
| `tenant` | the tenant of the mock systems: 1 to 48 characters, lower-case letters, digits and hyphens, starting with a letter or a digit |
| `rfq` | the request for quotation, an object with exactly three members |
| `rfq.rfq_id` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. A bidder gives one quote for each identifier and sender, so each `propose` needs a new identifier |
| `rfq.items` | 1 to 20 items, each with a `sku` and a `quantity`, and each SKU one time |
| `rfq.items[].sku` | the same form as `rfq.rfq_id` |
| `rfq.items[].quantity` | a whole number from 1 to 1000000 |
| `rfq.needed_by` | a date as `YYYY-MM-DD` that exists, in the year 0100 or later |
| `weights` | an object with exactly four members. Each is a number from 0 to 1 with at most 4 decimal places, and the four sum to 1. The agent does not send the weights to the bidders. |
| `weights.price`, `weights.lead_time`, `weights.reliability`, `weights.compliance` | the weight of the four parts of a score |

`execute` has these members:

| Member | Rule |
|---|---|
| `op` | the text `execute` |
| `authority`, `authority.principal_did`, `authority.delegation`, `tenant` | as for `propose` |
| `proposal` | exactly the three members that `propose` returned |
| `proposal.document` | the ranking. Its tenant must be the tenant of the request |
| `proposal.salt` | the salt of the proposal: 64 lowercase hex characters |
| `proposal.proposal_digest` | the digest of the proposal: 64 lowercase hex characters. The digest must be the digest of the salt and the document. |
| `approval` | the approval of the hirer for the digest, or `null`. The member must be there. The service passes it on, and the sourcing record checks it |
| `approval.attestation`, `approval.issuer_did` | the two members of an approval: the identifier of the attestation, and the DID of its issuer |

## The result

A job that does its work answers 200 with a result. A job that runs and does not end well answers 200 with a result too: see Reasons. `fault_mode` is the last member of every result: it is the setting of the fault switch, and it is empty in a clean run.

The result of `propose`, in the order of its members:

| Member | What it holds |
|---|---|
| `schema` | `vector.usecase.proposal.v1` |
| `use_case` | `bid-evaluation` |
| `decisions` | the decisions of the model, in this order: `shortlist`, each `accept_quote`, each `score` and `ranking`. Each holds its name, its choice as the model gave it, its reasoning and the proof of the model hire |
| `sub_jobs` | the quote jobs that the agent accepted: the receipt of each, its signature and the eight checks of the receipt |
| `document` | the ranking, or `null` in a failed result |
| `salt` | the salt of the proposal, or `null` |
| `proposal_digest` | the digest of the salt and the document, which the hirer approves, or `null` |
| `outcome` | `proposed` or `failed` |
| `exit_state` | `null` for `proposed`, `Failed` for `failed` |
| `reason` | `null` for `proposed`, a code for `failed` |
| `bidders` | the file of every candidate that the job read |
| `quotes` | the record of every quote job that has one: the accepted quotes, and the excluded bidders that were paid |
| `fault_mode` | the setting of the fault switch |

The file of a bidder has these members: `did`, `advert_ref`, `status`, `status_reason`, `lineage`, `accountable`, `organisation`, `organisation_verified`, `in_catalog`, `stake_lovelace`, `cases_against`, `price_list`, `compliance`, `credential`.

The record of a quote has these members: `desk_did`, `advert_ref`, `escrow_ref`, `paid_from_vault`, `receipt`, `receipt_signature`, `verification`, `result`, `accepted`, `challenge`.

A failed `propose` keeps what the job paid for and read: the decisions that it made, the quote jobs as `sub_jobs`, the files of the bidders and the records of the quotes.

The result of `execute`, in the order of its members:

| Member | What it holds |
|---|---|
| `schema` | `vector.usecase.result.v1` |
| `use_case` | `bid-evaluation` |
| `proposal_digest` | the digest of the proposal of the request |
| `handoff` | always `null`: `execute` hires no counterparty |
| `writes` | the one write to the sourcing record when it wrote the ranking, as `{"system":"sourcing-record","route":"POST /sourcing/rankings","status":201,"ref":<the id of the ranking or null>}`, and no write otherwise |
| `decisions` | always empty: `execute` makes no model call |
| `outcome` | `completed`, `refused_by_system` or `failed` |
| `reason` | `null` for `completed`, else a code |
| `challenge` | always `null` |
| `exit_state` | `Completed`, `Rejected` (or the state that the reason gives) or `Failed` |
| `fault_mode` | the setting of the fault switch |

The ranking document has these members:

| Member | What it holds |
|---|---|
| `schema` | `vector.usecase.ranking.v1` |
| `rfq_id` | the identifier of the request for quotation |
| `rfq_sha256` | the SHA-256 of the request, so that the approver and every quote talk about one request |
| `tenant` | the tenant of the request |
| `weights` | the four weights of the request |
| `ranked` | the ranked bidders, in the order of the model |
| `excluded` | every candidate that is not ranked, with the reason |

Each entry of `ranked` has these members: `rank`, `desk_did`, `organisation`, `score`, `components`, `quote`. The `quote` of an entry is built from the quote that the agent accepted: its escrow, the hash of its signed receipt, its total and its lead time. The model never writes it.

## Settings

A value that breaks a rule stops the service at start, and the message names the variable and never shows a value that is hex-shaped or long. A setting with no default is required. A number of lovelace is a whole number of digits, more than 0. The limits of the model hire and of the quote hire have no default, so a service never runs with a limit that nobody chose.

| Setting | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required |
| `AGENT_DID` | `identity.did`, in the form `did:vector:<identifier>`. It is the agent that the delegation of a hirer names as its delegate | none. Required |
| `IDENTITY_POLICY_ID` | `identity.registry_address`, the address of the identity registry derived from this policy: 56 lowercase hex characters. It must be the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, or the service stops at start | none. Required |
| `IDENTITY_ADDRESS` | the address of the identity registry. It may be left out. When it is set, it must be the address of `IDENTITY_POLICY_ID` | derived from the policy |
| `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO` | the four deployment values of the identity registry and of the vault, under the names that the MCP server reads. `packages/buyer-core` reads them | none. Required |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case. It must be live, deployed or proposed, in any case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-24` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace`, a whole number of lovelace of more than 0 | `3000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms`, the window of the advert. At least 5400000, because the deadline of a job assumes the 90 min window. At most 86400000, the 24 h that a Post accepts. The manifest publishes it | `5400000` |
| `SERVICE_AUTH_HEADER` | the `authorization` header that the runtime sends with every call, which `POST /` and `POST /precheck` require. It must be printable ASCII, for example `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required |
| `FAULT_MODE` | the one fault switch: empty, or `invert_scores`. Any other value stops the start. No manifest holds the value, and each result names it | empty |
| `PORT`, `HOST` | where the service listens | `9105`, `0.0.0.0` |
| `SOURCING_STATE_DIR` | where the records of the State files section are kept | `/data` |
| `VECTOR_OGMIOS_URL` | the Ogmios endpoint of the Vector node. It must be an `https://` address, because the tip reader of the janitor takes https only | the default of `packages/buyer-core` |
| `VECTOR_KOIOS_URL`, `VECTOR_SUBMIT_URL` | the Koios endpoint, and the endpoint that takes a signed transaction | the default of `packages/buyer-core` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the bidders are found | the default of `packages/buyer-core` |
| `VECTOR_MODULE1_MANIFEST` | the pinned `https://` address of the Module-1 deployment manifest, which the start fetches one time | none. Required |
| `IDENTITY_GATEWAY_URL` | the https origin of the identity gateway | `https://id.vector.apexfusion.org` |
| `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE` | the two https origins of the mock systems: the host of tokens and the client-certificate host. They must be two hosts. | none. Required |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire, comma separated, in order of preference | none. Required |
| `LLM_MAX_PRICE_LOVELACE` | the most that a model hire may cost, in lovelace | none. Required |
| `LLM_MAX_SUPPLIER_BOND_LOVELACE`, `LLM_MAX_BUYER_BOND_LOVELACE` | the most of each bond of the advert of a model, in lovelace | none. Required |
| `QUOTE_MAX_PRICE_LOVELACE`, `QUOTE_MAX_SUPPLIER_BOND_LOVELACE`, `QUOTE_MAX_BUYER_BOND_LOVELACE` | the most that a quote hire may cost, and the most of each bond of the advert of a Bid Desk, in lovelace | none. Required |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE` | the stake of a challenge, in lovelace | none. Required |
| `DISPUTE_MIN_WINDOW_LEFT_MS` | the least time left in the challenge window of a claim: a whole number of milliseconds of at least 2000 | none. Required |
| `DISPUTE_READ_TIMEOUT_MS` | the most time of one read of the dispute code: a whole number of milliseconds of at most 30000, the read budget of the buyer code, because the reserve of a quote hire assumes it | none. Required |
| `DISPUTE_STARTED_LEASE_MS` | the lease of a challenge that did not finish. At least twice `DISPUTE_READ_TIMEOUT_MS` | 10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more |
| `DISPUTE_RESOLUTION_DEADLINE_MS` | the resolution deadline of a challenge. It must be the one of the Module-1 deployment | the deadline of the deployment |
| `SUPPLIER_PKH` | `keys.supplier_pkh`: the key hash of the supplier key, 56 hex characters. It is published in the manifest | none. Required |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex`: the public key of the supplier key, 64 hex characters. The service stops at start unless its key hash is `SUPPLIER_PKH`. The service never signs with it | none. Required |
| `SCORER_1_DID`, `SCORER_2_DID`, `SCORER_3_DID` | the DIDs of the three scorers `scorer-1` to `scorer-3`. Each scorer is an agent of its own: no scorer is this agent, and no two scorers are one agent | none. Required |
| `COMPLIANCE_ISSUER_PKH` | `keys.compliance_issuer_pkh`: the key hash of the issuer of the compliance attestations that the agent counts, 56 hex characters. An attestation of any other issuer is not counted | none. Required |
| `COSIGN_ALLOWLIST` | the principals for whom the co-sign route signs, comma separated. The empty text holds nobody | none. Required |
| `COSIGN_MAX_CONCURRENT` | the most calls that the co-sign route works on at one time | `4` |
| `COSIGN_MAX_FUTURE_MS` | how far ahead the end of the validity window of a transaction may be | `3600000` |
| `COSIGN_LEDGER_TIMEOUT_MS` | the most time of one read of the ledger or one call of the register of signed bodies | `5000` |
| `SOURCING_SERVICE_PRIV_KEY_HEX`, `SOURCING_SERVICE_PKH` | the service key, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SOURCING_DELEGATION_1_PRIV_KEY_HEX`, `SOURCING_DELEGATION_1_PKH` | the first delegation key, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SOURCING_DELEGATION_2_PRIV_KEY_HEX`, `SOURCING_DELEGATION_2_PKH` | the second delegation key, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_1_AUTH_PRIV_KEY_HEX`, `SCORER_1_AUTH_PKH` | the authentication key of `scorer-1`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_1_DELEGATION_PRIV_KEY_HEX`, `SCORER_1_DELEGATION_PKH` | the delegation key of `scorer-1`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_2_AUTH_PRIV_KEY_HEX`, `SCORER_2_AUTH_PKH` | the authentication key of `scorer-2`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_2_DELEGATION_PRIV_KEY_HEX`, `SCORER_2_DELEGATION_PKH` | the delegation key of `scorer-2`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_3_AUTH_PRIV_KEY_HEX`, `SCORER_3_AUTH_PKH` | the authentication key of `scorer-3`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `SCORER_3_DELEGATION_PRIV_KEY_HEX`, `SCORER_3_DELEGATION_PKH` | the delegation key of `scorer-3`, and its key hash | none. The key is required; the key hash is derived when it is not set |

The terms of the advert are fixed, except the price: the price is `ADVERT_PRICE_LOVELACE`, each bond is 1000000 lovelace, and the lock is 5000000 lovelace at the default price.

## Keys

The service holds nine keys. Each key has a secret variable, `<PREFIX>_PRIV_KEY_HEX`, and a public cross-check variable, `<PREFIX>_PKH`, which holds the key hash. A key is 64 hex characters, read from the env file and from nowhere else. The service reads each variable one time, at start.

| Key | Key hash | Job |
|---|---|---|
| `SOURCING_SERVICE_PRIV_KEY_HEX` | `SOURCING_SERVICE_PKH` | the service key. It pays the model hires, signs the evidence and the challenge of a dispute, and signs the subject token of the agent |
| `SOURCING_DELEGATION_1_PRIV_KEY_HEX` | `SOURCING_DELEGATION_1_PKH` | the first delegation key. A delegation of a hirer names it as the delegate key. It pays the quote hires from the vault of that delegation, signs the Delegate and the Undelegate of each sub-delegation, and signs the proof of a token call |
| `SOURCING_DELEGATION_2_PRIV_KEY_HEX` | `SOURCING_DELEGATION_2_PKH` | the second delegation key, with the same job |
| `SCORER_1_AUTH_PRIV_KEY_HEX` | `SCORER_1_AUTH_PKH` | the authentication key of `scorer-1`. It signs the subject token of the scorer |
| `SCORER_1_DELEGATION_PRIV_KEY_HEX` | `SCORER_1_DELEGATION_PKH` | the delegation key of `scorer-1`. It is the delegate key of the sub-delegation of the scorer, and the key of the proof of its token |
| `SCORER_2_AUTH_PRIV_KEY_HEX` | `SCORER_2_AUTH_PKH` | the authentication key of `scorer-2` |
| `SCORER_2_DELEGATION_PRIV_KEY_HEX` | `SCORER_2_DELEGATION_PKH` | the delegation key of `scorer-2` |
| `SCORER_3_AUTH_PRIV_KEY_HEX` | `SCORER_3_AUTH_PKH` | the authentication key of `scorer-3` |
| `SCORER_3_DELEGATION_PRIV_KEY_HEX` | `SCORER_3_DELEGATION_PKH` | the delegation key of `scorer-3` |

The supplier key is the key of the runtime. This service never holds it. It holds the key hash and the public key of the supplier key (`SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`), which the manifest publishes. The public key must hash to the key hash beside it, which catches a private key in a public line. The service stops at start when one of the nine keys is the supplier key, and when two keys are one key: each key of the service is a key of its own.

Three of the keys pay: the service key and the two delegation keys. Each of them has one wallet and one lane. Everything that spends from a wallet runs on the lane of its key, one thing at a time, so no two transactions of one key spend one output. The six keys of the scorers own no wallet and no lane.

No key value stands in the manifest, in a log line, in an answer or in a message of the service.

## The fault switch

`FAULT_MODE` is empty or `invert_scores`. Any other value stops the start. The service reads the switch one time, at start. The switch is for a failure run, in which the agent does one wrong thing on purpose, so that the hirer and the checks can show how they answer.

With `invert_scores`, the scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value. The subtraction is made on the decimal text of the number, so 80.2 gives 19.8. The other scorers are not changed. The decision that the model made stays on record as the model gave it: the reversal is made on the answer of the scorer.

The fault changes what the job writes. It never changes a check. The manifest does not hold the active value: it lists `invert_scores` in `behaviour.fault_modes`, and one of its gaps names it. The bytes of the manifest are the same for every setting. Each result holds the setting in its last member, `fault_mode`.

## Errors

A call that the service refuses has the body `{"error": "<code>", "message": "<words>"}`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job and a 500 for an error that the service does not name. A refusal with a status of 500 or more gets fixed words for the buyer, `The service could not do this job (<code>). The operator's log has the detail.`, and the whole message is in the log. `shutting_down` has the fixed message `The service is stopping and takes no new job. Try again shortly.`, and the 409 `busy` of `POST /precheck` has the fixed message `The service is working on another job. Try again shortly.`.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over the limit), `bad_shape` (a request that breaks a rule of the intake, a tenant outside the form of the schema among them), `bad_context` (a context header that is missing or bad), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 500 | `internal` (a fault of the service) |
| 503 | `shutting_down` (the service is stopping) |

The codes and their statuses are `ERROR_STATUS` in `packages/usecase-kit/src/protocol`, except the two codes that the shared server answers itself, `bad_context` and `not_found`.

The co-sign route has its own codes:

| Status | Codes |
|---|---|
| 400 | `not_a_delegation`, `not_for_this_agent`, `expired`, `bad_shape`, `request_too_large` |
| 403 | `principal_not_allowed`, `spends_agent_funds` |
| 409 | `key_in_use`, `busy` |
| 415 | `unsupported_media_type` |
| 500 | `internal` |
| 503 | `check_unavailable` |

The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.

A job that fails is no HTTP error. It is a 200 result with a `reason` code, as the section Reasons says. The table of the reasons is on the page `specs/sourcing-agent.md`, with the step that writes each reason.

## Reasons

A job that does not end well is a 200 result, and its `reason` says why. The result says what happened in `outcome`, `exit_state` and `reason`:

| Job | Outcome | Exit state | Reason |
|---|---|---|---|
| `propose` | `proposed` | `null` | `null` |
| `propose` | `failed` | `Failed` | the code of the step that failed |
| `execute` | `completed` | `Completed` | `null` |
| `execute` | `refused_by_system` | `Rejected` | the code of the sourcing record |
| `execute` | `failed` | `Failed` | the code of the step that failed |

`approval_expired` gives `Expired` and `delegation_ended` gives `Cancelled` as the exit state of a refusal of the sourcing record. A `mock_system_failed` can leave the ranking written: read the sourcing record before you send `execute` again.

The reason is a code of lower-case letters, digits and `_`, at most 64 characters. A text that is no code is the reason `internal`. The code of a model decision that failed passes through as it is. The codes come from these closed lists of the code:

| List | Codes of |
|---|---|
| `PROPOSE_FAILURES` | the steps of `propose` |
| `QUOTE_CODES` | the quote fan-out: the reason and the code of a bidder that was left out, and the code that stops the fan-out |
| `SCORING_FAILURES` | the scorers |
| `EXECUTE_FAILURES` | the steps of `execute`. The reason of a refusal of the sourcing record is a class, and it is not in the list |

The page `specs/sourcing-agent.md` has the table of the codes, with the step that writes each one.

## Times

| Time | Value | What it bounds |
|---|---|---|
| Deadline of `propose` | 5220000 ms | `PROPOSE_DEADLINE_MS`: every wait of the job ends this long after its request arrives |
| Deadline of `execute` | 120000 ms | `EXECUTE_DEADLINE_MS`: the job ends this long after its request arrives |
| Timeout of the runtime for a job | 5280000 ms | `SERVICE_TIMEOUT_MS` of the runtime: 60 s after the deadline of a job |
| Window of the advert | 5400000 ms | `ADVERT_MAX_PROCESSING_MS`: 120 s after the timeout of the runtime. It is the least value and the default. The most is 86400000 ms. The escrow and the vault payment of the hirer stay locked up to it |
| Reserve of a quote hire | 1830000 ms | `QUOTE_HIRE_RESERVE_MS`: the time that one hire of a quote can take, from the Pay to its end |
| Reserve of the scoring | 1080000 ms | `SCORING_RESERVE_MS`: the need of the three scorers and the reserve of the ranking. The fan-out keeps it for the scoring after its last hire |
| Time left for a hire | 2910000 ms | the reserve of a quote hire and the reserve of the scoring together |
| Need of one scorer | 720000 ms | `SCORER_NEED_MS`: the least wait for the confirmations of the sub-delegation, the job of the scorer and the end of the sub-delegation |
| Need of the three scorers | 960000 ms | `SCORERS_NEED_MS`: the need of one scorer and the turn of the Delegates of the first two scorers |
| Reserve of the ranking | 120000 ms | `RANKING_RESERVE_MS`: the ranking decision and the build of the document |
| Job of a scorer | 420000 ms | `SCORER_JOB_TIMEOUT_MS`: the token, the read of the vendor master and the decision |
| Validity of a sub-delegation | 1800000 ms | `SUB_DELEGATION_VALID_MS`. The end step ends it earlier |
| Read of the bidders | 120000 ms | `BIDDER_READ_BUDGET_MS`: the whole read of the candidates |
| Call of a fact reader | 20000 ms | `FACT_READ_TIMEOUT_MS`: one call of a port of the reader |
| Fetch of a bidder file | 10000 ms | `BIDDER_FETCH_TIMEOUT_MS`: one fetch of a manifest or of a price list |
| Read of the ledger | 20000 ms | `LEDGER_BUDGET_MS`: every read of one check of a delegation |
| Reservation of the job slot | 120000 ms | a go of `POST /precheck` holds the slot for its escrow this long |
| Interim line | 60000 ms | the server writes `102 Processing` this often while a job runs |
| Pass of the janitors | 60000 ms | each janitor looks at what the jobs left behind this often |
| Wait of a stop | 300000 ms | a stop waits this long for the job that is running |

A quote hire starts only when the deadline of the job is at least 2910000 ms away, so it starts in the first 2310000 ms of the job. A bidder that the fan-out reaches later is left out with the reason `deadline`, and a job with no accepted quote ends `failed` with `no_quotes`. So with slow desks the job proposes from fewer quotes. The scoring starts only with `SCORING_RESERVE_MS` left, and the ranking decision only with `RANKING_RESERVE_MS` left. The job ends `failed` with `deadline` when it has not.

The job reads at most 8 candidates. A pass of a janitor that is still in flight at a stop is abandoned after 30000 ms. The window is not a promise that a job takes that long.

## State files

The service keeps its state in `SOURCING_STATE_DIR` (default `/data`, a volume in the image). The start proves that the directory can be written: it makes a file and removes it, and it stops when it cannot.

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the bookkeeping of the escrows that a paying key posted and did not settle: references, times and transaction hashes, never a request or a quote. There is one folder for each of the three paying keys |
| `dispute/` | the journal of the challenges that the service files |
| `left/` | the sub-delegations that a job left behind, which their janitor ends |
| `cosign-register.json` | the register of the delegation keys that a co-signed transaction uses, so a restart still answers `key_in_use` |

The start makes the folder `keys/<key hash>` of each paying key. Every 60 s the janitor of a paying key looks at its stranded file and settles the escrows that a hire left behind, when their time has come. The janitor of the left sub-delegations looks at its list every 60 s and ends the sub-delegations that no job uses. A janitor makes no transaction while its key is busy.

The log carries job outcomes, counts and codes, never a request, a quote, a price list, a vendor entry or a key. The request, the weights, the quotes, the files of the bidders and the entries of the vendor master are held in memory while a job runs.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, stops its janitors, and waits up to 300 s for the job that is running to end. A pass of a janitor that is still in flight after 30 s is abandoned, with a log line. A job that ends in time is answered, if its caller is still there, and the service exits 0. A job still running after 300 s is abandoned: its connection is closed, the log names the escrows that the state directory holds for the janitors of the next start, and the service exits 1. The container is killed when its grace period ends, so the grace period (`stop_grace_period` in a compose file) must be 330 s: the 300 s of the wait and 30 s more, for the log line and the exit code of a job that the service abandons.

A job is in memory only. A restart ends the job that runs, and the escrow and the vault payment of its hirer stay locked up to the window of the advert. Wait until the runtime says `free` before a restart.

## Run it

The service needs Node 22 or later, nine keys, a node, a Koios endpoint, a submit endpoint, the identity gateway, the marketplace indexer, the mock systems and the Module-1 manifest at a pinned address. A run uses real value: the model hires and the quote hires post escrows on Vector mainnet from the three paying keys. Put on those keys only what you mean to commit. On a machine with the repository:

```bash
pnpm install
cd agents/sourcing-agent
set -a; . /path/to/sourcing.env; set +a                  # the settings of the table above, but not the nine keys and the token
export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"   # the token that a caller must send, made by openssl
for prefix in SOURCING_SERVICE SOURCING_DELEGATION_1 SOURCING_DELEGATION_2 SCORER_1_AUTH SCORER_1_DELEGATION SCORER_2_AUTH SCORER_2_DELEGATION SCORER_3_AUTH SCORER_3_DELEGATION; do
  export "${prefix}_PRIV_KEY_HEX=$(cat "/path/to/keys/${prefix}.hex")"   # each key is read from a file: a key typed on a command line stays in the history of the shell
done
mkdir -p /tmp/sourcing-state                                  # where the records of the State files section are kept
SOURCING_STATE_DIR=/tmp/sourcing-state PORT=9105 pnpm start
```

The service logs one `listening` line: the address and the port, the hash of the manifest, the addresses of the three wallets that pay (the service key, delegation 1 and delegation 2) and the state directory. The three wallets need funds. At start the service makes three kinds of call: it fetches the Module-1 manifest from its pinned address, it asks the node for the start time of the chain, and it reads the wallet of each of its three paying keys. It calls nothing else at start.

The service stops at start, with the variable named, when a required setting of the table is not set, when a setting is not well formed, when a `..._PKH` is not the key hash of its key, when two keys are one key, when a key is the supplier key, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`, when `IDENTITY_POLICY_ID` is not the identity policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, when a scorer DID is the DID of the agent or of another scorer, when `MOCK_MTLS_BASE` names the host of `MOCK_PUBLIC_BASE`, when `FAULT_MODE` names a value that the Sourcing Agent does not list, when `VECTOR_OGMIOS_URL` is an http address, when `ADVERT_MAX_PROCESSING_MS` is below 5400000 or above 86400000, when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit, when the Module-1 manifest cannot be fetched or names another identity registry than `IDENTITY_POLICY_ID`, when the node gives no start time of the chain, or when it cannot write to its state directory.

`VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters, the commit that the manifest was published at. A file path, an `http://` address, an address with a user, a query or a fragment, and an address with no commit stop the start. The manifest must name the identity registry of `IDENTITY_POLICY_ID`. A manifest of another registry stops the start, and the message shows no hash.

A secret in the wrong line of an env file is the mistake that the start guards against. Each of the nine keys is looked for in every other setting that the service reads, in its raw form and its bech32 form, in any case, and inside a longer value too, before any check can print that line. The token (`SERVICE_AUTH_HEADER`) is looked for in the same way, whole or by its credential (the part after `Bearer `), when it has 16 characters or more. A hit stops the start, names the variable and does not show the value. The manifest is searched for all of them once more before the service listens.

`Dockerfile` builds the service image on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/sourcing-agent/Dockerfile -t vsa/sourcing-agent:dev .`. The image runs as the `node` user under `tini`, listens on 9105 and answers `/healthz` for its health check. `/data` is a volume that `node` owns. The image has no Python, no model and no env file. It copies the service in parts: its manifest, its `tsconfig.json` and its `src` folder, so it holds no test file of the service. The memory limit is set where the container runs.

The advert holds the SHA-256 of the bytes that `GET /agent.json` serves. `node scripts/manifest-hash.mjs <https origin>` prints the `detail_uri` and the `detail_hash` of a running service. To run the tests of the package, use `pnpm --filter @vsa/sourcing-agent test`. They need no network and no key.

## Deploy

`deploy/server/docker-compose.sourcing-agent.yml` runs the service and its runtime from two images.
The env example is `deploy/server/.env.sourcing-agent.example`, and the steps are in `deploy/server/RUNBOOK-sourcing-agent.md`.
The host builds no image: the compose file names each image by its digest.
