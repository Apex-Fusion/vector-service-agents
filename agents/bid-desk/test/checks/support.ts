// agents/bid-desk/test/checks/support.ts
// The world of the tests of the hook. It joins three fixtures of the repo: the stub gateway of id-kit (the sender and its DID resolution), the ledger world of buyer-core (the delegation and the records, read
// by the real read code over an offline node and a fake Koios) and a payment from a vault that was captured from a ledger. No test here touches the network. A test builds a world with `makeWorld`, changes one
// thing, and expects one refusal. The same world with no change is the accepted twin. The Bid Desk takes no approval, so the world holds no attestation.
import { createGatewayClient } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import type { JobContext } from '@vsa/service-kit';
import { BID_DESK_MODEL } from '@vsa/usecase-kit/bids';
import { ledgerPortOf } from '@vsa/usecase-kit/checks';
import type { ChecksPorts } from '@vsa/usecase-kit/checks';
import { RFQ_SCHEMA } from '@vsa/usecase-kit/protocol';
import type { JsonValue, RfqMessage } from '@vsa/usecase-kit/protocol';
import type { DelegationDatum, IdentityDatum } from '@vsa/vector-read/identity-codec';
import { CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import type { LedgerWorld } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { ADVERT_REF, rfqOf } from './samples.ts';

/** The time of the checks: a minute after the tip of the capture. */
export const T = CAPTURE_MS + 60_000;
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const PAID_ESCROW_REF = CAPTURE.payment.escrow_ref;
/** An escrow that a wallet paid and no vault: the payment that the check of the vault refuses. */
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;

export interface WorldOptions {
  /** The organisation that the Accountable Party of the sender names. The default is a verified one. Null gives a record with no organisation. */
  organisation?: { domain: string; verified?: boolean } | null;
  /** Changes the delegation of the world; null leaves it out. */
  delegation?: Partial<DelegationDatum> | null;
  /** Changes the record of the sender on the ledger (the delegate of the delegation); null leaves it out. */
  delegateRecord?: Partial<IdentityDatum> | null;
  /** Members of the request for quotation that replace those of the samples. */
  rfq?: Readonly<Record<string, JsonValue>>;
}

export interface World {
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  /** The Bid Desk itself, as an agent of the gateway. The hook never resolves it: a test changes its record and sees that no answer changes. */
  readonly desk: StubAgent;
  readonly delegateKey: TestKey;
  readonly ledger: LedgerWorld;
  /** The source and the cause of each fault that the checks reported. */
  readonly faults: Array<[string, unknown]>;
  readonly ports: ChecksPorts;
  /** What the runtime says about the escrow: the captured payment from a vault, the advert of the samples, and the delegation key as the buyer key. */
  readonly context: JobContext;
  /** The message that the sender sends: the request for quotation of the samples, with the delegation of the captured payment. */
  readonly rfq: RfqMessage;
}

/**
 * A world in which every check of the hook passes. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the ledger holds its record. The
 * escrow was paid from a vault of the delegation. The request names a sender, an identifier that the book does not hold, and SKUs.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const gateway = createStubGateway({ now: () => CAPTURE_MS - 40 * DAY });
  const delegateKey = ed25519Key('bid desk test: the delegate key');
  const organisation = over.organisation === undefined ? { domain: 'buyer.example', verified: true } : over.organisation ?? undefined;
  const sender = gateway.createAgent({ label: 'bid desk test sender', delegation: delegateKey, ...(organisation === undefined ? {} : { organisation }) });
  const desk = gateway.createAgent({ label: 'bid desk test desk' });

  const utxos = [
    ...(over.delegation === null ? [] : [delegationUtxo(DELEGATION_ID, delegation({
      delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null }, ...over.delegation,
    }))]),
    ...(over.delegateRecord === null ? [] : [recordUtxo(sender.id, liveRecord(over.delegateRecord ?? {}, [delegateKey.publicKeyHex]))]),
  ];
  const ledger = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx] });

  const faults: Array<[string, unknown]> = [];
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const ports: ChecksPorts = { clock: () => T, gateway: client, ledger: ledgerPortOf(ledger.env), onFault: (source, cause) => { faults.push([source, cause]); } };
  const context: JobContext = { escrowRef: PAID_ESCROW_REF, advertRef: ADVERT_REF, advertModel: BID_DESK_MODEL, buyerPkh: delegateKey.keyHash, paymentLovelace: 5_000_000n, deliverByMs: T + 300_000 };
  const rfq: RfqMessage = { schema: RFQ_SCHEMA, sender_did: sender.did, delegation: DELEGATION_ID, rfq: rfqOf(over.rfq) };
  return { gateway, sender, desk, delegateKey, ledger, faults, ports, context, rfq };
}

/** The same world, with the port of the ledger replaced by one that fails or answers as the test says. */
export const withLedger = (world: World, ledger: Partial<ChecksPorts['ledger']>): ChecksPorts => ({ ...world.ports, ledger: { ...world.ports.ledger, ...ledger } });

/** A rejection the way a failed network call rejects: its message names a host and holds a secret, and no answer may repeat it. */
export const failing = (): Promise<never> => Promise.reject(new TypeError('fetch failed: https://koios.example/api/v1/tx_info?key=secret-token-123'));
