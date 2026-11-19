// The CBOR check in the reads of Agent History. The rule: CBOR that is nested deeper than 64 levels is refused before it is decoded. A datum that fails the check counts as a datum
// that does not decode, so the report skips the output that holds it (the last blind-spot line says so). The decoders are the ones of @vsa/vector-read, which run the check first.
// The tests build the nested values here. A watch stands in for Data.from (test/decoder-watch.ts): a nested value that reaches it fails the test, and never reaches the real library.
// The static test reads src/ and names each place that reads a datum.
import { afterEach, describe, test, expect, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Data, Constr } from '@lucid-evolution/lucid';
import { replayFetch, didFor, M3_ENDORSEMENT_ADDRESS } from '@vsa/vector-read';
import { assertCborHexDepth, cborDepth } from '@vsa/vector-read/cbor-depth';
import { reputationSection } from '../src/modules.ts';
import type { Subject } from '../src/subject.ts';
import { BUILT_STAKE, BUILT_STAKE_HEX, addressKey, stakeRow, stakeToken, withStakeRows } from './support.ts';
import { watchDecoder } from './decoder-watch.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const CHANDRA = BUILT_STAKE.agent_did;
const OWNER = BUILT_STAKE.owner_pkh;
const subject: Subject = { kind: 'asset', pkh: null, asset_name: CHANDRA, did: didFor(CHANDRA), registry: 'legacy', controller_pkh: OWNER, candidates: [] };
/** CBOR hex of an array nested `levels` levels deep, with the integer 0 inside: valid Plutus data. */
const nested = (levels: number): string => `${'81'.repeat(levels)}00`;
const DEEP = nested(5000);

afterEach(() => { vi.restoreAllMocks(); });

describe('a datum that nests too deep is skipped', () => {
  test('a stake output: skipped, with its token, and Data.from does not run for it; the stake beside it is read', async () => {
    const watch = watchDecoder(Data, 'from');
    const token = [stakeToken(CHANDRA)];
    const store = withStakeRows(fx.store, [stakeRow(1, nested(65), token), stakeRow(2, BUILT_STAKE_HEX, token), stakeRow(3, DEEP, token)]);
    const r = await reputationSection(subject, replayFetch(store));
    expect(r.stakes.map((s) => s.utxo)).toEqual([`${stakeRow(2, null, null).tx_hash}#0`]);
    expect(watch.reached()).toBe(0);
    expect(watch.calls(), 'Data.from ran for the one stake only').toBe(1);
  });

  test('an endorsement output: skipped, and the endorsement beside it is found', async () => {
    const watch = watchDecoder(Data, 'from');
    const row = (n: number, datum: string) => ({ tx_hash: n.toString(16).padStart(64, 'd'), tx_index: 0, address: M3_ENDORSEMENT_ADDRESS, value: '2000000', block_height: 9_100_000 + n, inline_datum: { bytes: datum }, asset_list: [] });
    const named = Data.to(new Constr(0, [CHANDRA, new Constr(0, ['77'.repeat(28)])]));
    const store = { ...fx.store, [addressKey(M3_ENDORSEMENT_ADDRESS)]: { status: 200, body: JSON.stringify([row(1, nested(65)), row(2, named), row(3, DEEP)]) } };
    const r = await reputationSection(subject, replayFetch(store));
    expect(r.endorsements.map((e) => e.utxo)).toEqual([`${row(2, named).tx_hash}#0`]);
    expect(watch.reached()).toBe(0);
    expect(watch.calls()).toBe(1);
  });
});

describe('real data is inside the limit', () => {
  /** Every inline datum of the recorded answers of Koios and of the built stake: the check accepts each, and none nests more than 16 levels. */
  test('every recorded datum is accepted, and the built stake too', () => {
    const datums: string[] = [BUILT_STAKE_HEX];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x !== null && typeof x === 'object') {
        const datum = 'inline_datum' in x ? x.inline_datum : null;
        if (datum !== null && typeof datum === 'object' && 'bytes' in datum && typeof datum.bytes === 'string') datums.push(datum.bytes);
        Object.values(x).forEach(walk);
      }
    };
    for (const entry of Object.values(fx.store) as Array<{ body: string }>) { try { walk(JSON.parse(entry.body)); } catch { /* an answer that is not JSON holds no datum */ } }
    expect(datums.length).toBeGreaterThan(5);
    for (const hex of datums) {
      expect(() => assertCborHexDepth(hex), hex.slice(0, 20)).not.toThrow();
      expect(cborDepth(Buffer.from(hex, 'hex')), hex.slice(0, 20)).toBeLessThan(16);
    }
  });
});

describe('the sources of Agent History read a datum only through @vsa/vector-read', () => {
  const SOURCES = fileURLToPath(new URL('../src', import.meta.url));
  const files = readdirSync(SOURCES).filter((f) => f.endsWith('.ts')).map((f) => ({
    file: f, code: readFileSync(join(SOURCES, f), 'utf8').split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));
  const callers = (pattern: RegExp): string[] => files.flatMap(({ file, code }) => (pattern.test(code) ? [file] : [])).sort();

  test('no file calls a decoder of Lucid or CML by itself', () => {
    expect(callers(/\b(?:from_cbor_hex|from_cbor_bytes)\s*\(|\bData\.from\s*\(|\bfromTx\s*\(/)).toStrictEqual([]);
  });

  test('each place that reads a datum is named: the stake, the generic match, the record of a registry output and the identity timeline', () => {
    expect(callers(/\bdecodeStakeDatum\(/)).toStrictEqual(['modules.ts']);
    expect(callers(/\btopLevelBytes\(/)).toStrictEqual(['modules.ts']);
    expect(callers(/\bdecodeLegacyDatum\(|\bdecodeIdentityDatum\(/)).toStrictEqual(['identity.ts', 'subject.ts']);
    expect(callers(/\bdecodePlutusDataHex\(/)).toStrictEqual(['identity.ts']);
    // Each of them imports the decoder from the package, which runs the check first.
    for (const { code } of files.filter((f) => ['modules.ts', 'identity.ts', 'subject.ts'].includes(f.file))) expect(code).toMatch(/from '@vsa\/vector-read';/);
  });

  test('a decoder that fails is caught where the output is skipped, and not caught in the identity timeline, which shows the failure as an error of its section', () => {
    const code = (file: string) => files.find((f) => f.file === file)!.code;
    expect(code('modules.ts')).toMatch(/try \{ d = decodeStakeDatum\(bytes\); \} catch \{ return null; \}/);
    expect(code('modules.ts')).toMatch(/try \{ const fields = topLevelBytes\(u\.inline_datum!\.bytes\);.*\} catch \{ return \[\]; \}/);
    expect(code('subject.ts')).toMatch(/decodeIdentityDatum\(bytes\) \}; \} catch \{ return null; \}/);
    expect(code('identity.ts')).toMatch(/const content: RecordContent = registry === 'legacy' \? \{ registry, datum: decodeLegacyDatum\(bytes\) \} : \{ registry, datum: decodeIdentityDatum\(bytes\) \};/);
  });
});
