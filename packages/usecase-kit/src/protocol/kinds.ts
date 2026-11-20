// packages/usecase-kit/src/protocol/kinds.ts
// The kinds of agent. There are eight agents of six kinds: the Bid Desk kind runs three agents with one code. A buyer-side agent is hired by the hiring organisation, proposes, and then
// executes an approved proposal. A counterparty is hired by a buyer-side agent.

/** The buyer-side agents: use case 1 (inventory reorder), use case 2 (prior authorization) and use case 3 (supplier bid evaluation). */
export const BUYER_SIDE_KINDS = ['reorder-agent', 'prior-authorization-agent', 'sourcing-agent'] as const;
/** The counterparties of those agents, in the same order of use cases. */
export const COUNTERPARTY_KINDS = ['order-desk', 'insurer-intake-agent', 'bid-desk'] as const;
export const AGENT_KINDS = [...BUYER_SIDE_KINDS, ...COUNTERPARTY_KINDS] as const;

export type BuyerSideKind = (typeof BUYER_SIDE_KINDS)[number];
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];
export type AgentKind = (typeof AGENT_KINDS)[number];
