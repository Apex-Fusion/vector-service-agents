# Runbook: Agent History on apex-web

Status: PROPOSED. Nothing in this folder is LIVE or DEPLOYED. This runbook says what will happen, in order. None of it has been run on the box.

The operator holds the keys and does every step except step 10, which is the host administrator's (DNS and Caddy, see [README.md](README.md)). Every run of the agent is first-party until a payer outside our control appears. A first-party run shows that the path works. It is not demand and it counts as no revenue.

One thing about the order. The advert carries the sha256 of the manifest the service serves at `/agent.json`, and adverts are immutable. So everything the manifest contains (the agent identifier, the keys, the status word) has to be final before the hash is taken. That is why the identity is registered (steps 7 and 8) before the advert (step 12), and why changing the status afterwards costs a new advert (step 17).

## Funds

The Foundation funds two keys. Nobody pastes either key into a chat.

| Key | Funded with | Covers |
|---|---|---|
| Supplier key, generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral, never touched), then 50 units | The registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees. The rest pays the supplier's claim and submit fees. 25 would leave almost nothing for those, so fund 50. |
| Test buyer key, generated on the operator's own machine | Two transfers: 5 units alone, then 50 | The first-party run of step 15. A run costs about 3 units of the float. |

Two transfers, because a wallet funded in one lump can have its collateral spent as change by an ordinary transaction.

## 1. Put the files on the box

Operator. On the box, as the user that runs Docker:

```sh
mkdir -p /opt/agent-history && cd /opt/agent-history
git clone https://github.com/Apex-Fusion/vector-service-agents.git repo
cd repo/deploy/apex-web
git log -1 --oneline
```

The repository is private, so the box needs read access to it. Copying `deploy/apex-web` and `agents/agent-history` over `scp` also works if the layout stays the same. Check that the commit is the one that was reviewed. "This folder" below means `/opt/agent-history/repo/deploy/apex-web`.

## 2. Log in to the registry and get the service image

Operator, or the host administrator. The package is private; the token needs `read:packages`.

```sh
read -rs GHCR_TOKEN
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u <user> --password-stdin
unset GHCR_TOKEN
docker pull ghcr.io/apex-fusion/vector-service-agents/agent-history:latest
```

If CI has not published the image yet, build it from the repository root. Compose uses a local image that already has the right name:

```sh
cd /opt/agent-history/repo
docker build -f agents/agent-history/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/agent-history:latest .
cd deploy/apex-web
```

## 3. Build the runtime image

```sh
docker compose -f docker-compose.agent-history.yml build agent
```

This clones `vector-agent-template` at the pinned commit `c4c378a` and installs it. The compose file carries the full 40-character hash, because BuildKit does not resolve the short form. The first build takes a few minutes. It ends with `Image agent-history-agent Built`.

## 4. Make the env file and generate the supplier key

The key is generated on the box and never leaves it. This prints no secret: it writes the four values into the env file and shows only their lengths. From here on the compose commands need the external network `umami_default`, which exists on the box.

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

The key is a raw keypair and this file is the only copy. There is no recovery phrase, and nothing can derive it again. Copy `.env.agent-history` to the operator's encrypted offline store now, before the address receives anything. A wallet whose key is lost is gone, whatever the ledger shows for it.

## 5. Adapt the ops scripts

Operator. The identity steps use the ops scripts of the chandra stack, which are on the box in `/opt/chandra-supplier/ops` (from the HAL8 `chandra-supplier` repository). They are not copied into this repository: they carry mainnet paths, and `sign-tx.py` is the byte-preserving signer (first gotcha, at the end). Make adapted copies outside the git checkout, so that nothing they write can be committed:

```sh
mkdir -p /opt/agent-history/ops && cd /opt/agent-history/ops
for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do
  sed -e 's#/opt/chandra-supplier/supplier/\.env\.chandra#/opt/agent-history/repo/deploy/apex-web/.env.agent-history#g' \
      -e 's#/opt/chandra-supplier/ops#/opt/agent-history/ops#g' \
      "/opt/chandra-supplier/ops/$f" > "$f"
  chmod 755 "$f"
done
sed -i 's#chandra supplier#agent-history supplier#g' make-skey.py
DESC="The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Read-only; no model cost."
sed -i \
  -e 's#^ "name":"ChandraOCR",# "name":"Agent History",#' \
  -e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#" \
  -e 's#^ "capabilities":\[.*\],# "capabilities":["identity.history.report.v1"],#' \
  -e 's#^ "framework":"agents-marketplace",# "framework":"vector-service-agents",#' \
  -e 's#^ "endpoint":"https://mp-suppliers-chandra.hal8.ai"}# "endpoint":"https://mp-suppliers-history.hal8.ai"}#' \
  register-did.sh
sed -i 's#^CAPABILITIES = \[.*\]#CAPABILITIES = ["identity.history.report.v1"]#' m3-self-stake.py
grep -nE '"(name|description|capabilities|framework|endpoint)"' register-did.sh
grep -n '^CAPABILITIES' m3-self-stake.py
./setup-venv.sh
```

The `grep` lines must show the Agent History values and nothing of ChandraOCR. The description is the manifest's, and the registry takes at most 256 characters of it (this one is 214). `setup-venv.sh` builds the Python environment and clones the Module-3 SDK into `/opt/agent-history/ops`. It ends with `venv ok`.

## 6. Fund the supplier wallet

The Foundation. Read the address with `grep '^SUPPLIER_ADDRESS=' /opt/agent-history/repo/deploy/apex-web/.env.agent-history`, then send two separate transfers to it. The first is exactly 5 units, alone. Send the second, 50 units, only after the first has confirmed. Check:

```sh
cd /opt/agent-history/repo/deploy/apex-web
/opt/agent-history/ops/mcp-call.sh vector_get_utxos "{\"address\":\"$(sed -n 's/^SUPPLIER_ADDRESS=//p' .env.agent-history)\"}"
```

It must list two outputs: one of exactly 5 units and one for the second transfer.

## 7. Register the identity

Operator. This costs a deposit of 10 units, refundable on deregistration, and a fee.

```sh
cd /opt/agent-history/ops
sed -i '/^AGENT_DID=$/d' /opt/agent-history/repo/deploy/apex-web/.env.agent-history
python3 make-skey.py
./register-did.sh
```

The first line removes the empty `AGENT_DID=` line that came with the example: the script refuses to run when the name is already in the file, and it appends the real value. `make-skey.py` writes the signing key, in the form the signer reads, to `/opt/agent-history/ops/wallet` (mode 600). `register-did.sh` builds the registration on the hosted keyless MCP server, signs it locally with the byte-preserving signer, submits it, waits for it, and appends `AGENT_DID` and `AGENT_REGISTER_TX` to the env file. The record has the name `Agent History`, the capability `identity.history.report.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-history.hal8.ai` and the manifest's description.

Check: `grep -c '^AGENT_DID=did:vector:agent:' /opt/agent-history/repo/deploy/apex-web/.env.agent-history` prints 1. If the script stops with an error, read the first gotcha at the end before running it again. If it ends with `NOT CONFIRMED`, look at the explorer before running it again: the transaction may still land.

## 8. Stake in Module-3

Operator. This locks 10 units on the capability, refundable under the stake's own rules (a cooldown applies).

```sh
cd /opt/agent-history/ops
./venv/bin/python m3-self-stake.py
```

The staked capabilities must be a subset of the registry record's, and here both are the one capability `identity.history.report.v1`. The script patches the SDK's testnet genesis constant and asserts it against the wall clock before it spends anything (second gotcha). It appends `M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM` to the env file.

## 9. Start the service

Operator. Start `service` by name. A bare `docker compose up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.

```sh
cd /opt/agent-history/repo/deploy/apex-web
docker compose -f docker-compose.agent-history.yml up -d service
docker exec agent-history-service wget -qO- http://127.0.0.1:9091/healthz
docker exec agent-history-service wget -qO- http://127.0.0.1:9091/agent.json
```

`/healthz` answers `{"ok":true}`. The manifest must show the new DID in `identity.did`, the key hash in `identity.controller_pkh` and `keys.supplier_pkh`, the public key in `keys.pub_key_hex`, `status.chip` `proposed`, `status.since` `2026-10-13` and an empty `links.explorer_advert`. The advert's hash will cover exactly these bytes.

The service can report on itself. This shows what a buyer will get, including the registration of step 7 and the stake of step 8. Koios can take a minute to show a new registration:

```sh
DID=$(sed -n 's/^AGENT_DID=//p' .env.agent-history)
printf '[{"content":"{\\"subject\\":\\"%s\\"}","role":"user"}]' "$DID" \
  | docker exec -i agent-history-service wget -qO- --header='content-type: application/json' --post-file=/dev/stdin http://127.0.0.1:9091/ | head -c 700
```

## 10. DNS and Caddy

Host administrator, from [README.md](README.md) points 1 and 4: the DNS record for `mp-suppliers-history.hal8.ai` and the Caddy block, validated and reloaded. Check from any machine:

```sh
curl -fsS https://mp-suppliers-history.hal8.ai/agent.json
```

It must return the manifest of step 9, byte for byte. `/healthz` on the public name answers only after step 13, because every other path goes to the runtime.

## 11. Hash the manifest

Operator. From a checkout on any machine with Node 22 (it only fetches public bytes):

```sh
node scripts/manifest-hash.mjs https://mp-suppliers-history.hal8.ai
```

It prints one JSON line with `detail_uri`, `detail_hash` and `bytes`. Cross-check on the box with `curl -fsS https://mp-suppliers-history.hal8.ai/agent.json | sha256sum`: the 64 hex digits must be the same. If they differ, stop. Something between the box and the client rewrites the bytes.

## 12. Post the advert

Operator. From this folder. Set the hash, then run once with `--dry-run` and read the datum it prints: the capability, the model `agent-history-v1`, `max_processing_ms` 300000, the price and both bonds at 1000000, the endpoint, the detail URI, the hash and `status` Active. A dry run sends nothing.

```sh
cd /opt/agent-history/repo/deploy/apex-web
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

It must print `Active free identity.history.report.v1` and the hash of step 11. From here the agent is advertised and PROPOSED still stands: no job has settled.

## 15. The first-party run

Operator. Follow [E2E.md](../../docs/E2E.md) with `ADVERT_REF` from step 12 and the funded test buyer key. This is the step that proves the path, and nothing before it settles a job. As of 2026-10-13 the hosted MCP server has none of the nine marketplace tools the script needs. PR 1 is open as [Apex-Fusion/mcp-server#20](https://github.com/Apex-Fusion/mcp-server/pull/20) and PRs 2 and 3 follow. Until they are deployed, E2E.md says to build the PR 3 branch and run it locally. Add the run to the Results table in E2E.md. Only a run that ends in the printed evidence counts.

## 16. Wallet monitor

Operator. Add the supplier address to the fleet's wallet monitor (upstream repository), so that a drained float is seen before a claim fails.

## 17. Flip the status

Operator, and only after step 14 shows the advert Active and step 15 has ended with a settled first-party job. Then the status can honestly change from `proposed`. Set `deployed` or `live` as the operator decides: a first-party run shows that the path works, and it is not demand.

The status is in the manifest, so changing it changes the bytes the advert hashed, and a reader who compares the served manifest with the advert's `detail_hash` would see a mismatch. The advert has to be retired and posted again:

1. Check `curl -s http://127.0.0.1:8083/status` says `free`, and that no escrow is open against the advert.
2. In `.env.agent-history`, set `AGENT_STATUS_CHIP` to the new word and `AGENT_STATUS_SINCE` to today's date.
3. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate service`
4. Hash the new manifest (step 11).
5. Retire the old advert with the command in [README.md](README.md), Rollback, point 1, and wait for it to confirm.
6. Post the new advert (step 12). The new `ADVERT_REF` replaces the old one in the env file.
7. `docker compose -f docker-compose.agent-history.yml up -d --force-recreate agent`, then steps 13 and 14 again.
8. In the repository, in a pull request, change the status words that say PROPOSED: the Status section and opening lines of `specs/agent-history.md`, the table in the root `README.md`, `docs/HIRE.md`, and `.env.agent-history.example`. The tests that pin them (`agents/agent-history/test/spec.test.ts`, `scripts/specs.test.mjs`, `scripts/deploy.test.mjs`) fail until all of them agree.

## If something goes wrong

| What you see | Meaning | Next step |
|---|---|---|
| The runtime restarts and its log says `missing required env var ADVERT_REF` | It was started before the advert existed. | `docker compose -f docker-compose.agent-history.yml stop agent`, finish step 12, then step 13. |
| `/capability` shows an empty public key, or claims fail with `wrong_supplier` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. | Fill all four identity values from one key (step 4), then recreate. |
| Jobs fail with `service_unreachable` | The runtime cannot reach the service. | `docker exec agent-history-agent printenv SERVICE_URL` must print `http://agent-history-service:9091/`. Check that both containers run and sit on `umami_default`. |
| The env file changed and nothing happened | `restart` does not re-read it. | `up -d --force-recreate <service>`. |
| `network umami_default declared as external, but could not be found` | Wrong host, or the umami stack is down. | Start the umami stack. |
| `pull access denied` for the service image | Not logged in to `ghcr.io`, or the image is not published yet. | Step 2. |
| The served `/agent.json` hashes differently from the advert's `detail_hash` | The manifest changed after the advert was posted. | Step 17, items 4 to 7. |

## Two gotchas that cost real transactions

Copied from the chandra ops README. Do not re-learn them.

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
the result against wall clock before spending anything.

