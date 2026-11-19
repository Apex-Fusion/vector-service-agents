// The hosted tools: a call is held against the input schema that the server publishes, in both directions, and an answer is read into a typed result.
// The schemas are those that the live server published on 2026-11-19. A fake MCP server over HTTP (127.0.0.1 only) answers the real client code.
import { createServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { HostedError, answerOf, checkArguments, connectHosted, withSchemas } from '../lib/hosted.ts';
import type { HostedTools, ToolSchema } from '../lib/hosted.ts';

const LIVE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/hosted-schemas.json', import.meta.url)), 'utf8')) as { tools: Record<string, ToolSchema> };
const ID = 'ab'.repeat(32);
const withJson = (markdown: string, data: unknown): string => `${markdown}\n\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;

describe('checkArguments', () => {
  const schema = LIVE.tools.vector_check_delegation_use!;
  it('accepts the arguments that the live schema takes', () => {
    expect(checkArguments('vector_check_delegation_use', schema, { delegation: ID, action: 'marketplace.hire.v1', resource: `script:${'cd'.repeat(28)}` })).toEqual([]);
    expect(checkArguments('vector_check_delegation_use', schema, { delegation: ID, action: 'a', resource: 'b', time: 1_800_000_000_000, min_confirmations: 30 })).toEqual([]);
  });
  it('refuses an argument that the tool does not take, because a server drops it without a word', () => {
    expect(checkArguments('vector_check_delegation_use', schema, { delegation: ID, action: 'a', resource: 'b', minConfirmations: 30 })).toEqual([expect.stringContaining('minConfirmations')]);
  });
  it('refuses an argument that the schema requires and the call lacks', () => {
    const problems = checkArguments('vector_check_delegation_use', schema, { delegation: ID });
    expect(problems.join(' ')).toContain('action');
    expect(problems.join(' ')).toContain('resource');
  });
  it('refuses a value that breaks the pattern, the length, the type, the range or the list of the schema', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['vector_get_delegation', 'delegation', { delegation: 'xyz' }],
      ['vector_get_delegation', 'delegation', { delegation: 7 }],
      ['vector_check_delegation_use', 'action', { delegation: ID, action: '', resource: 'b' }],
      ['vector_check_delegation_use', 'action', { delegation: ID, action: 'a'.repeat(257), resource: 'b' }],
      ['vector_check_delegation_use', 'min_confirmations', { delegation: ID, action: 'a', resource: 'b', min_confirmations: 1.5 }],
      ['vector_check_delegation_use', 'min_confirmations', { delegation: ID, action: 'a', resource: 'b', min_confirmations: 100_001 }],
      ['vector_check_attestation', 'expected_type', { attestation: ID, expected_type: 'nonsense' }],
      ['vector_get_vault', 'limit', { delegation: ID, limit: 51 }],
    ];
    for (const [tool, argument, args] of cases) {
      expect(checkArguments(tool, LIVE.tools[tool], args).join(' '), `${tool} ${argument}`).toContain(argument);
    }
    expect(checkArguments('vector_check_attestation', LIVE.tools.vector_check_attestation, { attestation: ID, expected_type: 'approval', expected_digest: 'cd'.repeat(32) })).toEqual([]);
  });
  it('refuses a call of a tool that the server does not list', () => {
    expect(checkArguments('vector_nothing', undefined, {})).toEqual([expect.stringContaining('vector_nothing')]);
  });
});

describe('answerOf', () => {
  it('reads the last fenced JSON block, and says that the call failed when the server says so', () => {
    expect(answerOf({ content: [{ type: 'text', text: withJson('# A', { first: 1 }) + '\n\nmore\n' + withJson('# B', { live: true }) }] })).toMatchObject({ failed: false, json: { live: true } });
    expect(answerOf({ content: [{ type: 'text', text: '# no json' }] }).json).toBeNull();
    expect(answerOf({ isError: true, content: [{ type: 'text', text: 'something broke' }] })).toMatchObject({ failed: true, message: 'something broke' });
    expect(answerOf({ content: [{ type: 'text', text: 'Failed to read the vault: the node did not answer\n\nTips' }] })).toMatchObject({ failed: true, message: 'Failed to read the vault: the node did not answer' });
  });
});

describe('withSchemas', () => {
  it('holds each call to the schema of its tool before it reaches the server, and passes a good call on', async () => {
    const asked: string[] = [];
    const inner: HostedTools = { call: async (name) => { asked.push(name); return { text: '', json: null, failed: false, message: '' }; } };
    const checked = withSchemas(inner, LIVE.tools);
    await checked.call('vector_get_delegation', { delegation: ID });
    await expect(checked.call('vector_get_delegation', { delegation: 'bad' })).rejects.toBeInstanceOf(HostedError);
    await expect(checked.call('vector_get_delegation', { delegation: ID, extra: 1 })).rejects.toThrow(/extra/);
    await expect(checked.call('vector_unknown', {})).rejects.toThrow(/vector_unknown/);
    expect(asked).toEqual(['vector_get_delegation']);
  });
});

describe('connectHosted', () => {
  const servers: HttpServer[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((done) => { s.close(done); s.closeAllConnections(); }))); });

  async function fakeServer(handlers: Record<string, (args: Record<string, unknown>) => { text: string; isError?: boolean }>, tools: string[] = Object.keys(LIVE.tools)): Promise<{ url: string; calls: string[] }> {
    const calls: string[] = [];
    const http = createServer(async (req, res) => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const mcp = new Server({ name: 'fake-hosted', version: '0.0.0' }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map((name) => ({ name, description: name, inputSchema: LIVE.tools[name]! as { type: 'object' } })) }));
      mcp.setRequestHandler(CallToolRequestSchema, async (r) => {
        calls.push(r.params.name);
        const answer = handlers[r.params.name]?.((r.params.arguments ?? {}) as Record<string, unknown>) ?? { text: 'Failed: no such tool', isError: true };
        return { content: [{ type: 'text', text: answer.text }], isError: answer.isError ?? false };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
    });
    await new Promise<void>((done) => { http.listen(0, '127.0.0.1', done); });
    servers.push(http);
    const { port } = http.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/mcp`, calls };
  }

  it('lists the tools, holds a call to the schema, calls the tool, and reads the answer', async () => {
    const server = await fakeServer({ vector_get_delegation: (args) => ({ text: withJson('# Delegation', { delegation: args.delegation, live: true }) }) });
    const hosted = await connectHosted(server.url, { required: ['vector_get_delegation'] });
    try {
      expect(await hosted.call('vector_get_delegation', { delegation: ID })).toMatchObject({ failed: false, json: { delegation: ID, live: true } });
      await expect(hosted.call('vector_get_delegation', { delegation: ID, stray: 1 })).rejects.toThrow(/stray/);
      expect(server.calls).toEqual(['vector_get_delegation']);
    } finally { await hosted.close(); }
  });
  it('gives a tool that failed as a result, and the message of the tool', async () => {
    const server = await fakeServer({ vector_get_vault: () => ({ text: 'Failed to read the vault: the node did not answer', isError: true }) });
    const hosted = await connectHosted(server.url, { required: [] });
    try {
      expect(await hosted.call('vector_get_vault', { delegation: ID })).toMatchObject({ failed: true, message: 'Failed to read the vault: the node did not answer' });
    } finally { await hosted.close(); }
  });
  it('refuses a server that lacks a tool that the check needs, and says which', async () => {
    const server = await fakeServer({}, ['vector_get_delegation']);
    const err = await connectHosted(server.url, { required: ['vector_get_delegation', 'vector_get_vault'] }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('missing_tool');
    expect((err as HostedError).message).toContain('vector_get_vault');
  });
  it('says that the server cannot be reached', async () => {
    const err = await connectHosted('http://127.0.0.1:9/mcp', { required: [], timeoutMs: 3_000 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('unreachable');
  });
});
