// Where the sources of this package decode CBOR (src/, the vendored copies included). A datum from the chain is decoded through `@vsa/vector-read`, whose decoders run the
// check of its cbor-depth.ts first, or through a copy that runs the check itself. This test reads src/ and names each file that calls a decoder of CML, or Lucid's Data.from,
// by itself, with the reason that the call is safe. A file that is not named fails. The rule: refuse CBOR that is nested deeper than 64 levels before it is decoded.
// (The same test, for the sources of packages/vector-read, is in that package.)
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = fileURLToPath(new URL('../src', import.meta.url));
/** The calls that decode CBOR that was not built here: the decoders of CML, Lucid's Data.from and Lucid's fromTx. */
const DECODER_CALL = /\b(?:from_cbor_hex|from_cbor_bytes)\s*\(|\bData\.from\s*\(|\bfromTx\s*\(/;

/** The files that call a decoder by themselves, and why each call is safe. The number is how many calls the file makes. */
const MAY_CALL_DECODERS: Record<string, { calls: number; why: string }> = {
  'chain.ts': { calls: 1, why: 'reads the time to live of the unsigned transaction that a builder of this process made with Lucid: no chain data reaches it' },
  'fees.ts': { calls: 1, why: 'reads the fee of the signed transaction that the signer of this process made: no chain data reaches it' },
  'vendored/mcp/marketplace-build.ts': {
    calls: 1,
    why: 'reads the outputs of the Post transaction that the builder of this process made, to check the first one: no chain data reaches it. This copy is at the pin before the CBOR check (see VENDORED-FROM.md)',
  },
  'vendored/signer/sign.ts': { calls: 1, why: 'the check of the bytes runs first, in the same block (assertCborHexDepth)' },
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The code of a source file: its comments are taken out, so that a sentence about a decoder is not a call. */
function codeOf(path: string): string {
  // Line comments go first: a `/*` inside a line comment (a path such as `lib/*.ak`) does not open a block comment.
  return readFileSync(path, 'utf8').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

const files = new Map(sourceFiles(SOURCES).map((path) => [relative(SOURCES, path).split('\\').join('/'), codeOf(path)] as const));
const callsIn = (file: string): number => files.get(file)!.split('\n').filter((line) => DECODER_CALL.test(line)).length;
const count = (file: string, pattern: RegExp): number => files.get(file)!.split('\n').filter((line) => pattern.test(line)).length;

describe('the sources decode CBOR by themselves only where the call is named', () => {
  it('no other file calls a decoder of CML or Lucid', () => {
    const others = [...files].flatMap(([file, code]) => (file in MAY_CALL_DECODERS ? [] : code.split('\n').flatMap((line, i) => (DECODER_CALL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))));
    expect(others, 'these lines decode CBOR by themselves: read the datum through @vsa/vector-read, or name the file here with the reason').toStrictEqual([]);
  });

  it('each named file makes the number of calls that is named, and gives a reason', () => {
    for (const [file, { calls, why }] of Object.entries(MAY_CALL_DECODERS)) {
      expect(files.has(file), `${file} is a source file`).toBe(true);
      expect(callsIn(file), `${file} calls ${calls} decoder(s): change the name here`).toBe(calls);
      expect(why.length, file).toBeGreaterThan(20);
    }
  });
});

describe('the copies that read chain data check it first', () => {
  it('the signer checks the bytes of the transaction before CML reads them', () => {
    const code = files.get('vendored/signer/sign.ts')!;
    expect(code).toMatch(/from '@vsa\/vector-read\/cbor-depth';/);
    expect(code.indexOf("assertCborHexDepth(unsignedCborHex, { what: 'The transaction', kind: 'transaction' })")).toBeGreaterThan(0);
    expect(code.indexOf('assertCborHexDepth(')).toBeLessThan(code.indexOf('CML.Transaction.from_cbor_hex('));
  });

  it('the provider checks the inline datum of each output that it maps, and the datum that it looks up by a hash', () => {
    const code = files.get('vendored/mcp-shared/provider.ts')!;
    expect(code).toMatch(/from '@vsa\/vector-read\/cbor-depth';/);
    expect(count('vendored/mcp-shared/provider.ts', /\bassertCborHexDepth\(/), 'the check is made in readableDatum and in getDatum').toBe(2);
    // The Ogmios answer and the Koios row each go through readableDatum; the lookup by hash is checked before it returns.
    expect(count('vendored/mcp-shared/provider.ts', /datum = readableDatum\(datum, /)).toBe(1);
    expect(count('vendored/mcp-shared/provider.ts', /const datum = readableDatum\(koiosUtxo\.inline_datum\?\.bytes \|\| null, ref, withheld\);/)).toBe(1);
    expect(code).toMatch(/async getDatum\([\s\S]*?assertCborHexDepth\(bytes[\s\S]*?return bytes;/);
  });

  it('the configuration record is read through decodePlutusData of @vsa/vector-read', () => {
    const code = files.get('vendored/mcp/identity-deployment.ts')!;
    expect(code).toMatch(/import \{ decodePlutusData \} from '@vsa\/vector-read\/guarded-decode';/);
    expect(count('vendored/mcp/identity-deployment.ts', /\bdecodePlutusData\(/)).toBe(1);
  });
});
