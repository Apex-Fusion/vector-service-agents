// packages/usecase-kit/test/manifest/render.test.ts: the bytes of a manifest and their hash. The bytes are the same for every value of the setting FAULT_MODE and on every render, the manifest lists the
// possible fault values and has the one gap sentence, and it never names the active value. Each refusal has an accepted twin.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { faultGap, renderManifest } from '@vsa/usecase-kit/manifest';
import { readFaultSwitch } from '@vsa/usecase-kit/fault';
import { AGENT_KINDS, FAULT_MODES } from '@vsa/usecase-kit/protocol';
import type { AgentKind, FaultSetting } from '@vsa/usecase-kit/protocol';
import { refusal, sampleManifest, unwrap } from './support.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const settingsOf = (kind: AgentKind): string[] => ['', ...FAULT_MODES[kind]];

/** A builder the way an agent writes it: it takes the environment with FAULT_MODE, checks the setting at its start, and builds the manifest from the kit. */
const agentBuilder = (kind: AgentKind) => (setting: string) => {
  readFaultSwitch(kind, setting);
  return sampleManifest(kind);
};

describe('renderManifest: the bytes do not change with the setting', () => {
  it.each(AGENT_KINDS)('gives %s the same bytes and the same hash for the empty setting and for each fault value', (kind) => {
    const build = agentBuilder(kind);
    const texts = settingsOf(kind).map((setting) => JSON.stringify(build(setting)));
    expect(new Set(texts).size).toBe(1);
    expect(new Set(texts.map(sha256)).size).toBe(1);
    const rendered = unwrap(renderManifest(kind, build));
    expect(rendered.text).toBe(texts[0]);
    expect(rendered.sha256).toBe(sha256(texts[0]));
    expect(rendered.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('renders the template the same way: the same text for every value, indented, with a line break at the end', () => {
    for (const kind of AGENT_KINDS) {
      const build = (setting: string) => {
        readFaultSwitch(kind, setting);
        return sampleManifest(kind, { template: true });
      };
      const texts = settingsOf(kind).map((setting) => `${JSON.stringify(build(setting), null, 2)}\n`);
      expect(new Set(texts).size, kind).toBe(1);
      const rendered = unwrap(renderManifest(kind, build, { template: true }));
      expect(rendered.text, kind).toBe(texts[0]);
      expect(rendered.text.endsWith('}\n'), kind).toBe(true);
      expect(rendered.text, kind).toContain('<OPERATOR_CONTACT>');
      expect(rendered.sha256, kind).toBe(sha256(texts[0]));
      expect(JSON.parse(rendered.text), kind).toStrictEqual(sampleManifest(kind, { template: true }));
    }
  });

  it('serves compact bytes with no placeholder, and the template is another text', () => {
    const served = unwrap(renderManifest('order-desk', () => sampleManifest('order-desk')));
    const template = unwrap(renderManifest('order-desk', () => sampleManifest('order-desk', { template: true }), { template: true }));
    expect(served.text).not.toMatch(/<[A-Z_]+>/);
    expect(served.text).not.toContain('\n');
    expect(template.text).not.toBe(served.text);
    expect(template.sha256).not.toBe(served.sha256);
  });

  it('gives another hash for another manifest', () => {
    const one = unwrap(renderManifest('reorder-agent', () => sampleManifest('reorder-agent')));
    const other = unwrap(renderManifest('reorder-agent', () => ({ ...sampleManifest('reorder-agent'), version: '0.2.0' })));
    expect(other.sha256).not.toBe(one.sha256);
  });

  it('renders the empty setting two times and each fault value one time, and gives the setting to the builder', () => {
    for (const kind of AGENT_KINDS) {
      const seen: string[] = [];
      unwrap(renderManifest(kind, (setting) => { seen.push(setting); return sampleManifest(kind); }));
      expect(seen, kind).toStrictEqual(['', '', ...FAULT_MODES[kind]]);
    }
  });

  it('refuses a manifest that changes with the setting, and names the setting', () => {
    const changes = (build: (setting: string) => unknown) => refusal(renderManifest('order-desk', build));
    const version = changes((setting) => ({ ...sampleManifest('order-desk'), version: setting === '' ? '1' : '2' }));
    expect(version).toStrictEqual({ code: 'manifest_changes_with_fault', detail: 'the manifest changes when FAULT_MODE is "confirm_wrong_lot", and it must not change' });
    // A builder that lists only the active value, or that adds a sentence when a fault is on.
    const listed = changes((setting) => {
      const manifest = sampleManifest('order-desk');
      return { ...manifest, behaviour: { ...manifest.behaviour, fault_modes: setting === '' ? [] : [setting] } };
    });
    expect(listed.code).toBe('manifest_changes_with_fault');
    const gap = changes((setting) => ({ ...sampleManifest('order-desk'), gaps: [...sampleManifest('order-desk').gaps, ...(setting === '' ? [] : ['A fault is on.'])] }));
    expect(gap.code).toBe('manifest_changes_with_fault');
    const named = changes((setting) => ({ ...sampleManifest('order-desk'), fault_mode: setting }));
    expect(named.code).toBe('manifest_changes_with_fault');
  });

  it('refuses a manifest that changes between two renders for the same setting, also for a kind with no fault value', () => {
    for (const kind of ['reorder-agent', 'order-desk'] as const) {
      let count = 0;
      expect(refusal(renderManifest(kind, () => ({ ...sampleManifest(kind), nonce: (count += 1) }))), kind).toStrictEqual({
        code: 'manifest_not_stable',
        detail: 'the manifest builder gives other bytes on a second render with the same setting',
      });
    }
  });

  it('passes an error of the builder on, as it is: it is the error of the caller', () => {
    expect(() => renderManifest('order-desk', () => { throw new Error('environment variable OPERATOR_CONTACT is required'); })).toThrow('environment variable OPERATOR_CONTACT is required');
  });
});

describe('renderManifest: the fault switch in the manifest', () => {
  it('lists the possible values in behaviour.fault_modes and has the one gap sentence, for every kind', () => {
    for (const kind of AGENT_KINDS) {
      const manifest: { behaviour: { fault_modes: string[] }; gaps: string[] } = JSON.parse(unwrap(renderManifest(kind, () => sampleManifest(kind))).text);
      expect(manifest.behaviour.fault_modes, kind).toStrictEqual([...FAULT_MODES[kind]]);
      const sentence = faultGap(kind);
      expect(manifest.gaps.filter((gap) => gap === sentence), kind).toHaveLength(sentence === null ? 0 : 1);
      expect(manifest.gaps.filter((gap) => gap.includes('fault switch')), kind).toHaveLength(sentence === null ? 0 : 1);
    }
  });

  it('refuses a manifest with a member fault_mode, at the top and inside behaviour, also when it is the same for every setting', () => {
    const named = (at: 'top' | 'behaviour' | 'deep') => (): unknown => {
      const manifest = sampleManifest('reorder-agent');
      if (at === 'top') return { ...manifest, fault_mode: '' };
      if (at === 'behaviour') return { ...manifest, behaviour: { ...manifest.behaviour, fault_mode: '' } };
      return { ...manifest, links: { ...manifest.links, more: [{ fault_mode: '' }] } };
    };
    for (const at of ['top', 'behaviour', 'deep'] as const) {
      expect(refusal(renderManifest('reorder-agent', named(at))).code, at).toBe('manifest_names_fault');
    }
    // The twin: the words fault_mode inside a text are not a member. The gap sentence of the order desk has them.
    expect(faultGap('order-desk')).toContain('fault_mode');
    expect(renderManifest('order-desk', () => sampleManifest('order-desk'))).toMatchObject({ ok: true });
  });

  it('refuses a manifest without the gap sentence of its kind, with it twice, and with the sentence of another kind', () => {
    const withGaps = (kind: AgentKind, gaps: (own: string) => string[]) => (): unknown => ({ ...sampleManifest(kind), gaps: gaps(faultGap(kind) ?? '') });
    expect(refusal(renderManifest('order-desk', withGaps('order-desk', () => ['The model decides.']))).detail).toBe('gaps must hold the fault sentence of order-desk one time, and it holds it 0 times');
    expect(refusal(renderManifest('order-desk', withGaps('order-desk', (own) => [own, own]))).detail).toBe('gaps must hold the fault sentence of order-desk one time, and it holds it 2 times');
    expect(refusal(renderManifest('order-desk', withGaps('order-desk', (own) => [own, faultGap('bid-desk') ?? ''])))).toStrictEqual({
      code: 'manifest_fault_gap',
      detail: 'gaps holds the fault sentence of bid-desk, and the kind of this agent is order-desk',
    });
    expect(refusal(renderManifest('reorder-agent', withGaps('reorder-agent', () => [faultGap('sourcing-agent') ?? '']))).code).toBe('manifest_fault_gap');
    expect(renderManifest('reorder-agent', withGaps('reorder-agent', () => ['The model decides.']))).toMatchObject({ ok: true });
    expect(renderManifest('order-desk', withGaps('order-desk', (own) => ['The model decides.', own]))).toMatchObject({ ok: true });
    const { gaps: _gaps, ...noGaps } = sampleManifest('order-desk');
    expect(refusal(renderManifest('order-desk', () => noGaps)).code).toBe('manifest_fault_gap');
  });

  it('refuses a manifest whose behaviour breaks the additions of its kind', () => {
    const edit = (kind: AgentKind, change: (behaviour: Record<string, unknown>) => Record<string, unknown>) => (): unknown => {
      const manifest = sampleManifest(kind);
      return { ...manifest, behaviour: change({ ...manifest.behaviour }) };
    };
    const without = (name: string) => (behaviour: Record<string, unknown>) => {
      delete behaviour[name];
      return behaviour;
    };
    for (const name of ['operations', 'claim', 'cosign', 'fault_modes', 'model', 'relying_on']) {
      expect(refusal(renderManifest('reorder-agent', edit('reorder-agent', without(name)))).code, name).toBe('manifest_behaviour');
    }
    expect(refusal(renderManifest('order-desk', edit('order-desk', without('lots')))).code).toBe('manifest_behaviour');
    expect(refusal(renderManifest('bid-desk', edit('bid-desk', without('price_list')))).code).toBe('manifest_behaviour');
    expect(refusal(renderManifest('reorder-agent', edit('reorder-agent', (behaviour) => ({ ...behaviour, standing_claim: { reference: 'ab#0' } })))).code).toBe('manifest_behaviour');
    expect(refusal(renderManifest('order-desk', edit('order-desk', (behaviour) => ({ ...behaviour, fault_modes: [] })))).detail).toBe(
      'behaviour.fault_modes must list every fault value of order-desk, in the order of the table, and no other value',
    );
    expect(refusal(renderManifest('reorder-agent', () => ({ ...sampleManifest('reorder-agent'), behaviour: 'text' }))).code).toBe('manifest_behaviour');
    // The members of the agent itself stay free: the twin.
    expect(renderManifest('reorder-agent', edit('reorder-agent', (behaviour) => ({ ...behaviour, own_member: 'any value' })))).toMatchObject({ ok: true });
  });

  it('refuses a manifest of another schema, and takes the schema of the kit', () => {
    expect(refusal(renderManifest('reorder-agent', () => ({ ...sampleManifest('reorder-agent'), schema: 'vector.agent-manifest.v1' })))).toStrictEqual({
      code: 'manifest_schema',
      detail: 'the manifest schema must be vector.agent-manifest.v2',
    });
    expect(renderManifest('reorder-agent', () => sampleManifest('reorder-agent'))).toMatchObject({ ok: true });
  });

  it('refuses a served manifest that still has a placeholder, and takes the same manifest as a template', () => {
    const withPlaceholder = () => ({ ...sampleManifest('reorder-agent'), operator: { name: 'Sample operator', contact: '<OPERATOR_CONTACT>' } });
    expect(refusal(renderManifest('reorder-agent', withPlaceholder)).code).toBe('manifest_has_placeholder');
    expect(refusal(renderManifest('reorder-agent', withPlaceholder, { template: false })).code).toBe('manifest_has_placeholder');
    expect(renderManifest('reorder-agent', withPlaceholder, { template: true })).toMatchObject({ ok: true });
    // A file that stands for a published file by a placeholder is refused in a served manifest, by the rule of the file.
    expect(refusal(renderManifest('order-desk', () => sampleManifest('order-desk', { template: true }))).code).toBe('manifest_has_placeholder');
  });

  it('refuses a value that is not a manifest that JSON can write', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const value of [undefined, null, 'manifest', 7, [], () => ({}), new Map(), { ...sampleManifest('reorder-agent'), big: 5n }, circular]) {
      expect(refusal(renderManifest('reorder-agent', () => value)).code, String(value)).toBe('manifest_not_json');
    }
  });

  it('refuses a kind that is not a kind of agent', () => {
    for (const kind of ['nobody', '', 'constructor', undefined]) expect(renderManifest(kind as never, () => sampleManifest('reorder-agent')), String(kind)).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('takes the fault value of each kind as a setting of the builder: the twin of a kind that has none', () => {
    const calls: FaultSetting[] = [];
    unwrap(renderManifest('bid-desk', (setting) => { calls.push(setting); return sampleManifest('bid-desk'); }));
    expect(calls).toStrictEqual(['', '', 'quote_off_price_list']);
  });
});
