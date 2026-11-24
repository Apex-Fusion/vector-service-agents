// The record of a build that an attestation names: the document (its exact bytes, its digest and its name), the file that holds it, the images of the running containers of an agent, and the
// read of the public registry. Each refusal has an accepted twin. No test uses the network, a real clock or a real key.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { PreconditionError } from '../../checks/lib/session.ts';
import {
  IMAGE_REPOSITORY, attestationDocumentName, attestationDocumentOf, documentMatches, imageNamesOf, publicDigestOf, readLimited, requirePublicDigests, runningImagesOf, writeAttestationDocument,
} from '../lib/build-record.ts';
import { canonicalSha256 } from '../lib/platform.ts';
import data from '../usecases/inventory-reorder.ts';
import UC2 from '../usecases/prior-authorization.ts';
import UC3 from '../usecases/bid-evaluation.ts';

const folders: string[] = [];
afterAll(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const tempFolder = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'operator-build-record-'));
  folders.push(folder);
  return folder;
};

const GOLDEN_FILE = fileURLToPath(new URL('./golden/attestation-document.json', import.meta.url));
/** The inputs of the golden file, and the SHA-256 of its bytes. */
const GOLDEN = { manifestSha256: 'a1eb3d32efe49baab2de779778d4fb9c13ce6862b9e1289f380ab6f005b3db1b', imageDigest: 'sha256:1a5853f76722d53cffa101f1ea66216c3a43c06788dd30c5e58139a872dce4e2' };
const GOLDEN_SHA256 = '84da7369da93178bb4f8cdaaff42b746d741957af21c89d48c4a43a72fe61040';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const digestOf = (n: number): string => `sha256:${n.toString(16).padStart(2, '0').repeat(32)}`;

describe('the attestation document', () => {
  it('has the exact bytes of the golden file: two members in the canonical order, and no newline', () => {
    const document = attestationDocumentOf(GOLDEN);
    const golden = readFileSync(GOLDEN_FILE);
    expect(Buffer.from(document.text, 'utf8').equals(golden)).toBe(true);
    expect(golden.length).toBe(175);
    expect(golden.at(-1)).toBe('}'.charCodeAt(0));
    expect(Object.keys(JSON.parse(golden.toString('utf8')))).toEqual(['image_digest', 'manifest_sha256']);
  });
  it('has a digest that is the SHA-256 of its bytes, the digest of the golden file and the digest of canonicalSha256', () => {
    const document = attestationDocumentOf(GOLDEN);
    expect(document.sha256).toBe(GOLDEN_SHA256);
    expect(document.sha256).toBe(sha256(readFileSync(GOLDEN_FILE)));
    expect(document.sha256).toBe(sha256(Buffer.from(document.text, 'utf8')));
    expect(canonicalSha256({ image_digest: GOLDEN.imageDigest, manifest_sha256: GOLDEN.manifestSha256 })).toEqual({ ok: true, value: document.sha256 });
  });
  it('changes its bytes and its digest with the manifest hash and with the image digest, and with nothing else', () => {
    const base = attestationDocumentOf(GOLDEN);
    const other = attestationDocumentOf({ ...GOLDEN, manifestSha256: sha256('another manifest') });
    const third = attestationDocumentOf({ ...GOLDEN, imageDigest: digestOf(7) });
    expect(new Set([base.text, other.text, third.text]).size).toBe(3);
    expect(new Set([base.sha256, other.sha256, third.sha256]).size).toBe(3);
    expect(attestationDocumentOf({ ...GOLDEN })).toEqual(base);
  });

  const BAD_MANIFEST_HASHES: readonly (readonly [string, unknown])[] = [
    ['upper-case hex', GOLDEN.manifestSha256.toUpperCase()], ['one character short', GOLDEN.manifestSha256.slice(1)], ['one character long', `${GOLDEN.manifestSha256}0`],
    ['not hex', `${GOLDEN.manifestSha256.slice(1)}g`], ['prefixed with the algorithm', `sha256:${GOLDEN.manifestSha256}`], ['prefixed with 0x', `0x${GOLDEN.manifestSha256}`],
    ['followed by a space', `${GOLDEN.manifestSha256} `], ['empty', ''], ['a number', 7], ['missing', undefined],
  ];
  for (const [label, value] of BAD_MANIFEST_HASHES) {
    it(`refuses a manifest hash that is ${label}`, () => {
      expect(() => attestationDocumentOf({ ...GOLDEN, manifestSha256: value as string })).toThrow(PreconditionError);
    });
  }
  const hash = GOLDEN.imageDigest.slice('sha256:'.length);
  const BAD_IMAGE_DIGESTS: readonly (readonly [string, unknown])[] = [
    ['64 hex characters without the algorithm', hash], ['another algorithm', `sha512:${hash}`], ['upper-case hex', `sha256:${hash.toUpperCase()}`], ['one character short', `sha256:${hash.slice(1)}`],
    ['one character long', `sha256:${hash}0`], ['a reference with a repository', `${IMAGE_REPOSITORY}/reorder-agent@sha256:${hash}`], ['followed by a space', `sha256:${hash} `], ['empty', ''],
    ['a number', 7], ['missing', undefined],
  ];
  for (const [label, value] of BAD_IMAGE_DIGESTS) {
    it(`refuses an image digest that is ${label}`, () => {
      expect(() => attestationDocumentOf({ ...GOLDEN, imageDigest: value as string })).toThrow(PreconditionError);
    });
  }
  it('accepts the digests that the refusals above are the twins of', () => {
    expect(() => attestationDocumentOf({ manifestSha256: sha256('a manifest'), imageDigest: digestOf(255) })).not.toThrow();
  });
});

describe('the bytes that are the document', () => {
  const document = attestationDocumentOf(GOLDEN);
  const bytes = (text: string): Buffer => Buffer.from(text, 'utf8');
  const members = { image_digest: GOLDEN.imageDigest, manifest_sha256: GOLDEN.manifestSha256 };
  it('are exactly the canonical bytes', () => {
    expect(documentMatches(bytes(document.text), document)).toBe(true);
    expect(documentMatches(readFileSync(GOLDEN_FILE), document)).toBe(true);
  });
  const NOT_THE_DOCUMENT: readonly (readonly [string, Buffer])[] = [
    ['a pretty-printed text', bytes(JSON.stringify(members, null, 2))],
    ['a pretty-printed text with a final newline', bytes(`${JSON.stringify(members, null, 2)}\n`)],
    ['the document and a trailing newline', bytes(`${document.text}\n`)],
    ['the document and a carriage return and a newline', bytes(`${document.text}\r\n`)],
    ['the document with a third member', bytes(JSON.stringify({ ...members, runtime_digest: digestOf(3) }))],
    ['the document with a third member that sorts first', bytes(JSON.stringify({ a_note: 'x', ...members }))],
    ['the members in the other order', bytes(JSON.stringify({ manifest_sha256: GOLDEN.manifestSha256, image_digest: GOLDEN.imageDigest }))],
    ['the members with a space after each colon', bytes(`{"image_digest": "${GOLDEN.imageDigest}", "manifest_sha256": "${GOLDEN.manifestSha256}"}`)],
    ['the document with a byte order mark', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes(document.text)])],
    ['the document without its last byte', bytes(document.text.slice(0, -1))],
    ['the document of another manifest', bytes(attestationDocumentOf({ ...GOLDEN, manifestSha256: sha256('another manifest') }).text)],
    ['the document of another image', bytes(attestationDocumentOf({ ...GOLDEN, imageDigest: digestOf(9) }).text)],
    ['no bytes', Buffer.alloc(0)],
  ];
  for (const [label, text] of NOT_THE_DOCUMENT) {
    it(`do not include ${label}`, () => {
      expect(documentMatches(text, document)).toBe(false);
    });
  }
  it('are compared as bytes: a view on a larger buffer counts only for its own bytes', () => {
    const larger = Buffer.concat([bytes('x'), bytes(document.text), bytes('y')]);
    expect(documentMatches(larger.subarray(1, 1 + document.text.length), document)).toBe(true);
    expect(documentMatches(larger, document)).toBe(false);
  });
});

describe('the name of the document', () => {
  it('is the agent, a hyphen, the first 7 characters of the commit and .json', () => {
    expect(attestationDocumentName('reorder-agent', COMMIT)).toBe('reorder-agent-0123456.json');
    expect(attestationDocumentName('order-desk', 'f'.repeat(40))).toBe('order-desk-fffffff.json');
  });
  const BAD_COMMITS: readonly (readonly [string, string])[] = [
    ['39 characters', COMMIT.slice(1)], ['41 characters', `${COMMIT}0`], ['upper-case', COMMIT.toUpperCase()], ['not hex', `${COMMIT.slice(1)}z`], ['a short hash', COMMIT.slice(0, 7)], ['empty', ''],
    ['a branch name', 'main'],
  ];
  for (const [label, commit] of BAD_COMMITS) {
    it(`refuses a commit that is ${label}`, () => {
      expect(() => attestationDocumentName('reorder-agent', commit)).toThrow(PreconditionError);
    });
  }
  for (const agent of ['', 'Reorder-Agent', '../reorder-agent', 'reorder/agent', 'reorder agent', 'reorder.agent', '1agent', '-agent', 'a'.repeat(64)]) {
    it(`refuses the agent name ${JSON.stringify(agent)}`, () => {
      expect(() => attestationDocumentName(agent, COMMIT)).toThrow(PreconditionError);
    });
  }
  it('accepts the names that the refusals above are the twins of', () => {
    expect(() => attestationDocumentName('a', COMMIT)).not.toThrow();
    expect(() => attestationDocumentName(`a${'b'.repeat(62)}`, COMMIT)).not.toThrow();
  });
});

describe('the file of the document', () => {
  const NAME = 'reorder-agent-0123456.json';
  const document = attestationDocumentOf(GOLDEN);
  it('is written with mode 600 in a folder with mode 700, holds exactly the canonical bytes, and leaves no temporary file', () => {
    const folder = join(tempFolder(), 'attestation-documents');
    expect(writeAttestationDocument(folder, NAME, document)).toBe('written');
    expect(readFileSync(join(folder, NAME)).equals(readFileSync(GOLDEN_FILE))).toBe(true);
    expect(statSync(join(folder, NAME)).mode & 0o777).toBe(0o600);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(readdirSync(folder)).toEqual([NAME]);
  });
  it('is left as it is when the same document is written again', () => {
    const folder = tempFolder();
    writeAttestationDocument(folder, NAME, document);
    const before = statSync(join(folder, NAME));
    expect(writeAttestationDocument(folder, NAME, document)).toBe('unchanged');
    expect(statSync(join(folder, NAME)).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(folder)).toEqual([NAME]);
  });
  it('is never replaced: a file with other bytes stays, and the write is refused', () => {
    const folder = tempFolder();
    const old = `${JSON.stringify({ image_digest: GOLDEN.imageDigest, manifest_sha256: GOLDEN.manifestSha256 }, null, 2)}\n`;
    writeFileSync(join(folder, NAME), old, { mode: 0o600 });
    chmodSync(join(folder, NAME), 0o600);
    expect(() => writeAttestationDocument(folder, NAME, document)).toThrow(PreconditionError);
    expect(readFileSync(join(folder, NAME), 'utf8')).toBe(old);
    const next = attestationDocumentOf({ ...GOLDEN, manifestSha256: sha256('a new manifest') });
    expect(() => writeAttestationDocument(folder, NAME, next)).toThrow(PreconditionError);
    expect(writeAttestationDocument(folder, 'order-desk-0123456.json', next)).toBe('written');
  });
  for (const name of ['../reorder-agent-0123456.json', 'a/reorder-agent-0123456.json', 'reorder-agent-0123456.txt', 'reorder-agent-012345.json', 'Reorder-agent-0123456.json', 'reorder-agent-0123456.json.tmp', '']) {
    it(`refuses the file name ${JSON.stringify(name)} and writes nothing`, () => {
      const folder = tempFolder();
      expect(() => writeAttestationDocument(folder, name, document)).toThrow(PreconditionError);
      expect(readdirSync(folder)).toEqual([]);
      expect(existsSync(join(folder, '..', 'reorder-agent-0123456.json'))).toBe(false);
    });
  }
});

// ---- the images of the running containers ----

const REORDER = data.agents.find((agent) => agent.id === 'reorder-agent')!;
const ORDERS = data.agents.find((agent) => agent.id === 'order-desk')!;
const SERVICE_IMAGE = { 'reorder-agent': `${IMAGE_REPOSITORY}/reorder-agent`, 'order-desk': `${IMAGE_REPOSITORY}/order-desk` } as const;
const RUNTIME_IMAGE = `${IMAGE_REPOSITORY}/agent-runtime`;

/** The running images of both agents as the wrapper writes them: the service of each agent and every runtime. */
function runningImages(over: Readonly<Record<string, string>> = {}): Map<string, string> {
  return new Map<string, string>([
    ['reorder-service', `${SERVICE_IMAGE['reorder-agent']}@${digestOf(1)}`], ['reorder-runtime', `${RUNTIME_IMAGE}@${digestOf(2)}`],
    ['orders-service', `${SERVICE_IMAGE['order-desk']}@${digestOf(3)}`], ['orders-small-runtime', `${RUNTIME_IMAGE}@${digestOf(2)}`],
    ['orders-medium-runtime', `${RUNTIME_IMAGE}@${digestOf(2)}`], ['orders-large-runtime', `${RUNTIME_IMAGE}@${digestOf(2)}`], ...Object.entries(over),
  ]);
}
const without = (map: Map<string, string>, container: string): Map<string, string> => new Map([...map].filter(([name]) => name !== container));

describe('the images of an agent that runs', () => {
  it('are the service image and the image of each runtime, with the digest of each', () => {
    const images = runningImagesOf(REORDER, runningImages());
    expect(images.service).toEqual({ container: 'reorder-service', repository: SERVICE_IMAGE['reorder-agent'], digest: digestOf(1), reference: `${SERVICE_IMAGE['reorder-agent']}@${digestOf(1)}` });
    expect(images.runtimes).toEqual([{ container: 'reorder-runtime', repository: RUNTIME_IMAGE, digest: digestOf(2), reference: `${RUNTIME_IMAGE}@${digestOf(2)}` }]);
    const orders = runningImagesOf(ORDERS, runningImages());
    expect(orders.service).toMatchObject({ container: 'orders-service', repository: SERVICE_IMAGE['order-desk'], digest: digestOf(3) });
    expect(orders.runtimes.map((runtime) => runtime.container)).toEqual(['orders-small-runtime', 'orders-medium-runtime', 'orders-large-runtime']);
  });
  it('ignore the containers of the other agent', () => {
    expect(runningImagesOf(REORDER, without(without(runningImages(), 'orders-service'), 'orders-large-runtime')).service.digest).toBe(digestOf(1));
  });
  it('reads each Bid Desk from its own container even though the three services share one image digest', () => {
    const desks = UC3.agents.filter(({ kind }) => kind === 'bid-desk');
    const service = `${IMAGE_REPOSITORY}/bid-desk@${digestOf(4)}`;
    const running = new Map(desks.flatMap((desk) => [
      [desk.serviceContainer, service], ...desk.adverts.map((advert) => [advert.runtimeContainer, `${RUNTIME_IMAGE}@${digestOf(2)}`]),
    ] as [string, string][]));
    expect(desks.map((desk) => runningImagesOf(desk, running).service.container)).toEqual(['bids-alfa-service', 'bids-bravo-service', 'bids-charlie-service']);
    expect(desks.map((desk) => runningImagesOf(desk, running).service.digest)).toEqual([digestOf(4), digestOf(4), digestOf(4)]);
    running.set('bids-bravo-service', `${IMAGE_REPOSITORY}/sourcing-agent@${digestOf(4)}`);
    expect(() => runningImagesOf(desks[1]!, running)).toThrow('bids-bravo-service');
    expect(runningImagesOf(desks[0]!, running).service.reference).toBe(service);
  });
  const BAD: readonly (readonly [string, Map<string, string>, string])[] = [
    ['a service container that is not in the file', without(runningImages(), 'reorder-service'), 'reorder-service'],
    ['a runtime container that is not in the file', without(runningImages(), 'reorder-runtime'), 'reorder-runtime'],
    ['a service container that runs the runtime image', runningImages({ 'reorder-service': `${RUNTIME_IMAGE}@${digestOf(1)}` }), 'reorder-service'],
    ['a service container that runs the service image of the other agent', runningImages({ 'reorder-service': `${SERVICE_IMAGE['order-desk']}@${digestOf(1)}` }), 'reorder-service'],
    ['a runtime container that runs a service image', runningImages({ 'reorder-runtime': `${SERVICE_IMAGE['reorder-agent']}@${digestOf(2)}` }), 'reorder-runtime'],
    ['a service container that runs an image of another owner', runningImages({ 'reorder-service': `ghcr.io/another-owner/vector-service-agents/reorder-agent@${digestOf(1)}` }), 'reorder-service'],
    ['a service container that runs an image with a tag', runningImages({ 'reorder-service': `${SERVICE_IMAGE['reorder-agent']}:latest@${digestOf(1)}` }), 'reorder-service'],
    ['a service container that has an image id and no repository', runningImages({ 'reorder-service': digestOf(1) }), 'reorder-service'],
    ['a digest that is not sha256 and 64 lower-case hex characters', runningImages({ 'reorder-service': `${SERVICE_IMAGE['reorder-agent']}@sha256:${'AB'.repeat(32)}` }), 'reorder-service'],
  ];
  for (const [label, map, container] of BAD) {
    it(`refuse ${label}, and name the container`, () => {
      expect(() => runningImagesOf(REORDER, map)).toThrow(PreconditionError);
      expect(() => runningImagesOf(REORDER, map)).toThrow(container);
    });
  }
  it('refuse a runtime of the Order Desk that is not in the file, and take the same file when each runtime is there', () => {
    expect(() => runningImagesOf(ORDERS, without(runningImages(), 'orders-medium-runtime'))).toThrow('orders-medium-runtime');
    expect(() => runningImagesOf(ORDERS, runningImages())).not.toThrow();
  });
  it('never show the text of an image in a refusal', () => {
    const text = (() => { try { runningImagesOf(REORDER, runningImages({ 'reorder-service': 'registry.example/secret-looking-name@sha256:nothex' })); return ''; } catch (err) { return String((err as Error).message); } })();
    expect(text).not.toBe('');
    expect(text).not.toContain('secret-looking-name');
  });
});

interface Compose { services: Record<string, { container_name: string; image: string }> }
const composeOf = (agent: string): Compose => parseYaml(readFileSync(fileURLToPath(new URL(`../../../deploy/server/docker-compose.${agent}.yml`, import.meta.url)), 'utf8')) as Compose;

describe('the names of the images and the compose files', () => {
  for (const agent of [...data.agents, ...UC2.agents, ...UC3.agents]) {
    it(`hold the containers and the image repositories of ${agent.id}: the service and each runtime of its adverts`, () => {
      const names = imageNamesOf(agent);
      expect(names.serviceContainer).toBe(agent.serviceContainer);
      expect(names.serviceRepository).toBe(`${IMAGE_REPOSITORY}/${agent.kind}`);
      const repositories = new Map(Object.values(composeOf(agent.id).services).map((service) => [service.container_name, service.image.slice(0, service.image.indexOf('@'))]));
      expect(repositories.get(names.serviceContainer)).toBe(names.serviceRepository);
      for (const advert of agent.adverts) expect(repositories.get(advert.runtimeContainer)).toBe(names.runtimeRepository);
      expect(repositories.size).toBe(1 + new Set(agent.adverts.map((advert) => advert.runtimeContainer)).size);
    });
  }
});

// ---- the public registry ----

const TOKEN = 'registry-token-of-the-test';
type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
interface Call { readonly url: URL; readonly init: RequestInit }

/** A `fetch` that keeps its calls and answers by a handler. */
interface Web { readonly fetchImpl: typeof fetch; readonly calls: Call[] }
function web(handler: Handler): Web {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: new URL(String(input)), init: init ?? {} };
    calls.push(call);
    return handler(call.url, call.init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const manifestResponse = (digest: string | null, status = 200): Response => new Response('{"manifests":[]}', { status, headers: digest === null ? {} : { 'docker-content-digest': digest } });
const headerOf = (init: RequestInit, name: string): string | undefined => (init.headers as Record<string, string> | undefined)?.[name];

/** The registry: a token for each pull scope, and the digest of each image by its name below the repository path. A manifest read needs the token. */
function registry(digests: Readonly<Record<string, string>>, over: { token?: () => Response; manifest?: (image: string) => Response } = {}): Web {
  return web((url, init) => {
    if (url.pathname === '/token') return over.token?.() ?? Response.json({ token: TOKEN });
    const found = /^\/v2\/apex-fusion\/vector-service-agents\/([a-z0-9-]+)\/manifests\/([0-9a-f]{40})$/.exec(url.pathname);
    if (found === null) return new Response('not found', { status: 404 });
    if (headerOf(init, 'authorization') !== `Bearer ${TOKEN}`) return new Response('unauthorized', { status: 401 });
    return over.manifest?.(found[1]!) ?? manifestResponse(digests[found[1]!] ?? null, digests[found[1]!] === undefined ? 404 : 200);
  });
}

describe('the digest of a public tag', () => {
  const REPOSITORY = SERVICE_IMAGE['reorder-agent'];
  it('is the docker-content-digest of the manifest of the commit tag, read with an anonymous pull token', async () => {
    const { fetchImpl, calls } = registry({ 'reorder-agent': digestOf(1) });
    expect(await publicDigestOf(fetchImpl, REPOSITORY, COMMIT)).toBe(digestOf(1));
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.origin).toBe('https://ghcr.io');
    expect(calls[0]!.url.pathname).toBe('/token');
    expect(calls[0]!.url.searchParams.get('service')).toBe('ghcr.io');
    expect(calls[0]!.url.searchParams.get('scope')).toBe('repository:apex-fusion/vector-service-agents/reorder-agent:pull');
    expect(headerOf(calls[0]!.init, 'authorization')).toBeUndefined();
    expect(calls[1]!.url.href).toBe(`https://ghcr.io/v2/apex-fusion/vector-service-agents/reorder-agent/manifests/${COMMIT}`);
    expect(headerOf(calls[1]!.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
    const accept = headerOf(calls[1]!.init, 'accept') ?? '';
    for (const type of ['application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json']) expect(accept).toContain(type);
  });
  it('is read with no redirect and a time limit', async () => {
    const { fetchImpl, calls } = registry({ 'reorder-agent': digestOf(1) });
    await publicDigestOf(fetchImpl, REPOSITORY, COMMIT);
    for (const call of calls) {
      expect(call.init.redirect).toBe('manual');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
  const FAILURES: readonly (readonly [string, { token?: () => Response; manifest?: () => Response }])[] = [
    ['a token request with status 401', { token: () => new Response('no', { status: 401 }) }],
    ['a token request with status 500', { token: () => new Response('no', { status: 500 }) }],
    ['a token request with a redirect', { token: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/token' } }) }],
    ['a token answer that is not JSON', { token: () => new Response('not json') }],
    ['a token answer with no token', { token: () => Response.json({ expires_in: 300 }) }],
    ['a token answer with an empty token', { token: () => Response.json({ token: '' }) }],
    ['a token answer with a token that is no text', { token: () => Response.json({ token: 7 }) }],
    ['a token that holds a line break', { token: () => Response.json({ token: `abc\r\nx-injected: yes` }) }],
    ['a token answer that is far too long', { token: () => new Response('x'.repeat(40_000)) }],
    ['a manifest request with status 404', { manifest: () => new Response('missing', { status: 404 }) }],
    ['a manifest request with status 401', { manifest: () => new Response('no', { status: 401 }) }],
    ['a manifest request with status 500', { manifest: () => new Response('no', { status: 500 }) }],
    ['a manifest request with a redirect', { manifest: () => new Response(null, { status: 307, headers: { location: 'https://elsewhere.example/blob' } }) }],
    ['a manifest answer with no docker-content-digest', { manifest: () => manifestResponse(null) }],
    ['a digest of another algorithm', { manifest: () => manifestResponse(`sha512:${'ab'.repeat(32)}`) }],
    ['a digest with upper-case hex', { manifest: () => manifestResponse(`sha256:${'AB'.repeat(32)}`) }],
    ['a digest that is one character short', { manifest: () => manifestResponse(`sha256:${'ab'.repeat(32).slice(1)}`) }],
    ['a digest with no algorithm', { manifest: () => manifestResponse('ab'.repeat(32)) }],
  ];
  for (const [label, over] of FAILURES) {
    it(`is refused for ${label}, and the refusal never holds the token`, async () => {
      const { fetchImpl } = registry({ 'reorder-agent': digestOf(1) }, over);
      const err = await publicDigestOf(fetchImpl, REPOSITORY, COMMIT).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(PreconditionError);
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).not.toContain('x-injected');
    });
  }
  it('is refused when the request fails, with the name of the failure and never the token', async () => {
    const down = web(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) }); });
    const err = await publicDigestOf(down.fetchImpl, REPOSITORY, COMMIT).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect((err as Error).message).toContain('ECONNREFUSED');
    const late = web((url) => { if (url.pathname === '/token') return Response.json({ token: TOKEN }); throw new Error(`could not send the header Bearer ${TOKEN}`); });
    const second = await publicDigestOf(late.fetchImpl, REPOSITORY, COMMIT).then(() => null, (e: unknown) => e);
    expect(second).toBeInstanceOf(PreconditionError);
    expect((second as Error).message).not.toContain(TOKEN);
  });
  it('is asked for the images of this repository only, and for a commit of 40 hex characters only', async () => {
    const { fetchImpl, calls } = registry({ 'reorder-agent': digestOf(1) });
    for (const repository of ['ghcr.io/another-owner/vector-service-agents/reorder-agent', `${IMAGE_REPOSITORY}/`, `${IMAGE_REPOSITORY}/Reorder-Agent`, `${IMAGE_REPOSITORY}/a/b`, REPOSITORY.slice('ghcr.io/'.length), `${REPOSITORY}@${digestOf(1)}`]) {
      await expect(publicDigestOf(fetchImpl, repository, COMMIT)).rejects.toBeInstanceOf(PreconditionError);
    }
    for (const commit of [COMMIT.slice(1), COMMIT.toUpperCase(), 'latest', '', `${COMMIT}/../x`]) await expect(publicDigestOf(fetchImpl, REPOSITORY, commit)).rejects.toBeInstanceOf(PreconditionError);
    expect(calls).toEqual([]);
  });
});

describe('the running digests against the public tags', () => {
  const PUBLIC = { 'reorder-agent': digestOf(1), 'order-desk': digestOf(3), 'agent-runtime': digestOf(2) };
  it('pass when each running digest is the digest of its public tag, with one read of each repository', async () => {
    const { fetchImpl, calls } = registry(PUBLIC);
    await requirePublicDigests(fetchImpl, COMMIT, runningImagesOf(ORDERS, runningImages()));
    expect(calls.filter((call) => call.url.pathname.startsWith('/v2/')).map((call) => call.url.pathname.split('/')[4])).toEqual(['order-desk', 'agent-runtime']);
  });
  it('refuse a service image that differs from its public tag, and name the container and both digests', async () => {
    const { fetchImpl } = registry({ ...PUBLIC, 'reorder-agent': digestOf(9) });
    const err = await requirePublicDigests(fetchImpl, COMMIT, runningImagesOf(REORDER, runningImages())).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(PreconditionError);
    expect((err as Error).message).toContain('reorder-service');
    expect((err as Error).message).toContain(digestOf(1));
    expect((err as Error).message).toContain(digestOf(9));
  });
  it('refuse a runtime image that differs from its public tag', async () => {
    const { fetchImpl } = registry({ ...PUBLIC, 'agent-runtime': digestOf(9) });
    await expect(requirePublicDigests(fetchImpl, COMMIT, runningImagesOf(REORDER, runningImages()))).rejects.toThrow('reorder-runtime');
  });
  it('refuse the one runtime of three that runs another image', async () => {
    const { fetchImpl } = registry(PUBLIC);
    const images = runningImagesOf(ORDERS, runningImages({ 'orders-medium-runtime': `${RUNTIME_IMAGE}@${digestOf(8)}` }));
    await expect(requirePublicDigests(fetchImpl, COMMIT, images)).rejects.toThrow('orders-medium-runtime');
  });
  it('refuse a public tag that cannot be read', async () => {
    const { fetchImpl } = registry({ 'order-desk': digestOf(3) });
    await expect(requirePublicDigests(fetchImpl, COMMIT, runningImagesOf(ORDERS, runningImages()))).rejects.toBeInstanceOf(PreconditionError);
  });
});

describe('a read with a size limit', () => {
  it('gives the bytes of a body that is within the limit, and null for a body over it', async () => {
    expect(Buffer.from((await readLimited(new Response('abcd'), 4))!).toString('utf8')).toBe('abcd');
    expect(await readLimited(new Response('abcde'), 4)).toBeNull();
    expect((await readLimited(new Response(null), 4))!.length).toBe(0);
  });
  it('stops reading a body that never ends', async () => {
    let pulls = 0;
    const endless = new Response(new ReadableStream<Uint8Array>({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1_000)); } }));
    expect(await readLimited(endless, 4_000)).toBeNull();
    expect(pulls).toBeLessThan(20);
  });
});
