# Bid Desk

Capability `supplychain.rfq.quote.v1`. For a supplier: takes a request for quotation from a buyer's agent, checks who sent it, prices it from the supplier's published price list and returns a quote. The signed receipt of the job is the signed quote.

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
| Claim | a Module-1 claim for each run. The service stakes none. Before a run, an operator command stakes the claim with the service key: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. The command withdraws it after the window, when nobody challenged it. See Claim statements |

| Instance | Name | Organisation | Public URL (planned) | Role in the planned runs |
|---|---|---|---|---|
| `alfa` | Bid Desk Alfa | `alfa.vector.apexfusion.org` | `https://mp-suppliers-bids-alfa.vector.apexfusion.org` | quotes in every run |
| `bravo` | Bid Desk Bravo | `bravo.vector.apexfusion.org` | `https://mp-suppliers-bids-bravo.vector.apexfusion.org` | quotes in every run, and is the agent of the lifecycle run: its record changes its controller, recovers and is retired with a successor. The successor record is not an agent: it has no advert and no stake |
| `charlie` | Bid Desk Charlie | `charlie.vector.apexfusion.org` | `https://mp-suppliers-bids-charlie.vector.apexfusion.org` | is the bidder of the failure run, with the fault switch set |

The Bid Desk reads no controller of its own record, and its manifest names none. So a change of the controller of a record changes neither the manifest nor the checks of the hook.

## Capability id

`supplychain.rfq.quote.v1`

All three Bid Desks list this capability. The `model` string of each advert and of every receipt that it gives is `bid-desk-v1`. Each Bid Desk has its own advert.

Each Bid Desk is one runtime in front of one service, in a pack of its own. The runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). It holds the supplier key of its Bid Desk and has its advert. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash. The service does the work. It holds the service key and no private supplier key. It runs one job at a time.

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
| Job deadline, set by the service when a request arrives | 300000 ms |
| Request | at most 900000 bytes of wire payload, and 1 to 20 items |
| Model calls | one for each job: the decision `quote` |
| Jobs at a time | one for each Bid Desk: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |
| Budget of one read of the hook, `CHECKS_READ_BUDGET_MS` | 1200 ms by default, from 500 to 2249 ms. The hook makes 4 timed reads, and 4 reads of the widest budget stay under 9000 ms |
| Call for the credential | 20000 ms at most |

**The request limit.** The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. The manifest publishes it in `terms.input_limits.request_bytes`. The limit does not count the body of the call that a buyer makes to a runtime. The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte. The runtime refuses a body above 1048576 bytes (1 MiB). So the limit of 900000 bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below 1048576 bytes. The service reads at most 1000000 bytes of wire payload and refuses more with `request_too_large` (400).

**The money.** A hire of an advert locks its price and both bonds: 3 units. The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment. On Accept the Bid Desk receives the price and the supplier bond, and the buyer's bond returns to the buyer. If the buyer does not accept within 600 s of the Submit, the Bid Desk may Release the escrow and take the price and both bonds. If the Bid Desk never submits, the buyer reclaims after `deliver_by`. A request that the hook refuses, and a job that fails after the Claim, end that way: neither is paid. The service pays for its one model call from the service key.
