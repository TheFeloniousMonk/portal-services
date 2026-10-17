# PumpCheck (`pump-check`)

What can go wrong with a memecoin, as of now, on **Solana, Base and Robinhood Chain**. An agent sends up to ten tokens and gets back, for each one, the facts read from chain at a named block or slot, a verdict built only from the checks that ran, and plain-language flags it can show a person or act on.

Every check says whether it is **definitive** (read straight from chain state) or **heuristic** (a strong signal that can be wrong), whether it was read **live** for this request or **stored**, and the block or slot it used. A check that could not run says `unknown`; it is never counted as a pass. The service never signs, prepares or submits a transaction. **Not financial advice.**

Service ID: `pump-check` · `rpc_type: REST` · `compute_units_per_relay: 100000` · `results: variable`

## Endpoints

Every response, errors included, is a JSON object. Inputs are a JSON body.

| Method | Path | What |
|---|---|---|
| POST | `/v1/check` | Check 1 to 10 tokens |
| POST | `/v1/recent` | The newest checked tokens on a chain, from the store, filterable by verdict and liquidity |
| GET | `/v1/capabilities` | Chains, checks, thresholds, limits, and the live state of ingest, credits and RPC endpoints |
| GET | `/v1/version` | Identity |
| GET | `/healthz` | Readiness: an ingest completed in the last 10 minutes and at least one chain's RPC answers |
| GET | `/v1/openapi.json` | The OpenAPI document |

```json
POST /v1/check
{ "tokens": [ { "chain": "solana", "address": "2FcRrTiT3i25mRb1emE9TA7jNj3VwLgUHi1pyo39pump" },
              { "chain": "base",   "address": "0xd7da87d7dfe7524a72dc1b5930fc611836c39be2" } ],
  "detail": "standard" }
```

`chain` is `solana`, `base` or `robinhood`. `detail: "full"` adds each check's evidence (the probe's venue and amounts, top holders, early buyers) and the RPC endpoint that answered.

A real result for that Base token, recorded on 2026-10-16 (trimmed to two of its fifteen checks):

```json
{
  "chain": "base", "address": "0xd7da87d7dfe7524a72dc1b5930fc611836c39be2", "found": true, "known_asset": false,
  "verdict": "danger",
  "flags": [
    { "id": "honeypot", "severity": "critical", "method": "definitive", "reason": "selling the tokens just bought reverted" },
    { "id": "lp_status", "severity": "warning", "method": "definitive", "reason": "most of the pool's LP tokens are neither burned nor in a known locker" }
  ],
  "token": { "name": "KOLECT", "symbol": "KOLECT", "decimals": 18, "supply": 49999999999.99999, "created_at": "2026-10-14T13:59:33Z", "launchpad": null },
  "market": { "liquidity_usd": 292882.57, "volume_usd_24h": 668441.19, "txns_24h": 2016 },
  "checks": {
    "honeypot": { "result": "fail", "value": { "can_buy": true, "can_sell": false, "buy_tax_pct": 0, "sell_tax_pct": null, "error": "transfer failed" },
                  "method": "definitive", "source": "stored", "as_of": { "block": 52698830 } },
    "proxy":    { "result": "pass", "value": { "upgradeable": false }, "method": "definitive", "source": "live", "as_of": { "block": 52698832 } }
  }
}
```

### Verdict

| Verdict | Rule |
|---|---|
| `danger` | A critical check failed |
| `caution` | No critical failure, at least one warning |
| `ok` | Every critical check ran and passed, and no warnings |
| `unknown` | A critical check could not run, and nothing failed |

**Critical:** cannot sell; sell tax at or above 25%; freeze authority set; mint authority set; a Token-2022 permanent delegate, frozen default state, pause or non-transferable flag; an unrecognized transfer hook; an upgradeable proxy whose admin is not renounced; an owner that has not renounced *and* can mint, blacklist or pause.

**Warning:** buy or sell tax from 5% to 25%; mutable metadata; LP neither burned nor locked; top 10 holders above 50%; creator or deployer holding above 10%; total liquidity under $10,000; early buyers taking more than 20% of supply; an owner that has not renounced.

**Info:** less than an hour old; still on a launchpad curve.

Stablecoins, majors and issuer-controlled assets (USDC, wrapped SOL and ETH, Robinhood Chain's tokenized stocks) keep their authorities on purpose. They are marked `known_asset: true` with verdict `ok`; their checks are still reported, and their flags are `info`.

`result` is one of `pass`, `fail`, `warn`, `info`, `unknown` (the check exists but could not run this time), `not_applicable` (it does not apply to this token) or `not_available` (this service does not offer it on this chain). Only `unknown` on a critical check makes a verdict `unknown`.

## Checks

### Solana

| Check | How | Method |
|---|---|---|
| `mint_authority`, `freeze_authority` | The mint account, read live | definitive |
| `token2022_extensions` | Transfer fee (exact basis points), permanent delegate, default frozen state, non-transferable, pausable, mint close authority | definitive |
| `transfer_hook` | A hook program runs on every transfer; present or absent is definitive | definitive presence |
| `metadata_mutable` | Token-2022 metadata in the mint (Pump.fun's own tokens), else the Metaplex metadata account | definitive |
| `launch_state` | The Pump.fun bonding curve: still on it, or migrated | definitive |
| `creator_holding` | What the Pump.fun creator's token account still holds | definitive |
| `lp_status` | Pump.fun curve (no withdrawal path), or PumpSwap LP minted against LP burned | definitive |
| `liquidity`, `age` | From the store (DexPaprika) | definitive |
| `holder_concentration`, `snipers_bundles` | `not_available`: no free source serves Solana holder lists or launch transactions reliably | n/a |

On Solana, whether a token can be sold is decided by the authority and extension checks: a classic SPL token with no freeze authority cannot stop a transfer, and a Token-2022 mint can only through a hook, a permanent delegate, a frozen default state or a pause. No swap simulation is needed.

### Base and Robinhood Chain

| Check | How | Method |
|---|---|---|
| `is_contract` | Code at the address | definitive |
| `proxy` | EIP-1967 implementation, admin and beacon slots, EIP-1822, minimal proxies; then who controls upgrades | definitive |
| `owner` | `owner()` or `getOwner()`; zero or a burn address is renounced | definitive |
| `privileged_functions` | Mint, blacklist, pause, fee and max-transaction selectors in the runtime bytecode | heuristic |
| `honeypot`, `buy_tax`, `sell_tax` | A simulated buy and sell (below) | definitive at that block |
| `launch_state` | Pons: curve or graduated, the curve's fee and creator tax, the snipe tax, and whether sells are paused for graduation | definitive |
| `lp_status` | v2-style pairs: LP burned or in a known locker. Pons and launchpad pools: locked by design. Other v3/v4 positions: not read in v1 (`unknown`) | definitive / heuristic |
| `holder_concentration` | Blockscout PRO API, excluding pools, the v4 PoolManager, the Pons curve, burn addresses and lockers | definitive as of Blockscout's index |
| `deployer`, `creator_holding` | The sender of the token's creation transaction (found through Blockscout, or the Pons launch record), and its balance now; a token made through a launchpad or a CREATE2 deployer also names that contract as `created_through` | definitive |
| `snipers_bundles` | Swaps in the first 6 seconds of the pool, buyers resolved to the transaction sender | definitive buyers, heuristic bundles |
| `liquidity`, `age` | From the store | definitive |

**The honeypot probe.** A small contract, never deployed, is placed at a fixed address with an `eth_call` state override, and the caller is given a balance with another. One call buys about $5 of the token through its own pool and sells all of it back, and reports what each leg actually received. A sell that reverts right after the buy is re-run as a holder selling an existing balance, which separates a honeypot from a token that only blocks a sell in the buy's block. Venues: Uniswap v2, v3 and v4 (including hooked pools) on both chains, the Pons bonding curve, Aerodrome and Slipstream on Base. A token whose only pools are elsewhere gets `honeypot: unknown`. `round_trip_loss_pct` includes pool fees, hook fees and launchpad curve fees, which are not token taxes. Source: [`probe/Probe.sol`](probe/Probe.sol).

**Pons (Robinhood Chain).** Recognized on chain from the Pons V2 factory, without Blockscout. Pons tokens are fixed-supply ERC-20s with no owner; their risks sit in the curve (a fee plus the creator's tax, capped at 20% together), the snipe tax in a token's first seconds, a window before graduation when sells revert, and the meme hook on the graduated Uniswap v4 pool, whose fee the probe measures. Launches are read from the factory's events, so tokens still on their curve are covered before any DEX lists them.

## How it works

1. **Ingest.** Every 2 minutes, the newest pools on each chain from DexPaprika's list endpoints (one credit a page, however many rows), plus Pons launches from the factory's logs (free). New tokens join a queue, most active first.
2. **Precompute.** A worker reads everything that never changes and a first reading of what can flip, through Pocket's public RPC only, and stores it with the block or slot it was read at. When Pocket is down the token waits; ingest volume never moves onto the backup endpoints.
3. **Enrich.** Blockscout answers in 3 to 10 seconds, so holders and the deployer are read by a separate queue, one token at a time, tokens someone asked about first, then the most active. Until a token's turn comes, those checks say they are queued (`unknown`, never critical), and a check a minute later has them.
4. **Check.** A request is answered from the store plus a few live reads: what can flip (authorities, owner, proxy admin) is re-read at the request's block or slot, and the honeypot simulation is redone when the stored one is older than two minutes. A token the store has never seen is found and checked on demand.

**RPC.** Each chain has three endpoints, Pocket's public gateway first. A request-time call moves to the next on a network error, a 4-second deadline, HTTP 429 or 5xx, or an "unsupported" error; a revert is an answer, never retried. An endpoint failing 5 calls in a row is skipped for 60 seconds, and one more than 20 blocks (50 slots) behind the best is treated as down. `/v1/capabilities` shows each endpoint's state.

**Budgets.** DexPaprika: a ledger counts credits per hour over a rolling 30 days and stops at 95,000 (5% under the free key's 100,000); on-demand lookups are capped at 10 an hour. Blockscout: a holder list and an address lookup per EVM token, once, about 20 credits each (measured 2026-10-17 from the API's `x-credits-remaining` header), against the free plan's 100,000 a day; calls stop when fewer than 5,000 remain (`PUMP_BLOCKSCOUT_RESERVE`).

**Store.** SQLite on the container's `/data` volume. Tokens with no ingest activity for 7 days are deleted.

## For suppliers

Every supplier brings **two free keys of its own**. No key ships in this repository or the image, and callers never send one.

| Setting | Where to get it | Without it |
|---|---|---|
| `PUMP_DEXPAPRIKA_API_KEY` | <https://console.dexpaprika.com> (free, no card) | The keyless tier: 10,000 credits per 30 days per IP, so far fewer new tokens are ingested |
| `PUMP_BLOCKSCOUT_API_KEY` | <https://dev.blockscout.com> (PRO API) | `holder_concentration`, `deployer` and `creator_holding` on Base and Robinhood Chain read `not_available` (never `unknown`, so verdicts are unaffected) |

**Blockscout's free plan covers Robinhood Chain but not Base.** Since 2026-10-01 Base needs the Builder plan or above; on a free key Blockscout answers Base requests with a 402, and the service reports those three checks on Base as `not_available` with that reason. `/v1/capabilities` lists any chain the key's plan excludes under `blockscout.chains_not_in_plan`.

**With the Pocket Service Manager:** Services, Service settings for `pump-check` shows a form for both keys (secrets appear only as set or not set) and offers Restart now. **Without it:** on the server, `install -m 600 /dev/null /opt/pocket/services/pump-check/settings.env`, add one `NAME='value'` line per key, and recreate the container (`docker compose -p pump-check up -d --no-build --force-recreate` in `deploy/`).

Resources: 1 GB of RAM (the container is capped at 512 MB), 2 GB of disk for the store, outbound HTTPS to the RPC endpoints, `api.dexpaprika.com` and `api.blockscout.com`. RPC volume is high: each new token costs about 4 (Solana) or 6 to 10 (EVM) calls on Pocket's gateway.

Deploy files are in [`deploy/`](deploy/): the compose file, the relayer block and `add-to-relayer.sh`, `settings.json` (the two settings above), `relay-test.sh`, and the Skill's rendered stake, SAGE and health-check configs in `rendered/`. Gateway operators: type `passthrough`, `rpc_types: ["rest"]`, `relay_timeout` of at least 15 s ([`deploy/rendered/sage-service.yaml`](deploy/rendered/sage-service.yaml)).

## Configuration

Every knob is a `PUMP_*` environment variable with a default in [`backend/config.js`](backend/config.js): the RPC endpoint lists (`PUMP_RPC_SOLANA`, `PUMP_RPC_BASE`, `PUMP_RPC_ROBINHOOD`, comma-separated in failover order, each optionally `#logs=N` for its largest log range), deadlines, ingest cadence and pages per chain, the credit ceiling and fallback cap, retention, the sniper window, and every verdict threshold.

## Development

```bash
cd backend
npm ci
npm test            # 32 tests, offline: a recorded live session is replayed
node server.js      # live, on :8080 (PORT to change; PUMP_DATA_DIR for the store)
```

`node test/capture.mjs` re-records the session from live chains (without keys set). The probe is rebuilt with `cd probe && npm install && npm run build`, which writes `backend/probe-artifact.json`; the image never compiles.

Sources for every address the service relies on (Uniswap's deployments feed, Pons's verified contracts on Sourcify, Clanker's published list, symbols read on chain) are in [`backend/chains.js`](backend/chains.js).
