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
  -d '[{"content":"{\"subject\":\"did:vector:5542837bc3a6ccd66cb75ac91a796cf5716d439f4a72594bbfc06db7231029db\"}","role":"user"}]'
```

The body of `POST /` is the wire payload: a one-element message array whose `content` is the request JSON as a string, as in the curl above. The request JSON is `{ "subject": "<DID | 64-hex identifier | 56-hex key hash>", "include": [...] }`. A DID is the canonical `did:vector:<identifier>` or the legacy `did:vector:agent:<legacy registry policy>:<identifier>`, in lowercase; both give the same report. `include` defaults to all of `identity`, `marketplace`, `reputation`, `dispute`, `self_improvement`. A bad request is a 400 with a reason. A section that fails is reported as `{ "error": "..." }` and the report is still a 200. Identical requests within 60 s share one report, and requests that overlap share one build. A report with a failed section or without a chain tip is answered but not kept, so the next request builds it again.

Other routes: `GET /agent.json` (manifest) and `GET /healthz`. `POST` is accepted on `/` only; any other path is a 404.

## Manifest

`agent.json.template` is the JSON that `manifestFromEnv` prints with the four placeholders. A test keeps the two equal, so change the template by changing `manifestFromEnv` and regenerating it. The specification of the agent is `specs/agent-history.md` at the repository root.

| Variable | Manifest field | Default |
|---|---|---|
| `AGENT_DID` | `identity.did`, in the canonical form `did:vector:<identifier>`. The legacy form of the same identifier is published in the canonical form | empty |
| `SUPPLIER_PKH` | `keys.supplier_pkh`, and with `AGENT_DID` the listed supplier key `identity.supplier_key`, `<DID>#<key hash>` | empty |
| `SUPPLIER_PUB_KEY_HEX` | `keys.pub_key_hex` | empty |
| `IDENTITY_POLICY_ID` | `identity.registry_address`, the address of the identity registry derived from its policy | empty, the identity registry is not configured |
| `AGENT_VERSION` | `version` | `0.2.0` |
| `OPERATOR_CONTACT` | `operator.contact` | none. Required: the service stops at start without it |
| `ADVERT_PRICE_LOVELACE` | `terms.price_lovelace` | `1000000` |
| `ADVERT_MAX_PROCESSING_MS` | `terms.max_processing_ms` | `300000` |
| `AGENT_STATUS_CHIP` | `status.chip`, in lower case | `deployed` |
| `AGENT_STATUS_SINCE` | `status.since` | `2026-10-15` |
| `ADVERT_EXPLORER_URL` | `links.explorer_advert` | empty |

Numbers (and `PORT`) must be non-negative integers. `AGENT_STATUS_CHIP` must be LIVE, DEPLOYED or PROPOSED, in any case. `OPERATOR_CONTACT` must be set and not blank. A value of `AGENT_DID` that starts with `did:vector:` must name a Vector mainnet agent: the canonical form, or the legacy form under the legacy registry policy. A value that breaks one of these rules stops the service at start, and the error names the variable. `OPERATOR_CONTACT` has no default, because the value is published in the manifest that the advert hashes: use a role address that the Foundation confirms, never a person's.

## Settings of the report

The registries and the module addresses are deployment values. The service reads them when it starts (`src/config.ts`), and a value that breaks a rule stops it, with the variable named.

| Variable | What it sets | Default |
|---|---|---|
| `IDENTITY_POLICY_ID` | the identity registry: 56 lowercase hex characters, the policy ID published at its deployment. The report then reads both registries | empty: the legacy registry only, and every report says so in `blind_spots` |
| `IDENTITY_ADDRESS` | the address of the identity registry. It may be left out; when it is set it must be the address of `IDENTITY_POLICY_ID` (the script as payment credential, no stake credential), and it needs `IDENTITY_POLICY_ID` | derived from the policy |
| `M3_REPUTATION_ADDRESS`, `M3_ENDORSEMENT_ADDRESS` | the Module-3 stake and endorsement addresses | the deployment before the identity registry (`@vsa/vector-read` constants) |
| `M1_ADDRESSES`, `M6_ADDRESSES` | the Module-1 and Module-6 addresses, as `label=address` pairs separated by commas. The labels (a lowercase letter, then lowercase letters, digits and `_`, 32 at most) are the keys of the `dispute` and `self_improvement` sections, in that order | the six Module-1 addresses (v14 and v15-sim) and the three Module-6 addresses before the identity registry |
| `KOIOS_URL`, `INDEXER_URL` | the Koios and marketplace indexer bases (`@vsa/vector-read`) | Vector mainnet |

Each module address must be a Vector mainnet address whose payment credential is a script. A list names no label and no address twice. The names `IDENTITY_POLICY_ID` and `IDENTITY_ADDRESS` are the ones the identity gateway and the marketplace indexer read.

The advert `detail_uri` points at `GET /agent.json` and its `detail_hash` is the sha256 of the bytes served there. Adverts are immutable, so a changed manifest means a retired advert and a new one. From the repository root, print the hash of a running agent with `node scripts/manifest-hash.mjs https://<host>`.

## Tests and fixtures

```bash
pnpm --filter @vsa/agent-history test
pnpm --filter @vsa/agent-history record-fixtures            # needs network; rewrites test/fixtures/chandra.json
pnpm --filter @vsa/agent-history record-fixtures --replay   # no network; builds the stored report again from the recorded calls
```

The tests replay `test/fixtures/chandra.json`, a recording of every Koios, indexer and supplier call behind the ChandraOCR report (registration at block 7,275,113, the Module-3 stake `05563e75...#0`). No test needs the network. The identity registry is not deployed yet, so the tests of its records (registration, updates, holds, statuses, parties, recoveries, tombstones, adoption, a token outside its registry address) run on a small ledger in `test/support.ts`: the transactions of a test go in, and it answers the Koios calls the way Koios does. The ChandraOCR adoption tests put the recorded legacy registration and a synthetic adoption on that ledger, and every other call goes to the recording.

The recorder refuses to overwrite the fixture when the report has a failed section, no chain tip or no registry record. It builds the report with the default settings (the legacy registry, the module deployments before the identity registry), the ones the tests replay it with. The `report` stored in the fixture is the report the code built from the recorded calls, and the report test compares a fresh replay with it exactly: every section, the sources and the blind spots. After a change to the shape of the report, build the stored report again with `--replay` (or record again), then update the example in `specs/agent-history.md`, whose key paths a test keeps equal to a real report. The last recording, 2026-10-13, added the three Module-1 v15-sim addresses; the ledger data it holds for ChandraOCR is otherwise the same as before (3,436 indexer rows, first-party, as all marketplace activity to date; the stake; the registration), with a later chain tip. When the blind-spot lines changed (a sixth fixed line, and a reworded first one), and again for version 0.2.0 (the identity registry), the stored `report` was rebuilt offline from the recorded calls with the new code: no call was made again, and the ledger data is the recording's.

## Live check

A local run against the live ledger, 2026-10-13, chain tip at block 8,729,902, subject the ChandraOCR DID, all sections. The report now reads 11 module addresses: the three Module-1 v15-sim addresses join the eight it read before.

| Check | Result |
|---|---|
| Time, first request | 1.6 s (limit for this check: 60 s) |
| Time, identical request again | 2 ms, from the cache; the body is byte-identical (6,502 bytes) |
| `identity.registered` | tx `fee14e5f...`, block 7275113 |
| `reputation.stakes[0]` | `05563e75...#0`, `stake_lovelace` "10000000" |
| `key_roles.capability_key_matches_controller` (0.1.0; `capability_key_active` since 0.2.0) | true |
| `marketplace.as_supplier.escrows` | `total` 3436, `latest_checked` 50, `latest_spent` 50 |
| `dispute` | six arrays, three from the v14 addresses and three from the v15-sim addresses, all empty for this agent |
| Sections with an error | none |

`escrows.total` counts the indexer's rows, which are escrow UTxO versions: the 3,436 rows are 1,160 jobs (first-party, as all marketplace activity to date), each listed once per state it reached (Open, Claimed, Submitted). The report checks the latest 50 rows per side on the ledger and does not check the older ones: here `latest_checked` is 50 and all 50 are spent (`latest_spent` 50). No row records how a job ended; the report says so under `blind_spots`.

Two earlier runs on the same day, before the v15-sim addresses were added, gave the same values. The first took 3.0 s (chain tip at block 8,727,027). The second, after review batch 2 made the sections run concurrently, took 1.5 s (block 8,727,874) and answered the identical request in 3 ms from the cache.

## Image

`Dockerfile` builds the service image. The build context is the repository root, because the image installs the workspace from the lockfile: `docker build -f agents/agent-history/Dockerfile -t vsa/agent-history:dev .`. The image runs as the `node` user under `tini`, listens on 9091 and answers `/healthz` for its health check. It holds no key. The publish job in `.github/workflows/ci.yml` pushes the image on merge to `main`, to `ghcr.io/apex-fusion/vector-service-agents/agent-history` as `:latest` and as `:<commit sha>`. It has run on each merge to `main` since the repository went public on 2026-10-16, and the image is public; the box still builds the image itself. The agent is running on the box, and its status has been DEPLOYED since 2026-10-15. How it is put on the box, and what the operator and the host administrator each do: `deploy/host/README.md` and `deploy/host/RUNBOOK.md`.
