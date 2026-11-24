// agents/sourcing-agent/src/model/bidder.ts
// The file of a bidder (a Bid Desk that quotes on the marketplace) as the model decisions read it. `BidderFile` and its parts are plain shapes. The reader of the bidders writes the same shapes in its own
// folder, and the folders of one agent do not import each other: the wiring is where the two meet, and a difference is a compile error there.
//
// A file holds facts for the model. A fact is data and never a filter in code. The model reads a part of each file, and this part is fixed here (`bidderFacts`): words of closed lists, booleans, numbers, a
// decimal text, times and the DID of the bidder. It never holds a text that the bidder chose. The members that the model does not read are the advert reference, the organisation (a domain that the bidder
// names), the key hash of the Accountable Party, the identifier of the attestation, the reason code of its revoke, the time at which it was issued, the hash of the reply of the bidder, and the DID of a
// successor. Three of them stand as booleans: whether an Accountable Party covers the record, whether the record names a successor, and whether the bidder replied. The reason word of the status is kept
// only when it is one of the words that the gateway gives for a status that a record does not state itself, and any other text becomes null.
import type { Did, JsonValue, OutputRef } from '@vsa/usecase-kit/protocol';

/** The state of a fact that a source can fail to give. `unreadable` is a source that gave no answer. It is never `absent` and never `valid`. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/** The compliance attestation about a bidder. The reply of the bidder is a hash only: its text is never read. */
export interface ComplianceFact {
  /** `valid`: the newest attestation of the issuer is active. `invalid`: it is not. `absent`: none exists. */
  readonly state: FactState;
  /** The identifier of the attestation that decides the state. */
  readonly attestation: string | null;
  readonly attestation_state: 'active' | 'revoked' | 'expired' | 'not_yet_valid' | null;
  /** Times as `YYYY-MM-DDTHH:MM:SSZ`. The reason of a revoke is the decimal text of its code. */
  readonly issued_at: string | null;
  readonly valid_until: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  /** The hash of the reply of the bidder to the attestation. */
  readonly contested: { readonly sha256: string } | null;
}

/** What the record of a bidder shows about the end of its life and the change of its controller. */
export interface BidderLineage {
  readonly hold_until: string | null;
  readonly ended_at: string | null;
  readonly invalid_from: string | null;
  /** The DID that a revoked or retired record names as its successor. */
  readonly successor: Did | null;
  /** True while a change of the controller by recovery waits. */
  readonly recovery_pending: boolean;
}

/** The status of a bidder. `unreadable`: the gateway gave no answer, and the members that come from the record are then null or false. */
export type BidderStatus = 'active' | 'suspended' | 'revoked' | 'retired' | 'not_found' | 'unreadable';

/** The file of one bidder. */
export interface BidderFile {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  readonly status: BidderStatus;
  /** One of the reason words of the gateway, or null. */
  readonly status_reason: string | null;
  readonly lineage: BidderLineage;
  /** The key hash of the Accountable Party that covers the record now. */
  readonly accountable: string | null;
  /** The organisation, as a lower-case domain, when the gateway verified it. */
  readonly organisation: string | null;
  readonly organisation_verified: boolean;
  /** Null: the catalog could not be read. */
  readonly in_catalog: boolean | null;
  /** The stake as decimal text. Null: it could not be read. */
  readonly stake_lovelace: string | null;
  /** The challenges that are open against an open claim of the bidder. Null: they could not be read. */
  readonly cases_against: number | null;
  readonly price_list: 'valid' | 'invalid' | 'unreadable';
  readonly compliance: ComplianceFact;
  readonly credential: FactState;
}

/** The reason words of the gateway for a status that a record does not state itself. */
const STATUS_REASONS: readonly string[] = ['invalidated', 'parentRevoked', 'parentRetired', 'deactivationPending', 'parentSuspended', 'notAuthentic', 'unaccountable'];

const reasonOf = (value: string | null): string | null => (typeof value === 'string' && STATUS_REASONS.includes(value) ? value : null);

/**
 * The part of a file that a model reads, as a copy of JSON data. A member that is missing from a file counts as absent for the three booleans, so a file that lacks it shows no party, no successor and no
 * reply. A member that is read as it stands and is missing makes the input refuse to become a prompt, and then nothing is hired.
 */
export function bidderFacts(file: BidderFile): JsonValue {
  const { lineage, compliance } = file;
  return {
    did: file.did,
    status: file.status,
    status_reason: reasonOf(file.status_reason),
    lineage: {
      hold_until: lineage.hold_until,
      ended_at: lineage.ended_at,
      invalid_from: lineage.invalid_from,
      recovery_pending: lineage.recovery_pending,
      has_successor: typeof lineage.successor === 'string',
    },
    accountable: typeof file.accountable === 'string',
    organisation_verified: file.organisation_verified,
    in_catalog: file.in_catalog,
    stake_lovelace: file.stake_lovelace,
    cases_against: file.cases_against,
    price_list: file.price_list,
    compliance: {
      state: compliance.state,
      attestation_state: compliance.attestation_state,
      valid_until: compliance.valid_until,
      revoked_at: compliance.revoked_at,
      replied: typeof compliance.contested === 'object' && compliance.contested !== null,
    },
    credential: file.credential,
  };
}

/**
 * The fixed text that tells a model what a file holds. The two decisions that read a file (`shortlist` and `score`) put it in their instruction. It names each member that `bidderFacts` gives, and no
 * member that it leaves out.
 */
export const BIDDER_FILE_TEXT = [
  'A file has these members.',
  '"did" is the identifier of the bidder.',
  '"status" is the state of its identity record: "active", "suspended", "revoked", "retired", "not_found" or "unreadable".',
  '"status_reason" is a word that says why the state is not active, or null.',
  '"lineage" shows what the record says about the end of its life: "hold_until", "ended_at" and "invalid_from" are times or null, "recovery_pending" is true while a change of its controller waits, and "has_successor" is true when the record names a successor.',
  '"accountable" is true when an Accountable Party covers the record now.',
  '"organisation_verified" is true when the identity gateway verified the organisation of the bidder.',
  '"in_catalog" is true when the catalog of the gateway lists the bidder, false when it does not, and null when the catalog could not be read.',
  '"stake_lovelace" is the stake of the bidder as a whole number in text, or null when it could not be read.',
  '"cases_against" is the number of open challenges against the claims of the bidder, or null when they could not be read.',
  '"price_list" is the state of the price list that the bidder publishes: "valid", "invalid" or "unreadable".',
  '"compliance" is the compliance attestation about the bidder: "state" is "valid", "invalid", "absent" or "unreadable", "attestation_state" is "active", "revoked", "expired", "not_yet_valid" or null, "valid_until" and "revoked_at" are times or null, and "replied" is true when the bidder published a reply to the attestation.',
  '"credential" is the state of its identity credential: "valid", "invalid", "absent" or "unreadable".',
  'A time is written as YYYY-MM-DDTHH:MM:SSZ.',
  'A value that is null or "unreadable" means that no source gave an answer.',
].join(' ');
