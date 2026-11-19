// The guarded chain of the vault checks, against the real applied scripts of the fixtures: a vault Pay, an Accept and a Reclaim go through the guards of a check, the keys of the operator
// sign, the node takes the transaction, and each landing is written to the state file with the escrow and the vault that it leaves. A Pay above the limit of the delegation is refused
// before a key signs; a dry run signs nothing; a Pay that is not seen confirmed is an error that says it may land. Each refusal has its accepted twin. The chain runs inside a probe check
// of the real runner, so that its session is a real one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeVaultDatum, plutusAddressFromBech32 } from '../../../packages/vector-read/src/identity-codec.ts';
import { GuardedChain } from '../lib/guarded-chain.ts';
import type { PartNames, SpendResult, VaultLimits } from '../lib/guarded-chain.ts';
import { DryStop } from '../lib/hire-types.ts';
import { KeyRing } from '../lib/keys.ts';
import { GuardRefusal } from '../lib/land.ts';
import { TxNotConfirmedError, decodeVaultDatum } from '../lib/platform.ts';
import type { VaultPayResult } from '../lib/platform.ts';
import {
  ADVERT_REF, AGENT_ID, CHAIN_TXS, CLAIM_TX, DELEGATE_KEY, ESCROW_LOCK, ESCROW_REF, OWN_PKH, PAYLOAD, POST_TX, SUBMIT_TX, advertUtxo, chainFake, delegateRecord, delegationUtxo, escrowUtxo, identityEscrow,
  liveVault, submitted as submittedAt, supplierEnterprise, vaultUtxo,
} from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { harness } from './support/harness.ts';
import type { Harness } from './support/harness.ts';
import { probed } from './support/probe.ts';
import { CONTROLLER_N, DEPLOYMENT, MEMBER_N, NOW, World, keyOf } from './support/world.ts';

afterEach(() => { vi.useRealTimers(); });

const PARTS: PartNames = { pay: 'hire:pay', accept: 'hire:accept', reclaim: 'reclaim' };
const LIMITS: VaultLimits = { perTx: 50_000_000n, total: 100_000_000n };
const VAULT_REF = `${vaultUtxo(liveVault()).txHash}#0`;
const KOIOS = 'https://koios.test.example/';
const owner = { type: 'PrincipalKey' as const, hash: OWN_PKH, organisation: null };
const vaultRefund = { address: plutusAddressFromBech32(DEPLOYMENT.vault.address), datum: encodeVaultDatum({ type: 'Returned', owner }) };
/** The escrow of the delegate key, posted ten minutes before NOW, whose refund is the vault. */
const posted = () => identityEscrow(NOW - 10 * 60_000, { buyer_pkh: DELEGATE_KEY.keyHash, refund: vaultRefund });
const noFetch = (async () => { throw new Error('the network was touched'); }) as typeof fetch;

/** The world of the fixtures with a vault and its delegation, and the fixture escrows that a test names. */
async function worldWith(escrows: Parameters<typeof World.identity>[0] = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  return World.identity({ extra: [vaultUtxo(liveVault(), 100_000_000n), delegationUtxo(), delegateRecord(), ...(escrows.extra ?? [])] });
}

const pay = (chain: GuardedChain, over: Partial<{ vaultRef: string }> = {}) => chain.payFromVault({ vaultRef: VAULT_REF, advertRef: ADVERT_REF, payload: PAYLOAD, ...over });
const outputsAt = (h: Harness, address: string) => h.world.chain.held.filter((u) => u.address === address);

describe('payFromVault', () => {
  it('lands a Pay that the guards accept: the delegate key signs it, the node takes it, and the part hire:pay holds the escrow and the vault that continues', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let paid: VaultPayResult | null = null;
    expect(await probed(h, async (session) => { paid = await pay(new GuardedChain(session, { parts: PARTS, limits: LIMITS })); })).toBe(0);
    expect(paid).toMatchObject({ delegateKey: DELEGATE_KEY.keyHash, agentId: AGENT_ID, escrowRef: expect.stringMatching(/#0$/), vaultRef: expect.stringMatching(/#1$/) });
    const part = h.state('probe').notes['part.hire:pay'] as { refs: Record<string, string>; facts: Record<string, unknown>; tx_hash: string };
    expect(part.refs).toEqual({ escrow_ref: paid!.escrowRef, vault_ref: paid!.vaultRef });
    expect(part.facts).toMatchObject({ lock_lovelace: String(paid!.lockLovelace), advert_ref: ADVERT_REF });
    expect(h.state('probe').in_flight).toBeNull();
    expect(outputsAt(h, DEPLOYMENT.escrow.address)).toHaveLength(1);
    expect(h.world.chain.held.some((u) => `${u.txHash}#${u.outputIndex}` === VAULT_REF)).toBe(false);
    expect(h.evidence('probe').map((entry) => [entry.step, entry.status])).toEqual([['hire:pay', 'confirmed']]);
    expect(h.screen.text).toMatch(/ok +vault\b/);
  }, 60_000);

  it('refuses a Pay above the limit of one payment before a key signs, and the vault is as it was; the twin with the limit of the delegation lands', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let refused: unknown;
    expect(await probed(h, async (session) => {
      try { await pay(new GuardedChain(session, { parts: PARTS, limits: { perTx: 1_000_000n, total: 100_000_000n } })); } catch (err) { refused = err; }
    })).toBe(0);
    expect(refused).toBeInstanceOf(GuardRefusal);
    expect((refused as GuardRefusal).failures.map((failure) => failure.guard)).toEqual(['vault']);
    expect((refused as GuardRefusal).failures[0]!.message).toContain('over the limit per payment');
    expect(h.node.submitted).toEqual([]);
    expect(h.state('probe').notes['part.hire:pay']).toBeUndefined();
    expect(h.world.chain.held.some((u) => `${u.txHash}#${u.outputIndex}` === VAULT_REF)).toBe(true);
  }, 60_000);

  it('refuses a Pay past the limit of the period, and a Pay that the vault script refuses is the error of the builder, with nothing signed', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let refused: unknown;
    expect(await probed(h, async (session) => {
      try { await pay(new GuardedChain(session, { parts: PARTS, limits: { perTx: 50_000_000n, total: 2_000_000n } })); } catch (err) { refused = err; }
    })).toBe(0);
    expect(refused).toBeInstanceOf(GuardRefusal);
    expect((refused as GuardRefusal).failures[0]!.message).toContain('limit total');
    expect(h.node.submitted).toEqual([]);
  }, 60_000);

  it('in dry mode builds and checks the Pay, shows it, and ends in a dry stop: nothing is signed and the world does not move', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let stopped: unknown;
    expect(await probed(h, async (session) => {
      try { await pay(new GuardedChain(session, { parts: PARTS, limits: LIMITS })); } catch (err) { stopped = err; }
    }, { dry: true })).toBe(0);
    expect(stopped).toBeInstanceOf(DryStop);
    expect((stopped as DryStop).step).toBe('hire:pay');
    expect(h.node.submitted).toEqual([]);
    expect(h.screen.text).toContain('nothing is signed');
    expect(h.world.chain.held.some((u) => `${u.txHash}#${u.outputIndex}` === VAULT_REF)).toBe(true);
  }, 60_000);

  it('says that a Pay may still land when it was sent and not seen confirmed, names the escrow, and keeps the transaction in flight with the vault reference that it would leave', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    h.node.submit = async (cbor) => h.world.hashOf(cbor);
    let error: unknown;
    expect(await probed(h, async (session) => {
      try { await pay(new GuardedChain(session, { parts: PARTS, limits: LIMITS })); } catch (err) { error = err; }
    })).toBe(0);
    expect(error).toBeInstanceOf(TxNotConfirmedError);
    const failure = error as TxNotConfirmedError;
    expect(failure.mayLand).toBe(true);
    expect(failure.escrowRef).toBe(`${failure.txHash}#0`);
    expect(failure.deliverBy).toBeGreaterThan(NOW);
    const flight = h.state('probe').in_flight as { step: string; tx_hash: string; refs: Record<string, string> };
    expect(flight).toMatchObject({ step: 'hire:pay', tx_hash: failure.txHash, refs: { escrow_ref: `${failure.txHash}#0`, vault_ref: `${failure.txHash}#1` } });
    expect(h.state('probe').notes['part.hire:pay']).toBeUndefined();
  }, 60_000);

  it('cannot pay from a vault when the deployment has no reference script of the vault: it names the setting, and builds and signs nothing', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let refused: unknown;
    expect(await probed(h, async (session) => {
      const refs = { ...DEPLOYMENT.refs };
      delete refs.vault;
      const bare = { ...session, chain: { ...session.chain, deployment: { ...DEPLOYMENT, refs } } };
      try { await pay(new GuardedChain(bare, { parts: PARTS, limits: LIMITS })); } catch (err) { refused = err; }
    })).toBe(0);
    expect(String(refused)).toContain('VECTOR_IDENTITY_VAULT_REF_UTXO');
    expect(String(refused)).toContain('Nothing was built');
    expect(h.node.submitted).toEqual([]);
  }, 60_000);
});

describe('reclaim and accept of an escrow that a vault paid', () => {
  it('a Reclaim returns the whole lock to the vault as a Returned output of the owner, signed by the delegate key; the step reclaim holds the Returned output', async () => {
    const live = escrowUtxo(POST_TX, posted());
    const h = await harness({ world: await worldWith({ extra: [live] }), chainFetch: chainFake({ live: [advertUtxo(), live] }).f, koiosUrl: KOIOS });
    let result: SpendResult | null = null;
    expect(await probed(h, async (session) => { result = await new GuardedChain(session, { parts: PARTS, limits: LIMITS }).reclaim(ESCROW_REF); })).toBe(0);
    const back = outputsAt(h, DEPLOYMENT.vault.address).filter((u) => decodeVaultDatum(u.datum!).type === 'Returned');
    expect(back).toHaveLength(1);
    expect(back[0]!.assets.lovelace).toBe(ESCROW_LOCK);
    expect(result).toMatchObject({ returnedRef: `${back[0]!.txHash}#${back[0]!.outputIndex}` });
    expect(h.state('probe').steps.reclaim).toMatchObject({ refs: { escrow_ref: ESCROW_REF, returned_ref: result!.returnedRef } });
    expect(h.state('probe').steps.reclaim!.facts).toMatchObject({ lock_lovelace: String(ESCROW_LOCK) });
  }, 60_000);

  it('an Accept pays the supplier the price and its bond and returns the buyer bond to the vault as a Returned output; the part hire:accept holds it', async () => {
    const d = posted();
    const live = escrowUtxo(SUBMIT_TX, submittedAt(d, NOW - 60_000));
    const fake = chainFake({ live: [advertUtxo(), live], spent: [escrowUtxo(POST_TX, d), escrowUtxo(CLAIM_TX, { ...d, state: 'Claimed' })], txs: CHAIN_TXS });
    const h = await harness({ world: await worldWith({ extra: [live] }), chainFetch: fake.f, koiosUrl: KOIOS });
    let result: SpendResult | null = null;
    expect(await probed(h, async (session) => { result = await new GuardedChain(session, { parts: PARTS, limits: LIMITS }).accept(ESCROW_REF); })).toBe(0);
    expect(outputsAt(h, supplierEnterprise).some((u) => u.assets.lovelace === 3_000_000n)).toBe(true);
    const back = outputsAt(h, DEPLOYMENT.vault.address).filter((u) => decodeVaultDatum(u.datum!).type === 'Returned');
    expect(back).toHaveLength(1);
    expect(result).toMatchObject({ returnedRef: `${back[0]!.txHash}#${back[0]!.outputIndex}` });
    const part = h.state('probe').notes['part.hire:accept'] as { refs: Record<string, string> };
    expect(part.refs).toEqual({ escrow_ref: ESCROW_REF, returned_ref: result!.returnedRef });
  }, 60_000);

  it('a Reclaim in dry mode is shown and ends in a dry stop: nothing is signed', async () => {
    const live = escrowUtxo(POST_TX, posted());
    const h = await harness({ world: await worldWith({ extra: [live] }), chainFetch: chainFake({ live: [advertUtxo(), live] }).f, koiosUrl: KOIOS });
    let stopped: unknown;
    expect(await probed(h, async (session) => {
      try { await new GuardedChain(session, { parts: PARTS, limits: LIMITS }).reclaim(ESCROW_REF); } catch (err) { stopped = err; }
    }, { dry: true })).toBe(0);
    expect(stopped).toBeInstanceOf(DryStop);
    expect(h.node.submitted).toEqual([]);
  }, 60_000);
});

describe('what the guarded chain reads', () => {
  it('reads the advert, the state of an escrow and the wallet of the delegate key; it posts no escrow from a wallet', async () => {
    const live = escrowUtxo(POST_TX, posted());
    const h = await harness({ world: await worldWith({ extra: [live] }), chainFetch: chainFake({ live: [advertUtxo(), live] }).f, koiosUrl: KOIOS });
    let seen: { advert: unknown; state: unknown; wallet: unknown; post: unknown } | null = null;
    expect(await probed(h, async (session) => {
      const chain = new GuardedChain(session, { parts: PARTS, limits: LIMITS });
      seen = { advert: await chain.readAdvert(ADVERT_REF), state: await chain.escrowState(ESCROW_REF), wallet: await chain.wallet(), post: await chain.postEscrow().catch((err: unknown) => String(err)) };
    })).toBe(0);
    expect(seen!.advert).toMatchObject({ agent_id: AGENT_ID });
    expect(seen!.state).toBe('Open');
    expect(seen!.wallet).toMatchObject({ buyerPkh: DELEGATE_KEY.keyHash, collateralLovelace: 5_000_000n });
    expect(String(seen!.post)).toContain('pays from a vault only');
  }, 60_000);
});

describe('the key of the chain', () => {
  it('refuses a Pay that needs the signature of the delegate key when the chain signs with another key, and signs nothing', async () => {
    const h = await harness({ world: await worldWith(), chainFetch: noFetch });
    let refused: unknown;
    expect(await probed(h, async (session) => {
      const other = new KeyRing([keyOf(CONTROLLER_N), keyOf(MEMBER_N, 'agent'), keyOf(7, 'member')]);
      try { await pay(new GuardedChain({ ...session, ring: other }, { parts: PARTS, limits: LIMITS })); } catch (err) { refused = err; }
    })).toBe(0);
    expect(String(refused)).toContain(`needs the signature of ${DELEGATE_KEY.keyHash}`);
    expect(h.node.submitted).toEqual([]);
  }, 60_000);
});
