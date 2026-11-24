// agents/sourcing-agent/src/facts/stake.ts
// The Module-3 stake of an agent, as a fact for the file of a bidder. The port gives the outputs that hold the stake token of the agent: the policy is the reputation validator, and the name is derived from the
// identifier of the agent. Anybody can send an output with any datum to a script address, and an output can sit at any address, so a row counts as a stake only when ALL of these hold:
//
//   - it sits at the stake address (a row with no address is skipped, and so is a row that Koios shows as spent);
//   - it has an inline datum that the codec reads as the 8-field stake datum (any other datum is skipped, the 6-field datum of the earlier deployment included);
//   - it holds exactly one token of the policy and the name of this agent, in a quantity of 1 (the opening output of a stake has the datum and no token);
//   - the agent that the datum names has the token name of this agent.
//
// The result is the sum of the stake amounts of the rows that count. A row that the source gives twice counts once, by its output reference. A list with no row that counts is a stake of 0: an agent with no stake
// has no stake, and that is a fact. A source that cannot be read (the port throws, ends too late, or gives no list, or gives a row that has no output reference) is `{ ok: false }` and never a number.
// This file reads no network, no file and no environment variable: the source is a port.
import { REPUTATION_ADDRESS, REPUTATION_SCRIPT_HASH, decodeStakeDatum, stakeTokenName } from '@vsa/vector-read';
import type { KoiosUtxo, StakeDatum } from '@vsa/vector-read';
import { callPort } from './bound.ts';
import type { FactClock } from './bound.ts';

export interface StakeDeps {
  /** The unspent outputs that hold the asset of the policy and the name. It throws when the source cannot be read. `koios.assetUtxos` of vector-read has this shape. */
  readonly assetUtxos: (policy: string, name: string) => Promise<readonly KoiosUtxo[]>;
  readonly clock: FactClock;
}

/** The stake of an agent in units, or the fact that the source could not be read. */
export type StakeFact = { readonly ok: true; readonly stake_lovelace: bigint } | { readonly ok: false };

/** A row of the source is an object with the reference of its output. Without it, two rows cannot be told apart, so the list is of a wrong shape. */
function isRow(value: unknown): value is KoiosUtxo {
  return typeof value === 'object' && value !== null && 'tx_hash' in value && typeof value.tx_hash === 'string'
    && 'tx_index' in value && typeof value.tx_index === 'number' && Number.isSafeInteger(value.tx_index) && value.tx_index >= 0;
}

/** True when the output holds exactly one token of the stake policy with this name, in a quantity of 1. */
function holdsToken(row: KoiosUtxo, name: string): boolean {
  if (!Array.isArray(row.asset_list)) return false;
  const held = row.asset_list.filter((asset) => asset?.policy_id === REPUTATION_SCRIPT_HASH && asset.asset_name === name);
  return held.length === 1 && held[0]?.quantity === '1';
}

/** The amount that the output stakes, or null when the output is no stake of the agent that has the token name `name`. */
function stakeOf(row: KoiosUtxo, name: string): bigint | null {
  if (row.address !== REPUTATION_ADDRESS || row.is_spent === true) return null;
  const bytes = row.inline_datum?.bytes;
  if (typeof bytes !== 'string') return null;
  let datum: StakeDatum;
  try {
    datum = decodeStakeDatum(bytes);
  } catch {
    return null;
  }
  if (stakeTokenName(datum.agent_did) !== name || !holdsToken(row, name)) return null;
  // The validator never writes a stake below zero. A datum that holds one is no stake, and it must not lower the sum.
  return datum.stake_amount < 0n ? null : datum.stake_amount;
}

/**
 * The stake of the agent whose identifier is `agentId` (64 lower-case hex characters). It never throws. An identifier of another form cannot be read, so it gives `{ ok: false }` and calls no port.
 */
export async function readStake(deps: StakeDeps, agentId: string): Promise<StakeFact> {
  let name: string;
  try {
    name = stakeTokenName(agentId);
  } catch {
    return { ok: false };
  }
  const listed = await callPort(deps.clock, () => deps.assetUtxos(REPUTATION_SCRIPT_HASH, name));
  if (!listed.ok || !Array.isArray(listed.value)) return { ok: false };
  const counted = new Map<string, bigint>();
  for (const row of listed.value as readonly unknown[]) {
    if (!isRow(row)) return { ok: false };
    const amount = stakeOf(row, name);
    const reference = `${row.tx_hash}#${row.tx_index}`;
    if (amount !== null && !counted.has(reference)) counted.set(reference, amount);
  }
  let total = 0n;
  for (const amount of counted.values()) total += amount;
  return { ok: true, stake_lovelace: total };
}
