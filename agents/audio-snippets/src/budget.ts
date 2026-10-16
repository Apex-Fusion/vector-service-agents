// agents/audio-snippets/src/budget.ts
// The time of a job (ruling R-D8). A job must end with a result or a refusal before the runtime gives up on the service, SERVICE_TIMEOUT_MS (1380000 ms)
// after the call began, and that is 120 s inside the window of 25 min the advert gives (max_processing_ms 1500000; the runtime refuses to boot unless the
// timeout is at least 60 s inside it). So the deadline of a job is its arrival plus 22 min, 60 s before the runtime's timeout. Inside it the speech
// recognition gets at most 15 min, and 60 s less than the time left when clips are asked for, so that the clips can still be cut; it is not started with less
// than 30 s. What runs before it (the fetch, the probe, the decode) is bounded by its own limits in src/media.ts, 270 s at most in all.

/** The deadline of a job, after its arrival: 22 min. */
export const JOB_DEADLINE_MS = 1_320_000;
/** The most the speech recognition of one job may take: 15 min. */
export const ASR_MAX_MS = 900_000;
/** What the speech recognition leaves for the clips when a job asks for them. */
export const CLIPS_RESERVE_MS = 60_000;
/** The least time the speech recognition is started with; with less, the job answers deadline. */
export const ASR_MIN_MS = 30_000;
/** The most one clip may take to cut. */
export const CLIP_TIMEOUT_MS = 60_000;

/** The time the speech recognition of a job gets: min(15 min, the time left, less 60 s when clips are asked for), or null when that is under 30 s. */
export function asrBudgetMs(leftMs: number, returnClips: boolean): number | null {
  const budget = Math.min(ASR_MAX_MS, leftMs - (returnClips ? CLIPS_RESERVE_MS : 0));
  return budget >= ASR_MIN_MS ? budget : null;
}
