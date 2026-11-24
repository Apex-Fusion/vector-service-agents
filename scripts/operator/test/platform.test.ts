// The names that the tasks of the operator pack take from lib/platform.ts. A name that is not there is undefined at run time, and a type error in the list below, so the test fails.
import { describe, expect, it } from 'vitest';
import * as platform from '../lib/platform.ts';

/** The names that the tasks call, and nothing else: the list is typed against the module, so a name that the module lacks does not compile. */
const NAMES = [
  // the kit of the use-case agents
  'Dispute', 'createModule1Port', 'claimDocument', 'evidenceDocument', 'MAX_CLAIM_TYPE_BYTES', 'withdrawableFrom', 'addToAllowlist', 'parseAllowlist', 'checkCleanRun', 'checkFaultRun',
  'FAULT_MODE_VARIABLE', 'isFaultSetting', 'REORDER_CLAIM', 'ORDER_DESK_CLAIM', 'INVENTORY_CAPABILITIES', 'LOT_NAMES', 'parseOrderConfirmation', 'parsePurchaseOrder', 'canonicalJson',
  'canonicalSha256', 'requestRouteToken', 'keyObjectOfRawKey',
  // buyer-core
  'ensureSlotConfig', 'buildSubmitClaim', 'buildDocumentPublish', 'buildWithdrawClaim', 'readManifest', 'module1FromManifest', 'liveDelegations', 'readDelegation', 'readVaults',
  'checkAttestation', 'envelopeSigStructure', 'envelopeVerifies', 'ATT_TYPES',
  // id-kit
  'createGatewayClient',
] as const satisfies readonly (keyof typeof platform)[];

/** The names of the checks that the pack takes through the same module. */
const FROM_CHECKS = ['lucidForAddress', 'buildAttest', 'buildWithdrawAttestation', 'buildDelegate', 'buildUndelegate', 'signTransaction', 'findRecord', 'effectiveStatus', 'PURPOSE', 'OgmiosProvider', 'decodeTransaction', 'decodeVaultDatum', 'keyHashOf'] as const satisfies readonly (keyof typeof platform)[];

describe('lib/platform.ts', () => {
  it('gives each name that a task of the pack calls', () => {
    for (const name of NAMES) expect(platform[name], name).toBeDefined();
  });
  it('gives each name that the checks give, because it re-exports the platform of the checks', () => {
    for (const name of FROM_CHECKS) expect(platform[name], name).toBeDefined();
  });
  it('gives the real values and not another export of the same name: the fault variable, the claim type limit, the attestation types and the claim texts of the two agents', () => {
    expect(platform.FAULT_MODE_VARIABLE).toBe('FAULT_MODE');
    expect(platform.MAX_CLAIM_TYPE_BYTES).toBe(64);
    expect(platform.ATT_TYPES.provenance).toBe(1);
    expect(platform.ATT_TYPES.software).toBe(2);
    expect(platform.INVENTORY_CAPABILITIES).toEqual({ reorder: 'supplychain.reorder.po.v1', order: 'supplychain.order.accept.v1' });
    expect(platform.REORDER_CLAIM.statements.map((statement) => statement.id)).toEqual(['S1', 'S2', 'S3']);
    expect(platform.ORDER_DESK_CLAIM.statements.map((statement) => statement.id)).toEqual(['S1', 'S2', 'S3']);
    expect(platform.isFaultSetting('order-desk', 'confirm_wrong_lot')).toBe(true);
    expect(platform.isFaultSetting('reorder-agent', 'confirm_wrong_lot')).toBe(false);
  });
  it('gives the functions that a task calls as functions', () => {
    for (const name of ['canonicalJson', 'canonicalSha256', 'ensureSlotConfig', 'envelopeVerifies', 'addToAllowlist', 'parseAllowlist', 'checkCleanRun', 'createGatewayClient'] as const) {
      expect(typeof platform[name], name).toBe('function');
    }
    expect(typeof platform.Dispute).toBe('function');
  });
});
