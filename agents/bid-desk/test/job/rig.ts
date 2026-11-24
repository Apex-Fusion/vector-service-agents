// agents/bid-desk/test/job/rig.ts
// The rig of the tests of the job. It joins a scripted decision, the real memory book of the hook (so that the port of the job fits the book that the service wires), a fake credential from the gateway, a
// clock that a test moves by hand, and the record of the checks that passed. Each port notes its call in `events`, so a test sees the order of the steps. No test of the job uses the network. A test builds a
// rig, changes one thing, and expects one result. The same rig with no change is the accepted twin.
import { expect } from 'vitest';
import type { GatewayResult } from '@vsa/id-kit/client';
import type { JobContext } from '@vsa/service-kit';
import type { PriceList, Quote } from '@vsa/usecase-kit/bids';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { accepted, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Did, FaultSetting, JsonValue, RfqMessage } from '@vsa/usecase-kit/protocol';
import { MemoryRfqBook } from '../../src/checks/index.ts';
import { QuoteRefusal, runQuote } from '../../src/job/index.ts';
import type { QuoteChoice, QuoteDeps, TakenChecks } from '../../src/job/index.ts';
import { ADVERT_REF, BUYER_PKH, CREDENTIAL, DESK_DID, DESK_ORGANISATION, ESCROW_REF, PRICE_LIST, PRICE_LIST_SHA256, RFQ_VALUE, T0, choiceOf, decisionOf, messageOf, recordFor } from './samples.ts';

export interface RigOptions {
  /** The setting of the fault switch. The default is the empty text. */
  readonly mode?: FaultSetting<'bid-desk'>;
  /** Members of the request for quotation that replace those of the sample. */
  readonly rfq?: Readonly<Record<string, JsonValue>>;
  /** The price list of the job. */
  readonly list?: PriceList;
  /** `takeChecks` removes the entry, as the store of the hook does. */
  readonly oneShot?: boolean;
  /** The time from the arrival of the job to the `deliver_by` of the escrow, in milliseconds. The default is 300,000. A negative number is an escrow whose `deliver_by` has passed. */
  readonly deliverInMs?: number;
}

export interface Rig {
  /** The order in which the job reached each port: `take`, `decide`, `has`, `credential` and `record`. */
  readonly events: string[];
  readonly logs: string[];
  /** The escrow reference of each call of `takeChecks`. */
  readonly takes: string[];
  /** The input of each call of `decide`. */
  readonly decideInputs: JsonValue[];
  /** The DID of each call of `credential`. */
  readonly credentialAsks: Did[];
  /** The quotes that the book recorded: the sender, the identifier of the request and the hash of the quote. */
  readonly booked: Array<readonly [string, string, string]>;
  /** The memory book behind the port: a test asks it whether it holds a request. */
  readonly memory: MemoryRfqBook;
  readonly fault: FaultSwitch<'bid-desk'>;
  readonly request: RfqMessage;
  readonly context: JobContext;
  readonly deps: QuoteDeps;
  /** The time that the clock gives, in milliseconds. A test moves it. */
  now: number;
  /** What `takeChecks` gives. A test changes it. */
  entry: TakenChecks | null;
  /** What `decide` answers. A test changes it. */
  decision: DecideResult<QuoteChoice>;
  /** What the gateway answers for the credential. A test changes it. */
  issued: GatewayResult<string>;
  /** An error that the credential call throws, or null. */
  credentialError: Error | null;
  /** An error that `has` rejects with, or null. */
  hasError: Error | null;
  /** What `has` answers instead of the book, or undefined to read the book. */
  hasAnswer: unknown;
  /** An error that `record` rejects with, or null. */
  bookError: Error | null;
  /** True when the log throws. */
  logThrows: boolean;
  run(over?: { readonly request?: RfqMessage; readonly signal?: AbortSignal }): Promise<Quote>;
}

/** A rig in which the job passes every step: the record is there, the model prices the request from the list, the book is empty, and the gateway gives the credential. */
export function makeRig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const logs: string[] = [];
  const takes: string[] = [];
  const decideInputs: JsonValue[] = [];
  const credentialAsks: Did[] = [];
  const booked: Array<readonly [string, string, string]> = [];
  const memory = new MemoryRfqBook();
  const fault = readFaultSwitch('bid-desk', options.mode ?? '');
  const request = messageOf({ ...RFQ_VALUE, ...options.rfq });
  const context: JobContext = {
    escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'bid-desk-v1', buyerPkh: BUYER_PKH, paymentLovelace: 5_000_000n, deliverByMs: T0 + (options.deliverInMs ?? 300_000),
  };
  const rig: Rig = {
    events, logs, takes, decideInputs, credentialAsks, booked, memory, fault, request, context,
    now: T0,
    entry: recordFor(request),
    decision: accepted(decisionOf()),
    issued: { ok: true, value: CREDENTIAL },
    credentialError: null,
    hasError: null,
    hasAnswer: undefined,
    bookError: null,
    logThrows: false,
    deps: {
      agent: { did: DESK_DID, organisation: DESK_ORGANISATION },
      priceList: { list: options.list ?? PRICE_LIST, sha256: PRICE_LIST_SHA256 },
      takeChecks: (escrowRef) => {
        events.push('take');
        takes.push(escrowRef);
        const given = rig.entry;
        if (options.oneShot === true) rig.entry = null;
        return given;
      },
      book: {
        has: async (sender, rfqId) => {
          events.push('has');
          if (rig.hasError !== null) throw rig.hasError;
          return rig.hasAnswer === undefined ? memory.has(sender, rfqId) : (rig.hasAnswer as boolean);
        },
        record: async (sender, rfqId, quoteSha256) => {
          events.push('record');
          if (rig.bookError !== null) throw rig.bookError;
          await memory.record(sender, rfqId, quoteSha256);
          booked.push([sender, rfqId, quoteSha256]);
        },
      },
      credential: async (did) => {
        events.push('credential');
        credentialAsks.push(did);
        if (rig.credentialError !== null) throw rig.credentialError;
        return rig.issued;
      },
      decide: async (input) => {
        events.push('decide');
        decideInputs.push(input);
        return rig.decision;
      },
      fault,
      clock: () => rig.now,
      log: (line) => {
        if (rig.logThrows) throw new Error('the log is closed');
        logs.push(line);
      },
    },
    run: (over = {}) => runQuote(rig.deps, over.request ?? request, context, T0, over.signal),
  };
  return rig;
}

/** The decision of the rig: a model that gives this choice. */
export function choosing(rig: Rig, choice: QuoteChoice = choiceOf()): void {
  rig.decision = accepted(decisionOf(choice));
}

/** The refusal that a job ends with. A job that gives a result, and a job that throws anything else, fail the test. */
export async function refusalOf(work: Promise<unknown>): Promise<QuoteRefusal> {
  let result: unknown;
  try {
    result = await work;
  } catch (error) {
    if (error instanceof QuoteRefusal) return error;
    throw error;
  }
  throw new Error(`the job gave a result and did not refuse: ${JSON.stringify(result).slice(0, 80)}`);
}

/** The gateway failure that a call for the credential gives. */
export const gatewayFailure = (rule: 'gateway.refused' | 'gateway.unavailable' | 'gateway.bad_response' | 'gateway.unreachable', status: number): GatewayResult<string> => ({
  ok: false, rule, detail: 'DETAIL-OF-THE-GATEWAY: the gateway said something that a log must not repeat', status, error: null, retryAfterSeconds: null,
});

/** Nothing was written: the book recorded no quote and was never asked to. */
export function expectNothingRecorded(rig: Rig): void {
  expect(rig.booked).toHaveLength(0);
  expect(rig.events).not.toContain('record');
}

/** The lines of a log hold no credential (nor a part of it), no price list, no key, and no identifier of the request. */
export function expectCleanLog(logs: readonly string[]): void {
  const forbidden = [CREDENTIAL, ...CREDENTIAL.split('.'), 'PRIVATE KEY', 'unit_price', 'breaks', 'min_quantity', 'run1-rfq-1', 'quote_off_price_list'];
  for (const line of logs) for (const text of forbidden) expect(line, text).not.toContain(text);
}

/** The date of today that the input of a decision holds. */
export function todayOf(input: JsonValue | undefined): string {
  if (isPlainObject(input) && typeof input.today === 'string') return input.today;
  throw new Error('the input of the decision holds no date of today');
}
