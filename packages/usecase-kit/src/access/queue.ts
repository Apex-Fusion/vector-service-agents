// packages/usecase-kit/src/access/queue.ts
// The queue of one agent wallet. Two builds of one wallet at one time take the same output of the wallet as their seed, so they make the same delegation identifier, and the node accepts only one of
// the two transactions. So the build and the send of a Delegate or an Undelegate go through the queue of the wallet key, one at a time, and a transaction keeps its turn until the ledger shows it:
// the next build then reads the outputs that the last one left. The jobs under the sub-delegations still run at the same time, because only these transactions are queued.
//
// The caller gives the queue of the wallet key: the same queue that holds its other transactions of that key. `createSerialQueue` makes one, for a test and for a caller that has none.
import type { SerialQueue } from '../protocol/index.ts';
import { within, type Clock } from './ports.ts';

/** A queue in memory. It uses no timer. */
export function createSerialQueue(): SerialQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      const result = tail.then(task);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** What a wait for a turn gave: the turn, or why there is none. `release` gives the turn back, and it may be called again with no effect. */
export type TurnResult = { readonly state: 'granted'; readonly release: () => void } | { readonly state: 'timed_out' } | { readonly state: 'failed'; readonly error: unknown };

/**
 * Waits for a turn in `queue`, for at most `ms` of the clock. The turn is held until `release` is called. A wait that ends at the bound gives no turn and leaves no task behind: a turn that the queue
 * grants after the bound is given back at once, and its work never runs, so a run that gave up never makes a transaction that nobody ends.
 */
export async function takeTurn(queue: SerialQueue, clock: Clock, ms: number): Promise<TurnResult> {
  try {
    const got = await within(
      clock,
      ms,
      (signal) =>
        new Promise<TurnResult>((resolve) => {
          let release: () => void = () => undefined;
          const held = new Promise<void>((done) => {
            release = done;
          });
          signal.addEventListener('abort', () => release(), { once: true });
          queue
            .run(async () => {
              if (signal.aborted) return;
              resolve({ state: 'granted', release });
              await held;
            })
            .catch((error: unknown) => resolve({ state: 'failed', error }));
        }),
    );
    return got.timedOut ? { state: 'timed_out' } : got.value;
  } catch (error) {
    return { state: 'failed', error };
  }
}
