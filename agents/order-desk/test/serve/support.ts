// agents/order-desk/test/serve/support.ts
// What the tests of the service share: the environment of a full deployment, made at run time from labels so that no key and no token is written in the repository; the identity deployment that the
// environment names, with the policy that it gives; the Module-1 manifest in the form that the dispute code reads; and a few helpers. No test of the service uses the network.
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeChain, identityDeploymentFrom } from '@vsa/buyer-core';
import { stubKey } from '@vsa/hire-kit/testing';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A key made from `label`: its 32 raw bytes are the sha256 of the label, which is also how `stubKey` makes the public key and the key hash. */
export const keyOf = (label: string) => ({ privateKeyHex: sha256(label), ...stubKey(label) });

export const SERVICE = keyOf('order desk service test: the service key');
export const SMALL = keyOf('order desk service test: the small runtime');
export const MEDIUM = keyOf('order desk service test: the medium runtime');
export const LARGE = keyOf('order desk service test: the large runtime');
/** The mainnet enterprise address of the service key. */
export const SERVICE_ADDRESS = new FakeChain({ buyerPkh: SERVICE.pkh }).address;
export const AGENT_DID = `did:vector:${sha256('order desk service test: the agent')}`;
/** The value the runtimes send as the authorization header of every call to the service: "Bearer " and 64 hex characters. */
export const TOKEN = `Bearer ${sha256('order desk service test: the token of the runtimes')}`;
export const AUTH = { authorization: TOKEN };

const ROOT = sha256('order desk service test: the legacy root');
const REF = (label: string): string => `${sha256(label)}#0`;
const IDENTITY_SETTINGS = {
  VECTOR_IDENTITY_LEGACY_ROOT: ROOT,
  VECTOR_IDENTITY_CONFIG_SEED: REF('order desk service test: the config reference'),
  VECTOR_IDENTITY_ESCROW_REF_UTXO: REF('order desk service test: the escrow reference script'),
  VECTOR_IDENTITY_VAULT_REF_UTXO: REF('order desk service test: the vault reference script'),
};
const deployment = identityDeploymentFrom(IDENTITY_SETTINGS);
if (deployment === null) throw new Error('the identity settings of the tests give no deployment');
/** The identity policy that the deployment of the tests gives. */
export const POLICY = deployment.identity.hash;

export const CONTACT = 'ops@example.test';
export const ORIGIN = 'https://orders-small.example.test';

/** What an operator sets for a full deployment, and nothing else: every other setting has a default or is optional. */
export const FULL_ENV: Readonly<Record<string, string>> = {
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  ORDER_DESK_SERVICE_PRIV_KEY_HEX: SERVICE.privateKeyHex,
  SERVICE_AUTH_HEADER: TOKEN,
  LOTS_PUBLIC_ORIGIN: ORIGIN,
  SMALL_SUPPLIER_PKH: SMALL.pkh,
  SMALL_SUPPLIER_PUB_KEY_HEX: SMALL.pubKeyHex,
  MEDIUM_SUPPLIER_PKH: MEDIUM.pkh,
  MEDIUM_SUPPLIER_PUB_KEY_HEX: MEDIUM.pubKeyHex,
  LARGE_SUPPLIER_PKH: LARGE.pkh,
  LARGE_SUPPLIER_PUB_KEY_HEX: LARGE.pubKeyHex,
  IDENTITY_POLICY_ID: POLICY,
  ...IDENTITY_SETTINGS,
  VECTOR_MODULE1_MANIFEST: '/etc/order-desk/module1.json',
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

/** The text of the error that `fn` throws. A call that does not throw fails the test. */
export function message(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('it was accepted');
}

/** Does `text` show a part of `secret` that is worth a search, in any case? */
export const shows = (text: string, secret: string): boolean => text.toLowerCase().includes(secret.slice(-16).toLowerCase());

const dirs: string[] = [];
/** A new empty directory, removed by `cleanDirs`. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'order-desk-service-'));
  dirs.push(dir);
  return dir;
}
export function cleanDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

const MODULE1_FIXTURE = new URL('../../../../packages/buyer-core/test/fixtures/module1-mainnet-manifest.json', import.meta.url);

/**
 * Writes the Module-1 manifest of the mainnet capture to a file of its own, with the identity registry of the deployment of these tests, and gives the path of the file. The service checks that the manifest names
 * the registry that its own deployment gives, so the capture is changed in that one place.
 */
export function module1ManifestFile(identityHash: string = POLICY): string {
  const manifest = JSON.parse(readFileSync(MODULE1_FIXTURE, 'utf8')) as { identity: { identity_hash: string } };
  manifest.identity.identity_hash = identityHash;
  const file = join(tempDir(), 'module1.json');
  writeFileSync(file, JSON.stringify(manifest), 'utf8');
  return file;
}
