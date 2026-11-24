// The settings of the operator pack. Each setting has an accepted twin and a refusal that names the setting and never shows its value. No test uses the network or a clock.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsError, VECTOR_MAINNET, parseCommonSettings } from '../../checks/lib/settings.ts';
import type { Env } from '../../checks/lib/settings.ts';
import { parseOperatorSettings } from '../lib/settings.ts';
import type { SettingsIo } from '../lib/settings.ts';
import { USE_CASE_NAMES } from '../usecases/names.ts';

const folders: string[] = [];
afterAll(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

/** A new folder in the temporary directory, with a mode (700 by default). */
function folder(mode = 0o700): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-settings-'));
  chmodSync(dir, mode);
  folders.push(dir);
  return dir;
}
const modeOf = (path: string): number => statSync(path).mode & 0o777;

const KEYS = folder();
const STATE = folder();
const BASE: Env = { OPERATOR_KEYS_DIR: KEYS, OPERATOR_STATE_DIR: STATE };
const COMMIT = 'a1b2c3d4e5'.repeat(4);
const parse = (more: Env = {}, io: Partial<SettingsIo> = {}) => parseOperatorSettings({ ...BASE, ...more }, io);
const refusalOf = (env: Env, io: Partial<SettingsIo> = {}): SettingsError => {
  try { parseOperatorSettings(env, io); } catch (err) { if (err instanceof SettingsError) return err; throw err; }
  throw new Error('the call did not refuse');
};
const problemsOf = (more: Env, io: Partial<SettingsIo> = {}): string[] => [...refusalOf({ ...BASE, ...more }, io).problems];
/** The refusal of one setting that is the only problem: it names that setting, and nothing else is wrong. */
const namesOnly = (name: string): unknown[] => [expect.stringContaining(name)];
const fsError = (code: string): Error => Object.assign(new Error(`${code}: a message that holds /a/private/path`), { code });
/** The settings that the checks give by default, for the values that the pack shares with them. */
const common = parseCommonSettings({ CHECKS_NETWORK: 'vector-mainnet', CHECKS_RECORD: 'ab'.repeat(32) }, { keys: [] });

describe('the defaults', () => {
  it('gives the defaults when only the two folders are set', () => {
    expect(parse()).toEqual({
      network: VECTOR_MAINNET, useCase: 'inventory-reorder', keysDir: KEYS, stateDir: STATE, agentsDir: '/agents', goFile: join(STATE, 'GO.json'), mockEnvFile: null, contact: null, module1Commit: null,
      urls: common.urls, maxFeeLovelace: 2_000_000n, maxCollateralLossLovelace: 5_000_000n,
    });
  });
  it('shares its endpoints and its limits with the checks: a change of one default shows here', () => {
    const settings = parse();
    expect(settings.urls).toEqual(common.urls);
    expect([settings.maxFeeLovelace, settings.maxCollateralLossLovelace]).toEqual([common.maxFeeLovelace, common.maxCollateralLossLovelace]);
  });
  it('reads only the environment that it is given, and never the one of the process', () => {
    const before = process.env.OPERATOR_KEYS_DIR;
    process.env.OPERATOR_KEYS_DIR = KEYS;
    try { expect(refusalOf({}).problems).toContainEqual(expect.stringContaining('OPERATOR_KEYS_DIR')); } finally {
      if (before === undefined) delete process.env.OPERATOR_KEYS_DIR; else process.env.OPERATOR_KEYS_DIR = before;
    }
  });
  it('gives frozen settings, and a network that is a copy of the one of the checks', () => {
    const settings = parse();
    expect(Object.isFrozen(settings)).toBe(true);
    expect(Object.isFrozen(settings.urls)).toBe(true);
    expect(Object.isFrozen(settings.network)).toBe(true);
    expect(settings.network).not.toBe(VECTOR_MAINNET);
    expect(VECTOR_MAINNET).toEqual({ name: 'vector-mainnet', magic: 764_824_073, systemStartMs: 1_756_485_600_000 });
  });
});

describe('the key folder', () => {
  it('takes a folder that exists, and keeps its path as an absolute path', () => {
    expect(parse().keysDir).toBe(KEYS);
    expect(modeOf(KEYS)).toBe(0o700);
  });
  it('needs the setting, and says so together with the state folder', () => {
    expect(refusalOf({}).problems).toEqual(['set OPERATOR_KEYS_DIR', 'set OPERATOR_STATE_DIR']);
    expect(problemsOf({ OPERATOR_KEYS_DIR: ' ' })).toEqual(['set OPERATOR_KEYS_DIR']);
  });
  it('refuses a folder that does not exist and a path that is a file, and makes nothing', () => {
    const missing = join(KEYS, 'no-such-folder');
    expect(problemsOf({ OPERATOR_KEYS_DIR: missing })).toEqual(namesOnly('OPERATOR_KEYS_DIR'));
    expect(existsSync(missing)).toBe(false);
    const file = join(KEYS, 'a-file');
    writeFileSync(file, 'text');
    expect(problemsOf({ OPERATOR_KEYS_DIR: file })).toEqual(namesOnly('OPERATOR_KEYS_DIR'));
  });
  it('says why when the folder cannot be looked at, with the code of the system and nothing of its message', () => {
    const problems = problemsOf({}, { stat: (path) => { if (path === KEYS) throw fsError('EIO'); return { isFolder: true, mode: 0o700 }; } });
    expect(problems).toEqual([expect.stringMatching(/OPERATOR_KEYS_DIR.*EIO/)]);
    expect(problems.join('\n')).not.toMatch(/private|path/);
  });
});

describe('the state folder', () => {
  it('makes a folder that is missing with mode 700, and the folders above it', () => {
    const top = folder();
    const path = join(top, 'one', 'two');
    expect(parse({ OPERATOR_STATE_DIR: path }).stateDir).toBe(path);
    expect(modeOf(path)).toBe(0o700);
    expect(modeOf(join(top, 'one'))).toBe(0o700);
  });
  it('takes a folder with mode 700 as it is, with its content', () => {
    const own = folder();
    writeFileSync(join(own, 'kept'), 'kept');
    expect(parse({ OPERATOR_STATE_DIR: own }).stateDir).toBe(own);
    expect(readFileSync(join(own, 'kept'), 'utf8')).toBe('kept');
    expect(modeOf(own)).toBe(0o700);
  });
  for (const mode of [0o755, 0o750, 0o770, 0o777, 0o500, 0o600]) {
    it(`refuses a folder with mode ${mode.toString(8)}, names the mode, and leaves the folder as it is`, () => {
      const own = folder(mode);
      try {
        const problems = problemsOf({ OPERATOR_STATE_DIR: own });
        expect(problems).toEqual(namesOnly('OPERATOR_STATE_DIR'));
        expect(problems[0]).toContain(mode.toString(8));
        expect(modeOf(own)).toBe(mode);
      } finally {
        chmodSync(own, 0o700);
      }
    });
  }
  it('refuses a path that is a file', () => {
    const file = join(STATE, 'a-file');
    writeFileSync(file, 'text', { mode: 0o600 });
    expect(problemsOf({ OPERATOR_STATE_DIR: file })).toEqual(namesOnly('OPERATOR_STATE_DIR'));
  });
  it('makes no folder when another setting is refused', () => {
    const path = join(folder(), 'state');
    expect(problemsOf({ OPERATOR_STATE_DIR: path, OPERATOR_USE_CASE: 'no-such-use-case' })).toEqual(namesOnly('OPERATOR_USE_CASE'));
    expect(existsSync(path)).toBe(false);
  });
  it('lists a refused state folder together with another problem, and makes nothing', () => {
    const own = folder(0o755);
    try {
      const problems = problemsOf({ OPERATOR_STATE_DIR: own, OPERATOR_MODULE1_COMMIT: 'short' });
      expect(problems).toHaveLength(2);
      expect(problems.join('\n')).toContain('OPERATOR_STATE_DIR');
      expect(problems.join('\n')).toContain('OPERATOR_MODULE1_COMMIT');
    } finally {
      chmodSync(own, 0o700);
    }
  });
  it('says why when the folder cannot be made, with the code of the system and nothing of its message', () => {
    const problems = problemsOf({ OPERATOR_STATE_DIR: join(STATE, 'new') }, { makeFolder: () => { throw fsError('EACCES'); } });
    expect(problems).toEqual([expect.stringMatching(/OPERATOR_STATE_DIR.*EACCES/)]);
    expect(problems.join('\n')).not.toMatch(/private|path/);
  });
  it('says why when the folder cannot be looked at', () => {
    const problems = problemsOf({}, { stat: (path) => { if (path === STATE) throw fsError('EIO'); return { isFolder: true, mode: 0o700 }; } });
    expect(problems).toEqual([expect.stringMatching(/OPERATOR_STATE_DIR.*EIO/)]);
  });
  it('puts the approval file in the state folder unless the settings name another file', () => {
    expect(parse().goFile).toBe(join(STATE, 'GO.json'));
    expect(parse({ OPERATOR_GO_FILE: '/srv/test/APPROVAL.json' }).goFile).toBe('/srv/test/APPROVAL.json');
  });
});

describe('the other paths', () => {
  it('takes the agents folder, the approval file and the mock environment file as they are set', () => {
    const settings = parse({ OPERATOR_AGENTS_DIR: '/srv/test-agents', OPERATOR_GO_FILE: '/srv/test/GO.json', OPERATOR_MOCK_ENV_FILE: '/srv/test/mock.env' });
    expect([settings.agentsDir, settings.goFile, settings.mockEnvFile]).toEqual(['/srv/test-agents', '/srv/test/GO.json', '/srv/test/mock.env']);
  });
  it('makes a relative path absolute, as the checks do', () => {
    const settings = parse({ OPERATOR_AGENTS_DIR: 'test-agents', OPERATOR_MOCK_ENV_FILE: 'mock.env' });
    expect([settings.agentsDir, settings.mockEnvFile]).toEqual([resolve('test-agents'), resolve('mock.env')]);
  });
  for (const name of ['OPERATOR_KEYS_DIR', 'OPERATOR_STATE_DIR', 'OPERATOR_AGENTS_DIR', 'OPERATOR_GO_FILE', 'OPERATOR_MOCK_ENV_FILE']) {
    it(`${name}: refuses a path with a line break or another control character, and a path that is too long`, () => {
      for (const bad of [`${KEYS}\nOPERATOR_CONTACT=x`, `${KEYS}\u0000`, `${KEYS}\u001b[31m`, `${KEYS}\u0085`, `/${'a'.repeat(5000)}`]) {
        expect(problemsOf({ [name]: bad }), JSON.stringify(bad.slice(0, 20))).toEqual(namesOnly(name));
      }
    });
    it(`${name}: takes a path with a space`, () => {
      const spaced = join(folder(), 'a folder');
      mkdirSync(spaced, { mode: 0o700 });
      chmodSync(spaced, 0o700);
      expect(parse({ [name]: spaced })).toBeDefined();
    });
  }
});

describe('the use case', () => {
  it('is inventory-reorder when the setting is not set, and takes each name of the closed list', () => {
    expect(parse().useCase).toBe('inventory-reorder');
    expect(parse({ OPERATOR_USE_CASE: ' ' }).useCase).toBe('inventory-reorder');
    for (const name of USE_CASE_NAMES) expect(parse({ OPERATOR_USE_CASE: name }).useCase).toBe(name);
  });
  it('refuses a name that is not in the list, whatever its form', () => {
    for (const bad of ['inventory', 'inventory-reorder-2', 'Inventory-Reorder', '../inventory-reorder', 'inventory-reorder/', 'use case']) {
      expect(problemsOf({ OPERATOR_USE_CASE: bad }), bad).toEqual(namesOnly('OPERATOR_USE_CASE'));
    }
  });
});

describe('the network', () => {
  it('is vector-mainnet when the setting is not set, and when it names vector-mainnet', () => {
    expect(parse().network).toEqual(VECTOR_MAINNET);
    expect(parse({ OPERATOR_NETWORK: 'vector-mainnet' }).network).toEqual(VECTOR_MAINNET);
  });
  it('takes the magic of mainnet and refuses another magic for it', () => {
    expect(parse({ OPERATOR_NETWORK_MAGIC: '764824073' }).network).toEqual(VECTOR_MAINNET);
    expect(parse({ OPERATOR_NETWORK: 'vector-mainnet', OPERATOR_NETWORK_MAGIC: '764824073' }).network).toEqual(VECTOR_MAINNET);
    expect(problemsOf({ OPERATOR_NETWORK_MAGIC: '3311' })).toEqual(namesOnly('OPERATOR_NETWORK_MAGIC'));
    expect(problemsOf({ OPERATOR_NETWORK: 'vector-mainnet', OPERATOR_NETWORK_MAGIC: 'many' })).toEqual(namesOnly('OPERATOR_NETWORK_MAGIC'));
  });
  it('takes a named test network with its magic and its start', () => {
    expect(parse({ OPERATOR_NETWORK: 'vector-test', OPERATOR_NETWORK_MAGIC: '42', OPERATOR_NETWORK_SYSTEM_START_MS: '1700000000000' }).network)
      .toEqual({ name: 'vector-test', magic: 42, systemStartMs: 1_700_000_000_000 });
    expect(parse({ OPERATOR_NETWORK: 'vector-test', OPERATOR_NETWORK_MAGIC: '0' }).network).toEqual({ name: 'vector-test', magic: 0, systemStartMs: null });
    expect(parse({ OPERATOR_NETWORK: 'a', OPERATOR_NETWORK_MAGIC: '4294967295' }).network.magic).toBe(4_294_967_295);
  });
  it('refuses a test network without a magic, with a bad magic or a bad start', () => {
    expect(problemsOf({ OPERATOR_NETWORK: 'vector-test' })).toEqual(['set OPERATOR_NETWORK_MAGIC']);
    for (const bad of ['4.2', '-1', 'many', '4294967296', '1e3']) {
      expect(problemsOf({ OPERATOR_NETWORK: 'vector-test', OPERATOR_NETWORK_MAGIC: bad }), bad).toEqual(namesOnly('OPERATOR_NETWORK_MAGIC'));
    }
    for (const bad of ['0', '-5', 'soon', '1.5', '9007199254740992']) {
      expect(problemsOf({ OPERATOR_NETWORK: 'vector-test', OPERATOR_NETWORK_MAGIC: '42', OPERATOR_NETWORK_SYSTEM_START_MS: bad }), bad).toEqual(namesOnly('OPERATOR_NETWORK_SYSTEM_START_MS'));
    }
  });
  it('refuses a name that is no name of a network', () => {
    for (const bad of ['Not A Name', 'Vector-Test', '-vector', 'a'.repeat(41), 'vector_test', '../x']) {
      expect(problemsOf({ OPERATOR_NETWORK: bad, OPERATOR_NETWORK_MAGIC: '42' }), bad).toEqual(namesOnly('OPERATOR_NETWORK'));
    }
    expect(parse({ OPERATOR_NETWORK: 'a'.repeat(40), OPERATOR_NETWORK_MAGIC: '42' }).network.name).toBe('a'.repeat(40));
  });
});

describe('the contact', () => {
  it('is null when the setting is not set, and is the text of the setting when it is', () => {
    expect(parse().contact).toBeNull();
    expect(parse({ OPERATOR_CONTACT: '  ' }).contact).toBeNull();
    expect(parse({ OPERATOR_CONTACT: ' ops@example.com ' }).contact).toBe('ops@example.com');
    expect(parse({ OPERATOR_CONTACT: 'a'.repeat(254) }).contact).toBe('a'.repeat(254));
  });
  it('refuses text with a line break or another control character, and text that is too long', () => {
    for (const bad of ['ops@example.com\nOTHER=1', 'ops@example.com\rOTHER=1', 'ops\u0000@example.com', 'ops@example.com\u0085x', 'a'.repeat(255)]) {
      expect(problemsOf({ OPERATOR_CONTACT: bad }), JSON.stringify(bad.slice(0, 20))).toEqual(namesOnly('OPERATOR_CONTACT'));
    }
  });
});

describe('the Module-1 commit', () => {
  it('is null when the setting is not set, and takes 40 lower-case hex characters', () => {
    expect(parse().module1Commit).toBeNull();
    expect(parse({ OPERATOR_MODULE1_COMMIT: COMMIT }).module1Commit).toBe(COMMIT);
    expect(parse({ OPERATOR_MODULE1_COMMIT: ` ${COMMIT} ` }).module1Commit).toBe(COMMIT);
    expect(parse({ OPERATOR_MODULE1_COMMIT: '0'.repeat(40) }).module1Commit).toBe('0'.repeat(40));
  });
  it('refuses a commit with 39 or 41 characters, with upper case, with a character that is no hex digit, and a reference name', () => {
    for (const bad of [COMMIT.slice(1), `${COMMIT}0`, COMMIT.toUpperCase(), `${COMMIT.slice(1)}g`, 'main', `${COMMIT.slice(0, 20)} ${COMMIT.slice(21)}`]) {
      expect(problemsOf({ OPERATOR_MODULE1_COMMIT: bad }), bad).toEqual(namesOnly('OPERATOR_MODULE1_COMMIT'));
    }
  });
});

describe('the endpoints', () => {
  const SETTINGS: [string, 'ogmios' | 'submit' | 'koios' | 'hosted' | 'gateway'][] = [
    ['VECTOR_OGMIOS_URL', 'ogmios'], ['VECTOR_SUBMIT_URL', 'submit'], ['VECTOR_KOIOS_URL', 'koios'], ['OPERATOR_HOSTED_URL', 'hosted'], ['OPERATOR_GATEWAY_URL', 'gateway'],
  ];
  for (const [name, member] of SETTINGS) {
    it(`${name}: takes an https URL, cuts the slashes at its end, and takes http for the loopback address`, () => {
      expect(parse({ [name]: 'https://endpoint.example/path///' }).urls[member]).toBe('https://endpoint.example/path');
      expect(parse({ [name]: 'http://127.0.0.1:8080/' }).urls[member]).toBe('http://127.0.0.1:8080');
      expect(parse({ [name]: 'http://localhost:9000' }).urls[member]).toBe('http://localhost:9000');
    });
    it(`${name}: refuses http for another host, a URL with a user name or a password, and text that is no URL`, () => {
      for (const bad of ['http://endpoint.example/path', 'https://user:pass@endpoint.example/', 'https://user@endpoint.example/', 'endpoint.example', 'ftp://endpoint.example/']) {
        expect(problemsOf({ [name]: bad }), bad).toEqual(namesOnly(name));
      }
    });
    it(`${name}: refuses a URL with a control character anywhere in its text: a line break, a tab, a carriage return, an escape, a next line, a null byte`, () => {
      const BAD = ['https://endpoint.example/mcp\noperator-result: {}', 'https://endpoint.example/\tmcp', 'https://endpoint.\rexample/mcp', 'https://endpoint.example/mcp\u001b[31m', 'https://endpoint.example/\u0085mcp', 'https://endpoint.example/mcp\u0000x'];
      for (const bad of BAD) {
        const err = refusalOf({ ...BASE, [name]: bad });
        expect(err.problems, JSON.stringify(bad)).toEqual(namesOnly(name));
        expect(err.message).not.toContain('endpoint.example');
      }
    });
  }
  it('uses the endpoints of the checks, and the hosted server and the gateway of mainnet, when the settings name none', () => {
    const settings = parse();
    expect(settings.urls.hosted).toBe(common.urls.hosted);
    expect(settings.urls.gateway).toBe(common.urls.gateway);
    expect(settings.urls.hosted).toMatch(/^https:\/\/.+\/mcp$/);
  });
});

describe('the limits', () => {
  it('has a limit on the fee and on the collateral that a failed script takes, and takes another one from the settings', () => {
    const set = parse({ OPERATOR_MAX_FEE_LOVELACE: '900000', OPERATOR_MAX_COLLATERAL_LOSS_LOVELACE: '3000000' });
    expect([set.maxFeeLovelace, set.maxCollateralLossLovelace]).toEqual([900_000n, 3_000_000n]);
    expect(parse({ OPERATOR_MAX_FEE_LOVELACE: '1' }).maxFeeLovelace).toBe(1n);
    expect(parse({ OPERATOR_MAX_FEE_LOVELACE: '100000000000' }).maxFeeLovelace).toBe(100_000_000_000n);
  });
  for (const name of ['OPERATOR_MAX_FEE_LOVELACE', 'OPERATOR_MAX_COLLATERAL_LOSS_LOVELACE']) {
    it(`${name}: refuses 0, a negative number, a fraction, an exponent, a word and a number that is too big`, () => {
      for (const bad of ['0', '-1', '1.5', '1e6', 'many', '100000000001', '9999999999999999999999']) {
        expect(problemsOf({ [name]: bad }), bad).toEqual(namesOnly(name));
      }
    });
  }
});

describe('a refusal', () => {
  it('lists every problem in one SettingsError, one problem for each setting', () => {
    const err = refusalOf({
      OPERATOR_KEYS_DIR: join(KEYS, 'missing'), OPERATOR_USE_CASE: 'unknown', OPERATOR_NETWORK: 'Bad Name', OPERATOR_MODULE1_COMMIT: 'main', OPERATOR_CONTACT: 'a\nb', OPERATOR_HOSTED_URL: 'http://endpoint.example',
      OPERATOR_MAX_FEE_LOVELACE: '0',
    });
    expect(err.problems).toHaveLength(8);
    for (const name of ['OPERATOR_KEYS_DIR', 'OPERATOR_STATE_DIR', 'OPERATOR_USE_CASE', 'OPERATOR_NETWORK', 'OPERATOR_MODULE1_COMMIT', 'OPERATOR_CONTACT', 'OPERATOR_HOSTED_URL', 'OPERATOR_MAX_FEE_LOVELACE']) {
      expect(err.message, name).toContain(name);
    }
  });
  it('shows no value of any setting: a value can be a secret, and the name is enough to find the mistake', () => {
    const bad = (name: string): string => `distinctive-${name.toLowerCase()}`;
    const stateFile = join(folder(), bad('state'));
    writeFileSync(stateFile, 'text', { mode: 0o600 });
    const env: Env = {
      OPERATOR_KEYS_DIR: join(KEYS, bad('keys')), OPERATOR_STATE_DIR: stateFile, OPERATOR_AGENTS_DIR: `/${bad('agents')}\u0001x`, OPERATOR_GO_FILE: `/${bad('go')}\u0001x`, OPERATOR_MOCK_ENV_FILE: `/${bad('mock')}\u0001x`,
      OPERATOR_USE_CASE: bad('use'), OPERATOR_CONTACT: `${bad('contact')}\nx`, OPERATOR_MODULE1_COMMIT: bad('commit'), OPERATOR_NETWORK: bad('network').toUpperCase(),
      OPERATOR_HOSTED_URL: `http://${bad('hosted')}.example/token`, OPERATOR_GATEWAY_URL: `https://user:${bad('gateway')}@endpoint.example`, VECTOR_OGMIOS_URL: bad('ogmios'),
      VECTOR_SUBMIT_URL: `http://${bad('submit')}.example`, VECTOR_KOIOS_URL: `ftp://${bad('koios')}.example`, OPERATOR_MAX_FEE_LOVELACE: bad('fee'), OPERATOR_MAX_COLLATERAL_LOSS_LOVELACE: bad('loss'),
    };
    const err = refusalOf(env);
    expect(err.problems).toHaveLength(Object.keys(env).length);
    for (const name of Object.keys(env)) expect(err.message, name).toContain(name);
    expect(err.message).not.toMatch(/distinctive/i);
    expect(err.message).not.toContain(tmpdir());
    const test = refusalOf({ ...BASE, OPERATOR_NETWORK: 'vector-test', OPERATOR_NETWORK_MAGIC: bad('magic'), OPERATOR_NETWORK_SYSTEM_START_MS: bad('start') });
    expect(test.problems).toHaveLength(2);
    expect(test.message).not.toMatch(/distinctive/i);
    const mainnet = refusalOf({ ...BASE, OPERATOR_NETWORK_MAGIC: bad('magic') });
    expect(mainnet.problems).toEqual(namesOnly('OPERATOR_NETWORK_MAGIC'));
    expect(mainnet.message).not.toMatch(/distinctive/i);
  });
});
