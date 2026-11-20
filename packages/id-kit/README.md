# @vsa/id-kit

A client and a verifier for the identity gateway of the Vector chain (`https://id.vector.apexfusion.org`), and a stub gateway for tests.

- `@vsa/id-kit/client` (also the root): what an agent sends to the gateway to get a token, an SVID or its credential, and how it reads DID resolution.
- `@vsa/id-kit/verify` (also the root): what a relying party checks: an access token with its DPoP proof, both status list formats, an X.509-SVID, a JWT-SVID and an identity credential.
- `@vsa/id-kit/testing`: the stub gateway and test keys. No service imports it.

The gateway is the source of every wire format. `VENDORED-FROM.md` lists the three files of its code that this package copies byte for byte (the JOSE code, the DER code and the pattern rule of a delegation). A test fails when a copy changes. A test also checks that the client, the verifier, the shared code, the copied files and the root module never load the test helpers.

```ts
import { createGatewayClient, createVerifier, presentToken } from '@vsa/id-kit';

// An agent asks for a token that covers a delegation, and calls a resource with it.
const client = createGatewayClient({ baseUrl: 'https://id.vector.apexfusion.org' });
const token = await client.requestToken({
  subject: { did, key: recordKey },            // a private KeyObject, or a sign function (SignerKey)
  dpopKey: delegateKey,                        // with a delegation: the Ed25519 delegate key of the leaf delegation
  resource: 'https://mock.example/t/1/erp',
  delegation: { identifier: delegationId },
});
if (!token.ok) throw new Error(`${token.rule}: ${token.detail}`);
const headers = await presentToken(token.value.accessToken, delegateKey, { method: 'POST', url });   // { authorization, dpop }

// A relying party checks a call. The policy names the action and the resource that the grant must cover.
const verifier = createVerifier({ baseUrl: 'https://id.vector.apexfusion.org' });
const call = await verifier.accessToken(
  { authorization: req.headers.authorization, dpop: req.headers.dpop, method: 'POST', url: publicUrl },
  { audience: 'https://mock.example/t/1/erp', require: { action: 'erp.stock.read', resource: 'https://mock.example/t/1/erp' } },
);
if (!call.ok) return refuse(call.rule);            // the rule that failed
const { status } = call.value;
if (status.read) log(`status list built ${Math.round((Date.now() - status.issuedAt) / 1000)} seconds ago`);
if (!status.read) {
  // The call is not refused, but the verifier did not read the status list again within its time to live.
  // reason 'unavailable': the list cannot be read. reason 'stale': the list is over, or only an older copy is left because a new read failed.
  log(`status list not read (${status.reason}): ${status.detail}`);
}
```

## Keys

A caller gives each key as a private `KeyObject` (Ed25519 or P-256), or as a `SignerKey`: the algorithm, the public key and a sign function that returns the 64 bytes of the JWS form (Ed25519, or ES256 as `r` then `s`). The package reads no key file and no environment variable. It never exports a private key. `test/no-ambient-input.test.ts` scans `src/` for both.

## What the client sends

| Call | What goes out |
|---|---|
| `createSubjectToken` | An EdDSA JWT: header `alg`, `kid` = `did:vector:<id>#<56 hex key hash>`, `typ` JWT. Claims `iss` = `sub` = the DID, `aud` = `<gateway>/token`, `iat`, `exp` (120 seconds by default, 300 at most) and a new `jti` for each token. |
| `requestToken` | `POST /token`, form encoded: `grant_type` token exchange, `subject_token`, `subject_token_type`, one or more `audience` and `resource` values (at least one, at most 8, each at most 512 characters; a resource is an absolute URI with no fragment). With `delegation`, also `authorization_details`: one object of the type `https://id.vector.apexfusion.org/ns/delegation` with the identifier of the leaf delegation and, if the caller narrows the grant, `actions` (at most 16) and `locations` (at most 8). A `DPoP` header holds a proof for `POST` on the token endpoint, signed by `dpopKey`. |
| `createDpopProof`, `presentToken` | A JWT with `typ` dpop+jwt, the public JWK in the header, and `jti`, `htm`, `htu` (the URL with no query and no fragment), `iat` and, for a call to a resource, `ath` (the SHA-256 hash of the access token). `presentToken` gives `Authorization: DPoP <token>` and a new proof for one call. |
| `x509Svid` | `POST /spiffe/nonce`; then `POST /spiffe/x509-svid` with a PKCS #10 request for a P-256 key and a proof: a JWT by an authentication key (EdDSA or ES256) with the nonce and the public key of the request (`cnf.jwk`). The client makes the key when the caller gives none, and returns it. |
| `jwtSvid` | `POST /spiffe/jwt-svid` with a subject token and 1 to 8 audiences. |
| `credential` | `GET /agents/<identifier>/credential`. The result is the JWS as it came. Check it with `verifier.credential`. |
| `resolve` | `GET /1.0/identifiers/<did>`. The result says `resolved`, `deactivated` or `not_found`, with the effective status of the agent. |

The client checks a request against the limits of the gateway before it sends it. An argument that the gateway would refuse throws a `TypeError` or a `RangeError`, and nothing is sent. A call that goes out returns a typed result: `{ ok: true, value }`, or `{ ok: false, rule, detail, status, error, retryAfterSeconds }` with the rule `gateway.refused` (4xx, with the OAuth error code), `gateway.unavailable` (5xx or 429), `gateway.bad_response` or `gateway.unreachable`.

## What the verifier checks

Every check returns `{ ok: true, value }` or `{ ok: false, rule, detail }`. The `rule` is a member of the list of that check (exported as `ACCESS_TOKEN_RULES`, `CALL_RULES`, `STATUS_LIST_RULES`, `X509_SVID_RULES`, `JWT_SVID_RULES`, `CREDENTIAL_RULES`, `CREDENTIAL_CALL_RULES`, `KEY_SET_RULES` and `BUNDLE_RULES`). Each rule has a refusal and an accepted twin in the tests.

A `detail` is a sentence for a log. It names a rule, a field, a count, a time or a public identifier (a DID, a trust domain). It never repeats a credential or a part of one: not the `Authorization` header, not a token, a proof or a certificate, and not a value of the header of a JWS. So a service can return a detail, or write it to a log.

**Access token and DPoP proof** (`verifier.accessToken`), in this order:

| Rules | Check |
|---|---|
| `token.missing`, `token.scheme` | The `Authorization` header is `DPoP <token>`. A token that is sent as `Bearer` is refused. The detail of `token.scheme` never repeats the header: a caller that sends `<token> <something>` puts its token in the place of the scheme. |
| `token.malformed`, `token.alg`, `token.typ`, `token.kid`, `token.signature` | A JWS, ES256 (the algorithm `none` is refused), `typ` at+jwt, signed by a P-256 key of the key set of the gateway. A JWT-SVID, a status list or a credential is `token.typ`. |
| `token.issuer`, `token.audience` | `iss` is the gateway. `aud` names this resource. |
| `token.lifetime`, `token.expired`, `token.not_yet_valid` | `exp - iat` is from 1 to 300 seconds. A token is accepted until 30 seconds after `exp` (the clock leeway, `leewaySeconds`). So a token is honoured for 330 seconds after it was issued, at most. |
| `token.claims` | `jti`, `sub`, `client_id` (a DID that is the current actor) and `cnf.jkt` are there. |
| `dpop.missing`, `dpop.multiple`, `dpop.malformed`, `dpop.typ`, `dpop.alg`, `dpop.key`, `dpop.signature`, `dpop.jti`, `dpop.method`, `dpop.url`, `dpop.iat`, `dpop.ath`, `dpop.binding` | The proof is one JWT of the right type, with a public key and a signature that verifies, for this method and URL, from the last 5 minutes, naming this token by its hash, and made by the key that `cnf.jkt` names. |
| `dpop.replay`, `dpop.replay_store` | A proof is accepted once. The store of used proofs fails closed when it is full. |
| `act.invalid`, `act.depth` | The `act` chain is a chain of DIDs, at most 4 deep (`maxActDepth`). |
| `delegation.details` | The authorization details are one object of the delegation type, with valid patterns. Two objects, or an object of another type, are refused. |
| `delegation.unchecked` | A token that carries a delegation is refused when the policy has no `require`. The delegate chooses the audience of a token, and the gateway does not compare it with the grant. So a token with a delegation is accepted only when the policy names the action and the resource of the call. |
| `delegation.missing`, `delegation.action`, `delegation.resource` | With `require: { action, resource }`, a token with no delegation is refused (`delegation.missing`), unless `acceptDirect` is set. A pattern of the grant must cover the action and the resource (`x.*` covers `x.y`; `oc.*` does not cover `ocr.read`; `*` covers all; other patterns match exactly). |
| `status.claim` | The token names a position below 131,072 in a Token Status List of the gateway. |
| `status.revoked`, `status.suspended`, `status.value`, `status.list` | The entry of the agent that asked for the token in that list. A list that was read and is wrong is `status.list`. A list that was not read is no refusal (see below). |
| `actors.refused`, `delegation.refused` | The checks that the caller supplies (below). |
| `keys.unavailable`, `jwks.*` | The key set cannot be read, or it is wrong. |

The `htu` of a proof and the URL of the request are compared as the gateway compares them: the scheme and the host in lower case, the default port dropped, no query and no fragment, and the path as it is. A trailing slash, the case of the path and a percent-encoded letter all count.

The result of a call has `principal`, `actors` (the current actor first), `clientId`, `delegation` (the identifier and the patterns), `statusClaim`, `status` and the times. `status` is `{ read: true, list, fetchedAt, issuedAt }` or `{ read: false, list, reason, detail, issuedAt }`. `issuedAt` is the time that the gateway built the list (POSIX ms), so a caller can log the age of the list. It is null when the verifier holds no list.

**The policy of a call** has three cases:

```ts
{ audience }                                                       // only tokens with no delegation: the agent acts for itself
{ audience, require: { action, resource } }                        // only tokens with a delegation, and the grant must cover the action and the resource
{ audience, require: { action, resource }, acceptDirect: true }    // both kinds; the grant of a token with a delegation is still checked
```

`action` and `resource` are concrete values, not patterns. A pattern throws a `TypeError`. `require` is an object with an `action` and a `resource`, both text: any other shape throws a `TypeError` before the verifier reads anything. `acceptDirect` is `true`, `false` or not set. Any other value, such as the text "false" from an environment value, throws a `TypeError`. `acceptDirect` without `require` throws a `TypeError` too.

**Status lists.** The Bitstring Status List holds both purposes in one list: bit `p` is revocation, and bit `131072 + p` is suspension. The Token Status List has 2 bits for each entry: 0 valid, 1 invalid (revoked), 2 suspended. A decode checks the signature, the issuer, that the list is the one that was asked for, the time and the encoding (`list.*`). Both are read with `decodeTokenStatusList`, `decodeBitstringStatusList`, `tokenEntryStatus` and `bitstringEntryStatus`. The reader keeps the newer list: a list with an older issue time than its copy does not replace the copy.

**X.509-SVID** (`verifier.x509Svid`): the certificate chains to an authority of the bundle, is inside its validity (`x509.not_yet_valid`, `x509.expired`), is no CA, has the key usage digitalSignature and neither keyCertSign nor cRLSign, and has exactly one URI name that is a SPIFFE ID of an agent in this trust domain (`x509.malformed`, `x509.bundle`, `x509.untrusted`, `x509.ca`, `x509.key_usage`, `x509.san`, `x509.spiffe_id`, `x509.trust_domain`). The input is exactly one certificate: one PEM block (with only white space around it), the base64 of its DER (the form of a header that a proxy sets), or its DER bytes. A second certificate, a second PEM block, or any other text or bytes next to the certificate make the input `x509.malformed`. The base64 text has the standard alphabet and its padding, and white space in it does not count.

**JWT-SVID** (`verifier.jwtSvid`): ES256, `typ` JWT, a key of the bundle, `sub` a SPIFFE ID of an agent in this trust domain, `aud` names this resource, a life of 5 minutes at most (`jwt_svid.*`).

**Credential** (`verifier.credential`): the signature, the issuer (the DID of the signing key), the contexts and types, the time, the subject, and the two status entries (revocation at `p`, suspension at `131072 + p`, in one list of the gateway). The verifier then reads that list and checks both bits: `credential.revoked`, `credential.suspended`. A credential that anybody changed is `credential.signature`. A credential is refused with `credential.status_unknown` when the verifier did not read the list within its time to live (see below).

A credential is a public document: anybody can fetch it from the gateway. It proves facts about its subject. It does not prove that the caller is that agent. To know who the caller is, check an access token with its DPoP proof.

### A status list that was not read

A call with an access token is not refused when the verifier did not read the status list again within its time to live. The result says `status: { read: false, reason, detail }`, so that the caller can write it to its log:

- `unavailable`: the list cannot be read (the gateway answers 503, as it does for some minutes after it starts, or another status, or the network fails).
- `stale`: the list is over (its validity of one hour has passed), or the verifier holds only an older copy because a new read failed. `detail` then holds the cause of the failed read.

An older copy is still checked. When it shows the agent revoked or suspended, the call is refused. A list that is read and is wrong (a bad signature, another URL, a value that the gateway never writes) refuses the call (`status.list`, `status.value`).

An identity credential is different. It is a public document that stays valid for a day, so a missing answer of its list cannot mean that the agent is valid. `verifier.credential` refuses with `credential.status_unknown` when the list cannot be read, when the list is over, and when the verifier holds only an older copy after a failed read. An older copy that shows a revocation or a suspension is refused with `credential.revoked` or `credential.suspended`.

A credential is also refused when its list is old (`credential.status_unknown`). The gateway serves its last list while it builds a new one, and while builds fail, so a list that the verifier has just read can be old. The option `maxCredentialListAgeSeconds` (1,200 by default) is the oldest list that a credential check accepts: the time since the issue time of the list. The gateway sets the issue time when a build ends, a build takes some minutes, and a list shows the status that the gateway read during that build. So, after the gateway sees a revocation, a credential can be accepted until the gateway has built a new list that shows it and the verifier has read that list. It is not accepted for longer than the limit plus the time of one build. A value below the `ttl` of the list throws a `TypeError`, because a list inside its `ttl` would be refused. A value that is not a number of seconds, 1 or more, throws a `TypeError` when the verifier is made. The default fits a gateway that builds the lists at least every 600 seconds, with a build of less than 600 seconds. A gateway with a longer interval needs a larger value. A call with an access token does not use this limit: it keeps the soft rule, and its `status.issuedAt` tells the age of the list.

After a failed read the reader does not ask again before a wait. The wait is 5 seconds, or the `Retry-After` of the answer when that is longer, and never more than 60 seconds. This holds for every failed read: a 503, another status, a network failure, a 200 answer whose list is refused (a bad signature, another URL), and a 200 answer whose list is over. Until the wait ends, the reader gives the same failure again. A list that was wrong stays a refusal, and it is never turned into a list that was not read. The same holds for the key set and the bundle. When a read did not work, the reader uses its older copy while that copy is valid. When a list is already older than its `ttl` at the time of the read, the reader reads again after 5 seconds, not after the `ttl`.

### When a status change shows

A status change reaches a verifier in steps, one after the other:

1. The gateway sees the change on the ledger. It gives the status Revoked or Retired only after 30 confirmations.
2. The status watcher of the gateway checks the agents that have live access tokens every 30 seconds. It revokes the tokens of an agent that is no longer Active.
3. The gateway builds the status lists at most once in each refresh interval (`STATUS_LIST_REFRESH_SECONDS`, 60 seconds by default). It serves a list as it is while the list is younger than the interval. After that, it serves its last list while a new build runs, and while it cannot build. A list is valid for one hour, and its `ttl` is the refresh interval.
4. The verifier keeps a list for its `ttl`. `listCacheSeconds` makes that time shorter. When a list is already older than its `ttl` at the time of the read, the verifier reads again after 5 seconds.

Each step adds time to the others. This document gives no total. A token is also honoured until 30 seconds after its `exp`, which is 330 seconds after it was issued, at most.

### The key set

The verifier keeps the key set of the gateway for 300 seconds (`keyCacheSeconds`) and then reads it again. When it cannot read the set again, it keeps its copy for one hour after the last read, and then it refuses with `keys.unavailable`. A token with a `kid` that the copy lacks makes the verifier read the set again, at most once in 30 seconds. So a new key of the gateway is accepted after that read. When the gateway removes or replaces a key, the verifier still accepts what the old key signed for up to 300 seconds, or for up to one hour when it cannot reach the gateway. The status lists and the credentials are signed by the same key, so the same time holds for them. The bundle is kept for its refresh hint (300 seconds, or `bundleCacheSeconds`) and, when it cannot be read again, for one hour.

### Checks that the caller supplies

The status lists do not show everything. A delegation has no entry in a list, and an actor other than the requester has none in the token. For a call that must never honour authority that ended, give the policy:

- `checkActors`: called with the DIDs of the actors, the principal when it is an agent, and the requester. `gatewayActorCheck(client)` resolves each one. An agent passes only when the answer is that of a live record (the gateway does not answer 410, the answer for a record that has ended) and its effective status is Active. An answer for an ended record is refused, whatever status its body gives.
- `checkDelegation`: called with the grant of the delegation, for a check of the whole chain on the ledger. It runs for a token that has a delegation.

A check that returns `{ ok: false }` or throws refuses the call (`actors.refused`, `delegation.refused`).

### What the verifier does not check

- It does not check a status change that has not reached a list yet (see "When a status change shows"), or the effective status of an actor, unless `checkActors` is given.
- It does not check the delegation on the ledger (the period, the value limit, the keys that the delegate still lists), unless `checkDelegation` is given. The gateway checks them when it issues a token, and a token is honoured for 330 seconds at most.
- It reads no DPoP nonce: the gateway sends none. It does not use introspection or revocation endpoints.
- An SVID has no status list entry. An X.509-SVID ends by its time (at most 1 hour). The verifier does not check that the agent of an SVID is still Active; resolve its DID for that. It does not check the extended key usage of a certificate, or the proof of possession of its key: the TLS layer does that.
- The store of used proofs is in memory. It does not stop a replay in another process, or after a restart (a proof is accepted only in a window of 5 minutes).
- It does not check the organisation of an agent.

## The stub gateway

`createStubGateway()` answers the routes that the client and the verifier call (key set, metadata, token endpoint with DPoP and delegation chains, SPIFFE nonce, X.509-SVID, JWT-SVID and bundle, both status lists, credentials, DID resolution) with the formats and the refusals of the gateway, in one process, with no network. Its keys are made by the test. `stub.fetch` is a `fetch` function and `stub.now` is its clock (fixed, and moved with `setNow` and `advance`): give both to the client and to the verifier.

```ts
const gateway = createStubGateway();
const reader = gateway.createAgent({ label: 'reader' });
const delegation = gateway.delegate({ delegator: { principalKey: ed25519Key('member') }, delegate: reader, actions: ['erp.*'], resources: [url] });
gateway.setStatus(reader, 'suspended');      // the Token Status List and the credential follow
gateway.endDelegation(delegation);            // the token endpoint refuses a new token
gateway.lists.freeze();                       // the lists stay as they are: age them with advance()
gateway.fault('/status/tsl/0', LISTS_UNAVAILABLE);   // the answer of the live gateway while it builds its lists
```

It has no `/introspect` and no `/revoke`. `gateway.requests` records every request. The tests of the stub (`test/stub-gateway.test.ts`) check its own rules.

## Test vectors from the live gateway

`scripts/capture-live-vectors.ts` reads the public documents of the live gateway with GET requests (key set, metadata, bundle, both status lists, and the credential of one public record) and writes them to `test/fixtures/live/` with `capture.json`. It makes no token request, signs nothing and reads no key. It waits for the lists when the gateway builds them. `test/live-vectors.test.ts` reads each document at the time of the capture. Run it again with `pnpm --filter @vsa/id-kit capture`; check the new files before you commit them.

## Commands

```bash
pnpm --filter @vsa/id-kit test
pnpm --filter @vsa/id-kit typecheck
pnpm --filter @vsa/id-kit capture
```
