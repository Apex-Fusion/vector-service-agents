// agents/sourcing-agent/src/scoring/fault.ts
// The one fault of the Sourcing Agent: `invert_scores`. A fault makes an agent do one wrong thing on purpose in a failure run, so that the hirer and the checks can show how they answer. With this fault the
// scorer of the FIRST quote returns each of its four component scores and its score as 100 minus the value, so that the ranking changes. The decision that the model made is never changed: the record of
// what the model said stays as it is, and the reversal is made on the answer of the scorer.
//
// The fault is on for the value `invert_scores` and for no other value. The empty setting, and any text that is not exactly that value, is a clean run. The value comes from the switch that the service made at
// its start (`readFaultSwitch` of the kit refuses every other value there), and nothing else turns the fault on: not the body of a request, not the quote, not the environment. The switch is read ONE time.
//
// The reversal is made on the decimal text of the number, and not with a subtraction of floats: in a program `100 - 80.2` is `19.799999999999997`, and the evidence of a failure run must show `19.8`.
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import type { FaultMode } from '@vsa/usecase-kit/protocol';
import type { ScoreChoice } from './ports.ts';

/** The one fault value of the Sourcing Agent. The type holds it to a value that the kit lists for this kind of agent. */
const INVERT_SCORES: FaultMode<'sourcing-agent'> = 'invert_scores';

/** The shortest decimal text of a number from 0 to 100 reads as: digits, a fraction, and for a number below 0.000001 a negative exponent. */
const DECIMAL = /^(\d+)(?:\.(\d+))?(?:e-(\d+))?$/;

/**
 * 100 minus a score, exact in decimals. The score is read as its shortest decimal text (the text that `JSON.stringify` writes), the subtraction is made on the whole units of that text, and the result is the
 * number that its decimal text names: 80.2 gives 19.8, 0.1 gives 99.9, 0 gives 100 and 100 gives 0. A value that is not a number from 0 to 100 is a RangeError: a caller reverses a score that it checked.
 */
export function reversedOf(value: number): number {
  if (typeof value !== 'number' || !(value >= 0 && value <= 100)) throw new RangeError('a score is a number from 0 to 100');
  const parts = DECIMAL.exec(String(value));
  if (parts === null) throw new RangeError('a score has the decimal form of a number from 0 to 100');
  const [, whole = '', fraction = '', exponent = '0'] = parts;
  const places = fraction.length + Number(exponent);
  const rest = 100n * 10n ** BigInt(places) - BigInt(whole + fraction);
  const digits = rest.toString().padStart(places + 1, '0');
  return Number(places === 0 ? digits : `${digits.slice(0, digits.length - places)}.${digits.slice(digits.length - places)}`);
}

/** The choice with each of its four component scores and its score reversed. The members of the result are new, and the choice that it was given is not changed. */
export function reversedChoice(choice: ScoreChoice): ScoreChoice {
  const { price, lead_time: leadTime, reliability, compliance } = choice.components;
  return { components: { price: reversedOf(price), lead_time: reversedOf(leadTime), reliability: reversedOf(reliability), compliance: reversedOf(compliance) }, score: reversedOf(choice.score) };
}

/** What the fault does to the answer of the scorer of subject `index` (0 for the first subject). It gives the choice itself when the fault does nothing. */
export type ScoreFault = (index: number, choice: ScoreChoice) => ScoreChoice;

/** The fault of a scoring. It reads `mode` of the switch ONE time, here, and the function that it gives never reads the switch again: so a scoring never runs with two values. */
export function scoreFaultOf(fault: FaultSwitch<'sourcing-agent'>): ScoreFault {
  const inverts = fault.mode === INVERT_SCORES;
  return (index, choice) => (inverts && index === 0 ? reversedChoice(choice) : choice);
}
