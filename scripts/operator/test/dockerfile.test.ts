// scripts/operator/test/dockerfile.test.ts
// CI builds the image of the operator pack from the repository root, and a test machine can have no Docker daemon, so the Dockerfile and the ignore file are held here to what they have to say.
// The image holds the pack, the checks that the pack reuses and the workspace packages that both import. It holds no key, no env file, no test file, no shell script, no docker client and no git.
// It runs as node, with no volume, no port and no build argument, and it starts the command line of the pack. The caller mounts the keys folder, the state folder and the agents folder.
// A function reads a Dockerfile and lists what is wrong with it. The real file has no fault. Each broken copy has the fault that its name says, and each twin of a copy keeps its meaning and has none.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(posix.join(root, path), 'utf8');
const DOCKERFILE = 'scripts/operator/Dockerfile';
const BASE = 'FROM node:22-bookworm-slim';
const FINAL_COPY = 'COPY --from=builder --chown=node:node /repo /repo';
const TINI = 'RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*';
const INSTALL = "RUN pnpm install --frozen-lockfile --filter '@vsa/usecase-kit...'";
const ENTRYPOINT = 'ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx", "scripts/operator/cli.ts"]';
const ROOT_FILES = ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package.json', 'tsconfig.base.json'];
const BID_PRICE_LISTS = ['alfa', 'bravo', 'charlie'].map((name) => `agents/bid-desk/price-lists/${name}.json`);
/** The names that can carry a secret. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|SEED|CREDENTIAL|AUTH/i;
/** What no copy may bring into the image: a test folder or file, an env file, an npm settings file, a shell script and a key file. */
const NEVER_IN_IMAGE = /(^|\/)tests?(\/|$)|\.test\.|(^|\/)\.(env|npmrc)(\.|$)|\.sh$|\.(seed|key|pem)$/;

interface Manifest { name: string; packageManager?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
const manifest = (dir: string): Manifest => JSON.parse(read(dir === '' ? 'package.json' : `${dir}/package.json`)) as Manifest;

/** Every workspace package that `dir` depends on, and those depend on, as directories. */
function workspaceClosure(dir: string): string[] {
  const byName = new Map<string, string>();
  for (const parent of ['packages', 'agents', 'services']) for (const name of readdirSync(posix.join(root, parent))) if (existsSync(posix.join(root, parent, name, 'package.json'))) byName.set(manifest(`${parent}/${name}`).name, `${parent}/${name}`);
  const seen = new Set<string>();
  const visit = (at: string): void => {
    if (seen.has(at)) return;
    seen.add(at);
    for (const [name, range] of Object.entries(manifest(at).dependencies ?? {})) if (range.startsWith('workspace:')) visit(byName.get(name) ?? (() => { throw new Error(`no workspace package ${name}`); })());
  };
  visit(dir);
  return [...seen].sort();
}
const CLOSURE = ['packages/buyer-core', 'packages/hire-kit', 'packages/id-kit', 'packages/service-kit', 'packages/usecase-kit', 'packages/vector-read'];

/** The files below a folder of the repository, without node_modules. With `skipTests`, without test folders too. */
function filesBelow(dir: string, skipTests = false): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(posix.join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.name === 'node_modules' || (skipTests && entry.name === 'test')) continue;
    if (entry.isDirectory()) found.push(...filesBelow(path, skipTests));
    else found.push(path);
  }
  return found.sort();
}
const PACK_SOURCES = [...filesBelow('scripts/operator', true), ...filesBelow('scripts/checks/lib', true)].filter((file) => file.endsWith('.ts'));

/** The texts that the import lines of a source file name: static imports and exports with `from`, imports with no names, and dynamic imports of a text. */
const IMPORT_PATTERNS = [/^(?:import|export)\s[^;]*?\bfrom\s*(['"])([^'"\n]+)\1/gm, /^import\s*(['"])([^'"\n]+)\1/gm, /\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g];
const importsOf = (file: string): string[] => IMPORT_PATTERNS.flatMap((pattern) => [...read(file).matchAll(pattern)].map((found) => found[2]));
/** The file that a relative import names, or null when no file is there. */
function resolveImport(file: string, spec: string): string | null {
  const base = posix.join(posix.dirname(file), spec);
  return [base, base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find((path) => existsSync(posix.join(root, path)) && statSync(posix.join(root, path)).isFile()) ?? null;
}
const packageOf = (spec: string): string => spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/');

/** The names that an ENV or ARG line declares. */
function declaredNames(line: string): string[] {
  const rest = /^(?:ENV|ARG)\s+(.*)$/.exec(line)?.[1];
  if (rest === undefined) return [];
  return rest.includes('=') ? [...rest.matchAll(/(?:^|\s)([^\s=]+)=/g)].map((found) => found[1]) : [rest.split(/\s+/)[0]];
}

/** The paths that the COPY lines of a Dockerfile take from the build context. */
const sourcesOf = (copy: string): string[] => copy.replace(/^COPY (--chown=\S+ )?/, '').split(/\s+/).slice(0, -1).map((path) => path.replace(/^\.\//, ''));

/** What is wrong with a Dockerfile, as a list of lines. An empty list is a pass. */
function problemsOf(text: string): string[] {
  const problems: string[] = [];
  const instructions = text.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'));
  const stages = instructions.reduce<string[][]>((all, line) => { if (/^FROM /.test(line)) all.push([line]); else all.at(-1)?.push(line); return all; }, []);
  if (instructions.some((line) => line.endsWith('\\'))) problems.push('a line continues on the next line: write one instruction on each line');
  if (stages.length !== 2 || stages[0][0] !== `${BASE} AS builder` || stages[1][0] !== BASE) return [...problems, `the stages are the builder and the final image, both on ${BASE.slice(5)}`];
  const [builder, final] = stages;
  const copies = instructions.map((line, at) => ({ line, at })).filter(({ line }) => /^COPY /.test(line) && !/--from=/.test(line));
  const sources = copies.flatMap(({ line }) => sourcesOf(line));
  // Copy only the pack, the checks, their dependencies and the published price lists that the offline trial reads.
  for (const source of sources) if (!existsSync(posix.join(root, source))) problems.push(`${source} is copied and is not in the repository`);
  for (const source of sources) if (NEVER_IN_IMAGE.test(source)) problems.push(`a copy takes ${source}: no test, env file, key file or shell script goes into the image`);
  const expected = [...ROOT_FILES, ...CLOSURE.flatMap((dir) => [`${dir}/package.json`, dir]), ...BID_PRICE_LISTS, 'scripts/checks/lib', 'scripts/checks/tsconfig.json', 'scripts/operator'].sort();
  if (JSON.stringify([...sources].sort()) !== JSON.stringify(expected)) problems.push(`the copies take: ${[...sources].sort().join(' ')}; they must take: ${expected.join(' ')}`);
  if (JSON.stringify(final.filter((line) => /^(COPY|ADD) /.test(line))) !== JSON.stringify([FINAL_COPY])) problems.push(`the final stage copies only the workspace of the builder: ${FINAL_COPY}`);
  if (instructions.some((line) => /^ADD /.test(line))) problems.push('no ADD: it can fetch a file');
  for (const line of instructions) if (/--(?:from|mount)\b/.test(line) && line !== FINAL_COPY) problems.push(`${line.split(' ').slice(0, 2).join(' ')} takes files from another stage or image: only ${FINAL_COPY} may`);
  // The install: from the lockfile, for the closure of the use-case kit, with the manifests before it and the sources after it.
  if (JSON.stringify(instructions.filter((line) => /^RUN pnpm /.test(line))) !== JSON.stringify([INSTALL])) problems.push(`the one pnpm command is: ${INSTALL}`);
  const install = instructions.indexOf(INSTALL);
  if (!builder.includes(`RUN corepack enable && corepack prepare ${manifest('').packageManager} --activate`)) problems.push('the builder prepares the pnpm version of the root package.json');
  for (const dir of CLOSURE) {
    const manifestAt = copies.find(({ line }) => sourcesOf(line).includes(`${dir}/package.json`))?.at ?? -1;
    const sourcesAt = copies.find(({ line }) => sourcesOf(line).includes(dir))?.at ?? -1;
    if (!(manifestAt >= 0 && manifestAt < install)) problems.push(`${dir}/package.json is copied before the install`);
    if (!(sourcesAt > install && install >= 0)) problems.push(`${dir} is copied after the install`);
  }
  for (const file of ROOT_FILES) if (!copies.some(({ line, at }) => sourcesOf(line).includes(file) && at < install)) problems.push(`${file} is copied before the install`);
  // The system: tini is the one package, and no other tool comes in.
  if (JSON.stringify(instructions.filter((line) => /\b(?:apt-get|apk|pip3?|npm|yarn|curl|wget|git)\b/.test(line))) !== JSON.stringify([TINI])) problems.push(`the only line that adds a package installs tini: ${TINI}`);
  if (final[1] !== TINI) problems.push('tini is the first instruction of the final stage after FROM');
  // The run: as node, with the workspace in /repo, and with nothing that a caller does not mount or ask for.
  if (JSON.stringify(final.filter((line) => /^USER /.test(line))) !== JSON.stringify(['USER node']) || final.indexOf('USER node') < final.indexOf(FINAL_COPY)) problems.push('the final stage runs as USER node, after the copy of the workspace');
  if (!(builder.includes('WORKDIR /repo') && final.indexOf('WORKDIR /repo') >= 0 && final.indexOf('WORKDIR /repo') < final.indexOf(FINAL_COPY))) problems.push('both stages work in /repo, the final one before the copy');
  for (const word of ['VOLUME', 'EXPOSE', 'HEALTHCHECK', 'CMD', 'ARG']) if (instructions.some((line) => line.startsWith(`${word} `))) problems.push(`no ${word}: the image has no volume, no port, no health check, no default argument and no build argument`);
  if (JSON.stringify(instructions.filter((line) => /^ENV /.test(line))) !== JSON.stringify(['ENV NODE_ENV=production'])) problems.push('the one ENV is ENV NODE_ENV=production');
  for (const line of instructions) for (const name of declaredNames(line)) if (SECRET_NAME.test(name)) problems.push(`${line.split(' ')[0]} ${name}: a name that can carry a secret`);
  if (instructions.at(-1) !== ENTRYPOINT || instructions.filter((line) => /^ENTRYPOINT /.test(line)).length !== 1) problems.push(`the last instruction is the one ENTRYPOINT: ${ENTRYPOINT}`);
  if (!existsSync(posix.join(root, 'scripts/operator/cli.ts'))) problems.push('the entry point scripts/operator/cli.ts is in the repository');
  // The imports of the pack: each relative import names a file that the image holds, each package that it reaches is in the closure, and each other import is a package of the root.
  const held = (path: string): boolean => sources.some((source) => path === source || path.startsWith(`${source}/`)) && !/(^|\/)test(\/|$)/.test(path);
  const rootPackages = { ...manifest('').devDependencies, ...manifest('').dependencies };
  for (const file of PACK_SOURCES) {
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) {
        const target = resolveImport(file, spec);
        if (target === null) problems.push(`${file} imports ${spec} and no file is there`);
        else if (!held(target)) problems.push(`${file} imports ${target} and the image does not hold it`);
        else if (target.startsWith('packages/') && !CLOSURE.includes(target.split('/').slice(0, 2).join('/'))) problems.push(`${file} imports ${target}, a package outside the closure of the use-case kit`);
      } else if (!(spec.startsWith('node:') || builtinModules.includes(spec)) && !(packageOf(spec) in rootPackages)) {
        problems.push(`${file} imports ${spec}, and the root package.json does not list ${packageOf(spec)}`);
      }
    }
  }
  if (!('tsx' in rootPackages)) problems.push('the entry point loads tsx, and the root package.json does not list it');
  return problems;
}

/** The copy of a text with its first `from` changed to `to`. A change that changes nothing proves nothing, so a text that lacks `from` stops the test. */
function swap(text: string, from: string, to: string): string {
  expect(text.includes(from), `the text holds: ${from}`).toBe(true);
  return text.replace(from, () => to);
}

describe('scripts/operator/Dockerfile', () => {
  const real = read(DOCKERFILE);

  it('has no fault, and installs the closure that the pack reaches', () => {
    expect(problemsOf(real)).toEqual([]);
    expect(workspaceClosure('packages/usecase-kit')).toEqual(CLOSURE);
    expect(manifest('packages/usecase-kit').name).toBe('@vsa/usecase-kit');
    // The packages that the pack imports by a relative path: the closure holds each of them, and the others come with their own imports.
    const reached = new Set(PACK_SOURCES.flatMap((file) => importsOf(file).filter((spec) => spec.startsWith('.')).map((spec) => resolveImport(file, spec) ?? '').filter((path) => path.startsWith('packages/')).map((path) => path.split('/').slice(0, 2).join('/'))));
    expect([...reached].sort().filter((dir) => !CLOSURE.includes(dir))).toEqual([]);
    expect([...reached].sort()).toEqual(expect.arrayContaining(['packages/buyer-core', 'packages/id-kit', 'packages/usecase-kit', 'packages/vector-read']));
  });

  it('holds the entry that the caller starts: tsx loads the pack from /repo, and the root install gives it tsx and the MCP client', () => {
    expect(real).toContain(ENTRYPOINT);
    const rootManifest = manifest('');
    expect(rootManifest.devDependencies?.tsx).toBeDefined();
    expect(rootManifest.devDependencies?.['@modelcontextprotocol/sdk']).toBeDefined();
    expect(rootManifest.packageManager).toBe('pnpm@10.33.2');
  });

  const broken: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['no USER node', swap(real, 'USER node\n', ''), /runs as USER node/],
    ['a second package next to tini', swap(real, ' tini && ', ' tini curl && '), /the only line that adds a package/],
    ['a package manager of the system in the builder', swap(real, 'WORKDIR /repo\n', 'WORKDIR /repo\nRUN apt-get update && apt-get install -y git\n'), /the only line that adds a package/],
    ['a copy of the test folder of the pack', swap(real, 'COPY scripts/operator ./scripts/operator\n', 'COPY scripts/operator ./scripts/operator\nCOPY scripts/operator/test ./scripts/operator/test\n'), /a copy takes scripts\/operator\/test/],
    ['a copy of the test folder of a package', swap(real, 'COPY packages/id-kit ./packages/id-kit\n', 'COPY packages/id-kit ./packages/id-kit\nCOPY packages/id-kit/test ./packages/id-kit/test\n'), /a copy takes packages\/id-kit\/test/],
    ['a copy of a key file', swap(real, 'COPY scripts/operator ./scripts/operator\n', 'COPY scripts/operator ./scripts/operator\nCOPY run.seed ./run.seed\n'), /a copy takes run\.seed/],
    ['a copy of the whole scripts folder', swap(real, 'COPY scripts/operator ./scripts/operator\n', 'COPY scripts ./scripts\n'), /the copies take/],
    ['a copy of the whole checks folder, with its check scripts', swap(real, 'COPY scripts/checks/lib ./scripts/checks/lib\n', 'COPY scripts/checks ./scripts/checks\n'), /the copies take/],
    ['a copy that fetches a file', swap(real, 'USER node', 'ADD https://example.org/tool /usr/bin/tool\nUSER node'), /no ADD/],
    ['a docker client copied from another image', swap(real, 'USER node', 'COPY --from=docker:cli /usr/local/bin/docker /usr/bin/docker\nUSER node'), /the final stage copies only the workspace/],
    ['a copy from the build context in the final stage', swap(real, 'USER node', 'COPY scripts/operator/cli.ts ./cli.ts\nUSER node'), /the final stage copies only the workspace/],
    ['an ENV with a key name', swap(real, 'ENV NODE_ENV=production', 'ENV NODE_ENV=production OPERATOR_API_KEY=x'), /ENV OPERATOR_API_KEY: a name that can carry a secret/],
    ['a second ENV with a harmless name', swap(real, 'ENV NODE_ENV=production', 'ENV NODE_ENV=production\nENV PORT=80'), /the one ENV is/],
    ['a build argument with a token name', swap(real, 'AS builder\n', 'AS builder\nARG REGISTRY_TOKEN\n'), /ARG REGISTRY_TOKEN: a name that can carry a secret/],
    ['a build argument with a harmless name', swap(real, 'AS builder\n', 'AS builder\nARG MODE=a\n'), /no ARG/],
    ['a volume', swap(real, 'USER node', 'VOLUME /state\nUSER node'), /no VOLUME/],
    ['a port', swap(real, 'USER node', 'EXPOSE 8080\nUSER node'), /no EXPOSE/],
    ['a health check', swap(real, 'USER node', 'HEALTHCHECK CMD true\nUSER node'), /no HEALTHCHECK/],
    ['a default argument after the entry point', `${real}CMD ["keys", "status"]\n`, /no CMD/],
    ['plain node as the entry point', swap(real, '"--", "node", "--import", "tsx", ', '"--", "node", '), /the last instruction is the one ENTRYPOINT/],
    ['the entry point of a check script', swap(real, 'scripts/operator/cli.ts"]', 'scripts/checks/01-delegation.ts"]'), /the last instruction is the one ENTRYPOINT/],
    ['a package left out of the copies', swap(real, 'COPY packages/id-kit ./packages/id-kit\n', ''), /packages\/id-kit is copied after the install|the copies take/],
    ['the manifest of a package left out of the copies', swap(real, 'COPY packages/hire-kit/package.json ./packages/hire-kit/package.json\n', ''), /packages\/hire-kit\/package\.json is copied before the install/],
    ['the checks left out of the copies', swap(real, 'COPY scripts/checks/lib ./scripts/checks/lib\n', ''), /scripts\/checks\/lib\/\S+ and the image does not hold it/],
    ['the pack left out of the copies', swap(real, 'COPY scripts/operator ./scripts/operator\n', ''), /scripts\/operator\/\S+ and the image does not hold it|the copies take/],
    ['the install of another selection', swap(real, "'@vsa/usecase-kit...'", "'@vsa/hire-kit...'"), /the one pnpm command is/],
    ['an install without the lockfile', swap(real, ' --frozen-lockfile', ''), /the one pnpm command is/],
    ['the install after the sources', swap(swap(real, `${INSTALL}\n`, ''), 'COPY scripts/operator ./scripts/operator\n', `COPY scripts/operator ./scripts/operator\n${INSTALL}\n`), /is copied after the install/],
    ['another pnpm version', swap(real, 'pnpm@10.33.2', 'pnpm@9.0.0'), /prepares the pnpm version/],
    ['another base image in the final stage', swap(real, `\n${BASE}\n`, `\n${BASE.replace('22', '20')}\n`), /the stages are the builder and the final image/],
    ['an instruction on two lines', swap(real, ' tini && ', ' tini \\\n  && '), /a line continues/],
    ['a copy of a path that is not in the repository', swap(real, 'COPY scripts/operator ./scripts/operator\n', 'COPY scripts/operator ./scripts/operator\nCOPY scripts/missing ./scripts/missing\n'), /scripts\/missing is copied and is not in the repository/],
    ['a docker client copied in the builder stage', swap(real, 'COPY scripts/operator ./scripts/operator\n', 'COPY scripts/operator ./scripts/operator\nCOPY --from=docker:27-cli /usr/local/bin/docker /repo/node_modules/.bin/docker\n'), /COPY --from=docker:27-cli takes files from another stage or image/],
    ['a mount of another image in the builder stage', swap(real, 'WORKDIR /repo\n', 'WORKDIR /repo\nRUN --mount=type=bind,from=docker:27-cli,source=/usr/local/bin/docker,target=/mnt/docker cp /mnt/docker /repo/docker\n'), /RUN --mount=\S+ takes files from another stage or image/],
    ['a cache mount on the install', swap(real, 'RUN pnpm install', 'RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install'), /RUN --mount=\S+ takes files from another stage or image/],
  ];
  for (const [name, text, expected] of broken) {
    it(`refuses a copy with ${name}`, () => {
      const problems = problemsOf(text);
      expect(problems.some((problem) => expected.test(problem)), JSON.stringify(problems)).toBe(true);
    });
  }

  it('accepts a copy with a note, a blank line, the manifests in another order, a label, and the user set twice', () => {
    expect(problemsOf(`# a note\n\n${real}`)).toEqual([]);
    expect(problemsOf(swap(real, 'WORKDIR /repo\nRUN corepack', 'WORKDIR /repo\n\n# a note\nRUN corepack'))).toEqual([]);
    expect(problemsOf(swap(real, 'COPY packages/id-kit/package.json ./packages/id-kit/package.json\nCOPY packages/hire-kit/package.json ./packages/hire-kit/package.json\n', 'COPY packages/hire-kit/package.json ./packages/hire-kit/package.json\nCOPY packages/id-kit/package.json ./packages/id-kit/package.json\n'))).toEqual([]);
    expect(problemsOf(swap(real, 'USER node', 'LABEL org.opencontainers.image.title="operator"\nUSER node'))).toEqual([]);
  });
});

/** One line of an ignore file as a rule, in the way that the Docker builders read it: a line with a leading ! puts files back; `**` crosses folders, `*` and `?` stop at a slash. */
interface Rule { exclusion: boolean; pattern: RegExp }
function rulesOf(text: string): Rule[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#')).map((line) => {
    const exclusion = line.startsWith('!');
    const glob = (exclusion ? line.slice(1) : line).replace(/^\/+/, '').replace(/\/+$/, '');
    let source = '';
    for (let at = 0; at < glob.length; at += 1) {
      const char = glob[at];
      if (char === '*' && glob[at + 1] === '*') {
        at += 1;
        if (glob[at + 1] === '/') at += 1;
        source += at + 1 >= glob.length ? '.*' : '(.*/)?';
      } else if (char === '*') source += '[^/]*';
      else if (char === '?') source += '[^/]';
      else source += char.replace(/[\\^$.|+(){}[\]]/g, '\\$&');
    }
    return { exclusion, pattern: new RegExp(`^${source}$`) };
  });
}
/** Whether a file reaches the build context. The last rule that matches the path, or one of its folders, decides. */
function inContext(rules: readonly Rule[], path: string): boolean {
  const parts = path.split('/');
  const folders = parts.slice(0, -1).map((_, at) => parts.slice(0, at + 1).join('/'));
  let ignored = false;
  for (const rule of rules) {
    if (rule.exclusion !== ignored) continue;
    if (rule.pattern.test(path) || folders.some((folder) => rule.pattern.test(folder))) ignored = !rule.exclusion;
  }
  return !ignored;
}

/** Whether the image needs a file (true), must never get it (false), or has no rule for it (null). */
function wanted(path: string): boolean | null {
  const parts = path.split('/');
  const name = parts.at(-1) ?? '';
  if (parts.includes('node_modules') || parts.includes('test') || /^\.(env|npmrc)(\.|$)/.test(name) || name.endsWith('.seed')) return false;
  if (path.startsWith('packages/') || path.startsWith('scripts/operator/') || path.startsWith('scripts/checks/lib/') || path === 'scripts/checks/tsconfig.json') return true;
  return path.startsWith('scripts/checks/') ? null : !path.startsWith('scripts/');
}
/** The real files of the folders that the Dockerfile reads, and paths that a host can hold: an env file, a key file, an npm settings file and a node_modules folder in each place that a re-include opens. */
const TREE = [...filesBelow('scripts'), ...filesBelow('packages')];
const PROBES = [
  'scripts/operator/.env', 'scripts/operator/.env.local', 'scripts/operator/lib/.env', 'scripts/checks/lib/.env', 'scripts/checks/.env.keys', 'scripts/operator/node_modules/x/index.js',
  'scripts/checks/lib/node_modules/x/index.js', 'packages/buyer-core/.env', 'packages/buyer-core/node_modules/x/index.js', 'scripts/run-e2e-from-keyfile.sh', 'scripts/operator/lib/test/x.ts', 'scripts/checks/lib/test/y.ts',
  'scripts/operator/alpha.seed', 'scripts/checks/lib/shared/alpha.seed', 'scripts/operator/.npmrc', 'scripts/checks/lib/.npmrc',
];
function contextProblems(ignoreText: string): string[] {
  const rules = rulesOf(ignoreText);
  return [...TREE, ...PROBES].flatMap((file) => {
    const need = wanted(file);
    const arrives = inContext(rules, file);
    if (need === true && !arrives) return [`${file} does not reach the build context`];
    if (need === false && arrives) return [`${file} reaches the build context`];
    return [];
  });
}

describe('.dockerignore, for the image of the operator pack', () => {
  const real = read('.dockerignore');
  const lines = real.split('\n');

  it('keeps env files, node_modules and test folders out at any depth, and lets in the pack and the checks that it reuses', () => {
    for (const line of ['**/.env', '**/.env.*', '**/test', 'node_modules', '**/node_modules', 'scripts/*', '!scripts/operator', '!scripts/checks']) expect(lines, line).toContain(line);
    expect(lines, 'the scripts folder is named with its star, so that the two re-includes below it work').not.toContain('scripts');
    expect(lines.indexOf('scripts/*')).toBeLessThan(lines.indexOf('!scripts/operator'));
    expect(lines.indexOf('scripts/*')).toBeLessThan(lines.indexOf('!scripts/checks'));
  });

  it('sends the sources of the pack and of the checks, and no test folder, env file or other script', () => {
    expect(contextProblems(real)).toEqual([]);
    // The check reads the real folders. It is not empty: it holds the files that the image needs and the test folders that it must not get.
    expect(TREE).toEqual(expect.arrayContaining(['scripts/operator/cli.ts', 'scripts/checks/lib/guards.ts', 'scripts/checks/tsconfig.json', 'scripts/checks/test/support/world.ts', 'scripts/deploy.test.mjs']));
    expect(TREE.some((file) => file.startsWith('scripts/operator/test/'))).toBe(true);
    const rules = rulesOf(real);
    expect(['scripts/operator/cli.ts', 'scripts/operator/lib/runner.ts', 'scripts/checks/lib/keys.ts', 'scripts/checks/tsconfig.json'].map((file) => inContext(rules, file))).toEqual([true, true, true, true]);
    expect(['scripts/operator/test/dockerfile.test.ts', 'scripts/checks/test/support/world.ts', 'scripts/deploy.test.mjs', 'deploy/server/README.md', 'docs/HIRE.md'].map((file) => inContext(rules, file))).toEqual([false, false, false, false, false]);
  });

  it('brings no test file, env file, key file or shell script into the image, and brings the guards of the pack', () => {
    const rules = rulesOf(real);
    const brought = read(DOCKERFILE).split('\n').filter((line) => /^COPY (?!--from=)/.test(line)).flatMap(sourcesOf).flatMap((source) => (statSync(posix.join(root, source)).isFile() ? [source] : filesBelow(source))).filter((file) => inContext(rules, file));
    expect(brought.filter((file) => NEVER_IN_IMAGE.test(file))).toEqual([]);
    for (const file of ['scripts/operator/cli.ts', 'scripts/operator/lib/approval.ts', 'scripts/operator/lib/plan.ts', 'scripts/checks/lib/guards.ts', 'scripts/checks/lib/land.ts']) expect(brought, file).toContain(file);
    expect(brought.filter((file) => file.startsWith('agents/')).sort()).toEqual(BID_PRICE_LISTS);
    expect(brought.filter((file) => file.startsWith('scripts/') && !/^scripts\/(operator\/|checks\/lib\/|checks\/tsconfig\.json$)/.test(file))).toEqual([]);
  });

  const without = (line: string): string => swap(real, `${line}\n`, '');
  const broken: ReadonlyArray<readonly [string, string, RegExp]> = [
    ['no re-include of the pack', without('!scripts/operator'), /scripts\/operator\/cli\.ts does not reach/],
    ['no re-include of the checks', without('!scripts/checks'), /scripts\/checks\/lib\/keys\.ts does not reach/],
    ['no line for the test folders after the re-includes', without('scripts/**/test'), /scripts\/operator\/test\/\S+ reaches/],
    ['the line for the test folders above the re-includes', swap(without('scripts/**/test'), '!scripts/operator\n', 'scripts/**/test\n!scripts/operator\n'), /scripts\/operator\/test\/\S+ reaches/],
    ['the line for the test folders at depth one only', swap(real, 'scripts/**/test\n', 'scripts/*/test\n'), /scripts\/operator\/lib\/test\/x\.ts reaches/],
    ['no line for the test folders of the checks', swap(without('scripts/**/test'), '!scripts/checks\n', '!scripts/checks\nscripts/operator/test\n'), /scripts\/checks\/test\/\S+ reaches/],
    ['no line for every folder named test', without('**/test'), /packages\/usecase-kit\/test\/\S+ reaches/],
    ['no line for env files after the re-includes', without('scripts/**/.env'), /scripts\/operator\/\.env reaches/],
    ['no line for env files with a suffix after the re-includes', without('scripts/**/.env.*'), /scripts\/operator\/\.env\.local reaches/],
    ['no line for node_modules after the re-includes', without('scripts/**/node_modules'), /scripts\/checks\/lib\/node_modules\/x\/index\.js reaches/],
    ['no line for key files after the re-includes', without('scripts/**/*.seed'), /scripts\/operator\/alpha\.seed reaches/],
    ['no line for npm settings files after the re-includes', without('scripts/**/.npmrc'), /scripts\/operator\/\.npmrc reaches/],
    ['no line for env files at any depth', without('**/.env'), /packages\/buyer-core\/\.env reaches/],
    ['no line for the scripts folder', without('scripts/*'), /scripts\/deploy\.test\.mjs reaches/],
  ];
  for (const [name, text, expected] of broken) {
    it(`refuses a file with ${name}`, () => {
      const problems = contextProblems(text);
      expect(problems.some((problem) => expected.test(problem)), JSON.stringify(problems.slice(0, 5))).toBe(true);
    });
  }

  it('accepts a file with a note, a line that leaves out more, a slash at the end of a line, and the env lines and the key lines in another order', () => {
    expect(contextProblems(`# a note\n${real}`)).toEqual([]);
    expect(contextProblems(`${real}*.tmp\n`)).toEqual([]);
    expect(contextProblems(swap(real, 'scripts/**/test\n', 'scripts/**/test/\n'))).toEqual([]);
    expect(contextProblems(swap(real, 'scripts/**/.env\nscripts/**/.env.*\n', 'scripts/**/.env.*\nscripts/**/.env\n'))).toEqual([]);
    expect(contextProblems(swap(real, 'scripts/**/*.seed\nscripts/**/.npmrc\n', 'scripts/**/.npmrc\nscripts/**/*.seed\n'))).toEqual([]);
  });
});
