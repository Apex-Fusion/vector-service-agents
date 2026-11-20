// packages/usecase-kit/src/dispute/chain.ts
// The chain port of the dispute code over the Module-1 builders of the buyer code. It reads the claims at the claim script, and it builds, signs, submits and confirms four kinds of transaction:
// a document, a claim, a challenge and a withdrawal. The builders are keyless: they take a Lucid instance bound to the wallet address and return an unsigned transaction. The signature comes from a
// function that the caller gives. The code never holds a key: the caller closes the function over the service key.
//
// The checks come before the signature. Each build is compared with the call that asked for it: a challenge or a withdrawal must spend the claim output that the call names, and a challenge must hold
// the hash and the URI of the evidence of the call. A build that does not match is refused (`not_built`), and nothing is signed. Every transaction needs the signature of the wallet key only.
//
// A transaction takes the whole wallet but one output, so every method must run in the queue of the service key (ports.ts). The waits go through the `sleep` port: the build has `build_timeout_ms`, and
// the submit and the confirmation share `confirm_timeout_ms`. A wait that ends first gives `not_confirmed` with `may_land` true: the transaction can still land, and only before its `valid_to`.
// The `sleep` that the caller gives must not hold the process open: its timer is not cancelled when the work ends first.
import {
  AWAIT_TIMEOUT_MAX_MS, BUILD_TIMEOUT_MS, DELIVER_BY_BUFFER_MS, buildDocumentPublish, buildOpenChallenge, buildSubmitClaim, buildWithdrawClaim, decodeClaimDatum, lucidForAddress, paymentKeyHashOf,
} from '@vsa/buyer-core';
import type { Module1Deployment } from '@vsa/buyer-core';
import type { Provider, UTxO } from '@lucid-evolution/lucid';
import { addressDetails, decodeTransaction } from '@vsa/vector-read/guarded-decode';
import { utf8Hex } from '@vsa/vector-read/identity-codec';
import { accepted, parseOutputRef } from '../protocol/index.ts';
import type { Did, OutputRef } from '../protocol/index.ts';
import type {
  ClaimView, Module1Port, OpenChallengeCall, OpenedChallenge, PublishCall, PublishedDocument, SubmitClaimCall, SubmittedClaim, TxNotBuilt, TxNotConfirmed, TxResult, WithdrawClaimCall,
  WithdrawnClaim,
} from './ports.ts';
import { describeError } from './text.ts';

/** The node, as the builders use it: the provider of Lucid with the start time of the chain, which the slot clock needs. */
export type Module1Provider = Provider & { getSystemStartMs(): Promise<number> };

export interface Module1PortDeps {
  readonly provider: Module1Provider;
  /** The Module-1 deployment: read it with `readManifest` and `module1FromManifest` of the buyer code. */
  readonly module1: Module1Deployment;
  /** The address of the wallet of the service key: a mainnet address with a key payment credential. */
  readonly address: string;
  /** The identifier of the agent: 64 lower-case hex characters, with no `did:vector:`. Its record must list the wallet key with the transaction purpose, or name it as the controller. */
  readonly agent_id: string;
  /** Adds the signature of the service key to an unsigned transaction. The same function that the chain of the buyer code signs with. */
  readonly sign: (unsignedCborHex: string) => { readonly signedCborHex: string; readonly txHashHex: string };
  /** The time in POSIX milliseconds. A build takes its validity window from it. */
  readonly clock: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The most time for the build of one transaction. The default is the one of the chain of the buyer code. */
  readonly build_timeout_ms?: number;
  /** The most time from the start of the submit to the confirmation. The default is the one of the chain of the buyer code, and the most is its most. */
  readonly confirm_timeout_ms?: number;
  /** The minutes from now that a transaction stays valid: 1 to 59. The builders use 30 when this is not set. */
  readonly valid_minutes?: number;
}

/** `OgmiosProvider.awaitTx` polls this many times, one interval apart. */
const AWAIT_POLLS = 60;

const notBuilt = (detail: string): TxNotBuilt => ({ ok: false, code: 'not_built', detail });

/** The refs of the inputs of a transaction. */
function inputRefsOf(txCbor: string): ReadonlySet<string> {
  const inputs = decodeTransaction(txCbor).body().inputs();
  const refs = new Set<string>();
  for (let index = 0; index < inputs.len(); index += 1) refs.add(`${inputs.get(index).transaction_id().to_hex()}#${inputs.get(index).index()}`);
  return refs;
}

/**
 * Did the submit API refuse the transaction outright? `OgmiosProvider.submitTx` says `Transaction submission rejected (<status> ...` for an HTTP answer that is not OK. A 4xx refuses the request
 * itself, and the ledger's verdict is one: the node did not take the transaction. Any other failure leaves open whether the node has it.
 */
const refusedOutright = (error: unknown): boolean => error instanceof Error && /^Transaction submission rejected \(4\d\d\b/.test(error.message);

/** The claim output that a UTxO holds, or null when it is not one. It throws for a claim output with a datum that cannot be read: such an output must not be taken for no claim. */
function claimViewOf(module1: Module1Deployment, utxo: UTxO): ClaimView | null {
  let credential;
  try {
    credential = addressDetails(utxo.address).paymentCredential;
  } catch {
    return null;
  }
  if (credential?.type !== 'Script' || credential.hash !== module1.claim.hash) return null;
  const tokens = Object.entries(utxo.assets).filter(([unit]) => unit.startsWith(module1.claim.hash));
  if (tokens.length !== 1 || tokens[0]![1] !== 1n) return null;
  const ref = `${utxo.txHash}#${utxo.outputIndex}`;
  if (utxo.datum === undefined || utxo.datum === null) throw new Error(`the claim output ${ref} has no inline datum`);
  const datum = decodeClaimDatum(utxo.datum);
  return {
    ref, token: tokens[0]![0].slice(module1.claim.hash.length), claimer: `did:vector:${datum.claimerDid}`,
    claimer_key_hash: datum.claimerCredential.type === 'VerificationKey' ? datum.claimerCredential.hash : null, state: datum.state, stake_lovelace: datum.stakeAmount,
    submitted_at: datum.submittedAt, challenge_window_ms: datum.challengeWindow,
  };
}

function requireMilliseconds(value: unknown, name: string, most: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > most) throw new TypeError(`${name} must be a whole number of milliseconds from 1 to ${most}`);
  return value;
}

/** What a build is, as far as landing it needs. Every Module-1 build and the build of a document have these members. */
interface Built {
  readonly txCbor: string;
  readonly txHash: string;
  readonly fee: string;
  readonly validTo: number;
  readonly requiredSigners: readonly { readonly keyHash: string }[];
}

/** The chain port over the builders of the buyer code. It refuses settings of the wrong type before it reads anything. */
export function createModule1Port(deps: Module1PortDeps): Module1Port {
  const { provider, module1, address, sign, clock, sleep } = deps;
  if (typeof deps.agent_id !== 'string' || !/^[0-9a-f]{64}$/.test(deps.agent_id)) throw new TypeError('agent_id must be 64 lower-case hex characters');
  const agentId = deps.agent_id;
  const keyHash = paymentKeyHashOf(address);
  const buildMs = deps.build_timeout_ms === undefined ? BUILD_TIMEOUT_MS : requireMilliseconds(deps.build_timeout_ms, 'build_timeout_ms', 600_000);
  const confirmMs = deps.confirm_timeout_ms === undefined ? DELIVER_BY_BUFFER_MS : requireMilliseconds(deps.confirm_timeout_ms, 'confirm_timeout_ms', AWAIT_TIMEOUT_MAX_MS);
  const pollMs = Math.ceil(confirmMs / AWAIT_POLLS);
  const validMinutes = deps.valid_minutes;
  if (validMinutes !== undefined && (!Number.isInteger(validMinutes) || validMinutes < 1 || validMinutes > 59)) throw new TypeError('valid_minutes must be a whole number from 1 to 59');
  const agent: { readonly did: Did; readonly key_hash: string } = { did: `did:vector:${agentId}`, key_hash: keyHash };

  /** The build phase of a transaction: Lucid for the wallet and the builder, against a timer. A build that the timer ended is left to finish alone, and nothing is signed from it. */
  async function building<T>(what: string, work: () => Promise<T>): Promise<{ readonly ok: true; readonly value: T } | TxNotBuilt> {
    const late = sleep(buildMs).then(() => 'late' as const);
    const running = work();
    running.catch(() => undefined);
    try {
      const result = await Promise.race([running, late]);
      if (result === 'late') return notBuilt(`${what} was not built within ${buildMs} ms: the node or the indexer did not answer in time, and nothing was signed or sent`);
      return { ok: true, value: result };
    } catch (error) {
      return notBuilt(`${what} was not built: ${describeError(error)}`);
    }
  }

  /** Signs, submits and waits for the confirmation. The submit and the wait share one budget. */
  async function land(what: string, build: Built): Promise<{ readonly ok: true; readonly tx_hash: string; readonly fee_lovelace: bigint } | TxNotBuilt | TxNotConfirmed> {
    const others = build.requiredSigners.filter((signer) => signer.keyHash !== keyHash);
    if (others.length > 0) return notBuilt(`${what} needs the signature of another key (${others.map((signer) => signer.keyHash).join(', ')}), and this port signs with one key only`);
    let signed: { readonly signedCborHex: string; readonly txHashHex: string };
    let fee: bigint;
    try {
      signed = sign(build.txCbor);
      fee = BigInt(build.fee);
    } catch (error) {
      return notBuilt(`${what} could not be signed: ${describeError(error)}`);
    }
    if (signed.txHashHex !== build.txHash) return notBuilt(`${what} was signed as another transaction than the one that was built, and nothing was sent`);

    const facts = { tx_hash: build.txHash, valid_to: build.validTo };
    const notConfirmed = (detail: string, mayLand: boolean): TxNotConfirmed => ({ ok: false, code: 'not_confirmed', detail, ...facts, may_land: mayLand });
    const until = `It can land only before ${new Date(build.validTo).toISOString()}.`;
    const late = sleep(confirmMs).then(() => 'late' as const);
    try {
      const sending = provider.submitTx(signed.signedCborHex).then(() => 'sent' as const);
      sending.catch(() => undefined);
      if ((await Promise.race([sending, late])) === 'late') return notConfirmed(`${what} may not have been submitted: the submit API did not answer in time. ${until}`, true);
    } catch (error) {
      if (refusedOutright(error)) return notConfirmed(`${what} was refused and cannot land: ${describeError(error)}`, false);
      return notConfirmed(`${what} may not have been submitted: ${describeError(error)}. ${until}`, true);
    }
    try {
      const waiting = provider.awaitTx(build.txHash, pollMs);
      waiting.catch(() => undefined);
      if ((await Promise.race([waiting, late])) !== true) return notConfirmed(`${what} was submitted and is not seen confirmed yet. ${until}`, true);
    } catch (error) {
      return notConfirmed(`${what} was submitted, but its confirmation could not be read: ${describeError(error)}. ${until}`, true);
    }
    return { ok: true, tx_hash: build.txHash, fee_lovelace: fee };
  }

  /** Reads the output ref of a call. The dispute code checks it already: a port that is called directly gets the same check. */
  function refOf(ref: OutputRef): { readonly txHash: string; readonly outputIndex: number } | null {
    const parsed = parseOutputRef(ref, 'claim');
    if (!parsed.ok) return null;
    const [txHash, index] = parsed.value.split('#');
    return { txHash: txHash!, outputIndex: Number(index) };
  }

  return {
    agent,

    async readClaims(): Promise<readonly ClaimView[]> {
      const claims: ClaimView[] = [];
      for (const utxo of await provider.getUtxos(module1.claim.address)) {
        const view = claimViewOf(module1, utxo);
        if (view !== null) claims.push(view);
      }
      return claims;
    },

    async readClaim(ref: OutputRef): Promise<ClaimView | null> {
      const named = refOf(ref);
      if (named === null) throw new TypeError('ref must be a transaction hash, a hash sign and an output index');
      const [utxo] = await provider.getUtxosByOutRef([named]);
      return utxo === undefined ? null : claimViewOf(module1, utxo);
    },

    async publishDocument(call: PublishCall): Promise<TxResult<PublishedDocument>> {
      const built = await building('The document', async () => {
        const lucid = await lucidForAddress(provider, address);
        return buildDocumentPublish(lucid, provider, { changeAddress: address, bytes: call.bytes, type: call.type, mediaType: call.media_type, nowMs: clock(), validMinutes });
      });
      if (!built.ok) return built;
      const build = built.value;
      const landed = await land('The document transaction', build);
      if (!landed.ok) return landed;
      return accepted({ tx_hash: landed.tx_hash, uri: build.uri, document_hash: build.documentHash, fee_lovelace: landed.fee_lovelace });
    },

    async submitClaim(call: SubmitClaimCall): Promise<TxResult<SubmittedClaim>> {
      const built = await building('The claim', async () => {
        const lucid = await lucidForAddress(provider, address);
        return buildSubmitClaim({ lucid, provider, module1 }, {
          changeAddress: address, agentId, claimHash: call.claim_hash, claimUri: utf8Hex(call.claim_uri), claimType: utf8Hex(call.claim_type), stakeLovelace: call.stake_lovelace,
          challengeWindowMs: call.challenge_window_ms, nowMs: clock(), validMinutes,
        });
      });
      if (!built.ok) return built;
      const build = built.value;
      const claim = build.claim;
      const asked = claim.claimerDid === agentId && claim.claimerCredential.type === 'VerificationKey' && claim.claimerCredential.hash === keyHash && claim.state === 'Open'
        && claim.claimHash === call.claim_hash && claim.storageUri === utf8Hex(call.claim_uri) && claim.stakeAmount === call.stake_lovelace && claim.challengeWindow === call.challenge_window_ms;
      if (!asked) return notBuilt('The claim that was built is not the claim that was asked for, and nothing was signed');
      const landed = await land('The claim transaction', build);
      if (!landed.ok) return landed;
      return accepted({
        tx_hash: landed.tx_hash, claim: `${landed.tx_hash}#${build.claimOutputIndex}`, claim_token: build.claimToken, stake_lovelace: claim.stakeAmount, submitted_at: claim.submittedAt,
        challenge_window_ms: claim.challengeWindow, fee_lovelace: landed.fee_lovelace,
      });
    },

    async openChallenge(call: OpenChallengeCall): Promise<TxResult<OpenedChallenge>> {
      const named = refOf(call.claim);
      if (named === null) return notBuilt('The claim reference of the challenge is not a transaction hash, a hash sign and an output index');
      const built = await building('The challenge', async () => {
        const lucid = await lucidForAddress(provider, address);
        return buildOpenChallenge({ lucid, provider, module1 }, {
          changeAddress: address, auditorId: agentId, claim: { ref: named }, evidenceHash: call.evidence_hash, evidenceUri: utf8Hex(call.evidence_uri), stakeLovelace: call.stake_lovelace,
          resolutionDeadlineMs: call.resolution_deadline_ms, nowMs: clock(), validMinutes,
        });
      });
      if (!built.ok) return built;
      const build = built.value;
      const challenge = build.challenge;
      // The build must challenge the claim output of the call, and carry the evidence of the call. The transaction itself is read for the claim: the summary of the builder is not enough.
      const asked = build.claimInput === call.claim && build.claimToken === call.claim_token && challenge.claimToken === call.claim_token
        && challenge.claimRef.txHash === named.txHash && challenge.claimRef.outputIndex === named.outputIndex && challenge.auditorDid === agentId
        && challenge.auditorCredential.type === 'VerificationKey' && challenge.auditorCredential.hash === keyHash && challenge.evidenceHash === call.evidence_hash
        && challenge.evidenceUri === utf8Hex(call.evidence_uri) && challenge.stakeAmount === call.stake_lovelace && inputRefsOf(build.txCbor).has(call.claim);
      if (!asked) return notBuilt('The challenge that was built is not the challenge that was asked for, and nothing was signed');
      const landed = await land('The challenge transaction', build);
      if (!landed.ok) return landed;
      return accepted({
        tx_hash: landed.tx_hash, challenge: `${landed.tx_hash}#${build.challengeOutputIndex}`, challenge_token: build.challengeToken, claim: build.claimInput, claim_token: build.claimToken,
        stake_lovelace: challenge.stakeAmount, deadline: build.deadline, fee_lovelace: landed.fee_lovelace,
      });
    },

    async withdrawClaim(call: WithdrawClaimCall): Promise<TxResult<WithdrawnClaim>> {
      const named = refOf(call.claim);
      if (named === null) return notBuilt('The claim reference of the withdrawal is not a transaction hash, a hash sign and an output index');
      const built = await building('The withdrawal', async () => {
        const lucid = await lucidForAddress(provider, address);
        return buildWithdrawClaim({ lucid, provider, module1 }, { changeAddress: address, claim: { ref: named }, nowMs: clock(), validMinutes });
      });
      if (!built.ok) return built;
      const build = built.value;
      const asked = build.claimInput === call.claim && build.claimToken === call.claim_token && inputRefsOf(build.txCbor).has(call.claim);
      if (!asked) return notBuilt('The withdrawal that was built does not spend the claim that was asked for, and nothing was signed');
      const landed = await land('The withdrawal transaction', build);
      if (!landed.ok) return landed;
      return accepted({
        tx_hash: landed.tx_hash, claim: build.claimInput, claim_token: build.claimToken, payout: build.payoutRef, stake_lovelace: build.claim.stakeAmount, fee_lovelace: landed.fee_lovelace,
      });
    },
  };
}
