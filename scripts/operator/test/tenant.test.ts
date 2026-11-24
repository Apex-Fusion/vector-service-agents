// The task tenant, run through the real runner over a fake of the mock service (a fake `fetch`, no network) and a temporary env file of the mock. The tests look for the operator token in every argument
// that the fake recorded, in every line of output, and in every file of the state folder: it stands in the header `authorization` of the one call that makes a tenant, and nowhere else.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import type { UseCase } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { loadTask } from '../lib/load.ts';
import { MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import task from '../tasks/tenant.ts';
import BIDS from '../usecases/bid-evaluation.ts';
import USE from '../usecases/inventory-reorder.ts';
import PRIORAUTH from '../usecases/prior-authorization.ts';
import { NOW, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const TOKEN = hashOf('operator token').slice(0, 48);
const CLEAN_NAME = 'reorder-clean-20261115';
const FAILURE_NAME = 'reorder-failure-20261115';
const SUPPLIER = 'alfa.vector.apexfusion.org';
const INSURER = 'delta.vector.apexfusion.org';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Call { readonly url: string; readonly init: RequestInit }

const answer = (status: number, body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake of the mock service: it makes a tenant for the right token (201 for a new tenant and 200 for one that exists), refuses another token, and answers a read of the state and the log. */
class FakeMock {
  readonly calls: Call[] = [];
  readonly tenants = new Set<string>();
  /** What the state and the log of a tenant hold. */
  poOrders = 2;
  supplierOrders = 1;
  logLines = 5;
  dropped = 0;
  /** An answer that replaces the fake: a test sets it for one failure. */
  override: ((call: Call) => Response) | null = null;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} };
    this.calls.push(call);
    return this.override === null ? this.serve(call) : this.override(call);
  };

  private serve(call: Call): Response {
    const url = new URL(call.url);
    const headers = new Headers(call.init.headers);
    if (call.init.method === 'POST' && url.pathname === '/admin/tenants') {
      if (headers.get('authorization') !== `Bearer ${TOKEN}`) return answer(401, { error: 'operator_token_invalid', message: 'the operator token is missing or wrong' });
      const body: { tenant: string; organisations: unknown; seed?: { vendors: unknown[] } } = JSON.parse(String(call.init.body));
      const created = !this.tenants.has(body.tenant);
      this.tenants.add(body.tenant);
      return answer(created ? 201 : 200, { tenant: body.tenant, created, organisations: body.organisations, base: `${MOCK_PUBLIC_BASE}/t/${body.tenant}`, counts: { erp: 3, vendors: body.seed?.vendors.length ?? 3 } });
    }
    const read = /^\/t\/([a-z0-9-]+)\/(state|log)$/.exec(url.pathname);
    if (call.init.method === 'GET' && read !== null && this.tenants.has(read[1]!)) {
      return read[2] === 'state'
        ? answer(200, { tenant: read[1], po_store: { orders: new Array(this.poOrders).fill({}) }, supplier: { catalogue: [], orders: new Array(this.supplierOrders).fill({}) } })
        : answer(200, { tenant: read[1], dropped: this.dropped, lines: new Array(this.logLines).fill({}) });
    }
    return answer(404, { error: 'tenant_not_found', message: 'the tenant does not exist' });
  }
}

interface TenantWorld { readonly w: TaskWorld; readonly mock: FakeMock; readonly envFile: string }

interface WorldOptions { readonly mock?: FakeMock; readonly env?: Record<string, string | undefined>; readonly file?: string | null; readonly use?: UseCase }

/** A world with the fake mock and an env file of the mock (`file` is its text, null for no file). */
async function tenantWorld(options: WorldOptions = {}): Promise<TenantWorld> {
  const mock = options.mock ?? new FakeMock();
  const dir = mkdtempSync(join(tmpdir(), 'operator-mock-'));
  roots.push(dir);
  const envFile = join(dir, '.env.mock-systems');
  if (options.file !== null) writeFileSync(envFile, options.file ?? `MOCK_PUBLIC_BASE=${MOCK_PUBLIC_BASE}\nMOCK_OPERATOR_TOKEN=${TOKEN}\nPORT=9120\n`, { mode: 0o600 });
  const use = options.use ?? USE;
  const w = await taskWorld({ use, fetchImpl: mock.fetch, env: { OPERATOR_USE_CASE: USE.name, OPERATOR_MOCK_ENV_FILE: envFile, ...options.env } });
  return { w, mock, envFile };
}

const submit = (t: TenantWorld, ...argv: string[]): Promise<number> => t.w.run(task, '--submit', ...argv);
const facts = (w: TaskWorld) => FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: w.use.name, network: 'vector-mainnet' }).read();
const body = (call: Call): Record<string, unknown> => JSON.parse(String(call.init.body));

/** Everything that the fake recorded, as text, without the one header that carries the token. */
function recorded(mock: FakeMock): string {
  return mock.calls.map((call) => JSON.stringify({ url: call.url, method: call.init.method, body: call.init.body ?? null, headers: [...new Headers(call.init.headers)].filter(([name]) => name !== 'authorization') })).join('\n');
}

describe('the call that makes a tenant', () => {
  it('sends the body and the headers of a good call, says that the tenant is new, and writes the fact', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(t.mock.calls).toHaveLength(1);
    const call = t.mock.calls[0]!;
    expect(call.url).toBe(`${MOCK_PUBLIC_BASE}/admin/tenants`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    const headers = new Headers(call.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(body(call)).toEqual({ tenant: CLEAN_NAME, organisations: { supplier: SUPPLIER, insurer: INSURER } });
    expect(Object.keys(body(call))).not.toContain('seed');
    expect(t.w.screen.lines).toContain(`the tenant ${CLEAN_NAME} is new: the mock service made it from the default seed (the run reads GLV-NIT-M)`);
    expect(facts(t.w).tenants).toEqual({ r1: { name: CLEAN_NAME, createdAt: iso(NOW), seedKind: 'default' } });
    expect(t.w.machine()).toMatchObject({ task: 'tenant', mode: 'submit', outcome: 'done', exit: 0, result: { tenant: CLEAN_NAME, created: true } });
    expect(t.w.node.networkReads).toBe(0);
  });

  it('takes the name from the kind of the run and the date, from --name, or from --name when both are given, and never from the label of the run', async () => {
    const failure = await tenantWorld();
    expect(await submit(failure, '--run', 'r2', '--kind', 'failure')).toBe(0);
    expect(body(failure.mock.calls[0]!).tenant).toBe(FAILURE_NAME);
    expect(failure.w.screen.lines).toContain(`the tenant ${FAILURE_NAME} is new: the mock service made it from the default seed (the run reads MSK-N95)`);
    const labelled = await tenantWorld();
    expect(await submit(labelled, '--run', 'trial', '--kind', 'clean')).toBe(0);
    expect(body(labelled.mock.calls[0]!).tenant).toBe(CLEAN_NAME);
    const named = await tenantWorld();
    expect(await submit(named, '--run', 'r1', '--name', 'my-tenant-1')).toBe(0);
    expect(body(named.mock.calls[0]!).tenant).toBe('my-tenant-1');
    expect(named.w.screen.lines).toContain('the tenant my-tenant-1 is new: the mock service made it from the default seed');
    const both = await tenantWorld();
    expect(await submit(both, '--run', 'r1', '--name', 'my-tenant-2', '--kind', 'failure')).toBe(0);
    expect(body(both.mock.calls[0]!).tenant).toBe('my-tenant-2');
  });

  it('takes a name of 48 characters, and refuses a bad name, a bad kind, no kind and no name, and no run, before any call', async () => {
    const ok = await tenantWorld();
    expect(await submit(ok, '--run', 'r1', '--name', 'a'.repeat(48))).toBe(0);
    const table: ReadonlyArray<readonly [string, string[], string]> = [
      ['a name with an upper-case letter', ['--run', 'r1', '--name', 'Upper'], 'the name of a tenant'],
      ['a name with an underscore', ['--run', 'r1', '--name', 'bad_name'], 'the name of a tenant'],
      ['a name that starts with a hyphen', ['--run', 'r1', '--name', '-lead'], 'the name of a tenant'],
      ['a name of 49 characters', ['--run', 'r1', '--name', 'a'.repeat(49)], 'the name of a tenant'],
      ['a kind that is the label of a run', ['--run', 'r1', '--kind', 'trial'], '--kind is one of: clean, failure'],
      ['a kind that is a short label', ['--run', 'r1', '--kind', 'r1'], '--kind is one of: clean, failure'],
      ['a kind in upper case', ['--run', 'r1', '--kind', 'Clean'], '--kind is one of: clean, failure'],
      ['no kind and no name', ['--run', 'r1'], 'give --kind'],
      ['a run label that is the name of a kind', ['--run', 'clean'], 'give --kind'],
      ['a run label that is the name of the other kind', ['--run', 'failure'], 'give --kind'],
      ['no run', ['--kind', 'clean'], '--run <label> is required'],
    ];
    for (const [label, argv, words] of table) {
      const t = await tenantWorld();
      expect(await submit(t, ...argv), label).toBe(2);
      expect(t.w.screen.errorText, label).toContain(words);
      expect(t.mock.calls, label).toHaveLength(0);
      expect(facts(t.w).tenants, label).toEqual({});
    }
  });

  it('refuses a name that the facts hold for another run, and the same run again unless --reset, and resets with --reset', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    // Another run with the name of the first run: the service would reset that tenant.
    expect(await submit(t, '--run', 'r2', '--name', CLEAN_NAME)).toBe(2);
    expect(t.w.screen.errorText).toContain('for the run r1');
    // The same run again without --reset, and the same run with another name.
    t.w.screen.errors.length = 0;
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(2);
    expect(t.w.screen.errorText).toContain('Give --reset');
    t.w.screen.errors.length = 0;
    expect(await submit(t, '--run', 'r1', '--name', 'another-name', '--reset')).toBe(2);
    expect(t.w.screen.errorText).toContain(`--name ${CLEAN_NAME}`);
    expect(t.mock.calls).toHaveLength(1);
    // Another run with another name is a new tenant.
    expect(await submit(t, '--run', 'r2', '--kind', 'failure')).toBe(0);
    expect(t.mock.calls).toHaveLength(2);
    // The same run with --reset resets its tenant, and the fact takes the new time.
    t.w.clock.t += 60_000;
    t.w.screen.lines.length = 0;
    expect(await submit(t, '--run', 'r1', '--kind', 'clean', '--reset')).toBe(0);
    expect(t.mock.calls).toHaveLength(3);
    expect(t.w.screen.lines).toContain(`the tenant ${CLEAN_NAME} existed: the mock service reset it from the default seed (the run reads GLV-NIT-M), and its writes and its log are gone`);
    expect(t.w.machine().result).toEqual({ tenant: CLEAN_NAME, created: false });
    expect(facts(t.w).tenants.r1).toEqual({ name: CLEAN_NAME, createdAt: iso(NOW + 60_000), seedKind: 'default' });
    expect(facts(t.w).tenants.r2!.name).toBe(FAILURE_NAME);
  });

  it('says that a tenant existed when the service resets one that the facts do not hold, and takes --reset for a run with no tenant', async () => {
    const t = await tenantWorld();
    t.mock.tenants.add(CLEAN_NAME);
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(t.w.screen.lines.some((line) => line.startsWith(`the tenant ${CLEAN_NAME} existed: `))).toBe(true);
    expect(facts(t.w).tenants.r1!.name).toBe(CLEAN_NAME);
    const fresh = await tenantWorld();
    expect(await submit(fresh, '--run', 'r1', '--kind', 'failure', '--reset')).toBe(0);
    expect(fresh.w.screen.lines.some((line) => line.startsWith(`the tenant ${FAILURE_NAME} is new: `))).toBe(true);
  });
});

describe('the tenant data for the additional agents', () => {
  const run = ['--run', 'r1', '--name', 'test-tenant'];
  const domains = ['alfa.vector.apexfusion.org', 'bravo.vector.apexfusion.org', 'charlie.vector.apexfusion.org'];

  it('posts the insurer domain from the data and leaves out the seed for prior authorization', async () => {
    const first = await tenantWorld({ use: PRIORAUTH });
    expect(await submit(first, ...run)).toBe(0);
    expect(body(first.mock.calls[0]!)).toEqual({ tenant: 'test-tenant', organisations: { supplier: SUPPLIER, insurer: INSURER } });
    expect(facts(first.w).tenants.r1?.seedKind).toBe('default');
    const insurer = 'intake.example.org';
    const changed = await tenantWorld({ use: { ...PRIORAUTH, tenantOrganisations: { ...PRIORAUTH.tenantOrganisations, insurer } } });
    expect(await submit(changed, ...run)).toBe(0);
    expect(body(changed.mock.calls[0]!)).toMatchObject({ organisations: { insurer } });
  });

  it('keeps all three vendor rows in one tenant and replaces their organisation ids with domains', async () => {
    const t = await tenantWorld({ use: BIDS });
    expect(await submit(t, ...run)).toBe(0);
    expect(t.mock.calls).toHaveLength(1);
    const call = t.mock.calls[0]!;
    expect(body(call)).toEqual({
      tenant: 'test-tenant', organisations: { supplier: SUPPLIER, insurer: INSURER },
      seed: { vendors: BIDS.tenantSeed!.vendors.map((vendor, index) => ({ ...vendor, organisation: domains[index] })) },
    });
    expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(recorded(t.mock)).not.toContain(TOKEN);
    expect(t.w.allText()).not.toContain(TOKEN);
    expect(t.w.allText()).not.toContain('Supplier Alfa');
    expect(t.w.machine().result).toEqual({ tenant: 'test-tenant', created: true });
    expect(facts(t.w).tenants.r1).toEqual({ name: 'test-tenant', createdAt: iso(NOW), seedKind: 'custom' });
  });

  it('lists the vendor ids and domains without printing the seed or reading the token in a dry run', async () => {
    const t = await tenantWorld({ use: BIDS, file: null });
    expect(await t.w.run(task, ...run)).toBe(0);
    expect(t.mock.calls).toEqual([]);
    const screen = t.w.screen.lines.join('\n');
    BIDS.tenantSeed!.vendors.forEach((vendor, index) => {
      expect(screen).toContain(`${vendor.vendor_id}: ${domains[index]}`);
      expect(screen).not.toContain(vendor.name);
      expect(screen).not.toContain(vendor.last_audit);
    });
    expect(screen).not.toContain(TOKEN);
    expect(facts(t.w).tenants).toEqual({});
  });

  it('refuses an unknown vendor organisation before calling the mock service', async () => {
    const vendors = BIDS.tenantSeed!.vendors.map((vendor, index) => index === 2 ? { ...vendor, organisation: 'not-in-the-data' } : vendor);
    const t = await tenantWorld({ use: { ...BIDS, tenantSeed: { vendors } } });
    expect(await submit(t, ...run)).toBe(2);
    expect(t.w.screen.errorText).toContain('V-1003');
    expect(t.w.screen.errorText).toContain('not-in-the-data');
    expect(t.mock.calls).toEqual([]);
    expect(facts(t.w).tenants).toEqual({});
  });

  it.each([2, '3', null, undefined])('records no custom seed when the vendor count is %s', async (vendors) => {
    const t = await tenantWorld({ use: BIDS });
    t.mock.override = () => answer(201, { tenant: 'test-tenant', created: true, counts: { vendors }, echo: TOKEN });
    expect(await submit(t, ...run)).toBe(1);
    expect(t.w.screen.errorText).toContain('vendor count');
    expect(t.w.allText()).not.toContain(TOKEN);
    expect(facts(t.w).tenants).toEqual({});
  });

  it('does not make a tenant for the lifecycle run kind', async () => {
    const t = await tenantWorld({ use: BIDS });
    expect(await submit(t, ...run, '--kind', 'lifecycle')).toBe(2);
    expect(t.mock.calls).toEqual([]);
  });

  it.each([PRIORAUTH, BIDS])('reports state sections and the log for $title without counting purchase orders', async (use) => {
    const t = await tenantWorld({ use });
    expect(await submit(t, ...run)).toBe(0);
    t.mock.override = (call) => call.url.endsWith('/state')
      ? answer(200, { tenant: 'test-tenant', organisations: use.tenantOrganisations, insurer: { requests: [] }, sourcing: { rankings: [TOKEN] }, vendors: [] })
      : answer(200, { dropped: 3, lines: [TOKEN, TOKEN] });
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(0);
    expect(t.w.screen.lines).toContain('  state sections: insurer, sourcing, vendors');
    expect(t.w.screen.lines).toContain('  lines in the log: 2, dropped: 3');
    expect(t.w.screen.lines.join('\n')).toContain(`from the ${use.tenantSeed === null ? 'default' : 'custom'} seed`);
    expect(t.w.screen.lines.join('\n')).not.toContain('orders in the PO store');
    expect(t.w.allText()).not.toContain(TOKEN);
    for (const call of t.mock.calls.filter(({ init }) => init.method === 'GET')) expect(new Headers(call.init.headers).has('authorization')).toBe(false);
  });
});

describe('the operator token', () => {
  it('stands in the header of the one call and nowhere else: not in the url, the body, another header, a line of output, a fact, the state or the evidence', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(await submit(t, '--run', 'r1', '--kind', 'clean', '--reset')).toBe(0);
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(0);
    expect(await t.w.run(task, '--run', 'r2', '--kind', 'failure')).toBe(0);
    const carrying = t.mock.calls.filter((call) => new Headers(call.init.headers).get('authorization') === `Bearer ${TOKEN}`);
    expect(carrying).toHaveLength(2);
    expect(recorded(t.mock)).not.toContain(TOKEN);
    expect(t.w.allText()).not.toContain(TOKEN);
    expect(t.w.allText()).not.toContain(`Bearer`);
    for (const call of t.mock.calls.filter((one) => one.init.method === 'GET')) expect(new Headers(call.init.headers).has('authorization')).toBe(false);
  });

  it('is in no error: a refused token, a failure of the service, a failure of the network and an answer that holds it', async () => {
    const echo = `the token ${TOKEN} is wrong`;
    const table: ReadonlyArray<readonly [string, (call: Call) => Response, number, string]> = [
      ['a 401 that echoes the token', () => answer(401, { error: 'operator_token_invalid', message: echo }), 2, 'HTTP 401 operator_token_invalid'],
      ['a 403', () => answer(403, { error: 'forbidden' }), 2, 'HTTP 403 forbidden'],
      ['a 500 that echoes the token', () => answer(500, { error: 'internal', message: echo }), 1, 'HTTP 500 internal'],
      ['a 409', () => answer(409, { error: 'tenant_limit', message: echo }), 1, 'HTTP 409 tenant_limit'],
      ['a 502 with a text that holds the token', () => answer(502, `bad gateway ${TOKEN}`), 1, 'HTTP 502'],
      ['a code that is no code', () => answer(500, { error: `Not A Code ${TOKEN}` }), 1, 'HTTP 500'],
      ['a network failure that names the token', () => { throw Object.assign(new TypeError(`fetch failed ${TOKEN}`), { cause: { code: 'ECONNREFUSED', message: TOKEN } }); }, 1, 'ECONNREFUSED'],
      ['a network failure with no code', () => { throw new Error(`header value ${TOKEN}`); }, 1, '(ERROR)'],
    ];
    for (const [label, respond, exit, words] of table) {
      const t = await tenantWorld();
      t.mock.override = respond;
      expect(await submit(t, '--run', 'r1', '--kind', 'clean'), label).toBe(exit);
      expect(t.w.screen.errorText, label).toContain(words);
      expect(`${t.w.screen.errorText}\n${t.w.allText()}`, label).not.toContain(TOKEN);
      expect(facts(t.w).tenants, label).toEqual({});
      const failedLine = t.w.machine();
      expect(failedLine.exit, label).toBe(exit);
      expect(failedLine.outcome, label).toBe(exit === 2 ? 'stopped' : 'failed');
    }
  });

  it('does not show a token when the error field looks like a refusal code', async () => {
    const token = 't'.repeat(32);
    const t = await tenantWorld({ file: `MOCK_OPERATOR_TOKEN=${token}\n` });
    t.mock.override = () => answer(401, { error: token });
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(2);
    expect(t.w.screen.errorText).toContain('HTTP 401');
    expect(t.w.allText()).not.toContain(token);
  });

  it('refuses an answer that does not say that the tenant is made or reset, and writes no fact', async () => {
    const table: ReadonlyArray<readonly [string, Response]> = [
      ['a 201 that says created false', answer(201, { tenant: CLEAN_NAME, created: false })],
      ['a 200 that says created true', answer(200, { tenant: CLEAN_NAME, created: true })],
      ['a 201 for another tenant', answer(201, { tenant: 'another', created: true })],
      ['a 201 with a body that is no JSON', answer(201, 'created')],
      ['a 201 with no field created', answer(201, { tenant: CLEAN_NAME })],
    ];
    for (const [label, response] of table) {
      const t = await tenantWorld();
      t.mock.override = () => response.clone();
      expect(await submit(t, '--run', 'r1', '--kind', 'clean'), label).toBe(1);
      expect(t.w.screen.errorText, label).toContain('is not known');
      expect(facts(t.w).tenants, label).toEqual({});
    }
  });

  it('refuses to call when the setting, the file or the line is missing, or the token has not the form of the mock service, and never shows the token', async () => {
    const bad = 'x'.repeat(31);
    const table: ReadonlyArray<readonly [string, WorldOptions, string]> = [
      ['no setting', { env: { OPERATOR_MOCK_ENV_FILE: undefined } }, 'OPERATOR_MOCK_ENV_FILE is not set'],
      ['no file', { file: null }, 'cannot be used (the env file does not exist)'],
      ['a file that holds no token line', { file: 'PORT=9120\n' }, 'has no value in the line MOCK_OPERATOR_TOKEN'],
      ['an empty token', { file: 'MOCK_OPERATOR_TOKEN=\n' }, 'has no value in the line MOCK_OPERATOR_TOKEN'],
      ['a token of 31 characters', { file: `MOCK_OPERATOR_TOKEN=${bad}\n` }, 'does not have the form'],
      ['a token with a space', { file: `MOCK_OPERATOR_TOKEN="${TOKEN} ${TOKEN}"\n` }, 'does not have the form'],
      ['a file that is damaged', { file: 'this is no env file\n' }, 'cannot be used'],
    ];
    for (const [label, options, words] of table) {
      const t = await tenantWorld(options);
      expect(await submit(t, '--run', 'r1', '--kind', 'clean'), label).toBe(2);
      expect(t.w.screen.errorText, label).toContain(words);
      expect(t.mock.calls, label).toHaveLength(0);
      expect(`${t.w.screen.errorText}\n${t.w.allText()}`, label).not.toContain(bad);
      expect(`${t.w.screen.errorText}\n${t.w.allText()}`, label).not.toContain(TOKEN);
    }
  });
});

describe('a dry run', () => {
  it('prints the request without the token, reads no token file, and calls nothing', async () => {
    const t = await tenantWorld({ file: null });
    expect(await t.w.run(task, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(t.mock.calls).toHaveLength(0);
    expect(t.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0, result: { tenant: CLEAN_NAME } });
    const lines = t.w.screen.lines;
    expect(lines).toContain(`  POST ${MOCK_PUBLIC_BASE}/admin/tenants`);
    expect(lines).toContain(`  body ${JSON.stringify({ tenant: CLEAN_NAME, organisations: { supplier: SUPPLIER, insurer: INSURER } })}`);
    expect(lines.some((line) => line.startsWith('  header authorization: the operator token'))).toBe(true);
    expect(t.w.allText()).not.toContain('Bearer');
    expect(facts(t.w).tenants).toEqual({});
  });

  it('applies the rules of the name and of the facts, and wants the setting of the token file', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(await t.w.run(task, '--run', 'r1', '--kind', 'clean')).toBe(2);
    expect(await t.w.run(task, '--run', 'r1', '--kind', 'clean', '--reset')).toBe(0);
    expect(await t.w.run(task, '--run', 'r1')).toBe(2);
    expect(t.mock.calls).toHaveLength(1);
    const none = await tenantWorld({ env: { OPERATOR_MOCK_ENV_FILE: undefined } });
    expect(await none.w.run(task, '--run', 'r1', '--kind', 'clean')).toBe(2);
    expect(none.w.screen.errorText).toContain('OPERATOR_MOCK_ENV_FILE is not set');
  });
});

describe('the status', () => {
  it('reads the state and the log of the tenant of the run with no credential, and prints the counts', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    t.mock.calls.length = 0;
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(0);
    expect(t.mock.calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([`GET ${MOCK_PUBLIC_BASE}/t/${CLEAN_NAME}/state`, `GET ${MOCK_PUBLIC_BASE}/t/${CLEAN_NAME}/log`]);
    for (const call of t.mock.calls) expect([...new Headers(call.init.headers).keys()]).toEqual(['accept']);
    expect(t.w.screen.lines).toContain(`tenant ${CLEAN_NAME} of the run r1: made at ${iso(NOW)} from the default seed`);
    expect(t.w.screen.lines).toContain('  orders in the PO store: 2, orders at the supplier portal: 1');
    expect(t.w.screen.lines).toContain('  lines in the log: 5, dropped: 0');
    t.mock.supplierOrders = 3;
    t.mock.dropped = 7;
    t.w.screen.lines.length = 0;
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(0);
    expect(t.w.screen.lines).toContain('  orders in the PO store: 2, orders at the supplier portal: 3');
    expect(t.w.screen.lines).toContain('  lines in the log: 5, dropped: 7');
  });

  it('tells what to give when there is no run, and when the facts hold no tenant, and calls nothing then', async () => {
    const t = await tenantWorld();
    expect(await t.w.run(task, 'status')).toBe(0);
    expect(t.w.screen.lines).toContain('tenant: give --run <label> to read the tenant of a run');
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(0);
    expect(t.w.screen.lines).toContain('tenant: the facts hold no tenant for the run r1');
    expect(t.mock.calls).toHaveLength(0);
  });

  it('fails with the status and the code when the service refuses the read, and when an answer has not the documented form', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    t.mock.tenants.clear();
    expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(1);
    expect(t.w.screen.errorText).toContain('HTTP 404 tenant_not_found');
    for (const [label, state] of [['a state with no PO store', { supplier: { orders: [] } }], ['a state with orders that are no list', { po_store: { orders: 3 }, supplier: { orders: [] } }]] as const) {
      const odd = await tenantWorld();
      expect(await submit(odd, '--run', 'r1', '--kind', 'clean'), label).toBe(0);
      odd.mock.override = (call) => (call.url.endsWith('/state') ? answer(200, state) : answer(200, { dropped: 0, lines: [] }));
      expect(await odd.w.run(task, 'status', '--run', 'r1'), label).toBe(1);
      expect(odd.w.screen.errorText, label).toContain('does not have the form that the mock service documents');
    }
    const logless = await tenantWorld();
    expect(await submit(logless, '--run', 'r1', '--kind', 'clean')).toBe(0);
    logless.mock.override = (call) => (call.url.endsWith('/state') ? answer(200, { po_store: { orders: [] }, supplier: { orders: [] } }) : answer(200, { lines: [] }));
    expect(await logless.w.run(task, 'status', '--run', 'r1')).toBe(1);
  });
});

describe('the definition of the task', () => {
  it('needs no key, no chain, no hosted tool and no approval, takes --name, --kind and --reset, and has the one step create', () => {
    const flags = { has: () => false, value: () => undefined };
    expect(task.name).toBe('tenant');
    expect(task.needs.keys(USE, flags)).toEqual([]);
    expect(task.needs).toMatchObject({ chain: false, hosted: [], approval: 'never' });
    expect(task.flags).toEqual(['reset']);
    expect(task.valued).toEqual(['name', 'kind']);
    expect(task.steps(USE, flags)).toEqual(['create']);
  });

  it('loads by its name through the loader of the pack, which checks the shape of a definition', async () => {
    expect(await loadTask('tenant')).toMatchObject({ name: 'tenant', flags: ['reset'], valued: ['name', 'kind'], needs: { chain: false, approval: 'never' } });
  });

  it('has nothing to take back, and calls nothing', async () => {
    const t = await tenantWorld();
    expect(await t.w.run(task, 'cleanup')).toBe(0);
    expect(t.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
    expect(t.mock.calls).toHaveLength(0);
  });
});
