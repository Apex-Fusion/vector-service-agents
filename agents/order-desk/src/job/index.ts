// agents/order-desk/src/job/index.ts
// The job of the Order Desk: what it does after the Claim of an escrow. The decision `availability`. This folder imports the kit, the workspace packages and itself, and no other folder of the package: the
// service imports the folder, so an import the other way would make a cycle.
export { AVAILABILITY_DECISION } from './availability.ts';
export type { AvailabilityChoice } from './availability.ts';
