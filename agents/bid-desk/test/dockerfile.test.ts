// agents/bid-desk/test/dockerfile.test.ts
// The image is built from the repository root and cannot be built everywhere these tests run (a test machine can have no Docker daemon, and CI builds the image), so the Dockerfile is held here to what it has to
// say: that it copies what exists and all of what the service imports, that the install comes between the manifests and the sources, that the three price list files are in the image where the service reads them,
// and that the final image is the workspace, node and tini, with no Python and no other package, a data volume that node owns, run as node, on the port of the code, and starts index.ts. One image serves the
// three Bid Desks, so the image has no setting of an instance.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, PORT_DEFAULT, STATE_DIR_DEFAULT, priceListFileOf } from '../src/serve/settings.ts';

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

describe('agents/bid-desk/Dockerfile', () => {
  test('two stages on node:22-bookworm-slim: the builder and the final image', () => {
    expect(stages.map((stage) => stage[0])).toStrictEqual(['FROM node:22-bookworm-slim AS builder', 'FROM node:22-bookworm-slim']);
  });

  test('every path it copies from the build context exists in the repository, and the final stage copies nothing but the workspace of the builder', () => {
    expect(copies).toHaveLength(17);
    for (const { line } of copies) for (const source of sourcesOf(line)) expect(existsSync(join(root, source)), `${source} (${line})`).toBe(true);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the builder installs the service and every workspace package it depends on, the kit and the chain among them: the manifests, then the install from the lockfile, then the sources', () => {
    const closure = workspaceClosure('agents/bid-desk');
    expect(closure).toStrictEqual(['agents/bid-desk', 'packages/buyer-core', 'packages/hire-kit', 'packages/id-kit', 'packages/service-kit', 'packages/usecase-kit', 'packages/vector-read']);
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions[install]).toBe("RUN pnpm install --frozen-lockfile --filter '@vsa/bid-desk...'");
    expect(packageJson('agents/bid-desk').name).toBe('@vsa/bid-desk');
    for (const dir of closure) {
      const manifest = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`));
      const sources = copies.find(({ line }) => sourcesOf(line).includes(dir === 'agents/bid-desk' ? `${dir}/src` : dir));
      expect(manifest!.at, `${dir}/package.json comes before the install`).toBeLessThan(install);
      expect(sources!.at, `${dir} comes after the install`).toBeGreaterThan(install);
    }
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) expect(copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install), file).toBe(true);
    expect(builder).toContain('RUN corepack enable && corepack prepare pnpm@10.33.2 --activate');
  });

  test('the image holds no test file of the service: only its manifest, its tsconfig.json, its src folder and its price lists come from the build context, and the final stage takes the builder as it is', () => {
    const service = 'agents/bid-desk';
    const fromService = copies.flatMap(({ line }) => sourcesOf(line)).filter((source) => source === service || source.startsWith(`${service}/`));
    expect(fromService.sort()).toStrictEqual([`${service}/package.json`, `${service}/price-lists`, `${service}/src`, `${service}/tsconfig.json`]);
    // The files that these copies bring. A test folder, a test file and the support files of the tests are not among them.
    const brought = [
      'package.json', 'tsconfig.json',
      ...readdirSync(join(root, service, 'price-lists'), { recursive: true }).map((file) => `price-lists/${String(file)}`),
      ...readdirSync(join(root, service, 'src'), { recursive: true }).map((file) => `src/${String(file)}`),
    ];
    expect(brought.filter((file) => /(^|\/)(test|tests|support)(\/|$)|\.test\./.test(file))).toStrictEqual([]);
    expect(final.filter((line) => /^COPY /.test(line))).toStrictEqual(['COPY --from=builder --chown=node:node /repo /repo']);
  });

  test('the three price list files are copied to the folder where the service reads them: one image serves the three Bid Desks, and the instance selects the file', () => {
    const copy = 'COPY agents/bid-desk/price-lists ./agents/bid-desk/price-lists';
    expect(instructions).toContain(copy);
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(instructions.indexOf(copy)).toBeGreaterThan(install);
    // The folder holds the three files and no other, and the file of each instance is in it.
    expect(readdirSync(join(root, 'agents/bid-desk/price-lists')).sort()).toStrictEqual(INSTANCES.map((instance) => `${instance}.json`).sort());
    for (const instance of INSTANCES) {
      expect(relative(root, priceListFileOf(instance)), instance).toBe(`agents/bid-desk/price-lists/${instance}.json`);
      expect(existsSync(priceListFileOf(instance)), instance).toBe(true);
    }
    // No setting of an instance is in the image: the compose file of each deployment gives it.
    expect(instructions.filter((line) => /BID_DESK_/.test(line))).toStrictEqual([]);
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

  test('the environment, the port and the health check are the ones the code and the compose files use: 9106 for the three Bid Desks, and it starts index.ts with node and tsx under tini', () => {
    expect(final).toContain('ENV NODE_ENV=production PORT=9106 HOST=0.0.0.0');
    expect(PORT_DEFAULT).toBe(9106);
    expect(final).toContain('EXPOSE 9106');
    expect(final).toContain(`HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:9106/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]`);
    expect(final).toContain('ENTRYPOINT ["/usr/bin/tini", "--"]');
    expect(final.at(-1)).toBe('CMD ["node", "--import", "tsx", "agents/bid-desk/src/index.ts"]');
    expect(existsSync(join(root, 'agents/bid-desk/src/index.ts'))).toBe(true);
    expect(packageJson('agents/bid-desk').dependencies).toHaveProperty('tsx');
  });

  test('the tsx the image runs is the devDependency of the root package.json: node --import tsx runs in WORKDIR /repo and resolves /repo/node_modules/tsx', () => {
    expect(final).toContain('WORKDIR /repo');
    const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
    expect(rootManifest.devDependencies?.tsx).toBe('^4.21.0');
    expect(packageJson('agents/bid-desk').dependencies?.tsx, 'the agent asks for the same range').toBe(rootManifest.devDependencies?.tsx);
    // The lockfile, from which the image installs, resolves both to one version.
    const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const resolved = (importer: string): string | undefined => {
      const block = (lock.split(`\n  ${importer}:\n`)[1] ?? '').split(/\n  \S/)[0];
      return /\n      tsx:\n        specifier: \S+\n        version: (\S+)/.exec(block)?.[1];
    };
    expect(resolved('.')).toMatch(/^4\.\d+\.\d+$/);
    expect(resolved('agents/bid-desk')).toBe(resolved('.'));
  });

  test('the build context leaves out every env file and the node_modules of a host', () => {
    const ignored = readFileSync(join(root, '.dockerignore'), 'utf8').split('\n');
    for (const entry of ['**/.env', '**/.env.*', 'node_modules', '**/node_modules']) expect(ignored, entry).toContain(entry);
  });
});
