// packages/usecase-kit/src/cosign/ledger.ts
// What the route reads from the ledger: two questions, after every check that needs no network.
//   outputs               Whose are the outputs that the transaction spends? The address of an output is not in the transaction, so the route asks the ledger.
//   delegateKeysInUse     Which delegation keys does a live delegation name? The contract does not make a delegation key fresh, and a delegation stays on the ledger until its delegator ends it.
// The route reads the ledger through this interface only. A test gives a fake. A service gives `providerLedger` with the node of its chain. The route checks each answer in full before it uses it
// (route.ts): an answer of the wrong form is `check_unavailable`.
import { liveDelegations } from '@vsa/buyer-core';
import type { IdentityDeployment, OutRef } from '@vsa/buyer-core';
import { decodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import type { Provider, UTxO } from '@lucid-evolution/lucid';

/** An output that is on the ledger now: its reference and the address that holds it. */
export interface LedgerOutput {
  readonly txHash: string;
  readonly outputIndex: number;
  readonly address: string;
}

export interface CosignLedger {
  /** The outputs of `refs` that are on the ledger now, each one once. An output that is spent or unknown is not in the answer. An output that was not asked for is not in the answer either. */
  outputs(refs: readonly OutRef[]): Promise<readonly LedgerOutput[]>;
  /** The key hashes (56 lower-case hex characters) that a live delegation names as its delegate key, as a `Set`. */
  delegateKeysInUse(): Promise<ReadonlySet<string>>;
}

/**
 * The outputs at the delegation address, as the node gave them. By the contract, every token of the delegation policy sits at the delegation script with a valid inline datum, it is the only token of
 * the policy in its output, and its quantity is 1. An output that carries a token of the policy and breaks one of these rules is a fault of the source, and the read fails. The reader of buyer-core
 * leaves such an output out, and then the key that it names would read as free. An output with no token of the policy is not a delegation, and the reader leaves it out.
 */
function checkDelegationOutputs(outputs: readonly UTxO[], deployment: IdentityDeployment): void {
  if (!Array.isArray(outputs)) throw new Error('the node did not give a list of outputs');
  const policy = deployment.delegation.hash;
  for (const utxo of outputs) {
    const tokens = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(policy));
    if (tokens.length === 0) continue;
    if (utxo.address !== deployment.delegation.address) throw new Error('a token of the delegation policy is not at the delegation script');
    if (tokens.length !== 1 || tokens[0]![1] !== 1n) throw new Error('an output at the delegation script does not hold exactly one token of the delegation policy');
    if (typeof utxo.datum !== 'string') throw new Error('an output at the delegation script has no inline datum');
    decodeDelegationDatum(utxo.datum);
  }
}

/** The ledger as one node of the chain answers: `getUtxosByOutRef` for the outputs, and the live delegations at the delegation address. */
export function providerLedger(provider: Provider, deployment: IdentityDeployment): CosignLedger {
  return {
    async outputs(refs) {
      const found = await provider.getUtxosByOutRef(refs.map((ref) => ({ txHash: ref.txHash, outputIndex: ref.outputIndex })));
      return found.map((utxo) => ({ txHash: utxo.txHash, outputIndex: utxo.outputIndex, address: utxo.address }));
    },
    async delegateKeysInUse() {
      const outputs = await provider.getUtxos(deployment.delegation.address);
      checkDelegationOutputs(outputs, deployment);
      // The reader of buyer-core gets the outputs that were checked: one read of the node, and the same outputs for the check and for the reader.
      const checked: Pick<Provider, 'getUtxos'> = { getUtxos: async () => outputs };
      const live = await liveDelegations(checked as Provider, deployment);
      return new Set(live.map((delegation) => delegation.delegation.delegateKey));
    },
  };
}
