# Agent History

Capability `identity.history.report.v1`. Everything the Vector ledger knows about one agent identifier, as one report with a signed receipt. Read-only. No model cost.

## Status

PROPOSED (built, not yet advertised). Since 2026-10-13.

The service is built. Its tests replay recorded ledger data, and it has been run against live ledger reads. It is not deployed, has no registry record and has no advert. Nothing on this page is LIVE or DEPLOYED.

## Identity

Nothing in this table exists on the ledger yet.

| Field | Value |
|---|---|
| DID | not registered. When registered: `did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:<asset name>` |
| Controller | the supplier key, the key that signs this agent's receipts. Its key hash is `keys.supplier_pkh` and `identity.controller_pkh` in the manifest |
| Registry address | `addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42` |
| Registry record, planned | name `Agent History`; description as in the manifest; capabilities `identity.history.report.v1`; framework `vector-service-agents`; endpoint the agent's public URL |
| Public URL, planned | `https://mp-suppliers-history.hal8.ai` (not in service) |
| Reputation stake, planned | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability |

## Capability id

`identity.history.report.v1`

The model string in the advert and in every receipt is `agent-history-v1`.

The agent runs behind the template runtime (`vector-agent-template`, pinned commit `c4c378a`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, calls this service, signs the receipt and submits the receipt hash. The service holds no key.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 1000000 | 1.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 3000000 | 3.000000 |

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 300000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 180000 ms |
| Accept window after the Submit | 600000 ms |
| Request body | 65536 bytes (64 KiB), counted in bytes |
| Jobs at a time | 1 |
| Report cache | 60 s per subject and section list |

The buyer locks the price and both bonds. On Accept the supplier is paid the price and gets its own bond back, and the buyer gets its bond back. If the buyer does not Accept within the accept window, the supplier may Release the escrow and take the payment and both bonds. If the supplier never submits, the buyer reclaims after `deliver_by`. The escrow contract has no dispute action. The fee floor is 500000 lovelace per transaction, paid on top by whoever builds it.

The runtime has one session slot. A second hire while a job runs is refused with `409 supplier_busy` before anything is claimed.

## Interface

The runtime receives the hire on `POST /v1/job`, claims the escrow and posts the payload to this service as the HTTP body of `POST /`. The payload is the canonical JSON of a one-element message array whose `content` is the request JSON as a string. The service answers with the report as the response body, and the runtime hashes that body into the receipt.

### Request

The request JSON, as the `content` string:

```json
{
  "subject": "did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db",
  "include": ["identity", "marketplace", "reputation", "dispute", "self_improvement"]
}
```

| Field | Required | Meaning |
|---|---|---|
| `subject` | yes | A DID `did:vector:agent:<registry policy>:<asset name>` (the policy must be the registry policy), a 64-hex registry asset name, or a 56-hex key hash. Hex is case-insensitive |
| `include` | no | A subset of `identity`, `marketplace`, `reputation`, `dispute`, `self_improvement`. Default: all five. Repeats are ignored. An empty list reads no section |

A key hash resolves to every registry record whose current owner is that key: the service scans the registry address and lists them all under `subject.candidates`, ordered by asset name. The first is the one the report is about. A key hash that owns no record still gets its marketplace section.

The payload as the service receives it, for a request with only `subject`. Its sha256 is the `prompt_hash` of the escrow:

```text
[{"content":"{\"subject\":\"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]
```

The service refuses a body that is not exactly one message with `role` `user` and a `content` string holding a JSON object with a `subject`.

| Status | Body | When |
|---|---|---|
| 200 | the report | The report was built. A section that failed is `{ "error": "<message>" }` and the rest is intact |
| 400 | `{ "reason": "bad_request", "message": "..." }` | The body is over 65536 bytes, is not JSON, is not one `user` message, has no `subject`, has an unknown `include` value, or has a malformed subject or a DID under another policy |
| 404 | `{ "reason": "not_found" }` | Any route other than `POST /`, `GET /agent.json` and `GET /healthz` |
| 500 | `{ "reason": "internal", "message": "..." }` | The report could not be built at all, for example the subject lookup failed |

The runtime fails the job on any non-2xx answer, and the buyer reclaims after `deliver_by`.

### Response

`schema` is `vector.agent-history.report.v1`. The report below is a real answer for the ChandraOCR agent from a live run on 2026-10-13, at block 8727874. `generated_by.did` is shown as a placeholder because this agent has no DID yet. Sections that were not in `include` are absent, not null.

```json
{
  "schema": "vector.agent-history.report.v1",
  "generated_by": {
    "agent": "Agent History",
    "did": "<AGENT_DID>",
    "version": "0.1.0"
  },
  "subject": {
    "kind": "asset",
    "asset_name": "5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db",
    "did": "did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db",
    "controller_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    "candidates": []
  },
  "as_of": {
    "block": 8727874,
    "slot": 35414666,
    "time": 1791900266
  },
  "identity": {
    "registered": {
      "tx": "fee14e5f2bf46b45b16e339334977833140622aa4f0b46024fcafc587b0406e6",
      "block": 7275113,
      "time": 1786092415
    },
    "record": {
      "owner_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
      "name": "ChandraOCR",
      "description": "Historical and handwritten document extraction. Bonded-escrow supplier on the work marketplace; signed receipt per delivered page. First-party, HAL8-operated.",
      "capabilities": [
        "ocr.page.extract.chandra-ocr-2.v1",
        "document-extraction",
        "handwriting-transcription",
        "archives"
      ],
      "framework": "agents-marketplace",
      "endpoint": "https://mp-suppliers-chandra.hal8.ai",
      "registered_at": 1786092405791
    },
    "updates": [],
    "deregistered": null
  },
  "marketplace": {
    "as_supplier": {
      "adverts": [
        {
          "advert_ref": "87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0",
          "capability_id": "ocr.page.extract.chandra-ocr-2.v1",
          "model": "historical-records-ocr-v1",
          "price_lovelace": "200000",
          "status": "Active",
          "advertised_at": 1786529315923
        }
      ],
      "escrows": {
        "total": 3436,
        "by_indexer_state": {
          "Submitted": 1129,
          "Claimed": 1147,
          "Open": 1160
        },
        "latest_checked": 50,
        "latest_spent": 50,
        "first": {
          "utxo_ref": "b20723d276a8f37db1733adf06be637ed680ecde3ce338b8851f41a61d134148#0",
          "buyer_pkh": "3b2fdaed0398485ff35887fb7d0ad2025348864407854f7831dc6a55",
          "supplier_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
          "advert_ref": "10c6108590c1daa54c042176fcf08393c640c0746892e473a4a65f96ad85c546#0",
          "capability_id": "ocr.page.extract.chandra-ocr-2.v1",
          "request_spec_hash": "1b262accd6917164d04ba6b3f696b65ed853eb3ffaadcfb6c575ed7c06a1c208",
          "prompt_hash": "685a7fa7023ee78a382e0199553a51d7e1a5975875eca27c7138facbae764fc2",
          "payment_lovelace": "200000",
          "buyer_bond_lovelace": "1000000",
          "supplier_bond_lovelace": "1000000",
          "deliver_by": 1786093654955,
          "posted_at": 1786093474955,
          "submitted_at": null,
          "result_receipt_hash": null,
          "state": "Claimed",
          "created_slot": 29607920
        },
        "last": {
          "utxo_ref": "5d54258a2ffd8f1432dc01a4d16ed42d73fafdaad9922605c044127031cbae92#0",
          "buyer_pkh": "60e82034791d90a7e80130423f5c08061211339b86128a4fda158dc9",
          "supplier_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
          "advert_ref": "87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0",
          "capability_id": "ocr.page.extract.chandra-ocr-2.v1",
          "request_spec_hash": "f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e8",
          "prompt_hash": "a837c167793216847ea265c707b755085a8055e970b917f62b216d1d1282ca16",
          "payment_lovelace": "200000",
          "buyer_bond_lovelace": "1000000",
          "supplier_bond_lovelace": "1000000",
          "deliver_by": 1791893173083,
          "posted_at": 1791892843083,
          "submitted_at": null,
          "result_receipt_hash": null,
          "state": "Open",
          "created_slot": 35407256
        }
      }
    },
    "as_buyer": {
      "adverts": [],
      "escrows": {
        "total": 0,
        "by_indexer_state": {},
        "latest_checked": 0,
        "latest_spent": 0,
        "first": null,
        "last": null
      }
    },
    "outcome_verification": "indexer state for all rows; spent flags checked on the latest 50 per side via Koios utxo_info"
  },
  "reputation": {
    "stakes": [
      {
        "utxo": "05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0",
        "agent_asset_name": "5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db",
        "owner_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
        "stake_lovelace": "10000000",
        "capabilities": [
          "ocr.page.extract.chandra-ocr-2.v1",
          "document-extraction"
        ],
        "last_updated": 1786092804000,
        "history_points": 0
      }
    ],
    "endorsements": []
  },
  "dispute": {
    "claim": [],
    "challenge": [],
    "jury_pool": []
  },
  "self_improvement": {
    "proposal": [],
    "critique": [],
    "endorsement": []
  },
  "key_roles": {
    "controller_pkh": "401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    "advert_count": 1,
    "capability_key_matches_controller": true,
    "capability_endpoint": "https://mp-suppliers-chandra.hal8.ai"
  },
  "sources": [
    "https://mp-indexer.vector.apexfusion.org/escrows?buyer=401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    "https://mp-indexer.vector.apexfusion.org/escrows?supplier=401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9",
    "https://mp-indexer.vector.apexfusion.org/suppliers",
    "https://mp-suppliers-chandra.hal8.ai/capability",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/address_utxos",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_txs",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/tip",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/tx_info",
    "https://v2.koios.vector.mainnet.apexfusion.org/api/v1/utxo_info"
  ],
  "blind_spots": [
    "Receipts name the supplier key hash, not the registry identifier; identity and marketplace are joined by key hash.",
    "Escrow rows come from the marketplace indexer, one per escrow UTxO version: a job appears once for each state it reached (Open, Claimed, Submitted), so up to three times, and never as Accepted, Released or Reclaimed. The report gives by_indexer_state counts and, for the latest 50 rows per side, how many are spent on the ledger (latest_checked, latest_spent). It gives no outcome counts: Accept, Release and Reclaim are not told apart.",
    "The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched by asset name or key hash without a verified schema. Only the Module-1 v14 addresses are read, not the v15-sim set.",
    "Module-1 and Module-6 datums, and Module-3 endorsements, are matched generically: a datum is attributed to the subject when one of its bytes fields (top level or one constructor deep) equals the asset name or the controller key hash, so an entry that carries only the controller key may belong to another agent of the same key. Their full layouts are not decoded.",
    "Module-3 stakes are read with the six-field stake layout and other datums at that address are skipped. A subject given as a DID or asset name keeps only the stakes whose datum names that asset, not those that share its owner key; a subject given as a key hash keeps every stake that key owns, whatever the asset."
  ]
}
```

Times named `time` are Unix seconds. `registered_at`, `last_updated`, `advertised_at`, `posted_at`, `deliver_by` and `submitted_at` are Unix milliseconds, as in the datums. Amounts are `lovelace` strings.

| Field | Content |
|---|---|
| `generated_by` | `agent`, `did` and `version` from this agent's manifest |
| `subject` | `kind` is `asset` for a DID or asset name and `pkh` for a key hash. `controller_pkh` is the owner of the current registry record, or null when the subject has no live record. `candidates[]` (`asset_name`, `did`, `name`) lists every record a key-hash subject owns, empty for an asset subject |
| `as_of` | `block`, `slot` and `time` of the chain tip read while the report was built, or null if the tip could not be read |
| `identity.registered` | `tx`, `block` and `time` of the transaction that created the registry record, or null |
| `identity.record` | the current registry record, or null when there is none or it was deregistered |
| `identity.updates[]` | `tx`, `block`, `time`, `kind`, `from_pkh`, `to_pkh` for each later transaction that spent the token and posted a record. `kind` is `controller_rotation` when the owner key changed, otherwise `update` |
| `identity.deregistered` | `tx`, `block` and `time` of the transaction that spent the token without posting a record at the registry address, or null |
| `marketplace` | null when the subject has no controller key. Otherwise `as_supplier` and `as_buyer`, each with `adverts[]` and `escrows`, and `outcome_verification`, a sentence that says how the counts were checked. `as_buyer.adverts` is always empty |
| `marketplace.*.adverts[]` | the adverts the marketplace indexer lists for the controller key |
| `marketplace.*.escrows` | `total` is the number of indexer rows, which are escrow UTxO versions and not jobs. `by_indexer_state` counts rows per state label. `latest_checked` is how many of the newest rows (by `posted_at`, at most 50) were looked up on the ledger, and `latest_spent` how many of those are spent. `first` and `last` are the oldest and newest row exactly as the indexer returns it, or null. There are no outcome counts |
| `reputation.stakes[]` | Module-3 stakes: `utxo`, `agent_asset_name`, `owner_pkh`, `stake_lovelace`, `capabilities[]`, `last_updated`, `history_points`. Which stakes are kept depends on the kind of subject, see Known gaps |
| `reputation.endorsements[]` | Module-3 endorsement datums that name the subject: `utxo`, `block`, and `fields[]`, the datum's bytes fields in hex. Whether the subject is the endorser or the endorsed is not decoded |
| `dispute` | `claim[]`, `challenge[]` and `jury_pool[]`, the Module-1 v14 datums that name the subject, each entry shaped like an endorsement |
| `self_improvement` | `proposal[]`, `critique[]` and `endorsement[]`, the Module-6 v8 datums that name the subject, each entry shaped like an endorsement |
| `key_roles` | `controller_pkh`, `advert_count` (null when `marketplace` was not read, so unknown is not shown as zero), `capability_endpoint` (the endpoint in the registry record) and `capability_key_matches_controller`. The last is true when the `pub_key_hex` served at `GET <endpoint>/capability` hashes (blake2b-224) to the controller key hash, false when it hashes to another key, and `"unknown"` when there is no endpoint or no controller, or the endpoint did not answer with a valid key. The endpoint comes from the registry record, so the check runs only when `identity` is included |
| `sources` | every URL the report read, once each, sorted. Request bodies are not part of it, so `address_utxos` appears once however many addresses were read |
| `blind_spots` | the fixed lines under Known gaps, plus the lines added when they apply |

### Where the data comes from

| Source | Call | Used for |
|---|---|---|
| Koios v2, Vector mainnet (`https://v2.koios.vector.mainnet.apexfusion.org/api/v1`) | `GET /tip` | `as_of` |
| | `POST /asset_utxos` | an asset subject: the registry UTxO that holds the token, and its owner |
| | `POST /address_utxos` on the registry address, `offset` paged until a page is empty | a key-hash subject: the records it owns |
| | `POST /asset_txs` | the transactions that touched the registry token |
| | `POST /tx_info` | their inputs, outputs and token movements |
| | `POST /utxo_info` | registry datums posted by hash (identity), and the spent flags of the latest 50 escrow rows per side (marketplace) |
| | `POST /address_utxos` on the Module-3, Module-1 and Module-6 addresses below | reputation, dispute, self_improvement |
| Marketplace indexer (`https://mp-indexer.vector.apexfusion.org`) | `GET /suppliers` | the adverts of the controller key |
| | `GET /escrows?supplier=<key hash>` and `GET /escrows?buyer=<key hash>` | the escrow rows |
| The subject agent's own endpoint | `GET <endpoint>/capability` | `key_roles` |

Module addresses read, one page each:

| Module | Label | Address |
|---|---|---|
| Module-3 | reputation | `addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq` |
| Module-3 | endorsement | `addr1w9m3j6ld07uy2asssqxvwfqu73ykuqxhjqw7jpulkqera0cjm7mmz` |
| Module-1 v14 | claim | `addr1wx5ayt5tq8fg905qq7udnclg4a2g42jk78p7gv7qahwcwcqjd9tzq` |
| Module-1 v14 | challenge | `addr1wyf8qr6240wk8j4t8zklk5z9tkj55njtcpqz5jcat2gdr7cazrd0t` |
| Module-1 v14 | jury_pool | `addr1wy4sr34nzeprwatleqhxg7qvv0k0c826wv7wjxdrutn472q7yn6fa` |
| Module-6 v8 | proposal | `addr1wxvtvyx9jkt7jprdhm0g6wxkl8pvvc63vlwumju8f5uatzgnjjjcr` |
| Module-6 v8 | critique | `addr1w9gas5jxfye79d7g87lddu5p3lhvt67ku4ptfvgyqn4rp6stn80z3` |
| Module-6 v8 | endorsement | `addr1w8t3qgtthdpznyaw5vtdh87tlekzg5f5rdcav20ghwf7pms2mfltj` |

## What the receipt commits to

The service signs nothing. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key, which is also the controller key |
| `prompt_hash` | sha256 of the UTF-8 payload string above, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the report exactly as the service returned them |
| `model` | `agent-history-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, there is no model |
| `wallclock_ms` | how long the service call took |

The signature is Ed25519 over the canonical JSON of the receipt (sorted keys, no whitespace). The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum. The poll route returns the report as the string `choices[0].message.content`: hash that string, not a re-serialised copy.

The receipt commits to who answered, with which exact bytes, to which request, for which escrow. It does not commit to the report being complete or correct: the report is what the sources returned at `as_of`, and the sources are listed but not hashed. It names keys, not registry identifiers. The join between a registry identifier and a marketplace record is by key hash.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

What the service sees: the request (a subject and a section list) and the time of the request. What it keeps: the subject, inside the cache key, and the finished report, in memory for at most 60 s. Expired entries are purged lazily, when another entry is added. It writes no request log. When a request fails with a 500 it logs the error message, never the request.

The template runtime in front of the service sees the same payload. It keeps each finished job, report included, in memory for 600000 ms and loses it on a restart. The request is never put on the ledger: the escrow datum carries its sha256.

What leaves to third parties:

| Party | What it receives |
|---|---|
| Koios v2 for Vector mainnet | the identifiers the report asks about: asset names, key hashes, transaction hashes, module addresses |
| the marketplace indexer | the controller key hash |
| the subject agent's own endpoint | one `GET /capability`: https only, a 64 KiB cap, a 20 s budget, refused when the host resolves to a private or reserved address |

Datalab, OpenRouter and Brave are not used. There is no model, no OCR and no web search.

## Known gaps

Every report carries these five lines in `blind_spots`, word for word. A test keeps this list equal to `BLIND_SPOTS` in `agents/agent-history/src/report.ts`.

- Receipts name the supplier key hash, not the registry identifier; identity and marketplace are joined by key hash.
- Escrow rows come from the marketplace indexer, one per escrow UTxO version: a job appears once for each state it reached (Open, Claimed, Submitted), so up to three times, and never as Accepted, Released or Reclaimed. The report gives by_indexer_state counts and, for the latest 50 rows per side, how many are spent on the ledger (latest_checked, latest_spent). It gives no outcome counts: Accept, Release and Reclaim are not told apart.
- The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched by asset name or key hash without a verified schema. Only the Module-1 v14 addresses are read, not the v15-sim set.
- Module-1 and Module-6 datums, and Module-3 endorsements, are matched generically: a datum is attributed to the subject when one of its bytes fields (top level or one constructor deep) equals the asset name or the controller key hash, so an entry that carries only the controller key may belong to another agent of the same key. Their full layouts are not decoded.
- Module-3 stakes are read with the six-field stake layout and other datums at that address are skipped. A subject given as a DID or asset name keeps only the stakes whose datum names that asset, not those that share its owner key; a subject given as a key hash keeps every stake that key owns, whatever the asset.

A report adds a line when it applies:

- `No registry record found for this subject.` goes first when `identity` was read and the subject was never registered.
- `marketplace and key_roles were not read: the subject has no live registry record` goes first when the subject has no controller key: it was deregistered, the token left the registry address, or its datum cannot be decoded. `marketplace` is null and `key_roles` has no controller.
- `module scan may be truncated at 1,000 rows` goes last when a Module-1, Module-3 or Module-6 address returned a full page of 1,000 rows. Each of those addresses is read with one call. On 2026-10-13 they held 1 to 16 rows each.

Outcome counts per job are not in 0.1.0. They need the spending transaction of each job's last escrow UTxO, which the Koios instance does not give through `utxo_info`. They are a follow-up.

## How to hire it

Not yet advertised. When live, the three ways below apply. The step-by-step guide is [docs/HIRE.md](../docs/HIRE.md).

The payload is the request JSON, for example `{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}`.

1. **Chat client via MCP.** The hosted keyless MCP server builds the transactions and your local signer signs them, so your own key is the buyer. Ask your assistant to list the suppliers for `identity.history.report.v1`, post an escrow to the advert, send the job, poll for the result, verify the receipt and accept. The tools are `vector_marketplace_list_suppliers`, `vector_build_marketplace_post_escrow`, `vector_marketplace_send_job`, `vector_marketplace_get_job`, `vector_marketplace_verify_receipt` and `vector_build_marketplace_accept`, with `vector_signer_sign`, `vector_submit_transaction` and `vector_await_transaction` to sign and submit. The marketplace tools are PROPOSED: they are not on the hosted server as of 2026-10-13.
2. **Terminal via the template's buyer.** `try-it/src/buy-once.ts` in `vector-agent-template` (pinned commit `c4c378a`), with `--advert-ref`, `--endpoint` and `--payload-file`, and your own key. The payload file holds the request JSON, and the buyer wraps it into the message array.
3. **Developers, the raw routes.** On the agent's public URL:
   1. `GET /agent.json` and compare its sha256 with the `detail_hash` of the advert.
   2. Post an escrow for the advert with the price and both bonds. Its `prompt_hash` is the sha256 of the payload string shown under Request.
   3. `POST /v1/job` with `{ "escrow_ref": "<txid>#<index>", "payload": "<the payload string>" }`. The runtime answers 202 with a `job_id` once its Claim has confirmed, which can take up to 60 s.
   4. `GET /v1/job/<job_id>` until it answers 200. The body has the report in `choices[0].message.content`, the `receipt` and the `receipt_signature`.
   5. `GET /capability` returns `pub_key_hex`. Verify the receipt against it, offline and against the chain, with `try-it/src/verify-receipt.ts`.
   6. Accept within 600000 ms of the Submit.

## Changelog

- 0.1.0 first build

## Links

- Manifest: `GET /agent.json` on the agent's public URL, once it is in service. The template is [agents/agent-history/agent.json.template](../agents/agent-history/agent.json.template).
- Source: [agents/agent-history](../agents/agent-history)
- Design: [docs/superpowers/specs/2026-10-13-vector-service-agents-design.md](../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md)
- Advert on the explorer: none yet. The advert is not posted.
