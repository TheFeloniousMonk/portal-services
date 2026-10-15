# infiniFi Data (`infinifi`)

A Pocket Network REST service that gives agents read-only access to the [infiniFi](https://infinifi.xyz) protocol: yields, farms, redemptions, allocation votes, partner opportunities, and any wallet's positions, profit, history, and points. It is a **pass-through**. Every answer comes from infiniFi's own API at request time, reshaped for agents. The service never signs, prepares, or submits a transaction, and it is not affiliated with infiniFi.

Service ID: `infinifi` · `rpc_type: REST` · `compute_units_per_relay: 50000` · `results: variable`

## Endpoints

Every data endpoint is `POST` with a JSON body. Those with no required input also answer `GET` with their defaults. Every response, errors included, is a JSON object carrying `fetched_at` (when infiniFi answered) and `stale` (true when infiniFi was down and a cached copy was served).

### Protocol

| Path | Body | Returns |
|---|---|---|
| `/v1/overview` | — | TVL, liquid/illiquid split, iUSD supply (staked, locked, unwinding), siUSD rate and APYs, lock-tier and farm counts |
| `/v1/yields` | `min_weeks`, `max_weeks`, `include_empty` | siUSD and each liUSD tier (1–13 weeks): exchange rate, 1/7/30-day APY, amount locked, `empty` flag |
| `/v1/farms` | `chain`, `type`, `include_paused`, `min_apy`, `sort` | Where the USDC is deployed: APY, assets, maturity, redemption bucket, description |
| `/v1/farm` | `address` or `name` | Every farm matching; one name can exist on several chains |
| `/v1/params` | — | Reserve ratio, illiquid target, return and per-week bucket multipliers |
| `/v1/redemption-queue` | — | Total waiting, when fully funded, tickets |
| `/v1/redemption-quote` | `amount_iusd` | Whether that redemption pays out now or joins the queue |
| `/v1/allocation-votes` | `epoch` (default current) | Vote split across farms, with farm names |
| `/v1/opportunities` | `chain`, `protocol`, `asset` | Partner yield opportunities with APY, TVL, points multipliers, dates, infiniFi's link |

### Wallet (`address` required)

| Path | Extra body | Returns |
|---|---|---|
| `/v1/wallet` | — | One-call summary: current value, profit, unwinding, redemptions, points rank |
| `/v1/wallet/pnl` | — | Profit in iUSD: staked, per lock tier, unwinding; by chain |
| `/v1/wallet/history` | `kind` (`tvl`/`pnl`), `days` (7, 30, 90, 365, `"all"`), `by_chain` | USD series |
| `/v1/wallet/unwinding` | — | Positions currently unlocking |
| `/v1/wallet/redemptions` | — | Place in the queue, USDC claimable |
| `/v1/wallet/votes` | `epoch` | The wallet's allocation votes |
| `/v1/wallet/points` | `detail` | Rank, finalized points, multipliers, per-chapter points (per-source with `detail`) |

Plus `GET /` (RelayMiner ping), `GET /healthz`, `GET /v1/version`, `GET /v1/capabilities`, `GET /v1/openapi.json`.

```json
POST /v1/wallet  {"address": "0x46a83dc1a264bff133db887023d2884167094837"}
{
  "service": "infinifi", "fetched_at": "2026-10-15T19:09:19.276Z", "stale": false,
  "value_usd": 1132636.83,
  "pnl_iusd": {"total": 203261.30, "staked": 55029.39, "locked": 128551.56, "unwinding": 19680.34},
  "unwinding": {"count": 0, "positions": []},
  "redemptions": {"claimable_usdc": 0, "enqueued_iusd": 0, "fully_funded_at": null, "tickets": []},
  "points": {"rank": 10, "total_finalized_points": 335584.16, "current": {"episode": 11, "chapter": 3}},
  "missing": []
}
```

Units: APYs are fractions (`0.062` = 6.2%). Token amounts are whole tokens, not base units. `amount_iusd` is converted to infiniFi's 18-decimal units exactly, without floating point.

## How it maps to infiniFi

infiniFi publishes no API reference; its docs point to a private backend repository. The endpoint list here was read from the app's own bundle (`app.infinifi.xyz`) on 2026-10-15, and every call was checked live. `api.infinifi.xyz/api` (what the app calls) and `eth-api.infinifi.xyz/api` serve identical data. Outside `/api/*`, both hosts show a Cloudflare browser challenge.

| Ours | infiniFi |
|---|---|
| overview, yields, farms, farm, params | `GET /protocol/data` (one 30 KB payload, shared) |
| redemption-queue | `GET /protocol/redemptions/` |
| redemption-quote | `GET /simulate/redemptions?amount=` |
| allocation-votes, wallet/votes | `GET /protocol/votes/{epoch}[/{addr}]` |
| opportunities | `GET /points/integrations` |
| wallet/pnl | `GET /protocol/pnl/{addr}` |
| wallet/history | `GET /protocol/user-history/{tvl\|pnl}/{addr}?daysAgo=` |
| wallet/unwinding | `GET /protocol/unwinding/{addr}` |
| wallet/redemptions | `GET /protocol/redemptions/{addr}` |
| wallet/points | `GET /points/v2/user/{addr}` |
| wallet | five of the wallet calls, in parallel |

What the reshaping does, and nothing more: snake_case names, numbers instead of fixed-point strings, chain names instead of `MAINNET`/`BASE`/`MONAD`, ISO timestamps, a numeric farm APY where infiniFi sometimes sends a string, absolute links where infiniFi sends app paths, farm names joined onto vote rows, and an `empty` flag on lock tiers holding less than `IF_EMPTY_TIER_IUSD` (several hold only a ~1 iUSD placeholder deposit).

## Design notes

- **Pass-through only.** infiniFi's write endpoints (points sign-up and registration, which need a wallet signature) are left out. So are transaction-building features. Prefilled action links are a courtesy we will add once `app.infinifi.xyz` reads amounts from its URL. Today it reads only `?ref=` and sends `/deposit?amount=…` back to `/` with an empty form.
- **The current epoch is inferred.** infiniFi has no endpoint for it. The votes endpoint accepts only the current epoch and its neighbours, and its out-of-range error names the current one, so the backend asks for a far-future epoch and reads the number (cached 10 minutes). If infiniFi changes that message, `/v1/allocation-votes` without an `epoch` fails with a 503, while explicit epochs keep working. Ask infiniFi for a proper endpoint.
- **`days: "all"`** maps to infiniFi's `daysAgo=0`, which is the wallet's full history as a weekly series, not today.
- **Cache.** `/protocol/data` and the redemption queue are cached 60 s, votes and opportunities 300 s, all shared by every caller and with concurrent misses collapsed into one call. Wallet reads are never cached. If infiniFi is unreachable, a cached copy up to 15 minutes old is served with `stale: true`; past that, or for wallet reads, the relay gets a 503 `upstream_unavailable`.
- **Status codes.** Bad input is 400. infiniFi refusing the input (an epoch out of range, an unknown farm) is 422. Only an infiniFi outage with no cached copy is a 5xx, which leaves the relay unpaid; that is correct, since nothing was delivered.
- **One price for every endpoint.** Pocket prices per relay per service, so `/v1/wallet` (five upstream calls) costs the caller the same as `/v1/params`. That is fine at infiniFi's speed, and the per-part wallet endpoints remain for callers that need only one part.
- **No rate limits observed.** infiniFi sends no rate-limit headers, and 30 back-to-back requests all succeeded. The shared cache keeps a supplier's load on infiniFi near one protocol call a minute, regardless of relay volume.

## Configuration

`IF_*` environment variables, all optional (see `backend/config.js`): `IF_UPSTREAM_BASE`, `IF_APP_BASE`, `IF_UPSTREAM_DEADLINE_MS` (8000), `IF_PROTOCOL_TTL_MS` (60000), `IF_SLOW_TTL_MS` (300000), `IF_STALE_MAX_MS` (900000), `IF_EPOCH_TTL_MS` (600000), `IF_EMPTY_TIER_IUSD` (100), `IF_MAX_BODY_BYTES` (16384). No key is needed; the infiniFi API is public.

## Run and test

```bash
cd backend
npm test          # offline: a mock upstream serves real infiniFi payloads from test/fixtures/
node server.js    # live, on :8080 (PORT to change)
```

Then, against the running backend, the Skill's linter:

```bash
python <service-builder>/skills/pocket-service-builder/scripts/lint_backend.py --base-url http://127.0.0.1:8080 --card infinifi/card.json
```

## Deploy

`deploy/docker-compose.yaml` starts only the backend on the supplier's `pocket-supplier` network. `deploy/relayer-service.yaml` is the relayer block, and `deploy/add-to-relayer.sh` merges it into a network's relayer config. `deploy/rendered/` holds the Skill's rendered stake configs, SAGE entry, and health-check entry. `deploy/relay-test.sh` sends relays through the protocol with pocket-ap. It takes the application key only from `POCKET_APP_PRIVATE_KEY` or `deploy/app-key.hex`, as exported by the Service Manager; there is no keyring fallback. Registration, staking, and deployment are done in the Pocket Service Manager.
