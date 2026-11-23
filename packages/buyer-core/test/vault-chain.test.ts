// packages/buyer-core/test/vault-chain.test.ts
// RealChain pays an escrow from a vault (payFromVault), offline, against the real applied scripts. The node of these tests evaluates the scripts of a transaction for real (the
// evaluator that Lucid itself ships), and answers a validator that failed as Ogmios does (the 3010 with a 3012 inside), so a Pay that the vault script refuses fails as it fails on
// the node: VaultPayRefused, with the evaluation error and the draft transaction, before the Pay is signed. Covered: a Pay that the ledger accepts (built, evaluated by the node,
// signed with the delegate key, submitted, confirmed), a Pay above `per_tx` and one past `total` (never signed, never submitted, a typed refusal), what cannot be built, the key
// of the chain that must be the delegate key, no read of Koios or of the indexer, one transaction at a time, and the refund of a vault-paid escrow: an Accept and a Reclaim return to
// the vault as a Returned output. Each refusal has its accepted twin. Not covered offline: the vault script of the live deployment, and the node of the live chain.
import { createRequire } from 'node:module';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CML, SLOT_CONFIG_NETWORK, createCostModels, utxoToTransactionInput, utxoToTransactionOutput } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { decodeIdentityEscrowDatum, promptHashForPayload } from '@vsa/vector-read';
import { decodeVaultDatum, encodeVaultDatum, plutusAddressFromBech32 } from '@vsa/vector-read/identity-codec';
import type * as GuardedDecode from '@vsa/vector-read/guarded-decode';
import { TxNotConfirmedError, VaultPayImpossible, VaultPayRefused, buyerIdentityDeployment, buyerVaultDeployment, isLedgerRefusal, VAULT_PAY_VALID_MINUTES } from '../src/index.ts';
import { RealChain } from '../src/chain.ts';
import { OgmiosRpcError } from '../src/vendored/mcp-shared/provider.ts';
import { FixtureProvider, FIXTURE_TXHASH, fixtureProtocolParameters } from './fixtures/fixture-provider.ts';
import { CONFIG_SEED, CONFIG_UTXO, DAY, DEPLOYMENT, NOW, REF_UTXOS } from './fixtures/identity-world.ts';
import { PARENT_ID, twoHopWorld } from './fixtures/ledger-node.fixture.ts';
import type { IdentityDeployment } from '../src/vendored/mcp/identity-deployment.ts';
import {
  ADVERT_REF, AGENT_ID, CHAIN_TXS, CLAIM_TX, DELEGATE_KEY, DELEGATION_ID, ESCROW_LOCK, ESCROW_REF, IDENTITY_ADVERT, OWN_PKH, PAYLOAD, POST_TX, SUBMIT_TX, advertUtxo, agentRecord,
  chainFake, delegateRecord, delegation, delegationUtxo, escrowUtxo, identityEscrow, liveVault, submitted as submittedAt, supplierEnterprise, vaultUtxo,
} from './fixtures/escrow-identity.fixture.ts';

// The decoder of a transaction is the checked wrapper of vector-read. A test turns a fault of it on for the read of the Pay (paidEscrowOf of chain.ts) and for nothing else: the stack
// of the call says where it comes from, and the real function runs for every other call.
const decoding = vi.hoisted(() => ({ fault: false }));
vi.mock('@vsa/vector-read/guarded-decode', async (importOriginal) => {
  const actual = await importOriginal<typeof GuardedDecode>();
  return {
    ...actual,
    decodeTransaction: (hex: string) => {
      if (decoding.fault && (new Error('where').stack ?? '').includes('paidEscrowOf')) throw new Error('decode fault');
      return actual.decodeTransaction(hex);
    },
  };
});

afterEach(() => { vi.useRealTimers(); decoding.fault = false; });

// --- The evaluating node ------------------------------------------------------------------------------------------------------------
type Uplc = { eval_phase_two_raw: (...args: [Uint8Array, Uint8Array[], Uint8Array[], Uint8Array, bigint, bigint, bigint, bigint, number]) => Uint8Array[] };
/** The evaluator Lucid itself requires, resolved from Lucid's location: always the version Lucid pins, whatever else the lockfile holds. */
const UPLC = createRequire(createRequire(import.meta.url).resolve('@lucid-evolution/lucid'))('@lucid-evolution/uplc') as Uplc;
const TAGS = ['spend', 'mint', 'publish', 'withdraw', 'vote', 'propose'] as const;
/** The tip of the fixtures' chain at NOW: it starts at 1756485600000 and has a slot each second. */
const TIP_SLOT = (NOW - 1_756_485_600_000) / 1000;

/** The 3010 of Ogmios with the 3012 of the validator that failed, as the vendored provider raises it, with the text of the evaluator as the detail. */
function ogmiosRefusal(text: string): OgmiosRpcError {
  const place = /\b(Spend|Mint|Publish|Withdraw|Vote|Propose)\[(\d+)\]/.exec(text);
  const validator = { purpose: place === null ? 'spend' : place[1].toLowerCase(), index: place === null ? 0 : Number(place[2]) };
  const data = [{ validator, error: { code: 3012, message: 'Some of the scripts failed to evaluate to a positive outcome.', data: { validationError: text, traces: [] } } }];
  return new OgmiosRpcError('evaluateTransaction failed: 3010 Some scripts of the transactions terminated with error(s).', 'evaluateTransaction', 3010, 'Some scripts of the transactions terminated with error(s).', JSON.stringify(data), false);
}

/**
 * A node that holds the outputs it is given, evaluates scripts for real and says what a node says, and takes a submit. It records what it is asked, in order: `events` for the
 * order of the calls, `evaluations` for the transactions it evaluated, `submitted` for the signed transactions it was handed. A confirmation waits for `confirm`.
 */
class EvaluatingNode extends FixtureProvider {
  readonly events: string[] = [];
  readonly evaluations: string[] = [];
  readonly submitted: string[] = [];
  confirm: () => Promise<boolean> = async () => true;
  constructor(utxos: UTxO[]) { super([...REF_UTXOS, CONFIG_UTXO, ...utxos]); }
  async getNetworkTip(): Promise<{ slot: number; hash: string }> { return { slot: TIP_SLOT, hash: '' }; }
  async evaluateTx(txCborHex: string, additional: UTxO[] = []) {
    this.evaluations.push(txCborHex);
    this.events.push('evaluate');
    const params = fixtureProtocolParameters();
    const slot = SLOT_CONFIG_NETWORK.Mainnet;
    let results: Uint8Array[];
    try {
      results = UPLC.eval_phase_two_raw(
        Buffer.from(txCborHex, 'hex'), additional.map((u) => utxoToTransactionInput(u).to_cbor_bytes()), additional.map((u) => utxoToTransactionOutput(u).to_cbor_bytes()),
        createCostModels(params.costModels).to_cbor_bytes(), BigInt(params.maxTxExSteps), BigInt(params.maxTxExMem), BigInt(slot.zeroTime), BigInt(slot.zeroSlot), slot.slotLength,
      );
    } catch (err) {
      throw ogmiosRefusal(err instanceof Error ? err.message : String(err));
    }
    return results.map((bytes) => {
      const r = CML.LegacyRedeemer.from_cbor_bytes(bytes);
      return { ex_units: { mem: Number(r.ex_units().mem()), steps: Number(r.ex_units().steps()) }, redeemer_index: Number(r.index()), redeemer_tag: TAGS[r.tag()] };
    });
  }
  async submitTx(tx: string): Promise<string> {
    this.submitted.push(tx);
    this.events.push('submit');
    return CML.hash_transaction(CML.Transaction.from_cbor_hex(tx).body()).to_hex();
  }
  async awaitTx(): Promise<boolean> {
    this.events.push('await');
    const confirmed = await this.confirm();
    this.events.push('confirmed');
    return confirmed;
  }
}

// --- The world ------------------------------------------------------------------------------------------------------------------------
/** The private key of the delegate key of the fixtures: testKey(3) is made from 32 bytes of 3. */
const DELEGATE_PRIVATE_KEY = '03'.repeat(32);
/** The wallet of the delegate key: 1000 units, a pure 5-unit output (the collateral) and 10 units with a token. */
const walletAt = (address: string): UTxO[] => [
  { txHash: FIXTURE_TXHASH, outputIndex: 0, address, assets: { lovelace: 1_000_000_000n } },
  { txHash: FIXTURE_TXHASH, outputIndex: 1, address, assets: { lovelace: 5_000_000n } },
];
const delegateAddress = new RealChain(new FixtureProvider([]), { privateKeyHex: DELEGATE_PRIVATE_KEY }).address;
/** A fetch that must not be called: the Pay of a vault asks the node, and neither Koios nor the indexer. */
const noFetch = (async () => { throw new Error('the network was touched'); }) as typeof fetch;
const owner = { type: 'PrincipalKey' as const, hash: OWN_PKH, organisation: null };

/** What the node holds for a Pay: the wallet of the delegate key, the vault, its delegation, the delegate, the agent of the advert and the advert. */
const held = (over: { vault?: UTxO[]; delegationUtxo?: UTxO; delegate?: UTxO } = {}): UTxO[] => [
  ...walletAt(delegateAddress), ...(over.vault ?? [vaultUtxo(liveVault(), 100_000_000n)]), over.delegationUtxo ?? delegationUtxo(), over.delegate ?? delegateRecord(), agentRecord(), advertUtxo(),
];
const VAULT_REF = `${vaultUtxo(liveVault()).txHash}#0`;

function payChain(utxos: UTxO[] = held(), deployment: IdentityDeployment | null = DEPLOYMENT) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const node = new EvaluatingNode(utxos);
  const chain = new RealChain(node, { privateKeyHex: DELEGATE_PRIVATE_KEY, fetchImpl: noFetch, identityDeployment: deployment });
  const pay = (over: Partial<{ vaultRef: string; advertRef: string; payload: string }> = {}) => chain.payFromVault({ vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD, ...over });
  return { chain, node, pay };
}
/** What a promise rejects with; the test fails when it resolves. */
const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => expect.unreachable('the call resolved'), (err: unknown) => err);
/** A promise with its resolver. The package compiles for es2022, whose library has no Promise.withResolvers, so the executor form is the one that types here. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const outputsOf = (cborHex: string) => {
  const outs = CML.Transaction.from_cbor_hex(cborHex).body().outputs();
  return Array.from({ length: outs.len() }, (_, i) => {
    const o = outs.get(i);
    return { address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().toString()), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null };
  });
};
const requiredSigners = (cborHex: string): string[] => {
  const signers = CML.Transaction.from_cbor_hex(cborHex).body().required_signers();
  return signers === undefined ? [] : Array.from({ length: signers.len() }, (_, i) => signers.get(i).to_hex());
};

describe('RealChain.payFromVault accepted by the vault script', () => {
  it('builds the Pay without a limit check of its own, lets the node evaluate it, signs it with the delegate key, submits it and waits for the confirmation', async () => {
    const { chain, node, pay } = payChain();
    expect(chain.buyerPkh).toBe(DELEGATE_KEY.keyHash);
    const paid = await pay();
    expect(node.evaluations.length, 'the node was asked to evaluate the scripts').toBeGreaterThanOrEqual(1);
    expect(node.submitted).toHaveLength(1);
    expect(node.events.indexOf('evaluate')).toBeLessThan(node.events.indexOf('submit'));
    expect(node.events.indexOf('submit')).toBeLessThan(node.events.indexOf('await'));
    const signed = CML.Transaction.from_cbor_hex(node.submitted[0]);
    const txHash = CML.hash_transaction(signed.body()).to_hex();
    expect(paid.txHash).toBe(txHash);
    // The delegate key signs, and no other key.
    expect(requiredSigners(node.submitted[0])).toStrictEqual([DELEGATE_KEY.keyHash]);
    const witnesses = signed.witness_set().vkeywitnesses()!;
    expect(Array.from({ length: witnesses.len() }, (_, i) => witnesses.get(i).vkey().hash().to_hex())).toStrictEqual([DELEGATE_KEY.keyHash]);
    // Output 0 is the escrow for the delegate key, refunding to the vault as Returned { owner }; output 1 is the vault that continues.
    const [escrow, vault] = outputsOf(node.submitted[0]);
    expect(escrow.address).toBe(DEPLOYMENT.escrow.address);
    const datum = decodeIdentityEscrowDatum(escrow.datum!);
    expect([datum.buyer_pkh, datum.agent_id, datum.supplier_pkh, datum.prompt_hash, datum.state]).toStrictEqual([DELEGATE_KEY.keyHash, AGENT_ID, IDENTITY_ADVERT.supplier_pkh, promptHashForPayload(PAYLOAD), 'Open']);
    expect(datum.refund).toStrictEqual({ address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) });
    expect(escrow.lovelace).toBe(datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace);
    expect(vault.address).toBe(DEPLOYMENT.vault.address);
    expect(decodeVaultDatum(vault.datum!)).toMatchObject({ type: 'Live', delegation: DELEGATION_ID, spent: escrow.lovelace });
    expect(vault.lovelace).toBe(100_000_000n - escrow.lovelace);
    // What the result says.
    expect(paid).toMatchObject({
      escrowRef: `${txHash}#0`, vaultRef: `${txHash}#1`, lockLovelace: escrow.lovelace, vaultLovelace: vault.lovelace, spent: escrow.lovelace, newPeriod: true, agentId: AGENT_ID,
      supplierPkh: IDENTITY_ADVERT.supplier_pkh, promptHash: promptHashForPayload(PAYLOAD), delegateKey: DELEGATE_KEY.keyHash, deliverBy: datum.deliver_by, postedAt: datum.posted_at,
      limit: { perTx: 50_000_000n, total: 100_000_000n, periodMs: DAY },
    });
    expect(paid.feeLovelace).toBeGreaterThan(0n);
    // The Pay is valid for VAULT_PAY_VALID_MINUTES from its build, so that a Pay the wait gave up on can no longer land.
    expect(CML.Transaction.from_cbor_hex(node.submitted[0]).body().ttl()).toBeLessThanOrEqual(TIP_SLOT + VAULT_PAY_VALID_MINUTES * 60 + 1);
  }, 60_000);

  it('asks neither Koios nor the indexer: the advert is the node\'s, and it needs no listing (the fetch of the chain is never called)', async () => {
    const { pay, node } = payChain(held());
    await expect(pay()).resolves.toBeDefined();
    // noFetch throws when it is called, and the Pay completed: the advert came from the node, with no listing asked.
    expect(node.submitted).toHaveLength(1);
  }, 60_000);

  it('pays an advert that is not listed anywhere: the output on the node is enough', async () => {
    // The fixture world has no indexer at all; the same advert output is all that exists of it.
    const { pay } = payChain(held());
    await expect(pay({ advertRef: ADVERT_REF })).resolves.toMatchObject({ agentId: AGENT_ID });
  }, 60_000);
});

describe('RealChain.payFromVault refused by the vault script (VaultPayRefused: never signed, never submitted)', () => {
  /** The evidence of a refusal: the node's own words, the validator, and the draft that the node evaluated last, which spends the vault and pays the planned escrow. */
  function assertEvidence(error: unknown, node: EvaluatingNode): VaultPayRefused {
    expect(error).toBeInstanceOf(VaultPayRefused);
    const refused = error as VaultPayRefused;
    expect(error).not.toBeInstanceOf(VaultPayImpossible);
    expect(isLedgerRefusal(refused), 'the refusal is the ledger\'s, told by type').toBe(true);
    expect(refused.evaluationError).toBe('3010 Some scripts of the transactions terminated with error(s).');
    expect(refused.validators.map((v) => v.code)).toStrictEqual([3012]);
    expect(refused.validators[0].detail).toMatch(/\S/);
    expect(refused.draftTx).toBe(node.evaluations[node.evaluations.length - 1]);
    const [escrow] = outputsOf(refused.draftTx);
    expect([escrow.address, escrow.lovelace]).toStrictEqual([DEPLOYMENT.escrow.address, refused.attempt.amountLovelace]);
    const inputs = CML.Transaction.from_cbor_hex(refused.draftTx).body().inputs();
    expect(Array.from({ length: inputs.len() }, (_, i) => `${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`)).toContain(VAULT_REF);
    // Nothing was signed or sent: the draft has only the placeholder witnesses that Lucid adds to size it, none of them the key of the chain.
    expect(node.submitted).toStrictEqual([]);
    const witnesses = CML.Transaction.from_cbor_hex(refused.draftTx).witness_set().vkeywitnesses();
    for (let i = 0; witnesses !== undefined && i < witnesses.len(); i++) expect(witnesses.get(i).vkey().hash().to_hex()).not.toBe(DELEGATE_KEY.keyHash);
    return refused;
  }

  it('a Pay above per_tx is refused with the evaluation error and the draft transaction, and nothing is submitted; at per_tx the same Pay is paid', async () => {
    const tight = delegationUtxo(delegation({ value: { perTx: 1_000_000n, total: 100_000_000n, periodMs: DAY } }));
    const refusing = payChain(held({ delegationUtxo: tight }));
    const refused = assertEvidence(await rejection(refusing.pay()), refusing.node);
    expect(refused.attempt.amountLovelace).toBeGreaterThan(refused.attempt.limit.perTx);
    expect(refusing.node.events).not.toContain('submit');
    // The twin: the limit covers the lock, and the same chain, vault and advert pay.
    const lock = refused.attempt.amountLovelace;
    const accepting = payChain(held({ delegationUtxo: delegationUtxo(delegation({ value: { perTx: lock, total: 100_000_000n, periodMs: DAY } })) }));
    await expect(accepting.pay()).resolves.toMatchObject({ lockLovelace: lock });
    expect(accepting.node.submitted).toHaveLength(1);
  }, 120_000);

  it('a Pay past total in the running period is refused, and nothing is submitted; in a new period the same Pay is paid', async () => {
    const spentUp = payChain(held({ vault: [vaultUtxo(liveVault({ spent: 99_000_000n, periodStart: NOW - 3_600_000 }), 100_000_000n)] }));
    const refused = assertEvidence(await rejection(spentUp.pay()), spentUp.node);
    expect(refused.attempt.spent).toBeGreaterThan(refused.attempt.limit.total);
    expect(refused.attempt.newPeriod).toBe(false);
    // The twin: the period of the vault ended a day ago, so the spending counts from this Pay.
    const fresh = payChain(held({ vault: [vaultUtxo(liveVault({ spent: 99_000_000n, periodStart: NOW - 2 * DAY }), 100_000_000n)] }));
    await expect(fresh.pay()).resolves.toMatchObject({ newPeriod: true });
    expect(fresh.node.submitted).toHaveLength(1);
  }, 120_000);

  it('the queue of the chain goes on after a refusal: the next Pay is built, evaluated and paid', async () => {
    const world = held({ vault: [vaultUtxo(liveVault({ spent: 99_000_000n, periodStart: NOW - 3_600_000 }), 100_000_000n), vaultUtxo(liveVault(), 100_000_000n, 1)] });
    const { pay, node } = payChain(world);
    assertEvidence(await rejection(pay()), node);
    await expect(pay({ vaultRef: `${vaultUtxo(liveVault()).txHash}#1` })).resolves.toMatchObject({ newPeriod: true });
    expect(node.submitted).toHaveLength(1);
  }, 120_000);

  it('a delegation that names a parent with no output is refused by the node, and it is not impossible: the draft lacks the parent, the node evaluates it once, and nothing is submitted; with the parent the same Pay is paid', async () => {
    // The parent of the leaf was undelegated, so the chain has a gap. The builder does not judge it: the node judges the draft that lacks the parent.
    const gap = payChain([...walletAt(delegateAddress), ...twoHopWorld({ parent: false })]);
    const refused = assertEvidence(await rejection(gap.pay()), gap.node);
    expect(refused.attempt.missingParent).toStrictEqual({ missing: PARENT_ID, child: DELEGATION_ID });
    expect(gap.node.evaluations).toHaveLength(1);
    expect(gap.node.events).not.toContain('submit');
    // The twin: the parent has its output, and the same chain, vault and advert pay.
    const whole = payChain([...walletAt(delegateAddress), ...twoHopWorld()]);
    await expect(whole.pay()).resolves.toMatchObject({ agentId: AGENT_ID });
    expect(whole.node.submitted).toHaveLength(1);
  }, 120_000);
});

describe('RealChain.payFromVault cannot build (VaultPayImpossible, or a plain error, and nothing is signed)', () => {
  it('no_vault: a vault that the node does not hold; no_delegation: a delegation that ended, which is the case of a member that ends it; the held vault pays', async () => {
    const { pay, node } = payChain();
    const gone = await rejection(pay({ vaultRef: `${'ee'.repeat(32)}#0` }));
    expect(gone).toBeInstanceOf(VaultPayImpossible);
    expect((gone as VaultPayImpossible).reason).toBe('no_vault');
    const ended = payChain(held({ delegationUtxo: { ...delegationUtxo(), txHash: 'bb'.repeat(32), assets: { lovelace: 3_000_000n } } }));
    const none = await rejection(ended.pay());
    expect(none).toBeInstanceOf(VaultPayImpossible);
    expect((none as VaultPayImpossible).reason).toBe('no_delegation');
    expect(node.submitted).toStrictEqual([]);
    expect(ended.node.submitted).toStrictEqual([]);
    await expect(pay()).resolves.toMatchObject({ agentId: AGENT_ID });
  }, 120_000);

  it('a Pay of a chain whose key is not the delegate key is refused before it is signed, and says which keys must sign; the delegate\'s own chain pays', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const strangerKey = '07'.repeat(32);
    const stranger = new RealChain(new FixtureProvider([]), { privateKeyHex: strangerKey });
    const node = new EvaluatingNode([...walletAt(stranger.address), ...held().slice(2)]);
    const chain = new RealChain(node, { privateKeyHex: strangerKey, fetchImpl: noFetch, identityDeployment: DEPLOYMENT });
    const error = await rejection(chain.payFromVault({ vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD }));
    expect(String(error)).toContain(`needs the signature of ${DELEGATE_KEY.keyHash}, and this chain signs with ${stranger.buyerPkh} only`);
    expect(node.submitted).toStrictEqual([]);
    await expect(payChain().pay()).resolves.toMatchObject({ delegateKey: DELEGATE_KEY.keyHash });
  }, 120_000);

  it('a chain without the identity deployment cannot pay from a vault, says so with the names of the settings, and builds nothing', async () => {
    const node = new EvaluatingNode(held());
    const chain = new RealChain(node, { privateKeyHex: DELEGATE_PRIVATE_KEY, fetchImpl: noFetch });
    await expect(chain.payFromVault({ vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD })).rejects.toThrow(/VECTOR_IDENTITY_VAULT_REF_UTXO/);
    expect(node.events).toStrictEqual([]);
  });
});

describe('RealChain.payFromVault after the signature', () => {
  it('a Pay that Koios does not confirm is a TxNotConfirmedError with the escrow at output 0 and its deliver_by: it may land until its validity ends', async () => {
    const { pay, node } = payChain();
    node.confirm = async () => false;
    const error = await rejection(pay());
    expect(error).toBeInstanceOf(TxNotConfirmedError);
    const failure = error as TxNotConfirmedError;
    const signed = CML.Transaction.from_cbor_hex(node.submitted[0]);
    const txHash = CML.hash_transaction(signed.body()).to_hex();
    const datum = decodeIdentityEscrowDatum(outputsOf(node.submitted[0])[0].datum!);
    expect([failure.escrowRef, failure.txHash, failure.deliverBy, failure.mayLand]).toStrictEqual([`${txHash}#0`, txHash, datum.deliver_by, true]);
    expect(failure.validTo).toBeGreaterThan(NOW);
  }, 60_000);

  it('runs one transaction at a time: a second Pay does not touch the node until the first is confirmed', async () => {
    const { pay, node } = payChain(held({ vault: [vaultUtxo(liveVault(), 100_000_000n), vaultUtxo(liveVault(), 100_000_000n, 1)] }));
    const gate = deferred<boolean>();
    let confirmations = 0;
    node.confirm = () => (++confirmations === 1 ? gate.promise : Promise.resolve(true));
    const first = pay();
    const second = pay({ vaultRef: `${vaultUtxo(liveVault()).txHash}#1` });
    // The first Pay is built, evaluated, signed and submitted; the second waits in the queue of the chain.
    await vi.waitFor(() => expect(node.events).toContain('await'), { timeout: 30_000 });
    const evaluationsDuringTheWait = node.evaluations.length;
    // A genuine delay: that the second Pay does not start is an absence, which no signal can say. 300 ms is ample time for a Pay that did not wait for the queue to read the node.
    const pause = deferred<void>();
    setTimeout(pause.resolve, 300);
    await pause.promise;
    expect(node.evaluations.length, 'the second Pay has not reached the node').toBe(evaluationsDuringTheWait);
    gate.resolve(true);
    await Promise.all([first, second]);
    expect(node.submitted).toHaveLength(2);
    expect(node.events.filter((event) => event === 'submit')).toHaveLength(2);
    expect(node.events.indexOf('confirmed')).toBeLessThan(node.events.lastIndexOf('evaluate'));
  }, 120_000);
});

describe('the refund of an escrow that a vault paid returns to the vault (the real applied escrow script, evaluated offline)', () => {
  const IDENTITY_KOIOS = 'https://koios.test.example/';
  const vaultRefund = { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) };
  /** The escrow of the delegate key, posted ten minutes before NOW, whose refund is the vault. */
  const posted = () => identityEscrow(NOW - 10 * 60_000, { buyer_pkh: DELEGATE_KEY.keyHash, refund: vaultRefund });

  function refundChain(make: () => { node: UTxO[]; live: UTxO[]; spent?: UTxO[]; txs?: Record<string, Array<[string, string]>> }) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const o = make();
    const node = new EvaluatingNode([...walletAt(delegateAddress), agentRecord(), ...o.node]);
    const k = chainFake({ live: [advertUtxo(), ...o.live], spent: o.spent, txs: o.txs });
    return { node, chain: new RealChain(node, { privateKeyHex: DELEGATE_PRIVATE_KEY, koiosUrl: IDENTITY_KOIOS, fetchImpl: k.f, identityDeployment: DEPLOYMENT }) };
  }

  it('a Reclaim returns the whole lock to the vault address as a Returned output of the owner, signed by the delegate key and nobody else', async () => {
    const { chain, node } = refundChain(() => { const live = escrowUtxo(POST_TX, posted()); return { node: [live], live: [live] }; });
    await chain.reclaim(ESCROW_REF);
    expect(node.submitted).toHaveLength(1);
    const back = outputsOf(node.submitted[0]).filter((o) => o.address === DEPLOYMENT.vault.address);
    expect(back).toHaveLength(1);
    expect(back[0].lovelace).toBe(ESCROW_LOCK);
    expect(decodeVaultDatum(back[0].datum!)).toStrictEqual({ type: 'Returned', owner });
    // The refund is the output at the vault address: the transaction has that output and the change of the wallet, and no other.
    expect(outputsOf(node.submitted[0]).map((o) => o.address).sort()).toStrictEqual([DEPLOYMENT.vault.address, delegateAddress].sort());
    const witnesses = CML.Transaction.from_cbor_hex(node.submitted[0]).witness_set().vkeywitnesses()!;
    expect(Array.from({ length: witnesses.len() }, (_, i) => witnesses.get(i).vkey().hash().to_hex())).toStrictEqual([DELEGATE_KEY.keyHash]);
  }, 60_000);

  it('an Accept pays the supplier its price and bond, and returns the buyer bond to the vault as a Returned output', async () => {
    const { chain, node } = refundChain(() => {
      const d = posted();
      const live = escrowUtxo(SUBMIT_TX, submittedAt(d, NOW - 60_000));
      return { node: [live], live: [live], spent: [escrowUtxo(POST_TX, d), escrowUtxo(CLAIM_TX, { ...d, state: 'Claimed' })], txs: CHAIN_TXS };
    });
    await chain.accept(ESCROW_REF);
    const outs = outputsOf(node.submitted[0]);
    expect(outs.some((o) => o.address === supplierEnterprise && o.lovelace === 3_000_000n), 'price + supplier bond to the supplier key').toBe(true);
    const back = outs.filter((o) => o.address === DEPLOYMENT.vault.address);
    expect(back).toHaveLength(1);
    // The ledger minimum of the output with the Returned datum is above the buyer bond, and the output holds that minimum.
    expect(back[0].lovelace).toBeGreaterThanOrEqual(1_000_000n);
    expect(decodeVaultDatum(back[0].datum!)).toStrictEqual({ type: 'Returned', owner });
  }, 60_000);
});

describe('the deployment of a chain that pays from vaults', () => {
  const REF_TX = 'e0'.repeat(32);
  /** The settings of a buyer: the two deployment values, the escrow reference script and the policy the manifest publishes. The vault is the fourth, which a vault payer adds. */
  const THREE = {
    VECTOR_IDENTITY_LEGACY_ROOT: DEPLOYMENT.legacyRoot, VECTOR_IDENTITY_CONFIG_SEED: `${CONFIG_SEED.txHash}#${CONFIG_SEED.outputIndex}`, VECTOR_IDENTITY_ESCROW_REF_UTXO: `${REF_TX}#4`,
    IDENTITY_POLICY_ID: DEPLOYMENT.identity.hash,
  };
  const FOUR = { ...THREE, VECTOR_IDENTITY_VAULT_REF_UTXO: `${REF_TX}#3` };

  it('a chain made with buyerVaultDeployment pays from a vault: the deployment holds the vault script and its reference script, and the Pay is built, evaluated, signed and submitted', async () => {
    const deployment = buyerVaultDeployment(FOUR);
    expect(deployment.vault.hash).toBe(DEPLOYMENT.vault.hash);
    expect(deployment.refs.vault).toStrictEqual({ txHash: REF_TX, outputIndex: 3 });
    const { pay, node } = payChain(held(), deployment);
    await expect(pay()).resolves.toMatchObject({ delegateKey: DELEGATE_KEY.keyHash, vaultRef: expect.stringMatching(/#1$/) });
    expect(node.submitted).toHaveLength(1);
  }, 60_000);

  it('a chain made with buyerIdentityDeployment, which reads three settings, cannot pay from a vault: it says so with the name of the fourth setting, and builds and signs nothing', async () => {
    const deployment = buyerIdentityDeployment(FOUR);
    expect(deployment?.refs.vault).toBeUndefined();
    const { pay, node } = payChain(held(), deployment);
    const error = await rejection(pay());
    expect(String(error)).toContain('VECTOR_IDENTITY_VAULT_REF_UTXO');
    expect(String(error)).toContain('buyerVaultDeployment');
    expect(node.evaluations).toStrictEqual([]);
    expect(node.submitted).toStrictEqual([]);
    // The twin: the chain with the vault reference script pays.
    await expect(payChain(held(), buyerVaultDeployment(FOUR)).pay()).resolves.toMatchObject({ delegateKey: DELEGATE_KEY.keyHash });
  }, 120_000);
});

describe('the Pay is read before it is signed', () => {
  it('a fault of the decoder ends the call with nothing signed or submitted, so that no fault can follow a confirmed payment; without the fault the same Pay is submitted', async () => {
    const { pay, node } = payChain();
    decoding.fault = true;
    const error = await rejection(pay());
    expect(String(error)).toContain('decode fault');
    expect(node.submitted).toStrictEqual([]);
    expect(node.events).not.toContain('submit');
    decoding.fault = false;
    await expect(pay()).resolves.toMatchObject({ delegateKey: DELEGATE_KEY.keyHash });
    expect(node.submitted).toHaveLength(1);
  }, 120_000);
});
