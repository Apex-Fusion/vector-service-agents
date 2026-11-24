// The consent of Module-1 in a registration. A record with a Module-1 party has ONE withdrawal: the consent. The guard `nothing_else` counts withdrawals and reads neither the reward account nor
// the amount, so `checkConsentWithdrawal` reads both: the withdrawal must be from the reward account of Module-1 (the hash in the configuration record of the deployment), for the WHOLE balance
// of that account (the ledger refuses any other amount, and anybody can pay into the account). A record with no Module-1 party must have no withdrawal. The registrations here are built by the
// real builder over the identity fixtures, and the tests change the world after the build, as a payment into the account would. Each refusal has an accepted twin.
import { createRequire } from 'node:module';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { GuardRefusal, NetworkGate } from '../../checks/lib/land.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { DEPLOYMENT, NOW, keyOf, seedHex } from '../../checks/test/support/world.ts';
import { buildRegister } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import type { PartySpec, RegisterBuild } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { module1RewardAddress } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { M1 } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import { Exposure } from '../lib/approval.ts';
import type { GoFile } from '../lib/approval.ts';
import { checkConsentWithdrawal } from '../lib/consent.ts';
import type { LandHost, OperatorSettings } from '../lib/contract.ts';
import { landHosted } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { lucidForAddress } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { FakeClock, FakeNode, MemoryOutput, ThrowingSigner, World } from './support/fakes.ts';
import { makeKeyRoot, removeTestKeys, writeSeed } from './support/keys.ts';
import { PackHosted, liveBuildAnswer } from './support/pack-hosted.ts';
import type { LiveBuild } from './support/pack-hosted.ts';

// ---- the world ----

/** The keys of the tests, each with the number of the wallet of the world that has the same key: a registry key and a wallet of the world are one key. */
const N = { controller: 1, fee: 4, accountable: 5, provider: 6, listed: 7, run: 9 } as const;
type KeyName = keyof typeof N;
const NAMES = Object.keys(N) as KeyName[];
const USE_CASE = 'test-use-case';
const FEE_LIMIT = 2_000_000n;
/** The hash of another Module-1 script, and a reward account that is not the one of Module-1. */
const OTHER_HASH = 'ee'.repeat(28);
const REWARDS = 7_000_000n;

const folders: string[] = [];
afterAll(() => {
  removeTestKeys();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** The reward account of Module-1 as the node answers for it, and every read of it. A test changes the members after the build. */
interface Account { rewards: bigint; registered: boolean; fails: Error | null; reads: Array<{ hash: string; address: string }> }

/** A world with the identity fixtures, the wallets of the keys, and a node that reads reward accounts (the fixtures world does not). */
async function world(over: Partial<Account> = {}): Promise<{ world: World; account: Account }> {
  const world = await World.identity({ wallets: [{ n: N.fee }, { n: N.run }] });
  const account: Account = { rewards: REWARDS, registered: true, fails: null, reads: [], ...over };
  Object.assign(world.chain, {
    getRewardAccount: async (credential: { type: string; hash: string }, address: string) => {
      account.reads.push({ hash: credential.hash, address });
      if (account.fails !== null) throw account.fails;
      return account.registered ? { registered: true, rewards: account.rewards, source: 'ogmios' } : { registered: false, source: 'koios' };
    },
  });
  return { world, account };
}

/** A registration that the real builder makes: the Accountable key, a listed key, and Module-1 as the Responsible party, or the Provider key when `module1` is false. */
async function register(w: World, module1: boolean): Promise<RegisterBuild> {
  const key = (name: KeyName) => keyOf(N[name]);
  const party = (over: Partial<PartySpec>): PartySpec => ({ role: 'Accountable', signer: { type: 'ControllerSet' }, organisation: null, notAfter: null, rights: 3, removalAfter: null, ...over });
  const parties: PartySpec[] = [
    party({ signer: { type: 'KeyHash', hash: key('accountable').keyHash } }),
    module1 ? party({ role: 'Responsible', signer: { type: 'Script', hash: M1 }, rights: 1 }) : party({ role: 'Provider', signer: { type: 'KeyHash', hash: key('provider').keyHash }, rights: 0 }),
  ];
  const lucid = await lucidForAddress(w.chain, key('fee').address);
  return buildRegister({ lucid, provider: w.chain, deployment: DEPLOYMENT }, {
    changeAddress: key('fee').address, nowMs: NOW, controller: key('controller').publicKeyHex, parties, name: utf8Hex('Consent Agent'), capabilities: [utf8Hex('demo.text.stats.v1')],
    keys: [{ keyType: 'Ed25519', key: key('listed').publicKeyHex, purposes: 9, pop: null }],
  });
}

// ---- the body of a transaction, changed with the CML API ----

interface CmlRewardAddress { to_address(): { to_bech32(): string } }
interface CmlWithdrawals { len(): number; keys(): { len(): number; get(index: number): CmlRewardAddress }; get(key: CmlRewardAddress): bigint | undefined; insert(key: CmlRewardAddress, value: bigint): bigint | undefined }
interface CmlBody { withdrawals(): CmlWithdrawals | undefined; set_withdrawals(map: CmlWithdrawals): void }
interface CmlTransaction { body(): CmlBody; witness_set(): unknown; is_valid(): boolean; auxiliary_data(): unknown; to_cbor_hex(): string }
interface Cml {
  Transaction: { from_cbor_hex(hex: string): CmlTransaction; 'new'(body: CmlBody, witnesses: unknown, valid: boolean, auxiliary: unknown): CmlTransaction };
  MapRewardAccountToCoin: { 'new'(): CmlWithdrawals };
  RewardAddress: { 'new'(network: number, credential: unknown): CmlRewardAddress };
  Credential: { new_script(hash: unknown): unknown };
  ScriptHash: { from_hex(hex: string): unknown };
}
/** CML, from the place of buyer-core: the version that buyer-core pins. The tests of the pack name no package of their own. The module is typed by the parts of CML that these tests call. */
const lucidModule = createRequire(fileURLToPath(new URL('../../../packages/buyer-core/package.json', import.meta.url)))('@lucid-evolution/lucid') as { CML: Cml };
const { CML } = lucidModule;

interface Withdrawal { hash: string; lovelace: bigint }

/** The same transaction with exactly these withdrawals, each from the reward account of a script hash (network 1). The rest of the body stays as it was. */
function withdrawing(cbor: string, entries: readonly Withdrawal[]): string {
  const transaction = CML.Transaction.from_cbor_hex(cbor);
  const body = transaction.body();
  const map = CML.MapRewardAccountToCoin.new();
  for (const entry of entries) map.insert(CML.RewardAddress.new(1, CML.Credential.new_script(CML.ScriptHash.from_hex(entry.hash))), entry.lovelace);
  body.set_withdrawals(map);
  return CML.Transaction.new(body, transaction.witness_set(), transaction.is_valid(), transaction.auxiliary_data()).to_cbor_hex();
}

/** The withdrawals of a transaction: the reward address and the amount of each. */
function withdrawalsOf(cbor: string): Array<{ address: string; lovelace: bigint }> {
  const map = CML.Transaction.from_cbor_hex(cbor).body().withdrawals();
  const found: Array<{ address: string; lovelace: bigint }> = [];
  for (let at = 0; map !== undefined && at < map.keys().len(); at += 1) {
    const key = map.keys().get(at);
    found.push({ address: key.to_address().to_bech32(), lovelace: map.get(key) ?? 0n });
  }
  return found;
}

const REWARD_ADDRESS = module1RewardAddress(M1);
const OTHER_ADDRESS = module1RewardAddress(OTHER_HASH);
/** The consent that the builder makes: one withdrawal from the account of Module-1, for the balance that the node showed at the build. */
const CONSENT: Withdrawal = { hash: M1, lovelace: REWARDS };

const check = (w: World, cbor: string, expectModule1: boolean, step = 'reorder-agent') => checkConsentWithdrawal({ step, unsignedCbor: cbor, provider: w.chain, deployment: DEPLOYMENT, expectModule1 });
const refusal = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error('the call did not refuse'); }, (err: unknown) => err);
/** The failures of a refusal: the guard and the message of each. */
const failuresOf = (err: unknown): Array<{ guard: string; message: string }> => (err as GuardRefusal).failures.map(({ guard, message }) => ({ guard, message }));

describe('the builder and the helpers of these tests', () => {
  it('build a registration with Module-1 that holds one withdrawal of the whole balance from the reward account of Module-1, and one without Module-1 that holds none', async () => {
    const { world: w } = await world();
    const consent = await register(w, true);
    expect(withdrawalsOf(consent.txCbor)).toEqual([{ address: REWARD_ADDRESS, lovelace: REWARDS }]);
    expect(withdrawalsOf((await register(w, false)).txCbor)).toEqual([]);
    expect(withdrawalsOf(withdrawing(consent.txCbor, [CONSENT, { hash: OTHER_HASH, lovelace: 1n }]))).toEqual([{ address: REWARD_ADDRESS, lovelace: REWARDS }, { address: OTHER_ADDRESS, lovelace: 1n }]);
    expect(factsOf(withdrawing(consent.txCbor, [])).withdrawals).toBe(0);
  });
});

describe('checkConsentWithdrawal: a record with a Module-1 party', () => {
  it('passes the registration that the builder made: one withdrawal, from the reward account of Module-1, for the whole balance, and reads the account of Module-1 and no other', async () => {
    const { world: w, account } = await world();
    const built = await register(w, true);
    account.reads.length = 0;
    await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
    expect(account.reads).toEqual([{ hash: M1, address: REWARD_ADDRESS }]);
  });
  it('passes a whole balance of nothing and a whole balance of many units, because the amount is the balance that the node shows now', async () => {
    for (const rewards of [0n, 1n, 123_456_789n]) {
      const { world: w } = await world({ rewards });
      await expect(check(w, (await register(w, true)).txCbor, true), String(rewards)).resolves.toBeUndefined();
    }
  });
  it('refuses a body with no withdrawal where Module-1 is a party, with the guard nothing_else, and passes the same body when the record has no Module-1 party', async () => {
    const { world: w } = await world();
    const none = (await register(w, false)).txCbor;
    const err = await refusal(check(w, none, true));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(failuresOf(err)).toEqual([{ guard: 'nothing_else', message: expect.stringContaining('Module-1 is a party') }]);
    expect((err as GuardRefusal).message).toContain('has no withdrawal');
    expect((err as GuardRefusal).step).toBe('reorder-agent');
    await expect(check(w, none, false)).resolves.toBeUndefined();
  });
  it('refuses two withdrawals, also when the first is the consent that the builder made, and passes the one withdrawal', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    const two = withdrawing(built.txCbor, [CONSENT, { hash: OTHER_HASH, lovelace: 1n }]);
    const err = await refusal(check(w, two, true));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(failuresOf(err)).toEqual([{ guard: 'nothing_else', message: expect.stringContaining('2 withdrawals') }]);
    const same = withdrawing(built.txCbor, [CONSENT, { hash: M1, lovelace: REWARDS }]);
    expect(withdrawalsOf(same)).toHaveLength(1);
    await expect(check(w, same, true)).resolves.toBeUndefined();
    await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
  });
  it('refuses a withdrawal from another reward account, names the expected and the found address, and reads no account', async () => {
    const { world: w, account } = await world();
    const built = await register(w, true);
    const other = withdrawing(built.txCbor, [{ hash: OTHER_HASH, lovelace: REWARDS }]);
    account.reads.length = 0;
    const err = await refusal(check(w, other, true));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(failuresOf(err)).toEqual([{ guard: 'nothing_else', message: expect.stringContaining(OTHER_ADDRESS) }]);
    expect(failuresOf(err)[0]!.message).toContain(REWARD_ADDRESS);
    expect(account.reads).toEqual([]);
    await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
  });
  it('refuses the consent that the builder made when the configuration record names another Module-1 hash, as the body then withdraws from a reward account that is not the one of Module-1', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    w.chain.held = w.chain.held.map((utxo) => (utxo.address === DEPLOYMENT.configHolder.address ? { ...utxo, datum: `581c${OTHER_HASH}` } : utxo));
    const err = await refusal(check(w, built.txCbor, true));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(failuresOf(err)[0]!.guard).toBe('nothing_else');
    expect(failuresOf(err)[0]!.message).toContain(OTHER_ADDRESS);
    expect(failuresOf(err)[0]!.message).toContain(REWARD_ADDRESS);
    // The twin: the configuration record names the hash of the build, and the body passes.
    const twin = await world();
    await expect(check(twin.world, (await register(twin.world, true)).txCbor, true)).resolves.toBeUndefined();
  });
  for (const [label, balance, phrase] of [
    ['below the balance, when a payment into the account raised the balance after the build', REWARDS + 1n, 'whole balance'],
    ['below the balance by a large payment', REWARDS * 10n, 'whole balance'],
    ['above the balance, when the balance fell after the build', REWARDS - 1n, 'whole balance'],
    ['above the balance of nothing', 0n, 'whole balance'],
  ] as const) {
    it(`refuses an amount ${label}, and names both amounts in lovelace`, async () => {
      const { world: w, account } = await world();
      const built = await register(w, true);
      account.rewards = balance;
      const err = await refusal(check(w, built.txCbor, true));
      expect(err).toBeInstanceOf(GuardRefusal);
      expect(failuresOf(err)).toEqual([{ guard: 'nothing_else', message: expect.stringContaining(phrase) }]);
      expect(failuresOf(err)[0]!.message).toContain(`${REWARDS} lovelace`);
      expect(failuresOf(err)[0]!.message).toContain(`${balance} lovelace`);
      account.rewards = REWARDS;
      await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
    });
  }
  it('refuses a body whose amount is not the balance when the amount is changed in the body, and not in the world', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    for (const lovelace of [REWARDS - 1n, REWARDS + 1n, 1n]) {
      const err = await refusal(check(w, withdrawing(built.txCbor, [{ hash: M1, lovelace }]), true));
      expect(err, String(lovelace)).toBeInstanceOf(GuardRefusal);
      expect(failuresOf(err)[0]!.message).toContain(`${lovelace} lovelace`);
    }
    await expect(check(w, withdrawing(built.txCbor, [{ hash: M1, lovelace: REWARDS }]), true)).resolves.toBeUndefined();
  });
});

describe('checkConsentWithdrawal: what cannot be read is a precondition, and never a pass', () => {
  it('stops with a PreconditionError when the reward account of Module-1 is not registered, and passes when it is', async () => {
    const { world: w, account } = await world();
    const built = await register(w, true);
    account.registered = false;
    const err = await refusal(check(w, built.txCbor, true));
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err).not.toBeInstanceOf(GuardRefusal);
    expect((err as Error).message).toContain('not registered');
    expect((err as Error).message).toContain(REWARD_ADDRESS);
    account.registered = true;
    await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
  });
  it('stops with a PreconditionError when the read of the account fails, and names the failure without more', async () => {
    const { world: w, account } = await world();
    const built = await register(w, true);
    account.fails = new Error('Koios request failed (account_info): 503 Service Unavailable');
    const err = await refusal(check(w, built.txCbor, true));
    expect(err).toBeInstanceOf(PreconditionError);
    expect((err as Error).message).toContain('could not be read');
    expect((err as Error).message).toContain('503 Service Unavailable');
    account.fails = null;
    await expect(check(w, built.txCbor, true)).resolves.toBeUndefined();
  });
  it('stops with a PreconditionError when the node of the run cannot read a reward account at all', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    Object.assign(w.chain, { getRewardAccount: undefined });
    const err = await refusal(check(w, built.txCbor, true));
    expect(err).toBeInstanceOf(PreconditionError);
    expect((err as Error).message).toContain('cannot read a reward account');
  });
  it('stops with a PreconditionError when the account answers with no balance, and when the deployment has no configuration record', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    Object.assign(w.chain, { getRewardAccount: async () => ({ registered: true, source: 'ogmios' }) });
    const empty = await refusal(check(w, built.txCbor, true));
    expect(empty).toBeInstanceOf(PreconditionError);
    expect((empty as Error).message).toContain('no balance');
    const { world: sealed } = await world();
    const twin = await register(sealed, true);
    sealed.chain.held = sealed.chain.held.filter((utxo) => utxo.address !== DEPLOYMENT.configHolder.address);
    const err = await refusal(check(sealed, twin.txCbor, true));
    expect(err).toBeInstanceOf(PreconditionError);
    expect(err).not.toBeInstanceOf(GuardRefusal);
    expect((err as Error).message).toContain('no configuration record');
  });
  it('stops with a PreconditionError when the configuration record has no hash of Module-1 that can be read', async () => {
    const { world: w } = await world();
    const built = await register(w, true);
    w.chain.held = w.chain.held.map((utxo) => (utxo.address === DEPLOYMENT.configHolder.address ? { ...utxo, datum: '4101' } : utxo));
    const err = await refusal(check(w, built.txCbor, true));
    expect(err).toBeInstanceOf(PreconditionError);
    expect((err as Error).message).toContain('configuration record');
  });
  it('counts the withdrawals before it reads anything: a body with two withdrawals is refused even when the configuration record is gone and the account cannot be read', async () => {
    const { world: w, account } = await world();
    const built = await register(w, true);
    const two = withdrawing(built.txCbor, [CONSENT, { hash: OTHER_HASH, lovelace: 1n }]);
    w.chain.held = w.chain.held.filter((utxo) => utxo.address !== DEPLOYMENT.configHolder.address);
    account.fails = new Error('the node is down');
    account.reads.length = 0;
    expect(await refusal(check(w, two, true))).toBeInstanceOf(GuardRefusal);
    expect(account.reads).toEqual([]);
  });
});

describe('checkConsentWithdrawal: a record with no Module-1 party', () => {
  it('passes a body with no withdrawal, and reads nothing from the node', async () => {
    const { world: w, account } = await world();
    const built = await register(w, false);
    account.reads.length = 0;
    await expect(check(w, built.txCbor, false)).resolves.toBeUndefined();
    expect(account.reads).toEqual([]);
  });
  it('refuses a body that has a withdrawal, also when it is the consent of Module-1 for the whole balance, with the guard nothing_else', async () => {
    const { world: w, account } = await world();
    const built = await register(w, false);
    const withConsent = withdrawing(built.txCbor, [CONSENT]);
    account.reads.length = 0;
    const err = await refusal(check(w, withConsent, false));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(failuresOf(err)).toEqual([{ guard: 'nothing_else', message: expect.stringContaining('no party of the record is Module-1') }]);
    expect(failuresOf(err)[0]!.message).toContain('1 withdrawal');
    // A withdrawal from another account, and two withdrawals, are refused as well.
    expect(await refusal(check(w, withdrawing(built.txCbor, [{ hash: OTHER_HASH, lovelace: 5n }]), false))).toBeInstanceOf(GuardRefusal);
    expect(await refusal(check(w, withdrawing(built.txCbor, [CONSENT, { hash: OTHER_HASH, lovelace: 1n }]), false))).toBeInstanceOf(GuardRefusal);
    expect(account.reads).toEqual([]);
    await expect(check(w, built.txCbor, false)).resolves.toBeUndefined();
  });
});

// ---- through the landing: nothing is signed after a refusal ----

const settings: OperatorSettings = {
  network: VECTOR_MAINNET, useCase: USE_CASE, keysDir: '/keys', stateDir: '/state', agentsDir: '/agents', goFile: '/state/GO.json', mockEnvFile: null, contact: null, module1Commit: null,
  urls: { ogmios: 'https://ogmios.test', submit: 'https://submit.test', koios: 'https://koios.test', hosted: 'https://hosted.test/mcp', gateway: 'https://gateway.test' },
  maxFeeLovelace: FEE_LIMIT, maxCollateralLossLovelace: 5_000_000n,
};

function registryOf(): Registry {
  const root = makeKeyRoot();
  const specs: KeySpec[] = NAMES.map((name) => ({ name, scope: 'use-case', about: `The test key ${name}.` }));
  for (const name of NAMES) writeSeed(root, USE_CASE, name, `${seedHex(N[name])}\n`);
  return loadRegistry({ dir: root, useCase: USE_CASE, specs });
}

interface Landing { w: World; account: Account; node: FakeNode; registry: Registry; host: LandHost; signer: ThrowingSigner | null; state: StateFile; hosted: PackHosted }

/** A host for `landHosted` over a world: the registry of the keys, an approval that names the task and the tag `record`, and a signer that fails when it is asked, when `throwing` is true. */
async function landing(throwing: boolean): Promise<Landing> {
  const { world: w, account } = await world();
  const registry = registryOf();
  const dir = mkdtempSync(join(tmpdir(), 'operator-consent-'));
  chmodSync(dir, 0o700);
  folders.push(dir);
  const identity = { check: 'register', network: 'vector-mainnet', record: 'test' };
  const state = StateFile.open(join(dir, 'state.json'), identity);
  const evidence = EvidenceFile.open(join(dir, 'evidence.json'), identity);
  const go: GoFile = {
    approvedBy: 'a test approver', at: iso(NOW - 3_600_000), session: 'test-session', runWallet: keyOf(N.run).address, capUnits: 100, tasks: ['register'], irreversible: ['record'], expiresAt: iso(NOW + 86_400_000),
  };
  const node = new FakeNode(w);
  const signer = throwing ? new ThrowingSigner() : null;
  if (signer !== null) registry.ring.sign = () => signer.sign();
  const chain: ChainAccess = {
    provider: w.chain, deployment: DEPLOYMENT, koiosUrl: 'https://koios.test', fetchImpl: (async () => { throw new Error('the network was touched'); }) as typeof fetch,
    context: async (address) => ({ lucid: await lucidForAddress(w.chain, address), provider: w.chain, deployment: DEPLOYMENT }), liveVaultsOf: async () => [],
  };
  const hosted = new PackHosted({});
  const host: LandHost = {
    mode: 'submit', settings, registry, state, evidence, clock: new FakeClock(NOW), out: new MemoryOutput(), node, network: new NetworkGate(node, VECTOR_MAINNET), networkResult: () => null, chain, hosted,
    go, exposure: new Exposure(join(dir, 'exposure.json'), go), task: 'register', awaitMs: 10_000, pollMs: 5_000,
  };
  return { w, account, node, registry, host, signer, state, hosted };
}

const REGISTER_ARGS = (): Record<string, unknown> => ({ changeAddress: keyOf(N.fee).address, controller: keyOf(N.controller).publicKeyHex, name: 'Consent Agent', parties: [{ role: 'Accountable', signer: 'controller' }] });

/**
 * Lands the registration `built` with the bytes `cbor` as the answer of the hosted tool, with the plan that names the withdrawals that the bytes have, so that the guards alone would pass: only
 * the consent check can refuse. The signers are those that the build lists, and `expectModule1` is what the check is told.
 */
function landWith(l: Landing, built: RegisterBuild, cbor: string, expectModule1: boolean) {
  const live: LiveBuild = {
    txCbor: cbor, txHash: factsOf(cbor).txHash, fee: built.fee, validFrom: built.validFrom, validTo: built.validTo,
    requiredSigners: built.requiredSigners.map((signer) => ({ keyHash: signer.keyHash, roles: signer.roles })),
  };
  l.hosted.handlers.vector_build_identity_register = () => liveBuildAnswer('Identity registration', live, { did: built.did, id: built.id });
  return landHosted(l.host, {
    step: 'reorder-agent', tool: 'vector_build_identity_register', args: REGISTER_ARGS(), expectSigners: built.requiredSigners.map((signer) => l.registry.nameOfHash(signer.keyHash)!), irreversible: 'record',
    plan: (_build, facts) => planOf(l.host, {
      outflow: { fee: built.depositLovelace + FEE_LIMIT }, destinations: [DEPLOYMENT.identity.address], mint: { [`${DEPLOYMENT.identity.hash}${built.id}`]: 1n }, withdrawals: facts.withdrawals,
    }),
    beforeSign: async (build) => checkConsentWithdrawal({ step: 'reorder-agent', unsignedCbor: build.unsignedCbor, provider: l.host.chain.provider, deployment: l.host.chain.deployment, expectModule1 }),
  });
}

describe('checkConsentWithdrawal through landHosted, with a signer that fails when it is asked', () => {
  const untouched = (l: Landing): void => {
    expect(l.signer?.calls).toBe(0);
    expect(l.node.submitted).toEqual([]);
    expect(l.w.chain.applied).toEqual([]);
    expect(l.state.snapshot().in_flight).toBeNull();
    expect(l.state.snapshot().steps).toEqual({});
  };
  it('lands the registration whose consent is right: the signers sign, the transaction is submitted, and the step is recorded', async () => {
    const l = await landing(false);
    const built = await register(l.w, true);
    const result = await landWith(l, built, built.txCbor, true);
    expect(result.kind).toBe('landed');
    expect(l.node.submitted).toHaveLength(1);
    expect(l.state.step('reorder-agent')).toMatchObject({ tx_hash: built.txHash });
    // The signed transaction holds the withdrawal that was checked.
    expect(withdrawalsOf(l.node.submitted[0]!)).toEqual([{ address: REWARD_ADDRESS, lovelace: REWARDS }]);
  });
  const REFUSALS: Array<[string, boolean, (l: Landing, built: RegisterBuild) => string | void]> = [
    ['no withdrawal where Module-1 is a party', true, (_l, built) => withdrawing(built.txCbor, [])],
    ['two withdrawals', true, (_l, built) => withdrawing(built.txCbor, [CONSENT, { hash: OTHER_HASH, lovelace: 1n }])],
    ['a withdrawal from another reward account', true, (_l, built) => withdrawing(built.txCbor, [{ hash: OTHER_HASH, lovelace: REWARDS }])],
    ['an amount below the balance', true, (l) => { l.account.rewards = REWARDS + 1n; }],
    ['an amount above the balance', true, (l) => { l.account.rewards = REWARDS - 1n; }],
    ['a withdrawal on a record with no Module-1 party', false, (_l, built) => withdrawing(built.txCbor, [CONSENT])],
  ];
  for (const [label, module1, change] of REFUSALS) {
    it(`signs nothing and submits nothing for ${label}, and lands the twin that has the right consent`, async () => {
      const l = await landing(true);
      const built = await register(l.w, module1);
      // A record with no Module-1 party that is refused for a withdrawal is built with the party and told it has none: the body holds the withdrawal, and the check expects none.
      const expectModule1 = label === 'a withdrawal on a record with no Module-1 party' ? false : module1;
      const bytes = label === 'a withdrawal on a record with no Module-1 party' ? withdrawing((await register(l.w, false)).txCbor, [CONSENT]) : (change(l, built) ?? built.txCbor);
      const err = await refusal(landWith(l, built, bytes, expectModule1));
      expect(err, label).toBeInstanceOf(GuardRefusal);
      expect(failuresOf(err)[0]!.guard).toBe('nothing_else');
      untouched(l);
      const twin = await landing(false);
      const right = await register(twin.w, module1);
      expect((await landWith(twin, right, right.txCbor, module1)).kind).toBe('landed');
    });
  }
  for (const [label, change] of [
    ['an account that is not registered', (l: Landing) => { l.account.registered = false; }],
    ['a read of the account that fails', (l: Landing) => { l.account.fails = new Error('the node is down'); }],
    ['a deployment with no configuration record', (l: Landing) => { l.w.chain.held = l.w.chain.held.filter((utxo) => utxo.address !== DEPLOYMENT.configHolder.address); }],
  ] as const) {
    it(`signs nothing and submits nothing for ${label}, with a precondition and no guard`, async () => {
      const l = await landing(true);
      const built = await register(l.w, true);
      change(l);
      const err = await refusal(landWith(l, built, built.txCbor, true));
      expect(err, label).toBeInstanceOf(PreconditionError);
      untouched(l);
    });
  }
});
