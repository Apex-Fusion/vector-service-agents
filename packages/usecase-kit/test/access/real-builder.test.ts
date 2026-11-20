// packages/usecase-kit/test/access/real-builder.test.ts: the Delegate that the REAL builder of buyer-core makes for the terms of a sub-delegation, in the offline identity world of buyer-core. Lucid runs
// the applied delegation script on the build, so a build that completes passes the contract (minus the signatures). The rest of the ledger is the fake of support.ts.
import { CML, type UTxO } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { buildDelegate, buildUndelegate, enterpriseAddressOf, lucidForAddress } from '@vsa/buyer-core';
import type { DelegateBuild, UndelegateBuild } from '@vsa/buyer-core';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { DEPLOYMENT, identityWorld, recordUtxo, rootRecord, testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { MAX_DELEGATION_DEPOSIT_LOVELACE, MAX_TX_FEE_LOVELACE, deploymentSlotAt, withSubDelegation } from '../../src/access/index.ts';
import type { DelegationDatum, SubDelegationRun, TxSigner } from '../../src/access/index.ts';
import { AGENT_ID, DAY, NOW, PARENT_ID, SUBAGENT_ID, ZERO_TIME, parentDatum, subWorld, type SubWorld } from './support.ts';

const AGENT = testKey(41);
const SUBAGENT = testKey(42);
const UNLISTED = testKey(43);
const WALLET = enterpriseAddressOf(AGENT.keyHash);
const ALL_PURPOSES = 1 + 2 + 8 + 16;
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const idle = async (): Promise<string> => 'done';

/** The delegation of the hirer to the agent: one more hop, a value limit, and the delegate key of the agent. */
const PARENT: DelegationDatum = parentDatum({ delegateKey: AGENT.keyHash });

/** The identity world: the record of the agent, the record of its subagent, the parent delegation on the ledger (`parent` says what the ledger holds), the wallet of the agent key, and `extra`. */
async function world(parent: DelegationDatum = PARENT, extra: UTxO[] = []) {
  const provider = identityWorld([
    recordUtxo(AGENT_ID, rootRecord({ keys: [{ keyType: 'Ed25519', key: AGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    recordUtxo(SUBAGENT_ID, rootRecord({ endpoint: '', lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 }, keys: [{ keyType: 'Ed25519', key: SUBAGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    { txHash: 'f1'.repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_400_000n, [`${DEPLOYMENT.delegation.hash}${PARENT_ID}`]: 1n }, datum: encodeDelegationDatum(parent) },
    { txHash: 'a1'.repeat(32), outputIndex: 0, address: WALLET, assets: { lovelace: 1_000_000_000n } },
    { txHash: 'a1'.repeat(32), outputIndex: 1, address: WALLET, assets: { lovelace: 5_000_000n } },
    ...extra,
  ]);
  return { provider, context: { lucid: await lucidForAddress(provider, WALLET), provider, deployment: DEPLOYMENT } };
}

/** A key of the agent or the subagent that notes each transaction that it signs. */
function counting(keyHash: string, signed: string[]): TxSigner {
  return { keyHash, sign: (cbor) => (signed.push(keyHash), `${cbor}+${keyHash.slice(0, 4)}`) };
}

/** A run in which the builder is the real one. The ledger reads, the node and the confirmations are the fake. */
interface KeyFacts {
  readonly publicKey: string;
  readonly keyHash: string;
}
interface RunOptions {
  ledger?: DelegationDatum;
  subagentKey?: KeyFacts;
  /** The builder gives the bytes of a second, wider build, and reports the narrow one. */
  lie?: boolean;
  /** The Undelegate is the real one too, built over the identity world that holds the landed delegation. */
  realUndelegate?: boolean;
  /** The bytes of the Delegate end this many slots later than the real builder wrote (a negative number is earlier), and the report is made again for them. */
  moveTtl?: bigint;
  /** The `validTo` of the report is this many milliseconds later than the real builder wrote. */
  moveReport?: number;
}

/** The real Delegate with the TTL of its bytes moved by `slots`, and its hash made again for the new bytes: a builder whose bytes end at another slot than its report says. */
function withTtlMoved(made: DelegateBuild, slots: bigint): DelegateBuild {
  const tx = CML.Transaction.from_cbor_hex(made.txCbor);
  const body = tx.body();
  body.set_ttl(body.ttl()! + slots);
  const moved = CML.Transaction.new(body, tx.witness_set(), tx.is_valid(), tx.auxiliary_data());
  return { ...made, txCbor: moved.to_cbor_hex(), txHash: CML.hash_transaction(moved.body()).to_hex() };
}

async function run(options: RunOptions = {}): Promise<{ w: SubWorld; result: SubDelegationRun<string>; built: DelegateBuild[]; undelegated: UndelegateBuild[]; signed: string[] }> {
  const { context } = await world(options.ledger);
  const signed: string[] = [];
  const w = subWorld({
    parent: PARENT,
    script: DEPLOYMENT.delegation,
    request: { agent: { signer: counting(AGENT.keyHash, signed), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: counting((options.subagentKey ?? SUBAGENT).keyHash, signed) } },
  });
  w.chain.slotAt = deploymentSlotAt(context.provider);
  const built: DelegateBuild[] = [];
  const undelegated: UndelegateBuild[] = [];
  w.chain.buildDelegate = async (params) => {
    w.chain.params.push(params);
    const made = await buildDelegate(context, params);
    if (options.lie !== true) {
      const given: DelegateBuild = { ...(options.moveTtl === undefined ? made : withTtlMoved(made, options.moveTtl)), validTo: made.validTo + (options.moveReport ?? 0) };
      built.push(given);
      w.chain.adopt(given);
      return given;
    }
    const wide = await buildDelegate(context, { ...params, actions: ['erp.stock.read', 'po.write'], resources: ['https://mock.example/t/run1/erp', 'https://mock.example/t/run1/po'], value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY } });
    const lie: DelegateBuild = { ...wide, delegation: made.delegation };
    built.push(wide);
    w.chain.adopt(lie);
    return lie;
  };
  if (options.realUndelegate === true) {
    w.chain.buildUndelegate = async (params) => {
      const landed = built[0]!;
      const unit = `${DEPLOYMENT.delegation.hash}${landed.id}`;
      const { context: after } = await world(options.ledger, [
        { txHash: landed.txHash, outputIndex: landed.outputIndex, address: DEPLOYMENT.delegation.address, assets: { lovelace: landed.outputLovelace, [unit]: 1n }, datum: encodeDelegationDatum(landed.delegation) },
      ]);
      const made = await buildUndelegate(after, params);
      undelegated.push(made);
      w.chain.adoptUndelegate(made);
      return made;
    };
  }
  const result = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, idle));
  return { w, result, built, undelegated, signed };
}

describe('the Delegate that the real builder makes', () => {
  it('is the narrow sub-delegation: one hop below the parent, remaining 0, a value of 0, one action and one resource, and a period inside the parent', async () => {
    const { result, built } = await run();
    expect(result).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(built).toHaveLength(1);
    const d = built[0]!.delegation;
    expect(d).toStrictEqual({
      delegator: { type: 'Agent', id: AGENT_ID }, parent: PARENT_ID, delegate: SUBAGENT_ID, delegateKey: SUBAGENT.keyHash,
      actions: [hex('erp.stock.read')], resources: [hex('https://mock.example/t/run1/erp')], notBefore: expect.any(Number), notAfter: NOW + 3_600_000,
      depth: 2, remaining: 0, purpose: null, value: { perTx: 0n, total: 0n, periodMs: DAY },
    });
    expect(d.notBefore).toBeGreaterThanOrEqual(PARENT.notBefore);
    expect(d.notBefore).toBeLessThan(d.notAfter);
  });

  it('needs the signature of the live delegation key of the agent and of the delegation key of the subagent, and of no other key', async () => {
    const { built } = await run();
    expect(built[0]!.requiredSigners.map((s) => s.keyHash).sort()).toStrictEqual([AGENT.keyHash, SUBAGENT.keyHash].sort());
  });

  it('locks the ledger minimum for its datum, and pays a fee', async () => {
    const { built } = await run();
    expect(built[0]!.outputLovelace).toBeGreaterThan(1_000_000n);
    expect(built[0]!.outputLovelace).toBeLessThan(5_000_000n);
    expect(BigInt(built[0]!.fee)).toBeGreaterThan(100_000n);
    expect(BigInt(built[0]!.fee)).toBeLessThan(1_000_000n);
  });

  it('is refused by the real builder for a delegate key that the subagent does not list, and the refusal comes back with its words and nothing is sent', async () => {
    const { w, result } = await run({ subagentKey: UNLISTED });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_refused' }, end: { state: 'not_made' } });
    expect(result.kind === 'not_ready' && result.failure.detail).toMatch(/does not list the key/);
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('is refused by the real builder when the ledger has a parent with no further hop, although a read said that it has one', async () => {
    const { w, result } = await run({ ledger: { ...PARENT, remaining: 0 } });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_refused' }, end: { state: 'not_made' } });
    expect(result.kind === 'not_ready' && result.failure.detail).toMatch(/no further hop/);
    expect(w.chain.submitted).toHaveLength(0);
  });
});

describe('the keys sign the bytes that the real builder makes, and only those', () => {
  it('signs the real Delegate and the real Undelegate: both pass every rule of the transaction, and the fees and the deposit are far below their limits', async () => {
    const { result, built, undelegated, signed, w } = await run({ realUndelegate: true });
    expect(result).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended', txHash: undelegated[0]!.txHash } });
    expect(signed.slice(0, 2).sort()).toStrictEqual([AGENT.keyHash, SUBAGENT.keyHash].sort());
    expect(signed.slice(2)).toStrictEqual([AGENT.keyHash]);
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
    expect(BigInt(built[0]!.fee) * 2n).toBeLessThan(MAX_TX_FEE_LOVELACE);
    expect(BigInt(undelegated[0]!.fee) * 2n).toBeLessThan(MAX_TX_FEE_LOVELACE);
    expect(built[0]!.outputLovelace * 2n).toBeLessThan(MAX_DELEGATION_DEPOSIT_LOVELACE);
  });

  it('refuses the bytes of a second, wider build that come with the report of the narrow one: the probe of the review, and no key signs', async () => {
    const { result, built, signed, w } = await run({ lie: true });
    expect(built[0]!.delegation.actions).toStrictEqual([hex('erp.stock.read'), hex('po.write')]);
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch', detail: expect.stringContaining('byte for byte') }, end: { state: 'not_made' } });
    expect(signed).toStrictEqual([]);
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('refuses the real bytes of a Delegate for another delegation script, and signs them for the script of the deployment: the twin', async () => {
    const other = await run();
    expect(other.result.ok).toBe(true);
    const { context } = await world();
    const w = subWorld({
      parent: PARENT,
      request: { agent: { signer: counting(AGENT.keyHash, []), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: counting(SUBAGENT.keyHash, []) } },
    });
    w.chain.buildDelegate = async (params) => {
      const made = await buildDelegate(context, params);
      w.chain.adopt(made);
      return made;
    };
    expect(await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, idle))).toMatchObject({ ok: false, failure: { code: 'build_mismatch', detail: expect.stringContaining('does not mint exactly') }, end: { state: 'not_made' } });
  });
});

describe('the end of validity of the Delegate that the real builder makes', () => {
  it('is a TTL that is the slot of its reported end on the slot clock of the deployment, so the check passes with the rule of the deployment', async () => {
    const { result, built, w } = await run();
    expect(result).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    const { validTo, txCbor } = built[0]!;
    expect(validTo).toBe(NOW + 1_800_000);
    expect(CML.Transaction.from_cbor_hex(txCbor).body().ttl()).toBe(BigInt((validTo - ZERO_TIME) / 1000));
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it.each([[1n], [-1n]])('is refused when its bytes end %s slots from the slot of the report: no key signs and nothing is sent', async (moveTtl) => {
    const { result, signed, w } = await run({ moveTtl });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch', detail: expect.stringContaining('is not the slot of the end of validity') }, end: { state: 'not_made' } });
    expect(signed).toStrictEqual([]);
    expect(w.chain.submitted).toHaveLength(0);
  });

  it.each([[0], [999]])('is signed and sent when its report ends %i ms into the slot of the TTL: the twin', async (moveReport) => {
    const { result, signed, w } = await run({ moveReport });
    expect(result).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(signed.slice(0, 2).sort()).toStrictEqual([AGENT.keyHash, SUBAGENT.keyHash].sort());
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('is refused when its report ends one second after the slot of the TTL', async () => {
    const { result, signed, w } = await run({ moveReport: 1_000 });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch', detail: expect.stringContaining('is not the slot of the end of validity') }, end: { state: 'not_made' } });
    expect(signed).toStrictEqual([]);
    expect(w.chain.submitted).toHaveLength(0);
  });
});
