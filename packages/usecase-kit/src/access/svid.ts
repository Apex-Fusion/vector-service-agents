// packages/usecase-kit/src/access/svid.ts
// The SVIDs of a counterparty. A counterparty calls the system of its own organisation with an SVID of its own record, and not with a token: the Order Desk with an X.509-SVID as the TLS client
// certificate, the Insurer Intake Agent with a JWT-SVID. The key of an X.509-SVID is made in memory for one job. It is private in its object, and it is never written to a file or to a log.
import { inspect } from 'node:util';
import { X509Certificate, type KeyObject } from 'node:crypto';
import type { GatewayClient, KeyInput } from '@vsa/id-kit/client';
import { accepted, parseDid, type Accepted, type Did } from '../protocol/index.ts';
import { fromRule, fromThrown, gatewayFailure, noting, type GatewayFailure } from './gateway.ts';
import type { JwtSvidTarget } from './routes.ts';

export interface SvidDeps {
  /** The client of the gateway, made with the `fetch` and the clock of the caller. */
  readonly client: Pick<GatewayClient, 'x509Svid' | 'jwtSvid'>;
}

/** The record of the caller: its DID and an authentication key of its record. EdDSA signs the proof of an X.509-SVID request and the subject token of a JWT-SVID request. */
export interface SvidAgent {
  readonly did: Did;
  readonly key: KeyInput;
}

/** What a TLS client needs to present an X.509-SVID: the certificate and its private key, both as PEM text. */
export interface TlsCredentials {
  readonly cert: string;
  readonly key: string;
}

/** An X.509-SVID with the private key of its certificate. The key stays in this object: no property, no JSON text and no log line shows it. `tls` gives it to a TLS client. */
export class X509SvidCredential {
  readonly spiffeId: string;
  /** The certificate, as PEM text. It is public. */
  readonly certificate: string;
  /** The certificate of the authority of the trust domain, as PEM text. */
  readonly bundle: string;
  /** When the certificate ends, in POSIX milliseconds. */
  readonly expiresAt: number;
  readonly #key: KeyObject;

  /** Made by `fetchX509Svid` only. */
  constructor(facts: { spiffeId: string; certificate: string; bundle: string; expiresAt: number }, key: KeyObject) {
    this.spiffeId = facts.spiffeId;
    this.certificate = facts.certificate;
    this.bundle = facts.bundle;
    this.expiresAt = facts.expiresAt;
    this.#key = key;
  }

  /** The certificate and the key as a TLS client takes them. The key text is made at each call and the object does not keep it. */
  tls(): TlsCredentials {
    return { cert: this.certificate, key: this.#key.export({ format: 'pem', type: 'pkcs8' }).toString() };
  }

  toJSON(): { spiffeId: string; expiresAt: number } {
    return { spiffeId: this.spiffeId, expiresAt: this.expiresAt };
  }

  toString(): string {
    return `X509SvidCredential(${this.spiffeId})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

/** A JWT-SVID. The token is private in its object. `bearer` gives the value of the `Authorization` header of one call. */
export class JwtSvidCredential {
  readonly spiffeId: string;
  /** The audiences that the JWT-SVID names. */
  readonly audience: readonly string[];
  /** When the JWT-SVID ends, in POSIX milliseconds. */
  readonly expiresAt: number;
  readonly #svid: string;

  /** Made by `fetchJwtSvid` only. */
  constructor(facts: { spiffeId: string; audience: readonly string[]; expiresAt: number }, svid: string) {
    this.spiffeId = facts.spiffeId;
    this.audience = facts.audience;
    this.expiresAt = facts.expiresAt;
    this.#svid = svid;
  }

  /** `Bearer <JWT-SVID>`. */
  bearer(): string {
    return `Bearer ${this.#svid}`;
  }

  toJSON(): { spiffeId: string; audience: readonly string[]; expiresAt: number } {
    return { spiffeId: this.spiffeId, audience: this.audience, expiresAt: this.expiresAt };
  }

  toString(): string {
    return `JwtSvidCredential(${this.spiffeId})`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The claims of a compact JWT: three parts of base64url, and a JSON object in the second. Null for any other text. This reads the claims and does not check the signature. */
function claimsOf(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts.every((part) => BASE64URL.test(part))) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    return typeof claims === 'object' && claims !== null && !Array.isArray(claims) ? (claims as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The end of a certificate in POSIX milliseconds, as its own `notAfter` says, or null when it cannot be read. */
function endOfCertificate(pem: string): number | null {
  try {
    const end = Date.parse(new X509Certificate(pem).validTo);
    return Number.isSafeInteger(end) ? end : null;
  } catch {
    return null;
  }
}

/**
 * Gets an X.509-SVID for the agent. The client makes a new P-256 key in memory for each call and gives its private key back, and this function puts it in the credential. The gateway signs the
 * certificate for that key, and the credential is for one job: it ends within one hour. The end of the credential is the `notAfter` of the certificate, and not the end that the answer names. It
 * never throws, and no detail of a failure repeats a part of a proof that the key signed.
 */
export async function fetchX509Svid(deps: SvidDeps, agent: SvidAgent): Promise<Accepted<X509SvidCredential> | GatewayFailure> {
  const did = parseDid(agent.did, 'agent.did');
  if (!did.ok) return gatewayFailure('bad_request', did.detail);
  const secrets: string[] = [];
  try {
    const issued = await deps.client.x509Svid({ agent: { did: did.value, key: noting(agent.key, secrets, 'the authentication key') } });
    if (!issued.ok) return fromRule(issued, secrets);
    if (issued.value.privateKey === null) return gatewayFailure('gateway_bad_response', 'the client made no private key for the certificate');
    const { spiffeId, certificate, bundle } = issued.value;
    const expiresAt = endOfCertificate(certificate);
    if (expiresAt === null) return gatewayFailure('gateway_bad_response', 'the certificate has no end time that can be read');
    return accepted(new X509SvidCredential({ spiffeId, certificate, bundle, expiresAt }, issued.value.privateKey));
  } catch (error) {
    return fromThrown(error, secrets);
  }
}

/**
 * Gets a JWT-SVID for the audience of a route of the insurer system: `<public base>/t/<tenant>/insurer`. The JWT-SVID is what its own claims say: its `aud` is exactly the one audience that was
 * asked for, and its end is its `exp`. Another audience, two audiences, no `exp`, and a text that is not a compact JWT are `gateway_bad_response`. It never throws, and no detail of a failure
 * repeats a part of the subject token.
 */
export async function fetchJwtSvid(deps: SvidDeps, agent: SvidAgent, target: JwtSvidTarget): Promise<Accepted<JwtSvidCredential> | GatewayFailure> {
  const did = parseDid(agent.did, 'agent.did');
  if (!did.ok) return gatewayFailure('bad_request', did.detail);
  const secrets: string[] = [];
  try {
    const issued = await deps.client.jwtSvid({ agent: { did: did.value, key: noting(agent.key, secrets, 'the authentication key') }, audience: target.audience });
    if (!issued.ok) return fromRule(issued, secrets);
    const { spiffeId, svid } = issued.value;
    const claims = claimsOf(svid);
    if (claims === null) return gatewayFailure('gateway_bad_response', 'the JWT-SVID is not a compact JWT with a JSON object as its payload');
    const audience = claims.aud;
    if (audience !== target.audience && !(Array.isArray(audience) && audience.length === 1 && audience[0] === target.audience)) {
      return gatewayFailure('gateway_bad_response', 'the JWT-SVID does not name exactly the one audience that was asked for');
    }
    const exp = claims.exp;
    const expiresAt = typeof exp === 'number' ? Math.floor(exp * 1000) : Number.NaN;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) return gatewayFailure('gateway_bad_response', 'the JWT-SVID has no end time: its exp is missing or it is not a number');
    return accepted(new JwtSvidCredential({ spiffeId, audience: [target.audience], expiresAt }, svid));
  } catch (error) {
    return fromThrown(error, secrets);
  }
}
