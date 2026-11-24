// Data for use case 2 (prior authorization). The operator tasks read this value.
import { CHALLENGE_RESERVE_LOVELACE, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../lib/claim-constants.ts';
import type { KeyUse, UseCase } from '../lib/contract.ts';
import { PRIORAUTH_CAPABILITIES } from '../lib/platform.ts';
import { ALFA, COLLATERAL, CORE_KEYS, DELTA, DEMONSTRATION_SENTENCE, ECHO, MODULE_MANIFEST_PATH, RESULT_REFS, RESULT_WORDING, RUNTIME_COMMIT, line, organisationKeys, partiesOf } from './shared.ts';

const PRIORAUTH_ENV = '.env.prior-authorization-agent';
const INTAKE_ENV = '.env.insurer-intake-agent';
const PRIORAUTH_ORIGIN = 'https://mp-suppliers-priorauth.vector.apexfusion.org';
const INTAKE_ORIGIN = 'https://mp-suppliers-intake.vector.apexfusion.org';
const STAKE = 10_000_000n;
const ADVERT_DEPOSIT = 2_500_000n;
const BOND = 1_000_000n;

const PRIORAUTH_KEYS: readonly KeyUse[] = [
  {
    key: 'priorauth-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(PRIORAUTH_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'),
      line(PRIORAUTH_ENV, 'SUPPLIER_PKH', 'pkh'), line(PRIORAUTH_ENV, 'SUPPLIER_ADDRESS', 'address'),
    ],
  },
  { key: 'priorauth-service', purposes: ['authentication', 'transaction'], lines: [line(PRIORAUTH_ENV, 'PRIORAUTH_SERVICE_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'PRIORAUTH_SERVICE_PKH', 'pkh')] },
  { key: 'priorauth-delegation-1', purposes: ['delegation'], lines: [line(PRIORAUTH_ENV, 'PRIORAUTH_DELEGATION_1_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'PRIORAUTH_DELEGATION_1_PKH', 'pkh')] },
  { key: 'priorauth-delegation-2', purposes: ['delegation'], lines: [line(PRIORAUTH_ENV, 'PRIORAUTH_DELEGATION_2_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'PRIORAUTH_DELEGATION_2_PKH', 'pkh')] },
];
const RECORD_READER_KEYS: readonly KeyUse[] = [
  { key: 'record-reader-auth', purposes: ['authentication'], lines: [line(PRIORAUTH_ENV, 'RECORD_READER_AUTH_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'RECORD_READER_AUTH_PKH', 'pkh')] },
  { key: 'record-reader-delegation', purposes: ['delegation'], lines: [line(PRIORAUTH_ENV, 'RECORD_READER_DELEGATION_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'RECORD_READER_DELEGATION_PKH', 'pkh')] },
];
const DRAFTER_KEYS: readonly KeyUse[] = [
  { key: 'drafter-auth', purposes: ['authentication'], lines: [line(PRIORAUTH_ENV, 'DRAFTER_AUTH_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'DRAFTER_AUTH_PKH', 'pkh')] },
  { key: 'drafter-delegation', purposes: ['delegation'], lines: [line(PRIORAUTH_ENV, 'DRAFTER_DELEGATION_PRIV_KEY_HEX', 'secret'), line(PRIORAUTH_ENV, 'DRAFTER_DELEGATION_PKH', 'pkh')] },
];
const INTAKE_KEYS: readonly KeyUse[] = [
  {
    key: 'intake-supplier', purposes: ['authentication', 'transaction'],
    lines: [
      line(INTAKE_ENV, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(INTAKE_ENV, 'SUPPLIER_PUB_KEY_HEX', 'pub'),
      line(INTAKE_ENV, 'SUPPLIER_PKH', 'pkh'), line(INTAKE_ENV, 'SUPPLIER_ADDRESS', 'address'),
    ],
  },
  { key: 'intake-service', purposes: ['authentication', 'transaction'], lines: [line(INTAKE_ENV, 'INTAKE_SERVICE_PRIV_KEY_HEX', 'secret'), line(INTAKE_ENV, 'INTAKE_SERVICE_PKH', 'pkh')] },
];

// Each float is the sum of the budget items, rounded up to a multiple of ten units. The fees are estimates.
const SUPPLIER_ITEMS: UseCase['funding'][number]['items'] = [
  { what: 'Deposit of the advert', lovelace: ADVERT_DEPOSIT },
  { what: 'Fee of the advert', lovelace: 350_000n },
  { what: 'Supplier bond', lovelace: BOND },
];
const DELEGATION_ITEMS: UseCase['funding'][number]['items'] = [
  { what: 'Fees to open and end eight sub-delegations', lovelace: 6_300_000n },
  { what: 'Two sub-delegation deposits in flight', lovelace: 4_400_000n },
  { what: 'Fees to pay and accept or reclaim five hires', lovelace: 5_000_000n },
  { what: 'Top-ups of the returned output', lovelace: 500_000n },
];
const SERVICE_ITEMS: UseCase['funding'][number]['items'] = [
  { what: 'Stake', lovelace: STAKE },
  { what: 'Opening of the stake', lovelace: 2_000_000n },
  { what: 'Fees of the stake', lovelace: 820_000n },
  { what: 'Two claims in flight', lovelace: 2n * CLAIM_STAKE_LOVELACE },
  { what: 'Fees of the claims', lovelace: 4_000_000n },
  { what: 'One challenge', lovelace: 50_000_000n },
  { what: 'Fees of the challenge', lovelace: 1_000_000n },
];

const USE_CASE: UseCase = {
  name: 'prior-authorization',
  title: 'Use case 2 (prior authorization)',
  keys: [
    ...CORE_KEYS,
    ...organisationKeys(DELTA),
    { name: 'priorauth-supplier', scope: 'use-case', about: 'Supplier key of the Prior Authorization Agent runtime.' },
    { name: 'priorauth-service', scope: 'use-case', about: 'Service key of the Prior Authorization Agent. It pays for model hires, claims, challenges and the reputation stake.' },
    { name: 'priorauth-delegation-1', scope: 'use-case', about: 'First delegation key of the Prior Authorization Agent. A delegation from a hirer names one of its two delegation keys.' },
    { name: 'priorauth-delegation-2', scope: 'use-case', about: 'Second delegation key of the Prior Authorization Agent. A delegation from a hirer names one of its two delegation keys.' },
    { name: 'record-reader-auth', scope: 'use-case', about: 'Authentication key of the record-reader subagent.' },
    { name: 'record-reader-delegation', scope: 'use-case', about: 'Delegation key of the record-reader subagent.' },
    { name: 'drafter-auth', scope: 'use-case', about: 'Authentication key of the drafter subagent.' },
    { name: 'drafter-delegation', scope: 'use-case', about: 'Delegation key of the drafter subagent.' },
    { name: 'intake-supplier', scope: 'use-case', about: 'Supplier key of the Insurer Intake Agent runtime.' },
    { name: 'intake-service', scope: 'use-case', about: 'Service key of the Insurer Intake Agent. It pays for model hires, claims, challenges and the reputation stake.' },
  ],
  organisations: [ECHO, DELTA],
  agents: [
    {
      id: 'prior-authorization-agent', kind: 'prior-authorization-agent', name: 'Prior Authorization Agent',
      description: `${DEMONSTRATION_SENTENCE} Agent of a care provider in use case 2 (prior authorization).`,
      capability: PRIORAUTH_CAPABILITIES.draft, organisation: ECHO.id, endpoint: PRIORAUTH_ORIGIN, folder: 'prior-authorization-agent',
      serviceEnvFile: PRIORAUTH_ENV, serviceKey: 'priorauth-service', statusUrls: [`${PRIORAUTH_ORIGIN}/status`],
      serviceContainer: 'priorauth-service', exampleEnvFile: null, envManaged: { mock: true, module1: true }, publicKeyLines: [],
      keys: PRIORAUTH_KEYS, parties: partiesOf(ECHO), guardianThreshold: 2,
      adverts: [
        {
          model: 'prior-authorization-agent-v1', priceLovelace: 3_000_000n, supplierBondLovelace: BOND, buyerBondLovelace: BOND,
          windowMs: 1_800_000, maxOutputTokens: 0, depositLovelace: ADVERT_DEPOSIT,
          supplierKey: 'priorauth-supplier', origin: PRIORAUTH_ORIGIN, runtimeEnvFile: PRIORAUTH_ENV, runtimeContainer: 'priorauth-runtime',
        },
      ],
      cosign: true, faultValues: ['alter_after_approval'], stakeLovelace: STAKE,
      claim: { stakeLovelace: CLAIM_STAKE_LOVELACE, windowMs: CLAIM_WINDOW_MS, claimType: PRIORAUTH_CAPABILITIES.draft, challengeReserveLovelace: CHALLENGE_RESERVE_LOVELACE },
      end: { record: 'active', advert: 'retired', subagents: 'ended', successor: null },
    },
    {
      id: 'insurer-intake-agent', kind: 'insurer-intake-agent', name: 'Insurer Intake Agent',
      description: `${DEMONSTRATION_SENTENCE} Agent of an insurer in use case 2 (prior authorization).`,
      capability: PRIORAUTH_CAPABILITIES.intake, organisation: DELTA.id, endpoint: INTAKE_ORIGIN, folder: 'insurer-intake-agent',
      serviceEnvFile: INTAKE_ENV, serviceKey: 'intake-service', statusUrls: [`${INTAKE_ORIGIN}/status`],
      serviceContainer: 'intake-service', exampleEnvFile: null, envManaged: { mock: true, module1: true }, publicKeyLines: [],
      keys: INTAKE_KEYS, parties: partiesOf(DELTA), guardianThreshold: 2,
      adverts: [
        {
          model: 'insurer-intake-agent-v1', priceLovelace: 2_000_000n, supplierBondLovelace: BOND, buyerBondLovelace: BOND,
          windowMs: 480_000, maxOutputTokens: 0, depositLovelace: ADVERT_DEPOSIT,
          supplierKey: 'intake-supplier', origin: INTAKE_ORIGIN, runtimeEnvFile: INTAKE_ENV, runtimeContainer: 'intake-runtime',
        },
      ],
      cosign: false, faultValues: [], stakeLovelace: STAKE,
      claim: { stakeLovelace: CLAIM_STAKE_LOVELACE, windowMs: CLAIM_WINDOW_MS, claimType: PRIORAUTH_CAPABILITIES.intake, challengeReserveLovelace: CHALLENGE_RESERVE_LOVELACE },
      end: { record: 'active', advert: 'listed', subagents: 'live', successor: null },
    },
  ],
  subagents: [
    {
      id: 'record-reader', parent: 'prior-authorization-agent', name: 'record-reader',
      description: `${DEMONSTRATION_SENTENCE} Subagent in use case 2 (prior authorization). It reads an order and its record set.`, keys: RECORD_READER_KEYS,
    },
    {
      id: 'drafter', parent: 'prior-authorization-agent', name: 'drafter',
      description: `${DEMONSTRATION_SENTENCE} Subagent in use case 2 (prior authorization). It reads the guideline for an order.`, keys: DRAFTER_KEYS,
    },
  ],
  funding: [
    {
      wallet: 'fee', collateralLovelace: COLLATERAL, floatLovelace: 70_000_000n,
      items: [
        { what: 'Deposits of the records', lovelace: 40_000_000n },
        { what: 'Fees of the registrations', lovelace: 2_000_000n },
        { what: 'Deposits of the attestations', lovelace: 20_000_000n },
        { what: 'Fees of the attestations', lovelace: 1_360_000n },
        { what: 'Fee to end the subagents', lovelace: 500_000n },
      ],
    },
    {
      wallet: 'priorauth-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n,
      items: [...SUPPLIER_ITEMS, { what: 'Fees of about nine jobs', lovelace: 6_000_000n }],
    },
    {
      wallet: 'intake-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n,
      items: [...SUPPLIER_ITEMS, { what: 'Fees of about four jobs', lovelace: 3_600_000n }],
    },
    { wallet: 'priorauth-delegation-1', collateralLovelace: COLLATERAL, floatLovelace: 20_000_000n, items: DELEGATION_ITEMS },
    { wallet: 'priorauth-delegation-2', collateralLovelace: COLLATERAL, floatLovelace: 20_000_000n, items: DELEGATION_ITEMS },
    {
      wallet: 'priorauth-service', collateralLovelace: COLLATERAL, floatLovelace: 190_000_000n,
      items: [...SERVICE_ITEMS, { what: 'Six model hires', lovelace: 13_200_000n }],
    },
    {
      wallet: 'intake-service', collateralLovelace: COLLATERAL, floatLovelace: 180_000_000n,
      items: [...SERVICE_ITEMS, { what: 'Four model hires', lovelace: 8_800_000n }],
    },
  ],
  attestations: [
    { agent: 'prior-authorization-agent', types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null },
    { agent: 'insurer-intake-agent', types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null },
  ],
  runs: [
    { id: 'clean', subject: 'ORD-1001', tenantPrefix: 'priorauth-clean', vaultUnits: 5.3, perTxUnits: 4, totalUnits: 4 },
    { id: 'failure', subject: 'ORD-1001', tenantPrefix: 'priorauth-failure', vaultUnits: 17.3, perTxUnits: 4, totalUnits: 16 },
  ],
  // The steps describe the expected evidence, not the result of a run.
  evidenceSteps: [
    {
      id: 'r1-01', run: 'clean',
      what: 'The hirer delegates to the Prior Authorization Agent. The agent co-signs. The hirer submits. The hirer issues a principal-binding attestation that names the agent and opens a vault under the delegation.',
      primitive: 'Delegation with a co-signature, attestation: principal binding, vault', actor: 'hirer',
      proof: { refs: { delegation: 1, attestation: 1, vault: 1, transaction: 3 } },
    },
    {
      id: 'r1-02', run: 'clean',
      what: 'The hirer hires `propose`. The agent sub-delegates the record read and the guideline read to its two subagents, one after the other. Each subagent reads its system with its own token. A model writes the justification. The agent returns the request, the record set hash, the salt and the digest.',
      primitive: 'Escrow, two sub-delegations, token exchange with the delegation chain, model call from the marketplace', actor: 'agent',
      proof: { refs: { escrow: 2, delegation: 2, transaction: 4 }, projectedRoutes: [
        ['GET /records/orders/{order_id}', 'token', 'allowed', 2, 1, 200], ['GET /guidelines/{code}', 'token', 'allowed', 2, 1, 200],
      ] },
    },
    { id: 'r1-03', run: 'clean', what: 'The hirer approves the digest.', primitive: 'Attestation: approval', actor: 'hirer', proof: { refs: RESULT_REFS.approval } },
    {
      id: 'r1-04', run: 'clean', what: 'The hirer hires `execute`. The agent pays the advert of the Insurer Intake Agent from the vault and sends the handoff.',
      primitive: 'Escrow, vault payment, agent hires agent', actor: 'agent',
      proof: { refs: { escrow: 2, transaction: 3, vault: 1 } },
    },
    {
      id: 'r1-05', run: 'clean',
      what: 'The Insurer Intake Agent checks the handoff before it claims the escrow. It reads and reports the attestations of the sender. A model decides if the request is complete. The agent files the request at the insurer portal with its JWT identity and submits.',
      primitive: 'Pre-claim check, attestation reads, JWT-SVID, model call', actor: 'counterparty',
      proof: { refs: { escrow: 2, transaction: 1 }, projectedRoutes: [['POST /insurer/requests', 'jwt-svid', 'allowed', 0, 1, 201]] },
    },
    {
      id: 'r1-06', run: 'clean', what: 'The agent checks the receipt and accepts it. It writes the submission reference to the records system with a token and returns.',
      primitive: 'Receipt checks, accept, token for a route', actor: 'agent',
      proof: {
        refs: { escrow: 1, transaction: 1 }, projectedRoutes: [['POST /records/orders/{order_id}/submission', 'token', 'allowed', 1, 1, 201]],
        settlement: { type: 'intake-handoff', executeRole: 'execute', intakeRole: 'intake' },
      },
    },
    {
      id: 'r1-07', run: 'clean', what: 'The hirer closes the vault and ends the delegation.',
      primitive: 'Vault close, undelegate', actor: 'hirer', proof: { refs: RESULT_REFS.close },
    },
    {
      id: 'r2-d', run: 'failure',
      what: 'The hirer approves a proposal and revokes the approval. The Insurer Intake Agent refuses the handoff from `execute` before it claims the escrow. The escrow returns to the vault. The hirer approves again with a link to the first approval. `execute` goes through.',
      primitive: 'Attestation: revoke and approve again, refusal before the claim, reclaim to a vault', actor: 'hirer',
      proof: { refs: { attestation: 2, escrow: 3, transaction: 6 } },
    },
    {
      id: 'r2-e', run: 'failure',
      what: 'The hirer approves a second proposal with a short validity period. The hirer lets the approval expire. The Insurer Intake Agent refuses the handoff before it claims the escrow. The escrow returns to the vault.',
      primitive: 'Attestation: approval that ends, refusal before the claim', actor: 'counterparty',
      proof: { refs: { attestation: 1, escrow: 1, transaction: 2 } },
    },
    {
      id: 'r2-a', run: 'failure',
      what: 'The agent runs with the fault `alter_after_approval`. `execute` changes the request after approval. The Insurer Intake Agent finds that the digest differs. It does not claim the escrow or file a request at the insurer portal.',
      primitive: 'Digest check of an approval, refusal before the claim', actor: 'counterparty',
      proof: { refs: { escrow: 2, transaction: 2 } },
    },
    {
      id: 'r2-b', run: 'failure', what: 'The Insurer Intake Agent publishes the evidence and challenges the claim of the Prior Authorization Agent.',
      primitive: 'Module-1 challenge', actor: 'counterparty',
      proof: { refs: { claim: 1, challenge: 1 } },
    },
    {
      id: 'r2-b-hold', run: 'failure', what: 'The jury decides. The Prior Authorization Agent gets a hold of 7 days, reason 64.',
      primitive: 'Module-1 verdict and hold', actor: 'relay',
      proof: { refs: RESULT_REFS.verdict },
    },
    {
      id: 'r2-c', run: 'failure', what: 'The hirer tries to hire `propose` during the hold. The hosted tool refuses the hire because the agent has no listed advert.',
      primitive: 'Hold removes the agent from the listing', actor: 'hirer',
      proof: { refs: { hold: 1, transaction: 1 }, refusals: ['projected-tool'], recordFromTransaction: 'hold' },
    },
    {
      id: 'r2-f', run: 'failure',
      what: 'The controller ends the subagents of the agent. Both subagents resolve as revoked. The gateway refuses a token request from a subagent with no delegation.',
      primitive: 'End of the subagents, token refusal', actor: 'operator',
      proof: { refs: { transaction: 1, did: 2, probe: 2 } },
    },
  ],
  results: {
    runPrefix: 'use-case-2',
    wording: {
      'Delegation with a co-signature, attestation: principal binding, vault': {
        shows: 'The delegation, binding attestation and vault link the hirer to the agent.',
        doesNotShow: 'The private document or salt behind the binding digest.',
      },
      'Escrow, two sub-delegations, token exchange with the delegation chain, model call from the marketplace': {
        shows: 'The evidence links the proposal hire to two delegated reads and the model call for the justification.',
        doesNotShow: 'That the records or guideline came from real systems, or that the justification is correct.',
      },
      'Attestation: approval': RESULT_WORDING.approval,
      'Escrow, vault payment, agent hires agent': {
        shows: 'The execute hire led to a vault payment for a separate intake hire.',
        doesNotShow: 'That the insurer decided to cover the request.',
      },
      'Pre-claim check, attestation reads, JWT-SVID, model call': {
        shows: 'The intake evidence records the checks, the model decision and an allowed filing with a JWT identity.',
        doesNotShow: 'That the attestations were mandatory or that the request reached a real insurer.',
      },
      'Receipt checks, accept, token for a route': {
        shows: 'The evidence records a completed hire, acceptance of the intake work and an allowed write to the route with a token.',
        doesNotShow: 'That the write reached a real system. The route is part of a mock service.',
      },
      'Vault close, undelegate': RESULT_WORDING.close,
      'Attestation: revoke and approve again, refusal before the claim, reclaim to a vault': {
        shows: 'The evidence links the revoked approval to a refusal and reclaim, and the linked approval to the later hire.',
        doesNotShow: 'That a new approval can change the old one or make it valid again.',
      },
      'Attestation: approval that ends, refusal before the claim': {
        shows: 'The approval had expired when the handoff was refused before the claim.',
        doesNotShow: 'That an expired approval was the cause of any other refusal.',
      },
      'Digest check of an approval, refusal before the claim': {
        shows: 'Intake refused the changed request before the claim. The mock system records no filing for it.',
        doesNotShow: 'That the check decides whether the request is medically correct.',
      },
      'Module-1 challenge': RESULT_WORDING.challenge,
      'Module-1 verdict and hold': RESULT_WORDING.verdict,
      'Hold removes the agent from the listing': {
        shows: 'The marketplace listing during the hold did not show the held agent.',
        doesNotShow: 'That the listing will show the advert again after the hold.',
      },
      'End of the subagents, token refusal': {
        shows: 'The evidence ties the end transaction to revoked subagent resolutions and a refused token request.',
        doesNotShow: 'That a relying party stops accepting a token that it already holds.',
      },
    },
  },
  moduleManifestPath: MODULE_MANIFEST_PATH,
  runtimeCommit: RUNTIME_COMMIT,
  records: [],
  compliance: null,
  lifecycle: null,
  tenantSeed: null,
  tenantOrganisations: { supplier: ALFA.domain, insurer: DELTA.domain },
  notCovered: {
    lead: 'No run covers these three items:',
    items: [
      'The refund of the escrow of a revoked agent.',
      'A relying party that refuses a live token after its authority ended.',
      'A challenge of the Insurer Intake Agent by the Prior Authorization Agent.',
    ],
  },
};

export default USE_CASE;
