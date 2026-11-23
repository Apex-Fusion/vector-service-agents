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

| Route | Called by | Answer |
|---|---|---|
| `POST /precheck` | a runtime, before the Claim | the hook: 200 `{"go":true,"reserved_ms":120000}`, or a refusal with its code |
| `POST /` | a runtime, after the Claim | the job: the confirmation of the order, or an error |
| `GET /lots.json` | anyone | the lots file |
| `GET /agent.json` | anyone | the manifest |
| `GET /healthz` | anyone | `{"ok":true}` while the service runs |

`POST /` and `POST /precheck` need the token that only the runtimes hold. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read. `GET /lots.json`, `GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`. A buyer sends its job to the runtime of its advert, on the runtime route `/v1/job` of the manifest, and never to the service.

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

`FAULT_MODE=confirm_wrong_lot`: the confirmation names another lot and quantity than the purchase order, and the order that the service places has that wrong lot. The wrong lot of `lot-small` is `lot-medium`. The wrong lot of any other lot is `lot-small`. The quantity is the size of the wrong lot for the SKU in the lots file. A failure run uses the switch, to show that the agent of the buyer refuses a confirmation that breaks S1.

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
