// scripts/checks/lib/record.ts - the test record, read from the ledger before a step builds anything.
// A check acts on one record. Before it builds, it reads the record and refuses to go on when the record is not the one that the operator means: it is not in the registry, it is not
// Active, the controller key that the operator gave is not its controller, or it does not list a key that the step needs with the purpose that the step needs.
import { PURPOSE, effectiveStatus, findRecord, keyHashOf } from './platform.ts';
import { PreconditionError } from './session.ts';
import type { Session } from './session.ts';

export interface RecordFacts {
  id: string;
  did: string;
  controllerHash: string;
  keys: Array<{ keyHash: string; purposes: number }>;
}

export interface RecordNeeds {
  /** The agent key must be listed with the delegation purpose. */
  delegationKey?: boolean;
  /** The authentication key (the agent key unless the operator gave another) must be listed with the authentication purpose. */
  authenticationKey?: boolean;
}

export async function requireRecord(session: Pick<Session, 'chain' | 'settings' | 'ring' | 'authKey' | 'clock' | 'out'>, needs: RecordNeeds = {}): Promise<RecordFacts> {
  const { recordId, recordDid } = session.settings;
  const found = await findRecord(session.chain.provider, session.chain.deployment, recordId);
  if (found === null) throw new PreconditionError(`the record ${recordDid} is not in the identity registry: check CHECKS_RECORD, and wait for its registration to be confirmed`);
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the record ${recordDid} is a subagent: the checks run on a root record`);
  const now = session.clock.now();
  const status = effectiveStatus(found.record, new Map(), now, now);
  if (status !== 'Active') throw new PreconditionError(`the record ${recordDid} is ${status}: it must be Active`);
  const controllerHash = keyHashOf(found.record.controller);
  const given = session.ring.find('controller');
  if (given !== undefined && given.keyHash !== controllerHash) throw new PreconditionError(`the controller key that was given is not the controller of the record ${recordDid}: this is the wrong record or the wrong key`);
  const keys = found.record.keys.filter((key) => key.keyType === 'Ed25519').map((key) => ({ keyHash: keyHashOf(key.key), purposes: key.purposes }));
  const listed = (keyHash: string, purpose: number): boolean => keys.some((key) => key.keyHash === keyHash && (key.purposes & purpose) !== 0);
  const agent = session.ring.find('agent');
  if (needs.delegationKey === true && (agent === undefined || !listed(agent.keyHash, PURPOSE.delegation))) {
    throw new PreconditionError(`the record ${recordDid} does not list the agent key with the delegation purpose`);
  }
  if (needs.authenticationKey === true && (session.authKey === null || !listed(session.authKey.keyHash, PURPOSE.authentication))) {
    throw new PreconditionError(`the record ${recordDid} does not list the authentication key with the authentication purpose`);
  }
  session.out.out(`the record ${recordDid} is Active${given === undefined ? '' : ', and its controller is the controller key that was given'}${needs.delegationKey === true ? '; it lists the agent key with the delegation purpose' : ''}${needs.authenticationKey === true ? '; it lists the authentication key with the authentication purpose' : ''}`);
  return { id: recordId, did: recordDid, controllerHash, keys };
}
