// agents/document-pipeline/src/llm-prompt.ts
// The one input string of the chat job. The Pipeline sends the chat supplier {input} and nothing else (ruling R12), so the instructions and the page
// texts travel in the same string, and every character of it is committed in the escrow's prompt_hash: the wording below is part of what a job buys.
// The instructions are in English and name the language of the request by its code, which parseRequest has checked to be letters, digits and hyphens
// only. The page texts are passed exactly as the OCR supplier returned them, each after a line "=== page N ===", N counting from 1.
import type { Task } from './request.ts';

const PAGE_LINES = 'The text of each page follows a line "=== page N ===", where N is the page number.';

/** The instructions of a summary: plain text, in the language of the request, and nothing but the summary. */
export function summaryInstructions(language: string): string {
  return `Summarise the document below in plain text. Write the summary in the language whose code is "${language}". Answer with the summary only: `
    + `no title, no headings, no lists, no markdown. ${PAGE_LINES}`;
}

/** The instructions of an extraction: one JSON object valid against the schema and nothing else; free text the model writes is in the request's language. */
export function extractInstructions(language: string): string {
  return 'Extract data from the document below. Answer with one JSON object that is valid against the JSON Schema below, and nothing else: '
    + `no explanation, no markdown, no code fence. Where a value is free text you write yourself, write it in the language whose code is "${language}". ${PAGE_LINES}`;
}

/**
 * The input of the chat job: the instructions of the task, for an extraction the schema as compact JSON after a line "JSON Schema:", then the pages.
 * Throws when the task and the schema do not go together (an extraction without one, a summary with one): a mistake of the caller, before anything is sent.
 */
export function llmInput(args: { task: Task; language: string; schema?: Record<string, unknown>; pages: ReadonlyArray<{ index: number; text: string }> }): string {
  const pages = args.pages.map((page) => `=== page ${page.index + 1} ===\n${page.text}`).join('\n\n');
  if (args.task === 'summary') {
    if (args.schema !== undefined) throw new Error('A summary takes no schema.');
    return `${summaryInstructions(args.language)}\n\n${pages}`;
  }
  if (args.schema === undefined) throw new Error('An extraction needs the schema of the request.');
  return `${extractInstructions(args.language)}\n\nJSON Schema:\n${JSON.stringify(args.schema)}\n\n${pages}`;
}
