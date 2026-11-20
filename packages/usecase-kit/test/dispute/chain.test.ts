// packages/usecase-kit/test/dispute/chain.test.ts: the dispute code with the real chain port over the fixture world of the buyer code. Lucid runs the mainnet Module-1 scripts on every build, and the
// ledger of ledger.ts applies each signed transaction, so a test reads what the transactions did to the claims, the challenges and the documents. The fake Koios of the ledger lists the outputs by
// payment credential and gives the metadata of a document.
import { CML, credentialToAddress } from '@lucid-evolution/lucid';
import { setImmediate as tick } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { HireLane } from '@vsa/hire-kit';
import { buildSubmitClaim, decodeChallengeDatum, decodeClaimDatum, documentHash, documentUri, lucidForAddress } from '@vsa/buyer-core';
import type { ClaimDatum } from '@vsa/buyer-core';
import { utf8Hex } from '@vsa/vector-read/identity-codec';
import { Dispute, MAX_CLAIM_TYPE_BYTES, MemoryJournal, claimDocument, evidenceDocument } from '@vsa/usecase-kit/dispute';
import type { ChallengeResult, DisputeJournal, DisputeSettings, Module1PortDeps, ServiceQueue } from '@vsa/usecase-kit/dispute';
import { CLAIM_TOKEN, DAY, HOUR, NOW, agentRecord, claimUtxo, recordUtxo } from '../../../buyer-core/test/fixtures/jury-world.ts';
import { AUDITOR_ID, CLAIMER_ID, MODULE1, WALLET, WALLET_ADDRESS, forever, kitClaim, koiosOf, ledgerWorld, realPort, signWithWallet } from './ledger.ts';
import type { LedgerProvider } from './ledger.ts';
import { DIGEST_FACTS, ESCROW, ESCROW_2, MANIFEST_SHA, ORDER_DESK_CLAIM, ORDER_FACTS, SETTINGS, STATEMENT_S1, THIRD_ID, deferred, kitClaimDocument } from './support.ts';

const did = (id: string): string => `did:vector:${id}`;
const CLAIMER = did(CLAIMER_ID);
const AUDITOR = did(AUDITOR_ID);
const CLAIM_REF = `${'cc'.repeat(32)}#0`;
const SLOW = 120_000;

/** The dispute code of `agentId` over `ledger`, in the queue of a service key. */
function disputeOf(ledger: LedgerProvider, agentId: string, now = NOW, extra: { readonly journal?: DisputeJournal; readonly settings?: Partial<DisputeSettings> } = {}): Dispute {
  const queue: ServiceQueue = new HireLane();
  return new Dispute({
    port: realPort(ledger, agentId, now), queue, clock: () => now, sleep: forever, settings: { ...SETTINGS, ...extra.settings }, ...(extra.journal === undefined ? {} : { journal: extra.journal }),
  });
}

const claimText = (agent: string) => kitClaimDocument(agent);

const runClaim = { capability_id: 'supplychain.order.accept.v1', manifest_sha256: MANIFEST_SHA, claim: ORDER_DESK_CLAIM, stake_lovelace: 50_000_000n, challenge_window_ms: 24 * HOUR, claim_type: 'service-quality' };

/** The outputs at the claim address, decoded. */
const claimsOn = (ledger: LedgerProvider) => ledger.atAddress(MODULE1.claim.address).map((utxo) => ({ ref: `${utxo.txHash}#${utxo.outputIndex}`, datum: decodeClaimDatum(utxo.datum!), utxo }));

/** The challenge of the buyer-side agent of use case 1 for the escrow of a job. */
const challengeOrder = (dispute: Dispute, escrow: string = ESCROW): Promise<ChallengeResult> => dispute.challengeDelivery({ counterparty: CLAIMER, escrow_ref: escrow, evidence: ORDER_FACTS });

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
    // The open claim of the agent is this claim: its document is read from the ledger, and it is the claim document that this kit wrote.
    expect(await dispute.findOpenClaim(CLAIMER)).toMatchObject({ ok: true, value: { ref: staked.value.claim, token: staked.value.claim_token, state: 'Open', claimer: CLAIMER } });
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
    const filed = filedOf(await disputeOf(ledger, AUDITOR_ID).challengeApproval({ sender: CLAIMER, escrow_ref: ESCROW, evidence: DIGEST_FACTS }));
    expect(ledger.documents.get(filed.record.evidence)).toContain('The challenger refused the request before it did any work.');
    expect(ledger.documents.get(filed.record.evidence)).not.toContain('salt:');
    expect(decodeChallengeDatum(ledger.at(filed.record.challenge)!.datum!).evidenceHash).toBe(filed.evidence_hash);
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

    it('says chain_unavailable for a claim whose document is not on the ledger, and never takes it for a claim of another kind', async () => {
      // The fixture claim holds the address of a document that no transaction of the ledger carries.
      const ledger = ledgerWorld([claimUtxo(CLAIM_TOKEN)]);
      const result = await challengeOrder(disputeOf(ledger, AUDITOR_ID));
      expect(result).toMatchObject({ ok: false, code: 'chain_unavailable' });
      expect(ledger.accepted).toEqual([]);
    }, SLOW);
  });

  describe('an agent that staked a claim for each of two runs has two open claims, and the newest one is challenged', () => {
    it('challenges the claim with the latest challenge deadline, and the evidence names that claim', async () => {
      const ledger = ledgerWorld();
      const older = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim({ ...runClaim, challenge_window_ms: 12 * HOUR });
      const newer = await disputeOf(ledger, CLAIMER_ID, NOW + 60_000).stakeRunClaim({ ...runClaim, challenge_window_ms: 24 * HOUR });
      if (!older.ok || !newer.ok) throw new Error('a claim was not staked');
      expect(claimsOn(ledger).filter((claim) => claim.datum.state === 'Open').length).toBe(2);
      expect(newer.value.challenge_deadline).toBeGreaterThan(older.value.challenge_deadline);
      const filed = filedOf(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW + 120_000)));
      expect(filed.record.claim).toBe(newer.value.claim);
      expect(filed.claim_token).toBe(newer.value.claim_token);
      expect(ledger.documents.get(filed.record.evidence)).toContain(`Claim: ${newer.value.claim}`);
      // The older claim is still open.
      expect(claimsOn(ledger).find((claim) => claim.ref === older.value.claim)!.datum.state).toBe('Open');
    }, SLOW);

    it('says claim_ambiguous when two claims of this kit end at the same moment, and files nothing', async () => {
      const ledger = ledgerWorld();
      const first = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim(runClaim);
      const second = await disputeOf(ledger, CLAIMER_ID, NOW).stakeRunClaim(runClaim);
      if (!first.ok || !second.ok) throw new Error('a claim was not staked');
      expect(first.value.challenge_deadline).toBe(second.value.challenge_deadline);
      const before = ledger.accepted.length;
      expect(await challengeOrder(disputeOf(ledger, AUDITOR_ID, NOW + 120_000))).toMatchObject({ ok: false, code: 'claim_ambiguous' });
      expect(ledger.accepted.length).toBe(before);
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
    expect(Buffer.from(document.bytes).toString('utf8')).toBe(ledger.documents.get(filed.record.evidence));
    expect(document).toMatchObject({ type: 'evidence', media_type: 'text/plain' });
    // No other address is read: an https address is refused, and so is an address that is not a transaction.
    await expect(port.readDocument('https://example.org/claim.txt')).rejects.toThrow(TypeError);
    await expect(port.readDocument('vector-tx:zq9')).rejects.toThrow();
    await expect(port.readDocument(documentUri('9a'.repeat(32)))).rejects.toThrow();
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
    ];
    for (const extra of wrong) expect(() => realPort(ledger, AUDITOR_ID, NOW, extra)).toThrow(TypeError);
    expect(() => realPort(ledger, AUDITOR_ID, NOW, { valid_minutes: 59, build_timeout_ms: 1, confirm_timeout_ms: 600_000, blockfrost_url: 'https://blockfrost.test' })).not.toThrow();
    expect(() => realPort(ledger, AUDITOR_ID, NOW, { address: 'not an address' })).toThrow();
    expect(koiosOf(ledger)).toBeTypeOf('function');
  });
});
