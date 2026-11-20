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
| `CHECKS_VAULT_LIMIT_UNITS` | `4` | Checks 2 and 3: the limit of one payment of the vault. One payment locks the price and both bonds and nothing more: 3 units for Agent History. The dry run of the Pay shows the real amount. |
| `CHECKS_VAULT_TOTAL_UNITS` | `8` | Checks 2 and 3: the limit of all payments in one period of 24 hours. |
| `CHECKS_MAX_PRICE_UNITS` | `2` | Checks 2 and 3: the most that the price of the advert may be. |
| `CHECKS_MAX_SUPPLIER_BOND_UNITS` | `1` | Checks 2 and 3: the most that the supplier bond of the advert may be. |
| `CHECKS_MAX_BUYER_BOND_UNITS` | `1` | Checks 2 and 3: the most that the buyer bond of the advert may be. |
| `CHECKS_HIRE_PAYLOAD` | none | Check 2, required: the request that the service of the agent accepts. An empty value stops the run with exit 2. Check 3 sends no job and does not read it. See "The payload of check 2". |
| `CHECKS_SVID_VERIFIER_URL` | none | Check 6: the URL of the host that asks for a client certificate. `http://127.0.0.1:<port>` runs the verifier and the client on one machine. |
| `CHECKS_SVID_AUDIENCE` | the verifier URL | Check 6: the audience of the JWT-SVID. The verifier service needs the same value. |
| `CHECKS_SVID_PORT` | `9120` | Check 6: the port of the verifier service. It listens on `127.0.0.1` only. |

The three limits of a hire are compared with the values in the advert (price 1, supplier bond 1 and buyer bond 1 for Agent History), and not with the output that the builder makes. A bond limit of 1 unit does not refuse Agent History.

A key file holds one key: 64 hex characters, a bech32 secret key, or a `NAME=value` line. Its mode must be 600 or stricter. The scripts never print a key.

### The payload of check 2

`CHECKS_HIRE_PAYLOAD` is the request that the service of the agent accepts. Check 2 has no default for it. With no value, or an empty value, the run stops at its start with exit 2. This holds for every command of check 2, also `status` and `cleanup`: keep the value with the other settings.

The agent reads the payload as its job. For Agent History it is a JSON object with a `subject`: a DID, a 64 hex identifier or a 56 hex key hash.

```
CHECKS_HIRE_PAYLOAD='{"subject":"did:vector:<64 hex characters>"}'
```

Some services do not check the request before their Claim. Such a service takes the escrow with its Claim and refuses a bad request only after that. Agent History does this: it answers HTTP 400 after the Claim. The hire then ends as `failed_after_claim`. A bad request costs the fees of the Pay, and the lock comes back only after `deliver_by`. Check that the request has the form that the agent asks for before you start check 2.

When the settings come from a file that a shell reads, a JSON value needs single quotes, as in the example. Double quotes or no quotes change the JSON.

## Wallets

A step that runs a script needs a pure output of 5 units or more in the wallet that pays. This output is the collateral. A pure output holds units and no token. The builder keeps one such output as collateral, and a step can spend it. The steps that run a script are: Delegate, Undelegate, `vault_close`, the Pay, the Accept, the Reclaim, the two issue steps of check 4 and the withdraw of check 4. The step `vault_open` runs no script and needs no collateral.

Each of these steps checks its wallet before it builds anything. When the wallet has no such output, the step stops with exit 2. This also stops a dry run. The message names the wallet, with its key hash and its address, and says how to make the output.

The command `status` shows each wallet and says `NONE` when a wallet has no such output. To make one, send 5.5 units to the address of the wallet in one transaction, from that wallet or from another one. Wait for the confirmation. Run `status` again before each script step.

Start each wallet with ONE large output. Each step spends outputs and leaves change, and the outputs of 5 units or more run out. A member wallet with three outputs of 12, 8 and 8 units had none after eleven steps. For example, start the member wallet with one output of 50 units and the agent wallet with one output of 20 units.

| Wallet | Needs |
| --- | --- |
| member | the delegation deposit (about 2 units), the vault (`CHECKS_VAULT_UNITS`), the attestation deposits (5 units each), the fees, and a collateral output |
| agent (the delegate key) | the fees of the Pay, the Accept and the Reclaim (about 0.5 units each), the top-up of the Returned output of an Accept (see the costs), and a collateral output |

## Order of the checks

Each check opens its own delegation. A delegate key has one live delegation at a time, so run the checks one after the other.

1. Check 1, step `delegate`. Wait for 30 confirmations of the delegation (about 2.5 minutes on mainnet).
2. Check 5. It shows how long is left, and it makes the token request only with `--submit`.
3. Check 1, step `undelegate`. It waits for check 5. Pass `--skip-token-check` to end the delegation without check 5.
4. Check 2: `delegate`, `vault_open`, `hire`, `vault_close`, `undelegate`.
5. Check 3: `delegate`, `vault_open`, `pay`, `reclaim`, `vault_close`, `undelegate`. The step `reclaim` waits until 60 seconds after `deliver_by` of the escrow. With Agent History on mainnet the Reclaim was possible about 11 minutes after the Pay.
6. Check 4: `issue_approval`, `issue_binding`, `read_check`.
7. Check 6: start `06-svid-verifier.ts` behind the host, then run `06-svid.ts` (steps `x509` and `jwt`).

The `cleanup` command of each script ends what the script started: it reclaims an escrow that is due, closes a vault, and ends a delegation. For check 4 it withdraws the deposits when they are due, and it prints the date when they are not.

## Check 6 through a local proxy

Check 6 needs a host that asks for a client certificate. You can prove the client certificate path before such a host exists. Run Caddy on your machine with the snippet that the server uses (`deploy/server/Caddyfile.mock-systems.snippet`).

1. Make the Caddyfile. Write the global options, then add the snippet with its two host placeholders replaced: `<mock-host>` becomes `mock.localhost` and `<mock-mtls-host>` becomes `localhost`.

```
printf '{\n\tlocal_certs\n\tskip_install_trust\n\thttps_port 18443\n\tdefault_bind 127.0.0.1\n}\n\n' > Caddyfile
sed -e 's|<mock-host>|mock.localhost|g' -e 's|<mock-mtls-host>|localhost|g' deploy/server/Caddyfile.mock-systems.snippet >> Caddyfile
```

2. Run Caddy 2 in a container on the network of the host, with this Caddyfile. For example:

```
docker run --rm --name checks-caddy --network host -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2
```

3. Copy the root certificate of Caddy out of the container: `docker cp checks-caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt`. The client needs it, because Caddy signs its own host certificate.
4. Start the verifier service on its default port. Use the same value for the audience here and in step 5.

```
CHECKS_SVID_AUDIENCE=https://localhost:18443 pnpm exec tsx scripts/checks/06-svid-verifier.ts
```

5. Run the client with its own `CHECKS_STATE_DIR`, so that its steps do not stay in the state folder of the real run of check 6. Give it the root certificate with `NODE_EXTRA_CA_CERTS`.

```
NODE_EXTRA_CA_CERTS="$PWD/caddy-root.crt" CHECKS_SVID_VERIFIER_URL=https://localhost:18443 CHECKS_SVID_AUDIENCE=https://localhost:18443 CHECKS_STATE_DIR=./checks-state-proxy pnpm exec tsx scripts/checks/06-svid.ts --submit
```

The other settings (the record, the key files and the gateway) are the same as for the real run. The client must show these results: the verifier accepts the X.509-SVID, and it refuses a call with no client certificate. A call to `https://localhost:18443/svid/x509` with a forged `Client-Cert` header and no certificate must answer 401, because Caddy removes the header that the client sends. For example: `curl --cacert caddy-root.crt -H 'Client-Cert: :AAAA:' https://localhost:18443/svid/x509`.

## What each step costs

All amounts are in units. A transaction pays a fee, below `CHECKS_MAX_FEE_LOVELACE`. The dry run shows the exact fee. The values below were measured on mainnet with Agent History (price 1, supplier bond 1, buyer bond 1).

A payment from a vault locks exactly the price and both bonds: 3.0 units for Agent History. It has no top-up. The number 3.33 is a different amount: it is what the wallet Post of the hosted builder locks. Do not use it as the lock of a vault payment.

| Step | Fee | Locks | Comes back |
| --- | --- | --- | --- |
| Delegate (checks 1, 2, 3) | 0.37 to 0.39 | the delegation output: 2.008460 for a plain grant (check 1), 2.228270 for a grant with a value limit (checks 2 and 3) | at `undelegate` |
| Undelegate | 0.41, taken from the delegation output | none | the delegation output, less the fee |
| `vault_open` (checks 2, 3) | 0.17 | `CHECKS_VAULT_UNITS` (8) in the vault | at `vault_close` |
| the Pay (checks 2, 3) | 0.49, from the agent wallet | 3.0 units from the vault | at the Accept or the Reclaim |
| the Accept (check 2) | 0.50, from the agent wallet | none | The supplier gets the price and the supplier bond (2 units). The buyer bond goes to the vault as a Returned output |
| the Reclaim (check 3) | 0.50, from the agent wallet | none | all of the 3.0 units, to the vault as a Returned output |
| `vault_close` | 0.50 | none | the Live output and each Returned output, together |
| `issue_approval`, `issue_binding` (check 4) | 0.34 each | 5 each | at the withdraw, 90 days after `valid_until` |
| Check 5 and check 6 | nothing | none | not applicable |

The Returned output of an Accept holds the buyer bond and a top-up to the ledger minimum: 1.064570 units in the run. The agent wallet (the delegate key) pays the top-up.

The times that were measured: 30 confirmations took about 2.5 minutes, the Reclaim was possible about 11 minutes after the Pay, and a whole hire (Pay, job, receipt and Accept) took 77 seconds.

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
