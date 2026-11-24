// agents/insurer-intake-agent/src/store/index.ts
// The two stores of the Insurer Intake Agent that outlive one call. The intake book is a file on the state volume: one entry for each request number that the insurer portal took, and the job writes it. The
// record of the checks that passed is in memory, with a time to live: the hook puts the record of an escrow and the job takes it. The hook and the job take the stores as plain shapes, and the wiring of the
// service joins them. This folder imports the kit and the modules of node, and no other folder of the package.
export { FileIntakeBook, INTAKE_BOOK_LIMIT, MemoryIntakeBook } from './book.ts';
export type { BookFs, FileIntakeBookOptions, IntakeBook } from './book.ts';
export { PASSED_CHECKS_LIMIT, PASSED_CHECKS_TTL_MS, PassedChecks } from './passed.ts';
export type { PassedEntry } from './passed.ts';
