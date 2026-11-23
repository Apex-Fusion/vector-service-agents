// packages/usecase-kit/test/janitor/surface.test.ts: the folder is a subpath, it names what it exports, it imports no folder of the kit but the protocol and the access folder, and its code reads no environment
// variable, writes no log line by itself, and never compares the clock with the end of validity that the build port reported.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/janitor';
import * as byPath from '../../src/janitor/index.ts';

const SRC = fileURLToPath(new URL('../../src/janitor/', import.meta.url));
const FILES = ['index.ts', 'janitor.ts', 'store.ts'];

/** The code of a file, without the lines that are comments. */
function codeOf(name: string): string {
  return readFileSync(join(SRC, name), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**'))
    .join('\n');
}

describe('the folder', () => {
  it('is the subpath @vsa/usecase-kit/janitor, with the values that it exports and no others', () => {
    expect(byName.runJanitorOnce).toBe(byPath.runJanitorOnce);
    expect(Object.keys(byName).sort()).toStrictEqual(
      [
        'DEFAULT_END_POLL_MS', 'DEFAULT_ENTRY_TIMEOUT_MS', 'DEFAULT_STOP_WAIT_MS', 'DamagedLeftEntriesError', 'FileLeftStore', 'JANITOR_STATES', 'MemoryLeftStore', 'nodeLeftFs', 'parseLeftEntry',
        'runJanitorOnce', 'startJanitor',
      ].sort(),
    );
  });

  it('has one file for each part', () => {
    expect(readdirSync(SRC).sort()).toStrictEqual(FILES);
  });
});

describe('the code of the folder', () => {
  it.each(FILES)('%s imports no folder of the kit but the protocol and the access folder', (name) => {
    const folders = [...codeOf(name).matchAll(/from '\.\.\/([a-z]+)\//g)].map((match) => match[1]);
    expect(folders.filter((folder) => folder !== 'protocol' && folder !== 'access')).toStrictEqual([]);
  });

  it.each(FILES)('%s reads no environment variable, no stream of the process, and writes no log line by itself', (name) => {
    const code = codeOf(name);
    expect(code).not.toMatch(/process\.(env|stdout|stderr|argv)/);
    expect(code).not.toMatch(/\bconsole\./);
    expect(code).not.toMatch(/Date\.now\(\)|setTimeout\(/);
  });

  it('is the store that reads and writes files, and the janitor imports no module of Node', () => {
    expect(codeOf('janitor.ts')).not.toMatch(/from 'node:/);
    expect(codeOf('index.ts')).not.toMatch(/from 'node:/);
    expect([...codeOf('store.ts').matchAll(/from '(node:[a-z/]+)'/g)].map((match) => match[1]).sort()).toStrictEqual(['node:crypto', 'node:fs/promises', 'node:path']);
  });

  it('never compares the clock with the end of validity of the Delegate: the janitor reads only the slot of the tip', () => {
    expect(codeOf('janitor.ts')).not.toContain('delegateValidTo');
    expect(codeOf('janitor.ts')).toContain('delegateTtlSlot');
  });
});
