// agents/document-pipeline/test/readme.test.ts
// The README names every environment variable the service reads and every error code it answers with, and these tests keep the page and the code from
// parting: a variable read in src/ that the table does not name fails, so does a name in the table that no code reads, and so does a code with the
// wrong status or one that no source file knows.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { RequestError } from '../src/request.ts';
import type { RequestErrorCode } from '../src/request.ts';
import { CHAIN_SETTINGS, LLM_MODELS_DEFAULT, OCR_SUPPLIER_PKH_DEFAULT, OTHER_SETTINGS, PORT_DEFAULT, SHUTDOWN_WAIT_MS, STATE_DIR_DEFAULT } from '../src/start.ts';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
// The ledger's native unit is named once in the repository, in docs/HIRE.md. Spelled in two parts, so that a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'i');
const srcDir = new URL('../src/', import.meta.url);
const sources = readdirSync(srcDir).filter((file) => file.endsWith('.ts')).map((file) => ({ file, text: readFileSync(new URL(file, srcDir), 'utf8') }));
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

/** The names the code reads from the environment itself: `env.NAME`, `process.env.NAME`, and the names given to envInt and requiredEnv. */
function namesRead(): string[] {
  const found = new Set<string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]*)\b/g)) found.add(m[1]);
    for (const m of text.matchAll(/\b(?:envInt|requiredEnv)\(\s*'([A-Z][A-Z0-9_]*)'/g)) found.add(m[1]);
  }
  return [...found].sort();
}
// What buyer-core reads (src/vendored/mcp-shared/config.ts) and the README names in a sentence, not in its table.
const READ_BY_BUYER_CORE = ['VECTOR_KOIOS_URL', 'VECTOR_OGMIOS_URL', 'VECTOR_SUBMIT_URL'];

describe('agents/document-pipeline/README.md', () => {
  test('the Manifest table names exactly the variables the service reads', () => {
    const table = section('Manifest').split('\n').filter((line) => /^\| `[A-Z]/.test(line));
    const documented = table.flatMap((line) => ticks(line.split('|')[1])).sort();
    expect(documented.length).toBeGreaterThanOrEqual(18);
    expect(documented).toStrictEqual(namesRead());
    for (const name of READ_BY_BUYER_CORE) expect(section('Manifest'), name).toContain(`\`${name}\``);
  });

  test('the defaults the table gives are the code\'s', () => {
    const row = (name: string): string => section('Manifest').split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
    expect(row('OCR_ALLOWLIST_SUPPLIER_PKH')).toContain(`\`${OCR_SUPPLIER_PKH_DEFAULT}\``);
    expect(row('LLM_MODEL_ALLOWLIST')).toContain(`\`${LLM_MODELS_DEFAULT.join(',')}\``);
    expect(row('PIPELINE_STATE_DIR')).toContain(`\`${STATE_DIR_DEFAULT}\``);
    expect(row('PORT')).toContain(`\`${PORT_DEFAULT}\``);
    expect(row('ADVERT_PRICE_LOVELACE')).toContain('`5000000`');
    expect(row('ADVERT_MAX_PROCESSING_MS')).toContain('`1800000`');
    expect(row('AGENT_STATUS_CHIP')).toContain('`proposed`');
    expect(row('AGENT_STATUS_SINCE')).toContain('`2026-10-15`');
    expect(row('AGENT_VERSION')).toContain('`0.1.0`');
  });

  test('the Errors table gives each code of the intake its status, and every code it names is one the sources know', () => {
    const rows = section('Errors').split('\n').filter((line) => /^\| \d{3}, /.test(line));
    expect(rows).toHaveLength(7);
    const intake: RequestErrorCode[] = [
      'bad_json', 'bad_shape', 'schema_required', 'max_pages_range', 'base64_too_large', 'language_bad',
      'source_fetch_failed', 'source_mime_mismatch', 'source_unsupported', 'source_too_large', 'unreadable_source',
    ];
    const all = sources.map(({ text }) => text).join('\n');
    const documented = new Set<string>();
    for (const row of rows) {
      const status = Number(/^\| (\d{3}), /.exec(row)?.[1]);
      for (const code of ticks(row.split('|')[2])) {
        documented.add(code);
        if (code.endsWith('_')) continue; // `ocr_` and `llm_`, the two prefixes of the hire failures
        expect(all, code).toContain(`'${code}'`);
        if ((intake as string[]).includes(code)) expect(new RequestError(code as RequestErrorCode, 'x').status, code).toBe(status);
      }
    }
    for (const code of intake) expect(documented.has(code), code).toBe(true);
    for (const code of ['insufficient_float', 'ocr_supplier_unavailable', 'llm_supplier_unavailable', 'shutting_down']) expect(rows.find((row) => row.includes(`\`${code}\``)), code).toMatch(/^\| 503, /);
    expect(rows.find((row) => row.includes('`store_write_failed`'))).toMatch(/^\| 500, /);
    expect(rows.find((row) => row.includes('`unauthorized`'))).toMatch(/^\| 401, /); // R50: a call without the token of the runtime
    expect(rows.find((row) => row.includes('`schema_invalid`'))).toMatch(/^\| 400, /);
    for (const code of ['bad_wire', 'request_too_large']) expect(rows.find((row) => row.includes(`\`${code}\``))).toMatch(/^\| 400, /);
  });

  test('the settings the service looks in for a buyer key put in the wrong line are the ones it reads, all but the key itself', () => {
    expect([...OTHER_SETTINGS, 'PIPELINE_BUYER_PRIV_KEY_HEX'].sort()).toStrictEqual(namesRead());
    expect([...CHAIN_SETTINGS].sort()).toStrictEqual(READ_BY_BUYER_CORE);
  });

  test('it explains why a long job is kept alive with 102 Processing, what a 5xx tells the buyer, how the service stops, and what it checks at start', () => {
    expect(readme).toContain('102 Processing');
    expect(readme).toMatch(/runtime's fetch gives up after 300 s of silence/);
    expect(readme).toContain("The service could not do this job (<code>). The operator's log has the detail.");
    expect(readme).toMatch(/SIGTERM/);
    expect(readme).toMatch(/stop_grace_period/);
    expect(readme).toContain(`${SHUTDOWN_WAIT_MS / 1000} s`);
    expect(readme).toMatch(/asks `pdfinfo` and `pdftoppm` \(poppler-utils\) for their version/);
    expect(readme).toMatch(/at least 1800000/);
  });

  test('the example reads the key from a file and never writes it on a command line', () => {
    expect(readme).toContain('PIPELINE_BUYER_PRIV_KEY_HEX="$(cat ');
    expect(readme).not.toMatch(/PIPELINE_BUYER_PRIV_KEY_HEX=[<0-9a-f]/);
  });

  // R50: the service shares a network with other stacks and a job spends from the buyer wallet, so it answers only the runtime, which sends its
  // SERVICE_AUTH_HEADER as the authorization header of every call (vector-agent-template c4c378a, agent/src/executor/httpCallout.ts).
  test('it says that POST / needs the authorization header the runtime sends, the 401 without it, the routes that stay open, and that the token is made, not typed (R50)', () => {
    expect(readme).toContain('`POST /` requires the `authorization` header to be exactly the value of `SERVICE_AUTH_HEADER`');
    expect(readme).toContain('the value the template runtime sends with every call to a custom service');
    expect(readme).toContain('401 `{"error":"unauthorized"}`, with no detail');
    expect(readme).toMatch(/before the body is read and before a job slot is taken/);
    expect(readme).toMatch(/in constant time \(`crypto\.timingSafeEqual` on their sha256 digests/);
    expect(readme).toContain('`GET /healthz` and `GET /agent.json` need no header: the image\'s health check sends none, and the manifest is public');
    expect(readme).not.toMatch(/does not authenticate/);
    const run = section('Run it');
    expect(run).toContain('export SERVICE_AUTH_HEADER="Bearer $(openssl rand -hex 32)"');
    expect(run).toContain('when `OPERATOR_CONTACT`, `PIPELINE_BUYER_PRIV_KEY_HEX`, `SUPPLIER_PKH` or `SERVICE_AUTH_HEADER` is not set');
    expect(readme).not.toMatch(/SERVICE_AUTH_HEADER=["']?Bearer [0-9a-f]/); // no token in the page
    const row = section('Manifest').split('\n').find((line) => line.startsWith('| `SERVICE_AUTH_HEADER`')) ?? '';
    expect(row).toContain('the `authorization` header the runtime sends with every call');
    expect(row).toContain('Required: the service stops at start without it');
    expect(row).toContain('Never published, never logged');
    expect(section('Routes')).toContain('| `POST /` | the wire message and nothing else, with the `authorization` header of the runtime. Without it, 401 |');
  });

  test('it says the status the manifest and the code give, and nothing in it is a dash, a unit name or a key', () => {
    expect(readme).toContain('Status: PROPOSED (built, not deployed). Since 2026-10-15.');
    expect(readme).not.toMatch(/[\u{2013}\u{2014}]/u);
    expect(readme).not.toMatch(UNIT_NAME);
    expect(readme).not.toMatch(/[0-9a-f]{64}/); // no key, no 64-hex value of any kind
    expect(readme.match(/\b(LIVE|DEPLOYED)\b/g)).toBeNull(); // the words are only ever said in lower case here, as the values the manifest carries
  });
});
