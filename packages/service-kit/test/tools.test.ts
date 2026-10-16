// packages/service-kit/test/tools.test.ts
import { describe, test, expect } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { runTool, toolFailure, withPrivateDir } from '../src/tools.ts';

const node = process.execPath;
async function failureOf(p: Promise<unknown>) {
  try { await p; } catch (e) { return toolFailure(e); }
  throw new Error('the tool did not fail');
}

describe('tools', () => {
  test('runTool runs a program with an argument list, never a shell, and gives what it printed', async () => {
    const out = await runTool(node, ['-e', 'process.stdout.write(process.argv.slice(1).join("|"))', 'a b', '$HOME', ';ls'], { timeoutMs: 10_000, maxBuffer: 1024 });
    expect(out.stdout).toBe('a b|$HOME|;ls');
  });
  test('toolFailure reads the four ways a run fails: not started, out of time, output over the limit, an exit with a status', async () => {
    expect(await failureOf(runTool('a-tool-that-is-not-installed', [], { timeoutMs: 1000, maxBuffer: 1024 }))).toMatchObject({ kind: 'start', code: 'ENOENT' });
    expect(await failureOf(runTool(node, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 100, maxBuffer: 1024 }))).toStrictEqual({ kind: 'timeout' });
    expect(await failureOf(runTool(node, ['-e', 'process.stdout.write("x".repeat(5000))'], { timeoutMs: 10_000, maxBuffer: 100 }))).toStrictEqual({ kind: 'output' });
    expect(await failureOf(runTool(node, ['-e', 'process.stderr.write("broken"); process.exit(3)'], { timeoutMs: 10_000, maxBuffer: 1024 }))).toStrictEqual({ kind: 'exit', stderr: 'broken' });
  });
  test('runTool starts a program without the secrets of the service: a child that prints its environment lacks the token and every name that holds a key, a token, a secret, a password, an API key or an access key, and has the rest', async () => {
    const token = `Bearer ${'ef'.repeat(32)}`;
    const set: Record<string, string> = {
      SERVICE_AUTH_HEADER: token, KIT_TEST_PRIV_KEY_HEX: 'a key', KIT_TEST_TOKEN: 'a token', KIT_TEST_SECRET: 'a secret', KIT_TEST_PASSWORD: 'a password',
      KIT_TEST_API_KEY: 'an api key', KIT_TEST_ACCESS_KEY_ID: 'an access key', KIT_TEST_KEPT: 'kept',
    };
    const saved = Object.fromEntries(Object.keys(set).map((name) => [name, process.env[name]]));
    Object.assign(process.env, set);
    try {
      const out = await runTool(node, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], { timeoutMs: 10_000, maxBuffer: 1024 * 1024 });
      const seen = JSON.parse(out.stdout) as Record<string, string>;
      const names = Object.keys(seen).map((name) => name.toUpperCase());
      expect(names.filter((name) => name === 'SERVICE_AUTH_HEADER' || /PRIV_KEY|TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/.test(name))).toStrictEqual([]);
      expect(out.stdout).not.toContain('ef'.repeat(32));
      expect([seen.KIT_TEST_KEPT, names.includes('PATH')]).toStrictEqual(['kept', true]);
      // The service's own environment is left as it is.
      expect(process.env.SERVICE_AUTH_HEADER).toBe(token);
    } finally {
      for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    }
  });
  test('withPrivateDir gives a new empty directory and removes it after the work, whether the work threw or not', async () => {
    let seen = '';
    expect(await withPrivateDir('kit-test-', async (dir) => { seen = dir; expect(readdirSync(dir)).toStrictEqual([]); writeFileSync(`${dir}/x`, 'y'); return 7; })).toBe(7);
    expect(existsSync(seen)).toBe(false);
    await expect(withPrivateDir('kit-test-', async (dir) => { seen = dir; throw new Error('the work failed'); })).rejects.toThrow('the work failed');
    expect(existsSync(seen)).toBe(false);
  });
});
