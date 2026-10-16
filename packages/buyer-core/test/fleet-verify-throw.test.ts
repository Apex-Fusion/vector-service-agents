// packages/buyer-core/test/fleet-verify-throw.test.ts
// What verifyFleetReceipt does when the vendored verifyReceipt it calls throws, with that call replaced by one that throws on demand. The real way to make it throw
// is a receipt nested deeper than the stack allows (test/fleet-verify.test.ts); this file does not depend on the size of the stack, it holds any throw to the same
// answer, and it reaches the one branch a real call cannot: a throw while there is no hash on chain to compare. It also pins what the vendored call is handed.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted by vitest above the imports: fleet-verify.ts gets this stand-in, and it uses nothing else of the vendored module.
vi.mock('../src/vendored/mcp/marketplace-verify.ts', () => ({ verifyReceipt: vi.fn() }));
import { verifyReceipt } from '../src/vendored/mcp/marketplace-verify.ts';
import type { ReceiptVerdict } from '../src/vendored/mcp/marketplace-verify.ts';
import { verifyFleetReceipt } from '../src/fleet-verify.ts';
import type { FleetVerifyInput } from '../src/fleet-verify.ts';

const ESCROW = `${'ab'.repeat(32)}#0`;
const HASH_ON_CHAIN = 'aa'.repeat(32);
/** An input whose three rows made in fleet-verify.ts itself (escrow ref, response hash, model) pass; the rows of the vendored call are whatever the stand-in says. */
const input = (over: Partial<FleetVerifyInput> = {}): FleetVerifyInput => ({
  escrowRef: ESCROW,
  receipt: { escrow_ref: ESCROW, supplier_pkh: 'cd'.repeat(28), prompt_hash: 'ef'.repeat(32), response_hash: '12'.repeat(32), model: 'm-v1', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 1 },
  receiptSignature: 'ab'.repeat(64), responseHashHex: '12'.repeat(32), promptHashHex: 'ef'.repeat(32),
  supplierPubKeyHex: 'ab'.repeat(32), supplierPkhExpected: 'cd'.repeat(28), model: 'm-v1',
  onChainReceiptHash: async () => HASH_ON_CHAIN, ...over,
});

const ok = { state: 'pass', note: '' } as const;
const verdictOf = (onChain: ReceiptVerdict['checks']['on_chain_hash_matches']): ReceiptVerdict => ({
  verdict: 'verified',
  checks: { escrow_ref_matches: ok, response_hash_matches: { state: 'skipped', note: 'no report text given' }, supplier_key_matches: ok, signature_valid: ok, on_chain_hash_matches: onChain, prompt_hash_matches: ok },
});
const throwing = (thrown: unknown) => vi.mocked(verifyReceipt).mockImplementation(() => { throw thrown; });

const MADE_HERE = { escrow_ref_matches: 'pass', response_hash_matches: 'pass', model_matches: 'pass' } as const;
const VENDORED_FAIL = { supplier_key_matches: 'fail', signature_valid: 'fail', prompt_hash_matches: 'fail' } as const;

describe('verifyFleetReceipt, when the vendored verifier throws', () => {
  beforeEach(() => { vi.mocked(verifyReceipt).mockReset(); });

  it.each([
    ['a RangeError', new RangeError('Maximum call stack size exceeded')],
    ['a TypeError', new TypeError('x.toLowerCase is not a function')],
    ['a string', 'boom'],
    ['undefined', undefined],
  ])('%s is FAILED and not a rejection: the four rows the vendored call owns fail, the three made here are still made', async (_what, thrown) => {
    throwing(thrown);
    expect(await verifyFleetReceipt(input())).toStrictEqual({ verdict: 'FAILED', checks: { ...MADE_HERE, ...VENDORED_FAIL, on_chain_hash_matches: 'fail' } });
  });

  it('with no hash on chain to compare, the on-chain row is skipped and not failed, and the verdict is FAILED all the same', async () => {
    throwing(new RangeError('Maximum call stack size exceeded'));
    expect(await verifyFleetReceipt(input({ onChainReceiptHash: async () => null }))).toStrictEqual({ verdict: 'FAILED', checks: { ...MADE_HERE, ...VENDORED_FAIL, on_chain_hash_matches: 'skipped' } });
  });

  it('the read comes first and is not caught: its error is the rejection, and the vendored call is not made', async () => {
    throwing(new RangeError('Maximum call stack size exceeded'));
    const boom = new Error('the indexer is behind');
    await expect(verifyFleetReceipt(input({ onChainReceiptHash: async () => { throw boom; } }))).rejects.toBe(boom);
    expect(verifyReceipt).not.toHaveBeenCalled();
  });
});

describe('verifyFleetReceipt, what the vendored verifier is handed', () => {
  beforeEach(() => { vi.mocked(verifyReceipt).mockReset(); });

  it('the input as it is, the hash on chain as the read gave it, and no result text (the response hash is checked here, against the recomputed one)', async () => {
    vi.mocked(verifyReceipt).mockReturnValue(verdictOf(ok));
    const i = input();
    expect(await verifyFleetReceipt(i)).toStrictEqual({
      verdict: 'VERIFIED',
      checks: { ...MADE_HERE, supplier_key_matches: 'pass', signature_valid: 'pass', on_chain_hash_matches: 'pass', prompt_hash_matches: 'pass' },
    });
    expect(verifyReceipt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(verifyReceipt).mock.calls[0][0]).toStrictEqual({
      receipt: i.receipt, signature: i.receiptSignature, escrowRef: i.escrowRef, supplierPubKeyHex: i.supplierPubKeyHex,
      escrowSupplierPkh: i.supplierPkhExpected, escrowPromptHash: i.promptHashHex, resultReceiptHashOnChain: HASH_ON_CHAIN,
    });
  });

  it('no hash when the read broke its contract, and the on-chain row fails whatever the vendored call says of it', async () => {
    vi.mocked(verifyReceipt).mockReturnValue(verdictOf({ state: 'skipped', note: 'Submitted output not locatable' }));
    const v = await verifyFleetReceipt(input({ onChainReceiptHash: async () => 42 as unknown as string }));
    expect(v).toStrictEqual({ verdict: 'FAILED', checks: { ...MADE_HERE, supplier_key_matches: 'pass', signature_valid: 'pass', on_chain_hash_matches: 'fail', prompt_hash_matches: 'pass' } });
    expect(vi.mocked(verifyReceipt).mock.calls[0][0].resultReceiptHashOnChain).toBeNull();
  });
});
