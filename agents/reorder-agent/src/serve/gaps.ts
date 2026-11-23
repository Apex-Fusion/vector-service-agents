// agents/reorder-agent/src/serve/gaps.ts
// The gaps that the manifest states, as sentences, in one place: the manifest takes them from here (src/serve/manifest.ts), and the page of the agent repeats them word for word. The manifest is frozen into the
// hash of the advert when the advert is posted, so each sentence is a statement made to a hirer about what the service does today. Each is one line of plain text that ends with a full stop. A sentence that
// holds a number reads it from the code that holds it. The first six are the gaps of the agent. The seventh says whose keys the parties of the agent are. The eighth says what the runs of the use case do not show.
// The Reorder Agent has no fault value, so the kit adds no sentence about a fault switch.
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { withFaultGap } from '@vsa/usecase-kit/manifest';

export const LOT_GAP = 'The model chooses the lot. Nothing in this agent limits that choice: the vault of the hirer refuses a lot above the delegated amount, and the hirer approves the order or does not.';
export const APPROVAL_GAP = 'This agent does not check the approval of the hirer. The Order Desk does.';
export const CHALLENGE_GAP = `A challenge puts a hold on the identity of the supplier if the jury finds for this agent. It does not return what the escrow locked: a delivery that this agent refuses can still be released to the supplier ${ACCEPT_WINDOW_MS / 1000} s after its Submit.`;
export const STOCK_GAP = 'The stock reading comes from a mock system and is not checked against anything.';
export const MODEL_GAP = 'A model call that fails ends the job. There is no second provider.';
export const SUPPLIER_GAP = 'Every party on the supplier side is operated by the same foundation as this agent.';
export const KEYS_GAP = 'The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.';
export const NOT_SHOWN_GAP = 'What this does not show: no run covers the refund of the escrow of a revoked agent, the reclaim of an escrow by its buyer, or a relying party that refuses a live token after its authority ended, and tests alone cover the last.';

/** In the order the manifest states them. */
export function gapsFor(): readonly string[] {
  return withFaultGap('reorder-agent', [LOT_GAP, APPROVAL_GAP, CHALLENGE_GAP, STOCK_GAP, MODEL_GAP, SUPPLIER_GAP, KEYS_GAP, NOT_SHOWN_GAP]);
}
