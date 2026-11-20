// packages/usecase-kit/test/checks/support.ts
// The world of the tests of the checks. It joins three fixtures of the repo: the stub gateway of id-kit (the sender and its DID resolution), the ledger world of buyer-core (the delegation, the
// records and the attestation, read by the real read code over an offline node and a fake Koios) and a payment from a vault that was captured from mainnet. No test here touches the network.
// A test builds a world with `makeWorld`, changes one thing, and expects one refusal. The same world with no change is the accepted twin.
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import type { JobContext } from '@vsa/service-kit';
import type { UTxO } from '@lucid-evolution/lucid';
import type { AttestationDatum, DelegationDatum, IdentityDatum } from '@vsa/vector-read/identity-codec';
import {
  CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, MAINNET, attestation, attestationUtxo, callsTo, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo,
} from '../../../buyer-core/test/fixtures/ledger-read-world.ts';
import type { KoiosOptions, LedgerWorld } from '../../../buyer-core/test/fixtures/ledger-read-world.ts';
import { ledgerPortOf } from '../../src/checks/index.ts';
import type { ChecksPorts } from '../../src/checks/index.ts';
import { APPROVAL_ATT_TYPE, HANDOFF_SCHEMA, RFQ_SCHEMA, makeProposal } from '../../src/protocol/index.ts';
import type { ApprovalInput, Document, Handoff, Proposal, RfqMessage } from '../../src/protocol/index.ts';

export { CAPTURE, DAY, ISSUER_KEY, MAINNET, attestation, attestationUtxo, callsTo, delegation, delegationUtxo, liveRecord, recordUtxo };
export const HOUR = 3_600_000;
/** The time of the checks: a minute after the tip of the capture. */
export const T = CAPTURE_MS + 60_000;
export const ATTESTATION_ID = '88'.repeat(32);
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const ESCROW_REF = CAPTURE.payment.escrow_ref;
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
/** An issuer that has a record: the root delegator of the agent-root worlds, and the issuer record of an attestation. */
export const ISSUER_ID = 'e1'.repeat(32);
export const ISSUER_DID = `did:vector:${ISSUER_ID}`;
export const OTHER_DID = `did:vector:${'f2'.repeat(32)}`;
export const DOCUMENT: Document = { schema: 'vector.usecase.po.v1', po_number: 'run1-0001', sku: 'SKU-100', lot: 'lot-medium', quantity: 50, supplier_did: OTHER_DID };

export const proposalOf = (document: Document = DOCUMENT): Proposal => {
  const made = makeProposal(document);
  if (!made.ok) throw new Error(made.detail);
  return made.value;
};

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
  /** More outputs on the node, for example a parent delegation. */
  extraUtxos?: UTxO[];
  koios?: KoiosOptions;
  document?: Document;
}

export interface World {
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  readonly delegateKey: TestKey;
  readonly ledger: LedgerWorld;
  readonly faults: Array<[string, unknown]>;
  readonly ports: ChecksPorts;
  readonly proposal: Proposal;
  readonly context: JobContext;
  /** The handoff that the sender sends: the approved document, its salt and the reference of the approval. */
  readonly handoff: Handoff;
  readonly rfq: RfqMessage;
  /** The input of the approval check for the handoff. */
  readonly approvalInput: ApprovalInput;
}

/**
 * A world in which every check passes. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the ledger holds its record. The
 * root delegator is the key that issued the approval. The approval is for the proposal, it is valid for four hours, and the escrow was paid from a vault of the delegation.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const gateway = createStubGateway({ now: () => CAPTURE_MS - 40 * DAY });
  const delegateKey = ed25519Key('checks test: the delegate key');
  const organisation = over.organisation === undefined ? { domain: 'buyer.example', verified: true } : over.organisation ?? undefined;
  const sender = gateway.createAgent({ label: 'checks test sender', delegation: delegateKey, ...(organisation === undefined ? {} : { organisation }) });
  const proposal = proposalOf(over.document);

  const utxos: UTxO[] = [...(over.extraUtxos ?? [])];
  if (over.delegation !== null) {
    utxos.push(delegationUtxo(DELEGATION_ID, delegation({ delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null }, ...over.delegation })));
  }
  if (over.delegateRecord !== null) utxos.push(recordUtxo(sender.id, liveRecord(over.delegateRecord ?? {}, [delegateKey.publicKeyHex])));
  if (over.issuerRecord !== undefined) utxos.push(recordUtxo(ISSUER_ID, liveRecord(over.issuerRecord)));
  if (over.attestation !== null) {
    utxos.push(attestationUtxo(ATTESTATION_ID, attestation({
      subject: sender.id, attType: APPROVAL_ATT_TYPE, digest: proposal.proposal_digest, issuedAt: T - HOUR, validFrom: null, validUntil: T + 4 * HOUR, ...over.attestation,
    })));
  }
  const ledger = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx], ...over.koios });

  const faults: Array<[string, unknown]> = [];
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const ports: ChecksPorts = { clock: () => T, gateway: client, ledger: ledgerPortOf(ledger.env), onFault: (source, cause) => { faults.push([source, cause]); } };
  const context: JobContext = { escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'lot-medium', buyerPkh: delegateKey.keyHash, paymentLovelace: 5_000_000n, deliverByMs: T + 300_000 };
  const approval = { attestation: ATTESTATION_ID, issuer_did: OTHER_DID };
  const handoff: Handoff = {
    schema: HANDOFF_SCHEMA, use_case: 'inventory-reorder', sender_did: sender.did, delegation: DELEGATION_ID, document: proposal.document, salt: proposal.salt, approval,
  };
  const rfq: RfqMessage = { schema: RFQ_SCHEMA, sender_did: sender.did, delegation: DELEGATION_ID, rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 10 }] } };
  const approvalInput: ApprovalInput = { approval, sender_did: sender.did, delegation: DELEGATION_ID, document: proposal.document, salt: proposal.salt, now_ms: T };
  return { gateway, sender, delegateKey, ledger, faults, ports, proposal, context, handoff, rfq, approvalInput };
}

/** The same world, with the port of the ledger replaced by one that fails or answers as the test says. */
export const withLedger = (world: World, ledger: Partial<ChecksPorts['ledger']>): ChecksPorts => ({ ...world.ports, ledger: { ...world.ports.ledger, ...ledger } });

/** A rejection the way a failed network call rejects. */
export const failing = (): Promise<never> => Promise.reject(new TypeError('fetch failed: https://koios.example/api/v1/tx_info?key=secret-token-123'));
