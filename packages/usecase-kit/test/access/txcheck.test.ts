// packages/usecase-kit/test/access/txcheck.test.ts: the keys sign only a transaction that was read. The ledger of support.ts makes real bytes, and `txTamper` plays a builder that gives other bytes
// than its report says. Each refusal has the same run with honest bytes as its twin: it is signed, sent and ended. A refusal is `build_mismatch` for a Delegate and `end_failed` for an Undelegate,
// and no key signs.
import { describe, expect, it } from 'vitest';
import { decodeDelegationDatum, encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { MAX_COLLATERAL_LOVELACE, MAX_DELEGATION_DEPOSIT_LOVELACE, MAX_TX_FEE_LOVELACE, withSubDelegation } from '../../src/access/index.ts';
import type { DelegationDatum, SubDelegationRun } from '../../src/access/index.ts';
import { AGENT_KEY, DAY, OTHER_KEY, SCRIPT, SCRIPT_HASH, STRANGER, SUBAGENT_ID, SUBAGENT_KEY, WALLET, subWorld, type OutputSpec, type SubWorld, type TxSpec } from './support.ts';

const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const idle = async (): Promise<string> => 'done';
const OTHER_POLICY = 'cd'.repeat(28);

/** A world whose keys count their signatures, so that a test sees that a refused transaction was never signed. */
function counted(over: Parameters<typeof subWorld>[0] = {}): { w: SubWorld; signs: string[] } {
  const signs: string[] = [];
  const key = (keyHash: string) => ({ keyHash, sign: (cbor: string) => (signs.push(keyHash), `${cbor}+${keyHash.slice(0, 4)}`) });
  const w = subWorld({ ...over, request: { agent: { signer: key(AGENT_KEY), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: key(SUBAGENT_KEY) }, ...over.request } });
  return { w, signs };
}
const go = <T>(w: SubWorld, job: () => Promise<T>): Promise<SubDelegationRun<T>> => w.clock.run(withSubDelegation(w.deps, w.request, w.limits, job));
const datumOf = (spec: TxSpec): DelegationDatum => decodeDelegationDatum(spec.outputs[0]!.datumHex!);
const withOutput = (spec: TxSpec, index: number, change: Partial<OutputSpec>): TxSpec => ({ ...spec, outputs: spec.outputs.map((output, at) => (at === index ? { ...output, ...change } : output)) });

describe('a Delegate whose bytes are not the narrow delegation that was asked for is never signed', () => {
  const idOf = (spec: TxSpec): string => spec.mint[0]!.name;
  const token = (spec: TxSpec) => ({ policy: SCRIPT_HASH, name: idOf(spec), quantity: 1n });
  const refused: [string, (spec: TxSpec) => TxSpec, string][] = [
    // the datum in the bytes
    ['the datum of a wider delegation: two actions, two resources and a value', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), actions: [hex('erp.stock.read'), hex('po.write')], resources: [hex('https://mock.example/t/run1/erp'), hex('https://mock.example/t/run1/po')], value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY } }) }), 'byte for byte'],
    ['one more hop in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), remaining: 1 }) }), 'byte for byte'],
    ['a value of 1 in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), value: { perTx: 1n, total: 1n, periodMs: DAY } }) }), 'byte for byte'],
    ['another delegate key in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), delegateKey: OTHER_KEY }) }), 'byte for byte'],
    ['another delegator in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), delegator: { type: 'Agent', id: 'dd'.repeat(32) } }) }), 'byte for byte'],
    ['a purpose in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), purpose: 'ee'.repeat(32) }) }), 'byte for byte'],
    ['a later end in the datum', (s) => withOutput(s, 0, { datumHex: encodeDelegationDatum({ ...datumOf(s), notAfter: datumOf(s).notAfter + 1 }) }), 'byte for byte'],
    ['a datum hash and no inline datum', (s) => withOutput(s, 0, { datumHex: undefined, datumHash: '00'.repeat(32) }), 'no inline datum'],
    // the tokens
    ['no mint', (s) => ({ ...s, mint: [] }), 'does not mint exactly'],
    ['a mint of two tokens of the policy', (s) => ({ ...s, mint: [token(s), { policy: SCRIPT_HASH, name: '01'.repeat(32), quantity: 1n }] }), 'does not mint exactly'],
    ['a mint of a token of another policy besides the token', (s) => ({ ...s, mint: [token(s), { policy: OTHER_POLICY, name: '01', quantity: 1n }] }), 'does not mint exactly'],
    ['a token with another name', (s) => ({ ...s, mint: [{ ...token(s), name: '02'.repeat(32) }] }), 'does not mint exactly'],
    ['a token of another policy', (s) => ({ ...s, mint: [{ ...token(s), policy: OTHER_POLICY }] }), 'does not mint exactly'],
    ['a mint of 2', (s) => ({ ...s, mint: [{ ...token(s), quantity: 2n }] }), 'does not mint exactly'],
    ['a burn', (s) => ({ ...s, mint: [{ ...token(s), quantity: -1n }] }), 'does not mint exactly'],
    // the outputs
    ['a second output at the delegation script', (s) => ({ ...s, outputs: [...s.outputs, { address: SCRIPT.address, coin: 1_500_000n, datumHex: s.outputs[0]!.datumHex }] }), '2 outputs at the delegation script'],
    ['no output at the delegation script', (s) => ({ ...s, outputs: [s.outputs[1]!] }), '0 outputs at the delegation script'],
    ['a delegation output with no token', (s) => withOutput(s, 0, { tokens: [] }), 'does not hold exactly the one token'],
    ['a delegation output with a second token', (s) => withOutput(s, 0, { tokens: [token(s), { policy: OTHER_POLICY, name: '01', quantity: 1n }] }), 'does not hold exactly the one token'],
    ['a delegation output with another token', (s) => withOutput(s, 0, { tokens: [{ ...token(s), name: '02'.repeat(32) }] }), 'does not hold exactly the one token'],
    ['a deposit above the limit', (s) => withOutput(s, 0, { coin: MAX_DELEGATION_DEPOSIT_LOVELACE + 1n }), 'above the limit'],
    ['an output to another address', (s) => ({ ...s, outputs: [...s.outputs, { address: STRANGER, coin: 1_000_000n }] }), 'neither the delegation script nor the wallet'],
    ['the change to another address', (s) => withOutput(s, 1, { address: STRANGER }), 'neither the delegation script nor the wallet'],
    // what else the body does
    ['a certificate', (s) => ({ ...s, certs: true }), 'certificates'],
    ['a withdrawal', (s) => ({ ...s, withdrawals: true }), 'withdrawals'],
    ['a gift to the treasury', (s) => ({ ...s, donation: 1_000_000n }), 'treasury'],
    ['a value of the treasury', (s) => ({ ...s, treasury: 1n }), 'treasury'],
    ['votes', (s) => ({ ...s, votes: true }), 'votes or proposals'],
    ['proposals', (s) => ({ ...s, proposals: true }), 'votes or proposals'],
    ['a flag that says that the transaction is not valid', (s) => ({ ...s, isValid: false }), 'not valid'],
    ['a fee above the limit', (s) => ({ ...s, fee: MAX_TX_FEE_LOVELACE + 1n }), 'above the limit'],
    // the signers
    ['a third required signer', (s) => ({ ...s, signers: [...s.signers, OTHER_KEY] }), 'required signers'],
    ['one required signer', (s) => ({ ...s, signers: [AGENT_KEY] }), 'required signers'],
    ['the same required signer two times', (s) => ({ ...s, signers: [AGENT_KEY, AGENT_KEY] }), 'required signers'],
    ['other required signers', (s) => ({ ...s, signers: [OTHER_KEY, SUBAGENT_KEY] }), 'required signers'],
    ['no required signer', (s) => ({ ...s, signers: [] }), 'required signers'],
    // the collateral
    ['collateral with no total', (s) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: WALLET, total: null } }), 'collateral'],
    ['a total collateral above the limit', (s) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: WALLET, total: MAX_COLLATERAL_LOVELACE + 1n } }), 'collateral'],
    ['a collateral return to another address', (s) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: STRANGER, total: MAX_COLLATERAL_LOVELACE } }), 'collateral return'],
  ];

  it.each(refused)('is refused for %s: build_mismatch, no key signs, nothing is sent, nothing is ended', async (_name, change, why) => {
    const { w, signs } = counted();
    w.chain.txTamper = (spec, kind) => (kind === 'delegate' ? change(spec) : spec);
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'build_mismatch', detail: expect.stringContaining(why) }, end: { state: 'not_made' } });
    expect(signs).toStrictEqual([]);
    expect(w.chain.submitted).toHaveLength(0);
    expect(w.chain.log).not.toContain('buildUndelegate');
  });

  it.each([
    ['the honest bytes', (s: TxSpec) => s],
    ['required signers in another order', (s: TxSpec) => ({ ...s, signers: [...s.signers].reverse() })],
    ['a deposit at the limit', (s: TxSpec) => withOutput(s, 0, { coin: MAX_DELEGATION_DEPOSIT_LOVELACE })],
    ['a fee at the limit', (s: TxSpec) => ({ ...s, fee: MAX_TX_FEE_LOVELACE })],
    ['collateral at the limit, returned to the wallet', (s: TxSpec) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: WALLET, total: MAX_COLLATERAL_LOVELACE } })],
    ['collateral with no return', (s: TxSpec) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: null, total: 1_000_000n } })],
    ['a datum that the same fields encode to, with the output after the change', (s: TxSpec) => ({ ...s, outputs: [s.outputs[1]!, s.outputs[0]!] })],
  ])('is signed by both keys, sent and ended for %s: the twin of every refusal above', async (_name, change) => {
    const { w, signs } = counted();
    w.chain.txTamper = (spec, kind) => (kind === 'delegate' ? change(spec) : spec);
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(signs.slice(0, 2).sort()).toStrictEqual([AGENT_KEY, SUBAGENT_KEY].sort());
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate', 'undelegate']);
  });

  it('is refused when the hash in the report is not the hash of the bytes, and when it is not a hash', async () => {
    for (const [reported, why] of [['ee'.repeat(32), 'is not the hash of the transaction'], ['not-a-hash', 'no transaction hash']] as const) {
      const { w, signs } = counted();
      w.chain.reportHash = reported;
      expect(await go(w, idle), reported).toMatchObject({ ok: false, failure: { code: 'build_mismatch', detail: expect.stringContaining(why) }, end: { state: 'not_made' } });
      expect(signs).toStrictEqual([]);
    }
  });

  it.each([['text that is not hex', 'zz'], ['hex that is not a transaction', '00'], ['an empty text', ''], ['a list nested too deep', '81'.repeat(2_000)]])(
    'is refused when the bytes cannot be read: %s',
    async (_name, txCbor) => {
      const { w, signs } = counted();
      const build = w.chain.buildDelegate.bind(w.chain);
      w.chain.buildDelegate = async (params) => ({ ...(await build(params)), txCbor });
      expect(await go(w, idle)).toMatchObject({ ok: false, failure: { code: 'build_mismatch', detail: expect.stringContaining('cannot be read') }, end: { state: 'not_made' } });
      expect(signs).toStrictEqual([]);
      expect(w.chain.submitted).toHaveLength(0);
    },
  );

  it('is refused when the report of the build is narrow and the bytes are wide: the probe of the review, and the datum in the report is not what the keys read', async () => {
    const { w, signs } = counted();
    w.chain.txTamper = (spec, kind) => (kind === 'delegate' ? withOutput(spec, 0, { datumHex: encodeDelegationDatum({ ...datumOf(spec), actions: [hex('po.write')], value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY } }) }) : spec);
    const run = await go(w, idle);
    expect(w.chain.builtDelegates[0]!.delegation.actions).toStrictEqual([hex('erp.stock.read')]);
    expect(run).toMatchObject({ ok: false, failure: { code: 'build_mismatch' }, end: { state: 'not_made' } });
    expect(signs).toStrictEqual([]);
  });
});

describe('an Undelegate whose bytes are not the end of this delegation is never signed', () => {
  const token = (spec: TxSpec, quantity: bigint) => ({ policy: SCRIPT_HASH, name: spec.mint[0]!.name, quantity });
  const refused: [string, (spec: TxSpec) => TxSpec, string][] = [
    ['no burn', (s) => ({ ...s, mint: [] }), 'does not burn exactly'],
    ['a mint instead of a burn', (s) => ({ ...s, mint: [token(s, 1n)] }), 'does not burn exactly'],
    ['a burn of 2', (s) => ({ ...s, mint: [token(s, -2n)] }), 'does not burn exactly'],
    ['a burn of another token', (s) => ({ ...s, mint: [{ ...token(s, -1n), name: '02'.repeat(32) }] }), 'does not burn exactly'],
    ['a burn of a token of another policy', (s) => ({ ...s, mint: [{ ...token(s, -1n), policy: OTHER_POLICY }] }), 'does not burn exactly'],
    ['a burn and a mint', (s) => ({ ...s, mint: [token(s, -1n), { policy: OTHER_POLICY, name: '01', quantity: 5n }] }), 'does not burn exactly'],
    ['an output to another address', (s) => ({ ...s, outputs: [...s.outputs, { address: STRANGER, coin: 1_000_000n }] }), 'not the wallet of the agent'],
    ['the change to another address', (s) => withOutput(s, 0, { address: STRANGER }), 'not the wallet of the agent'],
    ['an output at the delegation script', (s) => ({ ...s, outputs: [...s.outputs, { address: SCRIPT.address, coin: 2_000_000n }] }), 'not the wallet of the agent'],
    ['a certificate', (s) => ({ ...s, certs: true }), 'certificates'],
    ['a withdrawal', (s) => ({ ...s, withdrawals: true }), 'withdrawals'],
    ['a gift to the treasury', (s) => ({ ...s, donation: 1n }), 'treasury'],
    ['a fee above the limit', (s) => ({ ...s, fee: MAX_TX_FEE_LOVELACE + 1n }), 'above the limit'],
    ['the key of the subagent as a second required signer', (s) => ({ ...s, signers: [AGENT_KEY, SUBAGENT_KEY] }), 'required signers'],
    ['another key as the required signer', (s) => ({ ...s, signers: [OTHER_KEY] }), 'required signers'],
    ['no required signer', (s) => ({ ...s, signers: [] }), 'required signers'],
    ['collateral that can be forfeited with no limit', (s) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: WALLET, total: null } }), 'collateral'],
    ['a collateral return to another address', (s) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: STRANGER, total: 1_000_000n } }), 'collateral return'],
  ];

  it.each(refused)('is not signed and not sent for %s: the job value stays, and the reference that is left is reported', async (_name, change, why) => {
    const { w, signs } = counted();
    w.chain.txTamper = (spec, kind) => (kind === 'undelegate' ? change(spec) : spec);
    const run = await go(w, idle);
    expect(run).toMatchObject({ ok: true, kind: 'returned', value: 'done', end: { state: 'not_ended', code: 'end_failed', detail: expect.stringContaining(why), left: { id: w.chain.subId, endTxHash: null } } });
    expect(signs).toStrictEqual([AGENT_KEY, SUBAGENT_KEY]);
    expect(w.chain.submitted.map((s) => s.kind)).toStrictEqual(['delegate']);
  });

  it('is refused when the hash in the report is not the hash of the bytes, and signed by the agent key alone when it is', async () => {
    const bad = counted();
    bad.w.chain.txTamper = (spec) => spec;
    const build = bad.w.chain.buildUndelegate.bind(bad.w.chain);
    bad.w.chain.buildUndelegate = async (params) => ({ ...(await build(params)), txHash: 'ee'.repeat(32) });
    expect(await go(bad.w, idle)).toMatchObject({ ok: true, end: { state: 'not_ended', code: 'end_failed', detail: expect.stringContaining('is not the hash of the transaction') } });
    const good = counted();
    expect(await go(good.w, idle)).toMatchObject({ ok: true, end: { state: 'ended' } });
    expect(good.signs).toStrictEqual([AGENT_KEY, SUBAGENT_KEY, AGENT_KEY]);
  });

  it('is refused when the bytes cannot be read', async () => {
    const { w, signs } = counted();
    const build = w.chain.buildUndelegate.bind(w.chain);
    w.chain.buildUndelegate = async (params) => ({ ...(await build(params)), txCbor: 'zz' });
    expect(await go(w, idle)).toMatchObject({ ok: true, end: { state: 'not_ended', code: 'end_failed', detail: expect.stringContaining('cannot be read') } });
    expect(signs).toStrictEqual([AGENT_KEY, SUBAGENT_KEY]);
  });

  it.each([
    ['the honest bytes', (s: TxSpec) => s],
    ['a fee at the limit', (s: TxSpec) => ({ ...s, fee: MAX_TX_FEE_LOVELACE })],
    ['collateral at the limit, returned to the wallet', (s: TxSpec) => ({ ...s, collateral: { inputs: s.inputs, returnAddress: WALLET, total: MAX_COLLATERAL_LOVELACE } })],
  ])('is signed by the agent key and sent for %s: the twin of every refusal above', async (_name, change) => {
    const { w } = counted();
    w.chain.txTamper = (spec, kind) => (kind === 'undelegate' ? change(spec) : spec);
    expect(await go(w, idle)).toMatchObject({ ok: true, kind: 'returned', end: { state: 'ended' } });
    expect(w.chain.submitted[1]!.cbor.endsWith(`+${AGENT_KEY.slice(0, 4)}`)).toBe(true);
  });
});

describe('the delegation script and the wallet of the request', () => {
  it.each([
    ['no script', undefined],
    ['a hash that is not 56 hex characters', { hash: 'ab', address: SCRIPT.address }],
    ['a hash in capital letters', { hash: SCRIPT_HASH.toUpperCase(), address: SCRIPT.address }],
    ['an address that is not an address', { hash: SCRIPT_HASH, address: 'not an address' }],
    ['the address of a wallet', { hash: SCRIPT_HASH, address: WALLET }],
    ['the address of another script', { hash: 'cd'.repeat(28), address: SCRIPT.address }],
    ['a hash that is a number', { hash: 5, address: SCRIPT.address }],
  ])('is refused before anything is built: %s', async (_name, script) => {
    const w = subWorld();
    const run = await w.clock.run(withSubDelegation({ ...w.deps, delegationScript: script as never }, w.request, w.limits, idle));
    expect(run).toMatchObject({ ok: false, kind: 'not_ready', failure: { code: 'bad_request' }, end: { state: 'not_made' } });
    expect(w.chain.log).toStrictEqual([]);
  });

  it('is refused when the wallet address is not an address, or the queue is not a queue, and accepted when both are right: the twin', async () => {
    const wrongWallet = subWorld({ request: { agent: { signer: { keyHash: AGENT_KEY, sign: (c: string) => c }, walletAddress: 'addr1_wallet_of_the_agent_key' } } });
    expect(await go(wrongWallet, idle)).toMatchObject({ failure: { code: 'bad_request', detail: expect.stringContaining('walletAddress') } });
    const w = subWorld();
    for (const walletQueue of [undefined, null, {}, { run: 5 }]) {
      expect(await w.clock.run(withSubDelegation({ ...w.deps, walletQueue: walletQueue as never }, w.request, w.limits, idle))).toMatchObject({ failure: { code: 'bad_request', detail: expect.stringContaining('walletQueue') } });
    }
    expect((await go(subWorld(), idle)).kind).toBe('returned');
  });
});
