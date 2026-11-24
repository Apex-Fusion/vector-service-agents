// scripts/operator/test/run-record.test.ts - the run record of a run, the report file of a hire, and the reader of the block time of a transaction. The record is strict: an unknown member, a wrong
// shape, a bad hash, a refusal without its facts and a key-shaped text are each refused with the name of the member. Each refusal has an accepted twin. No test uses the network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RunRecordError, UnknownTransactionError, hireRoleOf, parseReport, parseRunRecord, scriptTxInfoOf, txInfoOf, txTimeOf } from '../lib/run-record.ts';
import type { RunRecordPolicy } from '../lib/run-record.ts';
import { inventory } from '../lib/evidence/inventory.ts';
import data from '../usecases/inventory-reorder.ts';
import { KEY_TEXT } from './support/secrets.ts';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
/** One change of a copy: the path of a member and its new value. `undefined` removes the member. */
type Edit = readonly [path: readonly (string | number)[], value: Json | undefined];

const h = (text: string): string => createHash('sha256').update(`run record test ${text}`).digest('hex');
const ref = (text: string, index = 0): string => `${h(text)}#${index}`;

/** A good record: one hire of each kind, one refusal of each kind. */
const goodRecord = (): Json => ({
  format: 1, label: 'r1', kind: 'clean', date: '2026-12-01', tenant: 'reorder-clean-20261201',
  delegations: [{ id: h('delegation'), tx: h('delegation tx'), ended_tx: null }],
  vaults: [{ ref: ref('vault', 1), open_tx: h('vault open'), close_tx: null }],
  approval: { attestation: h('approval'), tx: h('approval tx') },
  sub_delegations: [{ id: h('sub'), delegate_tx: h('sub delegate'), undelegate_tx: h('sub undelegate') }],
  hires: [
    { step: 'propose', agent: 'reorder-agent', advert_ref: ref('advert'), escrow_ref: ref('escrow propose'), post_tx: h('escrow propose'), accept_tx: h('accept propose'), reclaim_tx: null, report_file: 'propose.report.json' },
    { step: 'order-desk', agent: 'order-desk', advert_ref: ref('advert desk'), escrow_ref: ref('escrow desk'), post_tx: h('escrow desk'), accept_tx: null, reclaim_tx: h('reclaim desk'), report_file: 'order-desk.report.json' },
  ],
  refusals: [
    { step: 'r2-a', kind: 'ledger', evaluation_error: 'the script failed', transaction_body: 'a1b2c3d4' },
    { step: 'r2-h', kind: 'tool', message: 'the gateway refused the request' },
  ],
});

const approval = { role: 'approval', attestation: h('approval'), tx: h('approval tx'), valid_until: 1_800_000_000_000, revoked_tx: null, supersedes: null };
const currentRecord = (): Json => edited(
  goodRecord(), [['approval'], undefined], [['use_case'], data.name], [['approvals'], [approval]], [['challenged'], null], [['rfq_ids'], []],
  [['sub_delegations', 0, 'subagent'], 'stock-reader'], [['sub_delegations', 0, 'hire'], 'propose'],
);
const parse = (value: unknown, policy: RunRecordPolicy = inventory) => parseRunRecord(value, data, policy);

/** A copy of `base` with the edits made. */
function edited(base: Json, ...edits: Edit[]): Json {
  const copy = structuredClone(base);
  for (const [path, value] of edits) {
    let node = copy;
    for (const key of path.slice(0, -1)) node = (node as Record<string, Json>)[key as string]!;
    const last = path[path.length - 1] as string;
    if (value === undefined) delete (node as Record<string, Json>)[last];
    else (node as Record<string, Json>)[last] = value;
  }
  return copy;
}

function refusedAt(value: unknown, member: string, policy: RunRecordPolicy = inventory): void {
  let caught: unknown;
  try { parse(value, policy); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(RunRecordError);
  expect((caught as RunRecordError).member).toBe(member);
  expect((caught as RunRecordError).message.startsWith(`${member}: `)).toBe(true);
}

describe('parseRunRecord', () => {
  it('reads the declared example of the first inventory input format', () => {
    // The original pack asked the operator to assemble this format. There is no run record writer.
    const example: unknown = JSON.parse(readFileSync(new URL('./fixtures/inventory-run-v1.example.json', import.meta.url), 'utf8'));
    expect(parse(example)).toMatchObject({
      legacy: true, label: 'r1', use_case: data.name, approvals: [{ role: 'approval', attestation: '33'.repeat(32), valid_until: null }],
      sub_delegations: [{ subagent: null, hire: null }], hires: [{ step: 'propose', report_file: 'propose.report.json' }],
    });
  });

  it('normalizes the old record without inventing a validity end or a sub-delegation association', () => {
    const old = goodRecord();
    const before = JSON.stringify(old);
    expect(parse(old)).toMatchObject({
      legacy: true, use_case: data.name, challenged: null, approvals: [{ ...approval, valid_until: null }],
      sub_delegations: [{ id: h('sub'), subagent: null, hire: null }], rfq_ids: [],
    });
    expect(JSON.stringify(old)).toBe(before);
  });

  it('reads every new member and validates its relation to the use-case data', () => {
    expect(parse(currentRecord())).toMatchObject({
      legacy: false, challenged: null, approvals: [approval],
      sub_delegations: [{ subagent: 'stock-reader', hire: 'propose' }],
    });
    refusedAt(edited(currentRecord(), [['sub_delegations', 0, 'subagent'], undefined]), 'sub_delegations[0].subagent');
    refusedAt(edited(currentRecord(), [['sub_delegations', 0, 'hire'], 'order-desk']), 'sub_delegations[0].hire');
    refusedAt(edited(currentRecord(), [['use_case'], 'another-use-case']), 'use_case');
    refusedAt(edited(currentRecord(), [['challenged'], 1]), 'challenged');
    refusedAt(edited(currentRecord(), [['challenged'], 'order-desk']), 'challenged');
    const failure = edited(currentRecord(), [['kind'], 'failure'], [['challenged'], 'order-desk'], [['approvals'], []]);
    expect(parse(failure)).toMatchObject({ challenged: 'order-desk', approvals: [] });
  });

  it('rejects a hybrid shape and never migrates an unapproved module or a malformed old value', () => {
    refusedAt(edited(goodRecord(), [['use_case'], data.name]), 'use_case');
    refusedAt(goodRecord(), 'use_case', { ...inventory, readLegacy: false });
    refusedAt(edited(goodRecord(), [['approval', 'valid_until'], 1]), 'approval.valid_until');
  });

  it('checks the list limits, roles, timestamps, unique request ids and the optional report scope', () => {
    refusedAt(edited(currentRecord(), [['approvals'], Array.from({ length: 5 }, (_, i) => ({ ...approval, attestation: h(String(i)) }))]), 'approvals');
    refusedAt(edited(currentRecord(), [['approvals', 0, 'role'], 'other']), 'approvals[0].role');
    refusedAt(edited(currentRecord(), [['approvals', 0, 'valid_until'], null]), 'approvals[0].valid_until');
    refusedAt(edited(currentRecord(), [['rfq_ids'], ['request-1']]), 'rfq_ids');
    const bid = { ...inventory, allowRfqs: true, reportOptional: ['order-desk'] };
    const withoutReport = edited(currentRecord(), [['hires', 1, 'report_file'], null], [['rfq_ids'], ['request-1', 'request-2']]);
    expect(parse(withoutReport, bid)).toMatchObject({ rfq_ids: ['request-1', 'request-2'], hires: [{ step: 'propose' }, { report_file: null }] });
    refusedAt(edited(withoutReport, [['rfq_ids', 1], 'request-1']), 'rfq_ids[1]', bid);
    refusedAt(edited(currentRecord(), [['hires', 1, 'report_file'], null]), 'hires[1].report_file');
    refusedAt(edited(withoutReport, [['hires', 1, 'reclaim_tx'], null]), 'hires[1].reclaim_tx', bid);
  });

  it('accepts each of the three agents of a module role and refuses another agent of the data', () => {
    const agents = ['desk-one', 'desk-two', 'desk-three', 'desk-four'];
    const use = { ...data, agents: [...data.agents, ...agents.map((id) => ({ ...data.agents[1]!, id }))] };
    const bid: RunRecordPolicy = { ...inventory, hireRoles: ['propose', 'quote'], agentOf: (role) => role === 'quote' ? agents.slice(0, 3) : inventory.agentOf(role) };
    const quote = (agent: string) => edited(currentRecord(), [['hires', 1, 'step'], 'quote-b'], [['hires', 1, 'agent'], agent]);
    for (const agent of agents.slice(0, 3)) expect(parseRunRecord(quote(agent), use, bid).hires[1]?.agent).toBe(agent);
    expect(() => parseRunRecord(quote('desk-four'), use, bid)).toThrow('hires[1].agent: is not an agent of the hire role quote');
  });

  it('reads only the named lifecycle fact ids and refuses a lifecycle record with any hire', () => {
    const lifecycle = edited(currentRecord(),
      [['kind'], 'lifecycle'], [['tenant'], null], [['lifecycle'], ['controller-change', 'retire']],
      [['delegations'], []], [['vaults'], []], [['approvals'], []], [['sub_delegations'], []], [['hires'], []],
    );
    expect(parse(lifecycle)).toMatchObject({ kind: 'lifecycle', tenant: null, lifecycle: ['controller-change', 'retire'] });
    refusedAt(edited(lifecycle, [['hires'], [1]]), 'hires');
    refusedAt(edited(lifecycle, [['lifecycle', 1], 'controller-change']), 'lifecycle[1]');
    expect(hireRoleOf('call-bid-a2', ['quote', 'call', 'call-bid'])).toBe('call-bid');
    expect(hireRoleOf('quote-too-long', ['quote'])).toBeNull();
  });

  it('takes the empty lists that a run can have, and a hire that is neither accepted nor reclaimed', () => {
    const record = edited(goodRecord(), [['sub_delegations'], []], [['refusals'], []], [['hires', 1, 'reclaim_tx'], null]);
    expect(parse(record).hires[1]!.reclaim_tx).toBeNull();
  });

  const refusals: Array<[string, Edit[], string]> = [
    ['an unknown member of the record', [[['extra'], 1]], 'extra'],
    ['an unknown member of a hire', [[['hires', 0, 'extra'], 1]], 'hires[0].extra'],
    ['a member with the name of a secret', [[['token'], 'x']], 'token'],
    ['a missing member', [[['tenant'], undefined]], 'tenant'],
    ['a format that is not 1', [[['format'], 2]], 'format'],
    ['a label in upper case', [[['label'], 'R1']], 'label'],
    ['a kind that is no run of the data', [[['kind'], 'dress']], 'kind'],
    ['a date that does not exist', [[['date'], '2026-02-30']], 'date'],
    ['a date with a short day', [[['date'], '2026-12-1']], 'date'],
    ['a tenant with a space', [[['tenant'], 'a tenant']], 'tenant'],
    ['delegations that are no list', [[['delegations'], {}]], 'delegations'],
    ['no delegation', [[['delegations'], []]], 'delegations'],
    ['a delegation id in upper case', [[['delegations', 0, 'id'], h('delegation').toUpperCase()]], 'delegations[0].id'],
    ['a delegation transaction of 63 characters', [[['delegations', 0, 'tx'], h('x').slice(1)]], 'delegations[0].tx'],
    ['an end transaction that is no hash', [[['delegations', 0, 'ended_tx'], 5]], 'delegations[0].ended_tx'],
    ['a vault reference with no index', [[['vaults', 0, 'ref'], h('vault')]], 'vaults[0].ref'],
    ['a vault open transaction that is no hash', [[['vaults', 0, 'open_tx'], 'abc']], 'vaults[0].open_tx'],
    ['an approval with no transaction', [[['approval', 'tx'], undefined]], 'approval.tx'],
    ['an approval that is a list', [[['approval'], [h('a')]]], 'approval'],
    ['a sub-delegation that is not ended', [[['sub_delegations', 0, 'undelegate_tx'], null]], 'sub_delegations[0].undelegate_tx'],
    ['a hire step in upper case', [[['hires', 0, 'step'], 'Propose']], 'hires[0].step'],
    ['a hire step that names no operation', [[['hires', 0, 'step'], 'approve']], 'hires[0].step'],
    ['an agent that does not fit the step', [[['hires', 0, 'agent'], 'order-desk']], 'hires[0].agent'],
    ['the same step twice', [[['hires', 1, 'step'], 'propose'], [['hires', 1, 'agent'], 'reorder-agent']], 'hires[1].step'],
    ['an advert reference that is no reference', [[['hires', 0, 'advert_ref'], 'x#0']], 'hires[0].advert_ref'],
    ['an escrow reference with an index of 7 digits', [[['hires', 0, 'escrow_ref'], ref('escrow propose', 1_234_567)]], 'hires[0].escrow_ref'],
    ['the same escrow twice', [[['hires', 1, 'escrow_ref'], ref('escrow propose')]], 'hires[1].escrow_ref'],
    ['a hire that is accepted and reclaimed', [[['hires', 0, 'reclaim_tx'], h('reclaim')]], 'hires[0].reclaim_tx'],
    ['a report file in another folder', [[['hires', 0, 'report_file'], '../propose.report.json']], 'hires[0].report_file'],
    ['a report file with a slash', [[['hires', 0, 'report_file'], 'a/b.json']], 'hires[0].report_file'],
    ['a report file that is no json file', [[['hires', 0, 'report_file'], 'propose.txt']], 'hires[0].report_file'],
    ['a refusal kind that is neither ledger nor tool', [[['refusals', 0, 'kind'], 'other']], 'refusals[0].kind'],
    ['a ledger refusal without its body', [[['refusals', 0, 'transaction_body'], undefined]], 'refusals[0].transaction_body'],
    ['a ledger refusal with a body that is no hex', [[['refusals', 0, 'transaction_body'], 'xyz']], 'refusals[0].transaction_body'],
    ['a ledger refusal with a body of an odd length', [[['refusals', 0, 'transaction_body'], 'abc']], 'refusals[0].transaction_body'],
    ['a ledger refusal with no evaluation error', [[['refusals', 0, 'evaluation_error'], '  ']], 'refusals[0].evaluation_error'],
    ['a ledger refusal with a message', [[['refusals', 0, 'message'], 'x']], 'refusals[0].message'],
    ['a tool refusal without its message', [[['refusals', 1, 'message'], undefined]], 'refusals[1].message'],
    ['a tool refusal with an empty message', [[['refusals', 1, 'message'], '']], 'refusals[1].message'],
    ['a tool refusal with a body', [[['refusals', 1, 'transaction_body'], 'ab']], 'refusals[1].transaction_body'],
    ['a message that holds a bearer token', [[['refusals', 1, 'message'], 'the header was Bearer abc123']], 'refusals[1].message'],
    ['an evaluation error that holds a key', [[['refusals', 0, 'evaluation_error'], `the key ${KEY_TEXT} failed`]], 'refusals[0].evaluation_error'],
  ];
  for (const [what, edits, member] of refusals) {
    it(`refuses ${what} and names ${member}`, () => {
      refusedAt(edited(goodRecord(), ...edits), member);
    });
  }

  it('refuses a record that is no object, and a list of delegations with the same id twice', () => {
    refusedAt('text', 'the record');
    refusedAt(edited(goodRecord(), [['delegations'], [{ id: h('d'), tx: h('t1'), ended_tx: null }, { id: h('d'), tx: h('t2'), ended_tx: null }]]), 'delegations[1].id');
  });

  it('takes the twins of the refusals: a body in upper case of even length, a reclaimed hire, and a refusal text that only looks like a secret', () => {
    const record = edited(
      goodRecord(), [['hires', 0, 'accept_tx'], null], [['hires', 0, 'reclaim_tx'], h('reclaim')], [['refusals', 0, 'transaction_body'], 'AbCdEf00'], [['refusals', 1, 'message'], 'The bearerless request was refused.'],
    );
    expect(() => parse(record)).not.toThrow();
  });
});

describe('parseReport', () => {
  const result = '{"a":1}';
  const good = (): Json => ({
    verdict: 'VERIFIED', checks: { escrow_ref_matches: 'pass', response_hash_matches: 'pass' },
    receipt: { escrow_ref: ref('escrow'), response_hash: h('response'), model: 'reorder-agent-v1', supplier_pkh: 'ab'.repeat(28), prompt_hash: h('prompt') },
    receipt_signature: 'cd'.repeat(64), result,
  });

  it('takes a good report', () => {
    expect(parseReport(good(), 'the report').result).toBe(result);
  });

  const refusals: Array<[string, Edit[], string]> = [
    ['an unknown member', [[['extra'], 1]], 'extra'],
    ['a verdict that is not VERIFIED', [[['verdict'], 'FAILED']], 'verdict'],
    ['no checks', [[['checks'], {}]], 'checks'],
    ['a check that did not pass', [[['checks', 'signature_valid'], 'fail']], 'checks.signature_valid'],
    ['a receipt with no response hash', [[['receipt', 'response_hash'], undefined]], 'receipt.response_hash'],
    ['a receipt with a response hash that is no hash', [[['receipt', 'response_hash'], 'abc']], 'receipt.response_hash'],
    ['a receipt with no escrow reference', [[['receipt', 'escrow_ref'], 5]], 'receipt.escrow_ref'],
    ['a signature of 126 characters', [[['receipt_signature'], 'cd'.repeat(63)]], 'receipt_signature'],
    ['a result that is no text', [[['result'], { a: 1 }]], 'result'],
    ['a result that holds a bearer token', [[['result'], 'Bearer abc123']], 'result'],
    ['a model that holds a key', [[['receipt', 'model'], KEY_TEXT]], 'receipt.model'],
  ];
  for (const [what, edits, member] of refusals) {
    it(`refuses ${what} and names ${member}`, () => {
      expect(() => parseReport(edited(good(), ...edits), 'the report')).toThrow(`the report: ${member}: `);
    });
  }
  it('takes a report whose receipt has more members than the five that it needs', () => {
    expect(() => parseReport(edited(good(), [['receipt', 'prompt_tokens'], 0], [['receipt', 'wallclock_ms'], 12]), 'the report')).not.toThrow();
  });
});

/** A fake Koios: it answers `tx_info` from a table, and keeps the requests. */
function koios(rows: Record<string, unknown>[], status = 200): { fetchImpl: typeof fetch; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : null });
    return new Response(JSON.stringify(rows), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('txInfoOf and txTimeOf', () => {
  const hash = h('tx');
  const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    outputs: [{ tx_hash: h('out'), tx_index: 0, payment_addr: { cred: 'cd'.repeat(28) } }, { tx_hash: h('out'), tx_index: 1, payment_addr: null }],
    tx_hash: hash, tx_timestamp: 1_794_000_000, inputs: [{ tx_hash: h('in'), tx_index: 2, payment_addr: { cred: 'ab'.repeat(28) } }, { tx_hash: h('wallet'), tx_index: 0, payment_addr: null }], ...over,
  });

  it('gives the block time in milliseconds, the inputs with their credentials and the minted tokens, and asks Koios for the inputs and the assets', async () => {
    const world = koios([row()]);
    const info = await txInfoOf(world.fetchImpl, 'https://koios.test/', hash);
    expect(info.timeMs).toBe(1_794_000_000_000);
    expect(info.inputs).toEqual([{ ref: `${h('in')}#2`, credential: 'ab'.repeat(28) }, { ref: `${h('wallet')}#0`, credential: null }]);
    expect(world.calls).toHaveLength(1);
    expect(world.calls[0]!.url).toBe('https://koios.test/api/v1/tx_info');
    expect(world.calls[0]!.method).toBe('POST');
    expect(world.calls[0]!.body).toEqual({ _tx_hashes: [hash], _inputs: true, _assets: true });
    expect(info.minted).toEqual([]);
    expect(info.outputs).toEqual([{ credential: 'cd'.repeat(28) }, { credential: null }]);
  });

  it('gives each minted token with its policy, its name and its quantity, and a negative quantity for a burn, in lower case', async () => {
    const policy = 'ab'.repeat(28);
    const listed = [{ policy_id: policy.toUpperCase(), asset_name: 'AABB', quantity: '1' }, { policy_id: policy, asset_name: '', quantity: '-1' }, { policy_id: policy, asset_name: 'cc', quantity: 2 }];
    const info = await txInfoOf(koios([row({ assets_minted: listed })]).fetchImpl, 'https://koios.test', hash);
    expect(info.minted).toEqual([{ policy, name: 'aabb', quantity: 1n }, { policy, name: '', quantity: -1n }, { policy, name: 'cc', quantity: 2n }]);
    expect((await txInfoOf(koios([row({ assets_minted: null })]).fetchImpl, 'https://koios.test', hash)).minted).toEqual([]);
  });

  it('gives the block time alone through txTimeOf', async () => {
    expect(await txTimeOf(koios([row()]).fetchImpl, 'https://koios.test', hash)).toBe(1_794_000_000_000);
  });

  it('uses the script flags when the transaction row has no phase-two flag', async () => {
    const script = { script_hash: 'ab'.repeat(28), valid_contract: true, spends_input: { tx_hash: h('in'), tx_index: 2 },
      input: { redeemer: { purpose: 'spend', datum: { value: { constructor: 2, fields: [] } } } } };
    const mint = { ...script, input: { redeemer: { purpose: 'mint' } } };
    const world = koios([row({ fee: '250001', outputs: [], plutus_contracts: [script, mint] })]);
    const proof = await scriptTxInfoOf(world.fetchImpl, 'https://koios.test', hash);
    expect(proof.spends).toEqual([{ script: script.script_hash, input: `${h('in')}#2`, valid: true, action: 2, fields: [] }]);
    expect(proof.fee).toBe(250_001n);
    expect(world.calls[0]?.body).toMatchObject({ _scripts: true });
  });

  it.each(['mint', 'reward', 'spend'] as const)('refuses any false phase-two flag on a %s run, even when the other flags are true', async (purpose) => {
    const spend = { script_hash: 'ab'.repeat(28), valid_contract: true, spends_input: { tx_hash: h('in'), tx_index: 2 },
      input: { redeemer: { purpose: 'spend', datum: { value: { constructor: 2, fields: [] } } } } };
    const failed = { ...spend, valid_contract: false, input: { redeemer: { ...spend.input.redeemer, purpose } } };
    for (const fields of [
      { plutus_contracts: [spend, failed] },
      { valid_contract: true, plutus_contracts: [spend, failed] },
      { valid_contract: false, plutus_contracts: [spend] },
    ]) {
      const world = koios([row({ outputs: [], ...fields })]);
      await expect(scriptTxInfoOf(world.fetchImpl, 'https://koios.test', hash)).rejects.toThrow('does not show successful script validation');
    }
  });

  const failures: Array<[string, Record<string, unknown>[], number, string]> = [
    ['a status that is not 200', [row()], 503, 'Koios tx_info answered 503'],
    ['a transaction that Koios does not know', [], 200, 'Koios does not know the transaction'],
    ['a row of another transaction', [row({ tx_hash: h('other') })], 200, 'did not return one row of the requested transaction'],
    ['a time that is no whole number', [row({ tx_timestamp: 'now' })], 200, 'no block time'],
    ['a time of zero', [row({ tx_timestamp: 0 })], 200, 'no block time'],
    ['inputs that are no list', [row({ inputs: null })], 200, 'no list of inputs'],
    ['an input without an index', [row({ inputs: [{ tx_hash: h('in'), payment_addr: null }] })], 200, 'an input that is no output'],
    ['outputs that are no list', [row({ outputs: null })], 200, 'no list of outputs'],
    ['an output that is no object', [row({ outputs: [5] })], 200, 'an output that is no object'],
    ['minted tokens that are no list', [row({ assets_minted: 'a token' })], 200, 'minted tokens that is no list'],
    ['a minted token without a quantity', [row({ assets_minted: [{ policy_id: 'ab'.repeat(28), asset_name: 'aa' }] })], 200, 'a minted token of a wrong shape'],
    ['a minted token with a quantity that is no whole number', [row({ assets_minted: [{ policy_id: 'ab'.repeat(28), asset_name: 'aa', quantity: '1.5' }] })], 200, 'a minted token of a wrong shape'],
    ['a minted token with a policy of 55 characters', [row({ assets_minted: [{ policy_id: 'ab'.repeat(27) + 'a', asset_name: 'aa', quantity: '1' }] })], 200, 'a minted token of a wrong shape'],
    ['a minted token with a name that is no hex', [row({ assets_minted: [{ policy_id: 'ab'.repeat(28), asset_name: 'xyz', quantity: '1' }] })], 200, 'a minted token of a wrong shape'],
  ];
  for (const [what, rows, status, message] of failures) {
    it(`refuses ${what}, and the message shows no address and no body`, async () => {
      const err = await txInfoOf(koios(rows, status).fetchImpl, 'https://koios.secret.test', hash).then(() => new Error('it passed'), (e: unknown) => e as Error);
      expect(err.message).toContain(message);
      expect(err.message).not.toContain('koios.secret.test');
      expect(err instanceof UnknownTransactionError).toBe(rows.length === 0);
    });
  }

  it('turns a failed call into a message with the short code of the network and no address', async () => {
    const fetchImpl = (async () => { throw Object.assign(new TypeError('fetch failed for https://koios.secret.test'), { cause: { code: 'ECONNREFUSED' } }); }) as unknown as typeof fetch;
    const err = await txTimeOf(fetchImpl, 'https://koios.secret.test', hash).then(() => new Error('it passed'), (e: unknown) => e as Error);
    expect(err.message).toContain('ECONNREFUSED');
    expect(err.message).not.toContain('secret');
  });
});
