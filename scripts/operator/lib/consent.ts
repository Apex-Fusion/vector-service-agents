// scripts/operator/lib/consent.ts - the check of the consent of Module-1 in a registration, made before any signature.
// A record with a Module-1 party has one withdrawal: Module-1 consents to its appointment by a withdrawal from its reward account, with the redeemer that the builder gives. The guard
// `nothing_else` of the checks counts withdrawals and reads neither the reward account nor the amount, and the guard `outflow` does not count a withdrawn reward. So this file reads the one thing
// that the guards leave open, from the bytes and from the node:
//   - a record with no Module-1 party has no withdrawal;
//   - a record with a Module-1 party has exactly one, from the reward address of Module-1 (the 28-byte hash in the inline datum of the configuration record of the deployment), for the WHOLE
//     balance of that account. The ledger refuses any other amount, and anybody can raise the balance by paying into the account, so the balance is read now and not trusted from the build.
// A fault of these is a `GuardRefusal` with the guard `nothing_else`. What the node cannot say (no configuration record, an account that is not registered, a read that fails, a node that cannot
// read a reward account, an account with no balance) is a `PreconditionError`: it is never a pass. Nothing here signs, and no key is used.
import { GuardRefusal } from '../../checks/lib/land.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ChainAccess } from '../../checks/lib/session.ts';
// The entry of buyer-core gives neither of these names, so they come by the path of their file, and only this file reads them: `findConfigRecord` reads the configuration record of a deployment,
// and `module1RewardAddress` makes the reward address of the Module-1 hash that the record holds (a mainnet address, as the pack runs on mainnet).
import { findConfigRecord, module1RewardAddress } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import type { ConfigRecord } from '../../../packages/buyer-core/src/vendored/mcp/identity-deployment.ts';
import { decodeTransaction } from './platform.ts';

/** What the check reads: the step (for the refusal), the unsigned bytes, the node, the deployment, and whether a party of the record is Module-1. */
export interface ConsentCheck {
  readonly step: string;
  readonly unsignedCbor: string;
  readonly provider: ChainAccess['provider'];
  readonly deployment: ChainAccess['deployment'];
  readonly expectModule1: boolean;
}

/** A withdrawal of the body: the reward address and the amount in lovelace. */
interface Withdrawal { address: string; lovelace: bigint }

/** What a node that reads reward accounts gives (`OgmiosProvider.getRewardAccount`): the Lucid provider type has no such method. */
interface RewardAccountRead { registered: boolean; rewards?: bigint }
interface RewardReader {
  getRewardAccount(credential: { type: 'Script'; hash: string }, rewardAddress: string): Promise<RewardAccountRead>;
}

const MAX_REASON_CHARS = 300;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_CHARS);

function readsRewardAccounts(provider: object): provider is RewardReader {
  return 'getRewardAccount' in provider && typeof provider.getRewardAccount === 'function';
}

/** The withdrawals of a transaction (hex CBOR), in the order of its body. */
function withdrawalsOf(unsignedCbor: string): Withdrawal[] {
  const map = decodeTransaction(unsignedCbor).body().withdrawals();
  const found: Withdrawal[] = [];
  if (map === undefined) return found;
  const keys = map.keys();
  for (let at = 0; at < keys.len(); at += 1) {
    const key = keys.get(at);
    found.push({ address: key.to_address().to_bech32(), lovelace: map.get(key) ?? 0n });
  }
  return found;
}

/**
 * Checks the withdrawal of an unsigned registration. With `expectModule1` false there must be none. With it true there must be exactly one, from the reward address of Module-1, for the whole
 * balance of its reward account. The count and the address are judged before the account is read, and the account that is read is the one of Module-1, never the one that the body names.
 * It resolves when the body passes, throws `GuardRefusal` (guard `nothing_else`) when the body is wrong, and throws `PreconditionError` when the node cannot tell.
 */
export async function checkConsentWithdrawal(check: ConsentCheck): Promise<void> {
  const { step, unsignedCbor, provider, deployment, expectModule1 } = check;
  const refuse = (message: string): GuardRefusal => new GuardRefusal(step, [{ guard: 'nothing_else', ok: false, message }]);
  const found = withdrawalsOf(unsignedCbor);
  if (!expectModule1) {
    if (found.length > 0) throw refuse(`no party of the record is Module-1, and the transaction has ${found.length} withdrawal(s): a withdrawal is the consent of Module-1, and no other withdrawal is allowed`);
    return;
  }
  if (found.length === 0) throw refuse('Module-1 is a party of the record, and the transaction has no withdrawal: Module-1 consents by one withdrawal from its reward account');
  if (found.length > 1) throw refuse(`Module-1 is a party of the record, and the transaction has ${found.length} withdrawals: the consent of Module-1 is exactly one withdrawal`);
  const withdrawal = found[0]!;

  let config: ConfigRecord | null;
  try { config = await findConfigRecord(provider, deployment); } catch (err) {
    throw new PreconditionError(`the configuration record of the identity registry could not be read (${errorText(err)}): the reward account of Module-1 is not known`);
  }
  if (config === null) throw new PreconditionError('the identity registry has no configuration record, so the reward account of Module-1 is not known: Module-1 cannot consent before the seal');
  const expected = module1RewardAddress(config.m1);
  if (withdrawal.address !== expected) throw refuse(`the withdrawal is from the reward address ${withdrawal.address}, and the consent of Module-1 is a withdrawal from ${expected}`);

  if (!readsRewardAccounts(provider)) throw new PreconditionError('the node of this run cannot read a reward account, so the balance that the consent of Module-1 takes is not known');
  let account: RewardAccountRead;
  try { account = await provider.getRewardAccount({ type: 'Script', hash: config.m1 }, expected); } catch (err) {
    throw new PreconditionError(`the reward account of Module-1 (${expected}) could not be read (${errorText(err)}): the balance that the consent takes is not known`);
  }
  if (!account.registered) throw new PreconditionError(`the reward account of Module-1 (${expected}) is not registered on the ledger: its consent cannot be made before the stake credential is registered`);
  if (typeof account.rewards !== 'bigint') throw new PreconditionError(`the node gave no balance for the reward account of Module-1 (${expected}): the amount of the consent is not known`);
  if (withdrawal.lovelace !== account.rewards) {
    throw refuse(`the withdrawal takes ${withdrawal.lovelace} lovelace, and the reward account of Module-1 holds ${account.rewards} lovelace: the consent takes the whole balance`);
  }
}
