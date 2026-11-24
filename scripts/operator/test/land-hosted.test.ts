// The hosted build and the landing of a built transaction, over a world with the real builders. Each refusal has an accepted twin. No test uses a real key, a real clock or the network.
// The tool names in the landing tests are labels: the fake tool builds the transaction that its test needs (a payment, or a delegation with two signers) and answers in the live format.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { GuardRefusal, LandRefused, NetworkGate } from '../../checks/lib/land.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
import type { StepPlan } from '../../checks/lib/guards.ts';
import { VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import { StateError, StateFile } from '../../checks/lib/state.ts';
import { SYSTEM_START_MS } from '../../checks/test/support/chain-view.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { AGENT_N, CONTROLLER_N, DEPLOYMENT, MEMBER_N, NOW, RECORD_ID, keyOf, seedHex } from '../../checks/test/support/world.ts';
import { ApprovalError, Exposure, lovelaceOfUnits } from '../lib/approval.ts';
import type { GoFile } from '../lib/approval.ts';
import type { BuiltLandSpec, HostedLandSpec, LandHost, OperatorSettings } from '../lib/contract.ts';
import { ToolRefused, hostedBuild, landBuilt, landHosted } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import type { PlanOver } from '../lib/plan.ts';
import { TxNotConfirmedError, buildDelegate, ensureSlotConfig, lucidForAddress } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { FakeClock, FakeNode, MemoryOutput, ThrowingSigner, World } from './support/fakes.ts';
import { makeKeyRoot, removeTestKeys, writeSeed } from './support/keys.ts';
import type { Handler, HandlerAnswer, LiveBuild } from './support/pack-hosted.ts';
import { PACK_CAPTURE, PACK_SCHEMAS, PackHosted, liveBuildAnswer } from './support/pack-hosted.ts';

const PACK_TOOLS = [
  'vector_build_identity_register', 'vector_build_identity_update', 'vector_build_reputation_stake_open', 'vector_build_reputation_stake', 'vector_get_reputation_stake',
  'vector_build_marketplace_advert_post', 'vector_build_marketplace_advert_retire', 'vector_build_identity_suspend', 'vector_build_identity_unsuspend', 'vector_resolve_did',
  'vector_marketplace_list_suppliers', 'vector_get_attestation', 'vector_check_attestation', 'vector_get_delegation', 'vector_get_vault', 'vector_get_jury_cases',
];

describe('the captured schemas and PackHosted', () => {
  it('hold the 16 tools that the pack calls, and the date and the server of the capture', () => {
    expect(Object.keys(PACK_SCHEMAS).sort()).toEqual([...PACK_TOOLS].sort());
    expect(PACK_CAPTURE.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PACK_CAPTURE.server.trim()).not.toBe('');
    expect(PACK_CAPTURE.tools_listed).toBeGreaterThanOrEqual(PACK_TOOLS.length);
    expect(Object.keys(PACK_SCHEMAS)).not.toContain('vector_build_transaction');
  });
  const REGISTER = { changeAddress: 'addr1test', controller: 'ab'.repeat(32), name: 'a test agent', parties: [{ role: 'Accountable', signer: 'controller' }] };
  const fake = () => new PackHosted({ vector_build_identity_register: () => ({ ok: true }) });
  it('refuses a stray argument before the handler runs, and takes the call without it', async () => {
    const hosted = fake();
    const err = await hosted.call('vector_build_identity_register', { ...REGISTER, extra: 1 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('bad_arguments');
    expect((err as HostedError).message).toContain('has no argument extra');
    expect(hosted.calls).toEqual([]);
    expect((await hosted.call('vector_build_identity_register', REGISTER)).json).toEqual({ ok: true });
    expect(hosted.calls).toHaveLength(1);
  });
  it('refuses a missing argument before the handler runs, and takes the call with it', async () => {
    const hosted = fake();
    const { name: _name, ...without } = REGISTER;
    const err = await hosted.call('vector_build_identity_register', without).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).message).toContain('requires name');
    expect(hosted.calls).toEqual([]);
    await hosted.call('vector_build_identity_register', REGISTER);
    expect(hosted.calls).toHaveLength(1);
  });
  it('refuses a value that breaks the schema, and a tool that the capture does not hold', async () => {
    const hosted = fake();
    const tooLong = await hosted.call('vector_build_identity_register', { ...REGISTER, valid_minutes: 60 }).then(() => null, (e: unknown) => e);
    expect((tooLong as HostedError).message).toContain('valid_minutes must be at most 59');
    await expect(hosted.call('vector_build_identity_register', { ...REGISTER, valid_minutes: 59 })).resolves.toBeDefined();
    await expect(hosted.call('vector_build_transaction', { changeAddress: 'addr1test', outputs: [] })).rejects.toMatchObject({ kind: 'bad_arguments' });
    await expect(hosted.call('vector_get_vault', {})).rejects.toMatchObject({ kind: 'unreachable' });
  });
  it('writes a build answer in the live format: the CBOR follows its marker, and the last JSON block holds the hash, the fee, the end of the validity and the signers', async () => {
    const build = { txCbor: 'aa'.repeat(10), txHash: 'bb'.repeat(32), fee: '450000', validFrom: 1_000, validTo: 61_000, requiredSigners: [{ keyHash: 'cc'.repeat(28), roles: ['wallet', 'controller'] }] };
    const hosted = new PackHosted({ vector_build_identity_register: () => liveBuildAnswer('Identity registration', build, { did: 'did:vector:test' }) });
    const answer = await hosted.call('vector_build_identity_register', REGISTER);
    expect(answer.failed).toBe(false);
    expect(answer.text).toContain(`**Unsigned TX CBOR:**\n\`\`\`\n${build.txCbor}\n\`\`\``);
    expect(answer.json).toEqual({
      did: 'did:vector:test', tx_hash: build.txHash, fee: '450000', valid_from: 1_000, valid_to: 61_000, required_signers: [{ key_hash: 'cc'.repeat(28), roles: ['wallet', 'controller'] }],
    });
  });
});

// ---- the world of the landing tests ----

const USE_CASE = 'test-use-case';
/** The keys of the tests, each with the number of the wallet of the world that has the same key: a registry key and a wallet of the world are one key. */
const KEY_N = { run: MEMBER_N, service: AGENT_N, controller: CONTROLLER_N, fee: 4, other: 5 } as const;
type KeyName = keyof typeof KEY_N;
const ALL_KEYS = Object.keys(KEY_N) as KeyName[];
/** An address that no registry holds. */
const OUTSIDE = keyOf(77, 'outsider').address;
const VALID_FOR_MS = 20 * 60_000;
const WAIT_MS = 10_000;
const FEE_LIMIT = 2_000_000n;

const folders: string[] = [];
afterAll(() => {
  removeTestKeys();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function registryOf(names: readonly KeyName[]): Registry {
  const root = makeKeyRoot();
  const specs: KeySpec[] = names.map((name) => ({ name, scope: 'use-case', about: `The test key ${name}.` }));
  for (const name of names) writeSeed(root, USE_CASE, name, `${seedHex(KEY_N[name])}\n`);
  return loadRegistry({ dir: root, useCase: USE_CASE, specs });
}

const settingsOf = (maxFeeLovelace: bigint): OperatorSettings => ({
  network: VECTOR_MAINNET, useCase: USE_CASE, keysDir: '/keys', stateDir: '/state', agentsDir: '/agents', goFile: '/state/GO.json', mockEnvFile: null, contact: null, module1Commit: null,
  urls: { ogmios: 'https://ogmios.test', submit: 'https://submit.test', koios: 'https://koios.test', hosted: 'https://hosted.test/mcp', gateway: 'https://gateway.test' },
  maxFeeLovelace, maxCollateralLossLovelace: 5_000_000n,
});

const goOf = (runWallet: string, over: Partial<GoFile> = {}): GoFile => ({
  approvedBy: 'a test approver', at: iso(NOW - 3_600_000), session: 'test-session', runWallet, capUnits: 100, tasks: ['fund'], irreversible: ['record'], expiresAt: iso(NOW + 86_400_000), ...over,
});

interface Ctx {
  world: World; node: FakeNode; clock: FakeClock; screen: MemoryOutput; registry: Registry; hosted: PackHosted; state: StateFile; evidence: EvidenceFile; exposure: Exposure; host: LandHost;
  /** What happened, in order: 'sign', 'reserve', 'in_flight' and 'submit'. */
  events: string[];
  /** What the exposure file and the state file held at each submit. */
  atSubmit: Array<{ exposed: bigint; inFlight: string | null }>;
  /** The signer that fails when asked, when the context has one. */
  signer: ThrowingSigner | null;
  /** The exposure file: it exists only after the first reserve. */
  exposurePath: string;
}

interface ContextOver {
  mode?: 'dry' | 'submit';
  /** The approval: absent for a valid one, null for none. */
  go?: GoFile | null;
  names?: readonly KeyName[];
  maxFee?: bigint;
  handlers?: Record<string, Handler>;
  /** The ring signs nothing: it fails when asked. */
  throwing?: boolean;
}

async function context(over: ContextOver = {}): Promise<Ctx> {
  const world = await World.identity({ wallets: [{ n: KEY_N.run }, { n: KEY_N.service, lovelace: [200_000_000n, 5_000_000n] }, { n: KEY_N.fee }, { n: KEY_N.other }] });
  const registry = registryOf(over.names ?? ALL_KEYS);
  const dir = mkdtempSync(join(tmpdir(), 'operator-landing-'));
  chmodSync(dir, 0o700);
  folders.push(dir);
  const identity = { check: 'operator', network: 'vector-mainnet', record: 'test' };
  const state = StateFile.open(join(dir, 'state.json'), identity);
  const evidence = EvidenceFile.open(join(dir, 'evidence.json'), identity);
  const go = 'go' in over ? (over.go ?? null) : goOf(keyOf(KEY_N.run).address);
  const exposurePath = join(dir, 'exposure.json');
  const exposure = new Exposure(exposurePath, go);
  const node = new FakeNode(world);
  const clock = new FakeClock(NOW);
  const screen = new MemoryOutput();
  const hosted = new PackHosted(over.handlers ?? {});
  const signer = over.throwing === true ? new ThrowingSigner() : null;
  const events: string[] = [];
  const atSubmit: Ctx['atSubmit'] = [];
  const reserve = exposure.reserve.bind(exposure);
  exposure.reserve = (entry) => { events.push('reserve'); reserve(entry); };
  const setInFlight = state.setInFlight.bind(state);
  state.setInFlight = (record) => { events.push('in_flight'); setInFlight(record); };
  const submit = node.submit.bind(node);
  node.submit = async (cbor) => {
    events.push('submit');
    atSubmit.push({ exposed: exposure.total(), inFlight: state.snapshot().in_flight?.tx_hash ?? null });
    return submit(cbor);
  };
  const sign = registry.ring.sign.bind(registry.ring);
  registry.ring.sign = (keyHash, cborHex) => { events.push('sign'); return signer === null ? sign(keyHash, cborHex) : signer.sign(); };
  const chain: ChainAccess = {
    provider: world.chain, deployment: DEPLOYMENT, koiosUrl: 'https://koios.test', fetchImpl: (async () => { throw new Error('the network was touched'); }) as typeof fetch,
    context: async (address) => ({ lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT }), liveVaultsOf: async () => [],
  };
  const host: LandHost = {
    mode: over.mode ?? 'submit', settings: settingsOf(over.maxFee ?? FEE_LIMIT), registry, state, evidence, clock, out: screen, node, network: new NetworkGate(node, VECTOR_MAINNET),
    networkResult: () => null, chain, hosted, go, exposure, task: 'fund', awaitMs: WAIT_MS, pollMs: 5_000,
  };
  return { world, node, clock, screen, registry, hosted, state, evidence, exposure, host, events, atSubmit, signer, exposurePath };
}

interface Payment { unsignedCbor: string; txHash: string; feeLovelace: bigint; validTo: number }

/**
 * A payment from the run wallet, built in process as the task fund builds it: the slot clock of Vector is set first (unless `vectorClock` is false), then Lucid builds with a `validTo`.
 * A `validTo` of null builds a body with no end.
 */
async function pay(world: World, outputs: ReadonlyArray<{ address: string; lovelace: bigint }>, over: { validTo?: number | null; vectorClock?: boolean } = {}): Promise<Payment> {
  if (over.vectorClock !== false) await ensureSlotConfig(world.chain);
  const validTo = over.validTo === undefined ? NOW + VALID_FOR_MS : over.validTo;
  const lucid = await lucidForAddress(world.chain, keyOf(KEY_N.run).address);
  let tx = lucid.newTx();
  for (const output of outputs) tx = tx.pay.ToAddress(output.address, { lovelace: output.lovelace });
  if (validTo !== null) tx = tx.validTo(validTo);
  const built = await tx.complete();
  return { unsignedCbor: built.toCBOR(), txHash: built.toHash(), feeLovelace: factsOf(built.toCBOR()).feeLovelace, validTo: validTo ?? NOW + VALID_FOR_MS };
}

const walletOf = (name: KeyName): string => keyOf(KEY_N[name]).address;
/** Three units to the service wallet and four to the fee wallet: a transfer inside the registry. */
const INSIDE = [{ address: walletOf('service'), lovelace: 3_000_000n }, { address: walletOf('fee'), lovelace: 4_000_000n }];
/** Three units to an address that the registry does not hold. */
const OUTWARD = [{ address: OUTSIDE, lovelace: 3_000_000n }];

/** The spec of a landing in process: the run key signs, and the plan allows what the payment sends. */
function builtSpec(c: Ctx, payment: Payment, plan: PlanOver = {}, over: Partial<BuiltLandSpec> = {}): BuiltLandSpec {
  return { step: 'fund', built: payment, expectSigners: ['run'], plan: () => planOf(c.host, { outflow: { run: 10_000_000n }, ...plan }), ...over };
}

const liveOf = (payment: Payment, signers: readonly string[]): LiveBuild => ({
  txCbor: payment.unsignedCbor, txHash: payment.txHash, fee: payment.feeLovelace.toString(), validFrom: NOW - 60_000, validTo: payment.validTo,
  requiredSigners: signers.map((keyHash) => ({ keyHash, roles: ['wallet'] })),
});

const refusal = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => { throw new Error('the call did not refuse'); }, (err: unknown) => err);
const guardsOf = (err: unknown): string[] => (err as GuardRefusal).failures.map((failure) => failure.guard);
/** Nothing was signed, submitted or recorded as in flight, and the world did not move. */
const untouched = (c: Ctx): void => {
  expect(c.events).not.toContain('sign');
  expect(c.node.submitted).toEqual([]);
  expect(c.world.chain.applied).toEqual([]);
  expect(c.state.snapshot().in_flight).toBeNull();
};
/** The approval was not read and the cap was not touched: no entry was reserved, and the exposure file was never made. */
const unreserved = (c: Ctx): void => {
  expect(c.events).not.toContain('reserve');
  expect(existsSync(c.exposurePath)).toBe(false);
};

// ---- landBuilt: the end of the validity ----
// These tests come first on purpose. Lucid turns a validTo into a slot with its own clock until ensureSlotConfig sets the slot clock of Vector, and that clock is global to the process:
// the first test builds with the clock of Lucid, so no call of ensureSlotConfig may come before it.

describe('landBuilt: the end of the validity', () => {
  it('refuses a payment that Lucid built with its own slot clock: both slots are named and nothing is signed, and the twin that was built after ensureSlotConfig lands', async () => {
    const c = await context();
    const wrong = await pay(c.world, INSIDE, { vectorClock: false });
    const vectorSlot = BigInt((wrong.validTo - SYSTEM_START_MS) / 1000);
    const bodySlot = factsOf(wrong.unsignedCbor).validityEndSlot;
    if (bodySlot === vectorSlot) throw new Error('Lucid used the slot clock of Vector, so this test proves nothing: it must run before any call of ensureSlotConfig');
    const err = await refusal(landBuilt(c.host, builtSpec(c, wrong)));
    expect(err).toBeInstanceOf(GuardRefusal);
    expect(guardsOf(err)).toEqual(['body']);
    expect((err as GuardRefusal).message).toContain(`the body ends at the slot ${bodySlot}`);
    expect((err as GuardRefusal).message).toContain(`is the slot ${vectorSlot}`);
    untouched(c);
    expect(c.screen.lines).toEqual([]);
    const right = await pay(c.world, INSIDE);
    expect(factsOf(right.unsignedCbor).validityEndSlot).toBe(BigInt((right.validTo - SYSTEM_START_MS) / 1000));
    expect((await landBuilt(c.host, builtSpec(c, right))).kind).toBe('landed');
  });
  it('refuses a body with no ttl, names the slot of the validTo, and lands the same payment with an end', async () => {
    const c = await context();
    const open = await pay(c.world, INSIDE, { validTo: null });
    expect(factsOf(open.unsignedCbor).validityEndSlot).toBeNull();
    const err = await refusal(landBuilt(c.host, builtSpec(c, open)));
    expect(guardsOf(err)).toEqual(['body']);
    expect((err as GuardRefusal).message).toContain('the body has no ttl');
    expect((err as GuardRefusal).message).toContain(`is the slot ${(open.validTo - SYSTEM_START_MS) / 1000}`);
    untouched(c);
    expect((await landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE)))).kind).toBe('landed');
  });
  it('refuses a validTo that is not the end of the ttl, in either direction, and takes the validTo that is', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    for (const shift of [-60_000, 1_000, 3_600_000]) {
      const err = await refusal(landBuilt(c.host, builtSpec(c, { ...payment, validTo: payment.validTo + shift })));
      expect(guardsOf(err), `shift ${shift}`).toEqual(['body']);
      expect((err as GuardRefusal).message).toContain(`the body ends at the slot ${(payment.validTo - SYSTEM_START_MS) / 1000}`);
    }
    untouched(c);
    expect((await landBuilt(c.host, builtSpec(c, payment))).kind).toBe('landed');
  });
  it('takes the second inside a slot: the slot of a validTo is the whole second that it falls in', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    expect((await landBuilt(c.host, builtSpec(c, { ...payment, validTo: payment.validTo + 999 }))).kind).toBe('landed');
  });
  it('refuses a validTo that is not a whole number of milliseconds after now before any guard runs, and takes a whole number', async () => {
    const c = await context({ throwing: true });
    const payment = await pay(c.world, INSIDE);
    const bad: Array<[string, unknown]> = [
      ['a fraction', payment.validTo + 0.5], ['not a number', Number.NaN], ['infinity', Number.POSITIVE_INFINITY], ['a text', String(payment.validTo)], ['now', NOW], ['the past', NOW - 1_000],
      ['a missing value', undefined],
    ];
    for (const [label, validTo] of bad) {
      const err = await refusal(landBuilt(c.host, builtSpec(c, { ...payment, validTo: validTo as number })));
      expect(err, label).toBeInstanceOf(Error);
      expect(err, label).not.toBeInstanceOf(GuardRefusal);
      expect((err as Error).message, label).toContain('not a whole number of milliseconds after now');
    }
    untouched(c);
    expect(c.screen.lines).toEqual([]);
    expect(c.signer?.calls).toBe(0);
    unreserved(c);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE)))).kind).toBe('landed');
  });
  it('refuses when the node gives no start of the chain, and when it cannot be read', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    c.node.facts = { magic: VECTOR_MAINNET.magic, systemStartMs: null };
    const none = await refusal(landBuilt(c.host, builtSpec(c, payment)));
    expect(guardsOf(none)).toEqual(['body']);
    expect((none as GuardRefusal).message).toContain('does not give the start of the chain');
    c.node.networkFacts = async () => { throw new Error('the node is down'); };
    const down = await refusal(landBuilt(c.host, builtSpec(c, payment)));
    expect(guardsOf(down)).toEqual(['body']);
    expect((down as GuardRefusal).message).toContain('the node is down');
    untouched(c);
  });
});

// ---- hostedBuild ----

const TOOL = 'vector_build_reputation_stake_open';
const ARGS = { changeAddress: 'addr1test', did: 'did:vector:test', capabilities: ['test.capability.v1'] };
const RUN_HASH = keyOf(KEY_N.run).keyHash;

interface AnswerEdit {
  /** The text of the CBOR block, or null for no block. */
  cbor?: string | null;
  /** Changes the last JSON block, or removes it when it gives null. */
  json?: (json: Record<string, unknown>) => Record<string, unknown> | null;
}

/** The answer of a build tool for `live`, with a part of it changed. */
function answerText(live: LiveBuild, edit: AnswerEdit = {}): { text: string } {
  let text = liveBuildAnswer('Stake opening', live).text;
  if (edit.cbor === null) text = text.replace(/\*\*Unsigned TX CBOR:\*\*\n```\n[^\n]*\n```\n\n/, '');
  else if (edit.cbor !== undefined) text = text.replace(/(\*\*Unsigned TX CBOR:\*\*\n```\n)[^\n]*(\n```)/, (_all, open: string, close: string) => `${open}${edit.cbor}${close}`);
  if (edit.json !== undefined) {
    const block = /```json\n([\s\S]*)\n```$/.exec(text);
    if (block === null) throw new Error('the test answer has no JSON block');
    const next = edit.json(JSON.parse(block[1]!) as Record<string, unknown>);
    text = text.slice(0, block.index) + (next === null ? '' : `\`\`\`json\n${JSON.stringify(next)}\n\`\`\``);
  }
  return { text };
}
const without = (json: Record<string, unknown>, key: string): Record<string, unknown> => Object.fromEntries(Object.entries(json).filter(([name]) => name !== key));

/** A real payment that the run wallet makes, its live build, and a host for `hostedBuild` whose tool gives `handler`. */
async function sample(handler: (live: LiveBuild) => HandlerAnswer) {
  const world = await World.identity({ wallets: [{ n: KEY_N.run }] });
  const payment = await pay(world, OUTWARD);
  const live = liveOf(payment, [RUN_HASH]);
  const screen = new MemoryOutput();
  const host = { hosted: new PackHosted({ [TOOL]: () => handler(live) }), clock: new FakeClock(NOW), out: screen };
  return { payment, live, host, screen };
}

describe('hostedBuild', () => {
  it('reads the answer of a build tool: the CBOR, the hash, the fee, the end of the validity and the signers, and holds them to the bytes', async () => {
    const { payment, host } = await sample((live) => liveBuildAnswer('Stake opening', live, { did: 'did:vector:test' }));
    const build = await hostedBuild(host, TOOL, ARGS);
    expect(build).toMatchObject({ tool: TOOL, args: ARGS, unsignedCbor: payment.unsignedCbor, txHash: payment.txHash, feeLovelace: payment.feeLovelace, validTo: payment.validTo });
    expect(build.requiredSigners).toEqual([{ keyHash: RUN_HASH, roles: ['wallet'] }]);
    expect(build.json).toMatchObject({ did: 'did:vector:test', tx_hash: payment.txHash });
    expect(build.text).toContain('**Unsigned TX CBOR:**');
    expect(host.hosted.calls).toEqual([{ name: TOOL, args: ARGS }]);
  });
  const MALFORMED: Array<[string, AnswerEdit, string]> = [
    ['no unsigned CBOR', { cbor: null }, 'has no unsigned CBOR'],
    ['a CBOR of an odd length', { cbor: 'abc' }, 'not hex of whole bytes'],
    ['a CBOR with a letter that is not hex', { cbor: 'zz11' }, 'not hex of whole bytes'],
    ['an empty CBOR', { cbor: '' }, 'not hex of whole bytes'],
    ['bytes that are no transaction', { cbor: 'aabbccdd' }, 'is no transaction'],
    ['no JSON block', { json: () => null }, 'has no JSON block'],
    ['no tx_hash', { json: (json) => without(json, 'tx_hash') }, 'no tx_hash'],
    ['a tx_hash that is no hash', { json: (json) => ({ ...json, tx_hash: 'zz' }) }, 'no tx_hash'],
    ['no fee', { json: (json) => without(json, 'fee') }, 'no fee'],
    ['a fee that is a number', { json: (json) => ({ ...json, fee: 450_000 }) }, 'no fee'],
    ['no valid_to', { json: (json) => without(json, 'valid_to') }, 'valid_to that is not a whole number'],
    ['a valid_to with a fraction', { json: (json) => ({ ...json, valid_to: 1_795_000_000_000.5 }) }, 'valid_to that is not a whole number'],
    ['a valid_to that is a text', { json: (json) => ({ ...json, valid_to: '1795000000000' }) }, 'valid_to that is not a whole number'],
    ['no required_signers', { json: (json) => without(json, 'required_signers') }, 'no required_signers list'],
    ['required_signers that is a text', { json: (json) => ({ ...json, required_signers: 'run' }) }, 'no required_signers list'],
    ['a signer with a short key_hash', { json: (json) => ({ ...json, required_signers: [{ key_hash: 'abc', roles: [] }] }) }, 'required_signers entry'],
    ['a signer with no roles', { json: (json) => ({ ...json, required_signers: [{ key_hash: RUN_HASH }] }) }, 'required_signers entry'],
    ['a tx_hash that is not the hash of the bytes', { json: (json) => ({ ...json, tx_hash: 'ee'.repeat(32) }) }, 'the bytes have the hash'],
    ['a fee that is not the fee of the bytes', { json: (json) => ({ ...json, fee: '1' }) }, 'the bytes have the fee'],
  ];
  for (const [label, edit, phrase] of MALFORMED) {
    it(`refuses an answer with ${label}, and says what is wrong`, async () => {
      const { host } = await sample((live) => answerText(live, edit));
      const err = await refusal(hostedBuild(host, TOOL, ARGS));
      expect(err).toBeInstanceOf(HostedError);
      expect((err as HostedError).kind).toBe('protocol');
      expect((err as HostedError).message).toContain(TOOL);
      expect((err as HostedError).message).toContain(phrase);
    });
  }
  it('takes the answer that has every member, as the twin of each refusal above', async () => {
    const { payment, host } = await sample((live) => answerText(live));
    expect((await hostedBuild(host, TOOL, ARGS)).txHash).toBe(payment.txHash);
    const upper = await sample((live) => answerText(live, { json: (json) => ({ ...json, tx_hash: String(json.tx_hash).toUpperCase() }) }));
    expect((await hostedBuild(upper.host, TOOL, ARGS)).txHash).toBe(upper.payment.txHash);
    const spaced = await sample((live) => ({ text: answerText(live).text.replace('**Unsigned TX CBOR:**\n```', '**Unsigned TX CBOR:**\n\n```hex') }));
    expect((await hostedBuild(spaced.host, TOOL, ARGS)).unsignedCbor).toBe(spaced.payment.unsignedCbor);
  });
  it('asks again when a failed answer says that the tool cannot answer now, 10 seconds apart, and takes the answer that comes', async () => {
    let asked = 0;
    const { live, host, screen } = await sample((built) => (++asked <= 2 ? { text: 'Failed to build: the node is not synced yet, try again in a minute', isError: true } : liveBuildAnswer('Stake opening', built)));
    const build = await hostedBuild(host, TOOL, ARGS);
    expect(build.txHash).toBe(live.txHash);
    expect(host.hosted.calls).toHaveLength(3);
    expect(host.clock.slept).toEqual([10_000, 10_000]);
    expect(screen.text).toContain('asking again in 10 s');
  });
  for (const phrase of ['not ready', 'not synced', 'behind', 'try again', 'temporar', 'timed out']) {
    it(`asks again for the text "${phrase}"`, async () => {
      let asked = 0;
      const { host } = await sample((live) => (++asked === 1 ? { text: `Failed: the tool is ${phrase} for now`, isError: true } : liveBuildAnswer('Stake opening', live)));
      await hostedBuild(host, TOOL, ARGS);
      expect(host.hosted.calls).toHaveLength(2);
      expect(host.clock.slept).toEqual([10_000]);
    });
  }
  it('gives up with HostedError unreachable after four more calls, and does not ask again after that', async () => {
    const { host } = await sample(() => ({ text: 'Failed to build: the node is behind, try again later', isError: true }));
    const err = await refusal(hostedBuild(host, TOOL, ARGS));
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('unreachable');
    expect((err as HostedError).message).toContain('5 calls');
    expect(host.hosted.calls).toHaveLength(5);
    expect(host.clock.slept).toEqual([10_000, 10_000, 10_000, 10_000]);
  });
  it('does not ask again for a success that mentions a transient text, and does not wait', async () => {
    const { payment, host } = await sample((live) => liveBuildAnswer('Stake opening (the wallet is not ready for a second build, try again later)', live));
    expect((await hostedBuild(host, TOOL, ARGS)).txHash).toBe(payment.txHash);
    expect(host.hosted.calls).toHaveLength(1);
    expect(host.clock.slept).toEqual([]);
  });
  it('throws ToolRefused with the first line of the text when a tool says Failed or REFUSED, after one call and with no wait', async () => {
    for (const [text, line] of [['Failed to build: the wallet has no collateral output\nsecond line', 'Failed to build: the wallet has no collateral output'], ['REFUSED: the name is not valid\nmore', 'REFUSED: the name is not valid']] as const) {
      const { host } = await sample(() => ({ text }));
      const err = await refusal(hostedBuild(host, TOOL, ARGS));
      expect(err).toBeInstanceOf(ToolRefused);
      expect(err).toMatchObject({ tool: TOOL, detail: line });
      expect((err as ToolRefused).message).toContain(TOOL);
      expect(host.hosted.calls).toHaveLength(1);
      expect(host.clock.slept).toEqual([]);
    }
  });
  it('gives a reason when the tool sets the error flag and says nothing', async () => {
    const { host } = await sample(() => ({ text: '', isError: true }));
    const err = await refusal(hostedBuild(host, TOOL, ARGS));
    expect(err).toBeInstanceOf(ToolRefused);
    expect((err as ToolRefused).detail).toBe('the tool gave no reason');
  });
  it('lets the schema refusal of the hosted tools pass: a call that the live schema refuses is a HostedError and never reaches the handler', async () => {
    const { host } = await sample((live) => liveBuildAnswer('Stake opening', live));
    const err = await refusal(hostedBuild(host, TOOL, { ...ARGS, stray: true }));
    expect(err).toBeInstanceOf(HostedError);
    expect((err as HostedError).kind).toBe('bad_arguments');
    expect(host.hosted.calls).toEqual([]);
  });
});

// ---- landBuilt: the guards, the signers, the approval and the cap ----

describe('landBuilt in a dry run', () => {
  it('prints the summary, signs and submits nothing, does not read the approval, and does not touch the cap', async () => {
    const c = await context({ mode: 'dry', go: null, throwing: true });
    const payment = await pay(c.world, INSIDE);
    const result = await landBuilt(c.host, builtSpec(c, payment));
    expect(result).toMatchObject({ kind: 'dry', txHash: payment.txHash, build: null });
    expect(result.facts.txHash).toBe(payment.txHash);
    expect(result.results.every((guard) => guard.ok)).toBe(true);
    untouched(c);
    unreserved(c);
    expect(c.signer?.calls).toBe(0);
    expect(c.screen.text).toContain(payment.txHash);
    expect(c.screen.text).toContain('dry mode, nothing is signed or submitted');
  });
  it('refuses what a submit run refuses: a signer that the step does not name, and an output outside the plan', async () => {
    const c = await context({ mode: 'dry', go: null, throwing: true });
    const signers = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), {}, { expectSigners: ['fee'] })));
    expect(guardsOf(signers)).toEqual(['signers']);
    const outside = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, OUTWARD))));
    expect(guardsOf(outside)).toEqual(['destinations']);
    untouched(c);
  });
});

describe('landBuilt in a submit run', () => {
  it('signs with the run key, records the step, writes the confirmed entry, and counts only the fee of a transfer inside the registry', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    const result = await landBuilt(c.host, builtSpec(c, payment, {}, { refs: () => ({ pay_ref: 'ref-one' }), facts: (facts) => ({ outputs: facts.outputs.length }), notes: ['a note of the step'] }));
    expect(result).toMatchObject({ kind: 'landed', txHash: payment.txHash, feeLovelace: payment.feeLovelace, confirmations: 1, build: null });
    expect(c.world.chain.applied).toHaveLength(1);
    const outputs = factsOf(payment.unsignedCbor).outputs.length;
    expect(c.state.step('fund')).toMatchObject({ tx_hash: payment.txHash, refs: { pay_ref: 'ref-one' }, facts: { outputs } });
    expect(c.state.snapshot().in_flight).toBeNull();
    expect(c.exposure.total()).toBe(payment.feeLovelace);
    expect(c.evidence.entries().filter((entry) => entry.status === 'confirmed')).toEqual([
      expect.objectContaining({ step: 'fund', tx_hash: payment.txHash, fee_lovelace: payment.feeLovelace.toString(), shows: { refs: { pay_ref: 'ref-one' }, facts: { outputs } } }),
    ]);
    expect(c.screen.text).toContain('a note of the step');
  });
  it('keeps a step with a colon as a part, in a note, and not as a step', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    await landBuilt(c.host, builtSpec(c, payment, {}, { step: 'float:part' }));
    expect(c.state.step('float:part')).toBeUndefined();
    expect(c.state.note('part.float:part')).toMatchObject({ tx_hash: payment.txHash });
    expect(c.state.snapshot().in_flight).toBeNull();
  });
  it('reserves the net outflow before the state file holds the transaction and before the submit, and the exposure file holds it at the submit', async () => {
    const c = await context();
    const payment = await pay(c.world, INSIDE);
    await landBuilt(c.host, builtSpec(c, payment));
    const order = c.events.filter((event) => event !== 'sign');
    expect(order).toEqual(['reserve', 'in_flight', 'submit']);
    expect(c.atSubmit).toEqual([{ exposed: payment.feeLovelace, inFlight: payment.txHash }]);
    const entry = JSON.parse(readFileSync(c.exposurePath, 'utf8')) as { entries: Array<{ step: string; tx_hash: string; net_lovelace: string }> };
    expect(entry.entries).toEqual([expect.objectContaining({ step: 'fund', tx_hash: payment.txHash, net_lovelace: payment.feeLovelace.toString() })]);
  });
  it('counts a transfer to an address outside the registry in full, its amount and its fee', async () => {
    const c = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 4 }) });
    const payment = await pay(c.world, OUTWARD);
    await landBuilt(c.host, builtSpec(c, payment, { destinations: [OUTSIDE] }));
    expect(c.exposure.total()).toBe(3_000_000n + payment.feeLovelace);
    expect(c.atSubmit[0]!.exposed).toBe(3_000_000n + payment.feeLovelace);
  });
  it('refuses a transfer that the cap does not hold before any signature, and lands it under a cap that holds it', async () => {
    const c = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 3 }), throwing: true });
    const payment = await pay(c.world, OUTWARD);
    const err = await refusal(landBuilt(c.host, builtSpec(c, payment, { destinations: [OUTSIDE] })));
    expect(err).toBeInstanceOf(ApprovalError);
    expect((err as ApprovalError).message).toContain('over the cap');
    untouched(c);
    unreserved(c);
    expect(c.signer?.calls).toBe(0);
    const ok = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 4 }) });
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, OUTWARD), { destinations: [OUTSIDE] }))).kind).toBe('landed');
  });
  it('holds the cap to the lovelace: a cap equal to the net outflow passes, and one lovelace less refuses', async () => {
    const probe = await context();
    const net = 3_000_000n + (await pay(probe.world, OUTWARD)).feeLovelace;
    const capOf = (lovelace: bigint) => goOf(keyOf(KEY_N.run).address, { capUnits: Number(lovelace) / 1_000_000 });
    expect(lovelaceOfUnits(capOf(net).capUnits)).toBe(net);
    const equal = await context({ go: capOf(net) });
    expect((await landBuilt(equal.host, builtSpec(equal, await pay(equal.world, OUTWARD), { destinations: [OUTSIDE] }))).kind).toBe('landed');
    const less = await context({ go: capOf(net - 1n), throwing: true });
    const err = await refusal(landBuilt(less.host, builtSpec(less, await pay(less.world, OUTWARD), { destinations: [OUTSIDE] })));
    expect(err).toBeInstanceOf(ApprovalError);
    untouched(less);
  });
  it('refuses every transaction under a cap of 0, and lands a transfer inside the registry under a cap that covers its fee only', async () => {
    const zero = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 0 }), throwing: true });
    expect(await refusal(landBuilt(zero.host, builtSpec(zero, await pay(zero.world, INSIDE))))).toBeInstanceOf(ApprovalError);
    untouched(zero);
    const small = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 1 }) });
    const payment = await pay(small.world, INSIDE);
    expect((await landBuilt(small.host, builtSpec(small, payment))).kind).toBe('landed');
    expect(small.exposure.total()).toBe(payment.feeLovelace);
  });
  it('adds up the cap over the transactions of a session: the third transfer is over the cap, and the first two stay counted', async () => {
    const c = await context({ go: goOf(keyOf(KEY_N.run).address, { capUnits: 7 }) });
    const first = await pay(c.world, OUTWARD);
    await landBuilt(c.host, builtSpec(c, first, { destinations: [OUTSIDE] }, { step: 'fund-1' }));
    const second = await pay(c.world, OUTWARD);
    await landBuilt(c.host, builtSpec(c, second, { destinations: [OUTSIDE] }, { step: 'fund-2' }));
    expect(c.exposure.total()).toBe(6_000_000n + first.feeLovelace + second.feeLovelace);
    const third = await pay(c.world, OUTWARD);
    const err = await refusal(landBuilt(c.host, builtSpec(c, third, { destinations: [OUTSIDE] }, { step: 'fund-3' })));
    expect(err).toBeInstanceOf(ApprovalError);
    expect(c.exposure.total()).toBe(6_000_000n + first.feeLovelace + second.feeLovelace);
    expect(c.world.chain.applied).toHaveLength(2);
  });
  it('leaves the evaluation error and the body in the evidence when the ledger refuses the transaction, and gives the reserve back', async () => {
    const c = await context();
    c.node.submitError = new Error('Transaction submission rejected (400): the script failed in this test');
    const payment = await pay(c.world, INSIDE);
    const err = await refusal(landBuilt(c.host, builtSpec(c, payment)));
    expect(err).toBeInstanceOf(LandRefused);
    const refused = c.evidence.entries().filter((entry) => entry.status === 'refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ step: 'fund', expected: false, tx_hash: payment.txHash, transaction_body: factsOf(payment.unsignedCbor).bodyHex });
    expect(String(refused[0]!.evaluation_error)).toContain('the script failed in this test');
    expect(c.atSubmit).toEqual([{ exposed: payment.feeLovelace, inFlight: payment.txHash }]);
    expect(c.exposure.total()).toBe(0n);
    expect(c.state.snapshot().in_flight).toBeNull();
    expect(c.state.step('fund')).toBeUndefined();
  });
  it('keeps the transaction in flight and its reserve when the submit fails without the verdict of the ledger', async () => {
    const c = await context();
    c.node.submitError = new Error('connection reset');
    const payment = await pay(c.world, INSIDE);
    expect(await refusal(landBuilt(c.host, builtSpec(c, payment)))).toBeInstanceOf(TxNotConfirmedError);
    expect(c.state.snapshot().in_flight?.tx_hash).toBe(payment.txHash);
    expect(c.exposure.total()).toBe(payment.feeLovelace);
    expect(c.evidence.entries().filter((entry) => entry.status === 'refused')).toEqual([]);
  });
  it('keeps the transaction in flight and its reserve when it is submitted and not seen confirmed', async () => {
    const c = await context();
    c.node.neverConfirm = true;
    const payment = await pay(c.world, INSIDE);
    expect(await refusal(landBuilt(c.host, builtSpec(c, payment)))).toBeInstanceOf(TxNotConfirmedError);
    expect(c.node.submitted).toHaveLength(1);
    expect(c.state.snapshot().in_flight?.tx_hash).toBe(payment.txHash);
    expect(c.state.step('fund')).toBeUndefined();
    expect(c.exposure.total()).toBe(payment.feeLovelace);
  });
  it('gives the reserve back when the state file refuses the record, because another transaction is in flight, and submits nothing', async () => {
    const c = await context();
    const first = await pay(c.world, INSIDE);
    c.state.setInFlight({ step: 'earlier', tx_hash: 'ab'.repeat(32), signed_cbor: 'aa', valid_to: NOW + 1_000, signed_at: NOW, refs: {}, facts: {} });
    const err = await refusal(landBuilt(c.host, builtSpec(c, first)));
    expect(err).toBeInstanceOf(StateError);
    expect(c.exposure.total()).toBe(0n);
    expect(c.node.submitted).toEqual([]);
    expect(c.state.snapshot().in_flight?.step).toBe('earlier');
  });

  it('refuses a transaction that the plan does not allow, and lands it when the plan does: an output to an address that the plan does not name', async () => {
    const c = await context({ throwing: true });
    const err = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, OUTWARD))));
    expect(guardsOf(err)).toEqual(['destinations']);
    untouched(c);
    unreserved(c);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, OUTWARD), { destinations: [OUTSIDE] }))).kind).toBe('landed');
  });
  it('refuses a fee over the limit of the settings, and lands under it', async () => {
    const tight = await context({ maxFee: 1n, throwing: true });
    const err = await refusal(landBuilt(tight.host, builtSpec(tight, await pay(tight.world, INSIDE))));
    expect(guardsOf(err)).toEqual(['fee']);
    untouched(tight);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE)))).kind).toBe('landed');
  });
  it('refuses an outflow over the limit of the plan, and lands within it', async () => {
    const c = await context({ throwing: true });
    const err = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), { outflow: { run: 1n } })));
    expect(guardsOf(err)).toEqual(['outflow']);
    untouched(c);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE), { outflow: { run: 7_000_000n + FEE_LIMIT } }))).kind).toBe('landed');
  });
  it('refuses a hash or a fee that the builder gives and that is not the hash or the fee of the bytes, and lands the claim that is', async () => {
    const c = await context({ throwing: true });
    const payment = await pay(c.world, INSIDE);
    const hash = await refusal(landBuilt(c.host, builtSpec(c, { ...payment, txHash: 'ee'.repeat(32) })));
    expect(guardsOf(hash)).toEqual(['body']);
    expect((hash as GuardRefusal).message).toContain('the hash of the bytes is');
    const fee = await refusal(landBuilt(c.host, builtSpec(c, { ...payment, feeLovelace: payment.feeLovelace + 1n })));
    expect(guardsOf(fee)).toEqual(['body']);
    untouched(c);
    unreserved(c);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE)))).kind).toBe('landed');
  });
  it('refuses a transaction when the node cannot read an input, and says which', async () => {
    const c = await context({ throwing: true });
    const payment = await pay(c.world, INSIDE);
    c.node.resolveInputs = async () => [];
    const err = await refusal(landBuilt(c.host, builtSpec(c, payment)));
    expect(guardsOf(err)).toEqual(['inputs']);
    expect((err as GuardRefusal).message).toContain('could not be read from the node');
    untouched(c);
  });

  it('refuses a signer that the step does not name and a signer that the bytes do not need, in each direction, and names both sets', async () => {
    const c = await context({ throwing: true });
    const payment = await pay(c.world, INSIDE);
    const fewer = await refusal(landBuilt(c.host, builtSpec(c, payment, {}, { expectSigners: ['run', 'fee'] })));
    expect(guardsOf(fewer)).toEqual(['signers']);
    expect((fewer as GuardRefusal).message).toContain('the keys that sign are run, and the step expects fee, run: missing fee');
    const other = await refusal(landBuilt(c.host, builtSpec(c, payment, {}, { expectSigners: ['fee'] })));
    expect((other as GuardRefusal).message).toContain('the keys that sign are run, and the step expects fee: extra run; missing fee');
    const none = await refusal(landBuilt(c.host, builtSpec(c, payment, {}, { expectSigners: [] })));
    expect((none as GuardRefusal).message).toContain('the step expects none: extra run');
    untouched(c);
    unreserved(c);
    expect(c.signer?.calls).toBe(0);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE), {}, { expectSigners: ['run', 'run'] }))).kind).toBe('landed');
  });
  it('refuses a name that the registry does not hold, and signs nothing', async () => {
    const c = await context({ throwing: true });
    const err = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), {}, { expectSigners: ['nobody'] })));
    expect(String((err as Error).message)).toContain('nobody');
    untouched(c);
  });

  const APPROVALS: Array<[string, Partial<GoFile> | null, string]> = [
    ['no approval', null, 'needs an approval file'],
    ['an approval that has expired', { expiresAt: iso(NOW - 1_000) }, 'has expired'],
    ['an approval for another run wallet', { runWallet: OUTSIDE }, 'another run wallet'],
    ['an approval that does not list the task', { tasks: ['keys'] }, 'does not list the task fund'],
  ];
  for (const [label, over, phrase] of APPROVALS) {
    it(`refuses a submit run with ${label}, before any signature, and lands with a valid approval`, async () => {
      const c = await context({ go: over === null ? null : goOf(keyOf(KEY_N.run).address, over), throwing: true });
      const err = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE))));
      expect(err).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).message).toContain(phrase);
      untouched(c);
      unreserved(c);
      expect(c.signer?.calls).toBe(0);
      const ok = await context();
      expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE)))).kind).toBe('landed');
    });
  }
  it('refuses a step with an irreversible tag that the approval does not list, and lands it when the approval lists the tag', async () => {
    const c = await context({ go: goOf(keyOf(KEY_N.run).address, { irreversible: [] }), throwing: true });
    const err = await refusal(landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), {}, { irreversible: 'record' })));
    expect(err).toBeInstanceOf(ApprovalError);
    expect((err as ApprovalError).message).toContain('irreversible tag record');
    untouched(c);
    const ok = await context();
    expect((await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE), {}, { irreversible: 'record' }))).kind).toBe('landed');
  });

  it('calls beforeSign in a submit run after the signer check and before the plan, and a throw stops the run before any signature', async () => {
    const c = await context({ throwing: true });
    const calls: string[] = [];
    const stop = new Error('the TXT value is not published');
    const payment = await pay(c.world, INSIDE);
    const err = await refusal(landBuilt(c.host, builtSpec(c, payment, {}, {
      beforeSign: async (facts) => { calls.push(`beforeSign ${facts.txHash}`); throw stop; }, plan: () => { calls.push('plan'); return planOf(c.host); },
    })));
    expect(err).toBe(stop);
    expect(calls).toEqual([`beforeSign ${payment.txHash}`]);
    untouched(c);
    unreserved(c);
    const wrongSigners = await refusal(landBuilt(c.host, builtSpec(c, payment, {}, { expectSigners: ['fee'], beforeSign: async () => { calls.push('beforeSign again'); } })));
    expect(guardsOf(wrongSigners)).toEqual(['signers']);
    expect(calls).toEqual([`beforeSign ${payment.txHash}`]);
    const ok = await context();
    const order: string[] = [];
    await landBuilt(ok.host, builtSpec(ok, await pay(ok.world, INSIDE), {}, { beforeSign: async () => { order.push('beforeSign'); }, plan: () => { order.push('plan'); return planOf(ok.host, { outflow: { run: 10_000_000n } }); } }));
    expect(order).toEqual(['beforeSign', 'plan']);
  });
  it('never calls beforeSign in a dry run, and calls the plan', async () => {
    const c = await context({ mode: 'dry', go: null });
    const calls: string[] = [];
    await landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), {}, { beforeSign: async () => { calls.push('beforeSign'); }, plan: () => { calls.push('plan'); return planOf(c.host, { outflow: { run: 10_000_000n } }); } }));
    expect(calls).toEqual(['plan']);
  });
  it('writes no key into the state file, the evidence file or the screen', async () => {
    const c = await context();
    await landBuilt(c.host, builtSpec(c, await pay(c.world, INSIDE), {}, { refs: () => ({ pay_ref: 'ref-one' }) }));
    const text = [readFileSync(c.state.path, 'utf8'), readFileSync(c.evidence.path, 'utf8'), readFileSync(c.exposurePath, 'utf8'), c.screen.text, c.screen.errorText].join('\n');
    for (const name of ALL_KEYS) expect(text, name).not.toContain(seedHex(KEY_N[name]));
  });
});

// ---- landHosted ----

/** A delegation that the run wallet makes with the service key as the delegate key, built by the real builder: it has two signers and mints a token. */
async function delegation(c: Ctx) {
  const run = keyOf(KEY_N.run);
  const lucid = await lucidForAddress(c.world.chain, run.address);
  const built = await buildDelegate({ lucid, provider: c.world.chain, deployment: DEPLOYMENT }, {
    changeAddress: run.address, nowMs: NOW, delegator: { type: 'PrincipalKey', hash: run.keyHash }, delegate: RECORD_ID, delegateKey: keyOf(KEY_N.service).keyHash,
    actions: ['mainnet-checks.token.v1'], resources: ['https://checks.example/token'], notAfter: NOW + 24 * 3_600_000, remaining: 0,
  });
  const live: LiveBuild = {
    txCbor: built.txCbor, txHash: built.txHash, fee: built.fee, validFrom: built.validFrom, validTo: built.validTo,
    requiredSigners: built.requiredSigners.map((signer) => ({ keyHash: signer.keyHash, roles: signer.roles })),
  };
  const plan = (): StepPlan => planOf(c.host, {
    outflow: { run: built.outputLovelace + FEE_LIMIT }, destinations: [DEPLOYMENT.delegation.address], mint: { [`${DEPLOYMENT.delegation.hash}${built.id}`]: 1n },
  });
  return { built, live, plan };
}

const REGISTER_ARGS = (): Record<string, unknown> => ({ changeAddress: walletOf('run'), controller: keyOf(CONTROLLER_N).publicKeyHex, name: 'a test agent', parties: [{ role: 'Accountable', signer: 'controller' }] });
const OPEN_ARGS = (): Record<string, unknown> => ({ changeAddress: walletOf('run'), did: 'did:vector:test', capabilities: ['test.capability.v1'] });

/** A hosted landing of a payment to an address outside the registry: the tool is the stake opening, and the plan names the address. */
async function opening(c: Ctx, over: { signers?: readonly string[]; answer?: (live: LiveBuild) => HandlerAnswer } = {}) {
  const payment = await pay(c.world, OUTWARD);
  const live = liveOf(payment, over.signers ?? [RUN_HASH]);
  c.hosted.handlers[TOOL] = () => (over.answer === undefined ? liveBuildAnswer('Stake opening', live, { opening: 'tool fact' }) : over.answer(live));
  const spec: HostedLandSpec = {
    step: 'open', tool: TOOL, args: OPEN_ARGS(), expectSigners: ['run'], plan: () => planOf(c.host, { outflow: { run: 10_000_000n }, destinations: [OUTSIDE] }),
  };
  return { payment, live, spec };
}

describe('landHosted', () => {
  it('builds with the tool, lands the answer, records the step, and gives the answer in the result', async () => {
    const c = await context();
    const { payment, spec } = await opening(c);
    const seen: string[] = [];
    const result = await landHosted(c.host, {
      ...spec, refs: (build, facts) => ({ tool_tx: build.txHash, body: facts.txHash }), facts: (build) => ({ tool_fact: String(build.json.opening) }),
      plan: (build, facts) => { seen.push(`${build.tool} ${facts.txHash === build.txHash}`); return spec.plan(build, facts); },
    });
    expect(result).toMatchObject({ kind: 'landed', txHash: payment.txHash, feeLovelace: payment.feeLovelace });
    expect(result.build).toMatchObject({ tool: TOOL, txHash: payment.txHash, args: OPEN_ARGS() });
    expect(seen).toEqual([`${TOOL} true`]);
    expect(c.hosted.calls).toEqual([{ name: TOOL, args: OPEN_ARGS() }]);
    expect(c.state.step('open')).toMatchObject({ tx_hash: payment.txHash, refs: { tool_tx: payment.txHash, body: payment.txHash }, facts: { tool_fact: 'tool fact' } });
    expect(c.exposure.total()).toBe(3_000_000n + payment.feeLovelace);
    expect(c.atSubmit).toEqual([{ exposed: 3_000_000n + payment.feeLovelace, inFlight: payment.txHash }]);
    const text = [readFileSync(c.state.path, 'utf8'), readFileSync(c.evidence.path, 'utf8'), c.screen.text].join('\n');
    for (const name of ALL_KEYS) expect(text, name).not.toContain(seedHex(KEY_N[name]));
  });
  it('builds in a dry run, shows the build in the result, and signs nothing, reads no approval and touches no cap', async () => {
    const c = await context({ mode: 'dry', go: null, throwing: true });
    const { payment, spec } = await opening(c);
    const result = await landHosted(c.host, spec);
    expect(result).toMatchObject({ kind: 'dry', txHash: payment.txHash });
    expect(result.build?.json.opening).toBe('tool fact');
    expect(c.hosted.calls).toHaveLength(1);
    untouched(c);
    unreserved(c);
    expect(c.signer?.calls).toBe(0);
  });
  const APPROVALS: Array<[string, Partial<GoFile> | null, string]> = [
    ['no approval', null, 'needs an approval file'],
    ['an approval that has expired', { expiresAt: iso(NOW - 1_000) }, 'has expired'],
    ['an approval for another run wallet', { runWallet: OUTSIDE }, 'another run wallet'],
    ['an approval that does not list the task', { tasks: ['keys'] }, 'does not list the task fund'],
    ['an approval that does not list the irreversible tag of the step', { irreversible: [] }, 'irreversible tag record'],
  ];
  for (const [label, over, phrase] of APPROVALS) {
    it(`refuses a submit run with ${label} before the tool is called`, async () => {
      const c = await context({ go: over === null ? null : goOf(keyOf(KEY_N.run).address, over), throwing: true });
      const { spec } = await opening(c);
      const err = await refusal(landHosted(c.host, { ...spec, irreversible: 'record' }));
      expect(err).toBeInstanceOf(ApprovalError);
      expect((err as ApprovalError).message).toContain(phrase);
      expect(c.hosted.calls).toEqual([]);
      untouched(c);
      unreserved(c);
      const ok = await context();
      const twin = await opening(ok);
      expect((await landHosted(ok.host, { ...twin.spec, irreversible: 'record' })).kind).toBe('landed');
    });
  }
  it('leaves a tool_refused entry with the message of the tool, and throws ToolRefused, when the tool refuses', async () => {
    const c = await context({ throwing: true });
    const { spec } = await opening(c, { answer: () => ({ text: 'REFUSED: the opening output of this agent exists already\nmore text' }) });
    const err = await refusal(landHosted(c.host, spec));
    expect(err).toBeInstanceOf(ToolRefused);
    expect(c.evidence.entries()).toEqual([expect.objectContaining({ step: 'open', status: 'tool_refused', expected: false, tool: TOOL, message: 'REFUSED: the opening output of this agent exists already' })]);
    untouched(c);
    unreserved(c);
    const ok = await context();
    const twin = await opening(ok);
    await landHosted(ok.host, twin.spec);
    expect(ok.evidence.entries().filter((entry) => entry.status === 'tool_refused')).toEqual([]);
  });
  it('refuses an answer whose hash is not the hash of its bytes, before any guard and any signature', async () => {
    const c = await context({ throwing: true });
    const { spec } = await opening(c, { answer: (live) => answerText(live, { json: (json) => ({ ...json, tx_hash: 'ee'.repeat(32) }) }) });
    const err = await refusal(landHosted(c.host, spec));
    expect(err).toBeInstanceOf(HostedError);
    untouched(c);
    expect(c.screen.lines).toEqual([]);
  });
  it('refuses a required signer that the answer lists and that the registry does not hold, and lands the same answer without it', async () => {
    const outsider = 'dd'.repeat(28);
    const c = await context({ throwing: true });
    const { spec } = await opening(c, { signers: [RUN_HASH, outsider] });
    const err = await refusal(landHosted(c.host, spec));
    expect(guardsOf(err)).toEqual(['signers']);
    expect((err as GuardRefusal).message).toContain(`a key that is not in the registry (${outsider})`);
    expect((err as GuardRefusal).message).toContain('extra');
    untouched(c);
    unreserved(c);
    const ok = await context();
    const twin = await opening(ok, { signers: [RUN_HASH] });
    expect((await landHosted(ok.host, twin.spec)).kind).toBe('landed');
  });
  it('refuses a signer set that differs from the plan by one name, in each direction, and lands the set that equals it', async () => {
    const hostedDelegation = async (c: Ctx, expectSigners: readonly string[]): Promise<HostedLandSpec> => {
      const { live, plan } = await delegation(c);
      c.hosted.handlers.vector_build_identity_register = () => liveBuildAnswer('Delegation', live);
      return { step: 'delegate', tool: 'vector_build_identity_register', args: REGISTER_ARGS(), expectSigners, plan };
    };
    const extra = await context({ throwing: true });
    const tooFew = await refusal(landHosted(extra.host, await hostedDelegation(extra, ['run'])));
    expect(guardsOf(tooFew)).toEqual(['signers']);
    expect((tooFew as GuardRefusal).message).toContain('extra service');
    untouched(extra);
    const missing = await context({ throwing: true });
    const tooMany = await refusal(landHosted(missing.host, await hostedDelegation(missing, ['run', 'service', 'fee'])));
    expect(guardsOf(tooMany)).toEqual(['signers']);
    expect((tooMany as GuardRefusal).message).toContain('missing fee');
    untouched(missing);
    unreserved(missing);
    const equal = await context();
    const spec = await hostedDelegation(equal, ['service', 'run']);
    const result = await landHosted(equal.host, spec);
    expect(result.kind).toBe('landed');
    expect(equal.events.filter((event) => event === 'sign')).toHaveLength(2);
  });
  it('refuses a key that the bytes need and the registry does not hold, and counts the output of a script in full when the keys are all there', async () => {
    const outside = await context({ names: ['run', 'controller', 'fee', 'other'], throwing: true });
    const { built, plan } = await delegation(outside);
    const built1 = { unsignedCbor: built.txCbor, txHash: built.txHash, feeLovelace: BigInt(built.fee), validTo: built.validTo };
    const err = await refusal(landBuilt(outside.host, { step: 'delegate', built: built1, expectSigners: ['run'], plan }));
    expect(guardsOf(err)).toEqual(['signers']);
    expect((err as GuardRefusal).message).toContain('a key that is not in the registry');
    untouched(outside);
    const c = await context();
    const again = await delegation(c);
    const landed = await landBuilt(c.host, {
      step: 'delegate', built: { unsignedCbor: again.built.txCbor, txHash: again.built.txHash, feeLovelace: BigInt(again.built.fee), validTo: again.built.validTo }, expectSigners: ['run', 'service'], plan: again.plan,
    });
    expect(landed.kind).toBe('landed');
    // The output at the script address leaves the registry in full, with the fee. The net outflow may also count the total collateral of a transaction that runs scripts.
    const floor = again.built.outputLovelace + BigInt(again.built.fee);
    expect(c.exposure.total()).toBeGreaterThanOrEqual(floor);
    expect(c.exposure.total()).toBeLessThanOrEqual(floor + (factsOf(again.built.txCbor).totalCollateral ?? 0n));
  });
  it('calls beforeSign with the build in a submit run, and a throw stops the run before any signature', async () => {
    const c = await context({ throwing: true });
    const { spec } = await opening(c);
    const stop = new Error('the TXT value is not published');
    const seen: string[] = [];
    const err = await refusal(landHosted(c.host, { ...spec, beforeSign: async (build, facts) => { seen.push(`${build.tool} ${facts.txHash === build.txHash}`); throw stop; } }));
    expect(err).toBe(stop);
    expect(seen).toEqual([`${TOOL} true`]);
    untouched(c);
    unreserved(c);
    const dry = await context({ mode: 'dry', go: null });
    const twin = await opening(dry);
    const calls: string[] = [];
    await landHosted(dry.host, { ...twin.spec, beforeSign: async () => { calls.push('beforeSign'); } });
    expect(calls).toEqual([]);
  });
});
