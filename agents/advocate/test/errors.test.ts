// agents/advocate/test/errors.test.ts
// The failures of a job: each code has its status, the buyer reads the kit's fixed text for the code, and the detail is the log's alone.
import { describe, expect, test } from 'vitest';
import { operatorsText } from '@vsa/service-kit';
import { AdvocateError, JOB_STATUS } from '../src/errors.ts';
import type { JobCode } from '../src/errors.ts';

describe('AdvocateError', () => {
  test('deadline is 422, aborted 499, and every other code 502', () => {
    expect(JOB_STATUS).toStrictEqual({
      search_failed: 502, search_empty: 502, no_sources: 502, model_failed: 502, model_output_invalid: 502, no_supported_claims: 502, deadline: 422, aborted: 499,
    });
  });

  test('the message is the fixed text of the kit for the code, the detail stands apart for the log, and the status is the code\'s', () => {
    for (const code of Object.keys(JOB_STATUS) as JobCode[]) {
      const e = new AdvocateError(code, `what happened (${code})`);
      expect([e instanceof Error, e.name, e.code, e.status, e.message, e.detail]).toStrictEqual([true, 'AdvocateError', code, JOB_STATUS[code], operatorsText(code), `what happened (${code})`]);
    }
    expect(new AdvocateError('search_failed', 'both Brave queries failed').message).toBe("The service could not do this job (search_failed). The operator's log has the detail.");
  });
});
