// agents/insurer-intake-agent/test/serve/support.ts
// What the tests of the serve folder share: the stand-in keys, a complete environment, a clock that moves by hand, and a few helpers. A key and a token are made at run time from a label, so that none is written in
// the repository. No test of this folder uses the network, and no key is real. The environment holds the settings that need no key and no identity deployment: the start adds the key and the identity names.
import { createHash } from 'node:crypto';
import { FakeChain } from '@vsa/buyer-core';
import { T0, stubKey } from '@vsa/hire-kit/testing';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityDeploymentFrom, rawHexToBech32 } from '@vsa/buyer-core';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A key made from `label`: its 32 raw bytes are the SHA-256 of the label, which is also how `stubKey` makes the public key and the key hash. */
export const standInKey = (label: string) => ({ privateKeyHex: sha256(label), ...stubKey(label) });

/** The service key of the tests: the key that the service pays with and that signs its requests for a JWT-SVID. */
export const SERVICE = standInKey('insurer intake settings test: the service key');
/** The supplier key of the tests. It is the key of the runtime, and the service holds its public values only. */
export const SUPPLIER = standInKey('insurer intake settings test: the supplier key of the runtime');
/** A key that is no key of the service. */
export const OTHER = standInKey('insurer intake settings test: another key');
/** The mainnet enterprise address of the service key. */
export const SERVICE_ADDRESS = new FakeChain({ buyerPkh: SERVICE.pkh }).address;

export const AGENT_DID = `did:vector:${sha256('insurer intake settings test: the agent')}`;
/** The value that the runtime sends as the authorization header of every call to the service: "Bearer " and 64 hex characters. */
export const TOKEN = `Bearer ${sha256('insurer intake settings test: the token of the runtime')}`;
/** An identity policy in its form (56 hex characters). It is the policy of no deployment. */
export const POLICY = sha256('insurer intake settings test: the identity policy').slice(0, 56);
export const CONTACT = 'ops@example.test';

/**
 * The pinned address of the Module-1 manifest that the tests give the service: an https URL with the 40 hex characters of a commit as a segment of its path. The host is an IP literal of the range for documentation,
 * so that a fetch of the manifest needs no lookup of a name.
 */
export const MODULE1_COMMIT = sha256('insurer intake settings test: the commit of the Module-1 manifest').slice(0, 40);
export const MODULE1_URL = `https://203.0.113.9/modules/${MODULE1_COMMIT}/Module-1/deploy/identity/mainnet/manifest.json`;

/** What an operator sets for a full deployment, and nothing else: every other setting has a default or is optional. */
export const FULL_ENV: Readonly<Record<string, string>> = {
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  IDENTITY_POLICY_ID: POLICY,
  SERVICE_AUTH_HEADER: TOKEN,
  SUPPLIER_PKH: SUPPLIER.pkh,
  SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex,
  INTAKE_SERVICE_PKH: SERVICE.pkh,
  VECTOR_MODULE1_MANIFEST: MODULE1_URL,
  MOCK_PUBLIC_BASE: 'https://mock.example.test',
  MOCK_MTLS_BASE: 'https://mock-mtls.example.test',
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
  DISPUTE_CHALLENGE_STAKE_LOVELACE: '50000000',
  DISPUTE_MIN_WINDOW_LEFT_MS: '600000',
  DISPUTE_READ_TIMEOUT_MS: '20000',
};

/** The environment with some settings replaced. A value of `undefined` takes the setting away. */
export function envWith(over: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...FULL_ENV };
  for (const [name, value] of Object.entries(over)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** The text of the error that `work` throws. A call that does not throw fails the test. */
export function message(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('it was accepted');
}

/**
 * Does `text` show `value`? A value of digits only is shown when its number stands in the text as a whole number: the text "from 500 to 1499" does not show 499. A longer value is shown when any run of 12 of its
 * characters stands in the text, in any case, so a message that repeats a part of it is found too. A value of fewer than 3 characters is never counted: it stands in any text by chance.
 */
export function shows(text: string, value: string): boolean {
  if (value.length < 3) return false;
  if (/^\d+$/.test(value)) {
    const numbers: string[] = text.match(/\d+/g) ?? [];
    return numbers.includes(value);
  }
  const lower = text.toLowerCase();
  const run = Math.min(value.length, 12);
  for (let at = 0; at + run <= value.length; at += 1) if (lower.includes(value.slice(at, at + run).toLowerCase())) return true;
  return false;
}

/** A clock that moves only when a test moves it, in milliseconds since the epoch. `now` is an arrow function, so a test can pass it as a bare function. */
export class FakeClock {
  #now: number;

  constructor(start: number = T0) {
    this.#now = start;
  }

  readonly now = (): number => this.#now;

  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('a clock moves forward by a whole number of milliseconds');
    this.#now += ms;
  }

  /** Waits for no time at all: the clock moves by `ms` and the promise is done. */
  sleep(ms: number): Promise<void> {
    this.advance(ms);
    return Promise.resolve();
  }
}

// --- what the tests of the start and of the service over HTTP add ---------------------------------------------------------------------------------------------

/** The one key variable of the start. The start names it, and the tests name it here. */
export const KEY_VARIABLES = { service: 'INTAKE_SERVICE_PRIV_KEY_HEX' } as const;

const REF = (label: string): string => `${sha256(label)}#0`;
/** The four identity names and their values: a legacy root, the configuration reference and the two reference scripts. Each value is made from a label. */
export const IDENTITY_SETTINGS = {
  VECTOR_IDENTITY_LEGACY_ROOT: sha256('insurer intake service test: the legacy root'),
  VECTOR_IDENTITY_CONFIG_SEED: REF('insurer intake service test: the config reference'),
  VECTOR_IDENTITY_ESCROW_REF_UTXO: REF('insurer intake service test: the escrow reference script'),
  VECTOR_IDENTITY_VAULT_REF_UTXO: REF('insurer intake service test: the vault reference script'),
} as const;
const deployment = identityDeploymentFrom(IDENTITY_SETTINGS);
if (deployment === null) throw new Error('the identity settings of the tests give no deployment');
/** The identity policy that the deployment of the tests gives. `IDENTITY_POLICY_ID` must equal it for a start. */
export const DEPLOYMENT_POLICY: string = deployment.identity.hash;

/** The value that the runtime sends as the authorization header, as the header of a call to the service. */
export const AUTH = { authorization: TOKEN };

/**
 * What an operator sets for a start: the full environment, the service key, and the four identity names with the policy that they give. `over` replaces settings, and a value of `undefined` takes a setting away.
 * The key and the policy are what the environment of the settings tests leaves out, because a settings test needs neither.
 */
export function startEnvWith(over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv {
  return envWith({ [KEY_VARIABLES.service]: SERVICE.privateKeyHex, ...IDENTITY_SETTINGS, IDENTITY_POLICY_ID: DEPLOYMENT_POLICY, ...over });
}

/** The secrets of a start: the service key in both its forms, the token, and the credential of the token. No log line, answer or message shows any of them. */
export function secretsOf(): string[] {
  return [SERVICE.privateKeyHex, rawHexToBech32(SERVICE.privateKeyHex), TOKEN, TOKEN.slice('Bearer '.length)];
}

const dirs: string[] = [];
/** A new empty directory, removed by `cleanDirs`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'insurer-intake-service-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const MODULE1_FIXTURE = new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url);

/**
 * The text of the Module-1 manifest of the mainnet capture, with the identity registry of the deployment of these tests. The service checks that the manifest names the registry that its own deployment gives, so
 * the capture is changed in that one place. `identityHash` gives another registry, for the test of the refusal.
 */
export function module1ManifestText(identityHash: string = DEPLOYMENT_POLICY): string {
  const manifest = JSON.parse(readFileSync(MODULE1_FIXTURE, 'utf8')) as { identity: { identity_hash: string } };
  manifest.identity.identity_hash = identityHash;
  return JSON.stringify(manifest);
}

/** What the host of the manifest answers: a text with the status 200, or a status alone with no body. */
export type Module1Answer = string | { readonly status: number };

/** A fetch that answers the address of the Module-1 manifest with `answer`, and passes every other call on to `next`. */
export function withModule1(next: typeof fetch, answer: Module1Answer = module1ManifestText()): typeof fetch {
  const address = new URL(MODULE1_URL).href;
  return async (input, init) => {
    const href = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href;
    if (href !== address) return next(input, init);
    return typeof answer === 'string' ? new Response(answer, { status: 200, headers: { 'content-type': 'text/plain' } }) : new Response('', { status: answer.status });
  };
}

/** A file with the manifest of these tests, for the child process of a test: a child cannot take a stub fetch, so its preload (module1-preload.mjs) answers the address from this file. */
export function module1StubFile(): string {
  const file = join(tempDir(), 'module1.json');
  writeFileSync(file, module1ManifestText(), 'utf8');
  return file;
}
