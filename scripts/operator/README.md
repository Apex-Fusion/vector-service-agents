# The operator pack

The operator pack prepares and checks three use cases. It makes keys, records, stakes, adverts and env files. It also checks the evidence of a run. One command runs one task. Before the pack signs a transaction, it checks the transaction and the approval.

| Setting name | Use case | Data |
|---|---|---|
| `inventory-reorder` | Use case 1 (inventory reorder) | [`usecases/inventory-reorder.ts`](usecases/inventory-reorder.ts) |
| `prior-authorization` | Use case 2 (prior authorization) | [`usecases/prior-authorization.ts`](usecases/prior-authorization.ts) |
| `bid-evaluation` | Use case 3 (supplier bid evaluation), with a separate lifecycle run on Bid Desk Bravo | [`usecases/bid-evaluation.ts`](usecases/bid-evaluation.ts) |

Use a separate state folder for each use case and network. The pack refuses a saved state or facts file that belongs to another use case or network. One approval file serves one use case. Never copy an approval file to another state folder. Code support does not show that an agent is deployed or a run has completed.

CI builds the pack as the image `operator` from `scripts/operator/Dockerfile`. The first argument of the container is the name of a task, and the settings are `OPERATOR_*` names (section "The settings"). From a checkout, the same command is:

```sh
node --import tsx scripts/operator/cli.ts <task> [status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>] [the flags of the task]
```

## The command

- `run` is the default command. It does the next step of the task that is not confirmed yet. A step that is confirmed never runs again, and a confirmed step that is not verified is verified first.
- With no `--submit`, a run is a dry run. A transaction preview shows the plan and signs and submits no transaction. The runner does not load the approval file or check the session cap. The `fund --member <label>` preview reads the approval file for the member's address and amount. The task `probe` makes its token request, and signs it, in a dry run too (see its row).
- With `--submit`, a transaction step signs, submits, waits for confirmation and records the result. Some tasks use `--submit` to write files only. The task table says which tasks need `GO.json`.
- Without `--all`, a run does one step. With `--all`, a run goes on after each step that is done. It stops at the first step that is only shown, that must wait, or that fails.
- `status` takes only `--run` and `--use-case`. It does not build a transaction. `hold status` reads the saved suspend and facts. It reads the current record only when they identify the same agent. An absent saved fact does not prove that the ledger has no holds. `probe status` reads only saved observations. Neither command loads signing keys or creates a journal.
- `cleanup` takes back what can come back. The task says what: a claim after its window, an advert that the pack posted, a deposit that is due, a hold that the pack made.
- `--run <label>` names a run and selects its state and evidence files. The run tasks `claim`, `tenant`, `fault`, `hold`, `probe` and `evidence` use it for their run data. Use `--run l1` for `lifecycle`. A keyless `claim --trial` does not need a label.
- `--use-case <name>` names the use case. The default is the setting `OPERATOR_USE_CASE`.
- A run tries to settle a saved transaction in flight before it builds the next step. When the pack records the step as landed, it keeps the reserve. A task that needs no approval refuses `run` and `cleanup` when its state holds a transaction in flight. Its `status` shows the saved entry without trying to settle it.
- To clear an unconfirmed transaction as not landed, a submit run needs a valid approval for the selected use case, task and run wallet. Automatic recovery can do this only when the clock is more than one minute past the end of validity and the indexer does not know the transaction. The node must pass the network guard. Its tip must be more than 20 slots past the transaction's end slot before it checks the inputs. It must show at least one unspent input and, if the transaction uses collateral, at least one unspent collateral input. Set `VECTOR_OGMIOS_URL` to one node, not a load balancer, so both reads come from the same node. If the checks cannot settle the transaction, the pack keeps the record and reserve and builds no new step. A dry run does not clear the record as not landed or release its reserve.
- Use `cleanup --release=<hash> --submit` only after you check the transaction and its inputs on the chain and show that it did not land. This also needs a valid approval for the selected use case, task and run wallet. Give the exact in-flight hash. The command refuses if the indexer shows that the transaction landed. The signed transaction must have a validity end. The clock must be more than one minute past the saved end of validity.
- For a manual release, a tip from a node that passes the network guard must be a valid slot more than 20 slots past the transaction's end slot. A returned tip that fails this check stops the release. If the network guard rejects the node or the tip request fails, the command reports that it did not use the node. It can proceed on the clock and the operator's check. If the indexer read fails, it reports the failure and adds no indexer check. The command writes an `info` entry into the evidence file before clearing the in-flight record. It does not run the task's usual cleanup.
- One run lock file in the state folder keeps two runs from writing the state, the facts and the cap file at the same time.

The exit code of the process is the exit code of the run:

| Exit | Meaning |
|---|---|
| 0 | The step is done, shown or finished, or a dry run is complete. |
| 1 | A step failed, or an error came after the run signed a transaction. |
| 2 | A flag, a setting, a key, a file, an approval, a guard or a precondition stopped the run. Nothing was signed. |
| 3 | The hosted tools cannot be used. |
| 4 | A wait is open. The output says how long is left. The pack never sleeps. |

Each run ends with one line on the standard output: `operator-result: <JSON>`. The JSON has seven members: `task`, `command`, `mode`, `outcome`, `exit`, `step` and `result`. The `outcome` is `dry`, `done`, `finished`, `wait`, `failed` or `stopped`. The `result` is an object of public values only: DIDs, hashes, references, a TXT name and a TXT value. A step or a result that holds the mark of a secret is replaced: the line then has `step: null` and `result: {}`.

## The tasks

The table lists task flags. `--use-case` selects the case. Use `--all` to continue past one completed step. Some actions reject `--submit`, including `status`, `attest --record`, `compliance --record` and `claim --trial`. The `fund` and `compliance` tasks do not take `--run`: each uses one state stream for the use case. If the pack refuses an approval before it signs any transaction, it exits 2. If it already signed a transaction in that run, an approval refusal exits 1.

| Task | What it does | Flags | With `--submit` | Writes |
|---|---|---|---|---|
| `keys` | Makes keys on first setup and shows the run wallet address. It never replaces a key file or prints a seed. | `--initialize` | Needs the approval. Use `--initialize` only for first setup. A dry run lists the keys and makes none. | The key files, `keys-public.<use case>.json` and `keys-initialized.json`. |
| `fund` | Sends units from the run wallet to the other wallets of the use case. The step `collateral` sends one pure output of exactly 5 units to each wallet that has none. The step `float` sends each wallet what its balance lacks to its collateral and its float. | `--member <label>` | Needs the approval. Signs with the run key and submits. With `--member <label>` it sends the amount that the approval gives to the one external address that the approval names for that label, once. | The state file and the evidence file. |
| `register` | Registers the agents, subagents and other records in the use case. A child follows its parent. For each subject with an organisation, the `organisation:` step checks that the gateway verified the organisation. | none | Needs the approval and the `record` tag. For each registration that needs a TXT record, `--submit` requires a saved dry-run note with the same DID, TXT name and TXT value. The task checks the published TXT before it signs. | The facts `records` and `organisations`. |
| `stake` | Makes the Module-3 stake of each agent in two steps, `open` and `create`. The owner of the stake is the service key of the agent. | none | Needs the approval, and the approval names the tag `stake`: the minimum of a stake never returns. | The fact `stakes`. |
| `advert` | Posts the next advert in use-case data order with the hash of the served manifest. The task reads the manifest twice and requires the same bytes. There is no flag to select a post. | `--agent <id>` (cleanup only) | Needs the approval. Cleanup retires recorded adverts. Use `--agent` to limit cleanup to one agent. The task checks the confirmed supplier credit after the actual fee. | The facts `adverts`, `manifests` and retirement evidence. |
| `attest` | Issues provenance and software attestations for the subjects in the use case. The task checks the attestations in the gateway. | `--record`, `--commit <sha>`, `--locator-base <url>` | Needs the approval and the `attestation` tag to issue. Cleanup withdraws only deposits that are due. `--record` takes no `--submit`. | The fact `attestations` and, with `--record`, the files in `attestation-documents/`. |
| `compliance` | Issues a compliance attestation for each configured subject. The issuer can revoke it. The subject controller can publish a reply. | `--record`, `--locator-base <url>`, `--revoke`, `--agent <id>`, `--reason <non-negative safe integer>`, `--contest`, `--reply-uri <url>` | Needs the approval. Issue needs the `attestation` tag. Revoke needs `attestation-revoke`. `--record` writes the documents without `--submit`. Cleanup withdraws only deposits that are due. | The public files in `documents`, the fact `compliance` and the evidence for each action. |
| `claim` | Stakes one claim per agent for a clean or failure run. The claim uses the agent's service key and holds 50 units with a challenge window of 24 hours. The task checks the configured reserve for a failure run's challenger. Cleanup records the payout reference of a confirmed withdrawal. If the original output was spent and no live output holds the token, cleanup can record `not open`. It does not independently verify the terminal spend or refund. | `--kind <clean or failure>`, `--trial` | Needs the approval for stake or cleanup. The stake records a claim document transaction and a claim transaction. `--trial` writes the case's jury test documents from public inputs. It uses no keys or ledger, and takes no `--submit`. | The fact `claims` or the files in `trial/`. |
| `allowlist` | Adds a principal key hash to `COSIGN_ALLOWLIST` of the agent that serves the co-sign route. It never drops an entry. | `--key <56 hex>`, `--agent <id>` | Needs the approval. Writes only the selected env file, not the running service. | The env file of the agent. |
| `env` | Plans all service and runtime env files for the selected use case from their examples. It checks the named records, files and variable placement before it writes. After `advert`, run it again to set `ADVERT_REF`. | `--replace-advert` | Needs the approval. Writes with mode 600. `--replace-advert` lets the task change a set reference to the one already in the facts. The task does not replace other set values. | The env files in the agent folders. |
| `tenant` | Makes a tenant for a run with its configured organisations and seed. It checks that a new name is unused. | `--name <tenant>`, `--kind <clean or failure>`, `--reset` | Needs no approval. A dry run does not send the create or reset request. Reset needs the saved tenant and the matching owner reported by the mock service. Reset removes the tenant's writes and log entries. | The fact `tenants`. |
| `fault` | Sets `FAULT_MODE` in an agent's env file. A check matches the configured service container and the observed start and switch values in `seen-services.json`. | `--agent <id>`, `--set <value>`, `--check <clean or a value>` | Needs the approval. `--set=` without `--agent` clears the switch in the env files of every agent in the use case. It does not change the running containers. `--check` records the check for the run. | The env file or the evidence entry. |
| `probe` | Makes one token request to the gateway under a delegation or one credential request for a subagent. It makes the request in a dry run too. For a delegation, it signs the request with two keys, the subject token with the service key of the agent and the proof with the delegate key. It signs no transaction. For a subagent, it checks the subject and proof keys of that record. A credential result does not prove that an action was allowed. | `--agent <id>`, `--key <name>`, `--delegation <id>`, `--subagent <id>`, `--resource <url>`, `--action <action>`, `--expect <granted or refused>` | Needs no approval. Use either a subagent or the delegation arguments, not both. | A local observation journal. No token or proof is stored. |
| `hold` | Puts a hold on an agent with the Accountable key of its organisation, and lifts it. The hold lasts 1 day by default, and 30 days at most. | `--agent <id>`, `--by <name>`, `--days <n>` | Needs the approval. Signs the hold or the lift. `cleanup --submit` lifts a hold that the pack made. | The fact `holds`. |
| `end-subagents` | Ends all current subagents of a parent that the use case marks for this action. It checks the parent epoch and each listed child. This action is permanent and takes no run label. | `--agent <id>` | Needs the approval and the `end-subagents` tag. The controller and fee keys sign. | The `subagentEnds` fact and evidence of the epoch change. |
| `revoke-record` | Revokes a record that the use case marks for revocation. Its Accountable key must hold the right for the named organisation. Reason 1 needs the time from which the key is invalid. The task takes no run label. | `--agent <id>`, `--by <key>`, `--reason <code>`, `--invalid-from <time>` | Needs the approval and, for revocation, the `record-revoke` tag. For cleanup, specify only the same agent. The controller and fee keys reclaim only the surplus of the verified revocation. | The `revocations` fact and confirmed evidence. A reclaim reports credit to the fee wallet only after checking the actual ledger fee and outputs. |
| `lifecycle` | Changes the controller, starts recovery, waits, completes recovery, retires the record, sets its successor and reclaims the surplus. Use `--run l1` with the use case that defines it. | none | Needs the approval. Use two approval windows. The first has `controller-change`. The second has `recovery-complete`, `retire` and `successor`. The task bypasses neither the wait nor an active hold. | The `lifecycle` facts and confirmed transaction references. The wait signs no transaction. |
| `delegations` | Lists delegations for an agent or delegate key, including subagent keys. It checks the parent chain of a child delegation. A child whose parent ended is not usable. | `--delegate-key <name>`, `--agent <id>` | Needs no approval. Reads only. | Nothing. |
| `evidence` | Checks a clean, failure or lifecycle run against the relevant ledger, indexer and service records. It does not treat a pending jury case as a result. A failure run can return exit 4 while a verdict or its required hold is not shown. | `--private` or `--number <n>` (1 to 99) | Needs no approval. A run writes without signing, even without `--submit`. Give one of the two flags, not both. `--private` writes only the private file. | `evidence/<date>-<agent>-run-<n>.json`, or `evidence/private/<label>.json`. |
| `results` | Writes a private results page from the evidence files for the use case. A step counts as shown only when its evidence proves the required references. | `--header-file <file>`, `--runs <label,label>` | Needs no approval. Without `--submit` it prints the page. With `--submit` it writes the page. | `results/<use case>.md`. |
| `end-state` | Checks the expected end state of each agent in the use case. Checks include records, organisations, adverts, claims, delegations, holds, keys, wallets, attestations and runtimes. A retired or revoked record has different checks from an active record. | none | Needs no approval. Reads only. `run` exits 0 when all checks pass, 4 when a check must wait and none fail, or 1 when a check fails. `status` reports an incomplete end state as non-success. | Nothing. |

A step that spends a wallet also used by a running service checks the required runtimes. A relevant running runtime must say `free`. The task stops if the required observation is missing or untrusted.

`results` takes the header file, the text that starts the page, from a path outside the keys folder. The file stays outside the repository, and it holds no run of 40 or more hex characters. Without `--runs`, the page takes the public evidence files only. A private file goes into the page when `--runs` names its label.

`end-state` needs `OPERATOR_MODULE1_COMMIT`, the public key file of the use case, and a fresh `running-images.json` in the state folder.

### Advert replacement

`advert` writes the reference and manifest information to the facts from its own confirmed post. It can change a saved advert reference only after the previous output is no longer live. The default state stream skips confirmed posts. A new `--run` label starts at the first configured advert. It stops at a live listing rather than moving on to another agent.

The pack has no command to replace one selected listing in place or to record an advert posted manually. `env --replace-advert` only copies references already in `facts.json`. It does not post an advert or check a replacement on the ledger. To replace one listing, use the manual flow in its deployment runbook. Do not retire unrelated listings or edit the facts to move the pack past a live listing.

### First key setup and recovery

Verify that the use case has no prior key setup. Keep a separate state folder for each use case. Restore the public key files of any earlier use cases before you continue.
The key folder of this use case must be empty. The shared key folder can hold only keys that match the earlier public key files. An unrecorded entry is a reason to stop, not a reason to make new keys.

1. Preview with `node --import tsx scripts/operator/cli.ts keys run --initialize`. A dry run needs no `GO.json`. You can preview the first wallet with no key files.
2. Get an approval for `keys` only. Set `useCase` to the selected use case. Set `capUnits` to `0`. Include no irreversible tags or external addresses. Use `unset` for `runWallet` only before the first wallet exists. For a later use case, use the address in the verified public key files.
3. Run `node --import tsx scripts/operator/cli.ts keys run --initialize --submit`. The task writes `keys-initialized.json` in the state folder before it makes any key files.

Do not use `--initialize` to repair or replace keys. If setup stops after it writes the marker, keep the marker and all key files. Restore the original public key file and any missing original key files from verified backups. Then run `keys run --submit` without `--initialize`. If no valid backup exists or you cannot verify custody, stop and reconcile custody outside this task. Do not remove the marker or start again in a new state folder.

For a use case with a valid `keys-public.json`, run `keys run --submit` without `--initialize`. The task checks the keys and writes `keys-public.<use case>.json`. It keeps the original file.

Before you submit `tenant`, the mock service must support the `operation` and `owner` fields of [`POST /admin/tenants`](../../services/mock-systems/README.md#tenants). An earlier build rejects these fields before it changes a tenant. The task does not retry with the legacy request. Select an unused name for a new run. The task cannot adopt or reset a tenant made with the legacy request.

## The order of the work

The steps below prepare and check a run. The pack does not perform a hirer's jobs.

1. `keys` prints the address of the dedicated run wallet after setup. The wallet is shared across the use cases of this pack. Keep it separate from hirer and service wallets. The owner funds it outside the pack.
2. `fund` prepares collateral and float. A transfer with `--member <label>` needs the exact address and amount for that label in the approval.
3. `register` makes the records. For each subject that needs a TXT record, run the dry step in the same state stream before you submit. The task saves the DID, TXT name and TXT value. Publish that TXT outside the pack. The submit run checks that the saved values match. It then requires the exact value from all three public resolvers over HTTP/2 with verified TLS before it signs. Wait for the gateway verification. Register a parent before its children.
4. `stake` makes the Module-3 stakes. `env` makes the files from the examples. Start the services outside the pack.
5. `advert` posts the configured adverts after the services serve their manifests. Run `env` again for the confirmed references. Check each runtime's own reference before it serves jobs.
6. `attest` prepares the public documents and issues the build attestations after you publish their files. For a case with compliance subjects, `compliance` prepares the documents, issues the configured attestation, and supports an issuer revoke and a subject reply. Use a raw document URL at its exact commit. Verify the first action before the next. If a withdrawal is not verified, check the same transaction. Do not start another withdrawal.
7. `claim` stakes the claims for a clean or failure run. `tenant` makes the tenant. `allowlist` adds the hirer to the co-sign list in the env file. Create the affected service container again under its restart rule before a hire or a fault check. Use `fault` to check the clean switch before and after the hires. Set only the intended fault for a failure run. Create the affected service container again after each change to its switch. Then check the switch that the running service reports.
8. `hold` makes or lifts a hold from the named Accountable key. It cannot lift a Module-1 hold. Use `delegations` and `probe` to observe delegation and gateway status. Use `end-subagents` or `revoke-record` only for the subjects and actions that the use case names. These actions are permanent.
9. `lifecycle` has two separate approval windows. The first changes the controller and starts recovery. Record the tool's refusal of an early completion. The second starts only after the recovery window opens and the node and transaction window both permit completion. See "Lifecycle closeout".
10. `evidence` checks and writes evidence from the run records. Use `claim cleanup` for eligible claims after their window. Do not count an unverified refund. `results` writes the private page. `end-state` checks what remains.

### Lifecycle closeout

Use `lifecycle run --run l1 --all --submit` in the first approval window. Exit 4 means the recovery must wait. Use `lifecycle status --run l1` to read the date from the record. The recovery opens seven days after the upper validity bound of its start transaction. The `lifecycle` task also needs a recorded refusal of early completion from the first window. That refusal submits no transaction.

Continue in the same state folder with a fresh approval after the wait. Do not bypass an active hold. Before retirement, close the selected agent's claims and retire only that agent's adverts with a separate approval for `advert`. Use `advert cleanup --agent <id> --submit` in the default advert state stream, without a run label. The lifecycle checks the actual terminal claim spend and the verified advert retirement receipts, including the supplier credit after fees. It then completes the retirement, successor and surplus steps. Cleanup cannot undo them.

## The files

The keys folder is the setting `OPERATOR_KEYS_DIR`.

- `<keys>/shared/<name>.seed` is a key that several use cases share. `<keys>/<use case>/<name>.seed` is a key of one use case. A file holds 64 lower-case hex characters and one newline. The folders have mode 700 and the files mode 600. No task replaces a key file.
- `<keys>/keys-public.<use case>.json` lists the public part of each key: its name, scope, purpose, public key, key hash and address. It holds no secret. The task also checks the earlier `keys-public.json` if it exists.

The state folder is the setting `OPERATOR_STATE_DIR`. It has mode 700.

- `GO.json` is the approval for one session of one use case (the setting `OPERATOR_GO_FILE` gives another path). It has mode 600. The required members are `approvedBy`, `at`, `session`, `useCase`, `runWallet`, `capUnits`, `tasks`, `irreversible` and `expiresAt`. For a transfer to a member, `external` gives the allowed address and units for each label.
- A task that needs approval refuses an absent, damaged or expired approval, or one whose `useCase` does not match the selected use case. It checks the exact run wallet, task name, required tags and cap before signing. The cap limits the cumulative net outflow of the keys of the pack in that session of that use case. A transfer between pack wallets counts only its fee. A transfer to a member counts in full.
- Irreversible tags: `record`, `stake`, `attestation`, `end-subagents`, `attestation-revoke`, `record-revoke`, `controller-change`, `recovery-complete`, `retire`, `successor`.
- `exposure.<session>.json` in that use case's state folder tracks what counts against the session cap. The pack reserves the outflow before it writes the in-flight record and submits the transaction. On automatic recovery or manual release of a transaction as not landed, the pack removes a matching reserve only from the cap file for the session in the loaded approval. If the approval names a different session, the original session's reserve stays in its file.
- `<task>.state.json` is the state of a task: its confirmed steps, the one transaction in flight, and notes. `<task>.evidence.json` is its evidence: confirmed, verified, info, refused and tool refused entries. A task that takes `--run` uses `<task>.<label>.state.json` and `<task>.<label>.evidence.json`. Both files have mode 600, and the pack writes each whole through a temporary file.
- The runner keeps the in-flight record and signs nothing new when automatic recovery cannot show whether the transaction landed. See "The command" for the approval, clock and node checks.
- `facts.json` keeps what one task found out and a later task needs: `records`, `organisations`, `stakes`, `adverts`, `manifests`, `attestations`, `claims`, `tenants`, `holds`, `deploy`, `compliance`, `revocations`, `lifecycle` and `subagentEnds`. It holds public values only. A fact is set once, and another value is an error unless the call replaces the fact.
- `keys-initialized.json` records that key setup started for this use case and network. It holds no keys. Keep it with the state when you restore files.
- `run.lock` is the run lock file.
- `seen-services.json` and `running-images.json` come from the script that starts the container. It writes both before every run, from the running containers, and the pack refuses a file that is more than 10 minutes old. `seen-services.json` holds `generated_at` and, for each service, its name, its kind, its container, its start time and the value of `FAULT_MODE`. `running-images.json` holds `generated_at` and `images`: for each running container, its image pinned by the digest of the image index. An empty `images` object means that no container runs.
- `attestation-documents/` holds the documents of `attest --record`. `documents/` holds the documents of `compliance --record`. `trial/` holds jury test documents and their hashes from `claim --trial`. `evidence/` holds the run evidence. `evidence/private/` holds private copies. `results/` holds the private results page.
- `runs/<label>.json` is the run record. `runs/<label>/` holds one report per reported hire. For a check that needs an execute request, save the exact UTF-8 request text as `<step>.request.json` with mode 600 in that mode-700 folder. Do not reformat it or publish it. A missing request cannot prove approval use. Public evidence for the new cases uses checked fields and hashes, not the signed request or result text.

The agents folder is the setting `OPERATOR_AGENTS_DIR`. It holds the folder of each agent: the env files that `env`, `allowlist` and `fault` write, and the examples that `env` makes them from.

The mock env file is the setting `OPERATOR_MOCK_ENV_FILE`. Only `tenant` reads it. The token of the mock service stays in one local variable of that task and goes into one header.

The image holds no key and no docker client. The caller starts it with `docker run --rm` and mounts what the task needs: the keys folder (read-only, except for `keys`), the state folder, the agent folders (for `env`, `allowlist` and `fault` only) and the mock env file (for `tenant` only).

## The settings

The settings are read from the environment. One refusal lists every problem, and it never shows a value.

| Setting | Meaning |
|---|---|
| `OPERATOR_USE_CASE` | The use case. The default is `inventory-reorder`. |
| `OPERATOR_KEYS_DIR` | The keys folder. It must exist for tasks other than `hold status` and `probe status`. |
| `OPERATOR_STATE_DIR` | The state folder. Required. It has mode 700. Regular runs can create it. `hold status` and `probe status` create nothing when it is missing. |
| `OPERATOR_AGENTS_DIR` | The folder that holds the folder of each agent. The default is `/agents`. |
| `OPERATOR_GO_FILE` | The approval file. The default is `GO.json` in the state folder. |
| `OPERATOR_MOCK_ENV_FILE` | The env file of the mock systems. Only `tenant` reads it. |
| `OPERATOR_CONTACT` | The contact that `env` writes into the env files. One line. The operator types it, and no file of the repository holds it. |
| `OPERATOR_MODULE1_COMMIT` | The commit of the Module-1 manifest, 40 lower-case hex characters. The claim, env, evidence, retirement and end-state checks that read the manifest use this pin. |
| `OPERATOR_NETWORK` | `vector-mainnet` by default, or the name of a test network. |
| `OPERATOR_NETWORK_MAGIC` | The network magic of a test network. |
| `OPERATOR_NETWORK_SYSTEM_START_MS` | The system start of a test network, in milliseconds. |
| `VECTOR_OGMIOS_URL` | The node. It must name one node, not a load balancer. |
| `VECTOR_SUBMIT_URL` | The address that takes a signed transaction. |
| `VECTOR_KOIOS_URL` | The Koios indexer. |
| `OPERATOR_HOSTED_URL` | The hosted tools of the marketplace. The default is the mainnet server. |
| `OPERATOR_GATEWAY_URL` | The identity gateway. The default is the mainnet gateway. |
| `OPERATOR_MAX_FEE_LOVELACE` | The most that a transaction may pay as a fee. The default is 2 units. |
| `OPERATOR_MAX_COLLATERAL_LOSS_LOVELACE` | The most that a transaction may lose of its collateral. The default is 5 units. |
| `VECTOR_MARKETPLACE_INDEXER_URL` | The indexer of the marketplace that `evidence` reads for the cases of the jury. The default is the public indexer. |

## What it never does

- It never prints a private key or sends one to a hosted builder. Only `env` obtains the private text it needs for the lines that the data names. The state folder is private: a transaction in flight retains signed bytes for recovery. Do not publish the state, probe journal, or private evidence.
- It never signs a transaction without an approval. A `--submit` of a task that moves funds or makes a permanent record refuses when the approval file is missing, expired or too narrow.
- It never signs a transaction that a guard refuses. The guards check the signers, the destinations, the fee, the outflow, the mint, the collateral and the inputs of each transaction against the plan of its step.
- `fund` sends units to pack wallets or to the exact member address and amount in the approval.
- It never replaces a key file. It replaces an existing advert reference only when you request `--replace-advert`. The compliance registry key `registry-foxtrot` signs only its attestation transactions, not the subject's reply.
