// The roles of the keys. A ring names a key with any string. A check names its keys with the three roles of a check only, so a check that names a fourth key does not compile.
// The assertions are about types: a run of the tests does nothing with them, and `tsc -p scripts/checks/tsconfig.json` checks them.
import { describe, expectTypeOf, it } from 'vitest';
import type { requireCollateral } from '../lib/collateral.ts';
import type { CheckKeyRole, KeyRing, KeyRole, LoadedKey } from '../lib/keys.ts';
import type { CheckDefinition } from '../lib/runner.ts';
import type { Session, stepPlan } from '../lib/session.ts';
import type { CommonSettings, Needs } from '../lib/settings.ts';

type Roles = 'controller' | 'agent' | 'member';

describe('the roles of the keys', () => {
  it('are any name for a key of a ring', () => {
    expectTypeOf<KeyRole>().toEqualTypeOf<string>();
    expectTypeOf<LoadedKey['role']>().toEqualTypeOf<string>();
  });
  it('are the three roles of a check in each place where a check names a key', () => {
    expectTypeOf<CheckKeyRole>().toEqualTypeOf<Roles>();
    expectTypeOf<Needs['keys'][number]>().toEqualTypeOf<Roles>();
    expectTypeOf<CommonSettings['keyFiles']>().toEqualTypeOf<Partial<Record<Roles | 'authentication', string>>>();
    expectTypeOf<CheckDefinition['needs']['keys'][number]>().toEqualTypeOf<Roles>();
    expectTypeOf<NonNullable<NonNullable<Parameters<typeof stepPlan>[1]>['outflow']>>().toEqualTypeOf<Partial<Record<Roles, bigint>>>();
    expectTypeOf<Parameters<typeof requireCollateral>[1]>().toEqualTypeOf<Roles>();
  });
  it('are checked at the ring: a check that names a fourth key through the ring does not compile, and the ring of a pack takes any name', () => {
    const askAsACheck = (ring: Session['ring']): void => {
      ring.get('member');
      ring.find('agent');
      // @ts-expect-error a misspelt role of a check is no role of a check
      ring.get('membar');
      // @ts-expect-error the name of a key of a pack is no role of a check
      ring.find('run');
    };
    const askAsAPack = (ring: KeyRing): void => {
      ring.get('run');
      ring.find('fee');
    };
    expectTypeOf<Session['ring']['get']>().parameter(0).toEqualTypeOf<Roles>();
    expectTypeOf<Session['ring']['find']>().parameter(0).toEqualTypeOf<Roles>();
    expectTypeOf<KeyRing['get']>().parameter(0).toEqualTypeOf<string>();
    expectTypeOf(askAsACheck).toBeFunction();
    expectTypeOf(askAsAPack).toBeFunction();
  });
});
