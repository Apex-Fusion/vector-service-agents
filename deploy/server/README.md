# The agents host: set-up files

This folder has the files of the agents and the mock systems that `deploy/host` does not hold. They run on a new host that `setup.sh` prepares, or beside the agents of `deploy/host` on the same host, when its proxy runs in a container (section "A host whose proxy runs in a container").
In both ways, the agents of this folder share no container, no folder and no port with the agents of `deploy/host`.
The snippet of the mock service is for Caddy on the host: its upstream is `127.0.0.1:9120`. On a host whose proxy runs in a container, the block of the mock service uses `mock-systems:9120` (section "A host whose proxy runs in a container").

The plan for the host is 19 containers: 8 services, 10 runtimes and 1 mock service. One agent has three runtimes in front of one service, so there are 10 runtimes. The memory of the host holds the mock service and the six containers of use case 1 at the planning sizes. The four containers of use case 2 do not all pass the gate at the planning sizes. The other 8 containers wait for a new count (section "The host").
The agents of this folder build no image on the host. CI builds each image. A compose file names the image by its digest.

The operator's steps are in [RUNBOOK.md](RUNBOOK.md). This note gives the facts.

## The files

| File | Use |
|---|---|
| `setup.sh` | One script. The operator runs it as root on the new host. It can run again with the same result. |
| `Caddyfile` | The main Caddy file. It has the global options and one `import` line. It has no site block. |
| `Caddyfile.mock-systems.snippet` | The two host blocks of the mock systems: one normal HTTPS host and one client-certificate (mTLS) host. |
| `docker-compose.mock-systems.yml` | The compose file of the mock service: one container, the image by digest, and the port on `127.0.0.1:9120`. |
| `.env.mock-systems.example` | The settings of the mock service. Names and placeholders only. The operator copies it to `.env.mock-systems`, which has mode 600. |
| `prove-mock-mtls.mjs` | A local proof of the mock snippet with the real Caddy. It runs on a developer machine, not on the host. |
| `RUNBOOK.md` | The operator's steps, the checks and the failure table. |
| `docker-compose.order-desk.yml` | The compose file of the Order Desk: three runtimes (`runtime-small`, `runtime-medium`, `runtime-large`) in front of one service, each image by digest, each port on `127.0.0.1`. |
| `.env.order-desk.example` | The settings of the Order Desk service and the values that its three runtimes share. Names and placeholders only. |
| `.env.order-desk-runtime.example` | The settings of one Order Desk runtime: its supplier key, its advert and its agent. The operator makes one copy for each of the three runtimes. |
| `Caddyfile.order-desk.snippet` | The three host blocks of the Order Desk: `/agent.json` and `/lots.json` go to the service, the rest to the runtime of the host. |
| `RUNBOOK-order-desk.md` | The operator's steps for the Order Desk, its checks and its failure table. |
| `docker-compose.reorder-agent.yml` | The compose file of the Reorder Agent: one runtime in front of one service, each image by digest, each port on `127.0.0.1`. The runtime gets none of the five keys of the service. |
| `.env.reorder-agent.example` | The settings of the Reorder Agent: its service and its runtime read the same file. Names and placeholders only. |
| `Caddyfile.reorder-agent.snippet` | The host block of the Reorder Agent: `/agent.json` and the co-sign route go to the service, the rest to the runtime. |
| `RUNBOOK-reorder-agent.md` | The operator's steps for the Reorder Agent, its checks and its failure table. |
| `docker-compose.prior-authorization-agent.yml` | The compose file of the Prior Authorization Agent: one runtime in front of one service, each image by digest, each port on `127.0.0.1`. The runtime gets none of the seven keys of the service. |
| `.env.prior-authorization-agent.example` | The settings of the Prior Authorization Agent: its service and its runtime read the same file. Names, placeholders and published values only. |
| `Caddyfile.prior-authorization-agent.snippet` | The host block of the Prior Authorization Agent: `/agent.json` and the co-sign route go to the service, the rest to the runtime. |
| `RUNBOOK-prior-authorization-agent.md` | The operator's steps for the Prior Authorization Agent, its checks and its failure table. |
| `docker-compose.insurer-intake-agent.yml` | The compose file of the Insurer Intake Agent: one runtime in front of one service, each image by digest, each port on `127.0.0.1`. The runtime does not get the key of the service. |
| `.env.insurer-intake-agent.example` | The settings of the Insurer Intake Agent: its service and its runtime read the same file. Names, placeholders and published values only. |
| `Caddyfile.insurer-intake-agent.snippet` | The host block of the Insurer Intake Agent: `/agent.json` goes to the service, the rest to the runtime. |
| `RUNBOOK-insurer-intake-agent.md` | The operator's steps for the Insurer Intake Agent, its checks and its failure table. |

Each agent adds one snippet file, one compose file and one env example later. They go in this folder, with the deploy pack of the agent.

## The host

| Item | Value |
|---|---|
| Memory | 8 GiB |
| CPUs and disk | 4 CPUs and 80 GB of disk, as a guide |
| System | Ubuntu 22.04 or 24.04, or Debian 12. The script uses `apt`. |
| Address | One public IPv4 address. It does not change. |
| Provider and region | The same as the present host |

A runtime uses about 190 MiB. A service takes more than an idle service shows. On 2026-11-23 the mock service showed 169 MiB in `docker stats`, and `MemAvailable` fell by 462 MiB when it started, from 4,074 MiB to 3,612 MiB. So the plan counts 462 MiB for each new service, until the first start of that service is measured. The figures in this section were measured on a host that also runs the agents of `deploy/host`. A new host needs its own measurement.
The mock service keeps its tenants in memory, and its limit is 2 GiB (section "The mock service"). `MemAvailable` already counts Docker, Caddy and the system. The rest of the memory is for jobs, for image pulls and for a container that starts again.
The gate is 1,024 MiB: a container starts only while `MemAvailable` is at least 1,024 MiB. A container that starts again needs the gate too.

The six containers of use case 1 (inventory reorder) have these planning sizes:

| Container | MiB |
|---|---|
| Reorder Agent runtime | 190 |
| Reorder Agent service | 462 |
| Order Desk runtimes (3) | 570 |
| Order Desk service | 462 |
| The six containers | 1,684 |

With the mock service running, `MemAvailable` was 3,612 MiB in the typical case, and 2,963 MiB at its lowest in 2 minutes. This table gives the memory after the six containers run, and compares it with the gate:

| After | Typical (MiB) | Lowest (MiB) | Gate 1,024 |
|---|---|---|---|
| The mock service runs | 3,612 | 2,963 | passes |
| The six containers run | 1,928 | 1,279 | passes, with 255 MiB of margin in the lowest case |

The host builds none of the images of use case 1, so no build of theirs counts here. The agents of `deploy/host` build their runtime on the host: that build takes memory too, and the figures here do not count it. The compose files give each runtime 768 MiB and each service 1,024 MiB (`mem_limit`), so that a fault stops one container only.
A job adds memory while it runs, in the service and in the runtime that holds its escrow: about 100 to 200 MiB in each. One job runs at a time in each service, so the two services add about 800 MiB. The co-sign route of the Reorder Agent runs outside the job slot: up to 4 calls at one time, about 100 MiB for each call. These figures are not measured.
With one job in each service, the six containers leave 1,128 MiB in the typical case and 479 MiB in the lowest case. With 4 calls of the co-sign route as well, they leave 728 MiB and 79 MiB. The gate is for a start, not for a peak. Measure a job and a co-sign call in the first run, and count again.

The four containers of use case 2 (prior authorization) have these planning sizes. They are estimates until the first start of a service is measured.

| Container | MiB |
|---|---|
| Prior Authorization Agent runtime | 190 |
| Prior Authorization Agent service | 462 |
| Insurer Intake Agent runtime | 190 |
| Insurer Intake Agent service | 462 |
| The four containers | 1,304 |

A start needs 1,024 MiB of `MemAvailable` before it. With the six containers of use case 1 running, `MemAvailable` is about 1,928 MiB in the typical case and 1,279 MiB in the lowest case. This table gives the memory before and after each start, in the order of the starts. The service starts first, then the runtime, for each agent:

| Start | Typical before | Typical after | Lowest before | Lowest after |
|---|---|---|---|---|
| Prior Authorization Agent service | 1,928 | 1,466 | 1,279 | 817 |
| Prior Authorization Agent runtime | 1,466 | 1,276 | 817, fails the gate | |
| Insurer Intake Agent service | 1,276 | 814 | | |
| Insurer Intake Agent runtime | 814, fails the gate | | | |

At the planning sizes, the fourth start fails the gate in the typical case (814 MiB before it), and the second start fails it in the lowest case (817 MiB before it). Let S be the size of one service in MiB, with the runtimes at 190 MiB. In the typical case, the fourth start passes only when `2S + 190 <= 904` (1,928 less 1,024), so S is at most 357 MiB. In the lowest case, it needs `2S + 190 <= 255` (1,279 less 1,024), so S is at most 32 MiB: no real service size passes. A start that would fail the gate stops, and the owner of the host decides.

The containers of later agents come after these ten. Add them to the table, and check the gate again. So the other 8 containers need more memory, or a real size below the planning size, before they start. Measure the real size of each container at its first start.

## The runtime image

CI builds one runtime image. Every runtime of the host runs it. The image comes from the agent template at one pinned commit.

| Item | Value |
|---|---|
| Image | `ghcr.io/apex-fusion/vector-service-agents/agent-runtime` |
| Source | The repository `Apex-Fusion/vector-agent-template`, at the commit in the `ref` of `.github/workflows/ci.yml`. A step fails the job when the checkout is not at that commit. |
| Tags | `:latest` and `:<full git commit sha>`. Only the `publish` job pushes them. The `build` job builds the image on every pull request and pushes nothing. |
| Label | `vector-agent-template.commit` holds the full commit of the template. |
| In a compose file | `ghcr.io/apex-fusion/vector-service-agents/agent-runtime@sha256:<digest>`. A tag moves, so a compose file never names the image by a tag. |

The operator takes the digest of the image that CI pushed for the reviewed commit, as for the mock service (RUNBOOK, step 6, "Run the mock service").

The host pulls with no login, so the package must be public. The first publish of a new package can make it private. After the first publish, check that the package is public: an anonymous `docker manifest inspect ghcr.io/apex-fusion/vector-service-agents/agent-runtime:latest` works. Run it with no login to `ghcr.io`. If the answer says `denied`, the package is private. An admin of the organisation then makes it public.

### Move the pin

The pin is one full commit of 40 hex digits. BuildKit does not resolve a short commit. Change the commit in one pull request, in all of these places:

1. The `ref` of the checkout of the template, in the job `build` and in the job `publish` of `.github/workflows/ci.yml`.
2. The check step after each of the two checkouts.
3. The label `vector-agent-template.commit` in the job `publish`.
4. The build context of each compose file in `deploy/host`. Each context ends with `#<commit>`.

The compose files of `deploy/host` build the runtime on their own host from the same commit. They do not use this image. A test in `scripts/deploy.test.mjs` compares the four files with the workflow. The test fails when one place names another commit.

## What the script does

1. It stops at once, and changes nothing, when the host already runs the agents of the present host.
   It looks for their containers, their volumes and their folders. A test keeps this list equal to the compose files in `deploy/host`.
2. It installs Docker Engine with the compose plugin, and Caddy. It takes the packages from the two vendors.
   It checks each vendor key against a pinned fingerprint.
3. It writes `/etc/docker/daemon.json`. The file sets the log limits: 3 files of 10 MB for each container. It sets `live-restore`. It makes the loopback address the default for a published port.
4. It makes the service user `agents` and the folders (see below).
5. It writes `/etc/caddy/Caddyfile` and the folder `/etc/caddy/agents`. It checks the new file with `caddy validate`, and it reloads Caddy.
6. It sets the firewall: TCP 22, 80 and 443, and no other incoming traffic.
7. It limits the journal to 1 GB and 1 month. Caddy and the Docker daemon log to the journal.
8. It prints what it did. Each line says `changed` or `unchanged`.

## What the script does not do

- It makes no key. It reads no secret. It writes no password.
- It starts no container and builds no image.
- It does not restart Docker or a container while a container runs. A runtime keeps its jobs in memory, and a restart stops them.
- It sets no DNS record. It does not change the SSH configuration.
- It refuses to run when this SSH session uses a port other than 22, because the firewall would end the session.

## Folders and ports

| Path | Owner and mode | Use |
|---|---|---|
| `/srv/agents` | `agents`, 750 | Home of the service user. |
| `/srv/agents/<agent>` | `agents`, 750 | One folder for each agent: the compose file and the env file. The operator gives the names to the script. |
| `/srv/agents/mock-systems` | `agents`, 750 | The folder of the mock service: its compose file and its env file. |
| `/srv/agents/keys` | `agents`, 700 | The folder for keys. It is empty after the set-up. |
| `/etc/caddy/Caddyfile` | `root`, 644 | The main Caddy file, when Caddy runs on the host. |
| `/etc/caddy/agents/*.snippet` | `root`, 644 | One snippet file for each agent, when Caddy runs on the host. |

Caddy runs on the host (the set-up of this folder), or in a container (section "A host whose proxy runs in a container"). In both cases a container publishes its port on `127.0.0.1` only. The plan of the ports:

| Container | Port on 127.0.0.1 |
|---|---|
| Reorder Agent runtime (1) | 8101 |
| Order Desk runtimes (3) | 8102 to 8104 |
| Prior Authorization Agent runtime (1) | 8105 |
| Insurer Intake Agent runtime (1) | 8106 |
| Runtimes of later agents (4) | 8107 to 8110 |
| Reorder Agent service (1) | 9101 |
| Order Desk service (1) | 9102 |
| Prior Authorization Agent service (1) | 9103 |
| Insurer Intake Agent service (1) | 9104 |
| Services of later agents (4) | 9105 to 9108 |
| Mock service (1) | 9120 |

Caddy on the host reaches a container by its port on `127.0.0.1`. Caddy in a container reaches it by its container name and its container port, on the network of the compose project. The port on `127.0.0.1` then serves the checks of the operator.
No container port binds to a public address. The compose files write the address (`127.0.0.1:8101:8080`).
The setting `ip` in `daemon.json` is a second lock. The firewall is a third, but Docker publishes ports around the firewall. So the first two locks matter.

## The snippet of an agent

When Caddy runs on the host, each agent has one snippet file in `/etc/caddy/agents`. The deploy pack of the agent holds it. The snippet has this shape:

```
<agent-host> {
	handle /agent.json {
		reverse_proxy 127.0.0.1:<service-port>
	}
	handle {
		reverse_proxy 127.0.0.1:<runtime-port>
	}
}
```

The route `/agent.json` goes to the service. Every other route goes to the runtime. An agent can add more routes for its service in the same way.
`<agent-host>` is one host name of the agent. An agent with three runtimes has three blocks, one for each host name.
The service port is in the range 9101 to 9108, and the runtime port is in the range 8101 to 8110.
This shape is for Caddy on the host. A host whose proxy runs in a container uses the shape of the next section.

## A host whose proxy runs in a container

On some hosts the proxy is a Caddy container, and no Caddy package is installed on the host. The packs of use case 1 (the Reorder Agent and the Order Desk) are written for such a host, and they fit no other: their upstreams are container names, and Caddy on the host cannot resolve them. The script, the main `Caddyfile` of this folder and the folder `/etc/caddy/agents` are not used there.
The packs of use case 2 (the Prior Authorization Agent and the Insurer Intake Agent) are written for such a host in the same way.
In this section, `<caddy container>` is the name of the Caddy container. `<caddyfile>` is the one file on the host that the container mounts as `/etc/caddy/Caddyfile`.

| Item | Rule |
|---|---|
| The Caddyfile | One file. The container mounts that file. There is no folder of snippets. |
| The block of an agent | The lines of the snippet of the pack, from `# <agent> vhosts (BEGIN)` to `# <agent> vhosts (END)`. The two markers are exact lines. A command finds them to replace the block or to remove it. |
| The upstreams | Container names and container ports, for example `reorder-service:9101` and `reorder-runtime:8080`. They are not ports on `127.0.0.1`. |
| The network | Compose makes the default network of the project, `<project>_default`, when it starts the service. A pack has no `networks` key. Only the Caddy container joins it. |
| The join | `docker network connect <project>_default <caddy container>`. Do it once for each project. Do it again after each new Caddy container, because a new container has none of the joins of the old one. |
| The write | Append the block to the end of `<caddyfile>`, in place. A mounted file does not follow a new file that replaces it. |
| The check | `docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`. The answer must say `Valid configuration`. |
| The reload | `docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. Never restart Caddy. |
| The way back | Write the file again without the lines from the BEGIN marker to the END marker, in place. Then validate and reload. |
| The mock service | The snippet of the mock service has the upstream `127.0.0.1:9120`, and `127.0.0.1` in a Caddy container is the container itself. So the block of the mock service names the container: `reverse_proxy mock-systems:9120` in each of its three proxy lines, and the Caddy container joins `mock-systems_default`. The compose file still publishes `127.0.0.1:9120` for the checks of the operator. Only the Caddy container joins that network. |

The shape of the block:

```
# <agent> vhosts (BEGIN)
<agent-host> {
	handle /agent.json {
		reverse_proxy <service container>:<service port>
	}
	handle {
		reverse_proxy <runtime container>:8080
	}
}
# <agent> vhosts (END)
```

Keep a copy of the Caddyfile before each change. Write it back, in place, when `caddy validate` fails. A new Caddy container reads the file when it starts, and it does not start with a file that fails.
The runbooks of the two packs give the commands with the names of their projects and their markers: `RUNBOOK-reorder-agent.md` and `RUNBOOK-order-desk.md`, in the section "The Caddy block".
The runbooks of the two packs of use case 2 give them in the same way: `RUNBOOK-prior-authorization-agent.md` and `RUNBOOK-insurer-intake-agent.md`.

## DNS

The operator makes these records in the DNS zone of the agents. Every A record points at the public IPv4 address of the host.

| Records | Count | Type | Name |
|---|---|---|---|
| Agent host names | 10 | A, DNS only | `<agent host name>`, one for each runtime |
| Mock host names | 2 | A, DNS only | `<mock host>` and `<mock mtls host>` |
| Organisation checks | 9 | TXT | `_did.<organisation domain>`, the value is an agent DID |

The 9 TXT records are not part of the host set-up. They need the agent DIDs, which exist after the registrations.

DNS only means that no proxy stands in front of the name. Caddy ends TLS and gets its own certificate for each name.
A proxy would end TLS before Caddy. It would also replace the body of an error answer, for example the 502 of a failed job.
The records must exist, and must resolve to the host, before the block of the name goes into Caddy: the snippet in `/etc/caddy/agents`, or the block in the Caddyfile of a container. Caddy asks for the certificate when it loads the block.

## The two mock host names

| Name | Use |
|---|---|
| `<mock host>` | The normal HTTPS host. Callers send access tokens and JWT-SVIDs here. |
| `<mock mtls host>` | The client-certificate host. A caller presents an X.509-SVID as the TLS client certificate. |

Both names go to the mock service on `127.0.0.1:9120`, or on `mock-systems:9120` when the proxy is a container. The operator puts the real names in the snippet (RUNBOOK, step 6).
The operator puts the same two names, as https origins, in the env file of the mock service (RUNBOOK, step 6, "Run the mock service"). Each name must be the same in the snippet and in the env file.

On `<mock mtls host>`, Caddy asks for a client certificate (`client_auth` with `mode request`). Caddy does not require the certificate.
Caddy does not check who issued it. It passes the certificate that the client presented to the mock service, in one request header.

### The header Client-Cert

| Item | Rule |
|---|---|
| Name | `Client-Cert` (the name of RFC 9440) |
| Value | `:` + the standard base64 of the DER bytes of the certificate + `:` |
| Base64 | RFC 4648 section 4: the alphabet `A-Z a-z 0-9 + /`, with `=` padding, and no line break |
| Certificate | The first certificate that the client sent (the end-entity certificate). Not the chain. |
| Form of the value | `^:[A-Za-z0-9+/]+={0,2}:$` |
| When it is present | The client sent a certificate to `<mock mtls host>`. |
| When it is absent | The client sent no certificate, or the request came to `<mock host>`. The header is never empty. |
| Count | One header. A request with two `Client-Cert` headers is a fault. The service refuses it. |
| `Client-Cert-Chain` | Caddy never sets it. Caddy removes it from every request. The service reads it as absent. |

Caddy removes any `Client-Cert` header and any `Client-Cert-Chain` header that a client sends. It does this on both host names, before it sets its own header.
So a client cannot forge a certificate. This is true only while Caddy is the sole way to reach the mock service. For this reason the compose file publishes the port of the service on `127.0.0.1` only, so that only a program on the host reaches it.
Every process of the host that can open `127.0.0.1:9120` is a direct client of the service. It can send the bytes of the certificate of any SVID with no key, and any `Host`. So the host runs nothing that is not trusted, and the port is on the loopback address only. The compose file gives the service the default network of its own project. No other container joins it. When the proxy is a container, only the Caddy container joins it.

The TLS handshake proves that the client holds the private key of the certificate. Nothing else is checked.
The mock service must check these things itself:

1. The value holds exactly one certificate, and the certificate that the service verifies is the whole value. `X509Certificate` reads the first certificate that it finds, drops the bytes after it, and reads a certificate that sits inside another one in place of the outer one. The TLS handshake proves only that the client holds the key of the certificate that it presented, and it does not prove who issued that certificate. So a client can put the SVID of another agent inside a certificate of its own, and a service that keeps the inner certificate takes the client for that agent.
2. The certificate chain, against the SPIFFE bundle of the identity gateway. The service reads the bundle again every 300 seconds. When a new copy cannot be fetched, the service goes on with its old copy for up to one hour after the last good read, and then it refuses the call. So an authority that the gateway removed stays trusted for up to one hour in that time.
3. The validity time of the certificate.
4. The SPIFFE ID in the URI name of the certificate.

A service reads the header in this way (Node 22). The result is `null` when there is no valid certificate:

```js
import { X509Certificate } from 'node:crypto';

const header = req.headers['client-cert']; // A string, or undefined. Node joins two headers with a comma, so the match below fails.
const match = /^:([A-Za-z0-9+/]+={0,2}):$/.exec(header ?? '');
let certificate = null;
try {
  if (match) {
    const bytes = Buffer.from(match[1], 'base64');
    const read = new X509Certificate(bytes);
    // X509Certificate reads the first certificate that it finds in the bytes. Keep the result only when it is the whole value.
    if (read.raw.equals(bytes)) certificate = read;
  }
} catch {
  // The bytes are not a certificate. The request has no certificate.
}
```

`x509Svid` of `@vsa/id-kit` makes this check and the three other checks.

### The local proof

`prove-mock-mtls.mjs` starts the real Caddy (the image `caddy:2`) with the real `Caddyfile` and the real snippet.
It uses high ports on the loopback address and a local CA. It puts a small echo backend behind Caddy.
It calls both host names with curl, over HTTP/1.1 and HTTP/2, and checks the header at the backend:

- A request with a client certificate reaches the backend with that certificate in `Client-Cert`.
- A request without a client certificate reaches the backend with no `Client-Cert` header.
- A forged `Client-Cert` header is removed on both host names. A forged `Client-Cert-Chain` header is removed too.
- The client certificates are self-signed. No CA of Caddy knows them. So Caddy passes a certificate that it did not check.

It needs Node 22, Docker, curl and openssl, and it runs on Linux:

```sh
node deploy/server/prove-mock-mtls.mjs
```

The script removes its container and its temporary folder at the end. The exit code is 0 when every check passes.

## The mock service

The mock service is one container. It serves the mock systems of the tenants. The data of a tenant is synthetic. A caller reads and writes it with a token or an SVID of an agent.
The operator makes a tenant with one call (RUNBOOK, step 6, "Make or reset a tenant").

| Item | Value |
|---|---|
| Image | `ghcr.io/apex-fusion/vector-service-agents/mock-systems`. CI builds it. The compose file names it by digest. |
| Files | `docker-compose.mock-systems.yml` and `.env.mock-systems.example`. The operator puts them in `/srv/agents/mock-systems`. |
| Port | `127.0.0.1:9120` on the host, and `0.0.0.0:9120` inside the container. Only Caddy reaches it. |
| Health | `GET /healthz` answers 200 and writes no log line. |
| Memory limit | 2 GiB. A full store (100 tenants with 5000 log lines each) needs about 650 MiB of heap, and Node keeps its heap below half of the container limit. |
| Hardening | A read-only file system, with a small memory file system on `/tmp`. No Linux capability. No new privileges. |
| State | In memory. A restart loses every tenant and its log. There is no volume. |
| Keys | None. The service holds no key and no wallet. Its one secret is the operator token in the env file. |
| Reads | The identity gateway, and the node and the indexer of the Vector ledger. The checks of a token and of an approval use them. The start needs none of them. A call whose check cannot read a source gets `503`. |

`.env.mock-systems.example` has a comment for each setting. Three groups need care:

- `MOCK_PUBLIC_BASE` and `MOCK_MTLS_BASE` are the origins of the two mock host names. They must name the same hosts as the snippet. A call that names another host gets `421`.
- `MOCK_OPERATOR_TOKEN` is the one secret. It is empty in the example, and the service does not start without it.
- The three `VECTOR_IDENTITY_*` values are the values that the identity registry deployment on Vector mainnet published on 2026-11-03.

A call needs the right host. `POST /admin/tenants` and every route of a system that takes an access token or a JWT-SVID go to `<mock host>`. A route that takes an X.509-SVID goes to `<mock mtls host>`.
`GET /healthz` answers on both hosts. The service refuses a `Client-Cert` header on `<mock host>`: Caddy removes that header there, so a call that carries it did not pass through Caddy.

## Rules for the host

- **Jobs stay in memory.** A runtime keeps its jobs in memory. A restart of a runtime, of Docker or of the host stops every job that runs.
  A restart during a run is forbidden. Before any restart, each runtime must say `free` on `/status`.
  Reload Caddy. Do not restart it.
- **The mock service keeps its tenants in memory.** A restart of the mock service, or a reboot of the host, loses every tenant and its log. It holds no job, so the check of the runtimes does not cover it.
  Make each tenant again after such a restart (RUNBOOK, step 6, "Make or reset a tenant").
- **Keys are made on the host and stay on it.** No key is made on another machine. No key leaves the host.
  A key file is in `/srv/agents/keys`, or in an env file with mode 600. See the RUNBOOK, section "Keys".
- **The agents of this folder build no image on the host.** CI builds the images. A compose file names an image by its digest.
- **No container port is public.** See the section "Folders and ports".
