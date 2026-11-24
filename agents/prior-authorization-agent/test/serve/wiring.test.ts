// agents/prior-authorization-agent/test/serve/wiring.test.ts
// The wiring joins the folders of the agent to the real parts. The tests run it over the stub marketplace of the hire kit (a FakeChain, an indexer and a model supplier behind one fetch), the offline node of the
// fixture world, the key hashes of the fixture world, and the golden record sets of the evidence folder. They show what the wiring decides and nothing of what the jobs decide: the three paying keys that are
// made with no read of a wallet, one queue for each key, one set of delegation ids, one counter and one list of left sub-delegations for the process, the closed sets of the decision `justification` made for
// each job, the address of the identity deployment that the reader of the insurer is given, the deadline of a decision from the job that asks it, a key kept out of every log line, and a start that the node can stop.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { DELIVER_BY_BUFFER_MS, fleetPostTerms, planFleetPostEscrow } from '@vsa/buyer-core';
import type { VaultChain } from '@vsa/buyer-core';
import { T0, marketplace, vaultChainWith } from '@vsa/hire-kit/testing';
import type { TokenRequest } from '@vsa/id-kit/client';
import { PRIORAUTH_CAPABILITIES, PRIORAUTH_CLAIM, PRIORAUTH_MODELS } from '@vsa/usecase-kit/priorauth';
import { renderManifest } from '@vsa/usecase-kit/manifest';
import {
  AGENT_DID as KIT_AGENT_DID, DELEG_A, NOW, PRINCIPAL as KIT_PRINCIPAL, STRANGER, SYSTEM_START_MS, agentWallet, build, keyOf as testKeyOf, liveDelegation, requestOf, withInput, world as ledgerWorld,
} from '../../../../packages/usecase-kit/test/cosign/support.ts';
import { FakeClock, FakeDelegations, PARENT_ID, parentDatum, NOW as ACCESS_NOW } from '../../../../packages/usecase-kit/test/access/support.ts';
import { DEPLOYMENT } from '../../../../packages/buyer-core/test/fixtures/identity-world.ts';
import { GUIDELINE, GUIDELINES_RESOURCE, KNEE_GUIDELINE, KNEE_RECORD_SET, ORDER_ID, RECORDS_RESOURCE, RECORD_SET, TENANT, hex, issued, systemAnswer } from '../evidence/support.ts';
import { requestDocument, sideOf } from '../execute/fixtures.ts';
import { said } from '../model/decide-support.ts';
import { JOB_DEADLINE_MS as EXECUTE_DEADLINE_MS } from '../../src/execute/index.ts';
import { PROPOSE_DEADLINE_MS } from '../../src/propose/index.ts';
import { KEY_ROLES, keyOf } from '../../src/serve/keys.ts';
import { manifestFromEnv } from '../../src/serve/manifest.ts';
import { JOB_DEADLINE_MS, cosignSettingsOf } from '../../src/serve/settings.ts';
import { STATE_FILES } from '../../src/serve/wiring.ts';
import type { InsurerSources, Wired } from '../../src/serve/wiring.ts';
import { KEY_NUMBERS, KEY_VARIABLES, MODULE1_URL, PRINCIPAL, SUPPLIER, cleanDirs, messageOf, rawKey, secretsOf, startEnv, withModule1 } from './support.ts';
import { drive, setup, settingsOf } from './world.ts';

afterEach(cleanDirs);

/** The public key, as 64 hex characters, of a key that the client of the kit resolved: the request holds the resolved key and not the object that the wiring gave. */
function publicKeyOf(resolved: unknown): string {
  if (typeof resolved === 'object' && resolved !== null && 'publicKey' in resolved) {
    const key = resolved.publicKey;
    if (typeof key === 'object' && key !== null && 'x' in key && typeof key.x === 'string') return Buffer.from(key.x, 'base64url').toString('hex');
  }
  throw new Error('the request holds no public key');
}

const INSURER_ID = 'b8'.repeat(32);
const INSURER_DID = `did:vector:${INSURER_ID}`;
const ADVERT_REF = `${'c3'.repeat(32)}#1`;
/** The choice of the decision `justification`: the references name records and criteria of the golden lumbar set. */
const CHOICE = {
  justification: 'The synthetic order meets criteria C1 and C2: REC-0002 records leg pain for three weeks and REC-0004 records physical therapy with little change.',
  guideline_refs: ['C1', 'C2'],
  record_refs: ['REC-0002', 'REC-0004'],
};

describe('one queue for each key, one set of ids, one counter and one list for the process', () => {
  test('the lane of each delegation key is the queue of its sub-delegations, of its hires and of the janitor, and no other key has one of these', async () => {
    const { wired, settings } = await setup();
    const [first, second] = wired.delegations;
    expect(first.keyHash).toBe(settings.keys.delegation1.pkh);
    expect(second.keyHash).toBe(settings.keys.delegation2.pkh);
    expect(wired.service.keyHash).toBe(settings.keys.service.pkh);
    const propose = wired.proposeDeps(T0);
    const execute = wired.executeDeps(T0);
    const janitor = wired.janitorDeps(100);
    for (const [paying, material] of [[first, settings.keys.delegation1], [second, settings.keys.delegation2]] as const) {
      expect(propose.delegationKeys.find(paying.keyHash)?.queue).toBe(paying.lane);
      expect(execute.delegationKeys.find(paying.keyHash)?.key).toBe(paying);
      expect(execute.delegationKeys.find(paying.keyHash)?.key.lane).toBe(paying.lane);
      expect(janitor.queueOf(paying.keyHash)).toBe(paying.lane);
      expect(janitor.signerOf(paying.keyHash)?.keyHash).toBe(material.pkh);
      expect(propose.delegationKeys.find(paying.keyHash)?.walletAddress).toBe(material.address);
      expect(propose.delegationKeys.find(paying.keyHash)?.signer.keyHash).toBe(material.pkh);
    }
    expect(execute.delegationKeys.first.key).toBe(first);
    expect(first.lane).not.toBe(second.lane);
    expect(first.lane).not.toBe(wired.service.lane);
    // The service key and the four subagent keys sign no sub-delegation and pay no vault Pay, and the janitor ends no delegation with them.
    for (const pkh of [wired.service.keyHash, settings.keys.recordReaderAuthentication.pkh, settings.keys.recordReaderDelegation.pkh, settings.keys.drafterAuthentication.pkh, settings.keys.drafterDelegation.pkh, 'ee'.repeat(28)]) {
      expect(propose.delegationKeys.find(pkh)).toBeNull();
      expect(execute.delegationKeys.find(pkh)).toBeNull();
      expect(janitor.signerOf(pkh)).toBeNull();
      expect(() => janitor.queueOf(pkh)).toThrow(/does not hold/);
    }
  });

  test('the dispute code runs in the lane of the service key: a call that needs the key waits while the lane is held, and goes on when the lane is free', async () => {
    const calls: string[] = [];
    const base = ledgerWorld([liveDelegation(DELEG_A.keyHash)]);
    // The provider records each call that the dispute code makes to the node.
    const provider = new Proxy(base, { get: (target, name) => { const member = Reflect.get(target, name, target); return typeof member === 'function' ? (...args: unknown[]) => { calls.push(String(name)); return member.apply(target, args); } : member; } });
    const run = await setup({ provider });
    const input = {
      capability_id: PRIORAUTH_CAPABILITIES.draft, manifest_sha256: 'ab'.repeat(32), claim: PRIORAUTH_CLAIM, stake_lovelace: 5_000_000n, challenge_window_ms: 3_600_000, claim_type: 'prior-authorization',
    } as unknown as Parameters<Wired['dispute']['stakeRunClaim']>[0];
    let release: () => void = () => undefined;
    const held = run.wired.service.lane.run(() => new Promise<void>((resolve) => { release = resolve; }));
    const before = calls.length;
    const claim = run.wired.dispute.stakeRunClaim(input);
    // The call is a chain of promises with no timer. Real time passes, and nothing of it may reach the node while the lane is held.
    await new Promise<void>((resolve) => { setTimeout(resolve, 100); });
    expect(calls.length).toBe(before);
    release();
    await held;
    await claim;
    expect(calls.length).toBeGreaterThan(before);
  });

  test('the evidence and the janitor share one set of delegation ids and one list of left sub-delegations, and the delegation script is one value', async () => {
    const { wired } = await setup();
    const id = 'dd'.repeat(32);
    const janitor = wired.janitorDeps(100);
    expect(janitor.inFlight(id)).toBe(false);
    wired.evidenceDeps.inFlight.add(id);
    expect(janitor.inFlight(id)).toBe(true);
    expect(wired.inFlight.has(id)).toBe(true);
    // The set does not depend on the job: the janitor that a later call makes sees the same set.
    expect(wired.janitorDeps(200).inFlight(id)).toBe(true);
    wired.evidenceDeps.inFlight.delete(id);
    expect(janitor.inFlight(id)).toBe(false);
    expect(wired.inFlight.has(id)).toBe(false);
    expect(wired.evidenceDeps.leftSink).toBe(wired.leftStore);
    expect(janitor.store).toBe(wired.leftStore);
    expect(wired.evidenceDeps.subDelegation.delegationScript).toBe(janitor.delegationScript);
    expect(janitor.delegationScript).toBe(wired.evidenceDeps.subDelegation.delegationScript);
    expect(wired.evidenceDeps.subDelegation.chain).toBeDefined();
    expect(await wired.leftStore.list()).toStrictEqual([]);
  });

  test('one counter for the process: every job gets the same one, and its numbers go on from one job to the next', async () => {
    const { wired, dir } = await setup();
    expect(wired.proposeDeps(T0).counter).toBe(wired.counter);
    expect(wired.proposeDeps(T0 + 5).counter).toBe(wired.counter);
    expect(existsSync(join(dir, STATE_FILES.counter))).toBe(false);
    // Two numbers from the one counter are two numbers: two counters on one file would give the same number twice.
    expect([await wired.proposeDeps(T0).counter.next('run1'), await wired.proposeDeps(T0 + 1).counter.next('run1')]).toStrictEqual([1, 2]);
    expect(JSON.parse(readFileSync(join(dir, STATE_FILES.counter), 'utf8'))).toStrictEqual({ run1: 2 });
  });

  test('the state directory holds the stranded store of each of the three paying keys and the journal of the dispute code, and no store of a subagent key', async () => {
    const { dir, settings, wired } = await setup();
    expect(readdirSync(join(dir, 'keys')).sort()).toStrictEqual([settings.keys.service.pkh, settings.keys.delegation1.pkh, settings.keys.delegation2.pkh].sort());
    expect(existsSync(join(dir, STATE_FILES.dispute))).toBe(true);
    expect(wired.service.dir).toBe(join(dir, 'keys', settings.keys.service.pkh));
    expect(wired.delegations.map((key) => key.dir)).toStrictEqual([join(dir, 'keys', settings.keys.delegation1.pkh), join(dir, 'keys', settings.keys.delegation2.pkh)]);
    expect(STATE_FILES).toStrictEqual({ dispute: 'dispute', left: 'left', register: 'cosign-register.json', counter: 'request-numbers.json' });
  });
});

describe('the three paying keys', () => {
  test('are made with the key hash that the service derived, and no call reads a wallet: a chain whose wallet cannot be read does not stop the start', async () => {
    const wallets: string[] = [];
    const run = await setup({
      options: {
        createChain: async (options) => {
          const m = marketplace();
          const pkh = keyOf(options.privateKeyHex).pkh;
          return vaultChainWith(m, { wallet: () => { wallets.push(pkh); return Promise.reject(new Error('the node does not answer')); } });
        },
      },
    });
    expect(wallets).toStrictEqual([]);
    expect([run.wired.service.keyHash, ...run.wired.delegations.map((key) => key.keyHash)]).toStrictEqual([run.settings.keys.service.pkh, run.settings.keys.delegation1.pkh, run.settings.keys.delegation2.pkh]);
    // The default wiring makes its three chains too, and nothing in a start asks the chains of the stub marketplace for a wallet.
    const normal = await setup();
    expect(normal.used.filter((call) => call.method === 'wallet')).toStrictEqual([]);
  });

  test('each paying key gets the chain that its own key makes, with the identity deployment that pays from a vault, and the four subagent keys get none', async () => {
    const seen: { pkh: string; identity: unknown; ogmios: string | undefined }[] = [];
    const { settings, wired } = await setup({
      options: {
        createChain: async (options) => {
          seen.push({ pkh: keyOf(options.privateKeyHex).pkh, identity: options.identityDeployment, ogmios: options.ogmiosUrl });
          const m = marketplace();
          return vaultChainWith(m, { wallet: async () => ({ ...(await m.chain.wallet()), buyerPkh: keyOf(options.privateKeyHex).pkh }) });
        },
      },
    });
    expect(seen.map((entry) => entry.pkh)).toStrictEqual([settings.keys.service.pkh, settings.keys.delegation1.pkh, settings.keys.delegation2.pkh]);
    expect(seen.every((entry) => entry.identity === settings.identityDeployment)).toBe(true);
    expect(seen.every((entry) => entry.ogmios === settings.endpoints.ogmiosUrl)).toBe(true);
    expect(wired.delegations).toHaveLength(2);
  });

  test('two keys that are one key, and a key that is the supplier key, are refused before any chain is made, and seven keys of their own are the twin', async () => {
    const run = await setup();
    const made: string[] = [];
    const counting = { createChain: async (): Promise<VaultChain> => { made.push('chain'); throw new Error('no chain was expected'); } };
    const same = { ...run.settings.keys, delegation2: run.settings.keys.delegation1 };
    const clash = await setup({ settings: { keys: same }, options: counting }).catch((error: unknown) => error);
    expect(clash).toBeInstanceOf(Error);
    expect((clash as Error).message).toMatch(/each key must be a key of its own/);
    // A key of a subagent that is the service key is a clash too, and so is any key that is the supplier key.
    const reader = { ...run.settings.keys, recordReaderAuthentication: run.settings.keys.service };
    expect(((await setup({ settings: { keys: reader }, options: counting }).catch((error: unknown) => error)) as Error).message).toMatch(/each key must be a key of its own/);
    for (const role of KEY_ROLES) {
      const supplier = run.settings.keys[role];
      const refused = await setup({ settings: { supplier: { pkh: supplier.pkh, pubKeyHex: supplier.publicKeyHex } }, options: counting }).catch((error: unknown) => error);
      expect((refused as Error).message, role).toMatch(/or a key is the supplier key/);
    }
    expect(made).toStrictEqual([]);
    await expect(setup()).resolves.toBeDefined();
  });

  test('the key leaves its object through withKey only: no log line of a start and of a decision holds a key, a token or a bech32 key', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    await run.wired.proposeDeps(T0).justify(RECORD_SET, GUIDELINE);
    expect(run.log.length).toBeGreaterThan(0);
    for (const secret of secretsOf(startEnv({ PRIORAUTH_STATE_DIR: run.dir }))) {
      for (const line of run.log) expect(line.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    for (const role of KEY_ROLES) expect(JSON.stringify(run.settings.keys[role]).toLowerCase()).not.toContain(rawKey(KEY_NUMBERS[role]));
    expect(KEY_ROLES.map((role) => KEY_VARIABLES[role])).toHaveLength(7);
  });
});

describe('the evidence of a job of propose', () => {
  /** The world of the evidence: the sub-delegations are made on the fake chain of the kit tests, the gateway is a function that notes each token request, and the two systems answer the golden bodies. */
  async function evidenceWorld() {
    const clock = new FakeClock(ACCESS_NOW);
    const delegate = keyOf(rawKey(KEY_NUMBERS.delegation1));
    const parent = parentDatum({ delegateKey: delegate.pkh, actions: ['record.read', 'guideline.read', 'priorauth.submit'].map(hex), resources: [RECORDS_RESOURCE, GUIDELINES_RESOURCE].map(hex) });
    const chain = new FakeDelegations(clock, parent, DEPLOYMENT.delegation);
    const requests: Array<{ readonly request: TokenRequest; readonly inFlight: string[]; readonly listed: string[]; readonly janitorSees: boolean }> = [];
    const fetched: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    let wiredRef: Wired | null = null;
    const run = await setup({
      fetch: () => withModule1((async (input: RequestInfo | URL, init?: RequestInit) => {
        fetched.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
        return systemAnswer(String(input));
      }) as typeof fetch),
      options: {
        clock, delegationChain: chain,
        gateway: {
          requestToken: async (request) => {
            const id = request.delegation?.identifier ?? '';
            const live = wiredRef;
            requests.push({ request, inFlight: [...(live?.inFlight ?? [])], listed: (await live?.leftStore.list())?.map((entry) => entry.left.id) ?? [], janitorSees: live?.janitorDeps(100).inFlight(id) ?? false });
            return issued(request, clock.now());
          },
        },
      },
    });
    wiredRef = run.wired;
    return { ...run, clock, chain, requests, fetched, delegate };
  }

  test('reads the golden record set and guideline through two sub-delegations, one after the other, each with the token request of its own subagent', async () => {
    const w = await evidenceWorld();
    const key = w.wired.proposeDeps(T0).delegationKeys.find(w.delegate.pkh);
    if (key === null) throw new Error('the first delegation key is not held');
    const result = await drive(w.clock, w.wired.proposeDeps(T0).evidence({ tenant: TENANT, order_id: ORDER_ID, delegation: PARENT_ID, key }, { deadline: ACCESS_NOW + 1_620_000 }));
    expect(result).toStrictEqual({ ok: true, record_set: RECORD_SET, guideline: GUIDELINE });
    const { keys } = w.settings;
    expect(w.requests.map((entry) => entry.request.subject.did)).toStrictEqual([w.settings.recordReaderDid, w.settings.drafterDid]);
    expect(w.requests.map((entry) => entry.request.delegation?.actions)).toStrictEqual([['record.read'], ['guideline.read']]);
    // The client of the kit resolves each key that it is given, so the request holds the public key of the key and not the object of the wiring: the subject is the authentication key of its subagent, and the proof is
    // made with the delegation key of the same subagent.
    for (const [at, [authentication, delegation]] of [[keys.recordReaderAuthentication, keys.recordReaderDelegation], [keys.drafterAuthentication, keys.drafterDelegation]].entries()) {
      expect(publicKeyOf(w.requests[at].request.subject.key), `the authentication key of the read ${at + 1}`).toBe(authentication.publicKeyHex);
      expect(publicKeyOf(w.requests[at].request.dpopKey), `the delegation key of the read ${at + 1}`).toBe(delegation.publicKeyHex);
    }
    // The two reads ran one after the other: each under the sub-delegation of its own, that the Delegate of its own made, and each Delegate was followed by its Undelegate before the next.
    const ids = w.requests.map((entry) => entry.request.delegation?.identifier);
    expect(ids).toStrictEqual(w.chain.builtDelegates.map((built) => built.id));
    expect(new Set(ids).size).toBe(2);
    expect(w.chain.submitted.map((sent) => sent.kind)).toStrictEqual(['delegate', 'undelegate', 'delegate', 'undelegate']);
    expect(w.fetched.map((call) => call.url)).toStrictEqual([`${RECORDS_RESOURCE}/orders/${ORDER_ID}`, `${GUIDELINES_RESOURCE}/${RECORD_SET.order.service_code}`]);
    expect(w.fetched.every((call) => call.authorization?.startsWith('DPoP ') === true)).toBe(true);
    // While a read waits for its token, the sub-delegation is in the set of the process and in the list of the janitor, and the janitor skips it. After the read, both are empty again.
    expect(w.requests.map((entry) => [entry.inFlight, entry.listed, entry.janitorSees])).toStrictEqual([[[ids[0]], [ids[0]], true], [[ids[1]], [ids[1]], true]]);
    expect(w.wired.inFlight.size).toBe(0);
    expect(await w.wired.leftStore.list()).toStrictEqual([]);
  });

  test('the delegation key that signs the two sub-delegations is the key of the delegation of the hirer, and the key of a subagent signs the other side', async () => {
    const w = await evidenceWorld();
    const key = w.wired.proposeDeps(T0).delegationKeys.find(w.delegate.pkh);
    if (key === null) throw new Error('the first delegation key is not held');
    expect(key.signer.keyHash).toBe(w.delegate.pkh);
    await drive(w.clock, w.wired.proposeDeps(T0).evidence({ tenant: TENANT, order_id: ORDER_ID, delegation: PARENT_ID, key }, { deadline: ACCESS_NOW + 1_620_000 }));
    expect(w.chain.params.map((asked) => asked.delegateKey)).toStrictEqual([w.settings.keys.recordReaderDelegation.pkh, w.settings.keys.drafterDelegation.pkh]);
    expect(w.chain.params.every((asked) => asked.changeAddress === key.walletAddress)).toBe(true);
  });
});

describe('the reader of the insurer', () => {
  const ROW = { utxo_ref: ADVERT_REF, capability_id: PRIORAUTH_CAPABILITIES.intake, advert_status: 'Active', agent_id: INSURER_ID };
  const ADVERT = { spent: false, agentId: INSURER_ID, advert: { status: 'Active', capability_id: PRIORAUTH_CAPABILITIES.intake, model: PRIORAUTH_MODELS.intake } };

  /** The readers under `readInsurer`, with a record of what each was asked. */
  function sourcesOf(over: Partial<InsurerSources> = {}): { sources: InsurerSources; asked: { list: string[]; read: { ref: string; address: string | null; koios: string }[] } } {
    const asked: { list: string[]; read: { ref: string; address: string | null; koios: string }[] } = { list: [], read: [] };
    const sources: InsurerSources = {
      fetchSuppliers: async (options) => { asked.list.push(options.capability_id); return [ROW]; },
      readAdvert: async (ref, _fetch, koios, address) => { asked.read.push({ ref, address, koios }); return ADVERT; },
      ...over,
    };
    return { sources, asked };
  }

  test('reads the advert of the insurer, and the advert address of the identity deployment goes to the chain read', async () => {
    const { sources, asked } = sourcesOf();
    const { wired, settings } = await setup({ options: { sources } });
    expect(await wired.proposeDeps(T0).readInsurer(INSURER_DID)).toStrictEqual({ ok: true, value: { advert_ref: ADVERT_REF } });
    expect(asked.list).toStrictEqual([PRIORAUTH_CAPABILITIES.intake]);
    expect(asked.read).toStrictEqual([{ ref: ADVERT_REF, address: DEPLOYMENT.advert.address, koios: settings.endpoints.koiosUrl }]);
    expect(asked.read[0].address).toBe(settings.identityDeployment.advert.address);
    expect(typeof asked.read[0].address).toBe('string');
  });

  test('an insurer that is not listed is a typed failure, and a node or an indexer that cannot be read is its own code and never a pass', async () => {
    const none = await setup({ options: { sources: sourcesOf({ fetchSuppliers: async () => [] }).sources } });
    expect(await none.wired.proposeDeps(T0).readInsurer(INSURER_DID)).toMatchObject({ ok: false, code: 'insurer_not_listed' });
    const indexer = await setup({ options: { sources: sourcesOf({ fetchSuppliers: async () => { throw new Error('the indexer is down'); } }).sources } });
    expect(await indexer.wired.proposeDeps(T0).readInsurer(INSURER_DID)).toMatchObject({ ok: false, code: 'insurer_unavailable' });
    const chain = await setup({ options: { sources: sourcesOf({ readAdvert: async () => ({ error: 'no advert' }) }).sources } });
    expect(await chain.wired.proposeDeps(T0).readInsurer(INSURER_DID)).toMatchObject({ ok: false, code: 'insurer_unavailable' });
  });
});

describe('the decision `justification` of a job of propose', () => {
  test('hires a model from the service key, shows it the order, the records and the guideline and not the references of the patient and the clinician, and gives the choice that the decision records', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE, 'The records support two criteria.');
    const answer = await run.wired.proposeDeps(T0).justify(RECORD_SET, GUIDELINE);
    if (!answer.ok) throw new Error(`the decision failed with ${answer.code}`);
    expect(answer.choice).toStrictEqual(CHOICE);
    expect(answer.choice).toStrictEqual(answer.decision.choice);
    expect(answer.decision).toMatchObject({ name: 'justification', choice: CHOICE, reasoning: 'The records support two criteria.' });
    expect(answer.decision.inference.path).toBe('marketplace');
    expect(run.m.llm.sends).toHaveLength(1);
    const prompt = run.m.llm.sends[0].body;
    for (const shown of ['ORD-1001', 'REC-0002', 'SYN-MRI-LS', 'Imaging of the lumbar spine']) expect(prompt).toContain(shown);
    for (const hidden of ['SYN-PT-0001', 'SYN-CL-0007']) expect(prompt).not.toContain(hidden);
    expect(run.log.filter((line) => line.startsWith('booked a Post'))).toHaveLength(1);
    expect(run.log.filter((line) => line.startsWith('booked an Accept'))).toHaveLength(1);
    // The key that pays: the Post and the Accept of the model hire are made by the chain of the service key, and no other chain makes a call of any kind.
    const servicePkh = run.settings.keys.service.pkh;
    expect(run.used.filter((call) => call.method === 'postEscrow').map((call) => call.pkh)).toStrictEqual([servicePkh]);
    expect(run.used.filter((call) => call.method === 'accept').map((call) => call.pkh)).toStrictEqual([servicePkh]);
    expect(run.used.filter((call) => call.pkh !== servicePkh)).toStrictEqual([]);
  });

  test('builds the closed sets of the references from the sets of its own job: an unknown record or criterion is model_output_invalid, and a reference of another set is the twin of one that its own set holds', async () => {
    const run = await setup();
    const justify = (set: typeof RECORD_SET, guideline: typeof GUIDELINE) => run.wired.proposeDeps(T0).justify(set, guideline);
    run.m.llm.answer = said({ ...CHOICE, record_refs: ['REC-0002', 'REC-9999'] });
    expect(await justify(RECORD_SET, GUIDELINE)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
    run.m.llm.answer = said({ ...CHOICE, guideline_refs: ['C1', 'C9'] });
    expect(await justify(RECORD_SET, GUIDELINE)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
    // A record of the knee set is no record of the lumbar set, and it is one of the knee set: the closed sets come from the set that the job gives.
    const knee = { ...CHOICE, record_refs: ['REC-0101'] };
    run.m.llm.answer = said(knee);
    expect(await justify(RECORD_SET, GUIDELINE)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
    const kneeAnswer = await justify(KNEE_RECORD_SET, KNEE_GUIDELINE);
    expect(kneeAnswer.ok).toBe(true);
    if (kneeAnswer.ok) expect(kneeAnswer.choice).toStrictEqual(knee);
    run.m.llm.answer = said(CHOICE);
    expect((await justify(RECORD_SET, GUIDELINE)).ok).toBe(true);
    // The reference of an earlier job does not stay: the lumbar record is refused for the knee set.
    expect(await justify(KNEE_RECORD_SET, KNEE_GUIDELINE)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
  });

  test('a prompt that is too large fails with bad_input before any hire, and nothing is posted', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    const big = { ...RECORD_SET, records: [{ ...RECORD_SET.records[0], summary: 'x'.repeat(400_000) }, ...RECORD_SET.records.slice(1)] };
    expect(await run.wired.proposeDeps(T0).justify(big, GUIDELINE)).toStrictEqual({ ok: false, code: 'bad_input' });
    expect(run.m.llm.sends).toHaveLength(0);
    expect(run.used.filter((call) => call.method === 'postEscrow')).toStrictEqual([]);
  });

  test('the book of the hire logs the lock, the fee and the transaction hash and nothing else', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    await run.wired.proposeDeps(T0).justify(RECORD_SET, GUIDELINE);
    const booked = run.log.filter((line) => line.startsWith('booked '));
    expect(booked).toHaveLength(2);
    expect(booked[0]).toMatch(/^booked a Post: lock \d+ lovelace, fee \d+ lovelace$/);
    expect(booked[1]).toMatch(/^booked an Accept: fee \d+ lovelace, transaction [0-9a-f]{64}$/);
  });

  test('the deadline of the decision is the deadline of the job that asks it: a job that arrived too long ago hires nothing, and a job that arrived now hires', async () => {
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    const late = await run.wired.proposeDeps(T0 - PROPOSE_DEADLINE_MS - 1).justify(RECORD_SET, GUIDELINE);
    expect(late).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    expect(run.m.llm.sends).toHaveLength(0);
    expect((await run.wired.proposeDeps(T0).justify(RECORD_SET, GUIDELINE)).ok).toBe(true);
    expect(run.m.llm.sends).toHaveLength(1);
  });

  test('the log of proposeDeps and of executeDeps is the log of the service', async () => {
    const run = await setup();
    run.wired.proposeDeps(T0).log('marker of the propose deps');
    run.wired.executeDeps(T0).log('marker of the execute deps');
    expect(run.log.some((line) => line.includes('marker of the propose deps'))).toBe(true);
    expect(run.log.some((line) => line.includes('marker of the execute deps'))).toBe(true);
  });
});

describe('the decision `accept_delivery` and the hire of a job of execute', () => {
  const SENT = sideOf(requestDocument());

  test('hires a model from the service key and gives the choice as the decision records it, for an acceptance and for a no', async () => {
    const run = await setup();
    run.m.llm.answer = said({ accept: true, mismatch: [] });
    const accepted = await run.wired.executeDeps(T0).acceptDelivery(SENT, SENT);
    if (!accepted.ok) throw new Error(`the decision failed with ${accepted.code}`);
    expect(accepted.choice).toStrictEqual({ accept: true, mismatch: [] });
    expect(accepted.decision).toMatchObject({ name: 'accept_delivery', choice: { accept: true, mismatch: [] } });
    // The prompt holds the two numbers and the two hashes, as the model compares them, and no other member of a request.
    const other = sideOf(requestDocument({ justification: 'Another justification of the same request.' }));
    run.m.llm.answer = said({ accept: false, mismatch: ['request_sha256'] });
    const declined = await run.wired.executeDeps(T0).acceptDelivery(SENT, other);
    if (!declined.ok) throw new Error(`the decision failed with ${declined.code}`);
    expect(declined.choice).toStrictEqual({ accept: false, mismatch: ['request_sha256'] });
    expect(declined.decision.choice).toStrictEqual({ accept: false, mismatch: ['request_sha256'] });
    expect(run.m.llm.sends).toHaveLength(2);
    const prompt = run.m.llm.sends[1].body;
    for (const shown of [SENT.request_sha256, other.request_sha256, SENT.request_number]) expect(prompt).toContain(shown);
    expect(prompt).not.toContain('SYN-PT-0001');
  });

  test('a failed decision gives the reason of the failure as its code, a job that arrived too long ago hires nothing, and two request numbers that differ are refused before any hire', async () => {
    const run = await setup();
    run.m.llm.answer = 'this is not a decision';
    expect(await run.wired.executeDeps(T0).acceptDelivery(SENT, SENT)).toStrictEqual({ ok: false, code: 'model_output_invalid' });
    const before = run.m.llm.sends.length;
    expect(await run.wired.executeDeps(T0 - 1_620_001).acceptDelivery(SENT, SENT)).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    const another = sideOf(requestDocument({ request_number: 'run1-2' }));
    await expect(run.wired.executeDeps(T0).acceptDelivery(SENT, another)).rejects.toThrow(TypeError);
    expect(run.m.llm.sends).toHaveLength(before);
  });

  test('the hire of the Insurer Intake Agent gets the three limits of the handoff, the two delegation keys as the buyer keys, the service key as the key of the agent, and the fault switch of the start', async () => {
    const { wired, settings } = await setup();
    const deps = wired.executeDeps(T0);
    expect(deps.limits).toStrictEqual({ maxPriceLovelace: 2_000_000n, maxSupplierBondLovelace: 2_000_000n, maxBuyerBondLovelace: 2_000_000n });
    expect(deps.buyerPkhs).toStrictEqual([settings.keys.delegation1.pkh, settings.keys.delegation2.pkh]);
    expect(deps.agent).toStrictEqual({ did: settings.agentDid, authenticationKey: settings.keys.service.keyObject });
    expect(deps.dispute).toBe(wired.dispute);
    expect(deps.fault).toBe(settings.fault);
    expect(deps.fault.mode).toBe('');
    expect(deps.tokens.client).toBe(wired.gateway);
    expect(deps.calls.bases).toStrictEqual(settings.mock);
    const evidence = wired.evidenceDeps.subagents;
    expect(evidence.record_reader.did).toBe(settings.recordReaderDid);
    expect(evidence.record_reader.authenticationKey).toBe(settings.keys.recordReaderAuthentication.keyObject);
    expect(evidence.record_reader.delegationKey).toBe(settings.keys.recordReaderDelegation.keyObject);
    expect(evidence.record_reader.signer.keyHash).toBe(settings.keys.recordReaderDelegation.pkh);
    expect(evidence.drafter.did).toBe(settings.drafterDid);
    expect(evidence.drafter.authenticationKey).toBe(settings.keys.drafterAuthentication.keyObject);
    expect(evidence.drafter.delegationKey).toBe(settings.keys.drafterDelegation.keyObject);
    expect(evidence.drafter.signer.keyHash).toBe(settings.keys.drafterDelegation.pkh);
    expect(wired.proposeDeps(T0).agent).toStrictEqual({ did: settings.agentDid });
  });

  test('the fault switch of the start is the switch of the deps: a start with the fault value gives it to the job', async () => {
    const { wired } = await setup({ env: { FAULT_MODE: 'alter_after_approval' } });
    expect(wired.executeDeps(T0).fault.mode).toBe('alter_after_approval');
  });
});

describe('the reads of the ledger', () => {
  test('the key of a delegation is the delegate key of its leaf, and a delegation that the ledger does not show has none', async () => {
    const { wired } = await setup();
    const deps = wired.proposeDeps(T0);
    expect(await deps.delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
    expect(await deps.delegateKeyOf('88'.repeat(32))).toBeNull();
    expect(await wired.executeDeps(T0).delegateKeyOf('77'.repeat(32))).toBe(DELEG_A.keyHash);
  });

  test('a ledger that cannot be read rejects: it is never "no delegation"', async () => {
    const broken = ledgerWorld();
    broken.getUtxos = async () => { throw new Error('the node does not answer'); };
    const { wired } = await setup({ provider: broken });
    await expect(wired.proposeDeps(T0).delegateKeyOf('77'.repeat(32))).rejects.toThrow();
    await expect(wired.proposeDeps(T0).reads.delegation('77'.repeat(32))).rejects.toThrow();
  });
});

describe('the start', () => {
  test('stops when the node gives no start time of the chain, and the node that gives one is its twin', async () => {
    const none = ledgerWorld();
    none.getSystemStartMs = async () => { throw new Error('the node does not answer'); };
    const failed = await setup({ provider: none }).catch((error: unknown) => error);
    expect((failed as Error).message).toMatch(/^the node gave no start time of the chain/);
    for (const bad of [Number.NaN, 0, -5, 1.5]) {
      const odd = ledgerWorld();
      odd.getSystemStartMs = async () => bad;
      const refused = await setup({ provider: odd }).catch((error: unknown) => error);
      expect((refused as Error).message).toMatch(/^the node gave a start time of the chain that is not a time/);
    }
    const { wired } = await setup();
    expect(wired.systemStartMs).toBe(SYSTEM_START_MS);
  });

  /** A fetch in front of the stub marketplace that answers MODULE1_URL with `response()` and passes every other call on. */
  const answering = (response: () => Response) => (next: typeof fetch): typeof fetch => (async (input, init) => (String(input) === MODULE1_URL ? response() : next(input, init))) as typeof fetch;

  test('fetches the Module-1 manifest at its pinned address one time, and the start fetches nothing else', async () => {
    const seen: string[] = [];
    const spy = (next: typeof fetch): typeof fetch => (async (input, init) => { seen.push(String(input)); return withModule1(next)(input, init); }) as typeof fetch;
    await setup({ fetch: spy });
    expect(seen).toStrictEqual([MODULE1_URL]);
  });

  test('stops when the Module-1 manifest cannot be fetched, or is not JSON, naming the variable, and the answer of the stub is its twin', async () => {
    const missing = await setup({ fetch: answering(() => new Response('', { status: 404 })) }).catch((error: unknown) => error);
    expect((missing as Error).message).toMatch(/^The Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) .* cannot be fetched: the host answered HTTP 404/);
    const notJson = await setup({ fetch: answering(() => new Response('not json', { status: 200 })) }).catch((error: unknown) => error);
    expect((notJson as Error).message).toMatch(/^The Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) .* is not JSON/);
    await expect(setup()).resolves.toBeDefined();
  });

  test('stops when the Module-1 manifest names another identity registry than IDENTITY_POLICY_ID, naming the two settings and no hash, and the manifest of the fixture is its twin', async () => {
    const fixture = await (await withModule1(fetch)(MODULE1_URL)).text();
    const other = JSON.parse(fixture) as { identity: { identity_hash: string } };
    const registry = other.identity.identity_hash;
    other.identity.identity_hash = 'ab'.repeat(28);
    const failed = await setup({ fetch: answering(() => new Response(JSON.stringify(other), { status: 200 })) }).catch((error: unknown) => error);
    const message = (failed as Error).message;
    expect(message).toMatch(/^the Module-1 manifest \(VECTOR_MODULE1_MANIFEST\) names another identity registry than IDENTITY_POLICY_ID/);
    expect(message).not.toContain('ab'.repeat(28));
    expect(message).not.toContain(registry);
    await expect(setup({ fetch: answering(() => new Response(fixture, { status: 200 })) })).resolves.toBeDefined();
  });

  test('the janitors start and stop, each with its own bound, and the line of an abandoned job names the escrows that the state directory holds', async () => {
    const { wired } = await setup();
    expect(wired.abandonedLine(300_000)).toBe('stopping: the job that is running did not finish within 300000 ms and is abandoned; the state directory holds 0 escrows for the janitors of the next start');
    wired.delegations[0].stranded.add({ escrow_ref: `${'ab'.repeat(32)}#0`, deliver_by: T0 + 1_000_000, posted_at: T0, kind: 'agent' });
    expect(wired.abandonedLine(1)).toContain(`holds 1 escrow for the janitors of the next start: ${'ab'.repeat(32)}#0`);
    const running = wired.startJanitors(60_000, 100);
    await running.stop();
    await running.stop();
  });
});

describe('the co-sign route', () => {
  /** The wiring over the fixture world of the route: the agent is the agent of that world, and `extra` outputs stand on the node. */
  const routeOf = async (extra: Parameters<typeof ledgerWorld>[0] = []) => {
    // The fixture world builds its Delegate at its own time, and the route reads the validity window of a transaction against the clock that it is given: the clock of this run stands at that time.
    const run = await setup({ env: { AGENT_DID: KIT_AGENT_DID }, provider: ledgerWorld(extra), options: { clock: { now: () => NOW, sleep: async () => undefined } } });
    return { ...run, route: run.wired.cosignRoute(cosignSettingsOf(startEnv())) };
  };

  test('is made over the two delegation keys, and a setting that the kit refuses stops the start with its detail', async () => {
    const { route, wired } = await routeOf();
    expect(route.path).toBe('/cosign/delegate');
    const settings = cosignSettingsOf(startEnv());
    const refused = messageOf(() => wired.cosignRoute({ ...settings, maxConcurrent: 0 }));
    expect(refused).toMatch(/^the co-sign route is refused: /);
    expect(refused).toContain('COSIGN_MAX_CONCURRENT');
    for (const secret of secretsOf()) expect(refused.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(settings.maxConcurrent).toBe(4);
  });

  test('signs for the delegation key and refuses a Delegate that the delegator did not sign first, and the Delegate that an allowlisted delegator signed is its twin', async () => {
    const { route } = await routeOf();
    const { hex: transaction } = await build();
    expect(await route.cosign(JSON.stringify({ transaction }))).toMatchObject({ ok: false, code: 'principal_not_allowed' });
    expect(await route.cosign(requestOf(transaction))).toMatchObject({ ok: true });
    expect(KIT_PRINCIPAL.keyHash).toBe(PRINCIPAL.keyHash);
  });

  test('refuses a Delegate that spends an output of any other key of the agent: the service key, the supplier key and the four subagent keys, and the wallet of a stranger is the twin', async () => {
    // The fixture world holds the wallets of the service key and of the supplier key already, and the node holds an output of each of the four subagent keys that this test adds.
    const others = [24, 23, 41, 42, 43, 44].map((n) => testKeyOf(n));
    const { route } = await routeOf(others.slice(2).map((key) => agentWallet(key, 1)));
    const { hex: transaction } = await build();
    for (const key of others) {
      expect(await route.cosign(requestOf(withInput(transaction, agentWallet(key, 1)))), `the key ${key.n}`).toMatchObject({ ok: false, code: 'spends_agent_funds' });
    }
    const stranger = await routeOf([agentWallet(STRANGER, 1)]);
    expect(await stranger.route.cosign(requestOf(withInput(transaction, agentWallet(STRANGER, 1))))).toMatchObject({ ok: true });
  });
});

describe('the terms of the advert', () => {
  test('are the price 3 and both bonds 1, and a Post on the advert locks the price and both bonds: 5,000,000 lovelace, for the manifest that the settings give', () => {
    const settings = settingsOf(startEnv());
    const env = startEnv({ PRIORAUTH_SERVICE_PKH: settings.keys.service.pkh, PRIORAUTH_DELEGATION_1_PKH: settings.keys.delegation1.pkh, PRIORAUTH_DELEGATION_2_PKH: settings.keys.delegation2.pkh });
    const rendered = renderManifest('prior-authorization-agent', (setting) => manifestFromEnv({ ...env, FAULT_MODE: setting }));
    if (!rendered.ok) throw new Error(rendered.detail);
    const { terms, capability_id: capability } = JSON.parse(rendered.value.text) as { terms: { price_lovelace: number; supplier_bond_lovelace: number; buyer_bond_lovelace: number; max_processing_ms: number }; capability_id: string };
    expect([terms.price_lovelace, terms.supplier_bond_lovelace, terms.buyer_bond_lovelace]).toStrictEqual([3_000_000, 1_000_000, 1_000_000]);
    const advert = {
      supplier_pkh: SUPPLIER.keyHash, capability_id: capability, model: PRIORAUTH_MODELS.draft, max_output_tokens: 0, max_processing_ms: terms.max_processing_ms, price_lovelace: BigInt(terms.price_lovelace),
      supplier_bond_lovelace: BigInt(terms.supplier_bond_lovelace), buyer_bond_lovelace: BigInt(terms.buyer_bond_lovelace), endpoint_url: 'https://priorauth.example.test',
      detail_uri: 'https://priorauth.example.test/agent.json', detail_hash: rendered.value.sha256, advertised_at: T0, status: 'Active', agent_id: settings.agentDid.slice('did:vector:'.length),
    } as const;
    const plan = planFleetPostEscrow(advert, `${'cc'.repeat(32)}#0`, settings.keys.delegation1.pkh, 'dd'.repeat(32), T0, fleetPostTerms(advert, settings.keys.delegation1.address));
    expect(plan.lockLovelace).toBe(5_000_000n);
    expect(plan.lockLovelace).toBe(BigInt(terms.price_lovelace + terms.supplier_bond_lovelace + terms.buyer_bond_lovelace));
    expect(plan.deliverBy).toBe(T0 + terms.max_processing_ms + DELIVER_BY_BUFFER_MS);
  });
});

describe('the deadline of a job', () => {
  test('is one value in the settings, in the job propose and in the job execute: 1,620,000 ms after the request arrived, and the decision of a job holds it', async () => {
    expect([JOB_DEADLINE_MS, PROPOSE_DEADLINE_MS, EXECUTE_DEADLINE_MS]).toStrictEqual([1_620_000, 1_620_000, 1_620_000]);
    const run = await setup();
    run.m.llm.answer = said(CHOICE);
    // A job that arrived exactly one deadline ago has no time left for a hire, and a job that arrived two minutes later has: a hire needs at least a minute, and the decision gets the deadline of its own job and no other.
    expect(await run.wired.proposeDeps(T0 - JOB_DEADLINE_MS).justify(RECORD_SET, GUIDELINE)).toStrictEqual({ ok: false, code: 'llm_out_of_time' });
    expect((await run.wired.proposeDeps(T0 - JOB_DEADLINE_MS + 120_000).justify(RECORD_SET, GUIDELINE)).ok).toBe(true);
  });
});
