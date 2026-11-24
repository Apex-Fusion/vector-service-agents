// agents/bid-desk/test/serve/world.ts
// The world of the tests of the service over HTTP. It joins the fixtures of the repo: the stub gateway of id-kit (the sender, the Bid Desk itself and its credential), the ledger world of buyer-core (the
// delegation and the record of the sender, read by the real read code over an offline node and a fake Koios), and the stub marketplace of hire-kit (a FakeChain whose wallet is the service key, the indexer and a
// model supplier). One clock drives all of them: the clock of the marketplace. No test uses the network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buyerVaultDeployment } from '@vsa/buyer-core';
import { ALLOWLIST, INDEXER, LLM_ADVERT, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { CONTEXT_HEADERS } from '@vsa/service-kit';
import type { JobContext } from '@vsa/service-kit';
import { BID_DESK_MODEL, priceFor } from '@vsa/usecase-kit/bids';
import type { PriceList } from '@vsa/usecase-kit/bids';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import { RFQ_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { Document, JsonValue, RfqMessage } from '@vsa/usecase-kit/protocol';
import { CAPTURE, CAPTURE_MS, ISSUER_KEY, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { loadPriceList } from '../../src/checks/index.ts';
import { serviceKeyOf } from '../../src/serve/keys.ts';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import {
  agentDidOf, checksBudgetOf, endpointsFromEnv, faultOf, hostOf, instanceOf, limitsOf, organisationOf, portOf, priceListFileOf, stateDirOf, supplierKeyOf,
} from '../../src/serve/settings.ts';
import type { Instance } from '../../src/serve/settings.ts';
import type { ServiceConfig } from '../../src/serve/start.ts';
import type { WireOptions } from '../../src/serve/wiring.ts';
import { IDENTITY_SETTINGS, SERVICE, TOKEN, envOf } from './support.ts';

/** The time of the world: a minute after the tip of the captured ledger. */
export const T = CAPTURE_MS + 60_000;
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const ESCROW_REF = CAPTURE.payment.escrow_ref;
/** An escrow that a wallet paid and no vault. */
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const LABEL = 'bid desk service test: the bid desk';
/** The DID of the Bid Desk in the stub gateway. A label fixes the identifier of a stub agent, so it is known before the gateway is made. */
export const DESK_DID: string = createStubGateway().createAgent({ label: LABEL }).did;

/** The request for quotation of the world: three items, each SKU once, and each SKU on all three price lists. */
export const RFQ_VALUE: Document = {
  rfq_id: 'run1-rfq-1', items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 250 }, { sku: 'MSK-N95', quantity: 40 }], needed_by: '2026-12-20',
};

/** What a model says when it prices the request from the price list: one line for each item at the price and the lead time that the list gives for its quantity. */
export function answerOf(list: PriceList, rfq: Document = RFQ_VALUE): string {
  const items = rfq.items as Array<{ sku: string; quantity: number }>;
  const lines = items.map(({ sku, quantity }) => {
    const priced = priceFor(list, sku, quantity);
    if (priced === null) throw new Error(`the price list has no price for ${sku}`);
    return { sku, quantity, unit_price: priced.unit_price, lead_time_days: priced.lead_time_days };
  });
  return JSON.stringify({ reasoning: 'Each line takes the unit price of its break and the lead time of its SKU.', choice: { lines, valid_until: '2027-06-30', notes: 'Each line takes the unit price of its break.' } });
}

/** The values that a test of the world changes. */
export interface WorldOptions {
  /** Which Bid Desk this is: alfa by default. */
  readonly instance?: Instance;
  /** Members of the request for quotation that replace those of the world. */
  readonly rfq?: Readonly<Record<string, JsonValue>>;
  /** The setting of the fault switch. */
  readonly fault?: string;
  /** Settings that replace those of the environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface World {
  readonly instance: Instance;
  /** The marketplace of the model hire. Its clock is the clock of the world. */
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  /** The Bid Desk itself, as an agent of the gateway: the job asks for its credential. */
  readonly desk: StubAgent;
  readonly delegateKey: TestKey;
  readonly ledger: LedgerWorld;
  /** The message that the sender sends: the request for quotation and the delegation of the captured payment. */
  readonly message: RfqMessage;
  /** What the runtime says about the escrow: the captured payment from a vault, the advert and the model of the Bid Desk, and the delegation key as the buyer key. */
  readonly context: JobContext;
  /** The environment of the service. The listener is on a port that the system picks, and the state directory is new. */
  readonly env: NodeJS.ProcessEnv;
  readonly config: ServiceConfig;
  readonly stateDir: string;
  /** What the service is given in place of its real parts. */
  readonly options: WireOptions;
  readonly logs: string[];
  /** Makes the model supplier wait before it answers, and tells when a call has reached it. */
  holdModel(): { readonly reached: Promise<void>; readonly release: () => void };
}

const dirs: string[] = [];
/** A new empty directory, removed by `cleanDirs`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bid-desk-service-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/**
 * The configuration of the service for an environment, made from the readers of the settings: the manifest is rendered for each setting of the fault switch from an environment with no secret in it, and the
 * price list is the file of the instance.
 */
export function configOf(env: NodeJS.ProcessEnv): ServiceConfig {
  const instance = instanceOf(env);
  const priceList = loadPriceList(priceListFileOf(instance));
  const service = serviceKeyOf(SERVICE.privateKeyHex);
  const published: NodeJS.ProcessEnv = { ...env, BID_DESK_SERVICE_PRIV_KEY_HEX: undefined, SERVICE_AUTH_HEADER: undefined, BID_DESK_SERVICE_PKH: service.pkh };
  const rendered = renderManifest('bid-desk', (setting) => manifestFromEnv({ ...published, FAULT_MODE: setting }, { sha256: priceList.sha256 }));
  if (!rendered.ok) throw new Error(`the manifest of the world is refused (${rendered.code}): ${rendered.detail}`);
  return {
    manifest: rendered.value, authHeader: TOKEN, host: hostOf(env), port: portOf(env), stateDir: stateDirOf(env), fault: faultOf(env), instance, agentDid: agentDidOf(env), organisation: organisationOf(env),
    service: { privateKeyHex: SERVICE.privateKeyHex, pkh: service.pkh, address: service.address }, supplier: supplierKeyOf(env), limits: limitsOf(env), checksBudgetMs: checksBudgetOf(env),
    endpoints: endpointsFromEnv(env), identityDeployment: buyerVaultDeployment(env), priceList,
  };
}

/**
 * A world in which every check of the hook passes and the job gives its quote. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the
 * ledger holds its record. The escrow was paid from a vault of the delegation. The model prices the request from the price list of the instance.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const instance = over.instance ?? 'alfa';
  const m = marketplace({ t0: T, buyerPkh: SERVICE.pkh, listed: ['llm'] });
  const gateway = createStubGateway({ now: () => m.clock.now });
  const delegateKey = ed25519Key('bid desk service test: the delegate key');
  const sender = gateway.createAgent({ label: 'bid desk service test: the sender', delegation: delegateKey, organisation: { domain: 'buyer.example', verified: true } });
  const desk = gateway.createAgent({ label: LABEL });
  if (desk.did !== DESK_DID) throw new Error('the stub gateway gave another DID to the Bid Desk');
  const utxos = [
    delegationUtxo(DELEGATION_ID, delegation({ delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null } })),
    recordUtxo(sender.id, liveRecord({}, [delegateKey.publicKeyHex])),
  ];
  const ledger = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx] });
  const rfq: Document = { ...RFQ_VALUE, ...over.rfq };
  const message: RfqMessage = { schema: RFQ_SCHEMA, sender_did: sender.did, delegation: DELEGATION_ID, rfq };
  const context: JobContext = { escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: BID_DESK_MODEL, buyerPkh: delegateKey.keyHash, paymentLovelace: 3_000_000n, deliverByMs: T + 300_000 };

  const logs: string[] = [];
  const stateDir = tempDir();
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  let gate: { reached: () => void; open: Promise<void> } | null = null;
  // The gateway answers its own origin. Every other call goes to the model supplier or the marketplace.
  const routed: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === gatewayOrigin) return gateway.fetch(input, init);
    if (gate !== null && url.pathname === '/v1/responses' && init?.method === 'POST') {
      gate.reached();
      await gate.open;
    }
    return m.fetchImpl(input, init);
  };
  const env = envOf(instance, {
    ...IDENTITY_SETTINGS, AGENT_DID: DESK_DID, PORT: '0', HOST: '127.0.0.1', BID_DESK_STATE_DIR: stateDir, IDENTITY_GATEWAY_URL: gateway.baseUrl, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER,
    LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), LLM_MAX_PRICE_LOVELACE: String(LLM_ADVERT.price_lovelace), LLM_MAX_SUPPLIER_BOND_LOVELACE: String(LLM_ADVERT.supplier_bond_lovelace),
    LLM_MAX_BUYER_BOND_LOVELACE: String(LLM_ADVERT.buyer_bond_lovelace), FAULT_MODE: over.fault ?? '', ...over.env,
  });
  const config = configOf(env);
  m.llm.answer = answerOf(config.priceList.list, rfq);
  // The hire waits `ms` by moving the clock of the world, after a turn of the event loop.
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setImmediate(() => { m.clock.now += ms; resolve(); }); });
  const options: WireOptions = { createChain: async () => m.chain, fetchImpl: routed, clock: () => m.clock.now, sleep, log: (line) => { logs.push(line); }, ledgerEnv: ledger.env };
  return {
    instance, m, gateway, sender, desk, delegateKey, ledger, message, context, env, config, stateDir, options, logs,
    holdModel: () => {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const open = new Promise<void>((resolve) => { release = resolve; });
      gate = { reached, open };
      return { reached: arrived, release };
    },
  };
}

/** The six headers of the context, as the runtime writes them. */
export function headersOf(context: JobContext): Record<string, string> {
  return {
    [CONTEXT_HEADERS.escrowRef]: context.escrowRef,
    [CONTEXT_HEADERS.advertRef]: context.advertRef,
    [CONTEXT_HEADERS.advertModel]: encodeURIComponent(context.advertModel),
    [CONTEXT_HEADERS.buyerPkh]: context.buyerPkh,
    [CONTEXT_HEADERS.paymentLovelace]: String(context.paymentLovelace),
    [CONTEXT_HEADERS.deliverByMs]: String(context.deliverByMs),
  };
}

/** A message in the wire form that the runtime posts: a one-element array whose content is the request JSON as a text. */
export const wire = (request: unknown): string => JSON.stringify([{ content: typeof request === 'string' ? request : JSON.stringify(request), role: 'user' }]);
