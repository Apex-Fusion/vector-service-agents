// scripts/render-template.mjs - writes agents/advocate/agent.json.template from manifestFromEnv, with the placeholders for the five fields the operator
// supplies. The template is never edited by hand: change the manifest in src/server.ts and run `pnpm --filter @vsa/advocate template`. A test
// (test/server.test.ts) keeps the file equal to what this prints.
import { writeFileSync } from 'node:fs';
import { renderTemplate } from '../src/server.ts';

const file = new URL('../agent.json.template', import.meta.url);
const text = renderTemplate();
writeFileSync(file, text, 'utf8');
console.log(`wrote agent.json.template (${Buffer.byteLength(text, 'utf8')} bytes)`);
