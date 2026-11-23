# @vsa/hire-kit

The code that a service uses to hire a supplier on the Vector marketplace.
The kit posts the escrow, sends the job, polls for the result, checks the receipt and accepts the escrow.
It hires a chat model, an OCR supplier or an agent of the template contract.

This page describes the paying keys, the limits of a hire, the five outcomes of `hireAgent`, the ledger, the limit of the decision, the vault that continues after a Pay, and the shared stubs.
The head of each file in `src/` describes that file.

## Paying keys

A key that pays has one chain, one stranded store and one lane.
`PayingKeys` gives one `PayingKey` to one key hash and one folder.
It refuses a key hash that it holds already.
It refuses a folder that another key of the same registry uses.
Two registries do not check each other, so a service makes one registry and gives every key to it.

`hireModel` and `hireAgent` take the paying key as their first argument.
They run in the lane of the key: one hire at a time for the key.
A hire whose turn comes at or after its deadline reads and pays nothing, and the facts of its deadline error name the stage `lane` and no escrow.
A request can set `minLeftAtTurnMs`: a turn with less time left before the deadline ends in the same way.
Use it when a hire that posts with little time left can only end at its first poll, with its escrow locked until the janitor reclaims it.
The janitor of the key starts no transaction while a hire runs or waits.
The chain and the store of a hire are the ones of its key, so a hire cannot use the chain of one key with the store of another.

## What a hire pays

The price ceiling does not bound what a hire pays.
The buyer funds the price and both bonds at the Post.
An Accept pays the supplier the price and the supplier bond.
The buyer bond returns to the buyer.
A Release pays the supplier the price and both bonds.
The supplier makes a Release when the buyer does not accept in time.

So `hireAgent` takes three limits, and `hireModel` takes the same three.
All are required, and none has a default.
Each is a bigint, or `null` for no limit.

| Field | Meaning |
|---|---|
| `maxPriceLovelace` | The most that the price of the advert may be. |
| `maxSupplierBondLovelace` | The most that the supplier bond of the advert may be. |
| `maxBuyerBondLovelace` | The most that the buyer bond of the advert may be. |

A number refuses an advert that is above it.
The message names the advert, the value and the limit.
The refusal comes before the Post or the Pay, so nothing is posted.
For `hireModel` the price ceiling is a bigint, and it has no `null`.

A limit that is a number, a text, `undefined` or a missing field is refused with a `TypeError` that names the field.
The error comes before anything is read, posted or paid, and before the lane of the key is used.
A caller of plain JavaScript that writes `1000000` and not `1000000n` gets the error, and it does not hire.

`chooseChatSupplier` takes the two limits of the bonds as optional fields.
It accepts a bigint, `null` or `undefined`, and it refuses every other type in the same way.
A call that gives none has no limit, as before.

Every hire of `hireModel` and `hireAgent` writes its terms into one line of the log, once the Post is confirmed.
A hire that completes also has them in `record.terms`, and every outcome of `hireAgent` that has an escrow carries them as `terms`.
The terms are the price, the supplier bond, the buyer bond, what the Post locks, and what an Accept pays the supplier.
The Document Pipeline does not ask for terms, so its record and its log do not change.

## Hire an agent

```ts
const outcome = await hireAgent(key, deps, {
  selection: { capabilityId: 'supplychain.order.accept.v1', model: 'order-desk-small' },
  payload: '{"purchase_order":"PO-7"}',
  maxPriceLovelace: 500_000n,
  maxSupplierBondLovelace: 2_000_000n,
  maxBuyerBondLovelace: null,
}, errors);
```

The selection names an advert (`advertRef`), or a capability that one Active advert in the indexer matches.
A model and the price ceiling narrow the match.
Two adverts that match are an error: the caller names one by its `advertRef`.
The kit reads the advert on chain in both cases.
It checks every field of the selection against the advert: the advert must be Active, and its capability and its model must be the ones that the caller gave.
Then it checks the three limits.
A mismatch is the `unavailable` error of the caller, and nothing is paid.

The kit also checks the size of the request before it pays.
The runtime of an agent takes a body of at most `RUNTIME_BODY_LIMIT_BYTES` (1 MiB), and it refuses a larger body after the payment.
The body is the escrow and the wire form of the payload in one JSON object, so a quote mark of the payload takes four bytes of it.
The escrow exists only after the payment, so the kit sizes the body with the reference that the payment will make.
A vault Pay opens its escrow at output 0.
A Post of the wallet promises no output, so its body is sized with the longest reference: 64 hex characters, a hash sign and 10 digits.
A body above the limit is the `unavailable` error of the caller.
The error comes before the lane, before any read and before any payment, so nothing is posted.

`hireAgent` says how the hire ended in one of five outcomes.

| Outcome | Meaning |
|---|---|
| `completed` | The receipt passed the eight checks, the decision accepted it, and the Accept was made. |
| `refused_before_claim` | The runtime refused the job. The kit gives this word on three facts together (see below). The escrow stays Open, and the janitor reclaims it after its `deliver_by`. |
| `failed_after_claim` | The agent may hold the job, or the kit cannot tell that it does not. The escrow stays in the store for the janitor. |
| `vault_refused` | The vault Pay did not leave the node. Nothing was signed, and no money moved. |
| `not_accepted` | The delivery came and the escrow was not accepted: a check of the receipt failed, the decision of the caller said no (`declined`), or the decision did not answer in time (`decision_timeout`). |

`refused_before_claim` needs all three facts:

1. The answer is the envelope of the runtime with a code. Its status is below 500, or it is 503 with `precheck_unreachable`, `precheck_timeout` or `precheck_failed`.
2. The escrow was read Open after the answer.
3. No earlier send of the job ended without a clear answer.

An agent that stays busy until the send ends in time gives the same outcome, with the code `busy`.

The word rests on the answer of the runtime and on one read of the chain just after it.
It is no proof.
Two cases still give it wrongly.
A runtime can claim the escrow and still answer a clean refusal.
A runtime can claim the escrow after its refusal, because an Open escrow stays open to a Claim until its `deliver_by`.
In both cases the escrow is in the store of the key, and the janitor reclaims an Open or Claimed escrow after its deadline.
An escrow that the agent went on to Submit cannot be reclaimed.

Every other end of a send is `failed_after_claim` with the reason `send_lost`.
That covers no answer, a page, a 5xx with another code, `escrow_not_found`, a refusal after an unclear send, and an escrow that is not read Open.
A caller must not hire again after `send_lost`, because the agent may hold the job.
The other reasons of `failed_after_claim` are `failed`, `timeout`, `bad_result`, `accept_failed` and `receipt_unavailable`.
`receipt_unavailable` means that the buyer did not judge the delivery: the agent does not hand over the receipt, or its hash cannot be read on chain in time.

The reason `failed` has two more members: `service_status` and `service_code`.
The runtime of an agent copies the first 200 characters of an error of its service into the failure of the job.
The kit reads the status and the code of that answer from the frame that the runtime writes: the reason `service_http_<status>`, and the message `service returned HTTP <status>: {"error":"<code>", ...`.
Both members are `null` when the failure has no such frame, and when the agent no longer knows the job.
The kit gives the status and the code as they came.
It never reads a code from free text, and it does not say what a code means: the caller decides.

What no outcome names is thrown as an error of the factory of the caller.
That includes no advert to hire, an advert above a limit, a request body above the limit of the runtime, a Post that failed before its signature, the deadline, a failed write of the store, and a decision that throws.

## The ledger

A hire books what it moved in `deps.ledger`.
`posted` gets the lock and the fee of the Post, or of the vault Pay, once it is confirmed.
`accepted` gets the fee and the hash of the Accept, once it is confirmed: `{ feeLovelace, txHash }`.
The hash is the one that the chain gave for the Accept transaction.
A caller finds a booking again by that hash.
An Accept that was sent and not seen confirmed books nothing, and the hire stands as `pending`.
A ledger that was written for the fee alone (`accepted: (accept: { feeLovelace: bigint }) => ...`) still fits the type.
A ledger that asks for a member that the kit does not give does not fit it: `accepted` is a property of the type, and the type checker refuses such a function.

## The decision of the caller

`request.decide` runs after the eight checks and before the Accept.
It has until `DECISION_WINDOW_MS` after the answer of the agent.
That is the accept window of 600 s, less the 240 s that an Accept needs (`ACCEPT_NEEDS_MS`): its build, up to 60 s, and its confirmation, up to 180 s.
So the limit is 360 s.

A decision that has not answered by then ends the hire as `not_accepted` with the reason `decision_timeout`.
The kit sends no Accept, and the lane of the key is free for the next hire.
The kit does not ask the decision at all when that time has passed already.
A decision that never answers does not hold the lane.
A decision that throws ends the hire with its own error.

On the chain, the escrow stays Submitted.
With no Accept in the accept window, the supplier can release the escrow, and a Release pays the supplier the price and both bonds.
So a decision that is too slow costs the caller what the hire paid.

## Pay from a vault

Set `request.vaultRef` to the reference of a vault output.
The hire then pays the escrow from that vault, as a delegate.
The chain of the key must pay from vaults.
Make it with `createRealChain` and a deployment from `buyerVaultDeployment(env)` of `@vsa/buyer-core`.
That loader needs four settings: `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO` and `VECTOR_IDENTITY_VAULT_REF_UTXO`.
`buyerIdentityDeployment(env)` reads the first three and does not load the reference script of the vault.
A chain made with it refuses a vault Pay, and the message names `VECTOR_IDENTITY_VAULT_REF_UTXO`.

A Pay spends the vault output and leaves a new one.
The reference of the new output continues the vault.
The next hire from this vault must start from it.
A caller takes the continuing reference from an outcome or from an error:

- An outcome that has an escrow has the field `vaultRef`. It is `null` when the wallet paid.
- A hire that throws after a confirmed Pay throws a `HireInterrupted`. It has the fields `vaultRef`, `escrowRef` and `cause`. Its message is the message of the cause.
- A hire whose Pay was submitted and not seen confirmed throws a `HirePayUnconfirmed`. The Pay may still land. It has the fields `vaultRefIfLanded` (the vault if the Pay lands: `<tx hash>#1`), `escrowRef`, `txHash`, `mayLand`, `validTo` and `cause`. `validTo` is the time after which the Pay cannot land, in POSIX milliseconds.

The kit wraps every error that follows a confirmed Pay: the deadline, a failed write of the store, and a ledger or a decision that throws.
It wraps the error of a Pay that was not seen confirmed in the same way.
An error before any Pay reaches the caller as it is, because no vault was spent.

After a `HirePayUnconfirmed`, a caller does not start a Pay from the old reference before `validTo`, because the Pay may land and spend it.
After `validTo` the caller reads the vault again from the chain.
If the Pay landed, the vault is at `vaultRefIfLanded`, and a hire with the old reference ends as `vault_refused` with the reason `no_vault`.
If it did not land, the old reference is still the vault.
A caller that sees the Pay on the chain before `validTo` can use `vaultRefIfLanded` at once.
A caller that keeps the old reference after the Pay landed pays its next hire from a vault that does not exist.

## Stubs

`@vsa/hire-kit/testing` is an in-memory marketplace for tests: a `FakeChain`, an indexer, a model supplier and a template supplier behind one `fetch`.
Test code imports it.
No service imports it.
