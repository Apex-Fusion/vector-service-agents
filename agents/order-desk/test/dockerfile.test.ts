// agents/order-desk/test/dockerfile.test.ts
// The image is built from the repository root and cannot be built everywhere these tests run (a test machine can have no Docker daemon, and CI builds the image), so the Dockerfile is held here to what it has to
// say: that it copies what exists and all of what the service imports, that the install comes between the manifests and the sources, that the data file of the lots is in the image where the service reads it, and
// that the final image is the workspace, node and tini, with no Python and no other package, a data volume that node owns, run as node, on the port of the code, and starts index.ts.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOTS_FILE, PORT_DEFAULT, STATE_DIR_DEFAULT } from '../src/serve/settings.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
const stages = instructions.reduce<string[][]>((all, line) => { if (/^FROM /.test(line)) all.push([line]); else all.at(-1)?.push(line); return all; }, []);
const [builder, final] = stages;
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

describe('agents/order-desk/Dockerfile', () => {
  test('two stages on node:22-bookworm-slim: the builder and the final image', () => {
    expect(stages.map((stage) => stage[0])).toStrictEqual(['FROM node:22-bookworm-slim AS builder', 'FROM node:22-bookworm-slim']);
  });

  test('every path it copies from the build context exists in the repository, and the final stage copies nothing but the workspace of the builder', () => {
    expect(copies).toHaveLength(17);
    for (const { line } of copies) for (const source of sourcesOf(line)) expect(existsSync(join(root, source)), `${source} (${line})`).toBe(true);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the builder installs the service and every workspace package it depends on, the kit and the chain among them: the manifests, then the install from the lockfile, then the sources', () => {
    const closure = workspaceClosure('agents/order-desk');
    expect(closure).toStrictEqual(['agents/order-desk', 'packages/buyer-core', 'packages/hire-kit', 'packages/id-kit', 'packages/service-kit', 'packages/usecase-kit', 'packages/vector-read']);
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions[install]).toBe("RUN pnpm install --frozen-lockfile --filter '@vsa/order-desk...'");
    expect(packageJson('agents/order-desk').name).toBe('@vsa/order-desk');
    for (const dir of closure) {
      const manifest = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`));
      const sources = copies.find(({ line }) => sourcesOf(line).includes(dir === 'agents/order-desk' ? `${dir}/src` : dir));
      expect(manifest!.at, `${dir}/package.json comes before the install`).toBeLessThan(install);
      expect(sources!.at, `${dir} comes after the install`).toBeGreaterThan(install);
    }
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) expect(copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install), file).toBe(true);
    expect(builder).toContain('RUN corepack enable && corepack prepare pnpm@10.33.2 --activate');
  });

  test('the image holds no test file of the service: only its manifest, its tsconfig.json, its src folder and its lots file come from the build context, and the final stage takes the builder as it is', () => {
    const service = 'agents/order-desk';
    const fromService = copies.flatMap(({ line }) => sourcesOf(line)).filter((source) => source === service || source.startsWith(`${service}/`));
    expect(fromService.sort()).toStrictEqual([`${service}/lots.json`, `${service}/package.json`, `${service}/src`, `${service}/tsconfig.json`]);
    // The files that these copies bring. A test folder, a test file and the support files of the tests are not among them.
    const brought = ['package.json', 'tsconfig.json', 'lots.json', ...readdirSync(join(root, service, 'src'), { recursive: true }).map((file) => `src/${String(file)}`)];
    expect(brought.filter((file) => /(^|\/)(test|tests|support)(\/|$)|\.test\./.test(file))).toStrictEqual([]);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the lots file is copied to the path where the service reads it: the file that the service serves at /lots.json is the file of the image', () => {
    expect(relative(root, LOTS_FILE)).toBe('agents/order-desk/lots.json');
    expect(instructions).toContain('COPY agents/order-desk/lots.json ./agents/order-desk/lots.json');
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions.indexOf('COPY agents/order-desk/lots.json ./agents/order-desk/lots.json')).toBeGreaterThan(install);
  });

  test('the final image: tini from Debian and no other package, no Python, no model, the workspace owned by node, a data volume that node owns, run as node', () => {
    const at = (line: string) => final.indexOf(line);
    // A package of the system or of Python, in either stage: tini, and nothing else.
    expect(instructions.filter((line) => /apt-get|apk |pip3? /.test(line))).toStrictEqual(['RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*']);
    expect(at('RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*')).toBe(1);
    expect(instructions.join('\n')).not.toMatch(/python|venv|models?\//i);
    expect(at('WORKDIR /repo')).toBeLessThan(at('COPY --from=builder --chown=node:node /repo /repo'));
    // The state directory: made and given to node before VOLUME, so that a new volume starts with that owner, and before the image runs as node.
    expect(final.filter((line) => /^VOLUME /.test(line))).toStrictEqual([`VOLUME ${STATE_DIR_DEFAULT}`]);
    expect(at('COPY --from=builder --chown=node:node /repo /repo')).toBeLessThan(at('RUN mkdir -p /data && chown node:node /data'));
    expect(at('RUN mkdir -p /data && chown node:node /data')).toBeLessThan(at('VOLUME /data'));
    expect(at('VOLUME /data')).toBeLessThan(at('USER node'));
  });

  test('the environment, the port and the health check are the ones the code and the compose file use, and it starts index.ts with node and tsx under tini', () => {
    expect(final).toContain('ENV NODE_ENV=production PORT=9102 HOST=0.0.0.0');
    expect(PORT_DEFAULT).toBe(9102);
    expect(final).toContain('EXPOSE 9102');
    expect(final).toContain(`HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9102/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`);
    expect(final).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(final.at(-1)).toBe('CMD ["node", "--import", "tsx", "agents/order-desk/src/index.ts"]');
    expect(existsSync(join(root, 'agents/order-desk/src/index.ts'))).toBe(true);
    expect(packageJson('agents/order-desk').dependencies).toHaveProperty('tsx');
  });

  test('the tsx the image runs is the devDependency of the root package.json: node --import tsx runs in WORKDIR /repo and resolves /repo/node_modules/tsx', () => {
    expect(final).toContain('WORKDIR /repo');
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(rootManifest.devDependencies?.tsx).toBe('^4.21.0');
    expect(packageJson('agents/order-desk').dependencies?.tsx, 'the agent asks for the same range').toBe(rootManifest.devDependencies?.tsx);
    // The lockfile, from which the image installs, resolves both to one version.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const resolved = (importer: string): string | undefined => {
      const block = (lock.split(`\n  ${importer}:\n`)[1] ?? '').split(/\n  \S/)[0];
      return /\n      tsx:\n        specifier: \S+\n        version: (\S+)/.exec(block)?.[1];
    };
    expect(resolved('.')).toMatch(/^4\.\d+\.\d+$/);
    expect(resolved('agents/order-desk')).toBe(resolved('.'));
  });

  test('the build context leaves out every env file and the node_modules of a host', () => {
    const ignored = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n');
    for (const entry of ['**/.env', '**/.env.*', 'node_modules', '**/node_modules']) expect(ignored, entry).toContain(entry);
  });
});
