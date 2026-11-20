// The collateral of a script step: a pure output of 5 units or more in the wallet that pays. A step that runs a script stops before it builds anything when its wallet has none.
import { describe, expect, it } from 'vitest';
import { COLLATERAL_MIN_LOVELACE, collateralAdvice, isCollateralOutput, requireCollateral } from '../lib/collateral.ts';
import type { Utxo } from '../lib/platform.ts';
import { harness } from './support/harness.ts';
import { probed } from './support/probe.ts';
import { AGENT_N, MEMBER_N, World, keyOf } from './support/world.ts';

const member = keyOf(MEMBER_N);
const agent = keyOf(AGENT_N);
const TOKEN = `${'cd'.repeat(28)}6e`;
const output = (assets: Record<string, bigint>): Utxo => ({ txHash: 'aa'.repeat(32), outputIndex: 0, address: member.address, assets });

describe('an output that can be collateral', () => {
  it('holds units only, and holds 5 units or more', () => {
    expect(COLLATERAL_MIN_LOVELACE).toBe(5_000_000n);
    expect(isCollateralOutput(output({ lovelace: 5_000_000n }))).toBe(true);
    expect(isCollateralOutput(output({ lovelace: 120_000_000n }))).toBe(true);
    expect(isCollateralOutput(output({ lovelace: 4_999_999n }))).toBe(false);
    expect(isCollateralOutput(output({ lovelace: 12_000_000n, [TOKEN]: 1n }))).toBe(false);
  });
  it('is made with one transaction of 5.5 units to the address of the wallet', () => {
    expect(collateralAdvice(member.address)).toContain(`send 5.5 units to ${member.address} in one transaction`);
  });
});

describe('the collateral that a step needs', () => {
  it('lets a wallet pass that holds one pure output of 5 units or more, whatever its other outputs are', async () => {
    const world = await World.identity({ wallets: [{ n: MEMBER_N, lovelace: [1_000_000n, 5_000_000n, 4_000_000n] }, { n: AGENT_N }] });
    const h = await harness({ world });
    expect(await probed(h, async (session) => {
      await requireCollateral(session, 'member');
      await requireCollateral(session, 'agent');
    })).toBe(0);
  });
  it('stops a wallet that holds none, with exit 2: outputs of less than 5 units, or a large output that holds a token', async () => {
    const cases = [
      { lovelace: [4_999_999n, 4_999_999n], extra: [] as Utxo[] },
      { lovelace: [] as bigint[], extra: [output({ lovelace: 50_000_000n, [TOKEN]: 1n })] },
    ];
    for (const { lovelace, extra } of cases) {
      const world = await World.identity({ wallets: [{ n: MEMBER_N, lovelace }, { n: AGENT_N }], extra });
      const h = await harness({ world });
      expect(await probed(h, (session) => requireCollateral(session, 'member'))).toBe(2);
      expect(h.screen.errorText).toContain(`The member wallet ${member.keyHash}`);
      expect(h.screen.errorText).toContain(member.address);
      expect(h.screen.errorText).toContain(collateralAdvice(member.address));
      expect(h.node.submitted).toEqual([]);
    }
  });
  it('judges the wallet of the role that it is given', async () => {
    const world = await World.identity();
    world.useUp(AGENT_N);
    const h = await harness({ world });
    expect(await probed(h, (session) => requireCollateral(session, 'member'))).toBe(0);
    expect(await probed(h, (session) => requireCollateral(session, 'agent'))).toBe(2);
    expect(h.screen.errorText).toContain(`The agent wallet ${agent.keyHash}`);
    expect(h.screen.errorText).toContain(agent.address);
  });
});
