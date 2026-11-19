// packages/id-kit/src/testing/state.ts
// The world of the stub gateway: its agents (records), its delegations, the tokens that it issued and its clock. A test builds this world with the methods of the stub
// gateway, and the routes of the stub read it as the real gateway reads the ledger.

import { CLOCK_LEEWAY_S, MAX_TOKEN_LIFETIME_S, PURPOSE } from '../common/constants.ts';
import type { TestKey } from './keys.ts';

/** The status of a record. The effective status of an agent can differ from it, because a subagent has the status of its parents too. */
export type AgentStatus = 'active' | 'suspended' | 'revoked' | 'retired';

export interface ListedKey {
  readonly key: TestKey;
  /** The purposes of the key as a bit set: authentication 1, assertion 2, transaction 8, delegation 16. */
  purposes: number;
}

export interface StubAgent {
  /** The identifier: 64 lowercase hex characters. */
  readonly id: string;
  readonly did: string;
  readonly name: string;
  /** The position of the agent in the status lists. */
  readonly index: number;
  /** The keys that the record lists. A test can change the list with `removeKey` and `setPurposes` of the stub. */
  readonly keys: ListedKey[];
  /** An Ed25519 key with the authentication purpose: the key of its subject tokens. */
  readonly authentication: TestKey;
  /** An Ed25519 key with the delegation purpose: the key that signs a delegation (`delegate_key`) and the proofs of a delegation token. */
  readonly delegation: TestKey;
  /** The identifier of the parent, for a subagent. */
  readonly parent: string | null;
  readonly created: number;
  status: AgentStatus;
  /** A reason for `status`, as a name: for example `hold`. */
  statusReason: string | null;
  /** The organisation that the Accountable party of the record names, and whether the gateway verified it. */
  organisation: { readonly domain: string; verified: boolean } | null;
  /** The capabilities that the profile of the record names. */
  readonly capabilities: readonly string[];
  /** The endpoint that the profile of the record names. */
  readonly endpoint: string | null;
}

export interface Delegator {
  readonly type: 'agent' | 'key';
  /** The identifier of the delegator agent, or the key hash (56 hex characters) of the principal key. */
  readonly id: string;
  readonly organisation: string | null;
}

export interface StubDelegation {
  /** The delegation identifier: 64 lowercase hex characters. */
  readonly id: string;
  readonly delegator: Delegator;
  /** The identifier of the parent delegation, or null for a root. */
  readonly parent: string | null;
  /** The identifier of the delegate agent. */
  readonly delegate: string;
  /** The key hash of the delegate key. */
  readonly delegateKey: string;
  readonly actions: readonly string[];
  readonly resources: readonly string[];
  /** POSIX ms. */
  readonly notBefore: number;
  readonly notAfter: number;
  readonly depth: number;
  readonly remaining: number;
  readonly purpose: string | null;
  /** The value limit for a vault under this delegation, in the smallest unit of the ledger, or null for a delegation with no limit. The stub does not pay: it checks that a child stays inside its parent. */
  readonly value: { readonly perTx: bigint; readonly total: bigint; readonly periodMs: number } | null;
  /** How many blocks confirm the delegation. The gateway counts it from 30. */
  confirmations: number;
  /** True after an Undelegate: the delegation is gone, and so is every delegation below it. */
  ended: boolean;
}

/** A token that the stub issued, kept as the gateway keeps it until a relying party can no longer accept it. */
interface IssuedRecord {
  readonly jti: string;
  readonly kind: 'access_token' | 'jwt_svid';
  /** The agents whose status the token depends on: the requester first, then each delegator agent. */
  readonly agents: readonly string[];
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export const CONFIRMATION_DEPTH = 30;

/** The first instant of the stub clock: a fixed time, so that a test never depends on the real clock. */
export const START_TIME = Date.UTC(2026, 10, 19, 12, 0, 0);

export class StubState {
  readonly agents = new Map<string, StubAgent>();
  readonly delegations = new Map<string, StubDelegation>();
  private readonly issued = new Map<string, IssuedRecord>();
  /** Per agent: the tokens issued at or before this time are revoked. */
  private readonly revokedUpTo = new Map<string, number>();
  private time = START_TIME;
  private fixedClock: (() => number) | null;
  private agentCount = 0;
  private delegationCount = 0;

  constructor(clock: (() => number) | null) {
    this.fixedClock = clock;
  }

  now(): number {
    return this.fixedClock === null ? this.time : this.fixedClock();
  }

  setNow(ms: number): void {
    if (this.fixedClock !== null) throw new Error('the stub gateway runs on a clock that the caller gave: move that clock');
    this.time = ms;
  }

  nextAgentNumber(): number {
    return this.agentCount++;
  }

  nextDelegationNumber(): number {
    return this.delegationCount++;
  }

  /** The agent with this identifier, or null. */
  agent(id: string): StubAgent | null {
    return this.agents.get(id) ?? null;
  }

  /** The effective status of an agent: its own status, or, when it is Active, the status that its parents give it. */
  effective(agent: StubAgent, depth = 0): { readonly status: AgentStatus; readonly reason: string | null } {
    if (agent.status !== 'active') return { status: agent.status, reason: null };
    const parent = agent.parent === null || depth >= 8 ? null : this.agent(agent.parent);
    if (parent === null) return { status: 'active', reason: null };
    const own = this.effective(parent, depth + 1);
    if (own.status === 'revoked') return { status: 'revoked', reason: 'parentRevoked' };
    if (own.status === 'retired') return { status: 'retired', reason: 'parentRetired' };
    if (own.status === 'suspended') return { status: 'suspended', reason: 'parentSuspended' };
    return { status: 'active', reason: null };
  }

  /** The key of the agent in its record that has this hash, or null. */
  listedKey(agent: StubAgent, keyHash: string): ListedKey | null {
    return agent.keys.find((k) => k.key.keyHash === keyHash) ?? null;
  }

  /** True when the record lists an Ed25519 key with the delegation purpose whose hash is `keyHash`. */
  listsDelegationKey(agent: StubAgent, keyHash: string): boolean {
    return agent.keys.some((k) => k.key.kind === 'Ed25519' && k.key.keyHash === keyHash && (k.purposes & PURPOSE.delegation) !== 0);
  }

  // ── tokens that the gateway issued ──

  recordIssued(token: IssuedRecord): void {
    this.issued.set(token.jti, token);
  }

  private prune(): void {
    const now = this.now();
    for (const [jti, token] of this.issued) if (token.expiresAt + CLOCK_LEEWAY_S * 1000 <= now) this.issued.delete(jti);
    const horizon = now - (MAX_TOKEN_LIFETIME_S + CLOCK_LEEWAY_S) * 1000;
    for (const [agent, at] of this.revokedUpTo) if (at < horizon) this.revokedUpTo.delete(agent);
  }

  /**
   * The agents whose entry in the Token Status List reads SUSPENDED even when they are Active: the requester of an access token that a status change revoked, while a relying
   * party could still accept the token (until its expiry and the clock leeway). Without this, a revoked token would be valid again when a hold ends.
   */
  heldEntries(): Set<string> {
    this.prune();
    const held = new Set<string>();
    for (const token of this.issued.values()) {
      if (token.kind === 'access_token' && token.agents.some((a) => (this.revokedUpTo.get(a) ?? -1) >= token.issuedAt)) held.add(token.agents[0]!);
    }
    return held;
  }

  /**
   * The status watcher of the gateway: for every agent that a live token depends on, revoke the tokens of the agent when its effective status is not Active.
   * The stub runs it at each status change, where the gateway runs it every 30 seconds.
   */
  watchStatuses(): void {
    this.prune();
    const live = new Set<string>();
    for (const token of this.issued.values()) if (token.expiresAt > this.now()) for (const a of token.agents) live.add(a);
    for (const id of live) {
      const agent = this.agent(id);
      if (agent === null || this.effective(agent).status !== 'active') this.revokedUpTo.set(id, Math.max(this.now(), this.revokedUpTo.get(id) ?? this.now()));
    }
  }
}
