import { createServer as httpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import type { Fetch, SafeFetchOpts } from '@vsa/vector-read';
import { parseWire, BadRequest, MAX_BODY } from './request.ts';
import { buildReport, degradedReasons, ESCROW_ROWS_GAP, DISPUTE_MODULE_GAP, GENERIC_MATCH_GAP, CURRENT_STATE_GAP } from './report.ts';
import type { Report } from './report.ts';
import { TtlCache } from './cache.ts';
// A number from the environment: absent or empty means the default (an empty string must not become 0); anything else must be a
// non-negative integer, and the error names the variable.
export function envInt(name: string, v: string | undefined, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`environment variable ${name} must be a non-negative integer, got "${v}"`);
  return Number(v);
}
// A setting the service cannot start without. Absent, empty and blank all mean it was not given, and the error names the variable.
// The value is published in the manifest the advert hashes, so there is no default: a default would be published by every deployment that forgot to set it.
export function requiredEnv(name: string, v: string | undefined): string {
  if (v === undefined || v.trim() === '') throw new Error(`environment variable ${name} is required (the operator's contact address, published in the manifest) and is not set`);
  return v.trim();
}
const CHIPS = ['LIVE', 'DEPLOYED', 'PROPOSED'];
// The status word: LIVE, DEPLOYED or PROPOSED in any case, carried in the manifest in lower case. Absent or empty means deployed (the word since 2026-10-15, RUNBOOK step 17).
function statusChip(v: string | undefined): string {
  if (v === undefined || v === '') return 'deployed';
  if (!CHIPS.includes(v.toUpperCase())) throw new Error(`environment variable AGENT_STATUS_CHIP must be one of ${CHIPS.join(', ')}, got "${v}"`);
  return v.toLowerCase();
}
export function manifestFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    schema: 'vector.agent-manifest.v1', name: 'Agent History', capability_id: 'identity.history.report.v1', version: env.AGENT_VERSION ?? '0.1.0',
    description: "The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Read-only; no model cost.",
    operator: { name: 'Apex Fusion Foundation', contact: requiredEnv('OPERATOR_CONTACT', env.OPERATOR_CONTACT) },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: REGISTRY_ADDRESS },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '' },
    interface: { request_schema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', description: 'DID, registry asset name (64 hex) or key hash (56 hex)' }, include: { type: 'array', items: { enum: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] } } } }, response_schema: { $ref: 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md#response' }, routes: { job: '/v1/job', status: '/status', capability: '/capability' } },
    terms: { price_lovelace: envInt('ADVERT_PRICE_LOVELACE', env.ADVERT_PRICE_LOVELACE, 1_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: envInt('ADVERT_MAX_PROCESSING_MS', env.ADVERT_MAX_PROCESSING_MS, 300_000), input_limits: { request_bytes: MAX_BODY } },
    behaviour: { data_handling: 'Reads public ledger data only; the request subject is held in memory, and a report is served from cache for at most 60 s (expired entries are purged lazily).', third_parties: ['Koios (Vector mainnet indexer)', 'marketplace indexer', "the subject agent's own endpoint (one GET /capability, 64 KiB cap, 20 s budget)"] },
    status: { chip: statusChip(env.AGENT_STATUS_CHIP), since: env.AGENT_STATUS_SINCE ?? '2026-10-15' },
    gaps: [ESCROW_ROWS_GAP, `${DISPUTE_MODULE_GAP} ${GENERIC_MATCH_GAP}`, CURRENT_STATE_GAP],
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
export function createServer(opts: {
  fetchImpl?: Fetch; manifest?: AgentManifest; lookup?: SafeFetchOpts['lookup'];
  buildReport?: typeof buildReport; // test seam: a test injects its own report builder; the service always runs the real one
} = {}) {
  const manifest = opts.manifest ?? manifestFromEnv();
  const f = opts.fetchImpl ?? fetch;
  const build = opts.buildReport ?? buildReport;
  // One report per subject and section list for 60 s; the pending promise is stored, so identical requests that arrive
  // while a report is being built share that one build. A report with a failed section or no chain tip is not kept.
  const reports = new TtlCache<Report>(REPORT_TTL_MS);
  return httpServer(async (req, res) => {
    // The body is serialised before anything is written, so a body that cannot be serialised can still be answered with a 500.
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 400 ? { connection: 'close' } : {}) });
      res.end(text);
    };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/agent.json') return send(200, manifest);
      if (req.method !== 'POST' || req.url !== '/') return send(404, { reason: 'not_found' });
      const parsed = parseWire(await readBody(req));
      const key = `${parsed.subject}\n${[...new Set(parsed.include)].sort().join(',')}`;
      const report = await reports.getOr(key, () => build(parsed, f, { manifest, lookup: opts.lookup }), (r) => degradedReasons(r).length === 0);
      return send(200, report);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Headers already out: nothing more can be said on this response. Log why, then cut it.
      if (res.headersSent) { console.error(`[agent-history] response failed after the headers were sent: ${message}`); res.destroy(); return; }
      if (e instanceof BadRequest || (e as any)?.status === 400) return send(400, { reason: 'bad_request', message });
      console.error(`[agent-history] 500: ${message}`); // the message only, never the request
      return send(500, { reason: 'internal', message });
    }
  });
}
