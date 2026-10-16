# Runbook: Agent History on the deployment host

Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 15 and 17 were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).

The operator holds the keys and does every step except three. Step 2 (the registry login and the service image) and step 10 (DNS and Caddy) are the host administrator's, see [README.md](README.md). Step 6 (the collateral and float of the supplier wallet) is the Foundation's. Every run of the agent is first-party until a buyer outside our control appears. A first-party run shows that the path works. It is not demand and it counts as no revenue.

One thing about the order. The advert carries the sha256 of the manifest the service serves at `/agent.json`, and adverts are immutable. So everything the manifest contains (the agent identifier, the keys, the status word) has to be final before the hash is taken. That is why the identity is registered (steps 7 and 8) before the advert (step 12), and why changing the status afterwards costs a new advert (step 17).

The commands on the box use `BASE`: the folder the operator chose for this agent, with the checkout of this repository in `repo` and the ops scripts in `ops`. Any path works. Set it in every new shell on the box before the commands below:

```sh
BASE=/opt/agent-history
```

## Collateral and float

The Foundation supplies two keys with their collateral and float. Nobody pastes either key into a chat.

| Key | Supplied with | Covers |
|---|---|---|
| Supplier key, generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral, never touched), then 50 units | The registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees. The rest covers the supplier's claim and submit fees. 25 would leave almost nothing for those, so send 50. |
| Test buyer key, generated on the operator's own machine | Two transfers: 5 units alone, then 50 | The first-party run of step 15. A run costs about 3 units of the float. |

Two transfers, because a wallet supplied in one transfer can have its collateral spent as change by an ordinary transaction.

## 1. Put the files on the box

Operator. On the box, as the user that runs Docker:

```sh
mkdir -p "$BASE" && cd "$BASE"
git clone https://github.com/Apex-Fusion/vector-service-agents.git repo
cd repo/deploy/host
git log -1 --oneline
```

The repository is public since 2026-10-16, so the box needs no GitHub credentials to clone it. Copying `deploy/host` and `agents/agent-history` over `scp` also works if the layout stays the same. Check that the commit is the one that was reviewed. "This folder" below means `$BASE/repo/deploy/host`.

Then name the network. Both containers join the external network of the host's reverse proxy, and its name is not in the repository: compose reads it as `PROXY_NETWORK` from `.env` in this folder for every compose command (the first is in step 3), and stops while it has no value. The host administrator gives the name ([README.md](README.md)). In this folder:

```sh
echo 'PROXY_NETWORK=<the network the host administrator names>' > .env
docker network inspect --format '{{.Name}}' "$(sed -n 's/^PROXY_NETWORK=//p' .env)"
```

The second line must print the name back. An error means that this host has no network of that name. `.env` holds no secret and is covered by the repository's `.gitignore`.

## 2. Log in to the registry and get the service image

Host administrator. The package is public since 2026-10-16: the login is optional, and its token needs `read:packages`. The host still builds the image itself (below).

```bash
read -rs GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin
unset GHCR_TOKEN
docker pull ghcr.io/apex-fusion/vector-service-agents/agent-history:latest
```

If CI has not published the image yet, build it from the repository root. Compose uses a local image that already has the right name:

```sh
cd "$BASE/repo"
docker build -f agents/agent-history/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/agent-history:latest .
cd deploy/host
```

Then pin the image. The manifest that the service renders is hashed into the advert (step 12), and `:latest` moves with every merge to `main`, so a later pull could change the bytes behind that hash. The compose file therefore names the image by digest. It ships with the placeholder `@sha256:<digest>`, and compose refuses to start the service (`invalid reference format`) until the placeholder is replaced. Record the digest of the image that is on the box now:

```sh
docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/apex-fusion/vector-service-agents/agent-history:latest
```

It prints the image name, `@sha256:` and 64 hex digits. Give that line to the operator. In `docker-compose.agent-history.yml` the operator replaces `@sha256:<digest>` in the `image:` line of `service` with `@sha256:` and the 64 digits. That is the only local change to the checkout, and it has to be made before step 9. If the command prints an error because `RepoDigests` is empty (an image built on the box by a Docker that keeps no digest for local images), use the image ID instead: `docker image inspect --format '{{.Id}}' ghcr.io/apex-fusion/vector-service-agents/agent-history:latest` prints `sha256:` and 64 hex digits, and the whole `image:` value is that. Do not pull `:latest` over the pinned service after the advert is posted: a new image has a new digest and can change the manifest, so the hash of step 11 has to be taken again.

## 3. Build the runtime image

```sh
docker compose -f docker-compose.agent-history.yml build agent
```

This clones `vector-agent-template` at the pinned commit `c4c378a` and installs it. The compose file carries the full 40-character hash, because BuildKit does not resolve the short form. The first build takes a few minutes. It ends with `Image agent-history-agent Built`.

## 4. Make the env file and generate the supplier key

The key is generated on the box and is never sent anywhere. This prints no secret: it writes the four values into the env file and shows only their lengths. From here on the compose commands need the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, step 1), which exists on the box.

```sh
umask 077
cp .env.agent-history.example .env.agent-history
chmod 600 .env.agent-history
KEYJSON=$(docker compose -f docker-compose.agent-history.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1)
for pair in privateKeyHex:SUPPLIER_PRIV_KEY_HEX publicKeyHex:SUPPLIER_PUB_KEY_HEX pubKeyHash:SUPPLIER_PKH address:SUPPLIER_ADDRESS; do
  field=${pair%%:*}; name=${pair##*:}
  value=$(printf '%s\n' "$KEYJSON" | sed -n "s/.*\"$field\": *\"\([0-9a-z]*\)\".*/\1/p")
  [ -n "$value" ] || { echo "no $field in the keypair output" >&2; break; }
  sed -i "s|^$name=.*|$name=$value|" .env.agent-history
done
unset KEYJSON value
awk -F= '/^SUPPLIER_/ { print $1, length($2) }' .env.agent-history
```

The last command must print `SUPPLIER_PRIV_KEY_HEX 64`, `SUPPLIER_PUB_KEY_HEX 64`, `SUPPLIER_PKH 56` and `SUPPLIER_ADDRESS 58`. All four are needed. An empty public key breaks the receipt check, and an empty key hash makes the runtime reject its own claims as `wrong_supplier`.

Then set the contact address, the one value in the file that is not generated. `OPERATOR_CONTACT` is required: the service stops at start without it, and the address is published in the manifest that the advert hashes, so it is final before step 11. Use the role address that the Foundation confirms, never a person's address. The line holds a placeholder in angle brackets from the example. Edit it in place, then check:

```sh
grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.agent-history
```

It must print 1: a value that does not start with an angle bracket.

The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today's date: the status can honestly change only in step 17.

The key is a raw keypair and this file is the only copy until step 7. There is no recovery phrase, and nothing can derive it again. Copy `.env.agent-history` to the operator's encrypted offline store now, before the address receives anything. A wallet whose key is lost is gone, whatever the ledger shows for it. Step 7 writes a second plaintext copy of the key to `$BASE/ops/wallet`: from then on the key is in two files on the box, and both are protected the same way.

## 5. Adapt the ops scripts

Operator. The identity steps use the operator's existing identity scripts (registration, stake, signing), kept outside the repository. They are not copied into this repository: they carry mainnet paths, and `sign-tx.py` is the byte-preserving signer (first gotcha, at the end). Make adapted copies outside the git checkout, so that nothing they write can be committed. The first three lines name what the copies replace: the folder of the existing scripts on the box, the env file they read, and the supplier name that `make-skey.py` writes into the key file:

```sh
SRC=<the folder of the existing identity scripts>
SRC_ENV=<the env file those scripts read>
SRC_LABEL=<the supplier name in make-skey.py>
mkdir -p "$BASE/ops" && cd "$BASE/ops"
for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do
  sed -e "s#$SRC_ENV#$BASE/repo/deploy/host/.env.agent-history#g" \
      -e "s#$SRC#$BASE/ops#g" \
      "$SRC/$f" > "$f"
  chmod 755 "$f"
done
sed -i "s#$SRC_LABEL#agent-history supplier#g" make-skey.py
DESC="The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Read-only; no model cost."
sed -i \
  -e 's#^ "name":".*",# "name":"Agent History",#' \
  -e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#" \
  -e 's#^ "capabilities":\[.*\],# "capabilities":["identity.history.report.v1"],#' \
  -e 's#^ "framework":".*",# "framework":"vector-service-agents",#' \
  -e 's#^ "endpoint":".*"}# "endpoint":"https://mp-suppliers-history.hal8.ai"}#' \
  register-did.sh
sed -i 's#^CAPABILITIES = \[.*\]#CAPABILITIES = ["identity.history.report.v1"]#' m3-self-stake.py
grep -nE '"(name|description|capabilities|framework|endpoint)"' register-did.sh
grep -n '^CAPABILITIES' m3-self-stake.py
./setup-venv.sh
```

The `grep` lines must show the Agent History values and nothing of the agent the scripts were written for. The description is the manifest's, and the registry takes at most 256 characters of it (this one is 214). `setup-venv.sh` builds the Python environment and clones the Module-3 SDK into `$BASE/ops`. It ends with `venv ok`.

## 6. Supply the supplier wallet with its collateral and float

The Foundation. Read the address with `grep '^SUPPLIER_ADDRESS=' "$BASE/repo/deploy/host/.env.agent-history"`, then send two separate transfers to it. The first is exactly 5 units, alone. Send the second, 50 units, only after the first has confirmed. Check:

```sh
cd "$BASE/repo/deploy/host"
"$BASE/ops/mcp-call.sh" vector_get_utxos "{\"address\":\"$(sed -n 's/^SUPPLIER_ADDRESS=//p' .env.agent-history)\"}"
```

It must list two outputs: one of exactly 5 units and one for the second transfer.

## 7. Register the identity

Operator. This costs a deposit of 10 units, refundable on deregistration, and a fee.

```sh
cd "$BASE/ops"
sed -i '/^AGENT_DID=$/d' "$BASE/repo/deploy/host/.env.agent-history"
python3 make-skey.py
./register-did.sh
```

The first line removes the empty `AGENT_DID=` line that came with the example: the script refuses to run when the name is already in the file, and it appends the real value. `make-skey.py` writes the signing key, in the form the signer reads, to `$BASE/ops/wallet` (mode 600). That file is a second plaintext copy of the supplier key, next to the one in the env file. Keep it as private as the env file, and remove it in Back out (point 4). `register-did.sh` builds the registration on the hosted keyless MCP server, signs it locally with the byte-preserving signer, submits it, waits for it, and appends `AGENT_DID` and `AGENT_REGISTER_TX` to the env file. The record has the name `Agent History`, the capability `identity.history.report.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-history.hal8.ai` and the manifest's description.

Check: `grep -c '^AGENT_DID=did:vector:agent:' "$BASE/repo/deploy/host/.env.agent-history"` prints 1. If the script stops with an error, read the first gotcha at the end before running it again. If it ends with `NOT CONFIRMED`, look at the explorer before running it again: the transaction may still land.

Record the identity in the repository. Once the check above prints 1, open a pull request that puts the DID and the registration transaction into the Identity section of `specs/agent-history.md` (the DID row, the "Registry record" row and the sentence that says the agent has a registry record), together with the test that pins them in `scripts/specs.test.mjs`. The status word does not change here. Step 17 is the only place that flips it.

## 8. Stake in Module-3

Operator. This locks 10 units on the capability, refundable under the stake's own rules (a cooldown applies).

```sh
cd "$BASE/ops"
./venv/bin/python m3-self-stake.py
```

The staked capabilities must be a subset of the registry record's, and here both are the one capability `identity.history.report.v1`. The script patches the SDK's testnet genesis constant and asserts it against the wall clock before it locks anything (second gotcha). It appends `M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM` to the env file.

## 9. Start the service

Operator. Start `service` by name. A bare `docker compose up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.

First check the pin of step 2. The `image:` line of `service` must name a digest of 64 hex digits (or an image ID) in place of the placeholder, or compose stops with `invalid reference format`:

```sh
cd "$BASE/repo/deploy/host"
grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/agent-history@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.agent-history.yml
```

It prints that line. Then start the service:

```sh
docker compose -f docker-compose.agent-history.yml up -d service
docker exec agent-history-service wget -qO- http://127.0.0.1:9091/healthz
docker exec agent-history-service wget -qO- http://127.0.0.1:9091/agent.json
```

`/healthz` answers `{"ok":true}`. The manifest must show the role address of step 4 in `operator.contact`, the new DID in `identity.did`, the key hash in `identity.controller_pkh` and `keys.supplier_pkh`, the public key in `keys.pub_key_hex`, `status.chip` and `status.since` as the env file sets them (step 4), and an empty `links.explorer_advert`. The advert's hash will cover exactly these bytes.

The service can report on itself. This shows what a buyer will get, including the registration of step 7 and the stake of step 8. Koios can take a minute to show a new registration:

```sh
DID=$(sed -n 's/^AGENT_DID=//p' .env.agent-history)
printf '[{"content":"{\\"subject\\":\\"%s\\"}","role":"user"}]' "$DID" \
  | docker exec -i agent-history-service wget -qO- --header='content-type: application/json' --post-file=/dev/stdin http://127.0.0.1:9091/ | head -c 700
```

The same by key hash, the other kind of subject that [docs/HIRE.md](../../docs/HIRE.md) section 7 invites members to use. This is the last check of the service before the advert is posted:

```sh
KEY=$(sed -n 's/^SUPPLIER_PKH=//p' .env.agent-history)
printf '[{"content":"{\\"subject\\":\\"%s\\"}","role":"user"}]' "$KEY" \
  | docker exec -i agent-history-service wget -qO- --header='content-type: application/json' --post-file=/dev/stdin http://127.0.0.1:9091/ | head -c 700
```

`subject.kind` is `pkh`, `subject.candidates` lists the record of step 7, and `marketplace` is an object.

## 10. DNS and Caddy

Host administrator, from [README.md](README.md) points 1 and 4: the DNS record for `mp-suppliers-history.hal8.ai` and the Caddy block, validated and reloaded. Check from any machine:

```sh
curl -fsS https://mp-suppliers-history.hal8.ai/agent.json
```

It must return the manifest of step 9, byte for byte. `/healthz` on the public name answers only after step 13, because every other path goes to the runtime.

## 11. Hash the manifest

Operator. Run it from the root of the repository checkout, on any machine with Node 22; the script only fetches public bytes. On the box the root is `$BASE/repo`:

```sh
cd "$BASE/repo"
node scripts/manifest-hash.mjs https://mp-suppliers-history.hal8.ai
```

It prints one JSON line with `detail_uri`, `detail_hash` and `bytes`. Cross-check on the box with `curl -fsS https://mp-suppliers-history.hal8.ai/agent.json | sha256sum`: the 64 hex digits must be the same. If they differ, stop. Something between the box and the client rewrites the bytes.

## 12. Post the advert

Operator. From this folder. Set the hash, then run once with `--dry-run` and read the datum it prints: the capability, the model `agent-history-v1`, `max_processing_ms` 300000, the price and both bonds at 1000000, the endpoint, the detail URI, the hash and `status` Active. A dry run sends nothing.

```sh
cd "$BASE/repo/deploy/host"
DETAIL_HASH=<the 64 hex digits from step 11>
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
docker compose -f docker-compose.agent-history.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts --dry-run \
  --capability-id identity.history.report.v1 \
  --model agent-history-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 1000000 \
  --max-processing-ms 300000 \
  --endpoint-url https://mp-suppliers-history.hal8.ai \
  --detail-uri https://mp-suppliers-history.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH"
```

Then the same command without `--dry-run`, which posts the advert. It locks about 2 units, returned when the advert is retired, and costs a fee:

```sh
ADVERT_REF=$(docker compose -f docker-compose.agent-history.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts \
  --capability-id identity.history.report.v1 \
  --model agent-history-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 1000000 \
  --max-processing-ms 300000 \
  --endpoint-url https://mp-suppliers-history.hal8.ai \
  --detail-uri https://mp-suppliers-history.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH" | tail -1)
echo "$ADVERT_REF"
printf '%s' "$ADVERT_REF" | grep -Eq '^[0-9a-f]{64}#[0-9]+$' || echo "unexpected output, do not continue"
sed -i "s|^ADVERT_REF=.*|ADVERT_REF=$ADVERT_REF|; s|^ADVERT_DETAIL_HASH=.*|ADVERT_DETAIL_HASH=$DETAIL_HASH|" .env.agent-history
```

`--max-output-tokens` is required: without it the command stops with `missing required env var: ADVERT_MAX_OUTPUT_TOKENS`. 8192 is the value in the template's README. The runtime does not meter tokens for a custom capability, and its receipts record zero. The bonds are not in the flags: the command reads `ADVERT_SUPPLIER_BOND_LOVELACE` and `ADVERT_BUYER_BOND_LOVELACE` from the env file, 1000000 each.

If the command stops with an error after the transaction went out, look at the indexer (step 14) before running it again, so that a second advert is not posted.

Record the advert in the repository. In a pull request, put the explorer link of the advert transaction in the Links section of `specs/agent-history.md`, in place of "Advert on the explorer: none yet. The advert is not posted." The link is `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/` followed by the transaction id, which is `ADVERT_REF` up to the `#`. In the same pull request refresh the rows of the Identity table that still say "planned" or "not in service" and have become true by now (the reputation stake of step 8, the public URL of steps 10 and 13). The manifest keeps an empty `links.explorer_advert`: the advert's own transaction id cannot be inside the manifest the advert hashes. The status word stays PROPOSED until step 17.

## 13. Start the runtime

Operator. The env file changed, so create the container fresh:

```sh
docker compose -f docker-compose.agent-history.yml up -d --force-recreate agent
curl -s http://127.0.0.1:8083/healthz
curl -s http://127.0.0.1:8083/capability
curl -s http://127.0.0.1:8083/status
```

`/healthz` answers `{"ok":true}`. `/capability` shows the advert, with `identity.history.report.v1` and the public key. `/status` says `free`. If `/capability` says `advert_unavailable`, the advert has not confirmed yet: wait a minute and ask again. Then the same through the public name: `/healthz`, `/capability` and `/agent.json` on `https://mp-suppliers-history.hal8.ai`.

## 14. Check the advert on the indexer

Operator. The indexer takes a short while to pick up a new advert.

```sh
curl -fsS https://mp-indexer.vector.apexfusion.org/suppliers \
  | ADVERT_REF=$(sed -n 's/^ADVERT_REF=//p' .env.agent-history) python3 -c '
import json, os, sys
for r in json.load(sys.stdin):
    if r["utxo_ref"] == os.environ["ADVERT_REF"]:
        print(r["advert_status"], r["status"], r["capability_id"], r["detail_hash"])
'
```

The fetch uses `curl` on purpose: the indexer answers 403 to the default user agent of Python's `urllib`.

It must print `Active free identity.history.report.v1` and the hash of step 11. From here the agent is advertised and the status word stays as it was until step 17.

## 15. The first-party run

Operator. Follow [E2E.md](../../docs/E2E.md) with `ADVERT_REF` from step 12 and the test buyer key with its collateral and float. This is the step that proves the path, and nothing before it settles a job. As of 2026-10-14 the nine marketplace tools the script needs are merged into `main` of Apex-Fusion/mcp-server (PR 1 as [#20](https://github.com/Apex-Fusion/mcp-server/pull/20), PR 2 as [#21](https://github.com/Apex-Fusion/mcp-server/pull/21) and PR 3 as [#23](https://github.com/Apex-Fusion/mcp-server/pull/23) with PR 2) and are on the hosted mainnet MCP server, which lists 33 tools. PR 4 ([#22](https://github.com/Apex-Fusion/mcp-server/pull/22)), the signer package with its `keygen` command, is merged too, and the package is published on npm (`@apexfusion/vector-mcp-signer`, version 2.0.0, on 2026-10-16). The default `BUILDER_URL` of the script is the hosted mainnet MCP server, so the run needs no local builder. E2E.md keeps the local build of `main` as the fallback for a builder that lacks the tools. Add the run to the Results table in E2E.md. Only a run that ends in the printed evidence counts. The first run, made on 2026-10-15, is recorded in E2E.md.

## 16. Wallet monitor

Not used for this agent: the operator decided on 2026-10-15 that the fleet's wallet monitor does not watch this supplier; the float is read by hand with the check of step 6. Kept for an operator who wants it. Add the supplier address to the fleet's wallet monitor, so that a drained float is seen before a claim fails. The monitor is `wallet-monitor/` in the `Apex-Fusion/agents-marketplace` repository (see its README). On the machine that runs it, add one entry to `wallet-monitor/wallets.json`, which is not in git: `{ "name": "supplier-agent-history", "address": "<SUPPLIER_ADDRESS from the env file>" }`. The monitor posts to Slack when a wallet drops below its threshold.

## 17. Flip the status

Operator, and only after step 14 shows the advert Active and step 15 has ended with a settled first-party job. Then the status can honestly change from `proposed`. Set `deployed` or `live` as the operator decides: a first-party run shows that the path works, and it is not demand.

The status is in the manifest, so changing it changes the bytes the advert hashed, and a reader who compares the served manifest with the advert's `detail_hash` would see a mismatch. The advert has to be retired and posted again. The old advert goes first, so that no Active advert carries a stale `detail_hash` while the service restarts:

1. Check `curl -s http://127.0.0.1:8083/status` says `free`, and that no escrow is open against the advert.
2. Retire the old advert (Back out, point 1) and wait for it to confirm. From here until item 6 the agent has no advert.
3. In `.env.agent-history`, set `AGENT_STATUS_CHIP` to the new word and `AGENT_STATUS_SINCE` to today's date.
4. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate service`
5. Hash the new manifest (step 11).
6. Post the new advert (step 12). The new `ADVERT_REF` replaces the old one in the env file.
7. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate agent`, then steps 13 and 14 again.
8. In the repository, in a pull request, change every file that says PROPOSED about Agent History, and the tests that pin the word: `specs/agent-history.md` (Status), `agents/agent-history/README.md`, `README.md` (the table), `docs/HIRE.md`, `docs/E2E.md`, `deploy/host/README.md`, `deploy/host/RUNBOOK.md` (its first paragraph and step 14), the first lines of `deploy/host/docker-compose.agent-history.yml` and `deploy/host/Caddyfile.snippet`, and `deploy/host/.env.agent-history.example`. The code carries the word as a default too: the `proposed` default in `agents/agent-history/src/server.ts`, the manifest template `agents/agent-history/agent.json.template` (regenerate it from the code, never by hand) and the pins in `agents/agent-history/test/server.test.ts`. The tests are `agents/agent-history/test/spec.test.ts`, `scripts/specs.test.mjs` and `scripts/deploy.test.mjs`. They fail until all of the files agree. The Identity and Links sections of the spec (the DID, the stake, the public URL, the advert and its explorer link) were refreshed after steps 7 and 12; check that they are still true. The new advert has a new reference: replace the old one wherever it is given as the current advert (`specs/agent-history.md`, `docs/HIRE.md`, `docs/E2E.md` and the default of `ADVERT_REF` in `scripts/run-e2e-from-keyfile.sh`), and keep it in the Links section of the spec as the retired advert.

## Back out

To stop the agent, and as the first move of step 17. The order matters: the advert goes first, so that nobody can post an escrow against an agent that is about to stop.

1. Retire the advert. Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted, and there is nothing to retire (go on with point 2). Operator: the transaction is signed with the supplier key in the env file. Check `curl -s http://127.0.0.1:8083/status` says `free` (`working` means a job is in flight: wait for it). From `$BASE/repo/deploy/host`:

   ```sh
   docker compose -f docker-compose.agent-history.yml run --rm --no-deps -T agent \
     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \
     --advert-ref "$(sed -n 's/^ADVERT_REF=//p' .env.agent-history)"
   ```

   Wait for it to confirm. The units it locked come back.
2. Stop the containers, operator or host administrator: `docker compose -f docker-compose.agent-history.yml down`. The external network of the host's reverse proxy is not touched.
3. Host administrator: remove the Caddy block from the host's Caddy configuration, validate and reload ([README.md](README.md), point 4), and remove the DNS record if it will not be reused.
4. Operator: remove the second plaintext copy of the supplier key that step 7 wrote, two files in a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory). The env file still holds the key. When the identity or the stake is withdrawn later, `python3 make-skey.py` writes the files again from the env file for that signing, and they are removed again afterwards.

The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them. The deposit returns on deregistration and the stake after its cooldown.

## If something goes wrong

| What you see | Meaning | Next step |
|---|---|---|
| The runtime restarts and its log says `missing required env var ADVERT_REF` | It was started before the advert existed. | `docker compose -f docker-compose.agent-history.yml stop agent`, finish step 12, then step 13. |
| `/capability` shows an empty public key, or claims fail with `wrong_supplier` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. | Fill all four identity values from one key (step 4), then recreate. |
| Jobs fail with `service_unreachable` | The runtime cannot reach the service. | `docker exec agent-history-agent printenv SERVICE_URL` must print `http://agent-history-service:9091/`. Check that both containers run and sit on the external network of the host's reverse proxy. |
| The service container keeps restarting and `docker logs agent-history-service` says `environment variable OPERATOR_CONTACT is required` | The contact line in the env file is empty or missing. | Set it as in step 4, then `up -d --force-recreate service`. |
| The env file changed and nothing happened | `restart` does not re-read it. | `up -d --force-recreate <service>`. |
| `network <name> declared as external, but could not be found` | Wrong host, a wrong name in `.env`, or the stack of the host's reverse proxy is down. | Check the name in `.env` (step 1). If it is right, start the stack of the host's reverse proxy. |
| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |
| `pull access denied` for the service image | Not logged in to `ghcr.io`, or the image is not published yet. | Step 2. |
| `invalid reference format` for the service image | The placeholder `@sha256:<digest>` is still in the `image:` line of the compose file. | Record the digest and put it in, step 2. |
| The served `/agent.json` hashes differently from the advert's `detail_hash` | The manifest changed after the advert was posted: the env file, or a service image other than the digest the advert was hashed with. | Retire the advert (Back out, point 1), then repeat steps 11, 12 and 13. |

## Two gotchas that cost real transactions

Copied from the README of the operator's existing identity scripts. Do not re-learn them.

**1. Never re-serialize an MCP-built transaction.** `sign-tx.py` splices the
signature in while preserving every original byte of both the body and the
witness set. A decode/re-encode round-trip canonicalizes Plutus data's
indefinite-length arrays (`d8799f…ff` → definite), which changes
`script_data_hash` and the ledger rejects with `PPViewHashesDontMatch`
(observed on the first registry attempt). Re-serializing the body alone
changes the tx id and voids the signature.

**2. The Module-3 SDK is testnet-pinned.** `constants.py` ships
`SYSTEM_START_UNIX_S = 1752057484` (testnet genesis) plus testnet Ogmios and
submit URLs. On mainnet you must pass mainnet endpoints explicitly AND patch
the genesis constant to `1756485600`, or `StakeDatum.last_updated` lands ~51
days off, fails Rule 6 of `validate_create_stake`, and the script aborts with
an opaque "terminated with error". `m3-self-stake.py` patches it and asserts
the result against wall clock before locking anything.

