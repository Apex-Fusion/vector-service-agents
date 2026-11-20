// packages/usecase-kit/test/cosign/contract.test.ts
// The wire contract of the hosted tool `vector_delegation_request_cosign`, as the route keeps it: the path, the six refusal codes with a 4xx each, the other codes with the statuses of the protocol, and
// the rule in words for the manifest of a buyer-side agent.
import { describe, expect, it } from 'vitest';
import { ERROR_STATUS } from '@vsa/usecase-kit/protocol';
import type { ManifestCosign } from '@vsa/usecase-kit/protocol';
import { COSIGN_MANIFEST, COSIGN_PATH, COSIGN_REFUSALS, COSIGN_STATUS } from '@vsa/usecase-kit/cosign';

/** The refusal codes that the tool names in its text for operators, in its own order. */
const TOOL_CODES = ['not_a_delegation', 'not_for_this_agent', 'key_in_use', 'principal_not_allowed', 'spends_agent_funds', 'expired'];

describe('the codes of the route', () => {
  it('have the status that the table of the route gives to each refusal', () => {
    expect(COSIGN_REFUSALS).toEqual({ not_a_delegation: 400, not_for_this_agent: 400, key_in_use: 409, principal_not_allowed: 403, spends_agent_funds: 403, expired: 400 });
  });

  it('are the six refusal codes of the wire contract, and no other refusal', () => {
    expect(Object.keys(COSIGN_REFUSALS)).toEqual(TOOL_CODES);
  });

  it('give each refusal a 4xx that is not 404 or 405: the tool reads these two as a route that is not served', () => {
    for (const [code, status] of Object.entries(COSIGN_REFUSALS)) {
      expect(status, code).toBeGreaterThanOrEqual(400);
      expect(status, code).toBeLessThan(500);
      expect([404, 405], code).not.toContain(status);
    }
  });

  it('take the statuses of the protocol for the codes that the protocol names', () => {
    for (const code of ['bad_shape', 'request_too_large', 'check_unavailable', 'busy', 'internal'] as const) expect(COSIGN_STATUS[code], code).toBe(ERROR_STATUS[code]);
  });

  it('are a 5xx only for a source that cannot be read and for a fault of the service: such an answer is never a refusal', () => {
    const faults = Object.entries(COSIGN_STATUS).filter(([, status]) => status >= 500).map(([code]) => code).sort();
    expect(faults).toEqual(['check_unavailable', 'internal']);
  });

  it('use the statuses of HTTP for a method and a content type that the route does not take', () => {
    expect([COSIGN_STATUS.method_not_allowed, COSIGN_STATUS.unsupported_media_type]).toEqual([405, 415]);
  });

  it('have the path that the tool calls', () => {
    expect(COSIGN_PATH).toBe('/cosign/delegate');
  });
});

describe('the rule in the manifest', () => {
  it('is the type of the manifest, with the path of the route', () => {
    const manifest: ManifestCosign = COSIGN_MANIFEST;
    expect(manifest.route).toBe(COSIGN_PATH);
  });

  it('names each clause of the rule that the route checks', () => {
    const rule = COSIGN_MANIFEST.rule.toLowerCase();
    const clauses = [
      'delegate transaction', 'names this agent', 'delegation key', 'signed the transaction first', 'allowlist', 'no live delegation', 'spend nothing of the agent', 'no certificate', 'no withdrawal', 'no other mint',
      'validity window', 'period of the delegation', 'one witness',
    ];
    for (const clause of clauses) {
      expect(rule, clause).toContain(clause);
    }
  });

  it('is one text of plain sentences that the manifest can hold: it has no new line and no markup', () => {
    expect(COSIGN_MANIFEST.rule).not.toMatch(/[\n<>{}`]/);
    expect(COSIGN_MANIFEST.rule.length).toBeLessThan(1_000);
  });
});
