// agents/bid-desk/test/job/credential.test.ts: step 6 of the job. The Bid Desk gets its credential from the identity gateway, after it read the book and before it builds the quote. A gateway that gives no
// credential, a call that throws, and a credential that is not a compact JWS (the form that a quote holds) are `credential_failed` (502): nothing is recorded, so the request stays free for another try. The
// log holds the rule and the status of the gateway, and never its detail or the credential. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { parseQuote } from '@vsa/usecase-kit/bids';
import { QUOTE_TEXT } from '../../src/job/refusal.ts';
import { expectCleanLog, expectNothingRecorded, gatewayFailure, makeRig, refusalOf } from './rig.ts';
import { CREDENTIAL, DESK_DID, choiceOf, quoteOf } from './samples.ts';

describe('a gateway that gives no credential', () => {
  it.each([
    ['gateway.refused', 409],
    ['gateway.unavailable', 503],
    ['gateway.bad_response', 200],
    ['gateway.unreachable', 0],
  ] as const)('ends the job with credential_failed (502) for %s (status %s), and nothing is recorded', async (rule, status) => {
    const rig = makeRig();
    rig.issued = gatewayFailure(rule, status);
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'credential_failed', status: 502, kind: 'job', message: QUOTE_TEXT.credential_failed });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(rig);
    expect(rig.logs).toHaveLength(1);
    expect(rig.logs[0]).toContain(`credential_failed: the gateway gave no credential: ${rule} (status ${status})`);
  });

  it('keeps the detail of the gateway out of the text for the buyer and out of the log', async () => {
    const rig = makeRig();
    rig.issued = gatewayFailure('gateway.unavailable', 503);
    const refusal = await refusalOf(rig.run());
    for (const text of [refusal.message, ...rig.logs]) expect(text).not.toContain('DETAIL-OF-THE-GATEWAY');
    expectCleanLog(rig.logs);
  });

  it('twin: a gateway that gives the credential passes, and the credential is asked for the DID of the desk one time', async () => {
    const rig = makeRig();
    expect(await rig.run()).toMatchObject({ outcome: 'done', credential: CREDENTIAL });
    expect(rig.credentialAsks).toStrictEqual([DESK_DID]);
  });

  it('leaves the request free: after a failed credential the book holds nothing, so a second try can give the quote', async () => {
    const rig = makeRig();
    rig.issued = gatewayFailure('gateway.unreachable', 0);
    await refusalOf(rig.run());
    expect(await rig.memory.has(rig.request.sender_did, 'run1-rfq-1')).toBe(false);
    rig.issued = { ok: true, value: CREDENTIAL };
    expect(await rig.run()).toMatchObject({ outcome: 'done' });
    expect(rig.booked).toHaveLength(1);
  });
});

describe('a call that throws', () => {
  it('ends the job with credential_failed (502), and the log holds the kind of the error and never its message', async () => {
    const rig = makeRig();
    rig.credentialError = new TypeError('https://gateway.example/agents/xyz refused the token secret-token-123');
    const refusal = await refusalOf(rig.run());
    expect(refusal).toMatchObject({ code: 'credential_failed', status: 502 });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(rig);
    expect(rig.logs[0]).toContain('TypeError');
    for (const text of [refusal.message, ...rig.logs]) {
      expect(text).not.toContain('secret-token-123');
      expect(text).not.toContain('gateway.example');
    }
  });
});

describe('a credential that is not a compact JWS', () => {
  const FORMS: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ['the credential of the samples', CREDENTIAL, true],
    ['three short parts', 'a.b.c', true],
    ['parts with hyphens and underscores', 'a-_.b-_.c-_', true],
    ['8192 characters, the most that a quote holds', `${'a'.repeat(8188)}.b.c`, true],
    ['8193 characters', `${'a'.repeat(8189)}.b.c`, false],
    ['the empty text', '', false],
    ['one part', 'abc', false],
    ['two parts', 'a.b', false],
    ['four parts', 'a.b.c.d', false],
    ['an empty part', 'a..c', false],
    ['a space', 'a.b.c d', false],
    ['a line break', 'a.b.c\n', false],
    ['a plus sign', 'a.b.c+', false],
    ['an equals sign of base64 padding', 'a.b.c=', false],
    ['a letter outside ASCII', 'ä.b.c', false],
    ['a number', 7, false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['a list', ['a.b.c'], false],
  ];

  it.each(FORMS.filter(([, , taken]) => !taken))('is credential_failed (502), and not internal, for %s: nothing is recorded', async (_what, credential) => {
    const rig = makeRig();
    rig.issued = { ok: true, value: credential as string };
    expect(await refusalOf(rig.run())).toMatchObject({ code: 'credential_failed', status: 502, message: QUOTE_TEXT.credential_failed });
    expect(rig.events).toStrictEqual(['take', 'decide', 'has', 'credential']);
    expectNothingRecorded(rig);
  });

  it.each(FORMS.filter(([, , taken]) => taken))('twin: %s passes, and the quote holds it as it is', async (_what, credential) => {
    const rig = makeRig();
    rig.issued = { ok: true, value: credential as string };
    expect(await rig.run()).toMatchObject({ outcome: 'done', credential });
  });

  it.each(FORMS)('is taken by the job exactly when the parser of the quote takes it: %s', async (_what, credential) => {
    const draft = { ...quoteOf(choiceOf()), credential };
    const rig = makeRig();
    rig.issued = { ok: true, value: credential as string };
    const passes = await rig.run().then(() => true, () => false);
    expect(passes).toBe(parseQuote(draft).ok);
  });

  it('does not log the credential that it refuses', async () => {
    const rig = makeRig();
    rig.issued = { ok: true, value: 'SECRET.PART one.c' };
    await refusalOf(rig.run());
    for (const line of rig.logs) {
      expect(line).not.toContain('SECRET');
      expect(line).not.toContain('PART one');
    }
  });
});
