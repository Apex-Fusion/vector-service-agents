// packages/service-kit/src/child-env.ts
// The environment of a program that a service starts, without the secrets of the service. A module with no imports, exported alone as @vsa/service-kit/env,
// so that a module that must not load the fetch of a source (the renderer of the Document Pipeline) can use it. Moved from src/env.ts with its filter.

/** The names a program that a service starts is not given, in any case: every name that holds a key, a token, a secret, a password, an API key or an access key. */
const HIDDEN_FROM_CHILDREN = /PRIV_KEY|TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY/i;

/**
 * The environment of a program a service starts (a tool, the worker of a model): a copy of `env` without SERVICE_AUTH_HEADER and without any name that holds
 * PRIV_KEY, TOKEN, SECRET, PASSWORD, API_KEY or ACCESS_KEY, in any case. Everything else is kept, so that PATH, the venv and the locale reach the program as they
 * are. Such a program parses what a caller sent, so it is given none of the secrets of the service: what it cannot read, it cannot leak. `env` itself is left
 * as it is.
 */
export function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.toUpperCase() !== 'SERVICE_AUTH_HEADER' && !HIDDEN_FROM_CHILDREN.test(name)) kept[name] = value;
  }
  return kept;
}
