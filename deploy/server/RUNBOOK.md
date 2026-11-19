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

## 7. Add an agent

The deploy pack of an agent has its compose file, its env example, its snippet and its own runbook. The runbook of the agent gives the keys, the registration and the advert. These steps are only for the host.

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
6. Install the snippet of the agent as `/etc/caddy/agents/<agent>.snippet`, as in step 6. Check the whole configuration and reload Caddy.
7. Check the public name:

   ```sh
   curl -sS https://<agent host name>/healthz
   ```

## 8. Remove an agent

1. The operator retires the advert first, as the runbook of the agent says. Then nobody can post an escrow against an agent that stops.
2. Check that the runtime says `free` (section "The restart rule"). Wait while it says `working`.
3. Stop the containers. Do not use `-v`. A volume can hold the list of escrows that a job left behind.

   ```sh
   sudo -u agents -H bash -c 'cd /srv/agents/<agent> && docker compose -f <compose file> down'
   ```

4. Remove the snippet. Check the configuration. Reload Caddy:

   ```sh
   sudo rm /etc/caddy/agents/<agent>.snippet
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   sudo systemctl reload caddy
   ```

5. Remove the DNS records of the agent.
6. Keep `/srv/agents/<agent>` and its keys. Delete them only when each wallet of the agent is empty. A deleted key cannot be made again.

## Keys

- Make each key on this host. Never make a key on another machine.
- Make a key as the service user, in `/srv/agents/keys`, with `umask 077`. A key file has mode 600.
- Use a command that writes the key to a file. Never use a command that prints the key.
- Never copy a key to a chat, a repository, a log, a terminal record or a backup that leaves the host.
- An env file that holds a key belongs to `agents` and has mode 600.
- The key never leaves the host. Nobody signs on another machine.
- The script makes no key and reads no key.
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

## Upgrade the host

1. Check that each runtime says `free`.
2. Check that `docker info --format '{{.LiveRestoreEnabled}}'` says `true`. A restart of the Docker daemon then keeps the containers.
3. Run `sudo apt-get update` and `sudo apt-get upgrade`. A package upgrade can restart `docker.service`.
4. A reboot stops every container. Reboot only when each runtime says `free`. If the compose file sets `restart: unless-stopped`, the containers start again. Their jobs are lost.

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
| A request to the mock host gets `421` | The TLS name and the Host header differ. Caddy refuses this on the client-certificate host. | Send the request with the same name in the TLS handshake and in the Host header. |
| The mock service sees no `Client-Cert` header | The client sent no certificate, or it called `<mock host>`. | Call `<mock mtls host>` and present the certificate. |
