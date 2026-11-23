// agents/reorder-agent/test/propose/golden.test.ts: the golden run of `propose`. The ledger of the sub-delegation, its clock and its keys are those of the tests of the access folder of the kit, and the real
// `withSubDelegation` runs over them. The run reads the supplier, makes the sub-delegation to `stock-reader`, reads the stock with the token of the subagent, ends the sub-delegation, asks the model once,
// and builds the purchase order that the golden file holds.
import { readFileSync } from 'node:fs';
import { resolveKey } from '@vsa/id-kit/client';
import { describe, expect, it } from 'vitest';
import { parsePurchaseOrder } from '@vsa/usecase-kit/inventory';
import { canonicalSha256, parseProposal, proposalDigest } from '@vsa/usecase-kit/protocol';
import { PROPOSE_FAILURES } from '../../src/propose/index.ts';
import {
  AGENT_KEY, BASES, DAY, DECISION, ERP_RESOURCE, LOTS, NOW, PARENT_ID, SKU, STOCK, SUBAGENT_DID, SUBAGENT_KEY, SUPPLIER, SUPPLIER_DID, WALLET, expectRecordedAndEnded, janitorPass, opsOf, proposed, world,
} from './support.ts';

const golden = JSON.parse(readFileSync(new URL('./golden/po.json', import.meta.url), 'utf8')) as Record<string, unknown>; // a golden file

describe('the golden run', () => {
  it('proposes the purchase order of the golden file, with a digest that covers it', async () => {
    const w = world();
    const result = proposed(await w.run());
    expect(result).toMatchObject({ schema: 'vector.usecase.proposal.v1', use_case: 'inventory-reorder', outcome: 'proposed', exit_state: null, reason: null, fault_mode: '' });
    expect(result.document).toStrictEqual(golden);
    expect(parsePurchaseOrder(result.document).ok).toBe(true);
    expect(result.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(proposalDigest(result.salt, result.document)).toStrictEqual({ ok: true, value: result.proposal_digest });
    expect(parseProposal({ document: result.document, salt: result.salt, proposal_digest: result.proposal_digest }).ok).toBe(true);
    expect(canonicalSha256(STOCK)).toStrictEqual({ ok: true, value: golden.stock_reading_sha256 });
  });

  it('keeps the decision and the sub-job that bought it', async () => {
    const result = proposed(await world().run());
    expect(result.decisions).toStrictEqual([DECISION]);
    expect(result.sub_jobs).toStrictEqual([DECISION.inference.sub_job]);
  });

  it('reads the supplier before it sends anything to the chain, and asks the model once with the reading and the three sizes of the lots', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.supplierCalls).toStrictEqual([{ supplier: SUPPLIER_DID, sku: SKU, chainCalls: 0 }]);
    expect(w.reorderCalls).toStrictEqual([{ reading: STOCK, lots: LOTS }]);
  });

  it('makes a sub-delegation of one action on one resource, with no value and no further hop, one level below the delegation of the hirer, signed by the two delegation keys', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.chain.params).toHaveLength(1);
    const params = w.chain.params[0]!;
    expect(params).toMatchObject({
      changeAddress: WALLET, parent: PARENT_ID, delegate: SUBAGENT_DID.slice('did:vector:'.length), delegateKey: SUBAGENT_KEY, actions: ['erp.stock.read'], resources: [ERP_RESOURCE], remaining: 0,
      value: { perTx: 0n, total: 0n, periodMs: DAY },
    });
    // The sub-delegation lasts longer than the wait for its confirmations and its job, and it ends inside the window of the job.
    expect(params.notAfter - NOW).toBeGreaterThan(600_000);
    expect(params.notAfter - NOW).toBeLessThan(1_620_000);
    expect(w.chain.submitted[0]!.cbor.endsWith(`+${AGENT_KEY.slice(0, 4)}+${SUBAGENT_KEY.slice(0, 4)}`)).toBe(true);
    expect(w.chain.submitted[1]!.cbor.endsWith(`${w.chain.builtUndelegates[0]!.txCbor}+${AGENT_KEY.slice(0, 4)}`)).toBe(true);
  });

  it('asks the gateway once for the token of the subagent under the sub-delegation, for the one route, and calls the ERP once with it', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.tokenRequests).toHaveLength(1);
    const request = w.tokenRequests[0]!;
    expect(request).toMatchObject({
      subject: { did: SUBAGENT_DID }, resource: ERP_RESOURCE, delegation: { identifier: w.chain.subId, actions: ['erp.stock.read'], locations: [ERP_RESOURCE] },
    });
    expect(resolveKey(request.subject.key).keyHash).toBe(w.keys.authentication.keyHash);
    expect(resolveKey(request.dpopKey).keyHash).toBe(w.keys.delegation.keyHash);
    expect(w.fetched).toHaveLength(1);
    expect(w.fetched[0]).toMatchObject({ url: `${BASES.publicBase}/t/run1/erp/stock/${SKU}`, method: 'GET' });
    expect(w.fetched[0]!.authorization).toMatch(/^DPoP /);
    expect(w.fetched[0]!.dpop).toBeTypeOf('string');
  });

  it('ends the sub-delegation, and keeps its records in this order: the id in use, the entry stored, the entry removed, the id out of use', async () => {
    const w = world();
    proposed(await w.run());
    await expectRecordedAndEnded(w);
    expect(w.sink.stored).toHaveLength(1);
    expect(w.sink.stored[0]).toMatchObject({
      signer_key_hash: AGENT_KEY, left: { id: w.chain.subId, parent: PARENT_ID, action: 'erp.stock.read', resource: ERP_RESOURCE, endTxHash: null },
    });
  });

  it('stores the entry and marks the id before the Delegate is sent, so a crash after the send leaves the record for the janitor', async () => {
    const w = world();
    const atSend: { entries: string[]; inUse: string[] }[] = [];
    const submit = w.chain.submit.bind(w.chain);
    w.chain.submit = async (cbor) => {
      atSend.push({ entries: [...w.sink.entries.keys()], inUse: [...w.live] });
      return submit(cbor);
    };
    proposed(await w.run());
    expect(atSend).toHaveLength(2);
    expect(atSend[0]).toStrictEqual({ entries: [w.chain.subId], inUse: [w.chain.subId] });
  });

  it('is not touched by a pass of the janitor while it waits for the 30 confirmations: the janitor leaves the delegation alone, and has nothing to do after the run', async () => {
    const w = world();
    proposed(await w.run());
    expect(w.janitorSeen).toStrictEqual([{ skipped: [w.chain.subId], taken: [] }]);
    expect(janitorPass(w.sink.entries, w.live)).toStrictEqual({ skipped: [], taken: [] });
  });

  it('keeps the choice of the model as it is: the lot, the quantity and the date are the ones that the model gave, and the advert is the advert of that lot', async () => {
    const w = world();
    w.script.reorder = async () => ({ ok: true, decision: DECISION, choice: { lot: 'lot-small', quantity: 99, needed_by: '2027-01-15' } });
    const result = proposed(await w.run());
    expect(result.document).toMatchObject({ lot: 'lot-small', quantity: 99, needed_by: '2027-01-15', advert_ref: SUPPLIER.adverts['lot-small'].advert_ref });
  });

  it('makes each proposal on its own: a second job gets the next number and a new salt', async () => {
    const w = world();
    const first = proposed(await w.run());
    const second = proposed(await w.run());
    expect(first.document.po_number).toBe('run1-1');
    expect(second.document.po_number).toBe('run1-2');
    expect(second.salt).not.toBe(first.salt);
    expect(second.proposal_digest).not.toBe(first.proposal_digest);
    expect(opsOf(w)).toStrictEqual(['add', 'put', 'remove', 'delete', 'add', 'put', 'remove', 'delete']);
  });

  it('lists the codes that it gives itself, and each has the form of a code', () => {
    expect(new Set(PROPOSE_FAILURES).size).toBe(PROPOSE_FAILURES.length);
    for (const code of PROPOSE_FAILURES) expect(code).toMatch(/^[a-z0-9_]{1,64}$/);
  });
});
