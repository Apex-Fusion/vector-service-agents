// agents/bid-desk/src/job/ports.ts
// The ports of the job of the Bid Desk. Everything that the job reads, writes or decides goes through one of them. The job reads no key file, no environment variable and no clock of its own. The service gives
// the real ports when it starts, and a test gives fakes. The types here are the whole contract between the job and the service.
//
// This file holds types only. The service builds one `QuoteDeps` for a job, and the job takes the record of the checks, the price list, the book, the credential, the model and the fault switch from it. The
// job takes no approval and calls no mock system: a quote needs neither.
import type { GatewayResult } from '@vsa/id-kit/client';
import type { PriceList } from '@vsa/usecase-kit/bids';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { Did, Digest, JsonValue } from '@vsa/usecase-kit/protocol';
import type { QuoteChoice } from './decision.ts';

/**
 * What the hook of the Bid Desk kept for one escrow: the record of the checks that passed, and the hash of the request that it checked (`canonicalSha256` of the whole message). It is a plain copy of the entry
 * of the store of the hook. This folder does not import the folder of the hook, so the shape is written here, and the service gives `take` of the store as `takeChecks`.
 */
export interface TakenChecks {
  readonly record: ChecksRecord;
  readonly request_sha256: Digest;
}

/**
 * The part of the book of the requests that the job uses. `has` answers whether the desk gave a quote for this request of this sender, and rejects when the book cannot answer. `record` stores the hash of the
 * quote that the desk gave: it resolves when the record is stored, and it rejects when it cannot store it. The key of the book is the DID of the sender and the identifier of the request, each as written.
 */
export interface BookPort {
  has(sender: Did, rfqId: string): Promise<boolean>;
  record(sender: Did, rfqId: string, quoteSha256: Digest): Promise<void>;
}

export interface QuoteDeps {
  /** The desk: its DID and its organisation, a domain name. Both stand in every quote that it gives. */
  readonly agent: { readonly did: Did; readonly organisation: string };
  /** The price list that the desk serves: the list as the kit parsed it, and the SHA-256 of its served bytes (the hash that the manifest holds). */
  readonly priceList: { readonly list: PriceList; readonly sha256: Digest };
  /** Takes the record that the hook kept for the escrow, and removes it. It gives null when there is none. The service gives `take` of the store of the hook, with its clock. */
  readonly takeChecks: (escrowRef: string) => TakenChecks | null;
  readonly book: BookPort;
  /** Gets the credential of the desk from the identity gateway: a compact JWS, or the failure of the gateway. The service gives `credential` of its gateway client. */
  readonly credential: (did: Did) => Promise<GatewayResult<string>>;
  /** Makes the decision `quote` for an input of the job. The service gives `decide` of the kit with `QUOTE_DECISION`, its limits and the deadline of the job. */
  readonly decide: (input: JsonValue) => Promise<DecideResult<QuoteChoice>>;
  /** The fault switch that the service made at its start. The job reads `mode` one time, and nothing else of the switch. */
  readonly fault: FaultSwitch<'bid-desk'>;
  /** The time now, in milliseconds: the clock that gave `arrivedAt`. The job uses it for the date of today, for the time of a log line, and for the time that is left until `deliver_by`. */
  readonly clock: () => number;
  /** Writes one line to the log of the service. A line has codes and references, and no key, no credential and no part of a request. A function that throws changes nothing. */
  readonly log: (line: string) => void;
}
