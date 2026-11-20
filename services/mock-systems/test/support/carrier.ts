// services/mock-systems/test/support/carrier.ts
// A certificate that a caller makes for itself. A new key signs it, so no authority of a bundle issued it. It has one extension that holds a text. When the text is the PEM text of another
// certificate, the reader of Node finds that text in the bytes and reads the certificate inside, in place of the one that came. Only a few pieces of DER are needed, so they are written here.
import { generateKeyPairSync, sign } from 'node:crypto';

const tlv = (tag: number, ...content: Buffer[]): Buffer => {
  const body = Buffer.concat(content);
  if (body.length > 0xffff) throw new Error('this encoder writes lengths up to 65535');
  const length = body.length < 0x80 ? [body.length] : body.length < 0x100 ? [0x81, body.length] : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
};
const sequence = (...items: Buffer[]): Buffer => tlv(0x30, ...items);
const set = (...items: Buffer[]): Buffer => tlv(0x31, ...items);
const integer = (value: number): Buffer => tlv(0x02, Buffer.from([value]));
const utf8String = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
const octetString = (bytes: Buffer): Buffer => tlv(0x04, bytes);
const bitString = (bytes: Buffer): Buffer => tlv(0x03, Buffer.from([0]), bytes);
const explicit = (tagNumber: number, inner: Buffer): Buffer => tlv(0xa0 | tagNumber, inner);

/** An object identifier, from its dotted text. */
function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const arc = (value: number): number[] => {
    const bytes = [value & 0x7f];
    for (let more = value >> 7; more > 0; more >>= 7) bytes.unshift((more & 0x7f) | 0x80);
    return bytes;
  };
  return tlv(0x06, Buffer.from([first! * 40 + second!, ...rest.flatMap(arc)]));
}

/** A UTCTime, `YYMMDDHHMMSSZ`. */
const utcTime = (ms: number): Buffer => tlv(0x17, Buffer.from(new Date(ms).toISOString().replace(/^\d\d|[-:T]|\.\d{3}/g, ''), 'ascii'));

const ECDSA_SHA256 = sequence(oid('1.2.840.10045.4.3.2'));
/** The identifier of the extension that holds the text: a private one, that no reader knows. */
const TEXT_EXTENSION = oid('1.3.6.1.4.1.99999.1');

/** The PEM text of a certificate. */
export const pemOf = (der: Buffer): string => `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

/**
 * The DER bytes of a certificate of version 3 that a new key signs. It is valid from one minute before `nowMs` for one hour, and it holds `text` in an extension. The text starts on a line of
 * its own, because the PEM reader of OpenSSL skips every line before the line that begins a block.
 */
export function carrierCertificate(text: string, nowMs: number): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const name = sequence(set(sequence(oid('2.5.4.3'), utf8String('a certificate that carries a text'))));
  const tbs = sequence(
    explicit(0, integer(2)), integer(1), ECDSA_SHA256, name, sequence(utcTime(nowMs - 60_000), utcTime(nowMs + 3_600_000)), name, publicKey.export({ format: 'der', type: 'spki' }),
    explicit(3, sequence(sequence(TEXT_EXTENSION, octetString(utf8String(`\n${text}`))))),
  );
  return sequence(tbs, ECDSA_SHA256, bitString(sign('sha256', tbs, privateKey)));
}
