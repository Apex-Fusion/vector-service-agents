// agents/insurer-intake-agent/test/report/exports.test.ts: the public surface of the folder, and its place in the package. The job takes the report as a function and the wiring of the service joins the real
// readers with it, so the folder imports the kit and the workspace packages, and no other folder of the package: not the hook, the stores, the job or the server. The logic reads through its ports only: no
// environment, no key file, no network, no file of any kind.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as report from '../../src/report/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/report/', import.meta.url));
const textOf = (file: string): string => readFileSync(join(FOLDER, file), 'utf8');
const specifiersOf = (text: string): string[] => [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);

describe('the folder of the report', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(report).sort()).toEqual(['READ_BUDGET_MS', 'REPORT_BUDGET_MS', 'ledgerReportDeps', 'reportAttestations']);
  });

  it('has the four files of the design', () => {
    expect(readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort()).toEqual(['index.ts', 'ledger.ts', 'ports.ts', 'report.ts']);
  });

  it('imports only a file of its own folder, a package of the kit, or a workspace package that the design names: never another folder of the package', () => {
    const allowed: Record<string, readonly string[]> = {
      'index.ts': ['./ledger.ts', './ports.ts', './report.ts'],
      'ledger.ts': ['./ports.ts', '@vsa/buyer-core', '@vsa/usecase-kit/access', '@vsa/usecase-kit/protocol', '@vsa/vector-read'],
      'ports.ts': ['@vsa/usecase-kit/access', '@vsa/usecase-kit/protocol'],
      'report.ts': ['./ports.ts', '@vsa/buyer-core', '@vsa/usecase-kit/access', '@vsa/usecase-kit/priorauth', '@vsa/usecase-kit/protocol'],
    };
    for (const [file, specifiers] of Object.entries(allowed)) {
      const found = specifiersOf(textOf(file));
      for (const specifier of found) expect(specifiers.includes(specifier), `${file} imports ${specifier}`).toBe(true);
      // A call of `import()` or `require()` would reach a module that the list above does not see.
      expect(/\bimport\s*\(|\brequire\s*\(/.test(textOf(file)), `${file} loads a module by a call`).toBe(false);
    }
  });

  it('keeps the logic apart from the real readers: the logic does not import the readers, and the readers do not import the logic', () => {
    expect(specifiersOf(textOf('report.ts'))).not.toContain('./ledger.ts');
    expect(specifiersOf(textOf('ledger.ts'))).not.toContain('./report.ts');
  });

  it('reads no environment, no file and no network, and makes no clock of its own: the clock is a port', () => {
    for (const file of ['index.ts', 'ledger.ts', 'ports.ts', 'report.ts']) {
      const text = textOf(file);
      expect(/\bprocess\b|\bglobalThis\b|\bDate\.now\b|\bnew Date\b|\bsetTimeout\b|\bfetch\b\s*\(|\bMath\.random\b/.test(text), `${file} reaches the world by itself`).toBe(false);
    }
  });

  it('keeps the shapes of the ports in a file that has types only: no value, and no import of a value', () => {
    const text = textOf('ports.ts');
    expect(/^export\s+(?:const|let|var|function|class|enum)\b/m.test(text)).toBe(false);
    expect([...text.matchAll(/^import\b(?!\s+type\b)/gm)]).toEqual([]);
    expect([...text.matchAll(/^export\s+(?:interface|type)\s+(\w+)/gm)].map((match) => match[1]).sort()).toEqual(['ReportDeps', 'ReportExpectation', 'ReportInput', 'ReportRoot', 'ReportRow']);
  });

  it('gives the ports only the members that the report uses', () => {
    const text = textOf('ports.ts');
    const members = (name: string): string[] => {
      const body = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? '';
      return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\W/gm)].map((match) => match[1]!);
    };
    expect(members('ReportDeps')).toEqual(['list', 'check', 'providerKeyHashOf', 'rootDelegatorOf', 'clock', 'log']);
    expect(members('ReportRow')).toEqual(['id', 'issuer_key_hash', 'issuer_id', 'issued_at']);
    expect(members('ReportInput')).toEqual(['sender', 'delegation', 'atMs']);
    expect(members('ReportExpectation')).toEqual(['attType', 'subject', 'issuer']);
  });
});
