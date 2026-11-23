// agents/order-desk/test/spec.test.ts
// specs/order-desk.md is the public page of the Order Desk, and the manifest links to its Request and Response headings. These tests hold the page to the code, so that the two cannot part: the opening line, the
// status and the changelog to the manifest; the terms of the three adverts to the constants, to the manifest, to the example environment and to the compose file; the claim to the constants of the kit; the gaps
// word for word to the manifest; the third parties and the data handling to the manifest; and the links to files that exist. No test here uses the network.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { CONTEXT_HEADERS, HEARTBEAT_MS, MAX_BODY, RESERVATION_MS, operatorsText, parseWire } from '@vsa/service-kit';
import {
  CONFIRMATION_CHECKS, INVENTORY_CAPABILITIES, LOT_NAMES, ORDER_DESK_CLAIM, PO_SCHEMA, REORDER_CLAIM, lotsFileSha256, parseLotsFile, parseOrderConfirmation, parsePurchaseOrder,
} from '@vsa/usecase-kit/inventory';
import { faultGap } from '@vsa/usecase-kit/manifest';
import {
  COUNTERPARTY_REFUSALS, ERROR_STATUS, FAULT_MODES, HANDOFF_SCHEMA, MAX_REQUEST_BYTES, NO_OPEN_CLAIM, RUNTIME_BODY_LIMIT_BYTES, accepted, canonicalJson, parseHandoff, proposalDigest,
} from '@vsa/usecase-kit/protocol';
import { PASSED_CHECKS_TTL_MS } from '../src/checks/index.ts';
import { AVAILABILITY_DECISION, ORDER_REFUSAL_STATUS, wrongLotOf } from '../src/job/index.ts';
import { CONTROLLER_GAP, GAPS, NOT_SHOWN_GAP, PAGE_GAPS } from '../src/serve/gaps.ts';
import { TEMPLATE_ENV, manifestFromEnv } from '../src/serve/manifest.ts';
import { RequestRefusal, parseOrderRequest } from '../src/serve/server.ts';
import { CALL_TIMEOUT_MS, JOB_DEADLINE_MS, LOTS_ROUTE, MIN_PROCESSING_WINDOW_MS, RUNTIME_PRECHECK_WAIT_MS, faultOf } from '../src/serve/settings.ts';
import { SETTINGS } from '../src/serve/start.ts';
import { makeRig, refusalOf, sentOrder } from './job/rig.ts';
import { CATALOGUE_ENTRY, PURCHASE_ORDER, decisionOf, handoffOf, hashOf } from './job/samples.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const page = readFileSync(new URL('../../../specs/order-desk.md', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (heading: string): string => (page.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
const sub = (heading: string): string => (page.split(`\n### ${heading}\n`)[1] ?? '').split(/\n##+ /)[0];
/** The first row of a table whose first cell is `label`, or the empty text. */
const row = (text: string, label: string): string => text.split('\n').find((line) => line.startsWith(`| ${label} |`)) ?? '';
const printed = (lovelace: number): string => (lovelace / 1_000_000).toFixed(6);
const manifest = manifestFromEnv(TEMPLATE_ENV);

/** The compose file of the pack: three runtimes in front of one service. */
interface ComposeService {
  readonly environment?: Readonly<Record<string, string>>;
}
const compose = parseYaml(readFileSync(`${root}deploy/server/docker-compose.order-desk.yml`, 'utf8')) as { readonly services: Readonly<Record<string, ComposeService>> };
const envExample = readFileSync(`${root}deploy/server/.env.order-desk.example`, 'utf8');
/** The runtimes of the pack, one for each lot, in the order of the lots. */
const runtimes = LOT_NAMES.map((lot) => compose.services[`runtime-${lot.slice('lot-'.length)}`]);

describe('specs/order-desk.md: the frame', () => {
  test("the opening line, the status line and the changelog are the manifest's, and the page says that the agent has no record", () => {
    expect(manifest.name).toBe('Order Desk');
    expect(page.split('\n')[0]).toBe(`# ${manifest.name}`);
    expect(page.split('\n')[2]).toBe(`Capability \`${manifest.capability_id}\`. ${manifest.description}`);
    expect(manifest.capability_id).toBe(INVENTORY_CAPABILITIES.order);
    expect(section('Capability id').split('\n')[1]).toBe(`\`${manifest.capability_id}\``);
    // The status line of the page opens with the word that the manifest carries and ends with its date.
    expect(manifest.status).toStrictEqual({ chip: 'proposed', since: '2026-11-23' });
    const status = `${manifest.status.chip.toUpperCase()} (built, not deployed). Since ${manifest.status.since}.`;
    expect(section('Status').split('\n')).toContain(status);
    expect(section('Status')).toContain('Nothing on this page is LIVE or DEPLOYED.');
    expect(section('Identity')).toContain('\nThis agent has no registry record yet.\n');
    expect(section('Changelog').trim()).toBe(`- ${manifest.version}, ${manifest.status.since}: built`);
    expect(manifest.version).toBe('0.1.0');
  });

  test('the Identity table says what the manifest says of the keys: a controller key of this deployment, three public supplier keys and one service key', () => {
    const identity = section('Identity');
    expect(row(identity, 'DID')).toBe('| DID | assigned at registration |');
    expect(row(identity, 'Controller')).toBe('| Controller | a controller key of this deployment |');
    const organisation = row(identity, 'Organisation');
    expect(organisation.includes('`alfa.vector.apexfusion.org`')).toBe(true);
    expect(organisation.includes('"Demonstration organisation run by the Apex Fusion Foundation"')).toBe(true);
    // The service holds one private key, the service key. It holds the key hash and the public key of each runtime, and the manifest publishes them for each tier.
    expect(SETTINGS.filter((name) => name.endsWith('_PRIV_KEY_HEX'))).toStrictEqual(['ORDER_DESK_SERVICE_PRIV_KEY_HEX']);
    expect(Object.keys(manifest.keys)).toStrictEqual(['service_pkh']);
    for (const tier of manifest.terms.tiers) expect(Object.keys(tier)).toEqual(expect.arrayContaining(['supplier_pkh', 'pub_key_hex']));
    expect(manifest.identity.supplier_key).toBe('<AGENT_DID>#<SMALL_SUPPLIER_PKH>');
    const suppliers = row(identity, 'Supplier keys');
    expect(suppliers).toContain('three, one for each runtime');
    expect(suppliers).toContain('The manifest gives the key hash and the public key of each runtime in `terms.tiers`');
    expect(suppliers).toContain('`identity.supplier_key` names the key of the small runtime as a key of the DID (`<DID>#<key hash>`)');
    const service = row(identity, 'Service key');
    expect(service).toContain('one key, held by the service and by no runtime');
    expect(service).toContain('It pays for the model hire of each decision, signs the transactions of the dispute code and signs the request for the X.509-SVID');
    expect(service).toContain('The manifest publishes its key hash as `keys.service_pkh`');
    expect(service).toContain('The service holds the key hashes and the public keys of the three runtimes, and no private supplier key');
    expect(row(identity, 'Parties')).toBe('| Parties | Accountable: the Accountable key of the organisation. Responsible: Module-1. Provider: the Provider key. Guardians: two, with a threshold of 2 |');
  });

  test('the Capability id names the three adverts by their lot, and the pack runs the three runtimes in front of the one service', () => {
    const capability = section('Capability id');
    for (const lot of LOT_NAMES) expect(row(capability, `\`${lot}\``), lot).toBe(`| \`${lot}\` | ${lot.slice('lot-'.length)} | set in the lots file, for each SKU |`);
    expect(capability).toContain('The `model` string of an advert and of every receipt that it gives is the name of the lot.');
    expect(manifest.terms.tiers.map((tier) => tier.model)).toStrictEqual([...LOT_NAMES]);
    // The pack: four containers, and each runtime is a template runtime of the kind custom that asks the one service before it claims.
    expect(Object.keys(compose.services)).toStrictEqual(['runtime-small', 'runtime-medium', 'runtime-large', 'service']);
    for (const runtime of runtimes) {
      expect(runtime.environment?.CAPABILITY_KIND).toBe('custom');
      expect(runtime.environment?.SERVICE_URL).toBe(runtimes[0].environment?.SERVICE_URL);
      expect(runtime.environment?.SERVICE_PRECHECK_URL).toBe(`${runtime.environment?.SERVICE_URL}precheck`);
    }
    expect(capability).toContain('The agent is three runtimes in front of one service. Each runtime is the template runtime (`vector-agent-template`, `CAPABILITY_KIND=custom`).');
    expect(capability).toContain('It asks the service before it claims an escrow, claims the escrow, posts the job to the service, signs the receipt and submits the receipt hash.');
    expect(capability).toContain('It holds the service key and no private supplier key.');
    expect(capability).toContain('The three runtimes share the service, its manifest and its one job slot, so one job runs at a time.');
    expect(readme).toContain('One job runs at a time.');
  });
});

describe('specs/order-desk.md: the Terms', () => {
  const terms = section('Terms');
  const tiers = manifest.terms.tiers;
  const lock = (tier: (typeof tiers)[number]): number => tier.price_lovelace + tier.supplier_bond_lovelace + tier.buyer_bond_lovelace;

  test('three groups, one for each advert, each with its price, both bonds and lock from the manifest, and nine rows in all of price and bonds in the order Price, Supplier bond, Buyer bond', () => {
    expect(tiers.map((tier) => tier.model)).toStrictEqual([...LOT_NAMES]);
    // The nine rows that the rule of the page profile counts, as they stand on the page.
    const shown = [...terms.matchAll(/^\| (Price|Supplier bond|Buyer bond) \| (\d+) \| (\d+\.\d{6}) \|$/gm)].map((hit) => hit[0]);
    const wanted = tiers.flatMap((tier) => [['Price', tier.price_lovelace], ['Supplier bond', tier.supplier_bond_lovelace], ['Buyer bond', tier.buyer_bond_lovelace]].map(([label, lovelace]) => `| ${label} | ${lovelace} | ${printed(Number(lovelace))} |`));
    expect(shown).toHaveLength(9);
    expect(shown).toStrictEqual(wanted);
    // Each group stands under the bold line of its advert, and holds its own three rows and its lock.
    const marks = LOT_NAMES.map((lot) => terms.indexOf(`\n**Advert \`${lot}\`**\n`));
    expect(marks.every((at) => at >= 0)).toBe(true);
    expect([...marks].sort((a, b) => a - b)).toStrictEqual(marks);
    tiers.forEach((tier, at) => {
      const group = terms.slice(marks[at], marks[at + 1] ?? terms.length);
      expect(group.split('\n').filter((line) => /^\| (Price|Supplier bond|Buyer bond) \|/.test(line)), tier.model).toStrictEqual(wanted.slice(3 * at, 3 * at + 3));
      expect(row(group, 'Locked by the buyer (price and both bonds)'), tier.model).toBe(`| Locked by the buyer (price and both bonds) | ${lock(tier)} | ${printed(lock(tier))} |`);
    });
    expect(tiers.map(lock)).toStrictEqual([4_000_000, 7_000_000, 12_000_000]);
    expect(terms).toContain('Amounts are `lovelace` fields. The last column is the same amount divided by 1,000,000, with six decimals.');
  });

  test('the window, the timeout of the runtimes and the deadline of the job are the constants, the manifest, the example environment and the compose file', () => {
    expect(tiers.every((tier) => tier.max_processing_ms === MIN_PROCESSING_WINDOW_MS)).toBe(true);
    expect(envExample.split('\n')).toContain(`ADVERT_MAX_PROCESSING_MS=${MIN_PROCESSING_WINDOW_MS}`);
    const timeout = JOB_DEADLINE_MS + 60_000;
    for (const runtime of runtimes) {
      expect(runtime.environment?.ADVERT_MAX_PROCESSING_MS).toBe(String(MIN_PROCESSING_WINDOW_MS));
      expect(runtime.environment?.SERVICE_TIMEOUT_MS).toBe(String(timeout));
    }
    expect(row(terms, 'Processing window, advert `max_processing_ms`')).toBe(`| Processing window, advert \`max_processing_ms\` | ${MIN_PROCESSING_WINDOW_MS} ms, for each of the three adverts |`);
    expect(row(terms, 'Service timeout, `SERVICE_TIMEOUT_MS` of each runtime')).toBe(`| Service timeout, \`SERVICE_TIMEOUT_MS\` of each runtime | ${timeout} ms |`);
    expect(row(terms, 'Job deadline, set by the service when a request arrives')).toBe(`| Job deadline, set by the service when a request arrives | ${JOB_DEADLINE_MS} ms |`);
    expect([MIN_PROCESSING_WINDOW_MS, timeout, JOB_DEADLINE_MS]).toStrictEqual([480_000, 360_000, 300_000]);
    // The one model call of a job is the decision availability.
    expect(AVAILABILITY_DECISION.name).toBe('availability');
    expect(row(terms, 'Model calls')).toBe('| Model calls | one for each job: the decision `availability` |');
  });

  test('the request limit is 900000 bytes of wire payload, and the page says that it is safe only below the limit of the runtime on the escaped body', () => {
    expect(manifest.terms.input_limits.request_bytes).toBe(MAX_REQUEST_BYTES);
    expect(row(terms, 'Request')).toBe(`| Request | at most ${MAX_REQUEST_BYTES} bytes of wire payload |`);
    expect(MAX_REQUEST_BYTES).toBeLessThan(MAX_BODY);
    expect(MAX_BODY).toBeLessThan(RUNTIME_BODY_LIMIT_BYTES);
    expect(RUNTIME_BODY_LIMIT_BYTES).toBe(1_048_576);
    expect(ERROR_STATUS.request_too_large).toBe(400);
    expect(terms).toContain('The limit on a request counts the wire payload: the request JSON written as a string inside a one-message array. It does not count the body of the call that a buyer makes to a runtime.');
    expect(terms).toContain('The buyer puts the wire payload inside a second JSON object, and each quote mark and each backslash of the wire payload then gets one more byte.');
    expect(terms).toContain(`The runtime refuses a body above ${RUNTIME_BODY_LIMIT_BYTES} bytes (1 MiB).`);
    expect(terms).toContain(`So the limit of ${MAX_REQUEST_BYTES} bytes is safe only below the limit of the runtime, on the escaped body, and a buyer must keep the body of its call at or below ${RUNTIME_BODY_LIMIT_BYTES} bytes.`);
    expect(terms).toContain(`The service reads at most ${MAX_BODY} bytes of wire payload and refuses more with \`request_too_large\` (400).`);
  });

  test('the economics: the supplier receives the price and its bond on Accept, the buyer bond returns, and a job that fails is not paid', () => {
    expect(terms).toContain("Economics: on Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer.");
    expect(terms).toContain('A job that the hook refuses, and a job that fails after the Claim, are not paid: the buyer reclaims the escrow after `deliver_by`.');
    expect(terms).toContain('The price stands for the size of the order on the ledger.');
    expect(readme).toContain('The price stands for the size of the order on the ledger. It is not the value of the goods.');
  });
});

describe('specs/order-desk.md: the claim, the fault switch and the gaps', () => {
  test('the claim statements are the constants of the kit, and the manifest holds the same three texts', () => {
    const table = section('Claim statements').split('\n').filter((line) => /^\| S[123] \|/.test(line));
    expect(table).toStrictEqual(ORDER_DESK_CLAIM.statements.map((statement) => `| ${statement.id} | ${statement.text} |`));
    expect(manifest.behaviour.claim.statements).toStrictEqual(ORDER_DESK_CLAIM.statements);
    expect(ORDER_DESK_CLAIM.statements.map((statement) => statement.id)).toStrictEqual(['S1', 'S2', 'S3']);
    expect(section('Claim statements')).toContain('The Order Desk stakes a Module-1 claim for each run. The claim has three statements. The manifest holds the same three texts in `behaviour.claim`.');
  });

  test('the Fault switch names the one value of the kit, the wrong lot of the job, and the field that every result carries', () => {
    const fault = section('Fault switch');
    expect(FAULT_MODES['order-desk']).toStrictEqual(['confirm_wrong_lot']);
    expect(manifest.behaviour.fault_modes).toStrictEqual(['confirm_wrong_lot']);
    expect(fault).toContain('`FAULT_MODE=confirm_wrong_lot`: the confirmation names another lot and quantity than the purchase order, and the order that the service places has that wrong lot.');
    // The wrong lot of the page is the wrong lot of the job.
    expect([wrongLotOf('lot-small'), wrongLotOf('lot-medium'), wrongLotOf('lot-large')]).toStrictEqual(['lot-medium', 'lot-small', 'lot-small']);
    expect(fault).toContain('The wrong lot of `lot-small` is `lot-medium`. The wrong lot of any other lot is `lot-small`. The quantity is the size of the wrong lot for the SKU in the lots file.');
    // The switch is empty in a clean run, it takes the one value of the kit, and any other value stops the start.
    expect(faultOf({ FAULT_MODE: '' }).mode).toBe('');
    expect(faultOf({ FAULT_MODE: 'confirm_wrong_lot' }).mode).toBe('confirm_wrong_lot');
    expect(() => faultOf({ FAULT_MODE: 'alter_after_approval' })).toThrow(/FAULT_MODE/);
    expect(fault).toContain('The switch is empty in a clean run. Any other value stops the start of the service.');
    expect(fault).toContain('It is declared in the manifest, in `behaviour.fault_modes`, and the manifest is the same for every value.');
    expect(fault).toContain('Each result returns the active value as `fault_mode`, its last member.');
    expect(fault).toContain('The switch changes what the job sends and never a check: the hook does not know that it exists.');
  });

  test('every gap of the manifest is on the page word for word, one to a line and in its order, and the page adds none', () => {
    const lines = section('Known gaps').split('\n').filter((line) => line.startsWith('- '));
    expect(lines).toStrictEqual(GAPS.map((gap) => `- ${gap}`));
    expect(manifest.gaps).toStrictEqual([...GAPS]);
    expect(lines).toHaveLength(9);
    // The six gaps of the page, the keys of the parties, what no run shows, and the one sentence of the kit about the fault switch.
    expect(lines.slice(0, 6)).toStrictEqual(PAGE_GAPS.map((gap) => `- ${gap}`));
    expect(lines[6]).toBe(`- ${CONTROLLER_GAP}`);
    expect(lines[7]).toBe(`- ${NOT_SHOWN_GAP}`);
    expect(lines[8]).toBe(`- ${faultGap('order-desk')}`);
    // The keys: the controller key, the Accountable key and the guardian keys are on one host of one operator.
    expect(lines[6]).toBe('- The controller key of this deployment, the Accountable key and the guardian keys are on one host of one operator, so a party is independent of the controller by key only.');
    // What no run shows: one run-in lead, and the three items, among them the reclaim of an escrow in use case 1.
    expect(page.split('What this does not show:').length - 1).toBe(1);
    expect(lines[7].startsWith('- What this does not show: ')).toBe(true);
    for (const item of ['the refund of the escrow of a revoked agent', 'the reclaim of an escrow in use case 1', 'a relying party that refuses a live token after its authority ends']) expect(lines[7], item).toContain(item);
    expect(section('Known gaps')).toContain('The manifest states these nine, in this order, word for word.');
  });
});

describe('specs/order-desk.md: the receipt, the operator, how to hire it and the links', () => {
  test('the receipt: the runtime signs it, and its model is the lot of the advert', () => {
    const receipt = section('What the receipt commits to');
    expect(receipt).toContain('The service signs no receipt. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.');
    expect(row(receipt, '`escrow_ref`')).toBe('| `escrow_ref` | the escrow UTxO, `<txid>#<index>` |');
    expect(row(receipt, '`supplier_pkh`')).toBe('| `supplier_pkh` | the key hash of the supplier key of the runtime that took the job: one of the three |');
    expect(row(receipt, '`prompt_hash`')).toBe('| `prompt_hash` | sha256 of the UTF-8 bytes of the wire payload, as the buyer committed it in the escrow datum |');
    expect(row(receipt, '`response_hash`')).toBe('| `response_hash` | sha256 of the UTF-8 bytes of the confirmation exactly as the service returned them |');
    // The model of a receipt is the model of its advert, and the model of each advert is its lot.
    expect(row(receipt, '`model`')).toBe(`| \`model\` | the lot of the advert: ${LOT_NAMES.slice(0, -1).map((lot) => `\`${lot}\``).join(', ')} or \`${LOT_NAMES.at(-1)}\` |`);
    expect(manifest.terms.tiers.map((tier) => tier.model)).toStrictEqual([...LOT_NAMES]);
    expect(row(receipt, '`prompt_tokens`, `completion_tokens`')).toBe('| `prompt_tokens`, `completion_tokens` | 0 and 0, the runtime counts none. The token counts of the model hire are in the sub-receipt under `decisions[0].inference.sub_job` |');
    expect(row(receipt, '`wallclock_ms`')).toBe('| `wallclock_ms` | how long the service call took |');
    expect(receipt).toContain(`the ${CONFIRMATION_CHECKS.length} checks, and the availability decision with its reasoning and the sub-receipt of the model supplier.`);
    expect(receipt).toContain('It does not commit to any goods being shipped: there are no goods.');
    expect(receipt).toContain('The signature is Ed25519 over the canonical JSON of the receipt. The sha256 of the canonical JSON of `{ receipt, signature }` is the `result_receipt_hash` in the Submitted escrow datum.');
  });

  test('the third parties and the data handling are the manifest\'s, word for word', () => {
    const operator = section('Operator and data handling');
    expect(manifest.operator.name).toBe('Apex Fusion Foundation');
    expect(operator).toContain('Operator: Apex Fusion Foundation. The contact is `operator.contact` in the manifest.');
    const parties = operator.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Party |')).map((line) => line.split(' | ')[0].slice(2));
    expect(parties).toStrictEqual(manifest.behaviour.third_parties);
    expect(parties).toHaveLength(5);
    expect(operator).toContain(manifest.behaviour.data_handling);
    expect(operator).toContain('All the data is synthetic. What leaves to third parties:');
  });

  test('How to hire it sends the reader to the Reorder Agent, and the Links name files that exist', () => {
    const how = section('How to hire it');
    expect(how).toContain('A buyer\'s agent hires the Order Desk from the vault of a delegation, with an approved purchase order.');
    expect(how).toContain('To see the Order Desk work, hire the [Reorder Agent](reorder-agent.md).');
    expect(how).toContain('No advert exists yet, so no buyer can hire the Order Desk today.');
    const links = section('Links');
    for (const [, target] of links.matchAll(/\]\(\.\.\/([^)]+)\)/g)) expect(existsSync(root + target), target).toBe(true);
    for (const [, label, target] of links.matchAll(/\[([^\]]+)\]\(\.\.\/([^)]+)\)/g)) expect(label, target).toBe(target);
    expect([...links.matchAll(/\]\(\.\.\/([^)]+)\)/g)].map((hit) => hit[1])).toStrictEqual(['agents/order-desk/agent.json.template', 'agents/order-desk/lots.json', 'agents/order-desk', 'deploy/server/RUNBOOK-order-desk.md']);
    expect(links).toContain('[Reorder Agent](reorder-agent.md)');
    expect(manifest.links.source.endsWith('/agents/order-desk')).toBe(true);
    expect(manifest.links.spec.endsWith('/specs/order-desk.md')).toBe(true);
  });
});

describe('specs/order-desk.md: the routes of the Interface', () => {
  test('the Interface names the routes of the service and the token that two of them need, and the buyer reaches the service through a runtime only', () => {
    const interfaceText = section('Interface');
    expect(LOTS_ROUTE).toBe('/lots.json');
    expect(manifest.interface.routes).toStrictEqual({ job: '/v1/job', status: '/status', capability: '/capability', lots: LOTS_ROUTE });
    for (const route of ['`POST /precheck`', '`POST /`', '`GET /lots.json`', '`GET /agent.json`', '`GET /healthz`']) expect(row(interfaceText, route), route).not.toBe('');
    expect(interfaceText).toContain('`POST /` and `POST /precheck` need the token that only the runtimes hold. A call without it gets 401 `{"error":"unauthorized"}`, before the body is read.');
    expect(interfaceText).toContain('`GET /lots.json`, `GET /agent.json` and `GET /healthz` need no token. Any other route gets 404 `{"error":"not_found"}`.');
    expect(interfaceText).toContain('A buyer sends its job to the runtime of its advert, on the runtime route `/v1/job` of the manifest, and never to the service.');
    expect(ERROR_STATUS.unauthorized).toBe(401);
    expect(readme).toContain('Without it, 401 `{"error":"unauthorized"}`');
    expect(readme).toContain('| any other route | 404 `{"error":"not_found"}` |');
  });
});

describe('specs/order-desk.md: the request', () => {
  const request = sub('Request');
  const rows = request.split('\n').filter((line) => /^\| `/.test(line));

  test('the wire payload and the request JSON are the two names of the wire message that the service reads', () => {
    const interfaceText = section('Interface');
    expect(interfaceText).toContain("The **request JSON** is what the buyer's agent writes: the handoff under Request below.");
    expect(interfaceText).toContain('The **wire payload** is the request JSON written as a string inside a one-message array: `[{"content": "<request JSON as a string>", "role": "user"}]`.');
    expect(interfaceText).toContain("The buyer's agent commits to the wire payload in the escrow, and a runtime posts it to the service as the body of `POST /` and of `POST /precheck`.");
    // The service reads exactly this array and gives back the request JSON as a string. It refuses any other body.
    expect(parseWire(JSON.stringify([{ content: 'request JSON', role: 'user' }]))).toBe('request JSON');
    expect(() => parseWire(JSON.stringify({ content: 'request JSON', role: 'user' }))).toThrow(/one-element message array/);
    expect(() => parseWire(JSON.stringify([{ content: 'request JSON', role: 'assistant' }]))).toThrow(/role must be/);
  });

  test('the example is the handoff of the sample of the job, and the service takes it', () => {
    const shown = /```json\n([\s\S]*?)\n```/.exec(request)?.[1] ?? '';
    expect(shown).toBe(JSON.stringify(handoffOf(), null, 2));
    expect(parseOrderRequest(shown)).toStrictEqual(handoffOf());
    expect(parseWire(JSON.stringify([{ content: shown, role: 'user' }]))).toBe(shown);
    expect(request).toContain('The request JSON is the handoff of use case 1 (inventory reorder). It has the members of the first table, in this order, and no other.');
    expect(request).toContain('Its `document` is a purchase order, which has the members of the second table, in this order, and no other.');
    expect(request).toContain('A request that breaks a rule is refused with `bad_shape` (400), before any check.');
    expect(() => parseOrderRequest('{}')).toThrow(RequestRefusal);
    expect(new RequestRefusal('bad_shape', 'x').status).toBe(400);
    expect(ERROR_STATUS.bad_shape).toBe(400);
  });

  test('the members of the handoff and of the purchase order are the members of the parsers of the kit, in their order, and the page states the rules of the parsers', () => {
    expect(rows).toHaveLength(17);
    const names = rows.map((line) => /^\| `([a-z0-9_]+)` \|/.exec(line)?.[1] ?? '');
    expect(names.slice(0, 7)).toStrictEqual(Object.keys(handoffOf()));
    expect(names.slice(7)).toStrictEqual(Object.keys(handoffOf().document));
    expect(rows.slice(0, 7)).toStrictEqual([
      `| \`schema\` | \`${HANDOFF_SCHEMA}\` |`,
      '| `use_case` | `inventory-reorder`. The Order Desk takes the handoff of use case 1 (inventory reorder) only |',
      '| `sender_did` | the DID of the agent of the buyer: `did:vector:` and 64 hex characters |',
      '| `delegation` | the identifier of the delegation that paid for the order: 64 hex characters |',
      '| `document` | the purchase order, with the members of the second table |',
      '| `salt` | 64 hex characters, which are 32 bytes. The digest that the buyer approved is the SHA-256 of these 32 bytes followed by the canonical text of the purchase order |',
      '| `approval` | `{ "attestation": "<64 hex characters>", "issuer_did": "did:vector:<64 hex characters>" }`: the approval of the buyer for this exact purchase order. It can be `null`, and the hook then refuses with `approval_not_found` |',
    ]);
    expect(rows.slice(7)).toStrictEqual([
      `| \`schema\` | \`${PO_SCHEMA}\` |`,
      '| `po_number` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit. A number counts without regard to case |',
      '| `tenant` | 1 to 48 characters: lower-case letters, digits and hyphens, starting with a letter or a digit |',
      '| `sku` | 1 to 64 characters: letters, digits, dots, hyphens and underscores, starting with a letter or a digit |',
      `| \`lot\` | ${LOT_NAMES.slice(0, -1).map((lot) => `\`${lot}\``).join(', ')} or \`${LOT_NAMES.at(-1)}\` |`,
      '| `quantity` | a whole number from 1 to 1000000 |',
      '| `needed_by` | a date that exists, as `YYYY-MM-DD` |',
      '| `supplier_did` | the DID of the supplier: `did:vector:` and 64 hex characters |',
      '| `advert_ref` | `<transaction hash>#<output index>`: 64 hex characters, `#`, and an index of at most 6 digits |',
      '| `stock_reading_sha256` | 64 hex characters: the digest of the stock reading that the buyer\'s agent read |',
    ]);
    // The use case, the shape and the approval of the handoff.
    expect(() => parseOrderRequest(JSON.stringify({ ...handoffOf(), use_case: 'prior-authorization' }))).toThrow(RequestRefusal);
    expect(parseHandoff(JSON.parse(JSON.stringify({ ...handoffOf(), approval: null }))).ok).toBe(true);
    // The digest that the buyer approved: the salt comes first, as 32 bytes.
    const canonical = canonicalJson(handoffOf().document);
    const digest = createHash('sha256').update(Buffer.from('9a'.repeat(32), 'hex')).update(canonical.ok ? canonical.value : '', 'utf8').digest('hex');
    expect(proposalDigest('9a'.repeat(32), handoffOf().document)).toStrictEqual({ ok: true, value: digest });
    // The rules of the purchase order are the rules of its parser.
    const accepts = (over: Record<string, unknown>): boolean => parsePurchaseOrder({ ...PURCHASE_ORDER, ...over }).ok;
    expect([accepts({}), accepts({ po_number: 'a'.repeat(64) }), accepts({ po_number: 'a'.repeat(65) }), accepts({ po_number: '-a' }), accepts({ po_number: 'a b' })]).toStrictEqual([true, true, false, false, false]);
    expect([accepts({ tenant: 'a'.repeat(48) }), accepts({ tenant: 'a'.repeat(49) }), accepts({ tenant: 'Run1' })]).toStrictEqual([true, false, false]);
    expect([accepts({ sku: 'a'.repeat(64) }), accepts({ sku: 'a'.repeat(65) })]).toStrictEqual([true, false]);
    expect([accepts({ quantity: 1 }), accepts({ quantity: 1_000_000 }), accepts({ quantity: 0 }), accepts({ quantity: 1_000_001 }), accepts({ quantity: 1.5 })]).toStrictEqual([true, true, false, false, false]);
    expect([accepts({ needed_by: '2026-12-31' }), accepts({ needed_by: '2026-02-30' })]).toStrictEqual([true, false]);
    expect([accepts({ advert_ref: `${'d4'.repeat(32)}#123456` }), accepts({ advert_ref: `${'d4'.repeat(32)}#1234567` })]).toStrictEqual([true, false]);
    expect([...LOT_NAMES.map((lot) => accepts({ lot })), accepts({ lot: 'lot-huge' })]).toStrictEqual([true, true, true, false]);
  });
});

describe('specs/order-desk.md: what the hook checks before the Claim', () => {
  const hook = sub('What it checks before the Claim');
  const checks = hook.split('\n').filter((line) => /^\| \d+ \|/.test(line)).map((line) => line.slice(2, -2).split(' | '));
  /** The refusal codes of one row of the table, in the order of the row. */
  const codesOf = (cells: string[]): string[] => [...cells[2].matchAll(/`([a-z_]+)`/g)].map((hit) => hit[1]);

  test('the 16 checks are the checks of the confirmation in their order, with the 18 refusal codes of the kit that come before the Claim in their order, each with its status', () => {
    expect(checks).toHaveLength(CONFIRMATION_CHECKS.length);
    expect(checks.map((cells) => Number(cells[0]))).toStrictEqual(CONFIRMATION_CHECKS.map((_, at) => at + 1));
    expect(checks.map((cells) => cells[1])).toStrictEqual(CONFIRMATION_CHECKS.map((name) => `\`${name}\``));
    const before = COUNTERPARTY_REFUSALS['order-desk'].filter((code) => code !== 'cannot_supply');
    expect(checks.flatMap(codesOf)).toStrictEqual(before);
    expect(before).toHaveLength(18);
    // Every code of a row has the status of that row, and the status is the one of the protocol.
    for (const cells of checks) for (const code of codesOf(cells)) expect(cells[3], code).toBe(String(ERROR_STATUS[code as keyof typeof ERROR_STATUS]));
    expect(checks.every((cells) => cells[3] === '403')).toBe(true);
    // The last four checks are the checks of the Order Desk, in the words of its README.
    const own = (readme.split('\n## The checks\n')[1] ?? '').split('\n## ')[0].split('\n').filter((line) => /^\| `/.test(line)).map((line) => line.slice(2, -2).split(' | '));
    expect(own).toHaveLength(4);
    expect(checks.slice(-4).map((cells) => [cells[1], cells[2], cells[4]])).toStrictEqual(own);
    expect(hook).toContain('The hook makes 16 checks, one after the other, in the order of the table.');
    expect(hook).toContain('The first check that fails ends the hook. Its answer is the refusal code of that check, with the status 403.');
    expect(hook).toContain('A refusal comes before the Claim: the escrow stays open, nothing is claimed, nothing is paid, and the buyer reclaims the escrow after `deliver_by`.');
  });

  test('a go keeps the record for 300 s and reserves the job slot for 120 s, the hook answers 503 for a source that it cannot read, and the runtime waits 10000 ms', () => {
    expect(hook).toContain(`When every check passes, the hook answers 200 \`{"go":true,"reserved_ms":${RESERVATION_MS}}\`.`);
    expect(hook).toContain(`The service keeps the record of the checks for ${PASSED_CHECKS_TTL_MS / 1000} s, and it reserves the job slot for that escrow for ${RESERVATION_MS / 1000} s.`);
    expect([RESERVATION_MS, PASSED_CHECKS_TTL_MS]).toStrictEqual([120_000, 300_000]);
    expect(hook).toContain('A source that the hook cannot read (the identity gateway, the ledger or the order book) is never a pass: the hook answers 503 `check_unavailable`.');
    expect(ERROR_STATUS.check_unavailable).toBe(503);
    expect(hook).toContain(`The runtime waits ${RUNTIME_PRECHECK_WAIT_MS} ms for the hook, and reads silence as a refusal.`);
    expect(readme).toContain('the hook keeps the record of the checks for 300 s and reserves the job slot for that escrow for 120 s');
    expect(readme).toContain('The runtime waits 10000 ms for the hook, and reads silence as a refusal.');
  });

  test('the six headers of the context carry the key of the escrow, the advert and the lot, and the body never does', () => {
    const headers = Object.values(CONTEXT_HEADERS);
    expect(headers).toHaveLength(6);
    const named = `${headers.slice(0, -1).map((name) => `\`${name}\``).join(', ')} and \`${headers.at(-1)}\``;
    expect(hook).toContain(`The runtime sends six headers of context with each call: ${named}.`);
    expect(hook).toContain('The hook needs all six, and a call with none, with some, or with a bad one gets 400 `bad_context`.');
    expect(hook).toContain('The key of the escrow, the advert and the lot come from these headers and never from the body: the checks `sender_key`, `delegation`, `lot` and `quantity` read them there.');
    expect(readme).toContain('a call with none, with some, or with a bad one gets 400 `bad_context`');
    expect(new RequestRefusal('bad_context', 'x').status).toBe(400);
  });

  test('a refusal for approval_digest_mismatch is answered first, and the service then files a challenge that names S1 of the claim of the Reorder Agent, with no reference in the message', () => {
    const precheck = readFileSync(new URL('../src/checks/precheck.ts', import.meta.url), 'utf8');
    expect(precheck).toContain("if (refusal.code !== 'approval_digest_mismatch') return;");
    expect(precheck).toContain('statement_text: REORDER_CLAIM.statements[0].text,');
    expect(REORDER_CLAIM.statements[0].id).toBe('S1');
    expect(NO_OPEN_CLAIM).toBe('no_open_claim');
    expect(hook).toContain('When the check `approval_digest` fails, the approval is for another purchase order than the one in the handoff. The hook refuses first, with `approval_digest_mismatch`.');
    expect(hook).toContain('Then the service starts a challenge in the background, against the open claim of the sender: it publishes an evidence document and opens the challenge on the ledger.');
    expect(hook).toContain(`The challenge names the statement S1 of the claim of the Reorder Agent: "${REORDER_CLAIM.statements[0].text}"`);
    expect(hook).toContain(`The answer of the hook never waits for the challenge and never holds a reference to it, because a challenge takes two transactions and the runtime waits only ${RUNTIME_PRECHECK_WAIT_MS} ms.`);
    expect(hook).toContain('The reference of the challenge goes to the log of the service and to the journal of its dispute code, never to the message of the refusal.');
    expect(hook).toContain('A challenge needs an open claim of the sender: when there is none, the service files nothing, and its log names the code `no_open_claim`.');
    expect(readme).toContain('The answer to the runtime never waits for the challenge and never holds a reference to it.');
  });
});

describe('specs/order-desk.md: what the job does, the response and the lots file', () => {
  const does = sub('What it does');
  const steps = does.split('\n').filter((line) => /^\d\. /.test(line));

  test('the job takes its six steps in the order of the page, with the calls to the portal that the manifest names, and it places one order of six members', async () => {
    const rig = makeRig();
    await rig.run();
    expect(rig.events).toStrictEqual(['take', 'svid', 'catalogue', 'decide', 'order', 'book']);
    const phrases = ['takes the record of the checks', 'X.509-SVID', 'supplier/catalogue/{sku}', 'Decision `availability`', 'supplier/orders', 'writes the order book'];
    expect(steps).toHaveLength(phrases.length);
    phrases.forEach((phrase, at) => expect(steps[at], phrase).toContain(phrase));
    const [catalogue, orders] = manifest.behaviour.relying_on.mock_systems;
    expect(steps[2]).toContain(`\`${catalogue}\``);
    expect(steps[4]).toContain(`\`${orders}\``);
    expect(rig.portal.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toStrictEqual(['GET /t/run1/supplier/catalogue/GLV-NIT-M', 'POST /t/run1/supplier/orders']);
    expect(Object.keys(sentOrder(rig.portal))).toStrictEqual(['po_number', 'po_sha256', 'sku', 'lot', 'quantity', 'ship_by']);
    expect(steps[4]).toContain('The order has the purchase order number, the hash of the purchase order, the SKU, the lot, the quantity and the ship-by date.');
    expect(rig.decideInputs).toStrictEqual([{ purchase_order: PURCHASE_ORDER, catalogue_entry: CATALOGUE_ENTRY }]);
    expect(steps[3]).toContain('The model gets a fixed instruction, the purchase order and the catalogue entry, and it answers `{ "confirm": true | false, "ship_by": "<date>", "note": "..." }`.');
    expect(AVAILABILITY_DECISION.parse({ confirm: true, ship_by: '2026-11-28', note: 'It is in stock.' }).ok).toBe(true);
    expect(AVAILABILITY_DECISION.parse({ confirm: 'yes', ship_by: '2026-11-28', note: 'It is in stock.' }).ok).toBe(false);
    expect(rig.portal.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(does).toContain(`The job has a deadline of ${JOB_DEADLINE_MS} ms after its request arrives, and it runs these steps in this order. A failure ends the job with an error, and no later step runs.`);
    expect(steps[0]).toContain('A job with no record, or with the record of another body, fails with `precheck_missing` and places no order.');
    expect(ORDER_REFUSAL_STATUS.precheck_missing).toBe(500);
  });

  test('a model that says no ends the job with cannot_supply and places no order, and the message holds the first 120 characters of the note', async () => {
    const rig = makeRig();
    rig.decision = accepted(decisionOf({ confirm: false, note: 'x'.repeat(200) }));
    const refusal = await refusalOf(rig.run());
    expect([refusal.code, refusal.status]).toStrictEqual(['cannot_supply', 403]);
    expect(ORDER_REFUSAL_STATUS.cannot_supply).toBe(403);
    expect(refusal.message.endsWith(`Note of the model: ${'x'.repeat(120)}`)).toBe(true);
    expect(rig.portal.orders.size).toBe(0);
    expect(rig.events).not.toContain('order');
    expect(does).toContain('When the model answers `confirm: false`, the job refuses with `cannot_supply` (403) after step 4. It places no order, and nothing is paid.');
    expect(does).toContain('The message of the refusal holds a fixed sentence and the first 120 characters of the note of the model.');
    expect(does).toContain('The escrow is Claimed, and it stays Claimed until the buyer reclaims it after `deliver_by`.');
  });

  test('the limits of the job: one order and no retry, a caller that hangs up, the 30 s before deliver_by, and the 20 s of a call to the portal', async () => {
    const gone = new AbortController();
    gone.abort();
    const rig = makeRig();
    const refusal = await refusalOf(rig.run({ signal: gone.signal }));
    expect([refusal.code, refusal.status]).toStrictEqual(['deadline', 422]);
    expect(rig.portal.orders.size).toBe(0);
    expect(ORDER_REFUSAL_STATUS.duplicate_po).toBe(403);
    expect(readFileSync(new URL('../src/job/order.ts', import.meta.url), 'utf8')).toContain('const RUNTIME_MARGIN_MS = 30_000;');
    expect(CALL_TIMEOUT_MS).toBe(20_000);
    expect(does).toContain('The job places at most one order, and nothing retries the order call. The portal refuses a second order for the same number, and the service answers `duplicate_po` (403).');
    expect(does).toContain('A job whose caller hangs up stops before the order is placed, because the service never places an order that nobody reads.');
    expect(does).toContain(`The job places no order when the order call could end less than 30 s before \`deliver_by\`, because the runtime stops waiting then. One call to the supplier portal takes ${CALL_TIMEOUT_MS} ms at most.`);
  });

  test('the Request and the Response headings are the two anchors that the manifest links to', () => {
    expect(page.match(/^### Request$/gm)).toHaveLength(1);
    expect(page.match(/^### Response$/gm)).toHaveLength(1);
    expect(manifest.interface.request_schema.$ref.endsWith('/specs/order-desk.md#request')).toBe(true);
    expect(manifest.interface.response_schema.$ref.endsWith('/specs/order-desk.md#response')).toBe(true);
  });

  test('the response example is the confirmation that the job gives in the golden run, and the members of the table are its members in their order', async () => {
    const response = sub('Response');
    const golden = readFileSync(new URL('./job/golden/confirmation.json', import.meta.url), 'utf8');
    const shown = /```json\n([\s\S]*?)\n```/.exec(response)?.[1] ?? '';
    expect(shown).toBe(golden.trimEnd());
    const given = await makeRig().run();
    expect(JSON.parse(shown)).toStrictEqual(given);
    expect(shown).toBe(JSON.stringify(given, null, 2));
    expect(parseOrderConfirmation(JSON.parse(shown))).toStrictEqual({ ok: true, value: given });
    // The example answers the request of the example: the same order, the same sender and the same approval, and the hash of its purchase order.
    const handoff = handoffOf();
    expect([given.po_number, given.sku, given.lot, given.quantity]).toStrictEqual([handoff.document.po_number, handoff.document.sku, handoff.document.lot, handoff.document.quantity]);
    expect(given.po_sha256).toBe(hashOf(handoff.document));
    expect(given.sender.did).toBe(handoff.sender_did);
    expect(given.approval.attestation).toBe(handoff.approval?.attestation);
    expect(given.approval.issuer_did).toBe(handoff.approval?.issuer_did);
    expect(Object.keys(given.checks)).toStrictEqual([...CONFIRMATION_CHECKS]);
    // The table names the members in the order of the confirmation, and its rows say what they hold.
    const names = response.split('\n').filter((line) => /^\| `/.test(line)).flatMap((line) => [...(line.split(' | ')[0] ?? '').matchAll(/`([a-z0-9_]+)`/g)].map((hit) => hit[1]));
    expect(names).toStrictEqual(Object.keys(given));
    expect(row(response, '`schema`')).toBe(`| \`schema\` | \`${given.schema}\` |`);
    expect(row(response, '`outcome`')).toBe('| `outcome` | always `done`: a refusal or a failure is an error, never a confirmation |');
    expect(row(response, '`po_sha256`')).toBe('| `po_sha256` | the SHA-256 of the canonical text of the purchase order that the Order Desk received, with no salt |');
    expect(row(response, '`checks`')).toBe(`| \`checks\` | the ${CONFIRMATION_CHECKS.length} checks, each \`true\`, in the order of the table of the hook |`);
    expect(row(response, '`decisions`')).toBe('| `decisions` | one decision, `availability`: its choice, its reasoning, and the hire of the model supplier with the sub-receipt that the service verified (`inference`) |');
    expect(row(response, '`fault_mode`')).toBe('| `fault_mode` | the setting of the fault switch: the empty text in a clean run |');
    expect(response).toContain('It is an illustration and not a recorded run: its references, hashes, key hash and signature are of no escrow, no supplier and no key.');
    expect(response).toContain('A job that does not place it answers with an error (see Errors) and no confirmation.');
  });

  test('the fault run of the example names the wrong lot and its size, and the page says so', async () => {
    const wrong = JSON.parse(readFileSync(new URL('./job/golden/confirmation-wrong-lot.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    const given = await makeRig({ mode: 'confirm_wrong_lot' }).run();
    expect(given).toStrictEqual(wrong);
    expect([given.lot, given.quantity, given.fault_mode]).toStrictEqual(['lot-small', 10, 'confirm_wrong_lot']);
    expect(section('Fault switch')).toContain('For the purchase order of the example under Request, the confirmation of a fault run names `lot-small` and the quantity 10, and its `fault_mode` is `confirm_wrong_lot`.');
  });

  test('the lots example is the lots file that the service serves, and the manifest holds the hash of its bytes', () => {
    const lots = sub('The lots file');
    const file = readFileSync(new URL('../lots.json', import.meta.url), 'utf8');
    const shown = /```json\n([\s\S]*?)\n```/.exec(lots)?.[1] ?? '';
    expect(shown).toBe(file.trimEnd());
    expect(parseLotsFile(JSON.parse(shown)).ok).toBe(true);
    expect(manifest.behaviour.lots.sha256).toBe(lotsFileSha256(file));
    expect(lots).toContain(`\`GET ${LOTS_ROUTE}\` answers the lots file: the size of each lot for each SKU. It needs no token.`);
    expect(lots).toContain('The manifest holds its address and its SHA-256 in `behaviour.lots`, and the SHA-256 is the hash of these bytes as the service serves them.');
    expect(lots).toContain('The check `quantity` reads the same file, and the agent of a buyer reads it to choose the lot and the quantity of its order.');
    expect(readme).toContain('| `GET /lots.json` | the lots file, the bytes that the manifest hashes. It needs no token and takes no job slot |');
  });
});

describe('specs/order-desk.md: the errors', () => {
  const errors = sub('Errors');
  const statusRows = (text: string): string[] => text.split('\n').filter((line) => /^\| \d{3}, /.test(line));
  /** The names of codes in the second cell of a row of the table, in order. */
  const codesIn = (line: string): string[] => [...(line.split('|')[2] ?? '').matchAll(/`([^`]+)`/g)].map((hit) => hit[1]).filter((text) => /^[a-z_]+$/.test(text));

  test('the table is the table of the README, row for row, and every code has its status in the protocol or in the request refusal of the service', () => {
    const onPage = statusRows(errors);
    expect(onPage).toHaveLength(10);
    expect(onPage).toStrictEqual(statusRows(readme.split('\n## Errors\n')[1] ?? ''));
    const documented = new Map<string, number[]>();
    for (const line of onPage) {
      const status = Number(/^\| (\d{3}), /.exec(line)?.[1]);
      for (const code of codesIn(line)) {
        documented.set(code, [...(documented.get(code) ?? []), status]);
        expect(code === 'bad_context' ? new RequestRefusal('bad_context', 'x').status : ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(status);
      }
    }
    // The 403 row before the Claim holds the 18 codes of the hook, in the order of its checks, and the codes of the job are the codes that the job gives.
    const before = onPage.find((line) => line.startsWith('| 403, the hook, before the Claim')) ?? '';
    expect(codesIn(before)).toStrictEqual(COUNTERPARTY_REFUSALS['order-desk'].filter((code) => code !== 'cannot_supply'));
    expect(codesIn(onPage.find((line) => line.startsWith('| 403, the job, after the Claim')) ?? '')).toStrictEqual(['cannot_supply', 'duplicate_po']);
    for (const [code, status] of Object.entries(ORDER_REFUSAL_STATUS)) expect(documented.get(code), code).toContain(status);
    for (const code of [...COUNTERPARTY_REFUSALS['order-desk'], 'check_unavailable', 'busy', 'shutting_down', 'unauthorized', 'bad_wire', 'request_too_large', 'bad_shape', 'bad_context', 'internal']) {
      expect(documented.has(code), code).toBe(true);
    }
    expect([...documented.entries()].filter(([, statuses]) => statuses.length > 1)).toStrictEqual([['duplicate_po', [403, 403]]]);
  });

  test('the text of the section gives the shape of a refusal, the fixed message of a fault, what a refusal leaves behind, the busy answer and the interim line', () => {
    expect(errors).toContain('A refusal is `{ "error": "<code>", "message": "<words>" }` with the status in the table.');
    expect(errors).toContain('- The 401 has the code and no message.');
    expect(errors).toContain(`- A refusal of status 500 or more gets a fixed message, \`${operatorsText('<code>')}\`, because the runtime copies the first 200 characters of a failure to the buyer, and the detail is the operator's.`);
    expect(errors).toContain('- The message of `cannot_supply` holds a fixed sentence and the first 120 characters of the note of the model.');
    expect(errors).toContain('- Anything else is 500 `{"error":"internal"}` with no detail. The cause is in the log.');
    expect(errors).toContain('- A refusal of the hook leaves the escrow open, and nothing is paid. A job that fails after the Claim leaves the escrow Claimed: the buyer reclaims it after `deliver_by`, and nothing is paid for work that was not done. A job that fails before the order is placed places no order.');
    expect(errors).toContain('gets 409 `{"error":"busy"}`, and nothing starts.');
    expect(HEARTBEAT_MS).toBe(60_000);
    expect(errors).toContain('writes an interim `102 Processing` line every 60 s, ahead of the answer, because the fetch of the runtime gives up after 300 s of silence.');
    expect(readme).toContain('The reason is that the runtime\'s fetch gives up after 300 s of silence.');
    expect(readme).toContain('A job that fails after the Claim leaves the escrow claimed. The buyer reclaims it after the deadline, and nothing is paid for work that was not done. A job that fails before the order is placed places no order.');
  });
});
