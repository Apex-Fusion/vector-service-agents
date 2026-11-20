// services/mock-systems/test/support/world.ts
// The world of the tests: the stub gateway of @vsa/id-kit (agents, delegations, tokens, SVIDs, status lists, DID resolution) and a ledger of fixture data built from the same agents and
// delegations (the fixtures of the ledger reads of packages/buyer-core). The service runs its real code on both: the real verifier on the tokens of the stub, and the real
// `checkDelegationUse` of buyer-core on the fixture ledger. The approvals that the member issues are attestations on the same ledger, and the real approval check of the use-case kit reads them.
// No test touches a network. One clock moves the gateway, the verifier and the service together.
import { X509Certificate } from 'node:crypto';
import { checkDelegationUse } from '@vsa/buyer-core';
import type { DelegationUseCheck, DelegationUseParams, LedgerEnv } from '@vsa/buyer-core';
import { createGatewayClient, presentToken } from '@vsa/id-kit';
import type { GatewayClient } from '@vsa/id-kit';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { AgentOptions, DelegationOptions, StubAgent, StubDelegation, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { createIdentityDeps } from '../../src/identity.ts';
import type { IdentityDeps, LedgerPort } from '../../src/identity.ts';
import { proposalDigest } from '@vsa/usecase-kit/protocol';
import { attestation as attestationDatum, attestationUtxo, delegation as delegationDatum, delegationUtxo, ledgerWorld, liveRecord, MAINNET, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';

export const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
export const PUBLIC_BASE = 'https://mock.example.test';
export const MTLS_BASE = 'https://mock-mtls.example.test';
export const PUBLIC_HOST = 'mock.example.test';
export const MTLS_HOST = 'mock-mtls.example.test';
export const OPERATOR_TOKEN = 'operator-token-of-the-tests-0123456789abcdef';
export const SUPPLIER_ORG = 'alfa.example.test';
export const INSURER_ORG = 'delta.example.test';
export const HOUR = 3_600_000;
/** The name of an approval that `World.approve` makes, and the name that `rankingBody` (test/support/scenario.ts) gives to the approval of a ranking. */
export const APPROVAL_ID = '07'.repeat(32);
/** The fields of an attestation that a test changes. */
type AttestationFields = NonNullable<Parameters<typeof attestationDatum>[0]>;

/** The published values of the identity registry deployment of Vector mainnet: public chain data, and the three settings of the service that name them. */
export const DEPLOYMENT_SETTINGS = {
  VECTOR_IDENTITY_LEGACY_ROOT: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  VECTOR_IDENTITY_CONFIG_SEED: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a#0',
  VECTOR_IDENTITY_POLICY_ID: 'd958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762',
};

/** A complete good environment for the service on `port`. The gateway is the default one, which is the address of the stub gateway too. `extra` adds or replaces a setting. */
export const serviceEnvironment = (port: number, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MOCK_PUBLIC_BASE: PUBLIC_BASE, MOCK_MTLS_BASE: MTLS_BASE, MOCK_OPERATOR_TOKEN: OPERATOR_TOKEN, ...DEPLOYMENT_SETTINGS, PORT: String(port), HOST: '127.0.0.1', ...extra,
});

const utf8Hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex');

/** The URL of a system of a tenant, as a delegation names it. */
export const resourceOf = (tenant: string, system: string): string => `${PUBLIC_BASE}/t/${tenant}/${system}`;

/** A token with the key that it is bound to: what a caller needs to make a call. */
export interface IssuedCredential {
  readonly accessToken: string;
  readonly key: TestKey;
}

export class World {
  time = T0;
  readonly now = (): number => this.time;
  readonly gateway: StubGateway = createStubGateway({ now: this.now });
  readonly client: GatewayClient = createGatewayClient({ baseUrl: this.gateway.baseUrl, fetch: this.gateway.fetch, now: this.now });
  readonly agents: StubAgent[] = [];
  readonly delegations: StubDelegation[] = [];
  /** The key of the member who delegates: a principal key with no record. */
  readonly member: TestKey = ed25519Key('member');
  /** When set, a read of the ledger fails with this error. */
  ledgerFault: Error | null = null;
  /** When set, the ledger gives this answer to a check of a delegation, in place of the real check. */
  ledgerAnswer: ((params: DelegationUseParams) => DelegationUseCheck) | null = null;
  /** When set, the ledger waits for this promise before it answers. Use `holdLedger`. */
  ledgerGate: Promise<void> | null = null;
  /** Called when the ledger is asked, before it waits on the gate. Use `holdLedger`. */
  private onLedgerAsked: (() => void) | null = null;
  /** What the service asked of the ledger, in order. */
  readonly ledgerParams: DelegationUseParams[] = [];
  /** The approvals that the member issued: one attestation output of the ledger for each. */
  readonly attestations: Array<{ id: string; fields: AttestationFields }> = [];
  /** The reads of the approval check that fail: the node and the indexer give no answer for the attestation, for the delegation chain, or for both. Null: every read answers. */
  approvalFault: 'attestation' | 'delegation' | 'both' | null = null;
  readonly ledger: LedgerPort = async (params) => {
    this.ledgerParams.push(params);
    this.onLedgerAsked?.();
    if (this.ledgerGate !== null) await this.ledgerGate;
    if (this.ledgerFault !== null) throw this.ledgerFault;
    if (this.ledgerAnswer !== null) return this.ledgerAnswer(params);
    return checkDelegationUse(this.ledgerEnv(), params);
  };
  readonly identity: IdentityDeps = createIdentityDeps({ gatewayUrl: this.gateway.baseUrl, fetch: this.gateway.fetch, now: this.now, ledger: this.ledger });

  /**
   * Holds the ledger: the next check of a delegation waits. `asked` is settled when the service has asked the ledger, so that a test knows that a call is in the middle of its checks, with
   * no wait on the clock. `release` lets the held checks go on, and takes the hold off.
   */
  holdLedger(): { asked: Promise<void>; release: () => void } {
    let release = (): void => undefined;
    let asked = (): void => undefined;
    this.ledgerGate = new Promise<void>((resolve) => { release = resolve; });
    const askedPromise = new Promise<void>((resolve) => { asked = resolve; });
    this.onLedgerAsked = asked;
    return { asked: askedPromise, release: () => { this.ledgerGate = null; this.onLedgerAsked = null; release(); } };
  }

  advance(ms: number): void {
    this.time += ms;
  }

  agent(label: string, options: AgentOptions = {}): StubAgent {
    const made = this.gateway.createAgent({ label, ...options });
    this.agents.push(made);
    return made;
  }

  /** A delegation from the member to `agent` for the actions on the resources. A sub-delegation names its parent. */
  delegate(options: Omit<DelegationOptions, 'delegator'> & { delegator?: DelegationOptions['delegator'] }): StubDelegation {
    const made = this.gateway.delegate({ delegator: { principalKey: this.member }, ...options });
    this.delegations.push(made);
    return made;
  }

  /** Ends a delegation on the gateway and on the ledger (an Undelegate). */
  end(delegation: StubDelegation): void {
    this.gateway.endDelegation(delegation);
  }

  /**
   * The member approves a ranking for `subject`: an attestation of the approval type (5), issued by the key of the member (the root delegator of the delegations of this world), with the digest
   * of the salt and the ranking. It is valid from one hour ago for four hours from now. `over` changes the attestation. Gives the name of the attestation.
   */
  approve(subject: StubAgent, ranking: unknown, salt: string, over: AttestationFields = {}, id: string = APPROVAL_ID): string {
    const digest = proposalDigest(salt, ranking);
    if (!digest.ok) throw new Error(`the ranking has no digest: ${digest.detail}`);
    this.attestations.push({
      id, fields: { subject: subject.id, issuer: this.member.publicKeyHex, attType: 5, digest: digest.value, issuedAt: this.time - HOUR, validFrom: null, validUntil: this.time + 4 * HOUR, ...over },
    });
    return id;
  }

  /** The ledger as it is now: a record for each agent and an output for each delegation that has not ended. */
  ledgerEnv(): LedgerEnv {
    const now = this.time;
    const status = (agent: StubAgent) => {
      if (agent.status === 'revoked') return { type: 'Revoked' as const, by: { type: 'ControllerSet' as const }, reason: 0, at: now - 1000, invalidFrom: null, successor: null };
      if (agent.status === 'retired') return { type: 'Retired' as const, at: now - 1000, successor: null };
      if (agent.status === 'suspended') return { type: 'Suspended' as const, holds: [{ by: { type: 'ControllerSet' as const }, reason: 0, since: now - 1000, until: now + 86_400_000 }] };
      return { type: 'Active' as const };
    };
    const records = this.agents.map((agent) => recordUtxo(agent.id, liveRecord({ status: status(agent) }, agent.keys.map((k) => k.key.publicKeyHex))));
    const links = this.delegations.filter((d) => !d.ended).map((d) =>
      delegationUtxo(d.id, delegationDatum({
        delegator: d.delegator.type === 'key' ? { type: 'PrincipalKey', hash: d.delegator.id, organisation: d.delegator.organisation } : { type: 'Agent', id: d.delegator.id },
        parent: d.parent, delegate: d.delegate, delegateKey: d.delegateKey, actions: d.actions.map(utf8Hex), resources: d.resources.map(utf8Hex),
        notBefore: d.notBefore, notAfter: d.notAfter, depth: d.depth, remaining: d.remaining, purpose: d.purpose,
        value: d.value === null ? null : { perTx: d.value.perTx, total: d.value.total, periodMs: d.value.periodMs },
      })));
    const approvals = this.attestations.map(({ id, fields }) => attestationUtxo(id, attestationDatum(fields)));
    return ledgerWorld([...records, ...links, ...approvals]).env;
  }

  /** The ledger as the approval check reads it: the ledger as it is now, and the reads that `approvalFault` names do not answer. */
  approvalLedgerEnv(): LedgerEnv {
    const env = this.ledgerEnv();
    if (this.approvalFault === null) return env;
    const scripts = this.approvalFault === 'attestation' ? [MAINNET.attestation] : this.approvalFault === 'delegation' ? [MAINNET.delegation] : [MAINNET.attestation, MAINNET.delegation];
    // A read names its script by address, by policy or by credential. The text of its arguments holds one of them, so a read of another script is not touched.
    const names = (args: unknown): boolean => {
      const text = JSON.stringify(args, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
      return scripts.some(({ address, hash }) => text.includes(address) || text.includes(hash));
    };
    const provider = new Proxy(env.provider, {
      get(target, name) {
        const member: unknown = Reflect.get(target, name);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => (names(args) ? Promise.reject(new Error('the node gave no answer')) : member.apply(target, args));
      },
    });
    const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (names([String(input), init?.body]) ? Promise.reject(new TypeError('fetch failed')) : env.fetchImpl(input, init))) as typeof fetch;
    return { ...env, provider, fetchImpl };
  }

  /** A token of `agent` under `delegation` for `resource`, bound to the delegate key of the agent. */
  async token(agent: StubAgent, delegation: StubDelegation, resource: string, audience: readonly string[] = []): Promise<IssuedCredential> {
    const issued = await this.client.requestToken({
      subject: { did: agent.did, key: agent.authentication.privateKey }, dpopKey: agent.delegation.privateKey, resource: [resource], audience, delegation: { identifier: delegation.id },
    });
    if (!issued.ok) throw new Error(`the stub gateway refused the token: ${issued.rule}: ${issued.detail}`);
    return { accessToken: issued.value.accessToken, key: agent.delegation };
  }

  /** The header fields of one call with the token: `Authorization` and a new proof for this method and URL. */
  async presented(credential: IssuedCredential, method: string, url: string): Promise<Record<string, string>> {
    const { authorization, dpop } = await presentToken(credential.accessToken, credential.key.privateKey, { method, url }, { now: this.now });
    return { authorization, dpop };
  }

  /** The `Client-Cert` header that the proxy sets for an X.509-SVID of `agent`. */
  async clientCert(agent: StubAgent): Promise<string> {
    const issued = await this.client.x509Svid({ agent: { did: agent.did, key: agent.authentication.privateKey } });
    if (!issued.ok) throw new Error(`the stub gateway refused the X.509-SVID: ${issued.rule}: ${issued.detail}`);
    return `:${new X509Certificate(issued.value.certificate).raw.toString('base64')}:`;
  }

  /** A JWT-SVID of `agent` for the audience, or for each audience of a list. */
  async jwtSvid(agent: StubAgent, audience: string | readonly string[]): Promise<string> {
    const issued = await this.client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience });
    if (!issued.ok) throw new Error(`the stub gateway refused the JWT-SVID: ${issued.rule}: ${issued.detail}`);
    return issued.value.svid;
  }
}
