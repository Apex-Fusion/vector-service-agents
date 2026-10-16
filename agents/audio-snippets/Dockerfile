# agents/audio-snippets/Dockerfile - build context is the repo root. Three stages: the workspace installed from the lockfile (builder); the speech model (asr):
# faster-whisper pinned in a venv, and the files of the model fetched at a pinned revision and checked; and the final image, which fetches nothing at run time.
FROM node:22-bookworm-slim AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY agents/audio-snippets/package.json ./agents/audio-snippets/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/audio-snippets...'
COPY packages/vector-read ./packages/vector-read
COPY packages/service-kit ./packages/service-kit
COPY agents/audio-snippets ./agents/audio-snippets

# The venv is built on the same base image and the same python3 of Debian as the final stage, so that it runs there as it is.
FROM node:22-bookworm-slim AS asr
ARG WHISPER_MODEL=base
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*
COPY agents/audio-snippets/asr/requirements.txt agents/audio-snippets/asr/fetch_model.py /app/asr/
RUN python3 -m venv /app/asr/venv && /app/asr/venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /app/asr/requirements.txt
RUN /app/asr/venv/bin/python -I /app/asr/fetch_model.py "$WHISPER_MODEL" "/app/asr/models/$WHISPER_MODEL"

FROM node:22-bookworm-slim
ARG WHISPER_MODEL=base
# python3 runs the venv of the speech model; ffmpeg and ffprobe read and cut the media; tini is the first process. No volume: a job keeps nothing.
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg tini && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY --from=builder --chown=node:node /repo /repo
COPY --from=asr /app/asr/venv /app/asr/venv
COPY --from=asr /app/asr/models /app/asr/models
COPY agents/audio-snippets/asr/worker.py /app/asr/worker.py
USER node
# The venv first on PATH, so that python3 -I /app/asr/worker.py runs it. The memory limit is the compose file's.
ENV NODE_ENV=production PORT=9093 HOST=0.0.0.0 ASR_WORKER=/app/asr/worker.py WHISPER_MODEL=$WHISPER_MODEL PATH=/app/asr/venv/bin:$PATH
EXPOSE 9093
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9093/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
# node runs the service itself, with tsx loaded as a hook, so a stop's SIGTERM reaches the service process through tini. tsx resolves from /repo/node_modules.
CMD ["node", "--import", "tsx", "agents/audio-snippets/src/index.ts"]
