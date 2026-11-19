// packages/id-kit/src/index.ts
// The public surface of @vsa/id-kit: the client of the identity gateway (src/client) and the verifier for a relying party (src/verify). The stub gateway for tests is a separate entry,
// `@vsa/id-kit/testing`, and no code of a service imports it. The two sides share the typed results (`Check`, `Refused`, `GatewayResult`) and the names of DIDs and keys.

export * from './client/index.ts';
export {
  ACCESS_TOKEN_RULES, BUNDLE_RULES, CALL_RULES, CREDENTIAL_CALL_RULES, CREDENTIAL_RULES, DPOP_RULES, JWT_SVID_RULES, KEY_SET_RULES, ReplayStoreFull, STATUS_LIST_RULES, X509_SVID_RULES,
  bitstringEntryStatus, checkAccessToken, checkCredential, checkDpopProof, createGatewayReader, createReplayStore, createVerifier, decodeBitstringStatusList, decodeTokenStatusList, gatewayActorCheck,
  isSoftListRule, parseAuthorization, parseBundle, parseKeySet, parseSpiffeId, tokenEntryStatus, verifyGatewayJws, verifyJwtSvid, verifyX509Svid,
} from './verify/index.ts';
export type {
  AccessTokenContext, AccessTokenPolicy, AccessTokenRequest, AccessTokenRule, ActorCheck, AuthorityVerdict, BitstringStatusList, BundleReadRule, BundleRule, CallRequest, CallRule, CredentialCheckRule,
  CredentialContext, CredentialRule, DelegationCheck, DelegationContext, DelegationGrant, DpopRule, EntryStatus, GatewayKey, GatewayReader, GatewayReaderOptions, JwtSvidRule, KeySet, KeySetRule, KeysRule,
  ListContext, ListReadRule, ListSnapshot, Principal, ReplayStore, ReplayStoreOptions, RequiredGrant, SpiffeBundle, StatusListRule, StatusNotRead, StatusRead, StatusReading, SvidCheckRule, SvidContext, TokenStatusList, Verifier,
  VerifiedAccessToken, VerifiedCall, VerifiedCredential, VerifiedCredentialStatus, VerifiedDpop, VerifiedJwtSvid, VerifiedX509Svid, VerifierOptions, X509SvidRule,
} from './verify/index.ts';
