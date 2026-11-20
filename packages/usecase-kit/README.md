# @vsa/usecase-kit

The shared code of the agents of three use cases: use case 1 (inventory reorder), use case 2 (prior authorization) and use case 3 (supplier bid evaluation).

Each use case has a buyer-side agent and a counterparty. The hiring organisation hires a buyer-side agent. The agent proposes, and it executes the proposal after the organisation approves it. A buyer-side agent hires the counterparty.

The package has no root entry. Each folder of `src/` is one part of the code and one subpath.

## Folders

| Folder | Import | Holds |
|---|---|---|
| `src/protocol` | `@vsa/usecase-kit/protocol` | The contract of the agents: the forms of the identifiers, the requests and the messages, the digest of a proposal, the exit state rule, the codes with their HTTP statuses, the fault values, the manifest types with the co-sign route and rule, and the request limits. |
| `src/checks` | `@vsa/usecase-kit/checks` | The checks that a counterparty makes before it does the work of a job: the sender, the delegation, the payment from a vault and the approval. The run of a list of checks, and the `precheck` option of the service kit. |
| `src/fault` | `@vsa/usecase-kit/fault` | The fault switch. A fault value makes one agent do one wrong thing on purpose in a failure run. The setting is `FAULT_MODE`, and it is empty in a clean run. |
| `src/manifest` | `@vsa/usecase-kit/manifest` | What the agents add under `behaviour` of the manifest, with builders and parsers, and `renderManifest`, which gives the bytes of a manifest and their hash. |
| `src/cosign` | `@vsa/usecase-kit/cosign` | The route `POST /cosign/delegate` of a buyer-side agent. It adds the signature of a delegation key to a Delegate transaction, under one fixed rule. |
| `src/access` | `@vsa/usecase-kit/access` | The credentials that an agent needs for a call to a business system (tokens and SVIDs), the typed result of a call, and the sub-delegation of a subagent. |
| `src/decision` | `@vsa/usecase-kit/decision` | The decisions that an agent buys from a model. One decision is one hire, with limits that the caller must give, and no second try. |
| `src/buyer` | `@vsa/usecase-kit/buyer` | The flow of a buyer-side agent: it reads the authority of a request, finds the vault, hires the counterparty, and makes the results of the protocol. |
| `src/dispute` | `@vsa/usecase-kit/dispute` | The dispute path of an agent: the claim of a run, the documents for a juror, and the challenge. |

Each folder has a section below, except `buyer` and `dispute`. They have a row only.

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
| Identifiers | `Did`, `DelegationId`, `AttestationId`, `Salt`, `Digest`, `OutputRef`, `TenantId`, `KeyHash`, `ScriptHash`, `ModelName`; `parseDid`, `parseDelegationId`, `parseAttestationId`, `parseSalt`, `parseDigest`, `parseOutputRef`, `parseTenantId`, `parseKeyHash`, `isKeyHash`, `isScriptHash`, `isModelName`, `agentIdOf`, `didOfAgentId`, `newSalt` |
| JSON data | `JsonValue`, `JsonObject`, `Document`, `MAX_DOCUMENT_DEPTH`; `isPlainObject`, `parseJsonValue`, `parseDocument`, `parseCanonicalDocument`, `parseJsonText`, `checkMembers`, `readMembers` |
| Digest | `canonicalJson`, `canonicalSha256`, `proposalDigest` |
| Requests | `Authority`, `Proposal`, `RequestBase`, `ProposeRequest`, `ExecuteRequest`, `UseCaseRequest`, `ProposeFieldsParser`; `parseAuthority`, `parseProposal`, `parseRequest`, `makeProposal` |
| Messages | `Handoff`, `RfqMessage`, `PROPOSAL_SCHEMA`, `RESULT_SCHEMA`, `HANDOFF_SCHEMA`, `RFQ_SCHEMA`, `DOCUMENT_SCHEMAS`, `DocumentSchema`; `parseHandoff`, `parseRfq` |
| Approval | `ApprovalRef`, `ApprovalInput`, `ApprovalResult`, `ApprovalAccepted`, `ApprovalRefused`, `ApprovalRefusedByCheck`, `ApprovalDigestMismatch`, `ApprovalCheck`, `ApprovalRefusal`, `APPROVAL_ATT_TYPE`, `APPROVAL_VALIDITY_DEFAULT_MS`, `APPROVAL_VALIDITY_MAX_MS`, `APPROVAL_DEPOSIT_LOVELACE`; `parseApprovalRef` |
| Results | `ProposalResult`, `ProposedResult`, `FailedProposalResult`, `ExecuteResult`, `CompletedResult`, `DisputedResult`, `EscalatedResult`, `UnfiledDisputeResult`, `RefusedResult`, `RefusedExit`, `VaultRefusedResult`, `FailedResult`, `Decision`, `PaidDelivery`, `SubJob`, `HandoffRecord`, `WriteRecord`, `ChallengeRecord`, `ReceiptVerification`, `ReceiptCheck`, `RECEIPT_CHECKS`, `NO_OPEN_CLAIM`, `ExitStateInput`; `exitStateOf`, `refusedExit` |
| Codes | `USE_CASES`, `HANDOFF_USE_CASES`, `OPERATIONS`, `OUTCOMES`, `PROPOSE_OUTCOMES`, `EXECUTE_OUTCOMES`, `EXIT_STATES`, `ERROR_STATUS`, `REFUSAL_CODES`, `SENDER_REFUSALS`, `DELEGATION_REFUSALS`, `VAULT_REFUSALS`, `APPROVAL_REFUSALS`, `COUNTERPARTY_REFUSALS`, `AFTER_CLAIM_REFUSALS`, `SYSTEM_REFUSALS`, `SYSTEM_REFUSAL_STATUS`, `ErrorCode`, `ErrorBody`, `RefusalCode`, `SystemRefusal`, `Outcome`, `ProposeOutcome`, `ExecuteOutcome`, `ExitState`, `UseCase`, `HandoffUseCase`, `Operation`; `isErrorCode`, `isRefusalCode`, `isSystemRefusal` |
| Kinds and faults | `BUYER_SIDE_KINDS`, `COUNTERPARTY_KINDS`, `AGENT_KINDS`, `BuyerSideKind`, `CounterpartyKind`, `AgentKind`, `FAULT_MODES`, `FaultMode`, `FaultSetting`; `isAgentKind`, `isFaultSetting` |
| Manifest | `BehaviourAdditions`, `ManifestClaim`, `ClaimStatement`, `ManifestCosign`, `ManifestModel`, `ManifestRelyingOn`, `ManifestFileRef`, `COSIGN_ROUTE`, `COSIGN_RULE` |
| Limits | `MAX_REQUEST_BYTES`, `RUNTIME_BODY_LIMIT_BYTES`; `checkRequestSize` |

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

### Copies

A parser reads each member of its input one time, as data, and builds a new plain value while it checks. It works on that copy and it returns that copy: the `document` of a proposal, the `document` of a handoff and the `rfq` of a request for quotation share no object with the input. So the digest that a result carries is the digest of the value that the result holds. A getter, a Proxy and an array of another kind cannot give a parser a second value, and cannot make it throw. A parser refuses an accessor member (`bad_shape`), an array that is not a plain array, and a Proxy that throws or is revoked. The fields of a `propose` request reach the parser of the use case as copies of plain JSON data.

The document of a proposal, of a handoff and of a request for quotation holds each text in the NFC form, which is the form that the digest binds. So a service works on the bytes that its digest covers. `parseCanonicalDocument` makes this copy, and the parsers of the messages use it. `parseDocument` and `parseJsonValue` keep each text as it came: a text that a model or a supplier wrote is recorded as it was written, and the fields of a `propose` request reach the use case as they came.

### Documents and the digest of a proposal

`proposalDigest(salt, document)` is the SHA-256 of the 32 bytes of the salt followed by the UTF-8 bytes of the canonical text of the document. The salt comes first. `makeProposal` makes the salt (or takes one) and the digest. `parseProposal` refuses a digest that is not the digest of its document and its salt.

The canonical text has the keys of each object in the order of their UTF-16 code units, every string value in the NFC form, no white space, and numbers as `JSON.stringify` writes them. It is the text that `canonicalize` of the buyer code writes. `test/protocol/canonical-drift.test.ts` holds the two together on generated documents.

The protocol takes a document only when the two give the same text. It refuses a value that JSON cannot hold (`undefined`, a function, a bigint, `NaN`, an infinite number, a hole in an array), an object that is not a plain object, an accessor member, the key `__proto__`, a key that is a whole number, a key that is not in the NFC form, and a value that is nested more than 32 levels deep.

`DOCUMENT_SCHEMAS` gives the `schema` of the document of each use case: `vector.usecase.po.v1` (the purchase order), `vector.usecase.priorauth-request.v1` (the prior-authorization request) and `vector.usecase.ranking.v1` (the ranking). It holds names only. Each use case defines the shape of its document. Use case 3 has no handoff, so `HANDOFF_USE_CASES` lists use case 1 and use case 2, and a handoff for use case 3 is refused.

### Results and the exit state

A buyer-side agent answers 200 with an `outcome` whenever it could read the request. `exitStateOf` gives the exit state of an `execute` result. It is the one rule for every buyer-side agent, and the result types agree with it: a result with a pair of outcome and exit state that the function cannot give does not compile. The one exception is the reason `approval_expired` with the state `Rejected`: the type of a refused result cannot refuse that pair.

| Outcome | Exit state |
|---|---|
| `completed` | `Completed` |
| `disputed`, with a challenge filed | `Escalated` (the reason is `null`) |
| `disputed`, with no challenge filed | `Failed` (the reason is `NO_OPEN_CLAIM`, or the code of the step that failed) |
| `refused_by_counterparty`, `refused_by_system` | `Expired` for the reason `approval_expired`, `Cancelled` for the reason `delegation_ended`, and `Rejected` for any other reason |
| `vault_refused` | `Cancelled` when the agent read the delegation after the refusal and found that the hirer ended it, and `Failed` in every other case |
| `failed` | `Failed` |

A result is made with no cast. A form that has one state has that state written in it: `Completed` for `completed`, `Failed` for `failed`, `Escalated` for a dispute with a challenge, and `Failed` for a dispute with no challenge. A `vault_refused` result takes `exit_state: exitStateOf({ outcome: 'vault_refused', ... })`. For an outcome that the compiler knows, the type of that call is the state type of the result. For an outcome that only the run knows, the type is `ExitState`. A refused result takes `...refusedExit(reason)`, as in `{ ...base, outcome, ...refusedExit(reason), challenge: null }`. It gives the reason and its exit state together, and the type of a refused result needs that pair. `exit_state: exitStateOf(...)` does not compile in a refused result, because its type does not prove that the state goes with the reason.

A proposal that was made has the exit state `null`. A proposal that failed has `Failed`.

### Errors and refusals

`ERROR_STATUS` gives the HTTP status of every code of an agent. A refusal code of a counterparty is a 403. A refusal comes before the Claim, so the escrow stays Open and nothing is paid. One refusal comes after the Claim: `cannot_supply`, the decision of the Order Desk (`AFTER_CLAIM_REFUSALS`). The buyer sees a job that failed after the Claim, and the escrow is Claimed until the buyer reclaims it after the deadline. `COUNTERPARTY_REFUSALS` lists the codes that each counterparty can answer, in the order of its checks.

`check_unavailable` (503) means that a check of a counterparty could not read its source, the ledger or the gateway. It is never a pass. It is an error code and not a refusal code of a rule, so it is not in `REFUSAL_CODES`.

`refused_by_counterparty` has the code of the counterparty as its `reason`. `vault_refused` has the evaluation error of the node as its `reason`. `refused_by_system` has the code of the mock system as its `reason`. `SYSTEM_REFUSALS` and `SYSTEM_REFUSAL_STATUS` list the refusals that the protocol names for a mock system, with their statuses: `token_invalid` (401), and `not_covered`, `delegation_ended`, `chain_too_deep`, `supplier_not_active` and the eight approval codes (403). A mock system can answer other codes of its own, for a client certificate, a tenant or a host. A buyer-side agent passes any code on as the reason, so a reason that is not in the list is not an error.

### The approval check

The protocol holds the types of the check and not the function. `ApprovalInput` has the approval reference or `null`, the DID of the sender, the delegation, the document and the salt that were received, and the time. `ApprovalResult` is `{ ok: true, ... }` or `{ ok: false, code, detail }` with one of the eight `APPROVAL_REFUSALS`. A digest mismatch also carries the two digests, because a challenge needs both.

A check can throw when it cannot read a source, such as the ledger or the gateway. A caller treats a throw as "not available" (503). It is never a pass, and it is never a refusal of a rule. The checks folder throws `CheckUnavailableError` in this case, and the mock service answers 503 `approval_unavailable`.

### The manifest

`BehaviourAdditions<K>` gives the members that an agent of kind `K` adds under `behaviour`. With no kind, the type is the union of the six kinds: an object is the additions of exactly one kind, and never a mix of the members or the fault values of two kinds.

`COSIGN_ROUTE` is the path of the co-sign route, `/cosign/delegate`, and `COSIGN_RULE` is the rule of the co-signature in words. The cosign folder states this rule, and the manifest of a buyer-side agent holds it. There is one text of each.

### What the protocol does not prove

The protocol holds types, parsers and tables. It reads no setting and no file. It proves the form of a message and the digest of a proposal. It does not prove that an approval is on the ledger, or that a counterparty runs the check. The checks folder and the mock services do that.

## Limits

**The request limit.** `MAX_REQUEST_BYTES` (900,000) bounds the wire payload that a service takes, counted in bytes. The wire payload is the request text written as a string inside a one-message JSON array. The limit does not bound the body of the call that a sender makes to the runtime in front of the service. The sender puts the wire payload inside a second JSON object, and each quote mark and each backslash gets one more byte again. So the body can pass `RUNTIME_BODY_LIMIT_BYTES` (1,048,576) while the wire payload is under the request limit, and the runtime refuses such a body. A sender must also keep the body of its call at or below `RUNTIME_BODY_LIMIT_BYTES`. `checkRequestSize` checks the wire payload only.

**The Unicode tables.** The canonical form puts each string value in the NFC form with the Unicode tables of the Node that runs. Two hosts with different Unicode versions can disagree on a character that only the newer version knows, and then their digests of one document differ. Run all parties on one Node line.

**Hostile values.** The parsers defend against a value that changes between two reads and against a changed prototype; a process that replaces a built-in function (for example `Object.keys`) is outside what they defend against.

## The checks folder

**What it is for.** The checks that a counterparty (the Order Desk, the Insurer Intake Agent and the bid desk) makes before it does the work of a job. A refusal comes before the Claim, so the escrow stays Open and nothing is paid.

**Main exports.** `sharedChecks` and `SHARED_CHECK_NAMES` (the sender, the delegation, the vault payment and the approval, in order), `runChecks` (runs a list in order and stops at the first refusal), `precheckOf` (the `precheck` option of the service kit), `checkApproval` and `approvalCheckOf`, `ledgerPortOf`, and `CheckUnavailableError`.

**What a caller must give.** The ports of `ChecksPorts`: the clock, the resolver of the identity gateway, and the ledger. `ledgerPortOf(env)` makes the ledger port from a `LedgerEnv`. Its reads end inside `env.budgetMs`, and the runtime waits 10 seconds for a pre-check, so give an `env` with a short `budgetMs`. The buyer key `buyerPkh` comes from the job context of the runtime, which read it from the escrow. It never comes from the body of the request. The code reads no environment variable and no key file.

**The contract of a caller.** `checkApproval` throws `CheckUnavailableError` when a source cannot be read. A caller answers 503 (`check_unavailable`) for the throw. It never reads the throw as a pass, and it never reads it as the refusal of a rule. `runChecks` and `precheckOf` do this for a list of checks. A refusal of a rule is a 403 with its code.

**What it does not prove without a chain.** An approval attestation has not run on mainnet in this form: its path is tested on fixture data. The check of the vault payment is tested on one captured mainnet payment.

## The fault folder

**What it is for.** The fault switch of failure runs. A fault value makes one agent do one wrong thing on purpose, so that the other agents and the checks can show how they answer. A fault never changes a check: no check function of the kit takes a fault value.

**Main exports.** `readFaultSwitch`, `withFaultMode` and `withFaultModeJob`, `readFaultMode` and `checkFaultMode`, `checkCleanRun` and `checkFaultRun`.

**The setting.** `FAULT_MODE`. It is empty in a clean run. The caller reads the environment and gives the value: `readFaultSwitch(kind, process.env.FAULT_MODE)` one time, at the start. A value that the kind does not list stops the start, and the error names the variable and the allowed values. The code reads no environment variable.

**The contract of a caller.** A service gives each result the field `fault_mode` with one helper, so job code cannot leave it out or write another value. A run script calls `checkCleanRun` before a clean run and `checkFaultRun` before a fault run, and the same guard again after the run.

**What it does not prove.** A guard reads the environments that a script gives it, at one time. It does not read a running process, so a service that starts again with another value after that read is not seen. The field `fault_mode` of each result is the second proof of what the process did.

## The manifest folder

**What it is for.** What the agents add under `behaviour` of the manifest `vector.agent-manifest.v2`: the operations, the three claim statements, the co-sign rule, the possible fault values, the models, the systems that the agent relies on, and the files of an order desk and of a bid desk.

**Main exports.** `buildBehaviour` and `parseBehaviourAdditions`, `faultGap` and `withFaultGap`, `renderManifest`, the parsers of the fields (`parseClaim`, `parseModel`, `parseRelyingOn` and `parseFileRef`), and `COSIGN_ROUTE` and `COSIGN_RULE`, which the protocol holds.

**What a caller must read.** The builders take the kind of the agent, and never the fault setting. `renderManifest` builds the manifest for the empty setting two times and for each fault value of the kind one time, and it refuses when the bytes differ. A template (`{ template: true }`) has a placeholder `<NAME>` for each value that the operator gives, and it is never served. A served manifest has no placeholder.

**What it does not prove without a live service.** The bytes and the hash are the same for every setting and every render in one process. The folder does not prove that the service serves these bytes at `/agent.json`, or that the advert on the chain holds this hash.

## The cosign folder

**What it is for.** The route `POST /cosign/delegate` of a buyer-side agent. A Delegate transaction needs the signature of the delegator and of a delegation key of the agent that gets the delegation. A person who delegates cannot get the second signature. The route adds it, under one fixed rule: `COSIGN_RULE`.

**Main exports.** `createCosignRoute` (it gives `path`, `cosign` and `handle`), `COSIGN_MANIFEST`, `parseCosignSettings` and `COSIGN_SETTINGS`, `parseAllowlist` and `addToAllowlist`, `providerLedger`, `KeyReservations`, `COSIGN_REFUSALS` and `COSIGN_STATUS`.

**The settings.** `COSIGN_ALLOWLIST` is the list of principal keys that a delegation may come from. It is required, and an empty text means nobody. `COSIGN_MAX_CONCURRENT` is 1 to 64, and the default is 4. `COSIGN_MAX_FUTURE_MS` is 60,000 to 3,600,000, and the default is 3,600,000. `COSIGN_LEDGER_TIMEOUT_MS` is 50 to 30,000, and the default is 5,000. The route reads no environment variable and no key file. The service gives the texts of the settings, the sign function of each delegation key, and the clock.

**The contract of a caller.** The delegator signs the Delegate first. The agent signs only a body that the delegator signed first. A request with no witness of the delegator that verifies over the body gets 403 `principal_not_allowed`, before the allowlist, the register and the ledger are read. A tool that builds the transaction must ask the delegator to sign before it calls the route. The register of signed bodies (`KeyRegister`) must be shared and durable for a service that runs more than one process, or that restarts. The default, `KeyReservations`, is in memory, it belongs to one route, and a restart forgets it.

**What it does not prove without a chain.** That the ledger accepts the co-signed transaction, and a real call from a hosted tool.

## The access folder

**What it is for.** The credentials that an agent needs for a call to a business system, and the sub-delegation of a subagent. A sub-delegation ends in a `finally` path, after a return, a refusal, a throw and a timeout of the job.

**Main exports.** `tokenTarget`, `x509Target` and `jwtSvidTarget` (the target of a call), `requestRouteToken` and `requestSubagentToken`, `callWithToken`, `callWithJwtSvid` and `callWithX509Svid` (one call, one typed result, no second try), `fetchX509Svid` and `fetchJwtSvid`, `withSubDelegation`, `deploymentSlotAt`, `txSignerOfRawKey`, and `createSerialQueue`.

**What a caller must give.** The folder reads no key file and no environment variable. Every access to the gateway, the ledger, HTTP and the clock is a parameter. `MockBases` holds the two origins of the mock service: `publicBase` (the setting `MOCK_PUBLIC_BASE`) and `mtlsBase` (the setting `MOCK_MTLS_BASE`). They are two https hosts.

**The contract of a caller.** A left sub-delegation (`LeftSubDelegation`) may be alive. The janitor ends it with the Undelegate, and the key of the agent signs. The janitor may drop the reference only when two things hold: the slot of the chain tip is at or past `delegateTtlSlot`, and the ledger does not show the Delegate (the delegation `id` that the transaction `delegateTxHash` made). Then the Delegate never lands. A Delegate that the ledger shows is live, and the janitor ends it with the Undelegate: the slot of the tip does not change this. The janitor compares slots, and never the clock with `delegateValidTo`: the TTL is in the signed bytes, and the time is only what the build port reported. The chain port (`DelegationChain`) needs the method `slotAt`, and `deploymentSlotAt` gives it for the identity deployment. `withSubDelegation` needs the bases of the mock service in its `deps`: the resource of a sub-delegation is `<publicBase>/t/<tenant>/<system>`, and a target on another host gets no sub-delegation.

**What it does not prove without a chain and a live gateway.** The wait for 30 confirmations and the submit are ports, and their adapters come with the agents. The folder does not prove the TLS handshake with a real client-certificate host.

## The decision folder

**What it is for.** The decisions that an agent buys from a model. `decide(deps, spec, input)` builds the prompt from the fixed text of the decision and its input, hires a model from the service key with `hireModel` of `@vsa/hire-kit`, reads the answer with the parser of the decision, and returns the `Decision` of the protocol. A failure holds no decision.

**Main exports.** `decide`, `DecisionSpec` and `ChoiceParser`, `checkLimits`, `parseModelAllowlist` and `parseMaxPrice`, `buildPrompt`, `HIRE_MIN_MS` and `MAX_PROMPT_BYTES`.

**The settings.** `LLM_MODEL_ALLOWLIST` is a comma-separated list of models, and it has no default. `LLM_MAX_PRICE_LOVELACE` is the price ceiling, and it has no default. The two bond limits are a `bigint` or `null`. All four limits are required parameters of `decide`. A missing limit is a refusal, and nothing is hired.

**The contract of a caller.** The prompt asks the model for ONE JSON object and nothing else. The reader takes think blocks at the start and one code fence around the object, and it refuses any other text (`model_output_invalid`). A hire starts only with 60 seconds left before the deadline of the run (`HIRE_MIN_MS`). The same rule holds when the hire waits in the lane of the service key: the request gives `minLeftAtTurnMs` to the hire kit. A failure after an Accept says that the supplier is paid, or may be paid, and it carries the delivery.

**What it does not prove.** A live supplier and the output of a real model, which can put words around the object that the reader wants.

## Tests

`pnpm test` in this folder runs vitest. Each refusal has a test with an accepted twin. `pnpm typecheck` also checks the lines of the tests that must not compile (`@ts-expect-error`). No test uses the network.
