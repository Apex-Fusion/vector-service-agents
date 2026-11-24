// agents/insurer-intake-agent/src/report/ports.ts
// The ports of the report of the attestations of the sender, as plain shapes. The logic (report.ts) reads the ledger only through the four ports below and the clock, so a test gives fakes, and the real readers
// (ledger.ts) map the readers of buyer-core to them. This file holds types only: no value, and no import of a value.
//
// Every port can throw or never answer. The report reads a throw, a read that does not answer in time and an answer of the wrong type as a source that cannot be read, and never as an attestation that does
// not exist.
import type { Clock } from '@vsa/usecase-kit/access';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';

/** One attestation about the sender, as a list gives it. It holds what the report needs to tell the issuer and to order the rows, and no value of the attestation itself (no digest and no locator). */
export interface ReportRow {
  /** The name of the attestation token: 64 lower-case hex characters. */
  readonly id: string;
  /** The hash of the issuer key: BLAKE2b with 28 bytes of the public key, as 56 lower-case hex characters. */
  readonly issuer_key_hash: string;
  /** The id of the record of the issuer (64 lower-case hex characters), or null when the issuer is a key with no record. */
  readonly issuer_id: string | null;
  /** When the attestation was issued, in milliseconds since 1970. */
  readonly issued_at: number;
}

/**
 * The root delegator of a delegation: the delegator of the last link of its chain. A key principal is named by the hash of its key (56 lower-case hex characters), and an agent by the id of its record (64
 * lower-case hex characters). These are plain shapes: the real port maps the delegator of the ledger codec to one of them.
 */
export type ReportRoot = { readonly type: 'key'; readonly hash: string } | { readonly type: 'agent'; readonly id: string };

/**
 * What a check expects of an attestation, besides the rule of the registry: the type, the subject and the issuer. The issuer is a key hash or the DID of a record, and never both. The digest is not here: a
 * type 4 attestation holds a salted commitment, and the document and the salt stay off the ledger with the hirer, so this agent cannot recompute it.
 */
export interface ReportExpectation {
  readonly attType: number;
  readonly subject: Did;
  readonly issuer: { readonly key_hash: string } | { readonly did: Did };
}

/** What the report is asked: the sender, the delegation that the request names, and the time of the checks (a whole number of milliseconds since 1970). */
export interface ReportInput {
  readonly sender: Did;
  readonly delegation: DelegationId;
  readonly atMs: number;
}

export interface ReportDeps {
  /** The attestations about `subject` of the type `attType`, newest first or in any order. A list that is cut short throws: a list that is not whole is a source that cannot be read. */
  list(subject: Did, attType: number): Promise<readonly ReportRow[]>;
  /** Does the attestation `id` pass the rule of the registry at the time `atMs`, and does it have the type, the subject and the issuer that `expect` names? */
  check(id: string, atMs: number, expect: ReportExpectation): Promise<boolean>;
  /**
   * The hash of the key of the Provider party in the record of `sender`, or null when the record has no Provider party that names a key. A record that cannot be found throws: null is never "no
   * record".
   */
  providerKeyHashOf(sender: Did): Promise<string | null>;
  /** The root delegator of `delegation`, or null when the delegation has no live chain that ends at a root. A read that fails throws. */
  rootDelegatorOf(delegation: DelegationId): Promise<ReportRoot | null>;
  /** The clock of the report. It bounds each read and the whole report. */
  readonly clock: Clock;
  /** One line of the log. A line names the kind, its word and the number of rows, and no value of an attestation. */
  log(line: string): void;
}
