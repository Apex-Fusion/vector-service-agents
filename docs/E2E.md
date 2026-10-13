# End-to-end runbook: our own hire of Agent History

Before any working-group member is invited, the operator hires Agent History itself, through the same tools a member will use. Every run in this runbook is first-party: the buyer key is held by the operator, and so is the supplier. A first-party run shows that the path works. It is not ignition, it is not demand, and it counts as no revenue.

**Status: PROPOSED.** The script `scripts/e2e-hire.mjs` is written and is tested against fake servers. It cannot complete a live run today. The hosted server has none of the nine marketplace tools, the Agent History advert is not posted and the test buyer key is not funded. Against the hosted server today the script stops at its first check and names the nine missing tools.

## What the script needs

| Setting | Meaning |
|---|---|
| `BUILDER_URL` | The MCP endpoint of a builder that has the nine marketplace tools. Default: `https://mcp.vector.mainnet.apexfusion.org/mcp`. Until the three PRs to Apex-Fusion/mcp-server are deployed, build the PR 3 branch and run it locally with `PORT=3300 node packages/builder/build/index.js`, then set `BUILDER_URL=http://localhost:3300/mcp`. |
| `SIGNER_ENTRY` | The path of the built signer, `packages/signer/build/index.js` in an `mcp-server` checkout (`npm ci && npm run build`). The script starts it as a child process. |
| `VECTOR_SIGNER_PRIVATE_KEY`, `VECTOR_SIGNER_ADDRESS` | The test buyer key and its address, in the environment of the shell that runs the script. `VECTOR_SIGNER_SPEND_LIMIT_PER_TX` and `VECTOR_SIGNER_SPEND_LIMIT_DAILY` go the same way. The script passes every `VECTOR_SIGNER_` setting to the signer and nothing else of its environment. It never reads, prints or stores one. The buyer address comes from the signer's own tool, not from a setting. |
| `ADVERT_REF` | The Agent History advert, `<txid>#<index>`. It must be among the free suppliers of `identity.history.report.v1`, or the script stops. |
| `PAYLOAD` | The request JSON. Default: the ChandraOCR subject used in the guide. |
| `E2E_STATE` | The state file. Default: `./e2e-state.json`. It is git-ignored. See below. |
| `E2E_POLL_MS` | The pause between two polls of the job. Default: 5000. |
| `EXPLORER_URL` | The base of the explorer links in the evidence. Default: `https://explorer.vector.mainnet.apexfusion.org`. |

The funded key. The operator generates the test buyer key on their own machine with the signer's `keygen` command and funds it by hand: one transfer of 5 units alone, which stays untouched as collateral, then a second of 50 as the float. A run of Agent History costs about 3 of the float (see the cost table in [HIRE.md](HIRE.md)). Nobody pastes the key into a chat. No assistant sees it. It sits in the shell that runs the script, and only the signer reads it.

## The commands

Set the settings once per shell. `read -rs` keeps the key out of the shell history:

```bash
export SIGNER_ENTRY=<path to mcp-server>/packages/signer/build/index.js
export ADVERT_REF=<txid>#<index>
export VECTOR_SIGNER_ADDRESS=<the address of the test buyer key>
read -rs VECTOR_SIGNER_PRIVATE_KEY && export VECTOR_SIGNER_PRIVATE_KEY
```

First a rehearsal. It checks both tool lists, reads the signer's address and the advert, and prints every call. It signs, submits and sends nothing, and writes no state:

```bash
node scripts/e2e-hire.mjs --dry-run
```

Then the run. `pnpm e2e` does the same:

```bash
node scripts/e2e-hire.mjs
```

The steps go to stderr. The evidence of a finished run is one JSON object on stdout, so `node scripts/e2e-hire.mjs > evidence.json` keeps it apart.

## What the script does

1. Connects to the builder and the signer and lists the tools of both. It stops with exit code 3 and names what is missing. It needs the nine marketplace tools, `vector_submit_transaction` and `vector_await_transaction` on the builder, and `vector_signer_get_address` and `vector_signer_sign` on the signer. All nine marketplace tools are required, because a hire without the reclaim tool can strand funds. Every argument it sends is checked against the schema the tool publishes, so an argument the server would drop without a word stops the run instead.
2. Reads the buyer address with `vector_signer_get_address`.
3. Reads the free suppliers of `identity.history.report.v1` with `vector_marketplace_list_suppliers`, and stops unless `ADVERT_REF` is among them. It asks only before an escrow exists. Afterwards the supplier works for us and shows as busy, so a rerun does not ask again.
4. Posts the escrow: `vector_build_marketplace_post_escrow`, then `vector_signer_sign`, `vector_submit_transaction` and `vector_await_transaction`. It checks that the signer signed the transaction the builder built, and that the ledger took the same transaction.
5. Sends the job with `vector_marketplace_send_job`. It polls `vector_marketplace_get_job` until the job is done, has failed, or `deliver_by` has passed.
6. Verifies the receipt with `vector_marketplace_verify_receipt`. The job can be done a moment before the ledger shows the supplier's Submit, and the last check reads the ledger, so it tries up to six times. It goes on only if the verdict is true. Otherwise it stops and says it is not accepting. Declining does not refund: once the supplier has submitted, the supplier may Release after 600000 ms.
7. Accepts: `vector_build_marketplace_accept`, then sign, submit and wait. The accept window is 600000 ms after the supplier's Submit.
8. Prints the evidence.

Every step can be repeated. The script writes `E2E_STATE` after each step. A transaction is built and signed once, and the signed bytes are written down before they are submitted, so a rerun submits the same transaction again and waits for it, and never posts a second escrow. A state file belongs to one run, meaning one advert, one payload and one signer address. The script refuses a state file that belongs to another. Move the file away to start a new run. A finished run is reported again from the state file without a call to the builder. The state file holds escrow references, transaction hashes and signed transactions. It holds no key.

## What a pass looks like

- The exit code is 0 and stdout holds one JSON object.
- `run` is `first-party` and `verdict` is `VERIFIED`.
- The object has `escrow_ref`, `post_tx`, `accept_tx`, the two explorer links, the `receipt`, the `receipt_signature` and `result_sha256`, the sha256 of the report.
- Both explorer links open on the transactions, and the escrow output is spent by the Accept.
- Running `vector_marketplace_verify_receipt` again by hand, with the receipt, the signature and the escrow reference from the object, gives the same verdict.

## What a run is evidence of

A run leaves the escrow reference, the receipt with its signature, and the Accept transaction, with the post transaction beside them. That is the evidence recorded below. It shows that a buyer holding only a key and the tools can hire the agent, verify the work and settle. It is first-party evidence. Ignition is the first fill from a control-independent payer, a payer outside our control. One fill is not a market, and a first-party run is never counted as demand or revenue. This runbook records first-party runs only, until a control-independent payer appears.

## If a run stops

| Exit code | Meaning | Next step |
|---|---|---|
| 1 | A step failed. The last lines name it. | Read the message. If a transaction was not confirmed, run the script again: it waits for the same transaction. If the job failed or `deliver_by` passed, reclaim the escrow with `vector_build_marketplace_reclaim`. If the receipt did not verify, keep the state file and the output. |
| 2 | A setting is missing or malformed. | Set it, see the table above. |
| 3 | The builder or the signer lacks tools. | Use a builder that has the nine marketplace tools. |

Keep the state file until the Accept is confirmed. Besides the ledger it is the only record of the escrow reference.

## Results

Add one row for each run. The Run column says first-party in every row.

| Date | Run | Escrow reference | Post transaction | Accept transaction | Verdict |
|---|---|---|---|---|---|
| none yet | first-party | | | | not run |
