// packages/usecase-kit/src/access/index.ts
// The credentials of an agent for the systems that it calls, and the sub-delegation to a subagent. Import it as `@vsa/usecase-kit/access`.
//   - routes: the mock routes, and the target of one call (src/routes.ts);
//   - a token for one route, and the token of a subagent (src/token.ts);
//   - a call with a token, with a JWT-SVID, or with an X.509-SVID, and the typed result of a call (src/call.ts, src/answer.ts);
//   - the SVIDs of a counterparty (src/svid.ts, src/mtls.ts);
//   - the sub-delegation, ended in a `finally` path (src/subdelegation.ts, src/signer.ts).
// Every access to the gateway, the ledger, a mock system and the clock goes through a parameter. The folder reads no key file and no environment variable.
export { SYSTEMS, ROUTES, jwtSvidTarget, tokenTarget, x509Target } from './routes.ts';
export type {
  CredentialKind, HttpMethod, JwtSvidRouteId, JwtSvidTarget, MockBases, RouteId, RouteTarget, SystemName, TokenCallers, TokenRouteId, TokenTarget, X509RouteId, X509Target,
} from './routes.ts';

export { systemClock, within } from './ports.ts';
export type { Bounded, Clock } from './ports.ts';

export { GATEWAY_FAILURES } from './gateway.ts';
export type { GatewayFailure, GatewayFailureCode } from './gateway.ts';

export { RouteToken, askWhileTooYoung, requestRouteToken, requestSubagentToken } from './token.ts';
export type { PatientOptions, RouteTokenRequest, RouteTokenResult, SubagentTokenRequest, TokenDeps, TokenHolder } from './token.ts';

export { MAX_CODE_CHARS, REFUSAL_WITHOUT_CODE, codeIn, readAnswer } from './answer.ts';
export type { SystemAnswered, SystemFailed, SystemRefused, SystemResult } from './answer.ts';

export { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_MAX_ANSWER_BYTES, callWithJwtSvid, callWithToken, callWithX509Svid } from './call.ts';
export type { CallDeps } from './call.ts';

export { JwtSvidCredential, X509SvidCredential, fetchJwtSvid, fetchX509Svid } from './svid.ts';
export type { SvidAgent, SvidDeps, TlsCredentials } from './svid.ts';
export { httpsTransport } from './mtls.ts';
export type { MtlsReply, MtlsRequest, MtlsTransport } from './mtls.ts';

export {
  CONFIRMATIONS_REQUIRED, DEFAULT_CONFIRMATION_WAIT_MS, DEFAULT_END_TIMEOUT_MS, DEFAULT_POLL_MS, MAX_SUB_DELEGATION_MS, MIN_SUB_DELEGATION_MS, SUB_DELEGATION_FAILURES, withSubDelegation,
} from './subdelegation.ts';
export type {
  DelegationChain, DelegationDatum, LeftSubDelegation, LiveDelegation, Readiness, SubDelegationDeps, SubDelegationEnd, SubDelegationFailure, SubDelegationFailureCode, SubDelegationHandle,
  SubDelegationLimits, SubDelegationOutcome, SubDelegationRequest, SubDelegationRun, TxSigner,
} from './subdelegation.ts';
export { txSignerOfRawKey } from './signer.ts';
export type { RawKeySigner } from './signer.ts';
