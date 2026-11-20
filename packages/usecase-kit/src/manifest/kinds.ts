// packages/usecase-kit/src/manifest/kinds.ts
// Two checks of a kind of agent. A kind is code, but the code of an agent can be plain JavaScript, so the builders check it at run time. This file is not part of the public surface.
import { AGENT_KINDS, BUYER_SIDE_KINDS } from '../protocol/index.ts';
import type { AgentKind, BuyerSideKind } from '../protocol/index.ts';

export const isAgentKind = (value: unknown): value is AgentKind => typeof value === 'string' && (AGENT_KINDS as readonly string[]).includes(value);

export const isBuyerSideKind = (value: AgentKind): value is BuyerSideKind => (BUYER_SIDE_KINDS as readonly string[]).includes(value);
