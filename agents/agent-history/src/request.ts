export const SECTIONS = ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] as const;
export type Section = typeof SECTIONS[number];
export interface HistoryRequest { subject: string; include: Section[] }
export class BadRequest extends Error { status = 400; constructor(m: string) { super(m); } }
const MAX_BODY = 64 * 1024;
export function parseWire(body: string): HistoryRequest {
  if (body.length > MAX_BODY) throw new BadRequest(`request too large (${body.length} bytes, max ${MAX_BODY})`);
  let arr: unknown;
  try { arr = JSON.parse(body); } catch { throw new BadRequest('body is not JSON'); }
  if (!Array.isArray(arr) || arr.length !== 1 || typeof (arr[0] as any)?.content !== 'string') throw new BadRequest('body must be the one-element message array [{content, role}]');
  let req: any;
  try { req = JSON.parse((arr[0] as any).content); } catch { throw new BadRequest('message content must be a JSON object with a subject'); }
  if (!req || typeof req.subject !== 'string' || req.subject.trim() === '') throw new BadRequest('subject is required: a DID, a registry asset name, or a key hash');
  const include = req.include === undefined ? [...SECTIONS] : req.include;
  if (!Array.isArray(include) || include.some((s: unknown) => !SECTIONS.includes(s as Section))) throw new BadRequest(`include must be a subset of ${SECTIONS.join(', ')}`);
  return { subject: req.subject.trim(), include: include as Section[] };
}
