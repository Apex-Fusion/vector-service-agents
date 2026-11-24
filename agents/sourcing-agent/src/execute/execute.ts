// agents/sourcing-agent/src/execute/execute.ts
// The job `execute` of the Sourcing Agent (use case 3, supplier bid evaluation). It writes the ranking that the hirer approved to the sourcing record of the hirer, and it answers with a result of the
// protocol. The job makes no model call, no hire and no vault Pay: it needs one token for the route `sourcing.rankings` and one call. The sourcing record checks the approval and the status of the
// top-ranked supplier. This job never checks, makes, replaces or defaults an approval: it passes the reference on as the request gave it, or the member with the value `null`, and the record refuses what is
// not right. The steps, in order. A step that fails ends the job, and no later step runs.
//   0. The settings: the DID of the agent and the target of the sourcing record. A wrong setting is a fault of the service (`ExecuteRefusal`, `internal`), and it is found before any read.
//   1. The document must be a ranking (`bad_document`), and its tenant must be the tenant of the request (`ranking_not_for_tenant`). Nothing is read or sent for a ranking that fails here.
//   2. The authority: a delegation that names another agent is a refusal for the server (`ExecuteRefusal`, `delegation_not_mine`). A ledger that cannot be read is `ledger_unavailable`.
//   3. The delegation key. The token is bound to the delegate key of the delegation, so nothing is sent without that key: `delegation_not_found` when the ledger shows no delegation,
//      `delegation_key_unknown` when this agent holds no such key, `ledger_unavailable` when the ledger cannot be read.
//   4. One token for the route `sourcing.rankings` (`token_failed`). The job reads the signal of the caller before it asks.
//   5. One call (`POST /sourcing/rankings`). The body is `{ ranking, salt, approval }`: the ranking is the document of the proposal as the hirer holds it, never rebuilt, reordered or changed. The job
//      reads the signal again before the call. The call is made one time and never again, also after a failure: a call that failed may have written the ranking.
//   6. The answer of the record becomes a result:
//        201                                      completed, with the one write
//        refused_by_system, or a 4xx with a code  refused_by_system, with the code of the record as the reason (the exit state comes from the kit)
//        any other answer, and a status that is not 201 for an accepted write    failed, `mock_system_failed`
// Time. Every wait of the job is bounded by the deadline, `EXECUTE_DEADLINE_MS` after the arrival of the job. A wait that would start after it is not started, and a wait that is still open at it ends.
import { DEFAULT_CALL_TIMEOUT_MS, callWithToken, requestRouteToken, tokenTarget, within } from '@vsa/usecase-kit/access';
import type { SystemResult, TokenTarget } from '@vsa/usecase-kit/access';
import { parseRanking } from '@vsa/usecase-kit/bids';
import { BAD_DOCUMENT, checkAuthority, completedResult, failedResult, refusedResult } from '@vsa/usecase-kit/buyer';
import type { ResultPieces } from '@vsa/usecase-kit/buyer';
import { ERROR_STATUS, isPlainObject, parseDid } from '@vsa/usecase-kit/protocol';
import type { Did, ExecuteRequest, ExecuteResult, JsonValue, WriteRecord } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps } from './ports.ts';

/** The job ends 120,000 ms after its request arrived: one token and one call, each bounded by 60,000 ms. */
export const EXECUTE_DEADLINE_MS = 120_000;

/**
 * A request that the job refuses before it reads or sends anything but the delegation: a delegation that names another agent (`delegation_not_mine`, 400), a request that is not well formed (`bad_shape`,
 * 400), and a setting of the service that is wrong (`internal`, 500). The service answers with `code` and `status`. Nothing was sent to the sourcing record.
 */
export class ExecuteRefusal extends Error {
  readonly code: 'delegation_not_mine' | 'bad_shape' | 'internal';
  readonly status: number;

  constructor(code: 'delegation_not_mine' | 'bad_shape' | 'internal', message: string) {
    super(message);
    this.name = 'ExecuteRefusal';
    this.code = code;
    this.status = ERROR_STATUS[code];
  }
}

const USE_CASE = 'bid-evaluation';
const RECORD_SYSTEM = 'sourcing-record';
const RECORD_ROUTE = 'POST /sourcing/rankings';
/** The status of a ranking that the sourcing record wrote. */
const RECORDED = 201;
/** A reference that a result may hold for the ranking that the record wrote: 1 to 64 characters of letters, digits, dot, hyphen and underscore. Any other value of the answer is not kept. */
const RANKING_REF = /^[A-Za-z0-9._-]{1,64}$/;

/** The codes of a `failed` result that this job writes. The reason of a refusal by the sourcing record is the code of the record: it is a class, and it is not in this list. */
const FAILED = {
  document: BAD_DOCUMENT,
  tenant: 'ranking_not_for_tenant',
  ledger: 'ledger_unavailable',
  notFound: 'delegation_not_found',
  keyUnknown: 'delegation_key_unknown',
  aborted: 'aborted',
  deadline: 'deadline',
  token: 'token_failed',
  system: 'mock_system_failed',
} as const;

/** Every code that `runExecute` gives as the reason of a `failed` result, in the order of the steps. */
export const EXECUTE_FAILURES: readonly string[] = Object.freeze(Object.values(FAILED));

function piecesOf(request: ExecuteRequest, writes: readonly WriteRecord[] = []): ResultPieces {
  return { use_case: USE_CASE, proposal_digest: request.proposal.proposal_digest, handoff: null, writes, decisions: [], fault_mode: '' };
}

/** A log that never throws: a function that fails to log changes no result. */
function noteOf(log: ExecuteDeps['log']): (line: string) => void {
  return (line) => {
    try {
      log(line);
    } catch {
      // The line is lost, and the job goes on.
    }
  };
}

interface Settings {
  readonly agent: Did;
  readonly target: TokenTarget;
}

/** The settings that the job needs, as checked values. A wrong one is a fault of the service, and it is found before any read. */
function settingsOf(deps: ExecuteDeps, request: ExecuteRequest): Settings {
  const agent = parseDid(deps.agent.did, 'agent.did');
  if (!agent.ok) throw new ExecuteRefusal('internal', agent.detail);
  const target = tokenTarget(deps.calls.bases, request.tenant, 'sourcing.rankings');
  if (!target.ok) throw new ExecuteRefusal('internal', `the write to the sourcing record has no target: ${target.detail}`);
  return { agent: agent.value, target: target.value };
}

/** What the time of one job is made of: its deps and its deadline. */
interface Run {
  readonly deps: ExecuteDeps;
  readonly deadline: number;
}

/** The whole milliseconds that are left until the deadline, at most the whole window. 0 when the time is out, and when the clock gives no time. */
function timeLeft(run: Run): number {
  const left = Math.floor(Math.min(run.deadline - run.deps.clock(), EXECUTE_DEADLINE_MS));
  return left >= 1 ? left : 0;
}

type Waited<T> = { readonly state: 'value'; readonly value: T } | { readonly state: 'timed_out' };

/**
 * Runs a call of a port and gives its answer, or says that the time is out. The call is bounded by the time that is left until the deadline, and it is not made when no time is left. A failure of the
 * call is thrown to the caller.
 */
async function waited<T>(run: Run, work: () => Promise<T>): Promise<Waited<T>> {
  const left = timeLeft(run);
  if (left < 1) return { state: 'timed_out' };
  const bounded = await within(run.deps.calls.clock, left, () => work());
  return bounded.timedOut ? { state: 'timed_out' } : { state: 'value', value: bounded.value };
}

/**
 * The body of the call: the ranking as the hirer holds it, the salt, and the approval. The reference goes on as the request holds it, with every member that it has, and no approval is the member with the
 * value `null`. The sourcing record refuses a missing member, and it refuses a null approval with its own code. The copy of the reference only gives the type of a JSON object: no value changes.
 */
function bodyOf(request: ExecuteRequest): JsonValue {
  const { approval } = request;
  return { ranking: request.proposal.document, salt: request.proposal.salt, approval: approval === null ? null : { ...approval } };
}

/** What the call came to. The reason of a refusal is a code of the record, and a failure has no code of its own: `failed` and `mock_system_failed` say it. */
type Written =
  | { readonly kind: 'written'; readonly record: WriteRecord }
  | { readonly kind: 'refused'; readonly reason: string; readonly status: number }
  | { readonly kind: 'failed'; readonly status: number | null; readonly sent: boolean };

/**
 * Only the status 201 is a ranking that the record wrote. A refusal of the system (401 and 403) is a refusal. So is an error status below 500 with the code of a rule: the request was understood and
 * refused, and nothing was written. Any other end is a failure: it may have written the ranking, or not.
 */
function writeOf(sent: SystemResult): Written {
  if (sent.ok) {
    if (sent.status !== RECORDED) return { kind: 'failed', status: sent.status, sent: true };
    const ref: unknown = isPlainObject(sent.body) ? sent.body.ranking_id : undefined;
    return { kind: 'written', record: { system: RECORD_SYSTEM, route: RECORD_ROUTE, status: RECORDED, ref: typeof ref === 'string' && RANKING_REF.test(ref) ? ref : null } };
  }
  if (sent.code === 'refused_by_system') return { kind: 'refused', reason: sent.reason, status: sent.status };
  if (sent.status !== null && sent.status >= 400 && sent.status < 500 && sent.systemCode !== null) return { kind: 'refused', reason: sent.systemCode, status: sent.status };
  return { kind: 'failed', status: sent.status, sent: sent.sent };
}

/**
 * Writes the approved ranking of an `execute` request that arrived at `arrivedAt` (POSIX milliseconds). It throws `ExecuteRefusal` for a request that it refuses before it sends anything, and for a setting
 * that is wrong. It gives a result for every other end. The job ends `EXECUTE_DEADLINE_MS` after the arrival of the request. A caller that hung up (`signal`) before the token, or before the call, stops the
 * job with `failed` and `aborted`. The job reads the signal at those two points and never passes it into a call: a call that was sent runs to its end.
 */
export async function runExecute(deps: ExecuteDeps, request: ExecuteRequest, arrivedAt: number, signal?: AbortSignal): Promise<ExecuteResult> {
  const note = noteOf(deps.log);
  const settings = settingsOf(deps, request);
  const stop = (code: string, why: string): ExecuteResult => {
    note(`execute: ${why} (${code})`);
    return failedResult(piecesOf(request), code);
  };
  /** Reads the signal of the caller now. Each call is a new read: a second test of `signal.aborted` itself would keep the answer of the first for the compiler, though the caller may hang up in between. */
  const hungUp = (): boolean => signal?.aborted === true;

  const ranking = parseRanking(request.proposal.document, 'proposal.document');
  if (!ranking.ok) return stop(FAILED.document, 'the document of the proposal is not a ranking');
  // The sourcing record takes a ranking for the tenant of its URL and for no other, so a ranking of another tenant is not sent, and nothing is read for it.
  if (ranking.value.tenant !== request.tenant) return stop(FAILED.tenant, 'the ranking is for another tenant than the request');

  const run: Run = { deps, deadline: arrivedAt + EXECUTE_DEADLINE_MS };
  const authority = await waited(run, () => checkAuthority(deps.reads, settings.agent, request.authority.delegation));
  if (authority.state === 'timed_out') return stop(FAILED.deadline, 'no time is left to read the delegation');
  const checked = authority.value;
  if (!checked.ok) {
    if (checked.code === 'ledger_unavailable') return stop(FAILED.ledger, 'the ledger could not be read for the delegation');
    throw new ExecuteRefusal(checked.code, checked.detail);
  }

  let hash: string | null;
  try {
    const read = await waited(run, () => deps.delegateKeyOf(request.authority.delegation));
    if (read.state === 'timed_out') return stop(FAILED.deadline, 'no time is left to read the delegate key');
    hash = read.value;
  } catch {
    return stop(FAILED.ledger, 'the ledger could not be read for the delegate key');
  }
  // The DPoP key of the token is the delegate key of the delegation, so a delegation that the ledger does not show has no key, and nothing is sent.
  if (hash === null) return stop(FAILED.notFound, 'the ledger shows no delegation of this name');
  const entry = deps.delegationKeys.find(hash);
  if (entry === null) return stop(FAILED.keyUnknown, 'this agent holds no key with the key hash of the delegate key');

  if (hungUp()) return stop(FAILED.aborted, 'the caller hung up before the token');
  const asked = await waited(run, () =>
    requestRouteToken(deps.tokens, {
      target: settings.target, holder: 'agent', subject: { did: settings.agent, key: deps.agent.authenticationKey }, dpopKey: entry.dpopKey, delegation: request.authority.delegation,
    }),
  );
  if (asked.state === 'timed_out') return stop(FAILED.deadline, 'no time is left for the token');
  const token = asked.value;
  if (!token.ok) return stop(FAILED.token, `the gateway gave no token: ${token.code}, status ${token.status}`);

  // The token was the one wait that took the caller's time before the commitment, so the signal is read again here: a ranking is not written for a caller that is gone.
  if (hungUp()) return stop(FAILED.aborted, 'the caller hung up before the call');
  const left = timeLeft(run);
  if (left < 1) return stop(FAILED.deadline, 'no time is left for the call');
  const sent = await callWithToken({ ...deps.calls, timeoutMs: Math.min(deps.calls.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS, left) }, token.value, settings.target, bodyOf(request));

  const written = writeOf(sent);
  switch (written.kind) {
    case 'written':
      note(`execute: the sourcing record wrote the ranking (${written.record.status})`);
      return completedResult(piecesOf(request, [written.record]));
    case 'refused':
      note(`execute: the sourcing record refused the ranking (${written.reason}, status ${written.status})`);
      return refusedResult('system', piecesOf(request), written.reason);
    default:
      note(
        `execute: the call to the sourcing record failed (${FAILED.system}, status ${written.status ?? 'none'}): ${written.sent ? 'the ranking may be written' : 'nothing was sent'}, and the call is not made again`,
      );
      return failedResult(piecesOf(request), FAILED.system);
  }
}
