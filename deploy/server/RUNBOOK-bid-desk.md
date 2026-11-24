# Runbook: the three Bid Desks on the agents host

This runbook tells the operator what to do, in order, to run the three Bid Desks on the agents host. [README.md](README.md) gives the facts of the host: the folders, the ports and the DNS records. [RUNBOOK.md](RUNBOOK.md) gives the steps that every agent of the host shares. This runbook gives the steps of the Bid Desks.

Four rules hold for every step:

- A runtime keeps its jobs in memory, and a service keeps the record of the checks of a job in memory. Never restart a container of a Bid Desk while a job runs (section "The restart rule").
- No command in this runbook prints a key or a token. Never add one that does.
- The host builds no image. CI publishes the images. Each compose file names each image by its digest.
- Each Bid Desk is a compose project of its own. A step for one Bid Desk never touches the containers, the env file, the volume or the Caddy block of another.

## What it is

The Bid Desk is the agent of a supplier in use case 3 (supplier bid evaluation). The Sourcing Agent of a buyer sends it a request for quotation. The Bid Desk checks who sent the request, prices it from the published price list of the supplier, and returns a quote. Its capability is `supplychain.rfq.quote.v1`.

There are three Bid Desks: `alfa`, `bravo` and `charlie`. They are one code base under three records of one operator, and they do not compete. Each one runs as two containers in a compose project of its own, `bid-desk-<name>`: a runtime in front of a service. The runtime holds the supplier key, serves the advert, claims the escrow of the buyer and calls the service. The service holds one key, the service key, and does the work. It does one job at a time. The three Bid Desks run one image of the service and one image of the runtime. They share nothing else: each has a supplier key, a service key, two wallets, an advert, two ports, a host name, a folder and a volume of its own, and no two of them share a job slot.

| Bid Desk | Runtime | Service | Runtime port on 127.0.0.1 | Service port on 127.0.0.1 | Host name | Folder | Volume | Organisation |
|---|---|---|---|---|---|---|---|---|
| `alfa` | `bids-alfa-runtime` | `bids-alfa-service` | 8108 | 9106 | `mp-suppliers-bids-alfa.vector.apexfusion.org` | `/srv/agents/bid-desk-alfa` | `bid-desk-alfa-state` | `alfa.vector.apexfusion.org` |
| `bravo` | `bids-bravo-runtime` | `bids-bravo-service` | 8109 | 9107 | `mp-suppliers-bids-bravo.vector.apexfusion.org` | `/srv/agents/bid-desk-bravo` | `bid-desk-bravo-state` | `bravo.vector.apexfusion.org` |
| `charlie` | `bids-charlie-runtime` | `bids-charlie-service` | 8110 | 9108 | `mp-suppliers-bids-charlie.vector.apexfusion.org` | `/srv/agents/bid-desk-charlie` | `bid-desk-charlie-state` | `charlie.vector.apexfusion.org` |

The container port is the same in the three Bid Desks, on purpose: 8080 for a runtime and 9106 for a service. The image of the service listens on 9106, and its health check reads that port. So a compose file changes only the host side of the mapping, and no compose file sets `PORT` for a service.

| Bid Desk | Advert model | Price (units) | Bonds (units) | Lock (units) |
|---|---|---|---|---|
| `alfa` | `bid-desk-v1` | 1 | 1 and 1 | 3 |
| `bravo` | `bid-desk-v1` | 1 | 1 and 1 | 3 |
| `charlie` | `bid-desk-v1` | 1 | 1 and 1 | 3 |

The lock of an advert is its price plus both bonds. The key variable names carry no name of a Bid Desk: the folder and the compose file tell the three apart. In each env file the supplier key of the runtime stands in `SUPPLIER_PRIV_KEY_HEX`, `SUPPLIER_PUB_KEY_HEX`, `SUPPLIER_PKH` and `SUPPLIER_ADDRESS`, and the service key stands in `BID_DESK_SERVICE_PRIV_KEY_HEX` and `BID_DESK_SERVICE_PKH`.

| Time | Value | Where |
|---|---|---|
| Window of an advert | 480,000 ms | `ADVERT_MAX_PROCESSING_MS` |
| Timeout of a runtime for its service | 360,000 ms | `SERVICE_TIMEOUT_MS` in each compose file |
| Deadline of a job in a service | 300,000 ms | the code of the service |

The deadline of a job is inside the timeout of the runtime, and the timeout is inside the window with 120 seconds to spare. The runtime refuses to boot with less than 60 seconds to spare.

Each runtime asks its service before it claims an escrow. That check before the Claim is required: a runtime with no check claims every escrow. The compose file of each Bid Desk sets `SERVICE_PRECHECK_URL` to the service of the same Bid Desk.

The operator makes three things outside this pack: the keys, the agent records, and the three adverts (with the hosted tools of the Vector marketplace). This runbook says when each one is needed and where its result goes. The claim of each Bid Desk is the operator's too (section "The operator pack"). A service does not start without its keys and `AGENT_DID`. A runtime does not start without its advert.

The status word of each Bid Desk is `proposed`, in lower case. It stays `proposed` until the first live run. `AGENT_STATUS_CHIP` in each env file holds it.

The order of the work:

1. Make the three DNS records.
2. Make the three folders, put the files in them, and make the three env files.
3. Pull the images, and pin them in the three compose files.
4. Check the three compose files.
5. Start the Bid Desks one after the other. For each one: start its service, add its Caddy block, post its advert, and start its runtime.

Section "The start order" gives step 5.

## The files

| File | Use |
|---|---|
| `docker-compose.bid-desk-alfa.yml`, `docker-compose.bid-desk-bravo.yml` and `docker-compose.bid-desk-charlie.yml` | One compose project for each Bid Desk: a runtime and a service, the images by digest, the ports on `127.0.0.1`, and the keys that each container must not hold. The three files are one file after the instance name, the host ports and the host name. |
| `.env.bid-desk.example` | The example of one env file: the settings of the service and the lines of the runtime. Names, placeholders and published values only. One example serves the three Bid Desks. |
| `Caddyfile.bid-desk.snippet` | The three host blocks, each between its own pair of markers. |
| `RUNBOOK-bid-desk.md` | This runbook. |
| `.env.bid-desk-alfa`, `.env.bid-desk-bravo` and `.env.bid-desk-charlie` | Made on the host from the example, one for each Bid Desk. The service and the runtime of that Bid Desk both read it. |

The six files of the pack are in `deploy/server`. The three env files hold keys and tokens. They never enter git, they have mode 600, and no key and no token stands in two of them.

## The memory gate

Before each container start, `MemAvailable` must be at least 1,024 MiB. The gate holds before each of the six starts of the three Bid Desks (a service and a runtime for each one), and for each container that you create again. Check it with this command:

```sh
awk '/^MemAvailable:/ { mib = int($2 / 1024); word = (mib >= 1024) ? "ok" : "stop"; print word, mib, "MiB available" }' /proc/meminfo
```

Start no container while it prints `stop`. When a start would fail the gate, make no start, and report the figure. Do not stop a container of another agent to make room, and do not lower a limit in a compose file. The section "The host" of [README.md](README.md) gives the planning sizes of a runtime and of a service, and what the other agents of the host leave free. Read the real size of each container of the three Bid Desks after its first start (section "The checks"), and write it down.

## The DNS records

Make three A records in the DNS zone of the agents. Each record is DNS only, and points at the public IPv4 address of the host:

- `mp-suppliers-bids-alfa.vector.apexfusion.org`
- `mp-suppliers-bids-bravo.vector.apexfusion.org`
- `mp-suppliers-bids-charlie.vector.apexfusion.org`

Check each name against a public resolver:

```sh
dig +short mp-suppliers-bids-alfa.vector.apexfusion.org A @1.1.1.1
dig +short mp-suppliers-bids-bravo.vector.apexfusion.org A @1.1.1.1
dig +short mp-suppliers-bids-charlie.vector.apexfusion.org A @1.1.1.1
```

Each answer must be the address of the host and nothing else. The address of a proxy means that the record is proxied: change it to DNS only. A proxy ends TLS before Caddy, and it replaces the body of an error answer. A failed job answers with its status and a JSON body, and the buyer needs that body. Caddy gets the certificate of a name when it loads the block of the name, so the record must resolve first.

## The folders

Each Bid Desk has a folder of its own: `/srv/agents/bid-desk-alfa`, `/srv/agents/bid-desk-bravo` and `/srv/agents/bid-desk-charlie`. Each one belongs to the service user, `agents`, with mode 750. Make them with `install -d`. Do not use the set-up script of the host: it refuses to run on a host that already runs agents. The first three commands make the folders, and the fourth checks them. Run the last three in the folder that holds the files of `deploy/server` (the folder `agents-server` of RUNBOOK.md, step 2):

```sh
sudo install -d -m 750 -o agents -g agents /srv/agents/bid-desk-alfa
sudo install -d -m 750 -o agents -g agents /srv/agents/bid-desk-bravo
sudo install -d -m 750 -o agents -g agents /srv/agents/bid-desk-charlie
sudo stat -c '%a %U:%G %n' /srv/agents/bid-desk-alfa /srv/agents/bid-desk-bravo /srv/agents/bid-desk-charlie
sudo install -m 644 -o agents -g agents docker-compose.bid-desk-alfa.yml .env.bid-desk.example /srv/agents/bid-desk-alfa/
sudo install -m 644 -o agents -g agents docker-compose.bid-desk-bravo.yml .env.bid-desk.example /srv/agents/bid-desk-bravo/
sudo install -m 644 -o agents -g agents docker-compose.bid-desk-charlie.yml .env.bid-desk.example /srv/agents/bid-desk-charlie/
```

The output of `stat` must be `750 agents:agents` and the folder, three times.

## The env files

Make the three env files as the service user, with mode 600. Each Bid Desk reads one file, with its own keys and its own token. Its service and its runtime both read it:

```sh
sudo -u agents -H bash
umask 077
for name in alfa bravo charlie; do cp "/srv/agents/bid-desk-$name/.env.bid-desk.example" "/srv/agents/bid-desk-$name/.env.bid-desk-$name"; done
```

The keys come from the operator pack, and the key rules of RUNBOOK.md (section "Keys") hold for them. A key is never typed in a shell, and no command here prints one. There are six keys, and all six are different: for each Bid Desk, the supplier key of its runtime and its service key. No two Bid Desks share a key, a wallet or a token.

- The supplier key of a Bid Desk goes in the four `SUPPLIER_` lines of its file. It is the key of its runtime. The service reads only the two public lines, `SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`: the compose file blanks `SUPPLIER_PRIV_KEY_HEX` for the service.
- The service key of a Bid Desk goes in `BID_DESK_SERVICE_PRIV_KEY_HEX` of its file. It pays for the model hire of each quote and signs the transactions of the janitor. It is never the supplier key. The compose file blanks the line for the runtime. `BID_DESK_SERVICE_PKH` is its key hash. The line is public and optional. When it has a value, the service checks it against the key at start.

The two keys of a Bid Desk have two wallets. Each wallet needs two transfers. The first is one pure output, alone, as collateral. The second is a float for the fees of its jobs. The funding table of the operator pack gives the sizes. A wallet that gets both in one transfer can have its collateral merged into change by an ordinary transaction. The wallet of the service key also holds the stake of the claim of its Bid Desk, which the operator commands make (section "The operator pack").

Make the three tokens, and write each one into its own file. The command prints nothing, and it makes a new token for each file:

```sh
for name in alfa bravo charlie; do sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')\"|" "/srv/agents/bid-desk-$name/.env.bid-desk-$name"; done
```

Fill the other lines of each file with an editor:

- `OPERATOR_CONTACT` (a role address, never a person) and `AGENT_DID`. The three DIDs are three different agents.
- `AGENT_ID`: the 64 hex characters of the agent record, the part of `AGENT_DID` after `did:vector:`. `ADVERT_REF` stays empty until the advert of that Bid Desk exists (section "The start order", step 5).
- `AGENT_STATUS_CHIP` stays `proposed` until the first live run. `FAULT_MODE` stays empty (section "The fault switch").
- Leave every other line as it is. The comments in the example say what each line does. A file never holds the three lines that name its Bid Desk: the compose file sets them.

Then check the files. No command here prints a secret. The first prints the mode and the owner of each file:

```sh
stat -c '%a %U:%G %n' /srv/agents/bid-desk-alfa/.env.bid-desk-alfa /srv/agents/bid-desk-bravo/.env.bid-desk-bravo /srv/agents/bid-desk-charlie/.env.bid-desk-charlie
```

It must print `600 agents:agents` and the file, three times. The next command lists the lines of the files that still hold a placeholder. It prints the file, the line number and the name, never the value. It must print nothing:

```sh
grep -nE '^[A-Z0-9_]+=.*<[^>]*>' /srv/agents/bid-desk-alfa/.env.bid-desk-alfa /srv/agents/bid-desk-bravo/.env.bid-desk-bravo /srv/agents/bid-desk-charlie/.env.bid-desk-charlie | cut -d= -f1
```

This command prints the name of each required line that is empty, with the name of its Bid Desk. It must print nothing:

```sh
for name in alfa bravo charlie; do
  for key in SUPPLIER_PRIV_KEY_HEX SUPPLIER_PUB_KEY_HEX SUPPLIER_PKH SUPPLIER_ADDRESS BID_DESK_SERVICE_PRIV_KEY_HEX SERVICE_AUTH_HEADER OPERATOR_CONTACT AGENT_DID AGENT_ID; do
    [ -n "$(sed -n "s/^$key=//p" "/srv/agents/bid-desk-$name/.env.bid-desk-$name" | tr -d '"')" ] || echo "empty: $name $key"
  done
done
```

This command prints the length of the value of each key line and of some other lines, never the value:

```sh
for name in alfa bravo charlie; do
  printf '%s: ' "$name"
  awk -F= '/^(SUPPLIER_PRIV_KEY_HEX|SUPPLIER_PUB_KEY_HEX|SUPPLIER_PKH|SUPPLIER_ADDRESS|BID_DESK_SERVICE_PRIV_KEY_HEX|BID_DESK_SERVICE_PKH|AGENT_ID|ADVERT_REF)=/ { printf "%s=%d ", $1, length($2) }' "/srv/agents/bid-desk-$name/.env.bid-desk-$name"
  printf '\n'
done
```

Each line must say `SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 BID_DESK_SERVICE_PRIV_KEY_HEX=64 BID_DESK_SERVICE_PKH=56 AGENT_ID=64 ADVERT_REF=0`. The key hash line of the service says 0 when you leave it empty. After step 5 of "The start order", `ADVERT_REF` has 66 characters.

No two Bid Desks may share a key or a token, and no key of a Bid Desk may be one key twice. This command counts the values that stand twice among the keys and the tokens of the three files. It prints a number and never a value. It must print `0`. The service also stops at start when its key is the supplier key:

```sh
sed -n 's/^\(SUPPLIER_PRIV_KEY_HEX\|BID_DESK_SERVICE_PRIV_KEY_HEX\|SERVICE_AUTH_HEADER\)=\(..*\)$/\2/p' /srv/agents/bid-desk-alfa/.env.bid-desk-alfa /srv/agents/bid-desk-bravo/.env.bid-desk-bravo /srv/agents/bid-desk-charlie/.env.bid-desk-charlie | grep -v '^""$' | sort | uniq -d | wc -l
```

This command prints a key hash that stands twice among the public key hash lines of the three files. It must print nothing:

```sh
sed -n 's/^\(SUPPLIER_PKH\|BID_DESK_SERVICE_PKH\)=\(..*\)$/\2/p' /srv/agents/bid-desk-alfa/.env.bid-desk-alfa /srv/agents/bid-desk-bravo/.env.bid-desk-bravo /srv/agents/bid-desk-charlie/.env.bid-desk-charlie | sort | uniq -d
```

## The images

CI builds the service image and reuses [the pinned runtime image](README.md#the-runtime-image). CI publishes both under `:latest` and `:<full git commit sha>`. Use the tag of a reviewed commit with a successful `publish` job. The service image is `ghcr.io/apex-fusion/vector-service-agents/bid-desk`. The runtime image is `ghcr.io/apex-fusion/vector-service-agents/agent-runtime`. The three Bid Desks run one image of each, so each image gets one digest in the three files.

The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`. RUNBOOK.md (section "Run the mock service") does the same for the mock service.

Pull both images. Put each digest in the three compose files. The `sed` command changes the files only when the digest has 64 characters:

```sh
REPO=ghcr.io/apex-fusion/vector-service-agents
COMMIT=<full git commit sha>
for image in bid-desk agent-runtime; do
  docker pull "$REPO/$image:$COMMIT"
  DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REPO/$image:$COMMIT" | sed 's/^.*@sha256://')
  if [ "${#DIGEST}" = 64 ]; then
    for name in alfa bravo charlie; do sed -i -E "s#($image@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" "/srv/agents/bid-desk-$name/docker-compose.bid-desk-$name.yml"; done
  else echo "no digest for $image: no compose file is changed"; fi
done
grep -hE '^    image: ' /srv/agents/bid-desk-alfa/docker-compose.bid-desk-alfa.yml /srv/agents/bid-desk-bravo/docker-compose.bid-desk-bravo.yml /srv/agents/bid-desk-charlie/docker-compose.bid-desk-charlie.yml
```

The last command must print six `image:` lines with 64 hex digits: the three runtime lines are equal, and the three service lines are equal. If a line still holds `<digest>`, compose refuses to start (`invalid reference format`).

## Check the compose files

First look at each file as compose renders it. Do it in a scratch folder with a stand-in env file, never in the folder of a real env file: the real file holds keys, and `docker compose config` prints the values of the env file into its output.

```sh
scratch=$(mktemp -d)
for name in alfa bravo charlie; do
  mkdir "$scratch/$name"
  cp "/srv/agents/bid-desk-$name/docker-compose.bid-desk-$name.yml" "$scratch/$name/"
  cp "/srv/agents/bid-desk-$name/.env.bid-desk.example" "$scratch/$name/.env.bid-desk-$name"
  (cd "$scratch/$name" && docker compose -f "docker-compose.bid-desk-$name.yml" config | grep -E '^name:|image:|container_name:|host_ip:|published:|target:')
done
rm -r "$scratch"
```

The output must show the project `bid-desk-<name>`, two containers, and each port with `host_ip: 127.0.0.1`. The published ports are 8108 and 9106 for `alfa`, 8109 and 9107 for `bravo`, and 8110 and 9108 for `charlie`. The target ports are 8080 and 9106 in all three. The `target: /data` is the volume of the service. No network or build is in the file.

Then check each file with its real env file. This command prints `0` for a file in which every image has its digest, and nothing else. It stops with a message that names the env file when that file is missing:

```sh
for name in alfa bravo charlie; do (cd "/srv/agents/bid-desk-$name" && grep -c '@sha256:<digest>' "docker-compose.bid-desk-$name.yml"; docker compose -f "docker-compose.bid-desk-$name.yml" config --quiet); done
```

## The price lists

Each Bid Desk serves its own price list at `/price-list.json` of its host. The file is in the image: `price-lists/alfa.json`, `price-lists/bravo.json` and `price-lists/charlie.json` of the package. The service serves its bytes. The manifest of the Bid Desk holds the address of the file and the SHA-256 of its bytes, and the advert holds the hash of the manifest. So the price list is inside the hash of the advert.

A new price list is a new image, and so a new manifest hash, and so a new advert for each Bid Desk whose list changed (section "The adverts"). Nobody changes a price list on the host. After the Bid Desk runs, check the list that it serves. The two values must be equal:

```sh
for host in mp-suppliers-bids-alfa.vector.apexfusion.org mp-suppliers-bids-bravo.vector.apexfusion.org mp-suppliers-bids-charlie.vector.apexfusion.org; do
  printf '%s: ' "$host"
  curl -fsS "https://$host/price-list.json" | sha256sum | cut -d' ' -f1
  printf '%s: ' "$host"
  curl -fsS "https://$host/agent.json" | node -e 'let text = ""; process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => { console.log(JSON.parse(text).behaviour.price_list.sha256); });'
done
```

## The adverts

Each Bid Desk has an advert of its own, and the three adverts have three hashes. The manifest of a Bid Desk names that Bid Desk, its agent record, its keys and its price list, so the three manifests differ. Post each advert with the hash of its own manifest, and never with the hash of another. This pack does not post the adverts: the operator posts them with the hosted tools of the Vector marketplace. Post each advert for the supplier key of its runtime, with the `AGENT_ID` of its agent record. The terms of each advert are:

- the capability `supplychain.rfq.quote.v1`;
- the model `bid-desk-v1`;
- the price 1 unit, with a supplier bond of 1 unit and a buyer bond of 1 unit, so the lock is 3 units;
- the window 480,000 ms;
- `endpoint_url`: the origin of the host name of its own Bid Desk;
- `detail_uri`: that origin and `/agent.json`;
- `detail_hash`: the hash of its own manifest (section "The checks", check 5).

Write the reference of each advert, `<transaction hash>#<output index>`, into `ADVERT_REF` of the env file of its own Bid Desk. A change to the manifest after its advert is posted means a retired advert and a new one for that Bid Desk. A change to a price list is a new image, and it changes the manifest of that Bid Desk only when the list of that Bid Desk changed. After you post a new advert, write its reference into `ADVERT_REF`, and create the runtime again with `up -d --no-deps --force-recreate runtime`, as section "The restart rule" says. A runtime that holds the reference of a retired advert refuses every job with 503 `advert_not_active`.

## The start order

Start the Bid Desks one after the other, `alfa` first, then `bravo`, then `charlie`. Finish the steps for one Bid Desk before you start the next, so that a fault shows in one Bid Desk only. Write the name of the Bid Desk in place of `<name>`, and take its ports from the table of section "What it is". Run each `docker compose` command as the service user, in `/srv/agents/bid-desk-<name>`.

1. Pass the memory gate (section "The memory gate"). Start the service. This command also makes the network `bid-desk-<name>_default` and the volume `bid-desk-<name>-state`:

   ```sh
   docker compose -f docker-compose.bid-desk-<name>.yml up -d service
   ```

2. Wait 30 seconds. Check the service. Write the port of its service in place of `<service port>`:

   ```sh
   curl -fsS http://127.0.0.1:<service port>/healthz
   docker logs --tail 20 bids-<name>-service
   ```

   The first command prints `{"ok":true}`. The log has the line `[bid-desk] listening on 0.0.0.0:9106; service address <address>; state directory /data`. If the container starts again and again, the log says why: read the failure table.

3. Join the Caddy container to the network of this Bid Desk, and add its block (section "The Caddy block"). Its DNS record must resolve to the host first.
4. Check the public names of this Bid Desk, and take the hash of its manifest (section "The checks"). It is the `detail_hash` of its advert.
5. Post the advert of this Bid Desk (section "The adverts"). Keep the Post transaction hash in the deployment record. Verify its output on the ledger. If confirmation is unknown, check the same hash and stop; do not post again. Write its confirmed reference into the existing `ADVERT_REF` entry of this desk's env file. Do not append a second entry or print the file.
6. Start the runtime. Pass the memory gate first. After the start, wait 30 seconds, and check that the runtime is up and says `free`. Write the port of its runtime in place of `<runtime port>`:

   ```sh
   docker compose -f docker-compose.bid-desk-<name>.yml up -d --no-deps runtime
   curl -fsS http://127.0.0.1:<runtime port>/healthz
   curl -s http://127.0.0.1:<runtime port>/status
   ```

   The option `--no-deps` keeps compose from touching the service: a start of the runtime never creates the service again.
   Read `GET /capability` on the runtime port of this desk. Require HTTP 200 and an `advert_ref` equal to the confirmed output reference from step 5. A reference for another desk is not ready for a hire.
7. Run the other checks of section "The checks" for this Bid Desk.

## The checks

Each command only reads. None prints a secret. The commands name the three Bid Desks. While one or two of them do not run yet, leave their ports, containers and host names out of the commands, and check the others.

1. The six containers answer on the loopback address. Each command prints `{"ok":true}`:

   ```sh
   for port in 8108 8109 8110 9106 9107 9108; do printf '%s: ' "$port"; curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"; printf '\n'; done
   ```

2. Each runtime says `free`. The word `working` means that a job runs:

   ```sh
   for port in 8108 8109 8110; do printf '%s: ' "$port"; curl -s --max-time 5 "http://127.0.0.1:$port/status" || printf 'no answer'; printf '\n'; done
   ```

3. No container of the Bid Desks has a public port. The command must print `ok: no public port of the Bid Desks`:

   ```sh
   docker ps --filter name='^bids-' --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public port of the Bid Desks'
   ```

   If a port is public, stop the container. Write `127.0.0.1:` before the port in the compose file, and start the container again.

4. No runtime holds the key of its service, and no service holds a supplier key. Each runtime has its check before the Claim. Each command prints `blank` or `hook set`:

   ```sh
   for name in alfa bravo charlie; do
     printf '%s: ' "$name"
     docker exec "bids-$name-runtime" sh -c 'test -z "$BID_DESK_SERVICE_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
     docker exec "bids-$name-runtime" sh -c 'test -n "$SERVICE_PRECHECK_URL" && echo hook set || echo NO HOOK'
     docker exec "bids-$name-service" sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   done
   ```

5. The three adverts have three manifest hashes. Run these commands from a checkout of this repository, on any machine. They need no key. The first prints one line of JSON for each Bid Desk, with the `detail_uri`, the `detail_hash` and the number of bytes. The second prints `3`, because the three hashes differ:

   ```sh
   for host in mp-suppliers-bids-alfa.vector.apexfusion.org mp-suppliers-bids-bravo.vector.apexfusion.org mp-suppliers-bids-charlie.vector.apexfusion.org; do node scripts/manifest-hash.mjs "https://$host"; done
   for host in mp-suppliers-bids-alfa.vector.apexfusion.org mp-suppliers-bids-bravo.vector.apexfusion.org mp-suppliers-bids-charlie.vector.apexfusion.org; do node scripts/manifest-hash.mjs "https://$host" | sed -n 's/.*"detail_hash":"\([0-9a-f]*\)".*/\1/p'; done | sort -u | wc -l
   ```

   After the adverts exist, the `detail_hash` of each advert must be the value of its own Bid Desk. If it is not, retire that advert and post a new one with the hash that is served now (section "The adverts").

6. Each price list is the file that its manifest hashes (section "The price lists").
7. Each runtime serves its card. The first command prints one JSON document with the interface `https://<host>/v1/job`. The second prints `200`:

   ```sh
   for host in mp-suppliers-bids-alfa.vector.apexfusion.org mp-suppliers-bids-bravo.vector.apexfusion.org mp-suppliers-bids-charlie.vector.apexfusion.org; do curl -fsS "https://$host/.well-known/agent-card.json"; printf '\n'; curl -fsS -o /dev/null -w '%{http_code}\n' "https://$host/"; done
   ```

8. The check before the Claim needs its token. A call to a service without the token gets `401`. The call holds no body and no token, and it does nothing else. The command prints `401` three times:

   ```sh
   for port in 9106 9107 9108; do curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://127.0.0.1:$port/precheck"; done
   ```

9. Read the size of each container, and the memory that is left. Write the figures down:

   ```sh
   docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' bids-alfa-runtime bids-alfa-service bids-bravo-runtime bids-bravo-service bids-charlie-runtime bids-charlie-service
   awk '/^MemAvailable:/ { print int($2 / 1024), "MiB available" }' /proc/meminfo
   ```

## The Caddy block

Caddy runs in a container on the host. `<caddy container>` is the name of that container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`. The blocks are in `Caddyfile.bid-desk.snippet`. It holds three host blocks, each between its own pair of lines: `# bid-desk-alfa vhosts (BEGIN)` and `# bid-desk-alfa vhosts (END)`, `# bid-desk-bravo vhosts (BEGIN)` and `# bid-desk-bravo vhosts (END)`, and `# bid-desk-charlie vhosts (BEGIN)` and `# bid-desk-charlie vhosts (END)`. Each block sends `/agent.json` and `/price-list.json` to the service of its Bid Desk, `bids-<name>-service:9106`, and every other path to its runtime, `bids-<name>-runtime:8080`. Write the name of the Bid Desk in place of `<name>` in the commands below, and work on one Bid Desk at a time. Its name must be a DNS only record that resolves to the host (section "The DNS records").

Only this way works for this pack. Its upstreams are container names, so only a Caddy container on the network of the project resolves them. A folder of snippets does not fit, and Caddy on the host cannot resolve the names. One pair of markers belongs to each Bid Desk, so a block gets in, is replaced and goes out on its own, and the other two blocks stay.

1. Join the Caddy container to the network of the project of this Bid Desk. Compose makes the network when it starts the service. Do it once for each Bid Desk, after the first start of its service, and again after each new Caddy container. The second command must list `<caddy container>` and `bids-<name>-service`, and also `bids-<name>-runtime` after step 6 of "The start order". The network lists the runtime only after that step:

   ```sh
   docker network connect bid-desk-<name>_default <caddy container>
   docker network inspect bid-desk-<name>_default --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

2. Keep a copy of the file, and check that it has no block of this Bid Desk yet. The second command must print `0`:

   ```sh
   cp -p <caddyfile> <caddyfile>.before-bid-desk-<name>
   grep -c '^# bid-desk-<name> vhosts (BEGIN)$' <caddyfile>
   ```

3. Add the block of this Bid Desk to the end of the file, in place. Append to the file: do not replace it. The container mounts one file, and a mount follows the inode of that file. A new file that takes its place has another inode, and the container does not see it. Run this in the folder that holds `Caddyfile.bid-desk.snippet`:

   ```sh
   sed -n '/^# bid-desk-<name> vhosts (BEGIN)$/,/^# bid-desk-<name> vhosts (END)$/p' Caddyfile.bid-desk.snippet >> <caddyfile>
   ```

4. Validate the whole file in the Caddy container. The answer must say `Valid configuration`. Then reload Caddy:

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   If the validation fails, write the old file back, in place, and read the error:

   ```sh
   cat <caddyfile>.before-bid-desk-<name> > <caddyfile>
   ```

   Do not leave a file that fails to validate on the host. A new Caddy container reads that file, and it does not start with it. Never restart Caddy: a restart cuts the connections that are open. A reload keeps them.
5. Watch the certificate. The log must say `certificate obtained successfully` for the name of this Bid Desk:

   ```sh
   docker logs --since 5m <caddy container> 2>&1 | grep -E 'certificate obtained|error'
   ```

To replace the block of one Bid Desk after a change, remove it, and then add it again. To remove it, write the file without the lines from `# bid-desk-<name> vhosts (BEGIN)` to `# bid-desk-<name> vhosts (END)`, in place. The blocks of the other two Bid Desks stay. Then validate and reload as in step 4:

```sh
sed '/^# bid-desk-<name> vhosts (BEGIN)$/,/^# bid-desk-<name> vhosts (END)$/d' <caddyfile> > caddyfile.new
cat caddyfile.new > <caddyfile>
```

## The restart rule

A runtime keeps its jobs in memory. A service keeps the record of the checks of a job for 300 seconds, and the job slot for 120 seconds after a go of the check before the Claim, both in memory. A restart of a container of a Bid Desk can cut a job under escrow, or lose a record that a job needs. A restart during a run is forbidden.

These actions are restarts of a container: `docker restart`, `docker compose restart`, `docker compose up -d --force-recreate`, `docker compose up -d` after a change of an image or of an env file, a reboot of the host and a power-off. These are not restarts: a reload of Caddy, a change of a Caddy block, and the first start of a container.

The Bid Desks share no job slot. Each service keeps the slot of its own Bid Desk, and each runtime says `free` or `working` for its own Bid Desk only. So a restart of one Bid Desk needs the runtime of that Bid Desk to say `free`, and it asks nothing of the other two. A service does not say anything about its slot, and a job can start at any time. So every restart has three steps, in this order, and the third follows the second with no pause:

1. Wait 2 minutes after the last job. A go of the check before the Claim keeps the slot for 120 seconds. After the wait, no slot is held for a job that has not started.
2. Check that the runtime of this Bid Desk says `free`. The word `working` means that a job runs: do not restart, wait for the job to end, and begin again at step 1.
3. Run the `up` command at once. Never check first and then wait: a job that starts in a wait after the check is cut.

One command does the three steps without a gap. It waits 2 minutes, checks `/status` of the runtime of the Bid Desk, and creates the container only when the runtime says `free`. A container reads its env file when it is created, so use the command after each change of an env file. Run the command of the Bid Desk in `/srv/agents/bid-desk-<name>`. The three commands create the service. To create the runtime, write `runtime` in place of `service`. To create both, write `service runtime`:

For `alfa`, in `/srv/agents/bid-desk-alfa`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8108/status | grep -q '"status":"free"'; then docker compose -f docker-compose.bid-desk-alfa.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

For `bravo`, in `/srv/agents/bid-desk-bravo`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8109/status | grep -q '"status":"free"'; then docker compose -f docker-compose.bid-desk-bravo.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

For `charlie`, in `/srv/agents/bid-desk-charlie`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8110/status | grep -q '"status":"free"'; then docker compose -f docker-compose.bid-desk-charlie.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

When a command prints the last words, nothing was restarted. Run it again after the job ends. The stop of section "Back out" follows the same three steps.

A change to `SERVICE_AUTH_HEADER` of a Bid Desk needs its service and its runtime created again, so that the two hold one value. Write `service runtime` in place of `service` in the command of that Bid Desk. A new image is a restart too: pin it as in section "The images", and create only the containers that use it, with the same command, one Bid Desk after the other.

A stop of a service waits up to 300 seconds for the job that runs. Compose waits 330 seconds before it kills the container: the 30 seconds more are for the service to log a job that it abandoned, and to exit. A runtime has the default grace period of 10 seconds, so never stop a runtime that says `working`.

Never restart Caddy. Reload it (section "The Caddy block").

## The fault switch

The service of each Bid Desk reads `FAULT_MODE` one time, when it starts. The line is empty in each env file for a clean run. The one other value is `quote_off_price_list`. Any other value stops the start (section "The failure table").

The value `quote_off_price_list` is for a failure run only, and for one Bid Desk. With it, the job of that Bid Desk quotes the unit price of one line below its own price list, so that the buyer can catch a quote that is off the published list. The switch of one Bid Desk never changes another. It changes no check, and it changes no manifest: the manifest and its hash are the same with the switch on or off, so the advert stays valid.

1. Write `FAULT_MODE=quote_off_price_list` in the env file of that Bid Desk, and in no other. After the run, write `FAULT_MODE=` again:

   ```sh
   sed -i 's/^FAULT_MODE=.*/FAULT_MODE=quote_off_price_list/' /srv/agents/bid-desk-<name>/.env.bid-desk-<name>
   ```

2. Create the service of that Bid Desk again, and only that one, with the command of section "The restart rule". It waits 2 minutes, checks that the runtime of that Bid Desk says `free`, and creates the service only then. An env change needs a new container: a restart does not read the file. Never do it during a run. The runtime does not read the switch, so the service is the one container to create again.
3. Read the switch from the running containers, never from the file. The command prints the value between brackets for each Bid Desk and prints nothing else:

   ```sh
   for name in alfa bravo charlie; do printf '%s: ' "$name"; docker exec "bids-$name-service" sh -c 'printf "FAULT_MODE=[%s]\n" "$FAULT_MODE"'; done
   ```

   A clean run needs `FAULT_MODE=[]` for the three Bid Desks. A failure run needs `FAULT_MODE=[quote_off_price_list]` for the one Bid Desk of the run and `FAULT_MODE=[]` for the other two. Do this check before each run.

Every quote carries the member `fault_mode`. It is the empty text in a clean run, and it is `quote_off_price_list` in a failure run. The evidence of a run carries the same value, so a result and its evidence say which kind of run they belong to.

## The failure table

A failed start of a service or of a runtime shows in `docker ps` as `Restarting`. Read `docker logs --tail 20 bids-<name>-service` or `docker logs --tail 20 bids-<name>-runtime`. A service prints `[bid-desk] cannot start:` and a message. The message names the variable and never shows its value.

A Bid Desk is the hired side. A job that fails answers with its HTTP status and a JSON body, and the runtime turns that answer into the one that the buyer reads. The statuses of the table are the statuses of the service.

| Symptom | Cause | Action |
|---|---|---|
| `invalid reference format` for an image | A placeholder `<digest>` is still in a compose file. | Pin the images (section "The images"). |
| `denied` on `docker pull` | The package is private. | Make the package public, or log in to `ghcr.io` with a token that has the scope `read:packages`. |
| Compose says that an env file is not found | The env file of that Bid Desk is missing, or compose runs in another folder. | Make the file from the example (section "The env files"). Run compose in `/srv/agents/bid-desk-<name>`. |
| A start fails with a port that is allocated or in use (8108, 8109, 8110, 9106, 9107 or 9108) | Another program holds the port. | Find it with `ss -ltnp`. Do not change a port: the Caddy blocks, the runbook and the guard test name these ports. |
| A service is up and says `unhealthy` | The health check of the image reads port 9106 inside the container. A compose file that sets `PORT` for the service, or that maps another container port, makes it fail. | Check the mapping of the service, `127.0.0.1:<service port>:9106`, and take any `PORT` out of its environment. Create the service again. |
| `[bid-desk] cannot start: environment variable BID_DESK_SERVICE_PRIV_KEY_HEX is required`, or `must be 64 lowercase hex characters` | The service key line is empty or wrong. | Write the key with a command that prints nothing (section "The env files"). |
| `... holds the service key, which belongs in BID_DESK_SERVICE_PRIV_KEY_HEX alone`, or `... holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The key or the token stands in another line too. The message names that line and does not show the value. | Take it out of the line that the message names. |
| `... BID_DESK_SERVICE_PKH (56 characters) is not the key hash of the key in BID_DESK_SERVICE_PRIV_KEY_HEX` | The key hash line does not belong to the key before it. | Correct the line, or leave it empty. |
| `... BID_DESK_SERVICE_PRIV_KEY_HEX holds the supplier key` | The service key is the supplier key of the runtime. | Make a key of its own for the service. The supplier key belongs to the runtime. |
| `... SERVICE_AUTH_HEADER is required`, or `must be printable ASCII` | The token line is empty, or it holds a character that a header cannot carry. | Make the token again (section "The env files"). Create the service and the runtime of that Bid Desk again with the command of section "The restart rule", with `service runtime` as the names. |
| `... SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH` | The two lines come from two keys, or a private key is in the line of the public key. | Copy both values from the key of the runtime of that Bid Desk. |
| `... AGENT_DID is required`, or `... must be did:vector: and 64 lowercase hex characters` | The DID line is empty or has the wrong form. | Write `did:vector:` and the 64 hex characters of the agent record. |
| `... BID_DESK_INSTANCE must be alfa, bravo or charlie` | The compose file was changed: the line names no Bid Desk. | Write the name of the Bid Desk as its compose file has it. |
| `... BID_DESK_ORGANISATION must be a domain name in lower case`, or `... BID_DESK_PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the organisation and the origin of the Bid Desk as its compose file has them. |
| `... IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give` | One of the three published values is wrong. | Copy the three values from the example. |
| `... CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 2249` | The budget of the hook is out of range: the four reads of the hook must stay under 9,000 ms. | Empty the line, or write a number in the range. |
| `... BID_DESK_STATE_DIR names /data, which cannot be written` | The volume is not writable for the user `node`. | Run `docker volume inspect bid-desk-<name>-state`. A new volume that is empty can be removed. A volume that holds `rfq-book.json` is not removed: make its data belong to `node`. |
| `... FAULT_MODE must be empty or "quote_off_price_list"` | The switch holds another value. | Empty the line, or write the one value of this agent (section "The fault switch"). |
| `... ADVERT_MAX_PROCESSING_MS must be at least 480000` | The window line is under the deadline of a job. | Write 480000, as the example has it. |
| `... LLM_MODEL_ALLOWLIST is required`, or `... must be a whole number of lovelace` (the same for each line of `LLM_MAX_`) | A limit line is empty or wrong. The service never fills in a limit. | Write the value of the example. |
| A runtime starts again and again, and its log says `loadConfig: missing required env var ADVERT_REF` | The runtime started before its advert existed. It never boots, so it holds no job. | Stop it with `docker compose -f docker-compose.bid-desk-<name>.yml stop runtime`. Finish step 5 of "The start order" for that Bid Desk. |
| A runtime log says `loadConfig: PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the origin of the host name of that Bid Desk, as its compose file has it. |
| Caddy answers 502 for a host name | The Caddy container is not on the network of that Bid Desk, or a container of that Bid Desk is down. | Check with `docker network inspect bid-desk-<name>_default ...` (section "The Caddy block") and `docker ps`. Join the network again. |
| Caddy gets no certificate for a name | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (section "The DNS records"). Read the log of the Caddy container. |
| The hash of `/agent.json` is not the `detail_hash` of the advert of that Bid Desk | A setting of the manifest changed after the advert was posted: an env line of the service, the image, the price list or the status word. | Retire the advert of that Bid Desk. Post a new advert with the hash that is served now. Write its reference into `ADVERT_REF` of its env file. Create the runtime of that Bid Desk again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| The hash of `/price-list.json` is not the `price_list.sha256` of the manifest | A proxy or a cache changed the bytes, or the Caddy block of that Bid Desk sends the path to another service. | Check the block of that Bid Desk (section "The Caddy block"): it sends `/price-list.json` to its own service. |
| `advert_not_active` (503) | The runtime holds the reference of an advert that is retired or not active, so it refuses every job. | Post a new advert when none is active. Write the reference of the active advert into `ADVERT_REF` of the env file of that Bid Desk. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `precheck_failed` (503) | The service answered the runtime with 401 `unauthorized`: the two containers were created from two versions of `SERVICE_AUTH_HEADER`. The log of the runtime says that the service refused the token. | Create the service and the runtime of that Bid Desk again with the command of section "The restart rule", with `service runtime` as the names. |
| `unauthorized` (401) | A call to the service has no token or another token. The runtime of the Bid Desk sends the token of its env file. | Nothing on the host for a call that comes from outside. For a runtime, create the two containers again as the row of `precheck_failed` says. |
| `busy` (409) | The service works on a job, or it keeps its slot for another escrow, for up to 120 seconds. Buyers send the job again. | Wait. Nothing to fix. |
| `supplier_busy` (409) | The runtime works on a job itself. | Wait. Nothing to fix. |
| `precheck_timeout` or `precheck_unreachable` (503) | The service gave no answer in 10 seconds, or the runtime could not connect to the service of its own Bid Desk. | Check `docker ps`, `docker logs --tail 20 bids-<name>-service` and `/healthz` on the port of the service. |
| `precheck_bad_status` (502) | The service answered with a redirect, or with a status that the runtime does not read. | Read the log of the service. |
| `shutting_down` (503) | The service is stopping: it takes no new job. | Wait for the start. Check `docker ps` and the log of the service. |
| `bad_context` (400) | The call has none, some, or a bad one of the six context headers. A runtime that runs the image of CI sends all six. | Check that the runtime runs the runtime image of the compose file, and not an older build. |
| `bad_wire`, `request_too_large` or `bad_shape` (400) | The request of the buyer is not the wire message, it is over 1,000,000 bytes, or it is no request for quotation of use case 3. | Nothing on the host. The buyer fixes its request. |
| `sender_not_active`, `sender_unaccountable` or `sender_key_mismatch` (403, before the Claim) | The sender is not an active agent, it has no accountable party in force, or its key is not the key that paid. | Nothing on the host. The escrow stays open. The buyer fixes its side. |
| `delegation_invalid`, `delegation_ended` or `not_vault_paid` (403, before the Claim) | The delegation does not name the sender, the delegation ended, or the escrow was not paid from a vault of the delegation. | Nothing on the host. The escrow stays open. |
| `duplicate_rfq` (403, before the Claim or after it) | The book of the Bid Desk already holds an answer to this request from this sender. The book never drops an entry. | Nothing on the host: a Bid Desk gives one quote for each request. The buyer sends a new request with a new `rfq_id`. |
| `check_unavailable` (503) | A check could not read its source in time: the identity gateway, the ledger or the book. The escrow stays open. | Read the line `bid desk: the <source> failed` in the log: it names the source and the kind of the error. Check that the host reaches the gateway, the node and the indexer, and that `rfq-book.json` is in the volume. |
| `precheck_missing` (500, after the Claim) | The job had no record of its check: the service restarted between the check and the job, or the job came more than 300 seconds after the check. | Never restart during a run. The escrow stays Claimed, and the buyer reclaims it after the deadline. |
| `credential_failed` (502) | The identity gateway gave no credential for the desk. | Check that the agent record of that Bid Desk exists and is active, and that the host reaches the gateway. |
| `inference_failed` or `model_output_invalid` (502) | The hire of the model failed, or the model gave no answer that a quote can hold. | Read the log line. Check the wallet of the service key: it needs its collateral and a float. |
| `store_write_failed` (500) | The service could not write `rfq-book.json` or the record of the model hires. | Check the volume `bid-desk-<name>-state` and the disk. |
| `deadline` (422) | The buyer hung up before the job gave its quote, or less than 30 seconds were left before the runtime stops waiting for the job. Nothing is recorded. | Read the log line of the job. Nothing to fix when it happens once. |
| `internal` (500) | A fault in the service. | Report it with the log line of the job. |

## Back out

To take one Bid Desk out of service, retire its listing first. An escrow that already exists can still need work. The other two Bid Desks, their containers and their blocks stay. To take all three out, run the steps for each Bid Desk in turn.

1. Check each recorded Post and the current advert outputs for this desk's agent ID, supplier and model. An empty `ADVERT_REF` does not prove that no Post landed. If a Post may still land, or the ledger read fails, stop here. Retire every matching active advert with `vector_build_marketplace_advert_retire` and the supplier key of this desk's runtime. Confirm each Retire with `vector_await_transaction`. Skip retirement only when no matching advert is active and no Post can still land.
2. If the runtime started, let its last job end and then wait 2 minutes. If the runtime never started, verify that fact with this desk's deployment record and container history. A missing container or a failed `/status` request is not proof.

   For either path, complete [the ledger check](RUNBOOK.md#check-the-ledger-before-a-use-case-3-stop) before you stop anything. Leave the runtime, service and its Caddy block in place if work is outstanding or proof is unavailable.

   If the runtime started, require `free` and zero active sessions at the stop. Run the command for this desk in its folder. Replace `<name>` and `<runtime port>` with the values in the table in "What it is". Compose waits up to 330 seconds for the service:

   ```sh
   status=$(curl -fsS --max-time 5 http://127.0.0.1:<runtime port>/status) &&
     printf '%s\n' "$status" | grep -q '"status":"free"' &&
     printf '%s\n' "$status" | grep -Eq '"active_sessions":0[,}]' &&
     docker compose -f docker-compose.bid-desk-<name>.yml stop
   ```

   If the runtime never started, stop the service alone with `docker compose -f docker-compose.bid-desk-<name>.yml stop service`. Continue only after the applicable stop succeeds.
3. Remove the Caddy block of that Bid Desk, with its own pair of markers, as section "The Caddy block" says. The blocks of the other two stay. Validate and reload Caddy.
4. Leave the network of the project before the `down` command, because the Caddy container is on it. Do not use `-v`:

   ```sh
   docker network disconnect bid-desk-<name>_default <caddy container>
   docker compose -f docker-compose.bid-desk-<name>.yml down
   ```

5. Keep the volume `bid-desk-<name>-state`: it holds the book of the requests that the desk answered, `rfq-book.json`, and the bookkeeping of the model hires of its service key. Keep the env file too. Delete a key file only when its wallet is empty: a key that is deleted cannot be made again.
6. Remove the DNS record of that Bid Desk when nobody uses the name again.

## The operator pack

The claim of each Bid Desk is made with the operator commands of the operator pack, and never by the service. The claim is the three statements in `behaviour.claim` of the manifest. The stake of the claim and its record belong to the service key of that Bid Desk: the operator commands make them, one Bid Desk at a time. The service has no claim code and no dispute code, and it never challenges. A challenge against the claim of a Bid Desk comes from the Sourcing Agent, and never from this service.

This runbook starts the three services and the three runtimes. It never makes a stake, a claim or a record.
