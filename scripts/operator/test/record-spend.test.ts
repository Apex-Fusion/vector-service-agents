import { describe, expect, it } from 'vitest';
import { awaitRecord, readRecord, recordSpendPlan, resolverReading } from '../lib/record-spend.ts';
import { parseOperatorSettings } from '../lib/settings.ts';
import priorAuth from '../usecases/prior-authorization.ts';
import { spendWorld } from './support/record-spend-builds.ts';
import { hashOf } from './support/task-world.ts';

const setup = () => spendWorld({ use: priorAuth, agent: 'prior-authorization-agent' });

describe('a record spend plan', () => {
  it('explains only the named record input, and permits only the fee outflow and identity destination', async () => {
    const f = await setup();
    const maxFeeLovelace = 1_000_000n;
    const ref = `${f.parentOutput.txHash}#${f.parentOutput.outputIndex}`;
    const plan = recordSpendPlan({
      chain: f.w.chain, registry: f.registry, settings: { ...parseOperatorSettings(f.w.env), maxFeeLovelace },
    }, { recordRef: ref });
    expect(plan.explained).toEqual(new Set([ref]));
    expect(plan.destinations).toEqual(new Set([f.w.chain.deployment.identity.address]));
    expect(plan.maxOutflow).toEqual({ [f.registry.hashOf('fee')]: maxFeeLovelace });
    expect(plan.mint).toEqual({});
    expect(plan.withdrawals).toBe(0);
  });

  it('reads the record and waits only up to the limit for a matching node result', async () => {
    const { w, id } = await setup();
    await expect(readRecord(w, id)).resolves.toMatchObject({ id });
    await expect(readRecord(w, hashOf('not registered'))).rejects.toThrow('not on the node');
    let tries = 0;
    expect(await awaitRecord(w, id, () => ++tries === 3)).toMatchObject({ id });
    expect(w.clock.slept).toEqual([5_000, 5_000]);
    const start = w.clock.now();
    expect(await awaitRecord(w, id, () => false, { windowMs: 11, pauseMs: 5 })).toBeNull();
    expect(w.clock.now() - start).toBe(11);
  });

  it('reports only known resolver statuses and omits text that could expose a key', async () => {
    const f = await setup();
    await expect(resolverReading({ hosted: f.hosted }, f.did)).resolves.toEqual({ read: 'ok', effective: 'Revoked', deactivated: true });
    f.hosted.handlers.vector_resolve_did = () => ({ text: `Failed: ${'abc'.repeat(22)}`, isError: true });
    await expect(resolverReading({ hosted: f.hosted }, f.did)).resolves.toEqual({ read: 'failed', message: 'The resolver message is not public.' });
  });
});
