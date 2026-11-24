// agents/prior-authorization-agent/src/serve/gaps.ts
// The gaps that the manifest states, as sentences, in one place: the manifest takes them from here (src/serve/manifest.ts), and the page of the agent repeats them word for word. The manifest is frozen into the
// hash of the advert when the advert is posted, so each sentence is a statement made to a hirer about what the service does today. Each is one line of plain text that ends with a full stop. A sentence that
// holds a number reads it from the code that holds it. The first seven are the gaps of the agent, in the order of its page. The eighth says whose keys the parties of the agent are. The ninth says what the runs of
// the use case do not show, and its lead, "What this does not show:", is the run-in lead of the page. The tenth is the sentence about the fault switch, which the kit adds: this agent has one fault value.
import { ACCEPT_WINDOW_MS } from '@vsa/buyer-core';
import { withFaultGap } from '@vsa/usecase-kit/manifest';

export const SYNTHETIC_GAP = 'Every record is synthetic. Nothing here has been run against a real records system or a real insurer.';
export const JUSTIFICATION_GAP = 'The model writes the justification. Nothing in this agent checks it against the guideline.';
export const SIGN_OFF_GAP = 'This agent does not check the sign-off of the hirer. The Insurer Intake Agent does.';
export const RECORD_SET_GAP = 'The subagent drafter is given the whole record set, but nothing forces the model to use all of it. The request carries the hash of the set so that a reviewer can compare.';
export const CHALLENGE_GAP = `A challenge puts a hold on the identity of the Insurer Intake Agent if the jury finds for this agent. It does not return what the escrow locked: a delivery that this agent refuses can still be released to the Insurer Intake Agent ${ACCEPT_WINDOW_MS / 1000} s after its Submit.`;
export const MODEL_GAP = 'A model call that fails ends the job. There is no second provider.';
export const INSURER_GAP = 'The insurer side is operated by the same foundation as this agent.';
export const KEYS_GAP = 'The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.';
export const NOT_SHOWN_GAP =
  'What this does not show: no run covers the refund of the escrow of a revoked agent, a relying party that refuses a live token after its authority ended, '
  + 'or a challenge of this agent against the Insurer Intake Agent, because that agent has no fault value. Tests alone cover the last two.';

/** In the order the manifest states them: the nine sentences above, then the sentence of the kit about the fault switch. */
export function gapsFor(): readonly string[] {
  return withFaultGap('prior-authorization-agent', [SYNTHETIC_GAP, JUSTIFICATION_GAP, SIGN_OFF_GAP, RECORD_SET_GAP, CHALLENGE_GAP, MODEL_GAP, INSURER_GAP, KEYS_GAP, NOT_SHOWN_GAP]);
}
