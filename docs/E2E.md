# End-to-end runbook: our own hire of a service agent

Before any working-group member is invited, the operator hires each of our agents itself, through the same tools a member will use. Agent History comes first, and Document Pipeline follows (see "Hiring Document Pipeline"). Every run in this runbook is first-party: the buyer key is held by the operator, and so is the supplier. A first-party run shows that the path works. It is not ignition, it is not demand, and it counts as no revenue.

**Status: DEPLOYED.** Agent History is DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15. The path is proven first-party, which is not demand. Document Pipeline is DEPLOYED (registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16). Since 2026-10-16. The script `scripts/e2e-hire.mjs` is written and is tested against fake servers. The nine marketplace tools are merged into `main` of Apex-Fusion/mcp-server and are on the hosted mainnet server as of 2026-10-14: an MCP `initialize` and `tools/list` handshake that day listed 33 tools, the nine among them. The current Agent History advert was posted on 2026-10-15, reference `b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0`. The first first-party run settled on 2026-10-15 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip. Against the hosted mainnet server the script now passes its first check, the tool list of the builder. The check that `ADVERT_REF` is among the free suppliers can pass with that reference: the marketplace indexer lists the advert as Active and free as of 2026-10-15. The current Document Pipeline advert was posted on 2026-10-16, reference `16a5da8726cab90949da2c0c92e025af276027715a5d854861c683d7d9341ca3#0`. Its first first-party run settled on 2026-10-16 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip. The marketplace indexer lists the current advert as Active and free as of 2026-10-16.

## What the script needs

| Setting | Meaning |
|---|---|
| `BUILDER_URL` | The MCP endpoint of a builder that has the nine marketplace tools. Default: `https://mcp.vector.mainnet.apexfusion.org/mcp`, which has them as of 2026-10-14. The default works, so you need not set `BUILDER_URL`. The local build is the fallback for a builder that lacks the tools: build `main` of Apex-Fusion/mcp-server and run it locally with `PORT=3300 node packages/builder/build/index.js`, then set `BUILDER_URL=http://localhost:3300/mcp`. The hosted testnet instance lists the same tools, but it reads the mainnet marketplace indexer with the testnet Koios, so it is not a builder for a mainnet run. |
| `SIGNER_ENTRY` | The path of the signer's `build/index.js`, from the published package or from a build of `packages/signer` in an `mcp-server` checkout (`npm ci && npm run build`); see "The commands". The script starts that file as a child process, so it needs the file, not an `npx` command. |
| `VECTOR_SIGNER_PRIVATE_KEY`, `VECTOR_SIGNER_ADDRESS` | The test buyer key and its address, in the environment of the shell that runs the script. `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` and `VECTOR_SIGNER_SPEND_LIMIT_DAILY` go the same way. The script forwards every `VECTOR_SIGNER_` setting to the signer process it starts. The SDK adds its own short list of default variables, such as `PATH` and `HOME`, and nothing else of the shell goes along. The script never prints or stores the value of a setting. The script learns the buyer address only from the signer's own tool. |
| `ADVERT_REF` | The advert to hire, `<txid>#<index>`: Agent History's, or the advert of the agent that `CAPABILITY_ID` names. It must be among the free suppliers of `CAPABILITY_ID`, or the script stops. |
| `CAPABILITY_ID` | The capability of the advert, as the marketplace lists it. Default: `identity.history.report.v1`, the capability of Agent History. The script asks the marketplace for the free suppliers of this capability and stops unless `ADVERT_REF` is among them, so an advert of another agent needs its own value: `document.pipeline.ocr-summary.v1` for Document Pipeline. An empty value, or one with a space in it, stops the script with exit code 2. |
| `PAYLOAD` | The request JSON. Default: the ChandraOCR subject used in the guide. For Document Pipeline, a request for one page of a PDF by URL, as under "Hiring Document Pipeline". |
| `E2E_STATE` | The state file. Default: `./e2e-state.json`. It is git-ignored. See below. |
| `E2E_POLL_MS` | The pause between two polls of the job, a positive whole number of milliseconds. Default: 5000. Anything else stops the script with exit code 2. |
| `EXPLORER_URL` | The base of the explorer links in the evidence. Default: `https://explorer.vector.mainnet.apexfusion.org`. |

The buyer key and what it holds. The operator generates the test buyer key on their own machine with the signer's `keygen` command (PR 4, merged into `main` on 2026-10-14; the npx package is published, version 2.0.0, and [HIRE.md](HIRE.md) section 2 has the command), and sends it its collateral and float by hand: one transfer of 5 units alone, which stays untouched as collateral, then a second of 50 as the float. A run of Agent History costs about 3 of the float, and a run of Document Pipeline about 7 (see the cost table in [HIRE.md](HIRE.md)). Run `keygen` in your own terminal, never through the assistant's shell tool: its output goes back into the conversation, so the only copy of the key would reach the model provider. Nobody pastes the key into a chat. No assistant sees it. It sits in the shell that runs the script, and only the signer reads it.

## The commands

Get the signer's `build/index.js` once. From the published package, install it with the dependencies it needs into a folder outside this repository:

```bash
npm install --prefix "$HOME/vector-signer" @apexfusion/vector-mcp-signer@2.0.0
```

If you built `packages/signer` from an `mcp-server` checkout instead, skip this and set `SIGNER_ENTRY` to `<path to mcp-server>/packages/signer/build/index.js`.

Set the settings once per shell. `read -rs` keeps the key out of the shell history:

```bash
export SIGNER_ENTRY="$HOME/vector-signer/node_modules/@apexfusion/vector-mcp-signer/build/index.js"
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

### Running it from a key file

`scripts/run-e2e-from-keyfile.sh KEYFILE [--dry-run]` runs the same script with the buyer key read from a file instead of from the `read -rs` prompt above. `KEYFILE` holds two lines, `VECTOR_SIGNER_PRIVATE_KEY=<key>` and `VECTOR_SIGNER_ADDRESS=<address>`, the `NAME=value` lines that `keygen` prints. The wrapper sources the file into its own environment and never prints it. It accepts a UTF-16 file with its byte-order mark, a UTF-8 file with a byte-order mark, and CRLF line endings, as an editor or PowerShell may leave them. Its messages and the dry run go through a filter that blanks key-shaped strings, a second guard: the script and the signer print no setting. A finished run writes its evidence to `evidence.json` in the repository root, and the state file is the one `E2E_STATE` names (`e2e-state.json` by default), as above. `--dry-run` is the rehearsal described above. `SIGNER_ENTRY` and `ADVERT_REF` come from the environment, as the table says. The wrapper has a default for `ADVERT_REF`, the Agent History advert, and none for `SIGNER_ENTRY`: it stops when `SIGNER_ENTRY` is not set, and with exit code 2 when it names no file. The key file is as secret as the key. Run the wrapper in your own terminal, and keep the file and the key out of any chat.

## Hiring Document Pipeline

The script hires any agent whose advert is among the free suppliers of `CAPABILITY_ID`, with the same steps. Document Pipeline has been advertised since 2026-10-16, and its first first-party run settled that day (see [Results](#results)). A first-party run of it uses these settings in place of the advert and the request of Agent History, in the shell that holds the key. [deploy/host/RUNBOOK-document-pipeline.md](../deploy/host/RUNBOOK-document-pipeline.md) step 15 is the operator's order of work.

```bash
export CAPABILITY_ID=document.pipeline.ocr-summary.v1
export ADVERT_REF=<txid>#<index>
export PAYLOAD='{"source":{"url":"<https URL of a one-page public PDF>"},"task":"summary","language":"en","max_pages":1}'
export E2E_POLL_MS=15000
export E2E_STATE=./e2e-state-pipeline.json
```

- `CAPABILITY_ID` is the capability of the Pipeline's advert. Without it the script looks for the advert among the free suppliers of Agent History's capability and stops before it posts anything.
- `PAYLOAD` is the request JSON for one page of a public PDF. Use a document that anyone may read: its page goes to the OCR agent, and Datalab behind it, and its text to the chat supplier and that supplier's model provider.
- `E2E_POLL_MS=15000`: a job takes minutes where Agent History's takes seconds, and the default pause of 5 s would ask the hosted server about 120 times in 10 minutes.
- `E2E_STATE=./e2e-state-pipeline.json`: a state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of the Agent History run.
- Expect up to 10 minutes for one page. The script polls until `deliver_by`, which is 33 minutes after the Post (the 30 min window and 180 s). Five pages take up to 27 min.

Then run the rehearsal and the run as above. With the key-file wrapper, export these settings in the shell first: it passes the environment on, and its default `ADVERT_REF` is the Agent History advert. The `capability_id` of the evidence is the Pipeline's, and its `result` is the bundle of the Pipeline as JSON text, which the receipt check takes untouched, as for Agent History. Add the run to the Results table with Document Pipeline in the Agent column. It is first-party and it is not demand.

## Hiring Audio Snippets

Audio Snippets is built and has no advert: its runbook, [deploy/host/RUNBOOK-audio-snippets.md](../deploy/host/RUNBOOK-audio-snippets.md), posts one in step 12 and makes this run in step 15. A first-party run of it uses these settings in place of the advert and the request of Agent History, in the shell that holds the key.

```bash
export CAPABILITY_ID=audio.transcript.snippets.v1
export ADVERT_REF=<txid>#<index>
export PAYLOAD='{"source":{"url":"<https URL of a short public-domain mp3>"},"language":"en","quotes":["All LibriVox recordings are in the public domain."]}'
export E2E_POLL_MS=10000
export E2E_STATE=./e2e-state-snippets.json
```

- `CAPABILITY_ID` is the capability of the advert of Audio Snippets. Without it the script looks for the advert among the free suppliers of Agent History's capability and stops before it posts anything.
- `PAYLOAD` is the request JSON for a short public-domain recording. A LibriVox recording says that sentence in its preamble, so the run shows a match. The service fetches the URL itself and refuses a redirect: a download link of archive.org redirects to the server that holds the file, so give the address it redirects to. The request asks for no clips, so that the answer stays under the 1000000 bytes the hosted server reads of it.
- `E2E_POLL_MS=10000`: a job can take far longer than the seconds of Agent History's, up to the 25 min window, and the default pause of 5 s would ask the hosted server about 300 times in 25 minutes.
- `E2E_STATE=./e2e-state-snippets.json`: a state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of an earlier run.
- The script polls until `deliver_by`, which is 28 minutes after the Post (the 25 min window and 180 s).

Then run the rehearsal and the run as above, and add the run to the Results table with Audio Snippets in the Agent column. It is first-party and it is not demand.

## What the script does

1. Connects to the builder and the signer and lists the tools of both. It stops with exit code 3 and names what is missing. It needs the nine marketplace tools, `vector_submit_transaction` and `vector_await_transaction` on the builder, and `vector_signer_get_address` and `vector_signer_sign` on the signer. All nine marketplace tools are required, because a hire without the reclaim tool can strand the lock of an escrow. Every argument it sends is checked against the schema the tool publishes: an argument the server would drop without a word, or one the server requires and the script does not send, stops the run instead. A fresh run holds every call it will make against those schemas before it builds the first transaction, so a tool whose arguments have changed stops the run before any value moves.
2. Reads the buyer address with `vector_signer_get_address`.
3. Reads the free suppliers of `CAPABILITY_ID` (default `identity.history.report.v1`) with `vector_marketplace_list_suppliers`, and stops unless `ADVERT_REF` is among them. It asks before the job is sent. Once the job is sent the supplier works for us and shows as busy, so a rerun does not ask again.
4. Posts the escrow: `vector_build_marketplace_post_escrow`, then `vector_signer_sign`, `vector_submit_transaction` and `vector_await_transaction`. It checks that the signer signed the transaction the builder built, and that the ledger took the same transaction. The hosted server sits behind a proxy that cuts a call near 100 s, so it asks `vector_await_transaction` to wait 90 s at a time, up to four times.
5. Sends the job with `vector_marketplace_send_job`. It writes `job.sending` to the state file before the call and replaces it with `job_id` when the answer arrives. It polls `vector_marketplace_get_job` until the job is done, has failed, or `deliver_by` has passed. The send and every poll pass the signer's address as `buyerAddress`, because the tools take only the wallet that posted the escrow and locked its value.
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

A run leaves the escrow reference, the receipt with its signature, the report it covers, and the Accept transaction, with the post transaction beside them. That is the evidence recorded below. It shows that a buyer holding only a key and the tools can hire the agent, verify the work and settle. It is first-party evidence. Ignition is the first fill from a control-independent buyer, a buyer outside our control. One fill is not a market, and a first-party run is never counted as demand or revenue. This runbook records first-party runs only, until a control-independent buyer appears.

## If a run stops

| What you see | Meaning | Next step |
|---|---|---|
| Exit code 1 | A step failed. The last lines name it. | Read the message. If a transaction was not confirmed, run the script again: it waits for the same transaction. If the job failed or `deliver_by` passed, check where the escrow stands before you reclaim anything: the job tool does not know, and the supplier's Submit may still land. `vector_build_marketplace_accept` builds only for a Submitted escrow and prints `seconds_left`. If it builds, accept within 600 s of the Submit, because after that the supplier may Release and keep everything that is locked, and a Submitted escrow cannot be reclaimed. Reclaim with `vector_build_marketplace_reclaim`, after `deliver_by`, only an escrow that is Open or Claimed. If the receipt did not verify, keep the state file and the output. A verdict of `incomplete` means that a row was skipped, for example because the ledger had not yet caught up with the supplier's Submit: it counts as neither a failure nor a pass, so run the check again by hand. |
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

Add one row for each run. The Agent column names the agent that was hired, and the Run column says first-party in every row.

| Date | Agent | Run | Escrow reference | Post transaction | Accept transaction | Verdict |
|---|---|---|---|---|---|---|
| 2026-10-15 | Agent History | first-party | `5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765#0` | [`5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765) | [`902df222e6e1ab76d2d7f1085963b4dbf3a9b4b88353b82481c57a92fbc5c03c`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/902df222e6e1ab76d2d7f1085963b4dbf3a9b4b88353b82481c57a92fbc5c03c) | VERIFIED |
| 2026-10-16 | Document Pipeline | first-party | `4a86037e68c497f94d1e16b8a97a43f756b3611f428809b284b5295e5916acd5#0` | [`4a86037e68c497f94d1e16b8a97a43f756b3611f428809b284b5295e5916acd5`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/4a86037e68c497f94d1e16b8a97a43f756b3611f428809b284b5295e5916acd5) | [`b9cc53fbfd1e6c0a6c624f4ce6f9a4868d16b5380fe5c3b259e6e663a4638ead`](https://explorer.vector.mainnet.apexfusion.org/transaction/hash/b9cc53fbfd1e6c0a6c624f4ce6f9a4868d16b5380fe5c3b259e6e663a4638ead) | VERIFIED |

The evidence of the Agent History run is [docs/evidence/2026-10-15-agent-history-run-1.json](evidence/2026-10-15-agent-history-run-1.json), the object the script printed, unchanged. It holds the receipt, its signature, the report text and the links, and no key. To repeat the check, call `vector_marketplace_verify_receipt` with `receipt`, `receipt_signature`, `escrow_ref` and the untouched `result` from that file: read the file with a JSON parser and pass `result` as it decodes. The check needs no key and no units. Both keys were ours. A first-party run shows that the path works. It is not demand.

The evidence of the Document Pipeline run is [docs/evidence/2026-10-16-document-pipeline-run-1.json](evidence/2026-10-16-document-pipeline-run-1.json), the object the script printed, unchanged. Its `result` is the bundle of the Pipeline as JSON text, and the check is repeated the same way, with the untouched `result`. The run read one page of the public sample PDF at `https://pdfobject.com/pdf/sample.pdf` (task summary, language en) against the first advert, which was retired at the status flip the same day. The supplier's wall clock was 73816 ms. The bundle holds two sub-jobs, one OCR page and one chat job, with 4461720 lovelace locked and 2006660 lovelace in fees, and the stranded store was empty afterwards. Both keys were ours. It is not demand.
