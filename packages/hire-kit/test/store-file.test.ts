// packages/hire-kit/test/store-file.test.ts
// The file of the stranded store did not move with the code: a stranded.json the Document Pipeline wrote before the extraction (its state volume on the
// host holds one) is read by the kit as it is, and the kit writes the same bytes back. The text below is the writer's own form, JSON.stringify of the list
// with two spaces and a line break at the end, every field an entry can have in the order the reader keeps them.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STRANDED_FILE, StrandedStore } from '../src/janitor.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const OPEN = `${'ab'.repeat(32)}#0`;
const MARKED = `${'cd'.repeat(32)}#1`;
const TODAY = `[
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

describe('the stranded file of the Pipeline', () => {
  it('is read as it is, and written back in the same bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hire-kit-file-'));
    dirs.push(dir);
    writeFileSync(join(dir, STRANDED_FILE), TODAY, 'utf8');
    const store = new StrandedStore(dir);
    expect(store.list()).toStrictEqual([
      { escrow_ref: OPEN, deliver_by: 1_790_000_480_000, posted_at: 1_790_000_000_000, kind: 'ocr' },
      {
        escrow_ref: MARKED, deliver_by: 1_790_000_500_000, posted_at: 1_790_000_020_000, kind: 'llm', valid_to: 1_790_000_200_000, lost_to_release_after: 1_790_001_080_000,
        gone_reads: 1, accept_pending: { tx_hash: 'ac'.repeat(32), valid_to: 1_790_000_606_000, by: 'run' },
      },
    ]);
    store.update(MARKED, { gone_reads: 1 });
    expect(readFileSync(join(dir, STRANDED_FILE), 'utf8')).toBe(TODAY);
  });
});
