// agents/document-pipeline/test/dockerfile.test.ts
// The image is built from the repository root and cannot be built everywhere these tests run, so the Dockerfile is held here to what it has to say: that
// it copies what exists and all of what the service imports, that the install comes between the manifests and the sources, and that the final image
// carries what the service needs at run time (poppler with a base font, tini, a data volume that node owns) and starts the file that index.ts is.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT_DEFAULT, STATE_DIR_DEFAULT } from '../src/start.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const instructions = dockerfile.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
const copies = instructions.map((line, at) => ({ line, at })).filter(({ line }) => /^COPY /.test(line) && !/--from=/.test(line));
const sourcesOf = (copy: string): string[] => copy.replace(/^COPY /, '').split(/\s+/).slice(0, -1).map((path) => path.replace(/^\.\//, ''));
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

describe('agents/document-pipeline/Dockerfile', () => {
  test('every path it copies from the build context exists in the repository', () => {
    expect(copies.length).toBeGreaterThanOrEqual(7);
    for (const { line } of copies) for (const source of sourcesOf(line)) expect(existsSync(join(root, source)), `${source} (${line})`).toBe(true);
  });

  test('it installs the service and every workspace package the service depends on: the manifests, then the install from the lockfile, then the sources', () => {
    const closure = workspaceClosure('agents/document-pipeline');
    expect(closure).toStrictEqual(['agents/document-pipeline', 'packages/buyer-core', 'packages/vector-read']);
    const install = instructions.findIndex((line) => /^RUN pnpm install /.test(line));
    expect(install).toBeGreaterThan(0);
    expect(instructions[install]).toMatch(/--frozen-lockfile/);
    expect(instructions[install]).toContain(`--filter '${packageJson('agents/document-pipeline').name}...'`);
    for (const dir of closure) {
      const manifest = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`));
      const sources = copies.find(({ line }) => sourcesOf(line).includes(dir));
      expect(manifest, `${dir}/package.json is copied`).toBeDefined();
      expect(sources, `${dir} is copied`).toBeDefined();
      expect(manifest!.at, `${dir}/package.json comes before the install`).toBeLessThan(install);
      expect(sources!.at, `${dir} comes after the install`).toBeGreaterThan(install);
    }
    for (const file of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json']) {
      expect(copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install), `${file} comes before the install`).toBe(true);
    }
  });

  test('the final image has tini, poppler with a base font, a data volume that node owns, and runs as node', () => {
    const final = instructions.slice(instructions.map((line, at) => (/^FROM /.test(line) ? at : -1)).filter((at) => at >= 0).pop());
    const at = (pattern: RegExp) => final.findIndex((line) => pattern.test(line));
    expect(final[0]).toMatch(/^FROM node:22-alpine$/);
    expect(final.join('\n')).toMatch(/^RUN apk add --no-cache tini poppler-utils fontconfig ttf-dejavu$/m);
    expect(at(/chown node:node \/data/)).toBeGreaterThan(-1);
    expect(at(/chown node:node \/data/)).toBeLessThan(at(/^VOLUME \/data$/)); // a new volume starts with the owner the directory has when VOLUME is reached
    expect(at(/^VOLUME \/data$/)).toBeLessThan(at(/^USER node$/));
    expect(at(/^COPY --from=builder --chown=node:node \/repo \/repo$/)).toBeGreaterThan(-1);
    expect(at(/^ENTRYPOINT \["\/sbin\/tini", "--"\]$/)).toBeGreaterThan(-1);
    expect(final[final.length - 1]).toMatch(/^CMD /);
    expect(final.some((line) => /^FROM .* AS builder/.test(line))).toBe(false);
  });

  test('it starts the file that is the entry of the service, with a tsx that is a dependency of the package, on the port and the state directory the code defaults to', () => {
    const cmd = instructions[instructions.length - 1];
    expect(cmd).toBe('CMD ["node_modules/.bin/tsx", "agents/document-pipeline/src/index.ts"]');
    expect(existsSync(join(root, 'agents/document-pipeline/src/index.ts'))).toBe(true);
    expect(packageJson('agents/document-pipeline').dependencies).toHaveProperty('tsx');
    expect(dockerfile).toMatch(new RegExp(`^ENV NODE_ENV=production PORT=${PORT_DEFAULT} HOST=0\\.0\\.0\\.0$`, 'm'));
    expect(dockerfile).toMatch(new RegExp(`^EXPOSE ${PORT_DEFAULT}$`, 'm'));
    expect(dockerfile).toMatch(new RegExp(`^HEALTHCHECK .*http://127\\.0\\.0\\.1:${PORT_DEFAULT}/healthz`, 'm'));
    expect(dockerfile).toMatch(new RegExp(`^VOLUME ${STATE_DIR_DEFAULT}$`, 'm'));
  });
});
