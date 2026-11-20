// packages/usecase-kit/src/checks/sender.ts
// The checks of the sender, one function for each check, in the order that a counterparty runs them:
//   - the sender resolves and its effective status is Active                      (sender_not_active)
//   - an Accountable Party covers the record now                                  (sender_unaccountable)
//   - the buyer key of the escrow is a key that the record lists for delegation   (sender_key_mismatch)
// Each function takes the DID resolution of the sender that the gateway gave, and it reads nothing. The first check also takes the DID that was asked. It checks the type of the answer
// (answers.ts): an answer of the wrong type, or for another DID, is `check_unavailable`, and it is never the code of a rule.
// The buyer key comes from the job context of the runtime, which the runtime read from the escrow on the ledger. It never comes from the body of the request: the sender chooses the body.
import type { Resolution } from '@vsa/id-kit/client';
import { accepted, isPlainObject, refused } from '../protocol/index.ts';
import type { Did, ProtocolResult } from '../protocol/index.ts';
import { resolutionOf } from './answers.ts';

/** A resolution of a record that exists and has not ended. */
export type ResolvedSender = Extract<Resolution, { readonly kind: 'resolved' }>;

/** What the sender check learned about the organisation of the sender. It is recorded, and it is never a reason to refuse. */
export interface SenderFacts {
  /** The organisation that the covering Accountable Party names, or null. */
  readonly organisation: string | null;
  /** True only when the gateway says that it verified that organisation. */
  readonly organisationVerified: boolean;
}

// The gateway writes a time as ISO 8601 in UTC, to the second. Any other text is not a time that this code reads.
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A time of the metadata in milliseconds, or null when the value is not a time in the form of the gateway. */
function timeOf(value: unknown): number | null {
  if (typeof value !== 'string' || !TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The sender resolves and its effective status is Active. A record that does not exist, a record that ended and a status other than Active are `sender_not_active`.
 * The one other cause that the gateway names is a record with no Accountable Party that covers it. It is the cause of the second check. See the comment at the code below.
 * Only the kind `resolved` goes on. A kind that this code does not know, and an answer of the wrong type or for another DID, are `check_unavailable`. They are never a pass.
 */
export function checkSenderActive(answer: Resolution, sender: Did): ProtocolResult<ResolvedSender, 'sender_not_active' | 'sender_unaccountable' | 'check_unavailable'> {
  const checked = resolutionOf(answer, sender);
  if (!checked.ok) return checked;
  const resolution = checked.value;
  if (resolution.kind === 'not_found') return refused('sender_not_active', 'the sender has no record at the identity gateway');
  if (resolution.kind === 'deactivated') return refused('sender_not_active', `the record of the sender has ended (${resolution.effectiveStatus})`);
  if (resolution.effectiveStatus === 'active') return accepted(resolution);
  // Decided: a sender that is suspended because no Accountable Party covers it gets `sender_unaccountable`, and not `sender_not_active`.
  // The gateway counts this cause in its effective status. A check on the status alone would never give the code of the second check. Any other suspension is `sender_not_active`.
  if (resolution.effectiveStatus === 'suspended' && resolution.effectiveReason === 'unaccountable') return refused('sender_unaccountable', 'no Accountable Party covers the record of the sender now');
  return refused('sender_not_active', `the sender is not Active (${resolution.effectiveStatus})`);
}

/**
 * An Accountable Party covers the record at the time `nowMs`: its start is not after that time, and it has no end or its end is not before that time.
 * The parties come from the metadata of the resolution. A record with no party, and a record with no Accountable Party that covers, are `sender_unaccountable`. A list of parties that
 * is not a list, and an Accountable Party with a time that this code cannot read, are an answer that cannot be used: `check_unavailable`. They are never a pass.
 */
export function checkSenderAccountable(resolution: ResolvedSender, nowMs: number): ProtocolResult<SenderFacts, 'sender_unaccountable' | 'check_unavailable'> {
  const parties = resolution.metadata.vectorParties;
  if (parties === undefined) return refused('sender_unaccountable', 'the record of the sender lists no Accountable Party');
  if (!Array.isArray(parties)) return refused('check_unavailable', 'the parties of the record of the sender are not a list');
  let covering: SenderFacts | null = null;
  for (const party of parties as readonly unknown[]) {
    if (!isPlainObject(party)) return refused('check_unavailable', 'a party of the record of the sender is not an object');
    if (party.role !== 'accountable') continue;
    const from = timeOf(party.notBefore);
    const until = party.notAfter === undefined ? null : timeOf(party.notAfter);
    if (from === null || (party.notAfter !== undefined && until === null)) return refused('check_unavailable', 'an Accountable Party has a time that cannot be read');
    if (covering === null && from <= nowMs && (until === null || until >= nowMs)) {
      covering = { organisation: typeof party.organisation === 'string' ? party.organisation : null, organisationVerified: party.organisationVerified === true };
    }
  }
  return covering === null ? refused('sender_unaccountable', 'no Accountable Party covers the record of the sender now') : accepted(covering);
}

/**
 * The key hash that the runtime read from the escrow is a key that the record lists with the delegation purpose. Only an Ed25519 key counts: the delegation purpose is not defined
 * for another kind of key. `buyerPkh` is 56 lower-case hex characters, from the job context.
 */
export function checkSenderKey(resolution: ResolvedSender, buyerPkh: string): ProtocolResult<null, 'sender_key_mismatch'> {
  // The purposes must be a list. A text has `includes` too, and it matches a part of the text.
  const listed = resolution.keys.some((key) => key.type === 'Ed25519' && key.keyHash === buyerPkh && Array.isArray(key.purposes) && key.purposes.includes('delegation'));
  return listed ? accepted(null) : refused('sender_key_mismatch', 'the record of the sender does not list the key of the escrow with the delegation purpose');
}
