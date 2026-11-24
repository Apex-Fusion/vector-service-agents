// agents/insurer-intake-agent/src/store/index.ts
// The stores of the Insurer Intake Agent that outlive one call. The intake book is a file on the state volume: one entry for each request number that the insurer portal took. The hook and the job take the
// stores as plain shapes, and the wiring of the service joins them. This folder imports the kit and the modules of node, and no other folder of the package.
export { FileIntakeBook, INTAKE_BOOK_LIMIT, MemoryIntakeBook } from './book.ts';
export type { BookFs, FileIntakeBookOptions, IntakeBook } from './book.ts';
