import { createHash } from 'node:crypto';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomically } from '../../checks/lib/files.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { readLimited } from './build-record.ts';
import { canonicalJson } from './platform.ts';
import { codeOf } from './registry.ts';

const AGENT = /^[a-z][a-z0-9-]{0,62}$/;
const DID = /^did:vector:[0-9a-f]{64}$/;
const NAME = /^compliance-(?:reply-)?[a-z][a-z0-9-]{0,62}-[0-9a-f]{7}\.json$/;
const MAX_BYTES = 4_096;
const READ_TIMEOUT_MS = 15_000;

export interface ComplianceDocument {
  readonly name: string;
  readonly text: string;
  readonly sha256: string;
}

function documentOf(agent: string, did: string, field: 'statement' | 'reply', content: string): ComplianceDocument {
  if (!AGENT.test(agent)) throw new PreconditionError('the document needs a valid agent name');
  if (!DID.test(did)) throw new PreconditionError('the document needs a canonical subject DID');
  if (typeof content !== 'string' || content.trim() === '') throw new PreconditionError(`the data gives no compliance ${field}`);
  const canonical = canonicalJson({ [field]: content, subject: did });
  if (!canonical.ok) throw new PreconditionError(`the compliance ${field} cannot be written as canonical JSON`);
  if (Buffer.byteLength(canonical.value) > MAX_BYTES) throw new PreconditionError(`the compliance ${field} exceeds ${MAX_BYTES} bytes`);
  const sha256 = createHash('sha256').update(canonical.value).digest('hex');
  const prefix = field === 'reply' ? 'compliance-reply' : 'compliance';
  return { name: `${prefix}-${agent}-${sha256.slice(0, 7)}.json`, text: canonical.value, sha256 };
}

export function complianceDocumentOf(input: { agent: string; did: string; statement: string }): ComplianceDocument {
  return documentOf(input.agent, input.did, 'statement', input.statement);
}

export function replyDocumentOf(input: { agent: string; did: string; text: string }): ComplianceDocument {
  return documentOf(input.agent, input.did, 'reply', input.text);
}

/** Publish without replacement. A file at this name can already be linked to a ledger digest. */
export function writeComplianceDocument(dir: string, name: string, document: ComplianceDocument): 'written' | 'unchanged' {
  if (!NAME.test(name) || name !== document.name || !name.endsWith(`-${document.sha256.slice(0, 7)}.json`)) {
    throw new PreconditionError('the compliance document name does not match its digest');
  }
  const path = join(dir, name);
  let staging: string | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    staging = mkdtempSync(join(dir, '.compliance-'));
    const temporary = join(staging, name);
    writeFileAtomically(temporary, document.text);
    try {
      linkSync(temporary, path);
    } catch (err) {
      if (codeOf(err) !== 'EEXIST') throw err;
      const existing = lstatSync(path);
      if (!existing.isFile()) throw new PreconditionError(`the compliance document ${name} must be a regular file`);
      if (existing.size !== Buffer.byteLength(document.text) || !readFileSync(path).equals(Buffer.from(document.text))) {
        throw new PreconditionError(`the compliance document ${name} holds other bytes: a published document never changes`);
      }
      return 'unchanged';
    }
    return 'written';
  } catch (err) {
    if (err instanceof PreconditionError) throw err;
    throw new PreconditionError(`the compliance document ${name} could not be written (${codeOf(err)})`);
  } finally {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true });
  }
}

/** Read the exact document and hash the fetched bytes. The error never contains the answer or its URL. */
export async function readComplianceDocument(fetchImpl: typeof fetch, uri: string, document: ComplianceDocument): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(uri, { method: 'GET', headers: { accept: 'application/json, text/plain' }, redirect: 'manual', signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
  } catch {
    throw new PreconditionError(`the published compliance document ${document.name} could not be fetched`);
  }
  if (response.status !== 200 || response.redirected) {
    void response.body?.cancel().catch(() => undefined);
    throw new PreconditionError(`the published compliance document ${document.name} does not have a direct status 200 answer`);
  }
  let bytes: Uint8Array | null;
  try { bytes = await readLimited(response, MAX_BYTES); } catch {
    throw new PreconditionError(`the body of the published compliance document ${document.name} could not be read`);
  }
  if (bytes === null) throw new PreconditionError(`the published compliance document ${document.name} exceeds ${MAX_BYTES} bytes`);
  if (!Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).equals(Buffer.from(document.text))) {
    throw new PreconditionError(`the bytes of the published compliance document ${document.name} are not the canonical document for this subject`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}
