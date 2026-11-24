// agents/sourcing-agent/test/facts/support.ts
// What the tests of the three readers of facts share. A clock that a test moves by hand. The stake that Vector mainnet holds for one test record, and the rows that Koios makes of it. The views of
// claims and challenges, built by hand. A stub gateway with a client and the real verifier on it. Every port of a test counts its calls, so a test can show that nothing is retried.
import { createGatewayClient } from '@vsa/id-kit/client';
import type { Check, GatewayResult, GatewayRule } from '@vsa/id-kit/client';
import { createStubGateway } from '@vsa/id-kit/testing';
import type { StubAgent, StubGateway } from '@vsa/id-kit/testing';
import { createVerifier } from '@vsa/id-kit/verify';
import type { ChallengeView, ClaimView } from '@vsa/usecase-kit/dispute';
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, encodeStakeDatum, stakeTokenName } from '@vsa/vector-read';
import type { KoiosUtxo, StakeDatum } from '@vsa/vector-read';
import type { CredentialDeps, FactClock } from '../../src/facts/index.ts';

// ---- the clock ----

/** A clock that a test moves by hand. A wait that a reader asks for stays open until `fire`, or until the reader ends it. */
export class ManualClock implements FactClock {
  /** The length of each wait that a reader asked for, in order. */
  readonly asked: number[] = [];
  readonly #open = new Set<() => void>();

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.asked.push(ms);
    return new Promise<void>((resolve) => {
      const end = (): void => {
        this.#open.delete(end);
        signal?.removeEventListener('abort', end);
        resolve();
      };
      this.#open.add(end);
      if (signal?.aborted === true) end();
      else signal?.addEventListener('abort', end, { once: true });
    });
  }

  /** The number of waits that are still open. A reader that is done leaves none. */
  get open(): number {
    return this.#open.size;
  }

  /** Time passes: every wait that is open ends now. */
  fire(): void {
    for (const end of [...this.#open]) end();
  }
}

/** Lets every promise that can settle without a timer settle. A test calls it before it moves the clock. */
export const settle = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/** A promise that never settles: a port that never answers. */
export const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

// ---- the stake ----
// The datum below is the inline datum of a stake output on Vector mainnet, as Koios gave it on 2026-11-23. The output holds a stake of 11,000,000 units for one test record. Its bytes are the
// same as in the tests of vector-read, so the codec that the reader uses is pinned to what the chain holds. The token name is the name that the chain shows for that output.

/** The identifier of the agent that has the recorded stake. */
export const AGENT_ID = '4e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9';
/** The identifier of another agent. */
export const OTHER_ID = 'b2'.repeat(32);
export const OWNER = '34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682';
const hexOf = (text: string): string => Buffer.from(text).toString('hex');

export const STAKE: StakeDatum = {
  agent_did: AGENT_ID, owner_pkh: OWNER, stake_amount: 11_000_000n, staked_capabilities: [hexOf('smoke.stake-check.a.v1'), hexOf('smoke.stake-check.b.v1')],
  last_updated: 1_795_425_911_000, history_points: 0n, challenge_locks: [], stake_id: { txHash: 'c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c', outputIndex: 0 },
};
export const STAKE_HEX = 'd8799f58204e1272ee30e5bdf5ad75be55553563a7056ab228295c70ffda988892da4a8fe9d8799f581c34267e928e17c77063ee4957b6932182b7d804ed1d3f77c3f4121682ff1a00a7d8c09f56736d6f6b652e7374616b652d636865636b2e612e763156736d6f6b652e7374616b652d636865636b2e622e7631ff1b000001a207b940d80080d8799f5820c4ec66206f6f917519f411f9fbab1d709c918b30acf6bc7951759a513fa22c8c00ffff';
/** The name of the stake token of the agent, as the chain shows it: `rstk_` and the first 27 bytes of the hash of the identifier. */
export const TOKEN_NAME = '7273746b5f1b98065ee43002664ff55bc12bba527c45b233b80cd7a4517e1581';

/** The stake datum of the recorded stake with some members changed, written as the module writes it. */
export const datumOf = (over: Partial<StakeDatum> = {}): string => encodeStakeDatum({ ...STAKE, ...over });

/** A datum of the earlier layout: constructor 0 with 6 fields (no stake id, no challenge locks). It is Plutus data of the right kind and the wrong number of fields. */
export const SIX_FIELD_DATUM = ['d8799f', `5820${AGENT_ID}`, `d8799f581c${OWNER}ff`, '1a00a7d8c0', '80', '1b000001a207b940d8', '00', 'ff'].join('');

const hashOf = (n: number): string => n.toString(16).padStart(64, '0');

/** The one token of the stake of an agent, as Koios lists it in `asset_list`. */
export const tokenOf = (agentId: string, quantity = '1'): { policy_id: string; asset_name: string; quantity: string } => ({ policy_id: REPUTATION_SCRIPT_HASH, asset_name: stakeTokenName(agentId), quantity });

/** A row of the extended answer of `asset_utxos`: the recorded stake output of AGENT_ID, at the stake address, with the datum and the one token. `n` makes the transaction hash. A test changes one member. */
export function stakeRow(n = 1, over: Partial<KoiosUtxo> = {}): KoiosUtxo {
  return {
    tx_hash: hashOf(n), tx_index: 0, address: REPUTATION_ADDRESS, value: '11000000', block_height: 9_600_000 + n, is_spent: false,
    inline_datum: { bytes: STAKE_HEX }, asset_list: [tokenOf(AGENT_ID)], ...over,
  };
}

// The recorded stake output as Koios gave it on 2026-11-24 (`asset_utxos`, extended): the members that the reader does not read are here too. The datum as JSON (`inline_datum.value`) is left out.
const liveRow = {
  tx_hash: '48d4ce7bbd9141a0e5787af08a2cb14aa6c75b64134f874fa64bc8a4155eb6ad', tx_index: 0, address: REPUTATION_ADDRESS, value: '11000000', stake_address: null, payment_cred: REPUTATION_SCRIPT_HASH,
  epoch_no: 453, block_height: 9_609_690, block_time: 1_795_424_118, datum_hash: 'f4f9cedb6cddb9b0ef4e8a4e0a2b1d3e0f33b881eb84f851eea165fe5c367927', inline_datum: { bytes: STAKE_HEX },
  reference_script: null, is_spent: false,
  asset_list: [{ decimals: 0, quantity: '1', policy_id: REPUTATION_SCRIPT_HASH, asset_name: TOKEN_NAME, fingerprint: 'asset1gu53tkydshnsqz762d2en7meejscjey96h7txf' }],
};
export const LIVE_ROW: KoiosUtxo = liveRow;

// ---- the cases ----

export const BIDDER = `did:vector:${'a1'.repeat(32)}`;
export const OTHER = `did:vector:${'c3'.repeat(32)}`;
const tokenText = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

/** A live claim output of Module-1. A claim that a challenge started on has the state `Challenged`, and it has moved to a new output: its `ref` is not the output that the challenge spent. */
export function claimView(n: number, claimer: string = BIDDER, over: Partial<ClaimView> = {}): ClaimView {
  return {
    ref: `${hashOf(1_000 + n)}#0`, token: tokenText(n), claimer, claimer_key_hash: null, state: 'Challenged', stake_lovelace: 11_000_000n, submitted_at: 1_795_000_000_000,
    challenge_window_ms: 600_000, claim_hash: 'ab'.repeat(32), claim_type: 'supplychain.rfq.quote.v1', claim_uri: `vector-tx:${hashOf(2_000 + n)}`, ...over,
  };
}

/** A live challenge output of Module-1 against `claim`. Its `claim` member is the output that the challenge spent, and that is not the live output of the claim; its `claim_token` is the token of the claim. */
export function challengeView(n: number, claim: ClaimView, over: Partial<ChallengeView> = {}): ChallengeView {
  return {
    ref: `${hashOf(3_000 + n)}#0`, token: tokenText(100 + n), claim: `${hashOf(4_000 + n)}#0`, claim_token: claim.token, auditor: OTHER, auditor_key_hash: null, stake_lovelace: 11_000_000n,
    evidence_hash: 'cd'.repeat(32), evidence_uri: `vector-tx:${hashOf(5_000 + n)}`, challenged_at: 1_795_000_100_000, resolution_deadline_ms: 600_000, state: 'PendingOracle', ...over,
  };
}

// ---- the credential ----

/** A call to the gateway that failed with this status. The rule is the one that the client gives for it. */
export const failure = (status: number, rule: GatewayRule = 'gateway.refused'): GatewayResult<string> => ({
  ok: false, rule, detail: 'words of the gateway that no result repeats', status, error: null, retryAfterSeconds: null,
});

/** A refusal of the verifier for this rule. */
export const refusal = (rule: string): Check<unknown, string> => ({ ok: false, rule, detail: 'words of the verifier that no result repeats' });

/** A credential as the client gives it. */
export const credentialOf = (jwt: string): GatewayResult<string> => ({ ok: true, value: jwt });

/** The credential with one byte of its payload changed: the first letter of the word that the stub gateway writes for the origin of a record. The signature is the old one. */
export function tamper(jwt: string): string {
  const [header, payload, signature] = jwt.split('.');
  const text = Buffer.from(payload!, 'base64url').toString('utf8');
  const changed = text.replace('"origin":"registered"', '"origin":"Registered"');
  if (changed === text || changed.length !== text.length) throw new Error('the stub gateway writes the credential in another form: change the test');
  return [header, Buffer.from(changed, 'utf8').toString('base64url'), signature].join('.');
}

export interface CredentialWorld {
  readonly gateway: StubGateway;
  /** An agent with a record in the stub gateway. */
  readonly agent: StubAgent;
  readonly clock: ManualClock;
  /** The ports of the reader: the client of the stub gateway and the real verifier on it. A test replaces a member. */
  deps(over?: Partial<CredentialDeps>): CredentialDeps;
}

/** A stub gateway, a client and a verifier on it, one agent, and a clock for the reader. Each test makes its own world: a verifier keeps the lists that it read. */
export function credentialWorld(): CredentialWorld {
  const gateway = createStubGateway();
  const client = createGatewayClient({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const verifier = createVerifier({ baseUrl: gateway.baseUrl, fetch: gateway.fetch, now: gateway.now });
  const agent = gateway.createAgent({ label: 'bidder' });
  const clock = new ManualClock();
  return { gateway, agent, clock, deps: (over = {}) => ({ fetchCredential: (did) => client.credential(did), verify: (jwt, policy) => verifier.credential(jwt, policy), clock, ...over }) };
}

/** The path of the credential of an agent at the stub gateway. */
export const credentialPath = (agent: StubAgent): string => `/agents/${agent.id}/credential`;
