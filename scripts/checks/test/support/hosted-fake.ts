// A fake of the hosted tools for the tests of the checks. Each call is held to the live schema of its tool (the schemas of test/fixtures/hosted-schemas.json), so that a test cannot
// call a tool in a way that the live server would refuse. A handler gives the text of an answer, or a JSON object that is written as the fenced block that the tools write.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HostedError, answerOf, checkArguments } from '../../lib/hosted.ts';
import type { HostedTools, ToolAnswer, ToolSchema } from '../../lib/hosted.ts';

const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/hosted-schemas.json', import.meta.url)), 'utf8')) as { tools: Record<string, ToolSchema> };

export type Handler = (args: Record<string, unknown>) => Record<string, unknown> | { text: string; isError?: boolean };

export class FakeHosted implements HostedTools {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>) {
    this.handlers = handlers;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const problems = checkArguments(name, LIVE.tools[name], args);
    if (problems.length > 0) throw new HostedError('bad_arguments', problems.join('; '));
    this.calls.push({ name, args });
    const handler = this.handlers[name];
    if (handler === undefined) throw new HostedError('unreachable', `the fake has no handler for ${name}`);
    const given = handler(args);
    if ('text' in given && typeof given.text === 'string') return answerOf({ content: [{ type: 'text', text: given.text }], isError: given.isError === true });
    return answerOf({ content: [{ type: 'text', text: `# answer\n\n\`\`\`json\n${JSON.stringify(given)}\n\`\`\`` }] });
  }
}
