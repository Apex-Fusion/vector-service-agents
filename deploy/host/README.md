# Agent History on the deployment host: note for the host administrator

Status: DEPLOYED since 2026-10-15. Nothing in this folder is LIVE. Steps 1 to 15 and 17 of the runbook were run on 2026-10-14 and 2026-10-15. Step 16, the wallet monitor, is not used for this agent (operator's decision, 2026-10-15).

This note says what will be installed on the box and what the host administrator does. The operator's part (keys, collateral and float, identity, advert) is [RUNBOOK.md](RUNBOOK.md). The host administrator's part is the registry login and the image (step 2 of the runbook), and DNS and Caddy (step 10). The image has to be on the box before the operator starts the service (step 9). DNS and Caddy have to work before the advert is posted (step 12), because the advert points at the public URL.

The Document Pipeline is a second stack on the same box. It has its own section after the Agent History part of this note and its own runbook, [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md). Audio Snippets is a third, with its own section after the Pipeline's, and its own runbook, [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md). Advocate is a fourth, with its own section at the end of this note, after that of Audio Snippets, and its own runbook, [RUNBOOK-advocate.md](RUNBOOK-advocate.md).

## What will land on the box

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `agent-history-agent` | built on the box from `https://github.com/Apex-Fusion/vector-agent-template.git` at the pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on `127.0.0.1:8083` only |
| `agent-history-service` | `ghcr.io/apex-fusion/vector-service-agents/agent-history`, pinned by digest | 9091 | The runtime and Caddy, over the external network of the host's reverse proxy. Nothing on the host |

The working directory on the box is `<base path>/repo/deploy/host`, inside a checkout of this repository; the base path is the folder the operator chose (`BASE` in the runbook). The compose project is `agent-history`. Both containers join the existing external network of the host's reverse proxy, which the stack of that proxy created. Its name is not in the repository: compose reads it as `PROXY_NETWORK` from `.env` next to the compose file, which the operator writes in step 1 of the runbook with the name the host administrator gives, and compose stops while it has no value. The runtime claims jobs, calls the service, signs the receipt and submits its hash. The service reads public ledger data and holds no key: it reads the same env file as the runtime, and the compose file blanks the one secret in it for the service.

## What the host administrator does

1. **DNS.** One name is needed now: `mp-suppliers-history.hal8.ai`, an A record to the box, DNS only (grey cloud), or Caddy cannot get its certificate. Advocate has its own name, `mp-suppliers-advocate.hal8.ai`, and its own section at the end of this note. Audio Snippets has its own name, `mp-suppliers-snippets.hal8.ai`, and its own section after the Pipeline's. The Document Pipeline has its own name, `mp-suppliers-pipeline.hal8.ai`, and its own section after the Agent History part of this note. The advert will carry the first name as its endpoint, so the operator waits for it before posting the advert.

2. **Registry login.** The package is public since 2026-10-16, so the login is optional, and the host still builds the image itself (point 3). To log in, on the box: `docker login ghcr.io -u <user> --password-stdin`, with a token that has `read:packages`.

3. **The image.** The CI job that publishes `ghcr.io/apex-fusion/vector-service-agents/agent-history` tags two names: `:latest` and `:<full git commit sha>`. The compose file does not use either tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), so that a later pull cannot change the bytes behind the advert's `detail_hash`. After the pull, the host administrator records the digest and hands it to the operator, who puts it in the `image:` line before the service starts ([RUNBOOK.md](RUNBOOK.md), step 2). Until CI can publish, build the image on the box from a checkout of this repository and let compose use it:

   ```sh
   docker build -f agents/agent-history/Dockerfile -t ghcr.io/apex-fusion/vector-service-agents/agent-history:latest .
   ```

   The digest (or, where Docker keeps none for a local image, the image ID) of that local build is the one to record. Compose does not pull an image that it already has, so `up -d` then runs the local build.

4. **Caddy.** Merge the block below into the host's Caddy configuration (it is the block in `Caddyfile.snippet`, which also carries comments), validate and reload. `<caddy container>` is the container of the host's Caddy:

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
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters. The advert's `detail_uri` is `https://mp-suppliers-history.hal8.ai/agent.json`, and the template runtime does not serve that path. Without the route the manifest cannot be fetched and the hash in the advert cannot be checked. The `/agent.json` route goes first so that it is not caught by the default one. Everything else goes to the runtime.

5. **Ports.** `127.0.0.1:8083` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8083 before the first start.

## What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty (`missing required env var ADVERT_REF`). The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT` is empty or missing in the env file, so its container restarts until the operator sets it (runbook step 4). The value is a role address, published in the manifest.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: `docker compose -f docker-compose.agent-history.yml up -d --force-recreate <service>`.
- The env file holds the supplier key. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own buyer key. A first-party run shows that the path works. It is not demand.

## Rollback

The order and the commands are in [RUNBOOK.md](RUNBOOK.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop. The host administrator's part comes last: remove the Caddy block from the host's Caddy configuration, validate and reload, and remove the DNS record if it will not be reused.

The registry identity and the Module-3 stake stay on the ledger until the operator withdraws them.

## Document Pipeline on the same box

Status: DEPLOYED since 2026-10-16. Nothing in this section is LIVE. Steps 1 to 15 and 17 of its runbook were run on 2026-10-16. Step 16, the wallet monitor, is not used for this agent, as for Agent History. The files are `docker-compose.document-pipeline.yml`, `.env.document-pipeline.example`, `Caddyfile.document-pipeline.snippet` and [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), which is the operator's order of work and follows [RUNBOOK.md](RUNBOOK.md) step for step. This section says what the Pipeline adds to the box and what the host administrator does for it. It is a second stack beside Agent History, in the same shape.

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `document-pipeline-agent` | built on the box from `https://github.com/Apex-Fusion/vector-agent-template.git` at the same pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on `127.0.0.1:8084` only |
| `document-pipeline-service` | `ghcr.io/apex-fusion/vector-service-agents/document-pipeline`, built on the box and pinned by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID | 9092 | The runtime and Caddy, over the external network of the host's reverse proxy. Nothing on the host: 9092 is never published |

The working directory on the box is `<base path>/repo/deploy/host`, inside a checkout of this repository that is shipped to the box as a git bundle, because the box has no GitHub credentials; the base path is the folder the operator chose for this agent (`BASE` in its runbook). The compose project is `document-pipeline`. Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for Agent History). What differs from Agent History:

- **Two keys.** The runtime holds the supplier key. The service holds a second, separate key, the buyer key, and every job posts escrows from that wallet. The compose file blanks each key in the container that does not need it. The env file holds both.
- **A token on the service.** The service answers `POST /` only to a call whose `authorization` header is the token in `SERVICE_AUTH_HEADER`, which the runtime sends with every call (ruling R50). Both containers read it from the env file, and the operator makes it in step 4 of the runbook. A `POST /` without that header, or with another value, gets 401 before its body is read. `GET /healthz` and `GET /agent.json` need no header, and any other path gets 404. Port 9092 is never published to the host all the same. It is reachable over the external network of the host's reverse proxy by every container on that network, so the host administrator keeps that network to stacks that are trusted: the token is the second lock, and anything that holds it can start a job that posts escrows from the buyer wallet.
- **The state volume.** `document-pipeline-state`, mounted at `/data`, holds `stranded.json`, the list of escrows a job left behind that the janitor of the service settles. `docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it. Neither is run while the file lists an escrow.
- **Memory and the stop.** The service has `mem_limit: 1536m`, because `pdftoppm` renders every page at 150 dpi whatever its size, and `stop_grace_period: 330s`, because on a stop it waits up to 300 s for the job that is running, and Docker must leave it 30 s more to log a job it had to abandon and to exit with its own code. A shorter timeout (`docker stop -t`, a host that shuts down faster) kills a job under escrow, so, once the runtime runs (step 13 of the runbook), restarts wait for `/status` on `127.0.0.1:8084` to say `free`. Before step 13 no job can run, and there is nothing to wait for.
- **A window of 30 min.** The advert gives a job 30 min, so one job can hold the runtime for up to 27 min.

### What the host administrator does for the Pipeline

1. **DNS.** One more name: `mp-suppliers-pipeline.hal8.ai`, an A record to the box, DNS only (grey cloud), or Caddy cannot get its certificate. The Caddy script of the runbook refuses until the name resolves to the box, and the advert points at the public URL, so the operator waits for the name before posting it.

2. **The image.** There is no registry login and no image to pull for this agent: the service image is built on the box from a checkout of this repository (step 2 of the runbook) and pinned there. The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/document-pipeline` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for Agent History, and the box still builds its own. The compose file uses neither tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID where Docker keeps no digest for a local build.

3. **Caddy.** Merge the block below into the host's Caddy configuration (it is the block in `Caddyfile.document-pipeline.snippet`, which also carries comments), validate and reload. The operator's runbook does this at step 10 with a copy of the install script of Agent History; by hand it is, with `<caddy container>` the container of the host's Caddy:

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
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters for the reason it matters for Agent History: the advert's `detail_uri` is `https://mp-suppliers-pipeline.hal8.ai/agent.json`, and the template runtime does not serve that path. The `/agent.json` route goes first so that it is not caught by the default one.

4. **Ports.** `127.0.0.1:8084` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8084 before the first start.

### What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty. The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT` is empty or missing, and while `PIPELINE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH` or `SERVICE_AUTH_HEADER` is not set, so its container restarts until the operator has finished step 4 of the runbook. It also refuses to start when `pdfinfo` and `pdftoppm` are not in the image, and when `/data` cannot be written.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: once the runtime runs (step 13 of the runbook), only when `curl -s http://127.0.0.1:8084/status` says `free` (a stop during a job can cut a job under escrow), and before step 13 at once, since no job can run: `docker compose -f docker-compose.document-pipeline.yml up -d --force-recreate <service>`. A change to `SERVICE_AUTH_HEADER` needs both containers recreated.
- The env file holds both keys and the token between the containers. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own test buyer key. A first-party run shows that the path works. It is not demand.

### Rollback

The order and the commands are in [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop, and lets the service finish what it holds. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop, and the state volume stays. The host administrator's part comes last: remove the Caddy block from the host's Caddy configuration, validate and reload, and remove the DNS record if it will not be reused.

## Audio Snippets on the same host

Status: DEPLOYED since 2026-10-17. Nothing in this section is LIVE. Steps 1 to 5, 9 and 10 of its runbook were run on 2026-10-16 and steps 6 to 15 and 17 on 2026-10-17. Step 16, the wallet monitor, is not used for this agent, as for the other two. The files are `docker-compose.audio-snippets.yml`, `.env.audio-snippets.example`, `Caddyfile.audio-snippets.snippet` and [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), which is the operator's order of work and follows [RUNBOOK-document-pipeline.md](RUNBOOK-document-pipeline.md) step for step. This section says what Audio Snippets adds to the host and what the host administrator does for it. It is a third stack beside Agent History and the Pipeline, in the same shape.

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `audio-snippets-agent` | built on the host from `https://github.com/Apex-Fusion/vector-agent-template.git` at the same pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on `127.0.0.1:8085` only |
| `audio-snippets-service` | `ghcr.io/apex-fusion/vector-service-agents/audio-snippets`, built on the host and pinned by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID | 9093 | The runtime and Caddy, over the external network of the host's reverse proxy. Nothing on the host: 9093 is never published |

The working directory on the host is `<base path>/repo/deploy/host`, inside a checkout of this repository that is shipped to the host as a git bundle; the base path is the folder the operator chose for this agent (`BASE` in its runbook). The compose project is `audio-snippets`. Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for the other two). What differs from the Pipeline:

- **One key.** The runtime holds the supplier key. The service holds no key and posts nothing: it reads the media, transcribes it, finds the cut points and answers. The compose file blanks the supplier key in the service's environment.
- **A token on the service, as for the Pipeline.** The service answers `POST /` only to a call whose `authorization` header is the token in `SERVICE_AUTH_HEADER`, which the runtime sends with every call. Both containers read it from the env file, and the operator makes it in step 4 of the runbook. A `POST /` without that header, or with another value, gets 401 before its body is read. `GET /healthz` and `GET /agent.json` need no header, and any other path gets 404. Port 9093 is never published to the host all the same. It is reachable over the external network of the host's reverse proxy by every container on that network, so the host administrator keeps that network to stacks that are trusted: the token is the second lock.
- **The speech model in the image.** The image carries Python with faster-whisper and the files of the model, built in when the operator builds the image (step 2 of the runbook): about 150 MB for the model `base`. The build fetches them from the Python package index and huggingface.co, at pinned versions, and nothing is fetched while a job runs but the media.
- **No state.** There is no volume. A job keeps its files in a private temporary directory of the container, removed when it ends, and `/healthz` answers 503 `low_disk` when less than 256 MiB is free there.
- **Memory and the stop.** The service has `mem_limit: 3072m`, because the speech model and the decode of 10 min of audio run in it, and `stop_grace_period: 330s`, because on a stop it waits up to 300 s for the job that is running, and Docker must leave it 30 s more to log a job it had to abandon and to exit with its own code. A shorter timeout kills a job under escrow, so, once the runtime runs (step 13 of the runbook), restarts wait for `/status` on `127.0.0.1:8085` to say `free`.
- **A window of 25 min.** The advert gives a job 25 min, so one job can hold the runtime for up to 22 min.

### What the host administrator does for Audio Snippets

1. **The network.** Give the operator the name of the external network of the host's reverse proxy, as for the other two: it goes into `.env` in step 1 of the runbook.

2. **DNS.** One more name: `mp-suppliers-snippets.hal8.ai`, an A record to the host, DNS only (grey cloud), or Caddy cannot get its certificate. The Caddy script of the runbook refuses until the name resolves to the host, and the advert points at the public URL, so the operator waits for the name before posting it.

3. **The image.** There is no registry login and no image to pull for this agent: the service image is built on the host from a checkout of this repository (step 2 of the runbook) and pinned there. The build needs the host to reach the Python package index and huggingface.co. The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/audio-snippets` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for the other two, and the host still builds its own. The compose file uses neither tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID where Docker keeps no digest for a local build.

4. **Caddy.** Merge the block below into the host's Caddy configuration (it is the block in `Caddyfile.audio-snippets.snippet`, which also carries comments), validate and reload. Step 10 of the runbook does this with a copy of the install script the Pipeline used; by hand it is, with `<caddy container>` the container of the host's Caddy:

   ```
   mp-suppliers-snippets.hal8.ai {
       handle /agent.json {
           reverse_proxy audio-snippets-service:9093
       }
       handle {
           reverse_proxy audio-snippets-agent:8080
       }
   }
   ```

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters for the reason it matters for the other two: the advert's `detail_uri` is `https://mp-suppliers-snippets.hal8.ai/agent.json`, and the template runtime does not serve that path. The `/agent.json` route goes first so that it is not caught by the default one.

5. **Ports.** `127.0.0.1:8085` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8085 before the first start.

### What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty. The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` or `SERVICE_AUTH_HEADER` is not set, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`, and when `ffmpeg`, `ffprobe` or the speech model is not in the image, so its container restarts until the operator has finished step 4 of the runbook. It also refuses to start when its temporary directory cannot be written.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: once the runtime runs (step 13 of the runbook), only when `curl -s http://127.0.0.1:8085/status` says `free` (a stop during a job can cut a job under escrow), and before step 13 at once, since no job can run: `docker compose -f docker-compose.audio-snippets.yml up -d --force-recreate <service>`. A change to `SERVICE_AUTH_HEADER` needs both containers recreated.
- The env file holds the supplier key and the token between the containers. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own test buyer key. A first-party run shows that the path works. It is not demand.

### Rollback

The order and the commands are in [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop. The host administrator's part comes last: remove the Caddy block of this agent from the host's Caddy configuration, validate and reload, and remove the DNS record if it will not be reused.

## Advocate on the same host

Status: DEPLOYED since 2026-10-20. Nothing in this section is LIVE. Steps 1 to 5 of its runbook were run on 2026-10-18 and step 4b (the two API keys), steps 6 (the supplier wallet), 7, 8, 9 and 10 on 2026-10-19, with the service image of `ccbcb94`, and the identity was registered and staked on 2026-10-19. The image was rebuilt from `bd8e42d` on 2026-10-19, with steps 1, 2, 3 and 4 run again and step 9 again. Steps 11 to 14 were run on 2026-10-19, and step 6 for the buyer wallet and steps 15 and 17 on 2026-10-20. Step 16, the wallet monitor, is not used for this agent, as for the other three. The files are `docker-compose.advocate.yml`, `.env.advocate.example`, `Caddyfile.advocate.snippet` and [RUNBOOK-advocate.md](RUNBOOK-advocate.md), which is the operator's order of work and follows [RUNBOOK-audio-snippets.md](RUNBOOK-audio-snippets.md) step for step. This section says what Advocate adds to the host and what the host administrator does for it. It is a fourth stack beside Agent History, the Pipeline and Audio Snippets, in the same shape.

| Container | Image | Listens on | Reachable from |
|---|---|---|---|
| `advocate-agent` | built on the host from `https://github.com/Apex-Fusion/vector-agent-template.git` at the same pinned commit `c4c378a` (`CAPABILITY_KIND=custom`) | 8080 | Caddy, over the external network of the host's reverse proxy. The host, on `127.0.0.1:8086` only |
| `advocate-service` | `ghcr.io/apex-fusion/vector-service-agents/advocate`, built on the host and pinned by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID | 9094 | The runtime and Caddy, over the external network of the host's reverse proxy. Nothing on the host: 9094 is never published |

The working directory on the host is `<base path>/repo/deploy/host`, inside a checkout of this repository that is shipped to the host as a git bundle; the base path is the folder the operator chose for this agent (`BASE` in its runbook). The compose project is `advocate`. Both containers join the external network of the host's reverse proxy (`PROXY_NETWORK` in `.env`, written in step 1 of its runbook, as for the other three). What differs from Audio Snippets:

- **Two keys, and two API keys.** The runtime holds the supplier key. The service holds a second, separate key, the buyer key, which posts the escrow of the one chat sub-job of a job: it buys the model call first from a chat supplier on the Vector marketplace, and makes it through OpenRouter only when that hire fails. It also holds two API keys of third parties, `BRAVE_SEARCH_API_KEY` and `OPENROUTER_API_KEY`, which the operator enters by hand in step 4 of the runbook. The compose file blanks the supplier key in the service's environment, and the buyer key and the two API keys in the runtime's. The env file holds both keys.
- **A token on the service, as for the Pipeline and Audio Snippets.** The service answers `POST /` only to a call whose `authorization` header is the token in `SERVICE_AUTH_HEADER`, which the runtime sends with every call. Both containers read it from the env file, and the operator makes it in step 4 of the runbook. A `POST /` without that header, or with another value, gets 401 before its body is read. `GET /healthz` and `GET /agent.json` need no header, and any other path gets 404. Port 9094 is never published to the host all the same. It is reachable over the external network of the host's reverse proxy by every container on that network, so the host administrator keeps that network to stacks that are trusted: the token is the second lock, and anything that holds it can start a job that posts an escrow from the buyer wallet.
- **Calls out of the host.** A job sends two search queries to the Brave Search API at `api.search.brave.com` and fetches each result page from its own host. It hires a chat supplier on the Vector marketplace: it reads the marketplace indexer at `mp-indexer.vector.apexfusion.org`, reads the ledger and posts and settles an escrow through Ogmios at `ogmios.vector.mainnet.apexfusion.org`, Koios at `v2.koios.vector.mainnet.apexfusion.org` and the submit API at `submit.vector.mainnet.apexfusion.org`, and sends the prompt to the endpoint the advert of the chosen supplier names (the chat suppliers of the fleet answer at `mp-suppliers-<name>.vector.apexfusion.org`). It calls OpenRouter at `openrouter.ai` only when that hire fails. All of it goes over https. The image holds no model: the build installs the packages of the lockfile and `tini`, as for Agent History and the Pipeline, and nothing is fetched at run time but the search, the pages, the hire and the call to the model of a job, and what the janitor of the service asks of the chain about the escrows a job left behind.
- **The state volume.** `advocate-state`, mounted at `/data`, holds `stranded.json`, the list of escrows a job left behind that the janitor of the service settles, as for the Pipeline. `docker compose down` keeps it, and `down -v` or `docker volume rm` would delete it. `down -v` is never run. `docker volume rm` is run only when the agent will not come back, after the buyer wallet is emptied, and not while the file lists an escrow, except a Submitted one that nothing can settle (the runbook's Back out, point 4). A job holds what it fetched in memory and keeps nothing of it after it ends.
- **Memory and the stop.** The service has `mem_limit: 1024m`, because one job holds at most 12 pages of at most 1 MB each and their text, and `stop_grace_period: 330s`, because on a stop it waits up to 300 s for the job that is running, its Accept included, and Docker must leave it 30 s more to log a job it had to abandon and to exit with its own code. A shorter timeout can kill a job under escrow, so, once the runtime runs (step 13 of the runbook), restarts wait for `/status` on `127.0.0.1:8086` to say `free`.
- **A window of 8 min.** The advert gives a job 8 min, and one job holds the runtime for up to 6 min.

### What the host administrator does for Advocate

1. **The network.** Give the operator the name of the external network of the host's reverse proxy, as for the other three: it goes into `.env` in step 1 of the runbook.

2. **DNS.** One more name: `mp-suppliers-advocate.hal8.ai`, an A record to the host, DNS only (grey cloud), or Caddy cannot get its certificate. The Caddy script of the runbook refuses until the name resolves to the host, and the advert points at the public URL, so the operator waits for the name before posting it.

3. **The image.** There is no registry login and no image to pull for this agent: the service image is built on the host from a checkout of this repository (step 2 of the runbook) and pinned there. The CI job publishes `ghcr.io/apex-fusion/vector-service-agents/advocate` on every merge to `main`, tagged `:latest` and `:<full git commit sha>`, as it does for the other three, and the host still builds its own. The compose file uses neither tag. It names the image by digest (`@sha256:<digest>`, a placeholder in the repository), or by image ID where Docker keeps no digest for a local build.

4. **Caddy.** Merge the block below into the host's Caddy configuration (it is the block in `Caddyfile.advocate.snippet`, which also carries comments), validate and reload. Step 10 of the runbook does this with a copy of the install script Audio Snippets used; by hand it is, with `<caddy container>` the container of the host's Caddy:

   ```
   mp-suppliers-advocate.hal8.ai {
       handle /agent.json {
           reverse_proxy advocate-service:9094
       }
       handle {
           reverse_proxy advocate-agent:8080
       }
   }
   ```

   ```sh
   docker exec <caddy container> caddy validate --config /etc/caddy/Caddyfile
   docker exec <caddy container> caddy reload --config /etc/caddy/Caddyfile
   ```

   The second route matters for the reason it matters for the other three: the advert's `detail_uri` is `https://mp-suppliers-advocate.hal8.ai/agent.json`, and the template runtime does not serve that path. The `/agent.json` route goes first so that it is not caught by the default one.

5. **Ports.** `127.0.0.1:8086` on the host is the runtime's `/healthz`, `/capability` and `/status`, for the operator's checks before DNS and as a probe afterwards. It is loopback only. The service is not published. Check `ss -ltnp` for a clash on 8086 before the first start.

6. **Outbound https.** The service calls `api.search.brave.com`, `openrouter.ai` and the hosts of the result pages, all over https, on port 443 or the port that a result names. For the hire of a chat supplier it calls the marketplace indexer, Ogmios, Koios and the submit API of Vector mainnet, and the endpoint of the supplier it chose, all over https on port 443. Where the host filters outbound traffic, it lets the service out to any host on 443: a list of allowed hosts would drop most pages, and a job would then fail with `no_sources` (502).

### What to know before starting anything

- `docker compose up -d` with no service name also starts the runtime, and the runtime exits at boot while `ADVERT_REF` is empty. The operator starts `service` by name, and `agent` only after the advert exists.
- The service refuses to start while `OPERATOR_CONTACT`, `ADVOCATE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX`, `SERVICE_AUTH_HEADER`, `BRAVE_SEARCH_API_KEY` or `OPENROUTER_API_KEY` is not set, when `SUPPLIER_PUB_KEY_HEX` is not the public key of `SUPPLIER_PKH`, when a buyer line is not the buyer key's or the buyer key is the supplier key, and when the buyer key or one of the two API keys is in another setting too, so its container restarts until the operator has finished step 4 of the runbook. It also refuses to start when `/data` cannot be written.
- The env file is read when a container is created. `docker compose restart` does not re-read it. After any change, recreate: once the runtime runs (step 13 of the runbook), only when `curl -s http://127.0.0.1:8086/status` says `free` (a stop during a job can cut a job under escrow), and before step 13 at once, since no job can run: `docker compose -f docker-compose.advocate.yml up -d --force-recreate <service>`. A change to `SERVICE_AUTH_HEADER` needs both containers recreated, and a change to an API key the service alone.
- The env file holds both keys, the token between the containers and the two API keys. It is mode 600, sits next to the compose file, is covered by the repository's `.gitignore`, and is never committed or pasted into a chat.
- The first runs are first-party: the operator hires the agent with its own test buyer key. A first-party run shows that the path works. It is not demand.

### Rollback

The order and the commands are in [RUNBOOK-advocate.md](RUNBOOK-advocate.md), under "Back out". The operator retires the advert first, so that nobody can post an escrow against an agent that is about to stop, and lets the service finish what it holds. That transaction is signed with the supplier key in the env file, so it is not the host administrator's. Then the containers stop, and the state volume stays. The host administrator's part comes last: remove the Caddy block of this agent from the host's Caddy configuration, validate and reload, and remove the DNS record if it will not be reused.
