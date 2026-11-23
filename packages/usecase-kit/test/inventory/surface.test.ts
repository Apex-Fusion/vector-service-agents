// packages/usecase-kit/test/inventory/surface.test.ts: the folder is the subpath `@vsa/usecase-kit/inventory`, and it has the shape that the package asks of a folder: it imports the protocol folder and no other
// folder, it reads no key file and no environment variable, and it opens no connection. It loads with vitest, with Node type stripping and with tsx, so that no type is imported as a value.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/inventory';
import * as byPath from '../../src/inventory/index.ts';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const FOLDER = join(PACKAGE, 'src', 'inventory');
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts'));

/** Runs Node in the package folder and returns what it prints. The flag for type stripping is in the arguments, so that a Node 22 version before 22.18 runs a .ts file too. */
function node(args: readonly string[]): string {
  return execFileSync(process.execPath, ['--no-warnings', ...args], { cwd: PACKAGE, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const NAMES = [
  'CONFIRMATION_CHECKS', 'CONFIRMATION_SCHEMA', 'INVENTORY_CAPABILITIES', 'LOTS_SCHEMA', 'LOT_NAMES', 'ORDER_DESK_CLAIM', 'PO_SCHEMA', 'REORDER_CLAIM', 'isLotName', 'lotSizeOf', 'lotsFileSha256',
  'parseLotsFile', 'parseOrderConfirmation', 'parsePurchaseOrder', 'poNumberOf',
];

describe('the subpath @vsa/usecase-kit/inventory', () => {
  it('is the folder src/inventory, and it exports these values and no other', () => {
    expect(byName.parsePurchaseOrder).toBe(byPath.parsePurchaseOrder);
    expect(Object.keys(byName).sort()).toStrictEqual(NAMES);
  });

  it('exports the helpers of the field rules to no one: they stay inside the folder', () => {
    for (const name of ['parseId', 'parseQuantity', 'parseDay', 'nfc', 'valuesOf', 'MAX_QUANTITY']) expect(Object.keys(byName), name).not.toContain(name);
  });

  it('loads with Node type stripping and with tsx, and gives the same names', () => {
    // The folder is loaded in a new Node process on purpose: the test exercises the loading boundary, so a static import of vitest cannot stand in for it.
    const script = "const m = await import('@vsa/usecase-kit/inventory'); console.log(Object.keys(m).sort().join(','));";
    expect(node(['--experimental-strip-types', '--input-type=module', '-e', script])).toBe(NAMES.join(','));
    expect(node(['--import', 'tsx', '--input-type=module', '-e', script])).toBe(NAMES.join(','));
  }, 60_000);
});

describe('the files of the folder', () => {
  it('are one file for each part', () => {
    expect([...files].sort()).toStrictEqual(['claims.ts', 'confirmation.ts', 'index.ts', 'lots.ts', 'order.ts']);
  });

  it.each(files)('%s imports the protocol folder, the files of this folder and the hash module of Node, and no other folder of the package', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s+'([^']+)'/g)) {
      const specifier = match[1]!;
      const allowed = specifier.startsWith('./') || specifier === '../protocol/index.ts' || specifier === 'node:crypto';
      expect(allowed, `${name} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files)('%s reads no environment variable and no file, makes no connection, and does not read the clock', (name) => {
    const text = readFileSync(join(FOLDER, name), 'utf8');
    for (const forbidden of ['process.env', 'node:fs', 'readFileSync', 'writeFileSync', 'node:child_process', 'node:http', 'node:https', 'node:net', 'node:dns', 'fetch(', 'Date.now', 'new Date()', 'Math.random']) {
      expect(text.includes(forbidden), `${name} uses ${forbidden}`).toBe(false);
    }
  });
});
