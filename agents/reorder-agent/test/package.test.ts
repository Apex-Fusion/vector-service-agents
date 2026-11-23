// agents/reorder-agent/test/package.test.ts - the manifest of the Reorder Agent (use case 1, inventory reorder) names the workspace packages that its folders need and no others. A change that adds a dependency changes this list too.
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

interface Manifest {
  readonly name?: unknown;
  readonly private?: unknown;
  readonly type?: unknown;
  readonly dependencies?: unknown;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;

test('the package is private, uses ES modules and has the name of its folder', () => {
  expect(manifest.name).toBe('@vsa/reorder-agent');
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
