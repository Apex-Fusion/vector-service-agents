import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createHash, createPrivateKey, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The four agent specs share one structure and one set of public-wording rules (docs/superpowers/specs/2026-10-13-vector-service-agents-design.md, section 8).
// The member guide and the E2E runbook are pinned against the same specs and the design at the end of this file.
const HEADINGS = ['Status', 'Identity', 'Capability id', 'Terms', 'Interface', 'What the receipt commits to', 'Operator and data handling', 'Known gaps', 'How to hire it', 'Changelog', 'Links'];
// The sentence under "Identity" in each spec. Agent History was registered on 2026-10-14 (RUNBOOK step 7), Document Pipeline on 2026-10-16 (step 7 of RUNBOOK-document-pipeline), Audio Snippets on 2026-10-17 (step 7 of RUNBOOK-audio-snippets) and Advocate on 2026-10-19 (step 7 of RUNBOOK-advocate), and each says so. No spec says that it has no record.
const NO_RECORD = 'This agent has no registry record yet.';
const HAS_RECORD = 'This agent has had a registry record since 2026-10-14.';
const DP_HAS_RECORD = 'This agent has had a registry record since 2026-10-16.';
const AS_HAS_RECORD = 'This agent has had a registry record since 2026-10-17.';
const AD_HAS_RECORD = 'This agent has had a registry record since 2026-10-19.';
// The status line of Agent History since the flip of 2026-10-15 (RUNBOOK step 17): the facts in one line, as every file that has a status line gives them.
const AH_STATUS = 'DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15.';
// The status line of Document Pipeline since the flip of 2026-10-16 (RUNBOOK-document-pipeline step 17): the facts in one line, in the form of Agent History's. The Pipeline was built on 2026-10-15, registered, staked and advertised on 2026-10-16, and PROPOSED (built, not deployed) until step 17. It is DEPLOYED, never LIVE: a first-party run is not demand.
const DP_STATUS = 'DEPLOYED (registered and staked 2026-10-16, advertised 2026-10-16, re-advertised 2026-10-16 at the status flip, one first-party job settled 2026-10-16). Since 2026-10-16.';
// The status line of Audio Snippets since the flip of 2026-10-17 (RUNBOOK-audio-snippets step 17), in the form of the other two. Audio Snippets was built on 2026-10-16 and PROPOSED (built, not
// deployed) until step 17; it was registered, staked and advertised on 2026-10-17, and one first-party job settled that day. It is DEPLOYED, never LIVE: a first-party run is not demand.
const AS_STATUS = 'DEPLOYED (registered and staked 2026-10-17, advertised 2026-10-17, re-advertised 2026-10-17 at the status flip, one first-party job settled 2026-10-17). Since 2026-10-17.';
// The status line of Advocate since the flip of 2026-10-20 (RUNBOOK-advocate step 17), in the form of the other three. Advocate was built on 2026-10-17 and PROPOSED (built, not deployed)
// until step 17; it was registered, staked and advertised on 2026-10-19, and one first-party job settled on 2026-10-20. It is DEPLOYED, never LIVE: a first-party run is not demand.
const AD_STATUS = 'DEPLOYED (registered and staked 2026-10-19, advertised 2026-10-19, re-advertised 2026-10-20 at the status flip, one first-party job settled 2026-10-20). Since 2026-10-20.';
const AGENTS = {
  'agent-history': { capability: 'identity.history.report.v1', model: 'agent-history-v1', status: AH_STATUS, record: HAS_RECORD },
  'document-pipeline': { capability: 'document.pipeline.ocr-summary.v1', model: 'document-pipeline-v1', status: DP_STATUS, record: DP_HAS_RECORD },
  'audio-snippets': { capability: 'audio.transcript.snippets.v1', model: 'audio-snippets-v1', status: AS_STATUS, record: AS_HAS_RECORD },
  advocate: { capability: 'research.advocate.onesided.v1', model: 'advocate-v1', status: AD_STATUS, record: AD_HAS_RECORD },
};
// The ledger's native unit is named once, in docs/HIRE.md. Spelled in two parts, so a search for the name finds only the guide.
const UNIT_NAME = new RegExp('AP' + '3X', 'gi');
// En and em dash, built from their code points so that this file holds neither.
const DASHES = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']', 'g');
// The two names every spec uses apart: the request JSON (what the member writes) and the wire payload (what is hashed and posted).
const WIRE_PAYLOAD = 'canonicalize([{ content: <request JSON as a string>, role: "user" }])';
const read = (name) => readFileSync(new URL(`../specs/${name}.md`, import.meta.url), 'utf8');
const section = (text, heading) => { const rest = text.split(`\n## ${heading}\n`)[1] ?? ''; return rest.split('\n## ')[0]; };
const DESIGN = readFileSync(new URL('../docs/superpowers/specs/2026-10-13-vector-service-agents-design.md', import.meta.url), 'utf8');

test('specs/ holds exactly the four agent specs', () => {
  assert.deepEqual(readdirSync(new URL('../specs/', import.meta.url)).sort(), Object.keys(AGENTS).map((n) => `${n}.md`).sort());
});

for (const [name, { capability, status, record }] of Object.entries(AGENTS)) {
  test(`${name}: the eleven headings in order, the capability id and the status line`, () => {
    const text = read(name);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]), HEADINGS);
    assert.ok(text.startsWith('# '), 'starts with a title');
    assert.ok(text.split('\n')[2].includes(`\`${capability}\``), 'the first line after the title names the capability id');
    assert.equal(section(text, 'Capability id').split('\n')[1], `\`${capability}\``);
    assert.ok(section(text, 'Status').includes(status), `the status line is "${status}"`);
  });

  test(`${name}: LIVE and DEPLOYED are said under Status and nowhere else, as the status line and the sentence that denies LIVE; no em or en dash, no native unit name`, () => {
    const text = read(name);
    const under = section(text, 'Status');
    // Agent History (since 2026-10-15), Document Pipeline (since 2026-10-16), Audio Snippets (since 2026-10-17) and Advocate (since 2026-10-20) are DEPLOYED and say that nothing on their page is LIVE.
    const denial = 'Nothing on this page is LIVE.';
    assert.ok(under.includes(denial), `the Status section says "${denial}"`);
    assert.equal(text.replace(under, '').match(/\b(LIVE|DEPLOYED)\b/g), null, 'not outside the Status section');
    assert.equal(under.replace(denial, '').replace(status, '').match(/\b(LIVE|DEPLOYED)\b/g), null, 'inside it, only the status line and the denial');
    assert.equal(text.match(DASHES), null);
    assert.equal(text.match(UNIT_NAME), null);
  });

  test(`${name}: the Identity section says whether the agent has a registry record, and it does not claim the whole table is absent`, () => {
    const text = read(name);
    const identity = section(text, 'Identity');
    assert.ok(identity.includes(`\n${record}\n`), `the Identity section says "${record}"`);
    for (const other of [NO_RECORD, HAS_RECORD, DP_HAS_RECORD, AS_HAS_RECORD, AD_HAS_RECORD].filter((sentence) => sentence !== record)) assert.equal(identity.includes(other), false, `and not "${other}"`);
    assert.equal(text.match(/Nothing in this table/), null); // the registry address row does exist
  });

  test(`${name}: the request JSON and the wire payload are named apart, and the raw routes say who wraps`, () => {
    const text = read(name);
    assert.equal(text.match(/payload is the request JSON/i), null);
    assert.ok(section(text, 'Interface').includes(WIRE_PAYLOAD), 'Interface defines the wire payload');
    assert.ok(section(text, 'Interface').includes('wrap the request JSON into the wire payload for you'), 'the tools and the buyer wrap it');
    assert.match(section(text, 'How to hire it'), /3[.] [*][*]Developers, the raw routes[.][*][*][^\n]*wire payload/);
    assert.match(section(text, 'What the receipt commits to'), /prompt_hash[^\n]*wire payload/);
  });

  test(`${name}: Terms are lovelace fields printed with six decimals`, () => {
    const rows = [...section(read(name), 'Terms').matchAll(/^\| (Price|Supplier bond|Buyer bond) \| (\d+) \| (\d+\.\d{6}) \|$/gm)];
    assert.equal(rows.length, 3);
    for (const [, , lovelace, printed] of rows) assert.equal((Number(lovelace) / 1_000_000).toFixed(6), printed);
  });
}

// Agent History has a registry record and a Module-3 self-stake since 2026-10-14 (RUNBOOK steps 7 and 8), and a public URL in service and an advert since the same day (steps 10 to 14), all run on the box.
// The spec, the guide and the runbooks record them and claim nothing more: one first-party job has settled (2026-10-15, RUNBOOK step 15), which is not demand, and the status word is DEPLOYED since 2026-10-15 (RUNBOOK step 17), never LIVE. The values are the ones the ledger holds for that registration and those adverts.
const AH = {
  did: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:8a98c4b74f0e49a09ca4b3502e121c96a8e6992afd2cba64ef8128042fedd440',
  registerTx: '6da5a2b4435257daf905f92f7ae281446d627aaedee25193cf55d94a547a49fa',
  stakeTx: 'eaf4d43d33da429e0d1072e2f01ae628958dedef97a385bc4d8120b3c8debba7',
  controllerPkh: '1ea22a13acac6da070959317bad9bf5e510e8f7875a6727d3a5262cd',
  // The first advert, posted and confirmed on 2026-10-14 (RUNBOOK step 12), listed Active and free by the marketplace indexer (step 14), and retired on 2026-10-15 at the status flip (step 17, item 2). The first-party run of 2026-10-15 was made against it.
  firstAdvertTx: '13446b05fd40cfac30e3df301748d0cc900b5de1a47582e40a2671107cbc747c',
  firstAdvertRef: '13446b05fd40cfac30e3df301748d0cc900b5de1a47582e40a2671107cbc747c#0',
  retireTx: 'b15761eb6b6df82f9bb29554749960b91b4896ef0081171baa1e2c5b5728cc0c',
  // The current advert, posted and confirmed on 2026-10-15 with the manifest of the status flip (step 17, item 6) and listed Active and free by the marketplace indexer. A reference is the transaction id and the output index.
  advertTx: 'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c',
  advertRef: 'b5185495e775237d795c1f09fdcf6a5787e6b354dd8a304ef2ff8b9d881fba6c#0',
  manifestHash: '251174d556f6f56331a5abc0c343ef9d7277e932511a965ee50f248659b61501',
};
const EXPLORER_TX = 'https://explorer.vector.mainnet.apexfusion.org/transaction/hash/';

test('specs/agent-history.md: the Status line says DEPLOYED since 2026-10-15, the Status paragraph and the Identity sentence say the registry record and the advert exist since 2026-10-14 and one first-party job has settled on 2026-10-15, nothing is LIVE, and the words of before do not come back', () => {
  const text = read('agent-history');
  assert.ok(section(text, 'Status').includes(`\n${AH_STATUS}\n`), 'the status line, alone on its line');
  assert.ok(section(text, 'Status').includes("It is deployed on the operator's host, has had a registry record since 2026-10-14 and has had an advert since 2026-10-14. One first-party job has settled, on 2026-10-15; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE."));
  assert.equal(section(text, 'Status').match(/PROPOSED|not deployed/), null, 'the words of before the flip do not come back');
  assert.equal(text.match(/no job (has )?settled/i), null, 'the spec does not say that no job settled');
  assert.equal(section(text, 'Status').match(/has no advert|not yet advertised/i), null, 'the Status paragraph and line do not say that the agent has no advert');
  assert.ok(section(text, 'Identity').includes(`\n${HAS_RECORD}\n`));
  // The words of before the registration. The lines a report adds for a subject that has no record ("No registry record found for this subject.") are about other subjects and stay.
  assert.equal(section(text, 'Status').match(/no registry record/i), null, 'the Status paragraph does not say that the agent has no record');
  assert.equal(text.match(/no registry record yet/i), null);
  assert.equal(text.match(/has no DID yet/i), null);
  assert.equal(section(text, 'Identity').match(/not registered|When registered|Registry record, planned|Reputation stake, planned/), null);
  // The Response example was recorded on 2026-10-13, the day before the registration, so its placeholder is explained by the date and not by a missing DID.
  assert.ok(text.includes('`generated_by.did` is shown as a placeholder because the run was made before this agent was registered on 2026-10-14.'));
});

test('specs/agent-history.md: the DID, the registry record and the reputation stake of 2026-10-14 are in the Identity table with their transactions, the URL is in service since 2026-10-14, and the first advert (retired on 2026-10-15) and the current advert (posted on 2026-10-15) are recorded in the Links', () => {
  const text = read('agent-history');
  const row = (label) => section(text, 'Identity').split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
  // The DID has the registry policy of the DID in the Request example and an asset name of 64 hex. The explorer link has the pattern the member guide gives.
  const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(section(text, 'Interface'))?.[1] ?? '';
  assert.match(policy, /^[0-9a-f]{56}$/);
  assert.match(AH.did, new RegExp(`^did:vector:agent:${policy}:[0-9a-f]{64}$`));
  assert.ok(readFileSync(new URL('../docs/HIRE.md', import.meta.url), 'utf8').includes(`${EXPLORER_TX}<txid>`), 'the explorer link pattern');
  assert.equal(row('DID'), `| DID | \`${AH.did}\` |`);
  const record = row('Registry record');
  for (const part of [
    'name `Agent History`', 'description as in the manifest', 'capabilities `identity.history.report.v1`', 'framework `vector-service-agents`', "endpoint the agent's public URL",
    `controller key hash \`${AH.controllerPkh}\` (the supplier key hash)`, 'Registered on 2026-10-14 in the confirmed transaction', `[\`${AH.registerTx}\`](${EXPLORER_TX}${AH.registerTx})`,
    'The deposit is 10000000 lovelace (10.000000), refundable on deregistration',
  ]) assert.ok(record.includes(part), `the Registry record row says: ${part}`);
  const stake = row('Reputation stake');
  for (const part of ['a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability', 'made on 2026-10-14 in transaction', `[\`${AH.stakeTx}\`](${EXPLORER_TX}${AH.stakeTx})`]) assert.ok(stake.includes(part), `the Reputation stake row says: ${part}`);
  assert.notEqual(AH.registerTx, AH.stakeTx, 'two transactions');
  // The URL is in service since 2026-10-14 (RUNBOOK steps 10 to 14), so the row is no longer "planned". The first advert was retired and the current one posted on 2026-10-15 (step 17): the Links keep the first as history and give the current one with its manifest hash. One first-party job settled on 2026-10-15 (step 15).
  assert.equal(row('Public URL'), '| Public URL | `https://mp-suppliers-history.hal8.ai` (in service as of 2026-10-14) |');
  assert.equal(row('Public URL, planned'), '', 'the URL is no longer planned');
  assert.equal(AH.advertRef.split('#')[0], AH.advertTx, 'the transaction id is the reference up to the #');
  assert.equal(AH.firstAdvertRef.split('#')[0], AH.firstAdvertTx);
  for (const hex of [AH.firstAdvertTx, AH.retireTx, AH.advertTx, AH.manifestHash]) assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(new Set([AH.firstAdvertTx, AH.retireTx, AH.advertTx]).size, 3, 'three transactions: the first advert, its retirement, the current advert');
  const links = section(text, 'Links');
  assert.ok(links.includes(`- First advert \`${AH.firstAdvertRef}\`, posted on 2026-10-14 in the confirmed transaction [\`${AH.firstAdvertTx}\`](${EXPLORER_TX}${AH.firstAdvertTx}), retired on 2026-10-15 at the status flip in the confirmed transaction [\`${AH.retireTx}\`](${EXPLORER_TX}${AH.retireTx}).`));
  assert.ok(links.includes(`- Current advert \`${AH.advertRef}\`, posted on 2026-10-15 in the confirmed transaction [\`${AH.advertTx}\`](${EXPLORER_TX}${AH.advertTx}), manifest hash \`${AH.manifestHash}\`. The marketplace indexer lists it as Active and free (checked on 2026-10-15).`));
  assert.ok(links.includes("- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-14."));
  assert.ok(section(text, 'How to hire it').includes('Advertised on 2026-10-14 and again on 2026-10-15, at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-15). One first-party job has settled, on 2026-10-15; it is not demand. The three ways below apply.'));
  // The words of before the advert do not come back. The three specs that have no advert keep theirs, and the runbooks quote them as instructions.
  assert.equal(text.match(/none yet|not posted|not in service|not yet advertised|once it is in service/i), null);
});

// Document Pipeline has a registry record and a Module-3 self-stake since 2026-10-16 (RUNBOOK-document-pipeline steps 7 and 8), and a public URL in service and an advert since the same day (steps 10 to 14), all run on the box.
// The spec, the guide and the runbooks record them and claim nothing more: one first-party job has settled (2026-10-16, step 15), which is not demand, and the status word is DEPLOYED since 2026-10-16 (step 17), never LIVE. The values are the ones the ledger holds for that registration, that stake and those adverts.
const DP = {
  did: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:b8599ec7f66a389dab40a963cce31a0e2e05c61e47f0b002fa39d59acf5932f5',
  registerTx: '195028d86ee9735084ce648779a673da5bf76977b10bc52b3d10dbfb57ef86dd',
  stakeTx: '6a41f59d0925b70583d0272fdddf9fedbc5dcac2d4af2c9484c452e2a5fb2830',
  controllerPkh: '5750aa8006bdc4f16f7950f54b89c2efb1d11091718d0db32a4863fc',
  // The first advert, posted and confirmed on 2026-10-16 (step 12), listed by the marketplace indexer (step 14), and retired the same day at the status flip (step 17, item 2). The first-party run was made against it.
  firstAdvertTx: '4fe706e06652342a83b68a1caf691373418d63a34431a66bcf284106af5f41df',
  firstAdvertRef: '4fe706e06652342a83b68a1caf691373418d63a34431a66bcf284106af5f41df#0',
  retireTx: '02f755ac6b07d3a1ecc839186ed3a296a8cf384e50f9a5b1fc1a1ac7efb5b141',
  // The second advert, posted on 2026-10-16 at the status flip (step 17, item 6) and retired the same day when the content pass changed the manifest text; the current advert followed it on the rebuilt image.
  secondAdvertTx: 'd2709262e001022ea68c0222474f9bebc74f8bfc31dcddd24dc89debcc6dda16',
  secondAdvertRef: 'd2709262e001022ea68c0222474f9bebc74f8bfc31dcddd24dc89debcc6dda16#0',
  secondManifestHash: 'f2dca80ac2b1685b956a9e0d2687d076aaa25e565637d69c58ebf0feb2127729',
  secondRetireTx: 'f9e9670e8da4fc423e371ab8cee20219c3f13c38ede12cd0208589a24edd9591',
  // The current advert, posted and confirmed on 2026-10-16 after the content pass changed the manifest text (the advert of the status flip was retired the same day) and listed Active and free by the marketplace indexer. A reference is the transaction id and the output index.
  advertTx: '16a5da8726cab90949da2c0c92e025af276027715a5d854861c683d7d9341ca3',
  advertRef: '16a5da8726cab90949da2c0c92e025af276027715a5d854861c683d7d9341ca3#0',
  manifestHash: '2d647f2ab239ce6f04c37f0eaf5d39a6240a305f020039880d05e47e1d3a67d7',
};
// The first first-party run of Document Pipeline (step 15, 2026-10-16): the object the script printed is docs/evidence/2026-10-16-document-pipeline-run-1.json, copied byte for byte.
const DP_RUN = {
  evidence: 'docs/evidence/2026-10-16-document-pipeline-run-1.json',
  evidenceBytes: 7530,
  evidenceSha256: 'a6f20fc37d4c13b1181cf5940a2d4199ca149f95bd8dda73fbdc6fe318129f6e',
  escrowRef: '4a86037e68c497f94d1e16b8a97a43f756b3611f428809b284b5295e5916acd5#0',
  postTx: '4a86037e68c497f94d1e16b8a97a43f756b3611f428809b284b5295e5916acd5',
  acceptTx: 'b9cc53fbfd1e6c0a6c624f4ce6f9a4868d16b5380fe5c3b259e6e663a4638ead',
  responseHash: '802aefff2759dee273f225c95c91bede1fe11f7e13386bdb9fb117155a320420',
  wallclockMs: 73816,
  sample: 'https://pdfobject.com/pdf/sample.pdf',
};

// Audio Snippets has a registry record and a Module-3 self-stake since 2026-10-17 (RUNBOOK-audio-snippets steps 7 and 8), and a public URL in service and an advert since the same day (steps 10 to 14), all run on the host.
// The spec, the guide and the runbooks record them and claim nothing more: one first-party job has settled (2026-10-17, step 15), which is not demand, and the status word is DEPLOYED since 2026-10-17 (step 17), never LIVE.
// The values are the ones the ledger holds for that registration, that stake and those adverts, and the public key is the one the manifest serves under keys.pub_key_hex.
const AS = {
  did: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:1532506e54fa79cdfca6bef566ff1a5e7af9fceb332ffb7414d9923334b9d1ee',
  registerTx: 'c101d9dd20a82d573bbb4d8d0155c89de403de29a73f1a68f1afa642542dc83b',
  stakeTx: 'a23857f97c9197dd1051ef291decb06ee9cf5818339ac67ea120d0810720f3a3',
  // The supplier key, the only key of the agent: its key hash is the controller of the registry record, and its public key signs the receipts.
  controllerPkh: '609cd71929d168a0c12bf6fa3d6743e91f6026c6c902abc728e8b9b8',
  pubKey: 'ef5a57f333b87f74e14c66145c7e3e5fa44ac7b69974cd6396cab1ca0ad54365',
  // The first advert, posted and confirmed on 2026-10-17 (step 12) over the manifest of before the flip, and retired the same day at the status flip (step 17, item 2). The first-party run was made against it.
  firstAdvertTx: '6cc1a8a7776ff6202a95ef6496a73dd521970bb7fa252b8a265c6e204e7ec489',
  firstAdvertRef: '6cc1a8a7776ff6202a95ef6496a73dd521970bb7fa252b8a265c6e204e7ec489#0',
  firstManifestHash: '84a9b9dfc8109be1144e9e70cedc5bbf2be3942ca7f6d7fd0570729037de843c',
  retireTx: '998499f2826dc80639e6606893f49568fa8c3fb3f3b001138b67637ba58f2374',
  // The current advert, posted and confirmed on 2026-10-17 at the status flip (step 17, item 6) over the manifest of the flip, and listed Active and free by the marketplace indexer. A reference is the transaction id and the output index.
  advertTx: '7dee930257e3d48d16fa267280899042e1619fe57d881c24dd9a332487212b2c',
  advertRef: '7dee930257e3d48d16fa267280899042e1619fe57d881c24dd9a332487212b2c#0',
  manifestHash: '059b0f6f9826eec89cfd4f7e3177152403983b926d2892bf2a472145daef879b',
  // The terms the current advert carries, as the ledger holds them: the price and the two bonds in lovelace, the window, the output tokens and the model.
  terms: { price: 2000000, supplierBond: 1000000, buyerBond: 1000000, maxProcessingMs: 1500000, maxOutputTokens: 8192, model: 'audio-snippets-v1' },
};
// The first first-party run of Audio Snippets (step 15, 2026-10-17): the object the script printed is docs/evidence/2026-10-17-audio-snippets-run-1.json, copied byte for byte.
const AS_RUN = {
  evidence: 'docs/evidence/2026-10-17-audio-snippets-run-1.json',
  evidenceBytes: 60783,
  evidenceSha256: '0450cc823db815ea988fe4b61fcc886b2a627d9e6681f83a889947518a1a31e3',
  escrowRef: '1bd01982aea06e39c6cd56eab0f49156ac202d06153f91492975d597e4d78c69#0',
  postTx: '1bd01982aea06e39c6cd56eab0f49156ac202d06153f91492975d597e4d78c69',
  acceptTx: '9f1e1aa9ea89bc2d2a91b6ed96bd429dd2d930e9dbccc204e5a50bedf58ebc61',
  responseHash: 'a7e97949c26ce96a36f40d5ebeadb80194816101af8a7d19d861326a34daede5',
  wallclockMs: 68485,
  quote: 'All LibriVox recordings are in the public domain.',
};

// Advocate has a registry record and a Module-3 self-stake since 2026-10-19 (RUNBOOK-advocate steps 7 and 8), and a public URL in service and an advert since the same day (steps 10 to 14),
// all run on the host. The spec, the guide and the runbooks record them and claim nothing more: one first-party job has settled (2026-10-20, step 15), which is not demand, and the status word
// is DEPLOYED since 2026-10-20 (step 17), never LIVE. The values are the ones the ledger holds for that registration, that stake and those adverts, and the key hash of the buyer key is the one
// the manifest serves under keys.buyer_pkh.
const AD = {
  did: 'did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:c5e44677dadefc8a194d15293cad889b85e1ce5c839177f1955778ac4c63d01c',
  registerTx: '0699bc56992695511fd3c55681deba4f9ad611cd5c526dcfe45758f203abe767',
  stakeTx: '82fdc231932405c105f8b8b03cc56c37c702d03befc1830e85d0debeeeabbb15',
  // The supplier key: its key hash is the controller of the registry record, and its public key, the one the manifest serves under keys.pub_key_hex, signs the receipts. The buyer key,
  // the second key, was made on the host when step 4 ran again, on 2026-10-19.
  controllerPkh: '20d8167910dbd9801984fe539fa94d94e53f2224226c7838c2f02867',
  pubKey: '1560d8c3c13ccd096ddda69be3f4ef65413bb31a4b325001965a46e99fad215c',
  buyerPkh: 'ee450a88d8344f18dd2baf266100aec3b1375b5870b2fe50f34de123',
  // The first advert, posted and confirmed on 2026-10-19 (step 12) over the manifest of before the flip, and retired on 2026-10-20 at the status flip (step 17, item 2). The first-party run was made against it.
  firstAdvertTx: 'bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc',
  firstAdvertRef: 'bdf2d452350b8e73eb723288c7d08e1dbaf2447236d030ef6e5f92e1772be4cc#0',
  firstManifestHash: '64d68e45a469c68ea6a0eabc1448a12e4a5c670573bbef6da1f8bab1179080e9',
  retireTx: '709dedff33e47723bbd85c29477ef3019a724ee61d2a44e2832cec56c3ad6e15',
  // The current advert, posted and confirmed on 2026-10-20 at the status flip (step 17, item 6) over the manifest of the flip, and listed Active and free by the marketplace indexer.
  advertTx: '199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb',
  advertRef: '199a5eed5fa377ed35a8fad726b99d2d59beac93bd33ab3eb891b70a98927deb#0',
  manifestHash: 'bb75efb7794f32c3e9547e256ef9ed6a877610e28d3a7fb5930d99925a102abc',
  // The terms the current advert carries: the price and the two bonds in lovelace, and the window.
  terms: { price: 3000000, supplierBond: 1000000, buyerBond: 1000000, maxProcessingMs: 480000 },
};
// The first first-party run of Advocate (step 15, 2026-10-20): the object the script printed is docs/evidence/2026-10-20-advocate-run-1.json, copied byte for byte. Its model call was bought
// on the marketplace, in a sub-job whose advert, escrow, supplier and counts are those below, and the service logged the job line below.
const AD_RUN = {
  evidence: 'docs/evidence/2026-10-20-advocate-run-1.json',
  evidenceBytes: 11381,
  evidenceSha256: 'ee7eedd4f6beda2a3c9225dfd0c64caabb871e83362381a1b96e29b774e31bf1',
  escrowRef: 'bfe89d231877a377fcb4a4a95afda8c3e3ed7810dc03070116e6105731961560#0',
  postTx: 'bfe89d231877a377fcb4a4a95afda8c3e3ed7810dc03070116e6105731961560',
  acceptTx: '87a39fc719a82f546c5a9d4c0c9891c648da7e98a153f914ede93b90107513d6',
  responseHash: '25c50e3f6935f6d631620f4b31395402bf83376ea461d570a879a4ae72df0281',
  wallclockMs: 42836,
  request: { subject: 'Should a city ban cars from its centre?', side: 'for', length: 'short', language: 'en' },
  subJob: {
    capability: 'llm.text.generate.v1', advertRef: 'e0bc4433bb86e495b8a4c5284e223a576267b8c64c79112a1330649ecba5ce28#0', model: 'deepseek/deepseek-v4-flash',
    escrowRef: 'cf44122a71b6c78697c066d981a904b1accb8ed200e04c9aff41cdbf305aaa1e#0', supplierPkh: '8dd21b435089885891d85ea45f43928df8a14b18366119892ef8433e',
    promptTokens: 13145, completionTokens: 913, wallclockMs: 7475,
  },
  jobLine: 'job done in 42816 ms: results 12, pages 6, arguments 3 (dropped 0), quotes dropped 1, tokens 13145/913; inference marketplace',
};

test('specs/document-pipeline.md: the Status line says DEPLOYED since 2026-10-16, the Status paragraph and the Identity sentence say the registry record and the advert exist since 2026-10-16 and one first-party job has settled on 2026-10-16, nothing is LIVE, and the words of before do not come back', () => {
  const text = read('document-pipeline');
  assert.ok(section(text, 'Status').includes(`\n${DP_STATUS}\n`), 'the status line, alone on its line');
  assert.ok(section(text, 'Status').includes("It is deployed on the operator's host, has had a registry record since 2026-10-16 and has had an advert since 2026-10-16. One first-party job has settled, on 2026-10-16; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE."));
  assert.equal(section(text, 'Status').match(/PROPOSED|not deployed/), null, 'the words of before the flip do not come back');
  assert.equal(text.match(/no job (has )?settled/i), null, 'the spec does not say that no job settled');
  assert.equal(section(text, 'Status').match(/has no advert|not yet advertised|no registry record/i), null, 'the Status paragraph does not say that the agent has no record or no advert');
  assert.ok(section(text, 'Identity').includes(`\n${DP_HAS_RECORD}\n`));
  // The words of before the registration.
  assert.equal(text.match(/no registry record yet|has no DID yet/i), null);
  assert.equal(section(text, 'Identity').match(/not registered|When registered|Registry record, planned|Public URL, planned|Reputation stake, planned/), null);
});

test('specs/document-pipeline.md: the DID, the registry record and the reputation stake of 2026-10-16 are in the Identity table with their transactions, the URL is in service since 2026-10-16, and the first advert (retired on 2026-10-16) and the current advert (posted on 2026-10-16) are recorded in the Links', () => {
  const text = read('document-pipeline');
  const row = (label) => section(text, 'Identity').split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
  // The DID has the registry policy that every DID of the registry has (the one in the Request example of Agent History) and an asset name of 64 hex of its own. The explorer link has the pattern the member guide gives.
  const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(section(read('agent-history'), 'Interface'))?.[1] ?? '';
  assert.match(policy, /^[0-9a-f]{56}$/);
  assert.match(DP.did, new RegExp(`^did:vector:agent:${policy}:[0-9a-f]{64}$`));
  assert.notEqual(DP.did, AH.did, 'its own asset name');
  assert.ok(readFileSync(new URL('../docs/HIRE.md', import.meta.url), 'utf8').includes(`${EXPLORER_TX}<txid>`), 'the explorer link pattern');
  assert.equal(row('DID'), `| DID | \`${DP.did}\` |`);
  const record = row('Registry record');
  for (const part of [
    'name `Document Pipeline`', 'capabilities `document.pipeline.ocr-summary.v1`', 'framework `vector-service-agents`', "endpoint the agent's public URL",
    `controller key hash \`${DP.controllerPkh}\` (the supplier key hash)`, 'Registered on 2026-10-16 in the confirmed transaction', `[\`${DP.registerTx}\`](${EXPLORER_TX}${DP.registerTx})`,
    'The deposit is 10000000 lovelace (10.000000), refundable on deregistration',
  ]) assert.ok(record.includes(part), `the Registry record row says: ${part}`);
  const stake = row('Reputation stake');
  for (const part of ['a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability', 'made on 2026-10-16 in transaction', `[\`${DP.stakeTx}\`](${EXPLORER_TX}${DP.stakeTx})`]) assert.ok(stake.includes(part), `the Reputation stake row says: ${part}`);
  assert.match(DP.controllerPkh, /^[0-9a-f]{56}$/);
  for (const hex of [DP.registerTx, DP.stakeTx, DP.firstAdvertTx, DP.retireTx, DP.secondAdvertTx, DP.secondRetireTx, DP.secondManifestHash, DP.advertTx, DP.manifestHash]) assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(new Set([DP.registerTx, DP.stakeTx, DP.firstAdvertTx, DP.retireTx, DP.secondAdvertTx, DP.secondRetireTx, DP.advertTx]).size, 7, 'seven transactions: the registration, the stake, the first advert, its retirement, the second advert, its retirement, the current advert');
  // The URL is in service since 2026-10-16 (steps 10 to 14), so no row is "planned" any more. The first advert was retired and the current one posted the same day (step 17): the Links keep the first as history and give the current one with its manifest hash. One first-party job settled on 2026-10-16 (step 15).
  assert.equal(row('Public URL'), '| Public URL | `https://mp-suppliers-pipeline.hal8.ai` (in service as of 2026-10-16) |');
  for (const label of ['Registry record, planned', 'Public URL, planned', 'Reputation stake, planned']) assert.equal(row(label), '', `${label} is gone`);
  assert.equal(DP.advertRef.split('#')[0], DP.advertTx, 'the transaction id is the reference up to the #');
  assert.equal(DP.firstAdvertRef.split('#')[0], DP.firstAdvertTx);
  assert.match(DP.advertRef, /^[0-9a-f]{64}#0$/);
  assert.notEqual(DP.advertRef, DP.firstAdvertRef);
  const links = section(text, 'Links');
  assert.ok(links.includes(`- First advert \`${DP.firstAdvertRef}\`, posted on 2026-10-16 in the confirmed transaction [\`${DP.firstAdvertTx}\`](${EXPLORER_TX}${DP.firstAdvertTx}), retired on 2026-10-16 at the status flip in the confirmed transaction [\`${DP.retireTx}\`](${EXPLORER_TX}${DP.retireTx}).`));
  assert.ok(links.includes(`- Current advert \`${DP.advertRef}\`, posted on 2026-10-16 in the confirmed transaction [\`${DP.advertTx}\`](${EXPLORER_TX}${DP.advertTx}), manifest hash \`${DP.manifestHash}\`. The marketplace indexer lists it as Active and free (checked on 2026-10-16).`));
  assert.ok(links.includes(`- Second advert \`${DP.secondAdvertRef}\`, posted on 2026-10-16 at the status flip in the confirmed transaction [\`${DP.secondAdvertTx}\`](${EXPLORER_TX}${DP.secondAdvertTx}), manifest hash \`${DP.secondManifestHash}\`, retired on 2026-10-16 in the confirmed transaction [\`${DP.secondRetireTx}\`](${EXPLORER_TX}${DP.secondRetireTx}) when the manifest text changed.`), 'the second advert and its retirement are in the Links');
  assert.ok(links.includes("- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-16."));
  assert.ok(section(text, 'How to hire it').includes('Advertised on 2026-10-16, and again the same day at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-16). One first-party job has settled, on 2026-10-16; it is not demand. The three ways below apply.'));
  // The words of before the advert do not come back. The two specs that have no advert keep theirs, and the runbooks quote them as instructions.
  assert.equal(text.match(/none yet|not posted|not in service|not yet advertised|none until deployed|once it is in service|waits for its deployment/i), null);
});

test('no spec says any more that it has no advert: Advocate, advertised since 2026-10-19, Audio Snippets, advertised since 2026-10-17, and the Pipeline, advertised since 2026-10-16, give their release, and How to hire it no longer waits', () => {
  // Advocate was built on 2026-10-17 and is DEPLOYED since 2026-10-20: its Changelog keeps the one line of the release and the day it was built, and How to hire it no longer waits.
  assert.equal(section(read('advocate'), 'Changelog').trim(), '- 0.1.0, 2026-10-17: built');
  assert.equal(section(read('advocate'), 'How to hire it').match(/Not yet advertised|Once advertised|waits for its deployment/), null, 'Advocate is advertised since 2026-10-19');
  for (const name of Object.keys(AGENTS)) assert.equal(read(name).match(/Not yet advertised|Once advertised|waits for its deployment/), null, `${name} is advertised`);
  // Audio Snippets was built on 2026-10-16 and is DEPLOYED since 2026-10-17: its Changelog keeps the one line of the release and the day it was built, and How to hire it no longer waits.
  assert.equal(section(read('audio-snippets'), 'Changelog').trim(), '- 0.1.0, 2026-10-16: built');
  assert.equal(section(read('audio-snippets'), 'How to hire it').match(/Not yet advertised|Once advertised|waits for its deployment/), null, 'Audio Snippets is advertised since 2026-10-17');
  // The Pipeline was built on 2026-10-15, advertised on 2026-10-16 and is DEPLOYED since that day: its Changelog names the release and the day, and no word of the design is left.
  const pipeline = read('document-pipeline');
  assert.equal(section(pipeline, 'How to hire it').includes('Not yet advertised'), false, 'the Pipeline is advertised since 2026-10-16');
  assert.equal(section(pipeline, 'Changelog').trim(), '- 0.1.0, 2026-10-15: built');
  assert.equal(pipeline.match(/Nothing is built|None of this is built/), null);
  assert.equal(section(read('agent-history'), 'How to hire it').includes('Not yet advertised'), false, 'Agent History is advertised since 2026-10-14');
  assert.ok(section(read('agent-history'), 'Changelog').trim() === '- 0.1.0 first build');
});

test('the terms of each spec are the terms in the design spec, read from its Terms paragraphs', () => {
  const found = new Map();
  const paragraph = /[*][*]Terms[.][*][*] Price (\d+); bonds (\d+) and (\d+); `ADVERT_MAX_PROCESSING_MS` ([\d ]+?)(?: [(][^)]*[)])?; `SERVICE_TIMEOUT_MS` ([\d ]+)[.] (?:In-memory[^.]*[.] )?Model string (?:in the advert and receipt: )?`([a-z0-9-]+)`/g;
  for (const m of DESIGN.matchAll(paragraph)) {
    const n = (s) => Number(s.replace(/ /g, '')); // the design groups thousands with a space
    found.set(m[6], { price: n(m[1]) * 1_000_000, supplierBond: n(m[2]) * 1_000_000, buyerBond: n(m[3]) * 1_000_000, window: n(m[4]), timeout: n(m[5]) });
  }
  assert.deepEqual([...found.keys()].sort(), Object.values(AGENTS).map((a) => a.model).sort(), 'the design has one Terms paragraph for each agent');
  for (const [name, { model }] of Object.entries(AGENTS)) {
    const design = found.get(model);
    const terms = section(read(name), 'Terms');
    const row = (label) => Number(terms.match(new RegExp('[|] ' + label + ' [|] ([0-9]+) '))?.[1]);
    assert.deepEqual({ price: row('Price'), supplierBond: row('Supplier bond'), buyerBond: row('Buyer bond') }, { price: design.price, supplierBond: design.supplierBond, buyerBond: design.buyerBond }, `${name}: price and bonds`);
    const windows = terms.match(/advert `max_processing_ms` \| (\d+) ms.*\n\| Service timeout, `SERVICE_TIMEOUT_MS` \| (\d+) ms/);
    assert.deepEqual([Number(windows?.[1]), Number(windows?.[2])], [design.window, design.timeout], `${name}: processing window and service timeout`);
    assert.ok(section(read(name), 'Capability id').includes(`\`${model}\``), `${name}: the model string is ${model}`);
  }
});

test('the design spec gives the registry endpoint as the public URL, the one the advert carries, not a service URL', () => {
  assert.ok(DESIGN.includes("endpoint = its public URL (the advert's `endpoint_url`)"));
  assert.equal(DESIGN.match(/endpoint = its service URL/), null);
});

test('the Pipeline states its economics and the first-party OCR hop; the Advocate states its declared bias verbatim', () => {
  const pipeline = read('document-pipeline');
  // The real net of the sub-jobs (about 2.2 each, the first live run's 4.41 for two), the price it is set against, and what returns of the 19 in flight.
  assert.ok(section(pipeline, 'Terms').includes("at five pages the Pipeline's six sub-jobs cost it about 13 net at today's fleet price of 0.2 per sub-job (each sub-job: the price, the supplier bond of 1 and about 1 in fees), against a job price of 5;"));
  assert.ok(section(pipeline, 'Terms').includes('the locks and fees in flight come to about 19, of which the buyer bonds and the lock excess return on Accept. The Foundation carries that gap on purpose while the fee floor stands.'));
  assert.equal(pipeline.match(/subsidises the difference|locks about 19 in sub-job escrows|to earn 5/), null, 'the economics of before');
  assert.match(section(pipeline, 'Operator and data handling'), /The OCR hop is first-party/);
  // The ChandraOCR registry record says HAL8-operated: the Pipeline's buyer key is the Foundation's, the OCR agent's supplier key is HAL8's.
  assert.match(section(pipeline, 'Operator and data handling'), /the Pipeline's buyer key is Foundation-operated and the OCR agent's supplier key is HAL8-operated/);
  assert.equal(pipeline.match(/both Foundation-operated/), null);
  assert.match(DESIGN, /the Pipeline's buyer key Foundation-operated, the OCR agent's supplier key HAL8-operated/);
  // The hiring rule is stated as an allowlist. No reason about what a backend is made of appears on a public surface.
  assert.ok(section(pipeline, 'Interface').includes("The Pipeline's OCR hop hires only the allowlisted first-party OCR advert."));
  assert.ok(DESIGN.includes("The Pipeline's OCR hop hires only the allowlisted first-party OCR advert."));
  for (const text of [pipeline, DESIGN]) assert.equal(text.match(/subscription|proxy/i), null);
  assert.match(section(pipeline, 'Operator and data handling'), /Direct hire of the OCR agent by outsiders is out of scope for this programme/);
  assert.equal(pipeline.match(/not offered to outsiders/), null); // the OCR advert is Active on the public indexer
  assert.ok(read('advocate').includes('"This brief argues one side only, by design, and omits counter-arguments."'));
  assert.equal(read('advocate').split('This brief argues one side only, by design, and omits counter-arguments.').length - 1, 3); // the rule, the shape and the example
});

// ---- Document Pipeline: built on 2026-10-15, registered, staked and advertised on 2026-10-16, DEPLOYED since 2026-10-16 ----
// The service is built and its tests replay a stub marketplace and a fake chain. It has had a registry record, a stake and an advert since 2026-10-16, runs on the operator's host and has settled one first-party job, so the word is DEPLOYED, never LIVE.
// The page says what is built and what is not, and the words of the design that it was before the build do not come back. agents/document-pipeline/test/spec.test.ts holds the rest of the
// page to the code and the manifest: the gap sentences, the numbers, the response example, the error codes.
const DP_PARAGRAPH = "The service is built. Its tests replay a stub marketplace and a fake chain. It is deployed on the operator's host, has had a registry record since 2026-10-16 and has had an advert since 2026-10-16. One first-party job has settled, on 2026-10-16; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE.";

test('specs/document-pipeline.md: the Status line is DEPLOYED since 2026-10-16, the paragraph says what is built, what runs and that nothing is LIVE, and the words of the design do not come back', () => {
  const text = read('document-pipeline');
  assert.equal(section(text, 'Status').trim(), `${DP_STATUS}\n\n${DP_PARAGRAPH}`);
  assert.equal(text.match(/PROPOSED \(not built\)|This page is a design|There is no code|None of this is built|Illustrative|How it buys \(design\)|No releases|The planned folder|Not built\. Everything/), null, 'the words of before the build do not come back');
  assert.ok(section(text, 'Identity').includes(`\n${DP_HAS_RECORD}\n`), 'the agent has had a registry record since 2026-10-16');
  // The Advert line of the Links is pinned above, with the registration and the advert. The Manifest line (with the link to the template) and the Source line are here.
  const links = section(text, 'Links').split('\n');
  for (const line of [
    '- Manifest: `GET /agent.json` on the agent\'s public URL, in service as of 2026-10-16. The service renders it from its environment when it starts. The template is [agents/document-pipeline/agent.json.template](../agents/document-pipeline/agent.json.template).',
    '- Source: [agents/document-pipeline](../agents/document-pipeline)',
  ]) assert.ok(links.includes(line), line);
  for (const path of ['agents/document-pipeline', 'agents/document-pipeline/agent.json.template']) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`);
});

// The rules for the extraction schema are the code's (agents/document-pipeline/src/extract.ts): the keywords it refuses, the three bounds, the root $async and the own __proto__.
const EXTRACT_SRC = readFileSync(new URL('../agents/document-pipeline/src/extract.ts', import.meta.url), 'utf8');
const extractNumber = (name) => Number((new RegExp('export const ' + name + ' = ([0-9_]+);').exec(EXTRACT_SRC)?.[1] ?? 'NaN').replaceAll('_', ''));
const extractList = (name) => [...(EXTRACT_SRC.split('\n').find((l) => l.startsWith(`const ${name} = [`)) ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);

test('specs/document-pipeline.md: the extraction schema rules name the keywords the code refuses and the bounds it holds, strict draft-07, the cost that is not bounded, and what a schema_valid false result keeps', () => {
  const rules = section(read('document-pipeline'), 'Interface').split('\n### The extraction schema\n')[1]?.split('\n### ')[0] ?? '';
  assert.ok(rules.length > 1500, 'the subsection exists');
  const refused = [...extractList('REFERENCES'), ...extractList('EXPRESSIONS')];
  assert.deepEqual(refused, ['$ref', '$dynamicRef', '$recursiveRef', '$id', '$defs', 'definitions', 'pattern', 'patternProperties', 'format'], 'the keywords of the code');
  const refusedLine = rules.split('\n').find((l) => l.startsWith('- Refused anywhere in the schema:')) ?? '';
  for (const keyword of refused) assert.ok(refusedLine.includes('`' + keyword + '`'), `${keyword} is refused on the page`);
  assert.deepEqual([extractNumber('SCHEMA_MAX_BYTES'), extractNumber('SCHEMA_MAX_DEPTH'), extractNumber('COMBINATION_MAX_ENTRIES')], [16384, 32, 16]);
  for (const part of [
    'a JSON Schema of draft-07, read in strict mode: a keyword the validator does not know is refused.',
    'refused with `schema_invalid` (400), before anything is fetched or posted, so it locks nothing.',
    '- A name is not a keyword. A property called `format` or `pattern` under `properties` is fine, and so are those words inside `const`, `enum`, `default` and `examples`.',
    '- An own `__proto__` key is refused anywhere in the schema, `const`, `enum`, `default` and `examples` included.',
    '- `$async` at the root is refused, `true` or `false`.',
    '- At most 16384 bytes of JSON (the schema as parsed, written out again) and 32 levels of nesting, data included. At most 16 entries in each `anyOf`, `oneOf` and `allOf`.',
    'The cost of a check still grows with the size of the answer times the size of the schema, and `uniqueItems` compares items pairwise.',
    'When the answer is not JSON, or does not validate against the schema, the job still succeeds and settles like any other, and the result is `{ "extraction": null, "schema_valid": false, "raw_text": "<the answer as received>" }`.',
  ]) assert.ok(rules.includes(part), `the schema rules say: ${part}`);
});

test('the four specs, the guide and the README agree on what is built: Agent History, Document Pipeline, Audio Snippets and Advocate DEPLOYED', () => {
  const byStatus = (re) => Object.entries(AGENTS).filter(([, a]) => re.test(a.status)).map(([name]) => name).sort();
  assert.deepEqual(byStatus(/^DEPLOYED \(/), ['advocate', 'agent-history', 'audio-snippets', 'document-pipeline']);
  assert.deepEqual(byStatus(/^PROPOSED \(built, not deployed\)\./), [], 'no agent is built and waiting any more');
  assert.deepEqual(byStatus(/^PROPOSED \(not built\)\./), [], 'no agent is specified and not built any more');
  // Each spec carries its own status line in its Status section, alone on a line, and no spec has the line of before its flip.
  for (const [name, { status }] of Object.entries(AGENTS)) assert.ok(section(read(name), 'Status').split('\n').includes(status), `${name}: the status line, alone on its line`);
  for (const name of Object.keys(AGENTS)) assert.equal(section(read(name), 'Status').match(/PROPOSED|not deployed/), null, `${name}: the line of before its flip is gone`);
  // The guide says it in a sentence and in the rows of its table, and the root README keeps its table: DEPLOYED for the four.
  assert.ok(hire().includes('This guide hires Agent History, and section 5 shows what changes for Document Pipeline, for Audio Snippets and for Advocate.'));
  const tableRows = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n');
  for (const [name, { capability }] of Object.entries(AGENTS)) assert.ok(tableRows.some((l) => l.endsWith(`| \`${capability}\` | DEPLOYED |`)), `${name}: its row of the README table`);
});

// ---- The member guide (docs/HIRE.md) and the E2E runbook (docs/E2E.md) ----
// They are read by people who act on them, so their numbers, tool names and wording are pinned here against the specs and the design.
const doc = (name) => readFileSync(new URL(`../docs/${name}`, import.meta.url), 'utf8');
const hire = () => doc('HIRE.md');
const e2eScript = () => readFileSync(new URL('./e2e-hire.mjs', import.meta.url), 'utf8');
const HIRE_SECTIONS = ['What you will end up with', 'Get a key', 'What the key must hold', 'Two lines of config', 'The chat script', 'Read your receipt', 'Register your own identifier (optional)', 'The terminal path', 'When it goes wrong', 'Honesty box'];
// The signer is published on npm (2026-10-16): version 2.0.0, whose build/index.js is identical to the build of packages/signer at mcp-server main, commit 651ae93. Every npx command of the guide, the runbook and the README pins that version, so that a later release cannot change what a reader runs.
const SIGNER_PACKAGE = '@apexfusion/vector-mcp-signer';
const SIGNER_VERSION = '2.0.0';
const SIGNER_COMMIT = '651ae93';
const SIGNER_NPX = `npx -y ${SIGNER_PACKAGE}@${SIGNER_VERSION}`;
const CHAT_SCRIPT = [
  '1. "List the marketplace capabilities on Vector."',
  '2. "Show me free suppliers for identity.history.report.v1."',
  '3. "Hire the first one. Payload: {"subject":"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db"}. Use my signer address as changeAddress, sign, submit and wait for confirmation."',
  '4. "Send the job with the same payload, then poll until it is done. Use my signer address as buyerAddress in both calls."',
  '5. "Verify the receipt. If every check passes, accept, sign, submit and wait."',
  '6. "Show me the receipt, the signature, the escrow reference and explorer links for the post and the accept."',
];
// The nine marketplace tools are read from the design spec, so a renamed tool fails here before it fails in a member's chat.
const MARKETPLACE_TOOLS = [...new Set(DESIGN.match(/\bvector_(?:build_)?marketplace_[a-z_]+/g))].sort();
const OTHER_TOOLS = ['vector_signer_get_address', 'vector_signer_decode_transaction', 'vector_signer_sign', 'vector_signer_get_spend_limits', 'vector_submit_transaction', 'vector_await_transaction', 'vector_build_register_agent', 'vector_build_deregister_agent', 'vector_get_utxos', 'vector_get_balance'];
const designEndpoint = (label) => new RegExp(label + ' `([^`]+)`').exec(DESIGN)?.[1];
const AGENT_SPEC = { 'Agent History': 'agent-history', 'Audio Snippets': 'audio-snippets', Advocate: 'advocate', 'Document Pipeline': 'document-pipeline' };
// What the guide, the runbooks, the script and the four specs said until 2026-10-14, when the nine tools were seen on the hosted mainnet server: a wait for a cutover,
// 24 tools, none of the nine on the server. None of it may be written again, so one pattern is held against all of them (see the last test of this file).
const WAITS_FOR_CUTOVER = /cutover|cut over|cuts it over|24 tools|none of them a marketplace tool|none of the marketplace tools|awaiting the|merged, awaiting|has them only after|still serves/i;

test('docs/HIRE.md: the ten sections of the design, numbered, in the order the member does them; the first paragraph says the guide is for anyone with a chat client and a key, written for a working-group member first', () => {
  assert.deepEqual([...hire().matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), HIRE_SECTIONS.map((title, i) => [i + 1, title]));
  assert.ok(hire().startsWith('# '), 'starts with a title');
  assert.ok(hire().split('\n')[2].startsWith('A guide for anyone with a chat client and a key. It was written for a working-group member first. You use a chat client that has two MCP servers connected'), 'the first paragraph');
  assert.equal(hire().match(/A guide for a working-group member/), null, 'the words of before');
});

test('docs/HIRE.md: the chat script is verbatim, six lines in one block, inside section 5', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes('```text\n' + CHAT_SCRIPT.join('\n') + '\n```'), 'the six lines, in order, in one fenced block');
});

// The guide has two request JSONs: message 3 of the chat script (Agent History's, a subject) and the one for Document Pipeline in the subsection of section 5 (a one-page PDF by URL).
test('docs/HIRE.md: sends the member to section 5 for Document Pipeline, Audio Snippets and Advocate; section 5 gives the Pipeline a second request JSON, the 30 min wait and the time to reclaim', () => {
  const guide = hire();
  assert.ok(guide.includes('This guide hires Agent History, and section 5 shows what changes for Document Pipeline, for Audio Snippets and for Advocate.'));
  // Since the flip of Advocate (2026-10-20) the words of before an advert are nowhere in the guide, its subsection of section 5 included: no agent that is advertised says them again.
  const advocateSub = '\n### The same script for Advocate\n' + (section(guide, '5. The chat script').split('\n### The same script for Advocate\n')[1] ?? '').split('\n### ')[0];
  assert.ok(advocateSub.length > 500, 'the subsection of Advocate is there');
  assert.equal(guide.match(/once it has an advert|no advert yet|until the operator posts one|waits for its deployment|once its advert is posted|cannot be hired until|is built and is not deployed|what will change for it then|it is hired the same way once/i), null, 'the words of before the advert and before the flips');
  // The table is dated with the day of its last row (Advocate, 2026-10-20), in its header and in the status paragraph.
  assert.ok(guide.includes('| Piece | Status on 2026-10-20 |') && guide.includes('and its status table was brought up to date on 2026-10-20.'));
  assert.equal(guide.match(/Three more agents are specified and not built/), null, 'the sentence of before the build');
  const five = section(guide, '5. The chat script');
  const heading = '\n### The same script for Document Pipeline\n';
  assert.ok(five.indexOf(heading) > five.indexOf('If a check fails, do not accept.'), 'a subsection at the end of section 5');
  // The subsection of the Pipeline ends where the one of Audio Snippets begins.
  const sub = (five.split(heading)[1] ?? '').split('\n### ')[0];
  const first = JSON.parse(/Payload: (\{"subject":"[^"]+"\})\./.exec(CHAT_SCRIPT[2])[1]);
  const blocks = [...sub.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, 'one request JSON in the subsection');
  const second = JSON.parse(blocks[0]);
  assert.deepEqual(Object.keys(first), ['subject']);
  assert.deepEqual(second, { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  for (const part of [
    'It has had an advert since 2026-10-16. The six messages are the same, with two changes.',
    'Ask for `document.pipeline.ocr-summary.v1` in message 2, and write this request JSON in messages 3 and 4:',
    'That URL is only an example. Use the https URL of a one-page PDF that anyone may read: its page goes to the OCR agent, and its text to the chat supplier and that supplier\'s model provider. The service fetches the URL itself, so it must be public and must not redirect.',
    'Its processing window is 30 min, so message 4 can wait that long: ask your assistant to poll again whenever a call is cut near 100 s, as in section 9.',
    'If the job fails, you reclaim after `deliver_by`, which is your Post time plus 30 min plus 180 s.',
    'The price is 5 and a job costs about 7 (the cost table in section 3).',
  ]) assert.ok(sub.includes(part), `the subsection says: ${part}`);
  // The wait is the advert's window in the spec, and the reclaim time is that window plus the 180 s of every deliver_by.
  assert.match(section(read('document-pipeline'), 'Terms'), /Processing window, advert `max_processing_ms` \| 1800000 ms \(30 min/);
  assert.ok(sub.indexOf('document.pipeline.ocr-summary.v1') > sub.indexOf('It has had an advert since 2026-10-16.'), 'the capability is asked for after the line that says it is advertised');
  assert.ok(section(hire(), '3. What the key must hold').split('\n').some((l) => l.startsWith('| 5 (Document Pipeline) | 7 | 6 | 1 | about 1 | about 7 | 7 |')), 'the cost table row the subsection points to');
});

test('docs/HIRE.md: the ledger unit is named once, in section 3, and nowhere else in the repo', () => {
  const guide = hire();
  assert.equal(guide.match(UNIT_NAME)?.length, 1);
  assert.ok(section(guide, '3. What the key must hold').includes("the ledger's native unit, " + UNIT_NAME.source));
  // Every other file of the repo says "unit" or prints lovelace. The design spec (docs/superpowers), which quotes the guide's one naming, and the recorded ledger data are not part of this rule.
  const root = fileURLToPath(new URL('../', import.meta.url));
  // The run outputs of docs/E2E.md (git-ignored, repository root) are an operator's files, not the repository: skipped.
  const runOutput = (rel) => /^(evidence\.json(\.tmp)?|e2e-state[^\/]*\.json[^\/]*)$/.test(rel);
  const skip = (rel) => runOutput(rel) || /(^|[\\/])(node_modules|\.git|\.superpowers)([\\/]|$)/.test(rel) || /(^|[\\/])test[\\/]fixtures([\\/]|$)/.test(rel) || rel.startsWith(join('docs', 'superpowers')) || rel === 'pnpm-lock.yaml';
  const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(relative(root, p))) continue; e.isDirectory() ? walk(p, out) : out.push(relative(root, p)); } return out; };
  const hits = walk(root).filter((rel) => /\.(ts|mjs|json|md|yml|yaml|template)$/.test(rel) && rel !== join('docs', 'HIRE.md')).filter((rel) => readFileSync(join(root, rel), 'utf8').match(UNIT_NAME));
  assert.deepEqual(hits, []);
});

// Section 3 of the guide has two ways to get the collateral and the float onto the key since 2026-10-15. The Foundation's way is held word for word (the one sentence that names the unit is in it), in the brand's vocabulary since 2026-10-16. The reader's own way says what a key supplied by hand needs.
const FOUNDATION_WAY = "The Foundation supplies collateral and float for working-group experiments. It sends your address two separate transfers: 5 units alone, then a float of 50. They stay separate on purpose. The Accept and the Reclaim run the escrow script, and each needs a pure 5-unit output as collateral. The Post keeps a pure 5-unit output aside when your wallet has one. A single transfer of the whole amount lets your wallet consume the collateral with the rest. Bonds are posted and fees are consumed in the ledger's native unit, " + UNIT_NAME.source + '. The name appears once, here. The rest of this guide calls it a unit.';

// What the signer reads (packages/signer of Apex-Fusion/mcp-server at 651ae93, the build of the npm package 2.0.0): config.ts takes VECTOR_SIGNER_PRIVATE_KEY with
// VECTOR_SIGNER_ADDRESS first, then a recovery phrase inline or from a file; keysource.ts takes a key that matches /^ed25519e?_sk1[0-9a-z]+$/ with an addr1 address,
// and derives from a recovery phrase the signing key of the first address of one account (index 0 unless set). A raw 64-hex key matches neither, so the sentence of
// before (2026-10-15 to 2026-10-21), which said the signer took only a keygen key and no recovery phrase, was not true, and LAUNCH.md section 5 converts a template key.
const SIGNER_READS = "The signer reads a bech32 key that starts `ed25519_sk1`, the form `keygen` prints, with its `addr1` address, or a wallet's recovery phrase, from which it signs for one address only, the first of one account, but the phrase in your config exposes the whole wallet, so this guide never uses one. It does not read a raw 64-hex key, such as the template's: [LAUNCH.md](LAUNCH.md) section 5 converts one. This guide uses the key from `keygen`, so a wallet's balance has to be sent to the address `keygen` printed.";

test('docs/HIRE.md section 3: two ways to get the collateral and the float onto the key, the Foundation way kept word for word, the own way says Vector mainnet, the key forms the signer reads and 5 alone before the float; the cost table and the check come after both', () => {
  const three = section(hire(), '3. What the key must hold');
  const at = (needle) => { const i = three.indexOf(needle); assert.ok(i >= 0, `section 3 says: ${needle}`); return i; };
  const order = ['There are two ways to get the collateral and the float onto your key. The cost table and the check below apply to both.', "**(a) The Foundation sends a working-group member's key its collateral and float, on request.**", FOUNDATION_WAY, '**(b) Or send them yourself.**', 'What one job costs you.', '| Price (agent) |', 'Check the collateral and the float before you go on.', '(`vector_get_utxos`)'];
  const positions = order.map(at);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the intro, the Foundation way, the own way, the cost, the table and the check: in this order');
  const own = three.slice(at('**(b) Or send them yourself.**'), at('What one job costs you.'));
  for (const part of [
    'The units must be on Vector mainnet.',
    "Units on Prime, on Nexus or in a bridged form elsewhere cannot serve as your key's collateral or float.",
    'The Reactor bridge moves units from Prime to Vector.',
    SIGNER_READS,
    'Send 5 alone first, then the float of 50. That is two transfers, for the reason given in (a).',
  ]) assert.ok(own.includes(part), `the own way says: ${part}`);
  assert.equal(own.match(UNIT_NAME), null, 'the own way says units, the name is in the Foundation way');
  assert.equal(hire().match(/We fund it/), null, 'the title of before');
  // The sentences of before said the signer took only a keygen key and no recovery phrase. Its source takes both forms and refuses raw hex.
  assert.equal(hire().match(/accepts only a key made by `keygen`|does not take a wallet's recovery phrase/), null, 'the sentences of before');
  assert.ok(existsSync(new URL('../docs/LAUNCH.md', import.meta.url)), 'the guide the sentence points to exists');
  assert.match(doc('LAUNCH.md'), /^## 5\. Give your agent an identity from chat$/m, 'and has the section it names');
});

test('docs/HIRE.md and docs/E2E.md: no em or en dash; nothing says LIVE except the sentence that denies it; DEPLOYED only in the status paragraph of each and in the rows of Agent History, Document Pipeline, Audio Snippets and Advocate in the guide', () => {
  for (const name of ['HIRE.md', 'E2E.md']) assert.equal(doc(name).match(DASHES), null, name);
  const guide = hire();
  const e2e = doc('E2E.md');
  assert.ok(guide.includes('Nothing in this guide is LIVE.'));
  assert.equal(guide.replace('Nothing in this guide is LIVE.', '').match(/\bLIVE\b/g), null);
  assert.equal(e2e.match(/\bLIVE\b/g), null);
  // DEPLOYED is said where the status of the agent is given: the status paragraph of each document and the row of the guide's table. Nowhere else, and each place gives the facts in the same words.
  const statusOf = (text) => text.split('\n').find((l) => l.startsWith('**Status: ')) ?? '';
  const row = guide.split('\n').find((l) => l.startsWith('| Agent History, capability ')) ?? '';
  const dpRow = guide.split('\n').find((l) => l.startsWith('| Document Pipeline, capability ')) ?? '';
  const asRow = guide.split('\n').find((l) => l.startsWith('| Audio Snippets, capability ')) ?? '';
  const adRow = guide.split('\n').find((l) => l.startsWith('| Advocate, capability ')) ?? '';
  assert.ok(statusOf(guide).startsWith(`**Status: DEPLOYED.** Agent History is ${AH_STATUS} Nothing in this guide is LIVE. `));
  assert.ok(statusOf(e2e).startsWith(`**Status: DEPLOYED.** Agent History is ${AH_STATUS} The path is proven first-party, which is not demand. Document Pipeline is ${DP_STATUS} Audio Snippets is ${AS_STATUS} Advocate is ${AD_STATUS} `));
  assert.ok(row.includes(`| ${AH_STATUS} `));
  assert.ok(dpRow.includes(`| ${DP_STATUS} `));
  assert.ok(asRow.includes(`| ${AS_STATUS} `));
  assert.ok(adRow.includes(`| ${AD_STATUS} `));
  assert.equal(guide.replace(statusOf(guide), '').replace(row, '').replace(dpRow, '').replace(asRow, '').replace(adRow, '').match(/\bDEPLOYED\b/g), null);
  assert.equal(e2e.replace(statusOf(e2e), '').match(/\bDEPLOYED\b/g), null);
});

test('docs/HIRE.md: the request JSON and the wire payload are named apart, as in the specs', () => {
  const five = section(hire(), '5. The chat script');
  assert.ok(five.includes(WIRE_PAYLOAD), 'section 5 defines the wire payload');
  assert.match(five, /wrap the request JSON into the wire payload/);
  assert.equal(hire().match(/payload is the request JSON/i), null);
  assert.match(section(hire(), '8. The terminal path'), /holds the request JSON, and the buyer wraps it into the wire payload/);
});

// Only the buyer's bond comes back on Accept. The supplier receives the price and the supplier bond, and a Release hands the supplier everything that is locked.
// These phrasings say otherwise: both bonds returning, a bond "returned", the supplier getting its own bond back.
const BONDS_RETURN = /both bonds (return|come back|are returned)|bonds? (are )?returned|returned on accept|bonds back|own bond|its bond back/i;

test('docs/HIRE.md: who receives what on Accept, Release and Reclaim', () => {
  const three = section(hire(), '3. What the key must hold');
  assert.ok(three.includes('On Accept the supplier receives the price and the supplier bond, and your bond returns to you.'));
  // One sentence, one unit: the Accept window is 600 s, and a Release hands the supplier everything that is locked, the buyer bond included.
  assert.ok(three.includes("If you do not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and keep everything that is locked: the price and both bonds, your buyer bond included."));
  assert.equal(three.match(/may Release/g)?.length, 1, 'said once');
  assert.equal(hire().match(/\b600000 ms\b/), null, 'the guide gives the window in seconds everywhere');
  assert.ok(three.includes('If the supplier never submits, you reclaim the price and both bonds after `deliver_by`.'));
});

test('the guide, the four specs and the E2E runbook never say that both bonds return or that the supplier gets a bond back', () => {
  const texts = [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')], ...Object.keys(AGENTS).map((name) => [`specs/${name}.md`, read(name)])];
  assert.equal(texts.length, 6);
  for (const [name, text] of texts) assert.equal(text.match(BONDS_RETURN), null, name);
  // The pattern finds each wording it exists for, among them the sentence that was wrong in specs/agent-history.md.
  for (const wrong of ['On Accept the supplier is paid the price and gets its own bond back.', 'the supplier gets its bond back', 'both bonds return', 'both bonds come back', 'the bonds are returned', 'returned on Accept', 'the bonds back']) assert.match(wrong, BONDS_RETURN, wrong);
  for (const right of ["the buyer's bond returns to the buyer", 'your bond returns to you', 'your bond of 1 comes back']) assert.doesNotMatch(right, BONDS_RETURN, right);
});

test('specs/agent-history.md: on Accept the supplier receives the price and the supplier bond, and the buyer bond returns to the buyer', () => {
  const terms = section(read('agent-history'), 'Terms');
  assert.ok(terms.includes("On Accept the supplier receives the price and the supplier bond, and the buyer's bond returns to the buyer."));
  assert.ok(terms.includes('the supplier may Release the escrow and take the price and both bonds'));
  assert.ok(terms.includes('If the supplier never submits, the buyer reclaims after `deliver_by`.'));
});

test('docs/HIRE.md: the cost table is the escrow arithmetic, with the prices of the four specs', () => {
  const rows = [...section(hire(), '3. What the key must hold').matchAll(/^\| (\d+) \(([^)]+)\) \| (\d+) \| (\d+) \| (\d+) \| about (\d+) \| about (\d+) \| (\d+) \|$/gm)];
  assert.deepEqual(rows.map((m) => m[2]).sort(), Object.keys(AGENT_SPEC).sort(), 'one row for each agent');
  for (const [, price, agent, lock, supplier, back, fees, pay, jobs] of rows) {
    const terms = section(read(AGENT_SPEC[agent]), 'Terms');
    const unit = (label) => Number(terms.match(new RegExp('[|] ' + label + ' [|] ([0-9]+) '))?.[1]) / 1_000_000;
    assert.equal(Number(price), unit('Price'), `${agent}: the price of the spec`);
    assert.equal(Number(lock), unit('Locked by the buyer [(]price and both bonds[)]'), `${agent}: the lock is price plus both bonds`);
    assert.equal(Number(supplier), unit('Price') + unit('Supplier bond'), `${agent}: the supplier receives the price and the supplier bond`);
    assert.equal(Number(back), unit('Buyer bond'), `${agent}: only the buyer bond comes back`);
    assert.equal(Number(fees), 1, `${agent}: fees about 1 across Post and Accept`);
    assert.equal(Number(pay), Number(lock) - Number(back) + Number(fees), `${agent}: what an accepted job costs the buyer`);
    assert.equal(Number(jobs), Math.floor(50 / Number(pay)), `${agent}: accepted jobs per float of 50`);
  }
});

test('docs/HIRE.md and the design agree on the figures a member types or reads', () => {
  const guide = hire();
  assert.ok(guide.includes(designEndpoint('MCP')), 'the hosted server URL');
  assert.ok(guide.includes(designEndpoint('Ogmios')), 'the Ogmios URL of the terminal path');
  assert.ok(guide.includes(`VECTOR_ZERO_TIME_MS=${DESIGN.match(/Zero time[^|]*[|] `(\d+)`/)[1]}`), 'the genesis time of the terminal path');
  assert.ok(guide.includes('https://explorer.vector.mainnet.apexfusion.org/transaction/hash/<txid>'), 'the explorer link pattern');
  assert.match(DESIGN, /per-transaction cap 100, daily cap 500/);
  assert.ok(guide.includes('"VECTOR_SIGNER_SPEND_LIMIT_PER_TX": "100000000"') && guide.includes('"VECTOR_SIGNER_SPEND_LIMIT_DAILY": "500000000"'), '100 and 500 units, as lovelace');
  assert.ok(guide.includes('c4c378a'), 'the pinned template commit');
  for (const flag of ['--advert-ref', '--endpoint', '--payload-file']) assert.ok(guide.includes(flag), flag);
});

test('docs/HIRE.md: says what is and is not in service, tool by tool', () => {
  const guide = hire();
  assert.equal(MARKETPLACE_TOOLS.length, 9);
  for (const tool of MARKETPLACE_TOOLS) assert.ok(guide.includes('`' + tool + '`'), tool);
  const row = (needle) => guide.split('\n').find((l) => l.startsWith('|') && l.includes(needle)) ?? '';
  // The nine tools are merged into main (2026-10-14) and are on the hosted mainnet server (33 tools, seen with an MCP handshake the same day): said for each PR, with its link.
  const onServer = 'merged into `main` on 2026-10-14, on the hosted mainnet server: ';
  assert.ok(row('vector_marketplace_list_capabilities').includes('PR 1, ' + onServer + '[Apex-Fusion/mcp-server#20](https://github.com/Apex-Fusion/mcp-server/pull/20)'));
  assert.ok(row('vector_build_marketplace_post_escrow').includes('PR 2, ' + onServer + '[Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21)'));
  assert.ok(row('vector_marketplace_send_job').includes('PR 3, merged into `main` on 2026-10-14 with PR 2, on the hosted mainnet server: [Apex-Fusion/mcp-server#23](https://github.com/Apex-Fusion/mcp-server/pull/23)'));
  // PR 4 (the signer with its keygen command) is merged into main (2026-10-14) and the package is published on npm (2026-10-16). The row gives the version, the day, who published it and what its build is identical to, and no more.
  const signerRow = row('@apexfusion/vector-mcp-signer');
  assert.ok(signerRow.includes('PR 4, merged into `main` on 2026-10-14: [Apex-Fusion/mcp-server#22](https://github.com/Apex-Fusion/mcp-server/pull/22). The package is published on npm as version 2.0.0, on 2026-10-16, by the Foundation\'s maintainers. Its `build/index.js` is identical to the build of `packages/signer` at `main` commit `651ae93`.'));
  assert.equal(signerRow.match(/not published/), null, 'the words of before the publication');
  // Agent History is DEPLOYED since 2026-10-15 (RUNBOOK step 17): the row gives the facts and the current advert reference in full, and says the URL is in service. It does not name the retired advert.
  const agentRow = row('identity.history.report.v1');
  assert.ok(agentRow.includes(`| ${AH_STATUS} The advert reference is \`${AH.advertRef}\`, listed as Active and free on 2026-10-15.`));
  assert.ok(agentRow.includes('The public URL, `https://mp-suppliers-history.hal8.ai`, is in service as of 2026-10-14.'));
  assert.equal(agentRow.includes(AH.firstAdvertTx), false, 'the retired advert is not the one the guide gives');
  assert.equal(guide.match(/<ADVERT_REF>|placeholder|not yet advertised|not in service/i), null, 'the words of before the advert');
  // The first-party runs of the path: one for each deployed agent, each a row of the Results table of docs/E2E.md with its evidence file. A first-party run is not demand.
  const serverRow = row('mcp.vector.mainnet.apexfusion.org');
  assert.ok(serverRow.includes('Running, v2.0.0, 33 tools. All nine marketplace tools are on it, checked on 2026-10-14 with an MCP `initialize` and `tools/list` handshake. Four first-party runs of the path are recorded, one for each deployed agent: on 2026-10-15 (Agent History), 2026-10-16 (Document Pipeline), 2026-10-17 (Audio Snippets) and 2026-10-20 (Advocate), each in the Results table of [docs/E2E.md](E2E.md) with its evidence file. A first-party run is not demand.'));
  const runs = doc('E2E.md').split('\n').filter((l) => /^\| 20\d\d-/.test(l)).map((l) => l.split(' | ').slice(0, 2).map((cell) => cell.replace(/^\| /, '')));
  assert.deepEqual(runs, [['2026-10-15', 'Agent History'], ['2026-10-16', 'Document Pipeline'], ['2026-10-17', 'Audio Snippets'], ['2026-10-20', 'Advocate']], 'the runs the row counts are the rows of the Results table');
  assert.equal(runs.length, Object.values(AGENTS).filter((a) => a.status.startsWith('DEPLOYED ')).length, 'one run for each deployed agent');
  for (const [date, agent] of runs) assert.ok(serverRow.includes(`${date} (${agent})`), `the row names the run of ${agent}`);
  assert.deepEqual(readdirSync(new URL('../docs/evidence/', import.meta.url)).sort(), ['2026-10-15-agent-history-run-1.json', '2026-10-16-document-pipeline-run-1.json', '2026-10-17-audio-snippets-run-1.json', '2026-10-20-advocate-run-1.json'], 'and each run has its evidence file');
  assert.equal(serverRow.match(/(One|Three) first-party runs? of the path (is|are) recorded/), null, 'the counts of before');
  assert.match(row('Hosted testnet instance'), /Updates itself from `main`, so it lists the marketplace tools\. It reads the mainnet marketplace indexer with the testnet Koios/);
  assert.equal(guide.match(/Open PR 1|PR 2 open|PR 3, planned|PR 4, planned|stacked on #20/), null, 'the statuses of before the merge');
  assert.equal(guide.match(WAITS_FOR_CUTOVER), null, 'nothing in the guide waits for a cutover');
});

test('docs/HIRE.md, docs/E2E.md and scripts/e2e-hire.mjs: every tool named is in the design or on the hosted server today', () => {
  const known = new Set([...MARKETPLACE_TOOLS, ...OTHER_TOOLS]);
  for (const [name, text] of [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')], ['scripts/e2e-hire.mjs', e2eScript()]]) {
    const unknown = [...new Set(text.match(/\bvector_[a-z_]+/g) ?? [])].filter((t) => !known.has(t));
    assert.deepEqual(unknown, [], `${name} names a tool that is not known`);
  }
  for (const tool of MARKETPLACE_TOOLS) assert.ok(e2eScript().includes(tool), `the script uses ${tool}`);
});

test('docs/E2E.md: every run is marked first-party, the commands are exact, and every setting the script reads is explained', () => {
  const e2e = doc('E2E.md');
  assert.ok(e2e.startsWith('# '), 'starts with a title');
  assert.match(e2e, /first-party/);
  assert.ok(e2e.includes('node scripts/e2e-hire.mjs --dry-run') && e2e.includes('node scripts/e2e-hire.mjs\n'));
  const table = e2e.split('\n').filter((l) => l.startsWith('|'));
  const results = table.slice(table.findIndex((l) => l.startsWith('| Date |')));
  assert.equal(results[0], '| Date | Agent | Run | Escrow reference | Post transaction | Accept transaction | Verdict |');
  for (const row of results.slice(2)) {
    assert.equal(row.split('|')[3].trim(), 'first-party', `a run row says first-party: ${row}`);
    assert.ok(Object.keys(AGENT_SPEC).includes(row.split('|')[2].trim()), `a run row names the agent that was hired: ${row}`);
  }
  const settings = [...new Set([...e2eScript().matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g), ...e2eScript().matchAll(/need\('([A-Z][A-Z0-9_]+)'\)/g)].map((m) => m[1]))];
  assert.ok(settings.length >= 5, 'the script reads its settings from the environment');
  for (const name of settings) assert.ok(e2e.includes('`' + name + '`'), `docs/E2E.md explains ${name}`);
});

// The script takes the capability as a setting (ruling R49), so the first-party run of Document Pipeline uses the same script as Agent History's: docs/E2E.md says which settings change.
test('docs/E2E.md: CAPABILITY_ID is a setting with its default and the Pipeline\'s value, step 3 names it, and the Results table has an Agent column', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(script.includes("const DEFAULT_CAPABILITY = 'identity.history.report.v1';") && script.includes('const CAPABILITY = env.CAPABILITY_ID ?? DEFAULT_CAPABILITY;'), 'the default and the setting');
  assert.ok(script.includes('is not among the free suppliers for ${CAPABILITY}') && script.includes("capability_id: CAPABILITY, limit: 50"), 'the free list and the stop use it');
  const rows = e2e.split('\n').filter((l) => l.startsWith('| `'));
  const names = rows.map((l) => l.split('`')[1]);
  assert.equal(names.indexOf('CAPABILITY_ID'), names.indexOf('ADVERT_REF') + 1, 'the row follows ADVERT_REF');
  assert.equal(names.indexOf('PAYLOAD'), names.indexOf('CAPABILITY_ID') + 1, 'and the row of PAYLOAD follows it');
  const row = rows.find((l) => l.startsWith('| `CAPABILITY_ID` |')) ?? '';
  for (const part of [
    'The capability of the advert, as the marketplace lists it. Default: `identity.history.report.v1`, the capability of Agent History.',
    'stops unless `ADVERT_REF` is among them, so an advert of another agent needs its own value: `document.pipeline.ocr-summary.v1` for Document Pipeline, `audio.transcript.snippets.v1` for Audio Snippets, `research.advocate.onesided.v1` for Advocate.',
    'An empty value, or one with a space in it, stops the script with exit code 2.',
  ]) assert.ok(row.includes(part), `the CAPABILITY_ID row says: ${part}`);
  assert.ok(rows.find((l) => l.startsWith('| `ADVERT_REF` |')).includes('It must be among the free suppliers of `CAPABILITY_ID`, or the script stops.'));
  assert.ok(rows.find((l) => l.startsWith('| `PAYLOAD` |')).includes('For Document Pipeline, a request for one page of a PDF by URL, as under "Hiring Document Pipeline".'));
  assert.ok(e2e.includes('3. Reads the free suppliers of `CAPABILITY_ID` (default `identity.history.report.v1`) with `vector_marketplace_list_suppliers`, and stops unless `ADVERT_REF` is among them.'));
  assert.equal(e2e.includes('3. Reads the free suppliers of `identity.history.report.v1` with'), false, 'step 3 of before');
  assert.ok(e2e.includes('The Agent column names the agent that was hired, and the Run column says first-party in every row.'));
});

test('docs/E2E.md: the section "Hiring Document Pipeline" gives the settings of its first-party run: its capability, a request for one page of a PDF by URL, a pause of 15 s, a state file of its own, up to 10 minutes', () => {
  const e2e = doc('E2E.md');
  const sec = section(e2e, 'Hiring Document Pipeline');
  assert.ok(sec.length > 900, 'the section exists');
  assert.ok(e2e.indexOf('\n## Hiring Document Pipeline\n') > e2e.indexOf('\n## The commands\n') && e2e.indexOf('\n## Hiring Document Pipeline\n') < e2e.indexOf('\n## What the script does\n'), 'after the commands, before the steps');
  const exported = Object.fromEntries((/```bash\n([\s\S]*?)\n```/.exec(sec)?.[1] ?? '').split('\n').map((l) => /^export ([A-Z0-9_]+)=(.*)$/.exec(l)).map((m) => [m[1], m[2]]));
  assert.deepEqual(Object.keys(exported), ['CAPABILITY_ID', 'ADVERT_REF', 'PAYLOAD', 'E2E_POLL_MS', 'E2E_STATE']);
  assert.equal(exported.CAPABILITY_ID, AGENTS['document-pipeline'].capability);
  assert.equal(exported.E2E_POLL_MS, '15000');
  assert.equal(exported.E2E_STATE, './e2e-state-pipeline.json');
  assert.equal(exported.ADVERT_REF, '<txid>#<index>');
  assert.ok(exported.PAYLOAD.startsWith("'") && exported.PAYLOAD.endsWith("'"), 'the request JSON is quoted for the shell');
  assert.deepEqual(JSON.parse(exported.PAYLOAD.slice(1, -1).replace('<https URL of a one-page public PDF>', 'https://example.org/letter.pdf')), { source: { url: 'https://example.org/letter.pdf' }, task: 'summary', language: 'en', max_pages: 1 });
  for (const part of [
    'The script hires any agent whose advert is among the free suppliers of `CAPABILITY_ID`, with the same steps. Document Pipeline has been advertised since 2026-10-16, and its first first-party run settled that day (see [Results](#results)).',
    'Use a document that anyone may read: its page goes to the OCR agent, and Datalab behind it, and its text to the chat supplier and that supplier\'s model provider.',
    'a job takes minutes where Agent History\'s takes seconds, and the default pause of 5 s would ask the hosted server about 120 times in 10 minutes.',
    'a state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of the Agent History run.',
    'Expect up to 10 minutes for one page. The script polls until `deliver_by`, which is 33 minutes after the Post (the 30 min window and 180 s). Five pages take up to 27 min.',
    'Then run the rehearsal and the run as above. With the key-file wrapper, export these settings in the shell first: it passes the environment on, and its default `ADVERT_REF` is the Agent History advert.',
    'Add the run to the Results table with Document Pipeline in the Agent column. It is first-party and it is not demand.',
  ]) assert.ok(sec.includes(part), `the section says: ${part}`);
  // The wrapper does what the section says: it exports a default for ADVERT_REF only, and the script inherits the rest of the environment.
  const wrapper = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(wrapper.includes('export ADVERT_REF="${ADVERT_REF:-'));
  assert.equal(/^\s*(export\s+)?CAPABILITY_ID=/m.test(wrapper), false, 'the wrapper sets no capability of its own: CAPABILITY_ID comes from the environment');
  // The pause that the section calls the default is the one the script has, read from it: 10 minutes at that pause ask the hosted server about 120 times.
  const pause = Number(/POLL_MS = env\.E2E_POLL_MS === undefined \? (\d+) :/.exec(e2eScript())?.[1]);
  assert.equal(Math.round(10 * 60 * 1000 / pause), 120);
});

test('docs/E2E.md and scripts/run-e2e-from-keyfile.sh: the runbook opens for every agent, the state file is the one E2E_STATE names, and the wrapper says so when a run stops', () => {
  const e2e = doc('E2E.md');
  const wrapper = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(e2e.split('\n')[2].startsWith('Before any working-group member is invited, the operator hires each of our agents itself, through the same tools a member will use. Agent History comes first, and Document Pipeline, Audio Snippets and Advocate follow (see "Hiring Document Pipeline", "Hiring Audio Snippets" and "Hiring Advocate").'));
  for (const heading of ['Hiring Document Pipeline', 'Hiring Audio Snippets', 'Hiring Advocate']) assert.ok(e2e.includes(`\n## ${heading}\n`), `the section the opening names: ${heading}`);
  assert.equal(e2e.split('\n')[2].includes('hires Agent History itself'), false, 'the opening of before the second agent');
  assert.ok(e2e.includes('A run of Agent History costs about 3 of the float, and a run of Document Pipeline about 7 (see the cost table in [HIRE.md](HIRE.md)).'));
  assert.ok(e2e.includes('and the state file is the one `E2E_STATE` names (`e2e-state.json` by default), as above.'));
  assert.equal(e2e.includes('and the state file is `e2e-state.json`, as above'), false, 'the Pipeline run names a state file of its own');
  assert.ok(wrapper.includes('echo "run stopped with exit code $rc (state kept in ${E2E_STATE:-e2e-state.json})" >&2'));
  assert.equal(wrapper.includes('(state kept in e2e-state.json)'), false);
  assert.ok(wrapper.includes('it and the state file (e2e-state.json, or the file E2E_STATE names) are git-ignored.'));
  assert.ok(wrapper.includes('CAPABILITY_ID, E2E_STATE, E2E_POLL_MS and PAYLOAD pass through from the environment'));
  // The wrapper has a default for ADVERT_REF and none for SIGNER_ENTRY: it stops when SIGNER_ENTRY is not set, and when it names no file.
  assert.ok(wrapper.includes(': "${SIGNER_ENTRY:?set SIGNER_ENTRY to the built signer,'));
  assert.ok(wrapper.includes('[ -f "$SIGNER_ENTRY" ] || { echo "signer build not found: $SIGNER_ENTRY" >&2; exit 2; }'));
  assert.ok(e2e.includes('`SIGNER_ENTRY` and `ADVERT_REF` come from the environment, as the table says. The wrapper has a default for `ADVERT_REF`, the Agent History advert, and none for `SIGNER_ENTRY`: it stops when `SIGNER_ENTRY` is not set, and with exit code 2 when it names no file.'));
  assert.equal(e2e.includes('The wrapper has a default for each'), false, 'the sentence of before, which gave SIGNER_ENTRY a default');
  // The default in the message is the script's own, and git ignores both files, the state file of the Pipeline run included.
  assert.ok(e2eScript().includes("env.E2E_STATE ?? 'e2e-state.json'"));
  const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n');
  const glob = (pattern) => new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.]/g, '[.]')).join('.*') + '$');
  assert.ok(ignored.includes('evidence.json') && ignored.includes('e2e-state*.json*'));
  for (const file of ['e2e-state.json', 'e2e-state-pipeline.json']) assert.ok(glob('e2e-state*.json*').test(file), `${file} is ignored`);
});

test('docs/HIRE.md and docs/E2E.md: every place that lists what the receipt check takes lists the report text', () => {
  for (const [name, body] of [['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')]]) {
    // A line that talks about running or repeating the check and names the signature and the escrow reference lists its inputs. Without the report text the response-hash check does not run.
    const lists = body.split('\n').filter((l) => /verify_receipt|repeat it/.test(l) && /signature/.test(l) && /escrow/.test(l));
    assert.ok(lists.length >= 1, `${name} lists the inputs of the check`);
    for (const l of lists) assert.match(l, /report text|`result`/, `${name}: ${l.slice(0, 100)}`);
  }
});

test('docs/HIRE.md: the status box says what runs today and that there is no audit; the client config file is said to hold the key in plain text', () => {
  const guide = hire();
  const line = 'The hosted mainnet server is running with 33 tools as of 2026-10-14, and all nine marketplace tools are on it. No third-party audit of the marketplace contracts exists.';
  assert.equal(guide.split(line).length - 1, 1, 'once');
  assert.ok(guide.indexOf('**Status: DEPLOYED.**') < guide.indexOf(line) && guide.indexOf(line) < guide.indexOf('| Piece |'), 'inside the status box, above the table');
  const four = section(guide, '4. Two lines of config');
  assert.ok(four.includes('The client config file now holds the raw signer key in plain text.'));
  assert.match(four, /can sign with the key and move what it holds/);
  assert.ok(four.indexOf('in plain text') > four.indexOf('```json') && four.indexOf('in plain text') < four.indexOf('The two limits'), 'after the config, before the limits');
});

test('docs/HIRE.md: the signer is published on npm and section 2 says so; keygen and the client config run version 2.0.0 with npx, and building from source is the alternative, after the npx command', () => {
  const guide = hire();
  const two = section(guide, '2. Get a key');
  const four = section(guide, '4. Two lines of config');
  // The facts in one paragraph: the package, the version, the day, who published it, what its build is identical to, and that anyone can rebuild and compare. No other claim about the package.
  assert.ok(two.includes(`The signer is published on npm as \`${SIGNER_PACKAGE}\`, version ${SIGNER_VERSION}, on 2026-10-16, by the Foundation's maintainers. Its \`build/index.js\` is identical to the build of \`packages/signer\` at Apex-Fusion/mcp-server \`main\`, commit \`${SIGNER_COMMIT}\`, which anyone can rebuild and compare.`));
  const signerRow = guide.split('\n').find((l) => l.startsWith('|') && l.includes(SIGNER_PACKAGE)) ?? '';
  assert.equal([signerRow, two, four].join('\n').match(/\b(secure|audited|safe)\b/i), null, 'no claim of security, audit or safety about the package');
  // The command pins the version, and the note about the name is one line after it.
  const command = '```bash\n' + SIGNER_NPX + ' keygen\n```';
  assert.ok(two.includes(command), 'the npx command of the guide');
  assert.equal(two.match(/^npx /gm)?.length, 1, 'one npx command in the section');
  const note = 'The name is now claimed by the Foundation and the version is pinned, so `npx -y` runs 2.0.0 and no later release.';
  assert.ok(two.includes('\n' + note + '\n'), 'the note, in one line');
  assert.ok(two.indexOf(command) < two.indexOf(note), 'the note follows the command');
  // The alternative: one paragraph and one block, after the npx command, at the commit the package was built from. The comparison is with the tarball of the package.
  const alternative = 'To check the code yourself, or if you cannot run `npx`, build commit `651ae93` from source and run `keygen` from the build. To compare it with the package, run `npm pack @apexfusion/vector-mcp-signer@2.0.0` in an empty folder, unpack the tarball, and compare its `build/index.js` with `packages/signer/build/index.js` of the build:';
  assert.ok(two.includes(alternative + '\n\n```bash\ngit clone https://github.com/Apex-Fusion/mcp-server.git\ncd mcp-server\ngit checkout 651ae93\nnpm ci && npm run build\nnode packages/signer/build/index.js keygen\n```'), 'the build from source, at the commit of the package');
  assert.ok(two.indexOf(note) < two.indexOf(alternative), 'the alternative comes after the npx command and its note');
  // The client config runs the same version with npx; the build from source gets one sentence after the config.
  const config = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  assert.equal(config.mcpServers['vector-signer'].command, 'npx');
  assert.deepEqual(config.mcpServers['vector-signer'].args, ['-y', `${SIGNER_PACKAGE}@${SIGNER_VERSION}`]);
  assert.equal(config.mcpServers.vector.url, designEndpoint('MCP'));
  assert.deepEqual(Object.keys(config.mcpServers['vector-signer'].env), ['VECTOR_SIGNER_PRIVATE_KEY', 'VECTOR_SIGNER_ADDRESS', 'VECTOR_SIGNER_SPEND_LIMIT_PER_TX', 'VECTOR_SIGNER_SPEND_LIMIT_DAILY']);
  assert.ok(four.includes('The signer entry runs the published package with `npx`, at the version pinned in section 2:'));
  assert.ok(four.includes('If you built the signer from source, replace `command` and `args` with `"command": "node"` and `"args": ["<path to mcp-server>/packages/signer/build/index.js"]`.'));
  assert.ok(four.indexOf('```json') < four.indexOf('If you built the signer from source'), 'after the config');
  // Every npx command that names the package names the version too, in the three documents a reader starts from.
  const afterEachCommand = (text) => text.split('npx -y ' + SIGNER_PACKAGE).slice(1);
  for (const [name, text] of [['README.md', readFileSync(new URL('../README.md', import.meta.url), 'utf8')], ['docs/HIRE.md', guide], ['docs/E2E.md', doc('E2E.md')]]) {
    assert.ok(afterEachCommand(text).every((rest) => rest.startsWith('@' + SIGNER_VERSION)), `${name}: every npx command names the version`);
  }
});

// The signer is published on npm, so no document that once said it was not, or told the reader to build it as the only way, says so any more. The manifest of the vendored files names the exception.
test('the signer is published on npm: no document says it is not, tells the reader to wait for it or to build it as the only way; the manifest of the vendored files names the exception', () => {
  const text = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  for (const rel of ['README.md', 'docs/HIRE.md', 'docs/E2E.md', 'deploy/host/RUNBOOK.md', 'deploy/host/RUNBOOK-document-pipeline.md', 'packages/buyer-core/VENDORED-FROM.md']) {
    assert.equal(text(rel).match(/(npx )?package is not published|until the (npx )?package is published|once the package is published|do not run an `npx` command|build the signer from source:|a signer that you build/i), null, `${rel}: the words of before the publication`);
  }
  assert.equal(text('README.md').match(/Clone https:\/\/github.com\/Apex-Fusion\/mcp-server\. In its folder/), null, 'the README no longer opens with the clone');
  assert.ok(text('packages/buyer-core/VENDORED-FROM.md').includes('Apart from the signer, the mcp-server packages are not published to a registry. The signer is published on npm as `@apexfusion/vector-mcp-signer` (version 2.0.0, 2026-10-16), but as a command, with four files: `build/index.js`, `README.md`, `LICENSE.md` and `package.json`. `src/sign.ts` is not among them.'));
});

test('docs/E2E.md: SIGNER_ENTRY is the build/index.js of the signer, from the published package (installed with its dependencies, outside the repository) or from a build of packages/signer; the script starts the file with node', () => {
  const e2e = doc('E2E.md');
  const row = e2e.split('\n').find((l) => l.startsWith('| `SIGNER_ENTRY` |')) ?? '';
  for (const part of [
    'The path of the signer\'s `build/index.js`, from the published package or from a build of `packages/signer` in an `mcp-server` checkout (`npm ci && npm run build`); see "The commands".',
    'The script starts that file as a child process, so it needs the file, not an `npx` command.',
  ]) assert.ok(row.includes(part), `the SIGNER_ENTRY row says: ${part}`);
  const commands = section(e2e, 'The commands');
  assert.equal([row, commands].join('\n').match(/\b(secure|audited|safe)\b/i), null, 'no claim of security, audit or safety about the package');
  const install = `npm install --prefix "$HOME/vector-signer" ${SIGNER_PACKAGE}@${SIGNER_VERSION}`;
  const entry = `export SIGNER_ENTRY="$HOME/vector-signer/node_modules/${SIGNER_PACKAGE}/build/index.js"`;
  assert.ok(commands.includes('From the published package, install it with the dependencies it needs into a folder outside this repository:\n\n```bash\n' + install + '\n```'));
  assert.ok(commands.includes('If you built `packages/signer` from an `mcp-server` checkout instead, skip this and set `SIGNER_ENTRY` to `<path to mcp-server>/packages/signer/build/index.js`.'));
  assert.ok(commands.indexOf(install) < commands.indexOf(entry) && commands.indexOf(entry) < commands.indexOf('node scripts/e2e-hire.mjs --dry-run'), 'install, then the setting, then the rehearsal');
  // The script starts the file it is given with node, so an npx command cannot stand in for it.
  assert.match(e2eScript(), /new StdioClientTransport\(\{ command: process\.execPath, args: \[SIGNER_ENTRY\]/);
});

test('docs/HIRE.md: the keygen output format is not pinned; the escrow minimum is a range; the 90 s limit belongs to the PR 3 tools, not to the wait', () => {
  const guide = hire();
  assert.equal(guide.match(/VECTOR_SIGNER_PRIVATE_KEY=\.\.\./), null, 'no NAME=... line is promised from keygen');
  assert.ok(guide.includes('If keygen prints them as `NAME=value` lines, the value is what follows the `=`.'));
  assert.ok(section(guide, '3. What the key must hold').includes('between 2.2 and 2.3 in an escrow output of this size, depending on the length of the agent'));
  const timeouts = guide.split('\n').find((l) => l.startsWith('| A tool call times out near 100 s')) ?? '';
  assert.ok(timeouts.includes('The PR 3 tools that call a supplier (send job, poll job, verify receipt) stop at 90 s on their own'));
  assert.ok(timeouts.includes('`vector_await_transaction` waits as long as it is asked, up to 300 s'));
  assert.match(guide, /\| The check table says `response_hash` fails \|/);
});

test('docs/E2E.md and scripts/e2e-hire.mjs agree on the send step, the signer settings and the response-hash row', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(e2e.includes('## If the send step was interrupted'));
  assert.ok(script.includes('docs/E2E.md, "If the send step was interrupted"'), 'the script points at that section');
  assert.ok(script.includes('an earlier run called vector_marketplace_send_job and recorded no job id') && e2e.includes('an earlier run called vector_marketplace_send_job'), 'the message the operator sees is the one the runbook quotes');
  assert.match(e2e, /\| Exit code 1, and the message starts "an earlier run called vector_marketplace_send_job" \|/);
  assert.match(e2e, /\| The check by hand says `response_hash` fails \|/);
  // An advert that is no longer free after an earlier run posted the escrow, and a signed transaction that can never land.
  assert.match(e2e, /\| Exit code 1, "is not among the free suppliers", after an earlier run already posted the escrow \|/);
  assert.match(e2e, /\| Exit code 1, and the same transaction is reported as not confirmed on every rerun \|/);
  assert.ok(e2e.includes('every rerun submits that same transaction again') && e2e.includes('mv e2e-state.json e2e-state.old.json'));
  assert.ok(script.includes('An earlier run already posted escrow') && script.includes('is still Open'));
  assert.ok(script.includes('follow the row "is not among the free suppliers" in docs/E2E.md ("If a run stops")'), 'the note for a post that was never confirmed names the row whose way out applies, not the row that says to run the script again');
  const freeRow = e2e.split('\n').find((l) => l.startsWith('| Exit code 1, "is not among the free suppliers", after an earlier run already posted the escrow |')) ?? '';
  for (const text of ['look the post transaction up on the explorer first. If it is there, the escrow is Open and the same steps apply.', 'If it is not there, nothing was posted:', 'a reclaim after `deliver_by`', 'While the advert is not free, running the script again stops at the same check.']) assert.ok(freeRow.includes(text), `the runbook row says ${text}`);
  assert.equal(freeRow.includes('follow the next row'), false, 'the row carries its own way out');
  assert.equal(e2e.match(/never reads/), null, 'the script reads the settings it forwards; it never prints or stores them');
  assert.ok(e2e.includes('The script forwards every `VECTOR_SIGNER_` setting to the signer process it starts.') && e2e.includes('The script never prints or stores the value of a setting.'));
  assert.match(e2e, /`keygen` command \(PR 4, merged into `main` on 2026-10-14; the npx package is published, version 2\.0\.0, and \[HIRE\.md\]\(HIRE\.md\) section 2 has the command\)/);
  assert.ok(e2e.includes('`--dry-run` is the only argument the script takes.'));
  assert.ok(e2e.includes('asks `vector_await_transaction` to wait 90 s at a time, up to four times'));
  assert.match(script, /const AWAIT_SLICE_S = 90;/);
  assert.match(script, /const AWAIT_SLICES = 4;/);
});

test('docs/HIRE.md: PR 2 is merged and its tools are on the hosted mainnet server, with its link; the last message lists the report text, and the lost buyer bond is said in one sentence', () => {
  const guide = hire();
  const row = (needle) => guide.split('\n').find((l) => l.startsWith('|') && l.includes(needle)) ?? '';
  assert.ok(row('vector_build_marketplace_post_escrow').includes('PR 2, merged into `main` on 2026-10-14, on the hosted mainnet server: [Apex-Fusion/mcp-server#21](https://github.com/Apex-Fusion/mcp-server/pull/21)'));
  assert.match(row('| Reads back what it already has |'), /^\| 6 \| .* You hold the report text, the receipt, the signature, the escrow reference and two links\./);
  assert.ok(section(guide, '3. What the key must hold').includes('the supplier may Release the escrow and keep everything that is locked: the price and both bonds, your buyer bond included.'));
});

test('docs/E2E.md and scripts/e2e-hire.mjs: the recovery text reads the escrow by its reference and closes a Submitted first-party escrow in one way', () => {
  const recovery = section(doc('E2E.md'), 'If the send step was interrupted');
  const script = e2eScript();
  const fromScript = script.slice(script.indexOf('function sendInterrupted'), script.indexOf('async function main'));
  assert.ok(recovery.length > 500 && fromScript.length > 500, 'both slices were found');
  for (const [name, text] of [['docs/E2E.md', recovery], ['scripts/e2e-hire.mjs', fromScript]]) {
    assert.ok(text.includes('mp-indexer.vector.apexfusion.org/escrows/') || text.includes('${INDEXER_URL}/escrows/'), `${name}: the one-row read`);
    assert.doesNotMatch(text, /newest row/, name);
    assert.doesNotMatch(text, /accept by hand|Let the (600000 ms|accept) window pass|Do not accept what you cannot verify/i, name);
    for (const word of ['vector_build_marketplace_accept', 'vector_build_marketplace_reclaim', 'posted_at', 'Submitted']) assert.ok(text.includes(word), `${name}: ${word}`);
    assert.match(text, /a Release would hand it to the supplier/, name);
    // PR 2's refusal for an escrow that is spent or not yet indexed, quoted as the tool words it, and one retry before concluding anything.
    assert.ok(text.includes('No live continuation of escrow <escrow') && text.includes('(spent, or not yet indexed); retry or check the explorer.'), `${name}: the refusal of the accept tool`);
    assert.match(text, /ask once more, because the indexer can lag the ledger/, name);
    assert.doesNotMatch(text, /already closed/, name);
  }
  assert.ok(recovery.includes('%23'), 'the # of the reference is written as %23');
  assert.ok(fromScript.includes('encodeURIComponent(post.escrow_ref)'));
});

test('docs/HIRE.md: the receipt check is described as the merged tool answers it, message 4 names buyerAddress, and keygen is run in the member\'s own terminal', () => {
  const guide = hire();
  const six = section(guide, '6. Read your receipt');
  assert.ok(six.includes('runs five checks and one extra row, and reports each as pass, fail or skipped'));
  assert.ok(six.includes('The verdict reads VERIFIED only when every row passes. It reads FAILED when a row fails, and INCOMPLETE when nothing failed but a row was skipped'));
  assert.ok(six.includes('the `prompt_hash` in the receipt equals the `prompt_hash` in the escrow datum'), 'the extra row');
  assert.ok(six.includes('check 2 is skipped and the verdict reads INCOMPLETE, which is never a pass'));
  assert.equal(guide.match(/can still read as a pass|as pass or fail:/), null, 'the wording of before the tool had a skipped state');
  const five = section(guide, '5. The chat script');
  assert.ok(five.includes('`buyerAddress` must be the wallet that posted the escrow and locked its value, which is your signer address.'), 'the table of message 4 says what buyerAddress is');
  const two = section(guide, '2. Get a key');
  assert.ok(two.includes("Run `keygen` in your own terminal, never through your assistant's shell tool."));
  assert.ok(two.includes('so the only copy of the key would reach your model provider'));
  assert.ok(two.indexOf('never through your assistant') < two.indexOf(SIGNER_NPX + ' keygen'), 'said before the first command');
});

test('docs/E2E.md and scripts/e2e-hire.mjs: buyerAddress, the skipped and incomplete wording, and a failed or stalled job checked before it is reclaimed', () => {
  const e2e = doc('E2E.md');
  const script = e2eScript();
  assert.ok(e2e.includes("The send and every poll pass the signer's address as `buyerAddress`"));
  assert.equal((script.match(/buyerAddress: address/g) ?? []).length, 4, 'the send and the poll, in the calls and in the plan');
  assert.ok(e2e.includes('check 2 is skipped, and a skipped row makes the verdict `incomplete`, never a pass'));
  assert.ok(e2e.includes('stops the run before any value moves') && script.includes('if (!state.post?.signed_cbor) for (const [name, args] of stepsOf('), 'a fresh run checks its arguments first');
  const row = e2e.split('\n').find((l) => l.startsWith('| Exit code 1 | A step failed.')) ?? '';
  assert.doesNotMatch(row, /If the job failed or `deliver_by` passed, reclaim/);
  for (const word of ["the supplier's Submit may still land", 'vector_build_marketplace_accept', '`seconds_left`', '600 s', 'Open or Claimed']) assert.ok(row.includes(word), `the runbook row says ${word}`);
  const fromScript = script.slice(script.indexOf('function checkTheEscrow'), script.indexOf('function postedEscrowNote'));
  assert.ok(fromScript.length > 400, 'the check-the-escrow text was found in the script');
  for (const word of ["the supplier's Submit may still land", 'vector_build_marketplace_accept', 'seconds_left', '600 s', 'Open or Claimed', 'vector_build_marketplace_reclaim']) assert.ok(fromScript.includes(word), `the script says ${word}`);
  assert.doesNotMatch(script, /Reclaim the escrow/, 'the script never tells the operator to simply reclaim');
  // The row for a lost state file names the Submitted case too, and the paragraph on the buyer key says where keygen is run.
  const lost = e2e.split('\n').find((l) => l.startsWith('| Exit code 2 |')) ?? '';
  for (const text of ['find it through the indexer rows of the buyer key', 'as in the first row of this table', 'vector_build_marketplace_accept', '`seconds_left`', 'If it is Submitted, accept within 600 s of the Submit', 'If it is Open or Claimed, reclaim it with `vector_build_marketplace_reclaim` after `deliver_by`']) assert.ok(lost.includes(text), `the lost-state row says ${text}`);
  assert.equal(lost.includes('reclaim it after `deliver_by` before you start a new run'), false, 'no bare reclaim');
  assert.ok(e2e.includes("Run `keygen` in your own terminal, never through the assistant's shell tool: its output goes back into the conversation, so the only copy of the key would reach the model provider."));
});

test('the marketplace tools are said to be on the hosted mainnet server (33 tools, 2026-10-14) in the runbooks, the script and the four specs, nothing waits for a cutover, and way 1 of the Agent History spec names buyerAddress', () => {
  const e2e = doc('E2E.md');
  assert.ok(e2e.includes('The nine marketplace tools are merged into `main` of Apex-Fusion/mcp-server and are on the hosted mainnet server as of 2026-10-14: an MCP `initialize` and `tools/list` handshake that day listed 33 tools, the nine among them.'));
  // The current advert was posted on 2026-10-15 at the status flip (RUNBOOK step 17), so the check that ADVERT_REF is among the free suppliers can pass with it. The first first-party run settled on 2026-10-15 (step 15), against the first advert, and is in the Results table. The status word is DEPLOYED.
  assert.ok(e2e.includes(`The current Agent History advert was posted on 2026-10-15, reference \`${AH.advertRef}\`. The first first-party run settled on 2026-10-15 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip.`));
  assert.equal(e2e.includes(AH.firstAdvertTx), false, 'the retired advert is named by what it was, not by its reference');
  assert.equal(e2e.match(/has not completed a live run|first-party run has not been made/i), null, 'the words of before the run');
  assert.ok(e2e.includes('Against the hosted mainnet server the script now passes its first check, the tool list of the builder. The check that `ADVERT_REF` is among the free suppliers can pass with that reference: the marketplace indexer lists the advert as Active and free as of 2026-10-15.'));
  assert.equal(e2e.match(/advert is not posted|until the advert is posted|not yet advertised|not in service|<ADVERT_REF>/i), null, 'the words of before the advert');
  assert.equal(e2e.match(/none yet/i), null, 'the empty row of the Results table is gone: the first run is in it');
  const builderRow = e2e.split('\n').find((l) => l.startsWith('| `BUILDER_URL` |')) ?? '';
  assert.ok(builderRow.includes('Default: `https://mcp.vector.mainnet.apexfusion.org/mcp`, which has them as of 2026-10-14. The default works, so you need not set `BUILDER_URL`.'));
  assert.ok(builderRow.includes('The local build is the fallback for a builder that lacks the tools: build `main` of Apex-Fusion/mcp-server and run it locally with `PORT=3300 node packages/builder/build/index.js`'));
  assert.ok(builderRow.includes('The hosted testnet instance lists the same tools, but it reads the mainnet marketplace indexer with the testnet Koios'));
  assert.equal(e2e.match(/three PRs|PR 3 branch|PR 4 \(planned\)|none of the nine marketplace tools/), null, 'the statuses of before the merge');
  const script = e2eScript();
  assert.ok(script.includes('They are merged into main of Apex-Fusion/mcp-server and on the hosted mainnet server as of 2026-10-14, so a builder that lacks them is some other builder.'));
  assert.equal(script.match(/three PRs|PR 3 branch/), null);
  const wayOne = section(read('agent-history'), 'How to hire it').split('\n').find((l) => l.startsWith('1. **Chat client via MCP.**')) ?? '';
  assert.ok(wayOne.includes('The send and every poll also take your signer address as `buyerAddress`, the wallet that posted the escrow and locked its value.'));
  assert.ok(wayOne.includes('The marketplace tools are on the hosted mainnet server, which lists 33 tools as of 2026-10-14.'));
  for (const name of ['document-pipeline', 'audio-snippets', 'advocate']) {
    const how = section(read(name), 'How to hire it');
    assert.ok(how.includes('The marketplace tools are on the hosted mainnet server as of 2026-10-14.'), name);
    assert.equal(how.match(/marketplace tools are PROPOSED/), null, name);
  }
  assert.equal(read('agent-history').match(/not on the hosted server/), null);
  // No file that once said it waits for a cutover says it now.
  const waited = [['docs/HIRE.md', hire()], ['docs/E2E.md', e2e], ['deploy/host/RUNBOOK.md', readFileSync(new URL('../deploy/host/RUNBOOK.md', import.meta.url), 'utf8')], ['scripts/e2e-hire.mjs', script], ...Object.keys(AGENTS).map((name) => ['specs/' + name + '.md', read(name)])];
  assert.equal(waited.length, 8);
  for (const [name, text] of waited) assert.equal(text.match(WAITS_FOR_CUTOVER), null, name + ' still waits for a cutover');
});

test('docs/HIRE.md section 8: the current advert reference is given in full and the public URL is in service; the reference is the same in the spec, the guide and the E2E runbook, and the guide never gives the retired one', () => {
  const eight = section(hire(), '8. The terminal path');
  assert.ok(eight.includes(`As of 2026-10-15 the advert reference is \`${AH.advertRef}\` and the endpoint URL is \`https://mp-suppliers-history.hal8.ai\`, which is in service. Check both against what the tools show you.`));
  assert.ok(eight.includes(`--advert-ref '${AH.advertRef}' --endpoint https://mp-suppliers-history.hal8.ai --payload-file ./payload.json`));
  assert.equal(hire().match(/<ADVERT_REF>|placeholder|not yet advertised|not in service/i), null, 'the words of before the advert');
  // The reference is the one the agent serves at /capability since the status flip of 2026-10-15: a transaction id of 64 hex digits and the output index 0. It is given in full, never shortened, in every file that gives it.
  assert.match(AH.advertRef, /^[0-9a-f]{64}#0$/);
  for (const [name, text] of [['specs/agent-history.md', read('agent-history')], ['docs/HIRE.md', hire()], ['docs/E2E.md', doc('E2E.md')]]) assert.ok(text.includes(AH.advertRef), `${name} gives the advert reference in full`);
  assert.equal(hire().includes(AH.firstAdvertTx), false, 'the guide never gives the retired advert');
});

test('the READMEs: Agent History is DEPLOYED since 2026-10-15, Document Pipeline since 2026-10-16, Audio Snippets since 2026-10-17 and Advocate since 2026-10-20; the agent READMEs give the facts of the status line and the defaults of the manifest, and none says it is not yet advertised', () => {
  const agentReadme = readFileSync(new URL('../agents/agent-history/README.md', import.meta.url), 'utf8');
  const pipelineReadme = readFileSync(new URL('../agents/document-pipeline/README.md', import.meta.url), 'utf8');
  const snippetsReadme = readFileSync(new URL('../agents/audio-snippets/README.md', import.meta.url), 'utf8');
  const advocateReadme = readFileSync(new URL('../agents/advocate/README.md', import.meta.url), 'utf8');
  const rootReadme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.ok(advocateReadme.includes(`Status: ${AD_STATUS} The service is built and its tests run the search, the pages, the model and the check against stand-ins for the Brave Search API, the result pages, a chat supplier of the marketplace, the chain and OpenRouter, with no network. It runs on the operator's host, and the one job it has settled is first-party, which is not demand.`));
  assert.ok(advocateReadme.includes('| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |') && advocateReadme.includes('| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-10-20` |'), 'the defaults of the code');
  assert.equal(advocateReadme.match(/no job (has )?(settled|run)|no registry record|no advert yet|has no advert|built, not deployed/i), null, 'the README of Advocate does not say that nothing happened');
  assert.ok(snippetsReadme.includes(`Status: ${AS_STATUS} The service is built and its tests run the real ffmpeg and, where it is installed, the real speech model. It runs on the operator's host, and the one job it has settled is first-party, which is not demand.`));
  assert.ok(snippetsReadme.includes('| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |') && snippetsReadme.includes('| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-10-17` |'), 'the defaults of the code');
  assert.equal(snippetsReadme.match(/no job (has )?(settled|run)|no registry record|no advert\b|built, not deployed/i), null, 'the README of Audio Snippets does not say that nothing happened');
  assert.ok(pipelineReadme.includes(`Status: ${DP_STATUS} The service is built and its tests replay an in-memory marketplace.`));
  assert.ok(pipelineReadme.includes('| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |') && pipelineReadme.includes('| `AGENT_STATUS_SINCE` | `status.since`, as YYYY-MM-DD | `2026-10-16` |'), 'the defaults of the code');
  assert.equal(pipelineReadme.match(/no job (has )?(settled|run)|no registry record|no advert\b/i), null, 'the Pipeline README does not say that nothing happened');
  assert.ok(agentReadme.includes(`Status: ${AH_STATUS} Read-only:`));
  assert.ok(agentReadme.includes('| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |') && agentReadme.includes('| `AGENT_STATUS_SINCE` | `status.since` | `2026-10-15` |'), 'the defaults of the code');
  assert.equal(agentReadme.match(/no job (has )?settled/i), null, 'the agent README does not say that no job settled');
  assert.deepEqual(rootReadme.split('\n').filter((l) => l.startsWith('| ') && l.includes('`')), [
    '| Agent History | `identity.history.report.v1` | DEPLOYED |',
    '| Document Pipeline | `document.pipeline.ocr-summary.v1` | DEPLOYED |',
    '| Audio Snippets | `audio.transcript.snippets.v1` | DEPLOYED |',
    '| Advocate | `research.advocate.onesided.v1` | DEPLOYED |',
  ]);
  // No README says of an agent that it is not advertised or waits for its deployment: the four are advertised. The README of Advocate names "no advert" once, in its rule of the ceiling of the chat job.
  for (const [name, text] of [['agents/agent-history/README.md', agentReadme], ['agents/document-pipeline/README.md', pipelineReadme], ['agents/audio-snippets/README.md', snippetsReadme], ['agents/advocate/README.md', advocateReadme.replace('when no advert at or under it can be', '')], ['README.md', rootReadme]]) assert.equal(text.match(/not yet advertised|no advert\b|not posted|not in service|<ADVERT_REF>|waits for its deployment/i), null, name);
});

// The root README tells a newcomer how to hire Agent History in one short section (2026-10-15). Its commands, its server URL and its figures are the guide's and the design's, so they are held against both here.
test('README: the section "Hire Agent History" sits between the status table and the link list in eight to thirteen short lines, with the npx command first and the build from source as the alternative, the hosted server, the 5-alone rule, the end state, the honesty line, and one line each that points at Document Pipeline, at Audio Snippets and at Advocate; it names no unit, no dash and no status', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const heading = '\n## Hire Agent History\n';
  assert.equal(readme.split(heading).length - 1, 1, 'one such section');
  const start = readme.indexOf(heading);
  const links = readme.indexOf('\n- Hire one: `docs/HIRE.md`\n');
  assert.ok(readme.slice(0, start).trimEnd().endsWith('| Advocate | `research.advocate.onesided.v1` | DEPLOYED |'), 'right after the status table');
  assert.ok(links > start, 'before the link list');
  const body = readme.slice(start + heading.length, links);
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 8 && lines.length <= 13, `eight to thirteen lines, found ${lines.length}`);
  for (const part of [
    'You need an MCP client, a signer that runs on your machine (published on npm), and some units on Vector mainnet.',
    `1. In your own terminal and never through an assistant, run \`${SIGNER_NPX} keygen\`.`,
    '2. Send units on Vector mainnet to the address `keygen` prints. Send 5 alone first, as collateral.',
    '3. Then send a float. One job costs about 3.',
    `4. Add the hosted server to your client: \`${designEndpoint('MCP')}\`.`,
    '5. Add the signer too, with the key in its environment (`docs/HIRE.md` section 4).',
    '6. Paste the six chat messages in `docs/HIRE.md` section 5, one at a time.',
    `The \`build/index.js\` in the npm package is identical to the build of \`packages/signer\` at mcp-server \`main\`, commit \`${SIGNER_COMMIT}\`. To check that code yourself, or if you cannot run \`npx\`, clone https://github.com/Apex-Fusion/mcp-server, check out \`${SIGNER_COMMIT}\`, build it with \`npm ci && npm run build\`, and run \`node packages/signer/build/index.js keygen\` instead (\`docs/HIRE.md\` section 2).`,
    'You end with the report, an Ed25519-signed receipt, the escrow reference, two explorer links, and a check anyone can repeat with no key.',
    "The supplier is first-party and the contracts have no third-party audit. Accept within 600 s of the supplier's submit, or the supplier may keep the lock.",
    'Document Pipeline reads a document and is hired the same way: `docs/HIRE.md` section 5 shows what changes.',
    'Audio Snippets transcribes a recording and finds the cut points of the quotes you give it, and is hired the same way: `docs/HIRE.md` section 5 shows what changes.',
    'Advocate writes the strongest one-sided brief for a position, with citations, and is hired the same way: `docs/HIRE.md` section 5 shows what changes.',
  ]) assert.ok(lines.includes(part), `the section has the line: ${part}`);
  // The lines about Document Pipeline, Audio Snippets and Advocate are the last three of the section, after the honesty line, each pointing at its subsection of section 5 of the guide.
  // The status of each agent is in the table above, not here: since 2026-10-20 it says DEPLOYED for all four.
  assert.equal(lines.at(-1), 'Advocate writes the strongest one-sided brief for a position, with citations, and is hired the same way: `docs/HIRE.md` section 5 shows what changes.');
  assert.equal(lines.at(-2), 'Audio Snippets transcribes a recording and finds the cut points of the quotes you give it, and is hired the same way: `docs/HIRE.md` section 5 shows what changes.');
  assert.equal(lines.at(-3), 'Document Pipeline reads a document and is hired the same way: `docs/HIRE.md` section 5 shows what changes.');
  for (const heading of ['\n### The same script for Document Pipeline\n', '\n### The same script for Audio Snippets\n', '\n### The same script for Advocate\n']) assert.ok(section(hire(), '5. The chat script').includes(heading), `section 5 of the guide has ${heading.trim()}`);
  assert.equal(readme.match(/waits for its deployment/), null, 'the lines of before the flips of Audio Snippets and of Advocate');
  // What the section says is what the guide says: the two commands, the 5 alone, the cost of a job, the six messages and the 600 s.
  const getKey = section(hire(), '2. Get a key');
  assert.ok(getKey.includes(SIGNER_NPX + ' keygen') && getKey.includes('npm ci && npm run build\nnode packages/signer/build/index.js keygen'), 'the commands of the guide: npx first, the build from source as the alternative');
  const three = section(hire(), '3. What the key must hold');
  assert.ok(three.includes('Send 5 alone first, then the float of 50.'), 'the guide sends 5 alone first');
  assert.ok(three.split('\n').some((l) => l.startsWith('| 1 (Agent History) | 3 | ') && l.endsWith(' | about 3 | 16 |')), 'one job costs about 3');
  assert.ok(three.includes("If you do not accept within 600 s of the supplier's Submit, the supplier may Release the escrow and keep everything that is locked"), 'the 600 s line');
  assert.equal(CHAT_SCRIPT.length, 6, 'the six chat messages of section 5');
  assert.equal(readme.match(UNIT_NAME), null, 'the README says units, the guide names the unit once');
  assert.equal(readme.match(DASHES), null, 'hyphens only');
  assert.equal(body.match(/\b(LIVE|DEPLOYED|PROPOSED)\b/), null, 'the section changes no status');
});

// ---- The first first-party run, 2026-10-15 (RUNBOOK step 15) ----
// docs/E2E.md records it in the Results table, and docs/evidence/ holds the object the script printed, byte for byte. Both keys were ours, so the run shows that the path works and is not demand:
// the status word was PROPOSED until step 17 was run on 2026-10-15 and is DEPLOYED since, never LIVE. The file is held against itself and against the docs here. The ledger rows of the receipt check need the chain and are repeated by hand with the tool.
const RUN1 = {
  evidence: 'docs/evidence/2026-10-15-agent-history-run-1.json',
  escrowRef: '5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765#0',
  postTx: '5248c71eb5eb65f8bfa865a837f34cc85e6d18fe07b01f14cc2ca22660176765',
  acceptTx: '902df222e6e1ab76d2d7f1085963b4dbf3a9b4b88353b82481c57a92fbc5c03c',
  responseHash: '8acccd2af71b7e301096270bc7d38aa0b471c4bbc61c2918dde275db086a0d41',
};
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const runEvidence = () => JSON.parse(readFileSync(new URL(`../${RUN1.evidence}`, import.meta.url), 'utf8'));
const explorerLink = (tx) => `[\`${tx}\`](${EXPLORER_TX}${tx})`;

test('docs/evidence: the evidence of the first-party run of 2026-10-15 parses, is VERIFIED, and its report text hashes to result_sha256 and to the response_hash of the receipt', () => {
  const ev = runEvidence();
  assert.equal(ev.run, 'first-party');
  assert.equal(ev.verdict, 'VERIFIED');
  assert.equal(ev.capability_id, AGENTS['agent-history'].capability);
  assert.equal(ev.advert_ref, AH.firstAdvertRef, 'the run was made against the first advert, which was retired at the status flip');
  assert.equal(ev.escrow_ref, RUN1.escrowRef);
  assert.equal(ev.post_tx, RUN1.postTx);
  assert.equal(ev.accept_tx, RUN1.acceptTx);
  assert.equal(ev.escrow_ref, `${ev.post_tx}#0`, 'the escrow is the first output of the post transaction');
  assert.notEqual(ev.post_tx, ev.accept_tx, 'two transactions');
  assert.deepEqual(ev.explorer, { post: EXPLORER_TX + RUN1.postTx, accept: EXPLORER_TX + RUN1.acceptTx });
  // All six rows of the receipt check passed.
  assert.deepEqual(ev.checks, Object.fromEntries(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches'].map((row) => [row, 'pass'])));
  // The report text is the exact string the receipt covers: its sha256 is result_sha256 and the response_hash of the receipt.
  assert.equal(typeof ev.result, 'string');
  assert.equal(sha256(ev.result), ev.result_sha256);
  assert.equal(ev.result_sha256, ev.receipt.response_hash);
  assert.equal(ev.result_sha256, RUN1.responseHash);
  assert.equal(Buffer.byteLength(ev.result, 'utf8'), 7019);
  // The receipt has the eight fields of the guide, names this escrow and the supplier key of the registry record, and carries no model cost.
  assert.deepEqual(Object.keys(ev.receipt).sort(), ['completion_tokens', 'escrow_ref', 'model', 'prompt_hash', 'prompt_tokens', 'response_hash', 'supplier_pkh', 'wallclock_ms']);
  assert.equal(ev.receipt.escrow_ref, ev.escrow_ref);
  assert.equal(ev.receipt.supplier_pkh, AH.controllerPkh);
  assert.equal(ev.receipt.model, AGENTS['agent-history'].model);
  assert.equal(ev.receipt.prompt_tokens, 0);
  assert.equal(ev.receipt.completion_tokens, 0);
  assert.match(ev.receipt_signature, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 64 bytes');
  // The prompt_hash is the sha256 of the wire payload of the request in the guide (message 3 of the chat script), so the receipt is for that request.
  const request = /Payload: (\{"subject":"[^"]+"\})\./.exec(CHAT_SCRIPT[2])[1];
  assert.equal(ev.receipt.prompt_hash, sha256(JSON.stringify([{ content: request, role: 'user' }])));
  // The report is the one this agent writes for that subject.
  const report = JSON.parse(ev.result);
  assert.equal(report.schema, 'vector.agent-history.report.v1');
  assert.equal(report.generated_by.did, AH.did);
  assert.equal(report.subject.did, JSON.parse(request).subject);
});

test('docs/E2E.md, specs/agent-history.md and the guide record the first-party run of 2026-10-15 with the same references, and the status word is DEPLOYED, not LIVE', () => {
  const e2e = doc('E2E.md');
  // The Results table has a row for each run: first-party, the escrow reference, the two transactions as explorer links, VERIFIED. Agent History's is first, Document Pipeline's, Audio Snippets' and Advocate's follow.
  assert.deepEqual(e2e.split('\n').filter((l) => /^\| 20\d\d-/.test(l)), [
    `| 2026-10-15 | Agent History | first-party | \`${RUN1.escrowRef}\` | ${explorerLink(RUN1.postTx)} | ${explorerLink(RUN1.acceptTx)} | VERIFIED |`,
    `| 2026-10-16 | Document Pipeline | first-party | \`${DP_RUN.escrowRef}\` | ${explorerLink(DP_RUN.postTx)} | ${explorerLink(DP_RUN.acceptTx)} | VERIFIED |`,
    `| 2026-10-17 | Audio Snippets | first-party | \`${AS_RUN.escrowRef}\` | ${explorerLink(AS_RUN.postTx)} | ${explorerLink(AS_RUN.acceptTx)} | VERIFIED |`,
    `| 2026-10-20 | Advocate | first-party | \`${AD_RUN.escrowRef}\` | ${explorerLink(AD_RUN.postTx)} | ${explorerLink(AD_RUN.acceptTx)} | VERIFIED |`,
  ]);
  assert.ok(e2e.includes('**Status: DEPLOYED.**'), 'the status word since the flip of 2026-10-15');
  assert.ok(e2e.includes('The first first-party run settled on 2026-10-15 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip.'));
  assert.equal(e2e.match(/none yet|has not completed a live run|first-party run has not been made/i), null, 'the words of before the run');
  // The paragraph under the table names the evidence file and how to repeat the check, which needs no key and no units.
  const results = section(e2e, 'Results');
  assert.ok(results.includes(`[${RUN1.evidence}](${RUN1.evidence.replace(/^docs\//, '')})`), 'a link from docs/E2E.md to the evidence file');
  const repeat = results.split('\n').find((l) => l.includes('vector_marketplace_verify_receipt')) ?? '';
  for (const part of ['`receipt`', '`receipt_signature`', '`escrow_ref`', 'the untouched `result`', 'needs no key and no units', 'It is not demand.']) assert.ok(repeat.includes(part), `the paragraph under the table says ${part}`);
  assert.ok(existsSync(new URL(`../${RUN1.evidence}`, import.meta.url)), 'the evidence file the docs name exists');
  // The spec says it in the Status line and paragraph and in How to hire it, and its Links point at the evidence and at the two transactions.
  const spec = read('agent-history');
  assert.ok(section(spec, 'Status').includes(AH_STATUS));
  for (const heading of ['Status', 'How to hire it']) assert.ok(section(spec, heading).includes('One first-party job has settled, on 2026-10-15; it is not demand.'), heading);
  assert.ok(section(spec, 'Links').includes(`- First-party hire on 2026-10-15, verdict VERIFIED, made against the first advert: the post transaction ${explorerLink(RUN1.postTx)} and the accept transaction ${explorerLink(RUN1.acceptTx)} on the explorer, and the evidence in [${RUN1.evidence}](../${RUN1.evidence}).`));
  // Nothing that states where the agent stands says that no job settled or that no first-party run is recorded. Step 14 of the runbook is in the list too: since the flip of 2026-10-15 it names no word and no job.
  const files = ['specs/agent-history.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/agent-history/README.md', 'deploy/host/docker-compose.agent-history.yml', 'deploy/host/README.md', 'deploy/host/RUNBOOK.md'];
  for (const file of files) assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').match(/no job (has )?settled|no first-party run of the path is recorded/i), null, file);
  // The honesty box of the guide stays true: nobody outside the team has run the path.
  assert.ok(section(hire(), '10. Honesty box').includes('- No run of this path by someone outside the team is recorded yet. The first-party runs are in [docs/E2E.md](E2E.md).'));
});

test('scripts/run-e2e-from-keyfile.sh and docs/E2E.md: the key file is sourced and never printed, the output goes through the filter, and the runbook says so without a path or an address', () => {
  const script = readFileSync(new URL('./run-e2e-from-keyfile.sh', import.meta.url), 'utf8');
  assert.ok(script.startsWith('#!/usr/bin/env bash\n'));
  assert.ok(script.includes(`export ADVERT_REF="\${ADVERT_REF:-${AH.advertRef}}"`), 'the default advert of the wrapper is the current one');
  assert.equal(script.includes(AH.firstAdvertTx), false, 'and not the retired one');
  assert.ok(script.includes('set -euo pipefail') && script.includes('usage: run-e2e-from-keyfile.sh KEYFILE [--dry-run]'));
  assert.doesNotMatch(script, /\b(echo|printf|cat)\b[^\n]*PRIVATE_KEY/, 'no line prints the key');
  assert.ok(script.includes('node scripts/e2e-hire.mjs --dry-run 2>&1 | redact') && script.includes('node scripts/e2e-hire.mjs 2> >(redact >&2) > evidence.json.tmp'), 'the dry run and the messages of a run go through the filter');
  assert.ok(script.includes('s/ed25519_sk1[0-9a-z]+/ed25519_sk1<redacted>/g'), 'the filter blanks a signer key');
  const e2e = doc('E2E.md');
  const commands = section(e2e, 'The commands');
  assert.ok(commands.indexOf('node scripts/e2e-hire.mjs --dry-run') < commands.indexOf('### Running it from a key file'), 'the section comes after the commands');
  const sub = commands.slice(commands.indexOf('### Running it from a key file'));
  for (const part of ['`scripts/run-e2e-from-keyfile.sh KEYFILE [--dry-run]`', 'the `NAME=value` lines that `keygen` prints', 'sources the file into its own environment and never prints it', 'UTF-16', 'byte-order mark', 'CRLF', 'blanks key-shaped strings', '`evidence.json`', 'keep the file and the key out of any chat']) assert.ok(sub.includes(part), `the key-file section says ${part}`);
  // It says nothing about where the key file is or what the buyer's address is.
  assert.doesNotMatch(e2e, /addr1[0-9a-z]{20,}|[A-Za-z]:[\x5c/]Users[\x5c/]|[\x5c/]home[\x5c/][A-Za-z]/, 'no address and no path into a home folder');
});

// ---- The first adverts are history (RUNBOOK step 17 of each agent) ----
// The status flips of Agent History (2026-10-15), Document Pipeline (2026-10-16), Audio Snippets (2026-10-17) and Advocate (2026-10-20) each retired the first advert and posted a new one with the manifest of the flip. The first reference lives in the Links of the spec, as history, and in the evidence of the run made against it.
// Everything that tells a reader which advert to hire gives the current one, so the old reference cannot come back as the current one without failing here.
test('the first adverts are history: their references are in the Links of the specs and in the evidence of the runs, and nowhere else; the guide, the runbook and the specs give the current ones', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  // A path from relative() has the separator of the platform; the walk turns it into forward slashes before anything else looks at it (\x5c is the backslash).
  const slashes = (rel) => rel.split('\x5c').join('/');
  // The run outputs of docs/E2E.md (git-ignored, repository root) are an operator's files, not the repository: skipped.
  const runOutput = (rel) => /^(evidence\.json(\.tmp)?|e2e-state[^\/]*\.json[^\/]*)$/.test(rel);
  const skip = (rel) => runOutput(rel) || /(^|\/)(node_modules|\.git|\.superpowers)(\/|$)/.test(rel) || /(^|\/)test\/fixtures(\/|$)/.test(rel) || rel.startsWith('docs/superpowers') || rel === 'pnpm-lock.yaml' || /\.test\.(mjs|ts)$/.test(rel);
  const walk = (dir, out = []) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (skip(slashes(relative(root, p)))) continue; e.isDirectory() ? walk(p, out) : out.push(slashes(relative(root, p))); } return out; };
  const files = walk(root).filter((rel) => /\.(ts|js|mjs|json|md|yml|yaml|sh|snippet|example|template)$/.test(rel));
  assert.ok(files.length >= 40 && files.includes('scripts/run-e2e-from-keyfile.sh') && files.includes('docs/HIRE.md'), `the walk reaches the repository, found ${files.length} files`);
  const holders = files.filter((rel) => readFileSync(join(root, rel), 'utf8').includes(AH.firstAdvertTx));
  assert.deepEqual(holders.sort(), [RUN1.evidence, 'specs/agent-history.md'].sort());
  // In the spec it is one line of Links, the one that says the advert was retired.
  const lines = read('agent-history').split('\n').filter((l) => l.includes(AH.firstAdvertTx));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith('- First advert ') && lines[0].includes('retired on 2026-10-15 at the status flip'));
  // The current advert is what a reader is told to hire.
  assert.notEqual(AH.advertRef, AH.firstAdvertRef);
  assert.equal(hire().split(AH.advertRef).length - 1, 3, 'the guide gives it in the table row, in section 8 and in the command');
  assert.equal(doc('E2E.md').split(AH.advertRef).length - 1, 1, 'the runbook gives it in the Status paragraph');
  assert.ok(read('agent-history').includes(`- Current advert \`${AH.advertRef}\``));
  // The same for Document Pipeline: its first advert, posted and retired on 2026-10-16, is in one line of its Links and in the evidence of its run. The guide gives the current one once, in its table row, and the E2E runbook once, in its Status paragraph.
  const dpHolders = files.filter((rel) => readFileSync(join(root, rel), 'utf8').includes(DP.firstAdvertTx));
  assert.deepEqual(dpHolders.sort(), [DP_RUN.evidence, 'specs/document-pipeline.md'].sort());
  const dpLines = read('document-pipeline').split('\n').filter((l) => l.includes(DP.firstAdvertTx));
  assert.equal(dpLines.length, 1);
  assert.ok(dpLines[0].startsWith('- First advert ') && dpLines[0].includes('retired on 2026-10-16 at the status flip'));
  assert.equal(hire().split(DP.advertRef).length - 1, 1, 'the guide gives the current advert in its table row');
  assert.equal(doc('E2E.md').split(DP.advertRef).length - 1, 1, 'the runbook gives the current advert in the Status paragraph');
  assert.ok(read('document-pipeline').includes(`- Current advert \`${DP.advertRef}\``));
  // The same for Audio Snippets: its first advert, posted and retired on 2026-10-17, is in one line of its Links and in the evidence of its run. The guide gives the current one in its table row and in the
  // subsection of section 5, and the E2E runbook in its Status paragraph and as the ADVERT_REF of the section "Hiring Audio Snippets".
  const asHolders = files.filter((rel) => readFileSync(join(root, rel), 'utf8').includes(AS.firstAdvertTx));
  assert.deepEqual(asHolders.sort(), [AS_RUN.evidence, 'specs/audio-snippets.md'].sort());
  const asLines = read('audio-snippets').split('\n').filter((l) => l.includes(AS.firstAdvertTx));
  assert.equal(asLines.length, 1);
  assert.ok(asLines[0].startsWith('- First advert ') && asLines[0].includes('retired on 2026-10-17 at the status flip'));
  assert.equal(hire().split(AS.advertRef).length - 1, 2, 'the guide gives the current advert in its table row and in section 5');
  assert.ok(section(hire(), '5. The chat script').includes(`It has had an advert since 2026-10-17, and the current one is \`${AS.advertRef}\`.`));
  assert.equal(doc('E2E.md').split(AS.advertRef).length - 1, 2, 'the runbook gives the current advert in the Status paragraph and as the ADVERT_REF of its section');
  assert.ok(section(doc('E2E.md'), 'Hiring Audio Snippets').includes(`\nexport ADVERT_REF=${AS.advertRef}\n`));
  assert.ok(read('audio-snippets').includes(`- Current advert \`${AS.advertRef}\``));
  // The same for Advocate: its first advert, posted on 2026-10-19 and retired on 2026-10-20, is in one line of its Links and in the evidence of its run. The guide gives the current one in its table row
  // and in the subsection of section 5, and the E2E runbook in its Status paragraph and as the ADVERT_REF of the section "Hiring Advocate".
  const adHolders = files.filter((rel) => readFileSync(join(root, rel), 'utf8').includes(AD.firstAdvertTx));
  assert.deepEqual(adHolders.sort(), [AD_RUN.evidence, 'specs/advocate.md'].sort());
  const adLines = read('advocate').split('\n').filter((l) => l.includes(AD.firstAdvertTx));
  assert.equal(adLines.length, 1);
  assert.ok(adLines[0].startsWith('- First advert ') && adLines[0].includes('retired on 2026-10-20 at the status flip'));
  assert.equal(hire().split(AD.advertRef).length - 1, 2, 'the guide gives the current advert in its table row and in section 5');
  assert.ok(section(hire(), '5. The chat script').includes(`It has had an advert since 2026-10-19, and the current one is \`${AD.advertRef}\`.`));
  assert.equal(doc('E2E.md').split(AD.advertRef).length - 1, 2, 'the runbook gives the current advert in the Status paragraph and as the ADVERT_REF of its section');
  assert.ok(section(doc('E2E.md'), 'Hiring Advocate').includes(`\nexport ADVERT_REF=${AD.advertRef}\n`));
  assert.ok(read('advocate').includes(`- Current advert \`${AD.advertRef}\``));
});

// ---- The first first-party run of Document Pipeline, 2026-10-16 (RUNBOOK-document-pipeline step 15) ----
// docs/E2E.md records it in the Results table, and docs/evidence/ holds the object the script printed, byte for byte. Both keys were ours, so the run shows that the path works and is not demand.
// The run was made against the first advert, which step 17 retired the same day. The ledger rows of the receipt check need the chain and are repeated by hand with the tool.
test('docs/evidence: the evidence of the first-party run of Document Pipeline of 2026-10-16 is the file the script printed, parses, is VERIFIED, and its bundle hashes to result_sha256 and to the response_hash of the receipt', () => {
  const raw = readFileSync(new URL(`../${DP_RUN.evidence}`, import.meta.url));
  assert.equal(raw.length, DP_RUN.evidenceBytes, 'copied byte for byte: its size');
  assert.equal(createHash('sha256').update(raw).digest('hex'), DP_RUN.evidenceSha256, 'copied byte for byte: its sha256');
  const ev = JSON.parse(raw.toString('utf8'));
  assert.equal(ev.run, 'first-party');
  assert.equal(ev.verdict, 'VERIFIED');
  assert.equal(ev.capability_id, AGENTS['document-pipeline'].capability);
  assert.equal(ev.advert_ref, DP.firstAdvertRef, 'the run was made against the first advert, which was retired at the status flip');
  assert.equal(ev.escrow_ref, DP_RUN.escrowRef);
  assert.equal(ev.post_tx, DP_RUN.postTx);
  assert.equal(ev.accept_tx, DP_RUN.acceptTx);
  assert.equal(ev.escrow_ref, `${ev.post_tx}#0`, 'the escrow is the first output of the post transaction');
  assert.notEqual(ev.post_tx, ev.accept_tx, 'two transactions');
  assert.deepEqual(ev.explorer, { post: EXPLORER_TX + DP_RUN.postTx, accept: EXPLORER_TX + DP_RUN.acceptTx });
  // All six rows of the receipt check passed.
  assert.deepEqual(ev.checks, Object.fromEntries(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches'].map((row) => [row, 'pass'])));
  // The bundle is the exact string the receipt covers: its sha256 is result_sha256 and the response_hash of the receipt.
  assert.equal(typeof ev.result, 'string');
  assert.equal(sha256(ev.result), ev.result_sha256);
  assert.equal(ev.result_sha256, ev.receipt.response_hash);
  assert.equal(ev.result_sha256, DP_RUN.responseHash);
  assert.equal(Buffer.byteLength(ev.result, 'utf8'), 5562);
  // The receipt has the eight fields of the guide, names this escrow and the supplier key of the Pipeline's registry record, and carries no model cost (the runtime counts none).
  assert.deepEqual(Object.keys(ev.receipt).sort(), ['completion_tokens', 'escrow_ref', 'model', 'prompt_hash', 'prompt_tokens', 'response_hash', 'supplier_pkh', 'wallclock_ms']);
  assert.equal(ev.receipt.escrow_ref, ev.escrow_ref);
  assert.equal(ev.receipt.supplier_pkh, DP.controllerPkh);
  assert.equal(ev.receipt.model, AGENTS['document-pipeline'].model);
  assert.equal(ev.receipt.prompt_tokens, 0);
  assert.equal(ev.receipt.completion_tokens, 0);
  assert.equal(ev.receipt.wallclock_ms, DP_RUN.wallclockMs);
  assert.match(ev.receipt_signature, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 64 bytes');
  // The prompt_hash is the sha256 of the wire payload of the request: one page of the public sample PDF, a summary in English.
  const request = JSON.stringify({ source: { url: DP_RUN.sample }, task: 'summary', language: 'en', max_pages: 1 });
  assert.equal(ev.receipt.prompt_hash, sha256(JSON.stringify([{ content: request, role: 'user' }])));
  // The bundle: one page read by the allowlisted first-party OCR agent and one chat job, every check of both sub-receipts true, and the accounting of the run.
  const bundle = JSON.parse(ev.result);
  assert.equal(bundle.schema, 'vector.document-pipeline.result.v1');
  assert.equal(bundle.source.pages, 1);
  assert.equal(bundle.pages.length, 1);
  const ocrPkh = /of the supplier key hash `([0-9a-f]{56})`/.exec(section(read('document-pipeline'), 'Interface'))?.[1];
  assert.match(ocrPkh, /^[0-9a-f]{56}$/);
  assert.equal(bundle.pages[0].sub_job.capability_id, 'ocr.page.extract.chandra-ocr-2.v1');
  assert.equal(bundle.pages[0].sub_job.supplier_pkh, ocrPkh, 'the OCR hop hired the allowlisted first-party supplier');
  assert.equal(bundle.llm_sub_job.capability_id, 'llm.text.generate.v1');
  assert.equal(bundle.llm_sub_job.receipt.model, 'deepseek/deepseek-v4-flash');
  for (const sub of [bundle.pages[0].sub_job, bundle.llm_sub_job]) {
    assert.deepEqual(Object.keys(sub.verification), ['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches', 'model_matches']);
    assert.ok(Object.values(sub.verification).every((v) => v === true), 'every check of a delivered sub-job is true');
  }
  assert.deepEqual(bundle.accounting, { sub_jobs: 2, locked_total_lovelace: '4461720', fees_total_lovelace: '2006660' });
  assert.equal(typeof bundle.result.summary, 'string');
});

test('docs/E2E.md, specs/document-pipeline.md and the guide record the first-party run of Document Pipeline of 2026-10-16 with the same references, and the status word is DEPLOYED, not LIVE', () => {
  const e2e = doc('E2E.md');
  const ev = JSON.parse(readFileSync(new URL(`../${DP_RUN.evidence}`, import.meta.url), 'utf8'));
  const bundle = JSON.parse(ev.result);
  // The Results table has its row (the test of Agent History's run holds both rows in order), and the status paragraph says the run and the adverts in the words of the spec.
  assert.ok(e2e.split('\n').includes(`| 2026-10-16 | Document Pipeline | first-party | \`${DP_RUN.escrowRef}\` | ${explorerLink(DP_RUN.postTx)} | ${explorerLink(DP_RUN.acceptTx)} | VERIFIED |`));
  assert.ok(e2e.includes(`The current Document Pipeline advert was posted on 2026-10-16, reference \`${DP.advertRef}\`. Its first first-party run settled on 2026-10-16 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip. The marketplace indexer lists the current advert as Active and free as of 2026-10-16.`));
  assert.equal(e2e.includes(DP.firstAdvertTx), false, 'the retired advert is named by what it was, not by its reference');
  // The paragraph under the table names the evidence file, how to repeat the check, and the numbers of the run, which are those of the file.
  const results = section(e2e, 'Results');
  assert.ok(results.includes(`[${DP_RUN.evidence}](${DP_RUN.evidence.replace(/^docs\//, '')})`), 'a link from docs/E2E.md to the evidence file');
  const paragraph = results.split('\n').find((l) => l.startsWith('The evidence of the Document Pipeline run is ')) ?? '';
  for (const part of [
    'the object the script printed, unchanged', 'the untouched `result`', `\`${DP_RUN.sample}\``, '(task summary, language en)', 'against the first advert, which was retired at the status flip the same day',
    `${ev.receipt.wallclock_ms} ms`, `${bundle.accounting.locked_total_lovelace} lovelace locked`, `${bundle.accounting.fees_total_lovelace} lovelace in fees`, 'the stranded store was empty afterwards', 'It is not demand.',
  ]) assert.ok(paragraph.includes(part), `the paragraph on the run of the Pipeline says ${part}`);
  assert.ok(existsSync(new URL(`../${DP_RUN.evidence}`, import.meta.url)), 'the evidence file the docs name exists');
  // The spec says it in the Status line and paragraph and in How to hire it, and its Links point at the evidence and at the two transactions.
  const spec = read('document-pipeline');
  assert.ok(section(spec, 'Status').includes(DP_STATUS));
  for (const heading of ['Status', 'How to hire it']) assert.ok(section(spec, heading).includes('One first-party job has settled, on 2026-10-16; it is not demand.'), heading);
  assert.ok(section(spec, 'Links').includes(`- First-party hire on 2026-10-16, verdict VERIFIED, made against the first advert: the post transaction ${explorerLink(DP_RUN.postTx)} and the accept transaction ${explorerLink(DP_RUN.acceptTx)} on the explorer, and the evidence in [${DP_RUN.evidence}](../${DP_RUN.evidence}).`));
  // Nothing that states where the agent stands says that no job settled or that no first-party run is recorded.
  const files = ['specs/document-pipeline.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/document-pipeline/README.md', 'deploy/host/docker-compose.document-pipeline.yml', 'deploy/host/README.md', 'deploy/host/RUNBOOK-document-pipeline.md'];
  for (const file of files) assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').match(/no job (has )?settled|no first-party run of the path is recorded/i), null, file);
});

// ---- Audio Snippets: built on 2026-10-16, registered, staked and advertised on 2026-10-17, DEPLOYED since 2026-10-17 ----
// The service is built and its tests run the real ffmpeg and, where it is installed, the real speech model. It has had a registry record, a stake and an advert since 2026-10-17, runs on the operator's
// host and has settled one first-party job, so the word is DEPLOYED, never LIVE. The page says what is built and what runs, and the words of the design it was before the build and of before the flip do
// not come back. agents/audio-snippets/test/spec.test.ts holds the rest of the page to the code and the manifest: the gap sentences, the numbers, the response example, the error codes, the two key rows.
const AS_PARAGRAPH = "The service is built. Its tests run the real ffmpeg and, on a machine that has it, the real speech model. It is deployed on the operator's host, has had a registry record since 2026-10-17 and has had an advert since 2026-10-17. One first-party job has settled, on 2026-10-17; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE.";

test('specs/audio-snippets.md: the Status line says DEPLOYED since 2026-10-17, the paragraph says what is built, what runs and that nothing is LIVE, the Identity sentence says the record exists since 2026-10-17, and the words of before the flip and of the design do not come back', () => {
  const text = read('audio-snippets');
  assert.equal(section(text, 'Status').trim(), `${AS_STATUS}\n\n${AS_PARAGRAPH}`);
  assert.equal(section(text, 'Status').match(/PROPOSED|not deployed/), null, 'the words of before the flip do not come back');
  assert.equal(text.match(/no job (has )?(settled|run)|no registry record yet|has no DID yet|is not deployed yet/i), null, 'the spec does not say that nothing happened');
  assert.ok(section(text, 'Identity').includes(`\n${AS_HAS_RECORD}\n`));
  assert.equal(section(text, 'Identity').match(/not registered|When registered|Registry record, planned|Public URL, planned|Reputation stake, planned|not in service/), null, 'the words of before the registration');
  assert.equal(text.match(/PROPOSED \(not built\)|This page is a design|There is no code|None of this is built|Illustrative|Backend \(design\)|No releases|The planned folder|Not built\. Everything|is not fixed yet|embedding similarity/), null, 'the words of before the build do not come back');
  assert.ok(section(text, 'Interface').includes('`match_method`') && section(text, 'Interface').includes('keyword overlap at segment level'), 'the method of a query is stated and named');
});

test('specs/audio-snippets.md: the DID, the supplier key, the registry record and the reputation stake of 2026-10-17 are in the Identity table with their transactions, the URL is in service, the current advert carries the terms of the page, and the first advert (retired at the flip), the current advert and the first-party hire are in the Links', () => {
  const text = read('audio-snippets');
  const row = (label) => section(text, 'Identity').split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
  // The DID has the registry policy that every DID of the registry has and an asset name of 64 hex of its own.
  const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(section(read('agent-history'), 'Interface'))?.[1] ?? '';
  assert.match(policy, /^[0-9a-f]{56}$/);
  assert.match(AS.did, new RegExp(`^did:vector:agent:${policy}:[0-9a-f]{64}$`));
  assert.equal(new Set([AS.did, AH.did, DP.did]).size, 3, 'its own asset name');
  assert.equal(row('DID'), `| DID | \`${AS.did}\` |`);
  // The supplier key is the only key of the agent: the Controller row gives its public key, the one the manifest serves, and the Registry record row its key hash (agents/audio-snippets/test/spec.test.ts holds the one to the other).
  assert.ok(row('Controller').startsWith(`| Controller | the supplier key, the only key of this agent and the key that signs its receipts. Its public key is \`${AS.pubKey}\`. The manifest publishes`));
  const record = row('Registry record');
  for (const part of [
    'name `Audio Snippets`', 'description as in the manifest', 'capabilities `audio.transcript.snippets.v1`', 'framework `vector-service-agents`', "endpoint the agent's public URL",
    `controller key hash \`${AS.controllerPkh}\` (the supplier key hash)`, `Registered on 2026-10-17 in the confirmed transaction ${explorerLink(AS.registerTx)}`,
    'The deposit is 10000000 lovelace (10.000000), refundable on deregistration',
  ]) assert.ok(record.includes(part), `the Registry record row says: ${part}`);
  // The deposit closes the row, as in the rows of the other two (step 7 of the runbook names the deposit of 10 units).
  assert.ok(record.endsWith(`${explorerLink(AS.registerTx)}. The deposit is 10000000 lovelace (10.000000), refundable on deregistration |`));
  assert.ok(section(readFileSync(new URL('../deploy/host/RUNBOOK-audio-snippets.md', import.meta.url), 'utf8'), '7. Register the identity').includes('This costs a deposit of 10 units, refundable on deregistration'));
  assert.equal(row('Reputation stake'), `| Reputation stake | a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability, made on 2026-10-17 in transaction ${explorerLink(AS.stakeTx)} |`);
  // The URL is in service since 2026-10-17 (steps 10 to 14), so no row is "planned" any more.
  assert.equal(row('Public URL'), '| Public URL | `https://mp-suppliers-snippets.hal8.ai` (in service as of 2026-10-17) |');
  for (const label of ['Registry record, planned', 'Public URL, planned', 'Reputation stake, planned']) assert.equal(row(label), '', `${label} is gone`);
  assert.match(AS.controllerPkh, /^[0-9a-f]{56}$/);
  for (const hex of [AS.registerTx, AS.stakeTx, AS.firstAdvertTx, AS.retireTx, AS.advertTx, AS.firstManifestHash, AS.manifestHash, AS.pubKey]) assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(new Set([AS.registerTx, AS.stakeTx, AS.firstAdvertTx, AS.retireTx, AS.advertTx, AS_RUN.postTx, AS_RUN.acceptTx]).size, 7, 'seven transactions: the registration, the stake, the first advert, its retirement, the current advert, the post and the accept of the run');
  assert.notEqual(AS.firstManifestHash, AS.manifestHash, 'the flip changed the manifest, so the advert was posted again');
  assert.equal(AS.firstAdvertRef, `${AS.firstAdvertTx}#0`);
  assert.equal(AS.advertRef, `${AS.advertTx}#0`);
  // The current advert carries the terms of the page: the price and the bonds of the Terms table, its window, and the output tokens and the model that step 12 of the runbook posts it with.
  const terms = section(text, 'Terms');
  const lovelace = (label) => Number(terms.split('\n').find((l) => l.startsWith(`| ${label} | `))?.split(' | ')[1]);
  assert.deepEqual([lovelace('Price'), lovelace('Supplier bond'), lovelace('Buyer bond')], [AS.terms.price, AS.terms.supplierBond, AS.terms.buyerBond]);
  assert.ok(terms.includes(`| Processing window, advert \`max_processing_ms\` | ${AS.terms.maxProcessingMs} ms |`));
  assert.ok(section(text, 'Capability id').includes(`The model string in the advert and in every receipt is \`${AS.terms.model}\`.`));
  const twelve = section(readFileSync(new URL('../deploy/host/RUNBOOK-audio-snippets.md', import.meta.url), 'utf8'), '12. Post the advert');
  for (const flag of [`--model ${AS.terms.model} `, `--max-output-tokens ${AS.terms.maxOutputTokens} `, `--price-lovelace ${AS.terms.price} `, `--max-processing-ms ${AS.terms.maxProcessingMs} `]) assert.equal(twelve.split(flag).length - 1, 2, `the dry run and the real run post the advert with ${flag.trim()}`);
  // The first advert was retired and the current one posted the same day (step 17): the Links keep the first as history, with the manifest it hashed, and give the current one with its manifest hash.
  const links = section(text, 'Links');
  assert.ok(links.includes(`- First advert \`${AS.firstAdvertRef}\`, posted on 2026-10-17 in the confirmed transaction ${explorerLink(AS.firstAdvertTx)}, manifest hash \`${AS.firstManifestHash}\` (the manifest before the status flip), retired on 2026-10-17 at the status flip in the confirmed transaction ${explorerLink(AS.retireTx)}.`));
  assert.ok(links.includes(`- Current advert \`${AS.advertRef}\`, posted on 2026-10-17 at the status flip in the confirmed transaction ${explorerLink(AS.advertTx)}, manifest hash \`${AS.manifestHash}\`. The marketplace indexer lists it as Active and free (checked on 2026-10-17).`));
  assert.ok(links.includes("- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-17. The service renders it from its environment when it starts. The template is [agents/audio-snippets/agent.json.template](../agents/audio-snippets/agent.json.template)."));
  assert.ok(links.includes('- Source: [agents/audio-snippets](../agents/audio-snippets)'));
  for (const path of ['agents/audio-snippets', 'agents/audio-snippets/agent.json.template']) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`);
  assert.ok(section(text, 'How to hire it').includes('Advertised on 2026-10-17, and again the same day at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-17). One first-party job has settled, on 2026-10-17; it is not demand. The three ways below apply.'));
  // The words of before the advert do not come back. Advocate keeps its own, and the runbooks quote them as instructions.
  assert.equal(text.match(/none yet|not posted|not in service|not yet advertised|none until deployed|once it is in service|not served yet|waits for its deployment|Once advertised/i), null, 'the words of before the advert');
});

// ---- The first first-party run of Audio Snippets, 2026-10-17 (RUNBOOK-audio-snippets step 15) ----
// docs/E2E.md records it in the Results table, and docs/evidence/ holds the object the script printed, byte for byte. Both keys were ours, so the run shows that the path works and is not demand.
// The run was made against the first advert, which step 17 retired the same day. The ledger rows of the receipt check need the chain and are repeated by hand with the tool. The signature needs only
// the public key, which the spec gives and the manifest serves, so it is checked here.
// The canonical JSON of the receipt, as the runtime signs it: the keys sorted and no whitespace. Every value of a receipt is a string of ASCII or a whole number.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
};

test('docs/evidence: the evidence of the first-party run of Audio Snippets of 2026-10-17 is the file the script printed, parses, is VERIFIED, its result hashes to result_sha256 and to the response_hash of the receipt, and the receipt is signed by the supplier key of the registry record', () => {
  const raw = readFileSync(new URL(`../${AS_RUN.evidence}`, import.meta.url));
  assert.equal(raw.length, AS_RUN.evidenceBytes, 'copied byte for byte: its size');
  assert.equal(createHash('sha256').update(raw).digest('hex'), AS_RUN.evidenceSha256, 'copied byte for byte: its sha256');
  const ev = JSON.parse(raw.toString('utf8'));
  assert.deepEqual(Object.keys(ev), ['run', 'capability_id', 'builder', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'explorer', 'verdict', 'checks', 'receipt', 'receipt_signature', 'result_sha256', 'result'], 'the fields the script prints, in its order');
  assert.equal(ev.run, 'first-party');
  assert.equal(ev.verdict, 'VERIFIED');
  assert.equal(ev.capability_id, AGENTS['audio-snippets'].capability);
  assert.equal(ev.advert_ref, AS.firstAdvertRef, 'the run was made against the first advert, which was retired at the status flip');
  assert.equal(ev.escrow_ref, AS_RUN.escrowRef);
  assert.equal(ev.post_tx, AS_RUN.postTx);
  assert.equal(ev.accept_tx, AS_RUN.acceptTx);
  assert.equal(ev.escrow_ref, `${ev.post_tx}#0`, 'the escrow is the first output of the post transaction');
  assert.notEqual(ev.post_tx, ev.accept_tx, 'two transactions');
  assert.deepEqual(ev.explorer, { post: EXPLORER_TX + AS_RUN.postTx, accept: EXPLORER_TX + AS_RUN.acceptTx });
  // The five checks and the extra prompt_hash row all passed.
  assert.deepEqual(ev.checks, Object.fromEntries(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches'].map((row) => [row, 'pass'])));
  // The result is the exact string the receipt covers: its sha256 is result_sha256 and the response_hash of the receipt.
  assert.equal(typeof ev.result, 'string');
  assert.equal(sha256(ev.result), ev.result_sha256);
  assert.equal(ev.result_sha256, ev.receipt.response_hash);
  assert.equal(ev.result_sha256, AS_RUN.responseHash);
  assert.equal(Buffer.byteLength(ev.result, 'utf8'), 50156);
  // The receipt has the eight fields of the guide, names this escrow and the supplier key of the registry record, and carries no model cost (the runtime counts none).
  assert.deepEqual(Object.keys(ev.receipt).sort(), ['completion_tokens', 'escrow_ref', 'model', 'prompt_hash', 'prompt_tokens', 'response_hash', 'supplier_pkh', 'wallclock_ms']);
  assert.equal(ev.receipt.escrow_ref, ev.escrow_ref);
  assert.equal(ev.receipt.supplier_pkh, AS.controllerPkh);
  assert.equal(ev.receipt.model, AGENTS['audio-snippets'].model);
  assert.equal(ev.receipt.prompt_tokens, 0);
  assert.equal(ev.receipt.completion_tokens, 0);
  assert.equal(ev.receipt.wallclock_ms, AS_RUN.wallclockMs);
  assert.match(ev.receipt.prompt_hash, /^[0-9a-f]{64}$/);
  // The signature is Ed25519 over the canonical JSON of the receipt, and it verifies with the public key of the supplier key.
  assert.ok(section(read('audio-snippets'), 'What the receipt commits to').includes('The signature is Ed25519 over the canonical JSON of the receipt.'));
  assert.match(ev.receipt_signature, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 64 bytes');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(AS.pubKey, 'hex').toString('base64url') }, format: 'jwk' });
  assert.equal(verifySignature(null, Buffer.from(canonical(ev.receipt), 'utf8'), key, Buffer.from(ev.receipt_signature, 'hex')), true, 'the receipt is signed by the supplier key');
  assert.equal(verifySignature(null, Buffer.from(canonical({ ...ev.receipt, wallclock_ms: ev.receipt.wallclock_ms + 1 }), 'utf8'), key, Buffer.from(ev.receipt_signature, 'hex')), false, 'and by nothing else: one field changed fails it');
  // The result: one public-domain recording of about six minutes within the Terms of the page, transcribed in English by the model of the image, the one quote found, nothing unmatched, no clips.
  const result = JSON.parse(ev.result);
  assert.equal(result.schema, 'vector.audio-snippets.result.v1');
  assert.deepEqual({ bytes: result.source.bytes, mime: result.source.mime, duration_s: result.source.duration_s }, { bytes: 2915521, mime: 'audio/mpeg', duration_s: 364.303 });
  assert.match(result.source.sha256, /^[0-9a-f]{64}$/);
  assert.ok(result.source.duration_s <= 600 && result.source.bytes <= 52428800, 'at most 10 min and 50 MB');
  assert.equal(result.model, 'faster-whisper-base-int8');
  assert.equal(result.language, 'en');
  assert.ok(Array.isArray(result.transcript) && result.transcript.length > 0, 'a word-timed transcript');
  assert.equal(result.matches.length, 1);
  assert.deepEqual([result.matches[0].from, result.matches[0].text], ['quote', AS_RUN.quote]);
  assert.deepEqual([result.unmatched, result.clips, result.clips_truncated], [[], [], false]);
});

test('docs/E2E.md, specs/audio-snippets.md and the guide record the first-party run of Audio Snippets of 2026-10-17 with the same references, and the status word is DEPLOYED, not LIVE', () => {
  const e2e = doc('E2E.md');
  const ev = JSON.parse(readFileSync(new URL(`../${AS_RUN.evidence}`, import.meta.url), 'utf8'));
  const result = JSON.parse(ev.result);
  // The Results table has its row (the test of Agent History's run holds the three rows in order), and the status paragraph says the run and the adverts in the words of the spec.
  assert.ok(e2e.split('\n').includes(`| 2026-10-17 | Audio Snippets | first-party | \`${AS_RUN.escrowRef}\` | ${explorerLink(AS_RUN.postTx)} | ${explorerLink(AS_RUN.acceptTx)} | VERIFIED |`));
  assert.ok(e2e.includes(`The current Audio Snippets advert was posted on 2026-10-17, reference \`${AS.advertRef}\`. Its first first-party run settled on 2026-10-17 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip. The marketplace indexer lists the current advert as Active and free as of 2026-10-17.`));
  assert.equal(e2e.includes(AS.firstAdvertTx), false, 'the retired advert is named by what it was, not by its reference');
  // The section of the runbook says that the agent is advertised and that its ADVERT_REF is the current advert.
  const hiring = section(e2e, 'Hiring Audio Snippets');
  assert.ok(hiring.startsWith('\nAudio Snippets has been advertised since 2026-10-17, and its first first-party run settled that day (see [Results](#results)). `ADVERT_REF` below is its current advert, posted that day at the status flip.'));
  assert.equal(hiring.match(/has no advert|posts one in step 12|is built and has no/), null, 'the words of before the advert');
  // The paragraph under the table names the evidence file, how to repeat the check, and the numbers of the run, which are those of the file and of the Terms of the page.
  const results = section(e2e, 'Results');
  assert.ok(results.includes(`[${AS_RUN.evidence}](${AS_RUN.evidence.replace(/^docs\//, '')})`), 'a link from docs/E2E.md to the evidence file');
  const paragraph = results.split('\n').find((l) => l.startsWith('The evidence of the Audio Snippets run is ')) ?? '';
  const terms = section(read('audio-snippets'), 'Terms');
  const unit = (label) => Number(terms.split('\n').find((l) => l.startsWith(`| ${label} | `))?.split(' | ')[1]) / 1_000_000;
  const received = (unit('Price') + unit('Supplier bond')).toFixed(6);
  assert.equal(received, '3.000000', 'the price and the supplier bond go to the supplier on Accept');
  for (const part of [
    'the object the script printed, unchanged', 'the untouched `result`',
    `the URL of a public-domain LibriVox recording of ${result.source.duration_s} s (${result.source.bytes} bytes, \`${result.source.mime}\`), the language \`${result.language}\`, one quote, "${AS_RUN.quote}", and no clips`,
    'against the first advert, which was retired at the status flip the same day',
    `The result holds ${result.matches.length} match, ${result.unmatched.length} unmatched and ${result.clips.length} clips.`, `The supplier's wall clock was ${ev.receipt.wallclock_ms} ms.`,
    `the supplier received the price, ${unit('Price')}, and the supplier bond, ${unit('Supplier bond')} (${received} in all), and the buyer bond came back to the buyer.`,
    'Both keys were ours. It is not demand.',
  ]) assert.ok(paragraph.includes(part), `the paragraph on the run of Audio Snippets says ${part}`);
  assert.ok(existsSync(new URL(`../${AS_RUN.evidence}`, import.meta.url)), 'the evidence file the docs name exists');
  // The spec says it in the Status line and paragraph and in How to hire it, and its Links point at the evidence and at the two transactions.
  const spec = read('audio-snippets');
  assert.ok(section(spec, 'Status').includes(AS_STATUS));
  for (const heading of ['Status', 'How to hire it']) assert.ok(section(spec, heading).includes('One first-party job has settled, on 2026-10-17; it is not demand.'), heading);
  assert.ok(section(spec, 'Links').includes(`- First-party hire on 2026-10-17, verdict VERIFIED, made against the first advert: the post transaction ${explorerLink(AS_RUN.postTx)} and the accept transaction ${explorerLink(AS_RUN.acceptTx)} on the explorer, and the evidence in [${AS_RUN.evidence}](../${AS_RUN.evidence}).`));
  // The guide gives the agent a row of its table: the status line, the current advert and the public URL.
  assert.ok(hire().split('\n').includes(`| Audio Snippets, capability \`audio.transcript.snippets.v1\` | ${AS_STATUS} The advert reference is \`${AS.advertRef}\`, listed as Active and free on 2026-10-17. The public URL, \`https://mp-suppliers-snippets.hal8.ai\`, is in service as of 2026-10-17. |`));
  // Nothing that states where the agent stands says that no job settled or that no first-party run is recorded.
  const files = ['specs/audio-snippets.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/audio-snippets/README.md', 'deploy/host/docker-compose.audio-snippets.yml', 'deploy/host/README.md', 'deploy/host/RUNBOOK-audio-snippets.md'];
  for (const file of files) assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').match(/no job (has )?(settled|run)|no first-party run of the path is recorded/i), null, file);
});

test('docs/HIRE.md and docs/E2E.md: Audio Snippets has a subsection of section 5 and a section of the E2E runbook, with a request the intake takes, its window and no clips through the hosted server', () => {
  const sub = section(hire(), '5. The chat script').split('\n### The same script for Audio Snippets\n')[1] ?? '';
  assert.ok(sub.includes('Ask for `audio.transcript.snippets.v1` in message 2'));
  assert.ok(sub.includes('```json\n{"source":{"url":"https://example.org/talk.mp3"},"language":"en","quotes":["a quote that was said in the talk"]}\n```'));
  assert.ok(sub.includes('the hosted server reads at most 1000000 bytes of the answer of a job, and clips can be larger'));
  assert.ok(sub.includes('A request can also carry a `query` and `ranges`, and the answer holds the transcript, the matches with their cut points and the clips: [specs/audio-snippets.md](../specs/audio-snippets.md) gives every field, under Request and Response.'), 'the page gives the rest of the request and the result');
  for (const heading of ['Request', 'Response']) assert.ok(read('audio-snippets').includes(`\n### ${heading}\n`), heading);
  assert.ok(sub.includes('which is your Post time plus 25 min plus 180 s. The price is 2 and a job costs about 4 (the cost table in section 3).'));
  const e2e = section(doc('E2E.md'), 'Hiring Audio Snippets');
  for (const part of ['export CAPABILITY_ID=audio.transcript.snippets.v1', 'export E2E_POLL_MS=10000', 'export E2E_STATE=./e2e-state-snippets.json', '[deploy/host/RUNBOOK-audio-snippets.md](../deploy/host/RUNBOOK-audio-snippets.md)', 'which is 28 minutes after the Post (the 25 min window and 180 s)']) assert.ok(e2e.includes(part), part);
  assert.equal((1_500_000 + 180_000) / 60_000, 28);
  assert.ok(doc('E2E.md').indexOf('\n## Hiring Audio Snippets\n') > doc('E2E.md').indexOf('\n## Hiring Document Pipeline\n'));
});

// Beyond the brief (R-D20): the numbers the guide and the E2E section state for Audio Snippets are the page's and the script's. The guide asks for a recording of at most the
// duration and the file size of the Terms; the E2E section counts the asks of the default pause of the script over the 25 min window of the advert.
test('docs/HIRE.md and docs/E2E.md: the recording of the guide is within the Terms of the page, and the asks counted in the E2E section are the default pause of the script over the 25 min window', () => {
  const terms = section(read('audio-snippets'), 'Terms');
  assert.ok(terms.includes('| Duration | 10 min (') && terms.includes('| Fetched file | 50 MB ('));
  const guide = section(hire(), '5. The chat script').split('\n### The same script for Audio Snippets\n')[1] ?? '';
  assert.ok(guide.includes('of at most 10 minutes and 50 MB'));
  assert.ok(guide.includes('Its processing window is 25 min, so message 4 can wait that long'));
  assert.match(terms, /\| Processing window, advert `max_processing_ms` \| 1500000 ms \|/);
  assert.equal(1_500_000 / 60_000, 25);
  const pause = Number(/POLL_MS = env\.E2E_POLL_MS === undefined \? (\d+) :/.exec(e2eScript())?.[1]);
  assert.equal(pause, 5000);
  assert.equal(25 * 60 * 1000 / pause, 300);
  assert.ok(section(doc('E2E.md'), 'Hiring Audio Snippets').includes("- `E2E_POLL_MS=10000`: a job can take far longer than the seconds of Agent History's, up to the 25 min window, and the default pause of 5 s would ask the hosted server about 300 times in 25 minutes."));
});

// Ruling R-D25: the E2E runbook says what a first-party run shows and what it is not, and the word a clause of it added is on no page. The word is spelled in two
// parts, as the unit name is, so that a search for it finds no file.
test('docs/E2E.md: a first-party run shows that the path works and is neither ignition nor demand; no spec, guide or README holds the word the clause added', () => {
  const e2e = doc('E2E.md');
  assert.ok(e2e.includes('A first-party run shows that the path works. It is not ignition, and it is not demand.'));
  assert.ok(e2e.includes('One fill is not a market, and a first-party run is never counted as demand.'));
  for (const text of [e2e, hire(), readFileSync(new URL('../README.md', import.meta.url), 'utf8'), ...Object.keys(AGENTS).map((name) => read(name))]) assert.doesNotMatch(text, new RegExp('reve' + 'nue', 'i'));
});

// ---- Advocate: built on 2026-10-17, registered, staked and advertised on 2026-10-19, DEPLOYED since 2026-10-20 ----
// The service is built and its tests run the search, the pages, the hire of a chat supplier, the model and the check against stand-ins. It has had a registry record, a stake and an advert since
// 2026-10-19, runs on the operator's host and has settled one first-party job, on 2026-10-20, so the word is DEPLOYED, never LIVE. The page says what is built and what runs, and the words of the
// design it was before the build and of before the flip do not come back. agents/advocate/test/spec.test.ts holds the rest of the page to the code and the manifest: the gap sentences, the
// numbers, the response example, the error codes, the third parties.
const AD_PARAGRAPH = "The service is built. Its tests run the search, the pages, the hire of a chat supplier, the model and the check against stand-ins for the Brave Search API, the result pages, a chat supplier of the marketplace, the chain and OpenRouter, with no network. It is deployed on the operator's host, has had a registry record since 2026-10-19 and has had an advert since 2026-10-19. One first-party job has settled, on 2026-10-20; it is not demand. No buyer outside the team has hired it. Nothing on this page is LIVE.";

test('specs/advocate.md: the Status line says DEPLOYED since 2026-10-20, the paragraph says what is built, what runs and that nothing is LIVE, and the words of before the flip and of the design do not come back', () => {
  const text = read('advocate');
  assert.equal(section(text, 'Status').trim(), `${AD_STATUS}\n\n${AD_PARAGRAPH}`);
  assert.equal(section(text, 'Status').match(/PROPOSED|not deployed/), null, 'the words of before the flip do not come back');
  assert.equal(text.match(/no job (has )?(settled|run)|no registry record yet|has no DID yet|is not deployed yet|has no advert|no advert yet/i), null, 'the spec does not say that nothing happened');
  assert.ok(section(text, 'Identity').includes(`\n${AD_HAS_RECORD}\n`));
  assert.equal(text.match(/PROPOSED \(not built\)|This page is a design|There is no code|None of this is built|Illustrative|Backend \(design\)|No releases|The planned folder|Not built\. Everything|8 to 12|A Judge agent|Nothing is built/), null, 'the words of before the build do not come back');
  const links = section(text, 'Links').split('\n');
  for (const line of [
    "- Manifest: `GET /agent.json` on the agent's public URL, in service as of 2026-10-19. The service renders it from its environment when it starts. The template is [agents/advocate/agent.json.template](../agents/advocate/agent.json.template).",
    '- Source: [agents/advocate](../agents/advocate)',
  ]) assert.ok(links.includes(line), line);
  // The manifest served at the public URL is the one of the image rebuilt from the merge of 2026-10-19, and carries deployed since the flip: the sentence about the build of before goes.
  assert.equal(text.match(/ccbcb94|rebuilt from this change|before step 11 of the runbook|Advert on the explorer: none/), null, 'the words of before the rebuild and the advert');
  for (const path of ['agents/advocate', 'agents/advocate/agent.json.template', 'agents/advocate/src/gaps.ts']) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${path} exists`);
  // The declared bias is stated as the rule, in the shape and in the example (the test of the Pipeline's economics counts the three), and the check of the quotes has a section of its own.
  assert.ok(section(text, 'Interface').includes('\n### Check\n') && section(text, 'Interface').includes('the thesis never answers alone'));
  assert.equal(section(text, 'Known gaps').split('\n').filter((l) => l.startsWith('- ')).length, 8, 'the eight gaps of the manifest, and none of the page\'s own');
});

// ---- Advocate since Plan E2: the model call bought first on the marketplace, OpenRouter as the fallback ----
// The page states the economics of the one chat sub-job in the form of the Pipeline's, the inference in one sentence of the job order, and how it buys in a
// section of its own, with the rule of the fallback. agents/advocate/test/spec.test.ts holds the numbers of the section to the code.
test('specs/advocate.md: the Economics line under Terms in the form of the Pipeline\'s, the inference in the job order, and How it buys with the first-party label and the rule of the fallback', () => {
  const text = read('advocate');
  const terms = section(text, 'Terms');
  assert.ok(terms.includes("Economics: a job costs the hirer about 5 (the price of 3, the supplier bond of 1 and about 1 in fees; the buyer bond returns on Accept). Its one chat sub-job costs the service about 2.2 net at today's fleet price of 0.2 per sub-job (the price, the supplier bond of 1 and about 1 in fees), against a job price of 3;"));
  assert.ok(terms.includes('the lock and fees in flight come to about 3.2 at that price, and up to 4.0 at the ceiling of 1 (`LLM_MAX_PRICE_LOVELACE`), of which the buyer bond and the lock excess return on Accept.'));
  assert.ok(terms.includes('The Foundation carries that on purpose while the fee floor stands.'));
  // The form of the Pipeline's line, which the design gives: what the sub-jobs cost at today's fleet price, each sub-job's parts, against the price of a job.
  assert.ok(section(read('document-pipeline'), 'Terms').includes("cost it about 13 net at today's fleet price of 0.2 per sub-job (each sub-job: the price, the supplier bond of 1 and about 1 in fees), against a job price of 5;"));
  assert.ok(section(hire(), '3. What the key must hold').split('\n').includes('| 3 (Advocate) | 5 | 4 | 1 | about 1 | about 5 | 10 |'), 'what a job costs the hirer, the cost table of the guide');
  const inter = section(text, 'Interface');
  assert.ok(inter.includes("The model call is bought first from a chat supplier on the Vector marketplace: the service posts a bonded escrow with its own buyer key, sends the prompt, verifies the supplier's signed receipt and accepts; only when that hire fails is the call made through OpenRouter, and the result says which path it took"));
  assert.ok(inter.indexOf('\n### How it buys\n') > inter.indexOf('\n### Check\n') && inter.indexOf('\n### How it buys\n') < inter.indexOf('\n### Errors\n'), 'after Check, before Errors');
  const how = (inter.split('\n### How it buys\n')[1] ?? '').split('\n### ')[0];
  assert.ok(how.includes('Every chat supplier it can hire today is first-party: a brief bought on the marketplace shows that the path works, and it is not demand.'));
  for (const head of ['**The choice.**', '**The hire.**', '**Time.**', '**The fallback.**', '**What a job leaves behind.**', '**Where the code is.**']) assert.ok(how.includes(head), head);
  // The rule of the fallback: every row says what ends the hire, its code, where the escrow is left and whether the job falls back; the rows that do not fall back
  // say what the job answers instead.
  const rows = how.split('\n').filter((l) => /^\| /.test(l) && !/^[|][-| ]+[|]$/.test(l));
  const fallback = rows.slice(rows.indexOf('| The hire ends | Code | The escrow then | Falls back |') + 1);
  assert.equal(fallback.length, 19);
  for (const row of fallback) assert.equal(row.split(' | ').length, 4, `four columns: ${row.slice(0, 60)}`);
  // The first row is the path that is off: after a write of the record failed, every later job goes to OpenRouter until a restart, and the code says so.
  assert.equal(fallback[0], '| the marketplace path is off: a write of the record failed in an earlier job, and the service has not restarted since | `marketplace_off` | none | yes |');
  assert.ok(readFileSync(new URL('../agents/advocate/src/inference.ts', import.meta.url), 'utf8').includes("'marketplace_off'"), 'the code of the path that is off is the code\'s');
  const no = fallback.filter((row) => / \| no[:|]/.test(row) || row.endsWith('| no |'));
  assert.deepEqual(no.map((row) => row.split(' | ')[1]), ['none', '`llm_accept_failed`', '`store_write_failed`', '`aborted`', '`no_supported_claims`'], 'what never falls back: a verified answer, a failed Accept, a failed record, a caller that left, a brief the check empties');
  assert.ok(how.includes('The job falls back to OpenRouter whenever the service holds no answer of the chat supplier that it could still verify and accept, never while it holds one, and never after a record could not be written or the caller left.'));
  // The two codes a job of the service fails with besides those of before, with their statuses, in the Errors of the page.
  const errors = (inter.split('\n### Errors\n')[1] ?? '');
  assert.ok(errors.includes('`inference_failed` (the answer of the chat supplier was verified and the Accept of its escrow could not land)'));
  assert.ok(errors.includes('| 500, the service | `store_write_failed` (an escrow was posted and could not be recorded), and `internal` |'));
  // The words of before the hire do not come back.
  assert.equal(text.match(/holds no chain key|posts nothing|nothing is written to disk|within 150 s|5 min processing window/), null);
});

test('specs/advocate.md: the DID, the registry record, the reputation stake and the buyer key of 2026-10-19 are in the Identity table, the URL is in service as of 2026-10-19, the current advert carries the terms of the page, and the first advert (retired at the flip), the current advert and the first-party hire are in the Links', () => {
  const text = read('advocate');
  const row = (label) => section(text, 'Identity').split('\n').find((l) => l.startsWith(`| ${label} |`)) ?? '';
  const policy = /did:vector:agent:([0-9a-f]{56}):/.exec(section(read('agent-history'), 'Interface'))?.[1] ?? '';
  assert.match(AD.did, new RegExp(`^did:vector:agent:${policy}:[0-9a-f]{64}$`));
  for (const other of [AH.did, DP.did, AS.did]) assert.notEqual(AD.did, other, 'its own asset name');
  assert.equal(row('DID'), `| DID | \`${AD.did}\` |`);
  // The supplier key: the Controller row gives its public key, the one the manifest serves, and the Registry record row its key hash (agents/advocate/test/spec.test.ts holds the one to the other).
  assert.ok(row('Controller').startsWith(`| Controller | the supplier key, the key that signs this agent's receipts. Its public key is \`${AD.pubKey}\`. The manifest publishes`));
  const record = row('Registry record');
  for (const part of [
    'name `Advocate`', 'description as in the manifest, which declares the bias', 'capabilities `research.advocate.onesided.v1`', 'framework `vector-service-agents`',
    "endpoint the agent's public URL, `https://mp-suppliers-advocate.hal8.ai`", `controller key hash \`${AD.controllerPkh}\` (the supplier key hash)`,
    'Registered on 2026-10-19 in the confirmed transaction', `[\`${AD.registerTx}\`](${EXPLORER_TX}${AD.registerTx})`, 'The deposit is 10000000 lovelace (10.000000), refundable on deregistration',
  ]) assert.ok(record.includes(part), `the Registry record row says: ${part}`);
  const stake = row('Reputation stake');
  for (const part of ['a Module-3 self-stake of 10000000 lovelace (10.000000) on the capability', 'made on 2026-10-19 in transaction', `[\`${AD.stakeTx}\`](${EXPLORER_TX}${AD.stakeTx})`]) assert.ok(stake.includes(part), `the Reputation stake row says: ${part}`);
  // Two keys: the buyer key, made on the host on 2026-10-19 when step 4 ran again, is a key of its own, and its key hash is the one the manifest serves under keys.buyer_pkh.
  for (const pkh of [AD.controllerPkh, AD.buyerPkh]) assert.match(pkh, /^[0-9a-f]{56}$/);
  assert.notEqual(AD.buyerPkh, AD.controllerPkh, 'the buyer key is not the supplier key');
  assert.ok(row('Second key').startsWith('| Second key | the buyer key, a separate key that posts the escrow of the chat sub-job of a job,'));
  assert.ok(row('Second key').includes(`It was made on the host on 2026-10-19, in step 4 of the runbook. The manifest publishes its key hash, \`${AD.buyerPkh}\`, as \`keys.buyer_pkh\`, which the service derives from the key |`));
  for (const hex of [AD.registerTx, AD.stakeTx, AD.firstAdvertTx, AD.retireTx, AD.advertTx, AD.firstManifestHash, AD.manifestHash, AD.pubKey]) assert.match(hex, /^[0-9a-f]{64}$/);
  assert.equal(new Set([AD.registerTx, AD.stakeTx, AD.firstAdvertTx, AD.retireTx, AD.advertTx, AD_RUN.postTx, AD_RUN.acceptTx]).size, 7, 'seven transactions: the registration, the stake, the first advert, its retirement, the current advert, the post and the accept of the run');
  assert.notEqual(AD.firstManifestHash, AD.manifestHash, 'the flip changed the manifest, so the advert was posted again');
  assert.equal(AD.firstAdvertRef, `${AD.firstAdvertTx}#0`);
  assert.equal(AD.advertRef, `${AD.advertTx}#0`);
  // The URL is in service as of 2026-10-19 (step 10), so no row is "planned" any more.
  assert.equal(row('Public URL'), '| Public URL | `https://mp-suppliers-advocate.hal8.ai` (in service as of 2026-10-19) |');
  for (const label of ['Registry record, planned', 'Public URL, planned', 'Reputation stake, planned', 'Second key, planned']) assert.equal(row(label), '', `${label} is gone`);
  // The current advert carries the terms of the page: the price and the bonds of the Terms table and its window, as step 12 of the runbook posts it.
  const terms = section(text, 'Terms');
  const lovelace = (label) => Number(terms.split('\n').find((l) => l.startsWith(`| ${label} | `))?.split(' | ')[1]);
  assert.deepEqual([lovelace('Price'), lovelace('Supplier bond'), lovelace('Buyer bond')], [AD.terms.price, AD.terms.supplierBond, AD.terms.buyerBond]);
  assert.ok(terms.includes(`| Processing window, advert \`max_processing_ms\` | ${AD.terms.maxProcessingMs} ms |`));
  const twelve = section(readFileSync(new URL('../deploy/host/RUNBOOK-advocate.md', import.meta.url), 'utf8'), '12. Post the advert');
  for (const flag of [`--price-lovelace ${AD.terms.price} `, `--max-processing-ms ${AD.terms.maxProcessingMs} `]) assert.equal(twelve.split(flag).length - 1, 2, `the dry run and the real run post the advert with ${flag.trim()}`);
  // The first advert was posted on 2026-10-19 and retired at the flip of 2026-10-20 (step 17): the Links keep it as history, with the manifest it hashed, and give the current one with its manifest hash.
  const links = section(text, 'Links');
  assert.ok(links.includes(`- First advert \`${AD.firstAdvertRef}\`, posted on 2026-10-19 in the confirmed transaction ${explorerLink(AD.firstAdvertTx)}, manifest hash \`${AD.firstManifestHash}\` (the manifest before the status flip), retired on 2026-10-20 at the status flip in the confirmed transaction ${explorerLink(AD.retireTx)}.`));
  assert.ok(links.includes(`- Current advert \`${AD.advertRef}\`, posted on 2026-10-20 at the status flip in the confirmed transaction ${explorerLink(AD.advertTx)}, manifest hash \`${AD.manifestHash}\`. The marketplace indexer lists it as Active and free (checked on 2026-10-20).`));
  assert.ok(section(text, 'How to hire it').includes('Advertised on 2026-10-19 and again on 2026-10-20, at the status flip: the marketplace indexer lists the current advert as Active and free (checked on 2026-10-20). One first-party job has settled, on 2026-10-20; it is not demand. The three ways below apply.'));
  // The words of before the registration and of before the advert do not come back; the runbooks quote them as instructions.
  assert.equal(text.match(/no registry record|not registered|When registered|planned registry record|not served yet|not in service|none yet|not posted|not yet advertised|none until deployed|once it is in service|waits for its deployment|Once advertised|no advert yet/i), null, 'the words of before the registration and the advert');
});

// ---- The first first-party run of Advocate, 2026-10-20 (RUNBOOK-advocate step 15) ----
// docs/E2E.md records it in the Results table, and docs/evidence/ holds the object the script printed, byte for byte. Both keys were ours, and so were both sides of its sub-job, so the run shows
// that the path works and is not demand. The run was made against the first advert, which step 17 retired the same day. The ledger rows of the receipt check need the chain and are repeated by hand
// with the tool. The signature needs only the public key, which the spec gives and the manifest serves, and the prompt hash only the request, so both are checked here.
test('docs/evidence: the evidence of the first-party run of Advocate of 2026-10-20 is the file the script printed, parses, is VERIFIED, its brief hashes to result_sha256 and to the response_hash of the receipt, the receipt is signed by the supplier key of the registry record and commits to the request of the page, and the brief was bought on the marketplace under a sub-receipt that passed the seven checks', () => {
  const raw = readFileSync(new URL(`../${AD_RUN.evidence}`, import.meta.url));
  assert.equal(raw.length, AD_RUN.evidenceBytes, 'copied byte for byte: its size');
  assert.equal(createHash('sha256').update(raw).digest('hex'), AD_RUN.evidenceSha256, 'copied byte for byte: its sha256');
  const ev = JSON.parse(raw.toString('utf8'));
  assert.deepEqual(Object.keys(ev), ['run', 'capability_id', 'builder', 'advert_ref', 'escrow_ref', 'post_tx', 'accept_tx', 'explorer', 'verdict', 'checks', 'receipt', 'receipt_signature', 'result_sha256', 'result'], 'the fields the script prints, in its order');
  assert.deepEqual([ev.run, ev.verdict, ev.capability_id, ev.builder], ['first-party', 'VERIFIED', AGENTS.advocate.capability, 'https://mcp.vector.mainnet.apexfusion.org/mcp']);
  assert.equal(ev.advert_ref, AD.firstAdvertRef, 'the run was made against the first advert, which was retired at the status flip');
  assert.deepEqual([ev.escrow_ref, ev.post_tx, ev.accept_tx], [AD_RUN.escrowRef, AD_RUN.postTx, AD_RUN.acceptTx]);
  assert.equal(ev.escrow_ref, `${ev.post_tx}#0`, 'the escrow is the first output of the post transaction');
  assert.notEqual(ev.post_tx, ev.accept_tx, 'two transactions');
  assert.deepEqual(ev.explorer, { post: EXPLORER_TX + AD_RUN.postTx, accept: EXPLORER_TX + AD_RUN.acceptTx });
  // The five checks and the extra prompt_hash row all passed.
  assert.deepEqual(ev.checks, Object.fromEntries(['escrow_ref_matches', 'response_hash_matches', 'supplier_key_matches', 'signature_valid', 'on_chain_hash_matches', 'prompt_hash_matches'].map((row) => [row, 'pass'])));
  // The result is the exact string the receipt covers: its sha256 is result_sha256 and the response_hash of the receipt.
  assert.equal(typeof ev.result, 'string');
  assert.equal(sha256(ev.result), ev.result_sha256);
  assert.equal(ev.result_sha256, ev.receipt.response_hash);
  assert.equal(ev.result_sha256, AD_RUN.responseHash);
  // The receipt has the eight fields of the guide, names this escrow and the supplier key of the registry record, and counts no tokens: the runtime counts none, and the sub-receipt does.
  assert.deepEqual(Object.keys(ev.receipt).sort(), ['completion_tokens', 'escrow_ref', 'model', 'prompt_hash', 'prompt_tokens', 'response_hash', 'supplier_pkh', 'wallclock_ms']);
  assert.deepEqual([ev.receipt.escrow_ref, ev.receipt.supplier_pkh, ev.receipt.model], [ev.escrow_ref, AD.controllerPkh, AGENTS.advocate.model]);
  assert.deepEqual([ev.receipt.prompt_tokens, ev.receipt.completion_tokens, ev.receipt.wallclock_ms], [0, 0, AD_RUN.wallclockMs]);
  // The signature is Ed25519 over the canonical JSON of the receipt, and it verifies with the public key of the supplier key.
  assert.ok(section(read('advocate'), 'What the receipt commits to').includes('The signature is Ed25519 over the canonical JSON of the receipt.'));
  assert.match(ev.receipt_signature, /^[0-9a-f]{128}$/, 'an Ed25519 signature is 64 bytes');
  const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(AD.pubKey, 'hex').toString('base64url') }, format: 'jwk' });
  assert.equal(verifySignature(null, Buffer.from(canonical(ev.receipt), 'utf8'), key, Buffer.from(ev.receipt_signature, 'hex')), true, 'the receipt is signed by the supplier key');
  assert.equal(verifySignature(null, Buffer.from(canonical({ ...ev.receipt, wallclock_ms: ev.receipt.wallclock_ms + 1 }), 'utf8'), key, Buffer.from(ev.receipt_signature, 'hex')), false, 'and by nothing else: one field changed fails it');
  // The prompt hash commits to the request of the run: the sha256 of the wire payload of the PAYLOAD of the section "Hiring Advocate", which is the example of the page.
  const payload = /\nexport PAYLOAD='([^']+)'\n/.exec(section(doc('E2E.md'), 'Hiring Advocate'))?.[1] ?? '';
  assert.deepEqual(JSON.parse(payload), AD_RUN.request);
  assert.deepEqual(JSON.parse(/Example:\n\n```json\n([\s\S]*?)\n```/.exec(section(read('advocate'), 'Interface'))?.[1] ?? 'null'), AD_RUN.request, 'the example of the page');
  assert.equal(sha256(canonical([{ content: payload, role: 'user' }])), ev.receipt.prompt_hash, 'the prompt hash is the sha256 of the wire payload of that request');
  // The brief: the side it declares, three arguments and the eight sources they cite, from the search of the page, and its model call bought on the marketplace, accepted and confirmed.
  const result = JSON.parse(ev.result);
  assert.deepEqual([result.schema, result.declared_bias.side, result.search], ['vector.advocate.brief.v1', AD_RUN.request.side, 'Brave Search API']);
  assert.deepEqual([result.arguments.length, result.sources.length, result.arguments.flatMap((a) => a.sources).length], [3, 8, 8]);
  assert.equal(result.model, `${AD_RUN.subJob.model} via the Vector marketplace`);
  assert.deepEqual([result.inference.path, result.inference.fallback_from, result.inference.accepted], ['marketplace', null, 'confirmed']);
  // The sub-job: the chat supplier the service hired with its own buyer key, its escrow, and a sub-receipt of that supplier that passed the seven checks of the page.
  const sub = result.inference.sub_job;
  assert.deepEqual([sub.capability_id, sub.advert_ref, sub.escrow_ref, sub.supplier_pkh], [AD_RUN.subJob.capability, AD_RUN.subJob.advertRef, AD_RUN.subJob.escrowRef, AD_RUN.subJob.supplierPkh]);
  assert.deepEqual([sub.receipt.escrow_ref, sub.receipt.supplier_pkh, sub.receipt.model], [sub.escrow_ref, sub.supplier_pkh, AD_RUN.subJob.model]);
  assert.deepEqual([sub.receipt.prompt_tokens, sub.receipt.completion_tokens, sub.receipt.wallclock_ms], [AD_RUN.subJob.promptTokens, AD_RUN.subJob.completionTokens, AD_RUN.subJob.wallclockMs]);
  assert.match(sub.receipt_signature, /^[0-9a-f]{128}$/);
  const how = (section(read('advocate'), 'Interface').split('\n### How it buys\n')[1] ?? '').split('\n### ')[0];
  const seven = how.split('\n').filter((l) => /^\| `[a-z_]+` \|/.test(l)).map((l) => l.split(' | ')[0].slice(3, -1));
  assert.equal(seven.length, 7);
  assert.deepEqual(sub.verification, Object.fromEntries(seven.map((check) => [check, true])), 'the seven checks of the page, in its order, all passed');
  // The line of the job the docs quote is the line the code writes (src/server.ts): its counts are those of the brief and of the sub-receipt, and the time of the service is within the wall clock of the receipt.
  const template = /return `(job done in [^`]+)`;/.exec(readFileSync(new URL('../agents/advocate/src/server.ts', import.meta.url), 'utf8'))?.[1] ?? '';
  const parts = template.split(/\$\{[^}]+\}/);
  assert.equal(parts.length, 9, 'eight values in the line');
  const values = new RegExp(`^${parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+?)')}$`).exec(AD_RUN.jobLine)?.slice(1) ?? [];
  assert.deepEqual(values.slice(1), ['12', '6', String(result.arguments.length), '0', '1', `${sub.receipt.prompt_tokens}/${sub.receipt.completion_tokens}`, 'marketplace']);
  assert.ok(Number(values[0]) <= ev.receipt.wallclock_ms, 'the service took no longer than the supplier wall clock of the receipt');
});

test('docs/E2E.md, specs/advocate.md and the guide record the first-party run of Advocate of 2026-10-20 with the same references, and the status word is DEPLOYED, not LIVE', () => {
  const e2e = doc('E2E.md');
  const ev = JSON.parse(readFileSync(new URL(`../${AD_RUN.evidence}`, import.meta.url), 'utf8'));
  const result = JSON.parse(ev.result);
  const sub = result.inference.sub_job;
  // The Results table has its row (the test of Agent History's run holds the four rows in order), and the status paragraph says the run and the adverts in the words of the spec.
  assert.ok(e2e.split('\n').includes(`| 2026-10-20 | Advocate | first-party | \`${AD_RUN.escrowRef}\` | ${explorerLink(AD_RUN.postTx)} | ${explorerLink(AD_RUN.acceptTx)} | VERIFIED |`));
  assert.ok(e2e.includes(`The current Advocate advert was posted on 2026-10-20, reference \`${AD.advertRef}\`. Its first first-party run settled on 2026-10-20 (verdict VERIFIED, see [Results](#results)); it was made against the first advert, which was retired that day at the status flip. The marketplace indexer lists the current advert as Active and free as of 2026-10-20.`));
  assert.equal(e2e.includes(AD.firstAdvertTx), false, 'the retired advert is named by what it was, not by its reference');
  // The section of the runbook says that the agent is advertised and that its ADVERT_REF is the current advert.
  const hiring = section(e2e, 'Hiring Advocate');
  assert.ok(hiring.startsWith('\nAdvocate has been advertised since 2026-10-19, and its first first-party run settled on 2026-10-20 (see [Results](#results)). `ADVERT_REF` below is its current advert, posted on 2026-10-20 at the status flip.'));
  assert.equal(hiring.match(/has no advert|posts one in step 12|is built and has no|<txid>/), null, 'the words of before the advert');
  // The paragraph under the table names the evidence file, how to repeat the check, and the numbers of the run, which are those of the file, of the Terms of the page and of the wallets.
  const results = section(e2e, 'Results');
  assert.ok(results.includes(`[${AD_RUN.evidence}](${AD_RUN.evidence.replace(/^docs\//, '')})`), 'a link from docs/E2E.md to the evidence file');
  const paragraph = results.split('\n').find((l) => l.startsWith('The evidence of the Advocate run is ')) ?? '';
  const terms = section(read('advocate'), 'Terms');
  const unit = (label) => Number(terms.split('\n').find((l) => l.startsWith(`| ${label} | `))?.split(' | ')[1]) / 1_000_000;
  const received = (unit('Price') + unit('Supplier bond')).toFixed(6);
  assert.equal(received, '4.000000', 'the price and the supplier bond go to the supplier on Accept');
  for (const part of [
    'the object the script printed, unchanged', 'the untouched `result`',
    `The request was the example of [specs/advocate.md](../specs/advocate.md), the subject "${AD_RUN.request.subject}", the side \`${AD_RUN.request.side}\`, the length \`${AD_RUN.request.length}\` and the language \`${AD_RUN.request.language}\``,
    'the run was made against the first advert, which was retired at the status flip the same day',
    `The brief holds ${result.arguments.length} arguments and ${result.sources.length} sources.`,
    `\`model\` reads \`${result.model}\`, \`inference.path\` is \`${result.inference.path}\`, \`fallback_from\` is \`null\` and \`accepted\` is \`${result.inference.accepted}\`.`,
    `The sub-job, of capability \`${sub.capability_id}\`, hired the advert \`${sub.advert_ref}\` (model \`${sub.receipt.model}\`, price 0.2) under the escrow \`${sub.escrow_ref}\`, from the supplier key hash \`${sub.supplier_pkh}\`;`,
    `its receipt passed the seven checks and counts ${sub.receipt.prompt_tokens} prompt tokens and ${sub.receipt.completion_tokens} completion tokens, with a wall clock of ${sub.receipt.wallclock_ms} ms.`,
    `The supplier's wall clock was ${ev.receipt.wallclock_ms} ms, and the line of the service on the host said \`${AD_RUN.jobLine}\`; \`stranded.json\` read \`[]\` after the job.`,
    `the supplier received the price, ${unit('Price')}, and the supplier bond, ${unit('Supplier bond')} (${received} in all), and the buyer bond came back to the buyer.`,
    'Both keys were ours, and so were both sides of the sub-job. It is not demand.',
  ]) assert.ok(paragraph.includes(part), `the paragraph on the run of Advocate says ${part}`);
  // The wallets, read with the check of step 6 before and after the run: the supplier wallet received the price and the supplier bond, less about 1 in fees for its Claim and its Submit; the
  // buyer wallet of the service held the two outputs of step 6, 5 alone and 30, and gave the sub-job its price of 0.2, the supplier bond of 1 and about 1 in fees for its Post and its Accept.
  const wallets = /The supplier wallet held (\d+\.\d{6}) before the run and (\d+\.\d{6}) after: the (\d+\.\d{6}), less the fees of its Claim and its Submit\. The buyer wallet of the service held (\d+\.\d{6}) before, the two outputs of step 6, and (\d+\.\d{6}) after, with its 5-unit output untouched: (\d+\.\d{6}) for the sub-job, its price, the supplier bond and the fees of the Post and the Accept\./.exec(paragraph);
  assert.ok(wallets, 'the paragraph gives the two wallets before and after the run');
  const [supplierBefore, supplierAfter, supplierReceived, buyerBefore, buyerAfter, subJob] = wallets.slice(1).map((n) => Math.round(Number(n) * 1_000_000));
  assert.deepEqual([supplierBefore, supplierAfter, supplierReceived, buyerBefore, buyerAfter, subJob], [30_239_294, 33_236_038, 4_000_000, 35_000_000, 32_796_670, 2_203_330]);
  assert.equal(supplierReceived, Math.round(Number(received) * 1_000_000), 'the supplier received the price and the supplier bond');
  assert.equal(buyerBefore, (5 + 30) * 1_000_000, 'the two outputs of step 6: 5 alone and 30');
  assert.equal(buyerBefore - buyerAfter, subJob, 'what the buyer wallet gave is the sub-job');
  const subFees = subJob - 200_000 - unit('Supplier bond') * 1_000_000;
  const supplierFees = supplierReceived - (supplierAfter - supplierBefore);
  for (const fees of [subFees, supplierFees]) assert.ok(fees > 900_000 && fees < 1_100_000, `about 1 in fees for two transactions: ${fees}`);
  assert.ok(existsSync(new URL(`../${AD_RUN.evidence}`, import.meta.url)), 'the evidence file the docs name exists');
  // The spec says it in the Status line and paragraph and in How to hire it, and its Links point at the evidence and at the two transactions.
  const spec = read('advocate');
  assert.ok(section(spec, 'Status').includes(AD_STATUS));
  for (const heading of ['Status', 'How to hire it']) assert.ok(section(spec, heading).includes('One first-party job has settled, on 2026-10-20; it is not demand.'), heading);
  assert.ok(section(spec, 'Links').includes(`- First-party hire on 2026-10-20, verdict VERIFIED, made against the first advert: the post transaction ${explorerLink(AD_RUN.postTx)} and the accept transaction ${explorerLink(AD_RUN.acceptTx)} on the explorer, and the evidence in [${AD_RUN.evidence}](../${AD_RUN.evidence}).`));
  // The guide gives the agent a row of its table: the status line, the current advert and the public URL.
  assert.ok(hire().split('\n').includes(`| Advocate, capability \`research.advocate.onesided.v1\` | ${AD_STATUS} The advert reference is \`${AD.advertRef}\`, listed as Active and free on 2026-10-20. The public URL, \`https://mp-suppliers-advocate.hal8.ai\`, is in service as of 2026-10-19. |`));
  // Nothing that states where the agent stands says that no job settled or that no first-party run is recorded.
  const files = ['specs/advocate.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'agents/advocate/README.md', 'deploy/host/docker-compose.advocate.yml', 'deploy/host/README.md', 'deploy/host/RUNBOOK-advocate.md'];
  for (const file of files) assert.equal(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').match(/no job (has )?(settled|run)|no first-party run of the path is recorded/i), null, file);
});

test('docs/HIRE.md and docs/E2E.md: Advocate has a subsection of section 5 and a section of the E2E runbook, with the request of the spec, its window, the cost of a job and what to read in the answer', () => {
  const guide = hire();
  const sub = section(guide, '5. The chat script').split('\n### The same script for Advocate\n')[1] ?? '';
  assert.ok(section(guide, '5. The chat script').indexOf('\n### The same script for Advocate\n') > section(guide, '5. The chat script').indexOf('\n### The same script for Audio Snippets\n'), 'after the subsection of Audio Snippets');
  assert.ok(sub.includes(`It has had an advert since 2026-10-19, and the current one is \`${AD.advertRef}\`. The six messages are the same, with two changes.`));
  assert.ok(sub.includes('Ask for `research.advocate.onesided.v1` in message 2'));
  const requestJson = '{"subject":"Should a city ban cars from its centre?","side":"for","length":"short","language":"en"}';
  assert.ok(sub.includes('```json\n' + requestJson + '\n```'));
  // The request of the guide is the example of the page, word for word in its fields.
  const example = /Example:\n\n```json\n([\s\S]*?)\n```/.exec(section(read('advocate'), 'Interface'))?.[1] ?? '';
  assert.deepEqual(JSON.parse(example), JSON.parse(requestJson));
  for (const part of [
    '[specs/advocate.md](../specs/advocate.md) gives every field, under Request and Response.',
    '`declared_bias` says which side the brief argues and that it leaves out the other side by design, and `omitted_by_design` names what it leaves out',
    'Every argument cites its sources, each with a `quote`: the service found that quote in the text it fetched from the page the source names, and dropped every quote it did not find, and any claim left with none.',
    'The model is asked to write the brief in the `language` you ask for; a quote stays in the words of its page.',
    '`length` is `short`, a thesis and 3 arguments asked for, or `standard`, a thesis and 5 to 7 asked for, and the check can leave fewer.',
    'Advocate writes the strongest one-sided brief for a position, with citations: it argues one side only, by design, and says so in every brief.',
    'The six messages are the same, with two changes.',
    '`side` is `for`, `against` or a position in your own words.',
    'The service searches the web for the subject itself, reads the pages it finds and asks one model for the brief.',
    'Read two things in the answer before you use it.',
    'A quote shows that the page says it; whether the page is right is yours to judge, and the `url` of each source lets you read the page itself.',
    'which is your Post time plus 8 min plus 180 s. The price is 3 and a job costs about 5 (the cost table in section 3).',
    'The answer also says how the model was asked: `model` names it with its path, and `inference` holds the receipt of the chat supplier the service hired, with the checks the service ran on it, or says that the call went through OpenRouter after a hire that failed. Every chat supplier the service hires today is first-party.',
  ]) assert.ok(sub.includes(part), `the subsection says: ${part}`);
  for (const heading of ['Request', 'Response', 'Check']) assert.ok(read('advocate').includes(`\n### ${heading}\n`), heading);
  // What the guide says of the quotes and of the language is what the page says: a quote that fails is dropped, an argument left with none is dropped, and the model is asked for the language.
  assert.ok(read('advocate').includes('A quote that fails is dropped. An argument left with no quote is dropped, and the thesis stays.'), 'the Check of the page');
  assert.ok(read('advocate').includes('The model is asked to write the brief in it; a quote stays in the words of its page.'), 'the language row of the page');
  assert.ok(section(guide, '3. What the key must hold').split('\n').includes('| 3 (Advocate) | 5 | 4 | 1 | about 1 | about 5 | 10 |'), 'the cost table row the subsection points to');
  const e2e = section(doc('E2E.md'), 'Hiring Advocate');
  for (const part of [
    'export CAPABILITY_ID=research.advocate.onesided.v1', `export PAYLOAD='${requestJson}'`, 'export E2E_POLL_MS=10000', 'export E2E_STATE=./e2e-state-advocate.json', `export ADVERT_REF=${AD.advertRef}`,
    "[deploy/host/RUNBOOK-advocate.md](../deploy/host/RUNBOOK-advocate.md) step 15 is the operator's order of work.",
    'which is 11 minutes after the Post (the 8 min window and 180 s)', 'add the run to the Results table with Advocate in the Agent column. Its `result` is the brief as JSON text',
    'The run holds a second hire: the service hires a chat supplier of the fleet with its own buyer key, so both sides of that sub-job are first-party too.',
    "its `inference` says whether the brief came from the chat supplier, whose sub-receipt it carries, or from OpenRouter. It is first-party and it is not demand.",
    'On the host, the log of the service has the line of the job, which ends `; inference marketplace` when the brief came from that supplier, and `stranded.json` prints `[]` (step 15 of the runbook).',
  ]) assert.ok(e2e.includes(part), part);
  assert.equal((480_000 + 180_000) / 60_000, 11);
  // The three settings the section explains are the script's: the capability of the advert, the request JSON of the page, and the state file of one run.
  for (const part of [
    "- `CAPABILITY_ID` is the capability of the advert of Advocate. Without it the script looks for the advert among the free suppliers of Agent History's capability and stops before it posts anything.",
    '- `PAYLOAD` is the request JSON of the example of [specs/advocate.md](../specs/advocate.md).',
    '- `E2E_STATE=./e2e-state-advocate.json`: a state file belongs to one run, and the script refuses one that belongs to another, so this run does not use the file of an earlier run.',
  ]) assert.ok(e2e.includes(part), part);
  for (const part of ["const DEFAULT_CAPABILITY = 'identity.history.report.v1';", 'const CAPABILITY = env.CAPABILITY_ID ?? DEFAULT_CAPABILITY;', 'is not among the free suppliers for ${CAPABILITY}', 'belongs to another run']) assert.ok(e2eScript().includes(part), part);
  assert.ok(e2eScript().indexOf('is not among the free suppliers for') < e2eScript().indexOf("'vector_build_marketplace_post_escrow'"), 'the advert is looked for before the escrow is posted');
  // What the mutation of the subsection and of the section found unheld: the messages the request goes in, the 100 s of a call, the first-party label and the search of the E2E run.
  assert.ok(sub.includes('and write this request JSON in messages 3 and 4:'));
  assert.ok(sub.includes('ask your assistant to poll again whenever a call is cut near 100 s, as in section 9.'));
  assert.ok(section(guide, '9. When it goes wrong').includes('A tool call times out near 100 s'));
  assert.ok(e2e.includes('A first-party run of it uses these settings in place of the advert and the request of Agent History'));
  assert.ok(e2e.includes('It is first-party and it is not demand.'));
  assert.ok(e2e.includes('The service sends its two search queries to the Brave Search API, fetches the pages they find, and sends '));
  // The shape of a brief is what the prompt asks for (ruling R-E27): the page says "asked for" and that the check can leave fewer, and the guide says the same in the same numbers.
  const lengthRow = section(read('advocate'), 'Terms').split('\n').find((l) => l.startsWith('| Length |')) ?? '';
  assert.ok(lengthRow.includes('a thesis and 3 arguments asked for') && lengthRow.includes('a thesis and 5 to 7 arguments asked for') && lengthRow.includes('the check can leave fewer'), 'the Length row of the page');
  // What goes to the third parties is said in the words of the manifest as built (rulings R-E27 and R-F12): the prompt of its third entry, the chat supplier, and its
  // fourth, OpenRouter only when that hire fails, read from the template, which agents/advocate/test/server.test.ts keeps equal to manifestFromEnv.
  const template = JSON.parse(readFileSync(new URL('../agents/advocate/agent.json.template', import.meta.url), 'utf8'));
  const sent = /^a chat supplier on the Vector marketplace, hired through a bonded escrow, and the model provider behind it [(]the prompt: (.+)[)]$/.exec(template.behaviour.third_parties[2])?.[1] ?? '';
  assert.ok(sent.startsWith('the subject, the side, the audience, the language and the length'), 'the sentence of the manifest, as built');
  assert.equal(template.behaviour.third_parties[3], 'OpenRouter and the model provider behind it (the same prompt), only when that hire fails');
  assert.ok(sub.includes(`It sends two search queries, made from the subject and the side, to the Brave Search API, and it sends the prompt (${sent}) to a chat supplier it hires on the Vector marketplace and the model provider behind it, or, only when that hire fails, to OpenRouter and the model provider behind it: write nothing in a request that should not go there.`), 'the guide says what goes to the third parties');
  assert.ok(e2e.includes(`and sends the prompt (${sent}) to the chat supplier it hires on the Vector marketplace and the model provider behind it, or, only when that hire fails, to OpenRouter and the model provider behind it, so the subject is one that may go to all of them.`), 'the runbook says what goes to the third parties');
  assert.ok(doc('E2E.md').indexOf('\n## Hiring Advocate\n') > doc('E2E.md').indexOf('\n## Hiring Audio Snippets\n') && doc('E2E.md').indexOf('\n## Hiring Advocate\n') < doc('E2E.md').indexOf('\n## What the script does\n'));
  // The state file of the run is ignored by git, as the others are.
  const ignored = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').split('\n');
  assert.ok(ignored.includes('e2e-state*.json*') && /^e2e-state.*\.json.*$/.test('e2e-state-advocate.json'));
});

test('docs/HIRE.md and docs/E2E.md: the window and the reclaim time of the guide are the Terms of the page, a job takes up to its deadline and longer only in the Accept of its hire, inside the service timeout, and the asks counted in the E2E section are the default pause of the script over the 8 min window', () => {
  const terms = section(read('advocate'), 'Terms');
  assert.match(terms, /\| Processing window, advert `max_processing_ms` \| 480000 ms \|/);
  assert.ok(terms.includes('| Job deadline, set by the service when a request arrives | 300000 ms (60 s inside the service timeout) |'));
  assert.ok(terms.includes('| Service timeout, `SERVICE_TIMEOUT_MS` | 360000 ms |'));
  const guide = section(hire(), '5. The chat script').split('\n### The same script for Advocate\n')[1] ?? '';
  assert.ok(guide.includes('A job takes up to 300 s, its deadline, and longer when the hire of its chat supplier is in its Accept then (the runtime gives up at 360 s). Its processing window is 8 min, so message 4 can wait that long'));
  // The deadline does not cut a hire in its Accept, as the gap of the deadline on the page says, and the runtime gives up at its service timeout, the 360 s of the Terms.
  assert.ok(read('advocate').includes('A hire in its Accept at the deadline runs on, as the Pipeline\'s does.'));
  assert.equal(480_000 / 60_000, 8);
  const pause = Number(/POLL_MS = env\.E2E_POLL_MS === undefined \? (\d+) :/.exec(e2eScript())?.[1]);
  assert.equal(pause, 5000);
  assert.equal(8 * 60 * 1000 / pause, 96);
  assert.ok(section(doc('E2E.md'), 'Hiring Advocate').includes("- `E2E_POLL_MS=10000`: a job takes up to 300 s, its deadline, and longer when the hire of its chat supplier is in its Accept then (the runtime gives up at 360 s), where Agent History's takes seconds, and the default pause of 5 s would ask the hosted server about 96 times in the 8 min window."));
  assert.equal(guide.match(/up to 150 s|5 min plus 180 s/), null, 'the words of before the wider window');
});

// ---- The sentences of the review of Plan E2 ----
// The Document Pipeline hires through packages/hire-kit, on packages/buyer-core, since the merge of 2026-10-19, and its service signs no receipt: its buyer key signs only the transactions of its
// sub-jobs. The row of its runbook that says how the 5 alone of that key is held back is held in scripts/deploy.test.mjs. Nothing else of the Pipeline changes with them.
test('specs/document-pipeline.md: the code of its hire is packages/hire-kit on packages/buyer-core since the merge of 2026-10-19, and its service signs no receipt, its buyer key only the transactions of its sub-jobs', () => {
  const text = read('document-pipeline');
  const how = (section(text, 'Interface').split('\n### How it buys\n')[1] ?? '').split('\n### ')[0];
  assert.ok(how.includes('\n**Where the code is.** The sub-hire code is in `packages/hire-kit` in this repository, on `packages/buyer-core`, since the merge of 2026-10-19. It uses the same datum codecs, builders and receipt verifier as the MCP server: they are vendored from it,'));
  assert.ok(section(text, 'What the receipt commits to').startsWith('\nThe service signs no receipt: its buyer key signs only the transactions of its sub-jobs. The runtime builds and signs the receipt, and submits its hash in the Submit transaction.\n'));
  assert.equal(text.match(/The sub-hire code is in `packages\/buyer-core`|The service signs nothing\./), null, 'the sentences of before the merge of 2026-10-19');
  // The code: the service hires through the kit, which stands on buyer-core, and the kit holds the hire and its janitor.
  const pkg = (dir) => JSON.parse(readFileSync(new URL(`../${dir}/package.json`, import.meta.url), 'utf8'));
  assert.ok(pkg('agents/document-pipeline').dependencies['@vsa/hire-kit'] && pkg('packages/hire-kit').dependencies['@vsa/buyer-core'], 'the Pipeline depends on the kit, and the kit on buyer-core');
  assert.ok(readFileSync(new URL('../agents/document-pipeline/src/hire.ts', import.meta.url), 'utf8').includes("import { hireOne } from '@vsa/hire-kit';"), 'the hire of a sub-job is the kit\'s');
  for (const file of ['hire.ts', 'janitor.ts']) assert.ok(existsSync(new URL(`../packages/hire-kit/src/${file}`, import.meta.url)), file);
});

// ---- The launch guide (docs/LAUNCH.md, 2026-10-21) ----
// A member who has read HIRE.md launches a supplier of their own from vector-agent-template, gives it an identity from the chat client and hires it once. The guide is held to
// what it was written from: the tools it names are on the hosted server or in the signer, its links resolve, the advert and stake builders are planned and never available,
// the key conversion it prints is the one the signer reads, and its words follow the public rules.
const launch = () => doc('LAUNCH.md');
const LAUNCH_SECTIONS = ['What you need', 'Let your coding agent build it', 'Post the advert', 'Boot the runtime and your service', 'Give your agent an identity from chat', 'Stake (optional)', 'Test-hire your own agent from chat', 'Tell the working group'];
// The 33 tools of the hosted server: the tools packages/builder of Apex-Fusion/mcp-server registers at main 651ae93, the commit the hosted mainnet server and the npm signer
// 2.0.0 were built from (HIRE.md section 2). The nine marketplace tools and the registry tools are among them; no advert and no stake builder is.
const HOSTED_TOOLS = [
  'vector_await_transaction', 'vector_build_deploy_contract', 'vector_build_deregister_agent', 'vector_build_interact_contract', 'vector_build_marketplace_accept',
  'vector_build_marketplace_post_escrow', 'vector_build_marketplace_reclaim', 'vector_build_message_agent', 'vector_build_register_agent', 'vector_build_self_improvement_critique',
  'vector_build_self_improvement_endorse', 'vector_build_self_improvement_proposal_lock', 'vector_build_self_improvement_proposal_spend', 'vector_build_send_apex', 'vector_build_send_tokens',
  'vector_build_transaction', 'vector_build_transfer_agent', 'vector_build_update_agent', 'vector_discover_agents', 'vector_dry_run', 'vector_get_agent_profile', 'vector_get_balance',
  'vector_get_transaction_history', 'vector_get_utxos', 'vector_marketplace_get_job', 'vector_marketplace_get_supplier', 'vector_marketplace_list_capabilities', 'vector_marketplace_list_suppliers',
  'vector_marketplace_send_job', 'vector_marketplace_verify_receipt', 'vector_self_improvement_analyze_metrics', 'vector_self_improvement_browse', 'vector_submit_transaction',
];
// The four tools of the signer (packages/signer/src/tools.ts at the same commit).
const SIGNER_TOOLS = ['vector_signer_get_address', 'vector_signer_decode_transaction', 'vector_signer_sign', 'vector_signer_get_spend_limits'];
// The sentence that says where the advert and stake builders stand on 2026-10-21: planned, not on the hosted server.
// Since 2026-10-21 a draft pull request holds them, Apex-Fusion/mcp-server#25: post and retire an advert, and the stake in two steps, with no unstake. A draft, not merged,
// not on the hosted server, so the guide still calls them planned.
const BUILDERS_PLANNED = 'Advert and stake builders for the hosted server are planned: a draft pull request, [Apex-Fusion/mcp-server#25](https://github.com/Apex-Fusion/mcp-server/pull/25), adds builders to post and retire an advert and to make the stake in two steps, with no unstake, because the minimum cannot be withdrawn. They are not on the hosted server, and this guide does not use them.';
// The words a public line of the launch guide does not use (its content rules). Each is spelled in two parts, as UNIT_NAME is, so that a search for the words finds none
// in this file. "payload" is a word of its own and passes.
const MONEY_WORDS = new RegExp('\\b(' + [['p', 'ays?'], ['p', 'aid'], ['p', 'ayments?'], ['p', 'ayers?'], ['e', 'arn\\w*'], ['mon', 'ey'], ['f', 'und(s|ed|ing)?'], ['sp', 'end\\w*'], ['sp', 'ent'], ['reve', 'nue'], ['gover', 'nance']].map((p) => p.join('')).join('|') + ')\\b', 'i');
// The roles-not-people guard of scripts/deploy.test.mjs, read from that file so that the names stand in one place, and the host of the Foundation's own deployment,
// which a guide for a member's own host never names.
const PERSON_NAMES = new RegExp(/^const NAMES = \/(.+)\/i;$/m.exec(readFileSync(new URL('./deploy.test.mjs', import.meta.url), 'utf8'))?.[1] ?? 'the names guard was not found', 'i');
const FOUNDATION_HOST = /hal8|PROXY_NETWORK|Caddy|\/opt\/|\b\d{1,3}(\.\d{1,3}){3}\b/i;
// The block of section 5 that converts the template's 64-hex key into the form the signer reads. It was run verbatim, offline, with a throwaway key on 2026-10-21; a test
// below runs its node code again and compares the result with what CML, which the signer parses keys with, makes of the same 32 bytes.
const CONVERSION_BLOCK = [
  'read -rs SUPPLIER_PRIV_KEY_HEX && export SUPPLIER_PRIV_KEY_HEX',
  `(cd try-it && node -e "const {bech32}=require('bech32');const h=process.env.SUPPLIER_PRIV_KEY_HEX;/^[0-9a-f]{64}$/.test(h)||(console.error('expected 64 lowercase hex characters'),process.exit(1));process.stdout.write('VECTOR_SIGNER_PRIVATE_KEY='+bech32.encode('ed25519_sk',bech32.toWords(Buffer.from(h,'hex')),1023)+'\\n')")`,
  'unset SUPPLIER_PRIV_KEY_HEX',
].join('\n');
// A heading as a GitHub anchor: lower case, punctuation dropped, spaces as hyphens.
const slug = (heading) => heading.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
// The Ed25519 public key of a 32-byte seed given as 64 hex, by node:crypto alone: the seed in a PKCS8 envelope, the raw key the last 32 bytes of the SPKI.
const publicKeyOfSeed = (hex) => createPublicKey(createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32);
// The fix round of 2026-10-21 (review v1, findings 1 to 10, the stake correction, the builders' draft, the copy of HIRE.md section 8). The sentences below are pinned.
// Every command that reads .env or handles the supplier key is the member's, in the member's own terminal (findings 1 and 2).
const OWN_TERMINAL = "Every command that reads `.env` or handles the supplier key runs in your own terminal, never through your assistant's shell tool: `gen-keypair` above, `post-advert` (section 3), `retire-advert`, `docker compose up -d` and `--force-recreate` (section 4), the conversions of sections 5 and 6, and the SDK run of section 6. Your assistant may write these commands, but it does not run them. Never let it run `cat .env`, `docker compose config` (it prints the values of `.env`), `docker inspect` on the agent container, or `env` or `printenv` in that container: each puts the key into the conversation. If your client can deny your assistant read access to a file, deny it `.env`: in Claude Code, a `permissions.deny` entry for `Read(./.env)` in the project's `.claude/settings.json`.";
const RUN_IT_YOURSELF = 'Run it in your own terminal. Your assistant may write the command, but it does not run it.';
const SKEY_RULE = "Make the file and run the SDK in your own terminal, never through your assistant's shell tool.";
// The block of section 6 that writes the cardano-cli .skey the SDK's load_wallet reads. Run verbatim offline on 2026-10-21 with a throwaway key: pycardano 0.19.2,
// with the three lines of load_wallet, read it back as the template's public key, key hash and address. A test below runs its node code again.
const SKEY_BLOCK = [
  'read -rs SUPPLIER_PRIV_KEY_HEX && export SUPPLIER_PRIV_KEY_HEX',
  `node -e "const h=process.env.SUPPLIER_PRIV_KEY_HEX;/^[0-9a-f]{64}$/.test(h)||(console.error('expected 64 lowercase hex characters'),process.exit(1));require('fs').writeFileSync(process.argv[1],JSON.stringify({type:'PaymentSigningKeyShelley_ed25519',description:'',cborHex:'5820'+h})+'\\n',{mode:0o600,flag:'wx'})" "$HOME/supplier.skey"`,
  'unset SUPPLIER_PRIV_KEY_HEX',
].join('\n');
const SKEY_REMOVE = 'The file is one more plaintext copy of the supplier key: remove it once the stake has confirmed, with `rm "$HOME/supplier.skey"` in your own terminal';
// The Module-3 stake is not refundable (the SDK's spec, section 6.2, and stake_validation.ak: a decrease must leave at least the minimum self-stake in a continuing output).
// The public wording, everywhere the stake's return is spoken of; no timing parameter of the module is named.
const STAKE_LOCKED = 'The stake stays locked: the module keeps 10 units as the minimum, and only stake above it can be decreased.';
const HIRE_PERMANENT = "The name and the description you enter are public and permanent: the transaction that writes them stays in the ledger's history after you deregister. Deregistering returns the deposit; it does not erase that transaction. Put no personal data in them.";
// HIRE.md section 8 pins the template at c4c378a, whose install leaves libsodium-sumo.mjs out of the wrapper's folder (the lockfile there pins libsodium 0.7.16).
const LIBSODIUM_COPY = 'cp node_modules/.pnpm/libsodium-sumo@0.7.16/node_modules/libsodium-sumo/dist/modules-sumo-esm/libsodium-sumo.mjs node_modules/.pnpm/libsodium-wrappers-sumo@0.7.16/node_modules/libsodium-wrappers-sumo/dist/modules-sumo-esm/';
const LIBSODIUM_WHY = "That copy is the one the template's `agent/Dockerfile` makes in its image. pnpm's store layout puts `libsodium-sumo.mjs` in a sibling package, and without it the buyer stops at the transaction build with `Cannot find module`.";

test('docs/LAUNCH.md: the title, the eight sections in the order a member does them, a check in every section after the first, and the README lists it next to HIRE.md', () => {
  const text = launch();
  assert.ok(text.startsWith('# Launch your own agent from a chat client\n'), 'the title');
  assert.ok(text.split('\n')[2].startsWith('A guide for a developer who has read [HIRE.md](HIRE.md).'), 'the first paragraph names its reader');
  assert.deepEqual([...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => [Number(m[1]), m[2]]), LAUNCH_SECTIONS.map((title, i) => [i + 1, title]));
  LAUNCH_SECTIONS.forEach((title, i) => {
    if (i > 0) assert.match(section(text, `${i + 1}. ${title}`), /Check[:,]|What you check/, `section ${i + 1} has a check`);
  });
  const lines = readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n');
  assert.equal(lines[lines.indexOf('- Hire one: `docs/HIRE.md`') + 1], '- Launch your own agent from a chat client: `docs/LAUNCH.md`', 'the README lists the guide right after HIRE.md');
});

test('docs/LAUNCH.md: every tool it names is one of the 33 tools of the hosted server or one of the four of the signer, as HIRE.md names them; no advert or stake tool is named', () => {
  assert.equal(HOSTED_TOOLS.length, 33);
  assert.equal(new Set(HOSTED_TOOLS).size, 33);
  const known = new Set([...HOSTED_TOOLS, ...SIGNER_TOOLS]);
  // The names HIRE.md and the E2E runbook are held to are among them: the nine marketplace tools of the design and the others of this file.
  for (const tool of [...MARKETPLACE_TOOLS, ...OTHER_TOOLS]) assert.ok(known.has(tool), `${tool} is on the hosted server or in the signer`);
  for (const [name, text] of [['docs/HIRE.md', hire()], ['docs/LAUNCH.md', launch()]]) {
    const unknown = [...new Set(text.match(/\bvector_[a-z_]+/g) ?? [])].filter((t) => !known.has(t));
    assert.deepEqual(unknown, [], `${name} names a tool that is not on the hosted server or in the signer`);
  }
  const named = new Set(launch().match(/\bvector_[a-z_]+/g));
  for (const tool of ['vector_build_register_agent', 'vector_get_agent_profile', 'vector_signer_sign', 'vector_submit_transaction', 'vector_await_transaction', 'vector_build_deregister_agent', 'vector_marketplace_list_suppliers', 'vector_marketplace_verify_receipt', 'vector_get_utxos']) assert.ok(named.has(tool), `the guide names ${tool}`);
  assert.deepEqual([...named].filter((t) => /advert|stake/.test(t)), [], 'no advert or stake tool exists on the hosted server');
  assert.ok(launch().includes('Every tool it names is on the hosted mainnet server, which lists 33 tools, or in the signer, version 2.0.0.'));
});

test('docs/LAUNCH.md: the advert and stake builders of the hosted server are planned, and the guide never says that they are available', () => {
  const text = launch();
  const six = section(text, '6. Stake (optional)');
  assert.ok(six.includes('A stake is not available as a chat tool today: the hosted server has no stake builder and no advert builder.'));
  assert.equal(text.split(BUILDERS_PLANNED).length - 1, 1, 'the planned sentence, once');
  assert.ok(six.includes(BUILDERS_PLANNED), 'in section 6');
  assert.ok(six.includes("the template's command line posts the advert (section 3), and the public Module-3 SDK makes the stake"));
  assert.equal(text.match(/builders? (is|are) (now )?(available|merged|shipped|deployed|on the hosted server)|stake (tool|builder) is available|(advert|stake) from chat with `vector_/i), null, 'nothing says the builders are there');
});

test('docs/LAUNCH.md: every relative link resolves to a file of the repository, and every anchor to a heading of that file', () => {
  const links = [...launch().matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((target) => !/^https?:/.test(target));
  assert.ok(links.length >= 10, `the guide links the repository, found ${links.length}`);
  for (const target of links) {
    const [path, anchor] = target.split('#');
    const file = new URL(`../docs/${path}`, import.meta.url);
    assert.ok(path !== '' && existsSync(file), `${target} resolves to a file`);
    if (anchor === undefined) continue;
    const headings = readFileSync(file, 'utf8').split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => slug(l.replace(/^#+ /, '')));
    assert.ok(headings.includes(anchor), `${target}: the anchor is a heading of ${path}`);
  }
  // The external links go to the public repositories the guide is about, on their default branches.
  // Two pull requests are linked as what they are, open proposals: the builders' draft (mcp-server#25) and the template's install step (vector-agent-template#3).
  for (const url of launch().match(/https:\/\/github\.com\/[^\s)]+/g)) assert.match(url, /^https:\/\/github\.com\/Apex-Fusion\/(vector-agent-template(#|\/blob\/main\/)|vector-agent-template\/pull\/3$|vector-agent-modules\/tree\/master\/Module-3$|vector-service-agents\/issues$|mcp-server\/pull\/25$)/, url);
});

test('docs/LAUNCH.md: the costs are the ones of the runbooks, the template docs and the register tool, each with its source', () => {
  const one = section(launch(), '1. What you need');
  const row = (start) => one.split('\n').find((l) => l.startsWith(start)) ?? '';
  assert.match(row('| 3. The advert |'), /^\| 3\. The advert \| about 2 \| when you retire the advert, .* \| 1 \| .*RUNBOOK\.md#12-post-the-advert/);
  assert.match(row('| 5. The registry deposit |'), /^\| 5\. The registry deposit \| 10 \| when you deregister, with `vector_build_deregister_agent` \| 1 \| `vector_build_register_agent`; \[HIRE\.md\]\(HIRE\.md\) section 7; .*TRUST-LAYER\.md/);
  // The stake is not refundable (Module-3 spec section 6.2, stake_validation.ak): the row says so in the public wording, and no cooldown is named.
  assert.equal(row('| 6. The stake, optional |'), '| 6. The stake, optional | 10, the minimum | never: the stake stays locked. The module keeps 10 units as the minimum, and only stake above it can be decreased | 2: a seed output, then the stake | the Module-3 SDK: its spec, section 6.2, and `stake_validation.ak` |');
  assert.match(row('| 7. The test hire, from your hiring key |'), /the price and both bonds, raised to the ledger's minimum for the escrow output \(about 2\.2 to 2\.3\) when that sum is lower \| on Accept your bond returns to your hiring key, and your supplier key receives the price and the supplier bond \| 2: the Post and the Accept \| \[HIRE\.md\]\(HIRE\.md\) section 3 \|$/);
  assert.ok(one.includes('Fees are about 0.5 a transaction, the fee floor'));
  // The numbers are the runbook's: the deposit, the stake, the advert lock, the fee, the setup and the float of 50.
  const runbook = readFileSync(new URL('../deploy/host/RUNBOOK.md', import.meta.url), 'utf8');
  assert.ok(runbook.includes('The registry deposit (10 units), the stake (10), the advert (about 2 locked) and fees of about 0.5 a transaction. The setup uses about 25 with fees.'));
  assert.ok(one.includes('Our runbooks send 5 and then 50 to each supplier key: the setup uses about 25 with fees'));
  // The registry deposit is the one HIRE.md section 7 gives for the same tool.
  assert.ok(section(hire(), '7. Register your own identifier (optional)').includes('It locks a deposit of 10 units, which you get back when you deregister.'));
});

test("docs/LAUNCH.md: the key is made and converted in the member's own terminal, the conversion block is the one that was proven, and it is the inverse of HIRE.md section 8", () => {
  const text = launch();
  const two = section(text, '2. Let your coding agent build it');
  const rule = "Run it in your own terminal, never through your assistant's shell tool: the output of a shell tool goes back into the conversation, so the key would reach your model provider.";
  assert.ok(two.includes(rule));
  assert.ok(two.indexOf(rule) < two.indexOf('src/cli/gen-keypair.ts --network 1'), 'the rule comes before the command');
  assert.ok(two.includes('From here your assistant must not open or print `.env`.'));
  const five = section(text, '5. Give your agent an identity from chat');
  assert.ok(five.includes('```bash\n' + CONVERSION_BLOCK + '\n```'), 'the block of section 5, verbatim');
  assert.ok(five.indexOf('Convert the key in your own terminal') < five.indexOf('read -rs'), "it is run in the member's own terminal");
  assert.ok(five.includes('it refuses a raw hex key'));
  // Nothing in the block that an interactive shell would change: no history expansion, no variable or command substitution inside the double quotes, no escaped quote.
  const code = /node -e "(.*)"\)$/m.exec(CONVERSION_BLOCK)?.[1] ?? '';
  assert.ok(code.length > 100, 'the node code was found');
  assert.equal(CONVERSION_BLOCK.includes('!'), false);
  assert.equal(/\$[A-Za-z_{(]|`|\\"/.test(code), false);
  // HIRE.md section 8 turns a signer key back into 64 hex with the same library and the same length limit.
  assert.ok(section(hire(), '8. The terminal path').includes("const d=bech32.decode(process.env.VECTOR_SIGNER_PRIVATE_KEY,1023);process.stdout.write(Buffer.from(bech32.fromWords(d.words)).toString('hex'))"));
});

test("docs/LAUNCH.md: the node code of the conversion turns a throwaway 64-hex key into the bech32 key CML makes of the same 32 bytes, and the signer's reading of it has the public key node:crypto derives from the seed and the key hash and address the template derives", () => {
  // The bech32 library the template's try-it folder requires (bech32 ^2.0.0) is in this repository's store as a dependency of its dependencies; the code runs as the member runs it.
  const store = fileURLToPath(new URL('../node_modules/.pnpm/', import.meta.url));
  const dir = readdirSync(store).find((name) => /^bech32@2\./.test(name));
  assert.ok(dir, 'bech32 2.x is in the store (the template requires ^2.0.0)');
  const nodePath = join(store, dir, 'node_modules');
  // Inside the double quotes the shell passes the code on unchanged (the test above checks that it holds nothing a shell would expand), so it is run as written.
  const code = /node -e "(.*)"\)$/m.exec(CONVERSION_BLOCK)[1];
  const fromRepo = createRequire(new URL('../packages/buyer-core/package.json', import.meta.url));
  const CML = fromRepo('@anastasia-labs/cardano-multiplatform-lib-nodejs');
  const { blake2b } = fromRepo('@noble/hashes/blake2b');
  const { bech32 } = createRequire(join(nodePath, 'bech32', 'package.json'))('bech32');
  const run = (hex) => execFileSync(process.execPath, ['-e', code], { env: { ...process.env, NODE_PATH: nodePath, SUPPLIER_PRIV_KEY_HEX: hex }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 3; i++) {
    const hex = randomBytes(32).toString('hex'); // a throwaway key, made here and never printed
    const out = run(hex);
    const m = /^VECTOR_SIGNER_PRIVATE_KEY=(ed25519_sk1[0-9a-z]+)\n$/.exec(out);
    assert.ok(m, 'one line in the form keygen prints');
    assert.match(m[1], /^ed25519e?_sk1[0-9a-z]+$/, 'the form packages/signer/src/keysource.ts accepts');
    assert.equal(m[1], CML.PrivateKey.from_normal_bytes(Buffer.from(hex, 'hex')).to_bech32(), 'the bech32 CML makes of the same 32 bytes');
    // The expected values come from outside CML. The public key: node:crypto's Ed25519 from the 32-byte seed (RFC 8032, as @noble/ed25519 in the template's
    // gen-keypair). The key hash: blake2b-224 of that public key, with the @noble/hashes the template uses. The address: an enterprise address with header 0x61,
    // bech32 under "addr" (agent/src/cli/gen-keypair.ts). The signer's reading of the printed key (CML, as sign.ts parses it) must give all three.
    const expectedPub = publicKeyOfSeed(hex);
    const pkh = Buffer.from(blake2b(expectedPub, { dkLen: 28 })).toString('hex');
    const address = bech32.encode('addr', bech32.toWords(Buffer.concat([Buffer.from([0x61]), Buffer.from(pkh, 'hex')])), 1023);
    const pub = CML.PrivateKey.from_bech32(m[1]).to_public();
    assert.equal(Buffer.from(pub.to_raw_bytes()).toString('hex'), expectedPub.toString('hex'), "the signer's public key is the one node:crypto derives from the template's seed");
    assert.equal(pub.hash().to_hex(), pkh, "the key hash the signer signs with is the template's SUPPLIER_PKH");
    assert.equal(CML.EnterpriseAddress.new(1, CML.Credential.new_pub_key(pub.hash())).to_address().to_bech32(), address, "the address is the template's SUPPLIER_ADDRESS");
  }
  // A key that is not 64 lowercase hex prints nothing on stdout and stops with the message.
  assert.throws(() => run('not a key'), (err) => err.status === 1 && err.stdout === '' && /expected 64 lowercase hex characters/.test(err.stderr));
});

test('docs/LAUNCH.md, the new sentence of HIRE.md section 3(b) and the new README line: hyphens only, none of the words of the content rules, no unit name, no person, no host of the Foundation, no status word', () => {
  const readmeLine = '- Launch your own agent from a chat client: `docs/LAUNCH.md`';
  assert.ok(PERSON_NAMES.source.startsWith('\\b(') && PERSON_NAMES.source.split('|').length >= 10, 'the names guard was read from scripts/deploy.test.mjs');
  const added = [['docs/LAUNCH.md', launch()], ['HIRE.md section 3(b)', SIGNER_READS], ['README.md', readmeLine], ['HIRE.md section 7', HIRE_PERMANENT], ['HIRE.md section 8', `${LIBSODIUM_COPY}\n${LIBSODIUM_WHY}`], ['the runbooks and the host README', STAKE_LOCKED]];
  for (const [name, text] of added) {
    assert.equal(text.match(DASHES), null, `${name}: hyphens only`);
    assert.equal(text.match(MONEY_WORDS), null, `${name}: none of the words of the content rules`);
    assert.equal(text.match(UNIT_NAME), null, `${name}: units, not the name`);
    assert.equal(text.match(PERSON_NAMES), null, `${name}: roles, not people`);
    assert.equal(text.match(FOUNDATION_HOST), null, `${name}: no host, address, network or proxy path of the Foundation's host`);
    assert.equal(text.match(/\b(LIVE|DEPLOYED|PROPOSED)\b/), null, `${name}: no status word`);
  }
  // The guards find what they exist for, and pass the words the guides use.
  const hits = [['we p', 'ay'], ['p', 'aid out'], ['p', 'ayment'], ['the p', 'ayer'], ['e', 'arn'], ['e', 'arned'], ['mon', 'ey'], ['f', 'und it'], ['f', 'unded'], ['f', 'unding'], ['sp', 'end'], ['sp', 'ending'], ['sp', 'ent'], ['reve', 'nue'], ['gover', 'nance']].map((p) => p.join(''));
  for (const hit of hits) assert.match(hit, MONEY_WORDS, hit);
  for (const miss of ['payload', 'the wire payload', 'learn', 'refund', 'Foundation', 'the price', 'consumed']) assert.doesNotMatch(miss, MONEY_WORDS, miss);
  for (const hit of ['mp-suppliers-history.hal8.ai', 'PROXY_NETWORK', 'Caddyfile', '/opt/agent-history', '10.0.0.5']) assert.match(hit, FOUNDATION_HOST, hit);
  assert.doesNotMatch('https://ogmios.vector.mainnet.apexfusion.org', FOUNDATION_HOST);
  // The first-party label stays on the hire of one's own agent, and the guide says what is not yet recorded.
  assert.ok(section(launch(), '7. Test-hire your own agent from chat').includes('A hire of your own agent is first-party. It shows that the path works. It is not demand.'));
  assert.ok(launch().includes('No launch by anyone outside the team is recorded yet. The npm signer has not yet signed a registration on mainnet: our four agents were registered through the same hosted tool with another local signer. No third-party audit of the marketplace contracts exists.'));
});

// ---- The fix round of 2026-10-21 (launch-docs review v1) ----

test('docs/LAUNCH.md (findings 1 and 2): every command that reads .env or handles the supplier key is run in the member\'s own terminal, the assistant is told what never to run, and nothing lets it run them', () => {
  const text = launch();
  const two = section(text, '2. Let your coding agent build it');
  assert.ok(two.includes('\n' + OWN_TERMINAL + '\n'), 'section 2 has the paragraph, alone');
  for (const command of ['`cat .env`', '`docker compose config`', '`docker inspect`', '`env`', '`printenv`', '`Read(./.env)`']) assert.ok(OWN_TERMINAL.includes(command), `the paragraph names ${command}`);
  assert.ok(section(text, '3. Post the advert').includes(RUN_IT_YOURSELF), 'section 3: the advert is posted in the member\'s own terminal');
  const four = section(text, '4. Boot the runtime and your service');
  assert.ok(four.includes('`docker compose -f deploy/docker-compose.yml up -d`, run in your own terminal, starts the runtime and the demo service.'));
  assert.ok(four.includes('recreate the container in your own terminal with `docker compose -f deploy/docker-compose.yml up -d --force-recreate`'));
  assert.ok(section(text, '1. What you need').includes("with the template's `retire-advert` command, run in your own terminal"));
  const six = section(text, '6. Stake (optional)');
  assert.ok(six.includes(SKEY_RULE), 'section 6: the .skey file and the SDK run are the member\'s');
  assert.ok(six.includes('```bash\n' + SKEY_BLOCK + '\n```'), 'section 6: the block that writes the .skey, verbatim');
  assert.ok(six.indexOf(SKEY_RULE) < six.indexOf('read -rs'), 'the rule comes before the block');
  assert.ok(six.includes(SKEY_REMOVE), 'section 6: the file is removed once the stake has confirmed');
  // The words of before, which let the assistant run commands that read the key.
  for (const before of ['You or your assistant can run it', 'It may load it into the environment of a command', 'by your assistant with `.env` loaded']) assert.equal(text.includes(before), false, `not: ${before}`);
  assert.equal((SKEY_BLOCK.match(/!/g) ?? []).length, 0, 'no history expansion in the block');
  assert.equal(/\$(?!HOME\/supplier\.skey")[A-Za-z_{(]|`|\\"/.test(SKEY_BLOCK.split('\n')[1].replace(/^node -e "/, '').replace(/" "\$HOME\/supplier\.skey"$/, '')), false, 'nothing a shell would expand inside the quoted code');
});

test('docs/LAUNCH.md (finding 2): the node code of the .skey block writes the cardano-cli envelope of the key, with mode 600 where the system has modes, refuses to overwrite and refuses a key that is not 64 lowercase hex', () => {
  const code = /^node -e "(.*)" "\$HOME\/supplier\.skey"$/m.exec(SKEY_BLOCK)[1];
  const dir = mkdtempSync(join(tmpdir(), 'launch-skey-'));
  try {
    const file = join(dir, 'supplier.skey');
    const run = (hex) => execFileSync(process.execPath, ['-e', code, file], { env: { ...process.env, SUPPLIER_PRIV_KEY_HEX: hex }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const hex = randomBytes(32).toString('hex'); // a throwaway key, made here and never printed
    assert.equal(run(hex), '', 'it prints nothing');
    const skey = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(skey), ['type', 'description', 'cborHex']);
    assert.equal(skey.type, 'PaymentSigningKeyShelley_ed25519', 'the type of a cardano-cli signing key file, the one pycardano\'s PaymentSigningKey.load checks');
    assert.equal(skey.cborHex, '5820' + hex, 'a CBOR byte string of 32 bytes: the key');
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600, 'mode 600');
    // The key in the file is the template's: CML reads the same 32 bytes as the public key node:crypto derives from the seed.
    const fromRepo = createRequire(new URL('../packages/buyer-core/package.json', import.meta.url));
    const CML = fromRepo('@anastasia-labs/cardano-multiplatform-lib-nodejs');
    const pub = CML.PrivateKey.from_normal_bytes(Buffer.from(skey.cborHex.slice(4), 'hex')).to_public();
    assert.equal(Buffer.from(pub.to_raw_bytes()).toString('hex'), publicKeyOfSeed(hex).toString('hex'));
    assert.throws(() => run(randomBytes(32).toString('hex')), (err) => err.status === 1 && /EEXIST/.test(err.stderr), 'a second run refuses to overwrite the file');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).cborHex, '5820' + hex, 'and the file is unchanged');
    rmSync(file);
    assert.throws(() => run('not a key'), (err) => err.status === 1 && /expected 64 lowercase hex characters/.test(err.stderr));
    assert.equal(existsSync(file), false, 'a bad key writes no file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the stake correction: the Module-3 stake is not refundable; LAUNCH.md, the four runbooks and the host README say so in the public wording, and none says the stake returns or names a cooldown', () => {
  const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
  const six = section(launch(), '6. Stake (optional)');
  assert.ok(six.includes('Lock only what you mean to leave there. ' + STAKE_LOCKED), 'section 6');
  const runbooks = ['deploy/host/RUNBOOK.md', 'deploy/host/RUNBOOK-document-pipeline.md', 'deploy/host/RUNBOOK-audio-snippets.md', 'deploy/host/RUNBOOK-advocate.md'];
  for (const rel of runbooks) {
    const text = read(rel);
    const eight = section(text, '8. Stake in Module-3');
    assert.ok(['This', 'this'].some((word) => eight.includes(`${word} locks 10 units on the capability. ${STAKE_LOCKED}`)), `${rel}: step 8`);
    assert.ok(section(text, 'Back out').includes('The registry identity stays on the ledger until the operator deregisters it, and the deposit returns then. ' + STAKE_LOCKED), `${rel}: Back out`);
  }
  assert.ok(read('deploy/host/README.md').includes('The registry identity stays on the ledger until the operator deregisters it, and the deposit returns then. ' + STAKE_LOCKED), 'deploy/host/README.md');
  // The words of before: a refund after a cooldown, a stake the operator withdraws. No timing parameter of the module is named on these pages.
  for (const rel of ['docs/LAUNCH.md', 'docs/HIRE.md', 'docs/E2E.md', 'README.md', 'deploy/host/README.md', ...runbooks, ...Object.keys(AGENTS).map((n) => `specs/${n}.md`)]) {
    assert.equal(read(rel).match(/cooldown|refundable under the stake|the stake after its|stake stay on the ledger until the operator withdraws|when you withdraw it/i), null, rel);
  }
});

test('docs/HIRE.md (findings 3 and 9, and the copy of section 8): the record is permanent in the chain\'s history, a recovery phrase exposes the whole wallet, and the terminal path copies the file its install leaves out', () => {
  const guide = hire();
  assert.ok(section(guide, '7. Register your own identifier (optional)').includes(HIRE_PERMANENT));
  assert.equal(guide.includes('stay on the ledger while the record exists'), false, 'the sentence of before');
  assert.ok(SIGNER_READS.includes('but the phrase in your config exposes the whole wallet, so this guide never uses one'));
  const eight = section(guide, '8. The terminal path');
  assert.ok(eight.includes('```bash\ngit clone https://github.com/Apex-Fusion/vector-agent-template.git && cd vector-agent-template && git checkout c4c378a && corepack pnpm install\n' + LIBSODIUM_COPY + '\n```'), 'the copy follows the install, in the same block');
  assert.ok(eight.includes(LIBSODIUM_WHY));
  assert.ok(eight.includes('The first fetches the template at the pinned commit, and the line after it copies one file that the install leaves out:'));
});

test('docs/LAUNCH.md (findings 4 to 8): the lock floor, the fleet prefixes the chat tools refuse, the stake from a terminal, the template commit, and the key line said to be the key', () => {
  const text = launch();
  assert.ok(text.split('\n')[2].includes('From your chat client you give it an on-chain identity. If you want, you add a reputation stake with the Module-3 SDK, from a terminal.'), 'finding 6');
  const seven = section(text, '7. Test-hire your own agent from chat');
  assert.ok(seven.includes("| 3 | The lock is your price plus both bonds, raised to the ledger's minimum for the escrow output (about 2.2 to 2.3) when that sum is lower; the tool prints the lock beside the price and both bonds. The wait ends with \"Transaction Confirmed\". |"), 'finding 4');
  // The floor is the one HIRE.md section 3 gives.
  assert.ok(section(hire(), '3. What the key must hold').includes('The ledger needs between 2.2 and 2.3 in an escrow output of this size'));
  const two = section(text, '2. Let your coding agent build it');
  assert.ok(two.includes('with a capability id that does not start with `llm.text.generate.`, `llm.chat.`, `ocr.page.extract.` or `audio.synthesize.`: the chat hire tools refuse those.'), 'finding 5');
  assert.ok(two.includes("As of 2026-10-21 the template's `main` is commit `c4c378a`, and its runtime is the one our four agents run."), 'finding 7');
  const five = section(text, '5. Give your agent an identity from chat');
  assert.ok(five.includes('That line is the key itself: copy it into the config, then clear the terminal.'), 'finding 8');
  assert.ok(five.includes('Put the signer in your user-level client config, never in a project file inside the checkout.'), 'finding 8');
});
