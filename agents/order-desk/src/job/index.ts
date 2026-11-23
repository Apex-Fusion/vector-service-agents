// agents/order-desk/src/job/index.ts
// The job of the Order Desk: what it does after the Claim of an escrow. `runOrder` takes the record of the checks, gets an X.509-SVID, reads the catalogue of the supplier portal, takes the model decision
// `availability`, places the order, writes the order book, and gives the confirmation. The fault `confirm_wrong_lot` changes the lot and the quantity of the order and of the confirmation. This folder
// imports the kit, the workspace packages and itself, and no other folder of the package: the service imports the folder, so an import the other way would make a cycle.
export { AVAILABILITY_DECISION } from './availability.ts';
export type { AvailabilityChoice } from './availability.ts';
export { wrongLotOf } from './fault.ts';
export { ORDER_REFUSAL_STATUS, OrderRefusal, runOrder } from './order.ts';
export type { OrderRefusalCode } from './order.ts';
export type { BookPort, OrderDeps, TakenChecks } from './ports.ts';
