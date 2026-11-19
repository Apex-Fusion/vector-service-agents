// packages/buyer-core/test/ledger-copies.test.ts
// The read and check code of the identity registry and the Module-1 builders, used as the package entry exports them (src/index.ts), on the
// captured mainnet outputs and on the offline Module-1 world of the fixtures (VENDORED-FROM.md, Read and check code). One scenario for each use
// that a service has, and the twin that each refusal needs. The tests of the copies themselves are the ported tests of the source: the manifest
// lists them. No network.
import { describe, it, expect, vi } from 'vitest';
import { CML } from '@lucid-evolution/lucid';
import type { UTxO } from '@lucid-evolution/lucid';
import { decodeAttestationDatum, decodeDelegationDatum, decodeVaultDatum, utf8Hex } from '@vsa/vector-read/identity-codec';
import * as entry from '../src/index.ts';
import {
  BudgetSpent, buildDocumentPublish, buildOpenChallenge, buildSubmitClaim, buildWithdrawClaim, checkAttestation, checkDelegationUse, decodeClaimDatum,
  decodeChallengeDatum, defaultChallengeWindow, documentHash, documentUri, escrowPaidFromVault, findClaim, lucidForAddress, module1FromManifest, readAttestation,
  readDelegation, readVaults, txHashOfUri, MAX_DOCUMENT_BYTES,
} from '../src/index.ts';
import type { AttestationCheck } from '../src/index.ts';
import * as ledgerRead from '../src/vendored/mcp/ledger-read.ts';
import * as attestationRead from '../src/vendored/mcp/attestation-read.ts';
import * as delegationRead from '../src/vendored/mcp/delegation-read.ts';
import * as vaultRead from '../src/vendored/mcp/vault-read.ts';
import * as module1Build from '../src/vendored/mcp/module1-build.ts';
import * as juryBuild from '../src/vendored/mcp/jury-build.ts';
import * as juryDocument from '../src/vendored/mcp/jury-document.ts';
import * as juryDeployment from '../src/vendored/mcp/jury-deployment.ts';
import * as juryCodec from '../src/vendored/mcp/jury-codec.ts';
import {
  CAPTURE, CAPTURE_MS, MAINNET, attestationIdOf, capturedUtxos, delegation, delegationUtxo, ledgerKoios, ledgerWorld, liveRecord, recordUtxo, utxoOf,
} from './fixtures/ledger-read-world.ts';
import type { LedgerWorld, TxRow } from './fixtures/ledger-read-world.ts';
import { testKey } from './fixtures/identity-world.ts';
import { HOUR, MODULE1, MODULE1_MANIFEST, NOW, STRANGER, WALLET, WALLET_ADDRESS, AUDITOR_ID, CLAIMER_ID, claimUtxo, juryWorld } from './fixtures/jury-world.ts';

// Lucid loads its WebAssembly on the first build, and the builders run the real scripts: a test that builds gets 60 s, not the 5 s of the default.
vi.setConfig({ testTimeout: 60_000 });

describe('the package entry exports the read and check code and the Module-1 builders', () => {
  it('names each function, constant and class that a service uses', () => {
    const values = [
      'MAX_PAGE', 'DEFAULT_PAGE', 'KOIOS_ANSWER_BYTES', 'READ_BUDGET_MS', 'BudgetSpent', 'TooManyMatches', 'withinBudget', 'utxoOfKoiosRow', 'soleTokenName', 'credentialOutputs',
      'credentialPage', 'koiosTipHeight', 'dataOfKoiosJson', 'checkPage', 'pageOf',
      'readAttestation', 'readAttestationDatum', 'attestationState', 'parseIssuer', 'issuerMatches', 'listAttestations', 'checkAttestation',
      'readDelegation', 'readChainRecords', 'isAction', 'isResource', 'checkDelegationUse',
      'periodAllowance', 'NOT_ON_NODE', 'readVaults', 'escrowPaidFromVault',
      'MODULE1_FEE_BUFFER', 'MAX_URI_BYTES', 'defaultChallengeWindow', 'buildSubmitClaim', 'findClaim', 'buildOpenChallenge', 'assertPayoutIsOutputZero', 'buildWithdrawClaim',
      'buildDocumentPublish', 'DOCUMENT_LABEL', 'CHUNK_MAX_BYTES', 'DOCUMENT_TYPES', 'DEFAULT_MEDIA_TYPE', 'MAX_DOCUMENT_BYTES', 'MAX_FETCH_BYTES', 'URI_PREFIX', 'documentHash',
      'documentBytes', 'documentUri', 'txHashOfUri', 'readDocument',
      'MODULE1_MANIFEST_ENV', 'MODULE1_NOT_CONFIGURED', 'JuryConfigError', 'readManifest', 'module1FromManifest', 'decodeClaimDatum', 'decodeChallengeDatum',
    ];
    for (const name of values) expect(typeof (entry as Record<string, unknown>)[name], name).not.toBe('undefined');
  });

  it('exports every function of the five read and build copies as that copy defines it, so that no function of them is left out', () => {
    for (const [file, module] of Object.entries({ ledgerRead, attestationRead, delegationRead, vaultRead, module1Build })) {
      for (const [name, value] of Object.entries(module)) expect((entry as Record<string, unknown>)[name], `${file}: ${name}`).toBe(value);
    }
  });

  it('exports the document builder, the document helpers, the manifest reader and the two claim decoders from the copies that hold them', () => {
    const named: Array<[string, Record<string, unknown>]> = [
      ['buildDocumentPublish', juryBuild], ['DOCUMENT_LABEL', juryDocument], ['documentHash', juryDocument], ['documentUri', juryDocument], ['txHashOfUri', juryDocument],
      ['readDocument', juryDocument], ['readManifest', juryDeployment], ['module1FromManifest', juryDeployment], ['JuryConfigError', juryDeployment],
      ['decodeClaimDatum', juryCodec], ['decodeChallengeDatum', juryCodec],
    ];
    for (const [name, module] of named) expect((entry as Record<string, unknown>)[name], name).toBe(module[name]);
  });
});

// ─── Attestations ────────────────────────────────────────────────────────────────────────────────

describe('an attestation: read it, and check it at a time', () => {
  const captured = CAPTURE.attestations.map((row) => ({ id: attestationIdOf(row), datum: decodeAttestationDatum(row.inline_datum!.bytes) }));
  const environment = captured.find((a) => a.datum.attType === 3)!;
  const revoked = captured.find((a) => a.datum.status.type === 'AttRevoked')!;
  const registeredIssuers = [...new Set(captured.flatMap((a) => (a.datum.issuerId === null ? [] : [a.datum.issuerId])))];
  /** The captured outputs and an Active record for each registered issuer. */
  const world = (): LedgerWorld => ledgerWorld([...capturedUtxos(), ...registeredIssuers.map((id) => recordUtxo(id, liveRecord()))]);
  const failing = (check: AttestationCheck): string[] => check.conditions.filter((line) => line.result === 'fail').map((line) => line.id);

  it('reads an attestation of mainnet with its datum, its deposit and its output, and reads no attestation for an identifier that nothing holds', async () => {
    const view = await readAttestation(world().env, environment.id);
    expect(view?.attestation).toStrictEqual(environment.datum);
    expect(view?.lovelace).toBe(5_000_000n);
    expect(view?.ref).toMatch(/^[0-9a-f]{64}#\d+$/);
    expect(await readAttestation(world().env, 'ee'.repeat(32))).toBeNull();
  });

  it('is valid inside its time window, and not valid after valid_until or more than one hour before it was issued', async () => {
    const at = (atMs: number) => checkAttestation(world().env, { id: environment.id, atMs });
    expect(environment.datum.validUntil).not.toBeNull();
    const inside = await at(CAPTURE_MS);
    expect([inside.valid, inside.ruleValid, failing(inside)]).toStrictEqual([true, true, []]);
    const late = await at(environment.datum.validUntil! + 1);
    expect([late.valid, failing(late)]).toStrictEqual([false, ['time_window']]);
    const early = await at(environment.datum.issuedAt - 3_600_000 - 1);
    expect([early.valid, failing(early)]).toStrictEqual([false, ['time_window']]);
    // The bounds themselves are inside.
    expect((await at(environment.datum.validUntil!)).valid).toBe(true);
  });

  it('is not valid when it is revoked, and a digest that it does not hold makes a valid one not valid while its twin keeps it valid', async () => {
    const check = await checkAttestation(world().env, { id: revoked.id, atMs: CAPTURE_MS });
    expect([check.valid, failing(check)]).toStrictEqual([false, ['active']]);
    const good = await checkAttestation(world().env, { id: environment.id, atMs: CAPTURE_MS, expect: { digest: environment.datum.digest, attType: 3 } });
    expect(good.valid).toBe(true);
    const wrong = await checkAttestation(world().env, { id: environment.id, atMs: CAPTURE_MS, expect: { digest: 'ab'.repeat(32) } });
    expect([wrong.ruleValid, wrong.valid]).toStrictEqual([true, false]);
    expect(wrong.expectations.map((line) => [line.id, line.result])).toStrictEqual([['digest', 'fail']]);
  });

  it('has no attestation to check for an identifier that nothing holds', async () => {
    const check = await checkAttestation(world().env, { id: 'ee'.repeat(32), atMs: CAPTURE_MS });
    expect([check.attestation, check.valid, failing(check)]).toStrictEqual([null, false, ['authentic']]);
  });
});

// ─── Delegations ───────────────────────────────────────────────────────────────────────────────

describe('a delegation: read it, and check its use over a chain of two links', () => {
  const live = CAPTURE.delegations.live;
  const ESCROW = `script:${MAINNET.escrow.hash}`;
  const HIRE = 'marketplace.hire.v1';
  const ID = 'd1'.repeat(32);
  const PARENT = 'd2'.repeat(32);
  const PARENT_AGENT = 'c4'.repeat(32);
  const delegateKey = testKey(31);
  const parentKey = testKey(32);
  const link = delegation();
  const parentLink = delegation({ delegate: PARENT_AGENT, delegateKey: parentKey.keyHash, remaining: 1 });
  const childLink = delegation({ parent: PARENT, depth: 2, remaining: 0, delegator: { type: 'Agent', id: PARENT_AGENT } });
  const records = [recordUtxo(PARENT_AGENT, liveRecord({}, [parentKey.publicKey])), recordUtxo(link.delegate, liveRecord({}, [delegateKey.publicKey]))];
  const use = (w: LedgerWorld, over: Partial<{ action: string; resource: string; atMs: number }> = {}) =>
    checkDelegationUse(w.env, { id: ID, action: HIRE, resource: ESCROW, atMs: CAPTURE_MS, ...over });

  it('reads the live delegation of mainnet with its terms, and no link for the one that was burned', async () => {
    const w = ledgerWorld([utxoOf(live.mint_output)]);
    const view = await readDelegation(w.env, live.id);
    expect([view.chain.length, view.missingParent]).toStrictEqual([1, null]);
    expect(view.chain[0].delegation).toStrictEqual(decodeDelegationDatum(live.mint_output.inline_datum!.bytes));
    const burned = await readDelegation(w.env, CAPTURE.delegations.burned.id);
    expect([burned.chain.length, burned.missingParent]).toStrictEqual([0, null]);
  });

  it('is usable over two links when each delegate is Active and lists its key, and not usable when the parent link is gone', async () => {
    const whole = await use(ledgerWorld([delegationUtxo(ID, childLink), delegationUtxo(PARENT, parentLink), ...records]));
    expect([whole.problems, whole.usable]).toStrictEqual([[], true]);
    expect(whole.view.chain.map((l) => l.id)).toStrictEqual([ID, PARENT]);
    const orphan = await use(ledgerWorld([delegationUtxo(ID, childLink), ...records]));
    expect(orphan.usable).toBe(false);
    expect(orphan.problems).toContain(`the parent delegation ${PARENT} of ${ID} is missing`);
    expect(orphan.view.missingParent).toBe(PARENT);
  });

  it('is not usable for an action that no pattern covers, a resource that no pattern covers or a time outside the period, and usable at the edge of the period', async () => {
    const w = () => ledgerWorld([delegationUtxo(ID, childLink), delegationUtxo(PARENT, parentLink), ...records]);
    expect((await use(w(), { action: 'marketplace.hire.v2' })).problems.some((p) => p.includes('covers "marketplace.hire.v2"'))).toBe(true);
    expect((await use(w(), { resource: `script:${'ab'.repeat(28)}` })).usable).toBe(false);
    expect((await use(w(), { atMs: link.notAfter + 1 })).usable).toBe(false);
    expect((await use(w(), { atMs: link.notBefore - 1 })).usable).toBe(false);
    expect((await use(w(), { atMs: link.notAfter })).usable).toBe(true);
  });

  it('refuses a read that has spent its budget as the error of the whole call', async () => {
    const w = ledgerWorld([delegationUtxo(ID, childLink), delegationUtxo(PARENT, parentLink), ...records]);
    await expect(checkDelegationUse({ ...w.env, budgetMs: 0 }, { id: ID, action: HIRE, resource: ESCROW, atMs: CAPTURE_MS })).rejects.toBeInstanceOf(BudgetSpent);
  });
});

// ─── Vaults, and the check that a vault paid an escrow ───────────────────────────────────────────────

describe('a vault: read it by reference and by delegation id, and check that a vault paid an escrow', () => {
  const delegationOnChain = CAPTURE.delegations.live;
  const real = decodeDelegationDatum(delegationOnChain.mint_output.inline_datum!.bytes);
  const key = testKey(31);
  // The delegate key of mainnet has no public key here, so the world lists the key of a test, with the terms and the token of mainnet.
  const payable = () => [delegationUtxo(delegationOnChain.id, { ...real, delegateKey: key.keyHash }), recordUtxo(real.delegate, liveRecord({}, [key.publicKey]))];
  const world = (): LedgerWorld => ledgerWorld([...CAPTURE.vaults.map(utxoOf), ...payable()]);
  /** The output reference of the Live vault output of mainnet: the only one of the five that names a delegation. */
  const liveRef = (() => {
    const found = CAPTURE.vaults.find((row) => decodeVaultDatum(row.inline_datum!.bytes).type === 'Live')!;
    return `${found.tx_hash}#${found.tx_index}`;
  })();

  it('reads the Live vault output of mainnet by its output reference: the limit of its delegation, and a payment that it can make once the period is over', async () => {
    const page = await readVaults(world().env, { vaultRef: liveRef }, CAPTURE_MS);
    expect(page.items.map((r) => r.output.ref)).toStrictEqual([liveRef]);
    const reading = page.items[0];
    expect([reading.onNode, reading.live?.canPay, reading.live?.problems]).toStrictEqual([true, true, []]);
    expect(reading.live?.limit).toStrictEqual(real.value);
  });

  it('reads the vault outputs of a delegation by its identifier, and no output for an identifier that no vault names', async () => {
    const page = await readVaults(world().env, { delegation: delegationOnChain.id }, CAPTURE_MS);
    expect(page.items.map((r) => r.output.ref)).toStrictEqual([liveRef]);
    expect(page.items[0].live?.delegation?.id).toBe(delegationOnChain.id);
    const none = await readVaults(world().env, { delegation: 'ee'.repeat(32) }, CAPTURE_MS);
    expect([none.items.length, none.total]).toStrictEqual([0, 0]);
  });

  it('shows that the escrow of the payment of mainnet was paid from a vault of its delegation, and not an escrow that a wallet posted, nor under another delegation', async () => {
    const pay = CAPTURE.payment;
    const env = (...txs: TxRow[]) => ({ deployment: MAINNET, koiosUrl: 'https://koios.example', fetchImpl: ledgerKoios({ txs }).f });
    const paid = await escrowPaidFromVault(env(pay.tx), pay.escrow_ref, pay.delegation);
    expect(paid).toMatchObject({ paid: true, escrowRef: pay.escrow_ref, delegation: pay.delegation, payTx: pay.escrow_ref.split('#')[0] });
    const plain = await escrowPaidFromVault(env(CAPTURE.plain_escrow.tx), CAPTURE.plain_escrow.escrow_ref, pay.delegation);
    expect(plain).toMatchObject({ paid: false, reason: 'no_vault_input' });
    const other = await escrowPaidFromVault(env(pay.tx), pay.escrow_ref, 'ee'.repeat(32));
    expect(other).toMatchObject({ paid: false, reason: 'other_delegation' });
  });
});

// ─── The Module-1 builders ─────────────────────────────────────────────────────────────────────────

describe('the four Module-1 transactions are built on the offline world with the real scripts', () => {
  const outputsOf = (txCbor: string) => {
    const outputs = CML.Transaction.from_cbor_hex(txCbor).body().outputs();
    return Array.from({ length: outputs.len() }, (_, i) => {
      const output = outputs.get(i);
      return { address: output.address().to_bech32(), lovelace: output.amount().coin(), datum: output.datum()?.as_datum()?.to_cbor_hex() ?? null };
    });
  };
  // The deployment keeps the name of the file that it was read from: the fixture file names itself the same way.
  const MANIFEST_SOURCE = 'module1-mainnet-manifest.json';
  const contextOf = async (extra: UTxO[] = []) => {
    const provider = juryWorld(extra);
    return { lucid: await lucidForAddress(provider, WALLET_ADDRESS), provider, module1: module1FromManifest(MODULE1_MANIFEST, MANIFEST_SOURCE) };
  };
  const claimToken = `636c6d5f${'0f'.repeat(28)}`;

  it('reads the Module-1 deployment from its manifest', () => {
    expect(module1FromManifest(MODULE1_MANIFEST, MANIFEST_SOURCE)).toStrictEqual(MODULE1);
  });

  it('publishes a document as the metadata of a transaction that only the wallet key signs, and gives its address before it is signed; a document of more than 15,000 bytes is refused', async () => {
    const { lucid, provider } = await contextOf();
    const bytes = Buffer.from('{"claim":"the quantity of the delivery differs from the quantity of the order"}', 'utf8');
    const built = await buildDocumentPublish(lucid, provider, { changeAddress: WALLET_ADDRESS, bytes, type: 'claim', nowMs: NOW });
    expect(built.uri).toBe(documentUri(built.txHash));
    expect(txHashOfUri(built.uri)).toBe(built.txHash);
    expect(built.documentHash).toBe(documentHash(bytes));
    expect(built.documentBytes).toBe(bytes.length);
    expect(built.requiredSigners.map((s) => s.keyHash)).toStrictEqual([WALLET.keyHash]);
    await expect(buildDocumentPublish(lucid, provider, { changeAddress: WALLET_ADDRESS, bytes: Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 0x61), type: 'claim', nowMs: NOW }))
      .rejects.toThrow(/has 15001 bytes; one transaction carries at most 15000/);
  });

  it('files a claim that locks the stake with the claimer credential and an Open datum, and refuses a stake below the minimum', async () => {
    const { lucid, provider, module1 } = await contextOf();
    const params = {
      changeAddress: WALLET_ADDRESS, agentId: CLAIMER_ID, claimHash: 'ab'.repeat(32), claimUri: utf8Hex('vector-tx:cu8SkAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'),
      claimType: utf8Hex('certification'), stakeLovelace: 50_000_000n, nowMs: NOW,
    };
    const built = await buildSubmitClaim({ lucid, provider, module1 }, params);
    const output = outputsOf(built.txCbor)[built.claimOutputIndex];
    expect([output.address, output.lovelace]).toStrictEqual([module1.claim.address, 50_000_000n]);
    const claim = decodeClaimDatum(output.datum!);
    expect([claim.state, claim.claimerDid, claim.claimerCredential, claim.challengeWindow]).toStrictEqual(
      ['Open', CLAIMER_ID, { type: 'VerificationKey', hash: WALLET.keyHash }, defaultChallengeWindow(module1)],
    );
    expect(built.requiredSigners.map((s) => s.keyHash)).toStrictEqual([WALLET.keyHash]);
    await expect(buildSubmitClaim({ lucid, provider, module1 }, { ...params, stakeLovelace: 49_999_999n })).rejects.toThrow(/at least 50\.000000 units/);
  });

  it('challenges an Open claim into Challenged and locks the stake in a pending challenge, and refuses an auditor that is the claimer', async () => {
    const claim = claimUtxo(claimToken);
    const { lucid, provider, module1 } = await contextOf([claim]);
    const params = {
      changeAddress: WALLET_ADDRESS, auditorId: AUDITOR_ID, claim: { token: claimToken }, evidenceHash: 'ed'.repeat(32), evidenceUri: utf8Hex('https://example.org/evidence.json'),
      stakeLovelace: 50_000_000n, resolutionDeadlineMs: 72 * HOUR, nowMs: NOW,
    };
    const built = await buildOpenChallenge({ lucid, provider, module1 }, params);
    const outputs = outputsOf(built.txCbor);
    expect(decodeChallengeDatum(outputs[built.challengeOutputIndex].datum!).state).toStrictEqual({ type: 'PendingOracle' });
    expect(decodeClaimDatum(outputs[built.claimOutputIndex].datum!).state).toBe('Challenged');
    expect(built.claimToken).toBe(claimToken);
    await expect(buildOpenChallenge({ lucid, provider, module1 }, { ...params, auditorId: CLAIMER_ID })).rejects.toThrow(/is the claimer of this claim/);
    // The claim that findClaim reads is the claim that the build spent.
    const found = await findClaim(provider, module1, { token: claimToken });
    expect(`${found.utxo.txHash}#${found.utxo.outputIndex}`).toBe(built.claimInput);
  });

  it('withdraws a claim that nobody challenged after its window, and refuses the withdrawal while the window is open', async () => {
    const mine = { type: 'VerificationKey' as const, hash: WALLET.keyHash };
    const ended = claimUtxo(claimToken, { claimerCredential: mine }, 5 * HOUR);
    const open = claimUtxo(claimToken, { claimerCredential: mine }, HOUR);
    const endedContext = await contextOf([ended]);
    const built = await buildWithdrawClaim(endedContext, { changeAddress: WALLET_ADDRESS, claim: { token: claimToken }, nowMs: NOW });
    expect(outputsOf(built.txCbor)[0]).toStrictEqual({ address: WALLET_ADDRESS, lovelace: 50_000_000n, datum: null });
    expect(built.payoutRef).toBe(`${built.txHash}#0`);
    const openContext = await contextOf([open]);
    await expect(buildWithdrawClaim(openContext, { changeAddress: WALLET_ADDRESS, claim: { token: claimToken }, nowMs: NOW })).rejects.toThrow(/Too early: the challenge window of the claim ends at/);
    // A claim of another claimer is refused even after its window.
    const stranger = claimUtxo(claimToken, { claimerCredential: { type: 'VerificationKey', hash: STRANGER.keyHash } }, 5 * HOUR);
    await expect(buildWithdrawClaim(await contextOf([stranger]), { changeAddress: WALLET_ADDRESS, claim: { token: claimToken }, nowMs: NOW })).rejects.toThrow(/is not the claimer credential of the claim/);
  });
});

