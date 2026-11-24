import { describe, expect, it } from 'vitest';
import { awaitRecord, readConfirmedRecordSpend, readRecord, recordSpendPlan, resolverReading } from '../lib/record-spend.ts';
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

describe('confirmed record-spend accounting', () => {
  it('reads the exact transaction and returns raw details only when requested', async () => {
    const { w, fee } = await setup();
    const txHash = hashOf('confirmed transaction');
    const inputHash = hashOf('spent output');
    const raw = { inline_datum: { bytes: null, value: { constructor: 0, fields: [] } }, asset_list: [] };
    const out = { tx_hash: txHash, tx_index: 0, payment_addr: { bech32: fee }, value: '9000000', ...raw };
    const input = { ...out, tx_hash: inputHash, value: '10000000' };
    let reported = [out];
    let withDetails = true;
    let phaseTwo: Record<string, unknown> = { plutus_contracts: [{ valid_contract: true }] };
    const fetchImpl: typeof fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ _tx_hashes: [txHash], _inputs: true, _scripts: true, ...(withDetails ? { _assets: true } : {}) });
      return Response.json([{ tx_hash: txHash, fee: '1000000', inputs: [input], outputs: reported, ...phaseTwo }]);
    };
    const session = { node: w.node, chain: { ...w.chain, fetchImpl } };
    w.node.script.push({ confirmations: 1 }, { confirmations: 1 }, { confirmations: 0 });
    await expect(readConfirmedRecordSpend(session, txHash, { withDetails: true })).resolves.toStrictEqual({
      fee: 1_000_000n, inputs: [{ ref: `${inputHash}#0`, address: fee, lovelace: 10_000_000n, ...raw }],
      outputs: [{ ref: `${txHash}#0`, address: fee, lovelace: 9_000_000n, ...raw }],
    });
    reported = [out, out];
    await expect(readConfirmedRecordSpend(session, txHash, { withDetails: true })).rejects.toThrow('same output reference more than once');
    reported = [out];
    await expect(readConfirmedRecordSpend(session, txHash, { withDetails: true })).rejects.toThrow('does not confirm the exact record spend');

    withDetails = false;
    phaseTwo = { valid_contract: true };
    w.node.script.push({ confirmations: 1 });
    await expect(readConfirmedRecordSpend(session, txHash)).resolves.toStrictEqual({
      fee: 1_000_000n, inputs: [{ ref: `${inputHash}#0`, address: fee, lovelace: 10_000_000n }],
      outputs: [{ ref: `${txHash}#0`, address: fee, lovelace: 9_000_000n }],
    });

    for (const unproved of [
      {}, { plutus_contracts: [] }, { plutus_contracts: [{}] },
      { valid_contract: false, plutus_contracts: [{ valid_contract: true }] },
      { valid_contract: true, plutus_contracts: [{ valid_contract: true }, { valid_contract: false }] },
    ]) {
      phaseTwo = unproved;
      w.node.script.push({ confirmations: 1 });
      await expect(readConfirmedRecordSpend(session, txHash)).rejects.toThrow('no affirmative phase-two validity evidence');
    }
  });
});
