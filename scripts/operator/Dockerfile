# scripts/operator/Dockerfile - build context is the repo root. Two stages: the workspace installed from the lockfile (builder), and the final image. The image runs the operator pack. The first word of the command
# line is the name of a task. The caller starts the container with docker run --rm and mounts what the task needs: the keys folder, the state folder and the agents folder. The image holds none of them. It holds no
# key, no env file, no test file, no shell script, no docker client and no git. No secret is a build argument, an ENV or a copied file: the caller gives the settings, as OPERATOR_* names with paths and public values,
# when it starts the container. The pack imports the checks by a relative path, so the image holds scripts/checks/lib and the workspace packages that both import. The check scripts stay out: only the pack signs in
# this image, and it signs behind its guards. The sources are copied in parts (the pack, scripts/checks/lib and the tsconfig.json of the checks), never the whole scripts folder.
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
# The pack is not a workspace package. It imports the packages by a relative path, and it loads tsx and the MCP client from the root package. The selection is the use-case kit and the packages that it needs, and
# these are all the packages that the pack reaches. The install also fills /repo/node_modules with the packages of the root.
RUN pnpm install --frozen-lockfile --filter '@vsa/usecase-kit...'
COPY packages/vector-read ./packages/vector-read
COPY packages/buyer-core ./packages/buyer-core
COPY packages/service-kit ./packages/service-kit
COPY packages/id-kit ./packages/id-kit
COPY packages/hire-kit ./packages/hire-kit
COPY packages/usecase-kit ./packages/usecase-kit
# The offline bid trial reads the same public bytes as the three desks. Do not copy an agent source tree.
COPY agents/bid-desk/price-lists/alfa.json agents/bid-desk/price-lists/bravo.json agents/bid-desk/price-lists/charlie.json ./agents/bid-desk/price-lists/
COPY scripts/checks/tsconfig.json ./scripts/checks/tsconfig.json
COPY scripts/checks/lib ./scripts/checks/lib
COPY scripts/operator ./scripts/operator

FROM node:22-bookworm-slim
# tini is the first process, and the one package added to the base image: node verifies TLS with the root certificates built into it.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
USER node
ENV NODE_ENV=production
# node runs the pack with tsx loaded as a hook, because plain node cannot run the .ts files of the pack, and a stop's SIGTERM reaches the pack through tini. tsx resolves from /repo/node_modules. The task and its
# flags are the arguments of the container, so the image has no CMD, no port and no volume: the caller mounts the folders of the task.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx", "scripts/operator/cli.ts"]
