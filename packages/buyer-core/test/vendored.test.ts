// packages/buyer-core/test/vendored.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readFileSync(join(root, 'VENDORED-FROM.md'), 'utf8');

describe('vendored files', () => {
  it('every vendored file is named in VENDORED-FROM.md with a source path, a commit and a sha256 of the copy', () => {
    const rows = manifest.split('\n').filter((l) => l.startsWith('| `src/vendored/') || l.startsWith('| `test/fixtures/'));
    expect(rows.length).toBeGreaterThanOrEqual(13);
    for (const row of rows) {
      const [, dest, source, commit, sha] = row.split('|').map((c) => c.trim().replace(/^`|`$/g, ''));
      expect(existsSync(join(root, dest)), dest).toBe(true);
      expect(source).toMatch(/^(mcp-server|agents-marketplace):/);
      expect(commit).toMatch(/^[0-9a-f]{7,40}$/);
      const actual = createHash('sha256').update(readFileSync(join(root, dest))).digest('hex');
      expect(actual, `${dest} changed since it was vendored`).toBe(sha);
    }
  });
  // The import below is the first load of Lucid's WASM in this file: about 2.3 s on its own, 4.3 s measured while `pnpm -r test`
  // runs the packages side by side, against vitest's 5 s default. Hence the explicit timeout.
  it('the public surface re-exports the builders, the lineage, the verifier, the provider and the signer', async () => {
    const m = await import('../src/index.ts');
    for (const name of ['planPostEscrow', 'buildPostEscrow', 'buildAccept', 'buildReclaim', 'resolveEscrowLineage', 'verifyReceipt', 'OgmiosProvider', 'signTransaction', 'rawHexToBech32', 'ESCROW_REF_UTXO', 'ACCEPT_WINDOW_MS', 'DELIVER_BY_BUFFER_MS']) expect(typeof (m as Record<string, unknown>)[name], name).not.toBe('undefined');
  }, 30_000);
});
