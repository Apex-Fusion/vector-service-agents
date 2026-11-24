// The names that the operator pack takes from the entry of buyer-core and from the fakes of the checks. A name that is not there is undefined, so the call or the type check fails.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { envelopeSigStructure, envelopeVerifies } from '../../../packages/buyer-core/src/index.ts';
import type { EnvelopeFields } from '../../../packages/buyer-core/src/index.ts';
import { parseKeyText } from '../../checks/lib/keys.ts';
import { FakeClock, FakeNode, MemoryOutput, ThrowingSigner, World } from './support/fakes.ts';

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
