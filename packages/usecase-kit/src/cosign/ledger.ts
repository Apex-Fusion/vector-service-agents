// packages/usecase-kit/src/cosign/ledger.ts
// What the route reads from the ledger: two questions, after every check that needs no network.
//   outputs               Whose are the outputs that the transaction spends? The address of an output is not in the transaction, so the route asks the ledger.
//   delegateKeysInUse     Which delegation keys does a live delegation name? The contract does not make a delegation key fresh, and a delegation stays on the ledger until its delegator ends it.
// The route reads the ledger through this interface only. A test gives a fake. A service gives `providerLedger` with the node of its chain.
import { liveDelegations } from '@vsa/buyer-core';
import type { IdentityDeployment, OutRef } from '@vsa/buyer-core';
import type { Provider } from '@lucid-evolution/lucid';

/** An output that is on the ledger now: its reference and the address that holds it. */
export interface LedgerOutput {
  readonly txHash: string;
  readonly outputIndex: number;
  readonly address: string;
}

export interface CosignLedger {
  /** The outputs of `refs` that are on the ledger now. An output that is spent or unknown is not in the answer. */
  outputs(refs: readonly OutRef[]): Promise<readonly LedgerOutput[]>;
  /** The key hashes (56 hex characters) that a live delegation names as its delegate key. */
  delegateKeysInUse(): Promise<ReadonlySet<string>>;
}

/** The ledger as one node of the chain answers: `getUtxosByOutRef` for the outputs, and the live delegations at the delegation address. */
export function providerLedger(provider: Provider, deployment: IdentityDeployment): CosignLedger {
  return {
    async outputs(refs) {
      const found = await provider.getUtxosByOutRef(refs.map((ref) => ({ txHash: ref.txHash, outputIndex: ref.outputIndex })));
      return found.map((utxo) => ({ txHash: utxo.txHash, outputIndex: utxo.outputIndex, address: utxo.address }));
    },
    async delegateKeysInUse() {
      return new Set((await liveDelegations(provider, deployment)).map((live) => live.delegation.delegateKey));
    },
  };
}
