# Order Desk

For a supplier: takes a purchase order for one lot from a buyer's agent, checks who sent it and that the buyer approved exactly this order, and, if the lot can be supplied, places it in the supplier's system and confirms it. Capability `supplychain.order.accept.v1`.

The Order Desk is the supplier side of use case 1 (inventory reorder). The buyer side is the Reorder Agent. It sends a handoff with one purchase order, and the Order Desk answers with a confirmation.

The service sits behind three template runtimes, one for each lot: `lot-small`, `lot-medium` and `lot-large`. Each runtime holds the supplier key of its lot and has its own advert. The three runtimes share this one service and this one manifest. A runtime claims the escrow of a buyer, posts the job to this service as the body of `POST /`, and signs the one receipt that the answer gives.

Before a runtime claims an escrow, it asks this service. The question is `POST /precheck`, and this page calls it the hook. The hook makes 16 checks, one after the other: the sender, the delegation, the payment from a vault, the approval, and then the supplier, the lot, the quantity and the purchase order number. The first check that fails refuses the job with its code. The escrow stays open, nothing is claimed, and nothing is paid. When every check passes, the hook keeps the record of the checks for 300 s and reserves the job slot for that escrow for 120 s.

After the Claim, the runtime posts the job. The job takes the record of the hook by its escrow reference, and compares the hash of its own body with the hash that the hook checked. It gets an X.509-SVID for the service key from the identity gateway. It reads the catalogue entry of the SKU at the supplier portal. It asks one model if the lot can be supplied. The service hires that model on the Vector marketplace through a bonded escrow that it posts with its service key. When the model says yes, the job places the order at the supplier portal, writes the order book and answers with the confirmation. When the model says no, the job answers `cannot_supply` and places no order. A job with no record of passed checks for its own body fails closed: it places no order.

The service holds one key: the service key. It pays for the model hire, signs the transactions of the dispute code, and signs the request for the X.509-SVID. The three supplier keys belong to the runtimes. The service holds their key hashes and their public keys only.

When the approval is for another purchase order than the one in the handoff (`approval_digest_mismatch`), the hook refuses first. Then it starts a challenge in the background against the open claim of the sender: the service publishes an evidence document and a challenge on the ledger. The answer to the runtime never waits for the challenge and never holds a reference to it.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its settings when it starts, and serves those bytes at `GET /agent.json`. It never serves the template itself. The three adverts hold the SHA-256 of those bytes, so the three runtimes show one manifest hash.

## Run it

The service needs Node 22 or later, a service key, and the settings of a deployment. It needs no other program and no model of its own. A run uses real value. The model hire posts an escrow on Vector mainnet from the service key, and a challenge locks a stake. Put on that key only what you mean to commit to escrows, fees and stakes. On a machine with the repository:

```bash
pnpm install
cd agents/order-desk
set -a; . /path/to/order-desk.env; set +a                                  # the settings of the table below, but not the two secrets
export ORDER_DESK_SERVICE_PRIV_KEY_HEX="$(cat /path/to/service-key.hex)"  # read from a file: a key typed on a command line stays in the history of the shell
export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"                # the token that a caller must send, made by openssl
mkdir -p /tmp/order-desk-state                                             # where the order book, the journal of the challenges and the record of the model hires are kept
ORDER_DESK_STATE_DIR=/tmp/order-desk-state PORT=9102 pnpm start
```

The service logs the address that the service key derives. That address pays for the model hire and for a challenge, so it needs funds.

At start the service makes one fetch: the Module-1 manifest, from its pinned address. The fetch has a limit of 20 s. After the start the service calls a third party for the hook, for a job, for a challenge, and for the janitor, which reads the ledger for the escrows that a run left behind.

The service stops at start, with the variable named, when a required setting of the table is not set, when a setting is not well formed, when a public key is not the public key of the key hash beside it, when `ORDER_DESK_SERVICE_PKH` is not the key hash of the service key, when the service key is the key of a runtime or two runtimes have one key, when `FAULT_MODE` names a value that the Order Desk does not list, when `CHECKS_READ_BUDGET_MS` is not from 500 to 1499, when `ADVERT_MAX_PROCESSING_MS` is below 8 min, when `LOTS_PUBLIC_ORIGIN` is not the origin of the small runtime, when `VECTOR_MODULE1_MANIFEST` is not an https URL pinned to a commit, when the Module-1 manifest cannot be fetched or names another identity registry than this deployment, or when it cannot write to its state directory.

A secret in the wrong line of an env file is the mistake that the start guards against. The service key is looked for in every other setting that the service reads, in its raw and its bech32 form, in any case, and inside a longer value too, before any check can print that line. Found there, it stops the start, names the variable and does not show the value. The token (`SERVICE_AUTH_HEADER`) is looked for in the same way, whole or by its credential (the part after `Bearer `), when it has 16 characters or more. So neither is in a message, a log line or an answer, and the manifest is searched for both once more before the service listens. No message shows a setting that is hex-shaped or long, only its length. The three runtime keys are public values. Each public key must hash to the key hash beside it, which catches a private key put in a public line.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs: it has no check of its own beyond answering |
| `GET /agent.json` | the manifest, the bytes that `JSON.stringify` gives |
| `GET /lots.json` | the lots file, the bytes that the manifest hashes. It needs no token and takes no job slot |
| `POST /precheck` | the hook: the token, the body of a job and the six context headers. A go is 200 `{"go":true,"reserved_ms":120000}`. A refusal is `{"error":"<code>","message":"<words>"}` with its status |
| `POST /` | the job: the wire message and the six context headers, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| any other route | 404 `{"error":"not_found"}` |

`GET /healthz`, `GET /agent.json` and `GET /lots.json` are matched on their path, whatever the query string, and a `HEAD` of any of them gets the headers of the `GET` and no body.

The body of `POST /` and of `POST /precheck` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`. It is read up to 1000000 bytes. The request JSON is the handoff of use case 1: `{ "schema": "vector.usecase.handoff.v1", "use_case": "inventory-reorder", "sender_did": "...", "delegation": "...", "document": { ... }, "salt": "...", "approval": { "attestation": "...", "issuer_did": "..." } }`. The `document` is a purchase order (`vector.usecase.po.v1`). A handoff for another use case, and a document that is not a purchase order, are `bad_shape` (400).

The runtime sends six headers of the context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. The hook needs all six. The job needs them too: a call with none, with some, or with a bad one gets 400 `bad_context`. The advert and the lot come from these headers and never from the body. The `model` of an advert is its lot name.

`POST /` and `POST /precheck` require the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`, the value that the runtimes send with every call. A call without it, or with another value, gets 401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is taken. The values are compared in constant time, and a refusal is logged once a minute at most, with a count and nothing that the caller sent. The other routes need no header: the health check of the image sends none, and the manifest and the lots file are public.

One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go of the hook for the escrow that holds the reservation reserves the slot again; a refusal of the hook reserves nothing. A go of the hook reserves the slot for its escrow for 120000 ms, and the job for that escrow takes the reservation. A job whose caller hangs up before the order call is stopped there: the service never places an order that nobody will read. A hang-up during the order call, or after it, does not stop the job: it books the order, and its log says that the caller hung up. A job has its own deadline, 300000 ms after its request arrives. The runtime waits 60 s longer (its `SERVICE_TIMEOUT_MS` is 360000), and the window of the adverts is 480000 ms at least. One call to the supplier portal takes 20000 ms at most. The job places no order when that call could end less than 30 s before `deliver_by`.

While a job runs, the server writes an interim `102 Processing` line every 60 s to a client that speaks HTTP/1.1, ahead of the answer. The reason is that the runtime's fetch gives up after 300 s of silence. The lines stop when the job ends.

The runtime waits 10000 ms for the hook, and reads silence as a refusal. The hook makes 6 timed reads, one after the other: the identity gateway once and the ledger five times. Each read ends inside `CHECKS_READ_BUDGET_MS`. Six times the largest budget that the service accepts is under 9000 ms, so the answer of the hook comes inside the wait of the runtime.

The answer to a job is the confirmation of the order. Its last member is `fault_mode`, which names the setting of the fault switch.

## The checks

The hook makes the 16 checks of the confirmation in this order: `sender_active`, `sender_accountable`, `sender_key`, `delegation`, `delegation_usable`, `vault_paid`, `approval_found`, `approval_type`, `approval_subject`, `approval_issuer`, `approval_valid`, `approval_digest`, `for_this_supplier`, `lot`, `quantity` and `not_duplicate`. The first 12 are the shared checks of use case 1: the sender, the delegation, the payment from a vault of that delegation, and the approval of the buyer for this exact purchase order. The last four are the checks of the Order Desk:

| Check | Refusal code | The rule |
|---|---|---|
| `for_this_supplier` | `not_for_this_supplier` | the purchase order names this agent (`AGENT_DID`) as its supplier |
| `lot` | `lot_mismatch` | the advert of the order is the advert of the escrow, and the lot of the order is the `model` of that advert |
| `quantity` | `quantity_mismatch` | the quantity is the size of that lot for the SKU in the lots file. A SKU that the file does not list is a mismatch |
| `not_duplicate` | `duplicate_po` | the order book holds no order for the tenant and the purchase order number. A number counts without regard to case |

A source that the hook cannot read (the identity gateway, the ledger or the order book) is never a pass: the hook answers 503 `check_unavailable`.

## Errors

A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table. The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log, by its message only. A refusal of status 500 or more gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer and the detail is the operator's. `shutting_down` has the fixed message `The service is stopping and takes no new job. Try again shortly.`, and the 409 `busy` of the hook has the fixed message `The service is working on another job. Try again shortly.`. The message of `cannot_supply` holds a fixed text and the first 120 characters of the note of the model.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that is not a handoff of use case 1 with a purchase order), `bad_context` (the six headers of the context are missing, some are missing, or one is not well formed) |
| 401, the caller | `unauthorized` (no message) |
| 403, the hook, before the Claim | `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `approval_not_found`, `approval_wrong_type`, `approval_wrong_subject`, `approval_wrong_issuer`, `approval_revoked`, `approval_expired`, `approval_issuer_invalid`, `approval_digest_mismatch`, `not_for_this_supplier`, `lot_mismatch`, `quantity_mismatch`, `duplicate_po` |
| 403, the job, after the Claim | `cannot_supply` (the model says that the lot cannot be supplied), `duplicate_po` (the supplier portal holds an order for the number already) |
| 404, no such route | `not_found` (no message) |
| 409, the service is busy | `busy` (a job runs, or the slot is reserved for another escrow. The answer to a job has no message, and the answer of the hook has one) |
| 422, the job | `deadline` (the caller hung up before the order call, or too little time was left to place the order) |
| 500, the service | `precheck_missing` (the job has no record of passed checks for its body), `store_write_failed` (the order book or the record of the model hire cannot be written. When the order book fails, the portal holds the order), `internal` (a fault of the service: a plain 500 with no message when nothing names it, and the fixed message when the job names it) |
| 502, a third party | `svid_failed` (the identity gateway gave no X.509-SVID), `mock_system_failed` (the supplier portal did not take the call. After a call that was sent, the order may exist at the portal), `inference_failed` (the model hire failed), `model_output_invalid` (the answer of the model cannot be used) |
| 503, the service cannot answer now | `check_unavailable` (the hook could not read a source), `shutting_down` (the service is stopping) |

A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow claimed. The buyer reclaims it after the deadline, and nothing is paid for work that was not done. A job that fails before the order call places no order. A job that fails after the order call can leave an order at the portal with no entry in the order book. That happens with `mock_system_failed` after a call that was sent, and with `store_write_failed` of the order book. The log says so. When the portal holds the order, a later job for the same purchase order number passes the check `not_duplicate`, and the portal then refuses its order: that job ends with `duplicate_po` (403) after the Claim.

## State

The service keeps its state in `ORDER_DESK_STATE_DIR` (default `/data`, a volume in the image):

| Path | What it holds |
|---|---|
| `orders.json` | the order book: the tenant, the purchase order number and the order id of each order that the service placed. It holds at most 10000 orders and never drops one |
| `dispute/` | the journal of the dispute code: one file for each escrow job, so one escrow has at most one challenge |
| `keys/<key hash>/stranded.json` | the bookkeeping of the escrows that a model hire posted: references, times and transaction hashes, never a request or a catalogue entry |

A book that holds 10000 orders cannot take a new order. For a purchase order number that the book does not hold, the hook answers 503 `check_unavailable` and the escrow stays open. For a number that the book holds, the hook still answers 403 `duplicate_po`.

The job writes the order book after the supplier portal took the order. The order book reads its file at each call. A file that is missing or damaged after the start makes the hook answer 503 `check_unavailable`, and it never reads as an empty book. A stranded file that is not a list stops the start and is left as it is, because starting without it would forget escrows that still hold a lock. The janitor of the service key starts with the service. Every 60 s it looks at the stranded file and settles the escrows that a model hire left behind, when their time has come. It makes no transaction while a hire or a challenge holds the queue of the key. The record of the checks that the hook keeps for a job is in memory only. It lives 300 s, the store holds 64 of them, and a restart loses them: a job after a restart fails closed with `precheck_missing`.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, stops its janitor, and waits up to 300 s for the job that is running to end. A pass of the janitor that is still in flight after 30 s is abandoned, with a log line. A job that ends in time is answered, if its caller is still there, and the service exits 0. A job still running after 300 s is abandoned: its connection is closed, the log names the escrows that the state directory holds for the janitor of the next start, and the service exits 1. The container is killed when its grace period ends, so the grace period (`stop_grace_period` in a compose file) must be 330 s: the 300 s of the wait and 30 s more, for the log line and the exit code of a job that the service had to abandon. A second signal ends the process at once.

## Settings

| Variable | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `AGENT_DID` | `identity.did`, in the canonical form `did:vector:<identifier>`. It is the supplier that a purchase order must name, and the agent whose key asks for the X.509-SVID | none. Required |
| `IDENTITY_POLICY_ID` | `identity.registry_address`, the address of the identity registry derived from this policy: 56 lowercase hex characters. It must be the identity policy that the four `VECTOR_IDENTITY_` values below give, or the service stops at start | none. Required |
| `IDENTITY_ADDRESS` | the address of the identity registry. It may be left out. When it is set, it must be the address of `IDENTITY_POLICY_ID` | derived from the policy |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case. It must be live, deployed or proposed, in any case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-23` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `ADVERT_MAX_PROCESSING_MS` | `max_processing_ms` of each tier. At least 480000, because the deadline of a job assumes the 8 min window | `480000` |
| `SERVICE_AUTH_HEADER` | the `authorization` header that the runtimes send with every call, which `POST /` and `POST /precheck` require. It must be printable ASCII, for example `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required: the service stops at start without it |
| `FAULT_MODE` | the fault switch of a failure run: empty, or `confirm_wrong_lot`. Any other value stops the start. With `confirm_wrong_lot` the job orders and confirms another lot than the purchase order names. No manifest holds the value, and each result names it | empty |
| `PORT` | the port that the service listens on | `9102` |
| `HOST` | the address that the service listens on | `0.0.0.0` |
| `ORDER_DESK_STATE_DIR` | where the state is kept | `/data` |
| `LOTS_PUBLIC_ORIGIN` | the https origin of the host of the small runtime, which serves `/lots.json`. The first label of its host name ends in `-small`. The hosts of the medium and the large tier are the same name with `-medium` and `-large` in place of `-small` | none. Required |
| `SMALL_SUPPLIER_PKH` | the key hash of the supplier key of the small runtime, 56 hex characters. It is published in the tier `lot-small`, and with `AGENT_DID` it is the listed supplier key `identity.supplier_key` | none. Required |
| `SMALL_SUPPLIER_PUB_KEY_HEX` | the public key of the small runtime, 64 hex characters. The service stops at start unless its key hash is `SMALL_SUPPLIER_PKH` | none. Required |
| `MEDIUM_SUPPLIER_PKH` | the key hash of the supplier key of the medium runtime, published in the tier `lot-medium` | none. Required |
| `MEDIUM_SUPPLIER_PUB_KEY_HEX` | the public key of the medium runtime. Its key hash must be `MEDIUM_SUPPLIER_PKH` | none. Required |
| `LARGE_SUPPLIER_PKH` | the key hash of the supplier key of the large runtime, published in the tier `lot-large` | none. Required |
| `LARGE_SUPPLIER_PUB_KEY_HEX` | the public key of the large runtime. Its key hash must be `LARGE_SUPPLIER_PKH` | none. Required |
| `ORDER_DESK_SERVICE_PRIV_KEY_HEX` | the service key, 64 lowercase hex characters, a raw Ed25519 key. It pays for the model hire, signs the transactions of the dispute code and signs the request for the X.509-SVID. Never published, never logged | none. Required: the service stops at start without it |
| `ORDER_DESK_SERVICE_PKH` | optional. `keys.service_pkh` is always the key hash that the service key derives. A value here that is not that hash stops the service at start | derived |
| `VECTOR_OGMIOS_URL` | the Ogmios endpoint of the Vector node | the default of `packages/buyer-core` |
| `VECTOR_KOIOS_URL` | the Koios endpoint | the default of `packages/buyer-core` |
| `VECTOR_SUBMIT_URL` | the endpoint that takes a signed transaction | the default of `packages/buyer-core` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the model suppliers are found | the default of `packages/buyer-core` |
| `VECTOR_IDENTITY_LEGACY_ROOT` | the Merkle root of the adoption allowlist of the identity registry, 64 hex characters. One of the four deployment values of the identity registry, under the names that the MCP server reads. `packages/buyer-core` reads them | none. Required |
| `VECTOR_IDENTITY_CONFIG_SEED` | the output of the configuration seal of the identity registry, `<transaction hash>#<index>` | none. Required |
| `VECTOR_IDENTITY_ESCROW_REF_UTXO` | the reference script output of the escrow of the identity marketplace, `<transaction hash>#<index>` | none. Required |
| `VECTOR_IDENTITY_VAULT_REF_UTXO` | the reference script output of the vault, `<transaction hash>#<index>` | none. Required |
| `VECTOR_MODULE1_MANIFEST` | the https URL of the Module-1 deployment manifest, pinned to a commit: one segment of its path is the 40 lowercase hex characters of the commit, as in `https://raw.githubusercontent.com/<owner>/<repository>/<commit>/<path>`. The service fetches it one time at start, and it must name the identity registry of this deployment. A file path, an http URL, a URL with a user, a query or a fragment, and a URL that names a branch or a tag stop the start | none. Required |
| `IDENTITY_GATEWAY_URL` | the https origin of the identity gateway | `https://id.vector.apexfusion.org` |
| `MOCK_PUBLIC_BASE` | the https origin of the host of tokens of the mock service, the supplier portal | none. Required |
| `MOCK_MTLS_BASE` | the https origin of the host of the mock service that asks for a client certificate. It must be another host than `MOCK_PUBLIC_BASE` | none. Required |
| `CHECKS_READ_BUDGET_MS` | the most that one timed read of the hook may take, in milliseconds. A whole number from 500 to 1499: six reads must stay under 9000 ms | `1200` |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire for its decision, comma separated, in order of preference, each of letters, digits, dots, underscores, colons, slashes and hyphens. The manifest holds the list | none. Required |
| `LLM_MAX_PRICE_LOVELACE` | the most that a model hire may be priced at, in lovelace. The manifest holds the number | none. Required |
| `LLM_MAX_SUPPLIER_BOND_LOVELACE` | the most that the supplier bond of a model advert may be, in lovelace. A model advert with a larger supplier bond is not hired | none. Required: no limit is not an answer |
| `LLM_MAX_BUYER_BOND_LOVELACE` | the most that the buyer bond of a model advert may be, in lovelace. A model advert with a larger buyer bond is not hired | none. Required: no limit is not an answer |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE` | the stake of a challenge, in lovelace | none. Required |
| `DISPUTE_MIN_WINDOW_LEFT_MS` | the least time left in the challenge window of a claim, in milliseconds. At least 2000 | none. Required |
| `DISPUTE_READ_TIMEOUT_MS` | the most time that one read of the dispute code may take, in milliseconds | none. Required |
| `DISPUTE_RESOLUTION_DEADLINE_MS` | optional. The resolution deadline of the Module-1 deployment in milliseconds. A value that is not the deadline of the deployment stops the start | the deadline of the deployment |
| `DISPUTE_STARTED_LEASE_MS` | optional. How long an unfinished challenge keeps its job, in milliseconds. At least twice `DISPUTE_READ_TIMEOUT_MS` | 10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more |

Numbers (and `PORT`) must be non-negative integers. A value that breaks a rule stops the service at start, and the error names the variable and never shows a value that is hex-shaped or long. Each limit of the model hire is a number: the service never fills in a missing limit.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with placeholders. A test keeps the two equal, byte for byte. Change the template by changing `manifestFromEnv`, and write it again with `pnpm --filter @vsa/order-desk template`.

One manifest serves the three adverts. `terms.tiers` has one entry for each lot, and the `model` of an advert is its lot name. The lock of an advert is its price and both bonds, in lovelace:

| Tier | Price | Supplier bond | Buyer bond | Lock |
|---|---|---|---|---|
| `lot-small` | 2000000 | 1000000 | 1000000 | 4000000 |
| `lot-medium` | 5000000 | 1000000 | 1000000 | 7000000 |
| `lot-large` | 10000000 | 1000000 | 1000000 | 12000000 |

The price stands for the size of the order on the ledger. It is not the value of the goods. Each tier holds the key hash and the public key of its runtime, its endpoint and `max_processing_ms`. The endpoints come from `LOTS_PUBLIC_ORIGIN`. `identity.supplier_key` is the key of the small runtime, and `keys.service_pkh` is the key hash of the service key. `behaviour.lots` holds the address of `/lots.json` and the SHA-256 of that file, so the service serves the bytes that the manifest hashes. `behaviour.model` holds the allowlist and the price limit of the model hire. `behaviour.fault_modes` lists `confirm_wrong_lot`. The `gaps` member lists what this agent does not do and what no run shows.

The active value of the fault switch is in no manifest. At its start the service renders the manifest for each setting of the switch, and it refuses to start when the bytes change. The advert holds the SHA-256 of the bytes that `GET /agent.json` serves. Adverts are immutable, so a changed manifest means three retired adverts and three new ones. `node scripts/manifest-hash.mjs <https origin>` prints the `detail_uri` and the `detail_hash` of a running service.

## Tests

```bash
pnpm --filter @vsa/order-desk test
```

The tests need no network and no key. The identity gateway is the stub gateway of `packages/id-kit`. The ledger is a fixture world over an offline node. The model supplier and the indexer are the stubs of `packages/hire-kit`, the chain is the fake chain of `packages/buyer-core`, the supplier portal is a fake, and the Module-1 port is scripted. One fake clock runs all of them.

## Image

`Dockerfile` builds the service image on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/order-desk/Dockerfile -t vsa/order-desk:dev .`. The image runs as the `node` user under `tini`, listens on 9102 and answers `/healthz` for its health check. `/data` is a volume that `node` owns. The image has no Python, no model and no env file. It copies the service in parts: its manifest, its `tsconfig.json`, its `src` folder and its `lots.json`. So it holds no test file of the service. The memory limit is set where the container runs.

## Deploy

`deploy/server/docker-compose.order-desk.yml` runs the three runtimes and this service as four containers. The steps are in `deploy/server/RUNBOOK-order-desk.md`.

The env examples are `deploy/server/.env.order-desk.example` (the service, and the lines that the three runtimes share) and `deploy/server/.env.order-desk-runtime.example` (one copy for each runtime).

`test/deploy.test.ts` holds the five files of that pack to their rules and to the settings of this service.
