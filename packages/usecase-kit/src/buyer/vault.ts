// packages/usecase-kit/src/buyer/vault.ts
// The vault of a job. The request has no vault: the agent finds the Live vault of its delegation on the ledger. A vault output changes its reference at each Pay, so the reference is read
// right before the Pay and never kept. Two Live vaults under one delegation are refused, because the limit of the delegation is counted in each vault output: with two, a job could spend
// the limit twice. No vault is refused too. Neither is a pass, and no hire starts. A read that cannot be made is `ledger_unavailable`.
import { parseOutputRef } from '@vsa/usecase-kit/protocol';
import type { DelegationId, OutputRef } from '@vsa/usecase-kit/protocol';
import type { LedgerReads, LiveVaults } from './ports.ts';

/** The codes of a vault search that found no vault to pay from. */
export type VaultRefusal = 'no_live_vault' | 'several_live_vaults' | 'ledger_unavailable';

export type VaultSearch =
  | { readonly ok: true; readonly vault_ref: OutputRef }
  | { readonly ok: false; readonly code: VaultRefusal; readonly detail: string };

/** Reads the Live vault outputs of the delegation at the time `atMs`. Exactly one is the vault to pay from. */
export async function findLiveVault(reads: LedgerReads, delegation: DelegationId, atMs: number): Promise<VaultSearch> {
  let read: LiveVaults;
  try {
    read = await reads.liveVaults(delegation, atMs);
  } catch {
    return { ok: false, code: 'ledger_unavailable', detail: 'the ledger could not be read for the vault of the delegation' };
  }
  if (typeof read !== 'object' || read === null || !Array.isArray(read.refs) || typeof read.complete !== 'boolean') {
    return { ok: false, code: 'ledger_unavailable', detail: 'the reading of the vaults of the delegation has the wrong shape' };
  }
  const refs = new Set<OutputRef>();
  for (const ref of read.refs as readonly unknown[]) {
    const checked = parseOutputRef(typeof ref === 'string' ? ref.toLowerCase() : ref, 'vault');
    if (!checked.ok) return { ok: false, code: 'ledger_unavailable', detail: 'the reading of the vaults of the delegation holds a reference that is not an output reference' };
    refs.add(checked.value);
  }
  const [first, ...others] = [...refs];
  if (first === undefined) {
    return read.complete
      ? { ok: false, code: 'no_live_vault', detail: 'the delegation has no Live vault on the ledger' }
      : { ok: false, code: 'several_live_vaults', detail: 'the read of the vaults of the delegation stopped before its end, so one vault cannot be shown to be the only one' };
  }
  if (others.length > 0 || !read.complete) {
    return { ok: false, code: 'several_live_vaults', detail: `the delegation has ${read.complete ? refs.size : 'more than one'} Live vaults on the ledger, and a Pay needs exactly one` };
  }
  return { ok: true, vault_ref: first };
}
