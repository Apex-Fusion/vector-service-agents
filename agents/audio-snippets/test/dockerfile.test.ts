// agents/audio-snippets/test/dockerfile.test.ts
// The image is built from the repository root and cannot be built everywhere these tests run (the implementers' machine has no Docker daemon; the host builds
// it at deployment), so the Dockerfile is held here to what it has to say: that it copies what exists and all of what the service imports, that the install
// comes between the manifests and the sources, that the speech model is installed from the pinned requirements and its files fetched at the pinned revision,
// and that the final image carries what a job needs at run time (python3 with that venv, ffmpeg, tini, the model, the worker) and starts index.ts.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WHISPER_SIZE_DEFAULT, modelDirOf } from '../src/model.ts';
import { PORT_DEFAULT } from '../src/start.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
const stages = instructions.reduce<string[][]>((all, line) => { if (/^FROM /.test(line)) all.push([line]); else all.at(-1)?.push(line); return all; }, []);
const [builder, asr, final] = stages;
const copies = instructions.map((line, at) => ({ line, at })).filter(({ line }) => /^COPY /.test(line) && !/--from=/.test(line));
const sourcesOf = (copy: string): string[] => copy.replace(/^COPY (--chown=\S+ )?/, '').split(/\s+/).slice(0, -1).map((path) => path.replace(/^\.\//, ''));
const packageJson = (dir: string): { name: string; dependencies?: Record<string, string> } => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));

/** Every workspace package `dir` depends on, and those depend on, as directories. */
function workspaceClosure(dir: string): string[] {
  const byName = new Map<string, string>();
  for (const parent of ['packages', 'agents']) for (const name of readdirSync(join(root, parent))) if (existsSync(join(root, parent, name, 'package.json'))) byName.set(packageJson(`${parent}/${name}`).name, `${parent}/${name}`);
  const seen = new Set<string>();
  const visit = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const [name, range] of Object.entries(packageJson(at).dependencies ?? {})) if (range.startsWith('workspace:')) visit(byName.get(name) ?? (() => { throw new Error(`no workspace package ${name}`); })());
  };
  visit(dir);
  return [...seen].sort();
}

describe('agents/audio-snippets/Dockerfile', () => {
  test('three stages on node:22-bookworm-slim: the builder, the speech model, and the final image', () => {
    expect(stages.map((stage) => stage[0])).toStrictEqual(['FROM node:22-bookworm-slim AS builder', 'FROM node:22-bookworm-slim AS asr', 'FROM node:22-bookworm-slim']);
  });

  test('every path it copies from the build context exists in the repository', () => {
    expect(copies.length).toBeGreaterThanOrEqual(9);
    for (const { line } of copies) for (const source of sourcesOf(line)) expect(existsSync(join(root, source)), `${source} (${line})`).toBe(true);
  });

  test('the builder installs the service and every workspace package it depends on: the manifests, then the install from the lockfile, then the sources', () => {
    const closure = workspaceClosure('agents/audio-snippets');
    expect(closure).toStrictEqual(['agents/audio-snippets', 'packages/service-kit', 'packages/vector-read']);
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions[install]).toBe("RUN pnpm install --frozen-lockfile --filter '@vsa/audio-snippets...'");
    for (const dir of closure) {
      const manifest = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`));
      const sources = copies.find(({ line }) => sourcesOf(line).includes(dir));
      expect(manifest!.at, `${dir}/package.json comes before the install`).toBeLessThan(install);
      expect(sources!.at, `${dir} comes after the install`).toBeGreaterThan(install);
    }
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) expect(copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install), file).toBe(true);
    expect(builder.join('\n')).toContain('RUN corepack enable && corepack prepare pnpm@10.33.2 --activate');
  });

  test('the speech model: the pinned requirements in a venv, the files of the model fetched at the pinned revision and checked, the size the default of the code', () => {
    expect(asr).toStrictEqual([
      'FROM node:22-bookworm-slim AS asr',
      `ARG WHISPER_MODEL=${WHISPER_SIZE_DEFAULT}`,
      'RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates && rm -rf /var/lib/apt/lists/*',
      'COPY agents/audio-snippets/asr/requirements.txt agents/audio-snippets/asr/fetch_model.py /app/asr/',
      'RUN python3 -m venv /app/asr/venv && /app/asr/venv/bin/pip install --no-cache-dir --disable-pip-version-check -r /app/asr/requirements.txt',
      'RUN /app/asr/venv/bin/python -I /app/asr/fetch_model.py "$WHISPER_MODEL" "/app/asr/models/$WHISPER_MODEL"',
    ]);
    const requirements = readFileSync(join(root, 'agents/audio-snippets/asr/requirements.txt'), 'utf8');
    expect(requirements).toMatch(/^faster-whisper==1\.2\.1$/m);
    expect(requirements).toMatch(/^ctranslate2==4\.8\.2$/m);
    expect(modelDirOf(WHISPER_SIZE_DEFAULT)).toBe('/app/asr/models/base');
  });

  test('the final image: python3, ffmpeg and tini from Debian, the workspace, the venv, the model and the worker, as node, with no volume', () => {
    const at = (line: string) => final.indexOf(line);
    expect(final[1]).toBe(`ARG WHISPER_MODEL=${WHISPER_SIZE_DEFAULT}`);
    expect(at('RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg tini && rm -rf /var/lib/apt/lists/*')).toBeGreaterThan(0);
    for (const line of ['COPY --from=builder --chown=node:node /repo /repo', 'COPY --from=asr /app/asr/venv /app/asr/venv', 'COPY --from=asr /app/asr/models /app/asr/models', 'COPY agents/audio-snippets/asr/worker.py /app/asr/worker.py']) {
      expect(at(line), line).toBeGreaterThan(0);
      expect(at(line), `${line} comes before USER node`).toBeLessThan(at('USER node'));
    }
    expect(final.some((line) => /^VOLUME /.test(line))).toBe(false);
    expect(final.some((line) => /pip install|fetch_model|corepack/.test(line))).toBe(false);
  });

  test('the environment, the port and the health check are the ones the code and the compose file use, and it starts index.ts with node and tsx under tini', () => {
    expect(final).toContain('ENV NODE_ENV=production PORT=9093 HOST=0.0.0.0 ASR_WORKER=/app/asr/worker.py WHISPER_MODEL=$WHISPER_MODEL PATH=/app/asr/venv/bin:$PATH');
    expect(PORT_DEFAULT).toBe(9093);
    expect(final).toContain('EXPOSE 9093');
    expect(final).toContain(`HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9093/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`);
    expect(final).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(final.at(-1)).toBe('CMD ["node", "--import", "tsx", "agents/audio-snippets/src/index.ts"]');
    expect(existsSync(join(root, 'agents/audio-snippets/src/index.ts'))).toBe(true);
    expect(packageJson('agents/audio-snippets').dependencies).toHaveProperty('tsx');
  });

  test('the tsx the image runs is the devDependency of the root package.json: node --import tsx runs in WORKDIR /repo and resolves /repo/node_modules/tsx', () => {
    expect(final).toContain('WORKDIR /repo');
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(rootManifest.devDependencies?.tsx).toBe('^4.21.0');
    expect(packageJson('agents/audio-snippets').dependencies?.tsx, 'the agent asks for the same range').toBe(rootManifest.devDependencies?.tsx);
    // The lockfile, from which the image installs, resolves both to one version.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const resolved = (importer: string): string | undefined => {
      const block = (lock.split(`\n  ${importer}:\n`)[1] ?? '').split(/\n  \S/)[0];
      return /\n      tsx:\n        specifier: \S+\n        version: (\S+)/.exec(block)?.[1];
    };
    expect(resolved('.')).toMatch(/^4\.\d+\.\d+$/);
    expect(resolved('agents/audio-snippets')).toBe(resolved('.'));
  });

  test('the build context leaves out the model files of a developer machine and every env file', () => {
    const ignored = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n');
    for (const entry of ['**/.models', '**/__pycache__', '**/.env', '**/.env.*', '**/node_modules']) expect(ignored, entry).toContain(entry);
  });
});
