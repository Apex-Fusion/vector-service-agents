# services/mock-systems/Dockerfile - build context is the repo root. Two stages: the workspace installed from the lockfile (builder), and the final image. The service holds no key and no
# wallet, and it has no volume: the data of the tenants is in memory, and a restart loses it. Nothing is fetched at run time but what a call asks of the identity gateway, and what the check of a
# delegation reads from the Vector node and the Vector indexer. No Python, no model files. The image holds no test file of the service: the service folder is copied in parts (its manifest,
# its tsconfig.json and src/), never whole. The tests start the service with an approval check that always passes (test/support/serve.ts), and the image must have no way to start it so.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY packages/buyer-core/package.json ./packages/buyer-core/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY packages/id-kit/package.json ./packages/id-kit/package.json
COPY services/mock-systems/package.json ./services/mock-systems/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/mock-systems...'
COPY packages/vector-read ./packages/vector-read
COPY packages/buyer-core ./packages/buyer-core
COPY packages/service-kit ./packages/service-kit
COPY packages/id-kit ./packages/id-kit
COPY services/mock-systems/tsconfig.json ./services/mock-systems/tsconfig.json
COPY services/mock-systems/src ./services/mock-systems/src

FROM node:22-bookworm-slim
# tini is the first process, and the one package added to the base image: node verifies TLS with the root certificates built into it.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
USER node
# The service listens on all the interfaces of the container. The compose file publishes the port on 127.0.0.1 only, so the proxy of the host is the one way to reach it. The memory limit is the
# compose file's.
ENV NODE_ENV=production PORT=9120 HOST=0.0.0.0
EXPOSE 9120
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9120/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# node runs the service itself, with tsx loaded as a hook, so a stop's SIGTERM reaches the service process through tini. tsx resolves from /repo/node_modules.
CMD ["node", "--import", "tsx", "services/mock-systems/src/index.ts"]
