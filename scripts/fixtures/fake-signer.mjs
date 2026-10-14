// A stand-in for the local signer, for the tests of scripts/e2e-hire.mjs.
// It holds no key and signs nothing. It answers the two tools the script calls in the shapes the real signer answers.
// It is configured the way the real signer is, through VECTOR_SIGNER_ settings, because those are the only settings the script passes on:
//   VECTOR_SIGNER_AUDIT_LOG_PATH         every call is appended there, as one JSON line (with this process's pid), so a test can see what was asked of it
//   VECTOR_SIGNER_SPEND_LIMIT_PER_TX     a transaction is refused above it, in lovelace; every transaction here moves 3.5 units
//   VECTOR_SIGNER_FAKE_HIDE              comma-separated tool names to leave out of the tool list
//   VECTOR_SIGNER_FAKE_WRONG_HASH=1      the signed transaction is reported with a hash that is not the one of the transaction given
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const FAKE_ADDRESS = 'addr1vfakesigneraddressfortestsonly0000000000000000000000';
const NET_OUTFLOW = 3_500_000;
const SCRIPT_SETTINGS = ['ADVERT_REF', 'PAYLOAD', 'E2E_STATE', 'E2E_POLL_MS', 'BUILDER_URL', 'SIGNER_ENTRY', 'EXPLORER_URL'];
const record = (entry) => { if (process.env.VECTOR_SIGNER_AUDIT_LOG_PATH) appendFileSync(process.env.VECTOR_SIGNER_AUDIT_LOG_PATH, JSON.stringify(entry) + '\n'); };
const text = (t) => ({ content: [{ type: 'text', text: t }] });
const hidden = (process.env.VECTOR_SIGNER_FAKE_HIDE ?? '').split(',').filter(Boolean);
const tools = [
  { name: 'vector_signer_get_address', description: 'Get this signer\'s wallet address.', inputSchema: { type: 'object', properties: {} } },
  { name: 'vector_signer_sign', description: 'Sign an unsigned transaction.', inputSchema: { type: 'object', properties: { txCbor: { type: 'string' } }, required: ['txCbor'] } },
].filter((t) => !hidden.includes(t.name));

const server = new Server({ name: 'fake-signer', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  // Which settings this process can see: the names only, never a value.
  record({ pid: process.pid, name, args, vectorSettings: Object.keys(process.env).filter((k) => k.startsWith('VECTOR_')).sort(), scriptSettings: SCRIPT_SETTINGS.filter((k) => k in process.env) });
  if (name === 'vector_signer_get_address') return text(`Signer address: ${FAKE_ADDRESS}\nKey source: a test double`);
  if (name === 'vector_signer_sign') {
    if (NET_OUTFLOW > Number(process.env.VECTOR_SIGNER_SPEND_LIMIT_PER_TX ?? '100000000')) return text('REFUSED. Net outflow is above the per-transaction limit.');
    const hash = process.env.VECTOR_SIGNER_FAKE_WRONG_HASH === '1' ? 'e'.repeat(64) : createHash('sha256').update(args.txCbor, 'utf8').digest('hex');
    return text(`# Signed\n\nHash: ${hash}\nNet outflow: 3.5\n\nSigned CBOR:\n\`\`\`\nff${args.txCbor}\n\`\`\`\n\nSubmit it with the builder's vector_submit_transaction. Nothing has been submitted yet.`);
  }
  return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
});
await server.connect(new StdioServerTransport());
