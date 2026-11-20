# @vsa/usecase-kit

The shared code of the agents of three use cases: use case 1 (inventory reorder), use case 2 (prior authorization) and use case 3 (supplier bid evaluation).

Each use case has a buyer-side agent and a counterparty. The hiring organisation hires a buyer-side agent. The agent proposes, and it executes the proposal after the organisation approves it. A buyer-side agent hires the counterparty.

The package has no root entry. Each folder of `src/` is one part of the code and one subpath.

## Folders

| Folder | Import | Holds |
|---|---|---|
| `src/protocol` | `@vsa/usecase-kit/protocol` | The contract of the agents: the forms of the identifiers, the requests and the messages, the digest of a proposal, the codes with their HTTP statuses, the fault values, the manifest types and the request limit. |

The checks of a counterparty, the flow of a buyer-side agent, the dispute code, the co-sign route, and the fault and manifest code are other folders. Each folder joins this table when it is added.

## How a new folder becomes a subpath

`package.json` has one `exports` entry: `"./*": "./src/*/index.ts"`. A folder `src/<name>/` that has an `index.ts` is the subpath `@vsa/usecase-kit/<name>`. A new folder needs no change to `package.json` and no change to the lockfile.

1. Make `src/<name>/index.ts`. It exports the public names of the folder.
2. Put the tests in `test/<name>/`.
3. Import the folder as `@vsa/usecase-kit/<name>`, from a test of the package or from another package of the workspace.

Only the `index.ts` of a folder is a subpath. A file inside a folder is not. There is no `src/index.ts`, and no file stands next to the folders. TypeScript, vitest, Node and tsx all resolve the pattern. `test/protocol/subpath.test.ts` makes a new folder and imports it with vitest, with Node and with tsx. It also fails when a folder of `src/` has no `index.ts`. The typecheck resolves the import of the protocol folder by the package name.

The package already names the workspace packages that the other folders need (`@vsa/buyer-core`, `@vsa/hire-kit`, `@vsa/id-kit`, `@vsa/service-kit` and `@vsa/vector-read`) and the libraries for signing and for chain data. A new folder uses them as they are.

## The protocol folder

A validator takes any value and never throws. It returns `{ ok: true, value }` or `{ ok: false, code, detail }`. The code of a form that is wrong is `bad_shape`. The detail names the field and never repeats the value. No code reads success from a text: a caller reads `ok`.

| Part | Names |
|---|---|
| Result | `ProtocolResult`, `Accepted`, `Refused`, `accepted`, `refused` |
| Identifiers | `Did`, `DelegationId`, `AttestationId`, `Salt`, `Digest`, `OutputRef`, `TenantId`; `parseDid`, `parseDelegationId`, `parseAttestationId`, `parseSalt`, `parseDigest`, `parseOutputRef`, `parseTenantId`, `newSalt` |
| JSON data | `JsonValue`, `JsonObject`, `Document`, `MAX_DOCUMENT_DEPTH`; `isPlainObject`, `parseJsonValue`, `parseDocument`, `parseJsonText`, `checkMembers` |
| Digest | `canonicalJson`, `canonicalSha256`, `proposalDigest` |
| Requests | `Authority`, `Proposal`, `RequestBase`, `ProposeRequest`, `ExecuteRequest`, `UseCaseRequest`, `ProposeFieldsParser`; `parseAuthority`, `parseProposal`, `parseRequest`, `makeProposal` |
| Messages | `Handoff`, `RfqMessage`, `PROPOSAL_SCHEMA`, `RESULT_SCHEMA`, `HANDOFF_SCHEMA`, `RFQ_SCHEMA`; `parseHandoff`, `parseRfq` |
| Approval | `ApprovalRef`, `ApprovalInput`, `ApprovalResult`, `ApprovalAccepted`, `ApprovalRefused`, `ApprovalRefusedByCheck`, `ApprovalDigestMismatch`, `ApprovalCheck`, `ApprovalRefusal`, `APPROVAL_ATT_TYPE`, `APPROVAL_VALIDITY_DEFAULT_MS`, `APPROVAL_VALIDITY_MAX_MS`, `APPROVAL_DEPOSIT_LOVELACE`; `parseApprovalRef` |
| Results | `ProposalResult`, `ProposedResult`, `FailedProposalResult`, `ExecuteResult`, `CompletedResult`, `DisputedResult`, `RefusedResult`, `Decision`, `SubJob`, `HandoffRecord`, `WriteRecord`, `ChallengeRecord`, `ReceiptVerification`, `ReceiptCheck`, `RECEIPT_CHECKS` |
| Codes | `USE_CASES`, `OPERATIONS`, `OUTCOMES`, `PROPOSE_OUTCOMES`, `EXECUTE_OUTCOMES`, `EXIT_STATES`, `ERROR_STATUS`, `REFUSAL_CODES`, `SENDER_REFUSALS`, `DELEGATION_REFUSALS`, `VAULT_REFUSALS`, `APPROVAL_REFUSALS`, `COUNTERPARTY_REFUSALS`, `ErrorCode`, `ErrorBody`, `RefusalCode`, `Outcome`, `ProposeOutcome`, `ExecuteOutcome`, `ExitState`, `UseCase`, `Operation`; `isErrorCode`, `isRefusalCode` |
| Kinds and faults | `BUYER_SIDE_KINDS`, `COUNTERPARTY_KINDS`, `AGENT_KINDS`, `BuyerSideKind`, `CounterpartyKind`, `AgentKind`, `FAULT_MODES`, `FaultMode`, `FaultSetting`; `isFaultSetting` |
| Manifest | `BehaviourAdditions`, `ManifestClaim`, `ClaimStatement`, `ManifestCosign`, `ManifestModel`, `ManifestRelyingOn`, `ManifestFileRef` |
| Limit | `MAX_REQUEST_BYTES`; `checkRequestSize` |

### A request

`parseRequest` takes the request JSON and refuses an operation that is not `propose` or `execute`. A `propose` request has `op`, `authority` and `tenant`, and the fields of the use case. The use case reads its own fields with a parser that it gives to `parseRequest`. An `execute` request has `op`, `authority`, `tenant`, `proposal` and `approval`. The approval is a reference or `null`, and the agent passes it on. The authority is `{ principal_did, delegation }` and has no vault. A member that the protocol does not name is refused.

```ts
import { ERROR_STATUS, accepted, checkMembers, parseDid, parseJsonText, parseRequest, refused } from '@vsa/usecase-kit/protocol';
import type { ProposeFieldsParser } from '@vsa/usecase-kit/protocol';

// A use case reads its own fields. checkMembers refuses a member that is missing and a member that the request must not have.
const parseFields: ProposeFieldsParser<{ sku: string; supplier_did: string }> = (fields) => {
  const members = checkMembers(fields, 'request', ['sku', 'supplier_did']);
  if (members !== null) return members;
  if (typeof fields.sku !== 'string' || fields.sku.length < 1 || fields.sku.length > 64) return refused('bad_shape', 'request.sku must be 1 to 64 characters');
  const supplier = parseDid(fields.supplier_did, 'request.supplier_did');
  return supplier.ok ? accepted({ sku: fields.sku, supplier_did: supplier.value }) : supplier;
};

const json = parseJsonText(requestText); // requestText: the request JSON out of the wire message
const parsed = json.ok ? parseRequest(json.value, parseFields) : json;
if (!parsed.ok) return reply(ERROR_STATUS[parsed.code], { error: parsed.code, message: parsed.detail });
const request = parsed.value; // request.op is 'propose' or 'execute'
```

### The digest of a proposal

`proposalDigest(salt, document)` is the SHA-256 of the 32 bytes of the salt followed by the UTF-8 bytes of the canonical text of the document. The salt comes first. `makeProposal` makes the salt (or takes one) and the digest. `parseProposal` refuses a digest that is not the digest of its document and its salt.

The canonical text has the keys of each object in the order of their UTF-16 code units, every string value in the NFC form, no white space, and numbers as `JSON.stringify` writes them. It is the text that `canonicalize` of the buyer code writes. `test/protocol/canonical-drift.test.ts` holds the two together on generated documents.

The protocol takes a document only when the two give the same text. It refuses a value that JSON cannot hold (`undefined`, a function, a bigint, `NaN`, an infinite number, a hole in an array), an object that is not a plain object, the key `__proto__`, a key that is a whole number, a key that is not in the NFC form, and a value that is nested more than 32 levels deep.

### Errors and refusals

`ERROR_STATUS` gives the HTTP status of every code of an agent. A refusal code of a counterparty is a 403: the counterparty refuses before it claims the job, so nothing is paid. `COUNTERPARTY_REFUSALS` lists the codes that each counterparty can answer, in the order of its checks. A buyer-side agent answers 200 with an `outcome` whenever it could read the request. `refused_by_counterparty` has the code of the counterparty as its `reason`. `vault_refused` has the evaluation error of the node as its `reason`.

### The approval check

The protocol holds the types of the check and not the function. `ApprovalInput` has the approval reference or `null`, the DID of the sender, the delegation, the document and the salt that were received, and the time. `ApprovalResult` is `{ ok: true, ... }` or `{ ok: false, code, detail }` with one of the eight `APPROVAL_REFUSALS`. A digest mismatch also carries the two digests, because a challenge needs both.

## Tests

`pnpm test` in this folder runs vitest. Each refusal has a test with an accepted twin. `pnpm typecheck` also checks the lines of the tests that must not compile (`@ts-expect-error`). No test uses the network.
