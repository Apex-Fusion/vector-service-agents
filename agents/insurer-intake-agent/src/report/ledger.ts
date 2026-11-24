// agents/insurer-intake-agent/src/report/ledger.ts
// The real ports of the report: the readers of buyer-core on a ledger env (the node, the deployment and Koios). Each port is one call of a reader, and each reader ends inside the budget of the env
// (`withinBudget`). No other read is made, and nothing is built, signed or sent.
//
//   list               the attestations about the sender of one type, as rows. The page is the largest page of the reader. A list that is cut short throws, because the rows that are left out could be the
//                      rows of the expected issuer: a list that is not whole is a source that was read in part, and the report never reads it as `absent`.
//   check              the rule of the registry at the time, and the expectation of the report: the type, the subject and the issuer.
//   providerKeyHashOf  the key hash of the signer of the first Provider party of the record of the sender that is in force at the time and that a key signs for. A record that cannot be found throws. Null is
//                      only a record with no such party: a party that has ended or has not started, and a party that a script or the controller set signs for, do not count (they sign for no attestation).
//   rootDelegatorOf    the delegator of the last link of the chain of the delegation. A chain that is empty, or that does not end at a root (a parent was ended), has no root delegator: null.
//
// A read that fails throws. The report reads a throw as a source that cannot be read, and never as an empty list, a record with no Provider, a delegation with no root or an attestation that is not valid.
import { MAX_PAGE, checkAttestation, findRecord, listAttestations, readDelegation, withinBudget } from '@vsa/buyer-core';
import type { IssuerRef, LedgerEnv } from '@vsa/buyer-core';
import type { Clock } from '@vsa/usecase-kit/access';
import { agentIdOf } from '@vsa/usecase-kit/protocol';
import { blake2b224Hex } from '@vsa/vector-read';
import type { ReportDeps, ReportExpectation, ReportRoot, ReportRow } from './ports.ts';

/** The issuer of an expectation as the reader names it: a key hash, or the id of a record. An expectation that names both, or neither, is a fault of the caller and is refused. */
function issuerRefOf(issuer: ReportExpectation['issuer']): IssuerRef {
  if ('key_hash' in issuer && !('did' in issuer)) return { type: 'key_hash', hash: issuer.key_hash };
  if ('did' in issuer && !('key_hash' in issuer)) return { type: 'did', id: agentIdOf(issuer.did) };
  throw new TypeError('the expected issuer names a key hash or a DID, and never both and never neither');
}

/**
 * The ports of the report over the real readers of buyer-core. The env holds the node, the deployment, Koios and the budget of one read: give it a budget that is not longer than the read budget of the
 * report, so that a read that the report gave up on ends by itself soon after.
 */
export function ledgerReportDeps(env: LedgerEnv, options: { readonly clock: Clock; log(line: string): void }): ReportDeps {
  return {
    clock: options.clock,
    log: (line) => options.log(line),

    async list(subject, attType) {
      const page = await listAttestations(env, { subject, attType, limit: MAX_PAGE });
      if (page.nextOffset !== null) throw new Error('more attestations match than one page holds, so the list is not whole');
      return page.items.map((view): ReportRow => ({
        id: view.id,
        issuer_key_hash: blake2b224Hex(view.attestation.issuer),
        issuer_id: view.attestation.issuerId,
        issued_at: view.attestation.issuedAt,
      }));
    },

    async check(id, atMs, expect) {
      const checked = await checkAttestation(env, { id, atMs, expect: { attType: expect.attType, subject: expect.subject, issuer: issuerRefOf(expect.issuer) } });
      return checked.valid;
    },

    async providerKeyHashOf(sender, atMs) {
      if (!Number.isSafeInteger(atMs) || atMs < 0) throw new TypeError('the time of the check must be a whole number of milliseconds since 1970');
      const found = await withinBudget(env, (inside) => findRecord(inside.provider, inside.deployment, agentIdOf(sender)));
      if (found === null) throw new Error('the registry holds no record of the sender');
      // The Provider is the first party that a key signs for and that is in force at the time: its start is not after the time, and it has no end or its end is not before the time.
      for (const party of found.record.parties) {
        if (party.role === 'Provider' && party.signer.type === 'KeyHash' && party.notBefore <= atMs && (party.notAfter === null || atMs <= party.notAfter)) return party.signer.hash;
      }
      return null;
    },

    async rootDelegatorOf(delegation): Promise<ReportRoot | null> {
      const { chain } = await readDelegation(env, delegation);
      if (chain.length === 0) return null;
      // Each link names the next one as its parent. A last link that names a parent that was ended is not a root.
      for (let index = 0; index < chain.length; index += 1) {
        const parent = index + 1 < chain.length ? chain[index + 1].id : null;
        if (chain[index].delegation.parent !== parent) return null;
      }
      const delegator = chain[chain.length - 1].delegation.delegator;
      return delegator.type === 'PrincipalKey' ? { type: 'key', hash: delegator.hash } : { type: 'agent', id: delegator.id };
    },
  };
}
