# agents/advocate/Dockerfile - build context is the repo root. Two stages: the workspace installed from the lockfile (builder), and the final image. The
# service runs no model and keeps no file: its image holds the workspace, node and tini, and nothing is fetched at run time but what a job asks of the Brave
# Search API, of the hosts of the result pages and of OpenRouter. No Python, no model files, no volume.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY agents/advocate/package.json ./agents/advocate/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/advocate...'
COPY packages/vector-read ./packages/vector-read
COPY packages/service-kit ./packages/service-kit
COPY agents/advocate ./agents/advocate

FROM node:22-bookworm-slim
# tini is the first process, and the one package added to the base image: node verifies TLS with the root certificates built into it.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
USER node
# The memory limit is the compose file's.
ENV NODE_ENV=production PORT=9094 HOST=0.0.0.0
EXPOSE 9094
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9094/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# node runs the service itself, with tsx loaded as a hook, so a stop's SIGTERM reaches the service process through tini. tsx resolves from /repo/node_modules.
CMD ["node", "--import", "tsx", "agents/advocate/src/index.ts"]
