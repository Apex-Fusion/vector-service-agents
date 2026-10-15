// packages/buyer-core/test/fleet-verify.test.ts
// verifyFleetReceipt: the seven checks on the receipt of a fleet sub-job, run on real Ed25519 signatures (a key generated for each job, never stored)
// and real hashes (the fleet commitments of src/commitments.ts, the receipt hash of @vsa/vector-read). The hosted server's verifier compares
// response_hash with the sha256 of the result text; a fleet supplier hashes a canonical envelope, so this verifier is given the recomputed hash.
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CML } from '@lucid-evolution/lucid';
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { verifyFleetReceipt, verifyReceipt, ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash } from '../src/index.ts';
import type { FleetVerification, FleetVerifyInput, Receipt } from '../src/index.ts';

// --- The job every test starts from: one OCR page, hired from the live ChandraOCR advert's model --------------------------------
const ESCROW = `${'ab'.repeat(32)}#0`;
const OTHER_ESCROW = `${'cd'.repeat(32)}#0`;
const PAGE = { image_b64: 'iVBORw0KGgo=', mime: 'image/png' as const, output_format: 'markdown' as const };
const PAGE_RESULT = { content: 'Page one of the test document.', output_format: 'markdown' };
const MODEL = 'historical-records-ocr-v1';
const PROMPT_HASH = ocrPromptHash(PAGE);
const RESPONSE_HASH = ocrResponseHash(PAGE_RESULT);

type Checks = FleetVerification['checks'];
const ALL_PASS: Checks = {
  escrow_ref_matches: 'pass', response_hash_matches: 'pass', supplier_key_matches: 'pass', signature_valid: 'pass',
  on_chain_hash_matches: 'pass', prompt_hash_matches: 'pass', model_matches: 'pass',
};
const ALL_FAIL: Checks = {
  escrow_ref_matches: 'fail', response_hash_matches: 'fail', supplier_key_matches: 'fail', signature_valid: 'fail',
  on_chain_hash_matches: 'fail', prompt_hash_matches: 'fail', model_matches: 'fail',
};
/** The verdict of the named checks failing and all others passing. */
const onlyFails = (...failing: Array<keyof Checks>): FleetVerification => ({
  verdict: 'FAILED', checks: { ...ALL_PASS, ...Object.fromEntries(failing.map((c) => [c, 'fail'])) },
});

interface SupplierKey { pubKeyHex: string; pkh: string; sign: (receipt: unknown) => string }
/** A supplier key made for the test: the public key as /capability serves it, its hash, and the signature a fleet supplier writes (Ed25519 over utf8(canonicalize(receipt)), in hex). */
function newKey(): SupplierKey {
  const sk = CML.PrivateKey.generate_ed25519();
  const pub = sk.to_public();
  return {
    pubKeyHex: Buffer.from(pub.to_raw_bytes()).toString('hex'),
    pkh: pub.hash().to_hex(),
    sign: (receipt) => sk.sign(Buffer.from(canonicalize(receipt), 'utf8')).to_hex(),
  };
}

/** The eight fields of the spec's receipt table, as a supplier writes them for the job above. */
const receiptFor = (pkh: string): Record<string, unknown> => ({
  escrow_ref: ESCROW, supplier_pkh: pkh, prompt_hash: PROMPT_HASH, response_hash: RESPONSE_HASH, model: MODEL,
  prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 4210,
});

/**
 * A finished job: the receipt the key signed, the hash the supplier put on chain for it, and the input that verifies it. `receipt` and `omit` change the
 * receipt BEFORE it is signed, so the signature and the hash on chain still belong to the receipt as it is: a test that changes one thing changes one thing.
 */
function job(over: { key?: SupplierKey; receipt?: Record<string, unknown>; omit?: string[] } = {}) {
  const key = over.key ?? newKey();
  const receipt: Record<string, unknown> = { ...receiptFor(key.pkh), ...over.receipt };
  for (const field of over.omit ?? []) delete receipt[field];
  const signature = key.sign(receipt);
  const onChainHash = sha256Utf8Hex(canonicalize({ receipt, signature }));
  const input: FleetVerifyInput = {
    escrowRef: ESCROW, receipt, receiptSignature: signature, responseHashHex: RESPONSE_HASH, promptHashHex: PROMPT_HASH,
    supplierPubKeyHex: key.pubKeyHex, supplierPkhExpected: key.pkh, model: MODEL, onChainReceiptHash: async () => onChainHash,
  };
  return { key, receipt, signature, onChainHash, input };
}
type Job = ReturnType<typeof job>;

describe('verifyFleetReceipt, a receipt the supplier key signed', () => {
  it('is VERIFIED with the seven checks passing, and leaves its input as it was', async () => {
    const j = job();
    // The fixture is what it claims to be: a 32-byte key, its 28-byte hash, a 64-byte signature.
    expect(j.key.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(j.key.pkh).toMatch(/^[0-9a-f]{56}$/);
    expect(j.signature).toMatch(/^[0-9a-f]{128}$/);
    const before = structuredClone(j.receipt);
    expect(await verifyFleetReceipt(j.input)).toStrictEqual({ verdict: 'VERIFIED', checks: ALL_PASS });
    expect(j.receipt).toStrictEqual(before);
  });

  it("carries the eight fields of the spec's receipt table", () => {
    const spec = readFileSync(fileURLToPath(new URL('../../../specs/document-pipeline.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
    const table = spec.split('\n## What the receipt commits to\n')[1].split('\n## ')[0];
    // The first cell of each row: one row names two fields (prompt_tokens, completion_tokens).
    const fields = table.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => [...l.split('|')[1].matchAll(/`([a-z_]+)`/g)].map((m) => m[1]));
    expect(fields).toHaveLength(8);
    expect(Object.keys(job().receipt).sort()).toStrictEqual([...fields].sort());
  });

  it('verifies a chat receipt too: its response_hash is the hash of {output, status, incomplete_details}, not of the answer text', async () => {
    const request = { input: 'Summarise the pages in two sentences.' };
    const response = {
      id: 'resp_1', status: 'completed', incomplete_details: null,
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A short summary.' }] }],
      usage: { input_tokens: 812, output_tokens: 9 },
    };
    const model = 'deepseek/deepseek-v4-flash';
    const promptHashHex = responsesPromptHash(request);
    const responseHashHex = responsesResponseHash(response);
    expect(responseHashHex).not.toBe(sha256Utf8Hex('A short summary.'));
    const j = job({ receipt: { prompt_hash: promptHashHex, response_hash: responseHashHex, model, prompt_tokens: 812, completion_tokens: 9 } });
    expect(await verifyFleetReceipt({ ...j.input, promptHashHex, responseHashHex, model })).toStrictEqual({ verdict: 'VERIFIED', checks: ALL_PASS });
    // The same receipt against the OCR page's hashes and model is another job's.
    expect(await verifyFleetReceipt(j.input)).toStrictEqual(onlyFails('response_hash_matches', 'prompt_hash_matches', 'model_matches'));
  });

  it('is what the vendored text check cannot do: that one hashes the result text, and a fleet supplier did not', async () => {
    const j = job();
    const hosted = verifyReceipt({
      receipt: j.receipt, signature: j.signature, escrowRef: ESCROW, result: PAGE_RESULT.content, supplierPubKeyHex: j.key.pubKeyHex,
      escrowSupplierPkh: j.key.pkh, escrowPromptHash: PROMPT_HASH, resultReceiptHashOnChain: j.onChainHash,
    });
    expect(sha256Utf8Hex(PAGE_RESULT.content)).not.toBe(RESPONSE_HASH);
    expect(hosted.verdict).toBe('failed');
    // Its other rows pass on this receipt, as the rows of verifyFleetReceipt do.
    expect(Object.entries(hosted.checks).filter(([, c]) => c.state !== 'pass').map(([name]) => name)).toStrictEqual(['response_hash_matches']);
    expect((await verifyFleetReceipt(j.input)).verdict).toBe('VERIFIED');
  });
});

describe('verifyFleetReceipt, each check on its own', () => {
  const flips: Array<[keyof Checks, string, (j: Job) => Partial<FleetVerifyInput>]> = [
    ['escrow_ref_matches', 'the receipt is for another escrow', () => ({ escrowRef: OTHER_ESCROW })],
    ['response_hash_matches', "the hash recomputed from the result is not the receipt's", () => ({ responseHashHex: ocrResponseHash({ content: 'Another page.', output_format: 'markdown' }) })],
    ['supplier_key_matches', 'the key does not hash to the supplier the buyer paid', () => ({ supplierPkhExpected: newKey().pkh })],
    ['signature_valid', "the signature is another key's, though the hash on chain is of the receipt with that signature", (j) => {
      const forged = newKey().sign(j.receipt);
      return { receiptSignature: forged, onChainReceiptHash: async () => sha256Utf8Hex(canonicalize({ receipt: j.receipt, signature: forged })) };
    }],
    ['on_chain_hash_matches', 'the hash on chain is of another signed receipt', () => ({ onChainReceiptHash: async () => sha256Utf8Hex('another signed receipt') })],
    ['prompt_hash_matches', 'the receipt is for another request', () => ({ promptHashHex: ocrPromptHash({ ...PAGE, image_b64: 'AAAA' }) })],
    ['model_matches', 'the receipt names another model', () => ({ model: 'another-model-v1' })],
  ];
  it.each(flips)('%s fails when %s, and the six others still pass', async (check, _why, wrong) => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, ...wrong(j) })).toStrictEqual(onlyFails(check));
  });

  it('supplier_key_matches fails when the receipt names another supplier than the key, though the key is the one the buyer paid', async () => {
    const j = job({ receipt: { supplier_pkh: newKey().pkh } });
    expect(await verifyFleetReceipt(j.input)).toStrictEqual(onlyFails('supplier_key_matches'));
  });

  it("a key that is another supplier's fails the key check and the signature check: it hashes to neither pkh and does not verify the signature", async () => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, supplierPubKeyHex: newKey().pubKeyHex })).toStrictEqual(onlyFails('supplier_key_matches', 'signature_valid'));
  });

  it('a signature of another key fails the signature check and, the hash on chain being of the real one, the on-chain row', async () => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, receiptSignature: newKey().sign(j.receipt) })).toStrictEqual(onlyFails('signature_valid', 'on_chain_hash_matches'));
  });

  it.each(['prompt_tokens', 'completion_tokens', 'wallclock_ms'])('%s is read by no check but the signature covers it: a change after signing fails the signature and the on-chain row', async (field) => {
    const j = job();
    const tampered = { ...j.receipt, [field]: (j.receipt[field] as number) + 1 };
    expect(await verifyFleetReceipt({ ...j.input, receipt: tampered })).toStrictEqual(onlyFails('signature_valid', 'on_chain_hash_matches'));
  });
});

describe('verifyFleetReceipt, the hash on chain and the verdict', () => {
  it('a null hash on chain skips that row and the verdict is INCOMPLETE', async () => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, onChainReceiptHash: async () => null })).toStrictEqual({ verdict: 'INCOMPLETE', checks: { ...ALL_PASS, on_chain_hash_matches: 'skipped' } });
  });

  it('a check that fails beats the skipped row: FAILED', async () => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, model: 'another-model-v1', onChainReceiptHash: async () => null })).toStrictEqual({
      verdict: 'FAILED', checks: { ...ALL_PASS, model_matches: 'fail', on_chain_hash_matches: 'skipped' },
    });
  });

  it('reads the hash on chain once per call, whatever the other checks say', async () => {
    for (const wrong of [{}, { model: 'another-model-v1' }, { receipt: null as unknown as Receipt }, { receiptSignature: 'not a signature' }]) {
      const j = job();
      const read = vi.fn(async () => j.onChainHash);
      await verifyFleetReceipt({ ...j.input, ...wrong, onChainReceiptHash: read });
      expect(read).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects with the error the read threw and gives no verdict: a read that failed says nothing about the receipt', async () => {
    const j = job();
    const boom = new Error('the indexer is behind');
    await expect(verifyFleetReceipt({ ...j.input, onChainReceiptHash: async () => { throw boom; } })).rejects.toBe(boom);
    await expect(verifyFleetReceipt({ ...j.input, onChainReceiptHash: () => Promise.reject(boom) })).rejects.toBe(boom);
    // A read that throws before it returns its promise is a rejection as well, not a throw out of verifyFleetReceipt.
    await expect(verifyFleetReceipt({ ...j.input, onChainReceiptHash: () => { throw boom; } })).rejects.toBe(boom);
  });
});

describe('verifyFleetReceipt, a malformed receipt', () => {
  it.each([['null', null], ['an array', [1, 2]], ['a string', 'receipt'], ['a number', 42], ['undefined', undefined]])('%s is no receipt: every row that reads it fails, the verdict is FAILED, nothing throws', async (_what, junk) => {
    const j = job();
    const input = { ...j.input, receipt: junk as unknown as Receipt };
    expect(await verifyFleetReceipt(input)).toStrictEqual({ verdict: 'FAILED', checks: ALL_FAIL });
    // With no hash on chain the last row is skipped, and the verdict is FAILED all the same.
    expect(await verifyFleetReceipt({ ...input, onChainReceiptHash: async () => null })).toStrictEqual({ verdict: 'FAILED', checks: { ...ALL_FAIL, on_chain_hash_matches: 'skipped' } });
  });

  // The field of the receipt each check reads, and that check.
  const READ_BY: Array<[string, keyof Checks]> = [
    ['escrow_ref', 'escrow_ref_matches'], ['response_hash', 'response_hash_matches'], ['supplier_pkh', 'supplier_key_matches'],
    ['prompt_hash', 'prompt_hash_matches'], ['model', 'model_matches'],
  ];
  it.each(READ_BY)('a receipt the supplier signed without %s fails %s and nothing else', async (field, check) => {
    const j = job({ omit: [field] });
    expect(Object.keys(j.receipt)).not.toContain(field);
    expect(await verifyFleetReceipt(j.input)).toStrictEqual(onlyFails(check));
  });

  it.each(READ_BY)('a %s that is not a string fails %s and nothing else', async (field, check) => {
    for (const junk of [null, 7, true, ['x'], { v: 1 }]) {
      const j = job({ receipt: { [field]: junk } });
      expect(await verifyFleetReceipt(j.input), `${field} = ${JSON.stringify(junk)}`).toStrictEqual(onlyFails(check));
    }
  });

  it.each([['empty', ''], ['63 bytes', 'ab'.repeat(63)], ['65 bytes', 'ab'.repeat(65)], ['not hex', 'zz'.repeat(64)], ['a number', 1234], ['undefined', undefined]])('a signature that is %s fails the signature check and the on-chain row, and nothing throws', async (_what, bad) => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, receiptSignature: bad as unknown as string })).toStrictEqual(onlyFails('signature_valid', 'on_chain_hash_matches'));
  });

  it.each([['empty', ''], ['31 bytes', 'ab'.repeat(31)], ['not hex', 'zz'.repeat(32)], ['a number', 99], ['undefined', undefined]])('a public key that is %s fails the key check and the signature check, and nothing throws', async (_what, bad) => {
    const j = job();
    expect(await verifyFleetReceipt({ ...j.input, supplierPubKeyHex: bad as unknown as string })).toStrictEqual(onlyFails('supplier_key_matches', 'signature_valid'));
  });

  it('a value that is missing, or is no digest or no ref, does not match, not even the same value on both sides', async () => {
    for (const junk of ['', 'zz'.repeat(32), 'ab'.repeat(31)]) {
      const j = job({ receipt: { response_hash: junk } });
      expect(await verifyFleetReceipt({ ...j.input, responseHashHex: junk }), `response_hash ${JSON.stringify(junk)}`).toStrictEqual(onlyFails('response_hash_matches'));
    }
    for (const junk of ['', 'not a ref', 'ab'.repeat(32)]) {
      const j = job({ receipt: { escrow_ref: junk } });
      expect(await verifyFleetReceipt({ ...j.input, escrowRef: junk }), `escrow_ref ${JSON.stringify(junk)}`).toStrictEqual(onlyFails('escrow_ref_matches'));
    }
    // Both missing is not a match either: undefined is not equal to undefined here.
    const missing = undefined as unknown as string;
    const j = job({ omit: ['escrow_ref', 'response_hash', 'model'] });
    expect(await verifyFleetReceipt({ ...j.input, escrowRef: missing, responseHashHex: missing, model: missing })).toStrictEqual(onlyFails('escrow_ref_matches', 'response_hash_matches', 'model_matches'));
  });
});

describe('verifyFleetReceipt, how values are compared', () => {
  it('a hex value matches whatever its case, on either side: digests, key hashes, escrow refs and the hash on chain', async () => {
    const key = newKey();
    // The upper-case spellings are other strings, or this test would prove nothing.
    for (const hex of [ESCROW, PROMPT_HASH, RESPONSE_HASH, key.pkh, job({ key }).onChainHash]) expect(hex.toUpperCase()).not.toBe(hex);
    const upperReceipt = job({ key, receipt: { escrow_ref: ESCROW.toUpperCase(), supplier_pkh: key.pkh.toUpperCase(), prompt_hash: PROMPT_HASH.toUpperCase(), response_hash: RESPONSE_HASH.toUpperCase() } });
    expect(await verifyFleetReceipt(upperReceipt.input)).toStrictEqual({ verdict: 'VERIFIED', checks: ALL_PASS });
    const j = job({ key });
    expect(await verifyFleetReceipt({
      ...j.input, escrowRef: ESCROW.toUpperCase(), responseHashHex: RESPONSE_HASH.toUpperCase(), promptHashHex: PROMPT_HASH.toUpperCase(),
      supplierPkhExpected: key.pkh.toUpperCase(), onChainReceiptHash: async () => j.onChainHash.toUpperCase(),
    })).toStrictEqual({ verdict: 'VERIFIED', checks: ALL_PASS });
  });

  it('the hash on chain covers the signature exactly as the supplier wrote it: the same signature in another case is another string', async () => {
    const j = job();
    const upper = j.signature.toUpperCase();
    expect(upper).not.toBe(j.signature);
    // The supplier committed to the upper-case spelling: the signature verifies (hex is hex) and the hash on chain is of that spelling.
    expect(await verifyFleetReceipt({
      ...j.input, receiptSignature: upper, onChainReceiptHash: async () => sha256Utf8Hex(canonicalize({ receipt: j.receipt, signature: upper })),
    })).toStrictEqual({ verdict: 'VERIFIED', checks: ALL_PASS });
    // The hash on chain being the one of the lower-case spelling, the upper-case one is not the signed receipt it committed to.
    expect(await verifyFleetReceipt({ ...j.input, receiptSignature: upper })).toStrictEqual(onlyFails('on_chain_hash_matches'));
  });

  it('escrow refs are compared as refs: another index or another transaction is another escrow', async () => {
    const j = job();
    for (const other of [`${'ab'.repeat(32)}#1`, OTHER_ESCROW]) expect(await verifyFleetReceipt({ ...j.input, escrowRef: other }), other).toStrictEqual(onlyFails('escrow_ref_matches'));
  });

  it('the model is compared exactly: no case folding, no trimming, no prefix', async () => {
    const j = job();
    for (const wrong of [MODEL.toUpperCase(), ` ${MODEL}`, `${MODEL}\n`, MODEL.slice(0, -1)]) {
      expect(await verifyFleetReceipt({ ...j.input, model: wrong }), JSON.stringify(wrong)).toStrictEqual(onlyFails('model_matches'));
    }
  });
});
