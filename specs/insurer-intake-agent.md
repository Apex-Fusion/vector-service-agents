# Insurer Intake Agent

Capability `health.priorauth.intake.v1`. For an insurer: takes an authorization request from the agent of a care provider, checks who sent it and that the provider's reviewer signed off exactly this request, decides whether it is complete, files it in the insurer's system and returns an intake record; it makes an intake decision and no coverage decision.

## Status

PROPOSED (built, not deployed). Since 2026-11-24.

Nothing on this page is LIVE or DEPLOYED.

The service is built. Its tests run the hook (the check that comes before the Claim), the job, the report of the attestations, the intake book and the manifest against stand-ins for the identity gateway, the ledger, the insurer portal, a model supplier and the dispute code, with no network. The agent has no registry record, no advert and no job yet. It is the insurer side of use case 2 (prior authorization). Its counterparty is the [Prior Authorization Agent](prior-authorization-agent.md). Every request that it reads is synthetic: no patient exists behind any of it.

## Identity

This agent has no registry record yet.

The table gives the design of the record. A value that the registration fixes reads "assigned at registration".

| Field | Value |
|---|---|
| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |
| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |
| Supplier key | the key of the runtime, listed in the record for the authentication and transaction purposes. The runtime signs its receipts, and the Claim and Submit transactions of its escrows, with it. The service never holds it. The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`. `identity.supplier_key` names it as a key of the DID (`<DID>#<key hash>`). The service does not start unless the public key hashes to the key hash |
| Service key | a key of its own, listed in the record for the authentication and transaction purposes. The service holds it and the runtime does not. It pays for the model hire of the decision, signs the transactions of the challenges that the service files, and signs the request for the JWT-SVID. The manifest publishes its key hash as `keys.buyer_pkh`. The service does not start when this key is the supplier key |
| Delegation keys | none. The manifest lists no delegation key, and the service has no co-sign route |
| Subagents | none. The record names no subagent, and no setting names one |
| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |
| Organisation | the domain `delta.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |
| Public URL | planned: `https://mp-suppliers-intake.vector.apexfusion.org`, the origin of the runtime in the pack. The agent has no advert yet |
| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |
| Claim | a Module-1 claim for each run. The service stakes none. Before a run, an operator command stakes the claim with the service key: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. The command withdraws it after the window, when nobody challenged it. See Claim statements |

## Capability id

`health.priorauth.intake.v1`

The model string in the advert and in every receipt is `insurer-intake-agent-v1`.

The agent is one runtime in front of one service. The runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). It holds the supplier key and has the advert. It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash. The service does the work. It holds the service key and no private supplier key. It runs one job at a time.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals. The Insurer Intake Agent has one advert, so its terms have one group.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 2000000 | 2.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 4000000 | 4.000000 |

The price is the default of the setting `ADVERT_PRICE_LOVELACE`. The two bonds are fixed in the code.

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 480000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` of the runtime | 360000 ms |
| Job deadline, set by the service when a request arrives | 300000 ms |
| Request | at most 900000 bytes of wire payload |
| Model calls | one for each job: the decision `completeness` |
| Jobs at a time | one: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |
| Budget of one read of the hook, `CHECKS_READ_BUDGET_MS` | 1200 ms by default, from 500 to 1499 ms. The hook makes 6 timed reads, and 6 reads of the widest budget stay under 9000 ms |
| Report of the attestations | at most 45000 ms for the whole report, and 15000 ms for one read |

**The request limit.** The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. The manifest publishes it in `terms.input_limits.request_bytes`. The limit does not count the body of the call that a buyer makes to the runtime. The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte. The runtime refuses a body above 1048576 bytes (1 MiB). So the limit of 900000 bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below 1048576 bytes. The service reads at most 1000000 bytes of wire payload and refuses more with `request_too_large` (400).

**The money.** A hire of the advert locks its price and both bonds: 4 units. The buyer pays the lock from a vault of its delegation, and the value limit of the delegation caps that payment. On Accept the agent receives the price and the supplier bond, and the buyer's bond returns to the buyer. If the buyer does not accept within 600 s of the Submit, the agent may Release the escrow and take the price and both bonds. If the agent never submits, the buyer reclaims after `deliver_by`. A request that the hook refuses, and a job that fails after the Claim, end that way: neither is paid. The service pays for its one model call from the service key.
