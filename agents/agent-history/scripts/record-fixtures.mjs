// Records every Koios/indexer/supplier call made while building the ChandraOCR report.
// Run once with network: pnpm --filter @vsa/agent-history record-fixtures
// With --replay it reads no network: it builds the report again from the calls the fixture already holds and stores that report. Use it after a
// change to the shape of the report; the ledger data stays that of the last recording.
// The report is built with the default configuration (the legacy registry and the module deployments before the identity registry), the one the
// tests replay it with.
// It refuses to overwrite the fixture when the report is degraded (a section error, no chain tip, no registry record):
// the tests replay this file, so a recording of a bad run would take them down with it.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { recordingFetch, replayFetch } from '@vsa/vector-read';
import { buildReport, degradedReasons } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
const file = new URL('../test/fixtures/chandra.json', import.meta.url);
const replay = process.argv.includes('--replay');
const store = replay ? JSON.parse(readFileSync(file, 'utf8')).store : {};
const req = { subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] };
// The manifest needs a contact address and the report does not carry it; this one is never published.
const report = await buildReport(req, replay ? replayFetch(store) : recordingFetch(fetch, store), { manifest: manifestFromEnv({ OPERATOR_CONTACT: 'recorder@example.test' }) });
const problems = degradedReasons(report);
if (!report.identity?.error && !report.identity?.registered) problems.push('identity.registered is null');
if (problems.length) {
  console.error(`refusing to overwrite the fixture, the ${replay ? 'replayed' : 'live'} report is degraded: ${problems.join('; ')}`);
  process.exit(1);
}
mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(file, JSON.stringify({ store, report }, null, 0));
console.log(`${replay ? 'replayed' : 'recorded'} ${Object.keys(store).length} calls; identity.registered=${JSON.stringify(report.identity?.registered)}`);
