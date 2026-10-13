import { createServer as httpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import type { Fetch, SafeFetchOpts } from '@vsa/vector-read';
import { parseWire, BadRequest, MAX_BODY } from './request.ts';
import { buildReport } from './report.ts';
import type { Report } from './report.ts';
import { TtlCache } from './cache.ts';
// A number from the environment: absent or empty means the default (an empty string must not become 0), anything else must be a number.
function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`environment value "${v}" is not a number`);
  return n;
}
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    schema: 'vector.agent-manifest.v1', name: 'Agent History', capability_id: 'identity.history.report.v1', version: env.AGENT_VERSION ?? '0.1.0',
    description: 'Everything the Vector ledger knows about one agent identifier, as one signed report. Read-only; no model cost.',
    operator: { name: 'Apex Fusion Foundation', contact: env.OPERATOR_CONTACT ?? 'filip.blagojevic@foundation.apexfusion.org' },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: REGISTRY_ADDRESS },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '' },
    interface: { request_schema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', description: 'DID, registry asset name (64 hex) or key hash (56 hex)' }, include: { type: 'array', items: { enum: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] } } } }, response_schema: { $ref: 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md#response' }, routes: { job: '/v1/job', status: '/status', capability: '/capability' } },
    terms: { price_lovelace: num(env.ADVERT_PRICE_LOVELACE, 1_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: num(env.ADVERT_MAX_PROCESSING_MS, 300_000), input_limits: { request_bytes: MAX_BODY } },
    behaviour: { data_handling: 'Reads public ledger data only; the request subject is not stored beyond a 60 s cache.', third_parties: ['Koios (Vector mainnet indexer)', 'marketplace indexer'] },
    status: { chip: env.AGENT_STATUS_CHIP ?? 'proposed', since: env.AGENT_STATUS_SINCE ?? '2026-10-13' },
    gaps: ['Escrow outcomes from the indexer; Accept vs Release not distinguished', 'Module-1 and Module-6 matched generically'],
    links: { spec: 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md', source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/agent-history', explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}
export type AgentManifest = ReturnType<typeof manifestFromEnv>;
const REPORT_TTL_MS = 60_000;
// Reads the request body as bytes, the unit parseWire counts in. Past MAX_BODY it stops keeping data and fails at once
// (the caller answers 400 and closes the connection); the rest of the upload is read and dropped, never held.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0, failed = false;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes <= MAX_BODY) chunks.push(c);
      else if (!failed) { failed = true; reject(new BadRequest(`request too large (more than ${MAX_BODY} bytes)`)); }
    });
    req.on('end', () => resolve(Buffer.concat(chunks, bytes).toString('utf8')));
    req.on('error', reject);
  });
}
export function createServer(opts: { fetchImpl?: Fetch; manifest?: AgentManifest; lookup?: SafeFetchOpts['lookup'] } = {}) {
  const manifest = opts.manifest ?? manifestFromEnv();
  const f = opts.fetchImpl ?? fetch;
  // One report per subject and section list for 60 s; the pending promise is stored, so identical requests that arrive
  // while a report is being built share that one build.
  const reports = new TtlCache<Report>(REPORT_TTL_MS);
  return httpServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json', ...(status === 400 ? { connection: 'close' } : {}) }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/agent.json') return send(200, manifest);
      if (req.method !== 'POST') return send(404, { reason: 'not_found' });
      const parsed = parseWire(await readBody(req));
      const key = `${parsed.subject}\n${[...new Set(parsed.include)].sort().join(',')}`;
      const report = await reports.getOr(key, () => buildReport(parsed, f, { manifest, lookup: opts.lookup }));
      return send(200, report);
    } catch (e) {
      if (e instanceof BadRequest || (e as any)?.status === 400) return send(400, { reason: 'bad_request', message: (e as Error).message });
      return send(500, { reason: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  });
}
