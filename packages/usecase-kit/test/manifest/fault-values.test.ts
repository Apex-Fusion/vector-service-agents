// packages/usecase-kit/test/manifest/fault-values.test.ts: a fault value of ANY kind may stand in the served manifest only in the places that the kit makes, the members of `behaviour.fault_modes`
// and the one gap sentence. A key `fault_mode` may stand nowhere. A builder that reads the environment by itself, and not from its argument, gives equal bytes in the renders of one process, so the
// check works on the text that is served, and no walk with a depth limit decides it. Each refusal has an accepted twin.
import { describe, expect, it, vi } from 'vitest';
import { faultGap, renderManifest } from '@vsa/usecase-kit/manifest';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import type { AgentKind } from '@vsa/usecase-kit/protocol';
import { refusal, sampleManifest, unwrap } from './support.ts';
import type { SampleManifest } from './support.ts';

/** The environment of a process, as a builder that does not use its argument reads it. */
let environment = '';

/** An object with this many levels of `n` around a leaf. */
function nest(levels: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) value = { n: value };
  return value;
}

const PLACE = 'only the members of behaviour.fault_modes and the one gap sentence may name a fault value';

/** Builders that read the environment by themselves and put the active value into the manifest. */
const LEAKS: [string, () => unknown, string][] = [
  ['a member FAULT_MODE', () => ({ ...sampleManifest('order-desk'), FAULT_MODE: environment }), `the fault value "confirm_wrong_lot" stands in the manifest at FAULT_MODE: ${PLACE}`],
  ['a member faultMode in behaviour', () => { const m = sampleManifest('order-desk'); return { ...m, behaviour: { ...m.behaviour, faultMode: environment } }; }, `the fault value "confirm_wrong_lot" stands in the manifest at behaviour.faultMode: ${PLACE}`],
  ['a text', () => ({ ...sampleManifest('order-desk'), name: `Sample agent ${environment}`.trim() }), `the fault value "confirm_wrong_lot" stands in the manifest at name: ${PLACE}`],
  ['a key', () => { const m = sampleManifest('order-desk'); return { ...m, links: { ...m.links, [environment || 'none']: 'x' } }; }, `the fault value "confirm_wrong_lot" stands in the manifest at links.confirm_wrong_lot: ${PLACE}`],
  ['a member fault_mode at depth 34', () => ({ ...sampleManifest('order-desk'), links: nest(33, { fault_mode: environment }) }), 'the manifest has a member fault_mode at links.n.n.n'],
];

describe('a builder that reads the environment by itself', () => {
  it.each(LEAKS)('is refused in a process with a fault, when it puts the value in %s, and the message says where', (name, build, message) => {
    environment = 'confirm_wrong_lot';
    const result = refusal(renderManifest('order-desk', build));
    expect(result.code, name).toBe('manifest_names_fault');
    expect(result.detail.startsWith(message), result.detail).toBe(true);
  });

  it.each(LEAKS)('never serves other bytes in a fault process and in a clean process, when it puts the value in %s: one of them is refused', (name, build) => {
    environment = 'confirm_wrong_lot';
    const fault = renderManifest('order-desk', build);
    environment = '';
    const cleanProcess = renderManifest('order-desk', build);
    expect(fault.ok, name).toBe(false);
    expect(!fault.ok || (cleanProcess.ok && fault.value.sha256 === cleanProcess.value.sha256), name).toBe(true);
  });

  it('is accepted when it keeps the environment out of the manifest, for every kind and every setting: the twin', () => {
    for (const kind of AGENT_KINDS) {
      const hashes = new Set<string>();
      for (const setting of ['', ...FAULT_MODES[kind]]) {
        environment = setting;
        const rendered = unwrap(renderManifest(kind, () => { readFaultSwitch(kind, environment); return sampleManifest(kind); }));
        hashes.add(rendered.sha256);
      }
      expect(hashes.size, kind).toBe(1);
    }
  });
});

describe('a fault value in a free text of the manifest', () => {
  const withMember = (kind: AgentKind, change: (manifest: SampleManifest) => Record<string, unknown>) => () => change(sampleManifest(kind));

  it('is refused in the description, and the message says where', () => {
    const named = withMember('order-desk', (m) => ({ ...m, description: 'It can run with confirm_wrong_lot in a failure run.' }));
    expect(refusal(renderManifest('order-desk', named))).toStrictEqual({
      code: 'manifest_names_fault',
      detail: `the fault value "confirm_wrong_lot" stands in the manifest at description: ${PLACE}`,
    });
    expect(renderManifest('order-desk', withMember('order-desk', (m) => ({ ...m, description: 'It confirms the order of a buyer.' })))).toMatchObject({ ok: true });
  });

  it('is refused for a fault value of every kind, also for a kind that has none and for a value of another kind', () => {
    for (const kind of AGENT_KINDS) {
      for (const value of Object.values(FAULT_MODES).flat()) {
        const named = withMember(kind, (m) => ({ ...m, description: `Mentions ${value}.` }));
        const result = refusal(renderManifest(kind, named));
        expect(result, `${kind} ${value}`).toStrictEqual({ code: 'manifest_names_fault', detail: `the fault value "${value}" stands in the manifest at description: ${PLACE}` });
      }
      expect(renderManifest(kind, withMember(kind, (m) => ({ ...m, description: 'Mentions no value.' }))), kind).toMatchObject({ ok: true });
    }
  });

  it('is refused in every place that the kit does not make: a second list, a member of behaviour, a gap that holds the sentence and more, and a key', () => {
    const own = faultGap('order-desk') ?? '';
    const cases: [string, () => Record<string, unknown>, string][] = [
      ['a second list of the values', () => { const m = sampleManifest('order-desk'); return { ...m, behaviour: { ...m.behaviour, own_modes: ['confirm_wrong_lot'] } }; }, 'behaviour.own_modes[0]'],
      ['the sentence in another member', () => ({ ...sampleManifest('order-desk'), notes: [own] }), 'notes[0]'],
      ['another gap that holds the value', () => { const m = sampleManifest('order-desk'); return { ...m, gaps: [...m.gaps, 'The value confirm_wrong_lot makes a wrong lot.'] }; }, `gaps[${sampleManifest('order-desk').gaps.length}]`],
      ['a member of a claim statement', () => { const m = sampleManifest('order-desk'); return { ...m, links: { ...m.links, text: 'xconfirm_wrong_lotx' } }; }, 'links.text'],
      ['a key with an odd name', () => { const m = sampleManifest('order-desk'); return { ...m, links: { ...m.links, 'a confirm_wrong_lot b': 'x' } }; }, 'links["a confirm_wrong_lot b"]'],
      ['a deep text', () => ({ ...sampleManifest('order-desk'), links: nest(40, { text: 'confirm_wrong_lot' }) }), 'links.n.n.n'],
    ];
    for (const [name, build, place] of cases) {
      const result = refusal(renderManifest('order-desk', build));
      expect(result.code, name).toBe('manifest_names_fault');
      expect(result.detail, name).toContain(`stands in the manifest at ${place}`);
    }
  });

  it('is accepted in the two places that the kit makes, once each: the twin', () => {
    for (const kind of AGENT_KINDS) {
      const rendered = unwrap(renderManifest(kind, () => sampleManifest(kind)));
      for (const value of Object.values(FAULT_MODES).flat()) {
        const own = (FAULT_MODES[kind] as readonly string[]).includes(value);
        expect(rendered.text.split(value).length - 1, `${kind} ${value}`).toBe(own ? 2 : 0);
      }
    }
  });
});

describe('a manifest that is deeper than a walk can go', () => {
  it('is refused with a member fault_mode at any depth, with the depth of the old limit and with more', () => {
    for (const levels of [31, 32, 33, 34, 100, 1000]) {
      const deep = () => ({ ...sampleManifest('reorder-agent'), links: nest(levels, { fault_mode: '' }) });
      expect(refusal(renderManifest('reorder-agent', deep)).code, String(levels)).toBe('manifest_names_fault');
      const without = () => ({ ...sampleManifest('reorder-agent'), links: nest(levels, { other: '' }) });
      expect(renderManifest('reorder-agent', without), String(levels)).toMatchObject({ ok: true });
    }
  });

  it('is refused when it is so deep that JSON cannot write it: it never passes', () => {
    const tooDeep = () => ({ ...sampleManifest('reorder-agent'), links: nest(200_000, { other: '' }) });
    expect(refusal(renderManifest('reorder-agent', tooDeep)).code).toBe('manifest_not_json');
  });

  it('finds a fault value at any depth, with the depth of the old limit and with more', () => {
    for (const levels of [33, 100, 1000]) {
      const deep = () => ({ ...sampleManifest('order-desk'), links: nest(levels, { text: 'confirm_wrong_lot' }) });
      const result = refusal(renderManifest('order-desk', deep));
      expect(result.code, String(levels)).toBe('manifest_names_fault');
      expect(result.detail, String(levels)).toContain('stands in the manifest at links.n.n.n');
    }
  });
});

describe('the message of the refusal', () => {
  it('cuts a long place and shows printable characters only', () => {
    const odd = () => ({ ...sampleManifest('order-desk'), links: { [`${'k'.repeat(100)}\n`]: 'confirm_wrong_lot' } });
    const result = refusal(renderManifest('order-desk', odd));
    expect(result.code).toBe('manifest_names_fault');
    expect(result.detail.length).toBeLessThan(260);
    expect(result.detail).not.toContain('\n');
    expect(result.detail).toContain('...');
  });
});

describe('a text that cannot be read back', () => {
  it('is refused and never passes, and the same manifest passes when the text can be read: the twin', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => { throw new SyntaxError('unreadable'); });
    try {
      expect(refusal(renderManifest('reorder-agent', () => sampleManifest('reorder-agent')))).toStrictEqual({ code: 'manifest_not_json', detail: 'the text of the manifest cannot be read back as JSON' });
    } finally {
      parse.mockRestore();
    }
    expect(renderManifest('reorder-agent', () => sampleManifest('reorder-agent'))).toMatchObject({ ok: true });
  });
});
