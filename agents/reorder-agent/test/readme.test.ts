// agents/reorder-agent/test/readme.test.ts
// The README names every setting the service reads, every code it answers with, and the numbers of its jobs. These tests keep the page and the code from parting: a setting that the code reads and the table does
// not name fails, so does a name in the table that no code reads, a code with the wrong status, and a number that is not the code's.
import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { HEARTBEAT_MS, MAX_BODY, RESERVATION_MS, SHUTDOWN_WAIT_MS } from '@vsa/service-kit';
import { COSIGN_STATUS } from '@vsa/usecase-kit/cosign';
import { INVENTORY_CAPABILITIES } from '@vsa/usecase-kit/inventory';
import { ERROR_STATUS, checkRequestSize } from '@vsa/usecase-kit/protocol';
import { DESCRIPTION } from '../src/serve/manifest.ts';
import {
  BUYER_BOND_LOVELACE, GATEWAY_DEFAULT, HOST_DEFAULT, JOB_DEADLINE_MS, MIN_PROCESSING_WINDOW_MS, PORT_DEFAULT, PRICE_DEFAULT_LOVELACE, STATE_DIR_DEFAULT, SUPPLIER_BOND_LOVELACE,
} from '../src/serve/settings.ts';
import { JANITOR_INTERVAL_MS, JANITOR_STOP_WAIT_MS, SETTINGS, loadConfig } from '../src/serve/start.ts';
import { STATE_FILES } from '../src/serve/wiring.ts';
import { completeEnv, messageOf } from './serve/support.ts';

const root = new URL('../../../', import.meta.url);
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const template = readFileSync(new URL('../agent.json.template', import.meta.url), 'utf8');
const manifest = JSON.parse(template) as { version: string; status: { chip: string; since: string } };
const section = (heading: string): string => (readme.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const ticks = (text: string): string[] => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cellsOf = (line: string): string[] => line.split('|').slice(1, -1).map((cell) => cell.trim());
const settingsRows = (): string[][] => section('Settings').split('\n').filter((line) => /^\| `/.test(line)).map(cellsOf);
const defaultOf = (name: string): string => settingsRows().find(([names]) => ticks(names).includes(name))?.[2] ?? '';
/** The rows of a table of the Errors section: the statuses of the row, and the codes in backticks of its second cell. */
const codeRows = (text: string): Array<{ statuses: number[]; codes: string[] }> =>
  text.split('\n').filter((line) => /^\| \d/.test(line)).map(cellsOf).map(([status, cell]) => ({ statuses: status.split(', ').map(Number), codes: ticks(cell).filter((code) => /^[a-z_]+$/.test(code)) }));

describe('agents/reorder-agent/README.md', () => {
  test('line 3 is the capability sentence of the manifest and the capability id', () => {
    expect(readme.split('\n')[2]).toBe(`${DESCRIPTION} Capability \`${INVENTORY_CAPABILITIES.reorder}\`.`);
  });

  test('the Settings table names exactly the settings the service reads, each one time', () => {
    const documented = settingsRows().flatMap(([names]) => ticks(names)).sort();
    expect(documented).toStrictEqual([...SETTINGS].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  test('the defaults of the table are the code and the manifest', () => {
    expect(defaultOf('PORT')).toBe(`\`${PORT_DEFAULT}\`, \`${HOST_DEFAULT}\``);
    expect(defaultOf('HOST')).toBe(defaultOf('PORT'));
    expect(defaultOf('REORDER_STATE_DIR')).toBe(`\`${STATE_DIR_DEFAULT}\``);
    expect(defaultOf('IDENTITY_GATEWAY_URL')).toBe(`\`${GATEWAY_DEFAULT}\``);
    expect(defaultOf('ADVERT_PRICE_LOVELACE')).toBe(`\`${PRICE_DEFAULT_LOVELACE}\``);
    expect(defaultOf('ADVERT_MAX_PROCESSING_MS')).toBe(`\`${MIN_PROCESSING_WINDOW_MS}\``);
    expect(defaultOf('AGENT_VERSION')).toBe(`\`${manifest.version}\``);
    expect(defaultOf('AGENT_STATUS_CHIP')).toBe(`\`${manifest.status.chip}\``);
    expect(defaultOf('AGENT_STATUS_SINCE')).toBe(`\`${manifest.status.since}\``);
  });

  test('each setting that the table calls required stops the start when it is missing, a key hash is optional and checked when it is set, and the complete environment is the twin', () => {
    expect(() => loadConfig(completeEnv())).not.toThrow();
    const required = settingsRows().filter(([, , standard]) => standard === 'none. Required').flatMap(([names]) => ticks(names));
    expect(required.length).toBeGreaterThan(20);
    for (const name of required) expect(() => loadConfig(completeEnv({ [name]: undefined })), name).toThrow();
    const keyRows = settingsRows().filter(([, , standard]) => standard === 'none. The key is required; the key hash is derived when it is not set');
    expect(keyRows).toHaveLength(5);
    for (const [names] of keyRows) {
      const [key, pkh] = ticks(names);
      expect(() => loadConfig(completeEnv({ [key]: undefined })), key).toThrow();
      expect(() => loadConfig(completeEnv({ [pkh]: undefined })), pkh).not.toThrow();
      expect(() => loadConfig(completeEnv({ [pkh]: '0'.repeat(56) })), pkh).toThrow();
    }
  });

  test('the Errors tables give each code its status, as the kit has it', () => {
    const [job, cosign] = section('Errors').split('The co-sign route has its own codes:');
    // The three codes that the shared server answers with itself are not in the table of the protocol.
    const serverOwn: Record<string, number> = { bad_context: 400, shutting_down: 503, internal: 500 };
    const jobRows = codeRows(job);
    expect(jobRows.flatMap((row) => row.codes).length).toBeGreaterThan(15);
    for (const { statuses, codes } of jobRows) for (const code of codes) expect([code, statuses], code).toStrictEqual([code, [(ERROR_STATUS as Record<string, number>)[code] ?? serverOwn[code]]]);
    const cosignRows = codeRows(cosign);
    expect(cosignRows.flatMap((row) => row.codes).sort()).toStrictEqual(Object.keys(COSIGN_STATUS).sort());
    for (const { statuses, codes } of cosignRows) for (const code of codes) expect(statuses, code).toContain((COSIGN_STATUS as Record<string, number>)[code]);
  });

  test('the numbers of Routes, Stopping, State and Settings are the code', () => {
    const routes = section('Routes');
    expect(routes).toContain(`${MAX_BODY} bytes`);
    expect(checkRequestSize('x'.repeat(900_000)).ok).toBe(true);
    expect(checkRequestSize('x'.repeat(900_001)).ok).toBe(false);
    expect(routes).toContain('900000 bytes');
    expect(routes).toContain(`for ${RESERVATION_MS / 1000} s`);
    expect(routes).toContain(`every ${HEARTBEAT_MS / 1000} s`);
    expect(routes).toContain(`${JOB_DEADLINE_MS} ms`);
    expect(routes).toContain(`${JOB_DEADLINE_MS + 60_000} ms`);
    expect(routes).toContain(`${MIN_PROCESSING_WINDOW_MS} ms`);
    expect(section('Stopping')).toContain(`up to ${SHUTDOWN_WAIT_MS / 1000} s`);
    expect(section('Stopping')).toContain(`after ${JANITOR_STOP_WAIT_MS / 1000} s`);
    expect(section('State')).toContain(`every ${JANITOR_INTERVAL_MS / 1000} s`);
    expect(PRICE_DEFAULT_LOVELACE + SUPPLIER_BOND_LOVELACE + BUYER_BOND_LOVELACE).toBe(5_000_000);
    expect(section('Settings')).toContain(`each bond is ${SUPPLIER_BOND_LOVELACE} lovelace, and the lock is 5000000 lovelace`);
    expect(BUYER_BOND_LOVELACE).toBe(SUPPLIER_BOND_LOVELACE);
  });

  test('the State table names the files and folders that the wiring keeps', () => {
    const paths = section('State').split('\n').filter((line) => /^\| `/.test(line)).map((line) => ticks(cellsOf(line)[0])[0]);
    expect(paths).toStrictEqual(['keys/<key hash>/stranded.json', `${STATE_FILES.dispute}/`, `${STATE_FILES.left}/`, STATE_FILES.register, STATE_FILES.counter]);
  });

  test('the placeholders of the template are named in the README and are settings', () => {
    const placeholders = [...new Set([...template.matchAll(/<([A-Z0-9_]+)>/g)].map((m) => m[1]))].sort();
    expect(placeholders.length).toBe(7);
    for (const name of placeholders) {
      expect(readme, name).toContain(`\`<${name}>\``);
      expect(SETTINGS as readonly string[], name).toContain(name);
    }
  });

  test('the fetch of the start is named, the files the page points at exist, and the Image section says what the Dockerfile says', () => {
    expect(readme).toContain('`VECTOR_MODULE1_MANIFEST` must be an `https://` address with a path segment of 40 lowercase hex characters');
    for (const path of ['agents/reorder-agent/Dockerfile', 'agents/reorder-agent/src/index.ts', 'agents/reorder-agent/test/serve/child-fetch.mjs', 'agents/reorder-agent/test/dockerfile.test.ts', 'agents/reorder-agent/test/readme.test.ts', 'packages/usecase-kit/src/protocol']) {
      expect(existsSync(new URL(path, root)), path).toBe(true);
    }
    const image = section('Image');
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(image).toContain(`listens on ${PORT_DEFAULT}`);
    expect(dockerfile).toContain(`EXPOSE ${PORT_DEFAULT}`);
    expect(image).toContain('docker build -f agents/reorder-agent/Dockerfile -t vsa/reorder-agent:dev .');
    for (const word of ['tini', 'node:22-bookworm-slim', '/data']) expect([word, image.includes(word), dockerfile.includes(word)]).toStrictEqual([word, true, true]);
  });
});
