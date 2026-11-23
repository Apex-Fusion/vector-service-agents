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
