// scripts/operator/tasks/keys.ts - the task keys: it makes the keys of the use case on the host, writes the public key file, and prints the address of the run wallet.
// A key is made from the random source of the system, and its file is never replaced. A lost key is made again only when no manifest protects it.
// The task never prints, logs, returns or stores a seed: the screen, the errors, the state file, the evidence file and the machine line hold names, key hashes and addresses only.
// The folders have mode 700 and the files mode 600. A dry run writes nothing, not even a folder, and it reads no approval.
// The runner loads the run key for a submit approval. Before the key exists, only this task can use an approval that says `unset` for the run wallet.
// The public key files protect the identity of the run wallet, shared keys and keys from the earlier file during its move to a file of its own.
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyCredentialOf } from '../../checks/lib/addresses.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import { units } from '../../checks/lib/format.ts';
import type { TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { KeyStoreError, LEGACY_PUBLIC_MANIFEST, checkPublicManifest, codeOf, findPublicManifest, loadRegistry, makeMissingKeys, publicManifestFile, writePublicManifest } from '../lib/registry.ts';
import type { KeyStoreIo, PublicKeyEntry, Registry } from '../lib/registry.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';

const RUN = 'run';
const KNOWN_MANIFESTS = [LEGACY_PUBLIC_MANIFEST, ...USE_CASE_NAMES.map(publicManifestFile)];
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

// ---- the public key file that is there ----

/** What the public key file is before this run: not there, not readable as a public key file, or read (the scope and address of each key). */
type OldManifest = { kind: 'absent' } | { kind: 'damaged' } | { kind: 'found'; keys: ReadonlyMap<string, Pick<PublicKeyEntry, 'address' | 'scope'>> };

function readOldManifest(path: string): OldManifest {
  let found: unknown;
  try {
    const file = lstatSync(path, { throwIfNoEntry: false });
    if (file === undefined) return { kind: 'absent' };
    if (!file.isFile()) return { kind: 'damaged' };
    found = JSON.parse(readFileSync(path, 'utf8'));
  } catch { return { kind: 'damaged' }; }
  if (!isObject(found) || !isObject(found.keys)) return { kind: 'damaged' };
  const keys = new Map<string, Pick<PublicKeyEntry, 'address' | 'scope'>>();
  for (const [name, entry] of Object.entries(found.keys)) {
    if (!isObject(entry)) return { kind: 'damaged' };
    const { address, scope } = entry;
    if (scope !== 'shared' && scope !== 'use-case') return { kind: 'damaged' };
    if (typeof address !== 'string' || address.length > 200 || !address.startsWith('addr1') || keyCredentialOf(address) === null) return { kind: 'damaged' };
    keys.set(name, { address, scope });
  }
  return { kind: 'found', keys };
}

/**
 * Stops the run when the run key would get another wallet than the public key file shows: the key file is lost (a new key has another address), or it holds another key. Funds may be at the
 * address that the public key file shows, so the pack decides nothing: nothing is made, and the operator restores the file or removes the public key file. A public key file that cannot be read
 * does not say, so a lost run key stops the run then too. `kept` holds the keys whose files exist.
 */
function requireRunWalletStays(kept: Registry, old: OldManifest): void {
  if (old.kind === 'absent') return;
  const shown = old.kind === 'found' ? old.keys.get(RUN)?.address : undefined;
  if (!kept.has(RUN)) {
    if (old.kind === 'damaged') {
      throw new PreconditionError('the run key file is missing, and the public key file cannot be read, so it is not known whether the run wallet holds funds. Restore the run key file, or repair or remove the public key file when you know that no funds are there. Nothing was made');
    }
    if (shown !== undefined) {
      throw new PreconditionError(`the run key file is missing, and the public key file shows the run wallet ${shown}: funds may be there, and a new key has another address. Restore the run key file. Nothing was made`);
    }
    return;
  }
  if (shown !== undefined && shown !== kept.addressOf(RUN)) {
    throw new PreconditionError(`the run key file gives another wallet than the public key file shows (${shown}): funds may be there. Restore the run key file that matches the public key file, or remove the public key file when you know that no funds are there. Nothing was made`);
  }
}

/** Refuses to change a key that a manifest records. Only shared keys in another use case belong to this one. */
function requireRecordedKeysStay(use: UseCase, kept: Registry, prior: OldManifest, sharedOnly: boolean): void {
  if (prior.kind !== 'found') return;
  for (const { name, scope } of use.keys) {
    const recorded = prior.keys.get(name);
    if (recorded === undefined || (sharedOnly && (scope !== 'shared' || recorded.scope !== 'shared'))) continue;
    const present = kept.has(name);
    if (present && kept.addressOf(name) === recorded.address) continue;
    const label = scope === 'shared' ? `the shared key ${name}` : `the key ${name}`;
    const problem = present ? 'gives another wallet than a public key file records' : 'is missing, but a public key file records it';
    throw new PreconditionError(`${label} ${problem}. Restore the matching key file. Nothing was made`);
  }
}

/** Why the public key file changes, in words: what is new, and each address that is not the address that the old file showed. */
function changesOf(old: OldManifest, registry: Registry, network: string): string[] {
  if (old.kind === 'absent') return ['the public key file is new'];
  if (old.kind === 'damaged') return ['the public key file was damaged and is written again'];
  const now = registry.publicManifest(network).keys;
  const reasons: string[] = [];
  for (const name of registry.names()) {
    const before = old.keys.get(name)?.address;
    const address = now[name]!.address;
    if (before === undefined) reasons.push(`the key ${name} is new`);
    else if (before !== address) reasons.push(`the address of the key ${name} changed from ${before} to ${address}`);
  }
  for (const name of old.keys.keys()) if (!registry.has(name)) reasons.push(`the key ${name} is no longer in the use case`);
  return reasons;
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
    // The file that this run reads is the file of the use case, or the file of the earlier name when the use case has none yet. The file that it writes is the file of the use case.
    const found = findPublicManifest(settings.keysDir, use.name);
    const earlier = found !== path;
    // What this run would do, over a file system that writes nothing. A refusal here (a folder or a key file that is not as the pack makes it, a run wallet that would change) stops the run before any key is made.
    const plan = makeMissingKeys(settings.keysDir, use.name, use.keys, DRY_IO);
    const existing = loadRegistry({ dir: settings.keysDir, useCase: use.name, specs: use.keys, need: plan.kept });
    const old = readOldManifest(found);
    requireRunWalletStays(existing, old);
    requireRecordedKeysStay(use, existing, old, !earlier);
    // Another use case may be the only record of a shared key.
    const sharedRun = use.keys.some(({ name: key, scope }) => key === RUN && scope === 'shared');
    for (const file of KNOWN_MANIFESTS) {
      const other = join(settings.keysDir, file);
      if (other === found) continue;
      const prior = readOldManifest(other);
      if (sharedRun && prior.kind === 'damaged') requireRunWalletStays(existing, prior);
      requireRecordedKeysStay(use, existing, prior, true);
    }

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
    const kept = registry.names().filter((key) => !made.includes(key));
    out.out(made.length === 0 ? 'made no key' : `made ${made.length} ${plural(made.length)}: ${made.join(', ')}`);
    out.out(`kept ${kept.length} ${plural(kept.length)}: a key file is never replaced`);
    let unchanged = false;
    if (old.kind === 'found' && !earlier) {
      try { checkPublicManifest(path, registry); unchanged = true; } catch (err) {
        if (!(err instanceof KeyStoreError)) throw err;
      }
    }
    if (!unchanged) {
      const reasons = changesOf(old, registry, settings.network.name);
      if (earlier) out.out(`the public key file is written under the name ${name}: the file ${LEGACY_PUBLIC_MANIFEST} of the earlier name is kept`);
      if (old.kind !== 'found') out.out(reasons.join('; '));
      else if (reasons.length > 0 || !earlier) out.out(`the public key file changed: ${(reasons.length > 0 ? reasons : ['the text of the public key file did not equal what the key files give']).join('; ')}`);
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
