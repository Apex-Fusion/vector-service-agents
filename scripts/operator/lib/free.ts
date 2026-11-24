// scripts/operator/lib/free.ts - the check that no running runtime of an agent works, and the reader of `running-images.json`.
// A task that spends a wallet that a running service also uses (the claim, the stake, the advert, the attestation) must not run while a runtime works on a job. The script that starts the
// container writes `running-images.json` before every run: it names each container of the use case that runs, with the image that it runs. That file decides alone which runtimes run. A
// runtime that is not in the file is not running, so it is not asked: a host name of a runtime that does not exist answers 502 at the proxy, and that answer says nothing. A runtime that is in
// the file must answer `free` at its status address. Any other answer is a refusal, and never a pass. A message of this file names a container, a status or a rule. It never shows a value of
// the file or a text that a runtime sent.
import { readFileSync } from 'node:fs';
import type { Output } from '../../checks/lib/ports.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec } from './contract.ts';
import { codeOf } from './registry.ts';

/** A runtime of an agent: the container that runs it, and the address where it says whether it works. */
export interface RuntimeRef { readonly container: string; readonly statusUrl: string }

/** What `readRunningImages` needs from the file system. */
export interface ReadIo {
  read(path: string): string;
}

const FILE = 'running-images.json';
/** The file is written before every run, so a file that is older than this is not the state of this run. */
const MAX_AGE_MS = 10 * 60_000;
/** A small step of the clock is no fault. A file from the future by more than this is a damaged file. */
const MAX_AHEAD_MS = 60_000;
const MAX_FILE_CHARS = 65_536;
const STATUS_LIMIT_MS = 10_000;
const STATUS_BODY_BYTES = 65_536;
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** An image as the compose file pins it: a repository, and the sha256 digest of the image index. */
const IMAGE = /^[a-z0-9][a-z0-9._:/-]{0,254}@sha256:[0-9a-f]{64}$/;

const realIo: ReadIo = { read: (path) => readFileSync(path, 'utf8') };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The POSIX milliseconds of an ISO 8601 time with a zone (`Z` or an offset), with up to nine decimals, or null when the value is no such time or names a moment that does not exist. */
function timeOf(value: unknown): number | null {
  const parts = typeof value === 'string' ? ISO_TIME.exec(value) : null;
  if (parts === null) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
  const milliseconds = parts[7] === undefined ? 0 : Number(parts[7].slice(0, 3).padEnd(3, '0'));
  const utc = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
  const moment = new Date(utc);
  const exists = moment.getUTCFullYear() === year && moment.getUTCMonth() === month - 1 && moment.getUTCDate() === day
    && moment.getUTCHours() === hour && moment.getUTCMinutes() === minute && moment.getUTCSeconds() === second;
  if (!exists) return null;
  const zone = parts[8]!;
  if (zone === 'Z') return utc;
  const [offsetHours, offsetMinutes] = [Number(zone.slice(1, 3)), Number(zone.slice(4, 6))];
  if (offsetHours > 23 || offsetMinutes > 59) return null;
  const offset = (offsetHours * 60 + offsetMinutes) * 60_000;
  return zone.startsWith('+') ? utc - offset : utc + offset;
}

/** The runtime of each advert of an agent: the container that serves the advert, and `<origin>/status`. */
export function runtimesOf(agent: Pick<AgentSpec, 'adverts'>): readonly RuntimeRef[] {
  return agent.adverts.map((advert) => ({ container: advert.runtimeContainer, statusUrl: `${advert.origin.replace(/\/+$/, '')}/status` }));
}

/**
 * Reads `running-images.json`: the map from the name of each container that runs to the image that it runs. The file must be there, be JSON of the shape `{ generated_at, images }` with
 * nothing else, name each container by a container name and each image by a repository with a sha256 digest, and be at most 10 minutes old at `nowMs`. An empty `images` object is a good
 * file: no container runs. Any other file is a PreconditionError, and nothing is signed. A refusal never shows a value of the file.
 */
export function readRunningImages(path: string, nowMs: number, io: Partial<ReadIo> = {}): ReadonlyMap<string, string> {
  if (!Number.isFinite(nowMs)) throw new PreconditionError(`the clock gave no valid time, so ${FILE} cannot be checked`);
  const files: ReadIo = { ...realIo, ...io };
  let text: string;
  try { text = files.read(path); } catch (err) {
    throw new PreconditionError(codeOf(err) === 'ENOENT' ? `${FILE} does not exist: the script that starts the container writes it before every run` : `${FILE} could not be read (${codeOf(err)})`);
  }
  if (text.length > MAX_FILE_CHARS) throw new PreconditionError(`${FILE} is longer than ${MAX_FILE_CHARS} characters, and a list of the running containers is not`);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new PreconditionError(`${FILE} is not JSON`); }
  if (!isRecord(parsed) || Object.keys(parsed).length !== 2 || !Object.hasOwn(parsed, 'generated_at') || !Object.hasOwn(parsed, 'images')) {
    throw new PreconditionError(`${FILE} does not have the shape that it must have: exactly the members generated_at and images`);
  }
  const generated = timeOf(parsed.generated_at);
  if (generated === null) throw new PreconditionError(`${FILE}: generated_at is not an ISO 8601 time with a zone`);
  if (nowMs - generated > MAX_AGE_MS) throw new PreconditionError(`${FILE} is more than 10 minutes old: the script that starts the container writes it before every run`);
  if (generated - nowMs > MAX_AHEAD_MS) throw new PreconditionError(`${FILE}: generated_at is in the future, so the clock or the file is wrong`);
  const images = parsed.images;
  if (!isRecord(images)) throw new PreconditionError(`${FILE}: images is not an object that maps a container to its image`);
  const running = new Map<string, string>();
  for (const [container, image] of Object.entries(images)) {
    if (!CONTAINER.test(container)) throw new PreconditionError(`${FILE}: a name in images is not a container name`);
    if (typeof image !== 'string' || !IMAGE.test(image)) throw new PreconditionError(`${FILE}: the image of a container is not a repository with a sha256 digest`);
    running.set(container, image);
  }
  return running;
}

/** The names of the containers that run, from `running-images.json`. The same checks as `readRunningImages`. */
export function readRunning(path: string, nowMs: number, io: Partial<ReadIo> = {}): ReadonlySet<string> {
  return new Set(readRunningImages(path, nowMs, io).keys());
}

type Answer = { readonly kind: 'free' } | { readonly kind: 'working' } | { readonly kind: 'unknown'; readonly why: string };
const unknown = (why: string): Answer => ({ kind: 'unknown', why });

/** The body of an answer as text, or null when it is longer than `max` bytes. The read stops as soon as the body passes `max`. */
async function limitedText(response: Response, max: number): Promise<string | null> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks, total));
}

/** What a runtime says at its status address. It never throws: a failure of any kind is an answer that says "cannot tell". */
async function answerOf(fetchImpl: typeof fetch, url: string, signal: AbortSignal): Promise<Answer> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal });
  } catch {
    return unknown('the request failed');
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    return unknown(`the answer has the status ${response.status}`);
  }
  let text: string | null;
  try { text = await limitedText(response, STATUS_BODY_BYTES); } catch { return unknown('the answer could not be read'); }
  if (text === null) return unknown(`the answer is longer than ${STATUS_BODY_BYTES} bytes`);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return unknown('the answer is not JSON'); }
  if (!isRecord(body)) return unknown('the answer is not a JSON object');
  const status = body.status;
  if (typeof status !== 'string') return unknown('the answer has no status text');
  if (status === 'free') return { kind: 'free' };
  if (status === 'working') return { kind: 'working' };
  return unknown('the status word is neither free nor working');
}

/** Asks one runtime. The request and the read of its body together have 10 seconds, and the request is aborted when they pass. */
async function ask(fetchImpl: typeof fetch, url: string): Promise<Answer> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<Answer>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(unknown(`no complete answer came within ${STATUS_LIMIT_MS / 1000} s`));
    }, STATUS_LIMIT_MS);
  });
  try {
    return await Promise.race([answerOf(fetchImpl, url, controller.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stops the task unless every runtime of the use case is free. A runtime whose container is not in `running` is not running: it passes, and the line says so, and it is not asked. A runtime
 * that runs is asked for its status address (10 seconds each, all at one time): the body must be a JSON object whose `status` is `free`, and its other members are ignored. `working`
 * is a PreconditionError that says that a job runs. Any other answer (a status code other than 200, a body that is not JSON, no status text, another word, a timeout, a failed request)
 * is a PreconditionError that says that it cannot tell, and never a pass. Every runtime is asked, and the error names each one that stops the task.
 */
export async function requireRuntimesFree(options: { fetchImpl: typeof fetch; runtimes: readonly RuntimeRef[]; running: ReadonlySet<string>; out: Output }): Promise<void> {
  const { fetchImpl, runtimes, running, out } = options;
  const answers = await Promise.all(runtimes.map((runtime) => (running.has(runtime.container) ? ask(fetchImpl, runtime.statusUrl) : null)));
  const problems: string[] = [];
  runtimes.forEach((runtime, index) => {
    const answer = answers[index];
    if (answer === null || answer === undefined) out.out(`the runtime ${runtime.container} is not running: it is not in ${FILE}, so it holds no job`);
    else if (answer.kind === 'free') out.out(`the runtime ${runtime.container} is running and says free`);
    else if (answer.kind === 'working') problems.push(`the runtime ${runtime.container} says working: a job runs`);
    else problems.push(`cannot tell whether the runtime ${runtime.container} works: ${answer.why}`);
  });
  if (problems.length > 0) throw new PreconditionError(`the task needs every runtime of the use case to say free, and ${problems.join('; ')}`);
}
