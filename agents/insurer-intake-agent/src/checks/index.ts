// agents/insurer-intake-agent/src/checks/index.ts
// The hook of the Insurer Intake Agent: what it checks before the runtime claims an escrow. The three checks that follow the shared checks of the use-case kit, the three plain shapes that it takes from the stores
// (the intake book that it reads and the sink of passed checks that it writes), and the pre-check itself, with the challenge that follows a refusal for `approval_digest_mismatch`. This folder imports the kit and the
// workspace packages, and no other folder of the package: not the stores, the job, the report or the server.
export { intakeChecks } from './extra.ts';
export type { IntakeChecksDeps } from './extra.ts';
export type { BookReader, PassedEntry, PassedSink } from './ports.ts';
export { createPrecheck } from './precheck.ts';
export type { PrecheckDeps } from './precheck.ts';
