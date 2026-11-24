// The names that the operator pack takes from the entry of buyer-core, from the kit and from the fakes of the checks, and the schemas of the hosted tools that the pack calls. A name that is not there is undefined, so the call or the type check fails.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envelopeSigStructure, envelopeVerifies } from '../../../packages/buyer-core/src/index.ts';
import type { EnvelopeFields } from '../../../packages/buyer-core/src/index.ts';
import { parseKeyText } from '../../checks/lib/keys.ts';
import { FakeClock, FakeNode, MemoryOutput, ThrowingSigner, World } from './support/fakes.ts';
import * as kitBids from '../../../packages/usecase-kit/src/bids/index.ts';
import * as kitPriorauth from '../../../packages/usecase-kit/src/priorauth/index.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { AGENT_KINDS, BID_CAPABILITIES, BID_DESK_CLAIM, INTAKE_CLAIM, PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, SOURCING_CLAIM } from '../lib/platform.ts';
import type { AgentKind } from '../lib/platform.ts';
import { PACK_CAPTURE, PACK_SCHEMAS, PackHosted } from './support/pack-hosted.ts';

/** The envelope that the tests of buyer-core call GOLDEN.registered. OpenSSL signed it with a key that was made for the purpose, so the values are public. */
const FIELDS: EnvelopeFields = {
  issuer: '48075a597e721a156e2e0799de5cc0c5324dc6e7eaf1cdd46250868ec53215dd', issuerId: '5c'.repeat(32), subject: '7a'.repeat(32), issuedAt: 1_795_000_000_000, format: 50, digest: '3e'.repeat(32),
};
const SIGNATURE = '1eaaf285ca048878e99b29fdbd7c5e7bef255616c22c434789bbbf69a8bd0bc1e8c329eee5d440d54eaa69f015f8e14afe138c711a39ab54d269a170be089107';

describe('the envelope names of the buyer-core entry', () => {
  it('envelopeSigStructure gives the Sig_structure of the envelope as hex: an array of four items that starts with the text Signature1', () => {
    const structure = envelopeSigStructure(FIELDS);
    expect(structure).toMatch(/^[0-9a-f]+$/);
    expect(structure.startsWith('846a5369676e617475726531')).toBe(true);
    expect(envelopeSigStructure({ ...FIELDS })).toBe(structure);
    expect(envelopeSigStructure({ ...FIELDS, digest: '3f'.repeat(32) })).not.toBe(structure);
  });
  it('envelopeVerifies accepts the golden signature, and refuses it for another digest, for a changed byte and for a text that is no signature', () => {
    expect(envelopeVerifies(FIELDS, SIGNATURE)).toBe(true);
    expect(envelopeVerifies({ ...FIELDS, digest: '3f'.repeat(32) }, SIGNATURE)).toBe(false);
    expect(envelopeVerifies(FIELDS, `${SIGNATURE.slice(0, -1)}${SIGNATURE.endsWith('0') ? '1' : '0'}`)).toBe(false);
    expect(envelopeVerifies(FIELDS, 'not a signature')).toBe(false);
  });
  it('envelopeVerifies accepts a signature that LoadedKey.signMessage makes over the Sig_structure, and only for the key of the issuer', () => {
    const issuer = parseKeyText(randomBytes(32).toString('hex'), 'provider');
    const fields: EnvelopeFields = { ...FIELDS, issuer: issuer.publicKeyHex };
    const signature = issuer.signMessage(Buffer.from(envelopeSigStructure(fields), 'hex'));
    expect(envelopeVerifies(fields, signature)).toBe(true);
    expect(envelopeVerifies({ ...fields, issuer: parseKeyText(randomBytes(32).toString('hex'), 'other').publicKeyHex }, signature)).toBe(false);
    expect(envelopeVerifies({ ...fields, issuedAt: fields.issuedAt + 1000 }, signature)).toBe(false);
  });
});

describe('the shared fakes', () => {
  it('re-export the fakes of the checks that the tests of the pack use', () => {
    expect([FakeClock, FakeNode, MemoryOutput, ThrowingSigner, World].map((fake) => typeof fake)).toEqual(['function', 'function', 'function', 'function', 'function']);
  });
});

describe('the claims, the capabilities and the kinds that the pack takes from the kit', () => {
  it('gives the claim of each of the four agents of use cases 2 and 3: the claim of the kit itself, with the statements S1, S2 and S3', () => {
    expect(PRIORAUTH_CLAIM).toBe(kitPriorauth.PRIORAUTH_CLAIM);
    expect(INTAKE_CLAIM).toBe(kitPriorauth.INTAKE_CLAIM);
    expect(SOURCING_CLAIM).toBe(kitBids.SOURCING_CLAIM);
    expect(BID_DESK_CLAIM).toBe(kitBids.BID_DESK_CLAIM);
    const claims = [PRIORAUTH_CLAIM, INTAKE_CLAIM, SOURCING_CLAIM, BID_DESK_CLAIM];
    for (const claim of claims) expect(claim.statements.map((statement) => statement.id)).toEqual(['S1', 'S2', 'S3']);
    expect(new Set(claims.flatMap((claim) => claim.statements.map((statement) => statement.text))).size).toBe(12);
  });
  it('gives the capability of each agent: the two of use case 2 and the two of use case 3', () => {
    expect(PRIORAUTH_CAPABILITIES).toEqual({ draft: 'health.priorauth.draft.v1', intake: 'health.priorauth.intake.v1' });
    expect(BID_CAPABILITIES).toEqual({ evaluate: 'supplychain.rfq.evaluate.v1', quote: 'supplychain.rfq.quote.v1' });
  });
  it('gives the six kinds of agent in the order of the kit, and a value of the type AgentKind is one of them', () => {
    expect([...AGENT_KINDS]).toEqual(['reorder-agent', 'prior-authorization-agent', 'sourcing-agent', 'order-desk', 'insurer-intake-agent', 'bid-desk']);
    const kinds: readonly AgentKind[] = AGENT_KINDS;
    expect(new Set(kinds).size).toBe(6);
  });
});

describe('the hosted schemas of the pack', () => {
  const ADDRESS = 'addr1qtest';
  const DID = `did:vector:${'ab'.repeat(32)}`;
  const HEX = 'cd'.repeat(32);
  /** The ten tools that end, retire, reclaim, revoke, recover or hand over a record, or revoke or contest an attestation, each with the arguments that a call needs and no other. */
  const TEN: readonly (readonly [string, Record<string, unknown>])[] = [
    ['vector_build_identity_end_subagents', { changeAddress: ADDRESS, did: DID }],
    ['vector_build_identity_revoke', { changeAddress: ADDRESS, did: DID, reason: 9 }],
    ['vector_build_identity_change_controller', { changeAddress: ADDRESS, did: DID, new_controller: HEX }],
    ['vector_build_identity_recovery_start', { changeAddress: ADDRESS, did: DID, new_controller: HEX, guardians: [0, 1] }],
    ['vector_build_identity_recovery_complete', { changeAddress: ADDRESS, did: DID }],
    ['vector_build_identity_retire', { changeAddress: ADDRESS, did: DID }],
    ['vector_build_identity_set_successor', { changeAddress: ADDRESS, did: DID, successor: DID }],
    ['vector_build_identity_reclaim', { changeAddress: ADDRESS, did: DID }],
    ['vector_build_attestation_revoke', { changeAddress: ADDRESS, attestation: HEX }],
    ['vector_build_attestation_contest', { changeAddress: ADDRESS, attestation: HEX, uri: 'https://agent.example/reply.json', sha256: HEX }],
  ];
  it('hold the input schema of each of the ten tools, and the arguments that the schema requires are the arguments that the tool needs', () => {
    for (const [name, args] of TEN) {
      const schema = PACK_SCHEMAS[name];
      expect(schema?.type, name).toBe('object');
      expect([...(schema?.required ?? [])].sort(), name).toEqual(Object.keys(args).sort());
    }
    expect(PACK_CAPTURE.tools_listed).toBeGreaterThanOrEqual(87);
    expect(PACK_CAPTURE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('let a call with the arguments that the tool needs pass, and refuse a call with a stray argument and a call that lacks one', async () => {
    for (const [name, args] of TEN) {
      const hosted = new PackHosted({ [name]: () => ({}) });
      await expect(hosted.call(name, args), name).resolves.toMatchObject({ failed: false });
      await expect(hosted.call(name, { ...args, stray: 1 }), name).rejects.toBeInstanceOf(HostedError);
      for (const missing of Object.keys(args)) {
        const rest = Object.fromEntries(Object.entries(args).filter(([key]) => key !== missing));
        await expect(hosted.call(name, rest), `${name} without ${missing}`).rejects.toBeInstanceOf(HostedError);
      }
      expect(hosted.calls).toHaveLength(1);
    }
  });
  it('hold the limit of the window of a build: 59 minutes pass and 60 are refused', async () => {
    const [name, args] = TEN[0]!;
    const hosted = new PackHosted({ [name]: () => ({}) });
    await expect(hosted.call(name, { ...args, valid_minutes: 59 })).resolves.toMatchObject({ failed: false });
    await expect(hosted.call(name, { ...args, valid_minutes: 60 })).rejects.toBeInstanceOf(HostedError);
  });
});
