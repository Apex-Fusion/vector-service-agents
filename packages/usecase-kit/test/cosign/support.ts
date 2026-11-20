// packages/usecase-kit/test/cosign/support.ts
// The world of the tests of the co-sign route. It is the fixture world of buyer-core: the real `buildDelegate` builds each Delegate transaction on it, and the real code of the delegation contract
// runs on the build. A hostile transaction is a build with one change, made with the decoder library. No test touches the network, and no key is real: every key is `Buffer.alloc(32, n)`.
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { buildDelegate, lucidForAddress } from '@vsa/buyer-core';
import type { DelegateParams } from '@vsa/buyer-core';
import { encodeDelegationDatum, utf8Hex } from '@vsa/vector-read/identity-codec';
import type { DelegationDatum } from '@vsa/vector-read/identity-codec';
import { COSIGN_SETTINGS, createCosignRoute, parseCosignSettings, providerLedger } from '@vsa/usecase-kit/cosign';
import type { CosignConfig, CosignLedger, CosignRoute, DelegationKey } from '@vsa/usecase-kit/cosign';
import type { FixtureProvider } from '../../../buyer-core/test/fixtures/fixture-provider.ts';
import { DAY, DEPLOYMENT, NOW, OWN_ADDRESS, identityWorld, recordUtxo, rootRecord, testKey } from '../../../buyer-core/test/fixtures/identity-world.ts';

export { DAY, DEPLOYMENT, NOW, OWN_ADDRESS };

/** The start of the chain in the fixture node: slot 0. */
export const SYSTEM_START_MS = 1_756_485_600_000;

export const AGENT_ID = 'ab'.repeat(32);
export const AGENT_DID = `did:vector:${AGENT_ID}`;
export const OTHER_AGENT_ID = 'cd'.repeat(32);

/** A key of the tests: its number n gives the private key `Buffer.alloc(32, n)`. */
export interface TestKey {
  readonly n: number;
  readonly publicKey: string;
  readonly keyHash: string;
}
const keyOf = (n: number): TestKey => ({ n, ...testKey(n) });
export const privateKeyOf = (key: TestKey): CML.PrivateKey => CML.PrivateKey.from_normal_bytes(Buffer.alloc(32, key.n));

/** The two delegation keys of the agent. */
export const DELEG_A = keyOf(21);
export const DELEG_B = keyOf(22);
/** Other keys of the agent: the keys of its service and of its supplier, which its record lists with the delegation purpose too. */
export const SUPPLIER = keyOf(23);
export const SERVICE = keyOf(24);
/** The key of another agent. */
export const OTHER_AGENT_KEY = keyOf(25);
/** The member: the principal key of the delegations. */
export const PRINCIPAL = keyOf(31);
export const STRANGER = keyOf(32);

/** The wallet of a key of the agent: an enterprise address, with a collateral output of 5 AP3X and a float of 20. */
export const walletAddress = (key: TestKey): string => credentialToAddress('Mainnet', { type: 'Key', hash: key.keyHash });
export const agentWallet = (key: TestKey, index = 0): UTxO => ({
  txHash: key.keyHash.slice(0, 8).repeat(8), outputIndex: index, address: walletAddress(key), assets: { lovelace: index === 0 ? 5_000_000n : 20_000_000n },
});

/** An output at the delegation script, as a live delegation that names `keyHash` as its delegate key. */
export function liveDelegation(keyHash: string, id = '77'.repeat(32)): UTxO {
  const datum: DelegationDatum = {
    delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash, organisation: null }, parent: null, delegate: AGENT_ID, delegateKey: keyHash, actions: [utf8Hex('marketplace.hire.v1')],
    resources: [], notBefore: NOW - DAY, notAfter: NOW + DAY, depth: 1, remaining: 0, purpose: null, value: null,
  };
  return {
    txHash: id.slice(0, 2).repeat(32), outputIndex: 0, address: DEPLOYMENT.delegation.address, assets: { lovelace: 2_000_000n, [`${DEPLOYMENT.delegation.hash}${id}`]: 1n }, datum: encodeDelegationDatum(datum),
  };
}

/** The records of the two agents, and the wallets of the agent. The record of the agent lists its supplier key and its service key with the delegation purpose too, so the builder accepts them. */
export function world(extra: UTxO[] = []): FixtureProvider {
  const listed = (key: TestKey, purposes: number) => ({ keyType: 'Ed25519' as const, key: key.publicKey, purposes, pop: null });
  const agent = rootRecord({ keys: [listed(DELEG_A, 16), listed(DELEG_B, 16), listed(SUPPLIER, 1 + 8 + 16), listed(SERVICE, 16)] });
  const other = rootRecord({ keys: [listed(OTHER_AGENT_KEY, 16)] });
  const wallets = [DELEG_A, DELEG_B, SUPPLIER, SERVICE].flatMap((key) => [agentWallet(key, 0), agentWallet(key, 1)]);
  return identityWorld([recordUtxo(AGENT_ID, agent), recordUtxo(OTHER_AGENT_ID, other), ...wallets, ...extra]);
}

/** The Delegate that the member builds for the agent with the real builder: the delegation key A, the principal key of the member, a window that ends 30 minutes after NOW. */
export async function build(over: Partial<DelegateParams> = {}, provider: FixtureProvider = world()): Promise<{ hex: string; id: string; hi: number }> {
  const changeAddress = over.changeAddress ?? OWN_ADDRESS;
  const lucid = await lucidForAddress(provider, changeAddress);
  const built = await buildDelegate({ lucid, provider, deployment: DEPLOYMENT }, {
    changeAddress, nowMs: NOW, validMinutes: 30, delegator: { type: 'PrincipalKey', hash: PRINCIPAL.keyHash }, delegate: AGENT_ID, delegateKey: DELEG_A.keyHash,
    actions: ['marketplace.hire.v1'], resources: [`script:${'bd'.repeat(28)}`], notAfter: NOW + 7 * DAY, remaining: 1, value: { perTx: 7_000_000n, total: 7_000_000n, periodMs: DAY }, ...over,
  });
  return { hex: built.txCbor, id: built.id, hi: built.validTo };
}

/** The ledger of the tests: the node of the fixture world, as `providerLedger` reads it. */
export const ledgerOf = (provider: FixtureProvider): CosignLedger => providerLedger(provider, DEPLOYMENT);

export interface Setup {
  now: number;
  /** The principal keys on the allowlist. */
  allowed: string[];
  /** The delegation keys that the service holds. */
  keys: TestKey[];
  otherKeyHashes: string[];
  ledger: CosignLedger;
  limits: Record<string, string>;
}

export interface Harness {
  route: CosignRoute;
  /** The body hashes that the sign functions got, with the key hash of each. */
  signed: { keyHash: string; message: Uint8Array }[];
  logs: string[];
  /** The clock: a test moves it. */
  clock: { now: number };
}

/** A sign function over the private key of `key`. */
export function signerOf(key: TestKey, signed: Harness['signed'] = []): DelegationKey {
  const secret = privateKeyOf(key);
  return {
    publicKey: key.publicKey,
    sign: (message) => {
      signed.push({ keyHash: key.keyHash, message: Uint8Array.from(message) });
      return secret.sign(message).to_raw_bytes();
    },
  };
}

/** The route of the agent, with the world of the tests. A test changes what it needs: the clock, the allowlist, the keys of the service, the ledger. */
export function harness(over: Partial<Setup> = {}): Harness {
  const clock = { now: over.now ?? NOW };
  const signed: Harness['signed'] = [];
  const logs: string[] = [];
  const keys = over.keys ?? [DELEG_A, DELEG_B];
  const settings = parseCosignSettings({ [COSIGN_SETTINGS.allowlist]: (over.allowed ?? [PRINCIPAL.keyHash]).join('\n'), ...over.limits });
  if (!settings.ok) throw new Error(`test settings: ${settings.detail}`);
  const config: CosignConfig = {
    agentDid: AGENT_DID, deployment: DEPLOYMENT, delegationKeys: keys.map((key) => signerOf(key, signed)), otherKeyHashes: over.otherKeyHashes ?? [SUPPLIER.keyHash, SERVICE.keyHash],
    settings: settings.value, ledger: over.ledger ?? ledgerOf(world()), systemStartMs: SYSTEM_START_MS, now: () => clock.now, log: (line) => logs.push(line),
  };
  const made = createCosignRoute(config);
  if (!made.ok) throw new Error(`test route: ${made.detail}`);
  return { route: made.value, signed, logs, clock };
}

/** The request body of the route for a transaction. */
export const requestOf = (hex: string): string => JSON.stringify({ transaction: hex });

// ─── Changes that make a hostile transaction out of a build ─────────────────────────────────────────────────────────────────────

export const refOf = (utxo: Pick<UTxO, 'txHash' | 'outputIndex'>): CML.TransactionInput => CML.TransactionInput.new(CML.TransactionHash.from_hex(utxo.txHash), BigInt(utxo.outputIndex));

function inputList(refs: CML.TransactionInput[]): CML.TransactionInputList {
  const list = CML.TransactionInputList.new();
  for (const ref of refs) list.add(ref);
  return list;
}
const inputsOf = (list: CML.TransactionInputList | undefined): CML.TransactionInput[] => Array.from({ length: list?.len() ?? 0 }, (_, i) => list!.get(i));

/** A body with the same parts as `old`, and the inputs, the outputs and the fee that `over` gives. CML has no setter for these three. */
function rebuilt(old: CML.TransactionBody, over: { inputs?: CML.TransactionInputList; outputs?: CML.TransactionOutputList }): CML.TransactionBody {
  const body = CML.TransactionBody.new(over.inputs ?? old.inputs(), over.outputs ?? old.outputs(), old.fee());
  const ttl = old.ttl();
  if (ttl !== undefined) body.set_ttl(ttl);
  const start = old.validity_interval_start();
  if (start !== undefined) body.set_validity_interval_start(start);
  const mint = old.mint();
  if (mint !== undefined) body.set_mint(mint);
  const scriptData = old.script_data_hash();
  if (scriptData !== undefined) body.set_script_data_hash(scriptData);
  const collateral = old.collateral_inputs();
  if (collateral !== undefined) body.set_collateral_inputs(collateral);
  const signers = old.required_signers();
  if (signers !== undefined) body.set_required_signers(signers);
  const returned = old.collateral_return();
  if (returned !== undefined) body.set_collateral_return(returned);
  const total = old.total_collateral();
  if (total !== undefined) body.set_total_collateral(total);
  const references = old.reference_inputs();
  if (references !== undefined) body.set_reference_inputs(references);
  return body;
}

/** What a change may touch: the body, the witness set, and the auxiliary data of a transaction. */
export interface Parts {
  body: CML.TransactionBody;
  witnesses: CML.TransactionWitnessSet;
  auxiliary?: CML.AuxiliaryData;
  valid: boolean;
}

/** The transaction `hex` with one change, as hex. The decoder library writes the changed transaction, so its body is canonical, and a test that needs the bytes of the builder keeps the build. */
export function changed(hex: string, change: (parts: Parts) => void): string {
  const tx = CML.Transaction.from_cbor_hex(hex);
  const parts: Parts = { body: tx.body(), witnesses: tx.witness_set(), valid: tx.is_valid(), ...(tx.auxiliary_data() === undefined ? {} : { auxiliary: tx.auxiliary_data()! }) };
  change(parts);
  return CML.Transaction.new(parts.body, parts.witnesses, parts.valid, parts.auxiliary).to_cbor_hex();
}

/** The transaction with one more input. */
export const withInput = (hex: string, utxo: UTxO): string => changed(hex, (p) => { p.body = rebuilt(p.body, { inputs: inputList([...inputsOf(p.body.inputs()), refOf(utxo)]) }); });
/** The transaction with another collateral input (the same count). */
export const withCollateral = (hex: string, utxo: UTxO): string => changed(hex, (p) => { p.body.set_collateral_inputs(inputList([refOf(utxo)])); });
/** The transaction with the output at `index` paid to `address`. */
export function withOutputAddress(hex: string, index: number, address: string): string {
  return changed(hex, (p) => {
    const outputs = CML.TransactionOutputList.new();
    const old = p.body.outputs();
    for (let i = 0; i < old.len(); i++) {
      const output = old.get(i);
      outputs.add(i === index ? CML.TransactionOutput.new(CML.Address.from_bech32(address), output.amount(), output.datum(), output.script_ref()) : output);
    }
    p.body = rebuilt(p.body, { outputs });
  });
}
/** The transaction whose outputs are `make(old outputs)`. */
export function withOutputs(hex: string, make: (outputs: CML.TransactionOutput[]) => CML.TransactionOutput[]): string {
  return changed(hex, (p) => {
    const old = p.body.outputs();
    const list = CML.TransactionOutputList.new();
    for (const output of make(Array.from({ length: old.len() }, (_, i) => old.get(i)))) list.add(output);
    p.body = rebuilt(p.body, { outputs: list });
  });
}
/** The transaction whose mint is `make()`: a map of policy to a list of [name, quantity]. */
export function withMint(hex: string, mint: Record<string, [string, bigint][]>): string {
  return changed(hex, (p) => {
    const value = CML.Mint.new();
    for (const [policy, assets] of Object.entries(mint)) for (const [name, quantity] of assets) value.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_hex(name), quantity);
    p.body.set_mint(value);
  });
}
/** The transaction with a redeemer for each of `tags` (0 spend, 1 mint, 2 cert, 3 reward, 4 voting, 5 proposing) at the index 0. */
export function withRedeemers(hex: string, tags: number[]): string {
  return changed(hex, (p) => {
    const list = CML.LegacyRedeemerList.new();
    for (const tag of tags) list.add(CML.LegacyRedeemer.new(tag, 0n, CML.PlutusData.new_integer(CML.BigInteger.from_str('0')), CML.ExUnits.new(1n, 1n)));
    p.witnesses.set_redeemers(CML.Redeemers.new_arr_legacy_redeemer(list));
  });
}
/** The transaction with the required signers `hashes`. */
export function withRequiredSigners(hex: string, hashes: string[]): string {
  return changed(hex, (p) => {
    const list = CML.Ed25519KeyHashList.new();
    for (const hash of hashes) list.add(CML.Ed25519KeyHash.from_hex(hash));
    p.body.set_required_signers(list);
  });
}
/** The transaction signed by `key` over its body, as the member signs it. */
export function signedBy(hex: string, key: TestKey): string {
  return changed(hex, (p) => {
    const list = p.witnesses.vkeywitnesses() ?? CML.VkeywitnessList.new();
    const secret = privateKeyOf(key);
    list.add(CML.Vkeywitness.new(secret.to_public(), secret.sign(CML.hash_transaction(p.body).to_raw_bytes())));
    p.witnesses.set_vkeywitnesses(list);
  });
}

/** The body of the transaction `hex` in hex, from the decoder library. */
export const bodyHexOf = (hex: string): string => CML.Transaction.from_cbor_hex(hex).body().to_cbor_hex();
/** The hash of the body of the transaction `hex`: the hash that a key signs. */
export const bodyHashOf = (hex: string): string => CML.hash_transaction(CML.Transaction.from_cbor_hex(hex).body()).to_hex();

/** The vkey witnesses of a transaction as `[key hash, public key, signature]`. */
export function witnessesOf(hex: string): [string, string, string][] {
  const list = CML.Transaction.from_cbor_hex(hex).witness_set().vkeywitnesses();
  return Array.from({ length: list?.len() ?? 0 }, (_, i) => {
    const witness = list!.get(i);
    return [witness.vkey().hash().to_hex(), Buffer.from(witness.vkey().to_raw_bytes()).toString('hex'), witness.ed25519_signature().to_hex()];
  });
}

/**
 * What the hosted tool does with the answer of an agent (`cosignWitnessOf` in mcp-server): the body of the answer is the body that was sent, the decoder reads the answer as it is written, the
 * answer holds exactly one witness of the delegate key, and its signature verifies over the hash of the body. The tool takes that one witness and nothing else of the answer.
 */
export function hostedToolTakes(sentHex: string, answerHex: string, delegateKeyHash: string): { ok: true; witness: [string, string, string] } | { ok: false; why: string } {
  let tx: CML.Transaction;
  try {
    tx = CML.Transaction.from_cbor_hex(answerHex);
  } catch {
    return { ok: false, why: 'the answer does not decode' };
  }
  if (tx.to_cbor_hex() !== answerHex) return { ok: false, why: 'the answer does not decode as written' };
  if (bodyHexOf(answerHex) !== bodyHexOf(sentHex)) return { ok: false, why: 'the body is not the body that was sent' };
  const own = witnessesOf(answerHex).filter(([hash]) => hash === delegateKeyHash);
  if (own.length !== 1) return { ok: false, why: `the answer has ${own.length} witnesses of the delegate key` };
  const [witness] = own;
  const verified = CML.PublicKey.from_bytes(Buffer.from(witness![1], 'hex')).verify(Buffer.from(bodyHashOf(sentHex), 'hex'), CML.Ed25519Signature.from_hex(witness![2]));
  return verified ? { ok: true, witness: witness! } : { ok: false, why: 'the signature does not verify' };
}
