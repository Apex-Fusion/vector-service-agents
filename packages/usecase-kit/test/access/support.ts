// packages/usecase-kit/test/access/support.ts: what the tests of the access folder share. No test uses the network: the gateway is the stub of id-kit, a mock system is a server on a loopback
// port, the clock is moved by the test, and the ledger is an object in memory.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DelegateBuild, DelegateParams, UndelegateBuild, UndelegateParams } from '@vsa/buyer-core';
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import { tokenTarget } from '../../src/access/index.ts';
import type { Clock, DelegationChain, DelegationDatum, LiveDelegation, MockBases, Readiness, SubDelegationDeps, SubDelegationLimits, SubDelegationRequest, TokenTarget, TxSigner } from '../../src/access/index.ts';

/** Lets every promise that can go on, go on. It uses the real event loop, which no test moves. */
export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A clock that only the test moves. A sleep ends when the test moves the time to it, or when its signal aborts. */
export class FakeClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #timers: { due: number; seq: number; resolve: () => void }[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = { due: this.#now + ms, seq: (this.#seq += 1), resolve };
      this.#timers.push(timer);
      signal?.addEventListener('abort', () => {
        const at = this.#timers.indexOf(timer);
        if (at >= 0) this.#timers.splice(at, 1);
        resolve();
      }, { once: true });
    });
  }

  /** The number of sleeps that wait. */
  get waiting(): number {
    return this.#timers.length;
  }

  /** Moves the time forward by `ms`, and ends each sleep that falls due, in its order. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await settle();
      const due = this.#timers.filter((timer) => timer.due <= target).sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (due === undefined) break;
      this.#timers.splice(this.#timers.indexOf(due), 1);
      this.#now = Math.max(this.#now, due.due);
      due.resolve();
    }
    this.#now = target;
    await settle();
  }

  /**
   * Moves the time from sleep to sleep until `work` ends. It fails when no sleep waits and the work is not done: that is a wait with no end. It also fails after 100,000 steps. The test, and not the
   * work under test, says that a wait has no end, so a bug of that kind fails fast.
   */
  async run<T>(work: Promise<T>): Promise<T> {
    let done = false;
    work.then(() => (done = true), () => (done = true));
    for (let step = 0; ; step += 1) {
      await settle();
      if (done) return work;
      if (step >= 100_000) throw new Error('the fake clock ran 100,000 steps and the work did not end');
      const next = [...this.#timers].sort((a, b) => a.due - b.due || a.seq - b.seq)[0];
      if (next === undefined) throw new Error('nothing waits on the clock, and the work did not end: a wait with no end');
      this.#timers.splice(this.#timers.indexOf(next), 1);
      this.#now = Math.max(this.#now, next.due);
      next.resolve();
    }
  }
}

export interface StubRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}
export interface StubReply {
  readonly status: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}
type StubHandler = StubReply | ((request: StubRequest) => StubReply | Promise<StubReply>);

/** A mock system as a server on a loopback port. It records each request, and it answers what the test says. */
export interface StubServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  readonly requests: StubRequest[];
  reply(handler: StubHandler): void;
  close(): Promise<void>;
}

export async function startStub(): Promise<StubServer> {
  const requests: StubRequest[] = [];
  let handler: StubHandler = { status: 200, body: '{}' };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: StubRequest = { method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(request);
      void Promise.resolve(typeof handler === 'function' ? handler(request) : handler).then((reply) => {
        res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
        res.end(reply.body ?? '');
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    reply: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A `fetch` for a test that talks to a stub server: it sends a request for the public base of the mock service to the stub, as a reverse proxy does. The call still names the https URL. */
export const viaStub = (stub: StubServer): typeof fetch => (input, init) => fetch(String(input).replace(BASES.publicBase, stub.origin), init);
/** The two bases for a test with no server. */
export const BASES: MockBases = { publicBase: 'https://mock.example', mtlsBase: 'https://mock-mtls.example' };

/** The identity gateway as a stub: an agent that a hirer delegated to, and its subagent. The client reads the clock of the stub. */
export function gatewayWorld() {
  const gateway = createStubGateway();
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const hirer = ed25519Key('hirer');
  const agent = gateway.createAgent({ label: 'agent' });
  const reader = gateway.createAgent({ label: 'stock-reader', parent: agent });
  return { gateway, client, hirer, agent, reader };
}

export function expectTarget<T>(result: { ok: boolean; value?: T }): T {
  if (!result.ok || result.value === undefined) throw new Error('the target was refused');
  return result.value;
}
export function erpTarget(bases: MockBases = BASES, tenant = 'run1', sku = 'GLV-NIT-M'): TokenTarget {
  return expectTarget(tokenTarget(bases, tenant, 'erp.stock', { sku }));
}

/** The payload of a JWT, read and not checked. */
export function claimsOf(jwt: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

// ── the ledger of the sub-delegation ──

export const PARENT_ID = 'aa'.repeat(32);
export const SUBAGENT_ID = 'bb'.repeat(32);
export const AGENT_ID = 'cc'.repeat(32);
export const AGENT_KEY = '11'.repeat(28);
export const SUBAGENT_KEY = '22'.repeat(28);
export const OTHER_KEY = '33'.repeat(28);
export const WALLET = 'addr1_wallet_of_the_agent_key';
export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const DAY = 86_400_000;
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** A key that marks the transaction that it signs, so that a test sees who signed. */
export const markSigner = (keyHash: string): TxSigner => ({ keyHash, sign: (cbor) => `${cbor}+${keyHash.slice(0, 4)}` });

/** The delegation of the hirer to the agent, as the ledger shows it: it allows one more hop, and it has a value limit. */
export function parentDatum(over: Partial<DelegationDatum> = {}): DelegationDatum {
  return {
    delegator: { type: 'PrincipalKey', hash: '44'.repeat(28), organisation: null }, parent: null, delegate: AGENT_ID, delegateKey: AGENT_KEY,
    actions: ['erp.stock.read', 'po.write'].map(hex), resources: ['https://mock.example/t/run1/erp', 'https://mock.example/t/run1/po'].map(hex),
    notBefore: NOW - DAY, notAfter: NOW + 5 * DAY, depth: 1, remaining: 1, purpose: null, value: { perTx: 6_000_000n, total: 22_000_000n, periodMs: DAY }, ...over,
  };
}

export interface Faults {
  /** `readDelegation` throws. */
  readThrows?: boolean;
  readinessThrows?: boolean;
  /** `readiness` never answers. */
  readinessHangs?: boolean;
  /** `readiness` says that the chain cannot be used. */
  unusable?: boolean;
  /** The confirmations stay below 30. */
  neverConfirm?: boolean;
  buildDelegateThrows?: boolean;
  buildUndelegateThrows?: boolean;
  /** The node refuses the Delegate. */
  submitDelegateThrows?: boolean;
  /** The Delegate lands although the node answered with a failure. */
  delegateLandsAnyway?: boolean;
  submitUndelegateThrows?: boolean;
  /** The Undelegate is accepted and never lands. */
  undelegateNeverLands?: boolean;
  /** A third key must sign the Delegate. */
  extraSigner?: string;
}

/** The ledger as a sub-delegation sees it, in memory. A block takes 4 seconds, the Delegate lands after 2 blocks, and the Undelegate after 2 blocks. */
export class FakeDelegations implements DelegationChain {
  readonly log: string[] = [];
  readonly params: DelegateParams[] = [];
  readonly undelegateParams: UndelegateParams[] = [];
  readonly submitted: { kind: 'delegate' | 'undelegate'; cbor: string; at: number }[] = [];
  readonly faults: Faults = {};
  /** Plays a builder that gives another datum than the one that was asked for. */
  tamper: ((datum: DelegationDatum) => DelegationDatum) | null = null;
  parent: DelegationDatum | null;
  #sub: { id: string; datum: DelegationDatum; landsAt: number } | null = null;
  #endsAt: number | null = null;
  #count = 0;

  constructor(readonly clock: FakeClock, parent: DelegationDatum | null = parentDatum()) {
    this.parent = parent;
  }

  get subId(): string | null {
    return this.#sub?.id ?? null;
  }

  async readDelegation(id: string): Promise<LiveDelegation | null> {
    this.log.push(`read:${id === PARENT_ID ? 'parent' : 'sub'}`);
    if (this.faults.readThrows === true) throw new Error('the ledger cannot be read');
    if (id === PARENT_ID) return this.parent === null ? null : { id, delegation: this.parent };
    const sub = this.#sub;
    if (sub === null || id !== sub.id || this.clock.now() < sub.landsAt) return null;
    if (this.#endsAt !== null && this.clock.now() >= this.#endsAt) return null;
    return { id, delegation: sub.datum };
  }

  async readiness(id: string): Promise<Readiness> {
    this.log.push('readiness');
    if (this.faults.readinessThrows === true) throw new Error('the ledger cannot be read');
    if (this.faults.readinessHangs === true) return new Promise<Readiness>(() => undefined);
    if (this.faults.unusable === true) return { state: 'unusable', problems: ['the delegate is not Active'] };
    const sub = this.#sub;
    if (sub === null || id !== sub.id || this.clock.now() < sub.landsAt) return { state: 'waiting', confirmations: null };
    const confirmations = Math.floor((this.clock.now() - sub.landsAt) / 4_000);
    return this.faults.neverConfirm !== true && confirmations >= 30 ? { state: 'ready' } : { state: 'waiting', confirmations: Math.min(confirmations, 29) };
  }

  async buildDelegate(params: DelegateParams): Promise<DelegateBuild> {
    this.log.push('buildDelegate');
    this.params.push(params);
    if (this.faults.buildDelegateThrows === true) throw new Error('the parent delegation allows no further hop');
    const parent = this.parent!;
    const asked: DelegationDatum = {
      delegator: { type: 'Agent', id: parent.delegate }, parent: params.parent ?? null, delegate: params.delegate, delegateKey: params.delegateKey,
      actions: params.actions.map(hex), resources: (params.resources ?? []).map(hex), notBefore: params.notBefore ?? Math.max(this.clock.now() - 60_000, parent.notBefore),
      notAfter: params.notAfter, depth: parent.depth + 1, remaining: params.remaining ?? 0, purpose: null, value: params.value ?? null,
    };
    const datum = this.tamper === null ? asked : this.tamper(asked);
    this.#count += 1;
    const id = this.#count.toString(16).padStart(2, '0').repeat(32);
    const requiredSigners = [{ keyHash: parent.delegateKey, roles: ['delegate key of the parent'] }, { keyHash: params.delegateKey, roles: ['delegate key'] }];
    if (this.faults.extraSigner !== undefined) requiredSigners.push({ keyHash: this.faults.extraSigner, roles: ['wallet'] });
    this.#sub = { id, datum, landsAt: Number.MAX_SAFE_INTEGER };
    return {
      txCbor: `delegate:${id}`, txHash: `ee${id.slice(2)}`, fee: '230000', feeAda: '0.23', validFrom: this.clock.now() - 60_000, validTo: this.clock.now() + 1_800_000, requiredSigners, id, seed: 'ab#0',
      outputIndex: 0, outputLovelace: 2_400_000n, delegation: datum,
    };
  }

  async buildUndelegate(params: UndelegateParams): Promise<UndelegateBuild> {
    this.log.push('buildUndelegate');
    this.undelegateParams.push(params);
    const sub = this.#sub;
    if (this.faults.buildUndelegateThrows === true || sub === null || params.id !== sub.id || this.clock.now() < sub.landsAt) throw new Error(`No live delegation ${params.id}: it does not exist, or it is not confirmed yet.`);
    return {
      txCbor: `undelegate:${sub.id}`, txHash: `ff${sub.id.slice(2)}`, fee: '190000', feeAda: '0.19', validFrom: this.clock.now() - 60_000, validTo: this.clock.now() + 1_800_000,
      requiredSigners: [{ keyHash: AGENT_KEY, roles: ['delegation key of the delegator'] }], id: sub.id, delegation: sub.datum, releasedLovelace: 2_400_000n, authorityLink: 0, authority: 'the agent',
    };
  }

  async submit(signedCborHex: string): Promise<string> {
    const kind = signedCborHex.startsWith('delegate:') ? 'delegate' : 'undelegate';
    this.log.push(`submit:${kind}`);
    this.submitted.push({ kind, cbor: signedCborHex, at: this.clock.now() });
    if (kind === 'delegate') {
      if (this.faults.submitDelegateThrows === true) {
        if (this.faults.delegateLandsAnyway === true) this.#sub!.landsAt = this.clock.now() + 8_000;
        throw new Error('the node did not answer');
      }
      this.#sub!.landsAt = this.clock.now() + 8_000;
    } else {
      if (this.faults.submitUndelegateThrows === true) throw new Error('the node refused the transaction');
      if (this.faults.undelegateNeverLands !== true) this.#endsAt = this.clock.now() + 8_000;
    }
    return 'txhash';
  }
}

/** A world for `withSubDelegation`: a ledger, a clock, a valid request and valid limits. */
export interface SubWorld {
  readonly clock: FakeClock;
  readonly chain: FakeDelegations;
  readonly deps: SubDelegationDeps;
  readonly request: SubDelegationRequest;
  readonly limits: SubDelegationLimits;
  readonly target: TokenTarget;
}
export interface SubWorldOptions {
  readonly request?: Partial<SubDelegationRequest>;
  readonly limits?: Partial<SubDelegationLimits>;
  /** The delegation of the hirer to the agent. `null` is a parent that the ledger does not show. */
  readonly parent?: DelegationDatum | null;
}
export function subWorld(over: SubWorldOptions = {}): SubWorld {
  const clock = new FakeClock(NOW);
  const chain = new FakeDelegations(clock, over.parent);
  const target = erpTarget();
  const request: SubDelegationRequest = {
    target, parent: PARENT_ID, agent: { signer: markSigner(AGENT_KEY), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: markSigner(SUBAGENT_KEY) }, validForMs: 3_600_000,
    ...over.request,
  };
  const limits: SubDelegationLimits = { jobTimeoutMs: 600_000, ...over.limits };
  return { clock, chain, deps: { chain, clock }, request, limits, target };
}
