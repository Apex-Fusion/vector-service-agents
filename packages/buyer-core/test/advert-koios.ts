// packages/buyer-core/test/advert-koios.ts
// A fake Koios for the two reads a Post makes before it builds: the advert (utxo_info, through the vendored readAdvert) and the transaction
// that created it (tx_info, the check that the supplier key signed it). Shaped after the koiosFake of the mcp-server's
// marketplace-build.test.ts at 651ae93; the advert is the live ChandraOCR advert of marketplace.fixture.ts. Not a vendored fixture, so it
// lives outside test/fixtures/ (every file there needs a row in VENDORED-FROM.md).
import { ADVERT_ADDRESS } from '../src/vendored/mcp/marketplace-constants.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF } from './fixtures/marketplace.fixture.ts';
import { SUPPLIER_ADDRESS } from './fixtures/escrow-koios.fixture.ts';
import type { KoiosFake } from './fixtures/escrow-koios.fixture.ts';

export const ADVERT_TX = ADVERT_REF.slice(0, 64);

/**
 * utxo_info answers with the advert output (unspent unless `spent`), or with `rows` as given; tx_info answers that the creating transaction
 * spent inputs of the credentials `inputCreds` (the supplier key by default). Every call is recorded with its URL.
 */
export function advertKoios(opts: { spent?: boolean; inputCreds?: string[]; rows?: unknown[] } = {}): KoiosFake {
  const calls: KoiosFake['calls'] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const path = '/' + new URL(url).pathname.split('/').slice(-3).join('/');
    calls.push({ path, body, url });
    if (path === '/api/v1/utxo_info') {
      const advert = { tx_hash: ADVERT_TX, tx_index: 0, address: ADVERT_ADDRESS, value: '2000000', is_spent: opts.spent ?? false, inline_datum: { bytes: ADVERT_DATUM_HEX } };
      return new Response(JSON.stringify(opts.rows ?? [advert]), { status: 200 });
    }
    if (path === '/api/v1/tx_info') {
      const creds = opts.inputCreds ?? [ADVERT_EXPECTED.supplier_pkh];
      const inputs = creds.map((cred, i) => ({ tx_hash: 'cc'.repeat(32), tx_index: i, payment_addr: { bech32: SUPPLIER_ADDRESS, cred }, stake_addr: null }));
      return new Response(JSON.stringify([{ tx_hash: ADVERT_TX, inputs }]), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
