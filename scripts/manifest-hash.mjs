// scripts/manifest-hash.mjs - prints the sha256 of the bytes a running agent serves at /agent.json.
// Usage: node scripts/manifest-hash.mjs https://mp-suppliers-history.hal8.ai
import { createHash } from 'node:crypto';
const base = process.argv[2]; if (!base) { console.error('usage: manifest-hash <https://host>'); process.exit(2); }
const res = await fetch(`${base.replace(/\/+$/, '')}/agent.json`);
if (!res.ok) { console.error(`${base} answered ${res.status} for /agent.json: nothing to hash`); process.exit(1); } // an error page must never become an advert's detail_hash
const bytes = Buffer.from(await res.arrayBuffer());
console.log(JSON.stringify({ detail_uri: `${base.replace(/\/+$/, '')}/agent.json`, detail_hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }));
