// Checks 2 and 3, the vault checks, against the world of fixtures with the real Delegate, Vault Open, Vault Close and Undelegate builders. The hire kit is the one thing that a fake takes the
// place of: a `HirePort` that records its calls and, as the chain does, leaves a Returned output in the vault. The checks must call it in the right order and with the right vault, wait
// for deliver_by before a reclaim, close the Live output and the Returned output together, verify each step with the hosted tools, and never hire again after a Pay.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERIOD_MS, RECLAIM_AFTER_MS, parseVaultSettings, vaultCheck } from '../lib/check-vault.ts';
import { collateralAdvice } from '../lib/collateral.ts';
import { iso } from '../lib/format.ts';
import type { VaultSettings } from '../lib/check-vault.ts';
import { DryStop, HireFailed } from '../lib/hire-types.ts';
import type { HirePort, VaultHireRequest, VaultHired, VaultPaid, VaultPayRequest, VaultReclaimed } from '../lib/hire-types.ts';
import type { CheckDefinition } from '../lib/runner.ts';
import { SettingsError } from '../lib/settings.ts';
import { StateFile } from '../lib/state.ts';
import type { Harness } from './support/harness.ts';
import { harness } from './support/harness.ts';
import { AGENT_N, DEPLOYMENT, MEMBER_N, RECORD_DID, World, keyOf } from './support/world.ts';
import { addReturned, liveVaultOf, vaultHostedFor } from './support/vault-world.ts';

const ADVERT = `${'ab'.repeat(32)}#0`;
const ESCROW = `${'e1'.repeat(32)}#0`;
/** The request that the agent accepts: check 2 has no default for it. */
const PAYLOAD = '{"subject":"the test record"}';
const ESCROW_ENV = { CHECKS_ADVERT_REF: ADVERT, CHECKS_HIRE_PAYLOAD: PAYLOAD };
/** What a Pay from a vault locks for the advert of Agent History (price 1, bonds 1 and 1): exactly the price and both bonds. */
const LOCK = 3_000_000n;
/** What an Accept returns to the vault: the buyer bond and a top-up to the ledger minimum of the Returned output. */
const BOND_BACK = 1_064_570n;

/** Writes a vault reference into the step vault_open of the state file, as a state file that a lost call left behind would hold it. */
function setVaultRef(h: Harness, name: string, ref: string): void {
  const path = join(h.stateDir, `${name}.state.json`);
  const json = JSON.parse(readFileSync(path, 'utf8')) as { steps: Record<string, { refs: Record<string, string> }> };
  json.steps.vault_open!.refs.vault_ref = ref;
  writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 });
}

class FakePort implements HirePort {
  readonly calls: string[] = [];
  readonly requests: Array<VaultHireRequest | VaultPayRequest | { escrowRef: string; deliverBy: number }> = [];
  /** When set, the next hire throws it, as the kit does for a hire that stops. */
  failure: HireFailed | DryStop | null = null;
  constructor(private readonly h: () => Harness) {}
  async hire(request: VaultHireRequest): Promise<VaultHired> {
    this.calls.push('hire');
    if (this.failure !== null) throw this.failure;
    this.requests.push(request);
    return {
      escrowRef: ESCROW, vaultRef: request.vaultRef, payTxHash: 'a1'.repeat(32), acceptTxHash: 'a2'.repeat(32), lockLovelace: LOCK, text: 'a report', returnedRef: addReturned(this.h(), BOND_BACK, 'f2'),
    };
  }
  async pay(request: VaultPayRequest): Promise<VaultPaid> {
    this.calls.push('pay');
    this.requests.push(request);
    if (this.failure instanceof DryStop) throw this.failure;
    return { escrowRef: ESCROW, vaultRef: request.vaultRef, txHash: 'a3'.repeat(32), lockLovelace: LOCK, deliverBy: this.h().clock.now() + 300_000 };
  }
  async reclaim(escrow: { escrowRef: string; deliverBy: number }): Promise<VaultReclaimed> {
    this.calls.push('reclaim');
    this.requests.push(escrow);
    return { txHash: 'a4'.repeat(32), returnedRef: addReturned(this.h(), LOCK, 'f1') };
  }
}

async function started(kind: 'escrow' | 'refund', returnedReports?: string, world?: World) {
  const name = kind === 'escrow' ? 'vault-escrow' : 'vault-refund';
  let h: Harness | null = null;
  const port = new FakePort(() => h!);
  const hosted = vaultHostedFor(() => h!, name, returnedReports);
  h = await harness({ hosted, env: ESCROW_ENV, ...(world === undefined ? {} : { world }) });
  return { h, port, hosted, check: vaultCheck(kind, () => port), name };
}

/** Runs the first `count` steps of a check with --submit, each in a run of its own. */
async function submitSteps(t: { h: Harness; check: CheckDefinition<VaultSettings> }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) expect(await t.h.run(t.check, '--submit'), `run ${i + 1}`).toBe(0);
}

describe('the settings of the vault checks', () => {
  it('need the advert, have defaults that fit the advert of Agent History, and refuse a limit above the period or the vault', () => {
    expect(parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT }, 'refund')).toMatchObject({
      hours: 24, advertRef: ADVERT, vaultLovelace: 8_000_000n, limitLovelace: 4_000_000n, totalLovelace: 8_000_000n, maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n,
    });
    expect(parseVaultSettings({ ...ESCROW_ENV, CHECKS_VAULT_UNITS: '12', CHECKS_VAULT_LIMIT_UNITS: '6', CHECKS_VAULT_TOTAL_UNITS: '10', CHECKS_MAX_PRICE_UNITS: '3' }, 'escrow'))
      .toMatchObject({ vaultLovelace: 12_000_000n, limitLovelace: 6_000_000n, totalLovelace: 10_000_000n, maxPriceLovelace: 3_000_000n, payload: PAYLOAD });
    for (const env of [{}, { CHECKS_ADVERT_REF: 'nope' }, { CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '3' }, { CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_LIMIT_UNITS: '9' }]) {
      expect(() => parseVaultSettings(env, 'refund')).toThrow(SettingsError);
    }
  });
  it('says which limit is wrong: a limit of one payment above the limit of the period names the period, and a limit above the vault names the vault', () => {
    expect(() => parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '10', CHECKS_VAULT_LIMIT_UNITS: '6', CHECKS_VAULT_TOTAL_UNITS: '4' }, 'refund')).toThrow(/CHECKS_VAULT_LIMIT_UNITS must be at most CHECKS_VAULT_TOTAL_UNITS/);
    expect(() => parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '3', CHECKS_VAULT_LIMIT_UNITS: '5', CHECKS_VAULT_TOTAL_UNITS: '8' }, 'refund')).toThrow(/CHECKS_VAULT_LIMIT_UNITS must be at most CHECKS_VAULT_UNITS/);
    expect(parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '10', CHECKS_VAULT_LIMIT_UNITS: '4', CHECKS_VAULT_TOTAL_UNITS: '4' }, 'refund')).toMatchObject({ limitLovelace: 4_000_000n, totalLovelace: 4_000_000n });
  });
  it('give check 2 no default for the request of the agent: a missing, an empty or a blank CHECKS_HIRE_PAYLOAD is refused for check 2, and check 3 needs none', () => {
    for (const payload of [undefined, '', '   ']) {
      const env = { CHECKS_ADVERT_REF: ADVERT, ...(payload === undefined ? {} : { CHECKS_HIRE_PAYLOAD: payload }) };
      expect(() => parseVaultSettings(env, 'escrow')).toThrow(/set CHECKS_HIRE_PAYLOAD/);
      expect(parseVaultSettings(env, 'refund').payload).toBe('');
    }
    expect(parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT, CHECKS_HIRE_PAYLOAD: `  ${PAYLOAD}  ` }, 'escrow').payload).toBe(PAYLOAD);
  });
  it('stop a run of check 2 at its start, with exit 2 and the name of the setting, when the request of the agent is not set; check 3 starts without it', async () => {
    const bare = { CHECKS_ADVERT_REF: ADVERT };
    const escrow = await harness({ env: bare });
    expect(await escrow.run(vaultCheck('escrow', () => new FakePort(() => escrow)))).toBe(2);
    expect(escrow.screen.errorText).toContain('set CHECKS_HIRE_PAYLOAD');
    expect(escrow.node.submitted).toEqual([]);
    const refund = await harness({ env: bare });
    expect(await refund.run(vaultCheck('refund', () => new FakePort(() => refund)))).toBe(0);
  });
});

describe('check 2, the vault pays an escrow that is accepted', () => {
  it('goes delegate, vault_open, hire, vault_close, undelegate: the kit gets the advert, the payload, the limits and the Live vault, and the close takes the Live and the Returned output', async () => {
    const t = await started('escrow');
    await submitSteps(t, 5);
    const { h, port, name } = t;
    const steps = h.state(name).steps;
    expect(Object.keys(steps)).toEqual(['delegate', 'vault_open', 'hire', 'vault_close', 'undelegate']);
    expect(steps.delegate!.facts).toMatchObject({ actions: ['marketplace.hire.v1'], limit_lovelace: '4000000', total_lovelace: '8000000', period_ms: PERIOD_MS });
    expect(port.calls).toEqual(['hire']);
    expect(port.requests[0]).toMatchObject({
      advertRef: ADVERT, vaultRef: steps.vault_open!.refs.vault_ref, maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n,
    });
    expect(steps.hire!.refs).toMatchObject({ escrow_ref: ESCROW, accept_tx: 'a2'.repeat(32), returned_ref: `${'f2'.repeat(32)}#0` });
    expect(steps.vault_close!.facts.closed).toEqual([steps.vault_open!.refs.vault_ref, `${'f2'.repeat(32)}#0`]);
    for (const step of Object.values(steps)) expect(step.verified_at).not.toBeNull();
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.vault.address)).toBe(false);
  });
  it('in dry mode shows the hire and signs nothing: a dry stop of the kit is the end of the dry run', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    t.port.failure = new DryStop('hire:pay');
    expect(await t.h.run(t.check)).toBe(0);
    expect(t.h.screen.text).toContain('the kit would hire the advert');
    expect(t.h.state(t.name).steps.hire).toBeUndefined();
    expect(t.h.state(t.name).notes.after_pay).toBeUndefined();
  });
  it('reads the vault from the chain: a reference of the state file that the node does not hold gives way to the one Live output of the delegation', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const live = liveVaultOf(t.h);
    setVaultRef(t.h, t.name, `${'dd'.repeat(32)}#0`);
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.port.requests[0]).toMatchObject({ vaultRef: `${live.txHash}#${live.outputIndex}` });
    expect(t.h.screen.text).toContain('is not on the node: the chain shows the vault output');
  });
  it('stops when the reference of the state file is not on the node and the chain shows two Live outputs of the delegation, and calls the kit with neither', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const live = liveVaultOf(t.h);
    t.h.world.chain.held.push({ ...live, txHash: 'bb'.repeat(32) });
    setVaultRef(t.h, t.name, `${'dd'.repeat(32)}#0`);
    expect(await t.h.run(t.check, '--submit')).toBe(2);
    expect(t.h.screen.errorText).toContain('shows 2 Live vault outputs');
    expect(t.port.calls).toEqual([]);
  });
  it('uses the reference of the state file when the node holds it, even when the chain shows another Live output of the delegation', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const live = liveVaultOf(t.h);
    t.h.world.chain.held.push({ ...live, txHash: 'bb'.repeat(32) });
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.port.requests[0]).toMatchObject({ vaultRef: `${live.txHash}#${live.outputIndex}` });
  });
  it('is recorded from the Pay and the Accept that landed, when the call that made them did not return: the kit is not called again', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const state = StateFile.open(join(t.h.stateDir, `${t.name}.state.json`), { check: t.name, network: 'vector-mainnet', record: RECORD_DID });
    const vaultRef = t.h.state(t.name).steps.vault_open!.refs.vault_ref!;
    const at = '2026-11-15T12:00:00.000Z';
    state.setNote('part.hire:pay', { confirmed_at: at, tx_hash: 'a1'.repeat(32), refs: { escrow_ref: ESCROW, vault_ref: vaultRef }, facts: { lock_lovelace: LOCK, deliver_by: t.h.clock.now() + 300_000, advert_ref: ADVERT } });
    state.setNote('part.hire:accept', { confirmed_at: at, tx_hash: 'a2'.repeat(32), refs: { escrow_ref: ESCROW, returned_ref: addReturned(t.h, BOND_BACK, 'f2') }, facts: {} });
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain('next: hire');
    expect(t.h.screen.text).not.toContain('next: cleanup');
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.port.calls).toEqual([]);
    expect(t.h.state(t.name).steps.hire).toMatchObject({ refs: { escrow_ref: ESCROW, accept_tx: 'a2'.repeat(32), returned_ref: `${'f2'.repeat(32)}#0` } });
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain('next: vault_close');
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.h.state(t.name).steps.vault_close!.facts.closed).toHaveLength(2);
  });
  it('cleanup closes an open vault and ends the delegation when the hire never ran, and ends the check', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(0);
    expect(t.h.screen.text).toContain('nothing stays locked');
    expect(Object.keys(t.h.state(t.name).steps)).toEqual(['delegate', 'vault_open', 'vault_close', 'undelegate']);
    expect(t.port.calls).toEqual([]);
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(0);
    expect(t.h.screen.text).toContain('nothing is left to take back');
    expect(await t.h.run(t.check, '--submit')).toBe(2);
    expect(t.h.screen.errorText).toContain('ended the check');
  });
});

describe('check 3, the vault pays an escrow that nobody claims', () => {
  async function paid(returnedReports?: string) {
    const t = await started('refund', returnedReports);
    await submitSteps(t, 3);
    return t;
  }
  it('pays without a job, then waits for deliver_by with the time that is left, and never calls the kit to reclaim before', async () => {
    const { h, port, check, name } = await paid();
    expect(port.calls).toEqual(['pay']);
    expect(port.requests[0]).toMatchObject({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n });
    const deliverBy = Number(h.state(name).steps.pay!.facts.deliver_by);
    expect(await h.run(check, '--submit')).toBe(4);
    expect(h.screen.text).toContain('can be reclaimed after its deliver_by');
    expect(port.calls).toEqual(['pay']);
    h.clock.t = deliverBy + RECLAIM_AFTER_MS - 1;
    expect(await h.run(check, '--submit')).toBe(4);
    expect(port.calls).toEqual(['pay']);
  });
  it('reclaims after deliver_by, then closes the Live and the Returned output together and ends the delegation', async () => {
    const { h, port, check, name } = await paid();
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    expect(await h.run(check, '--submit')).toBe(0);
    expect(port.calls).toEqual(['pay', 'reclaim']);
    expect(port.requests[1]).toEqual({ escrowRef: ESCROW, deliverBy: Number(h.state(name).steps.pay!.facts.deliver_by) });
    const returnedRef = `${'f1'.repeat(32)}#0`;
    expect(h.state(name).steps.reclaim).toMatchObject({ refs: { returned_ref: returnedRef }, verified_at: expect.any(String) });
    expect(await h.run(check, '--submit')).toBe(0);
    expect(h.state(name).steps.vault_close!.facts.closed).toEqual([h.state(name).steps.vault_open!.refs.vault_ref, returnedRef]);
    expect(await h.run(check, '--submit')).toBe(0);
    expect(Object.values(h.state(name).steps).every((step) => step.verified_at !== null)).toBe(true);
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.vault.address)).toBe(false);
  });
  it('exits 1 when the hosted tool shows the Returned output with less than the lock', async () => {
    const { h, check, name } = await paid('1000000');
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('holds less than');
    expect(h.state(name).steps.reclaim!.verified_at).toBeNull();
  });
  it('cleanup waits for deliver_by, reclaims, closes both outputs and ends the delegation', async () => {
    const { h, port, check, name } = await paid();
    expect(await h.run(check, 'cleanup', '--submit')).toBe(4);
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    expect(await h.run(check, 'cleanup', '--submit')).toBe(0);
    expect(port.calls).toEqual(['pay', 'reclaim']);
    expect(Object.keys(h.state(name).steps)).toEqual(['delegate', 'vault_open', 'pay', 'reclaim', 'vault_close', 'undelegate']);
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.vault.address)).toBe(false);
  });
});

describe('a hire that stops after a Pay', () => {
  const afterPay = (kind: 'failed_after_claim' | 'refused_before_claim', vaultRef: string | null, deliverBy: number | null, lock: bigint | null) => new HireFailed(kind, 'the send was lost', { escrowRef: ESCROW, vaultRef, deliverBy, lockLovelace: lock });
  it('keeps the escrow and the vault output that continues, never hires again, and the cleanup waits for deliver_by and then reclaims', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check, name } = t;
    const continued = liveVaultOf(h);
    port.failure = afterPay('failed_after_claim', `${continued.txHash}#${continued.outputIndex}`, h.clock.now() + 300_000, LOCK);
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('do not hire again');
    expect(h.state(name).notes.after_pay).toMatchObject({ escrow_ref: ESCROW, vault_ref: `${continued.txHash}#${continued.outputIndex}`, kind: 'failed_after_claim' });
    port.failure = null;
    expect(await h.run(check, '--submit')).toBe(2);
    expect(port.calls).toEqual(['hire']);
    expect(await h.run(check, 'cleanup', '--submit')).toBe(4);
    expect(port.calls).toEqual(['hire']);
    h.clock.t += 300_000 + RECLAIM_AFTER_MS;
    expect(await h.run(check, 'cleanup', '--submit')).toBe(0);
    expect(port.calls).toEqual(['hire', 'reclaim']);
    expect(h.state(name).steps.reclaim!.refs.escrow_ref).toBe(ESCROW);
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.vault.address)).toBe(false);
  });
  it('keeps both vault references and the time for a Pay that was sent and not seen confirmed, tells the operator not to start another Pay, and does not take the Pay for a payment that happened', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check, name } = t;
    const old = liveVaultOf(h);
    const validTo = h.clock.now() + 180_000;
    port.failure = new HireFailed('other', 'the Pay was sent and not seen confirmed', {
      escrowRef: ESCROW, vaultRef: null, deliverBy: h.clock.now() + 300_000, lockLovelace: null, vaultRefIfLanded: `${'a5'.repeat(32)}#1`, mayLand: true, validTo,
    });
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('it may still land until');
    expect(h.screen.errorText).toContain(`${'a5'.repeat(32)}#1`);
    expect(h.state(name).notes.unconfirmed_pay).toMatchObject({ escrow_ref: ESCROW, old_vault_ref: `${old.txHash}#${old.outputIndex}`, vault_ref_if_landed: `${'a5'.repeat(32)}#1`, may_land: true, valid_to: validTo });
    expect(h.state(name).notes.after_pay).toBeUndefined();
    // The run settles the transaction in flight first. When the Pay did not land, the old reference is the vault, and the hire can be made again from it.
    port.failure = null;
    expect(await h.run(check, '--submit')).toBe(0);
    expect(port.requests.at(-1)).toMatchObject({ vaultRef: `${old.txHash}#${old.outputIndex}` });
  });
  it('refuses the cleanup of an escrow whose deliver_by or lock the state file does not know, and says to read them on the ledger', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const live = liveVaultOf(t.h);
    t.port.failure = new HireFailed('failed_after_claim', 'the send was lost', { escrowRef: ESCROW, vaultRef: `${live.txHash}#${live.outputIndex}`, deliverBy: null, lockLovelace: null });
    expect(await t.h.run(t.check, '--submit')).toBe(1);
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(2);
    expect(t.h.screen.errorText).toContain('its deliver_by or its lock is not known');
    expect(t.port.calls).toEqual(['hire']);
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain('next: cleanup, after its deliver_by');
  });
  it('keeps nothing for a hire that stopped before its Pay, and the hire can be made again', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check, name } = t;
    port.failure = new HireFailed('vault_refused', 'the script of the vault refused the Pay');
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.state(name).notes.after_pay).toBeUndefined();
    port.failure = null;
    expect(await h.run(check, '--submit')).toBe(0);
    expect(port.calls).toEqual(['hire', 'hire']);
  });
});

describe('the status of a check', () => {
  it('says when the wallet of a key has no pure output of 5 units for collateral, and how to make one; a wallet that has one gets no warning', async () => {
    const bare = await World.identity({ wallets: [{ n: MEMBER_N, lovelace: [3_000_000n, 2_000_000n] }, { n: AGENT_N, lovelace: [200_000_000n, 5_000_000n] }] });
    const without = await harness({ world: bare, env: ESCROW_ENV });
    expect(await without.run(vaultCheck('escrow', () => new FakePort(() => without)), 'status')).toBe(0);
    const member = keyOf(MEMBER_N);
    expect(without.screen.text).toContain(`wallet of the member key ${member.keyHash}`);
    expect(without.screen.text).toContain(`NONE: a script step of this wallet needs one`);
    expect(without.screen.text).toContain(`send 5.5 units to ${member.address}`);
    expect(without.screen.text.split('\n').filter((line) => line.includes('NONE'))).toHaveLength(1);
    const stocked = await harness({ env: ESCROW_ENV });
    expect(await stocked.run(vaultCheck('escrow', () => new FakePort(() => stocked)), 'status')).toBe(0);
    expect(stocked.screen.text).not.toContain('NONE');
  });
});

describe('the collateral of the wallet that pays a step', () => {
  const member = keyOf(MEMBER_N);
  const agent = keyOf(AGENT_N);
  it('stops the step delegate before the build when the member wallet has no pure output of 5 units or more, and the same step runs when it has one', async () => {
    const poor = await World.identity();
    poor.useUp(MEMBER_N);
    const stopped = await started('escrow', undefined, poor);
    expect(await stopped.h.run(stopped.check)).toBe(2);
    expect(stopped.h.screen.errorText).toContain(`The member wallet ${member.keyHash}`);
    expect(stopped.h.screen.errorText).toContain(collateralAdvice(member.address));
    expect(stopped.h.screen.errorText).not.toContain('Collateral required');
    const ready = await started('escrow');
    expect(await ready.h.run(ready.check)).toBe(0);
  });
  it('asks for no collateral at vault_open, which runs no script: the step builds and lands with outputs of less than 5 units', async () => {
    const t = await started('escrow');
    await submitSteps(t, 1);
    t.h.world.useUp(MEMBER_N, [4_000_000n, 4_000_000n, 4_000_000n, 4_000_000n]);
    expect(await t.h.run(t.check)).toBe(0);
    expect(t.h.screen.text).toContain('opens a vault');
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.h.state(t.name).steps.vault_open).toBeDefined();
  });
  it('stops vault_close when the steps used up the outputs of the member wallet, and the same close runs while the wallet holds one', async () => {
    const t = await started('escrow');
    await submitSteps(t, 3);
    const { h, check } = t;
    expect(await h.run(check)).toBe(0);
    h.world.useUp(MEMBER_N);
    const sent = h.node.submitted.length;
    h.screen.lines.length = 0;
    expect(await h.run(check)).toBe(2);
    expect(h.screen.errorText).toContain(`The member wallet ${member.keyHash}`);
    expect(h.screen.errorText).not.toContain('Collateral required');
    expect(h.node.submitted).toHaveLength(sent);
  });
  it('stops hire before the kit is called when the agent wallet has no pure output of 5 units or more, and calls the kit when it has one', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check } = t;
    port.failure = new DryStop('hire:pay');
    expect(await h.run(check)).toBe(0);
    expect(port.calls).toEqual(['hire']);
    h.world.useUp(AGENT_N);
    h.screen.lines.length = 0;
    expect(await h.run(check)).toBe(2);
    expect(port.calls).toEqual(['hire']);
    expect(h.screen.errorText).toContain(`The agent wallet ${agent.keyHash}`);
    expect(h.screen.errorText).toContain(collateralAdvice(agent.address));
  });
  it('stops pay before the kit is called when the agent wallet has no pure output of 5 units or more, and calls the kit when it has one', async () => {
    const t = await started('refund');
    await submitSteps(t, 2);
    const { h, port, check } = t;
    port.failure = new DryStop('pay');
    expect(await h.run(check)).toBe(0);
    expect(port.calls).toEqual(['pay']);
    h.world.useUp(AGENT_N);
    h.screen.lines.length = 0;
    expect(await h.run(check)).toBe(2);
    expect(port.calls).toEqual(['pay']);
    expect(h.screen.errorText).toContain(`The agent wallet ${agent.keyHash}`);
  });
  it('stops reclaim, and the cleanup, after the wait and not before it, when the agent wallet has no pure output of 5 units or more', async () => {
    const t = await started('refund');
    await submitSteps(t, 3);
    const { h, port, check, name } = t;
    h.world.useUp(AGENT_N);
    expect(await h.run(check, '--submit')).toBe(4);
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    h.screen.lines.length = 0;
    expect(await h.run(check, '--submit')).toBe(2);
    expect(h.screen.errorText).toContain(`The agent wallet ${agent.keyHash}`);
    expect(await h.run(check, 'cleanup', '--submit')).toBe(2);
    expect(port.calls).toEqual(['pay']);
  });
});

describe('the next command that the status names', () => {
  const stopAfterPay = (h: Harness, deliverBy: number): HireFailed => {
    const continued = liveVaultOf(h);
    return new HireFailed('failed_after_claim', 'the send was lost', { escrowRef: ESCROW, vaultRef: `${continued.txHash}#${continued.outputIndex}`, deliverBy, lockLovelace: LOCK });
  };
  it('names hire before a Pay, cleanup with the time after a hire that stopped after its Pay, and says that the check is ended after the cleanup', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check } = t;
    expect(await h.run(check, 'status')).toBe(0);
    expect(h.screen.text).toContain('next: hire');
    const deliverBy = h.clock.now() + 300_000;
    port.failure = stopAfterPay(h, deliverBy);
    expect(await h.run(check, '--submit')).toBe(1);
    h.screen.lines.length = 0;
    expect(await h.run(check, 'status')).toBe(0);
    expect(h.screen.text).not.toContain('next: hire');
    expect(h.screen.text).toContain(`next: cleanup, after ${iso(deliverBy + RECLAIM_AFTER_MS)}`);
    expect(h.screen.text).toContain(ESCROW);
    port.failure = null;
    h.clock.t = deliverBy + RECLAIM_AFTER_MS;
    expect(await h.run(check, 'cleanup', '--submit')).toBe(0);
    h.screen.lines.length = 0;
    expect(await h.run(check, 'status')).toBe(0);
    expect(h.screen.text).toContain('next: nothing');
    expect(h.screen.text).not.toContain('next: hire');
  });
  it('names cleanup without a time when the escrow is reclaimed and the cleanup stopped before the rest', async () => {
    const t = await started('escrow');
    await submitSteps(t, 2);
    const { h, port, check } = t;
    const deliverBy = h.clock.now() + 300_000;
    port.failure = stopAfterPay(h, deliverBy);
    expect(await h.run(check, '--submit')).toBe(1);
    port.failure = null;
    h.clock.t = deliverBy + RECLAIM_AFTER_MS;
    h.world.useUp(MEMBER_N);
    expect(await h.run(check, 'cleanup', '--submit')).toBe(2);
    expect(port.calls).toEqual(['hire', 'reclaim']);
    h.screen.lines.length = 0;
    expect(await h.run(check, 'status')).toBe(0);
    expect(h.screen.text).toContain('next: cleanup: the escrow is reclaimed');
    expect(h.screen.text).not.toContain('next: cleanup, after');
  });
  it('names the next step in order for check 3 after its Pay', async () => {
    const t = await started('refund');
    await submitSteps(t, 3);
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain('next: reclaim');
  });
});
