// The hosted tools for the tests of the operator pack. `PackHosted` holds each call to the input schema that the live server published for its tool (test/fixtures/hosted-schemas.json, one
// tools/list read on the date that its `_captured` member says). A test cannot call a tool in a way that the live server would refuse: a stray argument, a missing one and a value that breaks
// the schema are refused before the handler runs, as `connectHosted` refuses them. A handler gives the text of an answer, or an object that is written as the fenced JSON block of a tool.
// `liveBuildAnswer` writes the answer of a build tool in the format of the live tools, so that a test can build a REAL transaction over a world and answer with it.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HostedError, answerOf, checkArguments } from '../../../checks/lib/hosted.ts';
import type { HostedTools, ToolAnswer, ToolSchema } from '../../../checks/lib/hosted.ts';
import { iso } from '../../../checks/lib/format.ts';
import type { Handler } from '../../../checks/test/support/hosted-fake.ts';

export type { Handler };

interface Captured { date: string; server: string; tools_listed: number; note: string }

const FILE = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/hosted-schemas.json', import.meta.url)), 'utf8')) as { _captured: Captured; tools: Record<string, ToolSchema> };

/** The input schema of each tool that the operator pack calls, as the live server published it. */
export const PACK_SCHEMAS: Readonly<Record<string, ToolSchema>> = FILE.tools;
/** When and from which server the schemas were read. */
export const PACK_CAPTURE: Readonly<Captured> = FILE._captured;

export class PackHosted implements HostedTools {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  readonly handlers: Record<string, Handler>;

  constructor(handlers: Record<string, Handler>) {
    this.handlers = handlers;
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    const problems = checkArguments(name, PACK_SCHEMAS[name], args);
    if (problems.length > 0) throw new HostedError('bad_arguments', problems.join('; '));
    this.calls.push({ name, args });
    const handler = this.handlers[name];
    if (handler === undefined) throw new HostedError('unreachable', `the fake has no handler for ${name}`);
    const given = handler(args);
    if ('text' in given && typeof given.text === 'string') return answerOf({ content: [{ type: 'text', text: given.text }], isError: given.isError === true });
    return answerOf({ content: [{ type: 'text', text: `# answer\n\n\`\`\`json\n${JSON.stringify(given)}\n\`\`\`` }] });
  }
}

/** What a build tool knows about the transaction that it built. The live tools write these members into their answer. */
export interface LiveBuild {
  readonly txCbor: string;
  readonly txHash: string;
  /** The fee in lovelace, as the tools write it: a text of digits. */
  readonly fee: string;
  readonly validFrom: number;
  readonly validTo: number;
  readonly requiredSigners: readonly { readonly keyHash: string; readonly roles: readonly string[] }[];
}

const SIGN_FLOW = 'Each key holder in the list signs in turn, passing on the CBOR that the previous signer returned. Then broadcast the signed transaction and confirm it.';

/**
 * The answer of a build tool, in the format of the live tools: a title, the validity window, the fee, the table of the keys that must sign, the unsigned CBOR in a fenced block that follows
 * `**Unsigned TX CBOR:**`, the signing flow, and a last fenced JSON block with `extra`, the hash, the fee, the window and the signers.
 */
export function liveBuildAnswer(title: string, build: LiveBuild, extra: Record<string, unknown> = {}): { text: string } {
  const rows = build.requiredSigners.map((signer) => `| \`${signer.keyHash}\` | ${signer.roles.join('; ')} |`).join('\n');
  const json = {
    ...extra, tx_hash: build.txHash, fee: build.fee, valid_from: build.validFrom, valid_to: build.validTo,
    required_signers: build.requiredSigners.map((signer) => ({ key_hash: signer.keyHash, roles: signer.roles })),
  };
  const text = `# ${title} (Unsigned, Not Submitted)\n\n**Valid:** ${iso(build.validFrom)} to ${iso(build.validTo)} (every signature and the submit must happen before the end)\n`
    + `**Estimated fee:** ${build.fee} lovelace\n\n**Required signers** (${build.requiredSigners.length}):\n\n| key hash | signs as |\n|---|---|\n${rows}\n\n`
    + `**Unsigned TX CBOR:**\n\`\`\`\n${build.txCbor}\n\`\`\`\n\n${SIGN_FLOW}\n\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;
  return { text };
}
