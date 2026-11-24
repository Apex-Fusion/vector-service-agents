// packages/usecase-kit/src/priorauth/index.ts
// The documents of use case 2 (prior authorization) that the Prior Authorization Agent and the Insurer Intake Agent share. The two agents are two packages and they do not import each other, so the kit holds
// what both read. Each document has a strict parser that returns a copy. Import it as `@vsa/usecase-kit/priorauth`.
//
//   request  the authorization request, which is the document of a proposal, the number of a request, and the key of that number (a number is unique without regard to case)
export { MAX_JUSTIFICATION_CHARS, PRIORAUTH_REQUEST_SCHEMA, parsePriorAuthRequest, requestNumberKey, requestNumberOf } from './request.ts';
export type { PriorAuthRequest } from './request.ts';
