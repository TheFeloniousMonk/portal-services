# TaintCheck

A Pocket Network REST service that scans a dependency manifest for **known-vulnerable** and **confirmed-malicious** packages. It is a monitor: the backend keeps a local mirror of OSV.dev (which already ingests the OpenSSF Malicious Packages feed) and answers every relay from it, so a scan spends nothing upstream. The only time a relay waits on the network is to fetch a manifest the caller links to.

Service ID: `taint-check` · `rpc_type: REST` · `compute_units_per_relay: 50000` · `results: variable`

## What one relay does

`POST /v1/scan` with **one** of: a link to a manifest, the manifest pasted in, or a pre-parsed component list:

```json
{ "lockfile": { "url": "https://github.com/acme/app/blob/main/package-lock.json" } }
```
```json
{ "lockfile": { "format": "package-lock.json", "content": "<raw file text>" } }
```
```json
{ "components": [ { "ecosystem": "npm", "name": "minimist", "version": "1.2.0" } ],
  "options": { "since": "2026-09-01T00:00:00Z", "heuristics": true, "min_severity": "high" } }
```

Response (every response is a JSON object, including errors):

```json
{
  "service": "taint-check",
  "data_as_of": "2026-09-20T06:00:00Z",
  "summary": { "malicious": 1, "vulnerable": 7, "suspicious": 3, "clean": 417, "highest": "malicious", "action_required": true },
  "findings": [
    { "ecosystem": "npm", "name": "evil-pkg", "version": "2.4.1", "verdict": "malicious",
      "malicious": [ { "id": "MAL-2024-0001", "source": "ossf/malicious-packages" } ],
      "recommendation": "Remove immediately; this exact version is confirmed malware." }
  ],
  "unresolved": []
}
```

- **`verdict`** is the spine: `malicious` (a `MAL-` record — this exact version is confirmed malware, ranked above any CVSS score) > `vulnerable` (an OSV advisory hit) > `suspicious` (heuristic signals only) > `clean`.
- **`data_as_of`** is always present: a monitor is only as good as its freshness. Because each supplier syncs its own snapshot, `results` is `variable` and verdicts converge as mirrors sync.
- **`lockfile.url`** takes a link to one public file on `github.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`, `gitlab.com` or `bitbucket.org`; the page link from the browser works and is fetched as the raw file. The format comes from the filename unless `lockfile.format` is given. A fetch that fails is a 4xx (`url_not_allowed` 400, `source_not_found`/`source_unavailable`/`source_deadline` 422, `source_too_large` 413).
- **`package.json`** names version ranges, not installed versions, so only exact pins are scanned and every range is listed in `unresolved`. Link the lockfile to scan what is actually installed.
- **Nothing to scan is an error.** An input with no pinned packages returns `400 nothing_to_scan` with the unresolved entries in `error.details`, so a caller never pays for an empty "all clean".
- **`options.since`** is a stateless delta mode: only advisories modified after the timestamp are returned, using OSV `modified`/`published` times — no per-caller state, which suits Pocket's relay model.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET/HEAD | `/` | RelayMiner reachability ping |
| GET | `/healthz` | readiness — `ok` only once a snapshot is loaded |
| GET | `/v1/version` | identity probe (`$.service`) |
| GET | `/v1/capabilities` | formats, limits, heuristics, sync state |
| GET | `/v1/openapi.json` | the OpenAPI document |
| POST | `/v1/scan` | the scan |

Supported formats: `package.json` (exact pins only), `package-lock.json` (also `npm-shrinkwrap.json` by link), `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `poetry.lock`, `uv.lock`, `Pipfile.lock`, `Cargo.lock`, `go.sum`. Ecosystems: npm, PyPI, crates.io, Go.

## Design notes

- **Links are fetched from public code hosts only.** `lockfile.url` is the one caller-supplied URL, and `fetcher.js` keeps it from becoming a general fetcher: https on the default port, no credentials, an allowlisted host and a single-file path, DNS resolved in-process with every address checked as public and the connection pinned to it (no DNS rebinding), redirects re-checked against the allowlist (at most 3), and a size and deadline cap. The service still never follows a URL, path, or VCS reference found *inside* a lockfile; it extracts only `(ecosystem, name, version)` and looks them up locally, and registry URLs for heuristics are built from `(ecosystem, name)`. A general "any URL" fetcher was considered and declined (2026-10-14) for the same reasons the fetch-through-egress proxy was.
- **Gateway phrases are escaped.** OSV advisory summaries are upstream text, and some contain phrases a gateway reads as a failed relay ("timeout bypass in vm2"). Every response has those phrases broken with a JSON `\u` escape, which decodes to the identical string (the Skill's design rule 6).
- **Cost tiers.** Tier 0 (mirror + serve) is near-free. Tier 1/2 heuristics (typosquat is local; install-script and recency need registry metadata) are optional and bounded. Deep tarball analysis is deliberately out of scope — that is the paid competitors' moat.
- **Standard library only.** No third-party dependencies; the ZIP reader for the OSV `all.zip` archives is in `unzip.js`.

## Operator configuration (`TC_*`)

| Variable | Default | Meaning |
|---|---|---|
| `TC_ECOSYSTEMS` | `npm,PyPI,crates.io,Go` | ecosystems to mirror |
| `TC_SYNC_INTERVAL_MS` | `21600000` (6h) | mirror refresh cadence |
| `TC_SYNC_ON_START` | `true` | sync on boot |
| `TC_DATA_DIR` | `/data` | snapshot location |
| `TC_MAX_BODY_BYTES` | `4194304` (4 MiB) | request body cap |
| `TC_MAX_COMPONENTS` | `5000` | components per relay |
| `TC_HEURISTICS_ENABLED` | `true` | allow `options.heuristics` |
| `TC_REGISTRY_LOOKUPS` | `false` | enable install-script/recency signals (needs registry egress) |
| `TC_USE_API_BACKSTOP` | `false` | allow the live OSV querybatch backstop |
| `TC_URL_FETCH` | `true` | accept `lockfile.url` |
| `TC_URL_FETCH_DEADLINE_MS` | `8000` | deadline for fetching a linked file |
| `TC_URL_MAX_BYTES` | `4194304` (4 MiB) | size cap for a linked file |

The backend needs outbound HTTPS to `storage.googleapis.com` (mirror), to the allowed code hosts (for `lockfile.url`), and, if registry lookups are on, to the ecosystem registries.

## Development

```bash
cd backend
npm test        # unit + HTTP contract, no network
TC_LIVE_FETCH=1 npm test   # adds one real fetch from github.com
npm start       # runs a real mirror sync on boot
```

## Status

Registered and supplied on Beta and MainNet (2026-09-20, suppliers moved to `cherry-as` 2026-09-28; transactions in `service.json`), serving relays on both. 1.1.0 (2026-10-14) adds `lockfile.url`, `package.json`, the `nothing_to_scan` 400, and gateway-phrase escaping; the on-chain card still describes 1.0 until it is updated with an edit-service transaction on each network.
