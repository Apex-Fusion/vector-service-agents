// The command line of a check, with a toy check of two steps that lands real transactions against a world of fixtures: the two modes, the order of the steps, the state, the evidence,
// the wait, the status, and the exit code of each kind of failure.
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostedError } from '../lib/hosted.ts';
import type { HostedTools } from '../lib/hosted.ts';
import { GuardRefusal } from '../lib/land.ts';
import type { LandRequest } from '../lib/land.ts';
import { FlagError, parseArguments, runCheck, runSteps, waitFor } from '../lib/runner.ts';
import type { CheckDefinition, StepHandler } from '../lib/runner.ts';
import { commitStep, stepPlan } from '../lib/session.ts';
import type { Session, StepOutcome } from '../lib/session.ts';
import { TxNotConfirmedError } from '../lib/platform.ts';
import { factsOf } from '../lib/txfacts.ts';
import { harness } from './support/harness.ts';
import { AGENT_N, MEMBER_N, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);

/** A step that pays `lovelace` from one wallet to the other, with the limits of a payment between two wallets. */
function payment(name: string, from: typeof member, to: typeof member, lovelace: bigint): StepHandler {
  return {
    name,
    async run(session: Session): Promise<StepOutcome> {
      const { lucid } = await session.chain.context(from.address);
      const built = await lucid.newTx().pay.ToAddress(to.address, { lovelace }).complete();
      const request: LandRequest = {
        step: name,
        built: { unsignedCbor: built.toCBOR(), txHash: built.toHash(), feeLovelace: factsOf(built.toCBOR()).feeLovelace, validTo: session.clock.now() + 30 * 60_000 },
        plan: stepPlan(session, { outflow: { [from.role]: lovelace + 1_000_000n } }),
        refs: { amount: String(lovelace) }, facts: { to: to.keyHash },
      };
      const landed = await session.land(request);
      if (landed.kind === 'dry') return { kind: 'dry' };
      commitStep(session, request, landed, { moved: String(lovelace) });
      return { kind: 'done', message: `${name} is confirmed` };
    },
  };
}

const handlers = [payment('one', member, agent, 3_000_000n), payment('two', agent, member, 2_000_000n)];
const toy: CheckDefinition = {
  name: 'toy', title: 'a toy check of two steps', needs: { keys: ['member', 'agent'], chain: true, hosted: [] }, flags: ['--extra'], steps: ['one', 'two'],
  parse: () => ({}),
  next: (session, flags) => runSteps(session, handlers, flags),
  cleanup: async () => ({ kind: 'done', message: 'there is nothing to take back' }),
};
const withStep = (step: StepHandler, name = 'toy'): CheckDefinition => ({ ...toy, name, steps: [step.name], next: (session, flags) => runSteps(session, [step], flags) });

describe('the arguments', () => {
  it('make a dry run of the next step by default, and take --submit, a command and the flags of the check', () => {
    expect(parseArguments(toy, [])).toEqual({ command: 'run', mode: 'dry', flags: new Set() });
    expect(parseArguments(toy, ['--submit'])).toEqual({ command: 'run', mode: 'submit', flags: new Set() });
    expect(parseArguments(toy, ['cleanup', '--submit', '--extra'])).toEqual({ command: 'cleanup', mode: 'submit', flags: new Set(['--extra']) });
    expect(parseArguments(toy, ['status'])).toEqual({ command: 'status', mode: 'dry', flags: new Set() });
  });
  it('refuse a word that is not known, two commands, and a flag of the status', () => {
    for (const argv of [['--sumbit'], ['run', 'cleanup'], ['status', '--submit'], ['status', '--extra'], ['--dry-run']]) expect(() => parseArguments(toy, argv), argv.join(' ')).toThrow(FlagError);
  });
});

describe('a run with no flag', () => {
  it('builds and checks the next step, prints what it would sign, and changes nothing', async () => {
    const h = await harness();
    expect(await h.run(toy)).toBe(0);
    expect(h.screen.text).toContain('step one: dry mode, nothing is signed or submitted');
    expect(h.screen.text).toContain('dry run: nothing was signed or submitted. Run again with --submit');
    expect(h.node.submitted).toEqual([]);
    expect(h.state('toy').steps).toEqual({});
    expect(h.evidence('toy')).toEqual([]);
  });
  it('refuses an unknown flag with the usage, before it reads a key', async () => {
    const h = await harness();
    expect(await h.run(toy, '--sumbit')).toBe(2);
    expect(h.screen.errorText).toContain('unknown argument --sumbit');
    expect(h.screen.errorText).toContain('usage:');
    expect(existsSync(join(h.stateDir, 'toy.state.json'))).toBe(false);
  });
});

describe('a run with --submit', () => {
  it('signs, submits, waits, records the step with its transaction hash and its references, and writes the evidence', async () => {
    const h = await harness();
    expect(await h.run(toy, '--submit')).toBe(0);
    const state = h.state('toy');
    expect(Object.keys(state.steps)).toEqual(['one']);
    expect(state.steps.one).toMatchObject({ refs: { amount: '3000000' }, facts: { to: agent.keyHash }, verified_at: null });
    expect(state.steps.one!.tx_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(state.in_flight).toBeNull();
    expect(h.evidence('toy')).toEqual([expect.objectContaining({ step: 'one', status: 'confirmed', tx_hash: state.steps.one!.tx_hash, shows: { moved: '3000000' } })]);
    expect(h.node.submitted).toHaveLength(1);
    expect(h.screen.text).toContain('one is confirmed');
  });
  it('does one step each time, in order, and never a confirmed step again', async () => {
    const h = await harness();
    await h.run(toy, '--submit');
    h.screen.lines.length = 0;
    expect(await h.run(toy)).toBe(0);
    expect(h.screen.text).toContain('step two:');
    expect(h.screen.text).not.toContain('step one:');
    expect(await h.run(toy, '--submit')).toBe(0);
    expect(Object.keys(h.state('toy').steps)).toEqual(['one', 'two']);
    h.screen.lines.length = 0;
    const submitted = h.node.submitted.length;
    expect(await h.run(toy, '--submit')).toBe(0);
    expect(h.screen.text).toContain('every step of the check toy is confirmed');
    expect(h.node.submitted).toHaveLength(submitted);
  });
  it('keeps the signed transaction in flight when it is not seen confirmed, exits 1, and settles it at the next start without building the step again', async () => {
    const h = await harness();
    h.node.neverConfirm = true;
    expect(await h.run(toy, '--submit')).toBe(1);
    expect(h.state('toy').in_flight).toMatchObject({ step: 'one' });
    expect(h.state('toy').steps).toEqual({});
    expect(h.screen.errorText).toContain('settles it before it builds anything');
    h.node.neverConfirm = false;
    h.screen.lines.length = 0;
    const submitted = h.node.submitted.length;
    expect(await h.run(toy)).toBe(0);
    expect(h.screen.text).toContain('is confirmed: the step is recorded');
    expect(h.state('toy').steps.one).toBeDefined();
    expect(h.state('toy').in_flight).toBeNull();
    expect(h.screen.text).toContain('step two:');
    expect(h.node.submitted).toHaveLength(submitted);
  });
  it('waits for a transaction that may still land, exits 4 and says until when', async () => {
    const h = await harness();
    h.node.neverConfirm = true;
    await h.run(toy, '--submit');
    h.screen.lines.length = 0;
    expect(await h.run(toy)).toBe(4);
    expect(h.screen.text).toMatch(/^WAIT: /m);
    expect(h.screen.text).toContain('may land until');
  });
  it('writes the error and the body of a transaction that the ledger refuses to the evidence, exits 1, and leaves the state as it was', async () => {
    const h = await harness();
    h.node.submitError = new Error('Transaction submission rejected (400 Bad Request): BadInputsUTxO');
    expect(await h.run(toy, '--submit')).toBe(1);
    expect(h.state('toy').steps).toEqual({});
    expect(h.state('toy').in_flight).toBeNull();
    expect(h.evidence('toy')).toEqual([expect.objectContaining({ step: 'one', status: 'refused', expected: false, evaluation_error: expect.stringContaining('BadInputsUTxO') })]);
    expect(h.evidence('toy')[0]!.transaction_body).toMatch(/^[0-9a-f]+$/);
    expect(h.screen.errorText).toContain('The state is unchanged');
  });
});

describe('the status', () => {
  it('shows the steps, the transaction in flight, the network and the wallets, with no build and nothing written but the files of the check', async () => {
    const h = await harness();
    await h.run(toy, '--submit');
    h.screen.lines.length = 0;
    expect(await h.run(toy, 'status')).toBe(0);
    const text = h.screen.text;
    expect(text).toContain('check toy: a toy check of two steps');
    expect(text).toMatch(/one +confirmed .*transaction [0-9a-f]{64}, not verified/);
    expect(text).toMatch(/two +not run/);
    expect(text).toContain('in flight: nothing');
    expect(text).toContain('next: two');
    expect(text).toContain('network guard: ok');
    expect(text).toContain(`wallet of the member key ${member.keyHash}`);
    expect(text).toContain(`wallet of the agent key ${agent.keyHash}`);
    expect(text).toMatch(/pure output\(s\) of 5 units or more for collateral/);
    expect(h.node.submitted).toHaveLength(1);
  });
});

describe('what a step ends with', () => {
  it('is a wait: the output says how long is left, and the exit is 4', async () => {
    const h = await harness();
    const waiting: StepHandler = { name: 'w', run: async (session) => waitFor(session.clock.now() + 125_000, session.clock.now(), 'the escrow can be reclaimed after its deadline') };
    expect(await h.run(withStep(waiting))).toBe(4);
    expect(h.screen.text).toContain('WAIT: the escrow can be reclaimed after its deadline: 2 min 5 s are left');
  });
  it('is mapped to an exit code: a guard 2, the hosted tools 3, the rest 1', async () => {
    const throwing = (error: unknown): StepHandler => ({ name: 's', run: async () => { throw error; } });
    const cases: Array<[unknown, number]> = [
      [new GuardRefusal('s', [{ guard: 'fee', ok: false, message: 'the fee is too high' }]), 2],
      [new HostedError('unreachable', 'the hosted server could not be used'), 3],
      [new HostedError('missing_tool', 'the hosted server lacks the tool x'), 3],
      [new HostedError('bad_arguments', 'x has no argument y'), 2],
      [new TxNotConfirmedError('not confirmed', { txHash: 'ab', escrowRef: '', deliverBy: null, validTo: 1, mayLand: true }), 1],
      [new Error('a step failed'), 1],
      ['not an error', 1],
    ];
    for (const [error, code] of cases) {
      const h = await harness();
      expect(await h.run(withStep(throwing(error))), String(error)).toBe(code);
      expect(h.screen.errors.length).toBeGreaterThan(0);
    }
  });
});

describe('the verification of a step', () => {
  const verified: HostedTools = { call: async () => ({ text: '', json: { live: true }, failed: false, message: '' }) };
  const checked = (verify: StepHandler['verify']): StepHandler => ({ ...handlers[0]!, verify });
  it('runs at once when the step lands, and marks the step verified', async () => {
    const h = await harness({ hosted: verified });
    let seen = 0;
    const def = withStep(checked(async (session) => { seen += 1; await session.hosted.call('vector_get_delegation', { delegation: 'ab'.repeat(32) }); }));
    expect(await h.run(def, '--submit')).toBe(0);
    expect(seen).toBe(1);
    expect(h.state('toy').steps.one!.verified_at).not.toBeNull();
    expect(h.screen.text).toContain('the step one is verified');
  });
  it('keeps a step confirmed when its verification fails, exits with the code of the failure, and verifies it before any other step at the next start', async () => {
    const h = await harness({ hosted: verified });
    let ok = false;
    const def: CheckDefinition = { ...toy, steps: ['one', 'two'], next: (session, flags) => runSteps(session, [checked(async () => { if (!ok) throw new HostedError('unreachable', 'the hosted server could not be used'); }), handlers[1]!], flags) };
    expect(await h.run(def, '--submit')).toBe(3);
    expect(h.state('toy').steps.one).toMatchObject({ verified_at: null });
    ok = true;
    h.screen.lines.length = 0;
    const submitted = h.node.submitted.length;
    expect(await h.run(def)).toBe(0);
    expect(h.state('toy').steps.one!.verified_at).not.toBeNull();
    expect(h.screen.text).toContain('the step one is verified');
    expect(h.node.submitted).toHaveLength(submitted);
  });
});

describe('the files of a run', () => {
  it('refuse a key file that other users can read, and say how to fix it', async () => {
    const h = await harness();
    chmodSync(h.env.CHECKS_MEMBER_KEY_FILE!, 0o644);
    expect(await h.run(toy)).toBe(2);
    expect(h.screen.errorText).toContain('mode 600');
  });
  it('refuse the state file of another record, and settings that are missing, all in one message', async () => {
    const h = await harness();
    await h.run(toy, '--submit');
    h.screen.errors.length = 0;
    const other = h.deps({ env: { ...h.env, CHECKS_RECORD: `did:vector:${'dd'.repeat(32)}` } });
    expect(await runCheck(toy, [], other)).toBe(2);
    expect(h.screen.errorText).toContain('another record');
    h.screen.errors.length = 0;
    const missing = h.deps({ env: { CHECKS_STATE_DIR: h.stateDir } });
    expect(await runCheck(toy, [], missing)).toBe(2);
    expect(h.screen.errorText).toContain('CHECKS_NETWORK');
    expect(h.screen.errorText).toContain('CHECKS_RECORD');
    expect(h.screen.errorText).toContain('CHECKS_MEMBER_KEY_FILE');
  });
});
