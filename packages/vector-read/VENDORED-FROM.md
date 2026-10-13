`src/datum.ts` is vendored from Apex-Fusion/mcp-server `packages/builder/src/vector/marketplace-datum.ts`
at the commit of PR 1 of the marketplace series (fill the commit hash here when PR 1 merges).
`src/safe-fetch.ts` is vendored from `packages/builder/src/vector/safe-fetch.ts`, which arrives with
PR 3 of the series. The golden tests in `test/datum.test.ts` are the same tests; a change in one
repo must pass in both.

`src/safe-fetch.ts` was hardened here first (byte cap enforced while the body streams, caller abort signal kept): PR 3 vendors this file and its tests from this repo's commit, after which this note is updated with the mcp-server commit hash.

## Provenance

| Here | Source | Pin | Edits |
|---|---|---|---|
| `src/datum.ts`, above the marker comment | `packages/builder/src/vector/marketplace-datum.ts` | `4a7b223` on branch `feat/marketplace-read-tools` (PR 1, pre-merge). **Update to the PR 1 merge commit when it merges.** | None. Byte-identical to the blob at the pin. No import-path adjustment was needed: the source imports only `@lucid-evolution/lucid` and `node:crypto`, and nothing from its constants module. |
| `src/datum.ts`, below the marker comment | local | n/a | `decodeRegistryDatum`, `decodeStakeDatum`, `topLevelBytes`, `blake2b224Hex`. Not in the source; keep them when re-vendoring. |
| `src/safe-fetch.ts` | `packages/builder/src/vector/safe-fetch.ts` (PR 3 of the series; the file does not exist at `4a7b223`) | Plan A Task 7 Step 3 text. **Replace with the PR 3 commit and record its hash when PR 3 merges.** | Transcribed from the Plan A text, then hardened here first: the body is read through a reader with a running byte cap (cancelled on overflow) after a `content-length` pre-check; a caller `init.signal` is combined with the timeout via `AbortSignal.any`; the residual-risk comment sits above the DNS check. Rules, defaults and exports unchanged. |
| `test/fixtures/marketplace.fixture.ts` | `packages/builder/test/fixtures/marketplace.fixture.ts` | `4a7b223` | None. Byte-identical. |
| `test/datum.test.ts` | `packages/builder/test/marketplace-datum.test.ts` | `4a7b223` | The 13 tests ported from `node:test` to vitest, assertion meaning kept. Local: the registry, stake and `topLevelBytes` tests, and a `blake2b224Hex` known-answer test. |
| `test/safe-fetch.test.ts` | `packages/builder/test/safe-fetch.test.ts` (Plan A Task 7 Step 1) | n/a | The 6 tests ported to vitest. Local: a success-path test that also pins `redirect: 'manual'`, an IP-literal test, and the hardening tests (streamed cap with pull count and cancel, `content-length` pre-check, exact-cap boundary, null body and multi-byte text split across chunks, caller signal and timeout). |

The header comments inside the vendored files still name their source paths. They are kept so a diff against the source shows only the local additions.

## Re-vendoring

1. Take the new pin (a commit of Apex-Fusion/mcp-server) and replace the vendored part of each file with the blob at that pin. For the datum module:
   `git -C <mcp-server> show <pin>:packages/builder/src/vector/marketplace-datum.ts`
2. Keep the local additions below the marker comment in `src/datum.ts`.
3. Port any new or changed source tests to `test/datum.test.ts`.
4. Run `pnpm --filter @vsa/vector-read test` here and the builder tests there. Both must pass.
5. Update the pin column above.

Check that the vendored part is still byte-identical to its pin (bash). The cut is at the marker comment, not at a line count: `sed` drops the marker and everything below it, and the second `sed` drops the one blank separator line above the marker.
`git -C <mcp-server> show <pin>:packages/builder/src/vector/marketplace-datum.ts | cmp - <(sed '/^\/\/ ---- Local additions/,$d' packages/vector-read/src/datum.ts | sed '$d')`
