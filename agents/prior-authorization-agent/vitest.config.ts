// agents/prior-authorization-agent/vitest.config.ts - the tests use no network. A test that reads the ledger fixtures or signs with a key runs real code, and CI runners are shared, so each test has 60 seconds.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 } });
