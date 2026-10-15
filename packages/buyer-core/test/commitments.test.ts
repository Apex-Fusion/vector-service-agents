// packages/buyer-core/test/commitments.test.ts
import { describe, it, expect } from 'vitest';
import { canonicalize, sha256Utf8Hex, requestSpecHash } from '@vsa/vector-read';
import * as commitments from '../src/commitments.ts';
import { ocrPromptHash, ocrResponseHash, responsesPromptHash, responsesResponseHash, responsesOutputText } from '../src/commitments.ts';
import { normalizeResponseRequest, responseRequestCommitment } from '../src/vendored/fleet/responses.ts';

describe('commitments', () => {
  it('request_spec_hash of the live ChandraOCR advert reproduces the on-chain value', () => {
    expect(requestSpecHash({ capability_id: 'ocr.page.extract.chandra-ocr-2.v1', max_output_tokens: 8192, model: 'historical-records-ocr-v1' } as never))
      .toBe('f41357ac8b61f59e2f33cebc1d2022d38b00026b75517d2d9ccb23a15f6667e8');
  });
  it('the OCR prompt hash is sha256 of canonicalize({image_b64, mime, output_format}), over the base64 string as sent', () => {
    const req = { image_b64: 'iVBORw0KGgo=', mime: 'image/png' as const, output_format: 'markdown' as const };
    expect(ocrPromptHash(req)).toBe(sha256Utf8Hex(canonicalize({ image_b64: 'iVBORw0KGgo=', mime: 'image/png', output_format: 'markdown' })));
    expect(canonicalize(req)).toBe('{"image_b64":"iVBORw0KGgo=","mime":"image/png","output_format":"markdown"}');
  });
  it('the OCR response hash covers {content, output_format} and nothing else', () => {
    expect(ocrResponseHash({ content: 'Dear Sir', output_format: 'markdown' })).toBe(sha256Utf8Hex('{"content":"Dear Sir","output_format":"markdown"}'));
  });
  it('the Responses prompt hash commits to the normalized request: a string input becomes one user message', () => {
    // Confirmed by printing it from the vendored fleet code (agents-marketplace e847a55): normalizeResponseRequest turns the string into one user
    // message with one input_text part, and responseRequestCommitment carries the fields the request has. A body without max_output_tokens
    // commits to none (the fleet clamps one only when the body carries it; the pinned fleet hash below has max_output_tokens 512).
    const expected = '{"input":[{"content":[{"text":"hello","type":"input_text"}],"role":"user","type":"message"}]}';
    expect(responsesPromptHash({ input: 'hello' })).toBe(sha256Utf8Hex(expected));
  });
  it('the Responses response hash covers output, status and incomplete_details of the parsed object', () => {
    const response = { id: 'resp_1', status: 'completed', incomplete_details: null, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A summary.' }] }], usage: { input_tokens: 10, output_tokens: 3 } };
    expect(responsesResponseHash(response)).toBe(sha256Utf8Hex(canonicalize({ output: response.output, status: 'completed', incomplete_details: null })));
    expect(responsesOutputText(response)).toBe('A summary.');
  });
});

describe('commitments, the edges of the pinned values', () => {
  it('re-exports requestSpecHash of @vsa/vector-read, the one function behind the on-chain value', () => {
    expect(commitments.requestSpecHash).toBe(requestSpecHash);
  });
  it('the OCR prompt hash covers {image_b64, mime, output_format} and nothing else', () => {
    const req = { image_b64: 'iVBORw0KGgo=', mime: 'image/png' as const, output_format: 'markdown' as const };
    const withExtras = { ...req, usage: { prompt_tokens: 1 }, note: 'not part of the commitment' };
    expect(ocrPromptHash(withExtras)).toBe(ocrPromptHash(req));
    expect(ocrPromptHash({ ...req, output_format: 'json' })).not.toBe(ocrPromptHash(req));
    expect(ocrPromptHash({ ...req, mime: 'image/jpeg' })).not.toBe(ocrPromptHash(req));
  });
  it('the OCR response hash ignores the rest of the poll body of a finished job, so the whole body can be passed', () => {
    const polled = { kind: 'ocr', output_format: 'markdown', content: 'Dear Sir', usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }, receipt: { escrow_ref: 'aa#0' }, receipt_signature: 'bb', submitted_ref: 'cc#0' };
    expect(ocrResponseHash(polled)).toBe(ocrResponseHash({ content: 'Dear Sir', output_format: 'markdown' }));
    expect(ocrResponseHash({ ...polled, output_format: 'html' })).not.toBe(ocrResponseHash(polled));
    expect(ocrResponseHash({ ...polled, content: 'Dear Madam' })).not.toBe(ocrResponseHash(polled));
  });
  it('strings are NFC-normalised on both sides of a job: a decomposed accent hashes as the composed one', () => {
    // U+010D as one code point, and as c followed by U+030C. The supplier hashes the NFC form (canonicalize), so a page text that arrives decomposed must too.
    const composed = 'Zagreb \u010D';
    const decomposed = 'Zagreb c\u030C';
    expect(decomposed).not.toBe(composed);
    expect(ocrResponseHash({ content: decomposed, output_format: 'markdown' })).toBe(ocrResponseHash({ content: composed, output_format: 'markdown' }));
    expect(responsesPromptHash({ input: decomposed })).toBe(responsesPromptHash({ input: composed }));
    expect(responsesPromptHash({ input: 'Zagreb c' })).not.toBe(responsesPromptHash({ input: composed }));
  });
  it('the vendored request commitment reproduces the prompt hash the fleet pins in its own tests, and a max_output_tokens in the body is part of it', () => {
    // PROMPT_HASH in tests/fixtures/supplier-side/sample-escrow-state.ts of agents-marketplace at e847a55; its request is this input with max_output_tokens 512.
    const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hello, who are you?' }] }];
    const committed = canonicalize(responseRequestCommitment(normalizeResponseRequest({ input, max_output_tokens: 512 })));
    expect(committed).toBe('{"input":[{"content":[{"text":"Hello, who are you?","type":"input_text"}],"role":"user","type":"message"}],"max_output_tokens":512}');
    expect(sha256Utf8Hex(committed)).toBe('29e5230dde416ad49901baf3ef90e411df401f3aaedba5d8e98e969e48472c9e');
  });
  it('the Responses response hash reads output, status and incomplete_details only, so the whole poll body can be passed', () => {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A summary.' }] }];
    const polled = { id: 'resp_1', object: 'response', created_at: 1, model: 'm', status: 'completed', incomplete_details: null, error: null, output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }, kind: 'chat', receipt: { escrow_ref: 'aa#0' }, receipt_signature: 'bb', submitted_ref: 'cc#0' };
    const hash = responsesResponseHash(polled);
    expect(responsesResponseHash({ ...polled, id: 'resp_2', model: 'other', usage: null, receipt: {}, receipt_signature: 'zz' })).toBe(hash);
    expect(responsesResponseHash({ ...polled, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Another.' }] }] })).not.toBe(hash);
    expect(responsesResponseHash({ ...polled, status: 'incomplete' })).not.toBe(hash);
    expect(responsesResponseHash({ ...polled, incomplete_details: { reason: 'max_output_tokens' } })).not.toBe(hash);
  });
  it('the Responses output text joins the assistant text parts in order and leaves reasoning items and refusals out', () => {
    const response = { output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'First. ' }, { type: 'refusal', refusal: 'no' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Second.' }] },
    ] };
    expect(responsesOutputText(response)).toBe('First. Second.');
  });
  it('a body that is not an object is refused by both response functions, and an output that is not an array by the text', () => {
    for (const bad of [null, 'text', 7, ['x']]) {
      expect(() => responsesResponseHash(bad)).toThrow('response must be an object');
      expect(() => responsesOutputText(bad)).toThrow('response must be an object');
    }
    expect(() => responsesOutputText({ status: 'completed' })).toThrow('response output must be an array');
  });
});
