// scripts/operator/vitest.config.ts - the test set of the operator pack. Run it with `vitest run --config scripts/operator/vitest.config.ts`.
// The tests use no network. A test that builds a transaction or a certificate runs real code, and the CI runners are shared, so each test has 60 seconds.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
});
