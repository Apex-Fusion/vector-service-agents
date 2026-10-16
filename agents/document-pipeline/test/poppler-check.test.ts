// agents/document-pipeline/test/poppler-check.test.ts
// The check the service makes at start (Renderer.check): pdfinfo and pdftoppm are each asked for their version, and a tool that cannot be run stops the
// start. Poppler's -v does not always exit 0 (test/render.test.ts probes for the tools by whether they start, not by what they exit with), so a tool that runs
// and exits with a status is a tool that is there. What the check does not do is read a PDF: it is the presence of the tools that it proves.
import { spawnSync } from 'node:child_process';
import { describe, test, expect } from 'vitest';
import { RequestError } from '../src/request.ts';
import { popplerRenderer, popplerRendererWith } from '../src/render.ts';
import type { RunTool } from '../src/render.ts';
import { fakeRenderer } from './fake-renderer.ts';

const cannotStart = (code: string) => Object.assign(new Error(`spawn tool ${code}`), { code, errno: -2, syscall: 'spawn tool' });
const exited = (status: number) => Object.assign(new Error(`Command failed: exit code ${status}`), { code: status, killed: false, signal: null, stderr: 'pdfinfo version 24.08.0' });
const timedOut = () => Object.assign(new Error('Command failed'), { code: null, killed: true, signal: 'SIGTERM', stderr: '' });

interface Call { file: string; args: readonly string[]; timeoutMs: number; maxBuffer: number }
/** A process runner that records each call and lets the test play the tool by its name. */
function tools(play: (file: string) => void = () => undefined) {
  const calls: Call[] = [];
  const run: RunTool = async (file, args, options) => {
    calls.push({ file, args, timeoutMs: options.timeoutMs, maxBuffer: options.maxBuffer });
    play(file);
    return { stdout: '', stderr: `${file} version 24.08.0` };
  };
  return { run, calls };
}
const refusal = async (promise: Promise<unknown>): Promise<Error> => {
  try { await promise; } catch (e) { return e as Error; }
  throw new Error('it did not reject');
};

describe('Renderer.check of popplerRendererWith', () => {
  test('asks pdfinfo and then pdftoppm for their version, with a short time limit and little output, and reads no PDF', async () => {
    const t = tools();
    await popplerRendererWith(t.run).check!();
    expect(t.calls.map((c) => [c.file, c.args])).toStrictEqual([['pdfinfo', ['-v']], ['pdftoppm', ['-v']]]);
    for (const call of t.calls) {
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.timeoutMs).toBeLessThanOrEqual(30_000);
      expect(call.maxBuffer).toBeLessThanOrEqual(1024 * 1024);
    }
  });

  test('asks for the tools by the names the options give', async () => {
    const t = tools();
    await popplerRendererWith(t.run, { pdfinfo: '/opt/poppler/bin/pdfinfo', pdftoppm: '/opt/poppler/bin/pdftoppm' }).check!();
    expect(t.calls.map((c) => c.file)).toStrictEqual(['/opt/poppler/bin/pdfinfo', '/opt/poppler/bin/pdftoppm']);
  });

  test('a tool that runs and exits with a status is there: -v does not always exit 0', async () => {
    const t = tools((file) => { throw exited(file === 'pdfinfo' ? 1 : 99); });
    await expect(popplerRendererWith(t.run).check!()).resolves.toBeUndefined();
    expect(t.calls).toHaveLength(2);
  });

  test('a tool that cannot be started stops the check with its name, the reason and what to install; it is a plain Error, not a verdict on a document', async () => {
    for (const [tool, code] of [['pdfinfo', 'ENOENT'], ['pdftoppm', 'ENOENT'], ['pdfinfo', 'EACCES'], ['pdftoppm', 'EACCES']] as const) {
      const t = tools((file) => { if (file === tool) throw cannotStart(code); });
      const error = await refusal(popplerRendererWith(t.run).check!());
      expect(error, `${tool} ${code}`).not.toBeInstanceOf(RequestError);
      expect(error.message, `${tool} ${code}`).toMatch(new RegExp(`^${tool} cannot be run \\(${code}\\): poppler-utils \\(pdfinfo and pdftoppm\\) must be installed and on PATH`));
      expect((error as Error & { cause?: unknown }).cause, `${tool} ${code}`).toBeDefined();
    }
  });

  test('the check stops at the first tool that fails, and does not ask the second', async () => {
    const t = tools(() => { throw cannotStart('ENOENT'); });
    await refusal(popplerRendererWith(t.run).check!());
    expect(t.calls.map((c) => c.file)).toStrictEqual(['pdfinfo']);
  });

  test('a tool that does not answer in time stops the check, saying so', async () => {
    const t = tools((file) => { if (file === 'pdftoppm') throw timedOut(); });
    const error = await refusal(popplerRendererWith(t.run).check!());
    expect(error.message).toMatch(/^pdftoppm cannot be run \(it did not answer within \d+ s\)/);
  });

  test('the renderer of the tests has no check, so a start with it asks nothing of the machine', () => {
    expect(fakeRenderer().check).toBeUndefined();
    expect(typeof popplerRendererWith(tools().run).check).toBe('function');
  });
});

describe('Renderer.check of popplerRenderer, with the real programs', () => {
  test('a tool that is not installed stops the check, naming it', async () => {
    const error = await refusal(popplerRenderer({ pdfinfo: 'pdfinfo-that-is-not-installed' }).check!());
    expect(error.message).toMatch(/^pdfinfo-that-is-not-installed cannot be run \(ENOENT\)/);
    const second = await refusal(popplerRenderer({ pdfinfo: process.execPath, pdftoppm: 'pdftoppm-that-is-not-installed' }).check!()); // node answers -v with its version
    expect(second.message).toMatch(/^pdftoppm-that-is-not-installed cannot be run \(ENOENT\)/);
  });

  // The probes ask each tool for its version: a missing tool is an ENOENT, whatever the exit code of a present one.
  const onPath = (tool: string) => spawnSync(tool, ['-v'], { stdio: 'ignore' }).error === undefined;
  const POPPLER = onPath('pdftoppm') && onPath('pdfinfo');
  test.skipIf(!POPPLER)('with poppler-utils installed the check passes (needs pdfinfo and pdftoppm on PATH)', async () => {
    await expect(popplerRenderer().check!()).resolves.toBeUndefined();
  });
});
