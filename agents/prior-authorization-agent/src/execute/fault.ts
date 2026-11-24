// agents/prior-authorization-agent/src/execute/fault.ts
// The fault `alter_after_approval` of the Prior Authorization Agent (use case 2, prior authorization). With the fault on, the job changes one sentence of the justification after the sign-off: the document that
// goes to the Insurer Intake Agent is a valid request, and its digest is not the digest that the hirer approved. This file holds the change only. It takes a request and gives a request, and it never sees a job.
//
// The rule. A sentence ends at ".", "!" or "?" when white space or the end of the text follows. The LAST sentence of the justification becomes a fixed synthetic sentence. A justification of one sentence
// becomes that sentence. The result is never equal to the input: a last sentence that is already the fixed sentence becomes the second fixed sentence. The result has at most `MAX_JUSTIFICATION_CHARS` code
// points: when the new text is too long, the first sentences go until it fits. Every other member of the request stays as it is, so the request parser takes the result.
import { MAX_JUSTIFICATION_CHARS } from '@vsa/usecase-kit/priorauth';
import type { PriorAuthRequest } from '@vsa/usecase-kit/priorauth';

/** The sentence that replaces the last sentence of the justification. */
export const ALTERED_SENTENCE = 'The patient also reports a fall one week ago.';

/** The sentence that replaces a last sentence that is already `ALTERED_SENTENCE`, so that the result is never the input. */
export const SECOND_ALTERED_SENTENCE = 'The patient also reports two falls in the last month.';

/** The end mark of a sentence: "." or "!" or "?", with white space or the end of the text after it. A mark inside a word, a number or a run of marks does not end a sentence. */
const SENTENCE_END = /[.!?](?=\s|$)/g;
const FIRST_SENTENCE_END = /[.!?](?=\s|$)/;
const SPACE = /\s/;

/** The number of code points of a text. The request parser counts code points, so a character outside the basic plane is one. */
function pointsIn(text: string): number {
  return Array.from(text).length;
}

/** The text without its first sentence and without the white space after it. A text with no end mark is one sentence, so nothing is left. */
function withoutFirstSentence(text: string): string {
  const end = FIRST_SENTENCE_END.exec(text);
  return end === null ? '' : text.slice(end.index + 1).trimStart();
}

/**
 * The request with its last sentence changed, as a new request. The text before the last sentence stays as it is, with the white space that separates it from the last sentence. The white space after the last
 * sentence goes. The input is not changed.
 */
export function alterJustification(document: PriorAuthRequest): PriorAuthRequest {
  const body = document.justification.trimEnd();
  // The last sentence starts after the last end mark that is not the end of the text, and after the white space that follows that mark. A text with no such mark is one sentence.
  let start = 0;
  for (const end of body.matchAll(SENTENCE_END)) {
    if (end.index + 1 < body.length) start = end.index + 1;
  }
  if (start > 0) {
    while (SPACE.test(body.charAt(start))) start += 1;
  }
  const sentence = body.slice(start) === ALTERED_SENTENCE ? SECOND_ALTERED_SENTENCE : ALTERED_SENTENCE;
  let kept = body.slice(0, start);
  while (pointsIn(kept) + pointsIn(sentence) > MAX_JUSTIFICATION_CHARS) kept = withoutFirstSentence(kept);
  return {
    ...document,
    diagnosis_codes: [...document.diagnosis_codes],
    justification: `${kept}${sentence}`,
    guideline_refs: [...document.guideline_refs],
    record_refs: [...document.record_refs],
  };
}
