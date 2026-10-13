# Plan B: `vector-service-agents` repo, Agent History, manifests, specs, guide

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the public `vector-service-agents` repo with a shared read-only chain library, the Agent History service running behind the template runtime, the four agent specs and manifests, the member guide, the first-party end-to-end script, and the apex-web deployment files David needs.

**Architecture:** A pnpm workspace. `packages/vector-read` holds Koios and indexer clients, datum decoders (vendored from Plan A's codecs, same golden tests) and a small `safeFetch`. `agents/agent-history` is a plain `node:http` service that the template runtime calls at `SERVICE_URL`: it parses the one-element message array, builds one JSON report from Koios, the indexer and the module addresses, and serves `GET /agent.json`. Deployment is two containers per agent on apex-web (runtime image built from the template at commit `c4c378a`, service image from this repo). Nothing in this repo holds a chain key.

**Tech Stack:** TypeScript ESM, pnpm 10, Node 22, vitest, tsx, `@lucid-evolution/lucid` (Data decoding only), `@noble/hashes`, `@modelcontextprotocol/sdk` (E2E client only), Docker.

**Spec:** `docs/superpowers/specs/2026-10-13-vector-service-agents-design.md` (sections 3, 4, 7.1, 7.2, 8, 9, 10, 11)

## Global Constraints

- Node 22 (`.nvmrc` = `22`), pnpm 10.33.2 via corepack, ESM only, `"type": "module"`.
- MIT licence from the first commit (`LICENSE` is the template's MIT text with "Apex Fusion Foundation" as holder).
- Status words in every public file: `LIVE`, `DEPLOYED`, `PROPOSED`. Never "planned as shipped". The unit is named once in `docs/HIRE.md` step 3 and nowhere else in prose; code uses `lovelace` fields and prints amounts with six decimals and no unit name.
- No key material anywhere in this repo: no `.env` committed, `.env*.example` files hold names only, and `agents/*/src` must not contain the substrings `mnemonic`, `seed`, `PRIV_KEY_HEX` (a repo-level test enforces it).
- Wire contract with the template runtime: the service receives `[{"content": "<string>", "role": "user"}]`, parses `JSON.parse(body)[0].content`, then parses that string as the request JSON; it returns the result JSON as the whole response body with `content-type: application/json`; HTTP 4xx for a bad request, 5xx for an internal failure (the runtime fails the job and the buyer reclaims).
- Mainnet constants exactly as in the spec section 6. Koios v2 base `https://v2.koios.vector.mainnet.apexfusion.org/api/v1`; indexer `https://mp-indexer.vector.apexfusion.org`.
- Outbound fetches from a service go through `safeFetch` (same rules as Plan A Task 7) with a 20 s budget and a 1 MB cap unless stated.
- Commit after every green step. Branch `main` in `C:\Users\Filip\Documents\Claude\vector-service-agents` (already initialised with the spec). Create the GitHub repo in Task 1; push at the end of each task.

## Review Focus

1. **A subject that does not exist** (unknown DID, asset or key hash). The report must come back 200 with `identity: null`, empty sections and `blind_spots` saying "no registry record found", not a 500. Pinned in Task 4.
2. **A key hash that owns several registry records.** The report lists all of them under `subject.candidates` and reports the first; it never silently picks one. Pinned in Task 3.
3. **A deregistered agent.** `identity.deregistered` is filled and the current record is null; the report still returns marketplace history. Pinned in Task 3 (synthetic fixture).
4. **Koios or the indexer down mid-report.** Each section fails independently: the failed section carries `{ error: "<message>" }` and the rest of the report is still produced; the HTTP status stays 200 so the receipt commits to what was known. Pinned in Task 4.
5. **A request larger than the template allows or with no subject.** 400 with a reason; the runtime never claims a job it cannot answer. Pinned in Task 4.

---

## File structure

```
vector-service-agents/
  package.json  pnpm-workspace.yaml  tsconfig.base.json  vitest.workspace.ts  .nvmrc  .gitignore  LICENSE  README.md
  .github/workflows/ci.yml
  packages/vector-read/
    package.json  tsconfig.json  src/index.ts
    src/constants.ts          mainnet addresses, hashes, URLs
    src/koios.ts              typed POST helpers, batching
    src/indexer.ts            suppliers, escrows
    src/datum.ts              advert, escrow, registry, stake decoders; canonicalize; hashes   (vendored from Plan A)
    src/safe-fetch.ts         url policy                                                      (vendored from Plan A)
    src/fixture-fetch.ts      record / replay fetch for tests
    test/datum.test.ts  test/koios.test.ts  test/fixtures/*.json
    VENDORED-FROM.md
  agents/agent-history/
    package.json  tsconfig.json  Dockerfile  agent.json.template  README.md
    src/index.ts              boot
    src/server.ts             node:http: POST /, GET /agent.json, GET /healthz
    src/request.ts            parse the wire envelope and validate the request
    src/subject.ts            resolve DID | asset | pkh
    src/identity.ts           registry record, updates, rotations, deregistration
    src/marketplace.ts        adverts, escrows, spent flags, counts
    src/modules.ts            Module-3 stakes/endorsements, Module-1, Module-6 (generic match)
    src/key-roles.ts          /capability key vs controller
    src/report.ts             assemble, sources, blind spots
    src/cache.ts              TTL cache
    scripts/record-fixtures.mjs
    test/*.test.ts  test/fixtures/chandra.json
  specs/agent-history.md  specs/document-pipeline.md  specs/audio-snippets.md  specs/advocate.md
  docs/HIRE.md  docs/E2E.md  docs/superpowers/...
  scripts/e2e-hire.mjs  scripts/manifest-hash.mjs  scripts/no-secrets.test.mjs
  deploy/apex-web/docker-compose.agent-history.yml  .env.agent-history.example  Caddyfile.snippet  README.md  RUNBOOK.md
```

---

### Task 1: Repository scaffold and CI

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`, `.nvmrc`, `.gitignore`, `LICENSE`, `README.md`, `.github/workflows/ci.yml`, `scripts/no-secrets.test.mjs`

- [ ] **Step 1: Write the workspace files**

`package.json`:
```json
{
  "name": "vector-service-agents",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.33.2",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --if-present test && node --test scripts/no-secrets.test.mjs",
    "typecheck": "pnpm -r --if-present typecheck",
    "e2e": "node scripts/e2e-hire.mjs",
    "manifest-hash": "node scripts/manifest-hash.mjs"
  },
  "devDependencies": { "typescript": "^5.7.3", "vitest": "^3.2.4", "tsx": "^4.21.0", "@types/node": "^22.13.1" }
}
```
`pnpm-workspace.yaml`:
```yaml
packages:
  - packages/*
  - agents/*
```
`tsconfig.base.json`:
```json
{ "compilerOptions": { "target": "es2022", "module": "esnext", "moduleResolution": "bundler", "strict": true, "esModuleInterop": true, "skipLibCheck": true, "resolveJsonModule": true, "allowImportingTsExtensions": true, "noEmit": true, "types": ["node"] } }
```
`vitest.workspace.ts`:
```ts
export default ['packages/*', 'agents/*'];
```
`.nvmrc`: `22`
`.gitignore`:
```
node_modules
.env
.env.*
!.env.*.example
dist
build
*.log
vector-signer-audit-log.json
```
`LICENSE`: MIT text, `Copyright (c) 2026 Apex Fusion Foundation`.

`scripts/no-secrets.test.mjs`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
const FORBIDDEN = /(mnemonic|seed phrase|PRIV_KEY_HEX=[0-9a-f]{64}|ed25519_sk1[0-9a-z]{20,})/i;
function walk(dir, out = []) { for (const e of readdirSync(dir)) { const p = join(dir, e); if (e === 'node_modules' || e === '.git') continue; statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
test('no key material in the repo', () => {
  const hits = walk('.').filter((p) => /\.(ts|js|mjs|json|md|yml|yaml|example)$/.test(p) && !p.endsWith('no-secrets.test.mjs')).filter((p) => FORBIDDEN.test(readFileSync(p, 'utf8')));
  assert.deepEqual(hits, []);
});
```

`README.md` (initial):
```markdown
# Vector service agents

Service agents that anyone can hire on the Vector agents marketplace, with the guide that takes a working-group member from a chat client to a verified receipt.

| Agent | Capability id | Status |
|---|---|---|
| Agent History | `identity.history.report.v1` | PROPOSED |
| Document Pipeline | `document.pipeline.ocr-summary.v1` | PROPOSED |
| Audio Snippets | `audio.transcript.snippets.v1` | PROPOSED |
| Advocate | `research.advocate.onesided.v1` | PROPOSED |

- Hire one: `docs/HIRE.md`
- Specs: `specs/`
- Design: `docs/superpowers/specs/2026-10-13-vector-service-agents-design.md`

Operated by the Apex Fusion Foundation. MIT.
```

`.github/workflows/ci.yml`:
```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10.33.2 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm test
```

- [ ] **Step 2: Install, run the secrets test, commit, create the GitHub repo**

```bash
cd "C:/Users/Filip/Documents/Claude/vector-service-agents"
corepack enable && corepack prepare pnpm@10.33.2 --activate
pnpm install
node --test scripts/no-secrets.test.mjs
git add -A && git commit -m "chore: workspace scaffold, MIT licence, CI, no-secrets test"
gh repo create Apex-Fusion/vector-service-agents --public --source . --remote origin --description "Hireable service agents on the Vector agents marketplace" --push
```
Expected: the test passes, the repo exists, `main` is pushed.

### Task 2: `packages/vector-read`: constants, Koios, indexer, datum codecs, safeFetch, fixture fetch

**Files:**
- Create: `packages/vector-read/package.json`, `tsconfig.json`, `src/index.ts`, `src/constants.ts`, `src/koios.ts`, `src/indexer.ts`, `src/datum.ts`, `src/safe-fetch.ts`, `src/fixture-fetch.ts`, `VENDORED-FROM.md`
- Test: `packages/vector-read/test/datum.test.ts`, `test/koios.test.ts`

**Interfaces:**
- Produces: everything in `src/index.ts`: `KOIOS_URL`, `INDEXER_URL`, `REGISTRY_POLICY`, `REGISTRY_ADDRESS`, `ESCROW_ADDRESS`, `ADVERT_ADDRESS`, `M3_REPUTATION_ADDRESS`, `M3_ENDORSEMENT_ADDRESS`, `M1_ADDRESSES`, `M6_ADDRESSES`; `koios.post<T>(path, body, fetchImpl)`, `koios.tip`, `koios.assetUtxos`, `koios.assetHistory`, `koios.assetTxs`, `koios.txInfo`, `koios.addressUtxos`, `koios.utxoInfo`; `indexer.suppliers`, `indexer.escrows({ supplier?, buyer? })`; decoders `decodeAdvertDatum`, `decodeEscrowDatum`, `decodeRegistryDatum`, `decodeStakeDatum`, `topLevelBytes(hex)`; `canonicalize`, `sha256Utf8Hex`, `blake2b224Hex`; `safeFetch`; `recordingFetch(real, store)`, `replayFetch(store)`.

- [ ] **Step 1: Package files**

`packages/vector-read/package.json`:
```json
{
  "name": "@vsa/vector-read", "version": "0.1.0", "private": true, "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "dependencies": { "@lucid-evolution/lucid": "^0.4.29", "@noble/hashes": "^1.7.1" },
  "devDependencies": { "vitest": "^3.2.4", "typescript": "^5.7.3", "@types/node": "^22.13.1" }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

`VENDORED-FROM.md`:
```markdown
`src/datum.ts` and `src/safe-fetch.ts` are vendored from Apex-Fusion/mcp-server
`packages/builder/src/vector/{marketplace-datum,safe-fetch}.ts` at the commit of PR 1 of
the marketplace series (fill the commit hash here when PR 1 merges). The golden tests in
`test/datum.test.ts` are the same tests; a change in one repo must pass in both.
```

- [ ] **Step 2: Write the failing datum tests**

Copy Plan A Task 2's fixtures into `test/fixtures/marketplace.fixture.ts` (same content) and write `test/datum.test.ts` with the same nine tests, importing from `../src/datum.ts` and using `vitest`'s `describe/test/expect`:
```ts
import { describe, test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Data } from '@lucid-evolution/lucid';
import { decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, canonicalize, requestSpecHash, wirePayloadFor, promptHashForPayload, escrowLockFloor, decodeStakeDatum, decodeRegistryDatum, topLevelBytes } from '../src/datum.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED } from './fixtures/marketplace.fixture.ts';

describe('vendored marketplace codecs', () => {
  test('advert decodes', () => { expect(decodeAdvertDatum(ADVERT_DATUM_HEX)).toEqual(ADVERT_EXPECTED); });
  test('request_spec_hash matches the live escrow', () => { expect(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX))).toBe(ESCROW_EXPECTED.request_spec_hash); });
  test('escrow decodes and re-encodes semantically', () => {
    expect(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX)).toEqual(ESCROW_EXPECTED);
    expect(Data.from(encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX)))).toEqual(Data.from(ESCROW_OPEN_DATUM_HEX));
  });
  test('wire payload and prompt hash', () => {
    expect(wirePayloadFor('hello')).toBe('[{"content":"hello","role":"user"}]');
    expect(promptHashForPayload('hello')).toBe(createHash('sha256').update('[{"content":"hello","role":"user"}]').digest('hex'));
  });
  test('lock floor is at least the economic total', () => {
    const d = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    expect(escrowLockFloor(d, 2_200_000n) >= 2_200_000n).toBe(true);
  });
});

describe('registry and stake datums', () => {
  // Module-3 stake datum of ChandraOCR (05563e75…#0), captured 2026-10-13.
  const STAKE_FIELDS = { asset: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', owner: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9', amount: 10_000_000n, caps: ['ocr.page.extract.chandra-ocr-2.v1', 'document-extraction'], last_updated: 1786092804000, history_points: 0n };
  test('stake datum round-trips through the known shape', () => {
    const { Constr, fromText } = require('@lucid-evolution/lucid');
    const hex = Data.to(new Constr(0, [STAKE_FIELDS.asset, new Constr(0, [STAKE_FIELDS.owner]), STAKE_FIELDS.amount, STAKE_FIELDS.caps.map(fromText), BigInt(STAKE_FIELDS.last_updated), STAKE_FIELDS.history_points]));
    expect(decodeStakeDatum(hex)).toEqual({ agent_asset_name: STAKE_FIELDS.asset, owner_pkh: STAKE_FIELDS.owner, stake_lovelace: STAKE_FIELDS.amount, capabilities: STAKE_FIELDS.caps, last_updated: STAKE_FIELDS.last_updated, history_points: 0 });
  });
  test('registry datum decodes the seven fields', () => {
    const { Constr, fromText } = require('@lucid-evolution/lucid');
    const hex = Data.to(new Constr(0, [new Constr(0, ['ab'.repeat(28)]), fromText('Name'), fromText('Desc'), [fromText('a.b.v1')], fromText('fw'), fromText('https://e.example'), 1786092405791n]));
    expect(decodeRegistryDatum(hex)).toEqual({ owner_pkh: 'ab'.repeat(28), name: 'Name', description: 'Desc', capabilities: ['a.b.v1'], framework: 'fw', endpoint: 'https://e.example', registered_at: 1786092405791 });
  });
  test('topLevelBytes lists bytes fields of an unknown constructor', () => {
    const { Constr } = require('@lucid-evolution/lucid');
    const hex = Data.to(new Constr(0, ['aa'.repeat(32), new Constr(0, ['bb'.repeat(28)]), 5n]));
    expect(topLevelBytes(hex)).toEqual(['aa'.repeat(32), 'bb'.repeat(28)]);
  });
});
```
(Use `import { Constr, fromText } from '@lucid-evolution/lucid'` at the top instead of `require` when the ESM setup complains.)

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @vsa/vector-read test` Expected: FAIL, module not found.

- [ ] **Step 4: Write `src/constants.ts`, `src/datum.ts`, `src/safe-fetch.ts`**

`src/constants.ts`:
```ts
export const KOIOS_URL = process.env.KOIOS_URL ?? 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
export const INDEXER_URL = process.env.INDEXER_URL ?? 'https://mp-indexer.vector.apexfusion.org';
export const REGISTRY_POLICY = 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01';
export const REGISTRY_ADDRESS = 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42';
export const ADVERT_ADDRESS = 'addr1wxvjn7jwak9kdvctscywvq0d9f9hksf6ysfa6yatya2efksvgxwpa';
export const ESCROW_ADDRESS = 'addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5';
export const ESCROW_SCRIPT_HASH = '810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912';
export const M3_REPUTATION_ADDRESS = 'addr1w9gk3cv8rn7mre2urrhpwwkteh8qjgzy5j9u9c3l8w34pyc76uluq';
export const M3_ENDORSEMENT_ADDRESS = 'addr1w9m3j6ld07uy2asssqxvwfqu73ykuqxhjqw7jpulkqera0cjm7mmz';
export const M1_ADDRESSES = {
  claim: 'addr1wx5ayt5tq8fg905qq7udnclg4a2g42jk78p7gv7qahwcwcqjd9tzq',
  challenge: 'addr1wyf8qr6240wk8j4t8zklk5z9tkj55njtcpqz5jcat2gdr7cazrd0t',
  jury_pool: 'addr1wy4sr34nzeprwatleqhxg7qvv0k0c826wv7wjxdrutn472q7yn6fa',
} as const;
export const M6_ADDRESSES = {
  proposal: 'addr1wxvtvyx9jkt7jprdhm0g6wxkl8pvvc63vlwumju8f5uatzgnjjjcr',
  critique: 'addr1w9gas5jxfye79d7g87lddu5p3lhvt67ku4ptfvgyqn4rp6stn80z3',
  endorsement: 'addr1w8t3qgtthdpznyaw5vtdh87tlekzg5f5rdcav20ghwf7pms2mfltj',
} as const;
export const didFor = (assetName: string) => `did:vector:agent:${REGISTRY_POLICY}:${assetName}`;
```
`src/datum.ts`: the full content of Plan A Task 2 Step 5 (`marketplace-datum.ts`), plus these additions at the end:
```ts
export interface RegistryDatum { owner_pkh: string; name: string; description: string; capabilities: string[]; framework: string; endpoint: string; registered_at: number }
export function decodeRegistryDatum(hex: string): RegistryDatum {
  const c = asConstr(Data.from(hex), 'registry');
  if (c.index !== 0 || c.fields.length !== 7) throw new Error(`registry: expected 7 fields, got ${c.fields.length}`);
  const owner = asConstr(c.fields[0], 'registry.owner');
  return {
    owner_pkh: asBytes(owner.fields[0], 'registry.owner.pkh'),
    name: toText(asBytes(c.fields[1], 'registry.name')), description: toText(asBytes(c.fields[2], 'registry.description')),
    capabilities: (c.fields[3] as unknown[]).map((x) => toText(asBytes(x, 'registry.capability'))),
    framework: toText(asBytes(c.fields[4], 'registry.framework')), endpoint: toText(asBytes(c.fields[5], 'registry.endpoint')),
    registered_at: Number(asInt(c.fields[6], 'registry.registered_at')),
  };
}
export interface StakeDatum { agent_asset_name: string; owner_pkh: string; stake_lovelace: bigint; capabilities: string[]; last_updated: number; history_points: number }
export function decodeStakeDatum(hex: string): StakeDatum {
  const c = asConstr(Data.from(hex), 'stake');
  if (c.index !== 0 || c.fields.length !== 6) throw new Error(`stake: expected 6 fields, got ${c.fields.length}`);
  return {
    agent_asset_name: asBytes(c.fields[0], 'stake.asset'), owner_pkh: asBytes(asConstr(c.fields[1], 'stake.owner').fields[0], 'stake.owner.pkh'),
    stake_lovelace: asInt(c.fields[2], 'stake.amount'), capabilities: (c.fields[3] as unknown[]).map((x) => toText(asBytes(x, 'stake.capability'))),
    last_updated: Number(asInt(c.fields[4], 'stake.last_updated')), history_points: Number(asInt(c.fields[5], 'stake.history_points')),
  };
}
/** Bytes fields at the top level or one constructor deep: enough to match a datum to an asset name or key hash without knowing its full schema. */
export function topLevelBytes(hex: string): string[] {
  const out: string[] = [];
  const walk = (x: unknown, depth: number) => {
    if (typeof x === 'string') out.push(x.toLowerCase());
    else if (x instanceof Constr && depth <= 1) x.fields.forEach((f) => walk(f, depth + 1));
  };
  walk(Data.from(hex), 0);
  return out;
}
import { blake2b } from '@noble/hashes/blake2b';
export function blake2b224Hex(hex: string): string { return Buffer.from(blake2b(Buffer.from(hex, 'hex'), { dkLen: 28 })).toString('hex'); }
```
`src/safe-fetch.ts`: the full content of Plan A Task 7 Step 3.

- [ ] **Step 5: Write `src/koios.ts`, `src/indexer.ts`, `src/fixture-fetch.ts`, `src/index.ts`**

`src/koios.ts`:
```ts
import { KOIOS_URL } from './constants.ts';
export type Fetch = typeof fetch;
const H = { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-service-agents' };
export async function post<T>(path: string, body: unknown, fetchImpl: Fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const res = await fetchImpl(`${KOIOS_URL}/${path}`, { method: 'POST', headers: H, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Koios ${path} answered ${res.status}`);
  return (await res.json()) as T;
}
export async function get<T>(path: string, fetchImpl: Fetch = fetch, timeoutMs = 20_000): Promise<T> {
  const res = await fetchImpl(`${KOIOS_URL}/${path}`, { headers: H, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Koios ${path} answered ${res.status}`);
  return (await res.json()) as T;
}
export interface KoiosUtxo { tx_hash: string; tx_index: number; address?: string; value: string; block_height?: number; block_time?: number; is_spent?: boolean; inline_datum?: { bytes: string } | null; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> | null; reference_script?: { hash: string; bytes: string } | null }
export interface KoiosTxInfo { tx_hash: string; block_height: number; tx_timestamp: number; inputs: Array<{ tx_hash: string; tx_index: number; payment_addr: { cred: string; bech32: string }; value: string; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> }>; outputs: Array<{ tx_index: number; payment_addr: { cred: string; bech32: string }; value: string; inline_datum: { bytes: string } | null; asset_list?: Array<{ policy_id: string; asset_name: string; quantity: string }> }>; assets_minted?: Array<{ policy_id: string; asset_name: string; quantity: string }> }
export const koios = {
  tip: (f?: Fetch) => get<Array<{ block_no: number; abs_slot: number; block_time: number; hash: string }>>('tip', f),
  assetUtxos: (policy: string, name: string, f?: Fetch) => post<KoiosUtxo[]>('asset_utxos', { _asset_list: [[policy, name]], _extended: true }, f),
  assetHistory: (policy: string, name: string, f?: Fetch) => post<Array<{ minting_txs: Array<{ tx_hash: string; quantity: string; block_time: number }> }>>('asset_history', { _asset_policy: policy, _asset_name: name }, f),
  assetTxs: (policy: string, name: string, f?: Fetch) => post<Array<{ tx_hash: string; block_height: number; block_time: number }>>('asset_txs', { _asset_policy: policy, _asset_name: name, _history: true }, f),
  txInfo: (hashes: string[], f?: Fetch) => post<KoiosTxInfo[]>('tx_info', { _tx_hashes: hashes }, f),
  addressUtxos: (addresses: string[], f?: Fetch) => post<KoiosUtxo[]>('address_utxos', { _addresses: addresses, _extended: true }, f, 40_000),
  utxoInfo: (refs: string[], f?: Fetch) => post<KoiosUtxo[]>('utxo_info', { _utxo_refs: refs, _extended: true }, f),
};
```
`src/indexer.ts`:
```ts
import { INDEXER_URL } from './constants.ts';
import type { Fetch } from './koios.ts';
export interface SupplierRow { utxo_ref: string; supplier_pkh: string; capability_id: string; model: string; price_lovelace: string; supplier_bond_lovelace: string; buyer_bond_lovelace: string; max_processing_ms: number; endpoint_url: string; detail_uri: string; status: string; advert_status: string; last_seen_iso: string | null; advertised_at: number }
export interface EscrowRow { utxo_ref: string; buyer_pkh: string; supplier_pkh: string; advert_ref: string; capability_id: string; payment_lovelace: string; deliver_by: number; posted_at: number; submitted_at: number | null; result_receipt_hash: string | null; state: string }
async function getJson<T>(url: string, f: Fetch = fetch): Promise<T> {
  const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'vector-service-agents' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`indexer ${new URL(url).pathname} answered ${res.status}`);
  return (await res.json()) as T;
}
export const indexer = {
  suppliers: (f?: Fetch) => getJson<SupplierRow[]>(`${INDEXER_URL}/suppliers`, f),
  escrows: (q: { supplier?: string; buyer?: string }, f?: Fetch) => getJson<EscrowRow[]>(`${INDEXER_URL}/escrows?${new URLSearchParams(q as Record<string, string>)}`, f),
};
```
`src/fixture-fetch.ts`:
```ts
// Record every outbound call into a JSON map, or replay from it. Key = method + url + body.
import type { Fetch } from './koios.ts';
export type FixtureStore = Record<string, { status: number; body: string }>;
const keyOf = (url: string, init?: RequestInit) => `${init?.method ?? 'GET'} ${url} ${typeof init?.body === 'string' ? init.body : ''}`;
export function recordingFetch(real: Fetch, store: FixtureStore): Fetch {
  return (async (url: any, init?: RequestInit) => {
    const res = await real(url, init);
    const body = await res.text();
    store[keyOf(String(url), init)] = { status: res.status, body };
    return new Response(body, { status: res.status, headers: { 'content-type': 'application/json' } });
  }) as Fetch;
}
export function replayFetch(store: FixtureStore): Fetch {
  return (async (url: any, init?: RequestInit) => {
    const hit = store[keyOf(String(url), init)];
    if (!hit) throw new Error(`fixture miss: ${keyOf(String(url), init)}`);
    return new Response(hit.body, { status: hit.status, headers: { 'content-type': 'application/json' } });
  }) as Fetch;
}
```
`src/index.ts` re-exports everything from the five modules.

- [ ] **Step 6: Koios/indexer client tests**

```ts
// packages/vector-read/test/koios.test.ts
import { describe, test, expect } from 'vitest';
import { koios, indexer, recordingFetch, replayFetch } from '../src/index.ts';
describe('clients', () => {
  test('utxoInfo posts _utxo_refs and replays through the fixture store', async () => {
    const store: Record<string, { status: number; body: string }> = {};
    const fake = (async (_u: any, init: any) => new Response(JSON.stringify([{ tx_hash: 'a'.repeat(64), tx_index: 0, value: '1', is_spent: true }]), { status: 200 })) as typeof fetch;
    const rec = recordingFetch(fake, store);
    const first = await koios.utxoInfo(['a'.repeat(64) + '#0'], rec);
    expect(first[0].is_spent).toBe(true);
    const again = await koios.utxoInfo(['a'.repeat(64) + '#0'], replayFetch(store));
    expect(again).toEqual(first);
    expect(Object.keys(store)[0]).toContain('utxo_info');
  });
  test('indexer.escrows builds the query string', async () => {
    let seen = '';
    const fake = (async (u: any) => { seen = String(u); return new Response('[]', { status: 200 }); }) as typeof fetch;
    await indexer.escrows({ supplier: 'ab' }, fake);
    expect(seen).toBe('https://mp-indexer.vector.apexfusion.org/escrows?supplier=ab');
  });
});
```

- [ ] **Step 7: Run, typecheck, commit, push**

```bash
pnpm install && pnpm --filter @vsa/vector-read test && pnpm --filter @vsa/vector-read typecheck
git add -A && git commit -m "feat(vector-read): Koios and indexer clients, vendored datum codecs, safeFetch, fixture fetch" && git push
```
Expected: 10 tests pass (8 datum, 2 client).

### Task 3: Agent History: request parsing, subject resolution, identity section

**Files:**
- Create: `agents/agent-history/package.json`, `tsconfig.json`, `src/request.ts`, `src/subject.ts`, `src/identity.ts`, `src/cache.ts`
- Test: `agents/agent-history/test/request.test.ts`, `test/subject.test.ts`, `test/identity.test.ts`

**Interfaces:**
- Produces: `parseWire(body: string): HistoryRequest` (throws `BadRequest` with `.status = 400`), `HistoryRequest = { subject: string; include: Section[] }`, `resolveSubject(subject, f): Promise<Subject>` where `Subject = { kind: 'asset' | 'pkh'; asset_name: string | null; did: string | null; controller_pkh: string | null; candidates: Array<{ asset_name; did; name }> }`, `identitySection(subject, f): Promise<IdentitySection>`.

- [ ] **Step 1: Package files**

`agents/agent-history/package.json`:
```json
{
  "name": "@vsa/agent-history", "version": "0.1.0", "private": true, "type": "module",
  "scripts": { "start": "tsx src/index.ts", "test": "vitest run", "typecheck": "tsc --noEmit", "record-fixtures": "node scripts/record-fixtures.mjs" },
  "dependencies": { "@vsa/vector-read": "workspace:*", "@lucid-evolution/lucid": "^0.4.29", "tsx": "^4.21.0" },
  "devDependencies": { "vitest": "^3.2.4", "typescript": "^5.7.3", "@types/node": "^22.13.1" }
}
```
`tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }`

- [ ] **Step 2: Write the failing tests**

`test/request.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { parseWire } from '../src/request.ts';
const wrap = (s: string) => JSON.stringify([{ content: s, role: 'user' }]);
describe('parseWire', () => {
  test('accepts a DID subject and defaults include', () => {
    expect(parseWire(wrap('{"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:' + 'ab'.repeat(32) + '"}')))
      .toEqual({ subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:' + 'ab'.repeat(32), include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] });
  });
  test('rejects a missing subject with 400', () => {
    expect(() => parseWire(wrap('{}'))).toThrowError(expect.objectContaining({ status: 400 }));
  });
  test('rejects a body that is not the message array', () => {
    expect(() => parseWire('{"subject":"x"}')).toThrowError(/message array/);
  });
  test('rejects an unknown include value and an oversized body', () => {
    expect(() => parseWire(wrap('{"subject":"' + 'ab'.repeat(28) + '","include":["nope"]}'))).toThrowError(/include/);
    expect(() => parseWire('x'.repeat(70_000))).toThrowError(/too large/);
  });
});
```
`test/subject.test.ts` (uses a hand-built fixture store):
```ts
import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { resolveSubject } from '../src/subject.ts';
const ASSET = 'ab'.repeat(32), OWNER = 'cd'.repeat(28);
const datum = Data.to(new Constr(0, [new Constr(0, [OWNER]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const utxo = { tx_hash: 'ee'.repeat(32), tx_index: 0, address: REGISTRY_ADDRESS, value: '10000000', inline_datum: { bytes: datum }, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }] };
const store = {
  [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, ASSET]], _extended: true })}`]: { status: 200, body: JSON.stringify([utxo]) },
  [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/address_utxos ${JSON.stringify({ _addresses: [REGISTRY_ADDRESS], _extended: true })}`]: { status: 200, body: JSON.stringify([utxo, { ...utxo, tx_index: 1, asset_list: [{ policy_id: REGISTRY_POLICY, asset_name: 'ff'.repeat(32), quantity: '1' }] }]) },
};
describe('resolveSubject', () => {
  test('a DID resolves to its asset and controller', async () => {
    const s = await resolveSubject(`did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, replayFetch(store));
    expect(s).toMatchObject({ kind: 'asset', asset_name: ASSET, controller_pkh: OWNER });
  });
  test('a key hash lists every record it controls and picks the first', async () => {
    const s = await resolveSubject(OWNER, replayFetch(store));
    expect(s.kind).toBe('pkh'); expect(s.candidates.length).toBe(2); expect(s.asset_name).toBe(ASSET);
  });
  test('an unknown asset resolves with null identity, not an error', async () => {
    const miss = { ...store, [`POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos ${JSON.stringify({ _asset_list: [[REGISTRY_POLICY, '11'.repeat(32)], _extended: true })}`]: { status: 200, body: '[]' } };
    const s = await resolveSubject('11'.repeat(32), replayFetch(miss));
    expect(s.asset_name).toBe('11'.repeat(32)); expect(s.controller_pkh).toBeNull();
  });
});
```
`test/identity.test.ts` (synthetic registration + rotation + deregistration):
```ts
import { describe, test, expect } from 'vitest';
import { Data, Constr, fromText } from '@lucid-evolution/lucid';
import { replayFetch, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import { identitySection } from '../src/identity.ts';
const ASSET = 'ab'.repeat(32), A = 'cd'.repeat(28), B = 'ef'.repeat(28), K = 'https://v2.koios.vector.mainnet.apexfusion.org/api/v1';
const reg = (owner: string) => Data.to(new Constr(0, [new Constr(0, [owner]), fromText('A'), fromText('d'), [fromText('x.y.v1')], fromText('fw'), fromText(''), 1n]));
const tok = [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '1' }];
const out = (datum: string | null, withTok = true) => ({ tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '10000000', inline_datum: datum ? { bytes: datum } : null, asset_list: withTok ? tok : [] });
const txs = [
  { tx_hash: '11'.repeat(32), block_height: 100, tx_timestamp: 1000, inputs: [], outputs: [out(reg(A))], assets_minted: tok },
  { tx_hash: '22'.repeat(32), block_height: 200, tx_timestamp: 2000, inputs: [{ tx_hash: '11'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [out(reg(B))] },
  { tx_hash: '33'.repeat(32), block_height: 300, tx_timestamp: 3000, inputs: [{ tx_hash: '22'.repeat(32), tx_index: 0, payment_addr: { cred: 'x', bech32: REGISTRY_ADDRESS }, value: '1', asset_list: tok }], outputs: [{ ...out(null, false), payment_addr: { cred: 'y', bech32: 'addr1v' + 'q'.repeat(50) } }], assets_minted: [{ policy_id: REGISTRY_POLICY, asset_name: ASSET, quantity: '-1' }] },
];
const store = {
  [`POST ${K}/asset_txs ${JSON.stringify({ _asset_policy: REGISTRY_POLICY, _asset_name: ASSET, _history: true })}`]: { status: 200, body: JSON.stringify(txs.map((t) => ({ tx_hash: t.tx_hash, block_height: t.block_height, block_time: t.tx_timestamp }))) },
  [`POST ${K}/tx_info ${JSON.stringify({ _tx_hashes: txs.map((t) => t.tx_hash) })}`]: { status: 200, body: JSON.stringify(txs) },
};
describe('identitySection', () => {
  test('registration, controller rotation and deregistration are all reported', async () => {
    const id = await identitySection({ kind: 'asset', asset_name: ASSET, did: `did:vector:agent:${REGISTRY_POLICY}:${ASSET}`, controller_pkh: null, candidates: [] }, replayFetch(store));
    expect(id.registered).toMatchObject({ tx: '11'.repeat(32), block: 100 });
    expect(id.updates).toEqual([{ tx: '22'.repeat(32), block: 200, time: 2000, kind: 'controller_rotation', from_pkh: A, to_pkh: B }]);
    expect(id.deregistered).toMatchObject({ tx: '33'.repeat(32), block: 300 });
    expect(id.record).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @vsa/agent-history test` Expected: FAIL, modules not found.

- [ ] **Step 4: Write the modules**

`src/request.ts`:
```ts
export const SECTIONS = ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] as const;
export type Section = typeof SECTIONS[number];
export interface HistoryRequest { subject: string; include: Section[] }
export class BadRequest extends Error { status = 400; constructor(m: string) { super(m); } }
const MAX_BODY = 64 * 1024;
export function parseWire(body: string): HistoryRequest {
  if (body.length > MAX_BODY) throw new BadRequest(`request too large (${body.length} bytes, max ${MAX_BODY})`);
  let arr: unknown;
  try { arr = JSON.parse(body); } catch { throw new BadRequest('body is not JSON'); }
  if (!Array.isArray(arr) || arr.length !== 1 || typeof (arr[0] as any)?.content !== 'string') throw new BadRequest('body must be the one-element message array [{content, role}]');
  let req: any;
  try { req = JSON.parse((arr[0] as any).content); } catch { throw new BadRequest('message content must be a JSON object with a subject'); }
  if (!req || typeof req.subject !== 'string' || req.subject.trim() === '') throw new BadRequest('subject is required: a DID, a registry asset name, or a key hash');
  const include = req.include === undefined ? [...SECTIONS] : req.include;
  if (!Array.isArray(include) || include.some((s: unknown) => !SECTIONS.includes(s as Section))) throw new BadRequest(`include must be a subset of ${SECTIONS.join(', ')}`);
  return { subject: req.subject.trim(), include: include as Section[] };
}
```
`src/cache.ts`:
```ts
export class TtlCache<V> {
  private m = new Map<string, { v: V; exp: number }>();
  constructor(private ttlMs: number) {}
  async getOr(key: string, fn: () => Promise<V>): Promise<V> {
    const hit = this.m.get(key);
    if (hit && hit.exp > Date.now()) return hit.v;
    const v = await fn(); this.m.set(key, { v, exp: Date.now() + this.ttlMs }); return v;
  }
}
```
`src/subject.ts`:
```ts
import { koios, decodeRegistryDatum, REGISTRY_POLICY, REGISTRY_ADDRESS, didFor } from '@vsa/vector-read';
import type { Fetch } from '@vsa/vector-read';
export interface Subject { kind: 'asset' | 'pkh'; asset_name: string | null; did: string | null; controller_pkh: string | null; candidates: Array<{ asset_name: string; did: string; name: string }> }
const DID_RE = /^did:vector:agent:([0-9a-f]{56}):([0-9a-f]{64})$/i;
export async function resolveSubject(input: string, f: Fetch): Promise<Subject> {
  const did = DID_RE.exec(input);
  const asset = did ? did[2].toLowerCase() : /^[0-9a-f]{64}$/i.test(input) ? input.toLowerCase() : null;
  if (asset) {
    const utxos = await koios.assetUtxos(REGISTRY_POLICY, asset, f);
    const u = utxos.find((x) => x.inline_datum?.bytes);
    const owner = u ? decodeRegistryDatum(u.inline_datum!.bytes).owner_pkh : null;
    return { kind: 'asset', asset_name: asset, did: didFor(asset), controller_pkh: owner, candidates: [] };
  }
  if (!/^[0-9a-f]{56}$/i.test(input)) throw Object.assign(new Error('subject must be a DID, a 64-hex registry asset name, or a 56-hex key hash'), { status: 400 });
  const pkh = input.toLowerCase();
  const all = await koios.addressUtxos([REGISTRY_ADDRESS], f);
  const candidates: Subject['candidates'] = [];
  for (const u of all) {
    if (!u.inline_datum?.bytes) continue;
    let d; try { d = decodeRegistryDatum(u.inline_datum.bytes); } catch { continue; }
    if (d.owner_pkh !== pkh) continue;
    const tok = (u.asset_list ?? []).find((a) => a.policy_id === REGISTRY_POLICY);
    if (tok) candidates.push({ asset_name: tok.asset_name, did: didFor(tok.asset_name), name: d.name });
  }
  const first = candidates[0] ?? null;
  return { kind: 'pkh', asset_name: first?.asset_name ?? null, did: first?.did ?? null, controller_pkh: pkh, candidates };
}
```
`src/identity.ts`:
```ts
import { koios, decodeRegistryDatum, REGISTRY_POLICY, REGISTRY_ADDRESS } from '@vsa/vector-read';
import type { Fetch, KoiosTxInfo, RegistryDatum } from '@vsa/vector-read';
import type { Subject } from './subject.ts';
export interface IdentitySection {
  registered: { tx: string; block: number; time: number } | null;
  record: RegistryDatum | null;
  updates: Array<{ tx: string; block: number; time: number; kind: 'update' | 'controller_rotation'; from_pkh: string; to_pkh: string }>;
  deregistered: { tx: string; block: number; time: number } | null;
}
const hasToken = (l: Array<{ policy_id: string; asset_name: string }> | null | undefined, asset: string) => (l ?? []).some((a) => a.policy_id === REGISTRY_POLICY && a.asset_name === asset);
export async function identitySection(s: Subject, f: Fetch): Promise<IdentitySection> {
  const empty: IdentitySection = { registered: null, record: null, updates: [], deregistered: null };
  if (!s.asset_name) return empty;
  const list = await koios.assetTxs(REGISTRY_POLICY, s.asset_name, f);
  if (list.length === 0) return empty;
  const infos = await koios.txInfo(list.map((t) => t.tx_hash), f);
  const byHash = new Map(infos.map((t) => [t.tx_hash, t]));
  const ordered = list.slice().sort((a, b) => a.block_height - b.block_height).map((t) => byHash.get(t.tx_hash)).filter((t): t is KoiosTxInfo => Boolean(t));
  let prevOwner: string | null = null; let record: RegistryDatum | null = null;
  const out: IdentitySection = { ...empty, updates: [] };
  for (const tx of ordered) {
    const o = tx.outputs.find((x) => x.payment_addr.bech32 === REGISTRY_ADDRESS && hasToken(x.asset_list, s.asset_name!) && x.inline_datum?.bytes);
    const spentToken = tx.inputs.some((i) => hasToken(i.asset_list, s.asset_name!));
    const at = { tx: tx.tx_hash, block: tx.block_height, time: tx.tx_timestamp };
    if (o) {
      const d = decodeRegistryDatum(o.inline_datum!.bytes);
      if (!spentToken) out.registered = at;
      else out.updates.push({ ...at, kind: prevOwner && prevOwner !== d.owner_pkh ? 'controller_rotation' : 'update', from_pkh: prevOwner ?? d.owner_pkh, to_pkh: d.owner_pkh });
      prevOwner = d.owner_pkh; record = d;
    } else if (spentToken) { out.deregistered = at; record = null; }
  }
  out.record = record;
  return out;
}
```

- [ ] **Step 5: Run, commit**

Run: `pnpm install && pnpm --filter @vsa/agent-history test` Expected: 8 tests pass.
```bash
git add -A && git commit -m "feat(agent-history): request parsing, subject resolution, identity timeline" && git push
```

### Task 4: Agent History: marketplace, modules, key roles, report, server, fixtures

**Files:**
- Create: `src/marketplace.ts`, `src/modules.ts`, `src/key-roles.ts`, `src/report.ts`, `src/server.ts`, `src/index.ts`, `scripts/record-fixtures.mjs`, `agent.json.template`
- Test: `test/report.test.ts`, `test/server.test.ts`, `test/fixtures/chandra.json` (recorded)

**Interfaces:**
- Produces: `buildReport(req, f, opts: { manifest: Manifest }): Promise<Report>`; `createServer(opts): http.Server`; manifest from env via `manifestFromEnv()`.

- [ ] **Step 1: Write the modules**

`src/marketplace.ts`:
```ts
import { koios, indexer } from '@vsa/vector-read';
import type { Fetch, EscrowRow } from '@vsa/vector-read';
export interface MarketplaceSide { adverts: Array<{ advert_ref: string; capability_id: string; model: string; price_lovelace: string; status: string; advertised_at: number }>; escrows: { total: number; by_indexer_state: Record<string, number>; latest_checked: number; latest_spent: number; first: EscrowRow | null; last: EscrowRow | null } }
const VERIFY_LATEST = 50;
async function side(rows: EscrowRow[], f: Fetch) {
  const sorted = rows.slice().sort((a, b) => a.posted_at - b.posted_at);
  const by: Record<string, number> = {};
  for (const r of rows) by[r.state] = (by[r.state] ?? 0) + 1;
  const latest = sorted.slice(-VERIFY_LATEST);
  let spent = 0;
  if (latest.length) {
    const info = await koios.utxoInfo(latest.map((r) => r.utxo_ref), f);
    spent = info.filter((u) => u.is_spent).length;
  }
  return { total: rows.length, by_indexer_state: by, latest_checked: latest.length, latest_spent: spent, first: sorted[0] ?? null, last: sorted[sorted.length - 1] ?? null };
}
export async function marketplaceSection(pkh: string | null, f: Fetch): Promise<{ as_supplier: MarketplaceSide; as_buyer: MarketplaceSide; outcome_verification: string } | null> {
  if (!pkh) return null;
  const [suppliers, asSup, asBuy] = await Promise.all([indexer.suppliers(f), indexer.escrows({ supplier: pkh }, f), indexer.escrows({ buyer: pkh }, f)]);
  const adverts = suppliers.filter((s) => s.supplier_pkh === pkh).map((s) => ({ advert_ref: s.utxo_ref, capability_id: s.capability_id, model: s.model, price_lovelace: s.price_lovelace, status: s.advert_status, advertised_at: s.advertised_at }));
  return { as_supplier: { adverts, escrows: await side(asSup, f) }, as_buyer: { adverts: [], escrows: await side(asBuy, f) }, outcome_verification: `indexer state for all rows; spent flags checked on the latest ${VERIFY_LATEST} per side via Koios utxo_info` };
}
```
`src/modules.ts`:
```ts
import { koios, decodeStakeDatum, topLevelBytes, M3_REPUTATION_ADDRESS, M3_ENDORSEMENT_ADDRESS, M1_ADDRESSES, M6_ADDRESSES } from '@vsa/vector-read';
import type { Fetch, KoiosUtxo } from '@vsa/vector-read';
const ref = (u: KoiosUtxo) => `${u.tx_hash}#${u.tx_index}`;
export async function reputationSection(asset: string | null, pkh: string | null, f: Fetch) {
  const [stakeUtxos, endorseUtxos] = await Promise.all([koios.addressUtxos([M3_REPUTATION_ADDRESS], f), koios.addressUtxos([M3_ENDORSEMENT_ADDRESS], f)]);
  const stakes = stakeUtxos.flatMap((u) => { try { const d = decodeStakeDatum(u.inline_datum!.bytes); return (asset && d.agent_asset_name === asset) || (pkh && d.owner_pkh === pkh) ? [{ utxo: ref(u), ...d, stake_lovelace: d.stake_lovelace.toString() }] : []; } catch { return []; } });
  const mentions = (list: KoiosUtxo[]) => list.flatMap((u) => { try { const b = topLevelBytes(u.inline_datum!.bytes); return (asset && b.includes(asset)) || (pkh && b.includes(pkh)) ? [{ utxo: ref(u), block: u.block_height ?? null, fields: b }] : []; } catch { return []; } });
  return { stakes, endorsements: mentions(endorseUtxos) };
}
export async function genericModuleSection(addresses: Record<string, string>, asset: string | null, pkh: string | null, f: Fetch) {
  const out: Record<string, Array<{ utxo: string; block: number | null; fields: string[] }>> = {};
  for (const [label, address] of Object.entries(addresses)) {
    const utxos = await koios.addressUtxos([address], f);
    out[label] = utxos.flatMap((u) => { try { const b = topLevelBytes(u.inline_datum!.bytes); return (asset && b.includes(asset)) || (pkh && b.includes(pkh)) ? [{ utxo: ref(u), block: u.block_height ?? null, fields: b }] : []; } catch { return []; } });
  }
  return out;
}
export const disputeSection = (asset: string | null, pkh: string | null, f: Fetch) => genericModuleSection(M1_ADDRESSES, asset, pkh, f);
export const selfImprovementSection = (asset: string | null, pkh: string | null, f: Fetch) => genericModuleSection(M6_ADDRESSES, asset, pkh, f);
```
`src/key-roles.ts`:
```ts
import { safeFetch, blake2b224Hex } from '@vsa/vector-read';
export async function keyRoles(controllerPkh: string | null, adverts: Array<{ advert_ref: string }>, endpoint: string | null, fetchImpl: typeof fetch) {
  const out: { controller_pkh: string | null; advert_count: number; capability_key_matches_controller: boolean | 'unknown'; capability_endpoint: string | null } = { controller_pkh: controllerPkh, advert_count: adverts.length, capability_key_matches_controller: 'unknown', capability_endpoint: endpoint };
  if (!endpoint || !controllerPkh) return out;
  try {
    const r = await safeFetch(`${endpoint.replace(/\/+$/, '')}/capability`, { headers: { accept: 'application/json' } }, { timeoutMs: 20_000, maxResponseBytes: 64 * 1024, fetchImpl });
    const pub = String(JSON.parse(r.text).pub_key_hex ?? '');
    if (/^[0-9a-f]{64}$/i.test(pub)) out.capability_key_matches_controller = blake2b224Hex(pub) === controllerPkh;
  } catch { /* stays unknown */ }
  return out;
}
```
`src/report.ts`:
```ts
import { koios } from '@vsa/vector-read';
import type { Fetch } from '@vsa/vector-read';
import type { HistoryRequest } from './request.ts';
import { resolveSubject } from './subject.ts';
import { identitySection } from './identity.ts';
import { marketplaceSection } from './marketplace.ts';
import { reputationSection, disputeSection, selfImprovementSection } from './modules.ts';
import { keyRoles } from './key-roles.ts';
export interface Manifest { name: string; capability_id: string; version: string; identity: { did: string; controller_pkh: string }; keys: { supplier_pkh: string; pub_key_hex: string } }
const BLIND_SPOTS = [
  'Receipts name the supplier key hash, not the registry identifier; identity and marketplace are joined by key hash.',
  'Escrow outcomes come from the marketplace indexer, which does not distinguish Accept from Release on terminal spends; spent flags for the latest 50 are checked on the ledger.',
  'The dispute module is deployed but not wired to the escrow contract; dispute entries, if any, are matched by asset name or key hash without a verified schema.',
  'Module-1 and Module-6 datums are matched generically (bytes fields equal to the asset name or key hash); their full layouts are not decoded.',
];
async function guarded<T>(fn: () => Promise<T>): Promise<T | { error: string }> { try { return await fn(); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; } }
export async function buildReport(req: HistoryRequest, f: Fetch, opts: { manifest: Manifest; sourcesSeen?: () => string[] }) {
  const tipP = koios.tip(f).then((t) => ({ block: t[0].block_no, slot: t[0].abs_slot, time: t[0].block_time })).catch(() => null);
  const subject = await resolveSubject(req.subject, f);
  const want = new Set(req.include);
  const identity = want.has('identity') ? await guarded(() => identitySection(subject, f)) : undefined;
  const marketplace = want.has('marketplace') ? await guarded(() => marketplaceSection(subject.controller_pkh, f)) : undefined;
  const reputation = want.has('reputation') ? await guarded(() => reputationSection(subject.asset_name, subject.controller_pkh, f)) : undefined;
  const dispute = want.has('dispute') ? await guarded(() => disputeSection(subject.asset_name, subject.controller_pkh, f)) : undefined;
  const self_improvement = want.has('self_improvement') ? await guarded(() => selfImprovementSection(subject.asset_name, subject.controller_pkh, f)) : undefined;
  const record = identity && !('error' in identity) ? identity.record : null;
  const adverts = marketplace && !('error' in marketplace) && marketplace ? marketplace.as_supplier.adverts : [];
  const key_roles = await keyRoles(subject.controller_pkh, adverts, record?.endpoint || null, f);
  const blind = [...BLIND_SPOTS];
  if (identity && !('error' in identity) && !identity.registered) blind.unshift('No registry record found for this subject.');
  return {
    schema: 'vector.agent-history.report.v1', generated_by: { agent: opts.manifest.name, did: opts.manifest.identity.did, version: opts.manifest.version },
    subject, as_of: await tipP, identity, marketplace, reputation, dispute, self_improvement, key_roles,
    sources: opts.sourcesSeen?.() ?? [], blind_spots: blind,
  };
}
```
`src/server.ts`:
```ts
import { createServer as httpServer } from 'node:http';
import { parseWire, BadRequest } from './request.ts';
import { buildReport } from './report.ts';
import type { Manifest } from './report.ts';
import type { Fetch } from '@vsa/vector-read';
export function manifestFromEnv(env = process.env) {
  return {
    schema: 'vector.agent-manifest.v1', name: 'Agent History', capability_id: 'identity.history.report.v1', version: env.AGENT_VERSION ?? '0.1.0',
    description: 'Everything the Vector ledger knows about one agent identifier, as one signed report. Read-only; no model cost.',
    operator: { name: 'Apex Fusion Foundation', contact: env.OPERATOR_CONTACT ?? 'filip.blagojevic@foundation.apexfusion.org' },
    identity: { did: env.AGENT_DID ?? '', controller_pkh: env.SUPPLIER_PKH ?? '', registry_address: 'addr1wxlp5z3fztdpsp6ha57dvx6khw82kqvgcxwu8s8rjykjcqghprf42' },
    keys: { supplier_pkh: env.SUPPLIER_PKH ?? '', pub_key_hex: env.SUPPLIER_PUB_KEY_HEX ?? '' },
    interface: { request_schema: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', description: 'DID, registry asset name (64 hex) or key hash (56 hex)' }, include: { type: 'array', items: { enum: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] } } } }, response_schema: { $ref: 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md#response' }, routes: { job: '/v1/job', status: '/status', capability: '/capability' } },
    terms: { price_lovelace: Number(env.ADVERT_PRICE_LOVELACE ?? 1_000_000), supplier_bond_lovelace: 1_000_000, buyer_bond_lovelace: 1_000_000, max_processing_ms: Number(env.ADVERT_MAX_PROCESSING_MS ?? 300_000), input_limits: { request_bytes: 65536 } },
    behaviour: { data_handling: 'Reads public ledger data only; the request subject is not stored beyond a 60 s cache.', third_parties: ['Koios (Vector mainnet indexer)', 'marketplace indexer'] },
    status: { chip: env.AGENT_STATUS_CHIP ?? 'proposed', since: env.AGENT_STATUS_SINCE ?? '2026-10-13' },
    gaps: ['Escrow outcomes from the indexer; Accept vs Release not distinguished', 'Module-1 and Module-6 matched generically'],
    links: { spec: 'https://github.com/Apex-Fusion/vector-service-agents/blob/main/specs/agent-history.md', source: 'https://github.com/Apex-Fusion/vector-service-agents/tree/main/agents/agent-history', explorer_advert: env.ADVERT_EXPLORER_URL ?? '' },
  };
}
export function createServer(opts: { fetchImpl?: Fetch; manifest?: ReturnType<typeof manifestFromEnv> } = {}) {
  const manifest = opts.manifest ?? manifestFromEnv();
  const f = opts.fetchImpl ?? fetch;
  return httpServer(async (req, res) => {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(200, { ok: true });
      if (req.method === 'GET' && req.url === '/agent.json') return send(200, manifest);
      if (req.method !== 'POST') return send(404, { reason: 'not_found' });
      let body = ''; for await (const c of req) { body += c; if (body.length > 70_000) break; }
      const parsed = parseWire(body);
      const report = await buildReport(parsed, f, { manifest: manifest as unknown as Manifest });
      return send(200, report);
    } catch (e) {
      if (e instanceof BadRequest || (e as any)?.status === 400) return send(400, { reason: 'bad_request', message: (e as Error).message });
      return send(500, { reason: 'internal', message: e instanceof Error ? e.message : String(e) });
    }
  });
}
```
`src/index.ts`:
```ts
import { createServer } from './server.ts';
const port = Number(process.env.PORT ?? 9091), host = process.env.HOST ?? '0.0.0.0';
createServer().listen(port, host, () => console.log(`[agent-history] listening on ${host}:${port}`));
```

- [ ] **Step 2: Fixture recorder and the recorded tests**

`scripts/record-fixtures.mjs`:
```js
// Records every Koios/indexer/supplier call made while building the ChandraOCR report.
// Run once with network: pnpm --filter @vsa/agent-history record-fixtures
import { writeFileSync, mkdirSync } from 'node:fs';
import { recordingFetch } from '@vsa/vector-read';
import { buildReport } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
const store = {};
const req = { subject: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', include: ['identity', 'marketplace', 'reputation', 'dispute', 'self_improvement'] };
const report = await buildReport(req, recordingFetch(fetch, store), { manifest: manifestFromEnv({}) });
mkdirSync(new URL('../test/fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('../test/fixtures/chandra.json', import.meta.url), JSON.stringify({ store, report }, null, 0));
console.log(`recorded ${Object.keys(store).length} calls; identity.registered=${JSON.stringify(report.identity?.registered)}`);
```
Run it with `node --import tsx scripts/record-fixtures.mjs` from `agents/agent-history` (the `record-fixtures` script in package.json should be exactly that command). Expected: prints `registered={"tx":"fee14e5f…","block":7275113,…}`.

`test/report.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { replayFetch } from '@vsa/vector-read';
import { buildReport } from '../src/report.ts';
import { manifestFromEnv } from '../src/server.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
const DID = 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db';
describe('ChandraOCR report (recorded fixtures)', () => {
  test('identity', async () => {
    const r = await buildReport({ subject: DID, include: ['identity'] }, replayFetch(fx.store), { manifest: manifestFromEnv({}) });
    expect(r.subject.controller_pkh).toBe('401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9');
    expect(r.identity).toMatchObject({ registered: { tx: 'fee14e5f2bf46b45b16e339334977833140622aa4f0b46024fcafc587b0406e6', block: 7275113 }, updates: [], deregistered: null });
    expect((r.identity as any).record.name).toBe('ChandraOCR');
    expect((r.identity as any).record.registered_at).toBe(1786092405791);
  });
  test('marketplace and reputation', async () => {
    const r = await buildReport({ subject: DID, include: ['marketplace', 'reputation'] }, replayFetch(fx.store), { manifest: manifestFromEnv({}) });
    const m = r.marketplace as any;
    expect(m.as_supplier.adverts[0].capability_id).toBe('ocr.page.extract.chandra-ocr-2.v1');
    expect(m.as_supplier.escrows.total).toBeGreaterThan(3000);
    expect(m.as_supplier.escrows.latest_checked).toBe(50);
    const rep = r.reputation as any;
    expect(rep.stakes[0]).toMatchObject({ utxo: '05563e751a32ce766aaf7aa015140912563f559394b5ecea77226d2c90bd6d4f#0', stake_lovelace: '10000000' });
  });
  test('a failing section does not fail the report', async () => {
    const store = { ...fx.store };
    for (const k of Object.keys(store)) if (k.includes('/suppliers')) store[k] = { status: 503, body: '{}' };
    const r = await buildReport({ subject: DID, include: ['identity', 'marketplace'] }, replayFetch(store), { manifest: manifestFromEnv({}) });
    expect((r.marketplace as any).error).toMatch(/503/);
    expect((r.identity as any).registered.block).toBe(7275113);
  });
});
```
`test/server.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { replayFetch } from '@vsa/vector-read';
import { createServer, manifestFromEnv } from '../src/server.ts';
const fx = JSON.parse(readFileSync(new URL('./fixtures/chandra.json', import.meta.url), 'utf8'));
async function call(body: string, method = 'POST', path = '/') {
  const srv = createServer({ fetchImpl: replayFetch(fx.store), manifest: manifestFromEnv({ AGENT_DID: 'did:test' }) });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, body: method === 'POST' ? body : undefined, headers: { 'content-type': 'application/json' } });
  const text = await res.text(); srv.close();
  return { status: res.status, json: JSON.parse(text) };
}
describe('http surface', () => {
  test('healthz and agent.json', async () => {
    expect((await call('', 'GET', '/healthz')).json).toEqual({ ok: true });
    expect((await call('', 'GET', '/agent.json')).json.capability_id).toBe('identity.history.report.v1');
  });
  test('wire envelope produces a 200 report', async () => {
    const r = await call(JSON.stringify([{ content: JSON.stringify({ subject: '5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db', include: ['identity'] }), role: 'user' }]));
    expect(r.status).toBe(200); expect(r.json.schema).toBe('vector.agent-history.report.v1');
  });
  test('missing subject is a 400, not a 500', async () => {
    const r = await call(JSON.stringify([{ content: '{}', role: 'user' }]));
    expect(r.status).toBe(400); expect(r.json.reason).toBe('bad_request');
  });
  test('an unknown subject is a 200 with no identity', async () => {
    const store = { ...fx.store, ['POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_utxos ' + JSON.stringify({ _asset_list: [['be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01', '11'.repeat(32)]], _extended: true })]: { status: 200, body: '[]' }, ['POST https://v2.koios.vector.mainnet.apexfusion.org/api/v1/asset_txs ' + JSON.stringify({ _asset_policy: 'be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01', _asset_name: '11'.repeat(32), _history: true })]: { status: 200, body: '[]' } };
    const srv = createServer({ fetchImpl: replayFetch(store), manifest: manifestFromEnv({}) });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as any).port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST', body: JSON.stringify([{ content: JSON.stringify({ subject: '11'.repeat(32), include: ['identity'] }), role: 'user' }]) });
    const j = await res.json(); srv.close();
    expect(res.status).toBe(200); expect(j.identity.registered).toBeNull(); expect(j.blind_spots[0]).toMatch(/No registry record/);
  });
});
```

- [ ] **Step 3: Run, fix, commit**

```bash
pnpm --filter @vsa/agent-history record-fixtures
pnpm --filter @vsa/agent-history test && pnpm typecheck
git add -A && git commit -m "feat(agent-history): report assembly, http surface, recorded ChandraOCR fixtures" && git push
```
Expected: 15 tests pass. The `chandra.json` fixture is committed (a few hundred KB).

- [ ] **Step 4: Run it locally against the live ledger and read the report by hand**

```bash
cd agents/agent-history && AGENT_DID=did:local PORT=9091 pnpm start &
curl -s -X POST localhost:9091/ -H 'content-type: application/json' -d '[{"content":"{\"subject\":\"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]' | python -m json.tool | head -80
```
Expected: `identity.registered.block` 7275113, `reputation.stakes[0].stake_lovelace` "10000000", `key_roles.capability_key_matches_controller` true, total time under 60 s. Record the elapsed time in `agents/agent-history/README.md`.

### Task 5: Manifest template, hash script, the four specs

**Files:**
- Create: `agents/agent-history/agent.json.template`, `scripts/manifest-hash.mjs`, `specs/agent-history.md`, `specs/document-pipeline.md`, `specs/audio-snippets.md`, `specs/advocate.md`, `agents/agent-history/README.md`

- [ ] **Step 1: Manifest hash script**

```js
// scripts/manifest-hash.mjs - prints the sha256 of the bytes a running agent serves at /agent.json.
// Usage: node scripts/manifest-hash.mjs https://mp-suppliers-history.hal8.ai
import { createHash } from 'node:crypto';
const base = process.argv[2]; if (!base) { console.error('usage: manifest-hash <https://host>'); process.exit(2); }
const res = await fetch(`${base.replace(/\/+$/, '')}/agent.json`);
const bytes = Buffer.from(await res.arrayBuffer());
console.log(JSON.stringify({ detail_uri: `${base.replace(/\/+$/, '')}/agent.json`, detail_hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }));
```
`agent.json.template` is the JSON that `manifestFromEnv({})` prints, with the env-derived fields shown as `<AGENT_DID>`, `<SUPPLIER_PKH>`, `<SUPPLIER_PUB_KEY_HEX>` and a header comment line in the README explaining the service renders it from env.

- [ ] **Step 2: Write `specs/agent-history.md`** with the eleven headings from spec section 8, status `PROPOSED (built, not yet advertised)`, the request/response JSON from the spec section 7.2 updated to this plan's shapes (`marketplace.*.escrows.by_indexer_state`, `latest_checked`, `latest_spent`, `outcome_verification`; `key_roles.capability_key_matches_controller`), terms 1 / 1 / 1, 300 000 ms, 180 000 ms service timeout, the data sources table, the three ways to hire, the gaps list (identical to `BLIND_SPOTS` in `report.ts`), and an empty changelog with one line "0.1.0 first build".

- [ ] **Step 3: Write the three PROPOSED specs** (`document-pipeline.md`, `audio-snippets.md`, `advocate.md`) with the same headings, status `PROPOSED (not built)`, request and response JSON copied from spec sections 7.3, 7.4, 7.5, terms as there, and under "How to hire it": "Not yet advertised. When live, the three ways below apply." The Pipeline spec states the economics sentence from the spec (about 19 spent to earn 5 at five pages, Foundation-subsidised while the fee floor stands) and the first-party OCR hop. The Advocate spec includes the declared-bias statement verbatim.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "docs: agent manifests, manifest-hash script, four agent specs" && git push
```

### Task 6: The member guide, the E2E runbook and script

**Files:**
- Create: `docs/HIRE.md`, `docs/E2E.md`, `scripts/e2e-hire.mjs`; add `@modelcontextprotocol/sdk` to root devDependencies.

- [ ] **Step 1: Write `docs/HIRE.md`** following spec section 9 exactly, ten numbered sections, with: the signer install block (npx form, and the clone-and-build form marked "until the npx package is published"); the two-server client config JSON (hosted `https://mcp.vector.mainnet.apexfusion.org/mcp`, local signer with `VECTOR_SIGNER_PRIVATE_KEY`, `VECTOR_SIGNER_ADDRESS`, `VECTOR_SIGNER_SPEND_LIMIT_PER_TX`, `VECTOR_SIGNER_SPEND_LIMIT_DAILY`); the chat script verbatim:
```
1. "List the marketplace capabilities on Vector."
2. "Show me free suppliers for identity.history.report.v1."
3. "Hire the first one. Payload: {"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}. Use my signer address as changeAddress, sign, submit and wait for confirmation."
4. "Send the job with the same payload, then poll until it is done."
5. "Verify the receipt. If every check passes, accept, sign, submit and wait."
6. "Show me the receipt, the signature, the escrow reference and explorer links for the post and the accept."
```
the funding paragraph where the unit is named once; the cost table (lock = price + 2 bonds; fees about 1 across Post and Accept; bonds back on Accept; worked rows for prices 1, 2, 3, 5); the optional register-your-own-identifier step with `vector_build_register_agent`; the terminal fallback (`vector-agent-template` `try-it/src/buy-once.ts` with `--advert-ref`, `--endpoint`, `--payload-file`); the troubleshooting list; the honesty box. Explorer link pattern: `https://explorer.vector.mainnet.apexfusion.org/transaction/hash/<txid>`.

- [ ] **Step 2: Write `scripts/e2e-hire.mjs`**

```js
// scripts/e2e-hire.mjs - first-party end-to-end hire through the MCP tools.
// Needs: a running builder (BUILDER_URL, default https://mcp.vector.mainnet.apexfusion.org/mcp),
// the local signer build path (SIGNER_ENTRY) and its env (VECTOR_SIGNER_PRIVATE_KEY, VECTOR_SIGNER_ADDRESS),
// ADVERT_REF and PAYLOAD (JSON string). Prints every step; exits non-zero on the first failure.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`missing ${k}`); process.exit(2); } return env[k]; };
const BUILDER_URL = env.BUILDER_URL ?? 'https://mcp.vector.mainnet.apexfusion.org/mcp';
const SIGNER_ENTRY = need('SIGNER_ENTRY'); const ADVERT_REF = need('ADVERT_REF'); const PAYLOAD = need('PAYLOAD');
const builder = new Client({ name: 'e2e-hire', version: '0.1.0' }); await builder.connect(new StreamableHTTPClientTransport(new URL(BUILDER_URL)));
const signer = new Client({ name: 'e2e-signer', version: '0.1.0' }); await signer.connect(new StdioClientTransport({ command: 'node', args: [SIGNER_ENTRY], env: { ...env } }));
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); const t = r.content.map((x) => x.text ?? '').join('\n'); const m = /```json\n([\s\S]*?)\n```/.exec(t); console.log(`\n== ${name}\n${t.slice(0, 600)}`); if (/^Failed|Rate limit/m.test(t)) throw new Error(`${name} failed`); return { text: t, json: m ? JSON.parse(m[1]) : null }; };
const cbor = (t) => /```\n([0-9a-f]+)\n```/i.exec(t)?.[1];
const signSubmitAwait = async (unsignedText) => {
  const s = await call(signer, 'vector_signer_sign', { txCbor: cbor(unsignedText) });
  const signed = /[0-9a-f]{200,}/i.exec(s.text)?.[0];
  const sub = await call(builder, 'vector_submit_transaction', { signedTxCbor: signed });
  const hash = /[0-9a-f]{64}/.exec(sub.text)?.[0];
  await call(builder, 'vector_await_transaction', { txHash: hash, timeoutSeconds: 180 });
  return hash;
};
const addr = (await call(signer, 'vector_signer_get_address', {})).text.match(/addr1[0-9a-z]+/)[0];
await call(builder, 'vector_marketplace_list_suppliers', { capability_id: 'identity.history.report.v1' });
const post = await call(builder, 'vector_build_marketplace_post_escrow', { changeAddress: addr, advert_ref: ADVERT_REF, payload: PAYLOAD });
const postTx = await signSubmitAwait(post.text); const escrowRef = post.json.escrow_ref; console.log('posted', postTx, escrowRef);
const sent = await call(builder, 'vector_marketplace_send_job', { escrow_ref: escrowRef, payload: PAYLOAD });
let job; for (let i = 0; i < 60; i++) { job = await call(builder, 'vector_marketplace_get_job', { escrow_ref: escrowRef, job_id: sent.json.jobId ?? sent.json.job_id }); if (job.json.state !== 'pending') break; await new Promise((r) => setTimeout(r, 5000)); }
if (job.json.state !== 'done') throw new Error(`job ended ${job.json.state}`);
const ver = await call(builder, 'vector_marketplace_verify_receipt', { escrow_ref: escrowRef, receipt: job.json.receipt, receipt_signature: job.json.receipt_signature, output: job.json.result });
if (!ver.json.verified) throw new Error('receipt not verified');
const acc = await call(builder, 'vector_build_marketplace_accept', { changeAddress: addr, escrow_ref: escrowRef });
const accTx = await signSubmitAwait(acc.text);
console.log(JSON.stringify({ escrow_ref: escrowRef, post_tx: postTx, accept_tx: accTx, receipt: job.json.receipt, receipt_signature: job.json.receipt_signature }, null, 2));
```
Check the exact argument names of `vector_submit_transaction` and `vector_await_transaction` in `packages/builder/test/smoke/tool-schemas.snapshot.json` (`signedTxCbor`, `txHash`, `timeoutSeconds`) before the first run and adjust the script if they differ.

- [ ] **Step 3: Write `docs/E2E.md`**: prerequisites (Plan A builder running or deployed; signer built; buyer key funded with 5 + 50; Agent History advert posted), the exact commands, what "pass" looks like, and a results table to fill (date, escrow ref, post tx, accept tx, verdict). Mark every run "first-party".

- [ ] **Step 4: Commit**

```bash
pnpm add -Dw @modelcontextprotocol/sdk && git add -A && git commit -m "docs: member guide, E2E runbook and hire script" && git push
```

### Task 7: Dockerfile, compose, env example, Caddy snippet, deployment handoff

**Files:**
- Create: `agents/agent-history/Dockerfile`, `deploy/apex-web/docker-compose.agent-history.yml`, `deploy/apex-web/.env.agent-history.example`, `deploy/apex-web/Caddyfile.snippet`, `deploy/apex-web/README.md`, `deploy/apex-web/RUNBOOK.md`

- [ ] **Step 1: Dockerfile for the service**

```dockerfile
# agents/agent-history/Dockerfile - build context is the repo root.
FROM node:22-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/vector-read/package.json ./packages/vector-read/package.json
COPY agents/agent-history/package.json ./agents/agent-history/package.json
RUN pnpm install --frozen-lockfile --filter '@vsa/agent-history...'
COPY packages/vector-read ./packages/vector-read
COPY agents/agent-history ./agents/agent-history
FROM node:22-alpine
WORKDIR /repo
RUN apk add --no-cache tini
COPY --from=builder /repo /repo
RUN chown -R node:node /repo
USER node
ENV NODE_ENV=production PORT=9091 HOST=0.0.0.0
EXPOSE 9091
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:9091/healthz >/dev/null || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node_modules/.bin/tsx", "agents/agent-history/src/index.ts"]
```
Build check: `docker build -f agents/agent-history/Dockerfile -t vsa/agent-history:dev .` (needs the Docker engine running; if it is not, mark the step "built in CI" and add a `docker build` job to `ci.yml` that builds the image without pushing).

- [ ] **Step 2: Compose, env example, Caddy snippet**

`deploy/apex-web/docker-compose.agent-history.yml`:
```yaml
# Agent History on apex-web: template runtime (pinned) + this repo's service. Pattern: chandra-supplier.
name: agent-history
services:
  agent:
    build:
      context: https://github.com/Apex-Fusion/vector-agent-template.git#c4c378a
      dockerfile: agent/Dockerfile
    container_name: agent-history-agent
    restart: unless-stopped
    env_file: [ { path: ./.env.agent-history, required: true } ]
    environment:
      CAPABILITY_KIND: custom
      SERVICE_URL: http://service:9091
      SERVICE_CONTENT_TYPE: application/json
      SERVICE_TIMEOUT_MS: "180000"
      ADVERT_MAX_PROCESSING_MS: "300000"
      PORT: "8080"
    ports: ["127.0.0.1:8083:8080"]
    depends_on: [service]
    networks: [umami_default]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
  service:
    image: ghcr.io/apex-fusion/vector-service-agents/agent-history:latest
    container_name: agent-history-service
    restart: unless-stopped
    env_file: [ { path: ./.env.agent-history, required: true } ]
    environment: { PORT: "9091", HOST: "0.0.0.0" }
    networks: [umami_default]
    logging: { driver: json-file, options: { max-size: "10m", max-file: "3" } }
networks:
  umami_default: { external: true, name: umami_default }
```
`deploy/apex-web/.env.agent-history.example` (names only; generated on the box by the runbook):
```
# Identity (from gen-keypair on the box)
SUPPLIER_PRIV_KEY_HEX=
SUPPLIER_PUB_KEY_HEX=
SUPPLIER_PKH=
SUPPLIER_ADDRESS=
# Chain
NETWORK_ID=1
OGMIOS_URL=https://ogmios.vector.mainnet.apexfusion.org
VECTOR_ZERO_TIME_MS=1756485600000
LIVE_CHAIN=1
ESCROW_REF_UTXO=c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#0
ADVERT_REF_UTXO=c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1
# Advert (filled by post-advert)
ADVERT_REF=
ADVERT_CAPABILITY_ID=identity.history.report.v1
ADVERT_MODEL=agent-history-v1
ADVERT_PRICE_LOVELACE=1000000
ADVERT_SUPPLIER_BOND_LOVELACE=1000000
ADVERT_BUYER_BOND_LOVELACE=1000000
ADVERT_MAX_PROCESSING_MS=300000
ADVERT_ENDPOINT_URL=https://mp-suppliers-history.hal8.ai
ADVERT_DETAIL_URI=https://mp-suppliers-history.hal8.ai/agent.json
ADVERT_DETAIL_HASH=
# Manifest (service)
AGENT_DID=
AGENT_STATUS_CHIP=live
AGENT_STATUS_SINCE=
ADVERT_EXPLORER_URL=
```
`deploy/apex-web/Caddyfile.snippet`:
```
mp-suppliers-history.hal8.ai {
    reverse_proxy agent-history-agent:8080
}
```
Note in `README.md`: the service's `/agent.json` must also be reachable at the advert's `detail_uri`; the template runtime does not proxy it, so add a second Caddy route: `handle /agent.json { reverse_proxy agent-history-service:9091 }` inside the same site block, before the default `reverse_proxy`.

- [ ] **Step 3: `deploy/apex-web/RUNBOOK.md`** (operator = Filip, DNS and Caddy = David): the ordered commands adapted from `chandra-supplier/ops/README.md`: generate the keypair on the box (`corepack pnpm --filter @marketplace/supplier exec tsx src/cli/gen-keypair.ts --network 1` inside the template checkout, or the compose `agent` image), fund 5 then 25 to 50 (two transfers), `docker compose -f docker-compose.agent-history.yml up -d service`, confirm `curl -s http://127.0.0.1:8083/healthz` after DNS, compute `ADVERT_DETAIL_HASH` with `node scripts/manifest-hash.mjs https://mp-suppliers-history.hal8.ai`, post the advert with the template's `tx:post-advert` (flags: `--capability-id identity.history.report.v1 --model agent-history-v1 --price-lovelace 1000000 --max-processing-ms 300000 --endpoint-url https://mp-suppliers-history.hal8.ai --detail-uri https://mp-suppliers-history.hal8.ai/agent.json --detail-hash <hash>`), write `ADVERT_REF` into the env file, restart `agent`, register the DID with `chandra-supplier/ops/register-did.sh` adapted to this agent's name, capabilities `["identity.history.report.v1"]`, framework `vector-service-agents`, endpoint `https://mp-suppliers-history.hal8.ai`, then `m3-self-stake.py` with the mainnet genesis patch, then write `AGENT_DID` into the env and restart `service`. End with the two gotchas copied verbatim from the chandra ops README (byte-preserving signer; testnet-pinned Module-3 SDK).

- [ ] **Step 4: `deploy/apex-web/README.md` for David**: what to pull (image tag), the two DNS names needed now (`mp-suppliers-history.hal8.ai`) and later (`pipeline`, `snippets`, `advocate`), the Caddy block, the ports used (8083 loopback), and the rollback (`docker compose down`, retire the advert with `tx:retire-advert`).

- [ ] **Step 5: CI image publish job**

Append to `.github/workflows/ci.yml` a `publish` job on pushes to `main` that logs in to GHCR with `GITHUB_TOKEN` and builds and pushes `ghcr.io/apex-fusion/vector-service-agents/agent-history:latest` and `:${{ github.sha }}` from `agents/agent-history/Dockerfile` (uses `docker/login-action@v3`, `docker/build-push-action@v6`).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "deploy: agent-history image, apex-web compose, env example, Caddy, runbook" && git push
```

### Task 8: Comms drafts and log entry (outside the public repo)

**Files:**
- Create: `C:\Users\Filip\Documents\Claude\AAIF\comms\2026-10-13-david-marketplace-mcp-note-v0.1.md`, `C:\Users\Filip\Documents\Claude\AAIF\comms\2026-10-13-discord-internal-service-agents-v0.1.md`
- Modify: `C:\Users\Filip\Documents\Claude\AAIF\LOG.md` (append entry 025)

- [ ] **Step 1: David note** (Filip's voice, short): what we're building (marketplace tools on the hosted keyless server, four PRs; the service-agents repo; apex-web hosting), the overlap with his gateway `/mcp` for Paper2Agent and why both can exist (custodial convenience vs identity-grade keyless), what we need from him (review the PRs, dispatch the mainnet deploy, one DNS name and Caddy block now, the npm scope question), and the two questions (producer count and admission rules for the WG answer; the `/v1/responses` route).

- [ ] **Step 2: Internal Discord post** (after the first first-party hire): the receipt, the escrow ref, the two explorer links, one line on what Agent History returns, the `HIRE.md` link, "first-party, labelled as such", and the ask to Chris for sign-off on the public wording.

- [ ] **Step 3: LOG entry 025**: the plan files, what was built today, what is pending on Filip (funds, Brave key later, npm scope) and David (review, deploy, DNS).

---

## Self-review notes

- Spec coverage: §3 repo layout → Task 1; §4 and §7.1 runtime contract → Tasks 4 and 7; §7.2 Agent History → Tasks 3 and 4; §8 specs and manifests → Task 5; §9 guide → Task 6; §10 tests → every task; §11 steps 2, 4 and 5 → Tasks 6, 7, 8.
- **Deviation from spec §7.2, flagged for Filip:** escrow outcomes read "from the redeemer" need the spending transaction of each escrow, and this Koios instance's `tx_info` returns `plutus_contracts: []` and has no spent-by lookup, so v1 reports the indexer's state plus Koios spent flags for the latest 50 escrows per side, and says so in `outcome_verification` and `blind_spots`. A redeemer-based classifier needs a local cache fed from the escrow address history; it is a follow-up task, not silently dropped.
- Deviation from spec §7.2 "key_roles.receipt_signer_match": receipts are not persisted anywhere public, so the check is `capability_key_matches_controller` (the supplier's served public key hashes to the controller key). Same intent, verifiable today.
- Review Focus 1 to 5 are pinned in Task 4 (`server.test.ts` unknown subject, `report.test.ts` failing section, `server.test.ts` 400), Task 3 (`subject.test.ts` candidates, `identity.test.ts` deregistration), Task 4 (`request.test.ts` size and subject).
- Plan C (Pipeline, Snippets, Advocate) starts from this repo and `packages/vector-read`; the Pipeline's signing buyer package (`packages/buyer-core`) is created there, vendoring Plan A's builders.
