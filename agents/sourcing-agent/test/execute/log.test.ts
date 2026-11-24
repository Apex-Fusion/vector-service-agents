// agents/sourcing-agent/test/execute/log.test.ts: what the job `execute` writes to its log and to its result. A line holds codes and statuses, and never a key, a token, a proof, the salt, the approval, a part of the ranking or
// a word of the sourcing record. A log that throws changes no result. Each form of the job is run, and the same secrets are searched in each.
import { describe, expect, it } from 'vitest';
import type { ExecuteResult } from '@vsa/usecase-kit/protocol';
import type { ExecuteDeps } from '../../src/execute/index.ts';
import { APPROVAL, SALT } from './fixtures.ts';
import type { World } from './world.ts';
import { jsonResponse, rawKeyHexOf, words, world } from './world.ts';

const WORDS = 'words of the record about the ranking of alfa.example.org';

/** The texts that no line of the log and no result may hold: the keys, the pieces of the token and of the proof of the call, the salt, the approval, and parts of the ranking. */
function secretsOf(w: World): string[] {
  const secrets = [
    rawKeyHexOf(w.a.testKey.privateKey), rawKeyHexOf(w.b.testKey.privateKey), rawKeyHexOf(w.agent.authentication.privateKey),
    SALT, APPROVAL.attestation, APPROVAL.issuer_did, String(w.document().rfq_sha256), `did:vector:${'a1'.repeat(32)}`, `${'e5'.repeat(32)}#0`, 'alfa.example.org', 'run1-rfq-1',
  ];
  for (const call of w.record.calls) {
    const token = (call.headers.authorization ?? '').slice('DPoP '.length);
    const proof = call.headers.dpop ?? '';
    secrets.push(token, proof, ...token.split('.').filter((piece) => piece.length >= 12), ...proof.split('.').filter((piece) => piece.length >= 12));
  }
  return secrets.filter((secret) => secret.length > 0);
}

interface Form {
  readonly name: string;
  readonly run: (w: World) => Promise<ExecuteResult>;
}

const FORMS: readonly Form[] = [
  { name: 'a ranking that was written', run: (w) => w.run() },
  { name: 'a ranking that the record refused, with words', run: (w) => { w.record.answer = () => jsonResponse(403, { error: 'approval_wrong_issuer', message: WORDS }); return w.run(); } },
  { name: 'a null approval', run: (w) => w.run(w.request(w.document(), null)) },
  { name: 'a call that failed, with words', run: (w) => { w.record.answer = () => jsonResponse(500, { error: 'internal', message: WORDS }); return w.run(); } },
  { name: 'a call whose error carries a word', run: (w) => { w.record.answer = () => { throw new TypeError(WORDS); }; return w.run(); } },
  { name: 'a gateway that gives no token', run: (w) => { w.gateway.endDelegation(w.delegation); return w.run(); } },
  { name: 'a ledger that fails with a message', run: (w) => { w.reads.failDelegation = new Error(WORDS); return w.run(); } },
  { name: 'a delegate key that cannot be read, with a message', run: (w) => { w.delegateKey.failure = new Error(WORDS); return w.run(); } },
  { name: 'a document that is no ranking', run: (w) => w.run(w.request({ schema: 'vector.usecase.po.v1', note: WORDS })) },
];

describe('the log and the result of the job', () => {
  for (const form of FORMS) {
    it(`hold no key, no token, no proof, no salt, no approval, no part of the ranking and no word of the record: ${form.name}`, async () => {
      const w = world();
      const result = await form.run(w);
      const spoken = w.log.join('\n');
      expect(w.log.length).toBeGreaterThan(0);
      for (const secret of secretsOf(w)) {
        expect(spoken, `the log holds ${secret.slice(0, 8)}`).not.toContain(secret);
        expect(JSON.stringify(result), `the result holds ${secret.slice(0, 8)}`).not.toContain(secret);
      }
      expect(spoken).not.toContain('words of the record');
      expect(JSON.stringify(result)).not.toContain('words of the record');
    });
  }

  it('writes one line for the end of a job that wrote the ranking: it starts with the name of the job and holds the status', async () => {
    const w = world();
    await w.run();
    expect(w.log).toHaveLength(1);
    expect(w.log[0]).toMatch(/^execute: .*\b201\b/);
  });
});

describe('a log that throws', () => {
  it('changes no result: the job goes on, and the ranking is written', async () => {
    const w = world();
    const deps: ExecuteDeps = { ...w.deps, log: () => { throw new Error('the log is closed'); } };
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe('completed none Completed');
    expect(w.record.written).toHaveLength(1);
  });

  it('changes no failure: the code of the failure is the same', async () => {
    const w = world();
    w.gateway.endDelegation(w.delegation);
    const deps: ExecuteDeps = { ...w.deps, log: () => { throw new Error('the log is closed'); } };
    expect(words(await w.run(w.request(), w.arrived, deps))).toBe('failed token_failed Failed');
  });
});
