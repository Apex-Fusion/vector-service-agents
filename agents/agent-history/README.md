# Agent History

The registry, stake, marketplace and module records the Vector ledger holds for one agent identifier, with the gaps stated. One report per job, delivered with the runtime's signed receipt. Capability `identity.history.report.v1`.

Status: DEPLOYED (registered and staked 2026-10-14, advertised 2026-10-14, re-advertised 2026-10-15 at the status flip, one first-party job settled 2026-10-15). Since 2026-10-15. Read-only: the service reads public ledger data, holds no keys and costs no model calls.

`agent.json.template` is the manifest with placeholders. The service renders the real manifest from its environment when it starts (`OPERATOR_CONTACT`, `AGENT_DID`, `SUPPLIER_PKH`, `SUPPLIER_PUB_KEY_HEX` and the optional settings, see Manifest below) and serves those bytes at `GET /agent.json`. It never serves the template itself. `<OPERATOR_CONTACT>`, `<AGENT_DID>`, `<SUPPLIER_PKH>` and `<SUPPLIER_PUB_KEY_HEX>` in the template stand for those four values.

## Run it

```bash
pnpm install
cd agents/agent-history
OPERATOR_CONTACT=ops@example.test AGENT_DID=did:local PORT=9091 pnpm start
curl -s -X POST localhost:9091/ -H 'content-type: application/json' \
  -d '[{"content":"{\"subject\":\"did:vector:agent:be1a0a2912da180757ed3cd61b56bb8eab0188c19dc3c0e3912d2c01:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]'
```

The body of `POST /` is the wire payload: a one-element message array whose `content` is the request JSON as a string, as in the curl above. The request JSON is `{ "subject": "<DID | 64-hex asset name | 56-hex key hash>", "include": [...] }`. `include` defaults to all of `identity`, `marketplace`, `reputation`, `dispute`, `self_improvement`. A bad request is a 400 with a reason. A section that fails is reported as `{ "error": "..." }` and the report is still a 200. Identical requests within 60 s share one report, and requests that overlap share one build. A report with a failed section or without a chain tip is answered but not kept, so the next request builds it again.

Other routes: `GET /agent.json` (manifest) and `GET /healthz`. `POST` is accepted on `/` only; any other path is a 404.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with the four placeholders. A test keeps the two equal, so change the template by changing `manifestFromEnv` and regenerating it. The specification of the agent is `specs/agent-history.md` at the repository root.

| Variable | Manifest field | Default |
|---|---|---|
| `AGENT_DID` | `identity.did` | empty |
| `SUPPLIER_PKH` | `identity.controller_pkh` and `keys.supplier_pkh` | empty |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex` | empty |
| `AGENT_VERSION` | `version` | `0.1.0` |
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `1000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms` | `300000` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |
| `AGENT_STATUS_SINCE` | `status.since` | `2026-10-15` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |

Numbers (and `PORT`) must be non-negative integers. `AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case. `OPERATOR_CONTACT` must be set and not blank. A value that breaks one of these rules stops the service at start, and the error names the variable. `OPERATOR_CONTACT` has no default, because the value is published in the manifest that the advert hashes: use a role address that the Foundation confirms, never a person's.

The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there. Adverts are immutable, so a changed manifest means a retired advert and a new one. From the repository root, print the hash of a running agent with `node scripts/manifest-hash.mjs https://<host>`.

## Tests and fixtures

```bash
pnpm --filter @vsa/agent-history test
pnpm --filter @vsa/agent-history record-fixtures   # needs network; rewrites test/fixtures/chandra.json
```

The tests replay `test/fixtures/chandra.json`, a recording of every Koios, indexer and supplier call behind the ChandraOCR report (registration at block 7,275,113, the Module-3 stake `05563e75...#0`). No test needs the network.

The recorder refuses to overwrite the fixture when the live report has a failed section, no chain tip or no registry record. The `report` stored in the fixture is the report the code built during the recording, and the report test compares a fresh replay with it exactly: every section, the sources and the blind spots. Record again after any change to the shape of the report, then update the example in `specs/agent-history.md`, whose key paths a test keeps equal to a real report. The last recording, 2026-10-13, added the three Module-1 v15-sim addresses; the ledger data it holds for ChandraOCR is otherwise the same as before (3,436 indexer rows, first-party, as all marketplace activity to date; the stake; the registration), with a later chain tip. When the blind-spot lines changed (a sixth fixed line, and a reworded first one), the stored `report` was rebuilt offline from the recorded calls with the new code: no call was made again, and every other part of the report is byte-identical to the recording.

## Live check

A local run against the live ledger, 2026-10-13, chain tip at block 8,729,902, subject the ChandraOCR DID, all sections. The report now reads 11 module addresses: the three Module-1 v15-sim addresses join the eight it read before.

| Check | Result |
|---|---|
| Time, first request | 1.6 s (limit for this check: 60 s) |
| Time, identical request again | 2 ms, from the cache; the body is byte-identical (6,502 bytes) |
| `identity.registered` | tx `fee14e5f...`, block 7275113 |
| `reputation.stakes[0]` | `05563e75...#0`, `stake_lovelace` "10000000" |
| `key_roles.capability_key_matches_controller` | true |
| `marketplace.as_supplier.escrows` | `total` 3436, `latest_checked` 50, `latest_spent` 50 |
| `dispute` | six arrays, three from the v14 addresses and three from the v15-sim addresses, all empty for this agent |
| Sections with an error | none |

`escrows.total` counts the indexer's rows, which are escrow UTxO versions: the 3,436 rows are 1,160 jobs (first-party, as all marketplace activity to date), each listed once per state it reached (Open, Claimed, Submitted). The report checks the latest 50 rows per side on the ledger and does not check the older ones: here `latest_checked` is 50 and all 50 are spent (`latest_spent` 50). No row records how a job ended; the report says so under `blind_spots`.

Two earlier runs on the same day, before the v15-sim addresses were added, gave the same values. The first took 3.0 s (chain tip at block 8,727,027). The second, after review batch 2 made the sections run concurrently, took 1.5 s (block 8,727,874) and answered the identical request in 3 ms from the cache.

## Image

`Dockerfile` builds the service image. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/agent-history/Dockerfile -t vsa/agent-history:dev .`. The image runs as the `node` user under `tini`, listens on 9091 and answers `/healthz` for its health check. It holds no key. The publish job in `.github/workflows/ci.yml` pushes the image on merge to `main`, to `ghcr.io/apex-fusion/vector-service-agents/agent-history` as `:latest` and as `:<commit sha>`. It has run on each merge to `main` since the repository went public on 2026-10-16, and the image is public; the box still builds the image itself. The agent is running on the box, and its status has been DEPLOYED since 2026-10-15. How it is put on the box, and what the operator and the host administrator each do: `deploy/host/README.md` and `deploy/host/RUNBOOK.md`.
