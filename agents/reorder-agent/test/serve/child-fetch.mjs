// agents/reorder-agent/test/serve/child-fetch.mjs - loaded by a child process of the start test, before the service. It puts a fetch in front of the real one. The one fetch of the start that is not a call to the node is
// the Module-1 manifest at its pinned address, and this fetch answers that address with the fixture file of the buyer code and passes every other call on. No child reaches a network, and the image holds no such file.
import { readFileSync } from 'node:fs';

const address = process.env.VECTOR_MODULE1_MANIFEST;
const manifest = readFileSync(new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url), 'utf8');
const real = globalThis.fetch;
globalThis.fetch = async (input, init) => (String(input) === address ? new Response(manifest, { status: 200, headers: { 'content-type': 'application/json' } }) : real(input, init));
