// agents/prior-authorization-agent/src/serve/wiring.ts
// Joins the folders of the agent (`model`, `insurer`, `counter`, `evidence`, `propose`, `execute`) and the kit to the real parts: the chain of each paying key, the gateway, the ledger, the node, the model hires, the
// dispute code, the durable files and the janitors. The folders never import each other, and they take every outside source as a port. This file builds the ports, and nothing else decides what a job does. It reads
// no environment variable and no key: the settings and the key material come in as values (src/serve/start.ts reads them).
//
// Three paying keys. The service key and the two delegation keys are in ONE registry (`PayingKeys`), each added with its key hash, which the start derived from the key that the chain signs with, and with its own
// folder `keys/<key hash>` of the state directory. The registry reads no wallet then: the wallet of the real chain is a read of the node, and a node that is down must not stop the start. The four subagent keys pay
// nothing and hold no chain. The seven keys are checked first: two keys that are one key, or a key that is the supplier key, stop the wiring before a chain is made.
//
// One queue for each paying key. The `lane` of a `PayingKey` is that queue, and the same object goes to every user of the key. The service key has one wallet, so its lane runs the model hires and the claims and the
// challenges of the dispute code, one at a time. Each delegation key has one wallet too: its lane runs the vault Pay and the Accept of a hire, the Delegate and the Undelegate of a sub-delegation, and the work of
// the janitor of left sub-delegations, which never starts a transaction while the lane is busy.
//
// One set of delegation ids and one list of left sub-delegations. A read of the evidence adds the id of its sub-delegation to the set before its Delegate is sent, and it deletes the id after it updated the list.
// The janitor skips an id that is in the set, so it never ends the sub-delegation of a job that still runs. The evidence and the janitor get the same set, the same list and the same delegation script.
//
// One counter for the process. The counter of request numbers keeps its numbers in one file. Two objects on one file would give one number twice, so the process makes one counter and every job gets it.
//
// One deadline for each job. A decision hires a model, and a hire needs the deadline of its job. The deps of a job are made when the job arrives (`proposeDeps`, `executeDeps`): the decision of that job holds the
// deadline of that job, and no other job can change it.
import { join } from 'node:path';
import { OgmiosProvider, createRealChain, fetchSuppliers, module1FromManifest, readAdvert, readDelegation, readManifest, MODULE1_MANIFEST_ENV } from '@vsa/buyer-core';
import type { IdentityDeployment, LedgerEnv, Module1Deployment, RealChainOptions, VaultChain } from '@vsa/buyer-core';
import { PayingKeys, stopJanitorWithin } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient } from '@vsa/id-kit/client';
import { within } from '@vsa/service-kit';
import { systemClock } from '@vsa/usecase-kit/access';
import type { Clock, DelegationChain, MockBases } from '@vsa/usecase-kit/access';
import { ledgerReadsFrom } from '@vsa/usecase-kit/buyer';
import type { HireLimits } from '@vsa/usecase-kit/buyer';
import { FileKeyRegister, createCosignRoute, providerLedger } from '@vsa/usecase-kit/cosign';
import type { CosignRoute, CosignSettings } from '@vsa/usecase-kit/cosign';
import { decide } from '@vsa/usecase-kit/decision';
import type { DecisionDeps, ModelLimits } from '@vsa/usecase-kit/decision';
import { Dispute, FileJournal, createModule1Port } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings, Module1Provider } from '@vsa/usecase-kit/dispute';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { FileLeftStore, startJanitor } from '@vsa/usecase-kit/janitor';
import type { JanitorDeps } from '@vsa/usecase-kit/janitor';
import { delegationChainOf, tipSlotOf } from '@vsa/usecase-kit/live';
import { parseGuideline, parseRecordSet } from '@vsa/usecase-kit/priorauth';
import { agentIdOf } from '@vsa/usecase-kit/protocol';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';
import { FileRequestCounter } from '../counter/index.ts';
import { readEvidence } from '../evidence/index.ts';
import type { EvidenceDeps, InFlight } from '../evidence/index.ts';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../execute/index.ts';
import type { DelegationKeyDeps, ExecuteDeps } from '../execute/index.ts';
import { readInsurer } from '../insurer/index.ts';
import type { AdvertRead, InsurerDeps, SupplierRow } from '../insurer/index.ts';
import { ACCEPT_DECISION, acceptInput, justificationDecision, justificationInput } from '../model/index.ts';
import { PROPOSE_DEADLINE_MS } from '../propose/index.ts';
import type { DelegationKey as ProposeKey, ProposeDeps } from '../propose/index.ts';
import { keyClashOf } from './keys.ts';
import type { KeyMaterial, KeyRole } from './keys.ts';
import type { Endpoints, SupplierKey } from './settings.ts';

/** The most time that one check of a delegation may take: every read of one check runs inside this budget. A check that does not end in it is a refusal (the ledger could not be read). */
export const LEDGER_BUDGET_MS = 20_000;
/** The most time that the start waits for the node to give the start time of the chain. */
export const SYSTEM_START_TIMEOUT_MS = 15_000;
/** The most time that one read of the tip of the node may take, for the janitor. */
export const TIP_TIMEOUT_MS = 10_000;
/** The state files of the service, inside the state directory. */
export const STATE_FILES = { dispute: 'dispute', left: 'left', register: 'cosign-register.json', counter: 'request-numbers.json' } as const;

/**
 * What the wiring needs, as values: the state directory, the three DIDs, the supplier key, the seven keys, the endpoints, the two origins of the mock service, the identity deployment, the limits of the model hires
 * and of the hire of the Insurer Intake Agent, the dispute settings, the source of the Module-1 manifest and the fault switch that the start made.
 */
export interface WiringSettings {
  readonly stateDir: string;
  readonly agentDid: Did;
  readonly recordReaderDid: Did;
  readonly drafterDid: Did;
  readonly supplier: SupplierKey;
  readonly keys: Readonly<Record<KeyRole, KeyMaterial>>;
  readonly endpoints: Endpoints;
  readonly mock: MockBases;
  readonly identityDeployment: IdentityDeployment;
  readonly modelLimits: ModelLimits;
  readonly handoffLimits: HireLimits;
  readonly dispute: DisputeSettings;
  readonly module1Manifest: string;
  readonly fault: FaultSwitch<'prior-authorization-agent'>;
}

/**
 * The readers under `readInsurer`, by the shapes that the reader uses of them. The real readers of buyer-core have more members, and each of them fits. A test replaces them: the service uses the real ones.
 */
export interface InsurerSources {
  readonly fetchSuppliers: (options: { fetchImpl: typeof fetch; capability_id: string }) => Promise<readonly SupplierRow[]>;
  readonly readAdvert: (ref: string, fetchImpl: typeof fetch, koiosUrl: string, identityAdvertAddress: string | null) => Promise<AdvertRead>;
}

/** The parts of the wiring that a test replaces. The service passes none of them, except the log. */
export interface WiringOptions {
  readonly fetchImpl?: typeof fetch;
  readonly clock?: Clock;
  readonly log?: (line: string) => void;
  /** Makes the chain of a key. Default `createRealChain`, which builds, signs and submits on Vector mainnet. */
  readonly createChain?: (options: RealChainOptions) => Promise<VaultChain>;
  /** The node. Default the Ogmios provider of buyer-core at the address of VECTOR_OGMIOS_URL. */
  readonly provider?: Module1Provider;
  /** The Module-1 deployment. Default: the manifest of the settings, read at the start. */
  readonly module1?: Module1Deployment;
  readonly sources?: Partial<InsurerSources>;
  /** The chain of the sub-delegations. Default the live one over the node. */
  readonly delegationChain?: DelegationChain;
  /** The client of the identity gateway. Default the real client at the address of IDENTITY_GATEWAY_URL. */
  readonly gateway?: Pick<GatewayClient, 'requestToken'>;
  /** The slot of the tip of the node, for the janitor. Default `tipSlotOf` at the address of VECTOR_OGMIOS_URL. */
  readonly tipSlot?: () => Promise<number>;
}

/** The wired service: what `startService` and the server use. */
export interface Wired {
  /** The start time of the chain in POSIX milliseconds, as the node gave it at the start. */
  readonly systemStartMs: number;
  readonly provider: Module1Provider;
  readonly ledger: LedgerEnv;
  readonly gateway: Pick<GatewayClient, 'requestToken'>;
  /** The service key: model hires, claims and challenges. */
  readonly service: PayingKey;
  /** The two delegation keys, in the order of the settings. */
  readonly delegations: readonly PayingKey[];
  readonly dispute: Dispute;
  readonly leftStore: FileLeftStore;
  readonly counter: FileRequestCounter;
  /** The ids of the sub-delegations that a read of this process still uses. */
  readonly inFlight: ReadonlySet<string>;
  /** The deps of the evidence: the two subagents, the sub-delegation, the tokens, the calls, the list of left sub-delegations and the set of ids. One object for the process. */
  readonly evidenceDeps: EvidenceDeps;
  /** The deps of a `propose` job that arrived at `arrivedAt`. */
  proposeDeps(arrivedAt: number): ProposeDeps;
  /** The deps of an `execute` job that arrived at `arrivedAt`. */
  executeDeps(arrivedAt: number): ExecuteDeps;
  /** The deps of the janitor of left sub-delegations. */
  janitorDeps(stopWaitMs: number): JanitorDeps;
  /** The co-sign route, over the two delegation keys and the register file of the state directory. A setting or a route that the kit refuses throws an Error with the detail. */
  cosignRoute(settings: CosignSettings): CosignRoute;
  /** The janitor of the stranded escrows of each paying key and the janitor of left sub-delegations. `stop` waits at most `stopWaitMs` for each. */
  startJanitors(intervalMs: number, stopWaitMs: number): { stop(): Promise<void> };
  /** The line a stop logs when it abandons the job that runs: the escrows that the state directory holds for the janitors of the next start. */
  abandonedLine(waitMs: number): string;
}

/** The start time of the chain from the node. A node that gives none, gives a time that is not a whole number of milliseconds, or does not answer in time stops the start. */
async function systemStartOf(provider: Module1Provider): Promise<number> {
  let ms: number;
  try {
    ms = await within(provider.getSystemStartMs(), SYSTEM_START_TIMEOUT_MS);
  } catch {
    throw new Error('the node gave no start time of the chain: the co-sign route needs it to read the validity window of a transaction, so the service does not start without it');
  }
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error('the node gave a start time of the chain that is not a time: the co-sign route needs it, so the service does not start with it');
  return ms;
}

/**
 * Builds everything that the jobs, the route and the janitors use. It reaches out for two things, and each can fail the start: the Module-1 manifest (an https address, pinned to a commit: the one file that the
 * start fetches) and the start time of the chain from the node. The three paying keys are added with the key hash that the settings carry, so no wallet is read. The rest is made with no call. A clash among the
 * keys is refused first, before a chain is made.
 */
export async function wire(settings: WiringSettings, options: WiringOptions = {}): Promise<Wired> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? ((): void => undefined);
  const { endpoints, keys, identityDeployment } = settings;
  const now = (): number => clock.now();
  const sleep = (ms: number): Promise<void> => clock.sleep(ms);
  if (keyClashOf(keys, settings.supplier.pkh) !== null) throw new Error('two keys of the service are one key, or a key is the supplier key: each key must be a key of its own');

  const provider: Module1Provider = options.provider ?? new OgmiosProvider({ ogmiosUrl: endpoints.ogmiosUrl, submitUrl: endpoints.submitUrl, koiosUrl: endpoints.koiosUrl });
  const ledger: LedgerEnv = { provider, deployment: identityDeployment, koiosUrl: endpoints.koiosUrl, fetchImpl, budgetMs: LEDGER_BUDGET_MS };
  let module1 = options.module1;
  if (module1 === undefined) {
    module1 = module1FromManifest(await readManifest(settings.module1Manifest, `The Module-1 manifest (${MODULE1_MANIFEST_ENV})`, fetchImpl), settings.module1Manifest);
    // A manifest of another registry, from a wrong commit, would make the dispute code build against records that the identity deployment of this service does not own. The message names the two settings and shows no hash.
    if (module1.identityHash !== identityDeployment.identity.hash) {
      throw new Error(`the Module-1 manifest (${MODULE1_MANIFEST_ENV}) names another identity registry than IDENTITY_POLICY_ID: it is the manifest of another deployment, so the service does not start with it`);
    }
  }
  const systemStartMs = await systemStartOf(provider);

  // The three paying keys. A chain is made from the key and the identity deployment that pays from a vault. The registry is given the key hash of each key, so it reads no wallet.
  const chainOf = (role: KeyRole): Promise<VaultChain> => keys[role].withKey((privateKeyHex) => (options.createChain ?? createRealChain)({
    privateKeyHex, koiosUrl: endpoints.koiosUrl, ogmiosUrl: endpoints.ogmiosUrl, submitUrl: endpoints.submitUrl, fetchImpl, identityDeployment,
    ...(endpoints.indexerUrl === undefined ? {} : { indexerUrl: endpoints.indexerUrl }),
  }));
  const registry = new PayingKeys(settings.stateDir);
  const payingOf = async (role: KeyRole): Promise<PayingKey> => registry.add(await chainOf(role), { dir: join(settings.stateDir, 'keys', keys[role].pkh), keyHash: keys[role].pkh });
  const service = await payingOf('service');
  const delegation1 = await payingOf('delegation1');
  const delegation2 = await payingOf('delegation2');
  const delegations: readonly PayingKey[] = [delegation1, delegation2];
  const delegationKeys: readonly KeyMaterial[] = [keys.delegation1, keys.delegation2];
  const delegationOf = (keyHash: string): { readonly paying: PayingKey; readonly material: KeyMaterial } | null => {
    const at = delegationKeys.findIndex((material) => material.pkh === keyHash);
    return at === -1 ? null : { paying: delegations[at], material: delegationKeys[at] };
  };

  const gateway = options.gateway ?? createGatewayClient({ baseUrl: endpoints.gatewayUrl, fetch: fetchImpl, now });
  const reads = ledgerReadsFrom(ledger);
  const delegationChain = options.delegationChain ?? delegationChainOf({ ...ledger, provider });
  const journal = new FileJournal(join(settings.stateDir, STATE_FILES.dispute));
  const dispute = new Dispute({
    port: createModule1Port({
      provider, module1, address: keys.service.address, agent_id: agentIdOf(settings.agentDid), sign: (unsignedCborHex) => keys.service.signUnsigned(unsignedCborHex), clock: now, sleep,
      koios_url: endpoints.koiosUrl, fetch: fetchImpl, identity_deployment: identityDeployment,
    }),
    queue: service.lane, clock: now, sleep, settings: settings.dispute, journal, log,
  });
  const leftStore = new FileLeftStore(join(settings.stateDir, STATE_FILES.left));
  const counter = new FileRequestCounter(join(settings.stateDir, STATE_FILES.counter));

  const ids = new Set<string>();
  const inFlight: InFlight = { add: (id) => { ids.add(id); }, delete: (id) => { ids.delete(id); } };

  /** The leaf of a delegation names the key that it gives the delegation to: its key hash, or null when the ledger shows no such delegation. */
  const delegateKeyOf = async (id: DelegationId): Promise<string | null> => {
    const leaf = (await readDelegation(ledger, id)).chain[0];
    return leaf === undefined ? null : leaf.delegation.delegateKey;
  };

  /** What the ledger of the hires books. It logs the fee and the hash, and nothing else. */
  const hireLedger: HireLedger = {
    posted: ({ lockLovelace, feeLovelace }) => { log(`booked a Post: lock ${lockLovelace} lovelace, fee ${feeLovelace} lovelace`); },
    accepted: ({ feeLovelace, txHash }) => { log(`booked an Accept: fee ${feeLovelace} lovelace, transaction ${txHash}`); },
  };
  const decisionDeps = (deadlineMs: number): DecisionDeps => ({
    key: service, limits: settings.modelLimits, clock: now, sleep, deadlineMs, fetchImpl, ledger: hireLedger, log,
    ...(endpoints.indexerUrl === undefined ? {} : { indexerUrl: endpoints.indexerUrl }),
  });

  const sources: InsurerSources = { fetchSuppliers, readAdvert, ...options.sources };
  // The reader of the insurer. `readAdvert` gets the advert address of the identity deployment: without it every advert of an Insurer Intake Agent reads as an error, and the reader gives `insurer_unavailable`.
  const insurerDeps: InsurerDeps = {
    // `fetchSuppliers` of buyer-core takes no address of an indexer: it reads the one that VECTOR_MARKETPLACE_INDEXER_URL gave it when it loaded, and the configured one when that is not set.
    listAdverts: (capabilityId) => sources.fetchSuppliers({ fetchImpl, capability_id: capabilityId }),
    readAdvert: (ref) => sources.readAdvert(ref, fetchImpl, endpoints.koiosUrl, identityDeployment.advert.address),
    clock: now,
  };

  const calls = { fetch: fetchImpl, clock, bases: settings.mock };
  const tokens = { client: gateway };
  const evidenceDeps: EvidenceDeps = {
    subagents: {
      record_reader: { did: settings.recordReaderDid, authenticationKey: keys.recordReaderAuthentication.keyObject, delegationKey: keys.recordReaderDelegation.keyObject, signer: keys.recordReaderDelegation.signer },
      drafter: { did: settings.drafterDid, authenticationKey: keys.drafterAuthentication.keyObject, delegationKey: keys.drafterDelegation.keyObject, signer: keys.drafterDelegation.signer },
    },
    subDelegation: { chain: delegationChain, clock, delegationScript: identityDeployment.delegation, bases: settings.mock },
    tokens, calls, clock, leftSink: leftStore, inFlight, parseRecordSet, parseGuideline, log,
  };

  // The queue of the wallet of a delegation key is the lane of its paying key: the one object that holds the Delegate and the Undelegate of a sub-delegation, the vault Pay and the Accept of a hire, and the janitor.
  const proposeKeys = { find: (keyHash: string): ProposeKey | null => {
    const found = delegationOf(keyHash);
    return found === null ? null : { signer: found.material.signer, walletAddress: found.material.address, queue: found.paying.lane };
  } };
  const executeEntry = (found: { readonly paying: PayingKey; readonly material: KeyMaterial }): DelegationKeyDeps => ({ key: found.paying, dpopKey: found.material.keyObject });
  const executeKeys = {
    find: (keyHash: string): DelegationKeyDeps | null => {
      const found = delegationOf(keyHash);
      return found === null ? null : executeEntry(found);
    },
    first: executeEntry({ paying: delegation1, material: keys.delegation1 }),
  };

  let tip: (() => Promise<number>) | undefined;
  // The reader of the tip is made at its first use: it takes an https address only, and a janitor with nothing to look at never asks the node.
  const tipSlot = options.tipSlot ?? (async (): Promise<number> => {
    tip ??= tipSlotOf({ fetch: fetchImpl, ogmiosUrl: endpoints.ogmiosUrl, timeoutMs: TIP_TIMEOUT_MS });
    return tip();
  });
  const janitorDeps = (stopWaitMs: number): JanitorDeps => ({
    store: leftStore, chain: delegationChain, delegationScript: identityDeployment.delegation,
    signerOf: (keyHash) => delegationOf(keyHash)?.material.signer ?? null,
    queueOf: (keyHash) => {
      const found = delegationOf(keyHash);
      if (found === null) throw new Error('the janitor asked for the queue of a key that the service does not hold');
      return found.paying.lane;
    },
    tipSlot, clock, log, inFlight: (id) => ids.has(id), stopWaitMs,
  });

  return {
    systemStartMs, provider, ledger, gateway, service, delegations, dispute, leftStore, counter, inFlight: ids, evidenceDeps,
    proposeDeps: (arrivedAt) => ({
      agent: { did: settings.agentDid },
      reads,
      delegateKeyOf,
      delegationKeys: proposeKeys,
      readInsurer: (insurer) => readInsurer(insurerDeps, insurer),
      evidence: (request, run) => readEvidence(evidenceDeps, request, run),
      justify: async (set, guideline) => {
        // The closed sets of the references are made from the two documents of THIS job: a reference that names no record of the set and no criterion of the guideline is refused by the parser of the decision.
        const decision = justificationDecision({ record_ids: set.records.map((record) => record.record_id), criterion_ids: guideline.criteria.map((criterion) => criterion.id) });
        const decided = await decide(decisionDeps(arrivedAt + PROPOSE_DEADLINE_MS), decision, justificationInput(set, guideline));
        // The reason is the code of the failure: a prompt that is too large is `bad_input`, and it fails before any hire.
        if (!decided.ok) return { ok: false, code: decided.reason };
        // The choice is built from the choice that the decision records, member by member: the request is made from the choice that the model gave.
        const { justification, guideline_refs: guidelineRefs, record_refs: recordRefs } = decided.value.choice;
        return { ok: true, decision: decided.value, choice: { justification, guideline_refs: [...guidelineRefs], record_refs: [...recordRefs] } };
      },
      counter,
      clock,
      log,
    }),
    executeDeps: (arrivedAt) => ({
      reads,
      delegateKeyOf,
      delegationKeys: executeKeys,
      hire: { clock: now, sleep, fetchImpl, ledger: hireLedger, log, ...(endpoints.indexerUrl === undefined ? {} : { indexerUrl: endpoints.indexerUrl }) },
      limits: settings.handoffLimits,
      acceptDelivery: async (sent, received) => {
        const decided = await decide(decisionDeps(arrivedAt + EXECUTE_DEADLINE_MS), ACCEPT_DECISION, acceptInput(sent, received));
        if (!decided.ok) return { ok: false, code: decided.reason };
        const { accept, mismatch } = decided.value.choice;
        return { ok: true, decision: decided.value, choice: { accept, mismatch: [...mismatch] } };
      },
      dispute,
      buyerPkhs: delegationKeys.map((material) => material.pkh),
      // The service key is the authentication key of the agent: it signs the subject token of a token request.
      agent: { did: settings.agentDid, authenticationKey: keys.service.keyObject },
      tokens,
      calls,
      fault: settings.fault,
      log,
    }),
    janitorDeps,
    cosignRoute: (cosign) => {
      const made = createCosignRoute({
        agentDid: settings.agentDid, deployment: identityDeployment,
        delegationKeys: delegationKeys.map((material) => ({ publicKey: material.publicKeyHex, sign: (bodyHash: Uint8Array) => material.signBodyHash(bodyHash) })),
        otherKeyHashes: [keys.service.pkh, settings.supplier.pkh, keys.recordReaderAuthentication.pkh, keys.recordReaderDelegation.pkh, keys.drafterAuthentication.pkh, keys.drafterDelegation.pkh],
        settings: cosign, ledger: providerLedger(provider, identityDeployment), register: new FileKeyRegister(join(settings.stateDir, STATE_FILES.register)), systemStartMs, now, log,
      });
      if (!made.ok) throw new Error(`the co-sign route is refused: ${made.detail}`);
      return made.value;
    },
    startJanitors: (intervalMs, stopWaitMs) => {
      const stranded = registry.startJanitors(intervalMs, { clock: now, log });
      const left = startJanitor(janitorDeps(stopWaitMs), intervalMs);
      return { stop: async () => { await Promise.all([stopJanitorWithin(stranded, stopWaitMs, log), left.stop()]); } };
    },
    abandonedLine: (waitMs) => {
      const refs = registry.list().flatMap((key) => key.stranded.list().map((entry) => entry.escrow_ref));
      return `stopping: the job that is running did not finish within ${waitMs} ms and is abandoned; the state directory holds ${refs.length} ${refs.length === 1 ? 'escrow' : 'escrows'} `
        + `for the janitors of the next start${refs.length === 0 ? '' : `: ${refs.join(', ')}`}`;
    },
  };
}
