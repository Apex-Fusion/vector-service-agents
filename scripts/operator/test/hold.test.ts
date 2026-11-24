// The task hold: a party hold on an agent with the Accountable key of its organisation, and its lift. The hosted tool is a fake that builds the REAL Suspend and Unsuspend of buyer-core over a world of
// the fixtures (a record with an Accountable party that has the suspend right, and a Module-1 party), so that the transaction passes the real identity script and the world moves on when it lands. The
// keys are the registry of use case 1 (made at run time). Each refusal has an accepted twin. The tool answers are built before the run, from the world as it is then, because a handler is not async.
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { iso } from '../../checks/lib/format.ts';
import { HostedError } from '../../checks/lib/hosted.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { DAY, DEPLOYMENT } from '../../checks/test/support/world.ts';
import { buildSuspend, buildUnsuspend } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import type { ActorSpec, IdentityContext, SuspendBuild, UnsuspendBuild } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { CONFIG_UTXO, M1, REF_UTXOS, recordUtxo, rootRecord } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { decodeIdentityDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Hold, IdentityDatum, Party, Role, Status } from '../../../packages/vector-read/src/identity-codec.ts';
import type { Facts, HoldFact, TaskFlags } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { ensureSlotConfig, lucidForAddress } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import type { KeySpec, Registry } from '../lib/registry.ts';
import { runTask } from '../lib/runner.ts';
import hold from '../tasks/hold.ts';
import USE from '../usecases/inventory-reorder.ts';
import { PackHosted, liveBuildAnswer } from './support/pack-hosted.ts';
import type { HandlerAnswer } from './support/pack-hosted.ts';
import { NOW, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

const NAMES = USE.keys.map((spec) => spec.name);
const SHARED = USE.keys.filter((spec) => spec.scope === 'shared').map((spec) => spec.name);
const OD_ID = 'b1'.repeat(32);
const OD_DID = `did:vector:${OD_ID}`;
const OTHER_ID = 'b2'.repeat(32);
const ALFA = 'accountable-alfa';
/** The start of the validity window that the build of a test has: a minute before the clock. The hold of one day ends a day after it. */
const LO = NOW - 60_000;

const keyParty = (hash: string, role: Role, rights: number, over: Partial<Party> = {}): Party => ({
  role, signer: { type: 'KeyHash', hash }, organisation: role === 'Accountable' ? utf8Hex('alfa.vector.apexfusion.org') : null, notBefore: NOW - 30 * DAY, notAfter: null, rights, removalAfter: null, ...over,
});
const MODULE1: Party = { role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null, notBefore: NOW - 30 * DAY, notAfter: null, rights: 1, removalAfter: null };
const module1Hold = (until = NOW + 6 * DAY): Hold => ({ by: { type: 'Script', hash: M1 }, reason: 64, since: NOW - DAY, until });
const suspended = (...holds: Hold[]): Status => ({ type: 'Suspended', holds });
const alfaHold = (alfa: string, days = 1): Hold => ({ by: { type: 'KeyHash', hash: alfa }, reason: 6, since: LO, until: LO + days * DAY });
const holdsOf = (record: IdentityDatum): Hold[] => (record.status.type === 'Suspended' ? record.status.holds : []);

interface WorldOver {
  /** The status of the record, or a function of the key hash of accountable-alfa. */
  status?: Status | ((alfa: string) => Status);
  /** The wallets of the world: the default gives `run` and `fee` 1,000 units and a pure output of 5 units. */
  wallets?: Record<string, readonly bigint[]>;
  /** False: the record is in the world and the facts hold no record fact, as for an agent that was never registered. */
  facts?: boolean;
  /** False: the record is not in the world. */
  record?: boolean;
  parties?: (alfa: string) => Party[];
}

interface HoldWorld {
  readonly w: TaskWorld;
  readonly hosted: PackHosted;
  /** The hash of the key accountable-alfa. */
  readonly alfa: string;
  /** The names of the keys that signed, in order. */
  readonly signed: string[];
  readonly answers: { suspend: HandlerAnswer | null; unsuspend: HandlerAnswer | null };
  context(): Promise<{ ctx: IdentityContext; fee: string }>;
  /** Builds the real Suspend over the world as it is, and keeps it as the answer of the tool. `controller` builds the Suspend of the controller, and `id` that of another record. */
  suspendAnswer(over?: { id?: string; days?: number; controller?: boolean }): Promise<SuspendBuild>;
  /** Builds the real Unsuspend over the world as it is, and keeps it as the answer of the tool. */
  unsuspendAnswer(): Promise<UnsuspendBuild>;
  run(...argv: string[]): Promise<number>;
  /** The arguments of a good run of the label r2. */
  args(...more: string[]): string[];
  go(): void;
  text(): string;
  errors(): string;
  record(id?: string): IdentityDatum;
  /** Replaces the record of the Order Desk by one with another status: what the chain shows when another author acted. */
  setStatus(status: Status): void;
  facts(): Readonly<Facts>;
  /** Writes the fact of a hold, as an earlier run of the pack would have. */
  putHold(fact: HoldFact): void;
}

async function world(over: WorldOver = {}): Promise<HoldWorld> {
  const w = await taskWorld({ keys: NAMES, shared: SHARED, use: USE, ...(over.wallets === undefined ? {} : { wallets: over.wallets }) });
  const registry = w.keys.registry;
  const alfa = registry.hashOf(ALFA);
  const status = typeof over.status === 'function' ? over.status(alfa) : (over.status ?? { type: 'Active' });
  const record = rootRecord({
    controller: registry.publicKeyOf('controller'), keys: [{ keyType: 'Ed25519', key: registry.publicKeyOf('order-small-supplier'), purposes: 1 + 8, pop: null }], capabilities: [utf8Hex('supplychain.order.accept.v1')],
    parties: over.parties === undefined ? [keyParty(alfa, 'Accountable', 3), MODULE1] : over.parties(alfa), status,
  });
  if (over.record !== false) w.world.chain.held.push(...REF_UTXOS, CONFIG_UTXO, recordUtxo(OD_ID, record), recordUtxo(OTHER_ID, record));
  const factsFile = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' });
  if (over.facts !== false) {
    factsFile.put('records', ['order-desk'], { did: OD_DID, id: OD_ID, tx: hashOf('record'), recordRef: `${hashOf('record')}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  const answers: HoldWorld['answers'] = { suspend: null, unsuspend: null };
  const prepared = (name: 'suspend' | 'unsuspend') => (): HandlerAnswer => {
    const answer = answers[name];
    if (answer === null) throw new Error(`the test prepared no answer for the tool ${name}`);
    return answer;
  };
  const unitOfRecord = `${DEPLOYMENT.identity.hash}${OD_ID}`;
  const recordOf = (id = OD_ID): IdentityDatum => {
    const found = w.world.chain.held.find((utxo) => utxo.address === DEPLOYMENT.identity.address && utxo.assets[`${DEPLOYMENT.identity.hash}${id}`] === 1n);
    if (typeof found?.datum !== 'string') throw new Error('the world holds no record');
    return decodeIdentityDatum(found.datum);
  };
  const resolver = (): HandlerAnswer => {
    if (w.world.chain.held.every((utxo) => utxo.assets[unitOfRecord] !== 1n)) return { text: 'Failed to resolve the DID: not found', isError: true };
    const current = recordOf();
    const holds = holdsOf(current);
    const effective = holds.some((candidate) => candidate.until > w.clock.now()) ? 'Suspended' : current.status.type;
    return { didDocumentMetadata: { vectorStatus: { status: current.status.type, effective, holds: holds.map((candidate) => ({ by: candidate.by.type, reason: String(candidate.reason), since: iso(candidate.since), until: iso(candidate.until) })) } } };
  };
  const hosted = new PackHosted({ vector_build_identity_suspend: prepared('suspend'), vector_build_identity_unsuspend: prepared('unsuspend'), vector_resolve_did: resolver });
  const signed: string[] = [];
  const readRegistry = (options: { dir: string; useCase: string; specs: readonly KeySpec[]; need: readonly string[] }): Registry => {
    const loaded = loadRegistry(options);
    const sign = loaded.ring.sign.bind(loaded.ring);
    loaded.ring.sign = (keyHash, cbor) => { signed.push(loaded.nameOfHash(keyHash) ?? keyHash); return sign(keyHash, cbor); };
    return loaded;
  };
  const context = async (): Promise<{ ctx: IdentityContext; fee: string }> => {
    await ensureSlotConfig(w.world.chain);
    const fee = registry.addressOf('fee');
    return { ctx: { lucid: await lucidForAddress(w.world.chain, fee), provider: w.world.chain, deployment: DEPLOYMENT }, fee };
  };
  return {
    w, hosted, alfa, signed, answers, context,
    suspendAnswer: async (given = {}) => {
      const { ctx, fee } = await context();
      const id = given.id ?? OD_ID;
      const actor: ActorSpec = { type: 'party', role: 'Accountable', signer: { type: 'KeyHash', hash: alfa } };
      const built = await buildSuspend(ctx, { changeAddress: fee, id, nowMs: w.clock.now(), days: given.days ?? 1, ...(given.controller === true ? {} : { actor }) });
      answers.suspend = liveBuildAnswer('Identity suspend', built, { did: `did:vector:${id}` });
      return built;
    },
    unsuspendAnswer: async () => {
      const { ctx, fee } = await context();
      const built = await buildUnsuspend(ctx, { changeAddress: fee, id: OD_ID, nowMs: w.clock.now(), author: { type: 'KeyHash', hash: alfa } });
      answers.unsuspend = liveBuildAnswer('Identity unsuspend', built, { did: OD_DID });
      return built;
    },
    run: (...argv) => runTask(hold, argv, w.deps({ hosted, readRegistry })),
    args: (...more) => ['--run', 'r2', '--agent', 'order-desk', '--by', ALFA, ...more],
    go: () => { w.writeGo({ tasks: ['hold'], capUnits: 20 }); },
    text: () => w.screen.lines.join('\n'),
    errors: () => w.screen.errors.join('\n'),
    record: recordOf,
    setStatus: (next) => {
      const current = recordOf();
      w.world.chain.held = w.world.chain.held.filter((utxo) => utxo.assets[unitOfRecord] !== 1n);
      w.world.chain.held.push(recordUtxo(OD_ID, { ...current, status: next }));
    },
    facts: () => w.facts(),
    putHold: (fact) => { factsFile.put('holds', ['r2'], fact); },
  };
}

const flags = (values: Record<string, string>): TaskFlags => ({ has: (name) => name in values, value: (name) => values[name] });
/** Nothing was signed, submitted or recorded: the tool may have been called, and the world and the facts are as they were. */
function untouched(h: HoldWorld, label = 'r2'): void {
  expect(h.signed).toEqual([]);
  expect(h.w.node.submitted).toEqual([]);
  expect(h.w.world.chain.applied).toEqual([]);
  expect(h.facts().holds[label]).toBeUndefined();
}
/** The readings that the evidence of a run holds, in order: before, during and after. */
const readings = (h: HoldWorld): string[] => h.w.evidence('hold', 'r2').flatMap((entry) => (typeof entry.shows === 'object' && entry.shows !== null && 'reading' in entry.shows ? [String(entry.shows.reading)] : []));
const calls = (h: HoldWorld, tool: string): Array<Record<string, unknown>> => h.hosted.calls.filter((call) => call.name === tool).map((call) => call.args);
/** A run of the suspend and the lift of the label r2 that lands both. */
async function suspendAndLift(h: HoldWorld): Promise<void> {
  h.go();
  await h.suspendAnswer();
  expect(await h.run(...h.args('--submit'))).toBe(0);
  await h.unsuspendAnswer();
  expect(await h.run(...h.args('--submit'))).toBe(0);
}

describe('the definition', () => {
  it('lists the three valued flags and no boolean flag, needs the approval and the chain, names the three hosted tools, and has the steps suspend and lift', () => {
    expect(hold).toMatchObject({
      name: 'hold', flags: [], valued: ['agent', 'by', 'days'],
      needs: { chain: true, hosted: ['vector_build_identity_suspend', 'vector_build_identity_unsuspend', 'vector_resolve_did'], approval: 'submit' },
    });
    expect(hold.steps(USE, flags({ run: 'r2' }))).toEqual(['suspend', 'lift']);
  });
  it('loads the fee key and the Accountable key of the organisation of the agent, and no other key', () => {
    expect(hold.needs.keys(USE, flags({ run: 'r2' }))).toEqual(['fee', ALFA]);
    expect(hold.needs.keys(USE, flags({ run: 'r2', by: ALFA, agent: 'order-desk' }))).toEqual(['fee', ALFA]);
    expect(hold.needs.keys(USE, flags({ run: 'r2', agent: 'reorder-agent' }))).toEqual(['fee', 'accountable-echo']);
  });
});

describe('the arguments', () => {
  it('refuses a --by that is not the Accountable key of the organisation of the agent: another Accountable key, a guardian key, the controller, the fee key, a key that does not exist; accountable-alfa passes', async () => {
    for (const by of ['accountable-echo', 'guardian-alfa', 'controller', 'fee', 'run', 'nobody']) {
      const h = await world();
      expect(await h.run('--run', 'r2', '--agent', 'order-desk', '--by', by), by).toBe(2);
      expect(h.errors(), by).toContain('--by must be the Accountable key of the organisation alfa of the agent order-desk, which is accountable-alfa');
      expect(h.hosted.calls, by).toEqual([]);
      untouched(h);
    }
    const ok = await world();
    await ok.suspendAnswer();
    expect(await ok.run(...ok.args())).toBe(0);
  });
  it('refuses a missing --run and a missing --by, and an agent that the use case does not list, with exit 2 and no call of the tool', async () => {
    const h = await world();
    expect(await h.run('--agent', 'order-desk', '--by', ALFA)).toBe(2);
    expect(h.errors()).toContain('hold needs --run <label>');
    expect(await h.run('--run', 'r2')).toBe(2);
    expect(h.errors()).toContain('hold needs --by <key>');
    expect(await h.run('--run', 'r2', '--agent', 'nobody', '--by', ALFA)).toBe(2);
    expect(h.errors()).toContain('--agent is one of reorder-agent, order-desk');
    expect(h.hosted.calls).toEqual([]);
    await h.suspendAnswer();
    expect(await h.run(...h.args())).toBe(0);
  });
  it('asks for the number of days that --days gives, from 1 to 30, and for one day without it; any other value is refused with exit 2 and no call of the tool', async () => {
    const h = await world();
    await h.suspendAnswer({ days: 30 });
    expect(await h.run(...h.args('--days', '30'))).toBe(0);
    expect(calls(h, 'vector_build_identity_suspend')[0]).toMatchObject({ days: 30 });
    expect(h.text()).toContain('a hold of 30 days');
    for (const days of ['0', '31', '1.5', 'x', '-1']) {
      const refused = await world();
      expect(await refused.run(...refused.args('--days', days)), days).toBe(2);
      expect(refused.errors(), days).toContain('--days');
      expect(refused.hosted.calls, days).toEqual([]);
    }
  });
});

describe('a dry run of the suspend', () => {
  it('builds the hold, shows the plan and the record, signs and submits nothing, writes no fact, and calls the tool with the Accountable key as the actor and no reason', async () => {
    const h = await world();
    await h.suspendAnswer();
    expect(await h.run(...h.args())).toBe(0);
    expect(calls(h, 'vector_build_identity_suspend')).toEqual([{ changeAddress: h.w.keys.registry.addressOf('fee'), did: OD_DID, actor: { role: 'Accountable', signer: h.alfa }, days: 1 }]);
    expect(h.text()).toContain(`hold: the agent order-desk (${OD_DID}) gets a hold of 1 day from the Accountable key accountable-alfa of the organisation alfa`);
    expect(h.text()).toContain('the record before: effective status Active; no hold');
    expect(h.text()).toContain('step suspend: dry mode, nothing is signed or submitted');
    expect(h.text()).toContain(`signers: accountable-alfa key ${h.alfa}, fee key ${h.w.keys.registry.hashOf('fee')}`);
    expect(h.text()).toContain('dry run: nothing was signed or submitted');
    untouched(h);
    expect(h.w.state('hold', 'r2')).toMatchObject({ steps: {}, in_flight: null });
    expect(h.w.evidence('hold', 'r2')).toEqual([]);
    expect(calls(h, 'vector_resolve_did')).toEqual([]);
    expect(h.w.machine()).toMatchObject({ task: 'hold', command: 'run', mode: 'dry', outcome: 'dry', exit: 0, step: 'suspend' });
  });
  it('says that the record is held by another author already, and goes on: a hold of this pack adds to it', async () => {
    const h = await world({ status: suspended(module1Hold()) });
    await h.suspendAnswer();
    expect(await h.run(...h.args())).toBe(0);
    expect(h.text()).toContain(`the record before: effective status Suspended; a hold by Module-1 (${M1}) (reason 64) until ${iso(NOW + 6 * DAY)}`);
    expect(h.text()).toContain('the record is held by another author already: a hold of this pack adds to it');
  });
});

describe('the suspend and the lift', () => {
  it('lands the hold with the signers by and fee, shows the status before, during and after, and records the hold in the facts; the lift removes the hold of that author and lands with the same signers', async () => {
    const h = await world();
    h.go();
    const built = await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect([...h.signed].sort()).toEqual([ALFA, 'fee']);
    expect(h.w.node.submitted).toHaveLength(1);
    expect(h.record().status).toEqual(suspended(alfaHold(h.alfa)));
    const txHash = h.w.world.chain.applied.map((tx) => h.w.world.hashOf(tx))[0]!;
    expect(h.facts().holds.r2).toEqual({ suspendTx: txHash, liftTx: null });
    const step = h.w.state('hold', 'r2').steps.suspend!;
    expect(step).toMatchObject({ tx_hash: txHash, verified_at: expect.any(String), facts: { agent: 'order-desk', did: OD_DID, by: ALFA, author: h.alfa, days: 1 } });
    expect(step.refs.recordBefore).toMatch(/^[0-9a-f]{64}#0$/);
    expect(step.refs.recordAfter).toBe(`${txHash}#${built.recordOutputIndex}`);
    expect(h.text()).toContain(`the node shows the hold by the key accountable-alfa until ${iso(LO + DAY)}; effective status Suspended`);
    expect(readings(h)).toEqual(['before', 'during']);
    expect(h.w.evidence('hold', 'r2').at(-1)).toMatchObject({
      status: 'info', shows: { reading: 'during', node: { effective: 'Suspended', holds: [{ by: 'the key accountable-alfa', reason: 6, until: iso(LO + DAY), inForce: true }] }, resolver: { read: 'ok', effective: 'Suspended' } },
    });
    expect(h.w.machine()).toMatchObject({ outcome: 'done', exit: 0, step: 'suspend' });
    expect(h.w.machine().result).toMatchObject({ run: 'r2', agent: 'order-desk', did: OD_DID, by: ALFA, suspendTx: txHash, liftTx: null, effective: 'Suspended' });

    await h.unsuspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(calls(h, 'vector_build_identity_unsuspend')).toEqual([{ changeAddress: h.w.keys.registry.addressOf('fee'), did: OD_DID, author: h.alfa }]);
    expect(h.record().status).toEqual({ type: 'Active' });
    const liftTx = h.w.world.chain.applied.map((tx) => h.w.world.hashOf(tx))[1]!;
    expect(h.facts().holds.r2).toEqual({ suspendTx: txHash, liftTx });
    expect(h.text()).toContain('the node shows no hold by the key accountable-alfa; effective status Active');
    expect(readings(h)).toEqual(['before', 'during', 'after']);
    expect(h.w.machine()).toMatchObject({ step: 'lift' });
    expect(h.w.machine().result).toMatchObject({ suspendTx: txHash, liftTx, effective: 'Active' });
    expect([...h.signed].sort()).toEqual([ALFA, ALFA, 'fee', 'fee']);

    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(h.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(h.w.node.submitted).toHaveLength(2);
  });
  it('keeps the hold of another author: the lift removes the hold of the Accountable key only, the record stays Suspended, and the message says that a Module-1 hold stays', async () => {
    const h = await world({ status: suspended(module1Hold()) });
    await suspendAndLift(h);
    expect(h.record().status).toEqual(suspended(module1Hold()));
    expect(h.text()).toContain(`the record stays Suspended: a hold of another author stays (Module-1 (${M1}) until ${iso(NOW + 6 * DAY)})`);
    expect(h.facts().holds.r2?.liftTx).toMatch(/^[0-9a-f]{64}$/);
    const during = await world({ status: suspended(module1Hold()) });
    during.go();
    await during.suspendAnswer();
    await during.run(...during.args('--submit'));
    expect(holdsOf(during.record())).toEqual([module1Hold(), alfaHold(during.alfa)]);
  });
  it('documents why the lift names the author: the captured schema refuses an actor for the Unsuspend, and the real Unsuspend with no author leaves the hold of the Accountable key in place', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    const bad = await h.hosted.call('vector_build_identity_unsuspend', { changeAddress: h.w.keys.registry.addressOf('fee'), did: OD_DID, actor: { role: 'Accountable', signer: h.alfa } }).then(() => null, (e: unknown) => e);
    expect(bad).toBeInstanceOf(HostedError);
    expect(bad).toMatchObject({ kind: 'bad_arguments', message: expect.stringContaining('has no argument actor') });
    const { ctx, fee } = await h.context();
    await expect(buildUnsuspend(ctx, { changeAddress: fee, id: OD_ID, nowMs: h.w.clock.now() })).rejects.toThrow(/has no hold by the controller/);
    expect(holdsOf(h.record())).toEqual([alfaHold(h.alfa)]);
  });
});

describe('the preconditions of the suspend', () => {
  /** A world and a run that the precondition refuses: exit 2, the tool is not asked to build, and nothing is signed or recorded. */
  async function refused(over: WorldOver, message: string): Promise<void> {
    const h = await world(over);
    await h.suspendAnswer().catch(() => undefined);
    expect(await h.run(...h.args()), message).toBe(2);
    expect(h.errors(), message).toContain(message);
    expect(calls(h, 'vector_build_identity_suspend'), message).toEqual([]);
    untouched(h);
  }

  it('refuses an agent whose record the facts do not hold, a record that the registry does not hold, and a record that is not Active', async () => {
    await refused({ facts: false }, 'the facts hold no record of the agent order-desk');
    await refused({ record: false }, 'the record of the agent order-desk is not in the identity registry');
    await refused({ status: { type: 'Revoked', by: { type: 'ControllerSet' }, reason: 1, at: NOW - DAY, invalidFrom: null, successor: null } }, 'the record of the agent order-desk is Revoked');
  });
  it('refuses a record that holds a hold of this author already, and a record that is Suspended with no hold in force', async () => {
    await refused({ status: (alfa) => suspended(alfaHold(alfa)) }, `the record already holds a hold of the key ${ALFA}`);
    await refused({ parties: (alfa) => [keyParty(alfa, 'Accountable', 3, { notAfter: NOW - DAY }), MODULE1] }, 'the record is Suspended and holds no hold in force');
  });
  it('refuses a fee wallet with no pure output of 5 units or more, and a label that the facts hold already; the same world with the output and a new label passes', async () => {
    await refused({ wallets: { run: [1_000_000_000n, 5_000_000n], fee: [3_000_000n, 2_000_000n] } }, 'has no pure output of 5 units or more');
    const h = await world();
    h.putHold({ suspendTx: hashOf('earlier'), liftTx: null });
    await h.suspendAnswer();
    expect(await h.run(...h.args())).toBe(2);
    expect(h.errors()).toContain('the facts hold a hold of the run r2 already');
    expect(calls(h, 'vector_build_identity_suspend')).toEqual([]);
    expect(await h.run(...h.args().map((word) => (word === 'r2' ? 'r3' : word)))).toBe(0);
  });
  it('refuses --submit with no approval file and with an approval that does not list the task, and signs nothing; the approval that lists it lands the hold', async () => {
    const none = await world();
    await none.suspendAnswer();
    expect(await none.run(...none.args('--submit'))).toBe(2);
    untouched(none);
    const other = await world();
    await other.suspendAnswer();
    other.w.writeGo({ tasks: ['toy'], capUnits: 20 });
    expect(await other.run(...other.args('--submit'))).toBe(2);
    untouched(other);
    other.go();
    expect(await other.run(...other.args('--submit'))).toBe(0);
  });
});

describe('what the signers and the plan refuse', () => {
  async function refusedSubmit(h: HoldWorld, guard: string, text: string): Promise<void> {
    h.go();
    expect(await h.run(...h.args('--submit'))).toBe(2);
    expect(h.errors()).toContain(`is refused by ${guard}`);
    expect(h.errors()).toContain(text);
    untouched(h);
    expect(h.w.state('hold', 'r2')).toMatchObject({ steps: {}, in_flight: null });
  }

  it('refuses a Suspend that the controller signs, because the signers are not by and fee, and signs nothing; the Suspend of the Accountable key lands', async () => {
    const h = await world();
    await h.suspendAnswer({ controller: true });
    await refusedSubmit(h, 'signers', 'missing accountable-alfa');
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
  });
  it('refuses a transaction that spends another record than the one of the agent, because the plan explains the record that it read and no other input; the Suspend of that record lands', async () => {
    const h = await world();
    await h.suspendAnswer({ id: OTHER_ID });
    await refusedSubmit(h, 'inputs', 'is not explained by the state file');
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
  });
  it('refuses a transaction whose change goes to an address outside the keys and the identity script: the guard destinations stops the dry run, and the cap stops the run with --submit; the twin that keeps the change lands', async () => {
    const h = await world();
    const built = await h.suspendAnswer();
    const cbor = built.txCbor.split(`581d61${h.w.keys.registry.hashOf('fee')}`).join(`581d61${'ee'.repeat(28)}`);
    expect(cbor).not.toBe(built.txCbor);
    h.answers.suspend = liveBuildAnswer('Identity suspend', { ...built, txCbor: cbor, txHash: factsOf(cbor).txHash }, { did: OD_DID });
    expect(await h.run(...h.args())).toBe(2);
    expect(h.errors()).toContain('is refused by destinations');
    expect(h.errors()).toContain('which is no wallet of the keys and no address of the step');
    untouched(h);
    h.go();
    expect(await h.run(...h.args('--submit'))).toBe(2);
    expect(h.errors()).toContain('over the cap of 20.000000 units');
    untouched(h);
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
  });
});

describe('the lift', () => {
  it('refuses a lift for a hold that the facts do not hold, and builds nothing; with the fact it lands', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    const before = h.facts();
    rmSync(join(h.w.stateDir, 'facts.json'));
    FactsFile.open(join(h.w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' })
      .put('records', ['order-desk'], { did: OD_DID, id: OD_ID, tx: hashOf('record'), recordRef: `${hashOf('record')}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
    await h.unsuspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(2);
    expect(h.errors()).toContain('the facts hold no hold of the run r2 that this pack made');
    expect(calls(h, 'vector_build_identity_unsuspend')).toEqual([]);
    expect(h.w.node.submitted).toHaveLength(1);
    expect(holdsOf(h.record())).toEqual([alfaHold(h.alfa)]);
    h.putHold(before.holds.r2!);
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(h.record().status).toEqual({ type: 'Active' });
  });
  it('refuses a lift when the record holds no hold of the author any more, and builds nothing', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    h.setStatus({ type: 'Active' });
    expect(await h.run(...h.args('--submit'))).toBe(2);
    expect(h.errors()).toContain(`the record holds no hold of the key ${ALFA}`);
    expect(calls(h, 'vector_build_identity_unsuspend')).toEqual([]);
    expect(h.facts().holds.r2?.liftTx).toBeNull();
  });
});

describe('the cleanup', () => {
  const cleanup = (h: HoldWorld, ...more: string[]): Promise<number> => h.run('cleanup', ...h.args(...more));

  it('takes back nothing when the facts hold no hold of the run, also when the record holds a hold of the same key that this pack did not make', async () => {
    const empty = await world();
    empty.go();
    expect(await cleanup(empty, '--submit')).toBe(0);
    expect(empty.text()).toContain('no hold of this pack is on for the run r2: there is nothing to take back');
    expect(empty.hosted.calls).toEqual([]);
    untouched(empty);
    const foreign = await world({ status: (alfa) => suspended(alfaHold(alfa)) });
    foreign.go();
    await foreign.unsuspendAnswer();
    expect(await cleanup(foreign, '--submit')).toBe(0);
    expect(foreign.hosted.calls).toEqual([]);
    expect(holdsOf(foreign.record())).toEqual([alfaHold(foreign.alfa)]);
    untouched(foreign);
  });
  it('lifts the hold that the facts hold without a lift, records the lift as the step lift, and leaves nothing for the next run; a dry run builds and shows the lift and changes nothing', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    await h.unsuspendAnswer();
    expect(await cleanup(h)).toBe(0);
    expect(h.text()).toContain('step lift: dry mode, nothing is signed or submitted');
    expect(h.w.node.submitted).toHaveLength(1);
    expect(h.facts().holds.r2?.liftTx).toBeNull();
    expect(await cleanup(h, '--submit')).toBe(0);
    expect(h.record().status).toEqual({ type: 'Active' });
    expect(h.facts().holds.r2?.liftTx).toMatch(/^[0-9a-f]{64}$/);
    expect(h.w.state('hold', 'r2').steps.lift).toMatchObject({ verified_at: expect.any(String) });
    expect(h.w.machine()).toMatchObject({ command: 'cleanup', outcome: 'done', exit: 0, step: 'lift' });
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(h.w.machine()).toMatchObject({ outcome: 'finished' });
    expect(await cleanup(h, '--submit')).toBe(0);
    expect(h.text()).toContain('no hold of this pack is on for the run r2');
    expect(h.w.node.submitted).toHaveLength(2);
  });
  it('refuses a cleanup whose agent or key is not the one that the suspend of the run recorded, and builds nothing', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    await h.unsuspendAnswer();
    expect(await h.run('cleanup', '--run', 'r2', '--agent', 'reorder-agent', '--by', 'accountable-echo', '--submit')).toBe(2);
    expect(h.errors()).toContain('the suspend of the run r2 was made for the agent order-desk');
    expect(calls(h, 'vector_build_identity_unsuspend')).toEqual([]);
    expect(await cleanup(h, '--submit')).toBe(0);
  });
  it('refuses a cleanup when the state holds the lift already and the facts hold none, and builds nothing', async () => {
    const h = await world();
    await suspendAndLift(h);
    const suspendTx = h.facts().holds.r2!.suspendTx;
    rmSync(join(h.w.stateDir, 'facts.json'));
    FactsFile.open(join(h.w.stateDir, 'facts.json'), { useCase: USE_CASE, network: 'vector-mainnet' })
      .put('records', ['order-desk'], { did: OD_DID, id: OD_ID, tx: hashOf('record'), recordRef: `${hashOf('record')}#0`, depositLovelace: '10000000', registeredAt: iso(NOW) });
    h.putHold({ suspendTx, liftTx: null });
    expect(await cleanup(h, '--submit')).toBe(2);
    expect(h.errors()).toContain('holds the lift already');
    expect(calls(h, 'vector_build_identity_unsuspend')).toHaveLength(1);
    expect(h.w.node.submitted).toHaveLength(2);
  });
});

describe('the verification', () => {
  it('goes on when the resolver does not answer, and says so in the evidence: the read of the node decides', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    h.hosted.handlers.vector_resolve_did = () => ({ text: 'Failed to resolve the DID: the gateway is down', isError: true });
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(h.w.evidence('hold', 'r2').at(-1)).toMatchObject({ shows: { reading: 'during', resolver: { read: 'failed', message: 'Failed to resolve the DID: the gateway is down' } } });
  });
  it('fails with exit 1 when the node does not show the hold within the window, keeps the step unverified and the hold in the facts, and verifies it again at the next run', async () => {
    const h = await world();
    h.go();
    await h.suspendAnswer();
    const submit = h.w.node.submit.bind(h.w.node);
    h.w.node.submit = async (cbor) => { h.w.node.submitted.push(cbor); return 'ab'.repeat(32); };
    h.w.node.script.push({ confirmations: 1 });
    expect(await h.run(...h.args('--submit'))).toBe(1);
    expect(h.errors()).toContain('the node does not show the hold');
    expect(h.w.state('hold', 'r2').steps.suspend).toMatchObject({ verified_at: null });
    expect(h.facts().holds.r2).toMatchObject({ liftTx: null });
    expect(h.w.evidence('hold', 'r2').at(-1)).toMatchObject({ shows: { reading: 'during', ok: false } });
    h.w.node.submit = submit;
    h.w.world.chain.apply(h.w.node.submitted[0]!);
    await h.unsuspendAnswer();
    expect(await h.run(...h.args('--submit'))).toBe(0);
    expect(h.w.state('hold', 'r2').steps.suspend).toMatchObject({ verified_at: expect.any(String) });
    expect(h.record().status).toEqual({ type: 'Active' });
  });
});

describe('the status', () => {
  it('shows the facts of the hold of the run and the record as the node shows it, with the name of the Accountable key', async () => {
    const h = await world();
    expect(await h.run('status', '--run', 'r2')).toBe(0);
    expect(h.text()).toContain('no hold of this pack is on for the run r2');
    expect(h.text()).toContain(`the record of the agent order-desk (${OD_DID}): effective status Active; no hold`);
    h.w.screen.lines.length = 0;
    h.go();
    await h.suspendAnswer();
    await h.run(...h.args('--submit'));
    h.w.screen.lines.length = 0;
    expect(await h.run('status', '--run', 'r2')).toBe(0);
    const suspendTx = h.facts().holds.r2!.suspendTx!;
    expect(h.text()).toContain(`hold of the run r2: suspend ${suspendTx}, lift not done`);
    expect(h.text()).toContain(`effective status Suspended; a hold by the key accountable-alfa (reason 6) until ${iso(LO + DAY)}`);
  });
});
