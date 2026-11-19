// Where the sources of this package decode CBOR that comes from the chain. This test reads src/ and names each place. A datum, a transaction and metadata are
// decoded through the wrappers of guarded-decode.ts, which run the check of cbor-depth.ts first, so no other file may call a decoder of CML, or Lucid's Data.from.
// Each call of a wrapper is named below, with the function that makes it: a call that is not named fails this test, and so does a name with no call. The
// decoders of agents-marketplace are plain TypeScript, and src/identity.ts is the one file that gives them to the other packages, each behind the same check.
// (The same test, for the sources of the other packages, is in packages/buyer-core/test and agents/agent-history/test.)
import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = fileURLToPath(new URL('../src', import.meta.url));
/** The calls that decode CBOR that was not built here: the decoders of CML, Lucid's Data.from and Lucid's fromTx. */
const DECODER_CALL = /\b(?:from_cbor_hex|from_cbor_bytes)\s*\(|\bData\.from\s*\(|\bfromTx\s*\(/;

/** The files that call a decoder, and why. */
const MAY_CALL_DECODERS: Record<string, string> = {
  'guarded-decode.ts': 'the wrappers: each one checks the bytes first',
};

/** The functions that read a datum through decodePlutusData, by file. Each name is one decode site. */
const DATUM_SITES: Record<string, string[]> = {
  'datum.ts': [
    'decodeAdvertDatum', 'decodeIdentityAdvertDatum', 'decodeAnyAdvertDatum', 'advertTextFieldsRoundTrip', 'decodeEscrowDatum', 'decodeIdentityEscrowDatum',
    'decodeAnyEscrowDatum', 'identityEscrowDatumToData', 'topLevelBytes',
  ],
  'identity-codec.ts': ['parse'],
  'reputation-datum.ts': ['decodeStakeDatum', 'decodeStakeParams', 'decodeCrossRefs'],
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

const files = sourceFiles(SOURCES).map((path) => ({ file: relative(SOURCES, path).split('\\').join('/'), code: codeOf(path) }));

/** The top-level function that holds each line that matches `call`, in file order. */
function functionsThatCall(code: string, call: RegExp): string[] {
  const names: string[] = [];
  let current = '';
  for (const line of code.split('\n')) {
    const declaration = /^(?:export )?(?:async )?function (\w+)/.exec(line);
    if (declaration) current = declaration[1];
    if (call.test(line)) names.push(current);
  }
  return names;
}

describe('the sources decode CBOR through guarded-decode.ts', () => {
  test('no other file calls a decoder of CML or Lucid by itself', () => {
    const others = files.flatMap(({ file, code }) => (file in MAY_CALL_DECODERS ? [] : code.split('\n').flatMap((line, i) => (DECODER_CALL.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : []))));
    expect(others, 'these lines decode CBOR by themselves; use decodePlutusData, decodeTransaction or decodeMetadatum').toStrictEqual([]);
  });

  test('each file that may call a decoder does call one', () => {
    for (const file of Object.keys(MAY_CALL_DECODERS)) {
      expect(files.find((f) => f.file === file)?.code.split('\n').some((line) => DECODER_CALL.test(line)), `${file} calls no decoder: take it out of MAY_CALL_DECODERS`).toBe(true);
    }
  });

  test('each wrapper checks the bytes before it calls its decoder, and the file has no other decoder call', () => {
    const code = files.find((f) => f.file === 'guarded-decode.ts')!.code;
    const functions = new Map(code.split(/\nexport function /).slice(1).map((part) => [part.slice(0, part.indexOf('(')), part] as const));
    for (const [wrapper, check, decoder] of [
      ['decodeTransaction', 'assertCborHexDepth(', 'CML.Transaction.from_cbor_hex('],
      ['decodePlutusData', 'assertPlutusDataHex(', 'Data.from('],
      ['decodeMetadatum', 'assertCborDepth(', 'CML.TransactionMetadatum.from_cbor_bytes('],
    ] as const) {
      const body = functions.get(wrapper);
      expect(body, `${wrapper} is exported`).toBeDefined();
      expect(body!.includes(check) && body!.includes(decoder) && body!.indexOf(check) < body!.indexOf(decoder), `${wrapper} calls ${check} before ${decoder}`).toBe(true);
    }
    expect(code.split(DECODER_CALL).length, 'guarded-decode.ts calls three decoders, one in each wrapper').toBe(4);
  });
});

describe('each place that reads a datum from the chain is named', () => {
  test('the calls of decodePlutusData are the named functions, in the three codec files and in no other', () => {
    const found: Record<string, string[]> = {};
    for (const { file, code } of files) {
      if (file === 'guarded-decode.ts' || file.startsWith('vendored/')) continue; // the wrappers, and the plain TypeScript decoders of agents-marketplace (own test below)
      const names = functionsThatCall(code, /\bdecodePlutusData\s*\(/);
      if (names.length > 0) found[file] = names;
    }
    expect(Object.keys(found).sort()).toStrictEqual(Object.keys(DATUM_SITES).sort());
    for (const [file, names] of Object.entries(DATUM_SITES)) {
      expect([...new Set(found[file])].sort(), file).toStrictEqual([...names].sort());
    }
  });

  test('decodePlutusData is called nine times in datum.ts, once in identity-codec.ts and three times in reputation-datum.ts', () => {
    const count = (file: string) => functionsThatCall(files.find((f) => f.file === file)!.code, /\bdecodePlutusData\s*\(/).length;
    expect([count('datum.ts'), count('identity-codec.ts'), count('reputation-datum.ts')]).toStrictEqual([9, 1, 3]);
  });

  test('each of those files imports decodePlutusData from guarded-decode.ts', () => {
    for (const file of Object.keys(DATUM_SITES)) {
      expect(files.find((f) => f.file === file)!.code, file).toMatch(/import \{[^}]*\bdecodePlutusData\b[^}]*\} from '\.\/guarded-decode\.js';/);
    }
  });
});

describe('the plain TypeScript decoders of agents-marketplace', () => {
  const VENDORED_DECODERS = /\b(?:decodeIdentityDatum|decodeLegacyDatum|decodePlutusDataHex)\b/;

  test('only src/identity.ts imports them from the vendored files, and it wraps each one with the check', () => {
    const importing = files.filter(({ code }) => /from '\.\/vendored\/shared\/cbor\/(?:IdentityDatum|plutus-data)\.ts'/.test(code) && code.split('\n').some((line) => /^import \{[^}]*\b(?:decodeIdentityDatum|decodeLegacyDatum|decodePlutusDataHex)\b/.test(line)));
    expect(importing.map((f) => f.file)).toStrictEqual(['identity.ts']);
    const code = importing[0].code;
    expect(code).toContain("export const decodeIdentityDatum = checked(readIdentityDatum, 'The record datum');");
    expect(code).toContain("export const decodeLegacyDatum = checked(readLegacyDatum, 'The record datum');");
    expect(code).toContain("export const decodePlutusDataHex = checked(readPlutusDataHex, 'The datum');");
    const checked = code.slice(code.indexOf('const checked'), code.indexOf('export const decodeIdentityDatum'));
    expect(checked.indexOf('assertCborHexDepth(') < checked.indexOf('return read(hex)'), 'checked runs the check, then the decoder').toBe(true);
  });

  test('no other file of src/ re-exports them without the check', () => {
    const reexports = files.filter(({ file, code }) => file !== 'identity.ts' && !file.startsWith('vendored/') && code.split('\n').some((line) => /^export .*\bfrom '\.\/vendored\/shared\/cbor\//.test(line) && VENDORED_DECODERS.test(line)));
    expect(reexports.map((f) => f.file)).toStrictEqual([]);
  });
});
