// packages/id-kit/test/no-ambient-input.test.ts: the package reads no key file and no environment variable, and it opens no socket of its own. A caller gives each key as a key object or
// as a sign function, and the `fetch` function for each call. This test reads every file under src/ and refuses a file that reads the environment, the file system or the network.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';

const src = fileURLToPath(new URL('../src/', import.meta.url));

/** A read of the environment, an import of a module that reads files, runs a program or opens a socket, a `require`, or a runtime object that holds the environment. */
const AMBIENT = /\bprocess\s*(?:\.\s*env\b|\[\s*['"`]env['"`]\s*\])|\bimport\.meta\.env\b|\b(?:Bun|Deno)\b\s*\.|\brequire\s*\(|\bfrom\s+['"](?:node:)?(?:fs|fs\/promises|child_process|os|net|tls|dns|http|https|http2|worker_threads|cluster)['"]|\bimport\s*\(\s*['"](?:node:)?(?:fs|child_process|os|net|http|https)/;

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => join(dir, p.split(sep).join('/')))
    .filter((p) => statSync(p).isFile() && p.endsWith('.ts'));

describe('no ambient input', () => {
  it('the guard flags a read of the environment, the file system, a program or a socket, and lets the rest pass', () => {
    const flagged = [
      'const k = process.env.GATEWAY_KEY;',
      "const k = process['env'].KEY;",
      'const k = process . env . KEY;',
      "import { readFileSync } from 'node:fs';",
      'import fs from "fs";',
      "import { readFile } from 'node:fs/promises';",
      "import { execSync } from 'node:child_process';",
      "import { createServer } from 'node:http';",
      "import { connect } from 'node:net';",
      "const x = require('node:fs');",
      'const key = Bun.env.KEY;',
      "const fs = await import('node:fs');",
    ];
    for (const line of flagged) expect(AMBIENT.test(line), line).toBe(true);
    const passed = [
      "import { createHash, sign } from 'node:crypto';",
      "import { deflateSync } from 'node:zlib';",
      "import { fileURLToPath } from 'node:url';",
      'const environment = { a: 1 };',
      '// the process env is not read here',
      "const http = options.fetch ?? globalThis.fetch;",
    ];
    for (const line of passed) expect(AMBIENT.test(line), line).toBe(false);
  });

  it('no file of the package reads the environment, the file system or the network; the scan reaches every folder of src/', () => {
    const files = filesUnder(src).map((p) => p.substring(src.length).split(sep).join('/'));
    for (const folder of ['client/', 'common/', 'testing/', 'vendored/m4/', 'verify/']) expect(files.some((f) => f.startsWith(folder)), `a file under src/${folder}`).toBe(true);
    const hits = files.filter((f) => AMBIENT.test(readFileSync(join(src, f), 'utf8')));
    expect(hits).toStrictEqual([]);
  });
});
