// packages/usecase-kit/src/protocol/queue.ts
// The queue of one wallet key. A wallet has one set of outputs, and the build of a transaction takes outputs from it. Two builds at one time can take the same output, and the node accepts only one of
// the two transactions. So each part of the kit that builds and sends a transaction from the wallet of a key does it in one queue, one job at a time: the dispute folder for its Module-1 steps, and
// the access folder for the Delegate and the Undelegate of a sub-delegation. A service makes ONE queue for each key, and it gives the same object to each part and to its hires.

/**
 * A queue that runs one job at a time, in the order of the calls. `HireLane` of the hire kit is such a queue, and so is the queue that `createSerialQueue` of the access folder makes. A caller must not call
 * `run` from inside a job of the same queue: the call would wait for itself.
 */
export interface SerialQueue {
  /** Runs `job` after every job that was given before it has ended, whatever the outcome of those jobs, and gives its result. A job that fails does not stop the ones behind it. */
  run<T>(job: () => Promise<T>): Promise<T>;
}
