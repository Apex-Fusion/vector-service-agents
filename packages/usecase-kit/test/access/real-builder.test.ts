// packages/usecase-kit/test/access/real-builder.test.ts: the Delegate that the REAL builder of buyer-core makes for the terms of a sub-delegation, in the offline identity world of buyer-core. Lucid runs
// the applied delegation script on the build, so a build that completes passes the contract (minus the signatures). The rest of the ledger is the fake of support.ts.
import { describe, expect, it } from 'vitest';
import { buildDelegate, enterpriseAddressOf, lucidForAddress } from '@vsa/buyer-core';
import type { DelegateBuild } from '@vsa/buyer-core';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { DEPLOYMENT, identityWorld, recordUtxo, rootRecord, testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { withSubDelegation } from '../../src/access/index.ts';
import type { DelegationDatum, SubDelegationRun } from '../../src/access/index.ts';
import { AGENT_ID, DAY, NOW, PARENT_ID, SUBAGENT_ID, markSigner, parentDatum, subWorld, type SubWorld } from './support.ts';

const AGENT = testKey(41);
const SUBAGENT = testKey(42);
const UNLISTED = testKey(43);
const WALLET = enterpriseAddressOf(AGENT.keyHash);
const ALL_PURPOSES = 1 + 2 + 8 + 16;
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const idle = async (): Promise<string> => 'done';

/** The delegation of the hirer to the agent: one more hop, a value limit, and the delegate key of the agent. */
const PARENT: DelegationDatum = parentDatum({ delegateKey: AGENT.keyHash });

/** The identity world: the record of the agent, the record of its subagent, the parent delegation on the ledger (`parent` says what the ledger holds), and the wallet of the agent key. */
async function world(parent: DelegationDatum = PARENT) {
  const provider = identityWorld([
    recordUtxo(AGENT_ID, rootRecord({ keys: [{ keyType: 'Ed25519', key: AGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    recordUtxo(SUBAGENT_ID, rootRecord({ endpoint: '', lineage: { type: 'Subagent', parent: AGENT_ID, parentEpoch: 0, depth: 1 }, keys: [{ keyType: 'Ed25519', key: SUBAGENT.publicKey, purposes: ALL_PURPOSES, pop: null }] })),
    { txHash: 'f1'.repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_400_000n, [`${DEPLOYMENT.delegation.hash}${PARENT_ID}`]: 1n }, datum: encodeDelegationDatum(parent) },
    { txHash: 'a1'.repeat(32), outputIndex: 0, address: WALLET, assets: { lovelace: 1_000_000_000n } },
    { txHash: 'a1'.repeat(32), outputIndex: 1, address: WALLET, assets: { lovelace: 5_000_000n } },
  ]);
  return { provider, context: { lucid: await lucidForAddress(provider, WALLET), provider, deployment: DEPLOYMENT } };
}

/** A run in which the builder is the real one. The ledger reads, the node and the confirmations are the fake. */
interface KeyFacts {
  readonly publicKey: string;
  readonly keyHash: string;
}
async function run(options: { ledger?: DelegationDatum; subagentKey?: KeyFacts } = {}): Promise<{ w: SubWorld; result: SubDelegationRun<string>; built: DelegateBuild[] }> {
  const { context } = await world(options.ledger);
  const w = subWorld({
    parent: PARENT,
    request: { agent: { signer: markSigner(AGENT.keyHash), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: markSigner((options.subagentKey ?? SUBAGENT).keyHash) } },
  });
  const built: DelegateBuild[] = [];
  w.chain.buildDelegate = async (params) => {
    w.chain.params.push(params);
    const made = await buildDelegate(context, params);
    built.push(made);
    w.chain.adopt(made);
    return made;
  };
  const result = await w.clock.run(withSubDelegation(w.deps, w.request, w.limits, idle));
  return { w, result, built };
}

describe('the Delegate that the real builder makes', () => {
  it('is the narrow sub-delegation: one hop below the parent, remaining 0, a value of 0, one action and one resource, and a period inside the parent', async () => {
    const { result, built } = await run();
    expect(result).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(built).toHaveLength(1);
    const d = built[0]!.delegation;
    expect(d).toStrictEqual({
      delegator: { type: 'Agent', id: AGENT_ID }, parent: PARENT_ID, delegate: SUBAGENT_ID, delegateKey: SUBAGENT.keyHash,
      actions: [hex('erp.stock.read')], resources: [hex('https://mock.example/t/run1/erp')], notBefore: expect.any(Number), notAfter: NOW + 3_600_000,
      depth: 2, remaining: 0, purpose: null, value: { perTx: 0n, total: 0n, periodMs: DAY },
    });
    expect(d.notBefore).toBeGreaterThanOrEqual(PARENT.notBefore);
    expect(d.notBefore).toBeLessThan(d.notAfter);
  });

  it('needs the signature of the live delegation key of the agent and of the delegation key of the subagent, and of no other key', async () => {
    const { built } = await run();
    expect(built[0]!.requiredSigners.map((s) => s.keyHash).sort()).toStrictEqual([AGENT.keyHash, SUBAGENT.keyHash].sort());
  });

  it('locks the ledger minimum for its datum, and pays a fee', async () => {
    const { built } = await run();
    expect(built[0]!.outputLovelace).toBeGreaterThan(1_000_000n);
    expect(built[0]!.outputLovelace).toBeLessThan(5_000_000n);
    expect(BigInt(built[0]!.fee)).toBeGreaterThan(100_000n);
    expect(BigInt(built[0]!.fee)).toBeLessThan(1_000_000n);
  });

  it('is refused by the real builder for a delegate key that the subagent does not list, and the refusal comes back with its words and nothing is sent', async () => {
    const { w, result } = await run({ subagentKey: UNLISTED });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_refused' }, end: { state: 'not_made' } });
    expect(result.kind === 'not_ready' && result.failure.detail).toMatch(/does not list the key/);
    expect(w.chain.submitted).toHaveLength(0);
  });

  it('is refused by the real builder when the ledger has a parent with no further hop, although a read said that it has one', async () => {
    const { w, result } = await run({ ledger: { ...PARENT, remaining: 0 } });
    expect(result).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_refused' }, end: { state: 'not_made' } });
    expect(result.kind === 'not_ready' && result.failure.detail).toMatch(/no further hop/);
    expect(w.chain.submitted).toHaveLength(0);
  });
});
