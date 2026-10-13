# agents/agent-history/Dockerfile - build context is the repo root.
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY agents/agent-history/package.json ./agents/agent-history/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/agent-history...'
COPY packages/vector-read ./packages/vector-read
COPY agents/agent-history ./agents/agent-history
FROM node:22-alpine
WORKDIR /repo
RUN apk add --no-cache tini
COPY --from=builder /repo /repo
RUN chown -R node:node /repo
USER node
ENV NODE_ENV=production PORT=9091 HOST=0.0.0.0
EXPOSE 9091
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:9091/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "agents/agent-history/src/index.ts"]
