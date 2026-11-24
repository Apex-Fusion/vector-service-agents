// agents/sourcing-agent/test/scoring/support.ts: what the tests of the scoring folder share: the data of the golden run (the request, the three bidders with their quotes and files, the vendor master, and the three
// scores that the model gives), the answers of the gateway and of the vendor master that a test scripts, and the checks on a result. No test uses the network, and no test waits for real time.
import { readFileSync } from 'node:fs';
import type { GatewayRefused } from '@vsa/id-kit/client';
import { parseQuote, parseRfqDocument, parseWeights } from '@vsa/usecase-kit/bids';
import type { Quote, RfqDocument, Weights } from '@vsa/usecase-kit/bids';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Decision } from '@vsa/usecase-kit/protocol';
import { expect } from 'vitest';
import type { BidderFile, ScoreAnswer, ScoreSubject, ScoredQuote, ScoringInput, ScoringResult, VendorEntry } from '../../src/scoring/index.ts';

export { AGENT_KEY, BASES, DAY, FakeClock, NOW, PARENT_ID, SCRIPT, WALLET, claimsOf, markSigner, parentDatum, slotOf } from '../../../../packages/usecase-kit/test/access/support.ts';

const readJson = (url: URL): unknown => JSON.parse(readFileSync(url, 'utf8'));

export const TENANT = 'run1';
export const TODAY = '2026-11-20';

/** The vendor master of the golden run: the default data of the mock service, as the body of `GET /vendors`. */
// The golden file holds the default vendors of the mock service, and `vendors.test.ts` holds the parser to it.
export const VENDORS_BODY = readJson(new URL('./golden/vendors-default.json', import.meta.url)) as { readonly vendors: readonly VendorEntry[] };

/** The three bidders of the golden run. The first is the first subject, and its scorer is the first scorer. */
export const BIDDERS = [
  { did: `did:vector:${'a1'.repeat(32)}`, organisation: 'alfa.example.org' },
  { did: `did:vector:${'b2'.repeat(32)}`, organisation: 'bravo.example.org' },
  { did: `did:vector:${'c3'.repeat(32)}`, organisation: 'charlie.example.org' },
] as const;

/** The three scores of the golden run, as the decision `score` gives them: one for each bidder, in the order of the bidders. */
export const GOLDEN_SCORES = readJson(new URL('./golden/scores.json', import.meta.url)) as readonly ScoredQuote[];

const KIT_GOLDEN = new URL('../../../../packages/usecase-kit/test/bids/golden/', import.meta.url);

function checked<T>(result: { ok: true; value: T } | { ok: false; detail: string }): T {
  if (!result.ok) throw new Error(`the sample of the test is not accepted by the kit: ${result.detail}`);
  return result.value;
}

export const RFQ: RfqDocument = checked(parseRfqDocument(readJson(new URL('rfq.json', KIT_GOLDEN))));
export const WEIGHTS: Weights = checked(parseWeights({ price: 0.4, lead_time: 0.2, reliability: 0.2, compliance: 0.2 }));

/** The quote of a bidder: the golden quote of the kit with the DID and the organisation of the bidder. The kit parser accepts it. */
export function quoteOf(did: string, organisation: string): Quote {
  const golden = readJson(new URL('quote.json', KIT_GOLDEN)) as Record<string, unknown>;
  return checked(parseQuote({ ...golden, desk_did: did, organisation }));
}

/** The file of a bidder: every member that the model reads, with the facts of a bidder in good standing. */
export function fileOf(did: string, organisation: string | null): BidderFile {
  return {
    did,
    advert_ref: `${'d4'.repeat(32)}#0`,
    status: 'active',
    status_reason: null,
    lineage: { hold_until: null, ended_at: null, invalid_from: null, successor: null, recovery_pending: false },
    accountable: 'ee'.repeat(28),
    organisation,
    organisation_verified: organisation !== null,
    in_catalog: true,
    stake_lovelace: '5000000',
    cases_against: 0,
    price_list: 'valid',
    compliance: { state: 'valid', attestation: 'f5'.repeat(32), attestation_state: 'active', issued_at: '2026-11-01T00:00:00Z', valid_until: '2027-11-01T00:00:00Z', revoked_at: null, revoke_reason: null, contested: null },
    credential: 'valid',
  };
}

/** A subject for a bidder. The organisation of the subject is the verified organisation: `null` for a bidder that no check backs. */
export function subjectOf(did: string, organisation: string | null): ScoreSubject {
  return { did, organisation, quote: quoteOf(did, organisation ?? 'alfa.example.org'), file: fileOf(did, organisation) };
}

/** The input of the golden run: three subjects. `PARENT_ID` is the delegation of the hirer. */
export function inputOf(delegation: string, subjects: readonly ScoreSubject[] = BIDDERS.map((bidder) => subjectOf(bidder.did, bidder.organisation))): ScoringInput {
  return { tenant: TENANT, delegation, today: TODAY, weights: WEIGHTS, rfq: RFQ, subjects };
}

/** The answer of the decision `score` for a bidder of the golden run: its golden decision, and the choice that the decision records. A copy, so that a test can change it. */
export function scoreAnswerFor(did: string): ScoreAnswer {
  const golden = GOLDEN_SCORES.find((score) => score.did === did);
  if (golden === undefined) throw new Error('the golden run has no score for this bidder');
  return { ok: true, decision: structuredClone(golden.decision), choice: structuredClone(golden.choice) };
}

/** The decision of an answer that must be an answer with a decision. */
export function decisionOf(answer: ScoreAnswer): Decision {
  if (!answer.ok) throw new Error('the answer of the test is a failure');
  return answer.decision;
}

// --- the gateway and the vendor master -----------------------------------------------------------------------------------------------------------

export const gatewayRefused = (status: number, error: string, detail: string): GatewayRefused => ({ ok: false, rule: 'gateway.refused', detail, status, error, retryAfterSeconds: null });
/** The answer of the gateway for a delegation that has fewer than 30 confirmations: the one text that the access folder reads as `delegation_too_young`. */
export const tooYoung = (): GatewayRefused => gatewayRefused(400, 'invalid_authorization_details', `delegation ${'ab'.repeat(32)} has fewer than 30 confirmations`);
export const gatewayDown = (rule: 'gateway.unavailable' | 'gateway.unreachable' | 'gateway.bad_response', status: number): GatewayRefused => ({ ok: false, rule, detail: 'no usable answer', status, error: null, retryAfterSeconds: null });

/** The answer of the vendor master: a JSON body and a status. */
export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// --- what a test reads ------------------------------------------------------------------------------------------------------------------------

/** The scores of a result that must be a list of scores. */
export function scoresOf(result: ScoringResult): readonly ScoredQuote[] {
  if (!result.ok) throw new Error(`the scoring failed with the code ${result.code}, and the test expected scores`);
  return result.scores;
}

/** A failed scoring with this code and these decisions, and nothing else. */
export function expectFailed(result: ScoringResult, code: string, decisions: readonly Decision[] = []): void {
  expect(result).toStrictEqual({ ok: false, code, decisions });
}

// The library of the compiler of the repository (ES2022) has no `Promise.withResolvers`, so these two use the executor form.
/** A call that never gets an answer. */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

/** A call that a test answers later, from outside. */
export function later<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value) => resolve(value) };
}

/**
 * A fault switch that a caller made by hand, with a getter that counts the reads of `mode`. The kit makes the real ones, and its type is sealed: a test of a text that the kit refuses, or of the number of reads,
 * needs this one.
 */
export function handMadeSwitch(mode: unknown): { readonly fault: FaultSwitch<'sourcing-agent'>; readonly reads: () => number } {
  let reads = 0;
  const made = {
    kind: 'sourcing-agent',
    get mode(): unknown {
      reads += 1;
      return mode;
    },
  };
  // The test needs a switch that the kit would not make.
  const fault = made as unknown as FaultSwitch<'sourcing-agent'>;
  return { fault, reads: () => reads };
}
