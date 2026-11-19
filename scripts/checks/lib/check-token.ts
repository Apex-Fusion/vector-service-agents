// scripts/checks/lib/check-token.ts - check 5: a delegation token, from the delegation of check 1, checked by the verifier of id-kit.
//
//   token   Waits until the delegation has 30 confirmations (the rule of the gateway for a delegation that it has not seen before), and says how long is left; it never sleeps. Then the
//           record asks the gateway for a token under the delegation: a token exchange with its subject token (signed by the authentication key) and a DPoP proof (signed by the
//           delegate key of the leaf delegation). The verifier of id-kit checks the token for a call that needs the action and the resource of the delegation: it must accept it. It then
//           checks a second call, with a new DPoP proof, for an action that the delegation does not grant: it must refuse it. The `status` of each verified call goes to the evidence.
//
// The step makes no transaction. It reads the state file of check 1 and never changes it.
import { iso } from './format.ts';
import { clientOf, delegationOfCheckOne, resolveRecord } from './gateway.ts';
import { createVerifier, presentToken } from './platform.ts';
import { runSteps, waitFor } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { PreconditionError } from './session.ts';
import type { Session } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';

/** The confirmations that the gateway wants for a delegation, and the seconds that a block takes on average on Vector (the active slot coefficient is 0.25 and a slot is a second). */
export const CONFIRMATIONS = 30;
export const BLOCK_SECONDS = 4;
export const UNGRANTED_ACTION = 'mainnet-checks.not-granted.v1';

export interface TokenSettings {
  /** The resource of the token, when the grant of the delegation is no URL. */
  resource: string | null;
}

export function parseTokenSettings(env: Env): TokenSettings {
  const reader = new EnvReader(env);
  const resource = reader.text('CHECKS_TOKEN_RESOURCE', false) ?? null;
  if (resource !== null) { try { if (new URL(resource).hash !== '') throw new Error('fragment'); } catch { reader.problems.push('CHECKS_TOKEN_RESOURCE must be an absolute URI with no fragment'); } }
  reader.done();
  return { resource };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The claims of a JWT that came from the gateway, for the evidence: the payload only, never the token. */
function claimsOf(jwt: string): Record<string, unknown> {
  try {
    const payload: unknown = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
    return isObject(payload) ? payload : {};
  } catch {
    return {};
  }
}

/** What the hosted tool says about the confirmations of the delegation: the number, or null when it does not say. */
function confirmationsOf(answer: Record<string, unknown>): number | null {
  const confirmations = answer.confirmations;
  const links = isObject(confirmations) && Array.isArray(confirmations.links) ? confirmations.links : [];
  const first: unknown = links[0];
  return isObject(first) && typeof first.confirmations === 'number' ? first.confirmations : null;
}

const token: StepHandler<TokenSettings> = {
  name: 'token',
  async run(session: Session<TokenSettings>) {
    const delegation = delegationOfCheckOne(session);
    const action = delegation.actions[0];
    const resource = session.extra.resource ?? delegation.resources[0];
    if (action === undefined || resource === undefined || !/^https?:\/\//.test(resource)) {
      throw new PreconditionError('the delegation of check 1 grants no action, or no resource that is a URL: set CHECKS_TOKEN_RESOURCE to a URL that its resource covers');
    }
    const asked = await session.hosted.call('vector_check_delegation_use', { delegation: delegation.id, action, resource, min_confirmations: CONFIRMATIONS });
    if (asked.failed || asked.json === null) throw new Error(`the hosted tool vector_check_delegation_use failed: ${asked.message || 'its answer has no JSON block'}`);
    const confirmations = confirmationsOf(asked.json);
    if (confirmations !== null && confirmations < CONFIRMATIONS) {
      const left = (CONFIRMATIONS - confirmations) * BLOCK_SECONDS * 1000;
      return waitFor(session.clock.now() + left, session.clock.now(), `the delegation has ${confirmations} of ${CONFIRMATIONS} confirmations that the gateway wants (a block takes ${BLOCK_SECONDS} seconds on average)`);
    }
    if (asked.json.usable !== true) {
      if (confirmations === null) return waitFor(session.clock.now() + 60_000, session.clock.now(), 'the hosted tool does not yet say how many confirmations the delegation has');
      throw new PreconditionError(`the delegation cannot be used for ${action} on ${resource}: ${Array.isArray(asked.json.problems) ? asked.json.problems.join('; ') : 'the hosted tool gave no reason'}`);
    }
    await resolveRecord(session, true);
    session.out.out(`the delegation ${delegation.id} has ${confirmations ?? 'at least 30'} confirmations and can be used for ${action} on ${resource}`);
    session.out.out(`the record would ask ${session.settings.urls.gateway}/token for a token for ${resource} under the delegation, with a DPoP proof of the delegate key ${delegation.delegateKeyHash}`);
    if (session.mode === 'dry') return { kind: 'dry' };

    const auth = session.authKey!;
    const agent = session.ring.get('agent');
    if (agent.keyHash !== delegation.delegateKeyHash) throw new PreconditionError('the agent key is not the delegate key of the delegation of check 1');
    const issued = await clientOf(session).requestToken({ subject: { did: session.settings.recordDid, key: auth.jwsKey() }, dpopKey: agent.jwsKey(), resource, delegation: { identifier: delegation.id } });
    if (!issued.ok) throw new Error(`the gateway refused the token request: ${issued.rule}: ${issued.detail}`);
    const verifier = createVerifier({ baseUrl: session.settings.urls.gateway, fetch: session.fetchImpl, now: () => session.clock.now() });
    const verify = async (required: string) => {
      const headers = await presentToken(issued.value.accessToken, agent.jwsKey(), { method: 'POST', url: resource }, { now: () => session.clock.now() });
      return verifier.accessToken({ authorization: headers.authorization, dpop: headers.dpop, method: 'POST', url: resource }, { audience: resource, require: { action: required, resource } });
    };
    const granted = await verify(action);
    const ungranted = await verify(UNGRANTED_ACTION);
    const problems: string[] = [];
    if (!granted.ok) problems.push(`the verifier refused the token for ${action}: ${granted.rule}: ${granted.detail}`);
    if (ungranted.ok) problems.push(`the verifier accepted the token for ${UNGRANTED_ACTION}, which the delegation does not grant`);
    else if (ungranted.rule !== 'delegation.action') problems.push(`the verifier refused the ungranted action for the rule ${ungranted.rule}, and not for delegation.action: ${ungranted.detail}`);
    const shows = {
      delegation: delegation.id, resource, action, claims: claimsOf(issued.value.accessToken), expires_in: issued.value.expiresIn,
      granted: granted.ok ? { ok: true, principal: granted.value.principal, actors: granted.value.actors, delegation: granted.value.delegation, status: granted.value.status } : { ok: false, rule: granted.rule, detail: granted.detail },
      ungranted: ungranted.ok ? { ok: true } : { ok: false, rule: ungranted.rule, detail: ungranted.detail },
    };
    if (problems.length > 0) {
      session.evidence.add({ step: 'token', status: 'info', shows: { ...shows, problems } });
      throw new Error(problems.join('; '));
    }
    session.state.recordStep('token', { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: { delegation_id: delegation.id }, facts: { jti: claimsOf(issued.value.accessToken).jti ?? null, resource, action } });
    session.evidence.add({ step: 'token', status: 'info', shows });
    return { kind: 'done', message: `the verifier accepted the token for ${action} and refused it for ${UNGRANTED_ACTION}` };
  },
};

export const tokenCheck: CheckDefinition<TokenSettings> = {
  name: 'delegation-token',
  title: 'a delegation token of the test record, from the delegation of check 1, checked by the verifier',
  needs: { keys: ['agent'], chain: false, hosted: ['vector_check_delegation_use'] },
  steps: ['token'],
  parse: (env) => parseTokenSettings(env),
  next: (session, flags) => runSteps(session, [token], flags),
  cleanup: async () => ({ kind: 'done', message: 'nothing to take back: the token makes no transaction and ends within five minutes; the delegation is ended by check 1' }),
};
