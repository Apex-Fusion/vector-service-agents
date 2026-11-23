// agents/order-desk/test/job/golden.test.ts: the run in which every step passes. The job takes the record of the hook, gets an X.509-SVID, reads the catalogue, asks the model, places one order, writes the
// order book, and gives the confirmation. The golden file is the confirmation. The same run is the accepted twin of every refusal in the other files of this folder.
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import { CONFIRMATION_CHECKS, parseOrderConfirmation } from '@vsa/usecase-kit/inventory';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { expectNoSecrets, makeRig, sentOrder } from './rig.ts';
import { CATALOGUE_ENTRY, ESCROW_REF, ISSUER_DID, ATTESTATION_ID, PURCHASE_ORDER_SHA256, SENDER_DID, VALID_UNTIL, hashOf, purchaseOrder } from './samples.ts';

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8'));

describe('the golden run', () => {
  it('gives the confirmation of the golden file, and the parser of the kit takes it as it is', async () => {
    const rig = makeRig();
    const confirmation = await rig.run();
    expect(confirmation).toStrictEqual(golden('confirmation'));
    expect(parseOrderConfirmation(confirmation)).toStrictEqual({ ok: true, value: confirmation });
  });

  it('names the order as the purchase order says it, and the hash of the purchase order as it was received', async () => {
    const rig = makeRig();
    const confirmation = await rig.run();
    expect(confirmation).toMatchObject({
      schema: 'vector.usecase.order-confirmation.v1', outcome: 'done', po_number: 'run1-0001', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28', order_id: 'SO-run1-0001',
    });
    expect(confirmation.po_sha256).toBe(PURCHASE_ORDER_SHA256);
    expect(confirmation.po_sha256).toBe(hashOf(rig.request.document));
    expect(confirmation.po_sha256).not.toBe(hashOf(rig.request));
  });

  it('takes the sender, the approval and the 16 checks from the record of the hook', async () => {
    const confirmation = await makeRig().run();
    expect(confirmation.sender).toStrictEqual({ did: SENDER_DID, organisation: 'buyer.example', organisation_verified: true });
    expect(confirmation.approval).toStrictEqual({ attestation: ATTESTATION_ID, issuer_did: ISSUER_DID, valid_until: VALID_UNTIL });
    expect(Object.keys(confirmation.checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
    expect(Object.values(confirmation.checks)).toStrictEqual(CONFIRMATION_CHECKS.map(() => true));
    expect(JSON.stringify(confirmation)).not.toContain('approval_issuer_key_hash');
    expect(JSON.stringify(confirmation)).not.toContain('3c'.repeat(28));
  });

  it('holds exactly one decision, the decision availability, as the model gave it, with its choice and its reasoning', async () => {
    const rig = makeRig();
    const confirmation = await rig.run();
    expect(confirmation.decisions).toHaveLength(1);
    expect(confirmation.decisions[0]).toStrictEqual(rig.decision.ok ? rig.decision.value : null);
    expect(confirmation.decisions[0]?.name).toBe('availability');
    expect(confirmation.ship_by).toBe(rig.decision.ok ? rig.decision.value.choice.ship_by : 'no decision');
  });

  it('asks the model one time, and gives it the purchase order and the entry of the catalogue, and nothing else', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.decideInputs).toHaveLength(1);
    expect(rig.decideInputs[0]).toStrictEqual({ purchase_order: purchaseOrder(), catalogue_entry: CATALOGUE_ENTRY });
  });

  it('reaches the ports in this order: the record, the SVID, the catalogue, the decision, the order, and the order book', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide', 'order', 'book']);
    expect(rig.takes).toStrictEqual([ESCROW_REF]);
  });

  it('places exactly one order, with the six members that the portal takes, and the order book holds it', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.portal.orders.size).toBe(1);
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const order = sentOrder(rig.portal);
    expect(order).toStrictEqual({ po_number: 'run1-0001', po_sha256: PURCHASE_ORDER_SHA256, sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, ship_by: '2026-11-28' });
    expect(Object.keys(order)).toStrictEqual(['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by']);
    expect(rig.booked).toStrictEqual([['run1', 'run1-0001', 'SO-run1-0001']]);
  });

  it('calls the portal on the client-certificate host, with the X.509-SVID of the service key as the client certificate and its key', async () => {
    const rig = makeRig();
    await rig.run();
    const [read, write] = rig.portal.calls;
    expect(rig.portal.calls).toHaveLength(2);
    expect(read).toMatchObject({ method: 'GET', url: 'https://mock-mtls.example/t/run1/supplier/catalogue/GLV-NIT-M', body: null });
    expect(write).toMatchObject({ method: 'POST', url: 'https://mock-mtls.example/t/run1/supplier/orders' });
    expect(read?.headers).toStrictEqual({ accept: 'application/json' });
    expect(write?.headers).toStrictEqual({ accept: 'application/json', 'content-type': 'application/json' });
    for (const call of [read, write]) {
      const certificate = new X509Certificate(call?.cert ?? '');
      expect(certificate.subjectAltName).toContain(`spiffe://id.vector.apexfusion.org/agent/${rig.agent.id}`);
      expect(certificate.checkPrivateKey(createPrivateKey(call?.key ?? ''))).toBe(true);
    }
    expect(write?.cert).toBe(read?.cert);
    expect(write?.key).toBe(read?.key);
    expect(rig.gateway.requests.some((request) => request.method === 'POST' && request.path === '/spiffe/x509-svid')).toBe(true);
  });

  it('writes one line to the log, that names the order, and no key, certificate or token', async () => {
    const rig = makeRig();
    const confirmation = await rig.run();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('SO-run1-0001');
    expect(rig.logs[0]).toContain('run1-0001');
    expectNoSecrets(rig, [...rig.logs, JSON.stringify(confirmation)]);
  });

  it('gives the same confirmation when the service stamps it: the fault_mode of the stamp and the fault_mode of the job are one value', async () => {
    const rig = makeRig();
    const stamped = withFaultModeJob(rig.fault, (request: Handoff) => rig.run({ request }));
    expect(await stamped(rig.request)).toStrictEqual(golden('confirmation'));
  });

  it('is not changed by a log that throws', async () => {
    const rig = makeRig();
    rig.logThrows = true;
    expect(await rig.run()).toStrictEqual(golden('confirmation'));
    expect(rig.booked).toHaveLength(1);
  });

  it('is the same run for a request that the server parses again from the same text: the twin of a request of another body', async () => {
    const rig = makeRig();
    const again = JSON.parse(JSON.stringify(rig.request)) as Handoff;
    expect(await rig.run({ request: again })).toStrictEqual(golden('confirmation'));
  });

  it('gives a new object at each job, so a change of one confirmation cannot change another', async () => {
    const first = await makeRig().run();
    const second = await makeRig().run();
    expect(second).toStrictEqual(first);
    expect(second).not.toBe(first);
    expect(second.decisions).not.toBe(first.decisions);
  });
});
