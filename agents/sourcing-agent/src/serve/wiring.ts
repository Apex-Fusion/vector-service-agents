// agents/sourcing-agent/src/serve/wiring.ts
// Joins the folders of the agent (`bidders`, `facts`, `compliance`, `model`, `quotes`, `scoring`, `propose`, `execute`) and the kit to the real parts: the chain of each paying key, the gateway, the ledger, the node, the
// model hires, the dispute code, the readers of the bidder file, the verifier and the durable files. The folders never import each other, and they take every outside source as a port. This file builds the ports, and
// nothing else decides what a job does. It reads no environment variable and no key: the settings and the key material come in as values (src/serve/start.ts reads them).
//
// One queue for each paying key. The `lane` of a `PayingKey` is that queue, and the same object goes to every user of the key. The service key has one wallet, so its lane runs the model hires and the claims and the
// challenges of the dispute code, one at a time. Each delegation key has one wallet too: its lane runs the vault Pay and the Accept of each quote hire, the Delegate and the Undelegate of each sub-delegation of a
// scorer, and the work of the janitor of left sub-delegations, which never starts a transaction while the lane is busy. The six keys of the scorers are no paying keys: they sign a sub-delegation and a token, and
// they own no wallet and no queue.
//
// One set of delegation ids. A run of `scoring` adds the id of its sub-delegation to the set before its Delegate is sent, and deletes it after the run has updated the list of left sub-delegations. The janitor of that
// list skips an id that is in the set, so it never ends the sub-delegation of a job that still runs.
//
// One of each of these for the whole process: the Module-1 port, the dispute code and its journal, the list of left sub-delegations and the verifier of the credentials. The Module-1 port is made one time from the
// manifest that the start fetched, and the same object goes to the dispute code and to the reader of the cases against a bidder.
//
// One deadline for each job. A decision hires a model, and a hire needs the deadline of its job. The deps of a job are made when the job arrives (`proposeDeps`, `executeDeps`): the decision of that job holds the
// deadline of that job, and no other job can change it. The scoring gets the deadline of the job less the time of the ranking decision, from the input that the job gives it.
//
// One co-sign route for the process. The route signs a Delegate for one of the two delegation keys. It refuses a Delegate that spends an output of any other key of the agent: the service key, the supplier key and the six
// keys of the scorers. Its register of the signed bodies is a file of the state directory, so a restart does not free a delegation key that signed a body. The route reads the validity window of a transaction against the
// start time of the chain, and the start asks the node for that time one time, with a bound.
//
// Two kinds of janitor. One janitor works on the stranded escrows of each of the three paying keys, and one works on the left sub-delegations. They start together and stop together. Each has its own bound at a stop: a pass
// that hangs on a call to the node is abandoned, and its entries stay in the state directory for the next start.
import { join } from 'node:path';
import { OgmiosProvider, READ_BUDGET_MS, createRealChain, fetchSuppliers, listAttestations, module1FromManifest, readAdvert, readDelegation, readManifest, MODULE1_MANIFEST_ENV } from '@vsa/buyer-core';
import type { AttestationPage, AttestationQuery, IdentityDeployment, LedgerEnv, Module1Deployment, RealChainOptions, VaultChain } from '@vsa/buyer-core';
import { PayingKeys, stopJanitorWithin } from '@vsa/hire-kit';
import type { HireLedger, PayingKey } from '@vsa/hire-kit';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient } from '@vsa/id-kit/client';
import { createVerifier } from '@vsa/id-kit/verify';
import { within } from '@vsa/service-kit';
import { safeFetch } from '@vsa/vector-read';
import type { KoiosUtxo } from '@vsa/vector-read';
import { systemClock } from '@vsa/usecase-kit/access';
import type { Clock, MockBases } from '@vsa/usecase-kit/access';
import { ledgerReadsFrom } from '@vsa/usecase-kit/buyer';
import type { HireLimits } from '@vsa/usecase-kit/buyer';
import { FileKeyRegister, createCosignRoute, providerLedger } from '@vsa/usecase-kit/cosign';
import type { CosignRoute, CosignSettings } from '@vsa/usecase-kit/cosign';
import { decide } from '@vsa/usecase-kit/decision';
import type { DecisionDeps, ModelLimits } from '@vsa/usecase-kit/decision';
import { Dispute, FileJournal, createModule1Port } from '@vsa/usecase-kit/dispute';
import type { DisputeSettings, Module1Port, Module1PortDeps, Module1Provider } from '@vsa/usecase-kit/dispute';
import type { FaultSwitch } from '@vsa/usecase-kit/fault';
import { FileLeftStore, startJanitor } from '@vsa/usecase-kit/janitor';
import type { JanitorDeps } from '@vsa/usecase-kit/janitor';
import { delegationChainOf, tipSlotOf } from '@vsa/usecase-kit/live';
import { agentIdOf, refused } from '@vsa/usecase-kit/protocol';
import type { DelegationId, Did } from '@vsa/usecase-kit/protocol';
import { BIDDER_READ_BUDGET_MS, parseArdCatalog, readBidders } from '../bidders/index.ts';
import type { AdvertRead, BidderRow, BiddersDeps } from '../bidders/index.ts';
import { readCompliance } from '../compliance/index.ts';
import type { DelegationKeyDeps, ExecuteDeps } from '../execute/index.ts';
import { FACT_READ_TIMEOUT_MS, casesAgainst, readCredential, readStake } from '../facts/index.ts';
import { ACCEPT_QUOTE_DECISION, RANKING_DECISION, SCORE_DECISION, SHORTLIST_DECISION, acceptQuoteInput, rankingInput, scoreInput, shortlistInput } from '../model/index.ts';
import { PROPOSE_DEADLINE_MS } from '../propose/index.ts';
import type { DiscoverResult, ProposeDeps } from '../propose/index.ts';
import { runQuotes } from '../quotes/index.ts';
import type { BidderStatus, QuotesDeps } from '../quotes/index.ts';
import { runScoring } from '../scoring/index.ts';
import type { Scorer, ScoringDeps } from '../scoring/index.ts';
import { KEY_ROLES, keyClashOf } from './keys.ts';
import type { KeyMaterial, KeyRole } from './keys.ts';
import type { Endpoints, SupplierKey } from './settings.ts';

/** The most time that one check of a delegation may take: every read of one check runs inside this budget. A check that does not end in it is a refusal (the ledger could not be read). */
export const LEDGER_BUDGET_MS = 20_000;
/** The most time that one read of the tip of the node may take, for the janitor. */
export const TIP_TIMEOUT_MS = 10_000;
/** The most time that the start waits for the node to give the start time of the chain. */
export const SYSTEM_START_TIMEOUT_MS = 15_000;
/** The most bytes that the read of the catalog of the gateway takes. A catalog above it is a catalog that could not be read. */
export const CATALOG_MAX_BYTES = 4_000_000;
/** The most time that the read of the catalog of the gateway takes. */
export const CATALOG_TIMEOUT_MS = 10_000;
/** The state files of the service, inside the state directory. The stranded store of each paying key is in the folder `keys/<key hash>`. */
export const STATE_FILES = { dispute: 'dispute', left: 'left', register: 'cosign-register.json' } as const;

/**
 * What the wiring needs, as values: the state directory, the identities of the agent and of its three scorers, the nine keys, the public values (the supplier key and the issuer of the compliance attestations), the
 * endpoints, the mock service, the identity deployment, the limits of the two kinds of hire, the dispute settings, the source of the Module-1 manifest and the fault switch.
 */
export interface WiringSettings {
  readonly stateDir: string;
  readonly agentDid: Did;
  /** The DIDs of the three scorers: scorer `k + 1` has `scorerDids[k]` and the keys `scorer<k + 1>Authentication` and `scorer<k + 1>Delegation`. */
  readonly scorerDids: readonly [Did, Did, Did];
  readonly supplier: SupplierKey;
  readonly keys: Readonly<Record<KeyRole, KeyMaterial>>;
  /** The key hash of the issuer of the compliance attestations that the agent counts: 56 lower-case hex characters. */
  readonly complianceIssuerPkh: string;
  readonly endpoints: Endpoints;
  readonly mock: MockBases;
  readonly identityDeployment: IdentityDeployment;
  /** The four limits of a model hire. */
  readonly modelLimits: ModelLimits;
  /** The three limits of the hire of a quote. */
  readonly quoteLimits: HireLimits;
  readonly dispute: DisputeSettings;
  /** The https address of the Module-1 manifest, pinned to a commit. */
  readonly module1Manifest: string;
  readonly fault: FaultSwitch<'sourcing-agent'>;
}

/**
 * The readers under the bidder reader, by the shapes that the reader uses of them. The real readers of buyer-core, of vector-read and of the kit have more members, and each of them fits, except the reader of the stake
 * (see `assetUtxos`). A test replaces them: the service uses the real ones.
 */
export interface BidderSources {
  readonly fetchSuppliers: (options: { fetchImpl: typeof fetch; capability_id: string }) => Promise<readonly BidderRow[]>;
  readonly readAdvert: (ref: string, fetchImpl: typeof fetch, koiosUrl: string, identityAdvertAddress: string | null) => Promise<AdvertRead>;
  readonly safeFetch: (url: string, init: RequestInit, options: { maxResponseBytes: number; timeoutMs: number; fetchImpl: typeof fetch }) => Promise<{ readonly status: number; readonly text: string }>;
  /**
   * The unspent outputs at Koios that hold one token, read at the Koios address `koiosUrl` of the settings (the address with no `/api/v1`). `koios.assetUtxos` of vector-read takes no such address: it reads at the variable
   * KOIOS_URL of its own, so it does not fit, and the service makes its own reader (`assetUtxosAt`).
   */
  readonly assetUtxos: (koiosUrl: string, policy: string, name: string, fetchImpl: typeof fetch) => Promise<readonly KoiosUtxo[]>;
  readonly listAttestations: (env: LedgerEnv, query: AttestationQuery) => Promise<AttestationPage>;
}

/** The two steps of the job `propose` that spend money and that take the deps that the wiring makes for them. A test replaces them to read the deps. */
export interface Runners {
  readonly quotes: typeof runQuotes;
  readonly scoring: typeof runScoring;
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
  /** Makes the Module-1 port. Default `createModule1Port`. The wiring calls it one time. */
  readonly createPort?: (deps: Module1PortDeps) => Module1Port;
  readonly sources?: Partial<BidderSources>;
  readonly runners?: Partial<Runners>;
  /** The slot of the tip of the node, for the janitor. Default `tipSlotOf` at the address of VECTOR_OGMIOS_URL. */
  readonly tipSlot?: () => Promise<number>;
}

/**
 * A delegation key of the service, as the job `propose` holds it: the paying key (its chain, its store and its lane) and the key material (its signer, its address and its key object). The job finds it by the key
 * hash of the delegate key of a delegation, and it gives it to the quote fan-out and to the scoring.
 */
export interface DelegationKeyEntry {
  readonly paying: PayingKey;
  readonly material: KeyMaterial;
}

/** The wired service: what `startService` and the server use. */
export interface Wired {
  /** The start time of the chain in POSIX milliseconds, as the node gave it at the start. */
  readonly systemStartMs: number;
  readonly provider: Module1Provider;
  readonly ledger: LedgerEnv;
  readonly gateway: GatewayClient;
  /** The service key: model hires, claims and challenges. */
  readonly service: PayingKey;
  /** The two delegation keys, in the order of the settings. */
  readonly delegations: readonly PayingKey[];
  readonly dispute: Dispute;
  readonly leftStore: FileLeftStore;
  /** The ids of the sub-delegations that a run of this process still uses. */
  readonly inFlight: ReadonlySet<string>;
  /** The deps of a `propose` job that arrived at `arrivedAt`. */
  proposeDeps(arrivedAt: number): ProposeDeps<DelegationKeyEntry>;
  /** The deps of an `execute` job that arrived at `arrivedAt`. The job makes no model hire, so these deps hold no deadline of the job. */
  executeDeps(arrivedAt: number): ExecuteDeps;
  /** The deps of the janitor of left sub-delegations. */
  janitorDeps(stopWaitMs: number): JanitorDeps;
  /** The co-sign route, over the two delegation keys and the register file of the state directory. A setting or a route that the kit refuses throws an Error with the detail. */
  cosignRoute(settings: CosignSettings): CosignRoute;
  /**
   * The janitor of the stranded escrows of each paying key and the janitor of left sub-delegations. `stop` waits at most `stopWaitMs` for each. An interval or a stop bound that a janitor refuses throws an Error, and no
   * janitor has started then.
   */
  startJanitors(intervalMs: number, stopWaitMs: number): { stop(): Promise<void> };
  /** The line that a stop logs when it abandons the job that runs: the stranded escrows of the three paying keys that the state directory holds for the janitors of the next start. */
  abandonedLine(waitMs: number): string;
}

/** The key hash that the chain of a key gives must be the key hash of the key: a chain made from another key is a fault of the wiring, and a transaction of it would be signed by the wrong key. */
function checkPaying(key: PayingKey, material: KeyMaterial, what: string): PayingKey {
  if (key.keyHash !== material.pkh) throw new Error(`the chain of the ${what} key does not belong to that key: its key hash is not the key hash of the key`);
  return key;
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
 * The unspent outputs that hold one token, from Koios at `<koiosUrl>/api/v1/asset_utxos`. The request is the one of `koios.assetUtxos` of vector-read, sent to the address of the settings. That reader takes its address from the
 * variable KOIOS_URL, which this service does not set, so the stake would come from another host than the one that the rest of the service reads. The slashes at the end of the address are cut first, as the tip reader of
 * buyer-core does: the default address of buyer-core ends with a slash, and the path would then hold two slashes before `api`. The call has the bound of one fact read, and an answer that is not a success is an error.
 */
async function assetUtxosAt(koiosUrl: string, policy: string, name: string, fetchImpl: typeof fetch): Promise<readonly KoiosUtxo[]> {
  const response = await fetchImpl(`${koiosUrl.replace(/\/+$/, '')}/api/v1/asset_utxos`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-service-agents' },
    body: JSON.stringify({ _asset_list: [[policy, name]], _extended: true }),
    signal: AbortSignal.timeout(FACT_READ_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Koios asset_utxos answered ${response.status}`);
  return (await response.json()) as KoiosUtxo[];
}

/**
 * Builds everything that the jobs, the route and the janitors use. It reaches out for three things, and each can fail the start: the Module-1 manifest (an https address, pinned to a commit: the one file that the start
 * fetches), the start time of the chain from the node, and the wallet of each of the three paying keys (the registry reads the wallet to learn the key hash). The rest is made with no call. A clash among the keys, and a
 * bound of the dispute reads that the quote hires do not assume, are refused first, before a chain is made.
 */
export async function wire(settings: WiringSettings, options: WiringOptions = {}): Promise<Wired> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? systemClock;
  const log = options.log ?? ((): void => undefined);
  const { endpoints, keys, identityDeployment } = settings;
  const now = (): number => clock.now();
  const sleep = (ms: number): Promise<void> => clock.sleep(ms);
  // A log that throws changes nothing: the line is lost, and the job goes on. Every line of the service goes through this function.
  const note = (line: string): void => {
    try {
      log(line);
    } catch {
      // The line is lost.
    }
  };
  const clash = keyClashOf(keys, settings.supplier.pkh);
  if (clash !== null) {
    throw new Error(clash.kind === 'equal'
      ? `the keys ${clash.first} and ${clash.second} of the service are one key: each key must be a key of its own`
      : `the key ${clash.role} of the service is the supplier key: each key must be a key of its own`);
  }
  // The time that a quote hire keeps for a challenge assumes that one read of the dispute code ends within the read budget of the buyer code. A longer bound would make that time too short.
  if (settings.dispute.read_timeout_ms > READ_BUDGET_MS) {
    throw new Error(`DISPUTE_READ_TIMEOUT_MS is above ${READ_BUDGET_MS} ms: the time that a quote hire keeps for a challenge assumes reads of at most that time, so the service does not start with it`);
  }

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
  // The start time of the chain comes before any chain is made: a node that gives none stops the start with nothing built.
  const systemStartMs = await systemStartOf(provider);

  // The three paying keys. A chain is made from the key and the identity deployment that pays from a vault. The registry reads the wallet of each chain for its key hash.
  const chainOf = (role: KeyRole): Promise<VaultChain> => keys[role].withKey((privateKeyHex) => (options.createChain ?? createRealChain)({
    privateKeyHex, koiosUrl: endpoints.koiosUrl, ogmiosUrl: endpoints.ogmiosUrl, submitUrl: endpoints.submitUrl, fetchImpl, identityDeployment,
    ...(endpoints.indexerUrl === undefined ? {} : { indexerUrl: endpoints.indexerUrl }),
  }));
  const registry = new PayingKeys(settings.stateDir);
  const service = checkPaying(await registry.add(await chainOf('service')), keys.service, 'service');
  const delegation1 = checkPaying(await registry.add(await chainOf('delegation1')), keys.delegation1, 'first delegation');
  const delegation2 = checkPaying(await registry.add(await chainOf('delegation2')), keys.delegation2, 'second delegation');
  const delegations: readonly PayingKey[] = [delegation1, delegation2];
  const delegationKeys: readonly KeyMaterial[] = [keys.delegation1, keys.delegation2];
  const entries: readonly DelegationKeyEntry[] = [{ paying: delegation1, material: keys.delegation1 }, { paying: delegation2, material: keys.delegation2 }];
  const entryOf = (keyHash: string): DelegationKeyEntry | null => entries.find((entry) => entry.material.pkh === keyHash) ?? null;
  // The key hashes of every other key of the agent: the service key, the six keys of the scorers and the supplier key. The co-sign route refuses a Delegate that spends an output of one of them. The list is every key that is
  // not a delegation key, so a key that the service holds later is in it without a change here.
  const otherKeyHashes: readonly string[] = [...KEY_ROLES.map((role) => keys[role]).filter((material) => !delegationKeys.includes(material)).map((material) => material.pkh), settings.supplier.pkh];

  const gateway = createGatewayClient({ baseUrl: endpoints.gatewayUrl, fetch: fetchImpl, now });
  // One verifier for every credential that the readers check: it keeps the key set and the status list that it read. Its options are those of the verifier of the mock service that this reader needs. The depth of
  // the act chain and the store of the proofs belong to the check of an access token, and the bundle belongs to an SVID, so the check of a credential uses none of them.
  const verifier = createVerifier({ baseUrl: endpoints.gatewayUrl, fetch: fetchImpl, now });
  const reads = ledgerReadsFrom(ledger);
  const delegationChain = delegationChainOf({ ...ledger, provider });
  const port = (options.createPort ?? createModule1Port)({
    provider, module1, address: keys.service.address, agent_id: agentIdOf(settings.agentDid), sign: (unsignedCborHex) => keys.service.signUnsigned(unsignedCborHex), clock: now, sleep,
    koios_url: endpoints.koiosUrl, fetch: fetchImpl, identity_deployment: identityDeployment,
  });
  const journal = new FileJournal(join(settings.stateDir, STATE_FILES.dispute));
  const dispute = new Dispute({ port, queue: service.lane, clock: now, sleep, settings: settings.dispute, journal, log: note });
  const leftStore = new FileLeftStore(join(settings.stateDir, STATE_FILES.left));

  const ids = new Set<string>();
  const inFlight = { add: (id: DelegationId): void => { ids.add(id); }, delete: (id: DelegationId): void => { ids.delete(id); } };

  /** The leaf of a delegation names the key that it gives the delegation to: its key hash, or null when the ledger shows no such delegation. */
  const delegateKeyOf = async (id: DelegationId): Promise<string | null> => {
    const leaf = (await readDelegation(ledger, id)).chain[0];
    return leaf === undefined ? null : leaf.delegation.delegateKey;
  };

  /** What the ledger of the hires books. It logs the fee and the hash, and nothing else. */
  const hireLedger: HireLedger = {
    posted: ({ lockLovelace, feeLovelace }) => { note(`booked a Post: lock ${lockLovelace} lovelace, fee ${feeLovelace} lovelace`); },
    accepted: ({ feeLovelace, txHash }) => { note(`booked an Accept: fee ${feeLovelace} lovelace, transaction ${txHash}`); },
  };
  const indexer = endpoints.indexerUrl === undefined ? {} : { indexerUrl: endpoints.indexerUrl };
  const decisionDeps = (deadlineMs: number): DecisionDeps => ({ key: service, limits: settings.modelLimits, clock: now, sleep, deadlineMs, fetchImpl, ledger: hireLedger, log: note, ...indexer });

  const sources: BidderSources = { fetchSuppliers, readAdvert, safeFetch, assetUtxos: assetUtxosAt, listAttestations, ...options.sources };
  // The ports of the bidder reader. Each fact reader gets the clock for its bounds of time, and no reader reads another source than the one that its port names.
  const biddersDeps: BiddersDeps = {
    // `fetchSuppliers` of buyer-core takes no address of an indexer: it reads the one that VECTOR_MARKETPLACE_INDEXER_URL gave it when it loaded, and the configured one when that is not set.
    listAdverts: (capabilityId) => sources.fetchSuppliers({ fetchImpl, capability_id: capabilityId }),
    // `readAdvert` gets the advert address of the identity deployment: without it every advert of a Bid Desk reads as an error.
    readAdvert: (ref) => sources.readAdvert(ref, fetchImpl, endpoints.koiosUrl, identityDeployment.advert.address),
    // The text of a file becomes bytes here, because the reader checks the hash of the bytes before it parses them, and a text that is not valid UTF-8 changes its hash and is refused by the reader.
    fetchBytes: async (url, limits) => {
      const got = await sources.safeFetch(url, {}, { maxResponseBytes: limits.maxBytes, timeoutMs: limits.timeoutMs, fetchImpl });
      return { status: got.status, bytes: Buffer.from(got.text) };
    },
    resolve: async (did) => {
      const answer = await gateway.resolve(did);
      if (!answer.ok) throw new Error('the gateway gave no DID resolution');
      return answer.value;
    },
    // A catalog that cannot be read is null, and never an empty catalog: a bidder is then neither in the catalog nor out of it.
    catalog: async () => {
      try {
        const got = await sources.safeFetch(`${endpoints.gatewayUrl}/.well-known/ard.json`, {}, { maxResponseBytes: CATALOG_MAX_BYTES, timeoutMs: CATALOG_TIMEOUT_MS, fetchImpl });
        const catalog = got.status === 200 ? parseArdCatalog(Buffer.from(got.text)) : null;
        return catalog !== null && catalog.ok ? catalog.value : null;
      } catch {
        return null;
      }
    },
    // The reader of the stake takes the id of the agent, which is the 64 hex characters of its DID. It reads at the Koios address of the settings.
    stake: (agentId) => readStake({ assetUtxos: (policy, name) => sources.assetUtxos(endpoints.koiosUrl, policy, name, fetchImpl), clock }, agentId),
    cases: (did) => casesAgainst({ claims: () => port.readClaims(), challenges: () => port.readChallenges(), clock }, did),
    compliance: (did, nowMs) => readCompliance({ list: (query) => sources.listAttestations(ledger, query), issuerPkh: settings.complianceIssuerPkh, clock }, did, nowMs),
    credential: (did) => readCredential({ fetchCredential: (agent) => gateway.credential(agent), verify: (jwt, policy) => verifier.credential(jwt, policy), clock }, did),
    clock: now,
  };

  /** The read of the bidders for a job that arrived at `arrivedAt`: the whole read gets the time that the job has left, and at most the budget of the reader. */
  const discover = (arrivedAt: number): Promise<DiscoverResult> => {
    const left = arrivedAt + PROPOSE_DEADLINE_MS - now();
    if (!(left > 0)) return Promise.resolve(refused('bidders_unavailable', 'the job has no time left for the read of the bidders'));
    return readBidders(biddersDeps, { budgetMs: Math.min(left, BIDDER_READ_BUDGET_MS) });
  };

  /** The status of a bidder that the gateway gives now, as the word that the quote fan-out reads. A gateway that gives no answer is `unreadable`. */
  const statusOf = async (did: Did): Promise<BidderStatus> => {
    const answer = await gateway.resolve(did);
    if (!answer.ok) return 'unreadable';
    return answer.value.kind === 'not_found' ? 'not_found' : answer.value.effectiveStatus;
  };

  // The four decisions. Each one hires a model from the service key, with the deadline of its job, and gives its answer as the code of the failure or as the decision with a choice that is built from the choice that
  // the decision records, member by member and list by list. The model gave that choice, and no other object is read for it.
  const shortlistOf = (arrivedAt: number): ProposeDeps<DelegationKeyEntry>['shortlist'] => async (rfq, files) => {
    const decided = await decide(decisionDeps(arrivedAt + PROPOSE_DEADLINE_MS), SHORTLIST_DECISION, shortlistInput(rfq, files));
    if (!decided.ok) return { ok: false, code: decided.reason };
    const { invite, not_invited: notInvited } = decided.value.choice;
    return { ok: true, decision: decided.value, choice: { invite: [...invite], not_invited: notInvited.map(({ did, reason }) => ({ did, reason })) } };
  };
  const rankOf = (arrivedAt: number): ProposeDeps<DelegationKeyEntry>['rank'] => async (input) => {
    const decided = await decide(decisionDeps(arrivedAt + PROPOSE_DEADLINE_MS), RANKING_DECISION, rankingInput(input.weights, input.scored));
    if (!decided.ok) return { ok: false, code: decided.reason };
    const { order, tie_break: tieBreak } = decided.value.choice;
    return { ok: true, decision: decided.value, choice: { order: [...order], tie_break: tieBreak } };
  };
  const acceptQuoteOf = (arrivedAt: number): QuotesDeps['acceptQuote'] => async ({ rfq, quote, list }) => {
    const decided = await decide(decisionDeps(arrivedAt + PROPOSE_DEADLINE_MS), ACCEPT_QUOTE_DECISION, acceptQuoteInput(rfq, quote, list));
    if (!decided.ok) return { ok: false, code: decided.reason };
    const { accept, mismatch } = decided.value.choice;
    return { ok: true, decision: decided.value, choice: { accept, mismatch: [...mismatch] } };
  };
  // The scorers run inside the time that the job keeps for them, and the ranking keeps the rest. So the decision `score` has the deadline of the scoring, which the job gives, and not the deadline of the job.
  const scoreOf = (deadlineMs: number): ScoringDeps['score'] => async (request) => {
    const decided = await decide(decisionDeps(deadlineMs), SCORE_DECISION, scoreInput(request));
    if (!decided.ok) return { ok: false, code: decided.reason };
    const { components, score } = decided.value.choice;
    return {
      ok: true,
      decision: decided.value,
      choice: { components: { price: components.price, lead_time: components.lead_time, reliability: components.reliability, compliance: components.compliance }, score },
    };
  };

  const runners = { quotes: options.runners?.quotes ?? runQuotes, scoring: options.runners?.scoring ?? runScoring };
  const calls = { fetch: fetchImpl, clock, bases: settings.mock };
  const tokens = { client: gateway };
  // The scorers are the three subagents. Each signs a sub-delegation and a token with keys of its own, and owns no wallet and no queue.
  const scorers: readonly [Scorer, Scorer, Scorer] = [
    { did: settings.scorerDids[0], authenticationKey: keys.scorer1Authentication.keyObject, delegationKey: keys.scorer1Delegation.keyObject, signer: keys.scorer1Delegation.signer },
    { did: settings.scorerDids[1], authenticationKey: keys.scorer2Authentication.keyObject, delegationKey: keys.scorer2Delegation.keyObject, signer: keys.scorer2Delegation.signer },
    { did: settings.scorerDids[2], authenticationKey: keys.scorer3Authentication.keyObject, delegationKey: keys.scorer3Delegation.keyObject, signer: keys.scorer3Delegation.signer },
  ];

  // The fan-out and the scoring get the signal of the caller as their third argument. Each reads it before each commitment of its own, and a function with two parameters here would let them go on paying after a hang-up.
  const quotesOf = (arrivedAt: number): ProposeDeps<DelegationKeyEntry>['quotes'] => (input, key, signal) => {
    const deps: QuotesDeps = {
      key: key.paying,
      hire: { clock: now, sleep, fetchImpl, ledger: hireLedger, log: note, ...indexer },
      reads,
      limits: settings.quoteLimits,
      recheck: statusOf,
      acceptQuote: acceptQuoteOf(arrivedAt),
      dispute,
      buyerPkhs: delegationKeys.map((material) => material.pkh),
      clock: now,
      log: note,
    };
    return runners.quotes(deps, input, signal);
  };
  const scoringOf: ProposeDeps<DelegationKeyEntry>['scoring'] = (input, key, signal) => {
    const deps: ScoringDeps = {
      scorers,
      agentKey: { signer: key.material.signer, walletAddress: key.material.address, queue: key.paying.lane },
      subDelegation: { chain: delegationChain, clock, delegationScript: identityDeployment.delegation, bases: settings.mock },
      tokens,
      calls,
      clock,
      leftSink: leftStore,
      inFlight,
      score: scoreOf(input.deadline_ms),
      fault: settings.fault,
      deadline_ms: input.deadline_ms,
      log: note,
    };
    const { tenant, delegation, today, weights, rfq, subjects } = input;
    return runners.scoring(deps, { tenant, delegation, today, weights, rfq, subjects }, signal);
  };

  // The job `execute` pays nothing, so its delegation key has no paying key: it is the key of the proof of the token. The entries are made once, so every job gets the same objects.
  const executeEntries = entries.map((entry): { readonly pkh: string; readonly deps: DelegationKeyDeps } => ({ pkh: entry.material.pkh, deps: { dpopKey: entry.material.keyObject } }));
  const executeKeys = { find: (keyHash: string): DelegationKeyDeps | null => executeEntries.find((entry) => entry.pkh === keyHash)?.deps ?? null, first: executeEntries[0].deps };

  let tip: (() => Promise<number>) | undefined;
  // The reader of the tip is made at its first use: it takes an https address only, and a janitor with nothing to look at never asks the node.
  const tipSlot = options.tipSlot ?? (async (): Promise<number> => {
    tip ??= tipSlotOf({ fetch: fetchImpl, ogmiosUrl: endpoints.ogmiosUrl, timeoutMs: TIP_TIMEOUT_MS });
    return tip();
  });
  const janitorDeps = (stopWaitMs: number): JanitorDeps => ({
    store: leftStore, chain: delegationChain, delegationScript: identityDeployment.delegation,
    signerOf: (keyHash) => entryOf(keyHash)?.material.signer ?? null,
    queueOf: (keyHash) => {
      const entry = entryOf(keyHash);
      if (entry === null) throw new Error('the janitor asked for the queue of a key that the service does not hold');
      return entry.paying.lane;
    },
    tipSlot, clock, log: note, inFlight: (id) => ids.has(id), stopWaitMs,
  });

  return {
    systemStartMs, provider, ledger, gateway, service, delegations, dispute, leftStore, inFlight: ids,
    proposeDeps: (arrivedAt) => ({
      agent: { did: settings.agentDid },
      reads,
      delegateKeyOf,
      delegationKeys: { find: entryOf },
      discover: () => discover(arrivedAt),
      shortlist: shortlistOf(arrivedAt),
      quotes: quotesOf(arrivedAt),
      scoring: scoringOf,
      rank: rankOf(arrivedAt),
      clock: now,
      log: note,
    }),
    executeDeps: () => ({
      reads,
      delegateKeyOf,
      delegationKeys: executeKeys,
      // The service key is the authentication key of the agent: it signs the subject token of a token request.
      agent: { did: settings.agentDid, authenticationKey: keys.service.keyObject },
      tokens,
      calls,
      clock: now,
      log: note,
    }),
    janitorDeps,
    cosignRoute: (cosign) => {
      const made = createCosignRoute({
        agentDid: settings.agentDid,
        deployment: identityDeployment,
        delegationKeys: delegationKeys.map((material) => ({ publicKey: material.publicKeyHex, sign: (bodyHash: Uint8Array) => material.signBodyHash(bodyHash) })),
        otherKeyHashes,
        settings: cosign,
        ledger: providerLedger(provider, identityDeployment),
        register: new FileKeyRegister(join(settings.stateDir, STATE_FILES.register)),
        systemStartMs,
        now,
        log: note,
      });
      if (!made.ok) throw new Error(`the co-sign route is refused: ${made.detail}`);
      return made.value;
    },
    startJanitors: (intervalMs, stopWaitMs) => {
      // The janitor of the left sub-delegations starts first. It refuses an interval that no janitor takes, and then no janitor of the stranded escrows has started.
      const left = startJanitor(janitorDeps(stopWaitMs), intervalMs);
      const stranded = registry.startJanitors(intervalMs, { clock: now, log: note });
      return { stop: async () => { await Promise.all([stopJanitorWithin(stranded, stopWaitMs, note), left.stop()]); } };
    },
    abandonedLine: (waitMs) => {
      const refs = registry.list().flatMap((key) => key.stranded.list().map((entry) => entry.escrow_ref));
      return `stopping: the job that is running did not finish within ${waitMs} ms and is abandoned; the state directory holds ${refs.length} ${refs.length === 1 ? 'escrow' : 'escrows'} `
        + `for the janitors of the next start${refs.length === 0 ? '' : `: ${refs.join(', ')}`}`;
    },
  };
}
