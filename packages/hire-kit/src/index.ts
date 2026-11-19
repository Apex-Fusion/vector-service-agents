// packages/hire-kit/src/index.ts
// The public surface of @vsa/hire-kit: how a service hires a fleet supplier for a sub-job, moved out of agents/document-pipeline so that another service
// hires the same way. One hire (src/hire.ts: hireOne, the error factory it is given and the facts it gives that factory, the record of the sub-job, and
// the chat job of the Responses API); the waits of a hire (src/budget.ts); the stranded store, the janitor and its bounded stop (src/janitor.ts, the file
// of the Pipeline read and written as it was); and the chat supplier, chosen and checked before its Post, with the lock it takes and the float a sub-job
// needs (src/select.ts). The kit writes every message; the caller's factory (HireErrors) chooses the class, the code and the status of each failure, so
// the Document Pipeline keeps its PipelineError, its codes and its words.

// --- One hire (src/hire.ts) ---
export { HireDeclined, chatJob, hireOne, verificationOf } from './hire.ts';
export type {
  AcceptDecision, Delivery, HireDeps, HireDetail, HireErrors, HireFacts, HireFailure, HireJob, HireKind, HireLedger, HireOptions, HireRecord, HireStage, HireSupplier, Hired,
} from './hire.ts';

// --- The hire of an agent of the template contract (src/agent.ts, src/template-client.ts) ---
export { hireAgent } from './agent.ts';
export type { AgentDelivery, AgentDeps, AgentErrors, AgentEscrow, AgentOutcome, AgentRequest, AgentSelection, VaultRefusal } from './agent.ts';
export { pollTemplateJob, sendTemplateJob, templateJob } from './template-client.ts';
export type { TemplateAnswer } from './template-client.ts';

// --- The paying keys (src/keys.ts) and the hire of a model from the service key (src/model.ts) ---
export { HireLane, PayingKey, PayingKeys } from './keys.ts';
export { hireModel } from './model.ts';
export type { ModelAnswer, ModelDeps, ModelErrors, ModelRequest } from './model.ts';

// --- The waits (src/budget.ts) ---
export { BUSY_RETRY_MS, POLL_INTERVAL_MS, RECEIPT_HASH_WAIT_MS, SEND_CUTOFF_MS, checkWithin, fit, waitWithin } from './budget.ts';
export type { Clocked } from './budget.ts';

// --- The stranded store and the janitor (src/janitor.ts) ---
export { JANITOR_GRACE_MS, STRANDED_FILE, StrandedStore, abandonedLine, runJanitorOnce, startJanitor, stopJanitorWithin } from './janitor.ts';
export type { AcceptPending, Busy, JanitorAction, JanitorChain, StrandedEntry, StrandedKind } from './janitor.ts';

// --- The chat supplier (src/select.ts) ---
export { aboveCeiling, advertOnChain, choiceLine, chooseChatSupplier, keyOfAdvert, plannedLockOf, subJobFloat } from './select.ts';
export type { ChatQuery } from './select.ts';
