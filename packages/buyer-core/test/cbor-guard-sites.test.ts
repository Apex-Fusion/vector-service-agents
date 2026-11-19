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

  it('the vault Pay, the delegation builders and what they build on read a transaction and an address through the checked wrappers, and none calls the address decoder of Lucid', () => {
    // These copies are at 2d95483. The datums they read come through @vsa/vector-read/identity-codec, which runs the check first.
    const copies = ['vault-build', 'delegation-build', 'identity-build', 'attestation-build', 'marketplace-build'].map((name) => `vendored/mcp/${name}.ts`);
    for (const file of copies) expect(count(file, /\bgetAddressDetails\s*\(/), `${file} calls the address decoder of Lucid`).toBe(0);
    expect(files.get('vendored/mcp/vault-build.ts')!).toMatch(/import \{ addressDetails \} from '@vsa\/vector-read\/guarded-decode';/);
    for (const file of ['identity-build', 'attestation-build', 'marketplace-build'].map((name) => `vendored/mcp/${name}.ts`)) {
      expect(files.get(file)!, file).toMatch(/import \{ decodeTransaction \} from '@vsa\/vector-read\/guarded-decode';/);
    }
  });
});

// The checked wrappers of @vsa/vector-read/guarded-decode read a datum, a transaction, a metadatum or an address after the scanner of cbor-depth has checked
// the bytes, and the copies call the scanner too. The copies call them in the places below. A re-vendor that adds a call, and a file that is not named, fail
// here until the call is named with what it reads.

/** The calls of a checked wrapper, and of the scanner itself. */
const CHECKED_CALL = /\b(?:decodePlutusData|decodeTransaction|decodeMetadatum|addressDetails|assertCborHexDepth|assertCborDepth)\s*\(/;

const OWN_TRANSACTION = 'a transaction that a builder of this process made: no chain data reaches it';
/** The files that call a checked wrapper or the scanner, how many lines call one, and what the calls read. */
const CHECKED_CALLS: Record<string, { calls: number; reads: string }> = {
  'chain.ts': { calls: 1, reads: `the supplier, the output and the collateral of ${OWN_TRANSACTION} (the Pay of a vault, which the node evaluated)` },
  'vendored/mcp/attestation-build.ts': { calls: 2, reads: `the outputs of ${OWN_TRANSACTION} (the deposit, and the output of the attestation)` },
  'vendored/mcp/attestation-read.ts': { calls: 1, reads: 'the datum of an attestation output, which comes from the chain' },
  'vendored/mcp/gov-build.ts': { calls: 1, reads: 'an address that a caller gives' },
  'vendored/mcp/identity-build.ts': { calls: 2, reads: `the outputs of ${OWN_TRANSACTION}` },
  'vendored/mcp/identity-deployment.ts': { calls: 1, reads: 'the datum of the configuration record, which comes from the chain' },
  'vendored/mcp/jury-chain.ts': { calls: 2, reads: `the first input of ${OWN_TRANSACTION}; and the address of an output, which comes from the chain` },
  'vendored/mcp/jury-codec.ts': { calls: 1, reads: 'a datum of Module-1 or of the jury, which comes from the chain' },
  'vendored/mcp/jury-document.ts': { calls: 2, reads: 'the transaction that Koios gives for a document, and the metadata that Blockfrost gives: both come from the chain' },
  'vendored/mcp/marketplace-build.ts': { calls: 1, reads: `the first output of ${OWN_TRANSACTION} (the escrow of a Post)` },
  'vendored/mcp/marketplace-indexer.ts': { calls: 1, reads: 'the inline datum of a Koios row, which comes from the chain: a row that fails the scan loses its datum' },
  'vendored/mcp/marketplace-lineage.ts': { calls: 1, reads: 'the address of an output of an escrow lineage, which comes from the chain' },
  'vendored/mcp/module1-build.ts': { calls: 1, reads: `the first output of ${OWN_TRANSACTION} (the payout of a withdrawal)` },
  'vendored/mcp/vault-build.ts': { calls: 1, reads: 'the address of a vault output, which comes from the node' },
  'vendored/mcp-shared/provider.ts': { calls: 2, reads: 'the inline datum of an output, and a datum that is looked up by its hash: both come from the node or Koios (the test above names the places)' },
  'vendored/signer/sign.ts': { calls: 1, reads: 'the unsigned transaction that the signer is given (the test above names the order)' },
};

describe('the copies call a checked wrapper or the scanner only where the call is named', () => {
  it('no other file calls one', () => {
    const others = [...files].flatMap(([file, code]) => (file in CHECKED_CALLS ? [] : code.split('\n').flatMap((line, i) => (CHECKED_CALL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))));
    expect(others, 'these lines read bytes through a checked wrapper: name the file here with what it reads').toStrictEqual([]);
  });

  it('each named file makes the number of calls that is named, says what they read, and takes the wrapper or the scanner from @vsa/vector-read', () => {
    for (const [file, { calls, reads }] of Object.entries(CHECKED_CALLS)) {
      expect(files.has(file), `${file} is a source file`).toBe(true);
      expect(count(file, CHECKED_CALL), `${file} makes ${calls} call(s): change the name here`).toBe(calls);
      expect(reads.length, file).toBeGreaterThan(20);
      expect(files.get(file)!, `${file} takes the wrapper or the scanner from @vsa/vector-read`).toMatch(/from '@vsa\/vector-read\/(?:guarded-decode|cbor-depth)';/);
    }
  });
});
