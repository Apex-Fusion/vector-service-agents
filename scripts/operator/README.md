# The operator pack

The operator pack makes the keys, the records, the stakes, the adverts, the env files and the other results that a use case needs before and during its runs. One command runs one task. A task that signs a transaction builds its step, checks it with the guards, and signs it in process only with an approval. The pack knows use case 1 (inventory reorder) today. Its data is in `usecases/inventory-reorder.ts`.

CI builds the pack as the image `operator` from `scripts/operator/Dockerfile`. The first argument of the container is the name of a task, and the settings are `OPERATOR_*` names (section "The settings"). From a checkout, the same command is:

```sh
node --import tsx scripts/operator/cli.ts <task> [status | run | cleanup] [--submit] [--all] [--use-case <name>] [--run <label>] [the flags of the task]
```

## The command

- `run` is the default command. It does the next step of the task that is not confirmed yet. A step that is confirmed never runs again, and a confirmed step that is not verified is verified first.
- With no `--submit`, a run is a dry run. It builds the step, runs every guard, prints the summary and the plan, and signs and submits no transaction. It needs no approval file. The task `probe` makes its token request, and signs it, in a dry run too (see its row).
- With `--submit`, a run signs, submits, waits for the confirmation and records the step. A task that moves funds or makes a permanent record needs the approval file `GO.json` (section "The files").
- Without `--all`, a run does one step. With `--all`, a run goes on after each step that is done. It stops at the first step that is only shown, that must wait, or that fails.
- `status` shows the state, the transaction in flight, the next step and the wallets, with no build. It takes only `--run` and `--use-case`.
- `cleanup` takes back what can come back. The task says what: a claim after its window, an advert that the pack posted, a deposit that is due, a hold that the pack made.
- `--run <label>` names a run of the use case. A task that works for a run (`claim`, `tenant`, `fault`, `hold`, `probe`, `evidence`) takes it. The state file and the evidence file of a task with a label are `<task>.<label>.state.json` and `<task>.<label>.evidence.json`.
- `--use-case <name>` names the use case. The default is the setting `OPERATOR_USE_CASE`.
- A transaction that a run signed and did not see confirmed stays in flight. The next run settles it before it builds anything. The runner lets it go only when its validity ended and the node (not the indexer) shows that one input is unspent, and one collateral input when it has any. That check counts only when the tip of the node is past the end of the validity by 20 slots. The tip and the inputs must come from one node: the setting `VECTOR_OGMIOS_URL` must name one node, not a load balancer. Otherwise the transaction stays in flight with its reserve, and the run exits 2.
- `cleanup --release=<hash> --submit` is the way out when the chain shows that the transaction is not there. It refuses until the clock is a minute past the end of the validity and the tip of the node is past it too. It writes an `info` entry into the evidence file, and it gives the reserve back when the approval is loaded. The cleanup of the task does not run then.
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

The first column is the name of the task. The flags are those of the task, besides `--submit`, `--all` and `--use-case`, which every task has, and `--run`, which every task except `fund` takes. A task whose `--submit` needs the approval refuses with exit 2 when the approval is missing, expired or too narrow.

| Task | What it does | Flags | With `--submit` | Writes |
|---|---|---|---|---|
| `keys` | Makes keys on first setup and shows the run wallet address. It never replaces a key file or prints a seed. | `--initialize` | Needs the approval. Use `--initialize` only for first setup. A dry run lists the keys and makes none. | The key files, `keys-public.<use case>.json` and `keys-initialized.json`. |
| `fund` | Sends units from the run wallet to the other wallets of the use case. The step `collateral` sends one pure output of exactly 5 units to each wallet that has none. The step `float` sends each wallet what its balance lacks to its collateral and its float. | `--member <label>` | Needs the approval. Signs with the run key and submits. With `--member <label>` it sends the amount that the approval gives to the one external address that the approval names for that label, once. | The state file and the evidence file. |
| `register` | Registers the record of each agent and of its subagent, and then waits until the gateway shows the organisation of each agent as verified. A dry run prints the DID, the TXT name and the TXT value, and writes a note. | none | Needs the approval, and the approval names the tag `record`. It refuses until the note of a dry run exists for the same DID and three public resolvers show the TXT value. | The facts `records` and `organisations`. |
| `stake` | Makes the Module-3 stake of each agent in two steps, `open` and `create`. The owner of the stake is the service key of the agent. | none | Needs the approval, and the approval names the tag `stake`: the minimum of a stake never returns. | The fact `stakes`. |
| `advert` | Posts the adverts of the use case. Each advert holds the hash of the manifest that the running service serves: the task reads `/agent.json` twice, and the two bodies must be equal. | none | Needs the approval. Posts the advert. `cleanup --submit` retires each advert that the pack posted. | The facts `adverts` and `manifests`. |
| `attest` | Issues a provenance attestation and a software attestation for each agent with the Provider key, and then waits until the gateway lists each one. The software attestation of the Reorder Agent carries a COSE envelope. `--record` writes the documents that the attestations name. | `--record`, `--commit <sha>`, `--locator-base <url>` | Needs the approval, and the approval names the tag `attestation`. `cleanup --submit` withdraws the deposits that are due. `--record` takes no `--submit`: it makes no transaction and writes the files at once. | The fact `attestations`, and the folder `attestation-documents`. |
| `compliance` | Issues a compliance attestation for each configured subject. The issuer can revoke it. The subject controller can publish a reply. | `--record`, `--locator-base <url>`, `--revoke`, `--agent <id>`, `--reason <integer>`, `--contest`, `--reply-uri <url>` | Needs the approval. Issue needs the `attestation` tag. Revoke needs `attestation-revoke`. `--record` writes the documents without `--submit`. Cleanup withdraws only deposits that are due. | The public files in `documents`, the fact `compliance` and the evidence for each action. |
| `claim` | Stakes the claim of a run for each agent, with a stake of 50 units and a challenge window of 24 hours. `cleanup` withdraws each claim of the run after its window, when nobody challenged it. A claim that a challenge moved waits for its verdict. `--trial` writes the documents for the test of the jury. | `--kind <clean or failure>`, `--trial` | Needs the approval. Stakes the claim in two transactions, the claim document and the claim. `--trial` makes no transaction and writes the files at once. | The fact `claims`, and the folder `trial`. |
| `allowlist` | Adds the key hash of a principal to `COSIGN_ALLOWLIST` in the env file of the Reorder Agent. It never drops an entry. | `--key <56 hex>`, `--agent <id>` | Needs the approval. Writes the env file of the agent. | The env file of the agent. |
| `env` | Makes the env files of the agents from their examples, and reconciles the files that exist. One run plans every agent of the use case: it writes nothing, and it stops with exit 2, when the folder, an example or a record of one agent is missing. It runs again after `advert`, to write `ADVERT_REF`. It is the one task that reads a seed, and each seed goes into the one line that the data names for it. It never overwrites a value. | `--replace-advert` | Needs the approval. Writes the files with mode 600. `--replace-advert` lets the task replace the reference of an advert. | The env files in the agent folders. |
| `tenant` | Makes the tenant of a run on the mock systems. It sends the request to the operator route of the mock service. | `--name <tenant>`, `--kind <clean or failure>`, `--reset` | Needs no approval. Sends the request. A dry run prints it and sends nothing. `--reset` resets a tenant that exists. | The fact `tenants`. |
| `fault` | Sets the switch `FAULT_MODE` of an agent in its env file, and checks that a run is clean or has the fault that it needs. `--check` reads `seen-services.json`. | `--agent <id>`, `--set <value>`, `--check <clean or a value>` | Needs the approval. `--set` writes the env file. `--check` writes the entry `fault_check` into the evidence file of the run. | The env file, and the evidence file of the run. |
| `probe` | Makes one token request to the gateway under a named delegation and a named delegate key, and records what the gateway answers. It makes the request in a dry run too, so it signs in a dry run too: it signs the request with two keys, the subject token with the service key of the agent and the proof with the delegate key. It signs no transaction. | `--agent <id>`, `--key <name>`, `--delegation <id>`, `--resource <url>`, `--action <action>`, `--expect <granted or refused>` | Needs no approval. Adds the entry to the evidence file of the run. | The evidence file of the run. |
| `hold` | Puts a hold on an agent with the Accountable key of its organisation, and lifts it. The hold lasts 1 day by default, and 30 days at most. | `--agent <id>`, `--by <name>`, `--days <n>` | Needs the approval. Signs the hold or the lift. `cleanup --submit` lifts a hold that the pack made. | The fact `holds`. |
| `delegations` | Lists the live delegations by delegate key, and says which delegation key of each agent is free. It signs and builds nothing. | `--delegate-key <name>`, `--agent <id>` | Needs no approval. Reads only. | Nothing. |
| `evidence` | Writes the evidence file of a run from its run record and the report file of each hire, after each reference agrees with a read of the node, the indexers, the hosted tools and the mock service. A run of kind failure exits 4 until its jury case has a verdict. `status` shows the claims, the challenge, the case and the hold. | `--private`, `--number <n>` | Needs no approval. Writes the file at once. `--private` writes a private copy. | `evidence/<date>-reorder-agent-run-<n>.json`, or `evidence/private/<label>.json`. |
| `results` | Writes the private results page of the use case from the evidence files of its runs. A step counts as shown only when its evidence file holds a reference for it. | `--header-file <file>`, `--runs <label,label>` | Needs no approval. Without `--submit` it prints the page. With `--submit` it writes the page. | `results/<use case>.md`. |
| `end-state` | Reads the end state and prints one line for each check: each record is Active, each organisation is verified, the adverts are listed, no claim is open, no delegation of a hirer is live, no hold of the pack is on, each wallet holds its collateral output and at least half of its float, the attestations are listed with the dates of their deposits, and the runtimes run and say free. | none | Needs no approval. Reads only. `run` ends with exit 0 when every check is ok, 4 when no check fails and some wait, and 1 when a check fails. `status` prints the same lines and ends with exit 0 only when every check is ok. | Nothing. |

A task that spends a wallet that a running service also uses (`claim`, `stake`, `advert`, `attest`, and the cleanup of `claim` and of `advert`) stops with exit 2 unless every runtime that `running-images.json` lists says `free` at its status address. A runtime that the file does not list is not running, and nobody asks it.

`results` takes the header file, the text that starts the page, from a path outside the keys folder. The file stays outside the repository, and it holds no run of 40 or more hex characters. Without `--runs`, the page takes the public evidence files only. A private file goes into the page when `--runs` names its label.

`end-state` needs `OPERATOR_MODULE1_COMMIT`, the public key file of the use case, and a fresh `running-images.json` in the state folder.

### First key setup and recovery

Verify that the use case has no prior key setup. Keep a separate state folder for each use case. Restore the public key files of any earlier use cases before you continue.
The key folder of this use case must be empty. The shared key folder can hold only keys that match the earlier public key files. An unrecorded entry is a reason to stop, not a reason to make new keys.

1. Preview with `node --import tsx scripts/operator/cli.ts keys run --initialize`. A dry run needs no `GO.json`. You can preview the first wallet with no key files.
2. Get an approval for `keys` only. Set `capUnits` to `0`. Include no irreversible tags or external addresses. Use `unset` for `runWallet` only before the first wallet exists. For a later use case, use the address in the verified public key files.
3. Run `node --import tsx scripts/operator/cli.ts keys run --initialize --submit`. The task writes `keys-initialized.json` in the state folder before it makes any key files.

Do not use `--initialize` to repair or replace keys. If setup stops after it writes the marker, keep the marker and all key files. Restore the original public key file and any missing original key files from verified backups. Then run `keys run --submit` without `--initialize`. If no valid backup exists or you cannot verify custody, stop and reconcile custody outside this task. Do not remove the marker or start again in a new state folder.

For a use case with a valid `keys-public.json`, run `keys run --submit` without `--initialize`. The task checks the keys and writes `keys-public.<use case>.json`. It keeps the original file.

## The order of the work

The work of a use case goes in this order. A task that has a dry run shows its step first.

1. `keys` makes the keys and prints the address of the run wallet. The owner of the funds sends units to that address. No task does it.
2. `fund` sends the collateral output and the float to each wallet. `fund` with `--member` sends units to a member, one label at a time.
3. `register` makes the records. A dry run prints the DID and the TXT value of each organisation. The operator publishes the value. Before it signs, `register --submit` checks the exact TXT value at Cloudflare, Google and Quad9. It uses authenticated HTTP/2 on port 443 for each resolver. The check stops if any resolver does not show the value. Then `register` waits for the gateway to verify the organisation. A record of a subagent follows the record of its parent.
4. `stake` makes the stake of each agent.
5. `env` makes the env files. The agent services start with them. The start is outside the pack.
6. `advert` posts the adverts, after the services run and serve their manifest and before the runtimes start. `env` writes the reference of each advert into the env file of its runtime. The runtimes start then.
7. `attest` with `--record` writes the documents. The documents are published outside the pack. `attest` then issues the attestations, and waits until the gateway lists them.
   When the use case has compliance subjects, `compliance` prepares their documents. Publish the documents before issuing the attestations. A revoke or a reply is a separate action.
8. For each run: `claim` stakes the claim of each agent. `allowlist` adds the key hash of a principal. `tenant` makes the tenant of the run. `fault` with `--check` shows that no switch is on before the first hire of a clean run, and again after the last hire. `fault` with `--set` turns a fault on and off for a failure run.
9. In a failure run: `hold` puts a hold on the agent and lifts it, `delegations` shows which delegation keys are in use, and `probe` shows what the gateway answers under a delegation, before and after the hirer ends it.
10. After a run: `evidence` writes the evidence file. `claim` with `cleanup` withdraws the claims after their window.
11. `results` writes the private page from the evidence files.
12. `end-state` checks the end state.

## The files

The keys folder is the setting `OPERATOR_KEYS_DIR`.

- `<keys>/shared/<name>.seed` is a key that several use cases share. `<keys>/<use case>/<name>.seed` is a key of one use case. A file holds 64 lower-case hex characters and one newline. The folders have mode 700 and the files mode 600. No task replaces a key file.
- `<keys>/keys-public.<use case>.json` lists the public part of each key: its name, scope, purpose, public key, key hash and address. It holds no secret. The task also checks the earlier `keys-public.json` if it exists.

The state folder is the setting `OPERATOR_STATE_DIR`. It has mode 700.

- `GO.json` is the approval of one session (the setting `OPERATOR_GO_FILE` gives another path). It holds `approvedBy`, `at`, `session`, `runWallet`, `capUnits`, `tasks`, `irreversible`, `expiresAt` and, for a transfer to a member, `external`: the only addresses outside the registry that may get funds, with the units of each. It has mode 600.
- `--submit` refuses when the approval is missing, damaged or expired, when `runWallet` is not the address of the run key, when the task is not in `tasks`, when a step carries a tag that `irreversible` does not list (`record`, `stake` or `attestation`), or when the cap would be passed. The cap is the cumulative net outflow of the keys of the pack in the session. A transfer between two wallets of the pack counts only its fee, and a transfer to an external address counts in full.
- `exposure.<session>.json` keeps what the session has reserved against the cap. The pack reserves the outflow of a transaction when it writes the transaction as in flight, before the submit. It gives the reserve back for a transaction that can no longer land.
- `<task>.state.json` is the state of a task: its confirmed steps, the one transaction in flight, and notes. `<task>.evidence.json` is its evidence: confirmed, verified, info, refused and tool refused entries. A task that takes `--run` uses `<task>.<label>.state.json` and `<task>.<label>.evidence.json`. Both files have mode 600, and the pack writes each whole through a temporary file.
- `facts.json` keeps what one task found out and a later task needs: `records`, `organisations`, `stakes`, `adverts`, `manifests`, `attestations`, `claims`, `tenants`, `holds` and `deploy`. It holds public values only. A fact is set once, and another value is an error unless the call replaces the fact.
- `keys-initialized.json` records that key setup started for this use case and network. It holds no keys. Keep it with the state when you restore files.
- `run.lock` is the run lock file.
- `seen-services.json` and `running-images.json` come from the script that starts the container. It writes both before every run, from the running containers, and the pack refuses a file that is more than 10 minutes old. `seen-services.json` holds `generated_at` and, for each service, its name, its kind, its container, its start time and the value of `FAULT_MODE`. `running-images.json` holds `generated_at` and `images`: for each running container, its image pinned by the digest of the image index. An empty `images` object means that no container runs.
- `attestation-documents/` holds the documents of `attest` with `--record`. `trial/` holds the documents of `claim` with `--trial`. `evidence/` holds the evidence files of `evidence`, and `evidence/private/` its private files. `results/` holds the page of `results`.
- `runs/<label>.json` is the run record that `evidence` reads. `runs/<label>/` holds one report file for each hire of the run.

The agents folder is the setting `OPERATOR_AGENTS_DIR`. It holds the folder of each agent: the env files that `env`, `allowlist` and `fault` write, and the examples that `env` makes them from.

The mock env file is the setting `OPERATOR_MOCK_ENV_FILE`. Only `tenant` reads it. The token of the mock service stays in one local variable of that task and goes into one header.

The image holds no key and no docker client. The caller starts it with `docker run --rm` and mounts what the task needs: the keys folder (read-only, except for `keys`), the state folder, the agent folders (for `env`, `allowlist` and `fault` only) and the mock env file (for `tenant` only).

## The settings

The settings are read from the environment. One refusal lists every problem, and it never shows a value.

| Setting | Meaning |
|---|---|
| `OPERATOR_USE_CASE` | The use case. The default is `inventory-reorder`. |
| `OPERATOR_KEYS_DIR` | The keys folder. It must exist. Required. |
| `OPERATOR_STATE_DIR` | The state folder. Required. It must have mode 700, and the pack makes it with that mode when it is missing. |
| `OPERATOR_AGENTS_DIR` | The folder that holds the folder of each agent. The default is `/agents`. |
| `OPERATOR_GO_FILE` | The approval file. The default is `GO.json` in the state folder. |
| `OPERATOR_MOCK_ENV_FILE` | The env file of the mock systems. Only `tenant` reads it. |
| `OPERATOR_CONTACT` | The contact that `env` writes into the env files. One line. The operator types it, and no file of the repository holds it. |
| `OPERATOR_MODULE1_COMMIT` | The commit of the Module-1 manifest, 40 lower-case hex characters. `claim`, `env` and `end-state` read it. |
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

- It never prints, logs or returns a key or a token. The screen, the errors, the state file, the evidence file, the facts file and the machine line hold names, hashes, addresses and public values only. The one function that gives a seed serves `env`, which writes it into the one line of the one file that the data names.
- It never signs a transaction without an approval. A `--submit` of a task that moves funds or makes a permanent record refuses when the approval file is missing, expired or too narrow.
- It never signs a transaction that a guard refuses. The guards check the signers, the destinations, the fee, the outflow, the mint, the collateral and the inputs of each transaction against the plan of its step.
- It never moves funds to an address that is not a wallet of its registry or an address that the approval names.
- It never replaces a key file, and it never overwrites a value in an env file.
