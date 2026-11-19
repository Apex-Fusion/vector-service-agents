// scripts/checks/lib/hosted.ts - the hosted MCP server of Vector, for the read and check tools that the checks call (the pattern of scripts/e2e-hire.mjs).
// A call is held against the input schema that the server publishes, in both directions: a server drops an argument that it does not know without a word, and a call that lacks a
// required argument is refused only when it is made. So a stray argument, a missing one, and a value that breaks the schema are refused here, before the call. An answer is read into a
// typed result: the text, the last fenced JSON block of the text, and whether the tool failed (the error flag of the server, or the first words of a failure).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export interface SchemaNode {
  type?: string;
  enum?: readonly string[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}
export interface ToolSchema {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: readonly string[];
}

export interface ToolAnswer {
  text: string;
  /** The last fenced JSON block of the text, as an object; null when there is none. */
  json: Record<string, unknown> | null;
  failed: boolean;
  /** The first line of the text of a failed call; empty for a call that worked. */
  message: string;
}

export interface HostedTools {
  call(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
}

export type HostedErrorKind = 'unreachable' | 'missing_tool' | 'bad_arguments' | 'protocol';

/** The hosted server cannot be used: it cannot be reached, it lacks a tool, or a call does not match the schema of its tool. */
export class HostedError extends Error {
  readonly kind: HostedErrorKind;
  constructor(kind: HostedErrorKind, message: string) {
    super(message);
    this.name = 'HostedError';
    this.kind = kind;
  }
}

/** The patterns that the tools of the checks publish. A pattern that is not here is left to the server: the checks build no expression from text that the server sent. */
const PATTERNS: Record<string, RegExp> = {
  '^[0-9a-fA-F]{64}$': /^[0-9a-fA-F]{64}$/,
  '^[0-9a-fA-F]{56}$': /^[0-9a-fA-F]{56}$/,
};

function nodeProblem(name: string, value: unknown, node: SchemaNode): string | null {
  if (node.type === 'string') {
    if (typeof value !== 'string') return `${name} must be a string`;
    if (node.minLength !== undefined && value.length < node.minLength) return `${name} must have at least ${node.minLength} characters`;
    if (node.maxLength !== undefined && value.length > node.maxLength) return `${name} must have at most ${node.maxLength} characters`;
    const pattern = node.pattern === undefined ? undefined : PATTERNS[node.pattern];
    if (pattern !== undefined && !pattern.test(value)) return `${name} does not match the pattern ${node.pattern}`;
    if (node.enum !== undefined && !node.enum.includes(value)) return `${name} must be one of ${node.enum.join(', ')}`;
  } else if (node.type === 'integer' || node.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (node.type === 'integer' && !Number.isInteger(value))) return `${name} must be ${node.type === 'integer' ? 'a whole number' : 'a number'}`;
    if (node.minimum !== undefined && value < node.minimum) return `${name} must be at least ${node.minimum}`;
    if (node.maximum !== undefined && value > node.maximum) return `${name} must be at most ${node.maximum}`;
  } else if (node.type === 'boolean' && typeof value !== 'boolean') {
    return `${name} must be true or false`;
  }
  return null;
}

/** What is wrong with the arguments of a call, against the schema of its tool. A tool that the server does not list is wrong in itself. */
export function checkArguments(tool: string, schema: ToolSchema | undefined, args: Record<string, unknown>): string[] {
  if (schema === undefined) return [`the hosted server lists no tool ${tool}`];
  const known = Object.keys(schema.properties ?? {});
  const problems: string[] = [];
  const stray = Object.keys(args).filter((key) => !known.includes(key));
  if (stray.length > 0) problems.push(`${tool} has no argument ${stray.join(', ')}; it takes ${known.join(', ') || 'none'}`);
  const missing = (schema.required ?? []).filter((key) => args[key] === undefined);
  if (missing.length > 0) problems.push(`${tool} requires ${missing.join(', ')}, which the call lacks; it takes ${known.join(', ')}`);
  for (const [key, node] of Object.entries(schema.properties ?? {})) {
    if (args[key] === undefined) continue;
    const problem = nodeProblem(key, args[key], node);
    if (problem !== null) problems.push(`${tool}: ${problem}`);
  }
  return problems;
}

const FAILED = /^(Failed\b|REFUSED\b|Could not\b|Rate limit exceeded)/m;

function lastJson(text: string): Record<string, unknown> | null {
  const block = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].at(-1);
  if (block === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(block[1]!);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Reads the result of a tool call. */
export function answerOf(result: { content?: ReadonlyArray<{ type?: string; text?: string }>; isError?: boolean }): ToolAnswer {
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
  const failed = result.isError === true || FAILED.test(text);
  return { text, json: lastJson(text), failed, message: failed ? text.trim().split('\n')[0]!.slice(0, 300) : '' };
}

/** Holds every call of `inner` to the schema of its tool. A call that does not match is refused before it is made. */
export function withSchemas(inner: HostedTools, schemas: Readonly<Record<string, ToolSchema>>): HostedTools {
  return {
    async call(name, args) {
      const problems = checkArguments(name, schemas[name], args);
      if (problems.length > 0) throw new HostedError('bad_arguments', problems.join('; '));
      return inner.call(name, args);
    },
  };
}

export interface ConnectOptions {
  /** The tools that the check needs: the server must list each of them. */
  required: readonly string[];
  /** The time limit of one call, in milliseconds. */
  timeoutMs?: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Connects to the hosted server, reads its tool list once, and gives the tools, each call held to its schema. */
export async function connectHosted(url: string, options: ConnectOptions): Promise<HostedTools & { close(): Promise<void> }> {
  const timeout = options.timeoutMs ?? 120_000;
  const client = new Client({ name: 'vector-mainnet-checks', version: '1' });
  const schemas: Record<string, ToolSchema> = {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), { timeout });
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout });
      for (const tool of page.tools) schemas[tool.name] = tool.inputSchema as ToolSchema;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  } catch (err) {
    await client.close().catch(() => undefined);
    throw new HostedError('unreachable', `the hosted server could not be used (${errorText(err)})`);
  }
  const absent = options.required.filter((name) => schemas[name] === undefined);
  if (absent.length > 0) {
    await client.close().catch(() => undefined);
    throw new HostedError('missing_tool', `the hosted server lacks the tool ${absent.join(', ')}`);
  }
  const checked = withSchemas({
    async call(name, args) {
      try {
        return answerOf(await client.callTool({ name, arguments: args }, undefined, { timeout }) as { content?: Array<{ type?: string; text?: string }>; isError?: boolean });
      } catch (err) {
        throw new HostedError('unreachable', `the call of ${name} did not end (${errorText(err)})`);
      }
    },
  }, schemas);
  return { call: (name, args) => checked.call(name, args), close: () => client.close() };
}
