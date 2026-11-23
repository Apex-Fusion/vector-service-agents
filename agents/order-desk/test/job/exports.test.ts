// agents/order-desk/test/job/exports.test.ts: the public surface of the folder, and its place in the package. The service wires the names below. The folder imports the kit, the workspace packages and itself, and
// no other folder of the package: the hook and the server are other folders, and the service imports the job, so an import of the hook or of the server would join folders that the design keeps apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as job from '../../src/job/index.ts';

const FOLDER = fileURLToPath(new URL('../../src/job/', import.meta.url));

describe('the folder of the job', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(job).sort()).toEqual(['AVAILABILITY_DECISION', 'ORDER_REFUSAL_STATUS', 'OrderRefusal', 'runOrder', 'wrongLotOf']);
  });

  it('has the five files of the design, and each imports only a file of its own folder, a workspace package or a module of node', () => {
    const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
    expect(files).toEqual(['availability.ts', 'fault.ts', 'index.ts', 'order.ts', 'ports.ts']);
    for (const file of files) {
      const specifiers = [...readFileSync(join(FOLDER, file), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);
      for (const specifier of specifiers) {
        expect(/^(?:\.\/[a-z]+\.ts|node:[a-z/]+|@vsa\/[a-z-]+(?:\/[a-z-]+)?)$/.test(specifier), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('imports no other folder of the package: no path that leaves the folder, and no import of the hook or of the server by name', () => {
    for (const file of readdirSync(FOLDER).filter((name) => name.endsWith('.ts'))) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      const specifiers = [...text.matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);
      expect(specifiers.filter((specifier) => specifier.includes('..')), file).toEqual([]);
      expect(specifiers.filter((specifier) => /\/(?:checks|serve)\//.test(specifier) && !specifier.startsWith('@vsa/')), file).toEqual([]);
    }
  });

  it('takes no environment variable and no file: the job reads nothing but its ports', () => {
    for (const file of readdirSync(FOLDER).filter((name) => name.endsWith('.ts'))) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      expect(text, file).not.toMatch(/process\.env|\bfrom 'node:(?:fs|fs\/promises|child_process|net|http|https|tls)'/);
    }
  });
});
