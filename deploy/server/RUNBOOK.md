# Runbook: set up the agents host

This runbook tells the operator what to do, in order. [README.md](README.md) gives the facts: the files, the host, the ports, the DNS records and the mock host names.

The operator has SSH access to the new host, as a user that can become root. The operator does every step.

Three rules hold for every step:

- Never run a step on the present host. The script refuses there and changes nothing.
- A runtime keeps its jobs in memory. Never restart a runtime, Docker or the host while a job runs (section "The restart rule").
- No command in this runbook prints a key. Never add one that does.

## 1. Get the host

1. Order one host: 8 GiB of memory, 4 CPUs and 80 GB of disk. Use Ubuntu 22.04 or 24.04, or Debian 12. Use the provider and the region of the present host.
2. Write down the public IPv4 address of the host. It is `<host address>` below.
3. If the provider has a firewall of its own, open TCP 22, 80 and 443 in it. The script sets the firewall of the host, not the one of the provider.

## 2. Put the files on the host

On the operator's machine, in a checkout of this repository:

```sh
scp -r deploy/server <ssh user>@<host address>:agents-server
ssh <ssh user>@<host address>
```

## 3. Run the script

On the host, as root (`sudo` or a root login):

```sh
cd agents-server
sudo ./setup.sh <agent> <agent>
```

`<agent>` is the name of one agent. Use the names that the deploy packs of the agents use. A name has lower case letters, digits and hyphens. The names are optional.
The script makes one folder for each name, in `/srv/agents`.

Read the output. Each line starts with `setup:`. A line says `changed` or `unchanged`. The last lines give the result and the versions.
On the first run, many lines say `changed`.

If the script stops, read the error. Fix the cause and run the script again. A second run is safe.
If the script says `refused: this host runs the agents of the present host`, you are on the wrong host. Nothing changed. Stop here.

Run the script a second time with the same names. The result line must say `0 changed`.

## 4. Check the host

These commands only read. None prints a secret.

```sh
systemctl is-active docker caddy
docker info --format 'live-restore={{.LiveRestoreEnabled}} log-driver={{.LoggingDriver}}'
sudo ufw status verbose
ss -ltnH | awk '{print $4}' | grep -Ev '^(127\.|\[::1\]:)' | grep -Ev ':(22|80|443)$' || echo 'ok: no other public listener'
sudo stat -c '%a %U:%G %n' /srv/agents /srv/agents/keys /srv/agents/mock-systems
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
timedatectl show --property=NTPSynchronized --value
free -m | sed -n 2p
df -h / | sed -n 2p
```

| Command | Expected |
|---|---|
| `systemctl is-active` | `active` two times |
| `docker info` | `live-restore=true log-driver=json-file` |
| `ufw status verbose` | `Status: active`, `Default: deny (incoming), allow (outgoing)`, and the rules 22/tcp, 80/tcp and 443/tcp, each for IPv4 and IPv6 |
| `ss` | `ok: no other public listener` |
| `stat` | `750 agents:agents /srv/agents`, `700 agents:agents /srv/agents/keys`, `750 agents:agents /srv/agents/mock-systems` |
| `caddy validate` | `Valid configuration` |
| `timedatectl` | `yes`. Tokens and certificates depend on the clock. |
| `free` and `df` | About 8 GiB of memory. At least 40 GB of free disk. |

## 5. Make the DNS records

Make the records of the README (section "DNS") in the DNS zone. Every A record is DNS only and points at `<host address>`.

Check each name against a public resolver:

```sh
dig +short <agent host name> A @1.1.1.1
```

The answer must be `<host address>` and nothing else. The address of a proxy means that the record is proxied. Change it to DNS only.
Wait for the answer before you go on. Caddy asks for the certificate of a name when it loads the snippet of the name. A name that does not resolve to the host fails, and Caddy tries again later.

## 6. Install the snippet of the mock systems

Set the two names. Replace the two placeholders in a copy of the snippet. Check that none is left:

```sh
cd agents-server
MOCK_HOST=<mock host>
MOCK_MTLS_HOST=<mock mtls host>
sed -e "s|<mock-host>|$MOCK_HOST|g" -e "s|<mock-mtls-host>|$MOCK_MTLS_HOST|g" Caddyfile.mock-systems.snippet > mock-systems.snippet
if grep -qF -e '<mock-host>' -e '<mock-mtls-host>' mock-systems.snippet; then echo 'a placeholder is left'; else echo 'ok'; fi
```

The last command must print `ok`. Then install the copy, check the whole configuration, and reload Caddy:

```sh
sudo install -m 644 -o root -g root mock-systems.snippet /etc/caddy/agents/mock-systems.snippet
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

`caddy validate` reads every snippet in `/etc/caddy/agents`. If it fails, remove the new file and read the error. Caddy keeps its old configuration until a reload succeeds.

Caddy now gets a certificate for each of the two names. Watch it, and read the result:

```sh
sudo journalctl -u caddy --since '5 minutes ago' --no-pager | grep -E 'certificate obtained|error'
curl -sSI https://<mock host>/ | head -n 1
```

The log must say `certificate obtained successfully` for each name. The `curl` answer is `502` until the mock service runs. Then it is the answer of the service.
The behaviour of the `Client-Cert` header is proven locally with `prove-mock-mtls.mjs` (README, section "The local proof").

Run the mock service next. The sections below give the steps to run it and the steps to use it.

### Run the mock service

The mock service is one container. Its compose file and its env file stay in `/srv/agents/mock-systems`. It keeps its tenants in memory. It has no volume, no key and no wallet (README, section "The mock service").
Do these steps after the snippet is installed.

1. Put the two files in the folder. Run this as the SSH user:

   ```sh
   cd agents-server
   sudo install -m 644 -o agents -g agents docker-compose.mock-systems.yml .env.mock-systems.example /srv/agents/mock-systems/
   ```

2. Open a shell as the service user. Make the env file from the example, with mode 600. The next steps run in this shell:

   ```sh
   sudo -u agents -H bash
   cd /srv/agents/mock-systems
   umask 077
   cp .env.mock-systems.example .env.mock-systems
   ```

3. Make the operator token. The command writes the token into the env file and prints nothing:

   ```sh
   sed -i "s|^MOCK_OPERATOR_TOKEN=.*|MOCK_OPERATOR_TOKEN=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)|" .env.mock-systems
   ```

4. Fill the other five lines with an editor: `MOCK_PUBLIC_BASE`, `MOCK_MTLS_BASE`, `VECTOR_IDENTITY_LEGACY_ROOT`, `VECTOR_IDENTITY_CONFIG_SEED` and `VECTOR_IDENTITY_POLICY_ID`. Leave every other line as it is.
   The first two lines hold the two names of step 6 as https origins: `https://<mock host>` and `https://<mock mtls host>`, with no path and no slash at the end.
   The last three lines hold the values that the identity registry deployment on Vector mainnet published on 2026-11-03. The comment above them in the file says where the agents hold the same values.
   Then check the file. No command here prints a secret:

   ```sh
   stat -c '%a %U:%G %n' .env.mock-systems
   grep -E '^(MOCK_PUBLIC_BASE|MOCK_MTLS_BASE|VECTOR_IDENTITY_[A-Z_]+)=<' .env.mock-systems || echo 'ok: no placeholder is left'
   sed -n 's/^MOCK_OPERATOR_TOKEN=//p' .env.mock-systems | grep -Eq '^[A-Za-z0-9._~+/=-]{32,128}$' && echo 'ok: the token has the right form' || echo 'the token is missing or has a wrong form'
   ```

   The output must be `600 agents:agents .env.mock-systems`, then `ok: no placeholder is left`, then `ok: the token has the right form`.

5. Pull the image, and put its digest in the compose file. CI pushes the image under `:latest` and `:<full git commit sha>`. Use the tag of a reviewed commit with a successful `publish` job. The pull needs no login when the package is public. If the answer says `denied`, the package is private: make it public in the settings of the package, or log in to `ghcr.io` with a token that has the scope `read:packages`.

   ```sh
   IMAGE=ghcr.io/apex-fusion/vector-service-agents/mock-systems
   docker pull "$IMAGE:<full git commit sha>"
   DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:<full git commit sha>" | sed 's/^.*@sha256://')
   [ "${#DIGEST}" = 64 ] && sed -i -E "s#(mock-systems@sha256:)(<digest>|[0-9a-f]{64})#\1$DIGEST#" docker-compose.mock-systems.yml || echo 'no digest: the compose file is not changed'
   grep -E '^    image: ghcr[.]io/apex-fusion/vector-service-agents/mock-systems@sha256:[0-9a-f]{64}$' docker-compose.mock-systems.yml
   ```

   The `sed` command changes the file only when the digest has 64 characters. The last command must print the `image:` line with 64 hex digits. If it prints nothing, the placeholder `<digest>` is still in the file, and compose refuses to start (`invalid reference format`).

6. Start the container. This is the first start, so it is not a restart:

   ```sh
   docker compose -f docker-compose.mock-systems.yml up -d
   ```

7. Wait 30 seconds. Then check the service. Each command only reads:

   ```sh
   curl -fsS http://127.0.0.1:9120/healthz
   docker ps --filter name='^mock-systems$' --format '{{.Names}} {{.Status}} {{.Ports}}'
   curl -sS -w '\n%{http_code}\n' https://<mock host>/t/none/state
   curl -sS -w '\n%{http_code}\n' https://<mock mtls host>/t/none/state
   ```

   | Command | Expected |
   |---|---|
   | `curl` on `127.0.0.1:9120` | `{"ok":true}` |
   | `docker ps` | `mock-systems Up <time> (healthy)`, and the port column has `127.0.0.1:9120->9120/tcp`. The state can be `(health: starting)` for the first 20 seconds. No port may start with `0.0.0.0` or `[::]`. |
   | The call to `<mock host>` | `404` and `tenant_not_found`. The call passed Caddy and reached the service, and `MOCK_PUBLIC_BASE` names this host. |
   | The call to `<mock mtls host>` | `421` and the words `not on the client-certificate host`. `MOCK_MTLS_BASE` names this host. |

   A `502` means that Caddy does not reach the service. Read the failure table.

### Make or reset a tenant

A tenant is one set of mock systems with its own data and its own log. It has a name and two organisations: the supplier and the insurer. This call makes a tenant. It also resets one: a tenant that exists is made again from the seed, and its writes and its log are gone.

The call needs the operator token. The commands read it from the env file. They do not print it, and they do not put it in the arguments of a program. Run them as the service user:

```sh
cd /srv/agents/mock-systems
token=$(sed -n 's/^MOCK_OPERATOR_TOKEN=//p' .env.mock-systems)
curl -sS --max-time 30 --header @<(printf 'Authorization: Bearer %s\n' "$token") --header 'Content-Type: application/json' \
  --data '{"tenant":"demo-1","organisations":{"supplier":"supplier.example.org","insurer":"insurer.example.org"}}' \
  https://<mock host>/admin/tenants
token=
```

The body has two fields:

- `tenant`: the name of the tenant. It has 1 to 48 lower case letters, digits and hyphens, and it starts with a letter or a digit. It is a part of every URL of the tenant.
- `organisations`: the two organisations of the tenant. `supplier` is the organisation domain that the record of an agent must name to call with an X.509-SVID. `insurer` is the same for a JWT-SVID. Each is a domain name in lower case with at least two labels.

The call has a third field, `seed`. It replaces whole parts of the default data: the stock, the catalogue, the records, the guidelines, the requirements and the vendors. Leave it out, and the tenant gets the default data.

The answer is `201` for a new tenant and `200` for a tenant that was made again (`"created":false`). The body lists the URL of each system of the tenant (`resources`) and the audience for JWT-SVIDs (`audiences`). A token must name one of these URLs exactly.
The service holds 100 tenants at most. The 101st name gets `409`. No call removes a tenant. To make room, restart the service, which loses every tenant.

### Read the state and the log of a tenant

Two routes only read. They need no credential. Run them from any machine:

```sh
curl -sS https://<mock host>/t/demo-1/state
curl -sS https://<mock host>/t/demo-1/log
```

Read the log of the container on the host, as the service user:

```sh
docker logs --tail 20 mock-systems
```

- `state` gives the data of the tenant: the seed data and every write that a caller made.
- `log` gives the last 5000 calls to the systems of the tenant: the route, who made the call, the decision and the rule that refused it. `dropped` counts the older lines that the service removed.
- `docker logs` gives the log of the container: one line of JSON for each call, for every tenant, except `GET /healthz`. It also has the lines of the start and the stop. No line has a token, a proof or a certificate.

### What a restart loses, upgrade and stop

The service keeps every tenant and its log in memory. A restart loses all of them. These actions are restarts of the mock service: `docker restart`, `docker compose restart`, `docker compose up --force-recreate`, a new image, a new env file, a reboot of the host, and a stop by the memory limit.
After a restart, make each tenant again with the call above. Until then, a call to the tenant gets `404` and `tenant_not_found`. The service holds no job, so no check must say `free` first. Tell the people who use the tenants before you restart.

To upgrade, run steps 5 and 6 again with the tag of the new commit. The `sed` command replaces the old digest. `docker compose up -d` sees the new image and creates the container again. This is a restart, so it loses every tenant. Check the service (step 7), and make each tenant again.
After a change to the env file, create the container again. `restart` does not read the file:

```sh
docker compose -f docker-compose.mock-systems.yml up -d --force-recreate mock-systems
```

To stop the service, run the next command. The tenants are lost, and there is no volume to keep. Callers get `502` from Caddy until the service runs again:

```sh
docker compose -f docker-compose.mock-systems.yml down
```

## 7. Add an agent

The deploy pack of an agent has its compose file, its env example, its snippet and its own runbook. The packs of use case 1 (inventory reorder) are the Reorder Agent, with `RUNBOOK-reorder-agent.md`, and the Order Desk, with `RUNBOOK-order-desk.md`. The packs of use case 2 (prior authorization) are the Prior Authorization Agent, with `RUNBOOK-prior-authorization-agent.md`, and the Insurer Intake Agent, with `RUNBOOK-insurer-intake-agent.md`. They fit the marker block only: their upstreams are container names, and Caddy on the host cannot resolve them. The runbook of each pack of use case 1 says which tasks of the operator pack make the keys, the records, the stakes, the env files and the advert. README.md, section "The operator image", describes the pack. The runbooks of the other packs give the keys, the registration and the advert. These steps are only for the host.

1. Make the DNS record of each host name of the agent (step 5). Wait until it resolves to `<host address>`.
2. Make the folder of the agent. Use the name of the agent:

   ```sh
   cd agents-server
   sudo ./setup.sh <agent>
   ```

3. Put the compose file and the env example of the agent in `/srv/agents/<agent>`. Make the env file as the service user, with mode 600:

   ```sh
   sudo -u agents -H bash
   cd /srv/agents/<agent>
   umask 077
   cp <env example> <env file>
   ```

   Fill the env file as the runbook of the agent says. Make each key as the section "Keys" says.
4. Start the containers as the runbook of the agent says: the service first, then the runtime. Run `docker compose` as the service user, in the folder of the agent.
5. Check each container on the loopback address. The runtime port is in the range 8101 to 8110, and the service port is in the range 9101 to 9108:

   ```sh
   curl -s http://127.0.0.1:<runtime port>/healthz
   docker ps --format '{{.Names}} {{.Ports}}' | grep -E '0\.0\.0\.0:|\[::\]:' && echo 'PUBLIC PORT FOUND' || echo 'ok: no public container port'
   ```

   The second command must print `ok: no public container port`. If a container port is public, stop the container. Write `127.0.0.1:` before the port in the compose file. Start the container again.
6. Put the block of the agent in the proxy. There are two ways. Use the one that fits the host, and use only that one:
   - Snippet folder. Caddy runs on the host (the set-up of this runbook), and the upstreams of the snippet are ports on `127.0.0.1`. The packs of use case 1 do not fit this way. The packs of use case 2 do not fit this way either. Install the snippet of the agent as `/etc/caddy/agents/<agent>.snippet`, as in step 6. Check the whole configuration and reload Caddy.
   - Marker block. Caddy runs in a container, and it mounts one Caddyfile (README, section "A host whose proxy runs in a container"). The packs of use case 1 use this way only. The packs of use case 2 use this way only. Join the Caddy container to the network of the project of the agent. Append the lines of the snippet, from its BEGIN marker to its END marker, to the Caddyfile, in place. Validate the whole file in the Caddy container, and reload Caddy. The runbook of the pack gives the commands, in its section "The Caddy block".
7. Check the public name:

   ```sh
   curl -sS https://<agent host name>/healthz
   ```

## 8. Remove an agent

1. The operator retires the advert first, as the runbook of the agent says. Then nobody can post an escrow against an agent that stops.
2. Check that the runtime says `free` (section "The restart rule"). Wait while it says `working`.
3. Take the block of the agent out of the proxy, and stop the containers. The order depends on the way that put the block in. Do not use `-v` when you stop the containers. A volume can hold the list of escrows that a job left behind.
   - Snippet folder. Stop the containers first. Then remove the snippet, check the configuration and reload Caddy:

     ```sh
     sudo -u agents -H bash -c 'cd /srv/agents/<agent> && docker compose -f <compose file> down'
     sudo rm /etc/caddy/agents/<agent>.snippet
     sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
     sudo systemctl reload caddy
     ```

   - Marker block. Take the block out first. Write the Caddyfile again without the lines from the BEGIN marker to the END marker, in place. Validate the whole file in the Caddy container, and reload Caddy. Leave the network of the project before the `down` command, because the Caddy container is on it. Then stop the containers:

     ```sh
     docker network disconnect <project>_default <caddy container>
     sudo -u agents -H bash -c 'cd /srv/agents/<agent> && docker compose -f <compose file> down'
     ```

     The runbook of the pack gives the commands, in its section "Back out".
4. Remove the DNS records of the agent.
5. Keep `/srv/agents/<agent>` and its keys. Delete them only when each wallet of the agent is empty. A deleted key cannot be made again.

## Keys

- Make each key on this host. Never make a key on another machine.
- Make a key as the service user, in `/srv/agents/keys`, with `umask 077`. A key file has mode 600.
- Use a command that writes the key to a file. Never use a command that prints the key.
- Never copy a key to a chat, a repository, a log, a terminal record or a backup that leaves the host.
- An env file that holds a key belongs to `agents` and has mode 600.
- The key never leaves the host. Nobody signs on another machine.
- The script makes no key and reads no key.
- The task `keys` of the operator pack makes the keys on this host. It never prints a key.
- Do not delete a key file while its wallet holds funds. Deleting the host deletes every key on it. Empty every wallet first.

## The restart rule

A runtime keeps its jobs in memory. A restart stops every job that runs. A job under escrow can then fail for the buyer. A restart during a run is forbidden.

These actions are restarts: `docker restart`, `docker compose restart`, `docker compose up --force-recreate`, `systemctl restart docker`, a reboot and a power-off.
These are not restarts: `systemctl reload caddy`, a change of a snippet, and `docker compose up -d` for a new agent.

Before a restart, check each runtime. Each runtime that runs must say `free`:

```sh
for port in $(seq 8101 8110); do printf '%s: ' "$port"; curl -s --max-time 5 "http://127.0.0.1:$port/status" || printf 'no answer'; printf '\n'; done
```

A runtime that says `working` holds a job. Wait and check again. An env file is read only when a container is created. After a change, recreate the container, and only when the runtime says `free`.

Never restart Caddy. Reload it. A restart cuts the connections that are open.

The script follows the same rule. It never restarts Docker while a container runs. If `daemon.json` changes, it prints `pending`. Restart Docker when each runtime says `free`.

The mock service holds no job, so this check does not cover it. It keeps its tenants in memory. These actions lose them: `docker restart`, `docker compose restart`, `docker compose up --force-recreate`, a reboot and a power-off. So does a new image or a new env file. A restart of the Docker daemon keeps the container (live-restore), so it keeps the tenants. After a loss, make each tenant again (step 6, "Make or reset a tenant").

## Upgrade the host

1. Check that each runtime says `free`.
2. Check that `docker info --format '{{.LiveRestoreEnabled}}'` says `true`. A restart of the Docker daemon then keeps the containers.
3. Run `sudo apt-get update` and `sudo apt-get upgrade`. A package upgrade can restart `docker.service`.
4. A reboot stops every container. Reboot only when each runtime says `free`. If the compose file sets `restart: unless-stopped`, the containers start again. Their jobs are lost. The mock service starts again with no tenant: make each tenant again (step 6, "Make or reset a tenant").

## The failure table

| Symptom | Cause | Action |
|---|---|---|
| `refused: this host runs the agents of the present host` | The script runs on the wrong host. | Nothing changed. Use the new host. |
| `refused: another program holds TCP 80 or 443` | Another web server or a container uses the port. | Stop or remove it. Run the script again. |
| `refused: this SSH session uses port N` | The firewall opens port 22 only, and the session would end. | Connect on port 22. Run the script again. |
| `refused: the key from <url> does not have the fingerprint` | The vendor changed its key, or the download is not the vendor key. | Check the fingerprint on the web site of the vendor. If the vendor changed it, change the pin in the script. |
| `refused: these packages conflict with Docker Engine` | The host has the Ubuntu or Debian Docker packages. | Remove the packages that the message names. Run the script again. |
| `stopped (exit 100)` with an `E:` line | `apt` failed. A common cause is a lock held by an update that runs at first boot. | Read the `E:` line. Wait a minute. Run the script again. |
| `refused: caddy validate stops on ...` | A snippet in `/etc/caddy/agents` is wrong. | Fix or remove the snippet. Run `caddy validate`. |
| Caddy does not get a certificate | The name does not resolve to the host, the record is proxied, or TCP 80 is closed. | Check the record (step 5) and the provider firewall. Read `journalctl -u caddy`. |
| The `ss` check lists a public port | A container binds a port to a public address, or a program listens on it. | Find the program with `ss -ltnp`. For a container, write `127.0.0.1:` before the port in the compose file. |
| `pending: daemon.json changed` | The script did not restart Docker, because containers run. | Restart Docker when each runtime says `free`. |
| A request to the mock host gets `421`, and the body has no `wrong_host` | The TLS name and the Host header differ. Caddy refuses this on the client-certificate host. | Send the request with the same name in the TLS handshake and in the Host header. |
| The mock service sees no `Client-Cert` header | The client sent no certificate, or it called `<mock host>`. | Call `<mock mtls host>` and present the certificate. |
| The mock container starts again and again (`docker ps` says `Restarting`) | The service refuses to start. The log of the container names the cause. A wrong or missing setting: the error names the variable. | Read the log: `docker logs --tail 20 mock-systems`. Fix the line of the setting in the env file, and create the container again. |
| A call to `POST /t/<tenant>/sourcing/rankings` gets `503`, and the body has `approval_unavailable` | The approval check could not read a source. The message names it: the attestation or the delegation. The node or the indexer of the Vector ledger gives no answer, or it answers too slowly: a read of the check ends after 12 seconds. The log line of the call has the rule `approval.failed`. The service wrote nothing. | Read the log: `docker logs --tail 20 mock-systems`. Check that the host reaches the node and the indexer, `VECTOR_OGMIOS_URL` and `VECTOR_KOIOS_URL` (the example env file has the defaults). Send the call again when they answer. |
| A call gets `421`, and the JSON body has `wrong_host` | The call used a host name that is not one of the two, or the wrong one of the two for the route. Or the env file names other hosts than the snippet. | Send `POST /admin/tenants`, the state, the log and every route with an access token or a JWT-SVID to `<mock host>`. Send a route with an X.509-SVID to `<mock mtls host>`. Check `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE`. After a change, create the container again. |
| A call gets `400`, and the body has `client_certificate_unexpected` | The call came to `<mock host>` with a `Client-Cert` header. Caddy removes that header on both names, so the call did not pass through Caddy, or the snippet lost its two `request_header` lines. | Send the call through Caddy, to the public name. Check that each of the two blocks of the installed snippet has `request_header -Client-Cert`. Install the snippet again (step 6). |
| A call to a tenant gets `404`, and the body has `tenant_not_found` | The tenant was never made, or the service restarted and lost it. | Make the tenant (step 6, "Make or reset a tenant"). |
| `POST /admin/tenants` gets `401`, and the body has `operator_token_invalid` | The token of the call is not the token of the env file, or the container runs with an older env file. | Send the token of the env file. After a change to the file, create the container again. |
