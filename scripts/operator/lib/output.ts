// scripts/operator/lib/output.ts - the machine line of a run. A run ends with `operator-result: ` and the JSON of its result on ONE line, also when it failed or stopped, so that the program that
// starts the pack can always read it. The text of the result holds public values only. JSON writes a line feed, a carriage return and the other control characters of a text as escapes, and this
// file writes the three characters that JSON leaves as they are (the next line and the two Unicode separators) as escapes too, so that no program splits the line in two.
import { jsonSafe } from '../../checks/lib/format.ts';

export type ResultCommand = 'status' | 'run' | 'cleanup';
export type ResultMode = 'dry' | 'submit';
export type ResultOutcome = 'dry' | 'done' | 'finished' | 'wait' | 'failed' | 'stopped';

/**
 * The seven members of the line. A member that the run cannot know is null: the task, the command and the mode before the command line is read, the step before the first step. `result` is the
 * public object of the task (DIDs, hashes, references, a TXT name and value), or an empty object.
 */
export interface OperatorResultFields {
  readonly task: string | null;
  readonly command: ResultCommand | null;
  readonly mode: ResultMode | null;
  readonly outcome: ResultOutcome;
  readonly exit: number;
  readonly step: string | null;
  readonly result: Readonly<Record<string, unknown>>;
}

const PREFIX = 'operator-result: ';
/** The characters that some programs take for the end of a line and that JSON writes as they are. */
const LINE_SEPARATORS = /[\u0085\u2028\u2029]/g;

/** The machine line of a run: the prefix and the JSON of the seven members, in a fixed order, with each bigint as text. A member that is not one of the seven is left out. The line has no line break. */
export function operatorResult(fields: OperatorResultFields): string {
  const { task, command, mode, outcome, exit, step, result } = fields;
  const json = JSON.stringify(jsonSafe({ task, command, mode, outcome, exit, step, result }));
  return `${PREFIX}${json.replace(LINE_SEPARATORS, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
}
