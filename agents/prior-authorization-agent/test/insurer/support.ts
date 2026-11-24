// agents/prior-authorization-agent/test/insurer/support.ts
// The stub ports of the reader of the insurer, and the world that they serve: the row of the indexer and the advert on the chain. The golden world is an insurer that passes every step. A test changes one
// thing in a copy of it, so each refusal has the golden world as its accepted twin.
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import type { ProtocolResult } from '@vsa/usecase-kit/protocol';
import type { AdvertRead, InsurerDeps, SupplierRow } from '../../src/insurer/index.ts';

export const AGENT_ID = 'a1'.repeat(32);
export const INSURER = `did:vector:${AGENT_ID}`;
export const STRANGER_ID = 'b2'.repeat(32);
/** The capability and the model of the Insurer Intake Agent, as the kit names them. */
export const CAPABILITY = PRIORAUTH_CAPABILITIES.intake;
export const MODEL = PRIORAUTH_MODELS.intake;
export const ADVERT_REF = `${'11'.repeat(32)}#0`;
export const OTHER_REF = `${'22'.repeat(32)}#1`;

/** The exact text of a golden file. */
export const goldenText = (name: string): string => readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8');

/** A fresh value of a golden JSON file that holds an object, so that a test can change a member without changing the sample. */
export const golden = (name: string): Record<string, unknown> => JSON.parse(goldenText(name)) as Record<string, unknown>;

/**
 * A text that no identifier, address or reference takes: it has a space, a slash, a hash sign and a line break. A refusal must never repeat the value that failed, so a test that gives this text checks that
 * no part of it is in the detail.
 */
export const MARKER = 'zq9 marker/value#7f3\n';

/** The value of a result that must have passed. */
export function must<T, C extends string>(result: ProtocolResult<T, C>): T {
  if (!result.ok) throw new Error(`the sample must pass, and it was refused with ${result.code}: ${result.detail}`);
  return result.value;
}

/** The code and the detail of a result that must have failed. */
export function refusal<C extends string>(result: ProtocolResult<unknown, C>): { code: C; detail: string } {
  if (result.ok) throw new Error('the result passed, and the test expected a refusal');
  return { code: result.code, detail: result.detail };
}

/** A detail that names `where` and holds no part of the marker. */
export function expectNames(detail: string, where: string): void {
  expect(detail).toContain(where);
  expect(detail).not.toContain('zq9');
  expect(detail).not.toContain('marker');
}

/** What the world serves and answers. A test changes a member of a copy of the golden world. */
export interface World {
  rows: SupplierRow[];
  /** The chain reading of each advert, by the reference that the row names. */
  reads: Record<string, AdvertRead>;
}

/** The row of the one advert of the golden world. A test changes one member. */
export function rowOf(over: Partial<SupplierRow> = {}): SupplierRow {
  return { utxo_ref: ADVERT_REF, capability_id: CAPABILITY, advert_status: 'Active', agent_id: AGENT_ID, ...over };
}

/** The reading of an advert that the chain shows, and not the `{ error }` of a reference that is no advert. */
export type ShownAdvert = Exclude<AdvertRead, { readonly error: string }>;

export interface AdvertOptions {
  spent?: boolean;
  agentId?: string | null;
  status?: string;
  capability_id?: string;
  model?: string;
}

/** The chain reading of an identity advert of the Insurer Intake Agent, with the members of the golden world unless the options say another. */
export function advertOf(over: AdvertOptions = {}): ShownAdvert {
  return {
    spent: over.spent ?? false,
    agentId: over.agentId === undefined ? AGENT_ID : over.agentId,
    advert: { status: over.status ?? 'Active', capability_id: over.capability_id ?? CAPABILITY, model: over.model ?? MODEL },
  };
}

/** An insurer that passes every step: one Active advert in the list of the indexer, and the same advert Active and unspent on the chain. */
export function goldenWorld(): World {
  return { rows: [rowOf()], reads: { [ADVERT_REF]: advertOf() } };
}

export interface Calls {
  /** The arguments of each call of `listAdverts`. The reader gives one argument: the capability. */
  readonly list: unknown[][];
  /** The arguments of each call of `readAdvert`. The reader gives one argument: the reference. The port of the service adds the advert address of the deployment itself. */
  readonly read: unknown[][];
}

export interface Stub {
  readonly deps: InsurerDeps;
  readonly calls: Calls;
  /** The clock of the reader. A test moves it. */
  readonly clock: { now: number };
}

/** The ports of the reader over `world`, with a record of each call. `over` replaces a port. */
export function stubOf(world: World, over: Partial<InsurerDeps> = {}): Stub {
  const calls: Calls = { list: [], read: [] };
  const clock = { now: 1_800_000_000_000 };
  const deps: InsurerDeps = {
    listAdverts: async (...args: unknown[]) => {
      calls.list.push(args);
      return world.rows;
    },
    readAdvert: async (...args: unknown[]) => {
      calls.read.push(args);
      const read = world.reads[String(args[0])];
      if (read === undefined) throw new Error('the chain has no advert at this reference');
      return read;
    },
    clock: () => clock.now,
    ...over,
  };
  return { deps, calls, clock };
}
