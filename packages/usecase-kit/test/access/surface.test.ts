// packages/usecase-kit/test/access/surface.test.ts: the folder is a subpath, it names what it exports, and its code reads no key file, no environment variable and no log: a key or a token has no way out.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as byName from '@vsa/usecase-kit/access';
import * as byPath from '../../src/access/index.ts';

const SRC = fileURLToPath(new URL('../../src/access/', import.meta.url));

describe('the folder', () => {
  it('is the subpath @vsa/usecase-kit/access, with the values that it exports and no others', () => {
    expect(byName.withSubDelegation).toBe(byPath.withSubDelegation);
    expect(Object.keys(byName).sort()).toStrictEqual(
      [
        'CONFIRMATIONS_REQUIRED', 'DEFAULT_CALL_TIMEOUT_MS', 'DEFAULT_CONFIRMATION_WAIT_MS', 'DEFAULT_END_TIMEOUT_MS', 'DEFAULT_LANDING_WAIT_MS', 'DEFAULT_MAX_ANSWER_BYTES', 'DEFAULT_POLL_MS',
        'DEFAULT_STEP_TIMEOUT_MS', 'GATEWAY_FAILURES', 'JwtSvidCredential', 'MAX_CODE_CHARS', 'MAX_COLLATERAL_LOVELACE', 'MAX_DELEGATION_DEPOSIT_LOVELACE', 'MAX_SUB_DELEGATION_MS', 'MAX_TX_FEE_LOVELACE',
        'MIN_SUB_DELEGATION_MS', 'REFUSAL_WITHOUT_CODE', 'ROUTES', 'RouteToken', 'SUB_DELEGATION_FAILURES', 'SYSTEMS', 'X509SvidCredential', 'askWhileTooYoung', 'callWithJwtSvid', 'callWithToken',
        'callWithX509Svid', 'codeIn', 'createSerialQueue', 'fetchJwtSvid', 'fetchX509Svid', 'httpsTransport', 'jwtSvidTarget', 'readAnswer', 'requestRouteToken', 'requestSubagentToken', 'systemClock',
        'tokenTarget', 'txSignerOfRawKey', 'withSubDelegation', 'within', 'x509Target',
      ].sort(),
    );
  });

  it('exports no file by itself: the helpers of text and of the gateway failures stay inside', () => {
    expect(Object.keys(byName)).not.toContain('safeText');
    expect(Object.keys(byName)).not.toContain('errorText');
    expect(Object.keys(byName)).not.toContain('gatewayFailure');
  });
});

describe('the code of the folder', () => {
  const files = readdirSync(SRC).filter((name) => name.endsWith('.ts'));

  it('has one file for each part', () => {
    expect(files.sort()).toStrictEqual(['answer.ts', 'call.ts', 'gateway.ts', 'index.ts', 'mtls.ts', 'ports.ts', 'queue.ts', 'routes.ts', 'signer.ts', 'subdelegation.ts', 'svid.ts', 'text.ts', 'token.ts', 'txcheck.ts', 'url.ts']);
  });

  it.each(files)('%s reads no environment variable, no file and no stream of the process, and writes no log line', (name) => {
    const code = readFileSync(join(SRC, name), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**'))
      .join('\n');
    expect(code).not.toMatch(/process\.(env|stdout|stderr|argv)/);
    expect(code).not.toMatch(/from 'node:(fs|fs\/promises|os|child_process)'|require\(/);
    expect(code).not.toMatch(/\bconsole\./);
  });

  it('uses the clock of the process in one place only: the system clock of the ports file', () => {
    const using = files.filter((name) => /Date\.now\(\)|setTimeout\(/.test(readFileSync(join(SRC, name), 'utf8')));
    expect(using).toStrictEqual(['ports.ts']);
  });
});
