// agents/insurer-intake-agent/test/serve/world.ts
// The world of the tests of the service over HTTP. It joins the fixtures of the repo: the stub gateway of id-kit (the sender, the Insurer Intake Agent itself and its JWT-SVID), the ledger world of buyer-core (the
// delegation, the records and the attestations, read by the real read code over an offline node and a fake Koios), the stub marketplace of hire-kit (a FakeChain whose wallet is the service key, the indexer and a
// model supplier), the fake insurer portal of the tests of the job, and a scripted Module-1 port. One clock drives all of them: the clock of the marketplace. No test uses the network, and every record is synthetic.
import { createPublicKey } from 'node:crypto';
import { resolveKey } from '@vsa/id-kit/client';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { ALLOWLIST, INDEXER, LLM_ADVERT, marketplace } from '@vsa/hire-kit/testing';
import type { Marketplace } from '@vsa/hire-kit/testing';
import type { LedgerEnv } from '@vsa/buyer-core';
import { CONTEXT_HEADERS } from '@vsa/service-kit';
import type { JobContext } from '@vsa/service-kit';
import { claimDocument } from '@vsa/usecase-kit/dispute';
import { keyObjectOfRawKey } from '@vsa/usecase-kit/live';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM } from '@vsa/usecase-kit/priorauth';
import { APPROVAL_ATT_TYPE, HANDOFF_SCHEMA, makeProposal } from '@vsa/usecase-kit/protocol';
import type { Handoff, JsonValue, Proposal } from '@vsa/usecase-kit/protocol';
import type { AttestationDatum, Party } from '@vsa/vector-read/identity-codec';
import { FixtureProvider } from '../../../../packages/buyer-core/test/fixtures/fixture-provider.ts';
import { CONTROLLER_ACCOUNTABLE, testKey } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import {
  CAPTURE, CAPTURE_MS, DAY, ISSUER_KEY, attestation, attestationUtxo, delegation, delegationUtxo, ledgerWorld, liveRecord, recordUtxo,
} from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { MANIFEST_SHA, ScriptedPort, claimView, escrowJob } from '../../../../packages/usecase-kit/test/dispute/support.ts';
import { Portal } from '../job/rig.ts';
import { BASES, PRIOR_REQUEST } from '../job/samples.ts';
import type { StartOptions } from '../../src/serve/start.ts';
import { SERVICE, startEnvWith, tempDir, withModule1 } from './support.ts';

export const HOUR = 3_600_000;
/** The time of the world: a minute after the tip of the captured ledger. */
export const T = CAPTURE_MS + 60_000;
/** The approval (type 5) and the three attestations that the report reads (types 1, 2 and 4), by id. */
export const ATTESTATION_ID = '88'.repeat(32);
export const PROVENANCE_ID = '81'.repeat(32);
export const SOFTWARE_ID = '82'.repeat(32);
export const BINDING_ID = '84'.repeat(32);
/** The delegation that the captured payment names, and the escrow that it made. */
export const DELEGATION_ID = CAPTURE.payment.delegation;
export const ESCROW_REF = CAPTURE.payment.escrow_ref;
/** An escrow that a wallet paid and no vault. */
export const PLAIN_ESCROW_REF = CAPTURE.plain_escrow.escrow_ref;
export const ADVERT_REF = `${'d4'.repeat(32)}#1`;
export const OTHER_ADVERT_REF = `${'d5'.repeat(32)}#1`;
export const LABEL = 'insurer intake service test: the insurer intake agent';
/** The DID of the Insurer Intake Agent in the stub gateway. A label fixes the identifier of a stub agent, so it is known before the gateway is made. */
export const INTAKE_DID: string = createStubGateway().createAgent({ label: LABEL }).did;
const INTAKE_ID = INTAKE_DID.slice('did:vector:'.length);
/** The key of the Provider of the sender: it issues the provenance and the software attestation. */
const PROVIDER_KEY = testKey(41);

/** The service key as a key of the stub gateway: the key that signs the request of the agent for its JWT-SVID is an authentication key of its DID. */
function serviceTestKey(): TestKey {
  const privateKey = keyObjectOfRawKey(SERVICE.privateKeyHex);
  const resolved = resolveKey(privateKey);
  return { kind: resolved.kind, privateKey, publicKey: createPublicKey(privateKey), jwk: resolved.jwk, publicKeyHex: resolved.publicKey, keyHash: resolved.keyHash, thumbprint: resolved.thumbprint };
}

/** The proposal for an authorization request of the world, with members replaced: its document, its salt and the digest that a hirer approves. The request names this agent and the advert of the world. */
export function proposalOf(request: Readonly<Record<string, JsonValue>> = {}): Proposal {
  const made = makeProposal({ ...PRIOR_REQUEST, insurer_did: INTAKE_DID, advert_ref: ADVERT_REF, ...request });
  if (!made.ok) throw new Error(made.detail);
  return made.value;
}

/** What the model says when the request meets every requirement. */
export const COMPLETE = JSON.stringify({ reasoning: 'The request names the clinician, lists the codes, cites the criteria and the records, and states the hash.', choice: { complete: true, missing: [] } });
/** What the model says when the request does not list the records. */
export const INCOMPLETE = JSON.stringify({ reasoning: 'The records are not shown.', choice: { complete: false, missing: ['R4'] } });

/** The three attestations that the report reads: which of them the ledger of the world holds. */
export type ReportPart = 'provenance' | 'software' | 'binding';

/** The values that a test of the world changes. */
export interface WorldOptions {
  /** Members of the authorization request that replace those of the world. The approval is for the request that this gives. */
  readonly request?: Readonly<Record<string, JsonValue>>;
  /** Changes the approval on the ledger. */
  readonly attestation?: Partial<AttestationDatum>;
  /** The attestations of the report that the ledger holds. All three by default. */
  readonly report?: readonly ReportPart[];
  /** Settings that replace those of the environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface World {
  /** The marketplace of the model hire. Its clock is the clock of the world. */
  readonly m: Marketplace;
  readonly gateway: StubGateway;
  readonly sender: StubAgent;
  readonly intake: StubAgent;
  readonly delegateKey: TestKey;
  /** The ledger that the hook and the report read. `ledgerDown` makes every read of it fail. */
  readonly ledger: LedgerEnv;
  readonly proposal: Proposal;
  /** The handoff that the sender sends: the approved authorization request, its salt and the reference of the approval. */
  readonly handoff: Handoff;
  /** What the runtime says about the escrow: the captured payment from a vault, the advert, the model of the advert and the delegation key as the buyer key. */
  readonly context: JobContext;
  readonly portal: Portal;
  /** The order in which the portal was reached: `requirements` and `filing`. */
  readonly events: string[];
  /** The scripted Module-1 port of the dispute code. */
  readonly port: IntakePort;
  /** The environment of the service. The listener is on a port that the system picks, and the state directory is new. */
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  /** What the service is given in place of its real parts. */
  readonly options: StartOptions;
  readonly logs: string[];
  /** Makes the model supplier wait before it answers, and tells when a call has reached it. */
  holdModel(): { readonly reached: Promise<void>; readonly release: () => void };
  /** Makes the filing at the insurer portal wait before the portal answers, and tells when the call has reached it. A call with a signal ends when the signal aborts. */
  holdFiling(): { readonly reached: Promise<void>; readonly release: () => void };
  /** The sender has one open claim for the Prior Authorization Agent, so that a challenge for a digest mismatch finds its target. */
  armChallenge(): void;
  /** Makes every read of the ledger fail (`true`) or answer again (`false`). */
  ledgerDown(down: boolean): void;
}

/** The scripted port, with this agent as the agent of the dispute code: the Insurer Intake Agent and its service key. */
export class IntakePort extends ScriptedPort {
  override readonly agent = { did: INTAKE_DID, key_hash: SERVICE.pkh };
}

/** One output of the ledger. This package has no dependency on the library that names the type, so the type is the one that the fixtures take. */
type Output = Parameters<typeof ledgerWorld>[0][number];

/** A node that fails every read of an address when it is told to. The text of its error names a host and holds a secret, and no line of the service may repeat it. */
class SwitchProvider extends FixtureProvider {
  down = false;

  override async getUtxos(...args: Parameters<FixtureProvider['getUtxos']>): Promise<Output[]> {
    if (this.down) throw new Error('the node is down: https://node.example/?key=secret-token-123');
    return super.getUtxos(...args);
  }
}

/**
 * A world in which every check of the hook passes and the job files its request. The sender is an agent of the stub gateway with a verified organisation and a delegation key. The delegation names it, and the
 * ledger holds its record, with a Provider party. The root delegator is the key that issued the approval, and the approval is for the authorization request. The ledger holds the three attestations that the report
 * reads, each valid. The escrow was paid from a vault of the delegation. The request names the Insurer Intake Agent, the advert and the model of the context. The model finds the request complete.
 */
export function makeWorld(over: WorldOptions = {}): World {
  const m = marketplace({ t0: T, buyerPkh: SERVICE.pkh, listed: ['llm'] });
  m.llm.answer = COMPLETE;
  const gateway = createStubGateway({ now: () => m.clock.now });
  const delegateKey = ed25519Key('insurer intake service test: the delegate key');
  const sender = gateway.createAgent({ label: 'insurer intake service test: the sender', delegation: delegateKey, organisation: { domain: 'clinic.example', verified: true } });
  const intake = gateway.createAgent({ label: LABEL, authentication: serviceTestKey() });
  if (intake.did !== INTAKE_DID) throw new Error('the stub gateway gave another DID to the Insurer Intake Agent');
  const proposal = proposalOf(over.request);
  const issuerId = over.attestation?.issuerId ?? null;
  const parts = over.report ?? ['provenance', 'software', 'binding'];
  const provider: Party = { role: 'Provider', signer: { type: 'KeyHash', hash: PROVIDER_KEY.keyHash }, organisation: null, notBefore: CAPTURE_MS - 60 * DAY, notAfter: null, rights: 0, removalAfter: null };
  const about = (id: string, attType: number, key: { publicKey: string }) => attestationUtxo(id, attestation({
    subject: sender.id, attType, issuer: key.publicKey, issuedAt: T - HOUR, validFrom: null, validUntil: T + 4 * HOUR,
  }));
  const utxos = [
    delegationUtxo(DELEGATION_ID, delegation({ delegate: sender.id, delegateKey: delegateKey.keyHash, delegator: { type: 'PrincipalKey', hash: ISSUER_KEY.keyHash, organisation: null } })),
    recordUtxo(sender.id, liveRecord({ parties: [{ ...CONTROLLER_ACCOUNTABLE, notBefore: CAPTURE_MS - 60 * DAY }, provider] }, [delegateKey.publicKeyHex])),
    attestationUtxo(ATTESTATION_ID, attestation({
      subject: sender.id, attType: APPROVAL_ATT_TYPE, digest: proposal.proposal_digest, issuedAt: T - HOUR, validFrom: null, validUntil: T + 4 * HOUR, ...over.attestation,
    })),
    ...(parts.includes('provenance') ? [about(PROVENANCE_ID, 1, PROVIDER_KEY)] : []),
    ...(parts.includes('software') ? [about(SOFTWARE_ID, 2, PROVIDER_KEY)] : []),
    ...(parts.includes('binding') ? [about(BINDING_ID, 4, ISSUER_KEY)] : []),
  ];
  const fixture = ledgerWorld(utxos, { txs: [CAPTURE.payment.tx, CAPTURE.plain_escrow.tx] });
  const node = new SwitchProvider(utxos);
  let down = false;
  const ledger: LedgerEnv = {
    ...fixture.env,
    provider: node,
    fetchImpl: (async (input: string, init?: RequestInit) => {
      if (down) throw new TypeError('fetch failed: https://koios.example/?key=secret-token-123');
      return (fixture.env.fetchImpl as (input: string, init?: RequestInit) => Promise<Response>)(input, init);
    }) as unknown as typeof fetch,
  };
  const context: JobContext = { escrowRef: ESCROW_REF, advertRef: ADVERT_REF, advertModel: 'insurer-intake-agent-v1', buyerPkh: delegateKey.keyHash, paymentLovelace: 4_000_000n, deliverByMs: T + 300_000 };
  // The reference names the issuer record that the attestation names, when it names one.
  const approval = { attestation: ATTESTATION_ID, issuer_did: issuerId === null ? `did:vector:${'f2'.repeat(32)}` : `did:vector:${issuerId}` };
  const handoff: Handoff = { schema: HANDOFF_SCHEMA, use_case: 'prior-authorization', sender_did: sender.did, delegation: DELEGATION_ID, document: proposal.document, salt: proposal.salt, approval };

  const events: string[] = [];
  const portal = new Portal(events);
  const port = new IntakePort();
  const logs: string[] = [];
  const stateDir = tempDir();
  const gatewayOrigin = new URL(gateway.baseUrl).origin;
  const portalOrigin = new URL(BASES.publicBase).origin;
  let gate: { reached: () => void; open: Promise<void> } | null = null;
  let filingGate: { reached: () => void; open: Promise<void> } | null = null;
  // The address of the Module-1 manifest answers with the manifest of the deployment of these tests. The gateway, the insurer portal, the model supplier and the marketplace each have their own answer.
  const routed: typeof fetch = withModule1(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === gatewayOrigin) return gateway.fetch(input, init);
    if (url.origin === portalOrigin) {
      if (filingGate !== null && init?.method === 'POST') {
        const { reached, open } = filingGate;
        reached();
        // A call with a signal ends when the signal aborts, as the fetch of Node does. A call without one waits until the test lets it go.
        await new Promise<void>((resolve, reject) => {
          init.signal?.addEventListener('abort', () => { reject(new Error('the call was aborted')); }, { once: true });
          void open.then(resolve);
        });
      }
      return portal.fetch(input, init);
    }
    if (gate !== null && url.pathname === '/v1/responses' && init?.method === 'POST') {
      gate.reached();
      await gate.open;
    }
    return m.fetchImpl(input, init);
  });
  const env = startEnvWith({
    AGENT_DID: INTAKE_DID, PORT: '0', HOST: '127.0.0.1', INTAKE_STATE_DIR: stateDir, IDENTITY_GATEWAY_URL: gateway.baseUrl, VECTOR_MARKETPLACE_INDEXER_URL: INDEXER,
    MOCK_PUBLIC_BASE: BASES.publicBase, MOCK_MTLS_BASE: BASES.mtlsBase, LLM_MODEL_ALLOWLIST: ALLOWLIST.join(','), LLM_MAX_PRICE_LOVELACE: String(LLM_ADVERT.price_lovelace),
    LLM_MAX_SUPPLIER_BOND_LOVELACE: String(LLM_ADVERT.supplier_bond_lovelace), LLM_MAX_BUYER_BOND_LOVELACE: String(LLM_ADVERT.buyer_bond_lovelace), ...over.env,
  });
  // The hire waits `ms` by moving the clock of the world, after a turn of the event loop. A wait of 20 s or more never ends: it is the bound of a read of the dispute code, and a read that the file system
  // answers in a later turn must not lose to it.
  const sleep = (ms: number): Promise<void> => (ms >= 20_000 ? new Promise<void>(() => undefined) : new Promise<void>((resolve) => { setImmediate(() => { m.clock.now += ms; resolve(); }); }));
  const options: StartOptions = {
    createChain: async () => m.chain, fetchImpl: routed, clock: () => m.clock.now, sleep, log: (line) => { logs.push(line); }, ledgerEnv: ledger, module1Port: port, janitorIntervalMs: 3_600_000,
  };
  return {
    m, gateway, sender, intake, delegateKey, ledger, proposal, handoff, context, portal, events, port, env, stateDir, options, logs,
    holdFiling: () => {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const open = new Promise<void>((resolve) => { release = resolve; });
      filingGate = { reached, open };
      return { reached: arrived, release };
    },
    holdModel: () => {
      let reached!: () => void;
      let release!: () => void;
      const arrived = new Promise<void>((resolve) => { reached = resolve; });
      const open = new Promise<void>((resolve) => { release = resolve; });
      gate = { reached, open };
      return { reached: arrived, release };
    },
    armChallenge: () => {
      const document = claimDocument({ agent_did: sender.did, capability_id: PRIORAUTH_CAPABILITIES.draft, manifest_sha256: MANIFEST_SHA, claim: PRIORAUTH_CLAIM });
      if (!document.ok) throw new Error(document.detail);
      const claim = claimView({ claimer: sender.did, submitted_at: T - HOUR });
      port.documents.set(claim.claim_uri, { bytes: document.value.bytes, type: 'claim', media_type: 'text/plain' });
      port.claims = [{ ...claim, claim_hash: document.value.hash }];
      port.readEscrowAnswer = () => escrowJob({ capability_id: PRIORAUTH_CAPABILITIES.intake, agent_id: INTAKE_ID, buyer_pkh: context.buyerPkh, block_time_ms: T - 30 * 60_000 });
    },
    ledgerDown: (value) => { down = value; node.down = value; },
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
