// scripts/operator/lib/build-record.ts - the record of a build that an attestation names.
// An attestation of an agent (a provenance attestation and a software attestation) names ONE document by its SHA-256 and by its locator. The document is the canonical JSON of exactly two members:
// the SHA-256 of the manifest that the service of the agent serves, and the digest of the image of that service. The file at the locator holds exactly those bytes: no newline, no other member, no
// other order. A file never changes: a new build has a new file. This file makes the document, names it, writes it, and holds the facts that must be true before an attestation names it: the
// image that runs in each container of the agent is the image of that container, and its digest is the digest that the public registry gives for the tag of the commit that CI built.
// The digest of a runtime image is checked and is not in the document.
// Nothing here signs or builds a transaction. A refusal is a PreconditionError (exit 2 of the task), and no message holds a token or the text of a value that a file gave.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { AgentSpec } from './contract.ts';
import { canonicalJson } from './platform.ts';
import { codeOf } from './registry.ts';

// ---- the document ----

const MANIFEST_SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const DOCUMENT_NAME = /^[a-z][a-z0-9-]{0,62}-[0-9a-f]{7}\.json$/;

/** The document that two attestations name: its text (the exact bytes of the file) and the SHA-256 of those bytes. */
export interface AttestationDocument {
  readonly text: string;
  readonly sha256: string;
}

export interface DocumentInput {
  /** The SHA-256 of the bytes of `<origin>/agent.json`: 64 lower-case hex characters. */
  readonly manifestSha256: string;
  /** The digest of the image of the service: `sha256:` and 64 lower-case hex characters. */
  readonly imageDigest: string;
}

/**
 * The document of a build. Its text is the canonical JSON of `image_digest` and `manifest_sha256`, so the members have the canonical order and the text has no white space and no newline. The digest
 * is the SHA-256 of exactly the bytes of the text. A manifest hash or an image digest of another form is refused.
 */
export function attestationDocumentOf(input: DocumentInput): AttestationDocument {
  const { manifestSha256, imageDigest } = input;
  if (typeof manifestSha256 !== 'string' || !MANIFEST_SHA256.test(manifestSha256)) throw new PreconditionError('the SHA-256 of the manifest is 64 lower-case hex characters');
  if (typeof imageDigest !== 'string' || !IMAGE_DIGEST.test(imageDigest)) throw new PreconditionError('the digest of the image is sha256: and 64 lower-case hex characters');
  const canonical = canonicalJson({ image_digest: imageDigest, manifest_sha256: manifestSha256 });
  if (!canonical.ok) throw new PreconditionError(`the document cannot be written in the canonical form (${canonical.detail})`);
  return { text: canonical.value, sha256: createHash('sha256').update(canonical.value, 'utf8').digest('hex') };
}

/** The name of the file of a document: the agent, a hyphen, the first 7 characters of the commit, and `.json`. */
export function attestationDocumentName(agent: string, commit: string): string {
  if (typeof agent !== 'string' || !AGENT_NAME.test(agent)) throw new PreconditionError('the name of an agent for a document is lower-case letters, digits and hyphens, and it starts with a letter');
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new PreconditionError('the commit of a build is 40 lower-case hex characters');
  return `${agent}-${commit.slice(0, 7)}.json`;
}

/** True when the bytes are exactly the bytes of the document. A pretty-printed text, a text with another member, another order and a trailing newline are not the document. */
export function documentMatches(bytes: Uint8Array, document: AttestationDocument): boolean {
  return Buffer.from(bytes).equals(Buffer.from(document.text, 'utf8'));
}

/**
 * Writes the file of a document into `dir`: mode 600, exactly the bytes of the text, through a temporary file. A file that holds the same bytes is left as it is. A file that holds other bytes
 * stays, and the write is refused: a document never changes, and a new build gets a new file.
 */
export function writeAttestationDocument(dir: string, name: string, document: AttestationDocument): 'written' | 'unchanged' {
  if (typeof name !== 'string' || !DOCUMENT_NAME.test(name)) throw new PreconditionError('the file of a document is named <agent>-<7 hex characters>.json');
  const path = join(dir, name);
  let held: Buffer | null = null;
  try { held = readFileSync(path); } catch (err) {
    if (codeOf(err) !== 'ENOENT') throw new PreconditionError(`the document file ${name} could not be read (${codeOf(err)})`);
  }
  if (held !== null) {
    if (documentMatches(held, document)) return 'unchanged';
    throw new PreconditionError(`the document file ${name} exists and holds other bytes: a document never changes, and a new build gets a new file`);
  }
  writeFileAtomically(path, document.text);
  return 'written';
}

// ---- the images of the containers of an agent ----

/** The public repository of the images that CI builds for this repository. */
export const IMAGE_REPOSITORY = 'ghcr.io/apex-fusion/vector-service-agents';
const REPOSITORY_PATH = 'apex-fusion/vector-service-agents';
const REPOSITORY_PATTERN = /^ghcr\.io\/apex-fusion\/vector-service-agents\/([a-z0-9][a-z0-9-]{0,62})$/;

/** The service container of each kind of agent that a use case has so far, and the image of its service. The compose files of the deploy pack hold the same names (a test holds them to each other). */
const SERVICES: Readonly<Partial<Record<AgentSpec['kind'], { readonly container: string; readonly image: string }>>> = {
  'reorder-agent': { container: 'reorder-service', image: 'reorder-agent' },
  'order-desk': { container: 'orders-service', image: 'order-desk' },
};
/** Every runtime of every agent runs this image. */
const RUNTIME_IMAGE = 'agent-runtime';

export interface ImageNames {
  readonly serviceContainer: string;
  readonly serviceRepository: string;
  readonly runtimeRepository: string;
}

/** The service container of an agent kind, the repository of its image, and the repository of the image that its runtimes run. */
export function imageNamesOf(kind: AgentSpec['kind']): ImageNames {
  const service = SERVICES[kind];
  if (service === undefined) throw new PreconditionError(`the pack names no service container for the kind ${kind}`);
  return { serviceContainer: service.container, serviceRepository: `${IMAGE_REPOSITORY}/${service.image}`, runtimeRepository: `${IMAGE_REPOSITORY}/${RUNTIME_IMAGE}` };
}

/** A container that runs: its name, the repository of its image, the digest of the image index, and the reference as `running-images.json` holds it. */
export interface RunningImage {
  readonly container: string;
  readonly repository: string;
  readonly digest: string;
  readonly reference: string;
}

export interface RunningImages {
  readonly service: RunningImage;
  readonly runtimes: readonly RunningImage[];
}

/**
 * The running images of an agent from the map of `running-images.json`: its service container, and each runtime container of its adverts. Each container must be in the map, and its image must be
 * a reference of the repository that is the image of that container, pinned by a sha256 digest. A container that is missing, an image of another repository, an image with a tag and an image id with
 * no repository are refused. A refusal names the container and never shows the text of a reference.
 */
export function runningImagesOf(agent: Pick<AgentSpec, 'id' | 'kind' | 'adverts'>, running: ReadonlyMap<string, string>): RunningImages {
  const names = imageNamesOf(agent.kind);
  const take = (container: string, repository: string): RunningImage => {
    const reference = running.get(container);
    if (reference === undefined) throw new PreconditionError(`the container ${container} of ${agent.id} is not in running-images.json: an attestation names a build that runs, and this agent is not deployed`);
    const at = reference.lastIndexOf('@');
    const digest = reference.slice(at + 1);
    if (at < 0 || reference.slice(0, at) !== repository || !IMAGE_DIGEST.test(digest)) {
      throw new PreconditionError(`the container ${container} of ${agent.id} does not run an image of ${repository} pinned by a sha256 digest: running-images.json names another repository, a tag, or no repository`);
    }
    return { container, repository, digest, reference };
  };
  const containers = [...new Set(agent.adverts.map((advert) => advert.runtimeContainer))];
  return { service: take(names.serviceContainer, names.serviceRepository), runtimes: containers.map((container) => take(container, names.runtimeRepository)) };
}

// ---- the public registry ----

/** The types of a manifest that a tag of CI can be: an OCI index and a manifest, and the two forms of Docker. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const TOKEN_ANSWER_MAX_BYTES = 16_384;
const REGISTRY_TIMEOUT_MS = 15_000;
/** The characters of a token of a registry (a JWT or an opaque value): nothing that can end a header value or start another header. */
const TOKEN_TEXT = /^[A-Za-z0-9._~+/=-]{1,8192}$/;

/** The name of a failure of a request for a message: its name and the code of its cause, and never its text, which a client can fill with the headers that it sent. */
function reasonOf(err: unknown): string {
  const name = err instanceof Error ? err.name : 'an error';
  const cause: unknown = err instanceof Error ? err.cause : undefined;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? `${name}, ${code}` : name;
}

/**
 * The bytes of the body of an answer, or null when the body is longer than `max` bytes. The read stops as soon as the body passes `max`, so a body that never ends is no harm.
 */
export async function readLimited(response: Response, max: number): Promise<Uint8Array | null> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

/** One GET of the registry: no redirect, a time limit, and nothing but status 200 passes. `what` says what the call is for. */
async function registryGet(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  } catch (err) {
    throw new PreconditionError(`the public registry could not be reached for ${what} (${reasonOf(err)})`);
  }
  if (response.status !== 200) {
    void response.body?.cancel().catch(() => undefined);
    throw new PreconditionError(`the public registry answered ${response.status} for ${what}`);
  }
  return response;
}

/** The pull token of an anonymous read: the `token` member of the answer (or `access_token`). It stays in memory, and no message holds it. */
async function pullTokenOf(response: Response, what: string): Promise<string> {
  const bytes = await readLimited(response, TOKEN_ANSWER_MAX_BYTES);
  if (bytes === null) throw new PreconditionError(`the answer of the public registry for ${what} is longer than ${TOKEN_ANSWER_MAX_BYTES} bytes`);
  let body: unknown;
  try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { throw new PreconditionError(`the answer of the public registry for ${what} is not JSON`); }
  const members = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const token = members.token ?? members.access_token;
  if (typeof token !== 'string' || !TOKEN_TEXT.test(token)) throw new PreconditionError(`the answer of the public registry for ${what} has no pull token of the expected form`);
  return token;
}

/**
 * The digest that the public registry gives for the tag of a commit: an anonymous pull token, then the manifest of the tag, with the `accept` types of an OCI index and a manifest, and the
 * header `docker-content-digest` of the answer. `repository` is an image below `IMAGE_REPOSITORY`, and `commit` is the 40 hex characters that CI uses as the tag. A refusal of the registry, a
 * request that fails and a digest of another form are a PreconditionError, and it never holds the token.
 */
export async function publicDigestOf(fetchImpl: typeof fetch, repository: string, commit: string): Promise<string> {
  if (typeof commit !== 'string' || !COMMIT.test(commit)) throw new PreconditionError('the tag of a public image is the commit of the build: 40 lower-case hex characters');
  const image = typeof repository === 'string' ? REPOSITORY_PATTERN.exec(repository)?.[1] : undefined;
  if (image === undefined) throw new PreconditionError('a public image is an image below the repository of this project, with a name of lower-case letters, digits and hyphens');
  const path = `${REPOSITORY_PATH}/${image}`;
  const tokenText = `a pull token for ${image}`;
  const token = await pullTokenOf(await registryGet(fetchImpl, `https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`, { accept: 'application/json' }, tokenText), tokenText);
  const manifestText = `the manifest of ${image} at the tag ${commit}`;
  const manifest = await registryGet(fetchImpl, `https://ghcr.io/v2/${path}/manifests/${commit}`, { accept: MANIFEST_ACCEPT, authorization: `Bearer ${token}` }, manifestText);
  void manifest.body?.cancel().catch(() => undefined);
  const digest = manifest.headers.get('docker-content-digest');
  if (digest === null || !IMAGE_DIGEST.test(digest)) throw new PreconditionError(`the public registry gave no docker-content-digest of the form sha256:<64 lower-case hex characters> for ${manifestText}`);
  return digest;
}

/**
 * Requires each running image of an agent to have the digest that the public registry gives for the tag of the commit: the service image, and the one image that every runtime runs (read once, and
 * compared with each runtime). A running image that differs, and a tag that cannot be read, are a PreconditionError that names the container and the digests.
 */
export async function requirePublicDigests(fetchImpl: typeof fetch, commit: string, images: RunningImages): Promise<void> {
  const check = async (image: RunningImage, published: string): Promise<void> => {
    if (image.digest !== published) {
      throw new PreconditionError(`the container ${image.container} runs the image ${image.digest}, and the public tag ${commit} of ${image.repository} is ${published}: the running image is not the image that CI built for this commit`);
    }
  };
  await check(images.service, await publicDigestOf(fetchImpl, images.service.repository, commit));
  const [first] = images.runtimes;
  if (first === undefined) return;
  const runtime = await publicDigestOf(fetchImpl, first.repository, commit);
  for (const image of images.runtimes) await check(image, runtime);
}
