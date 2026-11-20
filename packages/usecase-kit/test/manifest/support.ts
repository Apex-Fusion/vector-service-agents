// packages/usecase-kit/test/manifest/support.ts: the samples that the tests of the manifest share. Every value has the form that the manifest names. No value is a key or a real address.
import { buildBehaviour, withFaultGap } from '@vsa/usecase-kit/manifest';
import type { BehaviourParts } from '@vsa/usecase-kit/manifest';
import type { AgentKind } from '@vsa/usecase-kit/protocol';

export const CLAIM = [
  'An order that this agent places is the purchase order that its hirer approved.',
  'This agent accepts only a confirmation that names the SKU and the lot of the order.',
  'This agent pays a supplier only from the vault of its delegation.',
] as const;
export const MODEL = { allowlist: ['deepseek/deepseek-v4-flash'], max_price_lovelace: 200_000 } as const;
export const RELYING_ON = { mock_systems: ['GET /erp/stock/{sku}', 'POST /po'], gateway_routes: ['POST /token'] } as const;
export const LOTS = { uri: 'https://example.invalid/lots.json', sha256: 'ab'.repeat(32) } as const;
export const PRICES = { uri: 'https://example.invalid/prices.json', sha256: 'cd'.repeat(32) } as const;

/** The parts of each kind. The `satisfies` clause makes the typecheck hold each table to the type of its kind. */
export const PARTS = {
  'reorder-agent': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON },
  'prior-authorization-agent': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON },
  'sourcing-agent': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON },
  'order-desk': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON, lots: LOTS },
  'insurer-intake-agent': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON },
  'bid-desk': { claim: CLAIM, model: MODEL, relying_on: RELYING_ON, price_list: PRICES },
} as const satisfies { [K in AgentKind]: BehaviourParts<K> };

/** The same parts for a template: the files of the operator have placeholders. */
export const TEMPLATE_FILES = {
  lots: { uri: '<LOTS_URI>', sha256: '<LOTS_SHA256>' },
  price_list: { uri: '<PRICE_LIST_URI>', sha256: '<PRICE_LIST_SHA256>' },
} as const;

export function unwrap<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly detail: string }): T {
  if (!result.ok) throw new Error(`refused: ${result.detail}`);
  return result.value;
}

/** A refusal as `{ code, detail }`, and a failure of the test when the result passed. */
export function refusal(result: { readonly ok: boolean; readonly code?: string; readonly detail?: string }): { code: string; detail: string } {
  if (result.ok) throw new Error('the result passed, and the test expected a refusal');
  return { code: result.code ?? '', detail: result.detail ?? '' };
}

/** A manifest of an agent, with the members that the tests read. */
export interface SampleManifest {
  schema: string;
  name: string;
  capability_id: string;
  version: string;
  operator: { name: string; contact: string };
  behaviour: Record<string, unknown>;
  gaps: string[];
  links: Record<string, unknown>;
}

/** A manifest of an agent with the additions of the kit: the members of the agent come first, then the additions, and the gaps end with the fault sentence of the kind. */
export function sampleManifest(kind: AgentKind, options: { readonly template?: boolean } = {}): SampleManifest {
  const template = options.template === true;
  const base = PARTS[kind];
  // The table above holds each kind to its parts, so the parts of `kind` fit `kind`. The type system cannot follow a kind that is a variable.
  const parts = template ? { ...base, ...(kind === 'order-desk' ? { lots: TEMPLATE_FILES.lots } : {}), ...(kind === 'bid-desk' ? { price_list: TEMPLATE_FILES.price_list } : {}) } : base;
  const additions = unwrap(buildBehaviour(kind, parts as never, { template }));
  return {
    schema: 'vector.agent-manifest.v2',
    name: 'Sample agent',
    capability_id: 'sample.capability.v1',
    version: '0.1.0',
    operator: { name: 'Sample operator', contact: template ? '<OPERATOR_CONTACT>' : 'ops@example.invalid' },
    behaviour: { data_handling: 'The request is held in memory while a job runs.', ...additions },
    gaps: [...withFaultGap(kind, ['The model decides.', 'Every record is synthetic.'])],
    links: { spec: 'https://example.invalid/spec' },
  };
}
