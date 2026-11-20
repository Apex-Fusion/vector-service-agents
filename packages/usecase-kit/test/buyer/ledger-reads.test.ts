// packages/usecase-kit/test/buyer/ledger-reads.test.ts: the port over a `LedgerEnv` of buyer-core (`ledgerReadsFrom`), on the offline world that the tests of buyer-core use: a node that holds outputs, and
// a fake Koios. The port reads the delegation and the Live vault outputs that name it. An output of another owner than the delegator is left out, and so is an output that the node does not hold.
// A read that cannot be made rejects, so that the flow never reads it as "not found". The last tests run the authority check and the vault search of the flow over the same world.
import { describe, expect, it } from 'vitest';
import type { UTxO } from '@lucid-evolution/lucid';
import type { Delegator, VaultDatum } from '@vsa/vector-read/identity-codec';
import { checkAuthority, findLiveVault, ledgerReadsFrom } from '@vsa/usecase-kit/buyer';
import { testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { CAPTURE_MS, DAY, delegation, delegationUtxo, koiosRow, ledgerWorld, liveRecord, recordUtxo, vaultUtxo } from '../../../buyer-core/test/fixtures/ledger-read-world.ts';

type Live = Extract<VaultDatum, { type: 'Live' }>;

const owner: Delegator = { type: 'PrincipalKey', hash: testKey(50).keyHash, organisation: null };
const ATTACKER: Delegator = { type: 'PrincipalKey', hash: testKey(51).keyHash, organisation: null };
const D = 'd1'.repeat(32);
/** The agent that the delegation of the fixtures names as its delegate. */
const AGENT = delegation().delegate;
const AGENT_DID = `did:vector:${AGENT}`;
const live = (over: Partial<Live> = {}): Live => ({ type: 'Live', owner, delegation: D, spent: 1_000_000n, periodStart: CAPTURE_MS - DAY / 2, ...over });
const refOf = (utxo: UTxO): string => `${utxo.txHash}#${utxo.outputIndex}`;
/** The delegation D of `owner`, and the record of its delegate, which the use checks of a payment read. */
const delegated = (over = {}): UTxO[] => [delegationUtxo(D, delegation({ delegator: owner, ...over })), recordUtxo(AGENT, liveRecord({}, [testKey(31).publicKey]))];

describe('ledgerReadsFrom: the delegation', () => {
  it('reads the delegate of a delegation that exists, with its chain whole', async () => {
    const reads = ledgerReadsFrom(ledgerWorld(delegated()).env);
    expect(await reads.delegation(D)).toStrictEqual({ delegate: AGENT, chain_whole: true });
  });

  it('reads a delegation that the ledger does not have as null: it was never made, or it was undelegated', async () => {
    const reads = ledgerReadsFrom(ledgerWorld([]).env);
    expect(await reads.delegation(D)).toBeNull();
  });

  it('says that the chain is not whole when an ancestor was undelegated: the delegation exists and no Pay can use it', async () => {
    const reads = ledgerReadsFrom(ledgerWorld(delegated({ parent: 'aa'.repeat(32) })).env);
    expect(await reads.delegation(D)).toStrictEqual({ delegate: AGENT, chain_whole: false });
  });

  it('rejects when the node cannot be read, and does not give null for it', async () => {
    const world = ledgerWorld(delegated());
    const down = new Proxy(world.provider, { get: (target, name) => (typeof Reflect.get(target, name) === 'function' ? () => { throw new Error('the node is down'); } : Reflect.get(target, name)) });
    await expect(ledgerReadsFrom({ ...world.env, provider: down }).delegation(D)).rejects.toThrow('the node is down');
    // The twin: the same world with a node that answers.
    expect(await ledgerReadsFrom(world.env).delegation(D)).not.toBeNull();
  });
});

describe('ledgerReadsFrom: the Live vaults of a delegation', () => {
  it('lists the one Live vault output that names the delegation, with its reference, and says that the read is complete', async () => {
    const vault = vaultUtxo(live(), 9_000_000n);
    const reads = ledgerReadsFrom(ledgerWorld([vault, ...delegated()]).env);
    expect(await reads.liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(vault)], complete: true });
  });

  it('lists two Live vault outputs of the delegator: the flow refuses them, so the port must not hide the second', async () => {
    const a = vaultUtxo(live(), 9_000_000n);
    const b = vaultUtxo(live({ spent: 2_000_000n }), 8_000_000n);
    const read = await ledgerReadsFrom(ledgerWorld([a, b, ...delegated()]).env).liveVaults(D, CAPTURE_MS);
    expect([...read.refs].sort()).toStrictEqual([refOf(a), refOf(b)].sort());
    expect(read.complete).toBe(true);
  });

  it('leaves out an output of another owner than the delegator, which the vault script never lets pay: it cannot make a second vault', async () => {
    const real = vaultUtxo(live(), 9_000_000n);
    const hostile = vaultUtxo(live({ owner: ATTACKER }), 5_000_000n);
    const reads = ledgerReadsFrom(ledgerWorld([real, hostile, ...delegated()]).env);
    expect(await reads.liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(real)], complete: true });
    expect(await ledgerReadsFrom(ledgerWorld([hostile, ...delegated()]).env).liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [], complete: true });
  });

  it('does not list a Returned output, which names no delegation and only its owner can spend', async () => {
    const refund = vaultUtxo({ type: 'Returned', owner }, 3_000_000n);
    const real = vaultUtxo(live(), 9_000_000n);
    expect(await ledgerReadsFrom(ledgerWorld([refund, real, ...delegated()]).env).liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(real)], complete: true });
  });

  it('does not list an output that Koios shows and the node does not hold: it is spent, or the indexer is ahead of the node', async () => {
    const real = vaultUtxo(live(), 9_000_000n);
    const spent = vaultUtxo(live({ spent: 3_000_000n }), 8_000_000n);
    const world = ledgerWorld([real, ...delegated()], { rows: [real, spent, ...delegated()].map((utxo) => koiosRow(utxo)) });
    expect(await ledgerReadsFrom(world.env).liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(real)], complete: true });
  });

  it('keeps an output whose delegation is not on the ledger: the owner is not known, and the ledger decides when the Pay is evaluated', async () => {
    const vault = vaultUtxo(live(), 9_000_000n);
    expect(await ledgerReadsFrom(ledgerWorld([vault]).env).liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(vault)], complete: true });
  });

  it('is not hidden by outputs of an attacker with lower references: it reads every page, and the real vault is the one that is left', async () => {
    const hostile = Array.from({ length: 55 }, () => vaultUtxo(live({ owner: ATTACKER }), 5_000_000n));
    const real = vaultUtxo(live(), 9_000_000n);
    const world = ledgerWorld([...hostile, real, ...delegated()]);
    expect(await ledgerReadsFrom(world.env).liveVaults(D, CAPTURE_MS)).toStrictEqual({ refs: [refOf(real)], complete: true });
  });

  it('says that the read is not complete when the outputs go beyond the pages that it reads, and then lists what it found', async () => {
    const hostile = Array.from({ length: 205 }, () => vaultUtxo(live({ owner: ATTACKER }), 5_000_000n));
    const real = vaultUtxo(live(), 9_000_000n);
    const read = await ledgerReadsFrom(ledgerWorld([...hostile, real, ...delegated()]).env).liveVaults(D, CAPTURE_MS);
    expect(read.complete).toBe(false);
    expect(read.refs).toStrictEqual([refOf(real)]);
  }, 60_000);

  it('rejects when Koios cannot be read, and does not give an empty list for it', async () => {
    const world = ledgerWorld([vaultUtxo(live(), 9_000_000n), ...delegated()], { status: { credential_utxos: 500 } });
    await expect(ledgerReadsFrom(world.env).liveVaults(D, CAPTURE_MS)).rejects.toThrow();
  });
});

describe('the flow over the real port', () => {
  it('finds the one Live vault, and refuses no vault, two vaults and a read that fails', async () => {
    const a = vaultUtxo(live(), 9_000_000n);
    const b = vaultUtxo(live({ spent: 2_000_000n }), 8_000_000n);
    expect(await findLiveVault(ledgerReadsFrom(ledgerWorld([a, ...delegated()]).env), D, CAPTURE_MS)).toStrictEqual({ ok: true, vault_ref: refOf(a) });
    expect(await findLiveVault(ledgerReadsFrom(ledgerWorld([...delegated()]).env), D, CAPTURE_MS)).toMatchObject({ ok: false, code: 'no_live_vault' });
    expect(await findLiveVault(ledgerReadsFrom(ledgerWorld([a, b, ...delegated()]).env), D, CAPTURE_MS)).toMatchObject({ ok: false, code: 'several_live_vaults' });
    const down = ledgerWorld([a, ...delegated()], { status: { credential_utxos: 500 } });
    expect(await findLiveVault(ledgerReadsFrom(down.env), D, CAPTURE_MS)).toMatchObject({ ok: false, code: 'ledger_unavailable' });
  });

  it('checks the authority: the delegation that names the agent goes on, the one that names another agent is refused, and a delegation that is not found goes on', async () => {
    const reads = ledgerReadsFrom(ledgerWorld(delegated()).env);
    expect(await checkAuthority(reads, AGENT_DID, D)).toStrictEqual({ ok: true, delegation: 'names_agent' });
    expect(await checkAuthority(reads, `did:vector:${'f0'.repeat(32)}`, D)).toMatchObject({ ok: false, code: 'delegation_not_mine' });
    expect(await checkAuthority(ledgerReadsFrom(ledgerWorld([]).env), AGENT_DID, D)).toStrictEqual({ ok: true, delegation: 'not_found' });
  });
});
