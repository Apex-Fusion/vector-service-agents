// agents/insurer-intake-agent/test/checks/exports.test.ts: the public surface of the folder, and its place in the package. The service wires the names below. The folder imports the kit and the service kit, and
// no other folder of the package: not the stores (it takes the book and the sink as the plain shapes of ports.ts), and not the job, the report or the server, which import the folder.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as checks from '../../src/checks/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/checks/', import.meta.url));
const textOf = (file: string): string => readFileSync(join(FOLDER, file), 'utf8');

describe('the folder of the hook', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(checks).sort()).toEqual(['createPrecheck', 'intakeChecks']);
  });

  it('has the four files of the design, and each imports only a file of its own folder, a package of the kit, or the service kit', () => {
    const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
    expect(files).toEqual(['extra.ts', 'index.ts', 'ports.ts', 'precheck.ts']);
    const allowed = [
      './extra.ts', './ports.ts', './precheck.ts', '@vsa/service-kit', '@vsa/usecase-kit/checks', '@vsa/usecase-kit/dispute', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol',
    ];
    for (const file of files) {
      const text = textOf(file);
      const specifiers = [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);
      for (const specifier of specifiers) expect(allowed.includes(specifier), `${file} imports ${specifier}`).toBe(true);
      // A call of `import()` or `require()` would reach a module that the list above does not see.
      expect(/\bimport\s*\(|\brequire\s*\(/.test(text), `${file} loads a module by a call`).toBe(false);
    }
  });

  it('keeps the shapes of the stores in a file that has types only: no value, and no import of a value', () => {
    const text = textOf('ports.ts');
    expect(/^export\s+(?:const|let|var|function|class|enum)\b/m.test(text)).toBe(false);
    expect([...text.matchAll(/^import\b(?!\s+type\b)/gm)]).toEqual([]);
    expect([...text.matchAll(/^export\s+interface\s+(\w+)/gm)].map((match) => match[1]).sort()).toEqual(['BookReader', 'PassedEntry', 'PassedSink']);
  });

  it('gives the book only the member that the hook reads, and the sink only the member that it writes', () => {
    const text = textOf('ports.ts');
    const members = (name: string): string[] => {
      const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? '';
      return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\W/gm)].map((match) => match[1]!);
    };
    expect(members('BookReader')).toEqual(['has']);
    expect(members('PassedSink')).toEqual(['put']);
    expect(members('PassedEntry')).toEqual(['record', 'request_sha256']);
  });
});
