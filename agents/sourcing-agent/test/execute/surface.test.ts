// agents/sourcing-agent/test/execute/surface.test.ts: the names that the execute folder exports, and what its sources import. The wiring of the service takes the deps and the refusal of this job from the folder, and the page of
// the agent reads its closed list of codes, so a name that leaves it is a change of its contract. The job makes no model call, no hire and no vault payment, so its sources import none of the code for them, and they import no
// other folder of the agent. They read no file and no environment variable, read no time of day, and set no timer: every wait goes through the clock port of the call.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as execute from '../../src/execute/index.ts';
import type { ExecuteDeps } from '../../src/execute/index.ts';

const FOLDER = new URL('../../src/execute/', import.meta.url);
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const textOf = (name: string): string => readFileSync(new URL(name, FOLDER), 'utf8');

interface Import {
  /** True for `import type` and `export type`. */
  readonly typeOnly: boolean;
  readonly module: string;
}

/** The imports and the re-exports of a source: whether each is type-only, and the module that it names. */
const importsOf = (text: string): Import[] => [...text.matchAll(/^(?:import|export)( type)?\b[^;]*?\bfrom '([^']+)';/gm)].map((match) => ({ typeOnly: match[1] !== undefined, module: match[2]! }));

/** The modules that only a type may come from: the client of the identity gateway. */
const TYPE_ONLY = ['@vsa/id-kit/client'];

describe('the execute folder', () => {
  test('exports these values, and no other', () => {
    expect(Object.keys(execute).sort()).toStrictEqual(['EXECUTE_DEADLINE_MS', 'EXECUTE_FAILURES', 'ExecuteRefusal', 'runExecute']);
  });

  test('has these source files, and no other', () => {
    expect(files).toStrictEqual(['execute.ts', 'index.ts', 'ports.ts']);
  });

  test('imports the access, bids, buyer and protocol folders of the kit, the type of the client of the gateway, and its own files, and nothing else', () => {
    const allowed = ['@vsa/usecase-kit/access', '@vsa/usecase-kit/bids', '@vsa/usecase-kit/buyer', '@vsa/usecase-kit/protocol', ...TYPE_ONLY, './execute.ts', './ports.ts'];
    for (const name of files) {
      for (const { module } of importsOf(textOf(name))) {
        expect(module.startsWith('..'), `${name} imports a file of another folder: ${module}`).toBe(false);
        expect(allowed.includes(module), `${name} imports ${module}`).toBe(true);
      }
    }
    expect(importsOf(textOf('index.ts')).length).toBeGreaterThan(0);
  });

  test('takes the client of the gateway as a type only, so that no code of it runs here', () => {
    for (const name of files) {
      for (const { typeOnly, module } of importsOf(textOf(name))) {
        if (TYPE_ONLY.includes(module)) expect(typeOnly, `${name} imports ${module} as a value`).toBe(true);
      }
    }
  });

  test('reads no file, no environment variable and no time of day, makes no network call of its own, sets no timer, and draws no random number', () => {
    for (const name of files) {
      const text = textOf(name);
      for (const pattern of [/node:fs/, /node:child_process/, /process\.env/, /\breadFile/, /\bfetch\(/, /\bXMLHttpRequest\b/, /\bDate\b/, /\bsetTimeout\b/, /\bsetInterval\b/, /Math\.random/]) {
        expect(text, `${name} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  test('has no port for a model, a hire, a vault or a challenge: the deps are the reads, the keys, the token, the call, the clock and the log', () => {
    // The table has one entry for each member of `ExecuteDeps`: a member that is added or taken away makes it a type error.
    const ports = { reads: 'ledger', delegateKeyOf: 'ledger', delegationKeys: 'keys', agent: 'keys', tokens: 'gateway', calls: 'record', clock: 'time', log: 'log' } satisfies Record<keyof ExecuteDeps, string>;
    expect(Object.keys(ports).sort()).toStrictEqual(['agent', 'calls', 'clock', 'delegateKeyOf', 'delegationKeys', 'log', 'reads', 'tokens']);
  });
});
