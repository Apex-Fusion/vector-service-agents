// packages/hire-kit/test/stranded-kinds.test.ts
// The kinds of the stranded store after the kind `agent` was added to ocr and llm. A file that was written before reads as it is and its bytes come back unchanged; an entry of the new
// kind is written beside them and read back; a kind that no hire writes is still refused, by name.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STRANDED_FILE, StrandedStore } from '../src/janitor.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function dirWith(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hire-kit-kinds-'));
  dirs.push(dir);
  writeFileSync(join(dir, STRANDED_FILE), text);
  return dir;
}

const OPEN = `${'ab'.repeat(32)}#0`;
const MARKED = `${'cd'.repeat(32)}#1`;
const AGENT = `${'ef'.repeat(32)}#0`;
const OTHER = `${'12'.repeat(32)}#2`;
/** The file as the Document Pipeline wrote it before the kind agent existed: an ocr entry and an llm entry with every optional field. */
const BEFORE = `[
  {
    "escrow_ref": "${OPEN}",
    "deliver_by": 1790000480000,
    "posted_at": 1790000000000,
    "kind": "ocr"
  },
  {
    "escrow_ref": "${MARKED}",
    "deliver_by": 1790000500000,
    "posted_at": 1790000020000,
    "kind": "llm",
    "valid_to": 1790000200000,
    "lost_to_release_after": 1790001080000,
    "gone_reads": 1,
    "accept_pending": {
      "tx_hash": "${'ac'.repeat(32)}",
      "valid_to": 1790000606000,
      "by": "run"
    }
  }
]
`;
const AGENT_ENTRY = { escrow_ref: AGENT, deliver_by: 1790000600000, posted_at: 1790000100000, kind: 'agent' as const };

describe('the stranded store and the kind agent', () => {
  it('reads a file written before the kind agent existed, keeps its bytes when an entry of the new kind is added, and reads all three kinds back', () => {
    const dir = dirWith(BEFORE);
    const store = new StrandedStore(dir);
    expect(store.list().map((entry) => [entry.escrow_ref, entry.kind])).toStrictEqual([[OPEN, 'ocr'], [MARKED, 'llm']]);
    store.add(AGENT_ENTRY);
    const written = readFileSync(join(dir, STRANDED_FILE), 'utf8');
    // The old entries are the same bytes, and the new one follows them in the same form.
    expect(written.startsWith(BEFORE.slice(0, BEFORE.length - '\n]\n'.length))).toBe(true);
    expect(written).toBe(`${JSON.stringify([...JSON.parse(BEFORE), AGENT_ENTRY], null, 2)}\n`);
    expect(new StrandedStore(dir).list().map((entry) => entry.kind)).toStrictEqual(['ocr', 'llm', 'agent']);
  });

  it('writes the bytes of a file that holds an agent entry back as they were, after another entry is added and removed', () => {
    const text = `${JSON.stringify([JSON.parse(BEFORE)[0], AGENT_ENTRY], null, 2)}\n`;
    const dir = dirWith(text);
    const store = new StrandedStore(dir);
    store.add({ escrow_ref: OTHER, deliver_by: 1790000700000, posted_at: 1790000200000, kind: 'llm' });
    expect(readFileSync(join(dir, STRANDED_FILE), 'utf8')).not.toBe(text);
    store.remove(OTHER);
    expect(readFileSync(join(dir, STRANDED_FILE), 'utf8')).toBe(text);
  });

  it('refuses a kind that no hire writes, and names the three that it knows; the same file with a known kind is read', () => {
    const entry = JSON.parse(BEFORE)[0];
    const dir = dirWith(`${JSON.stringify([{ ...entry, kind: 'tts' }], null, 2)}\n`);
    expect(() => new StrandedStore(dir)).toThrow(/none of ocr, llm and agent/);
    const twin = dirWith(`${JSON.stringify([{ ...entry, kind: 'agent' }], null, 2)}\n`);
    expect(new StrandedStore(twin).list().map((e) => e.kind)).toStrictEqual(['agent']);
    expect(() => new StrandedStore(dirWith(`${JSON.stringify([{ ...entry, kind: 'Agent' }], null, 2)}\n`))).toThrow(/none of ocr, llm and agent/);
  });

  it('refuses to add an entry of an unknown kind', () => {
    const store = new StrandedStore(dirWith(BEFORE));
    // @ts-expect-error: 'tts' is not a StrandedKind; the store refuses it at run time as well, for a caller that is not typed.
    expect(() => store.add({ ...AGENT_ENTRY, kind: 'tts' })).toThrow(/none of ocr, llm and agent/);
    expect(store.list()).toHaveLength(2);
    store.add(AGENT_ENTRY);
    expect(store.list()).toHaveLength(3);
  });
});
