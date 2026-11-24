// scripts/operator/test/results.test.ts - the task `results` through the real runner, over made-up evidence files in a temporary state folder: two runs, one step that did not run. The page equals
// its golden file byte for byte. A step is shown only with a reference. The header file comes first and verbatim, and it is refused above 8 KiB. A dry run writes nothing. No test uses the network.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import results, { EXPLORER_TX, HEADER_LIMIT_BYTES, PAGE_TEXT, SHOWS, parseEvidence, renderPage } from '../tasks/results.ts';
import data from '../usecases/inventory-reorder.ts';
import type { UseCase } from '../lib/contract.ts';
import { hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';
import { KEY_TEXT } from './support/secrets.ts';

const GOLDEN = fileURLToPath(new URL('./golden/results-page.md', import.meta.url));
const HEADER = 'Results for a made-up group of the tests\nDate of the page: 2026-12-05\n';
const CLEAN = '2026-12-01-reorder-agent-run-1';
const FAILURE = 'r2';
const NOTE = 'The jury has no verdict yet.';

const tx = (name: string): string => hashOf(`results tx ${name}`);

interface StepInput { id: string; status: 'shown' | 'not_run'; refs: unknown[]; note?: string }

/** The refs of a step of the clean run: one transaction, and two or three references of other kinds where a step has them. */
function cleanRefs(id: string): unknown[] {
  if (id === 'r1-01') return [tx('r1-01'), { kind: 'delegation', value: hashOf('delegation id') }];
  if (id === 'r1-03') return [tx('post'), `${tx('post')}#0`, tx('accept')];
  return [tx(id)];
}

const cleanSteps = (): StepInput[] => data.evidenceSteps.filter((step) => step.run !== 'failure').map((step) => ({ id: step.id, status: 'shown' as const, refs: cleanRefs(step.id) }));

/** The failure run: step d did not run, and step h has a labelled transaction and a labelled case. */
const failureSteps = (): StepInput[] => data.evidenceSteps.filter((step) => step.run === 'failure').map((step): StepInput => {
  if (step.id === 'r2-d') return { id: step.id, status: 'not_run', refs: [], note: NOTE };
  return { id: step.id, status: 'shown', refs: step.id === 'r2-h' ? [{ kind: 'transaction', value: tx(step.id) }, { kind: 'case', value: `${tx('case')}#0` }] : [tx(step.id)] };
});

/** An evidence file as the assembler writes it, with members that the page never reads. */
const doc = (kind: 'clean' | 'failure', date: string, steps: unknown, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  run: `use-case-1-${kind}`, kind, date, capability_id: 'supplychain.reorder.po.v1', builder: 'https://hosted.test/mcp', result: 'a text that the page never reads', hires: [{ step: 'propose' }], steps, ...over,
});

const cleanDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => doc('clean', '2026-12-01', cleanSteps(), over);
const failureDoc = (over: Record<string, unknown> = {}): Record<string, unknown> => doc('failure', '2026-12-03', failureSteps(), { audience: 'private', ...over });

/** True for a reference that has a kind and a value, as the evidence files label one. */
const isLabelled = (ref: unknown): ref is { kind: string; value: string } => typeof ref === 'object' && ref !== null && 'kind' in ref && 'value' in ref && typeof ref.kind === 'string' && typeof ref.value === 'string';

interface Rig {
  readonly world: TaskWorld;
  readonly header: string;
  readonly pagePath: string;
  /** Writes an evidence file and gives its path. */
  put(folder: 'public' | 'private', label: string, value: unknown): string;
  /** Writes the two files of the golden page. */
  seed(): void;
  run(...argv: string[]): Promise<number>;
  page(): string;
}

async function makeRig(over: Partial<UseCase> = {}): Promise<Rig> {
  const world = await taskWorld({ keys: ['run', 'fee'], use: { title: data.title, runs: data.runs, evidenceSteps: data.evidenceSteps, ...over } });
  mkdirSync(world.stateDir, { recursive: true, mode: 0o700 });
  chmodSync(world.stateDir, 0o700);
  const header = join(world.dir, 'header.txt');
  writeFileSync(header, HEADER);
  const put = (folder: 'public' | 'private', label: string, value: unknown): string => {
    const dir = folder === 'public' ? join(world.stateDir, 'evidence') : join(world.stateDir, 'evidence', 'private');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${label}.json`);
    writeFileSync(path, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
    return path;
  };
  const pagePath = join(world.stateDir, 'results', 'inventory-reorder.md');
  return {
    world, header, pagePath, put,
    seed: () => { put('public', CLEAN, cleanDoc()); put('private', FAILURE, failureDoc()); },
    run: (...argv) => world.run(results, ...argv),
    page: () => readFileSync(pagePath, 'utf8'),
  };
}

/** The row of a step in a page: its cells, with the pipes that were escaped put back. */
function rowOf(page: string, id: string): string[] {
  const line = page.split('\n').find((text) => text.startsWith(`| ${id} |`));
  if (line === undefined) throw new Error(`the page has no row for ${id}`);
  return line.slice(2, -2).split(' | ');
}

const NO_ARGUMENTS = (rig: Rig): string[] => ['--header-file', rig.header];

describe('the task results', () => {
  it('needs no key, no chain, no hosted tool and no approval, and has one step and two valued flags', () => {
    expect(results.name).toBe('results');
    expect(results.needs.keys(data, { has: () => false, value: () => undefined })).toEqual([]);
    expect(results.needs.chain).toBe(false);
    expect(results.needs.hosted).toEqual([]);
    expect(results.needs.approval).toBe('never');
    expect(results.steps(data, { has: () => false, value: () => undefined })).toEqual(['run']);
    expect(results.flags).toEqual([]);
    expect([...results.valued].sort()).toEqual(['header-file', 'runs']);
  });

  it('writes the page of two runs, with one step that did not run, and the page equals its golden file byte for byte', async () => {
    const rig = await makeRig();
    rig.seed();
    expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`, '--submit')).toBe(0);
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(GOLDEN, rig.page());
    expect(rig.page()).toBe(readFileSync(GOLDEN, 'utf8'));
    const line = rig.world.machine();
    expect(line).toMatchObject({ task: 'results', command: 'run', mode: 'submit', outcome: 'done', exit: 0, step: 'run' });
    expect(line.result).toMatchObject({ labels: [CLEAN, FAILURE], file: join('results', 'inventory-reorder.md'), written: true, bytes: Buffer.byteLength(rig.page(), 'utf8') });
  });

  it('puts the text of the header file first and verbatim, whatever its ending, and never changes it', async () => {
    const texts = [HEADER, 'A name with no line end', 'First line\r\nSecond line, with accents: \u00e4\u00f6\u00fc\r\n', 'A line\n\n\nand two empty lines before the end\n\n'];
    for (const text of texts) {
      const rig = await makeRig();
      rig.seed();
      writeFileSync(rig.header, text);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(rig.page().startsWith(text)).toBe(true);
      expect(rig.page().slice(text.length).startsWith(`${text.endsWith('\n') ? '\n' : '\n\n'}# `)).toBe(true);
      expect(rig.page().slice(text.length)).not.toContain(text.trim());
    }
  });

  it('prints the page and writes no file in a dry run, and writes the same page with --submit: mode 600 in a folder of mode 700', async () => {
    const rig = await makeRig();
    rig.seed();
    expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`)).toBe(0);
    expect(existsSync(join(rig.world.stateDir, 'results'))).toBe(false);
    const golden = readFileSync(GOLDEN, 'utf8');
    expect(rig.world.screen.text).toContain(golden.slice(0, -1));
    expect(rig.world.machine()).toMatchObject({ mode: 'dry', outcome: 'done', exit: 0, result: { written: false } });
    expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`, '--submit')).toBe(0);
    expect(rig.page()).toBe(golden);
    expect(statSync(rig.pagePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(rig.world.stateDir, 'results')).mode & 0o777).toBe(0o700);
    expect(rig.world.machine().result).toMatchObject({ written: true });
  });

  it('can run again: the step is not recorded, and a later evidence file changes the page', async () => {
    const rig = await makeRig();
    rig.put('public', CLEAN, cleanDoc());
    expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
    const first = rig.page();
    rig.put('private', FAILURE, failureDoc());
    expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`, '--submit')).toBe(0);
    expect(rig.page()).not.toBe(first);
    expect(rig.page()).toContain('## Run r2: failure, 2026-12-03');
    expect(rig.world.state('results').steps).toEqual({});
  });

  describe('a step and its reference', () => {
    const use = { title: data.title, evidenceSteps: data.evidenceSteps };
    const runOf = (steps: unknown[]) => parseEvidence(doc('clean', '2026-12-01', steps), 'x', data);
    const shown = (id: string, refs: unknown[]): unknown => ({ id, status: 'shown', refs });

    it('writes a step that has a reference as shown, with the two sentences of its primitive', () => {
      const page = renderPage({ header: HEADER, use, runs: [runOf([shown('r1-02', [tx('vault')])])] });
      const row = rowOf(page, 'r1-02');
      expect(row[3]).toBe(`[\`${tx('vault')}\`](${EXPLORER_TX}${tx('vault')})`);
      expect(row[4]).toBe(SHOWS['Vault']!.shows);
      expect(row[5]).toBe(SHOWS['Vault']!.doesNotShow);
    });

    it('never writes a step as shown when the evidence has no reference for it', () => {
      const page = renderPage({ header: HEADER, use, runs: [runOf([shown('r1-02', [])])] });
      const row = rowOf(page, 'r1-02');
      expect(row[3]).toBe(PAGE_TEXT.none);
      expect(row[4]).toBe(PAGE_TEXT.noReference);
      expect(row[4]).not.toBe(SHOWS['Vault']!.shows);
      expect(row[5]).toBe(PAGE_TEXT.wholeStep);
      expect(page).not.toContain(SHOWS['Vault']!.shows);
    });

    it('writes a step that did not run as not run, with its reason and no reference', () => {
      const page = renderPage({ header: HEADER, use, runs: [runOf([{ id: 'r1-02', status: 'not_run', refs: [], note: 'The member did not open a vault.' }])] });
      const row = rowOf(page, 'r1-02');
      expect(row[3]).toBe(PAGE_TEXT.none);
      expect(row[4]).toBe(`${PAGE_TEXT.notRun} The member did not open a vault.`);
      expect(page).not.toContain(SHOWS['Vault']!.shows);
    });

    it('gives no reference to a step that did not run, even when the evidence holds one, and says when it has no reason', () => {
      const page = renderPage({ header: HEADER, use, runs: [runOf([{ id: 'r1-02', status: 'not_run', refs: [tx('vault')] }])] });
      const row = rowOf(page, 'r1-02');
      expect(row[3]).toBe(PAGE_TEXT.none);
      expect(row[4]).toBe(`${PAGE_TEXT.notRun} ${PAGE_TEXT.noReason}`);
      expect(page).not.toContain(tx('vault'));
    });

    it('says that a step has no entry when the evidence file leaves it out, and still writes one row for each step of the kind', () => {
      const page = renderPage({ header: HEADER, use, runs: [runOf([shown('r1-02', [tx('vault')])])] });
      expect(rowOf(page, 'r1-01')[4]).toBe(`${PAGE_TEXT.notRun} ${PAGE_TEXT.noEntry}`);
      const ids = page.split('\n').filter((line) => /^\| r\d-/.test(line)).map((line) => line.split(' | ')[0]!.slice(2));
      expect(ids).toEqual(data.evidenceSteps.filter((step) => step.run !== 'failure').map((step) => step.id));
    });

    it('makes a link of each transaction hash, and shows another reference as text, with its kind when it has one', () => {
      const page = renderPage({
        header: HEADER, use,
        runs: [runOf([shown('r1-03', [tx('a'), `${tx('a')}#0`, { kind: 'transaction', value: tx('b') }, { kind: 'delegation', value: hashOf('d') }, 'did:vector:abc'])])],
      });
      const refs = rowOf(page, 'r1-03')[3]!.split('; ');
      expect(refs).toEqual([
        `[\`${tx('a')}\`](${EXPLORER_TX}${tx('a')})`, `\`${tx('a')}#0\``, `[\`${tx('b')}\`](${EXPLORER_TX}${tx('b')})`, `delegation \`${hashOf('d')}\``, '`did:vector:abc`',
      ]);
    });

    it('writes the rows of a kind from the data and no others, in the order of the data', () => {
      const failure = parseEvidence(failureDoc(), 'x', data);
      const page = renderPage({ header: HEADER, use, runs: [failure] });
      const ids = page.split('\n').filter((line) => /^\| r\d-/.test(line)).map((line) => line.split(' | ')[0]!.slice(2));
      expect(ids).toEqual(data.evidenceSteps.filter((step) => step.run !== 'clean').map((step) => step.id));
    });
  });

  describe('the runs of a page', () => {
    it('refuses a label that has no evidence file, writes nothing, and writes a page for a label that has one', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},nope`, '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('there is no evidence file for the label nope');
      expect(existsSync(rig.pagePath)).toBe(false);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', CLEAN, '--submit')).toBe(0);
      expect(rig.page()).toContain(`## Run ${CLEAN}: clean, 2026-12-01`);
      expect(rig.page()).not.toContain('## Run r2');
    });

    it('takes the public labels by default, in the order of the dates, and the labels of --runs in the order that they are given', async () => {
      const rig = await makeRig();
      rig.put('public', '2026-12-09-reorder-agent-run-3', doc('failure', '2026-12-09', failureSteps()));
      rig.put('public', '2026-11-30-reorder-agent-run-0', doc('clean', '2026-11-30', cleanSteps()));
      rig.put('public', CLEAN, cleanDoc());
      const headings = (): string[] => rig.page().split('\n').filter((line) => line.startsWith('## Run ')).map((line) => line.split(':')[0]!);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(headings()).toEqual(['## Run 2026-11-30-reorder-agent-run-0', `## Run ${CLEAN}`, '## Run 2026-12-09-reorder-agent-run-3']);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `2026-12-09-reorder-agent-run-3,${CLEAN}`, '--submit')).toBe(0);
      expect(headings()).toEqual(['## Run 2026-12-09-reorder-agent-run-3', `## Run ${CLEAN}`]);
    });

    it('takes a private label only when --runs names it, and stops when only private files exist and no label is named (RP5)', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(rig.page()).toContain(`## Run ${CLEAN}`);
      expect(rig.page()).not.toContain('## Run r2');
      expect(rig.page()).not.toContain(NOTE);
      expect(rig.world.machine().result).toMatchObject({ labels: [CLEAN] });
      expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`, '--submit')).toBe(0);
      expect(rig.page()).toContain('## Run r2: failure, 2026-12-03');
      expect(rig.page()).toContain(NOTE);
      const privateOnly = await makeRig();
      privateOnly.put('private', FAILURE, failureDoc());
      expect(await privateOnly.run(...NO_ARGUMENTS(privateOnly), '--submit')).toBe(2);
      expect(privateOnly.world.screen.errorText).toContain('there is no public evidence file');
      expect(existsSync(privateOnly.pagePath)).toBe(false);
      expect(await privateOnly.run(...NO_ARGUMENTS(privateOnly), '--runs', FAILURE, '--submit')).toBe(0);
    });

    it('refuses a list that is no list of labels: an empty item, a label twice, a bad label, an empty value, and too many', async () => {
      const rig = await makeRig();
      rig.seed();
      const labels = Array.from({ length: 17 }, (_, index) => `l${index}`).join(',');
      for (const list of [`${CLEAN},`, `,${CLEAN}`, `${CLEAN},${CLEAN}`, 'Upper', 'under_score', `${'a'.repeat(33)}`, '', labels]) {
        const arg = list === '' ? '--runs=' : `--runs=${list}`;
        expect(await rig.run(...NO_ARGUMENTS(rig), arg, '--submit'), list).toBe(2);
      }
      expect(existsSync(rig.pagePath)).toBe(false);
      expect(await rig.run(...NO_ARGUMENTS(rig), `--runs=${CLEAN},${FAILURE}`, '--submit')).toBe(0);
    });

    it('stops with exit 2 when there is no evidence file at all', async () => {
      const rig = await makeRig();
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('there is no public evidence file');
      expect(existsSync(rig.pagePath)).toBe(false);
    });

    it('refuses two files with one label, a name that is no label, and a link, and skips the hidden and temporary files', async () => {
      const rig = await makeRig();
      rig.seed();
      rig.put('public', '.hidden', 'not json at all');
      writeFileSync(join(rig.world.stateDir, 'evidence', `${CLEAN}.json.tmp`), 'not json at all');
      writeFileSync(join(rig.world.stateDir, 'evidence', 'notes.txt'), 'not json at all');
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      rig.put('private', CLEAN, cleanDoc());
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain(`two evidence files have the label ${CLEAN}`);
      const other = await makeRig();
      other.seed();
      other.put('public', 'Bad_Name', cleanDoc());
      expect(await other.run(...NO_ARGUMENTS(other), '--submit')).toBe(2);
      expect(other.world.screen.errorText).toContain('is no label');
      const linked = await makeRig();
      linked.seed();
      symlinkSync(join(linked.world.stateDir, 'evidence', `${CLEAN}.json`), join(linked.world.stateDir, 'evidence', 'linked.json'));
      expect(await linked.run(...NO_ARGUMENTS(linked), '--submit')).toBe(2);
      expect(linked.world.screen.errorText).toContain('not a regular file');
    });
  });

  describe('the header file', () => {
    it('is required: a run without --header-file, with an empty value, or with a file that is not there stops with exit 2', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run('--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('--header-file is required');
      expect(await rig.run('--header-file=', '--submit')).toBe(2);
      expect(await rig.run('--header-file', join(rig.world.dir, 'absent.txt'), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('the header file cannot be read');
      expect(existsSync(rig.pagePath)).toBe(false);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
    });

    it('is refused above 8 KiB, and a file of exactly 8 KiB passes', async () => {
      const rig = await makeRig();
      rig.seed();
      writeFileSync(rig.header, `${'x'.repeat(HEADER_LIMIT_BYTES - 1)}\n`);
      expect(statSync(rig.header).size).toBe(8192);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      writeFileSync(rig.header, `${'x'.repeat(HEADER_LIMIT_BYTES)}\n`);
      expect(statSync(rig.header).size).toBe(8193);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('the header file is larger than 8192 bytes');
      expect(rig.world.screen.errorText).not.toContain('xxxxxxxx');
    });

    it('is refused when it is a folder, a link, no UTF-8 text, text with a NUL character, blank, or text with a mark of a secret', async () => {
      const rig = await makeRig();
      rig.seed();
      const refused = async (message: string): Promise<void> => {
        expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
        expect(rig.world.screen.errorText).toContain(message);
        expect(existsSync(rig.pagePath)).toBe(false);
      };
      const real = join(rig.world.dir, 'real.txt');
      writeFileSync(real, HEADER);
      rig.world.screen.errors.length = 0;
      writeFileSync(rig.header, Buffer.from([0x52, 0xff, 0xfe, 0x0a]));
      await refused('is not UTF-8 text');
      writeFileSync(rig.header, 'a\0b\n');
      await refused('NUL character');
      writeFileSync(rig.header, ' \n\t\n');
      await refused('holds no text');
      writeFileSync(rig.header, `Group\n${KEY_TEXT}\n`);
      await refused('mark of a secret');
      expect(rig.world.screen.text).not.toContain(KEY_TEXT);
      expect(await rig.run('--header-file', join(rig.world.dir), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('not a regular file');
      const link = join(rig.world.dir, 'link.txt');
      symlinkSync(real, link);
      expect(await rig.run('--header-file', link, '--submit')).toBe(2);
      expect(await rig.run('--header-file', real, '--submit')).toBe(0);
    });

    it('is refused when it is a file of the key folder, by its real path and also through a link to the folder, and the same text outside the folder passes (RP1)', async () => {
      const rig = await makeRig();
      rig.seed();
      const root = rig.world.keys.root;
      writeFileSync(join(root, 'header.txt'), HEADER);
      const folderLink = join(rig.world.dir, 'keys-link');
      symlinkSync(root, folderLink);
      for (const path of [join(root, 'header.txt'), join(root, 'shared', 'fee.seed'), join(folderLink, 'header.txt'), join(folderLink, 'shared', 'fee.seed')]) {
        expect(await rig.run('--header-file', path, '--submit'), path).toBe(2);
        expect(rig.world.screen.errorText).toContain('the header file is inside the key folder');
      }
      expect(existsSync(rig.pagePath)).toBe(false);
      expect(rig.world.screen.text).not.toContain(rig.world.keys.seedOf('fee'));
      expect(rig.world.screen.errorText).not.toContain(rig.world.keys.seedOf('fee'));
      expect(rig.world.screen.text).not.toContain(HEADER.split('\n')[0]!);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
    });

    it('is refused when its text holds 40 or more hex characters in a row, and a text with 39 passes (RP2)', async () => {
      const rig = await makeRig();
      rig.seed();
      const refused = [`MOCK_OPERATOR_TOKEN=${'ab'.repeat(32)}\n`, `Group ${'0'.repeat(40)}\n`, `${'F'.repeat(64)}\n`];
      for (const text of refused) {
        writeFileSync(rig.header, text);
        expect(await rig.run(...NO_ARGUMENTS(rig), '--submit'), text).toBe(2);
        expect(rig.world.screen.errorText).toContain('40 or more hex characters in a row');
        expect(rig.world.screen.text).not.toContain(text.trim());
        expect(rig.world.screen.errorText).not.toContain(text.trim());
        expect(existsSync(rig.pagePath)).toBe(false);
      }
      for (const text of [`Group ${'0'.repeat(39)}\n`, `${'ab'.repeat(19)}-${'cd'.repeat(19)}\n`]) {
        writeFileSync(rig.header, text);
        expect(await rig.run(...NO_ARGUMENTS(rig), '--submit'), text).toBe(0);
      }
    });
  });

  describe('an evidence file that is not usable', () => {
    const FILE_BROKEN: Array<[string, (value: Record<string, unknown>) => unknown, string]> = [
      ['a JSON value that is no object', () => ['x'], 'it is not a JSON object'],
      ['a kind that no run has', (value) => ({ ...value, kind: 'unknown-kind' }), 'kind is not the id of a run'],
      ['no kind', ({ kind: _kind, ...rest }) => rest, 'kind is not the id of a run'],
      ['a date that is no date', (value) => ({ ...value, date: '2026-13-45' }), 'date is not a date'],
      ['a date with a time', (value) => ({ ...value, date: '2026-12-01T10:00:00Z' }), 'date is not a date'],
      ['steps that are no list', (value) => ({ ...value, steps: {} }), 'steps is not a list'],
      ['a step that is no object', (value) => ({ ...value, steps: ['r1-01'] }), 'steps[0] is not an object'],
      ['a step id that is no id', (value) => ({ ...value, steps: [{ id: 'R1 01', status: 'shown', refs: [tx('x')] }] }), 'is not a step id'],
      ['a step that the data does not know', (value) => ({ ...value, steps: [{ id: 'r9-99', status: 'shown', refs: [tx('x')] }] }), 'is not a step of a run of this kind'],
      ['a step of the other kind', (value) => ({ ...value, steps: [{ id: 'r2-a', status: 'shown', refs: [tx('x')] }] }), 'is not a step of a run of this kind'],
      ['a step twice', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: [tx('x')] }, { id: 'r1-01', status: 'shown', refs: [tx('y')] }] }), 'repeats a step'],
      ['a status that is neither shown nor not_run', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'done', refs: [tx('x')] }] }), 'neither shown nor not_run'],
      ['refs that are no list', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: tx('x') }] }), 'refs is not a list'],
      ['too many refs', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: Array.from({ length: 33 }, (_, index) => tx(`r${index}`)) }] }), 'refs is not a list'],
      ['a reference that is a number', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: [7] }] }), 'no reference'],
      ['a reference with a space', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: ['a b'] }] }), 'no reference'],
      ['a labelled reference with a third member', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: [{ kind: 'escrow', value: tx('x'), more: 1 }] }] }), 'no reference'],
      ['a labelled transaction that is no hash', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: [{ kind: 'transaction', value: 'abc' }] }] }), 'no reference'],
      ['a note that is no text', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'not_run', refs: [], note: 7 }] }), 'note is not a text'],
      ['a note that is too long', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'not_run', refs: [], note: 'x'.repeat(2001) }] }), 'note is not a text'],
      ['a note with a mark of a secret', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'not_run', refs: [], note: `see ${KEY_TEXT}` }] }), 'mark of a secret'],
      ['a reference with a mark of a secret', (value) => ({ ...value, steps: [{ id: 'r1-01', status: 'shown', refs: [{ kind: 'escrow', value: KEY_TEXT }] }] }), 'mark of a secret'],
    ];
    for (const [name, change, rule] of FILE_BROKEN) {
      it(`refuses ${name} with exit 2, names the file and the rule, and writes nothing`, async () => {
        const rig = await makeRig();
        rig.put('public', CLEAN, change(cleanDoc()));
        expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
        expect(rig.world.screen.errorText).toContain(`the evidence file ${CLEAN} is not usable`);
        expect(rig.world.screen.errorText).toContain(rule);
        expect(rig.world.screen.errorText).not.toContain(KEY_TEXT);
        expect(existsSync(rig.pagePath)).toBe(false);
      });
    }

    it('refuses text that is not JSON, and a file above the limit, and accepts the same file when it is repaired', async () => {
      const rig = await makeRig();
      rig.put('public', CLEAN, '{ not json');
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain(`the evidence file ${CLEAN} is not JSON`);
      rig.put('public', CLEAN, `${JSON.stringify(cleanDoc({ result: 'x'.repeat(4 * 1024 * 1024) }))}\n`);
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('at most 4194304 bytes');
      rig.put('public', CLEAN, cleanDoc());
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
    });

    it('accepts a file with every member that the refusals above break, in its good form', async () => {
      const rig = await makeRig();
      rig.put('public', CLEAN, cleanDoc({ extra_member: { token: 'a member that the page never reads', seed: 1 } }));
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(rig.page()).toContain(`## Run ${CLEAN}: clean, 2026-12-01`);
    });
  });

  describe('the table of what a primitive shows and does not show', () => {
    it('has exactly the primitives of the data, each with two sentences and no dash that is not a hyphen', () => {
      expect(new Set(Object.keys(SHOWS))).toEqual(new Set(data.evidenceSteps.map((step) => step.primitive)));
      for (const [primitive, text] of Object.entries(SHOWS)) {
        expect(text.shows.length, primitive).toBeGreaterThan(20);
        expect(text.doesNotShow.length, primitive).toBeGreaterThan(20);
        expect(`${text.shows}${text.doesNotShow}`).toMatch(/^[\x20-\x7e]*$/);
      }
    });

    it('stops a run with exit 2 when a step of the data has a primitive that the table lacks, and passes with the primitive in the table', async () => {
      const added = { id: 'r1-12', run: 'clean' as const, what: 'A step that the table does not know.', primitive: 'A primitive that is new', actor: 'agent' as const };
      const rig = await makeRig({ evidenceSteps: [...data.evidenceSteps, added] });
      rig.put('public', CLEAN, cleanDoc());
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(2);
      expect(rig.world.screen.errorText).toContain('no entry for the primitive of the step r1-12');
      expect(existsSync(rig.pagePath)).toBe(false);
      const plain = await makeRig();
      plain.seed();
      expect(await plain.run(...NO_ARGUMENTS(plain), '--submit')).toBe(0);
    });

    it('stops a run with exit 2 when the page would hold a mark of a secret, and shows nothing of it', async () => {
      const rig = await makeRig();
      rig.put('public', CLEAN, doc('clean', '2026-12-01', [{ id: 'r1-02', status: 'shown', refs: [{ kind: 'bearer', value: 'x' }] }]));
      expect(await rig.run(...NO_ARGUMENTS(rig))).toBe(2);
      expect(rig.world.screen.errorText).toContain('the page holds a mark of a secret');
      expect(rig.world.screen.text).not.toContain('bearer');
      expect(existsSync(rig.pagePath)).toBe(false);
    });
  });

  describe('the content of the page', () => {
    it('holds only the header, the table, the data, the evidence and the fixed text of the page, and ends with the section Not covered', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run(...NO_ARGUMENTS(rig), '--runs', `${CLEAN},${FAILURE}`, '--submit')).toBe(0);
      const page = rig.page();
      const refs = [...cleanSteps(), ...failureSteps()].flatMap((step) => step.refs).flatMap((ref) => (typeof ref === 'string' ? [ref] : isLabelled(ref) ? [ref.kind, ref.value] : []));
      const known = [
        HEADER, data.title, EXPLORER_TX, CLEAN, FAILURE, 'clean', 'failure', '2026-12-01', '2026-12-03', NOTE, ...refs,
        ...Object.values(PAGE_TEXT).flat(), ...Object.values(SHOWS).flatMap((text) => [text.shows, text.doesNotShow]), ...data.evidenceSteps.flatMap((step) => [step.id, step.what, step.primitive]),
      ];
      let rest = page;
      for (const text of [...new Set(known)].sort((a, b) => b.length - a.length)) rest = rest.split(text).join('');
      expect(rest.match(/[A-Za-z0-9]/g)).toBeNull();
      const tail = page.slice(page.indexOf('## Not covered'));
      for (const item of [...PAGE_TEXT.notCoveredItems, ...PAGE_TEXT.limitsItems]) expect(tail).toContain(item);
      expect(PAGE_TEXT.notCoveredItems).toHaveLength(3);
      expect(page.trimEnd().endsWith(PAGE_TEXT.limitsItems.at(-1)!)).toBe(true);
    });

    it('changes only the header when the header file changes', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      const first = rig.page();
      writeFileSync(rig.header, 'Another group of the tests\n');
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(rig.page()).toBe(first.split(HEADER).join('Another group of the tests\n'));
      expect(first.startsWith(HEADER)).toBe(true);
    });

    it('shows no text of the rest of the evidence file: the result text and the other members stay out of the page', async () => {
      const rig = await makeRig();
      rig.put('public', CLEAN, cleanDoc({ result: 'the secret answer of the agent', hires: [{ step: 'propose', note: 'a hire that the page does not list' }] }));
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(rig.page()).not.toContain('the secret answer of the agent');
      expect(rig.page()).not.toContain('a hire that the page does not list');
    });
  });

  describe('status', () => {
    it('lists the evidence files by folder, and says whether the page exists', async () => {
      const rig = await makeRig();
      rig.seed();
      expect(await rig.run('status')).toBe(0);
      expect(rig.world.screen.text).toContain(`evidence files: ${CLEAN} (public), ${FAILURE} (private)`);
      expect(rig.world.screen.text).toContain('page: results/inventory-reorder.md does not exist yet');
      expect(await rig.run(...NO_ARGUMENTS(rig), '--submit')).toBe(0);
      expect(await rig.run('status')).toBe(0);
      expect(rig.world.screen.text).toMatch(/page: results\/inventory-reorder\.md exists, \d+ bytes/);
    });

    it('says that there is no evidence file when there is none', async () => {
      const rig = await makeRig();
      expect(await rig.run('status')).toBe(0);
      expect(rig.world.screen.text).toContain('evidence files: none');
    });
  });

  it('takes nothing back in cleanup', async () => {
    const rig = await makeRig();
    expect(await rig.run('cleanup')).toBe(0);
    expect(rig.world.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
  });
});
