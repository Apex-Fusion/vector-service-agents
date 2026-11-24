# Insurer Intake Agent

For an insurer: takes an authorization request from the agent of a care provider, checks who sent it and that the provider's reviewer signed off exactly this request, decides whether it is complete, files it in the insurer's system and returns an intake record; it makes an intake decision and no coverage decision. Capability `health.priorauth.intake.v1`.

Status: `proposed` since 2026-11-24. The service is built. Its tests run the hook and the job against stand-ins for the chain, the marketplace, the identity gateway, the insurer portal and the model supplier, with no network. It is not deployed, and no job of it has settled. Every request is synthetic. Nothing here has been run against a real insurer. The manifest links the specification and the source.

This is the service of use case 2 (prior authorization) for an insurer. The Prior Authorization Agent of a care provider hires it. It sits behind one template runtime. The runtime holds the supplier key. It asks this service a question before it claims an escrow, and after the Claim it posts the job to this service as the body of `POST /`.

The question is `POST /precheck`, and this page calls it the hook. The hook checks who sent the request and that the reviewer of the care provider signed off exactly this request. It makes 15 checks, one after the other. The first check that fails refuses the job with its code. The escrow stays open, nothing is claimed, and nothing is paid. The checks read the ledger and the gateway as they are at that moment. When every check passes, the hook keeps the record of the checks for 300 s and reserves the job slot for that escrow for 120 s.

After the Claim, the job takes the record of the hook by its escrow reference. It compares the hash of its own body with the hash that the hook checked. It gets a JWT-SVID for the service key from the identity gateway, and it reads the requirements of the insurer portal for the service code of the request. It reports three attestations of the sender: provenance, software and principal binding. Each is `valid`, `invalid`, `absent` or `unreadable`. The sender's organisation and its provenance, software and principal-binding attestations are reported, not required. The report does not check the digest of the principal-binding attestation, because the salt and the document stay with the hirer. A source that cannot be read is reported as unreadable and never as absent. The report never refuses the job and never reaches the model.

The job then asks one model supplier whether the request meets the requirements. The model decides completeness. Nothing in this agent overrides it. The service hires that model on the Vector marketplace through a bonded escrow that it posts with its service key. Then the job files the request in the insurer portal with the status `complete` or `incomplete`, writes the intake book, and answers with the intake record. An intake record is not a coverage decision. A job with no record of passed checks for its own body fails closed: it files nothing and answers `precheck_missing`.

The service holds one key: the service key. It pays for the model hire, signs the transactions of the dispute code, and signs the request for the JWT-SVID. The supplier key belongs to the runtime. The service holds its key hash and its public key only. The service never publishes a private key.

When the sign-off is for another request than the one in the handoff (`approval_digest_mismatch`), the hook refuses first. Then it starts a challenge in the background against the open claim of the sender: the service publishes an evidence document and a challenge on the ledger. The answer to the runtime never waits for the challenge and never holds a reference to it. A request refused is not paid, and leaves no signed record of the refusal except, on a digest mismatch, the evidence of the challenge.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its settings when it starts, and it serves those bytes at `GET /agent.json`. It never serves the template. The advert holds the SHA-256 of those bytes. The placeholders `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>` and `<INTAKE_SERVICE_PKH>` stand for the settings of the same name.

## Run it

The service needs Node 22 or later, one key, a node, a Koios endpoint, a submit endpoint, the identity gateway, the marketplace indexer, the mock systems and the Module-1 manifest at a pinned address. A run locks real value from the service key: the model hire posts an escrow from it, and a challenge locks a stake. Put on that key only what you mean to commit. Write the settings in an env file with the names of the table below, but not the two secrets. Then:

```bash
pnpm install
set -a; . /path/to/insurer-intake.env; set +a                                 # the settings of the table below, but not the two secrets
read -rs INTAKE_SERVICE_PRIV_KEY_HEX && export INTAKE_SERVICE_PRIV_KEY_HEX   # the service key, typed at a silent prompt: a key on a command line stays in the history of the shell
export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"                   # the token that the runtime must send, made by openssl
mkdir -p /tmp/insurer-intake-state                                            # where the intake book, the journal of the challenges and the stranded escrows are kept
INTAKE_STATE_DIR=/tmp/insurer-intake-state PORT=9104 pnpm --filter @vsa/insurer-intake-agent start
```

The service reads the settings of the table below and no others. It listens on `PORT` (default 9104). It keeps `requests.json`, `dispute/` and `keys/<key hash>/` in `INTAKE_STATE_DIR` (default `/data`, the volume of the image). A run outside the image sets `INTAKE_STATE_DIR` to a folder that the user can write. `FAULT_MODE` must be empty: the agent has no fault value. `CHECKS_READ_BUDGET_MS` is from 500 to 1499 (default 1200). `pnpm --filter @vsa/insurer-intake-agent template` writes `agent.json.template` again from the manifest code, and a test keeps the file equal to what the command writes.

The service logs one `listening` line. It holds the address and the port, the address of the service key and the state directory. The address of the service key pays for the model hire and for a challenge, so it needs funds. The service stops at start, with the variable named and the value never shown, when a required setting is not set, when a setting is not well formed, when `INTAKE_SERVICE_PKH` is not the key hash of the service key, when the service key is the supplier key, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`, when `FAULT_MODE` is not empty, when `CHECKS_READ_BUDGET_MS` is not from 500 to 1499, when `ADVERT_MAX_PROCESSING_MS` is below 480000, when the key or the token stands in the wrong line, when `VECTOR_OGMIOS_URL` is not an https address, when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit, and when `IDENTITY_POLICY_ID` is not the policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give. It also stops when the Module-1 manifest cannot be fetched, when the Module-1 manifest names another identity registry, when `DISPUTE_RESOLUTION_DEADLINE_MS` is not the deadline of the deployment, and when the state directory cannot be written. A start that stops prints `[insurer-intake-agent] cannot start: <message>` on stderr and exits 1. Nothing keeps running then.

At start the service makes one fetch: the Module-1 manifest, from its pinned address. The fetch has a limit of 20 s. `VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters, the commit that the manifest was published at. A file path, an `http://` address, an address with a user, a query or a fragment, and an address with no commit stop the start. The manifest must name the identity registry of this deployment. The service reads no wallet at start: it derives the key hash of the paying key from the key. After the start the service calls a third party for the hook, for a job, for a challenge, and for the janitor, which reads the ledger for the escrows that a run left behind.

A secret in the wrong line of an env file is the mistake that the start guards against. The service key is looked for in every other setting that the service reads, in its hex form and in its bech32 form, in any case, and inside a longer value too. The token (`SERVICE_AUTH_HEADER`) is looked for in the same way, whole and by its credential (the part after `Bearer `), when it has 16 characters or more. A hit stops the start. The message names the variable and never shows the value. The manifest is searched for both secrets once more before the service listens.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs. It needs no token |
| `GET /agent.json` | the manifest, the bytes rendered at start. It needs no token |
| `POST /precheck` | the hook: the token, the body of a job and the six context headers. A go is 200 `{"go":true,"reserved_ms":120000}`. A refusal is `{"error":"<code>","message":"<words>"}` with its status |
| `POST /` | the job: the wire message and the six context headers, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| any other route | 404 `{"error":"not_found"}` |

`GET /healthz` and `GET /agent.json` are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. The service has no other route.

The body of `POST /` and of `POST /precheck` is the wire message: a one-element array whose `content` is the request JSON as a string, and whose `role` is `user`. It is read up to 1000000 bytes. The request JSON is the handoff of use case 2 (prior authorization): `{ "schema": "vector.usecase.handoff.v1", "use_case": "prior-authorization", "sender_did": "...", "delegation": "...", "document": { ... }, "salt": "...", "approval": { "attestation": "...", "issuer_did": "..." } }`. The `document` is an authorization request (`vector.usecase.priorauth-request.v1`). The manifest publishes this schema under `interface.request_schema`. A member that the schema does not list is refused. A handoff for another use case, and a document that is not an authorization request, are `bad_shape` (400) on both routes, before the hook.

The manifest publishes the limit of the request under `terms.input_limits.request_bytes`: 900000 bytes of wire payload. The wire payload is the wire message above, counted in bytes of UTF-8, so each quote mark and each backslash of the request JSON counts two bytes. The service itself does not count this limit: it refuses a body only above 1000000 bytes, with `request_too_large` (400). A buyer that uses the kit of this repository checks the limit of 900000 bytes before it pays. The buyer then writes the wire payload again inside a second JSON object for the runtime, and each quote mark and each backslash of the wire payload gets one more byte there. The runtime takes at most 1048576 bytes of body. So the limit of 900000 bytes is safe only while the escaped body stays below 1048576 bytes, and the sender keeps its body under that limit.

The runtime sends six headers of the context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. The hook needs all six. The job needs them too: a call with none, with some, or with a bad one gets 400 `bad_context`. The advert comes from these headers and never from the body.

`POST /` and `POST /precheck` require the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`, the value that the runtime sends with every call. A call without it, or with another value, gets 401 `{"error":"unauthorized"}`, with no detail, before the body is read and before the job slot is taken. The values are compared in constant time. The other routes need no header: the health check of the image sends none, and the manifest is public.

The hook makes the 15 checks of the intake record in this order: `sender_active`, `sender_accountable`, `sender_key`, `delegation`, `delegation_usable`, `vault_paid`, `approval_found`, `approval_type`, `approval_subject`, `approval_issuer`, `approval_valid`, `approval_digest`, `for_this_insurer`, `advert` and `not_duplicate`. The first 12 are the shared checks of use case 2: the sender, the delegation, the payment from a vault of that delegation, and the sign-off of the provider's reviewer for this exact request. The last three are the checks of the Insurer Intake Agent:

| Check | Refusal code | The rule |
|---|---|---|
| `for_this_insurer` | `not_for_this_insurer` | the request names this agent (`AGENT_DID`) as its insurer |
| `advert` | `advert_mismatch` | the advert of the request is the advert that the escrow was posted on |
| `not_duplicate` | `duplicate_request` | the intake book holds no entry for the tenant and the request number. A number counts without regard to case |

A source that the hook cannot read (the identity gateway, the ledger or the intake book) is never a pass: the hook answers 503 `check_unavailable`.

One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message in the same two cases. A go of the hook reserves the slot for its escrow for 120000 ms, and the job for that escrow takes the reservation. While a job runs, the server writes an interim `102 Processing` line every 60 s to a client that speaks HTTP/1.1, ahead of the answer. The reason is that the fetch of the runtime gives up after 300 s of silence.

The runtime waits 10000 ms for the hook, and reads silence as a refusal. The hook makes 6 timed reads, one after the other: the identity gateway once and the ledger five times. Each read ends inside `CHECKS_READ_BUDGET_MS`. Six times the largest budget that the service accepts is under 9000 ms, so the answer of the hook comes inside the wait of the runtime.

A job has its own deadline, 300000 ms after its request arrives. The runtime waits 60 s longer (its `SERVICE_TIMEOUT_MS` is 360000), and the window of the advert is 480000 ms at least. One call to the insurer portal takes 20000 ms at most. The job files no entry when that call could end less than 30 s before `deliver_by`, and the model hire ends at the deadline of the job at the latest, and never later than the time that the filing needs after it. The report of the attestations has 45000 ms at most for the whole report and 15000 ms for one read. A kind that the budget cuts off is reported `unreadable`.

A job whose caller hangs up before the decision, or before the filing call, is stopped there with `deadline`: the service never hires a model or files an entry that nobody will read. A hang-up during the filing call, or after it, does not stop the job: it books the entry, and its log says that the caller hung up. The answer to a job is the intake record. Its last member is `fault_mode`, which is the empty text.

## Errors

A refusal is `{"error": "<code>", "message": "<words>"}` with the status in the table. The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log, by its message only. A refusal of status 500 or more gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer and the detail is the operator's. `shutting_down` has the fixed message `The service is stopping and takes no new job. Try again shortly.`, and the 409 `busy` of the hook has the fixed message `The service is working on another job. Try again shortly.`.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that is not a handoff of use case 2 with an authorization request), `bad_context` (the six headers of the context are missing, some are missing, or one is not well formed) |
| 401, the caller | `unauthorized` (no message) |
| 403, the hook, before the Claim | `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `approval_not_found`, `approval_wrong_type`, `approval_wrong_subject`, `approval_wrong_issuer`, `approval_revoked`, `approval_expired`, `approval_issuer_invalid`, `approval_digest_mismatch`, `not_for_this_insurer`, `advert_mismatch`, `duplicate_request` |
| 403, the job, after the Claim | `duplicate_request` (the insurer portal holds an entry for the request number already) |
| 404, no such route | `not_found` (no message) |
| 409, the service is busy | `busy` (a job runs, or the slot is reserved for another escrow. The answer to a job has no message, and the answer of the hook has one) |
| 422, the job | `deadline` (the caller hung up before the decision or the filing call, or too little time was left to file the request) |
| 500, the service | `precheck_missing` (the job has no record of passed checks for its body), `store_write_failed` (the intake book or the record of the model hire cannot be written. When the intake book fails, the portal holds the entry), `internal` (a fault of the service: a plain 500 with no message when nothing names it, and the fixed message when the job names it) |
| 502, a third party | `svid_failed` (the identity gateway gave no JWT-SVID), `mock_system_failed` (the insurer portal did not take the call. After a call that was sent, the entry may exist at the portal), `inference_failed` (the model hire failed), `model_output_invalid` (the answer of the model cannot be used) |
| 503, the service cannot answer now | `check_unavailable` (the hook could not read a source), `shutting_down` (the service is stopping) |

A counterparty answers 200 only when it did the work: the 200 answer is the intake record. Every code of the table is a refusal or a failure. The Prior Authorization Agent, which hires this service, turns a refusal or a failure into its own `reason`, and answers its hirer with a 200 result.

A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow claimed. The sender reclaims it after the deadline, and nothing is paid for work that was not done. A job that fails before the filing call files no entry. A job that fails after the filing call can leave an entry at the portal with no entry in the intake book. That happens with `mock_system_failed` after a call that was sent, and with `store_write_failed` of the intake book. The log says so. When the portal holds the entry, a later job for the same request number passes the check `not_duplicate`, and the portal then refuses its entry: that job ends with `duplicate_request` (403) after the Claim.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, stops its janitor, and waits up to 300 s for the job that is running to end. A job that ends in time is answered, if its caller is still there, and the service exits 0. A job still running after 300 s is abandoned: its connection is closed, the log names the escrows that the state directory holds for the janitor of the next start, and the service exits 1. The janitor of the service key runs every 60 s. A stop waits at most 30 s for a pass of the janitor that is in flight, and abandons that pass, with a log line. The container is killed when its grace period ends, so the grace period (`stop_grace_period` in a compose file) must be 330 s: the 300 s of the wait and 30 s more. A start that fails prints `[insurer-intake-agent] cannot start: <message>` on stderr and exits 1.

Stop or restart the service only when the runtime in front of it says `free` at its `/status`. The word `working` means that a job runs. A stop while a job runs abandons that job when the wait is over.

## State

`INTAKE_STATE_DIR` holds the records that outlive the process.

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the escrows that a model hire posted and did not settle: references, times and transaction hashes, never a request or a requirement. The janitor of the service key settles them when their time has come, every 60 s |
| `dispute/` | the journal of the dispute code: one file for each escrow job, so one escrow has at most one challenge |
| `requests.json` | the intake book: the tenant, the request number and the intake id of each request that the service filed. It holds at most 10000 entries and never drops one |

A book that holds 10000 entries cannot take a new entry. For a request number that the book does not hold, the hook answers 503 `check_unavailable` and the escrow stays open. For a number that the book holds, the hook still answers 403 `duplicate_request`. The book reads its file at each call. A file that is missing or damaged after the start makes the hook answer 503 `check_unavailable`, and it never reads as an empty book.

The service key has one queue. The model hire, and the claims and the challenges of the dispute code, run one after the other in it, so no two of them build a transaction from one wallet together. A stranded file that is not a list stops the start and is left as it is, because starting without it would forget escrows that still hold a lock. The record of the checks that the hook keeps for a job is in memory only. It lives 300 s, and the store holds 64 of them at most. A restart forgets them, and a job that arrives after a restart fails closed with `precheck_missing`.

## Settings

A setting that breaks a rule stops the service at start, and the message names the setting and never shows a secret. A setting with no default is required. A number is a whole number written in digits. The limits of the model hire have no default, so a service never runs with a limit that nobody chose.

| Setting | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact`: one line of at most 200 characters, with no control character | none. Required |
| `AGENT_DID` | `identity.did`, in the form `did:vector:` and 64 lowercase hex characters. It is the insurer that a request must name, and the agent whose service key asks for the JWT-SVID | none. Required |
| `IDENTITY_POLICY_ID` | the identity registry that the manifest names: 56 lowercase hex characters. It must be the policy that `VECTOR_IDENTITY_LEGACY_ROOT` and `VECTOR_IDENTITY_CONFIG_SEED` give, or the start stops | none. Required |
| `IDENTITY_ADDRESS` | `identity.registry_address`. When it is set, it must be the address of `IDENTITY_POLICY_ID` | derived from the policy |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case. It must be live, deployed or proposed, in any case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-24` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert`, an https address with no user and no password | empty |
| `SERVICE_AUTH_HEADER` | the `authorization` header that the runtime sends with every call, which `POST /` and `POST /precheck` require. It must be printable ASCII, for example `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required |
| `FAULT_MODE` | the fault switch of a failure run. This agent has no fault value, so the setting must be empty. Any other value stops the start. The manifest lists no value, and each result names the empty setting in `fault_mode` | empty |
| `PORT`, `HOST` | where the service listens. `PORT` is a whole number from 0 to 65535 | `9104`, `0.0.0.0` |
| `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL`, `VECTOR_SUBMIT_URL` | the chain endpoints, which `packages/buyer-core` reads. `VECTOR_OGMIOS_URL` must be an `https://` address, because the tip reader of the janitor takes https only | the default of `packages/buyer-core` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the model suppliers are found | the default of `packages/buyer-core` |
| `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO` | the deployment values of the identity registry, of its escrow and of the vault, under the names that `packages/buyer-core` reads. The service reads a payment from a vault, so it needs the reference of the vault too | none. Required |
| `VECTOR_MODULE1_MANIFEST` | the https URL of the Module-1 deployment manifest, pinned to a commit. The service fetches it one time at start, and it must name the identity registry of this deployment | none. Required |
| `IDENTITY_GATEWAY_URL` | the identity gateway, an https origin | `https://id.vector.apexfusion.org` |
| `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE` | the two https origins of the mock service, on two hosts: the host of tokens and of the insurer portal, and the host that asks for a client certificate. The service calls the insurer portal on the first, and the call code of the kit takes both | none. Required |
| `CHECKS_READ_BUDGET_MS` | the most that one timed read of the hook may take, in milliseconds. A whole number from 500 to 1499: six reads must stay under 9000 ms | `1200` |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire for its decision, comma separated, in order of preference, each of letters, digits, dots, underscores, colons, slashes and hyphens. The manifest holds the list | none. Required |
| `LLM_MAX_PRICE_LOVELACE` | the most that the model hire may be priced at, in lovelace: a whole number of more than 0. The manifest holds the number | none. Required |
| `LLM_MAX_SUPPLIER_BOND_LOVELACE`, `LLM_MAX_BUYER_BOND_LOVELACE` | the most that the supplier bond and the buyer bond of a model advert may be, in lovelace, each a whole number of more than 0. A model advert with a larger bond is not hired. The service never fills in a missing limit | none. Required |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE` | the stake of a challenge, in lovelace | none. Required |
| `DISPUTE_MIN_WINDOW_LEFT_MS` | the least time left in the challenge window of a claim, in milliseconds. At least 2000 | none. Required |
| `DISPUTE_READ_TIMEOUT_MS` | the most time that one read of the dispute code may take, in milliseconds | none. Required |
| `DISPUTE_STARTED_LEASE_MS` | optional. How long a challenge that did not finish keeps its job, in milliseconds. At least twice `DISPUTE_READ_TIMEOUT_MS` | 10 min, or twice `DISPUTE_READ_TIMEOUT_MS` when that is more |
| `DISPUTE_RESOLUTION_DEADLINE_MS` | optional. The resolution deadline of the Module-1 deployment, in milliseconds. A value that is not the deadline of the deployment stops the start | the deadline of the deployment |
| `INTAKE_STATE_DIR` | where the records of the State section are kept: an absolute path | `/data` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace`: a whole number of lovelace, more than 0 and at most 9998000000 | `2000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms`. From 480000 to 86400000. The least value is the window that the deadline of a job assumes | `480000` |
| `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` | `keys.supplier_pkh` and `keys.pub_key_hex`: the hash and the public key of the supplier key. The service stops at start unless the public key has this hash. The supplier key is the key of the runtime: the service never holds it and never signs with it | none. Required |
| `INTAKE_SERVICE_PRIV_KEY_HEX`, `INTAKE_SERVICE_PKH` | the service key, 64 lowercase hex characters, a raw Ed25519 key, and its key hash. The key pays for the model hire, signs the transactions of the dispute code and signs the request for the JWT-SVID. Never published, never logged. Its key hash is `keys.buyer_pkh` | none. The key is required; the key hash is derived when it is not set |

A key is 64 lowercase hex characters, read from the env file and from nowhere else. `INTAKE_SERVICE_PKH` is optional. When it is set, it must be the key hash of the service key, and the service stops at start when it is not. The terms are fixed: the price is `ADVERT_PRICE_LOVELACE`, each bond is 1000000 lovelace, and the lock is 4000000 lovelace for the default price. The lock is the price and both bonds.

## What this does not show

The tests do not reach a chain. They show that the service starts from a complete environment, that it renders a stable manifest, that the hook refuses with the code of the check that failed, and that the job does its steps in order against stand-ins. They do not show everything that the manifest names: no run covers the refund of the escrow of a revoked agent, a relying party that refuses a live token after its authority ended, or the challenge of the Prior Authorization Agent against this agent (this agent has no fault value). Tests alone cover the last two.

## Tests

```bash
pnpm --filter @vsa/insurer-intake-agent test
```

The tests need no network and no key. The folders `test/store`, `test/checks`, `test/report`, `test/job` and `test/serve` hold the tests of the parts of the agent: the intake book and the record of passed checks, the hook, the report of the attestations, the job, and the settings, the keys, the manifest, the wiring, the server and the start. The start tests run `src/index.ts` as a process, with `test/serve/module1-preload.mjs` in front of the fetch of the Module-1 manifest. `test/dockerfile.test.ts` and `test/readme.test.ts` keep the image file and this page to the code.

## Image

`Dockerfile` builds the service image in two stages on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/insurer-intake-agent/Dockerfile -t vsa/insurer-intake-agent:dev .`. The image runs as the `node` user under `tini`, listens on 9104 and answers `/healthz` every 20 s for its health check. `/data` is a volume that `node` owns. The image has no Python, no model and no env file. The Dockerfile copies the service in parts: its manifest, its `tsconfig.json` and its `src` folder. The build context leaves out every folder named `test`, every env file and every `node_modules`, so the image holds no test file. At start it fetches one file, the Module-1 manifest at its pinned address. At run time it fetches only what the hook reads of the identity gateway and the ledger, what a job asks of the identity gateway, the insurer portal, the ledger and a model supplier, and what the janitor reads of the ledger. The memory limit is set where the container runs.

## Deploy

`deploy/server/docker-compose.insurer-intake-agent.yml` runs the runtime and this service as two containers.
`deploy/server/.env.insurer-intake-agent.example` is the env example of the service and of its runtime.
`deploy/server/RUNBOOK-insurer-intake-agent.md` holds the steps of the deploy.
