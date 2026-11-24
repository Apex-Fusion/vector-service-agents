// agents/sourcing-agent/src/facts/credential.ts
// The identity credential of an agent, as a fact for the file of a bidder. The gateway issues the credential only while the agent is Active. The verifier checks its signature, its subject and its time, and it reads
// the status list of the gateway for the revocation bit and the suspension bit of the agent. The fact is one word:
//
//   valid       the gateway gave a credential and the verifier accepted it, so the status list shows the agent as neither revoked nor suspended
//   invalid     the verifier refused the credential for a rule of the credential: a bad signature, another subject, a time that is over, a bit that is set
//   absent      the gateway issues none: it does not know the agent (404), the agent is not Active (409) or its record ended (410)
//   unreadable  a source could not be read or used: the gateway did not answer (503 while it builds its lists, a network failure, a bad answer, no answer in time), the key set could not be read or used, or the
//               verifier could not read the status list in time or could not use the list that it read. This is no verdict on the agent, and it is never `valid`
//
// Each word comes from the typed result of a port, from a status or a rule, and never from a text. No word of the gateway or of the verifier reaches the result. An answer that has not the form of a result is
// `unreadable`, and so is a refusal whose rule this file does not know: it is no rule of the credential, so it is no verdict on the credential. This file reads no network, no file and no environment variable, and it
// holds no key: the sources are ports.
import type { Check, GatewayResult } from '@vsa/id-kit/client';
import { callPort } from './bound.ts';
import type { FactClock } from './bound.ts';

/** The word for the credential of an agent, as the file of a bidder holds it. */
export type FactState = 'valid' | 'invalid' | 'absent' | 'unreadable';

export interface CredentialDeps {
  /** The credential of an agent as a compact JWS, or the failure of the call. `GatewayClient.credential` of the identity kit has this shape. */
  readonly fetchCredential: (did: string) => Promise<GatewayResult<string>>;
  /** Checks the credential for this subject and reads the status list. `Verifier.credential` of the identity kit has this shape. */
  readonly verify: (jwt: string, policy: { readonly subject: string }) => Promise<Check<unknown, string>>;
  readonly clock: FactClock;
}

/** The statuses with which the gateway says that it issues no credential: 404 for an agent that it does not know, 409 for an agent that is not Active and 410 for a record that ended. */
const NO_CREDENTIAL_STATUSES: readonly number[] = [404, 409, 410];

/** The rules with which the verifier says that a source failed: the key set could not be read, or the status list was not read in time, or it was read and cannot be used. A rule of the key set starts with `jwks.`. */
const NOT_READ_RULES: readonly string[] = ['keys.unavailable', 'credential.status_unknown', 'credential.status_list'];

/**
 * The word for the answer of the verifier. The type says what a check is, and the port is not trusted to keep to it: an answer that is no object, that has no `ok` of true or false, or that refuses with a rule
 * that is no text is `unreadable`.
 */
function wordOfCheck(check: Check<unknown, string>): FactState {
  if (typeof check !== 'object' || check === null) return 'unreadable';
  if (check.ok === true) return 'valid';
  if (check.ok !== false || typeof check.rule !== 'string') return 'unreadable';
  if (NOT_READ_RULES.includes(check.rule) || check.rule.startsWith('jwks.')) return 'unreadable';
  return check.rule.startsWith('credential.') ? 'invalid' : 'unreadable';
}

/**
 * The word for the credential of the agent with the DID `did`. It never throws. The gateway is asked one time, and the verifier is asked one time and only for a credential that the gateway gave. Each call has
 * the bound of `FACT_READ_TIMEOUT_MS`, and nothing is retried.
 */
export async function readCredential(deps: CredentialDeps, did: string): Promise<FactState> {
  const fetched = await callPort(deps.clock, () => deps.fetchCredential(did));
  if (!fetched.ok) return 'unreadable';
  const answer = fetched.value;
  if (typeof answer !== 'object' || answer === null) return 'unreadable';
  if (answer.ok === false) return NO_CREDENTIAL_STATUSES.includes(answer.status) ? 'absent' : 'unreadable';
  const jwt = answer.value;
  if (answer.ok !== true || typeof jwt !== 'string' || jwt === '') return 'unreadable';
  const checked = await callPort(deps.clock, () => deps.verify(jwt, { subject: did }));
  return checked.ok ? wordOfCheck(checked.value) : 'unreadable';
}
