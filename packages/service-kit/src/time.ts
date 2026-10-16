// packages/service-kit/src/time.ts
// A wait with a bound: work that has not answered in time is abandoned.

/** The rejection of `within`: the work did not answer in time. */
export class OutOfTime extends Error {}

/**
 * `work`, or an OutOfTime rejection after `ms`, whichever comes first. The work is abandoned then and not cancelled: an answer it gives later is ignored.
 * The timer is unref'd, so that it never keeps the process alive.
 */
export function within<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new OutOfTime(`no answer within ${ms} ms`)), ms);
    timer.unref();
    work.then((value) => { clearTimeout(timer); resolve(value); }, (err: unknown) => { clearTimeout(timer); reject(err); });
  });
}
