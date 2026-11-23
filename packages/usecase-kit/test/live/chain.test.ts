// packages/usecase-kit/test/live/chain.test.ts: the delegation chain of the live folder, over the builders and the reads of the buyer code. The world is the offline identity world of the buyer code (Lucid runs the real
// scripts in every build) with two additions: a node that takes a signed transaction, checks its signatures and changes its outputs, and a fake Koios that gives the tip and the block of each output. No test uses the
// network or a key file. The first part runs the reads on that world: what `readDelegation` gives, and the decision of `readiness` from its two reads. The second part builds and sends the real Delegate and Undelegate.
// The last part runs `withSubDelegation` of the access folder over the adapter: it makes the sub-delegation, waits for 30 confirmations, runs a job, and ends the sub-delegation.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CML, coreToTxOutput, getAddressDetails } from '@lucid-evolution/lucid';
import type { Address, Credential, OutRef, UTxO } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import type { DelegateParams, DelegationUseCheck, LedgerEnv, LinkConfirmations } from '@vsa/buyer-core';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import type { IdentityDatum } from '@vsa/vector-read/identity-codec';
import * as byName from '@vsa/usecase-kit/live';
import { FixtureProvider } from '../../../buyer-core/test/fixtures/fixture-provider.ts';
import { CONFIG_UTXO, DEPLOYMENT, REF_UTXOS, recordUtxo, rootRecord, testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { callsTo, koiosRow, ledgerKoios } from '../../../buyer-core/test/fixtures/ledger-read-world.ts';
import { CONFIRMATIONS_REQUIRED, createSerialQueue, txSignerOfRawKey, withSubDelegation } from '../../src/access/index.ts';
import type { DelegationChain, DelegationDatum, SubDelegationDeps, SubDelegationHandle, SubDelegationLimits, SubDelegationRequest, SubDelegationRun } from '../../src/access/index.ts';
import { readinessOfDepth, readinessOfRules } from '../../src/live/chain.ts';
import * as byPath from '../../src/live/index.ts';
import { delegationChainOf } from '../../src/live/index.ts';
import type { LiveChainDeps } from '../../src/live/index.ts';
import { AGENT_ID, BASES, DAY, FakeClock, NOW, PARENT_ID, SUBAGENT_ID, erpTarget, parentDatum, slotOf } from '../access/support.ts';

// ── the world ──

const BLOCK_MS = 4_000;
const START_HEIGHT = 5_000_000;
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const refOf = (utxo: { readonly txHash: string; readonly outputIndex: number }): string => `${utxo.txHash}#${utxo.outputIndex}`;
/** The raw key whose 32 bytes are all `n`: the key that `testKey(n)` gives the public key and the key hash of. */
const rawKeyOf = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

const AGENT = testKey(41);
const SUBAGENT = testKey(42);
const agentSigner = txSignerOfRawKey(rawKeyOf(41));
const subagentSigner = txSignerOfRawKey(rawKeyOf(42));
/** The wallet of the agent key: its enterprise address. It pays the fees, and it gets the deposit back. */
const WALLET = agentSigner.address;

const SUB_ID = 'dd'.repeat(32);
/** Hashes of transactions of the world that no counter of the fixtures can make: the fixtures repeat two characters, these repeat six. */
const SUB_TX = 'b1c2d3'.repeat(11).slice(0, 64);
const PARENT_TX = 'f1e2d3'.repeat(11).slice(0, 64);
const WALLET_TX = 'a1b2c3'.repeat(11).slice(0, 64);
const FOREIGN_TX = 'e4f5a6'.repeat(11).slice(0, 64);

/** The route of the sub-delegation: the action and the resource of the sub-delegation of the examples. */
const ROUTE = { action: 'erp.stock.read', resource: 'https://mock.example/t/run1/erp' } as const;
/** The delegation of the hirer to the agent: one more hop. */
const PARENT: DelegationDatum = parentDatum({ delegateKey: AGENT.keyHash });
/** The sub-delegation that the agent gave to its subagent: no further hop, no value, one action on one resource. */
const SUB: DelegationDatum = {
  delegator: { type: 'Agent', id: AGENT_ID }, parent: PARENT_ID, delegate: SUBAGENT_ID, delegateKey: SUBAGENT.keyHash, actions: [hex(ROUTE.action)], resources: [hex(ROUTE.resource)],
  notBefore: NOW - 60_000, notAfter: NOW + 3_600_000, depth: 2, remaining: 0, purpose: null, value: { perTx: 0n, total: 0n, periodMs: DAY },
};
/** What the kit asks the Delegate builder for, for the sub-delegation of the examples. */
const DELEGATE: DelegateParams = {
  changeAddress: WALLET, nowMs: NOW, parent: PARENT_ID, delegate: SUBAGENT_ID, delegateKey: SUBAGENT.keyHash, actions: [ROUTE.action], resources: [ROUTE.resource], notAfter: NOW + 3_600_000, remaining: 0,
  value: { perTx: 0n, total: 0n, periodMs: DAY },
};

const ALL_PURPOSES = 1 + 2 + 8 + 16;
const listed = (key: { readonly publicKey: string }) => ({ keyType: 'Ed25519' as const, key: key.publicKey, purposes: ALL_PURPOSES, pop: null });
const subagentRecord = (over: Partial<IdentityDatum> = {}): IdentityDatum =>
  rootRecord({ endpoint: '', lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 }, keys: [listed(SUBAGENT)], ...over });
const delegationOutput = (id: string, datum: DelegationDatum, txHash: string): UTxO => ({
  txHash, outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_400_000n, [`${DEPLOYMENT.delegation.hash}${id}`]: 1n }, datum: encodeDelegationDatum(datum),
});
const walletOutputs = (): UTxO[] => [
  { txHash: WALLET_TX, outputIndex: 0, address: WALLET, assets: { lovelace: 1_000_000_000n } },
  { txHash: WALLET_TX, outputIndex: 1, address: WALLET, assets: { lovelace: 5_000_000n } },
];
const lovelaceAt = (world: World, address: string): bigint => world.live.filter((utxo) => utxo.address === address).reduce((sum, utxo) => sum + utxo.assets.lovelace!, 0n);

/**
 * The node of the world. It holds the outputs of the identity world, and it takes a signed transaction as a real node does in the rules that matter here: every signature verifies, every required signer and every
 * key of an input signed, and every input is an unspent output. The transaction then spends its inputs and makes its outputs. The height of the tip follows the clock of the world: one block in 4 seconds.
 */
class World extends FixtureProvider {
  live: UTxO[];
  /** The block height of the transaction of each output, by the hash of the transaction. An output with no entry has no block height in Koios. */
  readonly heights = new Map<string, number>();
  /** The hashes of the transactions that the node took, in order. */
  readonly taken: string[] = [];
  /** An error that `submitTx` throws instead of taking the transaction. */
  refuses: Error | null = null;
  /** A number holds the tip at that height, whatever the time. */
  stalledAt: number | null = null;
  readonly now: () => number;

  constructor(outputs: readonly UTxO[], now: () => number) {
    const all = [...REF_UTXOS, CONFIG_UTXO, ...outputs];
    super(all);
    this.live = all;
    this.now = now;
  }

  get tipHeight(): number {
    return this.stalledAt ?? START_HEIGHT + Math.floor((this.now() - NOW) / BLOCK_MS);
  }

  override async getUtxos(address: Address | Credential): Promise<UTxO[]> {
    if (typeof address !== 'string') throw new Error('the world lists outputs by address only');
    return this.live.filter((utxo) => utxo.address === address);
  }

  override async getUtxosByOutRef(refs: OutRef[]): Promise<UTxO[]> {
    return this.live.filter((utxo) => refs.some((ref) => ref.txHash === utxo.txHash && Number(ref.outputIndex) === utxo.outputIndex));
  }

  override async submitTx(tx: string): Promise<string> {
    if (this.refuses !== null) throw this.refuses;
    const parsed = CML.Transaction.from_cbor_hex(tx);
    const body = parsed.body();
    const hash = CML.hash_transaction(body).to_hex();
    const signed = new Set<string>();
    const witnesses = parsed.witness_set().vkeywitnesses();
    for (let index = 0; index < (witnesses?.len() ?? 0); index += 1) {
      const witness = witnesses!.get(index);
      if (!witness.vkey().verify(CML.hash_transaction(body).to_raw_bytes(), witness.ed25519_signature())) throw new Error('a signature does not verify');
      signed.add(witness.vkey().hash().to_hex());
    }
    const required = body.required_signers();
    for (let index = 0; index < (required?.len() ?? 0); index += 1) {
      if (!signed.has(required!.get(index).to_hex())) throw new Error(`the required signer ${required!.get(index).to_hex()} did not sign`);
    }
    const spent = new Set<string>();
    const inputs = body.inputs();
    for (let index = 0; index < inputs.len(); index += 1) {
      const ref = `${inputs.get(index).transaction_id().to_hex()}#${inputs.get(index).index()}`;
      const utxo = this.live.find((candidate) => refOf(candidate) === ref);
      if (utxo === undefined) throw new Error(`the input ${ref} is not an unspent output`);
      const credential = getAddressDetails(utxo.address).paymentCredential;
      if (credential?.type === 'Key' && !signed.has(credential.hash)) throw new Error(`the key of the input ${ref} did not sign`);
      spent.add(ref);
    }
    this.live = this.live.filter((utxo) => !spent.has(refOf(utxo)));
    const outputs = body.outputs();
    for (let index = 0; index < outputs.len(); index += 1) {
      const output = coreToTxOutput(outputs.get(index));
      this.live.push({ txHash: hash, outputIndex: index, address: output.address, assets: output.assets, ...(output.datum ? { datum: output.datum } : {}) });
    }
    this.heights.set(hash, this.tipHeight);
    this.taken.push(hash);
    return hash;
  }

  /** The unspent output that holds the token `id` of the delegation policy, or undefined. */
  delegationOf(id: string): UTxO | undefined {
    return this.live.find((utxo) => utxo.assets[`${DEPLOYMENT.delegation.hash}${id}`] !== undefined);
  }

  /** How many blocks lie on top of the block of the delegation `id`: the depth that Koios gives. */
  depthOf(id: string): number {
    const output = this.delegationOf(id);
    const height = output === undefined ? undefined : this.heights.get(output.txHash);
    if (height === undefined) throw new Error('the delegation has no block height');
    return this.tipHeight - height;
  }
}

/** A fake Koios over the world: the tip and the block height of each output. `status` makes a route answer with an HTTP status. */
function koiosOf(world: World, status: Record<string, number> = {}) {
  return ledgerKoios({
    status,
    get tip() {
      return world.tipHeight;
    },
    get utxoInfo() {
      return world.live.map((utxo) => koiosRow(utxo, { block_height: world.heights.get(utxo.txHash) }));
    },
  });
}

const envOf = (world: World, koios = koiosOf(world)): LiveChainDeps => ({ provider: world, deployment: DEPLOYMENT, koiosUrl: 'https://koios.example', fetchImpl: koios.f });

interface WorldOptions {
  /** The sub-delegation on the ledger. The default is `SUB`. `null` is none. */
  readonly sub?: DelegationDatum | null;
  /** False leaves the parent delegation off the ledger. */
  readonly parent?: boolean;
  /** Changes in the record of the subagent. */
  readonly subagent?: Partial<IdentityDatum>;
  /** The confirmations of the sub-delegation. The default is 100. `null` gives its output no block height. */
  readonly depth?: number | null;
  /** The confirmations of the parent delegation. The default is 50,000. */
  readonly parentDepth?: number;
  /** The clock of the world. The default stands at `NOW`, so the tip does not move. */
  readonly now?: () => number;
}

/** The world of the examples: the records of the agent and its subagent, the parent delegation, the sub-delegation, and the wallet of the agent. */
function worldOf(options: WorldOptions = {}): World {
  const sub = options.sub === undefined ? SUB : options.sub;
  const outputs = [
    recordUtxo(AGENT_ID, rootRecord({ keys: [listed(AGENT)] })),
    recordUtxo(SUBAGENT_ID, subagentRecord(options.subagent)),
    ...(options.parent === false ? [] : [delegationOutput(PARENT_ID, PARENT, PARENT_TX)]),
    ...(sub === null ? [] : [delegationOutput(SUB_ID, sub, SUB_TX)]),
    ...walletOutputs(),
  ];
  const world = new World(outputs, options.now ?? (() => NOW));
  world.heights.set(PARENT_TX, START_HEIGHT - (options.parentDepth ?? 50_000));
  if (options.depth !== null) world.heights.set(SUB_TX, START_HEIGHT - (options.depth ?? 100));
  return world;
}

/** A provider that notes the name of each method that is called on it, and then calls the method of the world. */
function recording(world: World): { readonly provider: World; readonly calls: string[] } {
  const calls: string[] = [];
  const provider = new Proxy(world, {
    get(target, name) {
      const member: unknown = Reflect.get(target, name);
      return typeof member === 'function'
        ? (...args: unknown[]) => {
            calls.push(String(name));
            return (member as (...a: unknown[]) => unknown).apply(target, args);
          }
        : member;
    },
  });
  return { provider, calls };
}

/** A provider whose every method throws: a node that is down. */
const down = (world: World): World => new Proxy(world, { get: (target, name) => (typeof Reflect.get(target, name) === 'function' ? () => { throw new Error('the node is down'); } : Reflect.get(target, name)) });

/** The error that a promise rejects with. A promise that resolves is a failure of the test. */
async function rejection(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('the call did not throw');
}

// ── the reads ──

describe('delegationChainOf: readDelegation', () => {
  it('gives the delegation that the ledger holds, with the hash of the transaction that made it', async () => {
    const chain = delegationChainOf(envOf(worldOf()));
    expect(await chain.readDelegation(SUB_ID)).toStrictEqual({ id: SUB_ID, delegation: SUB, txHash: SUB_TX });
    expect(await chain.readDelegation(PARENT_ID)).toStrictEqual({ id: PARENT_ID, delegation: PARENT, txHash: PARENT_TX });
  });

  it('gives null for an identifier that the ledger does not hold: it never existed, or it ended', async () => {
    const chain = delegationChainOf(envOf(worldOf({ sub: null })));
    expect(await chain.readDelegation(SUB_ID)).toBeNull();
    expect(await chain.readDelegation('ee'.repeat(32))).toBeNull();
  });

  it('gives the delegation although its parent is not on the ledger: the readiness says that it cannot be used', async () => {
    const chain = delegationChainOf(envOf(worldOf({ parent: false })));
    expect(await chain.readDelegation(SUB_ID)).toMatchObject({ id: SUB_ID, txHash: SUB_TX });
  });

  it('throws for an identifier that is not an identifier, and does not give null', async () => {
    const chain = delegationChainOf(envOf(worldOf()));
    for (const id of ['', 'not-an-id', 'dd'.repeat(31), 'dd'.repeat(33)]) await rejection(chain.readDelegation(id));
  });

  it('throws when the node cannot be read, and does not give null', async () => {
    const world = worldOf();
    const error = await rejection(delegationChainOf(envOf(down(world))).readDelegation(SUB_ID));
    expect(error.message).toContain('the node is down');
    // The twin: the same world with a node that answers.
    expect(await delegationChainOf(envOf(world)).readDelegation(SUB_ID)).not.toBeNull();
  });
});

describe('delegationChainOf: readiness', () => {
  const READY = { state: 'ready' } as const;
  const readiness = (world: World, route: { readonly action: string; readonly resource: string } = ROUTE, koios = koiosOf(world)) => delegationChainOf(envOf(world, koios)).readiness(SUB_ID, route, NOW);

  it.each([[30], [31], [10_000]])('is ready when every link has %i confirmations', async (depth) => {
    expect(await readiness(worldOf({ depth }))).toStrictEqual(READY);
  });

  it.each([[0], [1], [29]])('is waiting, and says the depth, when the sub-delegation has %i confirmations', async (depth) => {
    expect(await readiness(worldOf({ depth }))).toStrictEqual({ state: 'waiting', confirmations: depth });
  });

  it('is waiting with the least depth of the chain: a parent that is not deep gives its depth, and a sub-delegation that is not deep gives its own', async () => {
    expect(await readiness(worldOf({ depth: 100, parentDepth: 12 }))).toStrictEqual({ state: 'waiting', confirmations: 12 });
    expect(await readiness(worldOf({ depth: 7, parentDepth: 300 }))).toStrictEqual({ state: 'waiting', confirmations: 7 });
    expect(await readiness(worldOf({ depth: 30, parentDepth: 30 }))).toStrictEqual(READY);
  });

  it('is waiting with null when the ledger does not show the delegation yet, and reads no depth', async () => {
    const world = worldOf({ sub: null });
    const koios = koiosOf(world);
    expect(await readiness(world, ROUTE, koios)).toStrictEqual({ state: 'waiting', confirmations: null });
    expect(koios.calls).toStrictEqual([]);
  });

  it('is waiting with null when a link has no block height: Koios gives the output with no height, or does not give it', async () => {
    expect(await readiness(worldOf({ depth: null }))).toStrictEqual({ state: 'waiting', confirmations: null });
    const world = worldOf({ depth: 100 });
    const koios = ledgerKoios({ tip: START_HEIGHT, utxoInfo: world.live.filter((utxo) => utxo.txHash !== SUB_TX).map((utxo) => koiosRow(utxo, { block_height: world.heights.get(utxo.txHash) })) });
    expect(await readiness(world, ROUTE, koios)).toStrictEqual({ state: 'waiting', confirmations: null });
  });

  it('is waiting with 0 and not a negative depth when Koios gives a block above its tip', async () => {
    const world = worldOf({ depth: -3 });
    expect(await readiness(world)).toStrictEqual({ state: 'waiting', confirmations: 0 });
  });

  it('is unusable for a delegate that is not Active, with its problems, and reads no depth', async () => {
    const world = worldOf({ depth: 500, subagent: { status: { type: 'Retired', at: NOW - DAY, successor: null } } });
    const koios = koiosOf(world);
    const result = await readiness(world, ROUTE, koios);
    expect(result.state).toBe('unusable');
    if (result.state !== 'unusable') return;
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems.join(' ')).toContain('Retired');
    expect(koios.calls).toStrictEqual([]);
  });

  it('is unusable, and never waiting, for a delegate that is not Active with fewer than 30 confirmations', async () => {
    for (const depth of [0, 1, 29, 30, 500]) {
      const world = worldOf({ depth, subagent: { status: { type: 'Retired', at: NOW - DAY, successor: null } } });
      expect(await readiness(world)).toMatchObject({ state: 'unusable' });
    }
    // The twin: the same depths with an Active delegate wait, or are ready.
    expect(await readiness(worldOf({ depth: 29 }))).toMatchObject({ state: 'waiting' });
    expect(await readiness(worldOf({ depth: 30 }))).toStrictEqual(READY);
  });

  it('is unusable for an action that the delegation does not cover, with any depth', async () => {
    for (const depth of [0, 500]) expect(await readiness(worldOf({ depth }), { action: 'po.write', resource: ROUTE.resource })).toMatchObject({ state: 'unusable' });
    for (const depth of [0, 500]) expect(await readiness(worldOf({ depth }), { action: ROUTE.action, resource: 'https://mock.example/t/run1/po' })).toMatchObject({ state: 'unusable' });
  });

  it('is unusable when the parent delegation is not on the ledger: it ended, and the sub-delegation is no longer usable', async () => {
    expect(await readiness(worldOf({ parent: false, depth: 500 }))).toMatchObject({ state: 'unusable' });
  });

  it('reads the depth once, and the rules once, for a delegation that passes the rules', async () => {
    const world = worldOf({ depth: 100 });
    const koios = koiosOf(world);
    await readiness(world, ROUTE, koios);
    expect(callsTo(koios, 'tip')).toHaveLength(1);
    expect(callsTo(koios, 'utxo_info')).toHaveLength(1);
  });

  it('throws when the node cannot be read, and is not ready, waiting or unusable for it', async () => {
    const world = worldOf({ depth: 500 });
    const error = await rejection(delegationChainOf(envOf(down(world), koiosOf(world))).readiness(SUB_ID, ROUTE, NOW));
    expect(error.message).toContain('the node is down');
    expect(await readiness(world)).toStrictEqual(READY);
  });

  it.each(['tip', 'utxo_info'])('throws when Koios fails on %s in the read of the depth, and is not ready or waiting for it', async (route) => {
    const world = worldOf({ depth: 500 });
    const error = await rejection(readiness(world, ROUTE, koiosOf(world, { [route]: 500 })));
    expect(error.message).toContain('500');
    expect(await readiness(world)).toStrictEqual(READY);
  });

  it('throws for an action or a resource that is not one, and is not ready for it', async () => {
    const world = worldOf({ depth: 500 });
    await rejection(readiness(world, { action: 'ERP STOCK', resource: ROUTE.resource }));
    await rejection(readiness(world, { action: ROUTE.action, resource: 'mock.example/t/run1/erp' }));
  });
});

// ── the decision of readiness, on typed values ──

describe('the decision of readiness', () => {
  const LEAF = { id: SUB_ID, utxo: delegationOutput(SUB_ID, SUB, SUB_TX), delegation: SUB };
  const ROOT = { id: PARENT_ID, utxo: delegationOutput(PARENT_ID, PARENT, PARENT_TX), delegation: PARENT };
  const link = (id: string, confirmations: number | null): LinkConfirmations => ({ id, blockHeight: confirmations === null ? null : 1, confirmations });
  const read = (over: Partial<DelegationUseCheck> = {}): DelegationUseCheck => ({
    view: { id: SUB_ID, chain: [LEAF, ROOT], missingParent: null }, action: ROUTE.action, resource: ROUTE.resource, atMs: NOW, minConfirmations: 0, problems: [], usable: true, confirmations: null, ...over,
  });
  const depthRead = (links: readonly LinkConfirmations[], over: Partial<DelegationUseCheck> = {}): DelegationUseCheck =>
    read({ minConfirmations: CONFIRMATIONS_REQUIRED, confirmations: { tipHeight: 100, links: [...links] }, ...over });
  const READY = { state: 'ready' } as const;

  describe('the rules', () => {
    it('are waiting with null when the read shows no delegation, whatever its problems say', () => {
      const empty = { id: SUB_ID, chain: [], missingParent: null };
      expect(readinessOfRules(read({ view: empty, usable: false, problems: ['the delegation is not live'] }))).toStrictEqual({ state: 'waiting', confirmations: null });
    });

    it('are unusable with the problems of the read when the read is not usable, and a text about depth does not change it', () => {
      const problems = ['the delegate is Retired', 'the delegation x has 3 confirmations, fewer than the 30 that are asked for'];
      expect(readinessOfRules(read({ usable: false, problems }))).toStrictEqual({ state: 'unusable', problems });
    });

    it('give no decision for a usable read: the depth decides', () => {
      expect(readinessOfRules(read())).toBeNull();
    });
  });

  describe('the depth', () => {
    it('is ready when every link has 30 confirmations or more', () => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, 30), link(PARENT_ID, 31)]))).toStrictEqual(READY);
    });

    it('is waiting with the least depth when a link has fewer than 30, in either place', () => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, 29), link(PARENT_ID, 90)]))).toStrictEqual({ state: 'waiting', confirmations: 29 });
      expect(readinessOfDepth(depthRead([link(SUB_ID, 90), link(PARENT_ID, 4)]))).toStrictEqual({ state: 'waiting', confirmations: 4 });
    });

    it('is waiting with null when a link has no depth, also when the other link has fewer than 30', () => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, null), link(PARENT_ID, 90)]))).toStrictEqual({ state: 'waiting', confirmations: null });
      expect(readinessOfDepth(depthRead([link(SUB_ID, 3), link(PARENT_ID, null)]))).toStrictEqual({ state: 'waiting', confirmations: null });
    });

    it('is waiting with 0 for a link whose depth is below 0', () => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, -5), link(PARENT_ID, 90)]))).toStrictEqual({ state: 'waiting', confirmations: 0 });
    });

    it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [30.5]])('does not take %s as a depth: it is waiting with null, and never ready', (value) => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, value), link(PARENT_ID, 90)]))).toStrictEqual({ state: 'waiting', confirmations: null });
    });

    it('is waiting with null when the delegation has ended between the two reads', () => {
      expect(readinessOfDepth(depthRead([], { view: { id: SUB_ID, chain: [], missingParent: null }, usable: false, problems: ['the delegation is not live'] }))).toStrictEqual({ state: 'waiting', confirmations: null });
    });

    it('is unusable, with the problems, when every link is deep and the read is not usable: a rule broke between the two reads', () => {
      expect(readinessOfDepth(depthRead([link(SUB_ID, 40), link(PARENT_ID, 90)], { usable: false, problems: ['the delegate is Retired'] }))).toStrictEqual({ state: 'unusable', problems: ['the delegate is Retired'] });
    });

    it('throws for a read that has no depths, or the depths of another number of links, and is never ready for it', () => {
      expect(() => readinessOfDepth(depthRead([], { confirmations: null }))).toThrow();
      expect(() => readinessOfDepth(depthRead([link(SUB_ID, 40)]))).toThrow();
      expect(() => readinessOfDepth(depthRead([]))).toThrow();
      expect(() => readinessOfDepth(depthRead([link(SUB_ID, 40), link(PARENT_ID, 40), link(PARENT_ID, 40)]))).toThrow();
    });
  });
});

// ── the builders, the node and the slot clock ──

describe('delegationChainOf: the builders, the submit and the slot clock', () => {
  it('builds the Delegate of the kit, takes the signatures, sends it, shows it with the hash of its transaction, then builds and sends the Undelegate that ends it', async () => {
    const world = worldOf({ sub: null });
    const chain = delegationChainOf(envOf(world));
    const built = await chain.buildDelegate(DELEGATE);
    expect(built.requiredSigners.map((signer) => signer.keyHash).sort()).toStrictEqual([AGENT.keyHash, SUBAGENT.keyHash].sort());
    expect(await chain.readDelegation(built.id)).toBeNull();
    expect(await chain.submit(subagentSigner.sign(agentSigner.sign(built.txCbor)))).toBe(built.txHash);
    expect(await chain.readDelegation(built.id)).toStrictEqual({ id: built.id, delegation: built.delegation, txHash: built.txHash });
    const ended = await chain.buildUndelegate({ changeAddress: WALLET, nowMs: NOW, id: built.id, signer: AGENT.keyHash });
    expect(ended.id).toBe(built.id);
    expect(await chain.submit(agentSigner.sign(ended.txCbor))).toBe(ended.txHash);
    expect(await chain.readDelegation(built.id)).toBeNull();
    expect(world.taken).toStrictEqual([built.txHash, ended.txHash]);
  });

  it('gives the slot that the real builder writes as the TTL of a Delegate, for the time that it is given and not for the current time', async () => {
    const chain = delegationChainOf(envOf(worldOf({ sub: null })));
    const built = await chain.buildDelegate(DELEGATE);
    const ttl = CML.Transaction.from_cbor_hex(built.txCbor).body().ttl();
    expect(await chain.slotAt(built.validTo)).toBe(Number(ttl));
    expect(await chain.slotAt(built.validTo)).toBe(slotOf(built.validTo));
    expect(await chain.slotAt(built.validTo + 10_000)).toBe(Number(ttl) + 10);
  });

  it('throws when the node refuses the transaction, and gives no hash for it', async () => {
    const world = worldOf({ sub: null });
    const chain = delegationChainOf(envOf(world));
    const built = await chain.buildDelegate(DELEGATE);
    world.refuses = new Error('the node refused the transaction');
    const error = await rejection(chain.submit(subagentSigner.sign(agentSigner.sign(built.txCbor))));
    expect(error.message).toContain('the node refused the transaction');
    expect(world.taken).toStrictEqual([]);
  });

  it('throws when the node does not take a transaction that is not signed by every required signer, and the node is the one that checks', async () => {
    const world = worldOf({ sub: null });
    const chain = delegationChainOf(envOf(world));
    const built = await chain.buildDelegate(DELEGATE);
    await rejection(chain.submit(agentSigner.sign(built.txCbor)));
    expect(world.taken).toStrictEqual([]);
    expect(await chain.submit(subagentSigner.sign(agentSigner.sign(built.txCbor)))).toBe(built.txHash);
  });

  it('throws when the node cannot be read, in the builders and in the submit', async () => {
    const world = worldOf({ sub: null });
    const chain = delegationChainOf(envOf(down(world)));
    // The slot clock is not in this list: the buyer code keeps the start time of the chain for the whole process once it has read it, so a node that is down is not asked again.
    for (const call of [
      () => chain.buildDelegate(DELEGATE),
      () => chain.buildUndelegate({ changeAddress: WALLET, nowMs: NOW, id: SUB_ID, signer: AGENT.keyHash }),
      () => chain.submit('00'),
    ]) expect((await rejection(call())).message).toContain('the node is down');
    // The twin: the same calls on a node that answers.
    const live = delegationChainOf(envOf(world));
    expect((await live.buildDelegate(DELEGATE)).id).toMatch(/^[0-9a-f]{64}$/);
    expect(await live.slotAt(NOW)).toBe(slotOf(NOW));
  });

  it('throws for a wallet that holds no output, and builds nothing', async () => {
    const chain = delegationChainOf(envOf(worldOf({ sub: null })));
    const empty = txSignerOfRawKey(rawKeyOf(77)).address;
    await rejection(chain.buildDelegate({ ...DELEGATE, changeAddress: empty }));
  });

  it('throws for an Undelegate that the key cannot sign for: the delegation of the hirer is not the agent to end', async () => {
    const chain = delegationChainOf(envOf(worldOf()));
    const error = await rejection(chain.buildUndelegate({ changeAddress: WALLET, nowMs: NOW, id: PARENT_ID, signer: AGENT.keyHash }));
    expect(error.message.length).toBeGreaterThan(0);
    // The twin: the same key ends a delegation that it gave.
    expect((await chain.buildUndelegate({ changeAddress: WALLET, nowMs: NOW, id: SUB_ID, signer: AGENT.keyHash })).id).toBe(SUB_ID);
  });

  it('reads the ledger and ends nothing by itself: no build and no submit, and nothing at all when it is made', async () => {
    const world = worldOf({ depth: 5 });
    const { provider, calls } = recording(world);
    const chain = delegationChainOf({ ...envOf(world), provider });
    expect(calls).toStrictEqual([]);
    await chain.readDelegation(SUB_ID);
    await chain.readiness(SUB_ID, ROUTE, NOW);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).not.toContain('submitTx');
    expect(calls).not.toContain('getProtocolParameters');
    expect(world.taken).toStrictEqual([]);
    expect(world.delegationOf(SUB_ID)).toBeDefined();
  });
});

// ── withSubDelegation over the adapter ──

interface Under {
  readonly world: World;
  readonly clock: FakeClock;
  /** The names of the methods of the chain that the run called, in order. */
  readonly calls: string[];
  run<T>(job: (handle: SubDelegationHandle) => Promise<T>, limits?: Partial<SubDelegationLimits>): Promise<SubDelegationRun<T>>;
}

/** The chain, with a note of each call of a method. */
function spied(chain: DelegationChain, calls: string[]): DelegationChain {
  return {
    readDelegation: (id) => (calls.push('readDelegation'), chain.readDelegation(id)),
    readiness: (id, route, atMs) => (calls.push('readiness'), chain.readiness(id, route, atMs)),
    buildDelegate: (params) => (calls.push('buildDelegate'), chain.buildDelegate(params)),
    buildUndelegate: (params) => (calls.push('buildUndelegate'), chain.buildUndelegate(params)),
    submit: (signed) => (calls.push('submit'), chain.submit(signed)),
    slotAt: (ms) => (calls.push('slotAt'), chain.slotAt(ms)),
  };
}

/** A run of `withSubDelegation` on a world whose clock the test moves: the agent has a parent delegation and no sub-delegation yet. */
function under(options: { readonly extra?: readonly UTxO[]; readonly stalledAt?: number } = {}): Under {
  const clock = new FakeClock(NOW);
  const world = worldOf({ sub: null, now: () => clock.now() });
  world.live.push(...(options.extra ?? []));
  if (options.stalledAt !== undefined) world.stalledAt = options.stalledAt;
  const calls: string[] = [];
  const chain = spied(delegationChainOf(envOf(world)), calls);
  const deps: SubDelegationDeps = { chain, clock, delegationScript: DEPLOYMENT.delegation, bases: BASES, walletQueue: createSerialQueue() };
  const request: SubDelegationRequest = {
    target: erpTarget(BASES), parent: PARENT_ID, agent: { signer: agentSigner, walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: subagentSigner }, validForMs: 3_600_000,
  };
  return { world, clock, calls, run: (job, limits = {}) => clock.run(withSubDelegation(deps, request, { jobTimeoutMs: 600_000, ...limits }, job)) };
}

describe('withSubDelegation over the live chain', () => {
  it('makes the sub-delegation, waits for 30 confirmations, runs the job, and ends the sub-delegation', async () => {
    const { world, calls, run } = under();
    const seen: { id: string; confirmations: number; live: boolean }[] = [];
    const walletBefore = lovelaceAt(world, WALLET);
    const result = await run(async (handle) => {
      seen.push({ id: handle.id, confirmations: world.depthOf(handle.id), live: world.delegationOf(handle.id) !== undefined });
      return 'the token step ran';
    });
    expect(result).toMatchObject({ ok: true, kind: 'returned', value: 'the token step ran', end: { state: 'ended', txHash: world.taken[1] } });
    // The job ran once, under a sub-delegation that was on the ledger and had 30 confirmations.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.live).toBe(true);
    expect(seen[0]!.confirmations).toBeGreaterThanOrEqual(CONFIRMATIONS_REQUIRED);
    // The node took the Delegate and then the Undelegate, and the ledger does not show the sub-delegation at the end.
    expect(world.taken).toHaveLength(2);
    expect(world.delegationOf(seen[0]!.id)).toBeUndefined();
    expect(world.delegationOf(PARENT_ID)).toBeDefined();
    expect(calls.filter((call) => call === 'buildDelegate' || call === 'buildUndelegate' || call === 'submit')).toStrictEqual(['buildDelegate', 'submit', 'buildUndelegate', 'submit']);
    // The deposit of the Delegate is back in the wallet, less the two fees.
    const spent = walletBefore - lovelaceAt(world, WALLET);
    expect(spent).toBeGreaterThan(200_000n);
    expect(spent).toBeLessThan(2_000_000n);
  }, 60_000);

  it('ends the sub-delegation when the job throws, and gives the error of the job', async () => {
    const { world, run } = under();
    let id = '';
    const result = await run(async (handle) => {
      id = handle.id;
      throw new Error('the job failed');
    });
    expect(result).toMatchObject({ ok: false, kind: 'threw', end: { state: 'ended' } });
    expect(world.delegationOf(id)).toBeUndefined();
    expect(world.taken).toHaveLength(2);
  }, 60_000);

  it('never runs the job when the sub-delegation does not reach 30 confirmations, and still ends the sub-delegation', async () => {
    const { world, run } = under({ stalledAt: START_HEIGHT + 3 });
    let ran = 0;
    const result = await run(async () => {
      ran += 1;
      return 'the token step ran';
    }, { confirmationWaitMs: 60_000 });
    expect(ran).toBe(0);
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'confirmation_timeout' }, end: { state: 'ended' } });
    expect(world.taken).toHaveLength(2);
    expect(world.live.some((utxo) => utxo.address === DEPLOYMENT.delegation.address && utxo.txHash !== PARENT_TX)).toBe(false);
  }, 60_000);

  it('builds no Undelegate for a delegation that another transaction made under the identifier of the run', async () => {
    // The identifier of a Delegate comes from the output that the wallet spends as its seed: the same wallet gives the same identifier.
    const probe = await delegationChainOf(envOf(worldOf({ sub: null }))).buildDelegate(DELEGATE);
    const foreign: DelegationDatum = { ...SUB, delegateKey: '99'.repeat(28) };
    const { world, calls, run } = under({ extra: [delegationOutput(probe.id, foreign, FOREIGN_TX)] });
    world.refuses = new Error('the node refused the Delegate');
    const result = await run(async () => 'the token step ran');
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'submit_failed' }, end: { state: 'not_made' } });
    expect(calls).not.toContain('buildUndelegate');
    expect(world.taken).toStrictEqual([]);
    expect(world.delegationOf(probe.id)?.txHash).toBe(FOREIGN_TX);
  }, 60_000);
});

// ── the folder ──

describe('the live folder', () => {
  const SRC = fileURLToPath(new URL('../../src/live/', import.meta.url));
  const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
  const codeOf = (name: string): string =>
    readFileSync(join(SRC, name), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**'))
      .join('\n');

  it('is the subpath @vsa/usecase-kit/live, with the three functions that it exports and no others', () => {
    expect(byName.delegationChainOf).toBe(byPath.delegationChainOf);
    expect(Object.keys(byName).sort()).toStrictEqual(['delegationChainOf', 'keyObjectOfRawKey', 'tipSlotOf']);
    expect(Object.keys(byPath).sort()).toStrictEqual(['delegationChainOf', 'keyObjectOfRawKey', 'tipSlotOf']);
  });

  it('has one file for each part', () => {
    expect(files.sort()).toStrictEqual(['chain.ts', 'index.ts', 'keys.ts', 'tip.ts']);
  });

  it.each(files)('%s reads no environment variable, no file and no stream of the process, and writes no log line', (name) => {
    const code = codeOf(name);
    expect(code).not.toMatch(/process\.(env|stdout|stderr|argv)/);
    expect(code).not.toMatch(/from 'node:(fs|fs\/promises|os|child_process)'|require\(/);
    expect(code).not.toMatch(/\bconsole\./);
  });

  it.each(files)('%s imports no other folder of the kit than the protocol and the access folders', (name) => {
    const folders = [...codeOf(name).matchAll(/from '\.\.\/([a-z]+)\//g)].map((match) => match[1]);
    for (const folder of folders) expect(['access', 'protocol']).toContain(folder);
  });
});
