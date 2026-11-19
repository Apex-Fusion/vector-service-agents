// The key files of the checks: read once, never printed, never in an error text. Each refusal has an accepted twin.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { verify, createPublicKey } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { buyerIdentityOf, decodeTransaction, enterpriseAddressOf, rawHexToBech32 } from '../lib/platform.ts';
import { bech32Decode } from '../lib/addresses.ts';
import { KeyFileError, KeyRing, parseKeyText, readKeyFile } from '../lib/keys.ts';
import { World } from './support/world.ts';

const dir = mkdtempSync(join(tmpdir(), 'checks-keys-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const seedHex = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);
const write = (name: string, text: string | Buffer, mode = 0o600): string => {
  const path = join(dir, name);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
};
const refusal = (run: () => unknown): KeyFileError => {
  try { run(); } catch (err) { if (err instanceof KeyFileError) return err; throw err; }
  throw new Error('the call did not refuse');
};

describe('bech32Decode', () => {
  it('reads the bech32 of a signing key back to its 32 bytes', () => {
    for (const n of [1, 2, 3, 200]) {
      const decoded = bech32Decode(rawHexToBech32(seedHex(n)));
      expect(decoded?.hrp).toBe('ed25519_sk');
      expect(Buffer.from(decoded!.bytes).toString('hex')).toBe(seedHex(n));
    }
  });
  it('refuses a wrong checksum, mixed case and characters outside the alphabet', () => {
    const good = rawHexToBech32(seedHex(1));
    const flipped = `${good.slice(0, -1)}${good.endsWith('q') ? 'p' : 'q'}`;
    expect(bech32Decode(flipped)).toBeNull();
    expect(bech32Decode(`${good.slice(0, 12)}${good.slice(12).toUpperCase()}`)).toBeNull();
    expect(bech32Decode(`${good.slice(0, -1)}b`)).toBeNull();
    expect(bech32Decode('not bech32')).toBeNull();
    expect(bech32Decode(good)).not.toBeNull();
  });
});

describe('parseKeyText', () => {
  const identity = buyerIdentityOf(seedHex(7));
  it('reads a raw 64-hex key', () => {
    const key = parseKeyText(`${seedHex(7)}\n`, 'member');
    expect(key.keyHash).toBe(identity.buyerPkh);
    expect(key.address).toBe(identity.address);
    expect(key.role).toBe('member');
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });
  it('reads a bech32 key, alone or in a NAME=value line, to the same key', () => {
    const bech32 = rawHexToBech32(seedHex(7));
    for (const text of [bech32, `VECTOR_SIGNER_PRIVATE_KEY=${bech32}`, `SOME_NAME="${bech32}"\n`, `# a comment\n\nVECTOR_SIGNER_PRIVATE_KEY=${bech32}\n`]) {
      expect(parseKeyText(text, 'agent').keyHash, text.length.toString()).toBe(identity.buyerPkh);
    }
  });
  it('takes the address of the file for the wallet when it belongs to the key, and refuses another one', () => {
    const bech32 = rawHexToBech32(seedHex(7));
    const own = enterpriseAddressOf(identity.buyerPkh);
    expect(parseKeyText(`VECTOR_SIGNER_PRIVATE_KEY=${bech32}\nVECTOR_SIGNER_ADDRESS=${own}\n`, 'agent').address).toBe(own);
    const other = enterpriseAddressOf(buyerIdentityOf(seedHex(8)).buyerPkh);
    expect(refusal(() => parseKeyText(`VECTOR_SIGNER_PRIVATE_KEY=${bech32}\nVECTOR_SIGNER_ADDRESS=${other}\n`, 'agent')).reason).toBe('address_mismatch');
  });
  it('reads a file that an editor wrote: a byte-order mark, UTF-16 and CRLF', () => {
    const line = `VECTOR_SIGNER_PRIVATE_KEY=${rawHexToBech32(seedHex(7))}\r\nVECTOR_SIGNER_ADDRESS=${identity.address}\r\n`;
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, 'utf16le')]);
    const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line, 'utf8')]);
    for (const bytes of [utf16, utf8Bom, Buffer.from(line, 'utf8')]) expect(parseKeyText(bytes, 'member').keyHash).toBe(identity.buyerPkh);
  });
  it('refuses a file with no key, with two keys, with an extended key and with a short key, and never repeats what the file holds', () => {
    const one = rawHexToBech32(seedHex(1));
    const two = rawHexToBech32(seedHex(2));
    const cases: Array<[string, string, string]> = [
      ['no_key', 'VECTOR_SIGNER_ADDRESS=addr1abc\n', 'no key'],
      ['more_than_one_key', `${one}\n${two}\n`, 'two keys'],
      ['extended_key', `ed25519e_sk1${'q'.repeat(60)}`, 'extended'],
      ['no_key', seedHex(1).slice(0, 62), 'short'],
      ['no_key', 'ed25519_sk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'bad bech32'],
    ];
    for (const [reason, text, what] of cases) {
      const err = refusal(() => parseKeyText(text, 'member'));
      expect(err.reason, what).toBe(reason);
      expect(err.message).not.toContain(one);
      expect(err.message).not.toContain(two);
      expect(err.message).not.toContain(seedHex(1));
      expect(err.message).toContain('member key');
    }
  });
  it('refuses a bech32 key whose checksum is wrong without saying the key', () => {
    const good = rawHexToBech32(seedHex(3));
    const bad = `${good.slice(0, -1)}${good.endsWith('q') ? 'p' : 'q'}`;
    const err = refusal(() => parseKeyText(bad, 'agent'));
    expect(err.message).not.toContain(bad);
    expect(err.message).not.toContain(good.slice(10, 30));
  });
});

describe('a loaded key', () => {
  const key = parseKeyText(`VECTOR_SIGNER_PRIVATE_KEY=${rawHexToBech32(seedHex(9))}`, 'member');
  it('shows nothing of the secret when it is written as JSON, as text or inspected', () => {
    const shown = [JSON.stringify(key), String(key), inspect(key, { depth: 5, showHidden: true }), JSON.stringify({ key }), `${key}`];
    for (const text of shown) {
      expect(text).not.toContain(seedHex(9));
      expect(text).not.toContain(rawHexToBech32(seedHex(9)));
      expect(text).toContain(key.keyHash);
    }
  });
  it('signs a transaction with a witness that verifies, and keeps the body as it is', async () => {
    const world = await World.create([{ n: 9 }]);
    const built = await world.simplePayment(key.address, 2_000_000n);
    const signed = key.signTransaction(built.unsignedCbor);
    expect(signed.txHashHex).toBe(built.txHash);
    const tx = decodeTransaction(signed.signedCborHex);
    expect(tx.body().to_cbor_hex()).toBe(decodeTransaction(built.unsignedCbor).body().to_cbor_hex());
    const witnesses = tx.witness_set().vkeywitnesses();
    expect(witnesses?.len()).toBe(1);
    const witness = witnesses!.get(0);
    expect(Buffer.from(witness.vkey().to_raw_bytes()).toString('hex')).toBe(key.publicKeyHex);
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(key.publicKeyHex, 'hex')]);
    expect(verify(null, Buffer.from(built.txHash, 'hex'), createPublicKey({ key: spki, format: 'der', type: 'spki' }), Buffer.from(witness.ed25519_signature().to_raw_bytes()))).toBe(true);
  });
});

describe('readKeyFile', () => {
  it('reads a file with mode 600', () => {
    expect(readKeyFile(write('ok.key', seedHex(5)), 'agent').keyHash).toBe(buyerIdentityOf(seedHex(5)).buyerPkh);
  });
  it('refuses a file that other users can read, and says how to fix it, without a word of what it holds', () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660]) {
      const path = write(`open-${mode.toString(8)}.key`, seedHex(5), mode);
      const err = refusal(() => readKeyFile(path, 'agent'));
      expect(err.reason).toBe('mode');
      expect(err.message).toContain('mode 600');
      expect(err.message).not.toContain(seedHex(5));
    }
  });
  it('refuses a file that is not there, and a path that is a folder', () => {
    expect(refusal(() => readKeyFile(join(dir, 'missing.key'), 'member')).reason).toBe('unreadable');
    expect(refusal(() => readKeyFile(dir, 'member')).reason).toBe('unreadable');
  });
  it('reads the file once', () => {
    const path = write('once.key', seedHex(6));
    const reads: string[] = [];
    const key = readKeyFile(path, 'member', { read: (p) => { reads.push(p); return Buffer.from(seedHex(6)); } });
    expect(key.role).toBe('member');
    expect(reads).toEqual([path]);
  });
});

describe('KeyRing', () => {
  const member = parseKeyText(seedHex(1), 'member');
  const agent = parseKeyText(seedHex(2), 'agent');
  const controller = parseKeyText(seedHex(3), 'controller');
  it('knows the keys by hash and by role, and the wallet of each', () => {
    const ring = new KeyRing([member, agent, controller]);
    expect(ring.has(member.keyHash)).toBe(true);
    expect(ring.has('00'.repeat(28))).toBe(false);
    expect(ring.get('agent')).toBe(agent);
    expect([...ring.keyHashes()].sort()).toEqual([member.keyHash, agent.keyHash, controller.keyHash].sort());
    expect(ring.wallets().get(agent.keyHash)).toBe(agent.address);
  });
  it('refuses two keys for one role and two files with the same key', () => {
    expect(() => new KeyRing([member, parseKeyText(seedHex(4), 'member')])).toThrow(/one key for each role/);
    expect(() => new KeyRing([member, parseKeyText(seedHex(1), 'agent')])).toThrow(/same key/);
  });
  it('signs only for a key that it holds', async () => {
    const world = await World.create([{ n: 1 }]);
    const built = await world.simplePayment(member.address, 2_000_000n);
    const ring = new KeyRing([member, agent]);
    expect(decodeTransaction(ring.sign(member.keyHash, built.unsignedCbor)).witness_set().vkeywitnesses()?.len()).toBe(1);
    expect(() => ring.sign('00'.repeat(28), built.unsignedCbor)).toThrow(/no key/);
  });
});
