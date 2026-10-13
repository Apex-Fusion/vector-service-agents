// Records every Koios/indexer/supplier call made while building the ChandraOCR report.
// Run once with network: pnpm --filter @vsa/agent-history record-fixtures
// It refuses to overwrite the fixture when the live report is degraded (a section error, no chain tip, no registry record):
// the tests replay this file, so a recording of a bad run would take them down with it.
import { writeFileSync, mkdirSync } from 'node:fs';
import { recordingFetch } from '@vsa/vector-read';
import { buildReport, degradedReasons } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
const store = {};
const req = { subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] };
const report = await buildReport(req, recordingFetch(fetch, store), { manifest: manifestFromEnv({}) });
const problems = degradedReasons(report);
if (!report.identity?.error && !report.identity?.registered) problems.push('identity.registered is null');
if (problems.length) {
  console.error(`refusing to overwrite the fixture, the live report is degraded: ${problems.join('; ')}`);
  process.exit(1);
}
mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('../test/fixtures/chandra.json', import.meta.url), JSON.stringify({ store, report }, null, 0));
console.log(`recorded ${Object.keys(store).length} calls; identity.registered=${JSON.stringify(report.identity?.registered)}`);
