// agents/insurer-intake-agent/src/job/requirements.ts
// Step 4 of the job of the Insurer Intake Agent (use case 2, prior authorization): the requirement set of the insurer portal for the service code of the request. The portal says what a request for that
// service must show, and the model decides later whether the request shows it. The read is one GET with the JWT-SVID of step 3, and no body.
//
// Every failure of this step is `mock_system_failed`: a refusal of the portal (401 or 403), a failure (any other status, an answer that is not JSON, no answer within the time of the call), an answer that is no
// requirement set, a set for another service code than the one that was asked for, and a call that the kit refuses to send (a target that cannot be made, a JWT-SVID for another tenant or one that has ended). A
// code of the portal is never a code of this job: the code, the status and the way of the failure go to the log, and the text that the buyer reads is fixed. The log never holds the body of an answer: a body can
// repeat what was sent. The detail of the parser names a member of the body, so a body that is no requirement set gets a fixed reason and no detail. A refusal that the kit makes before it sends gives its own
// fixed reason. The longest time of the call is `calls.timeoutMs`.
import { callWithJwtSvid, jwtSvidTarget } from '@vsa/usecase-kit/access';
import type { JwtSvidCredential, SystemFailed, SystemRefused } from '@vsa/usecase-kit/access';
import { parseRequirementSet } from '@vsa/usecase-kit/priorauth';
import type { RequirementSet } from '@vsa/usecase-kit/priorauth';
import type { IntakeDeps } from './ports.ts';
import { INTAKE_REFUSAL_TEXT, refuse } from './refusal.ts';
import type { IntakeRefusal } from './refusal.ts';

/**
 * What a failed call to the portal says in the log: the status and the code that the portal gave, or the fixed reason of the kit for a call that it did not send. Never the detail of a call that was sent: a
 * detail repeats a part of the answer or of an error.
 */
function describeFailure(result: SystemRefused | SystemFailed): string {
  if (result.code === 'refused_by_system') return `refused by the portal (status ${result.status}, reason ${result.reason})`;
  if (!result.sent) return `failed (not sent: ${result.detail})`;
  const what = result.status === null ? 'no answer' : `status ${result.status}`;
  return `failed (${what}${result.systemCode === null ? '' : `, code ${result.systemCode}`})`;
}

/**
 * Reads the requirement set for `serviceCode` from the insurer system of `tenant` with `svid`, or throws an `IntakeRefusal` with the code `mock_system_failed`. The set is the copy that the kit parser made, and
 * its `service_code` is the one that was asked for. See the head of this file for the failures.
 */
export async function readRequirements(deps: Pick<IntakeDeps, 'calls' | 'log'>, svid: JwtSvidCredential, tenant: string, serviceCode: string): Promise<RequirementSet> {
  const fail = (why: string): IntakeRefusal => refuse(deps.log, 'mock_system_failed', INTAKE_REFUSAL_TEXT.mock_system_failed, why);
  const target = jwtSvidTarget(deps.calls.bases, tenant, 'insurer.requirements', { service_code: serviceCode });
  if (!target.ok) throw fail(`the target of the read of the requirements cannot be made: ${target.detail}`);
  const answer = await callWithJwtSvid(deps.calls, svid, target.value);
  if (!answer.ok) throw fail(`the read of the requirements ${describeFailure(answer)}`);
  const set = parseRequirementSet(answer.body);
  if (!set.ok) throw fail('the answer of the portal is no requirement set');
  if (set.value.service_code !== serviceCode) throw fail('the requirement set is for another service code than the one that was asked for');
  return set.value;
}
