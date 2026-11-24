// scripts/operator/lib/envfile.ts - the editor of one env file of an agent.
// The file holds lines in the form `NAME=value`, comments, and empty lines. The editor keeps every line in its place and sets one variable at a time: a variable that the file holds is replaced
// where it stands, and a new one is appended. It writes the file whole, through a temporary file in the same folder (mode 600, every byte flushed), and renames that file over the target, so a
// failed write leaves the old file as it was. It never changes the folder. It never prints a value: `describe` gives the names and the lengths of the values, and no text that this file makes (a
// message, a string form, a description) holds a value, a path or the message of the file system (only its short error code). `get` gives a value to a caller that needs it.
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { codeOf } from './registry.ts';

export type EnvFileReason = 'unreadable' | 'not_text' | 'damaged' | 'name' | 'value' | 'path' | 'write';

export class EnvFileError extends Error {
  readonly reason: EnvFileReason;
  constructor(reason: EnvFileReason, message: string) {
    super(message);
    this.name = 'EnvFileError';
    this.reason = reason;
  }
}

/** What the editor needs from the file system. A test gives a fake for the part that it breaks. */
export interface EnvIo {
  read(path: string): Buffer;
  rename(from: string, to: string): void;
}

/** A variable of the file, as `describe` shows it: its name and the length of its value in characters. The value is not in it. */
export interface EnvVariable { readonly name: string; readonly length: number }

/** A line of the file, as it stands. A line of a variable also holds the name and the value that it reads as. */
type Line = { readonly raw: string } | { readonly raw: string; readonly name: string; readonly value: string };

/** A file that is longer than this is refused, when it is read and when it would be written, so the editor never writes a file that it could not read again. */
const MAX_BYTES = 1_048_576;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const NAME_TO_SET = /^[A-Z][A-Z0-9_]*$/;
const SHOWN_NAME = /^[A-Za-z0-9_]{1,40}$/;

const realIo: EnvIo = { read: (path) => readFileSync(path), rename: renameSync };

const damaged = (where: string, rule: string): EnvFileError => new EnvFileError('damaged', `the env file is damaged at ${where}: ${rule}`);

/** The reason that a value cannot be written, or null. The value is never part of it. */
function valueProblem(value: unknown): string | null {
  if (typeof value !== 'string') return 'is not text';
  if (/[\n\r\u2028\u2029]/.test(value)) return 'holds a line break';
  if (value.includes('\u0000')) return 'holds a NUL byte';
  if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return 'holds a control character';
  if (value.includes('"')) return 'holds a double quote, which cannot be written so that every reader reads it back as it is';
  if (value.includes('\\')) return 'holds a backslash, which cannot be written so that every reader reads it back as it is';
  if (value.includes('$')) return 'holds a dollar sign, which a reader of the file takes for a variable';
  return null;
}

/** How a value stands in a line: in double quotes when it holds white space or a number sign, or begins with a single quote, and as it is otherwise. An empty value stands as nothing. */
function render(name: string, value: string): string {
  const quoted = value !== '' && (/[\s#]/.test(value) || value.startsWith("'"));
  return `${name}=${quoted ? `"${value}"` : value}`;
}

/**
 * The value that the text after the equals sign reads as, or null when the text is damaged. A value in double quotes ends at the next quote that no backslash protects (`\"` and `\\` read as
 * a quote and a backslash), a value in single quotes ends at the next single quote, and only white space and a comment may follow. Any other value ends at the first white space that a
 * number sign follows, and it is trimmed.
 */
function valueOf(rest: string): string | null {
  const text = rest.trim();
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let end = -1;
    for (let index = 1; index < text.length; index += 1) {
      if (quote === '"' && text[index] === '\\') { index += 1; continue; }
      if (text[index] === quote) { end = index; break; }
    }
    if (end < 0) return null;
    const after = text.slice(end + 1);
    if (after !== '' && !/^\s+#/.test(after)) return null;
    const inner = text.slice(1, end);
    return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner;
  }
  const comment = text.search(/\s#/);
  return (comment < 0 ? text : text.slice(0, comment)).trim();
}

/** The lines of a text. A line that is no empty line, no comment and no assignment, a name that two lines set, and a carriage return are a damaged file. A refusal names a line by its number. */
function parse(text: string): Line[] {
  const rows = text.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  const names = new Set<string>();
  return rows.map((raw, index): Line => {
    const where = `line ${index + 1}`;
    if (raw.includes('\r')) throw damaged(where, 'it has a carriage return');
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) return { raw };
    const match = ASSIGNMENT.exec(raw);
    if (match === null) throw damaged(where, 'it is not an empty line, a comment or NAME=value');
    const [, name, rest] = match;
    const value = valueOf(rest!);
    if (value === null) throw damaged(where, 'its value has a quote that does not end, or text after the closing quote');
    if (names.has(name!)) throw damaged(where, 'it sets a name that an earlier line sets');
    names.add(name!);
    return { raw, name: name!, value };
  });
}

/** The text of a file that holds bytes: not too long, no NUL byte, and UTF-8 that is well formed. A byte order mark stays in the text, so the first line is damaged. */
function textOfBytes(bytes: Buffer): string {
  if (bytes.length > MAX_BYTES) throw new EnvFileError('damaged', `the env file is longer than ${MAX_BYTES} bytes`);
  if (bytes.includes(0)) throw new EnvFileError('not_text', 'the env file is not text: it holds a NUL byte');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    throw new EnvFileError('not_text', 'the env file is not text: it is not well formed UTF-8');
  }
}

/** Flushes a folder so that the new entry survives a crash. The rename stands whether or not it can be flushed, so a failure here is no error. */
function flushFolder(folder: string): void {
  try {
    const fd = openSync(folder, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } catch {
    // The folder cannot be flushed on this platform: the rename stands, unflushed.
  }
}

export class EnvFile {
  readonly #lines: Line[];
  readonly #path: string | null;
  readonly #io: EnvIo;

  private constructor(lines: Line[], path: string | null, io: EnvIo) {
    this.#lines = lines;
    this.#path = path;
    this.#io = io;
  }

  /** Reads an env file. The file must be there, hold well formed text with no NUL byte, and have lines of the forms above. A refusal names the rule and a line number, and shows no value and no path. */
  static open(path: string, io: Partial<EnvIo> = {}): EnvFile {
    const files: EnvIo = { ...realIo, ...io };
    let bytes: Buffer;
    try { bytes = files.read(path); } catch (err) {
      throw new EnvFileError('unreadable', codeOf(err) === 'ENOENT' ? 'the env file does not exist' : `the env file could not be read (${codeOf(err)})`);
    }
    return new EnvFile(parse(textOfBytes(bytes)), path, files);
  }

  /** Reads the text of an example file. The result has no path: `write` needs one. */
  static fromExample(text: string, io: Partial<EnvIo> = {}): EnvFile {
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text) throw new EnvFileError('not_text', 'the text of the env file is not well formed');
    return new EnvFile(parse(textOfBytes(bytes)), null, { ...realIo, ...io });
  }

  /** The names of the variables, in the order of the file. */
  names(): string[] {
    return this.#lines.flatMap((line) => ('name' in line ? [line.name] : []));
  }

  has(name: string): boolean {
    return this.#lines.some((line) => 'name' in line && line.name === name);
  }

  /** The value of a variable as a reader of the file reads it (the quotes are off), or undefined when the file does not set it. It is for the caller that needs the value: it is never printed here. */
  get(name: string): string | undefined {
    const found = this.#lines.find((line) => 'name' in line && line.name === name);
    return found !== undefined && 'name' in found ? found.value : undefined;
  }

  /**
   * Sets a variable: the line of a variable that the file holds is replaced in its place, and a new variable is appended after the last line. The name must be capital letters, digits and
   * underscores, and begin with a letter. The value must be text with no line break, no NUL byte, no other control character, no double quote, no backslash and no dollar sign. A value
   * with white space or a number sign is written in double quotes. A refusal changes nothing, and names the variable and the rule, never the value.
   */
  set(name: string, value: string): void {
    if (typeof name !== 'string' || !NAME_TO_SET.test(name)) {
      const shown = typeof name === 'string' && SHOWN_NAME.test(name) ? name : 'a name that is no variable name';
      throw new EnvFileError('name', `the name ${shown} is not an env variable name: use capital letters, digits and underscores, and begin with a letter`);
    }
    const problem = valueProblem(value);
    if (problem !== null) throw new EnvFileError('value', `the value of ${name} cannot be written: it ${problem}`);
    const line: Line = { raw: render(name, value), name, value };
    const index = this.#lines.findIndex((held) => 'name' in held && held.name === name);
    if (index >= 0) this.#lines[index] = line;
    else this.#lines.push(line);
  }

  /** The name and the length of the value of each variable, in the order of the file. A value of 0 is an empty value. No value is in the result. */
  describe(): EnvVariable[] {
    return this.#lines.flatMap((line) => ('name' in line ? [{ name: line.name, length: line.value.length }] : []));
  }

  /**
   * Writes the file: to a temporary file in the folder of the target (made new, mode 600, every byte written and flushed), and then a rename over the target. A failure at any point removes
   * the temporary file and leaves the old file as it was. The folder is not made, and its mode and its owner are not touched. The target must be a regular file or not exist: a folder and a link
   * are refused. `path` defaults to the path that the file was opened from.
   */
  write(path?: string): void {
    const target = path ?? this.#path;
    if (target === null) throw new EnvFileError('path', 'this env file was made from a text and has no path: give the path to write');
    const text = this.#lines.length === 0 ? '' : `${this.#lines.map((line) => line.raw).join('\n')}\n`;
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > MAX_BYTES) throw new EnvFileError('write', `the env file would be longer than ${MAX_BYTES} bytes, too long to read again, so it is not written`);
    let existing: Stats | undefined;
    try { existing = lstatSync(target, { throwIfNoEntry: false }); } catch (err) {
      throw new EnvFileError('write', `the env file could not be written (${codeOf(err)}), and the old file is as it was`);
    }
    if (existing !== undefined && !existing.isFile()) throw new EnvFileError('path', 'the path of the env file is not a regular file: the write replaces a file and nothing else');
    const folder = dirname(target);
    const temporary = join(folder, `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      fchmodSync(fd, 0o600);
      for (let written = 0; written < bytes.length;) {
        const n = writeSync(fd, bytes, written, bytes.length - written);
        if (n <= 0) throw new Error('the write made no progress');
        written += n;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.#io.rename(temporary, target);
    } catch (err) {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* the temporary file is removed next */ }
      }
      try { unlinkSync(temporary); } catch { /* it was not made, or it is gone */ }
      throw new EnvFileError('write', `the env file could not be written (${codeOf(err)}), and the old file is as it was`);
    }
    flushFolder(folder);
  }

  toJSON(): { names: string[] } {
    return { names: this.names() };
  }

  toString(): string {
    const count = this.names().length;
    return `an env file with ${count} variable${count === 1 ? '' : 's'}`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
