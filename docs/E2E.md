# End-to-end runbook: our own hire of Agent History

Before any working-group member is invited, the operator hires Agent History itself, through the same tools a member will use. Every run in this runbook is first-party: the buyer key is held by the operator, and so is the supplier. A first-party run shows that the path works. It is not ignition, it is not demand, and it counts as no revenue.

**Status: PROPOSED.** The script `scripts/e2e-hire.mjs` is written and is tested against fake servers. It cannot complete a live run today. The nine marketplace tools are merged into `main` of Apex-Fusion/mcp-server (2026-10-14), awaiting the mainnet cutover: the hosted mainnet server still serves 24 tools, none of them a marketplace tool. The cutover is the maintainer's deliberate step and waits for this run. The Agent History advert is not posted and the test buyer key is not funded. Against the hosted mainnet server today the script stops at its first check and names the nine missing tools.

## What the script needs

| Setting | Meaning |
|---|---|
| `BUILDER_URL` | The MCP endpoint of a builder that has the nine marketplace tools. Default: `https://mcp.vector.mainnet.apexfusion.org/mcp`, which has them only after the mainnet cutover. Until then, build `main` of Apex-Fusion/mcp-server and run it locally with `PORT=3300 node packages/builder/build/index.js`, then set `BUILDER_URL=http://localhost:3300/mcp`. The hosted testnet instance lists the same tools, but it reads the mainnet marketplace indexer with the testnet Koios, so it is not a builder for a mainnet run. |
| `SIGNER_ENTRY` | The path of the built signer, `packages/signer/build/index.js` in an `mcp-server` checkout (`npm ci && npm run build`). The script starts it as a child process. |
| `VECTOR_SIGNER_PRIVATE_KEY`, `VECTOR_SIGNER_ADDRESS` | The test buyer key and its address, in the environment of the shell that runs the script. `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` and `VECTOR_SIGNER_SPEND_LIMIT_DAILY` go the same way. The script forwards every `VECTOR_SIGNER_` setting to the signer process it starts. The SDK adds its own short list of default variables, such as `PATH` and `HOME`, and nothing else of the shell goes along. The script never prints or stores the value of a setting. The buyer address comes from the signer's own tool, not from a setting. |
| `ADVERT_REF` | The Agent History advert, `<txid>#<index>`. It must be among the free suppliers of `identity.history.report.v1`, or the script stops. |
| `PAYLOAD` | The request JSON. Default: the ChandraOCR subject used in the guide. |
| `E2E_STATE` | The state file. Default: `./e2e-state.json`. It is git-ignored. See below. |
| `E2E_POLL_MS` | The pause between two polls of the job, a positive whole number of milliseconds. Default: 5000. Anything else stops the script with exit code 2. |
| `EXPLORER_URL` | The base of the explorer links in the evidence. Default: `https://explorer.vector.mainnet.apexfusion.org`. |

The funded key. The operator generates the test buyer key on their own machine with the signer's `keygen` command (PR 4, merged into `main` on 2026-10-14; the npx package is not published yet), and funds it by hand: one transfer of 5 units alone, which stays untouched as collateral, then a second of 50 as the float. A run of Agent History costs about 3 of the float (see the cost table in [HIRE.md](HIRE.md)). Run `keygen` in your own terminal, never through the assistant's shell tool: its output goes back into the conversation, so the only copy of the key would reach the model provider. Nobody pastes the key into a chat. No assistant sees it. It sits in the shell that runs the script, and only the signer reads it.

## The commands

Set the settings once per shell. `read -rs` keeps the key out of the shell history:

```bash
export SIGNER_ENTRY=<path to mcp-server>/packages/signer/build/index.js
export ADVERT_REF=<txid>#<index>
export VECTOR_SIGNER_ADDRESS=<the address of the test buyer key>
read -rs VECTOR_SIGNER_PRIVATE_KEY && export VECTOR_SIGNER_PRIVATE_KEY
```

First a rehearsal. It checks both tool lists, reads the signer's address and the advert, checks the arguments of every call against the schemas the tools publish, and prints every call. It signs, submits and sends nothing, and writes no state:

```bash
node scripts/e2e-hire.mjs --dry-run
```

Then the run. `pnpm e2e` does the same:

```bash
node scripts/e2e-hire.mjs
```

`--dry-run` is the only argument the script takes. Anything else stops it with exit code 2 and the usage line. The steps go to stderr. The evidence of a finished run is one JSON object on stdout, so `node scripts/e2e-hire.mjs > evidence.json` keeps it apart.

## What the script does

1. Connects to the builder and the signer and lists the tools of both. It stops with exit code 3 and names what is missing. It needs the nine marketplace tools, `vector_submit_transaction` and `vector_await_transaction` on the builder, and `vector_signer_get_address` and `vector_signer_sign` on the signer. All nine marketplace tools are required, because a hire without the reclaim tool can strand funds. Every argument it sends is checked against the schema the tool publishes: an argument the server would drop without a word, or one the server requires and the script does not send, stops the run instead. A fresh run holds every call it will make against those schemas before it builds the first transaction, so a tool whose arguments have changed stops the run before any money moves.
2. Reads the buyer address with `vector_signer_get_address`.
3. Reads the free suppliers of `identity.history.report.v1` with `vector_marketplace_list_suppliers`, and stops unless `ADVERT_REF` is among them. It asks before the job is sent. Once the job is sent the supplier works for us and shows as busy, so a rerun does not ask again.
4. Posts the escrow: `vector_build_marketplace_post_escrow`, then `vector_signer_sign`, `vector_submit_transaction` and `vector_await_transaction`. It checks that the signer signed the transaction the builder built, and that the ledger took the same transaction. The hosted server sits behind a proxy that cuts a call near 100 s, so it asks `vector_await_transaction` to wait 90 s at a time, up to four times.
5. Sends the job with `vector_marketplace_send_job`. It writes `job.sending` to the state file before the call and replaces it with `job_id` when the answer arrives. It polls `vector_marketplace_get_job` until the job is done, has failed, or `deliver_by` has passed. The send and every poll pass the signer's address as `buyerAddress`, because the tools take only the wallet that posted and funded the escrow.
6. Verifies the receipt with `vector_marketplace_verify_receipt`, passing the report text with it: without the report text check 2 is skipped, and a skipped row makes the verdict `incomplete`, never a pass. The job can be done a moment before the ledger shows the supplier's Submit, and check 5 reads the ledger, so it tries up to six times. It goes on only if the verdict is `verified`, which needs the five checks and the extra `prompt_hash` row to pass. Otherwise it stops and says it is not accepting. Declining does not refund: once the supplier has submitted, the supplier may Release after 600000 ms.
7. Accepts: `vector_build_marketplace_accept`, then sign, submit and wait. The accept window is 600000 ms after the supplier's Submit.
8. Prints the evidence.

Every step can be repeated except one. The script writes `E2E_STATE` after each step, through a temporary file that it renames, so a kill never leaves half a file. A transaction is built and signed once, and the signed bytes are written down before they are submitted, so a rerun submits the same transaction again and waits for it, and never posts a second escrow. A state file belongs to one run, meaning one advert, one payload and one signer address. The script refuses a state file that belongs to another. Move the file away to start a new run. A finished run is reported again from the state file without a call to the builder. The state file holds escrow references, transaction hashes, signed transactions and the report text. It holds no key.

The exception is the send. The job id exists only in the answer to `vector_marketplace_send_job`, and a second send for an escrow that the supplier has already claimed is refused with 409. So the state says `job.sending` before the call, and `job_id` once the answer is in. If a run is killed, or the call gives no answer, in between, the next run finds `job.sending` without a `job_id`. It sends nothing and stops with exit code 1, see [If the send step was interrupted](#if-the-send-step-was-interrupted). A send that the tool reports as failed is a known outcome, because the escrow is still Open. The script removes the marker itself, and the next run tries the send again.

## What a pass looks like

- The exit code is 0 and stdout holds one JSON object.
- `run` is `first-party` and `verdict` is `VERIFIED`.
- The object has `escrow_ref`, `post_tx`, `accept_tx`, the two explorer links, the `receipt`, the `receipt_signature`, the report text `result` and `result_sha256`, the sha256 of that text.
- Both explorer links open on the transactions, and the escrow output is spent by the Accept.
- Running `vector_marketplace_verify_receipt` again by hand, with `receipt`, `receipt_signature`, `escrow_ref` and `result` from the object, gives the same verdict. `result` is also `job.result` in the state file. Pass it untouched. A call without it skips the `response_hash` check, so the verdict reads `incomplete`, and a copy that was re-formatted or shortened fails it.

## What a run is evidence of

A run leaves the escrow reference, the receipt with its signature, the report it covers, and the Accept transaction, with the post transaction beside them. That is the evidence recorded below. It shows that a buyer holding only a key and the tools can hire the agent, verify the work and settle. It is first-party evidence. Ignition is the first fill from a control-independent payer, a payer outside our control. One fill is not a market, and a first-party run is never counted as demand or revenue. This runbook records first-party runs only, until a control-independent payer appears.

## If a run stops

| What you see | Meaning | Next step |
|---|---|---|
| Exit code 1 | A step failed. The last lines name it. | Read the message. If a transaction was not confirmed, run the script again: it waits for the same transaction. If the job failed or `deliver_by` passed, check where the escrow stands before you reclaim anything: the job tool does not know, and the supplier's Submit may still land. `vector_build_marketplace_accept` builds only for a Submitted escrow and prints `seconds_left`. If it builds, accept within 600 s of the Submit, because after that the supplier may Release and keep everything that is locked, and a Submitted escrow cannot be reclaimed. Reclaim with `vector_build_marketplace_reclaim`, after `deliver_by`, only an escrow that is Open or Claimed. If the receipt did not verify, keep the state file and the output. A verdict of `incomplete` is not a failure and not a pass: a row was skipped, for example because the ledger had not yet caught up with the supplier's Submit, so run the check again by hand. |
| Exit code 1, and the message starts "an earlier run called vector_marketplace_send_job" | The send step was interrupted, and the supplier may have claimed the escrow. | Do not send again. Follow the steps below. |
| Exit code 1, "is not among the free suppliers", after an earlier run already posted the escrow | The advert is busy, retired or no longer listed. When the message says the earlier run posted the escrow, that escrow is still Open: nothing was sent to the supplier. When it says the confirmation was never recorded, the escrow may not be on the ledger. | Reclaim an Open escrow with `vector_build_marketplace_reclaim` after `deliver_by` (the state file holds both), then move the state file away and start a new run. If the confirmation was never recorded, look the post transaction up on the explorer first. If it is there, the escrow is Open and the same steps apply. If it is not there, nothing was posted: move the state file away and start a new run, but not while the transaction can still land, because the escrow it posts would be known only to the ledger (the way back is the indexer rows of the buyer key and a reclaim after `deliver_by`). While the advert is not free, running the script again stops at the same check. |
| Exit code 1, and the same transaction is reported as not confirmed on every rerun | The state file keeps the signed bytes of each step, and every rerun submits that same transaction again. A transaction that can never land (an input it spends was used by another transaction, or its validity window has passed) is therefore retried on every rerun. | Look up the transaction hash from the output on the explorer. If it is there after a few minutes, the run was only slow: run the script again. If it is not there, nothing was posted: move the state file away (`mv e2e-state.json e2e-state.old.json`, or the file named by `E2E_STATE`) and start a new run. Do not move it while the transaction can still land: the escrow it posts would be known only to the ledger, and the way back is the indexer rows of the buyer key and a reclaim after `deliver_by`. |
| Exit code 2 | A setting is missing or malformed, an argument other than `--dry-run` was given, or the state file is not a JSON object. | Fix it, see the table above. Repair a damaged state file by hand. If it is lost, the escrow is still on the ledger: find it through the indexer rows of the buyer key, and check where it stands before you reclaim anything, as in the first row of this table: `vector_build_marketplace_accept` builds only for a Submitted escrow and prints `seconds_left`. If it is Submitted, accept within 600 s of the Submit, because after that the supplier may Release and keep everything that is locked, and a Submitted escrow cannot be reclaimed. If it is Open or Claimed, reclaim it with `vector_build_marketplace_reclaim` after `deliver_by`. Do this before you start a new run. |
| Exit code 3 | The builder or the signer lacks tools. | Use a builder that has the nine marketplace tools. |
| The check by hand says `response_hash` fails | The text that was checked is not the exact string the supplier returned. An assistant that re-serialises, re-formats or truncates the report changes its hash. | Pass `result` from the evidence, or `job.result` from the state file, byte for byte. Run the check from a script, or paste the text unchanged. |

Keep the state file until the Accept is confirmed. Besides the ledger it is the only record of the escrow reference.

## If the send step was interrupted

The message says "an earlier run called vector_marketplace_send_job and recorded no job id". The supplier may have claimed the escrow. The supplier's runtime has no route that finds a job from its escrow, so the job id cannot be asked for again. Do not delete `sending` and send again: a second send is refused with 409.

1. Look for the job id in the output of the interrupted run. It is under `== vector_marketplace_send_job`, in the JSON block as `jobId` (or `job_id`). If you have it, add `"job_id": "<the id>"` to the `job` section of the state file, delete the `sending` line, and run the script again. It goes on with the poll. The runtime keeps a finished job in memory for 600000 ms, so do this soon.
2. If the id is lost, look at the escrow. `vector_marketplace_get_supplier` for the advert shows the supplier's status, and busy means a job is running. The marketplace indexer keeps one row for each version of an escrow, because a Claim and a Submit each create a new output, and the versions of one job share `posted_at`. Read the escrow you posted with `GET https://mp-indexer.vector.apexfusion.org/escrows/<escrow_ref>`, where `<escrow_ref>` is `post.escrow_ref` in the state file and the `#` is written as `%23`. It answers with that one row, and its `posted_at` names the job. Then `GET https://mp-indexer.vector.apexfusion.org/escrows?buyer=<buyer key hash>` lists the versions: among the rows with that `posted_at`, the furthest `state` (Submitted, then Claimed, then Open) is where the escrow stands.
   - Open or Claimed: wait for `deliver_by`, which is in the state file, reclaim the escrow with `vector_build_marketplace_reclaim`, move the state file away and start a new run.
   - Submitted: the supplier has finished, and the report cannot be read without the id, so this run is not evidence. The escrow is first-party, so close it with `vector_build_marketplace_accept` while the 600000 ms window is open: your bond of 1 comes back, and a Release would hand it to the supplier. If the accept tool refuses with `No live continuation of escrow <escrow reference> found (spent, or not yet indexed); retry or check the explorer.`, wait a minute and ask once more, because the indexer can lag the ledger. If it refuses again, the escrow is spent and the supplier has most likely released it: look at the escrow on the explorer. Then move the state file away and start a new run.

Neither case is evidence. Only a run that ends in the printed evidence counts.

## Results

Add one row for each run. The Run column says first-party in every row.

| Date | Run | Escrow reference | Post transaction | Accept transaction | Verdict |
|---|---|---|---|---|---|
| none yet | first-party | | | | not run |
