// scripts/operator/test/allowlist.test.ts - the task `allowlist` through the real runner, over a temporary agents folder that holds the text of the real example file of the Reorder Agent as its env
// file. The task adds a key hash to the line COSIGN_ALLOWLIST. Each refusal has an accepted twin: a run that adds a key, and a run that stops with the file as it was.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAllowlist } from '../lib/platform.ts';
import allowlist from '../tasks/allowlist.ts';
import data from '../usecases/inventory-reorder.ts';
import { taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const KEY_A = 'ab'.repeat(28);
const KEY_B = 'cd'.repeat(28);
const KEY_C = 'ef'.repeat(28);
const KEY_D = '12'.repeat(28);
const VARIABLE = 'COSIGN_ALLOWLIST';
const EXAMPLE = readFileSync(fileURLToPath(new URL('../../../deploy/server/.env.reorder-agent.example', import.meta.url)), 'utf8');

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface Rig {
  readonly world: TaskWorld;
  /** The folder of the agents, and the env file of the Reorder Agent in it. */
  readonly agentsDir: string;
  readonly file: string;
  read(): string;
  /** The list of the file as the kit reads it. */
  keys(): string[];
  /** What the run wrote to its error stream: the text of a refusal. */
  errors(): string;
}

/** A world over the data of the pack, with an agents folder whose env file for the Reorder Agent is `text` (the example by default), or no env file when `text` is null. */
async function rig(text: string | null = EXAMPLE, mode = 0o644): Promise<Rig> {
  const agentsDir = mkdtempSync(join(tmpdir(), 'operator-agents-'));
  roots.push(agentsDir);
  const folder = join(agentsDir, 'reorder-agent');
  mkdirSync(folder, { recursive: true });
  const file = join(folder, '.env.reorder-agent');
  if (text !== null) {
    writeFileSync(file, text, { mode });
    chmodSync(file, mode);
  }
  const world = await taskWorld({ keys: ['run', 'fee'], use: { agents: data.agents }, env: { OPERATOR_AGENTS_DIR: agentsDir } });
  const read = (): string => readFileSync(file, 'utf8');
  const keys = (): string[] => {
    const line = read().split('\n').find((row) => row.startsWith(`${VARIABLE}=`));
    const parsed = parseAllowlist((line ?? '').slice(VARIABLE.length + 1));
    if (!parsed.ok) throw new Error('the list of the file is not a list that the kit reads');
    return parsed.value.keys();
  };
  return { world, agentsDir, file, read, keys, errors: () => world.screen.errors.join('\n') };
}

const approve = (r: Rig): string => r.world.writeGo({ tasks: ['allowlist'], capUnits: 0 });

/** The text of the file with the line of the list set to `value`. */
const withList = (value: string): string => EXAMPLE.split('\n').map((row) => (row.startsWith(`${VARIABLE}=`) ? `${VARIABLE}=${value}` : row)).join('\n');

/** The temporary files of the editor that a folder holds. A run must leave none. */
const leftovers = (r: Rig): string[] => readdirSync(join(r.agentsDir, 'reorder-agent')).filter((name) => name !== '.env.reorder-agent');

describe('the example file that the tests start from', () => {
  it('has the line COSIGN_ALLOWLIST once, and it is empty, so nobody is on the list', () => {
    expect(EXAMPLE.split('\n').filter((row) => row.startsWith(`${VARIABLE}=`))).toEqual([`${VARIABLE}=`]);
  });
});

describe('the task allowlist: add', () => {
  it('adds a key to the empty list of the example: the line holds the key, each other line is as it was, the mode is 600, and the result names the agent, the key and the count', async () => {
    const r = await rig();
    approve(r);
    expect(await r.world.run(allowlist, 'run', '--submit', '--key', KEY_A)).toBe(0);
    expect(r.read()).toBe(withList(KEY_A));
    expect(r.keys()).toEqual([KEY_A]);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
    expect(leftovers(r)).toEqual([]);
    expect(r.world.machine()).toMatchObject({ task: 'allowlist', command: 'run', mode: 'submit', outcome: 'done', exit: 0, result: { agent: 'reorder-agent', key: KEY_A, added: true, keys: 1 } });
    expect(r.world.screen.lines.join('\n')).toMatch(/restart rule/);
  });

  it('adds a second key to a list that holds one: the line holds both keys, joined by commas, in the order of the list', async () => {
    const r = await rig(withList(KEY_A));
    approve(r);
    expect(await r.world.run(allowlist, 'run', '--submit', '--key', KEY_B)).toBe(0);
    expect(r.read()).toBe(withList(`${KEY_A},${KEY_B}`));
    expect(r.keys()).toEqual([KEY_A, KEY_B]);
    expect(r.world.machine().result).toMatchObject({ added: true, keys: 2 });
  });

  it('never drops an entry: a list of three keys that is written with commas and spaces keeps each key and the new key, and the line has commas only', async () => {
    const r = await rig(withList(`"${KEY_A} ${KEY_B},${KEY_C}"`));
    approve(r);
    expect(await r.world.run(allowlist, 'run', '--submit', '--key', KEY_D)).toBe(0);
    expect(r.keys()).toEqual([KEY_A, KEY_B, KEY_C, KEY_D]);
    expect(r.read()).toBe(withList([KEY_A, KEY_B, KEY_C, KEY_D].join(',')));
    expect(r.read()).not.toContain(' #');
  });

  it('writes a line that the kit reads back with the same keys, and no other line of the file changes', async () => {
    const r = await rig(withList(`${KEY_A},${KEY_B}`));
    approve(r);
    const before = r.read().split('\n');
    expect(await r.world.run(allowlist, 'run', '--submit', '--key', KEY_C)).toBe(0);
    const after = r.read().split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.flatMap((row, index) => (row === before[index] ? [] : [index]));
    expect(changed).toHaveLength(1);
    expect(after[changed[0]!]).toBe(`${VARIABLE}=${KEY_A},${KEY_B},${KEY_C}`);
  });

  it('does nothing for a key that is on the list: the answer says so, the file is not written, and the count does not change', async () => {
    const text = withList(`${KEY_A},${KEY_B}`);
    const r = await rig(text);
    approve(r);
    expect(await r.world.run(allowlist, 'run', '--submit', '--key', KEY_B)).toBe(0);
    expect(r.read()).toBe(text);
    expect(statSync(r.file).mode & 0o777).toBe(0o644);
    expect(leftovers(r)).toEqual([]);
    expect(r.world.screen.lines.join('\n')).toMatch(/is on the allowlist of the agent reorder-agent already/);
    expect(r.world.machine().result).toMatchObject({ added: false, keys: 2, key: KEY_B });
  });

  it('shows the new line in a dry run, needs no approval, and writes nothing', async () => {
    const text = withList(KEY_A);
    const r = await rig(text);
    expect(await r.world.run(allowlist, 'run', '--key', KEY_B)).toBe(0);
    expect(r.read()).toBe(text);
    expect(leftovers(r)).toEqual([]);
    expect(r.world.screen.lines.join('\n')).toContain(`${VARIABLE}=${KEY_A},${KEY_B}`);
    expect(r.world.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', exit: 0 });
    expect(existsSync(r.world.goPath)).toBe(false);
  });
});

describe('the task allowlist: what stops it', () => {
  const stopped = (r: Rig, ...argv: string[]): Promise<number> => r.world.run(allowlist, ...argv);

  it('refuses a key that is no key hash, in a dry run and in a submit run, and writes nothing', async () => {
    const r = await rig();
    approve(r);
    for (const bad of [KEY_A.toUpperCase(), KEY_A.slice(1), `${KEY_A}0`, `${KEY_A.slice(0, 55)}g`, 'zz-not-hex']) {
      for (const mode of [[], ['--submit']]) {
        expect(await stopped(r, 'run', ...mode, '--key', bad), bad).toBe(2);
        expect(r.world.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
        expect(r.world.allText()).not.toContain(bad);
      }
    }
    expect(r.read()).toBe(EXAMPLE);
    expect(r.keys()).toEqual([]);
  });

  it('refuses a run with no key, and adds the key of the accepted twin', async () => {
    const r = await rig();
    approve(r);
    expect(await stopped(r, 'run', '--submit')).toBe(2);
    expect(r.errors()).toMatch(/give --key/);
    expect(r.read()).toBe(EXAMPLE);
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(0);
    expect(r.keys()).toEqual([KEY_A]);
  });

  it('refuses a missing env file, and makes none', async () => {
    const r = await rig(null);
    approve(r);
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(2);
    expect(r.errors()).toMatch(/env file does not exist/);
    expect(existsSync(r.file)).toBe(false);
    expect(leftovers(r)).toEqual([]);
  });

  it('refuses an env file with no line COSIGN_ALLOWLIST, and leaves it as it was', async () => {
    const text = EXAMPLE.split('\n').filter((row) => !row.startsWith(`${VARIABLE}=`)).join('\n');
    const r = await rig(text);
    approve(r);
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(2);
    expect(r.errors()).toMatch(/has no line COSIGN_ALLOWLIST/);
    expect(r.read()).toBe(text);
  });

  it('refuses a line that the kit cannot read, and leaves it as it was: the task never writes over a list that it cannot read', async () => {
    const text = withList(`${KEY_A},notakey`);
    const r = await rig(text);
    approve(r);
    expect(await stopped(r, 'run', '--submit', '--key', KEY_B)).toBe(2);
    expect(r.read()).toBe(text);
    expect(r.world.allText()).not.toContain('notakey');
  });

  it('refuses an agent without a co-sign route and an agent that the use case does not have, and takes the Reorder Agent by name', async () => {
    const r = await rig();
    approve(r);
    expect(await stopped(r, 'run', '--submit', '--agent', 'order-desk', '--key', KEY_A)).toBe(2);
    expect(r.errors()).toMatch(/has no co-sign route/);
    expect(await stopped(r, 'run', '--submit', '--agent', 'nobody', '--key', KEY_A)).toBe(2);
    expect(r.read()).toBe(EXAMPLE);
    expect(await stopped(r, 'run', '--submit', '--agent', 'reorder-agent', '--key', KEY_A)).toBe(0);
    expect(r.keys()).toEqual([KEY_A]);
  });

  it('refuses a submit run without an approval that lists the task, and adds the key with one', async () => {
    const r = await rig();
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(2);
    expect(r.read()).toBe(EXAMPLE);
    r.world.writeGo({ tasks: ['fund'], capUnits: 0 });
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(2);
    expect(r.read()).toBe(EXAMPLE);
    approve(r);
    expect(await stopped(r, 'run', '--submit', '--key', KEY_A)).toBe(0);
    expect(r.keys()).toEqual([KEY_A]);
  });

  it('refuses a use case with no agent that has a co-sign route', async () => {
    const r = await rig();
    const noRoute = await taskWorld({ keys: ['run', 'fee'], use: { agents: data.agents.map((agent) => ({ ...agent, cosign: false })) }, env: { OPERATOR_AGENTS_DIR: r.agentsDir } });
    expect(await noRoute.run(allowlist, 'run', '--key', KEY_A)).toBe(2);
    expect(r.read()).toBe(EXAMPLE);
  });
});

describe('the task allowlist: status and cleanup', () => {
  it('shows the count and the keys, and shows no other line of the file', async () => {
    const r = await rig(withList(`${KEY_A},${KEY_B}`));
    expect(await r.world.run(allowlist, 'status')).toBe(0);
    const text = r.world.screen.lines.join('\n');
    expect(text).toContain('the allowlist of the agent reorder-agent: 2 key(s)');
    expect(text).toContain(`  ${KEY_A}`);
    expect(text).toContain(`  ${KEY_B}`);
    // `status` takes no flag but --run and --use-case: it cannot ask about a key, and a dry run of `run --key` says whether a key is on the list.
    expect(await r.world.run(allowlist, 'status', '--key', KEY_C)).toBe(2);
    expect(await r.world.run(allowlist, 'run', '--key', KEY_B)).toBe(0);
    expect(r.world.screen.lines.join('\n')).toContain(`the key ${KEY_B} is on the allowlist of the agent reorder-agent already`);
    // No other line of the file reaches the screen: each variable line with a value, except the list, is absent.
    const others = EXAMPLE.split('\n').filter((row) => /^[A-Z][A-Z0-9_]*=.+$/.test(row) && !row.startsWith(`${VARIABLE}=`));
    expect(others.length).toBeGreaterThan(10);
    for (const row of others) expect(r.world.allText(), row).not.toContain(row);
    expect(r.read()).toBe(withList(`${KEY_A},${KEY_B}`));
  });

  it('shows the count of an empty list, and takes no key', async () => {
    const r = await rig();
    expect(await r.world.run(allowlist, 'status')).toBe(0);
    expect(r.world.screen.lines.join('\n')).toContain('the allowlist of the agent reorder-agent: 0 key(s)');
  });

  it('stops a status of a file that is not there', async () => {
    const r = await rig(null);
    expect(await r.world.run(allowlist, 'status')).toBe(2);
  });

  it('has nothing to take back, and writes nothing', async () => {
    const text = withList(KEY_A);
    const r = await rig(text);
    approve(r);
    expect(await r.world.run(allowlist, 'cleanup', '--submit')).toBe(0);
    expect(r.read()).toBe(text);
    expect(r.world.screen.lines.join('\n')).toMatch(/nothing to take back/);
  });
});
