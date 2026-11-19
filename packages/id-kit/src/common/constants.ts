// packages/id-kit/src/common/constants.ts
// The values that the identity gateway fixes and that both the client and the verifier use. The gateway writes the same values in identity-gateway/src/m4/
// (context.ts, delegation.ts, tokens.ts, status-lists.ts). test/live-vectors.test.ts checks the three URIs against what the live gateway serves.

/** The longest life, in seconds, of a subject token, of an access token, of a JWT-SVID and of a DPoP proof that the gateway accepts. */
export const MAX_TOKEN_LIFETIME_S = 300;
/** The difference, in seconds, between two clocks that the gateway accepts when it reads `iat`, `nbf` and `exp`. */
export const CLOCK_LEEWAY_S = 30;
/** The number of entries in one status list. Entry `i` is in list `floor(i / LIST_SIZE)`, at position `i mod LIST_SIZE`. */
export const LIST_SIZE = 131_072;
/** The most links that one delegation chain has. */
export const MAX_DELEGATION_DEPTH = 4;

/** The `type` of the authorization details object that names a delegation. */
export const DELEGATION_DETAILS_TYPE = 'https://id.vector.apexfusion.org/ns/delegation';
/** The grant type of a token request (RFC 8693). */
export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
/** The type of a subject token, and one of the two types of token that a request can ask for. */
export const JWT_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:jwt';
/** The other type of token that a request can ask for. It is the default. */
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

/** The limits of a token request. A longer list or a longer value gets a refusal from the gateway. */
export const MAX_AUDIENCES = 8;
export const MAX_AUDIENCE_LENGTH = 512;
export const MAX_ACTIONS = 16;
export const MAX_LOCATIONS = 8;

/** Key purposes of a record, as the gateway reads them (the `purposes` bit set of a listed key). */
export const PURPOSE = { authentication: 1, assertion: 2, transaction: 8, delegation: 16 } as const;
