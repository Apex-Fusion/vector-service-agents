// agents/insurer-intake-agent/test/serve/wiring.test.ts
// The real ports of the Insurer Intake Agent, made from the configuration: the state files, the one paying key and its one queue, the two gateway clients (the short budget of the hook, and the default time of the
// JWT-SVID), the ledger reads of the hook and of the report that end inside their budgets whatever the environment of the ledger says, the one record of passed checks and the one intake book that the hook and the job
// share, the real report over the ledger, the real model decision over the stub marketplace and its deadline, the task of the challenge that starts after the answer, the Module-1 port over the manifest of the
// deployment, and the log lines that name codes and kinds and never a message. No test here uses the network.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { FakeChain, rawHexToBech32 } from '@vsa/buyer-core';
import { fetchJwtSvid, jwtSvidTarget } from '@vsa/usecase-kit/access';
import { HIRE_MIN_MS } from '@vsa/usecase-kit/decision';
import { INTAKE_CHECKS } from '@vsa/usecase-kit/priorauth';
import { canonicalSha256 } from '@vsa/usecase-kit/protocol';
import { REPORT_BUDGET_MS as JOB_REPORT_BUDGET_MS } from '../../src/job/attest.ts';
import { RUNTIME_MARGIN_MS } from '../../src/job/index.ts';
import { READ_BUDGET_MS as REPORT_READ_BUDGET_MS, REPORT_BUDGET_MS } from '../../src/report/index.ts';
import { CALL_TIMEOUT_MS, JOB_DEADLINE_MS } from '../../src/serve/settings.ts';
import { loadConfig } from '../../src/serve/start.ts';
import { GATEWAY_DEFAULT_TIMEOUT_MS, wireService } from '../../src/serve/wiring.ts';
import { until } from './serve.ts';
import { DELEGATION_ID, INTAKE_DID, T, makeWorld, proposalOf } from './world.ts';
import type { World } from './world.ts';
import { MODULE1_URL, SERVICE, cleanDirs, message, module1ManifestText, shows, startEnvWith, withModule1 } from './support.ts';
import type { Module1Answer } from './support.ts';

afterEach(() => { cleanDirs(); vi.restoreAllMocks(); });

function hashOf(value: unknown): string {
  const hash = canonicalSha256(value);
  if (!hash.ok) throw new Error(hash.detail);
  return hash.value;
}

/** The digest of an authorization request that the hirer did not approve: the approval that holds it does not match the request that the sender sends. */
const OTHER_DIGEST = proposalOf({ request_number: 'run1-9' }).proposal_digest;
/** The input of the decision as the job gives it: six members of the request and the requirement set. Only its form matters here. */
const INPUT = {
  request: {
    ordering_clinician_ref: 'SYN-CL-0007', diagnosis_codes: ['M54.16'], justification: 'Criterion C1 is met. This text is synthetic.', guideline_refs: ['C1'], record_refs: ['REC-0002'], record_set_sha256: 'ab'.repeat(32),
  },
  requirements: { service_code: 'SYN-MRI-LS', title: 'Intake requirements', requirements: [{ id: 'R1', text: 'The request names the ordering clinician.' }, { id: 'R4', text: 'The request lists the records.' }] },
};
const IDS = ['R1', 'R2', 'R3', 'R4', 'R5'];
const MISSING_R9 = JSON.stringify({ reasoning: 'One requirement is not met.', choice: { complete: false, missing: ['R9'] } });

async function wired(world: World, over: Readonly<Record<string, string | undefined>> = {}) {
  const config = loadConfig({ ...world.env, ...over });
  return { config, ...(await wireService(config, world.options)) };
}

/** A wait of `ms` that a signal ends: a gateway that answers late. The tests of the two clients need real time, because the client bounds a call with a timer of its own. */
const lateGateway = (world: World, ms: number): typeof fetch => async (input, init) => {
  const signal = init?.signal;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true });
  });
  return world.options.fetchImpl!(input, init);
};

describe('wireService makes the real parts from the configuration', () => {
  test('the state files of the service are on its volume: the intake book, and the folder of the paying key, which is the service key', async () => {
    const world = makeWorld();
    const { key } = await wired(world);
    expect(existsSync(join(world.stateDir, 'requests.json'))).toBe(true);
    expect(existsSync(join(world.stateDir, 'keys', SERVICE.pkh))).toBe(true);
    expect([key.keyHash, key.dir, key.chain]).toStrictEqual([SERVICE.pkh, join(world.stateDir, 'keys', SERVICE.pkh), world.m.chain]);
  });

  test('the wiring reads no node and no gateway: a chain whose wallet cannot be read does not stop it', async () => {
    const world = makeWorld();
    const config = loadConfig(world.env);
    const chain = new FakeChain({ buyerPkh: SERVICE.pkh });
    chain.wallet = () => Promise.reject(new Error('the node does not answer'));
    const made = await wireService(config, { ...world.options, createChain: async () => chain, fetchImpl: () => Promise.reject(new Error('no network')) });
    expect(made.key.chain).toBe(chain);
  });

  test('the hook is a function for every configuration: the wiring has no configuration that leaves it out', async () => {
    for (const over of [{}, { CHECKS_READ_BUDGET_MS: '500' }, { CHECKS_READ_BUDGET_MS: '1499' }, { VECTOR_MARKETPLACE_INDEXER_URL: undefined }, { ADVERT_PRICE_LOVELACE: '6000000' }]) {
      const world = makeWorld();
      const { precheck } = await wired(world, over);
      expect(typeof precheck, JSON.stringify(over)).toBe('function');
    }
  });

  test('the job gets the service as its agent, the origins of the mock service, the call limit of 20 s, and the fetch and the clock of the wiring', async () => {
    const world = makeWorld();
    const { config, jobDeps } = await wired(world);
    const deps = jobDeps(T, world.context);
    expect(deps.agent.did).toBe(INTAKE_DID);
    expect(deps.agent.authenticationKey).toBe(config.service.keyObject);
    expect(deps.calls.bases).toStrictEqual(config.mock);
    expect([deps.calls.timeoutMs, CALL_TIMEOUT_MS]).toStrictEqual([20_000, 20_000]);
    expect(deps.calls.fetch).toBe(world.options.fetchImpl);
    expect(deps.calls.clock.now()).toBe(world.m.clock.now);
    expect(deps.clock()).toBe(world.m.clock.now);
    // No record of the hook yet: the job finds none.
    expect(deps.takeChecks(world.context.escrowRef)).toBeNull();
  });
});

describe('the hook and the job hold one record of passed checks and one intake book', () => {
  test('a go of the hook is taken by the job one time, with the hash of the request that the hook checked: a second take finds none', async () => {
    const world = makeWorld();
    const { precheck, jobDeps, passed } = await wired(world);
    expect(await precheck(world.handoff, world.context)).toStrictEqual({ go: true });
    const deps = jobDeps(T, world.context);
    const taken = deps.takeChecks(world.context.escrowRef);
    expect(taken?.request_sha256).toBe(hashOf(world.handoff));
    expect(Object.keys(taken?.record.checks ?? {})).toStrictEqual([...INTAKE_CHECKS]);
    expect(deps.takeChecks(world.context.escrowRef)).toBeNull();
    expect(jobDeps(T, world.context).takeChecks(world.context.escrowRef)).toBeNull();
    // The one store of the process: what the hook puts is in the store that the wiring hands out.
    expect(passed.take(world.context.escrowRef, world.m.clock.now)).toBeNull();
    expect(await precheck(world.handoff, world.context)).toStrictEqual({ go: true });
    expect(passed.take(world.context.escrowRef, world.m.clock.now)?.request_sha256).toBe(hashOf(world.handoff));
  });

  test('the intake book is the file requests.json: the job writes it, the hook reads it, and both hold the one object', async () => {
    const world = makeWorld();
    const { precheck, jobDeps, book } = await wired(world);
    expect(jobDeps(T, world.context).book).toBe(book);
    expect(jobDeps(T + 5_000, world.context).book).toBe(book);
    expect(await precheck(world.handoff, world.context)).toStrictEqual({ go: true });
    await jobDeps(T, world.context).book.record('run1', 'run1-1', 'IN-run1-0001');
    expect(readFileSync(join(world.stateDir, 'requests.json'), 'utf8')).toContain('IN-run1-0001');
    expect(await precheck(world.handoff, world.context)).toMatchObject({ go: false, status: 403, error: 'duplicate_request' });
  });

  test('a book that cannot be read gives the hook 503 check_unavailable, never a go and never the code of a rule', async () => {
    const world = makeWorld();
    const { precheck } = await wired(world);
    expect(await precheck(world.handoff, world.context)).toStrictEqual({ go: true });
    rmSync(join(world.stateDir, 'requests.json'));
    expect(await precheck(world.handoff, world.context)).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
    expect(world.logs.some((line) => line.startsWith('the hook could not read the intake book'))).toBe(true);
  });
});

describe('the one paying key has one queue', () => {
  test('a model hire runs in the queue of the service key', async () => {
    const world = makeWorld();
    const { key, jobDeps } = await wired(world);
    const hold = world.holdModel();
    expect(key.lane.busy).toBe(false);
    const hire = jobDeps(T, world.context).decide(INPUT, IDS);
    await hold.reached;
    expect(key.lane.busy).toBe(true);
    hold.release();
    const result = await hire;
    expect(result.ok).toBe(true);
    expect(key.lane.busy).toBe(false);
  });

  test('the challenge of the dispute code runs in the same queue, so a challenge and a hire never build from the one wallet together', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    const release = world.port.holdPublish();
    const { key, precheck } = await wired(world);
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    await until(() => world.port.events.some((event) => event.startsWith('publish')), 'the challenge has begun to publish its evidence');
    expect(key.lane.busy).toBe(true);
    release();
    await until(() => world.port.challenged.length === 1, 'the challenge is filed');
    await until(() => !key.lane.busy, 'the queue is free');
  });
});

describe('the task of the challenge', () => {
  test('starts after the hook has answered, in a later turn of the event loop: when the answer is in hand and every waiting microtask has run, the dispute code has not begun, and it begins in the turn after', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    // The dispute code bounds its first read with the sleep of the wiring, and it calls that sleep in the first run of its task, before any wait. A call of the sleep shows that the task has begun.
    const sleeps: number[] = [];
    const config = loadConfig(world.env);
    const { precheck } = await wireService(config, { ...world.options, sleep: (ms) => { sleeps.push(ms); return world.options.sleep!(ms); } });
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    // A task that a microtask started would have called the sleep by now, for the microtask comes before the answer is in hand. A long chain of microtasks runs before any turn of the event loop does.
    for (let step = 0; step < 100; step += 1) await Promise.resolve();
    expect(sleeps).toStrictEqual([]);
    await until(() => sleeps.includes(config.dispute.read_timeout_ms), 'the task has begun');
    await until(() => world.port.challenged.length === 1, 'the challenge is filed');
  });

  test('catches its own errors: a port of the dispute code that fails leaves a line with the code and never its message, and the answer of the hook is the same', async () => {
    const world = makeWorld({ attestation: { digest: OTHER_DIGEST } });
    world.armChallenge();
    world.port.readClaimsFails = new TypeError('the claims cannot be read: https://koios.example/?key=secret-token-123');
    const { precheck } = await wired(world);
    expect(await precheck(world.handoff, world.context)).toMatchObject({ go: false, status: 403, error: 'approval_digest_mismatch' });
    await until(() => world.logs.some((line) => line.startsWith('insurer intake agent: challenge not filed')), 'the log has the result');
    for (const line of world.logs) expect(line).not.toContain('secret-token');
  });
});

describe('the model decision', () => {
  test('is the real decision of the kit over the stub marketplace: one hire from the service key, the answer of the model as the choice, and a booking line with the fee and the hash', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    const result = await jobDeps(T, world.context).decide(INPUT, IDS);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect([result.value.name, result.value.choice, result.value.inference.path]).toStrictEqual(['completeness', { complete: true, missing: [] }, 'marketplace']);
    expect(world.m.llm.sends).toHaveLength(1);
    const posted = world.logs.filter((line) => line.startsWith('model hire: posted'));
    const accepted = world.logs.filter((line) => line.startsWith('model hire: accepted'));
    expect([posted.length, accepted.length]).toStrictEqual([1, 1]);
    expect(posted[0]).toMatch(/^model hire: posted, locked \d+ lovelace, fee \d+ lovelace$/);
    expect(accepted[0]).toMatch(/^model hire: accepted in [0-9a-f]{64}, fee \d+ lovelace$/);
  });

  test('builds the closed set of requirements from the ids that it is given: a requirement that the model names and the job did not give is refused, and the same answer is taken when the id is given', async () => {
    const refusing = makeWorld();
    refusing.m.llm.answer = MISSING_R9;
    const refused = await (await wired(refusing)).jobDeps(T, refusing.context).decide(INPUT, ['R1', 'R2']);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('model_output_invalid');
    const taking = makeWorld();
    taking.m.llm.answer = MISSING_R9;
    const taken = await (await wired(taking)).jobDeps(T, taking.context).decide(INPUT, ['R1', 'R9']);
    expect(taken.ok, JSON.stringify(taken)).toBe(true);
    if (taken.ok) expect(taken.value.choice).toStrictEqual({ complete: false, missing: ['R9'] });
  });

  test('has the deadline of the job, 300 s after its arrival: with less than a minute left it hires nothing', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    expect(JOB_DEADLINE_MS).toBe(300_000);
    expect(HIRE_MIN_MS).toBe(60_000);
    const late = await jobDeps(T - JOB_DEADLINE_MS + HIRE_MIN_MS - 1_000, world.context).decide(INPUT, IDS);
    expect(late.ok).toBe(false);
    if (!late.ok) expect([late.code, late.reason]).toStrictEqual(['inference_failed', 'llm_out_of_time']);
    expect(world.m.llm.sends).toStrictEqual([]);
    expect(world.logs.filter((line) => line.startsWith('model hire:'))).toStrictEqual([]);
  });

  test('never runs past the end of the time that the filing needs: deliver_by less 30 s, less the 20 s of a call, less the 10 s of a new JWT-SVID, so no escrow is posted and nothing is paid for a decision that could not be filed after it', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    expect([RUNTIME_MARGIN_MS, CALL_TIMEOUT_MS, GATEWAY_DEFAULT_TIMEOUT_MS]).toStrictEqual([30_000, 20_000, 10_000]);
    // The job arrived now, so its own deadline is 300 s away. The escrow ends in 119 s: 119 less 30, less 20, less 10 leaves 59 s, which is under the 60 s that a hire needs. Without the 10 s of the new JWT-SVID it
    // would leave 69 s and a hire.
    const short = await jobDeps(T, { ...world.context, deliverByMs: T + 119_000 }).decide(INPUT, IDS);
    expect(short.ok).toBe(false);
    if (!short.ok) expect([short.code, short.reason]).toStrictEqual(['inference_failed', 'llm_out_of_time']);
    // Nothing was posted or accepted: the book of the hires holds no line. The model supplier had no job.
    expect(world.logs.filter((line) => line.startsWith('model hire:'))).toStrictEqual([]);
    expect(world.m.llm.sends).toStrictEqual([]);
    // The same job with the time of the escrow that the world gives hires, and the book then holds its lines: the check above is not empty for want of a line.
    expect((await jobDeps(T, world.context).decide(INPUT, IDS)).ok).toBe(true);
    expect(world.m.llm.sends).toHaveLength(1);
    expect(world.logs.filter((line) => line.startsWith('model hire: posted'))).toHaveLength(1);
  });

  test('refuses an escrow whose end is not a number: an unknown time is never enough time', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    const result = await jobDeps(T, { ...world.context, deliverByMs: Number.NaN }).decide(INPUT, IDS);
    expect(result.ok).toBe(false);
    expect(world.m.llm.sends).toStrictEqual([]);
    expect(world.logs.filter((line) => line.startsWith('model hire:'))).toStrictEqual([]);
  });

  test('has the limits of the settings: a model that the allowlist does not name is never hired', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world, { LLM_MODEL_ALLOWLIST: 'another/model-that-is-not-listed' });
    const result = await jobDeps(T, world.context).decide(INPUT, IDS);
    expect(result.ok).toBe(false);
    expect(world.m.llm.sends).toStrictEqual([]);
  });
});

describe('the time of the hook', () => {
  test('the gateway client of the hook has the budget of the hook: a gateway that answers in 700 ms is no answer with a budget of 500 ms', async () => {
    const world = makeWorld();
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
    expect(world.logs.some((line) => line.startsWith('the hook could not read the identity gateway'))).toBe(true);
  });

  test('the gateway client of the job has the default time of 10 s: the same late gateway gives the job its JWT-SVID, and each call of the client is bounded by the time that the decision counts for a new one', async () => {
    const world = makeWorld();
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { jobDeps } = await wireService(config, { ...world.options, fetchImpl: lateGateway(world, 700) });
    const deps = jobDeps(T, world.context);
    const target = jwtSvidTarget(deps.calls.bases, 'run1', 'insurer.requests');
    if (!target.ok) throw new Error(target.detail);
    // The client bounds each call with a signal of its own, made with its time. The time of the hook is 500 ms here, and the client of the job has none of it.
    const bounds = vi.spyOn(AbortSignal, 'timeout');
    const svid = await fetchJwtSvid(deps.svid, { did: deps.agent.did, key: deps.agent.authenticationKey }, target.value);
    expect(svid.ok, JSON.stringify(svid)).toBe(true);
    const times = bounds.mock.calls.map(([ms]) => ms);
    expect(times).toContain(GATEWAY_DEFAULT_TIMEOUT_MS);
    expect(times).not.toContain(config.checksBudgetMs);
  });

  test('a ledger that does not answer ends each read of the hook inside the budget of the hook, whatever budget the environment of the ledger carries', async () => {
    const world = makeWorld();
    const hangs = (): Promise<never> => new Promise<never>(() => undefined);
    const provider = new Proxy({}, { get: () => hangs }) as typeof world.ledger.provider;
    const ledgerEnv = { ...world.ledger, provider, fetchImpl: hangs as unknown as typeof fetch, budgetMs: 600_000 };
    const config = loadConfig({ ...world.env, CHECKS_READ_BUDGET_MS: '500' });
    const { precheck } = await wireService(config, { ...world.options, ledgerEnv });
    const answer = await precheck(world.handoff, world.context);
    expect(answer).toMatchObject({ go: false, status: 503, error: 'check_unavailable' });
  });

  test('the cause of a read that failed goes to the log by its kind only: a message that holds an address and a key is never written', async () => {
    const world = makeWorld();
    const cause = new TypeError('fetch failed: https://gateway.example.test/x?key=secret-token-123');
    const failing: typeof fetch = async () => { throw cause; };
    const config = loadConfig(world.env);
    const { precheck } = await wireService(config, { ...world.options, fetchImpl: failing });
    expect(await precheck(world.handoff, world.context)).toMatchObject({ go: false, status: 503 });
    const lines = world.logs.filter((line) => line.startsWith('the hook could not read'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of world.logs) expect(line).not.toContain('secret-token');
    expect(lines[0]).toMatch(/^the hook could not read the identity gateway \(\w+\)$/);
  });
});

describe('the report of the attestations is the real adapter over the ledger', () => {
  const report = async (world: World) => {
    const { jobDeps } = await wired(world);
    return jobDeps(T, world.context).report({ sender: world.sender.did, delegation: DELEGATION_ID, atMs: T });
  };

  test('a type 4 attestation of the root delegator that approved gives valid, and the two Provider kinds are absent when the ledger holds none', async () => {
    expect(await report(makeWorld({ report: ['binding'] }))).toStrictEqual({ provenance: 'absent', software: 'absent', principal_binding: 'valid' });
  });

  test('the three attestations of the sender, each by its issuer, give three valid words; none of them gives three absent words', async () => {
    expect(await report(makeWorld())).toStrictEqual({ provenance: 'valid', software: 'valid', principal_binding: 'valid' });
    expect(await report(makeWorld({ report: [] }))).toStrictEqual({ provenance: 'absent', software: 'absent', principal_binding: 'absent' });
  });

  test('a ledger that cannot be read gives unreadable for the three kinds, never absent, and no line of the log shows the cause', async () => {
    const world = makeWorld();
    const { jobDeps } = await wired(world);
    world.ledgerDown(true);
    expect(await jobDeps(T, world.context).report({ sender: world.sender.did, delegation: DELEGATION_ID, atMs: T })).toStrictEqual({ provenance: 'unreadable', software: 'unreadable', principal_binding: 'unreadable' });
    for (const line of world.logs) expect(line).not.toContain('secret-token');
  });

  test('every read of the report ends inside the read budget of the report, whatever budget the environment of the ledger carries', async () => {
    const world = makeWorld();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    const { jobDeps } = await wireService(loadConfig(world.env), { ...world.options, ledgerEnv: { ...world.ledger, budgetMs: 600_000 } });
    expect(REPORT_READ_BUDGET_MS).toBe(15_000);
    await jobDeps(T, world.context).report({ sender: world.sender.did, delegation: DELEGATION_ID, atMs: T });
    const delays = timers.mock.calls.map(([, ms]) => ms);
    expect(delays).toContain(REPORT_READ_BUDGET_MS);
    expect(delays).not.toContain(600_000);
  });

  test('the whole report has the budget that the job gives it: the two constants are one number', () => {
    expect([JOB_REPORT_BUDGET_MS, REPORT_BUDGET_MS]).toStrictEqual([45_000, 45_000]);
  });
});

describe('the Module-1 port and the dispute settings', () => {
  /** Wires the service with no port given, so that the real port is made over the manifest that the host of `answer` gives. */
  const real = (world: World, answer: Module1Answer = module1ManifestText(), over: Readonly<Record<string, string | undefined>> = {}) =>
    wireService(loadConfig({ ...world.env, ...over }), { ...world.options, fetchImpl: withModule1(world.options.fetchImpl!, answer), module1Port: undefined });

  test('with no port given, the service fetches the manifest of the deployment one time, from the address that the setting names, and makes the real port: no other call is made', async () => {
    const world = makeWorld();
    const urls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      urls.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).href);
      return world.options.fetchImpl!(input, init);
    };
    const result = await wireService(loadConfig(world.env), { ...world.options, fetchImpl: recording, module1Port: undefined });
    expect(typeof result.precheck).toBe('function');
    expect(urls).toStrictEqual([MODULE1_URL]);
  });

  test('a manifest that names another identity registry than the deployment of the service is refused, naming both registries', async () => {
    const world = makeWorld();
    const text = await real(world, module1ManifestText('ab'.repeat(28))).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toMatch(/^the Module-1 manifest names the identity registry (ab){28}, but the identity deployment of this service is [0-9a-f]{56}/);
  });

  test('a manifest that cannot be fetched stops the start, naming the address and the setting', async () => {
    const world = makeWorld();
    const text = await real(world, { status: 404 }).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toBe(`The Module-1 manifest (VECTOR_MODULE1_MANIFEST) ${MODULE1_URL} cannot be fetched: the host answered HTTP 404.`);
  });

  test('a resolution deadline that is not the deadline of the deployment is refused, and the deadline of the deployment is taken', async () => {
    const world = makeWorld();
    const text = await real(world, undefined, { DISPUTE_RESOLUTION_DEADLINE_MS: '30000000' }).then(() => 'accepted', (error: Error) => error.message);
    expect(text).toMatch(/^the dispute settings are refused: .*30000000 ms.*259200000 ms/);
    await expect(real(world, undefined, { DISPUTE_RESOLUTION_DEADLINE_MS: '259200000' })).resolves.toBeDefined();
  });

  test('a message of the wiring shows no key', async () => {
    const world = makeWorld();
    const text = await real(world, { status: 404 }).then(() => 'accepted', (error: Error) => error.message);
    expect(shows(text, SERVICE.privateKeyHex)).toBe(false);
    expect(text.toLowerCase()).not.toContain(rawHexToBech32(SERVICE.privateKeyHex));
    expect(message(() => loadConfig(startEnvWith({ INTAKE_SERVICE_PRIV_KEY_HEX: undefined })))).not.toContain(SERVICE.privateKeyHex);
  });
});
