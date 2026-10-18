# Runbook: Advocate on the deployment host

Status: PROPOSED (built, not deployed) since 2026-10-13. Nothing in this folder is LIVE. This runbook says what will happen, in order. No step of it has been run.

This is [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), the runbook of Audio Snippets, written for Advocate. Audio Snippets ran its runbook in full on 2026-10-16 and 2026-10-17, so the mechanics are proven, and this runbook keeps its structure and its numbers: step N here is step N there, and step N of [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md) and of [RUNBOOK.md](RUNBOOK.md), the runbooks of the Pipeline and of Agent History. Where a step is the same, it gives the commands with this agent's names, and the runbook of Audio Snippets explains them. Where Advocate differs, the step says how. The operator keeps the notes of the earlier deployments, with no secrets in them, outside this repository: read them before step 1.

What differs from Audio Snippets, in one place:

- **One key, and two API keys.** The runtime holds the supplier key. The service holds no chain key and posts nothing: it searches the web, fetches the pages it found, asks one model and answers. It holds two API keys of its third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`, which the operator enters on the host by hand in step 4. The compose file blanks the supplier key in the service's environment and the two API keys in the runtime's. Only the supplier wallet receives collateral and float (step 6).
- **A token on the service, as for the Pipeline and Audio Snippets.** The service answers `POST /` only to a call that carries the token the runtime sends (`SERVICE_AUTH_HEADER`, made in step 4) and gives a `POST /` without it 401, because the network is shared with other stacks; any other path but `/healthz` and `/agent.json` gets 404. Its port 9094 is never published all the same.
- **A window of 5 min.** The advert's `max_processing_ms` is 300000 and the runtime's `SERVICE_TIMEOUT_MS` is 180000. A job has a deadline of its own, 150000 ms (150 s) after it arrives: the search gets at most 15 s of it, the pages at most 45 s and the model at most 90 s. The service writes an interim `102 Processing` line to the runtime every 60 s while a job runs, as the other services do, and a job ends long before the runtime's fetch would give up on 300 s of silence (step 13).
- **Calls out of the host, and no model in the image.** A job sends two search queries to the Brave Search API, fetches the result pages from their hosts over https, and makes one call to OpenRouter. The image holds Node and the code of the service, with no Python and no model, so step 2 builds it and checks Node alone.
- **No state, and a clean stop.** There is no volume: a job keeps what it fetched in memory, and nothing after it ends. A stop gives the service up to 300 s to finish the job that is running, which ends within 150 s of its arrival, and Docker 30 s more for it to log a job it abandoned and exit (`stop_grace_period: 330s`), and the container has a memory limit of 1024m.
- **The network, as for the other three.** The containers join the external network of the host's reverse proxy, which `.env` in this folder names in `PROXY_NETWORK` (step 1). Compose reads it from there for every command.
- **Price 3.** The advert's price is 3000000 lovelace and each bond 1000000.

The names used below:

| Thing | Here |
|---|---|
| Base path on the host | `$BASE`, the folder the operator chooses for this agent (any path works): the repository in `repo`, the ops scripts in `ops` |
| Base path of Audio Snippets | `$SNIPPETS_BASE`, the `BASE` of RUNBOOK-audio-snippets.md: its ops scripts and its install script |
| "This folder" | `$BASE/repo/deploy/host` |
| Compose file, env file | `docker-compose.advocate.yml`, `.env.advocate` |
| Containers | `advocate-agent` (the runtime), `advocate-service` |
| Ports | the runtime on `127.0.0.1:8086`, loopback only; the service on 9094, never published |
| Public name | `mp-suppliers-advocate.hal8.ai` |
| Network | the external network of the host's reverse proxy, named by `PROXY_NETWORK` in `.env` in this folder (step 1) |

The commands use the two base paths as variables. Set both again in every new shell on the host, before the commands below:

```sh
BASE=/opt/advocate
SNIPPETS_BASE=/opt/audio-snippets
```

Both values are examples: `BASE` is the folder the operator chooses for this agent, and `SNIPPETS_BASE` the one the operator chose for Audio Snippets. Each block that works in a folder starts with its own `cd` to it, so that it also runs alone in a new shell once the two variables are set there. The `docker compose` commands in the running text (step 17, Back out, the table at the end) run in `$BASE/repo/deploy/host`. The few values that a block takes from an earlier one, the functions of step 4 and `DETAIL_HASH` in step 12, are named where they matter.

The operator holds the key and does every step except two. Step 6 (the collateral and float of the supplier wallet) is the Foundation's. Step 10 (DNS and Caddy) is the host administrator's, see [README.md](README.md). Step 2 is the operator's here, because nothing is pulled from a registry, and so are the two API keys of step 4, which the operator enters from the accounts they belong to. Every run of the agent is first-party until a buyer outside our control appears. A first-party run shows that the path works. It is not demand.

One thing about the order, as for the other three. The advert carries the sha256 of the manifest the service serves at `/agent.json`, and adverts are immutable, so everything the manifest contains (the agent identifier, the key, the status word, the model) has to be final before the hash is taken. That is why the identity is registered (steps 7 and 8) before the advert (step 12), and why changing the status afterwards costs a new advert (step 17).

## Collateral and float

The Foundation supplies one key with its collateral and float. Nobody pastes the key into a chat.

| Key | Supplied with | Covers |
|---|---|---|
| Supplier key (the runtime's), generated on the host in step 4 | Two transfers to its address: exactly 5 units alone (collateral), then 50 units | As for the other three: the registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees. The rest covers the supplier's claim and submit fees. |

The service holds no chain key, so there is no second wallet. Two transfers, because a wallet supplied in one transfer can have its collateral merged into change by an ordinary transaction.

On 2026-10-17, for Audio Snippets, the setup transactions (steps 7, 8 and 12) used the 5-unit output as an input, so it did not stay alone; the supplier's Claim and Submit still found collateral in the change.

The two API keys are no part of the collateral and float: they are the keys of the accounts of the Brave Search API and of OpenRouter, which the operator enters in step 4. Each job that passes its intake makes two search queries and at most one model call on those accounts.

The key of the first-party run (step 15) is a second key and gets no collateral or float here: it is the operator's own test buyer key, the kind that hired Audio Snippets in its step 15. A job of Advocate costs the hirer about 5 (`docs/HIRE.md`, section 3), so that key needs its 5 alone and a float of at least 7 for the run, the lock of 5 and about 2 more (`docs/HIRE.md`, section 8). The float left from the earlier runs may be enough: the operator checks it before step 15, and asks the Foundation for a top-up if it is not.

## 1. Put the files on the host

Operator. The repository goes over as a git bundle of the reviewed `main`, as for the Pipeline and Audio Snippets, so that the host holds exactly the commit that was reviewed and needs no GitHub credentials. On the operator's machine, in a checkout of `main` at the commit that was reviewed:

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

Then name the network, as in step 1 of the runbook of Audio Snippets: compose reads `PROXY_NETWORK`, the external network of the host's reverse proxy, from `.env` in this folder for every compose command (the first is in step 3), and stops while it has no value. It is the network Audio Snippets is on, and the host administrator gives the name ([README.md](README.md)). In this folder:

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
docker build -f agents/advocate/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/advocate:latest .
cd deploy/host
```

The build installs the workspace from the lockfile and `tini` from Debian, on `node:22-bookworm-slim`. It installs no other language and fetches no model: the image holds Node and the code of the service. CI publishes the same image under `:latest` and `:<full git commit sha>` on every merge to `main`; the host still builds its own.

Then check the image before anything depends on it. There is no model in it to check, only the Node that runs the service:

```sh
docker run --rm --entrypoint node ghcr.io/apex-fusion/vector-service-agents/advocate:latest -e "console.log(process.version)"
```

It prints one line that starts with `v22.`, the version of Node 22. Another major version means that the image was not built from the Dockerfile of this repository.

Then pin the image, as in step 2 of the runbook of Audio Snippets. The manifest that the service renders is hashed into the advert (step 12), and `:latest` moves, so the compose file names the image by digest. It ships with the placeholder `@sha256:<digest>`, and compose refuses to start the service (`invalid reference format`) until the placeholder is replaced. This takes the digest where Docker keeps one for the image, and the image ID where it keeps none (an image built on the host by a Docker that keeps no digest for local images), and writes it into the `image:` line:

```sh
cd "$BASE/repo/deploy/host"
IMAGE=ghcr.io/apex-fusion/vector-service-agents/advocate
PIN=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:latest" 2>/dev/null || docker image inspect --format '{{.Id}}' "$IMAGE:latest")
if printf '%s\n' "$PIN" | grep -Eq "^($IMAGE@sha256:|sha256:)[0-9a-f]{64}\$"; then
  sed -i "s|^    image: .*|    image: $PIN|" docker-compose.advocate.yml
else
  echo "unexpected output, do not continue" >&2
fi
grep -n '^    image: ' docker-compose.advocate.yml
```

The last command prints one line, the `image:` line of `service`, with `@sha256:` or `sha256:` and 64 hex digits. That is the only local change to the checkout, and it has to be made before step 9. The pinned image has to stay on the host: it cannot be pulled, so `docker image prune -a`, which removes every image that no container uses, would remove the only copy once the containers are gone. Do not build over the pinned service after the advert is posted: a new build has a new ID and can change the manifest, so the hash of step 11 would have to be taken again.

## 3. Build the runtime image

Operator.

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.advocate.yml build agent
```

This clones `vector-agent-template` at the pinned commit `c4c378a`, the commit of the runtimes of the other three, and installs it. The compose file carries the full 40-character hash, because BuildKit does not resolve the short form. It ends with `Image advocate-agent Built`.

## 4. Make the env file, generate the supplier key and enter the two API keys

Operator. The key and the token between the two containers are generated on the host and are never sent anywhere. The two API keys are entered by hand on the host, from the accounts they belong to, and are never pasted into a chat or printed. Nothing secret is printed: each value is written into the env file, and only the lengths are shown.

This step makes things once and replaces nothing. The env file is made from the example only when there is none, and the key, the token and the two API keys are written only into an empty line. A block that is run a second time says `refusing:` and changes nothing, and that is the point: once the wallet holds units, a new key in its place is a lost wallet, and a copy of the example over the env file would replace the key. To make the key again while its address has received nothing, empty its four lines by hand (the failure table says how) and run only the block of the key.

The token is the value of `SERVICE_AUTH_HEADER`. The runtime sends it as the `authorization` header of every call to the service, and the service answers `POST /` only to a call that carries exactly that value, because other stacks share the network. Both containers read it from the env file, and neither blanks it. It is written in quotes, `SERVICE_AUTH_HEADER="Bearer <64 hex>"`: the ops scripts read the file with the shell's `.`, and without the quotes the shell would run the hex as a command and stop with exit 127. Docker Compose takes the quotes off, so the containers see `Bearer ` and the 64 hex digits, 71 characters.

The first block makes the env file and defines the three functions that the next blocks use. It is safe to paste again, in any new shell: it makes the file only if there is none.

```sh
cd "$BASE/repo/deploy/host"
umask 077
# keypair_into PREFIX makes one keypair with gen-keypair and writes its four values into the env file, as PREFIX_PRIV_KEY_HEX, PREFIX_PUB_KEY_HEX, PREFIX_PKH and PREFIX_ADDRESS.
# It writes into an empty place only: it refuses when the file is not here or when the key already has a value, so a key that may hold units is never replaced.
keypair_into() {
  [ -f .env.advocate ] || { echo "refusing: there is no .env.advocate in this folder" >&2; return 1; }
  [ -z "$(sed -n "s/^${1}_PRIV_KEY_HEX=//p" .env.advocate)" ] || { echo "refusing: ${1}_PRIV_KEY_HEX already has a value, and a key that may hold units is never replaced" >&2; return 1; }
  json=$(docker compose -f docker-compose.advocate.yml run --rm --no-deps -T agent \
    node_modules/.bin/tsx agent/src/cli/gen-keypair.ts --network 1) || { echo "gen-keypair failed" >&2; return 1; }
  for pair in privateKeyHex:${1}_PRIV_KEY_HEX publicKeyHex:${1}_PUB_KEY_HEX pubKeyHash:${1}_PKH address:${1}_ADDRESS; do
    field=${pair%%:*}; name=${pair##*:}
    value=$(printf '%s\n' "$json" | sed -n "s/.*\"$field\": *\"\([0-9a-z]*\)\".*/\1/p")
    [ -n "$value" ] || { echo "no $field in the keypair output" >&2; json=; return 1; }
    sed -i "s|^$name=.*|$name=$value|" .env.advocate
  done
  json=; value=
}
# token_into makes the token and writes it into the env file, in quotes. The same rule: it refuses when the line already has a value.
token_into() {
  [ -f .env.advocate ] || { echo "refusing: there is no .env.advocate in this folder" >&2; return 1; }
  [ -z "$(sed -n 's/^SERVICE_AUTH_HEADER=//p' .env.advocate | tr -d '"')" ] || { echo "refusing: SERVICE_AUTH_HEADER already has a value; to replace it, empty the line first" >&2; return 1; }
  value=$(openssl rand -hex 32) && [ "${#value}" = 64 ] || { echo "openssl rand failed" >&2; value=; return 1; }
  sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $value\"|" .env.advocate
  value=
}
# apikey_into NAME reads one API key from the terminal with read -rs, so that it is on no screen and in no shell history, and writes it into the line NAME of the env file.
# The same rule: it refuses when the line already has a value. It writes only a value of at least 20 characters of letters, digits, dots, hyphens and underscores.
apikey_into() {
  [ -f .env.advocate ] || { echo "refusing: there is no .env.advocate in this folder" >&2; return 1; }
  [ -z "$(sed -n "s/^${1}=//p" .env.advocate)" ] || { echo "refusing: ${1} already has a value; to replace it, empty the line first" >&2; return 1; }
  printf 'paste %s and press Enter (nothing is shown): ' "$1" >&2
  IFS= read -rs key
  printf '\n' >&2
  if [ "${#key}" -lt 20 ] || [ -n "$(printf '%s' "$key" | tr -d 'A-Za-z0-9._-')" ]; then
    echo "refusing: what was pasted for ${1} has ${#key} characters, or one that is not a letter, a digit, a dot, a hyphen or an underscore; nothing is written" >&2
    key=; return 1
  fi
  sed -i "s|^${1}=.*|${1}=$key|" .env.advocate
  key=
}
# The env file is made once, from the example, and never over one that is there: that one may hold a key whose wallet holds units.
if [ -e .env.advocate ]; then
  echo "refusing: the env file exists, and it is kept as it is" >&2
else
  cp .env.advocate.example .env.advocate && chmod 600 .env.advocate
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
awk -F= '/^SUPPLIER_(PRIV_KEY_HEX|PUB_KEY_HEX|PKH|ADDRESS)=|^SERVICE_AUTH_HEADER=/ { v = $2; gsub(/"/, "", v); print $1, length(v) }' .env.advocate
```

The last command must print `SUPPLIER_PRIV_KEY_HEX 64`, `SUPPLIER_PUB_KEY_HEX 64`, `SUPPLIER_PKH 56`, `SUPPLIER_ADDRESS 58` and `SERVICE_AUTH_HEADER 71` (`Bearer ` and 64 hex digits; the quotes are not counted). All five are needed. An empty public key breaks the receipt check, an empty supplier key hash makes the runtime reject its own claims as `wrong_supplier`, and the service stops at start without the token, without the public key, and with a public key that is not the one of the key hash, because it publishes both.

Then the two API keys of the service. They are not generated: the operator copies each from the account it belongs to, the key of the Brave Search API and the key of OpenRouter, and pastes it at the prompt the block prints. `read -rs` reads it with nothing shown, so that it is on no screen and in no shell history, and `sed` writes it into its line. The block writes only into an empty line, and only a value of at least 20 characters made of letters, digits, dots, hyphens and underscores: the ops scripts read the env file with the shell's `.`, which would run a `$` or a backquote in a value, and `sed` would misread a `|`, a `&` or a backslash. Then it unsets the variable that held the keys, and prints the length of each line and nothing else of it:

```sh
cd "$BASE/repo/deploy/host"
apikey_into BRAVE_SEARCH_API_KEY
apikey_into OPENROUTER_API_KEY
unset key
awk -F= '/^(BRAVE_SEARCH|OPENROUTER)_API_KEY=/ { print $1, length($2) }' .env.advocate
```

The last command must print `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`, each with a length of 20 or more. A length of 0 is a line the block did not write, because what was pasted was refused: run the block again, and it asks only for the line that is still empty. The service stops at start without either key (`environment variable BRAVE_SEARCH_API_KEY is required`, and the same for `OPENROUTER_API_KEY`, in the table at the end), so step 9 can start it only once both are in the file. To replace a key that is wrong, empty its line first with the command of the failure table, then run the block again.

Then set the contact address, the one value in the file that is not generated or copied. `OPERATOR_CONTACT` is required: the service stops at start without it, and the address is published in the manifest that the advert hashes, so it is final before step 11. Use the role address that the Foundation confirms, never a person's address. The line holds a placeholder in angle brackets from the example. Edit it in place, then check:

```sh
cd "$BASE/repo/deploy/host"
grep -c '^OPERATOR_CONTACT=[^<[:space:]]' .env.advocate
```

It must print 1: a value that does not start with an angle bracket. The ops scripts read this file with the shell's `.`, which cannot read the placeholder of the example, `OPERATOR_CONTACT=<...>`, until it is replaced: its angle brackets are redirections to the shell, which stops at that line, so the check must print 1 before step 6.

The example carries the status word and its date in `AGENT_STATUS_CHIP` and `AGENT_STATUS_SINCE`: `proposed` since 2026-10-13. They stay so until step 17, which is the only place that changes them.

The key is a raw keypair, and this file is its only copy until step 7. There is no recovery phrase, and nothing can derive the key again. Copy `.env.advocate` to the operator's encrypted offline store now, before the address receives anything, and copy it again after any regeneration of the key or of the token, and after either API key is entered again: a copy made before holds the old value, and the new one has no copy at all. The copy holds the two API keys too, so it is kept as the key is. A wallet whose key is lost is gone, whatever the ledger shows for it. Step 7 writes a second plaintext copy of the supplier key to the directory `$BASE/ops/wallet`: from then on the key is in two files on the host, and both are protected the same way.

## 5. Adapt the ops scripts

Operator. The identity steps use the ops scripts that Audio Snippets adapted from those of the Pipeline, in `$SNIPPETS_BASE/ops` (step 5 of RUNBOOK-audio-snippets.md, of RUNBOOK-document-pipeline.md and of RUNBOOK.md say where they come from and why the signer is the byte-preserving one). Make a fourth adapted copy for Advocate, outside the git checkout, so that nothing they write can be committed. Only the six scripts are copied; the venv and the wallet directory of Audio Snippets stay where they are. The first `sed` points every path to the env file of Audio Snippets at this agent's, whatever folder of its checkout the copy names, and the second the ops folder of Audio Snippets at this one:

```sh
mkdir -p "$BASE/ops" && cd "$BASE/ops"
for f in setup-venv.sh make-skey.py mcp-call.sh sign-tx.py register-did.sh m3-self-stake.py; do
  sed -e "s#[^\"' =]*/\.env\.audio-snippets#$BASE/repo/deploy/host/.env.advocate#g" \
      -e "s#$SNIPPETS_BASE/ops#$BASE/ops#g" \
      "$SNIPPETS_BASE/ops/$f" > "$f"
  chmod 755 "$f"
done
sed -i 's#audio-snippets supplier#advocate supplier#g' make-skey.py
DESC="The strongest one-sided brief for a position, with citations: it argues one side only, by design, omits counter-arguments, and says so in every output."
sed -i \
  -e 's#^ "name":"Audio Snippets",# "name":"Advocate",#' \
  -e "s#^ \"description\":\".*\",# \"description\":\"$DESC\",#" \
  -e 's#^ "capabilities":\[.*\],# "capabilities":["research.advocate.onesided.v1"],#' \
  -e 's#^ "endpoint":"https://mp-suppliers-snippets.hal8.ai"}# "endpoint":"https://mp-suppliers-advocate.hal8.ai"}#' \
  register-did.sh
sed -i 's#^CAPABILITIES = \[.*\]#CAPABILITIES = ["research.advocate.onesided.v1"]#' m3-self-stake.py
grep -nE '"(name|description|capabilities|framework|endpoint)"' register-did.sh
grep -n '^CAPABILITIES' m3-self-stake.py
grep -il 'snippets\|pipeline\|agent.history' *.sh *.py
grep -l 'env\.advocate' *.sh *.py
```

The first two `grep` lines must show the Advocate values and nothing of Audio Snippets, the third must print nothing, and the fourth names every script that reads the env file. A line the third prints is a path, a name or a message of another agent: change it by hand to this agent's before any script runs, because it would act on the wrong stack. The framework line is the same as for the other three, `vector-service-agents`. The description is the manifest's, which states the declared bias, and the registry takes at most 256 characters of it (this one is 151). Then the Python environment of the ops scripts on the host, made first with `cbor2` pinned, as in step 5 of the runbook of Audio Snippets, then completed by `setup-venv.sh`, which clones the Module-3 SDK into `$BASE/ops`:

```sh
cd "$BASE/ops"
python3 -m venv venv
./venv/bin/pip -q install 'cbor2==5.6.5'
./setup-venv.sh
./venv/bin/pip show cbor2 | grep '^Version'
./venv/bin/python -c "import pycardano, reputation_staking"
```

`setup-venv.sh` does not end with `venv ok` on this host: it ends with a traceback from its last line, `module 'pycardano' has no attribute '__version__'`, after everything is installed, and the venv is complete all the same (it ended so for Audio Snippets on 2026-10-16, whose venv has the same packages as this one, and steps 7 and 8 of RUNBOOK-audio-snippets.md ran on that venv). The check that holds is the last two lines of the block: `./venv/bin/pip show cbor2 | grep '^Version'` prints `Version: 5.6.5`, and `./venv/bin/python -c "import pycardano, reputation_staking"` exits 0.

## 6. Supply the supplier wallet with its collateral and float

The Foundation. Read the address with `grep '^SUPPLIER_ADDRESS=' "$BASE/repo/deploy/host/.env.advocate"`, then send two separate transfers to it. The first is exactly 5 units, alone. Send the second, 50 units, only after the first has confirmed. Check:

```sh
cd "$BASE/repo/deploy/host"
"$BASE/ops/mcp-call.sh" vector_get_utxos "{\"address\":\"$(sed -n 's/^SUPPLIER_ADDRESS=//p' .env.advocate)\"}"
```

The address must list two outputs: one of exactly 5 units and one of 50.

## 7. Register the identity

Operator. The same as step 7 of RUNBOOK.md. This costs a deposit of 10 units, refundable on deregistration, and a fee. Read the first gotcha at the end of RUNBOOK.md before the first run.

```sh
cd "$BASE/ops"
sed -i '/^AGENT_DID=$/d' "$BASE/repo/deploy/host/.env.advocate"
python3 make-skey.py
./register-did.sh
```

The first line removes the empty `AGENT_DID=` line that came with the example: the script refuses to run when the name is already in the file, and it appends the real value. `make-skey.py` writes the signing key of the supplier, in the form the signer reads, into the directory `$BASE/ops/wallet` (`payment.skey` and `payment.vkey`, mode 600). `payment.skey` is a second plaintext copy of the supplier key, next to the one in the env file. Keep it as private as the env file, and remove it in Back out (point 4). `register-did.sh` builds the registration on the hosted keyless MCP server, signs it locally with the byte-preserving signer, submits it, waits for it, and appends `AGENT_DID` and `AGENT_REGISTER_TX` to the env file. The record has the name `Advocate`, the capability `research.advocate.onesided.v1`, the framework `vector-service-agents`, the endpoint `https://mp-suppliers-advocate.hal8.ai` and the manifest's description.

Check: `grep -c '^AGENT_DID=did:vector:agent:' "$BASE/repo/deploy/host/.env.advocate"` prints 1. If the script stops with an error, read the first gotcha at the end of RUNBOOK.md before running it again. If it ends with `NOT CONFIRMED`, look at the explorer before running it again: the transaction may still land.

Record the identity in the repository. Once the check above prints 1, open a pull request that puts the DID and the registration transaction into the Identity section of `specs/advocate.md` (the DID row, the "Registry record, planned" row and the sentence that says the agent has no registry record yet), together with the test that pins them in `scripts/specs.test.mjs`. The status word does not change here. Step 17 is the only place that flips it.

## 8. Stake in Module-3

Operator. The same as step 8 of RUNBOOK.md: this locks 10 units on the capability, refundable under the stake's own rules (a cooldown applies). Read the second gotcha at the end of RUNBOOK.md before the run.

```sh
cd "$BASE/ops"
./venv/bin/python m3-self-stake.py
```

The staked capabilities must be a subset of the registry record's, and here both are the one capability `research.advocate.onesided.v1`. The script patches the SDK's testnet genesis constant and asserts it against the wall clock before it locks anything. It appends `M3_STAKE_TX`, `M3_SEED_UTXO` and `M3_STAKE_DFM` to the env file.

## 9. Start the service

Operator. Start `service` by name. A bare `up -d` also starts the runtime, which exits at boot while `ADVERT_REF` is empty.

The service starts only once the two API keys are in the env file (step 4): without either it stops at start and names it (the table at the end). That holds for a smoke start too. The service may be started here before step 6, to see it come up, and recreated after steps 7 and 8, as Audio Snippets was, and a smoke start works only once both keys are in.

First check the pin of step 2. The `image:` line of `service` must name a digest or an image ID of 64 hex digits in place of the placeholder, or compose stops with `invalid reference format`:

```sh
cd "$BASE/repo/deploy/host"
grep -E '^    image: (ghcr[.]io/apex-fusion/vector-service-agents/advocate@sha256:|sha256:)[0-9a-f]{64}$' docker-compose.advocate.yml
```

It prints that line. Then start the service and read it:

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.advocate.yml up -d service
docker logs advocate-service
docker exec advocate-service node -e "fetch('http://127.0.0.1:9094/healthz').then(async (r) => console.log(r.status, await r.text()))"
docker exec advocate-service node -e "fetch('http://127.0.0.1:9094/agent.json').then((r) => r.json()).then((m) => console.log(JSON.stringify({ contact: m.operator.contact, did: m.identity.did, controller_pkh: m.identity.controller_pkh, keys: m.keys, status: m.status, model_gap: m.gaps[4], explorer_advert: m.links.explorer_advert }, null, 2)))"
docker exec advocate-service node -e "fetch('http://127.0.0.1:9094/', { method: 'POST', body: 'x' }).then(async (r) => console.log(r.status, await r.text()))"
docker exec advocate-service node -e "for (const n of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) console.log(n, (process.env[n] ?? '').length)"
docker inspect --format '{{.HostConfig.Memory}} {{.Config.StopTimeout}}' advocate-service
```

The log shows `[advocate] listening on 0.0.0.0:9094; search Brave Search API; model deepseek/deepseek-v4-flash via OpenRouter` and no `cannot start`. The service checks its settings before it listens and does not start without them, so a `listening on` line means that the token, the key hash and its public key, and the two API keys were all in the env file. Whether the API keys are good shows in the first job: a key the Brave Search API refuses fails the job with `search_failed`, and one OpenRouter refuses with `model_failed` (the table at the end). `/healthz` answers `200 {"ok":true}`. The manifest must show the role address of step 4 in `operator.contact`, the new DID in `identity.did`, the key hash in `identity.controller_pkh` and `keys.supplier_pkh`, the public key in `keys.pub_key_hex`, `status.chip` and `status.since` as the env file sets them (step 4), the model of the service in the fifth gap (`deepseek/deepseek-v4-flash` while `OPENROUTER_MODEL` is not set), and an empty `links.explorer_advert`. The advert's hash will cover exactly these bytes. A `POST /` with no `authorization` header prints `401 {"error":"unauthorized"}`: the service refuses a call that does not carry the token of step 4 before it reads the body. The service does not start without that token (`environment variable SERVICE_AUTH_HEADER is required`, in the table at the end), nor with an empty `SUPPLIER_PUB_KEY_HEX` or one that is not the public key of `SUPPLIER_PKH`, nor without either API key (the same table). The next line prints `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY` with the lengths of step 4, and no key. The `inspect` line prints `1073741824 330`: the memory limit of 1024m in bytes and the stop timeout of 330 s, 30 s more than the service waits for a job.

## 10. DNS and Caddy

Host administrator, from [README.md](README.md) (the Advocate section): the DNS record for `mp-suppliers-advocate.hal8.ai`, DNS only, and the Caddy block, validated and reloaded. The block is merged by a copy of the install script Audio Snippets used in its step 10, which is idempotent and refuses while the name does not resolve to the host. The copy has this agent's vhost and snippet. Make it once, on the host:

```sh
cd "$BASE/ops"
sed -e 's#^VHOST=.*#VHOST=mp-suppliers-advocate.hal8.ai#' \
    -e "s#^SNIPPET=.*#SNIPPET=$BASE/repo/deploy/host/Caddyfile.advocate.snippet#" \
    "$SNIPPETS_BASE/ops/install-caddy-route.sh" > install-caddy-route.sh
chmod 755 install-caddy-route.sh
sed -i '/^MARKER=/s#audio-snippets#advocate#g' install-caddy-route.sh
grep -nE '^(VHOST|SNIPPET|MARKER)=' install-caddy-route.sh
grep -in 'snippets\|pipeline\|history' install-caddy-route.sh
```

The first `grep` must show the vhost, the snippet and the marker of Advocate. The second prints the first comment line of the copy, which names the Pipeline or Audio Snippets: a comment line is expected there, and is edited to this agent's or left as it is. A line that is a path, a name or a message of another stack is what must not appear: change it by hand to this agent's before the script runs, because it would act on the wrong stack. Run `./install-caddy-route.sh` once the record resolves to the host. The copy may poll `/healthz` on the public name after it has reloaded Caddy, and that route goes to the runtime, which does not exist before step 13. So before step 13 the script can wait on that poll, or end with exit code 2, with the block already in place. Read the last line it printed: if it is about the `/healthz` poll, that is the expected end, and the route to check is `/agent.json`, which goes to the service and answers now. If it says the name does not resolve to the host, the record is not there yet: wait for it and run the script again. Check from any machine:

```sh
curl -fsS https://mp-suppliers-advocate.hal8.ai/agent.json
```

It must return the manifest of step 9, byte for byte. `/healthz` on the public name answers only after step 13, because every other path goes to the runtime.

## 11. Hash the manifest

Operator. As in step 11 of RUNBOOK.md. The script runs on the operator's machine, from the root of a checkout of the repository, with Node 22: the host has no Node. It only fetches public bytes:

```sh
node scripts/manifest-hash.mjs https://mp-suppliers-advocate.hal8.ai
```

It prints one JSON line with `detail_uri`, `detail_hash` and `bytes`. The host cross-checks the raw bytes with `curl -fsS https://mp-suppliers-advocate.hal8.ai/agent.json | sha256sum`: the two must agree. If they differ, stop. Something between the host and the client rewrites the bytes.

## 12. Post the advert

Operator. From this folder. As in step 12 of RUNBOOK.md, with the terms of Advocate. Set the hash, then run once with `--dry-run` and read the datum it prints: the capability, the model `advocate-v1`, `max_processing_ms` 300000, the price 3000000 and both bonds at 1000000, the endpoint, the detail URI, the hash and `status` Active. A dry run sends nothing.

```sh
cd "$BASE/repo/deploy/host"
DETAIL_HASH=<the 64 hex digits from step 11>
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
docker compose -f docker-compose.advocate.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts --dry-run \
  --capability-id research.advocate.onesided.v1 \
  --model advocate-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 3000000 \
  --max-processing-ms 300000 \
  --endpoint-url https://mp-suppliers-advocate.hal8.ai \
  --detail-uri https://mp-suppliers-advocate.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH"
```

Then the same command without `--dry-run`, which posts the advert. It locks about 2 units, returned when the advert is retired, and costs a fee. In a new shell, set `BASE` and `DETAIL_HASH` again first.

```sh
cd "$BASE/repo/deploy/host"
printf '%s' "$DETAIL_HASH" | grep -Eq '^[0-9a-f]{64}$' || echo "not a sha256 hash"
ADVERT_REF=$(docker compose -f docker-compose.advocate.yml run --rm --no-deps -T agent \
  node_modules/.bin/tsx agent/src/cli/post-advert.ts \
  --capability-id research.advocate.onesided.v1 \
  --model advocate-v1 \
  --max-output-tokens 8192 \
  --price-lovelace 3000000 \
  --max-processing-ms 300000 \
  --endpoint-url https://mp-suppliers-advocate.hal8.ai \
  --detail-uri https://mp-suppliers-advocate.hal8.ai/agent.json \
  --detail-hash "$DETAIL_HASH" | tail -1)
echo "$ADVERT_REF"
printf '%s' "$ADVERT_REF" | grep -Eq '^[0-9a-f]{64}#[0-9]+$' || echo "unexpected output, do not continue"
sed -i "s|^ADVERT_REF=.*|ADVERT_REF=$ADVERT_REF|; s|^ADVERT_DETAIL_HASH=.*|ADVERT_DETAIL_HASH=$DETAIL_HASH|" .env.advocate
```

`--max-output-tokens` is required: without it the command stops with `missing required env var: ADVERT_MAX_OUTPUT_TOKENS`. 8192 is the value in the template's README. The runtime does not meter tokens for a custom capability, and its receipts record zero. The bonds are not in the flags: the command reads `ADVERT_SUPPLIER_BOND_LOVELACE` and `ADVERT_BUYER_BOND_LOVELACE` from the env file, 1000000 each.

If the command stops with an error after the transaction went out, look at the indexer (step 14) before running it again, so that a second advert is not posted.

Record the advert in the repository. In a pull request, put the explorer link of the advert transaction in the Links section of `specs/advocate.md`, in place of the line that says the advert is not posted. The link is `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/` followed by the transaction id, which is `ADVERT_REF` up to the `#`. In the same pull request refresh the rows of the Identity table that still say "planned" or "not in service" and have become true by now (the reputation stake of step 8, the public URL of steps 10 and 13). The manifest keeps an empty `links.explorer_advert`: the advert's own transaction id cannot be inside the manifest the advert hashes. The status word stays PROPOSED until step 17.

## 13. Start the runtime

Operator. The env file changed, so create the container fresh:

```sh
cd "$BASE/repo/deploy/host"
docker compose -f docker-compose.advocate.yml up -d --force-recreate agent
curl -s http://127.0.0.1:8086/healthz
curl -s http://127.0.0.1:8086/capability
curl -s http://127.0.0.1:8086/status
```

`/healthz` answers `{"ok":true}`. `/capability` shows the advert, with `research.advocate.onesided.v1` and the public key. `/status` says `free`. If `/capability` says `advert_unavailable`, the advert has not confirmed yet: wait a minute and ask again. Then the same through the public name: `/healthz`, `/capability` and `/agent.json` on `https://mp-suppliers-advocate.hal8.ai`.

The runtime and the service must hold the same token. Compare them without printing it: the first figure is the length (71) and the second the first twelve hex digits of the sha256 of the value.

```sh
for c in advocate-agent advocate-service; do
  docker exec "$c" node -e "const v = process.env.SERVICE_AUTH_HEADER ?? ''; console.log(v.length, require('node:crypto').createHash('sha256').update(v).digest('hex').slice(0, 12))"
done
```

The two lines must be the same. `0 e3b0c44298fc` is an empty token, and two lines that differ mean that one container was created from another version of the env file (the table at the end, `service_http_401`).

The runtime must hold neither API key, because the compose file blanks both for it:

```sh
docker exec advocate-agent node -e "for (const n of ['BRAVE_SEARCH_API_KEY', 'OPENROUTER_API_KEY']) console.log(n, (process.env[n] ?? '').length)"
```

It prints both names with the length 0. Another length means that the compose file was changed: put its two blank lines back and recreate the runtime.

One difference from the other services matters less here. A job of Advocate ends within 150 s, well inside the 300 s after which the runtime's plain `fetch` gives up on a response that has not begun, and the service writes an interim `102 Processing` line every 60 s all the same, ahead of the answer, which the runtime reads past. A job that fails as `service_unreachable` means that the runtime could not reach the service (the table at the end).

## 14. Check the advert on the indexer

Operator. The indexer takes a short while to pick up a new advert.

```sh
cd "$BASE/repo/deploy/host"
curl -fsS https://mp-indexer.vector.apexfusion.org/suppliers \
  | ADVERT_REF=$(sed -n 's/^ADVERT_REF=//p' .env.advocate) python3 -c '
import json, os, sys
for r in json.load(sys.stdin):
    if r["utxo_ref"] == os.environ["ADVERT_REF"]:
        print(r["advert_status"], r["status"], r["capability_id"], r["detail_hash"])
'
```

The fetch uses `curl` on purpose: the indexer answers 403 to the default user agent of Python's `urllib`.

It must print `Active free research.advocate.onesided.v1` and the hash of step 11. From here the agent is advertised and the status word stays as it was until step 17.

## 15. The first-party run

Operator, on the operator's own machine, with the test buyer key (Collateral and float). The mechanics are those of step 15 of the runbook of Audio Snippets and of [docs/E2E.md](../../docs/E2E.md); this step lists what differs for Advocate.

- `CAPABILITY_ID=research.advocate.onesided.v1`. The script looks the advert up among the free suppliers of this capability, and its default is the capability of Agent History, so without this setting it stops before it posts anything, with "is not among the free suppliers".
- `ADVERT_REF` is the advert of Advocate from step 12.
- `PAYLOAD` is the request JSON of the example of `specs/advocate.md`: `{"subject":"Should a city ban cars from its centre?","side":"for","length":"short","language":"en"}`. The service sends its two search queries to the Brave Search API, fetches the pages they find, and sends the subject, the side, the audience, the language and the length, and the titles, URLs and excerpts of the fetched pages, to OpenRouter and the model provider behind it.
- `E2E_POLL_MS=10000`. A job takes up to 150 s, its deadline, where Agent History's takes seconds.
- `E2E_STATE=./e2e-state-advocate.json`. A state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of an earlier run.

Run `node scripts/e2e-hire.mjs --dry-run` first, then `node scripts/e2e-hire.mjs`, with these settings, as in [docs/E2E.md](../../docs/E2E.md); its section "Hiring Advocate" lists them. The checks below are the same.

Then, on the host, look at what the run left behind:

```sh
docker logs --tail 20 advocate-service
```

The log has a line `[advocate] job done in <ms> ms: results <n>, pages <k>, arguments <a> (dropped <d>), quotes dropped <q>, tokens <p>/<c>`: the search gave `<n>` results, `<k>` pages were kept, the brief has `<a>` arguments after the check dropped `<d>`, the check dropped `<q>` quotes, and the model call used `<p>` prompt tokens and `<c>` completion tokens (`tokens -/-` when OpenRouter gave no count). The line holds no subject, no side, no URL, no quote and no key. A job leaves nothing behind: what it fetched is held in memory and dropped when it ends.

The hire costs the hirer about 5: the price, 3, and the supplier bond, 1, which the supplier receives on Accept, and fees of about 1; the buyer bond comes back to the buyer. Add the run to the Results table in docs/E2E.md and keep the evidence of the run in docs/evidence/. Its Agent column says Advocate. Only a run that ends in the printed evidence counts. A first-party run is not demand.

## Watch the first stop

Operator, after step 15 and while no job is running. On SIGTERM (`docker stop` sends it) the service takes no new job and waits up to 300 s for the one that is running, then exits 0, or 1 if it had to abandon that job. Docker allows 30 s more than the service waits (`stop_grace_period: 330s`), so that a job abandoned at the end of the wait is logged and the exit code is the service's. That works only if the signal reaches the service through the image's `tini`, which runs it as one process, `node --import tsx`, with no child to relay the signal, and a stop that kills a running job fails it for the hirer. So watch one stop now, with nothing at stake, before step 17 stops the service for real:

```sh
cd "$BASE/repo/deploy/host"
curl -s http://127.0.0.1:8086/status
time docker compose -f docker-compose.advocate.yml stop service
docker logs --tail 5 advocate-service
docker inspect --format '{{.State.ExitCode}}' advocate-service
docker compose -f docker-compose.advocate.yml up -d service
```

`/status` must say `free`: a stop during a job waits for the job, which ends within 150 s, and that is what the grace period is for; this check watches a stop with nothing running. With nothing running the stop returns in a few seconds. The log ends with `SIGTERM: stopping; no new job, and up to 300 s for the one that is running`, and the exit code is `0`. An exit code of 137 means the container was killed. Any other code but 0 fails the check too (143 would mean the signal ended the process before the service's own handling of it). If the line is missing or the code is not 0, do not go on to step 17, and do not stop the service while a job runs: report it with the log. When a job is running at a stop, the log also says `stopping: waiting up to 300000 ms for the job that is running`. This proves that the signal is delivered to an idle service and handled. The wait for a job that is running is tested offline (`packages/service-kit/test/lifecycle.test.ts`), and the host has not shown it for this agent yet: until a real stop that finds a job running shows it, a stop is made only when `/status` says `free`. A stop that had to abandon a job exits 1, and its log says so.

## 16. Wallet monitor

Not used for this agent, as for the other three (step 16 of RUNBOOK.md): the fleet's wallet monitor does not watch this wallet, and this runbook does not change that. The supplier float is read by hand with the check of step 6. Kept for an operator who wants it: the monitor is `wallet-monitor/` in the `Apex-Fusion/agents-marketplace` repository (see its README). On the machine that runs it, add one entry to `wallet-monitor/wallets.json`, which is not in git: `{ "name": "supplier-advocate", "address": "<SUPPLIER_ADDRESS from the env file>" }`. The monitor posts to Slack when a wallet drops below its threshold.

## 17. Flip the status

Operator, and only after step 14 shows the advert Active, step 15 has ended with a settled first-party job, and the first stop has been watched. Then the status can honestly change from `proposed`. Set `deployed` or `live` as the operator decides: a first-party run shows that the path works, and it is not demand.

The status is in the manifest, so changing it changes the bytes the advert hashed, and a reader who compares the served manifest with the advert's `detail_hash` would see a mismatch. The advert has to be retired and posted again. The old advert goes first, so that no Active advert carries a stale `detail_hash` while the service restarts:

1. Check `curl -s http://127.0.0.1:8086/status` says `free`, and that no escrow is open against the advert. The restart of item 4 waits up to 300 s for a job that is running, but a job cut off from its runtime fails for the hirer.
2. Retire the old advert (Back out, point 1) and wait for it to confirm. From here until item 6 the agent has no advert.
3. In `.env.advocate`, set `AGENT_STATUS_CHIP` to the new word and `AGENT_STATUS_SINCE` to today's date.
4. `docker compose -f docker-compose.advocate.yml up -d --force-recreate service`
5. Hash the new manifest (step 11).
6. Post the new advert (step 12). The new `ADVERT_REF` replaces the old one in the env file.
7. `docker compose -f docker-compose.advocate.yml up -d --force-recreate agent`, then steps 13 and 14 again.
8. In the repository, in a pull request, change every file that says PROPOSED about Advocate, and the tests that pin the word, and leave the other three agents' lines alone (their rows in the table of `README.md` and their specs). Find them with `grep -rIl PROPOSED --exclude-dir=node_modules --exclude-dir=.git .`. They are `specs/advocate.md` (Status), `agents/advocate/README.md`, `README.md` (the table, and the line that says Advocate waits for its deployment), `docs/HIRE.md` and `docs/E2E.md` where they say it, `deploy/host/README.md` (the Advocate section), `deploy/host/RUNBOOK-advocate.md` (its first paragraph), the first lines of `deploy/host/docker-compose.advocate.yml` and `deploy/host/Caddyfile.advocate.snippet`, and `deploy/host/.env.advocate.example`. The code carries the word as a default too: the `proposed` default in `agents/advocate/src/server.ts` and the manifest template `agents/advocate/agent.json.template` (regenerate it from the code with `pnpm --filter @vsa/advocate template`, never by hand), and the pins in `agents/advocate/test/server.test.ts` and `agents/advocate/test/start.test.ts`. The tests are `agents/advocate/test/spec.test.ts`, `agents/advocate/test/readme.test.ts`, `scripts/specs.test.mjs` and `scripts/deploy.test.mjs`. They fail until all of the files agree. The new advert has a new reference: replace the old one wherever it is given as the current advert, and keep it in the Links section of the spec as the retired advert.

## Back out

To stop the agent, and as the first move of step 17. The order matters: the advert goes first, so that nobody can post an escrow against an agent that is about to stop. Then the containers stop, and the service gets up to 300 s for a job that is running.

1. Retire the advert. Skip this point when `ADVERT_REF` in the env file is empty: no advert was posted, and there is nothing to retire (go on with point 2). Operator: the transaction is signed with the supplier key in the env file. If the runtime runs, check that `curl -s http://127.0.0.1:8086/status` says `free` (`working` means a job is in flight: wait for it). Without the runtime, from step 12 to step 13, no job can run. From `$BASE/repo/deploy/host`:

   ```sh
   cd "$BASE/repo/deploy/host"
   docker compose -f docker-compose.advocate.yml run --rm --no-deps -T agent \
     node_modules/.bin/tsx agent/src/cli/retire-advert.ts \
     --advert-ref "$(sed -n 's/^ADVERT_REF=//p' .env.advocate)"
   ```

   Wait for it to confirm. The units it locked come back.
2. Stop the containers, operator or host administrator: `docker compose -f docker-compose.advocate.yml down`. The stop waits up to 300 s for a job that is running, and Docker 30 s more for the service to log what it left and exit. There is no volume to keep, and the external network of the host's reverse proxy is not touched.
3. Host administrator: remove the Caddy block of this agent from the host's Caddy configuration, validate and reload ([README.md](README.md), the Advocate section), and remove the DNS record if it will not be reused.
4. Operator: the key. The supplier key has a second plaintext copy that step 7 wrote, in two files of a directory: `shred -u "$BASE/ops/wallet/payment.skey" "$BASE/ops/wallet/payment.vkey"`, then `rmdir "$BASE/ops/wallet"` (`shred` does not take a directory, and `rmdir` refuses one that holds anything else). The env file still holds the key, and so does the operator's offline store: keep both until the wallet is empty, because a wallet whose key is gone is gone. When the identity or the stake is withdrawn later, `python3 make-skey.py` writes the directory again from the env file for that signing, and it is removed again afterwards. The two API keys stay valid on their accounts until the operator revokes them there: revoke them when the agent will not come back.

The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them. The deposit returns on deregistration and the stake after its cooldown.

## If something goes wrong

| What you see | Meaning | Next step |
|---|---|---|
| The runtime restarts and its log says `missing required env var ADVERT_REF` | It was started before the advert existed. | `docker compose -f docker-compose.advocate.yml stop agent`, finish step 12, then step 13. |
| `required variable PROXY_NETWORK is missing a value` | There is no `.env` in this folder, or it gives `PROXY_NETWORK` no value. | Write it as in step 1. |
| `network <name> declared as external, but could not be found` | Wrong host, a wrong name in `.env`, or the stack of the host's reverse proxy is down. | Check the name in `.env` (step 1). If it is right, ask the host administrator to start the stack of the host's reverse proxy. |
| `/capability` shows an empty public key, claims fail with `wrong_supplier`, or the service stops at start with `environment variable SUPPLIER_PUB_KEY_HEX is required` | `SUPPLIER_PUB_KEY_HEX` or `SUPPLIER_PKH` is empty in the env file. The service refuses to start with an empty public key, and with one that is not the public key of `SUPPLIER_PKH` (the row that quotes `is not the public key of SUPPLIER_PKH`), because it publishes both. | Restore the four supplier lines from the offline copy of the env file (step 4), which holds them from one key, then recreate. Without a good copy, and only while the supplier address has received nothing, make the key again: empty the four lines with `sed -i 's/^\(SUPPLIER_[A-Z_]*\)=.*/\1=/' .env.advocate` and run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function). The block refuses a line that has a value, so it never replaces a key that holds units. Then refresh the offline copy and recreate. |
| Jobs fail with `service_unreachable` | The runtime cannot reach the service. | `docker exec advocate-agent printenv SERVICE_URL` must print `http://advocate-service:9094/`. Check that both containers run and sit on the network that `PROXY_NETWORK` in `.env` names. Report it with the logs of both containers. |
| Jobs fail with `service_http_401`, and the log of the service says `request refused: unauthorized (<n> since the last line of this kind)` | The runtime did not send the token the service holds: the two containers were created from different versions of the env file, or the line was changed after one of them started. | Run the comparison at the end of step 13: its two lines must be the same. If they differ, check that `/status` says `free`, then `up -d --force-recreate service` and `up -d --force-recreate agent`, and run the comparison again. The service logs this refusal once a minute at most, with the count since the last line, and never what the caller sent. |
| The service container keeps restarting and `docker logs advocate-service` says `environment variable OPERATOR_CONTACT is required` | The contact line in the env file is empty or missing. | Set it as in step 4, then `up -d --force-recreate service`. |
| The same, and the log says `environment variable SUPPLIER_PKH is required` | The supplier lines of the env file are empty: the supplier block of step 4 was not run, or did not finish. | Run only the supplier block of step 4 (the first block of that step first, in a new shell, to define the function; it leaves the file alone). It refuses while the key line has a value. Never run the whole step again, and never copy the example over the env file: that replaces a key that holds units. Then refresh the offline copy and recreate. |
| The same, and the log says `environment variable SERVICE_AUTH_HEADER is required`, or says that it must be printable ASCII | The token line of the env file is empty or missing, or holds a character that a header cannot carry. The service does not start without a token, so that it can never answer anyone. | Run the token block of step 4 (the first block of that step first, in a new shell, to define the function). It refuses while the line has a value: to replace a value that is wrong, empty the line first with `sed -i 's/^SERVICE_AUTH_HEADER=.*/SERVICE_AUTH_HEADER=""/' .env.advocate`. Then refresh the offline copy of the env file, and recreate the service, and the runtime too if it is running (with `/status` saying `free`), so that both hold the same value. |
| The same, and the log says `holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The token is in another line of the env file too, whole or by the part after `Bearer `. The message names that line and does not show the token. | Take the token out of the line it names: that line is published in the manifest, logged, or said in an answer of the service. Then recreate. |
| The same, and the log says `is not the public key of SUPPLIER_PKH` | The line of the supplier public key holds another value than the key of `SUPPLIER_PKH`: a private key by mistake, or lines from two keys. The message names both settings and shows no value. | Restore the four supplier lines from the offline copy of the env file, or, only while the supplier address has received nothing, make the key again, as in the `/capability` row above, then recreate. |
| The same, and the log says `environment variable BRAVE_SEARCH_API_KEY is required` | The line of the key of the Brave Search API is empty or missing: the block of the two API keys of step 4 was not run, or refused what was pasted. | Run the block of the two API keys of step 4 (the first block of that step first, in a new shell, to define the function). It asks only for a line that is empty. Then refresh the offline copy of the env file and recreate the service. |
| The same, and the log says `environment variable OPENROUTER_API_KEY is required` | The line of the key of OpenRouter is empty or missing, for the same reasons. | The same as the row above. |
| The same, and the log names another setting that holds one of the two API keys | One of the two keys is in another line of the env file too. The message names that line and shows no key. | Take the key out of the line it names: that line is published in the manifest, logged, or said in an answer of the service. Then recreate the service. |
| Jobs fail with `search_failed` (502), and the log of the service says `search: the key was refused (HTTP <status>)` | The Brave Search API refused the key with 401 or 403: the line holds another value than the key of the account, or the account no longer accepts it. The log gives the status and never the key. | Empty the line with `sed -i 's/^BRAVE_SEARCH_API_KEY=.*/BRAVE_SEARCH_API_KEY=/' .env.advocate`, run the block of the two API keys of step 4 (the first block of that step first, in a new shell, to define the function) with the right key, refresh the offline copy and recreate the service. |
| Jobs fail with `search_failed` (502), with no such line | Both search queries failed: each answered with a status other than 200 (a 5xx, or 429 twice: a query that answers 429 is asked once more, 1100 ms later), gave no answer within its time, could not be made (a network error, or a redirect, which is not followed), could not start before the end of the search, or gave an answer that is not a JSON object. A 429 means that the account takes no more queries for now. | Read the log line of the job, `job failed after <ms> ms: search_failed (502): both Brave queries failed: query 1 <why>, query 2 <why>`, which gives the reason of each query. A 429 or a 5xx: wait and let the next job try. A network error on both: check that the service reaches the web over https, as in the `no_sources` row. Another status of 400 to 499 on both: check the key and the account of the Brave Search API (the row above replaces the key). Report it with the log if it lasts. |
| Jobs fail with `search_empty` (502) | The two queries gave no usable result: none with an https URL. | Nothing on the host to fix: the search has nothing for that subject. The hirer can ask again in other words. |
| Jobs fail with `no_sources` (502) | No result page was kept: each one redirected, answered with a status other than 200, was not HTML or plain text, was over 1 MB, had under 200 characters of text, was refused or could not be reached (a host that resolves to a private or reserved address, a network error), did not answer within 15 s, or was still being fetched when the phase ended, 45 s after it began. | Read the log line `pages: 0 kept of <m> (redirect <a>, status <b>, type <c>, thin <d>, failed <e>)` first: a high `status` count means that the sites refuse the service or lack the pages, and a high `failed` count points at the network. Then check that the service reaches the web over https: `docker exec advocate-service node -e "fetch('https://example.org/').then((r) => console.log(r.status))"` prints 200. If it does, the pages of that subject cannot be read by the service. |
| Jobs fail with `model_failed` (502) | The call to OpenRouter answered with a status other than 200, gave a body over 4 MiB, gave a body that is not JSON or has no content, gave no answer within the full 90 s (with less time left, the job fails as `deadline`), or could not be made (a network error, or a redirect, which is not followed). The log says which, with the HTTP status when there is one. When the status is not 200 it shows the error of the provider: its code and the first 200 characters of its message when the answer is the JSON of an error, never its metadata, which can hold a part of the request, and the first 200 characters of the answer when it is not. For a 200 whose body is not JSON or has no content it gives the reason and the length of the body in characters, never its text. Never the key. | A 401 or a 403: the key is wrong or its account is no longer good for calls. Empty the line with `sed -i 's/^OPENROUTER_API_KEY=.*/OPENROUTER_API_KEY=/' .env.advocate`, run the block of the two API keys of step 4 (the first block of that step first, in a new shell, to define the function) with the right key, refresh the offline copy and recreate the service. A 429 or a 5xx: the model provider is busy, and the next job may pass. Any other status: read the text of the provider in the log line, its first 200 characters, and report it. |
| Jobs fail with `model_output_invalid` (502) | The model answered with text that is not the JSON of a brief. The log line of the job gives the reason and the length of the content in characters, never its text. | Report it with the log line. A change of `OPENROUTER_MODEL` changes the manifest, so it means a new advert (step 17, items 1 to 7). |
| Jobs fail with `no_supported_claims` (502) | The check dropped every argument: no quote the model gave was found in the text of the page it names. | Nothing on the host to fix. Report it with the log line of the job if it comes back. |
| Jobs fail with `deadline` (422) | The job ran out of its time: 150000 ms after its request arrived. The likeliest cause is that the model did not answer in the time it was given, which is the time left less 5 s: 85 to 90 s when the search and the pages have taken more than 55 s (when they took 55 s or less, the model gets the full 90 s and the same silence is `model_failed`). The job also fails this way when it has under 20 s left at the time the model was to start. | Read the log line of the job: `model: OpenRouter did not answer within <n> ms` before `job failed after <ms> ms: deadline (422)` is the silent model, with an `<n>` under 90000 (with 90000 the job fails as `model_failed`). If jobs keep reaching the deadline, the search, the pages or the model are slow from this host: report it with the log. |
| The env file changed and nothing happened | `restart` does not re-read it. | Once the runtime runs (step 13), check first that `curl -s http://127.0.0.1:8086/status` says `free`: a recreate stops the container, and a stop during a job can cut a job under escrow. Before step 13 no job can run. Then `up -d --force-recreate <service>`, and both containers after a change to `SERVICE_AUTH_HEADER`. |
| `invalid reference format` for the service image | The `image:` line still holds the placeholder `@sha256:<digest>`. | Pin the image as in step 2. |
| `No such image: sha256:...` for the service image | The pinned image is gone from the host: it was removed, by `docker image prune -a` for example. | Build it again and pin it (step 2). The new image has a new ID, and its manifest may differ: hash it again (step 11) before the next advert. |
| The served `/agent.json` hashes differently from the advert's `detail_hash` | The manifest changed after the advert was posted: the env file (`OPENROUTER_MODEL` among its lines), the image or the status word. | Retire the advert and post it again with the hash of the manifest that is served now (step 17, items 1 to 7). |
