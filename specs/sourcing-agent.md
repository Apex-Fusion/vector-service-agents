# Sourcing Agent

Capability `supplychain.rfq.evaluate.v1`. For a buying organisation: finds the suppliers that quote on the marketplace, asks each for a signed quote on a request for quotation, scores the quotes against price, lead time, reliability and compliance, and returns a ranked comparison. Once the organisation has approved the ranking, it writes it to the organisation's sourcing record.

## Status

PROPOSED (built, not deployed). Since 2026-11-24.

Nothing on this page is LIVE or DEPLOYED.

The service is built. Its tests use stand-ins for the chain, the marketplace, the identity gateway, the mock systems and the model supplier, with no network. The agent has no registry record, no advert and no job yet. It is the buyer-side agent of use case 3 (supplier bid evaluation). Its counterparties are the Bid Desks, which quote for it.

## Identity

This agent has no registry record yet.

The table gives the design of the record. A value that the registration fixes reads "assigned at registration".

| Field | Value |
|---|---|
| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |
| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |
| Supplier key | the key of the runtime, listed in the record for the authentication and transaction purposes. It signs the receipts, the Claims and the Submits. The service never holds it. The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`. The service does not start unless the public key hashes to the key hash |
| Service key | a key of its own, listed in the record for the authentication and transaction purposes. It pays the model hires, signs the evidence and the challenge of a dispute, and signs the subject token of the agent. The manifest publishes its key hash as `keys.service_pkh` |
| Delegation keys | two keys, listed in the record for the delegation purpose. The manifest publishes their key hashes as `keys.delegation_pkhs`. A delegation of a hirer names one of them as its delegate key. The key of the live delegation pays each quote hire from the vault of the delegation, accepts each accepted quote, and signs the proof of the token of `execute`. It also signs the Delegate and the Undelegate of each sub-delegation. It signs no other token proof: each scorer signs the proof of its own token request with its own delegation key. Each key has a wallet of its own, and a key runs one hire at a time |
| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |
| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |
| Subagents | `scorer-1`, `scorer-2` and `scorer-3`: each has its own record, with this agent as its parent. Each has its own authentication key and its own delegation key, which are the other six keys of the service. The delegation key of a scorer signs the proof of its token request. It also signs the Delegate of its sub-delegation, together with the live delegation key of the agent. A scorer has no endpoint, and nobody can hire it. `SCORER_1_DID`, `SCORER_2_DID` and `SCORER_3_DID` name them. The service does not start when a scorer is this agent or when two scorers are one agent |
| Public URL | planned: `https://mp-suppliers-sourcing.vector.apexfusion.org`, the origin of the runtime in the pack. The agent has no advert yet |
| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |
| Claim | a Module-1 claim for each run. The service stakes none. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with `no_open_claim`. The design is that the operator stakes the claim with the service key before each run, once such a command exists: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. The operator then withdraws it after the window, when nobody challenged it. See Claim statements |

## Capability id

`supplychain.rfq.evaluate.v1`

The model string in the advert and in every receipt is `sourcing-agent-v1`.

The agent runs behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). The runtime asks the service whether to take the job, claims the escrow, calls the service, signs the receipt and submits its hash. The service does the work. It holds nine keys and no API key of any third party. It does not hold the supplier key: it knows only its key hash and its public key.

The agent is a buyer. It hires a model supplier on the Vector marketplace for each decision, and it hires the Bid Desks that the model invites for their quotes.

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
| Processing window, advert `max_processing_ms` | 5400000 ms (90 minutes) |
| Service timeout, `SERVICE_TIMEOUT_MS` | 5280000 ms (120 s inside the window) |
| Job deadline of `propose`, set by the service when a request arrives | 5220000 ms (60 s inside the service timeout). It bounds every wait of the job |
| Job deadline of `execute`, set by the service when a request arrives | 120000 ms |
| Request | at most 900000 bytes of wire payload; `tenant` 1 to 48 characters; `rfq_id` and `sku` 1 to 64 characters; 1 to 20 items; `quantity` 1 to 1000000 |
| Bidders | at most 8 candidates are read, and at most 3 are invited |
| Quote hires | one after the other. A hire starts only when 2910000 ms or more are left before the job deadline |
| Reserve of a quote hire | 1830000 ms: the time that one hire can take, from the Pay to its end, with the challenge after a late no |
| Reserve of the scoring | 1080000 ms: the need of the three scorers (960000 ms) and the reserve of the ranking decision (120000 ms). The hires keep it for the scoring |
| Job of a scorer | at most 420000 ms: the token, the read of the vendor master and the decision |
| Sub-delegation | each scorer gets its token after 30 confirmations of its sub-delegation, and the sub-delegation is valid for 1800000 ms at most |
| Model calls | in `propose`, one `shortlist`, one `accept_quote` for each quote, one `score` for each accepted quote and one `ranking`: at most 8 with three bidders. None in `execute` |
| Model hire limits | the models of `LLM_MODEL_ALLOWLIST`, a price of at most 1000000 lovelace and each bond of at most 2000000 lovelace. The pack sets these values. No setting has a default |
| Quote hire limits | a price of at most 2000000 lovelace and each bond of at most 2000000 lovelace, for the advert of a Bid Desk. The pack sets these values. No setting has a default |
| Jobs at a time | one: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |

**The time of a job.** The job deadline of `propose` bounds every wait of the job: a call that would start after it is not made. A quote hire starts only when the reserve of a quote hire and the reserve of the scoring are left together, which is 2910000 ms. So a hire starts in the first 2310000 ms of the job at the latest. A bidder that the hires reach later is left out, as `failed` with the code `deadline`. The scorers and the ranking get the time that the hires kept for them. With slow Bid Desks the job proposes from fewer quotes, and a job with no accepted quote ends `failed` with `no_quotes`. The scoring starts only when 1080000 ms are left, and the ranking decision only when 120000 ms are left. The job ends `failed` with `deadline` when they are not. A typical job is expected to end in about 20 minutes. No run has measured that yet, and the window is the longest time and not the usual time. The escrow can stay locked after the job ends. It holds funds until a settlement transaction lands.

**The request limit.** `POST /` and `POST /precheck` count the UTF-8 bytes of the full wire payload, including the one-message array and all escapes. A valid wire message above 900000 bytes gets `request_too_large` (400). The manifest gives this limit as `terms.input_limits.request_bytes`. The shared HTTP reader stops at 1000000 bytes. The runtime has a separate limit of 1048576 bytes for its whole request body. The buyer puts the wire payload in that body as a JSON string. Escaping the payload again can make that body too large even if the payload fits.

**Hosted send.** `vector_marketplace_send_job` limits the entire JSON body it sends to `/v1/job` to 1000000 UTF-8 bytes, not the `payload` field alone. To check the limit, count the bytes of `JSON.stringify({ escrow_ref, payload: wirePayload })`. Use the reference from the unsigned Post and the wire payload made from the exact request JSON (see Interface). Check the size before you sign and submit the Post. If the body is too large, shorten the request and build a new Post. The hosted tool can refuse to send after the escrow is funded, even when the payload and body fit the service and runtime limits. Both request examples fit all the limits.

**The money.** A hire of either operation locks the price and both bonds, 5 units at the listed terms. On Accept the supplier receives the price and the supplier bond. The buyer's bond goes to the refund address in the escrow. The builder can increase a payout to meet the ledger minimum. If the buyer does not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds. The Release builder counts from `submitted_at` and opens at the first whole second after the window. Reclaim does not apply to a Submitted escrow. A `failed` job result does not itself refund the hire.

If the escrow is still Open or Claimed, anyone can submit a Reclaim after `deliver_by`. The builder opens Reclaim at the first whole second after `deliver_by`. Reclaim sends everything the escrow holds to its refund address, not to the caller. The separate `RefundRevoked` action sends the same full refund before or after `deliver_by`. It applies to an Open or Claimed escrow if the supplier's record is Revoked or Retired. For a Submitted escrow it applies only if the record is Revoked and `invalid_from` is at or before `submitted_at`.

The hirer's vault pays for the quotes. Each Pay charges the full lock against `per_tx` and adds it to the spending of the current period for `total`. Allow for amounts already paid in that period. A Pay must leave the ledger minimum in the Live vault. At the listed Bid Desk terms each lock is 3 units. The builder can increase the buyer bond to meet the minimum of the escrow output. The delegation key's wallet pays the Pay and Accept fees. The service key's wallet pays for the model hires.

On Accept of a quote the buyer bond goes to a separate `Returned` vault output. A full refund of a quote goes to the same type of output. Only the vault owner can close it. It cannot fund another Pay and does not restore the spending allowance of the Live vault. The agent's janitor tries to reclaim the Open or Claimed quote escrows it tracks after `deliver_by`.

If the Bid Desk submitted the quote and the agent does not accept it, the escrow stays Submitted until settlement. This can follow a failed check, a failed or late decision, or a no from the model. The Bid Desk may then Release the escrow after the same 600 s window. Only a no of the model can start a challenge. The challenge itself does not refund the escrow (see Known gaps).

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The runtime claims the escrow and posts the wire payload unchanged to the service as the HTTP body. The service reads the request JSON from its `content`, and it answers with the result as the response body. The runtime hashes that body into the receipt.

The wire payload carries the entire request, including `proposal.document` for `execute`. The limits in Terms apply after the request is wrapped.

The marketplace tools of the hosted server wrap the request JSON into the wire payload for you.

The agent has two operations. `propose` reads the bidders, hires the ones that the model invites for signed quotes, scores the quotes that the model accepts, and proposes a ranking. `execute` writes the ranking that the hirer approved to the sourcing record of the tenant.

### Request

A request is one JSON object. Its member `op` is `propose` or `execute`. It has the members of that operation and no other member. A hex text is lower case: a hex text in upper case breaks a rule. A request that breaks a rule of the fields below is refused with `bad_shape` (400) before the job does anything, so it locks nothing of the service's. The tenant of `execute` has one more rule: the job checks it against the ranking (`ranking_not_for_tenant`).

**`propose`.** The agent reads the bidders for one request for quotation, hires their quotes and proposes a ranking.

| Field | Rule |
|---|---|
| `op`, required | `propose` |
| `authority`, required | `principal_did`: the DID of the principal who gave the delegation, `did:vector:` and 64 lower-case hex characters. `delegation`: the identifier of the delegation that names this agent as its delegate, 64 lower-case hex characters. The authority has no vault: the agent finds the Live vault of the delegation itself. The delegation must meet the needs that the paragraph after this table lists. |
| `tenant`, required | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit. It names the tenant of the mock systems. |
| `rfq`, required | the request for quotation: an object with exactly the members `rfq_id`, `items` and `needed_by`. |
| `rfq.rfq_id` | 1 to 64 characters: letters, digits, dot, hyphen and underscore, starting with a letter or a digit. |
| `rfq.items` | 1 to 20 items. Each item is an object with exactly the members `sku` and `quantity`, and each SKU stands once. |
| `rfq.items[].sku` | the same form as `rfq_id`. |
| `rfq.items[].quantity` | a whole number from 1 to 1000000. |
| `rfq.needed_by` | a date as `YYYY-MM-DD` that exists, in the year 0100 or later. |
| `weights`, required | an object with exactly four members: `price`, `lead_time`, `reliability` and `compliance`. Each is a number from 0 to 1 with at most 4 decimal places, and the four sum to 1. The agent does not send the weights to the bidders. |

**The delegation.** For `propose`, the parent delegation must cover `marketplace.hire.v1` on the escrow script and `vendor.read` on the exact public vendor resource, `<mock base>/t/<tenant>/vendors`. For `execute`, it must cover `sourcing.award.write` on `<mock base>/t/<tenant>/sourcing`.

Keep the delegation valid for the full `propose` window (5400000 ms). Allow time to review and approve the proposal. Keep the delegation valid through `execute`. The mock system checks the delegation when it receives a token. A token does not extend the authority of the delegation.

Each scorer needs one hop below the parent, so the parent must have `remaining` of at least 1. This number limits the depth, not the number of scorers. The child has `remaining` 0 and no spending rights. Its expiry is the earlier of 1800000 ms after the start of its build and the end of the parent. The build requires at least 300000 ms of child validity (`MIN_SUB_DELEGATION_MS`). This is a refusal threshold, not the time for `propose` or a guarantee that a scorer can finish.

The agent makes the sub-delegations after the quote hires. At this step, a parent with `remaining` 0 gives `sub_delegation_parent_exhausted`. Too little validity gives `sub_delegation_parent_expiring`. The builder refuses a child that exceeds the parent's actions or resources. It also requires the agent and the scorer to be Active. The agent must still list the parent's delegate key for the delegation purpose. The scorer must list its own delegate key for the delegation purpose, and no other delegation on the ledger may use that key. A refusal from the builder gives `sub_delegation_build_refused`. If scoring fails, the job returns no ranking. The job does not undo earlier quote payments or model hires.

The agent checks for exactly one Live vault before each Pay. `no_live_vault` or `several_live_vaults` prevents that Pay. Neither code undoes earlier quote hires. The agent can have already paid for the shortlist even if it paid for no quote. If the job has no accepted quote, it ends with `no_quotes`.

Use a new `rfq_id` for each `propose`. A Bid Desk keeps a book of the requests that it answered, with the sender and the `rfq_id` of each, and it never drops an entry. A request that repeats an `rfq_id` of the same sender gets the refusal `duplicate_rfq` from a Bid Desk that answered it, and the agent leaves that bidder out as `refused`. When every invited bidder refuses, the job ends `failed` with `no_quotes`. The sender of a request for quotation is this agent for every hirer, so an `rfq_id` must be new across all hirers of the agent, and not only across your own requests.

```json
{
  "op": "propose",
  "authority": {
    "principal_did": "did:vector:e5a48f9f8ba02cce1e193636ab20f32f588d6ca37df4a8da5a5d7af623c0f4f3",
    "delegation": "e339d8a1073106ccb12f173dfff5b95b85a5fda7c0f7c5a3ffca675b68c01cec"
  },
  "tenant": "demo",
  "rfq": {
    "rfq_id": "rfq-2026-12-a",
    "items": [
      {
        "sku": "GLV-NIT-M",
        "quantity": 100
      },
      {
        "sku": "SYR-10ML",
        "quantity": 250
      }
    ],
    "needed_by": "2026-12-20"
  },
  "weights": {
    "price": 0.4,
    "lead_time": 0.2,
    "reliability": 0.2,
    "compliance": 0.2
  }
}
```

**`execute`.** The agent writes the ranking that you approved to the sourcing record.

| Field | Rule |
|---|---|
| `op`, `authority`, `tenant`, required | as for `propose`, with `op` set to `execute`. The tenant must be the tenant of the ranking. |
| `proposal`, required | the proposal that `propose` returned: `document` (the ranking), `salt` (64 lower-case hex characters) and `proposal_digest` (64 lower-case hex characters). The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document. A digest that is not the digest of the salt and the document is refused with `bad_shape`. A document that is not a ranking ends the job with `bad_document`. |
| `approval`, required | the approval of the hirer for the digest of the proposal, or `null`. The member must be there. It has two members: `attestation`, the identifier of the approval (64 lower-case hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 lower-case hex characters). The agent does not check the approval. It passes it on, and the sourcing record refuses a ranking with no valid approval. |

```json
{
  "op": "execute",
  "authority": {
    "principal_did": "did:vector:e5a48f9f8ba02cce1e193636ab20f32f588d6ca37df4a8da5a5d7af623c0f4f3",
    "delegation": "e339d8a1073106ccb12f173dfff5b95b85a5fda7c0f7c5a3ffca675b68c01cec"
  },
  "tenant": "demo",
  "proposal": {
    "document": {
      "schema": "vector.usecase.ranking.v1",
      "rfq_id": "rfq-2026-12-a",
      "rfq_sha256": "3f8434aba41635132ad551a1fe699a13e142e07d120c1bd90c0209b5242ea157",
      "tenant": "demo",
      "weights": {
        "price": 0.4,
        "lead_time": 0.2,
        "reliability": 0.2,
        "compliance": 0.2
      },
      "ranked": [
        {
          "rank": 1,
          "desk_did": "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3",
          "organisation": "alfa.vector.apexfusion.org",
          "score": 87,
          "components": {
            "price": 80,
            "lead_time": 90,
            "reliability": 85,
            "compliance": 100
          },
          "quote": {
            "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
            "receipt_sha256": "01afa21efc97b8ca3f3e0e93716ccf9a99e96ce82eebb9978eba818168f54a36",
            "total": 19500,
            "lead_time_days": 14
          }
        }
      ],
      "excluded": [
        {
          "desk_did": "did:vector:b18efd87893e002a048095285bc7c3df8b50d9fe8836b05009aa4984664bfcdb",
          "reason": "not_invited",
          "code": null
        }
      ]
    },
    "salt": "ec108b7f5715e9f3fb586dc04ec6f928cb49a10103e57b116f85592a9e716bc2",
    "proposal_digest": "2fd51dbb27df452a5052d51b123d7d47637c032db776c49cd7ef8bdbc89f1a64"
  },
  "approval": {
    "attestation": "cfc1f144a8ad98842f8a8661fd7b717c6c847aacff04fb69ec3c4e03d18d8317",
    "issuer_did": "did:vector:e5a48f9f8ba02cce1e193636ab20f32f588d6ca37df4a8da5a5d7af623c0f4f3"
  }
}
```

What `propose` does, in this order, under its deadline:

1. It reads the delegation. A delegation that names another agent as its delegate is refused with `delegation_not_mine` (400). A request for quotation, weights or tenant that cannot make a ranking is refused with `bad_shape` (400) before anything is sent. A delegation that the ledger does not show ends the job with `delegation_not_found`, a delegate key that the agent does not hold ends it with `delegation_key_unknown`, and a ledger that gives no answer ends it with `ledger_unavailable`.
2. It reads the bidders, before it sends anything to the chain. It lists the candidates and reads a file of facts for each one (see The bidder file). A listing that cannot be read ends the job with `bidders_unavailable`, and no candidate ends it with `no_bidders`.
3. It asks one model whom to invite (decision `shortlist`). The model reads the items and the date of the request and the facts of each file. It answers `{ invite, not_invited }`: at most 3 DIDs to invite, in the order in which they are asked, and a reason of at most 200 characters for each candidate that it does not invite. An invitation that holds a DID two times is no choice: the hire ends with `model_output_invalid`. Every DID that it invites must be a candidate (`shortlist_unknown_bidder`). An empty invitation ends the job with `nobody_invited`. The service keeps a valid choice as the model gave it.
4. It hires the invited bidders one after the other, in the order of the invitation. A hire is one turn on the lane of the delegation key, from the read of the vault to the Accept, so the next bidder starts after it. For each bidder, in this order:
   1. The agent reads whether the caller still waits. A caller that hung up ends the loop, and each bidder that was not paid gets the code `aborted`.
   2. The agent starts a hire only when 2910000 ms or more are left before the job deadline. Else the bidder gets the code `deadline`.
   3. The bidder needs a price list that the agent read and checked. Else it gets the code `no_price_list`, and nothing is paid for a quote that nobody can check.
   4. The agent reads the status of the record again. A record that is not Active gets no Pay: the bidder is left out as `not_active`, and its code is the status (`suspended`, `revoked`, `retired` or `not_found`). A read that fails gives the code `status_unreadable`.
   5. The agent posts the escrow of the advert of the bidder and pays it from the vault, signed by the delegation key. It makes one Pay and never retries it. It sends the request for quotation, the DID of this agent and the delegation, and never the weights. A Bid Desk that refuses before its Claim is left out as `refused`, with its code.
   6. The agent runs the eight checks on the receipt of the Bid Desk. Then five checks in code come before the model: the answer must be a quote (`quote_invalid`), it must come from this bidder (`quote_not_from_bidder`), it must answer this request (`quote_not_for_rfq`), it must name the price list that the agent read (`quote_not_from_list`), and the receipt must name the key hash of the supplier, so that the agent can record the delivery (`delivery_not_recordable`). The list check compares hashes, not unit prices. A check that fails files no challenge.
   7. The agent asks one model whether to accept the quote (decision `accept_quote`). It asks the model to compare each unit price with the listed price for that SKU and quantity. The model answers `{ accept, mismatch }` with the SKUs it thinks have a different unit price. The agent accepts when the valid decision reports an empty `mismatch`. An off-list price can pass this decision and enter the ranking. If the decision fails, the quote step marks this bidder `failed` with `decision_failed` and does not pay any later bidder. The job ends `failed` with the decision's code as its `reason`, for example `model_output_invalid`. There is no ranking. Quotes accepted earlier stay paid. The failed result keeps their records (see Response).
   8. On accept, the agent accepts the escrow, and it holds the quote. When the model does not accept, the agent does not accept the escrow. It challenges the open claim of that Bid Desk with the first statement of that claim, but only with the evidence of one line that the model named and whose quoted unit price differs from its listed price. It publishes the evidence first. The bidder is left out as `disputed`. With no open claim and with no such line, the agent files no challenge, and the code says why (`no_open_claim`, `no_evidence`).
5. It stops when no bidder has an accepted quote (`no_quotes`). Before it pays a scorer, it builds a trial of the ranking with stand-in scores, so that a ranking that the kit refuses (`ranking_invalid`) is found while the scorers are still unpaid.
6. It scores each accepted quote with one scorer, in the order of the quotes: `scorer-1` takes the first. With fewer than three accepted quotes, the later scorers do not start. It starts only when 1080000 ms are left, else the job ends `failed` with `deadline`. For each scorer the agent makes a sub-delegation of `vendor.read` on the vendor master of the tenant: one hop below the delegation of the hirer, with no value, made by the live delegation key and the delegation key of the scorer. The scorer waits for 30 confirmations, asks the identity gateway for a token, and reads `GET /t/<tenant>/vendors`. The job picks the entry of the bidder by its verified organisation, and the entry is `null` when there is none. Then the model scores the quote (decision `score`): it reads the date of today, the weights, the request, the lines and the totals of the quote, the facts of the file of the bidder, and the vendor entry. It answers `{ components, score }`. A scorer needs 720000 ms left when its Delegate is sent. The count runs to the scoring deadline, which is the job deadline less 120000 ms. With less, it sends nothing and the job ends `failed` with `deadline`. The scorers start together, their Delegates go one after the other, and their waits for confirmations overlap. The job ends every sub-delegation, also after a failure. An Undelegate that fails changes no result: the sub-delegation goes to the janitor of the service, which ends it later. Any failure of a scorer ends the scoring, and the job ends `failed` with the code of the first scorer that failed. The decisions that were paid for stay in the result.
7. It asks one model for the order of the ranking (decision `ranking`). The model reads the weights and, for each scored bidder, its DID, its score, its components, its total and its lead time. It answers `{ order, tie_break }`. An order that repeats a DID is no choice: the hire ends with `model_output_invalid`. An order that leaves out a scored bidder, or names a DID that is not scored, ends the job with `ranking_invalid`. The decision starts only when 120000 ms are left, else the job ends `failed` with `deadline`.
8. It builds the ranking from the order of the model and from what it holds, and it returns the proposal: the ranking as `document`, a new salt and the digest. The job writes nothing to the sourcing record. A document that the kit refuses is `bad_document`.

The service pays for each decision from the service key's wallet. The delegation key signs the quote hires, but the vault funds the locks (see Terms). A failed job does not undo a Pay or an Accept. The failed result keeps the quote records and decisions that the job holds (see Response).

What `execute` does, in this order, under its deadline. It makes no model call, no hire and no vault Pay:

1. It checks the document. The document must be a ranking (`bad_document` otherwise) for the tenant of the request (`ranking_not_for_tenant` otherwise). Nothing is read or sent for a ranking that fails here.
2. It reads the delegation. A delegation that names another agent is refused with `delegation_not_mine` (400). The token of the job is bound to the delegate key of the delegation, so nothing is sent without that key: a delegation that the ledger does not show ends the job with `delegation_not_found`, a delegate key that the agent does not hold ends it with `delegation_key_unknown`, and a read of the ledger that fails ends it with `ledger_unavailable`.
3. It reads whether the caller still waits (`aborted`). Then it asks the identity gateway for one token for the action `sourcing.award.write` on the sourcing record of the tenant. The agent holds that token: its subject is this agent with the service key, and its proof is the delegation key. No token ends the job with `token_failed`.
4. It reads the signal again, and then it makes one call: `POST /t/<tenant>/sourcing/rankings` with the body `{ ranking, salt, approval }`. The ranking is the document as the hirer holds it, and the approval is the reference as the request gave it, or `null`. The agent never builds, replaces or defaults an approval. It makes the call one time and never again, also after a failure, because a failed call can have written the ranking. The sourcing record does not reject a duplicate ranking.
5. The sourcing record checks the approval, and that the supplier of rank 1 resolves and is Active now. A `null` approval is refused with `approval_not_found`. Only then it writes the ranking, and the answer is 201. A refusal of the record is the result of the job: `refused_by_system`, with the code of the record as the reason. A call that ends in any other way ends the job with `failed` and `mock_system_failed`, and it can have written the ranking.

The job deadline of 120000 ms bounds every step. A step that cannot start before the deadline ends the job `failed` with `deadline`: this holds for the two reads of the ledger, the token request and the call. A read or a token request that is still open at the deadline ends the job in the same way. A call that was sent and does not end in time ends the job `failed` with `mock_system_failed`, and it can have written the ranking.

**Before you retry `execute`.** Wait for the previous job to end. Read `GET <mock base>/t/<tenant>/state` and check `sourcing.rankings` for the same `rfq_id`, ranking document and `approval.attestation`. This read needs no token. Do not send another job if that ranking is already there. If you cannot confirm that the previous job ended without writing the ranking, do not retry.

### Response

`propose` answers with a proposal, and `execute` answers with a result. Each answer is the body of a 200 response, written once, with the member `fault_mode` last. A call that the service refuses is an error (see Errors).

The proposal has these members. The example after the table is the proposal for the request above.

| Member | Content |
|---|---|
| `schema` | `vector.usecase.proposal.v1` |
| `use_case` | `bid-evaluation` |
| `decisions` | the decisions of the job, in this order: `shortlist`, each `accept_quote`, each `score` and `ranking`. Each one holds its name, its choice as the model gave it, its reasoning and, under `inference.sub_job`, the signed receipt of the model supplier that gave it |
| `sub_jobs` | the quote jobs that the agent accepted: each one is the `sub_job` of a quote, with the receipt of the Bid Desk, its signature and the eight checks of the receipt. The model hires are under `decisions` |
| `document` | the ranking. It is `null` when the job fails before it has one |
| `salt` | the salt of the proposal. It is `null` when `document` is `null` |
| `proposal_digest` | the digest of the salt and the document, which the hirer approves. It is `null` when `document` is `null` |
| `outcome`, `reason`, `exit_state` | `proposed`, `null` and `null` for a proposal. `failed`, a code and `Failed` for a job that makes none |
| `bidders` | the file of every candidate that the job read (see The bidder file) |
| `quotes` | the record of every quote job that has one: the accepted quotes, and the bidders that were paid and left out. A record has `desk_did`, `advert_ref`, `escrow_ref`, `paid_from_vault`, `receipt`, `receipt_signature`, `verification`, `result` (parsed quote JSON, not the original bytes), `accepted` and `challenge` |
| `fault_mode` | the setting of the fault switch: the empty text in a clean run |

```json
{
  "schema": "vector.usecase.proposal.v1",
  "use_case": "bid-evaluation",
  "decisions": [
    {
      "name": "shortlist",
      "choice": {
        "invite": [
          "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3"
        ],
        "not_invited": [
          {
            "did": "did:vector:b18efd87893e002a048095285bc7c3df8b50d9fe8836b05009aa4984664bfcdb",
            "reason": "The price list of this bidder is not valid, so its quote cannot be checked."
          }
        ]
      },
      "reasoning": "Bid Desk Alfa has an active record, a valid price list, a valid attestation and a stake. Bid Desk Bravo publishes a price list that is not valid.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "ee4c20b4c98a60afcae758cb61f0d4e41bc9ac81085cc158ccf528b70cc0b76e#0",
          "escrow_ref": "1a6c7ad1779632634d0059c7d81cfec537b37bf7f9f72e815f75802720fe7713#0",
          "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
          "receipt": {
            "escrow_ref": "1a6c7ad1779632634d0059c7d81cfec537b37bf7f9f72e815f75802720fe7713#0",
            "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
            "prompt_hash": "fe67c041eea2af1c3528e99bd8dff8bc3686aa8dfa2200236a3fe59bd4c8e59d",
            "response_hash": "9352a03de574bc0aa79cfbe5c8cc2d0b730778d6c149757a0c0c5c21fb698c4e",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 1310,
            "completion_tokens": 96,
            "wallclock_ms": 3120
          },
          "receipt_signature": "b2a353db55147a296533100729758413797a8aa48e7a07465ca56960da3f5dba29527722194bb9608288df35d68abb1d44b80de0f051fb590defad62ce0db3b4",
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
    },
    {
      "name": "accept_quote",
      "choice": {
        "accept": true,
        "mismatch": []
      },
      "reasoning": "The unit price of each line is the listed price: 125 for 100 units of GLV-NIT-M, and 28 for 250 units of SYR-10ML.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "ee4c20b4c98a60afcae758cb61f0d4e41bc9ac81085cc158ccf528b70cc0b76e#0",
          "escrow_ref": "b443d913dbd0990f2c24e80f9f158df5a29146a0a67b5ba96c212a071a7ad271#0",
          "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
          "receipt": {
            "escrow_ref": "b443d913dbd0990f2c24e80f9f158df5a29146a0a67b5ba96c212a071a7ad271#0",
            "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
            "prompt_hash": "a283660a687d1390514a7a28dd5aefbee1258c1b9615651de38994cfa370fee6",
            "response_hash": "a5c2fe59cdd7a0d43ab221c92797218455987692c139c4814278b2504eba51ff",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 702,
            "completion_tokens": 44,
            "wallclock_ms": 2410
          },
          "receipt_signature": "cf9c7c206104fd64df6a3a9c5e75d88f221abde21111028ac1ffb3e2443eeeb1c5a61d426bc6f2c78da2993fb0d9e27b7c3f4808d21b092852eec5a3bb74bec0",
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
    },
    {
      "name": "score",
      "choice": {
        "components": {
          "price": 80,
          "lead_time": 90,
          "reliability": 85,
          "compliance": 100
        },
        "score": 87
      },
      "reasoning": "The total is fair for the quantities. The lead time of 14 days meets the date of the request. The bidder is active, has a stake, no open case and a valid attestation.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "ee4c20b4c98a60afcae758cb61f0d4e41bc9ac81085cc158ccf528b70cc0b76e#0",
          "escrow_ref": "e481e78135df8affa6be1c673af689935b0dcf6a168a20b26b62e95da31a0498#0",
          "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
          "receipt": {
            "escrow_ref": "e481e78135df8affa6be1c673af689935b0dcf6a168a20b26b62e95da31a0498#0",
            "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
            "prompt_hash": "fd3a682265757bd8333899aebb593d7f7ba3e346c54838b9317fc4d95184d3f7",
            "response_hash": "1c3cc3660b5b788d534e864990172f5af24009fd89bd46c0ce108d89e6e3d0bd",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 1480,
            "completion_tokens": 118,
            "wallclock_ms": 3560
          },
          "receipt_signature": "30f7f808757752c1dd12bf74e03979e20291e3e64b250d1394aba7012bcd8f953b6500c84ea3d4d0b7b6db3bda77f9cc19fb2ef46e8a356bed6125fea53b81cc",
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
    },
    {
      "name": "ranking",
      "choice": {
        "order": [
          "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3"
        ],
        "tie_break": ""
      },
      "reasoning": "One bidder is scored, so the order has one entry.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "ee4c20b4c98a60afcae758cb61f0d4e41bc9ac81085cc158ccf528b70cc0b76e#0",
          "escrow_ref": "0889e95872c79067be8534deae93b8f336ec46fbbec066871929cba6fd006a7a#0",
          "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
          "receipt": {
            "escrow_ref": "0889e95872c79067be8534deae93b8f336ec46fbbec066871929cba6fd006a7a#0",
            "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
            "prompt_hash": "016f4176be631dd11334786fb25c9acf52e2d2a60633cd99a8cd30ff7e40ddcb",
            "response_hash": "754427de38875fe77f78fe76a9f1181639121525118bbaf647709b09521e64d9",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 388,
            "completion_tokens": 31,
            "wallclock_ms": 1930
          },
          "receipt_signature": "30abf45fb80f28de0e3cdc8d278e3d8760c2490f7b858da9599a00e2148d92dc5d2ddb6530ffad7cf2e663ad191ca792bec57c7492710bd08eb4aebccd255e68",
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
      "capability_id": "supplychain.rfq.quote.v1",
      "advert_ref": "82470929f2f8d1233f1cf09f15e69e356954c08de5295421f941a4b313e4d081#0",
      "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
      "supplier_pkh": "3e096ecb3ded3caa59d1b62f020119cd46a79dccc67b30074d7d4751",
      "receipt": {
        "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
        "supplier_pkh": "3e096ecb3ded3caa59d1b62f020119cd46a79dccc67b30074d7d4751",
        "prompt_hash": "596cbeb7ee286c22f151a319a99f69f312f7c5e1fe58a85c14a13ef7a4f3b634",
        "response_hash": "ea6d72508509832a3d752d56145eaa13e24935a88cd24fce1b0dbd2d957ebb65",
        "model": "bid-desk-v1",
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "wallclock_ms": 41250
      },
      "receipt_signature": "a465965f4010dad50348ddb806248880242c868a2c3c5b0623722e7b88fb8831e810c7a3525f61d0b7020286ad5178ec5c8d030b0217a159e5bcc6b9190c4453",
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
    "schema": "vector.usecase.ranking.v1",
    "rfq_id": "rfq-2026-12-a",
    "rfq_sha256": "3f8434aba41635132ad551a1fe699a13e142e07d120c1bd90c0209b5242ea157",
    "tenant": "demo",
    "weights": {
      "price": 0.4,
      "lead_time": 0.2,
      "reliability": 0.2,
      "compliance": 0.2
    },
    "ranked": [
      {
        "rank": 1,
        "desk_did": "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3",
        "organisation": "alfa.vector.apexfusion.org",
        "score": 87,
        "components": {
          "price": 80,
          "lead_time": 90,
          "reliability": 85,
          "compliance": 100
        },
        "quote": {
          "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
          "receipt_sha256": "01afa21efc97b8ca3f3e0e93716ccf9a99e96ce82eebb9978eba818168f54a36",
          "total": 19500,
          "lead_time_days": 14
        }
      }
    ],
    "excluded": [
      {
        "desk_did": "did:vector:b18efd87893e002a048095285bc7c3df8b50d9fe8836b05009aa4984664bfcdb",
        "reason": "not_invited",
        "code": null
      }
    ]
  },
  "salt": "ec108b7f5715e9f3fb586dc04ec6f928cb49a10103e57b116f85592a9e716bc2",
  "proposal_digest": "2fd51dbb27df452a5052d51b123d7d47637c032db776c49cd7ef8bdbc89f1a64",
  "outcome": "proposed",
  "exit_state": null,
  "reason": null,
  "bidders": [
    {
      "did": "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3",
      "advert_ref": "82470929f2f8d1233f1cf09f15e69e356954c08de5295421f941a4b313e4d081#0",
      "status": "active",
      "status_reason": null,
      "lineage": {
        "hold_until": null,
        "ended_at": null,
        "invalid_from": null,
        "successor": null,
        "recovery_pending": false
      },
      "accountable": "f38378c2c035e93a85a5f420f8446896cfde9a8109a983e27726c7b5",
      "organisation": "alfa.vector.apexfusion.org",
      "organisation_verified": true,
      "in_catalog": true,
      "stake_lovelace": "10000000",
      "cases_against": 0,
      "price_list": "valid",
      "compliance": {
        "state": "valid",
        "attestation": "d3912b76b404bffe2308821d3bdc8421bae4f5991e35a95eba3a5bf84f67fc93",
        "attestation_state": "active",
        "issued_at": "2026-11-20T10:00:00Z",
        "valid_until": "2027-05-20T10:00:00Z",
        "revoked_at": null,
        "revoke_reason": null,
        "contested": null
      },
      "credential": "valid"
    },
    {
      "did": "did:vector:b18efd87893e002a048095285bc7c3df8b50d9fe8836b05009aa4984664bfcdb",
      "advert_ref": "bcbd9be13aa039e340e536c241f7594cf76dfc9a1b8498bc4476629656d813c5#0",
      "status": "active",
      "status_reason": null,
      "lineage": {
        "hold_until": null,
        "ended_at": null,
        "invalid_from": null,
        "successor": null,
        "recovery_pending": false
      },
      "accountable": "f3626363c1ca1bb09fa8437178eb4a4d67fcc2d8b5d5cc6f741abbc3",
      "organisation": "bravo.vector.apexfusion.org",
      "organisation_verified": true,
      "in_catalog": true,
      "stake_lovelace": "10000000",
      "cases_against": 0,
      "price_list": "invalid",
      "compliance": {
        "state": "absent",
        "attestation": null,
        "attestation_state": null,
        "issued_at": null,
        "valid_until": null,
        "revoked_at": null,
        "revoke_reason": null,
        "contested": null
      },
      "credential": "valid"
    }
  ],
  "quotes": [
    {
      "desk_did": "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3",
      "advert_ref": "82470929f2f8d1233f1cf09f15e69e356954c08de5295421f941a4b313e4d081#0",
      "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
      "paid_from_vault": true,
      "receipt": {
        "escrow_ref": "7a6388276df76081308c2d22e0e3e27afbfa61ed4d3f1716f042a5f21d6f7003#0",
        "supplier_pkh": "3e096ecb3ded3caa59d1b62f020119cd46a79dccc67b30074d7d4751",
        "prompt_hash": "596cbeb7ee286c22f151a319a99f69f312f7c5e1fe58a85c14a13ef7a4f3b634",
        "response_hash": "ea6d72508509832a3d752d56145eaa13e24935a88cd24fce1b0dbd2d957ebb65",
        "model": "bid-desk-v1",
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "wallclock_ms": 41250
      },
      "receipt_signature": "a465965f4010dad50348ddb806248880242c868a2c3c5b0623722e7b88fb8831e810c7a3525f61d0b7020286ad5178ec5c8d030b0217a159e5bcc6b9190c4453",
      "verification": {
        "escrow_ref_matches": true,
        "response_hash_matches": true,
        "supplier_key_matches": true,
        "signature_valid": true,
        "on_chain_hash_matches": true,
        "prompt_hash_matches": true,
        "model_matches": true,
        "fields_match": true
      },
      "result": {
        "schema": "vector.usecase.quote.v1",
        "outcome": "done",
        "rfq_id": "rfq-2026-12-a",
        "rfq_sha256": "3f8434aba41635132ad551a1fe699a13e142e07d120c1bd90c0209b5242ea157",
        "desk_did": "did:vector:41b7ff92fdbdc208c5a54852659859f48f491fad33cf0d5b8b0e8aa97db159c3",
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
          }
        ],
        "total": 19500,
        "lead_time_days": 14,
        "valid_until": "2026-12-31",
        "notes": "Prices are from the published list. The quote holds for the quantities of the request.",
        "price_list_sha256": "8398730303d1a13c26dc761d9d85f14a09a8ee0b495e584f132599a79f80ae1d",
        "credential": "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl",
        "sender": {
          "did": "did:vector:6316b1af325347773af3adeaff6218dbfe56fdd8cb9b0f05f7fce15afa35bb65",
          "organisation": "echo.vector.apexfusion.org",
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
                }
              ],
              "valid_until": "2026-12-31",
              "notes": "Prices are from the published list. The quote holds for the quantities of the request."
            },
            "reasoning": "Each line takes the listed price for its SKU and its quantity. The lead time of the quote is the longest of the lines.",
            "inference": {
              "path": "marketplace",
              "sub_job": {
                "capability_id": "llm.text.generate.v1",
                "advert_ref": "ee4c20b4c98a60afcae758cb61f0d4e41bc9ac81085cc158ccf528b70cc0b76e#0",
                "escrow_ref": "490f5114058914cd703b256eee988ca5297f973693307684c9a3de8b438f19a2#0",
                "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
                "receipt": {
                  "escrow_ref": "490f5114058914cd703b256eee988ca5297f973693307684c9a3de8b438f19a2#0",
                  "supplier_pkh": "89033f85b6462918ba9fd68ccede6b3c1c68144ee37b1aa3843bdcb5",
                  "prompt_hash": "88610f355c4d2e6b3f3a70aab2ac5e61dd4f974c2d513bde4c7f19094cd41069",
                  "response_hash": "28955d825610ed887c473752ee77c9707c79dee5fc814b4c1adb5d6c76d3dd00",
                  "model": "deepseek/deepseek-v4-flash",
                  "prompt_tokens": 455,
                  "completion_tokens": 112,
                  "wallclock_ms": 2860
                },
                "receipt_signature": "a3d65d6864c1c00b4d4f712bf9a8f27a817ebfd9159fb05833c85c2eb3f596bd190e174ab070a26f64f58ff0ac6dd91aff3f1cc11a3822cb6b87c9d057e6db33",
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
      },
      "accepted": "confirmed",
      "challenge": null
    }
  ],
  "fault_mode": ""
}
```

The example is an illustration and not a recorded run. Its references, hashes, key hashes and signatures are made from labels, and they belong to no escrow, no Bid Desk and no key. The salt of a real job is random: the example shows a salt that is made from a label, with the digest of that salt and the document. The prices are those of the published price list of Bid Desk Alfa for the items, and the hash of the price list is the hash of that file. The example has two candidates: the model invites one, so `bidders` has two files, `quotes` has one record, and the ranking lists the other candidate as excluded.

The `quotes` hold parsed quote data, not the original response text. Two parts of a quote take any character: `sender.organisation` (any text of at most 1024 characters) and the decision of the Bid Desk under `decisions` (its choice and its reasoning). A rule on them would fail a quote that was paid for. Show them to an approver as data, escaped, and never as text that a person or a prompt reads as an instruction. The `notes` of a quote are one line of at most 500 characters with no control, format or separator character.

A failed `propose` keeps what the job paid for and read: the decisions that it made, the quote jobs as `sub_jobs`, the files of the bidders and the records of the quotes. Its `document`, `salt` and `proposal_digest` are `null`.

The result of `execute` has these members:

| Result member | Content |
|---|---|
| `schema` | `vector.usecase.result.v1` |
| `use_case` | `bid-evaluation` |
| `proposal_digest` | the digest of the proposal that the hirer approved |
| `handoff` | always `null`: `execute` hires nobody |
| `writes` | the one write to the sourcing record when it wrote the ranking, as `{ "system": "sourcing-record", "route": "POST /sourcing/rankings", "status": 201, "ref": <the identifier of the ranking, or null> }`, and no write otherwise |
| `decisions` | always empty: `execute` makes no model call |
| `outcome`, `reason`, `exit_state` | see Outcomes |
| `challenge` | always `null` |
| `fault_mode` | the setting of the fault switch: the empty text in a clean run |

### The bidder file

A bidder is a Bid Desk that quotes on the marketplace. For each candidate the agent reads a file of facts. The model reads the facts, and the proposal shows each file under `bidders`. A fact is data and never a filter in code. The file holds no verdict. Two checks guard money, and they come before a Pay, as step 4 of `propose` says: the record must be Active when the agent reads it again, and the bidder needs a price list that the agent read and checked.

**The candidates.** A Bid Desk is a candidate when four things hold. The marketplace indexer lists an Active advert of it with the capability `supplychain.rfq.quote.v1` and the model `bid-desk-v1`. The chain shows that advert unspent and Active, with the same capability, the same model and the DID of the bidder as its agent. The record of the DID lists the supplier key of the advert as an Ed25519 key with the transaction purpose. And the DID has one such advert: a DID with two Active adverts is no candidate, because the agent never picks one of two. A bidder whose record ended, whose DID has no record, or whose record cannot be read stays a candidate, and its file shows the status. The candidates are in the order of their advert references, compared as plain text, and the first 8 stay.

No free text of a bidder reaches a file. A member is a word of a closed list, a number, a boolean, a hash, a domain, a DID or a time. A time is written as `YYYY-MM-DDTHH:MM:SSZ`.

| File member | What it holds |
|---|---|
| `did` | the DID of the bidder |
| `advert_ref` | the reference of its advert: `<txid>#<index>` |
| `status` | the state of its identity record: `active`, `suspended`, `revoked`, `retired`, `not_found` or `unreadable` |
| `status_reason` | a reason word of the gateway when the state is not `active`: `invalidated`, `parentRevoked`, `parentRetired`, `deactivationPending`, `parentSuspended`, `notAuthentic` or `unaccountable`. Any other text is `null` |
| `lineage` | what the record says about the end of its life and the change of its controller (the next table) |
| `accountable` | the key hash of the Accountable Party that covers the record now, or `null` |
| `organisation` | the domain of the organisation of that party, in lower case, or `null`. It is shown only when the gateway verified it, because the bidder chooses its text |
| `organisation_verified` | `true` exactly when `organisation` is shown. It is never inferred |
| `in_catalog` | `true` when the catalog of the gateway lists the bidder, `false` when it does not, and `null` when the catalog could not be read |
| `stake_lovelace` | the reputation stake of the bidder as decimal text, or `null` when it could not be read |
| `cases_against` | the number of challenges that are open against an open claim of the bidder, or `null` when they could not be read |
| `price_list` | the state of the price list that the manifest of its advert names: `valid`, `invalid` or `unreadable` |
| `compliance` | the compliance attestation about the bidder (the table after the next) |
| `credential` | the state of its identity credential: `valid`, `invalid`, `absent` or `unreadable` |

| Member of `lineage` | What it holds |
|---|---|
| `hold_until` | the latest end of a hold on the record, or `null` |
| `ended_at` | the time at which the record ended, for a record that is revoked or retired, or `null` |
| `invalid_from` | the time from which the signatures of a revoked record are invalid, or `null` |
| `successor` | the DID that a revoked or retired record names as its successor, or `null` |
| `recovery_pending` | `true` while a change of the controller by recovery waits |

| Member of `compliance` | What it holds |
|---|---|
| `state` | `valid` when the newest attestation of the issuer is active, `invalid` when it is not, `absent` when none exists, and `unreadable` when the list or the datum could not be read |
| `attestation` | the identifier of the attestation that decides the state, or `null` |
| `attestation_state` | `active`, `revoked`, `expired` or `not_yet_valid` for that attestation, or `null` |
| `issued_at`, `valid_until`, `revoked_at` | times of that attestation, or `null` |
| `revoke_reason` | the code of the revoke as decimal text, or `null` |
| `contested` | `{ "sha256": <hash> }` when the bidder published a reply to the attestation, else `null`. The agent never reads the text of the reply: the file shows its hash only |

The states of a fact are `valid`, `invalid`, `absent` and `unreadable`. `unreadable` means that the source gave no answer in time or gave an answer that the agent cannot read. It is never `absent`, never `valid` and never a number: a stake that cannot be read is `null` and never `"0"`, and a catalog that cannot be read is `null` and never "not in the catalog". Only an attestation of the issuer `keys.compliance_issuer_pkh` of the manifest counts. An attestation of another issuer is not counted and not shown.

The example is the file of a bidder whose record was revoked. A file that the model reads holds less: it has no advert reference, no organisation, no identifier of an attestation, no reason of a revoke, no time of issue, and no hash of a reply. It shows three of these as booleans: whether an Accountable Party covers the record, whether the record names a successor, and whether the bidder replied.

```json
{
  "did": "did:vector:c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  "advert_ref": "3333333333333333333333333333333333333333333333333333333333333333#0",
  "status": "revoked",
  "status_reason": null,
  "lineage": {
    "hold_until": null,
    "ended_at": "2027-01-12T10:30:00Z",
    "invalid_from": "2027-01-11T18:00:00Z",
    "successor": null,
    "recovery_pending": false
  },
  "accountable": null,
  "organisation": null,
  "organisation_verified": false,
  "in_catalog": false,
  "stake_lovelace": "1000000",
  "cases_against": 3,
  "price_list": "valid",
  "compliance": {
    "state": "invalid",
    "attestation": "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
    "attestation_state": "revoked",
    "issued_at": "2026-11-20T10:00:00Z",
    "valid_until": "2027-05-20T10:00:00Z",
    "revoked_at": "2027-01-12T10:00:00Z",
    "revoke_reason": "1",
    "contested": {
      "sha256": "d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0"
    }
  },
  "credential": "invalid"
}
```

### The ranking

The ranking is the `document` of the proposal. The hirer reads it, approves its digest, and sends it back as `proposal.document` of `execute`. The sourcing record takes it as it stands.

| Member | Content |
|---|---|
| `schema` | `vector.usecase.ranking.v1` |
| `rfq_id` | the identifier of the request for quotation |
| `rfq_sha256` | the sha256 of the canonical JSON of the request for quotation (`rfq_id`, `items` and `needed_by`). Every quote of the ranking names the same hash, so the approver and every Bid Desk talk about one request |
| `tenant` | the tenant of the request |
| `weights` | the four weights of the request |
| `ranked` | the ranked bidders, 1 to 20 entries, in the order that the model gave |
| `excluded` | every candidate that is not ranked, with the reason: 0 to 20 entries |

| Member of an entry of `ranked` | Content |
|---|---|
| `rank` | the position of the entry in the list, from 1. The rank is the position and nothing else |
| `desk_did` | the DID of the Bid Desk |
| `organisation` | the domain of the Bid Desk, as a lower-case domain of at least two labels and at most 64 characters. It is a member only when the gateway verified the organisation: the sourcing record refuses the value `null`, so the member is left out when there is none |
| `score` | the score of the quote, a number from 0 to 100 |
| `components` | the four component scores `price`, `lead_time`, `reliability` and `compliance`, each a number from 0 to 100 |
| `quote` | the quote that the score was computed from (the next table) |

| Member of `quote` | Content |
|---|---|
| `escrow_ref` | the escrow of the quote job |
| `receipt_sha256` | the sha256 of the canonical JSON of `{ receipt, signature }`: the signed receipt of the quote job. The record of the quote under `quotes` has the receipt and its signature |
| `total` | the total of the quote: a whole number |
| `lead_time_days` | the longest lead time of the lines of the quote, in days |

| Member of an entry of `excluded` | Content |
|---|---|
| `desk_did` | the DID of the candidate |
| `reason` | `not_invited`, `not_active`, `refused`, `failed` or `disputed` |
| `code` | `null` for `not_invited`. For `not_active` the status of the record. For `refused` the refusal code of the Bid Desk. For `failed` the code of the step that failed. For `disputed` `null` when the agent filed a challenge, and else the code of the step that did not file one |

The model gives the order and nothing else. No code sorts by score: an order that does not follow the scores is an order that the model chose. The decision refuses an order that holds a DID two times (`model_output_invalid`). The job accepts the order only when it holds each scored bidder and no other DID (`ranking_invalid` otherwise). The score is not worked out again from the components and the weights: the model decides the numbers, and the job holds only that each number is from 0 to 100.

The model never writes the `quote` member. The job builds it from the quote that the agent holds and accepted: the escrow of its record, the hash of its signed receipt, and the total and the lead time of the parsed quote. The ranking holds only bidders whose quote the agent accepted.

To check the link to the receipt, find the record under `quotes` by `escrow_ref`. Hash the canonical JSON of `{ receipt, signature }`, with `signature` set to `receipt_signature`. Compare that hash with `receipt_sha256`. A change to `quotes[].result` does not change this hash.

To verify the quote independently, obtain the exact original quote response bytes. Check their SHA-256 against `receipt.response_hash`. Verify the Ed25519 signature over the canonical receipt with the Bid Desk supplier key. Check that the key and signed receipt hash match the escrow. The hosted `vector_marketplace_verify_receipt` takes the exact original result text, receipt, signature and escrow reference. Compare the verified quote with the parsed quote in the proposal. The proposal does not carry the original bytes. If you cannot obtain them, you can review the parsed quote, but you cannot verify the Bid Desk's quote from the proposal alone.

### Outcomes

The outcome and the exit state of an `execute` result follow one rule. The exit state is `Completed`, `Rejected`, `Expired`, `Cancelled`, `Escalated` or `Failed`.

| Outcome | Exit state | When |
|---|---|---|
| `completed` | `Completed` | the sourcing record wrote the ranking |
| `refused_by_system` | `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | the sourcing record refused the ranking. The `reason` is its code |
| `failed` | `Failed` | any other end. The `reason` is a code |

`execute` writes these three outcomes and no other. It hires nobody, so it has no `vault_refused` and no `refused_by_counterparty`. It files no challenge, so it has no `disputed`. A delegation that the hirer ended gives no token, and the job ends `failed` with `token_failed`: the exit state `Cancelled` comes only when the sourcing record itself refuses with `delegation_ended`. A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.

### Errors

A call that the service refuses has the body `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over a limit of Terms), `bad_shape` (a request that breaks a rule of Request, a tenant outside the form of the schema among them), `bad_context` (a context header that is missing or bad), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token of the service) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 500 | `internal` |
| 503 | `shutting_down` (the service is stopping) |

The table lists codes of the two jobs and codes of the quote step. The Job column says where the code applies: `propose`, `execute` or both. A bidder code describes that bidder, not the result of the whole job. If the job returns a ranking, its `excluded` entries can hold bidder codes. If a quote decision stops `propose`, the job's `reason` comes from that decision. See Outcomes for `refused_by_system` and its codes. The table uses two groups of codes: `sub_delegation_<code>` and the protocol codes that a Bid Desk can return.

| Reason | Job | What it says |
|---|---|---|
| `delegation_key_unknown` | both | the delegation names a delegate key that the agent does not hold |
| `delegation_not_found` | both | the ledger shows no delegation with that identifier |
| `ledger_unavailable` | both | a read of the ledger gave no answer in time, or an answer that the job cannot read. In `propose` it can also come from a quote hire |
| `bad_document` | both | in `propose`, a choice of the model that the job cannot read as data, or a ranking that the kit refuses as the document of a proposal. In `execute`, the document is no ranking |
| `aborted`, `deadline` | both | the caller hung up, or the job ran out of its time. In `propose`, `aborted` and `deadline` also stand for a bidder that is not paid (step 4) and for a scoring or a ranking decision that has less time than its reserve |
| `bidders_unavailable`, `no_bidders` | `propose` | `propose` cannot read the bidders (step 2 of `propose`): the listing cannot be read or the chain gave no usable answer, or every read worked and no Bid Desk is a candidate |
| `shortlist_unknown_bidder`, `nobody_invited` | `propose` | the model invites a DID that is not a candidate, or invites nobody (step 3) |
| `no_quotes` | `propose` | no bidder has an accepted quote |
| `ranking_invalid` | `propose` | the ranking cannot be built: a score or a component is not a number that the kit takes, or the order of the model leaves out a scored bidder or names a DID that is not scored |
| `decision_mismatch` | `propose` | the choice that the job built is not the choice that the decision records: in the shortlist, in a score or in the ranking decision |
| `internal` | `propose` | the job threw, a port gave an answer of a wrong form, or a code that the job read is not in the form of a code |
| `ranking_not_for_tenant` | `execute` | the ranking is for another tenant than the request |
| `token_failed` | `execute` | the identity gateway gave no token for the write to the sourcing record. A delegation that the hirer ended gives none |
| `mock_system_failed` | `execute` | the call did not report a confirmed write or a known refusal. It can have written the ranking. Check `sourcing.rankings` in the tenant state before you retry |
| `vendors_refused`, `vendors_failed`, `vendors_invalid` | `propose` | the read of the vendor master by a scorer was refused, failed, or gave an answer that is no vendor list |
| `scorer_token_failed` | `propose` | the identity gateway gave a scorer no token |
| `scorer_threw`, `scorer_timed_out` | `propose` | a scorer threw, or it did not end within its time |
| `score_invalid` | `propose` | the answer of a scorer is no score: a number is not from 0 to 100 |
| `sub_delegation_<code>` | `propose` | the sub-delegation of a scorer failed. The `<code>` is one of `bad_request`, `parent_unreadable`, `parent_not_live`, `parent_exhausted`, `parent_expiring`, `build_refused`, `build_mismatch`, `missing_signer`, `sign_failed`, `submit_failed`, `confirmation_timeout`, `ledger_unreadable`, `sub_delegation_unusable`, `journal_failed`, `step_timeout` and `internal` |
| `llm_supplier_unavailable` | `propose` | no model on the allowlist is within the three limits, so no hire starts |
| `llm_out_of_time`, `hire_threw` | `propose` | the deadline came during the hire of the model, or less than 60 s were left when the decision began, so no hire started (`llm_out_of_time`); or a port threw, or the result of the hire cannot be read (`hire_threw`) |
| `llm_post_failed`, `llm_busy`, `llm_refused`, `llm_send_lost`, `llm_failed`, `llm_timeout`, `llm_bad_result`, `llm_receipt_failed`, `llm_receipt_unavailable`, `llm_accept_failed` | `propose` | the hire of the model failed with a code of the hire kit, and the code follows the prefix. The ten codes of the hire kit are in the row of the hire of a Bid Desk |
| `model_output_invalid` | `propose` | the hire of the model ended, and its answer is not usable as a choice |
| `choice_changed`, `bad_decision` | `propose` | the parser of the decision is wrong: it returned a value that is not the choice that the model gave (`choice_changed`), or the definition of the decision or its parser is wrong (`bad_decision`) |
| `bad_limit`, `bad_input`, `bad_deps` | `propose` | a limit, the input or the clock of the decision is wrong, and nothing was hired |
| `store_write_failed` | `propose` | a record of a hire could not be written on the volume |
| `not_active`, `disputed` | `propose` | two of the four words of `reason` in an entry of `excluded` (see The ranking). The other two, `refused` and `failed`, stand in the row of the hire kit. The four are the reasons of a bidder and not the reason of a failed job |
| `suspended`, `revoked`, `retired`, `not_found` | `propose` | the code of a `not_active` bidder: the status of its record when the agent read it again |
| `no_price_list`, `status_unreadable` | `propose` | the bidder has no price list that the agent can check, or the status of its record could not be read again. Nothing is paid |
| `not_attempted` | `propose` | a bidder after one whose decision failed: no bidder after a failed decision is paid |
| `delegation_not_mine`, `request_too_large`, `bad_shape` | `propose` | the hire flow refused the request for quotation before the Pay, and nothing was paid |
| `advert_not_counterparty`, `advert_unavailable` | `propose` | the advert of the bidder is not an advert of that Bid Desk, or no agent can be hired for it, and nothing was paid |
| `no_live_vault`, `several_live_vaults` | `propose` | the delegation has no Live vault, or has more than one, so the quote cannot be paid |
| `vault_refused` | `propose` | the ledger refused the Pay from the vault, or the builder could not make it, and nothing was paid |
| `earlier_pay_may_land`, `pay_unconfirmed` | `propose` | an earlier Pay of the same key, or this Pay, was sent and not seen confirmed, and it may still land |
| `hire_error` | `propose` | an error that no other code names ended the hire before any Pay |
| `post_failed`, `busy`, `refused`, `send_lost`, `failed`, `timeout`, `bad_result`, `receipt_failed`, `receipt_unavailable`, `accept_failed` | `propose` | the hire of a Bid Desk failed, and the hire kit gave the code. The flow turns any other code into `inconsistent_outcome`. `refused` and `failed` are also two of the four words of `reason` in an entry of `excluded` |
| `decision_error`, `hire_interrupted` | `propose` | an error ended the hire after the Pay was confirmed. `decision_error` stands when the error came from the decision `accept_quote` |
| `counterparty_refused` | `propose` | a Bid Desk refused before its Claim with no rule of the protocol, and the protocol does not list the code of its answer |
| `sender_not_active`, `sender_unaccountable`, `sender_key_mismatch`, `delegation_invalid`, `delegation_ended`, `not_vault_paid`, `duplicate_rfq` | `propose` | the Bid Desk refused the request before its Claim with one of its seven refusal codes. The quote step leaves that bidder out as `refused`. The funded escrow stays Open until settlement. The janitor can reclaim it after `deliver_by` (see Terms) |
| `quote_invalid`, `quote_not_from_bidder`, `quote_not_for_rfq`, `quote_not_from_list` | `propose` | a check in code failed before the model was asked (step 4 of `propose`). The agent files no challenge |
| `delivery_not_recordable`, `decision_timeout` | `propose` | the receipt of the Bid Desk names no supplier key hash, so the delivery cannot be recorded (the fifth check in code, step 4 of `propose`), or the decision on the quote did not end in time |
| `decision_failed` | `propose` | bidder code from the quote step when `accept_quote` fails. The quote hires stop. The job's `reason` is the decision's code, for example `model_output_invalid` |
| `answer_missing`, `answer_invalid`, `choice_invalid`, `choice_not_recorded`, `decision_threw`, `invalid_code` | `propose` | the answer of the decision `accept_quote` is not a decision that the agent can act on, so nothing is accepted. These codes stop the quote hires and end the job |
| `inconsistent_outcome` | `propose` | the hire kit gave an outcome that does not hold together, so the job trusts none of it. The quote is not held |
| `no_open_claim`, `no_evidence`, `no_contradiction`, `same_agent`, `job_already_disputed`, `claim_window_closing`, `journal_unavailable`, `chain_unavailable`, `document_too_large`, `evidence_not_built`, `evidence_not_confirmed`, `claim_changed`, `challenge_not_built`, `challenge_not_confirmed`, `challenge_wrong_claim`, `port_error` | `propose` | the code of a `disputed` bidder: the model did not accept the quote, and the agent did not file or finish the challenge. `no_open_claim` says that the Bid Desk has no open claim, and `no_evidence` says that the model named no line whose quoted unit price differs from its listed price. `port_error` says that a transaction may have landed |
| a code of the protocol | `propose` | a Bid Desk answered an error before its Claim with a code that `ERROR_STATUS` of the kit lists, and that no other row names, such as `bad_wire` (400). The reason is that code |

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
| 500 | `internal` |
| 503 | `check_unavailable` |

The code `key_in_use` means that the delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it.

## What the receipt commits to

The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>`: 64 lower-case hex characters, a hash sign, and an output index with no leading zero |
| `supplier_pkh` | the key hash of the supplier key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `sourcing-agent-v1` |

The runtime writes the other fields of the receipt. The result is the committed output. The receipt of a `propose` job commits the ranking, its salt and its digest, the file of every candidate as the agent read it, the parsed quotes with the signed receipts of their Bid Desks, every model decision with its reasoning and the sub-job that bought it, and any challenge that the agent filed. The receipt of an `execute` job commits the outcome and the one write to the sourcing record, with its reference when it has one. The sub-receipt of a model supplier and the receipt of a Bid Desk are signed by those parties under their own keys, and accountability for the result stays on the key of this agent.

It does not commit to the ranking being right, to the prices of the Bid Desks being fair, or to any order being placed. The use case ends at the approved ranking.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The service stakes no claim, and no code of the service calls the staking of one. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with `no_open_claim`. The design is that, before each run, the operator stakes one claim with the service key of the agent: 50 units, which is 50000000 lovelace, with a challenge window of 24 hours. After the window, the operator withdraws the claim when nobody challenged it. A claim has these three statements. The manifest holds them in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.

| Id | Statement |
|---|---|
| S1 | Every score in a ranking cites the signed quote it was computed from. |
| S2 | This agent ranks only bidders whose signed quote it holds and accepted. |
| S3 | A ranking this agent writes to a sourcing record is the document whose digest its hirer approved. |

The job builds the `quote` member of each ranked entry from the quote that it holds and accepted, and the model never writes it: that holds S1 and S2. `execute` writes the document as the hirer holds it: that holds S3 together with the approval check of the sourcing record. The agent challenges the claim of a Bid Desk and never its own claim. It uses the first statement of the claim of the Bid Desk: "The unit price of every line in a quote is the price its published price list gives for that SKU and quantity."

## Fault switch

`FAULT_MODE=invert_scores`: the scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value. The subtraction is made on the decimal text of the number, so 80.2 gives 19.8. The other scorers are not changed. The decision that the model made stays on record as the model gave it: the reversal is made on the answer of the scorer, after the job checked that answer. The ranking holds the reversed numbers, and its `quote` members still cite the right quotes, so an approver who opens the quote behind a score can see that the score does not fit it.

The planned failure run sets the switch on this agent to show that an approver can find a wrong score from the quote that it cites. No command of this repository runs use case 3 yet. The switch changes what the job writes and never a check.

The switch is empty in a clean run. Any other value than `invert_scores` stops the start of the service. The service reads the switch one time, at start. It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value. Each result returns the active value as `fault_mode`, its last member.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

The request for quotation, the weights, the quotes, the files of the bidders and the entries of the vendor master are synthetic data, and they are held in memory while a job runs. On disk the service keeps the bookkeeping of the escrows it posts, the list of sub-delegations that it has to end, the record of the challenges it files and the register of the transactions it co-signed. The log carries job outcomes, counts and codes, never a request, a quote, a price list, a vendor entry or a key. What leaves to third parties:

| Party | What it receives |
|---|---|
| the identity gateway (the token requests of the agent and of its scorers, the DID resolutions, the catalog and the credentials of the bidders) | the token request of the agent for the action `sourcing.award.write`, with the subject token that the service key signs and the proof that the delegation key signs, and the token request of each scorer for the action `vendor.read`, signed with its two keys. Each request names one action, one resource and one delegation. It also receives the DID of each bidder, for the resolution of its record and the read of its credential, and a read of the catalog |
| the marketplace indexer (the list of the adverts of the bidders) | the capability of the Bid Desks, and the listing of their adverts |
| the mock vendor master and the sourcing record (the calls above, with their tokens) | a read of the vendor list of the tenant by each scorer, and a write of one approved ranking. Each call carries a token for one action and one resource. The write holds the ranking |
| each invited Bid Desk (the request for quotation, the DID of this agent and the delegation, and not the weights) | the request for quotation: the identifier, the items and the date. It also receives the DID of this agent and the identifier of the delegation. It receives no weight, no score and nothing of another bidder |
| a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of each decision: the files of the bidders, a quote with its price list, a quote with its vendor entry and the weights, and the scores) | one job for each decision: the fixed prompt of the decision, its data and the reference of the escrow. The data of each decision is in the table below |
| the Vector ledger (reads of stakes, cases and attestations, the sub-delegations and, on a refused quote, the evidence document and the challenge) | the reads of the stake, the open cases and the compliance attestations of the bidders, the Delegate and the Undelegate transactions of each sub-delegation, the Pay and the Accept of each quote hire, and, on a refused quote, the evidence document and the challenge. Each transaction stays in the history of the ledger |

The mock system requires a token to write a ranking. Anyone who knows the tenant name can read `GET <mock base>/t/<tenant>/state` without a token. The `sourcing.rankings` list shows the full ranking, including scores and quote totals, and the approval reference. Use synthetic data only.

What each decision receives:

| Decision | Data block | Left out |
|---|---|---|
| `shortlist` | `request` (`items` and `needed_by`) and `bidders` (the facts of each file) | the identifier of the request, the weights, and the members of a file that the model does not read (see The bidder file) |
| `accept_quote` | `request` (`items`), `quote` (`lines`, each with `sku`, `quantity`, `unit_price` and `lead_time_days`) and `price_list` (the entries for the SKUs of the lines) | the notes, the credential, the organisation, the sender, the checks and the decisions of the quote, and the line totals |
| `score` | `today`, `weights`, `request`, `quote` (`lines`, `total`, `lead_time_days` and `valid_until`), `lines_quoted`, `items_requested`, `bidder` (the facts of the file) and `vendor` (the entry of the vendor master, or `null`) | the notes, the credential, the organisation, the sender, the checks and the decisions of the quote |
| `ranking` | `weights` and, for each scored bidder, `desk_did`, `score`, `components`, `total` and `lead_time_days` | every text of a bidder or of a vendor |

No free text of a bidder reaches a decision: a file holds closed lists, numbers, booleans, hashes, a domain, DIDs and times, and a quote reaches the decisions as lines, prices and dates. The one free text that a decision reads is in the entry of the vendor master, which holds a name and a list of certifications. Those two reach the model inside the data block of `score`, and never inside an instruction. The data of every decision reaches the model only inside one marked data block.

To post and settle its escrows, the service reads the ledger through the node (Ogmios) and the Koios indexer, submits its transactions through the submit API, and finds the Bid Desks and the model suppliers on the marketplace indexer. They see the references and the transactions of those escrows, and nothing of a request. On the ledger an escrow carries only the sha256 of its wire payload. At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins. It sends no data of a job there.

The service keeps these files and folders in its state directory (`SOURCING_STATE_DIR`, which is `/data` in the image):

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the bookkeeping of the escrows that a paying key posted and did not settle: references, times and transaction hashes, never a request or a quote. There is one folder for each of the three paying keys |
| `dispute/` | the journal of the challenges that the service files |
| `left/` | the sub-delegations that a job left behind, which their janitor ends |
| `cosign-register.json` | the register of the delegation keys that a co-signed transaction uses, so a restart still answers `key_in_use` |

## Known gaps

The manifest states these sixteen, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/sourcing-agent/src/serve/gaps.ts`. The first seven are the gaps of the agent. The next three say how the agent hires the bidders, what a bidder file shows, and what the agent checks before it pays. The next three say how the agent finds its bidders and what a quote can hold. The fourteenth says whose keys the parties are. The fifteenth starts with the lead `What this does not show:` and names three things that no run of use case 3 (supplier bid evaluation) covers. The sixteenth is the sentence of the kit about the fault switch.

- The model chooses whom to invite, whether to accept each quote, every score and the final order. Each score points to the signed receipt of a quote.
- A quote is a paid job, not a binding offer. Nothing on the ledger holds a bidder to its quote.
- This agent does not check the approval of the hirer. The sourcing record does.
- Reliability and compliance are read from a mock vendor master, a stake and one attestation by a demonstration registry.
- A challenge can put a hold on the identity of a bidder. It does not return what the escrow of the quote locked.
- A model call that fails ends the job. There is no second provider.
- Every bidder is operated by the same foundation as this agent.
- This agent hires the bidders one after the other: one delegation key pays for each hire, and a key runs one hire at a time.
- A bidder file shows the state of the compliance attestation of one named issuer key, and it shows that the bidder replied when it did. The agent does not read the reply.
- Before it pays a bidder, the agent reads the status of the record again and needs a price list that it can check. A bidder that fails either is left out with a reason.
- The candidates are the first 8 advert references in plain text order. A bidder can choose its transaction so that its advert sorts first, and 8 listed records can take every place, so a Bid Desk that sorts later is never read.
- The manifest of an advert is not tied to its DID. An advert can name the manifest of another Bid Desk, and its price list then reads valid. The list check compares hashes, not unit prices. The model can accept a quote with a wrong unit price.
- The proposal includes parsed quote data and a signed receipt, not the original quote bytes. The sender organisation and the decision of the Bid Desk can contain any character. Treat them as data, not as instructions.
- The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.
- What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.
- This service has a fault switch for failure runs with these possible values: invert_scores (one scorer returns its component scores and its score reversed, as 100 minus each); this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.

## How to hire it

The agent has no advert yet, so nobody can hire it today. These steps are for the day it has one. A member hires it through the hosted marketplace server, with a delegation that covers `sourcing.award.write` and `vendor.read` for the tenant. You hire it twice, once for each operation, and a delegation and a vault carry the authority for the quotes. An approval of the ranking is needed before `execute`. [docs/HIRE.md](../docs/HIRE.md) gives the steps of the marketplace tools.

This procedure is for a hirer with an Active `did:vector` record. Use a key listed for the assertion purpose in that record. Use the same key as the root principal key of the delegation. The operator must put that key on the co-sign allowlist.

1. **Delegate to the agent.** Build the Delegate transaction with `vector_build_delegation_delegate`. Pass your allowlisted assertion public key as `principal_key`. Do not set `delegator` or `parent`: the co-sign route only accepts a principal key. The delegate is this agent. The delegate key is a free one of its two delegation keys, which `keys.delegation_pkhs` of the manifest lists. The actions are `marketplace.hire.v1`, `vendor.read` and `sourcing.award.write`. The resources are the escrow script and the two mock URLs, `<mock base>/t/<tenant>/vendors` and `<mock base>/t/<tenant>/sourcing`, where `<mock base>` is the origin of the mock systems that the operator gives you.

   Set `remaining` to 1 or more. Keep the delegation valid for the full 90-minute `propose` window, the review of the ranking and the `execute` call. Do not use the 300000 ms minimum of a sub-delegation as the job budget. See **The delegation** under Request for the builder checks and failure codes. Set `per_tx` to cover one full quote lock. Set `total` to cover the planned locks and any spending already recorded for the same period (see Terms).

   Sign the transaction with your key first: the co-sign route refuses a transaction that the delegator did not sign (`principal_not_allowed`). Send it to the agent with `vector_delegation_request_cosign`. The route signs only for a principal key on the allowlist of the operator. The route returns `key_in_use` (409) for a delegation key that is in use. Submit the transaction that comes back. Wait until the ledger shows the delegation: a `propose` job on a delegation that the ledger does not show ends with `delegation_not_found`. Then wait for 30 confirmations of the delegation. The sub-delegation of each scorer needs 30 confirmations on every link of its chain.
2. **Open one vault under the delegation** with `vector_build_vault_open`. The agent finds the Live vault before each Pay. With none or with several, that Pay cannot start (`no_live_vault` or `several_live_vaults`). These failures do not undo earlier payments. If no quote is accepted, the job ends `failed` with `no_quotes`. Fund the full lock of each planned quote hire: 9 units for three Bid Desks at the listed terms. Add the ledger minimum that must stay in the Live vault.
3. **Hire `propose`.** Check the hosted send size before you sign and submit the Post (see Terms). Post the escrow for the advert of the agent. Send the request JSON, read the result, verify the receipt and accept, as `docs/HIRE.md` says. The request JSON is the first example under Request, with your own values. Set `authority.principal_did` to your registered DID. Use a new `rfq_id` each time. The ranking is the `document` of the result. The job can take most of the window of 90 minutes. Each lock remains in place until settlement (see Terms).
4. **Approve the ranking, or do not.** Read the ranking and check the quote behind each score that you rely on (see [The ranking](#the-ranking)). Before you sign, recompute the digest from the exact `document` you reviewed and the `salt` in that proposal. Decode the hex salt into 32 bytes. Compute SHA-256 over those bytes followed by the UTF-8 bytes of the canonical JSON of that document. Use the canonical form of [`proposalDigest`](../packages/usecase-kit/src/protocol/digest.ts). Compare the result with `proposal_digest`. If they differ, stop. Do not sign an approval or hire `execute`.

   If you approve the ranking, call `vector_build_attestation_attest`. Set `att_type: "approval"` and set `subject` to this agent's DID. Set `digest` to the digest you recomputed. Set `issuer_did` to your registered DID and `issuer` to the same public key you used as `principal_key`. The sourcing record refuses another issuer with `approval_wrong_issuer`. Set `changeAddress` to the wallet address that pays for the approval. Set `valid_until` in POSIX milliseconds. The tool sets no end by default. The planned runs use 4 hours.

   The builder returns unsigned transaction bytes and the `attestation` identifier. Sign the transaction with the issuer key and any other keys that the builder names. Submit it and wait for confirmation with `vector_await_transaction`. Then call `vector_get_attestation` with the `attestation` identifier. Require `found: true`, `state: "active"` and `att_type: "approval"`. Check that `subject_did` names this agent and that `issuer_did` and `issuer_key` match the registered DID and public key you used. Check that `digest` matches the digest you recomputed. If you cannot verify any of these values, stop. Do not pay for `execute`. If the ledger does not show the approval, the sourcing record returns `approval_not_found`.
5. **Hire `execute`.** For `proposal`, send only the reviewed `document`, its `salt` and the checked `proposal_digest`. Use the same `authority` as for `propose`. In `approval`, use the `attestation` identifier and the registered `issuer_did` you verified in step 4. The second example under Request shows the request. Check the hosted send size before you sign and submit this Post too. Verify the receipt and accept. The result is `completed` when the sourcing record wrote the ranking. If the result is uncertain, check the tenant state before you retry (see Request).
6. **Close the vault and end the delegation.** Use `vector_build_vault_close` to close the Live vault and collect any `Returned` outputs. End the delegation with `vector_build_delegation_undelegate`.

**Recover the approval deposit.** The default and minimum deposit is 5 units (5000000 lovelace). The ledger can require a larger deposit. Check `deposit_lovelace` in the approval build. The deposit does not return automatically. Withdrawal becomes eligible 90 days after `valid_until` or, if revoked, 90 days after revocation, whichever date comes first. An active approval with no expiry must be revoked first. The hosted builder starts its transaction window one minute before the build, rounded down to a whole second. If it refuses as too early, use the build time it reports.

Call `vector_build_attestation_withdraw` with the `attestation` identifier and the receiving wallet's `changeAddress`. Sign with the issuer key. For a registered issuer, that key must still have the assertion purpose, or use `by: "controller"` and sign with the issuer's controller. Include any other signatures that the builder names. Submit the withdrawal and wait for confirmation. The transaction burns the attestation token and returns the deposit to the wallet less the fee.

## Changelog

- 0.1.0, 2026-11-24: built

## Links

- Manifest: `GET /agent.json` on the public URL of the agent, once the agent has an advert. The service renders it from its environment when it starts. The template is [agents/sourcing-agent/agent.json.template](../agents/sourcing-agent/agent.json.template).
- Source: [agents/sourcing-agent](../agents/sourcing-agent)
- Quote supplier: [Bid Desk](bid-desk.md).
- Deploy pack: [deploy/server/RUNBOOK-sourcing-agent.md](../deploy/server/RUNBOOK-sourcing-agent.md)
- Use case kit: [packages/usecase-kit](../packages/usecase-kit)
- Guide: [docs/HIRE.md](../docs/HIRE.md)
