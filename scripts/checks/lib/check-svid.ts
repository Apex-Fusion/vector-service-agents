// scripts/checks/lib/check-svid.ts - check 6: SVIDs of the test record against a verifier behind a host that asks for a client certificate.
//
//   x509   The record gets an X.509-SVID from the gateway (the client makes a P-256 key, and the agent key signs the proof). The client presents the certificate as the TLS client
//          certificate to the verifier (06-svid-verifier.ts) behind the proxy, which passes it in the header Client-Cert. The verifier checks the chain against the SPIFFE bundle, the
//          time and the SPIFFE ID, and says that the certificate is the one of the record. A second call with no certificate is refused.
//   jwt    The record gets a JWT-SVID for the audience of the verifier, and the verifier accepts it. A JWT-SVID for another audience is refused.
//
// The organisation of the record is not checked here. No transaction is made: the steps sign the proofs of the gateway with the agent key, and they cost nothing.
import { iso } from './format.ts';
import { clientOf, resolveRecord } from './gateway.ts';
import { mtlsGet } from './mtls.ts';
import { runSteps } from './runner.ts';
import type { CheckDefinition, StepHandler } from './runner.ts';
import { PreconditionError } from './session.ts';
import type { Session } from './session.ts';
import { EnvReader } from './settings.ts';
import type { Env } from './settings.ts';

export interface SvidSettings {
  /** The URL of the host that asks for a client certificate (https), or of a verifier on a loopback address, for a run on one machine. */
  verifierUrl: string;
  /** The audience that a JWT-SVID must name. */
  audience: string;
}

export function parseSvidSettings(env: Env): SvidSettings {
  const reader = new EnvReader(env);
  const verifierUrl = reader.url('CHECKS_SVID_VERIFIER_URL', undefined);
  const audience = reader.text('CHECKS_SVID_AUDIENCE', false) ?? verifierUrl;
  reader.done();
  return { verifierUrl, audience };
}

interface Answer { status: number; body: Record<string, unknown> }

function parseAnswer(response: { status: number; body: string }): Answer {
  try {
    const parsed: unknown = JSON.parse(response.body);
    return { status: response.status, body: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {} };
  } catch {
    return { status: response.status, body: {} };
  }
}

/** The SPIFFE ID of the record: the trust domain is the host of the gateway. */
const spiffeIdOf = (session: Session<SvidSettings>): string => `spiffe://${new URL(session.settings.urls.gateway).hostname}/agent/${session.settings.recordId}`;

async function preflight(session: Session<SvidSettings>): Promise<void> {
  await resolveRecord(session, false);
  const health = await session.fetchImpl(`${session.extra.verifierUrl}/health`, { signal: AbortSignal.timeout(15_000) }).then((r) => r.status, () => 0);
  if (health !== 200) throw new PreconditionError(`the verifier does not answer 200 on ${session.extra.verifierUrl}/health: it is not running, or the host is not set up`);
  session.out.out(`the verifier answers on ${session.extra.verifierUrl}`);
}

function record(session: Session<SvidSettings>, step: string, shows: Record<string, unknown>): void {
  session.state.recordStep(step, { confirmed_at: iso(session.clock.now()), tx_hash: null, refs: {}, facts: shows });
  session.evidence.add({ step, status: 'info', shows });
}

const x509: StepHandler<SvidSettings> = {
  name: 'x509',
  async run(session) {
    await preflight(session);
    session.out.out(`the record would get an X.509-SVID (spiffe id ${spiffeIdOf(session)}) from ${session.settings.urls.gateway} and present it to ${session.extra.verifierUrl}/svid/x509`);
    if (session.mode === 'dry') return { kind: 'dry' };
    const auth = session.authKey!;
    const issued = await clientOf(session).x509Svid({ agent: { did: session.settings.recordDid, key: auth.jwsKey() } });
    if (!issued.ok) throw new Error(`the gateway refused the X.509-SVID request: ${issued.rule}: ${issued.detail}`);
    const { certificate, privateKey, spiffeId, expiresAt } = issued.value;
    if (privateKey === null) throw new Error('the client gave no private key for the certificate');
    const accepted = parseAnswer(await mtlsGet(`${session.extra.verifierUrl}/svid/x509`, { certificatePem: certificate, privateKey }));
    const none = parseAnswer(await mtlsGet(`${session.extra.verifierUrl}/svid/x509`, null));
    const problems: string[] = [];
    if (accepted.status !== 200 || accepted.body.ok !== true) problems.push(`the verifier did not accept the certificate: ${accepted.status} ${String(accepted.body.rule ?? '')} ${String(accepted.body.detail ?? '')}`.trim());
    else if (accepted.body.spiffe_id !== spiffeId || spiffeId !== spiffeIdOf(session)) problems.push('the verifier accepted a certificate of another SPIFFE ID than the one of the record');
    if (none.status !== 401 || none.body.rule !== 'client_certificate.missing') problems.push(`the verifier did not refuse a call with no certificate: ${none.status}`);
    const shows = { spiffe_id: spiffeId, expires_at: expiresAt * 1000, verifier_answer: accepted.body, no_certificate_answer: none.body };
    if (problems.length > 0) {
      session.evidence.add({ step: 'x509', status: 'info', shows: { ...shows, problems } });
      throw new Error(problems.join('; '));
    }
    record(session, 'x509', shows);
    return { kind: 'done', message: `the verifier accepted the X.509-SVID of ${spiffeId}, and refused a call with no certificate` };
  },
};

const jwt: StepHandler<SvidSettings> = {
  name: 'jwt',
  async run(session) {
    await preflight(session);
    session.out.out(`the record would get a JWT-SVID for the audience ${session.extra.audience} and send it to ${session.extra.verifierUrl}/svid/jwt`);
    if (session.mode === 'dry') return { kind: 'dry' };
    const client = clientOf(session);
    const agent = { did: session.settings.recordDid, key: session.authKey!.jwsKey() };
    const own = await client.jwtSvid({ agent, audience: session.extra.audience });
    if (!own.ok) throw new Error(`the gateway refused the JWT-SVID request: ${own.rule}: ${own.detail}`);
    const other = await client.jwtSvid({ agent, audience: `${session.extra.audience}/other` });
    if (!other.ok) throw new Error(`the gateway refused the JWT-SVID request: ${other.rule}: ${other.detail}`);
    const send = async (token: string): Promise<Answer> => parseAnswer(await session.fetchImpl(`${session.extra.verifierUrl}/svid/jwt`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }).then(async (r) => ({ status: r.status, body: await r.text() })));
    const accepted = await send(own.value.svid);
    const refused = await send(other.value.svid);
    const problems: string[] = [];
    if (accepted.status !== 200 || accepted.body.ok !== true) problems.push(`the verifier did not accept the JWT-SVID: ${accepted.status} ${String(accepted.body.rule ?? '')}`.trim());
    else if (accepted.body.spiffe_id !== spiffeIdOf(session)) problems.push('the verifier accepted a JWT-SVID of another SPIFFE ID than the one of the record');
    if (refused.status !== 401 || refused.body.rule !== 'jwt_svid.audience') problems.push(`the verifier did not refuse the JWT-SVID of another audience: ${refused.status} ${String(refused.body.rule ?? '')}`.trim());
    const shows = { spiffe_id: own.value.spiffeId, expires_at: own.value.expiresAt * 1000, verifier_answer: accepted.body, other_audience_answer: refused.body };
    if (problems.length > 0) {
      session.evidence.add({ step: 'jwt', status: 'info', shows: { ...shows, problems } });
      throw new Error(problems.join('; '));
    }
    record(session, 'jwt', shows);
    return { kind: 'done', message: `the verifier accepted the JWT-SVID of ${own.value.spiffeId}, and refused one for another audience` };
  },
};

export const svidCheck: CheckDefinition<SvidSettings> = {
  name: 'svid',
  title: 'the test record gets an X.509-SVID and a JWT-SVID, and a verifier behind a client certificate host checks both',
  needs: { keys: ['agent'], chain: false, hosted: [] },
  steps: ['x509', 'jwt'],
  parse: (env) => parseSvidSettings(env),
  next: (session, flags) => runSteps(session, [x509, jwt], flags),
  cleanup: async () => ({ kind: 'done', message: 'nothing to take back: an SVID makes no transaction and has no deposit; an X.509-SVID ends within one hour and a JWT-SVID within five minutes' }),
};
