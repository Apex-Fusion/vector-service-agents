// packages/usecase-kit/src/fault/index.ts
// The fault switch of the agents. Import it as `@vsa/usecase-kit/fault`.
//
// A fault value makes one agent do one wrong thing on purpose in a failure run, so that the other agents and the checks can show how they answer. The setting is FAULT_MODE. It is empty in a clean run.
//
//   start        `readFaultSwitch(kind, process.env.FAULT_MODE)` one time. An unknown value, and the value of another kind, stop the start.
//   results      `withFaultMode` or `withFaultModeJob` gives every result of a job the field `fault_mode`. No job code writes the field.
//   manifest     The manifest names the possible values and never the active one (`@vsa/usecase-kit/manifest`).
//   run script   `checkCleanRun` before a clean run, `checkFaultRun` before a fault run, and `checkFaultMode` on each result that goes into the evidence file.
//
// A fault never changes a check. A fault value changes WHAT an agent sends or decides in its own job, as the page of that agent says. It never changes whether a check of a counterparty, a verifier
// or a limit runs. No check function of the kit takes a fault value: it has no parameter for one, and a request has no member that could carry one. The tests show this for the checks of the protocol.
export { FAULT_MODE_VARIABLE, parseFaultSetting, readFaultSwitch } from './setting.ts';
export type { FaultSettingRefusal, FaultSwitch } from './setting.ts';
export { checkFaultMode, readFaultMode, withFaultMode, withFaultModeJob } from './stamp.ts';
export type { FaultStampRefusal, WithFaultMode } from './stamp.ts';
export { checkCleanRun, checkFaultRun } from './guard.ts';
export type { ExpectedFault, RunGuardRefusal, RunGuardResult, SeenService, SeenSetting } from './guard.ts';
export type { FaultCompareRefusal } from './compare.ts';
