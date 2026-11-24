// scripts/checks/lib/collateral.ts - the collateral of a step that runs a script.
//
// A transaction that runs a script needs a collateral input: a pure output of units, with no token, of 5 units or more, in the wallet that pays. The builders refuse a wallet that has none,
// but only after the build, and with their own words. A step that runs a script asks for the collateral first (`requireCollateral`). A wallet that has none stops the step with exit 2
// and a text that names the wallet and says how to make one.
import type { CheckKeyRole } from './keys.ts';
import type { Utxo } from './platform.ts';
import { PreconditionError } from './session.ts';
import type { Session } from './session.ts';

/** A pure output of at least this many units is a collateral output. */
export const COLLATERAL_MIN_LOVELACE = 5_000_000n;

export const isCollateralOutput = (utxo: Utxo): boolean => Object.keys(utxo.assets).every((unit) => unit === 'lovelace') && (utxo.assets.lovelace ?? 0n) >= COLLATERAL_MIN_LOVELACE;

/** How to make a collateral output. */
export const collateralAdvice = (address: string): string => `Make one: send 5.5 units to ${address} in one transaction, from this wallet or from another wallet, and wait for the confirmation`;

/** Stops the step, before it builds anything, when the wallet of the key `role` holds no collateral output. */
export async function requireCollateral(session: Pick<Session, 'chain' | 'ring'>, role: CheckKeyRole): Promise<void> {
  const key = session.ring.get(role);
  if ((await session.chain.provider.getUtxos(key.address)).some(isCollateralOutput)) return;
  throw new PreconditionError(
    `The ${role} wallet ${key.keyHash} has no pure output of 5 units or more. This step runs a script, and the script needs one as collateral. The address of the wallet is ${key.address}. ${collateralAdvice(key.address)}.`,
  );
}
