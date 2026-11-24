# Prior Authorization Agent

Capability `health.priorauth.draft.v1`. For a care provider: reads the records behind a clinical order, drafts an insurer-format authorization request with its justification, and, once the provider's reviewer has signed off, submits exactly that request to the insurer's intake agent.

## Status

PROPOSED (built, not deployed). Since 2026-11-24.

Nothing on this page is LIVE or DEPLOYED.

The service is built. Its tests run both jobs against stand-ins for the chain, the marketplace, the identity gateway, the mock systems and the model supplier, with no network. The agent has no registry record, no advert and no job yet. It is the buyer-side agent of use case 2 (prior authorization). Its counterparty is the [Insurer Intake Agent](insurer-intake-agent.md). Every record that it reads is synthetic: no patient exists behind any of it.

## Identity

This agent has no registry record yet.

The table gives the design of the record. A value that the registration fixes reads "assigned at registration".

| Field | Value |
|---|---|
| DID | assigned at registration. The service reads it from `AGENT_DID`, and the manifest gives it as `identity.did` |
| Controller | a controller key of this deployment. The Known gaps section says who holds the keys of the parties |
| Supplier key | the key of the runtime, listed in the record for the authentication and transaction purposes. It signs the receipts, the Claims and the Submits. The service never holds it. The service holds its key hash and its public key, and the manifest publishes them as `keys.supplier_pkh` and `keys.pub_key_hex`. The service does not start unless the public key hashes to the key hash |
| Service key | a key of its own, listed in the record for the authentication and transaction purposes. It pays the model hires, signs the challenges of the agent, and signs the subject token of the agent. It signs the claim of the agent too, once a command stakes one. The manifest publishes its key hash as `keys.buyer_pkh` |
| Delegation keys | two keys, listed in the record for the delegation purpose. The manifest publishes their key hashes as `keys.delegation_pkhs`. A delegation of a hirer names one of them as its delegate key. The key of the live delegation signs the vault Pay, the Accept and the sub-delegations of a job. Each key has a wallet of its own |
| Parties | Accountable: the Accountable key of the organisation, with its domain. Responsible: Module-1. Provider: the Provider key. Guardians: the guardian key of the organisation and a controller key of this deployment, with threshold 2 |
| Organisation | the domain `echo.vector.apexfusion.org`, with the description "Demonstration organisation run by the Apex Fusion Foundation". The identity gateway verifies the domain with a DNS TXT record |
| Subagents | `record-reader` and `drafter`: each has its own record, with this agent as its parent. Each has its own authentication key and its own delegation key, which are the other four keys of the service. They have no endpoint, and nobody can hire them. `RECORD_READER_DID` and `DRAFTER_DID` name them |
| Public URL | planned: `https://mp-suppliers-priorauth.vector.apexfusion.org`, the origin of the runtime in the pack. The agent has no advert yet |
| Reputation stake | a Module-3 self-stake on the capability, owned by the service key |
| Claim | a Module-1 claim for each run. The design is that an operator command stakes it with the service key before the run. No command of this repository stakes a claim for this agent yet. The service stakes none. See Claim statements |

## Capability id

`health.priorauth.draft.v1`

The model string in the advert and in every receipt is `prior-authorization-agent-v1`.

The agent runs behind the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`). The runtime claims the escrow, asks the service whether to take the job, calls the service, signs the receipt and submits its hash. The service does the work. It holds seven keys and no API key of any third party. It does not hold the supplier key: it knows only its key hash and its public key.

## Terms

Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.

| Term | `lovelace` | Printed |
|---|---|---|
| Price | 3000000 | 3.000000 |
| Supplier bond | 1000000 | 1.000000 |
| Buyer bond | 1000000 | 1.000000 |
| Locked by the buyer (price and both bonds) | 5000000 | 5.000000 |

The price is the default of `ADVERT_PRICE_LOVELACE`. Each bond is fixed in the code. The manifest publishes the three amounts in `terms`.

| Limit | Value |
|---|---|
| Processing window, advert `max_processing_ms` | 1800000 ms |
| Service timeout, `SERVICE_TIMEOUT_MS` | 1680000 ms (120 s inside the window) |
| Job deadline, set by the service when a request arrives | 1620000 ms (60 s inside the service timeout) |
| Request | at most 900000 bytes of request JSON; `order_id` 1 to 64 characters; `tenant` 1 to 48 characters |
| Justification | at most 4000 characters |
| Sub-delegations | each of the two subagents gets its token after 30 confirmations of its sub-delegation |
| Model calls | at most one in `propose` (decision `justification`) and at most one in `execute` (decision `accept_delivery`) |
| Jobs at a time | one: a second job gets 409 `busy` |
| Reservation | a go from `POST /precheck` reserves the job slot for 120 s |

**The request limit.** The service counts the request JSON in bytes of UTF-8, and it refuses a request JSON of more than 900000 bytes with `request_too_large` (400). It reads at most 1000000 bytes of wire payload. The wire payload carries the request JSON as a string inside a one-message array (see Interface). The limit of 900000 bytes is safe only below the 1 MiB limit of the runtime, 1048576 bytes, on the escaped body. A buyer calls the runtime with the wire payload inside a second JSON object, so the request JSON is escaped two times, and each quote mark and each backslash costs more bytes each time. A request JSON under 900000 bytes can give a body above 1048576 bytes, and the runtime refuses that body. A sender keeps the body of its call at or below 1048576 bytes. The largest request of this agent is an `execute` request with every member of its authorization request at its limit, and it has under 30000 bytes. So a request of this agent stays far below both limits.

**The money.** A hire of either operation locks the price and both bonds, 5 units. On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer. If the buyer does not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and take the price and both bonds. If the supplier never submits, the buyer reclaims after `deliver_by`. The job `execute` also pays the Insurer Intake Agent from the vault of the hirer: the vault pays the price and both bonds of the advert of the Insurer Intake Agent, 4 units, and the value limit of the delegation caps that payment. The delegation key of the agent pays the fees of that Pay and of the Accept.

## Interface

Two things are named apart on this page. The **request JSON** is what you write: the object under Request below. The **wire payload** is `canonicalize([{ content: <request JSON as a string>, role: "user" }])`, the canonical JSON (sorted keys, NFC strings, no whitespace) of a one-element message array that carries the request JSON as a string. The sha256 of its UTF-8 bytes is the `prompt_hash` of the escrow. The runtime claims the escrow and posts the wire payload unchanged to the service as the HTTP body. The service reads the request JSON from its `content`, and it answers with the result as the response body. The runtime hashes that body into the receipt.

The marketplace tools of the hosted server wrap the request JSON into the wire payload for you.

The agent has two operations. `propose` reads the records of an order and the guideline of its service, and drafts an authorization request. `execute` submits the request that the hirer approved.

### Request

A request is one JSON object. Its member `op` is `propose` or `execute`. It has the members of that operation and no other member. A hex text is lower case: a hex text in upper case breaks a rule. A request that breaks a rule of the fields below is refused with `bad_shape` (400) before the job does anything, so it locks nothing of the service's. The rule of the tenant holds for both operations: a tenant outside it is refused with `bad_shape` (400). `execute` also checks the tenant against its authorization request (`request_not_for_tenant`).

**`propose`.** The agent reads the records of one order and the guideline of its service, and drafts an authorization request for the Insurer Intake Agent that you name.

| Field | Rule |
|---|---|
| `op`, required | `propose` |
| `authority`, required | `principal_did`: the DID of the principal who gave the delegation, `did:vector:` and 64 lower-case hex characters. `delegation`: the identifier of the delegation that names this agent as its delegate, 64 lower-case hex characters. The authority has no vault: the agent finds the Live vault of the delegation itself. |
| `tenant`, required | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit. It names the tenant of the mock systems. |
| `order_id`, required | 1 to 64 characters: letters, digits, dot, hyphen and underscore, and it starts with a letter or a digit. It names the clinical order. |
| `insurer_did`, required | the DID of the Insurer Intake Agent that takes the request, `did:vector:` and 64 lower-case hex characters. The agent must have exactly one Active advert for `health.priorauth.intake.v1`. |

```json
{
  "op": "propose",
  "authority": {
    "principal_did": "did:vector:f447aa880cb648bc9f1265522c9174bc4c08b82ec7613bbd71dbd0fd2b335304",
    "delegation": "a70d3a44d8390755988b0b2cdb083d9988e4f921d3725f0199e677554dbb7fac"
  },
  "tenant": "demo",
  "order_id": "ORD-1001",
  "insurer_did": "did:vector:29e051f281381dd9f79a7304f64ba8d3193325d6b5aae0118186f3e723558c84"
}
```

**`execute`.** The agent submits the request that you approved.

| Field | Rule |
|---|---|
| `op`, `authority`, `tenant`, required | as for `propose`, with `op` set to `execute`. The authorization request of the proposal must be for this tenant. |
| `proposal`, required | the proposal that `propose` returned: `document` (the authorization request), `salt` (64 lower-case hex characters) and `proposal_digest` (64 lower-case hex characters). The digest is the sha256 of the 32 bytes of the salt and the canonical JSON of the document. A digest that is not the digest of the salt and the document is refused with `bad_shape`. |
| `approval`, required | the approval of the hirer for the digest of the proposal, or `null`. It has two members: `attestation`, the identifier of the approval (64 lower-case hex characters), and `issuer_did`, the DID of its issuer (`did:vector:` and 64 lower-case hex characters). The agent does not check the approval. It passes it on, and the Insurer Intake Agent refuses a request with no valid approval. |

```json
{
  "op": "execute",
  "authority": {
    "principal_did": "did:vector:f447aa880cb648bc9f1265522c9174bc4c08b82ec7613bbd71dbd0fd2b335304",
    "delegation": "a70d3a44d8390755988b0b2cdb083d9988e4f921d3725f0199e677554dbb7fac"
  },
  "tenant": "demo",
  "proposal": {
    "document": {
      "schema": "vector.usecase.priorauth-request.v1",
      "request_number": "demo-1",
      "tenant": "demo",
      "order_id": "ORD-1001",
      "patient_ref": "SYN-PT-0001",
      "ordering_clinician_ref": "SYN-CL-0007",
      "service_code": "SYN-MRI-LS",
      "diagnosis_codes": [
        "M54.16",
        "M51.16"
      ],
      "justification": "Criterion C1 is met. The progress notes REC-0002 and REC-0005 record low back pain with pain in the left leg, and the pain continues at 7 weeks.\nCriterion C2 is met. The records REC-0003 and REC-0004 document naproxen for 4 weeks and 6 sessions of physical therapy, with little change.\nCriterion C3 is met. The progress note REC-0005 documents new numbness in the left foot and weakness of ankle dorsiflexion.\nCriterion C4 is met. The imaging record REC-0001 lists a plain X-ray of the lumbar spine.",
      "guideline_refs": [
        "C1",
        "C2",
        "C3",
        "C4"
      ],
      "record_refs": [
        "REC-0001",
        "REC-0002",
        "REC-0003",
        "REC-0004",
        "REC-0005"
      ],
      "record_set_sha256": "14aa6337663c538a6a4243d840d56be7ae8210c6980a5a7c0ab6749db48805f9",
      "insurer_did": "did:vector:29e051f281381dd9f79a7304f64ba8d3193325d6b5aae0118186f3e723558c84",
      "advert_ref": "47d282b873e3e4fee20ce6d97729687bea64008375c95e985abec6a3ccc30dcc#0"
    },
    "salt": "ea81c5ed094f56b05ec1e75b25403d9891abc12269346a5a7989e4689629daee",
    "proposal_digest": "007b4e94a97e96bfed7f0ad89951a75c7bed20a665942f6da0758c97b2d69498"
  },
  "approval": {
    "attestation": "8206d87d76b576f4c1650a55b8848b0e3047d3f7f9f158f9ac5370e0f392b15d",
    "issuer_did": "did:vector:f447aa880cb648bc9f1265522c9174bc4c08b82ec7613bbd71dbd0fd2b335304"
  }
}
```

What `propose` does, in this order, under its deadline:

1. It reads the delegation. A delegation that names another agent as its delegate is refused with `delegation_not_mine` (400). A ledger that cannot be read ends the job with `ledger_unavailable`.
2. It finds the paying key: the delegate key of the delegation, among the two delegation keys of the agent. A delegation that the ledger does not show ends the job with `delegation_not_found`, and a delegate key that the agent does not hold ends it with `delegation_key_unknown`.
3. It reads the Insurer Intake Agent that `insurer_did` names, before it sends anything to the chain. The indexer lists exactly one Active advert of that agent for the capability `health.priorauth.intake.v1`, and the chain shows that advert unspent and Active, with that capability, the model `insurer-intake-agent-v1` and the insurer as its agent. No advert, two adverts, and an advert that is spent, retired or another agent's end the job with `insurer_not_listed`. A source that cannot be read ends it with `insurer_unavailable`.
4. It reads the records and the guideline through two subagents, one after the other, and it uses no token of its own for them. First the agent sub-delegates `record.read` on the records resource of the tenant to `record-reader`: one hop below the delegation of the hirer, with no value. It waits for 30 confirmations. Then `record-reader` asks the identity gateway for a token and reads `GET /t/<tenant>/records/orders/<order_id>`: the order and its records. The job ends that sub-delegation. Then the agent does the same for `drafter` with `guideline.read` on the guideline resource of the tenant, and `drafter` reads `GET /t/<tenant>/guidelines/<service_code>`, with the service code of the order. The job ends each sub-delegation in every case, also after a failure. A first sub-delegation that does not end stops the job with `sub_delegation_not_ended`, so that no second one starts beside it. The janitor of the service ends a sub-delegation that a job leaves.
5. It checks what the subagents read. The record set must be the set of the order that the request names (`record_set_mismatch`), and the guideline must be the guideline of the service of that order (`guideline_mismatch`). A record that the kit refuses in a request ends the job with `bad_document`, before the model is hired and before a request number is taken.
6. It asks one model for the justification (decision `justification`). The model reads the order (without the patient reference and the clinician reference), the records and the guideline, and it answers `{ justification, guideline_refs, record_refs }`. The service checks the shape of the answer and that each reference names a criterion or a record that the agent read, each at most one time (`model_output_invalid` otherwise). It does not check that the text is true, or that it cites the references. The job builds the request from the choice only when the choice equals the choice that the decision records (`decision_mismatch` otherwise).
7. It builds the authorization request and returns the proposal: the document, a new salt and the digest. The request number comes from the counter of the tenant, and the counter stores the number before the job uses it. The job pays no insurer and writes nothing to the records system. It pays for the hire of the model with the service key, and for each sub-delegation with the delegation key.

What `execute` does, in this order, under its deadline:

1. It checks the document. The document must be an authorization request (`bad_document` otherwise), and it must be for the tenant of the request (`request_not_for_tenant` otherwise).
2. It reads the delegation, but not as `propose` does. A delegation that names another agent is refused with `delegation_not_mine` (400). A delegate key that the agent does not hold ends the job with `delegation_key_unknown`, and a read of the ledger that fails ends it with `ledger_unavailable`. A delegation that the ledger does not show does not stop the job. The job goes on with the first delegation key of the agent, and it ends with `no_live_vault` in step 4.
3. It builds the handoff from the document, the salt and the approval as the request gave them. A `null` approval goes on: the Insurer Intake Agent refuses it. The hire checks the size of the handoff before the Pay: at most 900000 bytes of wire payload, and at most 1048576 bytes in the body of the call to the runtime of the Insurer Intake Agent. A larger handoff is refused with `request_too_large` (400).
4. It hires the advert that the document names in `advert_ref`, one time, with one Pay from the Live vault of the delegation, signed by the delegation key. It never retries the Pay. A delegation with no Live vault ends the job with `no_live_vault`, and a delegation with several ends it with `several_live_vaults`. A Pay that the ledger refuses ends the job with `vault_refused`. An advert that is not an advert of the Insurer Intake Agent that the document names ends the job with `advert_not_counterparty`, and an advert that no agent can be hired for ends it with `advert_unavailable`, with nothing paid.
5. It sends the handoff to the Insurer Intake Agent. The Insurer Intake Agent checks the request before it claims the escrow. When the request fails a check, the Insurer Intake Agent refuses with a 403 and a code, and the result is `refused_by_counterparty` with that code. The escrow stays Open until the janitor of the key reclaims it after `deliver_by`. Any other refusal before the Claim is a `failed` result. Its reason is the code of the answer when the protocol lists it, such as `bad_shape` (400) or `busy` (409), and `counterparty_refused` otherwise. A send that does not end in a clear refusal is `failed` with `send_lost`, because the Insurer Intake Agent may hold the escrow. A status of 500 or more is such an end. The exception is a 503 answer with `precheck_unreachable`, `precheck_timeout` or `precheck_failed`: the runtime says that it could not ask its service, and the reason is `counterparty_refused`.
6. It runs the eight checks on the receipt of the Insurer Intake Agent. Then it checks the intake record in code: it must be an intake record (`intake_record_invalid`), and it must answer this request by its number and its sender (`intake_not_for_request`). Neither check asks the model.
7. It asks one model whether to accept the delivery (decision `accept_delivery`). The model reads two request numbers and two request hashes, and nothing else. The first number and hash are those of the request that the agent sent, and the agent computes the hash itself from the request in the handoff. The second number and hash are those that the intake record names. The model answers `{ accept, mismatch }`, and the agent accepts exactly when `mismatch` is empty. A model that accepts while the two hashes differ gives `decision_failed`, and the agent accepts nothing.
8. On accept, it accepts the escrow with the delegation key and writes the submission to the records system: `POST /t/<tenant>/records/orders/<order_id>/submission`, with a token for the action `priorauth.submit`. The body holds the request number, the intake id and the status of the intake record. The result is `completed` when the records system records the submission (201), and `refused_by_system` when the records system refuses it. The Accept comes before the write, so no end of the write undoes it. Two ends are `failed`: `token_failed` when the agent gets no token for the write, and `mock_system_failed` when the call ends in any other way.
9. When the model does not accept, it does not accept the escrow. It publishes the evidence, challenges the open claim of the Insurer Intake Agent with the second statement of that claim, and returns `disputed`.

### Response

`propose` answers with a proposal, and `execute` answers with a result. Each answer is the body of a 200 response, written once, with the member `fault_mode` last. A call that the service refuses is an error (see Errors).

The proposal has these members. The example after the table is the proposal for the requests above.

| Member | Content |
|---|---|
| `schema` | `vector.usecase.proposal.v1` |
| `use_case` | `prior-authorization` |
| `decisions` | the decision of the job, with its reasoning and, under `inference.sub_job`, the signed receipt of the model supplier that gave it |
| `sub_jobs` | the model hires of the job: each one is the `sub_job` of a decision |
| `document` | the authorization request. It is `null` when the job fails before it has one |
| `salt` | the salt of the proposal. It is `null` when `document` is `null` |
| `proposal_digest` | the digest of the salt and the document, which the hirer approves. It is `null` when `document` is `null` |
| `outcome`, `exit_state`, `reason` | `proposed`, `null` and `null` for a proposal. `failed`, `Failed` and a code for a job that makes none |
| `fault_mode` | the empty text in a clean run, and the value of the fault switch in a failure run (see Fault switch) |

```json
{
  "schema": "vector.usecase.proposal.v1",
  "use_case": "prior-authorization",
  "decisions": [
    {
      "name": "justification",
      "choice": {
        "justification": "Criterion C1 is met. The progress notes REC-0002 and REC-0005 record low back pain with pain in the left leg, and the pain continues at 7 weeks.\nCriterion C2 is met. The records REC-0003 and REC-0004 document naproxen for 4 weeks and 6 sessions of physical therapy, with little change.\nCriterion C3 is met. The progress note REC-0005 documents new numbness in the left foot and weakness of ankle dorsiflexion.\nCriterion C4 is met. The imaging record REC-0001 lists a plain X-ray of the lumbar spine.",
        "guideline_refs": [
          "C1",
          "C2",
          "C3",
          "C4"
        ],
        "record_refs": [
          "REC-0001",
          "REC-0002",
          "REC-0003",
          "REC-0004",
          "REC-0005"
        ]
      },
      "reasoning": "Each of the four criteria of the guideline is met by a record of the set, so the request cites the four criteria and the five records.",
      "inference": {
        "path": "marketplace",
        "sub_job": {
          "capability_id": "llm.text.generate.v1",
          "advert_ref": "443283bddae059d1aa4cc8fa2c0b1bff28ab4e0df7d09e70d53673565b639a3f#0",
          "escrow_ref": "b3c42ef53d55108d9487226469c5301cc3df377b67cf1ff3082b0e6143d69855#0",
          "supplier_pkh": "89b250439550623a9c3efdc45edd0bffb2bd7a0969192c3da6911dc2",
          "receipt": {
            "escrow_ref": "b3c42ef53d55108d9487226469c5301cc3df377b67cf1ff3082b0e6143d69855#0",
            "supplier_pkh": "89b250439550623a9c3efdc45edd0bffb2bd7a0969192c3da6911dc2",
            "prompt_hash": "e2fe0fde98637a095c3790e876bb43aec5e34ac274f188da336beea61cd651ed",
            "response_hash": "1eeff279728a4dc5ff181a348bee0ede81476d3d73d48f4d15b09ab350809d1e",
            "model": "deepseek/deepseek-v4-flash",
            "prompt_tokens": 1180,
            "completion_tokens": 64,
            "wallclock_ms": 2310
          },
          "receipt_signature": "8944da74b2c816961985ea34350547c78de18586b7e8cfc3b251bab8eac8e18dd88c00b081a3698b3778b37ba068ef620737a1df8a4e1ce58958836285376acf",
          "verification": {
            "escrow_ref_matches": true,
            "response_hash_matches": true,
            "supplier_key_matches": true,
            "signature_valid": true,
            "on_chain_hash_matches": true,
            "prompt_hash_matches": true,
            "model_matches": true,
            "fields_match": true
          }
        },
        "accepted": "confirmed"
      }
    }
  ],
  "sub_jobs": [
    {
      "capability_id": "llm.text.generate.v1",
      "advert_ref": "443283bddae059d1aa4cc8fa2c0b1bff28ab4e0df7d09e70d53673565b639a3f#0",
      "escrow_ref": "b3c42ef53d55108d9487226469c5301cc3df377b67cf1ff3082b0e6143d69855#0",
      "supplier_pkh": "89b250439550623a9c3efdc45edd0bffb2bd7a0969192c3da6911dc2",
      "receipt": {
        "escrow_ref": "b3c42ef53d55108d9487226469c5301cc3df377b67cf1ff3082b0e6143d69855#0",
        "supplier_pkh": "89b250439550623a9c3efdc45edd0bffb2bd7a0969192c3da6911dc2",
        "prompt_hash": "e2fe0fde98637a095c3790e876bb43aec5e34ac274f188da336beea61cd651ed",
        "response_hash": "1eeff279728a4dc5ff181a348bee0ede81476d3d73d48f4d15b09ab350809d1e",
        "model": "deepseek/deepseek-v4-flash",
        "prompt_tokens": 1180,
        "completion_tokens": 64,
        "wallclock_ms": 2310
      },
      "receipt_signature": "8944da74b2c816961985ea34350547c78de18586b7e8cfc3b251bab8eac8e18dd88c00b081a3698b3778b37ba068ef620737a1df8a4e1ce58958836285376acf",
      "verification": {
        "escrow_ref_matches": true,
        "response_hash_matches": true,
        "supplier_key_matches": true,
        "signature_valid": true,
        "on_chain_hash_matches": true,
        "prompt_hash_matches": true,
        "model_matches": true,
        "fields_match": true
      }
    }
  ],
  "document": {
    "schema": "vector.usecase.priorauth-request.v1",
    "request_number": "demo-1",
    "tenant": "demo",
    "order_id": "ORD-1001",
    "patient_ref": "SYN-PT-0001",
    "ordering_clinician_ref": "SYN-CL-0007",
    "service_code": "SYN-MRI-LS",
    "diagnosis_codes": [
      "M54.16",
      "M51.16"
    ],
    "justification": "Criterion C1 is met. The progress notes REC-0002 and REC-0005 record low back pain with pain in the left leg, and the pain continues at 7 weeks.\nCriterion C2 is met. The records REC-0003 and REC-0004 document naproxen for 4 weeks and 6 sessions of physical therapy, with little change.\nCriterion C3 is met. The progress note REC-0005 documents new numbness in the left foot and weakness of ankle dorsiflexion.\nCriterion C4 is met. The imaging record REC-0001 lists a plain X-ray of the lumbar spine.",
    "guideline_refs": [
      "C1",
      "C2",
      "C3",
      "C4"
    ],
    "record_refs": [
      "REC-0001",
      "REC-0002",
      "REC-0003",
      "REC-0004",
      "REC-0005"
    ],
    "record_set_sha256": "14aa6337663c538a6a4243d840d56be7ae8210c6980a5a7c0ab6749db48805f9",
    "insurer_did": "did:vector:29e051f281381dd9f79a7304f64ba8d3193325d6b5aae0118186f3e723558c84",
    "advert_ref": "47d282b873e3e4fee20ce6d97729687bea64008375c95e985abec6a3ccc30dcc#0"
  },
  "salt": "ea81c5ed094f56b05ec1e75b25403d9891abc12269346a5a7989e4689629daee",
  "proposal_digest": "007b4e94a97e96bfed7f0ad89951a75c7bed20a665942f6da0758c97b2d69498",
  "outcome": "proposed",
  "exit_state": null,
  "reason": null,
  "fault_mode": ""
}
```

The example is an illustration and not a recorded run. Its references, hashes, key hash and signature are made from labels, and they belong to no escrow, no supplier and no key. The record set of the example is the synthetic order `ORD-1001` with its five records. The `record_set_sha256` of the request is the sha256 of the canonical JSON of that set.

The authorization request, the `document`, has these members:

| Document member | Content |
|---|---|
| `schema` | `vector.usecase.priorauth-request.v1` |
| `request_number` | the tenant, a hyphen and a counter that the service keeps for each tenant |
| `tenant`, `order_id` | those of the request |
| `patient_ref`, `ordering_clinician_ref` | the synthetic references of the order. The service copies them from the order, and the model never writes them |
| `service_code`, `diagnosis_codes` | those of the order. `diagnosis_codes` has 1 to 8 codes of 1 to 16 characters |
| `justification` | the text that the model wrote, 1 to 4000 characters |
| `guideline_refs` | the ids of the criteria of the guideline that the justification cites: at most 20, none twice. Each id is a criterion that the agent read |
| `record_refs` | the ids of the records that the justification cites: at most 50, none twice. Each id is a record that the agent read |
| `record_set_sha256` | the sha256 of the canonical JSON of the record set that `record-reader` read: the order and its records |
| `insurer_did` | the Insurer Intake Agent that the request names |
| `advert_ref` | the advert of that Insurer Intake Agent, which `execute` pays |

The service checks the shape of the justification and the references. It does not check that the text is true: the model writes it, and the hirer reads it before the approval.

The result of `execute` has these members:

| Result member | Content |
|---|---|
| `schema` | `vector.usecase.result.v1` |
| `use_case` | `prior-authorization` |
| `proposal_digest` | the digest of the proposal that the hirer approved |
| `handoff` | the hire of the Insurer Intake Agent, or `null` when no escrow was posted. Its members: `counterparty_did`, `advert_ref`, `escrow_ref`, `paid_from_vault`, `receipt`, `receipt_signature`, `verification`, `result` (the intake record that the Insurer Intake Agent returned) and `accepted` (`confirmed`, `pending`, `no` or `null`) |
| `writes` | each call that changed the records system, with `system`, `route`, `status` and `ref`. The one write of a clean run is the submission |
| `decisions` | the decision on the delivery, when the model made one, with its reasoning and the sub-job that bought it |
| `outcome`, `reason`, `exit_state` | see Outcomes |
| `challenge` | `null`, or the challenge that the agent filed: `claim`, `evidence` and `challenge` |
| `fault_mode` | the empty text in a clean run, and the value of the fault switch in a failure run (see Fault switch) |

The intake record under `handoff.result` has these members:

| Intake record member | Content |
|---|---|
| `schema` | `vector.usecase.intake-record.v1` |
| `outcome` | `done`. The Insurer Intake Agent answers a refusal or a failure with an error and not with a record |
| `request_number` | the number of the request that the Insurer Intake Agent filed |
| `request_sha256` | the sha256 of the canonical JSON of the request that it received, with no salt. The agent compares it with the hash of the request that it sent |
| `status`, `missing` | `complete` with no missing requirement, or `incomplete` with the ids of 1 to 20 requirements of the insurer that the request does not meet |
| `intake_id` | the id that the insurer portal gave to the filed request |
| `sender`, `approval` | the sender of the job and the approval that came with it, as the Insurer Intake Agent checked them |
| `attestations` | what the Insurer Intake Agent found about the sender: `provenance`, `software` and `principal_binding`, each one `valid`, `invalid`, `absent` or `unreadable`. It reports them and never refuses a job for them |
| `checks` | the 15 checks of the Insurer Intake Agent, each one `true`: a record exists only for a request that passed all of them |
| `decisions` | the one decision of the Insurer Intake Agent, with its reasoning and the sub-job that bought it |
| `fault_mode` | the empty text: the Insurer Intake Agent has no fault value |

The agent does not judge `status`: it accepts a record whose hash is right, `complete` or `incomplete`, and it writes the status to the records system.

### Outcomes

The outcome and the exit state of an `execute` result follow one rule. The exit state is `Completed`, `Rejected`, `Expired`, `Cancelled`, `Escalated` or `Failed`.

| Outcome | Exit state | When |
|---|---|---|
| `completed` | `Completed` | the Insurer Intake Agent delivered an intake record, the model accepted it, and the records system recorded the submission |
| `vault_refused` | `Cancelled` when the hirer ended the delegation, else `Failed` | the ledger refused the Pay from the vault, or the builder could not make it. The `reason` is the text that the node or the builder gave, cut short, or `vault_reason_missing` when it gave none |
| `refused_by_counterparty` | `Rejected`, but `Escalated` for `approval_digest_mismatch`, `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | the Insurer Intake Agent refused the request. The `reason` is its code |
| `refused_by_system` | `Rejected`, but `Expired` for `approval_expired` and `Cancelled` for `delegation_ended` | the records system refused the submission. The `reason` is its code |
| `disputed` | `Escalated` when the agent filed a challenge, else `Failed` | the model did not accept the delivery. Without a challenge, the `reason` is the code of the step that failed, such as `no_open_claim` |
| `failed` | `Failed` | any other end. The `reason` is a code |

A `propose` job ends with `proposed` or with `failed`, and a proposal has no exit state.

### Errors

A call that the service refuses has the body `{ "error": "<code>", "message": "<words>" }`, with the status of the first table. Four answers carry the code only, with no `message`: the 401, the 404, the 409 of a job, and a 500 for an error that the service does not name. The 409 of `POST /precheck` has a `message`. A refusal with a status of 500 or more gets fixed words, and the whole message is in the log. A job that the service runs and that does not end well is no HTTP error: it is a 200 result with the outcome `failed` and a `reason` code.

| Status | Codes |
|---|---|
| 400 | `bad_wire` (not the one-element message array), `request_too_large` (over a limit of Terms), `bad_shape` (a request that breaks a rule of Request), `bad_context` (a call to `POST /precheck` with a missing or wrong context header), `delegation_not_mine` (the delegation names another agent as its delegate) |
| 401 | `unauthorized` (no authorization header, or one that is not the token of the service) |
| 404 | `not_found` (any other path, and any method that a route does not take) |
| 409 | `busy` (a job runs, or the slot is reserved for another escrow) |
| 503 | `shutting_down` (the service is stopping) |
| 500 | `internal` |

The next table lists each code that a job writes as the `reason` of a result that is not a proposal and not a recorded submission. The column Job says which job writes it: `propose`, `execute` or both. The other outcomes have their own reasons: see Outcomes. One row stands for a class of codes and not for one code: a code of the protocol, which the use case kit lists.

| Reason | Job | What it says |
|---|---|---|
| `ledger_unavailable` | both | a read of the ledger gave no answer in time, or an answer that the job cannot read |
| `delegation_key_unknown` | both | the delegation names a delegate key that the agent does not hold |
| `mock_system_failed` | both | a call to a mock system failed. In `propose` the call is a read of the records system or of the guideline store, and the system gave a code that is not one of the seven codes that pass through, or no code. In `execute` the call is the write of the submission, and the records system neither recorded it nor refused it |
| `bad_document` | both | a document is not what the kit takes. In `propose`: a record that the kit refuses in a request, a choice that the job cannot copy, a reference that names no record of the set and no criterion of the guideline, or a request that the kit refuses. In `execute`: a document that is no authorization request, or a proposal that the job cannot turn into a handoff or hash |
| `store_write_failed`, `deadline`, `aborted` | both | a record could not be written on the volume, the job ran out of its time, or the caller hung up |
| `delegation_not_found` | `propose` | the ledger shows no delegation with that identifier |
| `insurer_not_listed`, `insurer_unavailable` | `propose` | `propose` cannot read the Insurer Intake Agent (step 3 of `propose`) |
| `record_read_timeout`, `guideline_read_timeout` | `propose` | the read of the records, or the read of the guideline, did not end in time |
| `record_set_invalid`, `guideline_invalid` | `propose` | the body that the records system gave is no record set, or the body that the guideline store gave is no guideline |
| `record_set_mismatch`, `guideline_mismatch` | `propose` | the record set is not the set of the order that the request names, or the guideline is not the guideline of the service of that order |
| `sub_delegation_not_ended` | `propose` | the sub-delegation of the first subagent did not end, so the job makes no second one. The janitor of the service ends it |
| `sub_delegation_<code>` | `propose` | the sub-delegation of a subagent failed. The `<code>` is one of `bad_request`, `parent_unreadable`, `parent_not_live`, `parent_exhausted`, `parent_expiring`, `build_refused`, `build_mismatch`, `missing_signer`, `sign_failed`, `submit_failed`, `confirmation_timeout`, `ledger_unreadable`, `sub_delegation_unusable`, `journal_failed`, `step_timeout` and `internal` |
| `token_<code>` | `propose` | the identity gateway gave a subagent no token. The `<code>` is one of `bad_request`, `gateway_refused`, `delegation_too_young`, `gateway_unavailable`, `gateway_unreachable` and `gateway_bad_response` |
| `order_not_found`, `guideline_not_found` | `propose` | the records system knows no order with that id, or the guideline store knows no guideline for the service code of the order |
| `token_invalid`, `not_covered`, `delegation_ended`, `chain_too_deep`, `actor_not_active` | `propose` | a mock system refused the token of a subagent and gave this code. These five codes and the two codes of the row above are the seven codes that pass through |
| `llm_supplier_unavailable` | `propose` | no model on the allowlist is within the three limits, so no hire starts |
| `llm_out_of_time`, `hire_threw` | `propose` | the deadline came during the hire of the model, or less than 60 s were left when the decision began, so no hire started (`llm_out_of_time`); or a port threw, or the result of the hire cannot be read (`hire_threw`) |
| `llm_post_failed`, `llm_busy`, `llm_refused`, `llm_send_lost`, `llm_failed`, `llm_timeout`, `llm_bad_result`, `llm_receipt_failed`, `llm_receipt_unavailable`, `llm_accept_failed` | `propose` | the hire of the model failed with a code of the hire kit, and the code follows the prefix. The ten codes of the hire kit are in the row of the hire of the Insurer Intake Agent |
| `model_output_invalid` | `propose` | the hire of the model ended, and its answer is not usable as a choice |
| `choice_changed`, `bad_decision` | `propose` | the parser of the decision is wrong: it returned a value that is not the choice that the model gave (`choice_changed`), or the definition of the decision or its parser is wrong (`bad_decision`) |
| `bad_limit`, `bad_input`, `bad_deps` | `propose` | a limit, the input or the clock of the decision is wrong, and nothing was hired |
| `decision_mismatch` | `propose` | the choice that the job built is not the choice that the decision records |
| `internal` | `propose` | the job threw, a port gave an answer of a wrong form, or a code that the job read is not in the form of a code |
| `request_not_for_tenant` | `execute` | the authorization request is for another tenant than the request |
| `advert_not_counterparty` | `execute` | the advert in the document is not an advert of the Insurer Intake Agent that the document names |
| `advert_unavailable` | `execute` | no agent can be hired for the advert of the document, and nothing was paid |
| `no_live_vault`, `several_live_vaults` | `execute` | `execute` found no Live vault under the delegation, or more than one |
| `earlier_pay_may_land` | `execute` | an earlier Pay of the same key was sent and not seen confirmed, and it may still land. No job of that key pays until its validity ends |
| `pay_unconfirmed` | `execute` | the Pay was sent and not seen confirmed, and it may still land |
| `hire_interrupted`, `decision_error` | `execute` | an error ended the hire after the Pay was confirmed. `decision_error` stands when the error came from the decision on the delivery. An interrupted hire can also end with `deadline` or `store_write_failed` |
| `post_failed`, `busy`, `refused`, `send_lost`, `failed`, `timeout`, `bad_result`, `receipt_failed`, `receipt_unavailable`, `accept_failed` | `execute` | the hire of the Insurer Intake Agent failed, and the hire kit gave the code. The flow takes these ten codes from the hire kit, and it turns any other code into `inconsistent_outcome` |
| `counterparty_refused` | `execute` | the Insurer Intake Agent refused before its Claim with no rule of the protocol, and the protocol does not list the code of its answer |
| a code of the protocol | `execute` | the Insurer Intake Agent refused before its Claim with no rule of the protocol, and the protocol lists the code of its answer, such as `bad_shape` (400) or `busy` (409) |
| `intake_record_invalid`, `intake_not_for_request` | `execute` | the answer of the Insurer Intake Agent is no intake record, or it does not answer this request by its number and its sender. The model was not asked |
| `decision_failed`, `decision_timeout`, `delivery_not_recordable` | `execute` | the decision on the delivery could not be made or read, or the model accepted while the two hashes differ (`decision_failed`); the decision did not end in time (`decision_timeout`); or the delivery cannot be written as a record (`delivery_not_recordable`). The code of a decision that fails goes to the log and not to the result |
| `token_failed` | `execute` | the identity gateway gave no token for the write to the records system |
| `inconsistent_outcome` | `execute` | the hire kit gave an outcome that does not hold together, so the job trusts none of it. The submission is not written |
| `hire_error` | `execute` | an error that no other code names ended the hire before any Pay |
| `port_error` | `execute` | the challenge stopped with an error, and a transaction may have landed. It is the `reason` of a `disputed` result that holds no challenge |

### The co-sign route

`POST /cosign/delegate` is an open route of the service: it needs no token, and it takes no job slot. The route takes `POST` only. Any other method gets the 404 `not_found` of the service, as an unknown path does. The body is `{ "transaction": "<hex CBOR>" }`. The answer is 200 `{ "transaction": "<hex CBOR>" }`: the same transaction with one more witness, of the delegation key that its datum names. A refusal is `{ "error": "<code>", "message": "<words>" }`.

The route signs only for a principal key on the allowlist that the operator sets with `COSIGN_ALLOWLIST`. The empty allowlist holds nobody, and a service with no such setting does not start. The rule of the route is the rule that the manifest states in `behaviour.cosign`:

> The agent signs one kind of transaction: a Delegate transaction of the delegation contract that names this agent as the delegate and one of its own delegation keys as the delegate key. The delegator must have signed the transaction first, and the delegator must be a principal key on the allowlist of the operator. The delegation key must have no live delegation and no other signed transaction whose window is open. The transaction must spend nothing of the agent, and it must have no certificate, no withdrawal and no other mint. Its validity window must end in the future, and not too far ahead, and the period of the delegation must not be over. The agent adds one witness of the delegation key and changes nothing else.

| Status | Codes |
|---|---|
| 400 | `not_a_delegation`, `not_for_this_agent`, `expired`, `bad_shape`, `request_too_large` |
| 403 | `principal_not_allowed`, `spends_agent_funds` |
| 409 | `key_in_use`, `busy` |
| 415 | `unsupported_media_type` |
| 503 | `check_unavailable` |
| 500 | `internal` |

The code `key_in_use` means that the delegation key is in use: the agent signed another body for it whose window is open, or a live delegation on the ledger names it.

## What the receipt commits to

The service signs no receipt. The runtime builds the receipt, signs it with the supplier key and submits its hash in the Submit transaction.

| Receipt field | Value for this agent |
|---|---|
| `escrow_ref` | the escrow UTxO, `<txid>#<index>`: 64 lower-case hex characters, a hash sign, and an output index with no leading zero |
| `supplier_pkh` | the key hash of the supplier key |
| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |
| `response_hash` | sha256 of the UTF-8 bytes of the result exactly as the service returned them |
| `model` | `prior-authorization-agent-v1` |

The runtime writes the other fields of the receipt. The result is the committed output. The receipt of a `propose` job commits the authorization request, the hash of the record set, the salt, the digest of the proposal, and the decision of the model with its reasoning and the sub-job that bought it. The receipt of an `execute` job commits the outcome, the intake record that the Insurer Intake Agent returned with its receipt, the decision on the delivery, the write to the records system and, on `disputed`, the references of the challenge. The sub-receipt of a model is signed by the model supplier under its own key, and accountability for the result stays on the key of this agent.

It does not commit to the justification being clinically right, or to the record set being complete beyond what the records system returned.

The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.

## Claim statements

The service stakes no claim, and no code of the service calls the staking of one. No command of this repository stakes a claim for this agent yet. Until one does, a challenge against it ends with `no_open_claim`. The same holds for the Insurer Intake Agent: no command stakes a claim for it, so the challenge of this agent against it (step 9 of `execute`) ends with `no_open_claim` too. The design is that, before a run, an operator command stakes one claim with the service key of the agent: 50 units, with a challenge window of 24 hours. The operator withdraws the claim after the window. A claim has these three statements. The manifest holds them in `behaviour.claim`, with no reference to a claim. A challenge names the text of a statement.

| Id | Statement |
|---|---|
| S1 | A request this agent submits is byte-identical to the document whose digest its hirer approved. |
| S2 | The record set hash in a request is the hash of the set that its model was given. |
| S3 | This agent reads records and guidelines only through its subagents, each with its own token under its own sub-delegation. |

## Fault switch

`FAULT_MODE=alter_after_approval`. It is for a failure run only.

With this value, `execute` changes the last sentence of the justification after the approval, and before it sends the handoff to the Insurer Intake Agent. The last sentence becomes a fixed synthetic sentence. A justification of one sentence becomes that sentence. The changed request is still a valid request, and its digest is not the digest that the hirer approved. The Insurer Intake Agent finds that and refuses the request before its Claim.

The manifest lists the value in `behaviour.fault_modes`, and it never says which value is active: the bytes of the manifest are the same for every value. Every result has the member `fault_mode`. It is the empty text in a clean run, and it is `alter_after_approval` in a failure run. The service stops at start when `FAULT_MODE` has any other value.

## Operator and data handling

Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.

The order, the record set, the guideline, the authorization request and the intake record are synthetic data, and they are held in memory while a job runs. On disk the service keeps the bookkeeping of the escrows that it posts, the list of sub-delegations that it has to end, the record of the challenges that it files, the register of the transactions that it co-signed, and the counter of request numbers. The log carries job outcomes, counts and codes, never a record, a justification, a request or a key.

Every record is synthetic, and no patient exists behind any of it. Do not send a record of a real person to this agent while it is a demonstration.

The service keeps these files and folders in its state volume (`PRIORAUTH_STATE_DIR`, which is `/data` in the image):

| Path | What it holds |
|---|---|
| `keys/<key hash>/stranded.json` | the escrows that a paying key posted and did not settle: one file for each of the service key and the two delegation keys. The janitor of the key reclaims them after their `deliver_by`, every 60 s |
| `dispute/` | the journal of the challenges |
| `left/` | the sub-delegations that a job left behind. Their janitor ends them, every 60 s |
| `cosign-register.json` | the register of the delegation keys that a co-signed transaction uses, so a restart still answers `key_in_use` |
| `request-numbers.json` | the counter of request numbers, one for each tenant. A number is stored before a job uses it |

What leaves the service to third parties:

| Party | What it receives |
|---|---|
| the identity gateway (the token requests of the agent and of its two subagents, record-reader and drafter) | the token request of the agent for the action `priorauth.submit`, with the subject token that the service key signs and the proof that the delegation key signs, and the token request of each subagent for its own action (`record.read` for `record-reader`, `guideline.read` for `drafter`), signed with its two keys. Each request names one action, one resource and one delegation |
| the mock records system and guidelines store (the three calls that behaviour.relying_on lists, with their tokens) | a read of one order and its records, a read of one guideline, and a write of one submission. Each call carries a token for one action and one resource. The write holds the request number, the intake id and the status of the intake record |
| a model supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it (the prompt of the decision justification: the order without its patient reference and its clinician reference, the whole record set and the guideline; the prompt of the decision accept_delivery: the request number and the hash of the request that was sent, and the request number and the hash that the intake record names) | one job for each decision: the fixed prompt of the decision, its data and the reference of the escrow. The next table lists the data of the two decisions |
| the Insurer Intake Agent (the request, the salt, the approval reference, the DID of this agent and the delegation) | the handoff. The handoff holds the authorization request, the salt, the approval reference, the DID of this agent and the identifier of the delegation. |
| the Vector ledger (the two sub-delegations, the escrows, which carry only hashes, and, on a dispute, the evidence document and the challenge) | the Delegate and the Undelegate transactions of the two sub-delegations, the Post and the Accept transactions of the escrows, and, on a dispute, the evidence document and the challenge. Each stays in the history of the ledger |

What each decision receives:

| Decision | Data block | Left out |
|---|---|---|
| `justification` | `order` (`order_id`, `service_code`, `service_description`, `diagnosis_codes`, `ordered_at`), `records` (each record: `record_id`, `type`, `recorded_at`, `summary`) and `guideline` (`code`, `title`, `version`, `criteria` (each criterion: `id`, `text`) and `documentation`) | the `patient_ref` and the `ordering_clinician_ref` of the order. The agent copies them from the order into the request, and the model never writes them |
| `accept_delivery` | `sent` and `record` (each one: `request_number` and `request_sha256`) | everything else of the request and of the intake record |

The text of the records and of the guideline reaches the model only inside the marked data block, and never inside an instruction. The intake record reaches the model as one request number and one hash, and no text of it reaches the model. The agent checks the number and the sender of the intake record in code before it asks the model.

To post and settle its escrows, the service reads the ledger through the node (Ogmios) and the Koios indexer, submits its transactions through the submit API, and finds the Insurer Intake Agent and the model suppliers on the marketplace indexer. They see the references and the transactions of those escrows, and nothing of a request. On the ledger an escrow carries only the sha256 of its wire payload. At start the service fetches one file: the Module-1 deployment manifest, at an https address that a commit pins. It sends no data of a job there.

## Known gaps

The manifest states these ten, in this order, word for word. A test keeps them equal to `gapsFor` in `agents/prior-authorization-agent/src/serve/gaps.ts`. The first seven are the gaps of the agent. The eighth says whose keys the parties are. The ninth starts with the lead `What this does not show:` and names three things that no run of use case 2 (prior authorization) covers. The tenth is the sentence of the kit about the fault switch.

- Every record is synthetic. Nothing here has been run against a real records system or a real insurer.
- The model writes the justification. Nothing in this agent checks it against the guideline.
- This agent does not check the sign-off of the hirer. The Insurer Intake Agent does.
- The model is given the whole record set, but nothing forces the model to use all of it. The request carries the hash of the set so that a reviewer can compare.
- A challenge puts a hold on the identity of the Insurer Intake Agent if the jury finds for this agent. It does not return what the escrow locked: a delivery that this agent refuses can still be released to the Insurer Intake Agent 600 s after its Submit.
- A model call that fails ends the job. There is no second provider.
- The insurer side is operated by the same foundation as this agent.
- The controller key, the Accountable key and the guardian keys of this deployment are held on one host by one operator, so a party is independent of the controller by key only.
- What this does not show: no run covers the refund of the escrow of a revoked agent, a relying party that refuses a live token after its authority ended, or a challenge of this agent against the Insurer Intake Agent, because that agent has no fault value. Tests alone cover the last two.
- This service has a fault switch for failure runs with these possible values: alter_after_approval (in execute, one sentence of the justification changes before the handoff, so its digest differs from the approved digest); this manifest is the same for every value, so only the field fault_mode of each result shows which value is active.

## How to hire it

The agent has no advert yet, so nobody can hire it today. These steps are for the day it has one. You hire it twice, once for each operation, and a delegation and a vault carry the authority for the request. [docs/HIRE.md](../docs/HIRE.md) gives the steps of the marketplace tools.

1. **Delegate to the agent.** Build the Delegate transaction with `vector_build_delegation_delegate`. The delegate is this agent. The delegate key is a free one of its two delegation keys, which `keys.delegation_pkhs` of the manifest lists. The actions are `marketplace.hire.v1`, `record.read`, `guideline.read` and `priorauth.submit`. The resources are the escrow script, `<mock base>/t/<tenant>/records` and `<mock base>/t/<tenant>/guidelines`, where `<mock base>` is the origin of the mock systems that the operator gives you. The action `priorauth.submit` is for the write of the submission to the records system, and it uses the same resource as `record.read`. Set `remaining` to 1 or more: `propose` makes a sub-delegation under your delegation for each of the two subagents, and a delegation with `remaining` 0 ends that job with `sub_delegation_parent_exhausted`. Set the value limit to the price and both bonds of the advert of the Insurer Intake Agent, 4 units, for each job that you mean to pay for. Sign the transaction with your key first: the co-sign route refuses a transaction that the delegator did not sign (`principal_not_allowed`). Send the signed transaction to the agent with `vector_delegation_request_cosign`. The route signs only for a principal key on the allowlist of the operator, and it answers `key_in_use` (409) for a delegation key that is in use. Submit the transaction that comes back. Wait until the ledger shows the delegation: a `propose` job on a delegation that the ledger does not show ends with `delegation_not_found`. Then wait for 30 confirmations of the delegation. Each sub-delegation of `propose` needs 30 confirmations on every link of its chain, and a subagent gets no token before that.
2. **Make a principal-binding attestation (optional).** Make it with `vector_build_attestation_attest`: the type is 4, and the subject is this agent. Make it with the key that gave the delegation. The Insurer Intake Agent reads it, and its intake record says in `attestations.principal_binding` whether it found one. It never refuses a job for it.
3. **Open one vault under the delegation** with `vector_build_vault_open`. The agent finds the Live vault of the delegation itself, so the delegation needs exactly one: `execute` ends with `failed` and the reason `no_live_vault` or `several_live_vaults` otherwise. The vault pays the price and both bonds of the advert of the Insurer Intake Agent, so put in it what the jobs need.
4. **Hire `propose`.** Post the escrow for the advert of the agent, send the request JSON, read the result, verify the receipt and accept, as `docs/HIRE.md` says. The request JSON is the first example under Request, with your own values. The authorization request is the `document` of the result.
5. **Read the request and approve it.** Read the authorization request: the justification, the criteria and the records that it cites, and `record_set_sha256`, the hash of the record set that the agent read. Nothing in the agent checks the justification against the guideline, so your reading is the check. If you accept the request, make the approval with `vector_build_attestation_attest`: the type is 5, the subject is this agent, and the digest is the `proposal_digest`. Make it with the key that gave the delegation: the Insurer Intake Agent refuses another issuer with `approval_wrong_issuer`. Set `valid_until` yourself: the tool sets no end. The runs use 4 hours. The attestation holds a deposit of 5000000 lovelace, and the deposit returns 90 days after the attestation ends.
6. **Hire `execute`.** Send the `proposal` as `propose` returned it, with the `approval` of step 5. The second example under Request shows the request. Verify the receipt and accept.
7. **Close the vault and end the delegation.** Close the vault with `vector_build_vault_close`. End the delegation with `vector_build_delegation_undelegate`.

## Changelog

- 0.1.0, 2026-11-24: built

## Links

- Manifest: `GET /agent.json` on the public URL of the agent, once the agent has an advert. The service renders it from its environment when it starts. The template is [agents/prior-authorization-agent/agent.json.template](../agents/prior-authorization-agent/agent.json.template).
- Source: [agents/prior-authorization-agent](../agents/prior-authorization-agent)
- Deploy pack: [deploy/server/RUNBOOK-prior-authorization-agent.md](../deploy/server/RUNBOOK-prior-authorization-agent.md)
- Use case kit: [packages/usecase-kit](../packages/usecase-kit)
- Guide: [docs/HIRE.md](../docs/HIRE.md)
- Counterparty: [Insurer Intake Agent](insurer-intake-agent.md)
