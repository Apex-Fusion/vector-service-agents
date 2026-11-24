// Data of use case 3 (supplier bid evaluation). This file holds public text and amounts in lovelace. The drift tests hold it to the deployment files of the four agents.
import { CHALLENGE_RESERVE_LOVELACE, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS } from '../lib/claim-constants.ts';
import type { AgentSpec, EndSpec, KeyUse, OrganisationSpec, SubagentSpec, UseCase } from '../lib/contract.ts';
import { BID_CAPABILITIES } from '../lib/platform.ts';
import {
  ALFA, BRAVO, CHARLIE, COLLATERAL, CORE_KEYS, DELTA, DEMONSTRATION_SENTENCE, ECHO, MODULE_MANIFEST_PATH, RESULT_REFS, RESULT_WORDING, RUNTIME_COMMIT, line, organisationKeys, partiesOf,
} from './shared.ts';

const SOURCING_ENV = '.env.sourcing-agent';
const SOURCING_ORIGIN = 'https://mp-suppliers-sourcing.vector.apexfusion.org';
const ISSUER_KEY = 'registry-foxtrot';
const SUCCESSOR = 'bravo-successor';
const SUCCESSOR_AUTH = 'bravo-successor-auth';
const BOND_LOVELACE = 1_000_000n;
const ADVERT_DEPOSIT_LOVELACE = 2_500_000n;
const STAKE_LOVELACE = 10_000_000n;
const ACTIVE: EndSpec = { record: 'active', advert: 'listed', subagents: 'live', successor: null };
const SIGNING_PURPOSES = ['authentication', 'transaction'] as const;

function supplierKey(key: string, file: string): KeyUse {
  return {
    key, purposes: SIGNING_PURPOSES,
    lines: [
      line(file, 'SUPPLIER_PRIV_KEY_HEX', 'secret'), line(file, 'SUPPLIER_PUB_KEY_HEX', 'pub'),
      line(file, 'SUPPLIER_PKH', 'pkh'), line(file, 'SUPPLIER_ADDRESS', 'address'),
    ],
  };
}

function keyPair(key: string, purposes: KeyUse['purposes'], file: string, prefix: string): KeyUse {
  return { key, purposes, lines: [line(file, `${prefix}_PRIV_KEY_HEX`, 'secret'), line(file, `${prefix}_PKH`, 'pkh')] };
}

const ADVERT_TERMS = { supplierBondLovelace: BOND_LOVELACE, buyerBondLovelace: BOND_LOVELACE, maxOutputTokens: 0, depositLovelace: ADVERT_DEPOSIT_LOVELACE };
const CLAIM_TERMS = { stakeLovelace: CLAIM_STAKE_LOVELACE, windowMs: CLAIM_WINDOW_MS };

const SOURCING: AgentSpec = {
  id: 'sourcing-agent', kind: 'sourcing-agent', name: 'Sourcing Agent',
  description: `${DEMONSTRATION_SENTENCE} Agent of a buying organisation in use case 3 (supplier bid evaluation).`,
  capability: BID_CAPABILITIES.evaluate, organisation: ECHO.id, endpoint: SOURCING_ORIGIN, folder: 'sourcing-agent',
  statusUrls: [`${SOURCING_ORIGIN}/status`], serviceKey: 'sourcing-service', serviceContainer: 'sourcing-service', serviceEnvFile: SOURCING_ENV,
  exampleEnvFile: null, envManaged: { mock: true, module1: true },
  publicKeyLines: [{ key: ISSUER_KEY, lines: [line(SOURCING_ENV, 'COMPLIANCE_ISSUER_PKH', 'pkh')] }],
  keys: [
    supplierKey('sourcing-supplier', SOURCING_ENV),
    keyPair('sourcing-service', SIGNING_PURPOSES, SOURCING_ENV, 'SOURCING_SERVICE'),
    keyPair('sourcing-delegation-1', ['delegation'], SOURCING_ENV, 'SOURCING_DELEGATION_1'),
    keyPair('sourcing-delegation-2', ['delegation'], SOURCING_ENV, 'SOURCING_DELEGATION_2'),
  ],
  parties: partiesOf(ECHO), guardianThreshold: 2,
  adverts: [{
    ...ADVERT_TERMS, model: 'sourcing-agent-v1', priceLovelace: 3_000_000n, windowMs: 5_400_000,
    supplierKey: 'sourcing-supplier', origin: SOURCING_ORIGIN, runtimeEnvFile: SOURCING_ENV, runtimeContainer: 'sourcing-runtime',
  }],
  cosign: true, faultValues: ['invert_scores'], stakeLovelace: STAKE_LOVELACE,
  claim: { ...CLAIM_TERMS, claimType: BID_CAPABILITIES.evaluate, challengeReserveLovelace: CHALLENGE_RESERVE_LOVELACE },
  end: ACTIVE,
};

function bidDesk(organisation: OrganisationSpec, name: string, end: EndSpec): AgentSpec {
  const instance = organisation.id;
  const id = `bid-desk-${instance}`;
  const file = `.env.${id}`;
  const origin = `https://mp-suppliers-bids-${instance}.vector.apexfusion.org`;
  const serviceKey = `bid-${instance}-service`;
  const supplier = `bid-${instance}-supplier`;
  return {
    id, kind: 'bid-desk', name,
    description: `${DEMONSTRATION_SENTENCE} Bid desk of a supplier in use case 3 (supplier bid evaluation).`,
    capability: BID_CAPABILITIES.quote, organisation: instance, endpoint: origin, folder: id,
    statusUrls: [`${origin}/status`], serviceKey, serviceContainer: `bids-${instance}-service`, serviceEnvFile: file,
    exampleEnvFile: '.env.bid-desk.example', envManaged: { mock: false, module1: false }, publicKeyLines: [],
    keys: [supplierKey(supplier, file), keyPair(serviceKey, SIGNING_PURPOSES, file, 'BID_DESK_SERVICE')],
    parties: partiesOf(organisation), guardianThreshold: 2,
    adverts: [{
      ...ADVERT_TERMS, model: 'bid-desk-v1', priceLovelace: 1_000_000n, windowMs: 480_000,
      supplierKey: supplier, origin, runtimeEnvFile: file, runtimeContainer: `bids-${instance}-runtime`,
    }],
    cosign: false, faultValues: ['quote_off_price_list'], stakeLovelace: STAKE_LOVELACE,
    claim: { ...CLAIM_TERMS, claimType: BID_CAPABILITIES.quote, challengeReserveLovelace: null },
    end,
  };
}

const DESKS = [
  bidDesk(ALFA, 'Bid Desk Alfa', ACTIVE),
  bidDesk(BRAVO, 'Bid Desk Bravo', { record: 'retired', advert: 'retired', subagents: 'live', successor: SUCCESSOR }),
  bidDesk(CHARLIE, 'Bid Desk Charlie', { record: 'revoked', advert: 'retired', subagents: 'live', successor: null }),
];
const AGENTS = [SOURCING, ...DESKS];
const SCORERS: readonly SubagentSpec[] = [1, 2, 3].map((number) => {
  const id = `scorer-${number}`;
  return {
    id, parent: SOURCING.id, name: id,
    description: `${DEMONSTRATION_SENTENCE} Subagent of the Sourcing Agent in use case 3 (supplier bid evaluation). It reads vendor data for one quote.`,
    keys: [
      keyPair(`${id}-auth`, ['authentication'], SOURCING_ENV, `SCORER_${number}_AUTH`),
      keyPair(`${id}-delegation`, ['delegation'], SOURCING_ENV, `SCORER_${number}_DELEGATION`),
    ],
  };
});

function useCaseKey(name: string, about: string): UseCase['keys'][number] {
  return { name, scope: 'use-case', about };
}

// Each wallet needs one pure collateral output and a float that covers its items. The float rounds up to a multiple of 10 units.
const SUPPLIER_ITEMS = [
  { what: 'Deposit of the advert', lovelace: ADVERT_DEPOSIT_LOVELACE },
  { what: 'Fee of the advert', lovelace: 350_000n },
  { what: 'Supplier bond', lovelace: BOND_LOVELACE },
];
const DESK_SUPPLIER_ITEMS = [...SUPPLIER_ITEMS, { what: 'Fees of about four quote jobs', lovelace: 3_600_000n }];
const DELEGATION_ITEMS = [
  { what: 'Delegate and Undelegate for 13 scorer jobs', lovelace: 10_400_000n },
  { what: 'Three delegation deposits in flight', lovelace: 6_600_000n },
  { what: 'Pay and Accept or Reclaim for 13 quote hires', lovelace: 13_000_000n },
  { what: 'Top-ups', lovelace: 1_000_000n },
];
const SERVICE_ITEMS = [
  { what: 'Stake', lovelace: STAKE_LOVELACE },
  { what: 'Opening of the stake', lovelace: 2_000_000n },
  { what: 'Fees of the stake', lovelace: 820_000n },
  { what: 'Two claims in flight', lovelace: 2n * CLAIM_STAKE_LOVELACE },
  { what: 'Fees of the claims', lovelace: 4_000_000n },
];
const DESK_SERVICE_ITEMS = [...SERVICE_ITEMS, { what: 'Five model hires of 2.2 units each', lovelace: 11_000_000n }];

const USE_CASE: UseCase = {
  name: 'bid-evaluation',
  title: 'Use case 3 (supplier bid evaluation)',
  keys: [
    ...CORE_KEYS, ...organisationKeys(ALFA), ...organisationKeys(BRAVO), ...organisationKeys(CHARLIE),
    useCaseKey('sourcing-supplier', 'Supplier key of the Sourcing Agent runtime.'),
    useCaseKey(SOURCING.serviceKey, 'Service key of the Sourcing Agent. It signs for model hires, the stake, claims and challenges.'),
    useCaseKey('sourcing-delegation-1', 'First delegation key of the Sourcing Agent. It signs for quote hires and child delegations.'),
    useCaseKey('sourcing-delegation-2', 'Second delegation key of the Sourcing Agent. It signs for quote hires and child delegations.'),
    ...SCORERS.flatMap((scorer) => [
      useCaseKey(`${scorer.id}-auth`, `Authentication key of ${scorer.id}.`),
      useCaseKey(`${scorer.id}-delegation`, `Delegation key of ${scorer.id}.`),
    ]),
    ...DESKS.flatMap((desk) => [
      useCaseKey(desk.adverts[0].supplierKey, `Supplier key of the runtime of ${desk.name}.`),
      useCaseKey(desk.serviceKey, `Service key of ${desk.name}. It signs for model hires, the stake and claims.`),
    ]),
    useCaseKey(ISSUER_KEY, 'Issuer key of the demonstration compliance registry.'),
    useCaseKey('l1-controller-1', 'First new controller of Bid Desk Bravo. It signs the controller change.'),
    useCaseKey('l1-controller-2', 'Second new controller of Bid Desk Bravo. Recovery puts this key in control.'),
    useCaseKey(SUCCESSOR_AUTH, 'Authentication key of the successor record of Bid Desk Bravo.'),
  ],
  organisations: [ECHO, ALFA, BRAVO, CHARLIE],
  agents: AGENTS,
  subagents: SCORERS,
  records: [{
    id: SUCCESSOR, name: 'Bravo Successor', description: `${DEMONSTRATION_SENTENCE} Successor record of Bid Desk Bravo.`,
    keys: [{ key: SUCCESSOR_AUTH, purposes: ['authentication'], lines: [] }],
    parties: [{ role: 'Accountable', signer: { kind: 'key', key: BRAVO.accountableKey }, organisation: BRAVO.domain, rights: null }],
    organisation: BRAVO.id, guardianThreshold: 0,
  }],
  compliance: {
    issuerKey: ISSUER_KEY, subjects: DESKS.map((desk) => desk.id), format: 50, validDays: 365,
    statement: 'The demonstration registry lists this supplier for the bid evaluation test.',
    reply: { text: 'The supplier notes the revoke of the demonstration compliance attestation.' },
  },
  lifecycle: {
    agent: 'bid-desk-bravo', controllers: ['l1-controller-1', 'l1-controller-2'], guardians: [BRAVO.guardianKey, 'controller'],
    successor: SUCCESSOR, waitMs: 604_800_000,
  },
  // Use the default vendor rows of the mock service. Set each organisation to the id of its Bid Desk organisation.
  tenantSeed: { vendors: [
    { vendor_id: 'V-1001', organisation: ALFA.id, name: 'Supplier Alfa (synthetic)', on_time_delivery_rate: 0.97, defect_rate: 0.01, years_as_vendor: 6, payment_terms_days: 30, certifications: ['ISO 9001'], last_audit: '2026-03-14' },
    { vendor_id: 'V-1002', organisation: BRAVO.id, name: 'Supplier Bravo (synthetic)', on_time_delivery_rate: 0.92, defect_rate: 0.03, years_as_vendor: 4, payment_terms_days: 45, certifications: ['ISO 9001'], last_audit: '2026-01-22' },
    { vendor_id: 'V-1003', organisation: CHARLIE.id, name: 'Supplier Charlie (synthetic)', on_time_delivery_rate: 0.85, defect_rate: 0.06, years_as_vendor: 2, payment_terms_days: 60, certifications: [], last_audit: '2025-11-05' },
  ] },
  tenantOrganisations: { supplier: ALFA.domain, insurer: DELTA.domain },
  notCovered: {
    lead: 'No run covers these 4 items:',
    items: [
      'No run covers the refund of the escrow of a revoked agent.',
      'No run covers the reclaim of an escrow in use case 3.',
      'No run shows a relying party that refuses a live token after its authority ends.',
      'No run challenges a claim of the Sourcing Agent.',
    ],
  },
  funding: [
    {
      wallet: 'fee', collateralLovelace: COLLATERAL, floatLovelace: 150_000_000n,
      items: [
        { what: 'Deposits of eight records', lovelace: 80_000_000n },
        { what: 'Fees of the registrations', lovelace: 4_000_000n },
        { what: 'Deposits of eight provenance and software attestations', lovelace: 40_000_000n },
        { what: 'Fees of the provenance and software attestations', lovelace: 2_720_000n },
        { what: 'Deposits of three compliance attestations', lovelace: 15_000_000n },
        { what: 'Fees of the compliance attestations, revoke and reply', lovelace: 1_820_000n },
        { what: 'Fee of the record revoke', lovelace: 500_000n },
        { what: 'Fees of the six lifecycle transactions', lovelace: 3_000_000n },
      ],
    },
    {
      wallet: 'sourcing-supplier', collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n,
      items: [...SUPPLIER_ITEMS, { what: 'Fees of about seven jobs', lovelace: 6_000_000n }],
    },
    ...DESKS.map((desk) => ({ wallet: desk.adverts[0].supplierKey, collateralLovelace: COLLATERAL, floatLovelace: 10_000_000n, items: DESK_SUPPLIER_ITEMS })),
    { wallet: 'sourcing-delegation-1', collateralLovelace: COLLATERAL, floatLovelace: 40_000_000n, items: DELEGATION_ITEMS },
    { wallet: 'sourcing-delegation-2', collateralLovelace: COLLATERAL, floatLovelace: 40_000_000n, items: DELEGATION_ITEMS },
    {
      wallet: SOURCING.serviceKey, collateralLovelace: COLLATERAL, floatLovelace: 250_000_000n,
      items: [
        ...SERVICE_ITEMS,
        { what: 'One challenge', lovelace: CLAIM_STAKE_LOVELACE },
        { what: 'Fees of the challenge', lovelace: 1_000_000n },
        { what: '34 model hires of 2.2 units each', lovelace: 74_800_000n },
      ],
    },
    ...DESKS.map((desk) => ({ wallet: desk.serviceKey, collateralLovelace: COLLATERAL, floatLovelace: 130_000_000n, items: DESK_SERVICE_ITEMS })),
  ],
  attestations: AGENTS.map(({ id }) => ({ agent: id, types: ['provenance', 'software'], format: 50, validDays: 365, envelope: null })),
  runs: [
    { id: 'clean', subject: 'GLV-NIT-M', tenantPrefix: 'bids-clean', vaultUnits: 10.3, perTxUnits: 3, totalUnits: 9 },
    { id: 'failure', subject: 'GLV-NIT-M', tenantPrefix: 'bids-failure', vaultUnits: 31.3, perTxUnits: 3, totalUnits: 30 },
    { id: 'lifecycle', subject: 'bid-desk-bravo', tenantPrefix: 'bids-lifecycle', vaultUnits: 0, perTxUnits: 0, totalUnits: 0 },
  ],
  evidenceSteps: [
    {
      id: 'r1-01', run: 'clean', actor: 'hirer', primitive: 'Delegation with a co-signature, vault',
      what: 'The hirer delegates to the Sourcing Agent. The agent co-signs. The hirer submits and opens a vault under the delegation.',
      proof: { refs: { delegation: 1, vault: 1, transaction: 2 } },
    },
    {
      id: 'r1-02', run: 'clean', actor: 'hirer', primitive: 'Escrow', what: 'The hirer hires `propose` with a request for quotation and weights.',
      proof: { refs: RESULT_REFS.hire },
    },
    {
      id: 'r1-03', run: 'clean', actor: 'agent', primitive: 'Marketplace list, catalog and status list reads, model call from the marketplace',
      what: 'The agent lists the bidders of the quote capability, reads the catalog and builds a file of facts for each bidder. A model decides the shortlist.',
      proof: { refs: { bidder: 3, escrow: 1 } },
    },
    {
      id: 'r1-04', run: 'clean', actor: 'counterparty', primitive: 'Vault payment, pre-claim check, model call, accept',
      what: 'The agent pays each of three Bid Desks from the vault, one after the other. Each Bid Desk checks the handoff before its claim, claims, and a model writes its quote. A model of the agent decides whether to accept each quote, and the agent accepts each.',
      proof: { refs: { escrow: 9, transaction: 6 } },
    },
    {
      id: 'r1-05', run: 'clean', actor: 'agent', primitive: 'Three sub-delegations, token exchange with the delegation chain, model call',
      what: 'The agent sub-delegates the vendor read to three scorers. Each scorer reads the vendor master with its own token. A model decides the ranking. The agent returns the ranking and its digest.',
      proof: { refs: { delegation: 3, transaction: 6, escrow: 1 }, projectedRoutes: [['GET /vendors', 'token', 'allowed', 2, 3, 200]] },
    },
    {
      id: 'r1-06', run: 'clean', actor: 'hirer', primitive: 'Attestation: approval', what: 'The hirer approves the digest of the ranking.',
      proof: { refs: RESULT_REFS.approval },
    },
    {
      id: 'r1-07', run: 'clean', actor: 'agent', primitive: 'Escrow, token for a route',
      what: 'The hirer hires `execute`. The agent writes the ranking to the sourcing record with a token. The record takes it.',
      proof: { refs: RESULT_REFS.hire, projectedRoutes: [['POST /sourcing/rankings', 'token', 'allowed', 1, 1, 201]] },
    },
    {
      id: 'r1-08', run: 'clean', actor: 'hirer', primitive: 'Vault close, undelegate', what: 'The hirer closes the vault and ends the delegation.',
      proof: { refs: RESULT_REFS.close },
    },
    {
      id: 'r2-a', run: 'failure', actor: 'agent', primitive: 'Module-1 challenge',
      what: 'Bid Desk Charlie runs with the fault `quote_off_price_list`. A model of the Sourcing Agent refuses its quote. The agent publishes the evidence and challenges the claim of Bid Desk Charlie.',
      proof: { refs: { escrow: 1, claim: 1, challenge: 1 } },
    },
    {
      id: 'r2-a-release', run: 'failure', actor: 'counterparty', primitive: 'Escrow: release',
      what: 'Check for a confirmed Release spend of the Bid Desk Charlie quote escrow.',
      proof: { refs: { escrow: 1, transaction: 1 }, settlement: { type: 'release', hireRole: 'quote' } },
    },
    {
      id: 'r2-a-hold', run: 'failure', actor: 'relay', primitive: 'Module-1 verdict and hold', what: 'The jury decides. Bid Desk Charlie gets a hold of 7 days, reason 64.',
      proof: { refs: RESULT_REFS.verdict },
    },
    {
      id: 'r2-b', run: 'failure', actor: 'operator', primitive: 'Attestation: revoke and reply',
      what: 'Before the hold starts, the compliance registry revokes its attestation about Bid Desk Charlie, and the controller publishes a reply. A new `propose` shows the revoked attestation and the hash of the reply in the file of Bid Desk Charlie.',
      proof: { refs: { attestation: 1, escrow: 1, transaction: 4 } },
    },
    {
      id: 'r2-c', run: 'failure', actor: 'agent', primitive: 'Proposal during a verified hold',
      what: 'Check which Bid Desks the signed proposal names during the hold.',
      proof: { refs: { escrow: 1, hold: 1, transaction: 2 } },
    },
    {
      id: 'r2-d', run: 'failure', actor: 'agent', primitive: 'Refusal by a system with no approval',
      what: 'The Sourcing Agent runs with the fault `invert_scores`. The hirer opens the quotes and does not approve. `execute` with no approval is refused by the sourcing record.',
      proof: { refs: RESULT_REFS.hire, projectedRoutes: [['POST /sourcing/rankings', 'token', 'refused', 1, 1, 403]] },
    },
    {
      id: 'r2-e', run: 'failure', actor: 'operator', primitive: 'Revoke of a record by a party',
      what: 'Record the transaction and the record output for Bid Desk Charlie.',
      proof: { refs: RESULT_REFS.record, recordFromTransaction: 'record' },
    },
    {
      id: 'l1-01', run: 'lifecycle', actor: 'operator', primitive: 'Change of the controller', what: 'The old and the new controller of Bid Desk Bravo change the controller.',
      proof: { refs: RESULT_REFS.record },
    },
    {
      id: 'l1-02', run: 'lifecycle', actor: 'operator', primitive: 'Recovery start', what: 'Both guardians and the next controller start a recovery.',
      proof: { refs: RESULT_REFS.record },
    },
    {
      id: 'l1-03', run: 'lifecycle', actor: 'operator', primitive: 'Waiting time of a recovery', what: 'The recovery waits 7 days. The tool refuses to build an earlier completion.',
      proof: { refs: RESULT_REFS.close, refusals: ['source-tool'] },
    },
    {
      id: 'l1-04', run: 'lifecycle', actor: 'operator', primitive: 'Recovery completion', what: 'After the 7 days the wallet completes the recovery. The new controller takes over.',
      proof: { refs: RESULT_REFS.record },
    },
    {
      id: 'l1-05', run: 'lifecycle', actor: 'operator', primitive: 'Retire of a record', what: 'The new controller retires the record. The deposit stays.',
      proof: { refs: RESULT_REFS.record },
    },
    {
      id: 'l1-06', run: 'lifecycle', actor: 'operator', primitive: 'Successor of an ended record',
      what: 'The controller of the retired record and the controller of the successor record name the successor.',
      proof: { refs: RESULT_REFS.record },
    },
    {
      id: 'l1-07', run: 'lifecycle', actor: 'operator', primitive: 'Reclaim of an ended record',
      what: 'The controller of the retired record takes back the deposit above the ledger minimum.',
      proof: { refs: RESULT_REFS.record },
    },
  ],
  results: {
    runPrefix: 'use-case-3',
    wording: {
      'Delegation with a co-signature, vault': {
        shows: 'The ledger records the co-signed delegation and the vault it authorizes.',
        doesNotShow: 'That the agent used or exhausted the vault limit.',
      },
      'Escrow': {
        shows: 'The evidence names the escrow for the hire.',
        doesNotShow: 'That the work met the request or that the buyer accepted it.',
      },
      'Marketplace list, catalog and status list reads, model call from the marketplace': {
        shows: 'The evidence links the bidder facts to the model call for the shortlist.',
        doesNotShow: 'That every possible bidder was listed or that the shortlist is optimal.',
      },
      'Vault payment, pre-claim check, model call, accept': {
        shows: 'The evidence links three vault-paid quote hires to the checks, model decisions and accept transactions.',
        doesNotShow: 'That the quotes were the best available or that the agents guarantee delivery.',
      },
      'Three sub-delegations, token exchange with the delegation chain, model call': {
        shows: 'The evidence links three distinct delegated reads to the proposal and the model call for the ranking.',
        doesNotShow: 'That the ranking is optimal or that this model repeats it.',
      },
      'Attestation: approval': RESULT_WORDING.approval,
      'Escrow, token for a route': {
        shows: 'The execute hire and the allowed token write are recorded for this ranking.',
        doesNotShow: 'That the write made an award in a real procurement system.',
      },
      'Vault close, undelegate': RESULT_WORDING.close,
      'Module-1 challenge': RESULT_WORDING.challenge,
      'Escrow: release': {
        shows: 'The evidence records a confirmed Release spend of this quote escrow.',
        doesNotShow: 'Who submitted the transaction or how much the supplier received.',
      },
      'Module-1 verdict and hold': RESULT_WORDING.verdict,
      'Attestation: revoke and reply': {
        shows: 'The attestation is revoked. The bidder facts record the hash of its reply.',
        doesNotShow: 'That the reply restores the attestation or that either party is right.',
      },
      'Proposal during a verified hold': {
        shows: 'The signed proposal during the hold names the other two Bid Desks and omits Bid Desk Charlie.',
        doesNotShow: 'Which adverts the marketplace listed at that time.',
      },
      'Refusal by a system with no approval': {
        shows: 'The mock system refused the write when the request had no approval.',
        doesNotShow: 'That the system would refuse a valid approval or check the ranking itself.',
      },
      'Revoke of a record by a party': {
        shows: 'The evidence names the transaction and its record output.',
        doesNotShow: 'Which party authorized the transaction, the reason, or when signatures became invalid.',
      },
      'Change of the controller': {
        shows: 'The record shows the new controller after the change transaction.',
        doesNotShow: 'That this controller can recover the record without the required guardians.',
      },
      'Recovery start': {
        shows: 'The recorded recovery start names the next controller and when recovery can complete.',
        doesNotShow: 'That the recovery has completed.',
      },
      'Waiting time of a recovery': {
        shows: 'The tool refused to build a completion before the recovery window opened.',
        doesNotShow: 'That the ledger refused a submitted completion. None was submitted early.',
      },
      'Recovery completion': {
        shows: 'The completion after the wait put the next controller in control.',
        doesNotShow: 'That a recovery can bypass the waiting period.',
      },
      'Retire of a record': {
        shows: 'The record became a tombstone. The retire transaction left its deposit.',
        doesNotShow: 'That this transaction set a successor or reclaimed the deposit.',
      },
      'Successor of an ended record': {
        shows: 'The tombstone names the successor record.',
        doesNotShow: 'That the successor inherits a claim, delegation or advert.',
      },
      'Reclaim of an ended record': {
        shows: 'The reclaim took the deposit above the ledger minimum and left the tombstone.',
        doesNotShow: 'That this operation returns funds from a hire escrow.',
      },
    },
  },
  moduleManifestPath: MODULE_MANIFEST_PATH,
  runtimeCommit: RUNTIME_COMMIT,
};

export default USE_CASE;
