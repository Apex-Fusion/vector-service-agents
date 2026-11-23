// packages/usecase-kit/test/janitor/real-builder.test.ts: the Undelegate that the REAL builder of buyer-core makes for a left sub-delegation, in the offline identity world of buyer-core. The janitor checks its bytes with
// the expectations that it makes from the entry and the signer, so this is the test that the real bytes pass them, and that the real fee and the real signer are what the check wants. The rest of the ledger is the fake.
import type { UTxO } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { buildDelegate, buildUndelegate, enterpriseAddressOf, lucidForAddress } from '@vsa/buyer-core';
import type { DelegateBuild, UndelegateBuild } from '@vsa/buyer-core';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { DEPLOYMENT, identityWorld, recordUtxo, rootRecord, testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { MAX_TX_FEE_LOVELACE, deploymentSlotAt, withSubDelegation } from '../../src/access/index.ts';
import type { DelegationDatum, TxSigner } from '../../src/access/index.ts';
import { MemoryLeftStore, runJanitorOnce } from '../../src/janitor/index.ts';
import type { JanitorDeps, LeftEntry } from '../../src/janitor/index.ts';
import { AGENT_ID, PARENT_ID, SUBAGENT_ID, parentDatum, subWorld } from '../access/support.ts';
import { Lane, ProbeChain } from './support.ts';

const AGENT = testKey(41);
const SUBAGENT = testKey(42);
const WALLET = enterpriseAddressOf(AGENT.keyHash);
const ALL_PURPOSES = 1 + 2 + 8 + 16;
const PARENT: DelegationDatum = parentDatum({ delegateKey: AGENT.keyHash });
const idle = async (): Promise<string> => 'done';

/** The identity world: the records of the agent and of its subagent, the parent delegation, the wallet of the agent key, and `extra`. */
async function world(extra: UTxO[] = []) {
  const provider = identityWorld([
    recordUtxo(AGENT_ID, rootRecord({ keys: [{ keyType: 'Ed25519', key: AGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    recordUtxo(SUBAGENT_ID, rootRecord({ endpoint: '', lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 }, keys: [{ keyType: 'Ed25519', key: SUBAGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    { txHash: 'f1'.repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_400_000n, [`${DEPLOYMENT.delegation.hash}${PARENT_ID}`]: 1n }, datum: encodeDelegationDatum(PARENT) },
    { txHash: 'a1'.repeat(32), outputIndex: 0, address: WALLET, assets: { lovelace: 1_000_000_000n } },
    { txHash: 'a1'.repeat(32), outputIndex: 1, address: WALLET, assets: { lovelace: 5_000_000n } },
    ...extra,
  ]);
  return { provider, context: { lucid: await lucidForAddress(provider, WALLET), provider, deployment: DEPLOYMENT } };
}

/** A key that notes each transaction that it signs. */
function counting(keyHash: string, signed: string[]): TxSigner {
  return { keyHash, sign: (cbor) => (signed.push(keyHash), `${cbor}+${keyHash.slice(0, 4)}`) };
}

describe('the Undelegate that the real builder makes', () => {
  it('ends a left sub-delegation: the real bytes pass the rules of the end step, the key of the agent signs them alone, and the fee and the deposit are far below the limits', async () => {
    const { context } = await world();
    const signed: string[] = [];
    const sub = subWorld({
      parent: PARENT,
      script: DEPLOYMENT.delegation,
      request: { agent: { signer: counting(AGENT.keyHash, signed), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: counting(SUBAGENT.keyHash, signed) } },
    });
    sub.chain.slotAt = deploymentSlotAt(context.provider);
    const delegates: DelegateBuild[] = [];
    sub.chain.buildDelegate = async (params) => {
      sub.chain.params.push(params);
      const made = await buildDelegate(context, params);
      delegates.push(made);
      sub.chain.adopt(made);
      return made;
    };
    const store = new MemoryLeftStore();
    sub.chain.faults.buildUndelegateThrows = true;
    const run = await sub.clock.run(withSubDelegation({ ...sub.deps, beforeSend: (left) => store.put({ left, signer_key_hash: AGENT.keyHash }) }, sub.request, sub.limits, idle));
    sub.chain.faults.buildUndelegateThrows = false;
    if (run.end.state !== 'not_ended') throw new Error(`the run ended with ${run.end.state}, and a left sub-delegation was needed`);
    const entry: LeftEntry = { left: run.end.left, signer_key_hash: AGENT.keyHash };
    await store.put(entry);
    expect(await sub.chain.readDelegation(entry.left.id)).not.toBeNull();

    const chain = new ProbeChain(sub.chain);
    const undelegated: UndelegateBuild[] = [];
    chain.buildHook = async (params) => {
      const landed = delegates[0]!;
      const unit = `${DEPLOYMENT.delegation.hash}${landed.id}`;
      const { context: after } = await world([
        { txHash: landed.txHash, outputIndex: landed.outputIndex, address: DEPLOYMENT.delegation.address, assets: { lovelace: landed.outputLovelace, [unit]: 1n }, datum: encodeDelegationDatum(landed.delegation) },
      ]);
      const made = await buildUndelegate(after, params);
      undelegated.push(made);
      sub.chain.adoptUndelegate(made);
      return made;
    };
    const janitorSigns: string[] = [];
    const deps: JanitorDeps = {
      store,
      chain,
      delegationScript: DEPLOYMENT.delegation,
      signerOf: (keyHash) => (keyHash === AGENT.keyHash ? { ...counting(AGENT.keyHash, janitorSigns), address: WALLET } : null),
      queueOf: () => new Lane(),
      tipSlot: async () => 0,
      clock: sub.clock,
      log: () => undefined,
      inFlight: () => false,
    };
    const report = await sub.clock.run(runJanitorOnce(deps));
    expect(report.entries).toStrictEqual([{ id: entry.left.id, state: 'ended', detail: expect.any(String), endTxHash: undelegated[0]!.txHash }]);
    expect(janitorSigns).toStrictEqual([AGENT.keyHash]);
    expect(sub.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
    expect(undelegated).toHaveLength(1);
    expect(undelegated[0]!.requiredSigners.map((s) => s.keyHash)).toStrictEqual([AGENT.keyHash]);
    expect(BigInt(undelegated[0]!.fee) * 2n).toBeLessThan(MAX_TX_FEE_LOVELACE);
    expect(await store.list()).toStrictEqual([]);
    expect(await sub.chain.readDelegation(entry.left.id)).toBeNull();
  });
});
