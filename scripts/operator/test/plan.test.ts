// The plan helper: registry names in place of key hashes, the limits of the settings, and a mint that is always named. Each refusal has an accepted twin.
import { afterAll, describe, expect, it } from 'vitest';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import type { OperatorSettings } from '../lib/contract.ts';
import { planOf } from '../lib/plan.ts';
import { KeyStoreError } from '../lib/registry.ts';
import { makeTestKeys, removeTestKeys } from './support/keys.ts';

afterAll(removeTestKeys);
const keys = makeTestKeys(['run', 'fee', 'service'], { shared: ['run', 'fee'] });
const { registry } = keys;

const settingsOf = (maxFeeLovelace: bigint, maxCollateralLossLovelace: bigint): OperatorSettings => ({
  network: VECTOR_MAINNET, useCase: 'test-use-case', keysDir: '/keys', stateDir: '/state', agentsDir: '/agents', goFile: '/state/GO.json', mockEnvFile: null, contact: null, module1Commit: null,
  urls: { ogmios: 'https://ogmios.test', submit: 'https://submit.test', koios: 'https://koios.test', hosted: 'https://hosted.test/mcp', gateway: 'https://gateway.test' },
  maxFeeLovelace, maxCollateralLossLovelace,
});
const host = { registry, settings: settingsOf(1_234_567n, 7_654_321n) };

describe('planOf', () => {
  it('turns the names of the outflow into key hashes', () => {
    const plan = planOf(host, { outflow: { run: 5_000_000n, service: 7n } });
    expect(plan.maxOutflow).toEqual({ [registry.hashOf('run')]: 5_000_000n, [registry.hashOf('service')]: 7n });
    expect(Object.keys(plan.maxOutflow)).not.toContain('run');
  });
  it('refuses a name that the registry does not hold, and takes the name of a key that it holds', () => {
    expect(() => planOf(host, { outflow: { nobody: 1n } })).toThrow(KeyStoreError);
    expect(() => planOf(host, { outflow: { nobody: 1n } })).toThrow(/nobody/);
    expect(() => planOf(host, { outflow: { fee: 1n } })).not.toThrow();
  });
  it('sets the limits of the fee and of the collateral from the settings of the host', () => {
    const plan = planOf(host);
    expect(plan.maxFeeLovelace).toBe(1_234_567n);
    expect(plan.maxCollateralLossLovelace).toBe(7_654_321n);
    const other = planOf({ registry, settings: settingsOf(2_000_000n, 5_000_000n) });
    expect([other.maxFeeLovelace, other.maxCollateralLossLovelace]).toEqual([2_000_000n, 5_000_000n]);
  });
  it('says mint: {} when the plan names no mint, and keeps the mint that it names', () => {
    expect(planOf(host).mint).toEqual({});
    expect(planOf(host, { outflow: { run: 1n } }).mint).toEqual({});
    const unit = 'ab'.repeat(28);
    expect(planOf(host, { mint: { [unit]: 1n, [`${unit}01`]: -1n } }).mint).toEqual({ [unit]: 1n, [`${unit}01`]: -1n });
  });
  it('plans nothing that it is not told: no outflow, no destination, no explained input, no label, no vault and no withdrawal', () => {
    const plan = planOf(host);
    expect(plan.maxOutflow).toEqual({});
    expect([...plan.destinations]).toEqual([]);
    expect([...plan.explained]).toEqual([]);
    expect(plan.labels).toBeUndefined();
    expect(plan.vault).toBeUndefined();
    expect(plan.withdrawals).toBeUndefined();
  });
  it('takes the destinations and the explained inputs from any iterable, and the labels, the vault and the withdrawals as given', () => {
    function* refs(): Generator<string> { yield 'aa#0'; yield 'bb#1'; }
    const vault = { address: 'addr1vault', escrowAddress: 'addr1escrow', perTx: 3n, total: 9n };
    const plan = planOf(host, { destinations: ['addr1one', 'addr1two', 'addr1one'], explained: refs(), labels: { addr1one: 'the first' }, vault, withdrawals: 1 });
    expect(plan.destinations).toEqual(new Set(['addr1one', 'addr1two']));
    expect(plan.explained).toEqual(new Set(['aa#0', 'bb#1']));
    expect(plan.labels).toEqual({ addr1one: 'the first' });
    expect(plan.vault).toEqual(vault);
    expect(plan.withdrawals).toBe(1);
    expect(planOf(host, { destinations: new Set(['addr1set']) }).destinations).toEqual(new Set(['addr1set']));
    expect(planOf(host, { withdrawals: 0 }).withdrawals).toBe(0);
  });
  it('refuses a limit that is no bigint, a negative limit, a mint that is no bigint and a count of withdrawals that is no whole number', () => {
    const bad = (over: unknown) => () => planOf(host, over as Parameters<typeof planOf>[1]);
    expect(bad({ outflow: { run: 5 } })).toThrow(/outflow of run/);
    expect(bad({ outflow: { run: -1n } })).toThrow(/outflow of run/);
    expect(bad({ mint: { unit: 1 } })).toThrow(/mint/);
    for (const count of [-1, 1.5, '1', Number.NaN]) expect(bad({ withdrawals: count })).toThrow(/withdrawals/);
    expect(() => planOf({ registry, settings: settingsOf(-1n, 0n) })).toThrow(/fee/);
    expect(() => planOf({ registry, settings: { ...settingsOf(1n, 1n), maxCollateralLossLovelace: 5 as unknown as bigint } })).toThrow(/collateral/);
    expect(() => planOf(host, { outflow: { run: 0n }, mint: { unit: 0n }, withdrawals: 0 })).not.toThrow();
  });
  it('makes a new plan for each call: a change to one plan does not reach the next', () => {
    const first = planOf(host, { destinations: ['addr1one'], mint: { unit: 1n } });
    (first.destinations as Set<string>).add('addr1other');
    (first.mint as Record<string, bigint>).other = 2n;
    const second = planOf(host, { destinations: ['addr1one'], mint: { unit: 1n } });
    expect(second.destinations).toEqual(new Set(['addr1one']));
    expect(second.mint).toEqual({ unit: 1n });
    const mint = { unit: 1n };
    const own = planOf(host, { mint });
    mint.unit = 5n;
    expect(own.mint).toEqual({ unit: 1n });
  });
});
