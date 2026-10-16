# Agent History on apex-web: note for the host administrator

Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE. Steps 1 to 15 and 17 of the runbook were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).

This note says what will be installed on the box and what the host administrator does. The operator's part (keys, funds, identity, advert) is [RUNBOOK.md](RUNBOOK.md). The host administrator's part is the registry login and the image (step 2 of the runbook), and DNS and Caddy (step 10). The image has to be on the box before the operator starts the service (step 9). DNS and Caddy have to work before the advert is posted (step 12), because the advert points at the public URL.

The Document Pipeline is a second stack on the same box. It has its own section at the end of this note and its own runbook, [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md).

## What will land on the box

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `agent-history-agent` | built on the box from `https://github.com/Apex-Fusion/vector-agent-template.git` at the pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over `umami_default`. The host, on `127.0.0.1:8083` only |
| `agent-history-service` | `ghcr.io/apex-fusion/vector-service-agents/agent-history`, pinned by digest | 9091 | The runtime and Caddy, over `umami_default`. Nothing on the host |

The working directory on the box is `/opt/agent-history/repo/deploy/apex-web`, inside a checkout of this repository. The compose project is `agent-history`. Both containers join the existing external network `umami_default`, which the umami stack created. The runtime claims jobs, calls the service, signs the receipt and submits its hash. The service reads public ledger data and holds no key: it reads the same env file as the runtime, and the compose file blanks the one secret in it for the service.

## What the host administrator does

1. **DNS.** One name is needed now: `mp-suppliers-history.hal8.ai`, an A record to the box, DNS only (grey cloud), or Caddy cannot get its certificate. Two more come later, one for each agent that is not built yet: `mp-suppliers-snippets.hal8.ai` and `mp-suppliers-advocate.hal8.ai`. The Document Pipeline has its own name, `mp-suppliers-pipeline.hal8.ai`, and its own section at the end of this note. The advert will carry the first name as its endpoint, so the operator waits for it before posting the advert.

2. **Registry login.** The package is private. On the box: `docker login ghcr.io -u <user> --password-stdin`, with a token that has `read:packages`.

3. **The image.** The CI job that publishes `ghcr.io/apex-fusion/vector-service-agents/agent-history` tags two names: `:latest` and `:<full git commit sha>`. The compose file does not use either tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), so that a later pull cannot change the bytes behind the advert's `detail_hash`. After the pull, the host administrator records the digest and hands it to the operator, who puts it in the `image:` line before the service starts ([RUNBOOK.md](RUNBOOK.md), step 2). Until CI can publish, build the image on the box from a checkout of this repository and let compose use it:

   ```sh
   docker build -f agents/agent-history/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/agent-history:latest .
   ```

   The digest (or, where Docker keeps none for a local image, the image ID) of that local build is the one to record. Compose does not pull an image that it already has, so `up -d` then runs the local build.

4. **Caddy.** Merge the block below into `/opt/umami/Caddyfile` (it is the block in `Caddyfile.snippet`, which also carries comments), validate and reload:

   ```
   mp-suppliers-history.hal8.ai {
       handle /agent.json {
           reverse_proxy agent-history-service:9091
       }
       handle {
           reverse_proxy agent-history-agent:8080
       }
   }
   ```

   ```sh
   docker exec umami-caddy-1 caddy validate --config /etc/caddy/Caddyfile
   docker exec umami-caddy-1 caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters. The advert's `detail_uri` is `https://mp-suppliers-history.hal8.ai/agent.json`, and the template runtime does not serve that path. Without the route the manifest cannot be fetched and the hash in the advert cannot be checked. The `/agent.json` route goes first so that it is not caught by the default one. Everything else goes to the runtime.

5. **Ports.** `127.0.0.1:8083` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8083 before the first start.

## What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty (`missing required env var ADVERT_REF`). The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT` is empty or missing in the env file, so its container restarts until the operator sets it (runbook step 4). The value is a role address, published in the manifest.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: `docker compose -f docker-compose.agent-history.yml up -d --force-recreate <service>`.
- The env file holds the supplier key. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own buyer key. A first-party run shows that the path works. It is not demand and it counts as no revenue.

## Rollback

The order and the commands are in [RUNBOOK.md](RUNBOOK.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop. The host administrator's part comes last: remove the Caddy block from `/opt/umami/Caddyfile`, validate and reload, and remove the DNS record if it will not be reused.

The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them.

## Document Pipeline on the same box

Status: PROPOSED (built, not deployed). Since 2026-10-13. Nothing in this section is installed on the box. The files are `docker-compose.document-pipeline.yml`, `.env.document-pipeline.example`, `Caddyfile.document-pipeline.snippet` and [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), which is the operator's order of work and follows [RUNBOOK.md](RUNBOOK.md) step for step. This section says what the Pipeline adds to the box and what the host administrator does for it. It is a second stack beside Agent History, in the same shape.

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `document-pipeline-agent` | built on the box from `https://github.com/Apex-Fusion/vector-agent-template.git` at the same pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over `umami_default`. The host, on `127.0.0.1:8084` only |
| `document-pipeline-service` | `ghcr.io/apex-fusion/vector-service-agents/document-pipeline`, built on the box and pinned by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID | 9092 | The runtime and Caddy, over `umami_default`. Nothing on the host: 9092 is never published |

The working directory on the box is `/opt/document-pipeline/repo/deploy/apex-web`, inside a checkout of this repository that is shipped to the box as a git bundle, because the box has no GitHub credentials. The compose project is `document-pipeline`. Both containers join the external network `umami_default`. What differs from Agent History:

- **Two keys.** The runtime holds the supplier key. The service holds a second, separate key, the buyer key, and every job posts escrows from that wallet. The compose file blanks each key in the container that does not need it. The env file holds both.
- **A token on the service.** The service answers `POST /` only to a call whose `authorization` header is the token in `SERVICE_AUTH_HEADER`, which the runtime sends with every call (ruling R50). Both containers read it from the env file, and the operator makes it in step 4 of the runbook. A `POST /` without that header, or with another value, gets 401 before its body is read. `GET /healthz` and `GET /agent.json` need no header, and any other path gets 404. Port 9092 is never published to the host all the same. It is reachable over `umami_default` by every container on that network, so the host administrator keeps `umami_default` to stacks that are trusted: the token is the second lock, and anything that holds it can start a job that spends from the buyer wallet.
- **The state volume.** `document-pipeline-state`, mounted at `/data`, holds `stranded.json`, the list of escrows a job left behind that the janitor of the service settles. `docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it. Neither is run while the file lists an escrow.
- **Memory and the stop.** The service has `mem_limit: 1536m`, because `pdftoppm` renders every page at 150 dpi whatever its size, and `stop_grace_period: 330s`, because on a stop it waits up to 300 s for the job that is running, and Docker must leave it 30 s more to log a job it had to abandon and to exit with its own code. A shorter timeout (`docker stop -t`, a host that shuts down faster) kills a paid job, so, once the runtime runs (step 13 of the runbook), restarts wait for `/status` on `127.0.0.1:8084` to say `free`. Before step 13 no job can run, and there is nothing to wait for.
- **A window of 30 min.** The advert gives a job 30 min, so one job can hold the runtime for up to 27 min.

### What the host administrator does for the Pipeline

1. **DNS.** One more name: `mp-suppliers-pipeline.hal8.ai`, an A record to the box, DNS only (grey cloud), or Caddy cannot get its certificate. The Caddy script of the runbook refuses until the name resolves to the box, and the advert points at the public URL, so the operator waits for the name before posting it.

2. **The image.** There is no registry login and no image to pull for this agent: the service image is built on the box from a checkout of this repository (step 2 of the runbook) and pinned there. The CI job that publishes `ghcr.io/apex-fusion/vector-service-agents/document-pipeline` tags `:latest` and `:<full git commit sha>`, as it does for Agent History, once Actions can run. The compose file uses neither tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID where Docker keeps no digest for a local build.

3. **Caddy.** Merge the block below into `/opt/umami/Caddyfile` (it is the block in `Caddyfile.document-pipeline.snippet`, which also carries comments), validate and reload. The operator's runbook does this at step 10 with a copy of the install script of Agent History; by hand it is:

   ```
   mp-suppliers-pipeline.hal8.ai {
       handle /agent.json {
           reverse_proxy document-pipeline-service:9092
       }
       handle {
           reverse_proxy document-pipeline-agent:8080
       }
   }
   ```

   ```sh
   docker exec umami-caddy-1 caddy validate --config /etc/caddy/Caddyfile
   docker exec umami-caddy-1 caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters for the reason it matters for Agent History: the advert's `detail_uri` is `https://mp-suppliers-pipeline.hal8.ai/agent.json`, and the template runtime does not serve that path. The `/agent.json` route goes first so that it is not caught by the default one.

4. **Ports.** `127.0.0.1:8084` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8084 before the first start.

### What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty. The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT` is empty or missing, and while `PIPELINE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH` or `SERVICE_AUTH_HEADER` is not set, so its container restarts until the operator has finished step 4 of the runbook. It also refuses to start when `pdfinfo` and `pdftoppm` are not in the image, and when `/data` cannot be written.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: once the runtime runs (step 13 of the runbook), only when `curl -s http://127.0.0.1:8084/status` says `free` (a stop during a job can cut a paid job), and before step 13 at once, since no job can run: `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate <service>`. A change to `SERVICE_AUTH_HEADER` needs both containers recreated.
- The env file holds both keys and the token between the containers. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own test buyer key. A first-party run shows that the path works. It is not demand and it counts as no revenue.

### Rollback

The order and the commands are in [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop, and lets the service finish what it holds. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop, and the state volume stays. The host administrator's part comes last: remove the Caddy block from `/opt/umami/Caddyfile`, validate and reload, and remove the DNS record if it will not be reused.
