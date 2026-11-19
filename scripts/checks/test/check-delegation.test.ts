// Check 1, the delegation, against a world of fixtures with the real builders: a dry run signs nothing, the steps go in order, the hosted tools verify each step, and the cleanup ends
// the delegation from any state.
import { describe, expect, it } from 'vitest';
import { delegationCheck, parseDelegationSettings } from '../lib/check-delegation.ts';
import { writeKeyFile } from './support/world.ts';
import { SettingsError } from '../lib/settings.ts';
import { FakeHosted } from './support/hosted-fake.ts';
import type { Harness } from './support/harness.ts';
import { harness } from './support/harness.ts';
import { AGENT_N, DEPLOYMENT, MEMBER_N, RECORD_ID, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);

/** The hosted tools as the live server answers them for the delegation of the state file: live while its token is on the ledger. */
function hostedFor(h: () => Harness, over: { usable?: boolean } = {}): FakeHosted {
  const facts = (): Record<string, unknown> => h().state('delegation').steps.delegate!.facts;
  const live = (id: string): boolean => h().world.chain.held.some((u) => u.assets[`${DEPLOYMENT.delegation.hash}${id}`] === 1n);
  return new FakeHosted({
    vector_get_delegation: (args) => {
      const id = String(args.delegation);
      const f = facts();
      return live(id)
        ? { delegation: id, live: true, chain: [{ delegation: id, delegator: { type: 'PrincipalKey', key_hash: f.delegator_key_hash }, delegate: f.delegate_id, delegate_key: f.delegate_key_hash, actions: f.actions, resources: f.resources, not_after: f.not_after, depth: 1 }] }
        : { delegation: id, live: false, chain: [] };
    },
    vector_check_delegation_use: (args) => ({ delegation: args.delegation, usable: over.usable ?? true, problems: over.usable === false ? ['the period does not hold the instant'] : [] }),
  });
}

async function started(over: { usable?: boolean } = {}) {
  let h: Harness | null = null;
  const hosted = hostedFor(() => h!, over);
  h = await harness({ hosted });
  return { h, hosted };
}

describe('the settings of the delegation', () => {
  it('have a period, an action and a resource, with defaults, and refuse a grant that the delegation rules refuse', () => {
    expect(parseDelegationSettings({})).toEqual({ hours: 24, action: 'mainnet-checks.token.v1', resource: 'https://checks.example/token' });
    expect(parseDelegationSettings({ CHECKS_DELEGATION_HOURS: '2', CHECKS_DELEGATION_ACTION: 'a.b.v1', CHECKS_DELEGATION_RESOURCE: '*' })).toEqual({ hours: 2, action: 'a.b.v1', resource: '*' });
    for (const env of [{ CHECKS_DELEGATION_ACTION: 'Not An Action' }, { CHECKS_DELEGATION_RESOURCE: 'ftp://x' }, { CHECKS_DELEGATION_HOURS: '0' }]) expect(() => parseDelegationSettings(env)).toThrow(SettingsError);
  });
});

describe('the step delegate', () => {
  it('in dry mode builds and checks the Delegate, shows who signs and what the delegation grants, and signs and submits nothing', async () => {
    const { h, hosted } = await started();
    expect(await h.run(delegationCheck)).toBe(0);
    const text = h.screen.text;
    expect(text).toContain(`the member key ${member.keyHash} delegates to the record did:vector:${RECORD_ID}`);
    expect(text).toContain(`signers: member key ${member.keyHash}, agent key ${agent.keyHash}`);
    expect(text).toContain('the action mainnet-checks.token.v1 on the resource https://checks.example/token');
    expect(text).toMatch(/to the delegation script, with 1 of .*, with an inline datum/);
    expect(text).toMatch(/ok +network\b/);
    expect(h.node.submitted).toEqual([]);
    expect(hosted.calls).toEqual([]);
  });
  it('with --submit lands the Delegate, records the delegation and verifies it with the hosted tools', async () => {
    const { h, hosted } = await started();
    expect(await h.run(delegationCheck, '--submit')).toBe(0);
    const step = h.state('delegation').steps.delegate!;
    expect(step.refs.delegation_id).toMatch(/^[0-9a-f]{64}$/);
    expect(step.refs.delegation_output).toBe(`${step.tx_hash}#${(await h.world.chain.getUtxos(DEPLOYMENT.delegation.address))[0]!.outputIndex}`);
    expect(step.verified_at).not.toBeNull();
    expect(step.facts).toMatchObject({ delegator_key_hash: member.keyHash, delegate_id: RECORD_ID, delegate_key_hash: agent.keyHash, actions: ['mainnet-checks.token.v1'] });
    expect(hosted.calls.map((c) => c.name)).toEqual(['vector_get_delegation', 'vector_check_delegation_use']);
    expect(h.evidence('delegation').map((e) => e.status)).toEqual(['confirmed', 'verified']);
    expect(h.screen.text).toContain('the step delegate is verified');
  });
  it('refuses a controller key that is not the controller of the record, before it builds anything', async () => {
    const { h } = await started();
    writeKeyFile(h.dir, 7, 'controller', 'hex');
    expect(await h.run(delegationCheck)).toBe(2);
    expect(h.screen.errorText).toContain('controller');
  });
  it('exits 1 and says what the tools show, when the hosted tools do not show the delegation as the step made it', async () => {
    const { h } = await started({ usable: false });
    expect(await h.run(delegationCheck, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('cannot be used for mainnet-checks.token.v1');
    expect(h.state('delegation').steps.delegate!.verified_at).toBeNull();
    expect(h.evidence('delegation').some((e) => e.status === 'info' && JSON.stringify(e.shows).includes('failed'))).toBe(true);
  });
});

describe('the step undelegate', () => {
  it('waits for check 5 and says so, and goes on with --skip-token-check', async () => {
    const { h } = await started();
    await h.run(delegationCheck, '--submit');
    expect(await h.run(delegationCheck)).toBe(2);
    expect(h.screen.errorText).toContain('check 5 (the delegation token) has not run');
    h.screen.lines.length = 0;
    expect(await h.run(delegationCheck, '--skip-token-check')).toBe(0);
    expect(h.screen.text).toContain('ends the delegation');
    expect(h.screen.text).toContain('mints and burns: -1 of');
  });
  it('ends the delegation with --submit: the token is burned, the hosted tools show it not live, and every step is confirmed', async () => {
    const { h } = await started();
    await h.run(delegationCheck, '--submit');
    const id = h.state('delegation').steps.delegate!.refs.delegation_id!;
    expect(await h.run(delegationCheck, '--submit', '--skip-token-check')).toBe(0);
    expect(h.world.chain.held.some((u) => u.assets[`${DEPLOYMENT.delegation.hash}${id}`] === 1n)).toBe(false);
    expect(h.state('delegation').steps.undelegate!.verified_at).not.toBeNull();
    h.screen.lines.length = 0;
    expect(await h.run(delegationCheck, '--submit')).toBe(0);
    expect(h.screen.text).toContain('every step of the check delegation is confirmed');
  });
});

describe('the cleanup', () => {
  it('has nothing to take back when no delegation was made, and ends the delegation from the state delegate', async () => {
    const { h } = await started();
    expect(await h.run(delegationCheck, 'cleanup')).toBe(0);
    expect(h.screen.text).toContain('there is nothing to take back');
    await h.run(delegationCheck, '--submit');
    h.screen.lines.length = 0;
    expect(await h.run(delegationCheck, 'cleanup')).toBe(0);
    expect(h.screen.text).toContain('dry run');
    expect(await h.run(delegationCheck, 'cleanup', '--submit')).toBe(0);
    expect(h.screen.text).toContain('nothing stays locked');
    expect(h.state('delegation').steps.undelegate).toBeDefined();
    h.screen.lines.length = 0;
    expect(await h.run(delegationCheck, 'cleanup', '--submit')).toBe(0);
    expect(h.screen.text).toContain('has ended already');
  });
});
