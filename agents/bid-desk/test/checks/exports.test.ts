// agents/bid-desk/test/checks/exports.test.ts: the public surface of the folder, and its place in the package. The service wires the names below. The folder imports the kit, the workspace packages and
// itself, and no other folder of the package: the job and the server import the folder, so an import the other way would make a cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as checks from '../../src/checks/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/checks/', import.meta.url));

describe('the folder of the hook', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(checks).sort()).toEqual([
      'FileRfqBook', 'MemoryRfqBook', 'PASSED_CHECKS_LIMIT', 'PASSED_CHECKS_TTL_MS', 'PassedChecks', 'RFQ_BOOK_LIMIT', 'loadPriceList', 'rfqChecks',
    ]);
  });

  it('has the files of the design, and each imports only a file of its own folder, a workspace package or a module of node', () => {
    const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
    expect(files).toEqual(['book.ts', 'extra.ts', 'index.ts', 'passed.ts', 'pricelist.ts']);
    for (const file of files) {
      const specifiers = [...readFileSync(join(FOLDER, file), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(/^(?:\.\/[a-z]+\.ts|node:[a-z/]+|@vsa\/[a-z-]+(?:\/[a-z-]+)?)$/.test(specifier ?? ''), `${file} imports ${String(specifier)}`).toBe(true);
      }
    }
  });
});
