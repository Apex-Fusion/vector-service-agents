// agents/order-desk/src/job/ports.ts
// The ports of the job of the Order Desk. Everything that the job reads, writes or decides goes through one of them. The job reads no key file, no environment variable and no clock of its own. The
// service gives the real ports when it starts, and a test gives fakes. The types here are the whole contract between the job and the service.
//
// This file holds types only. The service builds one `OrderDeps` for a job, and the job takes the fault switch, the record of the checks, the gateway, the supplier portal, the model and the order book
// from it.
import type { KeyInput } from '@vsa/id-kit/client';
import type { CallDeps, MtlsTransport, SvidDeps } from '@vsa/usecase-kit/access';
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { DecideResult } from '@vsa/usecase-kit/decision';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { LotsFile } from '@vsa/usecase-kit/inventory';
import type { Did, Digest, JsonValue } from '@vsa/usecase-kit/protocol';
import type { AvailabilityChoice } from './availability.ts';

/**
 * What the hook of the Order Desk kept for one escrow: the record of the checks that passed, and the hash of the request that it checked (`canonicalSha256` of the handoff). It is a plain copy of the entry
 * of the store of the hook. This folder does not import the folder of the hook, so the shape is written here, and the service gives `take` of the store as `takeChecks`.
 */
export interface TakenChecks {
  readonly record: ChecksRecord;
  readonly request_sha256: Digest;
}

/** The part of the order book that the job uses: it records the order that the portal took. It resolves when the record is stored, and it rejects when it cannot store it. */
export interface BookPort {
  record(tenant: string, poNumber: string, orderId: string): Promise<void>;
}

export interface OrderDeps {
  /** The service key: the DID of the Order Desk and its authentication key. The key signs the request for the X.509-SVID, and nothing else. */
  readonly agent: { readonly did: Did; readonly authenticationKey: KeyInput };
  /** The client of the identity gateway, for the X.509-SVID. */
  readonly svid: SvidDeps;
  /**
   * The calls to the supplier portal: the `fetch` and the clock of the caller, the two origins of the mock service, and the transport that presents the X.509-SVID as the client certificate. A call with a
   * client certificate goes through the transport and never through `fetch`.
   */
  readonly calls: CallDeps & { readonly transport: MtlsTransport };
  /** Takes the record that the hook kept for the escrow, and removes it. It gives null when there is none. The service gives `take` of the store of the hook, with its clock. */
  readonly takeChecks: (escrowRef: string) => TakenChecks | null;
  /** The lots file that the Order Desk serves. The job reads it for the fault only. */
  readonly lots: LotsFile;
  readonly book: BookPort;
  /** Makes the decision `availability` for an input of the job. The service gives `decide` of the kit with `AVAILABILITY_DECISION`, its limits and the deadline of the job. */
  readonly decide: (input: JsonValue) => Promise<DecideResult<AvailabilityChoice>>;
  /** The fault switch that the service made at its start. The job reads `mode` one time, and nothing else of the switch. */
  readonly fault: FaultSwitch<'order-desk'>;
  /** The time now, in milliseconds: the clock that gave `arrivedAt`. The job uses it for the time of a log line. */
  readonly clock: () => number;
  /** Writes one line to the log of the service. A line has codes and references, and no key, no token and no part of a request. A function that throws changes nothing. */
  readonly log: (line: string) => void;
}
