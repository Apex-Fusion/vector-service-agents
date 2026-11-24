// agents/sourcing-agent/src/facts/bound.ts
// The one way that a reader of this folder calls a port. A port is a function that reads a source: the chain, the gateway or the verifier. A call has a bound of time and is never repeated. A call that
// fails, that throws or that does not answer in time gives `{ ok: false }`, and the reader of the fact turns that into its own answer for a source that cannot be read. It never turns it into a number or a pass.
// The bound is a wait of a clock port, so that a test moves time by hand and never waits.

/** The longest time that one call of a port takes: 20 seconds. */
export const FACT_READ_TIMEOUT_MS = 20_000;

/** The clock of the readers. A reader asks it for a wait and for nothing else. `systemClock` of the use-case kit has this shape. */
export interface FactClock {
  /** Resolves after `ms` milliseconds, or at once when `signal` aborts. It never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** The value of a call that answered in time, or the fact that it did not. The reason of a failure is not kept: it can hold the words of a source. */
export type Called<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Calls the port one time and waits at most `FACT_READ_TIMEOUT_MS` of the clock. The wait starts before the call, so a clock that fails means that the port is not called. A port that does not end
 * is left behind: its late answer or its late failure changes nothing. The wait is ended when the call is done, so that no timer stays open.
 */
export async function callPort<T>(clock: FactClock, call: () => Promise<T>): Promise<Called<T>> {
  const stop = new AbortController();
  try {
    const late = clock.sleep(FACT_READ_TIMEOUT_MS, stop.signal).then((): Called<T> => ({ ok: false }));
    const answered = Promise.resolve().then(call).then((value): Called<T> => ({ ok: true, value }), (): Called<T> => ({ ok: false }));
    return await Promise.race([answered, late]);
  } catch {
    return { ok: false };
  } finally {
    stop.abort();
  }
}
