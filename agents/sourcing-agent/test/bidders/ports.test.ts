// agents/sourcing-agent/test/bidders/ports.test.ts
// The ports of the bidder reader against the real readers that fill them, and the file of a bidder whose record a stub gateway serves through the real client. The first test proves, with the typecheck, that the
// types of the real readers fit the ports. No test here uses the network: the stub gateway answers through its own fetch function.
import { describe, expect, test } from 'vitest';
import { VECTOR_KOIOS_URL, fetchSuppliers, readAdvert } from '@vsa/buyer-core';
import type { IdentityDeployment } from '@vsa/buyer-core';
import { createGatewayClient } from '@vsa/id-kit/client';
import type { GatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import { safeFetch } from '@vsa/vector-read';
import { parseArdCatalog } from '../../src/bidders/catalog.ts';
import { readBidders } from '../../src/bidders/file.ts';
import type { BiddersDeps } from '../../src/bidders/types.ts';
import { addDesk, deskOf, emptyWorld, must, refusal, stubOf } from './support.ts';
import type { Desk } from './support.ts';

const EMPTY_LINEAGE = { hold_until: null, ended_at: null, invalid_from: null, successor: null, recovery_pending: false };

describe('the ports of the reader and the real readers', () => {
  test('has the ports that the real readers fit: the indexer and the chain reader of buyer-core, the fetch of vector-read behind a function that makes bytes, and the client of the gateway', () => {
    // The function is made and never called: the typecheck proves that the types of the real readers fit the ports, and no test here uses the network.
    const wiring = (deployment: IdentityDeployment, fetchImpl: typeof fetch, client: GatewayClient): BiddersDeps => ({
      listAdverts: (capabilityId) => fetchSuppliers({ capability_id: capabilityId, fetchImpl }),
      // Without the identity advert address of the deployment, buyer-core gives `{ error }` for every advert of a Bid Desk.
      readAdvert: (ref) => readAdvert(ref, fetchImpl, VECTOR_KOIOS_URL, deployment.advert.address),
      fetchBytes: async (url, limits) => {
        const answer = await safeFetch(url, {}, { maxResponseBytes: limits.maxBytes, timeoutMs: limits.timeoutMs });
        return { status: answer.status, bytes: Buffer.from(answer.text, 'utf8') };
      },
      resolve: async (did) => {
        const answer = await client.resolve(did);
        if (!answer.ok) throw new Error('the gateway gave no answer');
        return answer.value;
      },
      catalog: async () => {
        const answer = await safeFetch(`${client.baseUrl}/.well-known/ard.json`, {}, { maxResponseBytes: 4_000_000, timeoutMs: 10_000 });
        const catalog = parseArdCatalog(Buffer.from(answer.text, 'utf8'));
        return answer.status === 200 && catalog.ok ? catalog.value : null;
      },
      stake: async () => ({ ok: false }),
      cases: async () => ({ ok: false }),
      compliance: async () => ({ state: 'unreadable', attestation: null, attestation_state: null, issued_at: null, valid_until: null, revoked_at: null, revoke_reason: null, contested: null }),
      credential: async () => 'unreadable',
      clock: () => Date.now(),
    });
    expect(wiring.length).toBe(3);
  });
});

describe('the file of a bidder whose record the stub gateway serves', () => {
  /**
   * A world with one Bid Desk whose DID is the DID of an agent of the stub gateway, and the ports of the stub with the real client as the DID resolution. The record lists the supplier key of the advert with the
   * transaction purpose (the bit 8 of the stub), unless `purposes` says another set.
   */
  function setup(options: { verified?: boolean; purposes?: number } = {}) {
    const gateway = createStubGateway();
    const supplier = ed25519Key('bid-desk-bravo-supplier');
    const agent = gateway.createAgent({
      label: 'bid-desk-bravo',
      name: 'Bid Desk Bravo',
      organisation: { domain: 'bravo.example.org', verified: options.verified ?? true },
      keys: [{ key: supplier, purposes: options.purposes ?? 8 }],
    });
    const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
    const desk: Desk = { ...deskOf('bravo'), agent: agent.id, did: agent.did, pkh: supplier.keyHash };
    const world = emptyWorld();
    addDesk(world, desk);
    world.catalog = new Set([desk.did]);
    const stub = stubOf(world);
    const resolve: BiddersDeps['resolve'] = async (did) => {
      const answer = await client.resolve(did);
      if (!answer.ok) throw new Error('the gateway gave no answer');
      return answer.value;
    };
    const deps: BiddersDeps = { ...stub.deps, resolve, clock: () => gateway.now() };
    return { gateway, agent, desk, deps };
  }

  test('gives the status, the organisation and its verification of an Active record, as the real client reads them', async () => {
    const { deps } = setup();
    const file = must(await readBidders(deps)).bidders[0]!.file;
    expect(file).toMatchObject({ status: 'active', status_reason: null, lineage: EMPTY_LINEAGE, organisation: 'bravo.example.org', organisation_verified: true });
    // The record of the stub names the controller as its Accountable Party, and the controller is no key hash.
    expect(file.accountable).toBeNull();
  });

  test('gives no organisation, and not verified, for an organisation that the gateway did not verify', async () => {
    const { deps } = setup({ verified: false });
    const file = must(await readBidders(deps)).bidders[0]!.file;
    expect(file.organisation).toBeNull();
    expect(file.organisation_verified).toBe(false);
  });

  test('gives a Bid Desk whose record lists the supplier key with the transaction purpose a file, and one whose record lists it with another purpose no file', async () => {
    expect(must(await readBidders(setup().deps)).bidders).toHaveLength(1);
    // The authentication purpose only (the bit 1 of the stub): every read worked and nobody passes.
    expect(refusal(await readBidders(setup({ purposes: 1 }).deps)).code).toBe('no_bidders');
  });

  test.each(['revoked', 'retired'] as const)('gives a record that ended the status %s, as the real client reads the answer 410, and no organisation', async (status) => {
    const { gateway, agent, deps } = setup();
    gateway.setStatus(agent, status);
    const file = must(await readBidders(deps)).bidders[0]!.file;
    expect(file).toMatchObject({ status, organisation: null, organisation_verified: false, accountable: null });
  });

  test('gives a suspended record the status suspended with the reason that the gateway gives', async () => {
    const { gateway, agent, deps } = setup();
    gateway.setStatus(agent, 'suspended');
    const file = must(await readBidders(deps)).bidders[0]!.file;
    expect(file.status).toBe('suspended');
    expect(file.organisation).toBe('bravo.example.org');
  });

  test.each([['a network that fails', 'network' as const], ['a gateway that answers 503', { status: 503, body: '{"error":"temporarily_unavailable"}', headers: { 'content-type': 'application/json' } }]])(
    'gives the status `unreadable` for %s, as the real client reports it, and keeps the bidder',
    async (_name, fault) => {
      const { gateway, agent, deps } = setup();
      gateway.fault(`/1.0/identifiers/${agent.did}`, fault);
      const result = must(await readBidders(deps));
      expect(result.bidders).toHaveLength(1);
      expect(result.bidders[0]!.file).toMatchObject({ status: 'unreadable', organisation: null, organisation_verified: false, lineage: EMPTY_LINEAGE });
      // The other sources are still read.
      expect(result.bidders[0]!.file).toMatchObject({ price_list: 'valid', credential: 'valid' });
    },
  );
});
