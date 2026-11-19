# @vsa/id-kit

A client and a verifier for the identity gateway of the Vector chain (`https://id.vector.apexfusion.org`), and a stub gateway for tests.

- `@vsa/id-kit/client` (also the root): what an agent sends to the gateway to get a token, an SVID or its credential, and how it reads DID resolution.
- `@vsa/id-kit/verify` (also the root): what a relying party checks: an access token with its DPoP proof, both status list formats, an X.509-SVID, a JWT-SVID and an identity credential.
- `@vsa/id-kit/testing`: the stub gateway and test keys. No service imports it.

The gateway is the source of every wire format. `VENDORED-FROM.md` lists the three files of its code that this package copies byte for byte (the JOSE code, the DER code and the pattern rule of a delegation). A test fails when a copy changes.

```ts
import { createGatewayClient, createVerifier, presentToken } from '@vsa/id-kit';

// An agent asks for a token that covers a delegation, and calls a resource with it.
const client = createGatewayClient({ baseUrl: 'https://id.vector.apexfusion.org' });
const token = await client.requestToken({
  subject: { did, key: authenticationKey },   // a private KeyObject, or a sign function (SignerKey)
  dpopKey: delegateKey,                        // with a delegation: the Ed25519 delegate key of the leaf delegation
  resource: 'https://mock.example/t/1/erp',
  delegation: { identifier: delegationId },
});
if (!token.ok) throw new Error(`${token.rule}: ${token.detail}`);
const headers = await presentToken(token.value.accessToken, delegateKey, { method: 'POST', url });   // { authorization, dpop }

// A relying party checks a call.
const verifier = createVerifier({ baseUrl: 'https://id.vector.apexfusion.org' });
const call = await verifier.accessToken(
  { authorization: req.headers.authorization, dpop: req.headers.dpop, method: 'POST', url: publicUrl },
  { audience: 'https://mock.example/t/1/erp', require: { action: 'erp.stock.read', resource: 'https://mock.example/t/1/erp' } },
);
if (!call.ok) return refuse(call.rule);            // the rule that failed
if (!call.value.status.read) log(call.value.status.detail);   // a status list that was not read: see below
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

Every check returns `{ ok: true, value }` or `{ ok: false, rule, detail }`. The `rule` is a member of the list of that check (exported as `ACCESS_TOKEN_RULES`, `CALL_RULES`, `STATUS_LIST_RULES`, `X509_SVID_RULES`, `JWT_SVID_RULES`, `CREDENTIAL_RULES`, `KEY_SET_RULES` and `BUNDLE_RULES`). Each rule has a refusal and an accepted twin in the tests.

**Access token and DPoP proof** (`verifier.accessToken`), in this order:

| Rules | Check |
|---|---|
| `token.missing`, `token.scheme` | The `Authorization` header is `DPoP <token>`. A token that is sent as `Bearer` is refused. |
| `token.malformed`, `token.alg`, `token.typ`, `token.kid`, `token.signature` | A JWS, ES256, `typ` at+jwt, signed by a key of the key set of the gateway. A JWT-SVID, a status list or a credential is `token.typ`. |
| `token.issuer`, `token.audience` | `iss` is the gateway. `aud` names this resource. |
| `token.lifetime`, `token.expired`, `token.not_yet_valid` | `exp - iat` is from 1 to 300 seconds. The clock leeway is 30 seconds (`leewaySeconds`). |
| `token.claims` | `jti`, `sub`, `client_id` (a DID that is the current actor) and `cnf.jkt` are there. |
| `dpop.missing`, `dpop.multiple`, `dpop.malformed`, `dpop.typ`, `dpop.alg`, `dpop.key`, `dpop.signature`, `dpop.jti`, `dpop.method`, `dpop.url`, `dpop.iat`, `dpop.ath`, `dpop.binding` | The proof is one JWT of the right type, with a public key and a signature that verifies, for this method and URL, from the last 5 minutes, naming this token by its hash, and made by the key that `cnf.jkt` names. |
| `dpop.replay`, `dpop.replay_store` | A proof is accepted once. The store of used proofs fails closed when it is full. |
| `act.invalid`, `act.depth` | The `act` chain is a chain of DIDs, at most 4 deep (`maxActDepth`). |
| `delegation.details`, `delegation.missing`, `delegation.action`, `delegation.resource` | The authorization details name one delegation with valid patterns. If the policy gives `require: { action, resource }`, a pattern of the grant covers each (`x.*` covers `x.y`; `oc.*` does not cover `ocr.read`; `*` covers all; other patterns match exactly). |
| `status.claim` | The token names a position below 131,072 in a Token Status List of the gateway. |
| `status.revoked`, `status.suspended`, `status.value`, `status.list` | The entry of the agent that asked for the token in that list. |
| `actors.refused`, `delegation.refused` | The checks that the caller supplies (below). |
| `keys.unavailable`, `jwks.*` | The key set cannot be read, or it is wrong. |

The result of a call has `principal`, `actors` (the current actor first), `clientId`, `delegation` (the identifier and the patterns), `statusClaim`, `status` and the times.

**Status lists.** The Bitstring Status List holds both purposes in one list: bit `p` is revocation, and bit `131072 + p` is suspension. The Token Status List has 2 bits for each entry: 0 valid, 1 invalid (revoked), 2 suspended. A decode checks the signature, the issuer, that the list is the one that was asked for, the time and the encoding (`list.*`). Both are read with `decodeTokenStatusList`, `decodeBitstringStatusList`, `tokenEntryStatus` and `bitstringEntryStatus`.

**X.509-SVID** (`verifier.x509Svid`): the certificate chains to an authority of the bundle, is inside its validity (`x509.not_yet_valid`, `x509.expired`), is no CA, has the key usage digitalSignature and neither keyCertSign nor cRLSign, and has exactly one URI name that is a SPIFFE ID of an agent in this trust domain (`x509.malformed`, `x509.bundle`, `x509.untrusted`, `x509.ca`, `x509.key_usage`, `x509.san`, `x509.spiffe_id`, `x509.trust_domain`). The input is PEM, base64 of the DER (the form of a header that a proxy sets) or DER bytes.

**JWT-SVID** (`verifier.jwtSvid`): ES256, `typ` JWT, a key of the bundle, `sub` a SPIFFE ID of an agent in this trust domain, `aud` names this resource, a life of 5 minutes at most (`jwt_svid.*`).

**Credential** (`verifier.credential`): the signature, the issuer (the DID of the signing key), the contexts and types, the time, the subject, and the two status entries (revocation at `p`, suspension at `131072 + p`, in one list of the gateway). The verifier then reads that list and checks both bits: `credential.revoked`, `credential.suspended`. A credential that anybody changed is `credential.signature`.

### A status list that was not read

A status list that cannot be read (the gateway answers 503, as it does for some minutes after it starts, or the network fails) or that is old (its time of validity is over) does not refuse a call. The result says `status: { read: false, reason: 'unavailable' | 'stale', detail }`, so that the caller can write it to its log. A list that is read and is wrong (a bad signature, another URL) refuses the call (`status.list`). After a failed read the reader does not ask again before the wait that the gateway names (at least 5 seconds), and it uses its older copy while that copy is valid.

A status change shows when the list is built again. The gateway builds it every 60 seconds, and the reader keeps a list for its `ttl` (60 seconds), so a change shows within about two minutes. `listCacheSeconds` makes the reader keep a list for less time. An access token lives 5 minutes at most.

### Checks that the caller supplies

The status lists do not show everything. A delegation has no entry in a list, and an actor other than the requester has none in the token. For a call that must never honour authority that ended, give the policy:

- `checkActors`: called with the DIDs of the actors, the principal when it is an agent, and the requester. `gatewayActorCheck(client)` resolves each one and requires the effective status Active.
- `checkDelegation`: called with the grant of the delegation, for a check of the whole chain on the ledger. It runs for a token that has a delegation.

A check that returns `{ ok: false }` or throws refuses the call (`actors.refused`, `delegation.refused`).

### What the verifier does not check

- It does not check a status change that the gateway has not built into a list yet (see above), or the effective status of an actor, unless `checkActors` is given.
- It does not check the delegation on the ledger (the period, the value limit, the keys that the delegate still lists), unless `checkDelegation` is given. The gateway checks them when it issues a token, and a token lives 5 minutes.
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
