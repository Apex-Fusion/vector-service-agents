// The task `stake`: the Module-3 stake of each agent of use case 1 (inventory reorder), owned by its service key. A fake tool writes the bytes of the opening and of the stake over the identity fixtures and answers in
// the format of the live tools, so the real guards judge real bytes. The task runs through the real runner. Each refusal has an accepted twin. No test opens a connection.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { factsOf } from '../../checks/lib/txfacts.ts';
import { keyOf } from '../../checks/test/support/world.ts';
import { RECORDED_STAKE, RECORDED_STAKE_HEX, RECORDED_STAKE_ROW } from '../../../agents/agent-history/test/support.ts';
import { REPUTATION_ADDRESS as READ_ADDRESS, REPUTATION_SCRIPT_HASH, decodeStakeDatum, stakeTokenName } from '../../../packages/vector-read/src/index.ts';
import stake, { OPENING_LOVELACE, REPUTATION_ADDRESS, REPUTATION_POLICY, stakeTokenUnit } from '../tasks/stake.ts';
import type { Registry } from '../lib/registry.ts';
import { ORDER_DESK, REORDER, USE, stakeAdvertWorld } from './support/stake-advert-builds.ts';
import type { Fixture, Twist } from './support/stake-advert-builds.ts';
import { NOW } from './support/task-world.ts';

const OPEN = 'vector_build_reputation_stake_open';
const CREATE = 'vector_build_reputation_stake';
const READ = 'vector_get_reputation_stake';
const OUTSIDE = keyOf(77).address;
const BUILD_TOOLS = [OPEN, CREATE];
const NO_FLAGS = { has: () => false, value: () => undefined };

// ---- what a test reads ----

const errors = (f: Fixture): string => f.w.screen.errors.join('\n');
const outputsAt = (f: Fixture, address: string) => f.world.chain.held.filter((utxo) => utxo.address === address);
const unitOf = (f: Fixture, agent: typeof REORDER): string => stakeTokenUnit(f.idOf(agent));
/** The guards that a refusal names: the text of a GuardRefusal says `is refused by` and the names of the guards. */
const refusedBy = (text: string): string[] => /is refused by ([a-z_, ]+):/.exec(text)?.[1]?.split(', ') ?? [];
/** Nothing was signed or submitted, and nothing is in flight or recorded. */
function nothingSigned(f: Fixture): void {
  expect(f.signs).toEqual([]);
  expect(f.world.chain.applied).toEqual([]);
  expect(f.w.state('stake').in_flight).toBeNull();
  expect(Object.keys(f.w.state('stake').notes)).toEqual([]);
}
/** Nothing was built, signed or submitted. */
function nothingBuilt(f: Fixture): void {
  expect(f.hosted.calls.filter((call) => BUILD_TOOLS.includes(call.name))).toEqual([]);
  nothingSigned(f);
}
/** The run with --submit of the next step: it must end with exit 0. */
async function land(f: Fixture, ...more: string[]): Promise<void> {
  expect(await f.run(stake, '--submit', ...more)).toBe(0);
}
/** The run with --submit that a precondition stops: exit 2, the text of the refusal holds `reason`, and the tool was not called. */
async function stops(f: Fixture, reason: string): Promise<void> {
  expect(await f.run(stake, '--submit')).toBe(2);
  expect(errors(f)).toContain(reason);
  expect(f.w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
  expect(f.hosted.calls.filter((call) => BUILD_TOOLS.includes(call.name))).toEqual([]);
}

// ---- the constants of the reputation validator ----

describe('the constants of the reputation validator', () => {
  const recorded = RECORDED_STAKE_ROW.asset_list![0]!;
  it('equal the stake that the chain holds: the address, the policy and the token of the recorded stake output, and the datum that it carries', () => {
    expect(REPUTATION_ADDRESS).toBe(RECORDED_STAKE_ROW.address);
    expect(REPUTATION_POLICY).toBe(recorded.policy_id);
    expect(stakeTokenUnit(RECORDED_STAKE.agent_did)).toBe(`${recorded.policy_id}${recorded.asset_name}`);
    expect(decodeStakeDatum(RECORDED_STAKE_HEX)).toStrictEqual(RECORDED_STAKE);
    expect(`${RECORDED_STAKE_ROW.tx_hash}#${RECORDED_STAKE_ROW.tx_index}`).toMatch(/^48d4ce7b[0-9a-f]{56}#0$/);
    expect(RECORDED_STAKE_ROW.inline_datum!.bytes).toBe(RECORDED_STAKE_HEX);
  });
  it('equal the values of vector-read, which the fake tools use', () => {
    expect(REPUTATION_ADDRESS).toBe(READ_ADDRESS);
    expect(REPUTATION_POLICY).toBe(REPUTATION_SCRIPT_HASH);
    expect(stakeTokenUnit(RECORDED_STAKE.agent_did)).toBe(`${REPUTATION_SCRIPT_HASH}${stakeTokenName(RECORDED_STAKE.agent_did)}`);
  });
  it('derive the token name from the AGENT identifier, never from the stake identifier', () => {
    expect(stakeTokenUnit(RECORDED_STAKE.stake_id.txHash)).not.toBe(`${recorded.policy_id}${recorded.asset_name}`);
  });
  it('refuse an identifier that is not 64 lower-case hex characters, and take one that is', () => {
    for (const bad of ['', 'ab', 'AB'.repeat(32), 'zz'.repeat(32), 'ab'.repeat(33)]) expect(() => stakeTokenUnit(bad)).toThrow(/32 bytes/);
    expect(stakeTokenUnit('ab'.repeat(32))).toMatch(/^[0-9a-f]{56}7273746b5f[0-9a-f]{54}$/);
  });
  it('hold the stake of the data: 10 units for each agent, and an opening that locks 2 units', () => {
    expect(USE.agents.map((agent) => agent.stakeLovelace)).toEqual([10_000_000n, 10_000_000n]);
    expect(OPENING_LOVELACE).toBe(2_000_000n);
  });
});

// ---- the dry run ----

describe('stake: the dry run', () => {
  it('builds the opening of the first agent, shows it, and signs, submits and writes nothing', async () => {
    const f = await stakeAdvertWorld({ go: null });
    expect(await f.run(stake)).toBe(0);
    expect(f.w.machine()).toMatchObject({ task: 'stake', command: 'run', mode: 'dry', outcome: 'dry', exit: 0, step: 'reorder-agent:open' });
    expect(f.w.machine().result).toMatchObject({ agent: 'reorder-agent', step: 'open', did: f.didOf(REORDER), amount_lovelace: '10000000' });
    expect(f.hosted.calls).toEqual([{
      name: OPEN, args: { changeAddress: f.w.keys.registry.addressOf('reorder-service'), did: f.didOf(REORDER), capabilities: [REORDER.capability], owner_key_hash: f.hash('reorder-service'), amount: 10 },
    }]);
    const lines = f.w.screen.lines;
    for (const line of ['stake of reorder-agent (Reorder Agent): step open', `DID: ${f.didOf(REORDER)}`, `owner of the stake: the service key reorder-service ${f.hash('reorder-service')}`]) expect(lines, line).toContain(line);
    expect(lines.some((line) => line.startsWith('the opening output locks at least 2.000000 units at the reputation address'))).toBe(true);
    expect(lines.some((line) => /destinations\s+\d+ output\(s\), each to a wallet of the keys or to an address of the step/.test(line))).toBe(true);
    nothingSigned(f);
    expect(f.w.facts().stakes).toEqual({});
    expect(f.w.evidence('stake')).toEqual([]);
    expect(f.w.exposure()).toEqual([]);
  });
  it('shows the stake of an agent whose opening is on the node, and asks the tool with the reference of the opening', async () => {
    const f = await stakeAdvertWorld({ go: null });
    const ref = f.seedOpening(REORDER);
    expect(await f.run(stake)).toBe(0);
    expect(f.hosted.calls.map((call) => call.name)).toEqual([CREATE]);
    expect(f.hosted.calls[0]!.args).toMatchObject({ opening_ref: ref, owner_key_hash: f.hash('reorder-service'), amount: 10 });
    expect(f.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', step: 'reorder-agent:create' });
    expect(f.w.machine().result).toMatchObject({ agent: 'reorder-agent', step: 'create', opening_ref: ref, token_unit: unitOf(f, REORDER), amount_lovelace: '10000000' });
    expect(f.w.screen.lines.some((line) => line.includes('The minimum of a stake never returns to its owner'))).toBe(true);
    expect(f.signs).toEqual([]);
    expect(f.world.chain.applied).toEqual([]);
  });
});

// ---- open ----

describe('stake: the step open', () => {
  it('lands with the service key as its one signer, records the step, and writes the fact of the opening that the bytes made', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    expect(f.signs).toEqual([f.hash('reorder-service')]);
    const bytes = factsOf(f.world.chain.applied[0]!);
    const index = bytes.outputs.findIndex((output) => output.address === REPUTATION_ADDRESS);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(bytes.mint).toEqual({});
    expect(bytes.runsScripts).toBe(false);
    const ref = `${bytes.txHash}#${index}`;
    expect(f.w.facts().stakes).toEqual({ 'reorder-agent': { openingRef: ref, stakeRef: null, tokenUnit: null, amountLovelace: '10000000' } });
    const note = f.w.state('stake').notes['part.reorder-agent:open'] as { tx_hash: string; refs: Record<string, string> };
    expect(note.tx_hash).toBe(bytes.txHash);
    expect(note.refs).toEqual({ openingRef: ref });
    expect(outputsAt(f, REPUTATION_ADDRESS).map((utxo) => `${utxo.txHash}#${utxo.outputIndex}`)).toEqual([ref]);
    expect(f.w.machine()).toMatchObject({ mode: 'submit', outcome: 'done', exit: 0, step: 'reorder-agent:open' });
    expect(f.w.machine().result).toMatchObject({ agent: 'reorder-agent', step: 'open', did: f.didOf(REORDER), opening_ref: ref, tx: bytes.txHash, amount_lovelace: '10000000' });
    expect(f.w.evidence('stake').map((entry) => entry.status)).toEqual(['confirmed']);
  });
  it('needs no tag in the approval: the tag stake is for create', async () => {
    const f = await stakeAdvertWorld({ go: { irreversible: [] } });
    await land(f);
    expect(f.w.facts().stakes['reorder-agent']).toBeDefined();
  });
  it('reads the reference of the opening from the bytes, and never from the answer of the tool', async () => {
    const f = await stakeAdvertWorld();
    const claimed = `${'12'.repeat(32)}#7`;
    f.hosted.twist.open = { claimRef: claimed };
    await land(f);
    const bytes = factsOf(f.world.chain.applied[0]!);
    const held = f.w.facts().stakes['reorder-agent']!.openingRef;
    expect(held).not.toBe(claimed);
    expect(held).toBe(`${bytes.txHash}#${bytes.outputs.findIndex((output) => output.address === REPUTATION_ADDRESS)}`);
  });
  it('refuses a second opening of an agent whose opening the facts file holds: exit 2 and no build', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.calls.length = 0;
    // A new run label has a state file of its own, so only the facts file tells that the opening is made.
    expect(await f.run(stake, '--submit', '--run', 'again')).toBe(2);
    expect(errors(f)).toContain('the facts file holds the opening');
    expect(f.hosted.calls).toEqual([]);
    expect(f.world.chain.applied).toHaveLength(1);
  });
});

// ---- create ----

describe('stake: the step create', () => {
  it('lands with the controller and the service key as its signers and the stake token as its mint, spends the opening, verifies the stake with the read tool, and sets the two fields once', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    const opening = f.w.facts().stakes['reorder-agent']!.openingRef;
    const before = f.signs.length;
    await land(f);
    expect([...f.signs.slice(before)].sort()).toEqual([f.hash('controller'), f.hash('reorder-service')].sort());
    const bytes = factsOf(f.world.chain.applied[1]!);
    const unit = unitOf(f, REORDER);
    expect(bytes.mint).toEqual({ [unit]: 1n });
    expect(bytes.runsScripts).toBe(true);
    expect(bytes.inputs).toContain(opening);
    const index = bytes.outputs.findIndex((output) => output.address === REPUTATION_ADDRESS);
    expect(bytes.outputs[index]!.assets).toEqual({ [unit]: 1n });
    expect(bytes.outputs[index]!.lovelace).toBe(10_000_000n);
    expect(f.world.chain.find(opening)).toBeUndefined();
    expect(f.w.facts().stakes['reorder-agent']).toEqual({ openingRef: opening, stakeRef: `${bytes.txHash}#${index}`, tokenUnit: unit, amountLovelace: '10000000' });
    expect(f.hosted.calls.at(-1)).toEqual({ name: READ, args: { dids: [f.didOf(REORDER)] } });
    expect(f.w.evidence('stake').map((entry) => `${String(entry.step)}:${String(entry.status)}`)).toEqual(['reorder-agent:open:confirmed', 'reorder-agent:create:confirmed', 'reorder-agent:create:verified']);
    expect(f.w.machine()).toMatchObject({ outcome: 'done', step: 'reorder-agent:create' });
    expect(f.w.machine().result).toMatchObject({ agent: 'reorder-agent', step: 'create', token_unit: unit, opening_ref: opening });
    expect(f.w.state('stake').notes['part.reorder-agent:create']).toMatchObject({ verified_at: expect.any(String) });
  });
  it('runs the four steps in order with --all, and finishes: both agents hold a stake that is verified', async () => {
    const f = await stakeAdvertWorld();
    await land(f, '--all');
    expect(f.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    const facts = f.w.facts().stakes;
    for (const agent of [REORDER, ORDER_DESK]) expect(facts[agent.id]).toMatchObject({ stakeRef: expect.stringMatching(/^[0-9a-f]{64}#0$/), tokenUnit: unitOf(f, agent), amountLovelace: '10000000' });
    expect(Object.keys(f.w.state('stake').notes).sort()).toEqual(['part.order-desk:create', 'part.order-desk:open', 'part.reorder-agent:create', 'part.reorder-agent:open']);
    expect(outputsAt(f, REPUTATION_ADDRESS)).toHaveLength(2);
    expect(f.signs).toHaveLength(6);
  });
  it('refuses create when the approval lacks the tag stake: exit 2, the tool is not called and nothing is signed. The twin with the tag lands', async () => {
    const f = await stakeAdvertWorld({ go: { irreversible: [] } });
    await land(f);
    const signed = f.signs.length;
    f.hosted.calls.length = 0;
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toContain('the approval does not list the irreversible tag stake');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signs).toHaveLength(signed);
    expect(f.world.chain.applied).toHaveLength(1);
    f.w.writeGo({ tasks: ['stake'], irreversible: ['stake'], capUnits: 200 });
    await land(f);
    expect(f.world.chain.applied).toHaveLength(2);
  });
  it('waits (exit 4) while the node does not show the opening, builds nothing, and lands once the node shows it', async () => {
    const f = await stakeAdvertWorld();
    const ref = f.seedOpening(REORDER, { onNode: false });
    expect(await f.run(stake, '--submit')).toBe(4);
    expect(f.w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'reorder-agent:create' });
    expect(f.w.screen.lines.some((line) => line.startsWith(`WAIT: the opening output ${ref} of reorder-agent is not on the node yet`))).toBe(true);
    expect(f.hosted.calls).toEqual([]);
    expect(f.signs).toEqual([]);
    expect(f.world.chain.applied).toEqual([]);
    f.seedOpening(REORDER, { fact: false, step: false });
    await land(f);
    expect(f.world.chain.applied).toHaveLength(1);
    expect(f.w.facts().stakes['reorder-agent']!.tokenUnit).toBe(unitOf(f, REORDER));
  });
  it('refuses a create when the node shows an output that is no opening of the agent: exit 2 and no build', async () => {
    const f = await stakeAdvertWorld();
    // The facts file of the Reorder Agent holds a reference that the node shows with the datum of another agent.
    const other = f.seedOpening(ORDER_DESK, { fact: false, step: false });
    const own = f.seedOpening(REORDER, { onNode: false });
    f.world.chain.held.push({ ...f.world.chain.find(other)!, txHash: own.slice(0, 64) });
    await stops(f, 'is no opening output of reorder-agent: the datum names another agent');
  });
});

// ---- the record ----

describe('stake: the record of the agent', () => {
  const serviceKey = (purposes: number) => (agent: typeof REORDER, keys: Registry) => ({
    keys: [{ keyType: 'Ed25519' as const, key: keys.publicKeyOf(agent.serviceKey), purposes, pop: null }],
  });
  it('stops, and builds nothing, for a record that the facts file does not hold', async () => {
    await stops(await stakeAdvertWorld({ facts: false }), 'the facts file holds no record of reorder-agent');
  });
  it('stops for a service key that the record lists with another purpose than the transaction purpose. The twin lists it with that purpose and lands', async () => {
    await stops(await stakeAdvertWorld({ record: serviceKey(1) }), 'does not list the service key reorder-service with the transaction purpose');
    await land(await stakeAdvertWorld({ record: serviceKey(1 + 8) }));
  });
  it('stops for a service key that the record does not list at all', async () => {
    await stops(await stakeAdvertWorld({ record: () => ({ keys: [] }) }), 'does not list the service key reorder-service with the transaction purpose');
  });
  it('stops for a record that does not list the capability, byte for byte', async () => {
    await stops(await stakeAdvertWorld({ record: () => ({ capabilities: [] }) }), 'does not list the capability supplychain.reorder.po.v1, byte for byte');
  });
  it('stops for a record that is not Active', async () => {
    await stops(await stakeAdvertWorld({ record: () => ({ status: { type: 'Retired', at: NOW - 86_400_000, successor: null } }) }), 'is Retired: it must be Active');
  });
  it('stops for a record that another controller controls', async () => {
    await stops(await stakeAdvertWorld({ record: () => ({ controller: keyOf(77).publicKeyHex }) }), 'is not the controller key of the registry');
  });
  it('stops for a record that the node does not show', async () => {
    const f = await stakeAdvertWorld();
    f.world.chain.held = f.world.chain.held.filter((utxo) => !Object.keys(utxo.assets).some((unit) => unit.endsWith(f.idOf(REORDER))));
    await stops(f, 'is not on the node');
  });
});

// ---- the wallet and the runtimes ----

describe('stake: a stake that the node or the facts file holds', () => {
  it('stops open and create when the reputation address holds a stake of the agent and the facts file holds none, and builds nothing. The twin with the stake of another agent lands', async () => {
    const f = await stakeAdvertWorld();
    const ref = f.seedStake(REORDER);
    await stops(f, `the reputation address holds the stake of reorder-agent already (${ref})`);
    f.seedOpening(REORDER);
    await stops(f, `the reputation address holds the stake of reorder-agent already (${ref})`);
    const other = await stakeAdvertWorld();
    other.seedStake(ORDER_DESK);
    await land(other);
    expect(other.w.facts().stakes['reorder-agent']).toBeDefined();
  });
  it('stops a create when the facts file holds the stake already: exit 2 and no build', async () => {
    const f = await stakeAdvertWorld();
    f.seedOpening(REORDER);
    f.facts.put('stakes', ['reorder-agent', 'stakeRef'], `${'ab'.repeat(32)}#0`);
    await stops(f, 'the facts file holds the stake');
  });
});

describe('stake: the wallet and the runtimes of the agent', () => {
  it('stops for a service wallet with no pure output of 5 units or more, and builds nothing', async () => {
    await stops(await stakeAdvertWorld({ wallets: { 'reorder-service': [3_000_000n, 2_000_000n] } }), 'has no pure output of 5 units or more');
  });
  it('stops while a runtime that runs says working, and asks it. The twin where it says free lands', async () => {
    const f = await stakeAdvertWorld();
    const origin = REORDER.adverts[0]!.origin;
    f.setRunning(['reorder-runtime']);
    f.net.statuses.set(origin, () => new Response(JSON.stringify({ status: 'working' }), { status: 200 }));
    await stops(f, 'the runtime reorder-runtime says working: a job runs');
    expect(f.net.statusReads(origin)).toBe(1);
    f.net.statuses.set(origin, () => new Response(JSON.stringify({ status: 'free' }), { status: 200 }));
    f.setRunning(['reorder-runtime']);
    await land(f);
    expect(f.w.screen.lines).toContain('the runtime reorder-runtime is running and says free');
  });
  it('does not ask a runtime that is not in running-images.json, also when its host would answer 502', async () => {
    const f = await stakeAdvertWorld();
    for (const agent of USE.agents) for (const advert of agent.adverts) f.net.statuses.set(advert.origin, () => new Response('', { status: 502 }));
    await land(f);
    expect(f.net.urls.filter((url) => url.endsWith('/status'))).toEqual([]);
    expect(f.w.screen.lines).toContain('the runtime reorder-runtime is not running: it is not in running-images.json, so it holds no job');
  });
  it('stops when running-images.json is older than 10 minutes or missing: the file decides alone', async () => {
    const f = await stakeAdvertWorld();
    f.setRunning([], NOW - 11 * 60_000);
    await stops(f, 'is more than 10 minutes old');
    rmSync(join(f.w.stateDir, 'running-images.json'));
    await stops(f, 'running-images.json does not exist');
    nothingSigned(f);
    f.setRunning([]);
    await land(f);
  });
});

// ---- the guards judge the bytes ----

describe('stake: the guards judge the bytes of the build', () => {
  /** The run ends with exit 2 and the refusal of a guard. The tool built the transaction, and nothing was signed. */
  async function guarded(f: Fixture, guard: string, reason: string): Promise<void> {
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain(guard);
    expect(errors(f)).toContain(reason);
    expect(f.hosted.built).toHaveLength(1);
    expect(f.signs).toEqual([]);
    expect(f.world.chain.applied).toEqual([]);
    expect(f.w.state('stake').in_flight).toBeNull();
  }
  it('refuses an opening output that goes to another address: destinations', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.open = { address: OUTSIDE };
    await guarded(f, 'destinations', 'has 0 output(s) at the reputation address');
  });
  it('refuses a payment to another address besides the opening: the guard destinations names the address, and no other guard fails', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.open = { extra: { address: OUTSIDE, lovelace: 1_000_000n } };
    await guarded(f, 'destinations', `an output goes to ${OUTSIDE}`);
    expect(refusedBy(errors(f))).toEqual(['destinations']);
  });
  it('refuses an opening that names another owner than the service key', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.open = { owner: f.hash('reorder-delegation-1') };
    await guarded(f, 'destinations', 'the datum names another owner than the service key');
  });
  it('refuses a stake that another key owns: the owner of a stake is the service key and no other key', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { owner: f.hash('controller') };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toContain('the datum names another owner than the service key');
    f.hosted.twist.create = { owner: f.hash('reorder-supplier') };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toMatch(/another owner than the service key|is refused by signers/);
    expect(f.world.chain.applied).toHaveLength(1);
    expect(f.signs).toHaveLength(1);
  });
  it('refuses a create that spends an opening that the plan does not explain: inputs. The twin lands', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    const other = f.seedOpening(ORDER_DESK, { fact: false, step: false });
    f.hosted.twist.create = { spend: other };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain('inputs');
    expect(errors(f)).toContain(`${other} is not explained by the state file`);
    expect(f.world.chain.applied).toHaveLength(1);
    delete f.hosted.twist.create;
    await land(f);
    expect(f.world.chain.applied).toHaveLength(2);
  });
  it('refuses a stake output that goes to another address: destinations', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { address: OUTSIDE };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain('destinations');
    expect(errors(f)).toContain('has 0 output(s) at the reputation address');
    expect(f.world.chain.applied).toHaveLength(1);
  });
  it('refuses a stake of another amount, and a stake that names another opening, before it signs', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    const signed = f.signs.length;
    f.hosted.twist.create = { stake: 11_000_000n };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toContain('the stake output holds 11.000000 units, and the stake of the data is 10.000000 units');
    f.hosted.twist.create = { stakeId: `${'ab'.repeat(32)}#0` };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toContain('the datum names another opening output than the one that the facts file holds');
    expect(f.signs).toHaveLength(signed);
  });
  it('refuses a create that also sends units to another wallet of the registry: the limit is the stake less the opening, plus the fee limit (outflow). The twin lands', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { extra: { address: f.w.keys.registry.addressOf('controller'), lovelace: 5_000_000n } };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toEqual(['outflow']);
    expect(errors(f)).toContain('units leave it, over the limit of 10.000000 units');
    expect(f.world.chain.applied).toHaveLength(1);
    delete f.hosted.twist.create;
    await land(f);
    expect(f.world.chain.applied).toHaveLength(2);
  });
  it('refuses a payment of the stake transaction to another address: the guard destinations names the address', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { extra: { address: OUTSIDE, lovelace: 3_000_000n } };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toContain('destinations');
    expect(errors(f)).toContain(`an output goes to ${OUTSIDE}`);
  });
  it('refuses a create that leaves out the controller, and one that lists another key: signers. The twin lands', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { signers: [f.hash('reorder-service')] };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toEqual(['signers']);
    expect(errors(f)).toContain('missing controller');
    f.hosted.twist.create = { signers: [f.hash('controller'), f.hash('reorder-service'), f.hash('reorder-delegation-1')] };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(refusedBy(errors(f))).toEqual(['signers']);
    expect(f.signs).toHaveLength(1);
    delete f.hosted.twist.create;
    await land(f);
    expect(f.world.chain.applied).toHaveLength(2);
  });
  it('stops with exit 2 and the message of the tool when the tool refuses, and writes the refusal to the evidence', async () => {
    const f = await stakeAdvertWorld();
    f.hosted.twist.open = { refuse: 'Failed to build: the module refuses this opening' };
    expect(await f.run(stake, '--submit')).toBe(2);
    expect(errors(f)).toContain('the tool vector_build_reputation_stake_open refused the call');
    expect(f.w.evidence('stake')).toMatchObject([{ status: 'tool_refused', tool: OPEN, message: 'Failed to build: the module refuses this opening' }]);
    nothingSigned(f);
  });
});

// ---- a tool that builds another stake than it was asked for ----

describe('stake: a tool that builds another stake than the one that it was asked for', () => {
  const argCases: Array<[string, 'open' | 'create', (args: Record<string, unknown>, f: Fixture) => Record<string, unknown>, string]> = [
    ['another amount', 'create', (a) => ({ ...a, amount: 12 }), 'the stake output holds 12.000000 units, and the stake of the data is 10.000000 units'],
    ['the controller as owner', 'create', (a, f) => ({ ...a, owner_key_hash: f.hash('controller') }), 'the datum names another owner than the service key'],
    ['another capability', 'create', (a) => ({ ...a, capabilities: [ORDER_DESK.capability] }), 'the datum lists other capabilities than the capability of the agent'],
    ['two capabilities', 'create', (a) => ({ ...a, capabilities: [REORDER.capability, ORDER_DESK.capability] }), 'the datum lists other capabilities than the capability of the agent'],
    ['another agent', 'create', (a) => ({ ...a, did: `did:vector:${'ab'.repeat(32)}` }), 'the stake output does not hold exactly one stake token of this agent and nothing else'],
    ['another agent in the opening', 'open', (a) => ({ ...a, did: `did:vector:${'ab'.repeat(32)}` }), 'the datum names another agent'],
    ['another capability in the opening', 'open', (a) => ({ ...a, capabilities: [ORDER_DESK.capability] }), 'the datum lists other capabilities than the capability of the agent'],
    ['the controller as owner of the opening', 'open', (a, f) => ({ ...a, owner_key_hash: f.hash('controller') }), 'the datum names another owner than the service key'],
  ];
  for (const [label, step, change, reason] of argCases) {
    it(`refuses a ${step} that the tool builds with ${label}: exit 2, nothing more is signed`, async () => {
      const f = await stakeAdvertWorld();
      if (step === 'create') await land(f);
      const signed = f.signs.length;
      f.hosted.bend[step === 'open' ? OPEN : CREATE] = (args) => change(args, f);
      expect(await f.run(stake, '--submit')).toBe(2);
      expect(errors(f)).toContain(reason);
      expect(f.hosted.built).toHaveLength(step === 'open' ? 1 : 2);
      expect(f.signs).toHaveLength(signed);
      expect(f.world.chain.applied).toHaveLength(step === 'open' ? 0 : 1);
    });
  }
  const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
  const twistCases: Array<[string, 'open' | 'create', (f: Fixture) => Twist, string]> = [
    ['a datum that counts another stake', 'create', () => ({ stakeDatum: { stake_amount: 11_000_000n } }), 'the datum counts another stake than the stake of the data'],
    ['a datum with history points', 'create', () => ({ stakeDatum: { history_points: 3n } }), 'the datum has history points or challenge locks'],
    ['a datum with a challenge lock', 'create', () => ({ stakeDatum: { challenge_locks: ['aa'] } }), 'the datum has history points or challenge locks'],
    ['a datum of another agent', 'create', () => ({ stakeDatum: { agent_did: 'ab'.repeat(32) } }), 'the datum names another agent'],
    ['a datum with another capability', 'create', () => ({ stakeDatum: { staked_capabilities: [hex(ORDER_DESK.capability)] } }), 'the datum lists other capabilities than the capability of the agent'],
    ['a datum with two capabilities', 'create', () => ({ stakeDatum: { staked_capabilities: [hex(REORDER.capability), hex(ORDER_DESK.capability)] } }), 'the datum lists other capabilities than the capability of the agent'],
    ['a datum of another agent in the opening', 'open', () => ({ stakeDatum: { agent_did: 'ab'.repeat(32) } }), 'the datum names another agent'],
    ['a datum with another capability in the opening', 'open', () => ({ stakeDatum: { staked_capabilities: [hex(ORDER_DESK.capability)] } }), 'the datum lists other capabilities than the capability of the agent'],
    ['the stake token of another agent', 'create', (f) => ({ assets: { [unitOf(f, ORDER_DESK)]: 1n } }), 'the stake output does not hold exactly one stake token of this agent and nothing else'],
    ['two stake tokens', 'create', (f) => ({ assets: { [unitOf(f, REORDER)]: 2n } }), 'the stake output does not hold exactly one stake token of this agent and nothing else'],
    ['a second token', 'create', (f) => ({ assets: { [unitOf(f, REORDER)]: 1n, [unitOf(f, ORDER_DESK)]: 1n } }), 'the stake output does not hold exactly one stake token of this agent and nothing else'],
    ['a second output at the reputation address', 'open', () => ({ extra: { address: REPUTATION_ADDRESS, lovelace: 1_500_000n } }), 'has 2 output(s) at the reputation address'],
    ['a second output at the reputation address', 'create', () => ({ extra: { address: REPUTATION_ADDRESS, lovelace: 2_000_000n } }), 'has 2 output(s) at the reputation address'],
  ];
  for (const [label, step, twist, reason] of twistCases) {
    it(`refuses a ${step} with ${label} when the arguments of the tool are right: exit 2, nothing more is signed`, async () => {
      const f = await stakeAdvertWorld();
      if (step === 'create') await land(f);
      const signed = f.signs.length;
      f.hosted.twist[step] = twist(f);
      expect(await f.run(stake, '--submit')).toBe(2);
      expect(errors(f)).toContain(reason);
      expect(f.signs).toHaveLength(signed);
      expect(f.world.chain.applied).toHaveLength(step === 'open' ? 0 : 1);
    });
  }
});

// ---- the verification ----

describe('stake: the verification of create', () => {
  it('catches a stake of another amount: exit 1, the step stays unverified, and the two fields stay empty. The next run verifies it when the read is right', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.readTwist = (row) => ({ ...row, stake_amount: '11000000' });
    expect(await f.run(stake, '--submit')).toBe(1);
    expect(errors(f)).toContain('the hosted tools do not show the step reorder-agent:create as it was made');
    expect(errors(f)).toContain('the stake counts "11000000" lovelace, and the stake of the data is 10000000');
    expect(f.w.facts().stakes['reorder-agent']).toMatchObject({ stakeRef: null, tokenUnit: null });
    expect(f.w.state('stake').notes['part.reorder-agent:create']).not.toHaveProperty('verified_at');
    expect(f.w.evidence('stake').some((entry) => entry.status === 'info')).toBe(true);
    f.hosted.readTwist = (row) => row;
    expect(await f.run(stake)).toBe(0);
    expect(f.w.facts().stakes['reorder-agent']).toMatchObject({ stakeRef: expect.stringMatching(/#0$/), tokenUnit: unitOf(f, REORDER) });
    expect(f.w.state('stake').notes['part.reorder-agent:create']).toMatchObject({ verified_at: expect.any(String) });
  });
  it('reads the reference of the stake from the bytes: a tool that states another reference changes nothing', async () => {
    const f = await stakeAdvertWorld();
    await land(f);
    f.hosted.twist.create = { claimRef: `${'12'.repeat(32)}#7` };
    await land(f);
    const bytes = factsOf(f.world.chain.applied[1]!);
    expect(f.w.facts().stakes['reorder-agent']!.stakeRef).toBe(`${bytes.txHash}#${bytes.outputs.findIndex((output) => output.address === REPUTATION_ADDRESS)}`);
    expect(f.w.state('stake').notes['part.reorder-agent:create']).toMatchObject({ verified_at: expect.any(String) });
  });
  it('catches a stake that another key owns, and a stake of another output than the transaction made', async () => {
    for (const twist of [{ owner_key_hash: 'ab'.repeat(28) }, { ref: `${'cd'.repeat(32)}#0` }]) {
      const f = await stakeAdvertWorld();
      await land(f);
      f.hosted.readTwist = (row) => ({ ...row, ...twist });
      expect(await f.run(stake, '--submit')).toBe(1);
      expect(f.w.facts().stakes['reorder-agent']!.stakeRef).toBeNull();
    }
  });
});

// ---- the cleanup and the secrets ----

describe('stake: the cleanup and the output', () => {
  it('shows the four steps and the next step in the status, and reads no ledger output to build anything', async () => {
    const f = await stakeAdvertWorld({ go: null });
    expect(await f.run(stake, 'status')).toBe(0);
    const lines = f.w.screen.lines.join('\n');
    for (const step of ['reorder-agent:open', 'reorder-agent:create', 'order-desk:open', 'order-desk:create']) expect(lines).toContain(step);
    expect(lines).toContain('next: reorder-agent:open');
    expect(f.hosted.calls).toEqual([]);
    nothingSigned(f);
  });
  it('says that the minimum of a stake never returns to its owner, exits 0, and builds nothing', async () => {
    const f = await stakeAdvertWorld({ go: null });
    expect(await f.run(stake, 'cleanup')).toBe(0);
    expect(f.w.screen.lines).toContain('there is nothing to take back: the minimum of a stake never returns to its owner');
    expect(f.w.machine()).toMatchObject({ task: 'stake', command: 'cleanup', outcome: 'done', exit: 0 });
    expect(f.hosted.calls).toEqual([]);
    nothingSigned(f);
  });
  it('lists the steps of the data in order, and shows no seed in the output, the state, the facts or the evidence', async () => {
    const f = await stakeAdvertWorld();
    expect(stake.steps(USE, NO_FLAGS)).toEqual(['reorder-agent:open', 'reorder-agent:create', 'order-desk:open', 'order-desk:create']);
    await land(f, '--all');
    const text = f.w.allText();
    for (const name of ['controller', 'reorder-service', 'order-desk-service']) expect(text).not.toContain(f.w.keys.seedOf(name));
  });
});
