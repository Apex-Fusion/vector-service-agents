// agents/prior-authorization-agent/test/propose/golden.test.ts: the golden run of `propose`. The ports are fakes: the run reads the delegation, finds the paying key, reads the advert of the insurer, gets the
// record set and the guideline of the order `ORD-1001` through the evidence, asks the model once, takes the number, and builds the request that the golden file holds. Every record is synthetic. The list of the
// codes that the job writes is held to the job: a scenario writes each code of the list, and the list has no code that no scenario writes.
import { describe, expect, it } from 'vitest';
import { parsePriorAuthRequest, recordSetSha256, requestNumberOf } from '@vsa/usecase-kit/priorauth';
import { canonicalSha256, parseProposal, proposalDigest } from '@vsa/usecase-kit/protocol';
import type { ProposalResult } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES, ProposeRefusal } from '../../src/propose/index.ts';
import {
  ADVERT_REF, CHOICE, DECISION, DELEGATION, GUIDELINE, INSURER_DID, KEY, ORDER_ID, PORTS, RECORD_SET, SET_SHA256, SUB_JOB, TENANT, calledPorts, changed, expectFailed, golden, proposed, refusal, world,
} from './support.ts';

describe('the golden run', () => {
  it('proposes the request of the golden file, with a digest that covers it', async () => {
    const result = proposed(await world().run());
    expect(result).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'prior-authorization', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(result.document).toStrictEqual(golden('request'));
    expect(parsePriorAuthRequest(result.document).ok).toBe(true);
    expect(result.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalDigest(result.salt, result.document)).toStrictEqual({ ok: true, value: result.proposal_digest });
    expect(parseProposal({ document: result.document, salt: result.salt, proposal_digest: result.proposal_digest }).ok).toBe(true);
  });

  it('pins the golden hash of the record set and the golden digest of the request for a fixed salt', () => {
    const pinned = golden('digest');
    expect(SET_SHA256).toBe(pinned.record_set_sha256);
    expect(recordSetSha256(RECORD_SET)).toBe(pinned.record_set_sha256);
    expect(canonicalSha256(golden('record-set'))).toStrictEqual({ ok: true, value: pinned.record_set_sha256 });
    expect(proposalDigest(pinned.salt, golden('request'))).toStrictEqual({ ok: true, value: pinned.proposal_digest });
  });

  it('proposes the request of the order of the golden record set, for the insurer and the advert of the golden file', async () => {
    const result = proposed(await world().run());
    expect(result.document).toMatchObject({
      request_number: requestNumberOf(TENANT, 1), tenant: TENANT, order_id: ORDER_ID, insurer_did: INSURER_DID, advert_ref: ADVERT_REF, record_set_sha256: SET_SHA256,
    });
  });

  it('keeps the decision and the sub-job that bought it: one decision, named justification', async () => {
    const result = proposed(await world().run());
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(result.decisions.map((decision) => decision.name)).toStrictEqual(['justification']);
    expect(result.sub_jobs).toStrictEqual([SUB_JOB]);
    expect(result.sub_jobs).toStrictEqual(result.decisions.map((decision) => decision.inference.sub_job));
  });

  it('calls the six ports in this order, each once: the ledger, the key, the insurer, the evidence, the decision and the counter', async () => {
    const w = world();
    proposed(await w.run());
    expect(calledPorts(w)).toStrictEqual([...PORTS]);
    expect(w.insurerCalls).toStrictEqual([INSURER_DID]);
    expect(w.evidenceCalls).toHaveLength(1);
    expect(w.evidenceCalls[0]!.request).toStrictEqual({ tenant: TENANT, order_id: ORDER_ID, delegation: DELEGATION, key: KEY });
    expect(w.justifyCalls).toHaveLength(1);
    expect(w.counterCalls).toStrictEqual([TENANT]);
  });

  it('asks the model once with the golden record set and the golden guideline', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.justifyCalls[0]!.set).toStrictEqual(RECORD_SET);
    expect(w.justifyCalls[0]!.guideline).toStrictEqual(GUIDELINE);
  });

  it('keeps the choice of the model as it is: the justification and the references are the ones that the decision records', async () => {
    const result = proposed(await world().run());
    expect(result.document).toMatchObject({ justification: CHOICE.justification, guideline_refs: CHOICE.guideline_refs, record_refs: CHOICE.record_refs });
    expect(result.decisions[0]!.choice).toStrictEqual(DECISION.choice);
  });

  it('makes each proposal on its own: a second job gets the next number and a new salt', async () => {
    const w = world();
    const first = proposed(await w.run());
    const second = proposed(await w.run());
    expect(first.document.request_number).toBe('run1-1');
    expect(second.document.request_number).toBe('run1-2');
    expect(second.salt).not.toBe(first.salt);
    expect(second.proposal_digest).not.toBe(first.proposal_digest);
  });

  it('writes no line to the log for a proposal', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.logs).toStrictEqual([]);
  });
});

describe('the codes of a failed proposal', () => {
  it('are listed once each, and each has the form of a code', () => {
    expect(new Set(PROPOSE_FAILURES).size).toBe(PROPOSE_FAILURES.length);
    for (const code of PROPOSE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  /** For each code of the list, a job that writes it. */
  const SCENARIOS: Record<string, () => Promise<ProposalResult>> = {
    ledger_unavailable: () => {
      const w = world();
      w.script.delegation = async () => {
        throw new Error('the ledger is down');
      };
      return w.run();
    },
    delegation_not_found: () => {
      const w = world();
      w.script.delegateKeyOf = async () => null;
      return w.run();
    },
    delegation_key_unknown: () => {
      const w = world();
      w.script.findKey = () => null;
      return w.run();
    },
    insurer_not_listed: () => {
      const w = world();
      w.script.readInsurer = async () => refusal('insurer_not_listed');
      return w.run();
    },
    insurer_unavailable: () => {
      const w = world();
      w.script.readInsurer = async () => refusal('insurer_unavailable');
      return w.run();
    },
    record_set_mismatch: () => {
      const w = world();
      return w.run({ request: { order_id: 'ORD-1002' } });
    },
    guideline_mismatch: () => {
      const w = world();
      w.script.evidence = async () => ({ ok: true, record_set: RECORD_SET, guideline: changed(golden('guideline'), ['code'], 'SYN-CT-HEAD') as never });
      return w.run();
    },
    decision_mismatch: () => {
      const w = world();
      w.script.justify = async () => ({ ok: true, decision: DECISION, choice: { ...CHOICE, justification: 'Another text.' } });
      return w.run();
    },
    bad_document: () => {
      const w = world();
      w.script.justify = async () => ({ ok: true, decision: { ...DECISION, choice: { ...CHOICE, justification: '' } }, choice: { ...CHOICE, justification: '' } });
      return w.run();
    },
    store_write_failed: () => {
      const w = world();
      w.script.next = async () => {
        throw new Error('the disk is full');
      };
      return w.run();
    },
    deadline: () => {
      const w = world();
      w.script.evidence = () => new Promise(() => undefined);
      return w.run();
    },
    aborted: () => {
      const controller = new AbortController();
      controller.abort();
      return world().run({ signal: controller.signal });
    },
    internal: () => {
      const w = world();
      w.script.findKey = () => {
        throw new Error('the table is broken');
      };
      return w.run();
    },
  };

  it('are the codes that a job writes, one scenario for each code of the list and no code of the list without one', async () => {
    expect(Object.keys(SCENARIOS).sort()).toStrictEqual([...PROPOSE_FAILURES].sort());
    for (const [code, scenario] of Object.entries(SCENARIOS)) expectFailed(await scenario(), code);
  });

  it('are the reasons of a failed result, and a refusal is not a failed result: it is thrown with its status', async () => {
    const w = world();
    w.script.delegation = async () => ({ delegate: 'ff'.repeat(32), chain_whole: true });
    await expect(w.run()).rejects.toBeInstanceOf(ProposeRefusal);
  });
});
