// packages/buyer-core/test/config-and-fixtures.test.ts
// Pins the one deviation of the vendored config.ts (mainnet defaults, VENDORED-FROM.md), and puts the vendored fixtures to work on
// the vendored code: the live ChandraOCR advert through planPostEscrow, the lineage world through resolveEscrowLineage, and the
// fixture provider through lucidForAddress.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { decodeAdvertDatum, decodeEscrowDatum, promptHashForPayload } from '@vsa/vector-read';
import type { EscrowDatum } from '@vsa/vector-read';
import { planPostEscrow, resolveEscrowLineage, lucidForAddress, DELIVER_BY_BUFFER_MS } from '../src/index.ts';
import { ADVERT_REF, ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_REF, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE } from './fixtures/marketplace.fixture.ts';
import { world, escrowAt, SUBMIT_TX, ESCROW_TX } from './fixtures/escrow-koios.fixture.ts';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS } from './fixtures/fixture-provider.ts';

const MAINNET = {
  VECTOR_OGMIOS_URL: 'https://ogmios.vector.mainnet.apexfusion.org',
  // The Koios base as vendored: no /api/v1, which the vendored indexer and provider append themselves.
  VECTOR_KOIOS_URL: 'https://v2.koios.vector.mainnet.apexfusion.org/',
  VECTOR_SUBMIT_URL: 'https://submit.vector.mainnet.apexfusion.org/api/submit/tx',
};
// config.ts reads the environment when it is first imported, so each test stubs it and imports a fresh copy.
const freshConfig = async () => { vi.resetModules(); return import('../src/vendored/mcp-shared/config.ts'); };

describe('the vendored config.ts defaults to Vector mainnet (the listed deviation)', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('gives the three mainnet endpoints when their environment variables are unset', async () => {
    for (const name of Object.keys(MAINNET)) vi.stubEnv(name, undefined);
    const config = await freshConfig();
    expect({ VECTOR_OGMIOS_URL: config.VECTOR_OGMIOS_URL, VECTOR_KOIOS_URL: config.VECTOR_KOIOS_URL, VECTOR_SUBMIT_URL: config.VECTOR_SUBMIT_URL }).toStrictEqual(MAINNET);
  });

  it('still takes each endpoint from its environment variable', async () => {
    vi.stubEnv('VECTOR_OGMIOS_URL', 'https://ogmios.example');
    vi.stubEnv('VECTOR_KOIOS_URL', 'https://koios.example/');
    vi.stubEnv('VECTOR_SUBMIT_URL', 'https://submit.example/api/submit/tx');
    const config = await freshConfig();
    expect([config.VECTOR_OGMIOS_URL, config.VECTOR_KOIOS_URL, config.VECTOR_SUBMIT_URL]).toStrictEqual(['https://ogmios.example', 'https://koios.example/', 'https://submit.example/api/submit/tx']);
  });
});

describe('planPostEscrow on the live ChandraOCR advert (marketplace.fixture.ts)', () => {
  const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
  const nowMs = 1_790_000_000_000;
  const payload = '{"pages":1}';

  it('writes the Open datum the escrow validator expects, and asks for the lock the live Post of this advert carried', () => {
    const plan = planPostEscrow(advert, ADVERT_REF, ESCROW_EXPECTED.buyer_pkh, payload, nowMs);
    const deliverBy = nowMs + ADVERT_EXPECTED.max_processing_ms + DELIVER_BY_BUFFER_MS;
    expect(plan.datum).toStrictEqual({
      buyer_pkh: ESCROW_EXPECTED.buyer_pkh, supplier_pkh: ADVERT_EXPECTED.supplier_pkh,
      advert_ref: { txHash: ADVERT_REF.slice(0, 64), index: 0 }, capability_id: ADVERT_EXPECTED.capability_id,
      // The same advert, so the same request spec as the live escrow posted against it.
      request_spec_hash: ESCROW_EXPECTED.request_spec_hash, prompt_hash: promptHashForPayload(payload),
      payment_lovelace: ADVERT_EXPECTED.price_lovelace, buyer_bond_lovelace: ADVERT_EXPECTED.buyer_bond_lovelace, supplier_bond_lovelace: ADVERT_EXPECTED.supplier_bond_lovelace,
      deliver_by: deliverBy, posted_at: nowMs, submitted_at: null, result_receipt_hash: null, state: 'Open',
    });
    // The floor of the largest (Submitted) datum: the same datum shape as the live escrow, so the same lock it holds on chain.
    expect(plan.lockLovelace).toBe(ESCROW_LOCKED_LOVELACE);
    expect(plan).toMatchObject({ deliverBy, validTo: nowMs + DELIVER_BY_BUFFER_MS, endpointHost: 'mp-suppliers-chandra.hal8.ai', supplierPkh: ADVERT_EXPECTED.supplier_pkh, capabilityId: ADVERT_EXPECTED.capability_id });
  });

  it('refuses a Post by the supplier of the advert itself', () => {
    expect(() => planPostEscrow(advert, ADVERT_REF, ADVERT_EXPECTED.supplier_pkh, payload, nowMs)).toThrow('The buyer cannot be the supplier of the same advert.');
  });
});

describe('resolveEscrowLineage over the lineage world (escrow-koios.fixture.ts)', () => {
  const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
  const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };

  it('follows the live escrow from its Post output to its Submitted continuation, asking Koios under the vendored mainnet base', async () => {
    const w = world([escrowAt(SUBMIT_TX, submitted)]);
    const lineage = await resolveEscrowLineage(w.node, MAINNET.VECTOR_KOIOS_URL, ESCROW_REF, w.koios.f);
    expect(lineage.posted).toStrictEqual(posted);
    expect(lineage.spent).toBe(true);
    expect(lineage.current?.utxo).toMatchObject({ txHash: SUBMIT_TX, outputIndex: 0 });
    expect(lineage.current?.datum).toStrictEqual(submitted);
    // The base without /api/v1 becomes .../api/v1/<route>, never /api/v1/api/v1.
    const urls = w.koios.calls.map((c) => c.url ?? '');
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toMatch(/^https:\/\/v2\.koios\.vector\.mainnet\.apexfusion\.org\/api\/v1\/(utxo_info|credential_utxos|tx_info)(\?|$)/);
  });

  it('refuses to guess when Koios says the Post output is spent and the node still holds it', async () => {
    const w = world([escrowAt(ESCROW_TX, posted)]);
    await expect(resolveEscrowLineage(w.node, MAINNET.VECTOR_KOIOS_URL, ESCROW_REF, w.koios.f)).rejects.toThrow(/Koios and the node disagree about escrow/);
  });
});

describe('lucidForAddress over the fixture provider (fixture-provider.ts)', () => {
  it('builds a Lucid instance whose wallet is the address and its UTxOs, offline', async () => {
    const lucid = await lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), OWN_ADDRESS);
    expect(await lucid.wallet().address()).toBe(OWN_ADDRESS);
    expect((await lucid.wallet().getUtxos()).map((u) => u.outputIndex).sort()).toStrictEqual([0, 1, 2]);
  });

  it('refuses an address that does not parse, and an address with nothing on it', async () => {
    await expect(lucidForAddress(new FixtureProvider(FIXTURE_UTXOS), 'not-an-address')).rejects.toThrow(/^Invalid change address: /);
    await expect(lucidForAddress(new FixtureProvider([]), OWN_ADDRESS)).rejects.toThrow(/^No UTxOs found at /);
  });
});
