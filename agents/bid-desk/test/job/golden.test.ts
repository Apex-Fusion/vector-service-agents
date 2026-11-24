// agents/bid-desk/test/job/golden.test.ts: the run in which every step passes. The job takes the record of the hook, asks the model, makes the arithmetic, reads the book again, gets the credential, builds the
// quote, records the request in the book, and gives the quote. The golden file is the quote. The same run is the accepted twin of every refusal in the other files of this folder.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway } from '@vsa/id-kit/testing';
import { QUOTE_CHECKS, checkQuoteAnswersRfq, checkQuoteFromList, parseQuote } from '@vsa/usecase-kit/bids';
import { withFaultModeJob } from '@vsa/usecase-kit/fault';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { runQuote } from '../../src/job/index.ts';
import { quoteInput } from '../../src/job/decision.ts';
import { expectCleanLog, makeRig } from './rig.ts';
import { CREDENTIAL, DESK_DID, ESCROW_REF, FACTS, PRICE_LIST, PRICE_LIST_SHA256, RFQ, RFQ_SHA256, SENDER_DID, T0, TODAY, choiceOf, decisionOf, hashOf, messageOf, recordFor } from './samples.ts';

const golden = (name: string): unknown => JSON.parse(readFileSync(new URL(`./golden/${name}.json`, import.meta.url), 'utf8'));

describe('the golden run', () => {
  it('gives the quote of the golden file, and the parser of the kit takes it as it is', async () => {
    const quote = await makeRig().run();
    expect(quote).toStrictEqual(golden('quote'));
    expect(parseQuote(quote)).toStrictEqual({ ok: true, value: quote });
  });

  it('has the members of the page in the order of the page, and fault_mode is the last one', async () => {
    const quote = await makeRig().run();
    expect(Object.keys(quote)).toStrictEqual([
      'schema', 'outcome', 'rfq_id', 'rfq_sha256', 'desk_did', 'organisation', 'lines', 'total', 'lead_time_days', 'valid_until', 'notes', 'price_list_sha256', 'credential', 'sender', 'checks', 'decisions',
      'fault_mode',
    ]);
  });

  it('names the request as it was received: its identifier, and the hash of the request, which is the hash of the canonical text', async () => {
    const quote = await makeRig().run();
    expect(quote.rfq_id).toBe('run1-rfq-1');
    expect(quote.rfq_sha256).toBe(RFQ_SHA256);
    expect(quote.rfq_sha256).toBe(hashOf(RFQ));
    expect(checkQuoteAnswersRfq(quote, RFQ)).toStrictEqual({ ok: true, value: null });
  });

  it('names the price list that it priced from, and the desk and its organisation', async () => {
    const quote = await makeRig().run();
    expect(quote.price_list_sha256).toBe(PRICE_LIST_SHA256);
    expect(checkQuoteFromList(quote, PRICE_LIST_SHA256)).toStrictEqual({ ok: true, value: null });
    expect(quote.desk_did).toBe(DESK_DID);
    expect(quote.organisation).toBe('supplier-alfa.example');
  });

  it('makes the three numbers from the lines: each line total, the total, and the longest lead time', async () => {
    const quote = await makeRig().run();
    expect(quote.lines.map((line) => line.line_total)).toStrictEqual([12_500, 8_750, 2_360]);
    expect(quote.total).toBe(12_500 + 8_750 + 2_360);
    expect(quote.lead_time_days).toBe(20);
  });

  it('takes the sender and the 7 checks from the record of the hook, in the order that the checks ran', async () => {
    const quote = await makeRig().run();
    expect(quote.sender).toStrictEqual({ did: SENDER_DID, organisation: 'buyer.example', organisation_verified: true });
    expect(Object.keys(quote.checks)).toStrictEqual([...QUOTE_CHECKS]);
    expect(Object.values(quote.checks).every((passed) => passed === true)).toBe(true);
  });

  it('shows the facts of the record as they are: a sender with no organisation, and one that is not verified', async () => {
    const rig = makeRig();
    rig.entry = recordFor(rig.request, { facts: { ...FACTS, organisation: null, organisation_verified: false } });
    expect((await rig.run()).sender).toStrictEqual({ did: SENDER_DID, organisation: null, organisation_verified: false });
  });

  it('holds exactly one decision, the decision quote, as the model gave it, with its choice and its reasoning', async () => {
    const rig = makeRig();
    const quote = await rig.run();
    expect(quote.decisions).toStrictEqual([decisionOf()]);
    expect(quote.decisions[0]?.name).toBe('quote');
    expect(quote.decisions[0]?.choice).toStrictEqual(choiceOf());
  });

  it('asks the model one time, and gives it the date, the items and the entries of the list for them, and nothing else', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.decideInputs).toStrictEqual([quoteInput(RFQ, PRICE_LIST, TODAY)]);
  });

  it('reaches the ports in this order: the record, the model, the book (read), the credential, and the book (write)', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential', 'record']);
    expect(rig.takes).toStrictEqual([ESCROW_REF]);
    expect(rig.credentialAsks).toStrictEqual([DESK_DID]);
  });

  it('records one quote in the book: the sender, the identifier of the request, and the hash of the quote that it gave', async () => {
    const rig = makeRig();
    const quote = await rig.run();
    expect(rig.booked).toStrictEqual([[SENDER_DID, 'run1-rfq-1', hashOf(quote)]]);
    expect(await rig.memory.has(SENDER_DID, 'run1-rfq-1')).toBe(true);
    expect(await rig.memory.has(SENDER_DID, 'run1-rfq-2')).toBe(false);
    expect(await rig.memory.has(`did:vector:${'f2'.repeat(32)}`, 'run1-rfq-1')).toBe(false);
  });

  it('writes one line to the log, and the line holds no credential, no price list, no key, no identifier of the request and no fault value', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain('gave a quote');
    expect(rig.logs[0]).toContain(`escrow ${ESCROW_REF}`);
    expectCleanLog(rig.logs);
  });

  it('gives the same quote when the service stamps it: the fault_mode of the stamp and the fault_mode of the job are one value', async () => {
    const rig = makeRig();
    const stamped = await withFaultModeJob(rig.fault, (request: RfqMessage, arrivedAt: number) => runQuote(rig.deps, request, rig.context, arrivedAt))(rig.request, T0);
    expect(stamped).toStrictEqual(golden('quote'));
    expect(Object.keys(stamped).at(-1)).toBe('fault_mode');
  });

  it('is not changed by a log that throws', async () => {
    const rig = makeRig();
    rig.logThrows = true;
    expect(await rig.run()).toStrictEqual(golden('quote'));
  });

  it('is the same run for a request that the server parses again from the same text: the twin of a request of another body', async () => {
    const rig = makeRig();
    expect(await rig.run({ request: messageOf() })).toStrictEqual(golden('quote'));
  });

  it('gives a new object at each job, and a change of the quote changes neither the decision of the model nor the sample choice', async () => {
    const rig = makeRig();
    const first = await rig.run();
    const second = await makeRig().run();
    expect(first).not.toBe(second);
    first.lines.forEach((line) => Object.assign(line, { unit_price: 1 }));
    Object.assign(first.decisions[0]!.choice as object, { notes: 'changed' });
    expect(second).toStrictEqual(golden('quote'));
    expect(rig.decision.ok && rig.decision.value.choice).toStrictEqual(choiceOf());
  });

  it('takes the credential of the stub gateway as it is: a real credential has the form that the quote holds', async () => {
    const gateway = createStubGateway();
    const desk = gateway.createAgent({ label: 'bid desk golden' });
    const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
    const issued = await client.credential(desk.did);
    expect(issued.ok).toBe(true);
    const rig = makeRig();
    rig.issued = issued;
    const quote = await rig.run();
    expect(quote.credential).toBe(issued.ok ? issued.value : '');
    expect(quote.credential).not.toBe(CREDENTIAL);
    expect(parseQuote(quote).ok).toBe(true);
  });
});
