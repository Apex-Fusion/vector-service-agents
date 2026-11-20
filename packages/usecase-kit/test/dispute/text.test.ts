// packages/usecase-kit/test/dispute/text.test.ts: the text of a failure as it goes into a detail or a log line. It never repeats a URL, never holds a control character, and is short.
import { describe, expect, it } from 'vitest';
import { describeError } from '../../src/dispute/text.ts';

describe('the text of a failure', () => {
  it('is the message of an error', () => {
    expect(describeError(new Error('the node did not answer'))).toBe('the node did not answer');
    expect(describeError('a plain text')).toBe('a plain text');
  });

  it('replaces every URL, because an operator can put a key into a URL', () => {
    expect(describeError(new Error('failed at https://node.example/v1?key=zq9 and at http://other.example/x'))).toBe('failed at [url] and at [url]');
  });

  it('shows a control character and a character outside ASCII as a question mark', () => {
    expect(describeError(new Error('line\nbreak\u0000 and \u00e9'))).toBe('line?break? and ?');
  });

  it('is cut at 300 characters', () => {
    expect(describeError(new Error('x'.repeat(1000))).length).toBe(300);
    expect(describeError(new Error('x'.repeat(300))).length).toBe(300);
    expect(describeError(new Error('x'.repeat(299))).length).toBe(299);
  });

  it('never reads the message of a value that is not an error or a text', () => {
    const hostile = { message: 'zq9 secret', toString: () => 'zq9 secret' };
    expect(describeError(hostile)).toBe('an error with no message');
    expect(describeError(undefined)).toBe('an error with no message');
    expect(describeError(null)).toBe('an error with no message');
  });
});
