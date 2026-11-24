// packages/usecase-kit/src/priorauth/index.ts
// The documents of use case 2 (prior authorization) that the Prior Authorization Agent and the Insurer Intake Agent share. The two agents are two packages and they do not import each other, so the kit holds
// what both read. Each document has a strict parser that returns a copy. Import it as `@vsa/usecase-kit/priorauth`.
//
//   request  the authorization request, which is the document of a proposal, the number of a request, and the key of that number (a number is unique without regard to case)
//   records  the record set of an order, the guideline of a service and the requirement set of an insurer, as the mock systems give them, and the hash of a record set that a request carries
export { MAX_JUSTIFICATION_CHARS, PRIORAUTH_REQUEST_SCHEMA, parsePriorAuthRequest, requestNumberKey, requestNumberOf } from './request.ts';
export type { PriorAuthRequest } from './request.ts';
export { parseGuideline, parseRecordSet, parseRequirementSet, recordSetSha256 } from './records.ts';
export type { ClinicalOrder, ClinicalRecord, Criterion, Guideline, RecordSet, RequirementSet } from './records.ts';
