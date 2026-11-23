# Order Desk

Capability `supplychain.order.accept.v1`. For a supplier: takes a purchase order for one lot from a buyer's agent, checks who sent it and that the buyer approved exactly this order, and, if the lot can be supplied, places it in the supplier's system and confirms it.

## Status

PROPOSED (built, not deployed). Since 2026-11-23.

The service is built. Its tests run the hook (the check that comes before the Claim), the job, the order book and the manifest against stand-ins for the identity gateway, the ledger, the supplier portal, a model supplier and the dispute code, with no network. The agent has no registry record, no advert and no job yet. Nothing on this page is LIVE or DEPLOYED.

## Identity

This agent has no registry record yet.

Planned. The values are filled at registration.

| Field | Value |
|---|---|
| DID | assigned at registration |
| Controller | a controller key of this deployment |
| Supplier keys | three, one for each runtime. A runtime signs its receipts, and the Claim and Submit transactions of its escrows, with the supplier key of its own. The manifest gives the key hash and the public key of each runtime in `terms.tiers`. `identity.supplier_key` names the key of the small runtime as a key of the DID (`<DID>#<key hash>`) |
| Service key | one key, held by the service and by no runtime. It pays for the model hire of each decision, signs the transactions of the dispute code and signs the request for the X.509-SVID. The manifest publishes its key hash as `keys.service_pkh`. The service holds the key hashes and the public keys of the three runtimes, and no private supplier key |
| Parties | Accountable: the Accountable key of the organisation. Responsible: Module-1. Provider: the Provider key. Guardians: two, with a threshold of 2 |
| Organisation | `alfa.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation", verified by a DNS TXT record |
| Public URL | to be set: one host name for each runtime. The manifest names the lots file at `/lots.json` on the host name of the small runtime |
| Reputation stake | a Module-3 self-stake on the capability, made with the service key |
| Claim | a Module-1 claim on the statements of Claim statements, staked for each run |

## Capability id

`supplychain.order.accept.v1`

Three adverts, one for each lot size. The `model` string of an advert and of every receipt that it gives is the name of the lot.

| Advert `model` | Lot | Size |
|---|---|---|
| `lot-small` | small | set in the lots file, for each SKU |
| `lot-medium` | medium | set in the lots file, for each SKU |
| `lot-large` | large | set in the lots file, for each SKU |

The agent is three runtimes in front of one service. Each runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). It holds the supplier key of one lot and has the advert of that lot. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash. The service does the work. It holds the service key and no private supplier key. The three runtimes share the service, its manifest and its one job slot, so one job runs at a time.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals. The Order Desk has three adverts, so its terms have three groups, one for each lot.

**Advert `lot-small`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 2000000 | 2.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 4000000 | 4.000000 |

**Advert `lot-medium`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 5000000 | 5.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 7000000 | 7.000000 |

**Advert `lot-large`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 10000000 | 10.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 12000000 | 12.000000 |

The price stands for the size of the order on the ledger. It lets the vault limit of a buyer refuse a lot that is larger than the buyer delegated. It is not the commercial value of the goods, which exist only in the supplier system of the demonstration.

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 480000 ms, for each of the three adverts |
| Service timeout, `SERVICE_TIMEOUT_MS` of each runtime | 360000 ms |
| Job deadline, set by the service when a request arrives | 300000 ms |
| Request | at most 900000 bytes of wire payload |
| Model calls | one for each job: the decision `availability` |

The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. It does not count the body of the call that a buyer makes to a runtime. The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte. The runtime refuses a body above 1048576 bytes (1 MiB). So the limit of 900000 bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below 1048576 bytes. The service reads at most 1000000 bytes of wire payload and refuses more with `request_too_large` (400).

Economics: on Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer. A job that the hook refuses, and a job that fails after the Claim, are not paid: the buyer reclaims the escrow after `deliver_by`. The service pays for its one model call from the service key.

## Interface

A buyer's agent hires the Order Desk through one of its three runtimes. It posts an escrow on the advert of one lot, pays it from a vault of its delegation, and sends one request, the handoff of use case 1 (inventory reorder). The runtime of that advert asks the service before it claims the escrow. After the Claim it posts the job to the service. The service answers with the confirmation of the order, or with an error.

Two things are named apart on this page. The **request JSON** is what the buyer's agent writes: the handoff under Request below. The **wire payload** is the request JSON written as a string inside a one-message array: `[{"content": "<request JSON as a string>", "role": "user"}]`. The buyer's agent commits to the wire payload in the escrow, and a runtime posts it to the service as the body of `POST /` and of `POST /precheck`.

| Route | Called by | Answer |
|---|---|---|
| `POST /precheck` | a runtime, before the Claim | the hook: 200 `{"go":true,"reserved_ms":120000}`, or a refusal with its code |
| `POST /` | a runtime, after the Claim | the job: the confirmation of the order, or an error |
| `GET /lots.json` | anyone | the lots file |
| `GET /agent.json` | anyone | the manifest |
| `GET /healthz` | anyone | `{"ok":true}` while the service runs |

`POST /` and `POST /precheck` need the token that only the runtimes hold. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read. `GET /lots.json`, `GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`. A buyer sends its job to the runtime of its advert, on the runtime route `/v1/job` of the manifest, and never to the service.

### Request

The request JSON is the handoff of use case 1 (inventory reorder). It has the members of the first table, in this order, and no other. Its `document` is a purchase order, which has the members of the second table, in this order, and no other. A request that breaks a rule is refused with `bad_shape` (400), before any check.

Example. The tests of the job use this handoff. Its identifiers, references and digests are made up, so none of them is of a real escrow, agent or key.

```json
{
  "schema": "vector.usecase.handoff.v1",
  "use_case": "inventory-reorder",
  "sender_did": "did:vector:ecececececececececececececececececececececececececececececececec",
  "delegation": "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
  "document": {
    "schema": "vector.usecase.po.v1",
    "po_number": "run1-0001",
    "tenant": "run1",
    "sku": "GLV-NIT-M",
    "lot": "lot-medium",
    "quantity": 50,
    "needed_by": "2026-12-05",
    "supplier_did": "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    "advert_ref": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4#1",
    "stock_reading_sha256": "abababababababababababababababababababababababababababababababab"
  },
  "salt": "9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a",
  "approval": {
    "attestation": "9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b",
    "issuer_did": "did:vector:1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f"
  }
}
```

| Member | Rule |
|---|---|
| `schema` | `vector.usecase.handoff.v1` |
| `use_case` | `inventory-reorder`. The Order Desk takes the handoff of use case 1 (inventory reorder) only |
| `sender_did` | the DID of the agent of the buyer: `did:vector:` and 64 hex characters |
| `delegation` | the identifier of the delegation that paid for the order: 64 hex characters |
| `document` | the purchase order, with the members of the second table |
| `salt` | 64 hex characters, which are 32 bytes. The digest that the buyer approved is the SHA-256 of these 32 bytes followed by the canonical text of the purchase order |
| `approval` | `{ "attestation": "<64 hex characters>", "issuer_did": "did:vector:<64 hex characters>" }`: the approval of the buyer for this exact purchase order. It can be `null`, and the hook then refuses with `approval_not_found` |

| Member of the purchase order | Rule |
|---|---|
| `schema` | `vector.usecase.po.v1` |
| `po_number` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. A number counts without regard to case |
| `tenant` | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit |
| `sku` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit |
| `lot` | `lot-small`, `lot-medium` or `lot-large` |
| `quantity` | a whole number from 1 to 1000000 |
| `needed_by` | a date that exists, as `YYYY-MM-DD` |
| `supplier_did` | the DID of the supplier: `did:vector:` and 64 hex characters |
| `advert_ref` | `<transaction hash>#<output index>`: 64 hex characters, `#`, and an index of at most 6 digits |
| `stock_reading_sha256` | 64 hex characters: the digest of the stock reading that the buyer's agent read |

### What it checks before the Claim

The runtime asks the service before it claims an escrow. The question is `POST /precheck`, and this page calls it the hook. The hook makes 16 checks, one after the other, in the order of the table. The first check that fails ends the hook. Its answer is the refusal code of that check, with the status 403. A refusal comes before the Claim: the escrow stays open, nothing is claimed, nothing is paid, and the buyer reclaims the escrow after `deliver_by`.

| # | Check | Refusal code | Status | The rule |
|---|---|---|---|---|
| 1 | `sender_active` | `sender_not_active` | 403 | the sender has a record at the identity gateway, the record has not ended, and its status is Active. A record that the gateway suspends because no Accountable Party covers it gets `sender_unaccountable` |
| 2 | `sender_accountable` | `sender_unaccountable` | 403 | an Accountable Party covers the record of the sender now |
| 3 | `sender_key` | `sender_key_mismatch` | 403 | the key that posted the escrow is a key that the record of the sender lists with the delegation purpose. The runtime reads that key from the escrow, and the body never gives it |
| 4 | `delegation` | `delegation_invalid` | 403 | a live delegation has the identifier of the request, its delegate is the sender, and its delegate key is the key that posted the escrow |
| 5 | `delegation_usable` | `delegation_ended` | 403 | the delegation and each of its parents can be used now to hire. The check does not wait for confirmations |
| 6 | `vault_paid` | `not_vault_paid` | 403 | the escrow was paid from a vault of this delegation |
| 7 | `approval_found` | `approval_not_found` | 403 | the request has an approval, and its attestation is found and is authentic |
| 8 | `approval_type` | `approval_wrong_type` | 403 | the attestation is an approval (type 5) |
| 9 | `approval_subject` | `approval_wrong_subject` | 403 | the subject of the approval is the sender |
| 10 | `approval_issuer` | `approval_wrong_issuer` | 403 | the issuer of the approval is the root delegator of the delegation |
| 11 | `approval_valid` | `approval_revoked`, `approval_expired`, `approval_issuer_invalid` | 403 | the approval is valid now by the rule of the registry: it is not revoked, its time is not over, and its issuer was valid when it issued it |
| 12 | `approval_digest` | `approval_digest_mismatch` | 403 | the digest of the approval is the digest of the purchase order and the salt that the Order Desk received |
| 13 | `for_this_supplier` | `not_for_this_supplier` | 403 | the purchase order names this agent (`AGENT_DID`) as its supplier |
| 14 | `lot` | `lot_mismatch` | 403 | the advert of the order is the advert of the escrow, and the lot of the order is the `model` of that advert |
| 15 | `quantity` | `quantity_mismatch` | 403 | the quantity is the size of that lot for the SKU in the lots file. A SKU that the file does not list is a mismatch |
| 16 | `not_duplicate` | `duplicate_po` | 403 | the order book holds no order for the tenant and the purchase order number. A number counts without regard to case |

When every check passes, the hook answers 200 `{"go":true,"reserved_ms":120000}`. The service keeps the record of the checks for 300 s, and it reserves the job slot for that escrow for 120 s. A source that the hook cannot read (the identity gateway, the ledger or the order book) is never a pass: the hook answers 503 `check_unavailable`. The runtime waits 10000 ms for the hook, and reads silence as a refusal.

The runtime sends six headers of context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. The hook needs all six, and a call with none, with some, or with a bad one gets 400 `bad_context`. The key of the escrow, the advert and the lot come from these headers and never from the body: the checks `sender_key`, `delegation`, `lot` and `quantity` read them there.

When the check `approval_digest` fails, the approval is for another purchase order than the one in the handoff. The hook refuses first, with `approval_digest_mismatch`. Then the service starts a challenge in the background, against the open claim of the sender: it publishes an evidence document and opens the challenge on the ledger. The challenge names the statement S1 of the claim of the Reorder Agent: "An order this agent places is the purchase order whose digest its hirer approved." The answer of the hook never waits for the challenge and never holds a reference to it, because a challenge takes two transactions and the runtime waits only 10000 ms. The reference of the challenge goes to the log of the service and to the journal of its dispute code, never to the message of the refusal. A challenge needs an open claim of the sender: when there is none, the service files nothing, and its log names the code `no_open_claim`.

### What it does

After the Claim the runtime posts the job to the service. The job has a deadline of 300000 ms after its request arrives, and it runs these steps in this order. A failure ends the job with an error, and no later step runs.

1. The job takes the record of the checks that the hook kept for its escrow, and it compares the hash of its own body with the hash that the hook checked. A job with no record, or with the record of another body, fails with `precheck_missing` and places no order.
2. It gets an X.509-SVID for the service key from the identity gateway.
3. It reads `GET /t/{tenant}/supplier/catalogue/{sku}` at the supplier portal, with the SVID. The tenant and the SKU are those of the purchase order.
4. Decision `availability`: the service hires one model from the Vector marketplace. The model gets a fixed instruction, the purchase order and the catalogue entry, and it answers `{ "confirm": true | false, "ship_by": "<date>", "note": "..." }`.
5. When the answer is `confirm: true`, the job places one order with `POST /t/{tenant}/supplier/orders` and the same SVID. The order has the purchase order number, the hash of the purchase order, the SKU, the lot, the quantity and the ship-by date.
6. The job writes the order book, after the portal took the order, and it answers with the confirmation.

When the model answers `confirm: false`, the job refuses with `cannot_supply` (403) after step 4. It places no order, and nothing is paid. The message of the refusal holds a fixed sentence and the first 120 characters of the note of the model. The escrow is Claimed, and it stays Claimed until the buyer reclaims it after `deliver_by`.

The job places at most one order, and nothing retries the order call. The portal refuses a second order for the same number, and the service answers `duplicate_po` (403). A job whose caller hangs up stops before the order is placed, because the service never places an order that nobody reads. The job places no order when the order call could end less than 30 s before `deliver_by`, because the runtime stops waiting then. One call to the supplier portal takes 20000 ms at most.

### Response

`schema` is `vector.usecase.order-confirmation.v1`. A job that places the order answers with the confirmation, as the body of the answer, serialised once, with its members in the order of the table below. A job that does not place it answers with an error (see Errors) and no confirmation.

Example. The test of the golden run of the job gives exactly this confirmation for the handoff above, with stand-ins for the identity gateway, the supplier portal and the model supplier. It is an illustration and not a recorded run: its references, hashes, key hash and signature are of no escrow, no supplier and no key.

```json
{
  "schema": "vector.usecase.order-confirmation.v1",
  "outcome": "done",
  "po_number": "run1-0001",
  "po_sha256": "ee530a49d9ead8b2a2ecbd3896fc6b018e0050a0bf24ddf4dad7f88775585cbc",
  "sku": "GLV-NIT-M",
  "lot": "lot-medium",
  "quantity": 50,
  "ship_by": "2026-11-28",
  "order_id": "SO-run1-0001",
  "sender": {
    "did": "did:vector:ecececececececececececececececececececececececececececececececec",
    "organisation": "buyer.example",
    "organisation_verified": true
  },
  "approval": {
    "attestation": "9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b",
    "issuer_did": "did:vector:1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f",
    "valid_until": "2026-11-24T10:00:00.000Z"
  },
  "checks": {
    "sender_active": true,
    "sender_accountable": true,
    "sender_key": true,
    "delegation": true,
    "delegation_usable": true,
    "vault_paid": true,
    "approval_found": true,
    "approval_type": true,
    "approval_subject": true,
    "approval_issuer": true,
    "approval_valid": true,
    "approval_digest": true,
    "for_this_supplier": true,
    "lot": true,
    "quantity": true,
    "not_duplicate": true
  },
  "decisions": [
    {
      "name": "availability",
      "choice": {
        "confirm": true,
        "ship_by": "2026-11-28",
        "note": "The catalogue holds enough boxes for this lot."
      },
      "reasoning": "The catalogue shows 5000 boxes available and the lot needs 50, so the order can ship in three days.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3b3#0",
          "escrow_ref": "4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c#0",
          "supplier_pkh": "7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d",
          "receipt": {
            "escrow_ref": "4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c4c#0",
            "supplier_pkh": "7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d",
            "prompt_hash": "3333333333333333333333333333333333333333333333333333333333333333",
            "response_hash": "4444444444444444444444444444444444444444444444444444444444444444",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 412,
            "completion_tokens": 58,
            "wallclock_ms": 2140
          },
          "receipt_signature": "8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e8e",
          "verification": {
            "escrow_ref_matches": true,
            "response_hash_matches": true,
            "supplier_key_matches": true,
            "signature_valid": true,
            "on_chain_hash_matches": true,
            "prompt_hash_matches": true,
            "model_matches": true,
            "fields_match": true
          }
        },
        "accepted": "confirmed"
      }
    }
  ],
  "fault_mode": ""
}
```

| Member | Content |
|---|---|
| `schema` | `vector.usecase.order-confirmation.v1` |
| `outcome` | always `done`: a refusal or a failure is an error, never a confirmation |
| `po_number` | the number of the purchase order |
| `po_sha256` | the SHA-256 of the canonical text of the purchase order that the Order Desk received, with no salt |
| `sku` | the SKU of the purchase order |
| `lot`, `quantity` | the lot and the quantity of the order that the Order Desk placed. In a clean run they are the lot and the quantity of the purchase order |
| `ship_by` | the date by which the supplier ships the order, as the model gave it |
| `order_id` | the identifier that the supplier portal gave the order |
| `sender` | the DID of the sender, the organisation that the Accountable Party names (or `null`), and whether the identity gateway verified it. The organisation is recorded, and it is never a reason to refuse |
| `approval` | the attestation of the approval, the DID of its issuer (or `null`), and the end of its validity as a time in UTC (or `null`) |
| `checks` | the 16 checks, each `true`, in the order of the table of the hook |
| `decisions` | one decision, `availability`: its choice, its reasoning, and the hire of the model supplier with the sub-receipt that the service verified (`inference`) |
| `fault_mode` | the setting of the fault switch: the empty text in a clean run |

### The lots file

`GET /lots.json` answers the lots file: the size of each lot for each SKU. It needs no token. The manifest holds its address and its SHA-256 in `behaviour.lots`, and the SHA-256 is the hash of these bytes as the service serves them. The check `quantity` reads the same file, and the agent of a buyer reads it to choose the lot and the quantity of its order.

```json
{
  "schema": "vector.usecase.lots.v1",
  "items": [
    { "sku": "GLV-NIT-M", "lots": { "lot-small": 10, "lot-medium": 50, "lot-large": 200 } },
    { "sku": "SYR-10ML", "lots": { "lot-small": 25, "lot-medium": 100, "lot-large": 400 } },
    { "sku": "MSK-N95", "lots": { "lot-small": 20, "lot-medium": 100, "lot-large": 400 } }
  ]
}
```

### Errors

A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.

- The 401 has the code and no message.
- A refusal of status 500 or more gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer, and the detail is the operator's. `busy` and `shutting_down` have a fixed message of their own.
- The message of `cannot_supply` holds a fixed sentence and the first 120 characters of the note of the model.
- Anything else is 500 `{"error":"internal"}` with no detail. The cause is in the log.
- A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow Claimed: the buyer reclaims it after `deliver_by`, and nothing is paid for work that was not done. A job that fails before the order is placed places no order.
- One job runs at a time. A job, or a call of the hook for another escrow, that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts.
- While a job runs, the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the fetch of the runtime gives up after 300 s of silence.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that is not a handoff of use case 1 with a purchase order), `bad_context` (the six headers of the context are missing, some are missing, or one is not well formed) |
| 401, the caller | `unauthorized` |
| 403, the hook, before the Claim | `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `approval_not_found`, `approval_wrong_type`, `approval_wrong_subject`, `approval_wrong_issuer`, `approval_revoked`, `approval_expired`, `approval_issuer_invalid`, `approval_digest_mismatch`, `not_for_this_supplier`, `lot_mismatch`, `quantity_mismatch`, `duplicate_po` |
| 403, the job, after the Claim | `cannot_supply` (the model says that the lot cannot be supplied), `duplicate_po` (the supplier portal holds an order for the number already) |
| 409, the service is busy | `busy` |
| 422, the job | `deadline` (the caller hung up, or too little time was left to place the order) |
| 500, the service | `precheck_missing` (the job has no record of passed checks for its body), `store_write_failed` (the order book or the record of the model hire cannot be written), `internal` |
| 502, a third party | `svid_failed` (the identity gateway gave no X.509-SVID), `mock_system_failed` (the supplier portal did not take the call), `inference_failed` (the model hire failed), `model_output_invalid` (the answer of the model cannot be used) |
| 503, the service cannot answer now | `check_unavailable` (the hook could not read a source), `shutting_down` (the service is stopping) |

## What the receipt commits to

The service signs no receipt. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key of the runtime that took the job: one of the three |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the confirmation exactly as the service returned them |
| `model` | the lot of the advert: `lot-small`, `lot-medium` or `lot-large` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The token counts of the model hire are in the sub-receipt under `decisions[0].inference.sub_job` |
| `wallclock_ms` | how long the service call took |

The confirmation is the committed output. So the receipt commits the order as the Order Desk understood it (the SKU, the lot, the quantity, the ship-by date and the order id), the hash of the purchase order that it received, who sent it and under which approval, the 16 checks, and the availability decision with its reasoning and the sub-receipt of the model supplier. It does not commit to any goods being shipped: there are no goods.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The Order Desk stakes a Module-1 claim for each run. The claim has three statements. The manifest holds the same three texts in `behaviour.claim`.

| Id | Statement |
|---|---|
| S1 | A confirmation names the SKU, the lot and the quantity of the purchase order it answers. |
| S2 | This agent places one order per purchase order number. |
| S3 | This agent takes no purchase order without a valid approval by the buyer whose delegation paid for it. |

S1 is the statement that the fault `confirm_wrong_lot` breaks. A buyer's agent that declines a confirmation on the SKU, the lot or the quantity challenges the claim on S1.

## Fault switch

`FAULT_MODE=confirm_wrong_lot`: the confirmation names another lot and quantity than the purchase order, and the order that the service places has that wrong lot. The wrong lot of `lot-small` is `lot-medium`. The wrong lot of any other lot is `lot-small`. The quantity is the size of the wrong lot for the SKU in the lots file. For the purchase order of the example under Request, the confirmation of a fault run names `lot-small` and the quantity 10, and its `fault_mode` is `confirm_wrong_lot`. A failure run uses the switch, to show that the agent of the buyer refuses a confirmation that breaks S1.

The switch is empty in a clean run. Any other value stops the start of the service. The switch changes what the job sends and never a check: the hook does not know that it exists. It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value. Each result returns the active value as `fault_mode`, its last member.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

The purchase order, the approval reference and the catalogue entry are held in memory while a job runs, and none of them is kept after the job. The service writes to its state directory the bookkeeping of the escrows that it posts for its model call, the order book (the tenant, the purchase order number and the order id of each order that it placed) and the journal of its challenges. On a digest mismatch it publishes an evidence document and a challenge on the ledger. The log carries job outcomes, counts and codes, never a request, a catalogue entry or a key. All the data is synthetic. What leaves to third parties:

| Party | What it receives |
|---|---|
| the identity gateway (the resolution of the DID of the sender, and the request for the X.509-SVID) | the DID of the sender, in the hook. The DID of this agent and a request that the service key signs, for the X.509-SVID, in the job |
| the ledger, read only (the delegation, the escrow paid from a vault, the approval attestation) | the reads of the checks: the identifiers of the delegation, the escrow and the approval attestation |
| the supplier portal of the mock service (the catalogue read and the order, with the X.509-SVID) | the SKU, for the catalogue read. The purchase order number, its hash, the SKU, the lot, the quantity and the ship-by date, for the order. Both calls present the X.509-SVID as the client certificate |
| a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision: the purchase order and the catalogue entry) | one job: the instruction of the decision, the purchase order and the catalogue entry, and the reference of the escrow |
| the ledger, written only after a digest mismatch (the evidence document and the challenge) | the evidence document (the statement S1 of the claim of the sender, the digest of the approval, the digest of the purchase order that was sent, and the references of the claim, the two agents, the escrow and the approval; no text of the purchase order and no salt) and the challenge |

## Known gaps

The manifest states these nine, in this order, word for word. A test keeps them equal to `GAPS` in `agents/order-desk/src/serve/gaps.ts`.

- The model decides whether the lot can be supplied. Nothing in this agent overrides it.
- The checks read the ledger and the gateway as they are at that moment. A delegation or approval ended a moment later is not seen.
- The organisation of the sender is reported, not required.
- If the buyer's agent does not accept a confirmation, this agent's operator can still release the escrow 600 s after the Submit. A verdict against this agent does not change that.
- An order refused or not supplied is not paid, and leaves no signed record of the refusal except, on a digest mismatch, the evidence of the challenge.
- The price of a lot is a stand-in for its size.
- The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.
- What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 1, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.
- This service has a fault switch for failure runs with these possible values: confirm_wrong_lot (the confirmation names another lot and quantity than the purchase order, and the order that it places has the wrong lot); this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.

## How to hire it

No advert exists yet, so no buyer can hire the Order Desk today.

A buyer's agent hires the Order Desk from the vault of a delegation, with an approved purchase order. A hire from a wallet, or with no approval of this exact purchase order, is refused by the hook before the Claim. To see the Order Desk work, hire the [Reorder Agent](reorder-agent.md). It proposes a purchase order for a SKU. When its hirer approves the order, it pays the advert of the approved lot from the vault and sends the handoff to the Order Desk. The steps of that hire are on the page of the Reorder Agent.

## Changelog

- 0.1.0, 2026-11-23: built

## Links

- Manifest: `GET /agent.json` on the public URL of each runtime, once the agent is deployed. The service renders it from its environment when it starts. The template is [agents/order-desk/agent.json.template](../agents/order-desk/agent.json.template).
- Lots file: `GET /lots.json`, with the bytes of [agents/order-desk/lots.json](../agents/order-desk/lots.json).
- Source: [agents/order-desk](../agents/order-desk)
- Deploy pack: [deploy/server/RUNBOOK-order-desk.md](../deploy/server/RUNBOOK-order-desk.md)
- Buyer-side agent: [Reorder Agent](reorder-agent.md)
