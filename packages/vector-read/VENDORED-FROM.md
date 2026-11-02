`src/datum.ts` is vendored from Apex-Fusion/mcp-server `packages/builder/src/vector/marketplace-datum.ts`
at commit `ef374f8` (`ef374f878f7ac8f44eb32c68b0be12a1d2f63de3`, committed on 2026-11-02 at 19:18:59 +0100). It is not a merge commit: it is the head of the branch `feat/identity-registry`, which is not merged into main. The pin before it was `94b8f41`, the head of PR 2 of the marketplace series ([Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21), merged into main on 2026-10-14). When the branch is merged, re-vendor from the merge commit.
`src/identity-codec.ts` is the second file of that source: `packages/builder/src/vector/identity-codec.ts` at the same commit, copied whole. `src/datum.ts` imports it (`./identity-codec.js`). The package exports it as the subpath `@vsa/vector-read/identity-codec` and not from its index: its names (`decodeIdentityDatum`, `encodeIdentityDatum`, `decodeLegacyDatum`, `plutusAddressFromBech32`, `plutusAddressToBech32`, `IdentityDatum`, `PlutusAddress` and others) are also the names of the agents-marketplace codecs that `src/identity.ts` re-exports (Identity codecs, below), and its `plutusAddressToBech32` takes other arguments. The vendored copies of `packages/buyer-core` import it through that subpath.
`src/safe-fetch.ts` is vendored from `packages/builder/src/vector/safe-fetch.ts`, which came with
PR 3 of the series (merged into main on 2026-10-14). The golden tests in `test/datum.test.ts` are the same tests; a change in one
repo must pass in both.

`src/safe-fetch.ts` was hardened here first (byte cap enforced while the body streams, caller abort signal kept): PR 3 vendors this file and its tests from this repo's commit, after which this note is updated with the mcp-server commit hash.

A second round of hardening is in the same file, again made here first: the host lookup runs inside the time budget, the brackets of an IPv6 literal are stripped so that a literal is judged directly, and `isPrivateAddress` reads every spelling of an IPv6 address. The exports, the options and the defaults are unchanged. Re-vendor from the commit that carries it (`fix(vector-read): safeFetch lookup inside the budget, IPv6 literals and non-canonical forms`) and port the tests with it.

A third round is in the same file, again made here first: `isPrivateAddress` also refuses the IPv4 ranges 192.0.0.0/24, 198.18.0.0/15, 224.0.0.0/4 and 240.0.0.0/4, and with them the same ranges inside an IPv4-mapped or NAT64 address. The exports, the options and the defaults are unchanged. Re-vendor from the commit that carries it (`fix: e2e passes buyerAddress; verdict wording; safeFetch IPv4 reserved ranges; guard fixes`) and port the tests with it. The tests that read `specs/agent-history.md` stay here.

## Provenance

| Here | Source | Pin | Edits |
|---|---|---|---|
| `src/datum.ts`, above the marker comment | `packages/builder/src/vector/marketplace-datum.ts` | `ef374f8` on branch `feat/identity-registry` (not a merge commit). **Update to the merge commit when that branch is merged.** | None. Byte-identical to the blob at the pin (the `cmp` command below). Against `94b8f41` it adds `sha256BytesHex` (at `651ae93`) and the identity layouts of the drain (did:vector Part 2, sections 6.1, 6.2 and 6.5): the 16-field escrow and the 14-field advert (`IdentityEscrowDatum`, `IdentityAdvertDatum`, `Refund`), their decoders and encoders (`decodeIdentityEscrowDatum`, `encodeIdentityEscrowDatum`, `identityEscrowDatumToData`, `decodeIdentityAdvertDatum`, `encodeIdentityAdvertDatum`), the decoders of either layout by field count (`decodeAnyEscrowDatum`, `decodeAnyAdvertDatum`, `AnyEscrowDatum`, `AnyAdvertDatum`), and the lock floor of the identity escrow (`identityEscrowLockFloor`, sized with `plutusDataMaxBytes`). `advertTextFieldsRoundTrip` also reads the 14-field advert. Against the PR 1 blob (`4a7b223`) the earlier pin added the safe-integer check on the advert's two sizes (`asSafeInt`), the exported `advertTextFieldsRoundTrip`, and the min-UTxO wording of one comment. No import-path adjustment is needed: the source imports `@lucid-evolution/lucid`, `node:crypto` and `./identity-codec.js` (the next row), and nothing from its constants module. |
| `src/identity-codec.ts` | `packages/builder/src/vector/identity-codec.ts` | `ef374f8` | None. Byte-identical to the blob at the pin (sha256 `496b754f2f0a127c3a30aca0ba98c065b6efc4c5e185dca058b48477d543b527`). The Plutus Data codecs of the identity registry (the record, the legacy record, the mint and spend redeemers), of attestations, delegations and vaults, and the Plutus Data address. It imports only `@lucid-evolution/lucid`. |
| `src/datum.ts`, below the marker comment | local | n/a | `decodeStakeDatum`, `topLevelBytes`, `blake2b224Hex`. Not in the source; keep them when re-vendoring. The legacy registry record is read with the vendored `decodeLegacyDatum` (Identity codecs, below), not with a local decoder. |
| `src/safe-fetch.ts` | `packages/builder/src/vector/safe-fetch.ts` (PR 3 of the series; the file does not exist at `4a7b223`) | The build-time specification text, which has no commit. **Replace with the merge commit and record its hash when this file is next re-vendored (PR 3 merged into main on 2026-10-14).** | Transcribed from the build-time specification text, then hardened here first: the body is read through a reader with a running byte cap (cancelled on overflow) after a `content-length` pre-check; a caller `init.signal` is combined with the timeout via `AbortSignal.any`; the residual-risk comment sits above the DNS check. Second round: the timeout signal is created first and the host lookup is raced against it (a stalled resolver is cut at `timeoutMs` with the same `TimeoutError`; the caller's own signal still reaches `fetch` as before); the brackets of an IPv6 literal are stripped before `isIP`; `isPrivateAddress` expands an IPv6 address to its eight groups before classifying it, so that the mapped (`::ffff:10.0.0.1`), compatible (`::10.0.0.1`) and NAT64 (`64:ff9b::a00:1`) forms count as the IPv4 address they carry and site-local (`fec0::/10`) and multicast (`ff00::/8`) are refused. Third round: `isPrivateV4` also takes the third octet and refuses 192.0.0.0/24 (IETF protocol), 198.18.0.0/15 (benchmarking), 224.0.0.0/4 (multicast) and 240.0.0.0/4 (class E, the broadcast address included), so the same ranges are refused inside a mapped or NAT64 address too; the header comment says which IPv6 forms count as the IPv4 address inside them (`::ffff:0:0/96` and `64:ff9b::/96`; all of `::/96` is refused). Rules for https, credentials, redirects and the cap, defaults and exports unchanged. |
| `test/fixtures/marketplace.fixture.ts` | `packages/builder/test/fixtures/marketplace.fixture.ts` | `ef374f8` | None. Byte-identical (unchanged since `4a7b223`). |
| `test/datum.test.ts` | `packages/builder/test/marketplace-datum.test.ts` | `ef374f8` | The source tests ported from `node:test` to vitest, assertion meaning kept: the 13 of `4a7b223` and what PR 2 added (the safe-integer range test, the two Lucid-compact framing tests, the 65,535-byte header case and the `too long` check, and the six `advertTextFieldsRoundTrip` tests). Since `94b8f41` the source changed one regex escape (`advert\\.` in the safe-integer test), ported. Two tests of the first port that the source has since dropped as redundant are kept here (the semantic-equality test and the two lock-floor bounds). Local: the registry, stake and `topLevelBytes` tests, a `blake2b224Hex` known-answer test, the `sha256BytesHex` known answers (moved from `packages/buyer-core`, which defined the function in `src/hashes.ts` until this re-vendor), the identity layouts on the terms of the live escrow and advert (round trips, the refusals of the other field count, `decodeAnyEscrowDatum` and `decodeAnyAdvertDatum`, the `agent_id` checks of the encoders, `advertTextFieldsRoundTrip` with 14 fields, and `identityEscrowLockFloor` against the economic total and the legacy floor), and the escrow output minimum of the four service agents. |
| `test/identity-codec.test.ts` | `packages/builder/test/identity-codec.test.ts` | `ef374f8` | The source tests ported from `node:test` to vitest, assertion meaning kept: every datum of the fixture file decodes and encodes back to its bytes, every redeemer encodes to its bytes, the refusals of the decoders, the address, text and signer helpers, and the identity escrow lock floor. `OWN_ADDRESS`, which the source imports from its fixture provider, is written out. The fixture file is `test/fixtures/identity-cbor-fixtures.json`, the same file as the source's `packages/builder/test/fixtures/identity-cbor-fixtures.json` (sha256 `4a7bf768af8d9cac859024016eddfc0b29c079b659a47650b69c5f4efc449486`; both are copies of the agents-marketplace fixture, see Identity codecs). |
| `test/safe-fetch.test.ts` | `packages/builder/test/safe-fetch.test.ts` (from the build-time specification text) | n/a | The 6 tests ported to vitest. Local: a success-path test that also pins `redirect: 'manual'`, an IP-literal test, and the hardening tests (streamed cap with pull count and cancel, `content-length` pre-check, exact-cap boundary, null body and multi-byte text split across chunks, caller signal and timeout), and a test that `specs/agent-history.md` lists the refusals of `safeFetch` by name and that the code refuses each. Second round: the lookup inside the budget (a stalled, a slow and a late-failing resolver), IPv6 literals with no lookup, the spellings of an IPv6 address, and a caller `redirect: 'follow'` that cannot defeat `redirect: 'manual'`. Third round: one test for each of the four IPv4 ranges (first and last address, the public neighbour, and the mapped and NAT64 forms), one through `safeFetch` (a literal host and a looked-up one), and the spec-row tests extended to the new kinds and to the exact sentence about the IPv4 address inside an IPv6 one. |

The header comments inside the vendored files still name their source paths. They are kept so a diff against the source shows only the local additions.

## Re-vendoring

1. Take the new pin (a commit of Apex-Fusion/mcp-server) and replace the vendored part of each file with the blob at that pin, never with a working file of a CRLF checkout:
   `git -C <mcp-server> cat-file blob <pin>:packages/builder/src/vector/marketplace-datum.ts` for `src/datum.ts` above the marker, and
   `git -C <mcp-server> cat-file blob <pin>:packages/builder/src/vector/identity-codec.ts` for the whole of `src/identity-codec.ts`.
2. Keep the local additions below the marker comment in `src/datum.ts`.
3. If the datum module now imports another file of its folder, copy that file next to it in `src/`, whole, and add its row.
4. Port any new or changed source tests to `test/datum.test.ts` and `test/identity-codec.test.ts`.
5. Run `pnpm --filter @vsa/vector-read test` here and the builder tests there. Both must pass.
6. Update the pin column above. Then re-vendor `packages/buyer-core` at the same pin: its copies import both files (see `packages/buyer-core/VENDORED-FROM.md`).

Check that the vendored parts are still byte-identical to their pin (bash, from the repository root; the pin is `ef374f8` today). Each command prints nothing when the copy is right. For `src/datum.ts` the cut is at the marker comment, whatever the line count: `sed` drops the marker and everything below it, and the second `sed` drops the one blank separator line above the marker.

```bash
git -C <mcp-server> cat-file blob ef374f8:packages/builder/src/vector/marketplace-datum.ts | cmp - <(sed '/^\/\/ ---- Local additions/,$d' packages/vector-read/src/datum.ts | sed '$d')
git -C <mcp-server> cat-file blob ef374f8:packages/builder/src/vector/identity-codec.ts | cmp - packages/vector-read/src/identity-codec.ts
git -C <mcp-server> cat-file blob ef374f8:packages/builder/test/fixtures/marketplace.fixture.ts | cmp - packages/vector-read/test/fixtures/marketplace.fixture.ts
git -C <mcp-server> cat-file blob ef374f8:packages/builder/test/fixtures/identity-cbor-fixtures.json | cmp - packages/vector-read/test/fixtures/identity-cbor-fixtures.json
```

## Identity codecs, from Apex-Fusion/agents-marketplace

The files under `src/vendored/shared/` are copies of files of Apex-Fusion/agents-marketplace `packages/shared/src/` at commit `b5d66a6` (`b5d66a6437b390f525dfe00d989499ac5e339e04`, the head of branch `feat/identity-registry` on 2026-11-02). `test/fixtures/identity-cbor-fixtures.json` is a copy of `contracts/identity-marketplace/fixtures/cbor-fixtures.json` at the same commit: the Plutus Data CBOR that the Aiken types themselves serialise. Each copy was taken from the blob, `git -C <agents-marketplace> cat-file blob b5d66a6:<path>`, never from a working file.

They give the services the identity registry record (`IdentityDatum`) and the legacy registry record (`LegacyDatum`) of did:vector Part 1 section 5, the canonical Plutus Data encoder and strict decoder those records are hashed and compared with, the DID strings of Part 1 section 3 (`vectorDid`, `legacyVectorDid`, `parseVectorDid`), the key hash, and the purpose and rights values. `src/identity.ts` re-exports them and adds the local part: the two registries, the authenticity test of a record output and `activeKey`, the `active_key` of the `vector_identity` library.

| destination | source | commit | sha256 |
|---|---|---|---|
| `src/vendored/shared/cbor/plutus-data.ts` | `agents-marketplace:packages/shared/src/cbor/plutus-data.ts` | `b5d66a6` | `b9e9e1ffcba946ceeddf711547c0a7d57c4e0a316119eb0bf523a3f441844d4e` |
| `src/vendored/shared/cbor/plutus-schema.ts` | `agents-marketplace:packages/shared/src/cbor/plutus-schema.ts` | `b5d66a6` | `e02ee3bdbaa5e6e73a31b05e642083a65fdc85453040db7783eef3bf6902ed55` |
| `src/vendored/shared/cbor/address.ts` | `agents-marketplace:packages/shared/src/cbor/address.ts` | `b5d66a6` | `e1c526bb9bc19f38302901fce49c3128106d1b09e85f4b9146567626e6d0d7af` |
| `src/vendored/shared/cbor/IdentityDatum.ts` | `agents-marketplace:packages/shared/src/cbor/IdentityDatum.ts` | `b5d66a6` | `146b6d92782f1163ae20a27de51d287465049222227f7e8fc5eae5a4d4ccc9b3` |
| `src/vendored/shared/identity/id.ts` | `agents-marketplace:packages/shared/src/identity/id.ts` | `b5d66a6` | `4cb0dfb0da048bd77f1c508b1e4a42027a072e6e9676f7da2741592e680b09be` |
| `src/vendored/shared/identity/constants.ts` | `agents-marketplace:packages/shared/src/identity/constants.ts` excerpt, lines 6-68 | `b5d66a6` | `0b142e7c0471be38d68db4c1681bbae6c7f5432856ec3eef72fb9cf1592b5b34` |
| `src/vendored/shared/network.ts` | `agents-marketplace:packages/shared/src/network.ts` excerpt, line 16 | `b5d66a6` | `407d7b71f2f8345e40e82348ccfbebdf76fed03fd191661c94fe19f82e2129f6` |
| `src/vendored/shared/chain/ChainProvider.ts` | `agents-marketplace:packages/shared/src/chain/ChainProvider.ts` excerpt, line 14 | `b5d66a6` | `98ea97d44254ace46fe098baec870f2acd982694dd699dd0f03368ce71b577c5` |
| `test/fixtures/identity-cbor-fixtures.json` | `agents-marketplace:contracts/identity-marketplace/fixtures/cbor-fixtures.json` | `b5d66a6` | `4a7bf768af8d9cac859024016eddfc0b29c079b659a47650b69c5f4efc449486` |

`test/vendored.test.ts` checks this table in both directions: every row names a file whose sha256 matches, and every file under `src/vendored/` has a row.

No line of a copy is rewritten. The copies keep the folder layout of `packages/shared/src/`, so their relative imports (`./plutus-data.js`, `../cbor/IdentityDatum.js`, `../network.js`, `../chain/ChainProvider.js`) find the copies as they are. The TypeScript settings of this repository resolve the `.js` specifiers to the `.ts` files, and so do vitest and tsx. `address.ts` imports `bech32`, a dependency of this package for that reason, and `id.ts` imports `@noble/hashes/blake2b`.

Three copies are excerpts, whole lines of the source in their order:

- `identity/constants.ts`: lines 6-68 of 77, the import of `Role` and the purpose, rights, time and limit values. Left out: the header comment (lines 1-5), whose section range holds an en dash, and the amounts (lines 69-77), whose comments name the ledger's native unit, which `scripts/specs.test.mjs` refuses in every file of this repository but `docs/HIRE.md`.
- `network.ts`: line 16 of 58, the `NetworkId` type that `address.ts` imports. The rest are the network parameters and slot conversions of the marketplace builders.
- `chain/ChainProvider.ts`: line 14 of 96, the `OutputReference` type that `plutus-schema.ts` imports. Its comment (line 13) holds an em dash; the rest is the chain interface of the marketplace builders.

The other five copies and the fixture are byte-identical to their blobs. Not copied: the escrow, advert, attestation, delegation and vault codecs, the identity redeemers, the allowlist tree and the rest of `packages/shared`. Nothing here reads them.

Check the copies against the pin (bash, from the repository root): the first command prints nothing for each byte-identical copy, and the excerpts are cut the same way.

```bash
for f in cbor/plutus-data.ts cbor/plutus-schema.ts cbor/address.ts cbor/IdentityDatum.ts identity/id.ts; do git -C <agents-marketplace> cat-file blob b5d66a6:packages/shared/src/$f | cmp - packages/vector-read/src/vendored/shared/$f; done
git -C <agents-marketplace> cat-file blob b5d66a6:packages/shared/src/identity/constants.ts | sed -n '6,68p' | cmp - packages/vector-read/src/vendored/shared/identity/constants.ts
git -C <agents-marketplace> cat-file blob b5d66a6:packages/shared/src/network.ts | sed -n '16p' | cmp - packages/vector-read/src/vendored/shared/network.ts
git -C <agents-marketplace> cat-file blob b5d66a6:packages/shared/src/chain/ChainProvider.ts | sed -n '14p' | cmp - packages/vector-read/src/vendored/shared/chain/ChainProvider.ts
git -C <agents-marketplace> cat-file blob b5d66a6:contracts/identity-marketplace/fixtures/cbor-fixtures.json | cmp - packages/vector-read/test/fixtures/identity-cbor-fixtures.json
```

Re-vendoring:

1. Take the new pin, a commit of Apex-Fusion/agents-marketplace that holds the identity codecs.
2. Copy each row again from the blob at the pin. Before an excerpt is cut again, check that its line range still holds the same code, and that the lines left out still name the unit or hold a dash.
3. If a copy now imports a file that is not here, copy that file too (or the lines of it that are needed), at the same relative path, and add its row.
4. Recompute the sha256 column (`sha256sum`) and update the commit column and this section.
5. Run `pnpm --filter @vsa/vector-read test` and `pnpm typecheck`. `test/identity.test.ts` decodes and encodes again the identity and legacy records of the fixture file, byte for byte, and checks the identifier and DNS-safe test vectors of Part 1 section 3.
