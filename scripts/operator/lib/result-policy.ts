// Validate the results policy of a loaded use case. The policy is not part of a published evidence file.
export const MOST_RESULT_REFS = 32;

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

function projectedRoute(row: unknown): boolean {
  if (!Array.isArray(row) || row.length !== 6) return false;
  const [route, credential, decision, links, count, status] = row;
  return isRoute(route) && (credential === 'token' || credential === 'jwt-svid') && (decision === 'allowed' || decision === 'refused')
    && isLinks(links) && isCount(count) && isCount(status) && status >= 100 && status <= 599;
}

function settlement(value: unknown): boolean {
  if (!isObject(value)) return false;
  switch (value.type) {
    case 'none-recorded': return true;
    case 'receipt': return isRole(value.handoffRole);
    case 'release': return isRole(value.hireRole);
    case 'intake-handoff': return isRole(value.intakeRole) && isRole(value.executeRole) && value.intakeRole !== value.executeRole;
    default: return false;
  }
}

function proofProblem(proof: unknown): string | null {
  if (!isObject(proof) || !isObject(proof.refs)) return 'an evidence step has no results reference proof';
  if (Object.keys(proof).some((field) => !PROOF_FIELDS.has(field))) return 'an evidence step has an unknown results proof field';
  const refs = Object.entries(proof.refs);
  if (refs.length === 0) return 'an evidence step has no results reference thresholds';
  let needed = 0;
  for (const [kind, count] of refs) {
    if (resultRefShape(kind) === undefined) return 'an evidence step has an unknown results reference kind';
    if (!isCount(count) || (needed += count) > MOST_RESULT_REFS) return 'an evidence step has invalid results reference thresholds';
  }
  const { refusals, routes, projectedRoutes, recordFromTransaction } = proof;
  if (refusals !== undefined && (!Array.isArray(refusals) || refusals.length === 0 || new Set(refusals).size !== refusals.length
      || !refusals.every((kind: unknown) => kind === 'ledger' || kind === 'tool' || kind === 'projected-tool'))) return 'an evidence step has invalid results refusal kinds';
  if (routes !== undefined && (!Array.isArray(routes) || routes.length === 0 || !routes.every(legacyRoute))) return 'an evidence step has an invalid results route rule';
  if (projectedRoutes !== undefined && (!Array.isArray(projectedRoutes) || projectedRoutes.length === 0 || !projectedRoutes.every(projectedRoute))) return 'an evidence step has an invalid projected results route rule';
  if (recordFromTransaction !== undefined && recordFromTransaction !== 'record' && recordFromTransaction !== 'hold') return 'an evidence step has an invalid transaction-linked results reference';
  return proof.settlement !== undefined && !settlement(proof.settlement) ? 'an evidence step has an invalid results settlement rule' : null;
}

/** Check the complete policy without reading a file, loading a second case or showing its values. */
export function resultPolicyProblem(results: unknown, steps: readonly unknown[]): string | null {
  if (!isObject(results)) return 'results is not an object';
  if (typeof results.runPrefix !== 'string' || !/^use-case-[1-9][0-9]*$/.test(results.runPrefix)) return 'results has no usable run prefix';
  const { wording } = results;
  if (!isObject(wording)) return 'results wording is not an object';
  const primitives = new Set<string>();
  for (const step of steps) {
    if (!isObject(step) || typeof step.primitive !== 'string' || !Object.hasOwn(wording, step.primitive)) return 'an evidence step has no results wording';
    const text = wording[step.primitive];
    if (!isObject(text) || Object.keys(text).length !== 2 || !isWording(text.shows) || !isWording(text.doesNotShow)) {
      return 'an evidence step has no usable results sentences';
    }
    primitives.add(step.primitive);
    const problem = proofProblem(step.proof);
    if (problem !== null) return problem;
  }
  return Object.keys(wording).length === primitives.size ? null : 'results wording names a primitive with no evidence step';
}
