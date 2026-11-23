// packages/usecase-kit/src/live/chain.ts
// The `DelegationChain` of the sub-delegation (`withSubDelegation` of the access folder) over the builders and the reads of `@vsa/buyer-core`: its `buildDelegate` and `buildUndelegate` make the transactions, its
// `readDelegation` and `checkDelegationUse` read the ledger, and the node of the caller takes the signed transaction and gives the slot clock. A caller gives one `LiveChainDeps`: a `LedgerEnv` of buyer-core whose node
// also gives the start time of the chain (the `OgmiosProvider` of buyer-core does). The folder reads no key file and no environment variable.
//
// The adapter does what it is asked, and it tells what the ledger shows. It never ends a delegation by itself, and it never chooses which delegation to end: `withSubDelegation` chooses, and it compares the transaction
// hash that `readDelegation` reports with the hash of its own Delegate. A method that cannot read the ledger, or that the node refuses, THROWS. A throw is never `ready`, never "not live" (`null`) and never a hash.
//
// `readiness` reads the ledger twice with `checkDelegationUse`. The list `problems` of one read mixes the rule problems (a delegate that is not Active, a pattern that does not cover) with the depth problems, as text,
// and this file never reads that text. The first read asks for no depth (`minConfirmations: 0`), so every problem in it is a rule problem. The second read asks for 30 confirmations, and the depth of each link comes from
// its typed member `confirmations.links`. A rule that is broken is `unusable` whatever the depth is, so a delegate that is not Active is never `waiting`. A delegation that the ledger does not show yet, and a link that
// has no depth yet, are `waiting`. `readinessOfRules` and `readinessOfDepth` hold the decision, and they read typed members only.
import type { Provider } from '@lucid-evolution/lucid';
import { buildDelegate as buildDelegateTx, buildUndelegate as buildUndelegateTx, checkDelegationUse, lucidForAddress, readDelegation as readDelegationView } from '@vsa/buyer-core';
import type { DelegationUseCheck, IdentityContext, LedgerEnv } from '@vsa/buyer-core';
import { CONFIRMATIONS_REQUIRED, deploymentSlotAt } from '../access/index.ts';
import type { DelegationChain, Readiness, SlotClockSource } from '../access/index.ts';

/**
 * What the chain needs. It is a `LedgerEnv` of buyer-core (the node, the identity deployment, Koios with its `fetch`, and the time budget of one read), so the same object also serves the reads of the buyer folder.
 * It holds no key and no secret that a log could show.
 */
export interface LiveChainDeps extends LedgerEnv {
  /**
   * The node. The reads list outputs with it, the builders take it as the provider of Lucid, `slotAt` asks it for the start time of the chain, and `submit` gives it the signed transaction with `submitTx`. That call
   * takes the hex of the signed transaction, gives its hash, and throws when the node refuses it or does not answer. The `OgmiosProvider` of buyer-core is one: it posts the bytes to its submit endpoint.
   */
  readonly provider: Provider & SlotClockSource;
}

/** A depth that counts: a whole number of blocks. A depth below 0 is 0, because Koios can show a block that is above the tip that it gave. Anything that is not a whole number is no depth. */
function depthOf(confirmations: number | null): number | null {
  return typeof confirmations === 'number' && Number.isSafeInteger(confirmations) ? Math.max(0, confirmations) : null;
}

/**
 * What the read with no depth (`minConfirmations: 0`) decides, or null when the rules pass and the depth decides. A read that shows no delegation is `waiting` with no depth: the delegation never existed, it ended, or
 * the ledger does not show it yet. Any other problem of this read is a rule problem, and the problems go on as they are.
 */
export function readinessOfRules(rules: DelegationUseCheck): Readiness | null {
  if (rules.view.chain.length === 0) return { state: 'waiting', confirmations: null };
  return rules.usable ? null : { state: 'unusable', problems: rules.problems };
}

/**
 * What the read at 30 confirmations decides, after the rules passed. Every link of the chain must have 30 confirmations or more for `ready`. Any other chain is `waiting`, with the least depth, or with null when a link has
 * no depth yet. A read that no longer shows the delegation (it ended between the two reads) is `waiting` with null. A read that gives no depths, or the depths of another number of links than the chain, is an error: it
 * is never `ready`. When every link is deep and the read is not usable, a rule broke between the two reads, and the problems of the read are rule problems only.
 */
export function readinessOfDepth(depth: DelegationUseCheck): Readiness {
  const { chain } = depth.view;
  if (chain.length === 0) return { state: 'waiting', confirmations: null };
  const reading = depth.confirmations;
  if (reading === null || reading.links.length !== chain.length) throw new Error('the read of the depths does not match the chain that it read');
  const depths = reading.links.map((link) => depthOf(link.confirmations));
  if (depths.every((depthOfLink) => depthOfLink !== null && depthOfLink >= CONFIRMATIONS_REQUIRED)) return depth.usable ? { state: 'ready' } : { state: 'unusable', problems: depth.problems };
  const known = depths.filter((depthOfLink): depthOfLink is number => depthOfLink !== null);
  return { state: 'waiting', confirmations: known.length < depths.length ? null : Math.min(...known) };
}

/** The `DelegationChain` over the node and the ledger of `deps`. Making it asks nothing of the node. */
export function delegationChainOf(deps: LiveChainDeps): DelegationChain {
  const { provider, deployment } = deps;
  const contextOf = async (address: string): Promise<IdentityContext> => ({ lucid: await lucidForAddress(provider, address), provider, deployment });
  const useOf = (id: string, route: { readonly action: string; readonly resource: string }, atMs: number, minConfirmations: number): Promise<DelegationUseCheck> =>
    checkDelegationUse(deps, { id, action: route.action, resource: route.resource, atMs, minConfirmations });
  return {
    async readDelegation(id) {
      const leaf = (await readDelegationView(deps, id)).chain[0];
      return leaf === undefined ? null : { id: leaf.id, delegation: leaf.delegation, txHash: leaf.utxo.txHash };
    },
    async readiness(id, route, atMs) {
      return readinessOfRules(await useOf(id, route, atMs, 0)) ?? readinessOfDepth(await useOf(id, route, atMs, CONFIRMATIONS_REQUIRED));
    },
    async buildDelegate(params) {
      return buildDelegateTx(await contextOf(params.changeAddress), params);
    },
    async buildUndelegate(params) {
      return buildUndelegateTx(await contextOf(params.changeAddress), params);
    },
    async submit(signedCborHex) {
      return provider.submitTx(signedCborHex);
    },
    slotAt: deploymentSlotAt(provider),
  };
}
