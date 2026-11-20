# The agents host: set-up files

This folder has the files that set up one new host. The host runs the agents and the mock systems.
It is not the present host (see `deploy/host`). The two hosts share no container, no folder and no port.

The host has 19 containers: 8 services, 10 runtimes and 1 mock service. One agent has three runtimes in front of one service, so there are 10 runtimes.
The host builds no image. CI builds each image. A compose file names the image by its digest.

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

Each agent adds one snippet file, one compose file and one env example later. They go in this folder, with the deploy pack of the agent.

## The host

| Item | Value |
|---|---|
| Memory | 8 GiB |
| CPUs and disk | 4 CPUs and 80 GB of disk, as a guide |
| System | Ubuntu 22.04 or 24.04, or Debian 12. The script uses `apt`. |
| Address | One public IPv4 address. It does not change. |
| Provider and region | The same as the present host |

A runtime uses about 190 MiB. An idle service uses about 160 MiB. The 19 containers use about 3.3 GiB together.
The mock service uses about 140 MiB with no tenant. It keeps its tenants in memory, and its limit is 2 GiB (section "The mock service").
Docker, Caddy and the system use about 0.6 GiB more. The rest of the memory is for jobs, for image pulls and for a container that starts again.
Keep 1 GiB available when a container starts.

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
| `/etc/caddy/Caddyfile` | `root`, 644 | The main Caddy file. |
| `/etc/caddy/agents/*.snippet` | `root`, 644 | One snippet file for each agent. |

Caddy runs on the host. A container that Caddy reaches publishes its port on `127.0.0.1` only. The plan of the ports:

| Container | Port on 127.0.0.1 |
|---|---|
| Runtime (10) | 8101 to 8110 |
| Service (8) | 9101 to 9108 |
| Mock service (1) | 9120 |

No container port binds to a public address. The compose files write the address (`127.0.0.1:8101:8080`).
The setting `ip` in `daemon.json` is a second lock. The firewall is a third, but Docker publishes ports around the firewall. So the first two locks matter.

## The snippet of an agent

Each agent has one snippet file in `/etc/caddy/agents`. The deploy pack of the agent holds it. The snippet has this shape:

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
The records must exist, and must resolve to the host, before the snippet of the name goes into `/etc/caddy/agents`. Caddy asks for the certificate when it loads the snippet.

## The two mock host names

| Name | Use |
|---|---|
| `<mock host>` | The normal HTTPS host. Callers send access tokens and JWT-SVIDs here. |
| `<mock mtls host>` | The client-certificate host. A caller presents an X.509-SVID as the TLS client certificate. |

Both names go to the mock service on `127.0.0.1:9120`. The operator puts the real names in the snippet (RUNBOOK, step 6).
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
Every process of the host that can open `127.0.0.1:9120` is a direct client of the service. It can send the bytes of the certificate of any SVID with no key, and any `Host`. So the host runs nothing that is not trusted, the port is on the loopback address only, and no other container shares the network of the service. The compose file gives the service the default network of its own project, and no other container joins it.

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
- **The host builds no image.** CI builds the images. A compose file names an image by its digest.
- **No container port is public.** See the section "Folders and ports".
