`src/datum.ts` is vendored from Apex-Fusion/mcp-server `packages/builder/src/vector/marketplace-datum.ts`
at commit `94b8f41`, the head of PR 2 of the marketplace series ([Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21), open, stacked on #20). Replace the pin with the merge commit when the PRs merge.
`src/safe-fetch.ts` is vendored from `packages/builder/src/vector/safe-fetch.ts`, which arrives with
PR 3 of the series. The golden tests in `test/datum.test.ts` are the same tests; a change in one
repo must pass in both.

`src/safe-fetch.ts` was hardened here first (byte cap enforced while the body streams, caller abort signal kept): PR 3 vendors this file and its tests from this repo's commit, after which this note is updated with the mcp-server commit hash.

A second round of hardening is in the same file, again made here first: the host lookup runs inside the time budget, the brackets of an IPv6 literal are stripped so that a literal is judged directly, and `isPrivateAddress` reads every spelling of an IPv6 address. The exports, the options and the defaults are unchanged. Re-vendor from the commit that carries it (`fix(vector-read): safeFetch lookup inside the budget, IPv6 literals and non-canonical forms`) and port the tests with it.

## Provenance

| Here | Source | Pin | Edits |
|---|---|---|---|
| `src/datum.ts`, above the marker comment | `packages/builder/src/vector/marketplace-datum.ts` | `94b8f41` on branch `feat/marketplace-build-tools` (PR 2, pre-merge). **Update to the merge commit when PR 2 merges.** | None. Byte-identical to the blob at the pin (the `cmp` command below). Against the PR 1 blob (`4a7b223`) it adds the safe-integer check on the advert's two sizes (`asSafeInt`), the exported `advertTextFieldsRoundTrip`, and the min-UTxO wording of one comment. No import-path adjustment was needed: the source imports only `@lucid-evolution/lucid` and `node:crypto`, and nothing from its constants module. |
| `src/datum.ts`, below the marker comment | local | n/a | `decodeRegistryDatum`, `decodeStakeDatum`, `topLevelBytes`, `blake2b224Hex`. Not in the source; keep them when re-vendoring. |
| `src/safe-fetch.ts` | `packages/builder/src/vector/safe-fetch.ts` (PR 3 of the series; the file does not exist at `4a7b223`) | Plan A Task 7 Step 3 text. **Replace with the PR 3 commit and record its hash when PR 3 merges.** | Transcribed from the Plan A text, then hardened here first: the body is read through a reader with a running byte cap (cancelled on overflow) after a `content-length` pre-check; a caller `init.signal` is combined with the timeout via `AbortSignal.any`; the residual-risk comment sits above the DNS check. Second round: the timeout signal is created first and the host lookup is raced against it (a stalled resolver is cut at `timeoutMs` with the same `TimeoutError`; the caller's own signal still reaches `fetch` as before); the brackets of an IPv6 literal are stripped before `isIP`; `isPrivateAddress` expands an IPv6 address to its eight groups before classifying it, so that the mapped (`::ffff:10.0.0.1`), compatible (`::10.0.0.1`) and NAT64 (`64:ff9b::a00:1`) forms count as the IPv4 address they carry and site-local (`fec0::/10`) and multicast (`ff00::/8`) are refused. Rules, defaults and exports unchanged. |
| `test/fixtures/marketplace.fixture.ts` | `packages/builder/test/fixtures/marketplace.fixture.ts` | `94b8f41` | None. Byte-identical (unchanged since `4a7b223`). |
| `test/datum.test.ts` | `packages/builder/test/marketplace-datum.test.ts` | `94b8f41` | The source tests ported from `node:test` to vitest, assertion meaning kept: the 13 of `4a7b223` and what PR 2 added (the safe-integer range test, the two Lucid-compact framing tests, the 65,535-byte header case and the `too long` check, and the six `advertTextFieldsRoundTrip` tests). Two tests of the first port that the source has since dropped as redundant are kept here (the semantic-equality test and the two lock-floor bounds). Local: the registry, stake and `topLevelBytes` tests, a `blake2b224Hex` known-answer test, and the escrow output minimum of the four service agents. |
| `test/safe-fetch.test.ts` | `packages/builder/test/safe-fetch.test.ts` (Plan A Task 7 Step 1) | n/a | The 6 tests ported to vitest. Local: a success-path test that also pins `redirect: 'manual'`, an IP-literal test, and the hardening tests (streamed cap with pull count and cancel, `content-length` pre-check, exact-cap boundary, null body and multi-byte text split across chunks, caller signal and timeout), and a test that `specs/agent-history.md` lists the refusals of `safeFetch` by name and that the code refuses each. Second round: the lookup inside the budget (a stalled, a slow and a late-failing resolver), IPv6 literals with no lookup, the spellings of an IPv6 address, and a caller `redirect: 'follow'` that cannot defeat `redirect: 'manual'`. |

The header comments inside the vendored files still name their source paths. They are kept so a diff against the source shows only the local additions.

## Re-vendoring

1. Take the new pin (a commit of Apex-Fusion/mcp-server) and replace the vendored part of each file with the blob at that pin. For the datum module:
   `git -C <mcp-server> show <pin>:packages/builder/src/vector/marketplace-datum.ts`
2. Keep the local additions below the marker comment in `src/datum.ts`.
3. Port any new or changed source tests to `test/datum.test.ts`.
4. Run `pnpm --filter @vsa/vector-read test` here and the builder tests there. Both must pass.
5. Update the pin column above.

Check that the vendored part is still byte-identical to its pin (bash; the pin is `94b8f41` today). The cut is at the marker comment, not at a line count: `sed` drops the marker and everything below it, and the second `sed` drops the one blank separator line above the marker.
`git -C <mcp-server> show 94b8f41:packages/builder/src/vector/marketplace-datum.ts | cmp - <(sed '/^\/\/ ---- Local additions/,$d' packages/vector-read/src/datum.ts | sed '$d')`

The fixture is checked the same way: `git -C <mcp-server> show 94b8f41:packages/builder/test/fixtures/marketplace.fixture.ts | cmp - packages/vector-read/test/fixtures/marketplace.fixture.ts`.
