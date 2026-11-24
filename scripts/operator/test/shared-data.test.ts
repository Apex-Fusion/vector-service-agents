// The data that every use case of the pack shares: the keys that all use cases hold, the keys of an organisation, the five organisations, the five parties of a record, and the values that the data of
// each use case repeats. A test holds the data of use case 1 to these values, so that a copy in one place that drifts fails a test.
import { describe, expect, it } from 'vitest';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec } from '../lib/registry.ts';
import data from '../usecases/inventory-reorder.ts';
import {
  ALFA, BRAVO, CHARLIE, COLLATERAL, CORE_KEYS, DELTA, DEMONSTRATION_SENTENCE, ECHO, MODULE_MANIFEST_PATH, RUNTIME_COMMIT, line, organisationKeys, partiesOf,
} from '../usecases/shared.ts';

const ORGANISATIONS = [ECHO, ALFA, DELTA, BRAVO, CHARLIE];
const ALL_KEYS: readonly KeySpec[] = [...CORE_KEYS, ...ORGANISATIONS.filter((organisation) => organisation !== ECHO).flatMap(organisationKeys)];

describe('the shared keys', () => {
  it('are the six keys that every use case holds, in this order, each with its public sentence and the scope shared', () => {
    expect(CORE_KEYS.map((key) => [key.name, key.scope, key.about])).toEqual([
      ['controller', 'shared', 'Controller of every record that this deployment registers. It signs registrations, stakes and attestation consents.'],
      ['run', 'shared', 'The run wallet. It funds the other wallets.'],
      ['fee', 'shared', 'Pays the deposits and the fees of registrations, attestations and party actions.'],
      ['provider', 'shared', 'Provider key. It issues the provenance and software attestations.'],
      ['accountable-echo', 'shared', 'Accountable key of the organisation echo.'],
      ['guardian-echo', 'shared', 'Guardian key of the organisation echo.'],
    ]);
  });
  it('have names that the key registry takes, no name twice, and a sentence of 1 to 200 characters, also with the keys of the other organisations', () => {
    expect(() => loadRegistry({ dir: '/nowhere', useCase: 'a-use-case', specs: ALL_KEYS, need: [] })).not.toThrow();
    expect(new Set(ALL_KEYS.map((key) => key.name)).size).toBe(ALL_KEYS.length);
    for (const key of ALL_KEYS) {
      expect(key.about.length, key.name).toBeGreaterThanOrEqual(1);
      expect(key.about.length, key.name).toBeLessThanOrEqual(200);
      expect(key.scope, key.name).toBe('shared');
    }
    expect(() => loadRegistry({ dir: '/nowhere', useCase: 'a-use-case', specs: [...CORE_KEYS, CORE_KEYS[0]!], need: [] })).toThrow(/twice/);
  });
});

describe('organisationKeys', () => {
  it('gives the Accountable key and the guardian key of an organisation, both with the scope shared, named by the organisation', () => {
    for (const organisation of ORGANISATIONS) {
      const keys = organisationKeys(organisation);
      expect(keys.map((key) => [key.name, key.scope])).toEqual([[organisation.accountableKey, 'shared'], [organisation.guardianKey, 'shared']]);
      expect(keys.map((key) => key.about)).toEqual([`Accountable key of the organisation ${organisation.id}.`, `Guardian key of the organisation ${organisation.id}.`]);
    }
  });
  it('gives the keys that the core list holds for the organisation echo', () => {
    expect(organisationKeys(ECHO)).toEqual(CORE_KEYS.slice(4));
  });
});

describe('the organisations', () => {
  it('are echo, alfa, delta, bravo and charlie, each with its own domain and its own two keys', () => {
    expect(ORGANISATIONS.map((organisation) => [organisation.id, organisation.domain])).toEqual([
      ['echo', 'echo.vector.apexfusion.org'], ['alfa', 'alfa.vector.apexfusion.org'], ['delta', 'delta.vector.apexfusion.org'],
      ['bravo', 'bravo.vector.apexfusion.org'], ['charlie', 'charlie.vector.apexfusion.org'],
    ]);
    for (const organisation of ORGANISATIONS) expect([organisation.accountableKey, organisation.guardianKey], organisation.id).toEqual([`accountable-${organisation.id}`, `guardian-${organisation.id}`]);
    expect(new Set(ORGANISATIONS.flatMap((organisation) => [organisation.id, organisation.domain, organisation.accountableKey, organisation.guardianKey])).size).toBe(ORGANISATIONS.length * 4);
  });
});

describe('partiesOf', () => {
  it('gives the five parties of a record: the Accountable key of the organisation, Module-1, the Provider key with no rights, the guardian key of the organisation, and the controller key as guardian', () => {
    for (const organisation of ORGANISATIONS) {
      expect(partiesOf(organisation), organisation.id).toEqual([
        { role: 'Accountable', signer: { kind: 'key', key: organisation.accountableKey }, organisation: organisation.domain, rights: null },
        { role: 'Responsible', signer: { kind: 'module1' }, organisation: null, rights: null },
        { role: 'Provider', signer: { kind: 'key', key: 'provider' }, organisation: null, rights: [] },
        { role: 'Guardian', signer: { kind: 'key', key: organisation.guardianKey }, organisation: null, rights: null },
        { role: 'Guardian', signer: { kind: 'key', key: 'controller' }, organisation: null, rights: null },
      ]);
    }
  });
  it('has no guardian with the signer kind controller, the second guardian is the controller key, and the Provider has no rights', () => {
    for (const organisation of ORGANISATIONS) {
      const parties = partiesOf(organisation);
      const guardians = parties.filter((party) => party.role === 'Guardian');
      expect(guardians, organisation.id).toHaveLength(2);
      for (const guardian of guardians) expect(guardian.signer.kind, organisation.id).not.toBe('controller');
      expect(guardians[1]!.signer).toEqual({ kind: 'key', key: 'controller' });
      expect(parties.find((party) => party.role === 'Provider')!.rights, organisation.id).toEqual([]);
      expect(parties.filter((party) => party.signer.kind === 'module1')).toHaveLength(1);
    }
  });
});

describe('the helper and the constants', () => {
  it('line names the file, the variable and what the line holds', () => {
    expect(line('.env.example', 'SOME_NAME', 'pkh')).toEqual({ file: '.env.example', name: 'SOME_NAME', of: 'pkh' });
  });
  it('are the collateral of 5 units, the first sentence of a description, the path of the Module-1 manifest and a commit of 40 hex digits', () => {
    expect(COLLATERAL).toBe(5_000_000n);
    expect(DEMONSTRATION_SENTENCE).toBe('Demonstration organisation run by the Apex Fusion Foundation.');
    expect(MODULE_MANIFEST_PATH).toBe('Module-1/deploy/identity/mainnet/manifest.json');
    expect(RUNTIME_COMMIT).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('the data of use case 1', () => {
  it('takes the shared values from this file: the keys, the organisations, the parties, the sentence, the manifest, the commit, the collateral and the domains of the tenant', () => {
    expect(data.keys.slice(0, CORE_KEYS.length + 2)).toEqual([...CORE_KEYS, ...organisationKeys(ALFA)]);
    expect(data.organisations).toEqual([ECHO, ALFA]);
    expect(data.agents.map((agent) => agent.parties)).toEqual([partiesOf(ECHO), partiesOf(ALFA)]);
    for (const text of [...data.agents.map((agent) => agent.description), ...data.subagents.map((subagent) => subagent.description)]) expect(text.startsWith(`${DEMONSTRATION_SENTENCE} `)).toBe(true);
    expect(data.moduleManifestPath).toBe(MODULE_MANIFEST_PATH);
    expect(data.runtimeCommit).toBe(RUNTIME_COMMIT);
    for (const funding of data.funding) expect(funding.collateralLovelace, funding.wallet).toBe(COLLATERAL);
    expect(data.tenantOrganisations).toEqual({ supplier: ALFA.domain, insurer: DELTA.domain });
  });
});
