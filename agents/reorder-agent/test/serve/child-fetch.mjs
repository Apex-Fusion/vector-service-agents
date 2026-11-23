// agents/reorder-agent/test/serve/child-fetch.mjs - loaded by a child process of the start test, before the service. It puts a fetch in front of the real one. The start makes two kinds of fetch that must not reach a
// network: the Module-1 manifest at its pinned address, which this fetch answers with the fixture file of the buyer code, and the calls to the node at its https address, which it answers with the start time of the
// chain and an empty list of outputs. It passes every other call on.
import { readFileSync } from 'node:fs';

const manifestAddress = process.env.VECTOR_MODULE1_MANIFEST;
const nodeAddress = process.env.VECTOR_OGMIOS_URL;
const manifest = readFileSync(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url), 'utf8');
const real = globalThis.fetch;
const answer = (text) => new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init) => {
  const address = String(input);
  if (address === manifestAddress) return answer(manifest);
  if (nodeAddress && address.startsWith(nodeAddress)) {
    const call = JSON.parse(String(init?.body ?? '{}'));
    return answer(JSON.stringify({ jsonrpc: '2.0', result: call.method === 'queryNetwork/startTime' ? '2025-08-29T16:40:00Z' : [], id: null }));
  }
  return real(input, init);
};
