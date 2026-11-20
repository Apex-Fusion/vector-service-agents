// packages/usecase-kit/test/fault/isolation.test.ts: a fault never changes a check. A fault value changes what an agent sends or decides in its own job. It never changes whether a check of a
// counterparty, a verifier or a limit runs. The proof is that a check has no parameter for a fault value and a message has no member for one. The typecheck is part of the test: a line that must
// not compile carries a `@ts-expect-error`.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { checkRequestSize, makeProposal, parseApprovalRef, parseHandoff, parseRequest, parseRfq } from '@vsa/usecase-kit/protocol';
import type { ApprovalInput } from '@vsa/usecase-kit/protocol';
import { APPROVAL, AUTHORITY, DID_A, DELEGATION, DOCUMENT, SALT, TENANT } from '../protocol/support.ts';

type FaultKey = 'fault_mode' | 'fault_modes' | 'fault' | 'FAULT_MODE' | 'faultMode';

const INPUT: ApprovalInput = { approval: APPROVAL, sender_did: DID_A, delegation: DELEGATION, document: DOCUMENT, salt: SALT, now_ms: 1_780_000_000_000 };
const PROPOSE = { op: 'propose', authority: AUTHORITY, tenant: TENANT };
const HANDOFF = { schema: 'vector.usecase.handoff.v1', use_case: 'inventory-reorder', sender_did: DID_A, delegation: DELEGATION, document: DOCUMENT, salt: SALT, approval: APPROVAL };
const RFQ = { schema: 'vector.usecase.rfq.v1', sender_did: DID_A, delegation: DELEGATION, rfq: { rfq_id: 'rfq-1', items: [{ sku: 'SKU-100', quantity: 100 }], needed_by: '2026-12-20' } };

describe('a check has no parameter for a fault value', () => {
  it('gives the input of the approval check no member for a fault value, and refuses one in a literal', () => {
    expectTypeOf<Extract<keyof ApprovalInput, FaultKey>>().toEqualTypeOf<never>();
    // @ts-expect-error the approval check has no place for a fault value
    const withFault: ApprovalInput = { ...INPUT, fault_mode: 'confirm_wrong_lot' };
    expect(Object.keys(INPUT)).toStrictEqual(['approval', 'sender_did', 'delegation', 'document', 'salt', 'now_ms']);
    expect(withFault.now_ms).toBe(INPUT.now_ms);
  });

  it('gives the request limit one parameter, the wire payload, and the same answer for any other argument', () => {
    expect(checkRequestSize('{}')).toStrictEqual({ ok: true, value: 2 });
    // @ts-expect-error the limit check takes no fault value
    expect(checkRequestSize('{}', 'confirm_wrong_lot')).toStrictEqual(checkRequestSize('{}'));
    const tooBig = 'x'.repeat(900_001);
    // @ts-expect-error the limit check takes no fault value
    expect(checkRequestSize(tooBig, 'confirm_wrong_lot')).toMatchObject({ ok: false, code: 'request_too_large' });
    expect(checkRequestSize(tooBig)).toMatchObject({ ok: false, code: 'request_too_large' });
  });
});

describe('a message has no member for a fault value', () => {
  const names = ['fault_mode', 'FAULT_MODE', 'fault', 'faultMode'];

  it('refuses a request that carries a fault value, and takes the same request without it', () => {
    expect(parseRequest(PROPOSE)).toMatchObject({ ok: true });
    for (const name of names) {
      expect(parseRequest({ ...PROPOSE, [name]: 'confirm_wrong_lot' }), name).toStrictEqual({ ok: false, code: 'bad_shape', detail: `request has the member "${name}", which is not allowed` });
    }
    const proposal = makeProposal(DOCUMENT, SALT);
    if (!proposal.ok) throw new Error(proposal.detail);
    const execute = { op: 'execute', authority: AUTHORITY, tenant: TENANT, proposal: proposal.value, approval: null };
    expect(parseRequest(execute)).toMatchObject({ ok: true });
    for (const name of names) expect(parseRequest({ ...execute, [name]: 'alter_after_approval' }), name).toMatchObject({ ok: false, code: 'bad_shape' });
  });

  it('refuses a handoff, a request for quotation and an approval reference that carry a fault value, and takes them without it', () => {
    expect(parseHandoff(HANDOFF)).toMatchObject({ ok: true });
    expect(parseRfq(RFQ)).toMatchObject({ ok: true });
    expect(parseApprovalRef(APPROVAL)).toMatchObject({ ok: true });
    for (const name of names) {
      expect(parseHandoff({ ...HANDOFF, [name]: 'confirm_wrong_lot' }), name).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(parseRfq({ ...RFQ, [name]: 'quote_off_price_list' }), name).toMatchObject({ ok: false, code: 'bad_shape' });
      expect(parseApprovalRef({ ...APPROVAL, [name]: 'confirm_wrong_lot' }), name).toMatchObject({ ok: false, code: 'bad_shape' });
    }
  });
});

describe('the folders of the fault switch and of the manifest', () => {
  const folder = (name: string): { file: string; text: string }[] => {
    const directory = new URL(`../../src/${name}/`, import.meta.url);
    return readdirSync(directory).filter((file) => file.endsWith('.ts')).map((file) => ({ file: `${name}/${file}`, text: readFileSync(new URL(file, directory), 'utf8') }));
  };

  it('import the protocol and the workspace packages only, and no other folder of the package', () => {
    for (const { file, text } of [...folder('fault'), ...folder('manifest')]) {
      for (const [, path] of text.matchAll(/^(?:import|export)[^;]*? from '([^']+)'/gm)) {
        expect(path.startsWith('./') || path === '../protocol/index.ts' || path.startsWith('@vsa/') || path.startsWith('node:'), `${file} imports ${path}`).toBe(true);
      }
    }
  });

  it('give the manifest no way to read the active fault value: the manifest folder never names the switch', () => {
    const names = /\b(FaultSwitch|readFaultSwitch|parseFaultSetting|withFaultMode|withFaultModeJob|readFaultMode|checkFaultMode|checkCleanRun|checkFaultRun|FAULT_MODE_VARIABLE)\b/;
    for (const { file, text } of folder('manifest')) {
      expect(text, file).not.toMatch(names);
      expect(text, file).not.toMatch(/from '\.\.\/fault/);
    }
  });

  it('give the fault folder no way to change a manifest: it never names the manifest folder or its builders', () => {
    for (const { file, text } of folder('fault')) {
      expect(text, file).not.toMatch(/from '\.\.\/manifest/);
      expect(text, file).not.toMatch(/\b(buildBehaviour|renderManifest|parseBehaviourAdditions|withFaultGap)\b/);
    }
  });
});
