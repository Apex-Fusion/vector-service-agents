# Runbook: the Sourcing Agent on the agents host

This runbook tells the operator what to do, in order, to run the Sourcing Agent on the agents host. [README.md](README.md) gives the facts of the host: the folders, the ports and the DNS records. [RUNBOOK.md](RUNBOOK.md) gives the steps that every agent of the host shares. This runbook gives the steps of the Sourcing Agent.

Three rules hold for every step:

- A runtime keeps its jobs in memory, and the service keeps the slot of its job in memory. Never restart a container of the Sourcing Agent while a job runs (section "The restart rule").
- No command in this runbook prints a key or the token. Never add one that does.
- The host builds no image. CI builds the images, and the compose file names each one by its digest.

## What it is

The Sourcing Agent is the agent of a buying organisation in use case 3 (supplier bid evaluation). A hirer sends it a request for quotation. The agent finds the Bid Desks that quote on the marketplace, hires the ones that its model invites for a signed quote each, scores the quotes that its model accepts, and returns a ranking. When the organisation has approved the ranking, the agent writes it to the sourcing record of the organisation. Its capability is `supplychain.rfq.evaluate.v1`.

It runs as two containers in one compose project, `sourcing-agent`: a runtime in front of a service. The runtime holds the supplier key, serves the advert, claims the escrow of the hirer and calls the service. The service holds the nine keys of the agent and does the work. It does one job at a time. It also serves the co-sign route, `POST /cosign/delegate`, outside the job slot. The three scorers, `scorer-1`, `scorer-2` and `scorer-3`, have no container and no endpoint: the service signs for each of them with its own two keys.

| Runtime | Container | Port on 127.0.0.1 | Host name | Advert model | Price (units) | Bonds (units) | Lock (units) |
|---|---|---|---|---|---|---|---|
| Sourcing | `sourcing-runtime` | 8107 | `mp-suppliers-sourcing.vector.apexfusion.org` | `sourcing-agent-v1` | 3 | 1 and 1 | 5 |

The service is the container `sourcing-service`, on `127.0.0.1:9105`. The lock of an advert is its price plus both bonds.

| Time | Value | Where |
|---|---|---|
| Window of the advert | 5,400,000 ms | `ADVERT_MAX_PROCESSING_MS` |
| Timeout of the runtime for the service | 5,280,000 ms | `SERVICE_TIMEOUT_MS` in the compose file |
| Deadline of a job in the service | 5,220,000 ms | the code of the service |

The deadline of a job is inside the timeout of the runtime, and the timeout is inside the window with 120 seconds to spare. The runtime refuses to boot with less than 60 seconds to spare. The escrow and the vault payment of a hirer stay locked up to the window, 90 minutes, when a job runs to its end. A job runs up to 5,220,000 ms. So every restart, every container that you create again and the back out wait until the runtime says `free` (section "The restart rule").

The operator makes four things outside this pack: the keys, the agent records (the record of the agent and the records of its three scorers), the stake and the claim of the agent, and the advert (with the hosted tools of the Vector marketplace). This runbook says when each one is needed and where its result goes. The operator commands of the operator pack make the stake and the claim, and they use the service key. This service never makes a stake and never makes a claim: it files a challenge only. The service does not start without its nine keys, `AGENT_DID`, the three DIDs of the scorers and `COMPLIANCE_ISSUER_PKH`. The runtime does not start without its advert.

The status word of the agent is `proposed`, in lower case. It stays `proposed` until the first live run. `AGENT_STATUS_CHIP` in the env file holds it.

The order of the work:

1. Make the DNS record.
2. Put the files in the folder, and make the env file.
3. Pull the images, and pin them in the compose file.
4. Check the compose file.
5. Start the service.
6. Add the Caddy block, and check the public name.
7. Post the advert.
8. Start the runtime.

Section "The start order" gives the steps 5 to 8.

## The files

| File | Use |
|---|---|
| `docker-compose.sourcing-agent.yml` | The compose project: a runtime and a service, the images by digest, the ports on `127.0.0.1`, and the keys that each container must not hold. |
| `.env.sourcing-agent.example` | The settings of both containers: the supplier lines, the nine keys of the service, the token and the published values. Names, placeholders and published values only. |
| `Caddyfile.sourcing-agent.snippet` | The host block, between two markers. |
| `RUNBOOK-sourcing-agent.md` | This runbook. |
| `.env.sourcing-agent` | Made on the host from the example. The service and the runtime both read it. |

The four files of the pack are in `deploy/server`. The env file holds ten keys and a token. It never enters git, and it has mode 600.

## The memory gate

Before each container start, `MemAvailable` must be at least 1,024 MiB. The gate holds for each of the two containers, and for each container that you create again. Check it with this command:

```sh
awk '/^MemAvailable:/ { mib = int($2 / 1024); word = (mib >= 1024) ? "ok" : "stop"; print word, mib, "MiB available" }' /proc/meminfo
```

Start no container while it prints `stop`. When it prints `stop`, no container starts: report the line that it printed, and stop the work here. Do not stop a container of another agent to make room, and do not lower a limit in the compose file. The section "The host" of [README.md](README.md) gives the planning sizes of a runtime and of a service, and what the other agents of the host leave free.

Read the real size of each container of the Sourcing Agent after its first start (section "The checks"), and write it down. Read it again with `docker stats` during the first `propose` job: the service builds up to three sub-delegations, and that is the peak of its memory. Write that figure down too.

## The DNS record

Make one A record in the DNS zone of the agents. The record is DNS only, and it points at the public IPv4 address of the host:

- `mp-suppliers-sourcing.vector.apexfusion.org`

Check the name against a public resolver:

```sh
dig +short mp-suppliers-sourcing.vector.apexfusion.org A @1.1.1.1
```

The answer must be the address of the host and nothing else. The address of a proxy means that the record is proxied: change it to DNS only. A proxy ends TLS before Caddy, and it replaces the body of an error answer. A job that the service ends answers 200 with its `reason`. When the runtime cannot finish a job, it answers 502 with a JSON body, and the buyer needs that body. Caddy gets the certificate of a name when it loads the block of the name, so the record must resolve first.

## The folder

The folder of the Sourcing Agent is `/srv/agents/sourcing-agent`. It belongs to the service user, `agents`, with mode 750. Make it with `install -d`. Do not use the set-up script of the host: it refuses to run on a host that already runs agents. The first command makes the folder. Run the third command in the folder that holds the files of `deploy/server` (the folder `agents-server` of RUNBOOK.md, step 2):

```sh
sudo install -d -m 750 -o agents -g agents /srv/agents/sourcing-agent
sudo stat -c '%a %U:%G %n' /srv/agents/sourcing-agent
sudo install -m 644 -o agents -g agents docker-compose.sourcing-agent.yml .env.sourcing-agent.example /srv/agents/sourcing-agent/
```

The output of `stat` must be `750 agents:agents /srv/agents/sourcing-agent`.

## The env file

Make the env file as the service user, with mode 600. The service and the runtime both read it:

```sh
sudo -u agents -H bash
cd /srv/agents/sourcing-agent
umask 077
cp .env.sourcing-agent.example .env.sourcing-agent
```

The keys come from the operator pack, and the key rules of RUNBOOK.md (section "Keys") hold for them. A key is never typed in a shell, and no command here prints one. There are ten keys, and all ten are different:

- The supplier key goes in the four `SUPPLIER_` lines. It is the key of the runtime. The service reads only the two public lines, `SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`: the compose file blanks `SUPPLIER_PRIV_KEY_HEX` for the service.
- The nine keys of the service go in nine lines. `SOURCING_SERVICE_PRIV_KEY_HEX` is the service key. It pays the model hires, signs the claim and the challenges, and signs the subject token of the agent. `SOURCING_DELEGATION_1_PRIV_KEY_HEX` and `SOURCING_DELEGATION_2_PRIV_KEY_HEX` are the keys that a delegation of a hirer names. Each one pays the quote hires, and signs the vault payment, the Accept and the sub-delegations of a job: up to three, one for each scorer. Each scorer has two keys, an authentication key and a delegation key: `SCORER_1_AUTH_PRIV_KEY_HEX` and `SCORER_1_DELEGATION_PRIV_KEY_HEX`, the same two lines for `SCORER_2` and for `SCORER_3`. A scorer holds no funds of its own. The compose file blanks all nine lines for the runtime.
- Each key has a line for its key hash after it, `SOURCING_SERVICE_PKH` and so on. The line is public and optional. When it has a value, the service checks it against the key at start.

The service pays from three of its keys: the service key and the two delegation keys. The six keys of the three scorers pay nothing: the wallet of the delegation key of the job pays the Delegate and the Undelegate of each scorer. So the four paying keys have four wallets: the supplier key of the runtime and those three. Each wallet needs two transfers. The first is one pure output of 5 units, alone, as collateral. The second is a float for the fees of its jobs. A wallet that gets both in one transfer can have its collateral merged into change by an ordinary transaction. The wallet of the service key also pays the stake and the claim, and it holds the stake of a challenge, `DISPUTE_CHALLENGE_STAKE_LOVELACE`, while a challenge is open.

Make the token, and write it into the file. The command prints nothing:

```sh
sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')\"|" .env.sourcing-agent
```

Fill the other lines with an editor:

- `OPERATOR_CONTACT` (a role address, never a person), `AGENT_DID`, `SCORER_1_DID`, `SCORER_2_DID`, `SCORER_3_DID`, `COMPLIANCE_ISSUER_PKH`, `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`. The four DIDs are four different agents: the agent and its three scorers. `COMPLIANCE_ISSUER_PKH` is the key hash of the compliance registry, the issuer of the attestations that the agent counts: 56 lowercase hex characters, a public value. The placeholder stays until you know the value, and the service does not start with it.
- `VECTOR_MODULE1_MANIFEST`: replace `<commit>` with the 40 hex digits of the commit that the hosted MCP server uses for its own `VECTOR_MODULE1_MANIFEST`.
- `AGENT_ID`: the 64 hex characters of the agent record, the part of `AGENT_DID` after `did:vector:`. `ADVERT_REF` stays empty until the advert exists (section "The start order", step 5).
- `COSIGN_ALLOWLIST`: the key hashes of the principals whose delegation the co-sign route may co-sign, separated by commas. The empty line holds nobody, and the route then signs for nobody. A change to this line needs the service created again (section "The restart rule").
- `AGENT_STATUS_CHIP` stays `proposed` until the first live run. `FAULT_MODE` stays empty (section "The fault switch").
- Leave every other line as it is. The comments in the example say what each line does.

The service reads the settings in this table, and the runtime reads the lines of the supplier key and of the chain. Each setting has a line in the example, or the compose file sets it:

| Settings | What to do |
|---|---|
| The nine key lines `SOURCING_SERVICE_PRIV_KEY_HEX`, `SOURCING_DELEGATION_1_PRIV_KEY_HEX`, `SOURCING_DELEGATION_2_PRIV_KEY_HEX`, `SCORER_1_AUTH_PRIV_KEY_HEX`, `SCORER_1_DELEGATION_PRIV_KEY_HEX`, `SCORER_2_AUTH_PRIV_KEY_HEX`, `SCORER_2_DELEGATION_PRIV_KEY_HEX`, `SCORER_3_AUTH_PRIV_KEY_HEX` and `SCORER_3_DELEGATION_PRIV_KEY_HEX` | Write each key with a command that prints nothing. |
| The nine key hash lines `SOURCING_SERVICE_PKH`, `SOURCING_DELEGATION_1_PKH`, `SOURCING_DELEGATION_2_PKH`, `SCORER_1_AUTH_PKH`, `SCORER_1_DELEGATION_PKH`, `SCORER_2_AUTH_PKH`, `SCORER_2_DELEGATION_PKH`, `SCORER_3_AUTH_PKH` and `SCORER_3_DELEGATION_PKH` | Optional. Write the key hash of the key before it, or leave the line empty. |
| `SERVICE_AUTH_HEADER` | The token: make it with the command above. |
| `SUPPLIER_PRIV_KEY_HEX`, `SUPPLIER_PUB_KEY_HEX`, `SUPPLIER_PKH`, `SUPPLIER_ADDRESS` | The supplier key of the runtime: write all four. |
| `OPERATOR_CONTACT`, `AGENT_DID`, `SCORER_1_DID`, `SCORER_2_DID`, `SCORER_3_DID`, `COMPLIANCE_ISSUER_PKH`, `AGENT_ID` | Fill each one, as above. |
| `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE`, `VECTOR_MODULE1_MANIFEST` | Fill each one, as above. |
| `COSIGN_ALLOWLIST` | Fill it with the principals, or leave it empty. |
| `ADVERT_REF` | Empty until the advert exists. |
| `IDENTITY_POLICY_ID`, `IDENTITY_ADDRESS`, `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED`, `VECTOR_IDENTITY_ESCROW_REF_UTXO`, `VECTOR_IDENTITY_VAULT_REF_UTXO`, `IDENTITY_ESCROW_REF_UTXO`, `IDENTITY_ADVERT_REF_UTXO` | The identity registry: leave them as the example has them. |
| `NETWORK_ID`, `OGMIOS_URL`, `VECTOR_ZERO_TIME_MS`, `LIVE_CHAIN`, `ESCROW_REF_UTXO`, `ADVERT_REF_UTXO` | The chain, for the runtime: leave them as the example has them. |
| `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL`, `VECTOR_SUBMIT_URL`, `VECTOR_MARKETPLACE_INDEXER_URL`, `IDENTITY_GATEWAY_URL` | Leave them empty: the code has the defaults of Vector mainnet. |
| `ADVERT_PRICE_LOVELACE`, `ADVERT_MAX_PROCESSING_MS` | The terms of the advert: leave them as the example has them. |
| `AGENT_VERSION`, `AGENT_STATUS_CHIP`, `AGENT_STATUS_SINCE`, `ADVERT_EXPLORER_URL` | The manifest: leave them as the example has them. |
| `LLM_MODEL_ALLOWLIST`, `LLM_MAX_PRICE_LOVELACE`, `LLM_MAX_SUPPLIER_BOND_LOVELACE`, `LLM_MAX_BUYER_BOND_LOVELACE`, `QUOTE_MAX_PRICE_LOVELACE`, `QUOTE_MAX_SUPPLIER_BOND_LOVELACE`, `QUOTE_MAX_BUYER_BOND_LOVELACE` | The limits of the hires: leave them as the example has them. |
| `COSIGN_MAX_CONCURRENT`, `COSIGN_MAX_FUTURE_MS`, `COSIGN_LEDGER_TIMEOUT_MS` | The limits of the co-sign route: leave them empty. |
| `DISPUTE_CHALLENGE_STAKE_LOVELACE`, `DISPUTE_MIN_WINDOW_LEFT_MS`, `DISPUTE_READ_TIMEOUT_MS`, `DISPUTE_RESOLUTION_DEADLINE_MS`, `DISPUTE_STARTED_LEASE_MS` | The dispute code: leave them as the example has them. The last two stay empty. |
| `FAULT_MODE` | The fault switch: empty (section "The fault switch"). |
| `PORT`, `HOST`, `SOURCING_STATE_DIR` | The compose file sets them. Do not write them in the env file. |

Then check the file. No command here prints a secret. The first prints the mode and the owner:

```sh
stat -c '%a %U:%G %n' .env.sourcing-agent
```

It must print `600 agents:agents .env.sourcing-agent`. The next command lists the lines of the file that still hold a placeholder. It prints the line number and the name, never the value. It must print nothing:

```sh
grep -nE '^[A-Z0-9_]+=.*<[^>]*>' .env.sourcing-agent | cut -d= -f1
```

This command prints the name of each required line that is empty. It must print nothing:

```sh
for name in SUPPLIER_PRIV_KEY_HEX SUPPLIER_PUB_KEY_HEX SUPPLIER_PKH SUPPLIER_ADDRESS SOURCING_SERVICE_PRIV_KEY_HEX SOURCING_DELEGATION_1_PRIV_KEY_HEX SOURCING_DELEGATION_2_PRIV_KEY_HEX SCORER_1_AUTH_PRIV_KEY_HEX SCORER_1_DELEGATION_PRIV_KEY_HEX SCORER_2_AUTH_PRIV_KEY_HEX SCORER_2_DELEGATION_PRIV_KEY_HEX SCORER_3_AUTH_PRIV_KEY_HEX SCORER_3_DELEGATION_PRIV_KEY_HEX SERVICE_AUTH_HEADER OPERATOR_CONTACT AGENT_DID SCORER_1_DID SCORER_2_DID SCORER_3_DID COMPLIANCE_ISSUER_PKH AGENT_ID MOCK_PUBLIC_BASE MOCK_MTLS_BASE; do
  [ -n "$(sed -n "s/^$name=//p" .env.sourcing-agent | tr -d '"')" ] || echo "empty: $name"
done
```

These commands print the length of the value of each key line and of some other lines, never the value:

```sh
awk -F= '/^(SUPPLIER_PRIV_KEY_HEX|SUPPLIER_PUB_KEY_HEX|SUPPLIER_PKH|SUPPLIER_ADDRESS|ADVERT_REF|AGENT_ID|COMPLIANCE_ISSUER_PKH)=/ { printf "%s=%d ", $1, length($2) }' .env.sourcing-agent; printf '\n'
awk -F= '/^(SOURCING_SERVICE|SOURCING_DELEGATION_1|SOURCING_DELEGATION_2|SCORER_1_AUTH|SCORER_1_DELEGATION|SCORER_2_AUTH|SCORER_2_DELEGATION|SCORER_3_AUTH|SCORER_3_DELEGATION)_(PRIV_KEY_HEX|PKH)=/ { printf "%s=%d\n", $1, length($2) }' .env.sourcing-agent
```

The first line must say `SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 AGENT_ID=64 ADVERT_REF=0 COMPLIANCE_ISSUER_PKH=56`. After step 5 of "The start order", `ADVERT_REF` has 66 characters. Each key line of the service must say 64. Each key hash line says 56, or 0 when you leave it empty.

No two keys may be one key. The service stops at start when two keys are equal, or when a key of the service is the supplier key. This command prints a key hash that stands twice among the key hash lines. It must print nothing:

```sh
sed -n 's/^\(SUPPLIER\|SOURCING_SERVICE\|SOURCING_DELEGATION_1\|SOURCING_DELEGATION_2\|SCORER_1_AUTH\|SCORER_1_DELEGATION\|SCORER_2_AUTH\|SCORER_2_DELEGATION\|SCORER_3_AUTH\|SCORER_3_DELEGATION\)_PKH=\(..*\)$/\2/p' .env.sourcing-agent | sort | uniq -d
```

## The images

The compose file names two images. CI builds both, and it pushes each one under `:latest` and under `:<full git commit sha>`. Use the tag of the commit that was reviewed. The service image is `ghcr.io/apex-fusion/vector-service-agents/sourcing-agent`. The runtime image is `ghcr.io/apex-fusion/vector-service-agents/agent-runtime`.

The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`. RUNBOOK.md (step 6, "Run the mock service") does the same for the mock service.

Pull both images. Put each digest in `docker-compose.sourcing-agent.yml`. The `sed` command changes the file only when the digest has 64 characters:

```sh
cd /srv/agents/sourcing-agent
REPO=ghcr.io/apex-fusion/vector-service-agents
COMMIT=<full git commit sha>
for image in sourcing-agent agent-runtime; do
  docker pull "$REPO/$image:$COMMIT"
  DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REPO/$image:$COMMIT" | sed 's/^.*@sha256://')
  if [ "${#DIGEST}" = 64 ]; then sed -i -E "s#($image@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" docker-compose.sourcing-agent.yml; else echo "no digest for $image: the compose file is not changed"; fi
done
grep -E '^    image: ' docker-compose.sourcing-agent.yml
```

The last command must print two `image:` lines with 64 hex digits. If a line still holds `<digest>`, compose refuses to start (`invalid reference format`).

## Check the compose file

First look at the file as compose renders it. Do it in a scratch folder with a stand-in env file, never in the folder of the real env file: the real file holds keys, and `docker compose config` prints the values of the env file into its output.

```sh
scratch=$(mktemp -d)
cp docker-compose.sourcing-agent.yml "$scratch/"
cp .env.sourcing-agent.example "$scratch/.env.sourcing-agent"
(cd "$scratch" && docker compose -f docker-compose.sourcing-agent.yml config | grep -E '^name:|image:|container_name:|host_ip:|published:|target:')
rm -r "$scratch"
```

The output must show the project `sourcing-agent`, two containers, and each port with `host_ip: 127.0.0.1`. The published ports are 8107 and 9105. The `target: /data` is the volume `sourcing-state` of the service. No network or build is in the file.

Then check the file with the real env file. This command prints nothing when the file is right. It stops with a message when the env file is missing:

```sh
docker compose -f docker-compose.sourcing-agent.yml config --quiet
```

The command does not look at the digests. This one does. It must print `0`:

```sh
grep -c '@sha256:<digest>' docker-compose.sourcing-agent.yml
```

## The start order

Run each `docker compose` command as the service user, in `/srv/agents/sourcing-agent`. Each start follows the memory gate. When the gate prints `stop`, start nothing, and stop the work at that step.

1. Pass the memory gate (section "The memory gate"). Start the service. This command also makes the network `sourcing-agent_default` and the volume `sourcing-state`:

   ```sh
   docker compose -f docker-compose.sourcing-agent.yml up -d service
   ```

2. Wait 30 seconds. Check the service:

   ```sh
   curl -fsS http://127.0.0.1:9105/healthz
   docker logs --tail 20 sourcing-service
   ```

   The first command prints `{"ok":true}`. The log has the line `[sourcing-agent] listening on 0.0.0.0:9105; manifest <hash>; wallets (service, delegation 1, delegation 2) <three addresses>; state directory /data`. The service asks the node for the start time of the chain, reads its three wallets and fetches the Module-1 manifest at start, so the start takes some seconds. If the container starts again and again, the log says why: read the failure table.

3. Join the Caddy container to the network, and add the block of the host name (section "The Caddy block"). The DNS record must resolve to the host first.
4. Check the public name, and take the hash of the manifest (section "The checks"). It is the `manifest` value of the line of step 2, and it is the `detail_hash` of the advert.
5. Post the advert. This pack does not post it: the operator posts it with the hosted tools of the Vector marketplace. Post it for the supplier key of the runtime, with the `AGENT_ID` of the agent record. The terms of the advert are:
   - the capability `supplychain.rfq.evaluate.v1`;
   - the model `sourcing-agent-v1`;
   - the price 3 units, with a supplier bond of 1 unit and a buyer bond of 1 unit;
   - the window 5,400,000 ms;
   - `endpoint_url`: the origin of the host name, `https://mp-suppliers-sourcing.vector.apexfusion.org`;
   - `detail_uri`: that origin and `/agent.json`;
   - `detail_hash`: the hash of step 4.

   Keep the Post transaction hash in the deployment record before waiting for confirmation. Verify its output on the ledger. If confirmation is unknown, stop here and check the same hash. Do not post another advert.
   Write the reference of the advert, `<transaction hash>#<output index>`, into `ADVERT_REF` of `.env.sourcing-agent`. A change to the manifest after this step means a retired advert and a new one. After you post a new advert, write its reference into `ADVERT_REF`, and create the runtime again with `up -d --no-deps --force-recreate runtime`, as section "The restart rule" says. A runtime that holds the reference of a retired advert refuses every job with 503 `advert_not_active`.
   Set the existing `ADVERT_REF` entry. Do not append a second entry or print the rest of the env file.
6. Start the runtime. Pass the memory gate first. After the start, wait 30 seconds, and check that the runtime is up and says `free`:

   ```sh
   docker compose -f docker-compose.sourcing-agent.yml up -d --no-deps runtime
   curl -fsS http://127.0.0.1:8107/healthz
   curl -s http://127.0.0.1:8107/status
   ```

   The option `--no-deps` keeps compose from touching the service: a start of the runtime never creates the service again.
   Read `GET /capability` on port 8107. Require HTTP 200 and an `advert_ref` equal to the confirmed output reference from step 5. A different reference or no answer is not ready for a hire.
7. Run the other checks of section "The checks".

## The checks

Each command only reads. None prints a secret.

1. The two containers answer on the loopback address. Each command prints `{"ok":true}`:

   ```sh
   for port in 8107 9105; do printf '%s: ' "$port"; curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"; printf '\n'; done
   ```

2. The runtime says `free`. The word `working` means that a job runs:

   ```sh
   curl -s --max-time 5 http://127.0.0.1:8107/status || printf 'no answer'
   ```

3. No container of the Sourcing Agent has a public port. The command must print `ok: no public port of the Sourcing Agent`:

   ```sh
   docker ps --filter name='^sourcing-' --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public port of the Sourcing Agent'
   ```

   If a port is public, stop the container. Write `127.0.0.1:` before the port in the compose file, and start the container again.

4. The runtime holds no key of the service, and the service holds no supplier key. Each command prints `blank`:

   ```sh
   docker exec sourcing-runtime sh -c 'test -z "$SOURCING_SERVICE_PRIV_KEY_HEX$SOURCING_DELEGATION_1_PRIV_KEY_HEX$SOURCING_DELEGATION_2_PRIV_KEY_HEX$SCORER_1_AUTH_PRIV_KEY_HEX$SCORER_1_DELEGATION_PRIV_KEY_HEX$SCORER_2_AUTH_PRIV_KEY_HEX$SCORER_2_DELEGATION_PRIV_KEY_HEX$SCORER_3_AUTH_PRIV_KEY_HEX$SCORER_3_DELEGATION_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   docker exec sourcing-service sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   ```

5. The advert has the hash of the manifest. Run this command from a checkout of this repository, on any machine. It needs no key. It prints one line of JSON with the `detail_uri`, the `detail_hash` and the number of bytes:

   ```sh
   node scripts/manifest-hash.mjs https://mp-suppliers-sourcing.vector.apexfusion.org
   ```

   The `detail_hash` must be the `manifest` value in the line `listening on` of the service. After the advert exists, the `detail_hash` of the advert must be this value. If it is not, retire the advert and post a new one with this hash. Then write the new reference into `ADVERT_REF` of `.env.sourcing-agent`, and create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). A runtime that keeps the reference of the retired advert refuses every job with 503 `advert_not_active`.

6. The runtime serves its card. The first command prints one JSON document with the interface `https://mp-suppliers-sourcing.vector.apexfusion.org/v1/job`. The second prints `200`:

   ```sh
   curl -fsS https://mp-suppliers-sourcing.vector.apexfusion.org/.well-known/agent-card.json
   curl -fsS -o /dev/null -w '%{http_code}\n' https://mp-suppliers-sourcing.vector.apexfusion.org/
   ```

7. The co-sign route reaches the service. The call holds no transaction, so it signs nothing. The answer is `400` with the code `bad_shape`. Another answer means that Caddy does not send the path to the service (section "The Caddy block"):

   ```sh
   curl -sS -w '\n%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' https://mp-suppliers-sourcing.vector.apexfusion.org/cosign/delegate
   ```

8. Read the size of each container, and the memory that is left. Write the figures down:

   ```sh
   docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' sourcing-runtime sourcing-service
   awk '/^MemAvailable:/ { print int($2 / 1024), "MiB available" }' /proc/meminfo
   ```

## The Caddy block

Caddy runs in a container on the host. `<caddy container>` is the name of that container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`. The block is in `Caddyfile.sourcing-agent.snippet`, between the two lines `# sourcing-agent vhosts (BEGIN)` and `# sourcing-agent vhosts (END)`. It holds one host block. It sends `/agent.json` and `/cosign/delegate` to `sourcing-service:9105`, and every other path to `sourcing-runtime:8080`. The name must be a DNS only record that resolves to the host (section "The DNS record").

Only this way works for this pack. Its upstreams are container names, so only a Caddy container on the network of the project resolves them. A folder of snippets does not fit, and Caddy on the host cannot resolve the names.

1. Join the Caddy container to the network of the project. Compose makes the network when it starts the service. Do it once, and again after each new Caddy container. The second command must list `<caddy container>` and `sourcing-service`, and also `sourcing-runtime` after step 6 of "The start order". The network lists the runtime only after that step:

   ```sh
   docker network connect sourcing-agent_default <caddy container>
   docker network inspect sourcing-agent_default --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

2. Keep a copy of the file, and check that it has no block of the Sourcing Agent yet. The second command must print `0`:

   ```sh
   cp -p <caddyfile> <caddyfile>.before-sourcing-agent
   grep -c '^# sourcing-agent vhosts (BEGIN)$' <caddyfile>
   ```

3. Add the block to the end of the file, in place. Append to the file: do not replace it. The container mounts one file, and a mount follows the inode of that file. A new file that takes its place has another inode, and the container does not see it. Run this in the folder that holds `Caddyfile.sourcing-agent.snippet`:

   ```sh
   sed -n '/^# sourcing-agent vhosts (BEGIN)$/,/^# sourcing-agent vhosts (END)$/p' Caddyfile.sourcing-agent.snippet >> <caddyfile>
   ```

4. Validate the whole file in the Caddy container. The answer must say `Valid configuration`. Then reload Caddy:

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   If the validation fails, write the old file back, in place, and read the error:

   ```sh
   cat <caddyfile>.before-sourcing-agent > <caddyfile>
   ```

   Do not leave a file that fails to validate on the host. A new Caddy container reads that file, and it does not start with it. Never restart Caddy: a restart cuts the connections that are open. A reload keeps them.
5. Watch the certificate. The log must say `certificate obtained successfully` for the name:

   ```sh
   docker logs --since 5m <caddy container> 2>&1 | grep -E 'certificate obtained|error'
   ```

To replace the block after a change, remove it, and then add it again. To remove it, write the file without the lines from `# sourcing-agent vhosts (BEGIN)` to `# sourcing-agent vhosts (END)`, in place. Then validate and reload as in step 4:

```sh
sed '/^# sourcing-agent vhosts (BEGIN)$/,/^# sourcing-agent vhosts (END)$/d' <caddyfile> > caddyfile.new
cat caddyfile.new > <caddyfile>
```

## The restart rule

A runtime keeps its jobs in memory. The service keeps the slot of its job, and the slot that a go of the check before the Claim reserves for 120 seconds, in memory too. A restart of a container of the Sourcing Agent cuts the job that runs, and a job under escrow can then fail for the buyer. The escrow and the vault payment of the hirer then stay locked up to the window of the advert, 5,400,000 ms (90 minutes). The records on the volume stay: the janitors of the next start reclaim the escrows that a cut job left, and end its sub-delegations. A restart during a run is forbidden.

These actions are restarts of a container: `docker restart`, `docker compose restart`, `docker compose up -d --force-recreate`, `docker compose up -d` after a change of an image or of the env file, a reboot of the host and a power-off. These are not restarts: a reload of Caddy, a change of the Caddy block, and the first start of a container.

The service does not say anything about its slot, and a job can start at any time. So every restart has three steps, in this order, and the third follows the second with no pause:

1. Wait 2 minutes after the last job. A go of the check before the Claim keeps the slot for 120 seconds. After the wait, no slot is held for a job that has not started.
2. Check that the runtime says `free`. The word `working` means that a job runs: do not restart, wait for the job to end, and begin again at step 1.
3. Run the `up` command at once. Never check first and then wait: a job that starts in a wait after the check is cut.

This command does the three steps without a gap. It waits 2 minutes, checks `/status`, and creates the container only when the runtime says `free`. A container reads its env file when it is created, so use the command after each change of the env file. Use the name of the compose service: `service` or `runtime`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8107/status | grep -q '"status":"free"'; then docker compose -f docker-compose.sourcing-agent.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

When the command prints the last words, nothing was restarted. Run it again after the job ends. The stop of section "Back out" follows the same three steps.

The runtime says `free` when it holds no job of its own. When the runtime hangs up on a job, the service stops that job at its next step, and a step that has started runs to its end. The longest such step is a quote hire that has paid: it runs to its end, up to 1,830,000 ms (the reserve of a quote hire, about 30 minutes). So the service can work for up to that time after the runtime says `free`. Before a restart of the service:

1. Read the log: `docker logs --tail 20 sourcing-service`. The service logs the end of each job with the line `<operation> done in <ms> ms`.
2. When a job is still open, wait for that line.
3. Then run the command above.

The allowlist of the co-sign route is an env line: `COSIGN_ALLOWLIST` in `.env.sourcing-agent`. The service reads it at start, so a new principal needs the service created again, with the command above. The register of the keys that a co-signed delegation uses is on the volume, so a restart does not free a key that was used. A call to the route that arrives while the service stops gets no answer: the caller asks again.

A change to `SERVICE_AUTH_HEADER` needs the service and the runtime created again, so that the two hold one value. Write `service runtime` in place of `service` in the command: one command creates both. A new image is a restart too: pin it as in section "The images", and create only the containers that use it, with the same command.

A stop of the service waits up to 300 seconds for the job that runs. Compose waits 330 seconds before it kills the container: the 30 seconds more are for the service to log a job that it abandoned, and to exit. The 330 seconds cover that wait only. A job runs up to 5,220,000 ms, so never stop the service while the runtime says `working`. A runtime has the default grace period of 10 seconds, so never stop a runtime that says `working`.

Never restart Caddy. Reload it (section "The Caddy block").

## The fault switch

The service reads `FAULT_MODE` one time, when it starts. The line is empty for a clean run. The one other value is `invert_scores`. Any other value stops the start (section "The failure table").

The value `invert_scores` is for a failure run only. With it, the scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value. The other scorers are not changed. The ranking then lists scores that the quotes did not earn. Use it for a failure run, and for nothing else.

1. Create the service again only when the runtime says `free`, and never during a run. Write `FAULT_MODE=invert_scores` in `.env.sourcing-agent` first. After the run, write `FAULT_MODE=` again, and create the service again once more.
2. Create the service again with the command of section "The restart rule". An env change needs a new container: a restart does not read the file. The runtime does not read the switch, so the service is the one container to create again.
3. Read the switch from the running container, never from the file. The command prints the value between brackets and prints nothing else:

   ```sh
   docker exec sourcing-service sh -c 'printf "FAULT_MODE=[%s]\n" "$FAULT_MODE"'
   ```

   A clean run needs `FAULT_MODE=[]`. A failure run needs `FAULT_MODE=[invert_scores]`. Do this check before each run.

The manifest does not hold the value of the switch, so a change of the switch never changes the hash of the manifest, and the advert stays as it is. The result of every job carries the member `fault_mode`. It is the empty text in a clean run, and it is `invert_scores` in a failure run, so a result says which kind of run it belongs to.

## The failure table

A failed start of the service or of the runtime shows in `docker ps` as `Restarting`. Read `docker logs --tail 20 sourcing-service` or `docker logs --tail 20 sourcing-runtime`. The service prints `[sourcing-agent] cannot start:` and a message. The message names the variable and never shows its value.

A job that fails is no failed start. A failed job answers 200 with its `reason`, and 502 only when the runtime cannot finish it. The log line of a job is `<operation> done in <ms> ms: outcome <outcome>, reason <reason>, exit <state>, decisions <count>`. A `propose` line adds the number of the files of the bidders and of the records of the quotes: `, bidders <count>, quotes <count>`. The last rows of the table give the reasons that an operator sees in a result.

| Symptom | Cause | Action |
|---|---|---|
| `invalid reference format` for an image | A placeholder `<digest>` is still in the compose file. | Pin the images (section "The images"). |
| `denied` on `docker pull` | The package is private. | Make the package public, or log in to `ghcr.io` with a token that has the scope `read:packages`. |
| Compose says that the env file is not found | The env file is missing, or compose runs in another folder. | Make the file from its example (section "The env file"). Run compose in `/srv/agents/sourcing-agent`. |
| A start fails with a port that is allocated or in use (8107 or 9105) | Another program holds the port. | Find it with `ss -ltnp`. Do not change a port: the Caddy block, the runbook and the guard test name these ports. |
| `[sourcing-agent] cannot start: environment variable SOURCING_SERVICE_PRIV_KEY_HEX is required`, or `must be 64 hex characters` | A key line of the service is empty or wrong. The message names the line. | Write the key with a command that prints nothing (section "The env file"). The nine lines are `SOURCING_SERVICE_PRIV_KEY_HEX`, `SOURCING_DELEGATION_1_PRIV_KEY_HEX`, `SOURCING_DELEGATION_2_PRIV_KEY_HEX`, `SCORER_1_AUTH_PRIV_KEY_HEX`, `SCORER_1_DELEGATION_PRIV_KEY_HEX`, `SCORER_2_AUTH_PRIV_KEY_HEX`, `SCORER_2_DELEGATION_PRIV_KEY_HEX`, `SCORER_3_AUTH_PRIV_KEY_HEX` and `SCORER_3_DELEGATION_PRIV_KEY_HEX`. |
| `... holds the same key as ...: each key of the service must be a key of its own` | Two key lines of the service hold one key. | Make a key for each line. |
| `... holds the key of SUPPLIER_PKH: the supplier key is the runtime's` | A key of the service is the supplier key. | Make a key of its own for the service. The supplier key belongs to the runtime. |
| `... holds the service key, which belongs in SOURCING_SERVICE_PRIV_KEY_HEX alone`, or `... holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | A key or the token stands in another line too. The words before "which" name the key (`the first delegation key`, `the authentication key of scorer-1` and so on). The message names that line and does not show the value. | Take it out of the line that the message names. |
| `... SOURCING_SERVICE_PKH (56 characters) is not the key hash of the key in SOURCING_SERVICE_PRIV_KEY_HEX` | A key hash line does not belong to the key before it. The same message holds for each of the other eight. | Correct the line, or leave it empty. |
| `... SERVICE_AUTH_HEADER is required`, or `must be printable ASCII` | The token line is empty, or it holds a character that a header cannot carry. | Make the token again (section "The env file"). Create the service and the runtime again with the command of section "The restart rule". |
| `... SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH` | The two lines come from two keys, or a private key is in the line of the public key. | Copy both values from the key of the runtime. |
| `... AGENT_DID is required`, or `... must be did:vector: and 64 lowercase hex characters` (the same for `SCORER_1_DID`, `SCORER_2_DID` and `SCORER_3_DID`) | A DID line is empty or has the wrong form. | Write `did:vector:` and the 64 hex characters of the agent record. |
| `... SCORER_1_DID holds the DID of AGENT_DID`, or `... SCORER_2_DID holds the same DID as SCORER_1_DID` (the same for the third scorer, and for each pair) | A scorer has the DID of the agent or of another scorer. The agent and its three scorers are four agents. | Write the DID of the record of each scorer. |
| `... COMPLIANCE_ISSUER_PKH is required`, or `must be 56 hex characters` | The line is empty, or it still holds the placeholder, or it is not a key hash. | Write the key hash of the compliance registry: 56 lowercase hex characters. |
| `... MOCK_PUBLIC_BASE must be an https origin`, or `... MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE` | A placeholder is still in the line, or the two origins name one host. | Write the origin of the mock host and the origin of the mock mtls host. |
| `... VECTOR_MODULE1_MANIFEST must be an https address` | The line holds a file path, an http address, or an address with a user, a password, a query or a fragment. | Write the https address as the example has it. |
| `... VECTOR_MODULE1_MANIFEST must be pinned to a commit` | The placeholder `<commit>` is still in the line, or the address names a branch or a tag. | Write the 40 hex digits of the commit that the hosted MCP server uses. |
| `The Module-1 manifest (VECTOR_MODULE1_MANIFEST)` cannot be fetched | The host cannot reach the address, or the commit has no manifest at that path. | Check that the host reaches the address with `curl -sSI`. Write the commit that the hosted MCP server uses. |
| `the Module-1 manifest (VECTOR_MODULE1_MANIFEST) names another identity registry than IDENTITY_POLICY_ID` | The commit holds the manifest of another deployment. | Write the commit that the hosted MCP server uses. |
| `... IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give` | One of the three published values is wrong. | Copy the three values from the example. |
| `... VECTOR_OGMIOS_URL must be an https address` | The line holds an http address. The janitor reads the tip of the node with an https address only. | Empty the line, or write an https address. |
| `the node gave no start time of the chain` | The host does not reach the node (`VECTOR_OGMIOS_URL`), or the node gives no answer in 15 seconds. | Check that the host reaches the node. Start the service again when it answers. |
| `... SOURCING_STATE_DIR names /data, which cannot be written` | The volume is not writable for the user `node`. | Run `docker volume inspect sourcing-state`. A new volume that is empty can be removed. A volume that holds records is not removed: make its data belong to `node`. |
| `... FAULT_MODE must be empty or "invert_scores"` | The switch holds another value. | Empty the line, or write the one value of this agent (section "The fault switch"). |
| `... ADVERT_MAX_PROCESSING_MS must be at least 5400000` | The window line is under the window that the deadline of a job assumes. | Write 5400000, as the example has it. |
| `... ADVERT_MAX_PROCESSING_MS must be at most 86400000` | The window line is above 24 hours, the longest window that a Post accepts. | Write 5400000, as the example has it. |
| `... LLM_MODEL_ALLOWLIST is required`, or `... must be a whole number of lovelace of more than 0` (the same for each line of `LLM_MAX_`, `QUOTE_MAX_` and `DISPUTE_CHALLENGE_STAKE_LOVELACE`) | A limit line is empty or wrong. The service never fills in a limit. | Write the value of the example. |
| `... DISPUTE_MIN_WINDOW_LEFT_MS must be a whole number of milliseconds of at least 2000`, or `... DISPUTE_READ_TIMEOUT_MS must be a whole number of milliseconds of at most 30000` | A time line of the dispute code is out of its range. A quote hire keeps time for a challenge that assumes reads of at most 30,000 ms. | Write the value of the example. The two optional lines stay empty. |
| `the settings of the co-sign route are refused: COSIGN_ALLOWLIST is not set` | The line of the allowlist is missing, or an entry on it is no key hash of 56 lowercase hex characters. | Keep the line: empty, or with key hashes separated by commas. |
| A runtime starts again and again, and its log says `loadConfig: missing required env var ADVERT_REF` | The runtime started before its advert existed. It never boots, so it holds no job. | Stop it with `docker compose -f docker-compose.sourcing-agent.yml stop runtime`. Finish step 5 of "The start order". |
| A runtime log says `loadConfig: PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the origin of the host name, as the compose file has it. |
| Caddy answers 502 for the host name | The Caddy container is not on the network, or a container of the Sourcing Agent is down. | Check with `docker network inspect sourcing-agent_default ...` (section "The Caddy block") and `docker ps`. Join the network again. |
| Caddy gets no certificate for the name | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (section "The DNS record"). Read the log of the Caddy container. |
| The hash of `/agent.json` is not the `detail_hash` of the advert | A setting of the manifest changed after the advert was posted: an env line of the service, the image or the status word. | Retire the advert. Post a new advert with the hash that is served now. Write its reference into `ADVERT_REF` of `.env.sourcing-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `advert_not_active` (503) | The runtime holds the reference of an advert that is retired or not active, so it refuses every job. | Post a new advert when none is active. Write the reference of the active advert into `ADVERT_REF` of `.env.sourcing-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `precheck_failed` (503) | The service answered the runtime with 401 `unauthorized`: the two containers were created from two versions of `SERVICE_AUTH_HEADER`. The log of the runtime says that the service refused the token. | Create the service and the runtime again with the command of section "The restart rule", with `service runtime` as the names. |
| `busy` (409) | The service works on a job, or it keeps its slot for another escrow for up to 120 seconds, or the co-sign route works on as many calls as `COSIGN_MAX_CONCURRENT` allows. | Wait. Nothing to fix. The caller sends the call again. |
| `supplier_busy` (409) | The runtime works on a job itself. | Wait. Nothing to fix. |
| `precheck_timeout` or `precheck_unreachable` (503) | The service gave no answer in 10 seconds, or the runtime could not connect to `sourcing-service:9105`. | Check `docker ps`, `docker logs --tail 20 sourcing-service` and `/healthz` on port 9105. |
| `precheck_bad_status` (502) | The service answered with a redirect, or with a status that the runtime does not read. | Read the log of the service. |
| `shutting_down` (503) | The service is stopping: it takes no new job. | Wait for the start. Check `docker ps` and the log of the service. |
| `bad_context` (400) | The call has none, some, or a bad one of the six context headers. A runtime that runs the image of CI sends all six. | Check that the runtime runs the runtime image of the compose file, and not an older build. |
| `bad_wire`, `request_too_large` or `bad_shape` (400) | The request is not the wire message, it is over 1,000,000 bytes, or it is no request of use case 3 for this agent (the tenant has 1 to 48 lower-case letters, digits and hyphens). | Nothing on the host. The buyer fixes its request. |
| `delegation_not_mine` (400) | The delegation of the hirer names another agent as its delegate. | Nothing on the host, unless every job gets it: check `AGENT_DID`. |
| `internal` (500) | A fault in the service, or a setting of the agent that the job refuses. The buyer gets fixed words. | Read the log line of the job. Report it. |
| `principal_not_allowed` or `spends_agent_funds` (403) from `/cosign/delegate` | The principal is not on `COSIGN_ALLOWLIST`, the delegator did not sign first, or the transaction spends funds of the agent. | Nothing on the host for a transaction that spends funds. Add the key hash of the principal to the allowlist only when the principal may use the agent (section "The restart rule"). |
| `not_a_delegation`, `not_for_this_agent` or `expired` (400) from `/cosign/delegate` | The transaction is no Delegate of this agent, or its validity window ended or is too far ahead. | Nothing on the host. The caller builds the transaction again. |
| `key_in_use` (409) from `/cosign/delegate` | A delegation key that the transaction names is in use by another co-signed delegation. The register on the volume keeps that after a restart. | Nothing on the host. The caller asks for the other delegation key. |
| `check_unavailable` (503) from `/cosign/delegate` | The route could not read the ledger or the register in `COSIGN_LEDGER_TIMEOUT_MS`. | Check that the host reaches the node and that `cosign-register.json` is on the volume. The caller asks again. |
| `ledger_unavailable`, `delegation_not_found` or `delegation_key_unknown` as the `reason` of a failed job | A read of the ledger gave no answer in time, the ledger shows no such delegation, or the delegation of the hirer names a key that the service does not hold. | Check that the host reaches the node and the indexer. For `delegation_key_unknown`, nothing on the host unless every job gets it: check the two delegation key lines. |
| `bidders_unavailable` or `no_bidders` as the `reason` of a failed job | `bidders_unavailable`: the listing of the adverts could not be read, or the chain gave no usable reading for the adverts of the bidders, so no bidder could be confirmed. `no_bidders`: every read worked, and no Bid Desk passes: none has an advert that the indexer lists and the chain shows, with a record that lists its supplier key. | For `bidders_unavailable`, check that the host reaches the indexer and the node (`VECTOR_MARKETPLACE_INDEXER_URL`, `VECTOR_OGMIOS_URL`, `VECTOR_KOIOS_URL`). For `no_bidders`, check that the Bid Desks have active adverts and agent records. |
| `shortlist_unknown_bidder`, `nobody_invited`, `ranking_invalid`, `decision_mismatch` or `bad_document` as the `reason` of a failed job | The model invited nobody, or a bidder that is not a candidate. Or the model gave an order that is not an order of the accepted quotes (`ranking_invalid`), or a choice that the job cannot read or that differs from the choice that the decision recorded (`decision_mismatch`, `bad_document`). | Read the log line. Nothing to fix when it happens once. The decisions that the model made stay in the result. |
| `no_quotes` as the `reason` of a failed job | No bidder gave a quote that the agent accepted. A bidder that the fan-out reached too late is left out with `deadline`. A Bid Desk that already holds an answer to the same `rfq_id` from this agent refuses with `duplicate_rfq`, and each Bid Desk keeps that answer for ever. | Read the quote records in the result. After `duplicate_rfq` nothing is wrong on the host: the hirer sends a new request with a new `rfq_id`. |
| `vault_refused`, `no_price_list` or `status_unreadable` as the reason of a bidder that was left out | The vault of the hirer refused the payment of the quote, and nothing was paid. Or the bidder has no price list that the agent can check, or the agent could not read the status of the bidder before it paid. | Nothing on the host for `vault_refused`: the vault and the delegation decide. For the other two, check that the host reaches the indexer, the node and the host of the bidder. |
| `quote_invalid`, `quote_not_from_bidder`, `quote_not_for_rfq` or `quote_not_from_list` as the reason of a bidder that was left out | The check in code refused the quote before the model saw it: it is no valid quote, it is not from the bidder, it does not answer this request, or it names another price list than the one that the agent read. | Nothing on the host. The Bid Desk or its operator fixes the quote. |
| `suspended`, `revoked`, `retired` or `not_found` as the reason of a bidder with `not_active` | The agent read the status of the record of the bidder again before it paid, and the bidder is not active. | Nothing on the host. |
| `decision_failed` or `decision_timeout` as the reason of a bidder that was left out, or `store_write_failed` as the `reason` | The model gave no valid decision on the quote in time, or the service could not write a record on the volume. | Read the log line. Check the wallet of the service key. For `store_write_failed`, check the volume `sourcing-state` and the disk. |
| A `reason` that starts with `sub_delegation_` as the `reason` of a failed job | The sub-delegation of a scorer failed. The log line names the scorer. A sub-delegation that a job leaves keeps the key of its scorer busy until the janitor of the service ends it. | Read the log line. Check the wallet of the delegation key of the job: it needs its collateral and a float, because it pays the Delegate and the Undelegate. Wait for the janitor before the next `propose`. |
| `scorer_token_failed`, `vendors_refused`, `vendors_failed` or `vendors_invalid` as the `reason` of a failed job | The identity gateway gave no token for a scorer, or the vendor master of the mock systems refused the read, did not answer, or gave a list that is not valid. | Read the log line: it names the scorer and the code. Check the keys and the purposes in the record of that scorer, `MOCK_PUBLIC_BASE`, the tenant, and the mock service. |
| `scorer_threw`, `scorer_timed_out` or `score_invalid` as the `reason` of a failed job | The job of a scorer failed, took more than its 420,000 ms, or the model gave no valid score. | Read the log line. Check the wallet of the service key. |
| A `reason` that starts with `llm_`, or `hire_threw` or `model_output_invalid`, as the `reason` of a failed job | The hire of the model failed, or the model gave no valid choice. | Read the log line. Check the wallet of the service key: it needs its collateral and a float. |
| `token_failed` as the `reason` of a failed `execute` | The identity gateway gave no token for the route `sourcing.rankings`. | Check the keys and the purposes in the record of the agent, and check that the host reaches the identity gateway. |
| `ranking_not_for_tenant` as the `reason` of a failed `execute` | The ranking that the hirer approved is for another tenant than the request. | Nothing on the host. The hirer sends the request again with the right tenant. |
| `mock_system_failed` as the `reason` of a failed `execute` | The call to the sourcing record did not give an answer that says the ranking was written. The ranking may be written. | Check `MOCK_PUBLIC_BASE`, the tenant, and the mock service. Read the sourcing record before the hirer sends `execute` again: the service never repeats the call, and the record has no rule of one ranking for each request. |
| The log line of an `execute` says `outcome refused_by_system` | The sourcing record refused the ranking, and the `reason` is its code, for example `approval_expired` or `delegation_ended`. | Nothing on the host: the sourcing record decides. The hirer fixes its side. |
| `deadline` or `aborted` as the `reason` of a failed job | A `propose` ran out of its 5,220,000 ms, or an `execute` ran out of its 120,000 ms, or the runtime hung up before the job ended. The agent starts a quote hire only while 2,910,000 ms or more are left, and the scoring only while 1,080,000 ms or more are left. | Read the log line of the job. Nothing to fix when it happens once. With slow Bid Desks the job proposes from fewer quotes. |

## Back out

To take the Sourcing Agent out of service, retire its listing first. An escrow that already exists can still need work.

1. Check each recorded Post and the current advert outputs for this agent ID, supplier and model. An empty `ADVERT_REF` does not prove that no Post landed. If a Post may still land, or the ledger read fails, stop here. Retire every matching active advert with `vector_build_marketplace_advert_retire` and the supplier key of the runtime. Confirm each Retire with `vector_await_transaction`. Skip retirement only when no matching advert is active and no Post can still land.
2. If the runtime started, let its last job end and then wait 2 minutes. If the runtime never started, verify that fact with the deployment record and container history. A missing container or a failed `/status` request is not proof.

   For either path, complete [the ledger check](RUNBOOK.md#check-the-ledger-before-a-use-case-3-stop) before you stop anything. Leave the runtime, service and Caddy block in place if work is outstanding or proof is unavailable.

   If the runtime started, require `free` and zero active sessions at the stop. Compose waits up to 330 seconds for the service:

   ```sh
   status=$(curl -fsS --max-time 5 http://127.0.0.1:8107/status) &&
     printf '%s\n' "$status" | grep -q '"status":"free"' &&
     printf '%s\n' "$status" | grep -Eq '"active_sessions":0[,}]' &&
     docker compose -f docker-compose.sourcing-agent.yml stop
   ```

   If the runtime never started, stop the service alone with `docker compose -f docker-compose.sourcing-agent.yml stop service`. Continue only after the applicable stop succeeds.

3. Remove the Caddy block, as section "The Caddy block" says. Validate and reload Caddy.
4. Leave the network of the project before the `down` command, because the Caddy container is on it. Do not use `-v`:

   ```sh
   docker network disconnect sourcing-agent_default <caddy container>
   docker compose -f docker-compose.sourcing-agent.yml down
   ```

5. Keep the volume `sourcing-state`: it holds the escrows of each of the three paying keys, the journal of the dispute code, the sub-delegations that a job left and the register of the co-signed transactions. Keep the env file too. Delete a key file only when its wallet is empty: a key that is deleted cannot be made again.
6. Remove the DNS record when nobody uses the name again.
