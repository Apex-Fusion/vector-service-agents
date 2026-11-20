// packages/usecase-kit/test/dispute/ledger.ts
// A small ledger over the fixture world of the buyer code, so that the real chain port runs its builders and a test can read what the transactions did. The fixture world has the mainnet Module-1
// scripts, and Lucid runs them on every build. This provider adds what the fixture node lacks: it takes a signed transaction, checks that the required signers signed it, removes the outputs that the
// transaction spends, adds the outputs that it makes, and keeps the document that it carries. A transaction is confirmed when the provider has taken it, unless a test says that it is not.
import { CML, coreToTxOutput } from '@lucid-evolution/lucid';
import type { Address, Credential, OutRef, UTxO } from '@lucid-evolution/lucid';
import { rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import { FixtureProvider } from '../../../buyer-core/test/fixtures/fixture-provider.ts';
import { AUDITOR_ID, CLAIMER_ID, JURY_REF_UTXO, MODULE1, MODULE1_UTXOS, WALLET, WALLET_ADDRESS, WALLET_UTXOS, recordUtxo } from '../../../buyer-core/test/fixtures/jury-world.ts';
import { createModule1Port } from '@vsa/usecase-kit/dispute';
import type { Module1Port, Module1PortDeps } from '@vsa/usecase-kit/dispute';

export { AUDITOR_ID, CLAIMER_ID, JURY_REF_UTXO, MODULE1, WALLET, WALLET_ADDRESS };

/** The label of a document in the metadata of a transaction. */
const DOCUMENT_LABEL = 22084n;

const refOf = (utxo: { txHash: string; outputIndex: number }): string => `${utxo.txHash}#${utxo.outputIndex}`;

export class LedgerProvider extends FixtureProvider {
  /** The outputs that are unspent now. */
  live: UTxO[];
  /** The hashes of the transactions that the provider took, in order. */
  readonly accepted: string[] = [];
  /** The signed transactions that the provider took, in order. */
  readonly raw: string[] = [];
  /** The text of the document that a transaction carried, by the hash of the transaction. */
  readonly documents = new Map<string, string>();
  /** False makes `awaitTx` answer that a transaction is not confirmed. */
  confirms = true;
  /** An error that `submitTx` throws instead of taking the transaction. */
  refuses: Error | null = null;

  constructor(utxos: UTxO[]) {
    super(utxos);
    this.live = [...utxos];
  }

  override async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    if (typeof addressOrCredential !== 'string') throw new Error('LedgerProvider: credential queries are not supported');
    return this.live.filter((utxo) => utxo.address === addressOrCredential);
  }

  override async getUtxosByOutRef(outRefs: OutRef[]): Promise<UTxO[]> {
    return this.live.filter((utxo) => outRefs.some((ref) => ref.txHash === utxo.txHash && Number(ref.outputIndex) === utxo.outputIndex));
  }

  override async submitTx(tx: string): Promise<string> {
    if (this.refuses !== null) throw this.refuses;
    const parsed = CML.Transaction.from_cbor_hex(tx);
    const body = parsed.body();
    const hash = CML.hash_transaction(body).to_hex();
    // The required signers must have signed, and each signature must verify.
    const signed = new Set<string>();
    const witnesses = parsed.witness_set().vkeywitnesses();
    for (let index = 0; index < (witnesses?.len() ?? 0); index += 1) {
      const witness = witnesses!.get(index);
      if (!witness.vkey().verify(CML.hash_transaction(body).to_raw_bytes(), witness.ed25519_signature())) throw new Error('LedgerProvider: a signature does not verify');
      signed.add(witness.vkey().hash().to_hex());
    }
    const required = body.required_signers();
    for (let index = 0; index < (required?.len() ?? 0); index += 1) {
      if (!signed.has(required!.get(index).to_hex())) throw new Error(`LedgerProvider: the required signer ${required!.get(index).to_hex()} did not sign`);
    }
    if (signed.size === 0) throw new Error('LedgerProvider: the transaction has no signature');
    // The inputs must be unspent outputs.
    const spent = new Set<string>();
    const inputs = body.inputs();
    for (let index = 0; index < inputs.len(); index += 1) spent.add(`${inputs.get(index).transaction_id().to_hex()}#${inputs.get(index).index()}`);
    for (const ref of spent) if (!this.live.some((utxo) => refOf(utxo) === ref)) throw new Error(`LedgerProvider: the input ${ref} is not an unspent output`);
    this.live = this.live.filter((utxo) => !spent.has(refOf(utxo)));
    const outputs = body.outputs();
    for (let index = 0; index < outputs.len(); index += 1) {
      const output = coreToTxOutput(outputs.get(index));
      this.live.push({ txHash: hash, outputIndex: index, address: output.address, assets: output.assets, ...(output.datum ? { datum: output.datum } : {}) });
    }
    const metadatum = parsed.auxiliary_data()?.metadata()?.get(DOCUMENT_LABEL);
    if (metadatum !== undefined) {
      const document = JSON.parse(CML.decode_metadatum_to_json_str(metadatum, CML.MetadataJsonSchema.BasicConversions)) as { d: string[] };
      this.documents.set(hash, document.d.join(''));
    }
    this.accepted.push(hash);
    this.raw.push(tx);
    return hash;
  }

  override async awaitTx(txHash: string): Promise<boolean> {
    return this.confirms && this.accepted.includes(txHash);
  }

  /** The unspent output at `ref`, or undefined. */
  at(ref: string): UTxO | undefined {
    return this.live.find((utxo) => refOf(utxo) === ref);
  }

  /** The unspent outputs at an address. */
  atAddress(address: string): UTxO[] {
    return this.live.filter((utxo) => utxo.address === address);
  }
}

/** A node with the wallet, the Module-1 outputs, the records of the claimer and the auditor, and `extra`. */
export function ledgerWorld(extra: UTxO[] = [], records: UTxO[] = [recordUtxo(CLAIMER_ID), recordUtxo(AUDITOR_ID)]): LedgerProvider {
  return new LedgerProvider([...WALLET_UTXOS, ...MODULE1_UTXOS, JURY_REF_UTXO, ...records, ...extra]);
}

/** A promise that never settles: a wait that never ends. */
export const forever = (): Promise<never> => new Promise<never>(() => undefined);

/** The signature of the wallet key, made with the signer of the buyer code. The wallet key of the fixture world is a key of 32 bytes of 0x0b. */
export const signWithWallet = (unsignedCborHex: string): { signedCborHex: string; txHashHex: string } => signTransaction(unsignedCborHex, rawHexToBech32('0b'.repeat(32)));

/** The real chain port for `agentId` over the ledger, with a clock at `now` and waits that never end, unless `extra` gives others. */
export function realPort(provider: LedgerProvider, agentId: string, now: number, extra: Partial<Module1PortDeps> = {}): Module1Port {
  return createModule1Port({ provider, module1: MODULE1, address: WALLET_ADDRESS, agent_id: agentId, sign: signWithWallet, clock: () => now, sleep: forever, ...extra });
}
