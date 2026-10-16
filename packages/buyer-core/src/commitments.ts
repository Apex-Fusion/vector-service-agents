// packages/buyer-core/src/commitments.ts
// The commitments of a fleet job: prompt_hash (in the escrow datum) and response_hash (in the signed receipt), computed the way the fleet suppliers
// compute them (Apex-Fusion/agents-marketplace at e847a55, see VENDORED-FROM.md):
//   OCR        prompt_hash   = sha256(canonicalize({image_b64, mime, output_format}))      packages/shared/src/tx/escrow/postOcrEscrow.ts, ocrPromptHash
//              response_hash = sha256(canonicalize({content, output_format}))              supplier/src/jobRunner.ts, runOcrJob
//   Responses  prompt_hash   = sha256(canonicalize(responseRequestCommitment(normalizeResponseRequest(body))))     supplier/src/server.ts
//              response_hash = sha256(canonicalize(responseResultCommitment(response)))    supplier/src/jobRunner.ts, runChatJob
// canonicalize is the one of @vsa/vector-read (sorted keys, NFC strings, no whitespace), the same function as the fleet one but for one case: an own
// `__proto__` key. canonicalize assigns every key into a new object, and that assignment sets the prototype instead, so the key is dropped where the
// fleet's canonicalize keeps it. It cannot matter for the Pipeline: the prompt of its chat job is a string, and ruling R43 refuses an extraction schema
// with such a key, so none of its own values carries one. The Responses hashes compose the vendored src/vendored/fleet/responses.ts and never
// re-implement it. The two OCR hashes are three-line functions of canonicalize, written here field by field as the fleet writes them: a hash covers
// the named fields and nothing else.
import { canonicalize, sha256Utf8Hex } from '@vsa/vector-read';
import { normalizeResponseOutput, normalizeResponseRequest, responseOutputText, responseRequestCommitment, responseResultCommitment } from './vendored/fleet/responses.ts';
import type { ResponseObject } from './vendored/fleet/responses.ts';

export { requestSpecHash } from '@vsa/vector-read';

/**
 * `value` as the vendored fleet helpers take a response. The one check is that it is a JSON object: not null, not an array, not a primitive (a value that is
 * not is refused with "response must be an object"). Its fields are not looked at here.
 */
function asResponseObject(value: unknown): ResponseObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('response must be an object');
  return value as ResponseObject;
}

/** A commitment: the sha256 of the canonical JSON of `value`, the form of every hash of this file. */
const commit = (value: unknown): string => sha256Utf8Hex(canonicalize(value));

/** The prompt_hash of an OCR page job: the base64 string exactly as it is sent in the POST body, its mime type and the requested output format. */
export function ocrPromptHash(req: { image_b64: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; output_format: 'markdown' | 'html' | 'json' }): string {
  return commit({ image_b64: req.image_b64, mime: req.mime, output_format: req.output_format });
}

/**
 * The response_hash of an OCR page job: the extracted text and the output format it was requested in. The poll body of a finished job can be passed whole.
 * No shape check: the two fields are hashed as they are, and the caller validates them (the hop's read, before the hash is compared).
 */
export function ocrResponseHash(res: { content: string; output_format: string }): string {
  return commit({ content: res.content, output_format: res.output_format });
}

/**
 * The prompt_hash of a chat job (capability llm.text.generate.v1). The fleet commits to the request after normalisation, so a string input becomes
 * one user message with one input_text part. The body is {input} only: the fleet supplier clamps a max_output_tokens of the body to the one of the
 * advert before it compares the prompt hash (supplier/src/server.ts at e847a55), so a body that carried one would have to commit to the clamped value.
 */
export function responsesPromptHash(body: { input: string }): string {
  return commit(responseRequestCommitment(normalizeResponseRequest(body)));
}

/**
 * The response_hash of a chat job: the envelope {output, status, incomplete_details} of the response object as received. The poll body of a finished
 * job can be passed whole: only those three fields are read, so the receipt fields, id, model and usage are not covered. The fleet supplier runs
 * the output through normalizeResponseOutput before it builds the response it hashes (supplier/src/openai.ts), so the items as received are the
 * items it hashed. No shape check but that the response is an object: the three fields are hashed as received, and the caller validates them
 * (responsesOutputText, and the hop's read).
 */
export function responsesResponseHash(response: unknown): string {
  return commit(responseResultCommitment(asResponseObject(response)));
}

/**
 * The answer of a chat job: the text parts of the assistant messages of the output, in order; refusals and reasoning items are left out. The output
 * is validated by normalizeResponseOutput, as the fleet buyer validates it: an item of an unsupported type, or one that is not the assistant's, is refused.
 */
export function responsesOutputText(response: unknown): string {
  return responseOutputText(normalizeResponseOutput(asResponseObject(response).output));
}
