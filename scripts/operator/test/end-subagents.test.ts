import { describe, expect, it } from 'vitest';
import { buildEndSubagents } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { DAY, M1, recordUtxo } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import type { Status } from '../../../packages/vector-read/src/identity-codec.ts';
import { effectiveStatus } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import endSubagents from '../tasks/end-subagents.ts';
import priorAuth from '../usecases/prior-authorization.ts';
import { spendWorld, TOOLS } from './support/record-spend-builds.ts';
import type { SpendWorldOptions } from './support/record-spend-builds.ts';
import { hashOf, NOW } from './support/task-world.ts';

const NAME = 'prior-authorization-agent';
const moduleHold: Status = { type: 'Suspended', holds: [{ by: { type: 'Script', hash: M1 }, reason: 64, since: NOW - DAY, until: NOW + DAY }] };

async function setup(over: Partial<SpendWorldOptions> = {}) {
  const f = await spendWorld({ use: priorAuth, agent: NAME, ...over });
  f.showRunning(f.agent.adverts.map(({ runtimeContainer }) => runtimeContainer));
  f.w.writeGo({ tasks: ['end-subagents'], irreversible: ['end-subagents'] });
  return f;
}

describe('end-subagents', () => {
  it.each([false, true])('ends both children and preserves the parent datum except for the epoch (held: %s)', async (held) => {
    const f = await setup({ parent: { subagentEpoch: 4, ...(held ? { status: moduleHold } : {}) }, failResolver: held });
    const built = await buildEndSubagents(await f.context(), { changeAddress: f.fee, id: f.id, nowMs: NOW });
    f.prepare(TOOLS.end, built);
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(0);
    expect(f.hosted.calls[0]).toEqual({ name: TOOLS.end, args: { changeAddress: f.fee, did: f.did } });
    expect(f.signed.sort()).toEqual(['controller', 'fee']);
    const current = await f.record();
    expect(current.record).toEqual({ ...f.parent, subagentEpoch: 5 });
    expect(current.utxo.assets.lovelace).toBe(f.parentOutput.assets.lovelace);
    for (const id of f.childIds.values()) {
      const child = await f.record(id);
      expect(effectiveStatus(child.record, new Map([[f.id, current.record]]), f.w.clock.now(), f.w.clock.now())).toBe('Revoked');
    }
    const journal = f.w.state('end-subagents').steps['end-subagents'];
    expect(journal).toMatchObject({ tx_hash: built.txHash, verified_at: expect.any(String) });
    expect(f.w.facts().subagentEnds[NAME]).toEqual({ tx: built.txHash, at: journal.confirmed_at, epochBefore: 4, epochAfter: 5 });
    expect(f.hosted.calls.slice(1)).toEqual([...f.childIds.values()].map((id) => ({ name: TOOLS.resolve, args: { did: `did:vector:${id}` } })));
    const verified = f.w.evidence('end-subagents').find((entry) => entry.status === 'verified');
    expect(verified).toMatchObject({ shows: {
      before: { effective: held ? 'Suspended' : 'Active', subagentEpoch: 4 }, after: { effective: held ? 'Suspended' : 'Active', subagentEpoch: 5 },
      subagents: [...f.childIds.keys()].map((name) => ({ agent: name, before: held ? 'Suspended' : 'Active', after: 'Revoked',
        resolver: held ? { read: 'unavailable', message: 'Z'.repeat(300) } : { read: 'ok', effective: 'Revoked' } })),
    } });
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(await f.run(endSubagents, 'run', '--run', 'again', '--submit')).toBe(2);
    expect(f.w.node.submitted).toHaveLength(1);
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.end)).toHaveLength(1);
  });

  it('verifies a confirmed spend on the next run without building it again', async () => {
    const f = await setup();
    const built = await buildEndSubagents(await f.context(), { changeAddress: f.fee, id: f.id, nowMs: NOW });
    f.prepare(TOOLS.end, built);
    const { node } = f.w;
    const submit = node.submit.bind(node);
    let hidden: RecordUtxo['utxo'] | undefined;
    node.submit = async (cbor) => {
      const hash = await submit(cbor);
      const chain = f.w.world.chain;
      hidden = chain.held.find((output) => output.txHash === hash && output.outputIndex === built.recordOutputIndex);
      chain.held = chain.held.filter((output) => output !== hidden);
      return hash;
    };
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(1);
    expect(f.w.facts().subagentEnds).toEqual({});
    expect(f.w.state('end-subagents').steps['end-subagents']).toMatchObject({ tx_hash: built.txHash, verified_at: null });
    expect(hidden).toBeDefined();
    f.w.world.chain.held.push(hidden!);
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(0);
    expect(f.w.facts().subagentEnds[NAME]).toMatchObject({ tx: built.txHash });
    expect(f.hosted.calls.filter(({ name }) => name === TOOLS.end)).toHaveLength(1);
    expect(node.submitted).toHaveLength(1);
  });

  it('refuses a parent with an independent hold', async () => {
    const status: Status = { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 6, since: NOW - DAY, until: NOW + DAY }] };
    const f = await setup({ parent: { status } });
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('reason other than a verified Module-1 verdict hold');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it('does not request a build or a signature in dry mode', async () => {
    const f = await setup();
    expect(await f.run(endSubagents, 'run')).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'dry' });
    expect(f.w.screen.text).toContain('No transaction was built.');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
    expect(f.w.facts().subagentEnds).toEqual({});
  });

  it('refuses a working runtime or missing approval tag before the build', async () => {
    const f = await setup();
    f.setRuntime('working');
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('says working');
    f.setRuntime('free');
    f.w.writeGo({ tasks: ['end-subagents'], irreversible: [] });
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('irreversible tag end-subagents');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it('checks the running runtime again after the build and before it signs', async () => {
    const f = await setup();
    const built = await buildEndSubagents(await f.context(), { changeAddress: f.fee, id: f.id, nowMs: NOW });
    f.prepare(TOOLS.end, built);
    f.hosted.handlers[TOOLS.end] = () => {
      f.setRuntime('working');
      return f.answers.get(TOOLS.end)!;
    };
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('says working');
    expect(f.signed).toEqual([]);
    expect(f.w.node.submitted).toEqual([]);
  });

  it.each([
    { child: null, problem: 'not on the node' },
    { child: { lineage: { type: 'Subagent' as const, parent: hashOf('a different parent'), parentEpoch: 0, depth: 1 } }, problem: 'direct child' },
    { child: { parties: [] }, problem: 'not Active on its own' },
    { child: { status: { type: 'Revoked' as const, by: { type: 'ControllerSet' as const }, reason: 9, at: NOW - DAY, invalidFrom: null, successor: null } }, problem: 'not Active on its own' },
  ])('refuses an absent child or a child with different lineage or own status: $problem', async ({ child, problem }) => {
    const f = await setup({ parent: { status: moduleHold }, children: { 'record-reader': child } });
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain(problem);
    expect(f.hosted.calls).toEqual([]);
    expect(f.signed).toEqual([]);
  });

  it('refuses a child from an earlier epoch even when the facts file has no end fact', async () => {
    const f = await setup({ parent: { subagentEpoch: 1 } });
    const childId = f.childIds.get('record-reader')!;
    const child = await f.record(childId);
    const earlier = recordUtxo(childId, { ...child.record, lineage: { type: 'Subagent', parent: f.id, parentEpoch: 0, depth: 1 } });
    f.w.world.chain.held = f.w.world.chain.held.filter((output) => output !== child.utxo).concat(earlier);
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('current parent epoch');
    expect(f.hosted.calls).toEqual([]);
  });

  it('refuses a build for another record even when it has the same required signers', async () => {
    const f = await setup();
    const other = hashOf('another record');
    f.w.world.chain.held.push(recordUtxo(other, f.parent));
    f.prepare(TOOLS.end, await buildEndSubagents(await f.context(), { changeAddress: f.fee, id: other, nowMs: NOW }));
    expect(await f.run(endSubagents, 'run', '--submit')).toBe(2);
    expect(f.w.screen.errorText).toContain('does not spend the selected record');
    expect(f.signed).toEqual([]);
  });
});
