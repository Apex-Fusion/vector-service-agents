// Checks 2 and 3, the vault checks, against the world of fixtures with the real Delegate, Vault Open, Vault Close and Undelegate builders. The hire kit is the one thing that a fake takes the
// place of: a `HirePort` that records its calls. The checks must call it in the right order and with the right vault, wait for deliver_by before a reclaim, and verify each step with the
// hosted tools.
import { describe, expect, it } from 'vitest';
import { PERIOD_MS, RECLAIM_AFTER_MS, parseVaultSettings, vaultCheck } from '../lib/check-vault.ts';
import { HireFailed } from '../lib/hire-types.ts';
import type { HirePort, VaultHireRequest, VaultHired, VaultPaid, VaultReclaimed } from '../lib/hire-types.ts';
import { SettingsError } from '../lib/settings.ts';
import { FakeHosted } from './support/hosted-fake.ts';
import type { Handler } from './support/hosted-fake.ts';
import type { Harness } from './support/harness.ts';
import { harness } from './support/harness.ts';
import { DEPLOYMENT } from './support/world.ts';

const ADVERT = `${'ab'.repeat(32)}#0`;
const ESCROW = `${'e1'.repeat(32)}#0`;
const RETURNED = `${'f1'.repeat(32)}#0`;

class FakePort implements HirePort {
  readonly calls: string[] = [];
  /** When set, the next hire throws it, as the kit does for a hire that stops. */
  failure: HireFailed | null = null;
  readonly requests: Array<VaultHireRequest | { advertRef: string; vaultRef: string } | string> = [];
  constructor(private readonly h: () => Harness) {}
  async hire(request: VaultHireRequest): Promise<VaultHired> {
    this.calls.push('hire');
    if (this.failure !== null) throw this.failure;
    this.requests.push(request);
    return { escrowRef: ESCROW, vaultRef: request.vaultRef, payTxHash: 'a1'.repeat(32), acceptTxHash: 'a2'.repeat(32), lockLovelace: 3_000_000n, text: 'a report' };
  }
  async pay(request: { advertRef: string; vaultRef: string }): Promise<VaultPaid> {
    this.calls.push('pay');
    this.requests.push(request);
    return { escrowRef: ESCROW, vaultRef: request.vaultRef, txHash: 'a3'.repeat(32), lockLovelace: 3_000_000n, deliverBy: this.h().clock.now() + 300_000 };
  }
  async reclaim(escrowRef: string): Promise<VaultReclaimed> {
    this.calls.push('reclaim');
    this.requests.push(escrowRef);
    return { txHash: 'a4'.repeat(32), returnedRef: RETURNED };
  }
}

/** The hosted tools as the live server answers them: the delegation is live while its token is on the ledger, the vault while its output is held. */
function hostedFor(h: () => Harness, name: string, returnedLovelace = '3000000'): FakeHosted {
  const facts = (): Record<string, unknown> => h().state(name).steps.delegate!.facts;
  const handlers: Record<string, Handler> = {
    vector_get_delegation: (args) => {
      const id = String(args.delegation);
      const live = h().world.chain.held.some((u) => u.assets[`${DEPLOYMENT.delegation.hash}${id}`] === 1n);
      const f = facts();
      return live
        ? { delegation: id, live: true, chain: [{ delegation: id, delegator: { type: 'PrincipalKey', key_hash: f.delegator_key_hash }, delegate: f.delegate_id, delegate_key: f.delegate_key_hash, actions: f.actions, resources: f.resources, not_after: f.not_after, depth: 1 }] }
        : { delegation: id, live: false, chain: [] };
    },
    vector_get_vault: (args) => {
      const state = h().state(name).steps;
      if (args.owner_key_hash !== undefined) return state.reclaim === undefined ? { outputs: [] } : { outputs: [{ vault_ref: state.reclaim.refs.returned_ref, kind: 'Returned', lovelace: returnedLovelace }] };
      const ref = state.vault_open?.refs.vault_ref;
      const held = ref === undefined ? undefined : h().world.chain.held.find((u) => `${u.txHash}#${u.outputIndex}` === ref);
      return held === undefined ? { outputs: [] } : { outputs: [{ vault_ref: ref, kind: 'Live', lovelace: String(held.assets.lovelace), spent: '0' }] };
    },
  };
  return new FakeHosted(handlers);
}

async function started(kind: 'escrow' | 'refund', returnedLovelace?: string) {
  const name = kind === 'escrow' ? 'vault-escrow' : 'vault-refund';
  let h: Harness | null = null;
  const port = new FakePort(() => h!);
  const hosted = hostedFor(() => h!, name, returnedLovelace);
  h = await harness({ hosted, env: { CHECKS_ADVERT_REF: ADVERT } });
  return { h, port, hosted, check: vaultCheck(kind, () => port), name };
}

describe('the settings of the vault checks', () => {
  it('need the advert, have defaults for the rest, and refuse a limit above the vault', () => {
    expect(parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT })).toMatchObject({ hours: 24, advertRef: ADVERT, vaultLovelace: 6_000_000n, limitLovelace: 3_000_000n, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n });
    expect(parseVaultSettings({ CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '10', CHECKS_VAULT_LIMIT_UNITS: '10', CHECKS_HIRE_PAYLOAD: 'text' })).toMatchObject({ vaultLovelace: 10_000_000n, limitLovelace: 10_000_000n, payload: 'text' });
    for (const env of [{}, { CHECKS_ADVERT_REF: 'nope' }, { CHECKS_ADVERT_REF: ADVERT, CHECKS_VAULT_UNITS: '2', CHECKS_VAULT_LIMIT_UNITS: '3' }]) expect(() => parseVaultSettings(env)).toThrow(SettingsError);
  });
});

describe('check 2, the vault pays an escrow that is accepted', () => {
  it('goes delegate, vault_open, hire, vault_close, undelegate, and the kit gets the advert, the payload and the vault of the step', async () => {
    const { h, port, check, name } = await started('escrow');
    for (let i = 0; i < 5; i++) expect(await h.run(check, '--submit'), `run ${i + 1}`).toBe(0);
    expect(Object.keys(h.state(name).steps)).toEqual(['delegate', 'vault_open', 'hire', 'vault_close', 'undelegate']);
    const steps = h.state(name).steps;
    expect(steps.delegate!.facts).toMatchObject({ actions: ['marketplace.hire.v1'], limit_lovelace: '3000000', period_ms: PERIOD_MS });
    expect(port.calls).toEqual(['hire']);
    expect(port.requests[0]).toMatchObject({ advertRef: ADVERT, vaultRef: steps.vault_open!.refs.vault_ref, maxSupplierBondLovelace: 1_000_000n, maxBuyerBondLovelace: 1_000_000n });
    expect(steps.hire!.refs).toMatchObject({ escrow_ref: ESCROW, accept_tx: 'a2'.repeat(32) });
    for (const step of Object.values(steps)) expect(step.verified_at).not.toBeNull();
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.vault.address)).toBe(false);
    expect(h.world.chain.held.some((u) => u.address === DEPLOYMENT.delegation.address && u.assets[`${DEPLOYMENT.delegation.hash}${steps.delegate!.refs.delegation_id}`] === 1n)).toBe(false);
  });
  it('in dry mode builds the vault steps and does not call the kit', async () => {
    const { h, port, check } = await started('escrow');
    await h.run(check, '--submit');
    await h.run(check, '--submit');
    expect(await h.run(check)).toBe(0);
    expect(h.screen.text).toContain('a dry run builds no payment');
    expect(port.calls).toEqual([]);
  });
  it('cleanup closes an open vault and ends the delegation when the hire never ran', async () => {
    const { h, port, check, name } = await started('escrow');
    await h.run(check, '--submit');
    await h.run(check, '--submit');
    expect(await h.run(check, 'cleanup', '--submit')).toBe(0);
    expect(h.screen.text).toContain('nothing stays locked');
    expect(Object.keys(h.state(name).steps)).toEqual(['delegate', 'vault_open', 'vault_close', 'undelegate']);
    expect(port.calls).toEqual([]);
    h.screen.lines.length = 0;
    expect(await h.run(check, 'cleanup', '--submit')).toBe(0);
    expect(h.screen.text).toContain('nothing is left to take back');
  });
});

describe('check 3, the vault pays an escrow that nobody claims', () => {
  async function paid(returnedLovelace?: string) {
    const t = await started('refund', returnedLovelace);
    for (let i = 0; i < 3; i++) expect(await t.h.run(t.check, '--submit')).toBe(0);
    return t;
  }
  it('pays without a job, then waits for deliver_by with the time that is left, and never calls the kit to reclaim before', async () => {
    const { h, port, check, name } = await paid();
    expect(port.calls).toEqual(['pay']);
    const deliverBy = Number(h.state(name).steps.pay!.facts.deliver_by);
    expect(await h.run(check, '--submit')).toBe(4);
    expect(h.screen.text).toContain('can be reclaimed after its deliver_by');
    expect(port.calls).toEqual(['pay']);
    h.clock.t = deliverBy + RECLAIM_AFTER_MS - 1;
    expect(await h.run(check, '--submit')).toBe(4);
    expect(port.calls).toEqual(['pay']);
  });
  it('reclaims after deliver_by and the hosted tool shows the Returned output of the owner', async () => {
    const { h, port, check, name } = await paid();
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    expect(await h.run(check, '--submit')).toBe(0);
    expect(port.calls).toEqual(['pay', 'reclaim']);
    expect(port.requests[1]).toBe(ESCROW);
    expect(h.state(name).steps.reclaim).toMatchObject({ refs: { returned_ref: RETURNED }, verified_at: expect.any(String) });
  });
  it('exits 1 when the Returned output holds less than the lock', async () => {
    const { h, check, name } = await paid('1000000');
    h.clock.t = Number(h.state(name).steps.pay!.facts.deliver_by) + RECLAIM_AFTER_MS;
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('holds less than the lock');
    expect(h.state(name).steps.reclaim!.verified_at).toBeNull();
  });
});

describe('a hire that stops after a confirmed Pay', () => {
  it('keeps the escrow and the vault output that continues, never hires again, and the cleanup waits for deliver_by and then reclaims', async () => {
    const { h, port, check, name } = await started('escrow');
    await h.run(check, '--submit');
    await h.run(check, '--submit');
    const continued = `${'c1'.repeat(32)}#1`;
    port.failure = new HireFailed('failed_after_claim', 'the send was lost', { escrowRef: ESCROW, vaultRef: continued, deliverBy: h.clock.now() + 300_000, lockLovelace: 3_000_000n });
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('do not hire again');
    expect(h.state(name).notes.after_pay).toMatchObject({ escrow_ref: ESCROW, vault_ref: continued, kind: 'failed_after_claim' });
    port.failure = null;
    expect(await h.run(check, '--submit')).toBe(2);
    expect(port.calls).toEqual(['hire']);
    expect(await h.run(check, 'cleanup', '--submit')).toBe(4);
    expect(port.calls).toEqual(['hire']);
    h.clock.t += 300_000 + RECLAIM_AFTER_MS;
    await h.run(check, 'cleanup', '--submit');
    expect(port.calls).toEqual(['hire', 'reclaim']);
    expect(h.state(name).steps.reclaim!.refs.escrow_ref).toBe(ESCROW);
  });
  it('keeps nothing for a hire that stopped before its Pay, and the hire can be made again', async () => {
    const { h, port, check, name } = await started('escrow');
    await h.run(check, '--submit');
    await h.run(check, '--submit');
    port.failure = new HireFailed('refused_before_claim', 'the agent turned the job down');
    expect(await h.run(check, '--submit')).toBe(1);
    expect(h.state(name).notes.after_pay).toBeUndefined();
    port.failure = null;
    expect(await h.run(check, '--submit')).toBe(0);
    expect(port.calls).toEqual(['hire', 'hire']);
  });
});
