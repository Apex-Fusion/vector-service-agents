// packages/usecase-kit/test/priorauth/claims.test.ts: the capabilities, the model names and the claim statements of the two agents of use case 2 (prior authorization), and the shape of the folder. The manifest of
// an agent, its claim document and the challenge of the other agent all use these constants, so a challenge names the text that the claim holds. The texts below are the golden texts: a change of a word shows here.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claimDocument, readClaimDocument } from '@vsa/usecase-kit/dispute';
import { ORDER_DESK_CLAIM, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import { MAX_STATEMENT_CHARS, buildClaim, parseClaim } from '@vsa/usecase-kit/manifest';
import { INTAKE_CLAIM, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import * as byName from '@vsa/usecase-kit/priorauth';
import * as byPath from '../../src/priorauth/index.ts';
import { isModelName } from '@vsa/usecase-kit/protocol';
import type { ManifestClaim } from '@vsa/usecase-kit/protocol';
import { expectRefused, must } from './support.ts';

const PRIORAUTH_TEXTS = [
  'A request this agent submits is byte-identical to the document whose digest its hirer approved.',
  'The record set hash in a request is the hash of the set that its model was given.',
  'This agent reads records and guidelines only through its subagents, each with its own token under its own sub-delegation.',
] as const;

const INTAKE_TEXTS = [
  'This agent issues an intake record only for a request with a valid sign-off by the party whose delegation paid for it.',
  'An intake record names the hash of the request this agent received.',
  'This agent files one entry per request number.',
] as const;

const AGENT = `did:vector:${'ec'.repeat(32)}`;
const MANIFEST_SHA = 'ab'.repeat(32);

const CLAIMS = [
  ['the Prior Authorization Agent', PRIORAUTH_CLAIM, PRIORAUTH_TEXTS, PRIORAUTH_CAPABILITIES.draft],
  ['the Insurer Intake Agent', INTAKE_CLAIM, INTAKE_TEXTS, PRIORAUTH_CAPABILITIES.intake],
] as const;

describe('the capabilities', () => {
  it('are the capability of the Prior Authorization Agent and the capability of the Insurer Intake Agent', () => {
    expect(PRIORAUTH_CAPABILITIES).toStrictEqual({ draft: 'health.priorauth.draft.v1', intake: 'health.priorauth.intake.v1' });
  });

  it('cannot be changed, and an assignment throws', () => {
    // The type says that the members are read-only. The test checks that the object refuses a write at run time too.
    const mutable = PRIORAUTH_CAPABILITIES as { draft: string; intake: string };
    expect(Object.isFrozen(PRIORAUTH_CAPABILITIES)).toBe(true);
    expect(() => { mutable.intake = 'other'; }).toThrow(TypeError);
    expect(Reflect.set(PRIORAUTH_CAPABILITIES, 'draft', 'other')).toBe(false);
    expect(Reflect.deleteProperty(PRIORAUTH_CAPABILITIES, 'draft')).toBe(false);
    expect(PRIORAUTH_CAPABILITIES.intake).toBe('health.priorauth.intake.v1');
  });
});

describe('the models', () => {
  it('are the model of each advert and each receipt: one for the Prior Authorization Agent and one for the Insurer Intake Agent', () => {
    expect(PRIORAUTH_MODELS).toStrictEqual({ draft: 'prior-authorization-agent-v1', intake: 'insurer-intake-agent-v1' });
  });

  it('are model names that an advert can hold, and they differ from each other and from the capabilities', () => {
    const values = [...Object.values(PRIORAUTH_MODELS), ...Object.values(PRIORAUTH_CAPABILITIES)];
    for (const model of Object.values(PRIORAUTH_MODELS)) expect(isModelName(model), model).toBe(true);
    expect(new Set(values).size).toBe(4);
  });

  it('cannot be changed, and an assignment throws', () => {
    // The type says that the members are read-only. The test checks that the object refuses a write at run time too.
    const mutable = PRIORAUTH_MODELS as { draft: string; intake: string };
    expect(Object.isFrozen(PRIORAUTH_MODELS)).toBe(true);
    expect(() => { mutable.draft = 'other'; }).toThrow(TypeError);
    expect(Reflect.set(PRIORAUTH_MODELS, 'intake', 'other')).toBe(false);
    expect(Reflect.deleteProperty(PRIORAUTH_MODELS, 'intake')).toBe(false);
    expect(PRIORAUTH_MODELS.draft).toBe('prior-authorization-agent-v1');
  });
});

describe.each(CLAIMS)('the claim of %s', (_name, claim, texts, capability) => {
  it('has exactly three statements, with the ids S1, S2 and S3 in this order, and no claim reference', () => {
    expect(Object.keys(claim)).toStrictEqual(['statements']);
    expect(claim.statements).toHaveLength(3);
    expect(claim.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    for (const statement of claim.statements) expect(Object.keys(statement)).toStrictEqual(['id', 'text']);
  });

  it('holds the texts of the statements word for word', () => {
    expect(claim.statements.map((statement) => statement.text)).toStrictEqual([...texts]);
  });

  it('holds plain texts: one line, no control character, no space at either end, and the NFC form', () => {
    for (const { text } of claim.statements) {
      expect(text, text).toBe(text.trim());
      expect(text, text).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(text, text).toBe(text.normalize('NFC'));
      expect(text.length, text).toBeGreaterThan(0);
      expect(text.endsWith('.'), text).toBe(true);
    }
  });

  it('holds texts that the manifest can hold: at most the longest statement, and three different texts', () => {
    for (const { text } of claim.statements) expect(text.length, text).toBeLessThanOrEqual(MAX_STATEMENT_CHARS);
    expect(new Set(claim.statements.map((statement) => statement.text)).size).toBe(3);
  });

  it('is taken by the claim parser of the manifest folder, and the copy is the claim', () => {
    expect(parseClaim(claim)).toStrictEqual({ ok: true, value: claim });
    expect(must(parseClaim(claim))).not.toBe(claim);
  });

  it('is the claim that the builder of the manifest folder makes from its three texts', () => {
    expect(buildClaim([...texts])).toStrictEqual({ ok: true, value: claim });
  });

  it('is taken by the claim document of the dispute folder, and the document reads back as the claim', () => {
    const document = must(claimDocument({ agent_did: AGENT, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim }));
    expect(must(readClaimDocument(document.bytes))).toStrictEqual({ agent_did: AGENT, capability_id: capability, manifest_sha256: MANIFEST_SHA, claim });
  });

  it('cannot be changed: the claim, its list and each statement are frozen, and an assignment throws', () => {
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.isFrozen(claim.statements)).toBe(true);
    for (const statement of claim.statements) expect(Object.isFrozen(statement)).toBe(true);
    // The type says that the members are read-only. The test checks that the objects refuse a write at run time too.
    const first = claim.statements[0] as { id: string; text: string };
    const writable = claim as { statements: unknown };
    expect(() => { first.text = 'changed'; }).toThrow(TypeError);
    expect(() => { writable.statements = []; }).toThrow(TypeError);
    expect(Reflect.set(claim.statements[0], 'text', 'changed')).toBe(false);
    expect(() => Array.prototype.push.call(claim.statements, { id: 'S4', text: 'a fourth statement' })).toThrow(TypeError);
    expect(claim.statements.map((statement) => statement.text)).toStrictEqual([...texts]);
  });
});

describe('the two claims', () => {
  it('share no text with each other or with the claims of use case 1: a challenge that names one text cannot be read as a challenge of another claim', () => {
    const all = [PRIORAUTH_CLAIM, INTAKE_CLAIM, REORDER_CLAIM, ORDER_DESK_CLAIM].flatMap((claim) => claim.statements.map((statement) => statement.text));
    expect(new Set(all).size).toBe(12);
  });

  it('are two different claims, and each is used by the agent of its capability', () => {
    expect(PRIORAUTH_CLAIM).not.toStrictEqual(INTAKE_CLAIM);
    expect(PRIORAUTH_CLAIM.statements[0].text).toContain('digest its hirer approved');
    expect(INTAKE_CLAIM.statements[1].text).toContain('hash of the request');
  });

  it('refuse a text with a line break in the claim document of the dispute folder, so that the rule of plain text is the rule that holds for these texts', () => {
    const broken: ManifestClaim = { statements: [{ id: 'S1', text: 'A text with a\nline break.' }, PRIORAUTH_CLAIM.statements[1], PRIORAUTH_CLAIM.statements[2]] };
    expectRefused(claimDocument({ agent_did: AGENT, capability_id: PRIORAUTH_CAPABILITIES.draft, manifest_sha256: MANIFEST_SHA, claim: broken }), 'statements[0].text');
    expect(claimDocument({ agent_did: AGENT, capability_id: PRIORAUTH_CAPABILITIES.draft, manifest_sha256: MANIFEST_SHA, claim: PRIORAUTH_CLAIM }).ok).toBe(true);
  });
});

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const FOLDER = join(PACKAGE, 'src', 'priorauth');
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts'));

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The names that the folder must export. A later part of the folder adds names, so the test asks for these and allows more. */
const NAMES = [
  'ALTERED_SENTENCE', 'INTAKE_CLAIM', 'MAX_JUSTIFICATION_CHARS', 'PRIORAUTH_CAPABILITIES', 'PRIORAUTH_CLAIM', 'PRIORAUTH_MODELS', 'PRIORAUTH_REQUEST_SCHEMA', 'SECOND_ALTERED_SENTENCE',
  'alterJustification', 'parseGuideline', 'parsePriorAuthRequest', 'parseRecordSet', 'parseRequirementSet', 'recordSetSha256', 'requestNumberKey', 'requestNumberOf',
];

describe('the subpath @vsa/usecase-kit/priorauth', () => {
  it('is the folder src/priorauth, and it exports these values and the values of the later parts of the folder', () => {
    expect(byName.parsePriorAuthRequest).toBe(byPath.parsePriorAuthRequest);
    for (const name of NAMES) expect(Object.keys(byName), name).toContain(name);
    expect(Object.keys(byName).sort()).toStrictEqual(Object.keys(byPath).sort());
  });

  it('exports the helpers of the field rules to no one: they stay inside the folder', () => {
    for (const name of ['parseId', 'parseDay', 'parseText', 'parseList', 'parseIds', 'parseDiagnosisCodes', 'checkUnique', 'objectOf', 'isList', 'valuesOf']) expect(Object.keys(byName), name).not.toContain(name);
  });

  it('loads with Node type stripping and with tsx, and gives the same names', () => {
    // The folder is loaded in a new Node process on purpose: the test exercises the loading boundary, so a static import of vitest cannot stand in for it.
    const script = "const m = await import('@vsa/usecase-kit/priorauth'); console.log(Object.keys(m).sort().join(','));";
    const expected = Object.keys(byName).sort().join(',');
    expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe(expected);
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(expected);
  }, 60_000);
});

describe('the files of the folder', () => {
  it('include one file for each part', () => {
    for (const name of ['claims.ts', 'fault.ts', 'ids.ts', 'index.ts', 'records.ts', 'request.ts']) expect(files, name).toContain(name);
  });

  it.each(files)('%s imports the protocol folder and the files of this folder, and no other folder of the package', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const specifier = match[1]!;
      expect(specifier.startsWith('./') || specifier === '../protocol/index.ts', `${name} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files)('%s reads no environment variable and no file, makes no connection, and does not read the clock', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const forbidden of ['process.env', 'node:fs', 'readFileSync', 'writeFileSync', 'node:child_process', 'node:http', 'node:https', 'node:net', 'node:dns', 'fetch(', 'Date.now', 'new Date()', 'Math.random']) {
      expect(text.includes(forbidden), `${name} uses ${forbidden}`).toBe(false);
    }
  });
});
