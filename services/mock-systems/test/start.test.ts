// The start and the stop of the service. `startService` reads the settings, wires the parts and listens last, so a start that is refused opens no port. These tests start the service with a test
// approval check (the option `wire`) on a port that the system gives, and they call it over 127.0.0.1. The stub gateway, the ledger of fixture data and one clock stand behind it, as in the
// other tests. The start with the real wiring of the approval check is in test/wiring.test.ts.
import { once } from 'node:events';
import { connect } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GATEWAY_DEFAULT, KOIOS_DEFAULT, OGMIOS_DEFAULT } from '../src/config.ts';
import { STOP_WAIT_MS, startService } from '../src/start.ts';
import type { StartOptions, Started } from '../src/start.ts';
import { CHILD_PROBE_MS, CHILD_TEST_MS } from './support/child.ts';
import { freePort, listening, send, startChild } from './support/net.ts';
import { purchaseOrder } from './support/scenario.ts';
import { INSURER_ORG, MTLS_BASE, OPERATOR_TOKEN, PUBLIC_BASE, SUPPLIER_ORG, T0, World, resourceOf, serviceEnvironment } from './support/world.ts';

const ORGS = { supplier: SUPPLIER_ORG, insurer: INSURER_ORG };
const ADMIN = { authorization: `Bearer ${OPERATOR_TOKEN}` };

const running: Started[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((started) => started.shutdown()));
});

/**
 * The service on a free port, with the stub gateway, the ledger of fixture data and the clock of the world behind it, and an approval check that passes. The port is free when
 * `freePort` closes it, but another process of a busy host can take it before the service listens: then the start tries a new port, five times at most.
 */
async function start(world: World = new World(), settings: NodeJS.ProcessEnv = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const port = await freePort();
    const lines: string[] = [];
    const options: StartOptions = { fetch: world.gateway.fetch, now: world.now, writeLog: (line) => { lines.push(line); }, ledger: world.ledger, wire: () => async () => ({ ok: true }) };
    try {
      const started = await startService(serviceEnvironment(port, settings), options);
      running.push(started);
      return { world, port, lines, started };
    } catch (error) {
      if (attempt < 5 && (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE') continue;
      throw error;
    }
  }
}

const makeTenant = (port: number, tenant = 'run1') => send(port, { method: 'POST', path: '/admin/tenants', headers: ADMIN, body: { tenant, organisations: ORGS } });

/** A token for `POST /po` of the tenant, and the header fields of one call with it. */
async function poCall(world: World, port: number, number: string, tenant = 'run1', extra: Record<string, string> = {}) {
  const agent = world.agent(`reorder-${number}`);
  const delegation = world.delegate({ delegate: agent, actions: ['po.write'], resources: [resourceOf(tenant, 'po')], remaining: 1 });
  const credential = await world.token(agent, delegation, resourceOf(tenant, 'po'));
  const headers = await world.presented(credential, 'POST', `${PUBLIC_BASE}/t/${tenant}/po`);
  return send(port, { method: 'POST', path: `/t/${tenant}/po`, headers: { ...headers, ...extra }, body: purchaseOrder(tenant, number) });
}

describe('a service that starts', () => {
  it('listens on the port of PORT, answers the check of health, makes a tenant with the operator token, and serves its state', async () => {
    const { port, started, lines } = await start();
    expect(started.port).toBe(port);
    expect(await listening(port)).toBe(true);
    expect((await send(port, { path: '/healthz', host: '127.0.0.1' })).json).toEqual({ ok: true });
    const made = await makeTenant(port);
    expect([made.status, made.json?.created]).toEqual([201, true]);
    const state = await send(port, { path: '/t/run1/state' });
    expect(state.status).toBe(200);
    expect(state.json).toMatchObject({ tenant: 'run1', organisations: ORGS, po_store: { orders: [] } });
    // The one line of the start names the settings that are not secret. The operator token is in no line.
    expect(JSON.parse(lines[0]!)).toEqual({
      event: 'listening', host: '127.0.0.1', port, public_base: PUBLIC_BASE, mtls_base: MTLS_BASE, gateway: GATEWAY_DEFAULT, ledger: { ogmios: OGMIOS_DEFAULT, koios: KOIOS_DEFAULT },
    });
    expect(lines.join('\n')).not.toContain(OPERATOR_TOKEN);
  });

  it('wires its parts: the gateway, the ledger, the clock and the log work for a call with a token, and a call with none is refused', async () => {
    const { world, port, lines } = await start();
    expect((await makeTenant(port)).status).toBe(201);
    const written = await poCall(world, port, 'run1-1');
    expect(written.status, written.text).toBe(201);
    const none = await send(port, { method: 'POST', path: '/t/run1/po', body: purchaseOrder('run1', 'run1-2') });
    expect([none.status, none.json?.error]).toEqual([401, 'token_invalid']);
    const calls = lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.route === 'POST /po');
    expect(calls.map((line) => [line.decision, line.status, line.at])).toEqual([['allowed', 201, new Date(T0).toISOString()], ['refused', 401, new Date(T0).toISOString()]]);
    expect((await send(port, { path: '/t/run1/state' })).json).toMatchObject({ po_store: { orders: [{ po_number: 'run1-1' }] } });
  });
});

describe('a start with a wrong setting', () => {
  const wrong: Array<[name: string, what: string, change: NodeJS.ProcessEnv]> = [
    ['MOCK_PUBLIC_BASE', 'an address that is no https origin', { MOCK_PUBLIC_BASE: 'http://mock.example.test' }],
    ['MOCK_MTLS_BASE', 'the host of the other base', { MOCK_MTLS_BASE: PUBLIC_BASE }],
    ['MOCK_OPERATOR_TOKEN', 'a token that is too short', { MOCK_OPERATOR_TOKEN: 'short-token-of-the-tests' }],
    ['MOCK_OPERATOR_TOKEN', 'a token with a character that is not allowed', { MOCK_OPERATOR_TOKEN: 'a-token-with-a-space in it-0123456789abcdef' }],
    ['MOCK_OPERATOR_TOKEN', 'no token', { MOCK_OPERATOR_TOKEN: undefined }],
    ['IDENTITY_GATEWAY_URL', 'an address with a path', { IDENTITY_GATEWAY_URL: 'https://id.example.test/gateway' }],
    ['VECTOR_IDENTITY_LEGACY_ROOT', 'no value', { VECTOR_IDENTITY_LEGACY_ROOT: undefined }],
    ['VECTOR_IDENTITY_POLICY_ID', 'a policy that the two values do not give', { VECTOR_IDENTITY_POLICY_ID: '00'.repeat(28) }],
    ['HOST', 'the operator token in another setting', { HOST: OPERATOR_TOKEN }],
  ];
  it.each(wrong)('%s, %s: the start rejects, names the variable, never shows the operator token, writes no line and opens no port', async (name, _what, change) => {
    const port = await freePort();
    const settings = serviceEnvironment(port, change);
    const lines: string[] = [];
    const options: StartOptions = { writeLog: (line) => { lines.push(line); }, wire: () => async () => ({ ok: true }) };
    const error = await startService(settings, options).then(() => null, (failure: unknown) => failure as Error);
    expect(error, 'the start was accepted').toBeInstanceOf(Error);
    expect(error!.message).toContain(name);
    if (settings.MOCK_OPERATOR_TOKEN !== undefined) expect(error!.message).not.toContain(settings.MOCK_OPERATOR_TOKEN);
    expect(error!.message).not.toContain(OPERATOR_TOKEN);
    expect(lines).toEqual([]);
    expect(await listening(port)).toBe(false);
  });

  it('the same settings with the fault taken away start, and the port is open', async () => {
    const { port } = await start(new World(), { HOST: '127.0.0.1', MOCK_PUBLIC_BASE: PUBLIC_BASE });
    expect(await listening(port)).toBe(true);
  });
});

describe('the stop', () => {
  it('ends cleanly: the port is closed after it, and a second call is safe', async () => {
    const { port, started } = await start();
    expect((await send(port, { path: '/healthz' })).status).toBe(200);
    const first = started.shutdown();
    const second = started.shutdown();
    await Promise.all([first, second]);
    expect(await listening(port)).toBe(false);
    await started.shutdown();
  });

  it('closes a connection that is idle, so that the stop does not wait for it', async () => {
    const { port, started } = await start();
    // A client that keeps its connection open after the answer, as a proxy does. The service holds such a connection for two minutes.
    const socket = connect({ host: '127.0.0.1', port });
    let answer = '';
    const answered = new Promise<void>((resolve) => {
      socket.setEncoding('utf8').on('data', (text: string) => {
        answer += text;
        if (answer.includes('{"ok":true}')) resolve();
      });
    });
    socket.write('GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await answered;
    const closed = once(socket, 'close');
    const begun = performance.now();
    await started.shutdown();
    await closed;
    expect(performance.now() - begun).toBeLessThan(STOP_WAIT_MS / 2);
  });

  it('lets a call that runs end with its answer, takes no new connection, and ends when that call has ended', async () => {
    const { world, port, started } = await start();
    expect((await makeTenant(port)).status).toBe(201);
    const hold = world.holdLedger();
    const call = poCall(world, port, 'run1-1', 'run1', { connection: 'close' });
    await hold.asked;
    const stopping = started.shutdown();
    expect(await listening(port)).toBe(false);
    hold.release();
    const reply = await call;
    expect(reply.status, reply.text).toBe(201);
    await stopping;
  });
});

describe('the stop on a signal', () => {
  it.each(['SIGTERM', 'SIGINT'] as const)('%s stops the process: it writes the line of the stop, closes the port and exits with 0', async (name) => {
    const { child, port } = await startChild('test/support/serve.ts', serviceEnvironment);
    try {
      // A request is handled after the entry sets its signal handlers.
      const health = await send(port, { path: '/healthz', signal: AbortSignal.timeout(CHILD_PROBE_MS) });
      expect(health.status, child.diagnostics()).toBe(200);
      child.signal(name);
      expect(await child.waitForExit(`exit after ${name}`), child.diagnostics()).toEqual({ code: 0, signal: null });
      expect(child.stdout).toContain(`{"event":"stopping","signal":"${name}"}`);
      expect(await listening(port)).toBe(false);
    } finally {
      await child.cleanup();
    }
  }, CHILD_TEST_MS);
});
