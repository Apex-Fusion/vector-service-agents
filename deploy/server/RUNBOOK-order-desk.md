# Runbook: the Order Desk on the agents host

This runbook tells the operator what to do, in order, to run the Order Desk on the agents host. [README.md](README.md) gives the facts of the host: the folders, the ports and the DNS records. [RUNBOOK.md](RUNBOOK.md) gives the steps that every agent of the host shares. This runbook gives the steps of the Order Desk.

Three rules hold for every step:

- A runtime keeps its jobs in memory, and the service keeps the record of the checks of a job in memory. Never restart a container of the Order Desk while a job runs (section "The restart rule").
- No command in this runbook prints a key or the token. Never add one that does.
- The host builds no image. CI publishes the images. The compose file names each one by its digest.

## What it is

The Order Desk is the agent of a supplier in use case 1 (inventory reorder). It takes a purchase order from the agent of a buyer. It checks who sent the order, and that the buyer approved exactly this order. If the lot can be supplied, it places the order in the system of the supplier, and it confirms the order.

It runs as four containers in one compose project, `order-desk`: three runtimes in front of one service. Each runtime serves one advert, for one lot. A runtime has a supplier key, a wallet, an advert, a port and a host name of its own. The service has the logic. The three runtimes share it: its address, its token and its check before the Claim. It does one job at a time.

| Runtime | Container | Port on 127.0.0.1 | Host name | Advert model | Price (units) | Bonds (units) | Lock (units) |
|---|---|---|---|---|---|---|---|
| Small | `orders-small-runtime` | 8102 | `mp-suppliers-orders-small.vector.apexfusion.org` | `lot-small` | 2 | 1 and 1 | 4 |
| Medium | `orders-medium-runtime` | 8103 | `mp-suppliers-orders-medium.vector.apexfusion.org` | `lot-medium` | 5 | 1 and 1 | 7 |
| Large | `orders-large-runtime` | 8104 | `mp-suppliers-orders-large.vector.apexfusion.org` | `lot-large` | 10 | 1 and 1 | 12 |

The service is the container `orders-service`, on `127.0.0.1:9102`. The lock of an advert is its price plus both bonds. The three adverts have the capability `supplychain.order.accept.v1`.

| Time | Value | Where |
|---|---|---|
| Window of an advert | 480,000 ms | `ADVERT_MAX_PROCESSING_MS` |
| Timeout of a runtime for the service | 360,000 ms | `SERVICE_TIMEOUT_MS` in the compose file |
| Deadline of a job in the service | 300,000 ms | the code of the service |

The deadline of a job is inside the timeout of the runtime, and the timeout is inside the window with 120 seconds to spare. The runtime refuses to boot with less than 60 seconds to spare.

The operator pack (`scripts/operator`) makes the keys, the agent record, the stakes, the env files and the three adverts. It is not part of this deploy pack. Each task of the pack makes one result:

| Task | Result | When |
|---|---|---|
| `keys` | The keys of the use case, in the key folder. | First. |
| `fund` | The collateral output and the float of each wallet. | After `keys`. |
| `register` | The record of the agent. | After `fund`, and before the first start. The operator publishes the TXT value of the organisation first. |
| `stake` | The Module-3 stake of the agent. | After `register`, and before the first start. |
| `env` | The env files of both agents of use case 1: the four files of this pack (the shared file and one file for each runtime), and the env file of the Reorder Agent. One run plans both agents. It needs both agent folders and the records of both agents (and of stock-reader), and it writes nothing when one is missing. | Before the first start (step 2 of the order of the work), and again after `advert`, to write `ADVERT_REF` of each runtime. |
| `advert` | The three adverts. | After the service runs and serves its manifest, and before the runtimes start. |

This runbook says when each result is needed and where it goes. The service does not start without its keys and `AGENT_DID`. A runtime does not start without its advert. The commands of this runbook that make the env files by hand stay as the manual way, and the task `env` does the same work. `scripts/operator/README.md` says what each task does.

The order of the work:

1. Make the three DNS records.
2. Put the files in the folder, and make the four env files.
3. Pull the images, and pin them in the compose file.
4. Check the compose file.
5. Start the service.
6. Add the Caddy block, and check the three public names.
7. Post the three adverts.
8. Start the three runtimes, one after the other.

Section "The start order" gives the steps 5 to 8.

## The files

| File | Use |
|---|---|
| `docker-compose.order-desk.yml` | The compose project: three runtimes and one service, the images by digest, the ports on `127.0.0.1`, and the keys that each container must not hold. |
| `.env.order-desk.example` | The settings of the service and the lines that the three runtimes share. Names, placeholders and published values only. |
| `.env.order-desk-runtime.example` | The lines of one runtime: its four supplier lines, its advert and the agent identifier. One example for the three runtimes. |
| `Caddyfile.order-desk.snippet` | The three host blocks, between two markers. |
| `RUNBOOK-order-desk.md` | This runbook. |
| `.env.order-desk` | Made on the host from the shared example. The service and the three runtimes read it. |
| `.env.order-desk-small`, `.env.order-desk-medium` and `.env.order-desk-large` | Made on the host from the example of a runtime, one for each runtime. Only that runtime reads its file. |

The five files of the pack are in `deploy/server`. The four env files hold keys and a token. They never enter git, and they have mode 600.

## The memory gate

Before each container start, `MemAvailable` must be at least 1,024 MiB. The gate holds for each of the four containers, and for each container that you create again. Check it with this command:

```sh
awk '/^MemAvailable:/ { mib = int($2 / 1024); word = (mib >= 1024) ? "ok" : "stop"; print word, mib, "MiB available" }' /proc/meminfo
```

Start no container while it prints `stop`. A runtime of the other agents of the host uses about 190 MiB. Read the real size of each container of the Order Desk after its first start (section "The checks"), and write it down.

## The DNS records

Make three A records in the DNS zone of the agents. Each record is DNS only, and points at the public IPv4 address of the host:

- `mp-suppliers-orders-small.vector.apexfusion.org`
- `mp-suppliers-orders-medium.vector.apexfusion.org`
- `mp-suppliers-orders-large.vector.apexfusion.org`

Check each name against a public resolver:

```sh
dig +short mp-suppliers-orders-small.vector.apexfusion.org A @1.1.1.1
dig +short mp-suppliers-orders-medium.vector.apexfusion.org A @1.1.1.1
dig +short mp-suppliers-orders-large.vector.apexfusion.org A @1.1.1.1
```

Each answer must be the address of the host and nothing else. The address of a proxy means that the record is proxied: change it to DNS only. A proxy ends TLS before Caddy, and it replaces the body of an error answer. A failed job answers 502, and the buyer needs that body. Caddy gets the certificate of a name when it loads the block of the name, so the record must resolve first.

## The folder

The folder of the Order Desk is `/srv/agents/order-desk`. It belongs to the service user, `agents`, with mode 750. Run these commands in the folder `agents-server` of RUNBOOK.md, which holds the files of `deploy/server`:

```sh
sudo install -d -m 750 -o agents -g agents /srv/agents/order-desk
sudo stat -c '%a %U:%G %n' /srv/agents/order-desk
sudo install -m 644 -o agents -g agents docker-compose.order-desk.yml .env.order-desk.example .env.order-desk-runtime.example /srv/agents/order-desk/
```

The output of `stat` must be `750 agents:agents /srv/agents/order-desk`.

## The env files

Make the four env files as the service user, with mode 600. One file is for the service and the three runtimes together. Each runtime has a file of its own:

```sh
sudo -u agents -H bash
cd /srv/agents/order-desk
umask 077
cp .env.order-desk.example .env.order-desk
for size in small medium large; do cp .env.order-desk-runtime.example ".env.order-desk-$size"; done
```

The task `env` of the operator pack makes these files and fills the same lines. The commands of this section are the manual way. The keys come from the task `keys` of the operator pack, and the key rules of RUNBOOK.md (section "Keys") hold for them. Nobody types a key in a shell, and no command here prints one. There are four keys, and all four are different:

- The key of the service goes in `ORDER_DESK_SERVICE_PRIV_KEY_HEX` of `.env.order-desk`. It pays for the model hires and signs the claims and the challenges of the dispute code. It is never a supplier key.
- The supplier key of each runtime goes in the four `SUPPLIER_` lines of the file of that runtime. Each runtime has a key and a wallet of its own. Two runtimes with one key can spend the same outputs.

The three runtimes have three wallets. Each wallet needs two transfers. The first is one pure output of 5 units, alone, as collateral. The second is a float for the fees of its jobs, about 0.5 units for each transaction of the runtime. A wallet that gets both in one transfer can have its collateral merged into change by an ordinary transaction. The wallet of the service gets the same two transfers. It also holds the stake of a challenge, `DISPUTE_CHALLENGE_STAKE_LOVELACE`, while a challenge is open.

Make the token, and write it into the shared file. The command prints nothing:

```sh
sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $(openssl rand -hex 32)\"|" .env.order-desk
```

Fill the other lines with an editor:

- In `.env.order-desk`: `OPERATOR_CONTACT` (the contact address that the live agents publish; the operator types it, and no file of the repository holds it), `AGENT_DID`, `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE`, and the six lines `SMALL_SUPPLIER_PKH`, `SMALL_SUPPLIER_PUB_KEY_HEX`, `MEDIUM_SUPPLIER_PKH`, `MEDIUM_SUPPLIER_PUB_KEY_HEX`, `LARGE_SUPPLIER_PKH` and `LARGE_SUPPLIER_PUB_KEY_HEX`. They hold the public values of the three supplier keys. The task `env` writes the contact from the setting `OPERATOR_CONTACT`.
- In `VECTOR_MODULE1_MANIFEST`: replace `<commit>` with the 40 hex digits of the commit that the hosted MCP server uses for its `VECTOR_MODULE1_MANIFEST`.
- In each runtime file: `AGENT_ID` (the 64 hex characters of the agent record, the same in the three files). `ADVERT_REF` stays empty until the adverts exist (section "The start order", step 5).
- Leave every other line as it is. The comments in the examples say what each line does.

Then check the files. No command here prints a secret. The first prints the mode and the owner:

```sh
stat -c '%a %U:%G %n' .env.order-desk .env.order-desk-small .env.order-desk-medium .env.order-desk-large
```

It must print `600 agents:agents` four times. The next command lists the lines of the shared file that still hold a placeholder. It prints the line number and the name, never the value. It must print nothing:

```sh
grep -nE '^[A-Z0-9_]+=.*<[^>]*>' .env.order-desk | cut -d= -f1
```

This command prints the name of each required line of the shared file that is empty. It must print nothing:

```sh
for name in ORDER_DESK_SERVICE_PRIV_KEY_HEX SERVICE_AUTH_HEADER OPERATOR_CONTACT AGENT_DID SMALL_SUPPLIER_PKH SMALL_SUPPLIER_PUB_KEY_HEX MEDIUM_SUPPLIER_PKH MEDIUM_SUPPLIER_PUB_KEY_HEX LARGE_SUPPLIER_PKH LARGE_SUPPLIER_PUB_KEY_HEX; do
  [ -n "$(sed -n "s/^$name=//p" .env.order-desk | tr -d '"')" ] || echo "empty: $name"
done
```

This command prints the length of each value of a runtime file, never the value:

```sh
for size in small medium large; do
  printf '%s: ' "$size"
  awk -F= '/^(SUPPLIER_PRIV_KEY_HEX|SUPPLIER_PUB_KEY_HEX|SUPPLIER_PKH|SUPPLIER_ADDRESS|ADVERT_REF|AGENT_ID)=/ { printf "%s=%d ", $1, length($2) }' ".env.order-desk-$size"
  printf '\n'
done
```

Each line must say `SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 ADVERT_REF=0 AGENT_ID=64`. After step 5 of "The start order", `ADVERT_REF` has 66 characters.

The public values of each runtime must stand in both files: in its own file and in the shared file. This command compares them, and prints `ok` or a name:

```sh
for size in small medium large; do
  upper=$(printf '%s' "$size" | tr a-z A-Z)
  for part in PKH PUB_KEY_HEX; do
    own=$(sed -n "s/^SUPPLIER_$part=//p" ".env.order-desk-$size")
    shared=$(sed -n "s/^${upper}_SUPPLIER_$part=//p" .env.order-desk)
    if [ -n "$own" ] && [ "$own" = "$shared" ]; then echo "ok: $size $part"; else echo "differs or empty: $size $part"; fi
  done
done
```

`AGENT_DID` of the shared file is `did:vector:` and the `AGENT_ID` of each runtime file. This command checks it, and prints `ok` or a name:

```sh
for size in small medium large; do
  id=$(sed -n 's/^AGENT_ID=//p' ".env.order-desk-$size")
  if [ -n "$id" ] && [ "$(sed -n 's/^AGENT_DID=//p' .env.order-desk)" = "did:vector:$id" ]; then echo "ok: $size AGENT_ID"; else echo "differs or empty: $size AGENT_ID"; fi
done
```

No two runtimes may share a key. This command prints a key hash that stands twice among the three runtimes and the service. It must print nothing. The service also stops at start when two keys are one key:

```sh
{ sed -n 's/^SUPPLIER_PKH=//p' .env.order-desk-small .env.order-desk-medium .env.order-desk-large; sed -n 's/^ORDER_DESK_SERVICE_PKH=//p' .env.order-desk; } | sort | uniq -d
```

## The images

CI builds the service image and reuses [the pinned runtime image](README.md#the-runtime-image). CI publishes both under `:latest` and `:<full git commit sha>`. Use the tag of a reviewed commit with a successful `publish` job. The service image is `ghcr.io/apex-fusion/vector-service-agents/order-desk`. The runtime image is `ghcr.io/apex-fusion/vector-service-agents/agent-runtime`. The three runtimes use one image, so they get one digest.

The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`. RUNBOOK.md (step 5, "Run the mock service") does the same for the mock service.

Pull both images. Put each digest in `docker-compose.order-desk.yml`. The `sed` command changes the file only when the digest has 64 characters:

```sh
cd /srv/agents/order-desk
REPO=ghcr.io/apex-fusion/vector-service-agents
COMMIT=<full git commit sha>
for image in order-desk agent-runtime; do
  docker pull "$REPO/$image:$COMMIT"
  DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REPO/$image:$COMMIT" | sed 's/^.*@sha256://')
  if [ "${#DIGEST}" = 64 ]; then sed -i -E "s#($image@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" docker-compose.order-desk.yml; else echo "no digest for $image: the compose file is not changed"; fi
done
grep -E '^    image: ' docker-compose.order-desk.yml
```

The last command must print four `image:` lines with 64 hex digits. The three runtime lines must be equal. If a line still holds `<digest>`, compose refuses to start (`invalid reference format`).

## Check the compose file

First look at the file as compose renders it. Do it in a scratch folder with stand-in env files, never in the folder of the real env files: the real files hold keys, and `docker compose config` prints the values of the env files into its output.

```sh
scratch=$(mktemp -d)
cp docker-compose.order-desk.yml "$scratch/"
cp .env.order-desk.example "$scratch/.env.order-desk"
for size in small medium large; do cp .env.order-desk-runtime.example "$scratch/.env.order-desk-$size"; done
(cd "$scratch" && docker compose -f docker-compose.order-desk.yml config | grep -E '^name:|image:|container_name:|host_ip:|published:|target:')
rm -r "$scratch"
```

The output must show the project `order-desk`, four containers, and each port with `host_ip: 127.0.0.1`. The published ports are 8102, 8103, 8104 and 9102. The one network is the default network `order-desk_default`, which compose adds. No build is in the output.

Then check the file in the real folder. The first command must print `ok: every image has its digest`. The second prints nothing when all four env files are there:

```sh
grep -qE '^    image: .*<digest>' docker-compose.order-desk.yml && echo 'a digest is missing' || echo 'ok: every image has its digest'
docker compose -f docker-compose.order-desk.yml config --quiet
```

The second command stops with a message that names the env file when one is missing. It does not look at the digests: the first command does.

## The start order

Run each `docker compose` command as the service user, in `/srv/agents/order-desk`.

1. Pass the memory gate (section "The memory gate"). Start the service. This command also makes the network `order-desk_default` and the volume `order-desk-state`:

   ```sh
   docker compose -f docker-compose.order-desk.yml up -d service
   ```

2. Wait 30 seconds. Check the service:

   ```sh
   curl -fsS http://127.0.0.1:9102/healthz
   docker logs --tail 20 orders-service
   ```

   The first command prints `{"ok":true}`. The log has the line `[order-desk] listening on 0.0.0.0:9102; service address <address>; state directory /data`. If the container starts again and again, the log says why: read the failure table.

3. Join the Caddy container to the network, and add the block of the three host names (section "The Caddy block"). The three DNS records must resolve to the host first.
4. Check the three public names, and take the hash of the manifest (section "The checks"). The three hosts serve one manifest, so they give one `detail_hash`.
5. Post the three adverts with the task `advert` of the operator pack. The task reads the manifest twice, and it posts each advert for the supplier key of its runtime, with the `AGENT_ID` of the agent record. The manual way is the hosted tools of the Vector marketplace. The terms of each advert are:
   - the capability `supplychain.order.accept.v1`;
   - the model `lot-small`, `lot-medium` or `lot-large`;
   - the price 2, 5 or 10 units, with a supplier bond of 1 unit and a buyer bond of 1 unit;
   - the window 480,000 ms;
   - `endpoint_url`: the origin of the host of its own runtime;
   - `detail_uri`: that origin and `/agent.json`;
   - `detail_hash`: the hash of step 4. It is the same value in the three adverts.

   Write the reference of each advert, `<transaction hash>#<output index>`, into `ADVERT_REF` of the file of its runtime. A change to the manifest after this step means retired adverts and new ones.
6. Start the runtimes one after the other. Before each start, pass the memory gate. After each start, wait 30 seconds, and check that the runtime is up and says `free` before you start the next one:

   ```sh
   docker compose -f docker-compose.order-desk.yml up -d --no-deps runtime-small
   curl -fsS http://127.0.0.1:8102/healthz
   curl -s http://127.0.0.1:8102/status
   docker compose -f docker-compose.order-desk.yml up -d --no-deps runtime-medium
   curl -fsS http://127.0.0.1:8103/healthz
   curl -s http://127.0.0.1:8103/status
   docker compose -f docker-compose.order-desk.yml up -d --no-deps runtime-large
   curl -fsS http://127.0.0.1:8104/healthz
   curl -s http://127.0.0.1:8104/status
   ```

   The option `--no-deps` keeps compose from touching the service: a start of a runtime never creates the service again. Run the three groups of commands one at a time, not in one go.
7. Run the other checks of section "The checks".

## The checks

Each command only reads. None prints a secret.

1. The four containers answer on the loopback address. Each command prints `{"ok":true}`:

   ```sh
   for port in 8102 8103 8104 9102; do printf '%s: ' "$port"; curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"; printf '\n'; done
   ```

2. Each runtime says `free`. The word `working` means that a job runs:

   ```sh
   for port in 8102 8103 8104; do printf '%s: ' "$port"; curl -s --max-time 5 "http://127.0.0.1:$port/status" || printf 'no answer'; printf '\n'; done
   ```

3. No container of the Order Desk has a public port. The command must print `ok: no public port of the Order Desk`:

   ```sh
   docker ps --filter name='^orders-' --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public port of the Order Desk'
   ```

   If a port is public, stop the container. Write `127.0.0.1:` before the port in the compose file, and start the container again.

4. No runtime holds the key of the service, and the service holds no supplier key. Each command prints `blank`:

   ```sh
   for name in orders-small-runtime orders-medium-runtime orders-large-runtime; do printf '%s: ' "$name"; docker exec "$name" sh -c 'test -z "$ORDER_DESK_SERVICE_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'; done
   docker exec orders-service sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   ```

5. The three adverts have one manifest hash. Run these commands from a checkout of this repository, on any machine. They need no key. The three hashes must be equal, and the last command must print `1`:

   ```sh
   for host in mp-suppliers-orders-small.vector.apexfusion.org mp-suppliers-orders-medium.vector.apexfusion.org mp-suppliers-orders-large.vector.apexfusion.org; do node scripts/manifest-hash.mjs "https://$host"; done
   for host in mp-suppliers-orders-small.vector.apexfusion.org mp-suppliers-orders-medium.vector.apexfusion.org mp-suppliers-orders-large.vector.apexfusion.org; do node scripts/manifest-hash.mjs "https://$host" | sed -n 's/.*"detail_hash":"\([0-9a-f]*\)".*/\1/p'; done | sort -u | wc -l
   ```

   After the adverts exist, the `detail_hash` of each advert must be this value.

6. The lots file is the file that the manifest hashes. The two commands must print the same value:

   ```sh
   curl -fsS https://mp-suppliers-orders-small.vector.apexfusion.org/lots.json | sha256sum | cut -d' ' -f1
   curl -fsS https://mp-suppliers-orders-small.vector.apexfusion.org/agent.json | node -e 'let text = ""; process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => { console.log(JSON.parse(text).behaviour.lots.sha256); });'
   ```

7. Each runtime serves its card. The first command prints one JSON document with the interface `https://<host>/v1/job`. The second prints `200`:

   ```sh
   for host in mp-suppliers-orders-small.vector.apexfusion.org mp-suppliers-orders-medium.vector.apexfusion.org mp-suppliers-orders-large.vector.apexfusion.org; do curl -fsS "https://$host/.well-known/agent-card.json"; printf '\n'; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$host/"; done
   ```

8. Read the size of each container, and the memory that is left. Write the figures down:

   ```sh
   docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' orders-small-runtime orders-medium-runtime orders-large-runtime orders-service
   awk '/^MemAvailable:/ { print int($2 / 1024), "MiB available" }' /proc/meminfo
   ```

## The Caddy block

Caddy runs in a container on the host. `<caddy container>` is the name of that container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`. The block is in `Caddyfile.order-desk.snippet`, between the two lines `# order-desk vhosts (BEGIN)` and `# order-desk vhosts (END)`. It holds three host blocks. Each one sends `/agent.json` and `/lots.json` to `orders-service:9102`, and every other path to its own runtime. The three names must be DNS only records that resolve to the host (section "The DNS records").

1. Join the Caddy container to the network of the project. Compose makes the network when it starts the service. Do it once, and again after each new Caddy container. The second command must list `<caddy container>` and the containers of the Order Desk:

   ```sh
   docker network connect order-desk_default <caddy container>
   docker network inspect order-desk_default --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

2. Keep a copy of the file, and check that it has no block of the Order Desk yet. The second command must print `0`:

   ```sh
   cp -p <caddyfile> <caddyfile>.before-order-desk
   grep -c '^# order-desk vhosts (BEGIN)$' <caddyfile>
   ```

3. Add the block to the end of the file, in place. Append to the file: do not replace it. The container mounts one file, and a mount follows the inode of that file. A new file that takes its place has another inode, and the container does not see it. Run this in the folder that holds `Caddyfile.order-desk.snippet`:

   ```sh
   sed -n '/^# order-desk vhosts (BEGIN)$/,/^# order-desk vhosts (END)$/p' Caddyfile.order-desk.snippet >> <caddyfile>
   ```

4. Validate the whole file in the Caddy container. The answer must say `Valid configuration`. Then reload Caddy:

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   If the validation fails, write the old file back, in place, and read the error:

   ```sh
   cat <caddyfile>.before-order-desk > <caddyfile>
   ```

   Do not leave a file that fails to validate on the host. A new Caddy container reads that file, and it does not start with it. Never restart Caddy: a restart cuts the connections that are open. A reload keeps them.
5. Watch the certificates. The log must say `certificate obtained successfully` for each of the three names:

   ```sh
   docker logs --since 5m <caddy container> 2>&1 | grep -E 'certificate obtained|error'
   ```

To replace the block after a change, remove it, and then add it again. To remove it, write the file without the lines from `# order-desk vhosts (BEGIN)` to `# order-desk vhosts (END)`, in place. Then validate and reload as in step 4:

```sh
sed '/^# order-desk vhosts (BEGIN)$/,/^# order-desk vhosts (END)$/d' <caddyfile> > caddyfile.new
cat caddyfile.new > <caddyfile>
```

## The restart rule

A runtime keeps its jobs in memory. The service keeps the record of the checks of a job for 300 seconds, and the job slot for 120 seconds after a go of the check before the Claim, both in memory. A restart of a container of the Order Desk can cut a job under escrow, or lose a record that a job needs. A restart during a run is forbidden.

These actions are restarts of a container: `docker restart`, `docker compose restart`, `docker compose up -d --force-recreate`, `docker compose up -d` after a change of an image or of an env file, a reboot of the host and a power-off. These are not restarts: a reload of Caddy, a change of the Caddy block, and the first start of a container.

The three runtimes share the one job slot of the service. So all three runtimes must say `free` before you restart any container of the Order Desk, the service or a runtime. The service does not say anything about its slot: a go of the check keeps the slot for 120 seconds, and the service forgets the record of a check after 300 seconds. So do these steps in this order:

1. Wait 2 minutes after the last job.
2. Then check each runtime. A runtime that says `working` holds a job. Wait until the job ends, and start again at step 1:

   ```sh
   for port in 8102 8103 8104; do printf '%s: ' "$port"; curl -s --max-time 5 "http://127.0.0.1:$port/status" || printf 'no answer'; printf '\n'; done
   ```

3. When all three say `free`, create the container again at once. Do not wait between the check and the command. Use the name of the compose service: `service`, `runtime-small`, `runtime-medium` or `runtime-large`:

   ```sh
   docker compose -f docker-compose.order-desk.yml up -d --no-deps --force-recreate service
   ```

A container reads its env files when it is created. After a change, create that container again with step 3. The service reads `.env.order-desk` only. A runtime reads `.env.order-desk` and its own file.

A change to `SERVICE_AUTH_HEADER` needs the service and the three runtimes created again, so that the four hold one value. A new image is a restart too: pin it as in section "The images", and create only the containers that use it.

A stop of the service waits up to 300 seconds for the job that runs. Compose waits 330 seconds before it kills the container: the 30 seconds more are for the service to log a job that it abandoned, and to exit. A runtime has the default grace period of 10 seconds, so never stop a runtime that says `working`.

Never restart Caddy. Reload it (section "The Caddy block").

## The fault switch

`FAULT_MODE` in `.env.order-desk` is empty. That is a clean run: the service orders and confirms the lot that the purchase order names. The one other value is `confirm_wrong_lot`. With it, the confirmation names another lot and quantity than the purchase order, and the order that the service places has the wrong lot. A failure run uses it to show that the agent of the buyer refuses the wrong confirmation. Any other value stops the start of the service.

The switch does not change the manifest, so the three adverts stay valid. Every result carries the active value as its last member, `fault_mode`. A clean run has an empty value there.

To start a failure run:

1. Set the line. This changes the file only: no container reads it until the container is created again.

   ```sh
   sed -i 's/^FAULT_MODE=.*/FAULT_MODE=confirm_wrong_lot/' .env.order-desk
   ```

2. Wait 2 minutes after the last job. Then check that the three runtimes say `free` (section "The restart rule").
3. When all three say `free`, create the service again at once. Do not wait between the check and the command:

   ```sh
   docker compose -f docker-compose.order-desk.yml up -d --no-deps --force-recreate service
   ```

4. Check that the service runs, and that the three runtimes still say `free`.

To end the run, set the line empty again with `sed -i 's/^FAULT_MODE=.*/FAULT_MODE=/' .env.order-desk`. Then wait 2 minutes after the last job, and check that the three runtimes say `free`. When all three say `free`, create the service again at once with the command of step 3.

A failure run starts and ends between jobs, never during a run. Do not change the line, and do not create the service again, while a job runs. Never leave the switch on between runs.

## The failure table

A failed start of the service or of a runtime shows in `docker ps` as `Restarting`. Read `docker logs --tail 20 orders-service` or `docker logs --tail 20` of the runtime. The service prints `[order-desk] cannot start:` and a message. The message names the variable and never shows its value.

| Symptom | Cause | Action |
|---|---|---|
| `invalid reference format` for an image | A placeholder `<digest>` is still in the compose file. | Pin the images (section "The images"). |
| `denied` on `docker pull` | The package is private. | Make the package public, or log in to `ghcr.io` with a token that has the scope `read:packages`. |
| Compose says that an env file is not found | One of the four env files is missing, or compose runs in another folder. | Make the file from its example (section "The env files"). Run compose in `/srv/agents/order-desk`. |
| A start fails with a port that is allocated or in use (8102, 8103, 8104 or 9102) | Another program holds the port. | Find it with `ss -ltnp`. Do not change a port: the Caddy block, the runbook and the guard test name these ports. |
| `[order-desk] cannot start: environment variable ORDER_DESK_SERVICE_PRIV_KEY_HEX is required`, or `must be 64 lowercase hex characters` | The key line of the service is empty or wrong. | Write the key with a command that prints nothing (section "The env files"). |
| `... holds the service key, which belongs in ORDER_DESK_SERVICE_PRIV_KEY_HEX alone`, or `... holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The key or the token is in another line too. The message names that line and does not show the value. | Take it out of the line that the message names. |
| `... SERVICE_AUTH_HEADER is required`, or `must be printable ASCII` | The token line is empty, or it holds a character that a header cannot carry. | Make the token again (section "The env files"). Create the service and the three runtimes again. |
| `... LOTS_PUBLIC_ORIGIN must be the origin of the host of the small runtime` | The origin has a path, or the first label of its host name does not end in `-small`. | Write the https origin of the small host, as the example has it. |
| `... MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE` | The two origins of the mock systems name one host. | Write the origin of the mock host and the origin of the mock mtls host. |
| `... is not the public key of SMALL_SUPPLIER_PKH` (or of the medium or large line) | The key hash line and the public key line come from two keys, or a private key is in the line of the public key. | Copy both values from the file of that runtime (section "The env files"). |
| `... names the key of SMALL_SUPPLIER_PKH: each runtime has a key of its own`, or `... holds the key of SMALL_SUPPLIER_PKH` | Two runtimes share a key, or the key of the service is the key of a runtime. | Make a key for each one. A supplier key is never the key of the service. |
| `... IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give` | One of the three published values is wrong. | Copy the three values from the example. |
| `... VECTOR_MODULE1_MANIFEST must be an https URL with no user, query or fragment` | The line holds a file path, an http address, or an address with a user, a query or a fragment. | Write the https address as the example has it. |
| `... VECTOR_MODULE1_MANIFEST must be pinned to a commit` | The placeholder `<commit>` is still in the line, or the address names a branch or a tag. | Write the 40 hex digits of the commit that the hosted MCP server uses. |
| `The Module-1 manifest (VECTOR_MODULE1_MANIFEST)` cannot be read | The host cannot reach the address, or the commit has no manifest at that path. | Check that the host reaches the address with `curl -sSI`. Write the commit that the hosted MCP server uses. |
| `the Module-1 manifest names the identity registry ...` | The manifest at that commit is for another identity registry than `IDENTITY_POLICY_ID`. | Use the commit of the manifest of that registry. |
| `... ORDER_DESK_STATE_DIR names /data, which cannot be written` | The volume is not writable for the user `node`. | Run `docker volume inspect order-desk-state`. A new volume that is empty can be removed. A volume that holds `orders.json` is not removed: make its data belong to `node`. |
| `... FAULT_MODE must be empty or "confirm_wrong_lot"` | The switch holds another value. | Set it as section "The fault switch" says. |
| `... ADVERT_MAX_PROCESSING_MS must be at least 480000` | The window line is under the deadline of a job. | Write 480000, as the example has it. |
| A runtime starts again and again, and its log says `loadConfig: missing required env var ADVERT_REF` | The runtime started before its advert existed. | Stop it with `docker compose -f docker-compose.order-desk.yml stop runtime-small` (or the medium or large runtime). Finish step 5 of "The start order". |
| A runtime log says `loadConfig: PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the origin of the host of that runtime, as the compose file has it. |
| Caddy answers 502 for a host name | The Caddy container is not on the network, or the container of that runtime is down. | Check with `docker network inspect order-desk_default ...` (section "The Caddy block") and `docker ps`. Join the network again. |
| Caddy gets no certificate for a name | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (section "The DNS records"). Read the log of the Caddy container. |
| The hash of `/agent.json` is not the `detail_hash` of an advert | A setting of the manifest changed after the adverts were posted: an env line of the service, the image or the status word. | Retire the three adverts. Post them again with the hash that is served now. Write each new reference into `ADVERT_REF` of its runtime file. When all three runtimes say `free` (section "The restart rule"), run `docker compose -f docker-compose.order-desk.yml up -d --no-deps --force-recreate runtime-<size>` for each runtime, with the memory gate before each run. |
| `sender_not_active`, `sender_unaccountable` or `sender_key_mismatch` (403, before the Claim) | The sender is not an active agent, it has no accountable party in force, or its key is not the key that paid. | Nothing on the host. The escrow stays open. The buyer fixes its side. |
| `delegation_invalid`, `delegation_ended` or `not_vault_paid` (403, before the Claim) | The delegation does not name the sender, the delegation ended, or the escrow was not paid from a vault of the delegation. | Nothing on the host. The escrow stays open. |
| `approval_not_found`, `approval_wrong_type`, `approval_wrong_subject`, `approval_wrong_issuer`, `approval_revoked`, `approval_expired` or `approval_issuer_invalid` (403, before the Claim) | The buyer has no valid approval for this order. | Nothing on the host. The escrow stays open. |
| `approval_digest_mismatch` (403, before the Claim) | The approval is for another order than the one that arrived. The service answers first, and then it starts a challenge in the background. | Read the lines of the challenge in `docker logs orders-service`. The escrow stays open. |
| `not_for_this_supplier` (403) | The purchase order names another supplier than the DID of the Order Desk. | Nothing on the host, unless every order gets it: check `AGENT_DID`. |
| `lot_mismatch` (403) | The order names another advert or another lot than the advert that the escrow names. | Nothing on the host, unless every order gets it: check the model of each advert. |
| `quantity_mismatch` (403) | The quantity is not the size of the lot for that SKU in `/lots.json`, or the SKU is not in the file. | Nothing on the host. |
| `duplicate_po` (403) | The order book already holds that purchase order number. | Nothing: the Order Desk places one order for each number. |
| `check_unavailable` (503) | A check could not read its source in time: the identity gateway, the ledger or the order book. The escrow stays open. | Read the line `the hook could not read the <source>` in the log. Check that the host reaches the gateway, the node and the indexer, and that `orders.json` is in the volume. |
| `busy` (409): the buyer sees `supplier_busy` | The service works on a job, or it keeps its slot for another escrow, for up to 120 seconds. Buyers send the job again. | Wait. Nothing to fix. |
| `unauthorized` (401): the runtime answers `precheck_failed` (503) | The runtime sent a token that the service does not hold: the containers were created from two versions of `SERVICE_AUTH_HEADER`. | When the three runtimes say `free`, create the service and the three runtimes again. |
| `bad_context` (400) | The call has none, some, or a bad one of the six context headers. A runtime that runs the image of CI sends all six. | Check that the runtime runs the runtime image of the compose file, and not an older build. |
| `bad_wire`, `request_too_large` or `bad_shape` (400) | The request of the buyer is not the wire message, it is over 1,000,000 bytes, or it is no handoff of use case 1 with a purchase order. | Nothing on the host. The buyer fixes its request. |
| `shutting_down` (503) | The service is stopping: it takes no new job. | Wait for the start. Check `docker ps` and the log of the service. |
| `precheck_timeout` or `precheck_unreachable` (503) | The service gave no answer in 10 seconds, or the runtime could not connect to `orders-service:9102`. | Check `docker ps`, `docker logs --tail 20 orders-service` and `/healthz` on port 9102. |
| `precheck_bad_status` (502) | The service answered with a redirect, or with a status that the runtime does not read. | Read the log of the service. |
| `precheck_missing` (500, after the Claim) | The job had no record of its check: the service restarted between the check and the job, or the job came more than 300 seconds after the check. | Never restart during a run. The escrow stays Claimed, and the buyer reclaims it after the deadline. |
| `cannot_supply` (403, after the Claim) | The model decided that the lot cannot be supplied. No order is placed, and nothing is paid. The escrow stays Claimed until the buyer reclaims it after the deadline. The buyer reads the note of the model, 120 characters at most. | Nothing on the host: the decision is the model's. The log has the line `cannot_supply: the model did not confirm the order, so no order is placed`. |
| `svid_failed` (502) | The identity gateway gave no X.509-SVID for the key of the service. | Check that the key of the service is in the agent record with the authentication purpose, and that the host reaches the gateway. |
| `mock_system_failed` (502) | The supplier portal of the mock systems did not take the call. | Check `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`, the tenant, and the mock service. The log of the service has the code of the portal. |
| `inference_failed` or `model_output_invalid` (502) | The hire of the model failed, or the model gave no valid answer. | Read the log line. Check the wallet of the service: it needs its collateral and a float. |
| `store_write_failed` (500) | The service could not write `orders.json`, the journal of the dispute code or the record of the model hires. | Check the volume `order-desk-state` and the disk. |
| `deadline` (422) | The job ran out of its 300,000 ms, or the buyer hung up. | Read the log line of the job. |
| `internal` (500) | A fault in the service. | Report it with the log line of the job. |

## Back out

To take the Order Desk out of service. The order matters: the adverts go first, so that nobody can post an escrow against an agent that goes away.

1. Retire the three adverts. The operator does it with the hosted tools, one advert for each runtime, signed with the supplier key of that runtime. Skip an advert whose `ADVERT_REF` is empty in the file of its runtime: nothing was posted.
2. Wait until the three runtimes say `free`, and 2 minutes after the last job (section "The restart rule"). A job that was claimed before the retire still runs. Let it end.
3. Remove the Caddy block, as section "The Caddy block" says. Validate and reload Caddy.
4. Stop the containers. Do not use `-v`. Compose waits up to 330 seconds for the service. Leave the network of the project before the `down` command, because the Caddy container is on it:

   ```sh
   docker compose -f docker-compose.order-desk.yml stop
   docker network disconnect order-desk_default <caddy container>
   docker compose -f docker-compose.order-desk.yml down
   ```

5. Keep the volume `order-desk-state`: it holds the order book, the journal of the dispute code and the record of the model hires. Keep the env files too. Delete a key file only when its wallet is empty: a key that is deleted cannot be made again.
6. Remove the three DNS records when nobody uses the names again.
