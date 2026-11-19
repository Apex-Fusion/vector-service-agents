// A probe check: a check of the real runner whose only step runs a function of the test. The function gets a real session (the keys, the state file, the evidence file, the node, the chain
// and the way to land a transaction), so that a test can run a part of a check, such as the guarded chain or the guard of the record, as the runner would run it.
import type { CheckDefinition } from '../../lib/runner.ts';
import type { Session } from '../../lib/session.ts';
import type { Harness } from './harness.ts';

/** Runs `body` as the step of a probe check named `probe`, with --submit unless `dry`, and gives the exit code of the run. */
export async function probed(h: Harness, body: (session: Session<null>) => Promise<void>, options: { dry?: boolean } = {}): Promise<number> {
  const check: CheckDefinition<null> = {
    name: 'probe', title: 'a probe of a part of a check', needs: { keys: ['controller', 'agent', 'member'], chain: true, hosted: [] }, steps: ['probe'], parse: () => null,
    next: async (session) => { await body(session); return { kind: 'done', message: 'probe done' }; },
    cleanup: async () => ({ kind: 'done', message: '' }),
  };
  return options.dry === true ? h.run(check) : h.run(check, '--submit');
}
