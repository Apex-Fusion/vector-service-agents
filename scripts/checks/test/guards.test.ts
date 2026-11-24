// The guards of a step. Each guard judges the facts of the transaction bytes, before any signature. Each refusal has an accepted twin.
import { describe, expect, it } from 'vitest';
import { encodeVaultDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { KeyRing } from '../lib/keys.ts';
import { failed, runGuards } from '../lib/guards.ts';
import type { GuardName, RingView, StepPlan } from '../lib/guards.ts';
import { factsOf } from '../lib/txfacts.ts';
import type { TxFacts } from '../lib/txfacts.ts';
import type { Utxo } from '../lib/platform.ts';
import { AGENT_N, DEPLOYMENT, MEMBER_N, World, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);
const ring = new KeyRing([member, agent]);
const STRANGER = 'addr1qylasu4y34ccwt8hv55tkswa9fthtck9xtppvc4y03kwhaztd0jlxdzk72zj8mgy6x4269v9gytkgffh3k8d3l8987yqu5c35z';
const SCRIPT_ADDRESS = DEPLOYMENT.delegation.address;
const HASH = 'ab'.repeat(32);
const ref = (n: number, i = 0): string => `${n.toString(16).padStart(2, '0').repeat(32)}#${i}`;

const facts = (over: Partial<TxFacts> = {}): TxFacts => ({
  bodyHex: 'a4', txHash: HASH, feeLovelace: 400_000n, validityEndSlot: null, inputs: [], collateralInputs: [], referenceInputs: [], outputs: [], collateralReturn: null, totalCollateral: null,
  requiredSigners: [], mint: {}, withdrawals: 0, certificates: 0, runsScripts: false, witnesses: [], ...over,
});
const output = (index: number, address: string, lovelace: bigint, over: Partial<TxFacts['outputs'][number]> = {}): TxFacts['outputs'][number] => ({
  index, address, lovelace, assets: {}, inlineDatum: null, datumHash: null, hasScriptRef: false, ...over,
});
const utxo = (reference: string, address: string, lovelace: bigint, over: Partial<Utxo> = {}): Utxo => ({
  txHash: reference.slice(0, 64), outputIndex: Number(reference.slice(65)), address, assets: { lovelace }, ...over,
});
const plan = (over: Partial<StepPlan> = {}): StepPlan => ({
  maxFeeLovelace: 2_000_000n, maxOutflow: { [member.keyHash]: 10_000_000n }, maxCollateralLossLovelace: 5_000_000n, explained: new Set(), destinations: new Set(), mint: {}, labels: {}, ...over,
});
const claims = { txHash: HASH, feeLovelace: 400_000n };
/** The results of the guards for a transaction, by guard name. */
function judge(f: TxFacts, inputs: Utxo[], p: StepPlan = plan(), c = claims, r: KeyRing = ring): Record<GuardName, { ok: boolean; message: string }> {
  return Object.fromEntries(runGuards({ facts: f, claims: c, inputs, plan: p, ring: r }).map((g) => [g.guard, { ok: g.ok, message: g.message }])) as Record<GuardName, { ok: boolean; message: string }>;
}
const walletInput = (n: number, lovelace = 20_000_000n) => utxo(ref(n), member.address, lovelace);

describe('runGuards', () => {
  it('gives each guard one result, and a transaction that keeps every rule passes all of them', () => {
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)], requiredSigners: [member.keyHash] });
    const results = runGuards({ facts: tx, claims, inputs: [walletInput(1)], plan: plan(), ring });
    expect(results.map((g) => g.guard).sort()).toEqual(['body', 'collateral', 'destinations', 'fee', 'inputs', 'mint', 'nothing_else', 'outflow', 'signers', 'vault'].sort());
    expect(failed(results)).toEqual([]);
  });
  it('takes a ring that is any object with the key hashes, the wallets and a name for each key', () => {
    const named: RingView = { keyHashes: () => new Set([member.keyHash]), wallets: () => new Map([[member.keyHash, member.address]]), roleOf: (keyHash) => (keyHash === member.keyHash ? 'run' : undefined) };
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)], requiredSigners: [member.keyHash] });
    const results = runGuards({ facts: tx, claims, inputs: [walletInput(1)], plan: plan(), ring: named });
    expect(failed(results)).toEqual([]);
    expect(results.find((g) => g.guard === 'signers')?.message).toContain(`run ${member.keyHash}`);
    expect(results.find((g) => g.guard === 'outflow')?.message).toContain(`the run wallet ${member.keyHash}`);
  });
});

describe('body', () => {
  it('refuses a hash or a fee that is not the one the builder gave, and accepts the same', () => {
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(tx, [walletInput(1)]).body.ok).toBe(true);
    const wrongHash = judge(tx, [walletInput(1)], plan(), { ...claims, txHash: 'cd'.repeat(32) }).body;
    expect(wrongHash.ok).toBe(false);
    expect(wrongHash.message).toContain('the hash of the bytes');
    expect(judge(tx, [walletInput(1)], plan(), { ...claims, feeLovelace: 1n }).body.message).toContain('fee');
  });
});

describe('fee', () => {
  it('refuses a fee over the limit of the step, and accepts a fee at the limit', () => {
    const tx = (fee: bigint) => facts({ feeLovelace: fee, inputs: [ref(1)], outputs: [output(0, member.address, 20_000_000n - fee)] });
    expect(judge(tx(2_000_000n), [walletInput(1)], plan(), { ...claims, feeLovelace: 2_000_000n }).fee.ok).toBe(true);
    const over = judge(tx(2_000_001n), [walletInput(1)], plan(), { ...claims, feeLovelace: 2_000_001n }).fee;
    expect(over.ok).toBe(false);
    expect(over.message).toContain('2.000001 units');
  });
});

describe('signers', () => {
  it('refuses a transaction that needs the signature of a key that the operator did not give, and accepts it when the operator gave it', () => {
    const outsider = new KeyRing([member]);
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: [output(0, member.address, 29_600_000n)] });
    const inputs = [walletInput(1), utxo(ref(2), agent.address, 10_000_000n)];
    const refused = judge(tx, inputs, plan(), claims, outsider).signers;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain(agent.keyHash);
    expect(judge(tx, inputs).signers.ok).toBe(true);
  });
  it('refuses a required signer that is not one of the keys, and a collateral input of a key that is not', () => {
    const stranger = '11'.repeat(28);
    expect(judge(facts({ inputs: [ref(1)], requiredSigners: [stranger], outputs: [output(0, member.address, 19_600_000n)] }), [walletInput(1)]).signers.message).toContain(stranger);
    const tx = facts({ inputs: [ref(1)], collateralInputs: [ref(3)], runsScripts: true, outputs: [output(0, member.address, 19_600_000n)] });
    const refused = judge(tx, [walletInput(1), utxo(ref(3), STRANGER, 5_000_000n)]).signers;
    expect(refused.ok).toBe(false);
  });
  it('needs no key for an input at a script', () => {
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: [output(0, member.address, 24_600_000n)] });
    expect(judge(tx, [walletInput(1), utxo(ref(2), SCRIPT_ADDRESS, 5_000_000n)], plan({ explained: new Set([ref(2)]) })).signers.ok).toBe(true);
  });
});

describe('inputs', () => {
  it('refuses an output that the state does not explain, unless it is a plain output of a wallet of the keys, and accepts it when the state explains it', () => {
    const tx = facts({ inputs: [ref(1), ref(2)], outputs: [output(0, member.address, 24_600_000n)] });
    const script = utxo(ref(2), SCRIPT_ADDRESS, 5_000_000n, { datum: 'd87980' });
    const refused = judge(tx, [walletInput(1), script]).inputs;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain(ref(2));
    expect(judge(tx, [walletInput(1), script], plan({ explained: new Set([ref(2)]) })).inputs.ok).toBe(true);
  });
  it('does not take a wallet output with a datum or a script for a plain output', () => {
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(tx, [utxo(ref(1), member.address, 20_000_000n, { datum: 'd87980' })]).inputs.ok).toBe(false);
    expect(judge(tx, [utxo(ref(1), member.address, 20_000_000n, { datumHash: 'ab'.repeat(32) })]).inputs.ok).toBe(false);
    expect(judge(tx, [utxo(ref(1), member.address, 20_000_000n)]).inputs.ok).toBe(true);
  });
  it('refuses an input at an address of another key, and an input that cannot be read', () => {
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(tx, [utxo(ref(1), STRANGER, 20_000_000n)]).inputs.ok).toBe(false);
    const missing = judge(tx, []).inputs;
    expect(missing.ok).toBe(false);
    expect(missing.message).toContain('could not be read');
  });
  it('holds the collateral inputs to the same rule', () => {
    const tx = facts({ inputs: [ref(1)], collateralInputs: [ref(3)], runsScripts: true, outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(tx, [walletInput(1), utxo(ref(3), SCRIPT_ADDRESS, 5_000_000n)]).inputs.ok).toBe(false);
    expect(judge(tx, [walletInput(1), utxo(ref(3), member.address, 5_000_000n)]).inputs.ok).toBe(true);
  });
});

describe('destinations', () => {
  it('refuses an output to an address that the step does not name, and accepts the wallets of the keys and the addresses of the step', () => {
    const to = (address: string) => facts({ inputs: [ref(1)], outputs: [output(0, address, 5_000_000n), output(1, member.address, 14_600_000n)] });
    const refused = judge(to(STRANGER), [walletInput(1)]).destinations;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain(STRANGER);
    expect(judge(to(agent.address), [walletInput(1)]).destinations.ok).toBe(true);
    expect(judge(to(SCRIPT_ADDRESS), [walletInput(1)]).destinations.ok).toBe(false);
    expect(judge(to(SCRIPT_ADDRESS), [walletInput(1)], plan({ destinations: new Set([SCRIPT_ADDRESS]) })).destinations.ok).toBe(true);
  });
  it('holds the collateral return to the same rule', () => {
    const tx = (address: string) => facts({ inputs: [ref(1)], collateralInputs: [ref(3)], runsScripts: true, collateralReturn: { address, lovelace: 4_000_000n }, outputs: [output(0, member.address, 19_600_000n)] });
    const inputs = [walletInput(1), utxo(ref(3), member.address, 5_000_000n)];
    expect(judge(tx(STRANGER), inputs).destinations.ok).toBe(false);
    expect(judge(tx(member.address), inputs).destinations.ok).toBe(true);
  });
});

describe('outflow', () => {
  const pay = (lovelace: bigint) => facts({ inputs: [ref(1)], outputs: [output(0, agent.address, lovelace), output(1, member.address, 20_000_000n - lovelace - 400_000n)] });
  it('refuses more than the step lets leave a wallet, and accepts what is within the limit, the fee counted', () => {
    // The member wallet gives 9.6 units to the agent wallet and 0.4 units of fee: 10 units leave it, which is the limit.
    expect(judge(pay(9_600_000n), [walletInput(1)]).outflow.ok).toBe(true);
    const over = judge(pay(9_600_001n), [walletInput(1)]).outflow;
    expect(over.ok).toBe(false);
    expect(over.message).toContain(member.keyHash);
  });
  it('lets a wallet that the step does not name gain, and refuses it to lose', () => {
    const fromAgent = facts({ inputs: [ref(2)], outputs: [output(0, member.address, 1_000_000n), output(1, agent.address, 18_600_000n)] });
    const inputs = [utxo(ref(2), agent.address, 20_000_000n)];
    const refused = judge(fromAgent, inputs).outflow;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain(agent.keyHash);
    expect(judge(fromAgent, inputs, plan({ maxOutflow: { [agent.keyHash]: 1_500_000n } })).outflow.ok).toBe(true);
  });
  it('counts a gain as no outflow: the return of a deposit passes with a limit of nothing', () => {
    const back = facts({ inputs: [ref(1), ref(2)], outputs: [output(0, member.address, 24_600_000n)] });
    const inputs = [walletInput(1, 20_000_000n), utxo(ref(2), SCRIPT_ADDRESS, 5_000_000n)];
    expect(judge(back, inputs, plan({ maxOutflow: {}, explained: new Set([ref(2)]) })).outflow.ok).toBe(true);
  });
  it('refuses an asset that leaves a wallet', () => {
    const unit = `${'aa'.repeat(28)}746f6b656e`;
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n), output(1, agent.address, 1_000_000n, { assets: { [unit]: 5n } })] });
    const refused = judge(tx, [utxo(ref(1), member.address, 20_600_000n, { assets: { lovelace: 20_600_000n, [unit]: 5n } })]).outflow;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('746f6b656e');
    const kept = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 20_200_000n, { assets: { [unit]: 5n } })] });
    expect(judge(kept, [utxo(ref(1), member.address, 20_600_000n, { assets: { lovelace: 20_600_000n, [unit]: 5n } })]).outflow.ok).toBe(true);
  });
});

describe('collateral', () => {
  const script = (collateralReturn: TxFacts['collateralReturn']) => facts({ inputs: [ref(1)], collateralInputs: [ref(3)], runsScripts: true, collateralReturn, outputs: [output(0, member.address, 19_600_000n)] });
  const inputs = [walletInput(1), utxo(ref(3), member.address, 5_000_000n)];
  it('counts what a failed script takes: the collateral that no return gives back, and refuses it above the limit of the step', () => {
    const refused = judge(script(null), inputs, plan({ maxCollateralLossLovelace: 4_999_999n })).collateral;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('5.000000 units');
    expect(judge(script(null), inputs, plan({ maxCollateralLossLovelace: 5_000_000n })).collateral.ok).toBe(true);
  });
  it('counts only what the return does not give back', () => {
    const returned = script({ address: member.address, lovelace: 4_100_000n });
    expect(judge(returned, inputs, plan({ maxCollateralLossLovelace: 900_000n })).collateral.ok).toBe(true);
    expect(judge(returned, inputs, plan({ maxCollateralLossLovelace: 899_999n })).collateral.ok).toBe(false);
  });
  it('does not count collateral for a transaction that runs no script', () => {
    const plain = facts({ inputs: [ref(1)], collateralInputs: [ref(3)], runsScripts: false, outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(plain, inputs, plan({ maxCollateralLossLovelace: 1n })).collateral.ok).toBe(true);
  });
});

describe('mint', () => {
  const unit = `${DEPLOYMENT.delegation.hash}${'aa'.repeat(32)}`;
  it('refuses a mint that is not the one of the step, and accepts it', () => {
    const tx = (mint: Record<string, bigint>) => facts({ inputs: [ref(1)], mint, outputs: [output(0, member.address, 19_600_000n)] });
    expect(judge(tx({ [unit]: 1n }), [walletInput(1)], plan({ mint: { [unit]: 1n } })).mint.ok).toBe(true);
    expect(judge(tx({}), [walletInput(1)], plan({ mint: { [unit]: 1n } })).mint.ok).toBe(false);
    expect(judge(tx({ [unit]: 2n }), [walletInput(1)], plan({ mint: { [unit]: 1n } })).mint.ok).toBe(false);
    expect(judge(tx({ [unit]: 1n, [`${unit}bb`]: 1n }), [walletInput(1)], plan({ mint: { [unit]: 1n } })).mint.ok).toBe(false);
    expect(judge(tx({ [unit]: 1n }), [walletInput(1)], plan()).mint.ok).toBe(false);
    expect(judge(tx({ [unit]: -1n }), [walletInput(1)], plan({ mint: { [unit]: -1n } })).mint.ok).toBe(true);
  });
});

describe('nothing_else', () => {
  it('refuses a withdrawal and a certificate, and accepts a transaction with neither', () => {
    const tx = (over: Partial<TxFacts>) => facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)], ...over });
    expect(judge(tx({}), [walletInput(1)]).nothing_else.ok).toBe(true);
    expect(judge(tx({ withdrawals: 1 }), [walletInput(1)]).nothing_else.ok).toBe(false);
    expect(judge(tx({ certificates: 2 }), [walletInput(1)]).nothing_else.ok).toBe(false);
  });
  it('accepts the withdrawals that the step names and refuses any other number, and the message names both numbers', () => {
    const tx = (withdrawals: number) => facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)], withdrawals });
    expect(judge(tx(1), [walletInput(1)], plan({ withdrawals: 1 })).nothing_else.ok).toBe(true);
    expect(judge(tx(2), [walletInput(1)], plan({ withdrawals: 2 })).nothing_else.ok).toBe(true);
    const more = judge(tx(2), [walletInput(1)], plan({ withdrawals: 1 })).nothing_else;
    expect(more.ok).toBe(false);
    expect(more.message).toBe('the transaction has 2 withdrawal(s) and 0 certificate(s), and the step has 1 withdrawal(s) and no certificate');
    expect(judge(tx(0), [walletInput(1)], plan({ withdrawals: 1 })).nothing_else.ok).toBe(false);
    expect(judge(tx(1), [walletInput(1)], plan({ withdrawals: 0 })).nothing_else.ok).toBe(false);
    const unnamed = judge(tx(1), [walletInput(1)]).nothing_else;
    expect(unnamed.ok).toBe(false);
    expect(unnamed.message).toBe('the transaction has 1 withdrawal(s) and 0 certificate(s), and the step has none');
  });
  it('refuses every certificate, also when the step names withdrawals', () => {
    const tx = (over: Partial<TxFacts>) => facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)], ...over });
    expect(judge(tx({ withdrawals: 1 }), [walletInput(1)], plan({ withdrawals: 1 })).nothing_else.ok).toBe(true);
    expect(judge(tx({ withdrawals: 1, certificates: 1 }), [walletInput(1)], plan({ withdrawals: 1 })).nothing_else.ok).toBe(false);
    expect(judge(tx({ withdrawals: 0, certificates: 1 }), [walletInput(1)], plan({ withdrawals: 0 })).nothing_else.ok).toBe(false);
    expect(judge(tx({ withdrawals: 0, certificates: 1 }), [walletInput(1)]).nothing_else.ok).toBe(false);
  });
});

describe('vault', () => {
  const vaultAddress = DEPLOYMENT.vault.address;
  const escrowAddress = DEPLOYMENT.escrow.address;
  const owner = { type: 'PrincipalKey' as const, hash: member.keyHash, organisation: null };
  const live = (spent: bigint) => encodeVaultDatum({ type: 'Live', owner, delegation: 'dd'.repeat(32), spent, periodStart: 1_000 });
  const vaultPlan = (perTx: bigint, total: bigint) => plan({
    maxOutflow: {}, explained: new Set([ref(4)]), destinations: new Set([vaultAddress, escrowAddress]),
    vault: { address: vaultAddress, escrowAddress, perTx, total },
  });
  /** A Pay: the vault gives `lock` to an escrow and keeps the rest, and its datum says what it has paid. */
  const pay = (lock: bigint, spent: bigint, vaultHeld = 10_000_000n) => ({
    tx: facts({ inputs: [ref(4)], outputs: [output(0, escrowAddress, lock, { inlineDatum: 'd87980' }), output(1, vaultAddress, vaultHeld - lock, { inlineDatum: live(spent) })] }),
    inputs: [utxo(ref(4), vaultAddress, vaultHeld, { datum: live(spent - lock) })],
  });
  it('refuses a payment above the limit per payment, and accepts one at the limit', () => {
    const at = pay(3_000_000n, 3_000_000n);
    expect(judge(at.tx, at.inputs, vaultPlan(3_000_000n, 9_000_000n)).vault.ok).toBe(true);
    const refused = judge(at.tx, at.inputs, vaultPlan(2_999_999n, 9_000_000n)).vault;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('per payment');
  });
  it('refuses a payment that brings the total of the period above its limit, and accepts one that reaches it', () => {
    const second = pay(3_000_000n, 9_000_000n);
    expect(judge(second.tx, second.inputs, vaultPlan(3_000_000n, 9_000_000n)).vault.ok).toBe(true);
    const refused = judge(second.tx, second.inputs, vaultPlan(3_000_000n, 8_999_999n)).vault;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('total');
  });
  it('refuses a payment that takes more out of the vault than the escrow holds, or pays more than the datum says', () => {
    const leak = facts({ inputs: [ref(4)], outputs: [output(0, escrowAddress, 3_000_000n, { inlineDatum: 'd87980' }), output(1, vaultAddress, 6_000_000n, { inlineDatum: live(3_000_000n) })] });
    const refused = judge(leak, [utxo(ref(4), vaultAddress, 10_000_000n, { datum: live(0n) })], vaultPlan(5_000_000n, 9_000_000n)).vault;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('leaves the vault');
  });
  it('refuses a payment whose vault output has no readable datum', () => {
    const tx = facts({ inputs: [ref(4)], outputs: [output(0, escrowAddress, 3_000_000n), output(1, vaultAddress, 7_000_000n, { inlineDatum: 'ff' })] });
    expect(judge(tx, [utxo(ref(4), vaultAddress, 10_000_000n)], vaultPlan(5_000_000n, 9_000_000n)).vault.ok).toBe(false);
  });
  it('does not judge a transaction that pays no escrow: the close of a vault', () => {
    const close = facts({ inputs: [ref(4)], outputs: [output(0, member.address, 9_600_000n)] });
    expect(judge(close, [utxo(ref(4), vaultAddress, 10_000_000n)], vaultPlan(1n, 1n)).vault.ok).toBe(true);
  });
});

describe('a transaction that the node would take', () => {
  it('passes every guard for a payment between two wallets of the keys, and is refused above the limit of the wallet', async () => {
    const world = await World.create([{ n: MEMBER_N }, { n: AGENT_N }]);
    const built = await world.simplePayment(member.address, 3_000_000n, agent.address);
    const tx = factsOf(built.unsignedCbor);
    const inputs = await world.chain.getUtxosByOutRef(tx.inputs.map((r) => ({ txHash: r.slice(0, 64), outputIndex: Number(r.slice(65)) })));
    const claimed = { txHash: built.txHash, feeLovelace: tx.feeLovelace };
    expect(tx.txHash).toBe(built.txHash);
    expect(failed(runGuards({ facts: tx, claims: claimed, inputs, plan: plan({ maxOutflow: { [member.keyHash]: 4_000_000n } }), ring }))).toEqual([]);
    const refused = failed(runGuards({ facts: tx, claims: claimed, inputs, plan: plan({ maxOutflow: { [member.keyHash]: 3_000_000n } }), ring }));
    expect(refused.map((g) => g.guard)).toEqual(['outflow']);
  });
});

describe('the guards that the tests above do not reach', () => {
  it('signers: refuses an input that the ledger did not give, and accepts it when the ledger gave it', () => {
    const tx = facts({ inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)] });
    const refused = judge(tx, []).signers;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('could not be read');
    expect(judge(tx, [walletInput(1)]).signers.ok).toBe(true);
  });
  it('collateral: refuses a script that runs with no collateral input, and accepts it with a collateral input that the transaction returns in part', () => {
    const base = { runsScripts: true, inputs: [ref(1)], outputs: [output(0, member.address, 19_600_000n)] };
    const none = judge(facts(base), [walletInput(1)]).collateral;
    expect(none.ok).toBe(false);
    expect(none.message).toContain('no collateral input');
    const covered = facts({ ...base, collateralInputs: [ref(2)], collateralReturn: output(1, member.address, 18_000_000n) });
    expect(judge(covered, [walletInput(1), walletInput(2)]).collateral.ok).toBe(true);
  });
  it('vault: refuses a transaction that pays two escrows, and does not refuse one escrow for that', () => {
    const vault = { address: DEPLOYMENT.vault.address, escrowAddress: DEPLOYMENT.escrow.address, perTx: 3_000_000n, total: 3_000_000n };
    const step = plan({ vault, destinations: new Set([DEPLOYMENT.escrow.address]) });
    const two = facts({ inputs: [ref(1)], outputs: [output(0, DEPLOYMENT.escrow.address, 1_000_000n), output(1, DEPLOYMENT.escrow.address, 1_000_000n), output(2, member.address, 17_000_000n)] });
    const refused = judge(two, [walletInput(1)], step).vault;
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('pays 2 escrows');
    const one = facts({ inputs: [ref(1)], outputs: [output(0, DEPLOYMENT.escrow.address, 1_000_000n), output(1, member.address, 18_000_000n)] });
    expect(judge(one, [walletInput(1)], step).vault.message).not.toContain('pays 2 escrows');
  });
});
