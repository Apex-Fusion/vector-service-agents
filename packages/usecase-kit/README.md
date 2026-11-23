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
| `src/dispute` | `@vsa/usecase-kit/dispute` | The Module-1 path of an agent: the documents for a juror, the claim of a run and its withdrawal, and the challenge of a buyer-side agent and of a counterparty. |

Each folder has a section below.

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
| Queue | `SerialQueue` |

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

A buyer-side agent answers 200 with an `outcome` whenever it could read the request. `exitStateOf` gives the exit state of an `execute` result. It is the one rule for every buyer-side agent, and the result types agree with it: a result with a pair of outcome and exit state that the function cannot give does not compile. The one exception is a reason that has a state of its own (`approval_expired`, `delegation_ended`, and `approval_digest_mismatch` from the counterparty) with the state `Rejected`: the type of a refused result cannot refuse that pair.

| Outcome | Exit state |
|---|---|
| `completed` | `Completed` |
| `disputed`, with a challenge filed | `Escalated` (the reason is `null`) |
| `disputed`, with no challenge filed | `Failed` (the reason is `NO_OPEN_CLAIM`, or the code of the step that failed) |
| `refused_by_counterparty` | `Escalated` for the reason `approval_digest_mismatch` (the counterparty also challenges the claim of the sender), and else as `refused_by_system` |
| `refused_by_system` | `Expired` for the reason `approval_expired`, `Cancelled` for the reason `delegation_ended`, and `Rejected` for any other reason (a mock system files no challenge, so its `approval_digest_mismatch` is `Rejected`) |
| `vault_refused` | `Cancelled` when the agent read the delegation after the refusal and found that the hirer ended it, and `Failed` in every other case |
| `failed` | `Failed` |

A result is made with no cast. A form that has one state has that state written in it: `Completed` for `completed`, `Failed` for `failed`, `Escalated` for a dispute with a challenge, and `Failed` for a dispute with no challenge. A `vault_refused` result takes `exit_state: exitStateOf({ outcome: 'vault_refused', ... })`. For an outcome that the compiler knows, the type of that call is the state type of the result. For an outcome that only the run knows, the type is `ExitState`. A refused result takes `...refusedExit(outcome, reason)`, as in `{ ...base, ...refusedExit(outcome, reason), challenge: null }`. It gives the outcome, the reason and its exit state together, and the type of a refused result needs that triple. `exit_state: exitStateOf(...)` does not compile in a refused result, because its type does not prove that the state goes with the reason.

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

### The queue of a key

`SerialQueue` is the type of the queue of one wallet key. `run(job)` starts the job when every job before it has ended, whatever the outcome of those jobs. A job that fails does not stop the next one. The build and the send of a transaction from the wallet of a key run in this queue, so two builds of that wallet do not run at one time. The dispute folder and the access folder take the queue as a parameter, and the dispute folder names the type `ServiceQueue`. A service makes one queue for each key and gives the same object to both folders and to its hires. `HireLane` of the hire kit is such a queue, and `createSerialQueue` of the access folder makes one in memory.

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

## The buyer folder

**What it is for.** The flow of a buyer-side agent. It reads the delegation of a request, finds the one Live vault of that delegation, and hires the counterparty from the vault with `hireAgent` of `@vsa/hire-kit`. The delegation key signs the Pay and the Accept. Each end of a hire is one typed step, and helpers make the results of the protocol from the steps.

**Main exports.** `hireCounterparty` (it gives a `HireStep`, and only `completed` is a pass), `checkAuthority`, `findLiveVault`, `checkAdvertAgent`, `checkLimits`, `ledgerReadsFrom`, `stepOfOutcome`, the size checks that come before the Pay (`checkWirePayload` and `checkRuntimeBody`), and the helpers of results (`proposedResult`, `failedProposalResult`, `completedResult`, `refusedResult`, `vaultRefusedResult`, `failedResult`, `disputedResult` and `settledResult`).

**What a caller must give.** `HireDeps` has the paying key (`key`: the delegation key, whose chain must pay from a vault), the deps of the hire kit (`hire`: the fetch, the clock, the sleep, the deadline, the ledger that books the lock and the fees, and the log) and the reads of the ledger (`reads`: `ledgerReadsFrom(env)` makes them from a `LedgerEnv` of buyer-core). The three limits of a hire are required: `maxPriceLovelace`, `maxSupplierBondLovelace` and `maxBuyerBondLovelace`. Each is a `bigint` or `null`. The caller reads them from the settings of the agent, and the folder never fills in a limit that is missing. The flow reads the advert on the chain, and it never asks the indexer.

**The contract of a caller.**

- One call of `hireCounterparty` is one hire, and it makes at most one Pay. No step retries. Three calls with the same handoff make three Pays. A caller calls again for a job only when the result says that nothing was paid: the step `refused`, the step `vault_refused`, or a failure that ended before any Pay. A Pay that was sent and not seen confirmed (`pay_unconfirmed`) may still land, and no other Pay of the same key starts before its validity ends (`earlier_pay_may_land`). The flow keeps this state, and its lane, for the `PayingKey` object in memory: use one `PayingKey` for one key.
- A `completed` step can carry `booking_failed`. The ledger of the caller threw when the hire kit booked the fee of the Accept. The Accept is on the chain, and the work is paid for, so the step stays `completed`. `booking_failed` holds `accept_tx_hash` and `fee_lovelace`. The hire kit gives the ledger the fee and the hash of the Accept (`HireLedger.accepted`), and `accept_tx_hash` is that hash. It is `null` only when a chain broke its own type and gave no hash: the step never makes one up. The ledger may have written the booking before it threw. The caller checks its ledger by `accept_tx_hash` before it books the fee again.
- Before the Pay, the agent of the advert must be the counterparty. The flow reads the advert of the document on the chain before it reads a vault. The advert must name the counterparty as its agent: the DID is `did:vector:` and the `agent_id` of the advert, compared as text. Another agent, and an advert with no agent, are `advert_not_counterparty`, and nothing is paid. The hire kit checks the agent of the receipt against the agent of the advert, and never against the counterparty of the document, so this check ties the Pay to the counterparty.
- The first thing that the hire kit does after the Pay is to wait one poll interval. The flow checks that the deadline of the job leaves that time, and it asks the hire kit for the same time at its turn in the lane (`minLeftAtTurnMs`). A hire that waited too long ends with the reason `deadline`, and nothing is paid.
- The hire kit checks the size of the body again before its Pay (`RUNTIME_BODY_LIMIT_BYTES` of `@vsa/hire-kit`). The flow checks it first and gives `request_too_large`. The check of the kit is a second line of defence: it throws the `unavailable` error of the factory of the caller, and the flow never reaches it, because its own check refuses the same body first. For a vault hire the two bodies have the same size, because a vault Pay opens its escrow at output 0. A test pins the limit of the kit to the limit of the protocol.

**What it does not prove without a chain.** The reads of a vault and of a delegation on mainnet, and the lag of the indexer right after a Pay.

## The dispute folder

**What it is for.** The Module-1 path of an agent. A run stakes a claim, and the claim document states the three statements of the manifest of the agent. A buyer-side agent whose model does not accept a delivery files a challenge against the open claim of the counterparty. A counterparty that refuses a request because the digest of the approval is wrong files a challenge against the open claim of the sender. The challenge holds an evidence document that states the contradiction with its values: the SKU, the lot and the quantity of a purchase order (use case 1), the unit price of a quote (use case 3), or the digest of an approval against the digest of the request (use case 2). A claim that nobody challenges is withdrawn after its challenge window. A document for a juror has two limits: at most 3,000 bytes, and at most `JUROR_RECORD_LIMIT_BYTES` (4,300) bytes when its text is escaped twice for the record of a juror. A text with many quote marks or backslashes reaches the second limit first. A document that is too large is refused (`document_too_large`), and it is never cut.

**Main exports.** `Dispute` has `stakeRunClaim`, `withdrawClaim`, `challengeDelivery`, `challengeApproval`, `findOpenClaim` and `listOpenClaims`. `createModule1Port` makes the chain port over the builders of `@vsa/buyer-core`. `claimDocument` and `evidenceDocument` write the documents, and `readClaimDocument` and `evidenceReferences` read the bytes of a document back. `disputedFields` gives the members of the `disputed` result of the protocol. `MemoryJournal` is the default journal, and `DisputeJournal` is its port. `LEAST_RESOLUTION_DEADLINE_MS` is the least resolution deadline of a challenge.

**What a caller must give.** `DisputeDeps` has the chain `port`, the `queue` of the service key, the `clock`, a `sleep` that bounds each read of a port, the `settings`, and optionally a `journal` and a `log`. The `queue` is the `SerialQueue` of the protocol, and this folder also names the type `ServiceQueue`. Give the queue that runs the hires of the same key, because a Module-1 build spends every output of the wallet but one. The timer of `sleep` must not hold the process open. `log` gets one line for each step, with references of the chain and codes, and never a key or a part of a request. `createModule1Port` takes the node provider, the Module-1 deployment, the wallet address, the id of the agent, a `sign` function, the `clock` and the `sleep`, the URL of Koios with its `fetch`, and the identity deployment or `null`. The code never holds a key: the caller closes `sign` over the service key. With `null` as identity deployment, a challenge is refused (`bad_shape`), and the service can still stake and withdraw claims. `DisputeSettings` has no default for `challenge_stake_lovelace` (a `bigint` above 0), `min_window_left_ms` (at least 2,000) and `read_timeout_ms`. `resolution_deadline_ms` is optional. When it is set, it must be the value of the Module-1 deployment. The value of the deployment must be at least `LEAST_RESOLUTION_DEADLINE_MS` (6 hours and 40 minutes), and the constructor refuses less: the relay opens no case for a challenge with less. `started_lease_ms` is optional. The default is 10 minutes, or twice `read_timeout_ms` when that is more. A value below twice `read_timeout_ms` is refused. The constructor throws for a setting of the wrong type or out of range, before anything is read.

**The contract of a caller.**

- The scope of a job. A challenge takes `escrow_ref`, `capability_id` and `statement_text`, and `findOpenClaim` takes the same three as its `scope`. `escrow_ref` is the output that the Post of the job made. `capability_id` is the capability that the job hired, and the caller knows it from the advert. `statement_text` is the text of the statement S1 of the manifest of the agent that the job hired, and the caller has that manifest. A scope that is not in its form is `bad_shape`, and the detail names the member.
- The escrow is bound to the job, and the start of the job is the block of the Post. The port reads `escrow_ref` from the chain. The code takes it only when its datum has the identity layout, its `capability_id` is the capability of the scope, and its `agent_id` is the agent that the job hired: the counterparty for a delivery, this agent for an approval. Any other output is `bad_shape`: the escrow of another job, an escrow of the legacy layout (its datum names no agent), and an output that is no escrow output of the deployment. The output must be the output that the Post made: the state of its datum is Open. Koios keeps that datum after the output is spent. An output of a later step (the Claim or the Submit) is `bad_shape`, because its block is later than the start of the job. The start of the job is the time of the block that holds the transaction that made the output. The chain port reads it, and the caller gives no time. The member `posted_at` of the datum is never used: the poster writes it, and no validator checks it. A block that is dated after the clock is `chain_unavailable`. The code reads the escrow only when the other party has an open claim.
- The target and the skips. The other party cannot choose the target of a challenge. A claim is a target only when all of these hold. Its claimer is the other party. It is Open, and it has at least `min_window_left_ms` left of its window. It was submitted before the start of the job. Its stake is not above `challenge_stake_lovelace`. Its claim document is on chain with the hash that the claim holds, it is the document that `claimDocument` writes for the claimer, it is for the capability of the job, and it has `statement_text` as its statement S1. Two texts with the same NFC form are one text: this includes the forms NFC and NFD of a text, and a character that NFC replaces by another (for example the Kelvin sign and the letter K). Any other difference, such as a look-alike letter of another script, makes another text. Among the targets, the code takes the one with the latest challenge deadline, and with the same deadline the one with the lowest claim token. A claim that is not a target is skipped and counted by its reason: `window`, `began` (submitted at or after the start of the job), `stake`, `no_document` (the document is not on chain, or it is not a document), `not_kit` (it is not a claim document of this kit), `capability` and `statement`. When no target is left, the result is `no_open_claim`. When the other party has open claims, its detail gives the count for each reason. A source that cannot be read, or that answers in a wrong shape, is `chain_unavailable`. It is never a skip, and it is never `no_open_claim`.
- The journal must be durable for a service that must not file a job twice after a restart. A job is one escrow, and it gets one challenge. The code reads the journal first. It writes the record `started` before it sends the evidence, `evidence_landed` after the evidence lands, and `done` at the end. A job whose record says that a transaction landed or may land takes no second attempt, also after a restart. Only the record `started` lapses (see the lease). A second call for a job that filed a challenge gives the same challenge. The default `MemoryJournal` keeps the records in memory, and a restart forgets them. A durable journal keeps the records on disk, and its `put` returns only when the record is stored. A journal that cannot be read, that gives a record that is not in its form, or that gives the record of another escrow gives `journal_unavailable`, and nothing is sent. So does a write of the record `started` that fails. A write that fails after a transaction landed is logged, and it changes no result. The journal has no lock across processes.
- The lease and the claim of the record. A record `started` says that the evidence of the job may be on chain. It blocks the job for `started_lease_ms`, counted from the time in the record. After that time, the code first looks for a challenge of this agent for the job on chain, and that challenge is the result. When there is none, the job goes on only against the claim that the record names, and that claim goes through the same rules of a target. The code ends the job with `claim_changed` when the claim is spent, is not Open, is another claim, or has no window left. It ends the job with `claim_window_closing` when some window is left, but too little for the evidence to confirm. It sends nothing then. The first try can land while the second try runs. The second try then ends with `claim_changed`, with `challenge_not_built`, or with `challenge_not_confirmed` and `may_land` false. The code then looks again for a challenge of this agent. When it finds the challenge of the first try, that challenge is the result, and `extra_evidence` names the evidence document of the second try. Two processes can both go on after a lease ends. They go on against the same claim, and the chain takes only one challenge for a claim, so a job never files two challenges.
- No cap on the candidate claims. A candidate is an open claim of the other party with enough window left, submitted before the start of the job, and with a stake that is not above the challenge stake. The code does not limit the number of candidates. It reads the claim document of each candidate in turn, in the order of the choice, and it stops at the first target. A candidate costs one read, or two when the source does not have the transaction of the document yet. Each read has the bound `read_timeout_ms`, and the sum of the reads has no bound. A claimer that holds many open claims that are not targets makes the search longer. The code checks the window of the chosen claim again in the job of the queue, before it sends the evidence (`claim_window_closing`). After that check, the job reads and writes the journal, and each of the two steps can take up to `read_timeout_ms`. So give `min_window_left_ms` room for two times `read_timeout_ms` more than the time that the evidence and the challenge need to confirm.
- The escrow binds the agent and the capability, not the buyer. The datum of an escrow also names the buyer key, the supplier key and the advert, but the code compares only its capability and its agent. So it cannot tell apart two jobs for the same hired agent and the same capability: for a delivery, the job of another buyer that hired the same agent; for an approval, the job of any sender. The caller names the escrow of its own job, and the start of the job is the block of the escrow that the caller names.
- A counterparty answers the refusal `approval_digest_mismatch` first, and it calls `challengeApproval` after that. The reference of the challenge goes to the log and to the result. The counterparty must not put it into the message of the refusal.
- The result says what landed. A step that fails says what landed before it stopped: the evidence document (`evidence`), a transaction that was sent and not seen confirmed (`sent`, which can still land before `valid_to` unless `may_land` is false), a challenge that landed against another claim than the one that the evidence names (`challenge`), and a document with another hash than the one that was built (`wrong_document`). `disputedFields(result)` gives `Escalated` with the record of the challenge when it is filed, and `Failed` with the code of the step as the reason in any other case. The reason is `no_open_claim` when the other party has no open claim.

**What it does not prove without a chain.** The tests run the real chain port over the fixture world of the buyer code, where Lucid runs the Module-1 scripts in every build, and a scripted port for the other cases. They do not prove that a juror reads these documents, that the relay opens a case for a challenge, the fees and the timing of a real node, or the lists of a live Koios.

## Tests

`pnpm test` in this folder runs vitest. Each refusal has a test with an accepted twin. `pnpm typecheck` also checks the lines of the tests that must not compile (`@ts-expect-error`). No test uses the network.
