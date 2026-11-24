// agents/bid-desk/src/serve/gaps.ts
// The known gaps of the Bid Desk, as its manifest states them. The first five are the gaps of its page, in the order of the page. The sixth says that the keys of the parties stand on one host. The seventh
// says what no run shows. The kit adds the one sentence about the fault switch at the end (`withFaultGap`): it names each possible fault value and what it does, and the manifest never names the active value.
import { withFaultGap } from '@vsa/usecase-kit/manifest';

/** The gaps of the page of the Bid Desk, in its order. */
export const PAGE_GAPS = [
  'A quote is the result of a paid job. It is not a binding offer.',
  "The model prices the request. Nothing in this agent checks its lines against the price list: the buyer's agent can, because the price list and its hash are public.",
  'The three Bid Desks are one code base under three records, run by one foundation. They do not compete.',
  'The compliance attestation is issued by a demonstration registry with no record of its own.',
  'The numbers of the price list are synthetic.',
] as const;

/** The controller key, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only. */
export const CONTROLLER_GAP =
  'The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.';

/** What no run shows: the three items that the coverage of the runs leaves out. Its lead is the run-in lead of the page. */
export const NOT_SHOWN_GAP =
  'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 3, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.';

/** The gaps of the manifest: the page, the keys of the parties, what no run shows, and the sentence of the kit about the fault switch. */
export const GAPS: readonly string[] = withFaultGap('bid-desk', [...PAGE_GAPS, CONTROLLER_GAP, NOT_SHOWN_GAP]);
