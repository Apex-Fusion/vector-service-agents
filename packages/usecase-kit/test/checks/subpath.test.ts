// packages/usecase-kit/test/checks/subpath.test.ts: the folder is the subpath `@vsa/usecase-kit/checks`, and it has the shape that the package asks of a folder: it imports the protocol folder and the
// workspace packages only, and it reads no key file and no environment variable.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/checks';
import * as byPath from '../../src/checks/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/checks/', import.meta.url));
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts'));

describe('the subpath', () => {
  it('is the index of the folder, by name and by path', () => {
    expect(Object.keys(byName).sort()).toEqual(Object.keys(byPath).sort());
    expect(byName.runChecks).toBe(byPath.runChecks);
  });

  it('exports the functions that a counterparty uses', () => {
    for (const name of [
      'checkApproval', 'approvalCheckOf', 'checkSenderActive', 'checkSenderAccountable', 'checkSenderKey', 'checkDelegationNamesSender', 'checkDelegationUsable', 'checkVaultPaid', 'runChecks',
      'sharedChecks', 'precheckOf', 'ledgerPortOf', 'CheckUnavailableError', 'SHARED_CHECK_NAMES',
    ]) expect(byName, name).toHaveProperty(name);
  });
});

describe('the files of the folder', () => {
  it('import the protocol folder, the files of the folder and the workspace and library packages, and no other folder of the package', () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
        const specifier = match[1];
        const allowed = specifier.startsWith('./') || specifier === '../protocol/index.ts' || !specifier.startsWith('.');
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('read no environment variable and no file, and write nothing', () => {
    for (const file of files) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      for (const forbidden of ['process.env', 'node:fs', 'readFileSync', 'writeFileSync', 'node:child_process', 'Date.now', 'new Date(']) {
        expect(text.includes(forbidden), `${file} uses ${forbidden}`).toBe(false);
      }
    }
  });
});
