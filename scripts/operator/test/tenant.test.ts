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
interface MockOwner { readonly use_case: string; readonly run: string }

const answer = (status: number, body: unknown): Response => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const absent = (): Response => answer(404, { error: 'tenant_not_found', message: 'the tenant does not exist' });
const ownership = (use: UseCase = USE, run = 'r1', operation: 'create' | 'reset' = 'create') => ({ operation, owner: { use_case: use.name, run } });

/** The fake keeps the owner of each guarded tenant and serves public reads without a token. */
class FakeMock {
  readonly calls: Call[] = [];
  readonly tenants = new Map<string, MockOwner>();
  /** What the state and the log of a tenant hold. */
  poOrders = 2;
  supplierOrders = 1;
  logLines = 5;
  dropped = 0;
  /** An answer that replaces the fake: a test sets it for one failure. */
  override: ((call: Call) => Response | undefined) | null = null;

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(input), init: init ?? {} };
    this.calls.push(call);
    return this.override?.(call) ?? this.serve(call);
  };

  private serve(call: Call): Response {
    const url = new URL(call.url);
    const headers = new Headers(call.init.headers);
    if (call.init.method === 'POST' && url.pathname === '/admin/tenants') {
      if (headers.get('authorization') !== `Bearer ${TOKEN}`) return answer(401, { error: 'operator_token_invalid', message: 'the operator token is missing or wrong' });
      const body: { tenant: string; organisations: unknown; operation: 'create' | 'reset'; owner: MockOwner; seed?: { vendors: unknown[] } } = JSON.parse(String(call.init.body));
      const owner = this.tenants.get(body.tenant);
      const created = body.operation === 'create';
      if (created && owner !== undefined) return answer(409, { error: 'tenant_exists' });
      if (!created) {
        if (owner === undefined) return absent();
        if (owner.use_case !== body.owner.use_case || owner.run !== body.owner.run) return answer(409, { error: 'tenant_owner_mismatch' });
      }
      this.tenants.set(body.tenant, body.owner);
      return answer(created ? 201 : 200, { tenant: body.tenant, created, organisations: body.organisations, base: `${MOCK_PUBLIC_BASE}/t/${body.tenant}`, counts: { erp: 3, vendors: body.seed?.vendors.length ?? 3 } });
    }
    const read = /^\/t\/([a-z0-9-]+)\/(state|log)$/.exec(url.pathname);
    if (call.init.method === 'GET' && read !== null && this.tenants.has(read[1]!)) {
      return read[2] === 'state'
        ? answer(200, { tenant: read[1], po_store: { orders: new Array(this.poOrders).fill({}) }, supplier: { catalogue: [], orders: new Array(this.supplierOrders).fill({}) } })
        : answer(200, { tenant: read[1], dropped: this.dropped, lines: new Array(this.logLines).fill({ tenant: read[1] }) });
    }
    return absent();
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
const posts = (mock: FakeMock): Call[] => mock.calls.filter(({ init }) => init.method === 'POST');

/** Everything that the fake recorded, as text, without the one header that carries the token. */
function recorded(mock: FakeMock): string {
  return mock.calls.map((call) => JSON.stringify({ url: call.url, method: call.init.method, body: call.init.body ?? null, headers: [...new Headers(call.init.headers)].filter(([name]) => name !== 'authorization') })).join('\n');
}

describe('the call that makes a tenant', () => {
  it('sends the body and the headers of a good call, says that the tenant is new, and writes the fact', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    expect(t.mock.calls).toHaveLength(2);
    const [probe, call] = t.mock.calls as [Call, Call];
    expect(probe.url).toBe(`${MOCK_PUBLIC_BASE}/t/${CLEAN_NAME}/state`);
    expect(probe.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' });
    expect([...new Headers(probe.init.headers).keys()]).toEqual(['accept']);
    expect(call.url).toBe(`${MOCK_PUBLIC_BASE}/admin/tenants`);
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
    const headers = new Headers(call.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.get('content-type')).toBe('application/json');
    expect(body(call)).toEqual({ tenant: CLEAN_NAME, organisations: { supplier: SUPPLIER, insurer: INSURER }, ...ownership() });
    expect(Object.keys(body(call))).not.toContain('seed');
    expect(t.w.screen.lines).toContain(`the tenant ${CLEAN_NAME} is new: the mock service made it from the default seed (the run reads GLV-NIT-M)`);
    expect(facts(t.w).tenants).toEqual({ r1: { name: CLEAN_NAME, createdAt: iso(NOW), seedKind: 'default' } });
    expect(t.w.machine()).toMatchObject({ task: 'tenant', mode: 'submit', outcome: 'done', exit: 0, result: { tenant: CLEAN_NAME, created: true } });
    expect(t.w.node.networkReads).toBe(0);
  });

  it('takes the name from the kind of the run and the date, from --name, or from --name when both are given, and never from the label of the run', async () => {
    const failure = await tenantWorld();
    expect(await submit(failure, '--run', 'r2', '--kind', 'failure')).toBe(0);
    expect(body(posts(failure.mock)[0]!).tenant).toBe(FAILURE_NAME);
    expect(failure.w.screen.lines).toContain(`the tenant ${FAILURE_NAME} is new: the mock service made it from the default seed (the run reads MSK-N95)`);
    const labelled = await tenantWorld();
    expect(await submit(labelled, '--run', 'trial', '--kind', 'clean')).toBe(0);
    expect(body(posts(labelled.mock)[0]!).tenant).toBe(CLEAN_NAME);
    const named = await tenantWorld();
    expect(await submit(named, '--run', 'r1', '--name', 'my-tenant-1')).toBe(0);
    expect(body(posts(named.mock)[0]!).tenant).toBe('my-tenant-1');
    expect(named.w.screen.lines).toContain('the tenant my-tenant-1 is new: the mock service made it from the default seed');
    const both = await tenantWorld();
    expect(await submit(both, '--run', 'r1', '--name', 'my-tenant-2', '--kind', 'failure')).toBe(0);
    expect(body(posts(both.mock)[0]!).tenant).toBe('my-tenant-2');
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
    expect(t.mock.calls).toHaveLength(2);
    // Another run with another name is a new tenant.
    expect(await submit(t, '--run', 'r2', '--kind', 'failure')).toBe(0);
    expect(t.mock.calls).toHaveLength(4);
    // The same run with --reset resets its tenant, and the fact takes the new time.
    t.w.clock.t += 60_000;
    t.w.screen.lines.length = 0;
    expect(await submit(t, '--run', 'r1', '--kind', 'clean', '--reset')).toBe(0);
    expect(t.mock.calls).toHaveLength(5);
    expect(body(posts(t.mock)[2]!)).toMatchObject(ownership(USE, 'r1', 'reset'));
    expect(t.w.screen.lines).toContain(`the tenant ${CLEAN_NAME} existed: the mock service reset it from the default seed (the run reads GLV-NIT-M), and its writes and its log are gone`);
    expect(t.w.machine().result).toEqual({ tenant: CLEAN_NAME, created: false });
    expect(facts(t.w).tenants.r1).toEqual({ name: CLEAN_NAME, createdAt: iso(NOW + 60_000), seedKind: 'default' });
    expect(facts(t.w).tenants.r2!.name).toBe(FAILURE_NAME);
  });

  it.each([USE, PRIORAUTH])('does not use an occupied name without a local fact for $title', async (use) => {
    const first = await tenantWorld();
    expect(await submit(first, '--run', 'r1', '--kind', 'clean')).toBe(0);
    const second = await tenantWorld({ use, mock: first.mock });
    expect(await submit(second, '--run', 'r1', '--name', CLEAN_NAME)).toBe(2);
    expect(second.w.screen.errorText).toContain('already has a tenant');
    expect(posts(first.mock)).toHaveLength(1);
    expect(first.mock.tenants.get(CLEAN_NAME)).toEqual(ownership().owner);
    expect(facts(second.w).tenants).toEqual({});
  });

  it('requires a local fact before sending a reset', async () => {
    const fresh = await tenantWorld();
    expect(await submit(fresh, '--run', 'r1', '--kind', 'failure', '--reset')).toBe(2);
    expect(fresh.w.screen.errorText).toContain('--reset requires a local tenant fact');
    expect(fresh.mock.calls).toEqual([]);
  });

  it('cannot reset a tenant whose remote owner differs from the local fact', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    const before = facts(t.w).tenants;
    const foreign = ownership(PRIORAUTH).owner;
    t.mock.tenants.set(CLEAN_NAME, foreign);
    expect(await submit(t, '--run', 'r1', '--kind', 'clean', '--reset')).toBe(1);
    expect(t.w.screen.errorText).toContain('HTTP 409 tenant_owner_mismatch');
    expect(t.mock.tenants.get(CLEAN_NAME)).toBe(foreign);
    expect(facts(t.w).tenants).toEqual(before);
  });

  it('does not write when the preflight cannot confirm absence', async () => {
    const t = await tenantWorld();
    for (const [status, value] of [[404, { error: 'not_found' }], [404, 'not JSON'], [503, { error: TOKEN }]] as const) {
      t.mock.override = () => answer(status, value);
      expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(1);
      expect(t.w.screen.errorText).toContain(`absent (HTTP ${status})`);
      expect(t.w.allText()).not.toContain(TOKEN);
    }
    expect(posts(t.mock)).toEqual([]);
    expect(facts(t.w).tenants).toEqual({});
  });

  it('requests only a create when a tenant appears after the preflight', async () => {
    const t = await tenantWorld();
    const foreign = ownership(PRIORAUTH).owner;
    t.mock.override = ({ init }) => {
      if (init.method === 'GET') {
        t.mock.tenants.set(CLEAN_NAME, foreign);
        return absent();
      }
      return undefined;
    };
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(1);
    expect(t.w.screen.errorText).toContain('HTTP 409 tenant_exists');
    expect(posts(t.mock)).toHaveLength(1);
    expect(body(posts(t.mock)[0]!)).toMatchObject(ownership());
    expect(t.mock.tenants.get(CLEAN_NAME)).toBe(foreign);
    expect(facts(t.w).tenants).toEqual({});
  });

  it('does not fall back when an older server refuses the new fields', async () => {
    const t = await tenantWorld();
    t.mock.override = ({ init }) => init.method === 'POST' ? answer(400, { error: 'bad_request', message: 'body.operation is not a field of this object' }) : undefined;
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(1);
    expect(t.w.screen.errorText).toContain('HTTP 400 bad_request');
    expect(posts(t.mock)).toHaveLength(1);
    expect(body(posts(t.mock)[0]!)).toMatchObject(ownership());
    expect(facts(t.w).tenants).toEqual({});
  });
});

describe('the tenant data for the additional agents', () => {
  const run = ['--run', 'r1', '--name', 'test-tenant'];
  const domains = ['alfa.vector.apexfusion.org', 'bravo.vector.apexfusion.org', 'charlie.vector.apexfusion.org'];

  it('posts the insurer domain from the data and leaves out the seed for prior authorization', async () => {
    const first = await tenantWorld({ use: PRIORAUTH });
    expect(await submit(first, ...run)).toBe(0);
    expect(body(posts(first.mock)[0]!)).toEqual({ tenant: 'test-tenant', organisations: { supplier: SUPPLIER, insurer: INSURER }, ...ownership(PRIORAUTH) });
    expect(facts(first.w).tenants.r1?.seedKind).toBe('default');
    const insurer = 'intake.example.org';
    const changed = await tenantWorld({ use: { ...PRIORAUTH, tenantOrganisations: { ...PRIORAUTH.tenantOrganisations, insurer } } });
    expect(await submit(changed, ...run)).toBe(0);
    expect(body(posts(changed.mock)[0]!)).toMatchObject({ organisations: { insurer } });
  });

  it('keeps all three vendor rows in one tenant and replaces their organisation ids with domains', async () => {
    const t = await tenantWorld({ use: BIDS });
    expect(await submit(t, ...run)).toBe(0);
    expect(posts(t.mock)).toHaveLength(1);
    const call = posts(t.mock)[0]!;
    expect(body(call)).toEqual({
      tenant: 'test-tenant', organisations: { supplier: SUPPLIER, insurer: INSURER },
      ...ownership(BIDS),
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

  it('refuses two vendor organisations that resolve to the same domain before any call', async () => {
    const [first, second] = BIDS.tenantSeed!.vendors;
    expect(first!.organisation).not.toBe(second!.organisation);
    const duplicateDomain = BIDS.organisations.find((organisation) => organisation.id === first!.organisation)!.domain;
    const organisations = BIDS.organisations.map((organisation) => organisation.id === second!.organisation ? { ...organisation, domain: duplicateDomain } : organisation);
    const t = await tenantWorld({ use: { ...BIDS, organisations } });
    expect(await submit(t, ...run)).toBe(2);
    expect(t.w.screen.errorText).toContain(`more than one vendor uses the organisation domain ${duplicateDomain}`);
    expect(t.mock.calls).toEqual([]);
    expect(facts(t.w).tenants).toEqual({});
  });

  it.each([2, '3', null, undefined])('records no custom seed when the vendor count is %s', async (vendors) => {
    const t = await tenantWorld({ use: BIDS });
    t.mock.override = ({ init }) => init.method === 'POST' ? answer(201, { tenant: 'test-tenant', created: true, counts: { vendors }, echo: TOKEN }) : undefined;
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
      : answer(200, { tenant: 'test-tenant', dropped: 3, lines: Array.from({ length: 2 }, () => ({ tenant: 'test-tenant', echo: TOKEN })) });
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
      t.mock.override = (call) => call.init.method === 'POST' ? respond(call) : undefined;
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
    t.mock.override = ({ init }) => init.method === 'POST' ? answer(401, { error: token }) : undefined;
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(2);
    expect(t.w.screen.errorText).toContain('HTTP 401');
    expect(t.w.allText()).not.toContain(token);
  });

  it('refuses an answer that does not say that the tenant is made or reset, and writes no fact', async () => {
    const table: ReadonlyArray<readonly [string, Response]> = [
      ['a 201 that says created false', answer(201, { tenant: CLEAN_NAME, created: false })],
      ['a 200 that says created true', answer(200, { tenant: CLEAN_NAME, created: true })],
      ['a 200 that confirms a reset instead of a create', answer(200, { tenant: CLEAN_NAME, created: false })],
      ['a 201 for another tenant', answer(201, { tenant: 'another', created: true })],
      ['a 201 with a body that is no JSON', answer(201, 'created')],
      ['a 201 with no field created', answer(201, { tenant: CLEAN_NAME })],
    ];
    for (const [label, response] of table) {
      const t = await tenantWorld();
      t.mock.override = ({ init }) => init.method === 'POST' ? response.clone() : undefined;
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
    expect(lines).toContain(`  GET ${MOCK_PUBLIC_BASE}/t/${CLEAN_NAME}/state must first confirm that the name is unused`);
    expect(lines).toContain(`  POST ${MOCK_PUBLIC_BASE}/admin/tenants`);
    expect(lines).toContain(`  body ${JSON.stringify({ tenant: CLEAN_NAME, organisations: { supplier: SUPPLIER, insurer: INSURER }, ...ownership() })}`);
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
    expect(t.mock.calls).toHaveLength(2);
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
    for (const [label, state] of [
      ['a state with no PO store', { tenant: CLEAN_NAME, supplier: { orders: [] } }],
      ['a state with orders that are no list', { tenant: CLEAN_NAME, po_store: { orders: 3 }, supplier: { orders: [] } }],
    ] as const) {
      const odd = await tenantWorld();
      expect(await submit(odd, '--run', 'r1', '--kind', 'clean'), label).toBe(0);
      odd.mock.override = (call) => (call.url.endsWith('/state') ? answer(200, state) : answer(200, { tenant: CLEAN_NAME, dropped: 0, lines: [] }));
      expect(await odd.w.run(task, 'status', '--run', 'r1'), label).toBe(1);
      expect(odd.w.screen.errorText, label).toContain('does not have the form that the mock service documents');
    }
    const logless = await tenantWorld();
    expect(await submit(logless, '--run', 'r1', '--kind', 'clean')).toBe(0);
    logless.mock.override = (call) => (call.url.endsWith('/state')
      ? answer(200, { tenant: CLEAN_NAME, po_store: { orders: [] }, supplier: { orders: [] } })
      : answer(200, { tenant: CLEAN_NAME, lines: [] }));
    expect(await logless.w.run(task, 'status', '--run', 'r1')).toBe(1);
  });

  it('reports no counts when the state, log, or a log line does not identify the requested tenant', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    const state = { tenant: CLEAN_NAME, po_store: { orders: [] }, supplier: { orders: [] } };
    const log = { tenant: CLEAN_NAME, dropped: 0, lines: [{ tenant: CLEAN_NAME }] };
    const cases = [
      [{ ...state, tenant: undefined }, log],
      [{ ...state, tenant: 'another-tenant' }, log],
      [state, { ...log, tenant: undefined }],
      [state, { ...log, tenant: 'another-tenant' }],
      [state, { ...log, lines: [{ tenant: 'another-tenant' }] }],
    ] as const;
    for (const [stateBody, logBody] of cases) {
      t.w.screen.lines.length = 0;
      t.mock.override = (call) => answer(200, call.url.endsWith('/state') ? stateBody : logBody);
      expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(1);
      expect(t.w.screen.errorText).toContain('does not have the form that the mock service documents');
      expect(t.w.screen.lines.join('\n')).not.toMatch(/orders in the PO store|lines in the log/);
    }
  });

  it('does not use an oversized or incomplete body even if it contains valid JSON', async () => {
    const t = await tenantWorld();
    expect(await submit(t, '--run', 'r1', '--kind', 'clean')).toBe(0);
    const log = { tenant: CLEAN_NAME, dropped: 0, lines: [] };
    const prefix = JSON.stringify(log);
    const encoder = new TextEncoder();
    const max = 1_048_576;
    const oversized = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(prefix + ' '.repeat(max - prefix.length)));
        controller.enqueue(encoder.encode(TOKEN));
        controller.close();
      },
    }));
    const multibyte = answer(200, { ...log, note: 'é'.repeat(max / 2) });
    const short = new Response(prefix, { headers: { 'content-length': String(prefix.length + 5) } });
    const declaredOversized = new Response(prefix, { headers: { 'content-length': String(max + 1) } });
    for (const [response, message] of [
      [oversized, `exceeds ${max} bytes`], [multibyte, `exceeds ${max} bytes`],
      [short, 'does not match its Content-Length'], [declaredOversized, 'oversized Content-Length'],
    ] as const) {
      t.w.screen.lines.length = 0;
      t.mock.override = (call) => call.url.endsWith('/log') ? response : undefined;
      expect(await t.w.run(task, 'status', '--run', 'r1')).toBe(1);
      expect(t.w.screen.errorText).toContain(message);
      expect(t.w.screen.lines.join('\n')).not.toContain('lines in the log');
      expect(t.w.allText()).not.toContain(TOKEN);
    }
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
