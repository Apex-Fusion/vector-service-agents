// packages/service-kit/test/time.test.ts
import { describe, test, expect } from 'vitest';
import { OutOfTime, within } from '../src/time.ts';

describe('within', () => {
  test('resolves with what the work resolves with, when it answers in time', async () => {
    await expect(within(Promise.resolve('answered'), 1000)).resolves.toBe('answered');
  });
  test('rejects with what the work rejects with, the same object, when it fails in time', async () => {
    const failure = new Error('the work failed');
    await expect(within(Promise.reject(failure), 1000)).rejects.toBe(failure);
  });
  test('rejects with OutOfTime when the work has not answered in time, and an answer it gives later changes nothing', async () => {
    let answer = (_value: string): void => undefined;
    const late = new Promise<string>((resolve) => { answer = resolve; });
    const bounded = within(late, 20);
    await expect(bounded).rejects.toBeInstanceOf(OutOfTime);
    await expect(bounded).rejects.toThrow('no answer within 20 ms');
    answer('too late');
    await expect(bounded).rejects.toBeInstanceOf(OutOfTime);
  });
});
