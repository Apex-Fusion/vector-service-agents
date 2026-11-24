// scripts/operator/lib/settings.ts - the settings of the operator pack, read from the environment that the caller gives (the caller reads the process environment, and this file does not).
// Each setting has a name, a check on its shape, and a message that names the setting. A message never shows a value that was set: a value can be a secret, and the name is enough to find the
// mistake. One refusal lists every problem, so that the operator fixes them in one pass. The state folder is made, with mode 700, only after every setting has passed, so a refused run makes nothing.
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { VECTOR_KOIOS_URL, VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL } from '../../checks/lib/platform.ts';
import { EnvReader, SettingsError, VECTOR_MAINNET } from '../../checks/lib/settings.ts';
import type { Env, NetworkSpec } from '../../checks/lib/settings.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';
import type { OperatorSettings } from './contract.ts';
import { codeOf } from './registry.ts';

/** What a look at a path finds: a folder or a file, and its permission bits. */
export interface Found { isFolder: boolean; mode: number }

/** What the settings need from the file system. A test gives a fake for the parts that it breaks. */
export interface SettingsIo {
  /** What is at a path, or null when nothing is there. */
  stat(path: string): Found | null;
  /** Makes a folder with mode 700, and the folders above it when they are missing. */
  makeFolder(path: string): void;
}

const FOLDER_MODE = 0o700;
const CHECK_MODES = process.platform !== 'win32';
const DEFAULT_USE_CASE = 'inventory-reorder';
const DEFAULT_AGENTS_DIR = '/agents';
const DEFAULT_HOSTED_URL = 'https://mcp.vector.mainnet.apexfusion.org/mcp';
const DEFAULT_GATEWAY_URL = 'https://id.vector.apexfusion.org';
const DEFAULT_MAX_FEE_LOVELACE = 2_000_000n;
const DEFAULT_MAX_COLLATERAL_LOSS_LOVELACE = 5_000_000n;
const MAX_LIMIT_LOVELACE = 100_000_000_000n;
const MAX_PATH = 4096;
const MAX_CONTACT = 254;
const COMMIT = /^[0-9a-f]{40}$/;
const TEST_NETWORK = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** A control character of any range: a line break, a null byte, an escape. */
const CONTROL = /\p{Cc}/u;

const realIo: SettingsIo = {
  stat: (path) => {
    const found = statSync(path, { throwIfNoEntry: false });
    return found === undefined ? null : { isFolder: found.isDirectory(), mode: found.mode & 0o777 };
  },
  makeFolder: (path) => {
    mkdirSync(path, { recursive: true, mode: FOLDER_MODE });
    chmodSync(path, FOLDER_MODE);
  },
};

/** A path setting, made absolute as the checks do. A path with a control character or with too many characters is a problem: the file system refuses it with a message that shows it. */
function pathOf(reader: EnvReader, name: string, required: boolean): string | undefined {
  const value = reader.text(name, required);
  if (value === undefined) return undefined;
  if (value.length > MAX_PATH || CONTROL.test(value)) {
    reader.problems.push(`${name} must have at most ${MAX_PATH} characters and no control character`);
    return undefined;
  }
  return resolve(value);
}

/** Looks at a folder setting. A failure of the file system is a problem that has its short code and nothing of its message; the answer is then 'failed'. */
function look(reader: EnvReader, files: SettingsIo, name: string, path: string): Found | null | 'failed' {
  try { return files.stat(path); } catch (err) {
    reader.problems.push(`${name} could not be looked at (${codeOf(err)})`);
    return 'failed';
  }
}

function networkOf(reader: EnvReader): NetworkSpec {
  const name = reader.text('OPERATOR_NETWORK', false) ?? VECTOR_MAINNET.name;
  const magic = reader.env.OPERATOR_NETWORK_MAGIC?.trim() ?? '';
  if (name === VECTOR_MAINNET.name) {
    if (magic !== '' && magic !== String(VECTOR_MAINNET.magic)) reader.problems.push(`OPERATOR_NETWORK_MAGIC is not the magic of ${VECTOR_MAINNET.name}: leave it out`);
    return Object.freeze({ ...VECTOR_MAINNET });
  }
  if (!TEST_NETWORK.test(name)) {
    reader.problems.push('OPERATOR_NETWORK must be vector-mainnet, or the name of a test network (lower case letters, digits and dashes)');
    return Object.freeze({ ...VECTOR_MAINNET });
  }
  const testMagic = reader.whole('OPERATOR_NETWORK_MAGIC', 0n, 4_294_967_295n, undefined);
  const start = reader.text('OPERATOR_NETWORK_SYSTEM_START_MS', false);
  const systemStartMs = start === undefined ? null : Number(reader.whole('OPERATOR_NETWORK_SYSTEM_START_MS', 1n, 9_007_199_254_740_991n, undefined));
  return Object.freeze({ name, magic: Number(testMagic), systemStartMs });
}

/**
 * Reads the settings of a run from `env`. Throws a SettingsError that lists each problem and shows no value. A state folder that is missing is made with mode 700, but only when every setting
 * is valid. A state folder that exists with another mode, and a key folder that does not exist, are problems.
 */
export function parseOperatorSettings(env: Env, io: Partial<SettingsIo> = {}): OperatorSettings {
  const files: SettingsIo = { ...realIo, ...io };
  const reader = new EnvReader(env);
  const network = networkOf(reader);

  const useCase = reader.text('OPERATOR_USE_CASE', false) ?? DEFAULT_USE_CASE;
  if (!USE_CASE_NAMES.some((known) => known === useCase)) reader.problems.push(`OPERATOR_USE_CASE must be one of: ${USE_CASE_NAMES.join(', ')}`);

  const keysDir = pathOf(reader, 'OPERATOR_KEYS_DIR', true);
  if (keysDir !== undefined) {
    const found = look(reader, files, 'OPERATOR_KEYS_DIR', keysDir);
    if (found !== 'failed' && (found === null || !found.isFolder)) reader.problems.push('OPERATOR_KEYS_DIR must be a folder that exists');
  }

  const stateDir = pathOf(reader, 'OPERATOR_STATE_DIR', true);
  let makeState = false;
  if (stateDir !== undefined) {
    const found = look(reader, files, 'OPERATOR_STATE_DIR', stateDir);
    if (found === null) makeState = true;
    else if (found !== 'failed' && !found.isFolder) reader.problems.push('OPERATOR_STATE_DIR must be a folder, and a file is there');
    else if (found !== 'failed' && CHECK_MODES && found.mode !== FOLDER_MODE) reader.problems.push(`OPERATOR_STATE_DIR is a folder with mode ${found.mode.toString(8)}: set mode 700 on it`);
  }

  const agentsDir = pathOf(reader, 'OPERATOR_AGENTS_DIR', false) ?? DEFAULT_AGENTS_DIR;
  const goFile = pathOf(reader, 'OPERATOR_GO_FILE', false) ?? join(stateDir ?? '', 'GO.json');
  const mockEnvFile = pathOf(reader, 'OPERATOR_MOCK_ENV_FILE', false) ?? null;

  const contact = reader.text('OPERATOR_CONTACT', false);
  if (contact !== undefined && (contact.length > MAX_CONTACT || CONTROL.test(contact))) reader.problems.push(`OPERATOR_CONTACT must be one line of at most ${MAX_CONTACT} characters`);

  const module1Commit = reader.text('OPERATOR_MODULE1_COMMIT', false);
  if (module1Commit !== undefined && !COMMIT.test(module1Commit)) reader.problems.push('OPERATOR_MODULE1_COMMIT must be 40 lower-case hex characters, or not set');

  const urls = Object.freeze({
    ogmios: reader.url('VECTOR_OGMIOS_URL', VECTOR_OGMIOS_URL),
    submit: reader.url('VECTOR_SUBMIT_URL', VECTOR_SUBMIT_URL),
    koios: reader.url('VECTOR_KOIOS_URL', VECTOR_KOIOS_URL),
    hosted: reader.url('OPERATOR_HOSTED_URL', DEFAULT_HOSTED_URL),
    gateway: reader.url('OPERATOR_GATEWAY_URL', DEFAULT_GATEWAY_URL),
  });
  const maxFeeLovelace = reader.whole('OPERATOR_MAX_FEE_LOVELACE', 1n, MAX_LIMIT_LOVELACE, DEFAULT_MAX_FEE_LOVELACE);
  const maxCollateralLossLovelace = reader.whole('OPERATOR_MAX_COLLATERAL_LOSS_LOVELACE', 1n, MAX_LIMIT_LOVELACE, DEFAULT_MAX_COLLATERAL_LOSS_LOVELACE);
  reader.done();

  if (makeState) {
    try { files.makeFolder(stateDir ?? ''); } catch (err) { throw new SettingsError([`OPERATOR_STATE_DIR could not be made (${codeOf(err)})`]); }
  }
  return Object.freeze({
    network, useCase, keysDir: keysDir ?? '', stateDir: stateDir ?? '', agentsDir, goFile, mockEnvFile, contact: contact ?? null, module1Commit: module1Commit ?? null, urls, maxFeeLovelace, maxCollateralLossLovelace,
  });
}
