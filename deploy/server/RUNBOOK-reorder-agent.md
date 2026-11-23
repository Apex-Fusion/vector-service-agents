# Runbook: the Reorder Agent on the agents host

This runbook tells the operator what to do, in order, to run the Reorder Agent on the agents host. [README.md](README.md) gives the facts of the host: the folders, the ports and the DNS records. [RUNBOOK.md](RUNBOOK.md) gives the steps that every agent of the host shares. This runbook gives the steps of the Reorder Agent.

Three rules hold for every step:

- A runtime keeps its jobs in memory, and the service keeps the slot of its job in memory. Never restart a container of the Reorder Agent while a job runs (section "The restart rule").
- No command in this runbook prints a key or the token. Never add one that does.
- The host builds no image. CI builds the images, and the compose file names each one by its digest.

## What it is

The Reorder Agent is the agent of a buying organisation in use case 1 (inventory reorder). It reads the stock of one SKU, and it proposes a purchase order for one lot from a named supplier. When the organisation has approved the order, the agent places it from the vault of the organisation and records it. Its capability is `supplychain.reorder.po.v1`.

It runs as two containers in one compose project, `reorder-agent`: a runtime in front of a service. The runtime holds the supplier key, serves the advert, claims the escrow of the hirer and calls the service. The service holds the five keys of the agent and does the work. It does one job at a time. It also serves the co-sign route, `POST /cosign/delegate`, outside the job slot.

| Runtime | Container | Port on 127.0.0.1 | Host name | Advert model | Price (units) | Bonds (units) | Lock (units) |
|---|---|---|---|---|---|---|---|
| Reorder | `reorder-runtime` | 8101 | `mp-suppliers-reorder.vector.apexfusion.org` | `reorder-agent-v1` | 3 | 1 and 1 | 5 |

The service is the container `reorder-service`, on `127.0.0.1:9101`. The lock of an advert is its price plus both bonds.

| Time | Value | Where |
|---|---|---|
| Window of the advert | 1,800,000 ms | `ADVERT_MAX_PROCESSING_MS` |
| Timeout of the runtime for the service | 1,680,000 ms | `SERVICE_TIMEOUT_MS` in the compose file |
| Deadline of a job in the service | 1,620,000 ms | the code of the service |

The deadline of a job is inside the timeout of the runtime, and the timeout is inside the window with 120 seconds to spare. The runtime refuses to boot with less than 60 seconds to spare.

The operator makes three things outside this pack: the keys, the agent records (the record of the agent and the record of its subagent stock-reader), and the advert (with the hosted tools of the Vector marketplace). This runbook says when each one is needed and where its result goes. The service does not start without its keys, `AGENT_DID` and `STOCK_READER_DID`. The runtime does not start without its advert.

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
| `docker-compose.reorder-agent.yml` | The compose project: a runtime and a service, the images by digest, the ports on `127.0.0.1`, and the keys that each container must not hold. |
| `.env.reorder-agent.example` | The settings of both containers: the supplier lines, the five keys of the service, the token and the published values. Names, placeholders and published values only. |
| `Caddyfile.reorder-agent.snippet` | The host block, between two markers. |
| `RUNBOOK-reorder-agent.md` | This runbook. |
| `.env.reorder-agent` | Made on the host from the example. The service and the runtime both read it. |

The four files of the pack are in `deploy/server`. The env file holds six keys and a token. It never enters git, and it has mode 600.

## The memory gate

Before each container start, `MemAvailable` must be at least 1,024 MiB. The gate holds for each of the two containers, and for each container that you create again. Check it with this command:

```sh
awk '/^MemAvailable:/ { mib = int($2 / 1024); word = (mib >= 1024) ? "ok" : "stop"; print word, mib, "MiB available" }' /proc/meminfo
```

Start no container while it prints `stop`. A runtime of the other agents of the host uses about 190 MiB. Read the real size of each container of the Reorder Agent after its first start (section "The checks"), and write it down.

## The DNS record

Make one A record in the DNS zone of the agents. The record is DNS only, and it points at the public IPv4 address of the host:

- `mp-suppliers-reorder.vector.apexfusion.org`

Check the name against a public resolver:

```sh
dig +short mp-suppliers-reorder.vector.apexfusion.org A @1.1.1.1
```

The answer must be the address of the host and nothing else. The address of a proxy means that the record is proxied: change it to DNS only. A proxy ends TLS before Caddy, and it replaces the body of an error answer. A job that the service ends answers 200 with its `reason`. When the runtime cannot finish a job, it answers 502 with a JSON body, and the buyer needs that body. Caddy gets the certificate of a name when it loads the block of the name, so the record must resolve first.

## The folder

The folder of the Reorder Agent is `/srv/agents/reorder-agent`. It belongs to the service user, `agents`, with mode 750. The first command makes it. Run the third command in the folder that holds the files of `deploy/server` (the folder `agents-server` of RUNBOOK.md, step 2):

```sh
sudo install -d -m 750 -o agents -g agents /srv/agents/reorder-agent
sudo stat -c '%a %U:%G %n' /srv/agents/reorder-agent
sudo install -m 644 -o agents -g agents docker-compose.reorder-agent.yml .env.reorder-agent.example /srv/agents/reorder-agent/
```

The output of `stat` must be `750 agents:agents /srv/agents/reorder-agent`.

## The env file

Make the env file as the service user, with mode 600. The service and the runtime both read it:

```sh
sudo -u agents -H bash
cd /srv/agents/reorder-agent
umask 077
cp .env.reorder-agent.example .env.reorder-agent
```

The keys come from the operator pack, and the key rules of RUNBOOK.md (section "Keys") hold for them. A key is never typed in a shell, and no command here prints one. There are six keys, and all six are different:

- The supplier key goes in the four `SUPPLIER_` lines. It is the key of the runtime. The service reads only the two public lines, `SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`: the compose file blanks `SUPPLIER_PRIV_KEY_HEX` for the service.
- The five keys of the service go in five lines. `REORDER_SERVICE_PRIV_KEY_HEX` pays the model hires and signs the claims and the challenges. `REORDER_DELEGATION_1_PRIV_KEY_HEX` and `REORDER_DELEGATION_2_PRIV_KEY_HEX` are the keys that a delegation of a hirer names. `STOCK_READER_AUTH_PRIV_KEY_HEX` and `STOCK_READER_DELEGATION_PRIV_KEY_HEX` are the two keys of the subagent stock-reader. The compose file blanks all five for the runtime.
- Each key has a line for its key hash after it, `REORDER_SERVICE_PKH` and so on. The line is public and optional. When it has a value, the service checks it against the key at start.

The service pays from three of its keys: the service key and the two delegation keys. The two keys of stock-reader pay nothing. So the four paying keys have four wallets: the supplier key of the runtime and those three. Each wallet needs two transfers. The first is one pure output of 5 units, alone, as collateral. The second is a float for the fees of its jobs. A wallet that gets both in one transfer can have its collateral merged into change by an ordinary transaction. The wallet of the service key also holds the stake of a challenge, `DISPUTE_CHALLENGE_STAKE_LOVELACE`, while a challenge is open.

Make the token, and write it into the file. The command prints nothing:

```sh
sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')\"|" .env.reorder-agent
```

Fill the other lines with an editor:

- `OPERATOR_CONTACT` (a role address, never a person), `AGENT_DID`, `STOCK_READER_DID`, `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`.
- `VECTOR_MODULE1_MANIFEST`: replace `<commit>` with the 40 hex digits of the commit that the hosted MCP server uses for its own `VECTOR_MODULE1_MANIFEST`.
- `AGENT_ID`: the 64 hex characters of the agent record, the part of `AGENT_DID` after `did:vector:`. `ADVERT_REF` stays empty until the advert exists (section "The start order", step 5).
- `COSIGN_ALLOWLIST`: the key hashes of the principals whose delegation the co-sign route may co-sign, separated by commas. The empty line holds nobody, and the route then signs for nobody. A change to this line needs the service created again (section "The restart rule").
- Leave every other line as it is. The comments in the example say what each line does.

Then check the file. No command here prints a secret. The first prints the mode and the owner:

```sh
stat -c '%a %U:%G %n' .env.reorder-agent
```

It must print `600 agents:agents .env.reorder-agent`. The next command lists the lines of the file that still hold a placeholder. It prints the line number and the name, never the value. It must print nothing:

```sh
grep -nE '^[A-Z0-9_]+=.*<[^>]*>' .env.reorder-agent | cut -d= -f1
```

This command prints the name of each required line that is empty. It must print nothing:

```sh
for name in SUPPLIER_PRIV_KEY_HEX SUPPLIER_PUB_KEY_HEX SUPPLIER_PKH SUPPLIER_ADDRESS REORDER_SERVICE_PRIV_KEY_HEX REORDER_DELEGATION_1_PRIV_KEY_HEX REORDER_DELEGATION_2_PRIV_KEY_HEX STOCK_READER_AUTH_PRIV_KEY_HEX STOCK_READER_DELEGATION_PRIV_KEY_HEX SERVICE_AUTH_HEADER OPERATOR_CONTACT AGENT_DID STOCK_READER_DID AGENT_ID MOCK_PUBLIC_BASE MOCK_MTLS_BASE; do
  [ -n "$(sed -n "s/^$name=//p" .env.reorder-agent | tr -d '"')" ] || echo "empty: $name"
done
```

These commands print the length of the value of each key line and of some other lines, never the value:

```sh
awk -F= '/^(SUPPLIER_PRIV_KEY_HEX|SUPPLIER_PUB_KEY_HEX|SUPPLIER_PKH|SUPPLIER_ADDRESS|ADVERT_REF|AGENT_ID)=/ { printf "%s=%d ", $1, length($2) }' .env.reorder-agent; printf '\n'
awk -F= '/^(REORDER_SERVICE|REORDER_DELEGATION_1|REORDER_DELEGATION_2|STOCK_READER_AUTH|STOCK_READER_DELEGATION)_(PRIV_KEY_HEX|PKH)=/ { printf "%s=%d\n", $1, length($2) }' .env.reorder-agent
```

The first line must say `SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 AGENT_ID=64 ADVERT_REF=0`. After step 5 of "The start order", `ADVERT_REF` has 66 characters. Each key line of the service must say 64. Each key hash line says 56, or 0 when you leave it empty.

No two keys may be one key. The service stops at start when two keys are equal, or when a key of the service is the supplier key. This command prints a key hash that stands twice among the key hash lines. It must print nothing:

```sh
sed -n 's/^\(SUPPLIER\|REORDER_SERVICE\|REORDER_DELEGATION_1\|REORDER_DELEGATION_2\|STOCK_READER_AUTH\|STOCK_READER_DELEGATION\)_PKH=\(..*\)$/\2/p' .env.reorder-agent | sort | uniq -d
```

## The images

The compose file names two images. CI builds both, and it pushes each one under `:latest` and under `:<full git commit sha>`. Use the tag of the commit that was reviewed. The service image is `ghcr.io/apex-fusion/vector-service-agents/reorder-agent`. The runtime image is `ghcr.io/apex-fusion/vector-service-agents/agent-runtime`.

The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`. RUNBOOK.md (step 5, "Run the mock service") does the same for the mock service.

Pull both images. Put each digest in `docker-compose.reorder-agent.yml`. The `sed` command changes the file only when the digest has 64 characters:

```sh
cd /srv/agents/reorder-agent
REPO=ghcr.io/apex-fusion/vector-service-agents
COMMIT=<full git commit sha>
for image in reorder-agent agent-runtime; do
  docker pull "$REPO/$image:$COMMIT"
  DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REPO/$image:$COMMIT" | sed 's/^.*@sha256://')
  if [ "${#DIGEST}" = 64 ]; then sed -i -E "s#($image@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" docker-compose.reorder-agent.yml; else echo "no digest for $image: the compose file is not changed"; fi
done
grep -E '^    image: ' docker-compose.reorder-agent.yml
```

The last command must print two `image:` lines with 64 hex digits. If a line still holds `<digest>`, compose refuses to start (`invalid reference format`).

## Check the compose file

First look at the file as compose renders it. Do it in a scratch folder with a stand-in env file, never in the folder of the real env file: the real file holds keys, and `docker compose config` prints the values of the env file into its output.

```sh
scratch=$(mktemp -d)
cp docker-compose.reorder-agent.yml "$scratch/"
cp .env.reorder-agent.example "$scratch/.env.reorder-agent"
(cd "$scratch" && docker compose -f docker-compose.reorder-agent.yml config | grep -E '^name:|image:|container_name:|host_ip:|published:|target:')
rm -r "$scratch"
```

The output must show the project `reorder-agent`, two containers, and each port with `host_ip: 127.0.0.1`. The published ports are 8101 and 9101. The `target: /data` is the volume `reorder-state` of the service. No network or build is in the file.

Then check the file with the real env file. This command prints nothing when the file is right. It stops with a message when the env file is missing:

```sh
docker compose -f docker-compose.reorder-agent.yml config --quiet
```

The command does not look at the digests. This one does. It must print `0`:

```sh
grep -c '@sha256:<digest>' docker-compose.reorder-agent.yml
```

## The start order

Run each `docker compose` command as the service user, in `/srv/agents/reorder-agent`.

1. Pass the memory gate (section "The memory gate"). Start the service. This command also makes the network `reorder-agent_default` and the volume `reorder-state`:

   ```sh
   docker compose -f docker-compose.reorder-agent.yml up -d service
   ```

2. Wait 30 seconds. Check the service:

   ```sh
   curl -fsS http://127.0.0.1:9101/healthz
   docker logs --tail 20 reorder-service
   ```

   The first command prints `{"ok":true}`. The log has the line `[reorder-agent] listening on 0.0.0.0:9101; manifest <hash>; wallets (service, delegation 1, delegation 2) <three addresses>; state directory /data`. The service asks the node for the start time of the chain, reads its three wallets and fetches the Module-1 manifest at start, so the start takes some seconds. If the container starts again and again, the log says why: read the failure table.

3. Join the Caddy container to the network, and add the block of the host name (section "The Caddy block"). The DNS record must resolve to the host first.
4. Check the public name, and take the hash of the manifest (section "The checks"). It is the `manifest` value of the line of step 2, and it is the `detail_hash` of the advert.
5. Post the advert. This pack does not post it: the operator posts it with the hosted tools of the Vector marketplace. Post it for the supplier key of the runtime, with the `AGENT_ID` of the agent record. The terms of the advert are:
   - the capability `supplychain.reorder.po.v1`;
   - the model `reorder-agent-v1`;
   - the price 3 units, with a supplier bond of 1 unit and a buyer bond of 1 unit;
   - the window 1,800,000 ms;
   - `endpoint_url`: the origin of the host name, `https://mp-suppliers-reorder.vector.apexfusion.org`;
   - `detail_uri`: that origin and `/agent.json`;
   - `detail_hash`: the hash of step 4.

   Write the reference of the advert, `<transaction hash>#<output index>`, into `ADVERT_REF` of `.env.reorder-agent`. A change to the manifest after this step means a retired advert and a new one. After you post the new advert, write its reference into `ADVERT_REF`, and create the runtime again with `up -d --no-deps --force-recreate runtime`, as section "The restart rule" says. A runtime that holds the reference of a retired advert refuses every job with 503 `advert_not_active`.
6. Start the runtime. Pass the memory gate first. After the start, wait 30 seconds, and check that the runtime is up and says `free`:

   ```sh
   docker compose -f docker-compose.reorder-agent.yml up -d --no-deps runtime
   curl -fsS http://127.0.0.1:8101/healthz
   curl -s http://127.0.0.1:8101/status
   ```

   The option `--no-deps` keeps compose from touching the service: a start of the runtime never creates the service again.
7. Run the other checks of section "The checks".

## The checks

Each command only reads. None prints a secret.

1. The two containers answer on the loopback address. Each command prints `{"ok":true}`:

   ```sh
   for port in 8101 9101; do printf '%s: ' "$port"; curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"; printf '\n'; done
   ```

2. The runtime says `free`. The word `working` means that a job runs:

   ```sh
   curl -s --max-time 5 http://127.0.0.1:8101/status || printf 'no answer'
   ```

3. No container of the Reorder Agent has a public port. The command must print `ok: no public port of the Reorder Agent`:

   ```sh
   docker ps --filter name='^reorder-' --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public port of the Reorder Agent'
   ```

   If a port is public, stop the container. Write `127.0.0.1:` before the port in the compose file, and start the container again.

4. The runtime holds no key of the service, and the service holds no supplier key. Each command prints `blank`:

   ```sh
   docker exec reorder-runtime sh -c 'test -z "$REORDER_SERVICE_PRIV_KEY_HEX$REORDER_DELEGATION_1_PRIV_KEY_HEX$REORDER_DELEGATION_2_PRIV_KEY_HEX$STOCK_READER_AUTH_PRIV_KEY_HEX$STOCK_READER_DELEGATION_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   docker exec reorder-service sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   ```

5. The advert has the hash of the manifest. Run this command from a checkout of this repository, on any machine. It needs no key. It prints one line of JSON with the `detail_uri`, the `detail_hash` and the number of bytes:

   ```sh
   node scripts/manifest-hash.mjs https://mp-suppliers-reorder.vector.apexfusion.org
   ```

   The `detail_hash` must be the `manifest` value in the line `listening on` of the service. After the advert exists, the `detail_hash` of the advert must be this value. If it is not, retire the advert and post a new one with this hash. Then write the new reference into `ADVERT_REF` of `.env.reorder-agent`, and create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). A runtime that keeps the reference of the retired advert refuses every job with 503 `advert_not_active`.

6. The runtime serves its card. The first command prints one JSON document with the interface `https://mp-suppliers-reorder.vector.apexfusion.org/v1/job`. The second prints `200`:

   ```sh
   curl -fsS https://mp-suppliers-reorder.vector.apexfusion.org/.well-known/agent-card.json
   curl -fsS -o /dev/null -w '%{http_code}\n' https://mp-suppliers-reorder.vector.apexfusion.org/
   ```

7. The co-sign route reaches the service. The call holds no transaction, so it signs nothing. The answer is `400` with the code `bad_shape`. Another answer means that Caddy does not send the path to the service (section "The Caddy block"):

   ```sh
   curl -sS -w '\n%{http_code}\n' -X POST -H 'Content-Type: application/json' --data '{}' https://mp-suppliers-reorder.vector.apexfusion.org/cosign/delegate
   ```

8. Read the size of each container, and the memory that is left. Write the figures down:

   ```sh
   docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' reorder-runtime reorder-service
   awk '/^MemAvailable:/ { print int($2 / 1024), "MiB available" }' /proc/meminfo
   ```

## The Caddy block

Caddy runs in a container on the host. `<caddy container>` is the name of that container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`. The block is in `Caddyfile.reorder-agent.snippet`, between the two lines `# reorder-agent vhosts (BEGIN)` and `# reorder-agent vhosts (END)`. It holds one host block. It sends `/agent.json` and `/cosign/delegate` to `reorder-service:9101`, and every other path to `reorder-runtime:8080`. The name must be a DNS only record that resolves to the host (section "The DNS record").

1. Join the Caddy container to the network of the project. Compose makes the network when it starts the service. Do it once, and again after each new Caddy container. The second command must list `<caddy container>` and `reorder-service`, and also `reorder-runtime` after step 6 of "The start order":

   ```sh
   docker network connect reorder-agent_default <caddy container>
   docker network inspect reorder-agent_default --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

2. Keep a copy of the file, and check that it has no block of the Reorder Agent yet. The second command must print `0`:

   ```sh
   cp -p <caddyfile> <caddyfile>.before-reorder-agent
   grep -c '^# reorder-agent vhosts (BEGIN)$' <caddyfile>
   ```

3. Add the block to the end of the file, in place. Append to the file: do not replace it. The container mounts one file, and a mount follows the inode of that file. A new file that takes its place has another inode, and the container does not see it. Run this in the folder that holds `Caddyfile.reorder-agent.snippet`:

   ```sh
   sed -n '/^# reorder-agent vhosts (BEGIN)$/,/^# reorder-agent vhosts (END)$/p' Caddyfile.reorder-agent.snippet >> <caddyfile>
   ```

4. Validate the whole file in the Caddy container. The answer must say `Valid configuration`. Then reload Caddy:

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   If the validation fails, write the old file back, in place, and read the error:

   ```sh
   cat <caddyfile>.before-reorder-agent > <caddyfile>
   ```

   Do not leave a file that fails to validate on the host. A new Caddy container reads that file, and it does not start with it. Never restart Caddy: a restart cuts the connections that are open. A reload keeps them.
5. Watch the certificate. The log must say `certificate obtained successfully` for the name:

   ```sh
   docker logs --since 5m <caddy container> 2>&1 | grep -E 'certificate obtained|error'
   ```

To replace the block after a change, remove it, and then add it again. To remove it, write the file without the lines from `# reorder-agent vhosts (BEGIN)` to `# reorder-agent vhosts (END)`, in place. Then validate and reload as in step 4:

```sh
sed '/^# reorder-agent vhosts (BEGIN)$/,/^# reorder-agent vhosts (END)$/d' <caddyfile> > caddyfile.new
cat caddyfile.new > <caddyfile>
```

## The restart rule

A runtime keeps its jobs in memory. The service keeps the slot of its job, and the slot that a go of the check before the Claim reserves for 120 seconds, in memory too. A restart of a container of the Reorder Agent cuts the job that runs, and a job under escrow can then fail for the buyer. The records on the volume stay: the janitors of the next start reclaim the escrows that a cut job left, and end its sub-delegations. A restart during a run is forbidden.

These actions are restarts of a container: `docker restart`, `docker compose restart`, `docker compose up -d --force-recreate`, `docker compose up -d` after a change of an image or of the env file, a reboot of the host and a power-off. These are not restarts: a reload of Caddy, a change of the Caddy block, and the first start of a container.

The service does not say anything about its slot, and a job can start at any time. So every restart has three steps, in this order, and the third follows the second with no pause:

1. Wait 2 minutes after the last job. A go of the check before the Claim keeps the slot for 120 seconds. After the wait, no slot is held for a job that has not started.
2. Check that the runtime says `free`. The word `working` means that a job runs: do not restart, wait for the job to end, and begin again at step 1.
3. Run the `up` command at once. Never check first and then wait: a job that starts in a wait after the check is cut.

This command does the three steps without a gap. It waits 2 minutes, checks `/status`, and creates the container only when the runtime says `free`. A container reads its env file when it is created, so use the command after each change of the env file. Use the name of the compose service: `service` or `runtime`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8101/status | grep -q '"status":"free"'; then docker compose -f docker-compose.reorder-agent.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

When the command prints the last words, nothing was restarted. Run it again after the job ends.

The allowlist of the co-sign route is an env line: `COSIGN_ALLOWLIST` in `.env.reorder-agent`. The service reads it at start, so a new principal needs the service created again, with the command above. The register of the keys that a co-signed delegation uses is on the volume, so a restart does not free a key that was used. A call to the route that arrives while the service stops gets no answer: the caller asks again.

A change to `SERVICE_AUTH_HEADER` needs the service and the runtime created again, so that the two hold one value. Write `service runtime` in place of `service` in the command: one command creates both. A new image is a restart too: pin it as in section "The images", and create only the containers that use it, with the same command.

A stop of the service waits up to 300 seconds for the job that runs. Compose waits 330 seconds before it kills the container: the 30 seconds more are for the service to log a job that it abandoned, and to exit. A runtime has the default grace period of 10 seconds, so never stop a runtime that says `working`.

Never restart Caddy. Reload it (section "The Caddy block").

## The failure table

A failed start of the service or of the runtime shows in `docker ps` as `Restarting`. Read `docker logs --tail 20 reorder-service` or `docker logs --tail 20 reorder-runtime`. The service prints `[reorder-agent] cannot start:` and a message. The message names the variable and never shows its value. A job that fails is no failed start: the service answers it, and the log line of the job has `outcome failed` and the `reason` (the last rows of the table).

| Symptom | Cause | Action |
|---|---|---|
| `invalid reference format` for an image | A placeholder `<digest>` is still in the compose file. | Pin the images (section "The images"). |
| `denied` on `docker pull` | The package is private. | Make the package public, or log in to `ghcr.io` with a token that has the scope `read:packages`. |
| Compose says that the env file is not found | The env file is missing, or compose runs in another folder. | Make the file from its example (section "The env file"). Run compose in `/srv/agents/reorder-agent`. |
| A start fails with a port that is allocated or in use (8101 or 9101) | Another program holds the port. | Find it with `ss -ltnp`. Do not change a port: the Caddy block, the runbook and the guard test name these ports. |
| `[reorder-agent] cannot start: environment variable REORDER_SERVICE_PRIV_KEY_HEX is required`, or `must be 64 lowercase hex characters` | A key line of the service is empty or wrong. The message names the line. | Write the key with a command that prints nothing (section "The env file"). The five lines are `REORDER_SERVICE_PRIV_KEY_HEX`, `REORDER_DELEGATION_1_PRIV_KEY_HEX`, `REORDER_DELEGATION_2_PRIV_KEY_HEX`, `STOCK_READER_AUTH_PRIV_KEY_HEX` and `STOCK_READER_DELEGATION_PRIV_KEY_HEX`. |
| `... holds the same key as ...: each key of the service must be a key of its own` | Two key lines of the service hold one key. | Make a key for each line. |
| `... holds the key of SUPPLIER_PKH: the supplier key is the runtime's` | A key of the service is the supplier key. | Make a key of its own for the service. The supplier key belongs to the runtime. |
| `... holds the service key, which belongs in REORDER_SERVICE_PRIV_KEY_HEX alone`, or `... holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | A key or the token stands in another line too. The words before "which" name the key. The message names that line and does not show the value. | Take it out of the line that the message names. |
| `... REORDER_SERVICE_PKH (56 characters) is not the key hash of the key in REORDER_SERVICE_PRIV_KEY_HEX` | A key hash line does not belong to the key before it. The same message holds for each of the other four. | Correct the line, or leave it empty. |
| `... SERVICE_AUTH_HEADER is required`, or `must be printable ASCII` | The token line is empty, or it holds a character that a header cannot carry. | Make the token again (section "The env file"). Create the service and the runtime again with the command of section "The restart rule". |
| `... SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH` | The two lines come from two keys, or a private key is in the line of the public key. | Copy both values from the key of the runtime. |
| `... AGENT_DID is required`, or `... must be did:vector: and 64 lowercase hex characters` (the same for `STOCK_READER_DID`) | A DID line is empty or has the wrong form. | Write `did:vector:` and the 64 hex characters of the agent record. |
| `... MOCK_PUBLIC_BASE must be an https origin`, or `... MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE` | A placeholder is still in the line, or the two origins name one host. | Write the origin of the mock host and the origin of the mock mtls host. |
| `... VECTOR_MODULE1_MANIFEST must be an https address` | The line holds a file path, an http address, or an address with a user, a password, a query or a fragment. | Write the https address as the example has it. |
| `... VECTOR_MODULE1_MANIFEST must be pinned to a commit` | The placeholder `<commit>` is still in the line, or the address names a branch or a tag. | Write the 40 hex digits of the commit that the hosted MCP server uses. |
| `The Module-1 manifest (VECTOR_MODULE1_MANIFEST)` cannot be fetched | The host cannot reach the address, or the commit has no manifest at that path. | Check that the host reaches the address with `curl -sSI`. Write the commit that the hosted MCP server uses. |
| `... IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give` | One of the three published values is wrong. | Copy the three values from the example. |
| `the node gave no start time of the chain` | The host does not reach the node (`VECTOR_OGMIOS_URL`), or the node gives no answer in 15 seconds. | Check that the host reaches the node. Start the service again when it answers. |
| `... REORDER_STATE_DIR names /data, which cannot be written` | The volume is not writable for the user `node`. | Run `docker volume inspect reorder-state`. A new volume that is empty can be removed. A volume that holds records is not removed: make its data belong to `node`. |
| `... FAULT_MODE must be empty` | The switch holds a value. The Reorder Agent has no fault value. | Empty the line. |
| `... ADVERT_MAX_PROCESSING_MS must be at least 1800000` | The window line is under the deadline of a job. | Write 1800000, as the example has it. |
| `... LLM_MODEL_ALLOWLIST is required`, or `... must be a whole number of lovelace of more than 0` (the same for each line of `LLM_MAX_`, `HANDOFF_MAX_` and `DISPUTE_`) | A limit line is empty or wrong. The service never fills in a limit. | Write the value of the example. |
| `the settings of the co-sign route are refused: COSIGN_ALLOWLIST is not set` | The line of the allowlist is missing, or an entry on it is no key hash of 56 lowercase hex characters. | Keep the line: empty, or with key hashes separated by commas. |
| A runtime starts again and again, and its log says `loadConfig: missing required env var ADVERT_REF` | The runtime started before its advert existed. | Stop it with `docker compose -f docker-compose.reorder-agent.yml stop runtime`. Finish step 5 of "The start order". |
| A runtime log says `loadConfig: PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the origin of the host name, as the compose file has it. |
| Caddy answers 502 for the host name | The Caddy container is not on the network, or a container of the Reorder Agent is down. | Check with `docker network inspect reorder-agent_default ...` (section "The Caddy block") and `docker ps`. Join the network again. |
| Caddy gets no certificate for the name | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (section "The DNS record"). Read the log of the Caddy container. |
| The hash of `/agent.json` is not the `detail_hash` of the advert | A setting of the manifest changed after the advert was posted: an env line of the service, the image or the status word. | Retire the advert. Post a new advert with the hash that is served now. Write its reference into `ADVERT_REF` of `.env.reorder-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `advert_not_active` (503) | The runtime holds the reference of an advert that is retired or not active, so it refuses every job. | Post a new advert when none is active. Write the reference of the active advert into `ADVERT_REF` of `.env.reorder-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `precheck_failed` (503) | The service answered the runtime with 401 `unauthorized`: the two containers were created from two versions of `SERVICE_AUTH_HEADER`. The log of the runtime says that the service refused the token. | Create the service and the runtime again with the command of section "The restart rule", with `service runtime` as the names. |
| `busy` (409) | The service works on a job, or it keeps its slot for another escrow for up to 120 seconds, or the co-sign route works on as many calls as `COSIGN_MAX_CONCURRENT` allows. | Wait. Nothing to fix. The caller sends the call again. |
| `supplier_busy` (409) | The runtime works on a job itself. | Wait. Nothing to fix. |
| `precheck_timeout` or `precheck_unreachable` (503) | The service gave no answer in 10 seconds, or the runtime could not connect to `reorder-service:9101`. | Check `docker ps`, `docker logs --tail 20 reorder-service` and `/healthz` on port 9101. |
| `precheck_bad_status` (502) | The service answered with a redirect, or with a status that the runtime does not read. | Read the log of the service. |
| `shutting_down` (503) | The service is stopping: it takes no new job. | Wait for the start. Check `docker ps` and the log of the service. |
| `bad_context` (400) | The call has none, some, or a bad one of the six context headers. A runtime that runs the image of CI sends all six. | Check that the runtime runs the runtime image of the compose file, and not an older build. |
| `bad_wire`, `request_too_large` or `bad_shape` (400) | The request is not the wire message, it is over 1,000,000 bytes, or it is no request of use case 1 for this agent. | Nothing on the host. The buyer fixes its request. |
| `delegation_not_mine` (400) | The delegation of the hirer names another agent as its delegate. | Nothing on the host, unless every job gets it: check `AGENT_DID`. |
| `internal` (500) | A fault in the service, or a setting of the agent that the job refuses. The buyer gets fixed words. | Read the log line of the job. Report it. |
| `principal_not_allowed` or `spends_agent_funds` (403) from `/cosign/delegate` | The principal is not on `COSIGN_ALLOWLIST`, the delegator did not sign first, or the transaction spends funds of the agent. | Nothing on the host for a transaction that spends funds. Add the key hash of the principal to the allowlist only when the principal may use the agent (section "The restart rule"). |
| `not_a_delegation`, `not_for_this_agent` or `expired` (400) from `/cosign/delegate` | The transaction is no Delegate of this agent, or its validity window ended or is too far ahead. | Nothing on the host. The caller builds the transaction again. |
| `key_in_use` (409) from `/cosign/delegate` | A delegation key that the transaction names is in use by another co-signed delegation. The register on the volume keeps that after a restart. | Nothing on the host. The caller asks for the other delegation key. |
| `check_unavailable` (503) from `/cosign/delegate` | The route could not read the ledger or the register in `COSIGN_LEDGER_TIMEOUT_MS`. | Check that the host reaches the node and that `cosign-register.json` is on the volume. The caller asks again. |
| The log line of a job says `outcome refused_by_counterparty` and a `reason` such as `approval_not_found`, `approval_expired`, `duplicate_po` or `cannot_supply` | The Order Desk refused the order. The reason is the code of the Order Desk. `cannot_supply` comes after the Claim: the escrow stays Claimed. | Nothing on the host: the Order Desk decides. The buyer fixes its side. |
| `supplier_not_listed` or `supplier_unavailable` as the `reason` of a failed job | The marketplace lists no complete set of adverts for the Order Desk that the request names, or a source (the indexer, the chain or the lots file) could not be read. The other supplier reasons, `supplier_manifest_invalid`, `supplier_lots_invalid` and `sku_not_in_lots`, mean that the Order Desk serves a manifest or a lots file that the agent refuses, or that the SKU is not in the lots file. | Check that the host reaches the indexer, the node and the host of the Order Desk. Check that the Order Desk has its adverts. |
| `ledger_unavailable` as the `reason` of a failed job | A read of the ledger gave no answer in time. | Check that the host reaches the node and the indexer (`VECTOR_OGMIOS_URL` and `VECTOR_KOIOS_URL`). The buyer sends the job again. |
| `mock_system_failed` as the `reason` of a failed job | The mock service did not take the call: the stock read or the write of the order. | Check `MOCK_PUBLIC_BASE`, the tenant, and the mock service. |
| `token_failed`, or a `reason` that starts with `token_`, as the `reason` of a failed job | The identity gateway gave no token for the agent or for stock-reader. | Check the keys and the purposes in the record of the agent and in the record of stock-reader, and check that the host reaches the identity gateway. |
| A `reason` that starts with `sub_delegation_` | The sub-delegation of stock-reader failed. | Read the log line. Check the wallet of the first and of the second delegation key: each needs its collateral and a float. |
| `inference_failed` or `model_output_invalid` as the `reason` of a failed job | The hire of the model failed, or the model gave no valid answer. | Read the log line. Check the wallet of the service key: it needs its collateral and a float. |
| `store_write_failed` as the `reason` of a failed job | The service could not write a record on the volume. | Check the volume `reorder-state` and the disk. |
| `deadline` or `aborted` as the `reason` of a failed job | The job ran out of its 1,620,000 ms, or the runtime hung up before the job ended. | Read the log line of the job. Nothing to fix when it happens once. |
| `delegation_key_unknown` as the `reason` of a failed job | The delegation of the hirer names a key that the service does not hold. | Nothing on the host, unless every job gets it: check the two delegation key lines. |

## Back out

To take the Reorder Agent out of service. The order matters: the advert goes first, so that nobody can post an escrow against an agent that goes away.

1. Retire the advert. The operator does it with the hosted tools, signed with the supplier key of the runtime. Skip this step when `ADVERT_REF` is empty in the env file: nothing was posted.
2. Wait 2 minutes after the last job. Then check that the runtime says `free`, and stop the containers at once. Never check first and then wait. The command does the three steps without a gap. A job that was claimed before the retire still runs: when the runtime says `working`, nothing is stopped. Let the job end, and run the command again. Compose waits up to 330 seconds for the service:

   ```sh
   sleep 120; if curl -s --max-time 5 http://127.0.0.1:8101/status | grep -q '"status":"free"'; then docker compose -f docker-compose.reorder-agent.yml stop; else echo 'the runtime does not say free: nothing was stopped'; fi
   ```

3. Remove the Caddy block, as section "The Caddy block" says. Validate and reload Caddy.
4. Leave the network of the project before the `down` command, because the Caddy container is on it. Do not use `-v`:

   ```sh
   docker network disconnect reorder-agent_default <caddy container>
   docker compose -f docker-compose.reorder-agent.yml down
   ```

5. Keep the volume `reorder-state`: it holds the escrows of each paying key, the journal of the dispute code, the sub-delegations that a job left, the register of the co-signed transactions and the counter of the purchase order numbers. Keep the env file too. Delete a key file only when its wallet is empty: a key that is deleted cannot be made again.
6. Remove the DNS record when nobody uses the name again.
