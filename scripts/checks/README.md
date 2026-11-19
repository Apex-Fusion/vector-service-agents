# Mainnet checks

Six scripts prove six mechanisms on Vector mainnet with one test record. Each script runs one step. It shows what it will do, and it changes the chain only when you pass `--submit`.

| Script | Check | What it proves |
| --- | --- | --- |
| `01-delegation.ts` | 1 | A member key delegates to the test record. The agent key of the record co-signs. The member key ends the delegation. |
| `02-vault-escrow.ts` | 2 | The record pays an agent from a vault of the member. The job is done, verified and accepted. |
| `03-vault-refund.ts` | 3 | The record pays an agent from a vault and no job is sent. After `deliver_by` the lock returns to the vault as a Returned output. |
| `04-attestations.ts` | 4 | The member key issues a type 5 (approval) and a type 4 (principal binding) attestation about the record, with salted digests. The hosted tools read them. |
| `05-delegation-token.ts` | 5 | After 30 confirmations of the delegation of check 1, the record gets a delegation token. The verifier of id-kit accepts it, and refuses an action that the delegation does not grant. |
| `06-svid.ts`, `06-svid-verifier.ts` | 6 | The record gets an X.509-SVID and a JWT-SVID. A verifier behind a host that asks for a client certificate checks both. |

## How to run a script

```
pnpm exec tsx scripts/checks/01-delegation.ts            # shows the next step, changes nothing
pnpm exec tsx scripts/checks/01-delegation.ts --submit   # runs the next step
pnpm exec tsx scripts/checks/01-delegation.ts status     # shows each step, its state, and the wallets
pnpm exec tsx scripts/checks/01-delegation.ts cleanup    # shows what it would take back (add --submit to do it)
```

Always run a step with no flag first. Read the summary. Then run it again with `--submit`.

A dry run reads the chain and builds the transaction. It signs nothing and sends nothing. The summary shows the signers, the inputs, the outputs, the fee, what is minted or burned, and the result of each guard. For checks 2 and 3 the dry run also asks the agent for its capability and builds the Pay from the vault: the summary of the Pay shows how many units leave the vault, which is the number to check against `CHECKS_VAULT_LIMIT_UNITS`.

Before a key signs, the script checks the transaction. A failed guard stops the run with exit code 2 and nothing is signed. The guards are: `network`, `body`, `fee`, `signers`, `inputs`, `destinations`, `outflow`, `collateral`, `mint`, `nothing_else` and `vault`. After each signature the script checks that the body did not change (`signed_body`). The transactions of the hire kit in checks 2 and 3 go through the same guards.

If a run stops after the script sent a transaction, the state file keeps it as in flight. The next run waits for it, clears it after its validity end, or (with `--submit`) sends it again.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The step is done, or the dry run is complete. |
| 1 | The step failed. The message says why. |
| 2 | A setting, a flag, a key file, the state file, a guard or a precondition stopped the run. Nothing was signed. |
| 3 | The hosted tools do not answer, or a tool that the check needs is missing. |
| 4 | The step must wait. The message says how long. The script never sleeps. |

## Settings

All settings are environment variables.

| Name | Default | Meaning |
| --- | --- | --- |
| `CHECKS_NETWORK` | `vector-mainnet` | The network. Another name selects a test network. |
| `CHECKS_NETWORK_MAGIC`, `CHECKS_NETWORK_SYSTEM_START_MS` | mainnet values | Only for a test network. |
| `CHECKS_RECORD` | none | The DID of the test record, or its 64 hex characters. |
| `CHECKS_STATE_DIR` | `./checks-state` | The folder of the state files and the evidence files (mode 700). The hire kit keeps its stranded store of checks 2 and 3 in `hire/` under it. |
| `CHECKS_CONTROLLER_KEY_FILE` | none | The key file of the controller of the record. It signs nothing. The scripts use it to check that the record is the test record. |
| `CHECKS_AGENT_KEY_FILE` | none | The key file of the agent key. It is the delegate key. It signs the Pay, the Accept and the Reclaim of checks 2 and 3, and the proofs for DPoP and for the gateway. |
| `CHECKS_MEMBER_KEY_FILE` | none | The key file of the member key. It is the delegator, the owner of the vault, the issuer of the attestations, and it pays the fees of the steps of the member. |
| `CHECKS_AUTH_KEY_FILE` | the agent key | A separate authentication key, when the record lists one. |
| `CHECKS_MAX_FEE_LOVELACE` | `2000000` | The guard `fee` refuses a transaction with a higher fee. |
| `CHECKS_MAX_COLLATERAL_LOSS_LOVELACE` | `5000000` | The guard `collateral` refuses a transaction in which a failed script can take more. |
| `CHECKS_HOSTED_URL` | the hosted server of the network | The URL of the hosted tools. |
| `CHECKS_GATEWAY_URL` | `https://id.vector.apexfusion.org` | The origin of the identity gateway. |
| `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL`, `VECTOR_KOIOS_URL` | none | The node endpoints. |
| `VECTOR_IDENTITY_*` | the published mainnet values | Overrides of the identity deployment, for a test network. A network with a published deployment needs none. |
| `CHECKS_DELEGATION_HOURS` | `24` | How long a delegation lasts (checks 1, 2 and 3). |
| `CHECKS_DELEGATION_ACTION` | `mainnet-checks.token.v1` | The action that check 1 grants. |
| `CHECKS_DELEGATION_RESOURCE` | `https://checks.example/token` | The resource that check 1 grants. Check 5 sends its token request to this URL. |
| `CHECKS_TOKEN_RESOURCE` | the resource of the delegation | The resource of the token, when the grant is not a URL. |
| `CHECKS_ATTESTATION_VALID_HOURS` | `48` | How long an attestation of check 4 is valid. |
| `CHECKS_ADVERT_REF` | none | Checks 2 and 3: the advert of the agent to hire (`<tx hash>#<index>`). |
| `CHECKS_VAULT_UNITS` | `8` | Checks 2 and 3: what the vault locks, in units. It returns at `vault_close`. |
| `CHECKS_VAULT_LIMIT_UNITS` | `4` | Checks 2 and 3: the limit of one payment of the vault. One payment locks the price, both bonds and the ledger minimum of the escrow output: 3.33 units for Agent History. The dry run of the Pay shows the real amount. |
| `CHECKS_VAULT_TOTAL_UNITS` | `8` | Checks 2 and 3: the limit of all payments in one period of 24 hours. |
| `CHECKS_MAX_PRICE_UNITS` | `2` | Checks 2 and 3: the most that the price of the advert may be. |
| `CHECKS_MAX_SUPPLIER_BOND_UNITS` | `1` | Checks 2 and 3: the most that the supplier bond of the advert may be. |
| `CHECKS_MAX_BUYER_BOND_UNITS` | `1` | Checks 2 and 3: the most that the buyer bond of the advert may be. |
| `CHECKS_HIRE_PAYLOAD` | a short text | Check 2: the text that the agent reads. |
| `CHECKS_SVID_VERIFIER_URL` | none | Check 6: the URL of the host that asks for a client certificate. `http://127.0.0.1:<port>` runs the verifier and the client on one machine. |
| `CHECKS_SVID_AUDIENCE` | the verifier URL | Check 6: the audience of the JWT-SVID. The verifier service needs the same value. |
| `CHECKS_SVID_PORT` | `9120` | Check 6: the port of the verifier service. It listens on `127.0.0.1` only. |

The three limits of a hire are compared with the values in the advert (price 1, supplier bond 1 and buyer bond 1 for Agent History), and not with the output that the builder makes. The escrow output also holds the ledger minimum, so the lock is above the sum of the three values. A bond limit of 1 unit therefore does not refuse Agent History.

A key file holds one key: 64 hex characters, a bech32 secret key, or a `NAME=value` line. Its mode must be 600 or stricter. The scripts never print a key.

## Wallets

Each script step that runs a script needs a pure output of 5 units or more in the wallet that pays. The builder keeps the smallest such output as collateral, and a step can spend it. A wallet needs one before each script step. The steps that run a script are: Delegate, Undelegate, `vault_open`, `vault_close`, the Pay, the Accept and the Reclaim, and the attestation steps.

The command `status` shows each wallet and says `NONE` when a wallet has no such output. To make one, send 5.5 units to the same address, from that wallet or from another one. Run `status` again before each script step.

| Wallet | Needs |
| --- | --- |
| member | the delegation deposit (about 2 units), the vault (`CHECKS_VAULT_UNITS`), the attestation deposits (5 units each), the fees, and a collateral output |
| agent (the delegate key) | the fees of the Pay, the Accept and the Reclaim (about 0.2 and 0.5 units), and a collateral output |

## Order of the checks

Each check opens its own delegation. A delegate key has one live delegation at a time, so run the checks one after the other.

1. Check 1, step `delegate`. Wait for 30 confirmations of the delegation (about 2 minutes).
2. Check 5. It shows how long is left, and it makes the token request only with `--submit`.
3. Check 1, step `undelegate`. It waits for check 5. Pass `--skip-token-check` to end the delegation without check 5.
4. Check 2: `delegate`, `vault_open`, `hire`, `vault_close`, `undelegate`.
5. Check 3: `delegate`, `vault_open`, `pay`, `reclaim`, `vault_close`, `undelegate`. The step `reclaim` waits until 60 seconds after `deliver_by` of the escrow (the advert window is 300 seconds).
6. Check 4: `issue_approval`, `issue_binding`, `read_check`.
7. Check 6: start `06-svid-verifier.ts` behind the host, then run `06-svid.ts` (steps `x509` and `jwt`).

The `cleanup` command of each script ends what the script started: it reclaims an escrow that is due, closes a vault, and ends a delegation. For check 4 it withdraws the deposits when they are due, and it prints the date when they are not.

## What each step costs

All amounts are in units. A transaction pays a fee, below `CHECKS_MAX_FEE_LOVELACE`. The dry run shows the exact fee. For Agent History a hire locked 3.33 units in the escrow output, the Pay cost 0.17 units in fees and the Accept 0.50 units.

| Step | Pays | Locks | Comes back |
| --- | --- | --- | --- |
| Delegate (checks 1, 2, 3) | the fee | the delegation output (the dry run shows its amount) | at `undelegate` |
| Undelegate | the fee | none | the delegation output |
| `vault_open` (checks 2, 3) | the fee | `CHECKS_VAULT_UNITS` (8) in the vault | at `vault_close` |
| `hire` (check 2) | the fee of the Pay (the agent key) and of the Accept. The Accept pays the supplier the price and the supplier bond: 2 units for Agent History | 3.33 units from the vault, until the Accept | the buyer bond and the ledger minimum (1.33 units), to the vault as a Returned output |
| `pay`, `reclaim` (check 3) | the fee of each | 3.33 units from the vault, until the Reclaim | all of it, to the vault as a Returned output |
| `vault_close` | the fee | none | the Live output and each Returned output, together |
| `issue_approval`, `issue_binding` (check 4) | the fee of each | 5 each | at the withdraw, 90 days after `valid_until` |
| Check 5 and check 6 | nothing | none | not applicable |

The deposits of check 4 stay locked until 90 days after `valid_until`. The default is about 92 days from the issue. Run `04-attestations.ts cleanup --submit` after that date.

## How a hire ends (check 2)

The script `02-vault-escrow.ts` uses `hireAgent` of the hire kit with the paying key of the delegate key. The kit says how the hire ended in one of five ways.

| Outcome | What the check does |
| --- | --- |
| `completed` | Records the step `hire`. `vault_close` closes the Live vault and the Returned output of the Accept. |
| `refused_before_claim` | The agent turned the job down and the escrow is Open. The check records the escrow and the vault that continues, and exits with 1. It never hires again. `cleanup` reclaims after `deliver_by`. |
| `failed_after_claim` | The agent may hold the job. The check does the same, and its message says that the escrow may be claimed. |
| `vault_refused` | The script of the vault refused the Pay, or the node did not evaluate it. Nothing was signed. The evidence keeps the words of the node and the draft transaction. The hire can be made again. |
| `not_accepted` | The delivery came and the escrow was not accepted: a check of the receipt failed, the decision was refused, or it was not made in time (`decision_timeout`). The check records the escrow and never hires again. |

Every transaction of the kit is written to the state file when it lands, as a part of the step (`part.hire:pay`, `part.hire:accept`).

A Pay that was sent and not seen confirmed may still land. The check keeps it as a transaction in flight, with the vault reference that the Pay would leave, and as the note `unconfirmed_pay`: the vault that the check held, the vault if the Pay lands, and the time after which it cannot land. The message says the same. Start no other Pay until that time. The next run settles the transaction first: it waits while the Pay may land, records it as a part when it landed, and lets it go when it cannot land. A hire after that starts from the vault that the node holds.

Before a step spends a vault, it asks the node for the reference of the state file. If the node does not hold it, the step reads the Live vault of the delegation from the chain and goes on with it, or stops when there is more than one.

## Files

- `state`: `<check>.state.json` in the state folder. It holds the steps, the references and the notes. The salt and the document of check 4 are in the notes. Mode 600.
- `evidence`: `<check>.evidence.json`. It holds one entry for each transaction and each hosted read, with the transaction hash, the guard summary and what the tools showed. A refused transaction keeps its evaluation error and its body.
- `hire/`: the stranded store of the paying key (checks 2 and 3), written by the hire kit.
