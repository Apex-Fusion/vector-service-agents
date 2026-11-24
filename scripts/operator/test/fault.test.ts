// The task fault, run through the real runner over the real examples of the two service env files (read from deploy/server at test time) and a `seen-services.json` that the tests write the way the
// script that runs the pack does. The guards are the guards of the kit. A check never passes without a fresh and whole reading of every service of the use case.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import type { UseCase } from '../lib/contract.ts';
import { EnvFile } from '../lib/envfile.ts';
import { loadTask } from '../lib/load.ts';
import task from '../tasks/fault.ts';
import BIDS from '../usecases/bid-evaluation.ts';
import USE from '../usecases/inventory-reorder.ts';
import PRIORAUTH from '../usecases/prior-authorization.ts';
import { NOW, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const SERVER = fileURLToPath(new URL('../../../deploy/server/', import.meta.url));
const REORDER = 'reorder-agent/.env.reorder-agent';
const SERVICE = 'order-desk/.env.order-desk';
const FAULT = 'confirm_wrong_lot';
const REORDER_STARTED = '2026-11-15T10:00:00.123456789Z';
const DESK_STARTED = '2026-11-15T10:05:00Z';
/** A value that is no fault name and is longer than the kit shows: the guard names it by its length only, and the task shows it as a phrase. */
const ODD = 'sk-not-a-fault-name-at-all-x';
const PHRASE = 'a value that is no fault name';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

type Service = Record<string, unknown>;

/** The text of the file that the script writes: one service for each agent, both with the switch empty. `change` edits the document and the list of its services before the text is made. */
function seenDoc(change: (doc: Record<string, unknown>, services: Service[]) => void = () => undefined, generatedAt = NOW - 5 * 60_000, rows?: readonly Service[]): string {
  const services: Service[] = rows === undefined ? [
    { service: 'reorder-service', kind: 'reorder-agent', container: 'reorder-service', started_at: REORDER_STARTED, env: { FAULT_MODE: '' } },
    { service: 'orders-service', kind: 'order-desk', container: 'orders-service', started_at: DESK_STARTED, env: { FAULT_MODE: '' } },
  ] : rows.map((row) => ({ ...row }));
  const doc: Record<string, unknown> = { generated_at: iso(generatedAt), services };
  change(doc, services);
  return JSON.stringify(doc);
}

interface FaultWorld { readonly w: TaskWorld; readonly agents: string; path(file: string): string; value(file: string): string | undefined; seen(text: string): void }

interface WorldOptions { readonly go?: boolean; readonly files?: boolean; readonly seen?: string | null; readonly use?: UseCase }

async function faultWorld(options: WorldOptions = {}): Promise<FaultWorld> {
  const agents = mkdtempSync(join(tmpdir(), 'operator-agents-'));
  roots.push(agents);
  const use = options.use ?? USE;
  for (const { folder, serviceEnvFile: name, exampleEnvFile } of use.agents) {
    mkdirSync(join(agents, folder), { mode: 0o750 });
    if (options.files !== false) {
      copyFileSync(join(SERVER, exampleEnvFile ?? `${name}.example`), join(agents, folder, name));
      chmodSync(join(agents, folder, name), 0o600);
    }
  }
  const w = await taskWorld({ use, env: { OPERATOR_USE_CASE: USE.name, OPERATOR_AGENTS_DIR: agents } });
  mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(w.stateDir, 0o700);
  const seen = (text: string): void => { writeFileSync(join(w.stateDir, 'seen-services.json'), text, { mode: 0o600 }); };
  if (options.seen !== null) seen(options.seen ?? seenDoc());
  if (options.go !== false) w.writeGo({ tasks: ['fault'] });
  return { w, agents, path: (file) => join(agents, file), value: (file) => EnvFile.open(join(agents, file)).get('FAULT_MODE'), seen };
}

const submit = (f: FaultWorld, ...argv: string[]): Promise<number> => f.w.run(task, '--submit', ...argv);
const dry = (f: FaultWorld, ...argv: string[]): Promise<number> => f.w.run(task, ...argv);
const text = (f: FaultWorld, file: string): string => readFileSync(f.path(file), 'utf8');
const mode = (path: string): number => statSync(path).mode & 0o777;
const entries = (f: FaultWorld, run = 'r1'): Array<Record<string, unknown>> => f.w.evidence('fault', run);
/** What an entry of the guard shows: the check, the agent, whether it passed, and the name, the start time and the value of each service. */
const shows = (check: string, agent: string | null, ok: boolean, desk = '', reorder = ''): Record<string, unknown> => ({
  check, agent, ok, services: [{ service: 'reorder-service', started_at: REORDER_STARTED, value: reorder }, { service: 'orders-service', started_at: DESK_STARTED, value: desk }],
});

describe('--set', () => {
  it('sets the switch of the Order Desk in its service file, and sets it empty again, and changes no other line and no other file', async () => {
    const f = await faultWorld();
    const before = text(f, SERVICE);
    const reorder = text(f, REORDER);
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(f.value(SERVICE)).toBe(FAULT);
    expect(text(f, SERVICE)).toBe(before.replace('\nFAULT_MODE=\n', `\nFAULT_MODE=${FAULT}\n`));
    expect(text(f, REORDER)).toBe(reorder);
    expect(mode(f.path(SERVICE))).toBe(0o600);
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to ${FAULT} (it holds empty now; container orders-service)`);
    expect(f.w.screen.lines).toContain('the service of order-desk reads FAULT_MODE when its container is created: create the service again by the restart rule, after each of its 3 runtimes says free (container orders-service)');
    expect(f.w.machine()).toMatchObject({ task: 'fault', mode: 'submit', outcome: 'done', exit: 0, result: { set: [{ agent: 'order-desk', value: FAULT }] } });
    expect(await submit(f, '--agent', 'order-desk', '--set=')).toBe(0);
    expect(f.value(SERVICE)).toBe('');
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to empty (it holds ${FAULT} now; container orders-service)`);
  });

  it('takes the empty value for the Reorder Agent, which has no fault value, and for every agent when no agent is given', async () => {
    const f = await faultWorld();
    expect(await submit(f, '--agent', 'reorder-agent', '--set=')).toBe(0);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${REORDER} already holds empty: no change (container reorder-service)`);
    expect(f.w.screen.lines).toContain('the service of reorder-agent reads FAULT_MODE when its container is created: create the service again by the restart rule, after each of its 1 runtime says free (container reorder-service)');
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    f.w.screen.lines.length = 0;
    expect(await submit(f, '--set=')).toBe(0);
    expect(f.value(SERVICE)).toBe('');
    expect(f.value(REORDER)).toBe('');
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to empty (it holds ${FAULT} now; container orders-service)`);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${REORDER} already holds empty: no change (container reorder-service)`);
    expect(f.w.machine().result).toEqual({ set: [{ agent: 'reorder-agent', value: '' }, { agent: 'order-desk', value: '' }] });
  });

  it('keeps the value when it is the value that the file holds, and writes nothing', async () => {
    const f = await faultWorld();
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    const before = text(f, SERVICE);
    f.w.screen.lines.length = 0;
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${SERVICE} already holds ${FAULT}: no change (container orders-service)`);
    expect(f.w.machine().outcome).toBe('done');
  });

  it('shows the line in a dry run and writes nothing', async () => {
    const f = await faultWorld({ go: false });
    const before = text(f, SERVICE);
    expect(await dry(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0 });
    expect(f.w.screen.lines).toContain(`would set FAULT_MODE in ${SERVICE} to ${FAULT} (it holds empty now; container orders-service)`);
    expect(f.w.screen.lines.some((line) => line.startsWith('the service of order-desk reads FAULT_MODE'))).toBe(true);
  });

  it('refuses a value that the kind does not list, a fault value with no agent, an agent that is unknown, and both --set and --check, and neither, before it changes a file', async () => {
    const table: ReadonlyArray<readonly [string, string[], string]> = [
      ['a value that no kind lists', ['--agent', 'order-desk', '--set', 'bogus'], '--set is not a setting of the kind order-desk'],
      ['a value in upper case', ['--agent', 'order-desk', '--set', 'CONFIRM_WRONG_LOT'], '--set is not a setting of the kind order-desk'],
      ['the fault of the Order Desk for the Reorder Agent', ['--agent', 'reorder-agent', '--set', FAULT], 'the agent reorder-agent has no fault value'],
      ['a fault value with no agent', ['--set', FAULT], 'needs --agent'],
      ['an unknown agent', ['--agent', 'nobody', '--set='], '--agent is one of: reorder-agent, order-desk'],
      ['an empty agent', ['--agent=', '--set='], '--agent is one of'],
      ['--set and --check', ['--agent', 'order-desk', '--set', FAULT, '--check', 'clean', '--run', 'r1'], 'not both'],
      ['neither', ['--agent', 'order-desk'], 'give --set'],
    ];
    for (const [label, argv, words] of table) {
      const f = await faultWorld();
      const files = [text(f, SERVICE), text(f, REORDER)];
      expect(await submit(f, ...argv), label).toBe(2);
      expect(f.w.screen.errorText, label).toContain(words);
      expect([text(f, SERVICE), text(f, REORDER)], label).toEqual(files);
    }
  });

  it('refuses a file that is missing, damaged or without the line, names it, and writes no file of the other agent', async () => {
    const missing = await faultWorld({ files: false });
    expect(await submit(missing, '--set=')).toBe(2);
    expect(missing.w.screen.errorText).toContain('reorder-agent/.env.reorder-agent: the service env file cannot be used (the env file does not exist)');
    const odd = await faultWorld();
    writeFileSync(odd.path(SERVICE), 'this is no env file\n', { mode: 0o600 });
    expect(await submit(odd, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(odd.w.screen.errorText).toContain(`${SERVICE}: the service env file cannot be used`);
    const bare = await faultWorld();
    writeFileSync(bare.path(SERVICE), 'PORT=1\n', { mode: 0o600 });
    const reorder = text(bare, REORDER);
    expect(await submit(bare, '--set=')).toBe(2);
    expect(bare.w.screen.errorText).toContain(`${SERVICE}: the file has no line FAULT_MODE`);
    expect(text(bare, REORDER)).toBe(reorder);
  });

  it('writes nothing without the approval of the session', async () => {
    const f = await faultWorld({ go: false });
    const before = text(f, SERVICE);
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(text(f, SERVICE)).toBe(before);
    f.w.writeGo({ tasks: ['fund'] });
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(text(f, SERVICE)).toBe(before);
    f.w.writeGo({ tasks: ['fault'] });
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(f.value(SERVICE)).toBe(FAULT);
  });
});

describe('--check with a clean run', () => {
  it('passes for a fresh reading that shows no fault, writes no entry in a dry run, and writes one entry for each run with --submit: both entries are kept', async () => {
    const f = await faultWorld();
    expect(await dry(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f)).toEqual([]);
    expect(f.w.machine()).toMatchObject({ mode: 'dry', outcome: 'done', exit: 0, result: shows('clean', null, true) });
    expect(f.w.screen.lines).toContain(`service reorder-service: FAULT_MODE is empty, started at ${REORDER_STARTED}`);
    expect(f.w.screen.lines).toContain('service orders-service: FAULT_MODE is empty, started at 2026-11-15T10:05:00Z');
    expect(f.w.screen.lines.some((line) => line.includes('a dry run writes no evidence entry'))).toBe(true);
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f)).toEqual([{ step: 'fault_check', status: 'info', shows: shows('clean', null, true), at: expect.any(String) }]);
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f).map((entry) => entry.shows)).toEqual([shows('clean', null, true), shows('clean', null, true)]);
    expect(f.w.screen.lines.some((line) => line.includes('the entry fault_check is written into the evidence file'))).toBe(true);
    // The entries of another run are in another file.
    expect(await submit(f, '--run', 'r2', '--check', 'clean')).toBe(0);
    expect(entries(f, 'r2')).toHaveLength(1);
    expect(entries(f)).toHaveLength(2);
  });

  it('refuses a clean check when any service has a fault value, with exit 1 and the code of the guard, and writes the entry with ok false', async () => {
    const f = await faultWorld({ seen: seenDoc((_doc, services) => { services[1]!.env = { FAULT_MODE: FAULT }; }) });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(1);
    expect(f.w.screen.errorText).toContain('the fault guard refuses (fault_set)');
    expect(f.w.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { ...shows('clean', null, false, FAULT), code: 'fault_set' } });
    expect(entries(f).map((entry) => entry.shows)).toEqual([shows('clean', null, false, FAULT)]);
    const reorder = await faultWorld({ seen: seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: ' ' }; }) });
    expect(await dry(reorder, '--run', 'r1', '--check', 'clean')).toBe(1);
    expect(reorder.w.screen.errorText).toContain('fault_set');
    expect(entries(reorder)).toEqual([]);
  });

  it('shows a value that is no fault name as a phrase, in the output and in the entry', async () => {
    const f = await faultWorld({ seen: seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: ODD }; }) });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(1);
    expect(entries(f)[0]!.shows).toEqual(shows('clean', null, false, '', PHRASE));
    expect(f.w.screen.lines).toContain(`service reorder-service: FAULT_MODE is ${PHRASE}, started at ${REORDER_STARTED}`);
    // The reading itself stands in the state folder, so the check is on what the task shows and writes: the screen and the evidence.
    expect([...f.w.screen.lines, ...f.w.screen.errors, JSON.stringify(entries(f))].join('\n')).not.toContain(ODD);
  });

  it('refuses a clean check with exit 2 for a reading that is not fresh and whole, and writes no entry', async () => {
    const at = (offset: number): string => seenDoc(undefined, NOW + offset);
    const table: ReadonlyArray<readonly [string, string | null, string]> = [
      ['a file that is missing', null, 'seen-services.json does not exist'],
      ['a file that is older than 10 minutes', at(-601_000), 'more than 10 minutes old'],
      ['a file from the future', at(61_000), 'in the future'],
      ['a file that is not JSON', '{', 'is not JSON'],
      ['an empty list of services', seenDoc((doc) => { doc.services = []; }), 'services is not a list, or it is empty'],
      ['services that are no list', seenDoc((doc) => { doc.services = 'none'; }), 'services is not a list, or it is empty'],
      ['a time that is no time', seenDoc((doc) => { doc.generated_at = 'now'; }), 'generated_at is not an ISO 8601 time'],
      ['no time', seenDoc((doc) => { delete doc.generated_at; }), 'exactly the members generated_at and services'],
      ['a member more in the file', seenDoc((doc) => { doc.extra = 1; }), 'exactly the members generated_at and services'],
      ['a service with no started_at', seenDoc((_doc, services) => { delete services[1]!.started_at; }), 'exactly the members service, kind, container, started_at and env'],
      ['a started_at that is no time', seenDoc((_doc, services) => { services[1]!.started_at = 'yesterday'; }), 'started_at is not an ISO 8601 time'],
      ['a started_at with no zone', seenDoc((_doc, services) => { services[1]!.started_at = '2026-11-15T10:00:00'; }), 'started_at is not an ISO 8601 time'],
      ['a started_at that is a number', seenDoc((_doc, services) => { services[1]!.started_at = 1_700_000_000; }), 'started_at is not an ISO 8601 time'],
      ['a started_at that names no day', seenDoc((_doc, services) => { services[1]!.started_at = '2026-02-30T10:00:00Z'; }), 'started_at is not an ISO 8601 time'],
      ['an env that is null', seenDoc((_doc, services) => { services[0]!.env = null; }), 'env is not an object that holds exactly the variable FAULT_MODE'],
      ['an env that is a text', seenDoc((_doc, services) => { services[0]!.env = 'FAULT_MODE='; }), 'env is not an object'],
      ['an env that is a list', seenDoc((_doc, services) => { services[0]!.env = []; }), 'env is not an object'],
      ['an env with no FAULT_MODE', seenDoc((_doc, services) => { services[0]!.env = {}; }), 'env is not an object'],
      ['a FAULT_MODE that is a number', seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: 5 }; }), 'FAULT_MODE is not a text'],
      ['a FAULT_MODE that is null', seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: null }; }), 'FAULT_MODE is not a text'],
      ['a variable more in the env', seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: '', PATH: '/bin' }; }), 'env is not an object'],
      ['a member more in a service', seenDoc((_doc, services) => { services[0]!.image = 'x'; }), 'exactly the members service, kind, container, started_at and env'],
      ['a service that is no object', seenDoc((doc, services) => { doc.services = ['reorder', services[1]]; }), 'exactly the members service'],
      ['a name that is no name', seenDoc((_doc, services) => { services[0]!.service = 'two words'; }), 'service is not a name'],
      ['a container named twice', seenDoc((_doc, services) => { services[1]!.container = 'reorder-service'; }), 'names a container twice'],
      ['no Order Desk container', seenDoc((_doc, services) => { services.pop(); }), 'shows no container orders-service'],
      ['the Order Desk container with another kind', seenDoc((_doc, services) => { services[1]!.kind = 'bid-desk'; }), 'container orders-service has a different kind'],
      ['a FAULT_MODE named twice in the text', seenDoc().replace('"env":{"FAULT_MODE":""}}]', `"env":{"FAULT_MODE":"${FAULT}","FAULT_MODE":""}}]`), 'has a member twice'],
    ];
    for (const [label, seen, words] of table) {
      const f = await faultWorld({ seen });
      expect(await submit(f, '--run', 'r1', '--check', 'clean'), label).toBe(2);
      expect(f.w.screen.errorText, label).toContain(words);
      expect(entries(f), label).toEqual([]);
      expect(f.w.machine(), label).toMatchObject({ outcome: 'stopped', exit: 2 });
    }
  });

  it('passes a reading that is just fresh enough, and a start time with an offset, and ignores a service of another kind', async () => {
    const edge = await faultWorld({ seen: seenDoc(undefined, NOW - 600_000) });
    expect(await dry(edge, '--run', 'r1', '--check', 'clean')).toBe(0);
    const ahead = await faultWorld({ seen: seenDoc(undefined, NOW + 59_000) });
    expect(await dry(ahead, '--run', 'r1', '--check', 'clean')).toBe(0);
    const offset = await faultWorld({ seen: seenDoc((_doc, services) => { services[1]!.started_at = '2026-11-15T11:05:00+01:00'; }) });
    expect(await submit(offset, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(offset)[0]!.shows).toMatchObject({ services: [{ started_at: REORDER_STARTED }, { started_at: '2026-11-15T11:05:00+01:00' }] });
    const other = await faultWorld({
      seen: seenDoc((_doc, services) => { services.push({ service: 'bids-service', kind: 'bid-desk', container: 'bids-service', started_at: DESK_STARTED, env: { FAULT_MODE: 'quote_off_price_list' } }); }),
    });
    expect(await submit(other, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(other)[0]!.shows).toEqual(shows('clean', null, true));
  });

  it('ignores a container outside the use case, even if its kind matches', async () => {
    const reading = seenDoc((_doc, services) => {
      services.push({ service: 'service', kind: 'order-desk', container: 'another-desk', started_at: DESK_STARTED, env: { FAULT_MODE: FAULT } });
    });
    const f = await faultWorld({ seen: reading });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f)[0]!.shows).toEqual(shows('clean', null, true));
  });

  it('needs --run, takes no --agent, and takes --check clean only as that word', async () => {
    const f = await faultWorld();
    const table: ReadonlyArray<readonly [string, string[], string]> = [
      ['no run', ['--check', 'clean'], '--run <label> is required with --check'],
      ['--agent with clean', ['--run', 'r1', '--check', 'clean', '--agent', 'order-desk'], 'do not give --agent'],
      ['the empty check', ['--run', 'r1', '--check='], 'the empty value is no check'],
      ['a word that is no fault', ['--run', 'r1', '--check', 'Clean', '--agent', 'order-desk'], '--check is clean, or a setting of the kind order-desk'],
    ];
    for (const [label, argv, words] of table) {
      f.w.screen.errors.length = 0;
      expect(await submit(f, ...argv), label).toBe(2);
      expect(f.w.screen.errorText, label).toContain(words);
    }
    expect(entries(f)).toEqual([]);
  });
});

describe('--check with the fault that a run needs', () => {
  const faulty = (desk: string, reorder = ''): string => seenDoc((_doc, services) => { services[1]!.env = { FAULT_MODE: desk }; services[0]!.env = { FAULT_MODE: reorder }; });

  it('passes when the Order Desk holds the value and no other service holds one, and writes the entry with the check that was asked', async () => {
    const f = await faultWorld({ seen: faulty(FAULT) });
    expect(await submit(f, '--run', 'r1', '--agent', 'order-desk', '--check', FAULT)).toBe(0);
    expect(entries(f).map((entry) => entry.shows)).toEqual([shows(FAULT, 'order-desk', true, FAULT)]);
    expect(f.w.machine()).toMatchObject({ outcome: 'done', exit: 0, result: shows(FAULT, 'order-desk', true, FAULT) });
    expect(f.w.screen.lines).toContain(`service orders-service: FAULT_MODE is ${FAULT}, started at ${DESK_STARTED}`);
    expect(await dry(f, '--run', 'r1', '--agent', 'order-desk', '--check', FAULT)).toBe(0);
    expect(entries(f)).toHaveLength(1);
  });

  it('refuses another value, an empty value, and a value in another service, with exit 1 and the code, and writes the entry with ok false', async () => {
    const table: ReadonlyArray<readonly [string, string, string, string, string]> = [
      ['an empty value', faulty(''), 'fault_missing', '', ''],
      ['another value', faulty('other_fault'), 'fault_differs', 'other_fault', ''],
      ['a fault in the Reorder service too', faulty(FAULT, 'other_fault'), 'fault_set', FAULT, 'other_fault'],
    ];
    for (const [label, seen, code, desk, reorder] of table) {
      const f = await faultWorld({ seen });
      expect(await submit(f, '--run', 'r1', '--agent', 'order-desk', '--check', FAULT), label).toBe(1);
      expect(f.w.screen.errorText, label).toContain(`the fault guard refuses (${code})`);
      expect(entries(f)[0]!.shows, label).toEqual(shows(FAULT, 'order-desk', false, desk, reorder));
      expect(f.w.machine(), label).toMatchObject({ outcome: 'failed', exit: 1, result: { code } });
    }
  });

  it('refuses a fault check with no agent, for the Reorder Agent, for a value that the kind does not list, and with a reading that is not fresh', async () => {
    const f = await faultWorld({ seen: faulty(FAULT) });
    const table: ReadonlyArray<readonly [string, string[], string]> = [
      ['no agent', ['--run', 'r1', '--check', FAULT], 'needs --agent'],
      ['the Reorder Agent', ['--run', 'r1', '--agent', 'reorder-agent', '--check', FAULT], 'the agent reorder-agent has no fault value'],
      ['a value that no kind lists', ['--run', 'r1', '--agent', 'order-desk', '--check', 'bogus'], '--check is clean, or a setting of the kind order-desk'],
      ['an unknown agent', ['--run', 'r1', '--agent', 'nobody', '--check', FAULT], '--agent is one of'],
      ['no run', ['--agent', 'order-desk', '--check', FAULT], '--run <label> is required with --check'],
    ];
    for (const [label, argv, words] of table) {
      f.w.screen.errors.length = 0;
      expect(await submit(f, ...argv), label).toBe(2);
      expect(f.w.screen.errorText, label).toContain(words);
    }
    f.seen(seenDoc((_doc, services) => { services[1]!.env = { FAULT_MODE: FAULT }; }, NOW - 700_000));
    expect(await submit(f, '--run', 'r1', '--agent', 'order-desk', '--check', FAULT)).toBe(2);
    expect(entries(f)).toEqual([]);
  });

  it('keeps the entry of each check of a run, in order, with the start time of each service, so that two readings can be compared', async () => {
    const f = await faultWorld();
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    f.seen(faulty(FAULT));
    expect(await submit(f, '--run', 'r1', '--agent', 'order-desk', '--check', FAULT)).toBe(0);
    f.seen(seenDoc((_doc, services) => { services[1]!.started_at = '2026-11-15T11:30:00Z'; }));
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f).map((entry) => entry.shows)).toMatchObject([
      { check: 'clean', services: [{ started_at: REORDER_STARTED }, { started_at: DESK_STARTED }] },
      { check: FAULT, services: [{ started_at: REORDER_STARTED }, { started_at: DESK_STARTED }] },
      { check: 'clean', services: [{ started_at: REORDER_STARTED }, { started_at: '2026-11-15T11:30:00Z' }] },
    ]);
  });
});

describe('the containers of the additional agents', () => {
  const QUOTE_FAULT = 'quote_off_price_list';
  const cleanRows = (names: ReadonlyArray<readonly [string, string]>): Service[] => names.map(([kind, container]) => ({
    service: 'service', kind, container, started_at: DESK_STARTED, env: { FAULT_MODE: '' },
  }));
  const prior = cleanRows([['prior-authorization-agent', 'priorauth-service'], ['insurer-intake-agent', 'intake-service']]);
  // This order differs from the order of the agents in the data.
  const bids = cleanRows([['bid-desk', 'bids-charlie-service'], ['sourcing-agent', 'sourcing-service'], ['bid-desk', 'bids-bravo-service'], ['bid-desk', 'bids-alfa-service']]);
  const containers = ['sourcing-service', 'bids-alfa-service', 'bids-bravo-service', 'bids-charlie-service'];
  const snapshot = (services: Service[], change?: (doc: Record<string, unknown>, rows: Service[]) => void): string => seenDoc(change, undefined, services);

  it.each([
    { use: PRIORAUTH, rows: prior, wanted: ['priorauth-service', 'intake-service'] },
    { use: BIDS, rows: bids, wanted: containers },
  ])('checks every container for $use.title with one Compose service label', async ({ use, rows, wanted }) => {
    const f = await faultWorld({ use, seen: snapshot(rows) });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(0);
    expect(entries(f)[0]!.shows).toEqual({ check: 'clean', agent: null, ok: true, services: wanted.map((service) => ({ service, started_at: DESK_STARTED, value: '' })) });
  });

  it('reports the only flagged Bid Desk by container and refuses it if the container names are swapped', async () => {
    const f = await faultWorld({ use: BIDS, seen: snapshot(bids, (_doc, rows) => { rows[0]!.env = { FAULT_MODE: QUOTE_FAULT }; }) });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(1);
    expect(f.w.screen.errorText).toContain('bids-charlie-service');
    expect(await submit(f, '--run', 'r1', '--check', QUOTE_FAULT, '--agent', 'bid-desk-charlie')).toBe(0);
    expect(entries(f)[1]!.shows).toEqual({
      check: QUOTE_FAULT, agent: 'bid-desk-charlie', ok: true,
      services: containers.map((service) => ({ service, started_at: DESK_STARTED, value: service === 'bids-charlie-service' ? QUOTE_FAULT : '' })),
    });
    f.seen(snapshot(bids, (_doc, rows) => {
      rows[0]!.env = { FAULT_MODE: QUOTE_FAULT };
      [rows[0]!.container, rows[3]!.container] = [rows[3]!.container, rows[0]!.container];
    }));
    expect(await submit(f, '--run', 'r1', '--check', QUOTE_FAULT, '--agent', 'bid-desk-charlie')).toBe(1);
    expect(f.w.screen.errorText).toContain('bids-alfa-service');
    expect(await f.w.run(task, 'status')).toBe(0);
    expect(f.w.screen.lines).toContain(`fault: bid-desk-alfa: bid-desk-alfa/.env.bid-desk-alfa: FAULT_MODE in the file is empty, in the running service bids-alfa-service it is ${QUOTE_FAULT} (started at ${DESK_STARTED})`);
  });

  it('refuses two active switches, a missing container, a wrong kind and a shared container in the data', async () => {
    const f = await faultWorld({ use: BIDS, seen: snapshot(bids, (_doc, rows) => {
      rows[0]!.env = { FAULT_MODE: QUOTE_FAULT };
      rows[2]!.env = { FAULT_MODE: QUOTE_FAULT };
    }) });
    expect(await submit(f, '--run', 'r1', '--check', QUOTE_FAULT, '--agent', 'bid-desk-charlie')).toBe(1);
    expect(f.w.screen.errorText).toContain('bids-bravo-service');
    f.seen(snapshot(bids, (_doc, rows) => { rows.shift(); }));
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(2);
    expect(f.w.screen.errorText).toContain('shows no container bids-charlie-service');
    f.seen(snapshot(bids, (_doc, rows) => { rows[0]!.kind = 'sourcing-agent'; }));
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(2);
    expect(f.w.screen.errorText).toContain('container bids-charlie-service has a different kind');
    expect(entries(f)).toHaveLength(1);

    const agents = BIDS.agents.map((agent) => agent.id === 'bid-desk-charlie' ? { ...agent, serviceContainer: 'bids-bravo-service' } : agent);
    const shared = await faultWorld({ use: { ...BIDS, agents }, seen: snapshot(bids) });
    expect(await submit(shared, '--run', 'r1', '--check', 'clean')).toBe(2);
    expect(shared.w.screen.errorText).toContain('two agents of the data name container bids-bravo-service');
    expect(entries(shared)).toEqual([]);
  });

  it('changes the named desk file only and clears all four service files with --set=', async () => {
    const f = await faultWorld({ use: BIDS, seen: snapshot(bids) });
    const files = BIDS.agents.map(({ folder, serviceEnvFile }) => `${folder}/${serviceEnvFile}`);
    const before = files.map((file) => text(f, file));
    expect(await submit(f, '--agent', 'bid-desk-charlie', '--set', QUOTE_FAULT)).toBe(0);
    expect(files.map(f.value)).toEqual(['', '', '', QUOTE_FAULT]);
    expect(files.slice(0, 3).map((file) => text(f, file))).toEqual(before.slice(0, 3));
    expect(await submit(f, '--agent', 'sourcing-agent', '--set', 'invert_scores')).toBe(0);
    expect(await submit(f, '--set=')).toBe(0);
    expect(files.map((file) => text(f, file))).toEqual(before);
    expect(f.w.machine().result).toEqual({ set: BIDS.agents.map(({ id }) => ({ agent: id, value: '' })) });
  });
});

describe('a value that has the form of a key', () => {
  // 64 hex characters that start with a letter: the form of a key in hex. It must never reach a stream, the evidence or the result line.
  const KEY = `a${hashOf('fault key').slice(1)}`;

  it('is shown as a phrase by a check, in the output, the entry of the evidence and the result line', async () => {
    const f = await faultWorld({ seen: seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: KEY }; }) });
    expect(await submit(f, '--run', 'r1', '--check', 'clean')).toBe(1);
    expect([...f.w.screen.lines, ...f.w.screen.errors, JSON.stringify(entries(f))].join('\n')).not.toContain(KEY);
    expect(entries(f)[0]!.shows).toEqual(shows('clean', null, false, '', PHRASE));
    expect(f.w.machine().result).toEqual({ ...shows('clean', null, false, '', PHRASE), code: 'fault_set' });
  });

  it('is shown as a phrase by status and by --set, and --set= clears it', async () => {
    const f = await faultWorld();
    const file = EnvFile.open(f.path(SERVICE));
    file.set('FAULT_MODE', KEY);
    file.write();
    expect(await f.w.run(task, 'status')).toBe(0);
    expect(f.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: FAULT_MODE in the file is ${PHRASE}, in the running service orders-service it is empty (started at ${DESK_STARTED})`);
    f.w.screen.lines.length = 0;
    expect(await submit(f, '--agent', 'order-desk', '--set=')).toBe(0);
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to empty (it holds ${PHRASE} now; container orders-service)`);
    expect(f.value(SERVICE)).toBe('');
    expect([...f.w.screen.lines, ...f.w.screen.errors].join('\n')).not.toContain(KEY);
  });

  it('is no fault name, and a value with the form of a fault name is shown as it is: lower-case letters and underscores, at most 24 characters', async () => {
    const f = await faultWorld();
    const table: ReadonlyArray<readonly [string, string]> = [
      [FAULT, FAULT], ['a'.repeat(24), 'a'.repeat(24)], ['a'.repeat(25), PHRASE], ['abc1', PHRASE], ['Confirm', PHRASE], ['_x', PHRASE], ['x-y', PHRASE],
    ];
    for (const [value, shownAs] of table) {
      f.seen(seenDoc((_doc, services) => { services[0]!.env = { FAULT_MODE: value }; }));
      expect(await submit(f, '--run', 'r1', '--check', 'clean'), value).toBe(1);
      expect(entries(f).at(-1)!.shows, value).toMatchObject({ services: [{ service: 'reorder-service', value: shownAs }, { service: 'orders-service', value: '' }] });
    }
  });
});

describe('--set with a folder or a file that is a link or is missing', () => {
  const outside = (): string => {
    const folder = mkdtempSync(join(tmpdir(), 'operator-outside-'));
    roots.push(folder);
    return folder;
  };

  it('refuses the folder of an agent that is a link or is missing, and writes nothing through it', async () => {
    const linked = await faultWorld();
    const real = outside();
    copyFileSync(linked.path(SERVICE), join(real, '.env.order-desk'));
    chmodSync(join(real, '.env.order-desk'), 0o600);
    const before = readFileSync(join(real, '.env.order-desk'), 'utf8');
    rmSync(linked.path('order-desk'), { recursive: true });
    symlinkSync(real, linked.path('order-desk'));
    expect(await submit(linked, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(linked.w.screen.errorText).toContain('order-desk: the folder of the agent is missing or is not a real folder');
    expect(readFileSync(join(real, '.env.order-desk'), 'utf8')).toBe(before);
    const missing = await faultWorld();
    rmSync(missing.path('order-desk'), { recursive: true });
    expect(await submit(missing, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(missing.w.screen.errorText).toContain('order-desk: the folder of the agent is missing or is not a real folder');
  });

  it('refuses an env file that is a link, and does not follow it', async () => {
    const f = await faultWorld();
    const target = join(outside(), 'target.env');
    copyFileSync(f.path(SERVICE), target);
    chmodSync(target, 0o600);
    const before = readFileSync(target, 'utf8');
    rmSync(f.path(SERVICE));
    symlinkSync(target, f.path(SERVICE));
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(2);
    expect(f.w.screen.errorText).toContain(`${SERVICE}: the path of the env file is not a regular file`);
    expect(readFileSync(target, 'utf8')).toBe(before);
  });
});

describe('the status', () => {
  it('shows the value in each file and, with a fresh reading, the running value of each service', async () => {
    const f = await faultWorld({ go: false });
    expect(await f.w.run(task, 'status')).toBe(0);
    expect(f.w.screen.lines).toContain(`fault: reorder-agent: ${REORDER}: FAULT_MODE in the file is empty, in the running service reorder-service it is empty (started at ${REORDER_STARTED})`);
    expect(f.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: FAULT_MODE in the file is empty, in the running service orders-service it is empty (started at ${DESK_STARTED})`);
    f.w.writeGo({ tasks: ['fault'] });
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    f.seen(seenDoc((_doc, services) => { services[1]!.env = { FAULT_MODE: ODD }; }));
    f.w.screen.lines.length = 0;
    expect(await f.w.run(task, 'status')).toBe(0);
    expect(f.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: FAULT_MODE in the file is ${FAULT}, in the running service orders-service it is ${PHRASE} (started at ${DESK_STARTED})`);
    expect([...f.w.screen.lines, ...f.w.screen.errors].join('\n')).not.toContain(ODD);
  });

  it('says why there is no running value when the reading is missing or stale, and still shows the files, and exits 0', async () => {
    const missing = await faultWorld({ go: false, seen: null });
    expect(await missing.w.run(task, 'status')).toBe(0);
    expect(missing.w.screen.lines.some((line) => line.startsWith('fault: no fresh reading of the services: seen-services.json does not exist'))).toBe(true);
    expect(missing.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: FAULT_MODE in the file is empty, no reading of container orders-service`);
    const stale = await faultWorld({ go: false, seen: seenDoc(undefined, NOW - 700_000) });
    expect(await stale.w.run(task, 'status')).toBe(0);
    expect(stale.w.screen.lines.some((line) => line.includes('more than 10 minutes old'))).toBe(true);
    const nofile = await faultWorld({ go: false, files: false });
    expect(await nofile.w.run(task, 'status')).toBe(0);
    expect(nofile.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: the file cannot be used (the env file does not exist), in the running service orders-service it is empty (started at ${DESK_STARTED})`);
  });
});

describe('the definition of the task', () => {
  it('needs no key, no chain and no hosted tool, wants the approval of a submit run, takes --agent, --set and --check, and has the one step run', () => {
    const flags = { has: () => false, value: () => undefined };
    expect(task.name).toBe('fault');
    expect(task.needs.keys(USE, flags)).toEqual([]);
    expect(task.needs).toMatchObject({ chain: false, hosted: [], approval: 'submit' });
    expect(task.flags).toEqual([]);
    expect(task.valued).toEqual(['agent', 'set', 'check']);
    expect(task.steps(USE, flags)).toEqual(['run']);
  });

  it('loads by its name through the loader of the pack, which checks the shape of a definition', async () => {
    expect(await loadTask('fault')).toMatchObject({ name: 'fault', flags: [], valued: ['agent', 'set', 'check'], needs: { chain: false, approval: 'submit' } });
  });

  it('has nothing to take back, and changes no file', async () => {
    const f = await faultWorld();
    const before = [text(f, SERVICE), text(f, REORDER)];
    expect(await f.w.run(task, 'cleanup')).toBe(0);
    expect(f.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
    expect([text(f, SERVICE), text(f, REORDER)]).toEqual(before);
    expect(existsSync(join(f.w.stateDir, 'fault.evidence.json'))).toBe(true);
  });
});
