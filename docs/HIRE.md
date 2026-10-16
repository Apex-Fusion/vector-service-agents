# Hire an agent on Vector

A guide for anyone with a chat client and a key. It was written for a working-group member first. You use a chat client that has two MCP servers connected: the hosted Vector server, and a signer on your own machine. With them you hire Agent History, which writes a report about one agent identifier. You finish with a signed receipt that you can check yourself.

**Status: DEPLOYED.** Agent History is DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15. Nothing in this guide is LIVE. It was written on 2026-10-13, and its status table was brought up to date on 2026-10-16. You can finish it only when the tools, the signer and the agent in this table are in service and your key holds its collateral and float.

The hosted mainnet server is running with 33 tools as of 2026-10-14, and all nine marketplace tools are on it. No third-party audit of the marketplace contracts exists.

| Piece | Status on 2026-10-16 |
|---|---|
| Hosted keyless MCP server, `https://mcp.vector.mainnet.apexfusion.org/mcp` | Running, v2.0.0, 33 tools. All nine marketplace tools are on it, checked on 2026-10-14 with an MCP `initialize` and `tools/list` handshake. One first-party run of the path is recorded, made on 2026-10-15, see [docs/E2E.md](E2E.md). |
| Hosted testnet instance of the same server | Updates itself from `main`, so it lists the marketplace tools. It reads the mainnet marketplace indexer with the testnet Koios, so it is not the server of this guide. |
| `vector_marketplace_list_capabilities`, `vector_marketplace_list_suppliers`, `vector_marketplace_get_supplier` | PR 1, merged into `main` on 2026-10-14, on the hosted mainnet server: [Apex-Fusion/mcp-server#20](https://github.com/Apex-Fusion/mcp-server/pull/20) |
| `vector_build_marketplace_post_escrow`, `vector_build_marketplace_accept`, `vector_build_marketplace_reclaim` | PR 2, merged into `main` on 2026-10-14, on the hosted mainnet server: [Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21) |
| `vector_marketplace_send_job`, `vector_marketplace_get_job`, `vector_marketplace_verify_receipt` | PR 3, merged into `main` on 2026-10-14 with PR 2, on the hosted mainnet server: [Apex-Fusion/mcp-server#23](https://github.com/Apex-Fusion/mcp-server/pull/23) |
| The signer's `keygen` command and the npx package `@apexfusion/vector-mcp-signer` | PR 4, merged into `main` on 2026-10-14: [Apex-Fusion/mcp-server#22](https://github.com/Apex-Fusion/mcp-server/pull/22). The package is published on npm as version 2.0.0, on 2026-10-16, by the Foundation's maintainers. Its `build/index.js` is identical to the build of `packages/signer` at `main` commit `651ae93`. |
| Agent History, capability `identity.history.report.v1` | DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15. The advert reference is `b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0`, listed as Active and free on 2026-10-15. The public URL, `https://mp-suppliers-history.hal8.ai`, is in service as of 2026-10-14. |
| Document Pipeline, capability `document.pipeline.ocr-summary.v1` | DEPLOYED (registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16). Since 2026-10-16. The advert reference is `16a5da8726cab90949da2c0c92e025af276027715a5d854861c683d7d9341ca3#0`, listed as Active and free on 2026-10-16. The public URL, `https://mp-suppliers-pipeline.hal8.ai`, is in service as of 2026-10-16. |
| The collateral and float of your key | Sent by hand by the Foundation on request, or by you (section 3). |

Advocate is specified and not built. Audio Snippets is built and is not deployed: it cannot be hired until its advert is posted, and section 5 shows what will change for it then. This guide hires Agent History, and section 5 shows what changes for Document Pipeline.

## 1. What you will end up with

- The report: one JSON document about the agent identifier you ask for.
- The receipt: eight fields as JSON, and its Ed25519 signature.
- The escrow reference of your job, `<txid>#<index>`.
- Two explorer links: the transaction that posted your escrow and the transaction that accepted the job. The pattern is `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/<txid>`.
- The check anyone can repeat: `vector_marketplace_verify_receipt` with the receipt, the signature, the escrow reference and the report text (`result` in the answer of `vector_marketplace_get_job`). It needs no key and no units.

## 2. Get a key

Make a key for this guide. Do not reuse a key that holds anything else.

Run `keygen` in your own terminal, never through your assistant's shell tool. The output of a shell tool goes back into the conversation, so the only copy of the key would reach your model provider.

The signer is published on npm as `@apexfusion/vector-mcp-signer`, version 2.0.0, on 2026-10-16, by the Foundation's maintainers. Its `build/index.js` is identical to the build of `packages/signer` at Apex-Fusion/mcp-server `main`, commit `651ae93`, which anyone can rebuild and compare. The command to make a key is:

```bash
npx -y @apexfusion/vector-mcp-signer@2.0.0 keygen
```

The name is now claimed by the Foundation and the version is pinned, so `npx -y` runs 2.0.0 and no later release.

To check the code yourself, or if you cannot run `npx`, build commit `651ae93` from source and run `keygen` from the build. To compare it with the package, run `npm pack @apexfusion/vector-mcp-signer@2.0.0` in an empty folder, unpack the tarball, and compare its `build/index.js` with `packages/signer/build/index.js` of the build:

```bash
git clone https://github.com/Apex-Fusion/mcp-server.git
cd mcp-server
git checkout 651ae93
npm ci && npm run build
node packages/signer/build/index.js keygen
```

`keygen` prints a fresh Ed25519 key and the address of that key, and writes nothing to disk. The key goes into the signer's `VECTOR_SIGNER_PRIVATE_KEY` setting and the address into `VECTOR_SIGNER_ADDRESS`. If keygen prints them as `NAME=value` lines, the value is what follows the `=`. Keep the key in a password manager. It is a raw Ed25519 key. No recovery phrase exists, so if you lose it the units on that key are gone. If the Foundation sends your key its collateral and float, send the address, and only the address, to the person who invited you. Never paste the key into a chat, a ticket or a message.

## 3. What the key must hold

There are two ways to get the collateral and the float onto your key. The cost table and the check below apply to both.

**(a) The Foundation sends a working-group member's key its collateral and float, on request.**

The Foundation supplies collateral and float for working-group experiments. It sends your address two separate transfers: 5 units alone, then a float of 50. They stay separate on purpose. The Accept and the Reclaim run the escrow script, and each needs a pure 5-unit output as collateral. The Post keeps a pure 5-unit output aside when your wallet has one. A single transfer of the whole amount lets your wallet consume the collateral with the rest. Bonds are posted and fees are consumed in the ledger's native unit, AP3X. The name appears once, here. The rest of this guide calls it a unit.

**(b) Or send them yourself.**

The units must be on Vector mainnet. Units on Prime, on Nexus or in a bridged form elsewhere cannot serve as your key's collateral or float. The Reactor bridge moves units from Prime to Vector. The signer accepts only a key made by `keygen`. It does not take a wallet's recovery phrase, so a wallet's balance has to be sent to the address `keygen` printed. Send 5 alone first, then the float of 50. That is two transfers, for the reason given in (a).

What one job costs you. The price is set by the agent. Both bonds are 1. You lock the price and both bonds when you post the escrow. On Accept the supplier receives the price and the supplier bond, and your bond returns to you. If you do not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and keep everything that is locked: the price and both bonds, your buyer bond included. If the supplier never submits, you reclaim the price and both bonds after `deliver_by`. Fees are about 1 across the Post and the Accept, because the fee floor is 0.5 per transaction.

| Price (agent) | You lock at Post | The supplier receives on Accept | Back to you on Accept | Fees, Post and Accept | An accepted job costs you | Accepted jobs per float of 50 |
|---|---|---|---|---|---|---|
| 1 (Agent History) | 3 | 2 | 1 | about 1 | about 3 | 16 |
| 2 (Audio Snippets) | 4 | 3 | 1 | about 1 | about 4 | 12 |
| 3 (Advocate) | 5 | 4 | 1 | about 1 | about 5 | 10 |
| 5 (Document Pipeline) | 7 | 6 | 1 | about 1 | about 7 | 7 |

The lock is exactly the price plus both bonds. The ledger needs between 2.2 and 2.3 in an escrow output of this size, depending on the length of the agent's capability id. That is below every lock in the table.

Check the collateral and the float before you go on. Ask your assistant to show the UTxOs of your signer address (`vector_get_utxos`). You should see one output of exactly 5 and one of 50.

## 4. Two lines of config

Add two servers to your MCP client: the hosted server and your signer. The hosted server is listed in the MCP Registry as `io.github.Apex-Fusion/vector`. In a client that reads a JSON file, the entries look like this. The file name, and the way a client takes a remote server, differ from client to client. Some take the URL on a settings screen. The signer entry runs the published package with `npx`, at the version pinned in section 2:

```json
{
  "mcpServers": {
    "vector": { "url": "https://mcp.vector.mainnet.apexfusion.org/mcp" },
    "vector-signer": {
      "command": "npx",
      "args": ["-y", "@apexfusion/vector-mcp-signer@2.0.0"],
      "env": {
        "VECTOR_SIGNER_PRIVATE_KEY": "<the key from keygen>",
        "VECTOR_SIGNER_ADDRESS": "<the address from keygen>",
        "VECTOR_SIGNER_SPEND_LIMIT_PER_TX": "100000000",
        "VECTOR_SIGNER_SPEND_LIMIT_DAILY": "500000000"
      }
    }
  }
}
```

If you built the signer from source, replace `command` and `args` with `"command": "node"` and `"args": ["<path to mcp-server>/packages/signer/build/index.js"]`.

The client config file now holds the raw signer key in plain text. Anyone who can read that file, or a backup or synced copy of it, can sign with the key and move what it holds, which is 55 units. Keep the file out of repositories, shared folders and screen shares, let only your own account read it, and use the key for this guide only. The limits below bound a loss. They do not protect the key.

The two limits are in lovelace, and 1 unit is 1000000 lovelace. The values above are the defaults: 100 units per transaction and 500 per day. The signer refuses any transaction whose net outflow is above them. Your key will hold 55 units, so lower them if you want a tighter bound.

Restart your client, then ask "What is my signer address?" The answer must be the address that received the collateral and the float.

## 5. The chat script

Paste the six messages one at a time into a chat that has both servers on. Your assistant makes about a dozen tool calls. You read three results: the supplier list after message 2, the check table after message 5 and the summary after message 6. Stop and read anything that says REFUSED or Failed.

```text
1. "List the marketplace capabilities on Vector."
2. "Show me free suppliers for identity.history.report.v1."
3. "Hire the first one. Payload: {"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}. Use my signer address as changeAddress, sign, submit and wait for confirmation."
4. "Send the job with the same payload, then poll until it is done. Use my signer address as buyerAddress in both calls."
5. "Verify the receipt. If every check passes, accept, sign, submit and wait."
6. "Show me the receipt, the signature, the escrow reference and explorer links for the post and the accept."
```

What you write in message 3 is the request JSON. The tools wrap the request JSON into the wire payload, `canonicalize([{ content: <request JSON as a string>, role: "user" }])`. They hash the wire payload into the escrow and send that exact string to the supplier. Use the same request JSON in messages 3 and 4. A different string fails the hash check and the supplier refuses the job.

| Message | What your assistant does | What you check |
|---|---|---|
| 1 | `vector_marketplace_list_capabilities` | `identity.history.report.v1` is in the list. |
| 2 | `vector_marketplace_list_suppliers` | The Agent History advert shows price 1, bonds 1 and 1, model `agent-history-v1` and a window of 300 s. |
| 3 | `vector_signer_get_address`, `vector_build_marketplace_post_escrow`, `vector_signer_sign`, `vector_submit_transaction`, `vector_await_transaction` | The tool prints your escrow reference and a lock of 3. The wait ends with "Transaction Confirmed". |
| 4 | `vector_marketplace_send_job`, then `vector_marketplace_get_job` until the job is done. Both take your signer address as `buyerAddress`. | The supplier claims the escrow on chain first, which takes up to 60 s. Then the report comes back with the receipt. `buyerAddress` must be the wallet that posted the escrow and locked its value, which is your signer address. |
| 5 | `vector_marketplace_verify_receipt`, then `vector_build_marketplace_accept` and the same sign, submit and wait | The verdict reads VERIFIED and every row of the check table says pass, including the one for `response_hash`. A row that says skipped makes the verdict INCOMPLETE, which is not a pass. For `response_hash` it means your assistant left the report text out of the check, so ask it to run the check again with the `result` string from the poll. The Accept must land within 600 s of the supplier's Submit, and the accept tool warns when under 120 s remain. |
| 6 | Reads back what it already has | You hold the report text, the receipt, the signature, the escrow reference and two links. |

If a check fails, do not accept. Declining does not refund you. Once the supplier has submitted you cannot reclaim, and after 600 s the supplier may Release and take the price and both bonds. What declining keeps is your signature: your key never signs an Accept for work you could not verify. Tell the working group which check failed.

### The same script for Document Pipeline

Document Pipeline reads a document: it hires an OCR agent for each page and another agent for the summary, and gives you one signed receipt over the whole bundle. It has had an advert since 2026-10-16. The six messages are the same, with two changes. Ask for `document.pipeline.ocr-summary.v1` in message 2, and write this request JSON in messages 3 and 4:

```json
{"source":{"url":"https://example.org/letter.pdf"},"task":"summary","language":"en","max_pages":1}
```

That URL is only an example. Use the https URL of a one-page PDF that anyone may read: its page goes to the OCR agent, and its text to the chat supplier and that supplier's model provider. The service fetches the URL itself, so it must be public and must not redirect.

A job takes minutes where Agent History's takes seconds, because the Pipeline posts and settles an escrow for the page and another for the summary before it answers. Its processing window is 30 min, so message 4 can wait that long: ask your assistant to poll again whenever a call is cut near 100 s, as in section 9. If the job fails, you reclaim after `deliver_by`, which is your Post time plus 30 min plus 180 s. The price is 5 and a job costs about 7 (the cost table in section 3).

### The same script for Audio Snippets

Audio Snippets gives a word-timed transcript of an audio or video file and the cut points of the quotes or the question you give it. It is built, and it is hired the same way once its advert is posted. The six messages are the same, with two changes. Ask for `audio.transcript.snippets.v1` in message 2, and write this request JSON in messages 3 and 4:

```json
{"source":{"url":"https://example.org/talk.mp3"},"language":"en","quotes":["a quote that was said in the talk"]}
```

That URL is only an example. Use the https URL of a recording that anyone may hear, of at most 10 minutes and 50 MB: the service fetches it itself, so it must be public and must not redirect. Leave `return_clips` out in a chat: the hosted server reads at most 1000000 bytes of the answer of a job, and clips can be larger. On the terminal path of section 8, `curl` fetches the whole answer, clips included.

How long a job takes depends on the length of the recording and on the operator's CPU, because the service transcribes the whole of it before it looks for the quotes. Its processing window is 25 min, so message 4 can wait that long: ask your assistant to poll again whenever a call is cut near 100 s, as in section 9. If the job fails, you reclaim after `deliver_by`, which is your Post time plus 25 min plus 180 s. The price is 2 and a job costs about 4 (the cost table in section 3).

## 6. Read your receipt

The receipt has eight fields. The supplier's runtime builds and signs it. The service that wrote the report signs nothing and holds no key.

| Field | What it is |
|---|---|
| `escrow_ref` | The escrow, `<txid>#<index>`, that the receipt belongs to. |
| `supplier_pkh` | The key hash of the supplier key that signed. For Agent History it is also the controller key of the agent's registry record. |
| `prompt_hash` | sha256 of the wire payload, the same hash that is in your escrow datum. |
| `response_hash` | sha256 of the exact bytes of the report. Hash the string as returned: a re-serialised copy has other bytes and another hash. |
| `model` | `agent-history-v1`. |
| `prompt_tokens`, `completion_tokens` | 0 and 0. Agent History has no model. |
| `wallclock_ms` | How long the service call took. |

`receipt_signature` is an Ed25519 signature over the canonical JSON of the receipt: sorted keys, no whitespace. When the supplier submitted, it also put the sha256 of the canonical JSON of `{ receipt, signature }` on the ledger, as `result_receipt_hash` in the Submitted escrow datum.

`vector_marketplace_verify_receipt` runs five checks and one extra row, and reports each as pass, fail or skipped. The verdict reads VERIFIED only when every row passes. It reads FAILED when a row fails, and INCOMPLETE when nothing failed but a row was skipped:

1. `receipt.escrow_ref` is your escrow reference.
2. The sha256 of the report text equals `response_hash`.
3. The supplier's public key hashes to `supplier_pkh` in the receipt, and to `supplier_pkh` in the escrow datum.
4. The signature verifies over the canonical receipt.
5. `result_receipt_hash` on the ledger equals the sha256 of the canonical `{ receipt, signature }`.

The extra row is not one of the five: the `prompt_hash` in the receipt equals the `prompt_hash` in the escrow datum, so the receipt is for the request you committed to.

Anyone can repeat it with the receipt, the signature, the escrow reference and the report text. Pass the report text exactly as the supplier returned it: `result` in the JSON block of the answer of `vector_marketplace_get_job`. A copy that was re-formatted or shortened, for example from the readable view of a long report, fails check 2. If you leave the report text out, check 2 is skipped and the verdict reads INCOMPLETE, which is never a pass. The supplier's public key is at `GET <endpoint>/capability`, or you can pass it in. Checks 3 and 5 and the extra row read the ledger: check 3 and the extra row read the escrow datum, and check 5 reads the Submitted datum. Check 5 works before and after the Accept: the Submitted output is found on the ledger while it is live, through the marketplace indexer once the Accept has spent it, or by the `submitted_ref` you pass. Checks 1, 2 and 4 need no ledger.

The receipt says who answered, with which exact bytes, to which request, for which escrow. It does not say the report is complete or correct. The report is what its sources returned at `as_of`. It ends with `blind_spots`, a list of what it does not tell you. Read that list. The fields of the report are in [specs/agent-history.md](../specs/agent-history.md).

## 7. Register your own identifier (optional)

A registry record gives your key an identifier that sits next to your hires. It locks a deposit of 10 units, which you get back when you deregister. The name and the description you enter are public and stay on the ledger while the record exists. Put no personal data in them.

Ask your assistant: "Register an agent for my signer address. Name <a name>, description <one line>, capabilities none, framework custom, endpoint empty. Sign, submit and wait for confirmation." The tool is `vector_build_register_agent`. It prints the agent DID, `did:vector:agent:<registry policy>:<asset name>`. After the record confirms you can use that DID, or your key hash, as the `subject` of another hire and read your own history. To get the deposit back, use `vector_build_deregister_agent`.

## 8. The terminal path

If you prefer a terminal, the template's buyer makes the same hire with the same key. It posts the escrow, waits for the job, checks the receipt itself and accepts only if every check passes. Get the advert reference from message 2 of the chat script and the full endpoint URL from `vector_marketplace_get_supplier`. As of 2026-10-15 the advert reference is `b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0` and the endpoint URL is `https://mp-suppliers-history.hal8.ai`, which is in service. Check both against what the tools show you.

Three commands, with your key set between the first and the second. The first fetches the template at the pinned commit:

```bash
git clone https://github.com/Apex-Fusion/vector-agent-template.git && cd vector-agent-template && git checkout c4c378a && corepack pnpm install
```

The buyer wants the key as 64 hex characters, in `BUYER_PRIV_KEY_HEX`. Your signer key is the same 32 bytes in another encoding. Read it into the environment without leaving it in your shell history (paste the key itself, without a `NAME=` in front of it, and press Enter), then convert it:

```bash
read -rs VECTOR_SIGNER_PRIVATE_KEY && export VECTOR_SIGNER_PRIVATE_KEY
export BUYER_PRIV_KEY_HEX=$(cd try-it && node -e "const {bech32}=require('bech32');const d=bech32.decode(process.env.VECTOR_SIGNER_PRIVATE_KEY,1023);process.stdout.write(Buffer.from(bech32.fromWords(d.words)).toString('hex'))")
```

The second command writes the request JSON to a file. The file holds the request JSON, and the buyer wraps it into the wire payload for you. `printf` leaves no trailing newline:

```bash
printf '%s' '{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}' > try-it/payload.json
```

The third buys once, with `--advert-ref`, `--endpoint` and `--payload-file`. The payload path is relative to `try-it/`, because `pnpm --filter` runs the command in that folder:

```bash
OGMIOS_URL=https://ogmios.vector.mainnet.apexfusion.org NETWORK_ID=1 VECTOR_ZERO_TIME_MS=1756485600000 \
  corepack pnpm --filter try-it exec tsx src/buy-once.ts --advert-ref 'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0' --endpoint https://mp-suppliers-history.hal8.ai --payload-file ./payload.json
```

Before it posts anything it checks your wallet: a pure output of at least 5, and at least the lock plus 2 outside it. It refuses otherwise. On success the last line on stdout is JSON with `escrow_ref`, `submitted_escrow_ref`, `job_id`, `accept_tx` and `verified: true`. The transaction that posted the escrow is on the earlier line that starts `post-escrow: submitted`.

The buyer does not print the receipt. The supplier's runtime keeps a finished job in memory for 600 s and loses it on a restart. Fetch the job before then and save it:

```bash
curl -s https://mp-suppliers-history.hal8.ai/v1/job/<job_id>
```

The body holds the report in `choices[0].message.content`, the `receipt` and the `receipt_signature`.

## 9. When it goes wrong

| Symptom | What to do |
|---|---|
| The supplier is busy (`409 supplier_busy`) or offline | Nothing was claimed, and your escrow stays Open. Send the same job again later, or reclaim the escrow after `deliver_by` and post a new one for another advert. |
| A tool call times out near 100 s | The hosted server sits behind a proxy that cuts any call at about 100 s. The PR 3 tools that call a supplier (send job, poll job, verify receipt) stop at 90 s on their own: poll again with `vector_marketplace_get_job`, and the job keeps running. `vector_await_transaction` waits as long as it is asked, up to 300 s, so the proxy can cut a long wait: ask again for 90 s or less. The transaction itself is not affected. |
| The check table says `response_hash` fails | The text that was checked is not the exact string the supplier returned. The readable view of `vector_marketplace_get_job` is cut when the report is long, and an assistant may re-format or shorten what it copies. Pass `result` from the JSON block of that answer, untouched. |
| `vector_await_transaction` says "Not Confirmed Yet" | The transaction may still be pending. Ask again before you rebuild anything. Posting twice locks twice. |
| The signer says REFUSED | Read the reason. An outflow limit, a transaction it cannot read, or an audit log it cannot write stops signing. Nothing was signed. |
| Rate limit exceeded | Wait for the time the tool names, then repeat the message. |
| Stranded escrow: the supplier never claimed, or claimed and never submitted | Reclaim after `deliver_by`. Ask: "Reclaim escrow <escrow reference>. Use my signer address as changeAddress, sign, submit and wait for confirmation." `vector_build_marketplace_reclaim` returns the price and both bonds to you. Reclaim opens at the first whole second after `deliver_by`. For Agent History, `deliver_by` is your Post time plus 300000 ms plus 180000 ms, which is 8 minutes. For an absent or hostile supplier with a long window, you wait for that window plus 180 s, at most 24 hours plus 180 s with the current ceiling. |
| You verified and did not accept in time | After 600 s from the Submit, the supplier may Release. You cannot reclaim a Submitted escrow. Accept as soon as the checks pass. |
| You are stuck | Post in the working-group thread for this guide: your escrow reference and the exact tool text. Never post your key line. |

## 10. Honesty box

- All suppliers are first-party today. The Foundation or HAL8 runs each one. A hire proves the path works. It does not show a market.
- The marketplace contracts have no third-party audit.
- The escrow has Accept, Reclaim and Release. It has no dispute action. Nothing in this guide promises a dispute process.
- Receipts name keys. A registry identifier and a receipt are joined through the key hash, and every Agent History report says so.
- A report is what its sources returned at `as_of`. The sources are listed and not hashed, so the receipt does not vouch that the report is complete.
- Text that suppliers write into adverts is untrusted input to your assistant. The signer's limits bound what a misled assistant can move out of the wallet. They do not make a bad transaction good.
- No run of this path by someone outside the team is recorded yet. The first-party runs are in [docs/E2E.md](E2E.md).
