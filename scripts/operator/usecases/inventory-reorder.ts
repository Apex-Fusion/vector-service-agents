// scripts/operator/usecases/inventory-reorder.ts - the data of use case 1 (inventory reorder): the keys, the organisations, the two agents and the subagent, the funding, the attestations, the runs
// and the steps of the evidence. The operator tasks read this value and nothing else about the use case.
// The file holds public text and amounts in lovelace (bigint). It holds no key, no wallet address, no DID and no hash of a run, and no contact address: the contact is a setting.
// A test (test/usecase-inventory-reorder.test.ts) holds each name and each number here to the public file of the agents that states it, so a change in one place fails a test in the other.
import { INVENTORY_CAPABILITIES } from '../../../packages/usecase-kit/src/inventory/index.ts';
import { CHALLENGE_RESERVE_LOVELACE } from '../lib/claim-constants.ts';
import type { KeyLine, KeyUse, OrganisationSpec, PartySpec, UseCase } from '../lib/contract.ts';

const REORDER_ENV = '.env.reorder-agent';
const ORDER_ENV = '.env.order-desk';
const ORDER_SMALL_ENV = '.env.order-desk-small';
const ORDER_MEDIUM_ENV = '.env.order-desk-medium';
const ORDER_LARGE_ENV = '.env.order-desk-large';

const REORDER_ORIGIN = 'https://mp-suppliers-reorder.vector.apexfusion.org';
const ORDERS_SMALL_ORIGIN = 'https://mp-suppliers-orders-small.vector.apexfusion.org';
const ORDERS_MEDIUM_ORIGIN = 'https://mp-suppliers-orders-medium.vector.apexfusion.org';
const ORDERS_LARGE_ORIGIN = 'https://mp-suppliers-orders-large.vector.apexfusion.org';

const ECHO: OrganisationSpec = { id: 'echo', domain: 'echo.vector.apexfusion.org', accountableKey: 'accountable-echo', guardianKey: 'guardian-echo' };
const ALFA: OrganisationSpec = { id: 'alfa', domain: 'alfa.vector.apexfusion.org', accountableKey: 'accountable-alfa', guardianKey: 'guardian-alfa' };

/** One line of an env file: the file, the variable, and what the line holds. */
const line = (file: string, name: string, of: KeyLine['of']): KeyLine => ({ file, name, of });

/** The five parties of the record of an agent: the Accountable key of its organisation, Module-1, the Provider key (no rights), the guardian key of the organisation and the controller key as guardians. */
function partiesOf(organisation: OrganisationSpec): readonly PartySpec[] {
  return [
    { role: 'Accountable', signer: { kind: 'key', key: organisation.accountableKey }, organisation: organisation.domain, rights: null },
    { role: 'Responsible', signer: { kind: 'module1' }, organisation: null, rights: null },
    { role: 'Provider', signer: { kind: 'key', key: 'provider' }, organisation: null, rights: [] },
    { role: 'Guardian', signer: { kind: 'key', key: organisation.guardianKey }, organisation: null, rights: null },
    { role: 'Guardian', signer: { kind: 'key', key: 'controller' }, organisation: null, rights: null },
  ];
}

const REORDER_KEYS: readonly KeyUse[] = [
  {
    key: 'reorder-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(REORDER_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'), line(REORDER_ENV, 'SUPPLIER_PKH', 'pkh'), line(REORDER_ENV, 'SUPPLIER_ADDRESS', 'address'),
    ],
  },
  { key: 'reorder-service', purposes: ['authentication', 'transaction'], lines: [line(REORDER_ENV, 'REORDER_SERVICE_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'REORDER_SERVICE_PKH', 'pkh')] },
  { key: 'reorder-delegation-1', purposes: ['delegation'], lines: [line(REORDER_ENV, 'REORDER_DELEGATION_1_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'REORDER_DELEGATION_1_PKH', 'pkh')] },
  { key: 'reorder-delegation-2', purposes: ['delegation'], lines: [line(REORDER_ENV, 'REORDER_DELEGATION_2_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'REORDER_DELEGATION_2_PKH', 'pkh')] },
];

const STOCK_READER_KEYS: readonly KeyUse[] = [
  { key: 'stock-reader-auth', purposes: ['authentication'], lines: [line(REORDER_ENV, 'STOCK_READER_AUTH_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'STOCK_READER_AUTH_PKH', 'pkh')] },
  { key: 'stock-reader-delegation', purposes: ['delegation'], lines: [line(REORDER_ENV, 'STOCK_READER_DELEGATION_PRIV_KEY_HEX', 'secret'), line(REORDER_ENV, 'STOCK_READER_DELEGATION_PKH', 'pkh')] },
];

const ORDER_KEYS: readonly KeyUse[] = [
  {
    key: 'order-small-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(ORDER_SMALL_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(ORDER_SMALL_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'), line(ORDER_SMALL_ENV, 'SUPPLIER_PKH', 'pkh'), line(ORDER_SMALL_ENV, 'SUPPLIER_ADDRESS', 'address'),
      line(ORDER_ENV, 'SMALL_SUPPLIER_PKH', 'pkh'), line(ORDER_ENV, 'SMALL_SUPPLIER_PUB_KEY_HEX', 'pub'),
    ],
  },
  {
    key: 'order-medium-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(ORDER_MEDIUM_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(ORDER_MEDIUM_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'), line(ORDER_MEDIUM_ENV, 'SUPPLIER_PKH', 'pkh'), line(ORDER_MEDIUM_ENV, 'SUPPLIER_ADDRESS', 'address'),
      line(ORDER_ENV, 'MEDIUM_SUPPLIER_PKH', 'pkh'), line(ORDER_ENV, 'MEDIUM_SUPPLIER_PUB_KEY_HEX', 'pub'),
    ],
  },
  {
    key: 'order-large-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(ORDER_LARGE_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(ORDER_LARGE_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'), line(ORDER_LARGE_ENV, 'SUPPLIER_PKH', 'pkh'), line(ORDER_LARGE_ENV, 'SUPPLIER_ADDRESS', 'address'),
      line(ORDER_ENV, 'LARGE_SUPPLIER_PKH', 'pkh'), line(ORDER_ENV, 'LARGE_SUPPLIER_PUB_KEY_HEX', 'pub'),
    ],
  },
  { key: 'order-desk-service', purposes: ['authentication', 'transaction'], lines: [line(ORDER_ENV, 'ORDER_DESK_SERVICE_PRIV_KEY_HEX', 'secret'), line(ORDER_ENV, 'ORDER_DESK_SERVICE_PKH', 'pkh')] },
];

// The funding of each wallet, in lovelace: one pure output of 5,000,000 as collateral, and a float. The float is the sum of the items, rounded up to a multiple of 10,000,000.
const COLLATERAL = 5_000_000n;
const ORDER_SUPPLIER_ITEMS: UseCase['funding'][number]['items'] = [
  { what: 'Deposit of the advert', lovelace: 2_500_000n },
  { what: 'Fee of the advert', lovelace: 350_000n },
  { what: 'Supplier bond', lovelace: 1_000_000n },
  { what: 'Fees of about 4 jobs', lovelace: 3_600_000n },
];
const DELEGATION_ITEMS: UseCase['funding'][number]['items'] = [
  { what: 'Fees of the delegate and the undelegate of about 10 jobs', lovelace: 8_000_000n },
  { what: 'Deposit of the sub-delegation in flight', lovelace: 2_200_000n },
  { what: 'Fees of the Pay and the Accept of about 8 jobs', lovelace: 8_000_000n },
  { what: 'Top-ups of the returned output', lovelace: 500_000n },
];

const USE_CASE: UseCase = {
  name: 'inventory-reorder',
  title: 'Use case 1 (inventory reorder)',
  keys: [
    { name: 'controller', scope: 'shared', about: 'Controller of every record that this deployment registers. It signs registrations, stakes and attestation consents.' },
    { name: 'run', scope: 'shared', about: 'The run wallet. It funds the other wallets.' },
    { name: 'fee', scope: 'shared', about: 'Pays the deposits and the fees of registrations, attestations and party actions.' },
    { name: 'provider', scope: 'shared', about: 'Provider key. It issues the provenance and software attestations.' },
    { name: 'accountable-echo', scope: 'shared', about: 'Accountable key of the organisation echo.' },
    { name: 'guardian-echo', scope: 'shared', about: 'Guardian key of the organisation echo.' },
    { name: 'accountable-alfa', scope: 'shared', about: 'Accountable key of the organisation alfa.' },
    { name: 'guardian-alfa', scope: 'shared', about: 'Guardian key of the organisation alfa.' },
    { name: 'reorder-supplier', scope: 'use-case', about: 'Supplier key of the Reorder Agent runtime.' },
    { name: 'reorder-service', scope: 'use-case', about: 'Service key of the Reorder Agent: model hires, claims, challenges and the stake.' },
    { name: 'reorder-delegation-1', scope: 'use-case', about: 'First delegation key of the Reorder Agent. A delegation of a hirer names one of its two delegation keys.' },
    { name: 'reorder-delegation-2', scope: 'use-case', about: 'Second delegation key of the Reorder Agent. A delegation of a hirer names one of its two delegation keys.' },
    { name: 'stock-reader-auth', scope: 'use-case', about: 'Authentication key of the stock-reader subagent.' },
    { name: 'stock-reader-delegation', scope: 'use-case', about: 'Delegation key of the stock-reader subagent.' },
    { name: 'order-small-supplier', scope: 'use-case', about: 'Supplier key of the Order Desk runtime for the small lot.' },
    { name: 'order-medium-supplier', scope: 'use-case', about: 'Supplier key of the Order Desk runtime for the medium lot.' },
    { name: 'order-large-supplier', scope: 'use-case', about: 'Supplier key of the Order Desk runtime for the large lot.' },
    { name: 'order-desk-service', scope: 'use-case', about: 'Service key of the Order Desk.' },
  ],
  organisations: [ECHO, ALFA],
  agents: [
    {
      id: 'reorder-agent', kind: 'reorder-agent', name: 'Reorder Agent',
      description: 'Demonstration organisation run by the Apex Fusion Foundation. Agent of a buying organisation in use case 1 (inventory reorder).',
      capability: INVENTORY_CAPABILITIES.reorder, organisation: 'echo', endpoint: REORDER_ORIGIN, folder: 'reorder-agent', serviceEnvFile: REORDER_ENV, serviceKey: 'reorder-service',
      statusUrls: [`${REORDER_ORIGIN}/status`],
      keys: REORDER_KEYS, parties: partiesOf(ECHO), guardianThreshold: 2,
      adverts: [
        {
          model: 'reorder-agent-v1', priceLovelace: 3_000_000n, supplierBondLovelace: 1_000_000n, buyerBondLovelace: 1_000_000n, windowMs: 1_800_000, maxOutputTokens: 0, depositLovelace: 2_500_000n,
          supplierKey: 'reorder-supplier', origin: REORDER_ORIGIN, runtimeEnvFile: REORDER_ENV, runtimeContainer: 'reorder-runtime',
        },
      ],
      cosign: true, faultValues: [], stakeLovelace: 10_000_000n,
      claim: { stakeLovelace: 50_000_000n, windowMs: 86_400_000, claimType: INVENTORY_CAPABILITIES.reorder, challengeReserveLovelace: CHALLENGE_RESERVE_LOVELACE },
      serviceContainer: 'reorder-service', exampleEnvFile: null, envManaged: { mock: true, module1: true }, publicKeyLines: [],
      end: { record: 'active', advert: 'listed', subagents: 'live', successor: null },
    },
    {
      id: 'order-desk', kind: 'order-desk', name: 'Order Desk',
      description: 'Demonstration organisation run by the Apex Fusion Foundation. Order desk of a supplier in use case 1 (inventory reorder).',
      capability: INVENTORY_CAPABILITIES.order, organisation: 'alfa', endpoint: ORDERS_SMALL_ORIGIN, folder: 'order-desk', serviceEnvFile: ORDER_ENV, serviceKey: 'order-desk-service',
      statusUrls: [`${ORDERS_SMALL_ORIGIN}/status`, `${ORDERS_MEDIUM_ORIGIN}/status`, `${ORDERS_LARGE_ORIGIN}/status`],
      keys: ORDER_KEYS, parties: partiesOf(ALFA), guardianThreshold: 2,
      adverts: [
        {
          model: 'lot-small', priceLovelace: 2_000_000n, supplierBondLovelace: 1_000_000n, buyerBondLovelace: 1_000_000n, windowMs: 480_000, maxOutputTokens: 0, depositLovelace: 2_500_000n,
          supplierKey: 'order-small-supplier', origin: ORDERS_SMALL_ORIGIN, runtimeEnvFile: ORDER_SMALL_ENV, runtimeContainer: 'orders-small-runtime',
        },
        {
          model: 'lot-medium', priceLovelace: 5_000_000n, supplierBondLovelace: 1_000_000n, buyerBondLovelace: 1_000_000n, windowMs: 480_000, maxOutputTokens: 0, depositLovelace: 2_500_000n,
          supplierKey: 'order-medium-supplier', origin: ORDERS_MEDIUM_ORIGIN, runtimeEnvFile: ORDER_MEDIUM_ENV, runtimeContainer: 'orders-medium-runtime',
        },
        {
          model: 'lot-large', priceLovelace: 10_000_000n, supplierBondLovelace: 1_000_000n, buyerBondLovelace: 1_000_000n, windowMs: 480_000, maxOutputTokens: 0, depositLovelace: 2_500_000n,
          supplierKey: 'order-large-supplier', origin: ORDERS_LARGE_ORIGIN, runtimeEnvFile: ORDER_LARGE_ENV, runtimeContainer: 'orders-large-runtime',
        },
      ],
      cosign: false, faultValues: ['confirm_wrong_lot'], stakeLovelace: 10_000_000n,
      claim: { stakeLovelace: 50_000_000n, windowMs: 86_400_000, claimType: INVENTORY_CAPABILITIES.order, challengeReserveLovelace: null },
      serviceContainer: 'orders-service', exampleEnvFile: null, envManaged: { mock: true, module1: true }, publicKeyLines: [],
      end: { record: 'active', advert: 'listed', subagents: 'live', successor: null },
    },
  ],
  subagents: [
    {
      id: 'stock-reader', parent: 'reorder-agent', name: 'stock-reader',
      description: 'Demonstration organisation run by the Apex Fusion Foundation. Subagent of the Reorder Agent in use case 1 (inventory reorder). It reads the stock of one SKU.',
      keys: STOCK_READER_KEYS,
    },
  ],
  funding: [
    {
      wallet: 'fee', collateralLovelace: COLLATERAL, floatLovelace: 60_000_000n,
      items: [
        { what: 'Deposits of the three records', lovelace: 30_000_000n },
        { what: 'Fees of the registrations', lovelace: 1_500_000n },
        { what: 'Deposits of the four attestations', lovelace: 20_000_000n },
        { what: 'Fees of the attestations', lovelace: 1_360_000n },
        { what: 'Fees of the hold and the lift', lovelace: 800_000n },
      ],
    },
    {
      wallet: 'reorder-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n,
      items: [
        { what: 'Deposit of the advert', lovelace: 2_500_000n },
        { what: 'Fee of the advert', lovelace: 350_000n },
        { what: 'Supplier bond', lovelace: 1_000_000n },
        { what: 'Fees of about 20 jobs, less the prices that the wallet earns', lovelace: 6_000_000n },
      ],
    },
    { wallet: 'order-small-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n, items: ORDER_SUPPLIER_ITEMS },
    { wallet: 'order-medium-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n, items: ORDER_SUPPLIER_ITEMS },
    { wallet: 'order-large-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n, items: ORDER_SUPPLIER_ITEMS },
    { wallet: 'reorder-delegation-1', collateralLovelace: COLLATERAL, floatLovelace: 20_000_000n, items: DELEGATION_ITEMS },
    { wallet: 'reorder-delegation-2', collateralLovelace: COLLATERAL, floatLovelace: 20_000_000n, items: DELEGATION_ITEMS },
    {
      wallet: 'reorder-service', collateralLovelace: COLLATERAL, floatLovelace: 190_000_000n,
      items: [
        { what: 'Stake', lovelace: 10_000_000n },
        { what: 'Opening of the stake', lovelace: 2_000_000n },
        { what: 'Fees of the stake', lovelace: 820_000n },
        { what: 'Two claims in flight', lovelace: 100_000_000n },
        { what: 'Fees of the claims', lovelace: 4_000_000n },
        { what: 'One challenge', lovelace: 50_000_000n },
        { what: 'Fees of the challenge', lovelace: 1_000_000n },
        { what: 'Ten model hires of 2.2 units each', lovelace: 22_000_000n },
      ],
    },
    {
      wallet: 'order-desk-service', collateralLovelace: COLLATERAL, floatLovelace: 130_000_000n,
      items: [
        { what: 'Stake', lovelace: 10_000_000n },
        { what: 'Opening of the stake', lovelace: 2_000_000n },
        { what: 'Fees of the stake', lovelace: 820_000n },
        { what: 'Two claims in flight', lovelace: 100_000_000n },
        { what: 'Fees of the claims', lovelace: 4_000_000n },
        { what: 'Four model hires of 2.2 units each', lovelace: 8_800_000n },
      ],
    },
  ],
  attestations: [
    { agent: 'reorder-agent', types: ['provenance', 'software'], format: 50, validDays: 365, envelope: { type: 'software' } },
    { agent: 'order-desk', types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null },
  ],
  runs: [
    { id: 'clean', subject: 'GLV-NIT-M', tenantPrefix: 'reorder-clean', vaultUnits: 8.3, perTxUnits: 7, totalUnits: 7 },
    { id: 'failure', subject: 'MSK-N95', tenantPrefix: 'reorder-failure', vaultUnits: 8.3, perTxUnits: 7, totalUnits: 7 },
  ],
  evidenceSteps: [
    { id: 'r1-01', run: 'clean', what: 'The hirer delegates to the Reorder Agent. The agent co-signs. The hirer submits.', primitive: 'Delegation with a co-signature', actor: 'hirer' },
    { id: 'r1-02', run: 'clean', what: 'The hirer opens a vault under the delegation.', primitive: 'Vault', actor: 'hirer' },
    { id: 'r1-03', run: 'clean', what: 'The hirer hires `propose`.', primitive: 'Escrow: post, claim, submit, accept', actor: 'hirer' },
    {
      id: 'r1-04', run: 'clean', what: 'The agent sub-delegates the stock read to its subagent. The subagent reads the stock with a token that has a two-link chain.',
      primitive: 'Sub-delegation, token exchange with the delegation chain', actor: 'agent',
    },
    {
      id: 'r1-05', run: 'clean', what: 'A model decides the lot. The agent returns the purchase order, the salt and the digest, and ends the sub-delegation.',
      primitive: 'Model call from the marketplace, signed work record', actor: 'agent',
    },
    { id: 'r1-06', run: 'clean', what: 'The hirer approves the digest.', primitive: 'Attestation: approval', actor: 'hirer' },
    { id: 'r1-07', run: 'clean', what: 'The hirer hires `execute`.', primitive: 'Escrow', actor: 'hirer' },
    { id: 'r1-08', run: 'clean', what: 'The agent pays the advert of the approved lot from the vault and sends the handoff.', primitive: 'Vault payment, agent hires agent', actor: 'agent' },
    {
      id: 'r1-09', run: 'clean', what: 'The Order Desk checks the handoff before its claim, decides availability, writes the order to the supplier portal with its X.509 identity and submits.',
      primitive: 'Pre-claim check, X.509 SVID, model call', actor: 'counterparty',
    },
    {
      id: 'r1-10', run: 'clean', what: 'The agent checks the receipt, decides to accept, accepts, writes the purchase order to the PO store with a token, and returns.',
      primitive: 'Receipt checks, accept, token for a route', actor: 'agent',
    },
    { id: 'r1-11', run: 'clean', what: 'The hirer closes the vault and ends the delegation.', primitive: 'Vault close, undelegate', actor: 'hirer' },
    {
      id: 'r2-a', run: 'failure', what: 'The order for the large lot meets a payment above the limit of the delegation. The vault script refuses at the node evaluation.',
      primitive: 'Value limit of a vault', actor: 'agent',
    },
    {
      id: 'r2-b', run: 'failure', what: 'The same approved order goes to `execute` again after one settled order. The vault script refuses: the total is spent.',
      primitive: 'Value limit of a vault', actor: 'agent',
    },
    {
      id: 'r2-c', run: 'failure',
      what: 'The Order Desk runs with the fault `confirm_wrong_lot`. The model of the agent refuses the confirmation, publishes the evidence and challenges the claim of the Order Desk.',
      primitive: 'Module-1 challenge', actor: 'agent',
    },
    { id: 'r2-d', run: 'failure', what: 'The jury decides. The Order Desk gets a hold of 7 days, reason 64.', primitive: 'Module-1 verdict and hold', actor: 'relay' },
    {
      id: 'r2-e', run: 'failure', what: 'The release watcher of the Order Desk releases the escrow 600 seconds after the submit. The supplier is paid.',
      primitive: 'Escrow: release', actor: 'counterparty',
    },
    { id: 'r2-f', run: 'failure', what: 'A new `propose` that names the Order Desk during the hold finds no listed advert and fails.', primitive: 'Hold removes the agent from the listing', actor: 'agent' },
    {
      id: 'r2-g', run: 'failure', what: 'The Accountable key of the organisation of the Order Desk places a hold on it and lifts it.',
      primitive: 'Hold and lift by a party', actor: 'operator',
    },
    {
      id: 'r2-h', run: 'failure', what: 'The hirer ends the delegation. An approved order goes to `execute` and the payment fails. The gateway refuses a token request under that delegation.',
      primitive: 'End of a delegation, token refusal', actor: 'hirer',
    },
  ],
  moduleManifestPath: 'Module-1/deploy/identity/mainnet/manifest.json',
  runtimeCommit: 'a05564cae3ca0e72a3591c8b2eb16c7909a60839',
  records: [],
  compliance: null,
  lifecycle: null,
  tenantSeed: null,
  tenantOrganisations: { supplier: ALFA.domain, insurer: 'delta.vector.apexfusion.org' },
  // The section "Not covered" of the results page, as the results task prints it for use case 1.
  notCovered: {
    lead: 'No run covers these three items:',
    items: [
      'The refund of the escrow of a revoked agent.',
      'The reclaim of an escrow by its buyer.',
      'A relying party that refuses a live token after its authority ended. Tests alone cover this item.',
    ],
  },
};

export default USE_CASE;
