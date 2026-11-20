// packages/usecase-kit/test/buyer/subpath.test.ts: the folder is the subpath `@vsa/usecase-kit/buyer`. The import by the package name and the import by the path give the same names, and tsx loads
// the folder. The folder uses no syntax that a type stripper cannot erase, so that a service can run it as it is.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/buyer';
import * as byPath from '../../src/buyer/index.ts';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const FOLDER = join(PACKAGE, 'src', 'buyer');

describe('the subpath @vsa/usecase-kit/buyer', () => {
  it('resolves by the package name to the folder', () => {
    expect(typeof byName.hireCounterparty).toBe('function');
    expect(byName.hireCounterparty).toBe(byPath.hireCounterparty);
    expect(Object.keys(byName).sort()).toStrictEqual(Object.keys(byPath).sort());
  });

  it('loads with tsx, and gives the names that vitest gives', () => {
    // A static import cannot show that tsx loads the subpath: the script is run by another Node process, which is the load that this test is about.
    const script = "const m = await import('@vsa/usecase-kit/buyer'); console.log(Object.keys(m).sort().join(','));";
    const printed = execFileSync(process.execPath, ['--no-warnings', '--import', 'tsx', '--input-type=module', '-e', script], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    expect(printed).toBe(Object.keys(byName).sort().join(','));
  }, 60_000);

  it('imports only the protocol folder and the workspace packages: no file of another folder of the package', () => {
    for (const file of readdirSync(FOLDER)) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]!);
      for (const target of imports) {
        const own = target.startsWith('./');
        const named = target === '@vsa/usecase-kit/protocol' || (!target.startsWith('.') && !target.startsWith('@vsa/usecase-kit/'));
        expect(own || named, `${file} imports ${target}`).toBe(true);
      }
    }
  });

  it('uses no enum, no namespace and no parameter property, which a type stripper cannot erase', () => {
    for (const file of readdirSync(FOLDER)) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      expect(text, file).not.toMatch(/^\s*(?:export\s+)?(?:const\s+)?enum\s/m);
      expect(text, file).not.toMatch(/^\s*(?:export\s+)?(?:declare\s+)?namespace\s/m);
      expect(text, file).not.toMatch(/constructor\([^)]*\b(?:readonly|public|private|protected)\s+\w+/);
    }
  });
});
