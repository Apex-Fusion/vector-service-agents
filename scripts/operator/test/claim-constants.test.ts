// scripts/operator/test/claim-constants.test.ts - holds the claim constants of the operator pack to the public files that state the same numbers: the example environments (the stake of a
// challenge), the copy of the Module-1 manifest (the least stake and the window limits), the kit (the byte limit of a claim type), the data of use case 1, and the pages of the two agents.
// The check of the pages is a function that gives its problems. One test shows that the real pages have none. Other tests show that a page that states another number has the problem.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVENTORY_CAPABILITIES, MAX_CLAIM_TYPE_BYTES, module1FromManifest, readManifest } from '../lib/platform.ts';
import { CHALLENGE_RESERVE_LOVELACE, CLAIM_STAKE_LOVELACE, CLAIM_WINDOW_MS, RUN_APPROVAL_VALIDITY_MS, claimTypeOf } from '../lib/claim-constants.ts';
import data from '../usecases/inventory-reorder.ts';

const UNIT = 1_000_000n;
const HOUR_MS = 3_600_000;
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (path: string): string => readFileSync(`${ROOT}${path}`, 'utf8');

/** The value of a variable line of an env example. The file must have exactly one such line. */
function exampleValue(file: string, name: string): string {
  const lines = read(`deploy/server/${file}`).split('\n').filter((row) => row.startsWith(`${name}=`));
  if (lines.length !== 1) throw new Error(`${file} must have exactly one line ${name}`);
  return lines[0].slice(name.length + 1);
}

const EXAMPLES = ['.env.reorder-agent.example', '.env.order-desk.example'] as const;
const CHALLENGE_STAKES = EXAMPLES.map((file) => BigInt(exampleValue(file, 'DISPUTE_CHALLENGE_STAKE_LOVELACE')));

// The copy of the published Module-1 manifest that the fixtures of buyer-core keep, read with the reader of buyer-core.
const MANIFEST_FILE = `${ROOT}packages/buyer-core/test/fixtures/module1-mainnet-manifest.json`;
const MODULE1 = module1FromManifest(await readManifest(MANIFEST_FILE, 'The copy of the Module-1 manifest'), MANIFEST_FILE);

// ---- the pages ----

/** The numbers of a run as a page writes them. They come from the constants, so a constant that changes makes the sentences below change. */
const STAKE_UNITS = CLAIM_STAKE_LOVELACE / UNIT;
const WINDOW_HOURS = CLAIM_WINDOW_MS / HOUR_MS;
const APPROVAL_HOURS = RUN_APPROVAL_VALIDITY_MS / HOUR_MS;

interface PageSentence { readonly page: string; readonly what: string; readonly text: string }

/** The sentences that state the claim and the approval of a run, each with the page that holds it. */
const SENTENCES: readonly PageSentence[] = [
  {
    page: 'specs/reorder-agent.md', what: 'the claim of the Reorder Agent',
    text: `an operator command stakes one claim with the service key of the agent: ${STAKE_UNITS} units, with a challenge window of ${WINDOW_HOURS} hours.`,
  },
  { page: 'specs/reorder-agent.md', what: 'the approval of a run', text: `The runs use ${APPROVAL_HOURS} hours.` },
  {
    page: 'specs/order-desk.md', what: 'the claim of the Order Desk in the table',
    text: `an operator command stakes the claim with the service key: ${STAKE_UNITS} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${WINDOW_HOURS} hours.`,
  },
  {
    page: 'specs/order-desk.md', what: 'the claim of the Order Desk in its section',
    text: `an operator command stakes a Module-1 claim for the agent with the service key: ${STAKE_UNITS} units, which is ${CLAIM_STAKE_LOVELACE} lovelace, with a challenge window of ${WINDOW_HOURS} hours.`,
  },
];

/** The problems of a set of pages: each sentence that its page does not hold. `pages` maps the path of a page to its text. */
function pageProblems(pages: Readonly<Record<string, string>>): string[] {
  return SENTENCES.filter(({ page, text }) => !(pages[page] ?? '').includes(text)).map(({ page, what }) => `${page} does not state ${what} with the numbers of the constants`);
}

const PAGES: Readonly<Record<string, string>> = Object.fromEntries([...new Set(SENTENCES.map(({ page }) => page))].map((page) => [page, read(page)]));

describe('the claim constants', () => {
  it('hold the numbers of a run: a claim of 50 units, a window of 24 hours, an approval of 4 hours, and a reserve of 53 units for a challenge', () => {
    expect(CLAIM_STAKE_LOVELACE).toBe(50_000_000n);
    expect(CLAIM_WINDOW_MS).toBe(24 * HOUR_MS);
    expect(RUN_APPROVAL_VALIDITY_MS).toBe(4 * HOUR_MS);
    expect(CHALLENGE_RESERVE_LOVELACE).toBe(53_000_000n);
  });

  it('hold the stake of a claim to the stake of a challenge in both example environments: a challenge targets a claim whose stake is not above it, and an equal stake is a target', () => {
    expect(CHALLENGE_STAKES).toHaveLength(2);
    for (const challenge of CHALLENGE_STAKES) {
      expect(CLAIM_STAKE_LOVELACE).toBe(challenge);
      expect(CLAIM_STAKE_LOVELACE <= challenge).toBe(true);
    }
  });

  it('hold the stake of a claim to the least claim that the Module-1 manifest takes', () => {
    expect(CLAIM_STAKE_LOVELACE >= MODULE1.protocol.minClaimStake).toBe(true);
  });

  it('keep for the Reorder Agent the stake of its challenge in the example environment, and 3 units for the evidence document and the fees of the challenge', () => {
    expect(CHALLENGE_RESERVE_LOVELACE).toBe(BigInt(exampleValue('.env.reorder-agent.example', 'DISPUTE_CHALLENGE_STAKE_LOVELACE')) + 3_000_000n);
  });

  it('hold the window to 30 minutes and 24 hours, and to the window limits of the Module-1 manifest', () => {
    expect(CLAIM_WINDOW_MS >= 1_800_000 && CLAIM_WINDOW_MS <= 86_400_000).toBe(true);
    expect(CLAIM_WINDOW_MS >= MODULE1.protocol.minChallengeWindow && CLAIM_WINDOW_MS <= MODULE1.protocol.maxChallengeWindow).toBe(true);
  });

  it('give the capability id of an agent as its claim type, and a claim type of both agents is at most the byte limit of the kit', () => {
    for (const capability of [INVENTORY_CAPABILITIES.reorder, INVENTORY_CAPABILITIES.order]) {
      expect(claimTypeOf(capability)).toBe(capability);
      expect(Buffer.byteLength(claimTypeOf(capability), 'utf8')).toBeGreaterThan(0);
      expect(Buffer.byteLength(claimTypeOf(capability), 'utf8')).toBeLessThanOrEqual(MAX_CLAIM_TYPE_BYTES);
    }
  });
});

describe('the data of use case 1', () => {
  it('uses the constants for the claim of each agent: the stake, the window and the claim type', () => {
    expect(data.agents.map((agent) => agent.id)).toEqual(['reorder-agent', 'order-desk']);
    for (const agent of data.agents) {
      expect(agent.claim, agent.id).toEqual({ stakeLovelace: CLAIM_STAKE_LOVELACE, windowMs: CLAIM_WINDOW_MS, claimType: claimTypeOf(agent.capability) });
    }
  });

  it('funds the service wallet of each agent with two claims in flight at the stake of the constants', () => {
    for (const agent of data.agents) {
      const line = data.funding.find((entry) => entry.wallet === agent.serviceKey);
      const items = (line?.items ?? []).filter((item) => /claims in flight/i.test(item.what));
      expect(items.map((item) => item.lovelace), agent.id).toEqual([2n * CLAIM_STAKE_LOVELACE]);
    }
  });
});

describe('the pages of the two agents', () => {
  it('state the claim and the approval of a run with the numbers of the constants', () => {
    expect(pageProblems(PAGES)).toEqual([]);
  });

  it('are held to the constants: a page that states another stake, another window or another approval has a problem', () => {
    const order = PAGES['specs/order-desk.md'];
    const reorder = PAGES['specs/reorder-agent.md'];
    expect(pageProblems({ ...PAGES, 'specs/order-desk.md': order.replaceAll(`${STAKE_UNITS} units, which is ${CLAIM_STAKE_LOVELACE} lovelace`, `${STAKE_UNITS + 1n} units, which is ${CLAIM_STAKE_LOVELACE + UNIT} lovelace`) })).toEqual([
      'specs/order-desk.md does not state the claim of the Order Desk in the table with the numbers of the constants',
      'specs/order-desk.md does not state the claim of the Order Desk in its section with the numbers of the constants',
    ]);
    expect(pageProblems({ ...PAGES, 'specs/reorder-agent.md': reorder.replaceAll(`with a challenge window of ${WINDOW_HOURS} hours`, `with a challenge window of ${WINDOW_HOURS + 1} hours`) })).toEqual([
      'specs/reorder-agent.md does not state the claim of the Reorder Agent with the numbers of the constants',
    ]);
    expect(pageProblems({ ...PAGES, 'specs/reorder-agent.md': reorder.replaceAll(`The runs use ${APPROVAL_HOURS} hours.`, `The runs use ${APPROVAL_HOURS * 2} hours.`) })).toEqual([
      'specs/reorder-agent.md does not state the approval of a run with the numbers of the constants',
    ]);
  });

  it('are found only when they are read: a missing page has every problem of its sentences', () => {
    expect(pageProblems({})).toHaveLength(SENTENCES.length);
  });
});
