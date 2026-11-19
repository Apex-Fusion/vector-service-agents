// packages/buyer-core/test/ported-support.ts
// What the tests ported from Apex-Fusion/mcp-server (VENDORED-FROM.md, Tests) need besides vitest. Each of them imports this file.
// The time limit: node:test has none for a test, and vitest has 5 s. The ported tests run real decoders and built transactions, and the
// CI runners are shared, so each gets 60 s. A test that names its own limit keeps it.
// The fake clock: `mockTimers` is what `t.mock.timers` of node:test is in the source tests. `enable` fakes the APIs that it names
// ('setTimeout', with its clearTimeout, and 'Date', set to `now`) and `tick` moves the clock on. The real clock comes back after each test.
// This file is not a copy of a source file, so it sits outside test/fixtures/.
import { afterEach, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

type FakedApi = 'setTimeout' | 'Date';

export const mockTimers = {
  enable({ apis, now }: { apis: FakedApi[]; now?: number }): void {
    vi.useFakeTimers({ toFake: apis.flatMap((api) => (api === 'setTimeout' ? (['setTimeout', 'clearTimeout'] as const) : ([api] as const))), now });
  },
  tick(milliseconds: number): void {
    vi.advanceTimersByTime(milliseconds);
  },
};

afterEach(() => {
  vi.useRealTimers();
});
