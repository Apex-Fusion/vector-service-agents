// agents/insurer-intake-agent/src/job/completeness.ts
// The model decision of the Insurer Intake Agent, `completeness` (use case 2, prior authorization). The model reads the request and the requirement set of the insurer. It says whether the request meets every
// requirement, and it lists the id of each requirement that the request does not meet. This is an intake decision about the form of the request. It is no coverage decision, and the agent files the request
// whatever the model says: a request that is not complete is filed with the status `incomplete` and the ids that the model named.
//
// The decision has three parts: the fixed text of its prompt, the function that makes its input, and the parser of its choice. The fixed text is code. It holds no text of another party and no mark of the
// input block. The prompt rules of the decision folder of the kit already ask for one JSON object and nothing else, so the fixed text only says what the data holds and what shape `choice` has.
//
// What the model reads of another party: six members of the request (the reference of the clinician, the diagnosis codes, the justification, the two lists of references and the hash of the record set) and the
// requirement set. These are the members that the requirements talk about. The DID of the sender, the DID of the insurer, the advert reference, the patient reference, the tenant, the order id and the request
// number stay out, and so does everything that the checks of the hook and the report of the attestations found: the model decides from the request and the requirements only. The justification and the texts of
// the requirements are free text. They stand in the data block and nowhere else, and the kit writes the block so that no text in it can close it.
//
// A parser checks the SHAPE of a choice and the closed set of the requirement ids of one job. It returns the value that it was given, or a refusal: it never clamps, sorts, fills in or changes a value. It
// refuses an answer that contradicts itself: `complete` is true exactly when `missing` is empty. A refusal of the parser is `model_output_invalid` in the decision folder. The detail of a refusal names the
// place and never repeats a value that the model wrote.
import type { ChoiceParser, DecisionSpec } from '@vsa/usecase-kit/decision';
import type { PriorAuthRequest, RequirementSet } from '@vsa/usecase-kit/priorauth';
import { accepted, checkMembers, isPlainObject, refused } from '@vsa/usecase-kit/protocol';
import type { JsonValue } from '@vsa/usecase-kit/protocol';
import type { CompletenessChoice } from './ports.ts';

/** The name of the decision, as the intake record records it. */
export const COMPLETENESS_NAME = 'completeness';

const INSTRUCTION = [
  'You check the intake of one prior authorization request.',
  'This is an intake check of the form of the request.',
  'It is not a decision on coverage, and you do not judge whether the service is needed.',
  'The data has two members.',
  '"request" is the request: "ordering_clinician_ref" (the reference of the clinician who ordered the service), "diagnosis_codes" (a list of codes), "justification" (a text), "guideline_refs" (the criteria of the guideline that the justification cites), "record_refs" (the records that the justification cites) and "record_set_sha256" (the hash of the set of records that the request was written from).',
  '"requirements" is what the insurer needs in a request for this service: "service_code", "title" and "requirements" (a list).',
  'Each requirement has an "id" and a "text".',
  'Compare the request with each requirement.',
  'Use only the data that this message gives.',
  'A requirement is met when the request shows what its text asks for, and it is not met when the request does not show it.',
  '"choice" is an object with exactly two members: "complete" (true when the request meets every requirement, and false when it does not) and "missing" (a list of the "id" of each requirement that the request does not meet, each at most one time; the list is empty when "complete" is true, and it is not empty when "complete" is false).',
].join(' ');

/** The parser of one job: the shape of the choice, and the closed set of the requirement ids that the insurer gave. */
function completenessParser(known: ReadonlySet<string>): ChoiceParser<CompletenessChoice> {
  return (given) => {
    if (!isPlainObject(given)) return refused('bad_shape', 'choice must be a JSON object');
    const members = checkMembers(given, 'choice', ['complete', 'missing']);
    if (members !== null) return members;
    const { complete, missing } = given;
    if (typeof complete !== 'boolean') return refused('bad_shape', 'choice.complete must be true or false');
    if (!Array.isArray(missing)) return refused('bad_shape', 'choice.missing must be a list');
    const seen = new Set<string>();
    for (const [index, entry] of missing.entries()) {
      if (typeof entry !== 'string') return refused('bad_shape', `choice.missing[${index}] must be a text`);
      if (!known.has(entry)) return refused('bad_shape', `choice.missing[${index}] must be the id of a requirement of the set`);
      if (seen.has(entry)) return refused('bad_shape', `choice.missing[${index}] is in the list two times`);
      seen.add(entry);
    }
    if (complete && missing.length > 0) return refused('bad_shape', 'choice.complete is true, and choice.missing is not empty');
    if (!complete && missing.length === 0) return refused('bad_shape', 'choice.complete is false, and choice.missing is empty');
    // The members are checked, and the value that the model gave goes back as it is.
    return accepted(given as CompletenessChoice);
  };
}

/**
 * The decision `completeness` for one job. `requirementIds` are the ids of the requirement set that the insurer gave for the service of the request: they are the closed set of the parser. The decision is
 * made for each call, because the set belongs to one job. The list is copied, so a later change of the list does not change the decision. A value that is not a list of texts is a mistake of the caller: a
 * text would give a set of its letters, and nothing would give an empty set. It is a `TypeError`.
 */
export function completenessDecision(requirementIds: readonly string[]): DecisionSpec<CompletenessChoice> {
  if (!Array.isArray(requirementIds) || !requirementIds.every((id) => typeof id === 'string')) throw new TypeError('completenessDecision: requirementIds must be a list of texts');
  return Object.freeze({ name: COMPLETENESS_NAME, instruction: INSTRUCTION, parse: completenessParser(new Set<string>(requirementIds)) });
}

/**
 * The input of `completeness`: six members of the request and the requirement set. The members are copied by name, in this order, so no other member of the request reaches the prompt, and a change of the
 * input cannot change the request or the set of the job. See the head of this file for what stays out.
 */
export function completenessInput(request: PriorAuthRequest, requirements: RequirementSet): JsonValue {
  return {
    request: {
      ordering_clinician_ref: request.ordering_clinician_ref,
      diagnosis_codes: [...request.diagnosis_codes],
      justification: request.justification,
      guideline_refs: [...request.guideline_refs],
      record_refs: [...request.record_refs],
      record_set_sha256: request.record_set_sha256,
    },
    requirements: {
      service_code: requirements.service_code,
      title: requirements.title,
      requirements: requirements.requirements.map((requirement) => ({ id: requirement.id, text: requirement.text })),
    },
  };
}
