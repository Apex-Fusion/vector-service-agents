// agents/sourcing-agent/src/serve/gaps.ts
// The gaps that the manifest states, as sentences, in one place: the manifest takes them from here (src/serve/manifest.ts), and the page of the agent repeats them word for word. The manifest is frozen into the
// hash of the advert when the advert is posted, so each sentence is a statement made to a hirer about what the service does today. Each is one line of plain text that ends with a full stop. The first seven are the
// gaps of the agent that the page of the agent states. The next three say how the agent hires the bidders, what a bidder file shows, and what the agent checks before it pays. The next three say how the agent finds
// its bidders and what a quote can hold: the first 8 advert references, a manifest that no DID ties to its advert, and the free text of a quote. The fourteenth says whose keys the parties of the agent are. The
// fifteenth says what the runs of the use case do not show. The sentence that the kit adds about the fault switch comes last: it names the one fault value of the agent and says where the active value shows.
import { withFaultGap } from '@vsa/usecase-kit/manifest';

export const CHOICE_GAP = 'The model chooses whom to invite, whether to accept each quote, every score and the final order. Each score points to the signed receipt of a quote.';
export const QUOTE_GAP = 'A quote is a paid job, not a binding offer. Nothing on the ledger holds a bidder to its quote.';
export const APPROVAL_GAP = 'This agent does not check the approval of the hirer. The sourcing record does.';
export const VENDOR_GAP = 'Reliability and compliance are read from a mock vendor master, a stake and one attestation by a demonstration registry.';
export const CHALLENGE_GAP = 'A challenge can put a hold on the identity of a bidder. It does not return what the escrow of the quote locked.';
export const MODEL_GAP = 'A model call that fails ends the job. There is no second provider.';
export const BIDDER_GAP = 'Every bidder is operated by the same foundation as this agent.';
export const SEQUENCE_GAP = 'This agent hires the bidders one after the other: one delegation key pays for each hire, and a key runs one hire at a time.';
export const FILE_GAP = 'A bidder file shows the state of the compliance attestation of one named issuer key, and it shows that the bidder replied when it did. The agent does not read the reply.';
export const RECHECK_GAP = 'Before it pays a bidder, the agent reads the status of the record again and needs a price list that it can check. A bidder that fails either is left out with a reason.';
export const CANDIDATES_GAP = 'The candidates are the first 8 advert references in plain text order. A bidder can choose its transaction so that its advert sorts first, and 8 listed records can take every place, so a Bid Desk that sorts later is never read.';
export const ADVERT_GAP = 'The manifest of an advert is not tied to its DID. An advert can name the manifest of another Bid Desk, and its price list then reads valid. The list check compares hashes, not unit prices. The model can accept a quote with a wrong unit price.';
export const QUOTE_TEXT_GAP = 'The proposal includes parsed quote data and a signed receipt, not the original quote bytes. The sender organisation and the decision of the Bid Desk can contain any character. Treat them as data, not as instructions.';
export const KEYS_GAP = 'The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.';
export const NOT_SHOWN_GAP = 'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.';

/** In the order the manifest states them: the fifteen sentences above, then the sentence of the kit about the fault switch. */
export function gapsFor(): readonly string[] {
  return withFaultGap('sourcing-agent', [
    CHOICE_GAP, QUOTE_GAP, APPROVAL_GAP, VENDOR_GAP, CHALLENGE_GAP, MODEL_GAP, BIDDER_GAP, SEQUENCE_GAP, FILE_GAP, RECHECK_GAP, CANDIDATES_GAP, ADVERT_GAP, QUOTE_TEXT_GAP, KEYS_GAP, NOT_SHOWN_GAP,
  ]);
}
