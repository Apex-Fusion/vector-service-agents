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
| `src/janitor` | `@vsa/usecase-kit/janitor` | The list of the sub-delegations that a run left alive, in memory and on disk, and the janitor that ends them with the Undelegate. |
| `src/decision` | `@vsa/usecase-kit/decision` | The decisions that an agent buys from a model. One decision is one hire, with limits that the caller must give, and no second try. |
| `src/buyer` | `@vsa/usecase-kit/buyer` | The flow of a buyer-side agent: it reads the authority of a request, finds the vault, hires the counterparty, and makes the results of the protocol. |
| `src/dispute` | `@vsa/usecase-kit/dispute` | The Module-1 path of an agent: the documents for a juror, the claim of a run and its withdrawal, and the challenge of a buyer-side agent and of a counterparty. |
| `src/inventory` | `@vsa/usecase-kit/inventory` | The documents of use case 1 (inventory reorder) that the Reorder Agent and the Order Desk share: the purchase order, the lots file and the order confirmation, each with a strict parser, and the lot names, the capabilities and the claim statements of the two agents. |
| `src/live` | `@vsa/usecase-kit/live` | The parts that a buyer-side agent needs on a real chain: the real `DelegationChain` of a sub-delegation over the builders of `@vsa/buyer-core`, the slot of the tip of the node, and the key object of a raw Ed25519 key. |

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

## The janitor folder

**What it is for.** The sub-delegations that a run made and did not see ended. `withSubDelegation` ends each sub-delegation in a `finally` path. When the end fails, the result is `not_ended` with a `LeftSubDelegation`: the delegation may be alive, and the delegation key of the subagent stays in use until the Undelegate lands. An expiry does not free a key. The janitor reads the list of these references and ends each live delegation with the Undelegate. The buyer-side agents of the three use cases use it in the same way.

**Main exports.** `FileLeftStore` and `MemoryLeftStore` (the list: `put`, `list` and `remove` of a `LeftEntry`), `DamagedLeftEntriesError`, `parseLeftEntry`, `runJanitorOnce` (one pass) and `startJanitor` (a pass at once, then one after each interval, and never two at one time), `JanitorDeps`, `JanitorReport` and `JANITOR_STATES`.

**What a caller must give.** `JanitorDeps` has these members. The folder reads no key file and no environment variable.

| Member | What it is |
|---|---|
| `store` | The list: a `FileLeftStore` on a folder of the state volume of the service. |
| `chain` | The `DelegationChain` of the sub-delegation. The janitor uses `readDelegation`, `buildUndelegate` and `submit`. |
| `delegationScript` | The delegation script of the identity deployment: the same value that `SubDelegationDeps` takes. The janitor signs only a transaction that burns the token of this script. |
| `signerOf(keyHash)` | The signer of a delegation key and the address of its wallet, or `null` when the service has no such key. The key hash is the `signer_key_hash` of the entry: the live delegation key of the agent, which is the delegator of the sub-delegation. |
| `queueOf(keyHash)` | The queue of that key, with a member `busy`. It is the one object that the service gives to the hires of the key and to `walletQueue` of `withSubDelegation`. `HireLane` of the hire kit is such a queue. |
| `tipSlot()` | The slot of the tip of the chain, from the node. It rejects when the node gives no slot. |
| `clock`, `log` | The clock port, and one function that takes one line of text. |
| `inFlight(id)` | Required. True while a run of this process still uses the sub-delegation. A process that makes no sub-delegation gives a function that answers false. See the contract below. |
| `entryTimeoutMs`, `pollMs`, `stopWaitMs` | Optional bounds, in milliseconds from 1 to one day: the time for one entry (60,000), the time between two reads of the ledger after the send (5,000), and the wait of `stop` for the pass in flight (30,000). The time for one entry is shared by the reads, the turn in the queue, the build, the send and the wait for the ledger. Each call of the store has a bound of the same length of its own, and none is made while the turn in the queue is held. |
| `ttlMarginSlots` | Optional. The slots after the TTL slot of a Delegate that the janitor waits before it drops an entry that the ledger does not show. A whole number from 0 to 86,400. The default is 600 slots, which is 10 minutes. |

**The list.** `FileLeftStore(directory)` keeps one JSON file for each delegation id, named `<id>.json`. The id has 64 lower-case hex characters. A file looks like this:

```json
{
  "left": {
    "id": "<64 hex characters>",
    "parent": "<64 hex characters>",
    "action": "erp.stock.read",
    "resource": "https://mock.example/t/run1/erp",
    "delegateTxHash": "<64 hex characters>",
    "delegateValidTo": 1790000000000,
    "delegateTtlSlot": 33000000,
    "notAfter": 1790003600000,
    "endTxHash": null
  },
  "signer_key_hash": "<56 hex characters>"
}
```

`put` writes a temporary file in the folder, flushes it, renames it over the file of the id, and flushes the folder. It settles only after the flush of the folder, so an entry that `put` accepted is on the disk. A write that fails leaves the old entry whole, and a failed flush of the folder is an error of `put` too. A `put` for an id that the list has replaces the entry: a later end attempt updates `endTxHash`. An id that is not 64 hex characters, and an entry that is not in the form, are refused before any file is touched. One instance runs its calls one at a time, and one process owns the folder. `remove` of an id that is not there is not an error. The store makes its folder with mode 700. A folder path that has a part `..` is refused.

A file that is not an entry is never skipped in silence. `list` throws `DamagedLeftEntriesError` when a file that ends in `.json` cannot be read, is not JSON, is not an entry in the form, or holds the entry of another id than its name. The error names each damaged file and carries the entries that it could read (`entries`). The janitor logs each damaged file, keeps it, and goes on with the other entries. The store never removes a damaged file. A temporary file that a crash left does not end in `.json`, so it is not an entry.

**The contract of a caller.**

- Put the reference in the list from `beforeSend` of `withSubDelegation`, so that the entry is on the disk before the Delegate is sent. A `put` that fails stops the run and nothing is sent. After the run, call `remove` for the end states `ended` and `not_made`, and call `put` with the `left` of the end for `not_ended`.
- A run that still goes on must not lose its delegation to the janitor. The reference is in the list from before the send until the end step has returned, so a pass at that time (for example while the run waits for its 30 confirmations) would end the delegation of a job that is running. `inFlight` is a required member of `JanitorDeps`, so that no wiring leaves it out. A service that makes sub-delegations adds the id when `beforeSend` is called and removes it after the run has returned and the list is up to date. A process that makes no sub-delegation gives a function that answers false. A pass leaves such an entry alone, and it reads nothing for it. An answer of `inFlight` that is not true or false counts as true, and so does a throw.
- The rules of a pass, for each entry in the order of the list, and only for an entry of the list: an id that the list does not hold is never read and never ended.
  - The ledger shows the delegation, and its transaction hash is `delegateTxHash`: the janitor takes the signer and the queue of the key. An entry with no usable signer stays, with a line in the log. A busy queue is not used, and the entry is skipped. In the queue the janitor builds the Undelegate, checks its bytes with the rules of the end step of `withSubDelegation`, signs, sends, and reads the ledger until it no longer shows the delegation or the time of the entry ends. Then it removes the entry. If the delegation is still shown, the entry stays and holds the hash of the Undelegate. A refused Undelegate does not replace a hash that the entry holds, because the first Undelegate can still land.
  - The ledger shows a delegation with this id that another transaction made: the Delegate of this run can never land. The entry is removed, and the removal is logged. A transaction hash that is not 64 lower-case hex characters is not another transaction: the entry stays.
  - The ledger shows nothing: the entry is removed only when the slot of the tip is at or past `delegateTtlSlot` plus `ttlMarginSlots` (600 slots by default), and a second read of the ledger, made after the tip was read, still shows nothing. A fork that switches near the TTL can put the Delegate in a block that the first chain did not have, so the margin comes after the TTL. Before that slot the Delegate may still land, and the entry stays. The janitor compares slots and never the clock with `delegateValidTo`.
  - A read that throws, gives no answer, or gives a value that is not a delegation with the id of the entry keeps the entry. A tip that cannot be read keeps it too. A throw is never read as "not shown".
- A pass makes one transaction at most for an entry. It holds the turn in the queue of the key while it builds, signs, sends and waits for the ledger, so a hire of that key waits for it. It gives the turn back before it writes to the store, so a store that is slow never holds the queue. A pass never throws. Each entry has its own state, and the report says what happened: `ended`, `dropped_not_made`, `dropped_other`, `kept_waiting`, `kept_busy`, `kept_unreadable`, `kept_no_signer`, `kept_end_pending`, `kept_end_failed` and `kept_store_failed`. The log gets one line for each entry that needs a person, and none for `kept_waiting` and for a `kept_busy` of the plain kind. A `kept_busy` whose cause is a failure gets one line with the cause: an `inFlight` that throws or does not answer true or false, and a queue whose `busy` is not true or false. A detail names no key and no part of a request.
- `startJanitor` throws for an interval that is not a whole number of milliseconds from 1 to one day, and for deps that are not valid, so a service that is set up wrong does not start. `stop` lets no entry start after it and waits for the pass in flight, for at most `stopWaitMs`. A pass that does not end by then is abandoned with a line in the log, and its entries stay in the list for the next start.

**What it does not prove without a chain.** The tests run the janitor over the fake ledger of the access tests, which builds real bytes for the Delegate and the Undelegate, and over the Undelegate that the real builder of buyer-core makes in an offline world. They do not prove the lag between the ledger source and the tip of the node (the second read and the margin narrow it, and do not remove it), the answer of a real node to a send, the timing of a block, or the behaviour of a real disk after a crash.

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
- A job that the counterparty fails after its Claim is a `failed` step, with one exception that is a refusal: the Order Desk decides `cannot_supply` after its Claim, and its service answers 403 with `{"error":"cannot_supply"}`. The runtime copies that answer into the failure of the job. The hire kit reads the status and the code from the frame that the runtime writes, and it gives them as the members `service_status` and `service_code` of the outcome `failed_after_claim` with the reason `failed` (both are `null` when it reads none). The flow reads these members and no text. The step is `refused_by_counterparty` with the source `after_claim` only when the code is a code of `AFTER_CLAIM_REFUSALS`, its status is the status that `ERROR_STATUS` gives it, and the protocol lists the code for the counterparty of the use case. For another counterparty the step is `failed` with that code as its reason. Any other code, any other status, and a code in free text give the step `failed` with the reason of the hire kit.
- Before the Pay, the agent of the advert must be the counterparty. The flow reads the advert of the document on the chain before it reads a vault. The advert must name the counterparty as its agent: the DID is `did:vector:` and the `agent_id` of the advert, compared as text. Another agent, and an advert with no agent, are `advert_not_counterparty`, and nothing is paid. The hire kit checks the agent of the receipt against the agent of the advert, and never against the counterparty of the document, so this check ties the Pay to the counterparty.
- The first thing that the hire kit does after the Pay is to wait one poll interval. The flow checks that the deadline of the job leaves that time, and it asks the hire kit for the same time at its turn in the lane (`minLeftAtTurnMs`). A hire that waited too long ends with the reason `deadline`, and nothing is paid.
- The hire kit checks the size of the body again before its Pay (`RUNTIME_BODY_LIMIT_BYTES` of `@vsa/hire-kit`). The flow checks it first and gives `request_too_large`. The check of the kit is a second line of defence: it throws the `unavailable` error of the factory of the caller, and the flow never reaches it, because its own check refuses the same body first. For a vault hire the two bodies have the same size, because a vault Pay opens its escrow at output 0. A test pins the limit of the kit to the limit of the protocol.

**What it does not prove without a chain.** The reads of a vault and of a delegation on mainnet, and the lag of the indexer right after a Pay.

## The dispute folder

**What it is for.** The Module-1 path of an agent. A run stakes a claim, and the claim document states the three statements of the manifest of the agent. A buyer-side agent whose model does not accept a delivery files a challenge against the open claim of the counterparty. A counterparty that refuses a request because the digest of the approval is wrong files a challenge against the open claim of the sender. The challenge holds an evidence document that states the contradiction with its values: the SKU, the lot and the quantity of a purchase order (use case 1), the unit price of a quote (use case 3), or the digest of an approval against the digest of the request (use case 2). A claim that nobody challenges is withdrawn after its challenge window. A document for a juror has two limits: at most 3,000 bytes, and at most `JUROR_RECORD_LIMIT_BYTES` (4,300) bytes when its text is escaped twice for the record of a juror. A text with many quote marks or backslashes reaches the second limit first. A document that is too large is refused (`document_too_large`), and it is never cut.

**Main exports.** `Dispute` has `stakeRunClaim`, `withdrawClaim`, `challengeDelivery`, `challengeApproval`, `findOpenClaim` and `listOpenClaims`. `createModule1Port` makes the chain port over the builders of `@vsa/buyer-core`. `claimDocument` and `evidenceDocument` write the documents, and `readClaimDocument` and `evidenceReferences` read the bytes of a document back. `disputedFields` gives the members of the `disputed` result of the protocol. `MemoryJournal` is the default journal, and `DisputeJournal` is its port. `LEAST_RESOLUTION_DEADLINE_MS` is the least resolution deadline of a challenge.

**What a caller must give.** `DisputeDeps` has the chain `port`, the `queue` of the service key, the `clock`, a `sleep` that bounds each read of a port, the `settings`, and optionally a `journal` and a `log`. The `queue` is the `SerialQueue` of the protocol, and this folder also names the type `ServiceQueue`. Give the queue that runs the hires of the same key, because a Module-1 build spends every output of the wallet but one. The timer of `sleep` must not hold the process open. `log` gets one line for each step, with references of the chain and codes, and never a key or a part of a request. `createModule1Port` takes the node provider, the Module-1 deployment, the wallet address, the id of the agent, a `sign` function, the `clock` and the `sleep`, the URL of Koios with its `fetch`, and the identity deployment or `null`. The code never holds a key: the caller closes `sign` over the service key. With `null` as identity deployment, a challenge is refused (`bad_shape`), and the service can still stake and withdraw claims. `DisputeSettings` has no default for `challenge_stake_lovelace` (a `bigint` above 0), `min_window_left_ms` (at least 2,000) and `read_timeout_ms`. `resolution_deadline_ms` is optional. When it is set, it must be the value of the Module-1 deployment. The value of the deployment must be at least `LEAST_RESOLUTION_DEADLINE_MS` (6 hours and 40 minutes), and the constructor refuses less: the relay opens no case for a challenge with less. `started_lease_ms` is optional. The default is 10 minutes, or twice `read_timeout_ms` when that is more. A value below twice `read_timeout_ms` is refused. The constructor throws for a setting of the wrong type or out of range, before anything is read.

**The contract of a caller.**

- The scope of a job. A challenge takes `escrow_ref`, `capability_id`, `statement_text` and `buyer_pkhs`, and `findOpenClaim` takes the same members as its `scope`. A challenge names `buyer_pkhs`, and a `scope` may leave it out. An approval also takes `claim_capability_id`, a delivery refuses it, and a `scope` may have it. `escrow_ref` is the output that the Post of the job made. `capability_id` is the capability that the job hired, and the caller knows it from the advert. `statement_text` is the text of the statement S1 that the job broke. For a delivery, it is the S1 of the manifest of the agent that the job hired, and the caller has that manifest. For an approval, it is the S1 of the claim of the sender. Two more bullets below describe `buyer_pkhs` and `claim_capability_id`. A scope that is not in its form is `bad_shape`, and the detail names the member.
- The escrow is bound to the job, and the start of the job is the block of the Post. The port reads `escrow_ref` from the chain. The code takes it only when its datum has the identity layout, its `capability_id` is the capability of the scope, its `agent_id` is the agent that the job hired (the counterparty for a delivery, this agent for an approval), and its `buyer_pkh` is one of the `buyer_pkhs` of the scope. Any other output is `bad_shape`: the escrow of another job (for another capability, for another agent, or of another buyer), an escrow of the legacy layout (its datum names no agent), and an output that is no escrow output of the deployment. The output must be the output that the Post made: the state of its datum is Open. Koios keeps that datum after the output is spent. An output of a later step (the Claim or the Submit) is `bad_shape`, because its block is later than the start of the job. The start of the job is the time of the block that holds the transaction that made the output. The chain port reads it, and the caller gives no time. The member `posted_at` of the datum is never used: the poster writes it, and no validator checks it. A block that is dated after the clock is `chain_unavailable`. The code reads the escrow only when the other party has an open claim.
- The target and the skips. The other party cannot choose the target of a challenge. A claim is a target only when all of these hold. Its claimer is the other party. It is Open, and it has at least `min_window_left_ms` left of its window. It was submitted before the start of the job. Its stake is not above `challenge_stake_lovelace`. Its claim document is on chain with the hash that the claim holds, it is the document that `claimDocument` writes for the claimer, it is for the capability of the claim (`claim_capability_id`, or `capability_id` when the scope has none), and it has `statement_text` as its statement S1. Two texts with the same NFC form are one text: this includes the forms NFC and NFD of a text, and a character that NFC replaces by another (for example the Kelvin sign and the letter K). Any other difference, such as a look-alike letter of another script, makes another text. Among the targets, the code takes the one with the latest challenge deadline, and with the same deadline the one with the lowest claim token. A claim that is not a target is skipped and counted by its reason: `window`, `began` (submitted at or after the start of the job), `stake`, `no_document` (the document is not on chain, or it is not a document), `not_kit` (it is not a claim document of this kit), `capability` and `statement`. When no target is left, the result is `no_open_claim`. When the other party has open claims, its detail gives the count for each reason. A source that cannot be read, or that answers in a wrong shape, is `chain_unavailable`. It is never a skip, and it is never `no_open_claim`.
- The journal must be durable for a service that must not file a job twice after a restart. A job is one escrow, and it gets one challenge. The code reads the journal first. It writes the record `started` before it sends the evidence, `evidence_landed` after the evidence lands, and `done` at the end. A job whose record says that a transaction landed or may land takes no second attempt, also after a restart. Only the record `started` lapses (see the lease). A second call for a job that filed a challenge gives the same challenge. The default `MemoryJournal` keeps the records in memory, and a restart forgets them. A durable journal keeps the records on disk, and its `put` returns only when the record is stored. A journal that cannot be read, that gives a record that is not in its form, or that gives the record of another escrow gives `journal_unavailable`, and nothing is sent. So does a write of the record `started` that fails. A write that fails after a transaction landed is logged, and it changes no result. The journal has no lock across processes.
- The lease and the claim of the record. A record `started` says that the evidence of the job may be on chain. It blocks the job for `started_lease_ms`, counted from the time in the record. After that time, the code first looks for a challenge of this agent for the job on chain, and that challenge is the result. When there is none, the job goes on only against the claim that the record names, and that claim goes through the same rules of a target. The code ends the job with `claim_changed` when the claim is spent, is not Open, is another claim, or has no window left. It ends the job with `claim_window_closing` when some window is left, but too little for the evidence to confirm. It sends nothing then. The first try can land while the second try runs. The second try then ends with `claim_changed`, with `challenge_not_built`, or with `challenge_not_confirmed` and `may_land` false. The code then looks again for a challenge of this agent. When it finds the challenge of the first try, that challenge is the result, and `extra_evidence` names the evidence document of the second try. Two processes can both go on after a lease ends. They go on against the same claim, and the chain takes only one challenge for a claim, so a job never files two challenges.
- No cap on the candidate claims. A candidate is an open claim of the other party with enough window left, submitted before the start of the job, and with a stake that is not above the challenge stake. The code does not limit the number of candidates. It reads the claim document of each candidate in turn, in the order of the choice, and it stops at the first target. A candidate costs one read, or two when the source does not have the transaction of the document yet. Each read has the bound `read_timeout_ms`, and the sum of the reads has no bound. A claimer that holds many open claims that are not targets makes the search longer. The code checks the window of the chosen claim again in the job of the queue, before it sends the evidence (`claim_window_closing`). After that check, the job reads and writes the journal, and each of the two steps can take up to `read_timeout_ms`. So give `min_window_left_ms` room for two times `read_timeout_ms` more than the time that the evidence and the challenge need to confirm.
- The escrow is bound to the buyer keys that the caller names. The datum of an escrow names a buyer key (`buyer_pkh`), and the code takes the escrow only when that key is one of `buyer_pkhs`. A challenge must name them. A delivery names one to eight different key hashes: the delegation keys of this agent, which paid for the job. An approval names exactly one key hash: the buyer key of the job that this agent refused. Each key hash has 56 lower-case hex characters. The escrow of another buyer is `bad_shape`, and the detail names `buyer_pkhs` and never repeats a key. The check comes after the layout, the capability and the agent, and before the state and the time. It comes before the code reads any claim document. The code compares the key of the datum as text, so a key in another case or of another length is another buyer. The code reads `buyer_pkhs` one time, as data. A getter, a Proxy, an array of another kind, a list of the wrong size, a repeated key and a key of the wrong form are `bad_shape`. So the code tells apart the jobs of two buyers that hired the same agent for the same capability. It does not prove that the buyer key funded the escrow, because the poster writes the datum. The caller names the escrow of its own job, and the start of the job is the block of the escrow that the caller names. A `findOpenClaim` scope with no `buyer_pkhs` takes the escrow of any buyer: a lookup has no direction and no buyer. A scope with `buyer_pkhs` is bound to them in the same way.
- The scope of an approval has two capabilities. A delivery has one: the job hired the counterparty, so the escrow and the claim of the counterparty are for `capability_id`, and a delivery refuses `claim_capability_id`. In an approval the sender hired this agent. The escrow is for the capability of this agent, and that is `capability_id`. The claim of the sender is for the capability of the sender, and that is `claim_capability_id`, which an approval requires. The code compares the escrow with `capability_id` and the claim document with `claim_capability_id`. It does not check that `claim_capability_id` is the capability of the sender, so the caller gives the right value. A `findOpenClaim` scope may have `claim_capability_id`, and it defaults to `capability_id`. A claim for another capability is skipped with the reason `capability`. In an approval, `statement_text` is the statement S1 of the claim of the sender. A claim that the sender stakes after the Post of the job is skipped as `began`, as in a delivery. It is no standing claim for this job, and the refusal that the counterparty already sent still protects the counterparty.
- A counterparty answers the refusal `approval_digest_mismatch` first, and it calls `challengeApproval` after that. The reference of the challenge goes to the log and to the result. The counterparty must not put it into the message of the refusal.
- The result says what landed. A step that fails says what landed before it stopped: the evidence document (`evidence`), a transaction that was sent and not seen confirmed (`sent`, which can still land before `valid_to` unless `may_land` is false), a challenge that landed against another claim than the one that the evidence names (`challenge`), and a document with another hash than the one that was built (`wrong_document`). `disputedFields(result)` gives `Escalated` with the record of the challenge when it is filed, and `Failed` with the code of the step as the reason in any other case. The reason is `no_open_claim` when the other party has no open claim.

**What it does not prove without a chain.** The tests run the real chain port over the fixture world of the buyer code, where Lucid runs the Module-1 scripts in every build, and a scripted port for the other cases. They do not prove that a juror reads these documents, that the relay opens a case for a challenge, the fees and the timing of a real node, or the lists of a live Koios.

## The inventory folder

**What it is for.** The documents of use case 1 (inventory reorder). The Reorder Agent proposes a purchase order. The Order Desk reads it, places the order, and returns a confirmation. The two agents are two packages and they do not import each other, so the kit holds what both read: the three documents, the lot names, and the claim statements of the two agents. Each document has a strict parser and a golden example in `test/inventory/golden`.

**Main exports.** `parsePurchaseOrder`, `poNumberOf`, `poNumberKey` and `PO_SCHEMA`; `parseLotsFile`, `lotSizeOf`, `lotsFileSha256` and `LOTS_SCHEMA`; `parseOrderConfirmation`, `CONFIRMATION_CHECKS` and `CONFIRMATION_SCHEMA`; `LOT_NAMES` and `isLotName`; `INVENTORY_CAPABILITIES`, `REORDER_CLAIM` and `ORDER_DESK_CLAIM`.

**The contract of a caller.**

- A parser takes any value and never throws. It returns `{ ok: true, value }` with a new plain object, or `{ ok: false, code: 'bad_shape', detail }`. The detail names the field and never repeats the value. Each member is read one time as data. A text is checked as it is written: an identifier, a date and a digest are ASCII, so a text that passes is in the NFC form already, and a text that only NFC turns into a valid text (the Kelvin sign for the letter K) is refused, as the purchase order store refuses it. The one free text, the organisation of the sender, is copied in the NFC form. An accessor, the key `__proto__` and a member that is not listed are refused. A caller uses the copy and never the input.
- The purchase order is the document of a proposal, so its digest is `proposalDigest(salt, document)` of the protocol. The parser takes what the purchase order store of the mock service takes, and no more: an identifier of 1 to 64 characters for `po_number` and `sku`, a tenant of at most 48 characters, a quantity from 1 to 1,000,000, a date that exists, and an output index of at most 6 digits in `advert_ref`. The service is not imported here, so a change of its rules needs the same change in this folder. `poNumberOf(tenant, counter)` gives `<tenant>-<counter>`. A purchase order number is unique without regard to case, as in the supplier portal: the order book keys each number by `poNumberKey(poNumber)`, which is the number in lower case.
- The lots file is hashed as its bytes. The manifest of the Order Desk holds the hash of the bytes that it serves, so `lotsFileSha256(text)` hashes the text as it is served and writes no canonical form. A caller serves the same text that it hashed. `parseLotsFile` takes the value that `JSON.parse` made from the text. `lotSizeOf` gives `null` for a SKU that the file does not list, and a caller reads `null` as a mismatch.
- The confirmation has 16 checks. `CONFIRMATION_CHECKS` lists them in the order that they run: the 12 shared checks of an order desk (`SHARED_CHECK_NAMES['order-desk']` of the checks folder, which include `vault_paid`), and then `for_this_supplier`, `lot`, `quantity` and `not_duplicate`. A confirmation has every name with the value `true`, and no other member. `outcome` is `done`. The end of the approval is `null` or a time in UTC with milliseconds, as `toISOString` writes it: the year has four digits, or a sign and six digits. The organisation of the sender is `null` or any text of at most 1024 characters, because the shared sender check takes any text from the record of the sender. The `decisions` hold exactly one decision, named `availability`: the model decision of the Order Desk, which it makes in every job, also when a fault value is set. A list with no decision, with two decisions, or with a decision of another name is refused. The decision keeps each text as it came, because it holds the words of a model and its signed receipt.
- The claim statements are the texts that the claim and the challenge use. The manifest of an agent, its claim document and the challenge of the other agent all take `REORDER_CLAIM` and `ORDER_DESK_CLAIM`, so a challenge names the text that the claim holds. The constants are frozen.

**What it does not prove.** A parser checks the form of a document and nothing else. It does not prove that a lot size is the size that a supplier ships, that an order exists at the supplier, that a confirmation answers the purchase order that was sent (the agent that reads the confirmation compares the two documents), or that the hash in a manifest is the hash of the bytes that a host serves.

## The live folder

**What it is for.** Three parts that a buyer-side agent needs on a real chain, and that the other folders leave to the caller. `delegationChainOf` is the real `DelegationChain` for `withSubDelegation` of the access folder: the sub-delegation is made, the gateway can issue a token under it after 30 confirmations, and it is ended after the job. `tipSlotOf` gives the slot of the tip of the node, which the janitor of left sub-delegations compares with the TTL of a Delegate. `keyObjectOfRawKey` makes the Ed25519 key object that the token client and the DPoP proof take, from the 64 hex characters of a raw key.

**Main exports.** `delegationChainOf`, `LiveChainDeps`, `tipSlotOf` and `keyObjectOfRawKey`.

**What a caller must give.**

- `LiveChainDeps` is a `LedgerEnv` of buyer-core: `provider`, `deployment`, `koiosUrl`, `fetchImpl` and the optional `budgetMs`. `budgetMs` is the time of one read, and `readiness` makes up to two reads. The `provider` also gives `getSystemStartMs` (the slot clock) and takes a signed transaction with `submitTx`. The `OgmiosProvider` of buyer-core does both. The same object serves `ledgerReadsFrom` of the buyer folder. A service makes the provider from the settings `VECTOR_OGMIOS_URL`, `VECTOR_SUBMIT_URL` and `VECTOR_KOIOS_URL`.
- `tipSlotOf` takes `fetch`, `ogmiosUrl` (an https URL) and `timeoutMs` (a whole number from 1 to 86,400,000). It throws a TypeError when it is made with a value that is not in its form.
- `keyObjectOfRawKey` takes 64 lower-case hex characters. The caller reads the key from its own settings.
- The folder reads no environment variable and no key file.

**The contract of a caller.**

- The adapter ends nothing by itself. It builds and sends what `withSubDelegation` asks for, and it signs nothing. `withSubDelegation` decides what to end. It ends only a delegation whose transaction hash is the hash of its own Delegate, and `readDelegation` gives that hash for the delegation that the ledger shows.
- A method that cannot read the ledger, or that the node refuses, throws. A throw is never `ready`, never `null` (the ledger shows none) and never a hash. A node that answers a read with no list of outputs is an error of the `OgmiosProvider`, and never an empty list: an empty list would read as "the ledger shows none". A test runs the real provider with a stub `fetch` for this, on the path of the address and on the path of the output that Koios names.
- `submit` reads the signed bytes first, and it sends nothing that it cannot read. It gives the hash of the body that it sent, and it throws when the node answers with any other text. The node may have the transaction then: `withSubDelegation` reads the ledger after a throw of `submit`, and it ends a Delegate that landed. The submit of the `OgmiosProvider` has no time limit of its own. The caller sets it, and `withSubDelegation` does with `stepTimeoutMs`.
- `readDelegation` gives `null` only when the ledger shows no delegation with that identifier. An identifier that is not 64 hex characters is an error. A delegation whose parent the ledger no longer shows is live, and `readiness` says that it is `unusable`.
- `readiness` reads the ledger two times with `checkDelegationUse` of buyer-core. The first read asks for no depth, so its problems are rule problems. A delegate that is not Active is `unusable` with those problems, with any depth, and it is never `waiting`. A delegation that the ledger does not show yet is `waiting` with `confirmations: null`. The second read asks for 30 confirmations. The adapter reads the depth of each link from the typed members of the answer, and never from the text of a problem. A chain whose links all have 30 confirmations or more is `ready`. Any other chain is `waiting`, with the least depth, or with `null` when a link has no block height yet.
- `slotAt` is `deploymentSlotAt` of the access folder: the slot that the real builder writes as the TTL of a transaction for the same time. The buyer code keeps the start time of the chain for the whole process after its first read.
- `tipSlotOf` makes one request for each call and keeps no value. It asks `queryNetwork/tip`, the call that `OgmiosProvider` uses. It throws for a node that gives no slot, for a slot that is not a whole number of at least 1, for an error of the node, for a status other than 200, for an answer that is too long or is not JSON, for a failure of the network and for a time out. No message repeats the URL or a part of the answer.
- `keyObjectOfRawKey` throws a TypeError for a text that is not 64 lower-case hex characters, and for a value that is not text. The message never repeats the value. `inspect`, `JSON.stringify` and `toString` of the object show nothing of the key. The key leaves the object only when a caller calls `export`.

**What it does not prove without a chain.** The tests run the real builders over the fixture world of the buyer code, where Lucid runs the real scripts in every build, with a node that checks the signatures and a fake Koios. The real `OgmiosProvider` runs against a stub of `fetch`, and not against a real node. They do not prove the 30 confirmations on a real node: the depth that Koios gives, and the lag between the node and Koios. They do not prove the submit endpoint of a real node or the real answer of `queryNetwork/tip`.

## Tests

`pnpm test` in this folder runs vitest. Each refusal has a test with an accepted twin. `pnpm typecheck` also checks the lines of the tests that must not compile (`@ts-expect-error`). No test uses the network.
