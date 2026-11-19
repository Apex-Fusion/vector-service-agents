// packages/buyer-core/test/fake-chain-vault.test.ts
// The vault payment of FakeChain: what a Pay from a vault does to the vault, the escrow and the wallet, and what the vault script refuses. A Pay above `per_tx`, or past `total`, is a
// VaultPayRefused that the vendored judge calls a refusal of the ledger, with the evaluation error and the draft transaction, and nothing moves. A Pay that cannot be built is a
// VaultPayImpossible with its reason. A refund (Accept or Reclaim) of an escrow that a vault paid returns to the vault as a Returned output. Each refusal has its accepted twin.
import { describe, it, expect } from 'vitest';
import { promptHashForPayload } from '@vsa/vector-read';
import type { IdentityAdvertDatum } from '@vsa/vector-read';
import { DELIVER_BY_BUFFER_MS, FakeChain, VAULT_PAY_VALID_MINUTES, VaultPayImpossible, VaultPayNotEvaluated, VaultPayRefused, isLedgerRefusal } from '../src/index.ts';
import type { FakeChainOptions, VaultChain } from '../src/index.ts';

const T0 = 1_790_000_000_000;
const FEE = 500_000n;
const AGENT = 'ae'.repeat(32);
const SUPPLIER = 'cd'.repeat(28);
const ADVERT_REF = `${'a1'.repeat(32)}#0`;
const PAYLOAD = '{"order":"PO-1"}';
const DELEGATION = 'dd'.repeat(32);
const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
/** An advert of a template agent in the identity layout: price 2, both bonds 1, so a Pay locks 4 and the lock floor adds nothing the limit can see. */
const ADVERT: IdentityAdvertDatum = {
  supplier_pkh: SUPPLIER, capability_id: 'supplychain.order.accept.v1', model: 'order-desk-small', max_output_tokens: 256, max_processing_ms: 60_000,
  price_lovelace: 2_000_000n, supplier_bond_lovelace: 1_000_000n, buyer_bond_lovelace: 1_000_000n, endpoint_url: 'https://203.0.113.41', detail_uri: '',
  detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', advertised_at: T0 - 86_400_000, status: 'Active', agent_id: AGENT,
};

function setup(opts: Pick<FakeChainOptions, 'floatLovelace' | 'collateralLovelace'> & { adverts?: Record<string, IdentityAdvertDatum | never> } = {}) {
  const clock = { now: T0 };
  const { adverts, ...rest } = opts;
  const chain = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT, ...adverts }, clock: () => clock.now, prefix: 'vault-test/', ...rest });
  const vault = chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: LIMIT });
  const pay = (vaultRef = vault, advertRef = ADVERT_REF, payload = PAYLOAD) => chain.payFromVault({ vaultRef, advertRef, payload });
  return { chain, clock, vault, pay };
}
/** What a promise rejects with; the test fails when it resolves. */
const rejection = (promise: Promise<unknown>): Promise<unknown> => promise.then(() => expect.unreachable('the call resolved'), (err: unknown) => err);

describe('FakeChain pays an escrow from a vault', () => {
  it('is a VaultChain', () => {
    const chain: VaultChain = new FakeChain();
    expect(typeof chain.payFromVault).toBe('function');
    expect(FakeChain.VAULT_MIN_LOVELACE).toBe(1_271_450n);
  });

  it('takes the lock out of the vault and only the fee out of the wallet, opens the escrow at output 0 for the delegate key and keeps the vault at output 1 with the new spending', async () => {
    const { chain, pay, vault } = setup();
    const before = await chain.wallet();
    const paid = await pay();
    expect(paid.escrowRef).toBe(`${paid.txHash}#0`);
    expect(paid.vaultRef).toBe(`${paid.txHash}#1`);
    expect(paid).toMatchObject({
      lockLovelace: 4_000_000n, feeLovelace: FEE, vaultLovelace: 36_000_000n, spent: 4_000_000n, newPeriod: true, limit: LIMIT, agentId: AGENT, supplierPkh: SUPPLIER,
      promptHash: promptHashForPayload(PAYLOAD), delegateKey: chain.buyerPkh,
    });
    // Valid for VAULT_PAY_VALID_MINUTES from now: the window ends then, and deliver_by is that end + the supplier's window + the buffer; the period starts at the end of the window.
    const windowEnd = T0 + VAULT_PAY_VALID_MINUTES * 60_000;
    expect([paid.deliverBy, paid.periodStart, paid.postedAt]).toStrictEqual([windowEnd + ADVERT.max_processing_ms + DELIVER_BY_BUFFER_MS, windowEnd, T0]);
    expect(await chain.escrowState(paid.escrowRef)).toBe('Open');
    expect((await chain.wallet()).floatLovelace).toBe(before.floatLovelace - FEE);
    expect(chain.vault(vault)).toMatchObject({ kind: 'Live', consumed: true });
    expect(chain.vault(paid.vaultRef)).toMatchObject({ kind: 'Live', consumed: false, lovelace: 36_000_000n, spent: 4_000_000n, delegation: DELEGATION });
    const datum = chain.escrowDatum(paid.escrowRef)!;
    expect([datum.buyer_pkh, datum.supplier_pkh, datum.prompt_hash, datum.state, datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace]).toStrictEqual([
      chain.buyerPkh, SUPPLIER, promptHashForPayload(PAYLOAD), 'Open', 4_000_000n,
    ]);
  });

  it('a Pay is the next one from the vault that it left: the spending adds up inside the period, and the refs are the same on a new chain', async () => {
    const { pay } = setup();
    const first = await pay();
    const second = await pay(first.vaultRef);
    expect([second.spent, second.newPeriod, second.vaultLovelace]).toStrictEqual([8_000_000n, false, 32_000_000n]);
    expect(second.periodStart).toBe(first.periodStart);
    const again = setup();
    expect((await again.pay()).escrowRef).toBe(first.escrowRef);
  });
});

describe('the vault script refuses what the limits of the delegation do not allow (VaultPayRefused)', () => {
  const lockOf = 4_000_000n;

  it('a Pay above per_tx is refused with the evaluation error of the node, the validator and the draft transaction, and nothing moves; the same Pay at per_tx is paid', async () => {
    const tight = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, prefix: 'tight/' });
    const vaultRef = tight.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: { ...LIMIT, perTx: lockOf - 1n } });
    const floatBefore = (await tight.wallet()).floatLovelace;
    const refused = await rejection(tight.payFromVault({ vaultRef, advertRef: ADVERT_REF, payload: PAYLOAD }));
    expect(refused).toBeInstanceOf(VaultPayRefused);
    const error = refused as VaultPayRefused;
    expect(isLedgerRefusal(error)).toBe(true);
    expect(error.evaluationError).toBe('3010 Some scripts of the transactions terminated with error(s).');
    expect(error.validators).toHaveLength(1);
    expect(error.validators[0]).toMatchObject({ purpose: 'spend', index: 0, code: 3012, traces: ['above_per_tx'] });
    expect(error.validators[0].detail).toMatch(/above per_tx 3999999/);
    expect(error.attempt).toMatchObject({ amountLovelace: lockOf, vaultLovelace: 36_000_000n, spent: lockOf });
    expect(error.draftTx).toMatch(/^([0-9a-f]{2})+$/);
    expect(JSON.parse(Buffer.from(error.draftTx, 'hex').toString('utf8'))).toMatchObject({ draft: 'FakeChain', vault: vaultRef, advert: ADVERT_REF });
    // Nothing moved: the vault is the same output, no escrow exists, the wallet paid nothing.
    expect(tight.vault(vaultRef)).toMatchObject({ consumed: false, lovelace: 40_000_000n, spent: 0n });
    expect(tight.vaults()).toHaveLength(1);
    expect((await tight.wallet()).floatLovelace).toBe(floatBefore);
    // The accepted twin: the limit is the lock.
    const twin = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, prefix: 'tight/' });
    const twinVault = twin.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: { ...LIMIT, perTx: lockOf } });
    await expect(twin.payFromVault({ vaultRef: twinVault, advertRef: ADVERT_REF, payload: PAYLOAD })).resolves.toMatchObject({ lockLovelace: lockOf });
  });

  it('a Pay past total is refused inside the period, and nothing moves; it is paid in the next period, and a Pay at total is paid', async () => {
    const { chain, clock, pay, vault } = setup();
    const first = await pay(vault);
    const second = await pay(first.vaultRef);
    const third = await pay(second.vaultRef);
    expect(third.spent).toBe(12_000_000n);
    const floatBefore = (await chain.wallet()).floatLovelace;
    const refused = (await rejection(pay(third.vaultRef))) as VaultPayRefused;
    expect(refused).toBeInstanceOf(VaultPayRefused);
    expect(isLedgerRefusal(refused)).toBe(true);
    expect(refused.validators[0]).toMatchObject({ code: 3012, traces: ['above_total'] });
    expect(refused.attempt).toMatchObject({ spent: 16_000_000n, newPeriod: false });
    expect(chain.vault(third.vaultRef)).toMatchObject({ consumed: false, spent: 12_000_000n });
    expect((await chain.wallet()).floatLovelace).toBe(floatBefore);
    // The twin: a new period starts after periodMs, and the spending counts from this Pay again.
    clock.now = T0 + LIMIT.periodMs + 5 * 60_000;
    const next = await pay(third.vaultRef);
    expect([next.newPeriod, next.spent]).toStrictEqual([true, 4_000_000n]);
  });

  it('says a refusal of the ledger by its type, and a Pay that the node did not evaluate by another, so that nothing reads success from a text', () => {
    const notEvaluated = new VaultPayNotEvaluated('3004 something', [], '00', { amountLovelace: 1n, vaultLovelace: 1n, spent: 1n, periodStart: 0, newPeriod: true, limit: LIMIT }, new Error('x'));
    expect(isLedgerRefusal(notEvaluated)).toBe(false);
    expect(notEvaluated).not.toBeInstanceOf(VaultPayRefused);
  });
});

describe('what cannot be built is a VaultPayImpossible with its reason (nothing moves)', () => {
  const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
    const error = await rejection(promise);
    expect(error).toBeInstanceOf(VaultPayImpossible);
    expect(isLedgerRefusal(error)).toBe(false);
    return (error as VaultPayImpossible).reason;
  };

  it('no_vault: a vault that is not on the node, or was spent by an earlier Pay; the Pay from the vault that is there is paid', async () => {
    const { chain, pay, vault } = setup();
    expect(await reasonOf(pay(`${'ee'.repeat(32)}#0`))).toBe('no_vault');
    const paid = await pay(vault);
    expect(await reasonOf(pay(vault))).toBe('no_vault');
    await expect(pay(paid.vaultRef)).resolves.toMatchObject({ lockLovelace: 4_000_000n });
    expect(chain.vaults().filter((output) => !output.consumed)).toHaveLength(1);
  });

  it('vault_not_live: a Returned output pays nothing', async () => {
    const { chain, clock, pay, vault } = setup();
    const paid = await pay(vault);
    chain.markClaimed(paid.escrowRef);
    clock.now = paid.deliverBy + 2_000;
    await chain.reclaim(paid.escrowRef);
    const returned = chain.vaults().find((output) => output.kind === 'Returned')!;
    expect(await reasonOf(pay(returned.ref))).toBe('vault_not_live');
  });

  it('no_delegation: the principal ended the delegation, so no Pay under it is built; the same vault paid before', async () => {
    const { chain, pay, vault } = setup();
    const paid = await pay(vault);
    chain.endDelegation(DELEGATION);
    expect(await reasonOf(pay(paid.vaultRef))).toBe('no_delegation');
    expect(chain.vault(paid.vaultRef)).toMatchObject({ consumed: false });
  });

  it('no_advert: an advert the node does not hold, or one that is no identity advert; advert_terms: a fleet capability, which no vault can pay', async () => {
    const legacyRef = `${'a2'.repeat(32)}#0`;
    const fleetRef = `${'a3'.repeat(32)}#0`;
    const { agent_id: _agent, ...legacy } = ADVERT;
    const { pay } = setup({ adverts: { [legacyRef]: legacy as unknown as IdentityAdvertDatum, [fleetRef]: { ...ADVERT, capability_id: 'llm.text.generate.v1' } } });
    expect(await reasonOf(pay(undefined, `${'a9'.repeat(32)}#0`))).toBe('no_advert');
    expect(await reasonOf(pay(undefined, legacyRef))).toBe('no_advert');
    expect(await reasonOf(pay(undefined, fleetRef))).toBe('advert_terms');
    await expect(pay()).resolves.toMatchObject({ lockLovelace: 4_000_000n });
  });

  it('no_advert for a retired advert, buyer_is_supplier for the advert of the delegate key itself', async () => {
    const retiredRef = `${'a4'.repeat(32)}#0`;
    const ownRef = `${'a5'.repeat(32)}#0`;
    const probe = new FakeChain();
    const { pay } = setup({ adverts: { [retiredRef]: { ...ADVERT, status: 'Retired' }, [ownRef]: { ...ADVERT, supplier_pkh: probe.buyerPkh } } });
    expect(await reasonOf(pay(undefined, retiredRef))).toBe('no_advert');
    expect(await reasonOf(pay(undefined, ownRef))).toBe('buyer_is_supplier');
  });

  it('below_minimum: a Pay that would leave less than the ledger minimum in the vault is not built, and the one that leaves it is', async () => {
    const chain = new FakeChain({ adverts: { [ADVERT_REF]: ADVERT }, clock: () => T0, prefix: 'small/' });
    const small = chain.openVault({ delegation: DELEGATION, lovelace: 4_000_000n + FakeChain.VAULT_MIN_LOVELACE - 1n, limit: LIMIT });
    expect(await reasonOf(chain.payFromVault({ vaultRef: small, advertRef: ADVERT_REF, payload: PAYLOAD }))).toBe('below_minimum');
    const enough = chain.openVault({ delegation: DELEGATION, lovelace: 4_000_000n + FakeChain.VAULT_MIN_LOVELACE, limit: LIMIT });
    await expect(chain.payFromVault({ vaultRef: enough, advertRef: ADVERT_REF, payload: PAYLOAD })).resolves.toMatchObject({ vaultLovelace: FakeChain.VAULT_MIN_LOVELACE });
  });

  it('a wallet without a collateral output cannot pay from a vault: a plain error, nothing moves; with one it pays', async () => {
    const { chain, pay, vault } = setup({ collateralLovelace: null });
    const error = await rejection(pay(vault));
    expect(error).not.toBeInstanceOf(VaultPayImpossible);
    expect(String(error)).toMatch(/Collateral required/);
    expect(chain.vault(vault)).toMatchObject({ consumed: false });
    await expect(setup().pay()).resolves.toMatchObject({ lockLovelace: 4_000_000n });
  });
});

describe('a refund of an escrow that a vault paid returns to the vault as a Returned output', () => {
  it('an Accept pays the supplier its price and bond out of the escrow, returns the buyer bond to the vault, and the wallet pays only the fee', async () => {
    const { chain, pay, vault } = setup();
    const paid = await pay(vault);
    chain.markClaimed(paid.escrowRef);
    chain.markSubmitted(paid.escrowRef, 'cd'.repeat(32));
    const before = (await chain.wallet()).floatLovelace;
    const accepted = await chain.accept(paid.escrowRef);
    expect(accepted.feeLovelace).toBe(FEE);
    expect(await chain.escrowState(paid.escrowRef)).toBe('spent');
    expect((await chain.wallet()).floatLovelace).toBe(before - FEE);
    const returned = chain.vaults().filter((output) => output.kind === 'Returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ lovelace: 1_000_000n, delegation: DELEGATION, consumed: false, ref: `${accepted.txHash}#1` });
  });

  it('a Reclaim from the first whole second after deliver_by returns the whole lock to the vault, and the wallet pays only the fee; before that it is refused', async () => {
    const { chain, clock, pay, vault } = setup();
    const paid = await pay(vault);
    const before = (await chain.wallet()).floatLovelace;
    clock.now = paid.deliverBy - 1_000;
    await expect(chain.reclaim(paid.escrowRef)).rejects.toThrow(/opens at/);
    expect(chain.vaults().filter((output) => output.kind === 'Returned')).toHaveLength(0);
    clock.now = paid.deliverBy + 1_000;
    const reclaimed = await chain.reclaim(paid.escrowRef);
    expect((await chain.wallet()).floatLovelace).toBe(before - FEE);
    const returned = chain.vaults().filter((output) => output.kind === 'Returned');
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ lovelace: paid.lockLovelace, delegation: DELEGATION, ref: `${reclaimed.txHash}#1` });
    // The refund is not the Live vault: the Live vault keeps what the Pay left, and `spent` never falls.
    expect(chain.vault(paid.vaultRef)).toMatchObject({ kind: 'Live', lovelace: 36_000_000n, spent: 4_000_000n });
  });

  it('a Post from the wallet is unchanged: its lock comes back to the wallet and no vault output exists', async () => {
    // An advert whose price and bonds fit the lock that FakeChain gives every Post.
    const cheapRef = `${'a6'.repeat(32)}#0`;
    const { chain, clock } = setup({ adverts: { [cheapRef]: { ...ADVERT, price_lovelace: 200_000n } } });
    const posted = await chain.postEscrow({ advertRef: cheapRef, promptHash: promptHashForPayload(PAYLOAD) });
    expect((await chain.wallet()).floatLovelace).toBe(50_000_000n - FakeChain.LOCK_LOVELACE - FEE);
    clock.now = posted.deliverBy + 1_000;
    await chain.reclaim(posted.escrowRef);
    expect((await chain.wallet()).floatLovelace).toBe(50_000_000n - 2n * FEE);
    expect(chain.vaults().filter((output) => output.kind === 'Returned')).toHaveLength(0);
  });
});

describe('the world hooks', () => {
  it('openVault refuses a second vault under the same delegation with another limit, and a vault below the ledger minimum; endDelegation refuses an unknown delegation', () => {
    const chain = new FakeChain();
    chain.openVault({ delegation: DELEGATION, lovelace: 5_000_000n, limit: LIMIT });
    expect(() => chain.openVault({ delegation: DELEGATION, lovelace: 5_000_000n, limit: { ...LIMIT, total: 1n } })).toThrow(/another value limit/);
    expect(() => chain.openVault({ delegation: 'ee'.repeat(32), lovelace: 1n, limit: LIMIT })).toThrow(/at least 1271450/);
    expect(() => chain.endDelegation('ff'.repeat(32))).toThrow(/no delegation/);
    expect(chain.openVault({ delegation: DELEGATION, lovelace: 5_000_000n, limit: { ...LIMIT } })).toMatch(/^[0-9a-f]{64}#0$/);
  });
});
