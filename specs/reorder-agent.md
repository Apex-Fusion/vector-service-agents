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
| Claim | a Module-1 claim that an operator command stakes with the service key before a run. The service stakes none. See Claim statements |

## Capability id

`supplychain.reorder.po.v1`

The model string in the advert and in every receipt is `reorder-agent-v1`.

The agent runs behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). The runtime asks the service whether to take the job, claims the escrow, calls the service, signs the receipt and submits its hash. The service does the work. It holds five keys and no API key of any third party. It does not hold the supplier key: it knows only its key hash and its public key.

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

**The request limit.** The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload. The wire payload carries the request JSON as a string inside a one-message array (see Interface). The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body. A buyer calls the runtime with the wire payload inside a second JSON object, so the request JSON is escaped two times, and each quote mark and each backslash costs more bytes each time. A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes. The two requests of this agent are a few kilobytes, so they are far below both limits.

**The money.** A hire of either operation locks the price and both bonds, 5 units. On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer. If the buyer does not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds. If the supplier never submits, the buyer reclaims after `deliver_by`. The order is paid from the vault of the hirer: the vault pays the price and both bonds of the advert of the lot, and the value limit of the delegation caps that payment. The delegation key of the agent pays the fees of that Pay and of the Accept.

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The runtime claims the escrow and posts the wire payload unchanged to the service as the HTTP body. The service reads the request JSON from its `content`, and it answers with the result as the response body. The runtime hashes that body into the receipt.

The marketplace tools of the hosted server wrap the request JSON into the wire payload for you.

The agent has two operations. `propose` reads the stock and proposes a purchase order. `execute` places an order that the hirer approved.

### Request

A request is one JSON object. Its member `op` is `propose` or `execute`. It has the members of that operation and no other member. A hex text is lower case: a hex text in upper case breaks a rule. A request that breaks a rule of the fields below is refused with `bad_shape` (400) before the job does anything, so it locks nothing of the service's. One exception is the tenant of `execute`: the job checks it against its order (`po_not_for_tenant`).

**`propose`.** The agent reads the stock of one SKU and proposes an order for one lot from the Order Desk that you name.

| Field | Rule |
|---|---|
| `op`, required | `propose` |
| `authority`, required | `principal_did`: the DID of the principal who gave the delegation, `did:vector:` and 64 lower-case hex characters. `delegation`: the identifier of the delegation that names this agent as its delegate, 64 lower-case hex characters. The authority has no vault: the agent finds the Live vault of the delegation itself. |
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
| `proposal`, required | the proposal that `propose` returned: `document` (the purchase order), `salt` (64 lower-case hex characters) and `proposal_digest` (64 lower-case hex characters). The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document. A digest that is not the digest of the salt and the document is refused with `bad_shape`. |
| `approval`, required | the approval of the hirer for the digest of the proposal, or `null`. It has two members: `attestation`, the identifier of the approval (64 lower-case hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 lower-case hex characters). The agent does not check the approval. It passes it on, and the Order Desk refuses an order with no valid approval. |

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
2. It reads the delegation, but not as `propose` does. A delegation that names another agent is refused with `delegation_not_mine` (400). A delegate key that the agent does not hold ends the job with `delegation_key_unknown`, and a read of the ledger that fails ends it with `ledger_unavailable`. A delegation that the ledger does not show does not stop the job. The job goes on with the first delegation key of the agent, and it ends with `no_live_vault` in step 4.
3. It builds the handoff from the document, the salt and the approval as the request gave them. It refuses a proposal whose digest is not the digest of its document and its salt (`bad_shape`). It checks the size of the handoff before the Pay: at most 900000 bytes of wire payload, and at most 1048576 bytes in the body of the call to the runtime of the Order Desk. A larger handoff is refused with `request_too_large` (400).
4. It hires the advert that the document names in `advert_ref`, one time, with one Pay from the Live vault of the delegation, signed by the delegation key. It never retries the Pay. A delegation with no Live vault ends the job with `no_live_vault`, and a delegation with several ends it with `several_live_vaults`. A Pay that the ledger refuses ends the job with `vault_refused`.
5. It sends the handoff to the Order Desk. The Order Desk checks the order before it claims the escrow. When the order fails a check, the Order Desk refuses with a 403 and a code, and the result is `refused_by_counterparty` with that code. The escrow stays Open until the janitor of the key reclaims it after `deliver_by`. Any other refusal before the Claim is a `failed` result. Its reason is the code of the answer when the protocol lists it, such as `bad_shape` (400) or `busy` (409), and `counterparty_refused` otherwise. A send that does not end in a clear refusal is `failed` with `send_lost`, because the Order Desk may hold the escrow. A status of 500 or more is such an end. The exception is a 503 answer with `precheck_unreachable`, `precheck_timeout` or `precheck_failed`: the runtime says that it could not ask its service, and the reason is `counterparty_refused`. The one refusal that comes after the Claim is `cannot_supply`: the escrow then stays Claimed.
6. It runs the eight checks on the receipt of the Order Desk. Then it checks the confirmation in code: it must be an order confirmation (`confirmation_invalid`), and it must answer this order by its number and its hash (`confirmation_not_for_order`). Neither check asks the model.
7. It asks one model whether to accept the delivery (decision `accept_delivery`). The model reads the SKU, the lot and the quantity of the order and of the confirmation, and nothing else of either. It answers `{ accept, mismatch }`, and the agent accepts exactly when `mismatch` is empty.
8. On accept, it accepts the escrow with the delegation key and writes the order to the PO store: `POST /t/<tenant>/po`, with a token for the action `po.write`. The result is `completed` when the store records the order (201), and `refused_by_system` when the store refuses it. The Accept comes before the write, so no end of the write undoes it. Two ends are `failed`: `token_failed` when the agent gets no token for the write, and `mock_system_failed` when the call ends in any other way.
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
| `handoff` | the hire of the Order Desk, or `null` when no escrow was posted. Its members: `counterparty_did`, `advert_ref`, `escrow_ref`, `paid_from_vault`, `receipt`, `receipt_signature`, `verification`, `result` (the confirmation that the Order Desk returned) and `accepted` (`confirmed`, `pending`, `no` or `null`) |
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
| `vault_refused` | `Cancelled` when the hirer ended the delegation, else `Failed` | the ledger refused the Pay from the vault, or the builder could not make it. The `reason` is the text that the node or the builder gave, cut short, or `vault_reason_missing` when it gave none |
| `refused_by_counterparty` | `Rejected`, but `Escalated` for `approval_digest_mismatch`, `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | the Order Desk refused the order. The `reason` is its code |
| `refused_by_system` | `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | a mock system refused a call. The `reason` is its code |
| `disputed` | `Escalated` when the agent filed a challenge, else `Failed` | the model did not accept the delivery. Without a challenge, the `reason` is the code of the step that failed, such as `no_open_claim` |
| `failed` | `Failed` | any other end. The `reason` is a code |

A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.

### Errors

A call that the service refuses has the body `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over a limit of Terms), `bad_shape` (a request that breaks a rule of Request), `bad_context` (a call to `POST /precheck` with a missing or wrong context header), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token of the service) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 503 | `shutting_down` (the service is stopping) |
| 500 | `internal` |

The next table lists each code that a job writes as the `reason` of a `failed` result. The column Job says which job writes it: `propose`, `execute` or both. The other outcomes have their own reasons: see Outcomes. Two rows stand for a class of codes and not for one code: the code of a mock system, which the system chooses, and a code of the protocol, which the use case kit lists.

| Reason | Job | What it says |
|---|---|---|
| `delegation_key_unknown` | both | the delegation names a delegate key that the agent does not hold |
| `ledger_unavailable` | both | a read of the ledger gave no answer in time, or an answer that the job cannot read |
| `mock_system_failed` | both | a call to a mock system failed: in `propose` the call to the ERP, when the system gave no code, and in `execute` the call to the PO store, when it neither recorded the order nor refused it |
| `bad_document` | both | the document is no purchase order, or the job cannot hash it |
| `store_write_failed`, `deadline`, `aborted` | both | a record could not be written on the volume, the job ran out of its time, or the caller hung up |
| `delegation_not_found` | `propose` | the ledger shows no delegation with that identifier |
| `supplier_not_listed`, `supplier_manifest_invalid`, `supplier_lots_invalid`, `sku_not_in_lots`, `supplier_unavailable` | `propose` | `propose` cannot read the Order Desk (step 2 of `propose`) |
| `sub_delegation_<code>` | `propose` | the sub-delegation of `stock-reader` failed. The `<code>` is one of `bad_request`, `parent_unreadable`, `parent_not_live`, `parent_exhausted`, `parent_expiring`, `build_refused`, `build_mismatch`, `missing_signer`, `sign_failed`, `submit_failed`, `confirmation_timeout`, `ledger_unreadable`, `sub_delegation_unusable`, `journal_failed`, `step_timeout` and `internal` |
| `token_<code>` | `propose` | the identity gateway gave `stock-reader` no token. The `<code>` is one of `bad_request`, `gateway_refused`, `delegation_too_young`, `gateway_unavailable`, `gateway_unreachable` and `gateway_bad_response` |
| the code of a mock system | `propose` | the call to the ERP was refused or failed, and the system gave a code. `propose` writes that code when it has the form of a code (lower-case letters, digits and `_`, at most 64 characters), and `internal` when it has not |
| `stock_read_timeout`, `stock_reading_invalid`, `stock_reading_mismatch` | `propose` | the stock read did not end in time, its body is no stock reading, or the reading is for another SKU |
| `llm_supplier_unavailable` | `propose` | no model on the allowlist is within the three limits, so no hire starts |
| `llm_out_of_time`, `hire_threw` | `propose` | the deadline came during the hire of the model, or less than 60 s were left when the decision began, so no hire started (`llm_out_of_time`); or a port threw, or the result of the hire cannot be read (`hire_threw`) |
| `llm_post_failed`, `llm_busy`, `llm_refused`, `llm_send_lost`, `llm_failed`, `llm_timeout`, `llm_bad_result`, `llm_receipt_failed`, `llm_receipt_unavailable`, `llm_accept_failed` | `propose` | the hire of the model failed with a code of the hire kit, and the code follows the prefix. The ten codes of the hire kit are in the row of the hire of the Order Desk |
| `model_output_invalid` | `propose` | the hire of the model ended, and its answer is not usable as a choice |
| `choice_changed`, `bad_decision` | `propose` | the parser of the decision is wrong: it returned a value that is not the choice that the model gave (`choice_changed`), or the definition of the decision or its parser is wrong (`bad_decision`) |
| `bad_limit`, `bad_input`, `bad_deps` | `propose` | a limit, the input or the clock of the decision is wrong, and nothing was hired |
| `decision_mismatch` | `propose` | the choice that the job built is not the choice that the decision records |
| `internal` | `propose` | the job threw, a port gave an answer of a wrong form, or a code that the job read is not in the form of a code |
| `po_not_for_tenant` | `execute` | the order is for another tenant than the request |
| `advert_not_counterparty` | `execute` | the advert in the document is not an advert of the Order Desk that the document names |
| `advert_unavailable` | `execute` | no agent can be hired for the advert of the document, and nothing was paid |
| `no_live_vault`, `several_live_vaults` | `execute` | `execute` found no Live vault under the delegation, or more than one |
| `earlier_pay_may_land` | `execute` | an earlier Pay of the same key was sent and not seen confirmed, and it may still land. No job of that key pays until its validity ends |
| `pay_unconfirmed` | `execute` | the Pay was sent and not seen confirmed, and it may still land |
| `hire_interrupted`, `decision_error` | `execute` | an error ended the hire after the Pay was confirmed. `decision_error` stands when the error came from the decision on the delivery. An interrupted hire can also end with `deadline` or `store_write_failed` |
| `post_failed`, `busy`, `refused`, `send_lost`, `failed`, `timeout`, `bad_result`, `receipt_failed`, `receipt_unavailable`, `accept_failed` | `execute` | the hire of the Order Desk failed, and the hire kit gave the code. The flow takes these ten codes from the hire kit, and it turns any other code into `inconsistent_outcome` |
| `counterparty_refused` | `execute` | the Order Desk refused before its Claim with no rule of the protocol, and the protocol does not list the code of its answer |
| a code of the protocol | `execute` | the Order Desk refused before its Claim with no rule of the protocol, and the protocol lists the code of its answer, such as `bad_shape` (400) or `busy` (409) |
| `confirmation_invalid`, `confirmation_not_for_order` | `execute` | the answer of the Order Desk is no order confirmation, or it answers another order |
| `decision_failed`, `decision_timeout`, `delivery_not_recordable` | `execute` | the decision on the delivery could not be made or read, did not end in time, or the delivery cannot be written as a record. The code of a decision that fails goes to the log and not to the result |
| `token_failed` | `execute` | the identity gateway gave no token for the write to the PO store |
| `inconsistent_outcome` | `execute` | the hire kit gave an outcome that does not hold together, so the job trusts none of it. The order is not written |
| `hire_error` | `execute` | an error that no other code names ended the hire before any Pay |

### The co-sign route

`POST /cosign/delegate` is an open route of the service: it needs no token, and it takes no job slot. The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does. The body is `{ "transaction": "<hex CBOR>" }`. The answer is 200 `{ "transaction": "<hex CBOR>" }`: the same transaction with one more witness, of the delegation key that its datum names. A refusal is `{ "error": "<code>", "message": "<words>" }`.

The route signs only for a principal key on the allowlist that the operator sets with `COSIGN_ALLOWLIST`. The empty allowlist holds nobody, and a service with no such setting does not start. The rule of the route is the rule that the manifest states in `behaviour.cosign`:

> The agent signs one kind of transaction: a Delegate transaction of the delegation contract that names this agent as the delegate and one of its own delegation keys as the delegate key. The delegator must have signed the transaction first, and the delegator must be a principal key on the allowlist of the operator. The delegation key must have no live delegation and no other signed transaction whose window is open. The transaction must spend nothing of the agent, and it must have no certificate, no withdrawal and no other mint. Its validity window must end in the future, and not too far ahead, and the period of the delegation must not be over. The agent adds one witness of the delegation key and changes nothing else.

| Status | Codes |
|---|---|
| 400 | `not_a_delegation`, `not_for_this_agent`, `expired`, `bad_shape`, `request_too_large` |
| 403 | `principal_not_allowed`, `spends_agent_funds` |
| 409 | `key_in_use`, `busy` |
| 415 | `unsupported_media_type` |
| 503 | `check_unavailable` |
| 500 | `internal` |

The code `key_in_use` means that the delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it.

## What the receipt commits to

The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>`: 64 lower-case hex characters, a hash sign, and an output index with no leading zero |
| `supplier_pkh` | the key hash of the supplier key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `reorder-agent-v1` |

The runtime writes the other fields of the receipt. The result is the committed output. The receipt of a `propose` job commits the purchase order, the salt, the digest of the proposal, the hash of the stock reading, and the decision of the model with its reasoning and the sub-job that bought it. The receipt of an `execute` job commits the outcome, the confirmation that the Order Desk returned with its receipt, the decision on the delivery, every write to a mock system and, on `disputed`, the references of the challenge. The sub-receipt of a model is signed by the model supplier under its own key, and accountability for the result stays on the key of this agent.

It does not commit to the stock reading being true, to the quantity being right, or to the order being fulfilled.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The service stakes no claim, and no code of the service calls the staking of one. Before a run, an operator command stakes one claim with the service key of the agent: 50 units, with a challenge window of 24 hours. The operator withdraws the claim after the window. A claim has these three statements. The manifest holds them in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.

| Id | Statement |
|---|---|
| S1 | An order this agent places is the purchase order whose digest its hirer approved. |
| S2 | This agent accepts only a confirmation that names the SKU and the lot of the purchase order it answers. |
| S3 | This agent pays a supplier only from the vault of the delegation it was given. |

## Fault switch

None. `FAULT_MODE` must be empty.

The service stops at start when `FAULT_MODE` has a value. Every result has the member `fault_mode`, and it is the empty text. The manifest lists no fault value in `behaviour.fault_modes`.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

The stock reading, the purchase order and the confirmation are synthetic data, and they are held in memory while a job runs. On disk the service keeps the bookkeeping of the escrows it posts, the list of sub-delegations that it has to end, the record of the challenges it files, the register of the transactions it co-signed, and the counter of purchase order numbers. The log carries job outcomes, counts and codes, never a request, a stock reading, an order or a key. What leaves to third parties:

| Party | What it receives |
|---|---|
| the identity gateway (the token requests of the agent and of stock-reader) | the token request of the agent for the action `po.write`, with the subject token that the service key signs and the proof that the delegation key signs, and the token request of `stock-reader` for the action `erp.stock.read`, signed with its two keys. Each request names one action, one resource and one delegation |
| the mock ERP and the PO store (the calls above, with their tokens) | a read of the stock of one SKU, and a write of one order. Each call carries a token for one action and one resource. The write holds the purchase order |
| a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of each decision: the stock reading and the lots, or the purchase order and the confirmation) | one job for each decision: the fixed prompt of the decision, its data and the reference of the escrow. The data of `reorder` is the SKU and five numbers of the stock reading, the three lot sizes and the date of today. The data of `accept_delivery` is the SKU, the lot and the quantity of the order and of the confirmation. |
| the Order Desk (the purchase order, the salt, the approval reference, the DID of this agent and the delegation) | the handoff. The handoff holds the purchase order, the salt, the approval reference, the DID of this agent and the identifier of the delegation. |
| the Vector ledger (the sub-delegation and, on a dispute, the evidence document and the challenge) | the Delegate and the Undelegate transactions of the sub-delegation. On a dispute, the evidence document and the challenge. Each stays in the history of the ledger |

To post and settle its escrows, the service reads the ledger through the node (Ogmios) and the Koios indexer, submits its transactions through the submit API, and finds suppliers on the marketplace indexer. They see the references and the transactions of those escrows, and nothing of a request. On the ledger an escrow carries only the sha256 of its wire payload. At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins. It sends no data of a job there.

## Known gaps

The manifest states these eight, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/reorder-agent/src/serve/gaps.ts`. The Reorder Agent has no fault value, so the list has no sentence about a fault switch. The seventh sentence says whose keys the parties are. The eighth starts with the lead `What this does not show:` and names three things that no run of use case 1 (inventory reorder) covers.

- The model chooses the lot. Nothing in this agent limits that choice: the vault of the hirer refuses a lot above the delegated amount, and the hirer approves the order or does not.
- This agent does not check the approval of the hirer. The Order Desk does.
- A challenge puts a hold on the identity of the supplier if the jury finds for this agent. It does not return what the escrow locked: a delivery that this agent refuses can still be released to the supplier 600 s after its Submit.
- The stock reading comes from a mock system and is not checked against anything.
- A model call that fails ends the job. There is no second provider.
- Every party on the supplier side is operated by the same foundation as this agent.
- The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.
- What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow by its buyer, or a relying party that refuses a live token after its authority ended, and tests alone cover the last.

## How to hire it

The agent has no advert yet, so nobody can hire it today. These steps are for the day it has one. You hire it twice, once for each operation, and a delegation and a vault carry the authority for the order. [docs/HIRE.md](../docs/HIRE.md) gives the steps of the marketplace tools.

1. **Delegate to the agent.** Build the Delegate transaction with `vector_build_delegation_delegate`. The delegate is this agent. The delegate key is a free one of its two delegation keys, which `keys.delegation_pkhs` of the manifest lists. The actions are `marketplace.hire.v1`, `erp.stock.read` and `po.write`. The resources are the escrow script and the two mock URLs, `<mock base>/t/<tenant>/erp` and `<mock base>/t/<tenant>/po`, where `<mock base>` is the origin of the mock systems that the operator gives you. Set `remaining` to 1 or more: `propose` makes a sub-delegation under your delegation, and a delegation with `remaining` 0 ends that job with `sub_delegation_parent_exhausted`. Set the value limit to the price and both bonds of the lot that you accept. Sign the transaction with your key first: the co-sign route refuses a transaction that the delegator did not sign (`principal_not_allowed`). Send the signed transaction to the agent with `vector_delegation_request_cosign`. The route signs only for a principal key on the allowlist of the operator, and it answers `key_in_use` (409) for a delegation key that is in use. Submit the transaction that comes back. Wait until the ledger shows the delegation: a `propose` job on a delegation that the ledger does not show ends with `delegation_not_found`. Then wait for 30 confirmations of the delegation. The sub-delegation of `propose` needs 30 confirmations on every link of its chain, and `stock-reader` gets no token before that.
2. **Open one vault under the delegation** with `vector_build_vault_open`. The agent finds the Live vault of the delegation itself, so the delegation needs exactly one: `execute` ends with `failed` and the reason `no_live_vault` or `several_live_vaults` otherwise. The vault pays the price and both bonds of the advert of the lot, so put in it what the order needs.
3. **Hire `propose`.** Post the escrow for the advert of the agent, send the request JSON, read the result, verify the receipt and accept, as `docs/HIRE.md` says. The request JSON is the first example under Request, with your own values. The purchase order is the `document` of the result.
4. **Approve the order.** Read the purchase order. If you accept it, make the approval with `vector_build_attestation_attest`: the type is 5, the subject is this agent, and the digest is the `proposal_digest`. Make it with the key that gave the delegation: the Order Desk refuses another issuer with `approval_wrong_issuer`. Set `valid_until` yourself: the tool sets no end. The runs use 4 hours. The attestation holds a deposit of 5000000 lovelace, and the deposit returns 90 days after the attestation ends.
5. **Hire `execute`.** Send the `proposal` as `propose` returned it, with the `approval` of step 4. The second example under Request shows the request. Verify the receipt and accept.
6. **Close the vault and end the delegation.** Close the vault with `vector_build_vault_close`. End the delegation with `vector_build_delegation_undelegate`.

## Changelog

- 0.1.0, 2026-11-23: built

## Links

- Manifest: `GET /agent.json` on the public URL of the agent, once the agent has an advert. The service renders it from its environment when it starts. The template is [agents/reorder-agent/agent.json.template](../agents/reorder-agent/agent.json.template).
- Source: [agents/reorder-agent](../agents/reorder-agent)
- Deploy pack: [deploy/server/RUNBOOK-reorder-agent.md](../deploy/server/RUNBOOK-reorder-agent.md)
- Use case kit: [packages/usecase-kit](../packages/usecase-kit)
- Guide: [docs/HIRE.md](../docs/HIRE.md)
