// scripts/operator/lib/secrets.ts - the scan for the marks of a secret in a value that a file or a line of output must not hold.
// The facts file and the machine line of a run hold public values only. This scan finds the marks that a secret leaves: a text that starts a key of the ledger or sets a key variable, a bearer token,
// a token in a URL, and a member with the name of a secret. It finds no secret itself: a seed in hex has the shape of a hash, and no scan can tell the two apart.

/**
 * The texts that mark a secret, in any case: the start of a key of the ledger (`ed25519_sk` and `ed25519e_sk`), the `_sk1` or `_xsk1` of the bech32 text of a key of a wallet, a key variable that is
 * set (`PRIV_KEY_HEX=`), a bearer token (the word and a white space), and a token in a URL (`access_token=`).
 */
const SECRET_TEXT = /ed25519e?_sk|_x?sk1|PRIV_KEY_HEX=|bearer\s|access_token=/i;
/** A member holds a secret when its name is exactly one of these, in any case. A name that only contains one of them (`tokenUnit`, `claimToken`, `seedKind`) is no secret. */
const SECRET_NAME = /^(?:seed|secret|token|authorization|private)$/i;

/** True when a name of a member or of a step of a path has the name of a secret, or carries a mark of one. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || SECRET_TEXT.test(name);
}

/** True when a text holds a mark of a secret, or an object holds a member with the name of a secret, at any depth. A number, a boolean and null hold none. */
export function holdsSecret(value: unknown): boolean {
  if (typeof value === 'string') return SECRET_TEXT.test(value);
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (typeof value === 'object' && value !== null) return Object.entries(value).some(([name, member]) => isSecretName(name) || holdsSecret(member));
  return false;
}
