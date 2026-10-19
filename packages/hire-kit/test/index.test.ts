// packages/hire-kit/test/index.test.ts
// The surface of the kit is the API of the plan (ruling R-F1, section 2.2 of the analysis) and nothing else: the values src/index.ts exports, by name, and
// the types, which this file names so that the type check fails if one is missing.
import { describe, expect, test } from 'vitest';
import * as kit from '../src/index.ts';
import type {
  AcceptPending, Busy, ChatQuery, Clocked, HireDeps, HireErrors, HireFacts, HireFailure, HireJob, HireKind, HireLedger, HireOptions, HireRecord, HireStage,
  HireSupplier, Hired, JanitorAction, JanitorChain, StrandedEntry, StrandedKind,
} from '../src/index.ts';

/** Every type of the surface, so that the type check reads each one. */
export type Surface = [
  AcceptPending, Busy, ChatQuery, Clocked, HireDeps, HireErrors<Error>, HireFacts, HireFailure, HireJob<unknown>, HireKind, HireLedger, HireOptions, HireRecord,
  HireStage, HireSupplier, Hired<unknown>, JanitorAction, JanitorChain, StrandedEntry, StrandedKind,
];

describe('@vsa/hire-kit', () => {
  test('exports the values of its API and nothing else', () => {
    expect(Object.keys(kit).sort()).toStrictEqual([
      'BUSY_RETRY_MS', 'JANITOR_GRACE_MS', 'POLL_INTERVAL_MS', 'RECEIPT_HASH_WAIT_MS', 'SEND_CUTOFF_MS', 'STRANDED_FILE', 'StrandedStore', 'abandonedLine', 'aboveCeiling',
      'advertOnChain', 'chatJob', 'checkWithin', 'choiceLine', 'chooseChatSupplier', 'fit', 'hireOne', 'keyOfAdvert', 'plannedLockOf', 'runJanitorOnce', 'startJanitor',
      'stopJanitorWithin', 'subJobFloat', 'verificationOf', 'waitWithin',
    ]);
  });
});
