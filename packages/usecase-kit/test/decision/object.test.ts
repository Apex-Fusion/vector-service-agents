// packages/usecase-kit/test/decision/object.test.ts: the whole answer is the object. After the white space at both ends (and a byte order mark at the start) is taken off, the answer is exactly one JSON
// object. Two wrappers are permitted because they say nothing: think blocks at the very start, and one code fence around the whole rest. Any other character before or after the object ends the reading.
// A decision is recorded only when the answer has one reading. Each refusal has an accepted twin: the same object, alone or in a permitted wrapper.
import { describe, expect, it } from 'vitest';
import { accepted } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import type { ChoiceParser } from '@vsa/usecase-kit/decision';
import { readAnswer } from '../../src/decision/answer.ts';
import { MEDIUM_LOT, said } from './support.ts';

const MARKER = 'ZQ9-marker-7f3';
const any: ChoiceParser<JsonValue> = (given) => accepted(given);
const read = (text: string) => readAnswer({ text, status: 'completed' }, any);

/** The object that the model means. */
const OBJECT = said(MEDIUM_LOT);
/** An object that says the opposite: a reader that took it instead of OBJECT would record another choice. */
const OPPOSITE = said({ lot: 'lot-large', quantity: 200, needed_by: '2026-12-01' }, 'Reject the medium lot.');
const FENCED = '```json\n' + OBJECT + '\n```';

const NOT_ALONE = 'is not one JSON object alone';
const NOT_AN_OBJECT = 'is JSON that is not an object';
const THINK_OPEN = 'has a think block that is not closed';
const FENCE_FAULT = 'has a code fence that is not whole';

describe('the whole answer is the object: wrappers that are permitted', () => {
  it.each<[string, string]>([
    ['the object alone', OBJECT],
    ['white space at both ends', `\n\t  ${OBJECT} \r\n`],
    ['a byte order mark at the start', `\uFEFF${OBJECT}`],
    ['a byte order mark and then white space', `\uFEFF\n ${OBJECT}`],
    ['one think block', `<think>I weigh the lots.</think>${OBJECT}`],
    ['one think block with white space after it', `<think>I weigh the lots.</think>\n\n${OBJECT}\n`],
    ['several think blocks', `<think>one</think>\n<think>two</think> \n${OBJECT}`],
    ['an empty think block', `<think></think>${OBJECT}`],
    ['a think block that holds braces and objects', `<think>A draft: ${OPPOSITE} or {"a":1} }{</think>\n${OBJECT}`],
    ['a think block that holds a fenced object', `<think>\`\`\`json\n${OPPOSITE}\n\`\`\`</think>${OBJECT}`],
    ['a think block that holds the tag that opens one', `<think>a <think> b</think>${OBJECT}`],
    ['a fence with a word', FENCED],
    ['a fence with no word', '```\n' + OBJECT + '\n```'],
    ['a fence with the word in capitals', '```JSON\n' + OBJECT + '\n```'],
    ['a fence with line breaks of two characters', '```json\r\n' + OBJECT + '\r\n```'],
    ['a fence with spaces after the word and before the closing mark', '```json  \n' + OBJECT + '\n  ```'],
    ['a fence around an object on many lines', '```json\n' + JSON.stringify({ reasoning: 'Why.', choice: MEDIUM_LOT }, null, 2) + '\n```'],
    ['a fence with white space around it', `\n  ${FENCED}\n\n`],
    ['a think block and then a fence', `<think>I decide.</think>\n${FENCED}`],
    ['a fence with its mark in a text of the object', '```json\n' + said(MEDIUM_LOT, 'Write ``` for code.') + '\n```'],
  ])('reads %s', (_name, text) => {
    expect(read(text)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
  });

  it('reads the object that the model means, and never the one that a think block holds', () => {
    expect(read(`<think>${OPPOSITE}</think>${OBJECT}`)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT, reasoning: 'The data supports this choice.' } });
  });
});

describe('the whole answer is the object: any other character before or after the object', () => {
  it.each<[string, string, string]>([
    // The probes of the review.
    ['words before the object', `Sure. ${OBJECT}`, NOT_ALONE],
    ['words after the object', `${OBJECT} Hope this helps.`, NOT_ALONE],
    ['words before and after that take the choice back', `Sure. ${OPPOSITE} Hope this helps, but reject it.`, NOT_ALONE],
    ['the object in a list', `[${OBJECT}]`, NOT_AN_OBJECT],
    ['the object and a text in a list', `[${OPPOSITE}, "final answer: reject"]`, NOT_AN_OBJECT],
    ['two objects in a list', `[${OBJECT},${OPPOSITE}]`, NOT_AN_OBJECT],
    ['two objects with a space', `${OBJECT} ${OPPOSITE}`, NOT_ALONE],
    ['two objects with a line break', `${OBJECT}\n${OPPOSITE}`, NOT_ALONE],
    ['two objects that touch', `${OBJECT}${OPPOSITE}`, NOT_ALONE],
    // The object in another form.
    ['the object written as a text', JSON.stringify(OBJECT), NOT_AN_OBJECT],
    ['the object inside another object', `{"answer":${OBJECT}}`, 'has the wrong members'],
    ['no text at all', '', NOT_ALONE],
    ['white space only', ' \n\t ', NOT_ALONE],
    // Think blocks.
    ['a think block after the object', `${OBJECT}<think>I changed my mind.</think>`, NOT_ALONE],
    ['words between a think block and the object', `<think>x</think> Final: ${OBJECT}`, NOT_ALONE],
    ['words before a think block', `Sure. <think>x</think>${OBJECT}`, NOT_ALONE],
    ['a think block that is not closed', `<think>I weigh the lots. ${OBJECT}`, THINK_OPEN],
    ['a think block that is closed with the tag in capitals', `<think>x</THINK>${OBJECT}`, THINK_OPEN],
    ['a think block with its tag in capitals', `<THINK>x</THINK>${OBJECT}`, NOT_ALONE],
    ['a think block that is the whole answer', '<think>x</think>', NOT_ALONE],
    ['text that the first close tag leaves behind', `<think>a</think> b</think>${OBJECT}`, NOT_ALONE],
    // Code fences.
    ['words before a fence', `Here it is:\n${FENCED}`, NOT_ALONE],
    ['words after a fence', `${FENCED}\nHope this helps.`, FENCE_FAULT],
    ['a fence that is not closed', '```json\n' + OBJECT, FENCE_FAULT],
    ['a closing mark with no opening line', `${OBJECT}\n\`\`\``, NOT_ALONE],
    ['a closing mark on the line of the object', '```json\n' + OBJECT + '```', FENCE_FAULT],
    ['an object on the line of the opening mark', '```json ' + OBJECT + '\n```', FENCE_FAULT],
    ['a fence on one line', '```' + OBJECT + '```', FENCE_FAULT],
    ['a fence of four backticks', '````json\n' + OBJECT + '\n````', FENCE_FAULT],
    ['a fence with an opening line that is not a word', '```json now\n' + OBJECT + '\n```', FENCE_FAULT],
    ['two fences', `${FENCED}\n${FENCED}`, NOT_ALONE],
    ['a fence in a fence', '```\n' + FENCED + '\n```', NOT_ALONE],
    ['two objects in a fence', '```json\n' + OBJECT + '\n' + OPPOSITE + '\n```', NOT_ALONE],
    ['a list in a fence', '```json\n[' + OBJECT + ']\n```', NOT_AN_OBJECT],
    ['an empty fence', '```json\n```', FENCE_FAULT],
    ['a think block in a fence', '```json\n<think>x</think>' + OBJECT + '\n```', NOT_ALONE],
    ['a think block after a fence', `${FENCED}\n<think>x</think>`, FENCE_FAULT],
    // Characters that are not the white space of JSON.
    ['a byte order mark in the object', '{\uFEFF"reasoning":"r","choice":1}', NOT_ALONE],
    ['a byte order mark at the end', `${OBJECT}\uFEFF`, NOT_ALONE],
    ['a byte order mark after white space', ` \uFEFF${OBJECT}`, NOT_ALONE],
    ['a no-break space before the object', `\u00a0${OBJECT}`, NOT_ALONE],
  ])('refuses %s with model_output_invalid', (_name, text, why) => {
    const result = read(text);
    expect(result).toMatchObject({ ok: false, code: 'model_output_invalid' });
    if (!result.ok) expect(result.detail).toContain(why);
  });

  it('says in a detail how long the answer is and never repeats a word of it', () => {
    for (const text of [`${MARKER} ${OBJECT}`, `${OBJECT} ${MARKER}`, `<think>${MARKER}`, `\`\`\`json\n${MARKER}`, `[{"reasoning":"${MARKER}","choice":1}]`]) {
      const result = read(text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.detail).not.toContain(MARKER);
      expect(result.detail).toContain(`an answer of ${text.length} characters`);
    }
  });

  it('reads an answer with a long run of white space around the object: the white space is taken off by a loop, so the run costs nothing', () => {
    const run = `<think>x</think>\n${'\t '.repeat(200_000)}${OBJECT}${' \n'.repeat(200_000)}`;
    expect(read(run)).toMatchObject({ ok: true, value: { choice: MEDIUM_LOT } });
    // The twin: a character that is not white space, between two long runs of it, is refused.
    expect(read(`${OBJECT}${' '.repeat(300_000)}x${' '.repeat(300_000)}`)).toMatchObject({ ok: false, code: 'model_output_invalid' });
  });
});
