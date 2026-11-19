// packages/id-kit/test/public-api.test.ts: the root entry names the two shapes of a status reading, so that a service can type what it logs. The typecheck is the test: it fails when the
// entry does not export the names.
import { describe, expect, it } from 'vitest';
import type { StatusNotRead, StatusRead } from '../src/index.ts';

describe('the root entry', () => {
  it('names StatusRead and StatusNotRead', () => {
    const read: StatusRead = { read: true, list: 'https://id.example/status/tsl/0', fetchedAt: 2, issuedAt: 1 };
    const notRead: StatusNotRead = { read: false, list: 'https://id.example/status/tsl/0', reason: 'stale', detail: 'a new read failed', issuedAt: 1 };
    expect([read.read, notRead.read]).toStrictEqual([true, false]);
  });
});
