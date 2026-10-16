# Runbook: Audio Snippets on the deployment host

Status: PROPOSED (built, not deployed) since 2026-10-13. Nothing in this folder is LIVE. This runbook says what will happen, in order. No step of it has been run.

This is [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), the runbook of the Document Pipeline, written for Audio Snippets. The Pipeline ran its runbook in full on 2026-10-16, so the mechanics are proven, and this runbook keeps its structure and its numbers: step N here is step N there, and step N of [RUNBOOK.md](RUNBOOK.md), the runbook of Agent History. Where a step is the same, it gives the commands with this agent's names, and the runbook of the Pipeline explains them. Where Audio Snippets differs, the step says how. The operator keeps the notes of the earlier deployments, with no secrets in them, outside this repository: read them before step 1.

What differs from the Document Pipeline, in one place:

- **One key.** The runtime holds the supplier key. The service holds no key and posts nothing: it reads the media, transcribes it, finds the cut points and answers. The compose file blanks the supplier key in the service's environment. Only the supplier wallet receives collateral and float (step 6).
- **A token on the service, as for the Pipeline.** The service answers `POST /` only to a call that carries the token the runtime sends (`SERVICE_AUTH_HEADER`, made in step 4) and gives a `POST /` without it 401, because the network is shared with other stacks; any other path but `/healthz` and `/agent.json` gets 404. Its port 9093 is never published all the same.
- **A window of 25 min.** The advert's `max_processing_ms` is 1500000 and the runtime's `SERVICE_TIMEOUT_MS` is 1380000. A job has a deadline of its own, 1320000 ms (22 min) after it arrives, and the speech recognition gets at most 900 s of it. The service writes an interim `102 Processing` line to the runtime every 60 s, because the runtime's fetch gives up on 300 s of silence (step 13).
- **The speech model in the image.** The image carries faster-whisper in a venv and the files of the model, `base` unless it is built with another size, fetched at a pinned revision and checked when the image is built (step 2). Nothing is fetched while a job runs but the media.
- **No state, and a clean stop.** There is no volume: a job keeps its files in a private temporary directory that is removed when it ends, and `/healthz` answers 503 `low_disk` when that directory has less than 256 MiB free. A stop gives the service up to 300 s to finish the job that is running, and Docker 30 s more for it to log a job it abandoned and exit (`stop_grace_period: 330s`), and the container has a memory limit of 3072m.
- **The network, as for the other two.** The containers join the external network of the host's reverse proxy, which `.env` in this folder names in `PROXY_NETWORK` (step 1). Compose reads it from there for every command.
- **Price 2.** The advert's price is 2000000 lovelace and each bond 1000000.

The names used below:

| Thing | Here |
|---|---|
| Base path on the host | `$BASE`, the folder the operator chooses for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |
| Base path of the Pipeline | `$PIPELINE_BASE`, the `BASE` of RUNBOOK-document-pipeline.md: its ops scripts and its install script |
| "This folder" | `$BASE/repo/deploy/host` |
| Compose file, env file | `docker-compose.audio-snippets.yml`, `.env.audio-snippets` |
| Containers | `audio-snippets-agent` (the runtime), `audio-snippets-service` |
| Ports | the runtime on `127.0.0.1:8085`, loopback only; the service on 9093, never published |
| Public name | `mp-suppliers-snippets.hal8.ai` |
| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |

The commands use the two base paths as variables. Set both again in every new shell on the host, before the commands below:

```sh
BASE=/opt/audio-snippets
PIPELINE_BASE=/opt/document-pipeline
```

Both values are examples: `BASE` is the folder the operator chooses for this agent, and `PIPELINE_BASE` the one the operator chose for the Pipeline. Each block that works in a folder starts with its own `cd` to it, so that it also runs alone in a new shell once the two variables are set there. The `docker compose` commands in the running text (step 17, Back out, the table at the end) run in `$BASE/repo/deploy/host`. The few values that a block takes from an earlier one, the functions of step 4 and `DETAIL_HASH` in step 12, are named where they matter.

The operator holds the key and does every step except two. Step 6 (the collateral and float of the supplier wallet) is the Foundation's. Step 10 (DNS and Caddy) is the host administrator's, see [README.md](README.md). Step 2 is the operator's here, because nothing is pulled from a registry. Every run of the agent is first-party until a buyer outside our control appears. A first-party run shows that the path works. It is not demand.

One thing about the order, as for the Pipeline. The advert carries the sha256 of the manifest the service serves at `/agent.json`, and adverts are immutable, so everything the manifest contains (the agent identifier, the key, the status word, the model) has to be final before the hash is taken. That is why the identity is registered (steps 7 and 8) before the advert (step 12), and why changing the status afterwards costs a new advert (step 17).

## Collateral and float

The Foundation supplies one key with its collateral and float. Nobody pastes the key into a chat.

| Key | Supplied with | Covers |
|---|---|---|
| Supplier key (the runtime's), generated on the host in step 4 | Two transfers to its address: exactly 5 units alone (collateral, never touched), then 50 units | As for Agent History and the Pipeline: the registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees. The rest covers the supplier's claim and submit fees. |

The service holds no key, so there is no second wallet. Two transfers, because a wallet supplied in one transfer can have its collateral spent as change by an ordinary transaction.

The key of the first-party run (step 15) is a second key and gets no collateral or float here: it is the operator's own test buyer key, the kind that hired the Pipeline in its step 15. A job of Audio Snippets costs the hirer about 4 (`docs/HIRE.md`, section 3), so that key needs its 5 alone and a float of at least 6 for the run, the lock of 4 and about 2 more (`docs/HIRE.md`, section 8). The float left from the earlier runs may be enough: the operator checks it before step 15, and asks the Foundation for a top-up if it is not.

## 1. Put the files on the host

Operator. The repository goes over as a git bundle of the reviewed `main`, as for the Pipeline, so that the host holds exactly the commit that was reviewed and needs no GitHub credentials. On the operator's machine, in a checkout of `main` at the commit that was reviewed:

```sh
git bundle create vector-service-agents.bundle main
git bundle verify vector-service-agents.bundle
scp vector-service-agents.bundle <user>@<host>:/tmp/
```

On the host, as the user that runs Docker:

```sh
mkdir -p "$BASE" && cd "$BASE"
git clone --branch main /tmp/vector-service-agents.bundle repo
cd repo/deploy/host
git log -1 --oneline
```

`--branch main` is needed: a bundle of `main` alone has no `HEAD`, and a plain clone of it checks nothing out. Check that the commit is the one that was reviewed. "This folder" below means `$BASE/repo/deploy/host`.

Then name the network, as in step 1 of the Pipeline's runbook: compose reads `PROXY_NETWORK`, the external network of the host's reverse proxy, from `.env` in this folder for every compose command (the first is in step 3), and stops while it has no value. It is the network the Pipeline is on, and the host administrator gives the name ([README.md](README.md)). In this folder:

```sh
cd "$BASE/repo/deploy/host"
echo 'PROXY_NETWORK=<the network the host administrator names>' > .env
docker network inspect --format '{{.Name}}' "$(sed -n 's/^PROXY_NETWORK=//p' .env)"
```

The second line must print the name back. An error means that this host has no network of that name. `.env` holds no secret and is covered by the repository's `.gitignore`.

## 2. Build the service image and pin it

Operator. Nothing is pulled from a registry for this agent, so there is no login. Build the image from the repository root, which is the build context:

```sh
cd "$BASE/repo"
docker build -f agents/audio-snippets/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest .
cd deploy/host
```

The build installs the workspace from the lockfile, ffmpeg from Debian, faster-whisper 1.2.1 and ctranslate2 4.8.2 in a venv from `agents/audio-snippets/asr/requirements.txt`, and the files of the model `base` (about 150 MB from huggingface.co, at the revision `asr/fetch_model.py` pins, its `model.bin` checked against its sha256). It needs the host to reach the Python package index and huggingface.co, and takes several minutes. A build with `--build-arg WHISPER_MODEL=small` carries the model `small` (about 490 MB) instead, and the manifest then names it in a gap; this runbook builds `base`. CI publishes the same image under `:latest` and `:<full git commit sha>` once Actions can run; until it has, the host uses its own build.

Then check the image before anything depends on it. The first command asks the worker whether faster-whisper imports and the model files are there; the second runs the tests of the speech model inside the image, against the real model and the speech fixture of the repository, with `REQUIRE_ASR=1`, so that a missing piece fails instead of skipping:

```sh
docker run --rm --entrypoint python3 ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest -I /app/asr/worker.py --check /app/asr/models/base
docker run --rm --entrypoint sh -e REQUIRE_ASR=1 -e WHISPER_MODEL_DIR=/app/asr/models/base -w /repo/agents/audio-snippets ghcr.io/apex-fusion/vector-service-agents/audio-snippets:latest -c 'node_modules/.bin/vitest run test/worker-contract.test.ts test/asr-real.test.ts'
```

The first prints `{"ok":true,"faster_whisper":"1.2.1","ctranslate2":"4.8.2"}`. The second ends with every test passed and none skipped.

Then pin the image, as in step 2 of the Pipeline's runbook. The manifest that the service renders is hashed into the advert (step 12), and `:latest` moves, so the compose file names the image by digest. It ships with the placeholder `@sha256:<digest>`, and compose refuses to start the service (`invalid reference format`) until the placeholder is replaced. This takes the digest where Docker keeps one for the image, and the image ID where it keeps none (an image built on the host by a Docker that keeps no digest for local images), and writes it into the `image:` line:

```sh
cd "$BASE/repo/deploy/host"
IMAGE=ghcr.io/apex-fusion/vector-service-agents/audio-snippets
PIN=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:latest" 2>/dev/null || docker image inspect --format '{{.Id}}' "$IMAGE:latest")
if printf '%s\n' "$PIN" | grep -Eq "^($IMAGE@sha256:|sha256:)[0-9a-f]{64}\$"; then
  sed -i "s|^    image: .*|    image: $PIN|" docker-compose.audio-snippets.yml
else
  echo "unexpected output, do not continue" >&2
fi
grep -n '^    image: ' docker-compose.audio-snippets.yml
```

The last command prints one line, the `image:` line of `service`, with `@sha256:` or `sha256:` and 64 hex digits. That is the only local change to the checkout, and it has to be made before step 9. The pinned image has to stay on the host: it cannot be pulled, so `docker image prune -a`, which removes every image that no container uses, would remove the only copy once the containers are gone. Do not build over the pinned service after the advert is posted: a new build has a new ID and can change the manifest, so the hash of step 11 would have to be taken again.

## 3. Build the runtime image

Operator.

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.audio-snippets.yml build agent
```

This clones `vector-agent-template` at the pinned commit `c4c378a`, the commit of the runtimes of Agent History and the Pipeline, and installs it. The compose file carries the full 40-character hash, because BuildKit does not resolve the short form. It ends with `Image audio-snippets-agent Built`.

## 4. Make the env file and generate the supplier key

Operator. The key and the token between the two containers are generated on the host and are never sent anywhere. Nothing secret is printed: each value is written into the env file, and only the lengths are shown.

This step makes things once and replaces nothing. The env file is made from the example only when there is none, and the key and the token are written only into an empty line. A block that is run a second time says `refusing:` and changes nothing, and that is the point: once the wallet holds units, a new key in its place is a lost wallet, and a copy of the example over the env file would replace the key. To make the key again while its address has received nothing, empty its four lines by hand (the failure table says how) and run only the block of the key.

The token is the value of `SERVICE_AUTH_HEADER`. The runtime sends it as the `authorization` header of every call to the service, and the service answers `POST /` only to a call that carries exactly that value, because other stacks share the network. Both containers read it from the env file, and neither blanks it. It is written in quotes, `SERVICE_AUTH_HEADER="Bearer <64 hex>"`: the ops scripts read the file with the shell's `.`, and without the quotes the shell would run the hex as a command and stop with exit 127. Docker Compose takes the quotes off, so the containers see `Bearer ` and the 64 hex digits, 71 characters.

The first block makes the env file and defines the two functions that the next blocks use. It is safe to paste again, in any new shell: it makes the file only if there is none.

```sh
cd "$BASE/repo/deploy/host"
umask 077
# keypair_into PREFIX makes one keypair with gen-keypair and writes its four values into the env file, as PREFIX_PRIV_KEY_HEX, PREFIX_PUB_KEY_HEX, PREFIX_PKH and PREFIX_ADDRESS.
# It writes into an empty place only: it refuses when the file is not here or when the key already has a value, so a key that may hold units is never replaced.
keypair_into() {
  [ -f .env.audio-snippets ] || { echo "refusing: there is no .env.audio-snippets in this folder" >&2; return 1; }
  [ -z "$(sed -n "s/^${1}_PRIV_KEY_HEX=//p" .env.audio-snippets)" ] || { echo "refusing: ${1}_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced" >&2; return 1; }
  json=$(docker compose -f docker-compose.audio-snippets.yml run --rm --no-deps -T agent \
    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1) || { echo "gen-keypair failed" >&2; return 1; }
  for pair in privateKeyHex:${1}_PRIV_KEY_HEX publicKeyHex:${1}_PUB_KEY_HEX pubKeyHash:${1}_PKH address:${1}_ADDRESS; do
    field=${pair%%:*}; name=${pair##*:}
    value=$(printf '%s\n' "$json" | sed -n "s/.*\"$field\": *\"\([0-9a-z]*\)\".*/\1/p")
    [ -n "$value" ] || { echo "no $field in the keypair output" >&2; json=; return 1; }
    sed -i "s|^$name=.*|$name=$value|" .env.audio-snippets
  done
  json=; value=
}
# token_into makes the token and writes it into the env file, in quotes. The same rule: it refuses when the line already has a value.
token_into() {
  [ -f .env.audio-snippets ] || { echo "refusing: there is no .env.audio-snippets in this folder" >&2; return 1; }
  [ -z "$(sed -n 's/^SERVICE_AUTH_HEADER=//p' .env.audio-snippets | tr -d '"')" ] || { echo "refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first" >&2; return 1; }
  value=$(openssl rand -hex 32) && [ "${#value}" = 64 ] || { echo "openssl rand failed" >&2; value=; return 1; }
  sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $value\"|" .env.audio-snippets
  value=
}
# The env file is made once, from the example, and never over one that is there: that one may hold a key whose wallet holds units.
if [ -e .env.audio-snippets ]; then
  echo "refusing: the env file exists, and it is kept as it is" >&2
else
  cp .env.audio-snippets.example .env.audio-snippets && chmod 600 .env.audio-snippets
fi
```

Then the supplier key and the token, one block each, so that each can be made again alone, and no block touches a line that already has a value:

```sh
cd "$BASE/repo/deploy/host"
keypair_into SUPPLIER
```

```sh
cd "$BASE/repo/deploy/host"
token_into
```

Check the lengths of what was written:

```sh
cd "$BASE/repo/deploy/host"
awk -F= '/^SUPPLIER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/ { v = $2; gsub(/"/, "", v); print $1, length(v) }' .env.audio-snippets
```

The last command must print `SUPPLIER_PRIV_KEY_HEX 64`, `SUPPLIER_PUB_KEY_HEX 64`, `SUPPLIER_PKH 56`, `SUPPLIER_ADDRESS 58` and `SERVICE_AUTH_HEADER 71` (`Bearer ` and 64 hex digits; the quotes are not counted). All five are needed. An empty public key breaks the receipt check, an empty supplier key hash makes the runtime reject its own claims as `wrong_supplier`, and the service stops at start without the token, without the public key, and with a public key that is not the one of the key hash, because it publishes both.

Then set the contact address, the one value in the file that is not generated. `OPERATOR_CONTACT` is required: the service stops at start without it, and the address is published in the manifest that the advert hashes, so it is final before step 11. Use the role address that the Foundation confirms, never a person's address. The line holds a placeholder in angle brackets from the example. Edit it in place, then check:

```sh
cd "$BASE/repo/deploy/host"
grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.audio-snippets
```

It must print 1: a value that does not start with an angle bracket.

The example carries the status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`: `proposed` since 2026-10-13. They stay so until step 17, which is the only place that changes them.

The key is a raw keypair, and this file is its only copy until step 7. There is no recovery phrase, and nothing can derive the key again. Copy `.env.audio-snippets` to the operator's encrypted offline store now, before the address receives anything, and copy it again after any regeneration of the key or of the token: a copy made before holds the old key, and the new one has no copy at all. A wallet whose key is lost is gone, whatever the ledger shows for it. Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`: from then on the key is in two files on the host, and both are protected the same way.

## 5. Adapt the ops scripts

Operator. The identity steps use the ops scripts that the Pipeline adapted from those of Agent History, in `$PIPELINE_BASE/ops` (step 5 of RUNBOOK-document-pipeline.md and of RUNBOOK.md say where they come from and why the signer is the byte-preserving one). Make a third adapted copy for Audio Snippets, outside the git checkout, so that nothing they write can be committed. Only the six scripts are copied; the venv and the wallet directory of the Pipeline stay where they are. The first `sed` points every path to the env file of the Pipeline at this agent's, whatever folder of its checkout the copy names, and the second the ops folder of the Pipeline at this one:

```sh
mkdir -p "$BASE/ops" && cd "$BASE/ops"
for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do
  sed -e "s#[^\"' =]*/\.env\.document-pipeline#$BASE/repo/deploy/host/.env.audio-snippets#g" \
      -e "s#$PIPELINE_BASE/ops#$BASE/ops#g" \
      "$PIPELINE_BASE/ops/$f" > "$f"
  chmod 755 "$f"
done
sed -i 's#document-pipeline supplier#audio-snippets supplier#g' make-skey.py
DESC="A word-timed transcript of an audio or video file, plus the cut points for the quotes or the question you give it, and optionally the cut clips."
sed -i \
  -e 's#^ "name":"Document Pipeline",# "name":"Audio Snippets",#' \
  -e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#" \
  -e 's#^ "capabilities":\[.*\],# "capabilities":["audio.transcript.snippets.v1"],#' \
  -e 's#^ "endpoint":"https://mp-suppliers-pipeline.hal8.ai"}# "endpoint":"https://mp-suppliers-snippets.hal8.ai"}#' \
  register-did.sh
sed -i 's#^CAPABILITIES = \[.*\]#CAPABILITIES = ["audio.transcript.snippets.v1"]#' m3-self-stake.py
grep -nE '"(name|description|capabilities|framework|endpoint)"' register-did.sh
grep -n '^CAPABILITIES' m3-self-stake.py
grep -il 'pipeline\|agent.history' *.sh *.py
grep -l 'env\.audio-snippets' *.sh *.py
```

The first two `grep` lines must show the Audio Snippets values and nothing of the Pipeline, the third must print nothing, and the fourth names every script that reads the env file. A line the third prints is a path, a name or a message of another agent: change it by hand to this agent's before any script runs, because it would act on the wrong stack. The framework line is the same as for the Pipeline, `vector-service-agents`. The description is the manifest's, and the registry takes at most 256 characters of it (this one is 144). Then the Python environment, made first with `cbor2` pinned, as in step 5 of the Pipeline's runbook, then completed by `setup-venv.sh`, which clones the Module-3 SDK into `$BASE/ops`:

```sh
cd "$BASE/ops"
python3 -m venv venv
./venv/bin/pip -q install 'cbor2==5.6.5'
./setup-venv.sh
./venv/bin/pip show cbor2 | grep '^Version'
```

`setup-venv.sh` ends with `venv ok`, and the last command must print `Version: 5.6.5`.

## 6. Supply the supplier wallet with its collateral and float

The Foundation. Read the address with `grep '^SUPPLIER_ADDRESS=' "$BASE/repo/deploy/host/.env.audio-snippets"`, then send two separate transfers to it. The first is exactly 5 units, alone. Send the second, 50 units, only after the first has confirmed. Check:

```sh
cd "$BASE/repo/deploy/host"
"$BASE/ops/mcp-call.sh" vector_get_utxos "{\"address\":\"$(sed -n 's/^SUPPLIER_ADDRESS=//p' .env.audio-snippets)\"}"
```

The address must list two outputs: one of exactly 5 units and one of 50.

## 7. Register the identity

Operator. The same as step 7 of RUNBOOK.md. This costs a deposit of 10 units, refundable on deregistration, and a fee. Read the first gotcha at the end of RUNBOOK.md before the first run.

```sh
cd "$BASE/ops"
sed -i '/^AGENT_DID=$/d' "$BASE/repo/deploy/host/.env.audio-snippets"
python3 make-skey.py
./register-did.sh
```

The first line removes the empty `AGENT_DID=` line that came with the example: the script refuses to run when the name is already in the file, and it appends the real value. `make-skey.py` writes the signing key of the supplier, in the form the signer reads, into the directory `$BASE/ops/wallet` (`payment.skey` and `payment.vkey`, mode 600). `payment.skey` is a second plaintext copy of the supplier key, next to the one in the env file. Keep it as private as the env file, and remove it in Back out (point 4). `register-did.sh` builds the registration on the hosted keyless MCP server, signs it locally with the byte-preserving signer, submits it, waits for it, and appends `AGENT_DID` and `AGENT_REGISTER_TX` to the env file. The record has the name `Audio Snippets`, the capability `audio.transcript.snippets.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-snippets.hal8.ai` and the manifest's description.

Check: `grep -c '^AGENT_DID=did:vector:agent:' "$BASE/repo/deploy/host/.env.audio-snippets"` prints 1. If the script stops with an error, read the first gotcha at the end of RUNBOOK.md before running it again. If it ends with `NOT CONFIRMED`, look at the explorer before running it again: the transaction may still land.

Record the identity in the repository. Once the check above prints 1, open a pull request that puts the DID and the registration transaction into the Identity section of `specs/audio-snippets.md` (the DID row, the "Registry record, planned" row and the sentence that says the agent has no registry record yet), together with the test that pins them in `scripts/specs.test.mjs`. The status word does not change here. Step 17 is the only place that flips it.

## 8. Stake in Module-3

Operator. The same as step 8 of RUNBOOK.md: this locks 10 units on the capability, refundable under the stake's own rules (a cooldown applies). Read the second gotcha at the end of RUNBOOK.md before the run.

```sh
cd "$BASE/ops"
./venv/bin/python m3-self-stake.py
```

The staked capabilities must be a subset of the registry record's, and here both are the one capability `audio.transcript.snippets.v1`. The script patches the SDK's testnet genesis constant and asserts it against the wall clock before it locks anything. It appends `M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM` to the env file.

## 9. Start the service

Operator. Start `service` by name. A bare `up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.

First check the pin of step 2. The `image:` line of `service` must name a digest or an image ID of 64 hex digits in place of the placeholder, or compose stops with `invalid reference format`:

```sh
cd "$BASE/repo/deploy/host"
grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/audio-snippets@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.audio-snippets.yml
```

It prints that line. Then start the service and read it:

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.audio-snippets.yml up -d service
docker logs audio-snippets-service
docker exec audio-snippets-service node -e "fetch('http://127.0.0.1:9093/healthz').then(async (r) => console.log(r.status, await r.text()))"
docker exec audio-snippets-service node -e "fetch('http://127.0.0.1:9093/agent.json').then((r) => r.json()).then((m) => console.log(JSON.stringify({ contact: m.operator.contact, did: m.identity.did, controller_pkh: m.identity.controller_pkh, keys: m.keys, status: m.status, model_gap: m.gaps[1], explorer_advert: m.links.explorer_advert }, null, 2)))"
docker exec audio-snippets-service node -e "fetch('http://127.0.0.1:9093/', { method: 'POST', body: 'x' }).then(async (r) => console.log(r.status, await r.text()))"
docker inspect --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}}' audio-snippets-service
```

The log shows `[audio-snippets] listening on 0.0.0.0:9093; speech model faster-whisper-base-int8 (faster-whisper 1.2.1, ctranslate2 4.8.2, 4 threads)` and no `cannot start`. The service asks `ffprobe` and `ffmpeg` for their version and the worker to check the model before it listens, and does not start without them, so a `listening on` line means all three answered. `/healthz` answers `200 {"ok":true}`. The first answer is given before the first check of the free space has finished (the check is made at most once a minute, in the background), so ask again after a minute. `503 {"ok":false,"reason":"low_disk"}` means the temporary directory has less than 256 MiB free (the table at the end). The manifest must show the role address of step 4 in `operator.contact`, the new DID in `identity.did`, the key hash in `identity.controller_pkh` and `keys.supplier_pkh`, the public key in `keys.pub_key_hex`, `status.chip` and `status.since` as the env file sets them (step 4), the model the image was built with in the second gap, and an empty `links.explorer_advert`. The advert's hash will cover exactly these bytes. A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`: the service refuses a call that does not carry the token of step 4 before it reads the body. The service does not start without that token (`environment variable SERVICE_AUTH_HEADER is required`, in the table at the end), nor with an empty `SUPPLIER_PUB_KEY_HEX` or one that is not the public key of `SUPPLIER_PKH` (the same table). The `inspect` line prints `3221225472 330`: the memory limit of 3072m in bytes and the stop timeout of 330 s, 30 s more than the service waits for a job.

## 10. DNS and Caddy

Host administrator, from [README.md](README.md) (the Audio Snippets section): the DNS record for `mp-suppliers-snippets.hal8.ai`, DNS only, and the Caddy block, validated and reloaded. The block is merged by a copy of the install script the Pipeline used in its step 10, which is idempotent and refuses while the name does not resolve to the host. The copy has this agent's vhost and snippet. Make it once, on the host:

```sh
cd "$BASE/ops"
sed -e 's#^VHOST=.*#VHOST=mp-suppliers-snippets.hal8.ai#' \
    -e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.audio-snippets.snippet#" \
    "$PIPELINE_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh
chmod 755 install-caddy-route.sh
sed -i '/^MARKER=/s#document-pipeline#audio-snippets#g' install-caddy-route.sh
grep -nE '^(VHOST|SNIPPET|MARKER)=' install-caddy-route.sh
grep -in 'pipeline\|history' install-caddy-route.sh
```

The first `grep` must show the vhost, the snippet and the marker of Audio Snippets, and the second must print nothing. A line it prints is a path, a name or a message of another stack: change it by hand to this agent's before the script runs, because it would act on the wrong stack. Run `./install-caddy-route.sh` once the record resolves to the host. The copy may poll `/healthz` on the public name after it has reloaded Caddy, and that route goes to the runtime, which does not exist before step 13. So before step 13 the script can wait on that poll, or end with exit code 2, with the block already in place. Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the host, the record is not there yet: wait for it and run the script again. Check from any machine:

```sh
curl -fsS https://mp-suppliers-snippets.hal8.ai/agent.json
```

It must return the manifest of step 9, byte for byte. `/healthz` on the public name answers only after step 13, because every other path goes to the runtime.

## 11. Hash the manifest

Operator. As in step 11 of RUNBOOK.md. Run it from the root of the repository checkout, on any machine with Node 22; the script only fetches public bytes. On the host the root is `$BASE/repo`:

```sh
cd "$BASE/repo"
node scripts/manifest-hash.mjs https://mp-suppliers-snippets.hal8.ai
```

It prints one JSON line with `detail_uri`, `detail_hash` and `bytes`. Cross-check on the host with `curl -fsS https://mp-suppliers-snippets.hal8.ai/agent.json | sha256sum`: the 64 hex digits must be the same. If they differ, stop. Something between the host and the client rewrites the bytes.

## 12. Post the advert

Operator. From this folder. As in step 12 of RUNBOOK.md, with the terms of Audio Snippets. Set the hash, then run once with `--dry-run` and read the datum it prints: the capability, the model `audio-snippets-v1`, `max_processing_ms` 1500000, the price 2000000 and both bonds at 1000000, the endpoint, the detail URI, the hash and `status` Active. A dry run sends nothing.

```sh
cd "$BASE/repo/deploy/host"
DETAIL_HASH=<the 64 hex digits from step 11>
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
docker compose -f docker-compose.audio-snippets.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts --dry-run \
  --capability-id audio.transcript.snippets.v1 \
  --model audio-snippets-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 2000000 \
  --max-processing-ms 1500000 \
  --endpoint-url https://mp-suppliers-snippets.hal8.ai \
  --detail-uri https://mp-suppliers-snippets.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH"
```

Then the same command without `--dry-run`, which posts the advert. It locks about 2 units, returned when the advert is retired, and costs a fee. In a new shell, set `BASE` and `DETAIL_HASH` again first.

```sh
cd "$BASE/repo/deploy/host"
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
ADVERT_REF=$(docker compose -f docker-compose.audio-snippets.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts \
  --capability-id audio.transcript.snippets.v1 \
  --model audio-snippets-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 2000000 \
  --max-processing-ms 1500000 \
  --endpoint-url https://mp-suppliers-snippets.hal8.ai \
  --detail-uri https://mp-suppliers-snippets.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH" | tail -1)
echo "$ADVERT_REF"
printf '%s' "$ADVERT_REF" | grep -Eq '^[0-9a-f]{64}#[0-9]+$' || echo "unexpected output, do not continue"
sed -i "s|^ADVERT_REF=.*|ADVERT_REF=$ADVERT_REF|; s|^ADVERT_DETAIL_HASH=.*|ADVERT_DETAIL_HASH=$DETAIL_HASH|" .env.audio-snippets
```

`--max-output-tokens` is required: without it the command stops with `missing required env var: ADVERT_MAX_OUTPUT_TOKENS`. 8192 is the value in the template's README. The runtime does not meter tokens for a custom capability, and its receipts record zero. The bonds are not in the flags: the command reads `ADVERT_SUPPLIER_BOND_LOVELACE` and `ADVERT_BUYER_BOND_LOVELACE` from the env file, 1000000 each.

If the command stops with an error after the transaction went out, look at the indexer (step 14) before running it again, so that a second advert is not posted.

Record the advert in the repository. In a pull request, put the explorer link of the advert transaction in the Links section of `specs/audio-snippets.md`, in place of the line that says the advert is not posted. The link is `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/` followed by the transaction id, which is `ADVERT_REF` up to the `#`. In the same pull request refresh the rows of the Identity table that still say "planned" or "not in service" and have become true by now (the reputation stake of step 8, the public URL of steps 10 and 13). The manifest keeps an empty `links.explorer_advert`: the advert's own transaction id cannot be inside the manifest the advert hashes. The status word stays PROPOSED until step 17.

## 13. Start the runtime

Operator. The env file changed, so create the container fresh:

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.audio-snippets.yml up -d --force-recreate agent
curl -s http://127.0.0.1:8085/healthz
curl -s http://127.0.0.1:8085/capability
curl -s http://127.0.0.1:8085/status
```

`/healthz` answers `{"ok":true}`. `/capability` shows the advert, with `audio.transcript.snippets.v1` and the public key. `/status` says `free`. If `/capability` says `advert_unavailable`, the advert has not confirmed yet: wait a minute and ask again. Then the same through the public name: `/healthz`, `/capability` and `/agent.json` on `https://mp-suppliers-snippets.hal8.ai`.

The runtime and the service must hold the same token. Compare them without printing it: the first figure is the length (71) and the second the first twelve hex digits of the sha256 of the value.

```sh
for c in audio-snippets-agent audio-snippets-service; do
  docker exec "$c" node -e "const v = process.env.SERVICE_AUTH_HEADER ?? ''; console.log(v.length, require('node:crypto').createHash('sha256').update(v).digest('hex').slice(0, 12))"
done
```

The two lines must be the same. `0 e3b0c44298fc` is an empty token, and two lines that differ mean that one container was created from another version of the env file (the table at the end, `service_http_401`).

One difference matters from here on, as for the Pipeline. A job of 10 min of audio takes minutes, and the runtime calls the service with a plain `fetch` that gives up on a response that has not begun after 300 s. So the service writes an interim `102 Processing` line every 60 s while a job runs, ahead of the answer, and the runtime reads past it. A job that fails as `service_unreachable` at about the five-minute mark means those lines are not arriving (the table at the end).

## 14. Check the advert on the indexer

Operator. The indexer takes a short while to pick up a new advert.

```sh
cd "$BASE/repo/deploy/host"
curl -fsS https://mp-indexer.vector.apexfusion.org/suppliers \
  | ADVERT_REF=$(sed -n 's/^ADVERT_REF=//p' .env.audio-snippets) python3 -c '
import json, os, sys
for r in json.load(sys.stdin):
    if r["utxo_ref"] == os.environ["ADVERT_REF"]:
        print(r["advert_status"], r["status"], r["capability_id"], r["detail_hash"])
'
```

The fetch uses `curl` on purpose: the indexer answers 403 to the default user agent of Python's `urllib`.

It must print `Active free audio.transcript.snippets.v1` and the hash of step 11. From here the agent is advertised and the status word stays as it was until step 17.

## 15. The first-party run

Operator, on the operator's own machine, with the test buyer key (Collateral and float). The mechanics are those of step 15 of the Pipeline's runbook and of [docs/E2E.md](../../docs/E2E.md); this step lists what differs for Audio Snippets.

- `CAPABILITY_ID=audio.transcript.snippets.v1`. The script looks the advert up among the free suppliers of this capability, and its default is the capability of Agent History, so without this setting it stops before it posts anything, with "is not among the free suppliers".
- `ADVERT_REF` is the advert of Audio Snippets from step 12.
- `PAYLOAD` is the request JSON for a short public-domain recording: `{"source":{"url":"<https URL of a short public-domain mp3>"},"language":"en","quotes":["All LibriVox recordings are in the public domain."]}`. A LibriVox recording says that sentence in its preamble, so the run shows a match. The service fetches the URL itself and refuses a redirect: a download link of archive.org redirects to the server that holds the file, so give the address it redirects to (`curl -sI <link>` shows it in its `location` line).
- `E2E_POLL_MS=10000`. A job takes a minute or more where Agent History's took seconds.
- `E2E_STATE=./e2e-state-snippets.json`. A state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of an earlier run.
- No clips: the request leaves `return_clips` out, so that the result stays small. The hosted MCP server reads at most 1000000 bytes of a job's answer.

Run `node scripts/e2e-hire.mjs --dry-run` first, then `node scripts/e2e-hire.mjs`, with these settings, as in [docs/E2E.md](../../docs/E2E.md); its section "Hiring Audio Snippets" lists them. The checks below are the same.

Then, on the host, look at what the run left behind:

```sh
docker logs --tail 20 audio-snippets-service
```

The log has a line `[audio-snippets] job done in <ms> ms: <s> s of media; matches 1, unmatched 0, clips 0`: the quote of the preamble was found. A job leaves no file behind: its directory is removed when it ends.

Add the run to the Results table in docs/E2E.md and keep the evidence of the run in docs/evidence/. Its Agent column says Audio Snippets. Only a run that ends in the printed evidence counts. A first-party run is not demand.

## Watch the first stop

Operator, after step 15 and while no job is running. On SIGTERM (`docker stop` sends it) the service takes no new job and waits up to 300 s for the one that is running, then exits 0, or 1 if it had to abandon that job. Docker allows 30 s more than the service waits (`stop_grace_period: 330s`), so that a job abandoned at the end of the wait is logged and the exit code is the service's. That works only if the signal reaches the service through the image's `tini`, which runs it as one process, `node --import tsx`, with no child to relay the signal, and a stop that kills a running job fails it for the hirer. So watch one stop now, with nothing at stake, before step 17 stops the service for real:

```sh
cd "$BASE/repo/deploy/host"
curl -s http://127.0.0.1:8085/status
time docker compose -f docker-compose.audio-snippets.yml stop service
docker logs --tail 5 audio-snippets-service
docker inspect --format '{{.State.ExitCode}}' audio-snippets-service
docker compose -f docker-compose.audio-snippets.yml up -d service
```

`/status` must say `free`: a stop during a job waits for the job, up to 300 s, which is what the grace period is for; this check watches a stop with nothing running. With nothing running the stop returns in a few seconds. The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`. An exit code of 137 means the container was killed. Any other code but 0 fails the check too (143 would mean the signal ended the process before the service's own handling of it). If the line is missing or the code is not 0, do not go on to step 17, and do not stop the service while a job runs: report it with the log. When a job is running at a stop, the log also says `stopping: waiting up to 300000 ms for the job that is running`. This proves that the signal is delivered to an idle service and handled. The wait for a job that is running is tested offline (`packages/service-kit/test/lifecycle.test.ts`), and the host has not shown it for this agent yet: until a real stop that finds a job running shows it, a stop is made only when `/status` says `free`. A stop that had to abandon a job exits 1, and its log says so.

## 16. Wallet monitor

Not used for this agent, as for Agent History and the Pipeline (step 16 of RUNBOOK.md): the fleet's wallet monitor does not watch this wallet, and this runbook does not change that. The supplier float is read by hand with the check of step 6. Kept for an operator who wants it: the monitor is `wallet-monitor/` in the `Apex-Fusion/agents-marketplace` repository (see its README). On the machine that runs it, add one entry to `wallet-monitor/wallets.json`, which is not in git: `{ "name": "supplier-audio-snippets", "address": "<SUPPLIER_ADDRESS from the env file>" }`. The monitor posts to Slack when a wallet drops below its threshold.

## 17. Flip the status

Operator, and only after step 14 shows the advert Active, step 15 has ended with a settled first-party job, and the first stop has been watched. Then the status can honestly change from `proposed`. Set `deployed` or `live` as the operator decides: a first-party run shows that the path works, and it is not demand.

The status is in the manifest, so changing it changes the bytes the advert hashed, and a reader who compares the served manifest with the advert's `detail_hash` would see a mismatch. The advert has to be retired and posted again. The old advert goes first, so that no Active advert carries a stale `detail_hash` while the service restarts:

1. Check `curl -s http://127.0.0.1:8085/status` says `free`, and that no escrow is open against the advert. The restart of item 4 waits up to 300 s for a job that is running, but a job cut off from its runtime fails for the hirer.
2. Retire the old advert (Back out, point 1) and wait for it to confirm. From here until item 6 the agent has no advert.
3. In `.env.audio-snippets`, set `AGENT_STATUS_CHIP` to the new word and `AGENT_STATUS_SINCE` to today's date.
4. `docker compose -f docker-compose.audio-snippets.yml up -d --force-recreate service`
5. Hash the new manifest (step 11).
6. Post the new advert (step 12). The new `ADVERT_REF` replaces the old one in the env file.
7. `docker compose -f docker-compose.audio-snippets.yml up -d --force-recreate agent`, then steps 13 and 14 again.
8. In the repository, in a pull request, change every file that says PROPOSED about Audio Snippets, and the tests that pin the word, and leave the other three agents' lines alone (their rows in the table of `README.md` and their specs). Find them with `grep -rIl PROPOSED --exclude-dir=node_modules --exclude-dir=.git .`. They are `specs/audio-snippets.md` (Status), `agents/audio-snippets/README.md`, `README.md` (the table), `docs/HIRE.md` and `docs/E2E.md` where they say it, `deploy/host/README.md` (the Audio Snippets section), `deploy/host/RUNBOOK-audio-snippets.md` (its first paragraph), the first lines of `deploy/host/docker-compose.audio-snippets.yml` and `deploy/host/Caddyfile.audio-snippets.snippet`, and `deploy/host/.env.audio-snippets.example`. The code carries the word as a default too: the `proposed` default in `agents/audio-snippets/src/server.ts` and the manifest template `agents/audio-snippets/agent.json.template` (regenerate it from the code with `pnpm --filter @vsa/audio-snippets template`, never by hand), and the pins in `agents/audio-snippets/test/server.test.ts`. The tests are `agents/audio-snippets/test/spec.test.ts`, `scripts/specs.test.mjs` and `scripts/deploy.test.mjs`. They fail until all of the files agree. The new advert has a new reference: replace the old one wherever it is given as the current advert, and keep it in the Links section of the spec as the retired advert.

## Back out

To stop the agent, and as the first move of step 17. The order matters: the advert goes first, so that nobody can post an escrow against an agent that is about to stop. Then the containers stop, and the service gets up to 300 s for a job that is running.

1. Retire the advert. Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted, and there is nothing to retire (go on with point 2). Operator: the transaction is signed with the supplier key in the env file. If the runtime runs, check that `curl -s http://127.0.0.1:8085/status` says `free` (`working` means a job is in flight: wait for it). Without the runtime, from step 12 to step 13, no job can run. From `$BASE/repo/deploy/host`:

   ```sh
   cd "$BASE/repo/deploy/host"
   docker compose -f docker-compose.audio-snippets.yml run --rm --no-deps -T agent \
     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \
     --advert-ref "$(sed -n 's/^ADVERT_REF=//p' .env.audio-snippets)"
   ```

   Wait for it to confirm. The units it locked come back.
2. Stop the containers, operator or host administrator: `docker compose -f docker-compose.audio-snippets.yml down`. The stop waits up to 300 s for a job that is running, and Docker 30 s more for the service to log what it left and exit. There is no volume to keep, and the external network of the host's reverse proxy is not touched.
3. Host administrator: remove the Caddy block of this agent from the host's Caddy configuration, validate and reload ([README.md](README.md), the Audio Snippets section), and remove the DNS record if it will not be reused.
4. Operator: the key. The supplier key has a second plaintext copy that step 7 wrote, in two files of a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory, and `rmdir` refuses one that holds anything else). The env file still holds the key, and so does the operator's offline store: keep both until the wallet is empty, because a wallet whose key is gone is gone. When the identity or the stake is withdrawn later, `python3 make-skey.py` writes the directory again from the env file for that signing, and it is removed again afterwards.

The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them. The deposit returns on deregistration and the stake after its cooldown.

## If something goes wrong

| What you see | Meaning | Next step |
|---|---|---|
| The runtime restarts and its log says `missing required env var ADVERT_REF` | It was started before the advert existed. | `docker compose -f docker-compose.audio-snippets.yml stop agent`, finish step 12, then step 13. |
| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |
| `network <name> declared as external, but could not be found` | Wrong host, a wrong name in `.env`, or the stack of the host's reverse proxy is down. | Check the name in `.env` (step 1). If it is right, ask the host administrator to start the stack of the host's reverse proxy. |
| `/capability` shows an empty public key, claims fail with `wrong_supplier`, or the service stops at start with `environment variable SUPPLIER_PUB_KEY_HEX is required` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. The service refuses to start with an empty public key, and with one that is not the public key of `SUPPLIER_PKH` (the row that quotes `is not the public key of SUPPLIER_PKH`), because it publishes both. | Restore the four supplier lines from the offline copy of the env file (step 4), which holds them from one key, then recreate. Without a good copy, and only while the supplier address has received nothing, make the key again: empty the four lines with `sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.audio-snippets` and run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function). The block refuses a line that has a value, so it never replaces a key that holds units. Then refresh the offline copy and recreate. |
| Jobs fail with `service_unreachable` | The runtime cannot reach the service, or its fetch gave up on silence. | `docker exec audio-snippets-agent printenv SERVICE_URL` must print `http://audio-snippets-service:9093/`. Check that both containers run and sit on the network that `PROXY_NETWORK` in `.env` names. A failure at about 300 s into a job is the silence limit: the interim `102 Processing` lines of step 13 are not arriving. Report it with the logs of both containers. |
| Jobs fail with `service_http_401`, and the log of the service says `request refused: unauthorized (<n> since the last line of this kind)` | The runtime did not send the token the service holds: the two containers were created from different versions of the env file, or the line was changed after one of them started. | Run the comparison at the end of step 13: its two lines must be the same. If they differ, check that `/status` says `free`, then `up -d --force-recreate service` and `up -d --force-recreate agent`, and run the comparison again. The service logs this refusal once a minute at most, with the count since the last line, and never what the caller sent. |
| The service container keeps restarting and `docker logs audio-snippets-service` says `environment variable OPERATOR_CONTACT is required` | The contact line in the env file is empty or missing. | Set it as in step 4, then `up -d --force-recreate service`. |
| The same, and the log says `environment variable SUPPLIER_PKH is required` | The supplier lines of the env file are empty: the supplier block of step 4 was not run, or did not finish. | Run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function; it leaves the file alone). It refuses while the key line has a value. Never run the whole step again, and never copy the example over the env file: that replaces a key that holds units. Then refresh the offline copy and recreate. |
| The same, and the log says `environment variable SERVICE_AUTH_HEADER is required`, or says that it must be printable ASCII | The token line of the env file is empty or missing, or holds a character that a header cannot carry. The service does not start without a token, so that it can never answer anyone. | Run the token block of step 4 (the first block of that step first, in a new shell, to define the function). It refuses while the line has a value: to replace a value that is wrong, empty the line first with `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.audio-snippets`. Then refresh the offline copy of the env file, and recreate the service, and the runtime too if it is running (with `/status` saying `free`), so that both hold the same value. |
| The same, and the log says `holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The token is in another line of the env file too, whole or by the part after `Bearer `. The message names that line and does not show the token. | Take the token out of the line it names: that line is published in the manifest, logged, or said in an answer of the service. Then recreate. |
| The same, and the log says `is not the public key of SUPPLIER_PKH` | The line of the supplier public key holds another value than the key of `SUPPLIER_PKH`: a private key by mistake, or lines from two keys. The message names both settings and shows no value. | Restore the four supplier lines from the offline copy of the env file, or, only while the supplier address has received nothing, make the key again, as in the `/capability` row above, then recreate. |
| The same, and the log says `ffmpeg and ffprobe must be installed and on PATH` | The image has no `ffmpeg` or `ffprobe`: it was not built from the Dockerfile of this repository. | Build the image again and pin it (step 2). |
| The same, and the log says `the speech model is not ready` | faster-whisper does not import, or the model files are not where the service looks: the image was built with another size than `WHISPER_MODEL` names, or not from this Dockerfile. | Run the two checks of step 2 on the pinned image. Build it again with the size of the env file, or take `WHISPER_MODEL` out of the env file so that the image's own value holds, then recreate. |
| The same, and the log says `environment variable WHISPER_MODEL must be one of base, small` | The env file sets `WHISPER_MODEL` to a size the image cannot be built with. | Take the line out of the env file: the image sets the size it was built with. |
| `/healthz` of the service answers 503 `low_disk`, and the log says `disk check failed: ...` | The temporary directory of the container has less than 256 MiB free; a job would be refused with `low_disk` (503) before it fetched a byte. While it lasts, `docker ps` shows the service as unhealthy, because its health check is `/healthz`. | Free space on the host's disk (`df -h`, `docker system df`). The log says `disk check passed again` within a minute of there being room. |
| Jobs fail with `deadline` (422) | The job ran out of its time: the speech recognition did not finish within the 900 s it had, or too little was left to start it or a clip. | Read the log line of the job. One that ran for about 900 s means the host is too slow for the length of the media: check its load, and keep media to the 10 min the job takes. |
| Jobs fail with `asr_failed` (500) | The speech model failed or wrote no transcript. The log line of the job has its message, and the lines `asr: ...` before it what the worker wrote. | Run the two checks of step 2 on the pinned image. Report it with the log. |
| Jobs fail with `clip_failed` (500) | ffmpeg could not cut a clip. The log line of the job has the reason. | Report it with the log and the request's cut points. |
| The env file changed and nothing happened | `restart` does not re-read it. | Once the runtime runs (step 13), check first that `curl -s http://127.0.0.1:8085/status` says `free`: a recreate stops the container, and a stop during a job can cut a job under escrow. Before step 13 no job can run. Then `up -d --force-recreate <service>`, and both containers after a change to `SERVICE_AUTH_HEADER`. |
| `invalid reference format` for the service image | The `image:` line still holds the placeholder `@sha256:<digest>`. | Pin the image as in step 2. |
| `No such image: sha256:...` for the service image | The pinned image is gone from the host: it was removed, by `docker image prune -a` for example. | Build it again and pin it (step 2). The new image has a new ID, and its manifest may differ: hash it again (step 11) before the next advert. |
| The served `/agent.json` hashes differently from the advert's `detail_hash` | The manifest changed after the advert was posted: the env file, the image or the status word. | Retire the advert and post it again with the hash of the manifest that is served now (step 17, items 1 to 7). |
