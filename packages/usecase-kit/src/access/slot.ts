// packages/usecase-kit/src/access/slot.ts
// The slot rule of the identity deployment. A Delegate ends at a slot (the TTL of its body), and the reference of a left sub-delegation names the same end in POSIX milliseconds. The two must agree, so the
// keys sign the bytes of a Delegate only when its TTL is the slot that the end in milliseconds gives (txcheck.ts). The builders of `@vsa/buyer-core` turn the end of the validity of a transaction into a slot
// with the slot clock of the chain, and this file gives the same rule to the chain port of a caller.
import { unixTimeToSlot } from '@lucid-evolution/lucid';
import { ensureSlotConfig } from '@vsa/buyer-core';

/** What the slot clock of a chain needs from its node: the POSIX time of slot 0. The `OgmiosProvider` of `@vsa/buyer-core` has this method. */
export interface SlotClockSource {
  getSystemStartMs(): Promise<number>;
}

/**
 * The method `slotAt` of a `DelegationChain` for the identity deployment of `@vsa/buyer-core`. Slot 0 starts at the system start that the node reports, a slot lasts one second, and a time gives the slot that
 * contains it: the time is rounded down. This is the rule that Lucid applies to the `validTo` of a build, with the slot clock that `ensureSlotConfig` of buyer-core sets from the node, so the TTL that a real
 * builder writes for a `validTo` is the slot that this function gives for it. It rejects when the node gives no usable system start.
 */
export function deploymentSlotAt(source: SlotClockSource): (ms: number) => Promise<number> {
  return async (ms) => {
    await ensureSlotConfig(source);
    return unixTimeToSlot('Mainnet', ms);
  };
}
