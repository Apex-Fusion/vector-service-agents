// packages/usecase-kit/test/buyer/authority.test.ts: the authority check. A delegation that exists and names another agent is refused (`delegation_not_mine`). A delegation that is not found goes
// on, because the ledger refuses the payment later. A delegation that cannot be read is neither: it is `ledger_unavailable`. After a refused Pay the flow reads the delegation again, and only a
// delegation that is gone, or whose ancestor is gone, is ended.
import { describe, expect, it } from 'vitest';
import { checkAuthority, delegationAfter, readingOf } from '@vsa/usecase-kit/buyer';
import type { DelegationReading, LedgerReads } from '@vsa/usecase-kit/buyer';
import { BUYER_DID, BUYER_ID, DELEGATION, OTHER_ID } from './support.ts';

/** A port whose delegation is `reading`, or that rejects, and that counts its reads. The vaults are not read by this check. */
function reads(reading: unknown, fail: Error | null = null): LedgerReads & { delegationReads: number } {
  const port = {
    delegationReads: 0,
    delegation: async (): Promise<DelegationReading | null> => {
      port.delegationReads += 1;
      if (fail !== null) throw fail;
      return reading as DelegationReading | null;
    },
    liveVaults: async (): Promise<never> => { throw new Error('the check must not read the vaults'); },
  };
  return port;
}

describe('checkAuthority', () => {
  it('lets a job go on when the delegation names this agent as its delegate', async () => {
    const port = reads({ delegate: BUYER_ID, chain_whole: true });
    expect(await checkAuthority(port, BUYER_DID, DELEGATION)).toStrictEqual({ ok: true, delegation: 'names_agent' });
    expect(port.delegationReads).toBe(1);
  });

  it('refuses a delegation that names another agent: delegation_not_mine, and the detail repeats neither id', async () => {
    const refused = await checkAuthority(reads({ delegate: OTHER_ID, chain_whole: true }), BUYER_DID, DELEGATION);
    expect(refused).toStrictEqual({ ok: false, code: 'delegation_not_mine', detail: 'authority.delegation names another agent as its delegate' });
    expect(JSON.stringify(refused)).not.toContain(OTHER_ID);
    expect(JSON.stringify(refused)).not.toContain(BUYER_ID);
  });

  it('refuses a delegation whose ancestor was undelegated in the same way when it names another agent, and lets it go on when it names this agent', async () => {
    expect(await checkAuthority(reads({ delegate: OTHER_ID, chain_whole: false }), BUYER_DID, DELEGATION)).toMatchObject({ ok: false, code: 'delegation_not_mine' });
    // The authority check does not judge what the delegation covers: the ledger does.
    expect(await checkAuthority(reads({ delegate: BUYER_ID, chain_whole: false }), BUYER_DID, DELEGATION)).toStrictEqual({ ok: true, delegation: 'names_agent' });
  });

  it('lets a job go on when the delegation is not found, and says so', async () => {
    expect(await checkAuthority(reads(null), BUYER_DID, DELEGATION)).toStrictEqual({ ok: true, delegation: 'not_found' });
  });

  it('does not read a delegation that cannot be read as not found: the code is ledger_unavailable, and the error text is not repeated', async () => {
    const refused = await checkAuthority(reads(null, new Error('koios answered 502 for the key SECRET-KEY-TEXT')), BUYER_DID, DELEGATION);
    expect(refused).toMatchObject({ ok: false, code: 'ledger_unavailable' });
    expect(JSON.stringify(refused)).not.toContain('SECRET-KEY-TEXT');
    // The twin: the same port with no failure finds the delegation.
    expect(await checkAuthority(reads({ delegate: BUYER_ID, chain_whole: true }), BUYER_DID, DELEGATION)).toMatchObject({ ok: true });
  });

  it('does not trust a reading of the wrong shape: it is ledger_unavailable and never "mine" or "not found"', async () => {
    const wrong: unknown[] = [undefined, 7, 'x', [], {}, { delegate: BUYER_ID }, { chain_whole: true }, { delegate: BUYER_ID, chain_whole: 'yes' }, { delegate: BUYER_ID.toUpperCase(), chain_whole: true }, { delegate: 'abc', chain_whole: true }];
    for (const reading of wrong) expect(await checkAuthority(reads(reading), BUYER_DID, DELEGATION), JSON.stringify(reading)).toMatchObject({ ok: false, code: 'ledger_unavailable' });
  });

  it('refuses an agent DID or a delegation that has not the form of the protocol, before any read', async () => {
    const port = reads({ delegate: BUYER_ID, chain_whole: true });
    expect(await checkAuthority(port, 'did:vector:abc', DELEGATION)).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(await checkAuthority(port, BUYER_DID, 'not a delegation')).toMatchObject({ ok: false, code: 'bad_shape' });
    expect(port.delegationReads).toBe(0);
    expect(await checkAuthority(port, BUYER_DID, DELEGATION)).toMatchObject({ ok: true });
  });
});

describe('readingOf', () => {
  it('takes null and a reading of the right shape, and gives a new object', () => {
    expect(readingOf(null)).toStrictEqual({ ok: true, value: null });
    const given = { delegate: BUYER_ID, chain_whole: false, extra: 1 };
    const read = readingOf(given);
    expect(read).toStrictEqual({ ok: true, value: { delegate: BUYER_ID, chain_whole: false } });
    expect(read.ok && read.value).not.toBe(given);
  });
});

describe('delegationAfter', () => {
  it('says ended for a delegation that is gone, and for one whose ancestor is gone; and live for one that stands', async () => {
    expect(await delegationAfter(reads(null), DELEGATION)).toBe('ended');
    expect(await delegationAfter(reads({ delegate: BUYER_ID, chain_whole: false }), DELEGATION)).toBe('ended');
    expect(await delegationAfter(reads({ delegate: BUYER_ID, chain_whole: true }), DELEGATION)).toBe('live');
  });

  it('says unreadable, and never ended, when the ledger cannot be read or the reading has the wrong shape', async () => {
    expect(await delegationAfter(reads(null, new Error('down')), DELEGATION)).toBe('unreadable');
    expect(await delegationAfter(reads({ delegate: BUYER_ID }), DELEGATION)).toBe('unreadable');
    expect(await delegationAfter(reads('gone'), DELEGATION)).toBe('unreadable');
  });
});
