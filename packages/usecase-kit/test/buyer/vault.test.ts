// packages/usecase-kit/test/buyer/vault.test.ts: the search for the Live vault of a delegation. Exactly one vault is the vault to pay from. None, more than one, and a read that did not end are
// refused, and so is a read that cannot be made: none of them is a pass, and no hire starts after them.
import { describe, expect, it } from 'vitest';
import { findLiveVault } from '@vsa/usecase-kit/buyer';
import type { LedgerReads } from '@vsa/usecase-kit/buyer';
import { DELEGATION } from './support.ts';

const REF_A = `${'a1'.repeat(32)}#1`;
const REF_B = `${'b2'.repeat(32)}#0`;

/** A port whose vault read is `read`, or rejects. The delegation is not read by this search. */
function reads(read: unknown, fail: Error | null = null): LedgerReads & { seen: number[] } {
  const port = {
    seen: [] as number[],
    delegation: async (): Promise<never> => { throw new Error('the search must not read the delegation'); },
    liveVaults: async (_id: string, atMs: number): Promise<never> => {
      port.seen.push(atMs);
      if (fail !== null) throw fail;
      return read as never;
    },
  };
  return port;
}

describe('findLiveVault', () => {
  it('gives the one Live vault, and reads the ledger at the time that it is given', async () => {
    const port = reads({ refs: [REF_A], complete: true });
    expect(await findLiveVault(port, DELEGATION, 1_790_000_000_000)).toStrictEqual({ ok: true, vault_ref: REF_A });
    expect(port.seen).toStrictEqual([1_790_000_000_000]);
  });

  it('refuses a delegation with no Live vault: no_live_vault', async () => {
    expect(await findLiveVault(reads({ refs: [], complete: true }), DELEGATION, 1)).toMatchObject({ ok: false, code: 'no_live_vault' });
  });

  it('refuses a delegation with two Live vaults: several_live_vaults, because the limit of a delegation is counted in each vault output', async () => {
    const refused = await findLiveVault(reads({ refs: [REF_A, REF_B], complete: true }), DELEGATION, 1);
    expect(refused).toMatchObject({ ok: false, code: 'several_live_vaults' });
    expect(refused.ok ? '' : refused.detail).toContain('2 Live vaults');
  });

  it('counts the same output two times as one vault, and spells the hex in upper case as the same output', async () => {
    expect(await findLiveVault(reads({ refs: [REF_A, REF_A], complete: true }), DELEGATION, 1)).toStrictEqual({ ok: true, vault_ref: REF_A });
    expect(await findLiveVault(reads({ refs: [REF_A, REF_A.toUpperCase()], complete: true }), DELEGATION, 1)).toStrictEqual({ ok: true, vault_ref: REF_A });
  });

  it('refuses a read that stopped before its end, with one vault or with none: it cannot show that the vault is the only one', async () => {
    expect(await findLiveVault(reads({ refs: [REF_A], complete: false }), DELEGATION, 1)).toMatchObject({ ok: false, code: 'several_live_vaults' });
    expect(await findLiveVault(reads({ refs: [], complete: false }), DELEGATION, 1)).toMatchObject({ ok: false, code: 'several_live_vaults' });
    expect(await findLiveVault(reads({ refs: [REF_A], complete: true }), DELEGATION, 1)).toMatchObject({ ok: true });
  });

  it('refuses a read that cannot be made as ledger_unavailable, and never as "no vault"; the error text is not repeated', async () => {
    const refused = await findLiveVault(reads(undefined, new Error('Ogmios refused the key SECRET-KEY-TEXT')), DELEGATION, 1);
    expect(refused).toMatchObject({ ok: false, code: 'ledger_unavailable' });
    expect(JSON.stringify(refused)).not.toContain('SECRET-KEY-TEXT');
  });

  it('refuses a reading of the wrong shape, or with a reference that is no output reference, as ledger_unavailable', async () => {
    const wrong: unknown[] = [undefined, null, 'x', { refs: 'a', complete: true }, { refs: [REF_A] }, { refs: [REF_A], complete: 'yes' }, { refs: [7], complete: true }, { refs: [`${'a1'.repeat(32)}#01`], complete: true }, { refs: ['abc#1'], complete: true }];
    for (const read of wrong) expect(await findLiveVault(reads(read), DELEGATION, 1), JSON.stringify(read)).toMatchObject({ ok: false, code: 'ledger_unavailable' });
  });
});
