// agents/bid-desk/test/serve/support.ts
// What the tests of the service share: the environment of a full deployment, made at run time from labels so that no key and no token is written in the repository; the identity deployment that the
// environment names, with the policy that it gives; the three price list files with their pinned hashes; and a few helpers. No test of the service uses the network.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FakeChain, identityDeploymentFrom } from '@vsa/buyer-core';
import { stubKey } from '@vsa/hire-kit/testing';
import type { Instance } from '../../src/serve/settings.ts';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A key made from `label`: its 32 raw bytes are the sha256 of the label, which is also how `stubKey` makes the public key and the key hash. */
export const keyOf = (label: string) => ({ privateKeyHex: sha256(label), ...stubKey(label) });

export const SERVICE = keyOf('bid desk service test: the service key');
export const SUPPLIER = keyOf('bid desk service test: the supplier key');
/** The mainnet enterprise address of the service key. */
export const SERVICE_ADDRESS = new FakeChain({ buyerPkh: SERVICE.pkh }).address;
export const AGENT_DID = `did:vector:${sha256('bid desk service test: the agent')}`;
/** The value the runtime sends as the authorization header of every call to the service: "Bearer " and 64 hex characters. */
export const TOKEN = `Bearer ${sha256('bid desk service test: the token of the runtime')}`;

const REF = (label: string): string => `${sha256(label)}#0`;
/** The four settings that name the identity deployment. */
export const IDENTITY_SETTINGS = {
  VECTOR_IDENTITY_LEGACY_ROOT: sha256('bid desk service test: the legacy root'),
  VECTOR_IDENTITY_CONFIG_SEED: REF('bid desk service test: the config reference'),
  VECTOR_IDENTITY_ESCROW_REF_UTXO: REF('bid desk service test: the escrow reference script'),
  VECTOR_IDENTITY_VAULT_REF_UTXO: REF('bid desk service test: the vault reference script'),
};
const deployment = identityDeploymentFrom(IDENTITY_SETTINGS);
if (deployment === null) throw new Error('the identity settings of the tests give no deployment');
/** The identity policy that the deployment of the tests gives. */
export const POLICY = deployment.identity.hash;

export const CONTACT = 'ops@example.test';
export const ORIGIN = 'https://bids-alfa.example.test';
export const ORGANISATION = 'alfa.example.test';

/** The SHA-256 of each price list file, pinned. A change to a list changes its hash and the manifest of its instance, so the number changes with it. */
export const PRICE_LIST_SHA256: Readonly<Record<Instance, string>> = {
  alfa: '8398730303d1a13c26dc761d9d85f14a09a8ee0b495e584f132599a79f80ae1d',
  bravo: '60969045f9fc8f1d8371f864315e58a302d0100369559658fbba8c056e9fa6b0',
  charlie: 'c78398a4f0276aca2980f78d0488c296e8159716228874e748d03243a077b22b',
};

/** The address of the price list file of an instance, written here and not taken from the settings, so that a test of the settings can hold the two together. */
export const priceListUrl = (instance: Instance): URL => new URL(`../../price-lists/${instance}.json`, import.meta.url);

/** The text of the price list file of an instance, and its SHA-256 as `node:crypto` makes it. */
export function priceListOf(instance: Instance): { readonly text: string; readonly sha256: string } {
  const text = readFileSync(priceListUrl(instance), 'utf8');
  return { text, sha256: sha256(text) };
}

/** What an operator sets for a full deployment of the first instance, as far as the readers of this part go: every other setting has a default or is optional. */
export const FULL_ENV: Readonly<Record<string, string>> = {
  OPERATOR_CONTACT: CONTACT,
  AGENT_DID,
  BID_DESK_INSTANCE: 'alfa',
  BID_DESK_ORGANISATION: ORGANISATION,
  BID_DESK_PUBLIC_ORIGIN: ORIGIN,
  BID_DESK_SERVICE_PRIV_KEY_HEX: SERVICE.privateKeyHex,
  SERVICE_AUTH_HEADER: TOKEN,
  SUPPLIER_PKH: SUPPLIER.pkh,
  SUPPLIER_PUB_KEY_HEX: SUPPLIER.pubKeyHex,
  IDENTITY_POLICY_ID: POLICY,
  LLM_MODEL_ALLOWLIST: 'deepseek/deepseek-v4-flash',
  LLM_MAX_PRICE_LOVELACE: '1000000',
  LLM_MAX_SUPPLIER_BOND_LOVELACE: '2000000',
  LLM_MAX_BUYER_BOND_LOVELACE: '2000000',
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

/** The environment of a full deployment of one instance: its own origin and organisation. */
export const envOf = (instance: Instance, over: Readonly<Record<string, string | undefined>> = {}): NodeJS.ProcessEnv =>
  envWith({ BID_DESK_INSTANCE: instance, BID_DESK_PUBLIC_ORIGIN: `https://bids-${instance}.example.test`, BID_DESK_ORGANISATION: `${instance}.example.test`, ...over });

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
