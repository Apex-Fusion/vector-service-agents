// Records every Koios/indexer/supplier call made while building the ChandraOCR report.
// Run once with network: pnpm --filter @vsa/agent-history record-fixtures
// With --replay it reads no network: it builds the report again from the calls the fixture already holds and stores that report. Use it after a
// change to the shape of the report; the ledger data stays that of the last recording.
// With --extend it keeps every call the fixture holds, makes only the calls that the fixture lacks (read-only Koios and indexer calls), and stores the
// report that the code builds from them. Use it after a change of the addresses that the report reads: the fixture then holds the new calls next to the
// old ones, and the rest of the ledger data stays that of the last recording, the chain tip included.
// The report is built with the default configuration (the legacy registry and the default module addresses of @vsa/vector-read), the one the
// tests replay it with.
// It refuses to overwrite the fixture when the report is degraded (a section error, no chain tip, no registry record):
// the tests replay this file, so a recording of a bad run would take them down with it.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { recordingFetch, replayFetch, extendingFetch } from '@vsa/vector-read';
import { buildReport, degradedReasons } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
const file = new URL('../test/fixtures/chandra.json', import.meta.url);
const mode = process.argv.includes('--replay') ? 'replay' : process.argv.includes('--extend') ? 'extend' : 'record';
const store = mode === 'record' ? {} : JSON.parse(readFileSync(file, 'utf8')).store;
const held = Object.keys(store).length;
const f = mode === 'replay' ? replayFetch(store) : mode === 'extend' ? extendingFetch(fetch, store) : recordingFetch(fetch, store);
const req = { subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] };
// The manifest needs a contact address and the report does not carry it; this one is never published.
const report = await buildReport(req, f, { manifest: manifestFromEnv({ OPERATOR_CONTACT: 'recorder@example.test' }) });
const problems = degradedReasons(report);
if (!report.identity?.error && !report.identity?.registered) problems.push('identity.registered is null');
if (problems.length) {
  console.error(`refusing to overwrite the fixture, the ${mode === 'replay' ? 'replayed' : 'live'} report is degraded: ${problems.join('; ')}`);
  process.exit(1);
}
mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(file, JSON.stringify({ store, report }, null, 0));
const calls = Object.keys(store).length;
const verb = { record: 'recorded', replay: 'replayed', extend: 'extended' }[mode];
console.log(`${verb} ${calls} calls${mode === 'extend' ? ` (${calls - held} new)` : ''}; identity.registered=${JSON.stringify(report.identity?.registered)}; reputation.stakes=${report.reputation?.stakes?.length}`);
