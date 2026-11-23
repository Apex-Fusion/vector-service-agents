// agents/order-desk/test/checks/support.ts
// The world of the tests of the hook. It joins three fixtures of the repo: the stub gateway of id-kit (the sender and its DID resolution), the ledger world of buyer-core (the delegation, the records and the
// attestation, read by the real read code over an offline node and a fake Koios) and a payment from a vault that was captured from a ledger. No test here touches the network. A test builds a world with
// `makeWorld`, changes one thing, and expects one refusal. The same world with no change is the accepted twin.
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import type { JobContext } from '@vsa/service-kit';
import { ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { APPROVAL_ATT_TYPE, HANDOFF_SCHEMA, makeProposal } from '@vsa/usecase-kit/protocol';
import type { Handoff, JsonValue, Proposal } from '@vsa/usecase-kit/protocol';
import type { AttestationDatum, DelegationDatum, IdentityDatum } from '@vsa/vector-read/identity-codec';
import {
  CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, attestation, attestationUtxo, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { ADVERT_REF, OTHER_DID, purchaseOrder } from './samples.ts';

export { ISSUER_KEY };
export const HOUR = 3_600_000;
/** The time of the checks: a minute after the tip of the capture. */
export const T = CAPTURE_MS + 60_000;
export const ATTESTATION_ID = '88'.repeat(32);
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const ESCROW_REF = CAPTURE.payment.escrow_ref;
/** An escrow that a wallet paid and no vault: the payment that the check of the vault refuses. */
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;
/** The id of an issuer record, and the DID of that record. */
export const ISSUER_ID = 'e1'.repeat(32);

/** The proposal for a purchase order of the samples with members replaced: its document, its salt and the digest that a hirer approves. */
export function proposalOf(order: Readonly<Record<string, JsonValue>> = {}): Proposal {
  const made = makeProposal(purchaseOrder(order));
  if (!made.ok) throw new Error(made.detail);
  return made.value;
}

export interface WorldOptions {
  /** The organisation that the Accountable Party of the sender names. The default is a verified one. Null gives a record with no organisation. */
  organisation?: { domain: string; verified?: boolean } | null;
  /** Changes the delegation of the world; null leaves it out. */
  delegation?: Partial<DelegationDatum> | null;
  /** Changes the record of the sender on the ledger (the delegate of the delegation); null leaves it out. */
  delegateRecord?: Partial<IdentityDatum> | null;
  /** Changes the approval; null leaves it out. */
  attestation?: Partial<AttestationDatum> | null;
  /** Adds the record of the issuer (the record of ISSUER_ID) with these changes. */
  issuerRecord?: Partial<IdentityDatum>;
  /** Members of the purchase order that replace those of the samples. The approval is for the document that this gives. */
  order?: Readonly<Record<string, JsonValue>>;
}

export interface World {
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  readonly delegateKey: TestKey;
  readonly ledger: LedgerWorld;
  /** The source and the cause of each fault that the checks reported. */
  readonly faults: Array<[string, unknown]>;
  readonly ports: ChecksPorts;
  readonly proposal: Proposal;
  /** What the runtime says about the escrow: the captured payment from a vault, the advert of the samples and the medium lot, and the delegation key as the buyer key. */
  readonly context: JobContext;
  /** The handoff that the sender sends: the approved purchase order, its salt and the reference of the approval. */
  readonly handoff: Handoff;
}

/**
 * A world in which every check of the hook passes. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the ledger holds its record. The
 * root delegator is the key that issued the approval. The approval is for the purchase order, it is valid for four hours, and the escrow was paid from a vault of the delegation. The purchase order names the
 * Order Desk, the advert and the lot of the context, and the size of that lot.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const gateway = createStubGateway({ now: () => CAPTURE_MS - 40 * DAY });
  const delegateKey = ed25519Key('order desk test: the delegate key');
  const organisation = over.organisation === undefined ? { domain: 'buyer.example', verified: true } : over.organisation ?? undefined;
  const sender = gateway.createAgent({ label: 'order desk test sender', delegation: delegateKey, ...(organisation === undefined ? {} : { organisation }) });
  const proposal = proposalOf(over.order);
  const issuerId = over.attestation?.issuerId ?? null;

  const utxos = [
    ...(over.delegation === null ? [] : [delegationUtxo(DELEGATION_ID, delegation({
      delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null }, ...over.delegation,
    }))]),
    ...(over.delegateRecord === null ? [] : [recordUtxo(sender.id, liveRecord(over.delegateRecord ?? {}, [delegateKey.publicKeyHex]))]),
    ...(over.issuerRecord === undefined ? [] : [recordUtxo(ISSUER_ID, liveRecord(over.issuerRecord))]),
    ...(over.attestation === null ? [] : [attestationUtxo(ATTESTATION_ID, attestation({
      subject: sender.id, attType: APPROVAL_ATT_TYPE, digest: proposal.proposal_digest, issuedAt: T - HOUR, validFrom: null, validUntil: T + 4 * HOUR, ...over.attestation,
    }))]),
  ];
  const ledger = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx] });

  const faults: Array<[string, unknown]> = [];
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const ports: ChecksPorts = { clock: () => T, gateway: client, ledger: ledgerPortOf(ledger.env), onFault: (source, cause) => { faults.push([source, cause]); } };
  const context: JobContext = { escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'lot-medium', buyerPkh: delegateKey.keyHash, paymentLovelace: 5_000_000n, deliverByMs: T + 300_000 };
  // The reference names the issuer record that the attestation names, when it names one.
  const approval = { attestation: ATTESTATION_ID, issuer_did: issuerId === null ? OTHER_DID : `did:vector:${issuerId}` };
  const handoff: Handoff = { schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: sender.did, delegation: DELEGATION_ID, document: proposal.document, salt: proposal.salt, approval };
  return { gateway, sender, delegateKey, ledger, faults, ports, proposal, context, handoff };
}

/** The same world, with the port of the ledger replaced by one that fails or answers as the test says. */
export const withLedger = (world: World, ledger: Partial<ChecksPorts['ledger']>): ChecksPorts => ({ ...world.ports, ledger: { ...world.ports.ledger, ...ledger } });

/** A rejection the way a failed network call rejects: its message names a host and holds a secret, and no answer may repeat it. */
export const failing = (): Promise<never> => Promise.reject(new TypeError('fetch failed: https://koios.example/api/v1/tx_info?key=secret-token-123'));
