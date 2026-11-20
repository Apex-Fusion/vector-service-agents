// packages/usecase-kit/src/access/svid.ts
// The SVIDs of a counterparty. A counterparty calls the system of its own organisation with an SVID of its own record, and not with a token: the Order Desk with an X.509-SVID as the TLS client
// certificate, the Insurer Intake Agent with a JWT-SVID. The key of an X.509-SVID is made in memory for one job. It is private in its object, and it is never written to a file or to a log.
import { inspect } from 'node:util';
import type { KeyObject } from 'node:crypto';
import type { GatewayClient, KeyInput } from '@vsa/id-kit/client';
import { accepted, parseDid, type Accepted, type Did } from '../protocol/index.ts';
import { fromRule, fromThrown, gatewayFailure, type GatewayFailure } from './gateway.ts';
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

/**
 * Gets an X.509-SVID for the agent. The client makes a new P-256 key in memory for each call and gives its private key back, and this function puts it in the credential. The gateway signs the
 * certificate for that key, and the credential is for one job: it ends within one hour. It never throws.
 */
export async function fetchX509Svid(deps: SvidDeps, agent: SvidAgent): Promise<Accepted<X509SvidCredential> | GatewayFailure> {
  const did = parseDid(agent.did, 'agent.did');
  if (!did.ok) return gatewayFailure('bad_request', did.detail);
  try {
    const issued = await deps.client.x509Svid({ agent: { did: did.value, key: agent.key } });
    if (!issued.ok) return fromRule(issued);
    if (issued.value.privateKey === null) return gatewayFailure('gateway_bad_response', 'the client made no private key for the certificate');
    const { spiffeId, certificate, bundle, expiresAt } = issued.value;
    return accepted(new X509SvidCredential({ spiffeId, certificate, bundle, expiresAt: expiresAt * 1000 }, issued.value.privateKey));
  } catch (error) {
    return fromThrown(error);
  }
}

/** Gets a JWT-SVID for the audience of a route of the insurer system: `<public base>/t/<tenant>/insurer`. It never throws. */
export async function fetchJwtSvid(deps: SvidDeps, agent: SvidAgent, target: JwtSvidTarget): Promise<Accepted<JwtSvidCredential> | GatewayFailure> {
  const did = parseDid(agent.did, 'agent.did');
  if (!did.ok) return gatewayFailure('bad_request', did.detail);
  try {
    const issued = await deps.client.jwtSvid({ agent: { did: did.value, key: agent.key }, audience: target.audience });
    if (!issued.ok) return fromRule(issued);
    const { spiffeId, svid, expiresAt } = issued.value;
    return accepted(new JwtSvidCredential({ spiffeId, audience: [target.audience], expiresAt: expiresAt * 1000 }, svid));
  } catch (error) {
    return fromThrown(error);
  }
}
