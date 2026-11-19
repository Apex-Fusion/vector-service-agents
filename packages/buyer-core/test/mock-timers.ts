// packages/buyer-core/test/mock-timers.ts
// What `t.mock.timers` of node:test is in the source tests of Apex-Fusion/mcp-server that this package ports: a fake clock. `enable` fakes
// the APIs that it names ('setTimeout', with its clearTimeout, and 'Date', set to `now`) and `tick` moves the clock on. Each ported test
// that uses it calls `mockTimers` where the source calls `t.mock.timers`; the real clock comes back after each test. It is not a copy of
// a source file, so it sits outside test/fixtures/.
import { afterEach, vi } from 'vitest';

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
