// packages/hire-kit/test/index.test.ts
// The surface of the kit is the API of the plan (ruling R-F1, section 2.2 of the analysis) and nothing else: the values src/index.ts exports, by name, and
// the types, which this file names so that the type check fails if one is missing.
import { describe, expect, test } from 'vitest';
import * as kit from '../src/index.ts';
import type {
  AcceptDecision, AcceptPending, AgentDelivery, AgentDeps, AgentErrors, AgentEscrow, AgentOutcome, AgentRequest, AgentSelection, BondLimits, Busy, ChatQuery, Clocked, Delivery,
  HireDeps, HireDetail, HireErrors, HireFacts, HireFailure, HireJob, HireKind, HireLedger, HireOptions, HireRecord, HireStage, HireSupplier, HireTerms, Hired, JanitorAction,
  JanitorChain, ModelAnswer, ModelDeps, ModelErrors, ModelRequest, StrandedEntry, StrandedKind, TemplateAnswer, VaultRefusal,
} from '../src/index.ts';

/** Every type of the surface, so that the type check reads each one. */
export type Surface = [
  AcceptDecision, AcceptPending, AgentDelivery, AgentDeps, AgentErrors<Error>, AgentEscrow, AgentOutcome, AgentRequest, AgentSelection, BondLimits, Busy, ChatQuery, Clocked,
  Delivery<unknown>, HireDeps, HireDetail, HireErrors<Error>, HireFacts, HireFailure, HireJob<unknown>, HireKind, HireLedger, HireOptions, HireRecord, HireStage, HireSupplier,
  HireTerms, Hired<unknown>, JanitorAction, JanitorChain, ModelAnswer, ModelDeps, ModelErrors<Error>, ModelRequest, StrandedEntry, StrandedKind, TemplateAnswer, VaultRefusal,
];

describe('@vsa/hire-kit', () => {
  test('exports the values of its API and nothing else', () => {
    expect(Object.keys(kit).sort()).toStrictEqual([
      'BUSY_RETRY_MS', 'HireDeclined', 'HireInterrupted', 'HireLane', 'JANITOR_GRACE_MS', 'POLL_INTERVAL_MS', 'PayingKey', 'PayingKeys', 'RECEIPT_HASH_WAIT_MS', 'SEND_CUTOFF_MS',
      'STRANDED_FILE', 'StrandedStore', 'abandonedLine', 'aboveCeiling', 'advertOnChain', 'bondProblem', 'chatJob', 'checkWithin', 'choiceLine', 'chooseChatSupplier', 'fit', 'hireAgent',
      'hireModel', 'hireOne', 'isRuntimeRefusal', 'keyOfAdvert', 'plannedLockOf', 'pollTemplateJob', 'runJanitorOnce', 'sendTemplateJob', 'startJanitor', 'stopJanitorWithin', 'subJobFloat',
      'templateJob', 'termsLine', 'termsOf', 'verificationOf', 'waitWithin',
    ]);
  });
});
