// The vault checks end to end over the real parts: the real hire kit (`hireAgent`, the paying key, the stranded store and the janitor), the guarded chain with its guards, the vendored
// builders on the real applied scripts of the fixtures, and the steps of the checks. Only the outside is a fake: the supplier (it serves its capability and turns a job down, as a
// runtime does before its Claim), Koios (it describes the outputs of the world at the time of each call), and the hosted tools. Covered: a dry run of the hire and of the Pay shows the
// transaction and signs nothing; the checks of the kit before a Pay hold; a hire that the agent refuses leaves an escrow that the cleanup reclaims to the vault, and the vault and the
// delegation end; check 3 pays, waits, reclaims and closes. Each refusal has its accepted twin.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LISTED } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { ADVERT_REF, IDENTITY_ADVERT, advertUtxo, chainFake } from '../../../packages/buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { RECLAIM_AFTER_MS, vaultCheck } from '../lib/check-vault.ts';
import type { VaultKind, VaultSettings } from '../lib/check-vault.ts';
import { vaultPort } from '../lib/hire-adapter.ts';
import { decodeVaultDatum } from '../lib/platform.ts';
import { iso } from '../lib/format.ts';
import type { CheckDefinition } from '../lib/runner.ts';
import { harness } from './support/harness.ts';
import type { Harness } from './support/harness.ts';
import { vaultHostedFor } from './support/vault-world.ts';
import { DEPLOYMENT, NOW, World } from './support/world.ts';
/** The advert of the fixtures, served from an address that is no host name: the fetch of the kit to a supplier refuses a name that it cannot look up, and a test has no network. */
const SUPPLIER = 'https://203.0.113.41';
const ADVERT = { ...IDENTITY_ADVERT, endpoint_url: SUPPLIER };

afterEach(() => { vi.useRealTimers(); });

const KOIOS = 'https://koios.test.example/';
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Supplier {
  /** Fields that replace those of the capability answer: a key that is not the key of the advert, for one. */
  capability?: Record<string, unknown>;
  /** The answer to a job that is sent: a refusal of the runtime before its Claim, or nothing (the connection drops). */
  refuse?: { status: number; code: string };
}

/** The supplier of the advert of the fixtures: it serves its capability, and answers a job as `over` says. Any other call ends the test. */
function supplierFetch(over: Supplier = {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== SUPPLIER) throw new Error(`the network was touched: ${url.href}`);
    if (url.pathname === '/capability') {
      return json(200, { capability_id: IDENTITY_ADVERT.capability_id, model: IDENTITY_ADVERT.model, advert_ref: ADVERT_REF, supplier_pkh: LISTED.keyHash, pub_key_hex: LISTED.publicKey, ...over.capability });
    }
    if (url.pathname === '/v1/job' && init?.method === 'POST' && over.refuse !== undefined) return json(over.refuse.status, { error: over.refuse.code, message: `the service refused the job (${over.refuse.code})`, reason: over.refuse.code });
    throw new Error(`the supplier has no answer for ${init?.method ?? 'GET'} ${url.href}`);
  }) as typeof fetch;
}

/** Koios as it describes the world now: the advert, and every output at the escrow script that the world holds. It is made again for each call, because the world moves. */
function koiosOf(world: World): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => chainFake({ live: [advertUtxo(ADVERT), ...world.chain.held.filter((u) => u.address === DEPLOYMENT.escrow.address)] }).f(input, init)) as typeof fetch;
}

async function started(kind: VaultKind, over: { supplier?: Supplier; env?: Record<string, string> } = {}) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  const name = kind === 'escrow' ? 'vault-escrow' : 'vault-refund';
  const world = await World.identity({ advert: ADVERT });
  let h: Harness | null = null;
  const hosted = vaultHostedFor(() => h!, name);
  h = await harness({ world, hosted, env: { CHECKS_ADVERT_REF: ADVERT_REF, CHECKS_HIRE_PAYLOAD: '{"subject":"the test record"}', ...over.env }, fetchImpl: supplierFetch(over.supplier), chainFetch: koiosOf(world), koiosUrl: KOIOS });
  const check: CheckDefinition<VaultSettings> = vaultCheck(kind, vaultPort);
  return { h, check, name, world };
}

/** Runs the first steps of a check with --submit: the delegation and the vault. */
async function openVault(t: Awaited<ReturnType<typeof started>>): Promise<void> {
  for (let i = 0; i < 2; i++) expect(await t.h.run(t.check, '--submit'), `run ${i + 1}`).toBe(0);
}

/** Moves the clock of the check, the time of the builders and the tip of the node to `at`. */
function moveTo(t: Awaited<ReturnType<typeof started>>, at: number): void {
  t.h.clock.t = at;
  vi.setSystemTime(at);
  t.world.chain.tipSlot = Math.floor((at - 1_756_485_600_000) / 1000);
}

const vaultOutputs = (t: Awaited<ReturnType<typeof started>>) => t.world.chain.held.filter((u) => u.address === DEPLOYMENT.vault.address);
const escrowOutputs = (t: Awaited<ReturnType<typeof started>>) => t.world.chain.held.filter((u) => u.address === DEPLOYMENT.escrow.address);

describe('the dry run of the hire and of the Pay, over the real kit and the real guards', () => {
  it('check 2: the hire is chosen, the Pay is built from the vault and checked, the summary is shown, and nothing is signed or recorded', async () => {
    const t = await started('escrow');
    await openVault(t);
    const submitted = t.h.node.submitted.length;
    expect(await t.h.run(t.check)).toBe(0);
    expect(t.h.screen.text).toContain('the kit would hire the advert');
    expect(t.h.screen.text).toMatch(/ok +vault\b/);
    expect(t.h.screen.text).toContain('nothing is signed');
    expect(t.h.node.submitted).toHaveLength(submitted);
    expect(vaultOutputs(t)).toHaveLength(1);
    expect(t.h.state(t.name).steps.hire).toBeUndefined();
    expect(Object.keys(t.h.state(t.name).notes).filter((key) => key.startsWith('part.'))).toEqual([]);
  }, 120_000);

  it('check 3: the Pay is built, checked and shown, and nothing is signed', async () => {
    const t = await started('refund');
    await openVault(t);
    const submitted = t.h.node.submitted.length;
    expect(await t.h.run(t.check)).toBe(0);
    expect(t.h.screen.text).toContain('the kit would pay the advert');
    expect(t.h.screen.text).toMatch(/ok +vault\b/);
    expect(t.h.node.submitted).toHaveLength(submitted);
    expect(t.h.state(t.name).steps.pay).toBeUndefined();
  }, 120_000);

  it('stops before a Pay when the agent serves a key that is not the key of its advert, in the words of the kit; the twin with the right key shows the Pay', async () => {
    const t = await started('escrow', { supplier: { capability: { pub_key_hex: '11'.repeat(32), supplier_pkh: '22'.repeat(28) } } });
    await openVault(t);
    expect(await t.h.run(t.check)).toBe(1);
    expect(t.h.screen.errorText).toMatch(/serves another|not the key of its advert/);
    expect(t.h.screen.text).not.toContain('ok  vault');
  }, 120_000);

  it('stops before a Pay when the price of the advert is above the limit of the settings, and names the limit', async () => {
    const t = await started('escrow', { env: { CHECKS_MAX_PRICE_UNITS: '1' } });
    await openVault(t);
    expect(await t.h.run(t.check)).toBe(1);
    expect(t.h.screen.errorText).toContain('above the limit of 1000000 lovelace');
    expect(vaultOutputs(t)).toHaveLength(1);
  }, 120_000);
});

describe('check 2 when the agent refuses the job after the Pay', () => {
  it('pays from the vault, keeps the escrow and the vault that continues, never hires again, and the cleanup reclaims after deliver_by, closes both outputs and ends the delegation', async () => {
    const t = await started('escrow', { supplier: { refuse: { status: 403, code: 'approval_revoked' } } });
    await openVault(t);
    expect(await t.h.run(t.check, '--submit')).toBe(1);
    expect(t.h.screen.errorText).toContain('approval_revoked');
    const part = t.h.state(t.name).notes['part.hire:pay'] as { refs: Record<string, string>; facts: Record<string, unknown> };
    expect(part.refs.escrow_ref).toMatch(/#0$/);
    expect(part.refs.vault_ref).toMatch(/#1$/);
    expect(t.h.state(t.name).notes.after_pay).toMatchObject({ escrow_ref: part.refs.escrow_ref, vault_ref: part.refs.vault_ref, kind: 'refused_before_claim' });
    expect(t.h.state(t.name).steps.hire).toBeUndefined();
    expect(escrowOutputs(t)).toHaveLength(1);
    expect(vaultOutputs(t).map((u) => `${u.txHash}#${u.outputIndex}`)).toEqual([part.refs.vault_ref]);
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain(`next: cleanup, after ${iso(Number(part.facts.deliver_by) + RECLAIM_AFTER_MS)}`);
    expect(t.h.screen.text).not.toContain('next: hire');
    // The check never hires again: the kit is not called, and the escrow is the only thing to take back.
    t.h.screen.lines.length = 0;
    t.h.screen.errors.length = 0;
    expect(await t.h.run(t.check, '--submit')).toBe(2);
    expect(t.h.screen.errorText).toContain('never hire again');
    expect(escrowOutputs(t)).toHaveLength(1);
    // Before deliver_by the cleanup says how long it waits and signs nothing.
    const before = t.h.node.submitted.length;
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(4);
    expect(t.h.node.submitted).toHaveLength(before);
    moveTo(t, Number(part.facts.deliver_by) + 61_000);
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(0);
    const steps = t.h.state(t.name).steps;
    expect(Object.keys(steps)).toEqual(['delegate', 'vault_open', 'reclaim', 'vault_close', 'undelegate']);
    expect(steps.vault_close!.facts.closed).toEqual([part.refs.vault_ref, steps.reclaim!.refs.returned_ref]);
    expect(Object.values(steps).every((step) => step.verified_at !== null)).toBe(true);
    expect(vaultOutputs(t)).toEqual([]);
    expect(escrowOutputs(t)).toEqual([]);
    expect(t.h.state(t.name).notes.cleaned_up).toBeDefined();
    t.h.screen.lines.length = 0;
    expect(await t.h.run(t.check, 'status')).toBe(0);
    expect(t.h.screen.text).toContain('next: nothing');
  }, 240_000);
});

describe('check 3 over the real kit and the real chain', () => {
  it('pays from the vault with no job, waits for deliver_by, reclaims through the janitor to the vault as a Returned output, closes the Live and the Returned output together, and ends the delegation', async () => {
    const t = await started('refund');
    await openVault(t);
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    const paid = t.h.state(t.name).steps.pay!;
    expect(paid.refs.escrow_ref).toMatch(/#0$/);
    expect(escrowOutputs(t)).toHaveLength(1);
    expect(await t.h.run(t.check, '--submit')).toBe(4);
    moveTo(t, Number(paid.facts.deliver_by) + 61_000);
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    const returned = t.h.state(t.name).steps.reclaim!.refs.returned_ref!;
    const returnedOutput = t.world.chain.held.find((u) => `${u.txHash}#${u.outputIndex}` === returned)!;
    expect(decodeVaultDatum(returnedOutput.datum!).type).toBe('Returned');
    expect(BigInt(String(paid.facts.lock_lovelace))).toBeLessThanOrEqual(returnedOutput.assets.lovelace!);
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(t.h.state(t.name).steps.vault_close!.facts.closed).toEqual([paid.refs.vault_ref, returned]);
    expect(await t.h.run(t.check, '--submit')).toBe(0);
    expect(vaultOutputs(t)).toEqual([]);
    expect(escrowOutputs(t)).toEqual([]);
    expect(Object.values(t.h.state(t.name).steps).every((step) => step.verified_at !== null)).toBe(true);
    expect(Object.keys(t.h.state(t.name).steps)).toEqual(['delegate', 'vault_open', 'pay', 'reclaim', 'vault_close', 'undelegate']);
  }, 360_000);
});

describe('check 2 when the Pay is sent and not seen confirmed, over the real kit', () => {
  interface InFlight { step: string; tx_hash: string; signed_cbor: string; valid_to: number; refs: Record<string, string> }
  const unseen = (t: Awaited<ReturnType<typeof started>>) => { t.h.node.submit = async (cbor) => t.world.hashOf(cbor); };
  const flightOf = (t: Awaited<ReturnType<typeof started>>) => t.h.state(t.name).in_flight as unknown as InFlight;

  it('keeps the transaction in flight with the vault that it would leave and the old vault, waits for it, and when it cannot land the hire is made again from the old vault', async () => {
    const t = await started('escrow', { supplier: { refuse: { status: 403, code: 'approval_revoked' } } });
    await openVault(t);
    const sent = t.h.node.submit.bind(t.h.node);
    unseen(t);
    const old = vaultOutputs(t)[0]!;
    expect(await t.h.run(t.check, '--submit')).toBe(1);
    expect(t.h.screen.errorText).toContain('may still land until');
    const flight = flightOf(t);
    expect(flight).toMatchObject({ step: 'hire:pay', refs: { vault_ref: `${flight.tx_hash}#1` } });
    expect(t.h.state(t.name).notes.unconfirmed_pay).toMatchObject({ old_vault_ref: `${old.txHash}#${old.outputIndex}`, vault_ref_if_landed: `${flight.tx_hash}#1`, valid_to: flight.valid_to });
    expect(t.h.state(t.name).notes.after_pay).toBeUndefined();
    // While it may land, the next run waits for it and starts no other Pay.
    expect(await t.h.run(t.check, '--submit')).toBe(4);
    expect(escrowOutputs(t)).toEqual([]);
    // After its validity it cannot land: the run lets it go, reads the old vault from the chain, and pays again.
    moveTo(t, flight.valid_to + 61_000);
    t.h.node.submit = sent;
    expect(await t.h.run(t.check, '--submit')).toBe(1);
    expect(t.h.screen.errorText).toContain('approval_revoked');
    expect(t.h.state(t.name).notes['part.hire:pay']).toBeDefined();
    expect(escrowOutputs(t)).toHaveLength(1);
  }, 240_000);

  it('records the Pay when it lands after all, never hires again, and the cleanup goes on from the vault that the Pay left', async () => {
    const t = await started('escrow', { supplier: { refuse: { status: 403, code: 'approval_revoked' } } });
    await openVault(t);
    const sent = t.h.node.submit.bind(t.h.node);
    unseen(t);
    expect(await t.h.run(t.check, '--submit')).toBe(1);
    const flight = flightOf(t);
    t.world.chain.apply(flight.signed_cbor);
    t.h.node.submit = sent;
    expect(escrowOutputs(t)).toHaveLength(1);
    // The run settles the transaction first: it is confirmed, so it is recorded as a part, and the hire is not made again.
    t.h.screen.errors.length = 0;
    expect(await t.h.run(t.check, '--submit')).toBe(2);
    expect(t.h.screen.text).toContain('is confirmed: the step is recorded');
    expect(t.h.state(t.name).notes['part.hire:pay']).toMatchObject({ refs: { vault_ref: `${flight.tx_hash}#1` } });
    expect(t.h.screen.errorText).toContain('never hire again');
    const part = t.h.state(t.name).notes['part.hire:pay'] as { facts: Record<string, unknown> };
    moveTo(t, Number(part.facts.deliver_by) + 61_000);
    expect(await t.h.run(t.check, 'cleanup', '--submit')).toBe(0);
    expect(vaultOutputs(t)).toEqual([]);
    expect(escrowOutputs(t)).toEqual([]);
    expect(t.h.state(t.name).steps.vault_close!.facts.closed).toEqual([`${flight.tx_hash}#1`, t.h.state(t.name).steps.reclaim!.refs.returned_ref]);
  }, 240_000);
});
