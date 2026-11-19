#!/usr/bin/env node
// deploy/server/prove-mock-mtls.mjs - local proof of the two mock host names in Caddyfile.mock-systems.snippet.
//
// The script starts the real Caddy (the Docker image caddy:2) with the real main Caddyfile and the real snippet. Caddy listens on high ports
// of the loopback address and uses its own local CA. Behind Caddy, a small echo backend returns the headers that it receives. Then the
// script calls both host names with curl, over HTTP/1.1 and over HTTP/2, and checks the Client-Cert header at the backend:
//   - a request with a client certificate reaches the backend with the certificate in the header;
//   - a request without a client certificate reaches the backend with no such header;
//   - a Client-Cert header that the client forges is removed, on both host names.
// The test certificates are made for this run in a private temporary folder. The run removes the folder and the Caddy container at its end.
//
// Run it in the foreground, from the root of the repository. It needs Node 22, Docker, curl and openssl, and it runs on Linux:
//   node deploy/server/prove-mock-mtls.mjs
// Settings (all optional): CADDY_IMAGE (default caddy:2), PROOF_HTTPS_PORT (18443), PROOF_HTTP_PORT (18080), PROOF_BACKEND_PORT (19120).
// The exit code is 0 when every check passes.

import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { X509Certificate } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The two placeholders of the snippet, and the address of its upstream. */
export const HOST_PLACEHOLDER = '<mock-host>';
export const MTLS_PLACEHOLDER = '<mock-mtls-host>';
export const UPSTREAM = '127.0.0.1:9120';
/** The one line of the main Caddyfile that the proof replaces with the options for local ports and a local CA. */
export const ADMIN_LINE = '\tadmin localhost:2019';
/** The shape of the snippet of one agent. The host name and the two ports are placeholders. */
export const AGENT_SNIPPET = [
  '<agent-host> {',
  '\thandle /agent.json {',
  '\t\treverse_proxy 127.0.0.1:<service-port>',
  '\t}',
  '\thandle {',
  '\t\treverse_proxy 127.0.0.1:<runtime-port>',
  '\t}',
  '}',
  '',
].join('\n');

const count = (text, part) => text.split(part).length - 1;

/** Replace every placeholder of the snippet and its upstream address. A part that the text does not hold is an error. */
export function fillSnippet(text, { host, mtlsHost, upstream }) {
  let out = text;
  for (const [from, to] of [[HOST_PLACEHOLDER, host], [MTLS_PLACEHOLDER, mtlsHost], [UPSTREAM, upstream]]) {
    if (count(out, from) === 0) throw new Error(`the snippet does not hold ${from}`);
    out = out.split(from).join(to);
  }
  return out;
}

/** Replace every placeholder of the snippet of an agent. */
export function fillAgentSnippet(text, { host, servicePort, runtimePort }) {
  let out = text;
  for (const [from, to] of [['<agent-host>', host], ['<service-port>', String(servicePort)], ['<runtime-port>', String(runtimePort)]]) {
    if (count(out, from) === 0) throw new Error(`the snippet does not hold ${from}`);
    out = out.split(from).join(to);
  }
  return out;
}

/** The real main Caddyfile with its admin line replaced by the options of a local run: no admin API, a local CA, high ports, the loopback address. */
export function proofCaddyfile(text, { httpPort, httpsPort }) {
  if (count(text, ADMIN_LINE) !== 1) throw new Error('the main Caddyfile must hold the admin line once');
  const options = ['\tadmin off', '\tlocal_certs', '\tskip_install_trust', `\thttp_port ${httpPort}`, `\thttps_port ${httpsPort}`, '\tdefault_bind 127.0.0.1'].join('\n');
  return text.split(ADMIN_LINE).join(options);
}

/** The values of the headers with this name, from the flat list of a Node request (raw names, in the order sent). */
export function headerValues(rawHeaders, name) {
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === name.toLowerCase()) out.push(rawHeaders[i + 1]);
  return out;
}

/** The value of the Client-Cert header for a certificate (RFC 9440): the standard base64 of its DER bytes between two colons. */
export const clientCertValue = (certPem) => `:${new X509Certificate(certPem).raw.toString('base64')}:`;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function until(what, seconds, fn, detail = () => '') {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${what}. ${detail()}`);
    await sleep(300);
  }
}

/** Run a program and wait for it without blocking the event loop. The echo backend runs in this process, so a blocking call would stop it. */
const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'utf8', timeout: 30_000 }, (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr }));
});

const portFrom = (name, fallback) => {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name} must be a port from 1024 to 65535`);
  return value;
};

function need(tool, args) {
  const r = spawnSync(tool, args, { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`${tool} is not available: ${r.error?.message ?? r.stderr.trim()}`);
  return r.stdout.trim();
}

function openssl(...args) {
  const r = spawnSync('openssl', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.trim()}`);
}

/** One self-signed client certificate with a SPIFFE ID, and its key, in the folder. Caddy knows no CA for it. */
function makeClientCert(dir, name, spiffeId) {
  const crt = join(dir, `${name}.crt`);
  const key = join(dir, `${name}.key`);
  openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-keyout', key, '-out', crt,
    '-subj', `/CN=${name}`, '-addext', `subjectAltName=URI:${spiffeId}`, '-addext', 'extendedKeyUsage=clientAuth');
  return { crt, key, header: clientCertValue(readFileSync(crt)) };
}

async function main() {
  const image = process.env.CADDY_IMAGE || 'caddy:2';
  const port = { https: portFrom('PROOF_HTTPS_PORT', 18443), http: portFrom('PROOF_HTTP_PORT', 18080), backend: portFrom('PROOF_BACKEND_PORT', 19120) };
  need('docker', ['version', '--format', '{{.Server.Version}}']);
  need('curl', ['--version']);
  need('openssl', ['version']);

  const dir = mkdtempSync(join(tmpdir(), 'mock-mtls-proof-'));
  const container = `mock-mtls-proof-${process.pid}`;
  const host = { normal: 'mock.proof.test', mtls: 'mock-mtls.proof.test' };
  let backend;
  let caddy;
  let caddyLog = '';
  let caddyExited = false;
  const cleanup = () => {
    spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
    caddy?.kill('SIGKILL');
    backend?.closeAllConnections();
    backend?.close();
    rmSync(dir, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(130); });

  try {
    const agents = join(dir, 'agents');
    mkdirSync(agents, { mode: 0o700 });
    const mainText = readFileSync(join(here, 'Caddyfile'), 'utf8');
    const snippetText = readFileSync(join(here, 'Caddyfile.mock-systems.snippet'), 'utf8');
    const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });

    // Step 1: caddy validate on the real main Caddyfile, with the real snippet and the snippet of one agent in the folder that the import line reads.
    const validateDir = join(dir, 'validate');
    mkdirSync(join(validateDir, 'agents'), { recursive: true });
    writeFileSync(join(validateDir, 'Caddyfile'), mainText);
    writeFileSync(join(validateDir, 'agents', 'mock-systems.snippet'), fillSnippet(snippetText, { host: 'mock.example.test', mtlsHost: 'mock-mtls.example.test', upstream: UPSTREAM }));
    writeFileSync(join(validateDir, 'agents', 'agent.snippet'), fillAgentSnippet(AGENT_SNIPPET, { host: 'agent.example.test', servicePort: 9101, runtimePort: 8101 }));
    const validated = docker('run', '--rm', '--memory', '256m', '-v', `${join(validateDir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${join(validateDir, 'agents')}:/etc/caddy/agents:ro`,
      image, 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile');
    const validateLine = `${validated.stderr}${validated.stdout}`.trim().split('\n').filter((l) => /Valid configuration|Error|error/.test(l)).join(' | ');
    console.log(`caddy validate (the real Caddyfile, the mock snippet and one agent snippet): exit ${validated.status}; ${validateLine}`);
    if (validated.status !== 0) throw new Error('caddy validate failed');

    // Step 2: the proof setup. The snippet gets high ports and test host names. The main Caddyfile gets the options of a local run.
    writeFileSync(join(dir, 'Caddyfile'), proofCaddyfile(mainText, { httpPort: port.http, httpsPort: port.https }));
    writeFileSync(join(agents, 'mock-systems.snippet'), fillSnippet(snippetText, {
      host: `${host.normal}:${port.https}`, mtlsHost: `${host.mtls}:${port.https}`, upstream: `127.0.0.1:${port.backend}`,
    }));
    const certA = makeClientCert(dir, 'client-a', 'spiffe://proof.example/client-a');
    const certB = makeClientCert(dir, 'client-b', 'spiffe://proof.example/client-b');

    backend = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ method: req.method, url: req.url, rawHeaders: req.rawHeaders }));
    });
    await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(port.backend, '127.0.0.1', resolve); });

    caddy = spawn('docker', ['run', '--rm', '--name', container, '--network', 'host', '--memory', '512m', '--cpus', '1',
      '-v', `${join(dir, 'Caddyfile')}:/etc/caddy/Caddyfile:ro`, '-v', `${agents}:/etc/caddy/agents:ro`,
      image, 'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'], { stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [caddy.stdout, caddy.stderr]) stream.on('data', (chunk) => { caddyLog = `${caddyLog}${chunk}`.slice(-6000); });
    caddy.on('exit', () => { caddyExited = true; });

    const rootPath = join(dir, 'root.crt');
    await until('the local CA of Caddy', 60, () => {
      if (caddyExited) throw new Error(`Caddy stopped:\n${caddyLog}`);
      const r = docker('exec', container, 'cat', '/data/caddy/pki/authorities/local/root.crt');
      if (r.status !== 0 || !r.stdout.includes('BEGIN CERTIFICATE')) return false;
      writeFileSync(rootPath, r.stdout);
      return true;
    }, () => `Caddy log:\n${caddyLog}`);
    const version = docker('exec', container, 'caddy', 'version').stdout.trim().split(' ')[0];

    const bodyPath = join(dir, 'body.json');
    const call = async ({ proto, to, cert, headers = [], hostHeader }) => {
      const args = ['--silent', '--show-error', '--max-time', '20', proto === 'h2' ? '--http2' : '--http1.1', '--cacert', rootPath,
        '--resolve', `${host[to]}:${port.https}:127.0.0.1`, '--output', bodyPath, '--write-out', '%{http_code} %{http_version}'];
      if (cert) args.push('--cert', cert.crt, '--key', cert.key);
      for (const h of headers) args.push('--header', h);
      if (hostHeader) args.push('--header', `Host: ${hostHeader}:${port.https}`);
      args.push(`https://${host[to]}:${port.https}/echo`);
      const r = await run('curl', args);
      if (r.status !== 0) return { error: `curl exit ${r.status}: ${r.stderr.trim()}` };
      const [status, httpVersion] = r.stdout.trim().split(' ');
      // Only the echo backend gives a body with its list of headers. A request that no route of Caddy handles gets no such body.
      let seen = null;
      try {
        const echo = JSON.parse(readFileSync(bodyPath, 'utf8'));
        if (Array.isArray(echo.rawHeaders)) seen = echo.rawHeaders;
      } catch { /* a refusal has no echo body */ }
      return { status: Number(status), httpVersion, reached: seen !== null, cert: headerValues(seen ?? [], 'client-cert'), chain: headerValues(seen ?? [], 'client-cert-chain') };
    };
    let last = {};
    await until('the normal host name', 60, async () => {
      if (caddyExited) throw new Error(`Caddy stopped:\n${caddyLog}`);
      last = await call({ proto: 'h1', to: 'normal' });
      return last.status === 200 && last.reached;
    }, () => `Last call: ${JSON.stringify(last)}\nCaddy log:\n${caddyLog}`);

    const forgedB = certB.header;
    const forgedChain = `${certB.header}, ${certA.header}`;
    // Each case: what the client does, and what the backend must see. "none" means that the backend gets no header of that name.
    const cases = [
      { name: 'normal host, no certificate', to: 'normal', want: { cert: 'none', chain: 'none' } },
      { name: 'normal host, forged Client-Cert', to: 'normal', headers: [`Client-Cert: ${forgedB}`], want: { cert: 'none', chain: 'none' } },
      { name: 'normal host, forged client-cert (lower case)', to: 'normal', headers: [`client-cert: ${forgedB}`], want: { cert: 'none', chain: 'none' } },
      { name: 'normal host, forged Client-Cert-Chain', to: 'normal', headers: [`Client-Cert-Chain: ${forgedChain}`], want: { cert: 'none', chain: 'none' } },
      { name: 'normal host, certificate A offered and forged Client-Cert', to: 'normal', cert: certA, headers: [`Client-Cert: ${forgedB}`], want: { cert: 'none', chain: 'none' } },
      { name: 'mtls host, no certificate', to: 'mtls', want: { cert: 'none', chain: 'none' } },
      { name: 'mtls host, no certificate, forged Client-Cert', to: 'mtls', headers: [`Client-Cert: ${forgedB}`], want: { cert: 'none', chain: 'none' } },
      { name: 'mtls host, no certificate, forged Client-Cert-Chain', to: 'mtls', headers: [`Client-Cert-Chain: ${forgedChain}`], want: { cert: 'none', chain: 'none' } },
      { name: 'mtls host, certificate A', to: 'mtls', cert: certA, want: { cert: certA.header, chain: 'none' } },
      { name: 'mtls host, certificate A, forged Client-Cert (certificate B)', to: 'mtls', cert: certA, headers: [`Client-Cert: ${forgedB}`], want: { cert: certA.header, chain: 'none' } },
      { name: 'mtls host, certificate B, forged client-cert (certificate A, lower case)', to: 'mtls', cert: certB, headers: [`client-cert: ${certA.header}`], want: { cert: certB.header, chain: 'none' } },
      { name: 'mtls host, certificate A, forged Client-Cert-Chain', to: 'mtls', cert: certA, headers: [`Client-Cert-Chain: ${forgedChain}`], want: { cert: certA.header, chain: 'none' } },
      // The TLS name is the mtls host and the client sends its certificate, but the Host header names the normal host. The backend must get no certificate header.
      { name: 'TLS name of the mtls host, certificate A, Host header of the normal host', to: 'mtls', cert: certA, hostHeader: host.normal, want: { cert: 'none', chain: 'none' }, anyStatus: true },
    ];

    const rows = [];
    const failures = [];
    for (const proto of ['h1', 'h2']) {
      for (const c of cases) {
        const r = await call({ proto, ...c });
        let shown;
        const problems = [];
        if (r.error) {
          shown = r.error;
          problems.push(r.error);
        } else {
          const describe = (values, own) => (values.length === 0 ? 'absent' : values.length > 1 ? `${values.length} headers` : values[0] === own ? 'the certificate presented' : `other value (${values[0].slice(0, 20)}...)`);
          shown = `${r.reached ? 'reached the backend' : 'did not reach the backend'}; Client-Cert ${describe(r.cert, c.cert?.header)}; Client-Cert-Chain ${describe(r.chain)}`;
          if (r.httpVersion !== (proto === 'h2' ? '2' : '1.1')) problems.push(`the protocol was HTTP/${r.httpVersion}`);
          if (!c.anyStatus && (r.status !== 200 || !r.reached)) problems.push(r.reached ? `status ${r.status}` : `status ${r.status}, and the request did not reach the backend`);
          if (c.want.cert === 'none' ? r.cert.length !== 0 : !(r.cert.length === 1 && r.cert[0] === c.want.cert)) problems.push('Client-Cert at the backend is wrong');
          if (r.chain.length !== 0) problems.push('Client-Cert-Chain reached the backend');
        }
        rows.push({ name: c.name, proto: proto === 'h2' ? 'HTTP/2' : 'HTTP/1.1', status: r.status ?? '-', shown, ok: problems.length === 0 });
        if (problems.length > 0) failures.push(`${c.name} (${proto}): ${problems.join('; ')}`);
      }
    }

    console.log(`\nCaddy ${version} in ${image}; hosts ${host.normal} and ${host.mtls} on 127.0.0.1:${port.https}; backend 127.0.0.1:${port.backend}`);
    console.log('Client certificates: A and B are self-signed. No CA of Caddy knows them.\n');
    const width = Math.max(...rows.map((r) => r.name.length));
    for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(width)}  ${r.proto.padEnd(8)}  ${String(r.status).padEnd(3)}  ${r.shown}`);
    console.log(`\n${rows.length - failures.length} of ${rows.length} checks pass.`);
    for (const f of failures) console.log(`FAILED: ${f}`);
    if (failures.length > 0) process.exitCode = 1;
  } finally {
    cleanup();
    console.log(`removed: container ${container}, folder ${dir}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
