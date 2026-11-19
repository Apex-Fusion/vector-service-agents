// The guard of the record: before a step builds anything, the test record is read from the ledger. It must be in the registry, a root, Active, with the controller key that the operator gave,
// and it must list the keys that the step needs with the purposes that the step needs. Each refusal has its accepted twin: the same world with the one thing put right.
import { describe, expect, it } from 'vitest';
import type { IdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { requireRecord } from '../lib/record.ts';
import type { RecordFacts, RecordNeeds } from '../lib/record.ts';
import { PreconditionError } from '../lib/session.ts';
import { harness } from './support/harness.ts';
import { probed } from './support/probe.ts';
import { AGENT_N, NOW, RECORD_ID, World, keyOf } from './support/world.ts';

const agent = keyOf(AGENT_N);
const listed = (purposes: number): Partial<IdentityDatum> => ({ keys: [{ keyType: 'Ed25519', key: agent.publicKeyHex, purposes, pop: null }] });

/** Runs the guard in a probe check over a world whose record is changed by `record`, and gives what it said. */
async function ask(over: { record?: Partial<IdentityDatum>; env?: Record<string, string> }, needs: RecordNeeds = {}): Promise<{ error: unknown; facts: RecordFacts | null; text: string }> {
  const h = await harness({ world: await World.identity(over.record === undefined ? {} : { record: over.record }), ...(over.env === undefined ? {} : { env: over.env }) });
  let error: unknown = null;
  let facts: RecordFacts | null = null;
  await probed(h, async (session) => {
    try { facts = await requireRecord(session, needs); } catch (err) { error = err; }
  });
  return { error, facts, text: h.screen.text };
}

describe('the guard of the record', () => {
  it('accepts the test record, says that it is Active with the controller that was given, and names the keys that the step needs', async () => {
    const answer = await ask({}, { delegationKey: true, authenticationKey: true });
    expect(answer.error).toBeNull();
    expect(answer.facts).toMatchObject({ id: RECORD_ID, did: `did:vector:${RECORD_ID}` });
    expect(answer.text).toContain('is Active, and its controller is the controller key that was given; it lists the agent key with the delegation purpose; it lists the authentication key with the authentication purpose');
  });

  it('refuses a record that is not in the registry; the record of the settings is accepted', async () => {
    const answer = await ask({ env: { CHECKS_RECORD: `did:vector:${'ee'.repeat(32)}` } });
    expect(answer.error).toBeInstanceOf(PreconditionError);
    expect(String(answer.error)).toContain('is not in the identity registry');
  });

  it('refuses a subagent: the checks run on a root record', async () => {
    const answer = await ask({ record: { lineage: { type: 'Subagent', parent: 'aa'.repeat(32), parentEpoch: 0, depth: 1 } } });
    expect(String(answer.error)).toContain('is a subagent');
  });

  it('refuses a record that is not Active, and says its status', async () => {
    const answer = await ask({ record: { status: { type: 'Revoked', by: { type: 'KeyHash', hash: '00'.repeat(28) }, reason: 0, at: NOW - 10_000, invalidFrom: null, successor: null } } });
    expect(String(answer.error)).toContain('is Revoked: it must be Active');
  });

  it('refuses a controller key that is not the controller of the record: the wrong record or the wrong key', async () => {
    const answer = await ask({ record: { controller: keyOf(7).publicKeyHex } });
    expect(answer.error).toBeInstanceOf(PreconditionError);
    expect(String(answer.error)).toContain('is not the controller of the record');
  });

  it('refuses a record that lists the agent key without the delegation purpose, and only when the step needs it', async () => {
    const without = listed(1 + 8);
    expect(String((await ask({ record: without }, { delegationKey: true })).error)).toContain('does not list the agent key with the delegation purpose');
    expect((await ask({ record: without }, { authenticationKey: true })).error).toBeNull();
    expect((await ask({ record: without })).error).toBeNull();
    expect((await ask({ record: listed(1 + 8 + 16) }, { delegationKey: true })).error).toBeNull();
  });

  it('refuses a record that lists the authentication key without the authentication purpose, and only when the step needs it', async () => {
    const without = listed(8 + 16);
    expect(String((await ask({ record: without }, { authenticationKey: true })).error)).toContain('does not list the authentication key with the authentication purpose');
    expect((await ask({ record: without }, { delegationKey: true })).error).toBeNull();
    expect((await ask({ record: listed(1 + 8 + 16) }, { authenticationKey: true })).error).toBeNull();
  });
});
