// agents/document-pipeline/test/start.test.ts
// How the service starts. loadConfig reads the environment (three settings are required, the rest have defaults), derives the buyer key hash and the
// mainnet enterprise address from the key and refuses a PIPELINE_BUYER_PKH or PIPELINE_BUYER_ADDRESS that is not the key's (ruling R44), so that the buyer
// key hash the manifest publishes is the key that signs. startService puts the real parts together (the chain from the key, the stranded store in the state
// directory, the janitor on it, the server) and is run here with the parts a test can replace. The last tests run src/index.ts as a process: the exit at
// start with the variable named, and one start against a node that is not there.
import { describe, test, expect, afterEach } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeChain } from '@vsa/buyer-core';
import { StrandedStore } from '../src/janitor.ts';
import { WRITE_PROBE, loadConfig, startService } from '../src/start.ts';
import type { StartOptions } from '../src/start.ts';
import { fakeRenderer } from './fake-renderer.ts';
import { BUYER, BUYER_ADDRESS, FULL_ENV, SUPPLIER, TEST_CONTACT, cleanDirs, noFetch, tempDir, until, wire } from './server-support.ts';
import { ALLOWLIST, INDEXER, SUMMARY, escrowNo, marketplace } from './stub-suppliers.ts';
import { TWO_PAGES_PDF, toBase64 } from './support.ts';

const OCR_DEFAULT = '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9';
const MODELS_DEFAULT = ['deepseek/deepseek-v4-flash', 'deepseek-v4-pro', 'moonshotai/kimi-k2.6', 'Qwen/Qwen3.6-35B-A3B-FP8'];
const thrown = (fn: () => unknown): Error => {
  try { fn(); } catch (e) { return e as Error; }
  throw new Error('it did not throw');
};
/** A port nothing listens on: one that was just given back. */
const closedPort = () => new Promise<number>((resolve, reject) => {
  const probe = netServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

describe('loadConfig', () => {
  test('a full environment gives the defaults for everything the operator leaves out', () => {
    const config = loadConfig(FULL_ENV);
    expect(config).toMatchObject({ host: '0.0.0.0', port: 9092, stateDir: '/data', ocrAllowlistPkh: OCR_DEFAULT, llmAllowlist: MODELS_DEFAULT, privateKeyHex: BUYER.privateKeyHex });
    expect(config.indexerUrl).toBeUndefined();
    expect(config.manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-10-15' });
  });

  test('every setting is read: the OCR supplier key hash, the chat models in order, the state directory, the indexer, the port and the host', () => {
    const config = loadConfig({
      ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: 'AB'.repeat(28), LLM_MODEL_ALLOWLIST: ' model-a, model-b ,, model-c ', PIPELINE_STATE_DIR: '/var/pipeline', VECTOR_MARKETPLACE_INDEXER_URL: ' https://indexer.example.test/ ',
      PORT: '9100', HOST: '127.0.0.1',
    });
    expect(config).toMatchObject({ ocrAllowlistPkh: 'ab'.repeat(28), llmAllowlist: ['model-a', 'model-b', 'model-c'], stateDir: '/var/pipeline', indexerUrl: 'https://indexer.example.test/', port: 9100, host: '127.0.0.1' });
  });

  test('a setting that is set and empty means its default', () => {
    const config = loadConfig({ ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: '', LLM_MODEL_ALLOWLIST: '', PIPELINE_STATE_DIR: '', VECTOR_MARKETPLACE_INDEXER_URL: '', PORT: '', HOST: '' });
    expect(config).toMatchObject({ ocrAllowlistPkh: OCR_DEFAULT, llmAllowlist: MODELS_DEFAULT, stateDir: '/data', port: 9092, host: '0.0.0.0' });
    expect(config.indexerUrl).toBeUndefined();
  });

  test('three settings are required, checked in this order, and the error names the variable', () => {
    expect(thrown(() => loadConfig({})).message).toMatch(/environment variable OPERATOR_CONTACT is required/);
    expect(thrown(() => loadConfig({ OPERATOR_CONTACT: TEST_CONTACT })).message).toMatch(/environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required/);
    expect(thrown(() => loadConfig({ OPERATOR_CONTACT: TEST_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX: BUYER.privateKeyHex })).message).toMatch(/environment variable SUPPLIER_PKH is required/);
    for (const blank of ['', ' ', '\t\n']) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, OPERATOR_CONTACT: blank })).message, JSON.stringify(blank)).toMatch(/OPERATOR_CONTACT/);
      expect(thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: blank })).message, JSON.stringify(blank)).toMatch(/PIPELINE_BUYER_PRIV_KEY_HEX/);
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: blank })).message, JSON.stringify(blank)).toMatch(/SUPPLIER_PKH/);
    }
    // A line break at the end of a value from a file is not part of it.
    expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: `${BUYER.privateKeyHex}\r\n`, SUPPLIER_PKH: ` ${SUPPLIER.pkh}\n` }).privateKeyHex).toBe(BUYER.privateKeyHex);
  });

  test('a key that is not 64 lowercase hex characters is refused with the variable named, and what it was given is never echoed', () => {
    for (const bad of [BUYER.privateKeyHex.toUpperCase(), BUYER.privateKeyHex.slice(2), `${BUYER.privateKeyHex}00`, `0x${BUYER.privateKeyHex}`, 'g'.repeat(64), '<the buyer key>']) {
      const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PRIV_KEY_HEX: bad }));
      expect(error.message, bad).toMatch(/environment variable PIPELINE_BUYER_PRIV_KEY_HEX must be 64 lowercase hex characters/);
      expect(error.message).not.toContain(bad);
      expect(error.message).not.toContain(BUYER.privateKeyHex);
    }
  });

  test('the supplier key hash is 56 hex characters and is published in lower case; the public key, when given, is 64', () => {
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase() }).manifest.keys.supplier_pkh).toBe(SUPPLIER.pkh);
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PKH: SUPPLIER.pkh.toUpperCase() }).manifest.identity.controller_pkh).toBe(SUPPLIER.pkh);
    for (const bad of ['<SUPPLIER_PKH>', SUPPLIER.pkh.slice(1), `${SUPPLIER.pkh}00`, 'zz'.repeat(28)]) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PKH: bad })).message, bad).toMatch(/environment variable SUPPLIER_PKH must be 56 hex characters/);
    }
    expect(loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: '' }).manifest.keys.pub_key_hex).toBe('');
    for (const bad of ['<SUPPLIER_PUB_KEY_HEX>', SUPPLIER.pubKeyHex.slice(1), `${SUPPLIER.pubKeyHex}00`]) {
      expect(thrown(() => loadConfig({ ...FULL_ENV, SUPPLIER_PUB_KEY_HEX: bad })).message, bad).toMatch(/environment variable SUPPLIER_PUB_KEY_HEX must be 64 hex characters/);
    }
  });

  test('the other settings that are given must be well formed, and the error names the variable', () => {
    expect(thrown(() => loadConfig({ ...FULL_ENV, OCR_ALLOWLIST_SUPPLIER_PKH: 'abc' })).message).toMatch(/environment variable OCR_ALLOWLIST_SUPPLIER_PKH must be 56 hex characters/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, LLM_MODEL_ALLOWLIST: ' , ,' })).message).toMatch(/environment variable LLM_MODEL_ALLOWLIST must name at least one model/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, PORT: 'ninety' })).message).toMatch(/PORT/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, ADVERT_PRICE_LOVELACE: 'x' })).message).toMatch(/ADVERT_PRICE_LOVELACE/);
    expect(thrown(() => loadConfig({ ...FULL_ENV, AGENT_STATUS_CHIP: 'launched' })).message).toMatch(/AGENT_STATUS_CHIP/);
  });

  describe('the buyer identity (ruling R44)', () => {
    test('is derived from the key, as the key hash and the mainnet enterprise address, and the manifest publishes the hash whether or not the operator wrote it down', () => {
      const config = loadConfig(FULL_ENV);
      expect(config.buyer).toStrictEqual({ buyerPkh: BUYER.pkh, address: BUYER_ADDRESS });
      expect(config.buyer.address.startsWith('addr1v')).toBe(true);
      expect(config.manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      const written = loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: BUYER.pkh, PIPELINE_BUYER_ADDRESS: BUYER_ADDRESS });
      expect(written.manifest).toStrictEqual(config.manifest);
    });

    test('a hash or an address written down that is the key\'s is accepted, in any case; blank means not written', () => {
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: BUYER.pkh.toUpperCase() }).manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: '', PIPELINE_BUYER_ADDRESS: '  ' }).buyer.buyerPkh).toBe(BUYER.pkh);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: ` ${BUYER_ADDRESS}\n` }).buyer.address).toBe(BUYER_ADDRESS);
      expect(loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: BUYER_ADDRESS.toUpperCase() }).buyer.address).toBe(BUYER_ADDRESS);
    });

    test('a hash that is not the key\'s is refused at start, naming the variable and the key hash it was checked against, and never the key', () => {
      for (const wrong of ['cd'.repeat(28), SUPPLIER.pkh, '<PIPELINE_BUYER_PKH>', 'abc']) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_PKH: wrong }));
        expect(error.message, wrong).toMatch(/environment variable PIPELINE_BUYER_PKH/);
        expect(error.message).toContain(BUYER.pkh);
        expect(error.message).toMatch(/PIPELINE_BUYER_PRIV_KEY_HEX/);
        expect(error.message).not.toContain(BUYER.privateKeyHex);
      }
    });

    test('an address that is not the key\'s is refused the same way', () => {
      const other = new FakeChain({ buyerPkh: SUPPLIER.pkh }).address;
      for (const wrong of [other, 'addr1not-an-address', `${BUYER_ADDRESS}0`]) {
        const error = thrown(() => loadConfig({ ...FULL_ENV, PIPELINE_BUYER_ADDRESS: wrong }));
        expect(error.message, wrong).toMatch(/environment variable PIPELINE_BUYER_ADDRESS/);
        expect(error.message).toContain(BUYER_ADDRESS);
        expect(error.message).not.toContain(BUYER.privateKeyHex);
      }
    });
  });
});

describe('startService', () => {
  const running: Array<{ stop: () => Promise<void> }> = [];
  afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())); cleanDirs(); });
  const logs: string[] = [];
  afterEach(() => { logs.length = 0; });
  const envIn = (dir: string, over: Record<string, string> = {}) => ({ ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', PIPELINE_STATE_DIR: dir, ...over });
  const optionsWith = (over: StartOptions = {}): StartOptions => ({
    createChain: async () => new FakeChain({ buyerPkh: BUYER.pkh }), fetchImpl: noFetch, renderer: fakeRenderer(), log: (line) => { logs.push(line); }, janitorIntervalMs: 3_600_000, ...over,
  });
  async function start(env: Record<string, string>, over: StartOptions = {}) {
    const service = await startService(env, optionsWith(over));
    running.push(service);
    return service;
  }

  test('listens, serves the manifest with the buyer hash derived from the key, and is healthy', async () => {
    const service = await start(envIn(tempDir()));
    const base = `http://127.0.0.1:${service.port}`;
    const manifest = await (await fetch(`${base}/agent.json`)).json();
    expect(manifest.keys).toStrictEqual({ supplier_pkh: SUPPLIER.pkh, pub_key_hex: SUPPLIER.pubKeyHex, buyer_pkh: BUYER.pkh });
    expect(manifest.operator.contact).toBe(TEST_CONTACT);
    expect(await (await fetch(`${base}/healthz`)).json()).toStrictEqual({ ok: true });
    expect(logs.join('\n')).toContain(`listening on 127.0.0.1:${service.port}`);
  });

  test('makes the chain from the key of the environment, and logs the address to fund but never a key', async () => {
    const keys: string[] = [];
    await start(envIn(tempDir()), { createChain: async ({ privateKeyHex }) => { keys.push(privateKeyHex); return new FakeChain({ buyerPkh: BUYER.pkh }); } });
    expect(keys).toStrictEqual([BUYER.privateKeyHex]);
    expect(logs.join('\n')).toContain(BUYER_ADDRESS);
    expect(logs.join('\n')).not.toContain(BUYER.privateKeyHex);
  });

  test('starts the janitor on the stranded store in the state directory: it looks at an escrow left there by an earlier run', async () => {
    const dir = tempDir();
    const ref = `${'ab'.repeat(32)}#0`;
    new StrandedStore(dir).add({ escrow_ref: ref, deliver_by: 1_000, posted_at: 0, kind: 'ocr' }); // long past its deliver_by; no chain knows it, so it reads unknown
    await start(envIn(dir));
    await until(() => logs.some((line) => line.includes(`janitor: kept ${ref}`)), 'the janitor has made its first pass');
    expect(logs.find((line) => line.includes(`janitor: kept ${ref}`))).toMatch(/unknown/);
  });

  test('a job runs on the settings of the environment: the OCR supplier key, the models and the indexer it names, and the stranded store in its state directory', async () => {
    const m = marketplace();
    const dir = tempDir();
    const env = envIn(dir, { OCR_ALLOWLIST_SUPPLIER_PKH: m.ocr.key.pkh, LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), VECTOR_MARKETPLACE_INDEXER_URL: INDEXER });
    const parts: StartOptions = { createChain: async () => m.chain, fetchImpl: m.fetchImpl, renderer: fakeRenderer({ total: 2 }), clock: () => m.clock.now, sleep: async (ms) => { m.clock.now += ms; } };
    const request = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const service = await start(env, parts);
    const reply = await fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', body: wire(request) });
    const result = await reply.json();
    expect(reply.status).toBe(200);
    expect(result.result).toStrictEqual({ summary: SUMMARY });
    expect(result.accounting.sub_jobs).toBe(3);
    await expect(m.chain.escrowState(escrowNo(3))).resolves.toBe('spent');
    expect(JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8'))).toStrictEqual([]); // the store is there, and everything was accepted
    // The next job: the OCR supplier signs with a key that is not its own, the receipt fails, and the escrow it left is in the state directory.
    m.ocr.forge = true;
    const failed = await fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', body: wire(request) });
    expect(failed.status).toBe(422);
    expect((await failed.json()).error).toBe('ocr_receipt_failed');
    const kept = JSON.parse(readFileSync(join(dir, 'stranded.json'), 'utf8')) as Array<{ escrow_ref: string; kind: string }>;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ escrow_ref: escrowNo(4), kind: 'ocr' });
  });

  test('a wrong buyer hash is refused before anything is made: no chain, no state directory, no listener', async () => {
    const dir = join(tempDir(), 'state');
    let made = 0;
    await expect(startService(envIn(dir, { PIPELINE_BUYER_PKH: 'cd'.repeat(28) }), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/PIPELINE_BUYER_PKH/);
    expect(made).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test('a stranded file that is not a list stops the start before a chain is made, and the file is left as it is', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'stranded.json'), 'this is not a list', 'utf8');
    let made = 0;
    await expect(startService(envIn(dir), optionsWith({ createChain: async () => { made += 1; return new FakeChain(); } }))).rejects.toThrow(/stranded\.json is not a list of stranded escrows/);
    expect(made).toBe(0);
    expect(readFileSync(join(dir, 'stranded.json'), 'utf8')).toBe('this is not a list');
  });

  test('a state directory that cannot be written stops the start before a chain is made, and a good one is left as it was found', async () => {
    const bad = tempDir();
    mkdirSync(join(bad, WRITE_PROBE)); // a directory where the probe file goes: writing it fails on every platform
    let made = 0;
    const makeChain = async () => { made += 1; return new FakeChain(); };
    await expect(startService(envIn(bad), optionsWith({ createChain: makeChain }))).rejects.toThrow(/environment variable PIPELINE_STATE_DIR names .* which cannot be written/);
    expect(made).toBe(0);
    const good = tempDir();
    await start(envIn(good));
    expect(readdirSync(good)).toStrictEqual([]); // no probe left behind, and no stranded file until there is an escrow to put in it
  });

  test('a start that fails once the port is open closes the port again', async () => {
    const free = await closedPort();
    await expect(startService(envIn(tempDir(), { PORT: String(free) }), optionsWith({ janitorIntervalMs: 0 }))).rejects.toThrow(/janitor interval/);
    await expect(fetch(`http://127.0.0.1:${free}/healthz`)).rejects.toThrow();
  });

  test('a port that is taken stops the start with the reason', async () => {
    const first = await start(envIn(tempDir()));
    await expect(startService(envIn(tempDir(), { PORT: String(first.port) }), optionsWith())).rejects.toThrow(/EADDRINUSE|address already in use/);
  });

  test('stop closes the server and the janitor', async () => {
    const service = await start(envIn(tempDir()));
    await service.stop();
    await expect(fetch(`http://127.0.0.1:${service.port}/healthz`)).rejects.toThrow();
    await service.stop(); // safe to call twice
  });

  test('stop does not wait for a job that is running: its connection is closed', async () => {
    let asked = false;
    const hang = (async () => { asked = true; return new Promise<Response>(() => {}); }) as typeof fetch; // the indexer never answers
    const service = await start(envIn(tempDir()), { fetchImpl: hang });
    const request = { source: { pdf_b64: toBase64(TWO_PAGES_PDF), mime: 'application/pdf' }, task: 'summary' };
    const job = fetch(`http://127.0.0.1:${service.port}/`, { method: 'POST', body: wire(request) }).then(() => 'answered', () => 'closed');
    await until(() => asked, 'the job has reached the indexer');
    await service.stop();
    expect(await job).toBe('closed');
  });

});

// ---- The process --------------------------------------------------------------------------------------------------------------------
describe('src/index.ts as a process', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  // What the service reads, taken out of the environment the tests run in, so that nothing an operator has set can change what a test sees.
  const READ = [
    'OPERATOR_CONTACT', 'PIPELINE_BUYER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SUPPLIER_PUB_KEY_HEX', 'AGENT_DID', 'AGENT_VERSION', 'AGENT_STATUS_CHIP', 'AGENT_STATUS_SINCE',
    'ADVERT_PRICE_LOVELACE', 'ADVERT_MAX_PROCESSING_MS', 'ADVERT_EXPLORER_URL', 'PIPELINE_BUYER_PKH', 'PIPELINE_BUYER_ADDRESS', 'OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST',
    'PIPELINE_STATE_DIR', 'VECTOR_MARKETPLACE_INDEXER_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_KOIOS_URL', 'VECTOR_SUBMIT_URL', 'PORT', 'HOST',
  ];
  const baseEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...process.env };
    for (const name of READ) delete env[name];
    return env;
  };
  const NODE_ARGS = ['--import', 'tsx', 'src/index.ts'];
  const run = (env: Record<string, string>) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, NODE_ARGS, { cwd, env: { ...baseEnv(), ...env, PORT: '0', HOST: '127.0.0.1' }, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: unknown } | null)?.code;
      resolve({ status: error === null ? 0 : typeof code === 'number' ? code : null, stdout, stderr });
    });
  });

  test('exits 1 at start with the variable named, and listens on nothing, when a required setting is missing or the buyer hash is not the key\'s', async () => {
    const { OPERATOR_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH } = FULL_ENV;
    const cases: Array<[string, Record<string, string>, RegExp]> = [
      ['OPERATOR_CONTACT is not set', { PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, /environment variable OPERATOR_CONTACT is required/],
      ['OPERATOR_CONTACT is blank', { OPERATOR_CONTACT: '  ', PIPELINE_BUYER_PRIV_KEY_HEX, SUPPLIER_PKH }, /environment variable OPERATOR_CONTACT is required/],
      ['PIPELINE_BUYER_PRIV_KEY_HEX is not set', { OPERATOR_CONTACT, SUPPLIER_PKH }, /environment variable PIPELINE_BUYER_PRIV_KEY_HEX is required/],
      ['SUPPLIER_PKH is not set', { OPERATOR_CONTACT, PIPELINE_BUYER_PRIV_KEY_HEX }, /environment variable SUPPLIER_PKH is required/],
      ['PIPELINE_BUYER_PKH is not the key\'s', { ...FULL_ENV, PIPELINE_BUYER_PKH: 'cd'.repeat(28) }, /environment variable PIPELINE_BUYER_PKH/],
      ['PIPELINE_BUYER_ADDRESS is not the key\'s', { ...FULL_ENV, PIPELINE_BUYER_ADDRESS: new FakeChain({ buyerPkh: SUPPLIER.pkh }).address }, /environment variable PIPELINE_BUYER_ADDRESS/],
    ];
    const results = await Promise.all(cases.map(([, env]) => run(env)));
    cases.forEach(([label, , message], i) => {
      const r = results[i];
      expect(r.status, label).toBe(1);
      expect(r.stderr, label).toMatch(message);
      expect(r.stdout, label).not.toMatch(/listening/);
      expect(r.stderr + r.stdout, label).not.toContain(BUYER.privateKeyHex);
    });
  }, 120_000);

  test('started for real against a node that is not there: it listens, publishes the buyer hash derived from the key, and says its wallet cannot be read', async () => {
    const closed = await closedPort();
    const node = `http://127.0.0.1:${closed}`;
    const dir = tempDir();
    const child = spawn(process.execPath, NODE_ARGS, {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...baseEnv(), ...FULL_ENV, PORT: '0', HOST: '127.0.0.1', PIPELINE_STATE_DIR: dir, VECTOR_OGMIOS_URL: node, VECTOR_KOIOS_URL: `${node}/`, VECTOR_SUBMIT_URL: `${node}/api/submit/tx`, VECTOR_MARKETPLACE_INDEXER_URL: node },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      await until(() => /listening on 127\.0\.0\.1:\d+/.test(stdout), `the service listens (stdout: ${stdout}, stderr: ${stderr})`, 60_000);
      const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(stdout)?.[1]);
      const manifest = await (await fetch(`http://127.0.0.1:${port}/agent.json`)).json();
      expect(manifest.keys.buyer_pkh).toBe(BUYER.pkh);
      expect(manifest.keys.supplier_pkh).toBe(SUPPLIER.pkh);
      expect(stdout).toContain(BUYER_ADDRESS);
      expect(stdout.trim().split('\n').every((line) => line.startsWith('[document-pipeline] '))).toBe(true); // the log is the service's, one line each
      // The first wallet check goes to the node, which is not there: from then on the service says so.
      let status = 200;
      for (let i = 0; i < 300 && status === 200; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        status = (await fetch(`http://127.0.0.1:${port}/healthz`)).status;
      }
      expect(status).toBe(503);
      expect(existsSync(dir)).toBe(true);
      expect(stdout + stderr).not.toContain(BUYER.privateKeyHex);
    } finally {
      const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      child.kill();
      await exited;
    }
  }, 120_000);
});
