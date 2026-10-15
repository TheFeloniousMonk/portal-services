# Meme Watch (`meme-watch`)

A rolling 60-minute feed of Solana memecoin launches, served as a REST service on
Pocket Network. One `POST /v1/launches` returns everything that launched in the
last hour on Pump.fun, PumpSwap, Meteora DAAM v2 and Meteora DBC, with identity,
traction, buy and sell split, and drawdown from the all-time high.

Built with the Pocket Service Builder skill. Upstream data comes from
[DexPaprika](https://dexpaprika.com).

---

## Every supplier needs its own DexPaprika API key

This is the one thing to know before staking as a supplier for this service.

The backend reads an upstream API that meters by account. It does **not** accept a
credential from the caller, and no key ships in this repository or in the image.
Each operator creates their own at <https://console.dexpaprika.com>, which is free
and needs no card, and sets it in `deploy/.env` as `MW_DEXPAPRIKA_API_KEY`.

Without a key the backend still runs, on the keyless tier, but that tier is
metered per IP address and allows far fewer requests a month. The credit governor
reacts by polling less often, so the feed thins out and launches age out of the
window before they can be named. Treat a key as required.

On first run, check `GET /v1/capabilities` and read `upstream.plan`. That value is
what the API itself reports. If a key is configured and it still says the keyless
tier, the auth header name is wrong for your account; set `MW_DEXPAPRIKA_AUTH_HEADER`.

---

## How it works

Every relay is answered from a cache held in memory and mirrored to a CSV. A relay
never waits on an upstream call, so responses come back in milliseconds and an
upstream problem degrades the data rather than failing the relay.

A poll runs every 120 seconds:

1. **Re-read the whole 60-minute window**, newest first. Not just what is new since
   last time. The upstream index runs up to a minute behind the chain, so a pool can
   appear *after* we have already passed its creation time. A high-water mark would
   step over it permanently. Re-reading the window picks it up on the next poll.
2. **Refresh traction on rows already held.** Price, volume, transaction count and
   liquidity all change, and they arrive in the same list response that finds new
   pools, so refreshing them costs nothing extra. Without this, a launch found at
   two minutes old would carry two-minute-old numbers for the other 58.
3. **Enrich, then publish.** A newly seen pool is not added to the feed until its
   identity call has returned. Identity is fetched once and never refetched, because
   a name, symbol, supply and social link do not change. Pools waiting their turn sit
   in an in-memory queue, hottest first, and are counted in `pending_identity`.
4. **Prune and write.** Anything whose on-chain creation time has passed out of the
   window is dropped, and the CSV is rewritten to a temp file and renamed, so a
   request can never read a half-written file.

The CSV is reloaded on boot, so a restart does not lose the window.

### The credit budget is the architecture

A free key allows 100,000 credits a month. A 120-second poll is 21,600 polls a
month, which leaves about **4.6 upstream calls per poll** for everything. The
governor in `backend/dexpaprika.js` enforces a per-poll cap and a persisted monthly
ledger, so a restart loop cannot reset the counter and burn the allowance.

Because enrichment happens once per launch, the number of launches admitted per hour
*is* the bill. That makes the traction gate an editorial decision, not a tuning knob.
Measured on 2026-09-20 over a 60-minute window on Solana:

| Upstream gate | Launches per hour | Fits the budget |
|---|---|---|
| volume ≥ $5k, $10k, $20k | over 100, multiple pages | no |
| volume ≥ $50k and 100 transactions | 61, one page | yes |

So the default gate is $50,000 of since-launch volume and 100 transactions. At four
calls per poll the service spends about 86,400 credits a month and can name roughly
90 launches an hour against 61 arriving. Lowering the gate needs a paid upstream
plan; it is not just a larger number in the config.

A cold start is the exception. It finds a full hour at once and would take hours to
converge at three enrichments per poll, so `MW_COLDSTART_EXTRA_CALLS` grants a
one-time pool of 60 extra calls that fills the window on the first poll or two. That
is under 0.1% of a month.

---

## HTTP contract

Every response is a JSON object, including errors. Inputs are read from the POST
body: no caller header survives a relay, and the query string is not reliably
forwarded by every gateway.

| Method and path | Purpose |
|---|---|
| `GET`, `HEAD` `/` | Reachability ping. The RelayMiner refuses to start if this is not 2xx. |
| `GET /healthz` | Readiness. 503 until the first poll completes. |
| `GET /v1/version` | Identity probe. Pins the backend to the `meme-watch` id. |
| `GET /v1/capabilities` | Window, gate, limits, columns, upstream plan and credits left. |
| `GET /v1/openapi.json` | The OpenAPI document. |
| `POST /v1/launches` | The feed. |

### Query body

Every field is optional. An empty object returns the default page.

| Field | Type | Default | Notes |
|---|---|---|---|
| `dex` | string or array | all venues | `pumpfun`, `pumpswap`, `meteora_daam_v2`, `meteora_dbc` |
| `limit` | integer | 100 | capped at 500 |
| `max_age_minutes` | number | 60 | capped at the window |
| `min_txns` | number | none | |
| `min_volume_usd` | number | none | |
| `min_liquidity_usd` | number | none | |
| `named_only` | boolean | false | drop rows whose identity has not resolved |
| `sort` | string | `created_at` | or `volume_usd`, `txns`, `vol_per_txn`, `price_change_5m` |
| `format` | string | `json` | `csv` puts the table in the `csv` string field |

```bash
curl -sX POST http://localhost:8080/v1/launches \
  -H 'Content-Type: application/json' \
  -d '{"dex":"pumpfun","sort":"volume_usd","limit":10}'
```

### Reading the response

Three envelope fields matter for interpreting the data:

- **`complete_before`** is the instant up to which the upstream index is assumed
  settled. Launches after it are reported but may still be arriving. This is how a
  consumer tells a genuinely quiet minute from one that is not indexed yet.
- **`pending_identity`** counts launches that have been discovered but not yet
  named, and so are deliberately absent from `launches`.
- **`upstream_note`** is a closed vocabulary: `rate_limited`, `quota_exhausted`,
  `budget_exhausted`, `unreachable`, `bad_response`, `http_error`, or empty. It is
  never a raw upstream message, because gateways scan response bodies for wording
  like "timeout" and penalise the supplier for it.

### Fields worth understanding

- **`volume_usd` and `txns` are since-launch totals**, not 24-hour ones. For a pool
  younger than the window every upstream time bucket holds the same number.
- **`price_change_5m` is the only price window with signal this early.** The 6h and
  24h figures read zero until a pool is older than they are.
- **`quote_reserve_usd`, not `liquidity_usd`, is the money in the pool.** On a
  bonding-curve pool the headline liquidity figure does not reconcile with the
  reserves. Both are reported; prefer the reserve.
- **`vol_per_txn` separates interest from automation.** A pool doing 454 trades
  worth $119 in total is bots. One doing $28 a trade is people.
- **Duplicate symbols are real.** Copycat launches reuse hot tickers within
  minutes. The feed does not deduplicate them, and the repetition is itself signal.

### Not available

Holder counts, creator or developer wallet, bonding-curve progress, mint and freeze
authority, LP burn status, and token image URLs. The upstream API carries none of
them. Any rug-check dimension needs a Solana RPC call alongside this service, which
Pocket already supplies.

---

## Configuration

All settings are `MW_*` environment variables. Defaults are in `backend/config.js`.

| Variable | Default | Purpose |
|---|---|---|
| `MW_DEXPAPRIKA_API_KEY` | none | **Per-supplier upstream key.** |
| `MW_DEXPAPRIKA_BASE_URL` | auto | Authenticated host when a key is set. |
| `MW_DEXPAPRIKA_AUTH_HEADER` | `X-Api-Key` | Change if your account uses another name. |
| `MW_WINDOW_MINUTES` | `60` | Size of the rolling window. |
| `MW_POLL_INTERVAL_MS` | `120000` | Poll cadence. |
| `MW_INDEX_LAG_SECONDS` | `120` | Declared completeness boundary. |
| `MW_MAX_CALLS_PER_POLL` | `4` | Hard per-poll upstream cap. |
| `MW_MAX_LIST_PAGES` | `2` | Pages of the window to read per poll. |
| `MW_MONTHLY_CREDITS` | `95000` | Persisted monthly ceiling. |
| `MW_COLDSTART_EXTRA_CALLS` | `60` | One-time allowance to fill the window at boot. |
| `MW_GATE_MIN_VOLUME_USD` | `50000` | Upstream traction gate. |
| `MW_GATE_MIN_TXNS` | `100` | Upstream traction gate. |
| `MW_DATA_DIR` | `/data` | CSV and credit ledger. Needs a persistent volume. |

---

## Deploying

The supplier host already runs one HA RelayMiner stack per network. Adding this
service means starting its backend on the shared `pocket-supplier` network and
adding one entry to the relayer config.

```bash
# on the supplier host, in this service's deploy/ directory
cp .env.example .env && $EDITOR .env      # set MW_DEXPAPRIKA_API_KEY
docker compose -f docker-compose.yaml up -d --build
bash add-to-relayer.sh /opt/pocket/supplier
```

Registration, staking and the compute-units-per-relay price are done from the
Pocket Service Manager, which owns `service.json`. The `COMPUTE_UNITS_PER_RELAY`
value in `deploy/answers.json` is only a placeholder for the rendered reference
files; the app sets the on-chain value.

## Testing

```bash
cd backend && npm test
```

22 checks, no network access and no upstream credits: the server starts with
polling disabled and every fixture is a recorded upstream response. The suite
asserts the probe contracts, that every body starts with a brace, and that no
success body carries wording a gateway penalises.

To lint a running backend against the card's own health checks, from `backend/`:

```bash
python ../../../skills/pocket-service-builder/scripts/lint_backend.py \
  --base-url http://127.0.0.1:8080 --card ../card.json \
  --bad 'POST /v1/launches {"sort":"bogus"}'
```

## Layout

| Path | What it is |
|---|---|
| `card.json` | The on-chain metadata card. Validates clean; `results` is `variable`. |
| `service.json` | Read and written by the Pocket Service Manager. |
| `backend/` | The service. Node 22, no runtime dependencies. |
| `deploy/docker-compose.yaml` | Backend only, on the supplier's shared network. |
| `deploy/relayer-service.yaml` | The one block to merge into the relayer config. |
| `deploy/answers.json` | Inputs for the Skill's template renderer. |
| `deploy/rendered/` | Generated stake configs, gateway snippets and client config. |

## Why results are `variable`

Two suppliers running this service hold different cache state and poll on their own
schedules, so they legitimately return different rows for the same request. The card
says so. A consumer cannot cross-check one supplier against another here, and should
read `as_of` rather than assuming a canonical answer.
