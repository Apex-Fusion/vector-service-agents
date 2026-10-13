# Plan A: Marketplace tools for the hosted keyless MCP server

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add nine marketplace tools to `Apex-Fusion/mcp-server` so a member with a funded key and the local signer can list suppliers, post an escrow, send the job, verify the receipt and accept, all from a chat client, in four reviewable PRs.

**Architecture:** New modules under `packages/builder/src/vector/` follow the existing pattern (`zod/v4` positional `server.tool`, `checkRateLimit()` first, markdown out, unsigned CBOR built on `lucidForAddress`). The marketplace datum codecs are re-implemented on Lucid's `Data`/`Constr` (no cbor-x), pinned by golden tests against two live mainnet datums. PR 1 reads only (indexer + Koios); PR 2 builds unsigned Post/Accept/Reclaim; PR 3 adds the only outbound calls to supplier URLs behind `safeFetch`; PR 4 makes the signer `npx`-installable with a `keygen` subcommand.

**Tech Stack:** TypeScript ESM, npm workspaces, Node >= 22, `@lucid-evolution/lucid` 0.4.x (CML for Ed25519 verify), `@modelcontextprotocol/sdk`, `zod/v4`, `node:test` + `tsx`, tsup.

**Spec:** `<workspace>\vector-service-agents\docs\superpowers\specs\2026-10-13-vector-service-agents-design.md` (sections 4, 5, 6, 10, 11)

## Global Constraints

- Node `>=22`; the repo uses **npm workspaces, not pnpm**. Run commands from the repo root. Set `NODE_OPTIONS=--max-old-space-size=12288` for build and smoke.
- Imports in tool files use `import { z } from "zod/v4"` (plain `zod` breaks typecheck). Tools are registered with the positional form `server.tool(name, description, zodRawShape, handler)`.
- Every handler calls `checkRateLimit()` first and returns a single `{ type: "text" }` block. Errors come back as text, never thrown.
- The builder never holds key material. `test/boundary.test.ts` fails any source line matching `/(mnemonic|seed|bip39|fromSeed|walletFromSeed|selectWallet\.fromSeed)/i`: do not use those words in source, comments included.
- Mainnet constants (spec section 6) are inlined; no file reads of `plutus.json`; never import `agents-marketplace` code at runtime.
- Transactions: `addSignerKey(pkh)`, `validFrom(now - 60_000)`, `setMinFee(500_000n)`, `complete({ localUPLCEval: false })` for script spends, `ensureSlotConfig(provider)` before any validity bound.
- The snapshot test pins every tool's description and input schema. After adding tools: `npm run build && node packages/builder/scripts/regen-tool-schemas.mjs`, then commit the JSON. Never hand-edit the snapshot.
- Vocabulary in tool descriptions and output: "stake, bond, escrow, settlement, receipt"; amounts are printed with `lovelaceToAda()` as the existing tools do.
- Commit after every green step. Branch names: `feat/marketplace-read-tools`, `feat/marketplace-build-tools`, `feat/marketplace-transport`, `feat/signer-npx`. PRs target `Apex-Fusion/mcp-server` `main`; reviewer the HAL8 lead builder (`<reviewer handle>`). PR descriptions end with the attribution line given in the session.

## Review Focus

1. **A supplier endpoint that never answers 202.** `vector_marketplace_send_job` must return a clear "supplier did not claim within 90 s; the escrow is still Open, reclaim after deliver_by" message, not a hang. Pinned in Task 8's timeout test.
2. **A caller who passes an escrow ref that is not theirs.** `vector_build_marketplace_accept` must refuse when `buyer_pkh` differs from the change address's key hash, before building anything. Pinned in Task 5's plan test.
3. **An advert whose `endpoint_url` points at `http://169.254.169.254/` or a private host.** `safeFetch` refuses it; the refusal names the rule. Pinned in Task 7.
4. **A receipt served for a different escrow or signed by a different key.** `vector_marketplace_verify_receipt` reports `wrong_escrow_ref` or `pub_key_not_supplier`, never "verified". Pinned in Task 9.
5. **A wallet with no 5-unit pure collateral output.** Post must not consume the only collateral candidate; Accept must fail fast with "collateral required" rather than an opaque ledger error. Pinned in Task 4 (reserve) and Task 5 (assert).

---

## File structure

| File | Responsibility |
|---|---|
| `packages/builder/src/vector/marketplace-constants.ts` | script hashes, addresses, reference UTxOs, indexer URL, windows, min fee |
| `packages/builder/src/vector/marketplace-datum.ts` | `AdvertDatum`, `EscrowDatum` types; encode/decode on Lucid `Data`; `canonicalize`; hashes; `escrowLockFloor` |
| `packages/builder/src/vector/marketplace-indexer.ts` | typed fetchers for the public indexer and Koios `utxo_info` |
| `packages/builder/src/vector/marketplace-build.ts` | `planPostEscrow`/`buildPostEscrow`, `planAccept`/`buildAccept`, `planReclaim`/`buildReclaim`, `resolveEscrowLineage`, `reserveCollateralInputs` |
| `packages/builder/src/vector/safe-fetch.ts` | https-only, private-range-blocked, size- and time-capped fetch |
| `packages/builder/src/vector/marketplace-transport.ts` | route table, `sendJob`, `getJob`, `verifyReceipt` |
| `packages/builder/src/vector/marketplace.ts` | `registerMarketplaceTools(server, identity)`: the nine tools |
| `packages/builder/src/vector/vector.ts` | one added call: `registerMarketplaceTools(server, identity)` |
| `packages/builder/test/marketplace-datum.test.ts` | golden datum tests |
| `packages/builder/test/marketplace-build.test.ts` | Post offline build; Accept/Reclaim plan functions |
| `packages/builder/test/safe-fetch.test.ts` | URL policy tests |
| `packages/builder/test/marketplace-transport.test.ts` | route table, receipt verification |
| `packages/builder/test/fixtures/marketplace.fixture.ts` | live datum hexes and expected decodes |
| `packages/builder/test/smoke/tool-inventory.test.ts` | derived count, new names |
| `packages/builder/scripts/regen-tool-schemas.mjs` | SSE to Streamable HTTP |
| `packages/signer/src/index.ts`, `packages/signer/src/keygen.ts`, `packages/signer/package.json`, `packages/signer/README.md` | `keygen` subcommand, publishable package |

---

## PR 1: read tools and test plumbing

### Task 1: Worktree, install, baseline

**Files:**
- none created; repo root `<workspace>\vector-agentic-framework\mcp-server\repo`

- [ ] **Step 1: Fetch upstream and create the worktree**

```bash
cd "<workspace>/vector-agentic-framework/mcp-server/repo"
git fetch upstream
git worktree add "../wt-marketplace-read" -b feat/marketplace-read-tools upstream/main
cd "../wt-marketplace-read"
git log --oneline -1
```
Expected: the commit `7a8cafb` (or newer upstream main).

- [ ] **Step 2: Install and build**

```bash
export NODE_OPTIONS=--max-old-space-size=12288
npm ci
npm run build
```
Expected: `build/index.js` exists under `packages/builder/build/` and `packages/signer/build/`.

- [ ] **Step 3: Run the baseline tests**

```bash
npm run test:unit
npm run test:smoke
```
Expected: all pass, smoke reports "exposes exactly 24 tools".

- [ ] **Step 4: Point the server at mainnet for later integration steps (local only, not committed)**

Create `.env` at the worktree root (it is gitignored; verify with `git check-ignore .env`):
```
VECTOR_OGMIOS_URL=https://ogmios.vector.mainnet.apexfusion.org
VECTOR_SUBMIT_URL=https://submit.vector.mainnet.apexfusion.org/api/submit/tx
VECTOR_KOIOS_URL=https://v2.koios.vector.mainnet.apexfusion.org/
VECTOR_EXPLORER_URL=https://explorer.vector.mainnet.apexfusion.org
```
Run: `git check-ignore .env` Expected: prints `.env`.

### Task 2: Constants and datum codecs with golden tests

**Files:**
- Create: `packages/builder/src/vector/marketplace-constants.ts`
- Create: `packages/builder/src/vector/marketplace-datum.ts`
- Create: `packages/builder/test/fixtures/marketplace.fixture.ts`
- Test: `packages/builder/test/marketplace-datum.test.ts`

**Interfaces:**
- Produces: `AdvertDatum`, `EscrowDatum`, `EscrowState`, `decodeAdvertDatum(hex): AdvertDatum`, `decodeEscrowDatum(hex): EscrowDatum`, `encodeEscrowDatum(d): string`, `canonicalize(x): string`, `sha256Utf8Hex(s): string`, `requestSpecHash(advert): string`, `wirePayloadFor(payload): string`, `promptHashForPayload(payload): string`, `escrowLockFloor(openDatum, economicTotal): bigint`, `parseOutRef(ref): { txHash, outputIndex }`, `formatOutRef(txHash, idx): string`, and the constants.

- [ ] **Step 1: Write the fixture file**

```ts
// packages/builder/test/fixtures/marketplace.fixture.ts
// Live mainnet datums captured 2026-10-13 via Koios utxo_info. Do not edit by hand.

/** Advert 87c46c30…#0: ChandraOCR, Active. */
export const ADVERT_REF = '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d#0';
export const ADVERT_DATUM_HEX =
  'd8798d581c401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c958216f63722e706167652e657874726163742e6368616e6472612d6f63722d322e76315819686973746f726963616c2d7265636f7264732d6f63722d76311b00000000000020001b00000000000493e01b0000000000030d401b00000000000f42401b00000000000f4240582468747470733a2f2f6d702d737570706c696572732d6368616e6472612e68616c382e6169405820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8551b0000019ff571fc53d87980';
export const ADVERT_EXPECTED = {
  supplier_pkh: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9',
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
  model: 'historical-records-ocr-v1',
  max_output_tokens: 8192,
  max_processing_ms: 300_000,
  price_lovelace: 200_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: 'https://mp-suppliers-chandra.hal8.ai',
  detail_uri: '',
  detail_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  advertised_at: 1786529315923,
  status: 'Active' as const,
};

/** Escrow 1f1566b4…#0 as posted (Open) on 2026-08-12. */
export const ESCROW_REF = '1f1566b4fb32fe5af98a686d97383db7cd02bd47eae7f2742187d67e335c8538#0';
export const ESCROW_OPEN_DATUM_HEX =
  'd8798e581c60e82034791d90a7e80130423f5c08061211339b86128a4fda158dc9581c401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9d87982582087c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d1b000000000000000058216f63722e706167652e657874726163742e6368616e6472612d6f63722d322e76315820f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e858202320c4c4e9d4aec286dfee66452fe3f649b34345a808ad8d7bfe31e09686e9c61b0000000000030d401b00000000000f42401b00000000000f42401b0000019ff58112c71b0000019ff57c09b7d87a80d87a80d87980';
export const ESCROW_EXPECTED = {
  buyer_pkh: '60e82034791d90a7e80130423f5c08061211339b86128a4fda158dc9',
  supplier_pkh: '401af418a7e6fb106277292881fcdeaa1cc15b5b112e9c8bdb2d46c9',
  advert_ref: { txHash: '87c46c30026b438ef0aaedcf3c656743b32dd68ce69e36d11f1e2d2b91659e5d', index: 0 },
  capability_id: 'ocr.page.extract.chandra-ocr-2.v1',
  request_spec_hash: 'f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e8',
  prompt_hash: '2320c4c4e9d4aec286dfee66452fe3f649b34345a808ad8d7bfe31e09686e9c6',
  payment_lovelace: 200_000n,
  buyer_bond_lovelace: 1_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  deliver_by: 1786530304711,
  posted_at: 1786529974711,
  submitted_at: null,
  result_receipt_hash: null,
  state: 'Open' as const,
};
/** Lovelace actually locked by that Post (Koios value of the output). */
export const ESCROW_LOCKED_LOVELACE = 2_261_030n;
```

- [ ] **Step 2: Write the failing golden tests**

```ts
// packages/builder/test/marketplace-datum.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Data } from '@lucid-evolution/lucid';
import {
  decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, canonicalize,
  requestSpecHash, wirePayloadFor, promptHashForPayload, escrowLockFloor, parseOutRef, formatOutRef,
} from '../src/vector/marketplace-datum.ts';
import {
  ADVERT_DATUM_HEX, ADVERT_EXPECTED, ESCROW_OPEN_DATUM_HEX, ESCROW_EXPECTED, ESCROW_LOCKED_LOVELACE, ESCROW_REF,
} from './fixtures/marketplace.fixture.ts';

describe('advert datum', () => {
  test('decodes the live ChandraOCR advert field by field', () => {
    assert.deepEqual(decodeAdvertDatum(ADVERT_DATUM_HEX), ADVERT_EXPECTED);
  });
  test('request_spec_hash of that advert matches the live escrow datum', () => {
    assert.equal(requestSpecHash(decodeAdvertDatum(ADVERT_DATUM_HEX)), ESCROW_EXPECTED.request_spec_hash);
  });
});

describe('escrow datum', () => {
  test('decodes the live Open escrow field by field', () => {
    assert.deepEqual(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX), ESCROW_EXPECTED);
  });
  test('re-encoding is semantically identical to the on-chain bytes', () => {
    const ours = encodeEscrowDatum(decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX));
    assert.deepEqual(Data.from(ours), Data.from(ESCROW_OPEN_DATUM_HEX));
  });
  test('round-trips Submitted state with both options present', () => {
    const d = { ...ESCROW_EXPECTED, submitted_at: 1786530100000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
    assert.deepEqual(decodeEscrowDatum(encodeEscrowDatum(d)), d);
  });
  test('lock floor never goes below the economic total and covers the live lock', () => {
    const open = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
    const economic = open.payment_lovelace + open.buyer_bond_lovelace + open.supplier_bond_lovelace;
    const floor = escrowLockFloor(open, economic);
    assert.ok(floor >= economic);
    assert.ok(floor >= ESCROW_LOCKED_LOVELACE - 100_000n, `floor ${floor} is far below the live lock ${ESCROW_LOCKED_LOVELACE}`);
    assert.ok(floor <= ESCROW_LOCKED_LOVELACE + 200_000n, `floor ${floor} over-locks against the live lock ${ESCROW_LOCKED_LOVELACE}`);
  });
});

describe('hashing', () => {
  test('canonicalize sorts keys and drops undefined', () => {
    assert.equal(canonicalize({ b: 1, a: [{ d: 2, c: undefined }] }), '{"a":[{"d":2}],"b":1}');
  });
  test('wire payload is the one-element message array and prompt hash is sha256 of it', () => {
    assert.equal(wirePayloadFor('hello'), '[{"content":"hello","role":"user"}]');
    const expected = createHash('sha256').update('[{"content":"hello","role":"user"}]', 'utf8').digest('hex');
    assert.equal(promptHashForPayload('hello'), expected);
  });
  test('out refs parse and format', () => {
    assert.deepEqual(parseOutRef(ESCROW_REF), { txHash: ESCROW_REF.slice(0, 64), outputIndex: 0 });
    assert.equal(formatOutRef(ESCROW_REF.slice(0, 64), 0), ESCROW_REF);
    assert.throws(() => parseOutRef('nope#1'), /out ref/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-datum.test.ts`
Expected: FAIL, cannot find module `../src/vector/marketplace-datum.ts`.

- [ ] **Step 4: Write the constants module**

```ts
// packages/builder/src/vector/marketplace-constants.ts
// Vector mainnet marketplace constants. Source: agents-marketplace docs/DEPLOY_NEW_SUPPLIER.md
// and the live reference-script UTxOs (verified via Koios 2026-10-13). Inlined on purpose:
// the Docker image ships only build/, so nothing here may read plutus.json.
export const ESCROW_SCRIPT_HASH = '810ee059cd7819ce8f995ae438bbb06fef10017b4a17929cf971a912';
export const ESCROW_ADDRESS = 'addr1wxqsaczee4upnn50n9dwgw9mkph77yqp0d9p0y5ul9c6jysrv9dl5';
export const ADVERT_SCRIPT_HASH = '9929fa4eed8b66b30b8608e601ed2a4b7b413a2413dd13ab275594da';
export const ADVERT_ADDRESS = 'addr1wxvjn7jwak9kdvctscywvq0d9f9hksf6ysfa6yatya2efksvgxwpa';
export const ESCROW_REF_UTXO = { txHash: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54', outputIndex: 0 };
export const ADVERT_REF_UTXO = { txHash: 'c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54', outputIndex: 1 };
export const ACCEPT_WINDOW_MS = 600_000;
/** Buyer-side buffer added to the advert's processing window when computing deliver_by. */
export const DELIVER_BY_BUFFER_MS = 180_000;
export const MARKETPLACE_MIN_FEE = 500_000n;
export const COLLATERAL_MIN_LOVELACE = 5_000_000n;
export const MIN_UTXO_LOVELACE = 1_000_000n;
export const INDEXER_URL = process.env.VECTOR_MARKETPLACE_INDEXER_URL || 'https://mp-indexer.vector.apexfusion.org';
/** Redeemer constructor indices of the escrow validator (escrow.ak). */
export const REDEEMER = { Claim: 0, Submit: 1, Accept: 2, Reclaim: 3, Release: 4 } as const;
```

- [ ] **Step 5: Write the datum module**

```ts
// packages/builder/src/vector/marketplace-datum.ts
// Marketplace datum codecs on Lucid's Data/Constr. Field order is the on-chain order
// (agents-marketplace packages/shared/src/cbor/{AdvertDatum,EscrowDatum}.ts). Semantic
// equality with the marketplace's cbor-x encoder is pinned by test/marketplace-datum.test.ts;
// byte framing of lists may differ (indefinite vs definite), which the validator ignores.
import { Data, Constr, fromText, toText } from '@lucid-evolution/lucid';
import { createHash } from 'node:crypto';

export type AdvertStatus = 'Active' | 'Retired';
export type EscrowState = 'Open' | 'Claimed' | 'Submitted' | 'Accepted' | 'Reclaimed' | 'Released';
export interface OutRef { txHash: string; index: number }

export interface AdvertDatum {
  supplier_pkh: string; capability_id: string; model: string;
  max_output_tokens: number; max_processing_ms: number;
  price_lovelace: bigint; supplier_bond_lovelace: bigint; buyer_bond_lovelace: bigint;
  endpoint_url: string; detail_uri: string; detail_hash: string;
  advertised_at: number; status: AdvertStatus;
}
export interface EscrowDatum {
  buyer_pkh: string; supplier_pkh: string; advert_ref: OutRef; capability_id: string;
  request_spec_hash: string; prompt_hash: string;
  payment_lovelace: bigint; buyer_bond_lovelace: bigint; supplier_bond_lovelace: bigint;
  deliver_by: number; posted_at: number;
  submitted_at: number | null; result_receipt_hash: string | null; state: EscrowState;
}

const STATES: EscrowState[] = ['Open', 'Claimed', 'Submitted', 'Accepted', 'Reclaimed', 'Released'];
const HEX = /^[0-9a-fA-F]+$/;

export function parseOutRef(ref: string): { txHash: string; outputIndex: number } {
  const m = /^([0-9a-fA-F]{64})#(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid out ref "${ref}": expected <64-hex txid>#<index>`);
  return { txHash: m[1].toLowerCase(), outputIndex: Number(m[2]) };
}
export function formatOutRef(txHash: string, index: number): string { return `${txHash}#${index}`; }

function asConstr(x: unknown, where: string): Constr<Data> {
  if (!(x instanceof Constr)) throw new Error(`${where}: expected constructor`);
  return x;
}
function asBytes(x: unknown, where: string): string {
  if (typeof x !== 'string' || !HEX.test(x) && x !== '') throw new Error(`${where}: expected bytes`);
  return x.toLowerCase();
}
function asInt(x: unknown, where: string): bigint {
  if (typeof x !== 'bigint') throw new Error(`${where}: expected integer`);
  return x;
}
function optionInt(x: unknown, where: string): number | null {
  const c = asConstr(x, where);
  if (c.index === 1) return null;
  if (c.index === 0 && c.fields.length === 1) return Number(asInt(c.fields[0], where));
  throw new Error(`${where}: malformed option`);
}
function optionBytes(x: unknown, where: string): string | null {
  const c = asConstr(x, where);
  if (c.index === 1) return null;
  if (c.index === 0 && c.fields.length === 1) return asBytes(c.fields[0], where);
  throw new Error(`${where}: malformed option`);
}
const some = (v: Data) => new Constr(0, [v]);
const none = () => new Constr(1, []);

export function decodeAdvertDatum(hex: string): AdvertDatum {
  const c = asConstr(Data.from(hex), 'advert');
  if (c.index !== 0 || c.fields.length !== 13) throw new Error(`advert: expected Constr 0 with 13 fields, got ${c.index}/${c.fields.length}`);
  const f = c.fields;
  const status = asConstr(f[12], 'advert.status').index;
  if (status !== 0 && status !== 1) throw new Error(`advert.status: unknown tag ${status}`);
  return {
    supplier_pkh: asBytes(f[0], 'advert.supplier_pkh'),
    capability_id: toText(asBytes(f[1], 'advert.capability_id')),
    model: toText(asBytes(f[2], 'advert.model')),
    max_output_tokens: Number(asInt(f[3], 'advert.max_output_tokens')),
    max_processing_ms: Number(asInt(f[4], 'advert.max_processing_ms')),
    price_lovelace: asInt(f[5], 'advert.price'),
    supplier_bond_lovelace: asInt(f[6], 'advert.supplier_bond'),
    buyer_bond_lovelace: asInt(f[7], 'advert.buyer_bond'),
    endpoint_url: toText(asBytes(f[8], 'advert.endpoint_url')),
    detail_uri: toText(asBytes(f[9], 'advert.detail_uri')),
    detail_hash: asBytes(f[10], 'advert.detail_hash'),
    advertised_at: Number(asInt(f[11], 'advert.advertised_at')),
    status: status === 0 ? 'Active' : 'Retired',
  };
}

export function decodeEscrowDatum(hex: string): EscrowDatum {
  const c = asConstr(Data.from(hex), 'escrow');
  if (c.index !== 0 || c.fields.length !== 14) throw new Error(`escrow: expected Constr 0 with 14 fields, got ${c.index}/${c.fields.length}`);
  const f = c.fields;
  const ref = asConstr(f[2], 'escrow.advert_ref');
  if (ref.index !== 0 || ref.fields.length !== 2) throw new Error('escrow.advert_ref: malformed');
  const stateIdx = asConstr(f[13], 'escrow.state').index;
  const state = STATES[stateIdx];
  if (!state) throw new Error(`escrow.state: unknown tag ${stateIdx}`);
  return {
    buyer_pkh: asBytes(f[0], 'escrow.buyer_pkh'),
    supplier_pkh: asBytes(f[1], 'escrow.supplier_pkh'),
    advert_ref: { txHash: asBytes(ref.fields[0], 'escrow.advert_ref.txHash'), index: Number(asInt(ref.fields[1], 'escrow.advert_ref.index')) },
    capability_id: toText(asBytes(f[3], 'escrow.capability_id')),
    request_spec_hash: asBytes(f[4], 'escrow.request_spec_hash'),
    prompt_hash: asBytes(f[5], 'escrow.prompt_hash'),
    payment_lovelace: asInt(f[6], 'escrow.payment'),
    buyer_bond_lovelace: asInt(f[7], 'escrow.buyer_bond'),
    supplier_bond_lovelace: asInt(f[8], 'escrow.supplier_bond'),
    deliver_by: Number(asInt(f[9], 'escrow.deliver_by')),
    posted_at: Number(asInt(f[10], 'escrow.posted_at')),
    submitted_at: optionInt(f[11], 'escrow.submitted_at'),
    result_receipt_hash: optionBytes(f[12], 'escrow.result_receipt_hash'),
    state,
  };
}

export function encodeEscrowDatum(d: EscrowDatum): string {
  return Data.to(new Constr(0, [
    d.buyer_pkh, d.supplier_pkh,
    new Constr(0, [d.advert_ref.txHash, BigInt(d.advert_ref.index)]),
    fromText(d.capability_id),
    d.request_spec_hash, d.prompt_hash,
    d.payment_lovelace, d.buyer_bond_lovelace, d.supplier_bond_lovelace,
    BigInt(d.deliver_by), BigInt(d.posted_at),
    d.submitted_at === null ? none() : some(BigInt(d.submitted_at)),
    d.result_receipt_hash === null ? none() : some(d.result_receipt_hash),
    new Constr(STATES.indexOf(d.state), []),
  ]));
}

/** RFC 8785 subset used by the marketplace: sorted keys, NFC strings, no whitespace. */
export function canonicalize(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'string' ? v.normalize('NFC') : v;
    if (Array.isArray(v)) return v.map(sort);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      out[k.normalize('NFC')] = sort(x);
    }
    return out;
  };
  return JSON.stringify(sort(value));
}
export function sha256Utf8Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
export function requestSpecHash(a: Pick<AdvertDatum, 'capability_id' | 'max_output_tokens' | 'model'>): string {
  return sha256Utf8Hex(canonicalize({ capability_id: a.capability_id, max_output_tokens: a.max_output_tokens, model: a.model }));
}
/** The exact bytes a template supplier receives and hashes: the one-element message array. */
export function wirePayloadFor(payload: string): string { return canonicalize([{ content: payload, role: 'user' }]); }
export function promptHashForPayload(payload: string): string { return sha256Utf8Hex(wirePayloadFor(payload)); }

// Min-ada floor for the escrow's largest future datum (Submitted). Port of minAdaFloor.ts.
const UTXO_COST_PER_BYTE = 4310n;
const OUTPUT_OVERHEAD_BYTES = 160n;
const SAFETY_MARGIN_LOVELACE = 50_000n;
function estimateOutputBytes(datumBytes: number, lovelace: bigint): bigint {
  const addr = 1n + 29n;
  const coin = 1n + (lovelace > 0xffffffffn ? 8n : 4n);
  const datumField = 1n + 2n + 3n + BigInt(datumBytes);
  return addr + coin + datumField + 3n;
}
export function escrowLockFloor(openDatum: EscrowDatum, economicTotal: bigint): bigint {
  const submitted: EscrowDatum = { ...openDatum, submitted_at: openDatum.deliver_by, result_receipt_hash: 'ff'.repeat(32), state: 'Submitted' };
  const datumBytes = encodeEscrowDatum(submitted).length / 2;
  const floor = (OUTPUT_OVERHEAD_BYTES + estimateOutputBytes(datumBytes, economicTotal)) * UTXO_COST_PER_BYTE + SAFETY_MARGIN_LOVELACE;
  return floor > economicTotal ? floor : economicTotal;
}
```

- [ ] **Step 6: Run the golden tests**

Run: `node --import tsx --test packages/builder/test/marketplace-datum.test.ts`
Expected: PASS, 9 tests. If `advert.detail_uri` decoding fails on the empty string, confirm `asBytes` accepts `''` (it does by the `x !== ''` clause).

- [ ] **Step 7: Typecheck and boundary**

Run: `npm run typecheck && node --import tsx --test packages/builder/test/boundary.test.ts`
Expected: both pass.

- [ ] **Step 8: Commit**

```bash
git add packages/builder/src/vector/marketplace-constants.ts packages/builder/src/vector/marketplace-datum.ts packages/builder/test/fixtures/marketplace.fixture.ts packages/builder/test/marketplace-datum.test.ts
git commit -m "feat(marketplace): datum codecs and constants pinned to live mainnet datums"
```

### Task 3: Indexer client, three read tools, snapshot plumbing, PR 1

**Files:**
- Create: `packages/builder/src/vector/marketplace-indexer.ts`
- Create: `packages/builder/src/vector/marketplace.ts`
- Modify: `packages/builder/src/vector/vector.ts` (after the `registerSelfImprovementTools(server, identity);` line)
- Modify: `packages/builder/scripts/regen-tool-schemas.mjs`
- Modify: `packages/builder/test/smoke/tool-inventory.test.ts`
- Modify: `README.md`, `server.json`, `packages/builder/src/index.ts` (comment only)
- Test: `packages/builder/test/marketplace-indexer.test.ts`

**Interfaces:**
- Produces: `fetchCapabilities(): Promise<CapabilityRow[]>`, `fetchSuppliers(): Promise<SupplierRow[]>`, `fetchSupplier(pkh): Promise<SupplierRow | null>`, `koiosUtxoInfo(koiosUrl, refs): Promise<KoiosUtxo[]>`, `withJson(markdown, obj): string`, `registerMarketplaceTools(server, identity)`.

- [ ] **Step 1: Write the failing indexer tests (offline, fetch injected)**

```ts
// packages/builder/test/marketplace-indexer.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSuppliers, fetchCapabilities, koiosUtxoInfo, withJson } from '../src/vector/marketplace-indexer.ts';

const fakeFetch = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

describe('indexer client', () => {
  test('fetchCapabilities returns rows', async () => {
    const rows = await fetchCapabilities({ fetchImpl: fakeFetch([{ capability_id: 'x.y.v1', supplier_count: 2 }]) });
    assert.deepEqual(rows, [{ capability_id: 'x.y.v1', supplier_count: 2 }]);
  });
  test('fetchSuppliers normalises bigint fields and filters', async () => {
    const row = { utxo_ref: 'a'.repeat(64) + '#0', supplier_pkh: 'b'.repeat(56), capability_id: 'x.y.v1', model: 'm', max_output_tokens: 1, max_processing_ms: 300000, price_lovelace: '200000', supplier_bond_lovelace: '1000000', buyer_bond_lovelace: '1000000', endpoint_url: 'https://s.example', detail_uri: '', detail_hash: '', advertised_at: 1, status: 'free', advert_status: 'Active', current_escrow_ref: null, last_seen_iso: '2026-10-13T09:00:00.000Z', created_slot: 1 };
    const rows = await fetchSuppliers({ fetchImpl: fakeFetch([row, { ...row, status: 'offline' }]), capability_id: 'x.y.v1', onlyFree: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price_lovelace, 200_000n);
  });
  test('non-200 becomes a readable error', async () => {
    await assert.rejects(() => fetchCapabilities({ fetchImpl: fakeFetch({}, 503) }), /indexer .*503/);
  });
  test('koiosUtxoInfo posts refs and returns datum bytes', async () => {
    const seen: any[] = [];
    const f = (async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify([{ tx_hash: 'a'.repeat(64), tx_index: 0, value: '1', is_spent: false, inline_datum: { bytes: 'd87980' } }]), { status: 200 }); }) as unknown as typeof fetch;
    const out = await koiosUtxoInfo('https://koios.example/', ['a'.repeat(64) + '#0'], f);
    assert.deepEqual(seen[0], { _utxo_refs: ['a'.repeat(64) + '#0'], _extended: true });
    assert.equal(out[0].inline_datum?.bytes, 'd87980');
  });
  test('withJson appends a fenced json block', () => {
    const s = withJson('# T', { a: 1n });
    assert.ok(s.endsWith('```json\n{"a":"1"}\n```'));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-indexer.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the indexer client**

```ts
// packages/builder/src/vector/marketplace-indexer.ts
// Read-only clients for the public marketplace indexer and Koios utxo_info.
// No supplier URLs are contacted here (that is PR 3's safeFetch).
import { INDEXER_URL } from './marketplace-constants.js';

export interface CapabilityRow { capability_id: string; supplier_count: number }
export interface SupplierRow {
  utxo_ref: string; supplier_pkh: string; capability_id: string; model: string;
  max_output_tokens: number; max_processing_ms: number;
  price_lovelace: bigint; supplier_bond_lovelace: bigint; buyer_bond_lovelace: bigint;
  endpoint_url: string; detail_uri: string; detail_hash: string; advertised_at: number;
  status: string; advert_status: string; current_escrow_ref: string | null; last_seen_iso: string | null; created_slot: number;
}
export interface KoiosUtxo {
  tx_hash: string; tx_index: number; address?: string; value: string; is_spent?: boolean;
  inline_datum?: { bytes: string; value?: unknown } | null; datum_hash?: string | null;
  reference_script?: { hash: string; bytes: string; type: string } | null; block_height?: number; block_time?: number;
}
interface Opts { fetchImpl?: typeof fetch; timeoutMs?: number }

async function getJson<T>(url: string, opts: Opts, what: string): Promise<T> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(url, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (!res.ok) throw new Error(`${what}: indexer answered ${res.status} for ${url}`);
  return (await res.json()) as T;
}

export async function fetchCapabilities(opts: Opts = {}): Promise<CapabilityRow[]> {
  return getJson<CapabilityRow[]>(`${INDEXER_URL}/capabilities`, opts, 'list capabilities');
}

function normaliseSupplier(r: Record<string, unknown>): SupplierRow {
  return {
    ...(r as unknown as SupplierRow),
    price_lovelace: BigInt(String(r.price_lovelace ?? 0)),
    supplier_bond_lovelace: BigInt(String(r.supplier_bond_lovelace ?? 0)),
    buyer_bond_lovelace: BigInt(String(r.buyer_bond_lovelace ?? 0)),
  };
}

export async function fetchSuppliers(opts: Opts & { capability_id?: string; onlyFree?: boolean } = {}): Promise<SupplierRow[]> {
  const raw = await getJson<Record<string, unknown>[]>(`${INDEXER_URL}/suppliers`, opts, 'list suppliers');
  return raw.map(normaliseSupplier)
    .filter((s) => !opts.capability_id || s.capability_id === opts.capability_id)
    .filter((s) => !opts.onlyFree || s.status === 'free')
    .sort((a, b) => (a.price_lovelace < b.price_lovelace ? -1 : a.price_lovelace > b.price_lovelace ? 1 : (b.last_seen_iso ?? '').localeCompare(a.last_seen_iso ?? '')));
}

export async function fetchSupplier(pkh: string, opts: Opts = {}): Promise<SupplierRow | null> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${INDEXER_URL}/suppliers/${pkh}`, { headers: { accept: 'application/json', 'user-agent': 'vector-mcp-builder' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get supplier: indexer answered ${res.status}`);
  return normaliseSupplier((await res.json()) as Record<string, unknown>);
}

/** Koios utxo_info: returns inline datum bytes even for spent outputs. */
export async function koiosUtxoInfo(koiosUrl: string, refs: string[], fetchImpl: typeof fetch = fetch): Promise<KoiosUtxo[]> {
  const base = koiosUrl.replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/api/v1/utxo_info`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'vector-mcp-builder' },
    body: JSON.stringify({ _utxo_refs: refs, _extended: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Koios utxo_info answered ${res.status}`);
  return (await res.json()) as KoiosUtxo[];
}

/** Markdown for the human plus a fenced JSON block the assistant can pass between tools. */
export function withJson(markdown: string, obj: unknown): string {
  const json = JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return `${markdown}\n\n\`\`\`json\n${json}\n\`\`\``;
}
```

- [ ] **Step 4: Run the indexer tests**

Run: `node --import tsx --test packages/builder/test/marketplace-indexer.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the tool module with the three read tools**

```ts
// packages/builder/src/vector/marketplace.ts
// Marketplace family. PR 1: read tools (indexer + Koios only). PR 2 adds build tools,
// PR 3 adds job transport. Same conventions as agent-network.ts.
import { z } from "zod/v4";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { lovelaceToAda } from '@apexfusion/vector-mcp-shared/tx';
import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';
import { limiterFor } from './rate-limiter.js';
import { fetchCapabilities, fetchSuppliers, fetchSupplier, koiosUtxoInfo, withJson } from './marketplace-indexer.js';
import { decodeAdvertDatum, parseOutRef } from './marketplace-datum.js';

function text(t: string) { return { content: [{ type: "text" as const, text: t }] }; }
function fail(what: string, err: unknown, tips: string[]) {
  return text(`Failed to ${what}: ${err instanceof Error ? err.message : String(err)}\n\n**Troubleshooting Tips:**\n${tips.map((t, i) => `${i + 1}. ${t}`).join('\n')}`);
}
function host(url: string): string { try { return new URL(url).host; } catch { return url; } }

export function registerMarketplaceTools(server: McpServer, identity: string) {
  const rateLimiter = limiterFor(identity);
  function checkRateLimit() {
    const r = rateLimiter.check();
    return r.allowed ? null : text(`Rate limit exceeded. Retry after ${r.retryAfterMs}ms.`);
  }

  server.tool(
    "vector_marketplace_list_capabilities",
    "List the capability ids currently advertised on the Vector agents marketplace, with supplier counts. Read-only.",
    {},
    async () => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const rows = await fetchCapabilities();
        const table = rows.map((r) => `| \`${r.capability_id}\` | ${r.supplier_count} |`).join('\n');
        return text(withJson(`# Marketplace capabilities\n\n| capability_id | suppliers |\n|---|---|\n${table}\n\nNext: vector_marketplace_list_suppliers { capability_id }.`, rows));
      } catch (err) { return fail('list capabilities', err, ['The public indexer may be unreachable; retry in a minute']); }
    },
  );

  server.tool(
    "vector_marketplace_list_suppliers",
    "List supplier adverts on the Vector agents marketplace (advert ref, model, price, bonds, processing window, status). Read-only. Pick an advert_ref here, then hire it with vector_build_marketplace_post_escrow.",
    {
      capability_id: z.string().optional().describe("Filter by capability id, e.g. 'identity.history.report.v1'"),
      only_free: z.boolean().optional().default(true).describe("Only suppliers currently reporting status 'free' (default true)"),
      limit: z.number().int().min(1).max(50).optional().default(20).describe("Maximum rows (default 20, max 50)"),
    },
    async ({ capability_id, only_free, limit }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const rows = (await fetchSuppliers({ capability_id, onlyFree: only_free ?? true })).slice(0, limit ?? 20);
        if (rows.length === 0) return text(`No suppliers found${capability_id ? ` for ${capability_id}` : ''}${only_free ? ' with status free' : ''}.`);
        const table = rows.map((s) =>
          `| \`${s.utxo_ref}\` | ${s.capability_id} | ${s.model} | ${lovelaceToAda(s.price_lovelace)} | ${lovelaceToAda(s.supplier_bond_lovelace)} / ${lovelaceToAda(s.buyer_bond_lovelace)} | ${Math.round(s.max_processing_ms / 1000)} s | ${s.status} | ${s.last_seen_iso ?? '-'} | ${host(s.endpoint_url)} |`).join('\n');
        const md = `# Marketplace suppliers\n\nA job locks price + supplier bond + buyer bond; both bonds return on Accept.\n\n| advert_ref | capability | model | price | bonds (supplier / buyer) | window | status | last seen | endpoint |\n|---|---|---|---|---|---|---|---|---|\n${table}`;
        return text(withJson(md, rows.map((s) => ({ advert_ref: s.utxo_ref, supplier_pkh: s.supplier_pkh, capability_id: s.capability_id, model: s.model, price_lovelace: s.price_lovelace, supplier_bond_lovelace: s.supplier_bond_lovelace, buyer_bond_lovelace: s.buyer_bond_lovelace, max_processing_ms: s.max_processing_ms, status: s.status, last_seen_iso: s.last_seen_iso, endpoint_url: s.endpoint_url, detail_uri: s.detail_uri }))));
      } catch (err) { return fail('list suppliers', err, ['The public indexer may be unreachable; retry in a minute', 'Try without capability_id to see everything']); }
    },
  );

  server.tool(
    "vector_marketplace_get_supplier",
    "Read one supplier advert from the Vector ledger by advert_ref (all 13 advert fields) plus the indexer's live status. Read-only.",
    { advert_ref: z.string().describe("Advert UTxO reference '<txid>#<index>' from vector_marketplace_list_suppliers") },
    async ({ advert_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const ref = parseOutRef(advert_ref);
        const [utxo] = await koiosUtxoInfo(VECTOR_KOIOS_URL, [`${ref.txHash}#${ref.outputIndex}`]);
        if (!utxo?.inline_datum?.bytes) return text(`No advert found at ${advert_ref} (no UTxO or no inline datum).`);
        const advert = decodeAdvertDatum(utxo.inline_datum.bytes);
        const live = await fetchSupplier(advert.supplier_pkh).catch(() => null);
        const md = `# Advert ${advert_ref}\n\n` +
          `- **Capability:** \`${advert.capability_id}\`\n- **Model:** ${advert.model}\n- **Supplier key hash:** \`${advert.supplier_pkh}\`\n` +
          `- **Price:** ${lovelaceToAda(advert.price_lovelace)} · **Bonds:** supplier ${lovelaceToAda(advert.supplier_bond_lovelace)}, buyer ${lovelaceToAda(advert.buyer_bond_lovelace)}\n` +
          `- **Processing window:** ${advert.max_processing_ms} ms · **Max output tokens:** ${advert.max_output_tokens}\n` +
          `- **Endpoint:** ${advert.endpoint_url}\n- **Detail URI:** ${advert.detail_uri || '(none)'} · **Detail hash:** \`${advert.detail_hash}\`\n` +
          `- **Advertised at:** ${new Date(advert.advertised_at).toISOString()} · **Status on chain:** ${advert.status}${utxo.is_spent ? ' (UTxO spent: retired or updated)' : ''}\n` +
          `- **Indexer status:** ${live ? `${live.status}, last seen ${live.last_seen_iso ?? '-'}` : 'unknown'}`;
        return text(withJson(md, { advert_ref, ...advert, is_spent: utxo.is_spent ?? null, indexer_status: live?.status ?? null, last_seen_iso: live?.last_seen_iso ?? null }));
      } catch (err) { return fail('read advert', err, ['Check the advert_ref format <64-hex>#<index>', 'Koios may be unreachable; retry']); }
    },
  );
}
```

- [ ] **Step 6: Register the family in vector.ts**

In `packages/builder/src/vector/vector.ts`, add the import next to the other register imports:
```ts
import { registerMarketplaceTools } from './marketplace.js';
```
and after `registerSelfImprovementTools(server, identity);` add:
```ts
  // Marketplace tools (adverts, escrow, receipts) live in marketplace.ts
  registerMarketplaceTools(server, identity);
```

- [ ] **Step 7: Fix the regen script transport**

In `packages/builder/scripts/regen-tool-schemas.mjs` replace
```js
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
```
with
```js
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
```
and replace
```js
  await client.connect(new SSEClientTransport(new URL(`http://localhost:${PORT}/sse`)));
```
with
```js
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));
```
Also update the header comment line "lists tools over SSE" to "lists tools over Streamable HTTP (/mcp)".

- [ ] **Step 8: Derive the count in the smoke test and add the names**

In `packages/builder/test/smoke/tool-inventory.test.ts` add to `EXPECTED_TOOLS` (keep alphabetical order):
```ts
  'vector_marketplace_get_supplier',
  'vector_marketplace_list_capabilities',
  'vector_marketplace_list_suppliers',
```
and change the count test to:
```ts
  test(`exposes exactly ${EXPECTED_TOOLS.length} tools`, () => {
    assert.equal(
      actualNames.length,
      EXPECTED_TOOLS.length,
      `expected ${EXPECTED_TOOLS.length} tools, got ${actualNames.length}: ${JSON.stringify(actualNames)}`
    );
  });
```

- [ ] **Step 9: Regenerate the snapshot and update the public counts**

```bash
npm run build && node packages/builder/scripts/regen-tool-schemas.mjs
```
Expected: `wrote 27 tool schemas`.
Then: in `README.md` change both `24` mentions ("all 24 tools", "## MCP Tools (24)") to `27` and add a "### Marketplace (3)" subsection listing the three tools with one line each; in `server.json` change the description to "27 keyless tools for AI agents on Vector, the Apex Fusion eUTXO L2: wallets, contracts, registry, marketplace."; in `packages/builder/src/index.ts` change the comment "its 24 registered tools" to "its registered tools".

- [ ] **Step 10: Run everything**

```bash
npm run typecheck && npm run test:unit && npm run test:smoke
```
Expected: all green; smoke says "exposes exactly 27 tools".

- [ ] **Step 11: Commit and open PR 1**

```bash
git add -A
git commit -m "feat(marketplace): read tools (capabilities, suppliers, advert) and snapshot plumbing"
git push -u upstream feat/marketplace-read-tools
gh pr create --repo Apex-Fusion/mcp-server --base main --head feat/marketplace-read-tools \
  --title "Marketplace read tools: list capabilities, list suppliers, get advert" \
  --reviewer <reviewer handle> \
  --body-file - <<'EOF'
## What
Three read-only marketplace tools on the hosted keyless server, backed by the public indexer and Koios. No outbound calls to supplier URLs in this PR.

- `vector_marketplace_list_capabilities`
- `vector_marketplace_list_suppliers` (capability filter, free-only default)
- `vector_marketplace_get_supplier` (decodes the advert datum from the ledger)

Also: datum codecs on Lucid `Data` pinned by golden tests against two live mainnet datums (advert 87c46c30…#0, escrow 1f1566b4…#0); regen script moved from SSE to `/mcp`; tool count derived in the smoke test.

## Why
First of four PRs that let a member hire an agent from a chat client with their own key (spec: vector-service-agents/docs/superpowers/specs/2026-10-13-vector-service-agents-design.md). Next: unsigned Post/Accept/Reclaim builders.

## Tests
`npm run test:unit`, `npm run test:smoke` green locally; snapshot regenerated, count 27.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

---

## PR 2: build tools (unsigned Post, Accept, Reclaim)

### Task 4: Post escrow plan and builder with offline test

**Files:**
- Create: `packages/builder/src/vector/marketplace-build.ts`
- Test: `packages/builder/test/marketplace-build.test.ts`

**Interfaces:**
- Consumes: Task 2 codecs; `lucidForAddress`, `toBuildResult` from `./build.js`; `ensureSlotConfig`, `paymentKeyHashOf` patterns.
- Produces: `planPostEscrow(advert, advertRef, buyerPkh, payload, nowMs, deliverByMs?): { datum, lockLovelace, deliverBy }`, `buildPostEscrow(lucid, provider, p): Promise<VectorUnsignedBuildResult & { escrowRef: string; lockLovelace: bigint; deliverBy: number; promptHash: string }>`, `reserveCollateralInputs(utxos, lockLovelace): UTxO[] | undefined`.

- [ ] **Step 1: Create the worktree for PR 2 on top of PR 1**

```bash
cd "<workspace>/vector-agentic-framework/mcp-server/wt-marketplace-read"
git worktree add "../wt-marketplace-build" -b feat/marketplace-build-tools feat/marketplace-read-tools
cd "../wt-marketplace-build" && npm ci && cp ../wt-marketplace-read/.env .env
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/builder/test/marketplace-build.test.ts
import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { CML, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, UTxO } from '@lucid-evolution/lucid';
import { FixtureProvider, FIXTURE_UTXOS, OWN_ADDRESS, FIXTURE_TXHASH } from './fixtures/fixture-provider.ts';
import { lucidForAddress } from '../src/vector/build.ts';
import { ADVERT_DATUM_HEX, ADVERT_EXPECTED, ADVERT_REF, ESCROW_EXPECTED } from './fixtures/marketplace.fixture.ts';
import { ADVERT_ADDRESS, ESCROW_ADDRESS, DELIVER_BY_BUFFER_MS, ACCEPT_WINDOW_MS } from '../src/vector/marketplace-constants.ts';
import { decodeAdvertDatum, decodeEscrowDatum, promptHashForPayload } from '../src/vector/marketplace-datum.ts';
import { planPostEscrow, buildPostEscrow, reserveCollateralInputs, planAccept, planReclaim } from '../src/vector/marketplace-build.ts';

const OWN_PKH = getAddressDetails(OWN_ADDRESS).paymentCredential!.hash;
const ADVERT_UTXO: UTxO = { txHash: ADVERT_REF.slice(0, 64), outputIndex: 0, address: ADVERT_ADDRESS, assets: { lovelace: 2_000_000n }, datum: ADVERT_DATUM_HEX };

function outputs(cborHex: string) {
  const outs = CML.Transaction.from_cbor_hex(cborHex).body().outputs();
  const r: Array<{ address: string; lovelace: bigint; datum: string | null }> = [];
  for (let i = 0; i < outs.len(); i++) {
    const o = outs.get(i);
    r.push({ address: o.address().to_bech32(), lovelace: BigInt(o.amount().coin().toString()), datum: o.datum()?.as_datum()?.to_cbor_hex() ?? null });
  }
  return r;
}

describe('planPostEscrow', () => {
  const advert = decodeAdvertDatum(ADVERT_DATUM_HEX);
  test('locks price + both bonds (floored) and commits the payload hash', () => {
    const now = 1_786_529_974_711;
    const plan = planPostEscrow(advert, ADVERT_REF, OWN_PKH, 'hello', now);
    assert.equal(plan.datum.buyer_pkh, OWN_PKH);
    assert.equal(plan.datum.supplier_pkh, ADVERT_EXPECTED.supplier_pkh);
    assert.equal(plan.datum.prompt_hash, promptHashForPayload('hello'));
    assert.equal(plan.datum.request_spec_hash, ESCROW_EXPECTED.request_spec_hash);
    assert.equal(plan.datum.deliver_by, now + advert.max_processing_ms + DELIVER_BY_BUFFER_MS);
    assert.ok(plan.lockLovelace >= 2_200_000n);
    assert.equal(plan.datum.state, 'Open');
  });
  test('refuses a retired advert and a buyer who is the supplier', () => {
    assert.throws(() => planPostEscrow({ ...advert, status: 'Retired' }, ADVERT_REF, OWN_PKH, 'x', 1), /retired/);
    assert.throws(() => planPostEscrow(advert, ADVERT_REF, advert.supplier_pkh, 'x', 1), /cannot be the supplier/);
  });
});

describe('reserveCollateralInputs', () => {
  test('keeps the smallest pure 5-unit UTxO out of the inputs', () => {
    const reserved = reserveCollateralInputs(FIXTURE_UTXOS, 2_300_000n)!;
    assert.ok(reserved.every((u) => !(u.outputIndex === 1 && u.txHash === FIXTURE_TXHASH)), 'the 5 AP3X output must stay untouched');
  });
  test('returns undefined when no collateral candidate exists', () => {
    assert.equal(reserveCollateralInputs([{ ...FIXTURE_UTXOS[0], assets: { lovelace: 3_000_000n } }], 2_300_000n), undefined);
  });
});

describe('buildPostEscrow (offline)', () => {
  let lucid: LucidEvolution;
  before(async () => { lucid = await lucidForAddress(new FixtureProvider([...FIXTURE_UTXOS, ADVERT_UTXO]), OWN_ADDRESS); });
  test('escrow output is index 0 at the escrow address with the planned datum', async () => {
    const r = await buildPostEscrow(lucid, new FixtureProvider([...FIXTURE_UTXOS, ADVERT_UTXO]), { changeAddress: OWN_ADDRESS, advertRef: ADVERT_REF, payload: 'hello', nowMs: 1_786_529_974_711 });
    const outs = outputs(r.txCbor);
    assert.equal(outs[0].address, ESCROW_ADDRESS);
    assert.equal(outs[0].lovelace, r.lockLovelace);
    const d = decodeEscrowDatum(outs[0].datum!);
    assert.equal(d.prompt_hash, promptHashForPayload('hello'));
    assert.equal(r.escrowRef, `${r.txHash}#0`);
  });
});

describe('planAccept / planReclaim', () => {
  const base = { ...ESCROW_EXPECTED, submitted_at: 1_786_530_100_000, result_receipt_hash: 'ab'.repeat(32), state: 'Submitted' as const };
  test('accept pays supplier price + supplier bond and returns the buyer bond', () => {
    const p = planAccept(base, ESCROW_EXPECTED.buyer_pkh, 1_786_530_200_000);
    assert.equal(p.supplierLovelace, 1_200_000n);
    assert.equal(p.buyerLovelace, 1_000_000n);
    assert.equal(p.validTo, base.submitted_at + ACCEPT_WINDOW_MS);
    assert.equal(p.redeemerHex, 'd87b80');
  });
  test('accept refuses the wrong buyer, the wrong state and a closed window', () => {
    assert.throws(() => planAccept(base, 'cc'.repeat(28), 1_786_530_200_000), /not the buyer/);
    assert.throws(() => planAccept({ ...base, state: 'Open' }, ESCROW_EXPECTED.buyer_pkh, 1), /Submitted/);
    assert.throws(() => planAccept(base, ESCROW_EXPECTED.buyer_pkh, base.submitted_at + ACCEPT_WINDOW_MS + 1), /window/);
  });
  test('reclaim returns everything after deliver_by for Open or Claimed only', () => {
    const open = { ...ESCROW_EXPECTED };
    const p = planReclaim(open, ESCROW_EXPECTED.buyer_pkh, open.deliver_by + 1000);
    assert.equal(p.buyerLovelace, 2_200_000n);
    assert.equal(p.redeemerHex, 'd87c80');
    assert.throws(() => planReclaim(open, ESCROW_EXPECTED.buyer_pkh, open.deliver_by - 1), /deliver_by/);
    assert.throws(() => planReclaim(base, ESCROW_EXPECTED.buyer_pkh, base.deliver_by + 1), /Open or Claimed/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-build.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Write the build module (plans + Post builder; Accept/Reclaim builders come in Task 5)**

```ts
// packages/builder/src/vector/marketplace-build.ts
// Keyless marketplace transaction building. Every function returns UNSIGNED CBOR
// through toBuildResult; signing happens on the member's local signer.
import { Data, Constr, credentialToAddress, getAddressDetails } from '@lucid-evolution/lucid';
import type { LucidEvolution, Provider, UTxO } from '@lucid-evolution/lucid';
import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';
import { toBuildResult } from './build.js';
import { ensureSlotConfig } from './gov-build.js';
import {
  ESCROW_ADDRESS, ESCROW_REF_UTXO, ACCEPT_WINDOW_MS, DELIVER_BY_BUFFER_MS, MARKETPLACE_MIN_FEE,
  COLLATERAL_MIN_LOVELACE, MIN_UTXO_LOVELACE, REDEEMER,
} from './marketplace-constants.js';
import {
  decodeAdvertDatum, decodeEscrowDatum, encodeEscrowDatum, requestSpecHash, promptHashForPayload,
  escrowLockFloor, parseOutRef, formatOutRef,
} from './marketplace-datum.js';
import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';

export function paymentKeyHashOf(address: string): string {
  const d = getAddressDetails(address);
  if (d.paymentCredential?.type !== 'Key' || !d.paymentCredential.hash) throw new Error('Address must have a verification key payment credential.');
  return d.paymentCredential.hash;
}
export function enterpriseAddressOf(pkh: string): string { return credentialToAddress('Mainnet', { type: 'Key', hash: pkh }); }
const redeemerHex = (idx: number) => Data.to(new Constr(idx, []));

// ─── Post ───────────────────────────────────────────────────────────────────
export function planPostEscrow(advert: AdvertDatum, advertRef: string, buyerPkh: string, payload: string, nowMs: number, deliverByMs?: number) {
  if (advert.status !== 'Active') throw new Error(`Advert ${advertRef} is retired; pick another supplier.`);
  if (advert.supplier_pkh === buyerPkh) throw new Error('The buyer cannot be the supplier of the same advert.');
  if (typeof payload !== 'string' || payload.length === 0) throw new Error('payload must be a non-empty string');
  const ref = parseOutRef(advertRef);
  const deliverBy = deliverByMs ?? nowMs + advert.max_processing_ms + DELIVER_BY_BUFFER_MS;
  if (deliverBy <= nowMs + advert.max_processing_ms) throw new Error(`deliver_by must leave the supplier its full window of ${advert.max_processing_ms} ms`);
  const datum: EscrowDatum = {
    buyer_pkh: buyerPkh, supplier_pkh: advert.supplier_pkh,
    advert_ref: { txHash: ref.txHash, index: ref.outputIndex }, capability_id: advert.capability_id,
    request_spec_hash: requestSpecHash(advert), prompt_hash: promptHashForPayload(payload),
    payment_lovelace: advert.price_lovelace, buyer_bond_lovelace: advert.buyer_bond_lovelace, supplier_bond_lovelace: advert.supplier_bond_lovelace,
    deliver_by: deliverBy, posted_at: nowMs, submitted_at: null, result_receipt_hash: null, state: 'Open',
  };
  const economic = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
  return { datum, lockLovelace: escrowLockFloor(datum, economic), deliverBy };
}

/** Keep the smallest pure-lovelace UTxO >= 5 units out of the inputs so Accept/Reclaim can use it as collateral. */
export function reserveCollateralInputs(utxos: UTxO[], lockLovelace: bigint): UTxO[] | undefined {
  const pure = utxos.filter((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)
    .sort((a, b) => (a.assets.lovelace < b.assets.lovelace ? -1 : 1));
  if (pure.length === 0) return undefined;
  const collateral = pure[0];
  const rest = utxos.filter((u) => !(u.txHash === collateral.txHash && u.outputIndex === collateral.outputIndex));
  const total = rest.reduce((s, u) => s + u.assets.lovelace, 0n);
  return total >= lockLovelace + MARKETPLACE_MIN_FEE + MIN_UTXO_LOVELACE ? rest : undefined;
}

export async function buildPostEscrow(lucid: LucidEvolution, provider: Provider, p: { changeAddress: string; advertRef: string; payload: string; nowMs?: number; deliverByMs?: number })
  : Promise<VectorUnsignedBuildResult & { escrowRef: string; lockLovelace: bigint; deliverBy: number; promptHash: string }> {
  const ref = parseOutRef(p.advertRef);
  const [advertUtxo] = await provider.getUtxosByOutRef([{ txHash: ref.txHash, outputIndex: ref.outputIndex }]);
  if (!advertUtxo?.datum) throw new Error(`Advert ${p.advertRef} not found on chain (or it has no inline datum).`);
  const advert = decodeAdvertDatum(advertUtxo.datum);
  const buyerPkh = paymentKeyHashOf(p.changeAddress);
  const nowMs = p.nowMs ?? Date.now();
  const plan = planPostEscrow(advert, p.advertRef, buyerPkh, p.payload, nowMs, p.deliverByMs);
  await ensureSlotConfig(provider as any);
  const wallet = await lucid.wallet().getUtxos();
  const preset = reserveCollateralInputs(wallet, plan.lockLovelace);
  const tx = lucid.newTx()
    .pay.ToAddressWithData(ESCROW_ADDRESS, { kind: 'inline', value: encodeEscrowDatum(plan.datum) }, { lovelace: plan.lockLovelace })
    .addSignerKey(buyerPkh)
    .validFrom(nowMs - 60_000)
    .validTo(plan.deliverBy)
    .setMinFee(MARKETPLACE_MIN_FEE);
  const completed = preset ? await tx.complete({ presetWalletInputs: preset, localUPLCEval: false }) : await tx.complete();
  const r = toBuildResult(completed);
  return { ...r, escrowRef: formatOutRef(r.txHash, 0), lockLovelace: plan.lockLovelace, deliverBy: plan.deliverBy, promptHash: plan.datum.prompt_hash };
}

// ─── Accept / Reclaim plans (pure) ──────────────────────────────────────────
export function planAccept(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  if (datum.state !== 'Submitted' || datum.submitted_at === null) throw new Error(`Escrow state is ${datum.state}; Accept needs Submitted.`);
  const validTo = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (nowMs > validTo) throw new Error(`Accept window closed at ${new Date(validTo).toISOString()}; the supplier may now Release.`);
  const supplierDue = datum.payment_lovelace + datum.supplier_bond_lovelace;
  return {
    supplierAddress: enterpriseAddressOf(datum.supplier_pkh),
    supplierLovelace: supplierDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : supplierDue,
    buyerLovelace: datum.buyer_bond_lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : datum.buyer_bond_lovelace,
    validFrom: nowMs - 60_000, validTo, redeemerHex: redeemerHex(REDEEMER.Accept), secondsLeft: Math.floor((validTo - nowMs) / 1000),
  };
}
export function planReclaim(datum: EscrowDatum, callerPkh: string, nowMs: number) {
  if (datum.buyer_pkh !== callerPkh) throw new Error('This escrow was posted by another key; you are not the buyer.');
  if (datum.state !== 'Open' && datum.state !== 'Claimed') throw new Error(`Escrow state is ${datum.state}; Reclaim needs Open or Claimed.`);
  if (nowMs < datum.deliver_by) throw new Error(`Reclaim opens at deliver_by ${new Date(datum.deliver_by).toISOString()}.`);
  const due = datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace;
  return { buyerLovelace: due < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : due, validFrom: Math.max(datum.deliver_by, nowMs - 60_000), validTo: nowMs + 60_000, redeemerHex: redeemerHex(REDEEMER.Reclaim) };
}
```

- [ ] **Step 5: Run the tests**

Run: `node --import tsx --test packages/builder/test/marketplace-build.test.ts`
Expected: PASS for plan and reserve tests and the offline Post build. If `FixtureProvider.getUtxosByOutRef` does not return the advert UTxO, check that it filters its constructor list by `txHash`/`outputIndex` (it does for the gov tests); if `ensureSlotConfig` throws offline because `FixtureProvider` lacks `getSystemStartMs`, add to the fixture provider class: `async getSystemStartMs() { return 1756485600000; }` and `async getNetworkTip() { return { slot: 0, hash: '' }; }`.

- [ ] **Step 6: Commit**

```bash
git add packages/builder/src/vector/marketplace-build.ts packages/builder/test/marketplace-build.test.ts packages/builder/test/fixtures/fixture-provider.ts
git commit -m "feat(marketplace): unsigned Post builder, Accept/Reclaim plans, collateral reservation"
```

### Task 5: Lineage resolution and the Accept/Reclaim builders

**Files:**
- Modify: `packages/builder/src/vector/marketplace-build.ts` (append)
- Test: `packages/builder/test/marketplace-build.test.ts` (append)

**Interfaces:**
- Produces: `resolveEscrowLineage(provider, koiosUrl, escrowRef): Promise<{ posted: EscrowDatum; current: { utxo: UTxO; datum: EscrowDatum } | null; spent: boolean }>`, `buildAccept(lucid, provider, koiosUrl, p: { changeAddress; escrowRef; nowMs? })`, `buildReclaim(...)`.

- [ ] **Step 1: Write the failing lineage test**

Append to the test file:
```ts
import { resolveEscrowLineage } from '../src/vector/marketplace-build.ts';
import { ESCROW_OPEN_DATUM_HEX } from './fixtures/marketplace.fixture.ts';
import { encodeEscrowDatum } from '../src/vector/marketplace-datum.ts';

describe('resolveEscrowLineage', () => {
  const posted = decodeEscrowDatum(ESCROW_OPEN_DATUM_HEX);
  const submitted = { ...posted, submitted_at: posted.posted_at + 60_000, result_receipt_hash: 'cd'.repeat(32), state: 'Submitted' as const };
  const current: UTxO = { txHash: 'ee'.repeat(32), outputIndex: 0, address: ESCROW_ADDRESS, assets: { lovelace: 2_261_030n }, datum: encodeEscrowDatum(submitted) };
  const stranger: UTxO = { txHash: 'ff'.repeat(32), outputIndex: 0, address: ESCROW_ADDRESS, assets: { lovelace: 2_261_030n }, datum: encodeEscrowDatum({ ...submitted, posted_at: 1 }) };
  const koios = (async () => new Response(JSON.stringify([{ tx_hash: ESCROW_REF.slice(0, 64), tx_index: 0, value: '2261030', is_spent: true, inline_datum: { bytes: ESCROW_OPEN_DATUM_HEX } }]), { status: 200 })) as unknown as typeof fetch;
  test('finds the current UTxO by advert_ref, buyer, posted_at and prompt_hash', async () => {
    const r = await resolveEscrowLineage(new FixtureProvider([current, stranger]), 'https://koios.example', ESCROW_REF, koios);
    assert.equal(r.spent, true);
    assert.equal(r.current?.utxo.txHash, 'ee'.repeat(32));
    assert.equal(r.current?.datum.state, 'Submitted');
  });
  test('returns current = null when the lineage is finished', async () => {
    const r = await resolveEscrowLineage(new FixtureProvider([stranger]), 'https://koios.example', ESCROW_REF, koios);
    assert.equal(r.current, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-build.test.ts`
Expected: FAIL, `resolveEscrowLineage` is not exported.

- [ ] **Step 3: Append the lineage resolver and the two builders**

```ts
// append to packages/builder/src/vector/marketplace-build.ts
import { koiosUtxoInfo } from './marketplace-indexer.js';

/** The escrow moves to a new UTxO at Claim and Submit. Find where it is now. */
export async function resolveEscrowLineage(provider: Provider, koiosUrl: string, escrowRef: string, fetchImpl: typeof fetch = fetch) {
  const ref = parseOutRef(escrowRef);
  const [postedUtxo] = await koiosUtxoInfo(koiosUrl, [formatOutRef(ref.txHash, ref.outputIndex)], fetchImpl);
  if (!postedUtxo?.inline_datum?.bytes) throw new Error(`Escrow ${escrowRef} not found on the ledger (no inline datum).`);
  const posted = decodeEscrowDatum(postedUtxo.inline_datum.bytes);
  const spent = postedUtxo.is_spent === true;
  if (!spent) {
    const [u] = await provider.getUtxosByOutRef([ref]);
    return { posted, current: u?.datum ? { utxo: u, datum: posted } : null, spent };
  }
  const all = await provider.getUtxos(ESCROW_ADDRESS);
  for (const u of all) {
    if (!u.datum) continue;
    let d: EscrowDatum;
    try { d = decodeEscrowDatum(u.datum); } catch { continue; }
    if (d.advert_ref.txHash === posted.advert_ref.txHash && d.advert_ref.index === posted.advert_ref.index
      && d.buyer_pkh === posted.buyer_pkh && d.posted_at === posted.posted_at && d.prompt_hash === posted.prompt_hash) {
      return { posted, current: { utxo: u, datum: d }, spent };
    }
  }
  return { posted, current: null, spent };
}

async function escrowRefScript(provider: Provider): Promise<UTxO> {
  const [u] = await provider.getUtxosByOutRef([ESCROW_REF_UTXO]);
  if (!u?.scriptRef) throw new Error(`Escrow reference script ${formatOutRef(ESCROW_REF_UTXO.txHash, ESCROW_REF_UTXO.outputIndex)} not found; the marketplace needs to republish it.`);
  return u;
}
function assertCollateral(utxos: UTxO[]) {
  if (!utxos.some((u) => Object.keys(u.assets).every((k) => k === 'lovelace') && u.assets.lovelace >= COLLATERAL_MIN_LOVELACE)) {
    throw new Error('Collateral required: the wallet must hold one pure output of at least 5 units.');
  }
}

export async function buildAccept(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: { changeAddress: string; escrowRef: string; nowMs?: number })
  : Promise<VectorUnsignedBuildResult & { supplierLovelace: bigint; buyerLovelace: bigint; secondsLeft: number }> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const lineage = await resolveEscrowLineage(provider, koiosUrl, p.escrowRef);
  if (!lineage.current) throw new Error(`Escrow ${p.escrowRef} has no live UTxO: it was already accepted, released or reclaimed.`);
  const nowMs = p.nowMs ?? Date.now();
  const plan = planAccept(lineage.current.datum, callerPkh, nowMs);
  await ensureSlotConfig(provider as any);
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([await escrowRefScript(provider)])
    .collectFrom([lineage.current.utxo], plan.redeemerHex)
    .pay.ToAddress(plan.supplierAddress, { lovelace: plan.supplierLovelace })
    .pay.ToAddress(p.changeAddress, { lovelace: plan.buyerLovelace })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete({ localUPLCEval: false });
  return { ...toBuildResult(completed), supplierLovelace: plan.supplierLovelace, buyerLovelace: plan.buyerLovelace, secondsLeft: plan.secondsLeft };
}

export async function buildReclaim(lucid: LucidEvolution, provider: Provider, koiosUrl: string, p: { changeAddress: string; escrowRef: string; nowMs?: number })
  : Promise<VectorUnsignedBuildResult & { buyerLovelace: bigint }> {
  const callerPkh = paymentKeyHashOf(p.changeAddress);
  const lineage = await resolveEscrowLineage(provider, koiosUrl, p.escrowRef);
  if (!lineage.current) throw new Error(`Escrow ${p.escrowRef} has no live UTxO: nothing to reclaim.`);
  const nowMs = p.nowMs ?? Date.now();
  const plan = planReclaim(lineage.current.datum, callerPkh, nowMs);
  await ensureSlotConfig(provider as any);
  assertCollateral(await lucid.wallet().getUtxos());
  const completed = await lucid.newTx()
    .readFrom([await escrowRefScript(provider)])
    .collectFrom([lineage.current.utxo], plan.redeemerHex)
    .pay.ToAddress(p.changeAddress, { lovelace: plan.buyerLovelace })
    .addSignerKey(callerPkh)
    .validFrom(plan.validFrom)
    .validTo(plan.validTo)
    .setMinFee(MARKETPLACE_MIN_FEE)
    .complete({ localUPLCEval: false });
  return { ...toBuildResult(completed), buyerLovelace: plan.buyerLovelace };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test packages/builder/test/marketplace-build.test.ts`
Expected: PASS (lineage tests included). The Accept/Reclaim assembly is not exercised offline (script evaluation is delegated to Ogmios by design); it runs in the first-party E2E (Plan B, `docs/E2E.md`) before any deploy.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(marketplace): lineage resolver and unsigned Accept/Reclaim builders"
```

### Task 6: Register the build tools, snapshot, PR 2

**Files:**
- Modify: `packages/builder/src/vector/marketplace.ts` (append three tools inside `registerMarketplaceTools`)
- Modify: `packages/builder/test/smoke/tool-inventory.test.ts`, `README.md`, `server.json`

- [ ] **Step 1: Add imports and the three tools**

Add to the imports of `marketplace.ts`:
```ts
import { OgmiosProvider } from '@apexfusion/vector-mcp-shared/provider';
import { VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '@apexfusion/vector-mcp-shared/config';
import { lucidForAddress } from './build.js';
import { buildPostEscrow, buildAccept, buildReclaim } from './marketplace-build.js';
const SIGN_COPY = 'Sign it locally with vector_signer_sign { txCbor }, broadcast with vector_submit_transaction { signedTxCbor }, then confirm with vector_await_transaction { txHash }.';
function newProvider() { return new OgmiosProvider({ ogmiosUrl: VECTOR_OGMIOS_URL, submitUrl: VECTOR_SUBMIT_URL, koiosUrl: VECTOR_KOIOS_URL }); }
```
Append inside `registerMarketplaceTools`, after the get_supplier tool:
```ts
  server.tool(
    "vector_build_marketplace_post_escrow",
    "Build an UNSIGNED transaction that hires a supplier on the Vector agents marketplace: locks price + supplier bond + buyer bond in escrow for the given advert and commits a hash of your payload. Takes no key material. After it confirms, call vector_marketplace_send_job with the returned escrow_ref and the same payload. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("Your wallet address (pays the lock and fees; receives the bond back on Accept). Get it from vector_signer_get_address."),
      advert_ref: z.string().describe("Advert '<txid>#<index>' from vector_marketplace_list_suppliers"),
      payload: z.string().min(1).describe("The job payload string exactly as you will send it (for JSON, pass the JSON text)"),
      deliver_by_ms: z.number().int().optional().describe("Optional POSIX ms deadline; default now + advert window + 180 s"),
    },
    async ({ changeAddress, advert_ref, payload, deliver_by_ms }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildPostEscrow(lucid, provider, { changeAddress, advertRef: advert_ref, payload, deliverByMs: deliver_by_ms });
        const md = `# Unsigned Escrow Post Built (Not Submitted)\n\n**Escrow ref (after submit):** \`${r.escrowRef}\`\n**Locked:** ${lovelaceToAda(r.lockLovelace)} (price + both bonds, min-ada floored)\n**Deliver by:** ${new Date(r.deliverBy).toISOString()}\n**Payload hash:** \`${r.promptHash}\`\n**Estimated fee:** ${r.feeAda}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\nKeep the payload byte-identical for vector_marketplace_send_job. ${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref: r.escrowRef, lock_lovelace: r.lockLovelace, deliver_by: r.deliverBy, prompt_hash: r.promptHash, tx_hash: r.txHash, fee: r.fee }));
      } catch (err) { return fail('build escrow post', err, ['The wallet needs the lock plus about 1 unit for fees, and one pure 5-unit output kept as collateral', 'Check the advert is still Active with vector_marketplace_get_supplier']); }
    },
  );

  server.tool(
    "vector_build_marketplace_accept",
    "Build an UNSIGNED transaction that accepts a Submitted marketplace job: pays the supplier price + supplier bond and returns your buyer bond. Only the buyer can accept, within 600 s of the supplier's Submit. Verify the receipt first with vector_marketplace_verify_receipt. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildAccept(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref });
        const warn = r.secondsLeft < 120 ? `\n\n**Hurry:** only ${r.secondsLeft} s remain in the accept window.` : '';
        const md = `# Unsigned Accept Built (Not Submitted)\n\n**Supplier receives:** ${lovelaceToAda(r.supplierLovelace)}\n**Your bond back:** ${lovelaceToAda(r.buyerLovelace)}\n**Estimated fee:** ${r.feeAda}${warn}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref, tx_hash: r.txHash, supplier_lovelace: r.supplierLovelace, buyer_lovelace: r.buyerLovelace, seconds_left: r.secondsLeft }));
      } catch (err) { return fail('build accept', err, ['The job must be in Submitted state: poll vector_marketplace_get_job first', 'Accept must land within 600 s of Submit; after that the supplier may Release', 'The wallet needs one pure 5-unit output as collateral']); }
    },
  );

  server.tool(
    "vector_build_marketplace_reclaim",
    "Build an UNSIGNED transaction that reclaims your escrow after deliver_by when the supplier never submitted (state Open or Claimed): everything returns to you. " + SIGN_COPY,
    {
      changeAddress: z.string().describe("The buyer wallet address that posted the escrow"),
      escrow_ref: z.string().describe("The escrow_ref returned by vector_build_marketplace_post_escrow"),
    },
    async ({ changeAddress, escrow_ref }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = newProvider();
        const lucid = await lucidForAddress(provider, changeAddress);
        const r = await buildReclaim(lucid, provider, VECTOR_KOIOS_URL, { changeAddress, escrowRef: escrow_ref });
        const md = `# Unsigned Reclaim Built (Not Submitted)\n\n**Returned to you:** ${lovelaceToAda(r.buyerLovelace)}\n**Estimated fee:** ${r.feeAda}\n\n**Unsigned TX CBOR:**\n\`\`\`\n${r.txCbor}\n\`\`\`\n\n${SIGN_COPY}`;
        return text(withJson(md, { escrow_ref, tx_hash: r.txHash, buyer_lovelace: r.buyerLovelace }));
      } catch (err) { return fail('build reclaim', err, ['Reclaim opens only after deliver_by', 'A Submitted escrow cannot be reclaimed: accept it or wait for the supplier to Release']); }
    },
  );
```

- [ ] **Step 2: Snapshot, counts, tests**

Add `'vector_build_marketplace_accept'`, `'vector_build_marketplace_post_escrow'`, `'vector_build_marketplace_reclaim'` to `EXPECTED_TOOLS` (alphabetical). Then:
```bash
npm run build && node packages/builder/scripts/regen-tool-schemas.mjs && npm run typecheck && npm run test:unit && npm run test:smoke
```
Expected: `wrote 30 tool schemas`, all green. Update README ("30", list the three build tools under Marketplace) and `server.json` ("30 keyless tools…").

- [ ] **Step 3: Commit and open PR 2 (stacked on PR 1)**

```bash
git add -A && git commit -m "feat(marketplace): keyless build tools for escrow post, accept and reclaim"
git push -u upstream feat/marketplace-build-tools
gh pr create --repo Apex-Fusion/mcp-server --base feat/marketplace-read-tools --head feat/marketplace-build-tools \
  --title "Marketplace build tools: unsigned escrow post, accept, reclaim" --reviewer <reviewer handle> \
  --body "Stacked on #<PR1 number>; retarget to main once PR 1 merges. Unsigned builders on lucidForAddress; golden datum tests; Accept/Reclaim plans unit-tested, assembly exercised in the first-party E2E before deploy. Reclaim ships so a member can never strand funds on a silent supplier.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Replace `<PR1 number>` with the number printed by the Task 3 `gh pr create`.

---

## PR 3: job transport and receipt verification

### Task 7: safeFetch

**Files:**
- Create: `packages/builder/src/vector/safe-fetch.ts`
- Test: `packages/builder/test/safe-fetch.test.ts`

**Interfaces:**
- Produces: `assertSafeUrl(url: string): URL` (throws with the rule name), `isPrivateAddress(ip: string): boolean`, `safeFetch(url, init?, opts?: { maxResponseBytes?, timeoutMs?, lookup? }): Promise<{ status: number; headers: Headers; text: string }>`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/builder/test/safe-fetch.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeUrl, isPrivateAddress, safeFetch } from '../src/vector/safe-fetch.ts';

describe('safeFetch policy', () => {
  test('refuses non-https', () => { assert.throws(() => assertSafeUrl('http://example.com/x'), /https/); });
  test('refuses credentials in the URL', () => { assert.throws(() => assertSafeUrl('https://user:pw@example.com/'), /credentials/); });
  test('classifies private and special ranges', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  });
  test('refuses a host that resolves to a private address', async () => {
    const lookup = async () => [{ address: '169.254.169.254', family: 4 }];
    await assert.rejects(() => safeFetch('https://metadata.example/', {}, { lookup, fetchImpl: (async () => new Response('x')) as any }), /private/);
  });
  test('caps the response size', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const big = 'a'.repeat(5000);
    await assert.rejects(() => safeFetch('https://ok.example/', {}, { lookup, maxResponseBytes: 1000, fetchImpl: (async () => new Response(big)) as any }), /exceeds/);
  });
  test('refuses cross-scheme redirects', async () => {
    const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    const f = (async () => new Response('', { status: 302, headers: { location: 'http://evil.example/' } })) as any;
    await assert.rejects(() => safeFetch('https://ok.example/', {}, { lookup, fetchImpl: f }), /redirect/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/safe-fetch.test.ts` Expected: FAIL, module not found.

- [ ] **Step 3: Write safeFetch**

```ts
// packages/builder/src/vector/safe-fetch.ts
// The only code path on the public server that fetches URLs taken from chain data
// (advert endpoint_url, detail_uri). Rules: https only, no credentials, hosts that
// resolve to loopback/private/link-local/CGNAT/unspecified ranges are refused,
// bodies are capped, redirects never change scheme, and the whole call has a budget.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SafeFetchOpts {
  maxResponseBytes?: number; timeoutMs?: number;
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  fetchImpl?: typeof fetch;
}
export const SAFE_FETCH_DEFAULTS = { maxResponseBytes: 2 * 1024 * 1024, timeoutMs: 90_000 } as const;

export function assertSafeUrl(url: string): URL {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`safeFetch: malformed URL`); }
  if (u.protocol !== 'https:') throw new Error('safeFetch: only https URLs are allowed');
  if (u.username || u.password) throw new Error('safeFetch: credentials in URLs are not allowed');
  return u;
}

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('::ffff:')) return isPrivateAddress(low.slice(7));
    const first = parseInt(low.split(':')[0] || '0', 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return true;
}

export async function safeFetch(url: string, init: RequestInit = {}, opts: SafeFetchOpts = {}): Promise<{ status: number; headers: Headers; text: string }> {
  const u = assertSafeUrl(url);
  const lookup = opts.lookup ?? (async (h: string) => dnsLookup(h, { all: true }));
  const addrs = isIP(u.hostname) ? [{ address: u.hostname, family: isIP(u.hostname) }] : await lookup(u.hostname);
  if (addrs.length === 0) throw new Error(`safeFetch: ${u.hostname} does not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw new Error(`safeFetch: ${u.hostname} resolves to a private or reserved address; refused`);
  const f = opts.fetchImpl ?? fetch;
  const res = await f(u.toString(), { ...init, redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs) });
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get('location') ?? '';
    throw new Error(`safeFetch: redirect to ${loc || '(no location)'} refused (redirects are not followed)`);
  }
  const max = opts.maxResponseBytes ?? SAFE_FETCH_DEFAULTS.maxResponseBytes;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > max) throw new Error(`safeFetch: response of ${buf.byteLength} bytes exceeds the ${max} byte cap`);
  return { status: res.status, headers: res.headers, text: buf.toString('utf8') };
}
```

- [ ] **Step 4: Run tests, commit**

```bash
cd "<workspace>/vector-agentic-framework/mcp-server/wt-marketplace-build"
git worktree add "../wt-marketplace-transport" -b feat/marketplace-transport feat/marketplace-build-tools && cd "../wt-marketplace-transport" && npm ci && cp ../wt-marketplace-build/.env .env
node --import tsx --test packages/builder/test/safe-fetch.test.ts
git add -A && git commit -m "feat(marketplace): safeFetch policy for supplier URLs"
```
Expected: 6 tests pass before the commit.

### Task 8: Route table, sendJob, getJob

**Files:**
- Create: `packages/builder/src/vector/marketplace-transport.ts`
- Test: `packages/builder/test/marketplace-transport.test.ts`

**Interfaces:**
- Produces: `routeFor(capabilityId): Route`, `sendJob(provider, koiosUrl, p: { escrowRef; payload; route? }, fetchImpl?)`, `getJob(provider, koiosUrl, p: { escrowRef; jobId }, fetchImpl?)`, types `Route = { kind: 'template' | 'chat' | 'ocr' | 'tts'; post: (endpoint) => string; poll: (endpoint, id) => string; body: (escrowRef, payload) => { headers; body } }`.

- [ ] **Step 1: Pin the fleet routes from marketplace main**

```bash
cd "<workspace>/agents-marketplace" && git fetch origin && git grep -n -E 'app\.(post|get)\("/v1/' origin/main -- supplier/src/server.ts
```
Record the exact paths printed for chat/completions or responses, ocr/extract and audio/synthesize (post and poll). If the chat POST path printed is `/v1/responses`, use it in `ROUTES.chat.post` below instead of `/v1/chat/completions`; the poll path follows the same prefix with `/:jobId`.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/builder/test/marketplace-transport.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, parseJobResponse } from '../src/vector/marketplace-transport.ts';

describe('route table', () => {
  test('unknown capabilities use the template contract', () => {
    const r = routeFor('identity.history.report.v1');
    assert.equal(r.kind, 'template');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/job');
    assert.equal(r.poll('https://s.example', 'abc'), 'https://s.example/v1/job/abc');
    const b = r.body('e#0', '{"x":1}');
    assert.deepEqual(JSON.parse(b.body), { escrow_ref: 'e#0', payload: '{"x":1}' });
  });
  test('fleet LLM route sends X-Escrow-Ref and a messages body', () => {
    const r = routeFor('llm.text.generate.v1');
    const b = r.body('e#0', 'hi');
    assert.equal(b.headers['X-Escrow-Ref'], 'e#0');
    assert.deepEqual(JSON.parse(b.body).messages, [{ role: 'user', content: 'hi' }]);
  });
  test('ocr route passes the payload JSON through', () => {
    const r = routeFor('ocr.page.extract.chandra-ocr-2.v1');
    assert.equal(r.post('https://s.example'), 'https://s.example/v1/ocr/extract');
    assert.equal(r.body('e#0', '{"image_b64":"AA==","mime":"image/png"}').body, '{"image_b64":"AA==","mime":"image/png"}');
  });
});

describe('parseJobResponse', () => {
  test('202 is pending', () => { assert.deepEqual(parseJobResponse(202, '{"status":"running","escrow_ref":"e#0"}'), { state: 'pending', status: 'running' }); });
  test('200 carries result and receipt', () => {
    const p = parseJobResponse(200, JSON.stringify({ choices: [{ message: { content: 'out' } }], receipt: { a: 1 }, receipt_signature: 'ab', escrow_ref: 'e#0' }));
    assert.equal(p.state, 'done'); assert.equal(p.result, 'out'); assert.equal(p.receiptSignature, 'ab');
  });
  test('failed jobs surface the reason', () => { assert.deepEqual(parseJobResponse(502, '{"status":"failed","reason":"service_timeout","message":"m"}'), { state: 'failed', reason: 'service_timeout', message: 'm' }); });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-transport.test.ts` Expected: FAIL, module not found.

- [ ] **Step 4: Write the transport module**

```ts
// packages/builder/src/vector/marketplace-transport.ts
// Job transport to supplier endpoints, through safeFetch only.
import type { Provider } from '@lucid-evolution/lucid';
import { safeFetch } from './safe-fetch.js';
import { koiosUtxoInfo } from './marketplace-indexer.js';
import { decodeAdvertDatum } from './marketplace-datum.js';
import { resolveEscrowLineage } from './marketplace-build.js';

export interface Route {
  kind: 'template' | 'chat' | 'ocr' | 'tts';
  post: (endpoint: string) => string;
  poll: (endpoint: string, jobId: string) => string;
  body: (escrowRef: string, payload: string) => { headers: Record<string, string>; body: string };
}
const json = { 'content-type': 'application/json', accept: 'application/json' };
const trim = (e: string) => e.replace(/\/+$/, '');
export const ROUTES: Record<Route['kind'], Route> = {
  template: { kind: 'template', post: (e) => `${trim(e)}/v1/job`, poll: (e, id) => `${trim(e)}/v1/job/${id}`,
    body: (escrowRef, payload) => ({ headers: json, body: JSON.stringify({ escrow_ref: escrowRef, payload }) }) },
  chat: { kind: 'chat', post: (e) => `${trim(e)}/v1/chat/completions`, poll: (e, id) => `${trim(e)}/v1/chat/completions/${id}`,
    body: (escrowRef, payload) => ({ headers: { ...json, 'X-Escrow-Ref': escrowRef }, body: JSON.stringify({ messages: [{ role: 'user', content: payload }] }) }) },
  ocr: { kind: 'ocr', post: (e) => `${trim(e)}/v1/ocr/extract`, poll: (e, id) => `${trim(e)}/v1/ocr/extract/${id}`,
    body: (escrowRef, payload) => ({ headers: { ...json, 'X-Escrow-Ref': escrowRef }, body: payload }) },
  tts: { kind: 'tts', post: (e) => `${trim(e)}/v1/audio/synthesize`, poll: (e, id) => `${trim(e)}/v1/audio/synthesize/${id}`,
    body: (escrowRef, payload) => ({ headers: { ...json, 'X-Escrow-Ref': escrowRef }, body: payload }) },
};
export function routeFor(capabilityId: string, forced?: Route['kind']): Route {
  if (forced) return ROUTES[forced];
  if (capabilityId.startsWith('llm.')) return ROUTES.chat;
  if (capabilityId.startsWith('ocr.')) return ROUTES.ocr;
  if (capabilityId.startsWith('audio.synthesize.')) return ROUTES.tts;
  return ROUTES.template;
}

export type JobView =
  | { state: 'pending'; status: string }
  | { state: 'done'; result: string; receipt: unknown; receiptSignature: string; raw: unknown }
  | { state: 'failed'; reason: string; message: string };
export function parseJobResponse(status: number, text: string): JobView {
  let body: any = {};
  try { body = JSON.parse(text); } catch { /* keep {} */ }
  if (status === 202) return { state: 'pending', status: String(body.status ?? 'accepted') };
  if (status === 200) {
    const result = body?.choices?.[0]?.message?.content ?? body?.content ?? body?.audio_b64 ?? text;
    return { state: 'done', result: String(result), receipt: body.receipt, receiptSignature: String(body.receipt_signature ?? ''), raw: body };
  }
  return { state: 'failed', reason: String(body.reason ?? `http_${status}`), message: String(body.message ?? text.slice(0, 200)) };
}

async function endpointFor(provider: Provider, koiosUrl: string, escrowRef: string, fetchImpl: typeof fetch) {
  const lineage = await resolveEscrowLineage(provider, koiosUrl, escrowRef, fetchImpl);
  const adv = lineage.posted.advert_ref;
  const [advertUtxo] = await koiosUtxoInfo(koiosUrl, [`${adv.txHash}#${adv.index}`], fetchImpl);
  if (!advertUtxo?.inline_datum?.bytes) throw new Error('Advert for this escrow not found on the ledger');
  const advert = decodeAdvertDatum(advertUtxo.inline_datum.bytes);
  return { advert, lineage };
}

export async function sendJob(provider: Provider, koiosUrl: string, p: { escrowRef: string; payload: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch) {
  const { advert, lineage } = await endpointFor(provider, koiosUrl, p.escrowRef, fetchImpl);
  if (lineage.current?.datum.state !== 'Open') throw new Error(`Escrow is ${lineage.current?.datum.state ?? 'finished'}; a job can only be sent while it is Open`);
  const route = routeFor(advert.capability_id, p.route);
  const { headers, body } = route.body(p.escrowRef, p.payload);
  const res = await safeFetch(route.post(advert.endpoint_url), { method: 'POST', headers, body }, { timeoutMs: 90_000, maxResponseBytes: 1024 * 1024, fetchImpl });
  let parsed: any = {}; try { parsed = JSON.parse(res.text); } catch { /* keep */ }
  if (res.status !== 202 || !parsed.job_id) throw new Error(`Supplier answered ${res.status}: ${(parsed.reason ?? '')} ${(parsed.message ?? res.text.slice(0, 200))}`.trim());
  return { jobId: String(parsed.job_id), status: String(parsed.status ?? 'accepted'), route: route.kind, endpoint: advert.endpoint_url, capabilityId: advert.capability_id };
}

export async function getJob(provider: Provider, koiosUrl: string, p: { escrowRef: string; jobId: string; route?: Route['kind'] }, fetchImpl: typeof fetch = fetch) {
  const { advert } = await endpointFor(provider, koiosUrl, p.escrowRef, fetchImpl);
  const route = routeFor(advert.capability_id, p.route);
  const res = await safeFetch(route.poll(advert.endpoint_url, p.jobId), { headers: { accept: 'application/json' } }, { timeoutMs: 30_000, fetchImpl });
  return { view: parseJobResponse(res.status, res.text), endpoint: advert.endpoint_url, supplierPkh: advert.supplier_pkh };
}
```

- [ ] **Step 5: Run tests and commit**

Run: `node --import tsx --test packages/builder/test/marketplace-transport.test.ts` Expected: PASS, 6 tests.
```bash
git add -A && git commit -m "feat(marketplace): job transport with pinned supplier routes"
```

- [ ] **Step 6: Add the timeout behaviour test (Review Focus 1)**

Append to the transport test:
```ts
import { sendJob } from '../src/vector/marketplace-transport.ts';
test('a supplier that never answers produces a reclaim hint, not a hang', async () => {
  const never = (async (_u: string, init: any) => { await new Promise((r) => setTimeout(r, 50)); throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }) as unknown as typeof fetch;
  await assert.rejects(() => sendJob({} as any, 'https://koios.example', { escrowRef: 'a'.repeat(64) + '#0', payload: 'x' }, never), /timeout|aborted|not found/i);
});
```
Run the file again; expected PASS (the rejection surfaces before any hang). Commit: `git commit -am "test(marketplace): supplier timeout surfaces an error"`.

### Task 9: verifyReceipt, the three transport tools, PR 3

**Files:**
- Modify: `packages/builder/src/vector/marketplace-transport.ts` (append `verifyReceipt`)
- Modify: `packages/builder/src/vector/marketplace.ts` (append three tools; upgrade get_supplier to fetch `detail_uri`)
- Test: `packages/builder/test/marketplace-transport.test.ts` (append)

- [ ] **Step 1: Write the failing verification tests**

```ts
import { CML } from '@lucid-evolution/lucid';
import { createHash } from 'node:crypto';
import { canonicalize } from '../src/vector/marketplace-datum.ts';
import { verifyReceipt } from '../src/vector/marketplace-transport.ts';

function signedReceipt(sk: CML.PrivateKey, escrowRef: string, payload: string, output: string) {
  const pub = sk.to_public();
  const receipt = {
    prompt_hash: createHash('sha256').update(payload, 'utf8').digest('hex'),
    response_hash: createHash('sha256').update(output, 'utf8').digest('hex'),
    model: 'm', prompt_tokens: 0, completion_tokens: 0, wallclock_ms: 1,
    supplier_pkh: pub.hash().to_hex(), escrow_ref: escrowRef,
  };
  const sig = sk.sign(Buffer.from(canonicalize(receipt), 'utf8')).to_hex();
  return { receipt, sig, pubHex: pub.to_hex(), pkh: pub.hash().to_hex() };
}

describe('verifyReceipt', () => {
  const sk = CML.PrivateKey.generate_ed25519();
  const ref = 'a'.repeat(64) + '#0';
  const r = signedReceipt(sk, ref, 'payload', 'output');
  const onChain = createHash('sha256').update(canonicalize({ receipt: r.receipt, signature: r.sig }), 'utf8').digest('hex');
  test('all checks pass for a good receipt', () => {
    const v = verifyReceipt({ receipt: r.receipt, signature: r.sig, escrowRef: ref, output: 'output', supplierPubKeyHex: r.pubHex, escrowSupplierPkh: r.pkh, resultReceiptHashOnChain: onChain });
    assert.equal(v.ok, true); assert.deepEqual(Object.values(v.checks).every(Boolean), true);
  });
  test('wrong escrow ref fails that check only', () => {
    const v = verifyReceipt({ receipt: r.receipt, signature: r.sig, escrowRef: 'b'.repeat(64) + '#0', output: 'output', supplierPubKeyHex: r.pubHex, escrowSupplierPkh: r.pkh, resultReceiptHashOnChain: onChain });
    assert.equal(v.ok, false); assert.equal(v.checks.escrow_ref_matches, false); assert.equal(v.checks.signature_valid, true);
  });
  test('a key that is not the supplier fails pub_key_is_supplier', () => {
    const other = CML.PrivateKey.generate_ed25519();
    const v = verifyReceipt({ receipt: r.receipt, signature: r.sig, escrowRef: ref, output: 'output', supplierPubKeyHex: other.to_public().to_hex(), escrowSupplierPkh: r.pkh, resultReceiptHashOnChain: onChain });
    assert.equal(v.checks.pub_key_is_supplier, false); assert.equal(v.ok, false);
  });
  test('a tampered output fails response_hash', () => {
    const v = verifyReceipt({ receipt: r.receipt, signature: r.sig, escrowRef: ref, output: 'output!', supplierPubKeyHex: r.pubHex, escrowSupplierPkh: r.pkh, resultReceiptHashOnChain: onChain });
    assert.equal(v.checks.response_hash_matches, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test packages/builder/test/marketplace-transport.test.ts` Expected: FAIL, `verifyReceipt` not exported.

- [ ] **Step 3: Append verifyReceipt**

```ts
// append to marketplace-transport.ts
import { CML } from '@lucid-evolution/lucid';
import { canonicalize, sha256Utf8Hex } from './marketplace-datum.js';

export interface VerifyInput {
  receipt: unknown; signature: string; escrowRef: string; output?: string;
  supplierPubKeyHex: string; escrowSupplierPkh: string; resultReceiptHashOnChain: string | null;
}
export function verifyReceipt(i: VerifyInput) {
  const r = (i.receipt && typeof i.receipt === 'object' ? i.receipt : {}) as Record<string, unknown>;
  const checks = {
    receipt_well_formed: typeof r.prompt_hash === 'string' && typeof r.response_hash === 'string' && typeof r.supplier_pkh === 'string' && typeof r.escrow_ref === 'string' && /^[0-9a-f]{128}$/i.test(i.signature),
    escrow_ref_matches: r.escrow_ref === i.escrowRef,
    response_hash_matches: i.output === undefined ? true : String(r.response_hash).toLowerCase() === sha256Utf8Hex(i.output),
    pub_key_is_supplier: false, supplier_pkh_matches_escrow: String(r.supplier_pkh).toLowerCase() === i.escrowSupplierPkh.toLowerCase(),
    signature_valid: false, on_chain_hash_matches: false,
  };
  try {
    const pub = CML.PublicKey.from_bytes(Buffer.from(i.supplierPubKeyHex, 'hex'));
    checks.pub_key_is_supplier = pub.hash().to_hex() === i.escrowSupplierPkh.toLowerCase();
    checks.signature_valid = pub.verify(Buffer.from(canonicalize(r), 'utf8'), CML.Ed25519Signature.from_hex(i.signature));
  } catch { /* leave false */ }
  if (i.resultReceiptHashOnChain) {
    checks.on_chain_hash_matches = sha256Utf8Hex(canonicalize({ receipt: r, signature: i.signature })) === i.resultReceiptHashOnChain.toLowerCase();
  }
  const ok = Object.values(checks).every(Boolean);
  return { ok, checks };
}
```

- [ ] **Step 4: Run tests**

Run: `node --import tsx --test packages/builder/test/marketplace-transport.test.ts` Expected: PASS (11 tests, including the timeout test from Task 8). If `CML.PublicKey.from_bytes` is not a function in this CML build, use `CML.PublicKey.from_raw_bytes`; if `verify` wants raw bytes, pass `Buffer.from(i.signature, 'hex')` through `CML.Ed25519Signature.from_raw_bytes`.

- [ ] **Step 5: Append the three tools and upgrade get_supplier**

Add imports to `marketplace.ts`:
```ts
import { sendJob, getJob, verifyReceipt } from './marketplace-transport.js';
import { resolveEscrowLineage } from './marketplace-build.js';
import { safeFetch } from './safe-fetch.js';
```
Append inside `registerMarketplaceTools`:
```ts
  server.tool(
    "vector_marketplace_send_job",
    "Send the job payload to the supplier of a confirmed Open escrow. The supplier claims the escrow on chain (up to 60 s) and answers with a job_id. Poll with vector_marketplace_get_job. The payload must be byte-identical to the one given to vector_build_marketplace_post_escrow.",
    {
      escrow_ref: z.string().describe("escrow_ref from the confirmed post"),
      payload: z.string().min(1).describe("Same payload string as at post time"),
      route: z.enum(['auto', 'template', 'chat', 'ocr', 'tts']).optional().default('auto').describe("Force a supplier route; default picks by capability id"),
    },
    async ({ escrow_ref, payload, route }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const r = await sendJob(newProvider(), VECTOR_KOIOS_URL, { escrowRef: escrow_ref, payload, route: route === 'auto' ? undefined : route });
        return text(withJson(`# Job sent\n\n**job_id:** \`${r.jobId}\` · **status:** ${r.status} · **route:** ${r.route} · **capability:** ${r.capabilityId}\n\nPoll with vector_marketplace_get_job { escrow_ref, job_id } every few seconds until it returns a receipt.`, r));
      } catch (err) { return fail('send job', err, ['Make sure the post transaction is confirmed (vector_await_transaction) before sending', 'If the supplier did not answer within 90 s the escrow is still Open: try again, or reclaim after deliver_by', 'Supplier busy or offline: pick another advert']); }
    },
  );

  server.tool(
    "vector_marketplace_get_job",
    "Poll a marketplace job. Returns pending, failed, or done with the result, the signed receipt and the supplier's submit reference.",
    { escrow_ref: z.string(), job_id: z.string(), route: z.enum(['auto', 'template', 'chat', 'ocr', 'tts']).optional().default('auto') },
    async ({ escrow_ref, job_id, route }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const r = await getJob(newProvider(), VECTOR_KOIOS_URL, { escrowRef: escrow_ref, jobId: job_id, route: route === 'auto' ? undefined : route });
        const v = r.view;
        if (v.state === 'pending') return text(withJson(`# Job ${job_id}: ${v.status}\n\nStill working. Poll again in a few seconds.`, { state: 'pending', status: v.status }));
        if (v.state === 'failed') return text(withJson(`# Job ${job_id}: failed\n\n**Reason:** ${v.reason}\n${v.message}\n\nIf the escrow was claimed, the supplier forfeits its bond when you reclaim after deliver_by.`, v));
        return text(withJson(`# Job ${job_id}: done\n\n**Result:**\n\n${v.result.slice(0, 4000)}${v.result.length > 4000 ? '\n…(truncated in this view; full result in the JSON block)' : ''}\n\n**Receipt:** \`${JSON.stringify(v.receipt)}\`\n**Signature:** \`${v.receiptSignature}\`\n\nNext: vector_marketplace_verify_receipt, then vector_build_marketplace_accept.`, { state: 'done', result: v.result, receipt: v.receipt, receipt_signature: v.receiptSignature, supplier_pkh: r.supplierPkh }));
      } catch (err) { return fail('poll job', err, ['Check escrow_ref and job_id', 'The supplier may be restarting; poll again']); }
    },
  );

  server.tool(
    "vector_marketplace_verify_receipt",
    "Verify a marketplace receipt without trusting the supplier: hashes, Ed25519 signature against the advertised supplier key, the key against the escrow's supplier, and the hash the supplier committed on chain at Submit. Returns a pass/fail table.",
    {
      escrow_ref: z.string(),
      receipt: z.union([z.string(), z.record(z.string(), z.unknown())]).describe("The receipt object (or its JSON text) from vector_marketplace_get_job"),
      receipt_signature: z.string().describe("Hex Ed25519 signature from vector_marketplace_get_job"),
      output: z.string().optional().describe("The exact result string, to check response_hash"),
      supplier_pub_key_hex: z.string().optional().describe("Override the key normally read from the supplier's /capability"),
    },
    async ({ escrow_ref, receipt, receipt_signature, output, supplier_pub_key_hex }) => {
      const limited = checkRateLimit(); if (limited) return limited;
      try {
        const provider = newProvider();
        const lineage = await resolveEscrowLineage(provider, VECTOR_KOIOS_URL, escrow_ref);
        const datum = lineage.current?.datum ?? lineage.posted;
        let pub = supplier_pub_key_hex;
        if (!pub) {
          const adv = lineage.posted.advert_ref;
          const [advertUtxo] = await koiosUtxoInfo(VECTOR_KOIOS_URL, [`${adv.txHash}#${adv.index}`]);
          const advert = decodeAdvertDatum(advertUtxo!.inline_datum!.bytes);
          const cap = await safeFetch(`${advert.endpoint_url.replace(/\/+$/, '')}/capability`, { headers: { accept: 'application/json' } }, { timeoutMs: 20_000 });
          pub = String(JSON.parse(cap.text).pub_key_hex ?? '');
        }
        const rec = typeof receipt === 'string' ? JSON.parse(receipt) : receipt;
        // The Submitted datum carries the hash the supplier committed; a finished escrow has no live UTxO,
        // so the hash is visible only while the job is Submitted. The note below says so when it is missing.
        const onChain = datum.result_receipt_hash;
        const v = verifyReceipt({ receipt: rec, signature: receipt_signature, escrowRef: escrow_ref, output, supplierPubKeyHex: pub!, escrowSupplierPkh: datum.supplier_pkh, resultReceiptHashOnChain: onChain });
        const rows = Object.entries(v.checks).map(([k, ok]) => `| ${k} | ${ok ? 'pass' : 'FAIL'} |`).join('\n');
        const note = onChain ? '' : '\n\nNo on-chain receipt hash is visible yet (the supplier has not submitted, or the escrow is already settled); the on_chain_hash_matches row is false until a Submitted datum is found.';
        return text(withJson(`# Receipt verification: ${v.ok ? 'VERIFIED' : 'NOT VERIFIED'}\n\n| check | result |\n|---|---|\n${rows}${note}`, { verified: v.ok, checks: v.checks, on_chain_hash: onChain }));
      } catch (err) { return fail('verify receipt', err, ['Pass the receipt exactly as returned by vector_marketplace_get_job', 'If the supplier /capability is unreachable, pass supplier_pub_key_hex']); }
    },
  );
```
In `vector_marketplace_get_supplier`, after decoding the advert, add a `detail_uri` fetch:
```ts
        let manifest: unknown = null;
        if (advert.detail_uri) {
          try { manifest = JSON.parse((await safeFetch(advert.detail_uri, { headers: { accept: 'application/json' } }, { timeoutMs: 15_000, maxResponseBytes: 256 * 1024 })).text); } catch (e) { manifest = { error: e instanceof Error ? e.message : String(e) }; }
        }
```
and include `manifest` in the JSON block and a "**Manifest:** fetched / none" line in the markdown.

- [ ] **Step 6: Snapshot, counts, tests, PR 3**

Add `'vector_marketplace_get_job'`, `'vector_marketplace_send_job'`, `'vector_marketplace_verify_receipt'` to `EXPECTED_TOOLS` (alphabetical). Then:
```bash
npm run build && node packages/builder/scripts/regen-tool-schemas.mjs && npm run typecheck && npm run test:unit && npm run test:smoke
```
Expected: `wrote 33 tool schemas`, all green. Update README (33, list the three) and `server.json`.
```bash
git add -A && git commit -m "feat(marketplace): send job, poll job, verify receipt behind safeFetch"
git push -u upstream feat/marketplace-transport
gh pr create --repo Apex-Fusion/mcp-server --base feat/marketplace-build-tools --head feat/marketplace-transport \
  --title "Marketplace transport: send job, poll job, verify receipt (safeFetch)" --reviewer <reviewer handle> \
  --body "Stacked on PR 2. First outbound calls to supplier URLs on the public server, all through safeFetch: https only, private ranges refused after DNS resolution, 1 MB out / 2 MB in, 90 s budget, no redirects. Receipt verification is the template's strict five-check version with CML Ed25519. Routes pinned from agents-marketplace main in a test.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## PR 4: installable signer with keygen

### Task 10: keygen subcommand and publishable package

**Files:**
- Create: `packages/signer/src/keygen.ts`
- Modify: `packages/signer/src/index.ts` (dispatch before loading config), `packages/signer/package.json`, `packages/signer/README.md`
- Test: `packages/signer/test/keygen.test.ts`

**Interfaces:**
- Produces: `generateKey(): { privateKeyBech32: string; address: string; pubKeyHash: string }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/signer/test/keygen.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';
import { generateKey } from '../src/keygen.ts';

describe('keygen', () => {
  test('produces a bech32 ed25519 key and the matching mainnet enterprise address', () => {
    const k = generateKey();
    assert.match(k.privateKeyBech32, /^ed25519_sk1/);
    assert.match(k.address, /^addr1v/);
    const sk = CML.PrivateKey.from_bech32(k.privateKeyBech32);
    assert.equal(sk.to_public().hash().to_hex(), k.pubKeyHash);
    assert.equal(CML.Address.from_bech32(k.address).payment_cred()!.as_pub_key()!.to_hex(), k.pubKeyHash);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --import tsx --test packages/signer/test/keygen.test.ts` Expected: FAIL, module not found.

- [ ] **Step 3: Write keygen**

```ts
// packages/signer/src/keygen.ts
// Fresh raw Ed25519 key for a member's local signer. Prints to stdout; writes nothing.
import * as CML from '@anastasia-labs/cardano-multiplatform-lib-nodejs';

export function generateKey(): { privateKeyBech32: string; address: string; pubKeyHash: string } {
  const sk = CML.PrivateKey.generate_ed25519();
  const pkh = sk.to_public().hash();
  const address = CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(pkh)).to_address().to_bech32();
  return { privateKeyBech32: sk.to_bech32(), address, pubKeyHash: pkh.to_hex() };
}

export function printKeygen(): void {
  const k = generateKey();
  process.stdout.write([
    '# Paste these two lines into the signer\'s env in your MCP client config. Keep the key private.',
    `VECTOR_SIGNER_PRIVATE_KEY=${k.privateKeyBech32}`,
    `VECTOR_SIGNER_ADDRESS=${k.address}`,
    '',
    `# Send this address (only this) to whoever funds your key: ${k.address}`,
    '',
  ].join('\n'));
}
```
In `packages/signer/src/index.ts`, before `const config = loadConfig();` add:
```ts
import { printKeygen } from './keygen.js';
if (process.argv[2] === 'keygen') { printKeygen(); process.exit(0); }
```

- [ ] **Step 4: Make the package publishable**

In `packages/signer/package.json`: remove `"private": true`; add `"files": ["build", "README.md"]`, `"publishConfig": { "access": "public" }`, `"repository": { "type": "git", "url": "https://github.com/Apex-Fusion/mcp-server.git", "directory": "packages/signer" }`, `"license": "Apache-2.0"`. In `packages/signer/README.md` add a section "Install with npx" showing:
```json
{
  "mcpServers": {
    "vector-signer": {
      "command": "npx",
      "args": ["-y", "@apexfusion/vector-mcp-signer"],
      "env": { "VECTOR_SIGNER_PRIVATE_KEY": "ed25519_sk1…", "VECTOR_SIGNER_ADDRESS": "addr1v…" }
    }
  }
}
```
and `npx -y @apexfusion/vector-mcp-signer keygen` as the first step.

- [ ] **Step 5: Run tests, smoke, commit, PR 4**

```bash
cd "<workspace>/vector-agentic-framework/mcp-server/wt-marketplace-read"
git worktree add "../wt-signer-npx" -b feat/signer-npx upstream/main && cd "../wt-signer-npx" && npm ci
node --import tsx --test packages/signer/test/keygen.test.ts && npm run build && npm run test:smoke:signer && npm run typecheck
git add -A && git commit -m "feat(signer): keygen subcommand and publishable package"
git push -u upstream feat/signer-npx
gh pr create --repo Apex-Fusion/mcp-server --base main --head feat/signer-npx --title "Signer: npx install and keygen" --reviewer <reviewer handle> \
  --body "Removes private:true, adds files/publishConfig, and a keygen subcommand that prints a fresh bech32 Ed25519 key and its mainnet enterprise address. Publishing to npm under @apexfusion needs an owner with rights to the scope (open item).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```
Expected: PR opened; publishing itself is a human step (`npm publish --workspace=@apexfusion/vector-mcp-signer`) once the scope owner logs in.

---

## Integration (first-party, before any deploy)

### Task 11: Local end-to-end against mainnet, no outsider

Run after Plan B's Agent History advert exists and the Foundation's ecosystem lead has funded the test buyer key.

- [ ] **Step 1: Start the builder locally with the mainnet `.env` from the transport worktree**

```bash
cd "<workspace>/vector-agentic-framework/mcp-server/wt-marketplace-transport" && npm run build && PORT=3300 node packages/builder/build/index.js
```
Expected: stderr shows "listening on port 3300".

- [ ] **Step 2: Run the hire script from Plan B** (`vector-service-agents/scripts/e2e-hire.mjs`, Task B6) against `http://localhost:3300/mcp` with the local signer. Expected: a VERIFIED receipt and a confirmed Accept. Record the escrow ref and tx hashes in `vector-service-agents/docs/E2E.md`.

---

## Self-review notes

- Spec coverage: §5.1 → Task 3; §5.2 → Tasks 4, 5, 6; §5.3 → Tasks 7, 8, 9; §5.4 → Task 10; §6 constants → Task 2; §10 tests → every task; §11 steps 1 and 2 → Tasks 1 to 6.
- Deviation from spec §5.2 "golden test byte-match": Lucid's `Data.to` frames lists differently from the marketplace's cbor-x encoder, so the test pins field-level decode plus semantic re-encode equality, and the floor test pins the lock amount within 0.1/0.2 units of the live lock. The validator compares datum fields, not bytes.
- Accept and Reclaim assembly is covered only by the first-party E2E (script evaluation is delegated to Ogmios, which the offline fixture cannot do). Named in Task 5 Step 4 and Task 11.
- Review Focus items 1 to 5 are pinned in Tasks 8, 5, 7, 9, 4 respectively.
