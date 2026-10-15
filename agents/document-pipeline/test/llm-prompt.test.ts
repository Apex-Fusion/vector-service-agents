// agents/document-pipeline/test/llm-prompt.test.ts
// The one input string the chat supplier is sent. The Responses body is {input} and nothing else (ruling R12), so the instructions and the page texts
// travel together in it, and every character of it is committed in the escrow's prompt_hash. The strings are pinned here word for word: a change to
// the wording is a change to what every Pipeline job commits to.
import { describe, it, expect } from 'vitest';
import { extractInstructions, llmInput, summaryInstructions } from '../src/llm-prompt.ts';

const PAGES = [
  { index: 0, text: 'Page one of the test document.' },
  { index: 1, text: 'Page two of the test document.' },
];
const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } } };

describe('summaryInstructions', () => {
  it('asks for a plain-text summary in the language of the request', () => {
    expect(summaryInstructions('en')).toBe(
      'Summarise the document below in plain text. Write the summary in the language whose code is "en". Answer with the summary only: '
      + 'no title, no headings, no lists, no markdown. The text of each page follows a line "=== page N ===", where N is the page number.',
    );
  });

  it('names the language code of the request as it was given', () => {
    expect(summaryInstructions('pt-BR')).toContain('Write the summary in the language whose code is "pt-BR".');
  });
});

describe('extractInstructions', () => {
  it('asks for one JSON object valid against the schema and nothing else, with free text in the language of the request', () => {
    expect(extractInstructions('en')).toBe(
      'Extract data from the document below. Answer with one JSON object that is valid against the JSON Schema below, and nothing else: '
      + 'no explanation, no markdown, no code fence. Where a value is free text you write yourself, write it in the language whose code is "en". '
      + 'The text of each page follows a line "=== page N ===", where N is the page number.',
    );
  });
});

describe('llmInput', () => {
  it('summary: the instructions, then each page after its separator, pages numbered from 1', () => {
    expect(llmInput({ task: 'summary', language: 'en', pages: PAGES })).toBe(
      `${summaryInstructions('en')}\n\n=== page 1 ===\nPage one of the test document.\n\n=== page 2 ===\nPage two of the test document.`,
    );
  });

  it('extract: the instructions, the schema as compact JSON, then the pages', () => {
    expect(llmInput({ task: 'extract', language: 'en', schema: SCHEMA, pages: PAGES })).toBe(
      `${extractInstructions('en')}\n\nJSON Schema:\n{"type":"object","required":["title"],"properties":{"title":{"type":"string"}}}`
      + '\n\n=== page 1 ===\nPage one of the test document.\n\n=== page 2 ===\nPage two of the test document.',
    );
  });

  it('carries a page text exactly as the OCR supplier returned it, line breaks and markdown included', () => {
    const text = '# Letter\n\nDear reader,\n\n| a | b |\n|---|---|\n';
    expect(llmInput({ task: 'summary', language: 'de', pages: [{ index: 0, text }] })).toBe(`${summaryInstructions('de')}\n\n=== page 1 ===\n${text}`);
  });

  it('numbers a page by its index in the document, not by its place in the list', () => {
    expect(llmInput({ task: 'summary', language: 'en', pages: [{ index: 2, text: 'Third.' }] })).toBe(`${summaryInstructions('en')}\n\n=== page 3 ===\nThird.`);
  });

  it('refuses an extract without a schema, and a summary with one: the caller has mixed up the two tasks', () => {
    expect(() => llmInput({ task: 'extract', language: 'en', pages: PAGES })).toThrow(/schema/);
    expect(() => llmInput({ task: 'summary', language: 'en', schema: SCHEMA, pages: PAGES })).toThrow(/schema/);
  });
});
