// agents/sourcing-agent/test/compliance/real.test.ts
// The real list of buyer-core, `listAttestations`, behind `readCompliance`, over the ledger fixtures of buyer-core: an offline node that holds the outputs, and a fake Koios that lists them. The datums are real bytes. The
// codec of the builders makes them, and the real code reads them back. No test here touches the network. The scenarios of read.test.ts run again over the real list, so the real list and the scripted list must give
// the same answers.
import { describe, expect, test } from 'vitest';
import { listAttestations } from '@vsa/buyer-core';
import { decodeAttestationDatum, utf8Hex } from '@vsa/vector-read/identity-codec';
import type { AttestationDatum } from '@vsa/vector-read/identity-codec';
import {
  CAPTURE, CAPTURE_MS, attestationIdOf, attestationUtxo, callsTo, capturedUtxos, ledgerWorld, revokedWithReason,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { KoiosOptions, LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { readCompliance } from '../../src/compliance/index.ts';
import type { ComplianceDeps, FactState } from '../../src/compliance/index.ts';
import { AGENT_ID, DAY, DID, ID, NOW, OTHER_ID, REGISTRY, STRANGER, ManualClock, datum, depsOf, golden, id, readItems, revoked, view } from './support.ts';

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

/** The deps over the real list of a world. A wide list asks for every attestation about the bidder, whatever its issuer and type: the reader must drop the others itself. */
const realDeps = (world: LedgerWorld, wide = false): ComplianceDeps =>
  depsOf((query) => (wide ? listAttestations(world.env, { subject: query.subject, limit: 50 }) : listAttestations(world.env, query)));

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

describe('the real list', () => {
  test('a revoked attestation with a reason above 2^53 shows the exact reason and the time of the revocation, and the number of the datum is NaN', async () => {
    const fact = await readCompliance(realDeps(worldOf([wideRow(ID)])), DID, NOW);
    expect(fact.revoke_reason).toBe('1152921504606846983');
    expect(fact.revoked_at).toBe(new Date(WIDE_REVOKED_AT).toISOString().replace(/\.000Z$/, 'Z'));
    expect(fact.attestation_state).toBe('revoked');
    const page = await listAttestations(worldOf([wideRow(ID)]).env, { subject: DID, issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 20 });
    const status = page.items[0]!.attestation.status;
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

  test('a Koios that ignores its datum filter and its token filter changes nothing: the reader and the list decide on the decoded datum', async () => {
    const rows = [row(ID, datum())];
    const loose = worldOf(rows, { ignoreDatumFilter: true, ignoreAssetFilter: true });
    expect(await readCompliance(realDeps(loose), DID, NOW)).toStrictEqual(golden('fact-valid.json'));
  });

  test('a page that says that more attestations exist is not followed: the newest of 25 decides, and the list is read once', async () => {
    // The newest attestation of the 25 is revoked. The 24 older ones are active, so a reader that took the first active one, or a later page, would say valid.
    const rows = Array.from({ length: 25 }, (_, n) => row(id(0x80 + n), datum({ issuedAt: NOW - (30 - n) * DAY, ...(n === 24 ? revoked(NOW - DAY, 1) : {}) })));
    const world = worldOf(rows);
    let calls = 0;
    const deps = depsOf((query) => { calls += 1; return listAttestations(world.env, query); });
    const fact = await readCompliance(deps, DID, NOW);
    expect([fact.state, fact.attestation, fact.attestation_state]).toStrictEqual(['invalid', id(0x80 + 24), 'revoked']);
    expect(calls).toBe(1);
    expect(callsTo(world.koios, 'credential_utxos')).toHaveLength(1);
    const page = await listAttestations(world.env, { subject: DID, issuer: { type: 'key_hash', hash: REGISTRY.keyHash }, attType: 0, limit: 20 });
    expect([page.items.length, page.total, page.nextOffset]).toStrictEqual([20, 25, 20]);
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
