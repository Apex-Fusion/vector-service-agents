// packages/usecase-kit/src/cosign/route.ts
// The function behind `POST /cosign/delegate`: a request in, the same transaction with one witness more, or a typed refusal.
//
// The agent signs a transaction only when ALL of this holds, checked on the body that it signs:
//   - it is one Delegate of the delegation contract of the deployment: one token of the delegation policy minted and nothing else, one output at the delegation script with an inline datum (read.ts);
//   - the datum names this agent as the delegate and one of its delegation keys as the delegate key;
//   - the delegator is a principal key on the allowlist of the operator;
//   - the window has a start and an end, is one hour long at most, has not ended, and ends not too far ahead;
//   - the required signers are the delegator and the delegation key, and the delegation key has not signed the transaction yet;
//   - no other body that the agent signed holds the delegation key now, and no live delegation on the ledger names it;
//   - no input and no collateral input is an output of a wallet of a key of this agent, or of a script, or is unknown to the ledger.
// The checks run in this order. The ledger is read after every check that needs no network, the outputs first and the delegations second, and a read that fails is `check_unavailable` and never a pass.
// The signature is made over the hash of the bytes of the body, and the answer is the input with the one witness added (layout.ts): the agent checks that again before it answers.
import { CML } from '@lucid-evolution/lucid';
import { blake2b } from '@noble/hashes/blake2b';
import type { IdentityDeployment } from '@vsa/buyer-core';
import { within } from '@vsa/service-kit';
import { addressDetails, decodeTransaction } from '@vsa/vector-read/guarded-decode';
import { accepted, checkMembers, parseDid, parseJsonText, readMembers, refused } from '../protocol/index.ts';
import type { ManifestCosign, ProtocolResult, Refused } from '../protocol/index.ts';
import { COSIGN_PATH, MAX_COSIGN_REQUEST_BYTES, MAX_TRANSACTION_HEX, MAX_WINDOW_MS, RESERVATION_MARGIN_MS, SLOT_MS } from './codes.ts';
import type { CosignCode } from './codes.ts';
import { makeHandler } from './http.ts';
import type { CosignHandler } from './http.ts';
import { addVkeyWitness, bodyBytesOf, readFrame } from './layout.ts';
import type { CosignLedger, LedgerOutput } from './ledger.ts';
import { readDelegateTransaction } from './read.ts';
import type { DelegateFacts } from './read.ts';
import { KeyReservations } from './register.ts';
import { checkCosignSettings } from './settings.ts';
import type { CosignSettings } from './settings.ts';

/** One delegation key of the agent. The route gets the key through this function and reads no key file. */
export interface DelegationKey {
  /** The Ed25519 public key: 64 lower-case hex characters. */
  readonly publicKey: string;
  /** Signs the 32 bytes of a body hash and gives the 64 bytes of the signature. The route checks the signature before it uses it. */
  readonly sign: (bodyHash: Uint8Array) => Uint8Array | Promise<Uint8Array>;
}

export interface CosignConfig {
  /** The DID of the agent: `did:vector:` and 64 hex characters. */
  readonly agentDid: string;
  readonly deployment: IdentityDeployment;
  /** The delegation keys of the agent, one to eight. A delegation may name one of these keys and no other key. */
  readonly delegationKeys: readonly DelegationKey[];
  /** The key hashes (56 hex characters) of every other key of the agent: the service key, the supplier key, the keys of its subagents, and each key that its record lists. */
  readonly otherKeyHashes: readonly string[];
  readonly settings: CosignSettings;
  readonly ledger: CosignLedger;
  /** The start of the chain in POSIX ms: the time of slot 0. A slot is one second. */
  readonly systemStartMs: number;
  /** The clock, in POSIX ms. */
  readonly now: () => number;
  /** One line for each answer. The line has the code or the key and the start of the body hash, and nothing else of the request. */
  readonly log?: (line: string) => void;
}

/** What a good answer holds. */
export interface CosignSigned {
  /** The transaction with the one witness added, as lower-case hex. */
  readonly transaction: string;
  /** The hash of the body that the agent signed: 64 hex characters. */
  readonly bodyHash: string;
  /** The hash of the delegation key that signed: 56 hex characters. */
  readonly keyHash: string;
}

export interface CosignRoute {
  readonly path: typeof COSIGN_PATH;
  /** The function behind the route. It never throws: every failure is a typed refusal. */
  cosign(body: string | Uint8Array): Promise<ProtocolResult<CosignSigned, CosignCode>>;
  /** The handler that a service mounts at `POST /cosign/delegate`. It never throws. */
  readonly handle: CosignHandler;
}

/** The rule of the route in words, for `behaviour.cosign` of the manifest of a buyer-side agent. */
export const COSIGN_MANIFEST: ManifestCosign = {
  route: COSIGN_PATH,
  rule:
    'The agent signs one kind of transaction: a Delegate transaction of the delegation contract that names this agent as the delegate and one of its own delegation keys as the delegate key. ' +
    'The delegator must be a principal key on the allowlist of the operator. The delegation key must have no live delegation and no other signed transaction whose window is open. ' +
    'The transaction must spend nothing of the agent, and it must have no certificate, no withdrawal and no other mint. Its validity window must end in the future, and not too far ahead. ' +
    'The agent adds one witness of the delegation key and changes nothing else.',
};

const KEY_HASH = /^[0-9a-f]{56}$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
/** The largest slot that the route converts to a time: about 35,000 years. A slot above it is "too far ahead". */
const MAX_SLOT = 2n ** 40n;
const UNREADABLE = Symbol('unreadable');

const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(a, b) === 0;

interface Key {
  readonly publicKey: Uint8Array;
  readonly sign: DelegationKey['sign'];
}

/** The request body as the hex of the transaction, in lower case. Nothing is parsed before the size check. */
function parseRequest(body: unknown): ProtocolResult<string, 'bad_shape' | 'request_too_large'> {
  const bytes = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body instanceof Uint8Array ? body.byteLength : -1;
  if (bytes < 0) return refused('bad_shape', 'the request must be text or bytes');
  if (bytes > MAX_COSIGN_REQUEST_BYTES) return refused('request_too_large', `the request has more than ${MAX_COSIGN_REQUEST_BYTES} bytes`);
  let text: string;
  try {
    text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body as Uint8Array);
  } catch {
    return refused('bad_shape', 'the request is not UTF-8 text');
  }
  const json = parseJsonText(text, 'request');
  if (!json.ok) return json;
  const members = readMembers(json.value, 'request');
  if (!members.ok) return members;
  const unexpected = checkMembers(members.value, 'request', ['transaction']);
  if (unexpected !== null) return unexpected;
  const hex = members.value.transaction;
  if (typeof hex !== 'string' || hex.length > MAX_TRANSACTION_HEX || !HEX.test(hex)) return refused('bad_shape', 'request.transaction must be the hex of a transaction');
  return accepted(hex.toLowerCase());
}

/** True when `signature` verifies over `message` for `publicKey`. */
function verifies(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): boolean {
  try {
    return CML.PublicKey.from_bytes(publicKey).verify(message, CML.Ed25519Signature.from_raw_bytes(signature));
  } catch {
    return false;
  }
}

/**
 * The check of the answer before it leaves: the body bytes, the validity flag, the auxiliary data and each other entry of the witness set are the bytes of the input, the decoder reads the answer as it
 * is written, and its list of vkey witnesses is the old list and the witness of the delegation key at its end. A false here is a fault of the service, and the answer is not sent.
 */
function answerIsRight(facts: DelegateFacts, answer: Uint8Array, key: Key, signature: Uint8Array): boolean {
  const frame = readFrame(answer);
  if (frame === undefined || !sameBytes(bodyBytesOf(answer, frame), bodyBytesOf(facts.bytes, facts.frame))) return false;
  if (!sameBytes(answer.subarray(frame.witnesses.end), facts.bytes.subarray(facts.frame.witnesses.end))) return false;
  const others = (bytes: Uint8Array, entries: readonly { key: number; entry: { start: number; end: number } }[]) => entries.filter((e) => e.key !== 0).map((e) => hexOf(bytes.subarray(e.entry.start, e.entry.end)));
  if (others(answer, frame.witnesses.entries).join() !== others(facts.bytes, facts.frame.witnesses.entries).join()) return false;
  try {
    const hex = hexOf(answer);
    const tx = decodeTransaction(hex, 'the answer');
    if (tx.to_cbor_hex() !== hex || CML.hash_transaction(tx.body()).to_hex() !== hexOf(facts.bodyHash)) return false;
    const vkeys = tx.witness_set().vkeywitnesses();
    if (vkeys === undefined || vkeys.len() !== facts.witnessKeyHashes.length + 1) return false;
    const last = vkeys.get(vkeys.len() - 1);
    return sameBytes(last.vkey().to_raw_bytes(), key.publicKey) && sameBytes(last.ed25519_signature().to_raw_bytes(), signature);
  } catch {
    return false;
  }
}

/** The config, checked. The refusal names the setting and never repeats a value. */
function checkConfig(config: CosignConfig): ProtocolResult<{ agentId: string; keys: Map<string, Key>; agentKeys: Set<string>; settings: CosignSettings }, 'bad_setting'> {
  const bad = (detail: string) => refused('bad_setting', detail);
  const did = parseDid(config?.agentDid, 'agentDid');
  if (!did.ok) return bad('agentDid must be a DID of the form did:vector:<64 hex characters>');
  const hash = config.deployment?.delegation?.hash;
  const address = config.deployment?.delegation?.address;
  if (typeof hash !== 'string' || !KEY_HASH.test(hash) || typeof address !== 'string' || address === '') return bad('deployment must hold the hash and the address of the delegation script');
  if (!Array.isArray(config.delegationKeys) || config.delegationKeys.length < 1 || config.delegationKeys.length > 8) return bad('delegationKeys must be a list of one to eight keys');
  if (!Array.isArray(config.otherKeyHashes) || config.otherKeyHashes.length > 64 || config.otherKeyHashes.some((entry) => typeof entry !== 'string' || !KEY_HASH.test(entry))) {
    return bad('otherKeyHashes must be a list of at most 64 key hashes of 56 lower-case hex characters');
  }
  const keys = new Map<string, Key>();
  for (const key of config.delegationKeys) {
    if (typeof key?.publicKey !== 'string' || !/^[0-9a-f]{64}$/.test(key.publicKey) || typeof key.sign !== 'function') return bad('each delegation key needs a public key of 64 lower-case hex characters and a sign function');
    const publicKey = Uint8Array.from(Buffer.from(key.publicKey, 'hex'));
    const keyHash = hexOf(blake2b(publicKey, { dkLen: 28 }));
    if (keys.has(keyHash)) return bad('delegationKeys has the same key twice');
    keys.set(keyHash, { publicKey, sign: key.sign });
  }
  const settings = checkCosignSettings(config.settings);
  if (!settings.ok) return settings;
  if (typeof config.ledger?.outputs !== 'function' || typeof config.ledger?.delegateKeysInUse !== 'function') return bad('ledger must have the functions outputs and delegateKeysInUse');
  if (!Number.isSafeInteger(config.systemStartMs) || config.systemStartMs <= 0) return bad('systemStartMs must be a positive whole number of milliseconds');
  if (typeof config.now !== 'function') return bad('now must be a function');
  return accepted({ agentId: did.value.slice('did:vector:'.length), keys, agentKeys: new Set([...keys.keys(), ...config.otherKeyHashes]), settings: settings.value });
}

/**
 * The route for the agent of `config`. A config that is wrong is a refusal and the route is not made: a service that gets a refusal does not start. The route holds the register of the bodies that it
 * signed, and its limit for requests at one time, so a service makes one route and keeps it.
 */
export function createCosignRoute(config: CosignConfig): ProtocolResult<CosignRoute, 'bad_setting'> {
  const checked = checkConfig(config);
  if (!checked.ok) return checked;
  const { agentId, keys, agentKeys, settings } = checked.value;
  const { deployment, ledger, now: clock, systemStartMs, log } = config;
  const reservations = new KeyReservations();
  let running = 0;

  const slotMs = (slot: bigint): number | undefined => (slot < MAX_SLOT ? systemStartMs + Number(slot) * SLOT_MS : undefined);
  const unavailable = (): Refused<'check_unavailable'> => refused('check_unavailable', 'the agent could not read the ledger');
  const internal = (): Refused<'internal'> => refused('internal', 'the agent could not sign');
  /** One read of the ledger, with its time limit. It gives UNREADABLE when the read throws, takes too long, or gives a value of the wrong form. */
  async function read<T>(work: () => Promise<T>, formOk: (value: T) => boolean): Promise<T | typeof UNREADABLE> {
    try {
      const value = await within(Promise.resolve().then(work), settings.ledgerTimeoutMs);
      return formOk(value) ? value : UNREADABLE;
    } catch {
      return UNREADABLE;
    }
  }

  async function run(body: unknown): Promise<ProtocolResult<CosignSigned, CosignCode>> {
    const request = parseRequest(body);
    if (!request.ok) return request;
    const read1 = readDelegateTransaction(request.value, deployment);
    if (!read1.ok) return read1;
    const facts = read1.value;
    const { delegation } = facts;
    const key = keys.get(delegation.delegateKey);
    if (delegation.delegate !== agentId || key === undefined) return refused('not_for_this_agent', 'the delegation does not name this agent and one of its delegation keys');

    const now = clock();
    if (!Number.isFinite(now)) return internal();
    const from = slotMs(facts.validFromSlot);
    const to = slotMs(facts.validToSlot);
    if (from === undefined || to === undefined || !(from < to) || to - from > MAX_WINDOW_MS) return refused('not_a_delegation', 'the validity window is not the window of a Delegate');
    if (!(now < to)) return refused('expired', 'the validity window of the transaction has ended');
    if (!(to - now <= settings.maxFutureMs)) return refused('not_a_delegation', 'the validity window ends too far ahead');

    if (delegation.delegator.type !== 'PrincipalKey' || !settings.allowlist.has(delegation.delegator.hash)) return refused('principal_not_allowed', 'the agent does not accept delegations from this delegator');
    // The required signers are the delegator and the delegation key: both are there, and nothing else is. A list of the right length with a key twice has no delegation key, and it is refused.
    const wanted = [...new Set([delegation.delegator.hash, delegation.delegateKey])];
    if (facts.requiredSigners.length !== wanted.length || wanted.some((signer) => !facts.requiredSigners.includes(signer))) {
      return refused('not_a_delegation', 'the required signers must be the delegator and the delegation key');
    }
    if (facts.witnessKeyHashes.includes(delegation.delegateKey)) return refused('not_a_delegation', 'the transaction has a witness of the delegation key already');

    const bodyHash = hexOf(facts.bodyHash);
    const hold = reservations.take(delegation.delegateKey, bodyHash, to + RESERVATION_MARGIN_MS, now);
    if (hold === undefined) return refused('key_in_use', 'the delegation key is in use');
    try {
      const outputs = await read(() => ledger.outputs([...facts.spent]), (value) => Array.isArray(value));
      if (outputs === UNREADABLE) return unavailable();
      const byRef = new Map(outputs.map((output): [string, LedgerOutput] => [`${output?.txHash}#${output?.outputIndex}`, output]));
      let owned = false;
      let script = false;
      let unknown = false;
      for (const ref of facts.spent) {
        const output = byRef.get(`${ref.txHash}#${ref.outputIndex}`);
        if (output === undefined) {
          unknown = true;
          continue;
        }
        let credential;
        try {
          credential = addressDetails(output.address).paymentCredential;
        } catch {
          return unavailable();
        }
        if (credential === undefined) unknown = true;
        else if (credential.type === 'Script') script = true;
        else if (agentKeys.has(credential.hash)) owned = true;
      }
      if (owned) return refused('spends_agent_funds', 'the transaction spends an output of a wallet of this agent');
      if (script) return refused('not_a_delegation', 'the transaction spends a script output');
      if (unknown) return refused('not_a_delegation', 'the transaction spends an output that the ledger does not have, or that has no key');

      const used = await read(() => ledger.delegateKeysInUse(), (value) => typeof value?.has === 'function');
      if (used === UNREADABLE) return unavailable();
      if (used.has(delegation.delegateKey)) return refused('key_in_use', 'the delegation key is in use');

      let signature: Uint8Array;
      try {
        signature = Uint8Array.from(await key.sign(Uint8Array.from(facts.bodyHash)));
      } catch {
        return internal();
      }
      if (signature.length !== 64 || !verifies(key.publicKey, signature, facts.bodyHash)) return internal();
      const answer = addVkeyWitness(facts.bytes, facts.frame, key.publicKey, signature);
      if (answer === undefined || !answerIsRight(facts, answer, key, signature)) return internal();
      hold.commit();
      return accepted({ transaction: hexOf(answer), bodyHash, keyHash: delegation.delegateKey });
    } finally {
      hold.release();
    }
  }

  async function cosign(body: string | Uint8Array): Promise<ProtocolResult<CosignSigned, CosignCode>> {
    let result: ProtocolResult<CosignSigned, CosignCode>;
    if (running >= settings.maxConcurrent) {
      result = refused('busy', 'the agent is working on other requests');
    } else {
      running += 1;
      try {
        result = await run(body);
      } catch {
        result = internal();
      } finally {
        running -= 1;
      }
    }
    try {
      log?.(result.ok ? `cosign signed key ${result.value.keyHash.slice(0, 8)} body ${result.value.bodyHash.slice(0, 12)}` : `cosign refused ${result.code}`);
    } catch {
      // A log that fails does not change the answer.
    }
    return result;
  }

  return accepted({ path: COSIGN_PATH, cosign, handle: makeHandler(cosign) });
}
