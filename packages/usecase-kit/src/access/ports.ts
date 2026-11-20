// packages/usecase-kit/src/access/ports.ts
// The clock of the folder, and the one way that it bounds a wait. Every wait goes through the clock port, so that a test moves time and never waits.

export interface Clock {
  /** POSIX milliseconds. */
  now(): number;
  /** Resolves after `ms` milliseconds, or at once when `signal` aborts. It never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The clock of the process. A timer that it makes never keeps the process alive, and `signal` clears it. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      signal?.addEventListener('abort', done, { once: true });
    }),
};

/** The longest wait that any bound of this folder takes: one day, in milliseconds. A timer cannot hold more than about 24 days, so a longer number would end at once. */
export const MAX_WAIT_MS = 86_400_000;

export type Bounded<T> = { readonly timedOut: false; readonly value: T } | { readonly timedOut: true };

/**
 * Runs `work` and gives its value, or `{ timedOut: true }` when `ms` milliseconds of the clock pass first. The signal that `work` gets aborts on the timeout, so a call can stop. A `work` that
 * ignores the signal and never ends does not hold this function: the clock ends the wait. A failure of `work` before the timeout is thrown to the caller. A failure after it is dropped.
 */
export async function within<T>(clock: Clock, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<Bounded<T>> {
  const abort = new AbortController();
  const stop = new AbortController();
  const late = clock.sleep(ms, stop.signal).then((): Bounded<T> => ({ timedOut: true }));
  const run = Promise.resolve()
    .then(() => work(abort.signal))
    .then((value): Bounded<T> => ({ timedOut: false, value }));
  try {
    const first = await Promise.race([run, late]);
    if (first.timedOut) abort.abort();
    return first;
  } finally {
    stop.abort();
  }
}
