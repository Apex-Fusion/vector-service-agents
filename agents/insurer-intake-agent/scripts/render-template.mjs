// scripts/render-template.mjs - writes agents/insurer-intake-agent/agent.json.template from the manifest builder, with the placeholders for the values that the operator gives. The template is never edited by hand:
// change the manifest in src/serve/manifest.ts and run `pnpm --filter @vsa/insurer-intake-agent template`. A test (test/serve/manifest.test.ts) keeps the file equal to what this prints.
import { writeFileSync } from 'node:fs';
import { renderTemplate } from '../src/serve/manifest.ts';

const file = new URL('../agent.json.template', import.meta.url);
const text = renderTemplate();
writeFileSync(file, text, 'utf8');
console.log(`wrote agent.json.template (${Buffer.byteLength(text, 'utf8')} bytes)`);
