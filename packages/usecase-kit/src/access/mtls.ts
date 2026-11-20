// packages/usecase-kit/src/access/mtls.ts
// The one call that `fetch` cannot make: an HTTPS call that presents a client certificate. It is a port, so that a test gives a fake. `httpsTransport` is the real one, over node:https. It checks
// the certificate of the server as Node does by default, and it follows no redirect. The host that asks for the client certificate is a reverse proxy: it checks that the client holds the key of
// its certificate, and it passes the certificate to the mock service. A client never sets a header for that: the proxy removes it.
import { request as httpsRequest } from 'node:https';

export interface MtlsRequest {
  /** An https URL. */
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  /** The client certificate and its private key, as PEM text. */
  readonly cert: string;
  readonly key: string;
  /** The most bytes of the answer that the transport reads. It fails on a longer answer. */
  readonly maxBodyBytes: number;
  /** Aborts when the caller stops waiting. The transport ends the request. */
  readonly signal: AbortSignal;
}

export interface MtlsReply {
  readonly status: number;
  readonly body: string;
}

/** Makes one HTTPS call with a client certificate. It rejects when no answer can be read. */
export type MtlsTransport = (request: MtlsRequest) => Promise<MtlsReply>;

export const httpsTransport: MtlsTransport = (request) =>
  new Promise<MtlsReply>((resolve, reject) => {
    const target = new URL(request.url);
    if (target.protocol !== 'https:') {
      reject(new Error('the client-certificate host must be an https URL'));
      return;
    }
    const call = httpsRequest(target, { method: request.method, headers: request.headers, cert: request.cert, key: request.key, signal: request.signal }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > request.maxBodyBytes) {
          call.destroy(new Error(`the answer is longer than ${request.maxBodyBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    call.on('error', reject);
    call.end(request.body ?? undefined);
  });
