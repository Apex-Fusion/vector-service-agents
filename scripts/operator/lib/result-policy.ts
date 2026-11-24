// Validate the results policy of a loaded use case. The policy is not part of a published evidence file.
export const MOST_RESULT_REFS = 32;
export const RESULT_STEP_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export type ResultStepIndex<T> = ReadonlyMap<string, ReadonlyMap<string, T>>;

const REF_SHAPES = {
  attestation: 'hash', bidder: 'hash', case: 'hash', delegation: 'hash', transaction: 'hash',
  did: 'did', probe: 'text',
  challenge: 'output', claim: 'output', escrow: 'output', hold: 'output', record: 'output', vault: 'output',
} as const;
export type ResultRefKind = keyof typeof REF_SHAPES;

export function resultRefShape(kind: string): (typeof REF_SHAPES)[ResultRefKind] | undefined {
  return Object.hasOwn(REF_SHAPES, kind) ? REF_SHAPES[kind as ResultRefKind] : undefined;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isList: (value: unknown) => value is readonly unknown[] = Array.isArray;
const isWording = (value: unknown): boolean => typeof value === 'string' && value.length <= 200 && value.trim() !== '' && !/[|\r\n]/.test(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isLinks = (value: unknown): boolean => value === 0 || isCount(value);
const isRole = (value: unknown): boolean => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);
const isRoute = (value: unknown): boolean => typeof value === 'string' && /^[A-Z]+ \/\S*$/.test(value);
const PROOF_FIELDS = new Set(['refs', 'refusals', 'routes', 'projectedRoutes', 'recordFromTransaction', 'settlement']);

function legacyRoute(row: unknown): boolean {
  if (!Array.isArray(row) || row.length < 3 || row.length > 5) return false;
  const [route, credential, links, count, decision] = row;
  return isRoute(route) && (credential === 'token' || credential === 'jwt-svid' || credential === 'x509-svid') && (links === null || isLinks(links))
    && (count === undefined || isCount(count)) && (decision === undefined || decision === 'refused');
}

/** A projected event belongs to only one rule for a step. Its public log does not include the link count. */
function projectedRouteKey(row: unknown): string | null {
  if (!Array.isArray(row) || row.length !== 6) return null;
  const [route, credential, decision, links, count, status] = row;
  return isRoute(route) && (credential === 'token' || credential === 'jwt-svid') && (decision === 'allowed' || decision === 'refused')
    && isLinks(links) && isCount(count) && isCount(status) && status >= 100 && status <= 599
    ? `${route} ${credential} ${decision}` : null;
}

function nonemptyRules(value: unknown, accepts: (rule: unknown) => boolean): value is readonly unknown[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const rule of value) if (!accepts(rule)) return false;
  return true;
}

function isRefusalRule(kind: unknown): boolean {
  return kind === 'ledger' || kind === 'tool' || kind === 'projected-tool' || kind === 'source-tool';
}

function settlement(value: unknown): boolean {
  if (!isObject(value)) return false;
  const members = Object.keys(value).length;
  switch (value.type) {
    case 'none-recorded': return members === 1;
    case 'receipt': return members === 2 && isRole(value.handoffRole);
    case 'release': return members === 2 && isRole(value.hireRole);
    case 'intake-handoff': return members === 3 && isRole(value.intakeRole) && isRole(value.executeRole) && value.intakeRole !== value.executeRole;
    default: return false;
  }
}

function proofProblem(proof: unknown): string | null {
  if (!isObject(proof) || !Object.hasOwn(proof, 'refs') || !isObject(proof.refs)) return 'an evidence step has no results reference proof';
  if (Object.keys(proof).some((field) => !PROOF_FIELDS.has(field))) return 'an evidence step has an unknown results proof field';
  const refs = Object.entries(proof.refs);
  if (refs.length === 0) return 'an evidence step has no results reference thresholds';
  let needed = 0;
  for (const [kind, count] of refs) {
    if (resultRefShape(kind) === undefined) return 'an evidence step has an unknown results reference kind';
    if (!isCount(count) || (needed += count) > MOST_RESULT_REFS) return 'an evidence step has invalid results reference thresholds';
  }
  const { refusals, routes, projectedRoutes, recordFromTransaction } = proof;
  if (refusals !== undefined && (!nonemptyRules(refusals, isRefusalRule) || new Set(refusals).size !== refusals.length)) {
    return 'an evidence step has invalid results refusal kinds';
  }
  if (routes !== undefined && !nonemptyRules(routes, legacyRoute)) return 'an evidence step has an invalid results route rule';
  if (projectedRoutes !== undefined) {
    const invalid = 'an evidence step has an invalid projected results route rule';
    if (!Array.isArray(projectedRoutes) || projectedRoutes.length === 0) return invalid;
    const buckets = new Set<string>();
    for (const rule of projectedRoutes) {
      const key = projectedRouteKey(rule);
      if (key === null) return invalid;
      if (buckets.has(key)) return 'an evidence step repeats a projected results route rule';
      buckets.add(key);
    }
  }
  if (recordFromTransaction !== undefined && recordFromTransaction !== 'record' && recordFromTransaction !== 'hold') return 'an evidence step has an invalid transaction-linked results reference';
  return proof.settlement !== undefined && !settlement(proof.settlement) ? 'an evidence step has an invalid results settlement rule' : null;
}

/** Check and index the policy by declared run and step. Return a fixed error without input values. */
export function indexResultPolicy<T>(results: unknown, runs: unknown, steps: readonly T[]): ResultStepIndex<T> | string {
  if (!isObject(results)) return 'results is not an object';
  if (typeof results.runPrefix !== 'string' || !/^use-case-[1-9][0-9]*$/.test(results.runPrefix)) return 'results has no usable run prefix';
  const { wording } = results;
  if (!isObject(wording)) return 'results wording is not an object';
  if (!isList(runs)) return 'results has no list of run declarations';
  if (!isList(steps)) return 'results has no list of evidence steps';
  const index = new Map<string, Map<string, T>>();
  for (const run of runs) {
    if (!isObject(run) || (run.id !== 'clean' && run.id !== 'failure' && run.id !== 'lifecycle')) return 'results has an invalid run declaration';
    if (index.has(run.id)) return 'results has a duplicate run declaration';
    index.set(run.id, new Map());
  }
  const primitives = new Set<string>();
  for (const step of steps) {
    if (!isObject(step) || typeof step.id !== 'string' || !RESULT_STEP_ID.test(step.id)) return 'an evidence step has no usable results step id';
    const { id, run, primitive } = step;
    if (typeof run !== 'string' || (run === 'both' ? index.size === 0 : !index.has(run))) return 'an evidence step has no declared results run';
    if (typeof primitive !== 'string' || !Object.hasOwn(wording, primitive)) return 'an evidence step has no results wording';
    const text = wording[primitive];
    if (!isObject(text) || Object.keys(text).length !== 2 || !isWording(text.shows) || !isWording(text.doesNotShow)) {
      return 'an evidence step has no usable results sentences';
    }
    primitives.add(primitive);
    const problem = proofProblem(step.proof);
    if (problem !== null) return problem;
    for (const [kind, rows] of index) {
      if (run !== 'both' && run !== kind) continue;
      if (rows.has(id)) return 'an evidence step id applies more than once to a results run';
      rows.set(id, step);
    }
  }
  return Object.keys(wording).length === primitives.size ? index : 'results wording names a primitive with no evidence step';
}
