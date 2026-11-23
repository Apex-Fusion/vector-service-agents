# Reorder Agent

Capability `supplychain.reorder.po.v1`. For a buying organisation: reads the stock of one SKU, proposes a purchase order for one lot from a named supplier, and, once the organisation has approved the order, places it from the vault of the organisation and records it.

## Status

PROPOSED (built, not deployed). Since 2026-11-23.

Nothing on this page is LIVE or DEPLOYED.

The service is built. Its tests run the whole path against stand-ins for the chain, the marketplace, the identity gateway, the mock systems and the model supplier, with no network. The agent has no registry record, no advert and no job yet. It is the buyer-side agent of use case 1 (inventory reorder). Its counterparty is the Order Desk.

## Identity

This agent has no registry record yet.

The table gives the design of the record. A value that the registration fixes reads "assigned at registration".

| Field | Value |
|---|---|
| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |
| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |
| Supplier key | the key of the runtime, listed in the record for the authentication and transaction purposes. It signs the receipts, the Claims and the Submits. The service never holds it. The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`. The service does not start unless the public key hashes to the key hash |
| Service key | a key of its own, listed in the record for the authentication and transaction purposes. It pays the model hires, signs the claim and the challenges of the agent, and signs the subject token of the agent. The manifest publishes its key hash as `keys.buyer_pkh` |
| Delegation keys | two keys, listed in the record for the delegation purpose. The manifest publishes their key hashes as `keys.delegation_pkhs`. A delegation of a hirer names one of them as its delegate key. The key of the live delegation signs the vault Pay, the Accept and the sub-delegation of a job. Each key has a wallet of its own |
| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |
| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |
| Subagent | `stock-reader`: its own record, with this agent as its parent. It has its own authentication key and its own delegation key, which are the other two keys of the service. It has no endpoint, and nobody can hire it. `STOCK_READER_DID` names it |
| Public URL | planned: `https://mp-suppliers-reorder.vector.apexfusion.org`, the origin of the runtime in the pack. The agent has no advert yet |
| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |
| Claim | a Module-1 claim for each run, staked with the service key. See Claim statements |

## Capability id

`supplychain.reorder.po.v1`

The model string in the advert and in every receipt is `reorder-agent-v1`.

The agent runs behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, asks the service whether to take the job, calls the service, signs the receipt and submits its hash. The service does the work. It holds five keys and no API key of any third party. It does not hold the supplier key: it knows only its key hash and its public key.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 3000000 | 3.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 5000000 | 5.000000 |

The price is the default of `ADVERT_PRICE_LOVELACE`. Each bond is fixed in the code. The manifest publishes the three amounts in `terms`.

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 1800000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 1680000 ms (120 s inside the window) |
| Job deadline, set by the service when a request arrives | 1620000 ms (60 s inside the service timeout) |
| Request | at most 900000 bytes of request JSON; `sku` 1 to 64 characters; `tenant` 1 to 48 characters |
| Sub-delegation | `stock-reader` gets its token after 30 confirmations of the sub-delegation |
| Model calls | at most one in `propose` (decision `reorder`) and at most one in `execute` (decision `accept_delivery`) |
| Jobs at a time | one: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |

**The request limit.** The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload. The wire payload is the request JSON written as a string inside a one-message array (see Interface). The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body. A buyer calls the runtime with the wire payload inside a second JSON object, so the request JSON is escaped two times, and each quote mark and each backslash costs more bytes each time. A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes. The two requests of this agent are a few kilobytes, so they are far below both limits.

**The money.** A hire of either operation locks the price and both bonds, 5 units. On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer. If the buyer does not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds. If the supplier never submits, the buyer reclaims after `deliver_by`. The order is paid from the vault of the hirer: the vault pays the price and both bonds of the advert of the lot, and the value limit of the delegation caps that payment. The delegation key of the agent pays the fees of that Pay and of the Accept.

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The runtime claims the escrow and posts the wire payload unchanged to the service as the HTTP body. The service reads the request JSON from its `content`, and it answers with the result as the response body. The runtime hashes that body into the receipt.

The marketplace tools of the hosted server wrap the request JSON into the wire payload for you.

The agent has two operations. `propose` reads the stock and proposes a purchase order. `execute` places an order that the hirer approved.

### Request

A request is one JSON object. Its member `op` is `propose` or `execute`. It has the members of that operation and no other member. A request that breaks a rule of the fields below is refused with `bad_shape` (400) before the job does anything, so it locks nothing of the service's. One exception is the tenant of `execute`: the job checks it against its order (`po_not_for_tenant`).

**`propose`.** The agent reads the stock of one SKU and proposes an order for one lot from the Order Desk that you name.

| Field | Rule |
|---|---|
| `op`, required | `propose` |
| `authority`, required | `principal_did`: the DID of the principal who gave the delegation, `did:vector:` and 64 lower-case hex characters. `delegation`: the identifier of the delegation that names this agent as its delegate, 64 hex characters. The authority has no vault: the agent finds the Live vault of the delegation itself. |
| `tenant`, required | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit. It names the tenant of the mock systems. |
| `sku`, required | 1 to 64 characters: letters, digits, dot, hyphen and underscore, starting with a letter or a digit. |
| `supplier_did`, required | the DID of the Order Desk that takes the order. |

```json
{
  "op": "propose",
  "authority": {
    "principal_did": "did:vector:1b16a4ad53d776f67c39eb1538f2172505adce6226183558026ab5bc8e86d726",
    "delegation": "5363f0e4a784eec0910f52303a2c99605f0e67ced0562171b341102c7100e448"
  },
  "tenant": "demo",
  "sku": "GLV-NIT-M",
  "supplier_did": "did:vector:26e09135399b3d890a656ca1322416c9da0dcc83cdc690eb0f531f9c018862cf"
}
```

**`execute`.** The agent places the order that you approved.

| Field | Rule |
|---|---|
| `op`, `authority`, `tenant`, required | as for `propose`, with `op` set to `execute`. The tenant must be the tenant of the order. |
| `proposal`, required | the proposal that `propose` returned: `document` (the purchase order), `salt` (64 hex characters) and `proposal_digest` (64 hex characters). The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document. A digest that is not the digest of the salt and the document is refused with `bad_shape`. |
| `approval`, required | the approval of the hirer for the digest of the proposal, or `null`. It has two members: `attestation`, the identifier of the approval (64 hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 hex characters). The agent does not check the approval. It passes it on, and the Order Desk refuses an order with no valid approval. |

```json
{
  "op": "execute",
  "authority": {
    "principal_did": "did:vector:1b16a4ad53d776f67c39eb1538f2172505adce6226183558026ab5bc8e86d726",
    "delegation": "5363f0e4a784eec0910f52303a2c99605f0e67ced0562171b341102c7100e448"
  },
  "tenant": "demo",
  "proposal": {
    "document": {
      "schema": "vector.usecase.po.v1",
      "po_number": "demo-1",
      "tenant": "demo",
      "sku": "GLV-NIT-M",
      "lot": "lot-medium",
      "quantity": 50,
      "needed_by": "2026-12-01",
      "supplier_did": "did:vector:26e09135399b3d890a656ca1322416c9da0dcc83cdc690eb0f531f9c018862cf",
      "advert_ref": "279b01cec9396850f1f428a4975693e4746b79999b20e4ae04f5f9eb5be39b83#0",
      "stock_reading_sha256": "11532e38e5314a47c1b641dad8e7ab340f400f1fe1290eb72283270119f1b3a5"
    },
    "salt": "a75b603eaeddba1af8b3954178b908cc85c69478ccfaefbd406878236651eb68",
    "proposal_digest": "c4ce0d0b1ca97ecf97714f0f784661043876e3a0255a14c006a5245eadc9cd15"
  },
  "approval": {
    "attestation": "3a9cb075303323050d6e7a3d7979bda1e8020daa3d85d59b4ec6312d95bd4072",
    "issuer_did": "did:vector:1b16a4ad53d776f67c39eb1538f2172505adce6226183558026ab5bc8e86d726"
  }
}
```

What `propose` does, in this order, under its deadline:

1. It reads the delegation. A delegation that names another agent as its delegate is refused with `delegation_not_mine` (400). A delegation that the ledger does not show ends the job with `delegation_not_found`, and a delegate key that the agent does not hold ends it with `delegation_key_unknown`.
2. It reads the Order Desk that `supplier_did` names, before it sends anything to the chain. The indexer lists three Active adverts of the Order Desk, one for each lot: `lot-small`, `lot-medium` and `lot-large`. The chain shows each advert unspent and Active. The manifest at the address of the adverts has the hash that the adverts hold. The lots file that the manifest names has the hash that the manifest holds, and it lists the SKU. A failure ends the job with `supplier_not_listed`, `supplier_manifest_invalid`, `supplier_lots_invalid`, `sku_not_in_lots` or `supplier_unavailable`.
3. It sub-delegates `erp.stock.read` on the ERP resource of the tenant to `stock-reader`: one hop below the delegation of the hirer, with no value. It waits for 30 confirmations. Then `stock-reader` asks the identity gateway for a token and reads `GET /t/<tenant>/erp/stock/<sku>`. The reading must be for the SKU of the request. The job ends the sub-delegation in every case, also after a failure. The janitor of the service ends a sub-delegation that a job leaves.
4. It asks one model for the lot (decision `reorder`). The model reads the stock reading, the three lot sizes and the date of today, and answers `{ lot, quantity, needed_by }`. The service checks the shape of the answer and nothing else, and it keeps the choice as the model gave it.
5. It builds the purchase order and returns the proposal: the document, a new salt and the digest. The job pays no order and writes nothing to the PO store. It pays for the hire of the model with the service key, and for the sub-delegation with the delegation key.

What `execute` does, in this order, under its deadline:

1. It checks the document. The document must be a purchase order (`bad_document` otherwise) for the tenant of the request (`po_not_for_tenant` otherwise).
2. It reads the delegation as `propose` does: `delegation_not_mine` (400) for a delegation that names another agent, and `delegation_key_unknown` for a delegate key that the agent does not hold.
3. It builds the handoff from the document, the salt and the approval as the request gave them. It refuses a proposal whose digest is not the digest of its document and its salt (`bad_shape`). It checks the size of the handoff before the Pay: at most 900000 bytes of wire payload, and at most 1048576 bytes in the body of the call to the runtime of the Order Desk. A larger handoff is refused with `request_too_large` (400).
4. It hires the advert that the document names in `advert_ref`, one time, with one Pay from the Live vault of the delegation, signed by the delegation key. It never retries the Pay. A delegation with no Live vault ends the job with `no_live_vault`, and a delegation with several ends it with `several_live_vaults`. A Pay that the ledger refuses ends the job with `vault_refused`.
5. It sends the handoff to the Order Desk. The Order Desk checks the order before it claims the escrow. When it refuses, the result is `refused_by_counterparty` with its code, and the escrow stays Open until the janitor of the key reclaims it after `deliver_by`. The one refusal that comes after the Claim is `cannot_supply`: the escrow then stays Claimed.
6. It runs the eight checks on the receipt of the Order Desk. Then it checks the confirmation in code: it must be an order confirmation (`confirmation_invalid`), and it must answer this order by its number and its hash (`confirmation_not_for_order`). Neither check asks the model.
7. It asks one model whether to accept the delivery (decision `accept_delivery`). The model reads the SKU, the lot and the quantity of the order and of the confirmation, and nothing else of either. It answers `{ accept, mismatch }`, and the agent accepts exactly when `mismatch` is empty.
8. On accept, it accepts the escrow with the delegation key and writes the order to the PO store: `POST /t/<tenant>/po`, with a token for the action `po.write`. The result is `completed` when the store records the order (201), and `refused_by_system` when the store refuses it.
9. When the model does not accept, it does not accept the escrow. It publishes the evidence, challenges the open claim of the Order Desk with the first statement of that claim, and returns `disputed`.

### Response

`propose` answers with a proposal, and `execute` answers with a result. Each answer is the body of a 200 response, written once, with the member `fault_mode` last. A call that the service refuses is an error (see Errors).

The proposal has these members. The example after the table is the proposal for the request above.

| Member | Content |
|---|---|
| `schema` | `vector.usecase.proposal.v1` |
| `use_case` | `inventory-reorder` |
| `decisions` | the decision of the job, with its reasoning and, under `inference.sub_job`, the signed receipt of the model supplier that gave it |
| `sub_jobs` | the model hires of the job: each one is the `sub_job` of a decision |
| `document` | the purchase order. It is `null` when the job fails before it has one |
| `salt` | the salt of the proposal. It is `null` when `document` is `null` |
| `proposal_digest` | the digest of the salt and the document, which the hirer approves. It is `null` when `document` is `null` |
| `outcome`, `reason`, `exit_state` | `proposed`, `null` and `null` for a proposal. `failed`, a code and `Failed` for a job that makes none |
| `fault_mode` | always the empty text |

```json
{
  "schema": "vector.usecase.proposal.v1",
  "use_case": "inventory-reorder",
  "decisions": [
    {
      "name": "reorder",
      "choice": {
        "lot": "lot-medium",
        "quantity": 50,
        "needed_by": "2026-12-01"
      },
      "reasoning": "The stock of 60 is below the threshold of 100, and the use is 12 a day over a lead time of 7 days. The medium lot of 50 brings the stock back above the threshold.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "3786386dd3d7f347eef1183eac870d33b200316be653d20386d02422622f0f16#0",
          "escrow_ref": "a5d90b12639af1cc5cc92ab8c51e7f5b7db03a6dd7d841ebc62f0623663d108c#0",
          "supplier_pkh": "ab0b3df6569593c7c0c43540270290390a3a743e1b28a588cfa50a61",
          "receipt": {
            "escrow_ref": "a5d90b12639af1cc5cc92ab8c51e7f5b7db03a6dd7d841ebc62f0623663d108c#0",
            "supplier_pkh": "ab0b3df6569593c7c0c43540270290390a3a743e1b28a588cfa50a61",
            "prompt_hash": "32b881ad789389e8c64cd3748bb5a4e20fa2c45728f855528597441380968eb7",
            "response_hash": "4858a764f149ec8de53a25af894f90c2f375ad0c2d0cd3cb43d6d65147cc715d",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 412,
            "completion_tokens": 58,
            "wallclock_ms": 2140
          },
          "receipt_signature": "6a2a25f1c50e182bbdd9d674acd89271cca9ef388dd7ba316cd909fc20a146dd8695fe5fb83047f7c1eb06a88d2a56c72373a5748aaad865a0ed4a856ec8f619",
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
  "sub_jobs": [
    {
      "capability_id": "llm.text.generate.v1",
      "advert_ref": "3786386dd3d7f347eef1183eac870d33b200316be653d20386d02422622f0f16#0",
      "escrow_ref": "a5d90b12639af1cc5cc92ab8c51e7f5b7db03a6dd7d841ebc62f0623663d108c#0",
      "supplier_pkh": "ab0b3df6569593c7c0c43540270290390a3a743e1b28a588cfa50a61",
      "receipt": {
        "escrow_ref": "a5d90b12639af1cc5cc92ab8c51e7f5b7db03a6dd7d841ebc62f0623663d108c#0",
        "supplier_pkh": "ab0b3df6569593c7c0c43540270290390a3a743e1b28a588cfa50a61",
        "prompt_hash": "32b881ad789389e8c64cd3748bb5a4e20fa2c45728f855528597441380968eb7",
        "response_hash": "4858a764f149ec8de53a25af894f90c2f375ad0c2d0cd3cb43d6d65147cc715d",
        "model": "deepseek/deepseek-v4-flash",
        "prompt_tokens": 412,
        "completion_tokens": 58,
        "wallclock_ms": 2140
      },
      "receipt_signature": "6a2a25f1c50e182bbdd9d674acd89271cca9ef388dd7ba316cd909fc20a146dd8695fe5fb83047f7c1eb06a88d2a56c72373a5748aaad865a0ed4a856ec8f619",
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
    }
  ],
  "document": {
    "schema": "vector.usecase.po.v1",
    "po_number": "demo-1",
    "tenant": "demo",
    "sku": "GLV-NIT-M",
    "lot": "lot-medium",
    "quantity": 50,
    "needed_by": "2026-12-01",
    "supplier_did": "did:vector:26e09135399b3d890a656ca1322416c9da0dcc83cdc690eb0f531f9c018862cf",
    "advert_ref": "279b01cec9396850f1f428a4975693e4746b79999b20e4ae04f5f9eb5be39b83#0",
    "stock_reading_sha256": "11532e38e5314a47c1b641dad8e7ab340f400f1fe1290eb72283270119f1b3a5"
  },
  "salt": "a75b603eaeddba1af8b3954178b908cc85c69478ccfaefbd406878236651eb68",
  "proposal_digest": "c4ce0d0b1ca97ecf97714f0f784661043876e3a0255a14c006a5245eadc9cd15",
  "outcome": "proposed",
  "exit_state": null,
  "reason": null,
  "fault_mode": ""
}
```

The example is an illustration and not a recorded run. Its references, hashes, key hash and signature are made from labels, and they belong to no escrow, no supplier and no key. The stock reading of the example, in canonical form, is `{"daily_usage":12,"lead_time_days":7,"on_hand":60,"open_orders":0,"sku":"GLV-NIT-M","threshold":100}`. Its sha256 is the `stock_reading_sha256` of the order.

The purchase order, the `document`, has these members:

| Document member | Content |
|---|---|
| `schema` | `vector.usecase.po.v1` |
| `po_number` | the tenant, a hyphen and a counter that the service keeps for each tenant |
| `tenant`, `sku`, `supplier_did` | those of the request |
| `lot` | `lot-small`, `lot-medium` or `lot-large`, as the model chose |
| `quantity` | the quantity that the model chose. The Order Desk refuses a quantity that is not the size of the lot |
| `needed_by` | the date that the model chose, as `YYYY-MM-DD` |
| `advert_ref` | the advert of the Order Desk for that lot |
| `stock_reading_sha256` | the sha256 of the canonical JSON of the stock reading that the model read |

The service does not hold the choice of the model to the size of the lot or to the date of today. The hirer reads the order before the approval.

The result of `execute` has these members:

| Result member | Content |
|---|---|
| `schema` | `vector.usecase.result.v1` |
| `use_case` | `inventory-reorder` |
| `proposal_digest` | the digest of the proposal that the hirer approved |
| `handoff` | the hire of the Order Desk, or `null` when no escrow was posted. Its members: `counterparty_did`, `advert_ref`, `escrow_ref`, `paid_from_vault`, `receipt`, `receipt_signature`, `verification`, `result` (the confirmation that the Order Desk returned) and `accepted` (`confirmed`, `pending` or `no`) |
| `writes` | each call that changed a mock system, with `system`, `route`, `status` and `ref` |
| `decisions` | the decision on the delivery, when the model made one, with its reasoning and the sub-job that bought it |
| `outcome`, `reason`, `exit_state` | see Outcomes |
| `challenge` | `null`, or the challenge that the agent filed: `claim`, `evidence` and `challenge` |
| `fault_mode` | always the empty text |

### Outcomes

The outcome and the exit state of an `execute` result follow one rule. The exit state is `Completed`, `Rejected`, `Expired`, `Cancelled`, `Escalated` or `Failed`.

| Outcome | Exit state | When |
|---|---|---|
| `completed` | `Completed` | the Order Desk delivered, the model accepted the delivery, and the PO store recorded the order |
| `vault_refused` | `Cancelled` when the hirer ended the delegation, else `Failed` | the ledger refused the Pay from the vault. The `reason` is the evaluation error of the node |
| `refused_by_counterparty` | `Rejected`, but `Escalated` for `approval_digest_mismatch`, `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | the Order Desk refused the order. The `reason` is its code |
| `refused_by_system` | `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | a mock system refused a call. The `reason` is its code |
| `disputed` | `Escalated` when the agent filed a challenge, else `Failed` | the model did not accept the delivery. Without a challenge, the `reason` is the code of the step that failed, such as `no_open_claim` |
| `failed` | `Failed` | any other end. The `reason` is a code |

A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.

### Errors

A call that the service refuses before it does any work is `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code. A fault of the service (500) gets fixed words, and the whole message is in the log.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over a limit of Terms), `bad_shape` (a request that breaks a rule of Request), `bad_context` (a call to `POST /precheck` with a missing or wrong context header), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token of the service) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 503 | `shutting_down` (the service is stopping) |
| 500 | `internal` |

The codes that the agent itself writes as the `reason` of a `failed` result are these. The code of a mock system and a code of the hire kit can stand there too.

| Reason | What it says |
|---|---|
| `delegation_not_found`, `delegation_key_unknown` | the ledger shows no delegation with that identifier, or the delegation names a delegate key that the agent does not hold |
| `ledger_unavailable` | a read of the ledger gave no answer in time |
| `supplier_not_listed`, `supplier_manifest_invalid`, `supplier_lots_invalid`, `sku_not_in_lots`, `supplier_unavailable` | `propose` cannot read the Order Desk (step 2 of `propose`) |
| `stock_reading_mismatch`, `stock_reading_invalid`, `stock_read_timeout` | the stock reading is for another SKU, it is no stock reading, or it did not come in time |
| `mock_system_failed`, `token_failed` | a mock system did not take a call, or the identity gateway gave no token |
| `inference_failed`, `model_output_invalid`, `decision_mismatch` | the hire of the model failed, its answer is not a choice, or the choice that the job built is not the choice that the decision records |
| `no_live_vault`, `several_live_vaults` | `execute` found no Live vault under the delegation, or more than one |
| `confirmation_invalid`, `confirmation_not_for_order` | the answer of the Order Desk is no order confirmation, or it answers another order |
| `decision_failed`, `decision_timeout`, `delivery_not_recordable` | the decision on the delivery could not be made, did not end in time, or the delivery cannot be written as a record |
| `po_not_for_tenant`, `bad_document` | the order is for another tenant than the request, or the document is no purchase order |
| `pay_unconfirmed`, `hire_interrupted`, `decision_error` | the Pay was sent and not seen confirmed, or an error ended the hire after the Pay was confirmed |
| `store_write_failed`, `deadline`, `aborted`, `internal` | a record could not be written on the volume, the job ran out of its time, the caller hung up, or the service failed |

A failure of the sub-delegation of `stock-reader` is `sub_delegation_` and the code of the failure, such as `sub_delegation_parent_not_live`. A failure of its token is `token_` and the code of the failure, such as `token_delegation_too_young`.

### The co-sign route

`POST /cosign/delegate` is an open route of the service: it needs no token, and it takes no job slot. The body is `{ "transaction": "<hex CBOR>" }`. The answer is 200 `{ "transaction": "<hex CBOR>" }`: the same transaction with one more witness, of the delegation key that its datum names. A refusal is `{ "error": "<code>", "message": "<words>" }`.

The route signs only for a principal key on the allowlist that the operator sets with `COSIGN_ALLOWLIST`. The empty allowlist holds nobody, and a service with no such setting does not start. The rule of the route is the rule that the manifest states in `behaviour.cosign`:

> The agent signs one kind of transaction: a Delegate transaction of the delegation contract that names this agent as the delegate and one of its own delegation keys as the delegate key. The delegator must have signed the transaction first, and the delegator must be a principal key on the allowlist of the operator. The delegation key must have no live delegation and no other signed transaction whose window is open. The transaction must spend nothing of the agent, and it must have no certificate, no withdrawal and no other mint. Its validity window must end in the future, and not too far ahead, and the period of the delegation must not be over. The agent adds one witness of the delegation key and changes nothing else.

| Status | Codes |
|---|---|
| 400 | `not_a_delegation`, `not_for_this_agent`, `expired`, `bad_shape`, `request_too_large` |
| 403 | `principal_not_allowed`, `spends_agent_funds` |
| 405, 415 | `method_not_allowed`, `unsupported_media_type` |
| 409 | `key_in_use`, `busy` |
| 503 | `check_unavailable` |
| 500 | `internal` |

The code `key_in_use` means that the delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it.

## What the receipt commits to

The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `reorder-agent-v1` |

The runtime writes the other fields of the receipt. The result is the committed output. The receipt of a `propose` job commits the purchase order, the salt, the digest of the proposal, the hash of the stock reading, and the decision of the model with its reasoning and the sub-job that bought it. The receipt of an `execute` job commits the outcome, the confirmation that the Order Desk returned with its receipt, the decision on the delivery, every write to a mock system and, on `disputed`, the references of the challenge. The sub-receipt of a model is signed by the model supplier under its own key, and accountability for the result stays on the key of this agent.

It does not commit to the stock reading being true, to the quantity being right, or to the order being fulfilled.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The agent stakes a claim for each run, not a standing claim. A claim has these three statements. The manifest holds them in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.

| Id | Statement |
|---|---|
| S1 | An order this agent places is the purchase order whose digest its hirer approved. |
| S2 | This agent accepts only a confirmation that names the SKU and the lot of the purchase order it answers. |
| S3 | This agent pays a supplier only from the vault of the delegation it was given. |

## Fault switch

None. `FAULT_MODE` must be empty.

The service stops at start when `FAULT_MODE` has a value. Every result has the member `fault_mode`, and it is the empty text. The manifest lists no fault value in `behaviour.fault_modes`.
