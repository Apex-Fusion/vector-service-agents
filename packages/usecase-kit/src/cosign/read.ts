// packages/usecase-kit/src/cosign/read.ts
// Reads a transaction from outside as a Delegate, or refuses it. The reading is in this order, and a step never runs after a step that refused:
//   1. The layout, from the bytes (layout.ts): the keys of the body and of the witness set. A part that a Delegate does not have is refused here, before a decoder library reads the transaction.
//   2. The checked decode of the repository (the depth check, then CML), and the proof that the decoder read all of the bytes: the transaction must write itself back as the same text.
//   3. The mint: one token of the delegation policy, and nothing else.
//   4. The outputs: one output at the delegation script, with an inline datum, and the token and nothing else.
//   5. The datum. It is the only nested value that this code decodes.
//   6. The redeemer: one, for the mint.
// The route judges the facts that this file returns. This file decides what a Delegate is, and the route decides whether the agent signs it.
import { CML } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import { delegationProblems } from '@vsa/buyer-core';
import type { IdentityDeployment, OutRef } from '@vsa/buyer-core';
import { decodeTransaction } from '@vsa/vector-read/guarded-decode';
import { decodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import type { DelegationDatum } from '@vsa/vector-read/identity-codec';
import { refused, type Refused, type ProtocolResult, accepted } from '../protocol/index.ts';
import { MAX_SPENT_OUTPUTS } from './codes.ts';
import { bodyBytesOf, readFrame } from './layout.ts';
import type { Frame } from './layout.ts';

/** One vkey witness of the transaction: the key as it is written, the blake2b-224 hash of that key (56 hex characters), and the signature as it is written. */
export interface VkeyWitness {
  readonly keyHash: string;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
}

/** What the route needs to know about a transaction that has the form of a Delegate. */
export interface DelegateFacts {
  /** The bytes of the transaction, as they came. */
  readonly bytes: Uint8Array;
  readonly frame: Frame;
  /** The blake2b-256 hash of the bytes of the body: the 32 bytes that a key signs. */
  readonly bodyHash: Uint8Array;
  readonly delegation: DelegationDatum;
  /** The key hashes (56 hex characters each) in the required signers of the body, in the order of the body. */
  readonly requiredSigners: readonly string[];
  /** The vkey witnesses that the transaction carries now, in the order of the witness set. */
  readonly witnesses: readonly VkeyWitness[];
  /** The outputs that the transaction spends and uses as collateral, each one once. */
  readonly spent: readonly OutRef[];
  /** The slot of the start and the slot of the end of the validity window. */
  readonly validFromSlot: bigint;
  readonly validToSlot: bigint;
}

/** The parts of a body that a Delegate has, with the keys of the body map. The others are refused. */
const REQUIRED_BODY_KEYS: readonly number[] = [0, 1, 2, 3, 8, 9, 11, 13, 14, 18];
const OPTIONAL_BODY_KEYS: readonly number[] = [16, 17];
/** The parts that a Delegate has no use for. The detail names them from this table and never from the input. */
const REFUSED_PARTS: Readonly<Record<number, string>> = {
  4: 'a certificate', 5: 'a withdrawal', 6: 'an update', 7: 'auxiliary data', 15: 'a network id', 19: 'a vote', 20: 'a proposal', 21: 'a treasury value', 22: 'a donation',
};
/** The parts of a witness set that a Delegate has: the vkey witnesses (0) and the redeemers (5). The script is a reference input, so no script and no datum is in the witness set. */
const WITNESS_KEYS: readonly number[] = [0, 5];

const notADelegation = (detail: string): Refused<'not_a_delegation'> => refused('not_a_delegation', detail);

const refsOf = (list: { len(): number; get(i: number): { transaction_id(): { to_hex(): string }; index(): bigint } } | undefined): OutRef[] => {
  const refs: OutRef[] = [];
  for (let i = 0; list !== undefined && i < list.len(); i++) refs.push({ txHash: list.get(i).transaction_id().to_hex(), outputIndex: Number(list.get(i).index()) });
  return refs;
};

/** The bech32 text of an address, or undefined for an address that has none (a Byron address). */
function bech32Of(address: CML.Address): string | undefined {
  try {
    return address.to_bech32();
  } catch {
    return undefined;
  }
}

/** The one token that a value holds, as its policy, its name and its quantity; null when the value holds no token, or more than one. */
function soleToken(value: CML.Value): { policy: string; name: string; quantity: bigint } | null {
  const held = value.multi_asset();
  if (held.policy_count() !== 1) return null;
  const policy = held.keys().get(0);
  const names = held.get_assets(policy)?.keys();
  if (names === undefined || names.len() !== 1) return null;
  const name = names.get(0);
  return { policy: policy.to_hex(), name: name.to_hex(), quantity: held.get(policy, name) ?? 0n };
}

/**
 * Reads `hex` (lower-case hex of whole bytes) as a Delegate transaction of `deployment`, or refuses it with `not_a_delegation`. A transaction of the right form can still be refused by the route: this
 * file does not look at the agent, the allowlist, the window or the ledger.
 */
export function readDelegateTransaction(hex: string, deployment: IdentityDeployment): ProtocolResult<DelegateFacts, 'not_a_delegation'> {
  const bytes = Buffer.from(hex, 'hex');
  const frame = readFrame(bytes);
  if (frame === undefined) return notADelegation('the transaction is not laid out as a transaction');
  const bodyKeys = frame.body.entries.map((entry) => entry.key);
  for (const key of bodyKeys) {
    if (!REQUIRED_BODY_KEYS.includes(key) && !OPTIONAL_BODY_KEYS.includes(key)) return notADelegation(`the transaction has ${REFUSED_PARTS[key] ?? 'a part'} that a Delegate does not have`);
  }
  if (REQUIRED_BODY_KEYS.some((key) => !bodyKeys.includes(key))) return notADelegation('the transaction lacks a part that a Delegate has');
  const witnessKeys = frame.witnesses.entries.map((entry) => entry.key);
  if (witnessKeys.some((key) => !WITNESS_KEYS.includes(key)) || !witnessKeys.includes(5)) return notADelegation('the witness set is not the witness set of a Delegate');
  if (!frame.isValid) return notADelegation('the transaction is marked as one whose scripts fail');
  if (!frame.auxiliaryIsNull) return notADelegation('the transaction has auxiliary data');

  let tx: CML.Transaction;
  try {
    tx = decodeTransaction(hex, 'the transaction');
  } catch {
    return notADelegation('the transaction does not decode');
  }
  if (tx.to_cbor_hex() !== hex) return notADelegation('the decoder did not read the transaction as it was written');
  const body = tx.body();
  const bodyBytes = bodyBytesOf(bytes, frame);
  const bodyHash = blake2b(bodyBytes, { dkLen: 32 });
  if (Buffer.from(bodyHash).toString('hex') !== CML.hash_transaction(body).to_hex()) return notADelegation('the decoder and the bytes give two bodies');

  // The mint: one token of the delegation policy, quantity 1, and nothing else.
  const policy = deployment.delegation.hash;
  const minted = body.mint();
  const policies = minted?.keys();
  if (minted === undefined || policies === undefined || policies.len() !== 1 || policies.get(0).to_hex() !== policy) return notADelegation('the transaction must mint one token of the delegation policy and nothing else');
  const names = minted.get_assets(policies.get(0))?.keys();
  if (names === undefined || names.len() !== 1 || minted.get(policies.get(0), names.get(0)) !== 1n) return notADelegation('the transaction must mint one token of the delegation policy and nothing else');
  const tokenName = names.get(0).to_hex();

  // The outputs: one at the delegation script. An output that has the script as its payment credential and another address is refused too.
  let found: CML.TransactionOutput | undefined;
  const outputs = body.outputs();
  for (let i = 0; i < outputs.len(); i++) {
    const output = outputs.get(i);
    if (bech32Of(output.address()) === deployment.delegation.address) {
      if (found !== undefined) return notADelegation('the transaction has more than one output at the delegation script');
      found = output;
    } else if (output.address().payment_cred()?.as_script()?.to_hex() === policy) {
      return notADelegation('the transaction has an output at the delegation script with another address');
    }
  }
  if (found === undefined) return notADelegation('the transaction has no output at the delegation script');
  const token = soleToken(found.amount());
  if (token === null || token.policy !== policy || token.name !== tokenName || token.quantity !== 1n) return notADelegation('the delegation output must hold the minted token and no other token');
  if (found.script_ref() !== undefined) return notADelegation('the delegation output has a reference script');
  const inline = found.datum()?.as_datum();
  if (inline === undefined) return notADelegation('the delegation output has no inline datum');

  let delegation: DelegationDatum;
  try {
    delegation = decodeDelegationDatum(inline.to_cbor_hex());
  } catch {
    return notADelegation('the datum of the delegation output is not a delegation');
  }
  if (delegationProblems(delegation).length > 0) return notADelegation('the delegation breaks a rule of the delegation contract');
  if (delegation.delegator.type === 'PrincipalKey' && (delegation.parent !== null || delegation.depth !== 1)) return notADelegation('the delegation of a principal key must be a first delegation');

  // The redeemer: one, and it is for the mint.
  const redeemers = tx.witness_set().redeemers()?.to_flat_format();
  if (redeemers === undefined || redeemers.len() !== 1 || redeemers.get(0).tag() !== CML.RedeemerTag.Mint || redeemers.get(0).index() !== 0n) {
    return notADelegation('the transaction must have one redeemer, for the mint');
  }

  const inputs = refsOf(body.inputs());
  const collateral = refsOf(body.collateral_inputs());
  if (inputs.length === 0 || collateral.length === 0) return notADelegation('the transaction needs an input and a collateral input');
  const spent = [...inputs, ...collateral].filter((ref, i, all) => all.findIndex((other) => other.txHash === ref.txHash && other.outputIndex === ref.outputIndex) === i);
  if (spent.length > MAX_SPENT_OUTPUTS) return notADelegation('the transaction spends more outputs than a Delegate does');

  const signers = body.required_signers();
  const requiredSigners: string[] = [];
  for (let i = 0; signers !== undefined && i < signers.len(); i++) requiredSigners.push(signers.get(i).to_hex());
  const vkeys = tx.witness_set().vkeywitnesses();
  const witnesses: VkeyWitness[] = [];
  for (let i = 0; vkeys !== undefined && i < vkeys.len(); i++) {
    const witness = vkeys.get(i);
    const publicKey = Uint8Array.from(witness.vkey().to_raw_bytes());
    witnesses.push({ keyHash: Buffer.from(blake2b(publicKey, { dkLen: 28 })).toString('hex'), publicKey, signature: Uint8Array.from(witness.ed25519_signature().to_raw_bytes()) });
  }
  const validFromSlot = body.validity_interval_start();
  const validToSlot = body.ttl();
  if (validFromSlot === undefined || validToSlot === undefined) return notADelegation('the transaction has no validity window');

  return accepted({ bytes, frame, bodyHash, delegation, requiredSigners, witnesses, spent, validFromSlot, validToSlot });
}
