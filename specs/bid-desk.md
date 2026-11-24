# Bid Desk

Capability `supplychain.rfq.quote.v1`. For a supplier: takes a request for quotation from a buyer's agent, checks who sent it, and asks a model to price it using the supplier's published list. The runtime signs a receipt that commits to the exact quote bytes.

One code base serves three Bid Desks: Bid Desk Alfa, Bid Desk Bravo and Bid Desk Charlie. Each has its own record, keys, advert, organisation and price list. This page covers all three.

## Status

PROPOSED (built, not deployed). Since 2026-11-24.

Nothing on this page is LIVE or DEPLOYED.

The service is built. Its tests run the hook (the check that comes before the Claim), the job, the book of answered requests and the manifest against stand-ins for the identity gateway, the ledger and a model supplier, with no network. The three Bid Desks have no registry record, no advert and no job yet. Each is the supplier side of use case 3 (supplier bid evaluation). Their counterparty is the Sourcing Agent.

## Identity

This agent has no registry record yet.

The table gives the design of the record. A value that the registration fixes reads "assigned at registration". Each of the three Bid Desks has a record of its own, and the first table gives the design that the three share. The second table gives what differs.

| Field | Value |
|---|---|
| DID | assigned at registration, one for each Bid Desk. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |
| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |
| Supplier key | one key for each Bid Desk: the key of its runtime, listed in the record for the authentication and transaction purposes. The runtime signs its receipts, and the Claim and Submit transactions of its escrows, with it. The service never holds it. The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`. `identity.supplier_key` names it as a key of the DID (`<DID>#<key hash>`). The service does not start unless the public key hashes to the key hash |
| Service key | one key for each Bid Desk, a key of its own, listed in the record for the authentication and transaction purposes. The service holds it and the runtime does not. It pays for the model hire of each quote and signs the transactions of the janitor, which settles the escrows that a hire leaves behind. The manifest publishes its key hash as `keys.service_pkh`. The service does not start when this key is the supplier key |
| Delegation keys | none. The manifest lists no delegation key, and the service has no co-sign route |
| Subagents | none. The record names no subagent, and no setting names one |
| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |
| Organisation | the domain of the Bid Desk, from the second table, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |
| Public URL | planned: one origin for each Bid Desk, the origin of its runtime in its pack (second table). The manifest names the price list at `/price-list.json` on that origin. No Bid Desk has an advert yet |
| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |
| Claim | a Module-1 claim for each run. The service stakes none. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with `no_open_claim`. The design is that the operator stakes the claim with the service key before each run, once such a command exists: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. The operator then withdraws it after the window, when nobody challenged it. See Claim statements |

| Instance | Name | Organisation | Public URL (planned) | Role in the planned runs |
|---|---|---|---|---|
| `alfa` | Bid Desk Alfa | `alfa.vector.apexfusion.org` | `https://mp-suppliers-bids-alfa.vector.apexfusion.org` | quotes in every run |
| `bravo` | Bid Desk Bravo | `bravo.vector.apexfusion.org` | `https://mp-suppliers-bids-bravo.vector.apexfusion.org` | quotes in every run, and is the agent of the lifecycle run: its record changes its controller, recovers and is retired with a successor. The successor record is not an agent: it has no advert and no stake |
| `charlie` | Bid Desk Charlie | `charlie.vector.apexfusion.org` | `https://mp-suppliers-bids-charlie.vector.apexfusion.org` | is the bidder of the failure run, with the fault switch set |

The Bid Desk reads no controller of its own record, and its manifest names none. So a change of the controller of a record changes neither the manifest nor the checks of the hook.

## Capability id

`supplychain.rfq.quote.v1`

All three Bid Desks list this capability. The `model` string of each advert and of every receipt that it gives is `bid-desk-v1`. Each Bid Desk has its own advert.

Each Bid Desk is one runtime in front of one service, in a pack of its own. The runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). It holds the supplier key of its Bid Desk and has its advert. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash. The service does the work. It holds the service key and no private supplier key. It has no API key of a model provider: it hires its model on the Vector marketplace. It runs one job at a time.

The three services run one image and one code base. `BID_DESK_INSTANCE` selects the name and the price list file, `BID_DESK_ORGANISATION` gives the organisation, and `BID_DESK_PUBLIC_ORIGIN` gives the origin that serves the price list. The three Bid Desks share the code, the checks, the job and the terms of the advert. They differ in the name, the organisation and the price list. A Bid Desk shares no container, key, volume or job slot with another.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals. The Bid Desk has three adverts, one for each Bid Desk, so its terms have three groups. The three groups are equal: the price and the two bonds are constants of the code.

**Bid Desk Alfa, advert model `bid-desk-v1`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 1000000 | 1.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 3000000 | 3.000000 |

**Bid Desk Bravo, advert model `bid-desk-v1`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 1000000 | 1.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 3000000 | 3.000000 |

**Bid Desk Charlie, advert model `bid-desk-v1`**

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 1000000 | 1.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 3000000 | 3.000000 |

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 480000 ms, for each of the three adverts |
| Service timeout, `SERVICE_TIMEOUT_MS` of each runtime | 360000 ms |
| Deadline of the model hire, set by the service when a request arrives | 300000 ms after the request arrives, or 50000 ms before `deliver_by`, whichever is earlier |
| Request | published limit of 900000 bytes of wire payload, and 1 to 20 items |
| Model calls | one for each job: the decision `quote` |
| Jobs at a time | one for each Bid Desk: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |
| Budget of one read of the hook, `CHECKS_READ_BUDGET_MS` | 1200 ms by default, from 500 to 2249 ms. The hook makes 4 timed reads, and 4 reads of the widest budget stay under 9000 ms |
| Call for the credential | 20000 ms at most |

**The request limit.** The manifest asks the buyer to keep the full wire payload at or below 900000 UTF-8 bytes (`terms.input_limits.request_bytes`). This counts the one-message array and all escapes. The runtime limits the whole request body to 1048576 bytes. The buyer puts the wire payload inside that body as a JSON string. Escaping the payload again can put the body above the runtime limit even if the payload fits. On `POST /` and `POST /precheck` the Bid Desk's HTTP reader has a separate limit of 1000000 bytes. It refuses more with `request_too_large` (400).

A buyer that uses `vector_marketplace_send_job` must also keep the whole serialized body sent to `/v1/job` at or below 1000000 UTF-8 bytes. Check the size before you sign and submit the escrow Post. See [Terms of the Sourcing Agent](sourcing-agent.md#terms) for the body to measure.

**The money.** A hire of an advert locks its price and both bonds: 3 units at the listed terms. The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment. On Accept the Bid Desk receives the price and the supplier bond. The buyer bond goes to a separate `Returned` vault output that only the vault owner can close. If the buyer does not accept within 600 s of the Submit, the Bid Desk may Release the escrow and take the price and both bonds. Reclaim applies only to an Open or Claimed escrow. After `deliver_by` it returns the full lock to a `Returned` output, not to the caller's wallet. Neither return restores the spending allowance of the Live vault. See [Terms of the Sourcing Agent](sourcing-agent.md#terms) for the full settlement rules. The service pays for its one model call from the service key.

## Interface

A buyer's agent hires a Bid Desk through its runtime. It posts an escrow on the advert of that Bid Desk, pays it from a vault of its delegation, and sends one request, the request for quotation of use case 3 (supplier bid evaluation). The runtime asks the service before it claims the escrow. After the Claim it posts the job to the service. The service answers with the quote, or with an error. The three Bid Desks have one interface, and this section gives it once.

Two things are named apart on this page. The **request JSON** is what the buyer's agent writes: the message under Request below. The **wire payload** is the request JSON written as a string inside a one-message array: `[{"content": "<request JSON as a string>", "role": "user"}]`. The buyer's agent commits to the wire payload in the escrow, and a runtime posts it to the service as the body of `POST /` and of `POST /precheck`.

| Route | Called by | Answer |
|---|---|---|
| `POST /precheck` | the runtime, before the Claim | the hook: 200 `{"go":true,"reserved_ms":120000}`, or a refusal with its code |
| `POST /` | the runtime, after the Claim | the job: the quote, or an error |
| `GET /price-list.json` | anyone | the price list of the Bid Desk |
| `GET /agent.json` | anyone | the manifest |
| `GET /healthz` | on the service port, for operators | `{"ok":true}` when the Bid Desk service can answer HTTP |

`POST /` and `POST /precheck` need the token that only the runtime holds. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read. `GET /price-list.json`, `GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`. A buyer sends its job to the runtime of its advert, on the runtime route `/v1/job` of the manifest, and never to the service.

Public `/healthz` is different. Caddy sends it to the runtime, which can return `{"ok":true}` when the Bid Desk service is down. Caddy sends public `/agent.json` and `/price-list.json` to the service. A successful response there shows that the service answers on that path. None of these responses proves that the service can take or finish a job. Operators can check the service port separately (see [The checks](../deploy/server/RUNBOOK-bid-desk.md#the-checks)).

### Request

The request JSON is the request for quotation of use case 3 (supplier bid evaluation). It is one object with exactly the members of the first table. Its `rfq` is the request for quotation, and it has exactly the members of the second table. Each item of `items` has exactly the members of the third table. The order of the members does not matter. A request that breaks a rule is refused with `bad_shape` (400), before any check.

Example. The tests of the job use this request. Its identifiers are made up, so none of them is of a real agent or delegation.

```json
{
  "schema": "vector.usecase.rfq.v1",
  "sender_did": "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
  "delegation": "5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e",
  "rfq": {
    "rfq_id": "run1-rfq-1",
    "items": [
      {
        "sku": "GLV-NIT-M",
        "quantity": 100
      },
      {
        "sku": "SYR-10ML",
        "quantity": 250
      },
      {
        "sku": "MSK-N95",
        "quantity": 40
      }
    ],
    "needed_by": "2026-12-20"
  }
}
```

| Member | Rule |
|---|---|
| `schema` | `vector.usecase.rfq.v1` |
| `sender_did` | the DID of the buyer's agent: `did:vector:` and 64 lower-case hex characters |
| `delegation` | the identifier of the delegation that names the sender as its delegate and paid for the job: 64 lower-case hex characters |
| `rfq` | the request for quotation, with the members of the second table |

| Member of the request for quotation | Rule |
|---|---|
| `rfq_id` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. The service counts it as written, so `RFQ-7` and `rfq-7` are two requests |
| `items` | 1 to 20 items, with the members of the third table, and each SKU once |
| `needed_by` | a date that exists, as `YYYY-MM-DD`, in the year 0100 or later |

| Member of an item | Rule |
|---|---|
| `sku` | the same form as `rfq_id` |
| `quantity` | a whole number from 1 to 1000000 |

The service reads each text as it was written. An identifier or a SKU that is valid only after Unicode normalisation, such as the Kelvin sign in place of the letter K, is refused with `bad_shape`. The Bid Desk takes no approval, so a member that the tables do not list, `approval` included, is refused too.

### What it checks before the Claim

The runtime asks the service before it claims an escrow. The question is `POST /precheck`, and this page calls it the hook. The hook makes 7 checks, one after the other, in the order of the table. The first 6 are the shared checks of the use-case kit: the sender, the delegation and the payment from a vault. The last is the check of the Bid Desk. The Bid Desk takes no approval, so it has no check of one. The first check that fails ends the hook. Its answer is the refusal code of that check, with the status 403. A refusal comes before the Claim: the escrow stays open, nothing is claimed, nothing is paid, and the buyer reclaims the escrow after `deliver_by`.

| # | Check | Refusal code | Status | The rule |
|---|---|---|---|---|
| 1 | `sender_active` | `sender_not_active` | 403 | the sender has a record at the identity gateway, the record has not ended, and its status is Active. A record that the gateway suspends because no Accountable Party covers it gets `sender_unaccountable` |
| 2 | `sender_accountable` | `sender_unaccountable` | 403 | an Accountable Party covers the record of the sender now |
| 3 | `sender_key` | `sender_key_mismatch` | 403 | the key that posted the escrow is a key that the record of the sender lists with the delegation purpose. The runtime reads that key from the escrow, and the body never gives it |
| 4 | `delegation` | `delegation_invalid` | 403 | a live delegation has the identifier of the request, its delegate is the sender, and its delegate key is the key that posted the escrow |
| 5 | `delegation_usable` | `delegation_ended` | 403 | the delegation and each of its parents can be used now to hire. The check does not wait for confirmations |
| 6 | `vault_paid` | `not_vault_paid` | 403 | the escrow was paid from a vault of this delegation |
| 7 | `not_duplicate` | `duplicate_rfq` | 403 | the rfq book holds no answer to this `rfq_id` from this sender. The identifier counts as it was written |

When every check passes, the hook answers 200 `{"go":true,"reserved_ms":120000}`. The service keeps the record of the checks for 300 s, and it reserves the job slot for that escrow for 120 s. The record is for one escrow and one parsed request. A job with no matching record makes no quote. A source that the hook cannot read (the identity gateway, the ledger or the rfq book) is never a pass: the hook answers 503 `check_unavailable`. The runtime waits 10000 ms for the hook, and reads silence as a refusal.

The hook makes 4 timed reads, one after the other: the identity gateway once, for the DID of the sender, and the ledger three times (the delegation, its use and the payment from a vault). The read of the rfq book is local and has no budget. The hook reads the record of the sender and never the record of the Bid Desk itself.

The runtime sends six headers of context with each call: `x-vector-escrow-ref`, `x-vector-advert-ref`, `x-vector-advert-model`, `x-vector-buyer-pkh`, `x-vector-payment-lovelace` and `x-vector-deliver-by-ms`. The hook needs all six, and a call with none, with some, or with a bad one gets 400 `bad_context`. The key that posted the escrow and the reference of the escrow come from these headers and never from the body: the checks `sender_key`, `delegation` and `vault_paid` read them there.

The Bid Desk files no challenge. It takes no approval, so a request has no digest that the hook could refuse, and the service has no dispute code and no dispute setting. A refusal of the hook is the answer to the runtime and nothing more.

The hook does not check the SKUs of the request against the price list. SKUs absent from the list do not prevent the Claim. The job then hires the model. If the model gives no line, the job ends with `model_output_invalid` (502), because a quote needs at least one line (see What it does). A line that passes the code checks can use a price that the model made up, even for a SKU that the list does not carry.

The check `not_duplicate` and the job both read the book of the Bid Desk. The book holds one entry for each request that the Bid Desk answered, by the DID of the sender and the `rfq_id` as it was written. It never drops an entry, so a Bid Desk refuses a repeated `rfq_id` of the same sender for ever. It holds at most 10000 entries. A book that is full cannot take a new entry: for a request that it lacks, the hook then answers 503 `check_unavailable` and the escrow stays open, and for a request that it holds, the hook still answers 403 `duplicate_rfq`.

### What it does

After the Claim the runtime posts the job to the service. The job runs these steps in this order. A failure ends the job with an error, and no later step runs. The service sets one deadline when the request arrives, and it holds the model hire only: the earlier of 300000 ms after the request arrives and 50000 ms before `deliver_by`. The 50000 ms are 30000 ms for the runtime, which stops waiting then, and 20000 ms for the call for the credential. The steps after the hire can end later than the 300000 ms.

1. The job takes the record of the checks for its escrow. It compares the hash of the canonical JSON of its parsed request with the hash that the hook recorded. A job with no record, with the record of a different request, with a record that lacks one of the 7 checks, or with a fact in the record that it cannot read, fails with `precheck_missing` and makes no quote. It takes the sender and the 7 checks of the quote from that record.
2. Decision `quote`: the service hires one model from the Vector marketplace. The model gets a fixed instruction, the date of today, the items and the date of the request, and the entries of the price list for the SKUs of the items. It answers `{ "lines": [ { "sku", "quantity", "unit_price", "lead_time_days" } ], "valid_until": "<date>", "notes": "..." }`, and its reasons. The instruction asks the model to take each unit price from the list. The hire ends 300000 ms after the request arrives, or 50000 ms before `deliver_by` when that is earlier, and it does not start with less than 60000 ms left for it.
3. The job checks the choice against the request, in code: there is at least one line, each line has the SKU and the quantity of an item of the request, and each SKU stands in one line. A choice that breaks this rule ends the job with `model_output_invalid` (502). The decision is on record and no quote is made. The job does not check that every item has a line, and it never adds, removes or changes a line.
4. When the fault switch is set, the job changes the unit price of one line (see Fault switch). Then it makes the line totals, the total and the longest lead time. These three are arithmetic, not decisions.
5. It reads the book again. A request that the book holds ends the job with `duplicate_rfq` (403) after the Claim. The hook can pass two escrows of one request before the first job writes the book, and this read closes that gap.
6. It gets the credential of the Bid Desk from the identity gateway. A failure of the gateway, and an answer that is not a compact JWS, end the job with `credential_failed` (502).
7. It builds the quote and checks it with the parser of the kit. A quote that the parser refuses ends the job with `internal` (500).
8. It checks the time. With less than 30000 ms left before `deliver_by`, the job ends with `deadline` (422) and records nothing. Otherwise it writes the book: the sender, the `rfq_id` and the hash of the quote. A book that cannot be written ends the job with `store_write_failed` (500). Then the job answers with the quote.

The model sets the prices and the code does not check them. The code checks the SKU and the quantity of each line against the request, and it does not check a unit price against the price list. So a quote can hold a price that is not on the list. The buyer can compare each unit price with the public list for its SKU and quantity. The quote names the hash of that list. The Sourcing Agent checks this hash in code and asks its model to compare unit prices. It can accept a quote with an off-list price if the model reports no mismatch. The one price off the list that this Bid Desk makes on purpose is the fault `quote_off_price_list`.

A request none of whose SKUs the price list carries passes the hook and the Claim. The instruction to the model says to leave an item that the list does not carry out of the lines, and to name it in the notes. When no line is left, the job ends with `model_output_invalid` (502) after the Claim, and the service has paid for the model hire. A request with some SKUs on the list gets a quote with a line for each item that the model priced.

A job whose caller hangs up before the decision, or before the book records the quote, stops there with `deadline` (422) and records nothing. A hire that has started is not stopped. A hang-up after the record does not stop the job: the quote is booked, the job gives it, and its log says that the caller hung up. The job calls no mock system, takes no approval and files no challenge.

### Response

`schema` is `vector.usecase.quote.v1`. A job that makes the quote answers with it, as the body of the answer, serialised once, with its members in the order of the table below. The signed receipt commits to the exact quote bytes. A job that does not make a quote answers with an error (see Errors) and no quote.

Example. The test of the job gives exactly this quote for the request above, with the price list file of Bid Desk Alfa, the organisation of Bid Desk Alfa and stand-ins for the identity gateway, the book and the model supplier. It is an illustration and not a recorded run. Its desk DID, sender, credential, references, hashes and signature are made up, so none of them is of a real agent, escrow or key. Only the price list hash and the prices are those of the file of Bid Desk Alfa.

```json
{
  "schema": "vector.usecase.quote.v1",
  "outcome": "done",
  "rfq_id": "run1-rfq-1",
  "rfq_sha256": "42ca167e867b2e8df3a82b7dc4a5b1c2a3a96f523e1f56a3863936a5dceadf35",
  "desk_did": "did:vector:b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
  "organisation": "alfa.vector.apexfusion.org",
  "lines": [
    {
      "sku": "GLV-NIT-M",
      "quantity": 100,
      "unit_price": 125,
      "line_total": 12500,
      "lead_time_days": 14
    },
    {
      "sku": "SYR-10ML",
      "quantity": 250,
      "unit_price": 28,
      "line_total": 7000,
      "lead_time_days": 10
    },
    {
      "sku": "MSK-N95",
      "quantity": 40,
      "unit_price": 60,
      "line_total": 2400,
      "lead_time_days": 21
    }
  ],
  "total": 21900,
  "lead_time_days": 21,
  "valid_until": "2026-12-15",
  "notes": "All three items are on the price list.",
  "price_list_sha256": "8398730303d1a13c26dc761d9d85f14a09a8ee0b495e584f132599a79f80ae1d",
  "credential": "eyJhbGciOiJFZERTQSIsInR5cCI6InZjK2p3dCJ9.eyJpc3MiOiJkaWQ6dmVjdG9yOmdhdGV3YXkiLCJzdWIiOiJkaWQ6dmVjdG9yOmRlc2siLCJ2YyI6eyJ0eXBlIjpbIlZlcmlmaWFibGVDcmVkZW50aWFsIl19fQ.YSBzaWduYXR1cmUgdGhhdCBvbmx5IGEgdGVzdCB1c2Vz",
  "sender": {
    "did": "did:vector:a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    "organisation": "buyer.example",
    "organisation_verified": true
  },
  "checks": {
    "sender_active": true,
    "sender_accountable": true,
    "sender_key": true,
    "delegation": true,
    "delegation_usable": true,
    "vault_paid": true,
    "not_duplicate": true
  },
  "decisions": [
    {
      "name": "quote",
      "choice": {
        "lines": [
          {
            "sku": "GLV-NIT-M",
            "quantity": 100,
            "unit_price": 125,
            "lead_time_days": 14
          },
          {
            "sku": "SYR-10ML",
            "quantity": 250,
            "unit_price": 28,
            "lead_time_days": 10
          },
          {
            "sku": "MSK-N95",
            "quantity": 40,
            "unit_price": 60,
            "lead_time_days": 21
          }
        ],
        "valid_until": "2026-12-15",
        "notes": "All three items are on the price list."
      },
      "reasoning": "The list gives 125 for 100 gloves, 28 for 250 syringes and 60 for 40 masks, so each line takes the unit price of its break and the lead time of its SKU.",
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
            "prompt_tokens": 912,
            "completion_tokens": 164,
            "wallclock_ms": 3120
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
| `schema` | `vector.usecase.quote.v1` |
| `outcome` | always `done`: a refusal or a failure is an error, never a quote |
| `rfq_id` | the identifier of the request |
| `rfq_sha256` | the SHA-256 of the canonical text of the request for quotation that the Bid Desk received, with no salt |
| `desk_did` | the DID of this Bid Desk (`AGENT_DID`) |
| `organisation` | the organisation of this Bid Desk (`BID_DESK_ORGANISATION`) |
| `lines` | the lines of the quote: each has `sku`, `quantity`, `unit_price`, `line_total` and `lead_time_days` |
| `total` | the sum of the line totals |
| `lead_time_days` | the longest lead time of the lines |
| `valid_until` | the last day on which the quote holds, as the model gave it |
| `notes` | the note of the model: at most 500 characters |
| `price_list_sha256` | the SHA-256 of the price list file that this Bid Desk serves |
| `credential` | the credential of this Bid Desk from the identity gateway, a compact JWS |
| `sender` | the DID of the sender, the organisation that the covering Accountable Party names (or `null`), and whether the identity gateway verified it. The organisation is recorded, and the hook never refuses a sender for it. The job refuses an organisation of more than 1024 characters with `precheck_missing` (500) after the Claim |
| `checks` | the 7 checks of the hook, each `true`, in the order of the table of the hook |
| `decisions` | one decision, `quote`: its choice, its reasoning, and the hire of the model supplier with the sub-receipt that the service verified (`inference`) |
| `fault_mode` | the setting of the fault switch: the empty text in a clean run. It is the last member |

A line total is the quantity times the unit price, the total is the sum of the line totals, and `lead_time_days` is the longest lead time of the lines. The service makes these three numbers from the lines of the model. They are arithmetic and not decisions, and the parser of the kit refuses a quote with a number that is not the arithmetic of its lines. A quote can have fewer lines than the request has items. The instruction to the model asks it to name each item that it leaves out in the notes, and the job does not check the notes.

The quote names the hash of the request and the hash of the price list that it was priced from, so a buyer's agent can check each unit price against the public list.

The `notes` and the organisation of the sender are free text. The notes hold at most 500 characters and no control or hidden character. The quote holds an organisation of the sender of at most 1024 characters, and it can be any text that the covering Accountable Party names. The hook takes an organisation of any length. The job refuses one of more than 1024 characters: it fails with `precheck_missing` (500) after the Claim and before the model hire, and it makes no quote.

### The price list

`GET /price-list.json` answers the price list file of the Bid Desk: its SKUs, each with a lead time and a unit price from each minimum quantity. It needs no token and takes no job slot. The answer is the exact bytes of the file, with the header `content-type: application/json`. The unit price of a quantity is the price of the break with the greatest minimum that is not above the quantity.

The manifest holds the address of the file, `<public origin>/price-list.json`, and the SHA-256 of its bytes in `behaviour.price_list`. The advert holds the SHA-256 of the manifest. So a change of a list changes the manifest of its Bid Desk, and it is a new image and a new advert. The three tables below are the three files. The numbers are stand-in data of a demonstration: they carry no unit of account and no commercial value.

**Bid Desk Alfa**

| SKU | Lead time in days | Unit price from 1 | Unit price from 100 | Unit price from 500 |
|---|---|---|---|---|
| `GLV-NIT-M` | 14 | 140 | 125 | 110 |
| `SYR-10ML` | 10 | 32 | 28 | 24 |
| `MSK-N95` | 21 | 60 | 52 | 46 |

SHA-256 of the file: `8398730303d1a13c26dc761d9d85f14a09a8ee0b495e584f132599a79f80ae1d`

**Bid Desk Bravo**

| SKU | Lead time in days | Unit price from 1 | Unit price from 100 | Unit price from 500 |
|---|---|---|---|---|
| `GLV-NIT-M` | 10 | 148 | 132 | 118 |
| `SYR-10ML` | 8 | 34 | 30 | 26 |
| `MSK-N95` | 18 | 64 | 56 | 50 |

SHA-256 of the file: `60969045f9fc8f1d8371f864315e58a302d0100369559658fbba8c056e9fa6b0`

**Bid Desk Charlie**

| SKU | Lead time in days | Unit price from 1 | Unit price from 100 | Unit price from 500 |
|---|---|---|---|---|
| `GLV-NIT-M` | 21 | 130 | 115 | 102 |
| `SYR-10ML` | 14 | 29 | 25 | 22 |
| `MSK-N95` | 28 | 56 | 48 | 42 |

SHA-256 of the file: `c78398a4f0276aca2980f78d0488c296e8159716228874e748d03243a077b22b`

### Errors

A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.

- The 401, the 404, the 409 of a job and a plain 500 have the code and no message: `{"error":"unauthorized"}`, `{"error":"not_found"}`, `{"error":"busy"}` and `{"error":"internal"}`. A plain 500 is the answer to a fault that no code names, and its cause is in the log.
- A refusal of status 500 or more gets a fixed message, `The service could not do this job (<code>). The operator's log has the detail.`, because the runtime copies the first 200 characters of a failure to the buyer, and the detail is the operator's. `shutting_down` has the fixed message `The service is stopping and takes no new job. Try again shortly.`, and the 409 `busy` of the hook has the fixed message `The service is working on another job. Try again shortly.`.
- The messages of `duplicate_rfq` and `deadline` are fixed texts that hold no value of the request.
- A refusal of the hook leaves the funded escrow Open. A job that fails after the Claim does not Submit a quote, so the escrow stays Claimed. The lock does not return automatically. Anyone can submit a Reclaim after `deliver_by` to return the full lock to the vault owner as a `Returned` output (see Terms).
- The Bid Desk calls no mock system, so a failed job can leave behind a model hire and nothing else. A job that fails after the service accepted the model hire has paid the model supplier from the service key. A hire that stays unfinished is in the stranded file of the service key, and the janitor settles it.
- One job runs at a time. A job that arrives while a job runs, or while the slot is reserved for another escrow, gets 409 `{"error":"busy"}`, and nothing starts. A call of the hook gets 409 `busy` with a message while a job runs, whatever its escrow, and while the slot is reserved for another escrow. A new go of the hook for the escrow that holds the reservation reserves the slot again; a refusal of the hook reserves nothing.
- While a job runs, the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the fetch of the runtime gives up after 300 s of silence.
- A Bid Desk is the hired side. The service answers 200 only when it made a quote, and the 200 answer is the quote. Every code of the table is a refusal or a failure of the job or of the request, and the runtime turns it into the answer that the buyer reads.

| Status | Codes |
|---|---|
| 400, the message | `bad_wire` (not the one-element message array), `request_too_large` (over 1000000 bytes) |
| 400, the request | `bad_shape` (a request JSON that is not a request for quotation of use case 3), `bad_context` (the six headers of the context are missing, some are missing, or one is not well formed) |
| 401, the caller | `unauthorized` (no message) |
| 403, the hook, before the Claim | `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `duplicate_rfq` |
| 403, the job, after the Claim | `duplicate_rfq` (the book holds an answer to this request already: the hook passed two escrows of one request before the first job wrote the book) |
| 404, no such route | `not_found` (no message) |
| 409, the service is busy | `busy` (a job runs, or the slot is reserved for another escrow. The answer to a job has no message, and the answer of the hook has one) |
| 422, the job | `deadline` (the caller hung up before the model hire or before the record in the book, or less than 30 s are left before `deliver_by`) |
| 500, the service | `precheck_missing` (the job has no record of passed checks for its body), `store_write_failed` (the rfq book or the record of the model hire cannot be written), `internal` (a fault of the service: a plain 500 with no message when nothing names it, and the fixed message when the job names it) |
| 502, a third party | `credential_failed` (the identity gateway gave no credential that a quote can hold), `inference_failed` (the model hire failed, or it did not start because less than 60 s were left for it), `model_output_invalid` (the answer of the model cannot be used: it breaks the shape of the decision, or a line is not an item of the request, or there is no line) |
| 503, the service cannot answer now | `check_unavailable` (the hook could not read a source), `shutting_down` (the service is stopping) |

## What the receipt commits to

The service signs no receipt. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |
| `supplier_pkh` | the key hash of the supplier key of the runtime of the Bid Desk that took the job |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the quote exactly as the service returned them |
| `model` | `bid-desk-v1` |
| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The token counts of the model hire are in the sub-receipt under `decisions[0].inference.sub_job` |
| `wallclock_ms` | how long the service call took |

The quote is the committed output. The receipt commits to every line with its unit price and its lead time, the hash of the request that the Bid Desk received, the hash of the price list it names, its credential, who sent the request, the 7 checks, and the pricing decision with its reasoning and the sub-receipt of the model supplier. It does not hold the Bid Desk to the quote: a quote is not a binding offer (see Known gaps).

Keep the exact result bytes, the receipt and the signature if you need to verify the quote later. Check the SHA-256 of those bytes against `receipt.response_hash`, and verify the signature with the Bid Desk supplier key. Parsed or re-serialized JSON is not a substitute for the original bytes.

The sha256 of the quote text is what a challenge uses. The evidence of a challenge on S1 names that hash as `quote_sha256`, with the hash of the price list (`price_list_sha256`), the SKU and the quantity of the line, the unit price that the quote gives and the unit price that the list gives.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The service stakes no claim: no code of the service calls the staking. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with `no_open_claim`. The design is a Module-1 claim for each Bid Desk and each run. The operator stakes it with the service key of that Bid Desk before the run, once such a command exists: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. After the window, the operator withdraws the claim when nobody challenged it. The claim has three statements, and the three Bid Desks have the same three. The manifest of each holds the same three texts in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.

| Id | Statement |
|---|---|
| S1 | The unit price of every line in a quote is the price its published price list gives for that SKU and quantity. |
| S2 | A quote names the hash of the request for quotation it answers. |
| S3 | This agent gives one quote per request for quotation and sender. |

S1 is the statement that the fault `quote_off_price_list` breaks. When the Sourcing Agent's model reports a mismatch, the agent declines the quote. It challenges S1 only if there is an open claim and it can show that a line the model named has a different unit price. If the model misses a mismatch, the quote can be accepted. S2 is held by the member `rfq_sha256` of the quote, and S3 by the book of the Bid Desk (see What it checks before the Claim).

## Fault switch

`FAULT_MODE=quote_off_price_list`: the unit price of the first line that the price list prices is lowered by a fifth of the listed price, rounded up, and every check of the hook still passes. The new price is `listed - ceil(listed / 5)`, where `listed` is the price of the list for the SKU and the quantity of that line. The totals follow the changed line. The new price is below the listed price and at least 1, because no price of the three files is below 10. For the request of the example under Request and the price list of Bid Desk Alfa, the quote of a fault run has the unit price 100 on its first line (the listed price is 125), the line total 10000 and the total 19400, and its `fault_mode` is `quote_off_price_list`. The decision on record stays what the model said.

When no line can take the new price, the job ends with `internal` (500): a run never says that a fault was on when it changed nothing. The planned failure run sets the switch on one Bid Desk only, Bid Desk Charlie, to test whether the Sourcing Agent's model identifies the off-list price. No command of this repository runs use case 3 yet. The switch of one Bid Desk never changes another: each Bid Desk reads an env file of its own.

The switch is empty in a clean run. Any other value stops the start of the service. The switch changes what the job writes and never a check: the hook does not know that it exists. It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value. Each quote returns the active value as `fault_mode`, its last member.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest of each Bid Desk.

The request for quotation and the price list are synthetic data, and they are held in memory while a job runs. The service writes to its state directory the bookkeeping of the escrows that it posts for its model call and the book of the requests that it answered (the sender, the request identifier and the hash of the quote of each). The log carries job outcomes, counts and codes, never a request, a quote, a credential or a key. The Bid Desk calls no mock system and no dispute service. What leaves to third parties:

| Party | What it receives |
|---|---|
| the identity gateway (the resolution of the DID of the sender, and the request for the credential of this agent) | the DID of the sender, in the hook. The DID of this agent, in the job, for its credential |
| the ledger, read only (the delegation and the escrow paid from a vault) | the reads of the hook: the identifiers of the delegation and of the escrow |
| a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision: the request for quotation and the price list) | one job: the instruction of the decision, the date of today, the items and the date of the request, the entries of the price list for the SKUs of the items, and the reference of the escrow |

The service keeps these files and folders in its state directory (`BID_DESK_STATE_DIR`, which is `/data` in the image):

| Path | What it holds |
|---|---|
| `rfq-book.json` | the rfq book: the sender, the request identifier and the hash of the quote of each request that the service answered. It holds at most 10000 entries and never drops one |
| `keys/<key hash>/stranded.json` | the bookkeeping of the escrows that a model hire posted: references, times and transaction hashes, never a request or a quote |

What the decision receives:

| Decision | Data block | Left out |
|---|---|---|
| `quote` | `today`, `request` (`items` and `needed_by`) and `price_list` (the entries for the SKUs of the items, each with `sku`, `lead_time_days` and `breaks`) | the identifier of the request (`rfq_id`), the sender, the delegation and every other member of the message, and the entries of the price list for other SKUs |

The text of the request and of the price list reaches the model only inside the marked data block, and never inside an instruction. To post and settle its escrows for the model hire, the service reads the ledger through the node (Ogmios) and the Koios indexer, submits its transactions through the submit API, and finds the model suppliers on the marketplace indexer. At start the service makes no call of its own to a third party. The janitor of the service key runs its first pass at once, and then one pass every 60 s. A pass reads the ledger for each escrow of the stranded file that is due, and it can submit a Reclaim, or one more Accept, through the submit API. When the stranded file holds no escrow that is due, a pass makes no call.

## Known gaps

The manifest states these eight, in this order, word for word. A test keeps them equal to `GAPS` in `agents/bid-desk/src/serve/gaps.ts`. The first five are the gaps of the agent. The sixth says whose keys the parties are. The seventh starts with a run-in lead and names three things that no run of use case 3 (supplier bid evaluation) covers. The eighth is the sentence of the kit about the fault switch.

The fourth gap describes an identity attestation (type 0) about a Bid Desk. The Sourcing Agent reads it. The Bid Desk does not. The operator pack's `compliance` task supports one attestation for each Bid Desk. The task checks the exact bytes of the published statement before it signs the issue. The attestation records the URI and its SHA-256 digest. It is valid for 365 days unless revoked first.

The demonstration registry's key signs the issue and can revoke it. The current controller of the Bid Desk signs a `Contest` after the task verifies the revocation. The reply on the ledger records the URI and SHA-256 digest, not the text. The operator CLI does not enable use case 3 yet. This task support does not show that any of these attestations exist on mainnet.

- A quote is the result of a paid job. It is not a binding offer.
- The model prices the request. Nothing in this agent checks its lines against the price list: the buyer's agent can, because the price list and its hash are public.
- The three Bid Desks are one code base under three records, run by one foundation. They do not compete.
- The compliance attestation is issued by a demonstration registry with no record of its own.
- The numbers of the price list are synthetic.
- The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.
- What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.
- This service has a fault switch for failure runs with these possible values: quote_off_price_list (one quote line has a unit price that is not the published price for that item and quantity); this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.

## How to hire it

No advert exists yet, so no buyer can hire a Bid Desk today.

A buyer's agent hires a Bid Desk from the vault of a delegation. A hire without a delegation of the sender, or without a payment from its vault, is refused by the hook before the Claim. Each Bid Desk has its own advert and its own book of answered requests, so a buyer's agent can send one request, with one `rfq_id`, to each of the three Bid Desks, with one hire for each advert.

To see the Bid Desks work, hire the [Sourcing Agent](sourcing-agent.md). It hires Bid Desks for quotes on one request for quotation, and it proposes a ranking of the quotes to its hirer. The steps to hire the Sourcing Agent are on its page.

## Changelog

- 0.1.0, 2026-11-24: built

## Links

- Manifest: `GET /agent.json` on the public URL of each Bid Desk, once the agent is deployed. The service renders it from its environment when it starts. The template is [agents/bid-desk/agent.json.template](../agents/bid-desk/agent.json.template).
- Price lists: `GET /price-list.json` on the public URL of each Bid Desk, with the bytes of [agents/bid-desk/price-lists/alfa.json](../agents/bid-desk/price-lists/alfa.json), [agents/bid-desk/price-lists/bravo.json](../agents/bid-desk/price-lists/bravo.json) and [agents/bid-desk/price-lists/charlie.json](../agents/bid-desk/price-lists/charlie.json).
- Source: [agents/bid-desk](../agents/bid-desk)
- Deploy pack: [deploy/server/RUNBOOK-bid-desk.md](../deploy/server/RUNBOOK-bid-desk.md)
- Buyer-side agent: [Sourcing Agent](sourcing-agent.md)
