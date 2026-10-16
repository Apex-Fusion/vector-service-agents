# Vector service agents: design spec

**Date:** 2026-10-13 · **Status:** approved in conversation, awaiting written review · **Owners:** the Foundation's ecosystem lead (design, collateral and float, sends), Claude (code, docs), the HAL8 lead builder (review, deploy, hosting)

## 1. Purpose and success

Four service agents run on the Vector marketplace, hireable by anyone, with a guide that takes a working-group member from a chat client to a verified receipt in one sitting. The hire path is the hosted keyless MCP server plus the member's local signer, so the member's own key is the buyer on the ledger.

**Done** means one thing: a person we do not control has hired one of these agents on Vector mainnet and holds the receipt. Everything below serves that transaction.

**Constraints carried from canon.** Never state a planned thing as live; every surface carries a status chip (LIVE, DEPLOYED, PROPOSED). All suppliers today are first-party and the guide says so. No third-party audit of the contracts; said first. The escrow contract has Accept, Reclaim and Release and no dispute action; nothing promises disputes. The unit of fees and bonds is named once in the member guide ("the ledger's native unit, AP3X") and called "the unit" everywhere else. Amounts in this spec are in that unit unless marked lovelace (1 unit = 1,000,000 lovelace).

## 2. Scope

**In scope**

- Nine marketplace tools on the hosted keyless MCP server, in three PRs, plus a fourth PR that makes the local signer installable with `npx`.
- Four agents: Agent History, Document Pipeline, Audio Snippets, Advocate. Each ships as a spec, a manifest, a service, a compose file for apex-web, and a registry identity with a Module-3 self-stake.
- The member guide `docs/HIRE.md`, the per-agent specs, the note to the HAL8 lead builder, the internal Discord post.

**Out of scope for this spec** (named so nobody waits for them): reputation and dispute tools on the MCP server (next slice); a supplier-side "post advert" tool; the docs-site page (after the first outside receipt); direct hire of the OCR agent by outsiders (Datalab terms); a Judge agent that hires two Advocates; Meeting Minutes; any change to the escrow contract.

## 3. Shape of the work

| Piece | Repo | Owner | Reviewer |
|---|---|---|---|
| Marketplace tools, PRs 1 to 3, signer PR 4 | `Apex-Fusion/mcp-server` (Apache-2.0) | the Foundation's ecosystem lead + Claude | the HAL8 lead builder |
| Agents, manifests, specs, guide, compose files | new `Apex-Fusion/vector-service-agents` (MIT) | the Foundation's ecosystem lead + Claude build, the HAL8 lead builder hosts | the HAL8 lead builder |
| Public wording (guide, Discord, WG issue) | same repo | Claude drafts, the Foundation's ecosystem lead sends | the Foundation CEO signs off |

Local project folder: `<workspace>\vector-service-agents` (this spec lives in it).

**Repo layout of `vector-service-agents`**

```
README.md                 what this is, status table, links
LICENSE                   MIT
docs/HIRE.md              the member guide
docs/E2E.md               our own end-to-end runbook (first-party)
docs/superpowers/         specs and plans
specs/<agent>.md          one human-readable spec per agent
agents/<agent>/           service code, Dockerfile, agent.json, tests, fixtures
deploy/apex-web/          one compose file + env example + Caddy snippet per agent
scripts/                  e2e-hire client, manifest hash, fixture recorder
```

Agent folders: `agent-history`, `document-pipeline`, `audio-snippets`, `advocate`.

## 4. Architecture

```
member's chat client ──▶ hosted keyless MCP server ──▶ Koios v2 / indexer / Ogmios / submit API
        │                        │
        │ unsigned tx (CBOR)     │ safeFetch (PR 3 only)
        ▼                        ▼
 local signer (stdio MCP)   supplier endpoint on apex-web: template runtime ──▶ our service
        │                                   │
        └── signed tx ──▶ submit API        └── Claim / Submit on chain, receipt back to buyer
```

**Roles of each part**

- **Hosted keyless MCP server** (`mcp.vector.mainnet.apexfusion.org/mcp`, v2.0.0, 24 tools today). Reads chain state, builds unsigned transactions, never holds a key. Our tools follow its conventions: `server.tool(name, description, zodRawShape, handler)` with `zod/v4`, `checkRateLimit()` first, one markdown text block back, errors as text.
- **Local signer** (`packages/signer`, `@apexfusion/vector-mcp-signer`, stdio). Signs CBOR passed tool-to-tool; per-transaction cap 100, daily cap 500. Today it is `private: true` and installed by clone and build; PR 4 publishes it.
- **Marketplace contracts** (PlutusV3, mainnet): advert and escrow scripts, reference scripts on chain. Constants in section 6.
- **Public indexes:** marketplace indexer `mp-indexer.vector.apexfusion.org`, Koios v2 `v2.koios.vector.mainnet.apexfusion.org/api/v1`, activity-api `activity-api.vector.apexfusion.org`.
- **Agents:** each is two containers on apex-web behind the shared Caddy: the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`) and our service process reachable at `SERVICE_URL`. The runtime claims the escrow, calls the service, signs the receipt, submits the receipt hash. The service never touches a key.

**A hire, end to end** (the sequence the guide's chat script walks)

1. `vector_marketplace_list_suppliers` → pick an advert.
2. `vector_build_marketplace_post_escrow` → unsigned Post; `vector_signer_sign` → `vector_submit_transaction` → `vector_await_transaction`.
3. `vector_marketplace_send_job` → the supplier claims (up to 60 s) and answers 202 with a job id.
4. `vector_marketplace_get_job` until 200 → result, receipt, signature.
5. `vector_marketplace_verify_receipt` → verdict.
6. `vector_build_marketplace_accept` → sign → submit → await. Done; the member holds the receipt and two explorer links.

If the supplier never claims, `vector_build_marketplace_reclaim` after `deliver_by` returns the lock to the member.

## 5. MCP server changes

### 5.1 PR 1: read tools and test plumbing

No outbound calls to supplier URLs in this PR. Everything comes from the indexer and Koios.

| Tool | Input (zod) | Output |
|---|---|---|
| `vector_marketplace_list_capabilities` | none | table: capability_id, supplier_count (indexer `/capabilities`) |
| `vector_marketplace_list_suppliers` | `capability_id?: string`, `only_free?: boolean` (default true), `limit?: int` (default 20, max 50) | table: advert_ref, model, price, supplier_bond, buyer_bond, max_processing_ms, status, last_seen_iso, endpoint host, detail_uri (indexer `/suppliers`, sorted by price then last seen) |
| `vector_marketplace_get_supplier` | `advert_ref: "<txid>#<idx>"` | the advert datum decoded from Koios `utxo_info` (all 13 fields) plus the indexer's live status; `detail_uri` shown as a string (fetched only from PR 3 on) |

Every output ends with a fenced ```json block holding the same data, so the assistant can pass values between tools without parsing markdown.

Plumbing in the same PR: `scripts/regen-tool-schemas.mjs` switches from SSE `/sse` to Streamable HTTP `/mcp` (the pattern in `test/setup.ts`); `test/smoke/tool-inventory.test.ts` derives the expected count from `EXPECTED_TOOLS.length` instead of the literal 24; README and `server.json` tool counts are updated by the same commit that adds tools.

### 5.2 PR 2: build tools (unsigned transactions)

Shared code added to `packages/builder/src/vector/marketplace-build.ts`: the escrow and advert datum codecs, `decodeAdvertDatum`, `canonicalize`, `escrowLockFloor`, copied from `agents-marketplace` `packages/shared` (origin/main), with the signing and submission removed. Transactions are built on the existing `lucidForAddress(changeAddress)`, with `addSignerKey(pkh)`, `validFrom(now - 60 s)`, `setMinFee(500_000n)`, `localUPLCEval: false`, and the reserved collateral output of at least 5. Constants are inlined (section 6); the marketplace's `lucidContext.ts` and `blueprint.ts` are not imported (the first resets the slot config to testnet unless an env var is set, the second reads a file the image does not ship).

| Tool | Input | Builds |
|---|---|---|
| `vector_build_marketplace_post_escrow` | `changeAddress`, `advert_ref`, `payload: string`, `deliver_by_ms?: int` | Reads the advert. Locks `price + supplier_bond + buyer_bond`, raised to `escrowLockFloor` when needed. Datum: `buyer_pkh` = payment credential of `changeAddress`, `supplier_pkh`, `advert_ref`, `capability_id`, `request_spec_hash` and `prompt_hash` computed by the copied functions, `payment`, bonds, `deliver_by` (default `now + max_processing_ms + 180 000 ms`), `posted_at = now`, `state = Open`. Escrow output pinned at index 0. Returns unsigned CBOR, fee, lock amount, `deliver_by`, and the future `escrow_ref = <bodyHash>#0` |
| `vector_build_marketplace_accept` | `changeAddress`, `escrow_ref` | Resolves the current UTxO of the escrow lineage (indexer `/escrows/:ref`, fallback: scan the escrow address for the datum with the same `advert_ref`, `buyer_pkh`, `posted_at`). Requires `state = Submitted`, `buyer_pkh` = caller, `now < submitted_at + 600 000 ms`. Spends with redeemer Constr 2 (`d87b80`), reference script `ESCROW_REF_UTXO`, pays the supplier's enterprise address `payment + supplier_bond`, pays `buyer_bond` to `changeAddress`, `validTo = submitted_at + 600 000 ms`. Warns when under 120 s remain |
| `vector_build_marketplace_reclaim` | `changeAddress`, `escrow_ref` | For an escrow past `deliver_by` that is Open, or Claimed and never Submitted: redeemer Constr 3 (`d87c80`), everything back to `changeAddress`, `validFrom >= deliver_by`. The exact state rule is copied from `escrow.ak` at port time and pinned in a unit test; where the validator refuses a state, the tool refuses first and quotes the rule |

**Golden test that pins the port:** encoding the escrow datum for the parameters of mainnet escrow `1f1566b4fb32fe5af98a686d97383db7cd02bd47eae7f2742187d67e335c8538#0` (buyer `60e82034…`, supplier `401af418…`, price 0.2, bonds 1 and 1) must byte-match the inline datum Koios returns for that output. That one test pins the field order, the hash functions and the canonicalisation.

### 5.3 PR 3: job transport and verification

This PR introduces `safeFetch`, the only code path on the public server that calls a URL taken from chain data: https only; the host is resolved and refused when it is loopback, link-local, RFC 1918, CGNAT or a metadata range; request body ≤ 1 MB, response ≤ 2 MB; total budget 90 s (the hosted server sits behind Cloudflare, which drops calls near 100 s); no redirects across schemes; one retry on connection errors. `vector_marketplace_get_supplier` starts fetching `detail_uri` through it.

| Tool | Input | Behaviour |
|---|---|---|
| `vector_marketplace_send_job` | `escrow_ref`, `payload: string`, `route?: "auto" \| "template" \| "chat" \| "ocr"` (default auto) | Resolves the escrow datum → advert → `endpoint_url`, `capability_id`. Route by capability: unknown ids use the template contract `POST {endpoint}/v1/job` with body `{escrow_ref, payload}`; `llm.text.generate.v1` and `ocr.page.extract.*` use the fleet routes with the `X-Escrow-Ref` header. The fleet route table is read from `agents-marketplace` origin/main at port time and pinned in a test (the chat route moved to `/v1/responses` in a recent commit; the test states which one is live). Returns `job_id`, status, and the poll instruction. The template answers 202 only after its Claim confirms, which fits the 90 s budget |
| `vector_marketplace_get_job` | `escrow_ref`, `job_id` | `GET {endpoint}/v1/job/:id` (template) or the fleet poll route. Returns status; on 200 the result, `receipt`, `receipt_signature`, and the supplier's `submitted_ref` when present |
| `vector_marketplace_verify_receipt` | `receipt: object \| string`, `receipt_signature: hex`, `escrow_ref`, `result?: string`, `supplier_pub_key_hex?: hex` | Checks, each reported pass or fail: (1) `receipt.escrow_ref` equals `escrow_ref`; (2) with `result` given, `sha256(result)` equals `response_hash`; (3) the supplier public key (from the argument, else `GET {endpoint}/capability` `pub_key_hex`) hashes to `receipt.supplier_pkh` and to the escrow datum's `supplier_pkh`; (4) Ed25519 over `canonicalize(receipt)` verifies; (5) the Submitted escrow datum's `result_receipt_hash` equals `sha256(canonicalize({receipt, signature}))`, read with Koios `utxo_info`, which still returns the datum after the output is spent by Accept. The verification code is a copy of the template's `try-it/src/verify-receipt.ts`, which is the strict one; the SDK's shape-only check is not used |

### 5.4 PR 4: installable signer

`packages/signer` loses `private: true`, gains a `keygen` subcommand (prints a fresh raw Ed25519 key and its enterprise address, writes nothing), and is published as `@apexfusion/vector-mcp-signer`. The member's config becomes `npx -y @apexfusion/vector-mcp-signer` with `VECTOR_SIGNER_PRIVATE_KEY` and `VECTOR_SIGNER_ADDRESS` in env. Open item: who holds the `@apexfusion` npm scope (section 12).

## 6. Mainnet constants (inlined in code, pinned in tests)

| Item | Value |
|---|---|
| Registry policy / script hash | `be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01` |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Advert script hash / address | `9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da` / `addr1wxvjn7jwak9kdvctscywvq0d9f9hksf6ysfa6yatya2efksvgxwpa` |
| Escrow script hash / address | `810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912` / `addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5` |
| `ESCROW_REF_UTXO` / `ADVERT_REF_UTXO` | `c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#0` / `…#1` |
| Escrow redeemers | Claim Constr 0, Submit{receipt_hash} Constr 1, Accept Constr 2, Reclaim Constr 3, Release Constr 4 |
| Escrow datum (14 fields) | buyer_pkh, supplier_pkh, advert_ref, capability_id, request_spec_hash, prompt_hash, payment, buyer_bond, supplier_bond, deliver_by, posted_at, submitted_at?, result_receipt_hash?, state (Open, Claimed, Submitted) |
| Advert datum (13 fields) | supplier_pkh, capability_id, model, max_output_tokens, max_processing_ms, price, supplier_bond, buyer_bond, endpoint_url, detail_uri, detail_hash, advertised_at, status |
| Zero time / min fee / accept window / collateral | `1756485600000` ms / 500 000 lovelace / 600 000 ms / one pure output of 5 |
| Module-3 reputation / endorsement script hashes | `5168e1871cfdb1e55c18ee173acbcdce092044a48bc2e23f3ba35093` / `77196bed7fb8457610800cc7241cf4496e00d7901de9079fb0323ebf` |
| Module-3 addresses | `addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq` / `addr1w9m3j6ld07uy2asssqxvwfqu73ykuqxhjqw7jpulkqera0cjm7mmz` |
| Module-3 stake datum (observed on chain) | Constr 0 [agent_asset_name, Constr 0 [owner_pkh], stake_amount, [capabilities], last_updated_ms, history_points]; token prefix `rstk_` |
| Module-1 v14 claim / challenge / jury_pool | `addr1wx5ayt5tq8fg905qq7udnclg4a2g42jk78p7gv7qahwcwcqjd9tzq` / `addr1wyf8qr6240wk8j4t8zklk5z9tkj55njtcpqz5jcat2gdr7cazrd0t` / `addr1wy4sr34nzeprwatleqhxg7qvv0k0c826wv7wjxdrutn472q7yn6fa` (plus the v15-sim set `6c7a075f…`, `a28a2a36…`, `7135ee94…`) |
| Module-6 v8 proposal / critique / endorsement spend addresses | `addr1wxvtvyx9jkt7jprdhm0g6wxkl8pvvc63vlwumju8f5uatzgnjjjcr` / `addr1w9gas5jxfye79d7g87lddu5p3lhvt67ku4ptfvgyqn4rp6stn80z3` / `addr1w8t3qgtthdpznyaw5vtdh87tlekzg5f5rdcav20ghwf7pms2mfltj` |
| Endpoints | Ogmios `https://ogmios.vector.mainnet.apexfusion.org`, submit `https://submit.vector.mainnet.apexfusion.org/api/submit/tx`, Koios v2 `https://v2.koios.vector.mainnet.apexfusion.org/api/v1`, indexer `https://mp-indexer.vector.apexfusion.org`, activity-api `https://activity-api.vector.apexfusion.org`, MCP `https://mcp.vector.mainnet.apexfusion.org/mcp` |

The cross-module key is the registry asset name (Modules 1, 3, 6 store it in their `*_did` fields); the marketplace stores key hashes only. Attribution between the two is by key hash, and Agent History says so in every report.

## 7. The agents

### 7.1 Common runtime

- Template runtime at the pinned commit `c4c378a` (`vector-agent-template`, MIT, mainnet-proven 2026-08-19), `CAPABILITY_KIND=custom`, `SERVICE_URL=http://agent-history-service:9091/` (shown for Agent History: the service's container name, because the alias `service` is shared by every agent on `umami_default`; the path `/` is the only one the service accepts POST on), `SERVICE_CONTENT_TYPE=application/json`.
- **Wire contract.** The runtime POSTs the canonical one-element message array to the service: `[{"content": "<payload string>", "role": "user"}]`. Every service parses `JSON.parse(body)[0].content` and then parses that string as JSON. The service's response body becomes the output payload; the runtime hashes it into `response_hash`, signs the eight-field receipt and submits the hash.
- **Timing.** `SERVICE_TIMEOUT_MS <= ADVERT_MAX_PROCESSING_MS - 60 000`; the runtime also keeps 30 s to land the Submit. Values per agent below.
- **Inputs by URL.** Chat clients cannot carry media in a tool call and the hosted server caps requests at 1 MB, so media inputs are an https URL; base64 is accepted under 600,000 bytes of raw media. The wire payload is capped at 900,000 bytes: the runtime's `/v1/job` takes 1 MB of JSON that holds it escaped, and the template's buyer refuses a larger one. Base64 adds a third, so 600,000 raw bytes become 800,000 characters and leave 100,000 bytes for the rest of the request. Each service fetches through its own `safeFetch` (same rules as the server's, larger size caps as stated per agent) and writes `source.sha256` and `source.bytes` into its output, so the signed receipt still commits to the exact media.
- **Keys.** The runtime holds the supplier key (`SUPPLIER_PRIV_KEY_HEX`). Services hold no chain keys, with one exception: the Pipeline's buyer key (7.3). Keys are generated on the box by the runtime image's `gen-keypair`, straight into the env file (`deploy/apex-web/RUNBOOK.md`, step 4); nobody pastes keys into chat.
- **Identity.** Each agent registers a DID (`register-did.sh`, byte-preserving `sign-tx.py`) with name, description, capabilities equal to its capability id, framework `vector-service-agents`, endpoint = its public URL (the advert's `endpoint_url`); then self-stakes 10 in Module-3 on that capability (`m3-self-stake.py`, mainnet genesis patched). Staked capabilities must be a subset of registry capabilities.
- **Wallets.** One pure collateral output of 5 plus a float: 25 to 50 for History, Snippets and Advocate; 100 for the Pipeline. `wallet-monitor` gets each address.
- **Manifest.** Each service serves `GET /agent.json` (section 8). The advert's `detail_uri` points at it and `detail_hash` is the sha256 of the bytes at post time. Adverts are immutable; a changed manifest means a retired advert and a new one.
- **Containers.** Two per agent on `umami_default`: `agent` (runtime image built from the template at the pinned commit) and `service` (image from this repo, `ghcr.io/apex-fusion/vector-service-agents/<agent>`), loopback-published for drills, public through Caddy. Hostnames: `mp-suppliers-history.hal8.ai`, `mp-suppliers-pipeline.hal8.ai`, `mp-suppliers-snippets.hal8.ai`, `mp-suppliers-advocate.hal8.ai`.

### 7.2 Agent History · `identity.history.report.v1` · PROPOSED

The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Read-only, no model cost.

**Request** (JSON in the message content)

```json
{ "subject": "did:vector:agent:<policy>:<asset> | <asset name hex> | <key hash hex>",
  "include": ["identity", "marketplace", "reputation", "dispute", "self_improvement"] }
```

`include` defaults to all. A key hash resolves to every registry record whose current owner is that key (scan of the registry address UTxOs, datum field 0); zero matches still produces the marketplace section for that key.

**Response** `schema: "vector.agent-history.report.v1"`

| Section | Content | Source |
|---|---|---|
| `subject` | resolved did, asset name, controller pkh, registry address | Koios `asset_utxos`, `utxo_info` |
| `as_of` | block, slot, time | Koios `tip` |
| `identity` | `registered {tx, block, time}`; `record {name, description, capabilities, framework, endpoint, registered_at}`; `updates[] {tx, block, time, kind: update \| controller_rotation, from_pkh, to_pkh}` (a rotation is a change of datum field 0 between the spent and the new UTxO); `deregistered {tx, block, time}` or null (burn with no continuing output) | Koios `asset_history`, `asset_txs`, `tx_info` |
| `marketplace.as_supplier` / `as_buyer` | `adverts[] {advert_ref, capability_id, model, price, status, advertised_at}`; `escrows {counts_by_outcome {open, claimed, submitted, accepted, released, reclaimed}, first, last}`. Outcome comes from the redeemer of the final spend (`tx_info` → `plutus_contracts[].input.redeemer`): Constr 2 accepted, 3 reclaimed, 4 released. This is more than the indexer does today (it reports every terminal spend as Accept) | indexer `/suppliers/:pkh`, `/escrows?supplier=`, `/escrows?buyer=`; Koios `tx_info` |
| `reputation` | `stakes[] {utxo, stake_amount, capabilities, last_updated, history_points}`, `endorsements_received[]`, `endorsements_given[]` | Koios `address_utxos` on the two Module-3 addresses, filtered by asset name in datum field 0 |
| `dispute` | `claims[]`, `challenges[]`, `juror` or null | Module-1 addresses (v14 and v15-sim), same filter |
| `self_improvement` | `proposals[]`, `critiques[]`, `endorsements[]` | Module-6 addresses, same filter |
| `key_roles` | controller pkh; advert supplier pkhs; `receipt_signer_match`: true when the controller key also signs receipts for this agent's escrows, false, or "unknown" when no receipt is reachable | derived |
| `sources` | every URL queried | |
| `blind_spots` | fixed list: receipts name keys not DIDs; module links to escrows are by key hash; dispute module is not wired to the escrow; indexer outcome labels are not used | |

**Terms.** Price 1; bonds 1 and 1; `ADVERT_MAX_PROCESSING_MS` 300 000; `SERVICE_TIMEOUT_MS` 180 000. In-memory cache of reports (60 s per subject). Model string in the advert and receipt: `agent-history-v1`.

**Tests.** Golden fixtures recorded from Koios for ChandraOCR (registration at block 7,275,113, the Module-3 stake `05563e75…#0`, the 12 August job `1f1566b4…`), replayed offline; the report for that subject is asserted field by field, including `counts_by_outcome.accepted >= 1` and `receipt_signer_match: true`.

**Gaps stated in the spec file.** Module-3 and Module-6 datum layouts beyond the stake datum are read from the activity-api decoder and the module docs, without a local clone of `vector-agent-modules`; the first live report against each module is checked by hand before the advert is posted.

Field names are normative in specs/agent-history.md (written from the implementation).

### 7.3 Document Pipeline · `document.pipeline.ocr-summary.v1` · PROPOSED

An orchestrator: it buys OCR per page from the live OCR agent and a summary or extraction from an LLM supplier, verifies each sub-receipt, and signs one receipt over the whole bundle. For the working group it demonstrates a delegation chain made visible by receipts, with accountability staying on the Pipeline's key; by the group's own distinction between independent agents and sub-agents, the parties it hires are independent agents.

**Request**

```json
{ "source": { "url": "https://…" } | { "pdf_b64" | "image_b64": "…", "mime": "application/pdf | image/png | image/jpeg" },
  "task": "summary" | "extract", "schema": { JSON Schema, required when task = extract },
  "language": "en", "max_pages": 5 }
```

Limits: fetched source ≤ 20 MB; `max_pages` ≤ 5 in v1; PDF pages are rendered to PNG at 150 dpi.

**Response** `schema: "vector.document-pipeline.result.v1"`

```json
{ "source": { "sha256", "bytes", "mime", "pages" },
  "pages": [ { "index", "text",
               "sub_job": { "capability_id", "advert_ref", "escrow_ref", "supplier_pkh",
                            "receipt", "receipt_signature", "verification": { "...each check": true } } } ],
  "result": { "summary": "…" } | { "extraction": { … }, "schema_valid": true },
  "llm_sub_job": { same shape as a page sub_job },
  "accounting": { "sub_jobs": 6, "locked_total_lovelace", "fees_total_lovelace" } }
```

**How it buys.** The service holds its own buyer key (`PIPELINE_BUYER_PRIV_KEY_HEX`, Foundation-supplied, separate from the supplier key so Claims and Posts never contend for the same UTxOs). Per page: Post an escrow to the OCR advert (`87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0`), `POST /v1/ocr/extract` with `X-Escrow-Ref`, poll, verify, Accept. The Pipeline's OCR hop hires only the allowlisted first-party OCR advert. Then one `llm.text.generate.v1` job on the cheapest free supplier whose model is in an allowlist (`deepseek/deepseek-v4-flash` first), with the page texts and the task; verify; Accept. Sub-hire code lives in `packages/buyer-core` in this repo: the same datum codecs, builders and verifier as PR 2 and PR 3, vendored with a `VENDORED-FROM.md` that names the mcp-server commit, and the same golden datum test runs in both repos, so a drift fails it. The OCR hop is first-party (the Pipeline's buyer key Foundation-operated, the OCR agent's supplier key HAL8-operated), which keeps the Datalab terms. Both of the Pipeline's keys are published in `agent.json` under `keys`.

**Terms.** Price 5; bonds 1 and 1; `ADVERT_MAX_PROCESSING_MS` 1 800 000 (30 min, sequential pages at the OCR advert's 300 s SLA); `SERVICE_TIMEOUT_MS` 1 680 000. Model string `document-pipeline-v1`. Economics stated plainly in the spec file: at five pages the Pipeline locks about 19 in sub-job escrows and fees for a job priced at 5, at today's fleet price of 0.2 per sub-job; the Foundation subsidises the difference on purpose while the fee floor stands.

**Tests.** Service tests with a fake marketplace (an HTTP stub that plays supplier and a fake chain client), golden PDF of two pages, schema validation for `extract`; one live first-party run in `docs/E2E.md`.

### 7.4 Audio Snippets · `audio.transcript.snippets.v1` · PROPOSED

Word-timed transcript of an audio or video file plus the cut points for the quotes or question you give it, optionally the cut clips.

**Request**

```json
{ "source": { "url": "https://…" } | { "audio_b64": "…", "mime": "audio/mpeg | audio/wav | video/mp4 | …" },
  "language": "en", "query": "optional natural-language question", "quotes": ["optional exact or near-exact quotes"],
  "ranges": [ { "start_s", "end_s" } ], "return_clips": false, "clip_format": "mp3" }
```

Limits: duration ≤ 10 min, fetched file ≤ 50 MB; at least one of `query`, `quotes`, `ranges`.

**Response** `schema: "vector.audio-snippets.result.v1"`

```json
{ "source": { "sha256", "bytes", "mime", "duration_s" }, "model": "faster-whisper-small-int8",
  "transcript": [ { "start", "end", "text", "words": [ { "w", "start", "end" } ] } ],
  "matches": [ { "from": "quote | query | range", "start_s", "end_s", "text", "score" } ],
  "clips": [ { "start_s", "end_s", "format", "sha256", "bytes_b64": "only when return_clips and total <= 2 MB" } ] }
```

Matching: quotes by normalised fuzzy match over the word stream (score = ratio); `query` by sentence-level embedding similarity with a small local model, or by keyword overlap when the embedding model is not installed (the output says which). Cut points snap to word boundaries with 150 ms padding.

**Backend.** faster-whisper on CPU, model `small` int8 by default; ffmpeg for decode and cutting. Model size is decided after a one-line check of apex-web (`nproc`, memory): `base` if under 4 cores or 8 GB free. **Terms.** Price 2; bonds 1 and 1; `ADVERT_MAX_PROCESSING_MS` 1 500 000; `SERVICE_TIMEOUT_MS` 1 380 000. Model string `audio-snippets-v1`.

**Tests.** A 20-second public-domain clip as fixture; transcript words and a known quote's cut points asserted within 300 ms; clip sha256 stable.

### 7.5 Advocate · `research.advocate.onesided.v1` · PROPOSED

The strongest one-sided brief for a position, with citations. Its bias is declared in the advert's manifest, in its registry description and in every output.

**Request**

```json
{ "subject": "…", "side": "for | against | <free-text position>", "audience": "optional", "length": "short | standard", "language": "en" }
```

**Response** `schema: "vector.advocate.brief.v1"`

```json
{ "declared_bias": { "side": "…", "statement": "This brief argues one side only, by design, and omits counter-arguments." },
  "thesis": "…",
  "arguments": [ { "claim", "support", "sources": [ { "title", "url", "retrieved_at", "quote" } ] } ],
  "sources": [ … ], "omitted_by_design": "counter-arguments and rebuttals",
  "search": "Brave Search API", "model": "deepseek/deepseek-v4-flash via OpenRouter" }
```

**Backend.** Brave Search API (`BRAVE_SEARCH_API_KEY`, free tier) for 8 to 12 results, page text fetched through `safeFetch` (≤ 1 MB each), one LLM call through OpenRouter (`OPENROUTER_API_KEY`) with a fixed system prompt that forbids counter-arguments and requires every claim to cite a fetched source; a post-check drops any claim whose quote is not found in the fetched text. **Terms.** Price 3; bonds 1 and 1; `ADVERT_MAX_PROCESSING_MS` 300 000; `SERVICE_TIMEOUT_MS` 180 000. Model string `advocate-v1`.

**Why it is in the batch.** Declared behaviour in discovery metadata versus observed behaviour is the live thread in the Identity Primitives doc; this agent makes the declaration explicit and testable. A Judge agent that hires two Advocates for opposite sides is the natural follow-up and is out of scope here.

**Tests.** Search and LLM stubbed; the post-check is asserted (a fabricated quote is dropped); the declared-bias block is always present.

## 8. Specs and manifests

**`specs/<agent>.md`** has the same eleven headings for every agent: Status chip and since-date · Identity (DID, controller, registry fields) · Capability id · Terms (price, bonds, time window, input limits) · Interface (request and response, with an example of each) · What the receipt commits to · Operator and data handling (what we see, what leaves to third parties: Datalab, OpenRouter, Brave) · Known gaps · How to hire it, three ways (chat client via MCP; terminal via the template's buyer; for developers, the raw routes) · Changelog · Links (manifest, source, advert on the explorer).

**`agent.json`** (served at `GET /agent.json`, referenced by `detail_uri`)

```json
{ "schema": "vector.agent-manifest.v1", "name", "capability_id", "version",
  "description", "operator": { "name": "Apex Fusion Foundation", "contact": "…" },
  "identity": { "did", "controller_pkh", "registry_address" },
  "keys": { "supplier_pkh", "pub_key_hex", "buyer_pkh": "pipeline only" },
  "interface": { "request_schema": { JSON Schema }, "response_schema": { JSON Schema }, "routes": { "job": "/v1/job", "status": "/status", "capability": "/capability" } },
  "terms": { "price_lovelace", "supplier_bond_lovelace", "buyer_bond_lovelace", "max_processing_ms", "input_limits": { … } },
  "behaviour": { "declared_bias": "advocate only", "data_handling": "…", "third_parties": [ … ] },
  "status": { "chip": "live | deployed | proposed", "since": "date" },
  "gaps": [ "…" ], "links": { "spec", "source", "explorer_advert" } }
```

`scripts/manifest-hash.mjs` prints the sha256 that goes into the advert. The manifest is frozen at post time; a change means a new advert.

## 9. The member guide (`docs/HIRE.md`)

Order of the document, as the member will do it:

1. **What you'll end up with:** a receipt JSON, its signature, an escrow reference, two explorer links, and the one command anyone can run to verify it.
2. **Get a key:** `npx -y @apexfusion/vector-mcp-signer keygen` (until PR 4 lands: clone `mcp-server`, `npm ci && npm run build`, run the signer from `packages/signer`). Send us the address only.
3. **What the key must hold.** The Foundation supplies working-group experiments with a 5 collateral output and a float of 50. Bonds are posted and fees are consumed in the ledger's native unit, AP3X; the name appears once, here. What one job does: locks price plus two bonds of 1. On accept the supplier receives the price and the supplier bond, your bond of 1 returns to you, and about 1 burns in fees across Post and Accept, so an accepted job costs you the price plus 1 plus about 1. A float of 50 is roughly seven to sixteen accepted jobs depending on the agent.
4. **Two lines of config:** the hosted server URL (already listed in the MCP Registry as `io.github.Apex-Fusion/vector`) and the local signer with its caps (100 per transaction, 500 per day by default).
5. **The chat script,** verbatim: list capabilities; show suppliers for `identity.history.report.v1`; hire that one with this payload; when the receipt verifies, accept. The assistant makes about a dozen tool calls; the member reads three results.
6. **Read your receipt:** the eight fields, what each hash is, and `vector_marketplace_verify_receipt` as the offline check anyone can repeat.
7. **Optional:** register your own identifier with `vector_build_register_agent` (10 deposit, refundable), so your hires sit next to an identity.
8. **Terminal path:** the template's `try-it/src/buy-once.ts`, three commands, same key.
9. **When it goes wrong:** supplier busy or offline (pick another advert), 100-second timeouts (poll again), stranded escrow (reclaim after `deliver_by`), where to ask (the WG Discord thread).
10. **Honesty box:** all suppliers are first-party today; no third-party audit of the contracts; accept and reclaim exist, dispute does not; receipts name keys, identities are linked through the key.

## 10. Testing

| Where | What | Gate |
|---|---|---|
| mcp-server unit | datum codecs against the golden mainnet escrow (5.2); `escrowLockFloor` cases; Accept and Reclaim validity windows; redeemer bytes; `safeFetch` (schemes, private ranges, size, time, redirects); route table pinned | `npm run test:unit` in CI |
| mcp-server smoke | nine new tool schemas in `tool-schemas.snapshot.json`, derived count | `npm run test:smoke` in CI |
| mcp-server boundary | no key or mnemonic words in new sources | existing `boundary.test.ts` |
| agents, service level | golden input → exact JSON; fixtures recorded from Koios (History), stub marketplace (Pipeline), 20 s clip (Snippets), stubbed search and model (Advocate) | `pnpm test` per agent in CI |
| end to end, mainnet, first-party | `scripts/e2e-hire.mjs`: a scripted MCP client against a locally run builder plus signer, then against the deployed server; hires Agent History with our test buyer key and its float; asserts the verdict and the Accept confirmation | run by hand before each rollout step; documented in `docs/E2E.md` |

Tests are written before the code they test, per the repos' existing practice.

## 11. Rollout and gates

1. Spec approved in writing → implementation plan (writing-plans) → work in git worktrees, one branch per PR.
2. **PR 1** opened; **PR 2** branch with the golden datum test passing; **Agent History** service running locally against Koios. (Today.)
3. The Foundation's ecosystem lead supplies collateral plus float to: our test buyer key; four agent wallets. The Foundation's ecosystem lead executes every transfer; Claude never sees a key.
4. The note to the HAL8 lead builder goes out first (section 12), naming the gateway `/mcp` overlap. The HAL8 lead builder reviews PRs 1 to 4, dispatches the mainnet deploy (`deploy-mainnet.yml`, manual), adds four DNS names and Caddy blocks, pulls the images.
5. Agents register DIDs and self-stake via the existing ops scripts; adverts posted with `detail_uri` set; manifests frozen.
6. Our own first-party hire of Agent History through the deployed server succeeds → the receipt and the guide draft go to internal Discord → the Foundation CEO signs off → issue in `aaif/wg-identity-and-trust` → one member (a working-group ally first) walks the guide with us on a call → first outside receipt → docs-site page.

## 12. Decisions made in this design session

| Decision | Choice |
|---|---|
| Success criterion | a person we do not control hires an agent and holds the receipt |
| First hirer | a WG member, by hand, from a chat client |
| Collateral and float | Foundation-supplied key the member holds; their key is the buyer |
| Channel | extend the hosted keyless MCP server; local signer signs; several PRs, the HAL8 lead builder approves |
| Agents | Agent History, Document Pipeline, Audio Snippets, Advocate; ChandraOCR out of scope as a direct hire, used inside the Pipeline |
| Prices | 1 / 5 / 2 / 3; bonds 1 and 1 everywhere |
| Hosting | apex-web, chandra-supplier pattern, the HAL8 lead builder hosts |
| Media inputs | https URL, base64 under 600,000 bytes of raw media (wire payload capped at 900,000 bytes), source hash in the output |
| Publication | internal Discord → the Foundation CEO → WG GitHub issue → docs site after the first outside receipt |
| Unit name | once in the guide, "unit" elsewhere |

**Open items that need a human**

| Item | Who |
|---|---|
| Supply the collateral and float of the test buyer key and four agent wallets | the Foundation's ecosystem lead |
| Brave Search API key for Advocate; confirm OpenRouter key reuse | the Foundation's ecosystem lead |
| `@apexfusion` npm scope ownership for the signer publish | the Foundation's ecosystem lead or the HAL8 lead builder |
| apex-web CPU and memory check for whisper model size | the HAL8 lead builder (or the Foundation's ecosystem lead over SSH) |
| DNS names, Caddy blocks, mainnet deploy dispatch | the HAL8 lead builder |
| Alignment on the gateway `/mcp` overlap | the Foundation's ecosystem lead sends the note, the HAL8 lead builder answers |
| Sign-off on public wording | the Foundation CEO |

## 13. Risks

| Risk | Answer in this design |
|---|---|
| Two marketplace-over-MCP efforts (the HAL8 lead builder's gateway `/mcp`, this) | Note to the HAL8 lead builder first; the two are complementary (custodial convenience vs identity-grade keyless) and share no code paths |
| SSRF through on-chain `endpoint_url` and `detail_uri` | `safeFetch` rules, applied on the server and inside every service |
| Fee floor makes every job cost about 1 in fees plus the lock | Stated in the guide; the Foundation supplies the collateral and float; the Pipeline's subsidy named in its spec |
| Whisper on an unmeasured CPU box | model size decided after the check; 10-minute input cap; long SLA |
| Fleet route changed upstream (`/v1/responses`) | route table read from origin/main at port time and pinned in a test |
| Member strands a lock on a supplier that never claims | `vector_build_marketplace_reclaim` ships in PR 2, before any outsider is invited |
| Snapshot test blocks PRs | regen script fixed in PR 1; count derived |
| Public wording drifts from canon | the Foundation CEO sign-off gate; status chips on every surface |
