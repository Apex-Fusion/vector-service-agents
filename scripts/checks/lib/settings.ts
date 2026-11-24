// scripts/checks/lib/settings.ts - the settings of the checks, read from the environment. Each value has a name, a check on its shape, and a message that names the setting.
// A message never shows a value that was set: a value can be a secret, and the name is enough to find the mistake. One refusal lists every problem, so that the operator fixes
// them in one pass.
import { resolve } from 'node:path';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, identityDeploymentFrom, makeIdentityDeployment } from './platform.ts';
import type { IdentityDeployment } from './platform.ts';
import type { CheckKeyRole } from './keys.ts';

export type Env = Readonly<Record<string, string | undefined>>;

export class SettingsError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'SettingsError';
    this.problems = problems;
  }
}

/** A network by name, with what the node must say about itself before any transaction is signed. `systemStartMs` null: only the magic is compared. */
export interface NetworkSpec { name: string; magic: number; systemStartMs: number | null }

/** Vector mainnet: the network magic of its genesis, and the time of its slot 0. */
export const VECTOR_MAINNET: NetworkSpec = { name: 'vector-mainnet', magic: 764_824_073, systemStartMs: 1_756_485_600_000 };

const MAX_LIMIT_LOVELACE = 100_000_000_000n;
const DEFAULT_MAX_FEE_LOVELACE = 2_000_000n;
const DEFAULT_MAX_COLLATERAL_LOSS_LOVELACE = 5_000_000n;
const DEFAULT_HOSTED_URL = 'https://mcp.vector.mainnet.apexfusion.org/mcp';
const DEFAULT_GATEWAY_URL = 'https://id.vector.apexfusion.org';

/** Reads settings one by one and keeps what is wrong with them. `done` throws all the problems together. */
export class EnvReader {
  readonly problems: string[] = [];
  readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  /** The value of a setting, trimmed; an empty value is not set. */
  text(name: string, required: boolean): string | undefined {
    const value = this.env[name]?.trim();
    if (value === undefined || value === '') {
      if (required) this.problems.push(`set ${name}`);
      return undefined;
    }
    return value;
  }

  /** A whole number from `min` to `max`. A value that is not set gives `fallback`; with no fallback it is a problem. A wrong value is a problem and gives the fallback. */
  whole(name: string, min: bigint, max: bigint, fallback: bigint | undefined): bigint {
    const value = this.text(name, fallback === undefined);
    if (value === undefined) return fallback ?? min;
    if (!/^(0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) < min || BigInt(value) > max) {
      this.problems.push(`${name} must be a whole number from ${min} to ${max}`);
      return fallback ?? min;
    }
    return BigInt(value);
  }

  /** An https URL (http only for 127.0.0.1 and localhost) with no user name and no password; trailing slashes are cut. */
  url(name: string, fallback: string | undefined): string {
    const value = this.text(name, fallback === undefined) ?? fallback ?? '';
    let parsed: URL | null = null;
    try { parsed = new URL(value); } catch { /* refused below */ }
    const loopback = parsed !== null && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
    const protocolOk = parsed !== null && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback));
    if (parsed === null || !protocolOk || parsed.username !== '' || parsed.password !== '') {
      this.problems.push(`${name} must be an https URL (http only for 127.0.0.1 or localhost) with no user name or password`);
      return fallback ?? '';
    }
    let end = value.length;
    while (end > 0 && value[end - 1] === '/') end -= 1;
    return value.slice(0, end);
  }

  done(): void {
    if (this.problems.length > 0) throw new SettingsError(this.problems);
  }
}

export interface CommonSettings {
  network: NetworkSpec;
  stateDir: string;
  recordId: string;
  recordDid: string;
  urls: { ogmios: string; submit: string; koios: string; hosted: string; gateway: string };
  maxFeeLovelace: bigint;
  maxCollateralLossLovelace: bigint;
  /** The key files that the check needs, and the authentication key file when it is given. */
  keyFiles: Partial<Record<CheckKeyRole | 'authentication', string>>;
}

export interface Needs {
  keys: readonly CheckKeyRole[];
}

const KEY_SETTING: Record<CheckKeyRole, string> = {
  controller: 'CHECKS_CONTROLLER_KEY_FILE',
  agent: 'CHECKS_AGENT_KEY_FILE',
  member: 'CHECKS_MEMBER_KEY_FILE',
};

function networkOf(reader: EnvReader): NetworkSpec {
  const name = reader.text('CHECKS_NETWORK', true);
  if (name === undefined) return VECTOR_MAINNET;
  const magic = reader.env.CHECKS_NETWORK_MAGIC?.trim() ?? '';
  if (name === VECTOR_MAINNET.name) {
    if (magic !== '' && magic !== String(VECTOR_MAINNET.magic)) reader.problems.push(`CHECKS_NETWORK_MAGIC is not the magic of ${VECTOR_MAINNET.name}: leave it out`);
    return VECTOR_MAINNET;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) {
    reader.problems.push('CHECKS_NETWORK must be vector-mainnet, or a name of a test network (lower case letters, digits and dashes)');
    return VECTOR_MAINNET;
  }
  const testMagic = reader.whole('CHECKS_NETWORK_MAGIC', 0n, 4_294_967_295n, undefined);
  const start = reader.text('CHECKS_NETWORK_SYSTEM_START_MS', false);
  const systemStartMs = start === undefined ? null : Number(reader.whole('CHECKS_NETWORK_SYSTEM_START_MS', 1n, 9_007_199_254_740_991n, undefined));
  return { name, magic: Number(testMagic), systemStartMs };
}

function recordOf(reader: EnvReader): { id: string; did: string } {
  const value = reader.text('CHECKS_RECORD', true);
  if (value === undefined) return { id: '', did: '' };
  const match = /^(?:did:vector:)?([0-9a-fA-F]{64})$/i.exec(value);
  if (match === null) {
    reader.problems.push('CHECKS_RECORD must be the DID of the test record (did:vector: and 64 hex characters) or its 64 hex characters');
    return { id: '', did: '' };
  }
  const id = match[1]!.toLowerCase();
  return { id, did: `did:vector:${id}` };
}

/** The settings that every check reads. Throws a SettingsError that lists each problem. */
export function parseCommonSettings(env: Env, needs: Needs): CommonSettings {
  const reader = new EnvReader(env);
  const network = networkOf(reader);
  const record = recordOf(reader);
  const keyFiles: CommonSettings['keyFiles'] = {};
  for (const role of needs.keys) {
    const path = reader.text(KEY_SETTING[role], true);
    if (path !== undefined) keyFiles[role] = path;
  }
  const authentication = reader.text('CHECKS_AUTH_KEY_FILE', false);
  if (authentication !== undefined) keyFiles.authentication = authentication;
  const settings: CommonSettings = {
    network,
    stateDir: resolve(reader.text('CHECKS_STATE_DIR', false) ?? 'checks-state'),
    recordId: record.id,
    recordDid: record.did,
    urls: {
      ogmios: reader.url('VECTOR_OGMIOS_URL', VECTOR_OGMIOS_URL),
      submit: reader.url('VECTOR_SUBMIT_URL', VECTOR_SUBMIT_URL),
      koios: reader.url('VECTOR_KOIOS_URL', VECTOR_KOIOS_URL),
      hosted: reader.url('CHECKS_HOSTED_URL', DEFAULT_HOSTED_URL),
      gateway: reader.url('CHECKS_GATEWAY_URL', DEFAULT_GATEWAY_URL),
    },
    maxFeeLovelace: reader.whole('CHECKS_MAX_FEE_LOVELACE', 1n, MAX_LIMIT_LOVELACE, DEFAULT_MAX_FEE_LOVELACE),
    maxCollateralLossLovelace: reader.whole('CHECKS_MAX_COLLATERAL_LOSS_LOVELACE', 1n, MAX_LIMIT_LOVELACE, DEFAULT_MAX_COLLATERAL_LOSS_LOVELACE),
    keyFiles,
  };
  reader.done();
  return settings;
}

// ─── The identity deployment ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The values that the identity registry published on Vector mainnet on 2026-11-03: the root of its allowlist, the seed of its seal, and its reference scripts. They are public chain data. */
const MAINNET_IDENTITY = {
  legacyRoot: 'e4b6b17ce4a8f83aa17d3181ea140d2bd76c0cfa8a7c44ad69543800b4a0df01',
  configSeed: { txHash: '6c9856c70b1101f1a4e9ceb373188608013416eff48c51f5bb62706a65d41a2a', outputIndex: 0 },
  refs: {
    identity: { txHash: '3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46', outputIndex: 0 },
    attestation: { txHash: '55dfa9e05ff96844fd4313f1c7cb7f0c7f900f1cdf50099b0e2abb242da4128d', outputIndex: 0 },
    delegation: { txHash: 'f6d47a62146b2bc4dabc12454c8a3dbbedf673d45a6edccd1c462d55c8ba8be7', outputIndex: 0 },
    vault: { txHash: 'd0bf8f73c915fcbf57ddba714256e520a9a0820bc9e643218db8cf54762d215b', outputIndex: 0 },
    escrow: { txHash: '4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82', outputIndex: 0 },
    advert: { txHash: '5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758', outputIndex: 0 },
  },
} as const;

/**
 * The identity deployment of a run. When a VECTOR_IDENTITY_* setting is set, the reader of the MCP server reads them all (the root and the seed are required together). Without one,
 * Vector mainnet has the deployment that was published, and a test network has none: its run names the values.
 */
export function deploymentFor(network: NetworkSpec, env: Env): IdentityDeployment {
  let named: IdentityDeployment | null;
  try { named = identityDeploymentFrom({ ...env }); } catch (err) { throw new SettingsError([err instanceof Error ? err.message : String(err)]); }
  if (named !== null) return named;
  if (network.name !== VECTOR_MAINNET.name) {
    throw new SettingsError([`set VECTOR_IDENTITY_LEGACY_ROOT, VECTOR_IDENTITY_CONFIG_SEED and the VECTOR_IDENTITY_*_REF_UTXO values of the identity registry of ${network.name}: only vector-mainnet has a published deployment`]);
  }
  return makeIdentityDeployment({ legacyRoot: MAINNET_IDENTITY.legacyRoot, configSeed: { ...MAINNET_IDENTITY.configSeed }, refs: Object.fromEntries(Object.entries(MAINNET_IDENTITY.refs).map(([name, ref]) => [name, { ...ref }])) });
}
