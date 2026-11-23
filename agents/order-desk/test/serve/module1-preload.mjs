// agents/order-desk/test/serve/module1-preload.mjs
// Loaded with `node --import` by the tests that start src/index.ts as a process. A child process cannot take a stub fetch as an option, and the start makes one fetch: the Module-1 manifest, from its pinned
// address. This file answers that one address from the file that MODULE1_STUB_FILE names, and passes every other call on to the fetch of Node. It is a test file: the image does not hold it.
import { readFileSync } from 'node:fs';

const address = process.env.MODULE1_STUB_URL;
const file = process.env.MODULE1_STUB_FILE;
const real = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const href = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href;
  if (address !== undefined && file !== undefined && href === new URL(address).href) {
    return new Response(readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return real(input, init);
};
