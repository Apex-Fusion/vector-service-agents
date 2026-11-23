// agents/order-desk/src/serve/wiring.ts
// The real ports of the Order Desk: where the hook, the job and the dispute code get what they read, write and decide with. The folders of the hook (src/checks) and of the job (src/job) import neither each other nor
// this file; they get their ports in their deps, and this is the one place that makes them.
//
//   one paying key     The service key has one chain, one stranded store, one janitor and ONE queue (`lane`). The model hire of the decision, the claims and the challenges of the dispute code all run in that queue,
//                      so no two of them build a transaction from the one wallet together. The key comes from the registry of the kit (`PayingKeys.add`), named by the key hash that the service key derives and in the
//                      folder `keys/<key hash>` of the state directory. The hash is given, so that `add` reads no wallet: the wallet of the real chain is a read of the node, and a node that is down would stop the start.
//   two gateway clients  The hook reads the gateway once, with a client whose timeout is the budget of the hook (CHECKS_READ_BUDGET_MS). The job asks the gateway for its X.509-SVID with a client that has the default
//                      timeout of 10 s: an SVID that fails after the Claim would lose the job, and the hook is the only call that the runtime waits for.
//   the hook's ledger  Every read of the ledger by the hook ends inside the budget of the hook. The wiring sets that budget over the one that the environment of the ledger carries.
//   the decision       `decide` of the kit with the decision `availability`, the four limits of the settings and the deadline of the job, 300 s after the job arrived. One decision is one hire, with no second try.
//   the challenge      A task that starts after the hook has answered (`setImmediate`): the runtime waits 10 s for the hook, and a challenge takes two transactions.
//
// A line that this file writes holds codes, references and the kind of an error, and never the message of an error: a message can name an address with a key in it, or a part of a request.
import { join } from 'node:path';
import { OgmiosProvider, createRealChain, module1FromManifest, readManifest } from '@vsa/buyer-core';
import type { Chain, LedgerEnv, RealChainOptions } from '@vsa/buyer-core';
import { PayingKeys } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { JobContext, PrecheckAnswer } from '@vsa/service-kit';
import { httpsTransport, systemClock } from '@vsa/usecase-kit/access';
import type { Clock, MtlsTransport } from '@vsa/usecase-kit/access';
import { ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { decide } from '@vsa/usecase-kit/decision';
import { Dispute, FileJournal, createModule1Port } from '@vsa/usecase-kit/dispute';
import type { Module1Port } from '@vsa/usecase-kit/dispute';
import { agentIdOf } from '@vsa/usecase-kit/protocol';
import type { Handoff } from '@vsa/usecase-kit/protocol';
import { FileOrderBook, PassedChecks, createPrecheck } from '../checks/index.ts';
import { AVAILABILITY_DECISION } from '../job/index.ts';
import type { OrderDeps } from '../job/index.ts';
import { serviceKeyOf } from './keys.ts';
import type { ServiceKey } from './keys.ts';
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
  /** The transport that presents the X.509-SVID as the client certificate. */
  readonly transport?: MtlsTransport;
  /** The ledger that the hook reads. Its budget is replaced by the budget of the hook. */
  readonly ledgerEnv?: LedgerEnv;
  /** The Module-1 port of the dispute code. The default reads the manifest of the deployment and makes the real port. */
  readonly module1Port?: Module1Port;
}

/** The hook as the job server takes it. */
export type Precheck = (request: Handoff, context: JobContext) => Promise<PrecheckAnswer>;

export interface Wired {
  /** The paying key of the service key: its chain, its queue (`lane`), its stranded store and its janitor. */
  readonly key: PayingKey;
  readonly precheck: Precheck;
  /** The ports of the job that arrived at the time given. */
  readonly jobDeps: (arrivedAt: number) => OrderDeps;
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

/** The Module-1 port: the one that a test gives, or the real port over the manifest of the deployment. The manifest must name the identity registry that the deployment of this service gives. */
async function module1PortOf(
  config: ServiceConfig, options: WireOptions, ports: { clock: () => number; sleep: (ms: number) => Promise<void>; fetchImpl: typeof fetch; koiosUrl: string; service: ServiceKey },
): Promise<Module1Port> {
  if (options.module1Port !== undefined) return options.module1Port;
  const json = await readManifest(config.module1Manifest, 'The Module-1 manifest (VECTOR_MODULE1_MANIFEST)', ports.fetchImpl);
  const module1 = module1FromManifest(json, config.module1Manifest);
  if (module1.identityHash !== config.identityDeployment.identity.hash) {
    throw new Error(`the Module-1 manifest names the identity registry ${module1.identityHash}, but the identity deployment of this service is ${config.identityDeployment.identity.hash}`);
  }
  return createModule1Port({
    provider: new OgmiosProvider({ ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, koiosUrl: ports.koiosUrl }),
    module1, address: ports.service.address, agent_id: agentIdOf(config.agentDid), sign: ports.service.sign, clock: ports.clock, sleep: ports.sleep, koios_url: ports.koiosUrl, fetch: ports.fetchImpl,
    identity_deployment: config.identityDeployment,
  });
}

/**
 * Makes the real parts of the service from its configuration and joins them: the chain and the paying key, the two gateway clients, the ledger of the hook, the order book and the record of the passed checks, the
 * dispute code over its journal and its port, the hook, and the ports of the job. It reads files and makes no network call. It throws, naming what is wrong, and nothing keeps running then.
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
  const service = serviceKeyOf(config.service.privateKeyHex);
  const koiosUrl = config.endpoints.koiosUrl.replace(/\/+$/, '');

  const chain = await (options.createChain ?? createRealChain)({
    privateKeyHex: config.service.privateKeyHex, koiosUrl, ogmiosUrl: config.endpoints.ogmiosUrl, submitUrl: config.endpoints.submitUrl, identityDeployment: config.identityDeployment,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }), ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
  });
  // The registry holds the one key. The key hash is the one that the service key derives, and the folder is `keys/<key hash>` of the state directory. The stranded file in it is read here.
  const key = await new PayingKeys(config.stateDir).add(chain, { dir: join(config.stateDir, 'keys', service.pkh), keyHash: service.pkh });

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

  const book = new FileOrderBook(join(config.stateDir, 'orders.json'));
  const passed = new PassedChecks();
  const journal = new FileJournal(join(config.stateDir, 'dispute'));
  const port = await module1PortOf(config, options, { clock, sleep, fetchImpl, koiosUrl, service });
  let dispute: Dispute;
  try {
    dispute = new Dispute({ port, queue: key.lane, clock, sleep, settings: config.dispute, journal, log: say });
  } catch (error) {
    throw new Error(`the dispute settings are refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  const precheck = createPrecheck({
    ports, lots: config.lots.file, book, self: config.agentDid, passed, dispute,
    // The task starts after the answer is written. The task catches its own errors, and the catch here is the second line.
    schedule: (task) => { setImmediate(() => { void task().catch(() => undefined); }); },
    log: say,
  });

  const callClock: Clock = { now: clock, sleep: systemClock.sleep };
  const transport = options.transport ?? httpsTransport;
  const hireLedger = hireLedgerOf(say);
  const jobDeps = (arrivedAt: number): OrderDeps => ({
    agent: { did: config.agentDid, authenticationKey: service.authentication },
    svid: { client: jobGateway },
    calls: { fetch: fetchImpl, clock: callClock, bases: config.mock, timeoutMs: CALL_TIMEOUT_MS, transport },
    takeChecks: (escrowRef) => passed.take(escrowRef, clock()),
    lots: config.lots.file,
    book,
    decide: (input) => decide(
      {
        key, limits: config.limits, clock, sleep, deadlineMs: arrivedAt + JOB_DEADLINE_MS, fetchImpl, ledger: hireLedger, log: say,
        ...(config.endpoints.indexerUrl === undefined ? {} : { indexerUrl: config.endpoints.indexerUrl }),
      },
      AVAILABILITY_DECISION,
      input,
    ),
    fault: config.fault,
    clock,
    log: say,
  });
  return { key, precheck, jobDeps };
}
