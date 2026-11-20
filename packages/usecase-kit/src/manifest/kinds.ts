// packages/usecase-kit/src/manifest/kinds.ts
// A check of a kind of agent that only the manifest needs. The code of an agent can be plain JavaScript, so the builders check a kind at run time with `isAgentKind` of the protocol. This file is not part
// of the public surface.
import { BUYER_SIDE_KINDS } from '../protocol/index.ts';
import type { AgentKind, BuyerSideKind } from '../protocol/index.ts';

export const isBuyerSideKind = (value: AgentKind): value is BuyerSideKind => (BUYER_SIDE_KINDS as readonly string[]).includes(value);
