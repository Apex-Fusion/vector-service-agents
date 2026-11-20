// packages/usecase-kit/test/dispute/ledger.ts
// A small ledger over the fixture world of the buyer code, so that the real chain port runs its builders and a test can read what the transactions did. The fixture world has the mainnet Module-1
// scripts, and Lucid runs them on every build. This provider adds what the fixture node lacks: it takes a signed transaction, checks that the required signers signed it, removes the outputs that the
// transaction spends, adds the outputs that it makes, and keeps the document that it carries. A transaction is confirmed when the provider has taken it, unless a test says that it is not.
// `koiosOf` is a fake Koios over the same ledger: it lists the outputs of a payment credential, at any address, it gives the metadata of a document, and it describes the outputs by reference, spent or not.
// The world holds the escrow of the job of the samples (`jobEscrow`), an output of the identity layout that the real port reads for the time of its block: the fake Koios gives `block_time` for each output.
import { CML, coreToTxOutput, getAddressDetails } from '@lucid-evolution/lucid';
import type { Address, Credential, OutRef, UTxO } from '@lucid-evolution/lucid';
import { documentUri, rawHexToBech32, signTransaction } from '@vsa/buyer-core';
import type { ClaimDatum } from '@vsa/buyer-core';
import { utf8Hex } from '@vsa/vector-read/identity-codec';
import { FixtureProvider } from '../../../buyer-core/test/fixtures/fixture-provider.ts';
import { AUDITOR_ID, CLAIMER_ID, JURY_REF_UTXO, MODULE1, MODULE1_UTXOS, WALLET, WALLET_ADDRESS, WALLET_UTXOS, claimUtxo, recordUtxo } from '../../../buyer-core/test/fixtures/jury-world.ts';
import { DEPLOYMENT } from '../../../buyer-core/test/fixtures/identity-world.ts';
import { escrowUtxo, identityEscrow, submitted } from '../../../buyer-core/test/fixtures/escrow-identity.fixture.ts';
import type { IdentityEscrowDatum } from '@vsa/vector-read';
import { createModule1Port } from '@vsa/usecase-kit/dispute';
import type { Module1Port, Module1PortDeps } from '@vsa/usecase-kit/dispute';
import { CAPABILITY, ESCROW, JOB_BEGAN_AT, kitClaimDocument } from './support.ts';

export { AUDITOR_ID, CLAIMER_ID, JURY_REF_UTXO, MODULE1, WALLET, WALLET_ADDRESS };

/** The label of a document in the metadata of a transaction. */
const DOCUMENT_LABEL = 22084n;

const refOf = (utxo: { txHash: string; outputIndex: number }): string => `${utxo.txHash}#${utxo.outputIndex}`;

/** The hash of the transaction of the escrow output of the job. */
const ESCROW_TX = ESCROW.split('#')[0]!;

/** The metadata of a document, as label 22084 holds it. */
export interface DocumentMetadata {
  readonly v: 1;
  readonly t: string;
  readonly m: string;
  readonly d: string[];
}

export class LedgerProvider extends FixtureProvider {
  /** The outputs that are unspent now. */
  live: UTxO[];
  /** The hashes of the transactions that the provider took, in order. */
  readonly accepted: string[] = [];
  /** The signed transactions that the provider took, in order. */
  readonly raw: string[] = [];
  /** The text of the document that a transaction carried, by the hash of the transaction. */
  readonly documents = new Map<string, string>();
  /** The metadata of the document that a transaction carried, by the hash of the transaction. */
  readonly metadata = new Map<string, DocumentMetadata>();
  /** The routes that the fake Koios was asked, in order. */
  readonly koiosCalls: string[] = [];
  /** False makes `awaitTx` answer that a transaction is not confirmed. */
  confirms = true;
  /** An error that `submitTx` throws instead of taking the transaction. */
  refuses: Error | null = null;
  /** An HTTP status that the fake Koios answers for each route, or null for the right answers. */
  koiosStatus: number | null = null;
  /** Outputs that the fake Koios lists and the node does not hold: spent outputs, or outputs that the node has not seen. */
  readonly koiosOnly: UTxO[] = [];
  /** Outputs that are spent, and that the fake Koios still describes: its output info gives each with `is_spent` true, and no list gives it. Koios keeps the datum of a spent output. */
  readonly koiosSpent: UTxO[] = [];
  /** Transactions that the fake Koios does not have yet: it is behind. Its lists, its metadata and its output info leave their outputs and their documents out. */
  readonly koiosBehind = new Set<string>();
  /** The time of the block of a transaction, in seconds, by the hash of the transaction. The fake Koios gives it as `block_time` for each output that the transaction made. A transaction with no time here has rows with no `block_time`. */
  readonly blockTimes = new Map<string, number>();
  /** Transactions that the fake Koios has and that carry no document, with the CBOR that `tx_cbor` gives for each, or null for a transaction of which it keeps no CBOR. */
  readonly bare = new Map<string, string | null>();
  #documentCount = 0;

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
      const document = JSON.parse(CML.decode_metadatum_to_json_str(metadatum, CML.MetadataJsonSchema.BasicConversions)) as DocumentMetadata;
      this.documents.set(hash, document.d.join(''));
      this.metadata.set(hash, document);
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

  /** Puts a document on the ledger as the label metadata of a transaction that is not in the list of transactions. It gives the hash of that transaction and the URI of the document. */
  addDocument(text: string, type = 'claim', mediaType = 'text/plain'): { readonly tx_hash: string; readonly uri: string } {
    this.#documentCount += 1;
    const txHash = (0xd0 + this.#documentCount).toString(16).padStart(2, '0').repeat(32);
    const chunks = text.match(/[\s\S]{1,60}/g) ?? [];
    this.documents.set(txHash, text);
    this.metadata.set(txHash, { v: 1, t: type, m: mediaType, d: chunks });
    return { tx_hash: txHash, uri: documentUri(txHash) };
  }
}

/**
 * The records of the claimer and the auditor. They are made one time: `recordUtxo` gives each record a transaction hash from a counter that has room for 208 records, and a test file that makes
 * a world for each test goes past it. No test changes an output, and each ledger has its own list of live outputs, so the worlds share these two.
 */
const RECORDS: UTxO[] = [recordUtxo(CLAIMER_ID), recordUtxo(AUDITOR_ID)];

/**
 * The escrow of the job `ESCROW`: an output of the identity layout whose datum says that the escrow was posted at `postedAt`. The datum names the capability of the job, and the counterparty `CLAIMER_ID` as its
 * agent: the agent that this agent hired. `datum` changes members of the datum, and `over` changes members of the output. The output is at the escrow address of the deployment of the fixture world, and it holds more
 * than its datum owes.
 */
export function jobEscrow(postedAt = JOB_BEGAN_AT, over: Partial<UTxO> = {}, datum: Partial<IdentityEscrowDatum> = {}): UTxO {
  const [txHash, index] = ESCROW.split('#') as [string, string];
  return { ...escrowUtxo(txHash, identityEscrow(postedAt, { capability_id: CAPABILITY, agent_id: CLAIMER_ID, ...datum })), outputIndex: Number(index), ...over };
}

/**
 * Puts the escrow of the job into the ledger as the Post made it (live), or as the settlement left it (spent: only the output info of the fake Koios gives it), in the place of the escrow that the ledger has. `at` is the time of
 * the block of its transaction, and the datum says the same time as its member `posted_at`, as a poster that tells the truth writes it. A test that wants another `posted_at`, another capability or another agent changes
 * `datum`, and a test that wants another output changes `over`.
 */
export function postEscrowAt(ledger: LedgerProvider, at: number, spent = false, over: Partial<UTxO> = {}, datum: Partial<IdentityEscrowDatum> = {}): void {
  const others = (utxo: UTxO): boolean => refOf(utxo) !== ESCROW;
  ledger.live = ledger.live.filter(others);
  ledger.koiosSpent.splice(0, ledger.koiosSpent.length, ...ledger.koiosSpent.filter(others));
  ledger.blockTimes.set(ESCROW_TX, Math.floor(at / 1000));
  (spent ? ledger.koiosSpent : ledger.live).push(jobEscrow(at, over, datum));
}

/**
 * The output that a later step of the job made, put into the ledger at the transaction `txHash`, in a block made at `at`: the Claim output (the state Claimed) or the Submit output (the state Submitted). It keeps the
 * members that the Post wrote, as the script keeps them, and it holds the same value. `spent` puts it where the settlement leaves a spent output: only the output info of the fake Koios gives it. The output is the output
 * 0 of the transaction, and this gives its reference.
 */
export function laterEscrowAt(ledger: LedgerProvider, txHash: string, at: number, state: 'Claimed' | 'Submitted', spent: boolean): string {
  const post = identityEscrow(JOB_BEGAN_AT, { capability_id: CAPABILITY, agent_id: CLAIMER_ID });
  (spent ? ledger.koiosSpent : ledger.live).push(escrowUtxo(txHash, state === 'Claimed' ? { ...post, state } : submitted(post, at)));
  ledger.blockTimes.set(txHash, Math.floor(at / 1000));
  return `${txHash}#0`;
}

/** A node with the wallet, the Module-1 outputs, the records of the claimer and the auditor, the escrow of the job, and `extra`: outputs, or a function that makes them with the ledger in hand (a claim needs its document on the ledger). */
export function ledgerWorld(extra: UTxO[] | ((ledger: LedgerProvider) => UTxO[]) = [], records: UTxO[] = RECORDS): LedgerProvider {
  const ledger = new LedgerProvider([...WALLET_UTXOS, ...MODULE1_UTXOS, JURY_REF_UTXO, ...records, jobEscrow()]);
  ledger.blockTimes.set(ESCROW_TX, Math.floor(JOB_BEGAN_AT / 1000));
  ledger.live.push(...(typeof extra === 'function' ? extra(ledger) : extra));
  return ledger;
}

/**
 * A claim output of the claimer of the fixture world (`CLAIMER_ID`, or `overrides.claimerDid`) that is a claim of this kit: its document is the claim document that the kit writes for the claimer,
 * the document is on the ledger, and the claim holds its hash and its URI. `overrides` change members of the datum. The output is at the claim address.
 */
export function kitClaim(ledger: LedgerProvider, token: string, overrides: Partial<ClaimDatum> = {}, ageMs = 3_600_000): UTxO {
  const document = kitClaimDocument(`did:vector:${overrides.claimerDid ?? CLAIMER_ID}`);
  const { uri } = ledger.addDocument(document.text, 'claim');
  return claimUtxo(token, { claimHash: document.hash, storageUri: utf8Hex(uri), ...overrides }, ageMs);
}

/** The payment credential of an address, in hex. */
const paymentCredentialOf = (address: string): string | undefined => getAddressDetails(address).paymentCredential?.hash;

/** A Koios row of an output, as `credential_utxos` and `utxo_info` show it. `spent` is what the row says about the output, and `blockTime` the time of the block of its transaction in seconds, or undefined for a row with none. */
function koiosRow(utxo: UTxO, spent = false, blockTime?: number): Record<string, unknown> {
  const tokens = Object.entries(utxo.assets).filter(([unit]) => unit !== 'lovelace');
  return {
    tx_hash: utxo.txHash, tx_index: utxo.outputIndex, address: utxo.address, value: String(utxo.assets.lovelace), payment_cred: paymentCredentialOf(utxo.address), datum_hash: null,
    inline_datum: utxo.datum ? { bytes: utxo.datum } : null, reference_script: null, is_spent: spent, ...(blockTime === undefined ? {} : { block_time: blockTime }),
    asset_list: tokens.map(([unit, quantity]) => ({ policy_id: unit.slice(0, 56), asset_name: unit.slice(56), quantity: String(quantity), decimals: 0 })),
  };
}

/**
 * A fake Koios over a ledger. `credential_utxos` lists the unspent outputs of a payment credential at any address, with the filter of a token policy, the order, the offset and the limit of a page. It
 * lists the outputs that the node holds, and the outputs of `koiosOnly`. `tx_metadata` gives the label metadata of a document, and no JSON for a transaction of `bare`. `tx_cbor` gives the CBOR of a
 * transaction of `bare`, and `utxo_info` the outputs that the ledger holds. The transactions of `koiosBehind` are not known to any route. Any other route is a 404. `koiosStatus` of the ledger makes
 * every route answer with that status.
 */
export function koiosOf(ledger: LedgerProvider): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const address = new URL(url);
    const route = address.pathname.split('/').pop()!;
    ledger.koiosCalls.push(route);
    if (ledger.koiosStatus !== null) return new Response('{"error":"unavailable"}', { status: ledger.koiosStatus });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, string[]>) : {};
    const answer = (rows: unknown): Response => new Response(JSON.stringify(rows), { status: 200 });
    if (route === 'credential_utxos') {
      let rows = [...ledger.live, ...ledger.koiosOnly].filter((utxo) => !ledger.koiosBehind.has(utxo.txHash) && body._payment_credentials!.includes(paymentCredentialOf(utxo.address) ?? ''));
      const filter = address.searchParams.get('asset_list');
      if (filter?.startsWith('cs.')) {
        const wanted = JSON.parse(filter.slice(3)) as Array<{ policy_id: string }>;
        rows = rows.filter((utxo) => wanted.every((token) => Object.keys(utxo.assets).some((unit) => unit !== 'lovelace' && unit.startsWith(token.policy_id))));
      }
      rows = [...rows].sort((a, b) => (a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : a.outputIndex - b.outputIndex));
      const offset = Number(address.searchParams.get('offset') ?? 0);
      const limit = Number(address.searchParams.get('limit') ?? 1000);
      return answer(rows.slice(offset, offset + limit).map((utxo) => koiosRow(utxo, false, ledger.blockTimes.get(utxo.txHash))));
    }
    if (route === 'tx_metadata') {
      const known = (body._tx_hashes ?? []).filter((hash) => !ledger.koiosBehind.has(hash));
      return answer(known.flatMap((hash): Array<{ tx_hash: string; metadata: unknown }> => (ledger.metadata.has(hash)
        ? [{ tx_hash: hash, metadata: { [String(DOCUMENT_LABEL)]: ledger.metadata.get(hash) } }]
        : ledger.bare.has(hash) ? [{ tx_hash: hash, metadata: null }] : [])));
    }
    if (route === 'tx_cbor') return answer((body._tx_hashes ?? []).filter((hash) => ledger.bare.has(hash)).map((hash) => ({ tx_hash: hash, cbor: ledger.bare.get(hash) })));
    if (route === 'utxo_info') {
      const wanted = new Set(body._utxo_refs ?? []);
      const asked = (utxo: UTxO): boolean => wanted.has(refOf(utxo)) && !ledger.koiosBehind.has(utxo.txHash);
      return answer([
        ...[...ledger.live, ...ledger.koiosOnly].filter(asked).map((utxo) => koiosRow(utxo, false, ledger.blockTimes.get(utxo.txHash))),
        ...ledger.koiosSpent.filter(asked).map((utxo) => koiosRow(utxo, true, ledger.blockTimes.get(utxo.txHash))),
      ]);
    }
    return new Response('[]', { status: 404 });
  }) as unknown as typeof fetch;
}

/** The CBOR of a transaction with no inputs, no outputs and no metadata, as `tx_cbor` of Koios gives it for a transaction that carries no document. */
export const bareTransactionCbor = (): string => CML.Transaction.new(CML.TransactionBody.new(CML.TransactionInputList.new(), CML.TransactionOutputList.new(), 0n), CML.TransactionWitnessSet.new(), true).to_cbor_hex();

/** A promise that never settles: a wait that never ends. */
export const forever = (): Promise<never> => new Promise<never>(() => undefined);

/** The signature of the wallet key, made with the signer of the buyer code. The wallet key of the fixture world is a key of 32 bytes of 0x0b. */
export const signWithWallet = (unsignedCborHex: string): { signedCborHex: string; txHashHex: string } => signTransaction(unsignedCborHex, rawHexToBech32('0b'.repeat(32)));

/** The real chain port for `agentId` over the ledger, with a clock at `now`, the fake Koios of the ledger, and waits that never end, unless `extra` gives others. */
export function realPort(provider: LedgerProvider, agentId: string, now: number, extra: Partial<Module1PortDeps> = {}): Module1Port {
  return createModule1Port({
    provider, module1: MODULE1, address: WALLET_ADDRESS, agent_id: agentId, sign: signWithWallet, clock: () => now, sleep: forever, koios_url: 'https://koios.test', fetch: koiosOf(provider),
    identity_deployment: DEPLOYMENT, ...extra,
  });
}
