// The shipped wiring of the approval check (src/wiring.ts). The real check is written in the use-case kit and is not on `main`, so the shipped wiring gives none: the production start refuses,
// and the service never runs with a fake check or with one that always passes. When the real check is wired, this is the one file that changes: these tests become the tests of that check.
// The twin of each refusal is a start with a test approval check, on the same settings: it listens (test/start.test.ts has the tests of that start, and of the entry that runs it).
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createLedgerEnv } from '../src/ledger.ts';
import { NO_APPROVAL_CHECK, startService } from '../src/start.ts';
import { wireApprovalCheck } from '../src/wiring.ts';
import { Child, childEnvironment } from './support/child.ts';
import { freePort, listening } from './support/net.ts';
import { serviceEnvironment } from './support/world.ts';

describe('the shipped wiring of the approval check', () => {
  it('gives no approval check: the real check of the use-case kit is not wired in this build', () => {
    const ledger = createLedgerEnv(loadConfig(serviceEnvironment(9120)), fetch);
    expect(wireApprovalCheck(ledger)).toBeNull();
  });

  it('makes the production start refuse with the text of NO_APPROVAL_CHECK, and the start opens no port', async () => {
    const port = await freePort();
    await expect(startService(serviceEnvironment(port))).rejects.toThrow(NO_APPROVAL_CHECK);
    expect(await listening(port)).toBe(false);
  });

  it('does not stop a start that has a check: the same settings listen when a test approval check is wired', async () => {
    const port = await freePort();
    const started = await startService(serviceEnvironment(port), { wire: () => async () => ({ ok: true }), writeLog: () => undefined });
    try {
      expect(await listening(port)).toBe(true);
    } finally {
      await started.shutdown();
    }
    expect(await listening(port)).toBe(false);
  });

  it('makes the real entry (node --import tsx src/index.ts) exit with 1 and say why, and it opens no port', async () => {
    const port = await freePort();
    const child = new Child('src/index.ts', childEnvironment(serviceEnvironment(port)));
    expect(await child.exit).toEqual({ code: 1, signal: null });
    expect(child.stderr).toContain(`[mock-systems] cannot start: ${NO_APPROVAL_CHECK}`);
    expect(child.stdout).not.toContain('"event":"listening"');
    expect(await listening(port)).toBe(false);
  });
});
