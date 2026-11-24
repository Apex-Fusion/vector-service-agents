// scripts/operator/lib/claim-constants.ts - the numbers of the claim of a run, in one place.
// The task `claim` stakes a Module-1 claim for each agent before a run and withdraws it after its challenge window. The stake, the window, the claim type, the reserve for a challenge and the
// validity of the approval of a run are written here and nowhere else. The pages of the two agents state the same numbers, and a test (test/claim-constants.test.ts) holds the pages, the
// example environments, the data of use case 1 and the Module-1 manifest to this file, so a change in one place fails a test in another.

/** The stake of a claim, in lovelace: 50 units. It is the least claim that the Module-1 deployment takes, and it is not above the stake of a challenge (50 units), so a challenge can target the claim. */
export const CLAIM_STAKE_LOVELACE = 50_000_000n;

/** The challenge window of a claim, in milliseconds: 24 hours. A claim is withdrawn after it, when nobody challenged. Two runs in one window share two claims. */
export const CLAIM_WINDOW_MS = 86_400_000;

/** How long the approval of a run is valid, in milliseconds: 4 hours. */
export const RUN_APPROVAL_VALIDITY_MS = 14_400_000;

/** The claim type of an agent: the capability id of the agent. */
export const claimTypeOf = (capabilityId: string): string => capabilityId;

/** What the service wallet of the Reorder Agent keeps for its own challenge, in lovelace: the stake of a challenge (50 units) and 3 units for the evidence document and the fees of the challenge. */
export const CHALLENGE_RESERVE_LOVELACE = 53_000_000n;
