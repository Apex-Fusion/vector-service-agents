# Vendored from Apex-Fusion/agents-marketplace

The files under `src/vendored/m4/` are copies of files of Apex-Fusion/agents-marketplace at commit `46f4b8f` (`46f4b8ff3a463491f530983413d158acd06490c1`, committed on 2026-11-19 at 17:50:21 +0100, the head of main on that day). The identity gateway in `identity-gateway/` of that repository is the source of every wire format that this package reads or writes. The copies keep one implementation of the JOSE code, of the pattern rule and of the DER writers for the gateway and for this package. A drift in one of them cannot go unseen.

Each copy was taken from the blob, `git -C <agents-marketplace> cat-file blob <commit>:<path>`, never from a working file. A checkout with `core.autocrlf=true` has CRLF working files, and every checkout of this repository has LF (`.gitattributes` says `eol=lf`). A `cp` of such a working file records a sha256 that no checkout here reproduces.

## Files

| destination | source | commit | sha256 |
|---|---|---|---|
| `src/vendored/m4/jose.ts` | `agents-marketplace:identity-gateway/src/m4/jose.ts` | `46f4b8f` | `4bb722679e271d8b5b0c4bc084a40d35b3be1cee94f1661e027bead208b9466d` |
| `src/vendored/m4/der.ts` | `agents-marketplace:identity-gateway/src/m4/der.ts` | `46f4b8f` | `47dee586952b4cb2915ef5844cc3c6ca8eb26ac8088ce67f667b61cd57d66f87` |
| `src/vendored/m4/delegation-patterns.ts` | `agents-marketplace:identity-gateway/src/m4/delegation.ts` excerpt, lines 32-63 | `46f4b8f` | `f3c01f661e6b980971a0d0b7e9d6663745e5a17cb964dd62d064f32ece11f1fc` |

`test/vendored.test.ts` checks this table in both directions. Every row names a file whose sha256 matches. Every file under `src/vendored/` has a row. A copy that changes, and a file that is added with no row, fail the test.

## What each copy holds

- `jose.ts`: base64url that is strict and canonical, the parser of a compact JWS, the check of a JWS signature (Ed25519 and P-256), the signer of a compact JWS, the public JWK reader (it refuses any private member), the JWK thumbprint of RFC 7638 and the key object of a record key. The client signs with it, and the verifier reads and checks every JWS with it.
- `der.ts`: the DER writers (sequence, set, integer, object identifier, bit string, times, tags) and the strict DER reader. The client writes the certification request with the writers. The verifier reads an X.509 certificate with the reader, because `node:crypto` does not show the key usage bits and the exact alternative names. The whole file is copied, because the reader and the writers are one module of the source.
- `delegation-patterns.ts`: the action and resource patterns of the delegation rules. It is the block "Section 5.1 patterns" of the source, whole lines 32 to 63. The pattern checks (`isActionPattern`, `isResourcePattern`, `covers`, `patternCovers`, `narrower`) have no imports, so the excerpt stands alone. The verifier uses `covers` for the action and the resource of a call. The stub gateway uses all of them for the chain of a delegation.

No line of a copy is rewritten. The copies import only `node:crypto`, which is also what the source does, so a copy and its source differ in no line at all. The names `DELEGATION_DETAILS_TYPE` and `MAX_DELEGATION_DEPTH` (lines 27 to 30 of the source) are not copied: `src/common/constants.ts` writes them again, and `test/live-vectors.test.ts` checks the type URI against the metadata that the live gateway serves.

Not copied: the token, DPoP, SPIFFE, status list and credential code of the gateway. It is the server side of the same formats. The package writes the client side and the verifier side again, and it checks both against the live gateway's public output (`test/fixtures/live/`) and against the gateway's own rules, which the stub gateway follows.

## Check the copies against the pin

Bash, from the repository root. Each command prints nothing when the copy is right.

```bash
git -C <agents-marketplace> cat-file blob 46f4b8f:identity-gateway/src/m4/jose.ts | cmp - packages/id-kit/src/vendored/m4/jose.ts
git -C <agents-marketplace> cat-file blob 46f4b8f:identity-gateway/src/m4/der.ts | cmp - packages/id-kit/src/vendored/m4/der.ts
git -C <agents-marketplace> cat-file blob 46f4b8f:identity-gateway/src/m4/delegation.ts | sed -n '32,63p' | cmp - packages/id-kit/src/vendored/m4/delegation-patterns.ts
```

## Re-vendoring

1. Take the new pin, a commit of Apex-Fusion/agents-marketplace.
2. Copy each row again from the blob at the pin. Before the excerpt is cut again, check that lines 32 to 63 still hold the pattern block and nothing else. If the block moved, change the line range in the table and in the `sed` command.
3. If a copy now imports a file that is not here, copy that file too, at the same relative path, and add its row. Rewrite no line but import lines.
4. Recompute the sha256 column (`sha256sum`) and the commit column. Change the commit in this text.
5. Run `pnpm --filter @vsa/id-kit test` and `pnpm typecheck`.
