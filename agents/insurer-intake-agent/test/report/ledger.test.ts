// agents/insurer-intake-agent/test/report/ledger.test.ts: the real readers of the report. `ledgerReportDeps` maps the readers of buyer-core to the four ports: the list of the attestations about the sender, the check
// of one attestation, the Provider key of the sender, and the root delegator of a delegation. The world is the fixture world of buyer-core (an offline node and a fake Koios on the identity deployment of mainnet),
// so the real read code runs and no test touches the network. The question: does each port give what the report needs, is a read that fails a throw and never an empty answer, and does the whole report keep the
// rules over the real readers? The fixture world is not mainnet: a type 4 attestation with a registered issuer has not run on the live ledger.
import { describe, expect, it } from 'vitest';
import { systemClock } from '@vsa/usecase-kit/access';
import { didOfAgentId } from '@vsa/usecase-kit/protocol';
import { CAPTURE_MS, DAY, callsTo, delegation, delegationUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { ledgerReportDeps, reportAttestations } from '../../src/report/index.ts';
import type { AttestationReport, ReportDeps, ReportExpectation, ReportInput, ReportRow } from '../../src/report/index.ts';
import { ALL_VALID, DELEGATION, MEMBER_ID, OTHER_ID, SENDER, idOf } from './support.ts';
import {
  DownProvider, HOUR, MEMBER_KEY, MIDDLE_ID, NOW, PARENT_LINK, PROVIDER_KEY, ROOT_KEY, SENDER_ID, STRANGER_KEY, SilentProvider, agentRootLink, attestationAbout, goodWorld, keyRootLink, link,
  memberRecord, providerParty, senderRecord, withNode, worldOf,
} from './world.ts';
import type { Output } from './world.ts';

const INPUT: ReportInput = { sender: SENDER, delegation: DELEGATION, atMs: NOW };
const depsOf = (world: LedgerWorld, lines: string[] = []): ReportDeps => ledgerReportDeps(world.env, { clock: systemClock, log: (line) => { lines.push(line); } });
const reportIn = (world: LedgerWorld, lines: string[] = [], input: ReportInput = INPUT): Promise<AttestationReport> => reportAttestations(depsOf(world, lines), input);
const reportOn = (utxos: readonly Output[]): Promise<AttestationReport> => reportIn(worldOf(utxos));
const ALL_UNREADABLE: AttestationReport = { provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' };
const REVOKED = { status: { type: 'AttRevoked', at: CAPTURE_MS, reason: 1 } } as const;

describe('ledgerReportDeps', () => {
  it('gives the clock and the log of its options to the report', () => {
    const lines: string[] = [];
    const deps = ledgerReportDeps(worldOf([]).env, { clock: systemClock, log: (line) => { lines.push(line); } });
    expect(deps.clock).toBe(systemClock);
    deps.log('a line');
    expect(lines).toEqual(['a line']);
  });
});

describe('rootDelegatorOf', () => {
  it('gives a key principal as the hash of its key', async () => {
    expect(await depsOf(worldOf([keyRootLink()])).rootDelegatorOf(DELEGATION)).toEqual({ type: 'key', hash: ROOT_KEY.keyHash });
  });

  it('gives an agent root as the id of its record', async () => {
    expect(await depsOf(worldOf([agentRootLink()])).rootDelegatorOf(DELEGATION)).toEqual({ type: 'agent', id: MEMBER_ID });
  });

  it('gives the delegator of the LAST link of the chain, which is the root, and not the delegator of the delegation itself', async () => {
    const leaf = link(DELEGATION, { delegator: { type: 'Agent', id: MIDDLE_ID }, parent: PARENT_LINK });
    const keyRoot = delegationUtxo(PARENT_LINK, delegation({ delegate: MIDDLE_ID, delegator: { type: 'PrincipalKey', hash: ROOT_KEY.keyHash, organisation: null } }));
    expect(await depsOf(worldOf([leaf, keyRoot])).rootDelegatorOf(DELEGATION)).toEqual({ type: 'key', hash: ROOT_KEY.keyHash });
    const agentRoot = delegationUtxo(PARENT_LINK, delegation({ delegate: MIDDLE_ID, delegator: { type: 'Agent', id: MEMBER_ID } }));
    expect(await depsOf(worldOf([leaf, agentRoot])).rootDelegatorOf(DELEGATION)).toEqual({ type: 'agent', id: MEMBER_ID });
  });

  it('gives null for a delegation that is not live: the chain is empty', async () => {
    expect(await depsOf(worldOf([])).rootDelegatorOf(DELEGATION)).toBeNull();
    expect(await depsOf(worldOf([keyRootLink()])).rootDelegatorOf(idOf(0xeeee))).toBeNull();
  });

  it('gives null for a chain that does not end at a root: a parent was ended, so the delegator of the last link is no root delegator', async () => {
    const leaf = link(DELEGATION, { delegator: { type: 'PrincipalKey', hash: ROOT_KEY.keyHash, organisation: null }, parent: PARENT_LINK });
    expect(await depsOf(worldOf([leaf])).rootDelegatorOf(DELEGATION)).toBeNull();
  });

  it('throws when the node cannot be read, and never gives null for it', async () => {
    await expect(depsOf(withNode(worldOf([keyRootLink()]), { provider: new DownProvider([]) })).rootDelegatorOf(DELEGATION)).rejects.toThrow();
  });
});

describe('providerKeyHashOf', () => {
  it('gives the key hash of the signer of the Provider party of the record of the sender', async () => {
    expect(await depsOf(worldOf([senderRecord([providerParty()])])).providerKeyHashOf(SENDER)).toBe(PROVIDER_KEY.keyHash);
  });

  it('gives the first Provider party when the record has two, and finds it after the parties of other roles', async () => {
    const other = providerParty({ type: 'KeyHash', hash: STRANGER_KEY.keyHash });
    expect(await depsOf(worldOf([senderRecord([providerParty(), other])])).providerKeyHashOf(SENDER)).toBe(PROVIDER_KEY.keyHash);
    expect(await depsOf(worldOf([senderRecord([{ ...other, role: 'Responsible' }, { ...other, role: 'Guardian' }, providerParty()])])).providerKeyHashOf(SENDER)).toBe(PROVIDER_KEY.keyHash);
  });

  it('gives null for a record with no Provider party', async () => {
    expect(await depsOf(worldOf([senderRecord([])])).providerKeyHashOf(SENDER)).toBeNull();
    expect(await depsOf(worldOf([senderRecord([{ ...providerParty(), role: 'Responsible' }])])).providerKeyHashOf(SENDER)).toBeNull();
  });

  it.each([
    ['a script', { type: 'Script', hash: PROVIDER_KEY.keyHash }],
    ['the controller set', { type: 'ControllerSet' }],
  ] as const)('gives null for a Provider party whose signer is %s: it names no key, so no attestation can be of it', async (_name, signer) => {
    expect(await depsOf(worldOf([senderRecord([providerParty(signer)])])).providerKeyHashOf(SENDER)).toBeNull();
  });

  it('throws for a record that cannot be found: null is only a record with no Provider party', async () => {
    await expect(depsOf(worldOf([])).providerKeyHashOf(SENDER)).rejects.toThrow();
    await expect(depsOf(worldOf([senderRecord([providerParty()])])).providerKeyHashOf(didOfAgentId(idOf(0xbeef)))).rejects.toThrow();
  });

  it('throws when the node cannot be read', async () => {
    await expect(depsOf(withNode(worldOf([senderRecord([providerParty()])]), { provider: new DownProvider([]) })).providerKeyHashOf(SENDER)).rejects.toThrow();
  });
});

describe('list', () => {
  it('gives a row for each attestation about the sender of the type: its id, the hash of the issuer key, the record of the issuer and the issue time', async () => {
    const older = attestationAbout(4, ROOT_KEY, { issuedAt: CAPTURE_MS - 5 * HOUR });
    const newer = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
    expect(await depsOf(worldOf([older.utxo, newer.utxo])).list(SENDER, 4)).toEqual<ReportRow[]>([
      { id: newer.id, issuer_key_hash: MEMBER_KEY.keyHash, issuer_id: MEMBER_ID, issued_at: CAPTURE_MS },
      { id: older.id, issuer_key_hash: ROOT_KEY.keyHash, issuer_id: null, issued_at: CAPTURE_MS - 5 * HOUR },
    ]);
  });

  it('gives only the rows of the subject and the type that it asked for', async () => {
    const wanted = attestationAbout(4, ROOT_KEY);
    const world = worldOf([wanted.utxo, attestationAbout(1, ROOT_KEY).utxo, attestationAbout(15, ROOT_KEY).utxo, attestationAbout(4, ROOT_KEY, { subject: idOf(0xbb) }).utxo]);
    expect((await depsOf(world).list(SENDER, 4)).map((row) => row.id)).toEqual([wanted.id]);
    expect(await depsOf(world).list(didOfAgentId(idOf(0xcc)), 4)).toEqual([]);
  });

  it('gives an empty list when no attestation exists: an empty list is an answer', async () => {
    expect(await depsOf(worldOf([])).list(SENDER, 4)).toEqual([]);
  });

  it('is whole at 50 rows, and throws for 51: a list that is cut short is never read as the whole list', async () => {
    const fifty = Array.from({ length: 50 }, () => attestationAbout(4, STRANGER_KEY).utxo);
    expect((await depsOf(worldOf(fifty)).list(SENDER, 4)).length).toBe(50);
    await expect(depsOf(worldOf([...fifty, attestationAbout(4, STRANGER_KEY).utxo])).list(SENDER, 4)).rejects.toThrow();
  });

  it('throws when Koios fails, and never gives an empty list for it', async () => {
    await expect(depsOf(worldOf([attestationAbout(4, ROOT_KEY).utxo], { status: { credential_utxos: 500 } })).list(SENDER, 4)).rejects.toThrow();
  });
});

describe('check', () => {
  const expectKey: ReportExpectation = { attType: 4, subject: SENDER, issuer: { key_hash: ROOT_KEY.keyHash } };
  /** Asks the real check about `made`, in a world that holds it and `extra`. */
  const checkOf = (made: { id: string; utxo: Output }, extra: readonly Output[] = [], expectation: ReportExpectation = expectKey, atMs = NOW): Promise<boolean> =>
    depsOf(worldOf([made.utxo, ...extra])).check(made.id, atMs, expectation);

  it('is true for an attestation that passes the rule, with the type, the subject and the issuer that the expectation names: its digest is not checked', async () => {
    expect(await checkOf(attestationAbout(4, ROOT_KEY, { digest: 'ab'.repeat(32) }))).toBe(true);
  });

  it.each([
    ['revoked', REVOKED],
    ['expired', { validUntil: NOW - 1 }],
    ['not yet valid', { validFrom: NOW + DAY, validUntil: NOW + 5 * DAY }],
    ['issued more than an hour after the time of the check', { issuedAt: NOW + 2 * HOUR }],
  ] as const)('is false for an attestation that is %s', async (_name, over) => {
    expect(await checkOf(attestationAbout(4, ROOT_KEY, over))).toBe(false);
  });

  it('is true for an attestation that was issued up to an hour after the time of the check: a relying party does not require that the time is after the issue time', async () => {
    expect(await checkOf(attestationAbout(4, ROOT_KEY, { issuedAt: NOW + 30 * 60_000 }))).toBe(true);
  });

  it('is true on the last instant of the validity and false after it', async () => {
    const made = attestationAbout(4, ROOT_KEY, { validUntil: NOW });
    expect(await checkOf(made, [], expectKey, NOW)).toBe(true);
    expect(await checkOf(made, [], expectKey, NOW + 1)).toBe(false);
  });

  it('is false when the expectation is not met: another issuer key, another type, another subject', async () => {
    const made = attestationAbout(4, ROOT_KEY);
    expect(await checkOf(made, [], { ...expectKey, issuer: { key_hash: STRANGER_KEY.keyHash } })).toBe(false);
    expect(await checkOf(made, [], { ...expectKey, attType: 1 })).toBe(false);
    expect(await checkOf(made, [], { ...expectKey, subject: didOfAgentId(idOf(0xcc)) })).toBe(false);
  });

  it('is true for an issuer that is named by the DID of its record, and false for another record or for a key hash that is not its key', async () => {
    const made = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
    const record = memberRecord(MEMBER_ID, MEMBER_KEY);
    expect(await checkOf(made, [record], { ...expectKey, issuer: { did: didOfAgentId(MEMBER_ID) } })).toBe(true);
    expect(await checkOf(made, [record], { ...expectKey, issuer: { did: didOfAgentId(OTHER_ID) } })).toBe(false);
    expect(await checkOf(made, [record], { ...expectKey, issuer: { key_hash: STRANGER_KEY.keyHash } })).toBe(false);
  });

  it('is false for an attestation that no output holds, and for an issuer record that the registry does not hold', async () => {
    expect(await depsOf(worldOf([])).check(idOf(0xfeed), NOW, expectKey)).toBe(false);
    const made = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
    expect(await checkOf(made, [], { ...expectKey, issuer: { did: didOfAgentId(MEMBER_ID) } })).toBe(false);
  });

  it('refuses an issuer that names a key hash and a DID together, or neither, with no read', async () => {
    const world = worldOf([attestationAbout(4, ROOT_KEY).utxo]);
    const both = { key_hash: ROOT_KEY.keyHash, did: didOfAgentId(MEMBER_ID) };
    await expect(depsOf(world).check(idOf(0x1), NOW, { ...expectKey, issuer: both })).rejects.toThrow(TypeError);
    await expect(depsOf(world).check(idOf(0x1), NOW, { ...expectKey, issuer: {} as never })).rejects.toThrow(TypeError);
    expect(callsTo(world.koios, 'credential_utxos')).toEqual([]);
    expect(world.provider.scans).toEqual([]);
  });

  it('throws when the node cannot be read, and never gives false for it', async () => {
    const world = withNode(worldOf([attestationAbout(4, ROOT_KEY).utxo]), { provider: new DownProvider([]) });
    await expect(depsOf(world).check(idOf(0x1), NOW, expectKey)).rejects.toThrow();
  });
});

describe('the report over the real readers', () => {
  it('reports valid for each kind in the good world, with one line for each kind', async () => {
    const lines: string[] = [];
    expect(await reportIn(worldOf(goodWorld()), lines)).toEqual(ALL_VALID);
    expect(lines).toEqual(['attestation report: provenance valid rows=1', 'attestation report: software valid rows=1', 'attestation report: principal_binding valid rows=1']);
  });

  it.each([
    ['revoked', REVOKED],
    ['expired', { validUntil: NOW - 1 }],
    ['not yet valid', { validFrom: NOW + DAY, validUntil: NOW + 5 * DAY }],
  ] as const)('reports invalid for a kind whose attestation is %s, and leaves the other kinds', async (_name, over) => {
    expect(await reportOn(goodWorld({ binding: attestationAbout(4, ROOT_KEY, over).utxo }))).toEqual({ ...ALL_VALID, principal_binding: 'invalid' });
    expect(await reportOn(goodWorld({ provenance: attestationAbout(1, PROVIDER_KEY, over).utxo }))).toEqual({ ...ALL_VALID, provenance: 'invalid' });
    expect(await reportOn(goodWorld({ software: attestationAbout(2, PROVIDER_KEY, over).utxo }))).toEqual({ ...ALL_VALID, software: 'invalid' });
  });

  it('reports valid when the newest attestation is revoked and an older one is valid', async () => {
    const revoked = attestationAbout(4, ROOT_KEY, { ...REVOKED, issuedAt: CAPTURE_MS + 1 });
    expect(await reportOn([...goodWorld(), revoked.utxo])).toEqual(ALL_VALID);
  });

  it('reports invalid at a time after the validity of the attestations', async () => {
    expect(await reportIn(worldOf(goodWorld()), [], { ...INPUT, atMs: CAPTURE_MS + 40 * DAY })).toEqual({ provenance: 'invalid', software: 'invalid', principal_binding: 'invalid' });
  });

  it('reports absent for an attestation of another key, and for an attestation of the root delegator in a Provider kind', async () => {
    const world = goodWorld({ binding: attestationAbout(4, STRANGER_KEY).utxo, provenance: attestationAbout(1, ROOT_KEY).utxo });
    expect(await reportOn(world)).toEqual({ provenance: 'absent', software: 'valid', principal_binding: 'absent' });
  });

  it('reports absent when no attestation exists', async () => {
    expect(await reportOn(goodWorld({ provenance: null, software: null, binding: null }))).toEqual({ provenance: 'absent', software: 'absent', principal_binding: 'absent' });
  });

  describe('the decoys', () => {
    const member = memberRecord(MEMBER_ID, ROOT_KEY, MEMBER_KEY);

    it('DECOY: another key of the record of the member is not a binding by a key principal', async () => {
      const decoy = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
      expect(await reportOn([...goodWorld({ binding: decoy.utxo }), member])).toEqual({ ...ALL_VALID, principal_binding: 'absent' });
    });

    it('accepts the key of the principal when it names its record: the twin of the decoy', async () => {
      const real = attestationAbout(4, ROOT_KEY, { issuerId: MEMBER_ID });
      expect(await reportOn([...goodWorld({ binding: real.utxo }), member])).toEqual(ALL_VALID);
    });

    it('reports valid for an agent root, by the id of its record whatever key signed', async () => {
      const real = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
      expect(await reportOn([...goodWorld({ delegation: agentRootLink(), binding: real.utxo }), member])).toEqual(ALL_VALID);
    });

    it.each([
      ['no record', null],
      ['another record', OTHER_ID],
    ])('DECOY: the key of an agent root with %s is not a binding by that agent root', async (_name, issuerId) => {
      const decoy = attestationAbout(4, MEMBER_KEY, { issuerId });
      expect(await reportOn([...goodWorld({ delegation: agentRootLink(), binding: decoy.utxo }), member, memberRecord(OTHER_ID, MEMBER_KEY)])).toEqual({ ...ALL_VALID, principal_binding: 'absent' });
    });
  });

  describe('a sender with no Provider party, or with no record', () => {
    it('is absent for the provenance and the software attestation, with no list for them', async () => {
      const world = worldOf(goodWorld({ record: senderRecord([]) }));
      expect(await reportIn(world)).toEqual({ provenance: 'absent', software: 'absent', principal_binding: 'valid' });
      expect(callsTo(world.koios, 'credential_utxos').length).toBe(1);
    });

    it('is absent for a Provider party that names a script', async () => {
      const record = senderRecord([providerParty({ type: 'Script', hash: PROVIDER_KEY.keyHash })]);
      expect(await reportOn(goodWorld({ record }))).toEqual({ ...ALL_VALID, provenance: 'absent', software: 'absent' });
    });

    it('is unreadable for the Provider kinds when the registry has no record of the sender: a record that is not found is never "no Provider"', async () => {
      expect(await reportOn(goodWorld({ record: null }))).toEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'valid' });
    });
  });

  describe('a source that fails', () => {
    it('gives unreadable for the binding when the delegation is not live, or has no root, and leaves the Provider kinds', async () => {
      expect(await reportOn(goodWorld({ delegation: null }))).toEqual({ ...ALL_VALID, principal_binding: 'unreadable' });
      expect(await reportOn(goodWorld({ delegation: link(DELEGATION, { parent: PARENT_LINK }) }))).toEqual({ ...ALL_VALID, principal_binding: 'unreadable' });
    });

    it('gives unreadable for every kind when Koios fails to list, and says that a read failed', async () => {
      const lines: string[] = [];
      expect(await reportIn(worldOf(goodWorld(), { status: { credential_utxos: 500 } }), lines)).toEqual(ALL_UNREADABLE);
      expect(lines.length).toBe(3);
      for (const line of lines) expect(line).toMatch(/unreadable rows=0 why=read_failed$/);
    });

    it('gives unreadable for a list that is cut short, also when the attestation of the right issuer is in it: strangers cannot push a kind to absent', async () => {
      const strangers = Array.from({ length: 51 }, () => attestationAbout(4, STRANGER_KEY).utxo);
      expect(await reportOn([...goodWorld(), ...strangers])).toEqual({ ...ALL_VALID, principal_binding: 'unreadable' });
    });

    it('gives unreadable for every kind when the node cannot be read, and never absent', async () => {
      expect(await reportIn(withNode(worldOf(goodWorld()), { provider: new DownProvider([]) }))).toEqual(ALL_UNREADABLE);
    });

    it('ends when the budget of the env ends, if the node never answers: every kind is unreadable', async () => {
      const started = Date.now();
      expect(await reportIn(withNode(worldOf(goodWorld()), { provider: new SilentProvider([]), budgetMs: 100 }))).toEqual(ALL_UNREADABLE);
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });

  it('writes no value of an attestation, of the sender or of a failed read to the log', async () => {
    const lines: string[] = [];
    const decoy = attestationAbout(4, MEMBER_KEY, { issuerId: MEMBER_ID });
    await reportIn(worldOf([...goodWorld({ binding: decoy.utxo }), memberRecord(MEMBER_ID, ROOT_KEY, MEMBER_KEY)]), lines);
    await reportIn(withNode(worldOf(goodWorld()), { provider: new DownProvider([]) }), lines);
    const values = [SENDER, SENDER_ID, DELEGATION, MEMBER_ID, decoy.id, ROOT_KEY.keyHash, ROOT_KEY.publicKey, PROVIDER_KEY.keyHash, MEMBER_KEY.keyHash, MEMBER_KEY.publicKey, 'secret-token-123', 'node.example'];
    expect(lines.length).toBe(6);
    for (const line of lines) {
      for (const value of values) expect(line.includes(value), `a line holds ${value.slice(0, 12)}`).toBe(false);
      expect(line).toMatch(/^attestation report: (provenance|software|principal_binding) (valid|invalid|absent|unreadable) rows=\d+( why=[a-z_]+)?$/);
    }
  });
});
