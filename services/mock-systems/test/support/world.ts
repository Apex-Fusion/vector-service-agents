// services/mock-systems/test/support/world.ts
// The world of the tests: the stub gateway of @vsa/id-kit (agents, delegations, tokens, SVIDs, status lists, DID resolution) and a ledger of fixture data built from the same agents and
// delegations (the fixtures of the ledger reads of packages/buyer-core). The service runs its real code on both: the real verifier on the tokens of the stub, and the real
// `checkDelegationUse` of buyer-core on the fixture ledger. No test touches a network. One clock moves the gateway, the verifier and the service together.
import { X509Certificate } from 'node:crypto';
import { checkDelegationUse } from '@vsa/buyer-core';
import type { DelegationUseCheck, DelegationUseParams, LedgerEnv } from '@vsa/buyer-core';
import { createGatewayClient, presentToken } from '@vsa/id-kit';
import type { GatewayClient } from '@vsa/id-kit';
import { createStubGateway, ed25519Key } from '@vsa/id-kit/testing';
import type { AgentOptions, DelegationOptions, StubAgent, StubDelegation, StubGateway, TestKey } from '@vsa/id-kit/testing';
import { createIdentityDeps } from '../../src/identity.ts';
import type { IdentityDeps, LedgerPort } from '../../src/identity.ts';
import { delegation as delegationDatum, delegationUtxo, ledgerWorld, liveRecord, recordUtxo } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';

export const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);
export const PUBLIC_BASE = 'https://mock.example.test';
export const MTLS_BASE = 'https://mock-mtls.example.test';
export const PUBLIC_HOST = 'mock.example.test';
export const MTLS_HOST = 'mock-mtls.example.test';
export const OPERATOR_TOKEN = 'operator-token-of-the-tests-0123456789abcdef';
export const SUPPLIER_ORG = 'alfa.example.test';
export const INSURER_ORG = 'delta.example.test';
export const HOUR = 3_600_000;

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
    return ledgerWorld([...records, ...links]).env;
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

  /** A JWT-SVID of `agent` for the audience. */
  async jwtSvid(agent: StubAgent, audience: string): Promise<string> {
    const issued = await this.client.jwtSvid({ agent: { did: agent.did, key: agent.authentication.privateKey }, audience });
    if (!issued.ok) throw new Error(`the stub gateway refused the JWT-SVID: ${issued.rule}: ${issued.detail}`);
    return issued.value.svid;
  }
}
