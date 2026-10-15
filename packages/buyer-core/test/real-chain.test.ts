// packages/buyer-core/test/real-chain.test.ts
// RealChain offline. A node made of the vendored fixture provider, with a submit endpoint and a confirmation the test decides, stands in
// for Ogmios and the submit API; fake Koios answers the advert and lineage reads; the vendored OgmiosProvider.submitTx is driven over a
// stubbed fetch where its own answers matter. Covered: the key and the address it derives, the wallet it reads, the Post it builds keyless,
// signs locally, submits and waits for, one transaction at a time and for awaitTimeoutMs at most, the typed error of every failure after
// the signature, the Accept and the Reclaim up to the escrow reference script, the escrow state and receipt hash it reads off the vendored
// lineage, and the endpoints createRealChain wires. Not covered offline: an Accept or a Reclaim that gets past the reference script, which
// needs the deployed escrow script and the node's script evaluation (they then go through the same sign, submit and wait step as the Post).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CML } from '@lucid-evolution/lucid';
import type { Address, Credential, ProtocolParameters, UTxO } from '@lucid-evolution/lucid';
import { blake2b224Hex, decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum } from '@vsa/vector-read';
import type { EscrowDatum } from '@vsa/vector-read';
import {
  createRealChain, feeOfSignedTx, ocrPromptHash, planFleetPostEscrow, rawHexToBech32, signTransaction, OgmiosProvider, TxNotConfirmedError,
  DELIVER_BY_BUFFER_MS, ESCROW_REF_UTXO, VECTOR_OGMIOS_URL,
} from '../src/index.ts';
import type { ChainEscrowState, RealChainOptions } from '../src/index.ts';
import { RealChain } from '../src/chain.ts';
import { ESCROW_ADDRESS, MARKETPLACE_MIN_FEE } from '../src/vendored/mcp/marketplace-constants.ts';
import { ADVERT_REF, ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { FixtureProvider, FIXTURE_TXHASH, FIXTURE_TOKEN_UNIT } from './fixtures/fixture-provider.ts';
import { world, koiosFor, escrowAt, ESCROW_TX, CLAIM_TX, SUBMIT_TX } from './fixtures/escrow-koios.fixture.ts';
import type { KoiosOptions } from './fixtures/escrow-koios.fixture.ts';
import { advertKoios } from './advert-koios.ts';

const KOIOS = 'https://v2.koios.vector.mainnet.apexfusion.org/';
/** FixtureProvider.getSystemStartMs: Vector mainnet's start, the zero of the slot clock (one slot a second). */
const ZERO_TIME_MS = 1_756_485_600_000;
const PROMPT = ocrPromptHash({ image_b64: 'iVBORw0KGgo=', mime: 'image/png', output_format: 'markdown' });
const OTHER_PROMPT = ocrPromptHash({ image_b64: 'R0lGODlh', mime: 'image/png', output_format: 'markdown' });

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

/**
 * A fresh key generated at run time, and what the template's gen-keypair prints for it: the key hash (blake2b-224 of the public key) and
 * the address (header 0x61: enterprise, key credential, mainnet; then the key hash; bech32 'addr'). Composed here byte by byte, not with the
 * CML address classes RealChain uses.
 */
function generatedKey() {
  const sk = CML.PrivateKey.generate_ed25519();
  const hex = Buffer.from(sk.to_raw_bytes()).toString('hex');
  const buyerPkh = blake2b224Hex(Buffer.from(sk.to_public().to_raw_bytes()).toString('hex'));
  const address = CML.Address.from_raw_bytes(Buffer.from(`61${buyerPkh}`, 'hex')).to_bech32();
  return { hex, buyerPkh, address };
}

/** The fixture wallet at `address`: 1000 units, a pure 5-unit output (the collateral), and 10 units with a token. */
const walletAt = (address: string): UTxO[] => [
  { txHash: FIXTURE_TXHASH, outputIndex: 0, address, assets: { lovelace: 1_000_000_000n } },
  { txHash: FIXTURE_TXHASH, outputIndex: 1, address, assets: { lovelace: 5_000_000n } },
  { txHash: FIXTURE_TXHASH, outputIndex: 2, address, assets: { lovelace: 10_000_000n, [FIXTURE_TOKEN_UNIT]: 500n } },
];

/** The fixture node with a submit endpoint and a confirmation the test decides. It records what it is asked, in order. */
class SubmittingProvider extends FixtureProvider {
  readonly submitted: string[] = [];
  readonly awaited: Array<{ txHash: string; interval: number | undefined }> = [];
  readonly events: string[] = [];
  confirm: () => Promise<boolean> = async () => true;
  async getProtocolParameters(): Promise<ProtocolParameters> { this.events.push('read params'); return super.getProtocolParameters(); }
  async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> { this.events.push('read wallet'); return super.getUtxos(addressOrCredential); }
  async submitTx(tx: string): Promise<string> {
    this.submitted.push(tx);
    this.events.push('submit');
    return CML.hash_transaction(CML.Transaction.from_cbor_hex(tx).body()).to_hex();
  }
  async awaitTx(txHash: string, interval?: number): Promise<boolean> {
    this.awaited.push({ txHash, interval });
    this.events.push('await');
    const confirmed = await this.confirm();
    this.events.push('confirmed');
    return confirmed;
  }
}

/** The fixture node, submitting through the vendored OgmiosProvider.submitTx, whose HTTP call goes to the global fetch the test stubs. */
class VendoredSubmitProvider extends SubmittingProvider {
  readonly vendored = new OgmiosProvider({ ogmiosUrl: 'https://ogmios.test.example', submitUrl: 'https://submit.test.example/api/submit/tx', koiosUrl: 'https://koios.test.example' });
  async submitTx(tx: string): Promise<string> {
    this.submitted.push(tx);
    this.events.push('submit');
    return this.vendored.submitTx(tx);
  }
}

/** What a signed Post says of itself: its hash, the deliver_by of its escrow, and the end of its validity (the start of its ttl slot). */
function factsOf(signedCborHex: string) {
  const body = CML.Transaction.from_cbor_hex(signedCborHex).body();
  const txHash = CML.hash_transaction(body).to_hex();
  const deliverBy = decodeEscrowDatum(body.outputs().get(0).datum()!.as_datum()!.to_cbor_hex()).deliver_by;
  return { txHash, escrowRef: `${txHash}#0`, deliverBy, validTo: ZERO_TIME_MS + Number(body.ttl()) * 1000 };
}

/** The inputs of a transaction, as sorted refs. */
function inputRefs(cborHex: string): string[] {
  const inputs = CML.Transaction.from_cbor_hex(cborHex).body().inputs();
  const refs: string[] = [];
  for (let i = 0; i < inputs.len(); i++) refs.push(`${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`);
  return refs.sort();
}

describe('RealChain wallet', () => {
  it('is the address gen-keypair prints for the key, its key hash, the output the Post holds back as collateral and the float outside it', async () => {
    const { hex, buyerPkh, address } = generatedKey();
    expect(address).toMatch(/^addr1v/);
    const chain = new RealChain(new SubmittingProvider(walletAt(address)), { privateKeyHex: hex });
    expect(await chain.wallet()).toStrictEqual({ address, buyerPkh, collateralLovelace: 5_000_000n, floatLovelace: 1_010_000_000n });
  });

  it('takes the smallest pure output of at least 5 units as the collateral, counts everything else as float, and says null when there is none', async () => {
    const { hex, address } = generatedKey();
    const at = (outputIndex: number, lovelace: bigint, tokens: Record<string, bigint> = {}): UTxO => ({ txHash: FIXTURE_TXHASH, outputIndex, address, assets: { lovelace, ...tokens } });
    const several = new RealChain(new SubmittingProvider([at(0, 20_000_000n), at(1, 6_000_000n), at(2, 7_000_000n), at(3, 4_000_000n), at(4, 5_500_000n, { [FIXTURE_TOKEN_UNIT]: 1n })]), { privateKeyHex: hex });
    expect(await several.wallet()).toMatchObject({ collateralLovelace: 6_000_000n, floatLovelace: 36_500_000n });
    const none = new RealChain(new SubmittingProvider([at(0, 4_000_000n), at(1, 9_000_000n, { [FIXTURE_TOKEN_UNIT]: 1n })]), { privateKeyHex: hex });
    expect(await none.wallet()).toMatchObject({ collateralLovelace: null, floatLovelace: 13_000_000n });
  });
});

describe('RealChain postEscrow', () => {
  it('builds the Post keyless, signs it with the buyer key, submits it and returns once Koios confirms it', async () => {
    const { hex, buyerPkh, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    const koios = advertKoios();
    const chain = new RealChain(node, { privateKeyHex: hex, koiosUrl: 'https://koios.test.example/', fetchImpl: koios.f });
    const before = Date.now();
    const r = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT });
    const after = Date.now();

    expect(node.submitted).toHaveLength(1);
    const signed = CML.Transaction.from_cbor_hex(node.submitted[0]);
    const bodyHash = CML.hash_transaction(signed.body());
    const txHash = bodyHash.to_hex();
    // One witness, by the buyer key, over this body.
    const witnesses = signed.witness_set().vkeywitnesses();
    expect(witnesses?.len()).toBe(1);
    expect(witnesses!.get(0).vkey().hash().to_hex()).toBe(buyerPkh);
    expect(witnesses!.get(0).vkey().verify(bodyHash.to_raw_bytes(), witnesses!.get(0).ed25519_signature())).toBe(true);
    // Output 0 is the escrow planned for this key and this prompt hash at the moment of the Post.
    expect(r.postedAt >= before && r.postedAt <= after).toBe(true);
    const plan = planFleetPostEscrow(decodeAdvertDatum(ADVERT_DATUM_HEX), ADVERT_REF, buyerPkh, PROMPT, r.postedAt);
    const escrow = signed.body().outputs().get(0);
    expect(escrow.address().to_bech32()).toBe(ESCROW_ADDRESS);
    expect(escrow.amount().coin()).toBe(2_261_030n);
    expect(escrow.datum()?.as_datum()?.to_cbor_hex()).toBe(encodeEscrowDatum(plan.datum));
    expect(r).toStrictEqual({
      escrowRef: `${txHash}#0`, txHash, lockLovelace: 2_261_030n, feeLovelace: signed.body().fee(),
      deliverBy: r.postedAt + 300_000 + 180_000, postedAt: r.postedAt, supplierPkh: ADVERT_EXPECTED.supplier_pkh, collateralKept: true,
    });
    expect(r.feeLovelace >= MARKETPLACE_MIN_FEE).toBe(true);
    // It waited for this transaction: 60 polls over the default 180 s.
    expect(node.awaited).toStrictEqual([{ txHash, interval: 3_000 }]);
    // The advert came from the Koios the chain was given, and the 5-unit collateral output stayed out of the inputs.
    expect(koios.calls.map((c) => c.path)).toStrictEqual(['/api/v1/utxo_info', '/api/v1/tx_info']);
    expect(koios.calls.every((c) => c.url?.startsWith('https://koios.test.example/api/v1/'))).toBe(true);
    expect(inputRefs(node.submitted[0])).not.toContain(`${FIXTURE_TXHASH}#1`);
  }, 30_000);

  it('says collateralKept false when the wallet could fund the Post only with its 5-unit output', async () => {
    const { hex, address } = generatedKey();
    // 5 units and 3: without the 5-unit output, 3 units cannot pay the lock, the fee and a change output, so the whole wallet funds the Post.
    const node = new SubmittingProvider([
      { txHash: FIXTURE_TXHASH, outputIndex: 0, address, assets: { lovelace: 5_000_000n } },
      { txHash: FIXTURE_TXHASH, outputIndex: 1, address, assets: { lovelace: 3_000_000n } },
    ]);
    const r = await new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f }).postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT });
    expect(r.collateralKept).toBe(false);
    expect(inputRefs(node.submitted[0])).toContain(`${FIXTURE_TXHASH}#0`);
  }, 30_000);

  it('spreads the 60 polls of the provider over awaitTimeoutMs', async () => {
    const { hex, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f, awaitTimeoutMs: 240_000 });
    const r = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT });
    expect(node.awaited).toStrictEqual([{ txHash: r.txHash, interval: 4_000 }]);
  }, 30_000);

  it('throws TxNotConfirmedError with the escrow, deliver_by and the end of validity when Koios does not confirm the Post: it may land until then', async () => {
    const { hex, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    node.confirm = async () => false;
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f });
    const err = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    const facts = factsOf(node.submitted[0]);
    expect(err).toMatchObject({ name: 'TxNotConfirmedError', ...facts, mayLand: true });
    // The Post is valid for the buffer after it was built, in whole slots: its validity ends at most 1 s before posted_at + 180 s.
    expect(facts.validTo).toBeLessThanOrEqual(facts.deliverBy - 300_000);
    expect(facts.validTo).toBeGreaterThan(facts.deliverBy - 300_000 - 1_000);
    expect((err as Error).message).toBe(`The Post ${facts.txHash} of escrow ${facts.escrowRef} was submitted, but Koios did not report it confirmed within 180000 ms. It may land, but only before ${new Date(facts.validTo).toISOString()}: read the escrow before acting on it again.`);
  }, 30_000);

  it('throws TxNotConfirmedError, may land, when the confirmation cannot be read', async () => {
    const { hex, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    node.confirm = async () => { throw new Error('Koios tx_status answered 502'); };
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f });
    const err = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect(err).toMatchObject({ ...factsOf(node.submitted[0]), mayLand: true });
    expect((err as Error).message).toMatch(/was submitted, but its confirmation could not be read \(Koios tx_status answered 502\)\. It may land, but only before /);
  }, 30_000);

  // What the vendored OgmiosProvider.submitTx throws for each answer of the submit API, and what that means for the escrow.
  const SUBMIT_ANSWERS: Array<[answer: string, respond: () => Promise<Response>, mayLand: boolean, says: RegExp]> = [
    ['a 200 whose body is not a transaction hash', async () => new Response('{"status":"queued"}', { status: 200 }), true,
      /^The Post [0-9a-f]{64} of escrow [0-9a-f]{64}#0 may not have been submitted \(Transaction was submitted but the response could not be parsed as a transaction hash\. .*\)\. It may land, but only before /],
    ['a network error, after which the request may have gone out', async () => { throw new TypeError('fetch failed'); }, true,
      /may not have been submitted \(Submit API request failed \(submitTx\): network error\)\. It may land, but only before /],
    ['a 503, which a gateway may answer after forwarding the request', async () => new Response('upstream timed out', { status: 503, statusText: 'Service Unavailable' }), true,
      /may not have been submitted \(Transaction submission rejected \(503 Service Unavailable\): upstream timed out\)\. It may land, but only before /],
    ['a 400 with the ledger\'s refusal', async () => new Response('{"tag":"TxSubmitFail","contents":"BadInputsUTxO"}', { status: 400, statusText: 'Bad Request' }), false,
      /^The Post [0-9a-f]{64} of escrow [0-9a-f]{64}#0 was refused and cannot land \(Transaction submission rejected \(400 Bad Request\): \{"tag":"TxSubmitFail","contents":"BadInputsUTxO"\}\)\.$/],
  ];

  it.each(SUBMIT_ANSWERS)('a Post the submit API answers with %s throws TxNotConfirmedError with its facts, and is not waited for', async (_answer, respond, mayLand, says) => {
    const { hex, address } = generatedKey();
    const node = new VendoredSubmitProvider(walletAt(address));
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL) => { sent.push(String(url)); return respond(); });
    vi.spyOn(console, 'error').mockImplementation(() => {}); // the vendored provider logs the detail for the operator
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f });
    const err = await chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT }).then(() => null, (e: unknown) => e);
    expect(sent).toStrictEqual(['https://submit.test.example/api/submit/tx']);
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect(err).toMatchObject({ ...factsOf(node.submitted[0]), mayLand });
    expect((err as Error).message).toMatch(says);
    expect(node.awaited).toStrictEqual([]);
  }, 30_000);

  it('runs one transaction at a time: a second Post does not touch the node until the first is confirmed', async () => {
    const { hex, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    let release: (confirmed: boolean) => void = () => {};
    const gate = new Promise<boolean>((resolve) => { release = resolve; });
    let polls = 0;
    node.confirm = () => (++polls === 1 ? gate : Promise.resolve(true));
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f });
    const first = chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT });
    const second = chain.postEscrow({ advertRef: ADVERT_REF, promptHash: OTHER_PROMPT });
    await vi.waitFor(() => expect(node.awaited.length).toBeGreaterThan(0), { timeout: 20_000 });
    await new Promise((resolve) => setTimeout(resolve, 300)); // ample time for a second Post that did not wait to start reading the node
    expect(node.awaited).toHaveLength(1);
    expect(node.events.at(-1)).toBe('await');
    release(true);
    const [a, b] = await Promise.all([first, second]);
    const between = node.events.slice(node.events.indexOf('await') + 1, node.events.indexOf('confirmed'));
    expect(between).toStrictEqual([]);
    expect(node.events.filter((e) => !e.startsWith('read'))).toStrictEqual(['submit', 'await', 'confirmed', 'submit', 'await', 'confirmed']);
    expect(a.escrowRef).not.toBe(b.escrowRef);
  }, 30_000);

  it('waits awaitTimeoutMs in all even when the provider never answers, so the transaction queued behind it runs then', async () => {
    const { hex, address } = generatedKey();
    const node = new SubmittingProvider(walletAt(address));
    let started: () => void = () => {};
    const firstWaitStarted = new Promise<void>((resolve) => { started = resolve; });
    let polls = 0;
    node.confirm = () => { polls += 1; if (polls > 1) return Promise.resolve(true); started(); return new Promise<boolean>(() => {}); };
    // The build sets no timer (checked), so the whole run can go on a fake clock: only the budget's timer is faked.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const chain = new RealChain(node, { privateKeyHex: hex, fetchImpl: advertKoios().f });
    const first = chain.postEscrow({ advertRef: ADVERT_REF, promptHash: PROMPT });
    const second = chain.postEscrow({ advertRef: ADVERT_REF, promptHash: OTHER_PROMPT });
    let firstSettled = false;
    const firstOutcome = first.then(() => null, (e: unknown) => e).finally(() => { firstSettled = true; });
    await firstWaitStarted;
    await vi.advanceTimersByTimeAsync(DELIVER_BY_BUFFER_MS - 1);
    expect(firstSettled).toBe(false);
    expect(node.submitted).toHaveLength(1); // the second Post waits in the queue
    await vi.advanceTimersByTimeAsync(1);
    expect(firstSettled).toBe(true);
    const err = await firstOutcome;
    expect(err).toBeInstanceOf(TxNotConfirmedError);
    expect(err).toMatchObject({ ...factsOf(node.submitted[0]), mayLand: true });
    expect((err as Error).message).toMatch(/Koios did not report it confirmed within 180000 ms/);
    const next = await second;
    expect(node.submitted).toHaveLength(2);
    expect(next.escrowRef).toBe(factsOf(node.submitted[1]).escrowRef);
    expect(vi.getTimerCount()).toBe(0); // the second wait's timer was cleared once it was confirmed
  }, 30_000);
});

describe('RealChain accept and reclaim (offline, refused before anything is submitted)', () => {
  const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
  const submittedNow = (d: EscrowDatum): EscrowDatum => ({ ...d, submitted_at: Date.now() - 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' });
  /** A key, a node holding its wallet and the escrow outputs `make` gives for its key hash, and the Koios of that chain. */
  function chainWith(make: (buyerPkh: string) => { escrows: UTxO[]; koios?: KoiosOptions }) {
    const key = generatedKey();
    const { escrows, koios: options = {} } = make(key.buyerPkh);
    const utxos = [...escrows, ...walletAt(key.address)];
    const node = new SubmittingProvider(utxos);
    const koios = koiosFor(utxos, options);
    return { chain: new RealChain(node, { privateKeyHex: key.hex, koiosUrl: KOIOS, fetchImpl: koios.f }), node, koios };
  }
  const referenceScriptMissing = `Escrow reference script ${ESCROW_REF_UTXO.txHash}#${ESCROW_REF_UTXO.outputIndex} not found; the marketplace needs to republish it.`;

  it('an Accept of an escrow another key posted is refused by the vendored planner, through the Koios the chain was given', async () => {
    const { chain, node, koios } = chainWith(() => ({ escrows: [escrowAt(SUBMIT_TX, submittedNow(posted))] }));
    await expect(chain.accept(ESCROW_REF)).rejects.toThrow(`This escrow was posted by another key; you are not the buyer. (escrow ${ESCROW_REF})`);
    expect(node.submitted).toStrictEqual([]);
    expect(koios.calls.length).toBeGreaterThan(0);
    expect(koios.calls.every((c) => c.url?.startsWith(`${KOIOS}api/v1/`))).toBe(true);
  }, 30_000);

  it('a Reclaim of an escrow another key posted is refused by the vendored planner', async () => {
    const { chain, node } = chainWith(() => ({ escrows: [escrowAt(ESCROW_TX, posted)], koios: { spent: false } }));
    await expect(chain.reclaim(ESCROW_REF)).rejects.toThrow(`This escrow was posted by another key; you are not the buyer. (escrow ${ESCROW_REF})`);
    expect(node.submitted).toStrictEqual([]);
  }, 30_000);

  it('an Accept of its own Submitted escrow passes the planner, the wallet binding and the collateral check, and stops at the reference script this node lacks', async () => {
    const { chain, node } = chainWith((buyerPkh) => {
      const ours: EscrowDatum = { ...posted, buyer_pkh: buyerPkh };
      return { escrows: [escrowAt(SUBMIT_TX, submittedNow(ours))], koios: { datumHex: encodeEscrowDatum(ours) } };
    });
    await expect(chain.accept(ESCROW_REF)).rejects.toThrow(referenceScriptMissing);
    expect(node.submitted).toStrictEqual([]);
  }, 30_000);

  it('a Reclaim of its own Open escrow past deliver_by passes the planner, the wallet binding and the collateral check, and stops at the reference script', async () => {
    const { chain, node } = chainWith((buyerPkh) => {
      const ours: EscrowDatum = { ...posted, buyer_pkh: buyerPkh };
      return { escrows: [escrowAt(ESCROW_TX, ours)], koios: { datumHex: encodeEscrowDatum(ours), spent: false } };
    });
    await expect(chain.reclaim(ESCROW_REF)).rejects.toThrow(referenceScriptMissing);
    expect(node.submitted).toStrictEqual([]);
  }, 30_000);
});

describe('RealChain escrowState and onChainReceiptHash, through the vendored lineage', () => {
  const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
  const claimed: EscrowDatum = { ...posted, state: 'Claimed' };
  const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
  const chainOver = (w: ReturnType<typeof world>) => new RealChain(w.node, { privateKeyHex: generatedKey().hex, koiosUrl: KOIOS, fetchImpl: w.koios.f });
  const cases: Array<[name: string, make: () => ReturnType<typeof world>, state: ChainEscrowState, receiptHash: string | null]> = [
    ['Open: the Post output is unspent', () => world([escrowAt(ESCROW_TX, posted)], { spent: false }), 'Open', null],
    ['Claimed: the supplier\'s Claim carried it on', () => world([escrowAt(CLAIM_TX, claimed)]), 'Claimed', null],
    ['Submitted: the Submit carried it on, with the receipt hash', () => world([escrowAt(SUBMIT_TX, submitted)]), 'Submitted', 'cd'.repeat(32)],
    ['spent: the Post output is spent and no output carries it on', () => world([]), 'spent', null],
    ['unknown: Koios has no output at the ref', () => world([], { rows: [] }), 'unknown', null],
  ];

  it.each(cases)('%s', async (_name, make, state, receiptHash) => {
    const chain = chainOver(make());
    expect(await chain.escrowState(ESCROW_REF)).toBe(state);
    expect(await chain.onChainReceiptHash(ESCROW_REF)).toBe(receiptHash);
  });

  it('throws, and never answers unknown, when it cannot tell: Koios down, or Koios and the node disagree', async () => {
    const down = chainOver(world([], { status: 502 }));
    const err = await down.escrowState(ESCROW_REF).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe(`Could not read escrow ${ESCROW_REF}: Koios utxo_info answered 502`);
    await expect(down.onChainReceiptHash(ESCROW_REF)).rejects.toThrow(/Koios utxo_info answered 502/);
    // Koios says the Post output is spent while the node still holds it: one of them is behind.
    await expect(chainOver(world([escrowAt(ESCROW_TX, posted)])).escrowState(ESCROW_REF)).rejects.toThrow(/Koios and the node disagree/);
  });
});

describe('RealChain readAdvert', () => {
  it('decodes the advert Koios holds at the ref, and refuses a ref with no advert', async () => {
    const { hex } = generatedKey();
    const chain = new RealChain(new SubmittingProvider([]), { privateKeyHex: hex, fetchImpl: advertKoios().f });
    expect(await chain.readAdvert(ADVERT_REF)).toStrictEqual(decodeAdvertDatum(ADVERT_DATUM_HEX));
    const empty = new RealChain(new SubmittingProvider([]), { privateKeyHex: hex, fetchImpl: advertKoios({ rows: [] }).f });
    await expect(empty.readAdvert(ADVERT_REF)).rejects.toThrow(`No UTxO at ${ADVERT_REF}.`);
  });
});

describe('createRealChain', () => {
  it('refuses a key that is not 64 lowercase hex, and never echoes it', async () => {
    const { hex } = generatedKey();
    for (const bad of [hex.toUpperCase(), hex.slice(2), `${hex}00`, '']) {
      const err = await createRealChain({ privateKeyHex: bad }).then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/64 lowercase hex/);
      if (bad) expect(err?.message).not.toContain(bad);
    }
  });

  it('refuses an await budget shorter than DELIVER_BY_BUFFER_MS, or not a whole number of milliseconds', async () => {
    const { hex } = generatedKey();
    for (const awaitTimeoutMs of [DELIVER_BY_BUFFER_MS - 1, 0, -1, 1.5, Number.NaN]) {
      await expect(createRealChain({ privateKeyHex: hex, awaitTimeoutMs }), String(awaitTimeoutMs)).rejects.toThrow(/awaitTimeoutMs must be a whole number of milliseconds of at least 180000/);
    }
    await expect(createRealChain({ privateKeyHex: hex, awaitTimeoutMs: DELIVER_BY_BUFFER_MS })).resolves.toBeDefined();
  });

  it('reads the wallet over the vendored OgmiosProvider, from the Ogmios endpoint it is given (the vendored mainnet default otherwise), at the address of the key', async () => {
    const { hex, buyerPkh, address } = generatedKey();
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string };
      calls.push({ url: String(url), body });
      const result = [{ transaction: { id: 'ab'.repeat(32) }, index: 0, address, value: { coins: 7_000_000 } }];
      return new Response(JSON.stringify({ jsonrpc: '2.0', method: body.method, result, id: null }), { status: 200 });
    });
    const options: RealChainOptions = { privateKeyHex: hex, ogmiosUrl: 'https://ogmios.test.example', submitUrl: 'https://submit.test.example/api/submit/tx', koiosUrl: 'https://koios.test.example/' };
    const chain = await createRealChain(options);
    expect(await chain.wallet()).toStrictEqual({ address, buyerPkh, collateralLovelace: 7_000_000n, floatLovelace: 0n });
    expect(calls).toStrictEqual([{ url: 'https://ogmios.test.example', body: { jsonrpc: '2.0', method: 'queryLedgerState/utxo', params: { addresses: [address] }, id: null } }]);
    await (await createRealChain({ privateKeyHex: hex })).wallet();
    expect(calls[1].url).toBe(VECTOR_OGMIOS_URL.replace(/\/+$/, ''));
  });
});

describe('feeOfSignedTx', () => {
  it('reads the fee of a signed transaction: the fee field of its body, which signing leaves as the build chose it', () => {
    const owner = CML.PrivateKey.generate_ed25519();
    for (const fee of [500_000n, 1_234_567n]) {
      const inputs = CML.TransactionInputList.new();
      inputs.add(CML.TransactionInput.new(CML.TransactionHash.from_hex('ab'.repeat(32)), 0n));
      const outputs = CML.TransactionOutputList.new();
      outputs.add(CML.TransactionOutput.new(CML.Address.from_bech32(ESCROW_ADDRESS), CML.Value.from_coin(2_000_000n)));
      const unsigned = CML.Transaction.new(CML.TransactionBody.new(inputs, outputs, fee), CML.TransactionWitnessSet.new(), true).to_cbor_hex();
      const { signedCborHex } = signTransaction(unsigned, rawHexToBech32(Buffer.from(owner.to_raw_bytes()).toString('hex')));
      expect(feeOfSignedTx(signedCborHex)).toBe(fee);
    }
  });
});
