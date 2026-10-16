// agents/audio-snippets/src/run.ts
// One job, from the request to the result: the free space checked; then, in a private directory that is removed whatever happens, the media made ready
// (src/media.ts), the ranges held to its duration, the speech recognition with the time the job has for it (src/budget.ts), the transcript rounded and
// clamped, the matches (src/match.ts) and, when asked for, the clips (src/clips.ts). The service holds no key and posts nothing: a job that fails locks nothing
// of the service's, and the hirer reclaims the escrow after its deliver_by.
//
// A job whose caller hangs up is stopped (ruling R-D24): the server aborts the signal of the job, which cuts a fetch of the source that is still running, kills
// the worker of the speech model and stops the clips before the next cut, and is looked at between the steps. The job then fails with aborted (499), whatever
// it was doing, and the private directory is removed as after any failure; nothing of the job is kept.
import { tmpdir } from 'node:os';
import { errorText, withPrivateDir } from '@vsa/service-kit';
import { AsrError } from './asr.ts';
import type { Asr, AsrTranscript } from './asr.ts';
import { asrBudgetMs } from './budget.ts';
import { cutClips } from './clips.ts';
import { assertScratch } from './disk.ts';
import { findMatches, round3 } from './match.ts';
import { prepareMedia } from './media.ts';
import type { MediaTools } from './media.ts';
import { RequestError } from './request.ts';
import type { SnippetsRequest } from './request.ts';
import { SnippetsError, assemble, transcriptOf } from './result.ts';
import type { SnippetsResult } from './result.ts';

export interface RunDeps {
  fetchImpl: typeof fetch;
  tools: MediaTools;
  asr: Asr;
  /** The result's model, faster-whisper-<size>-int8. */
  model: string;
  clock: () => number;
  /** The deadline of the job on the clock: its arrival plus JOB_DEADLINE_MS, set by the server. */
  deadlineMs: number;
  /** Where the private directory of the job is made: the temporary directory of the system by default. */
  scratchRoot?: string;
  /** The free space a job needs there, and how it is read (test seams). */
  minFreeBytes?: number;
  freeBytes?: (dir: string) => Promise<number>;
  /** Aborts when the caller of the job hangs up (the server's abortOnClose): the job is stopped and fails with aborted. */
  signal?: AbortSignal;
}

/** The failure of a job that was stopped because its caller hung up. */
const abandoned = (): SnippetsError => new SnippetsError('aborted', 'the caller hung up, and the job was stopped');

export async function runSnippets(req: SnippetsRequest, deps: RunDeps): Promise<SnippetsResult> {
  try {
    return await runJob(req, deps);
  } catch (error) {
    // Whatever a job that was stopped fails with on its way (a cut fetch, a killed worker), it failed because its caller hung up.
    if (deps.signal?.aborted === true) throw abandoned();
    throw error;
  }
}

async function runJob(req: SnippetsRequest, deps: RunDeps): Promise<SnippetsResult> {
  const root = deps.scratchRoot ?? tmpdir();
  const withSignal = deps.signal === undefined ? {} : { signal: deps.signal };
  /** Throws aborted once the caller has hung up: looked at between the steps of the job. */
  const stopIfAbandoned = (): void => { if (deps.signal?.aborted === true) throw abandoned(); };
  await assertScratch(root, deps.minFreeBytes, deps.freeBytes);
  return withPrivateDir('audio-snippets-', async (dir) => {
    const prepared = await prepareMedia(req.source, dir, { fetchImpl: deps.fetchImpl, tools: deps.tools, ...withSignal });
    stopIfAbandoned();
    const duration = round3(prepared.source.duration_s);
    (req.ranges ?? []).forEach((range, index) => {
      if (range.end_s > duration) throw new RequestError('range_out_of_media', `range ${index} ends at ${range.end_s} s, after the end of the media at ${duration} s`);
    });
    const budget = asrBudgetMs(deps.deadlineMs - deps.clock(), req.return_clips);
    if (budget === null) throw new SnippetsError('deadline', 'the job had too little of its time left to start the speech recognition');
    let heard: AsrTranscript;
    try {
      heard = await deps.asr.transcribe(prepared.wav, req.language === 'auto' ? null : req.language, budget, deps.signal);
    } catch (error) {
      if (error instanceof AsrError && error.reason === 'aborted') throw abandoned();
      if (error instanceof AsrError && error.reason === 'timeout') {
        throw new SnippetsError('deadline', `the speech recognition did not finish within the ${Math.round(budget / 1000)} s the job had for it`);
      }
      throw new SnippetsError('asr_failed', errorText(error));
    }
    stopIfAbandoned();
    const transcript = transcriptOf(heard.segments, duration);
    const found = await findMatches(req, transcript, duration);
    stopIfAbandoned();
    const clips = req.return_clips
      ? await cutClips(found.matches, prepared.wav, dir, req.clip_format, { tools: deps.tools, clock: deps.clock, deadlineMs: deps.deadlineMs, ...withSignal })
      : { clips: [], truncated: false };
    stopIfAbandoned();
    return assemble({
      source: { ...prepared.source, duration_s: duration }, model: deps.model, language: req.language === 'auto' ? heard.language : req.language, transcript, found, clips,
    });
  }, root);
}
