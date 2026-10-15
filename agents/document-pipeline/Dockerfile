# agents/document-pipeline/Dockerfile - build context is the repo root.
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY packages/buyer-core/package.json ./packages/buyer-core/package.json
COPY agents/document-pipeline/package.json ./agents/document-pipeline/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/document-pipeline...'
COPY packages/vector-read ./packages/vector-read
COPY packages/buyer-core ./packages/buyer-core
COPY agents/document-pipeline ./agents/document-pipeline
FROM node:22-alpine
WORKDIR /repo
# poppler-utils gives pdfinfo and pdftoppm, which render a PDF to PNG. A PDF whose fonts are not embedded cannot be drawn without a base font, hence fontconfig and ttf-dejavu.
RUN apk add --no-cache tini poppler-utils fontconfig ttf-dejavu
COPY --from=builder --chown=node:node /repo /repo
# The state directory holds the list of escrows the janitor still has to settle, so it is a volume and outlives the container. It is made and given to node
# before VOLUME, so that a new volume starts with that owner. The memory limit is the compose file's.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
ENV NODE_ENV=production PORT=9092 HOST=0.0.0.0
EXPOSE 9092
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:9092/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "agents/document-pipeline/src/index.ts"]
