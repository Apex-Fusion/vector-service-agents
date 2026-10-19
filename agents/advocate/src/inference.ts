// agents/advocate/src/inference.ts
// The model call of a job (rulings R-F3, R-F4, R-F7 and R-F8): bought first from a chat supplier on the Vector marketplace, and made through OpenRouter only
// when that hire fails. The prompt is the one of src/prompt.ts, the same for both paths: on the marketplace it is one input string, the system prompt, a blank
// line and the user message (marketplaceInput), the body {input} and nothing else, every character of it committed in the prompt_hash of the escrow.
//
// The marketplace path, with the hire of packages/hire-kit: the choice of an allowlisted chat supplier at a price at or under the ceiling, its advert read and
// checked on chain (15 s, three candidates at most, within 25 s); the float of the buyer wallet, read within 10 s, which must hold a collateral output and,
// outside it, the lock the advert plans and the fees of a Post and an Accept; then the hire itself: the Post, recorded in the stranded store, the send, the
// polls, the seven checks of the receipt, and the Accept. Its waits stop at the hop deadline, its first send too, and its reads of the receipt hash at
// receiptByMs (src/budget.ts). Only then is the answer read as a brief (R-F3): the receipt commits to the supplier's output, not to its being a brief, and an
// escrow that is Submitted cannot be reclaimed, so a verified answer is accepted first and read after.
//
// The fallback rule (R-F4). The job falls back to OpenRouter whenever the hire leaves no answer it could still verify and accept: no supplier, a float that
// is short, a Post that failed, a send, a poll or a receipt that failed, the hop deadline reached, and a settled answer that is cut (llm_incomplete) or is
// not a brief (model_output_invalid), whose sub-job the result still carries. It never falls back after a verified answer that is a brief, after an Accept that
// could not be made (llm_accept_failed: the job fails inference_failed, 502), after a write of the stranded store that failed (store_write_failed, 500, the
// escrow named in the log; the marketplace path is then off until the service restarts, so that no later job posts what it cannot record), nor for a caller
// that has hung up. A marketplace brief whose every claim the check drops is no_supported_claims (src/run.ts): that brief was the answer of the job.
//
// The caller's signal (R-F7). The hire never sees it: a hire that commits value runs to its own end. The signal is looked at before the Post, so that nothing is
// posted for a caller who has gone, and after the hop, so that a caller who hung up during it gets aborted (499) once the hop has ended on its own terms,
// verified and accepted or failed and recorded for the janitor; the call through OpenRouter carries it as before. A store write that failed stays 500 whatever
// the caller did, so that the log names the escrow.
//
// The log (R-F8). A line about the hop carries its code and its stage and nothing else: `inference: marketplace <code> at <stage>, falling back` or
// `..., not falling back`. The messages of the kit can hold the words of a supplier, and none of them reaches a line or a detail of this file. The kit's own
// lines through `log` (the supplier chosen, a store entry it could not remove) carry references, a price and a host, and are let through.
import { OutOfTime, within } from '@vsa/service-kit';
import type { Chain } from '@vsa/buyer-core';
import { chatJob, chooseChatSupplier, hireOne, plannedLockOf, subJobFloat } from '@vsa/hire-kit';
import type { HireErrors, HireFacts, HireLedger, HireRecord, HireStage, HireSupplier, Hired, StrandedStore } from '@vsa/hire-kit';
import { CHOICE_BUDGET_MS, CHOICE_MAX_CANDIDATES, CHOICE_WITHIN_MS, HOP_MIN_MS, WALLET_READ_MS, hopDeadlineMs, modelBudgetMs, receiptByMs } from './budget.ts';
import { AdvocateError } from './errors.ts';
import { callModel, parseBriefAnswer } from './model.ts';
import type { ModelBrief, Usage } from './model.ts';
import type { Page } from './pages.ts';
import { SHAPES, messagesFor } from './prompt.ts';
import type { ChatMessage } from './prompt.ts';
import type { AdvocateRequest } from './request.ts';

export type InferencePath = 'marketplace' | 'openrouter';

export interface InferenceDeps {
  chain: Chain; stranded: StrandedStore; fetchImpl: typeof fetch; clock: () => number; sleep: (ms: number) => Promise<void>;
  /** The chat models the service hires (LLM_MODEL_ALLOWLIST), the most an advert may be priced at (LLM_MAX_PRICE_LOVELACE), and the marketplace indexer. */
  allowlist: readonly string[]; maxPriceLovelace: bigint; indexerUrl?: string;
  /** The key hash of the buyer key, which the lock of a Post is planned with. */
  buyerPkh: string;
  /** The fallback: the key of OpenRouter and its model (OPENROUTER_API_KEY, OPENROUTER_MODEL). */
  openRouterApiKey: string; openRouterModel: string;
  /** Whether the marketplace path is open: set off for the life of the process once a write of the stranded store has failed. */
  marketplace: { on: boolean };
  deadlineMs: number; signal?: AbortSignal; log: (line: string) => void;
}

export interface Inference {
  brief: ModelBrief;
  usage: Usage | null;
  path: InferencePath;
  /** The model of the advert hired on the marketplace path (the receipt names it), OPENROUTER_MODEL on the fallback. */
  model: string;
  /** The sub-job of the chat supplier when one was settled: on the marketplace path, and on a fallback after an answer that was settled and is no brief. */
  subJob: HireRecord | null;
  accepted: 'confirmed' | 'pending' | null;
  /** The code that sent the job to OpenRouter; null on the marketplace path. */
  fallbackFrom: string | null;
}

/** The input of the chat job: the system prompt, a blank line, the user message. */
export function marketplaceInput(messages: readonly [ChatMessage, ChatMessage]): string {
  return `${messages[0].content}\n\n${messages[1].content}`;
}

/**
 * The detail of a failed hire, for the log at 500 and 502: its code, its stage and its escrow, never the words of the kit or of a supplier. A store that
 * could not mark an Accept sent and not seen confirmed leaves a Submitted escrow, which cannot be reclaimed: if that Accept does not land, the escrow must
 * be accepted by hand within 600 s of its Submit, after which its supplier may release it, so its detail says that and not the deliver_by of a Post.
 */
function hopDetail(hopCode: string, facts: HireFacts | null): string {
  const at = facts === null ? '' : ` at ${facts.stage}`;
  const ref = facts?.escrowRef ?? null;
  if (hopCode === 'store_write_failed' && facts?.stage === 'accept') {
    return `the stranded store could not mark the Accept of the chat sub-job at accept: its escrow ${ref} stays recorded as Submitted, and its Accept may still land; read it on chain now and, if it is still Submitted once that Accept can no longer land, accept it by hand within 600 s of its Submit, after which its supplier may release it; restart the service, whose marketplace path is off until then`;
  }
  if (hopCode === 'store_write_failed') {
    return `the stranded store could not be written for the chat sub-job${at}: settle its escrow ${ref ?? '(none)'} by hand once its deliver_by has passed, and restart the service, whose marketplace path is off until then`;
  }
  return `the chat sub-job ended with ${hopCode}${at}; ${ref === null ? 'nothing was locked for it' : `its escrow ${ref} stays recorded for the janitor`}`;
}

/** A failure of the hire of the chat supplier: the code of the hire (`llm_<what>`, `llm_out_of_time`, `llm_supplier_unavailable`, `insufficient_float`, `store_write_failed`) and what the kit knew. */
export class HopFailed extends AdvocateError {
  readonly hopCode: string;
  readonly facts: HireFacts | null;
  constructor(hopCode: string, facts: HireFacts | null) {
    super(hopCode === 'store_write_failed' ? 'store_write_failed' : 'inference_failed', hopDetail(hopCode, facts));
    this.name = 'HopFailed';
    this.hopCode = hopCode;
    this.facts = facts;
  }
}

/** The errors the kit makes for Advocate: every one a HopFailed; the deadline of the hop is llm_out_of_time. The kit's message is not kept (R-F8). */
export const ADVOCATE_HOP_ERRORS: HireErrors<HopFailed> = {
  failure: (kind, what, _message, facts) => new HopFailed(`${kind}_${what}`, facts),
  deadline: (_doing, facts) => new HopFailed('llm_out_of_time', facts),
  storeWrite: (_message, facts) => new HopFailed('store_write_failed', facts),
};

/** The codes of a hire after which the job does not fall back (R-F4): the Accept could not be made, or the store could not be written. */
const NO_FALLBACK: ReadonlySet<string> = new Set(['llm_accept_failed', 'store_write_failed']);
/** The code of a job that goes to OpenRouter because the marketplace path is off. */
const MARKETPLACE_OFF = 'marketplace_off';
/** What the job is, in the words of the kit. */
const BRIEF_LABEL = 'the brief';
/** The stage of a line about the hop: the kit's stages, and the steps of this file before and after the hire. */
type Stage = HireStage | 'start' | 'choice' | 'float' | 'brief';
/** The hire's lock and fees are not added up: the result names the sub-job, and the escrow is on the ledger. */
const UNCOUNTED: HireLedger = { posted: () => undefined, accepted: () => undefined };

const abandoned = (): AdvocateError => new AdvocateError('aborted', 'the caller hung up, and the job was stopped');
const stopIfAbandoned = (signal: AbortSignal | undefined): void => { if (signal?.aborted === true) throw abandoned(); };
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** The tokens a receipt names, when both counts are whole numbers of 0 or more; null otherwise. */
function usageOf(receipt: Record<string, unknown>): Usage | null {
  const { prompt_tokens: prompt, completion_tokens: completion } = receipt;
  return isCount(prompt) && isCount(completion) ? { prompt_tokens: prompt, completion_tokens: completion } : null;
}

/** Why the job goes to OpenRouter, and the sub-job it settled on the way, if any. */
interface Fallback { fallbackFrom: string; subJob: HireRecord | null; accepted: 'confirmed' | 'pending' | null }

/** The brief of a job: from a chat supplier on the marketplace, or through OpenRouter when that hire fails (see the head of this file). */
export async function infer(req: AdvocateRequest, pages: readonly Page[], deps: InferenceDeps): Promise<Inference> {
  const messages = messagesFor(req, pages);
  const tried = await viaMarketplace(marketplaceInput(messages), deps);
  if ('brief' in tried) return tried;
  return viaOpenRouter(req, messages, tried, deps);
}

async function viaMarketplace(input: string, deps: InferenceDeps): Promise<Inference | Fallback> {
  const { clock, log, signal } = deps;
  const hopDeadline = hopDeadlineMs(deps.deadlineMs);
  const fallBack = (code: string, stage: Stage, settled?: { subJob: HireRecord; accepted: 'confirmed' | 'pending' }): Fallback => {
    log(`inference: marketplace ${code} at ${stage}, falling back`);
    return { fallbackFrom: code, subJob: settled?.subJob ?? null, accepted: settled?.accepted ?? null };
  };
  if (!deps.marketplace.on) return fallBack(MARKETPLACE_OFF, 'start');
  if (hopDeadline - clock() < HOP_MIN_MS) return fallBack('llm_out_of_time', 'start');

  // The choice: within 25 s, for chain.readAdvert has no time limit of its own. Nothing is locked yet, so whatever ends it falls back.
  let supplier: HireSupplier;
  try {
    supplier = await within(chooseChatSupplier(deps.chain, {
      fetchImpl: deps.fetchImpl, indexerUrl: deps.indexerUrl, allowlist: deps.allowlist, maxPriceLovelace: deps.maxPriceLovelace, ceilingSetting: 'LLM_MAX_PRICE_LOVELACE',
      budgetMs: CHOICE_BUDGET_MS, maxCandidates: CHOICE_MAX_CANDIDATES, log,
    }, () => new HopFailed('llm_supplier_unavailable', null)), CHOICE_WITHIN_MS);
  } catch (error) {
    if (error instanceof HopFailed || error instanceof OutOfTime) return fallBack('llm_supplier_unavailable', 'choice');
    throw error;
  }

  // The float: a fresh read of the wallet, its collateral output, and the lock of this advert and two fees outside it.
  let wallet: Awaited<ReturnType<Chain['wallet']>>;
  try { wallet = await within(deps.chain.wallet(), WALLET_READ_MS); } catch { return fallBack('insufficient_float', 'float'); }
  let lock: bigint;
  try { lock = plannedLockOf(supplier, deps.buyerPkh, Math.floor(clock())); } catch { return fallBack('llm_supplier_unavailable', 'float'); }
  if (wallet.collateralLovelace === null || wallet.floatLovelace < subJobFloat(lock)) return fallBack('insufficient_float', 'float');
  if (hopDeadline - clock() < HOP_MIN_MS) return fallBack('llm_out_of_time', 'post');
  // Nothing is posted for a caller who has gone.
  stopIfAbandoned(signal);

  let hired: Hired<{ text: string; status: unknown }>;
  try {
    hired = await hireOne(
      { chain: deps.chain, stranded: deps.stranded, clock, sleep: deps.sleep, deadlineMs: hopDeadline, log },
      supplier, chatJob(supplier.endpoint, input, BRIEF_LABEL, deps.fetchImpl), UNCOUNTED, ADVOCATE_HOP_ERRORS,
      { firstSendBy: hopDeadline, receiptBy: receiptByMs(deps.deadlineMs) },
    );
  } catch (error) {
    if (!(error instanceof HopFailed)) throw error;
    const stage = error.facts?.stage ?? 'post';
    if (error.hopCode === 'store_write_failed') {
      deps.marketplace.on = false;
      log(`inference: marketplace store_write_failed at ${stage}, not falling back`);
      throw error;
    }
    if (NO_FALLBACK.has(error.hopCode) || signal?.aborted === true) {
      log(`inference: marketplace ${error.hopCode} at ${stage}, not falling back`);
      stopIfAbandoned(signal);
      throw error;
    }
    return fallBack(error.hopCode, stage);
  }
  // The hop has ended on its own terms: a caller who hung up during it gets aborted now.
  stopIfAbandoned(signal);
  const { text, status } = hired.value;
  const settled = { subJob: hired.record, accepted: hired.accepted };
  // A cut answer, or one that is not a brief, was verified and accepted all the same, since the supplier delivered (R-F3).
  if (status !== 'completed') return fallBack('llm_incomplete', 'brief', settled);
  let brief: ModelBrief;
  try {
    brief = parseBriefAnswer(text);
  } catch (error) {
    if (error instanceof AdvocateError && error.code === 'model_output_invalid') return fallBack('model_output_invalid', 'brief', settled);
    throw error;
  }
  return { brief, usage: usageOf(hired.record.receipt), path: 'marketplace', model: supplier.model, subJob: hired.record, accepted: hired.accepted, fallbackFrom: null };
}

/** The fallback: one call through OpenRouter in the time the job has left, as the model phase was before the marketplace (rulings R-E5, R-E19). */
async function viaOpenRouter(req: AdvocateRequest, messages: [ChatMessage, ChatMessage], fallback: Fallback, deps: InferenceDeps): Promise<Inference> {
  stopIfAbandoned(deps.signal);
  // The time left is floored to whole milliseconds, for AbortSignal.timeout takes no fraction of one, which a clock that reads fractions would give it.
  const left = Math.floor(deps.deadlineMs - deps.clock());
  const budget = modelBudgetMs(left);
  if (budget === null) throw new AdvocateError('deadline', `the job had ${left} ms of its time left for the model, too little to start it`);
  const { content, usage } = await callModel(messages, {
    fetchImpl: deps.fetchImpl, apiKey: deps.openRouterApiKey, model: deps.openRouterModel, maxTokens: SHAPES[req.length].maxTokens, timeoutMs: budget, signal: deps.signal,
    log: deps.log,
  });
  stopIfAbandoned(deps.signal);
  return {
    brief: parseBriefAnswer(content), usage, path: 'openrouter', model: deps.openRouterModel, subJob: fallback.subJob, accepted: fallback.accepted,
    fallbackFrom: fallback.fallbackFrom,
  };
}
