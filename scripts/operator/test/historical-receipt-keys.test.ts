import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { blake2b256Hex, verifyReceipt } from '../../../packages/buyer-core/src/index.ts';
import { PURPOSE, effectiveStatus, tombstone } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { REDEEMER } from '../../../packages/buyer-core/src/vendored/mcp/marketplace-constants.ts';
import { escrowUtxo, identityEscrow } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { FixtureProvider } from '../../../packages/buyer-core/test/fixtures/fixture-provider.ts';
import { CAPTURE_MS, MAINNET, koiosRow, liveRecord, recordUtxo } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { Row as KoiosUtxoRow } from '../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { ed25519Key, identifier } from '../../../packages/id-kit/src/testing/keys.ts';
import { canonicalize, sha256Utf8Hex } from '../../../packages/vector-read/src/datum.ts';
import { decodeIdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import { historicalReceiptKey } from '../lib/evidence/historical-receipt-keys.ts';

const AGENT = identifier('receipt history: agent');
const INITIAL = identifier('receipt history: register');
const ROTATE = identifier('receipt history: rotate');
const REVOKE = identifier('receipt history: revoke');
const SUBMIT = identifier('receipt history: submit');
const POST = `${identifier('receipt history: post')}#0`;
const CLAIM = identifier('receipt history: claim');
const REF_SCRIPT = identifier('receipt history: script');
const OLD = ed25519Key('receipt history: first supplier');
const NEW = ed25519Key('receipt history: second supplier');
const HEIGHT = 9_050_000;
const SLOT = 8_000_000;
const BLOCK_MS = CAPTURE_MS + 2_000;
const EXPIRY = BLOCK_MS + 20_000;
const REF = `${SUBMIT}#0`;
const refOf = (u: Utxo): string => `${u.txHash}#${u.outputIndex}`;

const block = (delta: number) => ({ hash: identifier(`receipt history: block ${delta}`), abs_slot: SLOT + 10 * delta, block_height: HEIGHT + delta, block_time: BLOCK_MS / 1000 + 10 * delta });
const position = (delta: number, index: number) => ({ block_hash: block(delta).hash, absolute_slot: block(delta).abs_slot, block_height: block(delta).block_height,
  tx_timestamp: block(delta).block_time, tx_block_index: index });
const hashDatum = (hex: string): string => blake2b256Hex(Buffer.from(hex, 'hex'));

function onKoios(utxo: Utxo, delta: number, spent: boolean): KoiosUtxoRow {
  return koiosRow(utxo, { datum_hash: utxo.datum ? hashDatum(utxo.datum) : null, block_height: block(delta).block_height, block_time: block(delta).block_time, is_spent: spent });
}

// tx_info names the address and output. The bytes are in extended utxo_info, not tx_info.
function io(utxo: Utxo) {
  const row = koiosRow(utxo);
  return { tx_hash: utxo.txHash, tx_index: utxo.outputIndex, payment_addr: { cred: row.payment_cred, bech32: utxo.address }, value: row.value,
    datum_hash: utxo.datum ? hashDatum(utxo.datum) : null, inline_datum: utxo.datum ? { bytes: null } : null, asset_list: row.asset_list };
}
const slimRef = (utxo: Utxo) => ({ tx_hash: utxo.txHash, tx_index: utxo.outputIndex });
const script = (hash: string, purpose: 'mint' | 'spend', index: number, input?: Utxo, fields: readonly unknown[] = []) => ({
  script_hash: hash, valid_contract: true, spends_input: input === undefined ? null : slimRef(input), input: { redeemer: { purpose, datum: { value: { constructor: index, fields } } } },
});

type JsonRow = Record<string, unknown>;
interface Options {
  rotate?: 'before' | 'after';
  invalidFrom?: number | null;
  stale?: boolean;
  liveSubmit?: boolean;
  controllerOnly?: boolean;
  shortLivedParty?: boolean;
}

function world(options: Options = {}) {
  const data = liveRecord({}, [OLD.publicKeyHex]);
  const first = { ...recordUtxo(AGENT, options.controllerOnly ? { ...data, controller: OLD.publicKeyHex, keys: [] }
    : options.shortLivedParty ? { ...data, parties: data.parties.map((p) => ({ ...p, notAfter: EXPIRY - 1 })) } : data), txHash: INITIAL };
  const rotatedDatum = liveRecord({}, [NEW.publicKeyHex]);
  const rotated = { ...recordUtxo(AGENT, rotatedDatum), txHash: ROTATE };
  const atSubmit = options.rotate === 'before' ? rotated : first;
  const signer = options.rotate === 'before' ? NEW : OLD;
  const later = options.rotate === undefined ? first : rotated;
  const revokedDatum = tombstone(options.rotate === undefined ? data : rotatedDatum,
    { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: BLOCK_MS + 40_000, invalidFrom: options.invalidFrom ?? null, successor: null });
  const revoked = { ...recordUtxo(AGENT, revokedDatum), txHash: REVOKE };
  const head = options.invalidFrom !== undefined ? revoked : later;
  const claim = escrowUtxo(CLAIM, identityEscrow(BLOCK_MS - 60_000, { state: 'Claimed' }), { address: MAINNET.escrow.address });
  const text = '{"quote":"signed by the Bid Desk"}\n';
  const promptHash = sha256Utf8Hex('trial request');
  const receipt = { escrow_ref: POST, supplier_pkh: signer.keyHash, prompt_hash: promptHash, response_hash: sha256Utf8Hex(text),
    model: 'bid-desk-v1', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 100, agent_did: `did:vector:${AGENT}` };
  const signature = sign(null, Buffer.from(canonicalize(receipt), 'utf8'), signer.privateKey).toString('hex');
  const receiptHash = sha256Utf8Hex(canonicalize({ receipt, signature }));
  const submitted = escrowUtxo(SUBMIT, identityEscrow(BLOCK_MS - 60_000, { state: 'Submitted', submitted_at: EXPIRY,
    agent_id: AGENT, supplier_pkh: signer.keyHash, prompt_hash: promptHash, result_receipt_hash: receiptHash }), { address: MAINNET.escrow.address });
  const refScript: Utxo = { txHash: REF_SCRIPT, outputIndex: 0, address: MAINNET.escrow.address, assets: { lovelace: 3_000_000n } };
  const reference = options.stale ? first : atSubmit;
  const submitTx: JsonRow = { tx_hash: SUBMIT, ...position(0, 4), invalid_before: String(SLOT - 10), invalid_after: String(SLOT + 20),
    reference_inputs: [io(reference), slimRef(refScript)], inputs: [io(claim)], outputs: [io(submitted)], assets_minted: [],
    plutus_contracts: [script(MAINNET.escrow.hash, 'spend', REDEEMER.Submit, claim, [{ bytes: receiptHash }])], collateral_inputs: [] };
  const registerTx = { tx_hash: INITIAL, ...position(-2, 1), inputs: [], outputs: [io(first)],
    assets_minted: [{ policy_id: MAINNET.identity.hash, asset_name: AGENT, quantity: '1' }], plutus_contracts: [script(MAINNET.identity.hash, 'mint', 0)] };
  const rotateTx = { tx_hash: ROTATE, ...position(0, options.rotate === 'before' ? 3 : 5), inputs: [io(first)], outputs: [io(rotated)],
    assets_minted: [], plutus_contracts: [script(MAINNET.identity.hash, 'spend', 0, first)] };
  const revokeTx = { tx_hash: REVOKE, ...position(4, 3), inputs: [io(later)], outputs: [io(revoked)],
    assets_minted: [], plutus_contracts: [script(MAINNET.identity.hash, 'spend', 4, later)] };
  const history = [registerTx, ...(options.rotate === undefined ? [] : [rotateTx]), ...(options.invalidFrom === undefined ? [] : [revokeTx])].reverse();
  const txs = new Map<string, JsonRow>([submitTx, ...history].map((tx) => [String(tx.tx_hash), tx]));
  const outputs = new Map([onKoios(first, -2, first !== head), onKoios(rotated, 0, rotated !== head), onKoios(revoked, 4, false),
    onKoios(submitted, 0, options.liveSubmit !== true), onKoios(refScript, -2, false)].map((row) => [`${row.tx_hash}#${row.tx_index}`, row]));
  const blocks = new Map([-2, 0, 4, 8].map((d) => [block(d).hash, block(d)]));
  const tips = [{ hash: block(8).hash, slot: block(8).abs_slot }];
  const node = new FixtureProvider([head, ...(options.liveSubmit ? [submitted] : [])]);
  const provider = Object.assign(node, { getNetworkTip: async () => tips.length === 1 ? tips[0]! : tips.shift()! });
  const calls: string[] = [];
  const perturb: { moveSecondTx?: boolean; duplicateToken?: boolean; assetCount?: number; returnPrivateError?: boolean } = {};
  let txReads = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url));
    expect(path.origin).toBe('https://koios.example');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    const route = path.pathname.split('/').at(-1)!;
    calls.push(route);
    const input = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (perturb.returnPrivateError) throw new Error('https://credentials.invalid/never-show-this?token=private-string');
    if (route === 'asset_txs') {
      expect(input).toEqual({ _asset_policy: MAINNET.identity.hash, _asset_name: AGENT, _history: true });
      expect(path.searchParams.get('limit')).toBe('65');
      return Response.json(perturb.assetCount === undefined ? history.map((tx) => ({ tx_hash: tx.tx_hash, block_height: tx.block_height, block_time: tx.tx_timestamp }))
        : Array.from({ length: perturb.assetCount }, (_, n) => ({ tx_hash: identifier(`too many transactions ${n}`) })));
    }
    if (route === 'tx_info') {
      expect(input).toMatchObject({ _assets: true, _inputs: true, _scripts: true });
      const second = ++txReads > 1;
      return Response.json((input._tx_hashes as string[]).flatMap((hash) => {
        const tx = txs.get(hash);
        return tx === undefined ? [] : [second && perturb.moveSecondTx && hash === SUBMIT ? { ...tx, tx_block_index: 6 } : tx];
      }));
    }
    if (route === 'utxo_info') {
      expect(input._extended).toBe(true);
      return Response.json((input._utxo_refs as string[]).flatMap((ref) => {
        const row = outputs.get(ref);
        if (row === undefined) return [];
        return [perturb.duplicateToken && ref === refOf(refScript) ? { ...row, asset_list: outputs.get(refOf(atSubmit))!.asset_list } : row];
      }));
    }
    if (route === 'block_info') return Response.json((input._block_hashes as string[]).flatMap((hash) => blocks.has(hash) ? [blocks.get(hash)] : []));
    throw new Error('unexpected local request');
  };
  const env = { provider, deployment: MAINNET, koiosUrl: 'https://koios.example', fetchImpl };
  const expectSigned = (key: string) => verifyReceipt({ receipt, signature, escrowRef: POST, result: text, supplierPubKeyHex: key,
    escrowSupplierPkh: signer.keyHash, escrowPromptHash: promptHash, escrowAgentId: AGENT, resultReceiptHashOnChain: receiptHash }).verdict;
  return { env, submitted: { ref: REF, receiptHash, agentId: AGENT, supplierPkh: signer.keyHash }, atSubmit, head, submitTx, outputs, blocks, tips, calls, perturb, expectSigned };
}

describe('historical supplier receipt proof', () => {
  it.each([null, EXPIRY - 1, EXPIRY, EXPIRY + 1])('verifies a receipt from before the tombstone and reports invalid_from %s separately', async (invalidFrom) => {
    const w = world({ invalidFrom });
    const found = await historicalReceiptKey(w.env, w.submitted);
    expect(found).toStrictEqual({ publicKeyHex: OLD.publicKeyHex, recordRef: `${INITIAL}#0`, submittedAtMs: EXPIRY,
      revocation: { recordRef: `${REVOKE}#0`, invalidFromMs: invalidFrom, invalidatesSubmission: invalidFrom !== null && invalidFrom <= EXPIRY } });
    expect(w.expectSigned(found.publicKeyHex)).toBe('verified');
    const now = decodeIdentityDatum(w.head.datum!);
    expect(now.keys).toEqual([]);
    expect(effectiveStatus(now, new Map(), BLOCK_MS + 60_000, BLOCK_MS + 60_000)).toBe('Revoked');
  });

  it.each(['before', 'after'] as const)('uses the key at Submit when rotation lands %s it in the same block', async (rotate) => {
    const w = world({ rotate, liveSubmit: true });
    const found = await historicalReceiptKey(w.env, w.submitted);
    expect(found).toMatchObject({ publicKeyHex: (rotate === 'before' ? NEW : OLD).publicKeyHex, recordRef: refOf(w.atSubmit), revocation: null });
    expect(w.expectSigned(found.publicKeyHex)).toBe('verified');
    if (rotate === 'after') expect(w.expectSigned(NEW.publicKeyHex)).toBe('failed');
  });

  it('refuses an authentic old output if a same-block rotation already spent it', async () => {
    const w = world({ rotate: 'before', stale: true });
    await expect(historicalReceiptKey(w.env, w.submitted)).rejects.toThrow('did not reference the authentic record in effect');
    const control = world({ rotate: 'before' });
    expect(control.expectSigned((await historicalReceiptKey(control.env, control.submitted)).publicKeyHex)).toBe('verified');
  });

  it('refuses a substitute datum, a duplicate reference token and a different commitment', async () => {
    const altered = world({ rotate: 'after' });
    altered.outputs.get(refOf(altered.atSubmit))!.inline_datum = { bytes: altered.head.datum! };
    await expect(historicalReceiptKey(altered.env, altered.submitted)).rejects.toThrow('the exact inline datum disagrees with its transaction');
    const duplicate = world();
    duplicate.perturb.duplicateToken = true;
    await expect(historicalReceiptKey(duplicate.env, duplicate.submitted)).rejects.toThrow('the Submit reference conflicts with the identity token');
    const control = world();
    await expect(historicalReceiptKey(control.env, { ...control.submitted, receiptHash: AGENT })).rejects.toThrow('the Submit redeemer does not commit the receipt');
    expect(control.expectSigned((await historicalReceiptKey(control.env, control.submitted)).publicKeyHex)).toBe('verified');
  });

  it('refuses a controller without the transaction purpose and an authority that ends within the Submit window', async () => {
    const a = world({ controllerOnly: true });
    expect(PURPOSE.transaction).toBe(8);
    await expect(historicalReceiptKey(a.env, a.submitted)).rejects.toThrow('does not list one matching transaction key');
    const b = world({ shortLivedParty: true });
    await expect(historicalReceiptKey(b.env, b.submitted)).rejects.toThrow('was not an active independent supplier during the Submit');
  });

  it('refuses a re-included Submit or a node rollback while reading the proof', async () => {
    const moved = world({ rotate: 'after' });
    moved.perturb.moveSecondTx = true;
    await expect(historicalReceiptKey(moved.env, moved.submitted)).rejects.toThrow('transaction positions changed');
    const rollback = world();
    rollback.tips.push({ hash: block(4).hash, slot: block(4).abs_slot });
    await expect(historicalReceiptKey(rollback.env, rollback.submitted)).rejects.toThrow('the node rolled back');
    const split = world();
    split.blocks.delete(block(8).hash);
    await expect(historicalReceiptKey(split.env, split.submitted)).rejects.toThrow('Koios and the node do not share a chain point');
  });

  it('refuses missing reference data and an oversized history, without leaking source errors', async () => {
    const missing = world();
    delete missing.submitTx.reference_inputs;
    await expect(historicalReceiptKey(missing.env, missing.submitted)).rejects.toThrow('the Submit reference inputs are missing');
    const large = world();
    large.perturb.assetCount = 65;
    await expect(historicalReceiptKey(large.env, large.submitted)).rejects.toThrow('the identity token history is empty or exceeds its limit');
    expect(large.calls).toStrictEqual(['asset_txs']);
    const privateSource = world();
    privateSource.perturb.returnPrivateError = true;
    await expect(historicalReceiptKey(privateSource.env, privateSource.submitted)).rejects.toThrow('the historical supplier key is unproven: a ledger read failed or gave unsupported data');
  });
});
