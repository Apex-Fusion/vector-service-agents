// agents/insurer-intake-agent/src/report/index.ts
// The report of the attestations of the sender (use case 2, prior authorization). The Insurer Intake Agent reads the provenance, the software and the principal-binding attestation of the sender, and it
// reports what it found in four words: valid, invalid, absent or unreadable. It never refuses a job for one of them, and the result never reaches a prompt. The logic (report.ts) takes four ports and the clock
// as plain shapes (ports.ts), and the real readers (ledger.ts) map the readers of buyer-core to them, so that the job takes the report as a function and the wiring of the service joins the two. This folder
// imports the kit and the workspace packages, and no other folder of the package: not the hook, the stores, the job or the server.
export { ledgerReportDeps } from './ledger.ts';
export { READ_BUDGET_MS, REPORT_BUDGET_MS, reportAttestations } from './report.ts';
export type { AttestationReport } from './report.ts';
export type { ReportDeps, ReportExpectation, ReportInput, ReportRoot, ReportRow } from './ports.ts';
