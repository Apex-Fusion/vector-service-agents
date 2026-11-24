# Prior Authorization Agent

For a care provider: reads the records behind a clinical order, drafts an insurer-format authorization request with its justification, and, once the provider's reviewer has signed off, submits exactly that request to the insurer's intake agent. Capability `health.priorauth.draft.v1`.

Status: `proposed` since 2026-11-24. The service is built. Its tests run both jobs against stand-ins for the chain, the marketplace, the identity gateway, the mock systems and the model supplier, with no network. It is not deployed, and no job of it has settled. Every record is synthetic. Nothing here has been run against a real records system or a real insurer. The manifest links the specification and the source.

This is the service of use case 2 (prior authorization). It sits behind the template runtime. The runtime holds the supplier key, claims the escrow of the hirer, and posts the job to this service as the body of `POST /`. The job is `propose` or `execute`. `propose` reads the clinical order and its records through the subagent `record-reader`, and then the guideline of its service through the subagent `drafter`. Each subagent has its own keys, its own token and its own sub-delegation, and the two reads run one after the other. `propose` asks a model supplier on the marketplace for a justification, and it answers with an authorization request, its salt and its digest. It writes nothing to the records system and pays the intake agent nothing. `execute` takes that proposal and the reference of the sign-off of the hirer. It pays the intake agent of the insurer from the vault of the hirer, checks the intake record that comes back, asks a model supplier whether to accept it, and writes the submission to the records system. This agent does not check the sign-off of the hirer. The Insurer Intake Agent does. The service holds seven keys and pays from three of them. It never publishes a private key.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts, and it serves those bytes at `GET /agent.json`. It never serves the template. The placeholders `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>`, `<PRIORAUTH_SERVICE_PKH>`, `<PRIORAUTH_DELEGATION_1_PKH>` and `<PRIORAUTH_DELEGATION_2_PKH>` stand for the settings of the same name.

## Run it

The service needs Node 22 or later, seven keys, a node, a Koios endpoint, a submit endpoint, the identity gateway, the marketplace indexer, the mock systems and the Module-1 manifest at a pinned address. A run locks real value from the keys. Put on them only what you mean to commit. Write the settings in an env file with the names of the table below, then:

```bash
pnpm install
set -a; . /path/to/prior-authorization.env; set +a
pnpm --filter @vsa/prior-authorization-agent start
```

`PRIORAUTH_STATE_DIR` is `/data` unless the env file sets it, and `/data` is the volume of the image. A run outside the image sets it to a folder that the user can write. `pnpm --filter @vsa/prior-authorization-agent template` writes `agent.json.template` again from the manifest code, and a test keeps the file equal to what the command writes.

The service logs one `listening` line. It holds the hash of the manifest, the three addresses of the paying wallets and the state directory. It stops at start, with the variable named and the value never shown, when a required setting is not set, when a setting is not well formed, when a `..._PKH` is not the key hash of its key, when two keys are one key, when a key is the supplier key, when `FAULT_MODE` is not empty and is not `alter_after_approval`, when a key or the token stands in the wrong line, when `VECTOR_OGMIOS_URL` is not an https address, when `VECTOR_MODULE1_MANIFEST` is not an https address pinned to a commit, and when `IDENTITY_POLICY_ID` is not the policy that the four identity values give. It also stops when the Module-1 manifest names another identity registry, when the node gives no start time of the chain, and when the state directory cannot be written.

At start the service fetches one file, the Module-1 manifest, and it asks the node for the start time of the chain. `VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters, the commit that the manifest was published at. A file path, an `http://` address, an address with a user, a query or a fragment, and an address with no commit stop the start. The manifest must name the identity registry of this deployment. A manifest of another registry, from a wrong commit, stops the start, and the message shows no hash. The service reads no wallet at start: it derives the key hash of each paying key from the key.

A secret in the wrong line of an env file is the mistake that the start guards against. Each of the seven keys is looked for in every other setting, in its hex form and in its bech32 form, in any case, and inside a longer value too. The token is looked for in the same way, whole and by its credential, when it has 16 characters or more. The manifest is searched for each secret too. A hit stops the start. The message names the variable and never shows the value.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs |
| `GET /agent.json` | the manifest, the bytes rendered at start |
| `POST /` | the wire message, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| `POST /precheck` | the question that the runtime asks before it claims an escrow. The agent has no check of its own for it, so the shared server answers go when the job slot is free, and it reserves the slot for the escrow of the call for 120 s |
| `POST /cosign/delegate` | the co-sign route: no token, no job slot. It signs one Delegate for a principal key that the allowlist names |
| any other route | 404 `{"error":"not_found"}` |

The body of `POST /` and of `POST /precheck` is the wire message: a one-element array whose `content` is the request JSON as a string. It is read up to 1000000 bytes. The request JSON is read up to 900000 bytes, and it is one of the two operations. The manifest publishes its schema under `interface.request_schema`. A member that the schema does not list is refused. The limit of 900000 bytes bounds the wire payload and nothing else. A sender writes the payload again inside a second JSON object, and each quote mark and each backslash of the payload gets one more byte. The runtime takes at most 1048576 bytes of body. So the limit of 900000 bytes is safe only while the escaped body stays below 1048576 bytes, and the sender keeps its body under that limit. Each result carries the member `fault_mode`, which is the empty text unless `FAULT_MODE` is set.

One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. While a job runs, the server writes a `102 Processing` line every 60 s to a client that speaks HTTP/1.1, so that the fetch of the runtime does not give up on the silence. A job has its own deadline of 1620000 ms after its request arrives. That is 60 s inside the `SERVICE_TIMEOUT_MS` of the runtime, 1680000 ms. The window of the advert, `ADVERT_MAX_PROCESSING_MS`, is 1800000 ms at least.

A job whose caller hangs up is stopped. `propose` stops before its next step and still ends its sub-delegation. `execute` looks at the signal one time, before the hire, and never gives it to the hire: a hire that has paid is carried to its end. The log names the job as abandoned.

The log has one line for each job: the operation, the time it took, the outcome, the reason, the exit and the number of decisions. The log carries job outcomes, counts and codes, never a record, a justification, a request or a key.

## Errors

A call that the service refuses has the body `{"error": "<code>", "message": "<words>"}`, with the status of the first table. Four answers carry the code only, with no message: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a message. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over the limit), `bad_shape` (a request that breaks a rule of the intake), `bad_context` (a call to `POST /precheck` with a missing or wrong context header, or a call to `POST /` with some of the six context headers or a wrong one), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 503 | `shutting_down` (the service is stopping) |
| 500 | `internal` |

The codes and their statuses are `ERROR_STATUS` in `packages/usecase-kit/src/protocol`, except the codes that the shared server answers itself. A job that the service runs and that does not end well is no HTTP error. It is a 200 result with an `outcome` and a `reason` code. The status of such a result is 200 whatever its reason. The table of the reasons is in the page of the agent, with the job that writes each one. This README lists none.

The co-sign route has its own codes:

| Status | Codes |
|---|---|
| 400 | `not_a_delegation`, `not_for_this_agent`, `expired`, `bad_shape`, `request_too_large` |
| 403 | `principal_not_allowed`, `spends_agent_funds` |
| 409 | `key_in_use`, `busy` |
| 415 | `unsupported_media_type` |
| 503 | `check_unavailable` |
| 500 | `internal` |

The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does.

## Stopping

On SIGTERM (`docker stop` sends it) or SIGINT the service takes no new job and no new connection, stops its janitors, and waits up to 300 s for the job that is running to end. A pass of a janitor that is still in flight after 30 s is abandoned, with a log line. A job that ends in time is answered, if its caller is still there, and the service exits 0. A job still running after 300 s is abandoned: its connection is closed, the log names the escrows that the state directory holds for the janitors of the next start, and the service exits 1. The container is killed when its grace period ends, so the grace period (`stop_grace_period` in a compose file) must be 330 s: the 300 s of the wait and 30 s more.

Stop or restart the service only when the runtime in front of it says `free` at its `/status`. The word `working` means that a job runs. A stop while a job runs abandons that job when the wait is over.

## State

`PRIORAUTH_STATE_DIR` holds the records that outlive the process.

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the escrows that a paying key posted and did not settle: one file for each of the service key and the two delegation keys. The janitor of the key reclaims them after their `deliver_by`, every 60 s |
| `dispute/` | the journal of the challenges |
| `left/` | the sub-delegations that a read left behind. Their janitor ends them, every 60 s |
| `cosign-register.json` | the register of the keys in use by a co-signed delegation, so a restart still answers `key_in_use` |
| `request-numbers.json` | the counter of request numbers, one for each tenant. A number is stored before a job uses it |

The three paying keys each have one lane. For the service key, the lane runs the model hires and the claims and the challenges of the dispute code. For each delegation key, it runs the vault Pay and the Accept of a hire, the Delegate and the Undelegate of a sub-delegation, and the janitor of the left sub-delegations. So no two of them spend one output. The four subagent keys pay nothing and have no file here.

## Settings

A value that breaks a rule stops the service at start, and the message names the variable. A setting with no default is required. A number of lovelace is a whole number of digits, more than 0. The limits of the two kinds of hire and of the model have no default, so a service never runs with a limit that nobody chose.

| Setting | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact`: one line of at most 200 characters, with no control character | none. Required |
| `AGENT_DID` | `identity.did`, in the form `did:vector:` and 64 lowercase hex characters. It is the delegate that the delegation of a hirer names | none. Required |
| `RECORD_READER_DID`, `DRAFTER_DID` | the DIDs of the two subagents, `record-reader` and `drafter`. The agent and its two subagents are three agents, so the three DIDs differ | none. Required |
| `IDENTITY_POLICY_ID` | the identity registry that the manifest names: 56 lowercase hex characters. It must be the policy that the four `VECTOR_IDENTITY_` values give, or the start stops | none. Required |
| `IDENTITY_ADDRESS` | `identity.registry_address`. When it is set, it must be the address of `IDENTITY_POLICY_ID` | derived from the policy |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case. It must be live, deployed or proposed, in any case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-24` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert`, an https address with no user and no password | empty |
| `SERVICE_AUTH_HEADER` | the `authorization` header that the runtime sends with every call, which `POST /` and `POST /precheck` require. It must be printable ASCII, for example `Bearer ` and 64 hex characters, made with `openssl rand -hex 32`. Never published, never logged | none. Required |
| `FAULT_MODE` | the fault switch of a failure run: empty, or `alter_after_approval`. Any other value stops the start. With `alter_after_approval`, `execute` changes the last sentence of the justification after it checked the digest, so the intake agent gets a request that the hirer did not approve. The manifest lists the value and never says which one is active. Each result names the active value in `fault_mode` | empty |
| `PORT`, `HOST` | where the service listens | `9103`, `0.0.0.0` |
| `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL`, `VECTOR_SUBMIT_URL` | the chain endpoints, which `packages/buyer-core` reads. `VECTOR_OGMIOS_URL` must be an `https://` address, because the tip reader of the janitor takes https only | the default of `packages/buyer-core` |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the model suppliers and the insurer are found | the default of `packages/buyer-core` |
| `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO` | the deployment values of the identity registry, of its escrow and of the vault, under the names that `packages/buyer-core` reads | none. Required |
| `VECTOR_MODULE1_MANIFEST` | the https URL of the Module-1 deployment manifest, pinned to a commit. The service fetches it one time at start, and it must name the identity registry of this deployment | none. Required |
| `IDENTITY_GATEWAY_URL` | the identity gateway, an https origin | `https://id.vector.apexfusion.org` |
| `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE` | the two https origins of the mock systems, on two hosts: the host of tokens and the host that asks for a client certificate | none. Required |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire for its two decisions, comma separated, in order of preference. The manifest holds the list | none. Required |
| `LLM_MAX_PRICE_LOVELACE`, `LLM_MAX_SUPPLIER_BOND_LOVELACE`, `LLM_MAX_BUYER_BOND_LOVELACE` | the most that a model job may cost, and the most of each bond of its advert, in lovelace. A model advert above a limit is not hired. The three add up to at most 10000000000 lovelace, the value cap of an escrow | none. Required |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE` | the stake of a challenge, in lovelace | none. Required |
| `DISPUTE_MIN_WINDOW_LEFT_MS` | the least time left in the challenge window of a claim, in milliseconds. At least 2000 | none. Required |
| `DISPUTE_READ_TIMEOUT_MS` | the most time that one read of the dispute code may take, in milliseconds | none. Required |
| `DISPUTE_STARTED_LEASE_MS` | optional. How long a challenge that did not finish keeps its job, in milliseconds. At least twice `DISPUTE_READ_TIMEOUT_MS` | the dispute code decides |
| `DISPUTE_RESOLUTION_DEADLINE_MS` | optional. The resolution deadline of the Module-1 deployment, in milliseconds. A value that is not the deadline of the deployment stops the start | the dispute code decides |
| `PRIORAUTH_STATE_DIR` | where the records of the State section are kept: an absolute path | `/data` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace`: a whole number of lovelace, more than 0 and at most 9998000000 | `3000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms`. From 1800000 to 86400000. The least value is the window that the deadline of a job assumes | `1800000` |
| `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` | `keys.supplier_pkh` and `keys.pub_key_hex`: the hash and the public key of the supplier key. The service stops at start unless the public key has this hash. The supplier key is the key of the runtime: the service never holds it and never signs with it | none. Required |
| `HANDOFF_MAX_PRICE_LOVELACE`, `HANDOFF_MAX_SUPPLIER_BOND_LOVELACE`, `HANDOFF_MAX_BUYER_BOND_LOVELACE` | the most that the hire of the Insurer Intake Agent may cost, and the most of each bond of its advert, in lovelace. The three add up to at most 10000000000 lovelace | none. Required |
| `COSIGN_ALLOWLIST` | the principals for whom the co-sign route signs: key hashes of 56 lowercase hex characters, separated by white space or commas. A `#` starts a note that runs to the end of the line. The empty text holds nobody. The setting must be there | none. Required |
| `COSIGN_MAX_CONCURRENT`, `COSIGN_MAX_FUTURE_MS`, `COSIGN_LEDGER_TIMEOUT_MS` | the limits of the co-sign route: the requests that it works on at one time, how far ahead the end of the validity window of a transaction may be, and how long one read of the ledger may take, in milliseconds | `4`, `3600000`, `5000` |
| `PRIORAUTH_SERVICE_PRIV_KEY_HEX`, `PRIORAUTH_SERVICE_PKH` | the service key, 64 lowercase hex characters, a raw Ed25519 key, and its key hash. It pays the model hires, signs the claims and the challenges of the dispute code, and signs the subject token of the agent. Never published, never logged. For this key, its key hash is `keys.buyer_pkh` | none. The key is required; the key hash is derived when it is not set |
| `PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX`, `PRIORAUTH_DELEGATION_1_PKH` | the first delegation key and its key hash. A delegation of a hirer names one of the two delegation keys, and that key signs the vault Pay, the Accept and the sub-delegations of the delegation. Its key hash is in `keys.delegation_pkhs` | none. The key is required; the key hash is derived when it is not set |
| `PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX`, `PRIORAUTH_DELEGATION_2_PKH` | the second delegation key and its key hash. Its key hash is in `keys.delegation_pkhs` | none. The key is required; the key hash is derived when it is not set |
| `RECORD_READER_AUTH_PRIV_KEY_HEX`, `RECORD_READER_AUTH_PKH` | the key that signs the subject token of the subagent `record-reader`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `RECORD_READER_DELEGATION_PRIV_KEY_HEX`, `RECORD_READER_DELEGATION_PKH` | the delegate key of the sub-delegation of `record-reader`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `DRAFTER_AUTH_PRIV_KEY_HEX`, `DRAFTER_AUTH_PKH` | the key that signs the subject token of the subagent `drafter`, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `DRAFTER_DELEGATION_PRIV_KEY_HEX`, `DRAFTER_DELEGATION_PKH` | the delegate key of the sub-delegation of `drafter`, and its key hash | none. The key is required; the key hash is derived when it is not set |

A key is 64 lowercase hex characters, read from the env file and from nowhere else. A `..._PKH` is optional. When it is set, it must be the key hash of the key before it, and the service stops at start when it is not. The terms are fixed: the price is `ADVERT_PRICE_LOVELACE`, each bond is 1000000 lovelace, and the lock is 5000000 lovelace for the default price. The lock is the price and both bonds.

## What this does not show

The tests do not reach a chain. They show that the service starts from a complete environment, that it renders a stable manifest, and that each job does its steps in order against stand-ins. They do not show everything that the manifest names: no run covers the refund of the escrow of a revoked agent, a relying party that refuses a live token after its authority ended, or a challenge of this agent against the Insurer Intake Agent, because that agent has no fault value. Tests alone cover the last two.

## Tests

```bash
pnpm --filter @vsa/prior-authorization-agent test
```

The tests need no network and no key. The folders `test/model`, `test/insurer`, `test/counter`, `test/evidence`, `test/propose` and `test/execute` hold the tests of the parts of the agent. The folder `test/serve` holds the tests of the settings, the keys, the manifest, the wiring, the server and the start. The start tests run `src/index.ts` as a process, with `test/serve/child-fetch.mjs` in front of the fetch of the Module-1 manifest and of the calls to the node. `test/dockerfile.test.ts` and `test/readme.test.ts` keep the image file and this page to the code.

## Image

`Dockerfile` builds the service image in two stages on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/prior-authorization-agent/Dockerfile -t vsa/prior-authorization-agent:dev .`. The image runs as the `node` user under `tini`, listens on 9103 and answers `/healthz` every 20 s for its health check. `/data` is a volume that `node` owns. The image has no Python, no model and no env file. The Dockerfile copies the service in parts: its manifest, its `tsconfig.json` and its `src` folder. The build context leaves out every folder named `test`, every env file and every `node_modules`, so the image holds no test file. At start it fetches one file, the Module-1 manifest at its pinned address. At run time it fetches only what a job asks of the identity gateway, the mock systems, the node, the indexer, the Insurer Intake Agent and a model supplier. The memory limit is set where the container runs.

## Deploy

`deploy/server/docker-compose.prior-authorization-agent.yml` runs the runtime and this service as two containers.
`deploy/server/.env.prior-authorization-agent.example` is the env example of the service and of its runtime.
`deploy/server/RUNBOOK-prior-authorization-agent.md` holds the steps of the deploy.
