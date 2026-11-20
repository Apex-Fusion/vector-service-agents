// packages/usecase-kit/src/checks/shared.ts
// The checks that every counterparty makes before it does the work, as a list for `runChecks`, in this order:
//   sender_active, sender_accountable, sender_key              (the sender)
//   delegation, delegation_usable                              (the delegation)
//   vault_paid                                                 (the escrow was paid from a vault of that delegation)
//   approval_found, approval_type, approval_subject, approval_issuer, approval_valid, approval_digest   (the approval: the Order Desk and the Insurer Intake Agent)
// A bid desk gets a request for quotation. It carries no approval, so its list ends after `vault_paid`.
//
// What a pass learns, as facts: `organisation` and `organisation_verified` (the organisation of the sender and whether the gateway verified it: recorded, never a reason to refuse),
// and for an approval `approval_attestation`, `approval_issuer_did`, `approval_issuer_key_hash` and `approval_valid_until`.
//
// The buyer key is the key hash of the job context. The runtime read it from the escrow on the ledger.
// Nothing in the body of the request names it. A member of the body that looks like a buyer key is not read.
import type { JobContext } from '@vsa/service-kit';
import type { Resolution } from '@vsa/id-kit/client';
import { COUNTERPARTY_KINDS, HANDOFF_SCHEMA, RFQ_SCHEMA, accepted, isPlainObject, parseDelegationId, parseDid, parseOutputRef, refused } from '../protocol/index.ts';
import type { CounterpartyKind, Did, Handoff, RfqMessage } from '../protocol/index.ts';
import { checkApproval } from './approval.ts';
import { checkDelegationNamesSender, checkDelegationUsable, checkVaultPaid } from './delegation.ts';
import { CheckUnavailableError, badAnswer, nowOf, readThrough, reportFault } from './ports.ts';
import type { ChecksPorts } from './ports.ts';
import type { CheckStep } from './run.ts';
import { checkSenderAccountable, checkSenderActive, checkSenderKey } from './sender.ts';
import type { ResolvedSender } from './sender.ts';

/** The request that a counterparty of this kind takes: a handoff, or for a bid desk a request for quotation. */
export type RequestOf<K extends CounterpartyKind> = K extends 'bid-desk' ? RfqMessage : Handoff;

/** What the shared checks need: the kind, the request that the service parsed, and the job context of the runtime. */
export type SharedInput =
  | { readonly kind: 'order-desk' | 'insurer-intake-agent'; readonly request: Handoff; readonly context: JobContext }
  | { readonly kind: 'bid-desk'; readonly request: RfqMessage; readonly context: JobContext };

const SENDER = ['sender_active', 'sender_accountable', 'sender_key'] as const;
const DELEGATION = ['delegation', 'delegation_usable', 'vault_paid'] as const;
const APPROVAL = ['approval_found', 'approval_type', 'approval_subject', 'approval_issuer', 'approval_valid', 'approval_digest'] as const;

/** The name of each shared check of each kind, in the order that they run. A service that answers with a `checks` object takes the names from here, and adds the names of its own checks. */
export const SHARED_CHECK_NAMES = {
  'order-desk': [...SENDER, ...DELEGATION, ...APPROVAL],
  'insurer-intake-agent': [...SENDER, ...DELEGATION, ...APPROVAL],
  'bid-desk': [...SENDER, ...DELEGATION],
} as const satisfies Record<CounterpartyKind, readonly string[]>;

const KEY_HASH = /^[0-9a-f]{56}$/;

/** A TypeError for an input of the wrong form. The message names the field and never the value. */
function assertShared(input: SharedInput): void {
  if (!isPlainObject(input) || !isPlainObject(input.request) || !isPlainObject(input.context)) throw new TypeError('the shared checks need a kind, a request and a job context');
  if (!(COUNTERPARTY_KINDS as readonly unknown[]).includes(input.kind)) throw new TypeError(`kind must be one of ${COUNTERPARTY_KINDS.join(', ')}`);
  const schema = input.kind === 'bid-desk' ? RFQ_SCHEMA : HANDOFF_SCHEMA;
  if (input.request.schema !== schema) throw new TypeError(`a request to a ${input.kind} must have the schema ${schema}`);
  const checked = [
    parseDid(input.request.sender_did, 'request.sender_did'), parseDelegationId(input.request.delegation, 'request.delegation'), parseOutputRef(input.context.escrowRef, 'context.escrowRef'),
  ];
  for (const part of checked) if (!part.ok) throw new TypeError(`the input of the shared checks is wrong: ${part.detail}`);
  if (typeof input.context.buyerPkh !== 'string' || !KEY_HASH.test(input.context.buyerPkh)) throw new TypeError('the input of the shared checks is wrong: context.buyerPkh must be 56 lower-case hex characters');
}

/** The DID resolution of the sender. A failed call, and a resolution of another DID, are a source that did not answer. */
async function resolveSender(ports: ChecksPorts, sender: Did): Promise<Resolution> {
  const result = await readThrough(ports, 'identity gateway', () => ports.gateway.resolve(sender));
  if (result.ok !== true) {
    reportFault(ports, 'identity gateway', new Error(`${String(result.rule)}: ${String(result.detail)}`));
    throw new CheckUnavailableError('identity gateway');
  }
  const resolution = result.value;
  if (resolution.did !== sender || (resolution.kind === 'resolved' && resolution.document.id !== sender)) return badAnswer(ports, 'identity gateway', 'it is not the resolution of the sender');
  return resolution;
}

/**
 * The shared checks of a counterparty kind, as the steps of one run. The list is for one request: it reads the clock once, when it is made, so that every check uses the same time, and its
 * steps share what an earlier step read. Run it with `runChecks`, and add the checks of the kind after it. It throws a TypeError for an input of the wrong form.
 */
export function sharedChecks(ports: ChecksPorts, input: SharedInput): CheckStep[] {
  assertShared(input);
  const now = nowOf(ports);
  const { request, context } = input;
  const sender = request.sender_did;
  const delegation = request.delegation;
  let resolved: ResolvedSender | null = null;
  const senderRecord = (): ResolvedSender => {
    if (resolved === null) throw new TypeError('the check of the sender ran before the sender was read');
    return resolved;
  };

  const steps: CheckStep[] = [
    {
      names: ['sender_active'],
      run: async () => {
        const active = checkSenderActive(await resolveSender(ports, sender));
        if (!active.ok) return active;
        resolved = active.value;
        return accepted({});
      },
    },
    {
      names: ['sender_accountable'],
      run: async () => {
        const accountable = checkSenderAccountable(senderRecord(), now);
        return accountable.ok ? accepted({ organisation: accountable.value.organisation, organisation_verified: accountable.value.organisationVerified }) : accountable;
      },
    },
    {
      names: ['sender_key'],
      run: async () => {
        const key = checkSenderKey(senderRecord(), context.buyerPkh);
        return key.ok ? accepted({}) : key;
      },
    },
    {
      names: ['delegation'],
      run: async () => {
        const view = await readThrough(ports, 'delegation', () => ports.ledger.readDelegation(delegation));
        const named = checkDelegationNamesSender(view, delegation, sender, context.buyerPkh);
        return named.ok ? accepted({}) : named;
      },
    },
    {
      names: ['delegation_usable'],
      run: async () => {
        const use = await readThrough(ports, 'delegation use', () => ports.ledger.delegationUse(delegation, now));
        const usable = checkDelegationUsable(use, delegation, now);
        return usable.ok ? accepted({}) : usable;
      },
    },
    {
      names: ['vault_paid'],
      run: async () => {
        const paid = await readThrough(ports, 'vault payment', () => ports.ledger.escrowPaid(context.escrowRef, delegation));
        const checked = checkVaultPaid(paid, context.escrowRef, delegation);
        return checked.ok ? accepted({}) : checked;
      },
    },
  ];
  if (input.kind === 'bid-desk') return steps;

  const handoff = input.request;
  steps.push({
    names: APPROVAL,
    run: async () => {
      const result = await checkApproval(ports, { approval: handoff.approval, sender_did: sender, delegation, document: handoff.document, salt: handoff.salt, now_ms: now });
      if (result.ok) {
        return accepted({
          approval_attestation: result.attestation, approval_issuer_did: result.issuer_did, approval_issuer_key_hash: result.issuer_key_hash, approval_valid_until: result.valid_until,
        });
      }
      if (result.code === 'approval_digest_mismatch') {
        return { ...refused(result.code, result.detail), digests: { expected_digest: result.expected_digest, observed_digest: result.observed_digest } };
      }
      return refused(result.code, result.detail);
    },
  });
  return steps;
}
