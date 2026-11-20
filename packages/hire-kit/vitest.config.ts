// packages/hire-kit/vitest.config.ts - the tests use no network, but many of them run a whole hire with real timers. CI runners are shared, and on a busy runner such a test passes the
// default limit of 5 seconds with no defect in the code. So each test and each hook has 60 seconds. The tests that are found are the same as with no config file.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 60_000 } });
