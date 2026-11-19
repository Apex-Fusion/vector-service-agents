// scripts/checks/lib/evidence.ts - the evidence file of a check: what each confirmed step shows.
// One JSON file for each check, with mode 600, that only grows. A step that the ledger refuses holds the evaluation error and the transaction body. A step that a tool refuses
// holds the message of the tool. A refusal says whether the check expected it. No entry holds a key, a signature or a token: a step writes what it shows, as facts.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { writeFileAtomically } from './files.ts';
import type { WriteIo } from './files.ts';
import { jsonSafe } from './format.ts';

export const EVIDENCE_FORMAT = 1;

/** A call of a hosted tool: what was asked, and what came back. A tool that refused has its message. */
export interface HostedRead {
  tool: string;
  arguments: Record<string, unknown>;
  ok: boolean;
  message?: string;
  result?: unknown;
}

interface Common { step: string; at?: string }

export type EvidenceEntry =
  /** A transaction that was confirmed. */
  | (Common & { status: 'confirmed'; tx_hash: string | null; fee_lovelace?: bigint; shows: Record<string, unknown> })
  /** The read of the hosted tools after a step. */
  | (Common & { status: 'verified'; hosted: HostedRead[]; shows?: Record<string, unknown> })
  /** A step with no transaction (a read, a check of a verifier), or a note. */
  | (Common & { status: 'info'; shows: Record<string, unknown> })
  /** The ledger refused a transaction: its evaluation error and its body. */
  | (Common & { status: 'refused'; expected: boolean; tx_hash: string | null; evaluation_error: string; transaction_body: string })
  /** A tool refused: its message. */
  | (Common & { status: 'tool_refused'; expected: boolean; tool: string; message: string });

export class EvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceError';
  }
}

export interface EvidenceHeader { check: string; network: string; record: string }
export interface EvidenceIo extends WriteIo { clock(): string }

interface EvidenceDocument extends EvidenceHeader { format: typeof EVIDENCE_FORMAT; started_at: string; entries: Record<string, unknown>[] }

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function checkEntry(entry: EvidenceEntry): void {
  if (entry.status === 'refused') {
    if (entry.evaluation_error.trim() === '') throw new EvidenceError(`the entry of ${entry.step} has no evaluation error: a step that the ledger refuses holds the evaluation error`);
    if (!/^([0-9a-fA-F]{2})+$/.test(entry.transaction_body)) throw new EvidenceError(`the entry of ${entry.step} has no transaction body in hex: a step that the ledger refuses holds the transaction body`);
  }
  if (entry.status === 'tool_refused' && entry.message.trim() === '') throw new EvidenceError(`the entry of ${entry.step} has no message: a step that a tool refuses holds the message of the tool`);
}

export class EvidenceFile {
  readonly path: string;
  readonly #io: Partial<EvidenceIo>;
  #document: EvidenceDocument;

  private constructor(path: string, document: EvidenceDocument, io: Partial<EvidenceIo>) {
    this.path = path;
    this.#document = document;
    this.#io = io;
  }

  /** Opens the evidence file of a check, or makes it. A file of another check or record, and a file that is not evidence, is refused and left as it is. */
  static open(path: string, header: EvidenceHeader, io: Partial<EvidenceIo> = {}): EvidenceFile {
    const clock = io.clock ?? (() => new Date().toISOString());
    if (!existsSync(path)) {
      const document: EvidenceDocument = { format: EVIDENCE_FORMAT, ...header, started_at: clock(), entries: [] };
      writeFileAtomically(path, `${JSON.stringify(document, null, 2)}\n`, io);
      return new EvidenceFile(path, document, io);
    }
    const mode = statSync(path).mode & 0o777;
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new EvidenceError(`${path} has mode ${mode.toString(8)} and other users can read it: set mode 600 on it`);
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new EvidenceError(`${path} is not JSON: repair it, or move it away`); }
    if (!isObject(parsed) || parsed.format !== EVIDENCE_FORMAT || !Array.isArray(parsed.entries) || typeof parsed.started_at !== 'string') {
      throw new EvidenceError(`${path} is not an evidence file of this format`);
    }
    for (const field of ['check', 'network', 'record'] as const) {
      if (parsed[field] !== header[field]) throw new EvidenceError(`${path} is the evidence of another ${field} (${String(parsed[field])}), and this run is for ${header[field]}`);
    }
    return new EvidenceFile(path, parsed as unknown as EvidenceDocument, io);
  }

  entries(): readonly Record<string, unknown>[] {
    return structuredClone(this.#document.entries);
  }

  /** Appends one entry and writes the file. The entry is checked first: a refusal without its facts is not written. */
  add(entry: EvidenceEntry): void {
    checkEntry(entry);
    const clock = this.#io.clock ?? (() => new Date().toISOString());
    const written = jsonSafe({ ...entry, at: entry.at ?? clock() }) as Record<string, unknown>;
    const next: EvidenceDocument = { ...this.#document, entries: [...this.#document.entries, written] };
    writeFileAtomically(this.path, `${JSON.stringify(next, null, 2)}\n`, this.#io);
    this.#document = next;
  }
}
