# Runbook: the Insurer Intake Agent on the agents host

This runbook tells the operator what to do, in order, to run the Insurer Intake Agent on the agents host. [README.md](README.md) gives the facts of the host: the folders, the ports and the DNS records. [RUNBOOK.md](RUNBOOK.md) gives the steps that every agent of the host shares. This runbook gives the steps of the Insurer Intake Agent.

Three rules hold for every step:

- A runtime keeps its jobs in memory, and the service keeps the record of the checks of a job and the slot of its job in memory. Never restart a container of the Insurer Intake Agent while a job runs (section "The restart rule").
- No command in this runbook prints a key or the token. Never add one that does.
- The host builds no image. CI publishes the images. The compose file names each one by its digest.

## What it is

The Insurer Intake Agent is the agent of an insurer in use case 2 (prior authorization). The Prior Authorization Agent of a care provider hires it, and the vault of the hirer pays for the job. The runtime asks the hook of the service before it claims the escrow. The hook runs 15 checks: who sent the request, the delegation, the payment from the vault, the approval of the reviewer of the provider for exactly this request, and three checks of its own (the request names this insurer, it names the advert of the escrow, and its request number is new). When every check passes, the runtime claims the escrow and the service does the job. A model decides whether the request is complete, the service files the request in the system of the insurer, and it answers with an intake record. The agent makes an intake decision and no coverage decision. Its capability is `health.priorauth.intake.v1`.

It runs as two containers in one compose project, `insurer-intake-agent`: a runtime in front of a service. The runtime holds the supplier key, serves the advert, asks the hook, claims the escrow and calls the service. The service holds the service key and does the work. It does one job at a time. It has no co-sign route and no subagent.

| Runtime | Container | Port on 127.0.0.1 | Host name | Advert model | Price (units) | Bonds (units) | Lock (units) |
|---|---|---|---|---|---|---|---|
| Insurer Intake | `intake-runtime` | 8106 | `mp-suppliers-intake.vector.apexfusion.org` | `insurer-intake-agent-v1` | 2 | 1 and 1 | 4 |

The service is the container `intake-service`, on `127.0.0.1:9104`. The lock of an advert is its price plus both bonds.

| Time | Value | Where |
|---|---|---|
| Window of the advert | 480,000 ms | `ADVERT_MAX_PROCESSING_MS` |
| Timeout of the runtime for the service | 360,000 ms | `SERVICE_TIMEOUT_MS` in the compose file |
| Deadline of a job in the service | 300,000 ms | the code of the service |
| Wait of the runtime for the hook | 10,000 ms | the runtime |
| Budget of one read of the hook | 1,200 ms | `CHECKS_READ_BUDGET_MS` |

The deadline of a job is inside the timeout of the runtime, and the timeout is inside the window with 120 seconds to spare. The runtime refuses to boot with less than 60 seconds to spare. The hook makes six timed reads one after the other: the identity gateway once and the ledger five times. Six budgets are 7,200 ms. That is under the 9,000 ms that the service allows, so a second of the wait of the runtime stays for the rest of the hook.

The operator pack (`scripts/operator`) makes the keys, the record, the stake, the env files and the advert. It is not part of this deploy pack. Use its tasks in this order:

| Task | Result | When |
|---|---|---|
| `keys` | The keys of the use case. | First. |
| `fund` | Collateral and float for the wallets of the use case. | After key setup. |
| `register` | The record of the Insurer Intake Agent. | Before the first start. Publish the required organisation TXT first. |
| `stake` | The Module-3 stake of the agent. | After registration. |
| `env` | The env files of both agents in the use case. The task needs both folders and both agents' records, including the Prior Authorization Agent's subagents. | Before service start and after advert posting. |
| `advert` | One advert for this agent. | When the service serves its final manifest and before the runtime starts. |

The service needs its key and `AGENT_DID` to start. The runtime needs its confirmed advert reference. See the [operator pack guide](../../scripts/operator/README.md) for the tasks.

The first run also needs the claim of the run and a mock tenant with the insurer organisation. Use the task `claim` and the task `tenant` of the operator pack. For a manual tenant setup, use RUNBOOK.md, step 6, "Make or reset a tenant".

The `claim` task of the operator pack supports one Module-1 claim for this agent before each clean or failure run. The task signs with the service key. The stake is 50 units (50,000,000 lovelace). The challenge window is 24 hours. After the window, `claim cleanup` withdraws the claim if nobody challenged it. The service does not stake its own claim. If the challenge lookup finds no eligible open claim, it returns `no_open_claim`.

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
| `docker-compose.insurer-intake-agent.yml` | The compose project: a runtime and a service, the images by digest, the ports on `127.0.0.1`, and the keys that each container must not hold. |
| `.env.insurer-intake-agent.example` | The settings of both containers: the supplier lines, the service key, the token and the published values. Names, placeholders and published values only. |
| `Caddyfile.insurer-intake-agent.snippet` | The host block, between two markers. |
| `RUNBOOK-insurer-intake-agent.md` | This runbook. |
| `.env.insurer-intake-agent` | Made on the host from the example. The service and the runtime both read it. |

The four files of the pack are in `deploy/server`. The env file holds two keys and a token. It never enters git, and it has mode 600.

## The memory gate

Before each container start, `MemAvailable` must be at least 1,024 MiB. The gate holds for each of the two containers, and for each container that you create again. Check it with this command:

```sh
awk '/^MemAvailable:/ { mib = int($2 / 1024); word = (mib >= 1024) ? "ok" : "stop"; print word, mib, "MiB available" }' /proc/meminfo
```

Start no container while it prints `stop`. When a start would fail the gate, stop and ask the owner of the host. Do not stop a container of another agent to make room, and do not lower a limit in the compose file. The section "The host" of [README.md](README.md) gives the planning sizes of a runtime and of a service, and what the other agents of the host leave free. Read the real size of each container of the Insurer Intake Agent after its first start (section "The checks"), and write it down.

## The DNS record

Make one A record in the DNS zone of the agents. The record is DNS only, and it points at the public IPv4 address of the host:

- `mp-suppliers-intake.vector.apexfusion.org`

Check the name against a public resolver:

```sh
dig +short mp-suppliers-intake.vector.apexfusion.org A @1.1.1.1
```

The answer must be the address of the host and nothing else. The address of a proxy means that the record is proxied: change it to DNS only. A proxy ends TLS before Caddy, and it replaces the body of an error answer. A refusal of the hook and a job that the runtime cannot finish are error answers with a JSON body, and the buyer needs that body. Caddy gets the certificate of a name when it loads the block of the name, so the record must resolve first.

## The folder

The folder of the Insurer Intake Agent is `/srv/agents/insurer-intake-agent`. It belongs to the service user, `agents`, with mode 750. Make it with `install -d`. Do not use the set-up script of the host: it refuses to run on a host that already runs agents. The first command makes the folder. Run the third command in the folder that holds the files of `deploy/server` (the folder `agents-server` of RUNBOOK.md, step 2):

```sh
sudo install -d -m 750 -o agents -g agents /srv/agents/insurer-intake-agent
sudo stat -c '%a %U:%G %n' /srv/agents/insurer-intake-agent
sudo install -m 644 -o agents -g agents docker-compose.insurer-intake-agent.yml .env.insurer-intake-agent.example /srv/agents/insurer-intake-agent/
```

The output of `stat` must be `750 agents:agents /srv/agents/insurer-intake-agent`.

## The env file

Make the env file as the service user, with mode 600. The service and the runtime both read it:

```sh
sudo -u agents -H bash
cd /srv/agents/insurer-intake-agent
umask 077
cp .env.insurer-intake-agent.example .env.insurer-intake-agent
```

The task `env` makes this file from its example and fills the managed lines. The commands of this section are the manual way.

The keys come from the operator pack, and the key rules of RUNBOOK.md (section "Keys") hold for them. A key is never typed in a shell, and no command here prints one. There are two keys, and the two are different:

- The supplier key goes in the four `SUPPLIER_` lines. It is the key of the runtime. The service reads only the two public lines, `SUPPLIER_PKH` and `SUPPLIER_PUB_KEY_HEX`: the compose file blanks `SUPPLIER_PRIV_KEY_HEX` for the service.
- The service key goes in `INTAKE_SERVICE_PRIV_KEY_HEX`. It pays the model hire of each decision, and it signs the challenges of the dispute code and the request for the JWT-SVID. The operator pack uses this key to sign the agent's claim. The compose file blanks it for the runtime.
- The service key has a line for its key hash after it, `INTAKE_SERVICE_PKH`. The line is public and optional. When it has a value, the service checks it against the key at start.

The two keys have two wallets: the wallet of the supplier key and the wallet of the service key. Each wallet needs two transfers. The first is one pure output of 5 units, alone, as collateral. The second is a float for the fees of its jobs. A wallet that gets both in one transfer can have its collateral merged into change by an ordinary transaction. The wallet of the service key also holds the stake of a challenge, `DISPUTE_CHALLENGE_STAKE_LOVELACE`, while a challenge is open.

Make the token, and write it into the file. The command prints nothing:

```sh
sed -i "s|^SERVICE_AUTH_HEADER=.*|SERVICE_AUTH_HEADER=\"Bearer $(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')\"|" .env.insurer-intake-agent
```

Fill the other lines with an editor:

- `OPERATOR_CONTACT` (the contact address that the live agents publish; the operator types it, and no file of the repository holds it), `AGENT_DID`, `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`. The task `env` takes the contact from the setting `OPERATOR_CONTACT`.
- `VECTOR_MODULE1_MANIFEST`: replace `<commit>` with the 40 hex digits of the commit that the hosted MCP server uses for its own `VECTOR_MODULE1_MANIFEST`.
- `AGENT_ID`: the 64 hex characters of the agent record, the part of `AGENT_DID` after `did:vector:`. `ADVERT_REF` stays empty until the advert exists (section "The start order", step 5).
- `AGENT_STATUS_CHIP` stays `proposed` until the first live run. `FAULT_MODE` stays empty (section "The fault switch").
- Leave every other line as it is. The comments in the example say what each line does.

Then check the file. No command here prints a secret. The first prints the mode and the owner:

```sh
stat -c '%a %U:%G %n' .env.insurer-intake-agent
```

It must print `600 agents:agents .env.insurer-intake-agent`. The next command lists the lines of the file that still hold a placeholder. It prints the line number and the name, never the value. It must print nothing:

```sh
grep -nE '^[A-Z0-9_]+=.*<[^>]*>' .env.insurer-intake-agent | cut -d= -f1
```

This command prints the name of each required line that is empty. It must print nothing:

```sh
for name in SUPPLIER_PRIV_KEY_HEX SUPPLIER_PUB_KEY_HEX SUPPLIER_PKH SUPPLIER_ADDRESS INTAKE_SERVICE_PRIV_KEY_HEX SERVICE_AUTH_HEADER OPERATOR_CONTACT AGENT_DID AGENT_ID MOCK_PUBLIC_BASE MOCK_MTLS_BASE; do
  [ -n "$(sed -n "s/^$name=//p" .env.insurer-intake-agent | tr -d '"')" ] || echo "empty: $name"
done
```

These commands print the length of the value of each key line and of some other lines, never the value:

```sh
awk -F= '/^(SUPPLIER_PRIV_KEY_HEX|SUPPLIER_PUB_KEY_HEX|SUPPLIER_PKH|SUPPLIER_ADDRESS|AGENT_ID|ADVERT_REF)=/ { printf "%s=%d ", $1, length($2) }' .env.insurer-intake-agent; printf '\n'
awk -F= '/^INTAKE_SERVICE_(PRIV_KEY_HEX|PKH)=/ { printf "%s=%d\n", $1, length($2) }' .env.insurer-intake-agent
```

The first line must say `SUPPLIER_PRIV_KEY_HEX=64 SUPPLIER_PUB_KEY_HEX=64 SUPPLIER_PKH=56 SUPPLIER_ADDRESS=58 AGENT_ID=64 ADVERT_REF=0`. After step 5 of "The start order", `ADVERT_REF` has 66 characters. The second command must say `INTAKE_SERVICE_PRIV_KEY_HEX=64`. The key hash line says 56, or 0 when you leave it empty.

The two keys may not be one key. The service stops at start when the service key is the supplier key. This command prints a key hash that stands twice among the two key hash lines. It must print nothing:

```sh
sed -n 's/^\(SUPPLIER\|INTAKE_SERVICE\)_PKH=\(..*\)$/\2/p' .env.insurer-intake-agent | sort | uniq -d
```

## The images

CI builds the service image and reuses [the pinned runtime image](README.md#the-runtime-image). CI publishes both under `:latest` and `:<full git commit sha>`. Use the tag of a reviewed commit with a successful `publish` job. The service image is `ghcr.io/apex-fusion/vector-service-agents/insurer-intake-agent`. The runtime image is `ghcr.io/apex-fusion/vector-service-agents/agent-runtime`.

The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`. RUNBOOK.md (step 6, "Run the mock service") does the same for the mock service.

Pull both images. Put each digest in `docker-compose.insurer-intake-agent.yml`. The `sed` command changes the file only when the digest has 64 characters:

```sh
cd /srv/agents/insurer-intake-agent
REPO=ghcr.io/apex-fusion/vector-service-agents
COMMIT=<full git commit sha>
for image in insurer-intake-agent agent-runtime; do
  docker pull "$REPO/$image:$COMMIT"
  DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$REPO/$image:$COMMIT" | sed 's/^.*@sha256://')
  if [ "${#DIGEST}" = 64 ]; then sed -i -E "s#($image@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" docker-compose.insurer-intake-agent.yml; else echo "no digest for $image: the compose file is not changed"; fi
done
grep -E '^    image: ' docker-compose.insurer-intake-agent.yml
```

The last command must print two `image:` lines with 64 hex digits. If a line still holds `<digest>`, compose refuses to start (`invalid reference format`).

## Check the compose file

First look at the file as compose renders it. Do it in a scratch folder with a stand-in env file, never in the folder of the real env file: the real file holds keys, and `docker compose config` prints the values of the env file into its output.

```sh
scratch=$(mktemp -d)
cp docker-compose.insurer-intake-agent.yml "$scratch/"
cp .env.insurer-intake-agent.example "$scratch/.env.insurer-intake-agent"
(cd "$scratch" && docker compose -f docker-compose.insurer-intake-agent.yml config | grep -E '^name:|image:|container_name:|host_ip:|published:|target:')
rm -r "$scratch"
```

The output must show the project `insurer-intake-agent`, two containers, and each port with `host_ip: 127.0.0.1`. The published ports are 8106 and 9104. The `target: /data` is the volume `intake-state` of the service. No network or build is in the file.

Then check the file with the real env file. This command prints nothing when the file is right. It stops with a message when the env file is missing:

```sh
docker compose -f docker-compose.insurer-intake-agent.yml config --quiet
```

The command does not look at the digests. This one does. It must print `0`:

```sh
grep -c '@sha256:<digest>' docker-compose.insurer-intake-agent.yml
```

## The start order

Run each `docker compose` command as the service user, in `/srv/agents/insurer-intake-agent`.

1. Pass the memory gate (section "The memory gate"). Start the service. This command also makes the network `insurer-intake-agent_default` and the volume `intake-state`:

   ```sh
   docker compose -f docker-compose.insurer-intake-agent.yml up -d service
   ```

2. Wait 30 seconds. Check the service:

   ```sh
   curl -fsS http://127.0.0.1:9104/healthz
   docker logs --tail 20 intake-service
   ```

   The first command prints `{"ok":true}`. The log has the line `[insurer-intake-agent] listening on 0.0.0.0:9104; service address <address>; state directory /data`. The service fetches the Module-1 manifest at start, so the start takes some seconds. If the container starts again and again, the log says why: read the failure table.

3. Join the Caddy container to the network, and add the block of the host name (section "The Caddy block"). The DNS record must resolve to the host first.
4. Check the public name, and take the hash of the manifest (section "The checks"). It is the `detail_hash` of the advert.
5. Post the advert with the task `advert` of the operator pack. It uses the served manifest and the supplier key of the runtime, with the `AGENT_ID` of the agent record. The manual way is the hosted tools of the Vector marketplace. The terms of the advert are:
   - the capability `health.priorauth.intake.v1`;
   - the model `insurer-intake-agent-v1`;
   - the price 2 units, with a supplier bond of 1 unit and a buyer bond of 1 unit;
   - the window 480,000 ms;
   - `endpoint_url`: the origin of the host name, `https://mp-suppliers-intake.vector.apexfusion.org`;
   - `detail_uri`: that origin and `/agent.json`;
   - `detail_hash`: the hash of step 4.

   Run `env` again to write the confirmed `ADVERT_REF`. In the manual flow, set `ADVERT_REF` in `.env.insurer-intake-agent` to the confirmed `<transaction hash>#<output index>`. A change to the manifest needs retirement and a new advert. Use `--replace-advert` with `env` only to set the confirmed replacement. Create the runtime again with `up -d --no-deps --force-recreate runtime` under the restart rule. A runtime with a retired reference refuses with 503 `advert_not_active`.
6. Start the runtime. Pass the memory gate first. After the start, wait 30 seconds, and check that the runtime is up and says `free`:

   ```sh
   docker compose -f docker-compose.insurer-intake-agent.yml up -d --no-deps runtime
   curl -fsS http://127.0.0.1:8106/healthz
   curl -s http://127.0.0.1:8106/status
   ```

   The option `--no-deps` keeps compose from touching the service: a start of the runtime never creates the service again.
7. Run the other checks of section "The checks".

## The checks

Each command only reads. None prints a secret.

1. The two containers answer on the loopback address. Each command prints `{"ok":true}`:

   ```sh
   for port in 8106 9104; do printf '%s: ' "$port"; curl -fsS --max-time 5 "http://127.0.0.1:$port/healthz"; printf '\n'; done
   ```

2. The runtime says `free`. The word `working` means that a job runs:

   ```sh
   curl -s --max-time 5 http://127.0.0.1:8106/status || printf 'no answer'
   ```

3. No container of the Insurer Intake Agent has a public port. The command must print `ok: no public port of the Insurer Intake Agent`:

   ```sh
   docker ps --filter name='^intake-' --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public port of the Insurer Intake Agent'
   ```

   If a port is public, stop the container. Write `127.0.0.1:` before the port in the compose file, and start the container again.

4. The runtime holds no key of the service, and the service holds no supplier key. Each command prints `blank`:

   ```sh
   docker exec intake-runtime sh -c 'test -z "$INTAKE_SERVICE_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   docker exec intake-service sh -c 'test -z "$SUPPLIER_PRIV_KEY_HEX" && echo blank || echo NOT BLANK'
   ```

5. The advert has the hash of the manifest. Run this command from a checkout of this repository, on any machine. It needs no key. It prints one line of JSON with the `detail_uri`, the `detail_hash` and the number of bytes:

   ```sh
   node scripts/manifest-hash.mjs https://mp-suppliers-intake.vector.apexfusion.org
   ```

   After the advert exists, the `detail_hash` of the advert must be this value. If it is not, retire the advert and post a new one with this hash. Then write the new reference into `ADVERT_REF` of `.env.insurer-intake-agent`, and create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). A runtime that keeps the reference of the retired advert refuses every job with 503 `advert_not_active`.

6. The runtime serves its card. The first command prints one JSON document with the interface `https://mp-suppliers-intake.vector.apexfusion.org/v1/job`. The second prints `200`:

   ```sh
   curl -fsS https://mp-suppliers-intake.vector.apexfusion.org/.well-known/agent-card.json
   curl -fsS -o /dev/null -w '%{http_code}\n' https://mp-suppliers-intake.vector.apexfusion.org/
   ```

7. The switch of the service is empty (section "The fault switch"). This agent has no fault value, so the switch is empty in every run.
8. Read the size of each container, and the memory that is left. Write the figures down:

   ```sh
   docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' intake-runtime intake-service
   awk '/^MemAvailable:/ { print int($2 / 1024), "MiB available" }' /proc/meminfo
   ```

## The Caddy block

Caddy runs in a container on the host. `<caddy container>` is the name of that container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`. The block is in `Caddyfile.insurer-intake-agent.snippet`, between the two lines `# insurer-intake-agent vhosts (BEGIN)` and `# insurer-intake-agent vhosts (END)`. It holds one host block. It sends `/agent.json` to `intake-service:9104`, and every other path to `intake-runtime:8080`. The name must be a DNS only record that resolves to the host (section "The DNS record").

Only this way works for this pack. Its upstreams are container names, so only a Caddy container on the network of the project resolves them. A folder of snippets does not fit, and Caddy on the host cannot resolve the names.

1. Join the Caddy container to the network of the project. Compose makes the network when it starts the service. Do it once, and again after each new Caddy container. The second command must list `<caddy container>` and `intake-service`, and also `intake-runtime` after step 6 of "The start order". The network lists the runtime only after that step:

   ```sh
   docker network connect insurer-intake-agent_default <caddy container>
   docker network inspect insurer-intake-agent_default --format '{{range .Containers}}{{.Name}} {{end}}'
   ```

2. Keep a copy of the file, and check that it has no block of the Insurer Intake Agent yet. The second command must print `0`:

   ```sh
   cp -p <caddyfile> <caddyfile>.before-insurer-intake-agent
   grep -c '^# insurer-intake-agent vhosts (BEGIN)$' <caddyfile>
   ```

3. Add the block to the end of the file, in place. Append to the file: do not replace it. The container mounts one file, and a mount follows the inode of that file. A new file that takes its place has another inode, and the container does not see it. Run this in the folder that holds `Caddyfile.insurer-intake-agent.snippet`:

   ```sh
   sed -n '/^# insurer-intake-agent vhosts (BEGIN)$/,/^# insurer-intake-agent vhosts (END)$/p' Caddyfile.insurer-intake-agent.snippet >> <caddyfile>
   ```

4. Validate the whole file in the Caddy container. The answer must say `Valid configuration`. Then reload Caddy:

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   If the validation fails, write the old file back, in place, and read the error:

   ```sh
   cat <caddyfile>.before-insurer-intake-agent > <caddyfile>
   ```

   Do not leave a file that fails to validate on the host. A new Caddy container reads that file, and it does not start with it. Never restart Caddy: a restart cuts the connections that are open. A reload keeps them.
5. Watch the certificate. The log must say `certificate obtained successfully` for the name:

   ```sh
   docker logs --since 5m <caddy container> 2>&1 | grep -E 'certificate obtained|error'
   ```

To replace the block after a change, remove it, and then add it again. To remove it, write the file without the lines from `# insurer-intake-agent vhosts (BEGIN)` to `# insurer-intake-agent vhosts (END)`, in place. Then validate and reload as in step 4:

```sh
sed '/^# insurer-intake-agent vhosts (BEGIN)$/,/^# insurer-intake-agent vhosts (END)$/d' <caddyfile> > caddyfile.new
cat caddyfile.new > <caddyfile>
```

## The restart rule

A runtime keeps its jobs in memory. The service keeps the record of the checks of a job for 300 seconds, and the job slot for 120 seconds after a go of the hook, both in memory. A restart of a container of the Insurer Intake Agent can cut a job under escrow, or lose a record that a job needs (`precheck_missing`). The records on the volume stay: the janitors of the next start reclaim the escrows that a cut job left. A restart during a run is forbidden.

These actions are restarts of a container: `docker restart`, `docker compose restart`, `docker compose up -d --force-recreate`, `docker compose up -d` after a change of an image or of the env file, a reboot of the host and a power-off. These are not restarts: a reload of Caddy, a change of the Caddy block, and the first start of a container.

The service does not say anything about its slot, and a job can start at any time. So every restart has three steps, in this order, and the third follows the second with no pause:

1. Wait 2 minutes after the last job. A go of the hook keeps the slot for 120 seconds. After the wait, no slot is held for a job that has not started.
2. Check that the runtime says `free`. The word `working` means that a job runs: do not restart, wait for the job to end, and begin again at step 1.
3. Run the `up` command at once. Never check first and then wait: a job that starts in a wait after the check is cut.

This command does the three steps without a gap. It waits 2 minutes, checks `/status`, and creates the container only when the runtime says `free`. A container reads its env file when it is created, so use the command after each change of the env file. Use the name of the compose service: `service` or `runtime`:

```sh
sleep 120; if curl -s --max-time 5 http://127.0.0.1:8106/status | grep -q '"status":"free"'; then docker compose -f docker-compose.insurer-intake-agent.yml up -d --no-deps --force-recreate service; else echo 'the runtime does not say free: nothing was restarted'; fi
```

When the command prints the last words, nothing was restarted. Run it again after the job ends. The stop of section "Back out" follows the same three steps.

The runtime says `free` when it holds no job of its own. The service logs the end of each job with the line `job done in <ms> ms`, and a failed job with the line `job failed after <ms> ms` (`docker logs --tail 20 intake-service`). Read the log before a restart when a job may still run.

A change to `SERVICE_AUTH_HEADER` needs the service and the runtime created again, so that the two hold one value. Write `service runtime` in place of `service` in the command: one command creates both. A new image is a restart too: pin it as in section "The images", and create only the containers that use it, with the same command.

A stop of the service waits up to 300 seconds for the job that runs. Compose waits 330 seconds before it kills the container: the 30 seconds more are for the service to log a job that it abandoned, and to exit. The 330 seconds cover that wait only. A job runs up to 300,000 ms, so never stop the service while the runtime says `working`. A runtime has the default grace period of 10 seconds, so never stop a runtime that says `working`.

Never restart Caddy. Reload it (section "The Caddy block").

## The fault switch

The Insurer Intake Agent has no fault value. `FAULT_MODE` in `.env.insurer-intake-agent` must be empty, in every run. The service reads it one time, when it starts. A service that starts with any value refuses: the start stops, and the log says why (section "The failure table"). A failure run of use case 2 sets a fault value on the Prior Authorization Agent only. This agent still shows an empty switch.

The clean-run check reads the switch from the running container, never from the file. The command prints the value between brackets and prints nothing else:

```sh
docker exec intake-service sh -c 'printf "FAULT_MODE=[%s]\n" "$FAULT_MODE"'
```

A clean run needs `FAULT_MODE=[]`, and so does every other run of this agent. Do this check before each run. Any other output means that the env file or the compose file changed: make the line empty again, and create the service again with the command of section "The restart rule". An env change needs a new container: a restart does not read the file. The runtime does not read the switch, so the service is the one container to create again.

The result of every job carries the member `fault_mode`. It is the empty text.

## The failure table

A failed start of the service or of the runtime shows in `docker ps` as `Restarting`. Read `docker logs --tail 20 intake-service` or `docker logs --tail 20 intake-runtime`. The service prints `[insurer-intake-agent] cannot start:` and a message. The message names the variable and never shows its value.

This agent is a counterparty. A refusal of the hook comes before the Claim, and it leaves the escrow open: the buyer reclaims it. A failure of the job comes after the Claim. Both answer with a status and a code, and not with a `reason` in a 200 result.

| Symptom | Cause | Action |
|---|---|---|
| `invalid reference format` for an image | A placeholder `<digest>` is still in the compose file. | Pin the images (section "The images"). |
| `denied` on `docker pull` | The package is private. | Make the package public, or log in to `ghcr.io` with a token that has the scope `read:packages`. |
| Compose says that the env file is not found | The env file is missing, or compose runs in another folder. | Make the file from its example (section "The env file"). Run compose in `/srv/agents/insurer-intake-agent`. |
| A start fails with a port that is allocated or in use (8106 or 9104) | Another program holds the port. | Find it with `ss -ltnp`. Do not change a port: the Caddy block, the runbook and the guard test name these ports. |
| `[insurer-intake-agent] cannot start: environment variable INTAKE_SERVICE_PRIV_KEY_HEX is required`, or `must be 64 lowercase hex characters` | The key line of the service is empty or wrong. | Write the key with a command that prints nothing (section "The env file"). |
| `... holds the service key, which belongs in INTAKE_SERVICE_PRIV_KEY_HEX alone`, or `... holds the service token, which belongs in SERVICE_AUTH_HEADER alone` | The key or the token stands in another line too. The message names that line and does not show the value. | Take it out of the line that the message names. |
| `... INTAKE_SERVICE_PKH (56 characters) is not the key hash of the key in INTAKE_SERVICE_PRIV_KEY_HEX` | The key hash line does not belong to the key before it. | Correct the line, or leave it empty. |
| `... holds the key of SUPPLIER_PKH: the supplier key is the runtime's` | The service key is the supplier key. | Make a key of its own for the service. The supplier key belongs to the runtime. |
| `... SERVICE_AUTH_HEADER is required`, or `must be printable ASCII` | The token line is empty, or it holds a character that a header cannot carry. | Make the token again (section "The env file"). Create the service and the runtime again with the command of section "The restart rule", with `service runtime` as the names. |
| `... SUPPLIER_PUB_KEY_HEX is not the public key of SUPPLIER_PKH` | The two lines come from two keys, or a private key is in the line of the public key. | Copy both values from the key of the runtime. |
| `... AGENT_DID is required`, or `... must be did:vector: and 64 lowercase hex characters` | The DID line is empty or has the wrong form. | Write `did:vector:` and the 64 hex characters of the agent record. |
| `... MOCK_PUBLIC_BASE must be an https origin`, or `... MOCK_MTLS_BASE must name another host than MOCK_PUBLIC_BASE` | A placeholder is still in the line, or the two origins name one host. | Write the origin of the mock host and the origin of the mock mtls host. |
| `... VECTOR_MODULE1_MANIFEST must be an https URL` | The line holds a file path, an http address, or an address with a user, a password, a query or a fragment. | Write the https address as the example has it. |
| `... VECTOR_MODULE1_MANIFEST must be pinned to a commit` | The placeholder `<commit>` is still in the line, or the address names a branch or a tag. | Write the 40 hex digits of the commit that the hosted MCP server uses. |
| `The Module-1 manifest (VECTOR_MODULE1_MANIFEST)` cannot be fetched | The host cannot reach the address, or the commit has no manifest at that path. | Check that the host reaches the address with `curl -sSI`. Write the commit that the hosted MCP server uses. |
| `the Module-1 manifest names the identity registry ...` | The manifest at that commit is for another identity registry than `IDENTITY_POLICY_ID`. | Use the commit of the manifest of that registry. |
| `... IDENTITY_POLICY_ID is not the identity policy that VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED give` | One of the three published values is wrong. | Copy the three values from the example. |
| `... VECTOR_OGMIOS_URL must be an https address` | The line holds an http address. The janitor reads the tip of the node with an https address only. | Empty the line, or write an https address. |
| `... INTAKE_STATE_DIR names /data, which cannot be written` | The volume is not writable for the user `node`. | Run `docker volume inspect intake-state`. A new volume that is empty can be removed. A volume that holds records is not removed: make its data belong to `node`. |
| `... FAULT_MODE must be empty (insurer-intake-agent has no fault value)` | The switch holds a value. This agent has none. | Empty the line, and create the service again (section "The fault switch"). |
| `... ADVERT_MAX_PROCESSING_MS must be at least 480000` | The window line is under the deadline of a job. | Write 480000, as the example has it. |
| `... CHECKS_READ_BUDGET_MS must be a whole number of milliseconds from 500 to 1499` | The budget of a read of the hook is out of its range. Six reads must stay under 9,000 ms. | Write 1200, as the example has it. |
| `... LLM_MODEL_ALLOWLIST is required`, or `... must be a whole number of lovelace of more than 0` (the same for each line of `LLM_MAX_` and `DISPUTE_CHALLENGE_STAKE_LOVELACE`) | A limit line is empty or wrong. The service never fills in a limit. | Write the value of the example. |
| A runtime starts again and again, and its log says `loadConfig: missing required env var ADVERT_REF` | The runtime started before its advert existed. It never boots, so it holds no job. | Stop it with `docker compose -f docker-compose.insurer-intake-agent.yml stop runtime`. Finish step 5 of "The start order". |
| A runtime log says `loadConfig: PUBLIC_ORIGIN must be an https origin` | The compose file was changed. | Write the origin of the host name, as the compose file has it. |
| Caddy answers 502 for the host name | The Caddy container is not on the network, or a container of the Insurer Intake Agent is down. | Check with `docker network inspect insurer-intake-agent_default ...` (section "The Caddy block") and `docker ps`. Join the network again. |
| Caddy gets no certificate for the name | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (section "The DNS record"). Read the log of the Caddy container. |
| The hash of `/agent.json` is not the `detail_hash` of the advert | A setting of the manifest changed after the advert was posted: an env line of the service, the image or the status word. | Retire the advert. Post a new advert with the hash that is served now. Write its reference into `ADVERT_REF` of `.env.insurer-intake-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `advert_not_active` (503) | The runtime holds the reference of an advert that is retired or not active, so it refuses every job. | Post a new advert when none is active. Write the reference of the active advert into `ADVERT_REF` of `.env.insurer-intake-agent`. Create the runtime again with `up -d --no-deps --force-recreate runtime` (section "The restart rule"). |
| `precheck_failed` (503) | The service answered the runtime with 401 `unauthorized`: the two containers were created from two versions of `SERVICE_AUTH_HEADER`. The log of the runtime says that the service refused the token. | Create the service and the runtime again with the command of section "The restart rule", with `service runtime` as the names. |
| `precheck_timeout` or `precheck_unreachable` (503) | The service gave no answer to the hook in 10 seconds, or the runtime could not connect to `intake-service:9104`. | Check `docker ps`, `docker logs --tail 20 intake-service` and `/healthz` on port 9104. |
| `precheck_bad_status` (502) | The service answered with a redirect, or with a status that the runtime does not read. | Read the log of the service. |
| `busy` (409) | The service works on a job, or it keeps its slot for another escrow for up to 120 seconds. | Wait. Nothing to fix. The buyer sends the call again. |
| `supplier_busy` (409) | The runtime works on a job itself. | Wait. Nothing to fix. |
| `shutting_down` (503) | The service is stopping: it takes no new job. | Wait for the start. Check `docker ps` and the log of the service. |
| `bad_context` (400) | The call has none, some, or a bad one of the six context headers. A runtime that runs the image of CI sends all six. | Check that the runtime runs the runtime image of the compose file, and not an older build. |
| `bad_wire`, `request_too_large` or `bad_shape` (400) | The request is not the wire message, it is over 1,000,000 bytes, or it is no handoff of use case 2 with an authorization request. | Nothing on the host. The buyer fixes its request. |
| `sender_not_active`, `sender_unaccountable` or `sender_key_mismatch` (403, before the Claim) | The sender is not an active agent, it has no accountable party in force, or its key is not the key that paid. | Nothing on the host. The escrow stays open, and the buyer reclaims it. The buyer fixes its side. |
| `delegation_invalid`, `delegation_ended` or `not_vault_paid` (403, before the Claim) | The delegation does not name the sender, the delegation ended, or the escrow was not paid from a vault of the delegation. | Nothing on the host. The escrow stays open, and the buyer reclaims it. |
| `approval_not_found`, `approval_wrong_type`, `approval_wrong_subject`, `approval_wrong_issuer`, `approval_revoked`, `approval_expired` or `approval_issuer_invalid` (403, before the Claim) | The provider has no valid approval for this request. | Nothing on the host. The escrow stays open, and the buyer reclaims it. |
| `approval_digest_mismatch` (403, before the Claim) | The approval is for another request than the one that arrived. The service answers first, and then it starts a challenge against the open claim of the sender, in the background. | Read the lines of the challenge in `docker logs intake-service`. The challenge needs its stake in the wallet of the service key (`DISPUTE_CHALLENGE_STAKE_LOVELACE`). The escrow stays open. |
| `not_for_this_insurer` (403, before the Claim) | The request names another insurer than the DID of this agent. | Nothing on the host, unless every request gets it: check `AGENT_DID`. |
| `advert_mismatch` (403, before the Claim) | The request names another advert than the advert that the escrow was posted on. | Nothing on the host, unless every request gets it: check the advert and `ADVERT_REF`. |
| `duplicate_request` (403) | The intake book already holds an entry for the request number of the tenant (a refusal of the hook, before the Claim), or the insurer portal already holds one (a failure of the job, after the Claim). | Nothing: the agent files one entry for each request number. The sender uses a new number. |
| `check_unavailable` (503, before the Claim) | A check could not read its source in time: the identity gateway, the ledger or the intake book. The escrow stays open. | Read the line `the hook could not read the <source>` in the log. Check that the host reaches the gateway, the node and the indexer, and that `requests.json` is in the volume. |
| `precheck_missing` (500, after the Claim) | The job had no record of its check for this request: the service restarted between the hook and the job, or the job came more than 300 seconds after the hook. | Never restart during a run. The escrow stays Claimed, and the buyer reclaims it after the deadline. |
| `svid_failed` (502, after the Claim) | The identity gateway gave no JWT-SVID for the service key. | Check that the key of the service is a key of the agent record, that the record names the insurer organisation of the tenant, and that the host reaches the gateway. |
| `mock_system_failed` (502, after the Claim) | The insurer portal of the mock systems did not take the call: it refused, it failed, or its answer could not be read. | Check `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`, the tenant, and the mock service. The log of the service has the code of the portal. |
| `inference_failed` or `model_output_invalid` (502, after the Claim) | The hire of the model for the decision failed, or the model gave no valid answer. | Read the log line. Check the wallet of the service key: it needs its collateral and a float. |
| `store_write_failed` (500, after the Claim) | The service could not write the intake book (`requests.json`), the journal of the dispute code or the record of the model hires. | Check the volume `intake-state` and the disk. |
| `deadline` (422, after the Claim) | The job ran out of its 300,000 ms, the buyer hung up, or the job had too little time left to file. | Read the log line of the job. Nothing to fix when it happens once. |
| `internal` (500, after the Claim) | A fault in the service. | Report it with the log line of the job (`insurer intake: <code>: <reason>`). |

## Back out

To take the Insurer Intake Agent out of service. The order matters: the advert goes first, so that nobody can post an escrow against an agent that goes away.

1. Retire the advert. The operator does it with the hosted tools, signed with the supplier key of the runtime. Skip this step when `ADVERT_REF` is empty in the env file: nothing was posted.
2. Wait 2 minutes after the last job. Then check that the runtime says `free`, and stop the containers at once. Never check first and then wait. The command does the three steps without a gap. A job that was claimed before the retire still runs: when the runtime says `working`, nothing is stopped. Let the job end, and run the command again. Compose waits up to 330 seconds for the service:

   ```sh
   sleep 120; if curl -s --max-time 5 http://127.0.0.1:8106/status | grep -q '"status":"free"'; then docker compose -f docker-compose.insurer-intake-agent.yml stop; else echo 'the runtime does not say free: nothing was stopped'; fi
   ```

3. Remove the Caddy block, as section "The Caddy block" says. Validate and reload Caddy.
4. Leave the network of the project before the `down` command, because the Caddy container is on it. Do not use `-v`:

   ```sh
   docker network disconnect insurer-intake-agent_default <caddy container>
   docker compose -f docker-compose.insurer-intake-agent.yml down
   ```

5. Keep the volume `intake-state`: it holds the escrows of the service key, the journal of the dispute code and the intake book. Keep the env file too. Delete a key file only when its wallet is empty: a key that is deleted cannot be made again.
6. Remove the DNS record when nobody uses the name again.
