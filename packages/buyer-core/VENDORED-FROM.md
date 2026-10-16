# Vendored from Apex-Fusion/mcp-server and Apex-Fusion/agents-marketplace

The files under `src/vendored/mcp/`, `src/vendored/mcp-shared/` and `src/vendored/signer/` and the four files under `test/fixtures/` are copies of files of Apex-Fusion/mcp-server at commit `651ae93` (`651ae93115661c198539f7d087fb4494b2b135ac`, the merge of PR #24 into main on 2026-10-14). The two files under `src/vendored/fleet/` are copies of files of Apex-Fusion/agents-marketplace at commit `e847a55` (`e847a553146516e574f3cadb6688d74dd4cf2b7b`, committed on 2026-10-13, the `origin/main` of the clone it was taken from on 2026-10-15).

Each copy was taken from the blob at its commit, `git -C <checkout> cat-file blob <commit>:<path>`. The mcp-server checkout it was copied from runs with `core.autocrlf=true`, so its working files are CRLF, while the blobs are LF and so is every checkout of this repository (`.gitattributes` says `eol=lf`). A `cp` of the working file would have recorded a sha256 that no checkout of this repository reproduces. Each working file was checked to equal its blob once CR is stripped. The agents-marketplace clone runs with `core.autocrlf=true` too, and its working tree is a stale branch while the copies come from `origin/main`: the two fleet files were taken from the blobs and no working file of that clone was read.

## Why vendored

The mcp-server packages are not published to a registry. The Document Pipeline agent (deployed since 2026-10-16) posts escrows, signs and submits transactions, reads escrow lineage and verifies receipts. It builds, reads and verifies with the same code the hosted keyless MCP server uses: the same datum codecs, the same builders, the same lineage resolver and the same receipt verifier. It signs with `sign.ts` of the member's local signer package (`packages/signer`). The hosted server never signs: it returns unsigned transactions, and the member's local signer signs them.

The datum codecs are not copied a second time. `@vsa/vector-read` carries `marketplace-datum.ts` (at `94b8f41`), and the copies here import it from there. Drift is caught twice: by `packages/vector-read/test/datum.test.ts` (the golden datum tests, the same as the source's) and by the sha256 column below, which `test/vendored.test.ts` checks in both directions: every row names a file whose sha256 matches, and every file under `src/vendored/` and `test/fixtures/` has a row.

The fleet is not published to a registry either. The Pipeline commits to the request of a fleet job and to its answer with the fleet's own Responses code, `responses.ts`: the normalisation of the request, the request commitment, the result commitment and the normalisation of the output. A copy of that code is what makes the hash computed here the hash a fleet supplier computes; a re-implementation could drift with no test noticing. `fleet/types.ts` is the one type that file imports, `ChatMessage`, with the one type `ChatMessage` refers to, `ToolCall` (see Deviation: four excerpts). The repository Apex-Fusion/agents-marketplace carries no LICENSE file (none at the root or anywhere else in its tree at `e847a55`). A build-time ruling: this is code of the same organisation's public repository, copied unchanged but for one import line, and the missing licence is flagged to the operator as a licence-hygiene item.

## Files

| destination | source | commit | sha256 |
|---|---|---|---|
| `src/vendored/mcp/marketplace-constants.ts` | `mcp-server:packages/builder/src/vector/marketplace-constants.ts` | `651ae93` | `94f025040f07d5eac19d93601922effd679aa4de515c25211db915b429a9d1ba` |
| `src/vendored/mcp/marketplace-shared.ts` | `mcp-server:packages/builder/src/vector/marketplace-shared.ts` | `651ae93` | `5d5b6c7bc297467d7f6cfb8cae20d3d7d0342a9655809900a730f488b977cbd6` |
| `src/vendored/mcp/marketplace-indexer.ts` | `mcp-server:packages/builder/src/vector/marketplace-indexer.ts` | `651ae93` | `636c451d492b07f05aa6908ce89240dfb0a1988cf9f4d976a2155f8d58cf813e` |
| `src/vendored/mcp/marketplace-lineage.ts` | `mcp-server:packages/builder/src/vector/marketplace-lineage.ts` | `651ae93` | `bbbcd0b62329741b8fff815db05ec363e2e1a7c2a3af86ef0cc2d633f3a8d3c3` |
| `src/vendored/mcp/marketplace-build.ts` | `mcp-server:packages/builder/src/vector/marketplace-build.ts` | `651ae93` | `6c031ce94ab1532f954ef38188a45a970daae51ecaf2d0088dc1ec01032087a6` |
| `src/vendored/mcp/marketplace-verify.ts` | `mcp-server:packages/builder/src/vector/marketplace-verify.ts` | `651ae93` | `3e6ed2dc48572fbc2a7b58fb9a58e43e9d1e7e42e0b96dae06b91ac023113cdb` |
| `src/vendored/mcp/marketplace-transport.ts` | `mcp-server:packages/builder/src/vector/marketplace-transport.ts` | `651ae93` | `f0e0679bfaf546f3a4328e06bd4260f2572baddbc558dde10bf5bbe16f3e0172` |
| `src/vendored/mcp/marketplace-supplier.ts` | `mcp-server:packages/builder/src/vector/marketplace-supplier.ts` | `651ae93` | `ba7fce947cda895e1beab9e85a9ebc5a4149a3377cb2dc1108f4b91abb4a727c` |
| `src/vendored/mcp/gov-build.ts` | `mcp-server:packages/builder/src/vector/gov-build.ts` excerpt, lines 1-13, 85-135, 151-175 | `651ae93` | `a76357abf1138210e7f3b871c75ba1ac8b67c138debaf6eb4dd195dc1a599f8d` |
| `src/vendored/mcp/build.ts` | `mcp-server:packages/builder/src/vector/build.ts` excerpt, lines 1-48 | `651ae93` | `73cdbd0d5a6c35c54b89452d0d4b1b2e062d898acbfc0443e993f3b2fd281a5e` |
| `src/vendored/mcp/rate-limiter.ts` | `mcp-server:packages/builder/src/vector/rate-limiter.ts` | `651ae93` | `4290366f2f28b2ea3229a1c1bd4c69b068453a1d7b8d7f168a801964e61e3e7b` |
| `src/vendored/mcp/env.ts` | `mcp-server:packages/builder/src/env.ts` | `651ae93` | `061feb39a1466bf6b984da8f2e17ca53acfc9deef9b404f6815663c94b9db67c` |
| `src/vendored/mcp-shared/provider.ts` | `mcp-server:packages/shared/src/provider.ts` | `651ae93` | `c7dc7f39af96498d984b6519eaccd55b0c8fc8d07bfdc37071a790df876f3689` |
| `src/vendored/mcp-shared/config.ts` | `mcp-server:packages/shared/src/config.ts` | `651ae93` | `4e1961be29545ff23978f51189c0ed47ca023e63af4ba2652e6ee89d00a4e089` |
| `src/vendored/mcp-shared/types.ts` | `mcp-server:packages/shared/src/types.ts` | `651ae93` | `9f46880afa0a792fee827c9e375bb93988fb5a6a5b1c4301e428a48fa31b551c` |
| `src/vendored/mcp-shared/tx.ts` | `mcp-server:packages/shared/src/tx.ts` excerpt, lines 1-2, 46-54 | `651ae93` | `99c38573e690fb26ea9bf13f7f630ce77277b773c8712a4ba7b6731e286acc72` |
| `src/vendored/signer/sign.ts` | `mcp-server:packages/signer/src/sign.ts` | `651ae93` | `aa97a7254fded5f6b6ac84e298e2aa5e0b3c7dd052731a295ae831a4f6f6f572` |
| `src/vendored/fleet/responses.ts` | `agents-marketplace:packages/shared/src/responses.ts` | `e847a55` | `04340e5cdc18da67de82dd373ef1a95d03d1ad597cfd77c5e0d3a2ec54aae657` |
| `src/vendored/fleet/types.ts` | `agents-marketplace:packages/shared/src/tx/types.ts` excerpt, lines 18-35 | `e847a55` | `da27cb19fd0357fa60df3058a7d4d0ad1f917588eef97798ab24ded80bf766d6` |
| `test/fixtures/escrow-koios.fixture.ts` | `mcp-server:packages/builder/test/fixtures/escrow-koios.fixture.ts` | `651ae93` | `a23549963e4c0c3832c7588bbacf49557fd79fb7833cd159b5484039b673cdc0` |
| `test/fixtures/marketplace.fixture.ts` | `mcp-server:packages/builder/test/fixtures/marketplace.fixture.ts` | `651ae93` | `883054c0ecf5b4e24401423236598d14a9ced2ae0a3ec0f6742db589972dc92d` |
| `test/fixtures/fixture-provider.ts` | `mcp-server:packages/builder/test/fixtures/fixture-provider.ts` | `651ae93` | `b47af52aa798cbab072c140e21cf1bd341728503d835b2285af6996f8a30fd8b` |
| `test/fixtures/protocol-params.fixture.json` | `mcp-server:packages/builder/test/fixtures/protocol-params.fixture.json` | `651ae93` | `13d850d95193029ed0c21d6cb1394d690fb882a8491250e751c3dc4dd27dba02` |

Byte-identical to the blob (no edit at all): `marketplace-constants.ts`, `marketplace-shared.ts`, `env.ts`, `provider.ts`, `types.ts`, `sign.ts`, `marketplace.fixture.ts`, `fixture-provider.ts`, `protocol-params.fixture.json`. The excerpts `gov-build.ts`, `tx.ts` and `fleet/types.ts` are byte-identical to their line ranges. Every other copy differs from its blob only on the lines listed below (`fleet/responses.ts`: line 1).

The header comments inside the copies still name their source paths, and a comment may speak of code the copy does not carry (the excerpts below). They are kept so that a diff against the source shows only the rewritten lines.

## Rewritten lines

Only import lines change, one line for one line, so a copy keeps the line numbers of its source (and a stack trace points at the same line in both). The kinds of rewrite:

- `@apexfusion/vector-mcp-shared/config`, `/types`, `/tx` become `../mcp-shared/config.js`, `../mcp-shared/types.js`, `../mcp-shared/tx.js`.
- `./marketplace-datum.js` (and the fixture's `../../src/vector/marketplace-datum.ts`) becomes `@vsa/vector-read`. Every name imported that way is exported by `packages/vector-read/src/datum.ts`; the one that is not, `sha256BytesHex`, comes from `src/hashes.ts`.
- `./safe-fetch.js` becomes `@vsa/vector-read`. The mcp-server's `safe-fetch.ts` at `651ae93` is vector-read's `src/safe-fetch.ts` (the mcp-server vendored it from this repository) plus one provenance comment line.
- `./tx/types.js` becomes `./types.js` (the fleet's `responses.ts`). The `ChatMessage` type it imports sits next to it here, in the excerpt `fleet/types.ts`; in the source it is `packages/shared/src/tx/types.ts`.

Per file (the line numbers are the same in the source and the copy):

`src/vendored/mcp/marketplace-indexer.ts`
- line 4: `import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';` becomes `import { VECTOR_KOIOS_URL } from '../mcp-shared/config.js';`
- line 6: `import { decodeAdvertDatum, formatOutRef, parseOutRef } from './marketplace-datum.js';` becomes `import { decodeAdvertDatum, formatOutRef, parseOutRef } from '@vsa/vector-read';`
- line 7: `import type { AdvertDatum } from './marketplace-datum.js';` becomes `import type { AdvertDatum } from '@vsa/vector-read';`

`src/vendored/mcp/marketplace-lineage.ts`
- line 7: `import { decodeEscrowDatum, encodeEscrowDatum, parseOutRef, formatOutRef } from './marketplace-datum.js';` becomes `import { decodeEscrowDatum, encodeEscrowDatum, parseOutRef, formatOutRef } from '@vsa/vector-read';`
- line 8: `import type { EscrowDatum, EscrowState } from './marketplace-datum.js';` becomes `import type { EscrowDatum, EscrowState } from '@vsa/vector-read';`

`src/vendored/mcp/marketplace-build.ts`
- line 7: `import { VECTOR_KOIOS_URL } from '@apexfusion/vector-mcp-shared/config';` becomes `import { VECTOR_KOIOS_URL } from '../mcp-shared/config.js';`
- line 8: `import type { VectorUnsignedBuildResult } from '@apexfusion/vector-mcp-shared/types';` becomes `import type { VectorUnsignedBuildResult } from '../mcp-shared/types.js';`
- line 19 (the end of the import that starts on line 16): `} from './marketplace-datum.js';` becomes `} from '@vsa/vector-read';`
- line 20: `import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';` becomes `import type { AdvertDatum, EscrowDatum } from '@vsa/vector-read';`

`src/vendored/mcp/marketplace-verify.ts`
- line 8: `import { safeFetch } from './safe-fetch.js';` becomes `import { safeFetch } from '@vsa/vector-read';`
- line 10: `import { canonicalize, formatOutRef, sha256Utf8Hex } from './marketplace-datum.js';` becomes `import { canonicalize, formatOutRef, sha256Utf8Hex } from '@vsa/vector-read';`
- line 11: `import type { EscrowDatum } from './marketplace-datum.js';` becomes `import type { EscrowDatum } from '@vsa/vector-read';`

`src/vendored/mcp/marketplace-transport.ts`
- line 48: `import { safeFetch } from './safe-fetch.js';` becomes `import { safeFetch } from '@vsa/vector-read';`
- line 50: `import { promptHashForPayload, sha256BytesHex } from './marketplace-datum.js';` becomes `import { promptHashForPayload } from '@vsa/vector-read'; import { sha256BytesHex } from '../../hashes.js';` (two statements on the one line, so the line numbers stay those of the source)
- line 51: `import type { EscrowDatum } from './marketplace-datum.js';` becomes `import type { EscrowDatum } from '@vsa/vector-read';`

`src/vendored/mcp/marketplace-supplier.ts`
- line 18: `import { formatOutRef, parseOutRef, wirePayloadFor } from './marketplace-datum.js';` becomes `import { formatOutRef, parseOutRef, wirePayloadFor } from '@vsa/vector-read';`
- line 19: `import type { AdvertDatum, EscrowDatum } from './marketplace-datum.js';` becomes `import type { AdvertDatum, EscrowDatum } from '@vsa/vector-read';`

`src/vendored/mcp/build.ts` (an excerpt, see below)
- line 13: `import { lovelaceToAda, apexToLovelace } from '@apexfusion/vector-mcp-shared/tx';` becomes `import { lovelaceToAda } from '../mcp-shared/tx.js';` (the one rewrite that also drops a name: `apexToLovelace` is used only by the builders after line 48, which the excerpt leaves out, and the `tx.ts` excerpt does not carry it; a build-time ruling signed off this one rewrite)
- line 16 (the end of the import that starts on line 14): `} from '@apexfusion/vector-mcp-shared/types';` becomes `} from '../mcp-shared/types.js';`

`src/vendored/mcp/rate-limiter.ts`
- line 3: `import { intEnv } from '../env.js';` becomes `import { intEnv } from './env.js';` (`env.ts` sits next to it here; in the source it is one folder up, `packages/builder/src/env.ts`)

`test/fixtures/escrow-koios.fixture.ts`
- line 16: `import { ESCROW_ADDRESS, ESCROW_SCRIPT_HASH } from '../../src/vector/marketplace-constants.ts';` becomes `import { ESCROW_ADDRESS, ESCROW_SCRIPT_HASH } from '../../src/vendored/mcp/marketplace-constants.ts';`
- line 17: `import { encodeEscrowDatum } from '../../src/vector/marketplace-datum.ts';` becomes `import { encodeEscrowDatum } from '@vsa/vector-read';`
- line 18: `import type { EscrowDatum } from '../../src/vector/marketplace-datum.ts';` becomes `import type { EscrowDatum } from '@vsa/vector-read';`

`src/vendored/fleet/responses.ts` (from agents-marketplace at `e847a55`)
- line 1: `import type { ChatMessage } from "./tx/types.js";` becomes `import type { ChatMessage } from "./types.js";`

`src/vendored/mcp-shared/config.ts`: not an import rewrite, the listed deviation below.

## Deviation: config.ts defaults to Vector mainnet

The source defaults to Vector testnet. In this copy the three endpoint defaults are mainnet, and each is still overridden by its environment variable. The mainnet values are those of the mainnet table in the mcp-server README at the same commit.

- line 2: `VECTOR_OGMIOS_URL` default `https://ogmios.vector.testnet.apexfusion.org` becomes `https://ogmios.vector.mainnet.apexfusion.org`
- line 3: `VECTOR_SUBMIT_URL` default `https://submit.vector.testnet.apexfusion.org/api/submit/tx` becomes `https://submit.vector.mainnet.apexfusion.org/api/submit/tx`
- line 4: `VECTOR_KOIOS_URL` default `https://v2.koios.vector.testnet.apexfusion.org/` becomes `https://v2.koios.vector.mainnet.apexfusion.org/`

Two lines stay as the source has them: the comment on line 1 still says that the defaults target testnet, and `VECTOR_EXPLORER_URL` (line 5) still defaults to the testnet explorer. Nothing in buyer-core reads `VECTOR_EXPLORER_URL` or calls `explorerTxLink`, and `src/index.ts` does not export either.

`test/config-and-fixtures.test.ts` pins the three defaults (with the variables unset) and the override (with them set), so a re-vendor that brings the testnet defaults back fails there.

The Koios base excludes `/api/v1`. The vendored indexer (`koiosPostList`) and `OgmiosProvider` strip trailing slashes from the base and append `/api/v1/<route>` themselves; that is the vendored expectation, kept. `@vsa/vector-read` reads another variable, `KOIOS_URL`, whose default includes `/api/v1` (`https://v2.koios.vector.mainnet.apexfusion.org/api/v1`). Never hand vector-read's `KOIOS_URL` to a buyer-core function that takes a Koios base, or the reverse: the request would go to `/api/v1/api/v1/<route>`. The marketplace indexer is configured the same way twice: buyer-core reads `VECTOR_MARKETPLACE_INDEXER_URL`, vector-read reads `INDEXER_URL`, and both default to `https://mp-indexer.vector.apexfusion.org`.

## Deviation: four excerpts

Four copies are excerpts: whole lines of the source, byte for byte and in their order, with the rest left out. Nothing inside a kept line changes except the two `build.ts` import lines above.

- `src/vendored/mcp/gov-build.ts`: lines 1-13 (the header and the Lucid imports), 85-135 (the slot clock: `SlotClockProvider`, `slotClockOf`, `ChainClockError`, `ensureSlotConfig` and its module-global cache) and 151-175 (`paymentKeyHashOf`) of 821. The whole file imports `@aws-sdk/client-s3` at the top (the IPFS upload of the module-proposal builders), `registry-build.ts` and the shared `tx.ts`, and names the ledger unit in four lines. The copies need only the slot clock and the key hash, and buyer-core carries no AWS SDK. The comment above `paymentKeyHashOf` speaks of `buildProposalSpend` "below": that is in the part left out.
- `src/vendored/mcp/build.ts`: lines 1-48 of 196, `lucidForAddress` (exported by `src/index.ts`) and `toBuildResult`. The rest are the send, deploy and interact builders, which use `apexToLovelace`; line 13 drops that name from its import (see Rewritten lines).
- `src/vendored/mcp-shared/tx.ts`: lines 1-2 (the header comment) and 46-54 (a blank line and `lovelaceToAda`) of 113. The rest (`apexToLovelace`, the metadata, CBOR and NFT-name helpers) is not used by the copies, and `apexToLovelace` names the ledger unit in its comments and in its error text, which `scripts/specs.test.mjs` refuses anywhere in this repository but `docs/HIRE.md`.
- `src/vendored/fleet/types.ts` (from agents-marketplace at `e847a55`): lines 18-35 of 89 of `packages/shared/src/tx/types.ts`: the `ToolCall` interface, a blank line, and `ChatMessage` with its own comment. `ChatMessage` is the one type `fleet/responses.ts` imports (for the two adapters `chatMessagesToResponseInput` and `responseInputToChatMessages`), and `ToolCall` is the one type `ChatMessage` refers to. The rest of the file (its header, the `OutputReference` import from the chain provider, `WalletKey`, `BuildResult` and the two results derived from it, `TxConstructionError`) belongs to the fleet's transaction builders and is not used by the copy. The comment of `ToolCall` (lines 14-17) is left out: it holds an em dash.

## Verbatim exceptions to the repository's writing rules

The copies keep the source's wording where it breaks a writing rule of this repository. A build-time ruling: the copy stays byte-identical and the exception is declared here, never rewritten.

- `test/fixtures/fixture-provider.ts`, lines 78, 81, 84, 87, 90, 93 and 96: one em dash (U+2014) each, between `offline` and the method name in the error strings of the seven methods the offline provider refuses (`getUtxosWithUnit`, `getUtxoByUnit`, `getDelegation`, `getDatum`, `awaitTx`, `submitTx`, `evaluateTx`). This repository writes hyphens only. The dash check of `scripts/specs.test.mjs` does not read this file.

No other copy holds an en or em dash (the comment of `ToolCall` in the source of `fleet/types.ts` does, and lies outside the excerpt), and no copy names the ledger unit (the excerpts leave out the lines that do).

## Files the copies need beyond the set first planned

- `src/vendored/mcp/rate-limiter.ts` and `src/vendored/mcp/env.ts`: `marketplace-shared.ts` imports the type `RateLimiter` (a type import, erased at runtime, but the type check resolves it), and `rate-limiter.ts` imports `intEnv`. Whole files, no dependencies.
- `src/vendored/mcp-shared/tx.ts`: `build.ts` imports `lovelaceToAda` from it.
- `test/fixtures/marketplace.fixture.ts`, `test/fixtures/fixture-provider.ts` and `test/fixtures/protocol-params.fixture.json`: `escrow-koios.fixture.ts` imports the first two, and the fixture provider reads the JSON when a test asks it for protocol parameters. `marketplace.fixture.ts` is the same file as `packages/vector-read/test/fixtures/marketplace.fixture.ts` (it did not change between `94b8f41` and `651ae93`).

## Not copied

- `packages/builder/src/vector/marketplace-datum.ts` and `packages/builder/src/vector/safe-fetch.ts`: imported from `@vsa/vector-read` (above). Between `94b8f41` and `651ae93` the datum module gained only `sha256BytesHex`.
- The rest of `gov-build.ts`, and `registry-build.ts`: they need `@aws-sdk/client-s3`.
- The MCP tool modules (`marketplace.ts` and `marketplace-*-tools.ts`): they need `@modelcontextprotocol/sdk` and `zod`. buyer-core exports the functions those tools call.
- Everything of the signer but `sign.ts` (its key loading, key generation, policy, audit log and tools). The Document Pipeline's key comes from its env file as raw hex; `src/signing.ts` turns such a key into the bech32 that `signTransaction` takes.
- The rest of Apex-Fusion/agents-marketplace. Of the fleet only `packages/shared/src/responses.ts` and the excerpt above are copied. The OCR commitments are not: `ocrPromptHash` (in the OCR escrow builder, `packages/shared/src/tx/escrow/postOcrEscrow.ts`) and the OCR response hash (computed inline by `runOcrJob` in `supplier/src/jobRunner.ts`) are three lines each on `canonicalize`, written in `src/commitments.ts` and pinned by `test/commitments.test.ts`.

## Local files

- `src/hashes.ts`: `sha256BytesHex`. Its code lines are the source's, appended from the blob: line 9 (the `createHash` import) and lines 193-194 of `packages/builder/src/vector/marketplace-datum.ts` at `651ae93`, under a header comment. Tested in `test/hashes.test.ts`.
- `src/signing.ts`: `rawHexToBech32`, a raw 64-hex Ed25519 key as the bech32 `signTransaction` takes. Tested in `test/signing.test.ts`.
- `src/commitments.ts`: the fleet's request and response commitments, the hashes of the escrow datum and of the receipt: `ocrPromptHash`, `ocrResponseHash`, `responsesPromptHash`, `responsesResponseHash`, `responsesOutputText`, and `requestSpecHash` re-exported from `@vsa/vector-read`. The Responses functions compose the vendored `fleet/responses.ts` and the `canonicalize` of `@vsa/vector-read`; the two OCR hashes are written here (see Not copied). Tested in `test/commitments.test.ts`.
- `src/fleet-build.ts`: `planFleetPostEscrow` and `buildFleetPostEscrow`, the Post of a fleet job. They are the vendored `planPostEscrow` and `buildPostEscrow` with the hash of a template payload replaced by a prompt hash the caller computes (`src/commitments.ts`), without the vendored builder's refusal of fleet capabilities, and with the Koios base as an argument. Every other check and number is the vendored logic, mirrored there because a vendored file is never edited: the refusals of `planPostEscrow`, `deliver_by` = `posted_at` + the window + `DELIVER_BY_BUFFER_MS`, validity until min(`posted_at` + the buffer, `deliver_by` - the window), `escrowLockFloor`, the advert read and its author check, `reserveCollateralInputs` and `assertEscrowIsOutputZero`. Tested in `test/fleet-build.test.ts`.
- `src/chain.ts`: the `Chain` interface; `RealChain`, which builds keyless with `lucidForAddress` and the vendored builders, signs with the vendored `signTransaction` and the buyer key, submits through the provider, waits for the provider's `awaitTx` for `awaitTimeoutMs` at most (at least `DELIVER_BY_BUFFER_MS`, so that a Post the wait gave up on can no longer land), runs one transaction at a time, and reads escrow states and receipt hashes off `resolveEscrowLineage`; and `createRealChain`, which puts it over the vendored `OgmiosProvider`. Every failure after the signature is a `TxNotConfirmedError` with the transaction's hash, its escrow, the Post's `deliver_by`, the end of its validity and whether it may still land; a 4xx answer of the submit API is the one refusal it reads as final. Tested offline in `test/real-chain.test.ts`, the submit answers through the vendored `OgmiosProvider.submitTx`; Accept and Reclaim up to the escrow reference script, past which they need the deployed script and the node's script evaluation.
- `src/fake-chain.ts`: `FakeChain`, the in-memory `Chain` of the service tests, with the supplier's Claim and Submit as test hooks. Tested in `test/fake-chain.test.ts`.
- `src/fees.ts`: `feeOfSignedTx`, the fee field of a signed transaction's body. Tested in `test/real-chain.test.ts`.
- `src/guards.ts`: `isRecord` (a JSON object: not null, not an array) and `sameRef` (two refs name the same output, compared through the vendored `canonicalRef`, so the case of the hex, white space around the ref and leading zeros in the index do not matter; anything that is no ref, or no text, names nothing, not even itself): the two checks on untrusted values that `fleet-clients.ts`, `select-supplier.ts` and `fleet-verify.ts` share, written once. Tested in `test/guards.test.ts`.
- `src/fleet-clients.ts`: the HTTP side of a fleet hire: `readCapability` (GET `/capability`), `probeStatus` (GET `/status`), `sendOcrJob` and `sendResponsesJob` (the POST of a job once its escrow is posted), `pollOcrJob` and `pollResponsesJob` (a poll is made for an escrow, and a done answer must name it in its `escrow_ref`; a 200 without a receipt and its signature rejects, as any answer that is not the supplier's own), and the types `FetchLike`, `SupplierCapability`, `SendResult`, `PollResult` and `Receipt`. The vendored verifier exports no receipt type (it takes the receipt as `unknown`, and `JobView.receipt` of the vendored transport is `Record<string, unknown>`), so `Receipt` is that shape under a name, defined once here. The routes and headers are the fleet half of the vendored `ROUTES` (`marketplace-supplier.ts`, kept by the mcp-server and not used by it), and every call goes through the `safeFetch` of `@vsa/vector-read`, whatever fetch is injected. Tested in `test/fleet-clients.test.ts`.
- `src/select-supplier.ts`: `selectLlmSupplier` and `findOcrAdvert`, supplier discovery over the vendored `fetchSuppliers`. The indexer's row names an advert's UTxO `utxo_ref`, which is the `advert_ref` a supplier serves at `/capability`. The vendored `fetchSuppliers` takes no indexer base (it reads `INDEXER_URL` once), so an `indexerUrl` re-points its calls, and a vendored file is not edited. `selectLlmSupplier` is bounded: at most `maxCandidates` (6) suppliers are asked, within `budgetMs` (120 s) from the call, the request in flight being cancelled when the budget runs out. Tested in `test/select-supplier.test.ts`.
- `src/fleet-verify.ts`: `verifyFleetReceipt`, the check of a fleet sub-receipt before an Accept, and the types `FleetVerifyInput` and `FleetVerification`. The vendored `verifyReceipt` compares `response_hash` with the sha256 of the result text, and a fleet supplier hashes a canonical envelope (`src/commitments.ts`), so the hash the buyer recomputes is an input. Four of the seven rows are the vendored `verifyReceipt`'s own, called and not copied: `supplier_key_matches`, `signature_valid`, `on_chain_hash_matches` and `prompt_hash_matches`. Three are written here: `escrow_ref_matches` (both refs through the vendored `canonicalRef`), `response_hash_matches` (against the recomputed hash) and `model_matches`. The verdict is `VERIFIED` only when all seven pass, `FAILED` when one fails, and `INCOMPLETE` when none fails and the hash on chain was null. The verifier never throws on a malformed receipt, one nested too deeply for the vendored `canonicalize` to walk included: the vendored call has no guard for that in its on-chain row (a supplier can send such a receipt within the poll's size cap), so it runs inside a `try` and its four rows fail on a throw, the on-chain row being skipped only when there was no hash to compare. Only the error of the on-chain callback propagates (it is awaited first and not caught), and a callback result that is neither a string nor null fails the on-chain row. Tested in `test/fleet-verify.test.ts` and, with the vendored call replaced by one that throws, in `test/fleet-verify-throw.test.ts`.
- `src/index.ts`: the public surface.

The tests: `test/vendored.test.ts` (this manifest, both ways, and the public surface), `test/signing.test.ts`, `test/hashes.test.ts`, `test/commitments.test.ts` (the values the plan pins, the prompt hash the fleet pins in its own tests, and the fields each hash covers), `test/config-and-fixtures.test.ts` (the mainnet defaults, and the vendored fixtures driving `planPostEscrow`, `resolveEscrowLineage` and `lucidForAddress`), `test/fleet-build.test.ts`, `test/real-chain.test.ts`, `test/fake-chain.test.ts`, `test/guards.test.ts`, `test/fleet-verify.test.ts` (real Ed25519 signatures from keys generated per job, and the fleet commitments as the hashes), `test/fleet-verify-throw.test.ts` (the vendored `verifyReceipt` replaced by a stand-in that throws, and the arguments it is handed), `test/fleet-clients.test.ts` and `test/select-supplier.test.ts`. `test/advert-koios.ts` is a fake Koios for the advert a Post reads, shaped after the one of the mcp-server's `marketplace-build.test.ts`; it is not a copy, so it sits outside `test/fixtures/`. `test/fake-fetch.ts` is the fake fetch of the last two (it answers by method and URL and records the calls); it is not a copy either.

## Checking the copies against the pin

From the repository root, with `<mcp-server>` a checkout that has `651ae93` and `<agents-marketplace>` one that has `e847a55`:

```bash
# A whole file: no output for the byte-identical copies, the listed lines for the rewritten ones.
git -C <mcp-server> cat-file blob 651ae93:packages/builder/src/vector/marketplace-build.ts | diff - packages/buyer-core/src/vendored/mcp/marketplace-build.ts
# The excerpts.
git -C <mcp-server> cat-file blob 651ae93:packages/builder/src/vector/gov-build.ts | sed -n '1,13p;85,135p;151,175p' | cmp - packages/buyer-core/src/vendored/mcp/gov-build.ts
git -C <mcp-server> cat-file blob 651ae93:packages/shared/src/tx.ts | sed -n '1,2p;46,54p' | cmp - packages/buyer-core/src/vendored/mcp-shared/tx.ts
git -C <mcp-server> cat-file blob 651ae93:packages/builder/src/vector/build.ts | sed -n '1,48p' | diff - packages/buyer-core/src/vendored/mcp/build.ts
# The two fleet files: the first prints the one rewritten line (line 1), the second prints nothing.
git -C <agents-marketplace> cat-file blob e847a55:packages/shared/src/responses.ts | diff - packages/buyer-core/src/vendored/fleet/responses.ts
git -C <agents-marketplace> cat-file blob e847a55:packages/shared/src/tx/types.ts | sed -n '18,35p' | cmp - packages/buyer-core/src/vendored/fleet/types.ts
```

## Re-vendoring

1. Take the new pin (a commit of Apex-Fusion/mcp-server).
2. For each row, take the blob at the pin with `git cat-file blob` (never a working file of a CRLF checkout), cut the excerpts again after checking that the line ranges still hold the same code, and apply the rewrites listed above, one line for one line.
3. Apply the config.ts deviation again: the source's `config.ts` defaults to testnet, so set the defaults of lines 2-4 to the mainnet values above. A fresh blob brings the testnet defaults back, and `test/config-and-fixtures.test.ts` fails until they are mainnet again.
4. Check the verbatim exceptions above against the new copies (the em dash lines of `fixture-provider.ts`, and any new one), and update their line numbers here.
5. If the datum module changed after `94b8f41` in more than `sha256BytesHex`, re-vendor `packages/vector-read/src/datum.ts` first (see `packages/vector-read/VENDORED-FROM.md`).
6. Recompute the sha256 column (`sha256sum`), update the commit column and this file, and run `pnpm --filter @vsa/buyer-core test` and `pnpm typecheck`. `test/vendored.test.ts` fails on a copy without a row, a row without a copy, and a sha256 that no longer matches.
7. The two files under `src/vendored/fleet/` have their own pin, a commit of Apex-Fusion/agents-marketplace. Take the blobs at the pin of an up-to-date `origin/main` (the working tree of a clone may be a stale branch), cut `types.ts` again after checking that lines 18-35 still hold `ToolCall` and `ChatMessage` and that the comment above `ToolCall` is still outside the range, rewrite line 1 of `responses.ts`, and recompute their rows. If a value pinned in `test/commitments.test.ts` stops holding, the fleet changed what its suppliers commit to: an escrow posted with the old hash would be refused with `prompt_mismatch` or fail its receipt check, so find out why before any value is changed.
