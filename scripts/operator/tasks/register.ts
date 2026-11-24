// scripts/operator/tasks/register.ts - the task `register`: it registers the records of a use case (each agent, then its subagents) with the hosted tool `vector_build_identity_register`, signs in
// process with the keys of the registry, and then waits until the gateway shows the organisation of each agent as verified. The order matters, and the gate is in code:
//   1. A dry run builds the record and prints its DID (the DID follows the largest pure output of the `fee` wallet), the TXT name `_did.<domain>` and the TXT value (the DID). It looks nothing
//      up. It writes the note `dry.<step>` with the DID and the TXT value that it printed, and nothing else.
//   2. The workstation publishes the TXT value.
//   3. `run --submit` builds again and reads the DID of THAT build. Before the signature it checks, in this order: the consent of Module-1 (lib/consent.ts), the note of the dry run, that the DID of
//      the note is the DID of the build, and that three public resolvers show the TXT value (lib/dns.ts). A resolver is asked about a name only after a dry run printed its value: a resolver
//      keeps the answer "no record" for a name that it was asked about too early. A record with no organisation (a subagent) has no TXT and needs no note.
//   4. After the registration the step `organisation:<agent>` asks the gateway until it shows organisationVerified for the Accountable party of the record. It is a wait, and a wait is never a
//      failure before its time. It takes no transaction.
// The signers are exactly the keys that the data names, the plan has the identity address as its one destination, one identity token as its mint, and one withdrawal for a record with a Module-1
// party. The record is permanent: the step carries the tag `record`. Each step checks the record on the node after it landed.
import { collateralAdvice, isCollateralOutput } from '../../checks/lib/collateral.ts';
import { duration, iso, units } from '../../checks/lib/format.ts';
import { GuardRefusal } from '../../checks/lib/land.ts';
import { PreconditionError } from '../../checks/lib/session.ts';
import type { ChainAccess, StepOutcome } from '../../checks/lib/session.ts';
import type { StepRecord } from '../../checks/lib/state.ts';
import type { OutputFacts, TxFacts } from '../../checks/lib/txfacts.ts';
// The entry of buyer-core gives neither of these two tables of the identity rules, so they come by the path of their file: the rights of each party role by default, and the bit of each right.
import { RIGHT, ROLE_MAX_RIGHTS } from '../../../packages/buyer-core/src/vendored/mcp/identity-rules.ts';
// The entry of vector-read gives no codec of the identity datums either: `decodeIdentityDatum` reads the inline datum of a record output, as `findRecord` does.
import { decodeIdentityDatum } from '../../../packages/vector-read/src/identity-codec.ts';
import { checkConsentWithdrawal } from '../lib/consent.ts';
import type { HostedBuild, HostedLandSpec, KeyPurpose, KeyUse, OrganisationSpec, PartySpec, TaskDefinition, TaskSession, UseCase } from '../lib/contract.ts';
import { checkTxt } from '../lib/dns.ts';
import { landHosted } from '../lib/land-hosted.ts';
import type { Landed } from '../lib/land-hosted.ts';
import { planOf } from '../lib/plan.ts';
import { PURPOSE, createGatewayClient, effectiveStatus, findRecord, keyHashOf } from '../lib/platform.ts';
import type { RecordUtxo } from '../lib/platform.ts';
import type { Registry } from '../lib/registry.ts';
import { runSteps } from '../lib/runner.ts';
import type { StepHandler } from '../lib/runner.ts';

const TOOL = 'vector_build_identity_register';
/** The units that a record locks: the least that the registry takes. The plan allows the deposit and the fee limit to leave the `fee` wallet, and no more. */
const DEPOSIT_UNITS = 10;
const DEPOSIT_LOVELACE = 10_000_000n;
const VALID_MINUTES = 30;
/** How long after the registration the gateway has to show the organisation, and how often it scans (the text of a wait and of a failure says both). */
const ORGANISATION_LIMIT_MS = 45 * 60_000;
const PARENT_RETRY_MS = 60_000;
const DID_PREFIX = 'did:vector:';
const IDENTIFIER = /^[0-9a-f]{64}$/;
const MAX_REASON_CHARS = 200;

/** What the task keeps for the machine line of the run. The runner reads it after the run, through `result`. */
interface Extra { result: Record<string, unknown> | null }
type Session = TaskSession<Extra>;

/** One record of the data: an agent, or a subagent of an agent. The data of the subagent has no parties, no endpoint and no capability: its one party is the controller. */
interface Subject {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly keys: readonly KeyUse[];
  readonly endpoint: string | null;
  readonly capability: string | null;
  readonly parties: readonly PartySpec[];
  readonly guardianThreshold: number;
  /** The id of the parent agent, or null for an agent. */
  readonly parent: string | null;
  readonly organisation: OrganisationSpec | null;
}

interface Txt { name: string; value: string }

const CONTROLLER_PARTY: PartySpec = { role: 'Accountable', signer: { kind: 'controller' }, organisation: null, rights: null };

/** The records in the order of the steps: each agent, and after it the subagents that name it as their parent. A subagent whose parent is no agent of the data is a mistake of the data. */
function subjectsOf(use: UseCase): Subject[] {
  const subjects: Subject[] = [];
  for (const agent of use.agents) {
    const organisation = use.organisations.find((one) => one.id === agent.organisation);
    if (organisation === undefined) throw new Error(`the agent ${agent.id} names the organisation ${agent.organisation}, and the data lists no such organisation`);
    subjects.push({
      id: agent.id, name: agent.name, description: agent.description, keys: agent.keys, endpoint: agent.endpoint, capability: agent.capability, parties: agent.parties,
      guardianThreshold: agent.guardianThreshold, parent: null, organisation,
    });
    for (const sub of use.subagents.filter((one) => one.parent === agent.id)) {
      subjects.push({ id: sub.id, name: sub.name, description: sub.description, keys: sub.keys, endpoint: null, capability: null, parties: [CONTROLLER_PARTY], guardianThreshold: 0, parent: agent.id, organisation: null });
    }
  }
  const orphan = use.subagents.find((sub) => !use.agents.some((agent) => agent.id === sub.parent));
  if (orphan !== undefined) throw new Error(`the subagent ${orphan.id} names the parent ${orphan.parent}, and the data lists no such agent`);
  return subjects;
}

/** The names of the keys that sign a registration: the controller, the `fee` wallet, each listed key and each party that is a key. A name is counted once: a Guardian that is the controller key merges. */
function signersOf(subject: Subject): string[] {
  const names = ['controller', 'fee', ...subject.keys.map((use) => use.key), ...subject.parties.flatMap((party) => (party.signer.kind === 'key' ? [party.signer.key] : []))];
  return [...new Set(names)];
}

const holdsModule1 = (subject: Subject): boolean => subject.parties.some((party) => party.signer.kind === 'module1');
const txtOf = (subject: Subject, did: string): Txt | null => (subject.organisation === null ? null : { name: `_did.${subject.organisation.domain}`, value: did });
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_CHARS);

// ---- the arguments of the tool ----

function partyArgs(registry: Registry, party: PartySpec): Record<string, unknown> {
  const signer = party.signer.kind === 'controller' ? 'controller' : party.signer.kind === 'module1' ? 'module1' : registry.hashOf(party.signer.key);
  return { role: party.role, signer, ...(party.organisation === null ? {} : { organisation: party.organisation }), ...(party.rights === null ? {} : { rights: [...party.rights] }) };
}

/** The arguments of the tool, from the data and the keys of the registry. Nothing here is typed by hand: a name, a key, a party and a limit each come from a value. */
function argsOf(session: Session, subject: Subject, parentDid: string | null): Record<string, unknown> {
  const registry = session.registry;
  return {
    changeAddress: registry.addressOf('fee'), controller: registry.publicKeyOf('controller'), name: subject.name, description: subject.description,
    ...(subject.endpoint === null ? {} : { endpoint: subject.endpoint }),
    ...(subject.capability === null ? {} : { capabilities: [subject.capability] }),
    keys: subject.keys.map((use) => ({ key: registry.publicKeyOf(use.key), purposes: [...use.purposes] })),
    parties: subject.parties.map((party) => partyArgs(registry, party)),
    guardian_threshold: subject.guardianThreshold, deposit: DEPOSIT_UNITS, valid_minutes: VALID_MINUTES,
    ...(parentDid === null ? {} : { parent: parentDid }),
  };
}

// ---- what the build says about itself ----

/** The DID and the identifier that the answer of the tool gives. The DID must be `did:vector:` and the identifier: an answer that says another thing is wrong about its own build. */
function identityOf(build: HostedBuild): { did: string; id: string } {
  const { did, id } = build.json;
  if (typeof id !== 'string' || !IDENTIFIER.test(id)) throw new Error(`the answer of ${TOOL} has no id of 64 lower-case hex characters`);
  if (did !== `${DID_PREFIX}${id}`) throw new Error(`the answer of ${TOOL} gives the DID ${String(did).slice(0, MAX_REASON_CHARS)}, and the DID of its id is ${DID_PREFIX}${id}`);
  return { did, id };
}

/** The one output of the bytes that holds the identity token at the identity address: the record output. Another number of such outputs is a refusal. */
function recordOutputOf(step: string, deployment: ChainAccess['deployment'], id: string, facts: TxFacts): OutputFacts {
  const unit = `${deployment.identity.hash}${id}`;
  const found = facts.outputs.filter((output) => output.address === deployment.identity.address && output.assets[unit] === 1n);
  if (found.length !== 1) {
    throw new GuardRefusal(step, [{ guard: 'mint', ok: false, message: `the transaction has ${found.length} output(s) at the identity address that hold the identity token ${id}, and a registration has exactly one` }]);
  }
  return found[0]!;
}

// ---- the note of the dry run, and the TXT gate ----

/** What the dry run of a step wrote into its note: the DID and the TXT name and value that it printed. */
interface Note { did: string; txtName: string; txtValue: string }

/** The note of the dry run of a step, or null when it is missing or is not a note of this form: a note that lacks a member counts as no note. */
function noteOf(session: Session, step: string): Note | null {
  const note = session.state.note<unknown>(`dry.${step}`);
  if (typeof note !== 'object' || note === null || !('did' in note) || !('txtName' in note) || !('txtValue' in note)) return null;
  const { did, txtName, txtValue } = note;
  return typeof did === 'string' && typeof txtName === 'string' && typeof txtValue === 'string' ? { did, txtName, txtValue } : null;
}

/**
 * The gate before the signature of a record that has a TXT: the dry run wrote its note, the note holds the DID, the TXT name and the TXT value of this build, and three public resolvers show the
 * value. The note comes first and no resolver is asked before it: a missing note, a note of another DID, and a note of another name or value (the data changed) stop the run with no lookup. So a
 * resolver is asked only for a name and a value that a dry run printed.
 */
async function requireTxt(session: Session, step: string, did: string, txt: Txt): Promise<void> {
  const noted = noteOf(session, step);
  if (noted === null) {
    throw new PreconditionError(`the step ${step} has no note of a dry run: run the dry run, publish the TXT value, then run again with --submit. The dry run shows the TXT name and the TXT value.`);
  }
  if (noted.did !== did) {
    throw new PreconditionError(
      `the note of the dry run of the step ${step} holds the DID ${noted.did}, and this build has the DID ${did}: the fee wallet changed after the dry run, and a TXT value that was published is for the other DID. `
      + `The TXT value for this build is ${did} at ${txt.name}: run the dry run again, publish this value, then run again with --submit.`,
    );
  }
  if (noted.txtName !== txt.name || noted.txtValue !== txt.value) {
    throw new PreconditionError(
      `the note of the dry run of the step ${step} holds the TXT name ${noted.txtName} and the TXT value ${noted.txtValue}, and this build needs the TXT name ${txt.name} and the TXT value ${txt.value}: `
      + 'the data changed after the dry run. Run the dry run again, publish this value, then run again with --submit.',
    );
  }
  const shown = await checkTxt(session.fetchImpl, txt.name, txt.value);
  if (shown.ok) return;
  const missing = shown.resolvers.filter((one) => !one.seen).map((one) => `${one.resolver} (${one.error ?? 'not seen'})`);
  throw new PreconditionError(`the TXT value is not public on all three resolvers: publish the TXT value ${txt.value} at ${txt.name}, then run again. Not seen: ${missing.join('; ')}.`);
}

// ---- the preconditions of a step ----

/** The domain of the organisation of an agent must be the domain that an Accountable party of its record names: the gateway checks the TXT record of the domain of each party, and the TXT name of this task is the domain of the organisation. */
function requireOrganisationParty(subject: Subject): void {
  const organisation = subject.organisation;
  if (organisation === null || subject.parties.some((party) => party.role === 'Accountable' && party.organisation === organisation.domain)) return;
  throw new PreconditionError(
    `the data names the organisation ${organisation.id} with the domain ${organisation.domain} for ${subject.id}, and no Accountable party of the record names that domain: the gateway would check another name than the TXT name of this task`,
  );
}

/** The `fee` wallet pays the deposit and the fee and gives the collateral: it holds a pure output of 5 units or more, and enough for the deposit and the fee limit. */
async function requireFeeWallet(session: Session): Promise<void> {
  if (!session.registry.has('fee')) throw new PreconditionError('the registry holds no key named fee: the wallet of that key pays the deposit and the fee of a record');
  const address = session.registry.addressOf('fee');
  const utxos = await session.chain.provider.getUtxos(address);
  if (!utxos.some(isCollateralOutput)) {
    throw new PreconditionError(`The fee wallet ${address} has no pure output of 5 units or more. A registration runs a script, and the script needs one as collateral. ${collateralAdvice(address)}.`);
  }
  const held = utxos.reduce((sum, utxo) => sum + (utxo.assets.lovelace ?? 0n), 0n);
  const needed = DEPOSIT_LOVELACE + session.settings.maxFeeLovelace;
  if (held < needed) throw new PreconditionError(`The fee wallet ${address} holds ${units(held)}, and a registration needs ${units(needed)} for the deposit and the fee limit.`);
}

/** The parent of a subagent: its DID from the facts file, and its record from the node. */
interface Parent { did: string; record: RecordUtxo }

/**
 * The parent of a subagent, or the outcome that ends the step. The parent must be in the facts file and Active on the node. A parent that the node does not show yet (its registration is not
 * confirmed there) is a wait. A parent that is in no fact, is not a root record, or is not Active, is a precondition that fails.
 */
async function parentOf(session: Session, subject: Subject): Promise<Parent | StepOutcome> {
  const parentId = subject.parent!;
  const held = session.facts.read().records[parentId];
  if (held === undefined) throw new PreconditionError(`the parent ${parentId} is not in the facts file: register it first, and keep the facts file of the session`);
  const found = await findRecord(session.chain.provider, session.chain.deployment, held.id);
  const now = session.clock.now();
  if (found === null) {
    return { kind: 'wait', message: `the record of the parent ${parentId} (${held.did}) is not on the node yet: its registration is not confirmed there. Run the step again in a minute`, untilMs: now + PARENT_RETRY_MS };
  }
  if (found.record.lineage.type !== 'Root') throw new PreconditionError(`the parent ${parentId} (${held.did}) is a subagent: a subagent of this task has a root record as its parent`);
  const status = effectiveStatus(found.record, new Map(), now, now);
  if (status !== 'Active') throw new PreconditionError(`the parent ${parentId} (${held.did}) is ${status}: only an Active record can start a subagent`);
  return { did: held.did, record: found };
}

// ---- the landing of a record ----

function landSpec(session: Session, subject: Subject, parent: Parent | null): HostedLandSpec {
  const deployment = session.chain.deployment;
  const module1 = holdsModule1(subject);
  return {
    step: subject.id, tool: TOOL, args: argsOf(session, subject, parent === null ? null : parent.did), expectSigners: signersOf(subject), irreversible: 'record',
    // The plan runs in a dry run too: a record that is not the record of the data stops the run here, before any note and before any signature.
    plan: (build, facts) => {
      const { id } = identityOf(build);
      requireBuiltRecord(session, subject, build, recordOutputOf(subject.id, deployment, id, facts), parent === null ? null : parent.record);
      return planOf(session, {
        outflow: { fee: DEPOSIT_LOVELACE + session.settings.maxFeeLovelace }, destinations: [deployment.identity.address], mint: { [`${deployment.identity.hash}${id}`]: 1n }, withdrawals: module1 ? 1 : 0,
        labels: { [deployment.identity.address]: 'the identity registry' },
      });
    },
    // The checks before the first signature, in this order: the consent of Module-1 (it needs no note and asks no resolver), then the TXT gate. A dry run never comes here.
    beforeSign: async (build) => {
      await checkConsentWithdrawal({ step: subject.id, unsignedCbor: build.unsignedCbor, provider: session.chain.provider, deployment, expectModule1: module1 });
      const { did } = identityOf(build);
      const txt = txtOf(subject, did);
      if (txt !== null) await requireTxt(session, subject.id, did, txt);
    },
    refs: (build, facts) => {
      const { did, id } = identityOf(build);
      return { did, id, recordRef: `${facts.txHash}#${recordOutputOf(subject.id, deployment, id, facts).index}` };
    },
    facts: (build, facts) => ({ depositLovelace: recordOutputOf(subject.id, deployment, identityOf(build).id, facts).lovelace.toString() }),
  };
}

/** The result of the run for the machine line: public values only. */
function resultOf(subject: Subject, did: string, build: HostedBuild, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { subject: subject.id, did, txt: txtOf(subject, did), signers: signersOf(subject), valid_until: iso(build.validTo), ...extra };
}

/** What a dry run shows, and the note that it writes. The note is the one write of a dry run, and only a dry run that passed every guard writes it. */
function showDry(session: Session, subject: Subject, landed: Landed): void {
  const build = landed.build;
  if (build === null) throw new Error(`the landing of the step ${subject.id} gave no answer of the tool`);
  const { did, id } = identityOf(build);
  const txt = txtOf(subject, did);
  const record = recordOutputOf(subject.id, session.chain.deployment, id, landed.facts);
  const lines = [
    `record ${subject.id} (${subject.name})`, `DID: ${did}`, ...(txt === null ? ['no TXT for this record'] : [`TXT name: ${txt.name}`, `TXT value: ${txt.value}`]),
    `valid until: ${iso(build.validTo)}`, `signers: ${signersOf(subject).join(', ')}`, `deposit: ${units(record.lovelace)}`, `fee: ${units(build.feeLovelace)}`,
    ...(record.inlineDatum === null ? [] : describeRecord(session, decodeIdentityDatum(record.inlineDatum))),
  ];
  for (const line of lines) session.out.out(line);
  if (txt !== null) {
    session.state.setNote(`dry.${subject.id}`, { did, txtName: txt.name, txtValue: txt.value, at: iso(session.clock.now()) });
    session.out.out(`the dry run wrote the note dry.${subject.id}: publish the TXT value at the TXT name, then run again with --submit`);
  }
  session.extra.result = resultOf(subject, did, build);
}

/** The facts of a record that landed, from the record of its step in the state file. The same facts again change nothing. The organisation of an agent gets its fact once, with no verification yet. */
function writeFacts(session: Session, subject: Subject, record: StepRecord): void {
  const { did, id, recordRef } = record.refs;
  const deposit = record.facts.depositLovelace;
  if (record.tx_hash === null || did === undefined || id === undefined || recordRef === undefined || typeof deposit !== 'string') {
    throw new Error(`the state file holds the step ${subject.id} without the DID, the identifier, the reference or the deposit of its record: its facts cannot be written`);
  }
  session.facts.put('records', [subject.id], { did, id, tx: record.tx_hash, recordRef, depositLovelace: deposit, registeredAt: record.confirmed_at });
  if (subject.organisation !== null && session.facts.read().organisations[subject.organisation.id] === undefined) {
    session.facts.put('organisations', [subject.organisation.id], { txtName: `_did.${subject.organisation.domain}`, txtValue: did, verifiedAt: null });
  }
}

// ---- the check of the record on the node ----

type Datum = RecordUtxo['record'];
const textOfHex = (hex: string): string => Buffer.from(hex, 'hex').toString('utf8');
const purposeBits = (purposes: readonly KeyPurpose[]): number => purposes.reduce((sum, purpose) => sum + PURPOSE[purpose], 0);
const purposeText = (bits: number): string => Object.entries(PURPOSE).filter(([, bit]) => (bits & bit) !== 0).map(([name]) => name).join(' and ') || 'none';
const rightsText = (bits: number): string => Object.entries(RIGHT).filter(([, bit]) => (bits & bit) !== 0).map(([name]) => name).join(' and ') || 'none';
const rightBits = (party: PartySpec): number => (party.rights === null ? ROLE_MAX_RIGHTS[party.role] : party.rights.reduce((sum, right) => sum + RIGHT[right], 0));

function signerMatches(registry: Registry, have: Datum['parties'][number]['signer'], want: PartySpec['signer']): boolean {
  if (want.kind === 'controller') return have.type === 'ControllerSet';
  if (want.kind === 'module1') return have.type === 'Script';
  return have.type === 'KeyHash' && have.hash.toLowerCase() === registry.hashOf(want.key);
}

/**
 * What differs between a record and the data: the controller, the profile, the listed keys with their purposes, the parties with their rights and their times, the lineage, and the members that
 * the data does not have and a new record leaves empty (the framework, a pending recovery, the subagent epoch). Empty when none differs. It reads the record that the build holds, before any
 * signature, and the record on the node after the landing.
 */
function differences(session: Session, subject: Subject, datum: Datum, parent: RecordUtxo | null): string[] {
  const registry = session.registry;
  const problems: string[] = [];
  const same = (what: string, found: string, expected: string): void => { if (found !== expected) problems.push(`the ${what} of the record is ${found}, and the data says ${expected}`); };
  same('controller', datum.controller.toLowerCase(), registry.publicKeyOf('controller'));
  same('name', textOfHex(datum.name), subject.name);
  same('description', textOfHex(datum.description), subject.description);
  same('endpoint', textOfHex(datum.endpoint), subject.endpoint ?? '');
  same('capabilities', `[${datum.capabilities.map(textOfHex).join(', ')}]`, `[${subject.capability ?? ''}]`);
  same('guardian threshold', String(datum.guardianThreshold), String(subject.guardianThreshold));
  const wanted = new Map(subject.keys.map((use) => [registry.publicKeyOf(use.key), { name: use.key, purposes: purposeBits(use.purposes) }]));
  for (const [key, want] of wanted) {
    const have = datum.keys.find((one) => one.keyType === 'Ed25519' && one.key.toLowerCase() === key);
    if (have === undefined) problems.push(`the key ${want.name} is not listed in the record`);
    else if (have.purposes !== want.purposes) problems.push(`the key ${want.name} has the purposes ${purposeText(have.purposes)} in the record, and the data says ${purposeText(want.purposes)}`);
  }
  if (datum.keys.length !== wanted.size) problems.push(`the record lists ${datum.keys.length} keys, and the data names ${wanted.size}`);
  if (datum.parties.length !== subject.parties.length) problems.push(`the record has ${datum.parties.length} parties, and the data names ${subject.parties.length}`);
  // A new record has no framework, no pending recovery, no subagent epoch and the status Active. Each party starts at the start of the validity window (the creation time less the validity and
  // the minute before now that the window opens with), and has no end and no removal time: a party with an end would stop counting when the end comes.
  const start = datum.createdAt - (VALID_MINUTES + 1) * 60_000;
  if (datum.framework !== '') problems.push(`the framework of the record is ${textOfHex(datum.framework)}, and the data names none`);
  if (datum.pendingRecovery !== null) problems.push('the record has a pending recovery, and a new record has none');
  if (datum.subagentEpoch !== 0) problems.push(`the record has the subagent epoch ${datum.subagentEpoch}, and a new record has the epoch 0`);
  if (datum.status.type !== 'Active') problems.push(`the status of the record is ${datum.status.type}, and a new record is Active`);
  subject.parties.forEach((want, index) => {
    const have = datum.parties[index];
    if (have === undefined) return;
    const who = `the party ${index + 1} (${want.role})`;
    if (have.role !== want.role) problems.push(`${who} has the role ${have.role} in the record`);
    if (!signerMatches(registry, have.signer, want.signer)) problems.push(`${who} has another signer in the record than the data names`);
    const organisation = have.organisation === null ? null : textOfHex(have.organisation);
    if (organisation !== want.organisation) problems.push(`${who} has the organisation ${organisation ?? 'none'} in the record, and the data says ${want.organisation ?? 'none'}`);
    if (have.rights !== rightBits(want)) problems.push(`${who} has the rights ${rightsText(have.rights)} in the record, and the data says ${rightsText(rightBits(want))}`);
    if (have.notBefore !== start) problems.push(`${who} starts at ${iso(have.notBefore)} in the record, and the data says the start of the validity window (${iso(start)})`);
    if (have.notAfter !== null) problems.push(`${who} ends at ${iso(have.notAfter)} in the record, and the data names no end`);
    if (have.removalAfter !== null) problems.push(`${who} has the removal time ${iso(have.removalAfter)} in the record, and the data names none`);
  });
  if (subject.parent === null) {
    if (datum.lineage.type !== 'Root') problems.push('the record is a subagent, and the data says a root record');
  } else if (datum.lineage.type !== 'Subagent' || parent === null || datum.lineage.parent !== parent.id) {
    problems.push(`the record does not name the record of ${subject.parent} as its parent`);
  } else if (datum.lineage.parentEpoch !== parent.record.subagentEpoch || datum.lineage.depth !== 1) {
    problems.push(`the record names the epoch ${datum.lineage.parentEpoch} and the depth ${datum.lineage.depth} of its parent, and the data needs the epoch ${parent.record.subagentEpoch} and the depth 1`);
  }
  return problems;
}

/** The members of a record in words, for a dry run: what the record will say. The names are the names of the registry. */
function describeRecord(session: Session, datum: Datum): string[] {
  const nameOf = (hash: string): string => session.registry.nameOfHash(hash.toLowerCase()) ?? `a key that is not in the registry (${hash})`;
  const signerText = (signer: Datum['parties'][number]['signer']): string => (signer.type === 'ControllerSet' ? 'the controller' : signer.type === 'Script' ? 'Module-1' : `key ${nameOf(signer.hash)}`);
  return [
    `record controller: ${nameOf(keyHashOf(datum.controller))}`, `record name: ${textOfHex(datum.name)}`, `record endpoint: ${textOfHex(datum.endpoint) || 'none'}`,
    `record capabilities: ${datum.capabilities.map(textOfHex).join(', ') || 'none'}`,
    ...datum.keys.map((key, index) => `record key ${index + 1}: ${nameOf(keyHashOf(key.key))} with the purposes ${purposeText(key.purposes)}`),
    ...datum.parties.map((party, index) => `record party ${index + 1}: ${party.role}, ${signerText(party.signer)}, organisation ${party.organisation === null ? 'none' : textOfHex(party.organisation)}, rights ${rightsText(party.rights)}`),
    `record guardian threshold: ${datum.guardianThreshold}`,
    `record lineage: ${datum.lineage.type === 'Root' ? 'root' : `subagent of ${DID_PREFIX}${datum.lineage.parent}`}`,
  ];
}

/**
 * The record that the build holds, read from its bytes and compared with the data before any signature. The guards read the signers, the destinations, the mint, the withdrawals and the outflow,
 * and none of them reads the datum, so a tool that built another record (another controller, no parent, other keys or parties) would be signed. A record that differs, or that was not created at
 * the end of the validity of the build, is a refusal with the guard `body`. The plan runs in a dry run too, so a dry run stops here and writes no note.
 */
function requireBuiltRecord(session: Session, subject: Subject, build: HostedBuild, output: OutputFacts, parent: RecordUtxo | null): void {
  const refuse = (message: string): GuardRefusal => new GuardRefusal(subject.id, [{ guard: 'body', ok: false, message }]);
  if (output.inlineDatum === null) throw refuse('the record output of the build has no inline datum, so the record cannot be read');
  let datum: Datum;
  try { datum = decodeIdentityDatum(output.inlineDatum); } catch (err) { throw refuse(`the inline datum of the record output does not decode (${errorText(err)})`); }
  const problems = differences(session, subject, datum, parent);
  if (datum.createdAt !== build.validTo) problems.push(`the record says that it was created at ${iso(datum.createdAt)}, and the build is valid until ${iso(build.validTo)}`);
  if (problems.length > 0) throw refuse(`the record in the build is not the record of the data: ${problems.join('; ')}`);
}

// ---- the steps ----

/** The step of one record: the landing, and the check of the record on the node. */
function recordStep(subject: Subject): StepHandler<Extra> {
  return {
    name: subject.id,
    async run(session) {
      session.extra.result = null;
      if (session.state.snapshot().in_flight !== null) throw new PreconditionError('a transaction is in flight: settle it before a record is built');
      requireOrganisationParty(subject);
      await requireFeeWallet(session);
      const parent = subject.parent === null ? null : await parentOf(session, subject);
      if (parent !== null && !('record' in parent)) return parent;
      const landed = await landHosted(session, landSpec(session, subject, parent));
      if (landed.kind === 'dry') {
        showDry(session, subject, landed);
        return { kind: 'dry' };
      }
      const record = session.state.step(subject.id);
      if (record === undefined || landed.build === null) throw new Error(`the transaction ${landed.txHash} of the step ${subject.id} landed, and the state file does not hold the step`);
      writeFacts(session, subject, record);
      session.extra.result = resultOf(subject, identityOf(landed.build).did, landed.build, { tx: landed.txHash, record_ref: record.refs.recordRef });
      return { kind: 'done', message: `the record ${subject.id} is registered: ${identityOf(landed.build).did}, transaction ${landed.txHash}` };
    },
    async verify(session, record) {
      writeFacts(session, subject, record);
      const { did, id } = record.refs;
      if (did === undefined || id === undefined) throw new Error(`the state file holds the step ${subject.id} without the DID of its record`);
      const found = await findRecord(session.chain.provider, session.chain.deployment, id);
      if (found === null) throw new Error(`the record ${did} is not on the node, so it cannot be checked: run the task again`);
      const parentId = subject.parent === null ? null : session.facts.read().records[subject.parent]?.id;
      const parent = parentId === null || parentId === undefined ? null : await findRecord(session.chain.provider, session.chain.deployment, parentId);
      const problems = differences(session, subject, found.record, parent);
      const now = session.clock.now();
      const status = effectiveStatus(found.record, parent === null ? new Map() : new Map([[parent.id, parent.record]]), now, now);
      if (status !== 'Active') problems.push(`the record is ${status}, and it must be Active`);
      if (problems.length > 0) throw new Error(`the record ${did} on the node is not the record of the data: ${problems.join('; ')}`);
      session.evidence.add({ step: subject.id, status: 'info', shows: { verification: 'the record on the node is the record of the data', did } });
    },
  };
}

type Verdict = { verified: true } | { verified: false; why: string };

/** True when a list of parties of the gateway holds an Accountable party for the domain that the gateway shows as verified. */
function showsVerified(parties: unknown, domain: string): boolean {
  if (!Array.isArray(parties)) return false;
  return parties.some((party: unknown) => typeof party === 'object' && party !== null && 'role' in party && 'organisation' in party && 'organisationVerified' in party
    && typeof party.role === 'string' && party.role.toLowerCase() === 'accountable' && party.organisation === domain && party.organisationVerified === true);
}

/** Asks the gateway for the resolution of the DID. A record that ended is a failure; every other answer that does not show the organisation is a reason to wait. */
async function askGateway(session: Session, did: string, domain: string): Promise<Verdict> {
  const client = createGatewayClient({ baseUrl: session.settings.urls.gateway, fetch: session.fetchImpl, now: () => session.clock.now() });
  const answer = await client.resolve(did);
  if (!answer.ok) return { verified: false, why: `the gateway gave no answer (${answer.rule}: ${answer.detail.slice(0, MAX_REASON_CHARS)})` };
  const resolution = answer.value;
  if (resolution.kind === 'not_found') return { verified: false, why: 'the gateway has no record for this DID yet' };
  if (resolution.kind === 'deactivated') throw new Error(`the gateway shows the record ${did} as ${resolution.effectiveStatus}: a record that ended cannot get a verified organisation`);
  if (showsVerified(resolution.metadata.vectorParties, domain)) return { verified: true };
  return { verified: false, why: `the gateway shows no verified Accountable party for ${domain}` };
}

/** The step that waits for the gateway to show the organisation of an agent as verified. It takes no transaction and no approval. In a dry run it reads and writes nothing. */
function organisationStep(agent: Subject): StepHandler<Extra> {
  const organisation = agent.organisation!;
  const name = `organisation:${agent.id}`;
  return {
    name,
    async run(session) {
      session.extra.result = null;
      const facts = session.facts.read();
      const record = facts.records[agent.id];
      const held = facts.organisations[organisation.id];
      if (record === undefined || held === undefined) throw new PreconditionError(`the facts file holds no record of ${agent.id} and no organisation ${organisation.id}: register the record first`);
      const registered = Date.parse(record.registeredAt);
      if (Number.isNaN(registered)) throw new PreconditionError(`the facts file holds a time of registration of ${agent.id} that is no time`);
      const now = session.clock.now();
      const deadline = registered + ORGANISATION_LIMIT_MS;
      const verdict: Verdict = held.verifiedAt === null ? await askGateway(session, record.did, organisation.domain) : { verified: true };
      const shown = (verified: boolean): Record<string, unknown> => ({
        subject: name, did: record.did, organisation: organisation.id, txt: { name: held.txtName, value: held.txtValue }, verified, verified_at: held.verifiedAt,
      });
      if (verdict.verified) {
        if (session.mode === 'dry') {
          session.out.out(`the gateway shows the organisation ${organisation.domain} of ${agent.id} as verified: run with --submit to record the step`);
          session.extra.result = shown(true);
          return { kind: 'dry' };
        }
        const at = iso(now);
        if (held.verifiedAt === null) session.facts.put('organisations', [organisation.id, 'verifiedAt'], at);
        session.state.recordStep(name, { confirmed_at: at, tx_hash: null, refs: { did: record.did }, facts: { organisation: organisation.id, domain: organisation.domain }, verified_at: at });
        session.evidence.add({ step: name, status: 'info', shows: { organisation: organisation.id, domain: organisation.domain, did: record.did, organisationVerified: true } });
        session.extra.result = { ...shown(true), verified_at: held.verifiedAt ?? at };
        return { kind: 'done', message: `the gateway shows the organisation ${organisation.domain} of ${agent.id} as verified` };
      }
      session.extra.result = shown(false);
      if (now < deadline) {
        return {
          kind: 'wait', untilMs: deadline,
          message: `the gateway does not show the organisation ${organisation.domain} of ${agent.id} as verified yet (${verdict.why}). ${duration(deadline - now)} are left until ${iso(deadline)}. The gateway scans every 10 minutes: run the step again after the next scan`,
        };
      }
      throw new Error(
        `the gateway does not show the organisation ${organisation.domain} of ${agent.id} as verified, ${duration(ORGANISATION_LIMIT_MS)} after the registration (${verdict.why}). Check these: `
        + `(1) the TXT record ${held.txtName} holds ${held.txtValue} on public resolvers; (2) the gateway scans every 10 minutes; `
        + '(3) the live gateway checks a record that did not change again only after 24 hours, so a TXT value that was not public at the first check can keep the organisation unverified for up to a day; '
        + '(4) one update of the record (a change of its description) restarts the check at the next scan.',
      );
    },
  };
}

const keysOf = (use: UseCase): string[] => [...new Set(subjectsOf(use).flatMap(signersOf))];
const stepNames = (use: UseCase): string[] => {
  const subjects = subjectsOf(use);
  return [...subjects.map((subject) => subject.id), ...subjects.filter((subject) => subject.organisation !== null).map((subject) => `organisation:${subject.id}`)];
};
const handlersOf = (use: UseCase): StepHandler<Extra>[] => {
  const subjects = subjectsOf(use);
  return [...subjects.map(recordStep), ...subjects.filter((subject) => subject.organisation !== null).map(organisationStep)];
};

const register: TaskDefinition<Extra> = {
  name: 'register',
  title: 'Register the records of the use case, and wait for the gateway to verify their organisations',
  flags: [],
  valued: [],
  needs: { keys: keysOf, chain: true, hosted: [TOOL, 'vector_resolve_did'], approval: 'submit' },
  steps: stepNames,
  parse: () => ({ result: null }),
  next: (session) => runSteps(session, handlersOf(session.use)),
  cleanup: async () => ({ kind: 'done', message: 'a record is permanent: there is nothing to take back' }),
  result: (session) => session.extra.result ?? {},
};

export default register;
