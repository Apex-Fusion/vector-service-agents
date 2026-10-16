// packages/service-kit/test/child-env.test.ts
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { childEnv } from '../src/child-env.ts';

const TOKEN = `Bearer ${'ab'.repeat(32)}`;

describe('childEnv', () => {
  test('a copy without SERVICE_AUTH_HEADER and without any name that holds PRIV_KEY, TOKEN, SECRET, PASSWORD, API_KEY or ACCESS_KEY, in any case; everything else kept', () => {
    const kept = {
      PATH: '/app/asr/venv/bin:/usr/local/bin:/usr/bin', Path: 'the same on Windows', VIRTUAL_ENV: '/app/asr/venv', LANG: 'C.UTF-8', HOME: '/home/node', NODE_ENV: 'production',
      OPERATOR_CONTACT: 'ops@example.test', SUPPLIER_PKH: 'ab'.repeat(28), SUPPLIER_PUB_KEY_HEX: 'cd'.repeat(32), ASR_WORKER: '/app/asr/worker.py', KEYS_DIR: '/keys',
    };
    const hidden = {
      SERVICE_AUTH_HEADER: TOKEN, service_auth_header: TOKEN, SUPPLIER_PRIV_KEY_HEX: 'a key', PIPELINE_BUYER_PRIV_KEY_HEX: 'a key', priv_key: 'a key',
      GITHUB_TOKEN: 'a token', hf_token: 'a token', TOKENIZERS_PARALLELISM: 'false', CLIENT_SECRET: 'a secret', AppSecret: 'a secret', DB_PASSWORD: 'a password', password: 'a password',
      OPENAI_API_KEY: 'an api key', Brave_Api_Key: 'an api key', api_key: 'an api key', AWS_ACCESS_KEY_ID: 'an access key', MINIO_ACCESS_KEY: 'an access key', access_key: 'an access key',
    };
    const env = { ...kept, ...hidden };
    const before = { ...env };
    expect(childEnv(env)).toStrictEqual(kept);
    expect(env, 'the environment of the service is left as it is').toStrictEqual(before);
    expect(childEnv({})).toStrictEqual({});
  });
  test('src/child-env.ts has no imports and re-exports nothing, so @vsa/service-kit/env loads nothing else (the renderer of the Document Pipeline uses it)', () => {
    const source = readFileSync(new URL('../src/child-env.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^import\b/m);
    expect(source).not.toMatch(/^export\b[^;]*\bfrom\b/m);
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
    expect(manifest.exports['./env']).toBe('./src/child-env.ts');
  });
});
