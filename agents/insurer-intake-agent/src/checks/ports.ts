// agents/insurer-intake-agent/src/checks/ports.ts
// The three plain shapes that the hook takes from the stores of the package. The hook asks the intake book whether an entry exists, and it puts the record of the checks that passed in a sink that the job reads
// later. The stores are classes in the folder `src/store`. This folder does not import that folder: `FileIntakeBook` and `PassedChecks` fit these shapes, and the wiring of the service joins them. Each shape has
// the members of the store that the hook uses and no others, so the hook cannot call `record` of the book or `take` of the sink.
//
// This file holds types only.
import type { ChecksRecord } from '@vsa/usecase-kit/checks';
import type { Digest } from '@vsa/usecase-kit/protocol';

/** The part of the intake book that the hook reads. */
export interface BookReader {
  /**
   * Is there an entry for the request number of this tenant? The number counts without regard to case. Only `false` lets a request pass the duplicate check.
   * A book that cannot answer rejects, and the hook answers 503 `check_unavailable` for the rejection. A book that is full and has no entry for the number rejects too: the job could not record that
   * request, so the book must not read it as new.
   */
  has(tenant: string, requestNumber: string): Promise<boolean>;
}

/** What the hook learned about one request. The store of passed checks keeps it for the job. */
export interface PassedEntry {
  /** The checks that passed and what they learned: the record of `runChecks`. */
  readonly record: ChecksRecord;
  /** The `canonicalSha256` of the handoff that the hook checked. */
  readonly request_sha256: Digest;
}

/** The part of the store of passed checks that the hook writes. The job takes the entry with the escrow reference of its context. */
export interface PassedSink {
  /** Stores the entry for the escrow at the time `nowMs`. It throws for input of the wrong form, and the hook then answers with a fault of the service, never with a go. */
  put(escrowRef: string, entry: PassedEntry, nowMs: number): void;
}
