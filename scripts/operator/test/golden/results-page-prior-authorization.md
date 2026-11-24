Results for a made-up group of the tests
Date of the page: 2026-12-05

# Use case 2 (prior authorization): results

This page lists the steps of each run. A row names the primitive that the step used and the reference that the evidence file holds for it. A step counts as shown only when the evidence file holds a reference for it. A step that did not run says so and gives its reason.

## Run 2026-12-01-prior-authorization-agent-run-1: clean, 2026-12-01

| id | what | primitive | reference | shows | does not show |
|---|---|---|---|---|---|
| r1-01 | The hirer delegates to the Prior Authorization Agent. The agent co-signs. The hirer submits. The hirer issues a principal-binding attestation that names the agent and opens a vault under the delegation. | Delegation with a co-signature, attestation: principal binding, vault | delegation `example-delegation` | Not shown in full. The evidence file does not support every part of this step. | The whole step. |
| r1-02 | The hirer hires `propose`. The agent sub-delegates the record read and the guideline read to its two subagents, one after the other. Each subagent reads its system with its own token. A model writes the justification. The agent returns the request, the record set hash, the salt and the digest. | Escrow, two sub-delegations, token exchange with the delegation chain, model call from the marketplace | none | Not run. The evidence file has no entry for this step. | The whole step. |
| r1-03 | The hirer approves the digest. | Attestation: approval | none | Not run. The evidence file has no entry for this step. | The whole step. |
| r1-04 | The hirer hires `execute`. The agent pays the advert of the Insurer Intake Agent from the vault and sends the handoff. | Escrow, vault payment, agent hires agent | none | Not shown. The evidence file holds no reference for this step. | The whole step. |
| r1-05 | The Insurer Intake Agent checks the handoff before it claims the escrow. It reads and reports the attestations of the sender. A model decides if the request is complete. The agent files the request at the insurer portal with its JWT identity and submits. | Pre-claim check, attestation reads, JWT-SVID, model call | none | Not run. The filing did not run. | The whole step. |
| r1-06 | The agent checks the receipt and accepts it. It writes the submission reference to the records system with a token and returns. | Receipt checks, accept, token for a route | receipt `example-receipt` | Not shown in full. The evidence file does not support every part of this step. | The whole step. |
| r1-07 | The hirer closes the vault and ends the delegation. | Vault close, undelegate | none | Not run. The evidence file has no entry for this step. | The whole step. |

## Not covered

No run covers these three items:

- The refund of the escrow of a revoked agent.
- A relying party that refuses a live token after its authority ended.
- A challenge of the Insurer Intake Agent by the Prior Authorization Agent.

The runs have these limits:

- The model decisions are a sample. Another run can decide another way.
- The jury result is a sample. Another jury can decide another way.
- One operator holds the keys of the agents, and they sit on one host.
