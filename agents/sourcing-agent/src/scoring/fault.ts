// agents/sourcing-agent/src/scoring/fault.ts
// The one fault of the Sourcing Agent: `invert_scores`. A fault makes an agent do one wrong thing on purpose in a failure run, so that the hirer and the checks can show how they answer. With this fault the
// scorer of the first accepted quote returns each of its four component scores and its score as 100 minus the value. The kit reverses those scores. The recorded model decision does not change.
//
// The fault is on for the value `invert_scores` and for no other value. The empty setting, and any text that is not exactly that value, is a clean run. The value comes from the switch that the service made at
// its start (`readFaultSwitch` of the kit refuses every other value there), and nothing else turns the fault on: not the body of a request, not the quote, not the environment. The switch is read ONE time.
import { reversedChoice } from '@vsa/usecase-kit/bids';
import type { ScoreChoice } from '@vsa/usecase-kit/bids';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultMode } from '@vsa/usecase-kit/protocol';

/** The one fault value of the Sourcing Agent. The type holds it to a value that the kit lists for this kind of agent. */
const INVERT_SCORES: FaultMode<'sourcing-agent'> = 'invert_scores';

/** What the fault does to the answer of the scorer of subject `index` (0 for the first subject). It gives the choice itself when the fault does nothing. */
export type ScoreFault = (index: number, choice: ScoreChoice) => ScoreChoice;

/** The fault of a scoring. It reads `mode` of the switch ONE time, here, and the function that it gives never reads the switch again: so a scoring never runs with two values. */
export function scoreFaultOf(fault: FaultSwitch<'sourcing-agent'>): ScoreFault {
  const inverts = fault.mode === INVERT_SCORES;
  return (index, choice) => (inverts && index === 0 ? reversedChoice(choice) : choice);
}
