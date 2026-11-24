Results for a made-up group of the tests
Date of the page: 2026-12-05

# Use case 3 (supplier bid evaluation): results

This page lists the steps of each run. A row names the primitive that the step used and the reference that the evidence file holds for it. A step counts as shown only when the evidence file holds a reference for it. A step that did not run says so and gives its reason.

## Run 2026-12-04-bid-desk-bravo-run-1: lifecycle, 2026-12-04

| id | what | primitive | reference | shows | does not show |
|---|---|---|---|---|---|
| l1-01 | The old and the new controller of Bid Desk Bravo change the controller. | Change of the controller | none | Not run. The evidence file has no entry for this step. | The whole step. |
| l1-02 | Both guardians and the next controller start a recovery. | Recovery start | none | Not run. The evidence file has no entry for this step. | The whole step. |
| l1-03 | The recovery waits 7 days. The tool refuses to build an earlier completion. | Waiting time of a recovery | refusal `example-refusal` | The tool refused to build a completion before the recovery window opened. | That the ledger refused a submitted completion. None was submitted early. |
| l1-04 | After the 7 days the wallet completes the recovery. The new controller takes over. | Recovery completion | none | Not run. The evidence file has no entry for this step. | The whole step. |
| l1-05 | The new controller retires the record. The deposit stays. | Retire of a record | none | Not run. The evidence file has no entry for this step. | The whole step. |
| l1-06 | The controller of the retired record and the controller of the successor record name the successor. | Successor of an ended record | successor `example-successor` | The tombstone names the successor record. | That the successor inherits a claim, delegation or advert. |
| l1-07 | The controller of the retired record takes back the deposit above the ledger minimum. | Reclaim of an ended record | none | Not shown. The evidence file holds no reference for this step. | The whole step. |

## Not covered

No run covers these 4 items:

- No run covers the refund of the escrow of a revoked agent.
- No run covers the reclaim of an escrow in use case 3.
- No run shows a relying party that refuses a live token after its authority ends.
- No run challenges a claim of the Sourcing Agent.

The runs have these limits:

- The model decisions are a sample. Another run can decide another way.
- The jury result is a sample. Another jury can decide another way.
- One operator holds the keys of the agents, and they sit on one host.
