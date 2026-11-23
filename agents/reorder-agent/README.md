# Reorder Agent

For a buying organisation: reads the stock of one SKU, proposes a purchase order for one lot from a named supplier, and, once the organisation has approved the order, places it from the vault of the organisation and records it. Capability `supplychain.reorder.po.v1`.

Status: `proposed` since 2026-11-23. The service is built. Its tests run the whole path against stand-ins for the chain, the marketplace, the identity gateway, the mock systems and the model supplier, with no network. It is not deployed, and no job of it has settled. The manifest links the specification and the source.

The service sits behind the template runtime. The runtime holds the supplier key, claims the escrow of the hirer, and posts the job to this service as the body of `POST /`. The job is `propose` or `execute`. `propose` reads the stock from the mock system, asks a model supplier on the marketplace for a lot choice, and answers with a proposal. `execute` checks the approval of the organisation, hires the supplier of the lot, and writes the order. The service holds five keys and pays from three of them. It never publishes a key.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts, and it serves those bytes at `GET /agent.json`. It never serves the template. The placeholders `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>`, `<REORDER_SERVICE_PKH>`, `<REORDER_DELEGATION_1_PKH>` and `<REORDER_DELEGATION_2_PKH>` stand for the settings of the same name.

## Run it

The service needs Node 22 or later, five keys, a node, a Koios endpoint, a submit endpoint, the identity gateway, the marketplace indexer, the two mock systems and the Module-1 manifest at a pinned address. A run locks real value from the keys. Put on them only what you mean to commit. Write the settings in an env file with the names of the table below, then:

```bash
pnpm install
cd agents/reorder-agent
set -a; . /path/to/reorder.env; set +a
pnpm start
```

The service logs one `listening` line. It holds the hash of the manifest and the three addresses that pay. It stops at start, with the variable named and the value never shown, when a required setting is missing, when a setting is not well formed, when a `..._PKH` is not the hash of its key, when two keys are equal, when a key equals the supplier key, when `FAULT_MODE` is set, when a key or the token is in the wrong line, and when it cannot write to its state directory.

At start the service fetches one file, the Module-1 manifest. `VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters, the commit that the manifest was published at. A file path, an `http://` address, an address with no commit, and an address with a user, a query or a fragment stop the start. The manifest must name the identity registry of `IDENTITY_POLICY_ID`. A manifest of another registry, from a wrong commit, stops the start, and the message shows no hash. The service also asks the node for the start time of the chain, and it reads the wallet of each of its three paying keys. It calls nothing else at start.

A secret in the wrong line of an env file is the mistake that the start guards against. Each of the five keys and the token is looked for in every other setting, and in the manifest, in its raw form and its bech32 form. A hit stops the start. The message names the variable and never shows the value.

## Routes

| Route | Answer |
|---|---|
| `GET /healthz` | `{"ok":true}` while the service runs |
| `GET /agent.json` | the manifest, the bytes rendered at start |
| `POST /` | the wire message, with the `authorization` header of the runtime. Without it, 401 `{"error":"unauthorized"}` |
| `POST /precheck` | the question that the runtime asks before it claims an escrow. A go reserves the job slot for 120 s |
| `POST /cosign/delegate` | the co-sign route: no token, no job slot. It signs a sub-delegation for a buyer that the allowlist names |
| any other route | 404 `{"error":"not_found"}` |

The body of `POST /` is the wire message: a one-element array whose `content` is the request JSON as a string. It is read up to 1000000 bytes. The request JSON is read up to 900000 bytes, and it is one of the two operations. The manifest publishes its schema under `interface.request_schema`. A member that the schema does not list is refused. Each result carries the member `fault_mode`, which is always the empty text.

One job runs at a time, because the keys pay one escrow at a time. A second job gets 409 `{"error":"busy"}`. While a job runs, the server writes a `102 Processing` line every 60 s. A job has its own deadline of 1620000 ms after its request arrives. That is 60 s inside the `SERVICE_TIMEOUT_MS` of the runtime, 1680000 ms. The window of the advert, `ADVERT_MAX_PROCESSING_MS`, is at least 1800000 ms.

A job whose caller hangs up is stopped. `propose` stops before its next step and still ends its sub-delegation. `execute` looks at the signal one time, before the hire, and never gives it to the hire: a hire that has paid is carried to its end. The log names the job as abandoned.

The log has one line for each job: the operation, the time it took, the outcome, the reason, the exit and the number of decisions. It names counts and codes. It never holds a request, a stock reading, an order, a confirmation or a key.

## Errors

A call that the service refuses has the body `{"error": "<code>", "message": "<words>"}`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error. It is a 200 result with `outcome` `failed` and a `reason` code, as the paragraph after the first table says.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over the limit), `bad_shape` (a request that breaks a rule of the intake), `bad_context` (a call to `POST /precheck` with a missing or wrong context header), `delegation_not_mine` |
| 401 | `unauthorized` (no authorization header, or one that is not the token) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 503 | `shutting_down` (the service is stopping) |
| 500 | `internal` |

The codes and their statuses are `ERROR_STATUS` in `packages/usecase-kit/src/protocol`, except the codes that the shared server answers itself. The status of a `failed` result is 200 whatever its reason. Each reason that a job writes is in the table of the section Errors of `specs/reorder-agent.md`, with the job that writes it.

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

On SIGTERM or SIGINT the service takes no new job and no new connection, stops its janitors, and waits up to 300 s for the job that runs. A pass of a janitor that is still in flight after 30 s is abandoned, with a log line. A job that ends in time is answered, and the service exits 0. A job that is still running after 300 s is abandoned: its connection is closed, and the log names it.

## State

`REORDER_STATE_DIR` holds the records that outlive the process.

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the escrows that a paying key posted and did not settle. The janitor of the key reclaims them after their `deliver_by`, every 60 s |
| `dispute/` | the journal of the challenges |
| `left/` | the sub-delegations that a job left behind. Their janitor ends them |
| `cosign-register.json` | the register of the keys in use by a co-signed delegation, so a restart still answers `key_in_use` |
| `po-numbers.json` | the counter of purchase order numbers |

The three paying keys each have one lane: a hire, the wallet queue, the janitor and, for the service key, the dispute code share it, so no two of them spend one output.

## Settings

A value that breaks a rule stops the service at start, and the message names the variable. A setting with no default is required. A number of lovelace is a whole number of digits, more than 0. The limits of the two hires and of the model have no default, so a service never runs with a limit that nobody chose.

| Setting | Use | Default |
|---|---|---|
| `OPERATOR_CONTACT` | `operator.contact` | none. Required |
| `AGENT_DID` | `identity.did`, in the form `did:vector:<identifier>` | none. Required |
| `IDENTITY_POLICY_ID`, `IDENTITY_ADDRESS` | the identity registry: the policy ID (56 lowercase hex characters) and its address, which must be the address of the policy | none. The policy is required |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-11-23` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |
| `SERVICE_AUTH_HEADER` | the `authorization` header of the runtime, `Bearer ` and 64 hex characters. Never published, never logged | none. Required |
| `FAULT_MODE` | the one fault switch. The Reorder Agent has no fault value: any value stops the start | empty |
| `PORT`, `HOST` | where the service listens | `9101`, `0.0.0.0` |
| `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL`, `VECTOR_SUBMIT_URL` | the chain endpoints, which `packages/buyer-core` reads. `VECTOR_OGMIOS_URL` must be an `https://` address, because the tip reader of the janitor takes https only | the endpoints of Vector mainnet |
| `VECTOR_MARKETPLACE_INDEXER_URL` | the marketplace indexer in which the suppliers are found. The code reads it when it loads | the default of `packages/buyer-core` |
| `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO` | the deployment values of the identity registry and of the vault, under the names that `packages/buyer-core` reads | none. Required |
| `VECTOR_MODULE1_MANIFEST` | the pinned `https://` address of the Module-1 deployment manifest, which the start fetches one time | none. Required |
| `IDENTITY_GATEWAY_URL` | the identity gateway, an https origin | `https://id.vector.apexfusion.org` |
| `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE` | the two https origins of the mock systems, on two hosts | none. Required |
| `LLM_MODEL_ALLOWLIST` | the models that the service may hire, comma separated, in order of preference | none. Required |
| `LLM_MAX_PRICE_LOVELACE`, `LLM_MAX_SUPPLIER_BOND_LOVELACE`, `LLM_MAX_BUYER_BOND_LOVELACE` | the most that a model job may cost, and the most of each bond of its advert, in lovelace | none. Required |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE`, `DISPUTE_MIN_WINDOW_LEFT_MS`, `DISPUTE_READ_TIMEOUT_MS` | the stake of a challenge, the least time left in the challenge window of a claim, and the most time of one read of the dispute code | none. Required |
| `DISPUTE_STARTED_LEASE_MS`, `DISPUTE_RESOLUTION_DEADLINE_MS` | the lease of a challenge that did not finish, and the resolution deadline, which must be the one of the Module-1 deployment | the dispute code decides |
| `REORDER_STATE_DIR` | where the records of the State section are kept | `/data` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `3000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms`. The least value is the default | `1800000` |
| `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` | `keys.supplier_pkh` and `keys.pub_key_hex`: the hash and the public key of the supplier key. The service never signs with it | none. Required |
| `STOCK_READER_DID` | the agent that reads the stock for this service | none. Required |
| `HANDOFF_MAX_PRICE_LOVELACE`, `HANDOFF_MAX_SUPPLIER_BOND_LOVELACE`, `HANDOFF_MAX_BUYER_BOND_LOVELACE` | the most that the hire of the order supplier may cost, and the most of each bond of its advert, in lovelace | none. Required |
| `COSIGN_ALLOWLIST` | the principals for whom the co-sign route signs, comma separated. The empty text holds nobody | none. Required |
| `COSIGN_MAX_CONCURRENT`, `COSIGN_MAX_FUTURE_MS`, `COSIGN_LEDGER_TIMEOUT_MS` | the limits of the co-sign route | the default of the kit |
| `REORDER_SERVICE_PRIV_KEY_HEX`, `REORDER_SERVICE_PKH` | the service key, which pays and signs the claim, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `REORDER_DELEGATION_1_PRIV_KEY_HEX`, `REORDER_DELEGATION_1_PKH` | the first delegation key and its key hash | none. The key is required; the key hash is derived when it is not set |
| `REORDER_DELEGATION_2_PRIV_KEY_HEX`, `REORDER_DELEGATION_2_PKH` | the second delegation key and its key hash | none. The key is required; the key hash is derived when it is not set |
| `STOCK_READER_AUTH_PRIV_KEY_HEX`, `STOCK_READER_AUTH_PKH` | the key that authenticates the stock reader, and its key hash | none. The key is required; the key hash is derived when it is not set |
| `STOCK_READER_DELEGATION_PRIV_KEY_HEX`, `STOCK_READER_DELEGATION_PKH` | the delegation key of the stock reader, and its key hash | none. The key is required; the key hash is derived when it is not set |

A key is 64 lowercase hex characters, read from the env file and from nowhere else. A `..._PKH` is optional. When it is set, it must be the hash of the key before it, and the service stops at start when it is not. The terms are fixed: the price is `ADVERT_PRICE_LOVELACE`, each bond is 1000000 lovelace, and the lock is 5000000 lovelace.

## What this does not show

The tests do not reach a chain. They show that the service starts from a complete environment, that it renders a stable manifest, and that each job does its steps in order against stand-ins. They do not show a hire that settles on the mainnet, the refund of the escrow of a revoked agent, the reclaim of an escrow that no record holds, or a relying party that refuses a live token after the authority of its holder ended.

## Tests

```bash
pnpm --filter @vsa/reorder-agent test
```

The tests need no network and no key. The folder `test/serve` holds the tests of the settings, the keys, the manifest, the wiring, the server and the start. The start tests run `src/index.ts` as a process, with `test/serve/child-fetch.mjs` in front of the fetch of the Module-1 manifest and of the calls to the node. `test/dockerfile.test.ts` and `test/readme.test.ts` keep the image file and this page to the code.

## Image

`Dockerfile` builds the service image on `node:22-bookworm-slim`. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/reorder-agent/Dockerfile -t vsa/reorder-agent:dev .`. The image runs as the `node` user under `tini`, listens on 9101 and answers `/healthz` for its health check. `/data` is a volume that `node` owns. The image has no test file, no Python and no model. At start it fetches one file, the Module-1 manifest at its pinned address. At run time it fetches only what a job asks of the identity gateway, the mock systems, the node, the indexer and a supplier. The memory limit is set where the container runs.

## Deploy

`deploy/server` holds the compose file, the env example, the Caddy block and the runbook of the Reorder Agent.
The compose file pins both images by digest, publishes `127.0.0.1:8101` and `127.0.0.1:9101`, and gives the runtime none of the five keys of the service.
`test/deploy.test.ts` holds the pack to these rules and to `SETTINGS`.
