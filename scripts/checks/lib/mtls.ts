// scripts/checks/lib/mtls.ts - one GET to the verifier of check 6, with the X.509-SVID as the TLS client certificate.
// Over https the client presents the certificate in the TLS handshake, as a service of an agent does, and the proxy in front of the verifier passes it on in the header `Client-Cert`.
// A loopback http URL (127.0.0.1 or localhost) stands for that proxy, so that an operator can run the verifier and the check on one machine: the client then sets the header itself,
// in the form that the proxy sets (`:` and the base64 of the DER and `:`). Nothing but a loopback address gets this form of the call.
import { X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export interface MtlsCredentials {
  certificatePem: string;
  privateKey: KeyObject;
}

export interface MtlsResponse {
  status: number;
  body: string;
}

const MAX_BODY_BYTES = 65_536;

/** Makes the GET. With credentials the certificate is presented; with none no certificate is sent. A body over 64 KiB is cut. */
export function mtlsGet(url: string, credentials: MtlsCredentials | null, timeoutMs = 15_000): Promise<MtlsResponse> {
  const target = new URL(url);
  const loopback = target.protocol === 'http:' && (target.hostname === '127.0.0.1' || target.hostname === 'localhost');
  if (target.protocol !== 'https:' && !loopback) return Promise.reject(new Error('the verifier URL must be https (http only for 127.0.0.1 or localhost)'));
  const headers: Record<string, string> = { accept: 'application/json' };
  if (loopback && credentials !== null) headers['client-cert'] = `:${new X509Certificate(credentials.certificatePem).raw.toString('base64')}:`;
  const options = target.protocol === 'https:' && credentials !== null
    ? { method: 'GET', headers, timeout: timeoutMs, cert: credentials.certificatePem, key: credentials.privateKey.export({ format: 'pem', type: 'pkcs8' }) }
    : { method: 'GET', headers, timeout: timeoutMs };
  return new Promise((resolve, reject) => {
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target, options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => { if (size < MAX_BODY_BYTES) { chunks.push(chunk); size += chunk.length; } });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8').slice(0, MAX_BODY_BYTES) }); });
    });
    req.on('timeout', () => { req.destroy(new Error(`the verifier did not answer within ${timeoutMs} ms`)); });
    req.on('error', reject);
    req.end();
  });
}
