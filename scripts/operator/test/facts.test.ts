// The facts file of the operator pack: a fact is set once, a later step sets one field of a fact once, and the file holds public values only. Each refusal has an accepted twin. No test uses a real key:
// a text that looks like a key is built at run time.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { WriteIo } from '../../checks/lib/files.ts';
import type {
  AdvertFact, AttestationFact, ClaimFact, ComplianceFact, DeployFact, Facts, HoldFact, LifecycleFact, ManifestFact, OrganisationFact, RecordFact, RevocationFact, StakeFact, SubagentEndFact, TenantFact,
} from '../lib/contract.ts';
import { FactsConflict, FactsError, FactsFile } from '../lib/facts.ts';
import { KEY_TEXT, LOOKALIKE_NAMES, LOOKALIKE_TEXTS, SECRET_NAMES, SECRET_TEXTS } from './support/secrets.ts';

const folders: string[] = [];
afterAll(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** A new folder with mode 700 in the temporary directory. */
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-facts-'));
  chmodSync(dir, 0o700);
  folders.push(dir);
  return dir;
}
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const textOf = (path: string): string => readFileSync(path, 'utf8');

const IDENTITY = { useCase: 'inventory-reorder', network: 'vector-mainnet' };
const HEX_A = 'a1'.repeat(32);
const HEX_B = 'b2'.repeat(32);
const HEX_C = 'c3'.repeat(32);
const TIME = '2026-12-01T10:00:00.000Z';

const RECORD: RecordFact = { did: `did:vector:${HEX_A}`, id: HEX_A, tx: HEX_B, recordRef: `${HEX_B}#0`, depositLovelace: '10000000', registeredAt: TIME };
const ORGANISATION: OrganisationFact = { txtName: '_did.echo.example', txtValue: `did:vector:${HEX_A}`, verifiedAt: null };
const STAKE: StakeFact = { openingRef: `${HEX_B}#1`, stakeRef: null, tokenUnit: null, amountLovelace: '10000000' };
const ADVERT: AdvertFact = { ref: `${HEX_B}#0`, tx: HEX_B, detailUri: 'https://agent.example/agent.json', detailHash: HEX_C, endpoint: 'https://agent.example', postedAt: TIME };
const MANIFEST: ManifestFact = { uri: 'https://agent.example/agent.json', sha256: HEX_C, bytes: 2048, readAt: TIME };
const ATTESTATION: AttestationFact = { id: HEX_C, tx: HEX_B, digest: HEX_C, locator: 'https://agent.example/attestation.json', validUntil: '2027-12-01T10:00:00.000Z', issuedAt: TIME, envelope: true };
const CLAIM: ClaimFact = {
  claimRef: `${HEX_B}#0`, documentTx: HEX_A, claimTx: HEX_B, claimToken: `${HEX_C}436c61696d`, stakeLovelace: '50000000', windowMs: 1_800_000, stakedAt: TIME, withdrawableFrom: '2026-12-01T10:30:00.000Z', withdrawTx: null,
};
const TENANT: TenantFact = { name: 'clean-test', createdAt: TIME, seedKind: 'default' };
const HOLD: HoldFact = { suspendTx: HEX_A, liftTx: null };
const DEPLOY: DeployFact = { commit: 'a1b2c3d4e5'.repeat(4), images: { 'reorder-runtime': `registry.example/image@sha256:${HEX_C}` } };
const COMPLIANCE: ComplianceFact = {
  id: HEX_C, tx: HEX_B, digest: HEX_A, locator: 'https://agent.example/compliance.json', validUntil: '2027-12-01T10:00:00.000Z', issuedAt: TIME,
  revokeTx: null, contestTx: null, replySha256: null, replyUri: null,
};
const REVOCATION: RevocationFact = { tx: HEX_B, reason: 9, invalidFrom: null, revokedAt: TIME };
const LIFECYCLE_STEP: LifecycleFact = { tx: HEX_B, at: TIME };
const SUBAGENT_END: SubagentEndFact = { tx: HEX_C, at: TIME, epochBefore: 3, epochAfter: 4 };

interface Case { section: keyof Facts; path: string[]; fact: object; member: string; other: unknown }
/** One fact for each section, the path that it goes in, and a member with another value that makes it a different fact. */
const CASES: Case[] = [
  { section: 'records', path: ['reorder-agent'], fact: RECORD, member: 'tx', other: HEX_C },
  { section: 'organisations', path: ['echo'], fact: ORGANISATION, member: 'txtValue', other: `did:vector:${HEX_B}` },
  { section: 'stakes', path: ['reorder-agent'], fact: STAKE, member: 'amountLovelace', other: '20000000' },
  { section: 'adverts', path: ['order-desk', 'lot-small'], fact: ADVERT, member: 'ref', other: `${HEX_A}#2` },
  { section: 'manifests', path: ['order-desk'], fact: MANIFEST, member: 'bytes', other: 4096 },
  { section: 'attestations', path: ['reorder-agent', 'provenance'], fact: ATTESTATION, member: 'envelope', other: false },
  { section: 'claims', path: ['clean', 'reorder-agent'], fact: CLAIM, member: 'windowMs', other: 3_600_000 },
  { section: 'tenants', path: ['clean'], fact: TENANT, member: 'seedKind', other: 'custom' },
  { section: 'holds', path: ['clean'], fact: HOLD, member: 'suspendTx', other: HEX_C },
  { section: 'deploy', path: [], fact: DEPLOY, member: 'commit', other: 'f0e1d2c3b4'.repeat(4) },
  { section: 'compliance', path: ['sourcing-agent'], fact: COMPLIANCE, member: 'digest', other: HEX_C },
  { section: 'revocations', path: ['bid-desk-charlie'], fact: REVOCATION, member: 'reason', other: 65 },
  { section: 'lifecycle', path: ['change-controller'], fact: LIFECYCLE_STEP, member: 'tx', other: HEX_C },
  { section: 'subagentEnds', path: ['prior-authorization-agent'], fact: SUBAGENT_END, member: 'epochAfter', other: 5 },
];
interface FieldCase { section: keyof Facts; path: string[]; fact: object; field: string; value: string; other: string }
/** The fields that a later step sets, each with a fact that holds null in it. */
const FIELDS: FieldCase[] = [
  { section: 'organisations', path: ['echo'], fact: ORGANISATION, field: 'verifiedAt', value: '2026-12-01T11:00:00.000Z', other: '2026-12-01T12:00:00.000Z' },
  { section: 'stakes', path: ['reorder-agent'], fact: STAKE, field: 'stakeRef', value: `${HEX_C}#0`, other: `${HEX_C}#1` },
  { section: 'stakes', path: ['reorder-agent'], fact: STAKE, field: 'tokenUnit', value: `${HEX_A}5374616b65`, other: `${HEX_B}5374616b65` },
  { section: 'holds', path: ['clean'], fact: { suspendTx: null, liftTx: null }, field: 'suspendTx', value: HEX_B, other: HEX_C },
  { section: 'holds', path: ['clean'], fact: HOLD, field: 'liftTx', value: HEX_B, other: HEX_C },
  { section: 'claims', path: ['clean', 'reorder-agent'], fact: CLAIM, field: 'withdrawTx', value: HEX_C, other: HEX_A },
  { section: 'compliance', path: ['sourcing-agent'], fact: COMPLIANCE, field: 'revokeTx', value: HEX_A, other: HEX_B },
  { section: 'compliance', path: ['sourcing-agent'], fact: COMPLIANCE, field: 'contestTx', value: HEX_B, other: HEX_C },
  { section: 'compliance', path: ['sourcing-agent'], fact: COMPLIANCE, field: 'replySha256', value: HEX_C, other: HEX_A },
  { section: 'compliance', path: ['sourcing-agent'], fact: COMPLIANCE, field: 'replyUri', value: 'https://agent.example/reply.json', other: 'https://agent.example/reply-2.json' },
];
/** The sections whose facts take no field path. */
const NO_FIELDS = ['records', 'adverts', 'manifests', 'attestations', 'tenants', 'deploy', 'revocations', 'lifecycle', 'subagentEnds'] as const;

interface Made { path: string; facts: FactsFile; renames: () => number }
/** A facts file in a new folder. `renames` counts the writes: every write of the file ends with one rename. */
function fresh(io: Partial<WriteIo> = {}): Made {
  const path = join(folder(), 'facts.json');
  let count = 0;
  const counting: Partial<WriteIo> = { rename: (from, to) => { count += 1; renameSync(from, to); }, ...io };
  return { path, facts: FactsFile.open(path, IDENTITY, counting), renames: () => count };
}
const refusal = (run: () => unknown): FactsError => {
  try { run(); } catch (err) { if (err instanceof FactsError) return err; throw err; }
  throw new Error('the call did not refuse');
};
const put = (facts: FactsFile, section: keyof Facts, path: readonly string[], value: unknown, replace?: boolean): void => facts.put(section, path, value, replace === undefined ? undefined : { replace });
/** The members of a value that is an object, as a record, or null for any other value. */
const recordOf = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : null);
/** The fact of a path in the facts that the file gives now. */
function factAt(facts: FactsFile, section: keyof Facts, path: readonly string[]): unknown {
  let node: unknown = facts.read()[section];
  for (const key of path) node = recordOf(node)?.[key];
  return node;
}
const reversed = (fact: object): object => Object.fromEntries(Object.entries(fact).reverse());

describe('a fact is set once', () => {
  for (const { section, path, fact, member, other } of CASES) {
    describe(`${section}`, () => {
      it('goes in, and the file gives it back', () => {
        const { facts, path: file } = fresh();
        put(facts, section, path, fact);
        expect(factAt(facts, section, path)).toEqual(fact);
        expect(JSON.parse(textOf(file)).facts[section]).toEqual(section === 'deploy' ? fact : path.reduceRight<unknown>((inner, key) => ({ [key]: inner }), fact));
      });
      it('is a no-op when the same value comes again, in any order of its members', () => {
        const { facts, path: file, renames } = fresh();
        put(facts, section, path, fact);
        const before = textOf(file);
        put(facts, section, path, fact);
        put(facts, section, path, reversed(fact), false);
        put(facts, section, path, { ...fact }, true);
        expect(renames()).toBe(1);
        expect(textOf(file)).toBe(before);
      });
      it('is refused when another value comes, and the file stays as it was', () => {
        const { facts, path: file } = fresh();
        put(facts, section, path, fact);
        const before = textOf(file);
        const changed = { ...fact, [member]: other };
        for (const replace of [undefined, false, 'yes' as never, 1 as never]) {
          const err = refusal(() => put(facts, section, path, changed, replace));
          expect(err).toBeInstanceOf(FactsConflict);
          expect(err.reason).toBe('conflict');
          expect(err.message).toContain(section);
          if (typeof other === 'string') expect(err.message).not.toContain(other);
        }
        expect(textOf(file)).toBe(before);
        expect(factAt(facts, section, path)).toEqual(fact);
      });
      it('changes when the call says replace', () => {
        const { facts, path: file } = fresh();
        put(facts, section, path, fact);
        const before = textOf(file);
        put(facts, section, path, { ...fact, [member]: other }, true);
        expect(factAt(facts, section, path)).toEqual({ ...fact, [member]: other });
        expect(textOf(file)).not.toBe(before);
      });
    });
  }
  it('keeps the other facts of a section when it sets one, and sets two facts of one section below one path', () => {
    const { facts } = fresh();
    put(facts, 'adverts', ['order-desk', 'lot-small'], ADVERT);
    put(facts, 'adverts', ['order-desk', 'lot-medium'], { ...ADVERT, ref: `${HEX_A}#3` });
    put(facts, 'adverts', ['reorder-agent', 'reorder-agent-v1'], { ...ADVERT, ref: `${HEX_A}#4` });
    expect(Object.keys(facts.read().adverts['order-desk']!)).toEqual(['lot-small', 'lot-medium']);
    expect(facts.read().adverts['reorder-agent']!['reorder-agent-v1']!.ref).toBe(`${HEX_A}#4`);
    put(facts, 'records', ['a'], RECORD);
    put(facts, 'records', ['b'], { ...RECORD, tx: HEX_C });
    expect(Object.keys(facts.read().records)).toEqual(['a', 'b']);
  });
});

describe('the fields of a fact', () => {
  for (const { section, path, fact, field, value, other } of FIELDS) {
    describe(`${section}.${path.join('.')}.${field}`, () => {
      const written = (): Made => {
        const made = fresh();
        put(made.facts, section, path, fact);
        return made;
      };
      it('goes in once: null becomes the value with no replace, and the other members stay as they were', () => {
        const { facts } = written();
        expect(recordOf(factAt(facts, section, path))?.[field]).toBeNull();
        put(facts, section, [...path, field], value);
        expect(factAt(facts, section, path)).toEqual({ ...fact, [field]: value });
      });
      it('is a no-op when the same value comes again, also with replace', () => {
        const { facts, path: file, renames } = written();
        put(facts, section, [...path, field], value);
        const before = textOf(file);
        const writes = renames();
        put(facts, section, [...path, field], value);
        put(facts, section, [...path, field], value, true);
        expect(renames()).toBe(writes);
        expect(textOf(file)).toBe(before);
      });
      it('is refused when another value comes, and the file stays as it was', () => {
        const { facts, path: file } = written();
        put(facts, section, [...path, field], value);
        const before = textOf(file);
        const err = refusal(() => put(facts, section, [...path, field], other));
        expect(err).toBeInstanceOf(FactsConflict);
        expect(err.message).not.toContain(other);
        expect(err.message).not.toContain(value);
        expect(textOf(file)).toBe(before);
      });
      it('changes when the call says replace', () => {
        const { facts } = written();
        put(facts, section, [...path, field], value);
        put(facts, section, [...path, field], other, true);
        expect(factAt(facts, section, path)).toEqual({ ...fact, [field]: other });
      });
      it('is refused when no fact is there, names the path of the fact, and writes nothing', () => {
        const { facts, path: file } = fresh();
        const err = refusal(() => put(facts, section, [...path, field], value));
        expect(err.reason).toBe('missing_fact');
        expect(err.message).toContain(`${section}.${path.join('.')}`);
        expect(err.message).not.toContain(value);
        expect(existsSync(file)).toBe(false);
        const refused2 = refusal(() => put(facts, section, [...path, field], value, true));
        expect(refused2.reason).toBe('missing_fact');
      });
      it('is refused for a fact of the same section at another path', () => {
        const { facts, path: file } = fresh();
        put(facts, section, [...path.slice(0, -1), 'other-name'], fact);
        const before = textOf(file);
        expect(refusal(() => put(facts, section, [...path, field], value)).reason).toBe('missing_fact');
        expect(textOf(file)).toBe(before);
      });
    });
  }
  it('is refused in a section that takes no field path, also for a name that is a member of its fact', () => {
    for (const section of NO_FIELDS) {
      const { path, fact } = CASES.find((entry) => entry.section === section)!;
      const { facts, path: file } = fresh();
      put(facts, section, path, fact);
      const before = textOf(file);
      for (const name of [...Object.keys(fact), 'verifiedAt', 'stakeRef', 'liftTx', 'withdrawTx']) {
        for (const replace of [undefined, true]) {
          const err = refusal(() => put(facts, section, [...path, name], 'a-value', replace));
          expect(err.reason, `${section}.${name}`).toBe('path');
        }
      }
      expect(textOf(file)).toBe(before);
    }
  });
  it('is refused for a name that is not a field of its section: a member of the fact that no later step sets, a field of another section, a name in another case', () => {
    const NAMES: [keyof Facts, string[], string[]][] = [
      ['organisations', ['echo'], ['txtName', 'txtValue', 'stakeRef', 'verifiedat', 'VerifiedAt', 'verified_at', '']],
      ['stakes', ['reorder-agent'], ['openingRef', 'amountLovelace', 'verifiedAt', 'stakeref', 'token', 'tokenunit']],
      ['holds', ['clean'], ['suspend', 'lift', 'liftTX', 'withdrawTx']],
      ['claims', ['clean', 'reorder-agent'], ['claimRef', 'documentTx', 'claimTx', 'claimToken', 'withdrawtx', 'liftTx']],
      ['compliance', ['sourcing-agent'], ['id', 'tx', 'digest', 'locator', 'validUntil', 'issuedAt', 'revoketx', 'RevokeTx', 'replyHash', 'withdrawTx', 'liftTx']],
    ];
    const facts: Record<string, object> = { organisations: ORGANISATION, stakes: STAKE, holds: HOLD, claims: CLAIM, compliance: COMPLIANCE };
    for (const [section, path, names] of NAMES) {
      const made = fresh();
      put(made.facts, section, path, facts[section]);
      const before = textOf(made.path);
      for (const name of names) {
        for (const replace of [undefined, true]) {
          const err = refusal(() => put(made.facts, section, [...path, name], 'a-value', replace));
          expect(['field', 'path'], `${section}.${name}`).toContain(err.reason);
        }
      }
      expect(textOf(made.path)).toBe(before);
    }
  });
  it('accepts the field names that the sections list, and no other name of the same fact', () => {
    const { facts } = fresh();
    put(facts, 'stakes', ['a'], STAKE);
    put(facts, 'stakes', ['a', 'stakeRef'], `${HEX_C}#0`);
    put(facts, 'stakes', ['a', 'tokenUnit'], `${HEX_A}5374616b65`);
    expect(factAt(facts, 'stakes', ['a'])).toEqual({ ...STAKE, stakeRef: `${HEX_C}#0`, tokenUnit: `${HEX_A}5374616b65` });
    expect(refusal(() => put(facts, 'stakes', ['a', 'openingRef'], `${HEX_C}#9`, true)).reason).toBe('field');
  });
  it('is refused for a value that is no text: null, a number, an empty text, an object, a list', () => {
    const { facts, path: file } = fresh();
    put(facts, 'holds', ['clean'], HOLD);
    const before = textOf(file);
    for (const bad of [null, 5, '', {}, ['a'], true]) {
      expect(refusal(() => put(facts, 'holds', ['clean', 'liftTx'], bad)).reason, JSON.stringify(bad)).toBe('value');
    }
    expect(textOf(file)).toBe(before);
  });
});

describe('sections and paths', () => {
  it('refuses a section that the contract does not list, and writes nothing', () => {
    const { facts, path: file } = fresh();
    for (const section of ['nothing', '__proto__', 'constructor', 'toString', '', 'Records', 'record']) {
      expect(refusal(() => put(facts, section as keyof Facts, ['a'], RECORD)).reason, section).toBe('section');
    }
    expect(existsSync(file)).toBe(false);
  });
  for (const { section, path, fact } of CASES) {
    it(`${section}: refuses a path with another number of names than ${path.length}, or ${path.length + 1} when the last is a field`, () => {
      const { facts, path: file } = fresh();
      const wrong: unknown[] = [[...path, 'extra', 'more'], [...path, 'extra', 'more', 'most']];
      if (path.length > 0) wrong.push(path.slice(0, -1), []);
      if (path.length > 1) wrong.push(path.slice(0, -2));
      for (const bad of wrong) expect(['path', 'field'], JSON.stringify(bad)).toContain(refusal(() => put(facts, section, bad as string[], fact)).reason);
      expect(existsSync(file)).toBe(false);
      put(facts, section, path, fact);
      expect(factAt(facts, section, path)).toEqual(fact);
    });
  }
  it('refuses a path that is not a list of texts', () => {
    const { facts } = fresh();
    for (const bad of ['reorder-agent', null, undefined, { 0: 'reorder-agent' }, [5], [['reorder-agent']], [null]]) {
      expect(refusal(() => put(facts, 'records', bad as never, RECORD)).reason, JSON.stringify(bad)).toBe('path');
    }
  });
  it('refuses a name that cannot be a key of a file, and takes the names that agents, models, runs and DIDs have', () => {
    const { facts } = fresh();
    for (const bad of ['', '__proto__', ' a', 'a b', 'a/b', 'a\nb', 'x'.repeat(129), '.hidden', '-dash', '_under', 'a#b', 'a\u0000b']) {
      expect(refusal(() => put(facts, 'records', [bad], RECORD)).reason, JSON.stringify(bad)).toBe('path');
    }
    for (const good of ['reorder-agent-v1', `did:vector:${HEX_A}`, 'a.b_c', 'x'.repeat(128), 'Echo', '0abc', 'lot-small']) put(facts, 'records', [good], RECORD);
    expect(Object.keys(facts.read().records)).toHaveLength(7);
    expect('did' in {}).toBe(false);
  });
});

describe('secrets', () => {
  for (const { label, text } of SECRET_TEXTS) {
    it(`refuses ${label}: in a text of a fact, anywhere in the text, in a field, in the name of a member, in a name of the path, and when the call says replace`, () => {
      const { facts, path: file } = fresh();
      put(facts, 'holds', ['clean'], HOLD);
      const before = textOf(file);
      for (const shown of [text, `https://agent.example/?x=${text}&y=1`, `a ${text} b`]) {
        const err = refusal(() => put(facts, 'records', ['a'], { ...RECORD, did: shown }));
        expect(err.reason, shown).toBe('secret');
        expect(err.message).not.toContain(text);
        expect(refusal(() => put(facts, 'records', ['a'], { ...RECORD, did: shown }, true)).reason).toBe('secret');
        expect(refusal(() => put(facts, 'holds', ['clean', 'liftTx'], shown)).reason).toBe('secret');
        expect(refusal(() => put(facts, 'holds', ['clean', 'liftTx'], shown, true)).reason).toBe('secret');
        expect(refusal(() => put(facts, 'deploy', [], { commit: DEPLOY.commit, images: { [shown]: 'registry.example/image' } })).reason).toBe('secret');
      }
      const isName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text);
      expect(refusal(() => put(facts, 'records', [text], RECORD)).reason).toBe(isName ? 'secret' : 'path');
      expect(textOf(file)).toBe(before);
      expect(textOf(file)).not.toContain(text);
    });
  }
  it('accepts a text that only looks like a secret, in a text of a fact and as the first value of a field', () => {
    const { facts } = fresh();
    for (const [index, { label, text }] of LOOKALIKE_TEXTS.entries()) {
      put(facts, 'records', [`r${index}`], { ...RECORD, did: text });
      expect(facts.read().records[`r${index}`]!.did, label).toBe(text);
      put(facts, 'holds', [`h${index}`], { suspendTx: null, liftTx: null });
      put(facts, 'holds', [`h${index}`, 'liftTx'], text);
      expect(facts.read().holds[`h${index}`]!.liftTx, label).toBe(text);
    }
    expect(Object.keys(facts.read().records)).toHaveLength(LOOKALIKE_TEXTS.length);
  });
  it('refuses a member with exactly the name seed, secret, token, authorization or private, in any case, at any depth', () => {
    const { facts, path: file } = fresh();
    for (const name of SECRET_NAMES) {
      const attempts: [keyof Facts, string[], unknown][] = [
        ['records', ['a'], { ...RECORD, [name]: 'x' }],
        ['deploy', [], { commit: DEPLOY.commit, images: { [name]: 'x' } }],
        ['records', ['a'], { ...RECORD, extra: { deeper: { [name]: 'x' } } }],
        ['records', ['a'], { ...RECORD, extra: [{ [name]: 'x' }] }],
        ['records', ['a'], { ...RECORD, extra: [[{ [name]: null }]] }],
      ];
      for (const [section, path, value] of attempts) {
        const err = refusal(() => put(facts, section, path, value, true));
        expect(err.reason, `${name} ${JSON.stringify(value).slice(0, 40)}`).toBe('secret');
      }
    }
    expect(existsSync(file)).toBe(false);
  });
  it('accepts the members tokenUnit, claimToken and seedKind, and members whose names only contain a word of the list', () => {
    const { facts } = fresh();
    put(facts, 'stakes', ['a'], { ...STAKE, tokenUnit: `${HEX_A}5374616b65` });
    put(facts, 'stakes', ['a', 'stakeRef'], `${HEX_C}#0`);
    put(facts, 'claims', ['clean', 'a'], CLAIM);
    put(facts, 'tenants', ['clean'], TENANT);
    put(facts, 'tenants', ['custom'], { ...TENANT, seedKind: 'custom' });
    put(facts, 'deploy', [], { commit: DEPLOY.commit, images: Object.fromEntries(LOOKALIKE_NAMES.map((name) => [name, 'registry.example/image'])) });
    expect(facts.read().stakes.a!.tokenUnit).toBe(`${HEX_A}5374616b65`);
    expect(facts.read().claims.clean!.a!.claimToken).toBe(CLAIM.claimToken);
    expect(facts.read().tenants.custom!.seedKind).toBe('custom');
    expect(Object.keys(facts.read().deploy!.images)).toEqual([...LOOKALIKE_NAMES]);
  });
  it('refuses a name in the path that is the name of a secret or holds a key, also when the call says replace', () => {
    const { facts, path: file } = fresh();
    put(facts, 'records', ['good'], RECORD);
    const before = textOf(file);
    for (const name of [...SECRET_NAMES, KEY_TEXT]) {
      for (const replace of [undefined, true]) expect(refusal(() => put(facts, 'records', [name], RECORD, replace)).reason, name).toBe('secret');
    }
    expect(textOf(file)).toBe(before);
    expect(textOf(file)).not.toContain(KEY_TEXT);
  });
  for (const [section, path, fact, member] of [
    ['compliance', ['a'], COMPLIANCE, 'locator'], ['revocations', ['a'], REVOCATION, 'revokedAt'], ['lifecycle', ['a'], LIFECYCLE_STEP, 'at'], ['subagentEnds', ['a'], SUBAGENT_END, 'at'],
  ] as const) {
    it(`${section}: refuses each mark of a secret in a text, in a member named like a secret and in a name of the path, and accepts each text and each name that only looks like one`, () => {
      const { facts, path: file } = fresh();
      put(facts, section, path, fact);
      const before = textOf(file);
      for (const { text } of SECRET_TEXTS) {
        expect(refusal(() => put(facts, section, path, { ...fact, [member]: text }, true)).reason, text).toBe('secret');
        const isName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text);
        expect(refusal(() => put(facts, section, [text], fact)).reason, text).toBe(isName ? 'secret' : 'path');
      }
      for (const name of [...SECRET_NAMES, KEY_TEXT]) {
        expect(refusal(() => put(facts, section, [name], fact, true)).reason, name).toBe('secret');
        expect(refusal(() => put(facts, section, path, { ...fact, [name]: 'x' }, true)).reason, name).toBe('secret');
      }
      expect(textOf(file)).toBe(before);
      expect(textOf(file)).not.toContain(KEY_TEXT);
      for (const [index, { text }] of LOOKALIKE_TEXTS.entries()) put(facts, section, [`r${index}`], { ...fact, [member]: text });
      for (const name of LOOKALIKE_NAMES) put(facts, section, [name], fact);
      expect(Object.keys(factAt(facts, section, []) as object)).toHaveLength(1 + LOOKALIKE_TEXTS.length + LOOKALIKE_NAMES.length);
    });
  }
});

describe('the value', () => {
  it('writes a bigint as text and gives it back as text', () => {
    const { facts, path: file } = fresh();
    put(facts, 'records', ['a'], { ...RECORD, depositLovelace: 10_000_000n });
    put(facts, 'claims', ['clean', 'a'], { ...CLAIM, stakeLovelace: 50_000_000n });
    expect(JSON.parse(textOf(file)).facts.records.a.depositLovelace).toBe('10000000');
    expect(facts.read().records.a!.depositLovelace).toBe('10000000');
    expect(facts.read().claims.clean!.a!.stakeLovelace).toBe('50000000');
    put(facts, 'records', ['a'], { ...RECORD, depositLovelace: '10000000' });
  });
  it('refuses a value that is no fact of its section: null, a list, a text, a missing member, an extra member', () => {
    const { facts, path: file } = fresh();
    const withoutDid = Object.fromEntries(Object.entries(RECORD).filter(([member]) => member !== 'did'));
    const bad = [null, [], [RECORD], 'a text', 5, true, {}, withoutDid, { ...RECORD, extra: 'x' }, { ...RECORD, did: 5 }, { ...RECORD, did: '' }, { ...RECORD, did: null }];
    for (const value of bad) expect(refusal(() => put(facts, 'records', ['a'], value)).reason, JSON.stringify(value)).toBe('value');
    expect(existsSync(file)).toBe(false);
  });
  it('holds each member to its kind', () => {
    const { facts, path: file } = fresh();
    const BAD: [keyof Facts, string[], object, string, unknown[], unknown[]][] = [
      ['records', ['a'], RECORD, 'depositLovelace', ['1.5', '-1', 'ten', '01', '1e6', ' 5', 5.5], ['0', '10000000']],
      ['stakes', ['a'], STAKE, 'amountLovelace', ['x', '1.5'], ['2']],
      ['claims', ['clean', 'a'], CLAIM, 'stakeLovelace', ['x', '1.5'], ['50000000']],
      ['manifests', ['a'], MANIFEST, 'bytes', [-1, 1.5, '5', null, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60], [0, 2048]],
      ['claims', ['clean', 'a'], CLAIM, 'windowMs', [-1, 1.5, '5', null], [0, 1_800_000]],
      ['attestations', ['a', 'software'], ATTESTATION, 'envelope', ['true', 1, null], [true, false]],
      ['tenants', ['clean'], TENANT, 'seedKind', ['other', 'Default', null, 1], ['default', 'custom']],
      ['organisations', ['echo'], ORGANISATION, 'verifiedAt', [5, ''], [null, TIME]],
      ['holds', ['clean'], HOLD, 'liftTx', [5, '', {}], [null, HEX_A]],
      ['deploy', [], DEPLOY, 'images', [{ a: 5 }, { 'a b': 'x' }, { a: '' }, 'text', null, [], ['a']], [{}, { a: 'x' }]],
      ['deploy', [], DEPLOY, 'commit', [5, '', null], ['a1b2c3d4e5']],
      ['compliance', ['a'], COMPLIANCE, 'revokeTx', [5, '', {}], [null, HEX_A]],
      ['compliance', ['a'], COMPLIANCE, 'replyUri', [5, '', []], [null, 'https://agent.example/reply.json']],
      ['compliance', ['a'], COMPLIANCE, 'validUntil', [5, '', null], [TIME]],
      ['revocations', ['a'], REVOCATION, 'reason', [-1, 1.5, '9', null, Number.NaN], [0, 9, 65]],
      ['revocations', ['a'], REVOCATION, 'invalidFrom', [5, '', {}], [null, TIME]],
      ['lifecycle', ['a'], LIFECYCLE_STEP, 'at', [5, '', null], [TIME]],
      ['subagentEnds', ['a'], SUBAGENT_END, 'epochBefore', [-1, 1.5, '3', null], [0, 7]],
      ['subagentEnds', ['a'], SUBAGENT_END, 'epochAfter', [-1, 1.5, '4', null], [0, 8]],
    ];
    for (const [section, path, fact, member, bad, good] of BAD) {
      for (const value of bad) expect(refusal(() => put(facts, section, path, { ...fact, [member]: value }, true)).reason, `${section}.${member}=${String(value)}`).toBe('value');
      for (const value of good) put(facts, section, path, { ...fact, [member]: value }, true);
    }
    expect(textOf(file)).not.toContain('NaN');
  });
  it('refuses a value that JSON cannot hold: undefined, a function, a symbol, a cycle', () => {
    const { facts, path: file } = fresh();
    const cycle: Record<string, unknown> = { ...RECORD };
    cycle.self = cycle;
    for (const value of [undefined, () => RECORD, Symbol('x'), cycle]) expect(refusal(() => put(facts, 'records', ['a'], value)).reason).toBe('value');
    expect(existsSync(file)).toBe(false);
  });
  it('copies the value: a change of the object after the call changes nothing', () => {
    const { facts } = fresh();
    const value = { ...RECORD };
    put(facts, 'records', ['a'], value);
    value.did = 'changed';
    expect(facts.read().records.a).toEqual(RECORD);
  });
});

describe('the file', () => {
  it('is not made by open or by read, which give empty facts; a put makes it, with mode 600 in a folder with mode 700', () => {
    const path = join(folder(), 'state', 'facts.json');
    const facts = FactsFile.open(path, IDENTITY);
    expect(facts.read()).toEqual({
      records: {}, organisations: {}, stakes: {}, adverts: {}, manifests: {}, attestations: {}, claims: {}, tenants: {}, holds: {}, deploy: null, compliance: {}, revocations: {}, lifecycle: {}, subagentEnds: {},
    });
    expect(existsSync(path)).toBe(false);
    put(facts, 'records', ['a'], RECORD);
    expect(modeOf(path)).toBe(0o600);
    expect(modeOf(join(path, '..'))).toBe(0o700);
  });
  it('holds the format, the identity and the fourteen sections, as JSON', () => {
    const { facts, path } = fresh();
    put(facts, 'records', ['a'], RECORD);
    const file = JSON.parse(textOf(path));
    expect(Object.keys(file)).toEqual(['format', 'useCase', 'network', 'facts']);
    expect([file.format, file.useCase, file.network]).toEqual([1, 'inventory-reorder', 'vector-mainnet']);
    expect(Object.keys(file.facts)).toEqual([
      'records', 'organisations', 'stakes', 'adverts', 'manifests', 'attestations', 'claims', 'tenants', 'holds', 'deploy', 'compliance', 'revocations', 'lifecycle', 'subagentEnds',
    ]);
    expect(file.facts.deploy).toBeNull();
    expect(textOf(path).endsWith('\n')).toBe(true);
  });
  it('is read again at every call, so that two instances over one file see each other', () => {
    const { facts: first, path } = fresh();
    const second = FactsFile.open(path, IDENTITY);
    put(first, 'records', ['a'], RECORD);
    expect(second.read().records.a).toEqual(RECORD);
    put(second, 'tenants', ['clean'], TENANT);
    expect(first.read().tenants.clean).toEqual(TENANT);
    expect(refusal(() => put(second, 'records', ['a'], { ...RECORD, tx: HEX_C })).reason).toBe('conflict');
  });
  it('reads a file that an earlier run wrote, and sets a field of a fact that it holds', () => {
    const { facts, path } = fresh();
    put(facts, 'stakes', ['a'], STAKE);
    const later = FactsFile.open(path, IDENTITY);
    put(later, 'stakes', ['a', 'stakeRef'], `${HEX_C}#0`);
    expect(FactsFile.open(path, IDENTITY).read().stakes.a!.stakeRef).toBe(`${HEX_C}#0`);
  });
  it('gives frozen facts: a change throws, and the file does not change', () => {
    const { facts, path } = fresh();
    put(facts, 'records', ['a'], RECORD);
    put(facts, 'deploy', [], DEPLOY);
    const before = textOf(path);
    const read = facts.read();
    const images = read.deploy?.images;
    expect(Object.isFrozen(read) && Object.isFrozen(read.records) && Object.isFrozen(read.records.a) && Object.isFrozen(read.deploy) && Object.isFrozen(images)).toBe(true);
    expect(() => Object.assign(read.records, { b: RECORD })).toThrow(TypeError);
    expect(() => Object.assign(read.records.a!, { did: 'changed' })).toThrow(TypeError);
    expect(() => Object.assign(images!, { x: 'y' })).toThrow(TypeError);
    expect(textOf(path)).toBe(before);
    expect(facts.read().records.a!.did).toBe(RECORD.did);
  });
  it('leaves the old file and says the code of the system when a write fails, and shows no path', () => {
    const failing: Partial<WriteIo> = { rename: () => { throw Object.assign(new Error('EIO: a message that holds /a/private/path'), { code: 'EIO' }); } };
    const { facts, path } = fresh();
    put(facts, 'records', ['a'], RECORD);
    const before = textOf(path);
    const broken = FactsFile.open(path, IDENTITY, failing);
    const err = refusal(() => put(broken, 'records', ['b'], RECORD));
    expect(err.reason).toBe('unwritable');
    expect(err.message).toContain('EIO');
    expect(err.message).not.toMatch(/private|path/);
    expect(textOf(path)).toBe(before);
  });
  it('refuses another use case and another network, at open and later, and leaves the file as it is', () => {
    const { facts, path } = fresh();
    put(facts, 'records', ['a'], RECORD);
    const before = textOf(path);
    for (const other of [{ ...IDENTITY, useCase: 'another-use-case' }, { ...IDENTITY, network: 'vector-test' }, { useCase: 'Inventory-Reorder', network: 'vector-mainnet' }]) {
      const err = refusal(() => FactsFile.open(path, other));
      expect(err.reason).toBe('mismatch');
      expect(err.message).not.toContain('another-use-case');
    }
    const text = JSON.parse(before);
    for (const change of [{ useCase: 'another-use-case' }, { network: 'vector-test' }]) {
      writeFileSync(path, `${JSON.stringify({ ...text, ...change })}\n`, { mode: 0o600 });
      expect(refusal(() => facts.read()).reason).toBe('mismatch');
      expect(refusal(() => put(facts, 'records', ['b'], RECORD)).reason).toBe('mismatch');
      expect(refusal(() => put(facts, 'records', ['b'], RECORD, true)).reason).toBe('mismatch');
    }
    expect(JSON.parse(textOf(path)).facts.records).toEqual({ a: RECORD });
  });
  it('refuses a file that other users can read or write, at open and later, and does not change it', () => {
    const { facts, path } = fresh();
    put(facts, 'records', ['a'], RECORD);
    const before = textOf(path);
    for (const mode of [0o644, 0o640, 0o660, 0o666, 0o400, 0o700]) {
      chmodSync(path, mode);
      const err = refusal(() => FactsFile.open(path, IDENTITY));
      expect(err.reason, mode.toString(8)).toBe('mode');
      expect(err.message).toContain(mode.toString(8));
      expect(refusal(() => facts.read()).reason).toBe('mode');
      expect(refusal(() => put(facts, 'records', ['b'], RECORD)).reason).toBe('mode');
      expect(textOf(path)).toBe(before);
    }
    chmodSync(path, 0o600);
    expect(FactsFile.open(path, IDENTITY).read().records.a).toEqual(RECORD);
  });
  it('refuses a path that is a folder as damaged, and a path below a file as unreadable, with the code of the system and no path', () => {
    const dir = folder();
    mkdirSync(join(dir, 'facts.json'));
    expect(refusal(() => FactsFile.open(join(dir, 'facts.json'), IDENTITY)).reason).toBe('damaged');
    writeFileSync(join(dir, 'a-file'), 'x', { mode: 0o600 });
    const err = refusal(() => FactsFile.open(join(dir, 'a-file', 'facts.json'), IDENTITY));
    expect(err.reason).toBe('unreadable');
    expect(err.message).toContain('ENOTDIR');
    expect(err.message).not.toContain(dir);
    expect(textOf(join(dir, 'a-file'))).toBe('x');
  });
  it('says unwritable, with the code of the system and no path, when the folder of the file cannot be made', () => {
    const dir = folder();
    const facts = FactsFile.open(join(dir, 'sub', 'facts.json'), IDENTITY);
    writeFileSync(join(dir, 'sub'), 'x', { mode: 0o600 });
    const err = refusal(() => put(facts, 'records', ['a'], RECORD));
    expect(err.reason).toBe('unwritable');
    expect(err.message).toMatch(/\((?:EEXIST|ENOTDIR)\)/);
    expect(err.message).not.toContain(dir);
    expect(textOf(join(dir, 'sub'))).toBe('x');
  });
  it('refuses a link as the facts file, as damaged, in open, read and put: a link to a facts file and a link to nothing, and leaves the link and what it names as they are', () => {
    const dir = folder();
    const target = join(dir, 'target.json');
    put(FactsFile.open(target, IDENTITY), 'records', ['a'], RECORD);
    const before = textOf(target);
    const nothing = join(dir, 'nothing.json');
    const links: [string, string][] = [[join(dir, 'to-file.json'), target], [join(dir, 'to-nothing.json'), nothing]];
    const opened = links.map(([link]) => FactsFile.open(link, IDENTITY));
    for (const [link, goal] of links) symlinkSync(goal, link);
    for (const [index, [link, goal]] of links.entries()) {
      const facts = opened[index]!;
      expect(refusal(() => FactsFile.open(link, IDENTITY)).reason, link).toBe('damaged');
      expect(refusal(() => facts.read()).reason).toBe('damaged');
      for (const replace of [undefined, true]) expect(refusal(() => put(facts, 'records', ['b'], RECORD, replace)).reason).toBe('damaged');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(goal);
      expect(existsSync(`${link}.lock`)).toBe(false);
    }
    expect(existsSync(nothing)).toBe(false);
    expect(textOf(target)).toBe(before);
  });
  describe('the lock file', () => {
    it('is held around a put and removed after it, and a put is refused while a lock file exists: the message names the file, and nothing changes', () => {
      const { facts, path } = fresh();
      const lock = `${path}.lock`;
      put(facts, 'records', ['a'], RECORD);
      expect(existsSync(lock)).toBe(false);
      writeFileSync(lock, '', { mode: 0o600 });
      const before = textOf(path);
      const calls = [
        () => put(facts, 'records', ['b'], RECORD), () => put(facts, 'records', ['a'], RECORD), () => put(facts, 'records', ['a'], { ...RECORD, tx: HEX_C }, true),
        () => put(facts, 'holds', ['h'], HOLD), () => put(facts, 'holds', ['h', 'liftTx'], HEX_A),
      ];
      for (const call of calls) {
        const err = refusal(call);
        expect(err.reason).toBe('locked');
        expect(err.message).toContain(lock);
        expect(err.message).toContain('lock file');
      }
      expect(textOf(path)).toBe(before);
      expect(existsSync(lock)).toBe(true);
      expect(facts.read().records.a).toEqual(RECORD);
      rmSync(lock);
      put(facts, 'records', ['b'], RECORD);
      expect(existsSync(lock)).toBe(false);
      expect(Object.keys(facts.read().records)).toEqual(['a', 'b']);
    });
    it('is taken before the file is read: with a lock file there and a damaged facts file, a put says locked and not damaged', () => {
      const { facts, path } = fresh();
      put(facts, 'records', ['a'], RECORD);
      writeFileSync(path, 'not json', { mode: 0o600 });
      writeFileSync(`${path}.lock`, '', { mode: 0o600 });
      expect(refusal(() => put(facts, 'records', ['b'], RECORD)).reason).toBe('locked');
      rmSync(`${path}.lock`);
      expect(refusal(() => put(facts, 'records', ['b'], RECORD)).reason).toBe('damaged');
      expect(existsSync(`${path}.lock`)).toBe(false);
      expect(textOf(path)).toBe('not json');
    });
    it('is held until the rename: a put of another instance in the middle of a write is refused, so that no fact is lost', () => {
      const path = join(folder(), 'facts.json');
      const second = FactsFile.open(path, IDENTITY);
      const seen: FactsError[] = [];
      const first = FactsFile.open(path, IDENTITY, { rename: (from, to) => { seen.push(refusal(() => put(second, 'records', ['b'], RECORD))); renameSync(from, to); } });
      put(first, 'records', ['a'], RECORD);
      expect(seen.map((err) => err.reason)).toEqual(['locked']);
      expect(Object.keys(first.read().records)).toEqual(['a']);
      put(second, 'records', ['b'], RECORD);
      expect(Object.keys(second.read().records)).toEqual(['a', 'b']);
    });
    it('is removed when a put ends, also when the put is a no-op, is refused or fails to write', () => {
      const { facts, path } = fresh();
      const lock = `${path}.lock`;
      put(facts, 'records', ['a'], RECORD);
      put(facts, 'records', ['a'], RECORD);
      expect(existsSync(lock)).toBe(false);
      expect(refusal(() => put(facts, 'records', ['a'], { ...RECORD, tx: HEX_C })).reason).toBe('conflict');
      expect(existsSync(lock)).toBe(false);
      expect(refusal(() => put(facts, 'stakes', ['x', 'stakeRef'], HEX_C)).reason).toBe('missing_fact');
      expect(existsSync(lock)).toBe(false);
      const failing = FactsFile.open(path, IDENTITY, { rename: () => { throw Object.assign(new Error('EIO: a message that holds /a/private/path'), { code: 'EIO' }); } });
      expect(refusal(() => put(failing, 'records', ['b'], RECORD)).reason).toBe('unwritable');
      expect(existsSync(lock)).toBe(false);
    });
    it('makes no lock file and no folder for a refusal that comes before the file: a secret, a section, a value', () => {
      const dir = join(folder(), 'state');
      const facts = FactsFile.open(join(dir, 'facts.json'), IDENTITY);
      expect(refusal(() => put(facts, 'records', ['seed'], RECORD)).reason).toBe('secret');
      expect(refusal(() => put(facts, 'nothing' as keyof Facts, ['a'], RECORD)).reason).toBe('section');
      expect(refusal(() => put(facts, 'records', ['a'], { did: 'x' })).reason).toBe('value');
      expect(existsSync(dir)).toBe(false);
    });
  });

  describe('a damaged file is an error and never an empty store', () => {
    const empty = {
      records: {}, organisations: {}, stakes: {}, adverts: {}, manifests: {}, attestations: {}, claims: {}, tenants: {}, holds: {}, deploy: null, compliance: {}, revocations: {}, lifecycle: {}, subagentEnds: {},
    };
    const envelope = (over: Record<string, unknown> = {}, facts: Record<string, unknown> = {}): Record<string, unknown> => ({ format: 1, ...IDENTITY, facts: { ...empty, ...facts }, ...over });
    const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
    const without = (source: Record<string, unknown>, name: string): Record<string, unknown> => Object.fromEntries(Object.entries(source).filter(([key]) => key !== name));
    const withoutHolds = without(empty, 'holds');
    const withoutMember = (name: string): Record<string, unknown> => without(envelope(), name);
    const LATER = ['compliance', 'revocations', 'lifecycle', 'subagentEnds'];
    const omit = (source: Record<string, unknown>, ...names: string[]): Record<string, unknown> => Object.fromEntries(Object.entries(source).filter(([key]) => !names.includes(key)));
    const firstShape = omit(empty, ...LATER);
    const DAMAGED: [string, string][] = [
      ['text that is not JSON', 'not json'],
      ['an empty file', ''],
      ['half a file', json(envelope()).slice(0, 60)],
      ['a JSON list', '[]'],
      ['JSON null', 'null'],
      ['a text', '"facts"'],
      ['another format', json(envelope({ format: 2 }))],
      ['a format that is a text', json(envelope({ format: '1' }))],
      ['no format', json(withoutMember('format'))],
      ['no use case', json(withoutMember('useCase'))],
      ['no network', json(withoutMember('network'))],
      ['no facts', json(withoutMember('facts'))],
      ['a member that it does not take', json(envelope({ note: 'x' }))],
      ['a missing section', json(envelope({ facts: withoutHolds }))],
      ['a section that it does not list', json(envelope({ facts: { ...empty, extra: {} } }))],
      ...LATER.map((name): [string, string] => [`thirteen sections: ${name} is missing`, json(envelope({ facts: omit(empty, name) }))]),
      ['twelve sections: the first ten and two later ones', json(envelope({ facts: omit(empty, 'lifecycle', 'subagentEnds') }))],
      ['eleven sections: the first ten and one later one', json(envelope({ facts: omit(empty, 'revocations', 'lifecycle', 'subagentEnds') }))],
      ['nine sections: the first ten without holds', json(envelope({ facts: omit(firstShape, 'holds') }))],
      ['the first ten sections and a section that it does not list', json(envelope({ facts: { ...firstShape, extra: {} } }))],
      ['a fact of compliance of the wrong shape', json(envelope({}, { compliance: { a: { id: 'x' } } }))],
      ['a fact of compliance with a later field of the wrong kind', json(envelope({}, { compliance: { a: { ...COMPLIANCE, revokeTx: 5 } } }))],
      ['a revocation with a reason that is no number', json(envelope({}, { revocations: { a: { ...REVOCATION, reason: '9' } } }))],
      ['a lifecycle step with no time', json(envelope({}, { lifecycle: { a: { tx: HEX_B } } }))],
      ['a subagent end with an epoch that is a text', json(envelope({}, { subagentEnds: { a: { ...SUBAGENT_END, epochAfter: '4' } } }))],
      ['a map of facts where a fact of lifecycle belongs', json(envelope({}, { lifecycle: { a: { b: LIFECYCLE_STEP } } }))],
      ['a section that is a list', json(envelope({}, { records: [] }))],
      ['a section that is a text', json(envelope({}, { claims: 'x' }))],
      ['a section that is null', json(envelope({}, { stakes: null }))],
      ['facts that are a list', json(envelope({ facts: [] }))],
      ['a fact of the wrong shape', json(envelope({}, { records: { a: { did: 'x' } } }))],
      ['a fact with an extra member', json(envelope({}, { records: { a: { ...RECORD, extra: 'x' } } }))],
      ['a fact with a member of the wrong kind', json(envelope({}, { manifests: { a: { ...MANIFEST, bytes: '5' } } }))],
      ['a lovelace member that is no digits', json(envelope({}, { records: { a: { ...RECORD, depositLovelace: 'ten' } } }))],
      ['a fact where a map of facts belongs', json(envelope({}, { adverts: { a: ADVERT } }))],
      ['a map of facts where a fact belongs', json(envelope({}, { records: { a: { b: RECORD } } }))],
      ['a name that is no key', json(envelope({}, { records: { 'a b': RECORD } }))],
      ['the name __proto__', json(envelope()).replace('"records": {}', '"records": { "__proto__": {} }')],
      ['deploy that is a text', json(envelope({}, { deploy: 'x' }))],
      ['deploy of the wrong shape', json(envelope({}, { deploy: { commit: 'x' } }))],
    ];
    const written = (text: string, mode = 0o600): string => {
      const path = join(folder(), 'facts.json');
      writeFileSync(path, text, { mode });
      chmodSync(path, mode);
      return path;
    };
    for (const [label, text] of DAMAGED) {
      it(`${label}: open refuses it, says it is damaged, and leaves it as it is`, () => {
        const path = written(text);
        const err = refusal(() => FactsFile.open(path, IDENTITY));
        expect(err.reason).toBe('damaged');
        expect(err.message).toContain('damaged');
        expect(textOf(path)).toBe(text);
      });
    }
    it('accepts a file that holds facts of each section, and opens the empty file that a run writes', () => {
      const all = envelope({}, {
        records: { a: RECORD }, organisations: { echo: ORGANISATION }, stakes: { a: STAKE }, adverts: { a: { lot: ADVERT } }, manifests: { a: MANIFEST }, attestations: { a: { software: ATTESTATION } }, claims: { clean: { a: CLAIM } },
        tenants: { clean: TENANT }, holds: { clean: HOLD }, deploy: DEPLOY, compliance: { a: COMPLIANCE }, revocations: { a: REVOCATION }, lifecycle: { a: LIFECYCLE_STEP }, subagentEnds: { a: SUBAGENT_END },
      });
      const facts = FactsFile.open(written(json(all)), IDENTITY);
      expect(facts.read().adverts.a!.lot).toEqual(ADVERT);
      expect(facts.read().deploy).toEqual(DEPLOY);
      expect([facts.read().compliance.a, facts.read().revocations.a, facts.read().lifecycle.a, facts.read().subagentEnds.a]).toEqual([COMPLIANCE, REVOCATION, LIFECYCLE_STEP, SUBAGENT_END]);
      expect(FactsFile.open(written(json(envelope())), IDENTITY).read().records).toEqual({});
    });
    it('refuses to read and to put when the file is damaged after open, and never replaces it with an empty store', () => {
      const { facts, path } = fresh();
      put(facts, 'records', ['a'], RECORD);
      for (const [label, text] of DAMAGED) {
        writeFileSync(path, text, { mode: 0o600 });
        expect(refusal(() => facts.read()).reason, label).toBe('damaged');
        expect(refusal(() => put(facts, 'records', ['b'], RECORD)).reason, label).toBe('damaged');
        expect(refusal(() => put(facts, 'tenants', ['clean'], TENANT, true)).reason, label).toBe('damaged');
        expect(textOf(path), label).toBe(text);
      }
    });
  });
});

describe('a file of the first shape of the pack: the ten sections that a run wrote before the four later sections', () => {
  /** A file that the facts library of the first shape wrote in a real run of its code: a fact in each of its ten sections, with identity inventory-reorder on vector-mainnet. */
  const FIRST_SHAPE_TEXT = readFileSync(new URL('./fixtures/facts-first-shape.json', import.meta.url), 'utf8');
  const FIRST: Record<string, unknown> = JSON.parse(FIRST_SHAPE_TEXT).facts;
  const FIRST_NAMES = ['records', 'organisations', 'stakes', 'adverts', 'manifests', 'attestations', 'claims', 'tenants', 'holds', 'deploy'];
  const ALL_NAMES = [...FIRST_NAMES, 'compliance', 'revocations', 'lifecycle', 'subagentEnds'];
  const LATER_EMPTY = { compliance: {}, revocations: {}, lifecycle: {}, subagentEnds: {} };
  /** A copy of the file of the first shape, with mode 600, in a new folder. */
  function copy(): string {
    const path = join(folder(), 'facts.json');
    writeFileSync(path, FIRST_SHAPE_TEXT, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
  it('has the ten sections of the first shape and no more, and a fact in each of them', () => {
    expect(Object.keys(FIRST)).toEqual(FIRST_NAMES);
    for (const name of FIRST_NAMES) expect(Object.keys(FIRST[name] as object).length > 0 || name === 'deploy', name).toBe(true);
    expect(FIRST.deploy).not.toBeNull();
  });
  it('opens and reads with the four later sections empty, gives each fact as the file holds it, and does not change the file', () => {
    const path = copy();
    const facts = FactsFile.open(path, IDENTITY);
    expect(facts.read()).toEqual({ ...FIRST, ...LATER_EMPTY });
    expect(factAt(facts, 'holds', ['clean'])).toEqual(HOLD);
    expect(textOf(path)).toBe(FIRST_SHAPE_TEXT);
  });
  it('gives the file all fourteen sections at its first put, keeps each fact that it held, and sets each fact once as before', () => {
    const path = copy();
    const facts = FactsFile.open(path, IDENTITY);
    put(facts, 'compliance', ['sourcing-agent'], COMPLIANCE);
    const file = JSON.parse(textOf(path));
    expect(Object.keys(file.facts)).toEqual(ALL_NAMES);
    for (const name of FIRST_NAMES) expect(file.facts[name], name).toEqual(FIRST[name]);
    expect(file.facts.compliance).toEqual({ 'sourcing-agent': COMPLIANCE });
    for (const name of ['revocations', 'lifecycle', 'subagentEnds']) expect(file.facts[name], name).toEqual({});
    expect(FactsFile.open(path, IDENTITY).read().compliance['sourcing-agent']).toEqual(COMPLIANCE);
    expect(refusal(() => put(facts, 'holds', ['clean'], { ...HOLD, suspendTx: HEX_C })).reason).toBe('conflict');
  });
  it('sets a field of a fact that the file of the first shape holds, and then holds fourteen sections', () => {
    const path = copy();
    const facts = FactsFile.open(path, IDENTITY);
    expect(factAt(facts, 'holds', ['clean'])).toEqual({ suspendTx: HEX_A, liftTx: null });
    put(facts, 'holds', ['clean', 'liftTx'], HEX_B);
    const file = JSON.parse(textOf(path));
    expect(Object.keys(file.facts)).toEqual(ALL_NAMES);
    expect(file.facts.holds).toEqual({ clean: { suspendTx: HEX_A, liftTx: HEX_B } });
  });
});
