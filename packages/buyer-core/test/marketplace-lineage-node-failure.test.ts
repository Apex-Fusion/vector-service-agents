// Vitest port of one test of packages/builder/test/marketplace-lineage.test.ts at ebce68a (Apex-Fusion/mcp-server): the node failure test, with the lines of the source that it needs.
// VENDORED-FROM.md lists the lines that differ from the source.
import { describe, test } from 'vitest';
import './ported-support.ts';
import assert from 'node:assert/strict';
import { FixtureProvider } from './fixtures/fixture-provider.ts';
import { ESCROW_OPEN_DATUM_HEX, ESCROW_REF } from './fixtures/marketplace.fixture.ts';
import { escrowKoios, koiosFor, escrowAt, SUBMIT_TX } from './fixtures/escrow-koios.fixture.ts';
import { decodeEscrowDatum } from '@vsa/vector-read';
import type { EscrowDatum } from '@vsa/vector-read';
import { resolveEscrowLineage } from '../src/vendored/mcp/marketplace-lineage.ts';

const KOIOS = 'https://koios.example';
const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
const submitted: EscrowDatum = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' };
const current = escrowAt(SUBMIT_TX, submitted); // the genuine Submitted output

describe('resolveEscrowLineage', () => {
  test('a node failure is an Error that names the escrow and carries neither the endpoint nor a response body', async () => {
    const LEAKS = ['http://', 'https://', 'ogmios.example', 'hunter2', 'Service Unavailable', 'ECONNREFUSED', 'Invalid params'];
    const cases: Array<[string, Error, RegExp]> = [
      ['an HTTP error', new Error('Ogmios request failed (queryLedgerState/utxo): 503 Service Unavailable'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): 503$/],
      ['a JSON-RPC error with details', new Error('Ogmios request failed (queryLedgerState/utxo): -32602 Invalid params: {"password":"hunter2"} at https://ogmios.example'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): -32602$/],
      ['a network error', new Error('Ogmios request failed (queryLedgerState/utxo): network error'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): network error$/],
      ['an answer with no list', new Error('Ogmios request failed (queryLedgerState/utxo): the node gave no list'), /from the node: Ogmios request failed \(queryLedgerState\/utxo\): the node gave no list$/],
      ['anything else, which may carry the endpoint', new TypeError('connect ECONNREFUSED https://ogmios.example:1337'), /from the node: node request failed \(network error or timeout\)$/],
    ];
    for (const [name, error, message] of cases) {
      const node = Object.assign(new FixtureProvider([current]), { getUtxosByOutRef: async () => { throw error; } });
      for (const k of [koiosFor([current]), escrowKoios({ spent: false })]) {
        await assert.rejects(() => resolveEscrowLineage(node, KOIOS, ESCROW_REF, k.f), (err: unknown) => {
          assert.ok(err instanceof Error, name);
          assert.ok(err.message.startsWith(`Could not read escrow ${ESCROW_REF} from the node: `), `${name}: ${err.message}`);
          assert.match(err.message, message, name);
          for (const leak of LEAKS) assert.ok(!err.message.includes(leak), `${name}: "${leak}" leaked into: ${err.message}`);
          return true;
        }, name);
      }
    }
  });
});
