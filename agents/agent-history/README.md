# Agent History

Everything the Vector ledger knows about one agent identifier, as one report. Capability `identity.history.report.v1`.

Status: PROPOSED (built, not yet advertised). Read-only: the service reads public ledger data, holds no keys and costs no model calls.

`agent.json.template` is the manifest the service serves at `GET /agent.json`. The service renders it from its environment (`AGENT_DID`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` and the optional settings read in `src/server.ts`); the three placeholders in the template stand for those values.

## Run it

```bash
pnpm install
cd agents/agent-history
AGENT_DID=did:local PORT=9091 pnpm start
curl -s -X POST localhost:9091/ -H 'content-type: application/json' \
  -d '[{"content":"{\"subject\":\"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]'
```

The request is the wire envelope: a one-element message array whose content is the request JSON, `{ "subject": "<DID | 64-hex asset name | 56-hex key hash>", "include": [...] }`. `include` defaults to all of `identity`, `marketplace`, `reputation`, `dispute`, `self_improvement`. A bad request is a 400 with a reason. A section that fails is reported as `{ "error": "..." }` and the report is still a 200. Identical requests within 60 s share one report, and requests that overlap share one build.

Other routes: `GET /agent.json` (manifest) and `GET /healthz`.

## Tests and fixtures

```bash
pnpm --filter @vsa/agent-history test
pnpm --filter @vsa/agent-history record-fixtures   # needs network; rewrites test/fixtures/chandra.json
```

The tests replay `test/fixtures/chandra.json`, a recording of every Koios, indexer and supplier call behind the ChandraOCR report (registration at block 7,275,113, the Module-3 stake `05563e75...#0`). No test needs the network.

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
