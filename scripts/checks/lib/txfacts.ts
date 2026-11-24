// scripts/checks/lib/txfacts.ts - what a transaction says about itself, read from its bytes. The guards judge these facts and never the word of the builder: a builder can be wrong,
// and the bytes are what the ledger sees. The transaction is decoded through the checked decoder of the repository.
import { blake2b256Hex, decodeTransaction } from './platform.ts';

export interface OutputFacts {
  index: number;
  address: string;
  lovelace: bigint;
  /** The assets other than lovelace, by unit (the policy and the asset name in hex). */
  assets: Record<string, bigint>;
  inlineDatum: string | null;
  datumHash: string | null;
  hasScriptRef: boolean;
}

export interface TxFacts {
  /** The bytes of the body, in hex: the bytes that every signature covers. */
  bodyHex: string;
  /** The hash of the body. */
  txHash: string;
  feeLovelace: bigint;
  /** The slot at which the transaction is no longer valid: the `ttl` of the body, the end of the validity interval and not its start. Null when the body has none, and then it can land at any time. */
  validityEndSlot: bigint | null;
  inputs: string[];
  collateralInputs: string[];
  referenceInputs: string[];
  outputs: OutputFacts[];
  collateralReturn: { address: string; lovelace: bigint } | null;
  totalCollateral: bigint | null;
  requiredSigners: string[];
  /** What the transaction mints (positive) and burns (negative), by unit. */
  mint: Record<string, bigint>;
  withdrawals: number;
  certificates: number;
  /** A script runs: the transaction has a script data hash, so it has a redeemer. */
  runsScripts: boolean;
  /** The key hashes of the witnesses that the transaction carries now. */
  witnesses: string[];
}

interface InputList { len(): number; get(i: number): { transaction_id(): { to_hex(): string }; index(): bigint } }
interface AssetNames { keys(): { len(): number; get(i: number): { to_hex(): string } } }
interface Assets { keys(): { len(): number; get(i: number): { to_hex(): string } }; get_assets(policy: unknown): (AssetNames & { get(name: unknown): bigint | undefined }) | undefined }

function refsOf(list: InputList | undefined): string[] {
  const refs: string[] = [];
  for (let i = 0; list !== undefined && i < list.len(); i++) refs.push(`${list.get(i).transaction_id().to_hex()}#${list.get(i).index()}`);
  return refs;
}

/** The assets of a multi-asset value or of a mint, by unit. */
function assetsOf(assets: Assets | undefined): Record<string, bigint> {
  const found: Record<string, bigint> = {};
  if (assets === undefined) return found;
  const policies = assets.keys();
  for (let p = 0; p < policies.len(); p++) {
    const policy = policies.get(p);
    const inner = assets.get_assets(policy);
    const names = inner?.keys();
    for (let n = 0; inner !== undefined && names !== undefined && n < names.len(); n++) {
      const name = names.get(n);
      const quantity = inner.get(name);
      if (quantity !== undefined) found[`${policy.to_hex()}${name.to_hex()}`] = quantity;
    }
  }
  return found;
}

/** Reads the facts of a transaction (hex CBOR, unsigned or signed). A text that is no transaction is refused. */
export function factsOf(txCborHex: string): TxFacts {
  const tx = decodeTransaction(txCborHex);
  const body = tx.body();
  const outputs: OutputFacts[] = [];
  const list = body.outputs();
  for (let i = 0; i < list.len(); i++) {
    const output = list.get(i);
    const assets = assetsOf(output.amount().multi_asset() as unknown as Assets);
    outputs.push({
      index: i, address: output.address().to_bech32(), lovelace: output.amount().coin(), assets,
      inlineDatum: output.datum()?.as_datum()?.to_cbor_hex() ?? null, datumHash: output.datum()?.as_hash()?.to_hex() ?? null, hasScriptRef: output.script_ref() !== undefined,
    });
  }
  const returned = body.collateral_return();
  const required = body.required_signers();
  const requiredSigners: string[] = [];
  for (let i = 0; required !== undefined && i < required.len(); i++) requiredSigners.push(required.get(i).to_hex());
  const vkeys = tx.witness_set().vkeywitnesses();
  const witnesses: string[] = [];
  for (let i = 0; vkeys !== undefined && i < vkeys.len(); i++) witnesses.push(vkeys.get(i).vkey().hash().to_hex());
  const bodyHex = body.to_cbor_hex();
  return {
    bodyHex, txHash: blake2b256Hex(Buffer.from(bodyHex, 'hex')), feeLovelace: body.fee(), validityEndSlot: body.ttl() ?? null,
    inputs: refsOf(body.inputs()), collateralInputs: refsOf(body.collateral_inputs()), referenceInputs: refsOf(body.reference_inputs()),
    outputs,
    collateralReturn: returned === undefined ? null : { address: returned.address().to_bech32(), lovelace: returned.amount().coin() },
    totalCollateral: body.total_collateral() ?? null,
    requiredSigners, mint: assetsOf(body.mint() as unknown as Assets),
    withdrawals: body.withdrawals()?.len() ?? 0, certificates: body.certs()?.len() ?? 0,
    runsScripts: body.script_data_hash() !== undefined, witnesses,
  };
}
