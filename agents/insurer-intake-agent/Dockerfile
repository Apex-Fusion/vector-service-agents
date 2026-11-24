# agents/insurer-intake-agent/Dockerfile - build context is the repo root. Two stages: the workspace installed from the lockfile (builder), and the final image. The service sits behind one runtime.
# It holds one key, the service key, which the compose file hands it as an environment variable: the supplier key is the runtime's.
# Nothing is fetched at run time but the one fetch of the Module-1 manifest at start, from its pinned https address, what the hook reads of the identity gateway and the ledger, what a job asks of the identity
# gateway, the insurer portal, the ledger and a model supplier on the marketplace, and what the janitor reads of the ledger. No Python, no model files. The image holds no test file of the service: the service
# folder is copied in parts (its manifest, its tsconfig.json and its src folder), never whole. One volume, /data, holds the intake book, the journal of the dispute code and the bookkeeping of the model hires, so
# that they outlive the container.
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
COPY agents/insurer-intake-agent/package.json ./agents/insurer-intake-agent/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/insurer-intake-agent...'
COPY packages/vector-read ./packages/vector-read
COPY packages/buyer-core ./packages/buyer-core
COPY packages/service-kit ./packages/service-kit
COPY packages/id-kit ./packages/id-kit
COPY packages/hire-kit ./packages/hire-kit
COPY packages/usecase-kit ./packages/usecase-kit
COPY agents/insurer-intake-agent/tsconfig.json ./agents/insurer-intake-agent/tsconfig.json
COPY agents/insurer-intake-agent/src ./agents/insurer-intake-agent/src

FROM node:22-bookworm-slim
# tini is the first process, and the one package added to the base image: node verifies TLS with the root certificates built into it.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
# The state directory holds the intake book, the journal of the dispute code and the record of the model hires, so it is a volume and outlives the container. It is made and given to node before VOLUME, so that a
# new volume starts with that owner.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
# The service listens on all the interfaces of the container. The compose file publishes the port on 127.0.0.1 only, so the proxy of the host is the one way to reach it. The memory limit is the compose file's.
ENV NODE_ENV=production PORT=9104 HOST=0.0.0.0
EXPOSE 9104
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9104/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# node runs the service itself, with tsx loaded as a hook, so a stop's SIGTERM reaches the service process through tini. tsx resolves from /repo/node_modules.
CMD ["node", "--import", "tsx", "agents/insurer-intake-agent/src/index.ts"]
