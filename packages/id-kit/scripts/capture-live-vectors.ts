// packages/id-kit/scripts/capture-live-vectors.ts
// Captures the public documents of the live identity gateway as test vectors, for test/live-vectors.test.ts. It is read-only: it sends GET requests to public routes, and nothing else.
// It makes no token request, signs nothing, and reads no key file and no environment variable. The routes are a fixed list (the key set, the metadata, the SPIFFE bundle, both status
// lists, and the credential of one public record). A route outside the list is refused before any request goes out.
//
// The gateway builds a status list on the first request after it has had none for an hour, and that takes some minutes. Until then it answers 503. The script asks again after the
// wait that the gateway names, up to a time limit.
//
//   pnpm --filter @vsa/id-kit capture
//
// It writes the files to test/fixtures/live/, with capture.json: the origin, the time of the capture, and the sha256 of each file.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIVE_ORIGIN = 'https://id.vector.apexfusion.org';
/** A public record whose credential is captured: the record of a service agent that has been on the identity registry since its adoption. */
export const CREDENTIAL_AGENT = 'c5e44677dadefc8a194d15293cad889b85e1ce5c839177f1955778ac4c63d01c';

export interface Target {
  readonly file: string;
  readonly path: string;
  readonly accept: string;
}

/** The public routes that the script reads, and no others. */
export const targets = (agent: string): readonly Target[] => [
  { file: 'jwks.json', path: '/.well-known/jwks.json', accept: 'application/json' },
  { file: 'metadata.json', path: '/.well-known/oauth-authorization-server', accept: 'application/json' },
  { file: 'bundle.json', path: '/spiffe/bundle', accept: 'application/json' },
  { file: 'tsl-0.jwt', path: '/status/tsl/0', accept: 'application/statuslist+jwt' },
  { file: 'bsl-0.jwt', path: '/status/bsl/0', accept: 'application/vc+jwt' },
  { file: 'credential.jwt', path: `/agents/${agent}/credential`, accept: 'application/vc+jwt' },
];

const PUBLIC_ROUTES = [/^\/\.well-known\/jwks\.json$/, /^\/\.well-known\/oauth-authorization-server$/, /^\/spiffe\/bundle$/, /^\/status\/(?:tsl|bsl)\/0$/, /^\/agents\/[0-9a-f]{64}\/credential$/];

/** Throws unless `path` is one of the public routes that the script reads. */
export function assertPublicRoute(path: string): void {
  if (!PUBLIC_ROUTES.some((route) => route.test(path))) throw new Error(`${path} is not one of the public routes that this script reads`);
}

export interface CaptureOptions {
  /** The `fetch` function: the one of the runtime, or a stub in a test. */
  readonly fetch: typeof fetch;
  readonly origin: string;
  readonly agent: string;
  readonly outDir: string;
  /** The clock, in POSIX ms. */
  readonly now: () => number;
  /** Waits for `ms` milliseconds. */
  readonly sleep: (ms: number) => Promise<void>;
  /** How long to wait for a list that the gateway still builds, in ms. */
  readonly maxWaitMs: number;
  readonly log: (message: string) => void;
}

export interface CapturedFile {
  readonly path: string;
  readonly status: number;
  readonly contentType: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface CaptureManifest {
  readonly origin: string;
  /** The time of the last answer, in POSIX ms and in ISO form. The tests read each document at this time. */
  readonly capturedAtMs: number;
  readonly capturedAt: string;
  readonly agent: string;
  readonly files: Readonly<Record<string, CapturedFile>>;
}

export async function capture(options: CaptureOptions): Promise<CaptureManifest> {
  mkdirSync(options.outDir, { recursive: true });
  const files: Record<string, CapturedFile> = {};
  const started = options.now();
  for (const target of targets(options.agent)) {
    assertPublicRoute(target.path);
    for (;;) {
      // Only a GET with an Accept header. No body, no credentials.
      const response = await options.fetch(`${options.origin}${target.path}`, { method: 'GET', headers: { accept: target.accept }, redirect: 'manual' });
      const body = await response.text();
      if (response.status === 200) {
        writeFileSync(join(options.outDir, target.file), body);
        files[target.file] = {
          path: target.path,
          status: 200,
          contentType: response.headers.get('content-type') ?? '',
          bytes: Buffer.byteLength(body),
          sha256: createHash('sha256').update(body).digest('hex'),
        };
        options.log(`${target.path}: ${Buffer.byteLength(body)} bytes`);
        break;
      }
      if (response.status !== 503 || options.now() - started > options.maxWaitMs) throw new Error(`${target.path}: the gateway answered ${response.status}`);
      const asked = Number(response.headers.get('retry-after') ?? '5');
      options.log(`${target.path}: 503, the gateway builds its lists; asking again`);
      await options.sleep(Math.max(5, Number.isFinite(asked) ? asked : 5) * 1000);
    }
  }
  const capturedAtMs = options.now();
  const manifest: CaptureManifest = { origin: options.origin, capturedAtMs, capturedAt: new Date(capturedAtMs).toISOString(), agent: options.agent, files };
  writeFileSync(join(options.outDir, 'capture.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures', 'live');
  const manifest = await capture({
    fetch: globalThis.fetch,
    origin: LIVE_ORIGIN,
    agent: CREDENTIAL_AGENT,
    outDir,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    maxWaitMs: 15 * 60_000,
    log: (message) => console.error(message),
  });
  console.error(`captured ${Object.keys(manifest.files).length} files at ${manifest.capturedAt}`);
}
