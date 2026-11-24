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

describe('a manifest that cannot be written again', () => {
  it('is refused and never passes: the check of the written form runs, and a write that fails is not a pass', () => {
    const write = JSON.stringify;
    let calls = 0;
    const stringify = vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      calls += 1;
      // The first two calls write the manifest for the two settings of a kind with no fault value. The third call is the check of the written form.
      if (calls === 3) throw new RangeError('Maximum call stack size exceeded');
      return write(value, replacer, space);
    });
    try {
      expect(refusal(renderManifest('reorder-agent', () => sampleManifest('reorder-agent'))).code).toBe('manifest_not_in_written_form');
      expect(calls).toBe(3);
    } finally {
      stringify.mockRestore();
    }
    expect(renderManifest('reorder-agent', () => sampleManifest('reorder-agent'))).toMatchObject({ ok: true });
  });
});

/** `JSON.rawJSON` of the Node 22 line. It makes a value that `JSON.stringify` writes as the text that its author gave, so the text can hold an escape that a reader decodes. */
interface RawJson {
  rawJSON(text: string): object;
}

const hasRawJson = (json: JSON): json is JSON & RawJson => 'rawJSON' in json && typeof json.rawJSON === 'function';

function rawJson(text: string): object {
  if (!hasRawJson(JSON)) throw new Error('JSON.rawJSON is not in this Node');
  return JSON.rawJSON(text);
}

describe.skipIf(!hasRawJson(JSON))('a text that is not in the written form', () => {
  it('is refused when it writes a fault value with an escape, which a reader decodes: the case of the review, and its twin', () => {
    const escaped = { ...sampleManifest('order-desk'), name: rawJson('"confirm_wrong\\u005flot"') };
    // The served text has the escape, a reader decodes the fault value, and a count in the text finds none.
    const text = JSON.stringify(escaped);
    expect(text).toContain('confirm_wrong\\u005flot');
    expect(JSON.parse(text).name).toBe('confirm_wrong_lot');
    expect(refusal(renderManifest('order-desk', () => escaped)).code).toBe('manifest_not_in_written_form');
    // The twin: the same value, written in the form that the kit writes, is a fault value outside the kit places.
    expect(refusal(renderManifest('order-desk', () => ({ ...sampleManifest('order-desk'), name: 'confirm_wrong_lot' }))).code).toBe('manifest_names_fault');
  });

  const ESCAPED: [string, string][] = [
    ['a fault value with an escape for its underscore', '"confirm_wrong\\u005flot"'],
    ['a fault value of another kind with an escape', '"quote_off\\u005fprice_list"'],
    ['an escape for a letter of an innocent text', '"caf\\u00e9"'],
    ['an escape of a slash', '"a\\/b"'],
    ['a placeholder with escapes for its angle brackets', '"\\u003cOPERATOR_CONTACT\\u003e"'],
    ['a number that JSON.stringify writes in another way', '1.0'],
    ['a number with an exponent', '1E2'],
  ];

  it.each(ESCAPED)('is refused, in a served manifest and in a template, for %s', (name, json) => {
    const served = () => ({ ...sampleManifest('order-desk'), name: rawJson(json) });
    const template = () => ({ ...sampleManifest('order-desk', { template: true }), name: rawJson(json) });
    expect(refusal(renderManifest('order-desk', served)).code, name).toBe('manifest_not_in_written_form');
    expect(refusal(renderManifest('order-desk', template, { template: true })).code, name).toBe('manifest_not_in_written_form');
  });

  it('takes the same values when they are written in the form that the kit writes: the twins', () => {
    for (const value of ['café', 'a/b', 1, 100, '<not a placeholder>']) {
      expect(renderManifest('order-desk', () => ({ ...sampleManifest('order-desk'), name: value })), String(value)).toMatchObject({ ok: true });
    }
    expect(refusal(renderManifest('order-desk', () => ({ ...sampleManifest('order-desk'), name: '<OPERATOR_CONTACT>' }))).code).toBe('manifest_has_placeholder');
  });
});

describe('a text with every escape that JSON.stringify makes', () => {
  it('is in the written form: it renders, in a served manifest and in a template, and the text is what JSON.stringify writes', () => {
    const name = 'quote " backslash \\ newline \n tab \t control \u0001 lone \ud800 separator \u2028 emoji \u{1F600} accent \u00e9';
    const served = unwrap(renderManifest('order-desk', () => ({ ...sampleManifest('order-desk'), name })));
    expect(served.text).toBe(JSON.stringify({ ...sampleManifest('order-desk'), name }));
    const template = unwrap(renderManifest('order-desk', () => ({ ...sampleManifest('order-desk', { template: true }), name }), { template: true }));
    expect(template.text).toBe(`${JSON.stringify({ ...sampleManifest('order-desk', { template: true }), name }, null, 2)}\n`);
  });
});

describe('the bytes of a manifest that is in the written form', () => {
  // The hashes of the served text and of the template text of the sample manifest of each kind, as they were before the check of the written form. The three buyer-side kinds hold the co-sign rule of
  // the protocol, which is the text of the cosign folder: their hashes changed when the manifest took that text. The hashes of the sourcing agent changed again when the sentence of the fault
  // `invert_scores` named the score as well as the component scores: the text of the sentence is the only change in its bytes.
  const BEFORE: Record<AgentKind, readonly [string, string]> = {
    'reorder-agent': ['50412dc22240e71c27ee270c185200d21b4534e1ff837dc504430eabf9dba6d4', '5515e2e5aef6aa3daef8c018703eb76bc64599a6728a22051aebc09bb4c972ba'],
    'prior-authorization-agent': ['775a40c3030da02df81f7d815a6f56f4e4fb93f69d5b396d82eded5f4e28fdd0', '118d4c7c1f7040c5a35e044ffdd20fef6de30783efa5f55addbc7ca4c52cda79'],
    'sourcing-agent': ['d0d530a1309712e8589ff6da0849417558e6f336756de0395e4ca9f85d3c6fc5', '2a1493900cab4285bb49c6dcf91b7d22fee3a450c30c648a88106fba1b3c0cdb'],
    'order-desk': ['19dd2112bdf5bbaf208fb4c95e6b2b3e64baf6248948cb4f95438043e8943407', '7e40a3d214255d15460e7e10b797ae6dea30ffa2fe048d66949f231916ec19d3'],
    'insurer-intake-agent': ['3e73274e87226859803a2d8dfa3949423a469ad536c7928e006bc6669c2d35bf', 'ca60abefd3b9328c94d9c9580a82ca6c853ed4b57e7c0b6f2346c6c5230ab9f6'],
    'bid-desk': ['10ad5430b6a93005afc694d2f9d9cf850aac8a1f2b757801b575abed65330976', '9c5f38960883fd2cd758b51c67cf99a9aed220ab981f0fa6533b6c72a495a02e'],
  };

  it.each(AGENT_KINDS)('are the same as before for %s, for every setting: the served text and the template', (kind) => {
    for (const setting of ['', ...FAULT_MODES[kind]]) {
      const served = unwrap(renderManifest(kind, () => { readFaultSwitch(kind, setting); return sampleManifest(kind); }));
      const template = unwrap(renderManifest(kind, () => { readFaultSwitch(kind, setting); return sampleManifest(kind, { template: true }); }, { template: true }));
      expect([served.sha256, template.sha256], `${kind} ${setting}`).toStrictEqual([...BEFORE[kind]]);
    }
  });
});
