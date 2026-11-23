// agents/order-desk/test/serve/world.ts
// The world of the tests of the service over HTTP. It joins the fixtures of the repo: the stub gateway of id-kit (the sender, the Order Desk itself and the X.509-SVID), the ledger world of buyer-core (the
// delegation, the records and the approval, read by the real read code over an offline node and a fake Koios), the stub marketplace of hire-kit (a FakeChain whose wallet is the service key, the indexer and a
// model supplier), the fake supplier portal of the tests of the job, and a scripted Module-1 port. One clock drives all of them: the clock of the marketplace. No test uses the network.
import { createPublicKey } from 'node:crypto';
import { resolveKey } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { ALLOWLIST, INDEXER, LLM_ADVERT, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import { CONTEXT_HEADERS } from '@vsa/service-kit';
import type { JobContext } from '@vsa/service-kit';
import { claimDocument } from '@vsa/usecase-kit/dispute';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';
import { INVENTORY_CAPABILITIES, PO_SCHEMA, REORDER_CLAIM } from '@vsa/usecase-kit/inventory';
import { APPROVAL_ATT_TYPE, HANDOFF_SCHEMA, makeProposal } from '@vsa/usecase-kit/protocol';
import type { Handoff, JsonValue, Proposal } from '@vsa/usecase-kit/protocol';
import type { AttestationDatum } from '@vsa/vector-read/identity-codec';
import {
  CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, attestation, attestationUtxo, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { MANIFEST_SHA, ScriptedPort, claimView, escrowJob } from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { Portal } from '../job/rig.ts';
import type { StartOptions } from '../../src/serve/start.ts';
import { SERVICE, envWith, tempDir } from './support.ts';

export const HOUR = 3_600_000;
/** The time of the world: a minute after the tip of the captured ledger. */
export const T = CAPTURE_MS + 60_000;
export const ATTESTATION_ID = '88'.repeat(32);
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const ESCROW_REF = CAPTURE.payment.escrow_ref;
/** An escrow that a wallet paid and no vault. */
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const OTHER_ADVERT_REF = `${'d5'.repeat(32)}#1`;
export const LABEL = 'order desk service test: the order desk';
/** The DID of the Order Desk in the stub gateway. A label fixes the identifier of a stub agent, so it is known before the gateway is made. */
export const DESK_DID: string = createStubGateway().createAgent({ label: LABEL }).did;
const DESK_ID = DESK_DID.slice('did:vector:'.length);

/** The service key as a key of the stub gateway: the key that signs the request of the Order Desk for its X.509-SVID is an authentication key of its DID. */
function serviceTestKey(): TestKey {
  const privateKey = keyObjectOfRawKey(SERVICE.privateKeyHex);
  const resolved = resolveKey(privateKey);
  return { kind: resolved.kind, privateKey, publicKey: createPublicKey(privateKey), jwk: resolved.jwk, publicKeyHex: resolved.publicKey, keyHash: resolved.keyHash, thumbprint: resolved.thumbprint };
}

const PURCHASE_ORDER = {
  schema: PO_SCHEMA, po_number: 'run1-0001', tenant: 'run1', sku: 'GLV-NIT-M', lot: 'lot-medium', quantity: 50, needed_by: '2026-12-05', supplier_did: DESK_DID, advert_ref: ADVERT_REF,
  stock_reading_sha256: 'ab'.repeat(32),
} as const;

/** The proposal for a purchase order of the world, with members replaced: its document, its salt and the digest that a hirer approves. */
export function proposalOf(order: Readonly<Record<string, JsonValue>> = {}): Proposal {
  const made = makeProposal({ ...PURCHASE_ORDER, ...order });
  if (!made.ok) throw new Error(made.detail);
  return made.value;
}

/** What the model says when it confirms the order. */
export const CONFIRMS = JSON.stringify({ reasoning: 'The catalogue shows 5000 boxes and the lot needs 50, so the order can ship.', choice: { confirm: true, ship_by: '2026-11-28', note: 'The catalogue holds enough boxes for this lot.' } });
/** What the model says when it does not confirm the order. */
export const DECLINES = JSON.stringify({ reasoning: 'The catalogue holds too few boxes.', choice: { confirm: false, ship_by: '2026-11-28', note: 'The catalogue holds too few boxes for this lot.' } });

/** The values that a test of the world changes. */
export interface WorldOptions {
  /** Members of the purchase order that replace those of the world. The approval is for the order that this gives. */
  readonly order?: Readonly<Record<string, JsonValue>>;
  /** Changes the approval on the ledger. */
  readonly attestation?: Partial<AttestationDatum>;
  /** The setting of the fault switch. */
  readonly fault?: string;
  /** Settings that replace those of the environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface World {
  /** The marketplace of the model hire. Its clock is the clock of the world. */
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  readonly desk: StubAgent;
  readonly delegateKey: TestKey;
  readonly ledger: LedgerWorld;
  readonly proposal: Proposal;
  /** The handoff that the sender sends: the approved purchase order, its salt and the reference of the approval. */
  readonly handoff: Handoff;
  /** What the runtime says about the escrow: the captured payment from a vault, the advert and the medium lot, and the delegation key as the buyer key. */
  readonly context: JobContext;
  readonly portal: Portal;
  /** The scripted Module-1 port of the dispute code. */
  readonly port: DeskPort;
  /** The environment of the service. The listener is on a port that the system picks, and the state directory is new. */
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  /** What the service is given in place of its real parts. */
  readonly options: StartOptions;
  readonly logs: string[];
  /** Makes the model supplier wait before it answers, and tells when a call has reached it. */
  holdModel(): { readonly reached: Promise<void>; readonly release: () => void };
  /** The sender has one open claim for the Reorder Agent, so that a challenge for a digest mismatch finds its target. */
  armChallenge(): void;
}

/** The scripted port, with this agent as the agent of the dispute code: the Order Desk and its service key. */
export class DeskPort extends ScriptedPort {
  override readonly agent = { did: DESK_DID, key_hash: SERVICE.pkh };
}

/**
 * A world in which every check of the hook passes and the job places its order. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the
 * ledger holds its record. The root delegator is the key that issued the approval, and the approval is for the purchase order. The escrow was paid from a vault of the delegation. The purchase order names the
 * Order Desk, the advert and the lot of the context, and the size of that lot. The model confirms.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const m = marketplace({ t0: T, buyerPkh: SERVICE.pkh, listed: ['llm'] });
  m.llm.answer = CONFIRMS;
  const gateway = createStubGateway({ now: () => m.clock.now });
  const delegateKey = ed25519Key('order desk service test: the delegate key');
  const sender = gateway.createAgent({ label: 'order desk service test: the sender', delegation: delegateKey, organisation: { domain: 'buyer.example', verified: true } });
  const desk = gateway.createAgent({ label: LABEL, authentication: serviceTestKey() });
  if (desk.did !== DESK_DID) throw new Error('the stub gateway gave another DID to the Order Desk');
  const proposal = proposalOf(over.order);
  const issuerId = over.attestation?.issuerId ?? null;
  const utxos = [
    delegationUtxo(DELEGATION_ID, delegation({ delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null } })),
    recordUtxo(sender.id, liveRecord({}, [delegateKey.publicKeyHex])),
    attestationUtxo(ATTESTATION_ID, attestation({
      subject: sender.id, attType: APPROVAL_ATT_TYPE, digest: proposal.proposal_digest, issuedAt: T - HOUR, validFrom: null, validUntil: T + 4 * HOUR, ...over.attestation,
    })),
  ];
  const ledger = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx] });
  const context: JobContext = { escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'lot-medium', buyerPkh: delegateKey.keyHash, paymentLovelace: 5_000_000n, deliverByMs: T + 300_000 };
  const approval = { attestation: ATTESTATION_ID, issuer_did: issuerId === null ? `did:vector:${'f2'.repeat(32)}` : `did:vector:${issuerId}` };
  const handoff: Handoff = { schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: sender.did, delegation: DELEGATION_ID, document: proposal.document, salt: proposal.salt, approval };

  const events: string[] = [];
  const portal = new Portal(events);
  const port = new DeskPort();
  const logs: string[] = [];
  const stateDir = tempDir();
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  let gate: { reached: () => void; open: Promise<void> } | null = null;
  const routed: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === gatewayOrigin) return gateway.fetch(input, init);
    if (gate !== null && url.pathname === '/v1/responses' && init?.method === 'POST') {
      gate.reached();
      await gate.open;
    }
    return m.fetchImpl(input, init);
  };
  const env = envWith({
    AGENT_DID: DESK_DID, PORT: '0', HOST: '127.0.0.1', ORDER_DESK_STATE_DIR: stateDir, IDENTITY_GATEWAY_URL: gateway.baseUrl, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER,
    LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), LLM_MAX_PRICE_LOVELACE: String(LLM_ADVERT.price_lovelace), LLM_MAX_SUPPLIER_BOND_LOVELACE: String(LLM_ADVERT.supplier_bond_lovelace),
    LLM_MAX_BUYER_BOND_LOVELACE: String(LLM_ADVERT.buyer_bond_lovelace), FAULT_MODE: over.fault ?? '', ...over.env,
  });
  // The hire waits `ms` by moving the clock of the world, after a turn of the event loop. A wait of 20 s or more never ends: it is the bound of a read of the dispute code, and a read that the file system
  // answers in a later turn must not lose to it.
  const sleep = (ms: number): Promise<void> => (ms >= 20_000 ? new Promise<void>(() => undefined) : new Promise<void>((resolve) => { setImmediate(() => { m.clock.now += ms; resolve(); }); }));
  const options: StartOptions = {
    createChain: async () => m.chain, fetchImpl: routed, clock: () => m.clock.now, sleep, log: (line) => { logs.push(line); }, transport: portal.transport, ledgerEnv: ledger.env, module1Port: port,
    janitorIntervalMs: 3_600_000,
  };
  return {
    m, gateway, sender, desk, delegateKey, ledger, proposal, handoff, context, portal, port, env, stateDir, options, logs,
    holdModel: () => {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const open = new Promise<void>((resolve) => { release = resolve; });
      gate = { reached, open };
      return { reached: arrived, release };
    },
    armChallenge: () => {
      const document = claimDocument({ agent_did: sender.did, capability_id: INVENTORY_CAPABILITIES.reorder, manifest_sha256: MANIFEST_SHA, claim: REORDER_CLAIM });
      if (!document.ok) throw new Error(document.detail);
      const claim = claimView({ claimer: sender.did, submitted_at: T - HOUR });
      port.documents.set(claim.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: 'text/plain' });
      port.claims = [{ ...claim, claim_hash: document.value.hash }];
      port.readEscrowAnswer = () => escrowJob({ agent_id: DESK_ID, buyer_pkh: context.buyerPkh, block_time_ms: T - 30 * 60_000 });
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

export { DAY };
