// packages/buyer-core/test/fleet-build.test.ts
// The Post of a fleet job. planFleetPostEscrow and buildFleetPostEscrow mirror the vendored planPostEscrow and buildPostEscrow with a
// prompt hash computed by the caller (commitments.ts) in place of a template payload, and without the vendored builder's refusal of fleet
// capabilities. (a) to (c) are the brief's tests; the rest pins the refusals the mirror keeps and builds the Post offline, in both layouts: the
// identity layout (Part 2 sections 6.1, 6.2 and 6.5) over the identity world of the vendored fixtures (a deployment with test parameters, the agent's
// record on the node, one fake for Koios and the indexer).
import { describe, it, expect, beforeAll } from 'vitest';
import { CML, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { decodeAdvertDatum, decodeEscrowDatum, decodeIdentityEscrowDatum, encodeEscrowDatum, encodeIdentityEscrowDatum, identityEscrowLockFloor, requestSpecHash } from '@vsa/vector-read';
import type { IdentityEscrowDatum } from '@vsa/vector-read';
import { plutusAddressFromBech32 } from '@vsa/vector-read/identity-codec';
import {
  planFleetPostEscrow, buildFleetPostEscrow, buildPostEscrow, fleetPostTerms, isIdentityAdvert, lucidForAddress, ocrPromptHash, DELIVER_BY_BUFFER_MS, MAX_ESCROW_LOVELACE,
} from '../src/index.ts';
import type { FleetPostPlan, IdentityDeployment } from '../src/index.ts';
import { ESCROW_ADDRESS, MARKETPLACE_MIN_FEE, MAX_PROCESSING_MS_CEILING } from '../src/vendored/mcp/marketplace-constants.ts';
import { MAX_RANGE_MS } from '../src/vendored/mcp/identity-rules.ts';
import { isFleetCapability } from '../src/vendored/mcp/marketplace-supplier.ts';
import { ADVERT_REF, ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE } from './fixtures/marketplace.fixture.ts';
import { FixtureProvider, FIXTURE_UTXOS, FIXTURE_TXHASH, OWN_ADDRESS } from './fixtures/fixture-provider.ts';
import { DEPLOYMENT, NOW as IDENTITY_NOW, identityWorld, lucidOn } from './fixtures/identity-world.ts';
import {
  ADVERT_REF as IDENTITY_ADVERT_REF, AGENT_ID, IDENTITY_ADVERT, OWN_PKH as IDENTITY_BUYER, SUPPLIER_PKH, advertUtxo, agentRecord, chainFake, listedRow,
} from './fixtures/escrow-identity.fixture.ts';
import { advertKoios, ADVERT_TX } from './advert-koios.ts';

const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
/** The live escrow was posted by the fleet's own buyer, whose buffer is 30 s: deliver_by = posted_at + 300000 + 30000, as on chain. */
const LIVE_DELIVER_BY = 1_786_530_304_711;
/** This plan's rule, the mcp-server's buffer (DELIVER_BY_BUFFER_MS, 180 s): deliver_by = posted_at + 300000 + 180000. */
const PLANNED_DELIVER_BY = 1_786_530_454_711;
/** How the datum encodes an integer: 1b and 8 bytes, whatever its size (encodeEscrowDatum, byte-identical to the marketplace's encoder). */
const uint = (n: number): string => `1b${n.toString(16).padStart(16, '0')}`;
const NOW = ESCROW_EXPECTED.posted_at;
const BUYER = ESCROW_EXPECTED.buyer_pkh;
const PROMPT = ocrPromptHash({ image_b64: 'iVBORw0KGgo=', mime: 'image/png', output_format: 'markdown' });

describe('planFleetPostEscrow', () => {
  it('(a) writes the live escrow datum byte for byte but for deliver_by, which follows this plan\'s rule, and asks for the live lock', () => {
    const plan: FleetPostPlan = planFleetPostEscrow(advert, ADVERT_REF, ESCROW_EXPECTED.buyer_pkh, ESCROW_EXPECTED.prompt_hash, ESCROW_EXPECTED.posted_at);
    // The two numbers: the live one, and the one this plan writes.
    expect(ESCROW_EXPECTED.deliver_by).toBe(LIVE_DELIVER_BY);
    expect(LIVE_DELIVER_BY - ESCROW_EXPECTED.posted_at).toBe(300_000 + 30_000);
    expect(PLANNED_DELIVER_BY).toBe(ESCROW_EXPECTED.posted_at + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS);
    expect(plan.datum.deliver_by).toBe(PLANNED_DELIVER_BY);
    expect(plan.deliverBy).toBe(PLANNED_DELIVER_BY);
    // Every other field is the live datum's, byte for byte.
    expect(encodeEscrowDatum({ ...plan.datum, deliver_by: LIVE_DELIVER_BY })).toBe(ESCROW_OPEN_DATUM_HEX);
    expect(plan.datum).toStrictEqual({ ...ESCROW_EXPECTED, deliver_by: PLANNED_DELIVER_BY });
    // So the planned encoding is the live one with the eight bytes of deliver_by replaced (they occur once in it).
    expect(ESCROW_OPEN_DATUM_HEX.split(uint(LIVE_DELIVER_BY))).toHaveLength(2);
    expect(encodeEscrowDatum(plan.datum)).toBe(ESCROW_OPEN_DATUM_HEX.replace(uint(LIVE_DELIVER_BY), uint(PLANNED_DELIVER_BY)));
    // The lock of the live Post, and posted_at as given.
    expect(plan.lockLovelace).toBe(2_261_030n);
    expect(plan.lockLovelace).toBe(ESCROW_LOCKED_LOVELACE);
    expect(plan.postedAt).toBe(ESCROW_EXPECTED.posted_at);
  });

  it('(b) is valid until min(now + 180000, deliverBy - 300000): the latest a Post can land and still leave the supplier its full window', () => {
    const now = 1_790_000_000_000;
    const plan = planFleetPostEscrow(advert, ADVERT_REF, BUYER, PROMPT, now);
    expect(plan.validTo).toBe(Math.min(now + 180_000, plan.deliverBy - 300_000));
    expect(plan.validTo).toBe(now + 180_000);
    expect(plan.deliverBy - plan.validTo).toBe(ADVERT_EXPECTED.max_processing_ms);
    // Whatever the window: the same buffer, and the window kept.
    for (const max_processing_ms of [0, 10_000, MAX_PROCESSING_MS_CEILING]) {
      const p = planFleetPostEscrow({ ...advert, max_processing_ms }, ADVERT_REF, BUYER, PROMPT, now);
      expect(p.validTo, `window ${max_processing_ms}`).toBe(Math.min(now + DELIVER_BY_BUFFER_MS, p.deliverBy - max_processing_ms));
      expect(p.deliverBy - p.validTo, `window ${max_processing_ms}`).toBe(max_processing_ms);
    }
  });

  it('(c) is generic: a template-contract advert (identity.history.report.v1) is planned the same way as the fleet one', () => {
    const history = { ...advert, capability_id: 'identity.history.report.v1', model: 'agent-history-v1' };
    expect(isFleetCapability(history.capability_id)).toBe(false);
    expect(isFleetCapability(advert.capability_id)).toBe(true);
    const plan = planFleetPostEscrow(history, ADVERT_REF, BUYER, PROMPT, NOW);
    expect(plan.datum).toMatchObject({ capability_id: 'identity.history.report.v1', request_spec_hash: requestSpecHash(history), prompt_hash: PROMPT, buyer_pkh: BUYER, state: 'Open' });
    expect(plan.datum.request_spec_hash).not.toBe(ESCROW_EXPECTED.request_spec_hash);
    expect(plan.deliverBy).toBe(NOW + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });

  it('refuses what planPostEscrow refuses: a retired advert, the buyer as its own supplier, a window over 24 h, an endpoint without a host', () => {
    expect(() => planFleetPostEscrow({ ...advert, status: 'Retired' }, ADVERT_REF, BUYER, PROMPT, NOW)).toThrow(`Advert ${ADVERT_REF} is retired; pick another supplier.`);
    expect(() => planFleetPostEscrow(advert, ADVERT_REF, ADVERT_EXPECTED.supplier_pkh, PROMPT, NOW)).toThrow('The buyer cannot be the supplier of the same advert.');
    expect(() => planFleetPostEscrow({ ...advert, max_processing_ms: MAX_PROCESSING_MS_CEILING + 1 }, ADVERT_REF, BUYER, PROMPT, NOW)).toThrow(/longer than the 86400000 ms \(24 h\)/);
    expect(() => planFleetPostEscrow({ ...advert, endpoint_url: 'not a url' }, ADVERT_REF, BUYER, PROMPT, NOW)).toThrow(/not a usable URL with a host/);
    expect(() => planFleetPostEscrow(advert, ADVERT_REF, BUYER, PROMPT, 1.5)).toThrow(/whole number of POSIX milliseconds/);
  });

  it('takes the prompt hash only as 64 lowercase hex characters, the sha256 the fleet supplier recomputes', () => {
    for (const bad of ['', 'ab'.repeat(31), 'ab'.repeat(33), PROMPT.toUpperCase(), `${PROMPT.slice(1)}g`]) {
      expect(() => planFleetPostEscrow(advert, ADVERT_REF, BUYER, bad, NOW), JSON.stringify(bad)).toThrow(/prompt hash must be 64 lowercase hex characters/);
    }
  });
});

/** The inputs of a transaction, as sorted refs. */
function inputRefs(cborHex: string): string[] {
  const inputs = CML.Transaction.from_cbor_hex(cborHex).body().inputs();
  const refs: string[] = [];
  for (let i = 0; i < inputs.len(); i++) refs.push(`${inputs.get(i).transaction_id().to_hex()}#${inputs.get(i).index()}`);
  return refs.sort();
}

describe('buildFleetPostEscrow over the fixture provider (offline)', () => {
  const provider = new FixtureProvider(FIXTURE_UTXOS);
  const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
  let lucid: LucidEvolution;
  beforeAll(async () => { lucid = await lucidForAddress(provider, OWN_ADDRESS); }, 30_000);
  const post = (k = advertKoios(), over: { koiosUrl?: string } = {}) =>
    buildFleetPostEscrow(lucid, provider, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, promptHash: PROMPT, nowMs: NOW, ...over }, k.f);

  it('builds the unsigned Post of the live ChandraOCR advert, a fleet capability the vendored buildPostEscrow refuses', async () => {
    const r = await post();
    const plan = planFleetPostEscrow(advert, ADVERT_REF, OWN_PKH, PROMPT, NOW);
    const body = CML.Transaction.from_cbor_hex(r.unsignedCborHex).body();
    const escrow = body.outputs().get(0);
    expect(escrow.address().to_bech32()).toBe(ESCROW_ADDRESS);
    expect(escrow.amount().coin()).toBe(2_261_030n);
    expect(escrow.datum()?.as_datum()?.to_cbor_hex()).toBe(encodeEscrowDatum(plan.datum));
    expect(decodeEscrowDatum(escrow.datum()!.as_datum()!.to_cbor_hex()).prompt_hash).toBe(PROMPT);
    expect(r.escrowRef).toBe(`${CML.hash_transaction(body).to_hex()}#0`);
    expect(r.datum).toStrictEqual(plan.datum);
    expect(r).toMatchObject({ lockLovelace: 2_261_030n, deliverBy: NOW + 300_000 + DELIVER_BY_BUFFER_MS, postedAt: NOW, collateralKept: true, layout: 'legacy', agentId: null, escrowAddress: ESCROW_ADDRESS });
    await expect(buildPostEscrow(lucid, provider, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'x', nowMs: NOW }, advertKoios().f)).rejects.toThrow(/a fleet capability/);
  }, 30_000);

  it('says collateralKept false when only the whole wallet, 5-unit output included, can fund the Post (the vendored fallback)', async () => {
    // 5 units and 3: without the 5-unit output, 3 units cannot pay the lock, the fee and a change output.
    const tight = new FixtureProvider([
      { txHash: FIXTURE_TXHASH, outputIndex: 0, address: OWN_ADDRESS, assets: { lovelace: 5_000_000n } },
      { txHash: FIXTURE_TXHASH, outputIndex: 1, address: OWN_ADDRESS, assets: { lovelace: 3_000_000n } },
    ]);
    const tightLucid = await lucidForAddress(tight, OWN_ADDRESS);
    const r = await buildFleetPostEscrow(tightLucid, tight, { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, promptHash: PROMPT, nowMs: NOW }, advertKoios().f);
    expect(r.collateralKept).toBe(false);
    expect(inputRefs(r.unsignedCborHex)).toContain(`${FIXTURE_TXHASH}#0`);
  }, 30_000);

  it('signs for the buyer key, is valid from now - 60 s to now + the buffer in slots of the Vector clock, pays at least the marketplace fee, and keeps the 5-unit output as collateral', async () => {
    const r = await post();
    const body = CML.Transaction.from_cbor_hex(r.unsignedCborHex).body();
    const signers = body.required_signers();
    expect(signers?.len()).toBe(1);
    expect(signers!.get(0).to_hex()).toBe(OWN_PKH);
    const ZERO_TIME_MS = 1_756_485_600_000; // FixtureProvider.getSystemStartMs, Vector mainnet's start
    expect(body.validity_interval_start()).toBe(BigInt(Math.floor((NOW - 60_000 - ZERO_TIME_MS) / 1000)));
    expect(body.ttl()).toBe(BigInt(Math.floor((NOW + DELIVER_BY_BUFFER_MS - ZERO_TIME_MS) / 1000)));
    expect(body.fee() >= MARKETPLACE_MIN_FEE).toBe(true);
    // FIXTURE_UTXOS: 1000 units, 5 units, 10 units with a token. The 5-unit pure output is held back for the Accept and the Reclaim.
    expect(inputRefs(r.unsignedCborHex)).not.toContain(`${FIXTURE_TXHASH}#1`);
  }, 30_000);

  it('reads the advert and proves its author through the Koios it is given', async () => {
    const k = advertKoios();
    await post(k, { koiosUrl: 'https://koios.test.example/' });
    expect(k.calls.map((c) => [c.url, c.body])).toStrictEqual([
      ['https://koios.test.example/api/v1/utxo_info', { _utxo_refs: [ADVERT_REF], _extended: true }],
      ['https://koios.test.example/api/v1/tx_info', { _tx_hashes: [ADVERT_TX], _inputs: true, _assets: true }],
    ]);
  }, 30_000);

  it('refuses a spent advert, a ref with no advert, and an advert whose creating transaction spent nothing of the supplier key', async () => {
    await expect(post(advertKoios({ spent: true }))).rejects.toThrow(`Advert ${ADVERT_REF} has been spent`);
    await expect(post(advertKoios({ rows: [] }))).rejects.toThrow(`No UTxO at ${ADVERT_REF}.`);
    await expect(post(advertKoios({ inputCreds: ['ee'.repeat(28)] }))).rejects.toThrow(`Advert ${ADVERT_REF} was not created by its supplier key`);
  }, 30_000);
});

describe('planFleetPostEscrow in the identity layout (Part 2 sections 6.1 and 6.5)', () => {
  const terms = fleetPostTerms(IDENTITY_ADVERT, OWN_ADDRESS)!;

  it('takes the terms of an identity-marketplace advert: its agent, and the refund to the buyer\'s own address with no datum; a legacy advert has none', () => {
    expect(isIdentityAdvert(IDENTITY_ADVERT)).toBe(true);
    expect(terms).toStrictEqual({ agentId: AGENT_ID, refund: { address: plutusAddressFromBech32(OWN_ADDRESS), datum: null } });
    expect(isIdentityAdvert(advert)).toBe(false);
    expect(fleetPostTerms(advert, OWN_ADDRESS)).toBeUndefined();
  });

  it('writes the 16-field escrow: the 14 legacy fields as a legacy plan writes them, then agent_id and refund; its lock is sized for the widest Submitted datum', () => {
    const legacy = planFleetPostEscrow(IDENTITY_ADVERT, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW);
    const plan = planFleetPostEscrow(IDENTITY_ADVERT, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms);
    expect([legacy.layout, plan.layout]).toStrictEqual(['legacy', 'identity']);
    const datum = plan.datum as IdentityEscrowDatum;
    expect(datum).toStrictEqual({ ...legacy.datum, agent_id: AGENT_ID, refund: terms.refund });
    expect(plan.datumHex).toBe(encodeIdentityEscrowDatum(datum));
    expect(decodeIdentityEscrowDatum(plan.datumHex)).toStrictEqual(datum);
    expect(legacy.datumHex).toBe(encodeEscrowDatum(legacy.datum));
    expect(plan.lockLovelace).toBe(identityEscrowLockFloor(datum, 4_000_000n));
    // Where the floor is above price + both bonds, the identity floor (the widest encoding of the larger datum) is the higher of the two.
    const free = { ...IDENTITY_ADVERT, price_lovelace: 0n, buyer_bond_lovelace: 0n, supplier_bond_lovelace: 0n };
    const freeLegacy = planFleetPostEscrow(free, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW).lockLovelace;
    const freeIdentity = planFleetPostEscrow(free, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms).lockLovelace;
    expect(freeLegacy > 2_000_000n && freeIdentity > freeLegacy).toBe(true);
    expect([plan.deliverBy, plan.validTo, plan.postedAt]).toStrictEqual([legacy.deliverBy, legacy.validTo, legacy.postedAt]);
  });

  it('is valid from posted_at - 60 s to posted_at + the buffer, 240 s, within the one hour of every escrow builder, whatever the window', () => {
    for (const max_processing_ms of [0, 60_000, MAX_PROCESSING_MS_CEILING]) {
      const plan = planFleetPostEscrow({ ...IDENTITY_ADVERT, max_processing_ms }, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms);
      expect([plan.validFrom, plan.validTo], `window ${max_processing_ms}`).toStrictEqual([IDENTITY_NOW - 60_000, IDENTITY_NOW + DELIVER_BY_BUFFER_MS]);
      expect(plan.validTo - plan.validFrom <= MAX_RANGE_MS).toBe(true);
    }
  });

  it('refuses price and both bonds above the value cap F-29 (10000000000 lovelace) in both layouts, lets exactly the cap through, and refuses a negative amount in the identity layout', () => {
    expect(MAX_ESCROW_LOVELACE).toBe(10_000_000_000n);
    const at = (price: bigint) => ({ ...IDENTITY_ADVERT, price_lovelace: price });
    const cap = /asks for price \+ both bonds of 10000000001 lovelace, above the 10000000000 lovelace value cap of an escrow \(F-29\): such an escrow cannot be claimed, so it is not built\./;
    expect(() => planFleetPostEscrow(at(9_998_000_001n), IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms)).toThrow(cap);
    expect(() => planFleetPostEscrow(at(9_998_000_001n), IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW)).toThrow(cap);
    expect(planFleetPostEscrow(at(9_998_000_000n), IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms).lockLovelace).toBe(10_000_000_000n);
    expect(planFleetPostEscrow(at(9_998_000_000n), IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW).lockLovelace).toBe(10_000_000_000n);
    expect(() => planFleetPostEscrow({ ...IDENTITY_ADVERT, buyer_bond_lovelace: -1n }, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, terms)).toThrow(/its terms do not fit an escrow datum \(a negative amount\)/);
  });
});

describe('buildFleetPostEscrow of an identity-marketplace advert (offline)', () => {
  const KOIOS = 'https://koios.test.example';
  /** The Post of the identity advert over the identity world: `records` on the node, `listed` the indexer's rows, `deployment` the chain's. */
  const post = async (o: { records?: UTxO[]; listed?: unknown[]; deployment?: IdentityDeployment | null; indexerUrl?: string } = {}) => {
    const world = identityWorld(o.records ?? [agentRecord()]);
    const k = chainFake({ live: [advertUtxo()], listed: o.listed ?? [listedRow()] });
    const build = buildFleetPostEscrow(await lucidOn(world), world, {
      changeAddress: OWN_ADDRESS, advertRef: IDENTITY_ADVERT_REF, promptHash: PROMPT, nowMs: IDENTITY_NOW, koiosUrl: KOIOS,
      deployment: o.deployment === undefined ? DEPLOYMENT : o.deployment, ...(o.indexerUrl === undefined ? {} : { indexerUrl: o.indexerUrl }),
    }, k.f);
    return { build, k };
  };

  it('pays the identity escrow at output 0 of the deployment\'s escrow address: the agent of the advert, the refund to the buyer\'s own address, the planned lock', async () => {
    const { build } = await post();
    const r = await build;
    const plan = planFleetPostEscrow(IDENTITY_ADVERT, IDENTITY_ADVERT_REF, IDENTITY_BUYER, PROMPT, IDENTITY_NOW, fleetPostTerms(IDENTITY_ADVERT, OWN_ADDRESS));
    const body = CML.Transaction.from_cbor_hex(r.unsignedCborHex).body();
    const escrow = body.outputs().get(0);
    expect(escrow.address().to_bech32()).toBe(DEPLOYMENT.escrow.address);
    expect(escrow.amount().coin()).toBe(plan.lockLovelace);
    expect(escrow.datum()?.as_datum()?.to_cbor_hex()).toBe(plan.datumHex);
    const datum = decodeIdentityEscrowDatum(plan.datumHex);
    expect([datum.agent_id, datum.buyer_pkh, datum.supplier_pkh, datum.prompt_hash, datum.state]).toStrictEqual([AGENT_ID, IDENTITY_BUYER, SUPPLIER_PKH, PROMPT, 'Open']);
    expect(datum.refund).toStrictEqual({ address: plutusAddressFromBech32(OWN_ADDRESS), datum: null });
    expect(r).toMatchObject({ layout: 'identity', agentId: AGENT_ID, escrowAddress: DEPLOYMENT.escrow.address, lockLovelace: plan.lockLovelace, datum: plan.datum, escrowRef: `${CML.hash_transaction(body).to_hex()}#0` });
    const signers = body.required_signers();
    expect([signers?.len(), signers?.get(0).to_hex()]).toStrictEqual([1, IDENTITY_BUYER]);
    expect(Number(body.ttl()) - Number(body.validity_interval_start())).toBe(240);
  }, 30_000);

  it('asks the indexer it is given whether the advert is listed', async () => {
    const { build, k } = await post({ indexerUrl: 'https://indexer.test.example/' });
    await build;
    expect(k.calls).toContain('https://indexer.test.example/suppliers');
    expect(k.calls.filter((url) => url.endsWith('/suppliers'))).toHaveLength(1);
  }, 30_000);

  it('refuses an advert the indexer does not list, or lists with another agent', async () => {
    await expect((await post({ listed: [] })).build).rejects.toThrow(/is not listed by the marketplace indexer/);
    await expect((await post({ listed: [listedRow(IDENTITY_ADVERT_REF, 'bf'.repeat(32))] })).build).rejects.toThrow(/with another agent than the one its datum names/);
  }, 30_000);

  it('refuses an agent that fails the listing rule on chain: no record, the key or the capability not listed, not Active', async () => {
    const hold = { by: { type: 'ControllerSet' as const }, reason: 6, since: IDENTITY_NOW - 86_400_000, until: IDENTITY_NOW + 86_400_000 };
    await expect((await post({ records: [] })).build).rejects.toThrow(/has no record in the identity registry/);
    await expect((await post({ records: [agentRecord({ keys: [] })] })).build).rejects.toThrow(/does not list the supplier key .* with the transaction purpose/);
    await expect((await post({ records: [agentRecord({ capabilities: [] })] })).build).rejects.toThrow(/does not list the capability/);
    await expect((await post({ records: [agentRecord({ status: { type: 'Suspended', holds: [hold] } })] })).build).rejects.toThrow(/is Suspended; only an Active agent can take work/);
  }, 30_000);

  it('without the identity deployment refuses the advert with the words that name the settings, and builds nothing', async () => {
    await expect((await post({ deployment: null })).build).rejects.toThrow(/holds an identity-marketplace advert\. The identity registry is not configured on this server: set VECTOR_IDENTITY_LEGACY_ROOT and VECTOR_IDENTITY_CONFIG_SEED/);
  }, 30_000);
});
