// The task fault, run through the real runner over the real examples of the two service env files (read from deploy/server at test time) and a `seen-services.json` that the tests write the way the
// script that runs the pack does. The guards are the guards of the kit. A check never passes without a fresh and whole reading of every service of the use case.
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { EnvFile } from '../lib/envfile.ts';
import { loadTask } from '../lib/load.ts';
import task from '../tasks/fault.ts';
import USE from '../usecases/inventory-reorder.ts';
import { NOW, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const SERVER = fileURLToPath(new URL('../../../deploy/server/', import.meta.url));
const NAMES = USE.keys.map((key) => key.name);
const SHARED = USE.keys.filter((key) => key.scope === 'shared').map((key) => key.name);
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
function seenDoc(change: (doc: Record<string, unknown>, services: Service[]) => void = () => undefined, generatedAt = NOW - 5 * 60_000): string {
  const services: Service[] = [
    { service: 'reorder-service', kind: 'reorder-agent', container: 'reorder-service', started_at: REORDER_STARTED, env: { FAULT_MODE: '' } },
    { service: 'orders-service', kind: 'order-desk', container: 'orders-service', started_at: DESK_STARTED, env: { FAULT_MODE: '' } },
  ];
  const doc: Record<string, unknown> = { generated_at: iso(generatedAt), services };
  change(doc, services);
  return JSON.stringify(doc);
}

interface FaultWorld { readonly w: TaskWorld; readonly agents: string; path(file: string): string; value(file: string): string | undefined; seen(text: string): void }

interface WorldOptions { readonly go?: boolean; readonly files?: boolean; readonly seen?: string | null }

async function faultWorld(options: WorldOptions = {}): Promise<FaultWorld> {
  const agents = mkdtempSync(join(tmpdir(), 'operator-agents-'));
  roots.push(agents);
  for (const [folder, name] of [['reorder-agent', '.env.reorder-agent'], ['order-desk', '.env.order-desk']] as const) {
    mkdirSync(join(agents, folder), { mode: 0o750 });
    if (options.files !== false) {
      copyFileSync(join(SERVER, `${name}.example`), join(agents, folder, name));
      chmodSync(join(agents, folder, name), 0o600);
    }
  }
  const w = await taskWorld({ keys: NAMES, shared: SHARED, use: USE, env: { OPERATOR_AGENTS_DIR: agents } });
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
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to ${FAULT} (it holds empty now)`);
    expect(f.w.screen.lines).toContain('the service of order-desk reads FAULT_MODE when its container is created: create the service again by the restart rule, after each of its 3 runtimes says free');
    expect(f.w.machine()).toMatchObject({ task: 'fault', mode: 'submit', outcome: 'done', exit: 0, result: { set: [{ agent: 'order-desk', value: FAULT }] } });
    expect(await submit(f, '--agent', 'order-desk', '--set=')).toBe(0);
    expect(f.value(SERVICE)).toBe('');
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to empty (it holds ${FAULT} now)`);
  });

  it('takes the empty value for the Reorder Agent, which has no fault value, and for every agent when no agent is given', async () => {
    const f = await faultWorld();
    expect(await submit(f, '--agent', 'reorder-agent', '--set=')).toBe(0);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${REORDER} already holds empty: no change`);
    expect(f.w.screen.lines).toContain('the service of reorder-agent reads FAULT_MODE when its container is created: create the service again by the restart rule, after each of its 1 runtime says free');
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    f.w.screen.lines.length = 0;
    expect(await submit(f, '--set=')).toBe(0);
    expect(f.value(SERVICE)).toBe('');
    expect(f.value(REORDER)).toBe('');
    expect(f.w.screen.lines).toContain(`set FAULT_MODE in ${SERVICE} to empty (it holds ${FAULT} now)`);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${REORDER} already holds empty: no change`);
    expect(f.w.machine().result).toEqual({ set: [{ agent: 'reorder-agent', value: '' }, { agent: 'order-desk', value: '' }] });
  });

  it('keeps the value when it is the value that the file holds, and writes nothing', async () => {
    const f = await faultWorld();
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    const before = text(f, SERVICE);
    f.w.screen.lines.length = 0;
    expect(await submit(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.screen.lines).toContain(`FAULT_MODE in ${SERVICE} already holds ${FAULT}: no change`);
    expect(f.w.machine().outcome).toBe('done');
  });

  it('shows the line in a dry run and writes nothing', async () => {
    const f = await faultWorld({ go: false });
    const before = text(f, SERVICE);
    expect(await dry(f, '--agent', 'order-desk', '--set', FAULT)).toBe(0);
    expect(text(f, SERVICE)).toBe(before);
    expect(f.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0 });
    expect(f.w.screen.lines).toContain(`would set FAULT_MODE in ${SERVICE} to ${FAULT} (it holds empty now)`);
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
      ['a service named twice', seenDoc((_doc, services) => { services[1]!.service = 'reorder-service'; }), 'names a service twice'],
      ['no service of the kind of the Order Desk', seenDoc((_doc, services) => { services.pop(); }), 'no service of the kind order-desk (the agent order-desk)'],
      ['a service of the kind of the Order Desk that has another kind', seenDoc((_doc, services) => { services[1]!.kind = 'bid-desk'; }), 'no service of the kind order-desk'],
      ['two services of the kind of the Order Desk', seenDoc((_doc, services) => { services.push({ service: 'orders-two', kind: 'order-desk', container: 'orders-two', started_at: DESK_STARTED, env: { FAULT_MODE: '' } }); }), '2 services of the kind order-desk'],
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
    expect(missing.w.screen.lines).toContain(`fault: order-desk: ${SERVICE}: FAULT_MODE in the file is empty`);
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
