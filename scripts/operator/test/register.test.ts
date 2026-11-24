// The task `register`: the three records of use case 1 (the Reorder Agent, its subagent `stock-reader` and the Order Desk), the TXT gate, the signers, the consent of Module-1, the check of the
// record that landed, and the wait for the organisation check. A fake tool builds a REAL registration over the identity fixtures with the real builder and answers in the format of the live
// tools, so the real guards judge real bytes. A fake `fetch` stands for the three public resolvers and the gateway. The task runs through the real runner. Each refusal has an accepted twin.
import { decode, encode, RECURSION_DESIRED } from '@dnsquery/dns-packet';
import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceFile } from '../../checks/lib/evidence.ts';
import { iso } from '../../checks/lib/format.ts';
import { HostedError, checkArguments } from '../../checks/lib/hosted.ts';
import type { ToolAnswer } from '../../checks/lib/hosted.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
import { StateFile } from '../../checks/lib/state.ts';
import { DEPLOYMENT } from '../../checks/test/support/world.ts';
import { buildRegister } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import type { PartySpec, RegisterBuild, RegisterParams } from '../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import type { GoFile } from '../lib/approval.ts';
import type { UseCase } from '../lib/contract.ts';
import { FactsFile } from '../lib/facts.ts';
import { RIGHT, ROLE_MAX_RIGHTS } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
import { M1 } from '../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { decodeIdentityDatum, encodeIdentityDatum, utf8Hex } from '../../../packages/vector-read/src/identity-codec.ts';
import { RESOLVERS } from '../lib/dns.ts';
import { lucidForAddress } from '../lib/platform.ts';
import { loadRegistry } from '../lib/registry.ts';
import { loadTask } from '../lib/load.ts';
import { runTask } from '../lib/runner.ts';
import register from '../tasks/register.ts';
import USE from '../usecases/inventory-reorder.ts';
import UC2 from '../usecases/prior-authorization.ts';
import UC3 from '../usecases/bid-evaluation.ts';
import { FakeClock, ThrowingSigner, World } from './support/fakes.ts';
import { PACK_SCHEMAS, PackHosted, liveBuildAnswer } from './support/pack-hosted.ts';
import { NOW, ScriptedNode, USE_CASE, hashOf, taskWorld } from './support/task-world.ts';
import type { TaskWorld } from './support/task-world.ts';

vi.mock('node:http2', () => ({ connect: vi.fn(() => { throw new Error('registration tests must use the injected DNS fetch'); }) }));

// ---- the data ----

const REORDER = USE.agents.find((agent) => agent.id === 'reorder-agent')!;
const STOCK_READER = USE.subagents.find((agent) => agent.id === 'stock-reader')!;
const ECHO = USE.organisations.find((organisation) => organisation.id === 'echo')!;
const ALFA = USE.organisations.find((organisation) => organisation.id === 'alfa')!;
const KEY_NAMES = USE.keys.map((key) => key.name);
const SHARED = USE.keys.filter((key) => key.scope === 'shared').map((key) => key.name);
const TOOL = 'vector_build_identity_register';
const GATEWAY = 'https://gateway.test';
const RESOLVER_NAMES = RESOLVERS.map((resolver) => resolver.name);
const MINUTE = 60_000;
const DID_PREFIX = 'did:vector:';

// ---- what the tool is asked for, and what it builds ----

interface PartyArgs { role: PartySpec['role']; signer: string; organisation?: string; rights?: string[]; not_before?: number; not_after?: number; removal_after?: number }
interface KeyArgs { key: string; purposes: string[] }
interface RegisterArgs {
  changeAddress: string; controller: string; name: string; description?: string; endpoint?: string; capabilities?: string[]; keys: KeyArgs[]; parties: PartyArgs[];
  guardian_threshold?: number; parent?: string; deposit?: number; valid_minutes?: number; framework?: string;
}

const PURPOSE_BITS: Record<string, number> = { authentication: 1, assertion: 2, transaction: 8, delegation: 16 };
const rightsBits = (role: PartySpec['role'], names: readonly string[] | undefined): number => (names === undefined ? ROLE_MAX_RIGHTS[role] : names.reduce((sum, name) => sum + RIGHT[name as keyof typeof RIGHT], 0));

/** The parameters of the real builder for the arguments of the tool, as the tool reads them. */
function paramsOf(args: RegisterArgs, nowMs: number): RegisterParams {
  const party = (one: PartyArgs): PartySpec => ({
    role: one.role,
    signer: one.signer === 'controller' ? { type: 'ControllerSet' } : one.signer === 'module1' ? { type: 'Script', hash: M1 } : { type: 'KeyHash', hash: one.signer },
    organisation: one.organisation === undefined ? null : utf8Hex(one.organisation), notBefore: one.not_before, notAfter: one.not_after ?? null, rights: rightsBits(one.role, one.rights), removalAfter: one.removal_after ?? null,
  });
  return {
    changeAddress: args.changeAddress, nowMs, validMinutes: args.valid_minutes, controller: args.controller,
    keys: args.keys.map((key) => ({ keyType: 'Ed25519' as const, key: key.key, purposes: key.purposes.reduce((sum, name) => sum + PURPOSE_BITS[name]!, 0), pop: null })),
    parties: args.parties.map(party), guardianThreshold: args.guardian_threshold, name: utf8Hex(args.name), description: utf8Hex(args.description ?? ''), endpoint: utf8Hex(args.endpoint ?? ''),
    ...(args.framework === undefined ? {} : { framework: utf8Hex(args.framework) }),
    capabilities: (args.capabilities ?? []).map(utf8Hex), ...(args.parent === undefined ? {} : { parent: args.parent.slice(DID_PREFIX.length) }),
    depositLovelace: BigInt(Math.round((args.deposit ?? 10) * 1_000_000)),
  };
}

/** The reward account of Module-1 as the node answers for it: the balance, and the balance that a test sets after a build. */
interface Account { rewards: bigint }

/**
 * The hosted tool of the tests: held to the live schema of `vector_build_identity_register` like `PackHosted`, and it builds a real registration over the world, at the time of the clock.
 * `change` turns the arguments into the arguments that it builds (a test makes it build another record), and `after` runs after each build, before the answer (a test changes the world).
 */
class RegisterHosted extends PackHosted {
  change: (args: RegisterArgs) => RegisterArgs = (args) => args;
  /** Changes the facts that the tool writes in its answer besides the hash, the fee and the signers: a test makes the tool lie about its DID. */
  answer: (extra: Record<string, unknown>) => Record<string, unknown> = (extra) => extra;
  after: (built: RegisterBuild) => void = () => undefined;
  readonly built: RegisterBuild[] = [];
  readonly #world: World;
  readonly #clock: FakeClock;

  constructor(world: World, clock: FakeClock) {
    super({});
    this.#world = world;
    this.#clock = clock;
  }

  override async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
    if (name === TOOL) {
      const problems = checkArguments(name, PACK_SCHEMAS[name], args);
      if (problems.length > 0) throw new HostedError('bad_arguments', problems.join('; '));
      const answer = await this.#build(args);
      this.handlers[name] = () => answer;
    }
    return super.call(name, args);
  }

  async #build(sent: Record<string, unknown>): Promise<{ text: string }> {
    // The arguments passed the schema of the tool, which checks the members of the top level only: this is their shape.
    const asked = sent as unknown as RegisterArgs;
    const args = this.change(asked);
    const lucid = await lucidForAddress(this.#world.chain, args.changeAddress);
    const built = await buildRegister({ lucid, provider: this.#world.chain, deployment: DEPLOYMENT }, paramsOf(args, this.#clock.now()));
    this.built.push(built);
    this.after(built);
    return liveBuildAnswer('Identity registration', {
      txCbor: built.txCbor, txHash: built.txHash, fee: built.fee, validFrom: built.validFrom, validTo: built.validTo, requiredSigners: built.requiredSigners.map(({ keyHash, roles }) => ({ keyHash, roles })),
    }, this.answer({ did: built.did, id: built.id, seed: built.seed, record_output_index: built.recordOutputIndex }));
  }
}

// ---- the resolvers and the gateway ----

interface GatewayEntry { organisation: string; verified: boolean; role?: string; status?: 'active' | 'revoked'; did?: string }
const DNS_MESSAGE = 'application/dns-message';

function dnsQuestion(url: URL) {
  expect([...url.searchParams.keys()]).toEqual(['dns']);
  const query = decode(Buffer.from(url.searchParams.get('dns')!, 'base64url'));
  expect(query).toMatchObject({ id: 0, type: 'query', flags: RECURSION_DESIRED, answers: [], authorities: [], additionals: [] });
  expect(query.questions).toHaveLength(1);
  const question = query.questions![0]!;
  expect(question).toMatchObject({ class: 'IN', type: 'TXT' });
  return question;
}

/** A `fetch` for the three resolvers (DNS-over-HTTPS) and the gateway. It keeps each URL that it was asked for. */
class Net {
  readonly urls: string[] = [];
  /** The TXT values, by resolver and record name. */
  readonly records = new Map<string, Map<string, string[]>>();
  readonly gateway = new Map<string, GatewayEntry>();
  gatewayFails: Error | null = null;

  /** The TXT lookups that were made. */
  lookups(): URL[] { return this.urls.map((url) => new URL(url)).filter((url) => RESOLVERS.some((resolver) => new URL(resolver.url).host === url.host)); }

  /** Publishes the value at the name on the resolvers (all three by default). */
  publish(name: string, value: string, only: readonly string[] = RESOLVER_NAMES): void {
    for (const resolver of only) {
      const held = this.records.get(resolver) ?? new Map<string, string[]>();
      held.set(name, [...(held.get(name) ?? []), value]);
      this.records.set(resolver, held);
    }
  }

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.urls.push(url.href);
    const resolver = RESOLVERS.find((one) => new URL(one.url).host === url.host);
    if (resolver !== undefined) {
      expect(`${url.origin}${url.pathname}`).toBe(resolver.url);
      expect(init).toMatchObject({ method: 'GET', redirect: 'manual', signal: expect.any(AbortSignal) });
      expect(new Headers(init?.headers).get('accept')).toBe(DNS_MESSAGE);
      const question = dnsQuestion(url);
      const texts = this.records.get(resolver.name)?.get(question.name) ?? [];
      const response = encode({
        id: 0, type: 'response', flags: texts.length === 0 ? 0x0183 : 0x0180, questions: [question],
        answers: texts.map((data) => ({ type: 'TXT', class: 'IN', name: question.name, ttl: 60, data })),
      });
      return new Response(Buffer.from(response), { status: 200, headers: { 'content-type': DNS_MESSAGE } });
    }
    if (url.origin === GATEWAY) {
      if (this.gatewayFails !== null) throw this.gatewayFails;
      const did = decodeURIComponent(url.pathname.slice('/1.0/identifiers/'.length));
      const entry = this.gateway.get(did);
      if (entry === undefined) return new Response(JSON.stringify({ didDocument: null, didResolutionMetadata: { error: 'notFound' }, didDocumentMetadata: {} }), { status: 404 });
      const ended = entry.status === 'revoked';
      const metadata = {
        vectorStatus: { status: entry.status ?? 'active', effective: entry.status ?? 'active' },
        vectorParties: [{ role: entry.role ?? 'accountable', signer: 'controller', organisation: entry.organisation, ...(entry.verified ? { organisationVerified: true } : {}), rights: ['suspend', 'revoke'] }],
      };
      return new Response(JSON.stringify({ didDocument: ended ? null : { id: entry.did ?? did }, didResolutionMetadata: {}, didDocumentMetadata: metadata }), { status: ended ? 410 : 200 });
    }
    throw new Error('the test fetch was asked for a host that it does not know');
  };
}

// ---- the fixture ----

interface Fixture {
  readonly w: TaskWorld;
  readonly world: World;
  readonly account: Account;
  readonly hosted: RegisterHosted;
  readonly net: Net;
  /** The key hash of each signature that the ring was asked for. */
  readonly signs: string[];
  /** The signer that fails when it is asked: set it to refuse every signature. */
  refuseSigning: boolean;
  /** The data of the use case that each run loads: a test changes it between two runs. */
  use: UseCase;
  /** Runs the task through the real runner, with an empty screen, and gives the exit code. */
  run(...argv: string[]): Promise<number>;
}

const THROWER = new ThrowingSigner();
const feeOutputs = (address: string, lovelace: readonly bigint[]) => lovelace.map((amount, outputIndex) => ({ txHash: hashOf('wallet fee'), outputIndex, address, assets: { lovelace: amount } }));

/** Uses real registration builders over a fake ledger. The transport and keys belong to the fixture. */
async function fixture(over: { go?: Partial<GoFile> | null; fee?: readonly bigint[]; use?: UseCase } = {}): Promise<Fixture> {
  const use = over.use ?? USE;
  const keys = use.keys.map(({ name }) => name);
  const shared = use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name);
  const w = await taskWorld({ keys, shared, use, wallets: {}, env: { OPERATOR_GATEWAY_URL: GATEWAY, OPERATOR_USE_CASE: USE_CASE } });
  const world = await World.identity({ wallets: [], extra: feeOutputs(w.keys.registry.addressOf('fee'), over.fee ?? [1_000_000_000n, 5_000_000n]) });
  const account: Account = { rewards: 7_000_000n };
  Object.assign(world.chain, { getRewardAccount: async () => ({ registered: true, rewards: account.rewards, source: 'ogmios' }) });
  const node = new ScriptedNode(world);
  const net = new Net();
  const hosted = new RegisterHosted(world, w.clock);
  const chain: ChainAccess = {
    provider: world.chain, deployment: DEPLOYMENT, koiosUrl: 'https://koios.test', fetchImpl: net.fetchImpl,
    context: async (address) => ({ lucid: await lucidForAddress(world.chain, address), provider: world.chain, deployment: DEPLOYMENT }), liveVaultsOf: async () => [],
  };
  if (over.go !== null) w.writeGo({ tasks: ['register'], irreversible: ['record'], capUnits: 100, ...over.go });
  const f: Fixture = {
    w, world, account, hosted, net, use, signs: [], refuseSigning: false,
    run: async (...argv) => {
      w.screen.lines.length = 0;
      w.screen.errors.length = 0;
      const deps = w.deps({
        node, chain, hosted, fetchImpl: net.fetchImpl, loadUseCase: async () => f.use,
        readRegistry: (options) => {
          const registry = loadRegistry(options);
          const real = registry.ring.sign.bind(registry.ring);
          registry.ring.sign = (keyHash, cborHex) => { f.signs.push(keyHash); return f.refuseSigning ? THROWER.sign() : real(keyHash, cborHex); };
          return registry;
        },
      });
      return runTask(register, argv, deps);
    },
  };
  return f;
}

// ---- what a test reads ----

interface Txt { name: string; value: string }
interface Result { subject: string; did: string; txt: Txt | null; signers: string[]; valid_until: string }
const resultOf = (f: Fixture): Result => {
  const result: unknown = f.w.machine().result;
  return result as Result;
};
const errorText = (f: Fixture): string => f.w.screen.errors.join('\n');
const registry = (f: Fixture) => f.w.keys.registry;
const idOf = (did: string): string => did.slice(DID_PREFIX.length);
const steps = (f: Fixture): string[] => Object.keys(f.w.state('register').steps);
const feeAddress = (f: Fixture): string => registry(f).addressOf('fee');
/** A bigger pure output for the `fee` wallet: the next registration takes it as its seed, so the DID changes. */
const moveSeed = (f: Fixture): void => { f.world.chain.held.push({ txHash: hashOf('a bigger output'), outputIndex: 0, address: feeAddress(f), assets: { lovelace: 2_000_000_000n } }); };
/** Nothing was signed, submitted or recorded as in flight, and no step is recorded. */
const untouched = (f: Fixture): void => {
  expect(f.signs).toEqual([]);
  expect(f.world.chain.applied).toEqual([]);
  expect(f.w.state('register').in_flight).toBeNull();
  expect(steps(f)).toEqual([]);
};

/** The dry run of the next record. It gives the result that the machine line carries. */
async function dry(f: Fixture): Promise<Result> {
  expect(await f.run()).toBe(0);
  expect(f.w.machine()).toMatchObject({ task: 'register', mode: 'dry', outcome: 'dry', exit: 0 });
  return resultOf(f);
}
/** Publishes the TXT value that the dry run showed, on the resolvers that are named (all three by default). */
const publish = (f: Fixture, shown: Result, only?: readonly string[]): void => { if (shown.txt !== null) f.net.publish(shown.txt.name, shown.txt.value, only); };
/** The dry run of the next record, the publication of its TXT value, and the run with --submit that registers it. */
async function registered(f: Fixture, ...more: string[]): Promise<Result> {
  const shown = await dry(f);
  publish(f, shown);
  expect(await f.run('--submit', ...more)).toBe(0);
  return shown;
}
/** The three records, one after the other. It gives the three results. */
async function allThree(f: Fixture): Promise<Result[]> {
  return [await registered(f), await registered(f), await registered(f)];
}

// ---- the dry run ----

describe('register: the dry run', () => {
  it('shows the DID, the TXT name and value, the validity end, the signers, the deposit and the fee of the first record, writes its note, and looks nothing up', async () => {
    const f = await fixture({ go: null });
    f.refuseSigning = true;
    const shown = await dry(f);
    const built = f.hosted.built[0]!;
    expect(shown.did).toBe(built.did);
    expect(shown.did).toBe(`${DID_PREFIX}${built.id}`);
    expect(shown).toEqual({
      subject: 'reorder-agent', did: built.did, txt: { name: `_did.${ECHO.domain}`, value: built.did }, valid_until: iso(built.validTo),
      signers: ['controller', 'fee', 'reorder-supplier', 'reorder-service', 'reorder-delegation-1', 'reorder-delegation-2', 'accountable-echo', 'provider', 'guardian-echo'],
    });
    const lines = f.w.screen.lines;
    for (const line of [
      'record reorder-agent (Reorder Agent)', `DID: ${built.did}`, `TXT name: _did.${ECHO.domain}`, `TXT value: ${built.did}`, `valid until: ${iso(built.validTo)}`, `signers: ${shown.signers.join(', ')}`,
      'deposit: 10.000000 units', `fee: ${(Number(built.fee) / 1_000_000).toFixed(6)} units`,
    ]) expect(lines, line).toContain(line);
    expect(lines.some((line) => /nothing_else\s+1 withdrawal\(s\), as the step says, and no certificate/.test(line))).toBe(true);
    expect(lines.some((line) => line.startsWith('the dry run wrote the note dry.reorder-agent'))).toBe(true);
    expect(f.w.state('register').notes['dry.reorder-agent']).toEqual({ did: built.did, txtName: `_did.${ECHO.domain}`, txtValue: built.did, at: iso(NOW) });
    // The dry run looked nothing up, signed nothing, and wrote nothing but the note: no step, no fact, no cap entry, no evidence.
    expect(f.net.urls).toEqual([]);
    untouched(f);
    expect(Object.keys(f.w.state('register').notes)).toEqual(['dry.reorder-agent']);
    expect(f.w.facts()).toMatchObject({ records: {}, organisations: {} });
    expect(f.w.exposure()).toEqual([]);
    expect(f.w.evidence('register')).toEqual([]);
  });
  it('asks the tool for the record of the data: the arguments come from the data and the registry, and name no framework, no parent and no key of a secret', async () => {
    const f = await fixture({ go: null });
    await dry(f);
    const keys = registry(f);
    const pub = (name: string): string => keys.publicKeyOf(name);
    expect(f.hosted.calls).toEqual([{
      name: TOOL,
      args: {
        changeAddress: feeAddress(f), controller: pub('controller'), name: REORDER.name, description: REORDER.description, endpoint: REORDER.endpoint, capabilities: [REORDER.capability],
        keys: [
          { key: pub('reorder-supplier'), purposes: ['authentication', 'transaction'] }, { key: pub('reorder-service'), purposes: ['authentication', 'transaction'] },
          { key: pub('reorder-delegation-1'), purposes: ['delegation'] }, { key: pub('reorder-delegation-2'), purposes: ['delegation'] },
        ],
        parties: [
          { role: 'Accountable', signer: keys.hashOf('accountable-echo'), organisation: ECHO.domain }, { role: 'Responsible', signer: 'module1' },
          { role: 'Provider', signer: keys.hashOf('provider'), rights: [] }, { role: 'Guardian', signer: keys.hashOf('guardian-echo') }, { role: 'Guardian', signer: keys.hashOf('controller') },
        ],
        guardian_threshold: 2, deposit: 10, valid_minutes: 30,
      },
    }]);
  });
  it('needs no approval file, and writes a new note with the DID of the new build at the next dry run', async () => {
    const f = await fixture({ go: null });
    const first = await dry(f);
    moveSeed(f);
    const second = await dry(f);
    expect(second.did).not.toBe(first.did);
    expect(f.w.state('register').notes['dry.reorder-agent']).toMatchObject({ did: second.did, txtValue: second.did });
  });
  it('writes no note for a dry run that a guard refused: the value of a build that cannot be signed is never shown as the value to publish', async () => {
    const f = await fixture({ go: null });
    f.hosted.change = (args) => ({ ...args, parties: [...args.parties, { role: 'Distributor', signer: registry(f).hashOf('order-desk-service'), rights: [] }] });
    expect(await f.run()).toBe(2);
    expect(errorText(f)).toContain('signers');
    expect(f.w.state('register').notes).toEqual({});
    expect(f.w.machine()).toMatchObject({ outcome: 'stopped' });
    expect(f.w.machine().result).toEqual({});
  });
});

// ---- the submit run and the TXT gate ----

describe('register --submit: the note and the TXT gate', () => {
  it('stops with no note, says to run the dry run first, and looks nothing up: a resolver would keep the answer "no record" for a name that nobody published yet', async () => {
    const f = await fixture();
    f.refuseSigning = true;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('run the dry run, publish the TXT value, then run again');
    expect(f.net.urls).toEqual([]);
    untouched(f);
    expect(f.w.machine()).toMatchObject({ mode: 'submit', outcome: 'stopped', exit: 2, step: 'reorder-agent' });
    expect(f.w.machine().result).toEqual({});
    // The twin: after the dry run and the publication, the same run registers the record.
    f.refuseSigning = false;
    publish(f, await dry(f));
    expect(await f.run('--submit')).toBe(0);
    expect(steps(f)).toEqual(['reorder-agent']);
  });
  it('stops when the note holds another DID, because the fee wallet changed after the dry run, prints the value for this build, and looks nothing up', async () => {
    const f = await fixture();
    const old = await dry(f);
    publish(f, old);
    moveSeed(f);
    expect(await f.run('--submit')).toBe(2);
    const built = f.hosted.built.at(-1)!;
    expect(built.did).not.toBe(old.did);
    expect(errorText(f)).toContain(old.did);
    expect(errorText(f)).toContain(`TXT value for this build is ${built.did} at _did.${ECHO.domain}`);
    expect(errorText(f)).toContain('run the dry run again');
    // The TXT value of the old DID is public on all three resolvers, and nobody asked a resolver.
    expect(f.net.lookups()).toEqual([]);
    untouched(f);
    // The twin: the dry run again, the new value published, and the run lands.
    publish(f, await dry(f));
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.facts().records['reorder-agent']!.did).toBe(built.did);
  });
  it('stops when the note holds the DID of this build and the resolvers show only the value of an older DID, and names the resolvers that do not show the value', async () => {
    const f = await fixture();
    const old = await dry(f);
    publish(f, old);
    moveSeed(f);
    const fresh = await dry(f);
    expect(fresh.did).not.toBe(old.did);
    expect(await f.run('--submit')).toBe(2);
    expect(f.net.lookups()).toHaveLength(3);
    for (const name of RESOLVER_NAMES) expect(errorText(f)).toContain(name);
    expect(errorText(f)).toContain(`publish the TXT value ${fresh.did} at _did.${ECHO.domain}, then run again`);
    untouched(f);
    publish(f, fresh);
    expect(await f.run('--submit')).toBe(0);
  });
  for (const hidden of RESOLVER_NAMES) {
    it(`stops when the TXT value is missing on ${hidden}, asks the three resolvers once each, names ${hidden}, and signs nothing`, async () => {
      const f = await fixture();
      f.refuseSigning = true;
      const shown = await dry(f);
      publish(f, shown, RESOLVER_NAMES.filter((name) => name !== hidden));
      expect(await f.run('--submit')).toBe(2);
      expect(f.net.lookups().map((url) => url.host).sort()).toEqual(RESOLVERS.map((resolver) => new URL(resolver.url).host).sort());
      expect(f.net.lookups().map((url) => dnsQuestion(url).name)).toEqual([shown.txt!.name, shown.txt!.name, shown.txt!.name]);
      const text = errorText(f);
      expect(text).toContain(`publish the TXT value ${shown.did} at ${shown.txt!.name}, then run again`);
      expect(text).toContain(hidden);
      for (const name of RESOLVER_NAMES.filter((one) => one !== hidden)) expect(text.slice(text.indexOf('Not seen'))).not.toContain(name);
      untouched(f);
      // The twin: the value on the third resolver too, and the run lands.
      f.refuseSigning = false;
      publish(f, shown, [hidden]);
      expect(await f.run('--submit')).toBe(0);
    });
  }
  it('stops when only two of the three resolvers show the value', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown, ['cloudflare']);
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.machine()).toMatchObject({ outcome: 'stopped', exit: 2 });
    untouched(f);
  });
  /** The data with another domain for the organisation of an agent: the organisation and the Accountable party of the agent name it. */
  const withDomain = (use: UseCase, agentId: string, organisationId: string, domain: string): UseCase => ({
    ...use,
    organisations: use.organisations.map((one) => (one.id === organisationId ? { ...one, domain } : one)),
    agents: use.agents.map((agent) => (agent.id === agentId ? { ...agent, parties: agent.parties.map((party) => (party.role === 'Accountable' ? { ...party, organisation: domain } : party)) } : agent)),
  });
  it('stops when the data changed after the dry run so that the TXT name is another name: the note holds the name that was shown, and no resolver is asked', async () => {
    const f = await fixture();
    publish(f, await dry(f));
    f.use = withDomain(USE, 'reorder-agent', 'echo', 'changed.example');
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('the data changed after the dry run');
    expect(errorText(f)).toContain('_did.changed.example');
    expect(f.net.urls).toEqual([]);
    untouched(f);
    // The twin: a dry run of the new data writes a new note, and the value that is published at the new name lets the run land.
    publish(f, await dry(f));
    expect(await f.run('--submit')).toBe(0);
    expect(f.net.lookups().every((url) => dnsQuestion(url).name === '_did.changed.example')).toBe(true);
  });
  it('stops before it builds when the domain of the organisation is not the domain of an Accountable party of the record, because the gateway would check another name than the TXT name', async () => {
    const f = await fixture();
    f.use = { ...USE, agents: USE.agents.map((agent) => (agent.id === 'reorder-agent' ? { ...agent, parties: agent.parties.map((party) => (party.role === 'Accountable' ? { ...party, organisation: 'other.example' } : party)) } : agent)) };
    expect(await f.run()).toBe(2);
    expect(errorText(f)).toContain('no Accountable party of the record names that domain');
    expect(f.hosted.calls).toEqual([]);
    f.use = USE;
    expect(await f.run()).toBe(0);
  });
  it('lands the record when all three show the value: the three lookups, the signatures, the step, the facts, the cap, the evidence, and the record on the world', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    expect(await f.run('--submit')).toBe(0);
    const built = f.hosted.built[1]!;
    expect(f.net.lookups()).toHaveLength(3);
    expect(f.w.machine()).toMatchObject({ mode: 'submit', outcome: 'done', exit: 0, step: 'reorder-agent' });
    expect(resultOf(f)).toMatchObject({ subject: 'reorder-agent', did: shown.did, txt: shown.txt, tx: built.txHash, record_ref: `${built.txHash}#${built.recordOutputIndex}` });
    // Nine keys signed, each once: the signers of the record, with the controller counted once.
    expect(f.signs.map((hash) => registry(f).nameOfHash(hash)).sort()).toEqual([...shown.signers].sort());
    expect(f.world.chain.applied).toHaveLength(1);
    const step = f.w.state('register').steps['reorder-agent']!;
    expect(step).toMatchObject({ tx_hash: built.txHash, verified_at: expect.any(String), refs: { did: shown.did, id: idOf(shown.did), recordRef: `${built.txHash}#${built.recordOutputIndex}` } });
    expect(f.w.facts().records['reorder-agent']).toEqual({
      did: shown.did, id: idOf(shown.did), tx: built.txHash, recordRef: `${built.txHash}#${built.recordOutputIndex}`, depositLovelace: built.depositLovelace.toString(), registeredAt: step.confirmed_at,
    });
    expect(f.w.facts().organisations['reorder-agent']).toEqual({ txtName: `_did.${ECHO.domain}`, txtValue: shown.did, verifiedAt: null });
    expect(f.w.exposure()).toHaveLength(1);
    expect(f.w.exposure()[0]).toMatchObject({ step: 'reorder-agent' });
    expect(BigInt(f.w.exposure()[0]!.net_lovelace)).toBeGreaterThan(0n);
    expect(f.w.evidence('register').map((entry) => [entry.step, entry.status])).toEqual([['reorder-agent', 'confirmed'], ['reorder-agent', 'info']]);
  });
  it('needs the tag record in the approval: without it nothing is asked of the tool, nothing is looked up, and nothing is signed', async () => {
    const f = await fixture({ go: { irreversible: [] } });
    const shown = await dry(f);
    publish(f, shown);
    f.hosted.calls.length = 0;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('record');
    expect(f.hosted.calls).toEqual([]);
    expect(f.net.urls).toEqual([]);
    untouched(f);
    f.w.writeGo({ tasks: ['register'], irreversible: ['record'], capUnits: 100 });
    expect(await f.run('--submit')).toBe(0);
  });
});

// ---- the signers ----

describe('register: the signers of the build', () => {
  it('refuses a build with a party that the data does not have, because its key signs and the key is not in the planned set, before any lookup and any signature', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    f.net.urls.length = 0;
    f.hosted.change = (args) => ({ ...args, parties: [...args.parties, { role: 'Distributor', signer: registry(f).hashOf('order-desk-service'), rights: [] }] });
    f.refuseSigning = true;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('extra order-desk-service');
    expect(f.net.urls).toEqual([]);
    untouched(f);
    f.hosted.change = (args) => args;
    f.refuseSigning = false;
    expect(await f.run('--submit')).toBe(0);
  });
  it('refuses a build that lacks a key of the data, and names it', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    f.net.urls.length = 0;
    f.hosted.change = (args) => ({ ...args, keys: args.keys.slice(0, 3) });
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('missing reorder-delegation-2');
    expect(f.net.urls).toEqual([]);
    untouched(f);
  });
});

// ---- the consent of Module-1 inside the task ----

describe('register: the consent of Module-1 is the first check before a signature', () => {
  it('refuses a consent that does not take the whole balance with no note and no lookup, and says the consent and not the note', async () => {
    const f = await fixture();
    f.hosted.after = () => { f.account.rewards += 1n; };
    f.refuseSigning = true;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('nothing_else');
    expect(errorText(f)).toContain('the whole balance');
    expect(errorText(f)).not.toContain('run the dry run');
    expect(f.net.urls).toEqual([]);
    untouched(f);
    // The twin: the same run with a consent that is right goes on to the check of the note.
    f.hosted.after = () => undefined;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('run the dry run, publish the TXT value, then run again');
  });
  it('refuses it also when the note is there and the TXT value is public on all three resolvers: the TXT is not looked up', async () => {
    const f = await fixture();
    publish(f, await dry(f));
    f.hosted.after = () => { f.account.rewards = 1n; };
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('whole balance');
    expect(f.net.lookups()).toEqual([]);
    untouched(f);
    f.hosted.after = () => undefined;
    expect(await f.run('--submit')).toBe(0);
  });
  it('refuses a build with no withdrawal for an agent whose data names Module-1: the tool left the Module-1 party out', async () => {
    const f = await fixture();
    publish(f, await dry(f));
    f.net.urls.length = 0;
    f.hosted.change = (args) => ({ ...args, parties: args.parties.filter((party) => party.signer !== 'module1') });
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('Module-1 is a party of the record');
    expect(f.net.urls).toEqual([]);
    untouched(f);
  });
  it('says 1 withdrawal for the Reorder Agent and none for its subagent, and refuses a subagent that a tool made with a Module-1 party', async () => {
    const f = await fixture();
    await registered(f);
    expect(f.w.screen.lines.some((line) => /nothing_else\s+1 withdrawal\(s\), as the step says/.test(line))).toBe(true);
    f.hosted.change = (args) => ({ ...args, parties: [...args.parties, { role: 'Responsible', signer: 'module1' }] });
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('no party of the record is Module-1');
    expect(steps(f)).toEqual(['reorder-agent']);
    f.hosted.change = (args) => args;
    expect(await f.run()).toBe(0);
    expect(f.w.screen.lines.some((line) => /nothing_else\s+no withdrawal and no certificate/.test(line))).toBe(true);
  });
  it('checks the consent of the Order Desk the same way: before its note and before any lookup', async () => {
    const f = await fixture();
    await registered(f);
    await registered(f);
    f.net.urls.length = 0;
    f.hosted.after = () => { f.account.rewards += 1n; };
    expect(await f.run('--submit')).toBe(2);
    expect(f.w.machine()).toMatchObject({ outcome: 'stopped', step: 'order-desk' });
    expect(errorText(f)).toContain('the whole balance');
    expect(errorText(f)).not.toContain('run the dry run');
    expect(f.net.urls).toEqual([]);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader']);
  });
});

// ---- --all, and the subagent ----

describe('register --all', () => {
  it('registers the Reorder Agent with its note, then the subagent with no TXT and no note, and stops at the Order Desk with no note, with no lookup for it', async () => {
    const f = await fixture();
    const first = await dry(f);
    publish(f, first);
    // The run signed two records before it stopped, so the runner says that it failed (exit 1): exit 2 is for a run that signed nothing, as the run of the twin test above.
    expect(await f.run('--submit', '--all')).toBe(1);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader']);
    expect(errorText(f)).toContain('run the dry run, publish the TXT value, then run again');
    expect(errorText(f)).toContain('landed in this run');
    expect(f.w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'order-desk' });
    // Three lookups, all for the first record: the subagent has no TXT, and the Order Desk was not looked up.
    expect(f.net.lookups()).toHaveLength(3);
    expect(f.net.lookups().every((url) => dnsQuestion(url).name === first.txt!.name)).toBe(true);
    expect(Object.keys(f.w.state('register').notes).sort()).toEqual(['dry.reorder-agent']);
    const records = f.w.facts().records;
    expect(Object.keys(records).sort()).toEqual(['reorder-agent', 'stock-reader']);
    // The subagent names its parent, has no endpoint and no capability, and its DID is not the DID of its parent.
    const sub = f.hosted.calls.find((call) => call.args.parent !== undefined)!;
    expect(sub.args).toEqual({
      changeAddress: feeAddress(f), controller: registry(f).publicKeyOf('controller'), name: STOCK_READER.name, description: STOCK_READER.description, parent: records['reorder-agent']!.did,
      keys: [{ key: registry(f).publicKeyOf('stock-reader-auth'), purposes: ['authentication'] }, { key: registry(f).publicKeyOf('stock-reader-delegation'), purposes: ['delegation'] }],
      parties: [{ role: 'Accountable', signer: 'controller' }], guardian_threshold: 0, deposit: 10, valid_minutes: 30,
    });
    expect(records['stock-reader']!.did).not.toBe(records['reorder-agent']!.did);
    expect(f.signs).toHaveLength(9 + 4);
  });
  it('shows the DID of the Order Desk only after the two records before it landed, and then registers it', async () => {
    const f = await fixture();
    const first = await dry(f);
    publish(f, first);
    expect(await f.run('--submit', '--all')).toBe(1);
    const shown = await dry(f);
    expect(shown.subject).toBe('order-desk');
    expect(shown.txt).toEqual({ name: `_did.${ALFA.domain}`, value: shown.did });
    expect(shown.did).not.toBe(first.did);
    expect(f.hosted.built.at(-1)!.seed).not.toBe(f.hosted.built[0]!.seed);
    expect(f.w.screen.lines.some((line) => /nothing_else\s+1 withdrawal\(s\), as the step says/.test(line))).toBe(true);
    publish(f, shown);
    expect(await f.run('--submit')).toBe(0);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader', 'order-desk']);
    expect(f.w.facts().records['order-desk']!.did).toBe(shown.did);
    expect(f.w.facts().organisations['order-desk']).toMatchObject({ txtName: `_did.${ALFA.domain}`, txtValue: shown.did, verifiedAt: null });
    expect(shown.signers).toEqual(['controller', 'fee', 'order-small-supplier', 'order-medium-supplier', 'order-large-supplier', 'order-desk-service', 'accountable-alfa', 'provider', 'guardian-alfa']);
  });
});

describe('register: the subagent and its parent', () => {
  const parentUnit = (f: Fixture): string => `${DEPLOYMENT.identity.hash}${idOf(f.w.facts().records['reorder-agent']!.did)}`;
  it('waits with exit 4 and the reason when the node does not show the parent yet, builds nothing, and goes on when it does', async () => {
    const f = await fixture();
    await registered(f);
    const record = f.world.chain.held.find((utxo) => utxo.assets[parentUnit(f)] === 1n)!;
    f.world.chain.held = f.world.chain.held.filter((utxo) => utxo !== record);
    f.hosted.calls.length = 0;
    expect(await f.run('--submit')).toBe(4);
    expect(errorText(f) + f.w.screen.lines.join('\n')).toContain('the record of the parent reorder-agent');
    expect(f.w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'stock-reader' });
    expect(f.hosted.calls).toEqual([]);
    expect(steps(f)).toEqual(['reorder-agent']);
    f.world.chain.held.push(record);
    expect(await f.run('--submit')).toBe(0);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader']);
  });
  it('stops with exit 2 when the parent is not Active, names the status, and builds nothing', async () => {
    const f = await fixture();
    await registered(f);
    const record = f.world.chain.held.find((utxo) => utxo.assets[parentUnit(f)] === 1n)!;
    const datum = decodeIdentityDatum(record.datum!);
    const hold = { by: { type: 'ControllerSet' as const }, reason: 6, since: NOW - MINUTE, until: NOW + 7 * 86_400_000 };
    const suspended = { ...record, datum: encodeIdentityDatum({ ...datum, status: { type: 'Suspended', holds: [hold] } }) };
    f.world.chain.held = f.world.chain.held.map((utxo) => (utxo === record ? suspended : utxo));
    f.hosted.calls.length = 0;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('Suspended');
    expect(f.hosted.calls).toEqual([]);
    expect(steps(f)).toEqual(['reorder-agent']);
    f.world.chain.held = f.world.chain.held.map((utxo) => (utxo === suspended ? record : utxo));
    expect(await f.run('--submit')).toBe(0);
  });
  it('stops with exit 2 when the facts file does not hold the parent, and builds nothing', async () => {
    const f = await fixture();
    // The state file says that the parent is confirmed and verified, and the facts file has no record of it.
    const state = StateFile.open(`${f.w.stateDir}/register.state.json`, { check: 'register', network: 'vector-mainnet', record: USE_CASE });
    state.recordStep('reorder-agent', { confirmed_at: iso(NOW), tx_hash: hashOf('a record'), refs: {}, facts: {}, verified_at: iso(NOW) });
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('the parent reorder-agent is not in the facts file');
    expect(f.hosted.calls).toEqual([]);
    expect(f.w.machine()).toMatchObject({ exit: 2, step: 'stock-reader' });
  });
});

// ---- the preconditions of the wallet ----

describe('register: the wallet of the key fee', () => {
  it('stops before it builds when the wallet has no pure output of 5 units or more, and says how to make one', async () => {
    const f = await fixture({ fee: [3_000_000n, 2_000_000n] });
    expect(await f.run()).toBe(2);
    expect(errorText(f)).toContain('no pure output of 5 units or more');
    expect(errorText(f)).toContain(feeAddress(f));
    expect(f.hosted.calls).toEqual([]);
    const twin = await fixture({ fee: [5_000_000n, 50_000_000n] });
    expect(await twin.run()).toBe(0);
  });
  it('stops before it builds when the wallet cannot pay the deposit and the fee, and names both amounts', async () => {
    const f = await fixture({ fee: [11_000_000n] });
    expect(await f.run()).toBe(2);
    expect(errorText(f)).toContain('holds 11.000000 units');
    expect(errorText(f)).toContain('needs 12.000000 units');
    expect(f.hosted.calls).toEqual([]);
    expect(await (await fixture({ fee: [5_000_000n, 20_000_000n] })).run()).toBe(0);
  });
});

// ---- the record in the build, before any signature ----

describe('register: the record in the build is the record of the data, before any signature', () => {
  type Tamper = (args: RegisterArgs, keys: Fixture['w']['keys']['registry']) => RegisterArgs;
  const swapped: Tamper = (args, keys) => ({
    ...args,
    parties: args.parties.map((party) => (party.role === 'Accountable' ? { ...party, signer: keys.hashOf('provider') } : party.role === 'Provider' ? { ...party, signer: keys.hashOf('accountable-echo') } : party)),
  });
  const TAMPERS: Array<[string, Tamper, string]> = [
    ['the endpoint', (args) => ({ ...args, endpoint: 'https://elsewhere.example' }), 'the endpoint of the record'],
    ['the capabilities', (args) => ({ ...args, capabilities: [...(args.capabilities ?? []), 'extra.capability.v1'] }), 'the capabilities of the record'],
    ['the name', (args) => ({ ...args, name: 'Another Name' }), 'the name of the record'],
    ['the description', (args) => ({ ...args, description: 'Another description.' }), 'the description of the record'],
    ['the purposes of a key', (args) => ({ ...args, keys: args.keys.map((key, index) => (index === 1 ? { ...key, purposes: ['authentication'] } : key)) }), 'reorder-service'],
    ['the rights of a party', (args) => ({ ...args, parties: args.parties.map((party) => (party.role === 'Provider' ? { ...party, rights: ['suspend'] } : party)) }), 'Provider'],
    ['the organisation of a party', (args) => ({ ...args, parties: args.parties.map((party) => (party.role === 'Accountable' ? { ...party, organisation: 'other.example' } : party)) }), 'organisation'],
    ['the guardian threshold', (args) => ({ ...args, guardian_threshold: 1 }), 'guardian threshold'],
    ['the controller: the key reorder-service in place of the controller key', (args, keys) => ({ ...args, controller: keys.publicKeyOf('reorder-service') }), 'the controller of the record'],
    ['the signers of the Accountable and the Provider party swapped', swapped, 'has another signer'],
    ['an end of 2 hours for the Accountable party', (args) => ({ ...args, parties: args.parties.map((party) => (party.role === 'Accountable' ? { ...party, not_after: NOW + 2 * 3_600_000 } : party)) }), 'names no end'],
    ['a removal time for the Provider party', (args) => ({ ...args, parties: args.parties.map((party) => (party.role === 'Provider' ? { ...party, removal_after: NOW + 30 * 86_400_000 } : party)) }), 'the removal time'],
    ['a start in the future for the Provider party', (args) => ({ ...args, parties: args.parties.map((party) => (party.role === 'Provider' ? { ...party, not_before: NOW + 86_400_000 } : party)) }), 'starts at'],
    ['a framework', (args) => ({ ...args, framework: 'LangChain' }), 'the framework of the record'],
  ];
  for (const [label, change, phrase] of TAMPERS) {
    it(`refuses a build with another record than the data (${label}), in a dry run with no note and in a submit run before any signature, and lands the honest twin`, async () => {
      const f = await fixture();
      f.hosted.change = (args) => change(args, registry(f));
      expect(await f.run()).toBe(2);
      expect(errorText(f)).toContain(phrase);
      expect(f.w.state('register').notes).toEqual({});
      expect(f.w.machine().result).toEqual({});
      // The honest dry run writes the note, and the value is published. The same build with the other record is then refused in a submit run before any signature.
      f.hosted.change = (args) => args;
      const shown = await dry(f);
      publish(f, shown);
      f.hosted.change = (args) => change(args, registry(f));
      f.refuseSigning = true;
      expect(await f.run('--submit')).toBe(2);
      expect(errorText(f)).toContain(phrase);
      untouched(f);
      f.hosted.change = (args) => args;
      f.refuseSigning = false;
      expect(await f.run('--submit')).toBe(0);
    });
  }
  it('refuses a subagent that the tool built as a root record with no parent, before any signature, and lands the honest twin', async () => {
    const f = await fixture();
    await registered(f);
    const signed = f.signs.length;
    f.hosted.change = ({ parent: _parent, ...rest }) => rest;
    f.refuseSigning = true;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('as its parent');
    expect(f.signs).toHaveLength(signed);
    expect(f.world.chain.applied).toHaveLength(1);
    expect(steps(f)).toEqual(['reorder-agent']);
    f.hosted.change = (args) => args;
    f.refuseSigning = false;
    expect(await f.run('--submit')).toBe(0);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader']);
  });
  it('prints the members of the record that the build holds in a dry run, and the parent link of a subagent', async () => {
    const f = await fixture();
    const first = await dry(f);
    for (const line of [
      'record controller: controller', `record name: ${REORDER.name}`, `record endpoint: ${REORDER.endpoint}`, `record capabilities: ${REORDER.capability}`,
      'record key 1: reorder-supplier with the purposes authentication and transaction', 'record key 3: reorder-delegation-1 with the purposes delegation',
      `record party 1: Accountable, key accountable-echo, organisation ${ECHO.domain}, rights suspend and revoke`, 'record party 2: Responsible, Module-1, organisation none, rights suspend',
      'record party 3: Provider, key provider, organisation none, rights none', 'record party 5: Guardian, key controller, organisation none, rights recover',
      'record guardian threshold: 2', 'record lineage: root',
    ]) expect(f.w.screen.lines, line).toContain(line);
    publish(f, first);
    expect(await f.run('--submit')).toBe(0);
    expect(await f.run()).toBe(0);
    for (const line of ['record controller: controller', 'record endpoint: none', 'record party 1: Accountable, the controller, organisation none, rights suspend and revoke', `record lineage: subagent of ${first.did}`]) {
      expect(f.w.screen.lines, line).toContain(line);
    }
  });
  it('fails after the landing, with the name of what differs, when the node shows another record than the build, and the step stays unverified', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    const unit = `${DEPLOYMENT.identity.hash}${idOf(shown.did)}`;
    const read = f.world.chain.getUtxos.bind(f.world.chain);
    f.world.chain.getUtxos = async (address) => (await read(address)).map((utxo) => (
      utxo.assets[unit] === 1n ? { ...utxo, datum: encodeIdentityDatum({ ...decodeIdentityDatum(utxo.datum!), endpoint: utf8Hex('https://elsewhere.example') }) } : utxo
    ));
    expect(await f.run('--submit')).toBe(1);
    expect(errorText(f)).toContain('the endpoint of the record');
    expect(errorText(f)).toContain(shown.did);
    expect(f.w.state('register').steps['reorder-agent']).toMatchObject({ verified_at: null });
    expect(await f.run('--submit')).toBe(1);
  });
  it('verifies at the next run when the node did not show the record at the first read, and the facts that were written first are not written twice', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    f.hosted.after = () => undefined;
    const unit = `${DEPLOYMENT.identity.hash}${idOf(shown.did)}`;
    // The node shows no record at the first read: the world holds it only after the first verify has failed.
    const read = f.world.chain.getUtxos.bind(f.world.chain);
    let hidden = true;
    f.world.chain.getUtxos = async (address) => (await read(address)).filter((utxo) => !(hidden && utxo.assets[unit] === 1n));
    expect(await f.run('--submit')).toBe(1);
    expect(errorText(f)).toContain('is not on the node');
    expect(f.w.state('register').steps['reorder-agent']).toMatchObject({ verified_at: null });
    const facts = f.w.facts().records['reorder-agent'];
    expect(facts).toMatchObject({ did: shown.did });
    hidden = false;
    // The next run verifies the step first, and then shows the next step. A dry run changes nothing else.
    expect(await f.run()).toBe(0);
    expect(f.w.state('register').steps['reorder-agent']).toMatchObject({ verified_at: expect.any(String) });
    expect(f.w.facts().records['reorder-agent']).toEqual(facts);
    expect(f.world.chain.applied).toHaveLength(1);
  });
});

// ---- the wait for the organisation check ----

describe('register: the wait for the organisation check', () => {
  const left = async (f: Fixture): Promise<Result[]> => allThree(f);
  const verifyAt = (f: Fixture, record: Result, verified: boolean, over: Partial<GatewayEntry> = {}): void => {
    const organisation = record.subject === 'reorder-agent' ? ECHO.domain : ALFA.domain;
    f.net.gateway.set(record.did, { organisation, verified, ...over });
  };
  it('waits with exit 4 while the gateway has no record and while it does not show the organisation, with the time left, and verifies when it does', async () => {
    const f = await fixture();
    const [reorder, , desk] = await left(f);
    f.net.urls.length = 0;
    expect(await f.run('--submit')).toBe(4);
    expect(f.w.machine()).toMatchObject({ outcome: 'wait', exit: 4, step: 'organisation:reorder-agent' });
    expect(f.w.screen.lines.join('\n')).toMatch(/WAIT: .*no record.*4[0-5] min/);
    expect(f.net.urls).toEqual([`${GATEWAY}/1.0/identifiers/${reorder!.did}`]);
    verifyAt(f, reorder!, false);
    expect(await f.run('--submit')).toBe(4);
    expect(f.w.facts().organisations['reorder-agent']!.verifiedAt).toBeNull();
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader', 'order-desk']);
    verifyAt(f, reorder!, true);
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'done', step: 'organisation:reorder-agent' });
    expect(f.w.facts().organisations['reorder-agent']!.verifiedAt).toBe(iso(NOW));
    expect(f.w.state('register').steps['organisation:reorder-agent']).toMatchObject({ tx_hash: null, verified_at: iso(NOW) });
    // The next step is the organisation of the Order Desk.
    expect(await f.run('--submit')).toBe(4);
    expect(f.w.machine()).toMatchObject({ step: 'organisation:order-desk' });
    verifyAt(f, desk!, true);
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.facts().organisations['order-desk']!.verifiedAt).toBe(iso(NOW));
    const facts = JSON.stringify(f.w.facts());
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'finished', exit: 0 });
    expect(JSON.stringify(f.w.facts())).toBe(facts);
    // The step takes no transaction: nothing was signed after the three records.
    expect(f.signs).toHaveLength(9 + 4 + 9);
  });
  it('is never a failure before its time: until 45 minutes after the registration it waits, also when the gateway cannot be reached, and after that it fails and names the checks', async () => {
    const f = await fixture();
    const [reorder] = await left(f);
    const registeredAt = Date.parse(f.w.facts().records['reorder-agent']!.registeredAt);
    verifyAt(f, reorder!, false);
    for (const at of [registeredAt, registeredAt + 44 * MINUTE, registeredAt + 45 * MINUTE - 1]) {
      f.w.clock.t = at;
      expect(await f.run('--submit'), String(at - registeredAt)).toBe(4);
    }
    f.net.gatewayFails = new Error('the gateway is down');
    f.w.clock.t = registeredAt + 10 * MINUTE;
    expect(await f.run('--submit')).toBe(4);
    expect(f.w.screen.lines.join('\n')).toContain('the gateway gave no answer');
    f.net.gatewayFails = null;
    f.w.clock.t = registeredAt + 45 * MINUTE;
    expect(await f.run('--submit')).toBe(1);
    const text = errorText(f);
    for (const phrase of ['_did.', 'every 10 minutes', '24 hours', 'update of the record']) expect(text).toContain(phrase);
    expect(text).toContain(f.w.facts().organisations['reorder-agent']!.txtValue);
    expect(f.w.machine()).toMatchObject({ outcome: 'failed', exit: 1, step: 'organisation:reorder-agent' });
    expect(f.w.facts().organisations['reorder-agent']!.verifiedAt).toBeNull();
    // The twin: verified even after the time limit, it ends the step.
    verifyAt(f, reorder!, true);
    expect(await f.run('--submit')).toBe(0);
  });
  it('counts only an Accountable party with the organisation of the record and organisationVerified true', async () => {
    const f = await fixture();
    const [reorder] = await left(f);
    for (const over of [{ organisation: 'other.example' }, { role: 'responsible' }, { role: 'guardian' }] as const) {
      verifyAt(f, reorder!, true, over);
      expect(await f.run('--submit'), JSON.stringify(over)).toBe(4);
    }
    verifyAt(f, reorder!, true, { role: 'Accountable' });
    expect(await f.run('--submit')).toBe(0);
  });
  it('fails at once when the gateway shows the record as ended, and does not wait', async () => {
    const f = await fixture();
    const [reorder] = await left(f);
    verifyAt(f, reorder!, true, { status: 'revoked' });
    expect(await f.run('--submit')).toBe(1);
    expect(errorText(f)).toContain('revoked');
  });
  it('reads and writes nothing in a dry run: a verified organisation is shown, and the step stays open', async () => {
    const f = await fixture();
    const [reorder] = await left(f);
    verifyAt(f, reorder!, true);
    expect(await f.run()).toBe(0);
    expect(f.w.machine()).toMatchObject({ mode: 'dry', outcome: 'dry', step: 'organisation:reorder-agent' });
    expect(f.w.facts().organisations['reorder-agent']!.verifiedAt).toBeNull();
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader', 'order-desk']);
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.facts().organisations['reorder-agent']!.verifiedAt).toBe(iso(NOW));
  });
});

describe('register: agents, subagents and additional records', () => {
  const flags = { has: () => false, value: () => undefined };
  const uc2Records = ['prior-authorization-agent', 'record-reader', 'drafter', 'insurer-intake-agent'];
  const uc3Records = ['sourcing-agent', 'scorer-1', 'scorer-2', 'scorer-3', 'bid-desk-alfa', 'bid-desk-bravo', 'bid-desk-charlie', 'bravo-successor'];
  const gatewayVerifies = (f: Fixture, shown: Result, did = shown.did): void => {
    f.net.gateway.set(shown.did, { organisation: shown.txt!.name.slice('_did.'.length), verified: true, did });
  };

  it('registers both prior authorization subagents in order after their parent', async () => {
    const f = await fixture({ use: UC2 });
    expect(register.steps(UC2, flags)).toEqual([...uc2Records, 'organisation:prior-authorization-agent', 'organisation:insurer-intake-agent']);
    const parent = await registered(f);
    const reader = await registered(f);
    const drafter = await registered(f);
    const intake = await registered(f);
    expect(steps(f)).toEqual(uc2Records);
    for (const child of [reader, drafter]) {
      expect(child.txt).toBeNull();
      expect(child.signers).toEqual(['controller', 'fee', `${child.subject}-auth`, `${child.subject}-delegation`]);
    }
    gatewayVerifies(f, parent);
    gatewayVerifies(f, intake);
    expect(await f.run('--submit', '--all')).toBe(0);
    expect(Object.keys(f.w.facts().organisations)).toEqual(['prior-authorization-agent', 'insurer-intake-agent']);
  });

  it('requires an Active scorer parent and keeps the Bravo successor TXT and verification separate', async () => {
    const f = await fixture({ use: UC3 });
    expect(register.steps(UC3, flags)).toEqual([...uc3Records, ...['sourcing-agent', 'bid-desk-alfa', 'bid-desk-bravo', 'bid-desk-charlie', 'bravo-successor'].map((id) => `organisation:${id}`)]);
    const sourcing = await registered(f);
    const parent = f.world.chain.held.find((out) => out.assets[`${DEPLOYMENT.identity.hash}${idOf(sourcing.did)}`] === 1n)!;
    const original = parent.datum!;
    const hold = { by: { type: 'ControllerSet' as const }, reason: 6, since: NOW - MINUTE, until: NOW + MINUTE };
    parent.datum = encodeIdentityDatum({ ...decodeIdentityDatum(original), status: { type: 'Suspended', holds: [hold] } });
    const before = f.hosted.built.length;
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('only an Active record can start a subagent');
    expect(f.hosted.built).toHaveLength(before);
    parent.datum = original;
    for (const id of ['scorer-1', 'scorer-2', 'scorer-3']) {
      const scorer = await registered(f);
      expect(scorer).toMatchObject({ subject: id, txt: null, signers: ['controller', 'fee', `${id}-auth`, `${id}-delegation`] });
      expect(f.hosted.calls.at(-1)?.args.parent).toBe(sourcing.did);
    }
    const alfa = await registered(f);
    const bravo = await registered(f);
    const charlie = await registered(f);
    const successor = await dry(f);
    expect(successor).toMatchObject({ subject: 'bravo-successor', txt: { name: bravo.txt!.name, value: successor.did }, signers: ['controller', 'fee', 'bravo-successor-auth', 'accountable-bravo'] });
    expect(successor.did).not.toBe(bravo.did);
    const signed = f.signs.length;
    const previousLookups = f.net.lookups().length;
    expect(await f.run('--submit')).toBe(2);  // All three resolvers still have only Bravo's DID.
    expect(f.net.lookups()).toHaveLength(previousLookups + 3);
    expect(errorText(f)).toContain('not public on all three resolvers');
    expect(f.signs).toHaveLength(signed);
    publish(f, successor);
    expect(await f.run('--submit')).toBe(0);
    expect(f.hosted.calls.at(-1)?.args).not.toHaveProperty('endpoint');
    expect(f.hosted.calls.at(-1)?.args).not.toHaveProperty('capabilities');
    expect(f.hosted.calls.at(-1)?.args).not.toHaveProperty('parent');
    expect(steps(f)).toEqual(uc3Records);
    const organisations = f.w.facts().organisations;
    expect(organisations['bid-desk-bravo']).toEqual({ txtName: bravo.txt!.name, txtValue: bravo.did, verifiedAt: null });
    expect(organisations['bravo-successor']).toEqual({ txtName: bravo.txt!.name, txtValue: successor.did, verifiedAt: null });
    expect(organisations).not.toHaveProperty('bravo');

    for (const shown of [sourcing, alfa, bravo, charlie]) gatewayVerifies(f, shown);
    expect(await f.run('--submit', '--all')).toBe(4);
    expect(f.w.machine()).toMatchObject({ step: 'organisation:bravo-successor' });
    expect(f.w.facts().organisations['bid-desk-bravo']!.verifiedAt).toBe(iso(NOW));
    expect(f.w.facts().organisations['bravo-successor']!.verifiedAt).toBeNull();
    gatewayVerifies(f, successor, bravo.did);
    expect(await f.run('--submit')).toBe(4);
    expect(f.w.screen.text).toContain('a different DID');
    gatewayVerifies(f, successor);
    f.w.clock.t += MINUTE;
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.facts().organisations['bravo-successor']!.verifiedAt).toBe(iso(f.w.clock.now()));
  });
});

/** The pinned writer uses this ten-section envelope and these registration and gateway evidence shapes. */
function pinnedRegistration(f: Fixture, over: { pending?: boolean; badEvidence?: 'missing' | 'other DID' | 'conflicting'; missingOrganisationStep?: boolean } = {}) {
  const format = { useCase: USE_CASE, network: 'vector-mainnet' };
  const path = join(f.w.stateDir, 'facts.json');
  const header = { check: 'register', network: format.network, record: format.useCase };
  const state = StateFile.open(join(f.w.stateDir, 'register.state.json'), header);
  const verified = iso(NOW - MINUTE);
  const registered = iso(NOW - 2 * MINUTE);
  const journal = EvidenceFile.open(join(f.w.stateDir, 'register.evidence.json'), header, { clock: () => iso(NOW - MINUTE + 11) });
  const fixtures = { records: {}, organisations: {}, stakes: {}, adverts: {}, manifests: {}, attestations: {}, claims: {}, tenants: {}, holds: {}, deploy: null } as const;
  const moves = [REORDER, USE.agents[1]!].map((agent) => {
    const organisation = USE.organisations.find(({ id }) => id === agent.organisation)!;
    const tx = hashOf(`old register tx ${agent.id}`);
    const id = hashOf(`old record ${agent.id}`);
    const did = `${DID_PREFIX}${id}`;
    const record = { did, id, tx, recordRef: `${tx}#0`, depositLovelace: '10000000', registeredAt: registered };
    const fact = { txtName: `_did.${organisation.domain}`, txtValue: did, verifiedAt: over.pending === true && agent.id === 'order-desk' ? null : verified };
    return { from: organisation.id, to: agent.id, domain: organisation.domain, record, fact };
  });
  const readerTx = hashOf('old reader tx');
  const readerId = hashOf('old reader id');
  const reader = { to: 'stock-reader', record: { did: `${DID_PREFIX}${readerId}`, id: readerId, tx: readerTx, recordRef: `${readerTx}#0`, depositLovelace: '10000000', registeredAt: registered }, fact: null };
  const registeredRecords = [moves[0]!, reader, moves[1]!];
  for (const { to, record, fact } of registeredRecords) {
    const { did, id, tx, recordRef, depositLovelace } = record;
    if (fact !== null) state.setNote(`dry.${to}`, { did, txtName: fact.txtName, txtValue: fact.txtValue, at: iso(NOW - 3 * MINUTE) });
    state.recordStep(to, { tx_hash: tx, confirmed_at: registered, verified_at: registered, refs: { did, id, recordRef }, facts: { depositLovelace } });
    journal.add({ step: to, status: 'confirmed', tx_hash: tx, fee_lovelace: 500_000n, at: registered, shows: { refs: { did, id, recordRef }, facts: { depositLovelace } } });
    journal.add({ step: to, status: 'info', at: registered, shows: { verification: 'the record on the node is the record of the data', did } });
  }
  for (const { from, to, domain, record, fact } of moves) {
    if (fact.verifiedAt === null) continue;
    const name = `organisation:${to}`;
    if (to !== 'order-desk' || over.missingOrganisationStep !== true) {
      state.recordStep(name, { tx_hash: null, confirmed_at: verified, verified_at: verified, refs: { did: record.did }, facts: { organisation: from, domain } });
    }
    const isDesk = to === 'order-desk';
    const did = isDesk && over.badEvidence === 'other DID' ? moves[0]!.record.did : record.did;
    const shows = { organisation: from, domain, did, organisationVerified: true };
    if (!isDesk || over.badEvidence !== 'missing') journal.add({ step: name, status: 'info', shows });
    if (isDesk && over.badEvidence === 'conflicting') journal.add({ step: name, status: 'info', shows: { ...shows, organisationVerified: false } });
  }
  const records = Object.fromEntries(registeredRecords.map(({ to, record }) => [to, record]));
  const organisations = Object.fromEntries(moves.map(({ from, fact }) => [from, fact]));
  const envelope = { format: 1, ...format, facts: { ...fixtures, records, organisations } };
  const write = (): void => writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
  write();
  return { path, moves, organisations, records, write, store: FactsFile.open(path, format) };
}

describe('register: legacy organisation facts', () => {
  it('reads pinned writer bytes without a dry write and moves both facts once on submit', async () => {
    const f = await fixture();
    const old = pinnedRegistration(f);
    const source = readFileSync(old.path, 'utf8');
    expect(await f.run('status')).toBe(0);
    expect(await f.run()).toBe(0);
    expect(readFileSync(old.path, 'utf8')).toBe(source);
    expect(await f.run('--submit')).toBe(0);
    expect(f.w.machine()).toMatchObject({ outcome: 'finished' });
    expect(old.store.read().organisations).toEqual(Object.fromEntries(old.moves.map(({ to, fact }) => [to, fact])));
    expect(old.store.read().records).toEqual(old.records);
    const migrated = readFileSync(old.path, 'utf8');
    old.store.moveOrganisations(old.moves);
    expect(await f.run('--submit')).toBe(0);
    expect(readFileSync(old.path, 'utf8')).toBe(migrated);
    expect(f.net.urls).toEqual([]);
    expect(f.hosted.calls).toEqual([]);
    expect(f.signs).toEqual([]);
  });

  it('preserves a pending legacy fact without giving it another subject\'s verification', async () => {
    const f = await fixture();
    const old = pinnedRegistration(f, { pending: true });
    expect(await f.run('--submit')).toBe(4);
    const desk = old.moves[1]!;
    expect(f.net.urls).toEqual([`${GATEWAY}/1.0/identifiers/${desk.record.did}`]);
    expect(old.store.read().organisations['order-desk']).toEqual(desk.fact);
    expect(old.store.read().organisations['reorder-agent']).toEqual(old.moves[0]!.fact);
    f.net.gateway.set(desk.record.did, { organisation: desk.domain, verified: true });
    expect(await f.run('--submit')).toBe(0);
    expect(old.store.read().organisations['order-desk']!.verifiedAt).toBe(iso(NOW));
    expect(f.signs).toEqual([]);
  });

  it.each(['other DID', 'conflicting'] as const)('keeps every old byte when verification evidence is %s', async (badEvidence) => {
    const f = await fixture();
    const old = pinnedRegistration(f, { badEvidence });
    const source = readFileSync(old.path, 'utf8');
    expect(await f.run('--submit')).toBe(2);
    expect(errorText(f)).toContain('no matching verification evidence or its evidence conflicts');
    expect(readFileSync(old.path, 'utf8')).toBe(source);
    expect(f.net.urls).toEqual([]);
    expect(f.signs).toEqual([]);
  });

  it.each([true, false])('rechecks an interrupted legacy verification when the original step is missing: %s', async (missingOrganisationStep) => {
    const f = await fixture();
    const old = pinnedRegistration(f, { badEvidence: 'missing', missingOrganisationStep });
    const desk = old.moves[1]!;
    const previous = readFileSync(old.path, 'utf8');
    f.net.gateway.set(desk.record.did, { organisation: desk.domain, verified: true, did: old.moves[0]!.record.did });
    expect(await f.run('--submit')).toBe(4);
    expect(readFileSync(old.path, 'utf8')).toBe(previous);
    expect(f.w.screen.text).toContain('needs fresh verification');
    f.net.gateway.set(desk.record.did, { organisation: desk.domain, verified: true });
    // Simulate interruption after the observation but before the atomic facts move.
    writeFileSync(`${old.path}.lock`, '', { mode: 0o600 });
    expect(await f.run('--submit')).toBe(2);
    expect(readFileSync(old.path, 'utf8')).toBe(previous);
    const name = 'organisation:order-desk';
    const shown = { organisationVerified: true, did: desk.record.did, legacyVerifiedAt: desk.fact.verifiedAt, verifiedAt: iso(NOW), txtName: desk.fact.txtName, txtValue: desk.fact.txtValue };
    expect(f.w.evidence('register').filter(({ step }) => step === name)).toEqual([expect.objectContaining({ at: iso(NOW), shows: expect.objectContaining(shown) })]);
    rmSync(`${old.path}.lock`);
    f.net.urls.length = 0;
    expect(await f.run('--submit')).toBe(0);
    expect(f.net.urls).toEqual([]);
    expect(old.store.read().organisations['order-desk']).toEqual({ ...desk.fact, verifiedAt: iso(NOW) });
    expect(f.w.state('register').steps[name]).toMatchObject({ refs: { did: desk.record.did }, verified_at: iso(NOW) });
    expect(f.w.evidence('register').filter(({ step }) => step === name)).toHaveLength(1);
    expect(f.hosted.calls).toEqual([]);
    expect(f.signs).toEqual([]);
  });

  it.each(['wrong TXT name', 'wrong TXT value', 'missing TXT fact', 'missing record', 'ambiguous DID', 'conflicting target'] as const)('refuses a legacy map with %s', async (problem) => {
    const f = await fixture();
    const old = pinnedRegistration(f);
    const desk = old.moves[1]!;
    if (problem === 'wrong TXT name') old.organisations[desk.from] = { ...desk.fact, txtName: '_did.other.example' };
    if (problem === 'wrong TXT value') old.organisations[desk.from] = { ...desk.fact, txtValue: old.moves[0]!.fact.txtValue };
    if (problem === 'missing TXT fact') delete old.organisations[desk.from];
    if (problem === 'missing record') delete old.records[desk.to];
    if (problem === 'ambiguous DID') old.records.duplicate = desk.record;
    if (problem === 'conflicting target') old.organisations[desk.to] = { ...desk.fact, verifiedAt: null };
    old.write();
    const source = readFileSync(old.path, 'utf8');
    expect(await f.run('--submit')).toBe(2);
    expect(readFileSync(old.path, 'utf8')).toBe(source);
    expect(f.signs).toEqual([]);
  });

  it('removes an identical old key and refuses a stale attribution or a duplicate move without a partial write', async () => {
    const f = await fixture();
    const old = pinnedRegistration(f);
    const [first, second] = old.moves;
    old.store.put('organisations', [first!.to], first!.fact);
    const source = readFileSync(old.path, 'utf8');
    expect(() => old.store.moveOrganisations([first!, first!])).toThrow('uses one key more than once');
    expect(() => old.store.moveOrganisations([first!, { ...second!, record: { ...second!.record, tx: hashOf('a stale record') } }])).toThrow('record attribution');
    expect(readFileSync(old.path, 'utf8')).toBe(source);
    expect(await f.run('--submit')).toBe(0);
    expect(old.store.read().organisations).toEqual({ [first!.to]: first!.fact, [second!.to]: second!.fact });
    expect(f.signs).toEqual([]);
  });
});

// ---- what the files and the lines hold ----

describe('register: no key in any file or line', () => {
  it('writes no seed of any key into the screen, the state, the evidence or the facts, and a TXT value only as a public value', async () => {
    const f = await fixture();
    await allThree(f);
    const text = f.w.allText();
    for (const name of KEY_NAMES) expect(text, name).not.toContain(f.w.keys.seedOf(name));
    expect(text).not.toContain('PRIV_KEY');
  });
});

// ---- the answer of the tool ----

describe('register: the DID of the answer is the DID of the bytes', () => {
  const ANOTHER = 'ab'.repeat(32);
  it('fails when the answer gives a DID that is not did:vector: and its id, signs nothing, looks nothing up, and leaves the note of the honest dry run as it was', async () => {
    const f = await fixture();
    const shown = await dry(f);
    publish(f, shown);
    const note = f.w.state('register').notes['dry.reorder-agent'];
    f.hosted.answer = (extra) => ({ ...extra, did: `${DID_PREFIX}${ANOTHER}` });
    f.refuseSigning = true;
    expect(await f.run('--submit')).toBe(1);
    expect(errorText(f)).toContain('the DID of its id is');
    expect(f.net.urls).toEqual([]);
    untouched(f);
    expect(await f.run()).toBe(1);
    expect(f.w.state('register').notes['dry.reorder-agent']).toEqual(note);
    // The twin: the honest answer lands.
    f.hosted.answer = (extra) => extra;
    f.refuseSigning = false;
    expect(await f.run('--submit')).toBe(0);
  });
  it('refuses an answer whose identifier is not the token that its bytes mint, also in a dry run, and writes no note: a value that is not minted is never shown to publish', async () => {
    const f = await fixture({ go: null });
    f.hosted.answer = (extra) => ({ ...extra, did: `${DID_PREFIX}${ANOTHER}`, id: ANOTHER });
    expect(await f.run()).toBe(2);
    expect(errorText(f)).toContain('identity token');
    expect(f.w.state('register').notes).toEqual({});
    expect(f.w.machine().result).toEqual({});
    f.hosted.answer = (extra) => extra;
    expect(await f.run()).toBe(0);
  });
  it('fails when the identifier of the answer is not 64 lower-case hex characters', async () => {
    const f = await fixture({ go: null });
    for (const id of ['xyz', ANOTHER.toUpperCase(), ANOTHER.slice(2)]) {
      f.hosted.answer = (extra) => ({ ...extra, did: `${DID_PREFIX}${id}`, id });
      expect(await f.run(), id).toBe(1);
      expect(errorText(f)).toContain('no id of 64 lower-case hex characters');
    }
    expect(f.w.state('register').notes).toEqual({});
  });
});

// ---- the definition ----

describe('register: the definition of the task', () => {
  const flags = { has: () => false, value: () => undefined };
  it('is the task register with no flag of its own, and needs the chain, the two hosted tools and the approval of a submit run', () => {
    expect(register).toMatchObject({ name: 'register', flags: [], valued: [], needs: { chain: true, hosted: [TOOL, 'vector_resolve_did'], approval: 'submit' } });
  });
  it('lists the steps in order: each record with its subagents after it, and then the organisation of each agent', () => {
    expect(register.steps(USE, flags)).toEqual(['reorder-agent', 'stock-reader', 'order-desk', 'organisation:reorder-agent', 'organisation:order-desk']);
  });
  it('needs each key that a record names, once: all the keys of the use case but the run key, which the runner adds for a submit run', () => {
    const keys = register.needs.keys(USE, flags);
    expect(new Set(keys)).toEqual(new Set(KEY_NAMES.filter((name) => name !== 'run')));
    expect(keys).toHaveLength(new Set(keys).size);
  });
  it('loads through the loader of the pack as the task of its name, and has nothing to take back: a record is permanent', async () => {
    expect((await loadTask('register')).name).toBe('register');
    const f = await fixture({ go: null });
    expect(await f.run('cleanup')).toBe(0);
    expect(f.w.screen.lines.join('\n')).toContain('a record is permanent');
    expect(f.hosted.calls).toEqual([]);
  });
});

describe('register: a transaction in flight', () => {
  it('stops before it builds anything when the state file holds a transaction in flight: the runner settles a flight first, and this is a second guard', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'operator-flight-'));
    try {
      chmodSync(dir, 0o700);
      const state = StateFile.open(join(dir, 'register.state.json'), { check: 'register', network: 'vector-mainnet', record: USE_CASE });
      state.setInFlight({ step: 'reorder-agent', tx_hash: hashOf('a flight'), signed_cbor: 'aa', valid_to: NOW, signed_at: NOW, refs: {}, facts: {} });
      // The step reads the state file before anything else, so a session with a state file and the data is enough for it to stop.
      const session = { state, extra: { result: null }, use: USE, mode: 'submit', all: false } as unknown as Parameters<typeof register.next>[0];
      await expect(register.next(session)).rejects.toThrow('a transaction is in flight');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('register: a record is registered once', () => {
  it('stops before it builds when the facts file holds the record already, also for another run label, and a dry run says the same', async () => {
    const f = await fixture();
    await registered(f);
    f.hosted.calls.length = 0;
    const signed = f.signs.length;
    expect(await f.run('--run', 'again', '--submit')).toBe(2);
    expect(errorText(f)).toContain('the facts file holds the record reorder-agent already');
    expect(f.hosted.calls).toEqual([]);
    expect(f.signs).toHaveLength(signed);
    expect(f.world.chain.applied).toHaveLength(1);
    expect(Object.keys(f.w.state('register', 'again').steps)).toEqual([]);
    expect(await f.run('--run', 'again')).toBe(2);
    expect(f.hosted.calls).toEqual([]);
    // The twin: the run with no label goes on to the next record.
    expect(await f.run('--submit')).toBe(0);
    expect(steps(f)).toEqual(['reorder-agent', 'stock-reader']);
  });
});
