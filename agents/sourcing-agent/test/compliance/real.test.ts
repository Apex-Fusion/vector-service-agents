// agents/sourcing-agent/test/compliance/real.test.ts
// The real list of buyer-core, `listAttestations`, behind `readCompliance`, over the ledger fixtures of buyer-core: an offline node that holds the outputs, and a fake Koios that lists them. The datums are real bytes. The
// codec of the builders makes them, and the real code reads them back. No test here touches the network. The scenarios of read.test.ts run again over the real list, so the real list and the scripted list must give
// the same answers.
import { deepStrictEqual } from 'node:assert/strict';
import { describe, expect, test } from 'vitest';
import { listAttestations } from '@vsa/buyer-core';
import type { AttestationQuery } from '@vsa/buyer-core';
import { decodeAttestationDatum, encodeAttestationDatum, utf8Hex } from '@vsa/vector-read/identity-codec';
import type { AttestationDatum } from '@vsa/vector-read/identity-codec';
import {
  CAPTURE, CAPTURE_MS, MAINNET, attestationIdOf, attestationUtxo, callsTo, capturedUtxos, koiosRow, ledgerWorld, revokedWithReason,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { KoiosOptions, LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { readCompliance } from '../../src/compliance/index.ts';
import type { ComplianceDeps, FactState } from '../../src/compliance/index.ts';
import { ABSENT, AGENT_ID, DAY, DID, ID, MINUTE, NOW, OTHER_ID, REGISTRY, STRANGER, ManualClock, datum, depsOf, golden, id, readItems, revoked, view } from './support.ts';

/** One attestation of a scenario: its identifier and datum. A reason that a number cannot hold also has its exact value and the bytes of the datum, because the codec of the builders refuses to make such a datum. */
interface Row {
  readonly id: string;
  readonly datum: AttestationDatum;
  readonly reason?: bigint;
  readonly bytes?: string;
}

const row = (attestationId: string, d: AttestationDatum): Row => ({ id: attestationId, datum: d });

const WIDE_REASON = 2n ** 60n + 7n;
/** The time of the revocation that `revokedWithReason` of the fixtures writes. */
const WIDE_REVOKED_AT = CAPTURE_MS - DAY;
/** A revoked attestation whose reason is above 2^53. The datum of the view holds NaN for it, as the real list leaves it. */
const wideRow = (attestationId: string): Row => ({
  id: attestationId, datum: datum(revoked(WIDE_REVOKED_AT, Number.NaN)), reason: WIDE_REASON, bytes: revokedWithReason(WIDE_REASON, datum()),
});

/** The bytes of the datum `d` with each named 32-byte member written as an indefinite byte string of two chunks. The decoded datum is the same, and the bytes are not, as in a datum that a `Contest` writes again. */
function chunkedBytes(d: AttestationDatum, members: readonly ('subject' | 'issuer')[]): string {
  const plain = encodeAttestationDatum(d);
  let bytes = plain;
  for (const member of members) {
    const value = d[member];
    bytes = bytes.replace(`5820${value}`, `5f5810${value.substring(0, 32)}5810${value.substring(32)}ff`);
  }
  if (bytes === plain) throw new Error('the datum was not written again');
  deepStrictEqual(decodeAttestationDatum(bytes), decodeAttestationDatum(plain));
  return bytes;
}

/** An attestation of a scenario whose datum is written again with the named 32-byte members in chunks. */
const chunkedRow = (attestationId: string, d: AttestationDatum, members: readonly ('subject' | 'issuer')[] = ['subject']): Row => ({ id: attestationId, datum: d, bytes: chunkedBytes(d, members) });

/** The page of the list of every attestation that a query names by its place only: Koios pages it in the order of the output reference. */
const everyAttestation = (query: AttestationQuery): AttestationQuery => ({ limit: query.limit, ...(query.offset === undefined ? {} : { offset: query.offset }) });

const REPLY = { uri: utf8Hex('https://bidder.example/reply.txt'), sha256: 'cd'.repeat(32) };

/** What the ledger holds besides the scenario: attestations of the registry about another agent, and decoys that hold the bidder as a digest or as a link target, and an attestation of a stranger. */
const noise = () => [
  attestationUtxo(id(0x71), datum({ subject: OTHER_ID })),
  attestationUtxo(id(0x72), datum({ subject: OTHER_ID, digest: AGENT_ID })),
  attestationUtxo(id(0x73), datum({ subject: OTHER_ID, links: [{ rel: 1, target: AGENT_ID }] })),
  attestationUtxo(id(0x74), datum({ issuer: STRANGER.publicKey, attType: 15 })),
];

const utxosOf = (rows: readonly Row[]) => rows.map((r) => (r.bytes === undefined ? attestationUtxo(r.id, r.datum) : attestationUtxo(r.id, datum(), { datum: r.bytes })));
const worldOf = (rows: readonly Row[], koios: KoiosOptions = {}): LedgerWorld => ledgerWorld([...utxosOf(rows), ...noise()], koios);

/**
 * The deps over the real list of a world. The list that the reader asks for names the key hash of the registry and the type. A wide list answers with every attestation of the world instead, whatever its issuer, its type
 * and its subject, in the order of the output reference: the reader must drop the attestations that it does not count and put the others in order itself.
 */
const realDeps = (world: LedgerWorld, wide = false): ComplianceDeps => depsOf((query) => listAttestations(world.env, wide ? everyAttestation(query) : query));

const SCENARIOS: ReadonlyArray<readonly [string, readonly Row[], FactState]> = [
  ['no attestation', [], 'absent'],
  ['an active attestation', [row(ID, datum())], 'valid'],
  ['an active attestation with no end', [row(ID, datum({ validUntil: null }))], 'valid'],
  ['a revoked attestation', [row(ID, datum(revoked(NOW - 2 * DAY, 3)))], 'invalid'],
  ['a revoked attestation whose reason is above 2^53', [wideRow(ID)], 'invalid'],
  ['an expired attestation', [row(ID, datum({ validUntil: NOW - 1 }))], 'invalid'],
  ['an attestation that is not yet valid', [row(ID, datum({ validFrom: NOW + DAY }))], 'invalid'],
  ['a newer attestation that is revoked, and an older one that is active', [row(id(2), datum({ issuedAt: NOW - 5 * DAY, ...revoked(NOW - DAY, 1) })), row(id(1), datum({ issuedAt: NOW - 10 * DAY }))], 'invalid'],
  ['a newer attestation that is active, and an older one that is revoked', [row(id(2), datum({ issuedAt: NOW - 5 * DAY })), row(id(1), datum({ issuedAt: NOW - 10 * DAY, ...revoked(NOW - 6 * DAY, 1) }))], 'valid'],
  ['two attestations issued at the same time: the lower identifier is active', [row(id(0x20), datum({ issuedAt: NOW - DAY, ...revoked(NOW - DAY, 1) })), row(id(0x10), datum({ issuedAt: NOW - DAY }))], 'valid'],
  ['an active attestation with a reply', [row(ID, datum({ contested: REPLY }))], 'valid'],
  ['a revoked attestation with a reply', [row(ID, datum({ contested: REPLY, ...revoked(NOW - 2 * DAY, 9) }))], 'invalid'],
  ['a revoked attestation with a reply, whose subject is written in chunks of bytes', [chunkedRow(ID, datum({ contested: REPLY, ...revoked(NOW - 2 * DAY, 7) }))], 'invalid'],
  ['a newer attestation that is revoked, with its subject in chunks of bytes, and an older one that is active', [chunkedRow(id(2), datum({ issuedAt: NOW - 5 * DAY, ...revoked(NOW - DAY, 1) })), row(id(1), datum({ issuedAt: NOW - 10 * DAY }))], 'invalid'],
  ['an active attestation whose subject and issuer are written in chunks of bytes', [chunkedRow(ID, datum(), ['subject', 'issuer'])], 'valid'],
  ['an attestation of type 1', [row(ID, datum({ attType: 1 }))], 'absent'],
  ['an attestation of type 15', [row(ID, datum({ attType: 15 }))], 'absent'],
  ['an attestation of another issuer', [row(ID, datum({ issuer: STRANGER.publicKey }))], 'absent'],
  ['an attestation about another subject', [row(ID, datum({ subject: OTHER_ID }))], 'absent'],
  ['a newer attestation of a stranger, revoked, and an older one of the registry, active', [row(id(2), datum({ issuer: STRANGER.publicKey, issuedAt: NOW - DAY, ...revoked(NOW - DAY, 1) })), row(ID, datum())], 'valid'],
];

describe('the real list gives the answers of the scripted list', () => {
  test.each(SCENARIOS)('%s', async (_name, rows, state) => {
    const scripted = await readItems(rows.map((r) => view(r.id, r.datum, r.reason)));
    expect(scripted.state).toBe(state);
    // The query of the reader, as `listAttestations` runs it, and a wide list that makes the reader drop the attestations that it does not count.
    expect(await readCompliance(realDeps(worldOf(rows)), DID, NOW)).toStrictEqual(scripted);
    expect(await readCompliance(realDeps(worldOf(rows), true), DID, NOW)).toStrictEqual(scripted);
  });

  test('an active attestation of the registry about the bidder gives the golden fact', async () => {
    expect(await readCompliance(realDeps(worldOf([row(ID, datum())])), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
  });
});

describe('a datum that the controller of the subject writes again', () => {
  // The controller of the subject signs a `Contest`, which writes the datum again with the same decoded fields. The bytes can differ: a 32-byte value may be written in chunks. A filter of the list on the bytes of
  // the subject then misses the output, so the reader asks for no subject and decides on the decoded datum.
  const contested = datum({ contested: REPLY, ...revoked(NOW - 2 * DAY, 7) });
  const subjectQuery: AttestationQuery = { subject: DID, issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 20 };

  test('a revoked attestation with a reply, whose subject is written in chunks of bytes, reads invalid: revoked, the reason 7 and the reply', async () => {
    const world = worldOf([chunkedRow(ID, contested)]);
    const expected = { ...golden('fact-valid.json'), state: 'invalid', attestation_state: 'revoked', revoked_at: '2026-11-22T12:00:00Z', revoke_reason: '7', contested: { sha256: REPLY.sha256 } };
    expect(await readCompliance(realDeps(world), DID, NOW)).toStrictEqual(expected);
    // The witness: a list that names the subject does not find the output, and it finds the plain twin.
    expect((await listAttestations(world.env, subjectQuery)).total).toBe(0);
    const plain = worldOf([row(ID, contested)]);
    expect((await listAttestations(plain.env, subjectQuery)).total).toBe(1);
    expect(await readCompliance(realDeps(plain), DID, NOW)).toStrictEqual(expected);
  });

  test('a newer attestation that is revoked, with its subject in chunks, does not hide behind an older one that is active: the fact is invalid and not valid', async () => {
    const newer = datum({ issuedAt: NOW - 5 * DAY, ...revoked(NOW - DAY, 1) });
    const older = datum({ issuedAt: NOW - 10 * DAY });
    const world = worldOf([chunkedRow(id(2), newer), row(id(1), older)]);
    const fact = await readCompliance(realDeps(world), DID, NOW);
    expect([fact.state, fact.attestation, fact.attestation_state]).toStrictEqual(['invalid', id(2), 'revoked']);
    // The witness: a list that names the subject finds the older attestation only, and a reader that asked for it would say valid.
    const found = await listAttestations(world.env, subjectQuery);
    expect(found.items.map((item) => item.id)).toStrictEqual([id(1)]);
    // The twin: with the plain datum the answer is the same.
    expect(await readCompliance(realDeps(worldOf([row(id(2), newer), row(id(1), older)])), DID, NOW)).toStrictEqual(fact);
  });

  test('an issuer that is written in chunks of bytes is still the issuer: the key hash is taken of the decoded key', async () => {
    const both = chunkedRow(ID, datum(revoked(NOW - 2 * DAY, 7)), ['subject', 'issuer']);
    expect(await readCompliance(realDeps(worldOf([both])), DID, NOW)).toMatchObject({ state: 'invalid', attestation_state: 'revoked', revoke_reason: '7' });
    // The twin: the same writing of the key of a stranger is still the key of a stranger.
    const stranger = chunkedRow(ID, datum({ issuer: STRANGER.publicKey }), ['subject', 'issuer']);
    expect(await readCompliance(realDeps(worldOf([stranger])), DID, NOW)).toStrictEqual(ABSENT);
  });
});

describe('the real list', () => {
  test('a revoked attestation with a reason above 2^53 shows the exact reason and the time of the revocation, and the number of the datum is NaN', async () => {
    const fact = await readCompliance(realDeps(worldOf([wideRow(ID)])), DID, NOW);
    expect(fact.revoke_reason).toBe('1152921504606846983');
    expect(fact.revoked_at).toBe(new Date(WIDE_REVOKED_AT).toISOString().replace(/\.000Z$/, 'Z'));
    expect(fact.attestation_state).toBe('revoked');
    const page = await listAttestations(worldOf([wideRow(ID)]).env, { issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 50 });
    const status = page.items.find((item) => item.id === ID)!.attestation.status;
    expect(status.type === 'AttRevoked' && Number.isNaN(status.reason)).toBe(true);
  });

  test('the reply of the bidder shows as its hash: the address of the reply is in the datum, and nowhere in the fact', async () => {
    const fact = await readCompliance(realDeps(worldOf([row(ID, datum({ contested: REPLY }))])), DID, NOW);
    expect(fact.contested).toStrictEqual({ sha256: REPLY.sha256 });
    expect(JSON.stringify(fact)).not.toContain(REPLY.uri);
    expect(JSON.stringify(fact)).not.toContain('bidder.example');
  });

  test('a Koios that fails gives unreadable, never absent, and the same ledger with a Koios that answers is read', async () => {
    const rows = [row(ID, datum())];
    expect(await readCompliance(realDeps(worldOf(rows, { status: { credential_utxos: 500 } })), DID, NOW)).toMatchObject({ state: 'unreadable', attestation: null });
    expect((await readCompliance(realDeps(worldOf(rows)), DID, NOW)).state).toBe('valid');
  });

  test('a list that is spent by its own budget gives unreadable', async () => {
    const world = worldOf([row(ID, datum())]);
    const spent: ComplianceDeps = depsOf((query) => listAttestations({ ...world.env, budgetMs: 0 }, query));
    expect((await readCompliance(spent, DID, NOW)).state).toBe('unreadable');
  });

  test('5,000 attestation outputs in all make the list fail, and the fact is unreadable: it is neither valid nor absent, and a few outputs of other agents do not matter', async () => {
    const template = koiosRow(attestationUtxo(id(0x90), datum({ subject: OTHER_ID, issuer: STRANGER.publicKey })));
    const hash = (n: number): string => n.toString(16).padStart(8, '0').repeat(8);
    const outputs = (count: number) => Array.from({ length: count }, (_, n) => ({
      ...template, tx_hash: hash(0x100000 + n), asset_list: [{ policy_id: MAINNET.attestation.hash, asset_name: (0x100000 + n).toString(16).padStart(64, '0'), quantity: '1' }],
    }));
    const mine = attestationUtxo(ID, datum());
    const fine = ledgerWorld([mine], { rows: [...outputs(50), koiosRow(mine)] });
    expect(await readCompliance(realDeps(fine), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
    // The reader names no subject, so the list reads every attestation output, whoever its subject and its issuer are. It reads at most 4,999 of them: the 5,000th makes it fail, for every bidder.
    const flooded = ledgerWorld([mine], { rows: [...outputs(4_999), koiosRow(mine)] });
    expect(await readCompliance(realDeps(flooded), DID, NOW)).toMatchObject({ state: 'unreadable', attestation: null });
  });

  test('a Koios that ignores its token filter changes nothing: the list decides on the token and on the decoded datum', async () => {
    const rows = [row(ID, datum())];
    const loose = worldOf(rows, { ignoreAssetFilter: true });
    expect(await readCompliance(realDeps(loose), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
  });

  test('a list of 120 attestations of the registry is read page by page: the revoked attestation of the bidder is on the last page, and the older active one is beside it', async () => {
    const idOf = (n: number): string => n.toString(16).padStart(64, '0');
    // The registry attested 120 other agents. Each of those attestations is newer than both of the bidder, so the pages of the list, newest first, end with the bidder.
    const others = Array.from({ length: 120 }, (_, n) => row(idOf(n + 1), datum({ subject: idOf(0x1000 + n), issuedAt: NOW - (n + 1) * MINUTE })));
    const mine = [row(id(1), datum({ issuedAt: NOW - 10 * DAY })), row(id(2), datum({ issuedAt: NOW - 5 * DAY, ...revoked(NOW - DAY, 7) }))];
    for (const wide of [false, true]) {
      const world = worldOf([...others, ...mine]);
      const offsets: Array<number | undefined> = [];
      const deps = depsOf((query) => {
        offsets.push(query.offset);
        return listAttestations(world.env, wide ? everyAttestation(query) : query);
      });
      const fact = await readCompliance(deps, DID, NOW);
      expect([fact.state, fact.attestation, fact.attestation_state, fact.revoke_reason], `wide: ${wide}`).toStrictEqual(['invalid', id(2), 'revoked', '7']);
      expect(offsets, `wide: ${wide}`).toStrictEqual([undefined, 50, 100]);
      expect(callsTo(world.koios, 'credential_utxos'), `wide: ${wide}`).toHaveLength(3);
    }
  });

  test('the type 0 attestation that mainnet holds, made by another issuer, does not count for the key of the registry; one of the registry beside it decides', async () => {
    const onMainnet = CAPTURE.attestations
      .map((captured) => ({ id: attestationIdOf(captured), datum: decodeAttestationDatum(captured.inline_datum!.bytes) }))
      .filter((captured) => captured.datum.attType === 0);
    expect(onMainnet).toHaveLength(1);
    const subject = `did:vector:${onMainnet[0]!.datum.subject}`;
    const alone = ledgerWorld(capturedUtxos());
    expect(await readCompliance(depsOf((query) => listAttestations(alone.env, query)), subject, NOW)).toMatchObject({ state: 'absent' });
    // The twin: the attestation of the registry about the same agent. It decides, and it is not the one of mainnet.
    const beside = ledgerWorld([...capturedUtxos(), attestationUtxo(ID, datum({ subject: onMainnet[0]!.datum.subject }))]);
    const fact = await readCompliance(depsOf((query) => listAttestations(beside.env, query)), subject, NOW);
    expect([fact.state, fact.attestation]).toStrictEqual(['valid', ID]);
  });

  test('the clock of the reader is not moved by a list that answers: no timer is left', async () => {
    const clock = new ManualClock();
    const world = worldOf([row(ID, datum())]);
    const fact = await readCompliance(depsOf((query) => listAttestations(world.env, query), { clock }), DID, NOW);
    expect(fact.state).toBe('valid');
    expect(clock.waiting).toBe(0);
  });
});
