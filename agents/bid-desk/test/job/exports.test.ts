// agents/bid-desk/test/job/exports.test.ts: the public surface of the folder, and its place in the package. The service wires the names below. The folder imports the kit, the workspace packages and itself, and no
// other folder of the package: the hook and the server are other folders, and the service imports the job, so an import of the hook or of the server would join folders that the design keeps apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as job from '../../src/job/index.ts';
import { faultyPriceOf } from '../../src/job/fault.ts';
import { QUOTE_DECISION } from '../../src/job/decision.ts';
import { QUOTE_REFUSAL_STATUS, QuoteRefusal } from '../../src/job/refusal.ts';
import { RUNTIME_MARGIN_MS } from '../../src/job/quote.ts';

const FOLDER = fileURLToPath(new URL('../../src/job/', import.meta.url));
const files = readdirSync(FOLDER).filter((name) => name.endsWith('.ts')).sort();
const specifiersOf = (file: string): string[] => [...readFileSync(join(FOLDER, file), 'utf8').matchAll(/^(?:import|export)\b[^;]*?\bfrom '([^']+)'/gm)].map((match) => match[1]!);

describe('the folder of the job', () => {
  it('exports the names that the service wires, and no other value', () => {
    expect(Object.keys(job).sort()).toEqual(['QUOTE_DECISION', 'QUOTE_REFUSAL_STATUS', 'QuoteRefusal', 'RUNTIME_MARGIN_MS', 'faultyPriceOf', 'quoteInput', 'runQuote']);
  });

  it('exports the values of the files that hold them, and the decision has the name quote', () => {
    expect(job.faultyPriceOf).toBe(faultyPriceOf);
    expect(job.QUOTE_DECISION).toBe(QUOTE_DECISION);
    expect(job.QuoteRefusal).toBe(QuoteRefusal);
    expect(job.QUOTE_REFUSAL_STATUS).toBe(QUOTE_REFUSAL_STATUS);
    expect(job.RUNTIME_MARGIN_MS).toBe(RUNTIME_MARGIN_MS);
    expect(job.QUOTE_DECISION.name).toBe('quote');
  });

  it('has the six files of the design, and each imports only a file of its own folder, a workspace package or a module of node', () => {
    expect(files).toEqual(['decision.ts', 'fault.ts', 'index.ts', 'ports.ts', 'quote.ts', 'refusal.ts']);
    for (const file of files) {
      for (const specifier of specifiersOf(file)) {
        expect(/^(?:\.\/[a-z]+\.ts|node:[a-z/]+|@vsa\/[a-z-]+(?:\/[a-z-]+)?)$/.test(specifier), `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('imports no other folder of the package: no path that leaves the folder, and no import of the hook or of the server by name', () => {
    for (const file of files) {
      const specifiers = specifiersOf(file);
      expect(specifiers.filter((specifier) => specifier.includes('..')), file).toEqual([]);
      expect(specifiers.filter((specifier) => /\/(?:checks|serve)\//.test(specifier) && !specifier.startsWith('@vsa/')), file).toEqual([]);
    }
  });

  it('takes no environment variable and no file: the job reads nothing but its ports', () => {
    for (const file of files) {
      const text = readFileSync(join(FOLDER, file), 'utf8');
      expect(text, file).not.toMatch(/process\.env|\bfrom 'node:(?:fs|fs\/promises|child_process|net|http|https|tls)'/);
    }
  });

  it('calls no mock system and takes no approval: it imports no part of the kit that does', () => {
    for (const file of files) {
      expect(specifiersOf(file).filter((specifier) => /^@vsa\/usecase-kit\/(?:access|buyer|dispute|cosign|janitor|live)$/.test(specifier)), file).toEqual([]);
    }
  });
});
