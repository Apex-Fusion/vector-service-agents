# Mock systems

The mock systems are stand-ins with synthetic data. They are the systems that the agents of three use cases call:

- use case 1 (inventory reorder): the ERP, the PO store and the supplier portal;
- use case 2 (prior authorization): the records system, the guidelines store and the insurer portal;
- use case 3 (supplier bid evaluation): the vendor master and the sourcing record.

One service serves all of them. It has no real data behind it. It holds no key and no wallet.

The service is for tests and for runs of the agents. Each run has its own **tenant**: its own data, its own writes and its own log.
The service checks who calls and with what right, like a real system would. It reads the identity gateway and the Vector ledger to do this.

## Routes

A tenant has the name `<tenant>`. The resource of a system is `<public base>/t/<tenant>/<system>`. `<public base>` is the setting `MOCK_PUBLIC_BASE`.

| Route | Need | System |
|---|---|---|
| `GET /healthz` | none, on any host, no log line | |
| `POST /admin/tenants` | the operator token | |
| `GET /t/<tenant>/state` | none | |
| `GET /t/<tenant>/log` | none | |
| `GET /t/<tenant>/erp/stock/{sku}` | token `erp.stock.read` on `erp`. The agent or its subagent calls. | ERP (use case 1) |
| `POST /t/<tenant>/po` | token `po.write` on `po`. The agent calls. | PO store (use case 1) |
| `GET /t/<tenant>/supplier/catalogue/{sku}` | X.509-SVID of an agent of the supplier organisation | Supplier portal (use case 1) |
| `POST /t/<tenant>/supplier/orders` | X.509-SVID of an agent of the supplier organisation | Supplier portal (use case 1) |
| `GET /t/<tenant>/records/orders/{order_id}` | token `record.read` on `records`. The agent or its subagent calls. | Records system (use case 2) |
| `GET /t/<tenant>/guidelines/{code}` | token `guideline.read` on `guidelines`. The agent or its subagent calls. | Guidelines store (use case 2) |
| `POST /t/<tenant>/records/orders/{order_id}/submission` | token `priorauth.submit` on `records`. The agent calls. | Records system (use case 2) |
| `GET /t/<tenant>/insurer/requirements/{service_code}` | JWT-SVID of an agent of the insurer organisation | Insurer portal (use case 2) |
| `POST /t/<tenant>/insurer/requests` | JWT-SVID of an agent of the insurer organisation | Insurer portal (use case 2) |
| `GET /t/<tenant>/vendors` | token `vendor.read` on `vendors`. The agent or its subagent calls. | Vendor master (use case 3) |
| `POST /t/<tenant>/sourcing/rankings` | token `sourcing.award.write` on `sourcing`. The agent calls. The approval check and the check of the top supplier come after the token. | Sourcing record (use case 3) |

"The agent calls" means that the act chain of the token has one agent. "The agent or its subagent calls" means that it has one or two.
A chain of three is refused on every route.

### What a write does

A body is JSON (`application/json`) of at most 1 MiB. It has the fields that the route names and no other. A field that is not named is a 400 with the path of the field.
A body that names a tenant must name the tenant of the URL.

| Route | Fields of the body | Rule of the write | Answer |
|---|---|---|---|
| `POST /po` | `schema` (`vector.usecase.po.v1`), `po_number`, `tenant`, `sku`, `lot` (`lot-small`, `lot-medium` or `lot-large`), `quantity`, `needed_by`, `supplier_did`, `advert_ref`, `stock_reading_sha256` | One order for each `po_number`. The case does not count. A second order is 409 `duplicate_po`. | 201 with `record_id`, `po_number`, `status`, `recorded_at` |
| `POST /supplier/orders` | `po_number`, `po_sha256`, `sku`, `lot`, `quantity`, `ship_by` | The SKU is in the catalogue (404 `sku_not_found`). One order for each `po_number` (409 `duplicate_po`). | 201 with `order_id`, `po_number`, `status`, `recorded_at` |
| `POST /records/orders/{order_id}/submission` | `request_number`, `intake_id`, `status` (optional) | The order exists (404 `order_not_found`). One submission for each `request_number` of an order (409 `duplicate_submission`). | 201 with `submission_id`, `order_id`, `request_number`, `intake_id`, `recorded_at` |
| `POST /insurer/requests` | `request` (an object with `schema` `vector.usecase.priorauth-request.v1`, `tenant`, `request_number` and `service_code`; the rest is kept as sent), `status` (`complete` or `incomplete`), `missing` | One entry for each `request_number` (409 `duplicate_request`). An incomplete request is filed as it is. | 201 with `intake_id`, `request_number`, `status`, `missing`, `received_at` |
| `POST /sourcing/rankings` | `ranking` (an object with `schema` `vector.usecase.ranking.v1`, `tenant`, `rfq_id` and a list `ranked` with exactly one entry of rank 1), `salt`, `approval` (`null`, or an object with `attestation` and `issuer_did`) | See below. | 201 with `ranking_id`, `rfq_id`, `top`, `recorded_at` |

The sourcing record takes a ranking in this order. The first failure ends the call:

1. The body is a ranking.
2. An `approval` of `null` is 403 `approval_not_found`.
3. The approval check passes for the ranking exactly as it was sent. A check that does not pass gives one of the codes `approval_*` (403). A check that fails to run is 503 `approval_unavailable`: a source that it reads cannot be read, or it does not answer in 30 seconds. The log line then has the rule `approval.failed` or `approval.timeout`. A late answer changes nothing.
4. The supplier of rank 1 resolves at the identity gateway and is Active now (403 `supplier_not_active`).
5. The tenant is still the one that the caller was verified for (409 `tenant_changed`).

The approval check is the check of the use-case kit. See "The approval check of a ranking".

## Tenants

`POST /admin/tenants` makes a tenant. The caller sends the operator token as `Authorization: Bearer <operator token>`, on the host of tokens.

```json
{ "tenant": "run1", "organisations": { "supplier": "alfa.example.org", "insurer": "delta.example.org" }, "seed": { "erp": [] } }
```

- `tenant` is 1 to 48 lower case letters, digits or hyphens. It starts with a letter or a digit.
- `organisations.supplier` is the organisation that an agent of the supplier portal must name in its record. `organisations.insurer` is the same for the insurer portal.
- `seed` is optional. It replaces whole parts of the data: `erp`, `catalogue`, `records`, `guidelines`, `requirements` and `vendors`. A part that it does not name keeps the default data. A name that is not a part is a 400.

The answer is 201 with `created: true` for a new tenant. It has `base`, `resources` (the resource of each system), `audiences` (the audience of a JWT-SVID) and `counts` (the entries of each part).

The same call with the name of a tenant that exists **resets** the tenant. The answer is 200 with `created: false`. The tenant is made again from its seed. Its writes and its log are gone.
A call that began before the reset, and checked its caller for the old tenant, is refused (409 `tenant_changed`). It writes nothing.

The service holds at most 100 tenants (409 `tenant_limit`). A tenant keeps the last 5,000 lines of its log. The field `dropped` of the log counts the lines that it lost.

`GET /t/<tenant>/state` gives the organisations, the seed data and every write. It holds no credential and no salt.
`GET /t/<tenant>/log` gives `{ tenant, dropped, lines }`. See "The log".

### What the default seed holds

All the data is synthetic.

| Part | Default data |
|---|---|
| `erp` | 3 stock readings. `GLV-NIT-M` and `MSK-N95` are below their threshold. `SYR-10ML` is above it. |
| `catalogue` | 3 lines of the supplier, one for each SKU. The supplier holds 150 of `MSK-N95`, which is less than its large lot of 400. Each line gives the sizes of the three lots. |
| `records` | 2 clinical orders with their records. `ORD-1001` (lumbar spine) meets its guideline. `ORD-1002` (knee) does not. |
| `guidelines` | 2 guidelines, `SYN-MRI-LS` and `SYN-MRI-KN`, each with 4 criteria. |
| `requirements` | 2 sets of intake requirements, one for each service code, each with 5 requirements. |
| `vendors` | 3 vendors, `V-1001` to `V-1003`. They differ in delivery rate, defect rate, years as a vendor, payment terms and certification. |

## The two hosts and the header Client-Cert

The service has two host names. It tells them apart by the `Host` header.

| Host | Setting | Routes |
|---|---|---|
| The host of tokens | `MOCK_PUBLIC_BASE` | Every route, except the X.509 routes. Callers send access tokens and JWT-SVIDs here. |
| The client-certificate host | `MOCK_MTLS_BASE` | The X.509 routes only: `GET /supplier/catalogue/{sku}` and `POST /supplier/orders`. |

A route on the wrong host is 421 `wrong_host`. A `Host` header that names neither host is 421 too. A request with two `Host` headers is 400.
The check of health answers on any host.

A reverse proxy stands in front of the service. On the client-certificate host, the proxy asks the client for a certificate.
It passes the certificate to the service in one header: `Client-Cert: :<base64 of the DER of the certificate>:`.
The proxy removes any `Client-Cert` header that a client sends. See [deploy/server/README.md](../../deploy/server/README.md) for the proxy and the exact form of the header.

The service refuses:

- a `Client-Cert` header on the host of tokens (400 `client_certificate_unexpected`);
- more than one `Client-Cert` header (400 `client_certificate_multiple`);
- a value that is not in the form of the header (400 `client_certificate_malformed`).

A `Client-Cert-Chain` header is never read.

## What the service checks

### Order of a call

The first failure ends the call.

1. `GET /healthz` answers at once. It writes no line.
2. The request has one `Host` header, and it names one of the two hosts.
3. A `Client-Cert` header on the host of tokens is refused.
4. The route exists for the method (404, 405), and the host fits the route (421).
5. The tenant exists (404 `tenant_not_found`). No credential is read for a tenant that does not exist.
6. The credential meets the need of the route. See below.
7. A POST has a JSON body of at most 1 MiB. The service reads it only now, after it verified the caller.
8. The tenant is still the one that the caller was verified for (409 `tenant_changed`).
9. The route reads the document, applies the rules of its write and answers.

A call that cannot be checked is refused, and the answer is 503. The service never takes a gateway that it cannot read, or a ledger that it cannot read, as a pass.

### A token

A token is an access token of the identity gateway with a DPoP proof. The call sends `Authorization: DPoP <token>` and one `DPoP` header. The checks, in order:

1. The `Authorization` header has the scheme `DPoP` and a token.
2. The signature is valid against the key set of the gateway. The service reads the key set again every 300 seconds, and when a token names a key that it does not hold. When a new copy cannot be fetched (no answer, an error status, or a body that is not JSON), the verifier goes on with its old copy for up to one hour after the last good read. After that it refuses the call (503 `gateway_unavailable`). When the gateway answers with a key set that has no usable key, the service refuses the call at once.
3. The issuer is the gateway.
4. The audience is the resource of the route: `<public base>/t/<tenant>/<system>`. The comparison is exact.
5. The time: the life of the token is at most 5 minutes, it has not ended, and it is not from the future. The verifier accepts a clock difference of 30 seconds.
6. The DPoP proof: its key is the key that the token is bound to, it is for this method and this URL (the public URL, with no query), it names this token by its hash, and its time is in the window. The service accepts a proof once.
7. The act chain is a chain of agent DIDs, and it is no deeper than the route takes.
8. The delegation of the token covers the action and the resource of the route. The service asks for them as whole texts. The grant covers them when it names them, or names a pattern of a delegation that covers them, for example `erp.*` or `*`. A text that is only a prefix covers nothing: `erp.stock` does not cover `erp.stock.read`, and `<public base>/t/a` does not cover `<public base>/t/ab`.
9. The Token Status List entry of the agent that asked is not revoked and not suspended. A list that cannot be read, or that is old, does not refuse the call. The log line says so.
10. Each agent of the act chain, and the agent that asked, resolves at the gateway and is Active now. The service resolves each DID at each call.
11. The whole chain of the delegation is usable on the ledger now, for this action and this resource. The service reads the node and the indexer of Vector for this. A check that takes more than 20 seconds is refused.

### An X.509-SVID

The route is on the client-certificate host. The checks, in order:

1. The request has exactly one `Client-Cert` header, in the form `:<base64>:`.
2. The value holds exactly one certificate, and the certificate that the service verifies is the whole value. The service refuses bytes after the certificate, and a certificate that holds the PEM text of another certificate. Each is 401 `svid_invalid`, and the log line has the rule `x509.malformed`.
3. The certificate was issued by an authority in the SPIFFE bundle of the gateway. The service reads the bundle again every 300 seconds. When a new copy cannot be fetched (no answer, an error status, or a body that is not JSON), the verifier goes on with its old copy for up to one hour after the last good read, and then it refuses the call (503 `gateway_unavailable`). When the gateway answers with a body that is not a bundle, the service refuses the call at once.
4. The certificate is valid now. The verifier accepts a clock difference of 30 seconds at the start.
5. The certificate is a leaf (it is no CA). Its key usage has `digitalSignature`, and has neither `keyCertSign` nor `cRLSign`.
6. The certificate has exactly one URI name. It is a SPIFFE ID of the form `spiffe://<trust domain>/agent/<64 hex characters>`, and the trust domain is the one of the gateway.
7. The agent of that ID resolves at the gateway and is Active now.
8. The record of the agent names the supplier organisation of the tenant, in an Accountable Party that is in force now, and the gateway has verified that organisation (`organisationVerified`). The organisation is compared as a domain name, in any case, and only as a whole name.

### A JWT-SVID

The route is on the host of tokens. The call sends `Authorization: Bearer <JWT-SVID>`. The checks, in order:

1. The `Authorization` header has the scheme `Bearer` and a JWT. A request with two `Authorization` headers is a 400.
2. The signature is valid against a JWT key of the SPIFFE bundle of the gateway, and the type is `JWT`.
3. `sub` is a SPIFFE ID of an agent, in the trust domain of the gateway.
4. The audience is `<public base>/t/<tenant>/insurer`. The comparison is exact.
5. The time: the life is at most 5 minutes, it has not ended, and it is not from the future. The clock difference is 30 seconds.
6. The agent of the ID resolves and is Active now.
7. The record of the agent names the insurer organisation of the tenant, in an Accountable Party that is in force now, and the gateway has verified that organisation.

An access token is not a JWT-SVID, and a JWT-SVID is not an access token. Each route takes one kind only.

### The operator token

The operator token is the value of `MOCK_OPERATOR_TOKEN`. The service compares it in constant time. A missing token and a wrong token are both 401 `operator_token_invalid`.
The token goes in the `Authorization` header only. A query string, a cookie or another header does not carry it.

### The approval check of a ranking

The service runs the approval check of the use-case kit (`@vsa/usecase-kit/checks`) and takes its answer as it is. It gives the check the agent that calls, the delegation of the token, the reference of the approval, the ranking exactly as it was sent, the salt and the time of the call. `src/wiring.ts` is the one place that wires the check to the service.

The check reads the Vector ledger. It uses the node and the indexer of the settings `VECTOR_OGMIOS_URL` and `VECTOR_KOIOS_URL`, and the deployment of the three settings `VECTOR_IDENTITY_*`. It reads:

- the attestation that `approval.attestation` names;
- the delegation of the token, and its parents up to the root delegator;
- the record of the issuer of the attestation, and its ancestors, when the attestation names an issuer record.

It does not read the identity gateway. The checks run in this order. The first failure is the answer:

1. The attestation exists and is authentic (403 `approval_not_found`).
2. It is an approval (403 `approval_wrong_type`).
3. Its subject is the agent that calls (403 `approval_wrong_subject`).
4. Its issuer is the root delegator of the delegation of the token (403 `approval_wrong_issuer`). When the attestation names an issuer record, `approval.issuer_did` must name the same record.
5. It is valid now by the rule of the registry. It is not revoked (403 `approval_revoked`). The time of the call is in its time window (403 `approval_expired`). The signature of its envelope verifies, when it has one. The record of its issuer was not invalid when the issuer made it (403 `approval_issuer_invalid`).
6. Its digest is SHA-256 of the salt and the canonical form of the ranking (403 `approval_digest_mismatch`). The canonical form has the keys in order and no white space. So the order of the keys in the body does not matter, and the change of one value does.

A source that cannot be read gives 503 `approval_unavailable` and the rule `approval.failed`. The message names the source: the attestation or the delegation. A source cannot be read when the node or the indexer gives no answer, an error status or a body that the client cannot read, and when a read takes more than 12 seconds. The check never takes such a source as a pass.
One limit: the node client of `packages/buyer-core` reads an answer of the node that has no list of outputs (for example `"result": null`) as an empty list. Such an answer gives the 403 code that an empty ledger gives (for example `approval_not_found`), not 503. It is a refusal, never a pass.
The two reads of the check come one after the other, and each has its own budget of 12 seconds. So the check ends by itself inside the 30 seconds that the service waits for it.
A ranking that a digest cannot bind makes the check fail to run, and the answer is 503 too. These are: a key that is a whole number, the key `__proto__`, a key that is not in the NFC form, a number that is not finite, and more than 32 levels of objects.

## Refusals

A refusal is a typed result. Its body is `{ "error": "<code>", "message": "<words>" }`. A caller reads the code and the status. The message tells a person what to change.
A 401 has a `WWW-Authenticate` header (`DPoP algs="ES256 EdDSA"` for a token, `Bearer` for a JWT-SVID and for the operator token). A 405 has an `Allow` header.

| Code | Status | Meaning |
|---|---|---|
| `token_invalid` | 401 | The token or its proof is missing or not valid. |
| `not_covered` | 403 | The delegation of the token does not cover the action or the resource of the route, or the token has no delegation. |
| `delegation_ended` | 403 | The ledger does not show the delegation as usable now. |
| `chain_too_deep` | 403 | The act chain is deeper than the route takes. |
| `actor_not_active` | 403 | An agent of the act chain is not Active. |
| `svid_missing` | 401 | The request has no certificate, or no JWT-SVID. |
| `svid_invalid` | 401 | The SVID is not valid. The log line has the rule. |
| `agent_not_active` | 403 | The agent of the SVID does not resolve, or it is not Active. |
| `organisation_mismatch` | 403 | The record of the agent does not name the organisation of the tenant. |
| `organisation_unverified` | 403 | The record names the organisation, and the gateway has not verified it. |
| `approval_not_found` | 403 | The ranking has no approval, or the approval does not exist. |
| `approval_wrong_type` | 403 | The attestation is not an approval. |
| `approval_wrong_subject` | 403 | The approval names another agent as its subject. |
| `approval_wrong_issuer` | 403 | The approval does not come from the root delegator of the delegation. |
| `approval_revoked` | 403 | The approval is revoked. |
| `approval_expired` | 403 | The approval is not valid now. |
| `approval_issuer_invalid` | 403 | The record of the issuer is not valid. |
| `approval_digest_mismatch` | 403 | The digest of the approval is not the digest of the ranking and the salt. |
| `supplier_not_active` | 403 | The supplier of rank 1 does not resolve, or it is not Active. |
| `wrong_host` | 421 | The host does not fit the route, or it is not one of the two hosts. |
| `client_certificate_unexpected` | 400 | A `Client-Cert` header came to the host of tokens. |
| `client_certificate_multiple` | 400 | The request has more than one `Client-Cert` header. |
| `client_certificate_malformed` | 400 | The `Client-Cert` header is not in the form of the contract. |
| `operator_token_invalid` | 401 | The operator token is missing or wrong. |
| `gateway_unavailable` | 503 | The identity gateway could not be read. |
| `ledger_unavailable` | 503 | The ledger could not be read. |
| `approval_unavailable` | 503 | The approval check failed to run: a source that it reads (the attestation or the delegation on the ledger) could not be read, or it did not answer in 30 seconds, or it gave an answer that is not a pass and is not a refusal. |
| `service_busy` | 503 | The store of used proofs is full. Send the call again later. |
| `bad_request` | 400 | The request is not as the route needs. The message names the field. |
| `not_found` | 404 | No such route. |
| `method_not_allowed` | 405 | The path does not take this method. |
| `tenant_not_found` | 404 | The tenant does not exist. |
| `sku_not_found` | 404 | The ERP or the catalogue has no such item. |
| `order_not_found` | 404 | The records system has no such order. |
| `guideline_not_found` | 404 | The guideline store has no such guideline. |
| `requirements_not_found` | 404 | The insurer portal has no requirements for the service code. |
| `duplicate_po` | 409 | An order for this purchase order number exists. |
| `duplicate_request` | 409 | An entry for this request number exists. |
| `duplicate_submission` | 409 | A submission for this request number of the order exists. |
| `tenant_limit` | 409 | The service holds the most tenants that it takes. |
| `tenant_changed` | 409 | The tenant was made again while the call ran. Send the call again. |
| `body_too_large` | 413 | The body is larger than 1 MiB. |
| `unsupported_media_type` | 415 | The body of the route is `application/json`. |
| `internal` | 500 | The service failed. The call was not honoured. |

## The log

Each call writes one line of JSON on stdout. The check of health writes none. A call to a system of a tenant is also in the log of the tenant (`GET /t/<tenant>/log`).
It is the same line. A read of the state or of the log is on stdout and not in the log of the tenant.

| Field | Meaning |
|---|---|
| `at` | The time of the call, as an ISO 8601 text. |
| `tenant` | The tenant of the URL, or `null`. |
| `route` | The route without the prefix `/t/<tenant>`, for example `POST /po` or `GET /erp/stock/{sku}`. It is `null` when no route was found. |
| `method`, `path` | The method, and the path with no query. |
| `host` | `token`, `mtls` or `other`. |
| `credential` | `token`, `x509-svid`, `jwt-svid`, `operator` or `none`. |
| `sub` | The identity that the service verified: the subject of a token, or the SPIFFE ID of an SVID. `null` when nothing was verified. |
| `act` | The act chain of a token, with the agent that asked first. An empty list for an SVID. |
| `delegation` | The identifier of the delegation of a token. `null` for an SVID. |
| `decision` | `allowed` or `refused`. |
| `status`, `code`, `rule` | The HTTP status, the code of the refusal and the rule that refused. `code` and `rule` are `null` for an allowed call. |
| `token_status` | For an allowed token call: the age of the status list that the service read, or why it did not read one. |

A field of the identity holds a fact that the service verified. A token whose signature does not verify shows no `sub`, no `act` and no `delegation`.
No line holds a token, a DPoP proof, a JWT-SVID, the bytes of a certificate or the operator token.

The service writes three more lines. `listening` is the line of the start. `stopping` and `stop_failed` are the lines of the stop. A failure of the service writes a line with the field `event` set to `error`.

## Settings

The service reads its settings from the environment at the start. A wrong value stops the start. The error names the variable. It never shows the operator token.

| Name | Required or default | Meaning |
|---|---|---|
| `MOCK_PUBLIC_BASE` | required | The https origin of the host of tokens, for example `https://mock.example.org`. No path, no query. |
| `MOCK_MTLS_BASE` | required | The https origin of the client-certificate host. It is another host than `MOCK_PUBLIC_BASE`. |
| `MOCK_OPERATOR_TOKEN` | required | The token of `POST /admin/tenants`: 32 to 128 characters of letters, digits and `. _ ~ + / = -`. It is the one secret of the service. |
| `IDENTITY_GATEWAY_URL` | `https://id.vector.apexfusion.org` | The origin of the identity gateway. |
| `VECTOR_OGMIOS_URL` | `https://ogmios.vector.mainnet.apexfusion.org` | The node that the checks of a delegation and of an approval read. |
| `VECTOR_KOIOS_URL` | `https://v2.koios.vector.mainnet.apexfusion.org` | The indexer that the checks of a delegation and of an approval read. |
| `VECTOR_IDENTITY_LEGACY_ROOT` | required | A published value of the identity registry deployment that the two checks read. |
| `VECTOR_IDENTITY_CONFIG_SEED` | required | A published value of the same deployment. |
| `VECTOR_IDENTITY_POLICY_ID` | required | The policy that the two values give. The start checks it, so that a value with a typo stops the start. A read with the wrong deployment would find no delegation and no attestation, and the service would refuse every call. |
| `PORT` | `9120` | The port of the service. |
| `HOST` | `127.0.0.1` | The address of the service. The image sets `0.0.0.0`. |

The operator token must be in `MOCK_OPERATOR_TOKEN` only. The start refuses a token that it finds in another setting.

## Start and stop

```sh
corepack pnpm --filter @vsa/mock-systems start
```

The production start wires the approval check of the use-case kit to the ledger, the gateway client and the clock of the service (`src/wiring.ts`). The start needs no answer of the gateway, the node or the indexer: the first call reads them.
A start for which the wiring gives no approval check **refuses**. It writes `[mock-systems] cannot start: ...` on stderr, opens no port and exits with 1. The real wiring always gives a check. A test can pass a wiring that gives none.

The image is built from the root of the repository:

```sh
docker build -f services/mock-systems/Dockerfile -t mock-systems .
```

The service in the image listens on `0.0.0.0:9120`. The compose file of the host publishes the port on `127.0.0.1` only. `GET /healthz` is the health check of the image.

The service stops on SIGTERM and on SIGINT. `docker stop` sends the first. A stop takes no new connection, closes the connections that are idle, and gives a call that runs 5 seconds.
The process then exits with 0. It exits with 1 when the stop fails.

## Tests

```sh
corepack pnpm --filter @vsa/mock-systems test
corepack pnpm --filter @vsa/mock-systems typecheck
```

The tests use no network. They run the service on `127.0.0.1`, with the stub gateway of `@vsa/id-kit/testing` and a ledger of fixture data from `packages/buyer-core`.
Most tests give the service a fake approval check. It exists in the test support only. The tests in `test/wiring.test.ts`, and the last tests in `test/ranking.test.ts`, run the real check of the kit on the fixture ledger: the member issues an approval as an attestation, and the check reads it.

## What the service does not verify

- **An approval beyond the check of the kit.** The service takes the answer of the approval check as it is. It adds no check of an approval. The check reads the node and the indexer that the settings name, and it takes what they show as the state of the ledger. The service does not compare their answers with another source. A source that cannot be read gives 503 `approval_unavailable`, and never a pass.
- **A second use of a JWT-SVID.** A JWT-SVID can be used again within its lifetime. The service does not record the SVIDs that it saw.
- **The end of a token or an SVID.** A token is honoured up to 30 seconds after `exp`, and a JWT-SVID up to 30 seconds after its end. This is the clock difference that the verifier accepts. The check of the ledger still refuses an ended delegation in that time. An X.509-SVID gets no time after its end. At its start, a certificate is accepted 30 seconds early.
- **A key or an authority that the gateway removed.** The verifier reads the key set and the bundle every 300 seconds. While a new copy cannot be fetched, it uses its old copy for up to one hour after the last good read. So a key or an authority that the gateway removed stays trusted for up to one hour in that time.
- **The width of a delegation.** A delegation with the grant `*` on `*` covers every token route of every tenant, within the depth of the chain that each route takes. The organisation that delegates decides how wide its delegation is.
- **Where an SVID is honoured.** A JWT-SVID with two audiences is honoured at both. One X.509-SVID is honoured at every tenant whose organisation for that route is the organisation of the agent.
- **A second ranking.** The same ranking with the same approval can be written again. A ranking has no one-for-each rule.
- **A status list that is not read.** A status list that cannot be fetched (the gateway does not answer, or it answers with an error status), or that is over, does not refuse a token call. The log line says that the list was not read (`token_status`). A list that arrives and is not valid, for example a body that is not a list, refuses the call (401 `token_invalid`, rule `status.list`).
- **The client certificate.** The proxy proves that the client holds the key of its certificate. The service does not. So the service must be reachable through the proxy only. A client that reaches the service directly can send any `Client-Cert` header.
- **Direct clients.** Every process of the host that can open `127.0.0.1:9120` is a direct client. It can send the bytes of the certificate of any SVID with no key, and any `Host`. So the host runs nothing that is not trusted, the port is on the loopback address only, and no other container shares the network of the service.
- **The data.** The data of the tenants is in memory. A restart of the service loses it.

## Source files

| File | Use |
|---|---|
| `src/app.ts` | The HTTP side, the order of a call and the log line. |
| `src/identity.ts` | The decisions about the caller: a token, an SVID and the top supplier. |
| `src/routes.ts` | The routes, the need of each route and the handler of each route. |
| `src/tenants.ts` | The tenants, the writes and the log of a tenant. |
| `src/documents.ts`, `src/validate.ts`, `src/seed.ts` | The readers of the bodies and of the seed, and the default data. |
| `src/approval.ts`, `src/wiring.ts` | The shape of the approval check and the decision on its answer, and the one place that wires the check of the use-case kit to the service. |
| `src/config.ts`, `src/start.ts`, `src/index.ts`, `src/ledger.ts` | The settings, the start and the stop, the entry and the reads of the ledger. |
| `src/errors.ts` | The codes of the refusals and their statuses. |
