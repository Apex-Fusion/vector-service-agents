// packages/usecase-kit/test/buyer/advert.test.ts: the check that the advert of a job names the counterparty as its agent. The hire kit checks the agent of the receipt against the agent of the advert and never
// against the counterparty of the document, so the flow reads the advert before it pays. The advert of another agent, and an advert that names no agent, are `advert_not_counterparty`. A read that cannot be
// made, and a reading of the wrong shape, are `ledger_unavailable`, and neither is read as a match. Each refusal has a twin that passes.
import { describe, expect, it, vi } from 'vitest';
import { checkAdvertAgent } from '@vsa/usecase-kit/buyer';
import { AGENT_ADVERT_REF, COUNTERPARTY_DID } from './support.ts';

const AGENT_ID = COUNTERPARTY_DID.slice('did:vector:'.length);
const OTHER_DID = `did:vector:${'cc'.repeat(32)}`;

/** A chain whose read of the advert gives what the test says, or throws what the test throws. */
const chainThat = (read: () => unknown): Parameters<typeof checkAdvertAgent>[0] => ({ readAdvert: vi.fn(async () => read() as never) });

describe('the agent of the advert', () => {
  it('passes an advert whose agent is the counterparty, and asks the chain for the advert of the document', async () => {
    const chain = chainThat(() => ({ agent_id: AGENT_ID, capability_id: 'supplychain.order.accept.v1' }));
    expect(await checkAdvertAgent(chain, AGENT_ADVERT_REF, COUNTERPARTY_DID)).toStrictEqual({ ok: true });
    expect(chain.readAdvert).toHaveBeenCalledTimes(1);
    expect(chain.readAdvert).toHaveBeenCalledWith(AGENT_ADVERT_REF);
  });

  it('refuses an advert of another agent: advert_not_counterparty, and the detail repeats no DID', async () => {
    const refused = await checkAdvertAgent(chainThat(() => ({ agent_id: AGENT_ID })), AGENT_ADVERT_REF, OTHER_DID);
    expect(refused).toMatchObject({ ok: false, code: 'advert_not_counterparty' });
    expect(JSON.stringify(refused)).not.toContain(AGENT_ID);
    expect(JSON.stringify(refused)).not.toContain(OTHER_DID.slice('did:vector:'.length));
  });

  it('refuses an advert that names no agent, and an agent that is not a text: advert_not_counterparty', async () => {
    for (const advert of [{}, { capability_id: 'supplychain.order.accept.v1' }, { agent_id: undefined }, { agent_id: null }, { agent_id: 7 }, { agent_id: [AGENT_ID] }]) {
      expect(await checkAdvertAgent(chainThat(() => advert), AGENT_ADVERT_REF, COUNTERPARTY_DID), JSON.stringify(advert)).toMatchObject({ ok: false, code: 'advert_not_counterparty' });
    }
  });

  it('compares the agent as text and changes no case: an agent id in upper case is another text, and the same id in lower case is the counterparty', async () => {
    expect(await checkAdvertAgent(chainThat(() => ({ agent_id: AGENT_ID.toUpperCase() })), AGENT_ADVERT_REF, COUNTERPARTY_DID)).toMatchObject({ ok: false, code: 'advert_not_counterparty' });
    expect(await checkAdvertAgent(chainThat(() => ({ agent_id: AGENT_ID })), AGENT_ADVERT_REF, COUNTERPARTY_DID)).toStrictEqual({ ok: true });
  });

  it('refuses a read that cannot be made as ledger_unavailable, and never as a match: the error text is not repeated', async () => {
    const refused = await checkAdvertAgent(chainThat(() => { throw new Error('koios answered 502 for the token s3cret'); }), AGENT_ADVERT_REF, COUNTERPARTY_DID);
    expect(refused).toMatchObject({ ok: false, code: 'ledger_unavailable' });
    expect(JSON.stringify(refused)).not.toContain('s3cret');
    // The twin: the same chain that reads the advert gives a pass.
    expect(await checkAdvertAgent(chainThat(() => ({ agent_id: AGENT_ID })), AGENT_ADVERT_REF, COUNTERPARTY_DID)).toStrictEqual({ ok: true });
  });

  it('refuses a reading of the wrong shape as ledger_unavailable: a value that is no object, and an advert whose agent cannot be read', async () => {
    for (const reading of [null, undefined, 'an advert', 7, true]) {
      expect(await checkAdvertAgent(chainThat(() => reading), AGENT_ADVERT_REF, COUNTERPARTY_DID), String(reading)).toMatchObject({ ok: false, code: 'ledger_unavailable' });
    }
    const unreadable = { get agent_id(): string { throw new Error('a member that throws'); } };
    expect(await checkAdvertAgent(chainThat(() => unreadable), AGENT_ADVERT_REF, COUNTERPARTY_DID)).toMatchObject({ ok: false, code: 'ledger_unavailable' });
  });
});
