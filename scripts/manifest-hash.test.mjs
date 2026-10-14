import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./manifest-hash.mjs', import.meta.url));
const MANIFEST = Buffer.from('{"schema":"vector.agent-manifest.v1","name":"Example"}\n', 'utf8');
const serve = (handler) => new Promise((resolve) => { const srv = createServer(handler).listen(0, '127.0.0.1', () => resolve(srv)); });
const baseOf = (srv) => `http://127.0.0.1:${srv.address().port}`;

test('prints the sha256 of the exact bytes served at /agent.json, and tolerates a trailing slash', async () => {
  const srv = await serve((req, res) => {
    if (req.url === '/agent.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(MANIFEST); } else { res.writeHead(404); res.end(); }
  });
  try {
    const base = baseOf(srv);
    const { stdout } = await run(process.execPath, [SCRIPT, `${base}/`]);
    assert.deepEqual(JSON.parse(stdout), { detail_uri: `${base}/agent.json`, detail_hash: createHash('sha256').update(MANIFEST).digest('hex'), bytes: MANIFEST.length });
  } finally { srv.close(); }
});

test('does not hash an error page, and prints the usage line when there is no argument', async () => {
  const srv = await serve((req, res) => { res.writeHead(404, { 'content-type': 'text/html' }); res.end('<h1>not here</h1>'); });
  try {
    await assert.rejects(run(process.execPath, [SCRIPT, baseOf(srv)]), (e) => e.code === 1 && /404/.test(e.stderr) && e.stdout === '');
    await assert.rejects(run(process.execPath, [SCRIPT]), (e) => e.code === 2 && /usage/.test(e.stderr));
  } finally { srv.close(); }
});
