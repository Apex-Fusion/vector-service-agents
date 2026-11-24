// agents/insurer-intake-agent/src/job/index.ts
// The job of the Insurer Intake Agent: what it does after the Claim of an escrow. `runIntake` takes the record of the checks, gets a JWT-SVID, reads the requirement set of the insurer, reports the attestations
// of the sender, takes the model decision `completeness`, files the request in the insurer portal, writes the intake book, and gives the intake record. The agent has no fault value: the record always says
// `fault_mode: ''`. This folder imports the kit, the workspace packages and itself, and no other folder of the package: the service imports the folder, so an import the other way would make a cycle.
export { attestStep } from './attest.ts';
export { COMPLETENESS_NAME, completenessDecision, completenessInput } from './completeness.ts';
export { RUNTIME_MARGIN_MS, fileRequest } from './filing.ts';
export type { FilingInput } from './filing.ts';
export { runIntake } from './intake.ts';
export { INTAKE_REFUSAL_STATUS, IntakeRefusal } from './refusal.ts';
export type { IntakeRefusalCode } from './refusal.ts';
export { readRequirements } from './requirements.ts';
export { fetchSvid } from './svid.ts';
export { takeJob } from './take.ts';
export type { TakenJob } from './take.ts';
export type { AttestationReport, BookPort, CompletenessChoice, IntakeDeps, ReportInput, TakenChecks } from './ports.ts';
