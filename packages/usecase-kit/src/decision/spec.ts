// packages/usecase-kit/src/decision/spec.ts
// The definition of one decision. The code of a use case writes it, and `decide` runs it. It has three parts:
//
//   name         the name of the decision (`reorder`, `accept_delivery`, `availability`, ...). It goes into the decision that the agent records.
//   instruction  the fixed text of the prompt: what to decide and the shape of the `choice`. It is code. It never holds text of another party: that text goes in the input of `decide`.
//   parse        the parser of the choice.
//
// The choice is the model's. No code of this folder changes, clamps, fills in or computes a choice again, and the parser does not either. A parser checks the SHAPE: the members, their types, and
// the limits that the shape names, such as a whole number or a finite number. It returns the value that it was given, or a refusal. `decide` puts exactly that value in the decision. It also
// compares the value with the choice that the model gave, and a parser that returned another value is a defect: no decision is recorded (`choice_changed`).
//
// A choice that the shape permits stays as the model gave it, also when the use case would have chosen another value: a quantity of 0, or a score above the range that the prompt asked for, when the
// shape names no range. A use case that wants such a value refused names the limit in its shape, and then `decide` refuses the answer (`model_output_invalid`).
import { accepted, refused, type JsonValue, type ProtocolResult } from '../protocol/index.ts';
import { INPUT_CLOSE, INPUT_OPEN } from './prompt.ts';

/**
 * Checks the shape of a choice. `given` is a copy of the choice as the model gave it: plain JSON data that the parser may read as it likes. The parser returns that value, or a refusal that names the
 * member that is wrong. The detail of a refusal names a member and never repeats a value of the choice. A parser never throws.
 *
 * `C` is the type of the choice. Write it as a type alias of JSON data: an interface is not assignable to `JsonValue`.
 */
export type ChoiceParser<C extends JsonValue> = (given: JsonValue) => ProtocolResult<C>;

export interface DecisionSpec<C extends JsonValue = JsonValue> {
  /** A lower-case letter, then lower-case letters, digits and underscores: at most 64 characters. */
  readonly name: string;
  /** The fixed text of the prompt. It does not hold the marks of the input block. */
  readonly instruction: string;
  readonly parse: ChoiceParser<C>;
}

const DECISION_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The decision as a new object, or a refusal that names the member that is wrong. Each member is read one time, so a getter cannot give the prompt one name and the record another.
 * The instruction must not hold the marks of the input block: the block is the only place for the input, and one mark in the fixed text would give a second block.
 */
export function checkSpec<C extends JsonValue>(spec: DecisionSpec<C>): ProtocolResult<DecisionSpec<C>, 'bad_decision'> {
  let name: unknown;
  let instruction: unknown;
  let parse: unknown;
  try {
    ({ name, instruction, parse } = spec as unknown as Record<string, unknown>);
  } catch {
    return refused('bad_decision', 'the decision cannot be read');
  }
  if (typeof name !== 'string' || !DECISION_NAME.test(name)) {
    return refused('bad_decision', 'decision.name must be 1 to 64 characters: a lower-case letter, then lower-case letters, digits and underscores');
  }
  if (typeof instruction !== 'string' || instruction.trim() === '') return refused('bad_decision', 'decision.instruction must be a text that is not blank');
  if (instruction.includes(INPUT_OPEN) || instruction.includes(INPUT_CLOSE)) return refused('bad_decision', 'decision.instruction must not hold the marks of the input block');
  if (typeof parse !== 'function') return refused('bad_decision', 'decision.parse must be a function');
  return accepted({ name, instruction, parse: parse as ChoiceParser<C> });
}
