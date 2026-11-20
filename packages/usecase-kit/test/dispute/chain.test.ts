// packages/usecase-kit/test/dispute/chain.test.ts: the dispute code with the real chain port over the fixture world of the buyer code. Lucid runs the mainnet Module-1 scripts on every build, and the
// ledger of ledger.ts applies each signed transaction, so a test reads what the transactions did to the claims, the challenges and the documents. The fake Koios of the ledger lists the outputs by
// payment credential and gives the metadata of a document.
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import { setImmediate as tick } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HireLane } from '@vsa/hire-kit';
import { KOIOS_ANSWER_BYTES, buildSubmitClaim, decodeChallengeDatum, decodeClaimDatum, documentHash, documentUri, lucidForAddress } from '@vsa/buyer-core';
import type { ClaimDatum } from '@vsa/buyer-core';
import { utf8Hex } from '@vsa/vector-read/identity-codec';
import { encodeEscrowDatum } from '@vsa/vector-read';
import type { IdentityEscrowDatum } from '@vsa/vector-read';
import { Dispute, MAX_CLAIM_TYPE_BYTES, MemoryJournal, claimDocument, evidenceDocument } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, ClaimScope, DisputeJournal, DisputeSettings, Module1PortDeps, ServiceQueue } from '@vsa/usecase-kit/dispute';
import { encodeChallengeDatum } from '../../../buyer-core/src/vendored/mcp/jury-codec.ts';
import { CLAIM_TOKEN, DAY, HOUR, NOW, agentRecord, claimUtxo, recordUtxo } from '../../../buyer-core/test/fixtures/jury-world.ts';
import { ESCROW_ADDRESS } from '../../../buyer-core/src/vendored/mcp/marketplace-constants.ts';
import { identityEscrow } from '../../../buyer-core/test/fixtures/escrow-identity.fixture.ts';
import { AUDITOR_ID, CLAIMER_ID, MODULE1, WALLET, WALLET_ADDRESS, bareTransactionCbor, forever, kitClaim, koiosOf, ledgerWorld, postEscrowAt, realPort, signWithWallet } from './ledger.ts';
import type { LedgerProvider } from './ledger.ts';
import { CONFIRMATION, DIGEST_FACTS, ESCROW, ESCROW_2, JOB, JOB_BEGAN_AT, MANIFEST_SHA, ORDER_DESK_CLAIM, ORDER_FACTS, QUOTE_FACTS, SCOPE, SETTINGS, STATEMENT_S1, THIRD_ID, deferred, kitClaimDocument } from './support.ts';

const did = (id: string): string => `did:vector:${id}`;
const CLAIMER = did(CLAIMER_ID);
const AUDITOR = did(AUDITOR_ID);
const CLAIM_REF = `${'cc'.repeat(32)}#0`;
const SLOW = 120_000;

/** CBOR (hex) that is nested 100 levels deep: more than the reader decodes. */
const DEEP = `${'81'.repeat(100)}00`;

/** The CBOR metadatum of a JSON-like value: a number is an int, a string a text, an array a list, an object a map with text keys. */
function metadatumOf(value: unknown): CML.TransactionMetadatum {
  if (typeof value === 'number') return CML.TransactionMetadatum.new_int(CML.Int.new(BigInt(value)));
  if (typeof value === 'string') return CML.TransactionMetadatum.new_text(value);
  if (Array.isArray(value)) {
    const list = CML.MetadatumList.new();
    for (const item of value) list.add(metadatumOf(item));
    return CML.TransactionMetadatum.new_list(list);
  }
  const map = CML.MetadatumMap.new();
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) map.set(CML.TransactionMetadatum.new_text(key), metadatumOf(item));
  return CML.TransactionMetadatum.new_map(map);
}

/** The CBOR (hex) of the metadata map `{ 22084: value }`: the form that Blockfrost gives for the label of the documents. */
function labelCbor(value: unknown): string {
  const map = CML.MetadatumMap.new();
  map.set(CML.TransactionMetadatum.new_int(CML.Int.new(22084n)), metadatumOf(value));
  return Buffer.from(CML.TransactionMetadatum.new_map(map).to_cbor_bytes()).toString('hex');
}

/** The second source of the reader of the buyer code (Blockfrost) is read with the global fetch. A test that stubs it gets the real one back here. */
afterEach(() => {
  vi.unstubAllGlobals();
});

/** The address of the second source in a test that stubs the global fetch: it is in the documentation range, which the reader does not refuse as a private address. No test reaches the network. */
const BLOCKFROST = { blockfrost_url: 'https://203.0.113.7' } as const;

/** Stubs the global fetch with a Blockfrost that lists the label of the documents with `metadata` for each transaction. It gives the URLs that were asked. */
function stubBlockfrost(metadata: unknown): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: unknown) => {
    asked.push(String(url));
    return new Response(JSON.stringify([{ label: '22084', metadata }]), { status: 200 });
  });
  return asked;
}

/** The dispute code of `agentId` over `ledger`, in the queue of a service key. */
function disputeOf(
  ledger: LedgerProvider, agentId: string, now = NOW,
  extra: { readonly journal?: DisputeJournal; readonly settings?: Partial<DisputeSettings>; readonly port?: Partial<Module1PortDeps> } = {},
): Dispute {
  const queue: ServiceQueue = new HireLane();
  return new Dispute({
    port: realPort(ledger, agentId, now, extra.port), queue, clock: () => now, sleep: forever, settings: { ...SETTINGS, ...extra.settings }, ...(extra.journal === undefined ? {} : { journal: extra.journal }),
  });
}

const claimText = (agent: string) => kitClaimDocument(agent);

const runClaim = { capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR, claim_type: 'service-quality' };

/** The outputs at the claim address, decoded. */
const claimsOn = (ledger: LedgerProvider) => ledger.atAddress(MODULE1.claim.address).map((utxo) => ({ ref: `${utxo.txHash}#${utxo.outputIndex}`, datum: decodeClaimDatum(utxo.datum!), utxo }));

/** The challenge of the buyer-side agent of use case 1 for the escrow of a job. */
const challengeOrder = (dispute: Dispute, escrow: string = ESCROW, scope: Omit<ClaimScope, 'escrow_ref'> = JOB): Promise<ChallengeResult> => dispute.challengeDelivery({ counterparty: CLAIMER, escrow_ref: escrow, ...scope, evidence: ORDER_FACTS });

/** The challenge of a counterparty that refused a request of the other party for the digest of the approval. The other party posted the escrow of the job. */
const challengeApproved = (dispute: Dispute, escrow: string = ESCROW): Promise<ChallengeResult> => dispute.challengeApproval({ sender: CLAIMER, escrow_ref: escrow, ...JOB, evidence: DIGEST_FACTS });

function filedOf(result: ChallengeResult) {
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

describe('the claim of a run on the ledger', () => {
  it('publishes the claim document, and then stakes the claim with the hash and the URI of that document', async () => {
    const ledger = ledgerWorld();
    const dispute = disputeOf(ledger, CLAIMER_ID);
    const staked = await dispute.stakeRunClaim(runClaim);
    if (!staked.ok) throw new Error(staked.detail);
    const [documentTx, claimTx] = ledger.accepted;
    expect(ledger.accepted.length).toBe(2);
    expect(staked.value.document.tx_hash).toBe(documentTx);
    expect(staked.value.claim_tx).toBe(claimTx);
    // The document on the ledger is the claim document of this agent, and the claim holds its hash and its URI.
    const document = claimText(CLAIMER);
    expect(ledger.documents.get(documentTx!)).toBe(document.text);
    expect(ledger.documents.has(claimTx!)).toBe(false);
    const output = ledger.at(staked.value.claim)!;
    expect(output.address).toBe(MODULE1.claim.address);
    const datum = decodeClaimDatum(output.datum!);
    expect(datum).toMatchObject({ claimerDid: CLAIMER_ID, claimHash: documentHash(document.bytes), stakeAmount: 50_000_000n, challengeWindow: 24 * HOUR, state: 'Open' });
    expect(datum.storageUri).toBe(utf8Hex(documentUri(documentTx!)));
    expect(datum.storageUri).toBe(utf8Hex(staked.value.document.uri));
    expect(datum.claimerCredential).toEqual({ type: 'VerificationKey', hash: WALLET.keyHash });
    expect(output.assets).toMatchObject({ lovelace: 50_000_000n, [`${MODULE1.claim.hash}${staked.value.claim_token}`]: 1n });
    expect(staked.value.challenge_deadline).toBe(datum.submittedAt + 24 * HOUR);
    expect(staked.value.fee_lovelace > 0n).toBe(true);
    // The open claim of the agent for a job whose block was made after the claim is this claim: its document is read from the ledger, and it is the claim document that this kit wrote. A time of a block has whole seconds.
    const lookup = disputeOf(ledger, AUDITOR_ID, NOW + 60_000);
    postEscrowAt(ledger, datum.submittedAt + 1000);
    expect(await lookup.findOpenClaim(CLAIMER, SCOPE)).toMatchObject({ ok: true, value: { ref: staked.value.claim, token: staked.value.claim_token, state: 'Open', claimer: CLAIMER } });
    // The twin: a job that was posted at the moment of the claim is not covered by it.
    postEscrowAt(ledger, datum.submittedAt);
    expect(await lookup.findOpenClaim(CLAIMER, SCOPE)).toMatchObject({ ok: false, code: 'no_open_claim' });
  }, SLOW);

  it('signs each transaction with the wallet key and no other key', async () => {
    const ledger = ledgerWorld();
    expect((await disputeOf(ledger, CLAIMER_ID).stakeRunClaim(runClaim)).ok).toBe(true);
    for (const raw of ledger.raw) {
      const witnesses = CML.Transaction.from_cbor_hex(raw).witness_set().vkeywitnesses();
      expect(witnesses?.len()).toBe(1);
      expect(witnesses!.get(0).vkey().hash().to_hex()).toBe(WALLET.keyHash);
    }
  }, SLOW);

  it('says that the document landed when the claim is refused, with the message of the builder', async () => {
    const suspended = agentRecord({ status: { type: 'Suspended', holds: [{ by: { type: 'ControllerSet' }, reason: 0, since: NOW - DAY, until: NOW + DAY }] } });
    const ledger = ledgerWorld([], [recordUtxo(CLAIMER_ID, suspended), recordUtxo(AUDITOR_ID)]);
    const staked = await disputeOf(ledger, CLAIMER_ID).stakeRunClaim(runClaim);
    expect(staked).toMatchObject({ ok: false, code: 'claim_not_built', sent: null, wrong_document: null });
    if (staked.ok) return;
    expect(staked.detail).toContain('Suspended');
    expect(staked.document).not.toBeNull();
    expect(ledger.accepted.length).toBe(1);
    expect(ledger.documents.get(staked.document!.tx_hash)).toBe(claimText(CLAIMER).text);
    expect(claimsOn(ledger)).toEqual([]);
  }, SLOW);

  it('refuses a stake below the least stake of the deployment with the message of the builder, and the twin stakes', async () => {
    const ledger = ledgerWorld();
    const dispute = disputeOf(ledger, CLAIMER_ID);
    const low = await dispute.stakeRunClaim({ ...runClaim, stake_lovelace: 49_999_999n });
    expect(low).toMatchObject({ ok: false, code: 'claim_not_built' });
    if (!low.ok) expect(low.detail).toContain('at least 50.000000 units');
    const window = await dispute.stakeRunClaim({ ...runClaim, challenge_window_ms: 29 * 60_000 });
    expect(window).toMatchObject({ ok: false, code: 'claim_not_built' });
    expect((await dispute.stakeRunClaim({ ...runClaim, challenge_window_ms: 30 * 60_000 })).ok).toBe(true);
  }, SLOW);

  it('has the limit of the builder for the claim type: 64 bytes pass the builder, 65 do not, and the dispute refuses 65 before it publishes anything', async () => {
    expect(MAX_CLAIM_TYPE_BYTES).toBe(64);
    const ledger = ledgerWorld();
    const lucid = await lucidForAddress(ledger, WALLET_ADDRESS);
    const params = { changeAddress: WALLET_ADDRESS, agentId: CLAIMER_ID, claimHash: 'ab'.repeat(32), claimUri: utf8Hex('vector-tx:x'), stakeLovelace: 50_000_000n, nowMs: NOW };
    await expect(buildSubmitClaim({ lucid, provider: ledger, module1: MODULE1 }, { ...params, claimType: utf8Hex('x'.repeat(65)) })).rejects.toThrow('1 to 64 bytes');
    await expect(buildSubmitClaim({ lucid, provider: ledger, module1: MODULE1 }, { ...params, claimType: utf8Hex('x'.repeat(MAX_CLAIM_TYPE_BYTES)) })).resolves.toMatchObject({ claim: { state: 'Open' } });
    const fresh = ledgerWorld();
    await expect(disputeOf(fresh, CLAIMER_ID).stakeRunClaim({ ...runClaim, claim_type: 'x'.repeat(65) })).rejects.toThrow(RangeError);
    expect(fresh.accepted).toEqual([]);
    expect((await disputeOf(fresh, CLAIMER_ID).stakeRunClaim({ ...runClaim, claim_type: 'x'.repeat(64) })).ok).toBe(true);
  }, SLOW);
});

describe('the challenge on the ledger', () => {
  it('publishes the evidence, and then challenges the open claim, with the hash and the URI of the evidence that is on the ledger', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
    const [evidenceTx, challengeTx] = ledger.accepted;
    expect(ledger.accepted.length).toBe(2);
    // The evidence is the first transaction. It carries the document, and the challenge carries none. The document names the statement S1 of the claim document that the claim holds.
    const expected = evidenceDocument({
      ...ORDER_FACTS, claim: CLAIM_REF, claim_token: CLAIM_TOKEN, against_did: CLAIMER, by_did: AUDITOR, escrow_ref: ESCROW, statement_text: STATEMENT_S1,
    });
    if (!expected.ok) throw new Error(expected.detail);
    expect(ledger.documents.get(evidenceTx!)).toBe(expected.value.text);
    expect(ledger.documents.has(challengeTx!)).toBe(false);
    expect(filed.record).toEqual({ claim: CLAIM_REF, evidence: evidenceTx, challenge: expect.stringMatching(new RegExp(`^${challengeTx}#[0-9]+$`)) });
    // The challenge holds the hash of the document that is on the ledger, and its URI.
    const output = ledger.at(filed.record.challenge)!;
    expect(output.address).toBe(MODULE1.challenge.address);
    const challenge = decodeChallengeDatum(output.datum!);
    expect(challenge.evidenceHash).toBe(documentHash(Buffer.from(ledger.documents.get(evidenceTx!)!, 'utf8')));
    expect(challenge.evidenceHash).toBe(filed.evidence_hash);
    expect(challenge.evidenceUri).toBe(utf8Hex(documentUri(evidenceTx!)));
    // The resolution deadline of the challenge is the one of the deployment.
    expect(challenge).toMatchObject({
      claimRef: { txHash: 'cc'.repeat(32), outputIndex: 0 }, claimToken: CLAIM_TOKEN, auditorDid: AUDITOR_ID, stakeAmount: 50_000_000n, resolutionDeadline: MODULE1.protocol.resolutionDeadline,
      state: { type: 'PendingOracle' },
    });
    expect(MODULE1.protocol.resolutionDeadline).toBe(72 * HOUR);
    expect(output.assets).toMatchObject({ lovelace: 50_000_000n });
    // The claim moved on into the state Challenged.
    expect(ledger.at(CLAIM_REF)).toBeUndefined();
    const [claim] = claimsOn(ledger);
    expect(claim!.datum).toMatchObject({ state: 'Challenged', claimerDid: CLAIMER_ID });
    expect(claim!.utxo.assets[`${MODULE1.claim.hash}${CLAIM_TOKEN}`]).toBe(1n);
    expect(filed.deadline).toBe(challenge.challengedAt + 72 * HOUR);
    expect(filed.fee_lovelace! > 0n).toBe(true);
  }, SLOW);

  it('challenges the claim of the other party and leaves its own claim and the claim of a third agent as they are', async () => {
    const ledger = ledgerWorld((l) => [
      { ...kitClaim(l, `636c6d5f${'0a'.repeat(28)}`, { claimerDid: AUDITOR_ID }), txHash: 'c0'.repeat(32) }, kitClaim(l, CLAIM_TOKEN),
      { ...kitClaim(l, `636c6d5f${'0b'.repeat(28)}`, { claimerDid: THIRD_ID }), txHash: 'c3'.repeat(32) },
    ]);
    const [own, , third] = ledger.live.filter((utxo) => utxo.address === MODULE1.claim.address);
    filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
    expect(ledger.at(CLAIM_REF)).toBeUndefined();
    for (const untouched of [own!, third!]) {
      const now = ledger.at(`${untouched.txHash}#0`)!;
      expect(now.datum).toBe(untouched.datum);
      expect(decodeClaimDatum(now.datum!).state).toBe('Open');
    }
    expect(claimsOn(ledger).filter((claim) => claim.datum.state === 'Challenged').map((claim) => claim.datum.claimerDid)).toEqual([CLAIMER_ID]);
  }, SLOW);

  it('files nothing when the other party has no open claim, and sends no transaction', async () => {
    const own = (l: LedgerProvider) => ({ ...kitClaim(l, `636c6d5f${'0a'.repeat(28)}`, { claimerDid: AUDITOR_ID }), txHash: 'c0'.repeat(32) });
    const ledger = ledgerWorld((l) => [own(l), kitClaim(l, CLAIM_TOKEN, { state: 'Challenged' })]);
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'no_open_claim', evidence: null, sent: null });
    expect(ledger.accepted).toEqual([]);
    // The twin: the claim of the other party is open, and the transaction goes out.
    const open = ledgerWorld((l) => [own(l), kitClaim(l, CLAIM_TOKEN)]);
    expect((await challengeOrder(disputeOf(open, AUDITOR_ID))).ok).toBe(true);
  }, SLOW);

  it('gives the filed challenge again for the same job, and a second job finds the claim challenged and publishes nothing', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    const dispute = disputeOf(ledger, AUDITOR_ID);
    const first = filedOf(await challengeOrder(dispute));
    expect(ledger.accepted.length).toBe(2);
    expect(filedOf(await challengeOrder(dispute))).toEqual(first);
    expect(await challengeOrder(dispute, ESCROW_2)).toMatchObject({ ok: false, code: 'no_open_claim' });
    expect(ledger.accepted.length).toBe(2);
    expect(ledger.atAddress(MODULE1.challenge.address).length).toBe(1);
  }, SLOW);

  it('does not challenge when the evidence is not confirmed, and the evidence transaction can still land', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    ledger.confirms = false;
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'evidence_not_confirmed', evidence: null, sent: { tx_hash: ledger.accepted[0], may_land: true } });
    expect(ledger.accepted.length).toBe(1);
    expect(ledger.atAddress(MODULE1.challenge.address)).toEqual([]);
    expect(ledger.at(CLAIM_REF)).toBeDefined();
  }, SLOW);

  it('says that the evidence landed when the challenge cannot be built, and the claim is as it was', async () => {
    // The wallet holds two outputs, of 6 and 5 units: the evidence fits, and the stake of the challenge does not.
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    const poor = ledger.live.filter((utxo) => utxo.address === WALLET_ADDRESS);
    ledger.live = ledger.live.filter((utxo) => !poor.includes(utxo));
    ledger.live.push({ txHash: 'f1'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 6_000_000n } }, { txHash: 'f2'.repeat(32), outputIndex: 1, address: WALLET_ADDRESS, assets: { lovelace: 5_000_000n } });
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'challenge_not_built' });
    if (result.ok) return;
    expect(result.evidence).not.toBeNull();
    expect(ledger.documents.get(result.evidence!.tx_hash)).toContain('Evidence about statement S1');
    expect(ledger.at(CLAIM_REF)).toBeDefined();
    expect(ledger.atAddress(MODULE1.challenge.address)).toEqual([]);
  }, SLOW);

  it('files the evidence of a counterparty that refused for the digest of the approval', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    // The other party hired this agent: the datum of the escrow names this agent.
    postEscrowAt(ledger, JOB_BEGAN_AT, false, {}, { agent_id: AUDITOR_ID });
    const filed = filedOf(await challengeApproved(disputeOf(ledger, AUDITOR_ID)));
    expect(ledger.documents.get(filed.record.evidence)).toContain('The challenger refused the request before it did any work.');
    expect(ledger.documents.get(filed.record.evidence)).not.toContain('salt:');
    expect(decodeChallengeDatum(ledger.at(filed.record.challenge)!.datum!).evidenceHash).toBe(filed.evidence_hash);
  }, SLOW);

  it('files the challenge when the other party puts U+0000, or the text of its escape, in a value of its own document, and the evidence on the ledger holds neither', async () => {
    const confirmed = (change: Record<string, unknown>) => ({ ...ORDER_FACTS, confirmation: { ...CONFIRMATION, ...change } });
    const quoted = (change: Record<string, unknown>) => ({ ...QUOTE_FACTS, ...change });
    const values = ['lot-large\u0000', 'lot-large\\u0000', '\\u0000'];
    const fields: Array<[string, (value: string) => unknown]> = [
      ['the SKU of the confirmation', (value) => confirmed({ sku: value })],
      ['the lot of the confirmation', (value) => confirmed({ lot: value })],
      ['the quantity of the confirmation', (value) => confirmed({ quantity: value })],
      ['the SKU of the quote', (value) => quoted({ sku: value })],
      ['the quantity of the quote', (value) => quoted({ quantity: value })],
      ['the quoted unit price', (value) => quoted({ quoted_unit_price: value })],
      ['the listed unit price', (value) => quoted({ listed_unit_price: value })],
    ];
    for (const [field, facts] of fields) {
      for (const value of values) {
        const name = `${field}: ${JSON.stringify(value)}`;
        const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
        const dispute = disputeOf(ledger, AUDITOR_ID);
        const filed = filedOf(await dispute.challengeDelivery({ counterparty: CLAIMER, escrow_ref: ESCROW, ...JOB, evidence: facts(value) as never }));
        const text = ledger.documents.get(filed.record.evidence)!;
        expect(text, name).not.toContain('\u0000');
        expect(text, name).not.toContain('\\u0000');
        expect(ledger.accepted.length, name).toBe(2);
        // The same job gives the same challenge, and sends nothing.
        expect(filedOf(await dispute.challengeDelivery({ counterparty: CLAIMER, escrow_ref: ESCROW, ...JOB, evidence: facts(value) as never })), name).toEqual(filed);
        expect(ledger.accepted.length, name).toBe(2);
      }
    }
  }, SLOW);

  it('challenges a claim that sits at an address of the claim script with a stake part, which the node does not list by address', async () => {
    const address = credentialToAddress('Mainnet', { type: 'Script', hash: MODULE1.claim.hash }, { type: 'Key', hash: '0d'.repeat(28) });
    const ledger = ledgerWorld((l) => [{ ...kitClaim(l, CLAIM_TOKEN), address }]);
    // The node lists outputs by exact address: the claim is not at the address of the script.
    expect(ledger.atAddress(MODULE1.claim.address)).toEqual([]);
    const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
    expect(filed.record.claim).toBe(CLAIM_REF);
    // The claim went on in the state Challenged, at the same address, with its stake part.
    const claim = ledger.live.find((utxo) => utxo.assets[`${MODULE1.claim.hash}${CLAIM_TOKEN}`] === 1n)!;
    expect(claim.address).toBe(address);
    expect(decodeClaimDatum(claim.datum!).state).toBe('Challenged');
    // The twin: the same claim at the address of the script is challenged too.
    const plain = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    expect((await challengeOrder(disputeOf(plain, AUDITOR_ID))).ok).toBe(true);
  }, SLOW);

  it('challenges the claim that covers the job, and leaves out a newer claim for another capability, a claim with a higher stake, and a claim that was staked after the job began', async () => {
    const otherCapability = (ledger: LedgerProvider): Partial<ClaimDatum> => {
      const document = claimDocument({ agent_did: CLAIMER, capability_id: 'supplychain.rfq.quote.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM });
      if (!document.ok) throw new Error(document.detail);
      return { claimHash: document.value.hash, storageUri: utf8Hex(ledger.addDocument(document.value.text, 'claim').uri), challengeWindow: 20 * HOUR };
    };
    const token = (byte: string): string => `636c6d5f${byte.repeat(28)}`;
    const world = (): LedgerProvider => ledgerWorld((l) => [
      kitClaim(l, CLAIM_TOKEN),
      { ...kitClaim(l, token('0d'), otherCapability(l), 50 * 60_000), txHash: 'c4'.repeat(32) },
      { ...kitClaim(l, token('0e'), { stakeAmount: 500_000_000n, challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c5'.repeat(32) },
      { ...kitClaim(l, token('0c'), { challengeWindow: 20 * HOUR }, 10 * 60_000), txHash: 'c6'.repeat(32) },
    ]);
    const ledger = world();
    const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
    expect(filed.record.claim).toBe(CLAIM_REF);
    expect(filed.claim_token).toBe(CLAIM_TOKEN);
    expect(ledger.documents.get(filed.record.evidence)).toContain(`Claim: ${CLAIM_REF}`);
    // The twin: a job that hired the other capability is covered by the claim for it, and that claim ends later than the first one.
    const twin = world();
    postEscrowAt(twin, JOB_BEGAN_AT, false, {}, { capability_id: 'supplychain.rfq.quote.v1' });
    const covered = filedOf(await challengeOrder(disputeOf(twin, AUDITOR_ID), ESCROW, { ...JOB, capability_id: 'supplychain.rfq.quote.v1' }));
    expect(covered.record.claim).toBe(`${'c4'.repeat(32)}#0`);
  }, SLOW);

  it('says chain_unavailable when Koios cannot list the claims, and sends nothing: the claims at other addresses are not seen', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    ledger.koiosStatus = 503;
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(ledger.accepted).toEqual([]);
    ledger.koiosStatus = null;
    expect((await challengeOrder(disputeOf(ledger, AUDITOR_ID))).ok).toBe(true);
  }, SLOW);

  describe('a claim that is not a claim of this kit is not challenged', () => {
    const other = (ledger: LedgerProvider, text: string, type = 'claim', mediaType = 'text/plain') => {
      const { uri } = ledger.addDocument(text, type, mediaType);
      return { claimHash: documentHash(Buffer.from(text, 'utf8')), storageUri: utf8Hex(uri) };
    };

    it('leaves out a claim whose document is another text, another agent, another type or another hash, and files nothing', async () => {
      const kit = kitClaimDocument(CLAIMER);
      const cases: Array<[string, (ledger: LedgerProvider) => Partial<ClaimDatum>]> = [
        ['a document that is another text', (ledger) => other(ledger, 'any other text\n')],
        ['the claim document of another agent', (ledger) => other(ledger, kitClaimDocument(did(THIRD_ID)).text)],
        ['a document that is not published as a claim', (ledger) => other(ledger, kit.text, 'evidence')],
        ['a document with another media type', (ledger) => other(ledger, kit.text, 'claim', 'application/json')],
        ['a claim hash that is not the hash of the document', (ledger) => ({ ...other(ledger, kit.text), claimHash: 'ab'.repeat(32) })],
        ['an https address', () => ({ claimHash: kit.hash, storageUri: utf8Hex('https://example.org/claim.txt') })],
      ];
      for (const [name, make] of cases) {
        const ledger = ledgerWorld((l) => [claimUtxo(CLAIM_TOKEN, make(l))]);
        const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
        expect(result, name).toMatchObject({ ok: false, code: 'no_open_claim' });
        if (!result.ok) expect(result.detail, name).toContain('1 without a claim document of this kit');
        expect(ledger.accepted, name).toEqual([]);
      }
      // The twin: the claim document of this kit for the claimer is challenged.
      const twin = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
      expect((await challengeOrder(disputeOf(twin, AUDITOR_ID))).ok).toBe(true);
    }, SLOW);

    it('leaves out a claim whose document is not on the ledger when Koios has the claim, and says chain_unavailable when Koios is behind', async () => {
      // The fixture claim holds the address of a document that no transaction of the ledger carries.
      const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN)]);
      const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
      expect(result).toMatchObject({ ok: false, code: 'no_open_claim' });
      if (!result.ok) expect(result.detail).toContain('1 whose claim document is not on chain');
      expect(ledger.accepted).toEqual([]);
      // Koios is behind: the node lists the claim, and Koios has neither the claim nor its document. That is no reason to leave the claim out.
      const behind = ledgerWorld([claimUtxo(CLAIM_TOKEN)]);
      behind.koiosBehind.add(CLAIM_REF.split('#')[0]!);
      expect(await challengeOrder(disputeOf(behind, AUDITOR_ID))).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(behind.accepted).toEqual([]);
    }, SLOW);

    it('challenges the claim of this kit although a newer claim holds a document that does not exist, and waits for Koios when it does not have the newer claim yet', async () => {
      const world = (): LedgerProvider => ledgerWorld((l) => [
        kitClaim(l, CLAIM_TOKEN),
        { ...claimUtxo(`636c6d5f${'0d'.repeat(28)}`, { claimHash: 'cd'.repeat(32), storageUri: utf8Hex(documentUri('ab'.repeat(32))), challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c4'.repeat(32) },
      ]);
      const filed = filedOf(await challengeOrder(disputeOf(world(), AUDITOR_ID)));
      expect(filed.record.claim).toBe(CLAIM_REF);
      // The node lists the newer claim, and Koios does not have it yet: the code cannot tell a missing document from a source that is behind.
      const behind = world();
      behind.koiosBehind.add('c4'.repeat(32));
      expect(await challengeOrder(disputeOf(behind, AUDITOR_ID))).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(behind.accepted).toEqual([]);
      // Koios catches up, and the same job is filed.
      behind.koiosBehind.clear();
      expect(filedOf(await challengeOrder(disputeOf(behind, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
    }, SLOW);

    describe('a claim whose document does not decode is left out, as the claimer makes the document', () => {
      const DOC_TX = 'ab'.repeat(32);
      const NEWER_TOKEN = `636c6d5f${'0d'.repeat(28)}`;
      /** A newer claim that ends later. Its document is the transaction `DOC_TX`, which no test puts on the ledger as a document. */
      const newer = () => ({
        ...claimUtxo(NEWER_TOKEN, { claimHash: 'cd'.repeat(32), storageUri: utf8Hex(documentUri(DOC_TX)), challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c4'.repeat(32),
      });
      const world = (): LedgerProvider => ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN), newer()]);

      it('files the challenge against the claim of this kit when the newer claim holds a transaction whose CBOR is nested too deep, and against the newer claim when its document is of this kit', async () => {
        const deep = world();
        deep.bare.set(DOC_TX, DEEP);
        expect(filedOf(await challengeOrder(disputeOf(deep, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
        expect(deep.accepted.length).toBe(2);
        // The twin: the newer claim holds a document of this kit, with JSON metadata, and it ends later, so it is the target.
        const twin = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN), { ...kitClaim(l, NEWER_TOKEN, { challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c4'.repeat(32) }]);
        expect(filedOf(await challengeOrder(disputeOf(twin, AUDITOR_ID))).record.claim).toBe(`${'c4'.repeat(32)}#0`);
      }, SLOW);

      it('does the same when Koios keeps no CBOR and Blockfrost gives a CBOR that is nested too deep', async () => {
        const ledger = world();
        ledger.bare.set(DOC_TX, null);
        const asked = stubBlockfrost(DEEP);
        expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port: BLOCKFROST }))).record.claim).toBe(CLAIM_REF);
        expect(asked).toEqual([`https://203.0.113.7/txs/${DOC_TX}/metadata/cbor`]);
        expect(ledger.accepted.length).toBe(2);
      }, SLOW);

      it('says no_open_claim and counts the claim when it is the only claim, and files nothing', async () => {
        const cases: Array<[string, (ledger: LedgerProvider) => void]> = [
          ['a transaction whose CBOR is nested too deep', (ledger) => { ledger.bare.set(DOC_TX, DEEP); }],
          ['a Blockfrost whose CBOR is nested too deep', (ledger) => { ledger.bare.set(DOC_TX, null); stubBlockfrost(DEEP); }],
        ];
        for (const [name, set] of cases) {
          const ledger = ledgerWorld([newer()]);
          set(ledger);
          const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port: BLOCKFROST }));
          expect(result, name).toMatchObject({ ok: false, code: 'no_open_claim' });
          if (!result.ok) expect(result.detail, name).toContain('1 whose claim document is not on chain or is not a document');
          expect(ledger.accepted, name).toEqual([]);
        }
      }, SLOW);

      it('says chain_unavailable for hex text that is not hex, because no claimer makes the answer of a source, and files the same job when the source answers', async () => {
        const ledger = world();
        ledger.bare.set(DOC_TX, 'zz');
        expect(await challengeOrder(disputeOf(ledger, AUDITOR_ID))).toMatchObject({ ok: false, code: 'chain_unavailable' });
        expect(ledger.accepted).toEqual([]);
        ledger.bare.set(DOC_TX, bareTransactionCbor());
        expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
      }, SLOW);
    });
  });

  it('reads no challenge of another auditor, whatever its claim token and its deadline, and leaves out a challenge output whose datum cannot be read', async () => {
    const challengedToken = `636c6d5f${'0d'.repeat(28)}`;
    const foreign = (claimToken: string, resolutionDeadline: number): string => encodeChallengeDatum({
      claimRef: { txHash: 'c5'.repeat(32), outputIndex: 0 }, auditorDid: THIRD_ID, auditorCredential: { type: 'VerificationKey', hash: '0d'.repeat(28) }, stakeAmount: 50_000_000n,
      evidenceHash: 'ee'.repeat(32), evidenceUri: utf8Hex('vector-tx:x'), challengedAt: NOW - HOUR, resolutionDeadline, eligibleJurors: [], state: { type: 'PendingOracle' }, claimToken,
    });
    const output = (datum: string | undefined) => ({
      txHash: 'c6'.repeat(32), outputIndex: 0, address: MODULE1.challenge.address, assets: { lovelace: 50_000_000n, [`${MODULE1.challenge.hash}63686c5f${'0d'.repeat(28)}`]: 1n },
      ...(datum === undefined ? {} : { datum }),
    });
    const cases: Array<[string, string | undefined, number]> = [
      ['a claim token that is not a claim token', foreign('ff'.repeat(32), 72 * HOUR), 1],
      ['the claim token of the claim that is Challenged', foreign(challengedToken, 72 * HOUR), 1],
      ['a resolution deadline below 0, which the code cannot decode', foreign(challengedToken, -1), 0],
      ['a datum that cannot be read', 'd8799f01ff', 0],
      ['no inline datum', undefined, 0],
    ];
    for (const [name, datum, listed] of cases) {
      const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN), { ...claimUtxo(challengedToken, { state: 'Challenged' }), txHash: 'c5'.repeat(32) }, output(datum)]);
      expect((await realPort(ledger, AUDITOR_ID, NOW).readChallenges()).length, name).toBe(listed);
      expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID))).record.claim, name).toBe(CLAIM_REF);
    }
  }, SLOW);

  describe('an agent that staked a claim for each of two runs has two open claims, and the newest one is challenged', () => {
    it('challenges the claim with the latest challenge deadline, and the evidence names that claim', async () => {
      const ledger = ledgerWorld();
      const older = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim({ ...runClaim, challenge_window_ms: 12 * HOUR });
      const newer = await disputeOf(ledger, CLAIMER_ID, NOW + 60_000).stakeRunClaim({ ...runClaim, challenge_window_ms: 24 * HOUR });
      if (!older.ok || !newer.ok) throw new Error('a claim was not staked');
      expect(claimsOn(ledger).filter((claim) => claim.datum.state === 'Open').length).toBe(2);
      expect(newer.value.challenge_deadline).toBeGreaterThan(older.value.challenge_deadline);
      postEscrowAt(ledger, NOW + 90_000);
      const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW + 120_000)));
      expect(filed.record.claim).toBe(newer.value.claim);
      expect(filed.claim_token).toBe(newer.value.claim_token);
      expect(ledger.documents.get(filed.record.evidence)).toContain(`Claim: ${newer.value.claim}`);
      // The older claim is still open.
      expect(claimsOn(ledger).find((claim) => claim.ref === older.value.claim)!.datum.state).toBe('Open');
    }, SLOW);

    it('takes the claim with the lowest claim token when two claims of this kit end at the same moment, and files one challenge', async () => {
      const ledger = ledgerWorld();
      const first = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim(runClaim);
      const second = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim(runClaim);
      if (!first.ok || !second.ok) throw new Error('a claim was not staked');
      expect(first.value.challenge_deadline).toBe(second.value.challenge_deadline);
      const lowest = [first.value, second.value].sort((a, b) => (a.claim_token < b.claim_token ? -1 : 1))[0]!;
      postEscrowAt(ledger, NOW + 90_000);
      const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW + 120_000)));
      expect(filed.record.claim).toBe(lowest.claim);
      expect(filed.claim_token).toBe(lowest.claim_token);
      expect(ledger.atAddress(MODULE1.challenge.address).length).toBe(1);
    }, SLOW);
  });

  describe('a restart does not file a second challenge for one job', () => {
    /** A ledger whose node takes the challenge and then fails the answer of the submit: the challenge landed, and the code is told that it may not have. */
    function lostAnswer(): LedgerProvider {
      const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
      const original = ledger.submitTx.bind(ledger);
      let submits = 0;
      ledger.submitTx = async (tx: string) => {
        const hash = await original(tx);
        submits += 1;
        if (submits === 2) throw new Error('fetch failed');
        return hash;
      };
      return ledger;
    }

    it('finds the challenge of this agent for this job again, in the same process and after a restart with no journal', async () => {
      const ledger = lostAnswer();
      const dispute = disputeOf(ledger, AUDITOR_ID);
      const first = await challengeOrder(dispute);
      expect(first).toMatchObject({ ok: false, code: 'challenge_not_confirmed', sent: { may_land: true } });
      expect(ledger.accepted.length).toBe(2);
      const challenge = ledger.atAddress(MODULE1.challenge.address)[0]!;
      const ref = `${challenge.txHash}#${challenge.outputIndex}`;
      // The same process: the challenge is on chain, so it is the result, and nothing is sent.
      const again = filedOf(await challengeOrder(dispute));
      expect(again.record).toMatchObject({ claim: CLAIM_REF, challenge: ref });
      expect(again.fee_lovelace).toBeNull();
      expect(again.claim_token).toBe(CLAIM_TOKEN);
      expect(again.against_did).toBe(CLAIMER);
      // A restart: a new process has an empty journal, and it finds the same challenge.
      const restarted = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
      expect(restarted.record).toEqual(again.record);
      expect(restarted.evidence_hash).toBe(decodeChallengeDatum(challenge.datum!).evidenceHash);
      expect(ledger.accepted.length).toBe(2);
      // Another job against the same claimer finds no open claim: its claim is challenged, and the challenge is for the first job.
      expect(await challengeOrder(disputeOf(ledger, AUDITOR_ID), ESCROW_2)).toMatchObject({ ok: false, code: 'no_open_claim' });
      expect(ledger.accepted.length).toBe(2);
    }, SLOW);

    it('gives the recorded state after a restart with the journal of the first process, and sends nothing', async () => {
      const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
      ledger.confirms = false;
      const journal = new MemoryJournal();
      const first = await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { journal }));
      expect(first).toMatchObject({ ok: false, code: 'evidence_not_confirmed' });
      expect(ledger.accepted.length).toBe(1);
      // The evidence transaction may still land, so the new process does not publish a second evidence document.
      const restarted = await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { journal }));
      expect(restarted).toMatchObject({ ok: false, code: 'job_already_disputed', sent: { tx_hash: ledger.accepted[0] } });
      expect(ledger.accepted.length).toBe(1);
    }, SLOW);

    describe('a record started that is older than its lease names the claim for the job', () => {
      const NEWER_REF = `${'c4'.repeat(32)}#0`;
      /** A claim of the same agent that was staked 50 minutes ago and ends 20 hours later: with no record, it is the target. */
      const newer = (l: LedgerProvider) => ({ ...kitClaim(l, `636c6d5f${'0d'.repeat(28)}`, { challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c4'.repeat(32) });
      /** A journal with a record `started` of the claim `CLAIM_REF` for the job, 11 minutes old: it is older than the lease of 10 minutes. */
      const lapsed = async (): Promise<MemoryJournal> => {
        const journal = new MemoryJournal();
        await journal.put(ESCROW, { step: 'started', escrow: ESCROW, against: CLAIMER, claim: CLAIM_REF, claim_token: CLAIM_TOKEN, started_at: NOW - 11 * 60_000, evidence: null, filed: null, ended: null });
        return journal;
      };

      it('files against the claim of the record, and leaves the claim that ends later open', async () => {
        const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN), newer(l)]);
        const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { journal: await lapsed() })));
        expect(filed.record.claim).toBe(CLAIM_REF);
        expect(ledger.atAddress(MODULE1.challenge.address).length).toBe(1);
        expect(claimsOn(ledger).find((claim) => claim.ref === NEWER_REF)!.datum.state).toBe('Open');
        // The twin: a job with no record names the claim that ends later.
        const free = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN), newer(l)]);
        expect(filedOf(await challengeOrder(disputeOf(free, AUDITOR_ID))).record.claim).toBe(NEWER_REF);
      }, SLOW);

      it('says claim_changed and sends no transaction when the claim of the record is spent, although another claim is a target', async () => {
        const ledger = ledgerWorld((l) => [newer(l)]);
        const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { journal: await lapsed() }));
        expect(result).toMatchObject({ ok: false, code: 'claim_changed', evidence: null, sent: null });
        expect(ledger.accepted).toEqual([]);
      }, SLOW);
    });
  });
});

describe('the withdrawal on the ledger', () => {
  const mine = (overrides = {}, ageMs = 5 * HOUR) => claimUtxo(CLAIM_TOKEN, { claimerCredential: { type: 'VerificationKey', hash: WALLET.keyHash }, ...overrides }, ageMs);

  it('withdraws an unchallenged claim after its window, burns the claim token and pays the stake to the wallet', async () => {
    const ledger = ledgerWorld([mine()]);
    const done = await disputeOf(ledger, CLAIMER_ID).withdrawClaim({ claim: CLAIM_REF });
    if (!done.ok) throw new Error(done.detail);
    expect(ledger.at(CLAIM_REF)).toBeUndefined();
    expect(ledger.live.some((utxo) => utxo.assets[`${MODULE1.claim.hash}${CLAIM_TOKEN}`] !== undefined)).toBe(false);
    const payout = ledger.at(done.value.payout)!;
    expect(payout.address).toBe(WALLET_ADDRESS);
    expect(payout.assets.lovelace).toBe(50_000_000n);
    expect(done.value).toMatchObject({ claim: CLAIM_REF, claim_token: CLAIM_TOKEN, stake_lovelace: 50_000_000n, withdraw_tx: ledger.accepted[0] });
  }, SLOW);

  it('refuses a withdrawal inside the window and sends nothing, and withdraws the same claim after the window', async () => {
    const ledger = ledgerWorld([mine({}, HOUR)]);
    expect(await disputeOf(ledger, CLAIMER_ID).withdrawClaim({ claim: CLAIM_REF })).toMatchObject({ ok: false, code: 'window_not_ended' });
    expect(ledger.accepted).toEqual([]);
    expect((await disputeOf(ledger, CLAIMER_ID, NOW + 3 * HOUR + 1000).withdrawClaim({ claim: CLAIM_REF })).ok).toBe(true);
  }, SLOW);

  it('refuses a claim of another key, and a claim that is challenged, and sends nothing', async () => {
    const stranger = ledgerWorld([claimUtxo(CLAIM_TOKEN, {}, 5 * HOUR)]);
    expect(await disputeOf(stranger, CLAIMER_ID).withdrawClaim({ claim: CLAIM_REF })).toMatchObject({ ok: false, code: 'not_claimer' });
    const challenged = ledgerWorld([mine({ state: 'Challenged' })]);
    expect(await disputeOf(challenged, CLAIMER_ID).withdrawClaim({ claim: CLAIM_REF })).toMatchObject({ ok: false, code: 'claim_not_open' });
    expect(stranger.accepted).toEqual([]);
    expect(challenged.accepted).toEqual([]);
  }, SLOW);
});

describe('what the chain port reads', () => {
  it('reads each claim output with its datum, and ignores an output without a claim token', async () => {
    const plain = { txHash: 'ab'.repeat(32), outputIndex: 0, address: MODULE1.claim.address, assets: { lovelace: 3_000_000n } };
    const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN), plain]);
    const claims = await realPort(ledger, AUDITOR_ID, NOW).readClaims();
    expect(claims).toEqual([{
      ref: CLAIM_REF, token: CLAIM_TOKEN, claimer: CLAIMER, claimer_key_hash: expect.stringMatching(/^[0-9a-f]{56}$/), state: 'Open', stake_lovelace: 50_000_000n, submitted_at: NOW - HOUR,
      challenge_window_ms: 4 * HOUR, claim_hash: '0c'.repeat(32), claim_type: 'certification', claim_uri: 'vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }]);
    expect(await realPort(ledger, AUDITOR_ID, NOW).readClaim(CLAIM_REF)).toEqual(claims[0]);
    expect(await realPort(ledger, AUDITOR_ID, NOW).readClaim(`${'ab'.repeat(32)}#0`)).toBeNull();
    expect(await realPort(ledger, AUDITOR_ID, NOW).readClaim(`${'ee'.repeat(32)}#0`)).toBeNull();
  }, SLOW);

  it('reads a claim of a script credential with no key hash, and takes no output of another credential for a claim', async () => {
    const script = claimUtxo(CLAIM_TOKEN, { claimerCredential: { type: 'Script', hash: 'ab'.repeat(28) } });
    const elsewhere = { ...claimUtxo(`636c6d5f${'0b'.repeat(28)}`), txHash: 'ad'.repeat(32), address: WALLET_ADDRESS };
    const atChallenge = { ...claimUtxo(`636c6d5f${'0c'.repeat(28)}`), txHash: 'ae'.repeat(32), address: MODULE1.challenge.address };
    const ledger = ledgerWorld([script, elsewhere, atChallenge]);
    const port = realPort(ledger, AUDITOR_ID, NOW);
    expect(await port.readClaim(CLAIM_REF)).toMatchObject({ ref: CLAIM_REF, claimer_key_hash: null });
    expect(await port.readClaim(`${'ad'.repeat(32)}#0`)).toBeNull();
    expect(await port.readClaim(`${'ae'.repeat(32)}#0`)).toBeNull();
    expect((await port.readClaims()).map((claim) => claim.ref)).toEqual([CLAIM_REF]);
  }, SLOW);

  it('reads the claims at every address of the claim script: the node lists the address of the script, and Koios the others, and the node confirms what Koios lists', async () => {
    const stake = credentialToAddress('Mainnet', { type: 'Script', hash: MODULE1.claim.hash }, { type: 'Key', hash: '0d'.repeat(28) });
    const withStake = { ...claimUtxo(`636c6d5f${'0b'.repeat(28)}`), txHash: 'ad'.repeat(32), address: stake };
    const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN), withStake]);
    // An output that only Koios lists is spent on the node: it is not a claim of the list.
    const spent = { ...claimUtxo(`636c6d5f${'0c'.repeat(28)}`), txHash: 'ae'.repeat(32), address: stake };
    ledger.koiosOnly.push(spent);
    const port = realPort(ledger, AUDITOR_ID, NOW);
    expect((await port.readClaims()).map((claim) => claim.ref).sort()).toEqual([CLAIM_REF, `${'ad'.repeat(32)}#0`].sort());
    expect(await port.readClaim(`${'ae'.repeat(32)}#0`)).toBeNull();
    expect(ledger.koiosCalls).toContain('credential_utxos');
  }, SLOW);

  it('does not take a claim output with a datum that it cannot read for no claim', async () => {
    const broken = { ...claimUtxo(CLAIM_TOKEN), datum: 'd8799f01ff' };
    const ledger = ledgerWorld([broken]);
    await expect(realPort(ledger, AUDITOR_ID, NOW).readClaims()).rejects.toThrow();
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  describe('an answer of a wrong shape from the node is an error, and never no claim', () => {
    const SHAPES: Array<[string, (utxo: LedgerProvider['live'][number]) => unknown]> = [
      ['an output with no address', (utxo) => ({ ...utxo, address: '' })],
      ['an output with an address that cannot be read', (utxo) => ({ ...utxo, address: 'zq9' })],
      ['a token quantity that is a number', (utxo) => ({ ...utxo, assets: Object.fromEntries(Object.entries(utxo.assets).map(([unit, quantity]) => [unit, unit === 'lovelace' ? quantity : Number(quantity)])) })],
      ['no assets', (utxo) => ({ ...utxo, assets: undefined })],
      ['a datum that is not text', (utxo) => ({ ...utxo, datum: 7 })],
      ['an output with no reference', (utxo) => ({ ...utxo, txHash: undefined })],
      ['an output that is not an object', () => 'zq9'],
    ];

    it.each(SHAPES)('says chain_unavailable for %s, and sends nothing', async (_name, change) => {
      const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
      const original = ledger.getUtxos.bind(ledger);
      ledger.getUtxos = async (address) => (await original(address)).map((utxo) => (utxo.address === MODULE1.claim.address ? (change(utxo) as typeof utxo) : utxo));
      await expect(realPort(ledger, AUDITOR_ID, NOW).readClaims()).rejects.toThrow(/the node gave/);
      const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
      expect(result).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(ledger.accepted).toEqual([]);
    }, SLOW);

    it('says so for a list that is not a list, and for an output that the node was not asked for', async () => {
      const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
      ledger.getUtxos = async () => 'zq9' as never;
      await expect(realPort(ledger, AUDITOR_ID, NOW).readClaims()).rejects.toThrow(/no list/);
      const stake = credentialToAddress('Mainnet', { type: 'Script', hash: MODULE1.claim.hash }, { type: 'Key', hash: '0d'.repeat(28) });
      const hidden = ledgerWorld([{ ...claimUtxo(CLAIM_TOKEN), address: stake }]);
      // Koios lists the claim, and the node answers with another output than the one that was asked for.
      hidden.getUtxosByOutRef = async () => [{ txHash: 'ee'.repeat(32), outputIndex: 0, address: WALLET_ADDRESS, assets: { lovelace: 5_000_000n } }];
      await expect(realPort(hidden, AUDITOR_ID, NOW).readClaims()).rejects.toThrow(/not asked for/);
      await expect(realPort(hidden, AUDITOR_ID, NOW).readClaim(CLAIM_REF)).rejects.toThrow(/not asked for/);
    }, SLOW);

    it('takes a well-formed output that is not a claim for no claim, as the twin of the shapes above', async () => {
      const ledger = ledgerWorld([{ txHash: 'ab'.repeat(32), outputIndex: 0, address: MODULE1.claim.address, assets: { lovelace: 3_000_000n, [`${MODULE1.claim.hash}${'11'.repeat(32)}`]: 2n } }]);
      expect(await realPort(ledger, AUDITOR_ID, NOW).readClaims()).toEqual([]);
    }, SLOW);
  });

  describe('an answer of a wrong shape from Koios is an error, and never no claim', () => {
    type Row = Record<string, unknown>;
    const STAKE = credentialToAddress('Mainnet', { type: 'Script', hash: MODULE1.claim.hash }, { type: 'Key', hash: '0d'.repeat(28) });
    const MIB = 1024 * 1024;

    /** A ledger whose claim of this kit is at an address with a stake part: the node does not list it by the address of the script, so only the list of Koios shows it. */
    const hidden = (): LedgerProvider => ledgerWorld((l) => [{ ...kitClaim(l, CLAIM_TOKEN), address: STAKE }]);

    /** The fake Koios of the ledger, with the rows of `credential_utxos` changed by `change`. Any other route is as it is. */
    function bending(ledger: LedgerProvider, change: (rows: Row[]) => unknown[]): typeof fetch {
      const honest = koiosOf(ledger);
      return (async (url: string, init?: RequestInit) => {
        const answer = await honest(url as never, init);
        if (!url.includes('credential_utxos')) return answer;
        return new Response(JSON.stringify(change((await answer.json()) as Row[])), { status: 200 });
      }) as unknown as typeof fetch;
    }

    const SHAPES: Array<[string, (rows: Row[]) => unknown[]]> = [
      ['a value that is a number', (rows) => rows.map((row) => ({ ...row, value: Number(row.value) }))],
      ['an index that is a text', (rows) => rows.map((row) => ({ ...row, tx_index: String(row.tx_index) }))],
      ['a hash that is not a hash', (rows) => rows.map((row) => ({ ...row, tx_hash: 'zq9' }))],
      ['no address', (rows) => rows.map((row) => ({ ...row, address: '' }))],
      ['a list of tokens that is not a list', (rows) => rows.map((row) => ({ ...row, asset_list: 'zq9' }))],
      ['a token quantity that is a number', (rows) => rows.map((row) => ({ ...row, asset_list: (row.asset_list as Row[]).map((token) => ({ ...token, quantity: Number(token.quantity) })) }))],
      ['an entry that is null', (rows) => [...rows, null]],
      ['an entry that is a text', (rows) => [...rows, 'zq9']],
      ['an entry that is a number', (rows) => [...rows, 7]],
      ['an entry that is a list', (rows) => [...rows, []]],
    ];

    it.each(SHAPES)('says chain_unavailable for a list with %s, and sends nothing', async (_name, change) => {
      const ledger = hidden();
      const port = { fetch: bending(ledger, change) };
      await expect(realPort(ledger, AUDITOR_ID, NOW, port).readClaims()).rejects.toThrow(/wrong shape/);
      expect(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port }))).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(ledger.accepted).toEqual([]);
    }, SLOW);

    it('reads the claim and files the challenge when every row is in its form, as the twin of the shapes above', async () => {
      const ledger = hidden();
      const port = { fetch: bending(ledger, (rows) => rows) };
      expect(await realPort(ledger, AUDITOR_ID, NOW, port).readClaims()).toMatchObject([{ ref: CLAIM_REF, token: CLAIM_TOKEN }]);
      expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port }))).record.claim).toBe(CLAIM_REF);
      expect(ledger.accepted.length).toBe(2);
    }, SLOW);

    /** A body of 17 chunks of 1 MiB with no length header: it passes the limit of 16 MiB at its last chunk. */
    const longStream = (): ReadableStream<Uint8Array> => {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent === 17) controller.close();
          else {
            sent += 1;
            controller.enqueue(new Uint8Array(MIB).fill(32));
          }
        },
      });
    };

    const ANSWERS: Array<[string, () => Response, RegExp]> = [
      ['a status of 503', () => new Response('{"error":"unavailable"}', { status: 503 }), /answered 503/],
      ['a body that is not JSON', () => new Response('<html>', { status: 200 }), /not valid JSON/],
      ['a body that is not a list', () => new Response('{"rows":[]}', { status: 200 }), /non-list/],
      ['a body over the limit by its length header', () => new Response('[]', { status: 200, headers: { 'content-length': String(KOIOS_ANSWER_BYTES + 1) } }), /byte limit/],
      ['a body over the limit by its stream', () => new Response(longStream(), { status: 200 }), /byte limit/],
    ];

    it.each(ANSWERS)('says chain_unavailable for %s', async (_name, answer, message) => {
      const ledger = hidden();
      const port = { fetch: (async () => answer()) as unknown as typeof fetch };
      await expect(realPort(ledger, AUDITOR_ID, NOW, port).readClaims()).rejects.toThrow(message);
      expect(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port }))).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(ledger.accepted).toEqual([]);
    }, SLOW);
  });

  it('reads the challenges, and the document at a vector-tx address, and gives the deployment value of the resolution deadline', async () => {
    const ledger = ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);
    const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID)));
    const port = realPort(ledger, AUDITOR_ID, NOW);
    expect(port.protocol).toEqual({ resolution_deadline_ms: MODULE1.protocol.resolutionDeadline });
    const [challenge] = await port.readChallenges();
    expect(challenge).toMatchObject({
      ref: filed.record.challenge, token: filed.challenge_token, claim: CLAIM_REF, claim_token: CLAIM_TOKEN, auditor: AUDITOR, auditor_key_hash: WALLET.keyHash, stake_lovelace: 50_000_000n,
      evidence_hash: filed.evidence_hash, evidence_uri: filed.evidence_uri, resolution_deadline_ms: 72 * HOUR, state: 'PendingOracle',
    });
    const document = await port.readDocument(filed.evidence_uri);
    if (!document.ok) throw new Error(document.detail);
    expect(Buffer.from(document.value.bytes).toString('utf8')).toBe(ledger.documents.get(filed.record.evidence));
    expect(document.value).toMatchObject({ type: 'evidence', media_type: 'text/plain' });
    // No other address is read: an https address is refused, and so is an address that is not a transaction.
    await expect(port.readDocument('https://example.org/claim.txt')).rejects.toThrow(TypeError);
    await expect(port.readDocument('vector-tx:zq9')).rejects.toThrow();
    // A transaction that Koios does not have is an answer of the source, and it is not a failure.
    expect(await port.readDocument(documentUri('9a'.repeat(32)))).toMatchObject({ ok: false, code: 'transaction_unknown' });
  }, SLOW);
});

describe('a read of a document says why the source has none, and throws when the source fails', () => {
  const TX = '9a'.repeat(32);
  const MISSING = documentUri(TX);
  /** The second source of the reader is a private address: it is refused at once, and no test reaches the network. */
  const OFFLINE = { blockfrost_url: 'http://127.0.0.1:9' };
  const label = (value: unknown) => (ledger: LedgerProvider): void => { ledger.metadata.set(TX, value as never); };

  const ABSENT: Array<[string, 'transaction_unknown' | 'no_document', (ledger: LedgerProvider) => void]> = [
    ['a transaction that Koios does not have', 'transaction_unknown', () => undefined],
    ['a transaction with no metadata, whose CBOR has no label', 'no_document', (ledger) => { ledger.bare.set(TX, bareTransactionCbor()); }],
    ['a transaction with no JSON for the label and no CBOR form that the reader can get', 'no_document', (ledger) => { ledger.bare.set(TX, null); }],
    ['a label with a value of another version', 'no_document', label({ v: 2, t: 'claim', m: 'text/plain', d: ['x'] })],
    ['a label with a value that is not an object', 'no_document', label('zq9')],
    ['a label with no list of chunks', 'no_document', label({ v: 1, t: 'claim', m: 'text/plain' })],
    ['a label with a chunk that is not text', 'no_document', label({ v: 1, t: 'claim', m: 'text/plain', d: [7] })],
    ['a label with a chunk that starts with 0x', 'no_document', label({ v: 1, t: 'claim', m: 'text/plain', d: ['0xab'] })],
    ['a label with a type that starts with 0x', 'no_document', label({ v: 1, t: '0xab', m: 'text/plain', d: ['x'] })],
    ['a label with a type that is not text', 'no_document', label({ v: 1, t: 7, m: 'text/plain', d: ['x'] })],
    ['a label with a chunk of more than 64 bytes', 'no_document', label({ v: 1, t: 'claim', m: 'text/plain', d: ['a'.repeat(65)] })],
    ['a transaction whose CBOR is nested too deep', 'no_document', (ledger) => { ledger.bare.set(TX, DEEP); }],
    ['a transaction whose CBOR is not well-formed', 'no_document', (ledger) => { ledger.bare.set(TX, 'ff'); }],
  ];

  it.each(ABSENT)('says why for %s', async (_name, code, set) => {
    const ledger = ledgerWorld();
    set(ledger);
    const result = await realPort(ledger, AUDITOR_ID, NOW, OFFLINE).readDocument(MISSING);
    expect(result).toMatchObject({ ok: false, code });
    if (!result.ok) expect(result.detail).not.toContain(TX);
  }, SLOW);

  it('gives the document of a transaction that carries one, as the twin of the absences above', async () => {
    const ledger = ledgerWorld();
    ledger.metadata.set(TX, { v: 1, t: 'claim', m: 'text/plain', d: ['a document\n'] });
    expect(await realPort(ledger, AUDITOR_ID, NOW, OFFLINE).readDocument(MISSING)).toMatchObject({ ok: true, value: { type: 'claim', media_type: 'text/plain' } });
  }, SLOW);

  const FAILURES: Array<[string, (ledger: LedgerProvider) => void, Partial<Module1PortDeps>]> = [
    ['a Koios that answers 503', (ledger) => { ledger.koiosStatus = 503; }, {}],
    ['a Koios that answers something that is not a list', () => undefined, { fetch: (async () => new Response('{"rows":[]}', { status: 200 })) as unknown as typeof fetch }],
    ['a request that fails', () => undefined, { fetch: (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch }],
    ['a CBOR that is not hex', (ledger) => { ledger.bare.set(TX, 'zz'); }, {}],
  ];

  it.each(FAILURES)('throws for %s, and never says that the document is not there', async (_name, set, extra) => {
    const ledger = ledgerWorld();
    set(ledger);
    await expect(realPort(ledger, AUDITOR_ID, NOW, { ...OFFLINE, ...extra }).readDocument(MISSING)).rejects.toThrow();
  }, SLOW);

  it('says whether Koios has the output of a claim, and throws when it cannot be read', async () => {
    const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN)]);
    const port = realPort(ledger, AUDITOR_ID, NOW);
    expect(await port.isIndexed(CLAIM_REF)).toBe(true);
    expect(await port.isIndexed(`${'ee'.repeat(32)}#0`)).toBe(false);
    ledger.koiosBehind.add(CLAIM_REF.split('#')[0]!);
    expect(await port.isIndexed(CLAIM_REF)).toBe(false);
    await expect(port.isIndexed('zq9')).rejects.toThrow(TypeError);
    ledger.koiosStatus = 503;
    await expect(port.isIndexed(CLAIM_REF)).rejects.toThrow();
  }, SLOW);

  it('never takes a row of a wrong shape for the output that was asked for', async () => {
    const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN)]);
    const rows = [null, 'zq9', { tx_hash: 7, tx_index: 0 }, { tx_hash: CLAIM_REF.split('#')[0], tx_index: '0' }];
    const port = realPort(ledger, AUDITOR_ID, NOW, { fetch: (async () => new Response(JSON.stringify(rows), { status: 200 })) as unknown as typeof fetch });
    expect(await port.isIndexed(CLAIM_REF)).toBe(false);
  }, SLOW);
});

describe('a document that Blockfrost gives for a transaction that Koios shows with no JSON', () => {
  const TX = '9a'.repeat(32);
  const MISSING = documentUri(TX);

  /** A ledger whose Koios keeps no CBOR of the transaction, and a Blockfrost that lists the label with `metadata`. */
  function viaBlockfrost(metadata: unknown): { readonly ledger: LedgerProvider; readonly asked: string[] } {
    const ledger = ledgerWorld();
    ledger.bare.set(TX, null);
    return { ledger, asked: stubBlockfrost(metadata) };
  }

  it('gives the document that the CBOR of the label holds, as the twin of the refusals below', async () => {
    const { ledger, asked } = viaBlockfrost(labelCbor({ v: 1, t: 'claim', m: 'text/plain', d: ['a document\n'] }));
    const result = await realPort(ledger, AUDITOR_ID, NOW, BLOCKFROST).readDocument(MISSING);
    expect(result).toMatchObject({ ok: true, value: { type: 'claim', media_type: 'text/plain' } });
    if (result.ok) expect(Buffer.from(result.value.bytes).toString('utf8')).toBe('a document\n');
    expect(asked).toEqual([`https://203.0.113.7/txs/${TX}/metadata/cbor`]);
  }, SLOW);

  const BAD: Array<[string, string]> = [
    ['CBOR that is nested too deep', DEEP],
    ['CBOR that stops', 'a1195644a4'],
    ['a chunk of 65 bytes, which the decoder refuses', `a1195644a4617601617465636c61696d616d706170706c69636174696f6e2f6a736f6e6164817841${'61'.repeat(65)}`],
    ['a label value with a key that is a list, which cannot be shown as JSON', 'a1195644a1810101'],
    ['a label value that is not a document', labelCbor({ v: 2, t: 'claim', m: 'text/plain', d: ['x'] })],
  ];

  it.each(BAD)('says no_document for %s, as the sender of the address makes it', async (_name, hex) => {
    const { ledger, asked } = viaBlockfrost(hex);
    expect(await realPort(ledger, AUDITOR_ID, NOW, BLOCKFROST).readDocument(MISSING)).toMatchObject({ ok: false, code: 'no_document' });
    expect(asked.length).toBe(1);
  }, SLOW);

  it('throws for hex text that is not hex, because no sender makes the answer of a source', async () => {
    const { ledger } = viaBlockfrost('zz');
    await expect(realPort(ledger, AUDITOR_ID, NOW, BLOCKFROST).readDocument(MISSING)).rejects.toThrow(/is not hex/);
  }, SLOW);
});

describe('the start of a job is the time of the block of its escrow output', () => {
  const ESCROW_TX = ESCROW.split('#')[0]!;
  const NEWER_REF = `${'c4'.repeat(32)}#0`;
  /** Two claims of this kit: the older was submitted an hour before the clock, and the newer 50 minutes before it, and it ends later. */
  const twoClaims = (): LedgerProvider => ledgerWorld((l) => [
    kitClaim(l, CLAIM_TOKEN),
    { ...kitClaim(l, `636c6d5f${'0d'.repeat(28)}`, { challengeWindow: 20 * HOUR }, 50 * 60_000), txHash: 'c4'.repeat(32) },
  ]);

  it.each([['unspent', false], ['spent', true]] as const)('reads the time from the block of the escrow output when it is %s: the claim that was staked after the Post is not the target', async (_name, spent) => {
    // The job was posted 55 minutes ago. The newer claim was staked 5 minutes after the Post, so only the older claim covers the job.
    const covering = twoClaims();
    postEscrowAt(covering, NOW - 55 * 60_000, spent);
    expect(filedOf(await challengeOrder(disputeOf(covering, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
    expect(covering.koiosCalls).toContain('utxo_info');
    // The twin: the job was posted 30 minutes ago, both claims cover it, and the newer claim ends later.
    const both = twoClaims();
    postEscrowAt(both, NOW - 30 * 60_000, spent);
    expect(filedOf(await challengeOrder(disputeOf(both, AUDITOR_ID))).record.claim).toBe(NEWER_REF);
  }, SLOW);

  /** What the port gives for the escrow of the job of the samples when its block was made at `blockTime`. */
  const job = (blockTime: number) => ({ ok: true, value: { block_time_ms: blockTime, capability_id: JOB.capability_id, agent_id: CLAIMER_ID } });

  it('gives the time of the block of an escrow output of any state, unspent or spent, with the capability and the agent of its datum', async () => {
    const ledger = ledgerWorld();
    const port = realPort(ledger, AUDITOR_ID, NOW);
    expect(await port.readEscrowJob(ESCROW)).toEqual(job(JOB_BEGAN_AT));
    postEscrowAt(ledger, NOW - 7 * DAY, true);
    expect(await port.readEscrowJob(ESCROW)).toEqual(job(NOW - 7 * DAY));
    // The output of the state Submitted was made by a later transaction, in a later block. Its time is the time of that block, and not the member posted_at that it keeps from the Post.
    postEscrowAt(ledger, NOW - DAY, false, {}, { posted_at: NOW - 2 * DAY, state: 'Submitted', submitted_at: NOW - DAY, result_receipt_hash: 'cd'.repeat(32) });
    expect(await port.readEscrowJob(ESCROW)).toEqual(job(NOW - DAY));
    await expect(port.readEscrowJob('zq9')).rejects.toThrow(TypeError);
  }, SLOW);

  /** What a poster can write into the member posted_at of the datum: no validator checks it. */
  const POSTED_AT: Array<[string, number]> = [
    ['a time in the future', NOW + 365 * DAY],
    ['the time 1000', 1000],
    ['the time 0', 0],
    ['a time that a number cannot hold', 2 ** 60],
  ];

  it.each(POSTED_AT)('takes the time of the block, and not the member posted_at of the datum, when the poster writes %s', async (_name, postedAt) => {
    // The other party posted the escrow and hired this agent, so the datum names this agent.
    const lie = { posted_at: postedAt, agent_id: AUDITOR_ID };
    // The job was posted 55 minutes ago: only the older claim of the poster covers it. The poster is the other party, and it makes the challenge of a counterparty that refused its request.
    const covering = twoClaims();
    postEscrowAt(covering, NOW - 55 * 60_000, false, {}, lie);
    expect(await realPort(covering, AUDITOR_ID, NOW).readEscrowJob(ESCROW)).toMatchObject({ ok: true, value: { block_time_ms: NOW - 55 * 60_000 } });
    expect(filedOf(await challengeApproved(disputeOf(covering, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
    // Both claims were staked before the block of the job: the newer claim ends later, so it is the target. A start from the datum would leave out each claim, or refuse the job.
    const both = twoClaims();
    postEscrowAt(both, NOW - 30 * 60_000, false, {}, lie);
    expect(filedOf(await challengeApproved(disputeOf(both, AUDITOR_ID))).record.claim).toBe(NEWER_REF);
    // The twin: the poster writes the time of its block, and the result is the same.
    const honest = twoClaims();
    postEscrowAt(honest, NOW - 55 * 60_000, false, {}, { agent_id: AUDITOR_ID });
    expect(filedOf(await challengeApproved(disputeOf(honest, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
  }, SLOW);

  const NOT_ESCROWS: Array<[string, (ledger: LedgerProvider) => void, string]> = [
    ['an output at the address of the wallet', (ledger) => postEscrowAt(ledger, JOB_BEGAN_AT, false, { address: WALLET_ADDRESS }), 'is not at the escrow script'],
    ['an output at the escrow script with a datum that is not an escrow datum', (ledger) => postEscrowAt(ledger, JOB_BEGAN_AT, false, { datum: 'd8799f01ff' }), 'holds no escrow datum'],
    ['an output at the escrow script with no datum', (ledger) => postEscrowAt(ledger, JOB_BEGAN_AT, false, { datum: undefined }), 'holds no escrow datum'],
    ['an output that holds less than its datum owes', (ledger) => postEscrowAt(ledger, JOB_BEGAN_AT, false, { assets: { lovelace: 1_000_000n } }), 'holds less than its escrow datum owes'],
  ];

  it.each(NOT_ESCROWS)('says not_escrow for %s, and the dispute says bad_shape and files nothing', async (_name, set, why) => {
    const ledger = twoClaims();
    set(ledger);
    const result = await realPort(ledger, AUDITOR_ID, NOW).readEscrowJob(ESCROW);
    expect(result).toMatchObject({ ok: false, code: 'not_escrow' });
    if (!result.ok) expect(result.detail).toContain(why);
    const refused = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(refused).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('says that an identity-marketplace escrow is no escrow output when the port has no identity deployment, and reads an escrow of the legacy layout, which names no agent', async () => {
    const ledger = ledgerWorld();
    const port = realPort(ledger, AUDITOR_ID, NOW, { identity_deployment: null });
    const refused = await port.readEscrowJob(ESCROW);
    expect(refused).toMatchObject({ ok: false, code: 'not_escrow' });
    if (!refused.ok) expect(refused.detail).toContain('no identity deployment');
    // The twin: an escrow of the legacy layout, at the legacy escrow address.
    const { agent_id: _agent, refund: _refund, ...legacy } = identityEscrow(JOB_BEGAN_AT, { capability_id: JOB.capability_id });
    postEscrowAt(ledger, JOB_BEGAN_AT, false, { address: ESCROW_ADDRESS, datum: encodeEscrowDatum(legacy) });
    expect(await port.readEscrowJob(ESCROW)).toEqual({ ok: true, value: { block_time_ms: JOB_BEGAN_AT, capability_id: JOB.capability_id, agent_id: null } });
  }, SLOW);

  /** The fake Koios of the ledger, with the answer of the route `utxo_info` changed by `change`. Any other route is as it is. */
  function bendingInfo(ledger: LedgerProvider, change: (answer: Response) => Response | Promise<Response>): typeof fetch {
    const honest = koiosOf(ledger);
    return (async (url: string, init?: RequestInit) => {
      const answer = await honest(url as never, init);
      return url.includes('utxo_info') ? change(answer) : answer;
    }) as unknown as typeof fetch;
  }
  const rowsWith = (edit: (row: Record<string, unknown>) => Record<string, unknown>) => async (answer: Response): Promise<Response> =>
    new Response(JSON.stringify(((await answer.json()) as Array<Record<string, unknown>>).map(edit)), { status: 200 });

  const FAILURES: Array<[string, (ledger: LedgerProvider) => typeof fetch]> = [
    ['an output that Koios does not have', (ledger) => { ledger.koiosBehind.add(ESCROW_TX); return koiosOf(ledger); }],
    ['an answer of 503', (ledger) => bendingInfo(ledger, () => new Response('{"error":"unavailable"}', { status: 503 }))],
    ['an answer that is not a list', (ledger) => bendingInfo(ledger, () => new Response('{"rows":[]}', { status: 200 }))],
    ['a row with no spent status', (ledger) => bendingInfo(ledger, rowsWith(({ is_spent: _spent, ...row }) => row))],
    ['a row with no value', (ledger) => bendingInfo(ledger, rowsWith(({ value: _value, ...row }) => row))],
    ['a row with no time of the block', (ledger) => bendingInfo(ledger, rowsWith(({ block_time: _time, ...row }) => row))],
    ['a row with a time of the block that is a text', (ledger) => bendingInfo(ledger, rowsWith((row) => ({ ...row, block_time: String(row.block_time) })))],
    ['a row with a time of the block that is empty', (ledger) => bendingInfo(ledger, rowsWith((row) => ({ ...row, block_time: null })))],
    ['a row with a time of the block of 0', (ledger) => bendingInfo(ledger, rowsWith((row) => ({ ...row, block_time: 0 })))],
    ['a row with a time of the block that is not a whole number', (ledger) => bendingInfo(ledger, rowsWith((row) => ({ ...row, block_time: 1.5 })))],
    ['a row with a time of the block that a number cannot hold in milliseconds', (ledger) => bendingInfo(ledger, rowsWith((row) => ({ ...row, block_time: 2 ** 53 })))],
    ['a request that fails', () => (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch],
  ];

  it.each(FAILURES)('throws for %s, and the dispute says chain_unavailable and files nothing; the same job is filed when Koios answers', async (_name, bend) => {
    const ledger = twoClaims();
    // The failing fetch serves the escrow read only: the claims come from the node, and from the list of Koios, which the failing fetch must still answer.
    const honest = koiosOf(ledger);
    const failing = bend(ledger);
    const fetchImpl = (async (url: string, init?: RequestInit) => (String(url).includes('utxo_info') ? failing(url as never, init) : honest(url as never, init))) as unknown as typeof fetch;
    await expect(realPort(ledger, AUDITOR_ID, NOW, { fetch: fetchImpl }).readEscrowJob(ESCROW)).rejects.toThrow();
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW, { port: { fetch: fetchImpl } }));
    expect(result).toMatchObject({ ok: false, code: 'chain_unavailable' });
    expect(ledger.accepted).toEqual([]);
    // The twin: Koios answers, and the same job is filed.
    ledger.koiosBehind.delete(ESCROW_TX);
    expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID))).record.claim).toBe(NEWER_REF);
  }, SLOW);
});

describe('the escrow of a challenge is the escrow of this job, on the ledger', () => {
  const OTHER_CAPABILITY = 'supplychain.rfq.quote.v1';
  /** A ledger with the claim of the other party, and the escrow of the job: its datum names the capability of the job and the counterparty as its agent, which this agent hired. */
  const world = (): LedgerProvider => ledgerWorld((l) => [kitClaim(l, CLAIM_TOKEN)]);

  /** Datums of an escrow of another job, and the member of the datum that the refusal names. */
  const OF_ANOTHER_JOB: Array<[string, Partial<IdentityEscrowDatum>, string]> = [
    ['another capability', { capability_id: OTHER_CAPABILITY }, 'capability_id'],
    ['the capability and the agent of an escrow of another purpose', { capability_id: 'demo.text.stats.v1', agent_id: 'ae'.repeat(32) }, 'capability_id'],
    ['another agent', { agent_id: THIRD_ID }, 'agent_id'],
    ['this agent, which a job that hired this agent names', { agent_id: AUDITOR_ID }, 'agent_id'],
  ];

  it.each(OF_ANOTHER_JOB)('refuses a delivery for an escrow with %s, names the member, and sends nothing; the same job is filed when the datum is right', async (_name, datum, member) => {
    const ledger = world();
    postEscrowAt(ledger, JOB_BEGAN_AT, false, {}, datum);
    const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
    expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
    if (!result.ok) expect(result.detail).toContain(member);
    expect(ledger.accepted).toEqual([]);
    // The twin: the escrow of the job names the capability of the job and the counterparty.
    postEscrowAt(ledger, JOB_BEGAN_AT);
    expect(filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
  }, SLOW);

  it('refuses an approval for an escrow that names the sender, another agent or another capability, and files it when the datum names this agent', async () => {
    const refusals: Array<[string, Partial<IdentityEscrowDatum>]> = [
      ['the sender', { agent_id: CLAIMER_ID }],
      ['another agent', { agent_id: THIRD_ID }],
      ['another capability', { agent_id: AUDITOR_ID, capability_id: OTHER_CAPABILITY }],
    ];
    for (const [name, datum] of refusals) {
      const ledger = world();
      postEscrowAt(ledger, JOB_BEGAN_AT, false, {}, datum);
      expect(await challengeApproved(disputeOf(ledger, AUDITOR_ID)), name).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(ledger.accepted, name).toEqual([]);
    }
    const twin = world();
    postEscrowAt(twin, JOB_BEGAN_AT, false, {}, { agent_id: AUDITOR_ID });
    expect(filedOf(await challengeApproved(disputeOf(twin, AUDITOR_ID))).record.claim).toBe(CLAIM_REF);
  }, SLOW);

  it('refuses an escrow of the legacy layout, which names no agent, for a delivery and for an approval, and sends nothing', async () => {
    const { agent_id: _agent, refund: _refund, ...legacy } = identityEscrow(JOB_BEGAN_AT, { capability_id: JOB.capability_id });
    const ledger = world();
    postEscrowAt(ledger, JOB_BEGAN_AT, false, { address: ESCROW_ADDRESS, datum: encodeEscrowDatum(legacy) });
    for (const result of [await challengeOrder(disputeOf(ledger, AUDITOR_ID)), await challengeApproved(disputeOf(ledger, AUDITOR_ID))]) {
      expect(result).toMatchObject({ ok: false, code: 'bad_shape' });
      if (!result.ok) expect(result.detail).toContain('agent_id');
    }
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('gives the lookup of the open claim the same refusals, and takes the counterparty or this agent as the agent of the escrow', async () => {
    const lookup = (datum: Partial<IdentityEscrowDatum>) => {
      const ledger = world();
      postEscrowAt(ledger, JOB_BEGAN_AT, false, {}, datum);
      return disputeOf(ledger, AUDITOR_ID).findOpenClaim(CLAIMER, SCOPE);
    };
    expect(await lookup({})).toMatchObject({ ok: true, value: { ref: CLAIM_REF } });
    expect(await lookup({ agent_id: AUDITOR_ID })).toMatchObject({ ok: true, value: { ref: CLAIM_REF } });
    expect(await lookup({ agent_id: THIRD_ID })).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await lookup({ capability_id: OTHER_CAPABILITY })).toMatchObject({ ok: false, code: 'bad_shape' });
  }, SLOW);
});

describe('what the chain port does before and after the signature', () => {
  const publish = { bytes: Buffer.from('a document\n'), type: 'evidence', media_type: 'text/plain' } as const;

  it('does not sign or send a transaction that the signer cannot sign, and says that nothing landed', async () => {
    const ledger = ledgerWorld();
    const port = realPort(ledger, AUDITOR_ID, NOW, { sign: () => { throw new Error('the key is locked'); } });
    expect(await port.publishDocument(publish)).toMatchObject({ ok: false, code: 'not_built' });
    expect(ledger.accepted).toEqual([]);
    // The twin: the real signer.
    expect((await realPort(ledger, AUDITOR_ID, NOW).publishDocument(publish)).ok).toBe(true);
  }, SLOW);

  it('refuses a signature of another transaction than the one that was built', async () => {
    const ledger = ledgerWorld();
    const wrong = (cbor: string) => ({ ...signWithWallet(cbor), txHashHex: 'ab'.repeat(32) });
    expect(await realPort(ledger, AUDITOR_ID, NOW, { sign: wrong }).publishDocument(publish)).toMatchObject({ ok: false, code: 'not_built' });
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('says that a transaction that the node refused with a 4xx cannot land, and that any other failure can', async () => {
    const refused = ledgerWorld();
    refused.refuses = new Error('Transaction submission rejected (400 Bad Request): the ledger says no');
    expect(await realPort(refused, AUDITOR_ID, NOW).publishDocument(publish)).toMatchObject({ ok: false, code: 'not_confirmed', may_land: false });
    const down = ledgerWorld();
    down.refuses = new Error('network error');
    expect(await realPort(down, AUDITOR_ID, NOW).publishDocument(publish)).toMatchObject({ ok: false, code: 'not_confirmed', may_land: true });
    const gateway = ledgerWorld();
    gateway.refuses = new Error('Transaction submission rejected (502 Bad Gateway)');
    expect(await realPort(gateway, AUDITOR_ID, NOW).publishDocument(publish)).toMatchObject({ ok: false, code: 'not_confirmed', may_land: true });
  }, SLOW);

  it('does not repeat a URL of the node in a detail', async () => {
    const ledger = ledgerWorld();
    ledger.refuses = new Error('connect failed at https://node.example/key-0123456789abcdef');
    const result = await realPort(ledger, AUDITOR_ID, NOW).publishDocument(publish);
    expect(result).toMatchObject({ ok: false, code: 'not_confirmed' });
    if (!result.ok) expect(result.detail).not.toContain('key-0123456789abcdef');
  }, SLOW);

  it('says not confirmed when the wait for the confirmation ends first, and the transaction can still land', async () => {
    const ledger = ledgerWorld();
    ledger.awaitTx = forever;
    const timer = deferred<void>();
    const port = realPort(ledger, AUDITOR_ID, NOW, { sleep: (ms) => (ms === 222_222 ? timer.promise : forever()), build_timeout_ms: 111_111, confirm_timeout_ms: 222_222 });
    const pending = port.publishDocument(publish);
    while (ledger.accepted.length === 0) await tick();
    timer.resolve();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, code: 'not_confirmed', may_land: true, tx_hash: ledger.accepted[0] });
    if (!result.ok) expect(result.detail).toContain('not seen confirmed');
  }, SLOW);

  it('says not built when the build takes longer than its budget, and signs and sends nothing', async () => {
    const ledger = ledgerWorld();
    const port = realPort(ledger, AUDITOR_ID, NOW, { sleep: (ms) => (ms === 111_111 ? Promise.resolve() : forever()), build_timeout_ms: 111_111, confirm_timeout_ms: 222_222 });
    expect(await port.publishDocument(publish)).toMatchObject({ ok: false, code: 'not_built' });
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('does not sign a challenge when the node names another output for the claim than the output of the call', async () => {
    const other = { ...claimUtxo(`636c6d5f${'0b'.repeat(28)}`, { claimerDid: THIRD_ID }), txHash: 'c3'.repeat(32) };
    const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN), other]);
    // A node that answers the claim of the call with another claim output.
    const honest = ledger.getUtxosByOutRef.bind(ledger);
    ledger.getUtxosByOutRef = async (refs) => (refs.some((ref) => ref.txHash === 'cc'.repeat(32)) ? honest([{ txHash: 'c3'.repeat(32), outputIndex: 0 }]) : honest(refs));
    const result = await realPort(ledger, AUDITOR_ID, NOW).openChallenge({
      claim: CLAIM_REF, claim_token: CLAIM_TOKEN, evidence_hash: 'ab'.repeat(32), evidence_uri: 'https://example.org/e', stake_lovelace: 50_000_000n, resolution_deadline_ms: 72 * HOUR,
    });
    expect(result).toMatchObject({ ok: false, code: 'not_built' });
    if (!result.ok) expect(result.detail).toContain('not the challenge that was asked for');
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('refuses a withdrawal that spends another output than the call names', async () => {
    const mine = (txHash: string, token: string) => ({ ...claimUtxo(token, { claimerCredential: { type: 'VerificationKey', hash: WALLET.keyHash } }, 5 * HOUR), txHash });
    const ledger = ledgerWorld([mine('cc'.repeat(32), CLAIM_TOKEN), mine('c3'.repeat(32), `636c6d5f${'0b'.repeat(28)}`)]);
    const honest = ledger.getUtxosByOutRef.bind(ledger);
    ledger.getUtxosByOutRef = async (refs) => (refs.some((ref) => ref.txHash === 'cc'.repeat(32)) ? honest([{ txHash: 'c3'.repeat(32), outputIndex: 0 }]) : honest(refs));
    const result = await realPort(ledger, AUDITOR_ID, NOW).withdrawClaim({ claim: CLAIM_REF, claim_token: CLAIM_TOKEN });
    expect(result).toMatchObject({ ok: false, code: 'not_built' });
    expect(ledger.accepted).toEqual([]);
  }, SLOW);

  it('refuses settings of the wrong type before it reads anything', () => {
    const ledger = ledgerWorld();
    const wrong: Array<Partial<Module1PortDeps>> = [
      { agent_id: 'ab' }, { agent_id: AUDITOR_ID.toUpperCase() }, { valid_minutes: 0 }, { valid_minutes: 60 }, { valid_minutes: 1.5 }, { build_timeout_ms: 0 }, { confirm_timeout_ms: 600_001 },
      { confirm_timeout_ms: '1000' as never }, { koios_url: 'ftp://koios.test' }, { koios_url: 'koios.test' }, { koios_url: 7 as never }, { fetch: 'fetch' as never }, { blockfrost_url: 'blockfrost' },
      { module1: { ...MODULE1, protocol: { ...MODULE1.protocol, resolutionDeadline: 0 } } }, { module1: { ...MODULE1, protocol: { ...MODULE1.protocol, resolutionDeadline: 1.5 } } },
      { identity_deployment: undefined as never }, { identity_deployment: 'deployment' as never }, { identity_deployment: {} as never },
    ];
    for (const extra of wrong) expect(() => realPort(ledger, AUDITOR_ID, NOW, extra)).toThrow(TypeError);
    expect(() => realPort(ledger, AUDITOR_ID, NOW, { valid_minutes: 59, build_timeout_ms: 1, confirm_timeout_ms: 600_000, blockfrost_url: 'https://blockfrost.test', identity_deployment: null })).not.toThrow();
    expect(() => realPort(ledger, AUDITOR_ID, NOW, { address: 'not an address' })).toThrow();
    expect(koiosOf(ledger)).toBeTypeOf('function');
  });
});
