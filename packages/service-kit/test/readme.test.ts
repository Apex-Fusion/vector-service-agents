// packages/service-kit/test/readme.test.ts
// The README of the kit says what the code does. A name, a code or a time in it that the code does not match fails here. The package exports are held here too:
// they are what a service and its tests import.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { CONTEXT_HEADERS } from '../src/context.ts';
import * as kit from '../src/index.ts';
import { SHUTDOWN_WAIT_MS } from '../src/lifecycle.ts';
import { BUSY_TEXT, HEARTBEAT_MS, STOPPING_TEXT } from '../src/server.ts';
import { RESERVATION_MS } from '../src/slot.ts';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
/** The README cut at its headings of the second level: the text under a heading, by the heading. */
const section = (heading: string): string => {
  const start = README.indexOf(`\n## ${heading}\n`);
  expect(start, `the heading ${heading}`).toBeGreaterThan(-1);
  const next = README.indexOf('\n## ', start + 1);
  return README.slice(start, next === -1 ? undefined : next);
};

describe('the README of the kit', () => {
  test('the routes: the table has the pre-check, and the pre-check section gives the call with the six headers, in the order of the code', () => {
    expect(section('Routes')).toContain('| `POST /precheck` | the runtime |');
    const call = section('The pre-check').split('```text\n')[1]?.split('```')[0] ?? '';
    expect(call, 'the call is in a block of text').toContain('POST /precheck HTTP/1.1');
    const named = call.split('\n').filter((line) => line.startsWith('x-vector-')).map((line) => line.slice(0, line.indexOf(':')));
    expect(named).toStrictEqual(Object.values(CONTEXT_HEADERS));
  });

  test('the table of the context has each header and each field once, in the order of the code', () => {
    const rows = section('The job context').split('\n').filter((line) => line.startsWith('| `x-vector-'));
    expect(rows.map((row) => row.split('|')[1].trim())).toStrictEqual(Object.values(CONTEXT_HEADERS).map((name) => `\`${name}\``));
    expect(rows.map((row) => /^`(\w+)/.exec(row.split('|')[2].trim())?.[1])).toStrictEqual(Object.keys(CONTEXT_HEADERS));
  });

  test('the times are the times of the code: the reservation, the interim line and the stop', () => {
    const timing = section('The timing');
    expect(timing).toContain(`${RESERVATION_MS / 1000} seconds (\`RESERVATION_MS\`)`);
    expect(timing).toContain(`every ${HEARTBEAT_MS / 1000} seconds (\`HEARTBEAT_MS\`)`);
    expect(timing).toContain(`up to ${SHUTDOWN_WAIT_MS / 1000} seconds (\`SHUTDOWN_WAIT_MS\`)`);
    expect(section('The pre-check')).toContain(`\`{"go": true, "reserved_ms": ${RESERVATION_MS}}\``);
    expect(section('The job slot and the reservation')).toContain(`${RESERVATION_MS / 1000} seconds`);
  });

  test('the answers: each status and code that the pre-check gives is in the table', () => {
    const answers = section('The pre-check').split('### The answers')[1]?.split('### The option')[0] ?? '';
    for (const code of ['bad_context', 'bad_wire', 'request_too_large', 'unauthorized', 'busy', 'shutting_down', 'internal']) expect(answers, code).toContain(code);
    for (const status of ['| 200 |', '| 400 |', '| 401 |', '| 409 |', '| 503 |', '| 500 |']) expect(answers, status).toContain(status);
    expect(BUSY_TEXT).toBe('The service is working on another job. Try again shortly.');
    expect(STOPPING_TEXT).toBe('The service is stopping and takes no new job. Try again shortly.');
  });
});

describe('the package exports', () => {
  test('a service and its tests import the pre-check names from the package', () => {
    expect(Object.keys(kit)).toEqual(expect.arrayContaining(['BUSY_TEXT', 'CONTEXT_HEADERS', 'JobSlot', 'RESERVATION_MS', 'STOPPING_TEXT', 'createJobServer']));
    expect(kit.RESERVATION_MS).toBe(120_000);
    expect(kit.CONTEXT_HEADERS).toBe(CONTEXT_HEADERS);
    expect(kit.BUSY_TEXT).toBe(BUSY_TEXT);
  });
});
