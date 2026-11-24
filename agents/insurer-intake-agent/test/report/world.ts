// agents/insurer-intake-agent/test/report/world.ts: the ledger that the tests of the real readers use. It joins the fixture world of buyer-core (an offline node, a fake Koios and the identity deployment of
// mainnet, read by the real read code) with the records, the delegations and the attestations of the report: a sender with a Provider key, a delegation whose root is a key principal or an agent, and the
// attestations of the three kinds. No test here uses the network, a key file or the environment. Every record is synthetic.
import type { AttestationDatum, DelegationDatum, Party } from '@vsa/vector-read/identity-codec';
import { FixtureProvider } from '../../../../packages/buyer-core/test/fixtures/fixture-provider.ts';
import { CONTROLLER_ACCOUNTABLE, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { CAPTURE_MS, DAY, attestation, attestationUtxo, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { KoiosOptions, LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { DELEGATION, MEMBER_ID, SENDER, idOf } from './support.ts';

/** One output of the ledger. This package has no dependency on the library that names the type, so the type is the one that the fixtures take. */
export type Output = Parameters<typeof ledgerWorld>[0][number];

export const HOUR = 3_600_000;
/** The time of the checks: a minute after the tip of the capture. Every attestation of this world is issued at the tip. */
export const NOW = CAPTURE_MS + 60_000;
/** The id of the record of the sender: the id that the DID of the sender holds. */
export const SENDER_ID = SENDER.slice('did:vector:'.length);
/** The delegate of the root link in a chain of two links, and the id of the root link. */
export const MIDDLE_ID = idOf(0xc4);
export const PARENT_LINK = idOf(0xd2);

/** The key of a key principal that is the root delegator, the Provider key of the sender, a stranger, and a second key of the record of a member. */
export const ROOT_KEY = testKey(40);
export const PROVIDER_KEY = testKey(41);
export const STRANGER_KEY = testKey(42);
export const MEMBER_KEY = testKey(43);

/** A Provider party. With no argument its signer is the Provider key. */
export function providerParty(signer: Party['signer'] = { type: 'KeyHash', hash: PROVIDER_KEY.keyHash }): Party {
  return { role: 'Provider', signer, organisation: null, notBefore: CAPTURE_MS - 60 * DAY, notAfter: null, rights: 0, removalAfter: null };
}

/** The record of the sender: an Accountable Party and then `parties`. */
export function senderRecord(parties: readonly Party[]): Output {
  return recordUtxo(SENDER_ID, liveRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: CAPTURE_MS - 60 * DAY }, ...parties] }));
}

/** The record of a member that has keys: Active, with each key listed for every purpose. */
export const memberRecord = (id: string, ...keys: readonly { publicKey: string }[]): Output => recordUtxo(id, liveRecord({}, keys.map((key) => key.publicKey)));

/** A link of a delegation chain that names the sender as its delegate. `over` changes the datum. */
export const link = (id: string, over: Partial<DelegationDatum> = {}): Output => delegationUtxo(id, delegation({ delegate: SENDER_ID, ...over }));

/** The delegation of the request, with a key principal as its root. */
export const keyRootLink = (key: { keyHash: string } = ROOT_KEY): Output => link(DELEGATION, { delegator: { type: 'PrincipalKey', hash: key.keyHash, organisation: null } });
/** The delegation of the request, with an agent as its root. */
export const agentRootLink = (id: string = MEMBER_ID): Output => link(DELEGATION, { delegator: { type: 'Agent', id } });

let counter = 0x9000;
export interface Made {
  readonly id: string;
  readonly utxo: Output;
}

/** An attestation about the sender, issued at the tip of the capture by `key`, valid for 30 days. `over` changes the datum. */
export function attestationAbout(attType: number, key: { publicKey: string }, over: Partial<AttestationDatum> = {}): Made {
  const id = idOf((counter += 1));
  const datum = attestation({ subject: SENDER_ID, attType, issuer: key.publicKey, issuedAt: CAPTURE_MS, validFrom: null, validUntil: CAPTURE_MS + 30 * DAY, ...over });
  return { id, utxo: attestationUtxo(id, datum) };
}

/** The five parts of the good world, in the order of the list that the node holds. */
export type PartName = 'record' | 'delegation' | 'provenance' | 'software' | 'binding';
const PARTS: readonly PartName[] = ['record', 'delegation', 'provenance', 'software', 'binding'];

/**
 * The world in which every kind is valid: the sender with a Provider key, the delegation of a key principal, and one attestation of each kind by its issuer. `over` replaces a part by another output, or drops
 * it when it is null.
 */
export function goodWorld(over: Partial<Record<PartName, Output | null>> = {}): Output[] {
  const parts: Record<PartName, Output> = {
    record: senderRecord([providerParty()]),
    delegation: keyRootLink(),
    provenance: attestationAbout(1, PROVIDER_KEY).utxo,
    software: attestationAbout(2, PROVIDER_KEY).utxo,
    binding: attestationAbout(4, ROOT_KEY).utxo,
  };
  return PARTS.flatMap((name) => {
    const replacement = over[name];
    return replacement === null ? [] : [replacement ?? parts[name]];
  });
}

export const worldOf = (utxos: readonly Output[], koios: KoiosOptions = {}): LedgerWorld => ledgerWorld([...utxos], koios);

/** The world with a node that replaces the node of `world`. */
export const withNode = (world: LedgerWorld, node: Pick<LedgerWorld['env'], 'provider'> & { budgetMs?: number }): LedgerWorld => ({ ...world, env: { ...world.env, ...node } });

/** A node that cannot be asked: every read of an address fails. The text of its error names a host and holds a secret, and no line of the report may repeat it. */
export class DownProvider extends FixtureProvider {
  override getUtxos(): Promise<Output[]> {
    return Promise.reject(new Error('the node is down: https://node.example/?key=secret-token-123'));
  }
}

/** A node that never answers a read of an address. */
export class SilentProvider extends FixtureProvider {
  override getUtxos(): Promise<Output[]> {
    return new Promise<Output[]>(() => undefined);
  }
}
