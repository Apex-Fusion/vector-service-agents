// scripts/operator/tasks/keys.ts - the task keys: it makes the keys of the use case on the host, writes the public key file, and prints the address of the run wallet.
// A key is made from the random source of the system, and its file is never replaced. A lost key is made again only when no manifest protects it.
// The task never prints, logs, returns or stores a seed: the screen, the errors, the state file, the evidence file and the machine line hold names, key hashes and addresses only.
// The folders have mode 700 and the files mode 600. A dry run writes nothing, not even a folder, and it reads no approval.
// The runner loads the run key for a submit approval. Before the key exists, only this task can use an approval that says `unset` for the run wallet.
// Validate each public key file against the declared keys of its use case. A damaged file must be restored before a run can make keys or write a public key file.
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { enterpriseAddressOf, keyHashOf } from '../../checks/lib/platform.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { units } from '../../checks/lib/format.ts';
import type { OperatorSettings, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { loadUseCase } from '../lib/load.ts';
import { KeyStoreError, LEGACY_PUBLIC_MANIFEST, checkPublicManifest, codeOf, findPublicManifest, loadRegistry, makeMissingKeys, publicManifestFile, writePublicManifest } from '../lib/registry.ts';
import type { KeyStoreIo, Registry } from '../lib/registry.ts';
import { repeatedMember } from '../lib/strict-json.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';

const RUN = 'run';
const KNOWN_MANIFESTS = USE_CASE_NAMES.map((useCase) => [publicManifestFile(useCase), useCase] as const);
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;
const NAME_WIDTH = 24;
const SCOPE_WIDTH = 9;
/** The length of a key hash: 28 bytes in hex. */
const HASH_WIDTH = 56;

interface KeysExtra {
  /** What a submit run made and kept, and the address of the run wallet. Null until the keys are made. */
  report: { made: string[]; kept: string[]; runWallet: string } | null;
  /** What a dry run would make and keep. Null until the dry run has looked. */
  would: { make: string[]; keep: string[] } | null;
}

/**
 * The file system of a run that looks and writes nothing. `makeMissingKeys` over it names the keys that it would make and the keys that it would keep, and it refuses what the real call refuses (a
 * folder with the wrong mode, a link, a bad name), because it is the same code. Every member of the interface is given here, so a member that the interface gets later is a type error and never a
 * real write in a dry run. The random source gives zeros, and nothing writes them.
 */
const DRY_IO: KeyStoreIo = {
  stat: (path) => {
    const found = lstatSync(path, { throwIfNoEntry: false });
    return found === undefined ? null : { isFile: found.isFile(), isFolder: found.isDirectory(), isSymlink: found.isSymbolicLink(), mode: found.mode & 0o777 };
  },
  read: () => { throw new Error('a look at the keys reads no key file'); },
  makeFolder: () => undefined,
  writeNew: () => undefined,
  link: () => undefined,
  remove: () => undefined,
  flushFolder: () => undefined,
  randomSeed: () => Buffer.alloc(32),
};

const plural = (count: number): string => (count === 1 ? 'key' : 'keys');
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const folderOf = (use: UseCase, name: string): string => (use.keys.find((spec) => spec.name === name)?.scope === 'shared' ? 'shared' : use.name);

// ---- public key files ----

type Addresses = ReadonlyMap<string, string>;

const badManifest = (file: string, problem: string): PreconditionError =>
  new PreconditionError(`the public key file ${file} ${problem}. Restore the original public key file. Nothing was made`);

function keyFolderFiles(dir: string): Set<string> {
  try { return new Set(readdirSync(dir)); } catch (err) {
    if (codeOf(err) === 'ENOENT') return new Set();
    throw new PreconditionError(`the key folder cannot be read (${codeOf(err)}). Nothing was made`);
  }
}

function readManifest(dir: string, file: string): Record<string, unknown> {
  const path = join(dir, file);
  let found: unknown;
  let text: string;
  try {
    if (!lstatSync(path).isFile()) throw new Error();
    text = readFileSync(path, 'utf8');
    found = JSON.parse(text);
  } catch {
    throw badManifest(file, 'cannot be read');
  }
  if (!isObject(found) || repeatedMember(text) !== null) throw badManifest(file, 'is not a JSON object with unique members');
  return found;
}

/** A file proves absence only when it contains every key that its use case declares. */
function addressesOf(file: string, manifest: Record<string, unknown>, use: UseCase, network: string): Addresses {
  const { keys } = manifest;
  if (manifest.network !== network || typeof manifest.note !== 'string') throw badManifest(file, 'has an invalid network or note');
  if (!isObject(keys) || Object.keys(keys).length !== use.keys.length) throw badManifest(file, 'does not list exactly the declared keys');
  const addresses = new Map<string, string>();
  const seen = new Set<string>();
  for (const { name, scope } of use.keys) {
    const entry = Object.hasOwn(keys, name) ? keys[name] : undefined;
    if (!isObject(entry) || entry.scope !== scope || typeof entry.about !== 'string') throw badManifest(file, `has no valid entry for ${name}`);
    const { public_key_hex: pub, key_hash: hash, address } = entry;
    if (typeof pub !== 'string' || !PUBLIC_KEY_HEX.test(pub) || typeof hash !== 'string' || keyHashOf(pub) !== hash ||
        typeof address !== 'string' || enterpriseAddressOf(hash) !== address || seen.has(address)) {
      throw badManifest(file, `has an invalid or duplicate identity for ${name}`);
    }
    seen.add(address);
    addresses.set(name, address);
  }
  return addresses;
}

interface PriorManifests {
  readonly ownsFile: boolean;
  readonly ownsFolder: boolean;
  readonly ownKeys: Addresses | undefined;
  readonly shared: Addresses;
}

async function priorManifests(settings: OperatorSettings, use: UseCase, ownFile: string): Promise<PriorManifests> {
  const files = keyFolderFiles(settings.keysDir);
  const names = new Map<string, string>(KNOWN_MANIFESTS);
  names.set(ownFile, use.name);
  const definitions = new Map([[use.name, use]]);
  const recorded = new Map<string, Addresses>();
  const shared = new Map<string, string>();
  const sharedNames = new Map<string, string>();
  for (const file of files) {
    const legacy = file === LEGACY_PUBLIC_MANIFEST;
    if (!legacy && (!file.startsWith('keys-public.') || !file.endsWith('.json'))) continue;
    const expected = names.get(file);
    if (!legacy && expected === undefined) throw new PreconditionError('the key folder has a public key file for an unrecognized use case. Nothing was made');
    const manifest = readManifest(settings.keysDir, file);
    const name = manifest.use_case;
    if (typeof name !== 'string' || (legacy ? name !== use.name && !USE_CASE_NAMES.some((known) => known === name) : name !== expected)) {
      throw badManifest(file, 'does not name its recognized use case');
    }
    let owner = definitions.get(name);
    if (owner === undefined) {
      owner = await loadUseCase(name);
      definitions.set(name, owner);
    }
    const addresses = addressesOf(file, manifest, owner, settings.network.name);
    const before = recorded.get(name);
    for (const { name: key, scope } of owner.keys) {
      const address = addresses.get(key)!;
      if (before !== undefined && before.get(key) !== address) throw badManifest(file, `disagrees with another public key file for ${key}`);
      if (scope !== 'shared') continue;
      const knownAddress = shared.get(key);
      const knownName = sharedNames.get(address);
      if ((knownAddress !== undefined && knownAddress !== address) || (knownName !== undefined && knownName !== key)) {
        throw badManifest(file, `disagrees with another public key file for the shared key ${key}`);
      }
      shared.set(key, address);
      sharedNames.set(address, key);
    }
    recorded.set(name, addresses);
  }
  for (const name of USE_CASE_NAMES) {
    if (name !== use.name && files.has(name) && !recorded.has(name)) throw badManifest(publicManifestFile(name), 'is missing for an existing use case');
  }
  return { ownsFile: files.has(ownFile), ownsFolder: files.has(use.name), ownKeys: recorded.get(use.name), shared };
}

function requireRecordedKeysStay(use: UseCase, kept: Registry, prior: PriorManifests): void {
  for (const { name, scope } of use.keys) {
    const address = scope === 'shared' ? prior.shared.get(name) : prior.ownKeys?.get(name);
    const present = kept.has(name);
    if (address === undefined) {
      if (!present && scope === 'shared' && prior.ownsFolder && prior.ownKeys === undefined) {
        throw badManifest(publicManifestFile(use.name), 'is missing for the existing key folder of this use case');
      }
      continue;
    }
    if (present && kept.addressOf(name) === address) continue;
    if (name === RUN && prior.ownKeys !== undefined) {
      const problem = present ? `the run key file gives another wallet than the public key file shows (${address})`
        : `the run key file is missing, and the public key file shows the run wallet ${address}`;
      throw new PreconditionError(`${problem}: funds may be there. Restore the run key file that matches the public key file. Nothing was made`);
    }
    const label = scope === 'shared' ? `the shared key ${name}` : `the key ${name}`;
    const problem = present ? 'gives another wallet than a public key file records' : 'is missing, but a public key file records it';
    throw new PreconditionError(`${label} ${problem}. Restore the matching key file. Nothing was made`);
  }
}

// ---- what the task prints ----

/** The table of the keys that a registry holds: the name, the scope, the key hash and the wallet address. A name that no registry holds is shown as missing. */
function tableLines(registry: Registry, use: UseCase, network: string): string[] {
  const known = registry.publicManifest(network).keys;
  const lines = [`${'name'.padEnd(NAME_WIDTH)} ${'scope'.padEnd(SCOPE_WIDTH)} ${'key hash'.padEnd(HASH_WIDTH)} address`];
  for (const spec of use.keys) {
    const key = known[spec.name];
    lines.push(`${spec.name.padEnd(NAME_WIDTH)} ${spec.scope.padEnd(SCOPE_WIDTH)} ${key === undefined ? 'missing' : `${key.key_hash} ${key.address}`}`);
  }
  return lines;
}

const namedLines = (use: UseCase, names: readonly string[]): string[] => names.map((name) => `  ${name}: folder ${folderOf(use, name)}`);

async function walletLines(session: TaskSession<KeysExtra>, registry: Registry): Promise<string[]> {
  const lines: string[] = [];
  for (const name of registry.names()) {
    const found = await session.chain.provider.getUtxos(registry.addressOf(name));
    const total = found.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
    const pure = found.filter((utxo) => Object.keys(utxo.assets).every((unit) => unit === 'lovelace')).map((utxo) => units(utxo.assets.lovelace ?? 0n));
    lines.push(`wallet ${name}: ${units(total)} in ${found.length} output(s)${pure.length === 0 ? '' : `; pure outputs ${pure.join(', ')}`}`);
  }
  return lines;
}

const task: TaskDefinition<KeysExtra> = {
  name: 'keys',
  title: 'Make the keys of the use case, and show the address of the run wallet',
  flags: [],
  valued: [],
  needs: { keys: () => [], chain: true, hosted: [], approval: 'submit' },
  steps: () => [],
  parse: (_env, _settings, use) => {
    if (!use.keys.some((spec) => spec.name === RUN)) throw new PreconditionError('the use case lists no key named run: the run wallet funds the other wallets, so it must be in the list of keys');
    return { report: null, would: null };
  },

  async next(session) {
    const { settings, use, out } = session;
    const name = publicManifestFile(use.name);
    const path = join(settings.keysDir, name);
    // Plan before checking public files. The plan writes nothing.
    const plan = makeMissingKeys(settings.keysDir, use.name, use.keys, DRY_IO);
    const prior = await priorManifests(settings, use, name);
    const existing = loadRegistry({ dir: settings.keysDir, useCase: use.name, specs: use.keys, need: plan.kept });
    requireRecordedKeysStay(use, existing, prior);

    if (session.mode === 'dry') {
      out.out(`the key folder is ${settings.keysDir}`);
      out.out(`would make ${plan.made.length} ${plural(plan.made.length)}:`);
      for (const line of namedLines(use, plan.made)) out.out(line);
      out.out(`would keep ${plan.kept.length} ${plural(plan.kept.length)}:`);
      for (const line of namedLines(use, plan.kept)) out.out(line);
      session.extra.would = { make: plan.made, keep: plan.kept };
      return { kind: 'dry' };
    }

    // Never make a key that the plan kept, even if its file disappears after the check.
    const { made } = makeMissingKeys(settings.keysDir, use.name, use.keys.filter(({ name: key }) => !existing.has(key)));
    const registry = loadRegistry({ dir: settings.keysDir, useCase: use.name, specs: use.keys });
    for (const key of plan.kept) {
      if (existing.addressOf(key) !== registry.addressOf(key)) throw new PreconditionError(`the key ${key} changed during the check. Restore the original key file. The pack did not write a public key file`);
    }
    const kept = registry.names().filter((key) => !made.includes(key));
    out.out(made.length === 0 ? 'made no key' : `made ${made.length} ${plural(made.length)}: ${made.join(', ')}`);
    out.out(`kept ${kept.length} ${plural(kept.length)}: a key file is never replaced`);
    let unchanged = false;
    if (prior.ownsFile) {
      try { checkPublicManifest(path, registry); unchanged = true; } catch (err) {
        if (!(err instanceof KeyStoreError)) throw err;
      }
    }
    if (!unchanged) {
      if (prior.ownsFile) out.out('the public key file changed: the text of the public key file did not equal what the key files give');
      else if (prior.ownKeys !== undefined) out.out(`the public key file is written under the name ${name}: the file ${LEGACY_PUBLIC_MANIFEST} of the earlier name is kept`);
      else out.out('the public key file is new');
      writePublicManifest(path, registry, { network: settings.network.name, useCase: use.name });
    }
    const runWallet = registry.addressOf(RUN);
    session.extra.report = { made, kept, runWallet };
    if (made.length === 0 && unchanged) out.out('every key exists: nothing was made, and the public key file is unchanged');
    for (const line of tableLines(registry, use, settings.network.name)) out.out(line);
    const message = `the run wallet address is ${runWallet}: send the funds to it`;
    return made.length === 0 && unchanged ? { kind: 'finished', message } : { kind: 'done', message };
  },

  async cleanup() {
    return { kind: 'done', message: 'nothing can be taken back: the pack never deletes a key file' };
  },

  async status(session) {
    const { settings, use } = session;
    const name = publicManifestFile(use.name);
    const path = findPublicManifest(settings.keysDir, use.name);
    const plan = makeMissingKeys(settings.keysDir, use.name, use.keys, DRY_IO);
    const registry = loadRegistry({ dir: settings.keysDir, useCase: use.name, specs: use.keys, need: plan.kept });
    const lines = [plan.made.length === 0 ? `all ${use.keys.length} key files exist` : `${plan.made.length} of ${use.keys.length} key files are missing: ${plan.made.join(', ')}`];
    lines.push(...tableLines(registry, use, settings.network.name), ...(await walletLines(session, registry)));
    if (plan.made.length > 0) {
      lines.push('the public key file is not checked: a key file is missing');
      return lines;
    }
    try {
      checkPublicManifest(path, registry);
      lines.push(path === join(settings.keysDir, name)
        ? 'the public key file equals the key files'
        : `the public key file equals the key files (it is the file ${LEGACY_PUBLIC_MANIFEST} of the earlier name: a run with --submit writes ${name})`);
    } catch (err) {
      if (!(err instanceof KeyStoreError)) throw err;
      lines.push(err.message);
    }
    return lines;
  },

  result: (session) => {
    const { report, would } = session.extra;
    if (report !== null) return { made: report.made, kept: report.kept, run_wallet: report.runWallet };
    if (would !== null) return { would_make: would.make, would_keep: would.keep };
    return {};
  },
};

export default task;
