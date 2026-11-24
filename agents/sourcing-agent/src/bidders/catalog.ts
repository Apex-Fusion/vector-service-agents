// agents/sourcing-agent/src/bidders/catalog.ts
// The catalog of the identity gateway (`/.well-known/ard.json`). It lists the agents that have a protocol card. A bidder is in the catalog when one of its entries names the DID of the bidder in `metadata.did`.
// The file of a bidder holds that as a fact for the model: `in_catalog` is true or false, or null when the catalog could not be read. The fetch of the bytes is a port of the wiring. This file turns bytes into
// the set of DIDs, and it takes nothing else of a body that a third party can write: no name, no description and no address.
import { accepted, isPlainObject, parseDid, parseJsonText, refused } from '@vsa/usecase-kit/protocol';
import type { Did, ProtocolResult } from '@vsa/usecase-kit/protocol';

/**
 * The DIDs of a catalog body. The body is a JSON object with a list `entries`. An entry with a `metadata.did` that is a DID gives that DID. An entry without one, an entry that is not an object and a DID of
 * another form are skipped. A body that is not text in UTF-8, is not JSON, or has no list `entries` is refused with `bad_shape`: the caller reads a refusal as a catalog that could not be read, and never as an
 * empty catalog. The detail names what failed and never repeats the body.
 */
export function parseArdCatalog(bytes: Uint8Array): ProtocolResult<ReadonlySet<Did>> {
  if (!(bytes instanceof Uint8Array)) return refused('bad_shape', 'the catalog must be bytes');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return refused('bad_shape', 'the catalog is not text in UTF-8');
  }
  const json = parseJsonText(text, 'catalog');
  if (!json.ok) return json;
  if (!isPlainObject(json.value) || !Array.isArray(json.value.entries)) return refused('bad_shape', 'the catalog has no list entries');
  const dids = new Set<Did>();
  for (const entry of json.value.entries as readonly unknown[]) {
    if (!isPlainObject(entry) || !isPlainObject(entry.metadata)) continue;
    const did = parseDid(entry.metadata.did);
    if (did.ok) dids.add(did.value);
  }
  return accepted(dids);
}
