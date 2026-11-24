// agents/bid-desk/test/package.test.ts - the manifest of the Bid Desk of use case 3 (supplier bid evaluation) names the workspace packages that its folders need and no others. Its compiler is the one of the root, and its typecheck config sets no option of its own. A change to one of these facts changes this test too.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

interface Manifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly type?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
}

const manifest = readJson('../package.json') as Manifest;
const rootManifest = readJson('../../../package.json') as Manifest;

test('the package is private, uses ES modules and has the name of its folder', () => {
  expect(manifest.name).toBe('@vsa/bid-desk');
  expect(manifest.private).toBe(true);
  expect(manifest.type).toBe('module');
});

test('the runtime dependencies are the six workspace packages and tsx, and nothing else', () => {
  expect(manifest.dependencies).toStrictEqual({
    '@vsa/buyer-core': 'workspace:*',
    '@vsa/hire-kit': 'workspace:*',
    '@vsa/id-kit': 'workspace:*',
    '@vsa/service-kit': 'workspace:*',
    '@vsa/usecase-kit': 'workspace:*',
    '@vsa/vector-read': 'workspace:*',
    tsx: '^4.21.0',
  });
});

test('the development dependencies are the four tools of the repository, and nothing else', () => {
  expect(Object.keys(manifest.devDependencies ?? {}).sort()).toStrictEqual(['@types/node', 'typescript', 'vitest', 'yaml']);
});

test('the compiler range is the range of the root manifest, so that the package cannot stay on an older compiler', () => {
  const rootRange = rootManifest.devDependencies?.typescript;
  expect(typeof rootRange).toBe('string');
  expect(manifest.devDependencies?.typescript).toBe(rootRange);
});

test('the typecheck config extends the shared base and sets no option of its own', () => {
  expect(readJson('../tsconfig.json')).toStrictEqual({ extends: '../../tsconfig.base.json', include: ['src', 'test'] });
});
