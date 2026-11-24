// scripts/operator/usecases/shared.ts - the data that the use cases of the pack share: the keys that every use case holds, the keys of an organisation, the organisations, the five parties of a record
// and the values that the data of each use case repeats. The data file of a use case imports them and holds no copy.
// Like the data of a use case, the file holds public text and amounts in lovelace (bigint). It holds no key, no wallet address, no DID and no contact address.
// A test (test/shared-data.test.ts) holds these values, and the data of use case 1, to each other.
import type { KeyLine, OrganisationSpec, PartySpec } from '../lib/contract.ts';
import type { KeySpec } from '../lib/registry.ts';

/** The first sentence of the description of each record that the deployment registers. */
export const DEMONSTRATION_SENTENCE = 'Demonstration organisation run by the Apex Fusion Foundation.';
/** The path of the manifest of the Module-1 deployment in the repository that holds it. */
export const MODULE_MANIFEST_PATH = 'Module-1/deploy/identity/mainnet/manifest.json';
/** The commit of the repository of the agent templates that the CI file checks out. A test holds it to that file. */
export const RUNTIME_COMMIT = 'a05564cae3ca0e72a3591c8b2eb16c7909a60839';
/** The collateral of each wallet that runs a script, in lovelace: one pure output of 5 units, alone. */
export const COLLATERAL = 5_000_000n;

export const ECHO: OrganisationSpec = { id: 'echo', domain: 'echo.vector.apexfusion.org', accountableKey: 'accountable-echo', guardianKey: 'guardian-echo' };
export const ALFA: OrganisationSpec = { id: 'alfa', domain: 'alfa.vector.apexfusion.org', accountableKey: 'accountable-alfa', guardianKey: 'guardian-alfa' };
export const DELTA: OrganisationSpec = { id: 'delta', domain: 'delta.vector.apexfusion.org', accountableKey: 'accountable-delta', guardianKey: 'guardian-delta' };
export const BRAVO: OrganisationSpec = { id: 'bravo', domain: 'bravo.vector.apexfusion.org', accountableKey: 'accountable-bravo', guardianKey: 'guardian-bravo' };
export const CHARLIE: OrganisationSpec = { id: 'charlie', domain: 'charlie.vector.apexfusion.org', accountableKey: 'accountable-charlie', guardianKey: 'guardian-charlie' };

/** The Accountable key and the guardian key of an organisation. The organisations belong to the deployment, so both keys have the scope `shared`. */
export function organisationKeys(organisation: OrganisationSpec): readonly KeySpec[] {
  return [
    { name: organisation.accountableKey, scope: 'shared', about: `Accountable key of the organisation ${organisation.id}.` },
    { name: organisation.guardianKey, scope: 'shared', about: `Guardian key of the organisation ${organisation.id}.` },
  ];
}

/** The six keys that every use case holds: the controller, the run wallet, the fee wallet, the Provider key and the two keys of the organisation echo. */
export const CORE_KEYS: readonly KeySpec[] = [
  { name: 'controller', scope: 'shared', about: 'Controller of every record that this deployment registers. It signs registrations, stakes and attestation consents.' },
  { name: 'run', scope: 'shared', about: 'The run wallet. It funds the other wallets.' },
  { name: 'fee', scope: 'shared', about: 'Pays the deposits and the fees of registrations, attestations and party actions.' },
  { name: 'provider', scope: 'shared', about: 'Provider key. It issues the provenance and software attestations.' },
  ...organisationKeys(ECHO),
];

/** One line of an env file: the file, the variable, and what the line holds. */
export const line = (file: string, name: string, of: KeyLine['of']): KeyLine => ({ file, name, of });

/** The five parties of the record of an agent: the Accountable key of its organisation, Module-1, the Provider key (no rights), the guardian key of the organisation and the controller key as guardians. */
export function partiesOf(organisation: OrganisationSpec): readonly PartySpec[] {
  return [
    { role: 'Accountable', signer: { kind: 'key', key: organisation.accountableKey }, organisation: organisation.domain, rights: null },
    { role: 'Responsible', signer: { kind: 'module1' }, organisation: null, rights: null },
    { role: 'Provider', signer: { kind: 'key', key: 'provider' }, organisation: null, rights: [] },
    { role: 'Guardian', signer: { kind: 'key', key: organisation.guardianKey }, organisation: null, rights: null },
    { role: 'Guardian', signer: { kind: 'key', key: 'controller' }, organisation: null, rights: null },
  ];
}

/** Reference counts and wording which several cases use without change. */
export const RESULT_REFS = {
  hire: { transaction: 2, escrow: 1 },
  close: { transaction: 2 },
  approval: { attestation: 1, transaction: 1 },
  verdict: { case: 1, transaction: 1, hold: 1 },
  record: { transaction: 1, record: 1 },
} as const;

export const RESULT_WORDING = {
  approval: {
    shows: 'An approval attestation of the hirer is on the ledger. It names the digest of the proposal.',
    doesNotShow: 'That the hirer read the proposal. The attestation covers the digest only.',
  },
  close: {
    shows: 'The ledger holds the close of the vault and the end of the delegation.',
    doesNotShow: 'That a system refuses a live token after the end. Tests alone cover that case.',
  },
  challenge: {
    shows: 'The ledger records a challenge and its evidence.',
    doesNotShow: 'That the challenge is right. The jury decides that.',
  },
  verdict: {
    shows: 'The recorded verdict puts a time-limited hold on the challenged agent.',
    doesNotShow: 'That another jury decides the same way. The jury result is a sample.',
  },
} as const;
