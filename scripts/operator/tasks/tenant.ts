// scripts/operator/tasks/tenant.ts - the task tenant: it makes the tenant of a run on the mock systems of use case 1 (inventory reorder), through the operator route of the mock service.
// The call is `POST /admin/tenants` on the public origin of the mock systems, with the operator token of the mock in the header `authorization` and a JSON body that names the tenant and its two
// organisations. The service makes the tenant from its default seed, and it resets a tenant that exists when the same name comes again: the writes and the log of that tenant are gone. So the task
// refuses a name that the facts hold for another run, and a name that the facts hold for this run unless the flag --reset is given.
// The token is read from the env file of the mock at the moment of the call, held in one local variable, and put into the header and nowhere else: no argument, line of output, message, fact,
// state or evidence entry holds it. An error of a failed call names the status and the code of the answer, and never a header, a message of the answer or a message of the network.
import { iso } from '../../checks/lib/format.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { TaskDefinition, TaskSession, TenantFact } from '../lib/contract.ts';
import { EnvFile, EnvFileError } from '../lib/envfile.ts';
import { MOCK_INSURER_DOMAIN, MOCK_PUBLIC_BASE } from '../lib/mock-hosts.ts';
import { codeOf } from '../lib/registry.ts';
import { FlagError } from '../lib/runner.ts';

/** The name of a tenant: the mock service takes 1 to 48 lower-case letters, digits and hyphens, and a first character that is no hyphen. */
const TENANT_NAME = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** The form that the mock service asks of its operator token: 32 to 128 characters of letters, digits and `. _ ~ + / = -`. A value of another form is never sent, so it never reaches an error text of the network. */
const TOKEN_FORM = /^[A-Za-z0-9._~+/=-]{32,128}$/;
const TOKEN_LINE = 'MOCK_OPERATOR_TOKEN';
/** The code of a refusal of the mock service: lower-case words with underscores. Any other text of an answer is not shown. */
const REFUSAL_CODE = /^[a-z][a-z_]{0,39}$/;
const CALL_LIMIT_MS = 30_000;
const MAX_ANSWER_CHARS = 1_048_576;

interface Extra { result: Readonly<Record<string, unknown>> | null }

/** What `status` reads of the state and the log of a tenant. */
interface TenantCounts { readonly orders: number; readonly supplierOrders: number; readonly lines: number; readonly dropped: number }

/** The answer of the mock service as text: the status and the text of the body. No header is kept. */
interface Answer { readonly status: number; readonly text: string }

/** The reason of an error of the env file for a message: it holds no value and no path. A system error gives its short code. */
const reasonOf = (err: unknown): string => (err instanceof EnvFileError ? err.message : codeOf(err));

/** The short code of a failed call: the code of the network (ECONNREFUSED), and nothing of the message, which can name a header. */
function networkCode(err: unknown): string {
  const cause = typeof err === 'object' && err !== null && 'cause' in err ? err.cause : err;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{2,24}$/.test(code) ? code : 'ERROR';
}

/** The JSON of a text, or undefined when the text is no JSON. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** The code of a refusal in the body of an answer, or null. */
function refusalCodeOf(text: string): string | null {
  const body = parseJson(text);
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && REFUSAL_CODE.test(body.error) ? body.error : null;
}

/** The field `created` of the answer to the call that makes a tenant, or null when the body is no object of the mock service for this tenant. */
function createdOf(text: string, name: string): boolean | null {
  const body = parseJson(text);
  return typeof body === 'object' && body !== null && 'tenant' in body && body.tenant === name && 'created' in body && typeof body.created === 'boolean' ? body.created : null;
}

/** The number of entries of the list `orders` in the object that `section` names, or null. */
function ordersIn(section: unknown): number | null {
  return typeof section === 'object' && section !== null && 'orders' in section && Array.isArray(section.orders) ? section.orders.length : null;
}

/** The counts that `status` prints, or null when the state or the log has not the form that the mock service documents. */
function countsOf(state: string, log: string): TenantCounts | null {
  const stateBody = parseJson(state);
  const logBody = parseJson(log);
  if (typeof stateBody !== 'object' || stateBody === null || !('po_store' in stateBody) || !('supplier' in stateBody)) return null;
  if (typeof logBody !== 'object' || logBody === null || !('lines' in logBody) || !Array.isArray(logBody.lines) || !('dropped' in logBody) || typeof logBody.dropped !== 'number') return null;
  const orders = ordersIn(stateBody.po_store);
  const supplierOrders = ordersIn(stateBody.supplier);
  return orders === null || supplierOrders === null ? null : { orders, supplierOrders, lines: logBody.lines.length, dropped: logBody.dropped };
}

async function call(session: TaskSession<Extra>, method: 'GET' | 'POST', path: string, init: { headers: Record<string, string>; body?: string }): Promise<Answer> {
  let response: Response;
  try {
    response = await session.fetchImpl(`${MOCK_PUBLIC_BASE}${path}`, { method, headers: init.headers, body: init.body, redirect: 'error', signal: AbortSignal.timeout(CALL_LIMIT_MS) });
  } catch (err) {
    throw new Error(`the call to the mock service failed (${networkCode(err)}), and nothing is known of the tenant`);
  }
  let text: string;
  try { text = (await response.text()).slice(0, MAX_ANSWER_CHARS); } catch (err) {
    throw new Error(`the answer of the mock service could not be read (${networkCode(err)}), and nothing is known of the tenant`);
  }
  return { status: response.status, text };
}

/** The refusal that an answer with another status than the expected ones is: the status and the code, and no header and no message. A refused token is a setting (nothing was done). */
function refusalOf(answer: Answer): Error {
  const code = refusalCodeOf(answer.text);
  const detail = `HTTP ${answer.status}${code === null ? '' : ` ${code}`}`;
  return answer.status === 401 || answer.status === 403
    ? new PreconditionError(`the mock service refused the operator token (${detail}): check the file of the token`)
    : new Error(`the mock service refused the call (${detail})`);
}

/** The operator token: read from the env file of the mock now, and checked for its form. A refusal names the setting or the line and never the value. */
function operatorToken(path: string | null): string {
  if (path === null) throw new PreconditionError('OPERATOR_MOCK_ENV_FILE is not set: it names the env file of the mock systems, which holds the operator token');
  let token: string | undefined;
  try { token = EnvFile.open(path).get(TOKEN_LINE); } catch (err) {
    throw new PreconditionError(`the env file of the mock systems cannot be used (${reasonOf(err)})`);
  }
  if (token === undefined || token === '') throw new PreconditionError(`the env file of the mock systems has no value in the line ${TOKEN_LINE}`);
  if (!TOKEN_FORM.test(token)) throw new PreconditionError(`the line ${TOKEN_LINE} of the env file of the mock systems does not have the form that the mock service takes: 32 to 128 characters of letters, digits and . _ ~ + / = -`);
  return token;
}

/** The name of the tenant: `--name`, or the prefix of the run kind and the date. A flag problem is exit 2 and names the flag. */
function tenantName(session: TaskSession<Extra>): { name: string; sku: string | null } {
  const given = session.flags.value('name');
  const kind = session.flags.value('kind');
  if (given === undefined && kind === undefined) throw new FlagError('give --kind <clean or failure> or --name <tenant>: the task has no table of run labels, so the name of the tenant comes from one of them');
  const spec = kind === undefined ? undefined : session.use.runs.find((run) => run.id === kind);
  if (kind !== undefined && spec === undefined) throw new FlagError(`--kind is one of: ${session.use.runs.map((run) => run.id).join(', ')}`);
  const date = new Date(session.clock.now()).toISOString().slice(0, 10).replace(/-/g, '');
  const name = given ?? `${spec!.tenantPrefix}-${date}`;
  if (!TENANT_NAME.test(name)) throw new FlagError('the name of a tenant has 1 to 48 lower-case letters, digits or hyphens, and its first character is no hyphen');
  return { name, sku: spec === undefined ? null : spec.sku };
}

/** The tenant that the facts hold for a run, or undefined. */
function heldBy(session: TaskSession<Extra>, run: string): TenantFact | undefined {
  const tenants = session.facts.read().tenants;
  return Object.hasOwn(tenants, run) ? tenants[run] : undefined;
}

/** The domain of the supplier organisation of the tenant: the organisation of the Order Desk. */
function supplierDomain(session: TaskSession<Extra>): string {
  const desk = session.use.agents.find((agent) => agent.kind === 'order-desk');
  const organisation = desk === undefined ? undefined : session.use.organisations.find((one) => one.id === desk.organisation);
  if (organisation === undefined) throw new PreconditionError('the data of the use case names no organisation for the Order Desk');
  return organisation.domain;
}

async function create(session: TaskSession<Extra>): Promise<{ kind: 'dry' } | { kind: 'done'; message: string }> {
  const run = session.flags.value('run');
  if (run === undefined) throw new FlagError('--run <label> is required: the tenant belongs to a run');
  const { name, sku } = tenantName(session);
  const facts = session.facts.read();
  const owner = Object.entries(facts.tenants).find(([label, fact]) => fact.name === name && label !== run);
  if (owner !== undefined) throw new PreconditionError(`the facts hold the tenant ${name} for the run ${owner[0]}: a second call with this name resets that tenant, so use another name`);
  const held = heldBy(session, run);
  if (held !== undefined && held.name !== name) throw new PreconditionError(`the facts hold the tenant ${held.name} for the run ${run}: give --name ${held.name} with --reset to reset it, or use another run label`);
  if (held !== undefined && !session.flags.has('reset')) throw new PreconditionError(`the facts hold the tenant ${name} for the run ${run} already: a second call resets it, and its writes and its log are lost. Give --reset to reset it`);
  const body = { tenant: name, organisations: { supplier: supplierDomain(session), insurer: MOCK_INSURER_DOMAIN } };
  if (session.mode === 'dry') {
    if (session.settings.mockEnvFile === null) throw new PreconditionError('OPERATOR_MOCK_ENV_FILE is not set: it names the env file of the mock systems, which holds the operator token');
    session.out.out('the request that --submit sends (a dry run sends nothing):');
    session.out.out(`  POST ${MOCK_PUBLIC_BASE}/admin/tenants`);
    session.out.out('  header authorization: the operator token of the mock systems, read from its env file at the call (not shown)');
    session.out.out(`  body ${JSON.stringify(body)}`);
    session.extra.result = { tenant: name };
    return { kind: 'dry' };
  }
  const token = operatorToken(session.settings.mockEnvFile);
  const answer = await call(session, 'POST', '/admin/tenants', { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (answer.status !== 200 && answer.status !== 201) throw refusalOf(answer);
  const created = createdOf(answer.text, name);
  if (created !== (answer.status === 201)) throw new Error(`the mock service answered HTTP ${answer.status} with a body that does not say so (the field created) or that names another tenant: the state of the tenant ${name} is not known`);
  const fact: TenantFact = { name, createdAt: iso(session.clock.now()), seedKind: 'default' };
  try { session.facts.put('tenants', [run], fact, { replace: held !== undefined }); } catch (err) {
    throw new Error(`the tenant ${name} is ${created ? 'made' : 'reset'}, and the facts file could not take the fact tenants.${run} (${err instanceof Error ? err.message : 'an error'}). Give --reset with the same name to write the fact`);
  }
  session.extra.result = { tenant: name, created };
  const seed = sku === null ? 'the default seed' : `the default seed (the run reads ${sku})`;
  return {
    kind: 'done',
    message: created
      ? `the tenant ${name} is new: the mock service made it from ${seed}`
      : `the tenant ${name} existed: the mock service reset it from ${seed}, and its writes and its log are gone`,
  };
}

/** One read of the state or the log of a tenant. The route needs no credential, so no header but `accept` goes with it. */
async function read(session: TaskSession<Extra>, name: string, what: 'state' | 'log'): Promise<string> {
  const answer = await call(session, 'GET', `/t/${name}/${what}`, { headers: { accept: 'application/json' } });
  if (answer.status !== 200) throw refusalOf(answer);
  return answer.text;
}

const task: TaskDefinition<Extra> = {
  name: 'tenant',
  title: 'Make the tenant of a run on the mock systems',
  flags: ['reset'],
  valued: ['name', 'kind'],
  needs: { keys: () => [], chain: false, hosted: [], approval: 'never' },
  steps: () => ['create'],
  parse: () => ({ result: null }),
  next: create,
  async cleanup() {
    return { kind: 'done', message: 'there is nothing to take back: the mock service has no route that removes a tenant' };
  },
  async status(session) {
    const run = session.flags.value('run');
    if (run === undefined) return ['tenant: give --run <label> to read the tenant of a run'];
    const held = heldBy(session, run);
    if (held === undefined) return [`tenant: the facts hold no tenant for the run ${run}`];
    const counts = countsOf(await read(session, held.name, 'state'), await read(session, held.name, 'log'));
    if (counts === null) throw new Error(`the state or the log of the tenant ${held.name} does not have the form that the mock service documents`);
    return [
      `tenant ${held.name} of the run ${run}: made at ${held.createdAt} from the default seed`,
      `  orders in the PO store: ${counts.orders}, orders at the supplier portal: ${counts.supplierOrders}`,
      `  lines in the log: ${counts.lines}, dropped: ${counts.dropped}`,
    ];
  },
  result: (session) => session.extra.result ?? {},
};

export default task;
