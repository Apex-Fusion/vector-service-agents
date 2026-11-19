// The port of the vault checks over the hire kit, against the in-memory marketplace of the kit (a FakeChain with a vault, a template supplier behind one fetch): what each outcome of
// `hireAgent` is for the check (a result, or a `HireFailed` that holds the escrow and the vault that continues), the error of the kit after a confirmed Pay, a dry stop, the Pay of check 3
// with no job, and the Reclaim of the janitor. Each refusal has its accepted twin.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JANITOR_GRACE_MS } from '../../../packages/hire-kit/src/index.ts';
import { AGENT_ADVERT, AGENT_ADVERT_REF, AGENT_ANSWER, marketplace, vaultChainWith } from '../../../packages/hire-kit/testing/index.ts';
import type { Marketplace } from '../../../packages/hire-kit/testing/index.ts';
import { createHirePort } from '../lib/hire-adapter.ts';
import { DryStop, HireFailed } from '../lib/hire-types.ts';
import type { HireLimits, HirePort, VaultHireRequest } from '../lib/hire-types.ts';
import { TxNotConfirmedError } from '../lib/platform.ts';
import type { VaultChain } from '../lib/platform.ts';
import { MemoryOutput } from './support/fakes.ts';

const PAYLOAD = '{"purchase_order":"PO-7","lines":[{"sku":"A-1","quantity":12}]}';
const DELEGATION = 'dd'.repeat(32);
const LIMIT = { perTx: 5_000_000n, total: 12_000_000n, periodMs: 86_400_000 };
const NO_LIMITS: HireLimits = { maxPriceLovelace: null, maxSupplierBondLovelace: null, maxBuyerBondLovelace: null };

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

interface Setup { m: Marketplace; port: HirePort; stateDir: string; out: MemoryOutput; evidence: unknown[]; vault: string }
/** A marketplace with a vault that the delegate key pays from, and a port over the chain that `chain` makes of it (the FakeChain itself by default). */
function setup(over: { chain?: (m: Marketplace) => VaultChain; limit?: typeof LIMIT; market?: Parameters<typeof marketplace>[0] } = {}): Setup {
  const m = marketplace(over.market);
  const stateDir = mkdtempSync(join(tmpdir(), 'checks-port-'));
  dirs.push(stateDir);
  const out = new MemoryOutput();
  const evidence: unknown[] = [];
  const host = {
    clock: { now: () => m.clock.now, sleep: async (ms: number) => { m.clock.now += ms; } }, fetchImpl: m.fetchImpl, out, evidence: { add: (entry: unknown) => { evidence.push(entry); } },
  };
  const vault = m.chain.openVault({ delegation: DELEGATION, lovelace: 40_000_000n, limit: over.limit ?? LIMIT });
  return { m, port: createHirePort(host, over.chain === undefined ? m.chain : over.chain(m), { stateDir }), stateDir, out, evidence, vault };
}
const hireRequest = (s: Setup, over: Partial<VaultHireRequest> = {}): VaultHireRequest => ({ advertRef: AGENT_ADVERT_REF, payload: PAYLOAD, vaultRef: s.vault, ...NO_LIMITS, ...over });
const failure = async (call: Promise<unknown>): Promise<HireFailed> => {
  const error = await call.then(() => { throw new Error('the call did not fail'); }, (err: unknown) => err);
  if (!(error instanceof HireFailed)) throw error;
  return error;
};

describe('hire', () => {
  it('pays from the vault, sends the job, accepts, and gives the escrow, the vault that continues, the two transactions and the text', async () => {
    const s = setup();
    const done = await s.port.hire(hireRequest(s));
    expect(done.text).toBe(AGENT_ANSWER);
    expect(done.payTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.acceptTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(done.lockLovelace).toBeGreaterThan(0n);
    expect(done.returnedRef).toBeNull();
    expect(s.m.chain.vault(s.vault)).toMatchObject({ consumed: true });
    expect(s.m.chain.vault(done.vaultRef)).toMatchObject({ kind: 'Live', consumed: false, delegation: DELEGATION });
    expect(await s.m.chain.escrowState(done.escrowRef)).toBe('spent');
  });

  it('says refused_before_claim for the agent that turns the job down, with the escrow and the vault that continues; the escrow stays Open', async () => {
    const s = setup();
    s.m.agent.refuse = { status: 403, code: 'approval_revoked', message: 'The approval was revoked.' };
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('refused_before_claim');
    expect(error.message).toContain('approval_revoked');
    expect(error.after).toMatchObject({ vaultRef: expect.stringMatching(/#/), deliverBy: expect.any(Number), lockLovelace: expect.any(BigInt) });
    expect(await s.m.chain.escrowState(error.after!.escrowRef)).toBe('Open');
    expect(s.m.chain.vault(error.after!.vaultRef!)).toMatchObject({ kind: 'Live', consumed: false });
    // The twin: an agent that does not refuse completes.
    expect(await setup().port.hire(hireRequest(setup()))).toBeDefined();
  });

  it('says failed_after_claim, with the reason, for an agent that fails after its Claim', async () => {
    const s = setup();
    s.m.agent.steps = ['failed'];
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('failed_after_claim');
    expect(error.message).toContain('(failed)');
    expect(error.after!.escrowRef).toMatch(/#0$/);
  });

  it('says failed_after_claim for a send that was lost: the agent may hold the job', async () => {
    const s = setup();
    s.m.agent.lose = ['after-claim'];
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('failed_after_claim');
    expect(error.message).toContain('(send_lost)');
  });

  it('says not_accepted when the receipt fails a check', async () => {
    const s = setup();
    s.m.agent.forge = true;
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('not_accepted');
    expect(error.after).not.toBeNull();
  });

  it('does not call a hire complete while its Accept is not seen confirmed: it is a failure that holds the escrow and the vault, and the message says to run the step again', async () => {
    const s = setup({
      chain: (m) => vaultChainWith(m, {
        accept: async (ref) => {
          const done = await m.chain.accept(ref);
          throw new TxNotConfirmedError('the Accept was sent and not seen confirmed', { txHash: done.txHash, escrowRef: ref, deliverBy: null, validTo: m.clock.now + 60_000, mayLand: true });
        },
      }),
    });
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('other');
    expect(error.message).toContain('not yet seen confirmed');
    expect(error.after).toMatchObject({ escrowRef: expect.stringMatching(/#0$/), vaultRef: expect.stringMatching(/#/) });
  });

  it('says vault_refused for a Pay above the limit of the delegation, keeps the words of the node and the draft in the evidence, and holds no Pay; the twin with a higher limit completes', async () => {
    const s = setup({ limit: { ...LIMIT, perTx: 1_000_000n } });
    const error = await failure(s.port.hire(hireRequest(s)));
    expect(error.kind).toBe('vault_refused');
    expect(error.after).toBeNull();
    expect(s.evidence).toHaveLength(1);
    expect(s.evidence[0]).toMatchObject({ step: 'hire', status: 'refused', expected: false, tx_hash: null, evaluation_error: expect.any(String), transaction_body: expect.stringMatching(/^[0-9a-f]+$/) });
    expect(s.m.chain.vault(s.vault)).toMatchObject({ kind: 'Live', consumed: false });
    const twin = setup();
    expect((await twin.port.hire(hireRequest(twin))).text).toBe(AGENT_ANSWER);
  });

  it('refuses an advert above a limit before anything is paid, in the words of the port; at the limit the hire completes', async () => {
    const s = setup();
    const error = await failure(s.port.hire(hireRequest(s, { maxPriceLovelace: 1n })));
    expect(error.kind).toBe('other');
    expect(error.message).toContain('above the limit of 1 lovelace');
    expect(error.after).toBeNull();
    expect(s.m.chain.vault(s.vault)).toMatchObject({ consumed: false });
    const twin = setup();
    expect((await twin.port.hire(hireRequest(twin, { maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 10_000_000n, maxBuyerBondLovelace: 10_000_000n }))).text).toBe(AGENT_ANSWER);
  });

  it('refuses an advert that is not Active before a hire or a Pay, in the words of the port; the Active advert is paid', async () => {
    const retired = setup({ market: { agentAdvert: { ...AGENT_ADVERT, status: 'Retired' } } });
    expect((await failure(retired.port.hire(hireRequest(retired)))).message).toContain('is Retired on chain, not Active');
    expect((await failure(retired.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: retired.vault, ...NO_LIMITS }))).message).toContain('is Retired on chain, not Active');
    expect(retired.m.chain.vault(retired.vault)).toMatchObject({ consumed: false });
    const active = setup();
    expect((await active.port.hire(hireRequest(active))).text).toBe(AGENT_ANSWER);
  });

  it.skipIf(process.getuid?.() === 0)('gives the vault that continues when the kit throws after a confirmed Pay (the stranded store cannot be written), as a failure that holds the escrow and the vault', async () => {
    const s = setup();
    const keyDir = join(s.stateDir, 'hire', 'keys', (await s.m.chain.wallet()).buyerPkh);
    mkdirSync(keyDir, { recursive: true });
    chmodSync(keyDir, 0o500);
    try {
      const error = await failure(s.port.hire(hireRequest(s)));
      expect(error.kind).toBe('other');
      expect(error.after).toMatchObject({ escrowRef: expect.stringMatching(/#0$/), vaultRef: expect.stringMatching(/#/) });
      expect(s.m.chain.vault(error.after!.vaultRef!)).toMatchObject({ kind: 'Live', consumed: false });
      expect(s.m.chain.vault(s.vault)).toMatchObject({ consumed: true });
    } finally {
      chmodSync(keyDir, 0o700);
    }
  });

  it('ends in a dry stop when the chain does: the stop is not a failure, and the vault is as it was', async () => {
    const s = setup({ chain: (m) => vaultChainWith(m, { payFromVault: async () => { throw new DryStop('hire:pay'); } }) });
    const error = await s.port.hire(hireRequest(s)).then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(DryStop);
    expect(s.m.chain.vault(s.vault)).toMatchObject({ consumed: false });
  });
});

describe('pay and reclaim', () => {
  const returnedAware = (m: Marketplace): VaultChain => vaultChainWith(m, {
    reclaim: async (ref) => {
      const done = await m.chain.reclaim(ref);
      const returned = m.chain.vaults().find((view) => view.kind === 'Returned' && !view.consumed);
      return { ...done, returnedRef: returned?.ref ?? null };
    },
  });
  /** The escrows that the stranded store of the paying key holds, read from its file. */
  const strandedOf = (s: Setup): Array<{ escrow_ref: string; kind: string }> => {
    const keys = join(s.stateDir, 'hire', 'keys');
    if (!existsSync(keys)) return [];
    return readdirSync(keys).flatMap((dir) => {
      const file = join(keys, dir, 'stranded.json');
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Array<{ escrow_ref: string; kind: string }>) : [];
    });
  };

  it('pays the advert from the vault and sends no job: the escrow is Open, recorded for the janitor, and the vault continues', async () => {
    const s = setup();
    const paid = await s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS });
    expect(paid.lockLovelace).toBeGreaterThan(0n);
    expect(await s.m.chain.escrowState(paid.escrowRef)).toBe('Open');
    expect(s.m.agent.sends).toEqual([]);
    expect(s.m.chain.vault(paid.vaultRef)).toMatchObject({ kind: 'Live', consumed: false });
    expect(strandedOf(s).map((entry) => [entry.escrow_ref, entry.kind])).toEqual([[paid.escrowRef, 'agent']]);
  });

  it('refuses an advert above a limit of the price or of a bond before the Pay, in the words of the kit; at the limits it pays', async () => {
    const s = setup();
    expect((await failure(s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS, maxPriceLovelace: 1n }))).message).toContain('above the limit');
    expect((await failure(s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS, maxSupplierBondLovelace: 1n }))).message).toContain('supplier bond');
    expect((await failure(s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS, maxBuyerBondLovelace: 1n }))).message).toContain('buyer bond');
    expect(s.m.chain.vault(s.vault)).toMatchObject({ consumed: false });
    const twin = setup();
    expect(await twin.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: twin.vault, maxPriceLovelace: 10_000_000n, maxSupplierBondLovelace: 10_000_000n, maxBuyerBondLovelace: 10_000_000n })).toMatchObject({ escrowRef: expect.stringMatching(/#0$/) });
  });

  it('waits for the deliver_by of the escrow, and then the janitor reclaims it to the vault and the port gives the Returned output', async () => {
    const s = setup({ chain: returnedAware });
    const paid = await s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS });
    const early = await failure(s.port.reclaim({ escrowRef: paid.escrowRef, deliverBy: paid.deliverBy }));
    expect(early.message).toContain('waiting');
    s.m.clock.now = paid.deliverBy + JANITOR_GRACE_MS + 1;
    const done = await s.port.reclaim({ escrowRef: paid.escrowRef, deliverBy: paid.deliverBy });
    expect(done.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.m.chain.vault(done.returnedRef)).toMatchObject({ kind: 'Returned', consumed: false, lovelace: paid.lockLovelace });
    expect(await s.m.chain.escrowState(paid.escrowRef)).toBe('spent');
    expect(strandedOf(s)).toEqual([]);
  });

  it('reclaims an escrow that the store does not hold, from what the state file knows of it', async () => {
    const s = setup({ chain: returnedAware });
    const paid = await s.m.chain.payFromVault({ vaultRef: s.vault, advertRef: AGENT_ADVERT_REF, payload: PAYLOAD });
    s.m.clock.now = paid.deliverBy + JANITOR_GRACE_MS + 1;
    const done = await s.port.reclaim({ escrowRef: paid.escrowRef, deliverBy: paid.deliverBy });
    expect(s.m.chain.vault(done.returnedRef)).toMatchObject({ kind: 'Returned' });
  });

  it('says that the janitor did not reclaim when the chain shows no Returned output, and ends in a dry stop when the Reclaim does', async () => {
    const s = setup();
    const paid = await s.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: s.vault, ...NO_LIMITS });
    s.m.clock.now = paid.deliverBy + JANITOR_GRACE_MS + 1;
    expect((await failure(s.port.reclaim({ escrowRef: paid.escrowRef, deliverBy: paid.deliverBy }))).message).toContain('did not reclaim');
    const dry = setup({ chain: (m) => vaultChainWith(m, { reclaim: async () => { throw new DryStop('reclaim'); } }) });
    const due = await dry.port.pay({ advertRef: AGENT_ADVERT_REF, vaultRef: dry.vault, ...NO_LIMITS });
    dry.m.clock.now = due.deliverBy + JANITOR_GRACE_MS + 1;
    const stop = await dry.port.reclaim({ escrowRef: due.escrowRef, deliverBy: due.deliverBy }).then(() => null, (err: unknown) => err);
    expect(stop).toBeInstanceOf(DryStop);
  });
});
