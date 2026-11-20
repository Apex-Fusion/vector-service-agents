// packages/usecase-kit/src/access/txcheck.ts
// What the keys sign. A builder gives the bytes of a transaction and a report about them (the identifier, the datum, the signers), and the keys sign the bytes and not the report. So the bytes are
// decoded with the checked decoder of the vector-read package, and each part of the transaction that moves value or authority is read before any key signs: the tokens that it mints, the outputs,
// the certificates, the withdrawals, the required signers, the collateral and the fee. A transaction that fails a rule is not signed. This file is not part of the public surface.
import { CML } from '@lucid-evolution/lucid';
import { addressDetails, decodeTransaction } from '@vsa/vector-read/guarded-decode';
import { isScriptHash } from '../protocol/index.ts';
import { errorText } from './text.ts';

/**
 * The highest fee, in lovelace, that a Delegate or an Undelegate of this folder may have: 2 units. In the offline identity world with the real builder of buyer-core, a Delegate costs about
 * 0.42 units and an Undelegate about 0.43 units, and the test of the real builder holds each below 1 unit. The limit is about five times that, so a heavier chain of parents or a dearer script
 * does not stop a run, and it is far below the wallet, so a builder that gives the wallet away as a fee gets no signature.
 */
export const MAX_TX_FEE_LOVELACE = 2_000_000n;
/** The most lovelace that the output of a Delegate at the delegation script may hold: 5 units. The ledger minimum for its datum is about 2.2 units. The deposit comes back with the Undelegate. */
export const MAX_DELEGATION_DEPOSIT_LOVELACE = 5_000_000n;
/** The most collateral that a transaction may forfeit when its script fails: 5 units, the collateral that the builder takes. */
export const MAX_COLLATERAL_LOVELACE = 5_000_000n;

/** The delegation script of the identity deployment. `deployment.delegation` of `@vsa/buyer-core` has this shape. */
export interface DelegationScript {
  /** The script hash, which is the policy of the delegation tokens: 56 lower-case hex characters. */
  readonly hash: string;
  /** The address of the script, where the delegations live. */
  readonly address: string;
}

/** What a transaction of this folder is checked against. Every value is made by this folder from its own request, and none comes from the builder, with one exception: `DelegateExpectation.ttlSlot`. */
export interface TxExpectation {
  /** The hash that the builder reports for the transaction: it must be the hash of the bytes. */
  readonly txHash: string;
  /** The delegation identifier: the name of the token that the transaction mints (a Delegate) or burns (an Undelegate). */
  readonly id: string;
  readonly script: DelegationScript;
  /** The address of the wallet of the agent, as the hex of its bytes: every output that is not the delegation output goes there. */
  readonly walletHex: string;
  /** The key hashes that the transaction names as required signers: exactly these. */
  readonly signers: readonly string[];
}

/** What a Delegate is checked against, besides what every transaction is checked against. */
export interface DelegateExpectation extends TxExpectation {
  /** The datum that a Delegate must put in its one output at the delegation script, as the hex of its CBOR. */
  readonly datumHex: string;
  /**
   * The TTL that the body of the Delegate must have: the slot that its end of validity gives. This value comes from the report of the build, through the slot rule of the chain. The record of a left
   * sub-delegation names the same end, so the bytes that the keys sign end where a janitor expects.
   */
  readonly ttlSlot: number;
}

/** The address of a script or of a wallet as the hex of its bytes, or null when the text is not an address. */
export function addressHexOf(address: string): string | null {
  try {
    return addressDetails(address).address.hex;
  } catch {
    return null;
  }
}

/** Why `script` is not the delegation script of a deployment, or null: its hash is 56 lower-case hex characters, and its address is an address whose payment credential is the script of that hash. */
export function delegationScriptProblem(script: unknown): string | null {
  if (typeof script !== 'object' || script === null) return 'delegationScript must be the delegation script of the identity deployment: its hash and its address';
  const { hash, address } = script as Partial<DelegationScript>; // a caller in JavaScript can give any value, so each member is checked below
  if (!isScriptHash(hash) || typeof address !== 'string') return 'delegationScript must have the hash of the script (56 lower-case hex characters) and its address';
  try {
    const credential = addressDetails(address).paymentCredential;
    return credential?.type === 'Script' && credential.hash === hash ? null : 'the address of the delegation script is not an address of the script with this hash';
  } catch {
    return 'the address of the delegation script is not an address';
  }
}

interface Token {
  readonly policy: string;
  readonly name: string;
  readonly quantity: bigint;
}

function mintedTokens(mint: CML.Mint | undefined): Token[] {
  const tokens: Token[] = [];
  if (mint === undefined) return tokens;
  const policies = mint.keys();
  for (let p = 0; p < policies.len(); p += 1) {
    const policy = policies.get(p);
    const assets = mint.get_assets(policy);
    const names = assets?.keys();
    for (let n = 0; assets !== undefined && names !== undefined && n < names.len(); n += 1) tokens.push({ policy: policy.to_hex(), name: names.get(n).to_hex(), quantity: assets.get(names.get(n)) ?? 0n });
  }
  return tokens;
}

function heldTokens(assets: CML.MultiAsset): Token[] {
  const tokens: Token[] = [];
  const policies = assets.keys();
  for (let p = 0; p < policies.len(); p += 1) {
    const policy = policies.get(p);
    const named = assets.get_assets(policy);
    const names = named?.keys();
    for (let n = 0; named !== undefined && names !== undefined && n < names.len(); n += 1) tokens.push({ policy: policy.to_hex(), name: names.get(n).to_hex(), quantity: named.get(names.get(n)) ?? 0n });
  }
  return tokens;
}

const isOnly = (tokens: readonly Token[], policy: string, name: string, quantity: bigint): boolean =>
  tokens.length === 1 && tokens[0]!.policy === policy && tokens[0]!.name === name && tokens[0]!.quantity === quantity;

function signersOf(body: CML.TransactionBody): string[] {
  const list = body.required_signers();
  return Array.from({ length: list?.len() ?? 0 }, (_, index) => list!.get(index).to_hex());
}

/** The first rule that the body breaks for any transaction of this folder, or null: its validity, what it adds besides outputs and mints, its signers, its collateral and its fee. */
function bodyProblem(tx: CML.Transaction, e: TxExpectation): string | null {
  const body = tx.body();
  if (!tx.is_valid()) return 'the transaction is flagged as not valid';
  if (body.certs() !== undefined) return 'the transaction has certificates';
  if (body.withdrawals() !== undefined) return 'the transaction has withdrawals';
  if (body.voting_procedures() !== undefined || body.proposal_procedures() !== undefined) return 'the transaction has votes or proposals';
  if (body.donation() !== undefined || body.current_treasury_value() !== undefined) return 'the transaction gives to the treasury';
  if (body.fee() > MAX_TX_FEE_LOVELACE) return `the fee of the transaction is ${body.fee()} lovelace, above the limit of ${MAX_TX_FEE_LOVELACE}`;
  const signers = signersOf(body);
  if (signers.length !== e.signers.length || new Set(signers).size !== signers.length || !signers.every((signer) => e.signers.includes(signer))) {
    return 'the required signers of the transaction are not exactly the keys of this run';
  }
  if ((body.collateral_inputs()?.len() ?? 0) > 0) {
    const total = body.total_collateral();
    if (total === undefined || total > MAX_COLLATERAL_LOVELACE) return `the collateral that the transaction can forfeit is not limited to ${MAX_COLLATERAL_LOVELACE} lovelace`;
  }
  const returned = body.collateral_return();
  if (returned !== undefined && returned.address().to_hex() !== e.walletHex) return 'the collateral return goes to an address that is not the wallet of the agent';
  return null;
}

/** The delegation output: an inline datum equal to the one that was asked for, the one token of this run and nothing else, and a deposit of at most the limit. */
function delegationOutputProblem(output: CML.TransactionOutput, e: DelegateExpectation): string | null {
  const datum = output.datum()?.as_datum();
  if (datum === undefined) return 'the delegation output has no inline datum';
  if (datum.to_cbor_hex() !== e.datumHex) return 'the inline datum of the delegation output is not, byte for byte, the datum of the delegation that was asked for';
  if (!isOnly(heldTokens(output.amount().multi_asset()), e.script.hash, e.id, 1n)) return 'the delegation output does not hold exactly the one token of this delegation';
  if (output.amount().coin() > MAX_DELEGATION_DEPOSIT_LOVELACE) return `the delegation output holds ${output.amount().coin()} lovelace, above the limit of ${MAX_DELEGATION_DEPOSIT_LOVELACE}`;
  return null;
}

/**
 * The TTL of a Delegate: its body ends at the slot that the record of the sub-delegation names. A Delegate with no TTL could land at any time, after a janitor dropped the record, and anyone who holds its
 * bytes could send them again while its seed output is unspent.
 */
function ttlProblem(body: CML.TransactionBody, ttlSlot: number): string | null {
  const ttl = body.ttl();
  if (ttl === undefined) return 'the transaction has no end of validity (no TTL), so it could land at any time';
  return ttl === BigInt(ttlSlot) ? null : `the end of validity of the transaction (slot ${ttl}) is not the slot of the end of validity that the build reports (slot ${ttlSlot})`;
}

function decoded(txCbor: string): CML.Transaction | string {
  try {
    return decodeTransaction(txCbor, 'The transaction');
  } catch (error) {
    return `the transaction cannot be read: ${errorText(error)}`;
  }
}

/**
 * The first rule that a Delegate breaks, or null when the keys may sign it. The transaction has the hash that the builder reports; it mints exactly one token, the token of this delegation under
 * the delegation policy; it has exactly one output at the delegation script, and that output holds the datum that was asked for; every other output goes to the wallet of the agent; its TTL is the slot of
 * the end of validity that the build reports; it has no certificate, withdrawal, vote, proposal or gift to the treasury; its required signers are the keys of this run; and its fee and its collateral are
 * within the limits.
 */
export function delegateTxProblem(txCbor: string, e: DelegateExpectation): string | null {
  const tx = decoded(txCbor);
  if (typeof tx === 'string') return tx;
  const body = tx.body();
  if (CML.hash_transaction(body).to_hex() !== e.txHash) return 'the hash that the builder reports is not the hash of the transaction';
  if (!isOnly(mintedTokens(body.mint()), e.script.hash, e.id, 1n)) return 'the transaction does not mint exactly the one token of this delegation';
  const scriptHex = addressHexOf(e.script.address);
  const outputs = body.outputs();
  const atScript: CML.TransactionOutput[] = [];
  for (let index = 0; index < outputs.len(); index += 1) {
    const output = outputs.get(index);
    const address = output.address().to_hex();
    if (address === scriptHex) atScript.push(output);
    else if (address !== e.walletHex) return `output ${index} of the transaction goes to an address that is neither the delegation script nor the wallet of the agent`;
  }
  if (atScript.length !== 1) return `the transaction has ${atScript.length} outputs at the delegation script, and it needs exactly one`;
  const problem = delegationOutputProblem(atScript[0]!, e);
  return problem ?? ttlProblem(body, e.ttlSlot) ?? bodyProblem(tx, e);
}

/**
 * The first rule that an Undelegate breaks, or null. The transaction has the hash that the builder reports; it burns exactly the one token of this delegation; every output goes to the wallet of
 * the agent; and the rules for the body of every transaction hold.
 */
export function undelegateTxProblem(txCbor: string, e: TxExpectation): string | null {
  const tx = decoded(txCbor);
  if (typeof tx === 'string') return tx;
  const body = tx.body();
  if (CML.hash_transaction(body).to_hex() !== e.txHash) return 'the hash that the builder reports is not the hash of the transaction';
  if (!isOnly(mintedTokens(body.mint()), e.script.hash, e.id, -1n)) return 'the transaction does not burn exactly the one token of this delegation';
  const outputs = body.outputs();
  for (let index = 0; index < outputs.len(); index += 1) {
    if (outputs.get(index).address().to_hex() !== e.walletHex) return `output ${index} of the transaction goes to an address that is not the wallet of the agent`;
  }
  return bodyProblem(tx, e);
}
