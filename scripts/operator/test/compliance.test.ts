import { readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encodeAttestationDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../checks/lib/format.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { DEPLOYMENT, keyOf } from '../../checks/test/support/world.ts';
import { complianceDocumentOf, replyDocumentOf, writeComplianceDocument } from '../lib/compliance-document.ts';
import { parseArguments, runTask } from '../lib/runner.ts';
import compliance from '../tasks/compliance.ts';
import data from '../usecases/bid-evaluation.ts';
import inventory from '../usecases/inventory-reorder.ts';
import { ALFA, BASE, BRAVO, CHARLIE, DAY_MS, ISSUER, REPLY, SPEC, complianceWorld, publishedOf, sha256, subjectDid, subjectId } from './support/compliance-builds.ts';
import { NOW, hashOf } from './support/task-world.ts';

const ISSUE = ['run', '--locator-base', BASE];
const REVOKE = ['run', '--revoke', '--agent', CHARLIE];
const CONTEST = ['run', '--contest', '--agent', CHARLIE, '--reply-uri', REPLY];

describe('compliance documents and command scope', () => {
  it('uses canonical bytes, their digest and a subject-specific name for each document', () => {
    const did = subjectDid(CHARLIE);
    const statement = complianceDocumentOf({ agent: CHARLIE, statement: SPEC.statement, did });
    const reply = replyDocumentOf({ agent: CHARLIE, text: SPEC.reply.text, did });
    expect(statement).toEqual(publishedOf(CHARLIE));
    expect(reply).toEqual(publishedOf(CHARLIE, true));
    expect(Object.keys(JSON.parse(reply.text))).toEqual(['reply', 'subject']);
    expect(complianceDocumentOf({ agent: CHARLIE, statement: 'A new statement.', did }).name).not.toBe(statement.name);
    expect(() => complianceDocumentOf({ agent: '../other', statement: SPEC.statement, did })).toThrow('agent');
    expect(() => replyDocumentOf({ agent: CHARLIE, text: SPEC.reply.text, did: 'not a DID' })).toThrow('DID');
  });

  it('writes all six documents without keys, approval, fetch or a transaction', async () => {
    const r = await complianceWorld();
    rmSync(r.w.goPath);
    expect(await r.run('run', '--record')).toBe(0);
    const dir = join(r.w.stateDir, 'documents');
    const expected = SPEC.subjects.flatMap((agent) => [publishedOf(agent), publishedOf(agent, true)]);
    expect(readdirSync(dir).sort()).toEqual(expected.map(({ name }) => name).sort());
    for (const { name, text } of expected) {
      const path = join(dir, name);
      expect(readFileSync(path, 'utf8')).toBe(text);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const first = expected[0];
    const inode = statSync(join(dir, first.name)).ino;
    expect(await r.run('run', '--record')).toBe(0);
    expect(statSync(join(dir, first.name)).ino).toBe(inode);
    expect(r.loaded).toEqual([[], []]);
    expect(r.requests).toEqual([]);
    expect(r.hosted.calls).toEqual([]);
    expect(r.w.node.submitted).toEqual([]);
    expect(r.w.facts().compliance).toEqual({});
    expect(r.w.allText()).not.toContain(SPEC.reply.text);
  });

  it('leaves a different existing document or link in place', async () => {
    const { w } = await complianceWorld();
    const document = publishedOf(ALFA);
    const reply = publishedOf(ALFA, true);
    expect(writeComplianceDocument(w.stateDir, document.name, document)).toBe('written');
    expect(writeComplianceDocument(w.stateDir, document.name, document)).toBe('unchanged');
    const path = join(w.stateDir, document.name);
    writeFileSync(path, 'Other bytes.');
    expect(() => writeComplianceDocument(w.stateDir, document.name, document)).toThrow('other bytes');
    expect(readFileSync(path, 'utf8')).toBe('Other bytes.');
    symlinkSync(path, join(w.stateDir, reply.name));
    expect(() => writeComplianceDocument(w.stateDir, reply.name, reply)).toThrow('regular file');
    expect(readFileSync(path, 'utf8')).toBe('Other bytes.');
  });

  it('lists steps and only the keys that their mode needs', () => {
    for (const [args, names, keys] of [
      [ISSUE, SPEC.subjects.map((id) => `attest:${id}`), [ISSUER, 'fee']],
      [REVOKE, [`revoke:${CHARLIE}`], [ISSUER, 'fee']],
      [CONTEST, [`contest:${CHARLIE}`], ['controller', 'fee']],
      [['run', '--record'], [], []],
    ] as const) {
      const { flags } = parseArguments(compliance, args);
      expect(compliance.steps(data, flags)).toEqual(names);
      expect(compliance.needs.keys(data, flags)).toEqual(keys);
    }
    const { flags } = parseArguments(compliance, []);
    expect(compliance.steps(inventory, flags)).toEqual([]);
    expect(compliance.needs.keys(inventory, flags)).toEqual([]);
  });

  it.each([
    ['run', '--record', '--submit'], ['run', '--record', '--revoke', '--agent', CHARLIE], ['run', '--agent', CHARLIE],
    ['run', '--revoke', '--agent', 'another-agent'], ['run', '--contest', '--agent', CHARLIE], [...REVOKE, '--reason', '-9'],
    [...REVOKE, '--reason', '1.5'], [...REVOKE, '--reason', '9007199254740992'], [...ISSUE, '--reply-uri', REPLY],
    ['run', '--locator-base', BASE.replace(/[0-9a-f]{40}/, 'main')],
    [...CONTEST.slice(0, -1), REPLY.replace(/[0-9a-f]{40}/, 'main')],
    [...CONTEST.slice(0, -1), 'https://documents.example.test/reply.json'],
    ['run', '--contest', '--agent', CHARLIE, '--reply-uri', 'http://documents.example.test/reply.json'],
    ['run', '--contest', '--agent', CHARLIE, '--reply-uri', 'https://name:password@documents.example.test/reply.json'],
    ['run', '--contest', '--agent', CHARLIE, '--reply-uri', `https://documents.example.test/${'x'.repeat(256)}`],
  ].map((args) => ({ args })))('refuses flags before a key, fetch or build: $args', async ({ args }) => {
    const r = await complianceWorld();
    expect(await r.run(...args)).toBe(2);
    expect(r.loaded).toEqual([]);
    expect(r.requests).toEqual([]);
    expect(r.hosted.calls).toEqual([]);
  });

  it('refuses run labels for every action before it opens keys, connections or another state stream', async () => {
    const { w, registry, hosted } = await complianceWorld();
    let keyReads = 0;
    let connections = 0;
    const deps = {
      ...w.deps(), hosted,
      readRegistry() { keyReads += 1; return registry; },
      get node() { connections += 1; return w.node; },
    };
    const files = readdirSync(w.stateDir).sort();
    for (const action of [
      [...ISSUE, '--submit'], [...REVOKE, '--submit'], [...CONTEST, '--submit'], ['run', '--record'], ['status'],
      ['cleanup', '--submit'], ['cleanup', '--submit', '--release', hashOf('a test transaction')],
    ]) {
      w.screen.errors.length = 0;
      expect(await runTask(compliance, [...action, '--run=another'], deps), action.join(' ')).toBe(2);
      expect(w.screen.errorText).toContain('compliance takes no --run label');
      expect(readdirSync(w.stateDir).sort()).toEqual(files);
    }
    expect(keyReads).toBe(0);
    expect(connections).toBe(0);
    expect(hosted.calls).toEqual([]);
    expect(w.node.submitted).toEqual([]);
  });
});

describe('issue a compliance attestation', () => {
  it('issues all three with exact authority, document bytes, times and deposit', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all'), r.w.screen.errors.join('\n')).toBe(0);
    expect(r.loaded).toEqual([[ISSUER, 'fee', 'run']]);
    expect(r.w.node.submitted).toHaveLength(3);
    for (const [index, agent] of SPEC.subjects.entries()) {
      const fact = r.factOf(agent);
      const { attestation, lovelace, ref } = await r.view(agent);
      const locator = `${BASE}${publishedOf(agent).name}`;
      const tx = factsOf(r.w.node.submitted[index]);
      expect(tx.witnesses.sort()).toEqual([ISSUER, 'fee'].map((key) => r.registry.hashOf(key)).sort());
      expect(tx.mint).toEqual({ [`${DEPLOYMENT.attestation.hash}${fact.id}`]: 1n });
      expect(lovelace).toBe(5_000_000n);
      expect(attestation).toMatchObject({
        subject: subjectId(agent), issuer: r.registry.publicKeyOf(ISSUER), issuerId: null, attType: 0, format: 50,
        digest: sha256(publishedOf(agent).text), locator: utf8Hex(locator), validUntil: attestation.issuedAt + 365 * DAY_MS,
        solicited: false, envelopeSig: null, contested: null, status: { type: 'AttActive' },
      });
      expect(fact).toEqual({
        id: fact.id, tx: tx.txHash, digest: attestation.digest, locator, issuedAt: iso(attestation.issuedAt), validUntil: iso(attestation.validUntil!),
        revokeTx: null, contestTx: null, replySha256: null, replyUri: null,
      });
      expect(r.w.evidence('compliance')).toContainEqual(expect.objectContaining({ step: `attest:${agent}`, status: 'verified', shows: expect.objectContaining({ attestation_output: ref }) }));
    }
    expect(r.requests.map(({ url, init }) => [url, init?.method, init?.redirect])).toEqual(SPEC.subjects.map((agent) => [`${BASE}${publishedOf(agent).name}`, 'GET', 'manual']));
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    expect(await r.run(...ISSUE, '--submit', '--run', 'another')).toBe(2);
    expect(r.w.node.submitted).toHaveLength(3);
  });

  it('builds only one step in dry mode even with --all, and leaves no fact or attestation', async () => {
    const r = await complianceWorld();
    rmSync(r.w.goPath);
    expect(await r.run(...ISSUE, '--all')).toBe(0);
    expect(r.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', step: `attest:${ALFA}` });
    expect(r.loaded).toEqual([[ISSUER, 'fee']]);
    expect(r.requests).toHaveLength(1);
    expect(r.w.node.submitted).toEqual([]);
    expect(r.held()).toEqual([]);
    expect(r.w.facts().compliance).toEqual({});
  });

  it('keeps the single in-flight issue and reserve when a run label is refused', async () => {
    const r = await complianceWorld();
    r.w.node.neverConfirm = true;
    expect(await r.run(...ISSUE, '--submit')).toBe(1);
    const state = r.w.state('compliance');
    expect(state.in_flight).toMatchObject({ step: `attest:${ALFA}`, tx_hash: factsOf(r.w.node.submitted[0]).txHash });
    const reserves = r.w.exposure();
    expect(reserves).toHaveLength(1);
    const files = readdirSync(r.w.stateDir).sort();
    expect(await r.run(...ISSUE, '--submit', '--run', 'another')).toBe(2);
    expect(r.w.screen.errorText).toContain('compliance takes no --run label');
    expect(r.w.state('compliance')).toEqual(state);
    expect(r.w.exposure()).toEqual(reserves);
    expect(readdirSync(r.w.stateDir).sort()).toEqual(files);
    expect(r.w.node.submitted).toHaveLength(1);
    r.w.node.neverConfirm = false;
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    expect(r.w.node.submitted).toHaveLength(3);
    expect(r.w.state('compliance').in_flight).toBeNull();
    expect(r.factOf(ALFA).tx).toBe(state.in_flight!.tx_hash);
  });

  it('keeps a landed issue pending verification and reads it again without issuing twice', async () => {
    const r = await complianceWorld();
    r.setIssueVisible(false);
    expect(await r.run(...ISSUE, '--submit')).toBe(1);
    expect(r.w.node.submitted).toHaveLength(1);
    expect(r.w.state('compliance').notes[`part.attest:${ALFA}`]).not.toHaveProperty('verified_at');
    expect(r.w.facts().compliance).toEqual({});
    expect(await r.run('run', '--revoke', '--agent', ALFA, '--submit')).toBe(2);
    expect(await r.run('cleanup', '--submit')).toBe(2);
    expect(r.w.node.submitted).toHaveLength(1);
    r.setIssueVisible(true);
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    expect(r.w.node.submitted).toHaveLength(3);
    expect(r.w.state('compliance').notes[`part.attest:${ALFA}`]).toMatchObject({ verified_at: expect.any(String) });
  });

  it.each([
    ['different bytes', () => new Response(`${publishedOf(ALFA).text}\n`)],
    ['a redirect', () => new Response(null, { status: 302, headers: { location: 'https://documents.example.test/other.json' } })],
    ['a missing document', () => new Response(null, { status: 404 })],
    ['an oversized document', () => new Response('x'.repeat(4_097))],
  ] as const)('refuses %s before building', async (_name, response) => {
    const r = await complianceWorld();
    r.routes.set(`${BASE}${publishedOf(ALFA).name}`, response);
    expect(await r.run(...ISSUE, '--submit')).toBe(2);
    expect(r.w.world.chain.evaluations).toEqual([]);
    expect(r.w.node.submitted).toEqual([]);
  });

  it('refuses a missing or held subject before fetching', async () => {
    const missing = await complianceWorld({ noFacts: true });
    expect(await missing.run(...ISSUE)).toBe(2);
    expect(missing.requests).toEqual([]);
    const held = await complianceWorld();
    held.at(ALFA, { status: { type: 'Suspended', holds: [{ by: { type: 'KeyHash', hash: held.registry.hashOf('controller') }, reason: 6, since: NOW - 1_000, until: NOW + DAY_MS }] } });
    expect(await held.run(...ISSUE)).toBe(2);
    expect(held.requests).toEqual([]);
  });

  it.each([[4_000_000n, 4_000_000n], [5_000_000n, 2_000_000n]].map((fee) => ({ fee })))('needs collateral separate from the deposit and fee: $fee', async ({ fee }) => {
    const r = await complianceWorld({ fee });
    expect(await r.run(...ISSUE)).toBe(2);
    expect(r.w.world.chain.evaluations).toEqual([]);
  });

  it('refuses 400 days, a Provider issuer and an issue without its approval tag', async () => {
    const wrongTime = await complianceWorld({ use: { ...data, compliance: { ...SPEC, validDays: 400 } } });
    expect(await wrongTime.run(...ISSUE)).toBe(2);
    const wrongIssuer = await complianceWorld({ use: { ...data, compliance: { ...SPEC, issuerKey: 'provider' } } });
    expect(await wrongIssuer.run(...ISSUE)).toBe(2);
    expect(wrongIssuer.loaded).toEqual([]);
    const ok = await complianceWorld();
    ok.go({ irreversible: [] });
    expect(await ok.run(...ISSUE, '--submit')).toBe(2);
    expect(ok.w.node.submitted).toEqual([]);
    expect(ok.w.screen.errors.join('\n')).toContain('attestation');
  });
});

describe('revoke and reply', () => {
  it('binds the Sourcing reader and the facts to the confirmed revoke and reply', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    const issued = r.factOf(CHARLIE);
    expect(await r.sourcing(CHARLIE)).toMatchObject({ state: 'valid', attestation: issued.id, attestation_state: 'active' });
    const revoke = await r.buildRevoke();
    expect(await r.run(...REVOKE, '--submit')).toBe(0);
    const first = await r.view(CHARLIE);
    expect(first.revokeReason).toBe(9n);
    expect(first.attestation.status).toEqual({ type: 'AttRevoked', at: revoke.validFrom, reason: 9 });
    expect(first.ref).toBe(`${revoke.txHash}#${revoke.outputIndex}`);
    expect(r.factOf(CHARLIE).revokeTx).toBe(revoke.txHash);
    expect(r.w.evidence('compliance')).toContainEqual(expect.objectContaining({
      step: `revoke:${CHARLIE}`, status: 'verified', shows: {
        agent: CHARLIE, attestation_id: issued.id, attestation_output: first.ref, subject: subjectId(CHARLIE),
        issuer_key_hash: r.registry.hashOf(ISSUER), reason: 9, revoked_at: iso(revoke.validFrom),
      },
    }));
    const reply = publishedOf(CHARLIE, true);
    const contest = await r.buildContest();
    r.go({ irreversible: [] });
    expect(await r.run(...CONTEST, '--submit')).toBe(0);
    expect((await r.view(CHARLIE)).attestation.contested).toEqual({ uri: utf8Hex(REPLY), sha256: sha256(reply.text) });
    expect(r.factOf(CHARLIE)).toEqual({ ...issued, revokeTx: revoke.txHash, contestTx: contest.txHash, replySha256: reply.sha256, replyUri: REPLY });
    expect(r.hosted.calls.filter(({ name }) => name.startsWith('vector_build_'))).toEqual([
      { name: 'vector_build_attestation_revoke', args: { changeAddress: r.fee, attestation: issued.id, by: 'issuer', reason: 9 } },
      { name: 'vector_build_attestation_contest', args: { changeAddress: r.fee, attestation: issued.id, uri: REPLY, sha256: reply.sha256 } },
    ]);
    for (const [index, signers] of [[3, [ISSUER, 'fee']], [4, ['controller', 'fee']]] as const) {
      expect(factsOf(r.w.node.submitted[index]).witnesses.sort()).toEqual(signers.map((key) => r.registry.hashOf(key)).sort());
    }
    expect(r.loaded.slice(1)).toEqual([[ISSUER, 'fee', 'run'], ['controller', 'fee', 'run']]);
    expect(await r.sourcing(CHARLIE)).toMatchObject({ state: 'invalid', attestation_state: 'revoked', revoke_reason: '9', contested: { sha256: reply.sha256 } });
    expect(await r.sourcing(ALFA)).toMatchObject({ state: 'valid' });
    expect(await r.run('status')).toBe(0);
    expect(r.w.screen.lines.join('\n')).toContain(`reply SHA-256 ${reply.sha256}`);
    expect(r.w.allText()).not.toContain(SPEC.reply.text);
  });

  it('refuses missing facts, a contest on an active attestation, and a revoke without its tag', async () => {
    const r = await complianceWorld();
    expect(await r.run(...REVOKE, '--submit')).toBe(2);
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    expect(r.hosted.calls).toEqual([]);
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    r.go({ irreversible: ['attestation'] });
    expect(await r.run(...REVOKE, '--submit')).toBe(2);
    expect(r.hosted.calls.every(({ name }) => name === 'vector_get_attestation')).toBe(true);
    expect(r.w.node.submitted).toHaveLength(3);
  });

  it('requires the verified revoke and the issuer of the verified issue before a reply', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    const revoke = await r.buildRevoke();
    const list = r.w.world.chain.getUtxos.bind(r.w.world.chain);
    const lag = vi.spyOn(r.w.world.chain, 'getUtxos').mockImplementation(async (address) => (await list(address)).filter(({ txHash }) => txHash !== revoke.txHash));
    expect(await r.run(...REVOKE, '--submit')).toBe(1);
    lag.mockRestore();
    expect((await r.view(CHARLIE)).attestation.status.type).toBe('AttRevoked');
    expect(r.factOf(CHARLIE).revokeTx).toBeNull();
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    expect(r.w.screen.errorText).toContain(`the step revoke:${CHARLIE} is not verified`);
    expect(await r.run(...REVOKE, '--submit')).toBe(0);
    expect(r.factOf(CHARLIE).revokeTx).toBe(revoke.txHash);

    const view = await r.view(CHARLIE);
    const actual = r.w.world.chain.held;
    r.w.world.chain.held = actual.map((out) => out.txHash === view.utxo.txHash && out.outputIndex === view.utxo.outputIndex
      ? { ...out, datum: encodeAttestationDatum({ ...view.attestation, issuer: keyOf(17, 'agent').publicKeyHex }) } : out);
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    r.w.world.chain.held = actual;
    expect(r.w.screen.errorText).toContain(`the node does not show the verified compliance output of ${CHARLIE}`);
    expect(r.requests).toHaveLength(3);
    expect(r.hosted.calls.every(({ name }) => name !== 'vector_build_attestation_contest')).toBe(true);
    expect(r.w.node.submitted).toHaveLength(4);
    await r.buildContest();
    expect(await r.run(...CONTEST, '--submit')).toBe(0);
    expect(r.w.node.submitted).toHaveLength(5);
  });

  it('refuses a different revoke reason or attestation in the hosted body', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    await r.buildRevoke(ALFA);
    expect(await r.run(...REVOKE, '--submit')).toBe(2);
    await r.buildRevoke(CHARLIE, 3);
    expect(await r.run(...REVOKE, '--submit')).toBe(2);
    expect(r.w.node.submitted).toHaveLength(3);
    expect(await r.run(...REVOKE, '--reason', '3', '--submit')).toBe(0);
    expect(await r.run(...REVOKE, '--submit', '--run', 'again')).toBe(2);
    expect((await r.view(CHARLIE)).revokeReason).toBe(3n);
  });

  it('checks reply bytes, the current controller and the hosted anchor before landing', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    await r.buildRevoke();
    expect(await r.run(...REVOKE, '--submit')).toBe(0);
    expect(await r.run(...CONTEST.slice(0, -1), `${BASE}${publishedOf(BRAVO, true).name}`, '--submit')).toBe(2);
    expect(r.w.screen.errorText).toContain(`--reply-uri must name ${publishedOf(CHARLIE, true).name}`);
    expect(r.requests).toHaveLength(3);
    r.routes.set(REPLY, () => new Response(publishedOf(BRAVO, true).text));
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    expect(r.hosted.calls.some(({ name }) => name === 'vector_build_attestation_contest')).toBe(false);
    r.routes.set(REPLY, () => new Response(publishedOf(CHARLIE, true).text));
    const foreign = keyOf(17, 'agent').publicKeyHex;
    r.at(CHARLIE, { controller: foreign });
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    expect(r.hosted.calls.some(({ name }) => name === 'vector_build_attestation_contest')).toBe(false);
    await r.buildContest();
    r.at(CHARLIE, { controller: r.registry.publicKeyOf('controller') });
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    await r.buildContest(CHARLIE, REPLY, hashOf('another document'));
    expect(await r.run(...CONTEST, '--submit')).toBe(2);
    expect(r.w.node.submitted).toHaveLength(4);
    expect(r.factOf(CHARLIE).contestTx).toBeNull();
    await r.buildContest();
    expect(await r.run(...CONTEST, '--submit')).toBe(0);
    expect(r.w.node.submitted).toHaveLength(5);
  });
});

describe('compliance cleanup', () => {
  it('waits for the earlier chain date plus the build lead, then burns only due tokens', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit', '--all')).toBe(0);
    await r.buildRevoke();
    expect(await r.run(...REVOKE, '--submit')).toBe(0);
    const revoked = await r.view(CHARLIE);
    const unrevoked = await r.view(ALFA);
    const fromRevoke = revoked.withdrawableFrom!;
    const fromEnd = unrevoked.withdrawableFrom!;
    expect(fromRevoke).toBe(NOW - 60_000 + 90 * DAY_MS);
    expect(fromEnd).toBe(unrevoked.attestation.validUntil! + 90 * DAY_MS);
    r.travel(fromRevoke + 59_999);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.w.screen.lines.join('\n')).toContain(iso(fromRevoke));
    expect(r.w.node.submitted).toHaveLength(4);
    r.travel(fromRevoke + 60_000);
    expect(await r.run('cleanup')).toBe(0);
    expect(r.w.machine().outcome).toBe('dry');
    expect(r.w.node.submitted).toHaveLength(4);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    const tx = factsOf(r.w.node.submitted[4]);
    expect(tx.inputs).toContain(revoked.ref);
    expect(tx.mint).toEqual({ [`${DEPLOYMENT.attestation.hash}${revoked.id}`]: -1n });
    expect(tx.outputs.every(({ address }) => address === r.fee)).toBe(true);
    expect(tx.witnesses.sort()).toEqual([ISSUER, 'fee'].map((key) => r.registry.hashOf(key)).sort());
    expect(r.w.evidence('compliance')).toContainEqual(expect.objectContaining({
      step: `withdraw:${CHARLIE}`, status: 'verified', shows: expect.objectContaining({
        tx_hash: tx.txHash, attestation_before: revoked.ref, released_lovelace: String(revoked.lovelace), net_lovelace: String(revoked.lovelace - tx.feeLovelace),
      }),
    }));
    expect(r.held()).toHaveLength(2);
    r.travel(fromEnd + 60_000);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.held()).toEqual([]);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.w.node.submitted).toHaveLength(7);
  });

  it('fails cleanup for an unexplained missing output', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit')).toBe(0);
    const view = await r.view(ALFA);
    r.w.world.chain.held = r.w.world.chain.held.filter((out) => `${out.txHash}#${out.outputIndex}` !== view.ref);
    expect(await r.run('cleanup', '--submit')).toBe(1);
    expect(r.w.screen.errorText).toContain('the state has no withdrawal');
    expect(r.w.screen.lines.join('\n')).not.toContain('the deposit returned');
    expect(r.w.node.submitted).toHaveLength(1);
  });

  it('keeps the landed withdrawal pending until the ledger proves the consumed output and net repayment', async () => {
    const r = await complianceWorld();
    expect(await r.run(...ISSUE, '--submit')).toBe(0);
    r.travel((await r.view(ALFA)).withdrawableFrom! + 60_000);
    r.setWithdrawalRead((row) => ({ ...row, outputs: row.outputs.map((out) => ({ ...out, value: String(BigInt(out.value) - 1n) })) }));
    expect(await r.run('cleanup', '--submit')).toBe(1);
    const part = `part.withdraw:${ALFA}`;
    expect(r.w.state('compliance').notes[part]).not.toHaveProperty('verified_at');
    expect(r.w.screen.lines.join('\n')).not.toContain('the deposit returned');
    expect(r.w.node.submitted).toHaveLength(2);
    r.setWithdrawalRead((row) => ({
      ...row, inputs: row.inputs.map((input) => input.payment_addr.bech32 === DEPLOYMENT.attestation.address ? { ...input, tx_hash: hashOf('another input') } : input),
    }));
    expect(await r.run('cleanup', '--submit')).toBe(1);
    r.setWithdrawalRead((row) => ({ ...row, plutus_contracts: row.plutus_contracts.map((run) => ({ ...run, valid_contract: false })) }));
    expect(await r.run('cleanup', '--submit')).toBe(1);
    expect(r.w.state('compliance').notes[part]).not.toHaveProperty('verified_at');
    expect(r.w.node.submitted).toHaveLength(2);
    r.setWithdrawalRead((row) => row);
    expect(await r.run('cleanup', '--submit')).toBe(0);
    expect(r.w.state('compliance').notes[part]).toHaveProperty('verified_at');
    expect(r.w.screen.lines.join('\n')).toContain('the deposit returned to the fee wallet');
    expect(r.w.node.submitted).toHaveLength(2);
  });
});
