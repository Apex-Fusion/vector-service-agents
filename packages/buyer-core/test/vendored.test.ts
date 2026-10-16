// packages/buyer-core/test/vendored.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readFileSync(join(root, 'VENDORED-FROM.md'), 'utf8');
/** Every file under `dir` (a folder of the package), as a package-relative path with forward slashes. */
const filesUnder = (dir: string): string[] =>
  readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
    .map((p) => `${dir}/${p.split(sep).join('/')}`)
    .filter((p) => statSync(join(root, p)).isFile());

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
  it('says what the Document Pipeline is today, and what verifyFleetReceipt does with the on-chain row of a receipt that cannot be walked', () => {
    // The Pipeline is PROPOSED (built, not deployed): the sentence of before it was built is gone.
    expect(manifest).toContain('The Document Pipeline agent (built, not deployed) posts escrows, signs and submits transactions, reads escrow lineage and verifies receipts.');
    expect(manifest).not.toContain('not built yet');
    // src/fleet-verify.ts: on a throw the four rows fail, but the on-chain row is skipped when there was no hash on chain to compare.
    expect(manifest).toContain('so it runs inside a `try` and its four rows fail on a throw, the on-chain row being skipped only when there was no hash to compare.');
  });
  it('every file under src/vendored/ and test/fixtures/ has a row, so a file added without one fails', () => {
    const named = new Set(manifest.split('\n').filter((l) => l.startsWith('| `src/vendored/') || l.startsWith('| `test/fixtures/')).map((row) => row.split('|')[1].trim().replace(/^`|`$/g, '')));
    const onDisk = [...filesUnder('src/vendored'), ...filesUnder('test/fixtures')];
    expect(onDisk.length).toBeGreaterThanOrEqual(13);
    expect(onDisk.filter((f) => !named.has(f)), 'files without a row in VENDORED-FROM.md').toStrictEqual([]);
  });
  // The import below is the first load of Lucid's WASM in this file: about 2.3 s on its own, 4.3 s measured while `pnpm -r test`
  // runs the packages side by side, against vitest's 5 s default. Hence the explicit timeout.
  it('the public surface re-exports the builders, the lineage, the verifier, the provider, the signer and the fleet commitments, and exports the chain layer, the fleet clients, the supplier discovery and the fleet receipt check', async () => {
    const m = await import('../src/index.ts');
    for (const name of ['planPostEscrow', 'buildPostEscrow', 'buildAccept', 'buildReclaim', 'resolveEscrowLineage', 'verifyReceipt', 'OgmiosProvider', 'signTransaction', 'rawHexToBech32', 'buyerIdentityOf', 'ESCROW_REF_UTXO', 'ACCEPT_WINDOW_MS', 'DELIVER_BY_BUFFER_MS', 'ocrPromptHash', 'ocrResponseHash', 'responsesPromptHash', 'responsesResponseHash', 'responsesOutputText', 'requestSpecHash', 'planFleetPostEscrow', 'buildFleetPostEscrow', 'createRealChain', 'TxNotConfirmedError', 'FakeChain', 'feeOfSignedTx', 'readCapability', 'probeStatus', 'sendOcrJob', 'sendResponsesJob', 'pollOcrJob', 'pollResponsesJob', 'selectLlmSupplier', 'findOcrAdvert', 'verifyFleetReceipt']) expect(typeof (m as Record<string, unknown>)[name], name).not.toBe('undefined');
  }, 30_000);
});
