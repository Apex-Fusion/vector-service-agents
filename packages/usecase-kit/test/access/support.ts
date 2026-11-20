// packages/usecase-kit/test/access/support.ts: what the tests of the access folder share. No test uses the network: the gateway is the stub of id-kit, a mock system is a server on a loopback
// port, the clock is moved by the test, and the ledger is an object in memory.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CML } from '@lucid-evolution/lucid';
import type { DelegateBuild, DelegateParams, UndelegateBuild, UndelegateParams } from '@vsa/buyer-core';
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import { encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import { createSerialQueue, tokenTarget } from '../../src/access/index.ts';
import type {
  Clock, DelegationChain, DelegationDatum, DelegationScript, LiveDelegation, MockBases, Readiness, SerialQueue, SubDelegationDeps, SubDelegationLimits, SubDelegationRequest, TokenTarget, TxSigner,
} from '../../src/access/index.ts';

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
export const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
export const DAY = 86_400_000;
const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const MAINNET = 1;

/** The enterprise address of a key hash on mainnet, as text. */
export const walletOf = (keyHash: string): string => CML.EnterpriseAddress.new(MAINNET, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(keyHash))).to_address().to_bech32();
/** The wallet of the agent key: the address that pays the fees and gets the deposit back. */
export const WALLET = walletOf(AGENT_KEY);
/** A wallet that is not the wallet of the agent. */
export const STRANGER = walletOf(OTHER_KEY);
export const SCRIPT_HASH = 'ab'.repeat(28);
/** The delegation script of the tests: a hash and the address of that script. The real builder tests use the script of the identity deployment instead. */
export const SCRIPT: DelegationScript = { hash: SCRIPT_HASH, address: CML.EnterpriseAddress.new(MAINNET, CML.Credential.new_script(CML.ScriptHash.from_hex(SCRIPT_HASH))).to_address().to_bech32() };

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

// ── transactions: real bytes, as the builder of the ledger makes them ──

export interface TokenSpec {
  policy: string;
  name: string;
  quantity: bigint;
}
export interface OutputSpec {
  address: string;
  coin: bigint;
  tokens?: readonly TokenSpec[];
  /** The inline datum, as the hex of its CBOR. */
  datumHex?: string;
  /** A datum hash and no inline datum. */
  datumHash?: string;
}
export interface Ref {
  txHash: string;
  index: number;
}
/** The body of a transaction as a test describes it. Every field that a rule of the folder reads has a place here. */
export interface TxSpec {
  inputs: Ref[];
  outputs: OutputSpec[];
  fee: bigint;
  mint: TokenSpec[];
  /** The key hashes of the required signers. */
  signers: string[];
  certs?: boolean;
  withdrawals?: boolean;
  donation?: bigint;
  votes?: boolean;
  proposals?: boolean;
  treasury?: bigint;
  /** The collateral that the transaction names: its inputs, where the return goes, and the total that it can forfeit. */
  collateral?: { inputs: Ref[]; returnAddress: string | null; total: bigint | null };
  isValid?: boolean;
}

function valueOf(output: OutputSpec): CML.Value {
  const assets = CML.MultiAsset.new();
  for (const token of output.tokens ?? []) assets.set(CML.ScriptHash.from_hex(token.policy), CML.AssetName.from_hex(token.name), token.quantity);
  return CML.Value.new(output.coin, assets);
}
function outputOf(output: OutputSpec): CML.TransactionOutput {
  const datum =
    output.datumHex !== undefined
      ? CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(output.datumHex))
      : output.datumHash !== undefined
        ? CML.DatumOption.new_hash(CML.DatumHash.from_hex(output.datumHash))
        : undefined;
  return CML.TransactionOutput.new(CML.Address.from_bech32(output.address), valueOf(output), datum);
}
function inputsOf(refs: readonly Ref[]): CML.TransactionInputList {
  const list = CML.TransactionInputList.new();
  for (const ref of refs) list.add(CML.TransactionInput.new(CML.TransactionHash.from_hex(ref.txHash), BigInt(ref.index)));
  return list;
}

/** The bytes of a transaction with the body of `spec`, and its hash. */
export function txOf(spec: TxSpec): { cbor: string; hash: string } {
  const outputs = CML.TransactionOutputList.new();
  for (const output of spec.outputs) outputs.add(outputOf(output));
  const body = CML.TransactionBody.new(inputsOf(spec.inputs), outputs, spec.fee);
  if (spec.mint.length > 0) {
    const mint = CML.Mint.new();
    for (const token of spec.mint) mint.set(CML.ScriptHash.from_hex(token.policy), CML.AssetName.from_hex(token.name), token.quantity);
    body.set_mint(mint);
  }
  const signers = CML.Ed25519KeyHashList.new();
  for (const signer of spec.signers) signers.add(CML.Ed25519KeyHash.from_hex(signer));
  body.set_required_signers(signers);
  if (spec.certs === true) {
    const certs = CML.CertificateList.new();
    certs.add(CML.Certificate.new_stake_registration(CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(AGENT_KEY))));
    body.set_certs(certs);
  }
  if (spec.withdrawals === true) {
    const withdrawals = CML.MapRewardAccountToCoin.new();
    withdrawals.insert(CML.RewardAddress.new(MAINNET, CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(AGENT_KEY))), 1n);
    body.set_withdrawals(withdrawals);
  }
  if (spec.donation !== undefined) body.set_donation(spec.donation);
  if (spec.treasury !== undefined) body.set_current_treasury_value(spec.treasury);
  if (spec.votes === true) body.set_voting_procedures(CML.VotingProcedures.new());
  if (spec.proposals === true) body.set_proposal_procedures(CML.ProposalProcedureList.new());
  if (spec.collateral !== undefined) {
    body.set_collateral_inputs(inputsOf(spec.collateral.inputs));
    if (spec.collateral.returnAddress !== null) body.set_collateral_return(outputOf({ address: spec.collateral.returnAddress, coin: 1_000_000n }));
    if (spec.collateral.total !== null) body.set_total_collateral(spec.collateral.total);
  }
  const tx = CML.Transaction.new(body, CML.TransactionWitnessSet.new(), spec.isValid ?? true);
  return { cbor: tx.to_cbor_hex(), hash: CML.hash_transaction(tx.body()).to_hex() };
}

/** The hash of the transaction that is the bytes before the first `+` of a signed transaction: the keys of the tests append `+<key>`. */
const hashOfSigned = (signed: string): string => CML.hash_transaction(CML.Transaction.from_cbor_hex(signed.split('+')[0]!).body()).to_hex();

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
  /** The Delegate is accepted and never lands. */
  delegateNeverLands?: boolean;
  /** A third key must sign the Delegate (in the report of the build). */
  extraSigner?: string;
}

interface Utxo extends Ref {
  lovelace: bigint;
}
interface Made {
  kind: 'delegate' | 'undelegate';
  id: string;
  datum: DelegationDatum;
  hash: string;
  inputs: Ref[];
  created: Utxo[];
  /** The index of the delegation output in the Delegate. */
  outputIndex: number;
  /** A build that came from another builder: its inputs are not in this ledger, so they are not checked. */
  adopted: boolean;
}
interface Sub {
  datum: DelegationDatum;
  txHash: string;
  outputIndex: number;
  landsAt: number;
}
const refKey = (ref: Ref): string => `${ref.txHash}#${ref.index}`;
const DEPOSIT = 2_400_000n;

/**
 * The ledger as a sub-delegation sees it, in memory, with the wallet of the agent. A block takes 4 seconds, a transaction lands after 2 blocks, and the Delegate has 30 confirmations 120 seconds
 * after it lands. The builders make real bytes, as the builders of buyer-core do: the Delegate spends the largest output of the wallet as its seed, and the identifier is a hash of the seed, so two
 * builds before the first one lands get one identifier, and the node refuses the second transaction. A transaction takes effect when it lands.
 */
export class FakeDelegations implements DelegationChain {
  readonly log: string[] = [];
  readonly params: DelegateParams[] = [];
  readonly undelegateParams: UndelegateParams[] = [];
  readonly submitted: { kind: 'delegate' | 'undelegate'; cbor: string; at: number }[] = [];
  readonly builtDelegates: DelegateBuild[] = [];
  readonly builtUndelegates: UndelegateBuild[] = [];
  readonly faults: Faults = {};
  /** Plays a builder that gives another datum than the one that was asked for, in its report and in its bytes. */
  tamper: ((datum: DelegationDatum) => DelegationDatum) | null = null;
  /** Plays a builder that gives other bytes than the ones that match its report: it changes the body of a Delegate or an Undelegate after the report is made. */
  txTamper: ((spec: TxSpec, kind: 'delegate' | 'undelegate') => TxSpec) | null = null;
  /** Plays a builder that reports another transaction hash than the one of its bytes. */
  reportHash: string | null = null;
  parent: DelegationDatum | null;
  wallet: Utxo[] = [
    { txHash: 'a1'.repeat(32), index: 0, lovelace: 1_000_000_000n },
    { txHash: 'a1'.repeat(32), index: 1, lovelace: 5_000_000n },
  ];
  readonly #subs = new Map<string, Sub>();
  readonly #made = new Map<string, Made>();
  readonly #pending: { made: Made; landsAt: number; lands: boolean }[] = [];
  #lastId: string | null = null;

  constructor(readonly clock: FakeClock, parent: DelegationDatum | null = parentDatum(), readonly script: DelegationScript = SCRIPT) {
    this.parent = parent;
  }

  /** The identifier of the last Delegate that was built. */
  get subId(): string | null {
    return this.#lastId;
  }

  /** Takes the build of another builder, so that the later steps of a run find it: the node accepts its transaction, and the ledger takes the delegation when it lands. */
  adopt(built: DelegateBuild): void {
    this.#made.set(built.txHash, { kind: 'delegate', id: built.id, datum: built.delegation, hash: built.txHash, inputs: [], created: [], outputIndex: built.outputIndex, adopted: true });
    this.#lastId = built.id;
  }

  /** Takes the Undelegate of another builder: the node accepts its transaction, and the ledger ends the delegation when it lands. */
  adoptUndelegate(built: UndelegateBuild): void {
    this.#made.set(built.txHash, { kind: 'undelegate', id: built.id, datum: built.delegation, hash: built.txHash, inputs: [], created: [], outputIndex: 0, adopted: true });
  }

  /** Applies each transaction that has landed by now. */
  #settle(): void {
    const now = this.clock.now();
    for (const entry of [...this.#pending].filter((p) => p.lands && p.landsAt <= now)) {
      this.#pending.splice(this.#pending.indexOf(entry), 1);
      const { made } = entry;
      this.wallet = this.wallet.filter((u) => !made.inputs.some((input) => refKey(input) === refKey(u))).concat(made.created);
      if (made.kind === 'delegate') this.#subs.set(made.id, { datum: made.datum, txHash: made.hash, outputIndex: made.outputIndex, landsAt: entry.landsAt });
      else this.#subs.delete(made.id);
    }
  }

  /** The live sub-delegation `id`, or null. */
  #live(id: string): Sub | null {
    this.#settle();
    return this.#subs.get(id) ?? null;
  }

  async readDelegation(id: string): Promise<LiveDelegation | null> {
    this.log.push(`read:${id === PARENT_ID ? 'parent' : 'sub'}`);
    if (this.faults.readThrows === true) throw new Error('the ledger cannot be read');
    if (id === PARENT_ID) return this.parent === null ? null : { id, delegation: this.parent, txHash: 'f1'.repeat(32) };
    const sub = this.#live(id);
    return sub === null ? null : { id, delegation: sub.datum, txHash: sub.txHash };
  }

  async readiness(id: string): Promise<Readiness> {
    this.log.push('readiness');
    if (this.faults.readinessThrows === true) throw new Error('the ledger cannot be read');
    if (this.faults.readinessHangs === true) return new Promise<Readiness>(() => undefined);
    if (this.faults.unusable === true) return { state: 'unusable', problems: ['the delegate is not Active'] };
    const sub = this.#live(id);
    if (sub === null) return { state: 'waiting', confirmations: null };
    const confirmations = Math.floor((this.clock.now() - sub.landsAt) / 4_000);
    return this.faults.neverConfirm !== true && confirmations >= 30 ? { state: 'ready' } : { state: 'waiting', confirmations: Math.min(confirmations, 29) };
  }

  async buildDelegate(params: DelegateParams): Promise<DelegateBuild> {
    this.log.push('buildDelegate');
    this.params.push(params);
    if (this.faults.buildDelegateThrows === true) throw new Error('the parent delegation allows no further hop');
    this.#settle();
    const parent = this.parent!;
    const asked: DelegationDatum = {
      delegator: { type: 'Agent', id: parent.delegate }, parent: params.parent ?? null, delegate: params.delegate, delegateKey: params.delegateKey,
      actions: params.actions.map(hex), resources: (params.resources ?? []).map(hex), notBefore: params.notBefore ?? Math.max(this.clock.now() - 60_000, parent.notBefore),
      notAfter: params.notAfter, depth: parent.depth + 1, remaining: params.remaining ?? 0, purpose: null, value: params.value ?? null,
    };
    const datum = this.tamper === null ? asked : this.tamper(asked);
    const seed = this.wallet.reduce((best, u) => (u.lovelace > best.lovelace ? u : best));
    const id = createHash('sha256').update(refKey(seed)).digest('hex');
    const fee = 230_000n;
    const signers = [parent.delegateKey, params.delegateKey];
    const spec: TxSpec = {
      inputs: [seed],
      outputs: [
        { address: this.script.address, coin: DEPOSIT, tokens: [{ policy: this.script.hash, name: id, quantity: 1n }], datumHex: encodeDelegationDatum(datum) },
        { address: params.changeAddress, coin: seed.lovelace - DEPOSIT - fee },
      ],
      fee,
      mint: [{ policy: this.script.hash, name: id, quantity: 1n }],
      signers,
    };
    const tx = txOf(this.txTamper === null ? spec : this.txTamper(spec, 'delegate'));
    const requiredSigners = signers.map((keyHash) => ({ keyHash, roles: [] as string[] }));
    if (this.faults.extraSigner !== undefined) requiredSigners.push({ keyHash: this.faults.extraSigner, roles: ['wallet'] });
    const txHash = this.reportHash ?? tx.hash;
    const built: DelegateBuild = {
      txCbor: tx.cbor, txHash, fee: String(fee), feeAda: '0.23', validFrom: this.clock.now() - 60_000, validTo: this.clock.now() + 1_800_000, requiredSigners, id, seed: refKey(seed), outputIndex: 0,
      outputLovelace: DEPOSIT, delegation: datum,
    };
    this.#made.set(tx.hash, { kind: 'delegate', id, datum, hash: tx.hash, inputs: [seed], created: [{ txHash: tx.hash, index: 1, lovelace: seed.lovelace - DEPOSIT - fee }], outputIndex: 0, adopted: false });
    this.#lastId = id;
    this.builtDelegates.push(built);
    return built;
  }

  async buildUndelegate(params: UndelegateParams): Promise<UndelegateBuild> {
    this.log.push('buildUndelegate');
    this.undelegateParams.push(params);
    const sub = this.#live(params.id);
    if (this.faults.buildUndelegateThrows === true || sub === null) throw new Error(`No live delegation ${params.id}: it does not exist, or it is not confirmed yet.`);
    const fee = 190_000n;
    const feeInput = this.wallet.reduce((best, u) => (u.lovelace > best.lovelace ? u : best));
    const signer = params.signer ?? this.parent!.delegateKey;
    const spec: TxSpec = {
      inputs: [{ txHash: sub.txHash, index: sub.outputIndex }, feeInput],
      outputs: [{ address: params.changeAddress, coin: DEPOSIT + feeInput.lovelace - fee }],
      fee,
      mint: [{ policy: this.script.hash, name: params.id, quantity: -1n }],
      signers: [signer],
    };
    const tx = txOf(this.txTamper === null ? spec : this.txTamper(spec, 'undelegate'));
    const built: UndelegateBuild = {
      txCbor: tx.cbor, txHash: this.reportHash ?? tx.hash, fee: String(fee), feeAda: '0.19', validFrom: this.clock.now() - 60_000, validTo: this.clock.now() + 1_800_000,
      requiredSigners: [{ keyHash: signer, roles: ['delegation key of the delegator'] }], id: params.id, delegation: sub.datum, releasedLovelace: DEPOSIT, authorityLink: 0, authority: 'the agent',
    };
    this.#made.set(tx.hash, {
      kind: 'undelegate', id: params.id, datum: sub.datum, hash: tx.hash, inputs: [{ txHash: sub.txHash, index: sub.outputIndex }, feeInput],
      created: [{ txHash: tx.hash, index: 0, lovelace: DEPOSIT + feeInput.lovelace - fee }], outputIndex: 0, adopted: false,
    });
    this.builtUndelegates.push(built);
    return built;
  }

  async submit(signedCborHex: string): Promise<string> {
    const hash = hashOfSigned(signedCborHex);
    const made = this.#made.get(hash);
    if (made === undefined) throw new Error('the node does not know the outputs that this transaction spends');
    this.log.push(`submit:${made.kind}`);
    this.submitted.push({ kind: made.kind, cbor: signedCborHex, at: this.clock.now() });
    this.#settle();
    if (!made.adopted) {
      const spent = new Set(this.#pending.flatMap((p) => p.made.inputs.map(refKey)));
      const onLedger = new Set(this.wallet.map(refKey).concat([...this.#subs.values()].map((s) => refKey({ txHash: s.txHash, index: s.outputIndex }))));
      for (const input of made.inputs) if (!onLedger.has(refKey(input)) || spent.has(refKey(input))) throw new Error(`BadInputsUTxO: ${refKey(input)} is spent or unknown`);
    }
    const landsAt = this.clock.now() + 8_000;
    if (made.kind === 'delegate') {
      if (this.faults.submitDelegateThrows === true) {
        if (this.faults.delegateLandsAnyway === true) this.#pending.push({ made, landsAt, lands: true });
        throw new Error('the node did not answer');
      }
      this.#pending.push({ made, landsAt, lands: this.faults.delegateNeverLands !== true });
    } else {
      if (this.faults.submitUndelegateThrows === true) throw new Error('the node refused the transaction');
      this.#pending.push({ made, landsAt, lands: this.faults.undelegateNeverLands !== true });
    }
    return hash;
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
  /** The delegation script. The default is SCRIPT. */
  readonly script?: DelegationScript;
  /** The queue of the wallet. The default is a new queue. */
  readonly queue?: SerialQueue;
}
export function subWorld(over: SubWorldOptions = {}): SubWorld {
  const clock = new FakeClock(NOW);
  const script = over.script ?? SCRIPT;
  const chain = new FakeDelegations(clock, over.parent, script);
  const target = erpTarget();
  const request: SubDelegationRequest = {
    target, parent: PARENT_ID, agent: { signer: markSigner(AGENT_KEY), walletAddress: WALLET }, subagent: { did: `did:vector:${SUBAGENT_ID}`, signer: markSigner(SUBAGENT_KEY) }, validForMs: 3_600_000,
    ...over.request,
  };
  const limits: SubDelegationLimits = { jobTimeoutMs: 600_000, ...over.limits };
  return { clock, chain, deps: { chain, clock, delegationScript: script, walletQueue: over.queue ?? createSerialQueue() }, request, limits, target };
}
