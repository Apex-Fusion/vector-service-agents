// agents/sourcing-agent/test/dockerfile.test.ts
// The image is built from the repository root and cannot be built everywhere these tests run (a test machine can have no Docker daemon, and CI builds the image), so the Dockerfile is held here to what it has to
// say: that it copies what exists and all of what the service imports, that the install comes between the manifests and the sources, that the image holds no test file, and that the final image is the workspace,
// node and tini, with one volume owned by node, run as node, on the port of the code, and starts index.ts.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_DEFAULT, PORT_DEFAULT } from '../src/serve/settings.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
const stages = instructions.reduce<string[][]>((all, line) => { if (/^FROM /.test(line)) all.push([line]); else all.at(-1)?.push(line); return all; }, []);
const [builder, final] = stages;
const copies = instructions.map((line, at) => ({ line, at })).filter(({ line }) => /^COPY /.test(line) && !/--from=/.test(line));
const sourcesOf = (copy: string): string[] => copy.replace(/^COPY (--chown=\S+ )?/, '').split(/\s+/).slice(0, -1).map((path) => path.replace(/^\.\//, ''));
const packageJson = (dir: string): { name: string; dependencies?: Record<string, string> } => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
const SERVICE = 'agents/sourcing-agent';

/** Every workspace package `dir` depends on, and those depend on, as directories. */
function workspaceClosure(dir: string): string[] {
  const byName = new Map<string, string>();
  for (const parent of ['packages', 'agents', 'services']) for (const name of readdirSync(join(root, parent))) if (existsSync(join(root, parent, name, 'package.json'))) byName.set(packageJson(`${parent}/${name}`).name, `${parent}/${name}`);
  const seen = new Set<string>();
  const visit = (at: string) => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const [name, range] of Object.entries(packageJson(at).dependencies ?? {})) if (range.startsWith('workspace:')) visit(byName.get(name) ?? (() => { throw new Error(`no workspace package ${name}`); })());
  };
  visit(dir);
  return [...seen].sort();
}

describe('agents/sourcing-agent/Dockerfile', () => {
  test('two stages on node:22-bookworm-slim: the builder and the final image', () => {
    expect(stages.map((stage) => stage[0])).toStrictEqual(['FROM node:22-bookworm-slim AS builder', 'FROM node:22-bookworm-slim']);
  });

  test('every path it copies from the build context exists in the repository, and the final stage copies nothing but the workspace of the builder', () => {
    expect(copies).toHaveLength(16);
    for (const { line } of copies) for (const source of sourcesOf(line)) expect(existsSync(join(root, source)), `${source} (${line})`).toBe(true);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the builder installs the service and every workspace package it depends on: the manifests, then the install from the lockfile, then the sources', () => {
    const closure = workspaceClosure(SERVICE);
    expect(closure).toStrictEqual([SERVICE, 'packages/buyer-core', 'packages/hire-kit', 'packages/id-kit', 'packages/service-kit', 'packages/usecase-kit', 'packages/vector-read'].sort());
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions[install]).toBe("RUN pnpm install --frozen-lockfile --filter '@vsa/sourcing-agent...'");
    expect(packageJson(SERVICE).name).toBe('@vsa/sourcing-agent');
    for (const dir of closure) {
      const manifest = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`));
      const sources = copies.find(({ line }) => sourcesOf(line).includes(dir === SERVICE ? `${dir}/src` : dir));
      expect(manifest!.at, `${dir}/package.json comes before the install`).toBeLessThan(install);
      expect(sources!.at, `${dir} comes after the install`).toBeGreaterThan(install);
    }
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) expect(copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install), file).toBe(true);
    expect(builder).toContain('RUN corepack enable && corepack prepare pnpm@10.33.2 --activate');
  });

  test('the image holds no test file of the service: only its manifest, its tsconfig.json and its src folder come from the build context, and the final stage takes the builder as it is', () => {
    const fromService = copies.flatMap(({ line }) => sourcesOf(line)).filter((source) => source === SERVICE || source.startsWith(`${SERVICE}/`));
    expect(fromService.sort()).toStrictEqual([`${SERVICE}/package.json`, `${SERVICE}/src`, `${SERVICE}/tsconfig.json`]);
    // The files that these copies bring. A test folder, a test file, the support files of the tests and the template script are not among them.
    const brought = ['package.json', 'tsconfig.json', ...readdirSync(join(root, SERVICE, 'src'), { recursive: true }).map((file) => `src/${String(file)}`)];
    expect(brought.filter((file) => /(^|\/)(test|tests|support|scripts)(\/|$)|\.test\./.test(file))).toStrictEqual([]);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the final image: tini from Debian and no other package, no Python, no model, the workspace owned by node, one volume that node owns, run as node', () => {
    const at = (line: string) => final.indexOf(line);
    expect(instructions.filter((line) => /apt-get|apk |pip3? /.test(line))).toStrictEqual(['RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*']);
    expect(at('RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*')).toBe(1);
    expect(instructions.join('\n')).not.toMatch(/python|venv|models?\//i);
    expect(at('WORKDIR /repo')).toBeLessThan(at('COPY --from=builder --chown=node:node /repo /repo'));
    // The state directory is a volume that node owns: it is made and given to node before VOLUME, so that a new volume starts with that owner, and the user changes after both.
    expect(instructions.filter((line) => /^VOLUME /.test(line))).toStrictEqual(['VOLUME /data']);
    expect(at('RUN mkdir -p /data && chown node:node /data')).toBeGreaterThan(at('COPY --from=builder --chown=node:node /repo /repo'));
    expect(at('VOLUME /data')).toBe(at('RUN mkdir -p /data && chown node:node /data') + 1);
    expect(at('USER node')).toBe(at('VOLUME /data') + 1);
  });

  test('the environment, the port and the health check are the ones the code uses, and it starts index.ts with node and tsx under tini', () => {
    expect(PORT_DEFAULT).toBe(9105);
    expect(HOST_DEFAULT).toBe('0.0.0.0');
    expect(final).toContain('ENV NODE_ENV=production PORT=9105 HOST=0.0.0.0');
    expect(final).toContain('EXPOSE 9105');
    expect(final).toContain(`HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9105/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`);
    expect(final).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(final.at(-1)).toBe('CMD ["node", "--import", "tsx", "agents/sourcing-agent/src/index.ts"]');
    expect(existsSync(join(root, SERVICE, 'src/index.ts'))).toBe(true);
    expect(packageJson(SERVICE).dependencies).toHaveProperty('tsx');
  });

  test('the tsx the image runs is the devDependency of the root package.json: node --import tsx runs in WORKDIR /repo and resolves /repo/node_modules/tsx', () => {
    expect(final).toContain('WORKDIR /repo');
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(rootManifest.devDependencies?.tsx).toBe('^4.21.0');
    expect(packageJson(SERVICE).dependencies?.tsx, 'the service asks for the same range').toBe(rootManifest.devDependencies?.tsx);
    // The lockfile, from which the image installs, resolves both to one version.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const resolved = (importer: string): string | undefined => {
      const block = (lock.split(`\n  ${importer}:\n`)[1] ?? '').split(/\n  \S/)[0];
      return /\n      tsx:\n        specifier: \S+\n        version: (\S+)/.exec(block)?.[1];
    };
    expect(resolved('.')).toMatch(/^4\.\d+\.\d+$/);
    expect(resolved(SERVICE)).toBe(resolved('.'));
  });

  test('the build context leaves out every env file and the node_modules of a host', () => {
    const ignored = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n');
    for (const entry of ['**/.env', '**/.env.*', 'node_modules', '**/node_modules']) expect(ignored, entry).toContain(entry);
  });
});
