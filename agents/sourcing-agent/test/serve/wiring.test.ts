// agents/sourcing-agent/test/serve/wiring.test.ts
// The wiring joins the folders of the agent to the real parts. The tests run it over the stub marketplace of the hire kit (a FakeChain, an indexer and a model supplier behind one fetch), the stub gateway of the
// id-kit, the offline node of the fixture world, the key hashes of the fixture world and a scripted Module-1 port. They show what the wiring decides and nothing of what the jobs decide: one queue for each key, one
// set of delegation ids, one Module-1 port, one verifier, one list of left sub-delegations, the deadline of a decision from the job that asks it, the signal of the caller in both paid steps, a key kept out of every
// log line, and the readers of the bidder file joined to their sources. The readers of the bidders run for real over fake sources.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { READ_BUDGET_MS } from '@vsa/buyer-core';
import type { AttestationQuery, VaultChain } from '@vsa/buyer-core';
import { ALLOWLIST, INDEXER, LLM_ADVERT, T0, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubGateway } from '@vsa/id-kit/testing';
import type { Clock } from '@vsa/usecase-kit/access';
import { BID_CAPABILITIES, SOURCING_CLAIM } from '@vsa/usecase-kit/bids';
import type { ModelLimits } from '@vsa/usecase-kit/decision';
import type { Module1PortDeps, Module1Provider } from '@vsa/usecase-kit/dispute';
import { agentIdOf, isPlainObject } from '@vsa/usecase-kit/protocol';
import type { Decision } from '@vsa/usecase-kit/protocol';
import { KOIOS_URL, REPUTATION_SCRIPT_HASH, stakeTokenName } from '@vsa/vector-read';
import type { KoiosUtxo } from '@vsa/vector-read';
import { DELEG_A, DEPLOYMENT, liveDelegation, world } from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { ScriptedPort } from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { addDesk, deskOf, emptyWorld } from '../bidders/support.ts';
import type { Desk, World } from '../bidders/support.ts';
import { DAY, datum, id, page, settle, view } from '../compliance/support.ts';
import { challengeView, claimView, datumOf, stakeRow, tokenOf } from '../facts/support.ts';
import { said } from '../model/decide-support.ts';
import { LIST, QUOTE, RFQ, WEIGHTS, files as bidderFiles, golden, scored as scoredBidders } from '../model/support.ts';
import { TODAY, fileOf, inputOf, quoteOf } from '../scoring/support.ts';
import { BIDDER_FETCH_TIMEOUT_MS, BIDDER_FILE_MAX_BYTES } from '../../src/bidders/index.ts';
import { PROPOSE_DEADLINE_MS, RANKING_RESERVE_MS, SCORING_RESERVE_MS } from '../../src/propose/index.ts';
import type { QuotesInput, ScoringInput } from '../../src/propose/index.ts';
import type { QuotesDeps } from '../../src/quotes/index.ts';
import { SCORERS_NEED_MS } from '../../src/scoring/index.ts';
import type { ScoringDeps, VendorEntry } from '../../src/scoring/index.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import { GATEWAY_DEFAULT } from '../../src/serve/settings.ts';
import { CATALOG_MAX_BYTES, CATALOG_TIMEOUT_MS, STATE_FILES, wire } from '../../src/serve/wiring.ts';
import type { BidderSources, DelegationKeyEntry, Runners, Wired, WiringOptions, WiringSettings } from '../../src/serve/wiring.ts';
import { AGENT_DID, ISSUER, KEY_NUMBERS, KEY_VARIABLES, MODULE1_URL, cleanDirs, completeEnv, rawKey, secretsOf, tempDir, withModule1, wiringSettingsOf } from './support.ts';

afterEach(cleanDirs);

/** The limits that fit the model advert of the stub marketplace exactly, as the decisions of the kit tests do. */
const LIMITS: ModelLimits = {
  allowlist: ALLOWLIST, maxPriceLovelace: LLM_ADVERT.price_lovelace, maxSupplierBondLovelace: LLM_ADVERT.supplier_bond_lovelace, maxBuyerBondLovelace: LLM_ADVERT.buyer_bond_lovelace,
};
const DELEGATION = 'dd'.repeat(32);
const BIDDER = `did:vector:${'a1'.repeat(32)}`;
const BIDDER_ADVERT = `${'11'.repeat(32)}#0`;
/** The address of the catalog of the gateway: the stub gateway has the origin of the live gateway, and so have the settings. */
const CATALOG_URL = `${GATEWAY_DEFAULT}/.well-known/ard.json`;
/** The choices that the model gives in the tests: the golden choices of the model folder. */
const SHORTLIST = golden('shortlist-choice.json');
const RANKING = golden('ranking-choice.json');
const ACCEPT = golden('accept-quote-choice.json');
const SCORE = golden('score-choice.json');
// The golden file of the model folder is the entry of the vendor master that the folder of the scoring reads.
const VENDOR = golden('vendor.json') as unknown as VendorEntry;
/** A request for the fan-out that invites nobody: the runner of a test never reads it. */
const QUOTES_INPUT: QuotesInput = { rfq: RFQ, sender: AGENT_DID, delegation: DELEGATION, invited: [], deadline_ms: T0 + PROPOSE_DEADLINE_MS, keep_ms: SCORING_RESERVE_MS };
/** A request for the scoring: the golden run of the scoring folder with the deadline that the job gives. */
const SCORING_INPUT: ScoringInput = { ...inputOf(DELEGATION), deadline_ms: T0 + PROPOSE_DEADLINE_MS - RANKING_RESERVE_MS };
const SCORE_REQUEST = { today: TODAY, weights: WEIGHTS, rfq: RFQ, quote: quoteOf(BIDDER, 'alfa.example.org'), file: fileOf(BIDDER, 'alfa.example.org'), vendor: VENDOR };
/** The claim that the dispute code stakes for the agent: its capability, its three statements, a stake and a challenge window. */
const CLAIM = {
  capability_id: BID_CAPABILITIES.evaluate, manifest_sha256: 'ab'.repeat(32), claim: SOURCING_CLAIM, stake_lovelace: 5_000_000n, challenge_window_ms: 3_600_000, claim_type: 'supplychain.bid.evaluate.v1',
};

/** A promise that the test settles by hand. (The library of the compiler of the repository has no `Promise.withResolvers`, so this uses the executor form.) */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

/** A clock that the sleep of a hire moves, over the clock of the stub marketplace. A wait with a signal is the bound that a reader puts on a call: it ends when the reader ends it, and never by itself. */
const clockOf = (m: Marketplace): Clock => ({
  now: () => m.clock.now,
  sleep: async (ms, signal) => {
    if (signal === undefined) {
      m.clock.now += ms;
      return;
    }
    const open = deferred();
    if (signal.aborted) open.resolve();
    else signal.addEventListener('abort', open.resolve, { once: true });
    await open.promise;
  },
});

/** The fetch of the wiring: the stub gateway answers its own origin, the fixture serves the Module-1 manifest, and the stub marketplace answers every other call. */
const routed = (m: Marketplace, gateway: StubGateway): typeof fetch => withModule1(async (input: RequestInfo | URL, init?: RequestInit) => (
  String(input).startsWith(gateway.baseUrl) ? gateway.fetch(input, init) : m.fetchImpl(input, init)
));

interface Seen {
  readonly quotes: { readonly deps: QuotesDeps; readonly input: QuotesInput; readonly signal: AbortSignal | undefined }[];
  readonly scoring: { readonly deps: ScoringDeps; readonly input: Parameters<Runners['scoring']>[1]; readonly signal: AbortSignal | undefined }[];
}

/** Runners that record the deps, the input and the signal that they get, and spend nothing. */
function spy(): { readonly seen: Seen; readonly runners: Runners } {
  const seen: Seen = { quotes: [], scoring: [] };
  const runners: Runners = {
    quotes: async (deps, input, signal) => {
      seen.quotes.push({ deps, input, signal });
      return { outcomes: [], stopped: null };
    },
    scoring: async (deps, input, signal) => {
      seen.scoring.push({ deps, input, signal });
      return { ok: true, scores: [] };
    },
  };
  return { seen, runners };
}

interface Setup {
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly dir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly settings: WiringSettings;
  readonly wired: Wired;
  readonly log: string[];
  /** What the runners of a spied setup got. */
  readonly seen: Seen;
  /** Every call that a chain of the service made, with the hash of the key of that chain. The reads of the wallet at the start are in it. */
  readonly used: { readonly pkh: string; readonly method: string }[];
}

interface Over {
  readonly env?: NodeJS.ProcessEnv;
  readonly settings?: Partial<WiringSettings>;
  readonly options?: Partial<WiringOptions>;
  readonly provider?: Module1Provider;
  readonly fetch?: (next: typeof fetch) => typeof fetch;
  readonly gateway?: StubGateway;
  /** Replaces both paid steps by runners that record what they get. */
  readonly spy?: boolean;
  /** Gets the key hash of each chain that the wiring makes, in order. It is the record of a start that fails. */
  readonly chains?: string[];
}

/** The chain of each key is the FakeChain of the stub marketplace, with the wallet of the key. A chain is made once for each key, and the test reads which key made each call. */
async function setup(over: Over = {}): Promise<Setup> {
  const m = marketplace();
  const gateway = over.gateway ?? createStubGateway({ now: () => m.clock.now });
  const dir = tempDir();
  const env = completeEnv({ SOURCING_STATE_DIR: dir, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER, ...over.env });
  const settings: WiringSettings = { ...wiringSettingsOf(env), modelLimits: LIMITS, ...over.settings };
  const log: string[] = [];
  const chains = over.chains ?? [];
  const used: { pkh: string; method: string }[] = [];
  const spied = over.spy === true ? spy() : null;
  const wired = await wire(settings, {
    fetchImpl: over.fetch === undefined ? routed(m, gateway) : over.fetch(routed(m, gateway)),
    clock: clockOf(m),
    log: (line) => { log.push(line); },
    provider: over.provider ?? world([liveDelegation(DELEG_A.keyHash)]),
    tipSlot: async () => 0,
    createChain: async (options) => {
      const pkh = keyOf(options.privateKeyHex).pkh;
      chains.push(pkh);
      const chain = vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: pkh }) });
      // The chain that the service gets has each member of the chain, and each function records its call with the key hash of its key, so a test reads which key paid.
      const recording: VaultChain = Object.fromEntries(Object.entries(chain).map(([method, member]) => [method, typeof member === 'function' ? (...args: unknown[]) => { used.push({ pkh, method }); return member.apply(chain, args); } : member])) as unknown as VaultChain;
      return recording;
    },
    ...(spied === null ? {} : { runners: spied.runners }),
    ...over.options,
  });
  return { m, gateway, dir, env, settings, wired, log, seen: spied?.seen ?? { quotes: [], scoring: [] }, used };
}

/** The entry of the delegation key `at` as the job finds it, by the key hash of the delegate key of a delegation. */
function entryOf(wired: Wired, at: 0 | 1): DelegationKeyEntry {
  const found = wired.proposeDeps(T0).delegationKeys.find(wired.delegations[at]!.keyHash);
  if (found === null) throw new Error('the wiring holds no entry for the delegation key');
  return found;
}

/** The prompts that the model supplier received, in order. A hire sends `{ input }` and nothing else. */
function promptsOf(m: Marketplace): string[] {
  return m.llm.sends.map((send) => {
    const body: unknown = JSON.parse(send.body);
    if (!isPlainObject(body) || typeof body.input !== 'string') throw new Error('the model supplier received a body that is not { input }');
    return body.input;
  });
}

/** The error that the start of a wiring ends with. The test fails when the start works. */
async function startError(work: Promise<unknown>): Promise<Error> {
  const error = await work.then(() => null, (thrown: unknown) => thrown);
  if (!(error instanceof Error)) throw new Error('the start did not end with an Error');
  return error;
}

describe('one queue for each key, one set of ids, one port and one list for the process', () => {
  test('the lane of each delegation key is the queue of its quote hires, of its sub-delegations and of the janitor, and every other key has none', async () => {
    const { wired, settings, seen } = await setup({ spy: true });
    const [first, second] = wired.delegations;
    expect(first!.keyHash).toBe(settings.keys.delegation1.pkh);
    expect(second!.keyHash).toBe(settings.keys.delegation2.pkh);
    expect(wired.service.keyHash).toBe(settings.keys.service.pkh);
    const propose = wired.proposeDeps(T0);
    const janitor = wired.janitorDeps(100);
    for (const [at, material] of [[0, settings.keys.delegation1], [1, settings.keys.delegation2]] as const) {
      const paying = wired.delegations[at]!;
      const entry = entryOf(wired, at);
      expect(entry.paying).toBe(paying);
      expect(entry.material).toBe(material);
      await propose.quotes(QUOTES_INPUT, entry);
      await propose.scoring(SCORING_INPUT, entry);
      const hired = seen.quotes.at(-1)!.deps;
      const scored = seen.scoring.at(-1)!.deps;
      expect(hired.key).toBe(paying);
      expect(hired.key.lane).toBe(paying.lane);
      expect(scored.agentKey.queue).toBe(paying.lane);
      expect(scored.agentKey.signer).toBe(material.signer);
      expect(scored.agentKey.signer.keyHash).toBe(material.pkh);
      expect(scored.agentKey.walletAddress).toBe(material.address);
      expect(janitor.queueOf(paying.keyHash)).toBe(paying.lane);
      expect(janitor.signerOf(paying.keyHash)).toBe(material.signer);
    }
    expect(first!.lane).not.toBe(second!.lane);
    expect(first!.lane).not.toBe(wired.service.lane);
    expect(second!.lane).not.toBe(wired.service.lane);
    // The same entry for the same key, in every job.
    expect(wired.proposeDeps(T0 + 1).delegationKeys.find(first!.keyHash)).toBe(entryOf(wired, 0));
    // The service key and the six keys of the scorers have no queue and sign no Delegate of the agent. The janitor ends no delegation with them, and the job finds no delegation key in them.
    const others = [wired.service.keyHash, ...KEY_ROLES.filter((role) => role.startsWith('scorer')).map((role) => settings.keys[role].pkh), 'ee'.repeat(28)];
    expect(others).toHaveLength(8);
    for (const pkh of others) {
      expect(propose.delegationKeys.find(pkh)).toBeNull();
      expect(wired.executeDeps(T0).delegationKeys.find(pkh)).toBeNull();
      expect(janitor.signerOf(pkh)).toBeNull();
      expect(() => janitor.queueOf(pkh)).toThrow(/does not hold/);
    }
  });

  test('the dispute code gets the one Module-1 port that the start made from the settings, and it runs in the lane of the service key', async () => {
    const events: string[] = [];
    const made: Module1PortDeps[] = [];
    const run = await setup({ options: { createPort: (deps) => { made.push(deps); return new ScriptedPort(events); } } });
    // One port for the process, made from the settings of the service and from the manifest that the start fetched.
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ address: run.settings.keys.service.address, agent_id: agentIdOf(run.settings.agentDid), koios_url: run.settings.endpoints.koiosUrl });
    expect(made[0]!.identity_deployment).toBe(run.settings.identityDeployment);
    expect(made[0]!.module1.identityHash).toBe(run.settings.identityDeployment.identity.hash);
    // The lane of the service key is held. The dispute code needs the key, so it waits. The call is a chain of promises with no timer, so one turn of the event loop runs all of it that can run.
    const held = deferred();
    const holding = run.wired.service.lane.run(() => held.promise);
    const staking = run.wired.dispute.stakeRunClaim(CLAIM);
    await settle();
    expect(events).toStrictEqual([]);
    held.resolve();
    await holding;
    expect((await staking).ok).toBe(true);
    expect(events).toStrictEqual(['publish claim', 'submitClaim']);
  });

  test('the sub-delegations of every job and the janitor share one set of delegation ids, and the set is the one that the wiring exposes', async () => {
    const { wired, seen } = await setup({ spy: true });
    const key = entryOf(wired, 0);
    await wired.proposeDeps(T0).scoring(SCORING_INPUT, key);
    await wired.proposeDeps(T0 + 1).scoring(SCORING_INPUT, key);
    const [first, second] = seen.scoring.map((call) => call.deps.inFlight);
    const taken = 'dd'.repeat(32);
    const janitor = wired.janitorDeps(100);
    expect(janitor.inFlight(taken)).toBe(false);
    first!.add(taken);
    expect(janitor.inFlight(taken)).toBe(true);
    expect(wired.inFlight.has(taken)).toBe(true);
    // Another job gets the same set: an id that one run added is seen by the next one, and the janitor sees what the next one does.
    second!.delete(taken);
    expect(janitor.inFlight(taken)).toBe(false);
    expect(wired.inFlight.has(taken)).toBe(false);
  });

  test('the list of left sub-delegations is one object: every scoring and the janitor get the same one', async () => {
    const { wired, seen } = await setup({ spy: true });
    const key = entryOf(wired, 1);
    await wired.proposeDeps(T0).scoring(SCORING_INPUT, key);
    await wired.proposeDeps(T0 + 9).scoring(SCORING_INPUT, key);
    expect(seen.scoring[0]!.deps.leftSink).toBe(wired.leftStore);
    expect(seen.scoring[1]!.deps.leftSink).toBe(wired.leftStore);
    expect(wired.janitorDeps(100).store).toBe(wired.leftStore);
    expect(await wired.leftStore.list()).toStrictEqual([]);
  });

  test('the state directory holds the stranded store of each of the three paying keys and the journal of the dispute code, and none for a key of a scorer', async () => {
    const { dir, settings, wired } = await setup();
    expect(readdirSync(join(dir, 'keys')).sort()).toStrictEqual([settings.keys.service.pkh, settings.keys.delegation1.pkh, settings.keys.delegation2.pkh].sort());
    expect(existsSync(join(dir, STATE_FILES.dispute))).toBe(true);
    expect(wired.service.dir).toBe(join(dir, 'keys', settings.keys.service.pkh));
  });
});

describe('the keys that the chains are made from', () => {
  test('each of the three paying keys gets the chain that its own key makes, with the identity deployment that pays from a vault, and no scorer key gets a chain', async () => {
    const seen: { pkh: string; identity: unknown; ogmios: string | undefined; indexer: string | undefined }[] = [];
    const run = await setup({
      options: {
        createChain: async (options) => {
          const pkh = keyOf(options.privateKeyHex).pkh;
          seen.push({ pkh, identity: options.identityDeployment, ogmios: options.ogmiosUrl, indexer: options.indexerUrl });
          const m = marketplace();
          return vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: pkh }) });
        },
      },
    });
    const { settings } = run;
    expect(seen.map((entry) => entry.pkh)).toStrictEqual([settings.keys.service.pkh, settings.keys.delegation1.pkh, settings.keys.delegation2.pkh]);
    expect(seen.every((entry) => entry.identity === settings.identityDeployment && entry.ogmios === settings.endpoints.ogmiosUrl && entry.indexer === INDEXER)).toBe(true);
    expect(run.wired.delegations).toHaveLength(2);
  });

  test.each([
    ['service', 'the chain of the service key'], ['delegation1', 'the chain of the first delegation key'], ['delegation2', 'the chain of the second delegation key'],
  ] as const)('a chain of the %s key that gives another key hash than its key stops the start, and the right chain is its twin', async (role, words) => {
    const { settings } = await setup();
    const wrong = await startError(setup({
      options: {
        createChain: async (options) => {
          const m = marketplace();
          const own = keyOf(options.privateKeyHex).pkh;
          return vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: own === settings.keys[role].pkh ? 'ee'.repeat(28) : own }) });
        },
      },
    }));
    expect(wrong.message.startsWith(`${words} does not belong to that key`)).toBe(true);
    await expect(setup()).resolves.toBeDefined();
  });

  test('a clash among the nine keys, or a key that is the supplier key, stops the start before any chain is made, and names the roles and no key', async () => {
    const reference = await setup();
    const keys = reference.settings.keys;
    const clashes: ReadonlyArray<readonly [what: string, over: Partial<WiringSettings>, named: readonly string[]]> = [
      ['the two delegation keys are one key', { keys: { ...keys, delegation2: keys.delegation1 } }, ['delegation1', 'delegation2']],
      ['a scorer key is the service key', { keys: { ...keys, scorer2Delegation: keys.service } }, ['service', 'scorer2Delegation']],
      ['two scorer keys are one key', { keys: { ...keys, scorer3Authentication: keys.scorer1Authentication } }, ['scorer1Authentication', 'scorer3Authentication']],
      ['a scorer key is the supplier key', { supplier: { ...reference.settings.supplier, pkh: keys.scorer3Delegation.pkh } }, ['scorer3Delegation', 'supplier key']],
      ['the service key is the supplier key', { supplier: { ...reference.settings.supplier, pkh: keys.service.pkh } }, ['service', 'supplier key']],
    ];
    for (const [what, settings, named] of clashes) {
      const chains: string[] = [];
      const error = await startError(setup({ settings, chains }));
      expect(chains, what).toStrictEqual([]);
      for (const word of named) expect(error.message, what).toContain(word);
      for (const secret of [...secretsOf(reference.env), ...Object.values(keys).map((key) => key.pkh)]) expect(error.message.toLowerCase(), what).not.toContain(secret.toLowerCase());
    }
    const chains: string[] = [];
    await setup({ chains });
    expect(chains).toHaveLength(3);
  });

  test('a bound of the dispute reads above the read budget of the buyer code stops the start before any chain is made, and the budget itself is its twin', async () => {
    // The time that a quote hire keeps for a challenge assumes that one read takes 30,000 ms at the most.
    expect(READ_BUDGET_MS).toBe(30_000);
    const reference = await setup();
    const chains: string[] = [];
    const error = await startError(setup({ settings: { dispute: { ...reference.settings.dispute, read_timeout_ms: READ_BUDGET_MS + 1 } }, chains }));
    expect(error.message).toContain('DISPUTE_READ_TIMEOUT_MS');
    expect(error.message).toContain(String(READ_BUDGET_MS));
    expect(chains).toStrictEqual([]);
    await expect(setup({ settings: { dispute: { ...reference.settings.dispute, read_timeout_ms: READ_BUDGET_MS } } })).resolves.toBeDefined();
  });

  test('no key leaves its object but through withKey: no log line of a start, a decision, a read or a claim holds a key, a token or a bech32 key', async () => {
    const events: string[] = [];
    const run = await setup({ spy: true, options: { createPort: () => new ScriptedPort(events) } });
    const deps = run.wired.proposeDeps(T0);
    run.m.llm.answer = said(SHORTLIST);
    await deps.shortlist(RFQ, bidderFiles());
    run.m.llm.answer = said(RANKING);
    await deps.rank({ weights: WEIGHTS, scored: scoredBidders() });
    await deps.quotes(QUOTES_INPUT, entryOf(run.wired, 0));
    run.m.llm.answer = said(ACCEPT);
    await run.seen.quotes[0]!.deps.acceptQuote({ rfq: RFQ, quote: QUOTE, list: LIST });
    await deps.scoring(SCORING_INPUT, entryOf(run.wired, 0));
    run.m.llm.answer = said(SCORE);
    await run.seen.scoring[0]!.deps.score(SCORE_REQUEST);
    await run.wired.dispute.stakeRunClaim(CLAIM);
    expect(run.log.filter((line) => line.startsWith('booked a Post'))).toHaveLength(4);
    expect(run.log.some((line) => line.startsWith('dispute: claim'))).toBe(true);
    for (const secret of secretsOf(run.env)) {
      for (const line of run.log) expect(line.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    for (const role of KEY_ROLES) expect(JSON.stringify(run.settings.keys[role]).toLowerCase()).not.toContain(rawKey(KEY_NUMBERS[role]));
    expect(KEY_ROLES.map((role) => KEY_VARIABLES[role])).toHaveLength(9);
  });

  test('a log that throws changes no result: the decision is made', async () => {
    const run = await setup({ options: { log: () => { throw new Error('the log is broken'); } } });
    run.m.llm.answer = said(SHORTLIST);
    expect((await run.wired.proposeDeps(T0).shortlist(RFQ, bidderFiles())).ok).toBe(true);
    expect(run.m.llm.sends).toHaveLength(1);
  });
});

/** The answer of a decision port, as the four of them give it: the code of a failure, or the decision with the choice. */
type Answer = { readonly ok: true; readonly decision: Decision; readonly choice: object } | { readonly ok: false; readonly code: string };

/**
 * The four decisions: one table, because each is one model hire from the service key with the deadline of its job, and each gives its answer built from the choice that the decision records. `late` asks with a deadline
 * that leaves no time to hire, and `timely` asks with one that leaves time. The decisions `accept_quote` and `score` run inside the paid steps, so the test reads them from the deps that the runners got.
 */
interface Ask {
  readonly name: string;
  readonly choice: object;
  readonly timely: (run: Setup) => Promise<Answer>;
  readonly late: (run: Setup) => Promise<Answer>;
}

const ASKS: readonly Ask[] = [
  {
    name: 'shortlist',
    choice: SHORTLIST,
    timely: (run) => run.wired.proposeDeps(T0).shortlist(RFQ, bidderFiles()),
    late: (run) => run.wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).shortlist(RFQ, bidderFiles()),
  },
  {
    name: 'ranking',
    choice: RANKING,
    timely: (run) => run.wired.proposeDeps(T0).rank({ weights: WEIGHTS, scored: scoredBidders() }),
    late: (run) => run.wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).rank({ weights: WEIGHTS, scored: scoredBidders() }),
  },
  {
    name: 'accept_quote',
    choice: ACCEPT,
    timely: async (run) => {
      await run.wired.proposeDeps(T0).quotes(QUOTES_INPUT, entryOf(run.wired, 0));
      return run.seen.quotes.at(-1)!.deps.acceptQuote({ rfq: RFQ, quote: QUOTE, list: LIST });
    },
    late: async (run) => {
      await run.wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).quotes(QUOTES_INPUT, entryOf(run.wired, 0));
      return run.seen.quotes.at(-1)!.deps.acceptQuote({ rfq: RFQ, quote: QUOTE, list: LIST });
    },
  },
  {
    // The scoring has the deadline that the job gives it in its input, which is the deadline of the job less the time of the ranking. The arrival of the job does not matter here.
    name: 'score',
    choice: SCORE,
    timely: async (run) => {
      await run.wired.proposeDeps(T0).scoring({ ...SCORING_INPUT, deadline_ms: T0 + 1_000_000 }, entryOf(run.wired, 0));
      return run.seen.scoring.at(-1)!.deps.score(SCORE_REQUEST);
    },
    late: async (run) => {
      await run.wired.proposeDeps(T0).scoring({ ...SCORING_INPUT, deadline_ms: T0 + 30_000 }, entryOf(run.wired, 0));
      return run.seen.scoring.at(-1)!.deps.score(SCORE_REQUEST);
    },
  },
];

describe.each(ASKS)('the decision $name', (ask) => {
  test('hires a model from the service key and gives the choice built from the choice that the decision records', async () => {
    const run = await setup({ spy: true });
    run.m.llm.answer = said(ask.choice, 'The data supports this choice.');
    const answer = await ask.timely(run);
    if (!answer.ok) throw new Error(`the decision failed with ${answer.code}`);
    expect(answer.choice).toStrictEqual(ask.choice);
    expect(answer.choice).toStrictEqual(answer.decision.choice);
    // The choice is a copy that the wiring built member by member, so it is no object that the decision holds, and no list of it is a list of the decision.
    expect(answer.choice).not.toBe(answer.decision.choice);
    const recorded = answer.decision.choice;
    if (!isPlainObject(recorded)) throw new Error('the decision records a choice that is no object');
    for (const [name, member] of Object.entries(answer.choice)) {
      if (typeof member === 'object' && member !== null) expect(member, name).not.toBe(recorded[name]);
    }
    expect(answer.decision).toMatchObject({ name: ask.name, reasoning: 'The data supports this choice.', inference: { path: 'marketplace' } });
    expect(run.m.llm.sends).toHaveLength(1);
    // The key that pays: the Post and the Accept of the model hire are made by the chain of the service key, and no chain of a delegation key makes a call but the read of its wallet at the start.
    const servicePkh = run.settings.keys.service.pkh;
    expect(run.used.filter((call) => call.method === 'postEscrow').map((call) => call.pkh)).toStrictEqual([servicePkh]);
    expect(run.used.filter((call) => call.method === 'accept').map((call) => call.pkh)).toStrictEqual([servicePkh]);
    expect(run.used.filter((call) => call.pkh !== servicePkh && call.method !== 'wallet')).toStrictEqual([]);
    expect(run.log.filter((line) => line.startsWith('booked a Post'))).toHaveLength(1);
    expect(run.log.filter((line) => line.startsWith('booked an Accept'))).toHaveLength(1);
  });

  test('gives the code of a failed decision and no choice, for an answer of the model that no parser takes', async () => {
    const run = await setup({ spy: true });
    run.m.llm.answer = 'this is not a decision';
    expect(await ask.timely(run)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
  });

  test('hires nothing when the deadline of its job leaves no time, and hires when the job has time', async () => {
    const run = await setup({ spy: true });
    run.m.llm.answer = said(ask.choice);
    expect(await ask.late(run)).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    expect(run.m.llm.sends).toHaveLength(0);
    expect((await ask.timely(run)).ok).toBe(true);
    expect(run.m.llm.sends).toHaveLength(1);
  });
});

describe('the prompts of the decisions', () => {
  test('carry the facts that the model folder puts in: the request and the files for the shortlist, the weights and the scores for the ranking', async () => {
    const run = await setup();
    run.m.llm.answer = said(SHORTLIST);
    await run.wired.proposeDeps(T0).shortlist(RFQ, bidderFiles());
    run.m.llm.answer = said(RANKING);
    await run.wired.proposeDeps(T0).rank({ weights: WEIGHTS, scored: scoredBidders() });
    const [shortlist, ranking] = promptsOf(run.m);
    expect(shortlist).toContain('GLV-NIT-M');
    expect(shortlist).toContain(bidderFiles()[0]!.did);
    expect(ranking).toContain('"weights"');
    expect(ranking).toContain(scoredBidders()[2]!.desk_did);
  });
});

describe('the quote fan-out', () => {
  test('gets the paying key of the delegation key, the three limits, the two buyer keys, the one dispute code and the deps of a hire with no deadline of its own', async () => {
    const run = await setup({ spy: true });
    const deps = run.wired.proposeDeps(T0);
    const entry = entryOf(run.wired, 1);
    await deps.quotes(QUOTES_INPUT, entry);
    const call = run.seen.quotes[0]!;
    const given = call.deps;
    expect(call.input).toBe(QUOTES_INPUT);
    expect(given.key).toBe(entry.paying);
    expect(given.limits).toBe(run.settings.quoteLimits);
    expect(given.limits).toStrictEqual({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(given.buyerPkhs).toStrictEqual([run.settings.keys.delegation1.pkh, run.settings.keys.delegation2.pkh]);
    expect(given.dispute).toBe(run.wired.dispute);
    expect(given.reads).toBe(deps.reads);
    // The deadline of a hire is not in the deps: the fan-out sets it from its input.
    expect(Object.keys(given.hire).sort()).toStrictEqual(['clock', 'fetchImpl', 'indexerUrl', 'ledger', 'log', 'sleep']);
    expect(given.hire.indexerUrl).toBe(INDEXER);
    expect(given.clock()).toBe(T0);
    given.log('marker of the fan-out');
    expect(run.log).toContain('marker of the fan-out');
  });

  test('gives the hire no member for an indexer that the settings do not name', async () => {
    const run = await setup({ spy: true, env: { VECTOR_MARKETPLACE_INDEXER_URL: '' } });
    await run.wired.proposeDeps(T0).quotes(QUOTES_INPUT, entryOf(run.wired, 0));
    expect(Object.keys(run.seen.quotes[0]!.deps.hire).sort()).toStrictEqual(['clock', 'fetchImpl', 'ledger', 'log', 'sleep']);
  });

  test('reads the status of a bidder again from the gateway, and each kind of resolution gives its word', async () => {
    const run = await setup({ spy: true });
    await run.wired.proposeDeps(T0).quotes(QUOTES_INPUT, entryOf(run.wired, 0));
    const recheck = run.seen.quotes[0]!.deps.recheck;
    const agents = (['active', 'suspended', 'revoked', 'retired'] as const).map((status) => {
      const agent = run.gateway.createAgent({ label: `recheck-${status}` });
      if (status !== 'active') run.gateway.setStatus(agent, status);
      return { status, agent };
    });
    // A record that is Active or Suspended resolves, and a record that ended gives its word through the answer 410.
    for (const { status, agent } of agents) expect(await recheck(agent.did), status).toBe(status);
    expect(await recheck(`did:vector:${'ef'.repeat(32)}`)).toBe('not_found');
    const down = run.gateway.createAgent({ label: 'recheck-down' });
    const busy = run.gateway.createAgent({ label: 'recheck-busy' });
    run.gateway.fault(`/1.0/identifiers/${down.did}`, 'network');
    run.gateway.fault(`/1.0/identifiers/${busy.did}`, { status: 503, body: '{"error":"temporarily_unavailable"}', headers: { 'content-type': 'application/json' } });
    expect(await recheck(down.did)).toBe('unreadable');
    expect(await recheck(busy.did)).toBe('unreadable');
  });
});

describe('the signal of the caller', () => {
  test('goes to the fan-out and to the scoring as it is', async () => {
    const run = await setup({ spy: true });
    const controller = new AbortController();
    const deps = run.wired.proposeDeps(T0);
    await deps.quotes(QUOTES_INPUT, entryOf(run.wired, 0), controller.signal);
    await deps.scoring(SCORING_INPUT, entryOf(run.wired, 0), controller.signal);
    expect(run.seen.quotes[0]!.signal).toBe(controller.signal);
    expect(run.seen.scoring[0]!.signal).toBe(controller.signal);
    await deps.quotes(QUOTES_INPUT, entryOf(run.wired, 0));
    await deps.scoring(SCORING_INPUT, entryOf(run.wired, 0));
    expect(run.seen.quotes[1]!.signal).toBeUndefined();
    expect(run.seen.scoring[1]!.signal).toBeUndefined();
  });

  test('stops the real fan-out and the real scoring after a hang-up, and the same calls with a live signal go on to their next step', async () => {
    const run = await setup();
    const deps = run.wired.proposeDeps(T0);
    const key = entryOf(run.wired, 0);
    const hungUp = new AbortController();
    hungUp.abort();
    const live = new AbortController();
    // The fan-out reads the signal before the check of the price list, so a bidder with no price list is `aborted` after a hang-up and `no_price_list` with a live signal. Nothing is paid.
    const input: QuotesInput = { ...QUOTES_INPUT, invited: [{ did: BIDDER, advert_ref: BIDDER_ADVERT, organisation: null, price_list: null }] };
    const excluded = (code: string): object => ({ kind: 'excluded', did: BIDDER, reason: 'failed', code, record: null, decision: null, challenge: null });
    expect((await deps.quotes(input, key, hungUp.signal)).outcomes).toStrictEqual([excluded('aborted')]);
    expect((await deps.quotes(input, key, live.signal)).outcomes).toStrictEqual([excluded('no_price_list')]);
    // The scoring reads the signal before the check of its time, so a job that is late is `aborted` after a hang-up and `deadline` with a live signal. Nothing is sent.
    const late: ScoringInput = { ...SCORING_INPUT, deadline_ms: T0 };
    expect(await deps.scoring(late, key, hungUp.signal)).toStrictEqual({ ok: false, code: 'aborted', decisions: [] });
    expect(await deps.scoring(late, key, live.signal)).toStrictEqual({ ok: false, code: 'deadline', decisions: [] });
    expect(run.used.filter((call) => call.method !== 'wallet')).toStrictEqual([]);
    expect(run.m.llm.sends).toHaveLength(0);
  });
});

describe('the scoring', () => {
  test('gets the three scorers with their own keys, the signer and the wallet of the delegation key, the shared sets and lists, the fault switch and the deadline of the input', async () => {
    const run = await setup({ spy: true });
    const { settings } = run;
    const input: ScoringInput = { ...SCORING_INPUT, deadline_ms: T0 + 123_456 };
    await run.wired.proposeDeps(T0).scoring(input, entryOf(run.wired, 0));
    const call = run.seen.scoring[0]!;
    const given = call.deps;
    expect(given.scorers.map((scorer) => scorer.did)).toStrictEqual(settings.scorerDids);
    const roles = [['scorer1Authentication', 'scorer1Delegation'], ['scorer2Authentication', 'scorer2Delegation'], ['scorer3Authentication', 'scorer3Delegation']] as const;
    for (const [at, [authentication, delegation]] of roles.entries()) {
      expect(given.scorers[at]!.authenticationKey, authentication).toBe(settings.keys[authentication].keyObject);
      expect(given.scorers[at]!.delegationKey, delegation).toBe(settings.keys[delegation].keyObject);
      expect(given.scorers[at]!.signer, delegation).toBe(settings.keys[delegation].signer);
    }
    // The deadline of the scoring is the one that the job gives in its input, and not a time that the wiring made from the clock.
    expect(given.deadline_ms).toBe(T0 + 123_456);
    expect(given.fault).toBe(settings.fault);
    expect(given.tokens.client).toBe(run.wired.gateway);
    expect(given.calls.bases).toBe(settings.mock);
    expect(given.subDelegation.bases).toBe(settings.mock);
    expect(given.subDelegation.delegationScript).toBe(settings.identityDeployment.delegation);
    expect(given.leftSink).toBe(run.wired.leftStore);
    expect(given.clock).toBe(given.calls.clock);
    expect(given.clock).toBe(given.subDelegation.clock);
    expect(given.clock.now()).toBe(T0);
    // The input of the scoring has the members of the scoring folder: the deadline went to the deps.
    expect(call.input).toStrictEqual({ tenant: input.tenant, delegation: input.delegation, today: input.today, weights: input.weights, rfq: input.rfq, subjects: input.subjects });
    expect(call.input).not.toHaveProperty('deadline_ms');
    given.log('marker of the scoring');
    expect(run.log).toContain('marker of the scoring');
  });
});

/** Three Bid Desks that pass every step: each is an agent of the stub gateway, and its record lists the supplier key of its advert for the transaction purpose. */
function bidderWorld(gateway: StubGateway): { readonly world: World; readonly desks: readonly Desk[] } {
  const bidders = emptyWorld();
  const desks = (['alfa', 'bravo', 'charlie'] as const).map((name) => {
    const supplier = ed25519Key(`bid-desk-${name}-supplier`);
    const agent = gateway.createAgent({ label: `bid-desk-${name}`, name: `Bid Desk ${name}`, organisation: { domain: `${name}.example.org`, verified: true }, keys: [{ key: supplier, purposes: 8 }] });
    const desk: Desk = { ...deskOf(name), agent: agent.id, did: agent.did, pkh: supplier.keyHash };
    addDesk(bidders, desk);
    return desk;
  });
  return { world: bidders, desks };
}

interface Asked {
  readonly list: string[];
  readonly read: { readonly ref: string; readonly address: string | null; readonly koios: string }[];
  readonly files: { readonly url: string; readonly max: number; readonly timeout: number }[];
  readonly stakes: { readonly koios: string; readonly policy: string; readonly name: string }[];
  readonly attestations: AttestationQuery[];
}

/** The stake output of a bidder as Koios lists it: 11,000,000 units, with the token of that bidder. */
const stakeOf = (desk: Desk, n: number): KoiosUtxo => stakeRow(n, { inline_datum: { bytes: datumOf({ agent_did: desk.agent }) }, asset_list: [tokenOf(desk.agent)] });

/** The sources of the bidder reader over the world of the three desks, with a record of what each was asked. */
function sourcesOf(bidders: World, desks: readonly Desk[], asked: Asked): BidderSources {
  return {
    fetchSuppliers: async (options) => {
      asked.list.push(options.capability_id);
      return bidders.rows;
    },
    readAdvert: async (ref, _fetch, koios, address) => {
      asked.read.push({ ref, address, koios });
      const reading = bidders.reads[ref];
      if (reading === undefined) throw new Error('no advert');
      return reading;
    },
    safeFetch: async (url, _init, options) => {
      asked.files.push({ url, max: options.maxResponseBytes, timeout: options.timeoutMs });
      if (url === CATALOG_URL) return { status: 200, text: JSON.stringify({ entries: desks.map((desk) => ({ metadata: { did: desk.did } })) }) };
      const file = bidders.files[url];
      if (file === undefined || file instanceof Error) throw new Error('no file');
      return { status: file.status, text: Buffer.from(file.bytes).toString('utf8') };
    },
    assetUtxos: async (koios, policy, name) => {
      asked.stakes.push({ koios, policy, name });
      return desks.filter((desk) => stakeTokenName(desk.agent) === name).map((desk, n) => stakeOf(desk, n + 1));
    },
    listAttestations: async (_env, query) => {
      asked.attestations.push(query);
      return page(desks.map((desk, n) => view(id(0x10 + n), datum({ subject: desk.agent, issuer: ISSUER.publicKey, issuedAt: T0 - 10 * DAY, validUntil: T0 + 80 * DAY }))));
    },
  };
}

describe('the read of the bidders, through the real readers over fake sources', () => {
  /** The three desks, their sources, a Module-1 port with one case against the second desk, and the wiring over all of them. */
  async function reading(over: { sources?: (sources: BidderSources) => Partial<BidderSources>; env?: NodeJS.ProcessEnv; fetch?: (next: typeof fetch, desks: readonly Desk[]) => typeof fetch } = {}) {
    // The clock of the stub gateway stands still at the start time of the marketplace, as the clock of the wiring does while no hire waits.
    const gateway = createStubGateway({ now: () => T0 });
    const { world: bidders, desks } = bidderWorld(gateway);
    const asked: Asked = { list: [], read: [], files: [], stakes: [], attestations: [] };
    const events: string[] = [];
    const made: Module1PortDeps[] = [];
    const port = new ScriptedPort(events);
    const claim = claimView(1, desks[1]!.did);
    port.claims = [claim];
    port.challenges = [challengeView(1, claim)];
    const sources = sourcesOf(bidders, desks, asked);
    const wrap = over.fetch;
    const run = await setup({
      gateway,
      ...(over.env === undefined ? {} : { env: over.env }),
      ...(wrap === undefined ? {} : { fetch: (next: typeof fetch) => wrap(next, desks) }),
      options: { sources: over.sources === undefined ? sources : over.sources(sources), createPort: (deps) => { made.push(deps); return port; } },
    });
    expect(run.settings.endpoints.gatewayUrl).toBe(gateway.baseUrl);
    return { ...run, desks, asked, events, made };
  }

  test('gives the file of each of the three bidders, with the facts that its source gives', async () => {
    const { wired, settings, desks, asked, events } = await reading();
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    const bidders = found.value.bidders;
    expect(bidders.map((bidder) => bidder.file.did)).toStrictEqual(desks.map((desk) => desk.did));
    for (const [at, name] of (['alfa', 'bravo', 'charlie'] as const).entries()) {
      expect(bidders[at]!.file, name).toMatchObject({
        status: 'active', organisation: `${name}.example.org`, organisation_verified: true, in_catalog: true, stake_lovelace: '11000000', price_list: 'valid', credential: 'valid',
        compliance: { state: 'valid', attestation_state: 'active' },
      });
      expect(bidders[at]!.price_list, name).not.toBeNull();
      expect(bidders[at]!.supplier_pkh, name).toBe(desks[at]!.pkh);
    }
    expect(bidders.map((bidder) => bidder.file.cases_against)).toStrictEqual([0, 1, 0]);
    // What each source was asked. The indexer gets the capability of the Bid Desk, and the chain read gets the advert address of the identity deployment and the Koios address of the settings.
    expect(asked.list).toStrictEqual([BID_CAPABILITIES.quote]);
    expect(asked.read).toHaveLength(3);
    expect(asked.read.every((entry) => entry.address === settings.identityDeployment.advert.address && entry.address === DEPLOYMENT.advert.address && entry.koios === settings.endpoints.koiosUrl)).toBe(true);
    // The manifest and the price list of each bidder come with the limits of the reader, and the catalog comes with the limits of the wiring.
    expect(asked.files.map((file) => file.url).sort()).toStrictEqual([...desks.flatMap((desk) => [desk.manifestUrl, desk.listUrl]), CATALOG_URL].sort());
    for (const file of asked.files) {
      expect(file.max, file.url).toBe(file.url === CATALOG_URL ? CATALOG_MAX_BYTES : BIDDER_FILE_MAX_BYTES);
      expect(file.timeout, file.url).toBe(file.url === CATALOG_URL ? CATALOG_TIMEOUT_MS : BIDDER_FETCH_TIMEOUT_MS);
    }
    // The stake is read for the id of each agent, at the stake policy and at the Koios address of the settings.
    expect(asked.stakes.map((entry) => entry.name).sort()).toStrictEqual(desks.map((desk) => stakeTokenName(desk.agent)).sort());
    expect(asked.stakes.every((entry) => entry.policy === REPUTATION_SCRIPT_HASH && entry.koios === settings.endpoints.koiosUrl)).toBe(true);
    // The compliance attestations are those of the issuer that the settings name, in type 0, and the cases are read from the one port.
    expect(asked.attestations).toHaveLength(3);
    for (const query of asked.attestations) expect(query).toMatchObject({ issuer: { type: 'key_hash', hash: ISSUER.keyHash }, attType: 0, limit: 50 });
    expect(settings.complianceIssuerPkh).toBe(ISSUER.keyHash);
    expect(events.filter((event) => event === 'readClaims')).toHaveLength(3);
    expect(events.filter((event) => event === 'readChallenges')).toHaveLength(3);
  });

  /** A Koios address that a setting gives. It is not the address that vector-read takes from its own variable. */
  const KOIOS = 'https://koios.example.test';
  const ASSET_UTXOS = `${KOIOS}/api/v1/asset_utxos`;
  /** The sources of the bidder reader with no reader of the stake: the wiring then reads the stake with its own reader. */
  const withOwnStakeReader = ({ fetchSuppliers, readAdvert, safeFetch, listAttestations }: BidderSources): Partial<BidderSources> => ({ fetchSuppliers, readAdvert, safeFetch, listAttestations });

  test('reads the stake at the Koios address of the settings, with the request of vector-read, and never at the address that vector-read takes from its own variable', async () => {
    const requests: { readonly url: string; readonly method: string | undefined; readonly body: string; readonly signal: AbortSignal | null | undefined }[] = [];
    const { wired, settings, desks } = await reading({
      env: { VECTOR_KOIOS_URL: KOIOS },
      sources: withOwnStakeReader,
      fetch: (next, all) => async (input, init) => {
        if (!String(input).endsWith('/asset_utxos')) return next(input, init);
        requests.push({ url: String(input), method: init?.method, body: String(init?.body), signal: init?.signal });
        const { _asset_list: [[, name]] } = JSON.parse(String(init?.body)) as { _asset_list: [[string, string]] };
        const rows = all.filter((desk) => stakeTokenName(desk.agent) === name).map((desk, n) => stakeOf(desk, n + 1));
        return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    expect(settings.endpoints.koiosUrl).toBe(KOIOS);
    expect(`${KOIOS}/api/v1`).not.toBe(KOIOS_URL);
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    expect(found.value.bidders.map((bidder) => bidder.file.stake_lovelace)).toStrictEqual(['11000000', '11000000', '11000000']);
    // One request for each bidder, and each goes to the address of the settings, with the body and the method of vector-read and a bound of time.
    expect(requests.map((request) => request.url)).toStrictEqual([ASSET_UTXOS, ASSET_UTXOS, ASSET_UTXOS]);
    expect(requests.every((request) => request.method === 'POST' && request.signal instanceof AbortSignal)).toBe(true);
    expect(requests.map((request) => request.body).sort()).toStrictEqual(desks.map((desk) => JSON.stringify({ _asset_list: [[REPUTATION_SCRIPT_HASH, stakeTokenName(desk.agent)]], _extended: true })).sort());
  });

  test.each([
    ['the status 503', () => new Response('{"error":"down"}', { status: 503 })],
    ['a body that is no JSON', () => new Response('not json', { status: 200 })],
    ['a fetch that throws', (): Response => { throw new Error('the connection failed'); }],
  ] as const)('gives a stake of null, and never 0, for %s from Koios, and the other facts stay', async (_what, fails) => {
    const { wired } = await reading({
      env: { VECTOR_KOIOS_URL: KOIOS },
      sources: withOwnStakeReader,
      fetch: (next) => async (input, init) => (String(input) === ASSET_UTXOS ? fails() : next(input, init)),
    });
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    expect(found.value.bidders.map((bidder) => bidder.file.stake_lovelace)).toStrictEqual([null, null, null]);
    expect(found.value.bidders.map((bidder) => bidder.file.credential)).toStrictEqual(['valid', 'valid', 'valid']);
  });

  test('reads the cases against the bidders and stakes the claim of the agent through one Module-1 port, made one time', async () => {
    const { wired, events, made } = await reading();
    await wired.proposeDeps(T0).discover();
    const read = [...events];
    expect(read.filter((event) => event === 'readClaims')).toHaveLength(3);
    expect(read.filter((event) => event === 'readChallenges')).toHaveLength(3);
    expect((await wired.dispute.stakeRunClaim(CLAIM)).ok).toBe(true);
    // The claim went through the object that the reader of the cases used: its calls follow the reads in the one list of events.
    expect(events.slice(read.length)).toStrictEqual(['publish claim', 'submitClaim']);
    expect(made).toHaveLength(1);
  });

  test('counts the attestation of the issuer and no other: an attestation of a stranger is not the compliance of a bidder', async () => {
    const stranger = keyOf(rawKey(99)).publicKeyHex;
    const { wired } = await reading({
      sources: (sources) => ({
        ...sources,
        // The same attestations, as if another key had issued them.
        listAttestations: async (env, query) => {
          const own = await sources.listAttestations(env, query);
          return { ...own, items: own.items.map((item) => ({ ...item, attestation: { ...item.attestation, issuer: stranger } })) };
        },
      }),
    });
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    expect(found.value.bidders.map((bidder) => bidder.file.compliance.state)).toStrictEqual(['absent', 'absent', 'absent']);
  });

  test('gives the budget of the read as the time that the job has left, and reads nothing for a job that has no time left', async () => {
    const { wired, asked } = await reading();
    const left = 5_000;
    await wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS + left).discover();
    const desksFiles = (): typeof asked.files => asked.files.filter((file) => file.url.endsWith('/agent.json') || file.url.endsWith('/price-list.json'));
    expect(desksFiles()).toHaveLength(6);
    expect(desksFiles().every((file) => file.timeout === left)).toBe(true);
    const counts = (): number[] => [asked.list.length, asked.read.length, asked.files.length, asked.stakes.length, asked.attestations.length];
    const before = counts();
    expect(await wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS).discover()).toMatchObject({ ok: false, code: 'bidders_unavailable' });
    expect(await wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).discover()).toMatchObject({ ok: false, code: 'bidders_unavailable' });
    expect(counts()).toStrictEqual(before);
    // With the time of a whole job, the fetch of a file gets the time of one fetch of the reader.
    await wired.proposeDeps(T0).discover();
    expect(desksFiles().slice(6).every((file) => file.timeout === BIDDER_FETCH_TIMEOUT_MS)).toBe(true);
  });

  test('uses one verifier for every credential: the key set of the gateway is read once for two reads of three bidders', async () => {
    const { wired, gateway } = await reading();
    await wired.proposeDeps(T0).discover();
    await wired.proposeDeps(T0).discover();
    expect(gateway.requests.filter((request) => request.path === '/.well-known/jwks.json')).toHaveLength(1);
    expect(gateway.requests.filter((request) => request.path.endsWith('/credential'))).toHaveLength(6);
  });

  test.each([
    ['a fetch that throws', async () => { throw new Error('the fetch failed'); }],
    ['the status 404', async () => ({ status: 404, text: '{"entries":[]}' })],
    ['a body that is no JSON', async () => ({ status: 200, text: 'not json' })],
    ['a body with no list of entries', async () => ({ status: 200, text: '{"agents":[]}' })],
  ] as const)('gives `null` for the catalog for %s, and the other facts stay', async (_what, fails) => {
    const { wired } = await reading({ sources: (sources) => ({ ...sources, safeFetch: (url, init, options) => (url === CATALOG_URL ? fails() : sources.safeFetch(url, init, options)) }) });
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    expect(found.value.bidders.map((bidder) => bidder.file.in_catalog)).toStrictEqual([null, null, null]);
    expect(found.value.bidders.map((bidder) => bidder.file.credential)).toStrictEqual(['valid', 'valid', 'valid']);
  });

  test('keeps a bidder whose record the gateway cannot give, with the status `unreadable`, and reads the others', async () => {
    const { wired, desks, gateway } = await reading();
    gateway.fault(`/1.0/identifiers/${desks[1]!.did}`, 'network');
    const found = await wired.proposeDeps(T0).discover();
    if (!found.ok) throw new Error(`the read failed with ${found.code}`);
    expect(found.value.bidders.map((bidder) => bidder.file.status)).toStrictEqual(['active', 'unreadable', 'active']);
  });
});

describe('the reads of the ledger and the job execute', () => {
  test('the key of a delegation is the delegate key of its leaf, and a delegation that the ledger does not show has none', async () => {
    const { wired } = await setup();
    const deps = wired.proposeDeps(T0);
    expect(await deps.delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
    expect(await deps.delegateKeyOf('88'.repeat(32))).toBeNull();
    expect(await wired.executeDeps(T0).delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
  });

  test('a ledger that cannot be read rejects: it is never "no delegation"', async () => {
    const broken = world();
    broken.getUtxos = async () => { throw new Error('the node does not answer'); };
    const { wired } = await setup({ provider: broken });
    await expect(wired.proposeDeps(T0).delegateKeyOf('77'.repeat(32))).rejects.toThrow();
    await expect(wired.proposeDeps(T0).reads.delegation('77'.repeat(32))).rejects.toThrow();
  });

  test('gives the job execute the DPoP key of each delegation key, the service key as the key of the agent, the one gateway client, the bases of the mock service and the log of the service', async () => {
    const run = await setup();
    const { settings, wired } = run;
    const deps = wired.executeDeps(T0);
    expect(deps.delegationKeys.find(settings.keys.delegation1.pkh)?.dpopKey).toBe(settings.keys.delegation1.keyObject);
    expect(deps.delegationKeys.find(settings.keys.delegation2.pkh)?.dpopKey).toBe(settings.keys.delegation2.keyObject);
    // The first key is the entry of the first delegation key, and every job gets the same objects.
    expect(deps.delegationKeys.first).toBe(deps.delegationKeys.find(settings.keys.delegation1.pkh));
    expect(wired.executeDeps(T0 + 5).delegationKeys.first).toBe(deps.delegationKeys.first);
    expect(deps.agent).toStrictEqual({ did: settings.agentDid, authenticationKey: settings.keys.service.keyObject });
    expect(deps.tokens.client).toBe(wired.gateway);
    expect(deps.calls.bases).toBe(settings.mock);
    expect(deps.reads).toBe(wired.proposeDeps(T0).reads);
    expect(deps.clock()).toBe(T0);
    wired.proposeDeps(T0).log('marker of the propose deps');
    deps.log('marker of the execute deps');
    expect(run.log).toContain('marker of the propose deps');
    expect(run.log).toContain('marker of the execute deps');
  });
});

describe('the start', () => {
  /** A fetch in front of the stub marketplace that answers MODULE1_URL with `response()` and passes every other call on. */
  const answering = (response: () => Response) => (next: typeof fetch): typeof fetch => async (input, init) => (String(input) === MODULE1_URL ? response() : next(input, init));

  test('fetches the Module-1 manifest at its pinned address one time, and the start fetches nothing else', async () => {
    const seen: string[] = [];
    await setup({ fetch: (next) => async (input, init) => { seen.push(String(input)); return next(input, init); } });
    expect(seen).toStrictEqual([MODULE1_URL]);
  });

  test('stops when the Module-1 manifest cannot be fetched, or is not JSON, naming the variable, and the answer of the fixture is its twin', async () => {
    const missing = await startError(setup({ fetch: answering(() => new Response('', { status: 404 })) }));
    expect(missing.message).toMatch(/^The Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) .* cannot be fetched: the host answered HTTP 404/);
    const notJson = await startError(setup({ fetch: answering(() => new Response('not json', { status: 200 })) }));
    expect(notJson.message).toMatch(/^The Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) .* is not JSON/);
    await expect(setup()).resolves.toBeDefined();
  });

  test('stops when the Module-1 manifest names another identity registry than IDENTITY_POLICY_ID, naming the two settings and no hash, and the manifest of the fixture is its twin', async () => {
    const fixture = await (await withModule1(fetch)(MODULE1_URL)).text();
    const other: { identity: { identity_hash: string } } = JSON.parse(fixture);
    const registry = other.identity.identity_hash;
    other.identity.identity_hash = 'ab'.repeat(28);
    const chains: string[] = [];
    const failed = await startError(setup({ fetch: answering(() => new Response(JSON.stringify(other), { status: 200 })), chains }));
    expect(failed.message.startsWith('the Module-1 manifest (VECTOR_MODULE1_MANIFEST) names another identity registry than IDENTITY_POLICY_ID')).toBe(true);
    expect(failed.message).not.toContain('ab'.repeat(28));
    expect(failed.message).not.toContain(registry);
    expect(chains).toStrictEqual([]);
    await expect(setup({ fetch: answering(() => new Response(fixture, { status: 200 })) })).resolves.toBeDefined();
  });
});

describe('the numbers of the service agree with each other', () => {
  test('the time that the propose job keeps for the scoring is the time that three scorers need and the ranking decision keeps, so the hire gate and the check of the scorers cannot drift apart', () => {
    expect(SCORING_RESERVE_MS).toBe(SCORERS_NEED_MS + RANKING_RESERVE_MS);
  });
});
