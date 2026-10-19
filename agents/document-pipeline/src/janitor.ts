// agents/document-pipeline/src/janitor.ts
// The escrows a run posted and did not see accepted, and the janitor that settles them, are packages/hire-kit's (its src/janitor.ts), moved there from
// this file with their rulings (R16, R33, R39, R55) and their words. The file is the one it was: stranded.json in the state directory (PIPELINE_STATE_DIR in
// the service), a list of entries whose kind is ocr or llm, rewritten whole at every change, so the store a running Pipeline wrote is read as it is. This
// file names them for the Pipeline's own modules and tests.
export { JANITOR_GRACE_MS, STRANDED_FILE, StrandedStore, runJanitorOnce, startJanitor } from '@vsa/hire-kit';
export type { AcceptPending, Busy, JanitorAction, JanitorChain, StrandedEntry, StrandedKind } from '@vsa/hire-kit';
