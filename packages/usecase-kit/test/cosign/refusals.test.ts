// packages/usecase-kit/test/cosign/refusals.test.ts
// Each rule of the route has a hostile transaction and a twin. The hostile transaction is a real Delegate with one change, and the twin is the real Delegate: the agent refuses the first with the code
// of the rule, and it never calls the sign function; it signs the second. The review question is: does the agent ever sign a transaction that is not the one Delegate that the rule allows?
import { CML } from '@lucid-evolution/lucid';
import { describe, expect, it } from 'vitest';
import { decodeDelegationDatum, encodeDelegationDatum } from '@vsa/vector-read/identity-codec';
import type { DelegationDatum } from '@vsa/vector-read/identity-codec';
import { COSIGN_SETTINGS } from '@vsa/usecase-kit/cosign';
import type { CosignCode } from '@vsa/usecase-kit/cosign';
import {
  AGENT_ID, DAY, DEPLOYMENT, DELEG_A, DELEG_B, NOW, OTHER_AGENT_ID, OTHER_AGENT_KEY, OWN_ADDRESS, PRINCIPAL, SERVICE, STRANGER, SUPPLIER, agentWallet, build, changed, harness, ledgerOf, liveDelegation, memberUtxos, requestOf,
  signedBy, spentOf, walletAddress, withCollateral, withInput, withInputs, withMint, withOutputAddress, withOutputs, withRedeemerMap, withRedeemers, withRequiredSigners, withoutParts, world,
} from './support.ts';
import type { Setup, TestKey } from './support.ts';

/** The answer of the route to `hex`, and what its sign functions got. */
async function ask(hex: string, over: Partial<Setup> = {}, signer: TestKey = PRINCIPAL) {
  const h = harness(over);
  const result = await h.route.cosign(requestOf(hex, signer));
  return { result, signed: h.signed, h };
}

/** The agent refuses `hex` with `code`, and no key of the agent signs anything. The delegator signs `hex` first: `signer` is the key of the delegator of its datum. */
async function refuses(code: CosignCode, hex: string, over: Partial<Setup> = {}, signer: TestKey = PRINCIPAL): Promise<void> {
  const { result, signed } = await ask(hex, over, signer);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
  expect(signed).toEqual([]);
}

/** The agent signs `hex`, after the delegator signed it. */
async function signs(hex: string, over: Partial<Setup> = {}, signer: TestKey = PRINCIPAL): Promise<void> {
  const { result, signed } = await ask(hex, over, signer);
  if (!result.ok) throw new Error(`refused with ${result.code}: ${result.detail}`);
  expect(signed).toHaveLength(1);
}

const policyOf = DEPLOYMENT.delegation.hash;
const nameHex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');
const keyCredential = (hash: string): CML.Credential => CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex(hash));

/** The transaction with the datum of its delegation output changed by `change`. */
function withDatum(hex: string, change: (datum: DelegationDatum) => DelegationDatum): string {
  return withOutputs(hex, (outputs) => outputs.map((output) => {
    if (output.address().to_bech32() !== DEPLOYMENT.delegation.address) return output;
    const datum = change(decodeDelegationDatum(output.datum()!.as_datum()!.to_cbor_hex()));
    return CML.TransactionOutput.new(output.address(), output.amount(), CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(encodeDelegationDatum(datum))), output.script_ref());
  }));
}

/** The transaction with one entry more in the map of its body, written in the bytes, as the decoder library has no setter for it. */
function withRawBodyEntry(hex: string, key: number, valueHex: string): string {
  const bodyBytes = CML.Transaction.from_cbor_hex(hex).body().to_cbor_bytes().length;
  const head = parseInt(hex.slice(2, 4), 16);
  if ((head & 0xe0) !== 0xa0 || (head & 0x1f) >= 22) throw new Error('the test needs a body map with a short definite head');
  const entry = key.toString(16).padStart(2, '0') + valueHex;
  return hex.slice(0, 2) + (head + 1).toString(16) + hex.slice(4, 2 + bodyBytes * 2) + entry + hex.slice(2 + bodyBytes * 2);
}

describe('a transaction that does more than delegate is not a Delegate', () => {
  it('has the one Delegate as its twin', async () => {
    await signs((await build()).hex);
  });

  it('refuses a certificate', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', changed(hex, (p) => {
      const list = CML.CertificateList.new();
      list.add(CML.Certificate.new_stake_registration(keyCredential(DELEG_A.keyHash)));
      p.body.set_certs(list);
    }));
  });

  it('refuses a withdrawal, also with the quantity 0', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', changed(hex, (p) => {
      const map = CML.MapRewardAccountToCoin.new();
      map.insert(CML.RewardAddress.new(1, keyCredential(DELEG_A.keyHash)), 0n);
      p.body.set_withdrawals(map);
    }));
  });

  it.each([
    ['a vote, also with no vote in it', (p: { body: CML.TransactionBody }) => p.body.set_voting_procedures(CML.VotingProcedures.new())],
    ['a proposal, also with no proposal in it', (p: { body: CML.TransactionBody }) => p.body.set_proposal_procedures(CML.ProposalProcedureList.new())],
    ['a treasury value', (p: { body: CML.TransactionBody }) => p.body.set_current_treasury_value(1n)],
    ['a donation', (p: { body: CML.TransactionBody }) => p.body.set_donation(1n)],
    ['a hash of auxiliary data', (p: { body: CML.TransactionBody }) => p.body.set_auxiliary_data_hash(CML.AuxiliaryDataHash.from_hex('00'.repeat(32)))],
    ['a network id', (p: { body: CML.TransactionBody }) => p.body.set_network_id(CML.NetworkId.mainnet())],
  ])('refuses %s', async (_name, change) => {
    const { hex } = await build();
    await refuses('not_a_delegation', changed(hex, change));
  });

  it('refuses an update, a part that only the bytes can carry, before the decoder library reads the transaction', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', withRawBodyEntry(hex, 6, 'a0'));
  });

  it('refuses a body that lacks a part that a Delegate has, and takes a body that lacks the optional collateral return', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', withoutParts(hex, ['reference_inputs']));
    await refuses('not_a_delegation', withoutParts(hex, ['script_data_hash']));
    await signs(withoutParts(hex, ['collateral_return', 'total_collateral']));
  });

  it('refuses auxiliary data', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', changed(hex, (p) => { p.auxiliary = CML.AuxiliaryData.new(); }));
  });

  it('refuses a transaction that is marked as one whose scripts fail', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', changed(hex, (p) => { p.valid = false; }));
  });

  describe('the mint', () => {
    it('refuses two tokens of the delegation policy', async () => {
      const { hex, id } = await build();
      await refuses('not_a_delegation', withMint(hex, { [policyOf]: [[id, 1n], [nameHex('second'), 1n]] }));
    });

    it('refuses a burn of the token, and a burn of another token with it', async () => {
      const { hex, id } = await build();
      await refuses('not_a_delegation', withMint(hex, { [policyOf]: [[id, -1n]] }));
      await refuses('not_a_delegation', withMint(hex, { [policyOf]: [[id, 1n]], [DELEG_A.keyHash.slice(0, 56)]: [[nameHex('other'), -1n]] }));
    });

    it('refuses a quantity of 2, a token of another policy, and no mint', async () => {
      const { hex, id } = await build();
      await refuses('not_a_delegation', withMint(hex, { [policyOf]: [[id, 2n]] }));
      await refuses('not_a_delegation', withMint(hex, { [OTHER_AGENT_ID.slice(0, 56)]: [[id, 1n]] }));
      await refuses('not_a_delegation', withMint(hex, {}));
    });
  });

  describe('the outputs', () => {
    it('refuses a datum that is a hash and not inline', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withOutputs(hex, (outputs) => outputs.map((output) => (
        output.address().to_bech32() === DEPLOYMENT.delegation.address
          ? CML.TransactionOutput.new(output.address(), output.amount(), CML.DatumOption.new_hash(CML.DatumHash.from_hex('11'.repeat(32))))
          : output))));
    });

    it('refuses a delegation output without a datum, and a datum that is not a delegation', async () => {
      const { hex } = await build();
      const replaced = (datum: CML.DatumOption | undefined) => withOutputs(hex, (outputs) => outputs.map((output) => (
        output.address().to_bech32() === DEPLOYMENT.delegation.address ? CML.TransactionOutput.new(output.address(), output.amount(), datum) : output)));
      await refuses('not_a_delegation', replaced(undefined));
      await refuses('not_a_delegation', replaced(CML.DatumOption.new_datum(CML.PlutusData.new_integer(CML.BigInteger.from_str('7')))));
    });

    it('refuses a second output at the delegation script, and an output at the script with another stake part', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withOutputs(hex, (outputs) => [...outputs, outputs[0]!]));
      const withStake = CML.BaseAddress.new(1, CML.Credential.new_script(CML.ScriptHash.from_hex(policyOf)), keyCredential(STRANGER.keyHash)).to_address();
      await refuses('not_a_delegation', withOutputs(hex, (outputs) => [...outputs, CML.TransactionOutput.new(withStake, outputs[0]!.amount(), outputs[0]!.datum())]));
    });

    it('refuses a transaction with no output at the delegation script', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withOutputAddress(hex, 0, OWN_ADDRESS));
    });

    it('refuses a delegation output that holds one token that is not the minted token: another policy, another name, or two of it', async () => {
      const { hex, id } = await build();
      const holding = (policy: string, name: string, quantity: bigint) => withOutputs(hex, (outputs) => outputs.map((output) => {
        if (output.address().to_bech32() !== DEPLOYMENT.delegation.address) return output;
        const assets = CML.MultiAsset.new();
        assets.set(CML.ScriptHash.from_hex(policy), CML.AssetName.from_hex(name), quantity);
        return CML.TransactionOutput.new(output.address(), CML.Value.new(output.amount().coin(), assets), output.datum());
      }));
      await refuses('not_a_delegation', holding(OTHER_AGENT_ID.slice(0, 56), id, 1n));
      await refuses('not_a_delegation', holding(policyOf, nameHex('other'), 1n));
      await refuses('not_a_delegation', holding(policyOf, id, 2n));
      await signs(holding(policyOf, id, 1n));
    });

    it('refuses a delegation output that holds another token, or a reference script', async () => {
      const { hex, id } = await build();
      await refuses('not_a_delegation', withOutputs(hex, (outputs) => outputs.map((output) => {
        if (output.address().to_bech32() !== DEPLOYMENT.delegation.address) return output;
        const value = output.amount();
        const assets = value.multi_asset();
        assets.set(CML.ScriptHash.from_hex(policyOf), CML.AssetName.from_hex(nameHex('extra')), 1n);
        return CML.TransactionOutput.new(output.address(), CML.Value.new(value.coin(), assets), output.datum());
      })));
      await refuses('not_a_delegation', withOutputs(hex, (outputs) => outputs.map((output) => (
        output.address().to_bech32() === DEPLOYMENT.delegation.address
          ? CML.TransactionOutput.new(output.address(), output.amount(), output.datum(), CML.Script.new_plutus_v3(CML.PlutusV3Script.from_cbor_hex('450101002499')))
          : output))));
      expect(id).toHaveLength(64);
    });
  });

  describe('the redeemers', () => {
    it.each([['a spend', 0], ['a certificate', 2], ['a withdrawal', 3], ['a vote', 4], ['a proposal', 5]] as const)('refuses a redeemer for %s (tag %i) in place of the mint', async (_name, tag) => {
      const { hex } = await build();
      await refuses('not_a_delegation', withRedeemers(hex, [tag as number]));
    });

    it('refuses a redeemer for the mint at an index that is not the index of the policy', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withRedeemers(hex, [1], 1n));
      await signs(withRedeemers(hex, [1], 0n));
    });

    it('reads the redeemers in the form of a map as it reads the form of a list: the mint alone is signed, and any other purpose is refused', async () => {
      const { hex } = await build();
      await signs(withRedeemerMap(hex, [1]));
      await refuses('not_a_delegation', withRedeemerMap(hex, [0]));
      await refuses('not_a_delegation', withRedeemerMap(hex, [1, 5]));
    });

    it('refuses a second redeemer next to the one for the mint, and refuses no redeemer', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withRedeemers(hex, [1, 0]));
      await refuses('not_a_delegation', changed(hex, (p) => { p.witnesses = CML.TransactionWitnessSet.new(); }));
    });

    it('refuses a plutus script and a datum in the witness set: the script of a Delegate is a reference script', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', changed(hex, (p) => {
        const scripts = CML.PlutusV3ScriptList.new();
        scripts.add(CML.PlutusV3Script.from_cbor_hex('450101002499'));
        p.witnesses.set_plutus_v3_scripts(scripts);
      }));
      await refuses('not_a_delegation', changed(hex, (p) => {
        const datums = CML.PlutusDataList.new();
        datums.add(CML.PlutusData.new_integer(CML.BigInteger.from_str('1')));
        p.witnesses.set_plutus_datums(datums);
      }));
    });
  });

  describe('the signers', () => {
    it('refuses another key of the agent as a required signer: the service key and the supplier key', async () => {
      const { hex } = await build();
      const base = [PRINCIPAL.keyHash, DELEG_A.keyHash];
      await refuses('not_a_delegation', withRequiredSigners(hex, [...base, SERVICE.keyHash]));
      await refuses('not_a_delegation', withRequiredSigners(hex, [...base, SUPPLIER.keyHash]));
      await refuses('not_a_delegation', withRequiredSigners(hex, [...base, DELEG_B.keyHash]));
    });

    it('refuses a required signer that is not a key of the agent, a missing delegator, and a missing delegation key', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withRequiredSigners(hex, [PRINCIPAL.keyHash, DELEG_A.keyHash, STRANGER.keyHash]));
      await refuses('not_a_delegation', withRequiredSigners(hex, [DELEG_A.keyHash]));
      await refuses('not_a_delegation', withRequiredSigners(hex, [PRINCIPAL.keyHash]));
      await refuses('not_a_delegation', withRequiredSigners(hex, [PRINCIPAL.keyHash, PRINCIPAL.keyHash]));
    });

    it('refuses a transaction that has a witness of the delegation key already', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', signedBy(hex, DELEG_A));
      await signs(signedBy(hex, PRINCIPAL));
    });
  });

  describe('the datum', () => {
    it('refuses a delegation that breaks a rule of the delegation contract', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withDatum(hex, (d) => ({ ...d, notAfter: d.notBefore })));
      await refuses('not_a_delegation', withDatum(hex, (d) => ({ ...d, actions: [] })));
      await signs(withDatum(hex, (d) => ({ ...d })));
    });

    it('refuses a delegation of a principal key that is not a first delegation', async () => {
      const { hex } = await build();
      await refuses('not_a_delegation', withDatum(hex, (d) => ({ ...d, parent: '66'.repeat(32) })));
      await refuses('not_a_delegation', withDatum(hex, (d) => ({ ...d, depth: 2, remaining: 1 })));
    });
  });
});

describe('the delegation must name this agent and one of its delegation keys', () => {
  it('refuses a delegation to another agent, with the key of that agent', async () => {
    const { hex } = await build({ delegate: OTHER_AGENT_ID, delegateKey: OTHER_AGENT_KEY.keyHash });
    await refuses('not_for_this_agent', hex);
    await signs((await build()).hex);
  });

  it('refuses a delegation to another agent, with a key of this agent', async () => {
    await refuses('not_for_this_agent', withDatum((await build()).hex, (d) => ({ ...d, delegate: OTHER_AGENT_ID })));
  });

  it.each([['the service key', SERVICE], ['the supplier key', SUPPLIER]])('refuses %s as the delegation key, also when the record of the agent lists it with the delegation purpose', async (_name, key) => {
    // The builder takes the key, because the fixture record lists it with the delegation purpose. The agent knows its own delegation keys, and the record is not what it asks.
    const { hex } = await build({ delegateKey: key.keyHash });
    await refuses('not_for_this_agent', hex);
    await signs((await build({ delegateKey: DELEG_A.keyHash })).hex);
  });

  it('refuses a key that nobody lists, and a key hash of the wrong length cannot be built at all', async () => {
    await refuses('not_for_this_agent', withDatum((await build()).hex, (d) => ({ ...d, delegateKey: STRANGER.keyHash })));
  });

  it('signs for a delegation key only when the service holds it: a service with the key B alone refuses the key A', async () => {
    const { hex } = await build();
    await refuses('not_for_this_agent', hex, { keys: [DELEG_B] });
    await signs(hex, { keys: [DELEG_A] });
  });
});

describe('the delegator must be a principal key on the allowlist', () => {
  it('refuses a principal key that is not on the list, and signs the same transaction when it is: the delegator signed it in both cases', async () => {
    const { hex } = await build({ delegator: { type: 'PrincipalKey', hash: STRANGER.keyHash } });
    await refuses('principal_not_allowed', hex, {}, STRANGER);
    await signs(hex, { allowed: [STRANGER.keyHash] }, STRANGER);
  });

  it('refuses every principal key when the list is empty', async () => {
    const { hex } = await build();
    await refuses('principal_not_allowed', hex, { allowed: [] });
  });

  it('refuses a delegation of an agent as the delegator, whatever the list holds', async () => {
    const { hex } = await build({ delegator: { type: 'Agent', id: OTHER_AGENT_ID } });
    await refuses('principal_not_allowed', hex, { allowed: [PRINCIPAL.keyHash, OTHER_AGENT_ID.slice(0, 56)] });
  });

  it('refuses a sub-delegation by an agent for the delegator, and a delegation of a principal key with a parent for what it is', async () => {
    const byAgent = (await build({ delegator: { type: 'Agent', id: OTHER_AGENT_ID } })).hex;
    await refuses('principal_not_allowed', withDatum(byAgent, (d) => ({ ...d, parent: '66'.repeat(32), depth: 2, remaining: 0 })));
    await refuses('not_a_delegation', withDatum((await build()).hex, (d) => ({ ...d, parent: '66'.repeat(32), depth: 2, remaining: 0 })));
  });

  it('shows nothing of the list in the refusal: not a key, not the size', async () => {
    const { hex } = await build({ delegator: { type: 'PrincipalKey', hash: STRANGER.keyHash } });
    const { result } = await ask(hex, { allowed: [PRINCIPAL.keyHash, OTHER_AGENT_KEY.keyHash] }, STRANGER);
    expect(result.ok).toBe(false);
    const text = JSON.stringify(result);
    for (const secret of [PRINCIPAL.keyHash, OTHER_AGENT_KEY.keyHash, STRANGER.keyHash, '2 ', 'allowlist', 'list']) expect(text).not.toContain(secret);
  });
});

describe('the validity window', () => {
  it('is refused with `expired` at its end and after it, and is signed one millisecond before its end', async () => {
    const { hex, hi } = await build();
    await refuses('expired', hex, { now: hi });
    await refuses('expired', hex, { now: hi + 3_600_000 });
    await signs(hex, { now: hi - 1 });
  });

  it('is refused with `expired` when the period of the delegation has ended before now, and signed when the period ends at now', async () => {
    // The contract does not compare the period with the time. A key that such a delegation names is in use until the delegator ends the delegation, so the agent does not sign it.
    await refuses('expired', (await build({ notBefore: NOW - 2 * DAY, notAfter: NOW - 1 })).hex);
    await refuses('expired', (await build({ notBefore: NOW - 2 * DAY, notAfter: NOW - DAY })).hex);
    await signs((await build({ notBefore: NOW - 2 * DAY, notAfter: NOW })).hex);
  });

  it('is refused with `expired` when the period of the delegation has ended before the window of the transaction starts, and signed when it ends at the start', async () => {
    // The builder starts a window one minute before the time of the build. The clock is 5 minutes before that time, so the window starts in 4 minutes. The period ends between the clock and the start.
    const start = NOW - 60_000;
    const now = NOW - 5 * 60_000;
    await refuses('expired', (await build({ validMinutes: 5, notBefore: NOW - DAY, notAfter: start - 1 })).hex, { now });
    await signs((await build({ validMinutes: 5, notBefore: NOW - DAY, notAfter: start })).hex, { now });
  });

  it('gives the refusal for the period a text that shows nothing of the request', async () => {
    const { hex } = await build({ notBefore: NOW - 2 * DAY, notAfter: NOW - DAY });
    const { result } = await ask(hex);
    expect(result).toMatchObject({ ok: false, code: 'expired', detail: 'the period of the delegation has ended' });
  });

  it('is refused when it ends too far ahead of the clock, and signed under the limit', async () => {
    const { hex, hi } = await build();
    // The window ends 30 minutes after NOW. A limit of one minute refuses it, and the default limit of one hour takes it.
    await refuses('not_a_delegation', hex, { limits: { [COSIGN_SETTINGS.maxFutureMs]: '60000' } });
    await signs(hex, { limits: { [COSIGN_SETTINGS.maxFutureMs]: String(hi - NOW) } });
    await refuses('not_a_delegation', hex, { limits: { [COSIGN_SETTINGS.maxFutureMs]: String(hi - NOW - 1) } });
  });

  it('is refused when it is longer than one hour, or empty, or has no start or no end', async () => {
    const { hex } = await build();
    const start = CML.Transaction.from_cbor_hex(hex).body().validity_interval_start()!;
    await refuses('not_a_delegation', changed(hex, (p) => p.body.set_ttl(start + 3_601n)));
    await refuses('not_a_delegation', changed(hex, (p) => p.body.set_ttl(start)));
    await refuses('not_a_delegation', changed(hex, (p) => p.body.set_ttl(start - 1n)));
    await signs(changed(hex, (p) => p.body.set_ttl(start + 3_600n)), { limits: { [COSIGN_SETTINGS.maxFutureMs]: '3600000' }, now: NOW });
  });

  it('is refused when the clock gives a value that is not a time', async () => {
    const { hex } = await build();
    const { result, signed } = await ask(hex, { now: Number.NaN });
    expect(result).toMatchObject({ ok: false, code: 'internal' });
    expect(signed).toEqual([]);
  });
});

describe('the transaction must spend nothing of the agent', () => {
  it('refuses an output of a wallet of the agent as an input: each key of the agent has such a wallet', async () => {
    const { hex } = await build();
    for (const key of [DELEG_A, DELEG_B, SUPPLIER, SERVICE]) await refuses('spends_agent_funds', withInput(hex, agentWallet(key, 1)));
    await signs(hex);
  });

  it('refuses an output of the agent as a collateral input', async () => {
    const { hex } = await build();
    for (const key of [DELEG_A, SUPPLIER]) await refuses('spends_agent_funds', withCollateral(hex, agentWallet(key, 0)));
    await signs(hex);
  });

  it('refuses a transaction that the builder funds from the wallet of the agent, and the same transaction with its change paid to another address', async () => {
    const funded = await build({ changeAddress: walletAddress(DELEG_A) });
    await refuses('spends_agent_funds', funded.hex);
    // The value of the agent leaves to the member: the change output is paid to the address of the member.
    await refuses('spends_agent_funds', withOutputAddress(funded.hex, 1, OWN_ADDRESS));
    await signs((await build()).hex);
  });

  it('refuses an input whose address has no payment key: the agent cannot tell whose it is', async () => {
    const { hex } = await build();
    const stake = { txHash: 'ab'.repeat(32), outputIndex: 3, address: CML.RewardAddress.new(1, keyCredential(STRANGER.keyHash)).to_address().to_bech32(), assets: { lovelace: 2_000_000n } };
    await refuses('not_a_delegation', withInput(hex, stake), { ledger: ledgerOf(world([stake])) });
    await signs(withInput(hex, agentWallet(STRANGER, 1)), { ledger: ledgerOf(world([agentWallet(STRANGER, 1)])) });
  });

  it('knows a wallet only by the keys that the service gives: a key that it did not give is not the agent', async () => {
    const { hex } = await build();
    const spending = withInput(hex, agentWallet(SERVICE, 1));
    await refuses('spends_agent_funds', spending);
    await signs(spending, { otherKeyHashes: [SUPPLIER.keyHash] });
  });

  it('refuses an input that is an output of a script, and an input that the ledger does not have', async () => {
    const live = liveDelegation(DELEG_B.keyHash);
    const { hex } = await build();
    await refuses('not_a_delegation', withInput(hex, live), { ledger: ledgerOf(world([live])) });
    const unknown = { ...agentWallet(DELEG_A, 1), txHash: 'ee'.repeat(32) };
    await refuses('not_a_delegation', withInput(hex, unknown));
    await signs(withInput(hex, { ...agentWallet(STRANGER, 1) }), { ledger: ledgerOf(world([agentWallet(STRANGER, 1)])) });
  });

  it('takes a transaction that spends 32 outputs, inputs and collateral inputs together, and refuses one that spends 33 or more', async () => {
    const { hex } = await build();
    const members = memberUtxos(40);
    const ledger = ledgerOf(world(members));
    // The build can use one output as the input and as the collateral, and then it spends one output. The test counts the outputs of the build and adds as many as it needs.
    const own = spentOf(hex).length;
    await signs(withInputs(hex, members.slice(0, 32 - own)), { ledger });
    expect(spentOf(withInputs(hex, members.slice(0, 32 - own)))).toHaveLength(32);
    await refuses('not_a_delegation', withInputs(hex, members.slice(0, 33 - own)), { ledger });
    await refuses('not_a_delegation', withInputs(hex, members), { ledger });
  });

  it('refuses an input that is an output of the agent that the ledger does not have yet: an output that a later transaction makes', async () => {
    const { hex } = await build();
    await refuses('not_a_delegation', withInput(hex, { ...agentWallet(DELEG_A, 1), txHash: 'dd'.repeat(32), outputIndex: 5 }));
  });
});

describe('the delegation key must be free', () => {
  it('refuses a key that a live delegation names, and signs the key that no delegation names', async () => {
    const { hex } = await build();
    const ledger = ledgerOf(world([liveDelegation(DELEG_A.keyHash)]));
    await refuses('key_in_use', hex, { ledger });
    await signs((await build({ delegateKey: DELEG_B.keyHash })).hex, { ledger });
  });

  it('keeps a key in use after its delegation has expired: only the delegator ends a delegation', async () => {
    const live = liveDelegation(DELEG_A.keyHash);
    const datum = decodeDelegationDatum(live.datum!);
    const expired = { ...live, datum: encodeDelegationDatum({ ...datum, notAfter: NOW - 1_000 }) };
    await refuses('key_in_use', (await build()).hex, { ledger: ledgerOf(world([expired])) });
  });

  it('does not count an output at another address that has a delegation datum, and a delegation of another key', async () => {
    const stray = { ...liveDelegation(DELEG_A.keyHash), address: OWN_ADDRESS };
    await signs((await build()).hex, { ledger: ledgerOf(world([stray])) });
  });
});
