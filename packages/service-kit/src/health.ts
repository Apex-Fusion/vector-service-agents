// packages/service-kit/src/health.ts
// Whether a service can take a job, for GET /healthz: the last answer of a check, with the check made again in the background when that answer is older than
// the TTL. A request asks `poke` to start a check if one is due and reads `healthy` at once, so it never waits. One check runs at a time. Nothing is known
// before the first check has answered, and until then the service counts as fine. A change of state is told once, to onChange, and a repeat is not: the
// service writes its own line for it (the Pipeline writes "wallet check failed: <reason>").
import { errorText } from './text.ts';
import { within } from './time.ts';

export interface HealthOptions {
  /** Resolves when the service can take a job, and rejects with the reason when it cannot. */
  check: () => Promise<void>;
  /** The reason /healthz gives with its 503 while the check fails, such as insufficient_float. */
  reason: string;
  clock: () => number;
  /** How long an answer stands. */
  ttlMs: number;
  /** How long a check may take before it counts as failed. */
  timeoutMs: number;
  /** Told false with the reason when a check fails after one passed (or before any had answered), and true with null when one passes after one failed. */
  onChange?: (healthy: boolean, failure: string | null) => void;
}

export class HealthMonitor {
  #healthy = true;
  #running = false;
  #checkedAt = Number.NEGATIVE_INFINITY;
  readonly #opts: HealthOptions;
  constructor(opts: HealthOptions) { this.#opts = opts; }
  get healthy(): boolean { return this.#healthy; }
  get reason(): string { return this.#opts.reason; }
  poke(): void {
    if (this.#running) return;
    const age = this.#opts.clock() - this.#checkedAt;
    if (age >= 0 && age < this.#opts.ttlMs) return; // an answer from the future, after the clock was set back, is not a fresh one
    this.#running = true;
    this.#run().catch(() => undefined);
  }
  async #run(): Promise<void> {
    let failure: string | null = null;
    try { await within(this.#opts.check(), this.#opts.timeoutMs); } catch (err) { failure = errorText(err); }
    this.#checkedAt = this.#opts.clock();
    this.#running = false;
    if (failure !== null && this.#healthy) this.#opts.onChange?.(false, failure);
    if (failure === null && !this.#healthy) this.#opts.onChange?.(true, null);
    this.#healthy = failure === null;
  }
}
