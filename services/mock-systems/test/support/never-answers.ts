// services/mock-systems/test/support/never-answers.ts
// A process that waits on an approval check that never answers, with the time limit of the service, and that does nothing else. The timer of the limit must not keep it alive: it ends at
// once, with the exit status 0. A stop of the service must not wait 30 seconds for a call that waits on such a check.
import { decideApproval } from '../../src/approval.ts';

void decideApproval(() => {
  // The real timer is active when the check starts.
  process.stdout.write('waiting on the check\n');
  return new Promise<never>(() => undefined);
}, {
  sender: `did:vector:${'a1'.repeat(32)}`, delegation: 'd1'.repeat(32), attestation: '07'.repeat(32), issuerDid: `did:vector:${'b2'.repeat(32)}`, document: { schema: 'x' }, salt: 'f6'.repeat(32), atMs: 1_000,
}).then(() => {
  // Fail even if the test runner did not see the marker before the timer fired.
  process.stderr.write('the approval check ended before the child exited\n');
  process.exitCode = 1;
});
