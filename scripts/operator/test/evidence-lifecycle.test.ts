import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encodeIdentitySpend } from '../../../packages/vector-read/src/identity-codec.ts';
import { blake2b256Hex } from '../lib/platform.ts';
import { ruleStepIds } from '../tasks/evidence.ts';
import use from '../usecases/bid-evaluation.ts';
import { lifecycleEvidenceWorld } from './support/evidence-lifecycle-world.ts';
import type { Changed } from './support/evidence-lifecycle-world.ts';
import { hashOf } from './support/task-world.ts';

// The manifest client checks host resolution separately from fetching the fixture.
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '140.82.114.4', family: 4 }] }));

const lifecycleIds = use.evidenceSteps.filter(({ run }) => run === 'lifecycle').map(({ id }) => id);
const golden = new URL('./golden/evidence-uc3-lifecycle.json', import.meta.url);
const hashDatum = (hex: string) => blake2b256Hex(Buffer.from(hex, 'hex'));
type World = Awaited<ReturnType<typeof lifecycleEvidenceWorld>>;

function editJson(path: string, change: (row: Record<string, unknown>) => void): void {
  const row = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  change(row);
  writeFileSync(path, JSON.stringify(row));
}

async function refuses(f: World, id: string, member?: string) {
  const got = await f.produce();
  expect(got.exit, got.error).toBe(2);
  expect(got.error).toContain(id.startsWith('l1-') ? `steps.${id}` : id);
  if (member !== undefined) expect(got.error).toContain(member);
  expect(got.file).toBeNull();
  expect(f.w.node.submitted).toHaveLength(0);
}

describe('public lifecycle evidence', () => {
  it('writes the golden through the registered writer, without ordinary run inputs', async () => {
    const f = await lifecycleEvidenceWorld(undefined, { producerRefusal: true });
    const identity = `${use.name}:${f.report.label}`;
    expect(f.state.snapshot().record).toBe(identity);
    expect(f.adState.snapshot().record).toBe(use.name);
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8'))).toMatchObject({
      check: 'lifecycle', record: identity,
      entries: [{ step: 'recovery-wait', status: 'tool_refused', expected: true, tool: 'vector_build_identity_recovery_complete' }],
    });
    expect(f.producerCalls).toEqual([{ name: 'vector_build_identity_recovery_complete', args: {
      did: f.state.step('recovery-start')!.facts.did, changeAddress: f.keyEntries.fee!.address,
    } }]);
    expect(existsSync(f.w.goPath)).toBe(false);
    const got = await f.produce();
    expect(got.exit, got.error).toBe(0);
    expect(got.file).toBe(join('evidence', `${f.report.date}-${f.agent.id}-run-1.json`));
    expect(ruleStepIds(use.name).filter((name) => name.startsWith('l1-'))).toEqual(lifecycleIds);
    expect(got.doc).toMatchObject({ run: 'use-case-3-lifecycle', kind: 'lifecycle', capability_id: f.agent.capability,
      steps: lifecycleIds.map((id) => ({ id, status: 'shown', refs: expect.any(Array) })),
      refusals: [{ step: 'l1-03', kind: 'tool', message_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
      lifecycle: { effective_after: f.due, completed_at: expect.any(Number), claim_closeouts: [{ outcome: 'withdrawn' }],
        advert_closeouts: [{ advert_ref: `${f.advert.txHash}#1`, retirement_tx: f.advertTx }], reclaim: { retained_lovelace: String(f.final.assets.lovelace) } },
      resolutions: [{ status: 'retired', deactivated: true }, { status: 'active', deactivated: false, verification_methods: 2 }],
    });
    const doc = got.doc!;
    const steps = doc.steps as Array<{ id: string; refs: Array<{ kind: string; value: string }> }>;
    expect(steps[2]!.refs).toEqual([{ kind: 'transaction', value: f.txs['recovery-start'] }, { kind: 'transaction', value: f.txs['recovery-complete'] }]);
    expect(steps[6]!.refs).toEqual([{ kind: 'transaction', value: f.final.txHash }, { kind: 'record', value: `${f.final.txHash}#2` }]);
    for (const name of ['hires', 'mock', 'case', 'vault', 'approval', 'claims', 'delegation', 'result_projection']) expect(doc).not.toHaveProperty(name);
    const text = got.text!;
    for (const { public_key_hex, key_hash, address } of Object.values(f.keyEntries)) {
      for (const value of [public_key_hex, key_hash, address]) expect(text).not.toContain(value);
    }
    for (const value of ['No transaction was signed.', 'Private fixture details', 'test operator context only']) expect(text).not.toContain(value);
    expect(f.w.node.submitted).toHaveLength(0);
    expect(f.reads).toContain('required_signers');
    expect(f.reads).toContain('protocolParameters');
    if (process.env.WRITE_GOLDEN === '1') writeFileSync(golden, text);
    expect(text).toBe(readFileSync(golden, 'utf8'));
  });

  it('reports a proved terminal burn separately from a named withdrawal', async () => {
    const f = await lifecycleEvidenceWorld('unattributed-claim');
    const got = await f.produce();
    expect(got.exit, got.error).toBe(0);
    expect(got.doc).toMatchObject({ lifecycle: { claim_closeouts: [{ terminal_tx: f.burnTx, outcome: 'terminal_burn' }] } });
  });

  const producerMismatches = [
    { record: use.name },
    { record: `${use.name}:l2` },
    { record: 'inventory-reorder:l1' },
    { check: 'advert' },
  ];
  it.each(producerMismatches)('refuses a lifecycle state with a different producer identity: %j', async (identity) => {
    const f = await lifecycleEvidenceWorld();
    editJson(f.statePath, (row) => Object.assign(row, identity));
    await refuses(f, 'l1-01', 'lifecycle.state');
  });
  it.each(producerMismatches)('refuses an early refusal with a different producer identity: %j', async (identity) => {
    const f = await lifecycleEvidenceWorld();
    editJson(f.journalPath, (row) => Object.assign(row, identity));
    await refuses(f, 'l1-03', 'refusals');
  });

  const changes: readonly [Changed, string, string][] = [
    ['controller', 'l1-01', 'record_ref'],
    ['guardian-period', 'l1-02', 'guardians'],
    ['recovery-key', 'l1-02', 'record_ref'],
    ['recovery-period', 'l1-02', 'record_ref'],
    ['early-complete', 'l1-03', 'recovery_wait'],
    ['complete-controller', 'l1-04', 'record_ref'],
    ['complete-pending', 'l1-04', 'record_ref'],
    ['retire-pointer', 'l1-05', 'record_ref'],
    ['successor-status', 'l1-06', 'successor'],
    ['reclaim-minimum', 'l1-07', 'ledger_minimum'],
  ];
  it.each(changes)('refuses changed ledger state: %s', async (change, id, member) => {
    await refuses(await lifecycleEvidenceWorld(change), id, member);
  });

  const corrupt: readonly [string, string, string | undefined, (f: World) => unknown][] = [
    ['missing controllers', 'l1-01', 'public_manifest', (f) => rmSync(f.manifestPath)],
    ['inconsistent key hash', 'l1-01', 'public_manifest', (f) => { f.keyEntries.controller!.key_hash = '00'.repeat(28); f.writeKeys(); }],
    ['unavailable authority source', 'l1-01', 'required_signers', (f) => { f.signsDown.active = true; }],
    ['incomplete signer page', 'l1-01', 'required_signers', (f) => { f.signsDown.partial = true; }],
    ['missing controller signature', 'l1-01', 'required_signers', (f) => f.signers.get(f.txs['change-controller'])!.pop()],
    ['wrong guardian signer', 'l1-02', 'required_signers', (f) => { f.signers.get(f.txs['recovery-start'])![0] = '12'.repeat(28); }],
    ['wrong fee collateral', 'l1-01', 'fee', (f) => { f.rowsOf('change-controller').collateral_inputs[0]!.tx_hash = hashOf('other collateral'); }],
    ['missing deployed identity reference', 'l1-01', 'reference_inputs', (f) => f.rowsOf('change-controller').reference_inputs.shift()],
    ['foreign script reference', 'l1-01', 'reference_inputs', (f) => {
      f.rowsOf('change-controller').reference_inputs[0]!.tx_index = f.w.chain.deployment.refs.advert!.outputIndex;
    }],
    ['unavailable deployed identity script', 'l1-01', 'deployed identity script', (f) => {
      const { txHash, outputIndex } = f.w.chain.deployment.refs.identity!;
      f.w.world.chain.held = f.w.world.chain.held.filter((u) => u.txHash !== txHash || u.outputIndex !== outputIndex);
    }],
    ['missing sealed configuration reference', 'l1-02', 'reference_inputs', (f) => f.rowsOf('recovery-start').reference_inputs.pop()],
    ['foreign sealed configuration reference', 'l1-02', 'reference_inputs', (f) => {
      f.rowsOf('recovery-start').reference_inputs[1]!.tx_hash = hashOf('another configuration');
    }],
    ['unavailable sealed configuration', 'l1-01', 'sealed Module-1 configuration', (f) => {
      f.w.world.chain.held = f.w.world.chain.held.filter((u) => u.address !== f.w.chain.deployment.configHolder.address);
    }],
    ['unnecessary sealed configuration reference', 'l1-07', 'reference_inputs', (f) => {
      f.rowsOf('reclaim').reference_inputs.push(f.rowsOf('retire').reference_inputs[1]!);
    }],
    ['extra unrelated reference', 'l1-06', 'reference_inputs', (f) => {
      f.rowsOf('set-successor').reference_inputs.push({ tx_hash: hashOf('extra reference'), tx_index: 0 });
    }],
    ['wrong predecessor', 'l1-02', 'script_spend', (f) => {
      const tx = f.rowsOf('recovery-start');
      const unrelated = hashOf('another child output');
      tx.inputs[0]!.tx_hash = unrelated;
      tx.plutus_contracts[0]!.spends_input.tx_hash = unrelated;
    }],
    ['unconfirmed completion', 'lifecycle.recovery-complete.tx', undefined, (f) => f.missing.add(f.txs['recovery-complete'])],
    ['failed script', 'l1-04', 'script_spend', (f) => { f.rowsOf('recovery-complete').plutus_contracts[0]!.valid_contract = false; }],
    ['wrong action', 'l1-04', 'script_spend', (f) => { f.rowsOf('recovery-complete').plutus_contracts[0]!.input.redeemer.datum.hash = hashDatum(encodeIdentitySpend({ type: 'BumpEpoch' })); }],
    ['reordered transactions', 'l1-02', 'block_time', (f) => Object.assign(f.rowsOf('recovery-start'), {
      tx_timestamp: f.rowsOf('change-controller').tx_timestamp, absolute_slot: f.rowsOf('change-controller').absolute_slot, tx_block_index: 0,
      invalid_before: f.rowsOf('change-controller').invalid_before,
    })],
    ['unreadable record datum', 'l1-01', 'record_ref', (f) => { f.archive.get(`${f.txs['change-controller']}#2`)!.inline_datum!.bytes = 'ff'; }],
    ['missing tool refusal', 'l1-03', 'refusals', (f) => f.report.refusals.splice(0)],
    ['unrelated tool refusal', 'l1-03', 'refusals', (f) => { f.report.refusals[0]!.message = 'The tool refused another request.'; }],
    ['tool refusal after cutover', 'l1-03', 'refusals', (f) => editJson(f.journalPath, (journal) => {
      ((journal.entries as Array<{ at: string }>)[0]!).at = new Date(f.due).toISOString();
    })],
    ['refusal checkpoint of another recovery', 'l1-03', 'refusals', (f) => f.state.setNote('earlyRecoveryCompletion', { tx: hashOf('another recovery'), effectiveAfter: f.due })],
    ['live advert', 'l1-05', 'closeout', (f) => f.w.world.chain.held.push(f.advert)],
    ['missing advert receipt state', 'l1-05', 'advert.state', (f) => rmSync(f.adState.path)],
    ['missing verified advert receipt', 'l1-05', 'adverts', (f) => f.adState.setNote(`part.retire:${f.agent.id}:${f.agent.adverts[0]!.model}`, null)],
    ['wrong supplier payment', 'l1-05', 'adverts', (f) => { f.rows.get(f.advertTx)!.outputs[0]!.value = '1'; }],
    ['live claim', 'l1-05', 'closeout', (f) => f.w.world.chain.held.push(f.claim)],
    ['absent claim burn', 'l1-05', 'claims', (f) => f.history.minting_txs.shift()],
    ['unrelated withdrawal action', 'l1-05', 'claims', (f) => { f.rows.get(f.burnTx)!.plutus_contracts[0]!.input.redeemer.datum.hash = hashDatum('d87c80'); }],
    ['wrong successor reference', 'l1-06', 'reference_inputs', (f) => { f.rowsOf('set-successor').reference_inputs[1]!.tx_hash = hashOf('unrelated root'); }],
    ['wrong resolver successor', 'l1-06', 'resolutions', (f) => { f.resolve.old.didDocumentMetadata.vectorStatus.successor = `did:vector:${hashOf('wrong successor')}`; }],
    ['wrong successor verification list', 'l1-06', 'resolutions', (f) => f.resolve.next.didDocument.verificationMethod.pop()],
    ['missing minimum coefficient', 'l1-07', 'ledger_minimum', (f) => { f.params.coefficient = null; }],
    ['wrong reclaim refund', 'l1-07', 'fee', (f) => { f.rowsOf('reclaim').outputs[0]!.value = '1'; }],
    ['later node record output', 'l1-07', 'end_state', (f) => {
      f.final.txHash = hashOf('later reclaim output');
      f.resolve.old.didDocumentMetadata.vectorLedger.txId = f.final.txHash;
    }],
  ];
  it.each(corrupt)('refuses incomplete evidence: %s', async (_name, id, member, change) => {
    const f = await lifecycleEvidenceWorld();
    change(f);
    await refuses(f, id, member);
  });
});
