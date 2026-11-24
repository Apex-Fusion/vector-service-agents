// agents/insurer-intake-agent/test/store/exports.test.ts: the public surface of the folder, and its place in the package. The wiring of the service joins the stores with the hook and the job, and these take
// plain shapes. The folder imports the kit, the modules of node and itself, and no other folder of the package: the hook, the job and the server import no store, so the folders never meet in a cycle.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as store from '../../src/store/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/store/', import.meta.url));

describe('the folder of the stores', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(store).sort()).toEqual(['FileIntakeBook', 'INTAKE_BOOK_LIMIT', 'MemoryIntakeBook', 'PASSED_CHECKS_LIMIT', 'PASSED_CHECKS_TTL_MS', 'PassedChecks']);
  });

  it('has the three files of the design, and each imports only a file of its own folder, a folder of the kit that the design names, or a module of node', () => {
    const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
    expect(files).toEqual(['book.ts', 'index.ts', 'passed.ts']);
    const allowed = ['./book.ts', './passed.ts', '@vsa/usecase-kit/checks', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol'];
    for (const file of files) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      const specifiers = [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);
      for (const specifier of specifiers) {
        expect(allowed.includes(specifier) || /^node:[a-z/]+$/.test(specifier), `${file} imports ${specifier}`).toBe(true);
      }
      // A call of `import()` or `require()` would reach a module that the list above does not see.
      expect(/\bimport\s*\(|\brequire\s*\(/.test(text), `${file} loads a module by a call`).toBe(false);
    }
  });
});
