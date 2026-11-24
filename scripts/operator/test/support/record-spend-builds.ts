import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_UTXO, CONTROLLER_ACCOUNTABLE, DAY, M1, REF_UTXOS, recordUtxo, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import type { RecordSpendBuild } from '../../../../packages/buyer-core/src/vendored/mcp/identity-build.ts';
import { utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import type { IdentityDatum, Party } from '../../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../../checks/lib/format.ts';
import { HostedError } from '../../../checks/lib/hosted.ts';
import type { Utxo } from '../../../checks/lib/platform.ts';
import { factsOf } from '../../../checks/lib/txfacts.ts';
import type { AgentSpec, OrganisationSpec, TaskDefinition, UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { ensureSlotConfig, findRecord } from '../../lib/platform.ts';
import type { IdentityContext, RecordUtxo } from '../../lib/platform.ts';
import { loadRegistry } from '../../lib/registry.ts';
import type { Registry } from '../../lib/registry.ts';
import { runTask } from '../../lib/runner.ts';
import { liveBuildAnswer, PackHosted } from './pack-hosted.ts';
import type { HandlerAnswer } from './pack-hosted.ts';
import { hashOf, NOW, taskWorld } from './task-world.ts';
import type { TaskWorld } from './task-world.ts';

export const TOOLS = {
  end: 'vector_build_identity_end_subagents', revoke: 'vector_build_identity_revoke', reclaim: 'vector_build_identity_reclaim', resolve: 'vector_resolve_did',
} as const;

export interface SpendWorldOptions {
  use: UseCase;
  agent: string;
  parent?: Partial<IdentityDatum>;
  parentLovelace?: bigint;
  children?: Record<string, Partial<IdentityDatum> | null>;
  addRecord?: boolean;
  addFact?: boolean;
  failResolver?: boolean;
}

interface ArchiveOutput { tx_hash: string; tx_index: number; payment_addr: { bech32: string }; value: string }
interface ArchiveSpend { tx_hash: string; fee: string; inputs: ArchiveOutput[]; outputs: ArchiveOutput[] }

function archiveOutput(utxo: Utxo): ArchiveOutput {
  return { tx_hash: utxo.txHash, tx_index: utxo.outputIndex, payment_addr: { bech32: utxo.address }, value: String(utxo.assets.lovelace) };
}

export interface SpendWorld {
  w: TaskWorld;
  agent: AgentSpec;
  organisation: OrganisationSpec;
  parent: IdentityDatum;
  defaultParty: Party;
  moduleParty: Party;
  id: string;
  did: string;
  childIds: ReadonlyMap<string, string>;
  parentOutput: RecordUtxo['utxo'];
  registry: Registry;
  fee: string;
  accountableHash: string;
  hosted: PackHosted;
  answers: ReadonlyMap<string, HandlerAnswer>;
  archive: Map<string, ArchiveSpend>;
  signed: string[];
  statusUrls: readonly string[];
  store: FactsFile;
  context(): Promise<IdentityContext>;
  run<Extra>(task: TaskDefinition<Extra>, ...argv: string[]): Promise<number>;
  setRuntime(status: string): void;
  showRunning(containers: readonly string[]): void;
  prepare(tool: string, built: RecordSpendBuild, fields?: Record<string, unknown>): void;
  record(recordId?: string): Promise<RecordUtxo>;
  feeBalance(): Promise<bigint>;
}

export async function spendWorld(options: SpendWorldOptions): Promise<SpendWorld> {
  const agent = options.use.agents.find(({ id }) => id === options.agent)!;
  const organisation = options.use.organisations.find(({ id }) => id === agent.organisation)!;
  const id = hashOf(`record of ${agent.id}`);
  const did = `did:vector:${id}`;
  const children = options.use.subagents.filter(({ parent }) => parent === agent.id);
  const childIds = new Map(children.map(({ id: name }) => [name, hashOf(`record of ${name}`)]));
  const statusUrls: string[] = [];
  let runtimeStatus = 'free';
  const archive = new Map<string, ArchiveSpend>();
  const w = await taskWorld({
    keys: options.use.keys.map(({ name }) => name), shared: options.use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name), use: options.use,
    // The runner uses the test loader below. Its environment still needs an active default.
    env: { OPERATOR_USE_CASE: 'inventory-reorder' },
    fetchImpl: async (input, init) => {
      const url = String(input);
      if (new URL(url).pathname === '/api/v1/tx_info') {
        const request = JSON.parse(String(init?.body)) as { _tx_hashes: string[]; _inputs?: boolean };
        if (request._inputs !== true) throw new Error('The archive request needs transaction inputs.');
        return Response.json(request._tx_hashes.flatMap((hash) => {
          const found = archive.get(hash);
          return found === undefined ? [] : [found];
        }));
      }
      statusUrls.push(url);
      if (!agent.statusUrls.includes(url)) throw new Error('Unexpected status URL.');
      return Response.json({ status: runtimeStatus });
    },
  });
  const submit = w.node.submit.bind(w.node);
  w.node.submit = async (hex) => {
    const facts = factsOf(hex);
    const inputs = facts.inputs.map((ref) => archiveOutput(w.world.chain.find(ref)!));
    const hash = await submit(hex);
    const outputs = w.world.chain.held.filter((utxo) => utxo.txHash === hash).map(archiveOutput);
    archive.set(hash, { tx_hash: hash, fee: String(facts.feeLovelace), inputs, outputs });
    return hash;
  };
  const { registry } = w.keys;
  const fee = registry.addressOf('fee');
  const accountableHash = registry.hashOf(organisation.accountableKey);
  const defaultParty: Party = {
    role: 'Accountable', signer: { type: 'KeyHash', hash: accountableHash }, organisation: utf8Hex(organisation.domain),
    notBefore: NOW - 31 * DAY, notAfter: null, rights: 3, removalAfter: null,
  };
  const moduleParty: Party = {
    role: 'Responsible', signer: { type: 'Script', hash: M1 }, organisation: null,
    notBefore: NOW - 31 * DAY, notAfter: null, rights: 1, removalAfter: null,
  };
  const parent = rootRecord({
    controller: registry.publicKeyOf('controller'), parties: [defaultParty, moduleParty],
    name: utf8Hex(agent.name), capabilities: [utf8Hex(agent.capability)], ...options.parent,
  });
  const store = FactsFile.open(join(w.stateDir, 'facts.json'), { useCase: w.use.name, network: 'vector-mainnet' });
  w.world.chain.held.push(...REF_UTXOS, CONFIG_UTXO);
  const parentOutput = recordUtxo(id, parent, options.parentLovelace);
  if (options.addRecord !== false) w.world.chain.held.push(parentOutput);
  const registration = (name: string, recordId: string, output: RecordUtxo['utxo']) => store.put('records', [name], {
    did: `did:vector:${recordId}`, id: recordId, tx: output.txHash, recordRef: `${output.txHash}#${output.outputIndex}`,
    depositLovelace: String(output.assets.lovelace), registeredAt: iso(NOW - 30 * DAY),
  });
  if (options.addFact !== false) registration(agent.id, id, parentOutput);
  for (const [name, childId] of childIds) {
    const change = options.children?.[name];
    const child = rootRecord({
      controller: registry.publicKeyOf('controller'), parties: [CONTROLLER_ACCOUNTABLE], endpoint: '', capabilities: [],
      lineage: { type: 'Subagent', parent: id, parentEpoch: parent.subagentEpoch, depth: 1 }, ...change,
    });
    const output = recordUtxo(childId, child);
    if (change !== null) w.world.chain.held.push(output);
    registration(name, childId, output);
  }

  const answers = new Map<string, HandlerAnswer>();
  const hosted = new PackHosted({
    [TOOLS.end]: () => answers.get(TOOLS.end)!,
    [TOOLS.revoke]: () => answers.get(TOOLS.revoke)!,
    [TOOLS.reclaim]: () => answers.get(TOOLS.reclaim)!,
    [TOOLS.resolve]: () => {
      if (options.failResolver === true) throw new HostedError('unreachable', 'Z'.repeat(450));
      return { didDocumentMetadata: { deactivated: true, vectorStatus: { effective: 'Revoked' } } };
    },
  });
  const signed: string[] = [];
  const context = async (): Promise<IdentityContext> => {
    await ensureSlotConfig(w.world.chain);
    return w.chain.context(fee);
  };
  const run = <Extra>(task: TaskDefinition<Extra>, ...argv: string[]) => runTask(task, argv, w.deps({
    hosted, readRegistry: (input) => {
      const loaded = loadRegistry(input);
      const sign = loaded.ring.sign.bind(loaded.ring);
      loaded.ring.sign = (hash, cbor) => { signed.push(loaded.nameOfHash(hash)!); return sign(hash, cbor); };
      return loaded;
    },
  }));
  return {
    w, agent, organisation, parent, defaultParty, moduleParty, id, did, childIds, parentOutput, registry, fee, accountableHash, hosted, answers, archive, signed, statusUrls, store, context, run,
    setRuntime(status: string): void { runtimeStatus = status; },
    showRunning(containers: readonly string[]): void {
      mkdirSync(w.stateDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(w.stateDir, 'running-images.json'), JSON.stringify({ generated_at: iso(w.clock.now()), images: Object.fromEntries(containers.map((name) => [name, `registry.example/service@sha256:${hashOf(name)}`])) }));
    },
    prepare(tool: string, built: RecordSpendBuild, fields: Record<string, unknown> = {}): void {
      answers.set(tool, liveBuildAnswer('Identity record spend', built, { did: built.did, action: built.action, record_output_index: built.recordOutputIndex, ...fields }));
    },
    async record(recordId = id): Promise<RecordUtxo> {
      const found = await findRecord(w.chain.provider, w.chain.deployment, recordId);
      if (found === null) throw new Error('The test record is absent.');
      return found;
    },
    async feeBalance(): Promise<bigint> {
      return (await w.chain.provider.getUtxos(fee)).reduce((sum, utxo) => sum + utxo.assets.lovelace, 0n);
    },
  };
}
