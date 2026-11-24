// agents/sourcing-agent/src/bidders/types.ts
// The shapes of the bidder reader of use case 3 (supplier bid evaluation): the file that the model reads for each bidder, the view that the code keeps, the ports that the reader takes, and the bounds that
// it keeps. A bidder is a Bid Desk that quotes on the marketplace. The file holds facts for the model. A fact is data, and the file never decides who is a bidder: the code of this folder decides that only
// from the adverts that the indexer lists and the chain shows. `ComplianceFact` and `FactState` are plain shapes that the folders `facts` and `compliance` write again in their own files. The folders do not
// import each other, and the wiring is where the types meet.
//
// No free text of a bidder reaches a member of a file. The members are words of a closed list, numbers, booleans, hashes, a domain, DIDs and times in the form `YYYY-MM-DDTHH:MM:SSZ`.
import type { Resolution } from '@vsa/id-kit/client';
import type { PriceList } from '@vsa/usecase-kit/bids';
import type { Did, Digest, OutputRef } from '@vsa/usecase-kit/protocol';

/** The most bidders that one read gives. The candidates are in the order of their advert references, and the first ones stay. */
export const MAX_CANDIDATES = 8;
/** The most bidders that are read at one time. */
export const MAX_PARALLEL_READS = 4;
/** The most time that one call of a port has, in milliseconds. */
export const FACT_READ_TIMEOUT_MS = 20_000;
/** The time that the whole read has, from its start, in milliseconds. */
export const BIDDER_READ_BUDGET_MS = 120_000;
/** The most bytes that the reader takes of a manifest and of a price list. */
export const BIDDER_FILE_MAX_BYTES = 262_144;
/** The most time that one fetch of a manifest or of a price list has, in milliseconds. */
export const BIDDER_FETCH_TIMEOUT_MS = 10_000;

/** The state of a fact that a source can fail to give. `unreadable` is a source that gave no answer. It is never `absent` and never `valid`. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

/** The compliance attestation about a bidder. The reply of the bidder is a hash only: its text is never read. */
export interface ComplianceFact {
  /** `valid`: the newest attestation of the issuer is active. `invalid`: it is not. `absent`: none exists. */
  readonly state: FactState;
  /** The id of the attestation that decides the state. */
  readonly attestation: string | null;
  readonly attestation_state: 'active' | 'revoked' | 'expired' | 'not_yet_valid' | null;
  /** Times in the form `YYYY-MM-DDTHH:MM:SSZ`. The reason of a revoke is the decimal text of its code. */
  readonly issued_at: string | null;
  readonly valid_until: string | null;
  readonly revoked_at: string | null;
  readonly revoke_reason: string | null;
  /** The hash of the reply of the bidder (the `Contest` anchor). */
  readonly contested: { readonly sha256: string } | null;
}

/** What the record of a bidder says about the end of its life and the change of its controller. */
export interface BidderLineage {
  /** The latest end of a hold. */
  readonly hold_until: string | null;
  /** The time at which the record ended, for a record that is revoked or retired. */
  readonly ended_at: string | null;
  /** The time from which the signatures of a revoked record are invalid. */
  readonly invalid_from: string | null;
  /** The DID that a revoked or retired record names as its successor. */
  readonly successor: Did | null;
  /** True while a change of the controller by recovery waits. */
  readonly recovery_pending: boolean;
}

/** The status of a bidder. `unreadable`: the gateway gave no answer, and the members that come from the record are then null or false. */
export type BidderStatus = 'active' | 'suspended' | 'revoked' | 'retired' | 'not_found' | 'unreadable';

/** The file of one bidder: what the model reads. */
export interface BidderFile {
  readonly did: Did;
  readonly advert_ref: OutputRef;
  readonly status: BidderStatus;
  /** One of the reason words of the gateway, or null. */
  readonly status_reason: string | null;
  readonly lineage: BidderLineage;
  /** The key hash of the Accountable Party that covers the record now. */
  readonly accountable: string | null;
  /** The organisation of that party, as a lower-case domain of at least two labels. It is shown only when the gateway verified it, because the bidder chooses its text. Null otherwise. */
  readonly organisation: string | null;
  /** True only when the gateway says that it verified the organisation. It is never inferred. */
  readonly organisation_verified: boolean;
  /** Null: the catalog could not be read. */
  readonly in_catalog: boolean | null;
  /** The stake as decimal text. Null: it could not be read. */
  readonly stake_lovelace: string | null;
  /** The challenges that are open against an open claim of the bidder. Null: they could not be read. */
  readonly cases_against: number | null;
  /** The state of the price list of the bidder, as the manifest of its advert names it. */
  readonly price_list: 'valid' | 'invalid' | 'unreadable';
  readonly compliance: ComplianceFact;
  readonly credential: FactState;
}

/** What the code keeps of one bidder: the file, the key hash of its supplier key, and the price list that its manifest names. */
export interface BidderView {
  readonly file: BidderFile;
  /** The key hash that the advert of the bidder names as its supplier. */
  readonly supplier_pkh: string;
  /** The price list, read, checked against the hash of the manifest and parsed. Null unless `file.price_list` is `valid`. */
  readonly price_list: { readonly list: PriceList; readonly sha256: Digest } | null;
}

/**
 * The members of a row of the indexer that the reader uses. `fetchSuppliers` of buyer-core gives rows with more members, and each of them fits. The reader checks each member that it uses. The listing of
 * the indexer applies the listing rule to an advert of the identity layout. The chain shows the `agent_id` that the author of the datum wrote, and the advert validator does not check who the author is.
 */
export interface BidderRow {
  /** The reference of the advert, as `<transaction hash>#<index>`. */
  readonly utxo_ref: string;
  readonly capability_id: string;
  readonly model: string;
  /** `Active` or `Retired`. */
  readonly advert_status: string;
  /** The id of the agent that the advert names: 64 lower-case hex characters, or null for an advert of the legacy layout. */
  readonly agent_id?: string | null;
}

/**
 * What the chain shows of one advert, in the members that the reader uses. `readAdvert` of buyer-core gives this and more: either `{ error }` for a reference that is not an advert (and for every advert of the
 * identity layout, when `readAdvert` has no identity advert address), or the advert with its agent. `spent` is true for an advert that was spent, and a retired advert has the status `Retired`.
 */
export type AdvertRead =
  | { readonly error: string }
  | {
      readonly spent: boolean;
      readonly agentId: string | null;
      readonly advert: {
        readonly supplier_pkh: string;
        readonly status: string;
        readonly capability_id: string;
        readonly model: string;
        readonly detail_uri: string;
        readonly detail_hash: string;
      };
    };

/** The limits that the reader gives to a fetch, with each call. The port enforces both. */
export interface FetchLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

/** The answer of a fetch: the HTTP status, and the body as bytes. */
export interface FetchedBytes {
  readonly status: number;
  readonly bytes: Uint8Array;
}

/** The answer of the stake reader: the stake of an agent in lovelace, or no answer. */
export type StakeAnswer = { readonly ok: true; readonly stake_lovelace: bigint } | { readonly ok: false };
/** The answer of the cases reader: the open challenges against open claims of a bidder, or no answer. */
export type CasesAnswer = { readonly ok: true; readonly cases: number } | { readonly ok: false };

/**
 * What the reader needs, as functions. The folder reads no file and no environment variable, and it makes no network call by itself. A port that throws, or that does not answer in time, gives the member that
 * it feeds the state `unreadable` or `null`. A port of a fact that answers with a value of another shape is a fault of the wiring, and the read throws a `TypeError`.
 */
export interface BiddersDeps {
  /** The adverts that the indexer lists for a capability: `fetchSuppliers` of buyer-core with `capability_id`. */
  readonly listAdverts: (capabilityId: string) => Promise<readonly BidderRow[]>;
  /**
   * One advert, read on the chain: `readAdvert` of buyer-core, bound to the fetch, to the Koios address and to the identity advert address of the deployment, as
   * `(ref) => readAdvert(ref, fetchImpl, koiosUrl, deployment.advert.address)`. Without that address, buyer-core answers `{ error }` for every advert of the identity layout, and every advert of a Bid Desk has it.
   */
  readonly readAdvert: (ref: OutputRef) => Promise<AdvertRead>;
  /**
   * A file of a bidder, fetched with the limits that the reader gives: `safeFetch` of `@vsa/vector-read` behind a function that makes bytes from its text. It refuses an address that is not https or that names
   * a private host, and it throws for a body above `maxBytes`. A port that returns more than `maxBytes` bytes gets the state `invalid`, because the reader checks the size again.
   */
  readonly fetchBytes: (url: string, limits: FetchLimits) => Promise<FetchedBytes>;
  /**
   * The DID resolution of a bidder: the `resolve` of the gateway client. A function that throws when the gateway gives no answer. It is called one time for each bidder whose advert the chain shows. The keys of a
   * record that exists must list the supplier key of the advert with the transaction purpose, or the bidder has no file.
   */
  readonly resolve: (did: Did) => Promise<Resolution>;
  /** The DIDs of the catalog of the gateway, or null when it cannot be read: `parseArdCatalog` over the bytes of `/.well-known/ard.json`. */
  readonly catalog: () => Promise<ReadonlySet<Did> | null>;
  /** The stake of an agent: `readStake` of the facts folder. The argument is the id of the agent: the 64 hex characters of its DID. */
  readonly stake: (agentId: string) => Promise<StakeAnswer>;
  /** The cases against a bidder: `casesAgainst` of the facts folder. */
  readonly cases: (did: Did) => Promise<CasesAnswer>;
  /** The compliance attestation about a bidder at a time in milliseconds: `readCompliance` of the compliance folder. */
  readonly compliance: (did: Did, nowMs: number) => Promise<ComplianceFact>;
  /** The state of the identity credential of a bidder: `readCredential` of the facts folder. */
  readonly credential: (did: Did) => Promise<FactState>;
  /** The time, in milliseconds. */
  readonly clock: () => number;
}

/** Bounds that a caller can make shorter, for example to keep a read inside the deadline of a job. A value above the constant of this folder never widens the bound. */
export interface BiddersOptions {
  /** The time that the whole read has. At most `BIDDER_READ_BUDGET_MS`. */
  readonly budgetMs?: number;
  /** The time that one call of a port has. At most `FACT_READ_TIMEOUT_MS`. */
  readonly callMs?: number;
}
