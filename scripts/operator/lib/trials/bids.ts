import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PreconditionError } from '../../../checks/lib/session.ts';
import {
  QUOTE_CHECKS, QUOTE_SCHEMA, lineChecks, parsePriceList, parseQuote, parseRfqDocument, priceFor, priceListSha256, quotePriceFacts, quoteTotals, rfqSha256,
} from '../../../../packages/usecase-kit/src/bids/index.ts';
import { claimFile, evidenceFile, jsonFile, requireBuilt, sampleDecision, trialAgent, trialSubjects } from './shared.ts';
import type { TrialBuilder, TrialCase } from './shared.ts';

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function readPriceList(instance: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(instance)) throw new PreconditionError('the Bid Desk organisation ID is not a price list file name');
  let text: string;
  let json: unknown;
  try {
    text = UTF8.decode(readFileSync(new URL(`../../../../agents/bid-desk/price-lists/${instance}.json`, import.meta.url)));
    json = JSON.parse(text);
  } catch {
    throw new PreconditionError(`cannot read the published price list for ${instance} as UTF-8 JSON`);
  }
  return { list: requireBuilt(parsePriceList(json), 'published price list'), text, sha256: priceListSha256(text) };
}

export const bidTrial: TrialBuilder = (use, facts) => {
  const sourcing = trialAgent(use, facts, 'sourcing-agent', '7a', '7b');
  const desk = trialAgent(use, facts, 'bid-desk', '7c', '7d');
  // The deploy pack uses the organisation ID as BID_DESK_INSTANCE.
  const { list, text: listText, sha256: listSha } = readPriceList(desk.organisation.id);
  const rfq = requireBuilt(parseRfqDocument({
    rfq_id: 'RFQ-TRIAL-1', needed_by: '2026-12-31',
    items: [{ sku: 'GLV-NIT-M', quantity: 100 }, { sku: 'SYR-10ML', quantity: 100 }, { sku: 'MSK-N95', quantity: 100 }],
  }), 'sample request for quotation');
  const rfqSha = requireBuilt(rfqSha256(rfq), 'hash of the sample request for quotation');
  const listed = rfq.items.map((item) => {
    const price = priceFor(list, item.sku, item.quantity);
    if (price === null) throw new PreconditionError(`the sample price list gives no price for ${item.sku} at ${item.quantity}`);
    return { ...item, ...price };
  });
  const first = listed[0]!;
  const other = priceFor(list, first.sku, 500);
  if (other === null) throw new PreconditionError(`the sample price list gives no price for ${first.sku} at the other quantity break`);

  const prices = [
    ['price-above-list', first.unit_price + 1],
    ['price-below-list', first.unit_price - 1],
    ['price-of-another-break', other.unit_price],
  ] as const;
  const cases: TrialCase[] = prices.map(([name, unitPrice]) => {
    const priceList = { file: `${name}.price-list.json`, text: listText, juror: null };
    const lines = [{ ...first, unit_price: unitPrice }, ...listed.slice(1)];
    const totals = quoteTotals(lines);
    if (totals === null) throw new PreconditionError(`the case ${name} has invalid quote lines`);
    const notes = 'This quote is a sample for a test of the jury.';
    const validUntil = '2026-12-30';
    const quote = requireBuilt(parseQuote({
      schema: QUOTE_SCHEMA, outcome: 'done', rfq_id: rfq.rfq_id, rfq_sha256: rfqSha, desk_did: desk.claim.agent_did, organisation: desk.organisation.domain,
      ...totals, valid_until: validUntil, notes, price_list_sha256: listSha, credential: 'sample.sample.sample',
      sender: { did: sourcing.claim.agent_did, organisation: sourcing.organisation.domain, organisation_verified: true },
      checks: Object.fromEntries(QUOTE_CHECKS.map((check) => [check, true])),
      decisions: [sampleDecision('quote', { lines, valid_until: validUntil, notes }, 'The quote covers all three items.')], fault_mode: '',
    }), `sample quote of the case ${name}`);
    const quoteFile = jsonFile(`${name}.quote.json`, quote);
    const price = requireBuilt(quotePriceFacts({
      line: lineChecks(quote, list)[0]!, price_list_sha256: listSha, quote_sha256: createHash('sha256').update(quoteFile.text, 'utf8').digest('hex'),
    }), `price evidence of the case ${name}`);
    return {
      name, fields: { kind: price.kind, claimer: desk.id, challenger: sourcing.id },
      files: [claimFile(name, desk), evidenceFile(name, desk, sourcing, price), jsonFile(`${name}.rfq.json`, rfq), priceList, quoteFile],
    };
  });
  cases.push({ name: 'sourcing-claim', fields: { kind: null, claimer: sourcing.id }, files: [claimFile('sourcing-claim', sourcing)] });
  return { ...trialSubjects(sourcing, desk), cases };
};
