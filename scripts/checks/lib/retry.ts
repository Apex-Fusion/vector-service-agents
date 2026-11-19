// scripts/checks/lib/retry.ts - a read that the indexers can lag behind a transaction is asked again for a short time. This is no wait of the checks (those say how long is left and end):
// it is the seconds that Koios and the hosted server need to show what the chain already holds.
import type { Clock } from './ports.ts';

/**
 * Runs `attempt` until it says that it is done, for at most `windowMs` of the clock, with `pauseMs` between two attempts. Gives the value of the last attempt, done or not: the
 * caller says what a value that is not done means.
 */
export async function eventually<T>(clock: Clock, options: { windowMs: number; pauseMs: number }, attempt: () => Promise<{ done: boolean; value: T }>): Promise<{ done: boolean; value: T }> {
  const deadline = clock.now() + options.windowMs;
  for (;;) {
    const result = await attempt();
    if (result.done || clock.now() >= deadline) return result;
    await clock.sleep(options.pauseMs);
  }
}
