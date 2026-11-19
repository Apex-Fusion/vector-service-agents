// What the tests of the vault checks share: the Live vault of a world, a Returned output that a test puts into it (as an Accept or a Reclaim does), and the hosted tools as the live server
// answers them for a delegation and its vault outputs.
import { encodeVaultDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import { decodeVaultDatum } from '../../lib/platform.ts';
import { FakeHosted } from './hosted-fake.ts';
import type { Handler } from './hosted-fake.ts';
import type { Harness } from './harness.ts';
import { DEPLOYMENT } from './world.ts';

/** The Live vault output of the world and its datum. */
export function liveVaultOf(h: Harness) {
  const live = h.world.chain.held.find((u) => u.address === DEPLOYMENT.vault.address && u.datum !== undefined && u.datum !== null && decodeVaultDatum(u.datum).type === 'Live');
  if (live === undefined) throw new Error('the world holds no Live vault');
  return live;
}

/** Puts a Returned output of the owner of the Live vault into the world, as an Accept or a Reclaim does, and gives its reference. */
export function addReturned(h: Harness, lovelace: bigint, tag: string): string {
  const live = liveVaultOf(h);
  const owner = decodeVaultDatum(live.datum!).owner;
  const txHash = tag.repeat(32);
  h.world.chain.held.push({ txHash, outputIndex: 0, address: DEPLOYMENT.vault.address, assets: { lovelace }, datum: encodeVaultDatum({ type: 'Returned', owner }) });
  return `${txHash}#0`;
}

/**
 * The hosted tools as the live server answers them: the delegation is live while its token is on the ledger, and a vault output is shown while the world holds it. `returnedReports`
 * makes every Returned output say that amount of lovelace, as a server that reads another amount would.
 */
export function vaultHostedFor(h: () => Harness, name: string, returnedReports?: string): FakeHosted {
  const facts = (): Record<string, unknown> => h().state(name).steps.delegate!.facts;
  const vaultOutputs = (): Array<Record<string, unknown>> => h().world.chain.held.flatMap((u) => {
    if (u.address !== DEPLOYMENT.vault.address || u.datum === undefined || u.datum === null) return [];
    const vault = decodeVaultDatum(u.datum);
    const lovelace = vault.type === 'Returned' && returnedReports !== undefined ? returnedReports : String(u.assets.lovelace);
    return [{ vault_ref: `${u.txHash}#${u.outputIndex}`, kind: vault.type, lovelace, ...(vault.type === 'Live' ? { delegation: vault.delegation } : {}) }];
  });
  const handlers: Record<string, Handler> = {
    vector_get_delegation: (args) => {
      const id = String(args.delegation);
      const live = h().world.chain.held.some((u) => u.assets[`${DEPLOYMENT.delegation.hash}${id}`] === 1n);
      const f = facts();
      return live
        ? { delegation: id, live: true, chain: [{ delegation: id, delegator: { type: 'PrincipalKey', key_hash: f.delegator_key_hash }, delegate: f.delegate_id, delegate_key: f.delegate_key_hash, actions: f.actions, resources: f.resources, not_after: f.not_after, depth: 1 }] }
        : { delegation: id, live: false, chain: [] };
    },
    vector_get_vault: (args) => ({ outputs: args.delegation === undefined ? vaultOutputs() : vaultOutputs().filter((o) => o.kind === 'Live' && o.delegation === args.delegation) }),
  };
  return new FakeHosted(handlers);
}
