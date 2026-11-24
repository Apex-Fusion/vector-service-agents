// agents/bid-desk/src/serve/wiring.ts
// The real ports of the Bid Desk: where the hook and the job get what they read, write and decide with. The folders of the hook (src/checks) and of the job (src/job) import neither each other nor this file;
// they get their ports in their deps, and this is the one place that makes them.
//
//   one paying key       The service key has one chain, one stranded store, one janitor and ONE queue (`lane`). The model hire of each decision runs in that queue, so no two hires build a transaction from the
//                        one wallet together. The key comes from the registry of the kit (`PayingKeys.add`), named by the key hash that the service key derives and in the folder `keys/<key hash>` of the
//                        state directory. The hash is given, so that `add` reads no wallet: the wallet of the real chain is a read of the node, and a node that is down would stop the start.
//   two gateway clients  The hook reads the gateway once, with a client whose timeout is the budget of the hook (CHECKS_READ_BUDGET_MS). The job asks the gateway for the credential of the desk with a client
//                        whose timeout is CALL_TIMEOUT_MS: a credential that fails after the Claim would lose the job, and the hook is the only call that the runtime waits 10 s for.
//   the hook's ledger    Every read of the ledger by the hook ends inside the budget of the hook. The wiring sets that budget over the one that the environment of the ledger carries.
//   one book             One `FileRfqBook` serves the hook and every job of the process. Two objects on one file can lose an entry: each reads the file, adds its entry and writes the whole file. The job reads
//                        the book again before it records a quote, so a second escrow of one request that the hook passed before the first job wrote its entry is refused there.
//   the decision         `decide` of the kit with the decision `quote`, the four limits of the settings and the deadline of the job, 300 s after the job arrived. One decision is one hire, with no second try.
//
// The Bid Desk is not buyer-side: it has no Module-1 port, no dispute code and no sub-delegation. The janitor of its one paying key, which ends the escrows that a model hire left, starts with the service.
//
// A line that this file writes holds codes, references and the kind of an error, and never the message of an error: a message can name an address with a key in it, or a part of a request.
import { join } from 'node:path';
import { OgmiosProvider, createRealChain } from '@vsa/buyer-core';
import type { Chain, LedgerEnv, RealChainOptions } from '@vsa/buyer-core';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import { ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { decide } from '@vsa/usecase-kit/decision';
import type { RfqMessage } from '@vsa/usecase-kit/protocol';
import { FileRfqBook, PassedChecks, createPrecheck } from '../checks/index.ts';
import { QUOTE_DECISION } from '../job/index.ts';
import type { QuoteDeps } from '../job/index.ts';
import { serviceKeyOf } from './keys.ts';
import { defaultLog } from './server.ts';
import { CALL_TIMEOUT_MS, JOB_DEADLINE_MS } from './settings.ts';
import type { ServiceConfig } from './start.ts';

/** The parts that a test replaces. The service itself uses the real one of each. */
export interface WireOptions {
  /** Makes the chain of the service key. The default is `createRealChain`, which builds, signs and submits on Vector mainnet. */
  readonly createChain?: (options: RealChainOptions) => Promise<Chain>;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  /** The ledger that the hook reads. Its budget is replaced by the budget of the hook. */
  readonly ledgerEnv?: LedgerEnv;
}

/** The hook as the job server takes it. */
export type Precheck = (request: RfqMessage, context: JobContext) => Promise<PrecheckAnswer>;

export interface Wired {
  /** The paying key of the service key: its chain, its queue (`lane`), its stranded store and its janitor. */
  readonly key: PayingKey;
  readonly precheck: Precheck;
  /** The ports of the job that arrived at the time given. */
  readonly jobDeps: (arrivedAt: number) => QuoteDeps;
}

/** A wait that never holds the process open: the timer is not cancelled when the work that it bounds ends first. */
const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** The book of what a model hire moved: the lock and the fee of its Post, the fee and the hash of its Accept. A line holds those numbers and the hash, and nothing else. */
function hireLedgerOf(log: (line: string) => void): HireLedger {
  return {
    posted: ({ lockLovelace, feeLovelace }) => { log(`model hire: posted, locked ${lockLovelace} lovelace, fee ${feeLovelace} lovelace`); },
    accepted: ({ feeLovelace, txHash }) => { log(`model hire: accepted in ${txHash}, fee ${feeLovelace} lovelace`); },
  };
}

/**
 * Makes the real parts of the service from its configuration and joins them: the chain and the paying key, the two gateway clients, the ledger of the hook, the rfq book and the record of the passed checks, the
 * hook, and the ports of the job. It reads files and makes no network call: the chain, the ledger and the gateway are read when the hook and the job need them. It throws, naming what is wrong, and nothing
 * keeps running then.
 */
export async function wireService(config: ServiceConfig, options: WireOptions = {}): Promise<Wired> {
  const log = options.log ?? defaultLog;
  // A log that throws changes nothing: the hook, the job and the model hire each call it from a place that must not fail for it.
  const say = (line: string): void => {
    try {
      log(line);
    } catch {
      // The line is lost.
    }
  };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const service = serviceKeyOf(config.service.privateKeyHex);
  const koiosUrl = config.endpoints.koiosUrl.replace(/\/+$/, '');

  const chain = await (options.createChain ?? createRealChain)({
    privateKeyHex: config.service.privateKeyHex, koiosUrl, ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, identityDeployment: config.identityDeployment,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }), ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
  });
  // The registry holds the one key. The key hash is the one that the service key derives, and the folder is `keys/<key hash>` of the state directory. The stranded file in it is read here.
  const key = await new PayingKeys(config.stateDir).add(chain, { dir: join(config.stateDir, 'keys', service.pkh), keyHash: service.pkh });

  const hookGateway = createGatewayClient({ baseUrl: config.endpoints.gatewayUrl, fetch: fetchImpl, now: clock, timeoutMs: config.checksBudgetMs });
  const jobGateway = createGatewayClient({ baseUrl: config.endpoints.gatewayUrl, fetch: fetchImpl, now: clock, timeoutMs: CALL_TIMEOUT_MS });
  const ledgerEnv: LedgerEnv = options.ledgerEnv ?? {
    provider: new OgmiosProvider({ ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, koiosUrl }), deployment: config.identityDeployment, koiosUrl, fetchImpl,
  };
  // No `onFault`: the hook writes one line for each source that failed, with the kind of the cause, and that line is the one record of it.
  const ports: ChecksPorts = { clock, gateway: hookGateway, ledger: ledgerPortOf({ ...ledgerEnv, budgetMs: config.checksBudgetMs }) };

  const book = new FileRfqBook(join(config.stateDir, 'rfq-book.json'));
  const passed = new PassedChecks();
  const precheck = createPrecheck({ ports, book, passed, clock, log: say });

  const hireLedger = hireLedgerOf(say);
  const jobDeps = (arrivedAt: number): QuoteDeps => ({
    agent: { did: config.agentDid, organisation: config.organisation },
    priceList: { list: config.priceList.list, sha256: config.priceList.sha256 },
    takeChecks: (escrowRef) => passed.take(escrowRef, clock()),
    book,
    credential: (did) => jobGateway.credential(did),
    decide: (input) => decide(
      {
        key, limits: config.limits, clock, sleep, deadlineMs: arrivedAt + JOB_DEADLINE_MS, fetchImpl, ledger: hireLedger, log: say,
        ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
      },
      QUOTE_DECISION,
      input,
    ),
    fault: config.fault,
    clock,
    log: say,
  });
  return { key, precheck, jobDeps };
}
