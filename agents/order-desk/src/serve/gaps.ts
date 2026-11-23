// agents/order-desk/src/serve/gaps.ts
// The known gaps of the Order Desk, as its manifest states them. The first six are the gaps of its page, in the order of the page. The seventh says that the keys of the parties stand on one host. The eighth
// says what no run shows. The kit adds the one sentence about the fault switch at the end (`withFaultGap`): it names each possible fault value and what it does, and the manifest never names the active value.
import { withFaultGap } from '@vsa/usecase-kit/manifest';

/** The gaps of the page of the Order Desk, in its order. */
export const PAGE_GAPS = [
  'The model decides whether the lot can be supplied. Nothing in this agent overrides it.',
  'The checks read the ledger and the gateway as they are at that moment. A delegation or approval ended a moment later is not seen.',
  'The organisation of the sender is reported, not required.',
  "If the buyer's agent does not accept a confirmation, this agent's operator can still release the escrow 600 s after the Submit. A verdict against this agent does not change that.",
  'An order refused or not supplied is not paid, and leaves no signed record of the refusal except, on a digest mismatch, the evidence of the challenge.',
  'The price of a lot is a stand-in for its size.',
] as const;

/** The controller key, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only. */
export const CONTROLLER_GAP =
  'The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.';

/** What no run shows: the three items that the coverage of the runs leaves out. Its lead is the run-in lead of the page. */
export const NOT_SHOWN_GAP =
  'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow in use case 1, or a relying party that refuses a live token after its authority ends. Tests cover that last case only.';

/** The gaps of the manifest: the page, the keys of the parties, what no run shows, and the sentence of the kit about the fault switch. */
export const GAPS: readonly string[] = withFaultGap('order-desk', [...PAGE_GAPS, CONTROLLER_GAP, NOT_SHOWN_GAP]);
