// agents/insurer-intake-agent/src/serve/gaps.ts
// The gaps that the manifest states, as sentences, in one place: the manifest takes them from here (src/serve/manifest.ts), and the page of the agent repeats them word for word. The manifest is frozen into the hash
// of the advert when the advert is posted, so each sentence is a statement made to a hirer about what the service does today. Each is one line of plain text that ends with a full stop.
// The first six are the gaps of the page of the agent, in its order. The seventh and the eighth are the two that this agent adds. The ninth says whose keys the parties of the agent are. The tenth says what the runs of
// the use case do not show, and its lead, "What this does not show:", is the run-in lead of the page. The Insurer Intake Agent has no fault value, so the kit adds no sentence about a fault switch.
import { withFaultGap } from '@vsa/usecase-kit/manifest';

export const COVERAGE_GAP = 'An intake record is not a coverage decision.';
export const COMPLETENESS_GAP = 'The model decides completeness. Nothing in this agent overrides it.';
export const LEDGER_GAP = 'The checks read the ledger and the gateway as they are at that moment.';
export const REPORTED_GAP = "The sender's organisation and its provenance, software and principal-binding attestations are reported, not required.";
export const REFUSED_GAP = 'A request refused is not paid, and leaves no signed record of the refusal except, on a digest mismatch, the evidence of the challenge.';
export const SYNTHETIC_GAP = 'Every request is synthetic.';
export const BINDING_GAP = 'The report does not check the digest of the principal-binding attestation, because the salt and the document stay with the hirer.';
export const UNREADABLE_GAP = 'A source that cannot be read is reported as unreadable and never as absent.';
export const KEYS_GAP =
  'The controller key, the Accountable key and the guardian keys of this deployment are on one host of one operator, so a party is independent of the controller by key only.';
export const NOT_SHOWN_GAP =
  'What this does not show: no run covers the refund of the escrow of a revoked agent, a relying party that refuses a live token after its authority ended, '
  + 'or the challenge of the Prior Authorization Agent against this agent, because this agent has no fault value. Tests alone cover the last two.';

/** In the order the manifest states them. */
export function gapsFor(): readonly string[] {
  return withFaultGap('insurer-intake-agent', [
    COVERAGE_GAP, COMPLETENESS_GAP, LEDGER_GAP, REPORTED_GAP, REFUSED_GAP, SYNTHETIC_GAP, BINDING_GAP, UNREADABLE_GAP, KEYS_GAP, NOT_SHOWN_GAP,
  ]);
}
