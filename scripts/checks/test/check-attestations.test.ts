// Check 4, the attestations, against the world of fixtures with the real Attest and Withdraw builders: salted digests, the order of the steps, the read by the hosted tools (the salted
// digest passes and the digest with no salt fails), and the cleanup that withdraws what is due and says the date for the rest.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WITHDRAW_WAIT_MS, attestationsCheck, parseAttestationSettings, plainDigest, saltedDigest } from '../lib/check-attestations.ts';
import { collateralAdvice } from '../lib/collateral.ts';
import { SettingsError, VECTOR_MAINNET } from '../lib/settings.ts';
import { StateFile } from '../lib/state.ts';
import { FakeHosted } from './support/hosted-fake.ts';
import type { Harness } from './support/harness.ts';
import { harness } from './support/harness.ts';
import { DEPLOYMENT, MEMBER_N, RECORD_DID, RECORD_ID, World, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);

/** The hosted tools as the live server answers them for the attestations of the state file: found while the token is on the ledger. */
function hostedFor(h: () => Harness): FakeHosted {
  const issued = (): Array<{ id: string; facts: Record<string, unknown> }> => ['issue_approval', 'issue_binding'].flatMap((name) => {
    const step = h().state('attestations').steps[name];
    return step === undefined ? [] : [{ id: step.refs.attestation_id!, facts: step.facts }];
  });
  const onLedger = (id: string): boolean => h().world.chain.held.some((u) => u.assets[`${DEPLOYMENT.attestation.hash}${id}`] === 1n);
  const view = (item: { id: string; facts: Record<string, unknown> }): Record<string, unknown> => ({
    found: true, attestation: item.id, subject: item.facts.subject, issuer_key_hash: item.facts.issuer_key_hash, att_type_code: item.facts.att_type === 'approval' ? 5 : 4, digest: item.facts.digest, state: 'active',
  });
  return new FakeHosted({
    vector_get_attestation: (args) => {
      const item = issued().find((entry) => entry.id === args.attestation);
      return item !== undefined && onLedger(item.id) ? view(item) : { found: false, attestation: args.attestation };
    },
    vector_list_attestations: () => ({ total: issued().length, offset: 0, limit: 50, next_offset: null, attestations: issued().filter((i) => onLedger(i.id)).map(view) }),
    vector_check_attestation: (args) => {
      const item = issued().find((entry) => entry.id === args.attestation);
      if (item === undefined) return { attestation: args.attestation, found: false, valid: false, rule_valid: false, conditions: [] };
      const meets = args.expected_digest === item.facts.digest && args.expected_subject === RECORD_DID && args.expected_issuer === member.keyHash && (args.expected_type === 'approval' ? 5 : 4) === (item.facts.att_type === 'approval' ? 5 : 4);
      return { attestation: item.id, found: true, valid: meets, rule_valid: true, conditions: [], details: meets ? 'every expectation is met' : 'the digest is not the digest of the attestation' };
    },
  });
}

async function started(world?: World) {
  let h: Harness | null = null;
  const hosted = hostedFor(() => h!);
  h = await harness({ hosted, ...(world === undefined ? {} : { world }) });
  return { h, hosted };
}

describe('the settings of check 4', () => {
  it('have a validity in hours, with a default, and refuse a value outside the ledger rule', () => {
    expect(parseAttestationSettings({})).toEqual({ validHours: 48 });
    expect(parseAttestationSettings({ CHECKS_ATTESTATION_VALID_HOURS: '72' })).toEqual({ validHours: 72 });
    for (const bad of ['0', '8761', 'two']) expect(() => parseAttestationSettings({ CHECKS_ATTESTATION_VALID_HOURS: bad })).toThrow(SettingsError);
  });
});

describe('the digests', () => {
  it('differ with and without the salt, and the salted one is SHA-256 of the salt bytes and the document', () => {
    const salt = '11'.repeat(32);
    expect(saltedDigest(salt, 'doc')).toMatch(/^[0-9a-f]{64}$/);
    expect(saltedDigest(salt, 'doc')).not.toBe(plainDigest('doc'));
    expect(saltedDigest(salt, 'doc')).not.toBe(saltedDigest('22'.repeat(32), 'doc'));
  });
});

describe('the steps that issue', () => {
  it('in dry mode build and check the Attest, show the deposit, and write no salt and send nothing', async () => {
    const { h, hosted } = await started();
    expect(await h.run(attestationsCheck)).toBe(0);
    expect(h.screen.text).toContain('issues an attestation of type approval about');
    expect(h.screen.text).toContain('the salt and the document stay off the chain');
    expect(h.node.submitted).toEqual([]);
    expect(hosted.calls).toEqual([]);
  });
  it('with --submit land the approval and then the binding, and keep a salt and a document whose salted digest is the digest on the ledger', async () => {
    const { h } = await started();
    expect(await h.run(attestationsCheck, '--submit')).toBe(0);
    expect(await h.run(attestationsCheck, '--submit')).toBe(0);
    const state = h.state('attestations');
    for (const [step, type] of [['issue_approval', 'approval'], ['issue_binding', 'principal_binding']] as const) {
      const done = state.steps[step]!;
      const held = state.notes[`held.${type}`] as { salt: string; document: string; digest: string };
      expect(done.facts).toMatchObject({ att_type: type, subject: RECORD_ID, issuer_key_hash: member.keyHash, digest: held.digest });
      expect(saltedDigest(held.salt, held.document)).toBe(held.digest);
      expect(held.salt).toMatch(/^[0-9a-f]{64}$/);
      expect(h.world.chain.held.some((u) => u.assets[`${DEPLOYMENT.attestation.hash}${done.refs.attestation_id}`] === 1n)).toBe(true);
    }
    expect((state.notes['held.approval'] as { salt: string }).salt).not.toBe((state.notes['held.principal_binding'] as { salt: string }).salt);
  });
});

describe('the step read_check', () => {
  it('waits for the issue steps, and then reads both attestations: the salted digest passes and the digest with no salt fails', async () => {
    const { h, hosted } = await started();
    await h.run(attestationsCheck, '--submit');
    await h.run(attestationsCheck, '--submit');
    expect(await h.run(attestationsCheck)).toBe(0);
    expect(hosted.calls).toEqual([]);
    expect(await h.run(attestationsCheck, '--submit')).toBe(0);
    const names = hosted.calls.map((c) => c.name);
    expect(names.filter((n) => n === 'vector_get_attestation')).toHaveLength(2);
    expect(names.filter((n) => n === 'vector_check_attestation')).toHaveLength(4);
    expect(names.filter((n) => n === 'vector_list_attestations')).toHaveLength(1);
    const digests = hosted.calls.filter((c) => c.name === 'vector_check_attestation').map((c) => c.args.expected_digest);
    expect(new Set(digests).size).toBe(4);
    expect(h.state('attestations').steps.read_check!.verified_at).not.toBeNull();
  });
  it('exits 1 when the hosted tool accepts the digest with no salt', async () => {
    let h: Harness | null = null;
    const honest = hostedFor(() => h!);
    const lax = new FakeHosted({ ...honest.handlers, vector_check_attestation: (args) => ({ attestation: args.attestation, found: true, valid: true, rule_valid: true, conditions: [] }) });
    h = await harness({ hosted: lax });
    await h.run(attestationsCheck, '--submit');
    await h.run(attestationsCheck, '--submit');
    expect(await h.run(attestationsCheck, '--submit')).toBe(1);
    expect(h.screen.errorText).toContain('accepted the digest of the document with no salt');
  });
  it('marks both issue steps as verified when the read passes, and leaves them not verified when it fails', async () => {
    const { h } = await started();
    await h.run(attestationsCheck, '--submit');
    await h.run(attestationsCheck, '--submit');
    for (const step of ['issue_approval', 'issue_binding']) expect(h.state('attestations').steps[step]!.verified_at, step).toBeNull();
    expect(await h.run(attestationsCheck, '--submit')).toBe(0);
    for (const step of ['issue_approval', 'issue_binding']) expect(h.state('attestations').steps[step]!.verified_at, step).not.toBeNull();
    h.screen.lines.length = 0;
    expect(await h.run(attestationsCheck, 'status')).toBe(0);
    expect(h.screen.text).not.toContain('not verified');

    let failing: Harness | null = null;
    const honest = hostedFor(() => failing!);
    const lax = new FakeHosted({ ...honest.handlers, vector_check_attestation: (args) => ({ attestation: args.attestation, found: true, valid: true, rule_valid: true, conditions: [] }) });
    failing = await harness({ hosted: lax });
    await failing.run(attestationsCheck, '--submit');
    await failing.run(attestationsCheck, '--submit');
    expect(await failing.run(attestationsCheck, '--submit')).toBe(1);
    for (const step of ['issue_approval', 'issue_binding']) expect(failing.state('attestations').steps[step]!.verified_at, step).toBeNull();
  });
});

describe('the cleanup', () => {
  it('says the date of the withdraw while the deposits are locked, then withdraws both when the 90 days are past', async () => {
    const { h } = await started();
    await h.run(attestationsCheck, '--submit');
    await h.run(attestationsCheck, '--submit');
    h.screen.lines.length = 0;
    expect(await h.run(attestationsCheck, 'cleanup', '--submit')).toBe(0);
    expect(h.screen.text).toContain('stays locked until');
    const until = Number(h.state('attestations').steps.issue_approval!.facts.valid_until) + WITHDRAW_WAIT_MS;
    h.clock.t = until + 120_000;
    h.world.chain.tipSlot = Math.floor((h.clock.t - VECTOR_MAINNET.systemStartMs!) / 1000);
    h.screen.lines.length = 0;
    expect(await h.run(attestationsCheck, 'cleanup', '--submit')).toBe(0);
    expect(h.state('attestations').steps.withdraw_approval).toBeDefined();
    expect(h.state('attestations').steps.withdraw_binding).toBeDefined();
    expect(h.world.chain.held.some((u) => Object.keys(u.assets).some((unit) => unit.startsWith(DEPLOYMENT.attestation.hash)))).toBe(false);
  });
  it('has nothing to take back when no attestation was issued', async () => {
    const { h } = await started();
    expect(await h.run(attestationsCheck, 'cleanup')).toBe(0);
    expect(h.screen.text).toContain('no approval attestation to take back');
  });
});

describe('the collateral of the member wallet', () => {
  it('stops an issue step before the build, and before a salt is written, when the member wallet has no pure output of 5 units or more', async () => {
    const poor = await World.identity();
    poor.useUp(MEMBER_N);
    const { h } = await started(poor);
    expect(await h.run(attestationsCheck, '--submit')).toBe(2);
    expect(h.screen.errorText).toContain(`The member wallet ${member.keyHash}`);
    expect(h.screen.errorText).toContain(collateralAdvice(member.address));
    expect(h.screen.errorText).not.toContain('Collateral required');
    expect(h.node.submitted).toEqual([]);
    expect(StateFile.peek(join(h.stateDir, 'attestations.state.json'))?.notes['held.approval']).toBeUndefined();
  });
  it('stops the withdraw of a deposit that is due when the member wallet has no pure output of 5 units or more', async () => {
    const { h } = await started();
    await h.run(attestationsCheck, '--submit');
    await h.run(attestationsCheck, '--submit');
    h.clock.t = Number(h.state('attestations').steps.issue_approval!.facts.valid_until) + WITHDRAW_WAIT_MS + 120_000;
    h.world.chain.tipSlot = Math.floor((h.clock.t - VECTOR_MAINNET.systemStartMs!) / 1000);
    h.world.useUp(MEMBER_N);
    const sent = h.node.submitted.length;
    h.screen.lines.length = 0;
    expect(await h.run(attestationsCheck, 'cleanup', '--submit')).toBe(2);
    expect(h.screen.errorText).toContain(`The member wallet ${member.keyHash}`);
    expect(h.node.submitted).toHaveLength(sent);
  });
});
