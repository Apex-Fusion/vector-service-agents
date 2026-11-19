// The checks reach the packages through lib/platform.ts, and the hire kit through lib/hire-adapter.ts. This test loads platform, so that a package that moves a file or drops a name is found here.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as platform from '../lib/platform.ts';

const LIB = fileURLToPath(new URL('../lib/', import.meta.url));

describe('platform', () => {
  it('gives each name that a check calls', () => {
    for (const name of [
      'OgmiosProvider', 'lucidForAddress', 'signTransaction', 'rawHexToBech32', 'enterpriseAddressOf', 'buildDelegate', 'buildUndelegate', 'buildVaultOpen', 'buildVaultClose', 'buildVaultPay',
      'buildAttest', 'buildWithdrawAttestation', 'buildAccept', 'buildReclaim', 'identityDeploymentFrom', 'makeIdentityDeployment', 'decodeTransaction', 'createGatewayClient', 'createVerifier',
      'presentToken', 'keyHashOf', 'TxNotConfirmedError', 'AcceptWindowClosedError', 'VaultPayRefused', 'VaultPayNotEvaluated', 'VaultPayImpossible',
    ]) {
      expect(typeof (platform as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(platform.HIRE_ACTION).toBe('marketplace.hire.v1');
    expect(platform.ATT_TYPES.approval).toBe(5);
    expect(platform.ATT_TYPES.principal_binding).toBe(4);
  });

  it('is, with hire-adapter.ts, the only place in lib that names a package by its path: the hire kit is used in that one file', () => {
    const others = readdirSync(LIB).filter((file) => file.endsWith('.ts') && file !== 'platform.ts');
    const reaching = others.filter((file) => /['"][./]*\/?packages\/[^'"]*['"]/.test(readFileSync(join(LIB, file), 'utf8')));
    expect(reaching).toEqual(['hire-adapter.ts']);
    const kit = others.filter((file) => /packages\/hire-kit\//.test(readFileSync(join(LIB, file), 'utf8')));
    expect(kit).toEqual(['hire-adapter.ts']);
  });
});
