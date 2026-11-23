# agents/reorder-agent/Dockerfile - build context is the repo root. Two stages: the workspace installed from the lockfile (builder), and the final image. The service holds five keys that it reads from its env file at
# start, and no key is in the image. It keeps its records on one volume, /data: the stranded escrows of each paying key, the journal of the challenges, the sub-delegations that a job left, the register of the
# transactions it co-signed and the counter of purchase order numbers, so that they outlive the container. At its start the service fetches one file, the Module-1 manifest at its pinned address, and it asks the node
# and the chain for the start time and the three wallets. At run time it fetches only what a job asks of the identity gateway, the mock systems, the node, the indexer, the Order Desk and a model supplier. No Python,
# no model files. The image holds no test file of the service: the service folder is copied in parts (its manifest, its tsconfig.json and src/), never whole.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY packages/buyer-core/package.json ./packages/buyer-core/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY packages/id-kit/package.json ./packages/id-kit/package.json
COPY packages/hire-kit/package.json ./packages/hire-kit/package.json
COPY packages/usecase-kit/package.json ./packages/usecase-kit/package.json
COPY agents/reorder-agent/package.json ./agents/reorder-agent/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/reorder-agent...'
COPY packages/vector-read ./packages/vector-read
COPY packages/buyer-core ./packages/buyer-core
COPY packages/service-kit ./packages/service-kit
COPY packages/id-kit ./packages/id-kit
COPY packages/hire-kit ./packages/hire-kit
COPY packages/usecase-kit ./packages/usecase-kit
COPY agents/reorder-agent/tsconfig.json ./agents/reorder-agent/tsconfig.json
COPY agents/reorder-agent/src ./agents/reorder-agent/src

FROM node:22-bookworm-slim
# tini is the first process, and the one package added to the base image: node verifies TLS with the root certificates built into it.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
# The state directory holds the records that the janitors and the co-sign route need after a restart, so it is a volume and outlives the container. It is made and given to node before VOLUME, so that a new volume
# starts with that owner.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
# The service listens on all the interfaces of the container. The compose file publishes the port on 127.0.0.1 only, so the proxy of the host is the one way to reach it. The memory limit is the compose file's.
ENV NODE_ENV=production PORT=9101 HOST=0.0.0.0
EXPOSE 9101
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9101/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# node runs the service itself, with tsx loaded as a hook, so a stop's SIGTERM reaches the service process through tini. tsx resolves from /repo/node_modules.
CMD ["node", "--import", "tsx", "agents/reorder-agent/src/index.ts"]
