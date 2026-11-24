// Test the real end-state task on a shared offline fixture. Each check has its own result and exit code.
import {
  COINS_PER_BYTE, DAY, HOUR, MANIFEST_URL, ORDER, ORDER_ID, READER_ID, RECLAIM_TX, REORDER_ID, datumOf, did, hash, makeRig, ref,
} from './support/end-state-world.ts';
import type { Result, Rig } from './support/end-state-world.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { testKey } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { MODULE1, agentRecord, claimUtxo, recordUtxo } from '../../../packages/buyer-core/test/fixtures/jury-world.ts';
import { MAINNET, delegation, delegationUtxo, recordUtxo as registryUtxo } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { decodeIdentityAdvertDatum, encodeIdentityAdvertDatum } from '../../../packages/vector-read/src/index.ts';
import { decodeIdentityDatum, encodeIdentityDatum, encodeIdentitySpend } from '../../../packages/vector-read/src/identity-codec.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { iso } from '../../checks/lib/format.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { blake2b256Hex } from '../lib/platform.ts';
import { LEGACY_PUBLIC_MANIFEST, publicManifestFile, writePublicManifest } from '../lib/registry.ts';
import endState from '../tasks/end-state.ts';
import data from '../usecases/inventory-reorder.ts';
import bidEvaluation from '../usecases/bid-evaluation.ts';
import priorAuthorization from '../usecases/prior-authorization.ts';
import { NOW, USE_CASE } from './support/task-world.ts';

const CLAIM_TOKEN = `636c6d5f${'0f'.repeat(28)}`;
const CONTAINERS = data.agents.flatMap((agent) => agent.adverts.map((advert) => advert.runtimeContainer));
const STATUS_URLS = data.agents.flatMap((agent) => agent.adverts.map((advert) => `${advert.origin}/status`));
const SLOW = 240_000;
const FAIR_FLOAT = 1_000_000_000n;
const holdOf = (by: { type: 'Script'; hash: string } | { type: 'KeyHash'; hash: string }, reason: number, until: number) => ({ by, reason, since: NOW - 2 * HOUR, until });
const JURY_UNTIL = NOW + 7 * DAY - 2 * HOUR;
const JURY_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'Script', hash: MODULE1.claim.hash }, 64, JURY_UNTIL)] } }));
const PARTY_UNTIL = NOW + DAY;
const PARTY_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, PARTY_UNTIL)] } }));
const MIXED_HELD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'Script', hash: MODULE1.claim.hash }, 64, JURY_UNTIL), holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, PARTY_UNTIL)] } }));
const EXPIRED_HOLD = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Suspended', holds: [holdOf({ type: 'KeyHash', hash: testKey(3).keyHash }, 6, NOW - HOUR)] } }));
const REVOKED = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: NOW - DAY, invalidFrom: null, successor: null } }));
const RETIRED = recordUtxo(ORDER_ID, agentRecord({ status: { type: 'Retired', at: NOW - DAY, successor: null } }));

const ALL_CHECKS = [
  'record_active:reorder-agent', 'record_active:order-desk', 'organisation:reorder-agent', 'organisation:order-desk', 'adverts', 'claims:reorder-agent', 'claims:order-desk', 'delegations', 'holds', 'wallets',
  'attestations', 'runtimes', 'subagents:reorder-agent',
];

/** Every check has the result that `expected` gives for its name, and `ok` when it gives none. */
function expectChecks(rig: Rig, expected: Record<string, Result> = {}): void {
  const found = rig.checks();
  expect([...found.keys()]).toEqual(ALL_CHECKS);
  for (const [name, check] of found) expect(check.result, `${name}: ${check.text}`).toBe(expected[name] ?? 'ok');
}

async function expectFailure(rig: Rig, name: string, detail: string): Promise<void> {
  expect(await rig.run(), rig.errors()).toBe(1);
  expect(rig.checks().get(name)).toMatchObject({ result: 'fail', text: expect.stringContaining(detail) });
  expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { verdict: 'fail' } });
}

const openClaim = (over: { claimer?: string; ageMs?: number; windowMs?: number; token?: string; tx?: string; state?: 'Open' | 'Challenged' | 'Validated' | 'Invalidated' } = {}) => ({
  ...claimUtxo(over.token ?? CLAIM_TOKEN, { claimerDid: over.claimer ?? REORDER_ID, challengeWindow: over.windowMs ?? 4 * HOUR, state: over.state ?? 'Open' }, over.ageMs ?? HOUR), txHash: over.tx ?? 'cc'.repeat(32),
});

const claimFact = (over: Record<string, unknown> = {}) => ({
  claimRef: ref('claim'), documentTx: hash('claim document'), claimTx: hash('claim'), claimToken: CLAIM_TOKEN, stakeLovelace: '50000000', windowMs: 86_400_000, stakedAt: iso(NOW - HOUR), withdrawableFrom: iso(NOW + 3 * HOUR),
  withdrawTx: null, ...over,
});

describe('the task end-state', () => {
  it('needs no key, a chain, the two hosted tools that it reads, and no approval, and has no step and no flag', () => {
    expect(endState.name).toBe('end-state');
    expect(endState.needs.keys(data, { has: () => false, value: () => undefined })).toEqual([]);
    expect(endState.needs.chain).toBe(true);
    expect([...endState.needs.hosted].sort()).toEqual(['vector_marketplace_list_suppliers', 'vector_resolve_did']);
    expect(endState.needs.approval).toBe('never');
    expect(endState.steps(data, { has: () => false, value: () => undefined })).toEqual([]);
    expect(endState.flags).toEqual([]);
    expect(endState.valued).toEqual([]);
  });

  describe('a state in which all is well', () => {
    it('gives exit 0, keeps the twelve original checks, checks the live subagent, and prints DONE', async () => {
      const rig = await makeRig();
      expect(await rig.run()).toBe(0);
      expectChecks(rig);
      expect(rig.world.screen.lines).toContain('end state: DONE: every check is ok');
      expect(rig.world.screen.lines).toContain('the end state is reached: every check is ok');
      const line = rig.world.machine();
      expect(line).toMatchObject({ task: 'end-state', command: 'run', outcome: 'finished', exit: 0, step: null, result: { verdict: 'done' } });
      expect((line.result.checks as unknown[]).length).toBe(ALL_CHECKS.length);
    }, SLOW);

    it('reads only: the ledger takes no transaction, the facts and the state hold nothing new, and no runtime or manifest read is a write', async () => {
      const rig = await makeRig();
      expect(await rig.run('--submit')).toBe(0);
      expect(rig.ledger.accepted).toEqual([]);
      expect(rig.ledger.raw).toEqual([]);
      expect(rig.world.state('end-state').steps).toEqual({});
      expect(rig.world.state('end-state').in_flight).toBeNull();
      expect(rig.webCalls.filter((url) => !STATUS_URLS.includes(url))).toEqual([MANIFEST_URL]);
    }, SLOW);

    it('says in each line what is so: the DID, the date of the deposit of each attestation, the adverts and the runtimes', async () => {
      const rig = await makeRig();
      await rig.run();
      const found = rig.checks();
      expect(found.get('record_active:reorder-agent')!.text).toBe(`the record ${did(REORDER_ID)} is Active`);
      expect(found.get('organisation:order-desk')!.text).toContain(data.organisations[1]!.domain);
      expect(found.get('adverts')!.text).toContain('reorder-agent 1, order-desk 3');
      expect(found.get('runtimes')!.text).toContain('orders-large-runtime');
      for (const agent of data.agents) for (const type of ['provenance', 'software']) {
        expect(found.get('attestations')!.text).toContain(`${agent.id}/${type} ${hash(`attestation ${agent.id} ${type}`)} is listed in vectorProvenance, valid until ${iso(NOW + 300 * DAY)}, deposit due ${iso(NOW + 390 * DAY)}`);
      }
    }, SLOW);

    it('shows the same lines with status, and ends the machine line with the outcome done and exit 0', async () => {
      const rig = await makeRig();
      expect(await rig.observe('status')).toMatchObject({ exit: 0, signatures: 0, submissions: 0 });
      expectChecks(rig);
      expect(rig.world.screen.lines).toContain('end state: DONE: every check is ok');
      expect(rig.world.machine()).toMatchObject({ command: 'status', outcome: 'done', exit: 0 });
    }, SLOW);
  });

  describe('the other use cases', () => {
    it('accepts the active parent with two ended children, the spent advert and the stopped runtime', async () => {
      const rig = await makeRig({}, priorAuthorization);
      const status = await rig.observe('status');
      expect(status, status.errors).toMatchObject({ exit: 0, signatures: 0, submissions: 0 });
      expect([...rig.checks().keys()]).toEqual([
        'record_active:prior-authorization-agent', 'record_active:insurer-intake-agent', 'organisation:prior-authorization-agent', 'organisation:insurer-intake-agent',
        'adverts', 'claims:prior-authorization-agent', 'claims:insurer-intake-agent', 'delegations', 'holds', 'wallets', 'attestations', 'runtimes',
        'subagents:prior-authorization-agent',
      ]);
      for (const check of rig.checks().values()) expect(check.result, check.text).toBe('ok');
      expect(rig.checks().get('adverts')!.text).toContain('insurer-intake-agent 1');
      expect(rig.checks().get('subagents:prior-authorization-agent')!.text).toContain('revoked (record-reader, drafter)');
      expect(rig.checks().get('runtimes')!.text).toContain('the retired runtimes are stopped (priorauth-runtime)');
      expect(rig.webCalls).not.toContain(priorAuthorization.agents[0]!.statusUrls[0]);
      expect(rig.protocolRequests).toEqual([]);
    }, SLOW);

    it('refuses a live or unrelated child, an unavailable child, and the absence of an end fact', async () => {
      const rig = await makeRig({}, priorAuthorization);
      const child = did(rig.idOf('drafter'));
      const original = rig.gateway.get(child)!;
      const name = 'subagents:prior-authorization-agent';
      rig.gateway.set(child, { ...original, effective: 'active' });
      await expectFailure(rig, name, 'does not show drafter as revoked');
      rig.gateway.set(child, { ...original, parent: { parent: did(rig.idOf('insurer-intake-agent')), parentEpoch: 0, depth: 1 } });
      await expectFailure(rig, name, 'does not show drafter as a direct child of the expected parent');
      rig.gateway.delete(child);
      await expectFailure(rig, name, 'the gateway knows no such record');
      const missing = await makeRig({ skipSubagentEnd: true }, priorAuthorization);
      await expectFailure(missing, name, 'the facts hold no end of the subagents');
    }, SLOW);

    it('does not credit an end operation for children from an older epoch', async () => {
      const rig = await makeRig({ subagentEpochBefore: 1 }, priorAuthorization);
      const parent = 'prior-authorization-agent';
      await expectFailure(rig, `subagents:${parent}`, 'at epoch 1');
    }, SLOW);

    it('requires the named parent spend and the BumpEpoch action', async () => {
      const rig = await makeRig({}, priorAuthorization);
      const parent = 'prior-authorization-agent';
      const fact = rig.facts.read().subagentEnds[parent]!;
      const history = rig.history.get(fact.tx)!;
      const original = history.plutus_contracts[0]!.input.redeemer.datum;
      history.plutus_contracts[0]!.input.redeemer.datum = datumOf(encodeIdentitySpend({ type: 'ChangeController' }));
      await expectFailure(rig, `subagents:${parent}`, 'did not spend that parent record with BumpEpoch');
      history.plutus_contracts[0]!.input.redeemer.datum = original;
      expect(await rig.run('status')).toBe(0);
    }, SLOW);

    it('refuses a retired advert runtime that is still running and a live outgoing child delegation', async () => {
      const rig = await makeRig({}, priorAuthorization);
      rig.writeRunning(['intake-runtime', 'priorauth-runtime']);
      await expectFailure(rig, 'runtimes', 'the retired runtime priorauth-runtime is still running');
      rig.writeRunning();
      rig.ledger.live.push(delegationUtxo(hash('outgoing delegation'), delegation({
        delegate: hash('another agent'), delegator: { type: 'Agent', id: rig.idOf('record-reader') }, parent: hash('parent'), depth: 2,
      })));
      await expectFailure(rig, 'delegations', 'is live, delegator agent');
    }, SLOW);

    it('accepts the bid end state with one desk listed, terminal records and two retired adverts', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const run = await rig.observe('run');
      expect(run, run.errors).toMatchObject({ exit: 0, signatures: 0, submissions: 0 });
      for (const check of rig.checks().values()) expect(check.result, check.text).toBe('ok');
      expect(rig.checks().get('record:bid-desk-bravo')!.text).toContain(`Retired and names the successor ${did(rig.idOf('bravo-successor'))}`);
      expect(rig.checks().get('record:bid-desk-charlie')!.text).toContain('Revoked and matches the facts');
      expect(rig.checks().get('organisation:bravo-successor')!.result).toBe('ok');
      expect(rig.checks().get('subagents:sourcing-agent')!.text).toContain('Active (scorer-1, scorer-2, scorer-3)');
      const advertised = rig.checks().get('adverts')!.text;
      expect(advertised).toContain('(sourcing-agent 1, bid-desk-alfa 1)');
      expect(advertised).toContain('bid-desk-bravo/bid-desk-v1');
      expect(advertised).toContain('bid-desk-charlie/bid-desk-v1');
      const quotes = bidEvaluation.agents[1]!.capability;
      expect(rig.hosted.calls.filter(({ name, args }) => name === 'vector_marketplace_list_suppliers' && args.capability_id === quotes)).toEqual([
        { name: 'vector_marketplace_list_suppliers', args: { capability_id: quotes, only_free: false, limit: 50 } },
      ]);
      expect(rig.checks().get('attestations')!.text).toContain('bid-desk-bravo/software');
      expect(rig.checks().get('attestations')!.text).toContain('is on the node, valid until');
      const gatewayDids = rig.hosted.calls.filter(({ name }) => name === 'vector_resolve_did').map(({ args }) => args.did);
      expect(gatewayDids).not.toContain(did(rig.idOf('bid-desk-bravo')));
      expect(gatewayDids).not.toContain(did(rig.idOf('bid-desk-charlie')));
      const compliance = rig.checks().get('compliance')!.text;
      expect(compliance).toContain(`is revoked with reply ${hash('reply')}, deposit due ${iso(NOW + 88 * DAY)}`);
      expect(compliance).toContain(`is active, deposit due ${iso(NOW + 390 * DAY)}`);
      expect(rig.checks().get('lifecycle')!.text).toContain('the deposit above the ledger minimum was reclaimed');
      expect(rig.protocolRequests).toEqual([{ jsonrpc: '2.0', method: 'queryLedgerState/protocolParameters', params: {}, id: 'end-state' }]);
    }, SLOW);

    it('does not let one desk stand for another or ignore a retired advert from the same capability', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const alfa = rig.listing.find((row) => row.agent_id === rig.idOf('bid-desk-alfa'))!;
      const original = [...rig.listing];
      const bravo = rig.facts.read().adverts['bid-desk-bravo']!['bid-desk-v1']!;
      rig.listing = [...original, { ...alfa, advert_ref: bravo.ref, agent_id: rig.idOf('bid-desk-bravo'), did: did(rig.idOf('bid-desk-bravo')) }];
      await expectFailure(rig, 'adverts', 'the indexer still lists the retired advert bid-desk-bravo/bid-desk-v1');
      rig.listing = original.map((row) => row === alfa ? { ...row, agent_id: rig.idOf('bid-desk-charlie'), did: did(rig.idOf('bid-desk-charlie')) } : row);
      await expectFailure(rig, 'adverts', 'another record or model, not bid-desk-alfa/bid-desk-v1');
      rig.listing = [...original, { ...alfa, advert_ref: ref('foreign advert'), agent_id: hash('foreign desk'), did: did(hash('foreign desk')) }];
      await expectFailure(rig, 'adverts', 'an advert of the capability');
      rig.listing = original;
      rig.ledger.live.push({ txHash: bravo.tx, outputIndex: 0, address: MAINNET.advert.address, assets: { lovelace: 2_500_000n } });
      await expectFailure(rig, 'adverts', 'the node still holds an unspent output for a retired advert');
    }, SLOW);

    it('fails closed if the node cannot read the live advert address', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const read = rig.ledger.getUtxos.bind(rig.ledger);
      vi.spyOn(rig.ledger, 'getUtxos').mockImplementation(async (address) => {
        if (address === MAINNET.advert.address) throw new Error('the advert output lookup failed');
        return read(address);
      });
      await expectFailure(rig, 'adverts', 'cannot tell: the advert output lookup failed');
      expect(rig.checks().get('lifecycle')!.result).toBe('ok');
      expect(await rig.run('status')).toBe(1);
      expect(rig.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      expect(rig.world.screen.text).not.toContain('end state: DONE');
    }, SLOW);

    it('follows an updated advert to a confirmed retire that credits the supplier', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const name = 'bid-desk-bravo';
      const model = 'bid-desk-v1';
      const original = rig.facts.read().adverts[name]![model]!;
      const prior = rig.ledger.koiosSpent.find(({ txHash }) => txHash === original.tx)!;
      const datum = decodeIdentityAdvertDatum(prior.datum!);
      const successor = { ...prior, txHash: hash('replacement Bravo'), datum: encodeIdentityAdvertDatum({ ...datum, status: 'Retired' }) };
      const retirement = rig.retireAdvert(name, model, successor);
      rig.archive(successor.txHash, prior, successor, MAINNET.advert.hash, 'd87a80');
      rig.ledger.live.push(successor);
      await expectFailure(rig, 'adverts', 'the node still holds the traced advert output');
      expect(rig.listing.some(({ advert_ref }) => advert_ref === `${successor.txHash}#0`)).toBe(false);
      rig.ledger.live.pop();
      // The script allows a new output to name any record. This output is not part of the spend history.
      rig.ledger.live.push({ ...prior, txHash: hash('unrelated advert with same datum') });
      rig.history.delete(successor.txHash);
      await expectFailure(rig, 'adverts', 'does not confirm the exact spend');
      rig.archive(successor.txHash, prior, successor, MAINNET.advert.hash, 'd87a80');
      const tx = rig.history.get(retirement)!;
      const paid = tx.outputs[0]!.value;
      tx.outputs[0]!.value = String(BigInt(paid) - 1n);
      await expectFailure(rig, 'adverts', 'supplier net credit is not the advert deposit minus the actual fee');
      tx.outputs[0]!.value = paid;
      expect(await rig.run('status')).toBe(0);
    }, SLOW);

    it('accepts the matching retirement in a labelled journal and rejects distinct matching receipts', async () => {
      const rig = await makeRig({ advertRun: 'shutdown-1' }, priorAuthorization);
      const agent = priorAuthorization.agents[0]!;
      const model = agent.adverts[0]!.model;
      const original = rig.facts.read().adverts[agent.id]![model]!;
      const prior = rig.ledger.koiosSpent.find(({ txHash }) => txHash === original.tx)!;
      expect(await rig.run('status')).toBe(0);
      const step = `part.retire:${agent.id}:${model}`;
      const named = StateFile.peek(join(rig.world.stateDir, 'advert.shutdown-1.state.json'))!;
      const defaultJournal = StateFile.open(join(rig.world.stateDir, 'advert.state.json'), { check: 'advert', network: named.network, record: priorAuthorization.name });
      defaultJournal.setNote(step, named.notes[step]);
      expect(await rig.run('status')).toBe(0);
      rig.retireAdvert(agent.id, model, { ...prior, txHash: hash('old unrelated advert') }, 'previous');
      expect(await rig.run('status')).toBe(0);
      rig.retireAdvert(agent.id, model, prior, 'other-receipt');
      await expectFailure(rig, 'adverts', 'more than one confirmed receipt matches');
    }, SLOW);

    it('requires the listed reference, supplier, datum and pure deposit to agree across the two sources', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const id = rig.idOf('bid-desk-alfa');
      const row = rig.listing.find(({ agent_id }) => agent_id === id)!;
      const output = rig.ledger.at(row.advert_ref)!;
      const datum = decodeIdentityAdvertDatum(output.datum!);
      const otherSupplier = testKey(5).keyHash;
      row.supplier_pkh = otherSupplier;
      await expectFailure(rig, 'adverts', 'the indexer lists');
      expect(rig.checks().get('adverts')!.text).toContain('for another supplier');
      row.supplier_pkh = datum.supplier_pkh;
      const rest = rig.ledger.live.filter((one) => one !== output);
      rig.ledger.live = rest;
      await expectFailure(rig, 'adverts', 'the node does not hold the listed advert bid-desk-alfa');
      for (const altered of [
        { ...output, datum: encodeIdentityAdvertDatum({ ...datum, supplier_pkh: otherSupplier }) },
        { ...output, datum: encodeIdentityAdvertDatum({ ...datum, model: 'other-model' }) },
        { ...output, datum: encodeIdentityAdvertDatum({ ...datum, status: 'Retired' }) },
        { ...output, assets: { ...output.assets, [MAINNET.attestation.hash + hash('other asset')]: 1n } },
      ]) {
        rig.ledger.live = [...rest, altered];
        await expectFailure(rig, 'adverts', 'does not match the advert of bid-desk-alfa/bid-desk-v1');
      }
      rig.ledger.live = [...rest, output];
      expect(await rig.run('status')).toBe(0);
    }, SLOW);

    it('requires the exact terminal status, successor and revocation facts', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const bravo = rig.idOf('bid-desk-bravo');
      const original = rig.ledger.at(`${RECLAIM_TX}#0`)!;
      rig.setRecord(bravo, registryUtxo(bravo, agentRecord({
        keys: [], parties: [], status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 9, invalidFrom: null, at: NOW - DAY, successor: null },
      })));
      await expectFailure(rig, 'record:bid-desk-bravo', 'is Revoked: it must be Retired');
      rig.setRecord(bravo, registryUtxo(bravo, agentRecord({ keys: [], parties: [], status: { type: 'Retired', at: NOW - DAY, successor: null } })));
      await expectFailure(rig, 'record:bid-desk-bravo', 'does not name the expected successor');
      rig.setRecord(bravo, original);
      const successor = rig.idOf('bravo-successor');
      rig.gateway.get(did(successor))!.verified = false;
      await expectFailure(rig, 'organisation:bravo-successor', 'does not show the organisation');
      rig.gateway.get(did(successor))!.verified = true;
      rig.setRecord(successor, registryUtxo(successor, agentRecord({ keys: [], parties: [], status: { type: 'Retired', at: NOW - DAY, successor: null } })));
      await expectFailure(rig, 'record:bid-desk-bravo', 'is not an Active root record');
      rig.facts.put('revocations', ['bid-desk-charlie'], { ...rig.facts.read().revocations['bid-desk-charlie'], reason: 8 }, { replace: true });
      await expectFailure(rig, 'record:bid-desk-charlie', 'on the node does not match the facts');
    }, SLOW);

    it('requires the Accountable author and a recorded invalidation time for the revoked desk', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const subject = 'bid-desk-charlie';
      const id = rig.idOf(subject);
      const out = rig.ledger.live.find(({ assets }) => assets[MAINNET.identity.hash + id] === 1n)!;
      const datum = decodeIdentityDatum(out.datum!);
      if (datum.status.type !== 'Revoked') throw new Error('the fixture needs a revoked datum');
      rig.setRecord(id, { ...out, datum: encodeIdentityDatum({ ...datum, status: { ...datum.status, by: { type: 'ControllerSet' } } }) });
      await expectFailure(rig, `record:${subject}`, 'is not from the Accountable key');
      rig.setRecord(id, { ...out, datum: encodeIdentityDatum({ ...datum, status: { ...datum.status, invalidFrom: null } }) });
      const fact = rig.facts.read().revocations[subject]!;
      rig.facts.put('revocations', [subject], { ...fact, invalidFrom: null }, { replace: true });
      await expectFailure(rig, `record:${subject}`, 'has no usable invalidation time');
    }, SLOW);

    it('requires the compliance contest transaction and verifies the reply and the Provider output on the node', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const charlie = 'bid-desk-charlie';
      const original = rig.facts.read().compliance[charlie]!;
      rig.facts.put('compliance', [charlie], { ...original, contestTx: null }, { replace: true });
      await expectFailure(rig, 'compliance', 'no complete revoke and contest');
      rig.facts.put('compliance', [charlie], { ...original, replySha256: hash('other reply') }, { replace: true });
      await expectFailure(rig, 'compliance', 'the reply to the compliance attestation of bid-desk-charlie does not match the facts on the node');
      rig.facts.put('compliance', [charlie], original, { replace: true });
      const revokeTx = original.revokeTx!;
      const revoke = rig.history.get(revokeTx)!;
      const history = revoke.outputs[0]!;
      history.asset_list = [...rig.history.get(RECLAIM_TX)!.outputs[0]!.asset_list];
      await expectFailure(rig, 'compliance', 'do not spend the expected attestation');
      history.asset_list = [...revoke.inputs[0]!.asset_list];
      expect(await rig.run('status')).toBe(0);
      const { tx } = rig.facts.read().attestations[charlie]!.software!;
      rig.ledger.live = rig.ledger.live.filter(({ txHash }) => txHash !== tx);
      await expectFailure(rig, 'attestations', 'bid-desk-charlie/software does not match the facts on the node');
    }, SLOW);

    it('checks the exact deposit, its reclaim transaction and the presence of all lifecycle steps', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const bravo = rig.idOf('bid-desk-bravo');
      const output = rig.ledger.at(`${RECLAIM_TX}#0`)!;
      rig.setRecord(bravo, { ...output, assets: { ...output.assets, lovelace: output.assets.lovelace! - 1n } });
      await expectFailure(rig, 'lifecycle', 'the tombstone holds less lovelace than the ledger minimum');
      expect(rig.checks().get('record:bid-desk-bravo')!.result).toBe('fail');
      rig.setRecord(bravo, { ...output, assets: { ...output.assets, lovelace: output.assets.lovelace! + 1n } });
      await expectFailure(rig, 'lifecycle', 'the deposit above the ledger minimum was not reclaimed: 0.000001 units remain');
      expect(rig.checks().get('record:bid-desk-bravo')).toMatchObject({ result: 'ok', text: expect.stringContaining('the controller can still reclaim 0.000001 units') });
      rig.setRecord(bravo, { ...output, txHash: hash('other output') });
      await expectFailure(rig, 'lifecycle', 'the tombstone output does not match the reclaim transaction');
      rig.setRecord(bravo, { ...output, assets: { ...output.assets, [MAINNET.attestation.hash + hash('unrelated token')]: 1n } });
      await expectFailure(rig, 'record:bid-desk-bravo', 'the tombstone must hold just its identity token');
      const missing = await makeRig({ skipStep: 'recovery-wait' }, bidEvaluation);
      await expectFailure(missing, 'lifecycle', 'no usable lifecycle step(s): recovery-wait');
    }, SLOW);

    it('requires the recovered controller and complete, confirmed credit to the fee wallet', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const bravo = rig.idOf('bid-desk-bravo');
      const output = rig.ledger.at(`${RECLAIM_TX}#0`)!;
      const datum = decodeIdentityDatum(output.datum!);
      rig.setRecord(bravo, { ...output, datum: encodeIdentityDatum({ ...datum, controller: testKey(5).publicKey }) });
      await expectFailure(rig, 'lifecycle', 'does not retain the recovered controller');
      rig.setRecord(bravo, output);
      const tx = rig.history.get(RECLAIM_TX)!;
      tx.valid_contract = false;
      await expectFailure(rig, 'lifecycle', 'has no affirmative phase-two validity evidence');
      delete tx.valid_contract;
      tx.plutus_contracts[0]!.valid_contract = false;
      await expectFailure(rig, 'lifecycle', 'has no affirmative phase-two validity evidence');
      tx.plutus_contracts[0]!.valid_contract = true;
      const contracts = tx.plutus_contracts;
      tx.plutus_contracts = [];
      await expectFailure(rig, 'lifecycle', 'has no affirmative phase-two validity evidence');
      tx.plutus_contracts = contracts;
      const redeemer = contracts[0]!.input.redeemer;
      const reclaim = redeemer.datum;
      redeemer.datum = datumOf(encodeIdentitySpend({ type: 'BumpEpoch' }));
      await expectFailure(rig, 'lifecycle', 'did not spend the predecessor with Reclaim');
      redeemer.datum = reclaim;
      rig.unconfirmed.add(RECLAIM_TX);
      await expectFailure(rig, 'lifecycle', 'does not confirm the exact spend');
      rig.unconfirmed.delete(RECLAIM_TX);
      const fee = tx.fee;
      tx.fee = '';
      await expectFailure(rig, 'lifecycle', 'has no actual fee');
      tx.fee = fee;
      const wallet = tx.outputs[1]!;
      const archiveDatum = tx.inputs[0]!;
      const digest = archiveDatum.datum_hash;
      archiveDatum.datum_hash = hash('another datum');
      await expectFailure(rig, 'lifecycle', 'the transaction history datum does not match its hash');
      archiveDatum.datum_hash = digest;
      const amount = wallet.value;
      wallet.value = String(BigInt(amount) - 1n);
      await expectFailure(rig, 'lifecycle', 'did not receive the reclaimed deposit less the transaction fee');
      wallet.value = amount;
      expect(await rig.run('status')).toBe(0);
      wallet.value = String(BigInt(amount) - BigInt(tx.inputs[1]!.value));
      tx.inputs.pop();
      tx.outputs[0]!.inline_datum = null;
      expect(await rig.run('status')).toBe(0);
    }, SLOW);

    it('checks the raw hash and decoded value of the exact output when historic bytes use another encoding', async () => {
      const rig = await makeRig({}, bidEvaluation);
      const tx = rig.history.get(RECLAIM_TX)!;
      const saved = tx.inputs[0]!;
      const onNode = rig.ledger.at(`${RECLAIM_TX}#0`)!;
      const canonical = onNode.datum!;
      expect(canonical).toMatch(/^d8799f[0-9a-f]+ff$/);
      // A definite list encodes the same fourteen fields with different bytes.
      const raw = `d8798e${canonical.slice(6, -2)}`;
      const previous = { ...onNode, txHash: saved.tx_hash, outputIndex: saved.tx_index, assets: { ...onNode.assets, lovelace: BigInt(saved.value) } };
      saved.datum_hash = blake2b256Hex(Buffer.from(raw, 'hex'));
      await expectFailure(rig, 'lifecycle', 'the transaction history datum does not match its hash');
      rig.ledger.koiosSpent.push({ ...previous, datum: raw, outputIndex: saved.tx_index + 1 });
      await expectFailure(rig, 'lifecycle', 'the transaction history datum does not match its hash');
      rig.ledger.koiosSpent.pop();
      rig.ledger.koiosSpent.push({ ...previous, datum: raw });
      expect(await rig.run('status')).toBe(0);
      rig.ledger.koiosSpent.pop();
      const different = encodeIdentityDatum({ ...decodeIdentityDatum(canonical), name: '78' });
      saved.datum_hash = blake2b256Hex(Buffer.from(different, 'hex'));
      rig.ledger.koiosSpent.push({ ...previous, datum: different });
      await expectFailure(rig, 'lifecycle', 'the transaction history datum bytes and value disagree');
    }, SLOW);

    it('does not substitute a default for missing, invalid or conflicting protocol parameters', async () => {
      for (const protocolParameters of [{}, { minUtxoDepositCoefficient: 0 }, { minUtxoDepositCoefficient: 5.5 }, { minUtxoDepositCoefficient: COINS_PER_BYTE, coinsPerUtxoByte: 4_310 }]) {
        const rig = await makeRig({ protocolParameters }, bidEvaluation);
        await expectFailure(rig, 'lifecycle', 'the node did not give one positive integer for the coins per UTxO byte');
        expect(rig.protocolRequests).toHaveLength(1);
      }
      const alias = await makeRig({ protocolParameters: { coinsPerUtxoByte: COINS_PER_BYTE } }, bidEvaluation);
      expect(await alias.run('status')).toBe(0);
    }, SLOW);
  });

  describe('each check fails alone', () => {
    it('a record that is Revoked, Retired or not in the registry is a fail, and the same agent Active is ok', async () => {
      for (const [utxo, text] of [[REVOKED, 'is Revoked: it must be Active'], [RETIRED, 'is Retired: it must be Active']] as const) {
        const rig = await makeRig();
        rig.setRecord(ORDER_ID, utxo);
        expect(await rig.run()).toBe(1);
        expectChecks(rig, { 'record_active:order-desk': 'fail' });
        expect(rig.checks().get('record_active:order-desk')!.text).toContain(text);
        expect(rig.errors()).toContain('the end state is not reached: 1 check(s) fail (record_active:order-desk)');
        expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { verdict: 'fail' } });
      }
      const rig = await makeRig();
      rig.ledger.live = rig.ledger.live.filter((utxo) => utxo.assets[`${MAINNET.identity.hash}${ORDER_ID}`] === undefined);
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'record_active:order-desk': 'fail', adverts: 'fail', 'holds': 'fail' });
      expect(rig.checks().get('record_active:order-desk')!.text).toContain('is not in the identity registry');
    }, SLOW);

    it('a hold of 7 days from the jury is a wait with its date, exit 4, and the wait line names the time', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      expect(await rig.run()).toBe(4);
      expectChecks(rig, { 'record_active:order-desk': 'wait' });
      const text = rig.checks().get('record_active:order-desk')!.text;
      expect(text).toContain(`until ${iso(JURY_UNTIL)}`);
      expect(text).toContain('on hold from the jury (reason 64)');
      expect(rig.world.screen.lines).toContain(`WAIT: the end state is not reached yet: 1 check(s) wait (record_active:order-desk). The lines above say what is still to do (until ${iso(JURY_UNTIL)})`);
      expect(rig.world.machine()).toMatchObject({ outcome: 'wait', exit: 4, result: { verdict: 'wait' } });
    }, SLOW);

    it('reports an inherited jury hold as a wait until the verified parent deadline', async () => {
      const rig = await makeRig();
      rig.setRecord(REORDER_ID, registryUtxo(REORDER_ID, agentRecord({
        status: { type: 'Suspended', holds: [holdOf({ type: 'Script', hash: MODULE1.claim.hash }, 64, JURY_UNTIL)] },
      })));
      const child = rig.gateway.get(did(READER_ID))!;
      child.effective = 'suspended';
      child.ownHolds = [{ until: iso(NOW - HOUR) }];
      expect(await rig.run()).toBe(4);
      expectChecks(rig, { 'record_active:reorder-agent': 'wait', 'subagents:reorder-agent': 'wait' });
      expect(rig.checks().get('subagents:reorder-agent')!.text).toContain(`inherit the jury hold until ${iso(JURY_UNTIL)}`);
      expect(rig.world.machine()).toMatchObject({ outcome: 'wait', exit: 4 });
    }, SLOW);

    it('a hold of another author, a hold that the jury shares with another author, and an Active record twin: fail, fail, ok', async () => {
      for (const utxo of [PARTY_HELD, MIXED_HELD]) {
        const rig = await makeRig();
        rig.setRecord(ORDER_ID, utxo);
        expect(await rig.run()).toBe(1);
        expectChecks(rig, { 'record_active:order-desk': 'fail', 'holds': 'fail' });
        expect(rig.checks().get('record_active:order-desk')!.text).toContain('is Suspended, and the hold is not a hold of the jury');
      }
      const twin = await makeRig();
      twin.setRecord(ORDER_ID, EXPIRED_HOLD);
      expect(await twin.run()).toBe(0);
      expectChecks(twin);
    }, SLOW);

    it('an organisation that the gateway does not show as verified is a fail, and so are a missing Accountable party and a failed hosted call', async () => {
      const unverified = await makeRig();
      unverified.gateway.get(did(ORDER_ID))!.verified = false;
      expect(await unverified.run()).toBe(1);
      expectChecks(unverified, { 'organisation:order-desk': 'fail' });
      expect(unverified.checks().get('organisation:order-desk')!.text).toContain(`does not show the organisation ${data.organisations[1]!.domain} as verified`);
      const noParty = await makeRig();
      noParty.gateway.get(did(REORDER_ID))!.parties = false;
      expect(await noParty.run()).toBe(1);
      expectChecks(noParty, { 'organisation:reorder-agent': 'fail' });
      expect(noParty.checks().get('organisation:reorder-agent')!.text).toContain('shows no Accountable party');
      const down = await makeRig();
      down.hosted.handlers.vector_resolve_did = () => ({ text: 'Failed to resolve DID: the gateway is down', isError: true });
      expect(await down.run()).toBe(1);
      expectChecks(down, { 'organisation:reorder-agent': 'fail', 'organisation:order-desk': 'fail', 'attestations': 'fail', 'subagents:reorder-agent': 'fail' });
      expect(down.checks().get('organisation:order-desk')!.text).toContain('the hosted tool vector_resolve_did failed: Failed to resolve DID: the gateway is down');
    }, SLOW);

    it('an advert that is not listed, an advert that the facts do not hold, and an indexer that cannot be read are a fail', async () => {
      const missing = await makeRig();
      missing.listing = missing.listing.filter((row) => row.model !== 'lot-medium');
      expect(await missing.run()).toBe(1);
      expectChecks(missing, { adverts: 'fail' });
      expect(missing.checks().get('adverts')!.text).toContain(`does not list the advert order-desk/lot-medium (${ref('advert lot-medium')})`);
      const extra = await makeRig();
      extra.listing = [...extra.listing, { advert_ref: ref('stray'), capability_id: ORDER.capability, model: 'lot-huge', agent_id: ORDER_ID, did: did(ORDER_ID), supplier_pkh: testKey(5).keyHash, status: 'free' }];
      expect(await extra.run()).toBe(1);
      expectChecks(extra, { adverts: 'fail' });
      expect(extra.checks().get('adverts')!.text).toContain(`lists an advert of the capability ${ORDER.capability} that the facts do not hold (${ref('stray')})`);
      const broken = await makeRig();
      broken.hosted.handlers.vector_marketplace_list_suppliers = () => ({ text: 'a text with no list' });
      expect(await broken.run()).toBe(1);
      expectChecks(broken, { adverts: 'fail' });
      expect(broken.checks().get('adverts')!.text).toContain('cannot tell: the answer of vector_marketplace_list_suppliers holds no list of adverts');
    }, SLOW);

    it('the adverts of an agent on hold from the jury are a wait, and an advert that is missing from an agent that is Active is a fail', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      rig.listing = rig.listing.filter((row) => row.capability_id !== ORDER.capability);
      expect(await rig.run()).toBe(4);
      expectChecks(rig, { 'record_active:order-desk': 'wait', 'adverts': 'wait' });
      expect(rig.checks().get('adverts')!.text).toContain(`is not listed while the record is on hold until ${iso(JURY_UNTIL)}`);
      const active = await makeRig();
      active.listing = active.listing.filter((row) => row.capability_id !== ORDER.capability);
      expect(await active.run()).toBe(1);
      expectChecks(active, { adverts: 'fail' });
    }, SLOW);

    it('an open claim is a fail when its window has ended, and a wait with the time when it has not', async () => {
      const ended = await makeRig();
      ended.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      ended.facts.put('claims', ['r1', 'reorder-agent'], claimFact());
      expect(await ended.run()).toBe(1);
      expectChecks(ended, { 'claims:reorder-agent': 'fail' });
      expect(ended.checks().get('claims:reorder-agent')!.text).toContain('of the run r1 is open and its window has ended');
      expect(ended.checks().get('claims:reorder-agent')!.text).toContain('cleanup --run r1 --submit');
      const open = await makeRig();
      open.ledger.live.push(openClaim({ ageMs: HOUR }));
      open.facts.put('claims', ['r1', 'reorder-agent'], claimFact());
      expect(await open.run()).toBe(4);
      expectChecks(open, { 'claims:reorder-agent': 'wait' });
      const until = Math.ceil((NOW - HOUR + 4 * HOUR + 1) / 1000) * 1000;
      expect(open.checks().get('claims:reorder-agent')!.text).toContain(`its window ends in 3 h 1 s (at ${iso(until)})`);
      expect(open.world.screen.lines.some((line) => line.startsWith('WAIT: ') && line.endsWith(`(until ${iso(until)})`))).toBe(true);
    }, SLOW);

    it('an open claim that the facts do not hold is a fail too, and the claim of the other agent is read apart', async () => {
      const rig = await makeRig();
      rig.ledger.live.push(openClaim({ claimer: ORDER_ID, ageMs: 6 * HOUR }));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'claims:order-desk': 'fail' });
      expect(rig.checks().get('claims:order-desk')!.text).toContain('(the facts do not hold it) is open and its window has ended');
    }, SLOW);

    it('a claim of the facts that is not open is ok only when the facts say so: not withdrawn is a wait, withdrawn and not open are ok', async () => {
      const unsaid = await makeRig();
      unsaid.facts.put('claims', ['r1', 'order-desk'], claimFact());
      expect(await unsaid.run()).toBe(4);
      expectChecks(unsaid, { 'claims:order-desk': 'wait' });
      expect(unsaid.checks().get('claims:order-desk')!.text).toContain('is not open, and the facts do not say so: run the task claim, cleanup --run r1 --submit');
      const closed = await makeRig();
      closed.facts.put('claims', ['r1', 'order-desk'], claimFact());
      closed.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await closed.run()).toBe(0);
      expectChecks(closed);
      const withdrawn = await makeRig();
      withdrawn.facts.put('claims', ['r1', 'order-desk'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await withdrawn.run()).toBe(0);
      expectChecks(withdrawn);
      expect(withdrawn.checks().get('claims:order-desk')!.text).toContain('1 claim(s) of the facts are withdrawn or not open');
    }, SLOW);

    it('a claim that the facts call withdrawn is still a fail when the chain shows it open', async () => {
      const rig = await makeRig();
      rig.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      rig.facts.put('claims', ['r1', 'reorder-agent'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'claims:reorder-agent': 'fail' });
    }, SLOW);

    it('a claim that is Challenged is a wait, whatever the facts say, and a claim in any other state that is not Open is a wait too (EP1)', async () => {
      const output = (state: 'Challenged' | 'Validated' | 'Invalidated' = 'Challenged') => openClaim({ claimer: ORDER_ID, ageMs: 2 * HOUR, state });
      // EP1b: the facts hold the claim and do not say that it is closed.
      const silent = await makeRig();
      silent.ledger.live.push(output());
      silent.facts.put('claims', ['r1', 'order-desk'], claimFact());
      expect(await silent.run()).toBe(4);
      expectChecks(silent, { 'claims:order-desk': 'wait' });
      expect(silent.checks().get('claims:order-desk')!.text).toContain('of the run r1 is Challenged, so it is not closed');
      // EP1: the facts say `not open`, and a live output still holds the token of the claim: the check is not done.
      const said = await makeRig();
      said.ledger.live.push(output());
      said.facts.put('claims', ['r1', 'order-desk'], claimFact());
      said.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await said.run()).toBe(4);
      expectChecks(said, { 'claims:order-desk': 'wait' });
      expect(said.world.machine()).toMatchObject({ outcome: 'wait', exit: 4, result: { verdict: 'wait' } });
      expect(await said.run('status')).toBe(1);
      expect(said.world.screen.text).not.toContain('end state: DONE');
      // The facts hold a withdraw transaction, and the token is still held by a live output.
      const withdrawn = await makeRig();
      withdrawn.ledger.live.push(output());
      withdrawn.facts.put('claims', ['r1', 'order-desk'], claimFact({ withdrawTx: hash('withdraw') }));
      expect(await withdrawn.run()).toBe(4);
      expectChecks(withdrawn, { 'claims:order-desk': 'wait' });
      // A challenged claim of the agent that the facts do not hold.
      const unknown = await makeRig();
      unknown.ledger.live.push(output());
      expect(await unknown.run()).toBe(4);
      expectChecks(unknown, { 'claims:order-desk': 'wait' });
      expect(unknown.checks().get('claims:order-desk')!.text).toContain('(the facts do not hold it) is Challenged, so it is not closed');
      // The other states that are not Open.
      for (const state of ['Validated', 'Invalidated'] as const) {
        const rig = await makeRig();
        rig.ledger.live.push(output(state));
        expect(await rig.run()).toBe(4);
        expectChecks(rig, { 'claims:order-desk': 'wait' });
        expect(rig.checks().get('claims:order-desk')!.text).toContain(`is ${state}, so it is not closed`);
      }
      // The twin: the facts say `not open`, and no live output holds the token.
      const closed = await makeRig();
      closed.facts.put('claims', ['r1', 'order-desk'], claimFact());
      closed.facts.put('claims', ['r1', 'order-desk', 'withdrawTx'], 'not open');
      expect(await closed.run()).toBe(0);
      expectChecks(closed);
    }, SLOW);

    it('an attestation that the data names and the facts lack is a fail, for one type and for all four', async () => {
      const one = await makeRig({ skipAttestation: 'order-desk/software' });
      expect(await one.run()).toBe(1);
      expectChecks(one, { attestations: 'fail' });
      const text = one.checks().get('attestations')!.text;
      expect(text).toContain('the facts hold no attestation of the type software for the agent order-desk: run the task attest first');
      expect(text).toContain(`reorder-agent/provenance ${hash('attestation reorder-agent provenance')} is listed in vectorProvenance`);
      const none = await makeRig({ skipAttestation: 'all' });
      expect(await none.run()).toBe(1);
      expectChecks(none, { attestations: 'fail' });
      expect(none.checks().get('attestations')!.text.match(/the facts hold no attestation of the type/g)).toHaveLength(4);
    }, SLOW);

    it('cannot tell is a fail: no Module-1 commit, a manifest of another registry, and a chain that cannot be read', async () => {
      const bare = await makeRig({ env: { OPERATOR_MODULE1_COMMIT: undefined } });
      expect(await bare.run()).toBe(1);
      expectChecks(bare, { 'claims:reorder-agent': 'fail', 'claims:order-desk': 'fail' });
      expect(bare.checks().get('claims:reorder-agent')!.text).toContain('cannot tell: OPERATOR_MODULE1_COMMIT is not set');
      const koios = await makeRig();
      koios.ledger.koiosStatus = 503;
      expect(await koios.run()).toBe(1);
      expectChecks(koios, { 'claims:reorder-agent': 'fail', 'claims:order-desk': 'fail' });
      expect(koios.checks().get('claims:order-desk')!.text).toMatch(/^(cannot tell|the open claims cannot be read)/);
    }, SLOW);

    it('a live delegation of a hirer is a fail that names its id and the key hash of the delegator, with the advice to ask the hirer', async () => {
      const rig = await makeRig();
      const hirer = testKey(30).keyHash;
      rig.ledger.live.push(delegationUtxo(hash('delegation 1'), delegation({ delegate: REORDER_ID, delegator: { type: 'PrincipalKey', hash: hirer, organisation: null } })));
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { delegations: 'fail' });
      const text = rig.checks().get('delegations')!.text;
      expect(text).toContain(`the delegation ${hash('delegation 1')} to reorder-agent is live, delegator key hash ${hirer}`);
      expect(text).toContain('The operator cannot end the delegation of a hirer: ask the hirer to end it.');
    }, SLOW);

    it('a live sub-delegation to the subagent is a fail, and a delegation to another agent is ok', async () => {
      const sub = await makeRig();
      sub.ledger.live.push(delegationUtxo(hash('delegation 2'), delegation({ delegate: READER_ID, delegator: { type: 'Agent', id: REORDER_ID }, parent: hash('parent'), depth: 2 })));
      expect(await sub.run()).toBe(1);
      expectChecks(sub, { delegations: 'fail' });
      expect(sub.checks().get('delegations')!.text).toContain(`to stock-reader is live, delegator agent ${REORDER_ID}`);
      const other = await makeRig();
      other.ledger.live.push(delegationUtxo(hash('delegation 3'), delegation({ delegate: 'e5'.repeat(32) })));
      expect(await other.run()).toBe(0);
      expectChecks(other);
    }, SLOW);

    it('a hold of this pack that is on is a fail, and a hold in the facts that ended by itself is ok', async () => {
      const on = await makeRig();
      on.setRecord(ORDER_ID, PARTY_HELD);
      on.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: null });
      expect(await on.run()).toBe(1);
      expect(on.checks().get('holds')!.result).toBe('fail');
      expect(on.checks().get('holds')!.text).toContain(`the record ${did(ORDER_ID)} of order-desk has a hold of the key hash ${testKey(3).keyHash} until ${iso(PARTY_UNTIL)}`);
      expect(on.checks().get('holds')!.text).toContain('cleanup --run r2 --submit');
      const ended = await makeRig();
      ended.setRecord(ORDER_ID, EXPIRED_HOLD);
      ended.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: null });
      expect(await ended.run()).toBe(0);
      expect(ended.checks().get('holds')!.text).toContain('the facts show no lift for the run(s) r2, and the node shows no hold');
      const lifted = await makeRig();
      lifted.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: hash('lift') });
      expect(await lifted.run()).toBe(0);
    }, SLOW);

    it('a hold that the facts call lifted is a fail when the node still shows it', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, PARTY_HELD);
      rig.facts.put('holds', ['r2'], { suspendTx: hash('suspend'), liftTx: hash('lift') });
      expect(await rig.run()).toBe(1);
      expect(rig.checks().get('holds')!.result).toBe('fail');
    }, SLOW);

    it('a wallet below half of its float or with no collateral output is a wait with the advice to top it up, and the exact limit is ok', async () => {
      const low = await makeRig();
      low.setWallet('order-small-supplier', [5_000_000n, 1_000_000n]);
      expect(await low.run()).toBe(4);
      expectChecks(low, { wallets: 'wait' });
      expect(low.checks().get('wallets')!.text).toContain('order-small-supplier holds 6.000000 units and needs 10.000000 units');
      expect(low.checks().get('wallets')!.text).toContain('top the wallet up by hand');
      const bare = await makeRig();
      bare.setWallet('reorder-service', [4_000_000n, 4_000_000n, FAIR_FLOAT]);
      bare.setWallet('order-large-supplier', [4_000_000n, 4_000_000n, 4_000_000n]);
      expect(await bare.run()).toBe(4);
      expect(bare.checks().get('wallets')!.text).toContain('order-large-supplier has no pure output of 5 units or more as collateral');
      expect(bare.checks().get('wallets')!.text).not.toContain('reorder-service');
      const exact = await makeRig();
      exact.setWallet('order-small-supplier', [10_000_000n]);
      expect(await exact.run()).toBe(0);
      const above = await makeRig();
      above.setWallet('order-small-supplier', [9_999_999n]);
      expect(await above.run()).toBe(4);
    }, SLOW);

    it('a wallet that the public key file does not list, and a public key file that is not there, are a fail', async () => {
      const rig = await makeRig();
      rmSync(join(rig.world.keys.root, publicManifestFile(USE_CASE)));
      expect(await rig.run()).toBe(1);
      expect(rig.checks().get('wallets')!.result).toBe('fail');
      expect(rig.checks().get('wallets')!.text).toContain(`cannot tell: the public key file ${publicManifestFile(USE_CASE)} cannot be read (ENOENT)`);
      const other = await makeRig();
      writeFileSync(join(other.world.keys.root, publicManifestFile(USE_CASE)), JSON.stringify({ use_case: USE_CASE, network: 'vector-mainnet', keys: { fee: { address: other.world.keys.registry.addressOf('fee') } } }));
      expect(await other.run()).toBe(1);
      expect(other.checks().get('wallets')!.text).toContain('the public key file lists no wallet for');
      const foreign = await makeRig();
      writeFileSync(join(foreign.world.keys.root, publicManifestFile(USE_CASE)), JSON.stringify({ use_case: 'another', network: 'vector-mainnet', keys: {} }));
      expect(await foreign.run()).toBe(1);
      expect(foreign.checks().get('wallets')!.text).toContain('is for another use case or another network');
    }, SLOW);

    it('reads the public key file of the earlier name when the file of the use case is not there, and not an earlier file that names another use case', async () => {
      const rig = await makeRig();
      rmSync(join(rig.world.keys.root, publicManifestFile(USE_CASE)));
      writePublicManifest(join(rig.world.keys.root, LEGACY_PUBLIC_MANIFEST), rig.world.keys.registry, { network: 'vector-mainnet', useCase: USE_CASE });
      expect(await rig.run()).toBe(0);
      expect(rig.checks().get('wallets')!.result).toBe('ok');
      const foreign = await makeRig();
      rmSync(join(foreign.world.keys.root, publicManifestFile(USE_CASE)));
      writeFileSync(join(foreign.world.keys.root, LEGACY_PUBLIC_MANIFEST), JSON.stringify({ use_case: 'another', network: 'vector-mainnet', keys: {} }));
      expect(await foreign.run()).toBe(1);
      expect(foreign.checks().get('wallets')!.text).toContain(`cannot tell: the public key file ${publicManifestFile(USE_CASE)} cannot be read (ENOENT)`);
    }, SLOW);

    it('the dates of the deposits are the end of the validity and 90 days, and an attestation that is not listed is a fail unless it expired', async () => {
      const rig = await makeRig();
      rig.gateway.get(did(REORDER_ID))!.listed = [hash('attestation reorder-agent provenance')];
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { attestations: 'fail' });
      const text = rig.checks().get('attestations')!.text;
      expect(text).toContain(`the attestation reorder-agent/software ${hash('attestation reorder-agent software')} is not listed in vectorProvenance`);
      expect(text).toContain(`reorder-agent/provenance ${hash('attestation reorder-agent provenance')} is listed in vectorProvenance, valid until ${iso(NOW + 300 * DAY)}, deposit due ${iso(NOW + 390 * DAY)}`);
      const expired = await makeRig();
      expired.facts.put('attestations', ['reorder-agent', 'software'], { id: hash('old'), tx: hash('old tx'), digest: hash('digest'), locator: 'https://example.test/doc', validUntil: iso(NOW - DAY), issuedAt: iso(NOW - 366 * DAY), envelope: true }, { replace: true });
      expect(await expired.run()).toBe(0);
      expect(expired.checks().get('attestations')!.text).toContain(`reorder-agent/software ${hash('old')} is expired and not listed, valid until ${iso(NOW - DAY)}, deposit due ${iso(NOW + 89 * DAY)}`);
    }, SLOW);

    it('a runtime that says working is a wait, and a runtime that is not listed, that cannot be asked or that answers wrongly is a fail', async () => {
      const working = await makeRig();
      working.statuses.set(STATUS_URLS[1]!, 'working');
      expect(await working.run()).toBe(4);
      expectChecks(working, { runtimes: 'wait' });
      expect(working.checks().get('runtimes')!.text).toContain('the runtime orders-small-runtime says working: a job runs, so wait until it ends');
      const absent = await makeRig();
      absent.writeRunning(CONTAINERS.filter((container) => container !== 'orders-medium-runtime'));
      expect(await absent.run()).toBe(1);
      expectChecks(absent, { runtimes: 'fail' });
      expect(absent.checks().get('runtimes')!.text).toContain('the runtime orders-medium-runtime is not running: at the end state the 4 runtimes run');
      expect(absent.webCalls).not.toContain(STATUS_URLS[2]);
      for (const answer of [500, 'not json', 'sleeping'] as const) {
        const odd = await makeRig();
        odd.statuses.set(STATUS_URLS[0]!, answer);
        expect(await odd.run()).toBe(1);
        expectChecks(odd, { runtimes: 'fail' });
        expect(odd.checks().get('runtimes')!.text).toContain('cannot tell whether the runtime reorder-runtime works');
      }
    }, SLOW);

    it('a runtime that gives no answer within 10 seconds is a fail that says that it cannot tell, also when the fetch ignores the abort signal, and the other runtimes are still asked', async () => {
      const rig = await makeRig();
      rig.statuses.set(STATUS_URLS[1]!, 'hang');
      // Only the timeout is faked: the files and the hosted calls of the run take their real time, and the loop moves the clock of the timer while the run goes on. The bound makes a reader with no limit fail the test
      // and not hang it.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let exit: number | undefined;
        void rig.run().then((code) => { exit = code; });
        for (let turn = 0; turn < 3_000 && exit === undefined; turn += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
          await nextTurn();
        }
        expect(exit).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expectChecks(rig, { runtimes: 'fail' });
      expect(rig.checks().get('runtimes')!.text).toContain('cannot tell whether the runtime orders-small-runtime works: no complete answer came within 10 s');
      expect(rig.webCalls).toEqual(expect.arrayContaining([STATUS_URLS[0], STATUS_URLS[2], STATUS_URLS[3]]));
    }, SLOW);

    it('a file of the running containers that is stale, missing or empty is a fail, and the file of this minute is ok', async () => {
      const stale = await makeRig();
      stale.writeRunning(CONTAINERS, NOW - 11 * 60_000);
      expect(await stale.run()).toBe(1);
      expect(stale.checks().get('runtimes')!.text).toContain('cannot tell: running-images.json is more than 10 minutes old');
      const missing = await makeRig();
      rmSync(join(missing.world.stateDir, 'running-images.json'));
      expect(await missing.run()).toBe(1);
      expect(missing.checks().get('runtimes')!.text).toContain('cannot tell: running-images.json does not exist');
      const empty = await makeRig();
      empty.writeRunning([]);
      expect(await empty.run()).toBe(1);
      expect(empty.checks().get('runtimes')!.text).toContain('the runtime reorder-runtime is not running');
      const fresh = await makeRig();
      fresh.writeRunning(CONTAINERS, NOW - 9 * 60_000);
      expect(await fresh.run()).toBe(0);
    }, SLOW);

    it('a hosted tool that cannot be reached is a fail with its own line and never a pass', async () => {
      const rig = await makeRig();
      rig.hosted.handlers.vector_marketplace_list_suppliers = () => { throw new HostedError('unreachable', 'the hosted server cannot be reached'); };
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { adverts: 'fail' });
      expect(rig.checks().get('adverts')!.text).toBe('cannot tell: the hosted server cannot be reached');
    }, SLOW);

    it('a network guard that fails stops the reads: one fail named network, and no read of the ledger or the hosted tools', async () => {
      const rig = await makeRig();
      rig.world.node.facts = { magic: 42, systemStartMs: 1 };
      expect(await rig.run()).toBe(1);
      expect([...rig.checks().keys()]).toEqual(['network']);
      expect(rig.checks().get('network')!.result).toBe('fail');
      expect(rig.hosted.calls).toEqual([]);
    }, SLOW);
  });

  describe('the whole', () => {
    it('is exit 1 when a check waits and another fails, and the line of the whole names both', async () => {
      const rig = await makeRig();
      rig.setRecord(ORDER_ID, JURY_HELD);
      rig.gateway.get(did(REORDER_ID))!.verified = false;
      expect(await rig.run()).toBe(1);
      expectChecks(rig, { 'record_active:order-desk': 'wait', 'organisation:reorder-agent': 'fail' });
      expect(rig.world.screen.lines).toContain('end state: NOT DONE: 1 check(s) fail (organisation:reorder-agent) and 1 check(s) wait (record_active:order-desk)');
      expect(rig.world.machine()).toMatchObject({ outcome: 'failed', exit: 1, result: { verdict: 'fail' } });
    }, SLOW);

    it('has no date to wait for when a wait has none, and the latest date when every wait has one', async () => {
      const dateless = await makeRig();
      dateless.setRecord(ORDER_ID, JURY_HELD);
      dateless.setWallet('order-small-supplier', [5_000_000n]);
      expect(await dateless.run()).toBe(4);
      expect(dateless.world.screen.lines.find((line) => line.startsWith('WAIT: '))).toBe('WAIT: the end state is not reached yet: 2 check(s) wait (record_active:order-desk, wallets). The lines above say what is still to do');
      const dated = await makeRig();
      dated.setRecord(ORDER_ID, JURY_HELD);
      dated.ledger.live.push(openClaim({ ageMs: HOUR }));
      expect(await dated.run()).toBe(4);
      expect(dated.world.screen.lines.find((line) => line.startsWith('WAIT: '))).toContain(`(until ${iso(JURY_UNTIL)})`);
    }, SLOW);

    it('never ends status with exit 0 or the outcome done for a state that is not done: a claim, a delegation, a hold and a wait all end with exit 1', async () => {
      const claim = await makeRig();
      claim.ledger.live.push(openClaim({ ageMs: 5 * HOUR }));
      expect(await claim.run('status')).toBe(1);
      expect(claim.world.screen.lines).toContain('end state: NOT DONE: 1 check(s) fail (claims:reorder-agent) and 0 check(s) wait (none)');
      expect(claim.world.screen.text).not.toContain('end state: DONE');
      expect(claim.errors()).toContain('the end state is not reached: 1 check(s) fail (claims:reorder-agent)');
      expect(claim.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const open = await makeRig();
      open.ledger.live.push(openClaim({ ageMs: HOUR }));
      expect(await open.run('status')).toBe(1);
      expect(open.errors()).toContain('the end state is not reached yet: 1 check(s) wait (claims:reorder-agent)');
      expect(open.world.screen.text).not.toContain('end state: DONE');
      expect(open.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const delegated = await makeRig();
      delegated.ledger.live.push(delegationUtxo(hash('delegation 1'), delegation({ delegate: REORDER_ID })));
      expect(await delegated.run('status')).toBe(1);
      expect(delegated.world.screen.text).not.toContain('end state: DONE');
      const held = await makeRig();
      held.setRecord(ORDER_ID, PARTY_HELD);
      expect(await held.run('status')).toBe(1);
      expect(held.world.screen.text).not.toContain('end state: DONE');
      expect(held.world.machine()).toMatchObject({ command: 'status', outcome: 'failed', exit: 1 });
      const jury = await makeRig();
      jury.setRecord(ORDER_ID, JURY_HELD);
      expect(await jury.run('status')).toBe(1);
      expect(jury.world.screen.lines.some((line) => line.startsWith('WAIT record_active:order-desk: '))).toBe(true);
    }, SLOW);

    it('takes nothing back in cleanup', async () => {
      const rig = await makeRig();
      expect(await rig.run('cleanup')).toBe(0);
      expect(rig.world.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0 });
      expect(rig.hosted.calls).toEqual([]);
    }, SLOW);
  });
});
