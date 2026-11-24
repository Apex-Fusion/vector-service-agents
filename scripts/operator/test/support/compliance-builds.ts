import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readCompliance } from '../../../../agents/sourcing-agent/src/compliance/read.ts';
import { ManualClock } from '../../../../agents/sourcing-agent/test/compliance/support.ts';
import { attestationState, listAttestations, readAttestation } from '../../../../packages/buyer-core/src/index.ts';
import { buildContestAttestation, buildRevokeAttestation } from '../../../../packages/buyer-core/src/vendored/mcp/attestation-build.ts';
import { CONFIG_UTXO, REF_UTXOS, recordUtxo, rootRecord } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { koiosRow, ledgerKoios } from '../../../../packages/buyer-core/test/fixtures/ledger-read-world.ts';
import { decodeAttestationDatum, utf8Hex } from '../../../../packages/vector-read/src/identity-codec.ts';
import { keyHashOf } from '../../../../packages/id-kit/src/index.ts';
import type { IdentityDatum } from '../../../../packages/vector-read/src/identity-codec.ts';
import { iso } from '../../../checks/lib/format.ts';
import { factsOf } from '../../../checks/lib/txfacts.ts';
import { VECTOR_MAINNET } from '../../../checks/lib/settings.ts';
import { DEPLOYMENT } from '../../../checks/test/support/world.ts';
import type { GoFile } from '../../lib/approval.ts';
import type { UseCase } from '../../lib/contract.ts';
import { FactsFile } from '../../lib/facts.ts';
import { loadRegistry } from '../../lib/registry.ts';
import type { Utxo } from '../../lib/platform.ts';
import { runTask } from '../../lib/runner.ts';
import compliance from '../../tasks/compliance.ts';
import data from '../../usecases/bid-evaluation.ts';
import { PackHosted, liveBuildAnswer } from './pack-hosted.ts';
import type { HandlerAnswer } from './pack-hosted.ts';
import { HOUR, NOW, USE_CASE, hashOf, taskWorld } from './task-world.ts';

export const SPEC = data.compliance!;
export const ISSUER = SPEC.issuerKey;
export const [ALFA, BRAVO, CHARLIE] = SPEC.subjects;
export const DAY_MS = 86_400_000;
export const BASE = `https://raw.githubusercontent.com/Apex-Fusion/vector-service-agents/${'e1'.repeat(20)}/docs/attestations/`;
export const subjectId = (agent: string): string => hashOf(`compliance record ${agent}`);
export const subjectDid = (agent: string): `did:vector:${string}` => `did:vector:${subjectId(agent)}`;
export const sha256 = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
export function publishedOf(agent: string, reply = false): { name: string; text: string; sha256: string } {
  const subject = subjectDid(agent);
  const text = JSON.stringify(reply ? { reply: SPEC.reply.text, subject } : { statement: SPEC.statement, subject });
  const digest = sha256(text);
  return { name: `${reply ? 'compliance-reply' : 'compliance'}-${agent}-${digest.slice(0, 7)}.json`, text, sha256: digest };
}
export const REPLY = `${BASE}${publishedOf(CHARLIE, true).name}`;

interface LedgerOutput {
  tx_hash: string;
  tx_index: number;
  payment_addr: { bech32: string };
  value: string;
}
const ledgerOutput = (output: Utxo): LedgerOutput => ({
  tx_hash: output.txHash, tx_index: output.outputIndex, payment_addr: { bech32: output.address }, value: String(output.assets.lovelace),
});
interface WithdrawalRow {
  tx_hash: string;
  fee: string;
  inputs: LedgerOutput[];
  outputs: LedgerOutput[];
  plutus_contracts: { script_hash: string; valid_contract: boolean; spends_input: { tx_hash: string; tx_index: number } }[];
}

interface Options {
  use?: UseCase;
  noFacts?: boolean;
  fee?: readonly bigint[];
}

/** Real builders and ledger readers over the offline node. Hosted spend answers are prepared before the task calls them. */
export async function complianceWorld(options: Options = {}) {
  const use = options.use ?? data;
  const names = use.keys.map(({ name }) => name);
  const shared = use.keys.filter(({ scope }) => scope === 'shared').map(({ name }) => name);
  // The runner loads the injected use case. Its environment default must still name a listed use case.
  const w = await taskWorld({ keys: names, shared, use, env: { OPERATOR_USE_CASE: USE_CASE }, ...(options.fee === undefined ? {} : { wallets: { fee: options.fee } }) });
  const registry = w.keys.registry;
  const fee = registry.addressOf('fee');
  const controller = registry.publicKeyOf('controller');
  w.world.chain.held.push(CONFIG_UTXO, ...REF_UTXOS);
  const records = new Map<string, IdentityDatum>();
  for (const subject of SPEC.subjects) {
    const datum = rootRecord({ controller });
    records.set(subject, datum);
    w.world.chain.held.push(recordUtxo(subjectId(subject), datum));
  }
  const at = (agent: string, over: Partial<IdentityDatum>): void => {
    const record = { ...records.get(agent)!, ...over };
    const index = w.world.chain.held.findIndex((output) => output.assets[`${DEPLOYMENT.identity.hash}${subjectId(agent)}`] === 1n);
    if (index === -1) throw new Error('Missing test record.');
    w.world.chain.held[index] = recordUtxo(subjectId(agent), record);
  };
  const factsFile = FactsFile.open(join(w.stateDir, 'facts.json'), { network: 'vector-mainnet', useCase: w.use.name });
  if (options.noFacts !== true) for (const agent of SPEC.subjects) {
    const { txHash, outputIndex } = recordUtxo(subjectId(agent), records.get(agent)!);
    factsFile.put('records', [agent], { id: subjectId(agent), did: subjectDid(agent), tx: txHash, recordRef: `${txHash}#${outputIndex}`, depositLovelace: '10000000', registeredAt: iso(NOW) });
  }
  const routes = new Map<string, () => Response>(SPEC.subjects.map((agent) => {
    const { name, text } = publishedOf(agent);
    return [`${BASE}${name}`, () => new Response(text)] as const;
  }));
  routes.set(REPLY, () => new Response(publishedOf(CHARLIE, true).text));
  const requests: { url: string; init: RequestInit | undefined }[] = [];
  const withdrawals = new Map<string, WithdrawalRow>();
  let showWithdrawal = (row: WithdrawalRow): WithdrawalRow => row;
  const submit = w.node.submit.bind(w.node);
  w.node.submit = async (cbor) => {
    const tx = factsOf(cbor);
    if (!Object.entries(tx.mint).some(([unit, amount]) => unit.startsWith(DEPLOYMENT.attestation.hash) && amount === -1n)) return submit(cbor);
    const inputs = tx.inputs.map((ref) => ledgerOutput(w.world.chain.find(ref)!));
    const hash = await submit(cbor);
    withdrawals.set(hash, {
      tx_hash: hash, fee: String(tx.feeLovelace), inputs, outputs: w.world.chain.held.filter((out) => out.txHash === hash).map(ledgerOutput),
      plutus_contracts: inputs.filter((input) => input.payment_addr.bech32 === DEPLOYMENT.attestation.address).map(({ tx_hash, tx_index }) => ({
        script_hash: DEPLOYMENT.attestation.hash, valid_contract: true, spends_input: { tx_hash, tx_index },
      })),
    });
    return hash;
  };
  const fetchImpl: typeof fetch = async (url, init) => {
    const text = String(url);
    requests.push({ url: text, init });
    if (text === `${w.chain.koiosUrl}/api/v1/tx_info` && init?.method === 'POST') {
      const { _tx_hashes: hashes }: { _tx_hashes: string[] } = JSON.parse(String(init.body));
      return Response.json(hashes.flatMap((hash) => {
        const row = withdrawals.get(hash);
        return row === undefined ? [] : [showWithdrawal(structuredClone(row))];
      }));
    }
    return routes.get(text)?.() ?? new Response(null, { status: 404 });
  };
  const spend = new Map<string, HandlerAnswer>();
  let visible = true;
  const held = () => w.world.chain.held.filter((output) => output.address === DEPLOYMENT.attestation.address && output.datum !== undefined);
  const prepared = (action: string): HandlerAnswer => {
    const answer = spend.get(action);
    if (answer === undefined) throw new Error(`No test build for ${action}.`);
    return answer;
  };
  const hosted = new PackHosted({
    vector_get_attestation: ({ attestation: id }) => {
      const output = visible ? held().find((candidate) => candidate.assets[`${DEPLOYMENT.attestation.hash}${String(id)}`] === 1n) : undefined;
      if (output?.datum == null) return { found: false, attestation: id };
      const d = decodeAttestationDatum(output.datum);
      return {
        found: true, attestation: id, output_ref: `${output.txHash}#${output.outputIndex}`,
        subject: d.subject, issuer_key_hash: keyHashOf(d.issuer), issuer_id: d.issuerId, att_type_code: d.attType, format: d.format, digest: d.digest,
        locator_hex: d.locator, solicited: d.solicited, envelope_sig: d.envelopeSig, issued_at: d.issuedAt, valid_until: d.validUntil,
        status: d.status.type === 'AttActive' ? 'active' : 'revoked',
      };
    },
    vector_build_attestation_revoke: () => prepared('revoke'),
    vector_build_attestation_contest: () => prepared('contest'),
  });
  const loaded: string[][] = [];
  const go = (over?: Partial<GoFile>): void => {
    w.writeGo({ tasks: ['compliance'], irreversible: ['attestation', 'attestation-revoke'], at: iso(w.clock.now()), expiresAt: iso(w.clock.now() + 6 * HOUR), ...over });
  };
  go();
  const context = () => w.chain.context(fee);
  const factOf = (agent: string) => w.facts().compliance[agent];
  return {
    w, registry, fee, factsFile, hosted, routes, requests, loaded, held, go, at,
    setIssueVisible(value: boolean): void { visible = value; },
    setWithdrawalRead(read: (row: WithdrawalRow) => WithdrawalRow): void { showWithdrawal = read; },
    travel(now: number): void {
      w.clock.t = now;
      w.world.chain.tipSlot = Math.floor((now - VECTOR_MAINNET.systemStartMs!) / 1000);
      go();
    },
    run(...argv: string[]): Promise<number> {
      return runTask(compliance, argv, w.deps({
        hosted, fetchImpl,
        readRegistry: (input) => { loaded.push([...(input.need ?? [])]); return loadRegistry(input); },
      }));
    },
    factOf,
    async view(agent: string) {
      const view = await readAttestation(w.chain, factOf(agent).id);
      if (view === null) throw new Error(`No attestation for ${agent}.`);
      return view;
    },
    async sourcing(agent: string) {
      const koios = ledgerKoios({ rows: held().map((output) => koiosRow(output)) });
      const env = { ...w.chain, fetchImpl: koios.f };
      return readCompliance({
        issuerPkh: registry.hashOf(ISSUER), list: (query) => listAttestations(env, query),
        clock: new ManualClock(),
      }, subjectDid(agent), w.clock.now());
    },
    async buildRevoke(agent = CHARLIE, reason = 9) {
      const id = factOf(agent).id;
      const build = await buildRevokeAttestation(await context(), { changeAddress: fee, id, nowMs: w.clock.now(), reason, by: 'issuer' });
      spend.set('revoke', liveBuildAnswer('Attestation Revocation', build, { attestation: id, action: build.action, reason, revoked_at: build.validFrom, attestation_output_index: build.outputIndex }));
      return build;
    },
    async buildContest(agent = CHARLIE, uri = REPLY, digest = publishedOf(agent, true).sha256) {
      const id = factOf(agent).id;
      const build = await buildContestAttestation(await context(), { changeAddress: fee, id, nowMs: w.clock.now(), anchor: { uri: utf8Hex(uri), sha256: digest } });
      spend.set('contest', liveBuildAnswer('Attestation Contest', build, { attestation: id, action: build.action, contested_sha256: digest, contested_uri: uri, attestation_output_index: build.outputIndex }));
      return build;
    },
  };
}
