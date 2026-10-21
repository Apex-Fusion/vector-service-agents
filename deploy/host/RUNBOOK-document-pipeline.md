# Runbook: Document Pipeline on the deployment host

Status: DEPLOYED since 2026-10-16. Nothing in this folder is LIVE. This runbook says what happens, in order. Steps 1 to 15 and 17 were run on 2026-10-16, and the first stop was watched the same day (the service was idle, the stop took 1 s, the exit code was 0). Step 16, the wallet monitor, is not used for this agent, as for Agent History.

This is [RUNBOOK.md](RUNBOOK.md), the runbook of Agent History, written for the Document Pipeline. Agent History ran its runbook in full on 2026-10-14 and 2026-10-15, so the mechanics are proven, and this runbook keeps its structure and its numbers: step N here is step N there. Where a step is the same, it gives the commands with this agent's names, and RUNBOOK.md explains them. Where the Pipeline differs, the step says how. The notes of that deployment, with no secrets in them, are in `$HISTORY_BASE/DEPLOY-NOTES.md` on the box (the names table below says what `HISTORY_BASE` is): read them before step 1.

What differs from Agent History, in one place:

- **Two keys.** The runtime holds the supplier key. The service holds a second, separate key, the buyer key, that posts the escrows of the sub-jobs it hires, so that its Posts and the supplier key's Claims never contend for the same outputs. Both are made on the box in step 4, and both wallets receive their collateral and float in step 6. The compose file gives each container only its own key: the other one is blanked in its environment.
- **The service locks value.** Every job posts escrows from the buyer wallet. The service answers `POST /` only to a call that carries the token the runtime sends (`SERVICE_AUTH_HEADER`, made in step 4, ruling R50) and gives a `POST /` without it 401, because the network is shared with other stacks; any other path but `/healthz` and `/agent.json` gets 404. Its port 9092 is never published all the same, and a job is refused up front, locking nothing, when the buyer wallet cannot cover it.
- **A window of 30 min where Agent History has 5.** The advert's `max_processing_ms` is 1800000 and the runtime's `SERVICE_TIMEOUT_MS` is 1680000. A job of five pages takes up to 27 min. The service writes an interim `102 Processing` line to the runtime every 60 s, because the runtime's fetch gives up on 300 s of silence (step 13).
- **State and a clean stop.** The service keeps `stranded.json`, the list of escrows a job left behind, in the volume `document-pipeline-state`, and its janitor settles them. A stop gives the service up to 300 s to finish the job that is running, and Docker 30 s more for it to log a job it abandoned and exit (`stop_grace_period: 330s`), and the container has a memory limit of 1536m.
- **No registry.** The service image is built on the box and pinned there (step 2), and the repository goes to the box as a git bundle (step 1), because the box has no GitHub credentials.
- **Price 5.** The advert's price is 5000000 lovelace and each bond 1000000. The Foundation carries the gap between what the sub-jobs cost and that price on purpose (`specs/document-pipeline.md`, Terms).

The names used below:

| Thing | Here |
|---|---|
| Base path on the box | `$BASE`, the folder the operator chose for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |
| Base path of Agent History | `$HISTORY_BASE`, the `BASE` of RUNBOOK.md: its ops scripts, its install script and the notes of its deployment |
| "This folder" | `$BASE/repo/deploy/host` |
| Compose file, env file | `docker-compose.document-pipeline.yml`, `.env.document-pipeline` |
| Containers | `document-pipeline-agent` (the runtime), `document-pipeline-service` |
| Ports | the runtime on `127.0.0.1:8084`, loopback only; the service on 9092, never published |
| Public name | `mp-suppliers-pipeline.hal8.ai` |
| State volume | `document-pipeline-state`, mounted at `/data` |
| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |

The commands use the two base paths as variables. Set both in every new shell on the box before the commands below:

```sh
BASE=/opt/document-pipeline
HISTORY_BASE=/opt/agent-history
```

The operator holds the keys and does every step except two. Step 6 (the collateral and float of the two wallets) is the Foundation's. Step 10 (DNS and Caddy) is the host administrator's, see [README.md](README.md). Step 2 is the operator's here, because nothing is pulled from a registry. Every run of the agent is first-party until a buyer outside our control appears. A first-party run shows that the path works. It is not demand.

One thing about the order, as for Agent History. The advert carries the sha256 of the manifest the service serves at `/agent.json`, and adverts are immutable, so everything the manifest contains (the agent identifier, the keys, the status word) has to be final before the hash is taken. That is why the identity is registered (steps 7 and 8) before the advert (step 12), and why changing the status afterwards costs a new advert (step 17).

## Collateral and float

The Foundation supplies two keys with their collateral and float. Nobody pastes either key into a chat.

| Key | Supplied with | Covers |
|---|---|---|
| Supplier key (the runtime's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral), then 50 units | As for Agent History: the registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees. The rest covers the supplier's claim and submit fees. |
| Buyer key (the service's), generated on the box in step 4 | Two transfers to its address: exactly 5 units alone (collateral for the Accept and the Reclaim of the sub-jobs, held back from every Post while the rest of the wallet covers that Post and its change), then 100 units | The sub-jobs the service hires: the OCR hops at about 2.2 net per page (price 0.2, supplier bond 1, fees about 1) plus the chat hop at about the same, so about 13 net for a job of five pages, against its price of 5. The locks and fees in flight for such a job come to about 19, of which the buyer bonds and the lock excess return on Accept (`specs/document-pipeline.md`, Terms). These figures hold at today's fleet price of 0.2 per sub-job; the service hires no advert priced above `OCR_MAX_PRICE_LOVELACE` or `LLM_MAX_PRICE_LOVELACE` (1 unit each unless the env file says otherwise). A job is refused with `insufficient_float` (503), and `/healthz` of the service turns 503, when the float outside the collateral is under (max_pages + 1) x 4.5, which is 27 for five pages; a job is also refused, before its first Post, when the float does not cover the locks and fees at the prices of the adverts it chose. 100 covers several jobs of five pages at about 19 each in flight, and the buyer bonds and the lock excess come back as the Accepts land. |

Two transfers, because a wallet supplied in one transfer can have its collateral spent as change by an ordinary transaction.

On 2026-10-17, for Audio Snippets, the setup transactions (steps 7, 8 and 12) used the 5-unit output as an input, so it did not stay alone; the supplier's Claim and Submit still found collateral in the change.

The key of the first-party run (step 15) is a third key and gets no collateral or float here: it is the operator's own test buyer key, the kind that hired Agent History in step 15 of RUNBOOK.md. A job of the Pipeline costs the hirer about 7 (`docs/HIRE.md`, section 3), so that key needs its 5 alone and a float of at least 9 for the run, the lock of 7 and about 2 more (`docs/HIRE.md`, section 8). The float left from the Agent History run may be enough: the operator checks it before step 15, and asks the Foundation for a top-up if it is not.

## 1. Put the files on the box

Operator. The box has no GitHub credentials, so the repository goes over as a git bundle. On the operator's machine, in a checkout of `main` at the commit that was reviewed:

```sh
git bundle create vector-service-agents.bundle main
git bundle verify vector-service-agents.bundle
scp vector-service-agents.bundle <user>@<box>:/tmp/
```

On the box, as the user that runs Docker:

```sh
mkdir -p "$BASE" && cd "$BASE"
git clone --branch main /tmp/vector-service-agents.bundle repo
cd repo/deploy/host
git log -1 --oneline
```

`--branch main` is needed: a bundle of `main` alone has no `HEAD`, and a plain clone of it checks nothing out. Check that the commit is the one that was reviewed. "This folder" below means `$BASE/repo/deploy/host`.

Then name the network, as in step 1 of RUNBOOK.md: compose reads `PROXY_NETWORK`, the external network of the host's reverse proxy, from `.env` in this folder for every compose command (the first is in step 3), and stops while it has no value. It is the network Agent History is on, and the host administrator gives the name ([README.md](README.md)). In this folder:

```sh
echo 'PROXY_NETWORK=<the network the host administrator names>' > .env
docker network inspect --format '{{.Name}}' "$(sed -n 's/^PROXY_NETWORK=//p' .env)"
```

The second line must print the name back. An error means that this host has no network of that name. `.env` holds no secret and is covered by the repository's `.gitignore`.

## 2. Build the service image and pin it

Operator. Nothing is pulled from a registry for this agent, so there is no login. Build the image from the repository root, which is the build context:

```sh
cd "$BASE/repo"
docker build -f agents/document-pipeline/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/document-pipeline:latest .
cd deploy/host
```

The build installs the workspace from the lockfile and `poppler-utils` with a base font, and takes a few minutes. CI publishes the same image under `:latest` and `:<full git commit sha>` on every merge to `main`; the box still builds its own.

Then pin the image, as in step 2 of RUNBOOK.md. The manifest that the service renders is hashed into the advert (step 12), and `:latest` moves, so the compose file names the image by digest. It ships with the placeholder `@sha256:<digest>`, and compose refuses to start the service (`invalid reference format`) until the placeholder is replaced. This takes the digest where Docker keeps one for the image, and the image ID where it keeps none (an image built on the box by a Docker that keeps no digest for local images), and writes it into the `image:` line:

```sh
IMAGE=ghcr.io/apex-fusion/vector-service-agents/document-pipeline
PIN=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:latest" 2>/dev/null || docker image inspect --format '{{.Id}}' "$IMAGE:latest")
if printf '%s\n' "$PIN" | grep -Eq "^($IMAGE@sha256:|sha256:)[0-9a-f]{64}\$"; then
  sed -i "s|^    image: .*|    image: $PIN|" docker-compose.document-pipeline.yml
else
  echo "unexpected output, do not continue" >&2
fi
grep -n '^    image: ' docker-compose.document-pipeline.yml
```

The last command prints one line, the `image:` line of `service`, with `@sha256:` or `sha256:` and 64 hex digits. That is the only local change to the checkout, and it has to be made before step 9. The pinned image has to stay on the box: it cannot be pulled, so `docker image prune -a`, which removes every image that no container uses, would remove the only copy once the containers are gone. Do not build over the pinned service after the advert is posted: a new build has a new ID and can change the manifest, so the hash of step 11 would have to be taken again.

## 3. Build the runtime image

Operator.

```sh
docker compose -f docker-compose.document-pipeline.yml build agent
```

This clones `vector-agent-template` at the pinned commit `c4c378a`, the commit of Agent History's runtime, and installs it. The compose file carries the full 40-character hash, because BuildKit does not resolve the short form. It ends with `Image document-pipeline-agent Built`.

## 4. Make the env file and generate the two keys

Operator. The two keys and the token between the two containers are generated on the box and are never sent anywhere. Nothing secret is printed: each value is written into the env file, and only the lengths are shown. From here on the compose commands need the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, step 1), which exists on the box.

This step makes things once and replaces nothing. The env file is made from the example only when there is none, and each key and the token are written only into an empty line. A block that is run a second time says `refusing:` and changes nothing, and that is the point: once a wallet holds units, a new key in its place is a lost wallet, and a copy of the example over the env file would replace both keys at once. To make a key again while its address has received nothing, empty its four lines by hand (the failure table says how) and run only the block of that key.

The token is the value of `SERVICE_AUTH_HEADER`. The runtime sends it as the `authorization` header of every call to the service, and the service answers `POST /` only to a call that carries exactly that value (ruling R50), because other stacks share the external network of the host's reverse proxy and a job posts escrows from the buyer wallet. Both containers read it from the env file, and neither blanks it. It is written in quotes, `SERVICE_AUTH_HEADER="Bearer <64 hex>"`: the ops scripts read the file with the shell's `.`, and without the quotes the shell would run the hex as a command and stop with exit 127. Docker Compose takes the quotes off, so the containers see `Bearer ` and the 64 hex digits, 71 characters.

The first block makes the env file and defines the two functions that the next blocks use. It is safe to paste again, in any new shell: it makes the file only if there is none.

```sh
cd "$BASE/repo/deploy/host"
umask 077
# keypair_into PREFIX makes one keypair with gen-keypair and writes its four values into the env file, as PREFIX_PRIV_KEY_HEX, PREFIX_PUB_KEY_HEX, PREFIX_PKH and PREFIX_ADDRESS.
# It writes into an empty place only: it refuses when the file is not here or when the key already has a value, so a key that may hold units is never replaced.
keypair_into() {
  [ -f .env.document-pipeline ] || { echo "refusing: there is no .env.document-pipeline in this folder" >&2; return 1; }
  [ -z "$(sed -n "s/^${1}_PRIV_KEY_HEX=//p" .env.document-pipeline)" ] || { echo "refusing: ${1}_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced" >&2; return 1; }
  json=$(docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent \
    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1) || { echo "gen-keypair failed" >&2; return 1; }
  for pair in privateKeyHex:${1}_PRIV_KEY_HEX publicKeyHex:${1}_PUB_KEY_HEX pubKeyHash:${1}_PKH address:${1}_ADDRESS; do
    field=${pair%%:*}; name=${pair##*:}
    value=$(printf '%s\n' "$json" | sed -n "s/.*\"$field\": *\"\([0-9a-z]*\)\".*/\1/p")
    [ -n "$value" ] || { echo "no $field in the keypair output" >&2; json=; return 1; }
    sed -i "s|^$name=.*|$name=$value|" .env.document-pipeline
  done
  json=; value=
}
# token_into makes the token and writes it into the env file, in quotes. The same rule: it refuses when the line already has a value.
token_into() {
  [ -f .env.document-pipeline ] || { echo "refusing: there is no .env.document-pipeline in this folder" >&2; return 1; }
  [ -z "$(sed -n 's/^SERVICE_AUTH_HEADER=//p' .env.document-pipeline | tr -d '"')" ] || { echo "refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first" >&2; return 1; }
  value=$(openssl rand -hex 32) && [ "${#value}" = 64 ] || { echo "openssl rand failed" >&2; value=; return 1; }
  sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $value\"|" .env.document-pipeline
  value=
}
# The env file is made once, from the example, and never over one that is there: that one may hold keys whose wallets hold units.
if [ -e .env.document-pipeline ]; then
  echo "refusing: the env file exists, and it is kept as it is" >&2
else
  cp .env.document-pipeline.example .env.document-pipeline && chmod 600 .env.document-pipeline
fi
```

Then the supplier key, the buyer key and the token, one block each. The buyer key has a block of its own, so that it can be made again alone, and no block touches a line that already has a value:

```sh
cd "$BASE/repo/deploy/host"
keypair_into SUPPLIER
```

```sh
cd "$BASE/repo/deploy/host"
keypair_into PIPELINE_BUYER
```

```sh
cd "$BASE/repo/deploy/host"
token_into
```

The supplier block makes the supplier key and fills the supplier lines of the env file. The buyer block makes another key and fills the buyer lines. The token block makes the token. Check the lengths of what was written:

```sh
awk -F= '/^(SUPPLIER|PIPELINE_BUYER)_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/ { v = $2; gsub(/"/, "", v); print $1, length(v) }' .env.document-pipeline
```

The last command must print `SUPPLIER_PRIV_KEY_HEX 64`, `SUPPLIER_PUB_KEY_HEX 64`, `SUPPLIER_PKH 56`, `SUPPLIER_ADDRESS 58`, `PIPELINE_BUYER_PRIV_KEY_HEX 64`, `PIPELINE_BUYER_PUB_KEY_HEX 64`, `PIPELINE_BUYER_PKH 56`, `PIPELINE_BUYER_ADDRESS 58` and `SERVICE_AUTH_HEADER 71` (`Bearer ` and 64 hex digits; the quotes are not counted). All nine are needed. An empty public key breaks the receipt check, an empty supplier key hash makes the runtime reject its own claims as `wrong_supplier`, the service stops at start when a buyer value is not the key's, and it stops at start without the token. Then check that the two keys are two, from their public key hashes:

```sh
[ "$(sed -n 's/^SUPPLIER_PKH=//p' .env.document-pipeline)" != "$(sed -n 's/^PIPELINE_BUYER_PKH=//p' .env.document-pipeline)" ] && echo "two different keys" || echo "THE TWO KEYS ARE THE SAME: stop, empty the four buyer lines and run the buyer block again"
```

Then set the contact address, the one value in the file that is not generated. `OPERATOR_CONTACT` is required: the service stops at start without it, and the address is published in the manifest that the advert hashes, so it is final before step 11. Use the role address that the Foundation confirms, never a person's address. The line holds a placeholder in angle brackets from the example. Edit it in place, then check:

```sh
grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.document-pipeline
```

It must print 1: a value that does not start with an angle bracket.

The example also carries the current status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`. On a first run, before any job has settled, set them to `proposed` and today's date: the status can honestly change only in step 17.

Both keys are raw keypairs, and this file is the only copy of either until step 7. There is no recovery phrase, and nothing can derive a key again. Copy `.env.document-pipeline` to the operator's encrypted offline store now, before either address receives anything, and copy it again after any regeneration of a key or of the token: a copy made before holds the old key, and the new one has no copy at all. A wallet whose key is lost is gone, whatever the ledger shows for it. Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`: from then on the supplier key is in two files on the box, and both are protected the same way. The buyer key never has a second copy on the box.

## 5. Adapt the ops scripts

Operator. The identity steps use the ops scripts that Agent History already adapted from the operator's existing identity scripts, in `$HISTORY_BASE/ops` (RUNBOOK.md, step 5, says why they are not in this repository and why the signer is the byte-preserving one). Make a second adapted copy for the Pipeline, outside the git checkout, so that nothing they write can be committed. Only the six scripts are copied; the venv and the wallet directory of Agent History stay where they are:

```sh
mkdir -p "$BASE/ops" && cd "$BASE/ops"
for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do
  sed -e "s#$HISTORY_BASE/repo/deploy/host/\.env\.agent-history#$BASE/repo/deploy/host/.env.document-pipeline#g" \
      -e "s#$HISTORY_BASE/ops#$BASE/ops#g" \
      "$HISTORY_BASE/ops/$f" > "$f"
  chmod 755 "$f"
done
sed -i 's#agent-history supplier#document-pipeline supplier#g' make-skey.py
DESC="Reads a document: OCR for each page, then a summary or a structured extraction, with every sub-receipt checked and one receipt over the whole bundle."
sed -i \
  -e 's#^ "name":"Agent History",# "name":"Document Pipeline",#' \
  -e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#" \
  -e 's#^ "capabilities":\[.*\],# "capabilities":["document.pipeline.ocr-summary.v1"],#' \
  -e 's#^ "endpoint":"https://mp-suppliers-history.hal8.ai"}# "endpoint":"https://mp-suppliers-pipeline.hal8.ai"}#' \
  register-did.sh
sed -i 's#^CAPABILITIES = \[.*\]#CAPABILITIES = ["document.pipeline.ocr-summary.v1"]#' m3-self-stake.py
grep -nE '"(name|description|capabilities|framework|endpoint)"' register-did.sh
grep -n '^CAPABILITIES' m3-self-stake.py
grep -il 'agent.history' *.sh *.py
```

The first two `grep` lines must show the Document Pipeline values and nothing of Agent History, and the third must print nothing. The framework line is the same as for Agent History, `vector-service-agents`. The description is the manifest's, and the registry takes at most 256 characters of it (this one is 149). Then the Python environment. It is made first and `cbor2` pinned, because on 2026-10-14 pip resolved `cbor2` 6.1.5 for Agent History, which breaks `cbor2pure`, and its venv runs 5.6.5. `setup-venv.sh` then builds the rest of the environment and clones the Module-3 SDK into `$BASE/ops`:

```sh
python3 -m venv venv
./venv/bin/pip -q install 'cbor2==5.6.5'
./setup-venv.sh
./venv/bin/pip show cbor2 | grep '^Version'
./venv/bin/python -c "import pycardano, reputation_staking"
```

`setup-venv.sh` does not end with `venv ok` on this box: it ends with a traceback from its last line, `module 'pycardano' has no attribute '__version__'`, after everything is installed, and the venv is complete all the same (it ended so for Audio Snippets on 2026-10-16, whose venv has the same packages as this one, and steps 7 and 8 of RUNBOOK-audio-snippets.md ran on that venv). The check that holds is the last two lines of the block: `./venv/bin/pip show cbor2 | grep '^Version'` prints `Version: 5.6.5`, and `./venv/bin/python -c "import pycardano, reputation_staking"` exits 0.

## 6. Supply the two wallets with their collateral and float

The Foundation. Read the two addresses with `grep -E '^(SUPPLIER|PIPELINE_BUYER)_ADDRESS=' "$BASE/repo/deploy/host/.env.document-pipeline"`, then send two separate transfers to each. The first is exactly 5 units, alone. Send the second only after the first has confirmed: 50 units to the supplier address, 100 units to the buyer address. Check both:

```sh
cd "$BASE/repo/deploy/host"
for name in SUPPLIER_ADDRESS PIPELINE_BUYER_ADDRESS; do
  echo "== $name"
  "$BASE/ops/mcp-call.sh" vector_get_utxos "{\"address\":\"$(sed -n "s/^$name=//p" .env.document-pipeline)\"}"
done
```

Each address must list two outputs: one of exactly 5 units and one for the second transfer.

## 7. Register the identity

Operator. The same as step 7 of RUNBOOK.md, for the supplier key only. This costs a deposit of 10 units, refundable on deregistration, and a fee. Read the first gotcha at the end of RUNBOOK.md before the first run.

```sh
cd "$BASE/ops"
sed -i '/^AGENT_DID=$/d' "$BASE/repo/deploy/host/.env.document-pipeline"
python3 make-skey.py
./register-did.sh
```

The first line removes the empty `AGENT_DID=` line that came with the example: the script refuses to run when the name is already in the file, and it appends the real value. `make-skey.py` writes the signing key of the supplier, in the form the signer reads, into the directory `$BASE/ops/wallet` (`payment.skey` and `payment.vkey`, mode 600). `payment.skey` is a second plaintext copy of the supplier key, next to the one in the env file. Keep it as private as the env file, and remove it in Back out (point 5). The buyer key is not touched by any step here and has no second copy on the box. `register-did.sh` builds the registration on the hosted keyless MCP server, signs it locally with the byte-preserving signer, submits it, waits for it, and appends `AGENT_DID` and `AGENT_REGISTER_TX` to the env file. The record has the name `Document Pipeline`, the capability `document.pipeline.ocr-summary.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-pipeline.hal8.ai` and the manifest's description.

Check: `grep -c '^AGENT_DID=did:vector:agent:' "$BASE/repo/deploy/host/.env.document-pipeline"` prints 1. If the script stops with an error, read the first gotcha at the end of RUNBOOK.md before running it again. If it ends with `NOT CONFIRMED`, look at the explorer before running it again: the transaction may still land.

Record the identity in the repository. Once the check above prints 1, open a pull request that puts the DID and the registration transaction into the Identity section of `specs/document-pipeline.md` (the DID row, the "Registry record" row and the sentence that says the agent has a registry record), together with the test that pins them in `scripts/specs.test.mjs`. The status word does not change here. Step 17 is the only place that flips it.

## 8. Stake in Module-3

Operator. The same as step 8 of RUNBOOK.md: this locks 10 units on the capability. The owner cannot withdraw it: the module keeps 10 units as the minimum, and only stake above it can be decreased. Read the second gotcha at the end of RUNBOOK.md before the run.

```sh
cd "$BASE/ops"
./venv/bin/python m3-self-stake.py
```

The staked capabilities must be a subset of the registry record's, and here both are the one capability `document.pipeline.ocr-summary.v1`. The script patches the SDK's testnet genesis constant and asserts it against the wall clock before it locks anything. It appends `M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM` to the env file.

## 9. Start the service

Operator. Start `service` by name. A bare `docker compose up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.

First check the pin of step 2. The `image:` line of `service` must name a digest or an image ID of 64 hex digits in place of the placeholder, or compose stops with `invalid reference format`:

```sh
cd "$BASE/repo/deploy/host"
grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/document-pipeline@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.document-pipeline.yml
```

It prints that line. Then start the service and read it:

```sh
docker compose -f docker-compose.document-pipeline.yml up -d service
docker logs document-pipeline-service
docker exec document-pipeline-service node -e "fetch('http://127.0.0.1:9092/healthz').then(async (r) => console.log(r.status, await r.text()))"
docker exec document-pipeline-service node -e "fetch('http://127.0.0.1:9092/agent.json').then((r) => r.json()).then((m) => console.log(JSON.stringify({ contact: m.operator.contact, did: m.identity.did, controller_pkh: m.identity.controller_pkh, keys: m.keys, status: m.status, explorer_advert: m.links.explorer_advert }, null, 2)))"
docker exec document-pipeline-service node -e "fetch('http://127.0.0.1:9092/', { method: 'POST', body: 'x' }).then(async (r) => console.log(r.status, await r.text()))"
docker inspect --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}}' document-pipeline-service
docker exec document-pipeline-service sh -c 'pdfinfo -v 2>&1 | head -1; pdftoppm -v 2>&1 | head -1'
```

The log shows `[document-pipeline] listening on 0.0.0.0:9092; buyer address <the buyer address of step 4>; state directory /data` and no `cannot start`. The service asks `pdfinfo` and `pdftoppm` for their version before it listens and does not start without them, so a `listening on` line means both ran, and the last command shows the same two versions. `/healthz` answers `200 {"ok":true}`. The first answer is given before the first check of the buyer wallet has finished (the check is made at most once a minute, in the background), so ask again after a minute. `503 {"ok":false,"reason":"insufficient_float"}` means the buyer wallet cannot cover a job of five pages (the table at the end). The manifest must show the role address of step 4 in `operator.contact`, the new DID in `identity.did`, the key hash in `identity.controller_pkh` and `keys.supplier_pkh`, the public key in `keys.pub_key_hex`, the key hash of the buyer key in `keys.buyer_pkh` (the service derives it from the key, and it must equal `PIPELINE_BUYER_PKH` in the env file), `status.chip` and `status.since` as the env file sets them (step 4), and an empty `links.explorer_advert`. The advert's hash will cover exactly these bytes. A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`: the service refuses a call that does not carry the token of step 4 before it reads the body. The service does not start without that token (`environment variable SERVICE_AUTH_HEADER is required`, in the table at the end). The `inspect` line prints `1610612736 330`: the memory limit of 1536m in bytes and the stop timeout of 330 s, 30 s more than the service waits for a job.

## 10. DNS and Caddy

Host administrator, from [README.md](README.md) (the Document Pipeline section): the DNS record for `mp-suppliers-pipeline.hal8.ai`, DNS only, and the Caddy block, validated and reloaded. The block is merged by a copy of the install script of Agent History, which is idempotent and refuses while the name does not resolve to the box. The copy has this agent's vhost and snippet. Make it once, on the box:

```sh
cd "$BASE/ops"
sed -e 's#^VHOST=.*#VHOST=mp-suppliers-pipeline.hal8.ai#' \
    -e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.document-pipeline.snippet#" \
    "$HISTORY_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh
chmod 755 install-caddy-route.sh
grep -nE '^(VHOST|SNIPPET|MARKER)=' install-caddy-route.sh
```

The `grep` must show the vhost and the snippet of the Pipeline. If a line does not show, the copy of Agent History names them differently: read the script, and change its vhost and its snippet path by hand. If the `MARKER=` line still names Agent History, correct it with `sed -i '/^MARKER=/s#agent-history#document-pipeline#g' install-caddy-route.sh`: the marker is the comment the script writes above the block in the Caddyfile, and it says what manages the block. Then check that nothing of Agent History is left in the copy:

```sh
grep -in history install-caddy-route.sh
```

It may print a comment line of the copy: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of the other stack is what must not appear: change it by hand to this agent's before the script runs, because it would act on the wrong stack. Run `./install-caddy-route.sh` once the record resolves to the box. The copy may poll `/healthz` on the public name after it has reloaded Caddy, and that route goes to the runtime, which does not exist before step 13. So before step 13 the script can wait on that poll, or end with exit code 2, with the block already in place. Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the box, the record is not there yet: wait for it and run the script again. Check from any machine:

```sh
curl -fsS https://mp-suppliers-pipeline.hal8.ai/agent.json
```

It must return the manifest of step 9, byte for byte. `/healthz` on the public name answers only after step 13, because every other path goes to the runtime.

## 11. Hash the manifest

Operator. As in step 11 of RUNBOOK.md. The script runs on the operator's machine, from the root of a checkout of the repository, with Node 22: the box has no Node. It only fetches public bytes:

```sh
node scripts/manifest-hash.mjs https://mp-suppliers-pipeline.hal8.ai
```

It prints one JSON line with `detail_uri`, `detail_hash` and `bytes`. The box cross-checks the raw bytes with `curl -fsS https://mp-suppliers-pipeline.hal8.ai/agent.json | sha256sum`: the two must agree. If they differ, stop. Something between the box and the client rewrites the bytes.

## 12. Post the advert

Operator. From this folder. As in step 12 of RUNBOOK.md, with the terms of the Pipeline. Set the hash, then run once with `--dry-run` and read the datum it prints: the capability, the model `document-pipeline-v1`, `max_processing_ms` 1800000, the price 5000000 and both bonds at 1000000, the endpoint, the detail URI, the hash and `status` Active. A dry run sends nothing.

```sh
cd "$BASE/repo/deploy/host"
DETAIL_HASH=<the 64 hex digits from step 11>
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts --dry-run \
  --capability-id document.pipeline.ocr-summary.v1 \
  --model document-pipeline-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 5000000 \
  --max-processing-ms 1800000 \
  --endpoint-url https://mp-suppliers-pipeline.hal8.ai \
  --detail-uri https://mp-suppliers-pipeline.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH"
```

Then the same command without `--dry-run`, which posts the advert. It locks about 2 units, returned when the advert is retired, and costs a fee:

```sh
ADVERT_REF=$(docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts \
  --capability-id document.pipeline.ocr-summary.v1 \
  --model document-pipeline-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 5000000 \
  --max-processing-ms 1800000 \
  --endpoint-url https://mp-suppliers-pipeline.hal8.ai \
  --detail-uri https://mp-suppliers-pipeline.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH" | tail -1)
echo "$ADVERT_REF"
printf '%s' "$ADVERT_REF" | grep -Eq '^[0-9a-f]{64}#[0-9]+$' || echo "unexpected output, do not continue"
sed -i "s|^ADVERT_REF=.*|ADVERT_REF=$ADVERT_REF|; s|^ADVERT_DETAIL_HASH=.*|ADVERT_DETAIL_HASH=$DETAIL_HASH|" .env.document-pipeline
```

`--max-output-tokens` is required: without it the command stops with `missing required env var: ADVERT_MAX_OUTPUT_TOKENS`. 8192 is the value in the template's README. The runtime does not meter tokens for a custom capability, and its receipts record zero. The bonds are not in the flags: the command reads `ADVERT_SUPPLIER_BOND_LOVELACE` and `ADVERT_BUYER_BOND_LOVELACE` from the env file, 1000000 each.

If the command stops with an error after the transaction went out, look at the indexer (step 14) before running it again, so that a second advert is not posted.

Record the advert in the repository. In a pull request, put the explorer link of the advert transaction in the Links section of `specs/document-pipeline.md`, in place of the line that says the advert is not posted. The link is `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/` followed by the transaction id, which is `ADVERT_REF` up to the `#`. In the same pull request refresh the rows of the Identity table that still say "planned" or "not in service" and have become true by now (the reputation stake of step 8, the public URL of steps 10 and 13). The manifest keeps an empty `links.explorer_advert`: the advert's own transaction id cannot be inside the manifest the advert hashes. The status word stays PROPOSED until step 17.

## 13. Start the runtime

Operator. The env file changed, so create the container fresh:

```sh
docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate agent
curl -s http://127.0.0.1:8084/healthz
curl -s http://127.0.0.1:8084/capability
curl -s http://127.0.0.1:8084/status
```

`/healthz` answers `{"ok":true}`. `/capability` shows the advert, with `document.pipeline.ocr-summary.v1` and the public key. `/status` says `free`. If `/capability` says `advert_unavailable`, the advert has not confirmed yet: wait a minute and ask again. Then the same through the public name: `/healthz`, `/capability` and `/agent.json` on `https://mp-suppliers-pipeline.hal8.ai`.

The runtime and the service must hold the same token. Compare them without printing it: the first figure is the length (71) and the second the first twelve hex digits of the sha256 of the value.

```sh
for c in document-pipeline-agent document-pipeline-service; do
  docker exec "$c" node -e "const v = process.env.SERVICE_AUTH_HEADER ?? ''; console.log(v.length, require('node:crypto').createHash('sha256').update(v).digest('hex').slice(0, 12))"
done
```

The two lines must be the same. `0 e3b0c44298fc` is an empty token, and two lines that differ mean that one container was created from another version of the env file (the table at the end, `service_http_401`).

One difference matters from here on. A job takes minutes, and the runtime calls the service with a plain `fetch` that gives up on a response that has not begun after 300 s. So the service writes an interim `102 Processing` line every 60 s while a job runs, ahead of the answer, and the runtime reads past it. A job that fails as `service_unreachable` at about the five-minute mark means those lines are not arriving (the table at the end).

## 14. Check the advert on the indexer

Operator. The indexer takes a short while to pick up a new advert.

```sh
curl -fsS https://mp-indexer.vector.apexfusion.org/suppliers \
  | ADVERT_REF=$(sed -n 's/^ADVERT_REF=//p' .env.document-pipeline) python3 -c '
import json, os, sys
for r in json.load(sys.stdin):
    if r["utxo_ref"] == os.environ["ADVERT_REF"]:
        print(r["advert_status"], r["status"], r["capability_id"], r["detail_hash"])
'
```

The fetch uses `curl` on purpose: the indexer answers 403 to the default user agent of Python's `urllib`.

It must print `Active free document.pipeline.ocr-summary.v1` and the hash of step 11. From here the agent is advertised and the status word stays as it was until step 17.

## 15. The first-party run

Operator, on the operator's own machine, with the test buyer key (Collateral and float). The mechanics are those of step 15 of RUNBOOK.md and of [docs/E2E.md](../../docs/E2E.md); this step lists what differs for the Pipeline. The hosted mainnet server has the nine marketplace tools, as it had for Agent History.

- `CAPABILITY_ID=document.pipeline.ocr-summary.v1`. The script looks the advert up among the free suppliers of this capability, and its default is the capability of Agent History, so without this setting it stops before it posts anything, with "is not among the free suppliers".
- `ADVERT_REF` is the Pipeline's advert from step 12.
- `PAYLOAD` is the request JSON for one page of a public PDF: `{"source":{"url":"<https URL of a one-page public PDF>"},"task":"summary","language":"en","max_pages":1}`. Use a document that anyone may read: its page goes to the OCR agent, and Datalab behind it, and its text to the chat supplier and that supplier's model provider.
- `E2E_POLL_MS=15000`. A job takes minutes where Agent History's took seconds, and the default pause of 5 s would ask the hosted server about 120 times in 10 minutes.
- `E2E_STATE=./e2e-state-pipeline.json`. A state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of the Agent History run.
- Expect up to 10 minutes for one page. The OCR hop and the chat hop each wait for a supplier's Claim, its work and its Submit, and for two transactions of the Pipeline's own. Five pages take up to 27 min.

Run `node scripts/e2e-hire.mjs --dry-run` first, then `node scripts/e2e-hire.mjs`, with these settings, as in [docs/E2E.md](../../docs/E2E.md); its section "Hiring Document Pipeline" lists them. The checks below are the same.

Then, on the box, look at what the run left behind:

```sh
docker logs --tail 20 document-pipeline-service
docker exec document-pipeline-service cat /data/stranded.json
```

The log has a line `[document-pipeline] job done in <ms> ms: 2 sub-jobs`: one page and one summary. `stranded.json` prints `[]`: a clean run leaves nothing for the janitor, because each Accept removes its own entry. The janitor writes a line only when it acts on an escrow (the table at the end), so a clean run has none.

Add the run to the Results table in docs/E2E.md and keep the evidence of the run in docs/evidence/. Its Agent column says Document Pipeline. Only a run that ends in the printed evidence counts. A first-party run is not demand.

## Watch the first stop

Operator, after step 15 and while no job is running. On SIGTERM (`docker stop` sends it) the service takes no new job and waits up to 300 s for the one that is running, its Accept included, then exits 0, or 1 if it had to abandon that job. Docker allows 30 s more than the service waits (`stop_grace_period: 330s`), so that a job abandoned at the end of the wait is logged and the exit code is the service's. That works only if the signal reaches the service through the image's `tini`, which runs it as one process, `node --import tsx`, with no child to relay the signal, and a stop that kills a running job strands the escrows it posted for the janitor. So watch one stop now, with nothing at stake, before step 17 stops the service for real:

```sh
cd "$BASE/repo/deploy/host"
curl -s http://127.0.0.1:8084/status
time docker compose -f docker-compose.document-pipeline.yml stop service
docker logs --tail 5 document-pipeline-service
docker inspect --format '{{.State.ExitCode}}' document-pipeline-service
docker compose -f docker-compose.document-pipeline.yml up -d service
```

`/status` must say `free`: a stop during a job waits for the job, up to 300 s, which is what the grace period is for; this check watches a stop with nothing running. With nothing running the stop returns in a few seconds. The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`. An exit code of 137 means the container was killed. Any other code but 0 fails the check too (143 would mean the signal ended the process before the service's own handling of it). If the line is missing or the code is not 0, do not go on to step 17, and do not stop the service while a job runs: report it with the log. When a job is running at a stop, the log also says `stopping: waiting up to 300000 ms for the job that is running`. This proves that the signal is delivered to an idle service and handled. The wait for a job that is running is tested offline (`agents/document-pipeline/test/start.test.ts`), and the box has not shown it yet: until the first real stop that finds a job running shows it, a stop is made only when `/status` says `free`. A stop that had to abandon a job exits 1, and its log names the escrows the state directory holds for the janitor of the next start.

## 16. Wallet monitor

Not used for this agent, as for Agent History (step 16 of RUNBOOK.md): the fleet's wallet monitor does not watch these wallets, and this runbook does not change that. The supplier float is read by hand with the check of step 6. The buyer float is watched by the service itself: `/healthz` answers 503 `insufficient_float` once the float outside the collateral is under (max_pages + 1) x 4.5, and every job is refused with the same code before it locks anything. Kept for an operator who wants it: the monitor is `wallet-monitor/` in the `Apex-Fusion/agents-marketplace` repository (see its README). On the machine that runs it, add two entries to `wallet-monitor/wallets.json`, which is not in git: `{ "name": "supplier-document-pipeline", "address": "<SUPPLIER_ADDRESS from the env file>" }` and `{ "name": "buyer-document-pipeline", "address": "<PIPELINE_BUYER_ADDRESS from the env file>" }`. The monitor posts to Slack when a wallet drops below its threshold.

## 17. Flip the status

Operator, and only after step 14 shows the advert Active, step 15 has ended with a settled first-party job, and the first stop has been watched. Then the status can honestly change from `proposed`. Set `deployed` or `live` as the operator decides: a first-party run shows that the path works, and it is not demand.

The status is in the manifest, so changing it changes the bytes the advert hashed, and a reader who compares the served manifest with the advert's `detail_hash` would see a mismatch. The advert has to be retired and posted again. The old advert goes first, so that no Active advert carries a stale `detail_hash` while the service restarts:

1. Check `curl -s http://127.0.0.1:8084/status` says `free`, and that no escrow is open against the advert. The restart of item 4 waits up to 300 s for a job that is running, but a job cut off from its runtime fails for the hirer.
2. Retire the old advert (Back out, point 1) and wait for it to confirm. From here until item 6 the agent has no advert.
3. In `.env.document-pipeline`, set `AGENT_STATUS_CHIP` to the new word and `AGENT_STATUS_SINCE` to today's date.
4. `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate service`
5. Hash the new manifest (step 11).
6. Post the new advert (step 12). The new `ADVERT_REF` replaces the old one in the env file.
7. `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate agent`, then steps 13 and 14 again.
8. In the repository, in a pull request, change every file that says PROPOSED about the Document Pipeline, and the tests that pin the word, and leave the other three agents' lines alone (their rows in the table of `README.md` and their specs). Find them with `grep -rIl PROPOSED --exclude-dir=node_modules --exclude-dir=.git .`. They are `specs/document-pipeline.md` (Status), `agents/document-pipeline/README.md`, `README.md` (the table), `docs/HIRE.md` and `docs/E2E.md` where they say it, `deploy/host/README.md` (the Document Pipeline section), `deploy/host/RUNBOOK-document-pipeline.md` (its first paragraph), the first lines of `deploy/host/docker-compose.document-pipeline.yml` and `deploy/host/Caddyfile.document-pipeline.snippet`, and `deploy/host/.env.document-pipeline.example`. The code carries the word as a default too: the `proposed` default in `agents/document-pipeline/src/server.ts` and the manifest template `agents/document-pipeline/agent.json.template` (regenerate it from the code with `pnpm --filter @vsa/document-pipeline template`, never by hand), and the pins in `agents/document-pipeline/test/server.test.ts`. The tests are `agents/document-pipeline/test/spec.test.ts`, `scripts/specs.test.mjs` and `scripts/deploy.test.mjs`. They fail until all of the files agree. The new advert has a new reference: replace the old one wherever it is given as the current advert, and keep it in the Links section of the spec as the retired advert.

## Back out

To stop the agent, and as the first move of step 17. The order matters: the advert goes first, so that nobody can post an escrow against an agent that is about to stop. Then the service gets to finish what it holds, and only then do the containers stop.

1. Retire the advert. Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted, and there is nothing to retire (go on with point 2). Operator: the transaction is signed with the supplier key in the env file. If the runtime runs, check that `curl -s http://127.0.0.1:8084/status` says `free` (`working` means a job is in flight: wait for it). Without the runtime, from step 12 to step 13, no job can run. From `$BASE/repo/deploy/host`:

   ```sh
   docker compose -f docker-compose.document-pipeline.yml run --rm --no-deps -T agent \
     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \
     --advert-ref "$(sed -n 's/^ADVERT_REF=//p' .env.document-pipeline)"
   ```

   Wait for it to confirm. The units it locked come back.
2. Let the service finish what it holds. Operator: `docker exec document-pipeline-service cat /data/stranded.json` prints `[]`, or lists only escrows whose `deliver_by` has not come yet: the janitor reclaims each one 5 s after its `deliver_by` and logs `janitor: reclaimed <escrow>: ...`. If `cat` says `No such file or directory`, no job has ever recorded an escrow and there is nothing to wait for. Stop the containers once the list is empty, or leave the rest for the next start of the service, which point 3 allows.
3. Stop the containers, operator or host administrator: `docker compose -f docker-compose.document-pipeline.yml down`. The stop waits up to 300 s for a job that is running, and Docker 30 s more for the service to log what it left and exit. Never add `-v`, and never run `docker volume rm document-pipeline-state`: the volume holds `stranded.json`, the escrows that still lock the buyer's units, and the janitor of the next start reads it. `down` keeps it. The external network of the host's reverse proxy is not touched.
4. Host administrator: remove the Caddy block from the host's Caddy configuration, validate and reload ([README.md](README.md), the Document Pipeline section), and remove the DNS record if it will not be reused.
5. Operator: the keys. The supplier key has a second plaintext copy that step 7 wrote, in two files of a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory, and `rmdir` refuses one that holds anything else). The env file still holds both keys, and so does the operator's offline store: keep both until both wallets are empty, because a wallet whose key is gone is gone. The buyer wallet is emptied last, with the buyer key, once `stranded.json` is empty (or was never written): its float and its collateral go back to the Foundation. No script of this pack does that: none signs with the buyer key, so the float stays in the wallet until the operator signs the transfer with the buyer key by other means (the byte-preserving signer pointed at a signing-key file made from the buyer key and shredded afterwards, as in the `store_write_failed` row of the table at the end). When the identity is deregistered later, `python3 make-skey.py` writes the directory again from the env file for that signing, and it is removed again afterwards.

The registry identity stays on the ledger until the operator deregisters it, and the deposit returns then. The stake is different. The owner cannot withdraw it: the module keeps 10 units as the minimum, and only stake above it can be decreased.

## If something goes wrong

| What you see | Meaning | Next step |
|---|---|---|
| The runtime restarts and its log says `missing required env var ADVERT_REF` | It was started before the advert existed. | `docker compose -f docker-compose.document-pipeline.yml stop agent`, finish step 12, then step 13. |
| `/capability` shows an empty public key, or claims fail with `wrong_supplier` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. | Restore the four supplier lines from the offline copy of the env file (step 4), which holds them from one key, then recreate. Without a good copy, and only while the supplier address has received nothing, empty the four lines with `sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline` and run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function). The block refuses a line that has a value, so it never replaces a key that holds units. Then refresh the offline copy and recreate. |
| Jobs fail with `service_unreachable` | The runtime cannot reach the service, or its fetch gave up on silence. | `docker exec document-pipeline-agent printenv SERVICE_URL` must print `http://document-pipeline-service:9092/`. Check that both containers run and sit on the external network of the host's reverse proxy. A failure at about 300 s into a job is the silence limit: the interim `102 Processing` lines of step 13 are not arriving. Report it with the logs of both containers. |
| Jobs fail with `service_http_401`, and the log of the service says `request refused: unauthorized (<n> since the last line of this kind)` | The runtime did not send the token the service holds: the two containers were created from different versions of the env file, or the line was changed after one of them started. | Run the comparison at the end of step 13: its two lines must be the same. If they differ, check that `/status` says `free`, then `up -d --force-recreate service` and `up -d --force-recreate agent`, and run the comparison again. The service logs this refusal once a minute at most, with the count since the last line, and never what the caller sent. |
| The service container keeps restarting and `docker logs document-pipeline-service` says `environment variable OPERATOR_CONTACT is required` | The contact line in the env file is empty or missing. | Set it as in step 4, then `up -d --force-recreate service`. |
| The same, and the log says `environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required` | The buyer lines of the env file are empty: the buyer key block of step 4 was not run, or did not finish. | Run only the buyer key block of step 4 (the first block of that step first, in a new shell, to define the function; it leaves the file alone). It makes the key from a second `gen-keypair`, never from a copy of the supplier key, and it refuses while the buyer key line has a value. If it stopped half way, empty the four buyer lines while the address has received nothing, with `sed -i 's/^\(PIPELINE_BUYER_[A-Z_]*\)=.*/\1=/' .env.document-pipeline`, and run the block again. Never run the whole step again, and never copy the example over the env file: that replaces keys that hold units. Then refresh the offline copy and recreate. |
| The same, and the log says `environment variable SERVICE_AUTH_HEADER is required`, or says that it must be printable ASCII | The token line of the env file is empty or missing, or holds a character that a header cannot carry. The service does not start without a token, so that it can never answer anyone. | Run the token block of step 4 (the first block of that step first, in a new shell, to define the function). It refuses while the line has a value: to replace a value that is wrong, empty the line first with `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.document-pipeline`. Then refresh the offline copy of the env file, and recreate the service, and the runtime too if it is running (with `/status` saying `free`), so that both hold the same value. |
| The same, and the log says `holds the buyer key, which belongs in PIPELINE_BUYER_PRIV_KEY_HEX alone` | The buyer key is in another line of the env file. The message names that line and does not show the key. | Take the key out of the line it names: that line is published in the manifest or logged. Then recreate. |
| The same, and the log says `holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The token is in another line of the env file too, whole or by the part after `Bearer `. The message names that line and does not show the token. | Take the token out of the line it names: that line is published in the manifest, logged, or said in an answer of the service. Then recreate. |
| The same, and the log says `is not the public key of SUPPLIER_PKH` | The line of the supplier public key holds another value, a private key by mistake. | Restore the four supplier lines from the offline copy of the env file, as in the `/capability` row above, then recreate. |
| The same, and the log says `is not the key hash of the key in PIPELINE_BUYER_PRIV_KEY_HEX` | `PIPELINE_BUYER_PKH` or `PIPELINE_BUYER_ADDRESS` was written by hand and is not the key's. | Correct the line or remove it: the service derives both from the key. |
| The same, and the log says `poppler-utils (pdfinfo and pdftoppm) must be installed and on PATH` | The image has no `pdfinfo` or `pdftoppm`: it was not built from the Dockerfile of this repository. | Build the image again and pin it (step 2). |
| The same, and the log says `which cannot be written` | The volume `document-pipeline-state` is not writable by the user the service runs as, `node` (uid 1000). | `docker volume inspect document-pipeline-state`. A volume that is new and empty can be removed, and compose makes it again. One that holds `stranded.json` is not removed: make `/data` belong to `node` instead. |
| The same, and the log says `is not a list of stranded escrows` | `stranded.json` was damaged. The service left it as it was and did not start, because starting without it would forget escrows that still hold a lock. | Read it with `docker run --rm -v document-pipeline-state:/data alpine cat /data/stranded.json`, repair it by hand, and do not delete it. |
| `/healthz` of the service answers 503 `insufficient_float`, and jobs are refused with `insufficient_float` (503) | The buyer float outside the collateral is under `(max_pages + 1) * 4.5`, which is 27 for five pages, or the wallet has no collateral output of 5, or it could not be read. Nothing was locked, unless the message says `The page escrows are settled`: then the chat supplier was chosen again after the pages, and its advert takes more than the float held then. While it lasts, `docker ps` shows the service as unhealthy, because its health check is `/healthz`. | Read the buyer wallet with the check of step 6 and ask the Foundation to top it up, with 5 alone if the collateral is gone. The log says `wallet check failed: ...` once, and `wallet check passed again` when it is right. |
| `/healthz` of the service answers 503 `insufficient_float` though the buyer wallet holds enough, and the log says `wallet check failed: The buyer wallet holds 0 lovelace outside its collateral` | The buyer wallet is in one output: it was supplied in one transfer, or a transaction gathered its outputs into one. The service takes the smallest pure output of at least 5 units as the collateral and counts only what is outside it as the float, so a single output, however large, leaves a float of 0. Nothing was locked. | Add an output of exactly 5 units: ask the Foundation to send 5 units alone, as in step 6, or send 5 units from the buyer wallet to its own address, signed with the buyer key by the manual means of the `store_write_failed` row. The 5 units become the collateral and the rest is float again. The log says `wallet check passed again` within a minute. |
| Jobs fail with `ocr_supplier_unavailable` (503) | The allowlisted OCR supplier has no single Active advert that the indexer lists and the ledger confirms, or its `/capability` cannot be read or serves another key, or its `/status` says `offline` or cannot be read (the message says which). A supplier at work is hired: the send waits for it. Nothing was locked. | Ask the indexer for the suppliers of `ocr.page.extract.chandra-ocr-2.v1` and look for the key of `OCR_ALLOWLIST_SUPPLIER_PKH`. Wait, or ask whoever operates the OCR agent. |
| Jobs fail with `llm_supplier_unavailable` (503) | No Active advert of a model on `LLM_MODEL_ALLOWLIST` has a supplier that serves the Responses API at `/capability` and says `free` or `working` at `/status`, within the 120 s of the selection. A supplier at work counts, and the send waits for it; an offline one does not. Usually nothing was locked: if the log line shows it came after the pages were read, the page escrows were settled. | Wait, or change the list in the env file and recreate the service. |
| Jobs fail with `ocr_supplier_unavailable` or `llm_supplier_unavailable` (503), and the log line says `above the ceiling of` | The advert of that hop is priced above `OCR_MAX_PRICE_LOVELACE` or `LLM_MAX_PRICE_LOVELACE`, on the indexer or on the ledger. Both are 1000000 lovelace unless the env file sets them. Nothing was locked. | Read the price on the indexer with the check of step 14. If the operator accepts it, set the setting in the env file and recreate the service: a higher price takes a larger float, which each job checks again before its first Post. Otherwise wait for a cheaper advert. |
| A job fails with `store_write_failed` (500) | The service posted an escrow and could not write it to `stranded.json`. The log line names the escrow, and the janitor does not know it. | Find where the escrow stands (`vector_marketplace_get_supplier`, or the explorer). Open or Claimed: reclaim it by hand after its `deliver_by`. Submitted: it cannot be reclaimed, and its supplier may release it after 600 s. No script of this pack signs with the buyer key, which is the service's, so the reclaim is manual: build it with `vector_build_marketplace_reclaim` on the hosted server and sign it with the buyer key on the box by the same byte-preserving means as the supplier's transactions (`sign-tx.py`, pointed at a signing-key file made from the buyer key, which is shredded afterwards). |
| `janitor: reclaimed <escrow>: ...` | An escrow a job left behind was Open or Claimed and has been reclaimed: everything it locked came back. | Nothing. |
| `janitor: kept <escrow>: Submitted: it cannot be reclaimed, and its supplier may release it from <time> at the latest` | The supplier submitted a receipt that the job did not accept (it failed a check, or the job ran out of time). A Submitted escrow cannot be reclaimed, and the lock goes to the supplier when it releases. | Nothing brings it back. Read the log of that job for why it was not accepted. |
| `janitor: the pass failed` or `janitor: kept <escrow>` with "its state could not be read" | The node or the indexer did not answer, or `stranded.json` could not be written. The janitor tries again every minute. | If it goes on for more than a few minutes, look at the disk and at the volume: a service that cannot write the file cannot record the escrows it posts. |
| The env file changed and nothing happened | `restart` does not re-read it. | Once the runtime runs (step 13), check first that `curl -s http://127.0.0.1:8084/status` says `free`: a recreate stops the container, and a stop during a job can cut a job under escrow. Before step 13 no job can run. Then `up -d --force-recreate <service>`, and both containers after a change to `SERVICE_AUTH_HEADER`. |
| `network <name> declared as external, but could not be found` | Wrong host, a wrong name in `.env`, or the stack of the host's reverse proxy is down. | Check the name in `.env` (step 1). If it is right, start the stack of the host's reverse proxy. |
| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |
| `invalid reference format` for the service image | The placeholder `@sha256:<digest>` is still in the `image:` line of the compose file. | Pin the image, step 2. |
| `No such image: sha256:...` for the service image | The pinned image is not on the box: it was pruned, or the pin came from another machine. | Build the image again (step 2). A new build has a new ID and can change the manifest, so take the hash of step 11 again and compare it with the advert's. |
| The served `/agent.json` hashes differently from the advert's `detail_hash` | The manifest changed after the advert was posted: the env file, or a service image other than the one the advert was hashed with. | Retire the advert (Back out, point 1), then repeat steps 11, 12 and 13. |
