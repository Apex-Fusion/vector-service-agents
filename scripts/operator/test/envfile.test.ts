// The editor of one env file. It keeps the lines and the comments in order, sets one variable at a time, writes the file whole through a temporary file with mode 600, and never prints a value.
// A test gives a value that it can look for (SECRET) and then looks for it in every text that the editor makes: a description, an error, a string form.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { EnvFile, EnvFileError } from '../lib/envfile.ts';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A secret that a test can look for: 64 characters, made at run time. */
const SECRET = 'cd'.repeat(32);

/** A folder of its own with the files that a test names (name to text or bytes), and the folder. */
function folderWith(files: Readonly<Record<string, string | Buffer>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'operator-env-'));
  roots.push(dir);
  chmodSync(dir, 0o750);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

const EXAMPLE = [
  '# The supplier key of the runtime. The line is empty here on purpose.',
  'SUPPLIER_PRIV_KEY_HEX=',
  'SUPPLIER_PKH=',
  '',
  '# The token between the runtime and the service.',
  'SERVICE_AUTH_HEADER=""',
  'ESCROW_REF_UTXO=abcd#0',
  'OPERATOR_CONTACT=<role address of the operator>',
  '   # an indented comment',
  'FAULT_MODE=',
  '',
].join('\n');

function errorOf(run: () => unknown): EnvFileError {
  try { run(); } catch (err) {
    if (err instanceof EnvFileError) return err;
    throw err;
  }
  throw new Error('the call did not refuse');
}

describe('reading', () => {
  it('keeps the variables in the order of the file, and tells a name that the file holds from one that it does not', () => {
    const file = EnvFile.fromExample(EXAMPLE);
    expect(file.names()).toEqual(['SUPPLIER_PRIV_KEY_HEX', 'SUPPLIER_PKH', 'SERVICE_AUTH_HEADER', 'ESCROW_REF_UTXO', 'OPERATOR_CONTACT', 'FAULT_MODE']);
    expect(file.has('SUPPLIER_PKH')).toBe(true);
    expect(file.has('SUPPLIER')).toBe(false);
    expect(file.has('supplier_pkh')).toBe(false);
    expect(file.has('not a name')).toBe(false);
    expect(file.get('SUPPLIER_PKH')).toBe('');
    expect(file.get('MISSING')).toBeUndefined();
    expect(file.get('not a name')).toBeUndefined();
  });
  const VALUES: ReadonlyArray<readonly [string, string]> = [
    ['A=plain', 'plain'], ['A=', ''], ['A=""', ''], ["A=''", ''], ['A="two words"', 'two words'], ["A='single quoted'", 'single quoted'], ['A=x#y', 'x#y'], ['A=abcd#0', 'abcd#0'],
    ['A=x #comment', 'x'], ['A="q" # note', 'q'], ['A=  padded  ', 'padded'], ['A=<a b c>', '<a b c>'], ['A=1=2', '1=2'], ['A="a\\"b"', 'a"b'], ['A="a\\\\b"', 'a\\b'],
    ['A="x#y"', 'x#y'], ['A=Bearer abc', 'Bearer abc'],
  ];
  for (const [line, value] of VALUES) {
    it(`reads the value of the line ${JSON.stringify(line)} as ${JSON.stringify(value)}`, () => {
      expect(EnvFile.fromExample(`${line}\n`).get('A')).toBe(value);
    });
  }
  it('reads a file that holds only comments and empty lines, and an empty file', () => {
    expect(EnvFile.fromExample('# one\n\n   \n# two\n').names()).toEqual([]);
    expect(EnvFile.fromExample('').names()).toEqual([]);
  });
  it('opens a file by its path, with the same result as the text of the file', () => {
    const dir = folderWith({ '.env.test': EXAMPLE });
    const file = EnvFile.open(join(dir, '.env.test'));
    expect(file.names()).toEqual(EnvFile.fromExample(EXAMPLE).names());
    expect(file.get('OPERATOR_CONTACT')).toBe('<role address of the operator>');
  });
  it('reads the variable names of the three env examples of the agents, and writes each one back as it was', () => {
    const folder = fileURLToPath(new URL('../../../deploy/server/', import.meta.url));
    const target = folderWith();
    const MUST_HOLD: ReadonlyArray<readonly [string, string]> = [['.env.reorder-agent.example', 'AGENT_ID'], ['.env.order-desk.example', 'AGENT_DID'], ['.env.order-desk-runtime.example', 'ADVERT_REF']];
    for (const [name, variable] of MUST_HOLD) {
      const text = readFileSync(join(folder, name), 'utf8');
      const file = EnvFile.fromExample(text);
      expect(file.names().length, name).toBeGreaterThan(5);
      expect(file.has(variable), name).toBe(true);
      file.write(join(target, name));
      expect(readFileSync(join(target, name), 'utf8'), name).toBe(text);
    }
    expect(EnvFile.fromExample(readFileSync(join(folder, '.env.reorder-agent.example'), 'utf8')).get('ESCROW_REF_UTXO')).toMatch(/^[0-9a-f]{64}#0$/);
  });

  it('refuses a file that is missing, and a path that is not a file, and shows no path', () => {
    const dir = folderWith();
    const missing = errorOf(() => EnvFile.open(join(dir, 'missing.env')));
    expect(missing.reason).toBe('unreadable');
    expect(missing.message).toMatch(/does not exist/);
    const folder = errorOf(() => EnvFile.open(dir));
    expect(folder.reason).toBe('unreadable');
    expect(folder.message).toMatch(/could not be read \(EISDIR\)/);
    for (const error of [missing, folder]) expect(error.message).not.toContain(dir);
  });
  it('refuses a file that cannot be read through the file system that a test gives, and names the code only', () => {
    const error = errorOf(() => EnvFile.open('/agents/reorder-agent/.env.reorder-agent', { read: () => { throw Object.assign(new Error('EACCES: permission denied, open /agents/reorder-agent'), { code: 'EACCES' }); } }));
    expect(error.message).toMatch(/\(EACCES\)/);
    expect(error.message).not.toContain('/agents');
  });
  const DAMAGED: ReadonlyArray<readonly [string, string | Buffer, EnvFileError['reason']]> = [
    ['a NUL byte', Buffer.from(`A=1\nB=${SECRET}\u0000\n`), 'not_text'],
    ['a byte that is no UTF-8', Buffer.concat([Buffer.from(`A=${SECRET}\n# `), Buffer.from([0xc3, 0x28]), Buffer.from('\n')]), 'not_text'],
    ['a carriage return', `A=1\r\nB=${SECRET}\r\n`, 'damaged'],
    ['a line that is no assignment and no comment', `A=1\nthis is not a line ${SECRET}\n`, 'damaged'],
    ['a name with a space before the equals sign', `A =${SECRET}\n`, 'damaged'],
    ['a name with a space after the equals sign and a dash in the name', `A-B=${SECRET}\n`, 'damaged'],
    ['an export prefix', `export A=${SECRET}\n`, 'damaged'],
    ['a byte order mark', `\uFEFFA=${SECRET}\n`, 'damaged'],
    ['one name twice', `A=1\nB=2\nA=${SECRET}\n`, 'damaged'],
    ['a double quote that does not end', `A="${SECRET}\n`, 'damaged'],
    ['a single quote that does not end', `A='${SECRET}\n`, 'damaged'],
    ['text after a quoted value', `A="${SECRET}" and more\n`, 'damaged'],
    ['a name that begins with a digit', `1A=${SECRET}\n`, 'damaged'],
    ['a file over the limit', `A=${'x'.repeat(1_048_577)}\n`, 'damaged'],
  ];
  for (const [what, content, reason] of DAMAGED) {
    it(`refuses a file with ${what}, from a path and from a text where the text can hold it, and shows nothing of it`, () => {
      const dir = folderWith({ '.env.bad': content });
      const error = errorOf(() => EnvFile.open(join(dir, '.env.bad')));
      expect(error.reason).toBe(reason);
      expect(error.message).not.toContain(SECRET);
      if (typeof content === 'string') expect(errorOf(() => EnvFile.fromExample(content)).message).not.toContain(SECRET);
    });
  }
  it('names the line that is damaged by its number, and reads the same file without the fault', () => {
    const error = errorOf(() => EnvFile.fromExample(`# one\nA=1\n\nbroken line\nB=2\n`));
    expect(error.message).toMatch(/line 4/);
    expect(EnvFile.fromExample(`# one\nA=1\n\nB=3\nB2=2\n`).names()).toEqual(['A', 'B', 'B2']);
  });
  it('reads a name in lower case or with a small letter, and refuses to set it', () => {
    const file = EnvFile.fromExample('Mixed_Case=1\nlower=2\n');
    expect(file.names()).toEqual(['Mixed_Case', 'lower']);
    expect(file.get('lower')).toBe('2');
    expect(errorOf(() => file.set('lower', '3')).reason).toBe('name');
  });
});

describe('set', () => {
  it('replaces a variable in its place, and keeps every other line, the comments and the empty lines as they were', () => {
    const file = EnvFile.fromExample(EXAMPLE);
    file.set('SUPPLIER_PKH', 'ab'.repeat(28));
    const target = join(folderWith(), '.env.out');
    file.write(target);
    const lines = readFileSync(target, 'utf8').split('\n');
    const before = EXAMPLE.split('\n');
    expect(lines).toHaveLength(before.length);
    for (let index = 0; index < before.length; index += 1) {
      expect(lines[index], `line ${index + 1}`).toBe(before[index] === 'SUPPLIER_PKH=' ? `SUPPLIER_PKH=${'ab'.repeat(28)}` : before[index]);
    }
    expect(file.get('SUPPLIER_PKH')).toBe('ab'.repeat(28));
    expect(file.names()).toEqual(EnvFile.fromExample(EXAMPLE).names());
  });
  it('appends a variable that the file does not hold, after the last line, and a second set of it replaces it', () => {
    const file = EnvFile.fromExample(EXAMPLE);
    file.set('AGENT_ID', 'one');
    file.set('ADVERT_REF', 'two');
    file.set('AGENT_ID', 'three');
    expect(file.names().slice(-2)).toEqual(['AGENT_ID', 'ADVERT_REF']);
    expect(file.get('AGENT_ID')).toBe('three');
    const target = join(folderWith(), '.env.out');
    file.write(target);
    const text = readFileSync(target, 'utf8');
    expect(text.endsWith('FAULT_MODE=\nAGENT_ID=three\nADVERT_REF=two\n')).toBe(true);
    expect(text.match(/^AGENT_ID=/gm)).toHaveLength(1);
  });
  it('appends to an empty file, and ends each file that has a line with one new line', () => {
    const file = EnvFile.fromExample('');
    file.set('ONE', '1');
    const target = join(folderWith(), '.env.out');
    file.write(target);
    expect(readFileSync(target, 'utf8')).toBe('ONE=1\n');
    const bare = EnvFile.fromExample('A=1\n# last');
    bare.write(target);
    expect(readFileSync(target, 'utf8')).toBe('A=1\n# last\n');
  });

  for (const name of ['lower', 'Mixed', '1ABC', 'A-B', 'A B', 'A=B', '', ' A', 'A\nB', 'a'.repeat(3), 'ÄB', '_A', 'A.B']) {
    it(`refuses the name ${JSON.stringify(name)}, and changes nothing`, () => {
      const file = EnvFile.fromExample(EXAMPLE);
      const error = errorOf(() => file.set(name, 'value'));
      expect(error.reason).toBe('name');
      expect(file.names()).toEqual(EnvFile.fromExample(EXAMPLE).names());
    });
  }
  for (const name of ['A', 'ABC_1', 'A1', 'SUPPLIER_PRIV_KEY_HEX', 'REORDER_DELEGATION_1_PKH']) {
    it(`accepts the name ${name}`, () => {
      const file = EnvFile.fromExample(EXAMPLE);
      file.set(name, 'value');
      expect(file.get(name)).toBe('value');
    });
  }
  it('refuses a name that is no name without showing it, and shows a name that looks like one', () => {
    const file = EnvFile.fromExample('');
    expect(errorOf(() => file.set(SECRET, 'x')).message).not.toContain(SECRET);
    expect(errorOf(() => file.set('bad name', 'x')).message).not.toContain('bad name');
    expect(errorOf(() => file.set('lower_case', 'x')).message).toContain('lower_case');
  });
  const BAD_VALUES: ReadonlyArray<readonly [string, unknown]> = [
    ['a new line', `a\n${SECRET}`], ['a carriage return', `a\r${SECRET}`], ['a NUL byte', `a\u0000${SECRET}`], ['another control character', `a\u0001${SECRET}`], ['a delete character', `a\u007f${SECRET}`],
    ['a double quote', `a"${SECRET}`], ['a backslash', `a\\${SECRET}`], ['a dollar sign', `a$${SECRET}`], ['a number', 5], ['null', null], ['undefined', undefined], ['a list', [SECRET]],
  ];
  for (const [what, value] of BAD_VALUES) {
    it(`refuses a value with ${what}, changes nothing, and shows nothing of the value`, () => {
      const file = EnvFile.fromExample(EXAMPLE);
      const error = errorOf(() => file.set('FAULT_MODE', value as string));
      expect(error.reason).toBe('value');
      expect(error.message).toContain('FAULT_MODE');
      expect(error.message).not.toContain(SECRET);
      expect(file.get('FAULT_MODE')).toBe('');
      expect(errorOf(() => file.set('NEW_NAME', value as string)).reason).toBe('value');
      expect(file.has('NEW_NAME')).toBe(false);
    });
  }
  const QUOTING: ReadonlyArray<readonly [string, string]> = [
    ['plain', 'plain'], ['', ''], ['a=b', 'a=b'], ['é ü', '"é ü"'], ['two words', '"two words"'], ['abcd#0', '"abcd#0"'], [' lead', '" lead"'], ['trail ', '"trail "'], ['tab\there', '"tab\there"'],
    ["'q", `"'q"`], ["it's", "it's"], [`Bearer ${SECRET}`, `"Bearer ${SECRET}"`], ['a'.repeat(300), 'a'.repeat(300)], ['#', '"#"'], [' ', '" "'],
  ];
  for (const [value, written] of QUOTING) {
    it(`writes the value ${JSON.stringify(value.length > 40 ? `${value.slice(0, 10)}...` : value)} as ${JSON.stringify(written.length > 40 ? `${written.slice(0, 10)}...` : written)}, and reads it back as it was`, () => {
      const file = EnvFile.fromExample('X=1\n');
      file.set('X', value);
      expect(file.get('X')).toBe(value);
      const target = join(folderWith(), '.env.out');
      file.write(target);
      expect(readFileSync(target, 'utf8')).toBe(`X=${written}\n`);
      expect(EnvFile.open(target).get('X')).toBe(value);
    });
  }
  it('writes the service header with its quotes, and keeps the quotes of a line that it does not touch', () => {
    const file = EnvFile.fromExample('SERVICE_AUTH_HEADER=""\nOTHER=1\n');
    file.set('OTHER', '2');
    file.set('SERVICE_AUTH_HEADER', `Bearer ${SECRET}`);
    const target = join(folderWith(), '.env.out');
    file.write(target);
    expect(readFileSync(target, 'utf8')).toBe(`SERVICE_AUTH_HEADER="Bearer ${SECRET}"\nOTHER=2\n`);
    const kept = EnvFile.fromExample('SERVICE_AUTH_HEADER="Bearer old value"\nOTHER=1\n');
    kept.set('OTHER', '9');
    kept.write(target);
    expect(readFileSync(target, 'utf8')).toBe('SERVICE_AUTH_HEADER="Bearer old value"\nOTHER=9\n');
  });
  it('clears a variable to an empty value, as the fault switch is cleared', () => {
    const file = EnvFile.fromExample('FAULT_MODE=confirm_wrong_lot\n');
    file.set('FAULT_MODE', '');
    const target = join(folderWith(), '.env.out');
    file.write(target);
    expect(readFileSync(target, 'utf8')).toBe('FAULT_MODE=\n');
    expect(file.get('FAULT_MODE')).toBe('');
  });
});

describe('describe', () => {
  it('gives the names and the lengths of the values, in the order of the file, and no value', () => {
    const file = EnvFile.fromExample(`# comment ${SECRET}\nA=${SECRET}\nB=\nC="two words"\nD=x#y\n`);
    file.set('E', `Bearer ${SECRET}`);
    const described = file.describe();
    expect(described).toEqual([{ name: 'A', length: 64 }, { name: 'B', length: 0 }, { name: 'C', length: 9 }, { name: 'D', length: 3 }, { name: 'E', length: 71 }]);
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect(Object.keys(described[0]!).sort()).toEqual(['length', 'name']);
  });
  it('shows no value in the string forms of the editor', () => {
    const file = EnvFile.fromExample(`A=${SECRET}\n`);
    for (const text of [String(file), JSON.stringify(file), inspect(file, { depth: 5, showHidden: true }), `${file}`, JSON.stringify({ file })]) {
      expect(text).not.toContain(SECRET);
    }
    expect(JSON.parse(JSON.stringify(file))).toEqual({ names: ['A'] });
    expect(String(file)).toMatch(/1 variable/);
  });
  it('shows no value in the error of any call that fails', () => {
    const dir = folderWith({ '.env.bad': `A=${SECRET}\nthis is no line\n` });
    const file = EnvFile.fromExample(`A=${SECRET}\n`);
    const messages = [
      errorOf(() => EnvFile.open(join(dir, '.env.bad'))), errorOf(() => file.set(`bad ${SECRET}`, SECRET)), errorOf(() => file.set('A', `${SECRET}\n`)), errorOf(() => file.write()),
      errorOf(() => file.write(join(dir, 'missing-folder', '.env'))), errorOf(() => EnvFile.fromExample(`A=1\n${SECRET}\n`)),
    ].map((error) => error.message);
    for (const message of messages) expect(message).not.toContain(SECRET);
    for (const message of messages) expect(message).not.toContain(dir);
  });
});

describe('write', () => {
  it('replaces the file whole with mode 600, leaves no temporary file, and does not change the folder', () => {
    const dir = folderWith({ '.env.test': EXAMPLE });
    const path = join(dir, '.env.test');
    chmodSync(path, 0o644);
    const folderBefore = statSync(dir);
    const file = EnvFile.open(path);
    file.set('ESCROW_REF_UTXO', 'abcd#1');
    file.write();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('ESCROW_REF_UTXO="abcd#1"');
    expect(readdirSyncOf(dir)).toEqual(['.env.test']);
    expect(statSync(dir).mode & 0o777).toBe(folderBefore.mode & 0o777);
    expect(statSync(dir).uid).toBe(folderBefore.uid);
    expect(statSync(dir).gid).toBe(folderBefore.gid);
  });
  it('makes the temporary file in the folder of the target with mode 600, and renames it over the target', () => {
    const dir = folderWith({ '.env.test': 'A=1\n' });
    const path = join(dir, '.env.test');
    const renames: Array<{ from: string; to: string; mode: number; text: string }> = [];
    const file = EnvFile.open(path, {
      rename: (from, to) => {
        renames.push({ from, to, mode: statSync(from).mode & 0o777, text: readFileSync(from, 'utf8') });
        renameSync(from, to);
      },
    });
    file.set('A', '2');
    file.write();
    expect(renames).toHaveLength(1);
    expect(dirname(renames[0]!.from)).toBe(dir);
    expect(basename(renames[0]!.from)).toMatch(/^\..*\.tmp$/);
    expect(renames[0]!.to).toBe(path);
    expect(renames[0]!.mode).toBe(0o600);
    expect(renames[0]!.text).toBe('A=2\n');
    expect(readFileSync(path, 'utf8')).toBe('A=2\n');
  });
  it('leaves the old file as it was when the rename fails, removes the temporary file, and names the code only', () => {
    const dir = folderWith({ '.env.test': EXAMPLE });
    const path = join(dir, '.env.test');
    const before = readFileSync(path);
    const file = EnvFile.open(path, { rename: () => { throw Object.assign(new Error(`ENOSPC: no space left on device, rename '${path}'`), { code: 'ENOSPC' }); } });
    file.set('FAULT_MODE', 'confirm_wrong_lot');
    const error = errorOf(() => file.write());
    expect(error.reason).toBe('write');
    expect(error.message).toMatch(/\(ENOSPC\)/);
    expect(error.message).toMatch(/old file is as it was/);
    expect(error.message).not.toContain(dir);
    expect(readFileSync(path).equals(before)).toBe(true);
    expect(readdirSyncOf(dir)).toEqual(['.env.test']);
  });
  it('refuses to write into a folder that is missing, and does not make it', () => {
    const dir = folderWith();
    const target = join(dir, 'missing', '.env.out');
    const error = errorOf(() => EnvFile.fromExample('A=1\n').write(target));
    expect(error.reason).toBe('write');
    expect(error.message).toMatch(/\(ENOENT\)/);
    expect(readdirSyncOf(dir)).toEqual([]);
  });
  it('writes to the path that it is given, and leaves the file that it was opened from as it was', () => {
    const dir = folderWith({ '.env.test': 'A=1\n' });
    const file = EnvFile.open(join(dir, '.env.test'));
    file.set('A', '2');
    file.write(join(dir, '.env.copy'));
    expect(readFileSync(join(dir, '.env.test'), 'utf8')).toBe('A=1\n');
    expect(readFileSync(join(dir, '.env.copy'), 'utf8')).toBe('A=2\n');
    expect(statSync(join(dir, '.env.copy')).mode & 0o777).toBe(0o600);
  });
  it('refuses to write a file that has no path, and a file that was made from a text and has none', () => {
    const error = errorOf(() => EnvFile.fromExample('A=1\n').write());
    expect(error.reason).toBe('path');
    const dir = folderWith();
    EnvFile.fromExample('A=1\n').write(join(dir, '.env.out'));
    expect(readFileSync(join(dir, '.env.out'), 'utf8')).toBe('A=1\n');
  });
  it('refuses to replace a folder or a link, and replaces a regular file', () => {
    const dir = folderWith({ 'real.env': 'A=1\n' });
    mkdirSync(join(dir, 'folder.env'));
    symlinkSync(join(dir, 'real.env'), join(dir, 'link.env'));
    for (const name of ['folder.env', 'link.env']) {
      const error = errorOf(() => EnvFile.fromExample('A=2\n').write(join(dir, name)));
      expect(error.reason, name).toBe('path');
    }
    expect(readFileSync(join(dir, 'real.env'), 'utf8')).toBe('A=1\n');
    EnvFile.fromExample('A=2\n').write(join(dir, 'real.env'));
    expect(readFileSync(join(dir, 'real.env'), 'utf8')).toBe('A=2\n');
  });
  it('refuses to write a file that it could not read again, and leaves the old file as it was', () => {
    const dir = folderWith({ '.env.test': 'A=1\n' });
    const file = EnvFile.open(join(dir, '.env.test'));
    file.set('BIG', 'x'.repeat(1_048_577));
    const error = errorOf(() => file.write());
    expect(error.reason).toBe('write');
    expect(error.message).toMatch(/too long/);
    expect(readFileSync(join(dir, '.env.test'), 'utf8')).toBe('A=1\n');
    expect(readdirSyncOf(dir)).toEqual(['.env.test']);
  });
  it('reads again what it wrote: the names, the values and the order', () => {
    const dir = folderWith({ '.env.test': EXAMPLE });
    const path = join(dir, '.env.test');
    const file = EnvFile.open(path);
    file.set('SUPPLIER_PRIV_KEY_HEX', SECRET);
    file.set('SERVICE_AUTH_HEADER', `Bearer ${SECRET}`);
    file.set('AGENT_DID', 'did:vector:abc');
    file.write();
    const again = EnvFile.open(path);
    expect(again.names()).toEqual(file.names());
    for (const name of file.names()) expect(again.get(name), name).toBe(file.get(name));
    expect(again.get('SUPPLIER_PRIV_KEY_HEX')).toBe(SECRET);
  });
});

/** The names in a folder, sorted. */
function readdirSyncOf(dir: string): string[] {
  return readdirSync(dir).sort();
}

