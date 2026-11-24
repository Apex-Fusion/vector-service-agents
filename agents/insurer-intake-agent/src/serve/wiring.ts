// agents/insurer-intake-agent/src/serve/wiring.ts
// The real ports of the Insurer Intake Agent: where the hook, the job and the dispute code get what they read, write and decide with. The folders of the stores (src/store), of the hook (src/checks), of the job
// (src/job) and of the report (src/report) import none of each other and not this file; they get their ports in their deps, and this is the one place that makes them and joins them. The shapes meet here and
// nowhere else: `FileIntakeBook` and `PassedChecks` fit the plain shapes of the hook (`BookReader`, `PassedSink`) and of the job (`BookPort`, `TakenChecks`), and the compiler checks each fit where the object is given.
//
//   one paying key      The service key has one chain, one stranded store, one janitor and ONE queue (`lane`). The model hire of the decision, the claims and the challenges of the dispute code all run in that queue,
//                       so no two of them build a transaction from the one wallet together. The key comes from the registry of the kit (`PayingKeys.add`), named by the key hash that the service key derives and in the
//                       folder `keys/<key hash>` of the state directory. The hash is given, so that `add` reads no wallet: the wallet of the real chain is a read of the node, and a node that is down would stop the start.
//                       The chain pays from a vault for nothing: the agent hires models with its own key. It reads a vault payment of the sender, so its identity deployment holds the reference script of the vault.
//   two gateway clients The hook reads the gateway once, with a client whose timeout is the budget of the hook (CHECKS_READ_BUDGET_MS). The job asks the gateway for its JWT-SVID with a client that has the default
//                       timeout of 10 s: an SVID that fails after the Claim would lose the job, and the hook is the only call that the runtime waits for.
//   two ledger budgets  Every read of the ledger by the hook ends inside the budget of the hook, and every read of the report ends inside the read budget of the report. The wiring sets each budget over the one that the
//                       environment of the ledger carries.
//   one store each      ONE record of passed checks and ONE intake book for the process. The hook puts into the record and reads the book, the job takes from the record and writes the book. Two objects would not see
//                       each other: a pass of the hook would never reach the job, and two books on one file could lose an entry.
//   the decision        `decide` of the kit with the decision `completeness` over the requirement ids of that job, the four limits of the settings, and the deadline of that job: 300 s after it arrived, and never past the
//                       end of the time that the rest of the job needs (the margin of the runtime, the call of the filing and a new JWT-SVID before it). One decision is one hire, with no second try.
//   the challenge       A task that starts after the hook has answered (`setImmediate`): the runtime waits 10 s for the hook, and a challenge takes two transactions.
//
// The deps of a job are made when the job arrives, so no job can change the deadline of another. A line that this file writes holds codes, references and the kind of an error, and never the message of an error: a
// message can name an address with a key in it, or a part of a request.
import { join } from 'node:path';
import { OgmiosProvider, createRealChain, module1FromManifest, readManifest } from '@vsa/buyer-core';
import type { Chain, LedgerEnv, RealChainOptions } from '@vsa/buyer-core';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import { systemClock } from '@vsa/usecase-kit/access';
import type { Clock } from '@vsa/usecase-kit/access';
import { ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { decide } from '@vsa/usecase-kit/decision';
import { Dispute, FileJournal, createModule1Port } from '@vsa/usecase-kit/dispute';
import type { Module1Port } from '@vsa/usecase-kit/dispute';
import { agentIdOf } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { createPrecheck } from '../checks/index.ts';
import { RUNTIME_MARGIN_MS, completenessDecision } from '../job/index.ts';
import type { IntakeDeps } from '../job/index.ts';
import { READ_BUDGET_MS as REPORT_READ_BUDGET_MS, ledgerReportDeps, reportAttestations } from '../report/index.ts';
import { FileIntakeBook, PassedChecks } from '../store/index.ts';
import { defaultLog } from './server.ts';
import { CALL_TIMEOUT_MS, JOB_DEADLINE_MS } from './settings.ts';
import type { ServiceConfig } from './start.ts';

/**
 * The time of one call of the gateway client when its caller gives none: 10 s. This is `DEFAULT_TIMEOUT_MS` of id-kit, which no entry of that package exports, so the number is written here, and a test holds the
 * two equal through the client itself. The client of the job takes it. A new JWT-SVID, which the job asks for between the decision and the filing when the first one is about to end, takes that long at most.
 */
export const GATEWAY_DEFAULT_TIMEOUT_MS = 10_000;

/** The parts that a test replaces. The service itself uses the real one of each. */
export interface WireOptions {
  /** Makes the chain of the service key. The default is `createRealChain`, which builds, signs and submits on Vector mainnet. */
  readonly createChain?: (options: RealChainOptions) => Promise<Chain>;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly log?: (line: string) => void;
  /** The ledger that the hook and the report read. The budget of the hook and the budget of a read of the report replace its own budget. */
  readonly ledgerEnv?: LedgerEnv;
  /** The Module-1 port of the dispute code. The default fetches the manifest of the deployment one time, from its pinned address, and makes the real port. */
  readonly module1Port?: Module1Port;
}

/** The hook as the job server takes it. */
export type Precheck = (request: Handoff, context: JobContext) => Promise<PrecheckAnswer>;

export interface Wired {
  /** The paying key of the service key: its chain, its queue (`lane`), its stranded store and its janitor. */
  readonly key: PayingKey;
  readonly precheck: Precheck;
  /** The ports of the job that arrived at the time given, for the escrow of the context. */
  readonly jobDeps: (arrivedAt: number, context: JobContext) => IntakeDeps;
  /** The one record of passed checks of the process: the hook puts into it, and the job takes from it. */
  readonly passed: PassedChecks;
  /** The one intake book of the process, the file `requests.json`: the hook reads it, and the job writes it. */
  readonly book: FileIntakeBook;
  /** The janitor of the stranded escrows of each paying key of the registry, which is the service key. It starts no transaction while the queue of its key works. */
  readonly startJanitors: (intervalMs: number, options?: { clock?: () => number; log?: (line: string) => void }) => { stop: () => Promise<void> };
}

/** A wait that never holds the process open: the timer is not cancelled when the work that it bounds ends first. */
const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms).unref(); });

/** The kind of a thrown value, for the log: the name of an error, and the type of anything else. The message of an error is never logged. */
const kindOf = (cause: unknown): string => (cause instanceof Error ? cause.name : typeof cause);

/** The book of what a model hire moved: the lock and the fee of its Post, the fee and the hash of its Accept. A line holds those numbers and the hash, and nothing else. */
function hireLedgerOf(log: (line: string) => void): HireLedger {
  return {
    posted: ({ lockLovelace, feeLovelace }) => { log(`model hire: posted, locked ${lockLovelace} lovelace, fee ${feeLovelace} lovelace`); },
    accepted: ({ feeLovelace, txHash }) => { log(`model hire: accepted in ${txHash}, fee ${feeLovelace} lovelace`); },
  };
}

/**
 * The Module-1 port: the one that a test gives, or the real port over the manifest of the deployment. The manifest is fetched one time, from the pinned https address of the setting. It must name the identity
 * registry that the deployment of this service gives. The port itself makes no call when it is made.
 */
async function module1PortOf(config: ServiceConfig, options: WireOptions, ports: { clock: () => number; sleep: (ms: number) => Promise<void>; fetchImpl: typeof fetch; koiosUrl: string }): Promise<Module1Port> {
  if (options.module1Port !== undefined) return options.module1Port;
  const json = await readManifest(config.module1Manifest, 'The Module-1 manifest (VECTOR_MODULE1_MANIFEST)', ports.fetchImpl);
  const module1 = module1FromManifest(json, config.module1Manifest);
  if (module1.identityHash !== config.identityDeployment.identity.hash) {
    throw new Error(`the Module-1 manifest names the identity registry ${module1.identityHash}, but the identity deployment of this service is ${config.identityDeployment.identity.hash}`);
  }
  return createModule1Port({
    provider: new OgmiosProvider({ ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, koiosUrl: ports.koiosUrl }),
    module1, address: config.service.address, agent_id: agentIdOf(config.agentDid), sign: (unsignedCborHex) => config.service.signUnsigned(unsignedCborHex), clock: ports.clock, sleep: ports.sleep,
    koios_url: ports.koiosUrl, fetch: ports.fetchImpl, identity_deployment: config.identityDeployment,
  });
}

/**
 * Makes the real parts of the service from its configuration and joins them: the chain and the paying key, the two gateway clients, the ledger of the hook and of the report, the intake book and the record of the
 * passed checks, the dispute code over its journal and its port, the hook, and the ports of the job. It reads files and makes the one fetch of the Module-1 manifest, from its pinned https address
 * (`module1PortOf`), and no other network call: the chain, the ledger and the gateway are read when the hook and the job need them. It throws, naming what is wrong, and nothing keeps running then.
 */
export async function wireService(config: ServiceConfig, options: WireOptions = {}): Promise<Wired> {
  const log = options.log ?? defaultLog;
  // A log that throws changes nothing: the hook, the job and the dispute code each call it from a place that must not fail for it.
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
  const { service } = config;
  const koiosUrl = config.endpoints.koiosUrl.replace(/\/+$/, '');

  // The key goes to the chain through `withKey`, the one door of the key material, and nowhere else.
  const chain = await service.withKey((privateKeyHex) => (options.createChain ?? createRealChain)({
    privateKeyHex, koiosUrl, ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, identityDeployment: config.identityDeployment,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }), ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
  }));
  // The registry holds the one key. The key hash is the one that the service key derives, and the folder is `keys/<key hash>` of the state directory. The stranded file in it is read here.
  const registry = new PayingKeys(config.stateDir);
  const key = await registry.add(chain, { dir: join(config.stateDir, 'keys', service.pkh), keyHash: service.pkh });

  const hookGateway = createGatewayClient({ baseUrl: config.endpoints.gatewayUrl, fetch: fetchImpl, now: clock, timeoutMs: config.checksBudgetMs });
  const jobGateway = createGatewayClient({ baseUrl: config.endpoints.gatewayUrl, fetch: fetchImpl, now: clock });
  const ledgerEnv: LedgerEnv = options.ledgerEnv ?? {
    provider: new OgmiosProvider({ ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, koiosUrl }), deployment: config.identityDeployment, koiosUrl, fetchImpl,
  };
  const ports: ChecksPorts = {
    clock,
    gateway: hookGateway,
    ledger: ledgerPortOf({ ...ledgerEnv, budgetMs: config.checksBudgetMs }),
    onFault: (source, cause) => { say(`the hook could not read the ${source} (${kindOf(cause)})`); },
  };

  // The one intake book and the one record of passed checks of the process.
  const book = new FileIntakeBook(join(config.stateDir, 'requests.json'));
  const passed = new PassedChecks();
  const journal = new FileJournal(join(config.stateDir, 'dispute'));
  const port = await module1PortOf(config, options, { clock, sleep, fetchImpl, koiosUrl });
  let dispute: Dispute;
  try {
    dispute = new Dispute({ port, queue: key.lane, clock, sleep, settings: config.dispute, journal, log: say });
  } catch (error) {
    throw new Error(`the dispute settings are refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  const precheck = createPrecheck({
    ports, book, self: config.agentDid, passed, dispute,
    // The task starts after the answer is written. The task catches its own errors, and the catch here is the second line.
    schedule: (task) => { setImmediate(() => { void task().catch(() => undefined); }); },
    log: say,
  });

  // The calls of the job wait with the timers of the system and read the time from the clock of the wiring.
  const callClock: Clock = { now: clock, sleep: systemClock.sleep };
  const reportDeps = ledgerReportDeps({ ...ledgerEnv, budgetMs: REPORT_READ_BUDGET_MS }, { clock: callClock, log: say });
  const hireLedger = hireLedgerOf(say);
  const jobDeps = (arrivedAt: number, context: JobContext): IntakeDeps => ({
    agent: { did: config.agentDid, authenticationKey: service.keyObject },
    svid: { client: jobGateway },
    calls: { fetch: fetchImpl, clock: callClock, bases: config.mock, timeoutMs: CALL_TIMEOUT_MS },
    takeChecks: (escrowRef) => passed.take(escrowRef, clock()),
    book,
    report: (input) => reportAttestations(reportDeps, input),
    // The job has no check of the time before the paid decision, so the deadline of the decision holds it: the hire never runs past the time that the rest of the job needs after it. The runtime stops waiting 30 s
    // before deliver_by (RUNTIME_MARGIN_MS), the call of the filing takes up to CALL_TIMEOUT_MS, and a new JWT-SVID before the filing takes up to GATEWAY_DEFAULT_TIMEOUT_MS. A time that is not a number is no
    // deadline, and the decision hires nothing for it.
    decide: (input, requirementIds) => decide(
      {
        key, limits: config.limits, clock, sleep, fetchImpl, ledger: hireLedger, log: say,
        deadlineMs: Math.min(arrivedAt + JOB_DEADLINE_MS, context.deliverByMs - RUNTIME_MARGIN_MS - CALL_TIMEOUT_MS - GATEWAY_DEFAULT_TIMEOUT_MS),
        ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
      },
      completenessDecision(requirementIds),
      input,
    ),
    clock,
    log: say,
  });
  return { key, precheck, jobDeps, passed, book, startJanitors: (intervalMs, janitorOptions) => registry.startJanitors(intervalMs, janitorOptions) };
}
