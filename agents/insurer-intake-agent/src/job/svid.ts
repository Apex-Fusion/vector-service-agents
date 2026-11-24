// agents/insurer-intake-agent/src/job/svid.ts
// Step 3 of the job of the Insurer Intake Agent (use case 2, prior authorization): the JWT-SVID. The insurer portal takes a call only with a JWT-SVID of an agent whose record names the insurer organisation,
// and the audience of that JWT-SVID is the insurer system of the tenant: `<public base>/t/<tenant>/insurer`. Both routes of the job are below that audience, the read of the requirement set and the filing, so
// one JWT-SVID serves them both. The JWT-SVID is for the service key: the gateway issues it after it checks a subject token that the key signed.
//
// A failure of the gateway is `svid_failed`: a refusal, an answer that is no JWT-SVID or names another audience than the one that was asked for, a gateway that is down, and an audience that cannot be made from
// the two bases and the tenant (in that last case nothing is sent). The code and the status of the gateway go to the log, and never to the text that the buyer reads. The credential keeps its token private, and
// this step never writes the token, the subject token or the key to a log. A JWT-SVID lasts at most five minutes, so a later step that needs one after a long wait asks for it again.
import { fetchJwtSvid, jwtSvidTarget } from '@vsa/usecase-kit/access';
import type { JwtSvidCredential } from '@vsa/usecase-kit/access';
import type { IntakeDeps } from './ports.ts';
import { INTAKE_REFUSAL_TEXT, refuse } from './refusal.ts';

/**
 * Gets the JWT-SVID of the service key for the insurer system of `tenant`, or throws an `IntakeRefusal` with the code `svid_failed`. It makes one request to the gateway, and the time bound of that request is the
 * one of the client of the gateway in `deps.svid`.
 */
export async function fetchSvid(deps: Pick<IntakeDeps, 'agent' | 'svid' | 'calls' | 'log'>, tenant: string): Promise<JwtSvidCredential> {
  // The audience is the resource of the insurer system of the tenant, and both routes of the job share it. The route with no path parameter gives it.
  const target = jwtSvidTarget(deps.calls.bases, tenant, 'insurer.requests');
  if (!target.ok) throw refuse(deps.log, 'svid_failed', INTAKE_REFUSAL_TEXT.svid_failed, `the audience of the JWT-SVID cannot be made: ${target.detail}`);
  const svid = await fetchJwtSvid(deps.svid, { did: deps.agent.did, key: deps.agent.authenticationKey }, target.value);
  if (!svid.ok) throw refuse(deps.log, 'svid_failed', INTAKE_REFUSAL_TEXT.svid_failed, `the gateway gave no JWT-SVID: ${svid.code} (status ${svid.status})`);
  return svid.value;
}
