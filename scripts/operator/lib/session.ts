// scripts/operator/lib/session.ts - the session that a task gets, and the outside world that it is built over.
// `connect` makes the node, the chain and the hosted tools of a run: the real ones (the node of Vector, the chain of the checks, the hosted client that connects at its first call), or the fakes that a
// test gives. `makeSession` joins them with the parts that the runner opened (the settings, the registry, the state, the evidence, the facts, the approval and the cap) into the `TaskSession` of the
// contract. The session does not read the process environment: the runner gets the environment from its caller, and this file passes it on to the chain.
// The network guard runs once, in the runner. The session gives its result through `networkResult()` with no wait, so that a flow that signs with a SYNC function can read it. The result is null until
// the runner has stored one.
import type { EvidenceFile } from '../../checks/lib/evidence.ts';
import type { GuardResult } from '../../checks/lib/guards.ts';
import type { HostedTools } from '../../checks/lib/hosted.ts';
import { NetworkGate } from '../../checks/lib/land.ts';
import { VectorNode } from '../../checks/lib/node.ts';
import { OgmiosProvider } from '../../checks/lib/platform.ts';
import type { Clock, NodeAccess, Output } from '../../checks/lib/ports.ts';
import { lazyHosted, realChain, unusedChain } from '../../checks/lib/runner.ts';
import type { ChainAccess, Mode } from '../../checks/lib/session.ts';
import type { CommonSettings, Env } from '../../checks/lib/settings.ts';
import type { StateFile } from '../../checks/lib/state.ts';
import type { Exposure, GoFile } from './approval.ts';
import type { FactsStore, OperatorSettings, TaskDefinition, TaskFlags, TaskSession, UseCase } from './contract.ts';
import { dohOverHttp2, dohUsingFetch } from './dns.ts';
import type { DohLookup } from './dns.ts';
import type { Registry } from './registry.ts';

/** How long a transaction is waited for, and how often its status is read, in milliseconds. The checks use the same values. */
export const AWAIT_MS = 180_000;
export const POLL_MS = 4_000;

/** The parts of the world outside the process that a run reads and writes: the node, the chain, the hosted tools and the `fetch`. */
export interface Connections {
  readonly node: NodeAccess;
  readonly chain: ChainAccess;
  readonly hosted: HostedTools;
  readonly fetchImpl: typeof fetch;
  readonly dohLookup: DohLookup;
  /** The network guard over the node: it asks the node for its network once and keeps a result that it read. The runner asks it before a transaction in flight is settled, and the landing asks it again. */
  readonly network: NetworkGate;
  /** Closes the hosted tools when they were connected. It never throws. */
  close(): Promise<void>;
}

/** What `connect` takes from its caller. A part that is given is used as it is. A part that is not given is the real one. */
export interface ConnectDeps {
  readonly env: Env;
  readonly fetchImpl?: typeof fetch;
  readonly node?: NodeAccess;
  readonly chain?: ChainAccess;
  readonly hosted?: HostedTools;
}

/** The settings in the form that the chain of the checks reads. It reads the network and the addresses of the services, and the other members are empty. */
function commonOf(settings: OperatorSettings): CommonSettings {
  return {
    network: settings.network, stateDir: settings.stateDir, recordId: '', recordDid: '', urls: settings.urls, maxFeeLovelace: settings.maxFeeLovelace,
    maxCollateralLossLovelace: settings.maxCollateralLossLovelace, keyFiles: {},
  };
}

/**
 * Makes the node, the chain and the hosted tools of a run. Nothing here opens a connection: the node and the provider connect when they are first asked, and the hosted tools connect at their first
 * call, so a run that calls none never needs the server. A task that reads no ledger (`needs.chain` is false) gets a chain that refuses each use and says why.
 */
export function connect(def: Pick<TaskDefinition, 'name' | 'needs'>, settings: OperatorSettings, deps: ConnectDeps): Connections {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const provider = deps.node !== undefined && deps.chain !== undefined
    ? null
    : new OgmiosProvider({ ogmiosUrl: settings.urls.ogmios, submitUrl: settings.urls.submit, koiosUrl: settings.urls.koios });
  const node = deps.node ?? new VectorNode({ provider: provider!, koiosUrl: settings.urls.koios, fetchImpl });
  const chain = deps.chain ?? (def.needs.chain ? realChain(commonOf(settings), deps.env, fetchImpl, provider!) : unusedChain(def.name));
  const lazy = deps.hosted === undefined ? lazyHosted(settings.urls.hosted, def.needs.hosted) : { tools: deps.hosted, close: async () => undefined };
  const dohLookup = deps.fetchImpl === undefined ? dohOverHttp2 : dohUsingFetch(deps.fetchImpl);
  return { node, chain, hosted: lazy.tools, fetchImpl, dohLookup, network: new NetworkGate(node, settings.network), close: lazy.close };
}

/** What `makeSession` needs: the parts that the runner opened, and the way to read the result of the network guard. */
export interface SessionParts<Extra> {
  readonly task: string;
  readonly mode: Mode;
  readonly all: boolean;
  readonly settings: OperatorSettings;
  readonly use: UseCase;
  readonly extra: Extra;
  readonly flags: TaskFlags;
  readonly registry: Registry;
  readonly state: StateFile;
  readonly evidence: EvidenceFile;
  readonly facts: FactsStore;
  /** The approval of the session, or null when the run loaded none. */
  readonly go: GoFile | null;
  readonly exposure: Exposure;
  readonly out: Output;
  readonly clock: Clock;
  readonly connections: Connections;
  /** What the runner stored from the network guard: null before the guard ran. */
  readonly networkResult: () => GuardResult | null;
  readonly awaitMs: number;
  readonly pollMs: number;
}

/** Builds the session of a task. The session is frozen: its members cannot be replaced. Its network gate is the one of the connections. */
export function makeSession<Extra>(parts: SessionParts<Extra>): TaskSession<Extra> {
  const { connections } = parts;
  return Object.freeze({
    mode: parts.mode,
    settings: parts.settings,
    registry: parts.registry,
    state: parts.state,
    evidence: parts.evidence,
    clock: parts.clock,
    out: parts.out,
    node: connections.node,
    network: connections.network,
    networkResult: parts.networkResult,
    chain: connections.chain,
    hosted: connections.hosted,
    go: parts.go,
    exposure: parts.exposure,
    task: parts.task,
    awaitMs: parts.awaitMs,
    pollMs: parts.pollMs,
    use: parts.use,
    extra: parts.extra,
    flags: parts.flags,
    facts: parts.facts,
    fetchImpl: connections.fetchImpl,
    dohLookup: connections.dohLookup,
    all: parts.all,
  });
}
