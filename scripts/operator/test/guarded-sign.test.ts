// The guarded signer for the flows that the kit drives. The kit builds a transaction with the provider, calls a SYNC sign, submits, and waits for the confirmation by itself, and one call of the kit
// can sign more than one transaction. `recordingProvider` keeps what a build reads and what the wait confirmed, and `guardedSign` judges each transaction before it returns a signature.
// The first part builds the transactions with Lucid over a small ledger of the checks. The last part runs the real chain port of the kit and its claim flow over the ledger of the kit tests.
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { ensureSlotConfig } from '../../../packages/buyer-core/src/index.ts';
import { HireLane } from '../../../packages/hire-kit/src/index.ts';
import { Dispute } from '../../../packages/usecase-kit/src/dispute/index.ts';
import type { RunClaimInput, RunClaimResult } from '../../../packages/usecase-kit/src/dispute/index.ts';
import { ChainView, hashOfTransaction } from '../../checks/test/support/chain-view.ts';
import { CLAIMER_ID, MODULE1, WALLET_ADDRESS, forever, ledgerWorld, realPort } from '../../../packages/usecase-kit/test/dispute/ledger.ts';
import type { LedgerProvider } from '../../../packages/usecase-kit/test/dispute/ledger.ts';
import { HOUR, MANIFEST_SHA, ORDER_DESK_CLAIM, SETTINGS as DISPUTE_SETTINGS } from '../../../packages/usecase-kit/test/dispute/support.ts';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import type { GuardResult, StepPlan } from '../../checks/lib/guards.ts';
import { settleInFlight } from '../../checks/lib/inflight.ts';
import { parseKeyText } from '../../checks/lib/keys.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { lucidForAddress } from '../../checks/lib/platform.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import type { NodeAccess } from '../../checks/lib/ports.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { ApprovalError, Exposure, netRegistryOutflow } from '../lib/approval.ts';
import type { GoFile } from '../lib/approval.ts';
import type { GuardedSignRequest, LandHost, OperatorSettings } from '../lib/contract.ts';
import { DryStop, guardedSign, recordKitLanding, recordingProvider } from '../lib/guarded-sign.ts';
import type { Recorder } from '../lib/guarded-sign.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { FakeClock, MemoryOutput } from './support/fakes.ts';
import { counterSeed, makeKeyRoot, removeTestKeys, writeSeed } from './support/keys.ts';

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const MINUTE = 60_000;
const USE_CASE = 'test-use-case';
const IDENTITY = { check: 'claim', network: 'vector-mainnet', record: USE_CASE };
const FIXTURE_TX = 'e17a2ebab8eae3850f959290041b3bef3f3597584f8cf4a728e14777dddb8c32';
const KEY_NAMES = ['run', 'service', 'other'] as const;
type KeyName = (typeof KEY_NAMES)[number];
type Signed = { signedCborHex: string; txHashHex: string };
type Sign = (unsignedCborHex: string) => Signed;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  removeTestKeys();
});

/** A ledger of the checks that takes a signed transaction (`submitTx`), and says that a transaction is confirmed once it took it (`awaitTx`), unless a test says that it is not. */
class TestChain extends ChainView {
  confirms = true;

  override async submitTx(tx: string): Promise<string> {
    return this.apply(tx);
  }

  override async awaitTx(txHash: string): Promise<boolean> {
    return this.confirms && this.applied.some((signed) => hashOfTransaction(signed) === txHash);
  }
}

beforeAll(async () => {
  await ensureSlotConfig(new TestChain([], NOW));
});

// ---- the host of a test: real state, evidence and exposure files, a real registry, and nothing that a test does not name ----

function registryOf(seeds: Partial<Record<KeyName, string>> = {}, need?: readonly KeyName[]): Registry {
  const root = makeKeyRoot();
  const specs: KeySpec[] = KEY_NAMES.map((name) => ({ name, scope: 'use-case', about: `The test key ${name}.` }));
  for (const name of KEY_NAMES) writeSeed(root, USE_CASE, name, `${seeds[name] ?? counterSeed()}\n`);
  return loadRegistry({ dir: root, useCase: USE_CASE, specs, ...(need === undefined ? {} : { need }) });
}

const goFor = (registry: Registry, over: Partial<GoFile> = {}): GoFile => ({
  approvedBy: 'the test', at: '2026-11-15T11:00:00Z', session: 'test-session', runWallet: registry.addressOf(registry.has('run') ? 'run' : 'service'), capUnits: 100, tasks: ['claim'], irreversible: [], expiresAt: '2026-11-16T12:00:00Z', ...over,
});

const HOST_SETTINGS: OperatorSettings = {
  network: VECTOR_MAINNET, useCase: USE_CASE, keysDir: '/test/keys', stateDir: '/test/state', agentsDir: '/test/agents', goFile: '/test/state/GO.json', mockEnvFile: null, contact: null, module1Commit: null,
  urls: { ogmios: 'https://node.test', submit: 'https://submit.test', koios: 'https://indexer.test', hosted: 'https://hosted.test/mcp', gateway: 'https://gateway.test' },
  maxFeeLovelace: 2_000_000n, maxCollateralLossLovelace: 5_000_000n,
};

/** A member of the host that the signer must not touch: any read of it fails the test. */
const unused = <T extends object>(name: string): T => new Proxy({} as T, { get: () => { throw new Error(`the guarded signer touched the ${name} of the host`); } });

interface HostOptions {
  mode?: 'dry' | 'submit';
  /** The approval. Not given: a good approval with the cap `capUnits` (100). `null`: no approval. */
  go?: GoFile | null;
  capUnits?: number;
  /** The result of the network guard that the runner keeps. Not given: ok. `null`: the guard has not run. */
  network?: GuardResult | null;
  systemStartMs?: number | null;
  /** The write of the state file: a test makes it fail with this function. */
  stateRename?: (from: string, to: string) => void;
}

interface HostParts {
  readonly host: LandHost;
  readonly registry: Registry;
  readonly state: StateFile;
  readonly evidence: EvidenceFile;
  readonly exposure: Exposure;
  readonly out: MemoryOutput;
  readonly clock: FakeClock;
  /** The spy on the signature of the ring: it calls through, and a test can count the calls or replace the result. */
  readonly signs: MockInstance<(keyHash: string, cborHex: string) => string>;
  readonly dir: string;
}

function makeHost(registry: Registry, options: HostOptions = {}): HostParts {
  const dir = mkdtempSync(join(tmpdir(), 'operator-sign-'));
  roots.push(dir);
  const go = options.go === undefined ? goFor(registry, options.capUnits === undefined ? {} : { capUnits: options.capUnits }) : options.go;
  const stateRename = options.stateRename;
  const state = StateFile.open(join(dir, 'claim.state.json'), IDENTITY, { rename: (from, to) => (stateRename === undefined ? renameSync(from, to) : stateRename(from, to)) });
  const evidence = EvidenceFile.open(join(dir, 'claim.evidence.json'), IDENTITY);
  const exposure = new Exposure(join(dir, 'exposure.test-session.json'), go);
  const clock = new FakeClock(NOW);
  const out = new MemoryOutput();
  const signs = vi.spyOn(registry.ring, 'sign');
  const network: GuardResult | null = options.network === undefined ? { guard: 'network', ok: true, message: 'the node is on vector-mainnet' } : options.network;
  const systemStartMs = options.systemStartMs === undefined ? VECTOR_MAINNET.systemStartMs : options.systemStartMs;
  const host: LandHost = {
    mode: options.mode ?? 'submit', settings: { ...HOST_SETTINGS, network: { ...VECTOR_MAINNET, systemStartMs } }, registry, state, evidence, clock, out, node: unused('node'), network: unused('network gate'),
    networkResult: () => network, chain: unused('chain'), hosted: unused('hosted tools'), go, exposure, task: 'claim', awaitMs: 30_000, pollMs: 5_000,
  };
  return { host, registry, state, evidence, exposure, out, clock, signs, dir };
}

const walletOutputs = (address: string, tag: string, lovelace: readonly bigint[]): Utxo[] => lovelace.map((amount, outputIndex) => ({ txHash: `${tag}${FIXTURE_TX.slice(2)}`, outputIndex, address, assets: { lovelace: amount } }));

interface Rig extends HostParts {
  readonly chain: TestChain;
  /** The provider that the builders read through. */
  readonly recorded: TestChain & Recorder;
  /** An address that is no wallet of the registry. */
  readonly external: string;
}

/** The wallets `service` (100 and 5 units), `run` (50 units) and `other` (20 units) on a small ledger, and a host over the registry of their keys. */
function makeRig(options: HostOptions & { need?: readonly KeyName[] } = {}): Rig {
  const registry = registryOf({}, options.need);
  const parts = makeHost(registry, options);
  const wallets = [['service', '10', [100_000_000n, 5_000_000n]], ['run', '20', [50_000_000n]], ['other', '30', [20_000_000n]]] as const;
  const held = wallets.filter(([name]) => registry.has(name)).flatMap(([name, tag, lovelace]) => walletOutputs(registry.addressOf(name), tag, lovelace));
  const chain = new TestChain(held, NOW);
  return { ...parts, chain, recorded: recordingProvider(chain), external: parseKeyText(counterSeed(), 'external').address };
}

function planOf(registry: Registry, over: Partial<StepPlan> & { outflow?: Partial<Record<KeyName, bigint>> } = {}): StepPlan {
  const { outflow, ...rest } = over;
  const maxOutflow: Record<string, bigint> = {};
  for (const [name, amount] of Object.entries(outflow ?? {})) maxOutflow[registry.hashOf(name)] = amount!;
  return { maxFeeLovelace: 2_000_000n, maxOutflow, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set(), mint: {}, ...rest };
}

/** The request of a plain move of funds: the key `service` signs, and 4 units may leave its wallet. */
const moveRequest = (registry: Registry, over: Partial<GuardedSignRequest> = {}): GuardedSignRequest => ({ step: 'move', plan: planOf(registry, { outflow: { service: 4_000_000n } }), signer: 'service', ...over });

interface Built { readonly cbor: string; readonly hash: string; readonly facts: TxFacts }

/** Builds an unsigned payment through `through` (the recording provider by default): from the wallet `from` (`service`) to `to` (the wallet `other`), valid for 30 minutes unless `validTo` says another end, or null for none. */
async function pay(rig: Rig, lovelace: bigint, options: { from?: KeyName; to?: string; through?: TestChain; validTo?: number | null } = {}): Promise<Built> {
  const lucid = await lucidForAddress(options.through ?? rig.recorded, rig.registry.addressOf(options.from ?? 'service'));
  const tx = lucid.newTx().pay.ToAddress(options.to ?? rig.registry.addressOf('other'), { lovelace });
  const built = await (options.validTo === null ? tx : tx.validTo(options.validTo ?? NOW + 30 * MINUTE)).complete();
  const cbor = built.toCBOR();
  return { cbor, hash: built.toHash(), facts: factsOf(cbor) };
}

function thrown(run: () => unknown): unknown {
  try { run(); } catch (err) { return err; }
  throw new Error('the call did not throw');
}

/** The refusal of a guard, with the guards that failed. */
function refusal(run: () => unknown): GuardRefusal {
  const err = thrown(run);
  if (!(err instanceof GuardRefusal)) throw new Error(`expected a GuardRefusal, got ${String(err)}`);
  return err;
}

/** Nothing was signed, reserved or kept in flight. */
function expectNothingSigned(rig: HostParts): void {
  expect(rig.signs).not.toHaveBeenCalled();
  expect(rig.exposure.total()).toBe(0n);
  expect(rig.state.snapshot().in_flight).toBeNull();
}

interface ExposureFile { entries: Array<{ step: string; tx_hash: string; net_lovelace: string; at: string }> }

function exposureEntries(rig: HostParts): ExposureFile['entries'] {
  const path = join(rig.dir, 'exposure.test-session.json');
  if (!existsSync(path)) return [];
  const file: ExposureFile = JSON.parse(readFileSync(path, 'utf8'));
  return file.entries;
}

// ---- the record of the provider ----

function output(n: number, index = 0): Utxo {
  return { txHash: n.toString(16).padStart(2, '0').repeat(32), outputIndex: index, address: `addr_test_${n}`, assets: { lovelace: 1_000_000n * BigInt(n), ...(n === 9 ? { [`${'11'.repeat(28)}74657374`]: 5n } : {}) } };
}
const refOf = (utxo: Utxo): string => `${utxo.txHash}#${utxo.outputIndex}`;

/** A provider with the output reads of Lucid, a private field, and a method of its own: it counts what it was asked. */
class ReadingProvider {
  readonly asked: string[] = [];
  readonly #word = 'private';
  answers = new Map<string, boolean>();

  async getUtxos(address: string): Promise<Utxo[]> {
    this.asked.push(`getUtxos ${address}`);
    return [output(1), output(2, 3)];
  }

  async getUtxosWithUnit(address: string, unit: string): Promise<Utxo[]> {
    this.asked.push(`getUtxosWithUnit ${address} ${unit}`);
    return [output(9)];
  }

  async getUtxoByUnit(unit: string): Promise<Utxo> {
    this.asked.push(`getUtxoByUnit ${unit}`);
    return output(4);
  }

  async getUtxosByOutRef(refs: ReadonlyArray<{ txHash: string; outputIndex: number }>): Promise<Utxo[]> {
    this.asked.push(`getUtxosByOutRef ${refs.length}`);
    return refs.map((ref) => ({ ...output(5), txHash: ref.txHash, outputIndex: ref.outputIndex }));
  }

  async awaitTx(txHash: string, interval?: number): Promise<boolean> {
    this.asked.push(`awaitTx ${txHash.slice(0, 4)} ${String(interval)}`);
    const known = this.answers.get(txHash);
    if (known === undefined) throw new Error('the node could not be read');
    return known;
  }

  word(): string {
    return this.#word;
  }

  readonly label = 'plain member';
}

describe('recordingProvider', () => {
  it('keeps each output that getUtxos, getUtxosByOutRef, getUtxosWithUnit and getUtxoByUnit return, by its reference', async () => {
    const inner = new ReadingProvider();
    const provider = recordingProvider(inner);
    expect(provider.seen(refOf(output(1)))).toBeUndefined();
    await provider.getUtxos('addr1');
    expect(provider.seen(refOf(output(1)))).toEqual(output(1));
    expect(provider.seen(refOf(output(2, 3)))).toEqual(output(2, 3));
    expect(provider.seen(refOf(output(2)))).toBeUndefined();
    await provider.getUtxosWithUnit('addr1', 'unit1');
    expect(provider.seen(refOf(output(9)))).toEqual(output(9));
    await provider.getUtxoByUnit('unit2');
    expect(provider.seen(refOf(output(4)))).toEqual(output(4));
    const asked = [{ txHash: '77'.repeat(32), outputIndex: 2 }];
    await provider.getUtxosByOutRef(asked);
    expect(provider.seen(`${'77'.repeat(32)}#2`)).toMatchObject({ txHash: '77'.repeat(32), outputIndex: 2 });
    expect(provider.seen(`${'77'.repeat(32)}#1`)).toBeUndefined();
    expect(inner.asked).toEqual(['getUtxos addr1', 'getUtxosWithUnit addr1 unit1', 'getUtxoByUnit unit2', 'getUtxosByOutRef 1']);
  });
  it('gives back what the provider gave, and keeps what it gave in a copy: a later change of the output does not change the record', async () => {
    const provider = recordingProvider(new ReadingProvider());
    const [first] = await provider.getUtxos('addr1');
    expect(first).toEqual(output(1));
    first!.address = 'addr_changed_after_the_read';
    first!.assets.lovelace = 1n;
    expect(provider.seen(refOf(output(1)))).toEqual(output(1));
  });
  it('takes the reference in lower case, and reads a reference in upper case', async () => {
    const provider = recordingProvider(new ReadingProvider());
    await provider.getUtxos('addr1');
    expect(provider.seen(refOf(output(1)).toUpperCase())).toEqual(output(1));
  });
  it('passes every other member through: a method that reads a private field, a plain member and the arguments', async () => {
    const inner = new ReadingProvider();
    const provider = recordingProvider(inner);
    expect(provider.word()).toBe('private');
    expect(provider.label).toBe('plain member');
    expect(provider).toBeInstanceOf(ReadingProvider);
    provider.answers.set('aa'.repeat(32), true);
    expect(inner.answers.get('aa'.repeat(32))).toBe(true);
    await provider.awaitTx('aa'.repeat(32), 1234);
    expect(inner.asked).toEqual(['awaitTx aaaa 1234']);
  });
  it('says that a transaction is confirmed only after awaitTx resolved true for its hash', async () => {
    const inner = new ReadingProvider();
    const provider = recordingProvider(inner);
    const [yes, no, unread] = ['a1'.repeat(32), 'b2'.repeat(32), 'c3'.repeat(32)];
    inner.answers.set(yes!, true);
    inner.answers.set(no!, false);
    expect(provider.confirmed(yes!)).toBe(false);
    expect(await provider.awaitTx(yes!)).toBe(true);
    expect(await provider.awaitTx(no!)).toBe(false);
    expect(provider.confirmed(yes!)).toBe(true);
    expect(provider.confirmed(no!)).toBe(false);
    expect(provider.confirmed(unread!)).toBe(false);
    expect(provider.confirmed(yes!.toUpperCase())).toBe(true);
  });
  it('does not say confirmed for a wait that failed, and passes the failure on', async () => {
    const inner = new ReadingProvider();
    const provider = recordingProvider(inner);
    await expect(provider.awaitTx('d4'.repeat(32))).rejects.toThrow('the node could not be read');
    expect(provider.confirmed('d4'.repeat(32))).toBe(false);
  });
  it('passes the failure of a read on, and keeps nothing for it', async () => {
    const inner = new ReadingProvider();
    inner.getUtxos = async () => { throw new Error('the node is down'); };
    const provider = recordingProvider(inner);
    await expect(provider.getUtxos('addr1')).rejects.toThrow('the node is down');
    expect(provider.seen(refOf(output(1)))).toBeUndefined();
  });
  it('keeps a record for each provider: two providers do not share what they read', async () => {
    const one = recordingProvider(new ReadingProvider());
    const two = recordingProvider(new ReadingProvider());
    await one.getUtxos('addr1');
    expect(one.seen(refOf(output(1)))).toBeDefined();
    expect(two.seen(refOf(output(1)))).toBeUndefined();
  });
});

// ---- the guards before a signature ----

describe('guardedSign: what is refused before a signature', () => {
  it('refuses an input that was not read, names it, and signs nothing; the same transaction is signed when its inputs were read', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const unread = recordingProvider(rig.chain);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), unread)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['inputs']);
    expect(error.message).toMatch(/an input was not read/);
    for (const ref of built.facts.inputs) expect(error.message).toContain(ref);
    expect(rig.out.text).toContain('(not read)');
    expectNothingSigned(rig);
    const signed = guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor);
    expect(signed.txHashHex).toBe(built.hash);
  });
  it('names only the input that was not read when the transaction spends one that it read and one that it did not', async () => {
    const rig = makeRig();
    const [first, second] = await rig.chain.getUtxos(rig.registry.addressOf('service'));
    // The builder reads through the plain chain: nothing of it is in the record. Only the first output is read through the recording provider.
    await rig.recorded.getUtxosByOutRef([{ txHash: first!.txHash, outputIndex: first!.outputIndex }]);
    const lucid = await lucidForAddress(rig.chain, rig.registry.addressOf('service'));
    const built = await lucid.newTx().collectFrom([first!, second!]).pay.ToAddress(rig.registry.addressOf('other'), { lovelace: 3_000_000n }).validTo(NOW + 30 * MINUTE).complete();
    expect(factsOf(built.toCBOR()).inputs.sort()).toEqual([refOf(first!), refOf(second!)].sort());
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.toCBOR()));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['inputs']);
    expect(error.message).toContain(refOf(second!));
    expect(error.message).not.toContain(refOf(first!));
    expectNothingSigned(rig);
    await rig.recorded.getUtxosByOutRef([{ txHash: second!.txHash, outputIndex: second!.outputIndex }]);
    expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.toCBOR()).txHashHex).toBe(built.toHash());
  });

  const GUARDS: ReadonlyArray<readonly [string, (rig: Rig) => Partial<StepPlan> & { outflow?: Partial<Record<KeyName, bigint>> }, string]> = [
    ['outflow', () => ({ outflow: { service: 1_000_000n } }), 'outflow'],
    ['fee', () => ({ outflow: { service: 4_000_000n }, maxFeeLovelace: 1n }), 'fee'],
    ['mint', () => ({ outflow: { service: 4_000_000n }, mint: { [`${'aa'.repeat(28)}41`]: 1n } }), 'mint'],
    ['nothing_else', () => ({ outflow: { service: 4_000_000n }, withdrawals: 1 }), 'nothing_else'],
  ];
  for (const [what, plan, guard] of GUARDS) {
    it(`refuses a transaction that the guard ${what} fails, says which guard, and signs nothing; the twin with the right plan is signed`, async () => {
      const rig = makeRig();
      const built = await pay(rig, 3_000_000n);
      const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry, { plan: planOf(rig.registry, plan(rig)) }), rig.recorded)(built.cbor));
      expect(error.failures.map((failure) => failure.guard)).toEqual([guard]);
      expect(rig.out.text).toMatch(new RegExp(`FAIL +${guard}\\b`));
      expectNothingSigned(rig);
      expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
    });
  }
  it('refuses a payment to an address that the plan does not name, and signs it when the plan names the address', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n, { to: rig.external });
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['destinations']);
    expectNothingSigned(rig);
    const named = moveRequest(rig.registry, { plan: planOf(rig.registry, { outflow: { service: 4_000_000n }, destinations: new Set([rig.external]) }) });
    expect(guardedSign(rig.host, named, rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });
  it('judges each transaction by the plan that the function gives for its bytes', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const seenFacts: TxFacts[] = [];
    const strict = moveRequest(rig.registry, { plan: (facts) => { seenFacts.push(facts); return planOf(rig.registry, { outflow: { service: 1_000_000n } }); } });
    expect(refusal(() => guardedSign(rig.host, strict, rig.recorded)(built.cbor)).failures.map((failure) => failure.guard)).toEqual(['outflow']);
    expect(seenFacts).toHaveLength(1);
    expect(seenFacts[0]!.txHash).toBe(built.hash);
    const loose = moveRequest(rig.registry, { plan: () => planOf(rig.registry, { outflow: { service: 4_000_000n } }) });
    expect(guardedSign(rig.host, loose, rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });

  it('refuses when the network guard has not run, and signs when it has', async () => {
    const rig = makeRig({ network: null });
    const built = await pay(rig, 3_000_000n);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['network']);
    expect(error.message).toMatch(/has not run/);
    expectNothingSigned(rig);
    const ready = makeRig();
    const again = await pay(ready, 3_000_000n);
    expect(guardedSign(ready.host, moveRequest(ready.registry), ready.recorded)(again.cbor).txHashHex).toBe(again.hash);
  });
  it('refuses when the network guard failed, with the message of the guard, in the dry mode too', async () => {
    for (const mode of ['submit', 'dry'] as const) {
      const rig = makeRig({ mode, network: { guard: 'network', ok: false, message: 'the node is on the network with the magic 1' } });
      const built = await pay(rig, 3_000_000n);
      const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
      expect(error.failures.map((failure) => failure.guard)).toEqual(['network']);
      expect(error.message).toContain('the node is on the network with the magic 1');
      expectNothingSigned(rig);
    }
  });

  it('refuses a transaction that has no end of validity, in both modes, and signs one that has', async () => {
    for (const mode of ['submit', 'dry'] as const) {
      const rig = makeRig({ mode });
      const open = await pay(rig, 3_000_000n, { validTo: null });
      expect(open.facts.validityEndSlot).toBeNull();
      const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(open.cbor));
      expect(error.failures.map((failure) => failure.guard)).toEqual(['body']);
      expect(error.message).toMatch(/no end of validity/);
      expectNothingSigned(rig);
    }
    const rig = makeRig();
    expect((await pay(rig, 3_000_000n)).facts.validityEndSlot).not.toBeNull();
  });
  it('refuses when the network settings give no start time of the chain, and signs when they do', async () => {
    const rig = makeRig({ systemStartMs: null });
    const built = await pay(rig, 3_000_000n);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['body']);
    expect(error.message).toMatch(/start time/);
    expectNothingSigned(rig);
    const ready = makeRig();
    const again = await pay(ready, 3_000_000n);
    expect(guardedSign(ready.host, moveRequest(ready.registry), ready.recorded)(again.cbor).txHashHex).toBe(again.hash);
  });
  const HOUR_MS = 60 * MINUTE;
  const BAD_ENDS: ReadonlyArray<readonly [string, number, RegExp]> = [
    ['an end in the past', NOW - MINUTE, /not after now/],
    ['an end that is the time now', NOW, /not after now/],
    ['an end a month ago', NOW - 30 * 24 * HOUR_MS, /not after now/],
    ['an end one second more than one hour away', NOW + HOUR_MS + 1000, /more than one hour after now/],
    ['an end three years away', NOW + 3 * 365 * 24 * HOUR_MS, /more than one hour after now/],
  ];
  for (const [what, validTo, message] of BAD_ENDS) {
    it(`refuses a transaction with ${what}, in both modes, before any reserve or signature, and shows the end`, async () => {
      for (const mode of ['submit', 'dry'] as const) {
        const rig = makeRig({ mode });
        const built = await pay(rig, 3_000_000n, { validTo });
        expect(built.facts.validityEndSlot).not.toBeNull();
        const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
        expect(error.failures.map((failure) => failure.guard), mode).toEqual(['body']);
        expect(error.message).toMatch(message);
        expect(error.message).toContain(new Date(validTo).toISOString());
        expect(rig.out.text).toContain(`valid until: ${new Date(validTo).toISOString()}`);
        expectNothingSigned(rig);
        expect(existsSync(join(rig.dir, 'exposure.test-session.json'))).toBe(false);
      }
    });
  }
  it('signs a transaction that ends one second from now, in 30 minutes, and in exactly one hour, and keeps that end in the transaction in flight', async () => {
    for (const validTo of [NOW + 1000, NOW + 30 * MINUTE, NOW + HOUR_MS]) {
      const rig = makeRig();
      const built = await pay(rig, 3_000_000n, { validTo });
      expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
      expect(rig.state.snapshot().in_flight?.valid_to).toBe(validTo);
    }
  });
  it('refuses every end of validity when the clock gives no time, in both modes, and signs when it does', async () => {
    for (const mode of ['submit', 'dry'] as const) {
      const rig = makeRig({ mode });
      rig.clock.t = Number.NaN;
      const built = await pay(rig, 3_000_000n);
      const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
      expect(error.failures.map((failure) => failure.guard), mode).toEqual(['body']);
      expect(error.message).toMatch(/clock gave no valid time/);
      expectNothingSigned(rig);
    }
    const ready = makeRig();
    const again = await pay(ready, 3_000_000n);
    expect(guardedSign(ready.host, moveRequest(ready.registry), ready.recorded)(again.cbor).txHashHex).toBe(again.hash);
  });
  it('refuses a step name that is empty, too long or not text, and signs with a name that is right', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    for (const step of ['', 'x'.repeat(201), 5 as unknown as string]) {
      const error = thrown(() => guardedSign(rig.host, moveRequest(rig.registry, { step }), rig.recorded)(built.cbor));
      expect(error).toBeInstanceOf(PreconditionError);
    }
    expectNothingSigned(rig);
    expect(guardedSign(rig.host, moveRequest(rig.registry, { step: 'x'.repeat(200) }), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });
});

describe('guardedSign: the dry mode', () => {
  it('prints the summary and stops with a DryStop, and reaches no signature, no reserve and no state', async () => {
    const rig = makeRig({ mode: 'dry' });
    const built = await pay(rig, 3_000_000n);
    const error = thrown(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error).toBeInstanceOf(DryStop);
    expect((error as DryStop).step).toBe('move');
    expect((error as DryStop).message).toMatch(/nothing was signed/);
    expectNothingSigned(rig);
    expect(existsSync(join(rig.dir, 'exposure.test-session.json'))).toBe(false);
    expect(rig.state.snapshot()).toMatchObject({ steps: {}, in_flight: null, notes: {} });
    expect(rig.evidence.entries()).toEqual([]);
    const text = rig.out.text;
    expect(text).toContain('step move: dry mode, nothing is signed or submitted');
    expect(text).toContain(`transaction: ${built.hash}`);
    expect(text).toContain('valid until: 2026-11-15T12:30:00.000Z');
    expect(text).toMatch(/3\.000000 units to the other wallet/);
    expect(text).toContain(`service key ${rig.registry.hashOf('service')}`);
    expect(text).toMatch(/net outflow of the registry: 0\.\d{6} units/);
    for (const name of ['network', 'body', 'fee', 'signers', 'inputs', 'destinations', 'outflow', 'collateral', 'mint', 'nothing_else', 'vault']) expect(text, name).toMatch(new RegExp(`ok +${name}\\b`));
  });
  it('needs no approval in the dry mode, and refuses a transaction that breaks a guard with a GuardRefusal and not a DryStop', async () => {
    const rig = makeRig({ mode: 'dry', go: null });
    const built = await pay(rig, 3_000_000n);
    expect(thrown(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor))).toBeInstanceOf(DryStop);
    const strict = moveRequest(rig.registry, { plan: planOf(rig.registry, { outflow: { service: 1_000_000n } }) });
    expect(refusal(() => guardedSign(rig.host, strict, rig.recorded)(built.cbor)).failures.map((failure) => failure.guard)).toEqual(['outflow']);
    expect(rig.out.text).toMatch(/FAIL +outflow/);
    expectNothingSigned(rig);
  });
  it('shows the notes of the request in the summary', async () => {
    const rig = makeRig({ mode: 'dry' });
    const built = await pay(rig, 3_000_000n);
    thrown(() => guardedSign(rig.host, moveRequest(rig.registry, { notes: ['the key service moves 3 units to the key other'] }), rig.recorded)(built.cbor));
    expect(rig.out.text).toContain('the key service moves 3 units to the key other');
  });
});

// ---- the submit mode ----

describe('guardedSign: the submit mode', () => {
  it('reserves the net outflow, signs with the one key, writes in_flight before it returns, and returns the hash of the body that it judged', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const signed = guardedSign(rig.host, moveRequest(rig.registry, { refs: { moved: `${built.hash}#0` }, facts: { amount: '3000000' } }), rig.recorded)(built.cbor);
    expect(signed.txHashHex).toBe(built.hash);
    const after = factsOf(signed.signedCborHex);
    expect(after.bodyHex).toBe(built.facts.bodyHex);
    expect(after.witnesses).toEqual([rig.registry.hashOf('service')]);
    expect(rig.signs).toHaveBeenCalledTimes(1);
    expect(rig.signs).toHaveBeenCalledWith(rig.registry.hashOf('service'), built.cbor);
    // In flight, as soon as the call returned: the signed bytes, the end of the validity, the time, and what the step records.
    expect(rig.state.snapshot().in_flight).toEqual({
      step: 'move', tx_hash: built.hash, signed_cbor: signed.signedCborHex, valid_to: NOW + 30 * MINUTE, signed_at: NOW, refs: { moved: `${built.hash}#0` }, facts: { amount: '3000000' },
    });
    // Reserved: a move between two wallets of the registry costs its fee.
    expect(rig.exposure.total()).toBe(built.facts.feeLovelace);
    expect(exposureEntries(rig)).toEqual([{ step: 'move', tx_hash: built.hash, net_lovelace: built.facts.feeLovelace.toString(), at: '2026-11-15T12:00:00.000Z' }]);
    expect(rig.out.text).toContain('step move: submit mode');
    expect(rig.out.text).toContain('signed by service');
  });
  it('counts a payment to an address outside the registry in full, and refuses it when the cap is below it', async () => {
    const plan = (rig: Rig): StepPlan => planOf(rig.registry, { outflow: { service: 4_000_000n }, destinations: new Set([rig.external]) });
    const tight = makeRig({ capUnits: 3 });
    const built = await pay(tight, 3_000_000n, { to: tight.external });
    const net = netRegistryOutflow(built.facts, new Map((await tight.chain.getUtxos(tight.registry.addressOf('service'))).map((utxo) => [refOf(utxo), { address: utxo.address, lovelace: utxo.assets.lovelace! }])), tight.registry.ring);
    expect(net).toBe(3_000_000n + built.facts.feeLovelace);
    const error = thrown(() => guardedSign(tight.host, moveRequest(tight.registry, { plan: plan(tight) }), tight.recorded)(built.cbor));
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).message).toMatch(/over the cap/);
    expectNothingSigned(tight);
    const wide = makeRig({ capUnits: 4 });
    const again = await pay(wide, 3_000_000n, { to: wide.external });
    guardedSign(wide.host, moveRequest(wide.registry, { plan: plan(wide) }), wide.recorded)(again.cbor);
    expect(wide.exposure.total()).toBe(3_000_000n + again.facts.feeLovelace);
  });
  it('counts a move between two wallets of the registry as its fee, so a cap below the amount takes it', async () => {
    const rig = makeRig({ capUnits: 1 });
    const built = await pay(rig, 3_000_000n);
    guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor);
    expect(rig.exposure.total()).toBe(built.facts.feeLovelace);
  });

  const BAD_APPROVALS: ReadonlyArray<readonly [string, (registry: Registry) => GoFile | null, RegExp]> = [
    ['no approval', () => null, /needs an approval file/],
    ['an approval that has expired', (registry) => goFor(registry, { expiresAt: '2026-11-15T11:59:59Z' }), /has expired/],
    ['an approval for another run wallet', (registry) => goFor(registry, { runWallet: registry.addressOf('other') }), /another run wallet/],
    ['an approval that does not list the task', (registry) => goFor(registry, { tasks: ['fund'] }), /does not list the task claim/],
  ];
  for (const [what, go, message] of BAD_APPROVALS) {
    it(`refuses with ${what}, and signs nothing; the twin with a good approval is signed`, async () => {
      const rig = makeRig();
      const bad = makeHost(rig.registry, { go: go(rig.registry) });
      const built = await pay(rig, 3_000_000n);
      const error = thrown(() => guardedSign(bad.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
      expect(error).toBeInstanceOf(ApprovalError);
      expect((error as ApprovalError).message).toMatch(message);
      expect(bad.exposure.total()).toBe(0n);
      expect(bad.state.snapshot().in_flight).toBeNull();
      expect(rig.signs).not.toHaveBeenCalled();
      expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
    });
  }
  it('refuses a step that carries a tag that the approval does not list, and signs when the approval lists it', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const error = thrown(() => guardedSign(rig.host, moveRequest(rig.registry, { irreversible: 'stake' }), rig.recorded)(built.cbor));
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).message).toMatch(/irreversible tag stake/);
    expectNothingSigned(rig);
    const listed = makeHost(rig.registry, { go: goFor(rig.registry, { irreversible: ['stake'] }) });
    expect(guardedSign(listed.host, moveRequest(rig.registry, { irreversible: 'stake' }), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });
  it('refuses to sign when the registry holds no run key, and signs when it does', async () => {
    const rig = makeRig({ need: ['service', 'other'] });
    expect(rig.registry.has('run')).toBe(false);
    const built = await pay(rig, 3_000_000n);
    const error = thrown(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).message).toMatch(/no run key exists/);
    expectNothingSigned(rig);
    const full = makeRig();
    const again = await pay(full, 3_000_000n);
    expect(guardedSign(full.host, moveRequest(full.registry), full.recorded)(again.cbor).txHashHex).toBe(again.hash);
  });

  it('refuses a plan whose signer is not the key that the transaction needs, and signs when the plan names that key', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry, { signer: 'run' }), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['signers']);
    expect(error.message).toMatch(/needs the signature of service/);
    expect(error.message).toMatch(/the plan names run/);
    expectNothingSigned(rig);
    expect(guardedSign(rig.host, moveRequest(rig.registry, { signer: 'service' }), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });
  it('refuses a plan whose signer is no key of the registry', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry, { signer: 'nobody' }), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['signers']);
    expect(error.message).toMatch(/holds no key named nobody/);
    expectNothingSigned(rig);
  });
  it('refuses a transaction that needs two keys, because the port signs with one, and signs the one that needs a single key', async () => {
    const rig = makeRig();
    const own = (await rig.recorded.getUtxos(rig.registry.addressOf('service')))[0]!;
    const other = (await rig.recorded.getUtxos(rig.registry.addressOf('run')))[0]!;
    const lucid = await lucidForAddress(rig.recorded, rig.registry.addressOf('service'));
    const built = await lucid.newTx().collectFrom([own, other]).pay.ToAddress(rig.registry.addressOf('other'), { lovelace: 3_000_000n }).validTo(NOW + 30 * MINUTE).complete();
    const request = moveRequest(rig.registry, { plan: planOf(rig.registry, { outflow: { service: 1_000_000_000n, run: 1_000_000_000n } }) });
    const error = refusal(() => guardedSign(rig.host, request, rig.recorded)(built.toCBOR()));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['signers']);
    expectNothingSigned(rig);
    const single = await pay(rig, 3_000_000n);
    expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(single.cbor).txHashHex).toBe(single.hash);
  });

  it('refuses when the signed bytes have another body than the body that it judged, and signs when they do not', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const other = await pay(rig, 4_000_000n);
    const stranger = rig.registry.ring.sign(rig.registry.hashOf('service'), other.cbor);
    rig.signs.mockClear();
    rig.signs.mockImplementationOnce(() => stranger);
    const error = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['signed_body']);
    expect(error.message).toMatch(/not the body that was judged/);
    expect(rig.state.snapshot().in_flight).toBeNull();
    expect(rig.exposure.total()).toBe(0n);
    expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
  });
  it('refuses when the signed bytes carry no witness of the signer, or the witness of another key', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    rig.signs.mockImplementationOnce((_keyHash, cbor) => cbor);
    const none = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(none.failures.map((failure) => failure.guard)).toEqual(['signed_body']);
    expect(none.message).toMatch(/witness/);
    rig.signs.mockImplementationOnce((_keyHash, cbor) => rig.registry.ring.sign(rig.registry.hashOf('run'), cbor));
    const wrong = refusal(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor));
    expect(wrong.failures.map((failure) => failure.guard)).toEqual(['signed_body']);
    expect(rig.state.snapshot().in_flight).toBeNull();
    expect(rig.exposure.total()).toBe(0n);
  });
  it('gives the reserve back when the signature fails, and returns nothing', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    rig.signs.mockImplementationOnce(() => { throw new Error('the key could not sign'); });
    expect(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor)).toThrow('the key could not sign');
    expect(rig.exposure.total()).toBe(0n);
    expect(exposureEntries(rig)).toEqual([]);
    expect(rig.state.snapshot().in_flight).toBeNull();
  });
  it('returns no signed bytes when in_flight cannot be written, and gives the reserve back', async () => {
    let broken = false;
    const rig = makeRig({ stateRename: (from, to) => { if (broken) throw new Error('the disk is full'); renameSync(from, to); } });
    const built = await pay(rig, 3_000_000n);
    broken = true;
    expect(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor)).toThrow();
    expect(rig.state.snapshot().in_flight).toBeNull();
    expect(rig.exposure.total()).toBe(0n);
    broken = false;
    expect(guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor).txHashHex).toBe(built.hash);
    expect(rig.state.snapshot().in_flight?.tx_hash).toBe(built.hash);
  });
  it('keeps the reserve when the write of in_flight failed after it replaced the state file: the next run may submit that transaction', async () => {
    let broken = false;
    const rig = makeRig({ stateRename: (from, to) => { renameSync(from, to); if (broken) throw new Error('the folder could not be flushed'); } });
    const built = await pay(rig, 3_000_000n);
    broken = true;
    expect(() => guardedSign(rig.host, moveRequest(rig.registry), rig.recorded)(built.cbor)).toThrow('the folder could not be flushed');
    // The file on disk holds the signed transaction, and the memory of the state file does not: the reserve stays, so the cap counts the transaction.
    expect(StateFile.peek(rig.state.path)?.in_flight?.tx_hash).toBe(built.hash);
    expect(rig.exposure.total()).toBe(built.facts.feeLovelace);
    expect(exposureEntries(rig).map((entry) => entry.tx_hash)).toEqual([built.hash]);
  });
  it('refuses a transaction that it signed already in the same call, also after the transaction is confirmed', async () => {
    const rig = makeRig();
    const built = await pay(rig, 3_000_000n);
    const sign = guardedSign(rig.host, moveRequest(rig.registry), rig.recorded);
    const signed = sign(built.cbor);
    rig.chain.apply(signed.signedCborHex);
    await rig.recorded.awaitTx(built.hash);
    expect(rig.recorded.confirmed(built.hash)).toBe(true);
    const error = thrown(() => sign(built.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/signed already/);
    expect(rig.signs).toHaveBeenCalledTimes(1);
  });
});

// ---- more than one transaction in one call of the kit ----

const FIRST = 3_000_000n;
const SECOND = 4_000_000n;

/** The step of a transaction of a call that signs two: the one that pays FIRST to `to` is the first, and it is a part of the step `move`. */
const pairStep = (to: string, names: { first: string; second: string } = { first: 'move:first', second: 'move' }) => (facts: TxFacts): string => (facts.outputs.some((o) => o.address === to && o.lovelace === FIRST) ? names.first : names.second);

function pairRequest(rig: Rig, over: Partial<GuardedSignRequest> = {}): GuardedSignRequest {
  return moveRequest(rig.registry, { step: pairStep(rig.registry.addressOf('other')), plan: planOf(rig.registry, { outflow: { service: 6_000_000n } }), ...over });
}

/** Signs the first transaction of a call, and lets the ledger take it, as the kit does when it submits. */
async function landFirst(rig: Rig, sign: Sign, to?: string): Promise<Built & { signed: Signed }> {
  const built = await pay(rig, FIRST, to === undefined ? {} : { to });
  const signed = sign(built.cbor);
  rig.chain.apply(signed.signedCborHex);
  return { ...built, signed };
}

/** The first transaction of a call, signed and taken by the ledger (and waited for, unless `confirmed` is false), and the second one, built and not signed. */
async function afterFirst(rig: Rig, request: GuardedSignRequest, options: { confirmed?: boolean; to?: string } = {}): Promise<{ sign: Sign; first: Built; second: Built }> {
  const sign = guardedSign(rig.host, request, rig.recorded);
  const first = await landFirst(rig, sign, options.to);
  if (options.confirmed !== false) await rig.recorded.awaitTx(first.hash);
  const second = await pay(rig, SECOND, options.to === undefined ? {} : { to: options.to });
  return { sign, first, second };
}

describe('guardedSign: a second transaction in one call of the kit', () => {
  it('refuses the second transaction while the provider did not see the wait of the first, and signs it after the wait said true: the first becomes a part', async () => {
    const refused = makeRig();
    const early = await afterFirst(refused, pairRequest(refused), { confirmed: false });
    const error = thrown(() => early.sign(early.second.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/not seen confirmed/);
    expect(refused.signs).toHaveBeenCalledTimes(1);
    expect(refused.state.snapshot().in_flight?.tx_hash).toBe(early.first.hash);
    expect(refused.state.note('part.move:first')).toBeUndefined();
    expect(exposureEntries(refused).map((entry) => entry.tx_hash)).toEqual([early.first.hash]);

    const rig = makeRig();
    const { sign, first, second } = await afterFirst(rig, pairRequest(rig));
    expect(rig.recorded.confirmed(first.hash)).toBe(true);
    const signed = sign(second.cbor);
    expect(signed.txHashHex).toBe(second.hash);
    expect(rig.state.note('part.move:first')).toMatchObject({ tx_hash: first.hash, confirmed_at: '2026-11-15T12:00:00.000Z' });
    expect(rig.state.snapshot().in_flight).toMatchObject({ step: 'move', tx_hash: second.hash, signed_cbor: signed.signedCborHex });
    expect(rig.state.snapshot().steps).toEqual({});
    expect(exposureEntries(rig).map((entry) => entry.tx_hash)).toEqual([first.hash, second.hash]);
    expect(rig.exposure.total()).toBe(first.facts.feeLovelace + second.facts.feeLovelace);
    expect(rig.signs).toHaveBeenCalledTimes(2);
  });
  it('refuses the second transaction when the wait of the first said false', async () => {
    const rig = makeRig();
    rig.chain.confirms = false;
    const { sign, first, second } = await afterFirst(rig, pairRequest(rig));
    expect(rig.recorded.confirmed(first.hash)).toBe(false);
    expect(thrown(() => sign(second.cbor))).toBeInstanceOf(PreconditionError);
    expect(rig.state.note('part.move:first')).toBeUndefined();
    expect(rig.state.snapshot().in_flight?.tx_hash).toBe(first.hash);
  });
  it('refuses the second transaction when the step of the first has no colon, and signs it when the step has one', async () => {
    const refused = makeRig();
    const plain = pairRequest(refused, { step: pairStep(refused.registry.addressOf('other'), { first: 'move', second: 'move:second' }) });
    const { sign, first, second } = await afterFirst(refused, plain);
    const error = thrown(() => sign(second.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/no colon/);
    expect(refused.state.snapshot().in_flight?.tx_hash).toBe(first.hash);
    expect(refused.state.snapshot().notes).toEqual({});
    expect(refused.state.snapshot().steps).toEqual({});
    expect(refused.signs).toHaveBeenCalledTimes(1);

    const rig = makeRig();
    const named = pairRequest(rig, { step: pairStep(rig.registry.addressOf('other'), { first: 'move:first', second: 'move:second' }) });
    const twin = await afterFirst(rig, named);
    expect(twin.sign(twin.second.cbor).txHashHex).toBe(twin.second.hash);
  });
  it('refuses the second transaction when it has the step name of the first, and signs it with another name', async () => {
    const refused = makeRig();
    const same = pairRequest(refused, { step: 'move:first' });
    const { sign, first, second } = await afterFirst(refused, same);
    const error = thrown(() => sign(second.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/used by an earlier transaction of this call/);
    expect(refused.state.snapshot().in_flight?.tx_hash).toBe(first.hash);
    expect(refused.state.snapshot().notes).toEqual({});
  });
  it('refuses a transaction while a transaction of another run is in flight, and signs when none is', async () => {
    const refused = makeRig();
    refused.state.setInFlight({ step: 'older', tx_hash: 'ee'.repeat(32), signed_cbor: 'aa', valid_to: NOW + MINUTE, signed_at: NOW, refs: {}, facts: {} });
    const built = await pay(refused, FIRST);
    const error = thrown(() => guardedSign(refused.host, pairRequest(refused), refused.recorded)(built.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/settle it first/);
    expect(refused.signs).not.toHaveBeenCalled();
    expect(refused.exposure.total()).toBe(0n);
    expect(refused.state.snapshot().in_flight?.step).toBe('older');

    const rig = makeRig();
    const again = await pay(rig, FIRST);
    expect(guardedSign(rig.host, pairRequest(rig), rig.recorded)(again.cbor).txHashHex).toBe(again.hash);
  });
  it('refuses a transaction while a transaction of another call of this run is in flight, even when it is confirmed, and lets the call that signed it go on', async () => {
    const rig = makeRig();
    const { sign, second } = await afterFirst(rig, pairRequest(rig));
    const stranger = guardedSign(rig.host, pairRequest(rig), rig.recorded);
    const error = thrown(() => stranger(second.cbor));
    expect(error).toBeInstanceOf(PreconditionError);
    expect((error as PreconditionError).message).toMatch(/settle it first/);
    expect(rig.signs).toHaveBeenCalledTimes(1);
    expect(sign(second.cbor).txHashHex).toBe(second.hash);
  });
  it('refuses the second transaction when the cap is below it, and keeps the reserve of the first and the first in flight; a wider cap takes both', async () => {
    const plan = (rig: Rig): StepPlan => planOf(rig.registry, { outflow: { service: 6_000_000n }, destinations: new Set([rig.external]) });
    const tight = makeRig({ capUnits: 5 });
    const request = (rig: Rig): GuardedSignRequest => pairRequest(rig, { step: pairStep(rig.external), plan: plan(rig) });
    const early = await afterFirst(tight, request(tight), { to: tight.external });
    expect(tight.exposure.total()).toBe(FIRST + early.first.facts.feeLovelace);
    const error = thrown(() => early.sign(early.second.cbor));
    expect(error).toBeInstanceOf(ApprovalError);
    expect((error as ApprovalError).message).toMatch(/over the cap/);
    expect(tight.signs).toHaveBeenCalledTimes(1);
    expect(exposureEntries(tight).map((entry) => entry.tx_hash)).toEqual([early.first.hash]);
    expect(tight.state.snapshot().in_flight?.tx_hash).toBe(early.first.hash);
    expect(tight.state.note('part.move:first')).toBeUndefined();

    const wide = makeRig({ capUnits: 8 });
    const both = await afterFirst(wide, request(wide), { to: wide.external });
    both.sign(both.second.cbor);
    expect(wide.exposure.total()).toBe(FIRST + both.first.facts.feeLovelace + SECOND + both.second.facts.feeLovelace);
  });
  it('judges each transaction by the plan of its own bytes: the plan of the first does not cover the second', async () => {
    const rig = makeRig();
    const other = rig.registry.addressOf('other');
    const byBytes = (secondLimit: bigint): GuardedSignRequest => pairRequest(rig, {
      plan: (facts) => planOf(rig.registry, { outflow: { service: facts.outputs.some((o) => o.address === other && o.lovelace === FIRST) ? 4_000_000n : secondLimit } }),
    });
    const strict = await afterFirst(rig, byBytes(1_000_000n));
    const error = refusal(() => strict.sign(strict.second.cbor));
    expect(error.failures.map((failure) => failure.guard)).toEqual(['outflow']);
    expect(rig.signs).toHaveBeenCalledTimes(1);
    expect(rig.state.snapshot().in_flight?.tx_hash).toBe(strict.first.hash);
    const loose = makeRig();
    const twin = await afterFirst(loose, pairRequest(loose, {
      plan: (facts) => planOf(loose.registry, { outflow: { service: facts.outputs.some((o) => o.address === loose.registry.addressOf('other') && o.lovelace === FIRST) ? 4_000_000n : 5_000_000n } }),
    }));
    expect(twin.sign(twin.second.cbor).txHashHex).toBe(twin.second.hash);
  });
});

describe('recordKitLanding', () => {
  it('records the step, clears the transaction in flight, and writes the evidence entry; the part of the first stays', async () => {
    const rig = makeRig();
    const { sign, first, second } = await afterFirst(rig, pairRequest(rig));
    sign(second.cbor);
    rig.chain.apply(rig.signs.mock.results[1]!.value as string);
    await rig.recorded.awaitTx(second.hash);
    recordKitLanding(rig.host, { step: 'move', txHash: second.hash, refs: { moved: `${second.hash}#0` }, facts: { amount: '4000000' }, shows: { amount: SECOND, parts: 2 } });
    expect(rig.state.step('move')).toMatchObject({ tx_hash: second.hash, refs: { moved: `${second.hash}#0` }, facts: { amount: '4000000' }, confirmed_at: '2026-11-15T12:00:00.000Z', verified_at: null });
    expect(rig.state.snapshot().in_flight).toBeNull();
    expect(rig.state.note('part.move:first')).toMatchObject({ tx_hash: first.hash });
    expect(rig.evidence.entries()).toEqual([expect.objectContaining({ step: 'move', status: 'confirmed', tx_hash: second.hash, shows: { amount: '4000000', parts: 2 } })]);
  });
  it('refuses to record a transaction other than the one in flight, and records it when it is the one', async () => {
    const rig = makeRig();
    const { sign, first, second } = await afterFirst(rig, pairRequest(rig));
    sign(second.cbor);
    const wrong = thrown(() => recordKitLanding(rig.host, { step: 'move', txHash: first.hash, refs: {}, facts: {}, shows: {} }));
    expect(wrong).toBeInstanceOf(PreconditionError);
    expect(rig.state.snapshot().in_flight?.tx_hash).toBe(second.hash);
    expect(rig.state.snapshot().steps).toEqual({});
    expect(rig.evidence.entries()).toEqual([]);
    recordKitLanding(rig.host, { step: 'move', txHash: second.hash, refs: {}, facts: {}, shows: {} });
    expect(rig.state.confirmed('move')).toBe(true);
  });
  it('records a step with a colon as a part, and records a step when nothing is in flight', () => {
    const rig = makeRig();
    recordKitLanding(rig.host, { step: 'move:first', txHash: 'aa'.repeat(32), refs: {}, facts: {}, shows: {} });
    expect(rig.state.note('part.move:first')).toMatchObject({ tx_hash: 'aa'.repeat(32) });
    expect(rig.state.snapshot().steps).toEqual({});
    recordKitLanding(rig.host, { step: 'move', txHash: 'bb'.repeat(32), refs: { a: 'b' }, facts: {}, shows: {} });
    expect(rig.state.step('move')).toMatchObject({ tx_hash: 'bb'.repeat(32), refs: { a: 'b' } });
    expect(rig.evidence.entries()).toHaveLength(2);
  });
  it('leaves the last transaction in flight when the task dies before it records the step, and the next run settles it as the same step', async () => {
    const rig = makeRig();
    const { sign, first, second } = await afterFirst(rig, pairRequest(rig, { refs: { moved: 'the plan has no reference of the output' } }));
    sign(second.cbor);
    const node: NodeAccess = {
      networkFacts: async () => { throw new Error('the settle reads no network facts'); }, networkTip: async () => { throw new Error('the settle reads no tip'); }, resolveInputs: async () => [], submit: async () => '', txStatus: async () => ({ confirmations: 1 }),
    };
    const settled = await settleInFlight({ state: rig.state, node, clock: rig.clock, out: () => undefined, mode: 'submit', awaitMs: 1000, pollMs: 100 });
    expect(settled).toEqual({ kind: 'recorded', step: 'move', txHash: second.hash });
    expect(rig.state.step('move')).toMatchObject({ tx_hash: second.hash, refs: { moved: 'the plan has no reference of the output' } });
    expect(rig.state.note('part.move:first')).toMatchObject({ tx_hash: first.hash });
    expect(rig.state.snapshot().in_flight).toBeNull();
  });
});

// ---- the real chain port of the kit ----

const SLOW = 120_000;
const CLAIM_STAKE = 50_000_000n;
const RUN_CLAIM: RunClaimInput = {
  capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, stake_lovelace: CLAIM_STAKE, challenge_window_ms: 24 * HOUR, claim_type: 'service-quality',
};

/** The claim transaction makes an output at the claim script of Module-1. The claim document makes none. */
const isClaim = (facts: TxFacts): boolean => facts.outputs.some((output) => output.address === MODULE1.claim.address);

function claimPlan(registry: Registry, facts: TxFacts): StepPlan {
  return {
    maxFeeLovelace: 2_000_000n, maxOutflow: { [registry.hashOf('service')]: CLAIM_STAKE + 2_000_000n }, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set([MODULE1.claim.address]),
    mint: Object.fromEntries(Object.entries(facts.mint).filter(([unit, quantity]) => unit.startsWith(MODULE1.claim.hash) && quantity === 1n)), labels: { [MODULE1.claim.address]: 'the claim script' },
  };
}

function claimRequest(registry: Registry, over: Partial<GuardedSignRequest> = {}): GuardedSignRequest {
  return {
    step: (facts) => (isClaim(facts) ? 'claim' : 'claim:document'), plan: (facts) => (isClaim(facts) ? claimPlan(registry, facts) : planOf(registry, { outflow: { service: 1_000_000n } })), signer: 'service',
    facts: { claim_type: RUN_CLAIM.claim_type }, notes: ['the service key stakes the claim of a run'], ...over,
  };
}

interface Kit extends HostParts {
  readonly ledger: LedgerProvider;
  readonly recorded: LedgerProvider & Recorder;
  readonly dispute: Dispute;
  /** The errors that the guarded signer threw, in order: the kit turns each into the text of a refusal, so the task reads the cause here. */
  readonly stops: Error[];
}

/** The real chain port of the kit, over the ledger of the kit tests, with the guarded signer as its `sign` and the recording provider as its provider. */
function makeKit(options: HostOptions = {}, request?: (registry: Registry) => GuardedSignRequest, recorderOf?: (recorded: Recorder) => Recorder): Kit {
  const registry = registryOf({ service: '0b'.repeat(32) });
  expect(registry.addressOf('service')).toBe(WALLET_ADDRESS);
  const parts = makeHost(registry, options);
  const ledger = ledgerWorld();
  const recorded = recordingProvider(ledger);
  const stops: Error[] = [];
  const inner = guardedSign(parts.host, request === undefined ? claimRequest(registry) : request(registry), recorderOf === undefined ? recorded : recorderOf(recorded));
  const sign: Sign = (unsignedCborHex) => {
    try { return inner(unsignedCborHex); } catch (err) {
      if (err instanceof Error) stops.push(err);
      throw err;
    }
  };
  const port = realPort(ledger, CLAIMER_ID, NOW, { provider: recorded, sign });
  const dispute = new Dispute({ port, queue: new HireLane(), clock: () => NOW, sleep: forever, settings: DISPUTE_SETTINGS });
  return { ...parts, ledger, recorded, dispute, stops };
}

function staked(result: RunClaimResult): Extract<RunClaimResult, { ok: true }>['value'] {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

describe('the real chain port of the kit, with the claim of a run', () => {
  it('in the dry mode builds the claim document and stops at its signature with a DryStop: the kit says that the document is not built', async () => {
    const kit = makeKit({ mode: 'dry' });
    const result = await kit.dispute.stakeRunClaim(RUN_CLAIM);
    expect(result).toMatchObject({ ok: false, code: 'claim_document_not_built', document: null, sent: null });
    if (result.ok) throw new Error('the dry run staked a claim');
    expect(result.detail).toMatch(/dry run/);
    expect(result.detail).toMatch(/nothing was signed/);
    expect(kit.stops).toHaveLength(1);
    expect(kit.stops[0]).toBeInstanceOf(DryStop);
    expect((kit.stops[0] as DryStop).step).toBe('claim:document');
    expect(kit.ledger.accepted).toEqual([]);
    expectNothingSigned(kit);
    expect(kit.state.snapshot()).toMatchObject({ steps: {}, notes: {} });
    expect(kit.out.text).toContain('step claim:document: dry mode, nothing is signed or submitted');
    expect(kit.out.text).toContain('the service key stakes the claim of a run');
  }, SLOW);
  it('signs both transactions, records the document as a part when it signs the claim, and keeps the claim in flight until the task records the step', async () => {
    const kit = makeKit();
    const value = staked(await kit.dispute.stakeRunClaim(RUN_CLAIM));
    const [documentTx, claimTx] = kit.ledger.accepted;
    expect(kit.ledger.accepted).toHaveLength(2);
    expect(value.document.tx_hash).toBe(documentTx);
    expect(value.claim_tx).toBe(claimTx);
    expect(kit.stops).toEqual([]);
    expect(kit.signs).toHaveBeenCalledTimes(2);
    for (const raw of kit.ledger.raw) expect(factsOf(raw).witnesses).toEqual([kit.registry.hashOf('service')]);
    // The document is a part of the step claim, kept as a note, and the claim is in flight: the state file holds one transaction in flight.
    expect(kit.state.note('part.claim:document')).toMatchObject({ tx_hash: documentTx });
    expect(kit.state.snapshot().in_flight).toMatchObject({ step: 'claim', tx_hash: claimTx, refs: {}, facts: { claim_type: 'service-quality' } });
    expect(kit.state.snapshot().steps).toEqual({});
    // The cap holds both reserves: the fee of the document, and the stake and the fee of the claim.
    const entries = exposureEntries(kit);
    expect(entries.map((entry) => [entry.step, entry.tx_hash])).toEqual([['claim:document', documentTx], ['claim', claimTx]]);
    const documentFee = factsOf(kit.ledger.raw[0]!).feeLovelace;
    const claimFee = factsOf(kit.ledger.raw[1]!).feeLovelace;
    expect(BigInt(entries[0]!.net_lovelace)).toBe(documentFee);
    const claimNet = BigInt(entries[1]!.net_lovelace);
    expect(claimNet >= CLAIM_STAKE + claimFee).toBe(true);
    expect(claimNet <= CLAIM_STAKE + claimFee + 5_000_000n).toBe(true);
    expect(kit.exposure.total()).toBe(documentFee + claimNet);
    // The task records the step after the kit returned: the step is confirmed, and nothing is in flight any more.
    recordKitLanding(kit.host, {
      step: 'claim', txHash: value.claim_tx, refs: { claim: value.claim }, facts: { claim_token: value.claim_token },
      shows: { claim: value.claim, document: value.document.tx_hash, stake_lovelace: value.stake_lovelace },
    });
    expect(kit.state.step('claim')).toMatchObject({ tx_hash: claimTx, refs: { claim: value.claim }, facts: { claim_token: value.claim_token } });
    expect(kit.state.snapshot().in_flight).toBeNull();
    expect(kit.state.note('part.claim:document')).toMatchObject({ tx_hash: documentTx });
    expect(kit.evidence.entries()).toEqual([expect.objectContaining({ step: 'claim', status: 'confirmed', tx_hash: claimTx })]);
  }, SLOW);
  it('does not build the claim when the wait for the document says that it is not confirmed: the document stays in flight and the claim is never signed', async () => {
    const kit = makeKit();
    kit.ledger.confirms = false;
    const result = await kit.dispute.stakeRunClaim(RUN_CLAIM);
    expect(result).toMatchObject({ ok: false, code: 'claim_document_not_confirmed' });
    expect(kit.signs).toHaveBeenCalledTimes(1);
    expect(kit.ledger.accepted).toHaveLength(1);
    expect(kit.recorded.confirmed(kit.ledger.accepted[0]!)).toBe(false);
    expect(kit.state.snapshot().in_flight).toMatchObject({ step: 'claim:document', tx_hash: kit.ledger.accepted[0] });
    expect(kit.state.note('part.claim:document')).toBeUndefined();
    expect(exposureEntries(kit)).toHaveLength(1);
    expect(kit.stops).toEqual([]);
  }, SLOW);
  it('refuses the claim when the cap is below its net outflow: the document is on the ledger, its reserve stays, and the claim is not signed', async () => {
    const kit = makeKit({ capUnits: 1 });
    const result = await kit.dispute.stakeRunClaim(RUN_CLAIM);
    expect(result).toMatchObject({ ok: false, code: 'claim_not_built' });
    if (result.ok) throw new Error('the claim was staked over the cap');
    expect(result.detail).toMatch(/over the cap/);
    expect(result.document).not.toBeNull();
    expect(kit.stops).toHaveLength(1);
    expect(kit.stops[0]).toBeInstanceOf(ApprovalError);
    expect(kit.ledger.accepted).toHaveLength(1);
    expect(kit.signs).toHaveBeenCalledTimes(1);
    expect(exposureEntries(kit)).toHaveLength(1);
    expect(kit.state.snapshot().in_flight).toMatchObject({ step: 'claim:document', tx_hash: kit.ledger.accepted[0] });
    expect(kit.state.note('part.claim:document')).toBeUndefined();
  }, SLOW);
  it('judges the claim by the plan of its own bytes: a plan that does not name what the claim mints refuses it, and the document is judged by its own plan', async () => {
    const kit = makeKit({}, (registry) => claimRequest(registry, { plan: (facts) => (isClaim(facts) ? { ...claimPlan(registry, facts), mint: {} } : planOf(registry, { outflow: { service: 1_000_000n } })) }));
    const result = await kit.dispute.stakeRunClaim(RUN_CLAIM);
    expect(result).toMatchObject({ ok: false, code: 'claim_not_built' });
    expect(kit.stops).toHaveLength(1);
    expect(kit.stops[0]).toBeInstanceOf(GuardRefusal);
    expect((kit.stops[0] as GuardRefusal).failures.map((failure) => failure.guard)).toEqual(['mint']);
    expect(kit.ledger.accepted).toHaveLength(1);
    expect(kit.signs).toHaveBeenCalledTimes(1);
  }, SLOW);
  it('looks up the collateral inputs of the claim in the record too: the claim is refused when the last read of its collateral input is unknown, and signed when every read is known', async () => {
    // The probe is the twin: it signs the claim and shows which output the claim names as its collateral. The world is the same each time, so the second run builds the same claim.
    const probe = makeKit();
    staked(await probe.dispute.stakeRunClaim(RUN_CLAIM));
    const claim = factsOf(probe.ledger.raw[1]!);
    const collateral = claim.collateralInputs[0]!;
    expect(collateral).toMatch(/^[0-9a-f]{64}#\d+$/);
    // The signer looks up the spent inputs, and then the collateral inputs. This record knows the output at every lookup but the last one of the collateral output: so it is the collateral that no read gave.
    const lookups = [...claim.inputs, ...claim.collateralInputs].filter((ref) => ref === collateral).length;
    let reads = 0;
    const kit = makeKit({}, undefined, (recorded) => ({
      seen: (ref) => {
        if (ref !== collateral) return recorded.seen(ref);
        reads += 1;
        return reads === lookups ? undefined : recorded.seen(ref);
      },
      confirmed: (txHash) => recorded.confirmed(txHash),
    }));
    const result = await kit.dispute.stakeRunClaim(RUN_CLAIM);
    expect(result).toMatchObject({ ok: false, code: 'claim_not_built' });
    expect(kit.stops).toHaveLength(1);
    const stop = kit.stops[0];
    expect(stop).toBeInstanceOf(GuardRefusal);
    expect((stop as GuardRefusal).failures.map((failure) => failure.guard)).toEqual(['inputs']);
    expect((stop as GuardRefusal).message).toContain(collateral);
    expect(kit.out.text).toContain('collateral inputs (1):');
    expect(kit.ledger.accepted).toHaveLength(1);
    expect(kit.signs).toHaveBeenCalledTimes(1);
    expect(kit.state.snapshot().steps).toEqual({});
  }, SLOW);
});
