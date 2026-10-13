# Agent History

Everything the Vector ledger knows about one agent identifier, as one report. Capability `identity.history.report.v1`.

Status: PROPOSED (built, not yet advertised). Read-only: the service reads public ledger data, holds no keys and costs no model calls.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts (`AGENT_DID`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` and the optional settings, see Manifest below) and serves those bytes at `GET /agent.json`. It never serves the template itself. `<AGENT_DID>`, `<SUPPLIER_PKH>` and `<SUPPLIER_PUB_KEY_HEX>` in the template stand for those three values.

## Run it

```bash
pnpm install
cd agents/agent-history
AGENT_DID=did:local PORT=9091 pnpm start
curl -s -X POST localhost:9091/ -H 'content-type: application/json' \
  -d '[{"content":"{\"subject\":\"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]'
```

The request is the wire envelope: a one-element message array whose content is the request JSON, `{ "subject": "<DID | 64-hex asset name | 56-hex key hash>", "include": [...] }`. `include` defaults to all of `identity`, `marketplace`, `reputation`, `dispute`, `self_improvement`. A bad request is a 400 with a reason. A section that fails is reported as `{ "error": "..." }` and the report is still a 200. Identical requests within 60 s share one report, and requests that overlap share one build. A report with a failed section or without a chain tip is answered but not kept, so the next request builds it again.

Other routes: `GET /agent.json` (manifest) and `GET /healthz`. `POST` is accepted on `/` only; any other path is a 404.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with the three placeholders. A test keeps the two equal, so change the template by changing `manifestFromEnv` and regenerating it. The specification of the agent is `specs/agent-history.md` at the repository root.

| Variable | Manifest field | Default |
|---|---|---|
| `AGENT_DID` | `identity.did` | empty |
| `SUPPLIER_PKH` | `identity.controller_pkh` and `keys.supplier_pkh` | empty |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex` | empty |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `OPERATOR_CONTACT` | `operator.contact` | the Foundation address in `src/server.ts` |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `1000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms` | `300000` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `proposed` |
| `AGENT_STATUS_SINCE` | `status.since` | `2026-10-13` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |

Numbers (and `PORT`) must be non-negative integers. `AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case. Anything else stops the service at start, and the error names the variable.

The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there. Adverts are immutable, so a changed manifest means a retired advert and a new one. From the repository root, print the hash of a running agent with `node scripts/manifest-hash.mjs https://<host>`.

## Tests and fixtures

```bash
pnpm --filter @vsa/agent-history test
pnpm --filter @vsa/agent-history record-fixtures   # needs network; rewrites test/fixtures/chandra.json
```

The tests replay `test/fixtures/chandra.json`, a recording of every Koios, indexer and supplier call behind the ChandraOCR report (registration at block 7,275,113, the Module-3 stake `05563e75...#0`). No test needs the network.

The recorder refuses to overwrite the fixture when the live report has a failed section, no chain tip or no registry record. The `report` stored in the fixture was made before the sources were sorted and the blind spots reworded, so the report test compares its data sections and its set of sources, and the blind-spot lines are tested against `BLIND_SPOTS`. Recording again refreshes it.

## Live check

A local run against the live ledger, 2026-10-13, chain tip at block 8,727,027, subject the ChandraOCR DID, all sections:

| Check | Result |
|---|---|
| Time, first request | 3.0 s (limit for this check: 60 s) |
| Time, identical request again | 0.2 s, from the cache; the body is byte-identical |
| `identity.registered` | tx `fee14e5f...`, block 7275113 |
| `reputation.stakes[0]` | `05563e75...#0`, `stake_lovelace` "10000000" |
| `key_roles.capability_key_matches_controller` | true |
| `marketplace.as_supplier.escrows` | `total` 3436, `latest_checked` 50, `latest_spent` 50 |
| Sections with an error | none |

`escrows.total` counts the indexer's rows, which are escrow UTxO versions: the 3,436 rows are 1,160 jobs, each listed once per state it reached (Open, Claimed, Submitted), and all of them are spent on the ledger. No row records how a job ended; the report says so under `blind_spots`.

A second run after review batch 2, which reads the sections concurrently, 2026-10-13, chain tip at block 8,727,874, same subject and sections: the first request took 1.5 s, the identical second request 3 ms from the cache, no section had an error, and the 3,436 rows and 50 of 50 spent were the same.
