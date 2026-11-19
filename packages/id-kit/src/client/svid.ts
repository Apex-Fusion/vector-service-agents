// packages/id-kit/src/client/svid.ts
// SPIFFE identity documents (SVIDs) of an agent. Its SPIFFE ID is `spiffe://<trust domain>/agent/<identifier>`, and the trust domain is the host of the gateway.
// - X.509-SVID: three steps. POST /spiffe/nonce gives a nonce. The client then signs a JWT with an authentication key of the agent (EdDSA or ES256) whose claims hold the nonce and
//   the public key of the new certificate (`cnf.jwk`), and it posts that JWT with a PKCS #10 request for the P-256 key. The certificate lasts at most one hour.
// - JWT-SVID: POST /spiffe/jwt-svid with a subject token and the audiences. It is an ES256 JWT that lasts at most five minutes.

import { KeyObject, X509Certificate, generateKeyPairSync } from 'node:crypto';
import { MAX_AUDIENCES, MAX_AUDIENCE_LENGTH } from '../common/constants.ts';
import { badBody, failureOf, jsonObject, send } from '../common/http.ts';
import { resolveKey, type KeyInput } from '../common/keys.ts';
import { accept, type GatewayResult } from '../common/result.ts';
import { createAgentJwt, createSubjectToken, type AgentIdentity } from './agent-jwt.ts';
import type { ClientContext } from './context.ts';
import { createCertificationRequest, pem } from './csr.ts';

export interface X509SvidRequest {
  /** The agent: its DID and an authentication key (Ed25519, or P-256 with a valid proof of possession in the record). */
  readonly agent: AgentIdentity;
  /** The P-256 key of the certificate. Leave it out and the client makes a new key, and gives its private key in the result. */
  readonly svidKey?: KeyInput;
}

export interface IssuedX509Svid {
  readonly spiffeId: string;
  /** The X.509-SVID, in PEM. */
  readonly certificate: string;
  /** The certificate of the CA of the trust domain, in PEM. */
  readonly bundle: string;
  /** When the certificate ends, in POSIX seconds. */
  readonly expiresAt: number;
  /** The private key of the certificate, if the client made the key. It is null when the caller gave the key. */
  readonly privateKey: KeyObject | null;
}

export interface JwtSvidRequest {
  /** The agent: its DID and its Ed25519 authentication key. */
  readonly agent: AgentIdentity;
  /** The audience of the JWT-SVID: 1 to 8 values of at most 512 characters. */
  readonly audience: string | readonly string[];
}

export interface IssuedJwtSvid {
  readonly spiffeId: string;
  /** The JWT-SVID: an ES256 JWT with `sub` = the SPIFFE ID. */
  readonly svid: string;
  /** When the JWT-SVID ends, in POSIX seconds. */
  readonly expiresAt: number;
}

const POST_JSON = { 'content-type': 'application/json', accept: 'application/json' } as const;

/** The nonce for one X.509-SVID request. It is single-use and it lasts five minutes. */
async function fetchNonce(ctx: ClientContext): Promise<GatewayResult<string>> {
  const outcome = await send(ctx, `${ctx.origin}/spiffe/nonce`, { method: 'POST', headers: { accept: 'application/json' } });
  if (!outcome.reached || outcome.reply.status !== 200) return failureOf(outcome, 'a nonce request');
  const nonce = jsonObject(outcome.reply.body)?.nonce;
  return typeof nonce === 'string' && nonce.length > 0 ? accept(nonce) : badBody(outcome.reply.status, 'the answer has no nonce');
}

export async function requestX509Svid(ctx: ClientContext, request: X509SvidRequest): Promise<GatewayResult<IssuedX509Svid>> {
  const svidKey: KeyInput = request.svidKey ?? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  const generated = request.svidKey === undefined && svidKey instanceof KeyObject ? svidKey : null;
  const key = resolveKey(svidKey, 'the key of the certificate');
  const jwk = key.jwk;
  if (key.kind !== 'P256' || jwk.kty !== 'EC') throw new TypeError('the key of an X.509-SVID is a P-256 key');
  const csr = pem('CERTIFICATE REQUEST', await createCertificationRequest(key));

  const nonce = await fetchNonce(ctx);
  if (!nonce.ok) return nonce;
  const proof = await createAgentJwt(request.agent, ctx.tokenEndpoint, { now: ctx.now, extraClaims: { nonce: nonce.value, cnf: { jwk: key.jwk } }, algorithms: ['EdDSA', 'ES256'] });
  const outcome = await send(ctx, `${ctx.origin}/spiffe/x509-svid`, { method: 'POST', headers: POST_JSON, body: JSON.stringify({ csr, proof }) });
  if (!outcome.reached || outcome.reply.status !== 200) return failureOf(outcome, 'an X.509-SVID request');

  const { status, body } = outcome.reply;
  const json = jsonObject(body);
  const { spiffe_id: spiffeId, x509_svid: certificate, bundle, expires_at: expiresAt } = json ?? {};
  if (typeof spiffeId !== 'string' || typeof certificate !== 'string' || typeof bundle !== 'string' || typeof expiresAt !== 'number') return badBody(status, 'the answer has not the four members of an X.509-SVID answer');
  let issued: X509Certificate;
  try {
    issued = new X509Certificate(certificate);
  } catch {
    return badBody(status, 'the certificate in the answer is not a certificate');
  }
  const issuedKey = issued.publicKey.export({ format: 'jwk' });
  if (issuedKey.x !== jwk.x || issuedKey.y !== jwk.y) return badBody(status, 'the certificate is not for the key of the request');
  return accept({ spiffeId, certificate, bundle, expiresAt, privateKey: generated });
}

export async function requestJwtSvid(ctx: ClientContext, request: JwtSvidRequest): Promise<GatewayResult<IssuedJwtSvid>> {
  const audiences = typeof request.audience === 'string' ? [request.audience] : request.audience;
  if (!Array.isArray(audiences) || audiences.length === 0 || audiences.length > MAX_AUDIENCES || !audiences.every((a) => typeof a === 'string' && a.length > 0 && a.length <= MAX_AUDIENCE_LENGTH)) {
    throw new TypeError(`the audience of a JWT-SVID is 1 to ${MAX_AUDIENCES} non-empty values of at most ${MAX_AUDIENCE_LENGTH} characters`);
  }
  const subjectToken = await createSubjectToken(request.agent, ctx.tokenEndpoint, { now: ctx.now });
  const outcome = await send(ctx, `${ctx.origin}/spiffe/jwt-svid`, { method: 'POST', headers: POST_JSON, body: JSON.stringify({ audience: audiences.length === 1 ? audiences[0] : audiences, subject_token: subjectToken }) });
  if (!outcome.reached || outcome.reply.status !== 200) return failureOf(outcome, 'a JWT-SVID request');
  const { spiffe_id: spiffeId, svid, expires_at: expiresAt } = jsonObject(outcome.reply.body) ?? {};
  if (typeof spiffeId !== 'string' || typeof svid !== 'string' || svid.split('.').length !== 3 || typeof expiresAt !== 'number') return badBody(outcome.reply.status, 'the answer has not the three members of a JWT-SVID answer');
  return accept({ spiffeId, svid, expiresAt });
}
