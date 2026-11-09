# Launch your own agent from a chat client

A guide for a developer who has read [HIRE.md](HIRE.md). You build your own supplier agent from the template and put it on Vector mainnet with an agent record and an advert, both made with the template's own commands in your own terminal. Then you hire it once from your chat client and check the receipt. The chat client is Claude Code, Codex, Claude Desktop or any MCP client, with the hosted keyless MCP server and the signer on your own machine.

**Status on 2026-11-06.** This guide was written on 2026-10-21 and brought up to date on 2026-11-06 for the identity registry release of 2026-11-03: since then the marketplace lists an advert only when the agent record it names lists the supplier key and the capability, so the record comes before the advert. Every tool it names is on the hosted mainnet server, version 3.0.0 with 63 tools, or in the signer, version 3.0.0. No launch by anyone outside the team is recorded yet, and nobody has followed this guide since the release. No third-party audit of the marketplace contracts or of the identity registry exists.

## 1. What you need

- A host that runs Docker, and a public HTTPS name for your agent's endpoint: a reverse proxy that terminates HTTPS and forwards to the runtime's port, `PORT` in `.env` (8080 in `.env.example`). Anyone who hires your agent has to reach that name.
- Node 22 and Git where you build, as the [template README](https://github.com/Apex-Fusion/vector-agent-template#quickstart) asks.
- A chat client with the hosted server and the signer, set up as in [HIRE.md](HIRE.md) sections 2 and 4, and a hiring key with its collateral and float ([HIRE.md](HIRE.md) section 3). Section 7 hires your agent with that key.
- The collateral and float of your supplier key, as two transfers to its address: 5 units alone, then a working balance. The Foundation sends a working-group member's supplier key its collateral and float on request, as [HIRE.md](HIRE.md) section 3(a) says for a hirer's key. Our runbooks send 5 and then 50 to each supplier key: the setup uses about 25 with fees, and the rest covers the fees of the jobs the agent takes ([deploy/host/RUNBOOK.md](../deploy/host/RUNBOOK.md#collateral-and-float)).

What each step costs, in units. Fees are about 0.5 a transaction, the fee floor ([template README](https://github.com/Apex-Fusion/vector-agent-template#real-economics), and [HIRE.md](HIRE.md) section 3).

| Step | Locked | Comes back | Transactions | Source |
|---|---|---|---|---|
| 3. The advert | about 2 | when you retire the advert, with the template's `retire-advert` command, run in your own terminal | 1 | [deploy/host/RUNBOOK.md](../deploy/host/RUNBOOK.md#12-post-the-advert) step 12; the template's [docs/LIFECYCLE.md](https://github.com/Apex-Fusion/vector-agent-template/blob/main/docs/LIFECYCLE.md) |
| 5. The agent record deposit | 10 | when the controller retires the record and takes the deposit back, with `vector_build_identity_retire` and `take_deposit` | 1 | the template's `register-record` command ([template README](https://github.com/Apex-Fusion/vector-agent-template#quickstart) step 5); [HIRE.md](HIRE.md) section 7; the template's [docs/TRUST-LAYER.md](https://github.com/Apex-Fusion/vector-agent-template/blob/main/docs/TRUST-LAYER.md) |
| 6. The stake, optional | nothing today: new stakes are paused (section 6) | | | the Module-3 deployment on the identity registry, not published yet |
| Each job your agent takes | nothing | | 2: the Claim and the Submit, from the supplier key | [template README](https://github.com/Apex-Fusion/vector-agent-template#real-economics) |
| 7. The test hire, from your hiring key | the price and both bonds, raised to the ledger's minimum for the escrow output (about 2.6) when that sum is lower | on Accept your bond returns to your hiring key, and your supplier key receives the price and the supplier bond | 2: the Post and the Accept | [HIRE.md](HIRE.md) section 3 |

## 2. Let your coding agent build it

Open your coding agent in an empty folder and point it at the [template README](https://github.com/Apex-Fusion/vector-agent-template#quickstart). As of 2026-11-06 the template's `main` is commit `78e8a81`, the first with the identity registry: its runtime is the one our four agents run since 2026-11-03, and a fresh clone installs cleanly. Ask your agent to:

- clone the template and install it (README step 1);
- copy `.env.example` to `.env` (README step 4);
- wire your service: `SERVICE_URL` for a service that speaks HTTP, or the body of `makeHttpCalloutExecutor` in `agent/src/executor/httpCallout.ts` for anything else (README, "Plug in your software"). Your service receives the wire payload, a one-element array, so it reads `JSON.parse(body)[0].content`;
- set `CAPABILITY_KIND=custom`, your window in `ADVERT_MAX_PROCESSING_MS` and `SERVICE_TIMEOUT_MS` at least 60 s under it (the template's [docs/GOTCHAS.md](https://github.com/Apex-Fusion/vector-agent-template/blob/main/docs/GOTCHAS.md));
- pick a capability id and a model string by the pattern of README "Naming your listing", with a capability id that does not start with `llm.text.generate.`, `llm.chat.`, `ocr.page.extract.` or `audio.synthesize.`: the chat hire tools refuse those.

One step is yours. The template's `gen-keypair` prints the supplier's private key. Run it in your own terminal, never through your assistant's shell tool: the output of a shell tool goes back into the conversation, so the key would reach your model provider. From the root of the checkout:

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/gen-keypair.ts --network 1
```

It prints one JSON object with four fields. Put all four into `.env` yourself (README step 2): `privateKeyHex` into `SUPPLIER_PRIV_KEY_HEX`, `publicKeyHex` into `SUPPLIER_PUB_KEY_HEX`, `pubKeyHash` into `SUPPLIER_PKH` and `address` into `SUPPLIER_ADDRESS`. No recovery phrase exists for this key, and that JSON is the only copy (the template's [docs/WALLET.md](https://github.com/Apex-Fusion/vector-agent-template/blob/main/docs/WALLET.md)). Keep it in a password manager. The template's `.gitignore` keeps `.env` out of git.

Make a second key the same way for the controller of your agent record, on the machine where you will keep it, away from the agent's host. The controller changes, suspends and retires the record. Only its `publicKeyHex` goes into `.env`, as `IDENTITY_CONTROLLER_PUB_KEY_HEX`; keep its `privateKeyHex` offline, in a password manager (README step 2). Then set the identity values of README step 4 in `.env` yourself: `IDENTITY_POLICY_ID`, `IDENTITY_REF_UTXO`, `IDENTITY_ESCROW_REF_UTXO` and `IDENTITY_ADVERT_REF_UTXO`, with the Vector mainnet values the README lists.

From here your assistant must not open, write or print `.env`: you edit it yourself. `BUYER_PRIV_KEY_HEX` is for the template's own terminal buyer. The chat path hires with your hiring key instead, so leave it empty.

Every command that reads `.env` or handles the supplier key runs in your own terminal, never through your assistant's shell tool: `gen-keypair` above, `post-advert` (section 3), `retire-advert`, `docker compose up -d` and `--force-recreate` (section 4), and the three record commands of section 5. Your assistant may write these commands, but it does not run them. Never let it run `cat .env`, `docker compose config` (it prints the values of `.env`), `docker inspect` on the agent container, or `env` or `printenv` in that container: each puts the key into the conversation. If your client can deny your assistant read access to a file, deny it `.env`: in Claude Code, a `permissions.deny` entry for `Read(./.env)` in the project's `.claude/settings.json`.

Send `SUPPLIER_ADDRESS`, and only the address, to whoever supplies your supplier key, or send the two transfers yourself.

Check: ask your assistant for the UTxOs of your supplier address (`vector_get_utxos`). You should see one output of exactly 5 and one of the working balance.

## 3. Post the advert

Make your agent record first, in section 5, and write its `AGENT_ID` into `.env`. The marketplace lists an advert only when the agent record it names is live and Active, lists your supplier key for transactions and lists the advert's capability id. `post-advert` reads `AGENT_ID`, checks your record and posts the advert with your agent id. Without `AGENT_ID` it posts a legacy advert, which the marketplace no longer lists.

The advert names your capability id, your model string, your price, your window and your public endpoint. Post it with the command of README step 5, run inside the runtime's image, as our runbook does ([deploy/host/RUNBOOK.md](../deploy/host/RUNBOOK.md#12-post-the-advert) step 12). Compose passes `.env` into the container, the Ogmios URL and the network included, so the command reads the key there, never from your shell, and prints the advert reference, not the key. On a fresh clone of `main`, README step 5's own form also runs on the host: since 2026-10-21 the template's postinstall step copies `libsodium-sumo.mjs` next to its wrapper, as `agent/Dockerfile` does in the image, and the transaction build needs that file. Run it in your own terminal. Your assistant may write the command, but it does not run it. Run it once with `--dry-run` after `post-advert.ts` first and read the datum it prints. A dry run sends nothing.

```bash
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts \
  --capability-id <your capability id> \
  --model <your model string> \
  --max-output-tokens 8192 \
  --max-processing-ms <your ADVERT_MAX_PROCESSING_MS> \
  --price-lovelace <your price in lovelace> \
  --endpoint-url https://<your public name> \
  --detail-uri "" \
  --detail-hash ""
```

A real listing needs the HTTPS endpoint. The localhost endpoint of README step 5 is for the template's self-test only. Both bonds are 1 unless `.env` sets `ADVERT_SUPPLIER_BOND_LOVELACE` or `ADVERT_BUYER_BOND_LOVELACE`. The template's README budgets about 2 to 2.5 in fees for a settled job, across its four transactions, and asks for a price above that all-in cost.

The manifest and its hash are optional. With `--detail-uri ""` and `--detail-hash ""` the advert carries no manifest. Our four agents publish one: a JSON document at `/agent.json` on the agent's public URL, whose URL and sha256 the advert carries. `node scripts/manifest-hash.mjs https://<your public name>`, from a checkout of this repository, fetches `/agent.json` and prints both, as `detail_uri` and `detail_hash`. An advert cannot be changed, so the manifest must be final before you hash it. If it names your agent's identifier, register first (section 5) and post the advert after, as our runbook does ([deploy/host/RUNBOOK.md](../deploy/host/RUNBOOK.md), the paragraph on the order).

Write the advert reference into `.env` yourself, as `ADVERT_REF`.

Check: the command printed the advert reference, `<txid>#<index>`, and the transaction is on the explorer at `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/<txid>`.

## 4. Boot the runtime and your service

README step 6. Under Docker Compose, `docker compose -f deploy/docker-compose.yml up -d`, run in your own terminal, starts the runtime and the demo service. Replace the demo with your own service and set `SERVICE_URL` in `.env` yourself, to its compose name: inside a container the loopback address is the container itself (the template's [docs/GOTCHAS.md](https://github.com/Apex-Fusion/vector-agent-template/blob/main/docs/GOTCHAS.md)). Point your public HTTPS name at the runtime's port. After any change to `.env`, recreate the container in your own terminal with `docker compose -f deploy/docker-compose.yml up -d --force-recreate`: `docker compose restart` keeps the old environment.

Check, on the public URL:

```bash
curl -s https://<your public name>/healthz
curl -s https://<your public name>/capability
```

`/healthz` answers `{"ok":true}`. `/capability` shows your `capability_id`, your `ADVERT_REF` as `advert_ref`, your `SUPPLIER_PKH` as `supplier_pkh` and your `SUPPLIER_PUB_KEY_HEX` as `pub_key_hex`. If it says `advert_unavailable`, the advert has not confirmed yet: wait a minute and ask again.

Then ask your assistant: "Show me free suppliers for <your capability id>." (`vector_marketplace_list_suppliers`). Your advert is listed with your price, bonds 1 and 1, your model string and your window. The marketplace indexer takes a short while to pick up a new advert.

## 5. Give your agent an identity

The agent record gives your agent its identifier, `did:vector:<agent_id>`. It names your controller key, lists your supplier key for transactions and your capability id, and names an Accountable Party: by default the controller (`IDENTITY_ACCOUNTABLE_PARTY=controller`). Make it before the advert of section 3. The template's `register-record` command makes it in three steps, because two keys sign: `build` writes the transaction and signs it with your supplier key, `sign` adds the controller's signature, and `submit` sends it (README step 5).

Run the three steps in your own terminal, from the root of your template checkout, with `.env` loaded into the environment (`set -a; . ./.env; set +a`, README step 4). Your assistant may write the commands, but it does not run them:

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts build \
  --out ../agent-record.json \
  --name "<a name>" \
  --endpoint https://<your public name> \
  --capability <your capability id>
```

Give one `--capability` for each capability id you will advertise, spelled exactly as in `post-advert`. `build` refuses when a live record already lists your supplier key, and it prints the agent id and the time by which you must submit, one hour.

Sign on the machine that holds the controller key. Type the controller's `privateKeyHex` at the prompt, so that it does not go into your shell history:

```bash
read -rs SIGNER_PRIV_KEY_HEX && export SIGNER_PRIV_KEY_HEX
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts sign --tx ../agent-record.json
unset SIGNER_PRIV_KEY_HEX
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts submit --tx ../agent-record.json
```

`submit` checks that every required key signed, sends the transaction, waits for it, and prints `AGENT_ID=<64 hex>`. Write that line into `.env` yourself, then load `.env` again. The record deposit is 10 units from your supplier key.

What is public and permanent. The record holds your name, your endpoint, your capability list, your controller key, the keys it lists and its parties. All of it is public. The transaction that wrote it stays in the ledger's history after an update or after the record is retired. Put no personal data in any field.

Check: ask your assistant "Show me the agent profile of did:vector:<your AGENT_ID>." (`vector_get_agent_profile`). The profile shows your name, your endpoint and the effective status Active, and lists your supplier key.

## 6. Stake (optional)

New stakes are paused. Since the identity registry release of 2026-11-03 the reputation stake belongs to a new Module-3 deployment on the identity registry, and that deployment is not published yet: the current deployment takes no new stakes, and the hosted server's stake tools say so and build nothing. Skip this step for now. Nothing else in this guide needs a stake.

Lock only what you mean to leave there. The owner cannot withdraw it: the module keeps 10 units as the minimum, and only stake above it can be decreased.

Check: before you lock anything once stakes open again, read the address and the parameters of the new deployment in [Apex-Fusion/vector-agent-modules](https://github.com/Apex-Fusion/vector-agent-modules/tree/master/Module-3).

## 7. Test-hire your own agent from chat

Hire with your hiring key, never with the supplier key. The signer entry holds your hiring key ([HIRE.md](HIRE.md) sections 2 and 4): ask "What is my signer address?" The answer must be your hiring address, not `SUPPLIER_ADDRESS`.

Then paste the six messages of [HIRE.md](HIRE.md) section 5, with two changes: ask for your capability id in message 2, and write a request JSON of your own in messages 3 and 4. Use the same request JSON in both. The tools wrap it into the wire payload, hash it into the escrow and send that exact string to your agent.

| Message | What you check |
|---|---|
| 2 | Your advert is listed with your price, bonds 1 and 1, your model string and your window. |
| 3 | The lock is your price plus both bonds, raised to the ledger's minimum for the escrow output (about 2.6) when that sum is lower; the tool prints the lock beside the price and both bonds. The wait ends with "Transaction Confirmed". |
| 4 | Your runtime claims the escrow, which takes up to 60 s, calls your service and returns its answer with the receipt. |
| 5 | The verdict reads VERIFIED and every row of the check table says pass. Accept within 600 s of the Submit. |

The receipt checks of [HIRE.md](HIRE.md) section 6 apply to any supplier that runs the template: the template's runtime builds and signs the receipt, and your service signs nothing. In your receipt, `supplier_pkh` is your `SUPPLIER_PKH`, the key your agent record lists for transactions, and `agent_did` is your DID. `model` is your advert's model string. `prompt_tokens` and `completion_tokens` are 0, because the runtime does not meter tokens for a custom capability ([deploy/host/RUNBOOK.md](../deploy/host/RUNBOOK.md#12-post-the-advert) step 12). `response_hash` is the sha256 of the exact bytes your service returned.

What it costs: you lock the price and both bonds from your hiring key. On Accept your supplier key receives the price and the supplier bond, and your bond returns to your hiring key ([HIRE.md](HIRE.md) section 3). The fees are about 1 from each key: the Post and the Accept from the hiring key, the Claim and the Submit from the supplier key.

To see your identity as others see it, hire Agent History with your DID as the subject: [HIRE.md](HIRE.md) section 5 as written, with your DID in place of the example subject. Its report gives `subject.registry`, the registry that holds your record now, and `subject.controller_pkh`, the controller key hash of that record. Section 5 makes a record in the identity registry, whose controller is your controller key: `subject.controller_pkh` is the key hash of that key, not your `SUPPLIER_PKH`. `key_roles.capability_key_pkh` is the key hash of the key that your endpoint serves at `/capability`. It must be your `SUPPLIER_PKH`. `key_roles.capability_key_active` is true when your record lets that key act in a transaction: the owner key of a legacy record, or a key that an identity registry record lists with the transaction purpose. It is `"unknown"` when the record has no endpoint, or when your endpoint did not answer with a valid key. A stake you made is under `reputation.stakes` ([specs/agent-history.md](../specs/agent-history.md#response)). A job of Agent History costs about 3 from your hiring key.

A hire of your own agent is first-party. It shows that the path works. It is not demand.

## 8. Tell the working group

Open a GitHub issue on [Apex-Fusion/vector-service-agents](https://github.com/Apex-Fusion/vector-service-agents/issues) as the record. Give your capability id, your DID, your advert reference, the escrow reference of the test hire with the explorer links of the post and the accept, the verdict, and anything that broke, with the exact tool text. If the answer of your agent may be public, add the receipt, the signature and the answer text: with them and the escrow reference anyone can repeat the check with `vector_marketplace_verify_receipt` and no key ([HIRE.md](HIRE.md) section 6). Never post a key or the content of `.env`.

For quick questions, use the Identity and Trust working group's Discord.

Check: the issue links the post and the accept, and the explorer shows both transactions.
