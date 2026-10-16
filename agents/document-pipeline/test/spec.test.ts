// agents/document-pipeline/test/spec.test.ts
// specs/document-pipeline.md and the manifest say the same things. The page is written from what the code does, and these tests keep it that way, as
// agents/agent-history/test/spec.test.ts does for its page: the numbers of the Terms, the capability id, the opening line, the identity, the request and the
// response the manifest links to, the third parties, the links, every gap sentence of the manifest word for word (src/gaps.ts), the rules for the extraction
// schema, the response example (the golden result of test/golden.ts), the error codes of the README, and the facts of "How it buys" that are the code's own
// constants.
//
// What these tests do not hold is the Status line and the paragraph under it, the wording of the guide and of the E2E runbook, and the status words of the
// four specs together: scripts/specs.test.mjs holds those, and it cannot import the TypeScript of the service.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { DELIVER_BY_BUFFER_MS, LLM_SELECTION_BUDGET_MS, LLM_SELECTION_MAX_CANDIDATES } from '@vsa/buyer-core';
import { REGISTRY_ADDRESS } from '@vsa/vector-read';
import {
  BUSY_RETRY_MS, JOB_DEADLINE_MS, LLM_MIN_LEFT_MS, LLM_SELECTION_MAX_AGE_MS, OCR_IMAGE_B64_MAX, PAGE_MIN_LEFT_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS,
} from '../src/budget.ts';
import { COMBINATION_MAX_ENTRIES, SCHEMA_MAX_BYTES, SCHEMA_MAX_DEPTH, compileExtractionSchema } from '../src/extract.ts';
import { DEADLINE_GAP, GAPS, SUBSIDY_GAP } from '../src/gaps.ts';
import { JANITOR_GRACE_MS, STRANDED_FILE } from '../src/janitor.ts';
import { llmInput } from '../src/llm-prompt.ts';
import { DEFAULT_LANGUAGE, MAX_INLINE_BYTES, MAX_PAGES, parseRequest } from '../src/request.ts';
import { MAX_PAGE_PIXELS } from '../src/render.ts';
import { PipelineError } from '../src/result.ts';
import { HEARTBEAT_MS, MAX_BODY, manifestFromEnv } from '../src/server.ts';
import { loadSource } from '../src/source.ts';
import { JANITOR_INTERVAL_MS, LLM_MODELS_DEFAULT, OCR_SUPPLIER_PKH_DEFAULT } from '../src/start.ts';
import { GOLDEN } from './golden.ts';
import { TEST_CONTACT } from './server-support.ts';
import { PAGE_0_PNG, text, toBase64 } from './support.ts';

const spec = readFileSync(new URL('../../../specs/document-pipeline.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const hire = readFileSync(new URL('../../../docs/HIRE.md', import.meta.url), 'utf8');
const e2e = readFileSync(new URL('../../../docs/E2E.md', import.meta.url), 'utf8');
const runbook = readFileSync(new URL('../../../deploy/apex-web/RUNBOOK-document-pipeline.md', import.meta.url), 'utf8');
const m = manifestFromEnv({ OPERATOR_CONTACT: TEST_CONTACT });
// The text of one "## heading" section, up to the next "## " heading.
const textOf = (text: string, heading: string): string => { const rest = text.split(`\n## ${heading}\n`)[1]; return rest === undefined ? '' : rest.split('\n## ')[0]; };
const section = (heading: string): string => textOf(spec, heading);
// The text of one "### heading" of the Interface section, up to the next "### " heading.
const sub = (heading: string): string => (section('Interface').split(`\n### ${heading}\n`)[1] ?? '').split('\n### ')[0];
const thousands = (n: number): string => n.toLocaleString('en-US');
const tick = (s: string): string => `\`${s}\``;

describe('specs/document-pipeline.md', () => {
  test('the Terms tables carry the numbers of the manifest', () => {
    const t = m.terms;
    const printed = (n: number) => (n / 1_000_000).toFixed(6);
    const terms = section('Terms');
    expect(terms).toContain(`| Price | ${t.price_lovelace} | ${printed(t.price_lovelace)} |`);
    expect(terms).toContain(`| Supplier bond | ${t.supplier_bond_lovelace} | ${printed(t.supplier_bond_lovelace)} |`);
    expect(terms).toContain(`| Buyer bond | ${t.buyer_bond_lovelace} | ${printed(t.buyer_bond_lovelace)} |`);
    const locked = t.price_lovelace + t.supplier_bond_lovelace + t.buyer_bond_lovelace;
    expect(terms).toContain(`| Locked by the buyer (price and both bonds) | ${locked} | ${printed(locked)} |`);
    expect(terms).toContain(`| Processing window, advert \`max_processing_ms\` | ${t.max_processing_ms} ms`);
    // The runtime's service timeout is the job's own deadline plus 60 s, so that a run answers before the runtime gives up on it.
    expect(terms).toContain(`| Service timeout, \`SERVICE_TIMEOUT_MS\` | ${JOB_DEADLINE_MS + 60_000} ms |`);
    expect(terms).toContain(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms (60 s inside the service timeout) |`);
    expect(terms).toContain(`| Fetched source | ${t.input_limits.source_bytes / (1024 * 1024)} MB |`);
    expect(terms).toContain(`| \`max_pages\` | ${t.input_limits.max_pages} in v1 |`);
    expect(terms).toContain('| PDF pages | rendered to PNG at 150 dpi |');
  });

  test('the Interface section gives the limits of the manifest in words', () => {
    const t = m.terms.input_limits;
    const text = section('Interface').replace(/\s+/g, ' ');
    expect(text).toContain(`The wire payload is capped at ${thousands(t.request_bytes)} bytes`);
    expect(text).toContain(`base64 of at most ${thousands(t.inline_media_bytes)} bytes of raw media`);
    expect(text).toContain(`and a ${t.source_bytes / (1024 * 1024)} MB cap`);
    expect(text).toContain(`POST ${m.interface.routes.job}`);
  });

  test('the capability id and the model string', () => {
    expect(section('Capability id')).toContain(`\`${m.capability_id}\``);
    expect(section('Capability id')).toContain('`document-pipeline-v1`');
  });

  test('the opening line says what the manifest description says', () => {
    expect(spec.split('\n')[2]).toContain(m.description);
  });

  test('the status word is the manifest\'s', () => {
    expect(section('Status').trimStart().startsWith(`${m.status.chip.toUpperCase()} (`)).toBe(true);
  });

  test('the identity: the registry address, and both key hashes under keys', () => {
    const identity = section('Identity');
    expect(identity).toContain(`\`${REGISTRY_ADDRESS}\``);
    expect(m.identity.registry_address).toBe(REGISTRY_ADDRESS);
    for (const key of ['supplier_pkh', 'buyer_pkh']) {
      expect(Object.keys(m.keys)).toContain(key);
      expect(identity).toContain(`\`${key}\``);
    }
  });

  test('the request: the spec shows every field of the schema the manifest publishes, with the same values', () => {
    const request = spec.split('\n### Request\n')[1].split('\n### Response\n')[0];
    const schema = m.interface.request_schema;
    for (const name of Object.keys(schema.properties)) expect(request, name).toContain(`"${name}"`);
    expect(schema.required).toStrictEqual(['source', 'task']);
    expect(request).toContain(schema.properties.task.enum.map((task) => `"${task}"`).join(' | '));
    for (const mime of ['application/pdf', 'image/png', 'image/jpeg']) {
      expect(request, mime).toContain(mime);
      expect(JSON.stringify(schema.properties.source), mime).toContain(mime);
    }
    expect(request).toContain(`"language": "${schema.properties.language.default}"`);
    expect(request).toContain(`"max_pages": ${schema.properties.max_pages.default}`);
  });

  test('the response: one Response heading, which is the anchor the manifest links to', () => {
    expect(m.interface.response_schema.$ref.endsWith('/specs/document-pipeline.md#response')).toBe(true);
    expect(spec.match(/^#{1,6} Response$/gm)).toStrictEqual(['### Response']); // one heading, so the anchor is #response
    expect(spec).toContain('`schema` is `vector.document-pipeline.result.v1`');
  });

  test('the third parties of the manifest are the ones the page lists', () => {
    const table = section('Operator and data handling');
    const [host, ocr, llm, koios, indexer] = m.behaviour.third_parties;
    for (const party of [host, ocr, llm]) expect(table, party).toContain(`| ${party}`);
    expect(table).toContain('Koios');
    expect(table).toContain('marketplace indexer');
    expect(koios).toMatch(/^Koios/);
    expect(indexer).toBe('marketplace indexer');
  });

  test('the links of the manifest name the page and the folder of the service, which exist', () => {
    expect(m.links.spec).toBe('https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/document-pipeline.md');
    expect(m.links.source).toBe('https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/document-pipeline');
    expect(existsSync(new URL('../../../specs/document-pipeline.md', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../src/index.ts', import.meta.url))).toBe(true);
  });

  // The manifest states seven gaps (src/gaps.ts). The page carries every one word for word, one to a line and in the order the manifest states them, as the page of
  // agent-history carries the lines of its blind_spots, and it adds five of its own.
  test('every gap sentence of the manifest is on the page word for word, one to a line and in the manifest\'s order; the subsidy is in the Economics line of the Terms too', () => {
    expect(m.gaps).toStrictEqual([...GAPS]);
    expect(GAPS).toHaveLength(7);
    const gaps = section('Known gaps');
    const places = GAPS.map((gap) => { const at = gaps.indexOf(`\n- ${gap}\n`); expect(at, gap.slice(0, 50)).toBeGreaterThan(-1); return at; });
    expect(places).toStrictEqual([...places].sort((a, b) => a - b));
    // The Economics lines of the Terms continue after a label, so the sentence begins in lower case there.
    expect(section('Terms')).toContain(`Economics: ${SUBSIDY_GAP.replace(/^At/, 'at')}`);
  });

  // Ruling R53: the deadline gap says what the deadline does and no more. It cuts the next hire and the waits of a hire, and a hire in its Accept finishes late.
  test('the deadline gap narrows to what the code does: the next hire not started, a hire that would wait again cut, a hire in its Accept finishing late (ruling R53)', () => {
    expect(DEADLINE_GAP).toBe(`A job has a deadline of its own, ${JOB_DEADLINE_MS} ms after its request arrives: a page is not started with less than ${PAGE_MIN_LEFT_MS / 1000} s left, `
      + `nor the summary or extraction with less than ${LLM_MIN_LEFT_MS / 1000} s. A job that cannot start its next hire in time, or whose hire would have to wait again on its `
      + 'supplier or on the ledger after the deadline, fails with the code deadline and returns no bundle, and the sub-jobs it had already paid for are not refunded. '
      + 'A hire in its Accept at the deadline is not cut: it finishes late, and the chat job may then answer after the runtime has given up on the job.');
    expect(section('Known gaps')).not.toContain('A job that cannot finish in time');
  });

  test('the page adds five gaps of its own: the exit between signing a Post and its confirmation, the budget of the runtime, the token of the runtime, the 102 Processing line, the English instructions', () => {
    const gaps = section('Known gaps');
    const own = [
      '- A process exit between signing a Post and its confirmation leaves a sub-escrow that is in no record, so the janitor never sees it. It can be reclaimed by hand after its `deliver_by`, and it holds the lock of one sub-job.',
      "- The runtime's budget for a job is the smaller of `SERVICE_TIMEOUT_MS` and `deliver_by` less the start time less 30 s, and the wire carries no budget, so the service cannot see it. A job that the runtime claims late can be abandoned by the runtime while the service goes on hiring and paying until its own deadline. The hirer then reclaims after `deliver_by`.",
      "- The service answers `POST /` only when the call carries the token the runtime sends as its `authorization` header. A `POST /` without it gets 401 `unauthorized`, with no detail, before its body is read, so that nothing else on the host's network can make the service spend. `GET /healthz` and `GET /agent.json` need no header, and neither does a `HEAD` of either; any other route gets 404.",
      "- While a job runs the service writes an interim `102 Processing` line every 60 s, ahead of the answer, because the runtime's fetch gives up on a response that has not begun after 300 s of silence and a job takes up to 27 minutes. The answer is the same 200 with the same body.",
      '- The instructions the chat supplier gets are in English and name the requested language by its code. There is no translation table, so whether the answer is in that language is up to the model.',
    ];
    for (const line of own) expect(gaps, line.slice(0, 50)).toContain(`\n${line}\n`);
    expect(gaps.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(GAPS.length + own.length);
    expect(gaps.indexOf(`\n- ${GAPS[GAPS.length - 1]}\n`)).toBeLessThan(gaps.indexOf(`\n${own[0]}\n`));
    // The numbers they state are the code's: a line every minute, an answer inside 27 minutes (the job deadline, 1620000 ms).
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(JOB_DEADLINE_MS / 60_000).toBe(27);
  });

  test('the response example is the golden result of the two-page summary run, field for field and in the order the service writes it, with the note that says whose values they are', () => {
    const response = sub('Response');
    const block = response.split('```json\n')[1].split('\n```')[0];
    expect(JSON.parse(block)).toStrictEqual(JSON.parse(JSON.stringify(GOLDEN)));
    expect(JSON.stringify(JSON.parse(block))).toBe(JSON.stringify(GOLDEN)); // the same keys in the same order, as the service writes them
    expect(response).toContain('Example, the result of the two-page summary run of the test suite:');
    expect(response).toContain("The example is from the stub marketplace of the test suite; hashes, references and signatures are the harness's, the shape and field names are the contract. The amounts in `accounting` are those of the test suite's fake chain.");
    expect(block).not.toMatch(/<[a-z0-9 ]+>/); // no placeholder is left of the illustration the page had before the build
    expect(GOLDEN.accounting.sub_jobs).toBe(GOLDEN.pages.length + 1);
    // The table names the fields of the result, and the shape names the three forms of `result`.
    for (const field of ['source', 'pages[]', 'sub_job', 'result', 'llm_sub_job', 'accounting']) expect(response, field).toContain(`| \`${field}\` |`);
    expect(response).toContain('"result": { "summary": "..." } | { "extraction": { ... }, "schema_valid": true }');
    expect(response).toContain('| { "extraction": null, "schema_valid": false, "raw_text": "..." },');
  });

  test('the shape rules of the request are the intake\'s: three forms of source, 600000 raw bytes of padded base64, schema only with extract, the language rule and max_pages from 1 to 5', () => {
    const request = sub('Request');
    const rows = Object.fromEntries(request.split('\n').filter((l) => /^\| .+ \| .+ \|$/.test(l) && !l.startsWith('| Field |')).map((l) => [l.split('|')[1].trim(), l.split('|')[2].trim()]));
    expect(Object.keys(rows)).toStrictEqual(['`source`, required', '`source` by URL', '`source` inline', 'Inline base64', '`task`, required', '`schema`', '`language`', '`max_pages`']);
    expect(rows['`source`, required']).toBe('Exactly one of three forms, with no other key in it.');
    expect(rows['`source` by URL']).toBe('`{ "url": "<https URL>" }`. The service fetches the document.');
    expect(rows['`source` inline']).toBe('`{ "pdf_b64": "<base64>", "mime": "application/pdf" }`, or `{ "image_b64": "<base64>", "mime": "image/png" }` with `image/jpeg` for a JPEG. The document travels in the request.');
    expect(rows['Inline base64']).toBe(`Standard base64, padded, with no whitespace or line breaks. At most ${MAX_INLINE_BYTES} bytes of raw media. A larger document goes by URL.`);
    expect(rows['`task`, required']).toBe('`summary` or `extract`');
    expect(rows['`schema`']).toContain('Required with `task` `extract` and refused with `task` `summary`.');
    const language = m.interface.request_schema.properties.language;
    expect(rows['`language`']).toContain(`Default \`${DEFAULT_LANGUAGE}\`. 2 to ${language.maxLength} characters: a language code of 2 to 8 letters, then any number of hyphen-separated subtags of 1 to 8 letters or digits`);
    expect(rows['`max_pages`']).toContain(`A whole number from 1 to ${MAX_PAGES}, default ${MAX_PAGES}.`);
    // Only the shape rules are said to run before anything is fetched. The rules for the document run once it is loaded, still before an escrow is posted.
    expect(request).toContain('The shape of a request is checked first. A request that breaks a shape rule is refused before anything is fetched or posted, so it spends nothing.');
    expect(request).not.toContain('A request that breaks one is refused before anything is fetched or posted');
    const loaded = request.split('Then the document is loaded, fetched or decoded, and checked. That is still before any escrow is posted, so a refusal here spends nothing either:\n')[1] ?? '';
    expect(loaded.split('\n').filter((l) => l.startsWith('- '))).toStrictEqual([
      `- A document that cannot be fetched is refused (\`source_fetch_failed\`), and so is a fetched one over ${m.terms.input_limits.source_bytes / (1024 * 1024)} MB (\`source_too_large\`).`,
      '- Once the document is loaded, its type is read from its first bytes. A type that is not PDF, PNG or JPEG is refused (`source_unsupported`), and so is a type that differs from the one the request declared or the server served (`source_mime_mismatch`).',
      `- A PDF is rendered to PNG pages. One that cannot be rendered, because it is locked, damaged or has no pages, is refused (\`unreadable_source\`). A page that would be over ${MAX_PAGE_PIXELS} pixels at 150 dpi is refused before it is rendered, and so is a page image over ${OCR_IMAGE_B64_MAX} base64 characters (both \`page_too_large\`).`,
    ]);
    // The intake takes the examples of the language rule and its bound of 16 characters, and refuses what the rule leaves out.
    const asked = (extra: Record<string, unknown>): string => JSON.stringify({ source: { url: 'https://example.org/letter.pdf' }, task: 'summary', ...extra });
    for (const code of ['en', 'en-GB', 'zh-Hant-TW', 'es-419', 'en-abcdefgh-abcd']) expect(parseRequest(asked({ language: code })).language, code).toBe(code);
    for (const code of ['e', '1en', 'en_GB', 'en-', 'abcdefghi', 'en-abcdefgh-abcde']) expect(() => parseRequest(asked({ language: code })), code).toThrow();
    expect(() => parseRequest(asked({ schema: { type: 'object' } }))).toThrow(/only accepted with task "extract"/);
    expect(() => parseRequest(asked({ task: 'extract' }))).toThrow(/needs a schema/);
    for (const pages of [0, MAX_PAGES + 1]) expect(() => parseRequest(asked({ max_pages: pages })), String(pages)).toThrow(/from 1 to 5/);
  });

  test('the intake reads the shape and not the bytes: a request whose document is no document passes it, and the type rules refuse it once the document is loaded (422, src/source.ts)', async () => {
    const inline = (bytes: Uint8Array, mime: string): string => JSON.stringify({ source: { pdf_b64: toBase64(bytes), mime }, task: 'summary' });
    const notADocument = parseRequest(inline(text('plain text, not a document'), 'application/pdf'));
    await expect(loadSource(notADocument, { fetchImpl: fetch })).rejects.toMatchObject({ name: 'RequestError', code: 'source_unsupported', status: 422 });
    const pngAsPdf = parseRequest(inline(PAGE_0_PNG, 'application/pdf'));
    await expect(loadSource(pngAsPdf, { fetchImpl: fetch })).rejects.toMatchObject({ name: 'RequestError', code: 'source_mime_mismatch', status: 422 });
  });

  // The rules for the extraction schema (rulings R36, R42, R43) are the manifest's notes and the code's: what the page lists as refused is refused, and the bounds are the constants.
  test('the extraction schema rules on the page are the code\'s: each listed keyword, the root $async and an own __proto__ are refused with schema_invalid (400), and the bounds are the constants', () => {
    const rules = sub('The extraction schema');
    const refusal = (schema: Record<string, unknown>): PipelineError | undefined => {
      try { compileExtractionSchema(schema); } catch (err) { return err instanceof PipelineError ? err : undefined; }
      return undefined;
    };
    const samples: Record<string, unknown> = { $ref: '#', $dynamicRef: '#x', $recursiveRef: '#', $id: 'x', $defs: {}, definitions: {}, pattern: 'a', patternProperties: {}, format: 'date' };
    const refusedLine = rules.split('\n').find((l) => l.startsWith('- Refused anywhere in the schema:')) ?? '';
    for (const [keyword, value] of Object.entries(samples)) {
      expect(refusedLine, keyword).toContain(tick(keyword));
      expect(refusal({ type: 'object', [keyword]: value }), keyword).toMatchObject({ code: 'schema_invalid', status: 400 });
    }
    expect(refusedLine.split('. ')[0].match(/`[^`]+`/g)).toHaveLength(Object.keys(samples).length); // the list is these nine words and no keyword that the code takes
    expect(refusal({ $async: true, type: 'object' })).toMatchObject({ code: 'schema_invalid', status: 400 });
    expect(refusal(JSON.parse('{"type":"object","default":{"__proto__":1}}'))).toMatchObject({ code: 'schema_invalid', status: 400 });
    // A name is not a keyword: the page says so, and the code takes such a schema.
    expect(() => compileExtractionSchema({ type: 'object', properties: { format: { type: 'string' }, pattern: { type: 'string' } }, default: { format: 'A4' } })).not.toThrow();
    expect(rules).toContain(`- At most ${SCHEMA_MAX_BYTES} bytes of JSON (the schema as parsed, written out again) and ${SCHEMA_MAX_DEPTH} levels of nesting, data included. At most ${COMBINATION_MAX_ENTRIES} entries in each \`anyOf\`, \`oneOf\` and \`allOf\`.`);
    // The manifest says the same in its notes: the list, the bounds, the code.
    const notes = m.interface.notes.join(' ');
    for (const keyword of Object.keys(samples)) expect(notes, keyword).toContain(keyword);
    expect(notes).toContain(`${SCHEMA_MAX_BYTES} bytes of JSON and ${SCHEMA_MAX_DEPTH} levels deep, and each of its anyOf, oneOf and allOf has at most ${COMBINATION_MAX_ENTRIES} entries`);
    expect(notes).toContain('declare $async at the root');
    expect(notes).toContain('schema_invalid (400)');
    expect(rules).toContain('refused with `schema_invalid` (400)');
  });

  test('the Errors table gives the codes of the README table under the same statuses, and says what a refusal and a failure on the service\'s side look like', () => {
    const pairs = (table: string): string[] => table.split('\n').filter((l) => /^\| \d{3}, /.test(l)).flatMap((l) => {
      const [, label, codes] = l.split('|');
      return [...codes.matchAll(/`([^`]+)`/g)].map((c) => `${label.trim().slice(0, 3)} ${c[1]}`);
    }).sort();
    const errors = sub('Errors');
    const readmeErrors = (readme.split('\n## Errors\n')[1] ?? '').split('\n## ')[0];
    expect(pairs(readmeErrors).length).toBeGreaterThan(30);
    expect(pairs(errors)).toStrictEqual(pairs(readmeErrors));
    for (const must of ['400 schema_invalid', '401 unauthorized', '422 source_fetch_failed', '422 unreadable_source', '422 llm_incomplete', '503 insufficient_float', '503 ocr_supplier_unavailable', '503 llm_supplier_unavailable', '500 store_write_failed']) expect(pairs(errors), must).toContain(must);
    const lead = errors.split('\n| Status | Codes |\n')[0];
    expect(lead).toContain('A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.');
    expect(lead.split('\n').filter((l) => l.startsWith('- '))).toStrictEqual([
      '- The 401 and `internal` have the code and no message.',
      '- The runtime fails the job on any non-2xx answer and copies the first 200 characters of the failure to the buyer. The buyer reclaims after `deliver_by`.',
      "- `store_write_failed`, `insufficient_float`, `ocr_supplier_unavailable` and `llm_supplier_unavailable` are failures on the service's side. Their message is fixed: `The service could not do this job (<code>). The operator's log has the detail.` A path, an escrow or the text of a provider is the operator's.",
      '- `shutting_down` says that the service is stopping.',
      '- One job runs at a time. A second request while one runs gets 409 `{"error":"busy"}`, and nothing is started.',
      '- `GET /healthz` and `GET /agent.json` are matched on their path, whatever the query string, and a `HEAD` of either gets the headers of the `GET` and no body. Any other route gets 404 `{"error":"not_found"}`, a `POST /` with a query string among them.',
    ]);
    // The failures on the service's side are the 500 and 503 rows but for internal and shutting_down, which have their own words.
    const serviceSide = pairs(errors).filter((p) => /^(500|503) /.test(p)).map((p) => p.split(' ')[1]).filter((code) => code !== 'internal' && code !== 'shutting_down').sort();
    expect(serviceSide).toStrictEqual(['insufficient_float', 'llm_supplier_unavailable', 'ocr_supplier_unavailable', 'store_write_failed']);
    expect(errors).toContain('A 400, a 401, a 422 for the document and a 503 are given before the first escrow is posted, so they spend nothing. The exception is `llm_supplier_unavailable` when the chat supplier is chosen again after the pages were paid.');
    expect(readme).toContain("The service could not do this job (<code>). The operator's log has the detail.");
    expect(readme).toContain('A 400, a 401, a 422 for the document and a 503 are all given before the first escrow is posted, so they spend nothing; the one exception is `llm_supplier_unavailable`');
    expect(MAX_BODY).toBe(1_000_000);
    expect(errors).toContain('`request_too_large` (over 1000000 bytes)');
  });

  test('How it buys states the code\'s own numbers and names: the OCR supplier key, the allowlist in order, the budgets, the seven checks, the janitor, and the endpoints of the fleet', () => {
    const buys = sub('How it buys');
    expect(buys.length).toBeGreaterThan(5000);
    expect(buys).toContain(`By default that is the Active advert for \`ocr.page.extract.chandra-ocr-2.v1\` of the supplier key hash \`${OCR_SUPPLIER_PKH_DEFAULT}\` (the operator's \`OCR_ALLOWLIST_SUPPLIER_PKH\` sets it). The service resolves it from the marketplace indexer at run time, whatever the indexer says of its supplier at the moment,`);
    // Ruling R60: the indexer's word for a supplier at the moment does not rule an advert out, and a chat supplier at work is hired and waited for.
    expect(buys).toContain('The candidates are the Active adverts whose model is on the allowlist, whatever the indexer says of their supplier at the moment.');
    expect(buys).toContain(`and a \`/status\` that says \`free\`, \`working\` or \`offline\`. The first that passes is hired, and its advert is read again on the ledger. A supplier that is not free is hired all the same: the send is made again every ${BUSY_RETRY_MS / 1000} s while it answers that it is busy, until ${SEND_CUTOFF_MS / 1000} s before the \`deliver_by\` of the escrow, and only then does the hop fail with \`llm_busy\`.`);
    expect(buys).not.toContain('says `free`.');
    const models = `${LLM_MODELS_DEFAULT.slice(0, -1).map(tick).join(', ')} and ${tick(LLM_MODELS_DEFAULT[LLM_MODELS_DEFAULT.length - 1])}`;
    expect(buys).toContain(`The allowlist holds, by default and in this order of preference, ${models} (\`LLM_MODEL_ALLOWLIST\` sets it).`);
    for (const name of ['OCR_ALLOWLIST_SUPPLIER_PKH', 'LLM_MODEL_ALLOWLIST']) expect(readme, name).toContain(`| \`${name}\` |`);
    expect(buys).toContain(`if the first choice is more than ${LLM_SELECTION_MAX_AGE_MS / 60_000} minutes old`);
    // The Pipeline uses selectLlmSupplier as it stands, so it asks the first six within 120 s: the defaults of buyer-core.
    const count = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][LLM_SELECTION_MAX_CANDIDATES];
    expect(buys).toContain(`The first ${count} are asked in turn, within ${LLM_SELECTION_BUDGET_MS / 1000} s.`);
    // Time: the bullets, with the numbers of the code and, for the waits that no constant holds, the words of the head of src/budget.ts.
    const head = readFileSync(new URL('../src/budget.ts', import.meta.url), 'utf8').split('\nimport ')[0].replace(/\n\/\/ ?/g, ' ');
    const [page, chat] = (/\((\d+) s for a page, (\d+) s for the chat job\)/.exec(head) ?? []).slice(1).map(Number);
    for (const part of [
      "its Post confirmed (up to 180 s, the chain's own wait)", "the supplier's Claim (up to 60 s", 'the work (up to 240 s for an OCR page, 180 s for the chat job)', "the supplier's Submit (about 30 s)",
      'the hash of the receipt showing on chain (up to 120 s)', 'and the Accept confirmed (up to 180 s)',
    ]) expect(head, part).toContain(part);
    expect([page, chat]).toStrictEqual([810, 750]);
    const time = (buys.split('\n**Time.**\n')[1] ?? '').split('\n\n**')[0].split('\n').filter((l) => l.startsWith('- '));
    expect(time).toStrictEqual([
      `- A job has a deadline of its own, ${JOB_DEADLINE_MS} ms after its request arrives.`,
      `- No page is started with less than ${PAGE_MIN_LEFT_MS / 1000} s left before the deadline, and the chat hop is not started with less than ${LLM_MIN_LEFT_MS / 1000} s left.`,
      `- One hire waits for its Post to confirm (up to ${DELIVER_BY_BUFFER_MS / 1000} s), the supplier's Claim (up to 60 s), the work (up to 240 s for a page and 180 s for the chat job), the supplier's Submit (about 30 s), the hash of the receipt on the ledger (up to ${RECEIPT_HASH_WAIT_MS / 1000} s) and its own Accept to confirm (up to ${DELIVER_BY_BUFFER_MS / 1000} s). That is ${page} s for a page and ${chat} s for the chat job in the worst case.`,
      '- The minimums are below those worst cases: they are a typical hire plus a margin.',
      '- The deadline cuts what the service waits for on its own: the repeats of a send, the polls, the repeats of a read of the receipt hash, and the pauses between them. Past the deadline none of them starts again.',
      '- A hire that the deadline cuts fails the job with `deadline`, after payment. The sub-jobs it had already paid for are not refunded, and the escrow of the hire in progress goes to the janitor.',
      `- The deadline does not cut the confirmation of a Post or of an Accept. The chain waits for each of them, up to ${DELIVER_BY_BUFFER_MS / 1000} s, whatever the time.`,
      '- A hire that is in its Accept when the deadline passes runs on, its retries included: the Accept completes, is left `accept_pending`, or fails with `accept_failed` once its retries are over. A page is then followed by `deadline` at the next hop. The chat job still returns its result, which can come after the runtime has given up on the job, 60 s after the deadline at the latest.',
    ]);
    // Ruling R54: the Accept is made again, every 15 s, until the window closes or 600 s after the answer of the supplier.
    expect(buys).toContain('An Accept that fails in a way that cannot land, a build that did not complete or a submit that was refused, is made again every 15 s, until the accept window has closed or 600 s have passed since the supplier\'s answer. Only then does the hop fail with `accept_failed`.');
    expect(POLL_INTERVAL_MS / 1000).toBe(3);
    // Before anything is posted.
    // Ruling R66: the size of each page is checked before it is rendered.
    expect(buys).toContain(`a PDF is rendered to PNG pages at 150 dpi, once the size of each page is known: a page that would be over ${MAX_PAGE_PIXELS} pixels is refused with \`page_too_large\` before it is rendered, and so is a page image over ${OCR_IMAGE_B64_MAX} base64 characters.`);
    expect(buys).toContain('a pure output of at least 5000000 lovelace as collateral and a float outside it of `(max_pages + 1) x 4500000` lovelace');
    // The seven checks, in the order of the verification object.
    const checks = Object.keys(GOLDEN.llm_sub_job.verification);
    expect(checks).toHaveLength(7);
    const rows = buys.split('\n').filter((l) => l.startsWith('| `')).map((l) => l.split('`')[1]);
    expect(rows).toStrictEqual(checks);
    expect(buys).toContain('The seven checks of a sub-receipt, in the order of the `verification` object. The Pipeline accepts an escrow only when all seven pass:');
    expect(buys).toContain(`reads it again every ${POLL_INTERVAL_MS / 1000} s, for up to ${RECEIPT_HASH_WAIT_MS / 1000} s`);
    // The janitor: a minute between passes, 5 s after deliver_by, the 600 s window of the escrow, the file in the state directory.
    expect(JANITOR_INTERVAL_MS).toBe(60_000);
    expect(buys).toContain('A janitor looks at the record every minute. From 5 s after an escrow\'s `deliver_by`');
    expect(buys).toContain('An entry is dropped once its Reclaim is confirmed, or once the output reads spent, or unknown, on two passes in a row.');
    expect(JANITOR_GRACE_MS).toBe(5_000);
    expect(buys).toContain(`\`${STRANDED_FILE}\``);
    expect(buys).toContain('once the 600 s accept window after its Submit has passed');
    // The fleet: the endpoints, the header, the body of the chat job, the input of the chat job.
    const clients = readFileSync(new URL('../../../packages/buyer-core/src/fleet-clients.ts', import.meta.url), 'utf8');
    for (const part of ['POST /v1/ocr/extract', 'POST /v1/responses', 'X-Escrow-Ref']) {
      expect(clients, part).toContain(part);
      expect(buys, part).toContain(part);
    }
    expect(buys).toContain('the body `{ "input": "<text>" }` and nothing else');
    const input = llmInput({ task: 'extract', language: 'en', schema: { type: 'object' }, pages: [{ index: 0, text: 'T' }] });
    expect(input).toContain('JSON Schema:\n{"type":"object"}');
    expect(input).toContain('=== page 1 ===\nT');
    expect(input).toContain('the language whose code is "en"');
    expect(buys).toContain('a line `JSON Schema:` and the schema as compact JSON; then the text of each page after a line `=== page N ===`, N counting from 1.');
    expect(DELIVER_BY_BUFFER_MS).toBe(180_000);
  });

  test('Operator and data handling says what the manifest says the service holds and writes, and what the ledger carries', () => {
    const handling = section('Operator and data handling');
    const [held, , kept] = m.behaviour.data_handling.split(/(?<=\.) (?=[A-Z])/);
    expect(held).toContain('private temporary directory');
    expect(kept).toContain('state directory');
    expect(handling).toContain(held);
    expect(handling).toContain(kept);
    expect(handling.toLowerCase()).toContain('on the ledger the sub-escrows carry hashes, not the document or its text');
    expect(handling).toContain('| the page texts, the task and, for an extraction, the schema |'); // the manifest: "the page texts, the task and any schema to the LLM supplier"
    expect(m.behaviour.data_handling).toContain('the page texts, the task and any schema to the LLM supplier');
    expect(handling).toContain('The service holds the buyer key (a separate key from the supplier key) and no other.');
  });

  // The request JSON is written in four places besides the page's Example (the page's How to hire it, the guide, the E2E runbook, the runbook of the Pipeline), and each is a request the intake accepts.
  test('the request JSON of the page, the guide, the E2E runbook and the runbook of the Pipeline is a request the intake accepts, for one page of a document by URL', () => {
    const found: Record<string, string> = {
      'the Example of the page': /```json\n([\s\S]*?)\n```/.exec(sub('Request'))?.[1] ?? '',
      'How to hire it': /for example, `(\{[^`]+\})`\./.exec(section('How to hire it'))?.[1] ?? '',
      'the guide, section 5': /```json\n([\s\S]*?)\n```/.exec((textOf(hire, '5. The chat script').split('\n### The same script for Document Pipeline\n')[1] ?? ''))?.[1] ?? '',
      'the E2E runbook': /^export PAYLOAD='(.*)'$/m.exec(textOf(e2e, 'Hiring Document Pipeline'))?.[1] ?? '',
      'the runbook of the Pipeline, step 15': /`PAYLOAD` is the request JSON for one page of a public PDF: `(\{[^`]+\})`/.exec(textOf(runbook, '15. The first-party run'))?.[1] ?? '',
    };
    for (const [where, json] of Object.entries(found)) {
      expect(json, where).not.toBe('');
      const request = parseRequest(json.replace('<https URL of a one-page public PDF>', 'https://example.org/letter.pdf'));
      expect(request, where).toStrictEqual({ source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
    }
  });

  test('the guide and the E2E runbook give the time to reclaim as the 30 min window of the advert plus the 180 s of every deliver_by, and the E2E runbook the 33 minutes the script polls', () => {
    expect(m.terms.max_processing_ms / 60_000).toBe(30);
    expect(DELIVER_BY_BUFFER_MS / 1000).toBe(180);
    expect(hire).toContain('If the job fails, you reclaim after `deliver_by`, which is your Post time plus 30 min plus 180 s.');
    expect(textOf(e2e, 'Hiring Document Pipeline')).toContain('which is 33 minutes after the Post (the 30 min window and 180 s)');
    expect((m.terms.max_processing_ms + DELIVER_BY_BUFFER_MS) / 60_000).toBe(33);
  });
});
