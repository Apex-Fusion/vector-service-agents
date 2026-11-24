// The texts that the secret scan must find, and texts that look like them and must pass. No key is in a source file: each text that looks like a key or a key variable is built at run time.

/** A text that looks like a key of the ledger, made at run time so that no source file holds it. */
export const KEY_TEXT = ['ed25519', `sk1${'q'.repeat(40)}`].join('_');

const PAYLOAD = 'q'.repeat(40);
const KEY_VARIABLE = ['SUPPLIER', 'PRIV', 'KEY', 'HEX'].join('_');

export interface TextRow { readonly label: string; readonly text: string }

/** Texts that carry a mark of a secret: the scan finds each, in any text and in any case. */
export const SECRET_TEXTS: readonly TextRow[] = [
  { label: 'a key of the ledger', text: KEY_TEXT },
  { label: 'a key of the ledger in upper case', text: KEY_TEXT.toUpperCase() },
  { label: 'the start of a key of the ledger and no more', text: ['ed25519', 'sk'].join('_') },
  { label: 'an extended key of the ledger', text: ['ed25519e', `sk1${PAYLOAD}`].join('_') },
  { label: 'an extended key of a wallet', text: ['root', `xsk1${PAYLOAD}`].join('_') },
  { label: 'a key of an address', text: ['addr', `sk1${PAYLOAD}`].join('_') },
  { label: 'a key variable that is set', text: `${KEY_VARIABLE}=${'ab'.repeat(32)}` },
  { label: 'a key variable with no value', text: `${KEY_VARIABLE}=` },
  { label: 'a key variable in lower case', text: `${KEY_VARIABLE.toLowerCase()}=${'ab'.repeat(32)}` },
  { label: 'a bearer token', text: 'Bearer abc123' },
  { label: 'a bearer token in lower case', text: 'bearer abc123' },
  { label: 'a bearer token with a tab', text: 'Bearer\tabc123' },
  { label: 'a bearer token with a line break', text: 'Bearer\nabc123' },
  { label: 'a bearer token in a header', text: 'Authorization: Bearer abc123' },
  { label: 'a token in a URL', text: 'https://agent.example/path?access_token=abc123' },
  { label: 'a token in a URL after another parameter', text: 'https://agent.example/path?a=1&access_token=abc123' },
  { label: 'a token in a URL in upper case', text: 'ACCESS_TOKEN=abc123' },
];

/** Texts that only look like a secret: the scan lets each pass. Each is the twin of a row of SECRET_TEXTS. */
export const LOOKALIKE_TEXTS: readonly TextRow[] = [
  { label: 'a URL that ends with the word bearer', text: 'https://agent.example/bearer' },
  { label: 'the word bearer alone', text: 'bearer' },
  { label: 'a longer word', text: 'Bearers' },
  { label: 'a word that holds bearer', text: 'the bearerless case' },
  { label: 'the name of the curve', text: 'ed25519' },
  { label: 'the name of the curve and sk, with a hyphen', text: 'ed25519-sk' },
  { label: 'the name of the curve and sk, with a space', text: 'ed25519 sk' },
  { label: 'the name of the extended curve', text: 'ed25519e' },
  { label: 'sk1 with no underscore before it', text: 'sk1abcdef' },
  { label: 'a word with _sk and no 1', text: 'task_skip' },
  { label: 'a name of a token with no equals sign', text: 'access_token' },
  { label: 'a name with a hyphen in place of the underscore', text: 'access-token=abc123' },
  { label: 'the name of a key variable with no equals sign', text: KEY_VARIABLE },
  { label: 'a part of the name of a key variable', text: 'PRIV_KEY' },
];

/** Names of members that hold a secret: exactly one of five words, in any case. */
export const SECRET_NAMES: readonly string[] = ['seed', 'secret', 'token', 'authorization', 'private', 'Seed', 'SECRET', 'Token', 'AUTHORIZATION', 'pRiVaTe'];

/** Names of members that only contain one of the five words. */
export const LOOKALIKE_NAMES: readonly string[] = ['tokenUnit', 'claimToken', 'seedKind', 'seeded-runtime', 'tokens', 'privately', 'secrets', 'authorize'];
