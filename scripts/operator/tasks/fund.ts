// scripts/operator/tasks/fund.ts - the task fund: it funds the wallets of the use case from the run wallet. Every transaction is built in process (the hosted tool that sends funds has no end of
// validity) and lands through `landBuilt`, with the run key as its one signer.
//   collateral   one transaction: one pure output of exactly the collateral amount (5 units in use case 1) to each wallet that holds no such output. Alone, so that no later spend merges it.
//   float        one transaction: to each wallet, what its balance lacks to the collateral and the float of its line, when that is at least one unit.
//   member:<label>  with --member <label>: one transaction with one output, to the one external address that the approval names for the label, for the amount that the approval gives.
// The run wallet can pay a wallet of the registry, and an address of the approval in a member step. No other address can get a lovelace: the plan names exactly the addresses that the step sends
// to, and the guard `destinations` refuses any other output before a signature. The amounts of the two first steps come from the ledger (what each wallet holds now), so the steps are safe to
// run again, and the state file keeps the transaction of each step. The step of a member is sent once for each label: the state file records it, and a recorded label is refused.
import { bech32Decode, keyCredentialOf } from '../../checks/lib/addresses.ts';
import { iso, units } from '../../checks/lib/format.ts';
import type { StepPlan } from '../../checks/lib/guards.ts';
import type { Utxo } from '../../checks/lib/platform.ts';
import { eventually } from '../../checks/lib/retry.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { factsOf } from '../../checks/lib/txfacts.ts';
import type { TxFacts } from '../../checks/lib/txfacts.ts';
import { ApprovalError, loadGo, lovelaceOfUnits } from '../lib/approval.ts';
import type { FundingLine, StepOutcome, TaskDefinition, TaskSession } from '../lib/contract.ts';
import { landBuilt } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { ensureSlotConfig, lucidForAddress } from '../lib/platform.ts';
import { runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const UNIT = 1_000_000n;
const RUN = 'run';
/** The run wallet keeps this much for the fee of a step, besides the outputs of the step. */
const FEE_RESERVE = UNIT;
/** A top-up below one unit is not sent: it is no use, and a transaction costs a fee. */
const MIN_FLOAT = UNIT;
/** A transaction that the task builds is valid for 20 minutes after the time of the chain. */
const VALID_FOR_MS = 20 * 60_000;
/** The network id that a mainnet address holds in the low half of its first byte. */
const MAINNET_NETWORK_ID = 1;
const LABEL = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** The node can show a block later than the indexer that confirmed the transaction, so a wallet is read again for a short time before it is said to lack its output. */
const VERIFY_WINDOW = { windowMs: 60_000, pauseMs: 5_000 } as const;
const NAME_WIDTH = 24;
/** The widths of the number columns of the table: the balance now, the collateral to send, the float to send and the balance after. */
const COLUMNS = [14, 20, 16, 16] as const;

type FundStep = 'collateral' | 'float';

export interface Transfer { readonly address: string; readonly lovelace: bigint }

/** A transaction that the task built: the unsigned CBOR, its hash and fee, and the end of its validity in POSIX milliseconds. */
export interface BuiltTransfer { readonly unsignedCbor: string; readonly txHash: string; readonly feeLovelace: bigint; readonly validTo: number }

interface FundExtra {
  /** What this run sent, step by step: the transaction (null for a step that needed none), the number of wallets and the lovelace. */
  readonly sent: Array<{ step: string; transaction: string | null; wallets: number; lovelace: bigint }>;
}

/** The parts of the provider of the chain that tell the time of the chain. The provider of the pack has both. The interface of the builder library lacks them. */
interface ClockProvider {
  getSystemStartMs(): Promise<number>;
  getNetworkTip?(): Promise<{ slot: number }>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- the build: the clock of Vector, then Lucid with a validTo ----

/**
 * The time of the chain: the start of the chain (the answer of `ensureSlotConfig`) and the slot of the tip that the node reports, as buyer-core reads them. A provider that gives no tip has no
 * clock of its own, and the clock of the host stands in.
 */
async function chainNowMs(session: Pick<TaskSession, 'clock'>, provider: ClockProvider, start: number): Promise<number> {
  if (typeof provider.getNetworkTip !== 'function') return session.clock.now();
  const tip = await provider.getNetworkTip();
  if (!Number.isSafeInteger(tip.slot) || tip.slot < 0) throw new PreconditionError('the node gave no usable tip, so the end of the validity cannot be set');
  return start + tip.slot * 1000;
}

/**
 * Builds one payment from the run wallet: one output for each transfer, the change to the run wallet, and a validTo 20 minutes after the time of the chain. The slot clock of Vector is set
 * FIRST, and only here: Lucid turns a validTo into a slot with its own clock until `ensureSlotConfig` has set the clock of Vector, and the ttl would then be years too late. Nothing is signed
 * or submitted here.
 */
export async function buildTransfers(session: Pick<TaskSession, 'chain' | 'registry' | 'clock'>, transfers: readonly Transfer[]): Promise<BuiltTransfer> {
  const provider = session.chain.provider as unknown as ClockProvider;
  if (typeof provider.getSystemStartMs !== 'function') throw new PreconditionError('the provider of the chain cannot tell the start of the chain, so the end of the validity cannot be set');
  const start = await ensureSlotConfig(provider);
  const lucid = await lucidForAddress(session.chain.provider, session.registry.addressOf(RUN));
  const validTo = (await chainNowMs(session, provider, start)) + VALID_FOR_MS;
  let payment = lucid.newTx();
  for (const transfer of transfers) payment = payment.pay.ToAddress(transfer.address, { lovelace: transfer.lovelace });
  const completed = await payment.validTo(validTo).complete();
  const unsignedCbor = completed.toCBOR();
  return { unsignedCbor, txHash: completed.toHash(), feeLovelace: factsOf(unsignedCbor).feeLovelace, validTo };
}

/**
 * The plan of a payment: the destinations are exactly the addresses of the transfers, the run wallet may lose the sum of the transfers and the fee of the bytes, and nothing is minted, burned or
 * withdrawn. Any other output, and any asset that leaves a wallet, is refused by the guards before a signature.
 */
export function planOfTransfers(session: Pick<TaskSession, 'registry' | 'settings'>, transfers: readonly Transfer[], facts: TxFacts): StepPlan {
  const total = transfers.reduce((sum, transfer) => sum + transfer.lovelace, 0n);
  return planOf(session, { outflow: { [RUN]: total + facts.feeLovelace }, destinations: transfers.map((transfer) => transfer.address) });
}

// ---- the wallets and what each step sends ----

interface Wallet { readonly name: string; readonly address: string; readonly line: FundingLine; readonly balance: bigint; readonly outputs: readonly Utxo[] }
interface Row { readonly wallet: Wallet; readonly collateral: bigint; readonly float: bigint }

const isPure = (utxo: Utxo): boolean => Object.keys(utxo.assets).every((unit) => unit === 'lovelace');
const lovelaceIn = (outputs: readonly Utxo[]): bigint => outputs.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
const holdsExactly = (wallet: Wallet): boolean => wallet.outputs.some((utxo) => isPure(utxo) && utxo.assets.lovelace === wallet.line.collateralLovelace);
const plural = (count: number): string => (count === 1 ? 'wallet' : 'wallets');

/** Reads the outputs of the wallet of each funding line from the node. */
async function readWallets(session: Pick<TaskSession, 'use' | 'registry' | 'chain'>): Promise<Wallet[]> {
  const wallets: Wallet[] = [];
  for (const line of session.use.funding) {
    const address = session.registry.addressOf(line.wallet);
    const outputs = await session.chain.provider.getUtxos(address);
    wallets.push({ name: line.wallet, address, line, balance: lovelaceIn(outputs), outputs });
  }
  return wallets;
}

/**
 * What each wallet gets from `step` on. The collateral is one output of the amount of the line for a wallet that holds no pure output of exactly that amount (the step collateral only: after it
 * the step float finds the output there). The float is what the balance lacks to the collateral and the float of the line, counted after the collateral output; a top-up below one unit is not sent.
 */
function rowsOf(wallets: readonly Wallet[], step: FundStep): Row[] {
  return wallets.map((wallet) => {
    const { collateralLovelace, floatLovelace } = wallet.line;
    const collateral = step === 'collateral' && collateralLovelace > 0n && !holdsExactly(wallet) ? collateralLovelace : 0n;
    const need = collateralLovelace + floatLovelace - (wallet.balance + collateral);
    return { wallet, collateral, float: need >= MIN_FLOAT ? need : 0n };
  });
}

const amount = (lovelace: bigint): string => units(lovelace).replace(' units', '');

/** The table of a step, in units: the balance now, the collateral and the float to send, and the balance after both, and the totals. */
function tableLines(rows: readonly Row[]): string[] {
  const cells = (label: string, ...values: bigint[]): string => label.padEnd(NAME_WIDTH) + values.map((value, index) => amount(value).padStart(COLUMNS[index]!)).join('');
  const head = 'wallet'.padEnd(NAME_WIDTH) + ['balance now', 'collateral to send', 'float to send', 'balance after'].map((text, index) => text.padStart(COLUMNS[index]!)).join('');
  const lines = [head];
  const total = { balance: 0n, collateral: 0n, float: 0n };
  for (const row of rows) {
    lines.push(cells(row.wallet.name, row.wallet.balance, row.collateral, row.float, row.wallet.balance + row.collateral + row.float));
    total.balance += row.wallet.balance;
    total.collateral += row.collateral;
    total.float += row.float;
  }
  lines.push(cells('total', total.balance, total.collateral, total.float, total.balance + total.collateral + total.float));
  return lines;
}

// ---- the landing of a payment ----

/**
 * Builds the payment, runs the checks of the landing, and in submit mode signs and lands it. The run wallet must hold the outputs and one unit for the fee (a refusal before any build: exit 2).
 * The plan is the plan of `planOfTransfers`. The step is recorded by the landing with its transaction and `record`.
 */
async function pay(session: TaskSession<FundExtra>, step: string, transfers: readonly Transfer[], where: string, record: Record<string, unknown>): Promise<StepOutcome> {
  const total = transfers.reduce((sum, transfer) => sum + transfer.lovelace, 0n);
  const balance = lovelaceIn(await session.chain.provider.getUtxos(session.registry.addressOf(RUN)));
  session.out.out(`the step ${step} sends ${units(total)} to ${where} in one transaction`);
  session.out.out(`the run wallet holds ${units(balance)}; after this step it holds ${units(balance - total)} before the fee`);
  if (balance < total + FEE_RESERVE) {
    throw new PreconditionError(`the run wallet holds ${units(balance)}, and the step ${step} needs ${units(total)} for its outputs and ${units(FEE_RESERVE)} for the fee`);
  }
  const built = await buildTransfers(session, transfers);
  const landed = await landBuilt(session, { step, built, expectSigners: [RUN], plan: (facts) => planOfTransfers(session, transfers, facts), facts: () => record });
  session.out.out(`the fee is ${units(landed.facts.feeLovelace)}: the run wallet holds ${units(balance - total - landed.facts.feeLovelace)} after this step`);
  if (landed.kind === 'dry') return { kind: 'dry' };
  session.extra.sent.push({ step, transaction: landed.txHash, wallets: transfers.length, lovelace: total });
  return { kind: 'done', message: `the step ${step} is confirmed in the transaction ${landed.txHash}` };
}

/** The step records itself with no transaction when no wallet needs anything: the state file then says that the step is done, and the next run goes on to the next step. */
function recordNothing(session: TaskSession<FundExtra>, step: FundStep): StepOutcome {
  const said = step === 'collateral' ? 'no wallet needs a collateral output' : 'every wallet holds its float';
  if (session.mode === 'dry') {
    session.out.out(`${said}: the step ${step} would be recorded with no transaction`);
    return { kind: 'dry' };
  }
  session.state.recordStep(step, { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: {}, facts: { to: {} } });
  session.out.out(`${said}: the step ${step} is recorded with no transaction`);
  session.extra.sent.push({ step, transaction: null, wallets: 0, lovelace: 0n });
  return { kind: 'done', message: `the step ${step} needed no transaction` };
}

async function fundStep(session: TaskSession<FundExtra>, step: FundStep): Promise<StepOutcome> {
  const rows = rowsOf(await readWallets(session), step);
  for (const text of tableLines(rows)) session.out.out(text);
  const sendOf = (row: Row): bigint => (step === 'collateral' ? row.collateral : row.float);
  const sending = rows.filter((row) => sendOf(row) > 0n);
  if (sending.length === 0) return recordNothing(session, step);
  const transfers = sending.map((row) => ({ address: row.wallet.address, lovelace: sendOf(row) }));
  return pay(session, step, transfers, `${sending.length} ${plural(sending.length)}`, { to: Object.fromEntries(sending.map((row) => [row.wallet.name, sendOf(row).toString()])) });
}

// ---- the verification after a landing ----

/** The names of the wallets, grouped by the amount that each lacks, as a sentence part: `the wallets a, b` for one amount, and one such part for each other amount. */
function lackingText(lacking: ReadonlyArray<{ name: string; wanted: bigint }>, what: (wanted: bigint) => string): string {
  const groups = new Map<bigint, string[]>();
  for (const { name, wanted } of lacking) groups.set(wanted, [...(groups.get(wanted) ?? []), name]);
  return [...groups].map(([wanted, names]) => `${what(wanted)} at the ${plural(names.length)} ${names.join(', ')}`).join('; ');
}

/**
 * Reads each wallet from the node after a step landed, and throws when one lacks what the step sent: for the collateral, a pure output of exactly its amount; for the float, a balance of at
 * least the collateral and the float of its line. The node is asked again for a short time first. The step stays confirmed in the state file, and is verified again at the next run.
 */
async function verifyWallets(session: TaskSession<FundExtra>, step: FundStep): Promise<void> {
  const outcome = await eventually(session.clock, VERIFY_WINDOW, async () => {
    const wallets = await readWallets(session);
    const lacking = wallets.flatMap((wallet) => {
      const { collateralLovelace, floatLovelace } = wallet.line;
      if (step === 'collateral') return collateralLovelace > 0n && !holdsExactly(wallet) ? [{ name: wallet.name, wanted: collateralLovelace }] : [];
      // A wallet that lacks less than one unit is not sent a float (`rowsOf`), so it is not a failure either.
      return collateralLovelace + floatLovelace - wallet.balance >= MIN_FLOAT ? [{ name: wallet.name, wanted: collateralLovelace + floatLovelace }] : [];
    });
    return { done: lacking.length === 0, value: lacking };
  });
  if (outcome.done) return;
  const what = step === 'collateral' ? (wanted: bigint) => `no pure output of exactly ${units(wanted)}` : (wanted: bigint) => `less than ${units(wanted)}`;
  throw new Error(`the node shows ${lackingText(outcome.value, what)}: the transaction of the step ${step} is recorded, and the step is verified again at the next run`);
}

// ---- the step of a member ----

/** The label of a member that the state file records: the transaction that sent it. A member is never sent twice. */
function refuseRecorded(session: TaskSession<FundExtra>, label: string): void {
  const note = session.state.note<unknown>(`part.member:${label}`);
  if (note === undefined) return;
  const hash = isObject(note) && typeof note.tx_hash === 'string' ? note.tx_hash : 'unknown';
  throw new PreconditionError(`the member ${label} was sent already (the transaction ${hash}): a member is never sent twice`);
}

/**
 * The approval of the session. A submit run has it from the runner. A dry run reads the file here, because the address and the amount of the member are in it and nowhere else: a missing
 * or bad file stops the dry run with exit 2.
 */
function approvalOf(session: TaskSession<FundExtra>) {
  if (session.go !== null) return session.go;
  try { return loadGo(session.settings.goFile, session.clock.now()); } catch (err) {
    if (err instanceof ApprovalError) throw new PreconditionError(`the member step reads the address and the amount from the approval file, also in a dry run: ${err.message}`);
    throw err;
  }
}

/** An external address is a mainnet address and no wallet of the registry, by its payment key, so that no form of a registry address passes as external. */
function requireExternal(session: TaskSession<FundExtra>, label: string, address: string): void {
  const decoded = bech32Decode(address);
  if (decoded === null || decoded.hrp !== 'addr' || decoded.bytes.length < 29 || (decoded.bytes[0]! & 0x0f) !== MAINNET_NETWORK_ID) {
    throw new PreconditionError(`the external address of the label ${label} is not a mainnet address`);
  }
  const credential = keyCredentialOf(address);
  const owner = credential === null ? undefined : session.registry.nameOfHash(credential);
  if (owner !== undefined) throw new PreconditionError(`the external address of the label ${label} is a wallet of the registry (the key ${owner}): an external address is outside it`);
}

function memberStep(label: string): StepHandler<FundExtra> {
  const step = `member:${label}`;
  return {
    name: step,
    async run(session) {
      const entry = approvalOf(session).external?.find((item) => item.label === label);
      if (entry === undefined) throw new PreconditionError(`the approval file has no external entry with the label ${label}`);
      requireExternal(session, label, entry.address);
      const lovelace = lovelaceOfUnits(entry.units);
      session.out.out(`the member ${label}: ${units(lovelace)} to ${entry.address}`);
      return pay(session, step, [{ address: entry.address, lovelace }], 'the external address of the approval', { label, lovelace: lovelace.toString() });
    },
  };
}

const collateralStep: StepHandler<FundExtra> = { name: 'collateral', run: (session) => fundStep(session, 'collateral'), verify: (session) => verifyWallets(session, 'collateral') };
const floatStep: StepHandler<FundExtra> = { name: 'float', run: (session) => fundStep(session, 'float'), verify: (session) => verifyWallets(session, 'float') };

const task: TaskDefinition<FundExtra> = {
  name: 'fund',
  title: 'Fund the wallets of the use case from the run wallet',
  flags: [],
  valued: ['member'],
  needs: { keys: (use) => [...new Set([RUN, ...use.funding.map((line) => line.wallet)])], chain: true, hosted: [], approval: 'submit' },
  steps: (_use, flags) => {
    const member = flags.value('member');
    return member === undefined ? ['collateral', 'float'] : [`member:${member}`];
  },
  parse: (_env, _settings, use, flags) => {
    // One state file holds the members that were sent. A run label would open another file, and the same label could be sent again.
    if (flags.value('run') !== undefined) throw new PreconditionError('the task fund takes no --run label: it keeps one state file for the use case, so that a member is never sent twice');
    const wallets = new Set<string>();
    use.funding.forEach((line, index) => {
      const whole = (value: unknown): boolean => typeof value === 'bigint' && value >= 0n;
      if (!whole(line.collateralLovelace) || !whole(line.floatLovelace)) {
        throw new PreconditionError(`the funding line number ${index + 1} has an amount that is not a whole number of lovelace, or is below 0`);
      }
      if (wallets.has(line.wallet)) throw new PreconditionError(`the funding line number ${index + 1} names a wallet that an earlier line names`);
      wallets.add(line.wallet);
    });
    const member = flags.value('member');
    if (member !== undefined && !LABEL.test(member)) throw new PreconditionError('the label of --member is 1 to 32 lower-case letters, digits and hyphens, and it starts with a letter or a digit');
    return { sent: [] };
  },

  async next(session) {
    const member = session.flags.value('member');
    if (member === undefined) return runSteps(session, [collateralStep, floatStep]);
    refuseRecorded(session, member);
    return runSteps(session, [memberStep(member)]);
  },

  async cleanup() {
    return { kind: 'done', message: 'the pack never sweeps a wallet: floats are topped up by hand, and the operator empties a wallet. Nothing was changed' };
  },

  async status(session) {
    const step = session.state.step('collateral') === undefined ? 'collateral' : 'float';
    return [`the funding that the step ${step} and the steps after it still send:`, ...tableLines(rowsOf(await readWallets(session), step))];
  },

  result: (session) => ({
    sent: session.extra.sent.map((item) => ({ step: item.step, transaction: item.transaction, wallets: item.wallets, lovelace: item.lovelace.toString() })),
  }),
};

export default task;
