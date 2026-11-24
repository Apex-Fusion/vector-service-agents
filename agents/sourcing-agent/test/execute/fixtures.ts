// agents/sourcing-agent/test/execute/fixtures.ts
// The documents that the tests of the job `execute` share: the ranking that the hirer approved (a golden file), the approval reference, and the `execute` request that the protocol parser gives. No
// value is a key. A document is a plain object that a test changes with `over`, so that a test names what it changes.
import { readFileSync } from 'node:fs';
import { makeProposal, parseRequest } from '@vsa/usecase-kit/protocol';
import type { ExecuteRequest } from '@vsa/usecase-kit/protocol';

export const PRINCIPAL_DID = `did:vector:${'b2'.repeat(32)}`;
export const SALT = '33'.repeat(32);
export const TENANT = 'run1';
export const APPROVAL = { attestation: '22'.repeat(32), issuer_did: PRINCIPAL_DID } as const;

export type Json = Record<string, unknown>;
export type GoldenName = 'ranking' | 'completed' | 'refused-null-approval';

/** The exact text of a golden file. */
export const goldenText = (name: GoldenName): string => readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8');

/** A fresh value of a golden file, so that a test can change a member without changing the sample. */
export const golden = (name: GoldenName): Json => JSON.parse(goldenText(name)) as Json;

/**
 * The ranking of the tests: the golden file, with the members that `over` names replaced. The members of the golden file are not in the order that the parser of the kit writes them, and the same holds
 * for the members of its weights, its components and its quotes. So a job that builds the ranking again from its parts sends other bytes than the document that the hirer approved.
 */
export function rankingDocument(over: Json = {}): Json {
  return { ...golden('ranking'), ...over };
}

/** The `execute` request for a document, as the protocol parser gives it. The tenant of the request is the tenant of the tests unless another is given. */
export function executeRequest(document: unknown, delegation: string, approval: unknown = APPROVAL, tenant: string = TENANT): ExecuteRequest {
  const proposal = makeProposal(document, SALT);
  if (!proposal.ok) throw new Error(`the proposal of the test is refused: ${proposal.detail}`);
  const parsed = parseRequest({ op: 'execute', authority: { principal_did: PRINCIPAL_DID, delegation }, tenant, proposal: proposal.value, approval });
  if (!parsed.ok) throw new Error(`the request of the test is refused: ${parsed.detail}`);
  if (parsed.value.op !== 'execute') throw new Error('the request of the test is not an execute request');
  return parsed.value;
}
