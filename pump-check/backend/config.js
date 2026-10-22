// Configuration for the pump-check backend. Every knob is a PUMP_* environment
// variable so an operator can tune the service without editing code.
//
// Two budgets bind this service: DexPaprika credits (100,000 per rolling 30
// days on a free key, enforced by the ledger in dexpaprika.js) and RPC volume
// on Pocket's public gateway (allowlisted for this service). Ingest spends the
// first; precompute and checks spend the second.

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined || v === "" ? d : /^(1|true|yes|on)$/i.test(String(v)));
const str = (v, d) => (v === undefined || v === "" ? d : String(v));

export const PUBLIC_HOST = "https://api.dexpaprika.com";
export const PRO_HOST = "https://api-pro.dexpaprika.com";

const dexpaprikaKey = str(process.env.PUMP_DEXPAPRIKA_API_KEY, "");
const planSetting = str(process.env.PUMP_DEXPAPRIKA_PLAN, "free").toLowerCase();
// keyless: public host, 10,000 credits per 30 days per IP. free: public host,
// 100,000. paid: api-pro (a free key there is refused with 403 wrong_host).
const plan = !dexpaprikaKey ? "keyless" : planSetting === "paid" ? "paid" : "free";

// Endpoints per chain, in failover order. Pocket first; the others are for
// outages (SPEC section 7). An entry may carry its largest log range as
// "#logs=N".
const DEFAULT_RPC = {
  solana: "https://solana.api.pocket.network,https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com",
  base: "https://base.api.pocket.network,https://base-rpc.publicnode.com,https://base.drpc.org#logs=10",
  robinhood:
    "https://robinhood.api.pocket.network,https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com#logs=10",
};

export function parseEndpoints(list) {
  return String(list)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [url, frag = ""] = entry.split("#");
      const m = /logs=(\d+)/.exec(frag);
      return { url, maxLogRange: m ? Number(m[1]) : null };
    });
}

export const CHAINS = Object.freeze(["solana", "base", "robinhood"]);

export const config = Object.freeze({
  service: "pump-check",
  version: "1.1.1",
  port: num(process.env.PORT, 8080),
  dataDir: str(process.env.PUMP_DATA_DIR, "/data"),

  // --- DexPaprika ---------------------------------------------------------
  dexpaprikaKey,
  plan,
  planSettingUnknown: dexpaprikaKey && !["free", "paid"].includes(planSetting) ? planSetting : null,
  dexpaprikaBase: str(process.env.PUMP_DEXPAPRIKA_BASE_URL, plan === "paid" ? PRO_HOST : PUBLIC_HOST),
  dexpaprikaDeadlineMs: num(process.env.PUMP_DEXPAPRIKA_DEADLINE_MS, 10000),
  // The free tier allows 30 requests a minute; 2.1 s between calls stays under it.
  dexpaprikaSpacingMs: num(process.env.PUMP_DEXPAPRIKA_SPACING_MS, 2100),
  // 5% under the published allowance, counted over a rolling 30 days.
  monthlyCredits: num(process.env.PUMP_MONTHLY_CREDITS, dexpaprikaKey ? 95000 : 9500),
  fallbackCreditsPerHour: num(process.env.PUMP_FALLBACK_CREDITS_PER_HOUR, 10),

  // --- Blockscout PRO API (EVM holders and deployer) ------------------------
  blockscoutKey: str(process.env.PUMP_BLOCKSCOUT_API_KEY, ""),
  blockscoutBase: str(process.env.PUMP_BLOCKSCOUT_BASE_URL, "https://api.blockscout.com"),
  // Address lookups took up to 10.5 s on 2026-10-17; they run off the request path.
  blockscoutDeadlineMs: num(process.env.PUMP_BLOCKSCOUT_DEADLINE_MS, 20000),
  // The free plan allows 5 requests a second.
  blockscoutSpacingMs: num(process.env.PUMP_BLOCKSCOUT_SPACING_MS, 220),
  // Stop calling when fewer daily credits than this remain.
  blockscoutReserve: num(process.env.PUMP_BLOCKSCOUT_RESERVE, 5000),

  // --- RPC ---------------------------------------------------------------
  rpc: Object.freeze({
    solana: parseEndpoints(str(process.env.PUMP_RPC_SOLANA, DEFAULT_RPC.solana)),
    base: parseEndpoints(str(process.env.PUMP_RPC_BASE, DEFAULT_RPC.base)),
    robinhood: parseEndpoints(str(process.env.PUMP_RPC_ROBINHOOD, DEFAULT_RPC.robinhood)),
  }),
  rpcDeadlineMs: num(process.env.PUMP_RPC_DEADLINE_MS, 4000),
  rpcMaxLag: num(process.env.PUMP_RPC_MAX_LAG, 20),
  rpcMaxLagSlots: num(process.env.PUMP_RPC_MAX_LAG_SLOTS, 50),
  logPageBlocks: num(process.env.PUMP_LOG_PAGE_BLOCKS, 1000),
  breakerFailures: num(process.env.PUMP_RPC_BREAKER_FAILURES, 5),
  breakerCooldownMs: num(process.env.PUMP_RPC_BREAKER_COOLDOWN_MS, 60000),

  // --- ingest and precompute -----------------------------------------------
  ingestIntervalMs: num(process.env.PUMP_INGEST_INTERVAL_MS, 120000),
  pages: Object.freeze({
    solana: num(process.env.PUMP_PAGES_SOLANA, 2),
    base: num(process.env.PUMP_PAGES_BASE, 1),
    robinhood: num(process.env.PUMP_PAGES_ROBINHOOD, 1),
  }),
  // Pons launches are read from the factory's logs, which costs no credits.
  ponsIngest: bool(process.env.PUMP_PONS_INGEST, true),
  precomputeConcurrency: num(process.env.PUMP_PRECOMPUTE_CONCURRENCY, 4),
  // Background enrichment (on-chain deployer, holders): about 30 calls a token.
  enrichConcurrency: num(process.env.PUMP_ENRICH_CONCURRENCY, 3),
  // Precompute waits and retries Pocket rather than spilling ingest volume
  // onto the free backup endpoints.
  precomputeRetryMs: num(process.env.PUMP_PRECOMPUTE_RETRY_MS, 30000),
  maxQueue: num(process.env.PUMP_MAX_QUEUE, 5000),
  retentionDays: num(process.env.PUMP_RETENTION_DAYS, 7),
  // Sniper analysis looks at buys in this window after the pool opened.
  // Seconds, not blocks: Robinhood Chain makes about ten blocks a second.
  sniperWindowSeconds: num(process.env.PUMP_SNIPER_WINDOW_SECONDS, 6),

  // --- holder index (Transfer events, for chains Blockscout's plan excludes) ---
  // Base by default: Blockscout's free plan has not covered it since 2026-10-01.
  indexChains: str(process.env.PUMP_INDEX_CHAINS, "base")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  indexIntervalMs: num(process.env.PUMP_INDEX_INTERVAL_MS, 15000),
  // Addresses per eth_getLogs while following; split further when a node refuses.
  indexBatch: num(process.env.PUMP_INDEX_BATCH, 100),
  indexFollowPagesPerTick: num(process.env.PUMP_INDEX_FOLLOW_PAGES, 4),
  indexBackfillTokensPerTick: num(process.env.PUMP_INDEX_BACKFILL_TOKENS, 8),
  indexBackfillPagesPerTick: num(process.env.PUMP_INDEX_BACKFILL_PAGES, 10),
  // A token's history beyond either limit is not indexed (holders read unknown).
  indexMaxTransfers: num(process.env.PUMP_INDEX_MAX_TRANSFERS, 200000),
  indexMaxPages: num(process.env.PUMP_INDEX_MAX_PAGES, 400),
  // The widest single backfill page, in blocks, once pages come back sparse.
  indexMaxSpan: num(process.env.PUMP_INDEX_MAX_SPAN, 64000),

  // --- checks ------------------------------------------------------------
  maxTokens: num(process.env.PUMP_MAX_TOKENS, 10),
  maxRecent: num(process.env.PUMP_MAX_RECENT, 100),
  maxBodyBytes: num(process.env.PUMP_MAX_BODY_BYTES, 16 * 1024),
  // Stored "moves constantly" results older than this are recomputed at check time.
  shelfLifeMs: num(process.env.PUMP_SHELF_LIFE_MS, 120000),
  checkDeadlineMs: num(process.env.PUMP_CHECK_DEADLINE_MS, 11000),
  sellTaxCritical: num(process.env.PUMP_SELL_TAX_CRITICAL, 25),
  taxWarning: num(process.env.PUMP_TAX_WARNING, 5),
  minLiquidityUsd: num(process.env.PUMP_MIN_LIQUIDITY_USD, 10000),
  topHoldersWarnPct: num(process.env.PUMP_TOP_HOLDERS_WARN_PCT, 50),
  creatorHoldingWarnPct: num(process.env.PUMP_CREATOR_HOLDING_WARN_PCT, 10),
  sniperWarnPct: num(process.env.PUMP_SNIPER_WARN_PCT, 20),
  splitMinTxns: num(process.env.PUMP_SPLIT_MIN_TXNS, 20),
  // The probe spends this much of the quote asset, in USD, on its simulated buy.
  probeUsd: num(process.env.PUMP_PROBE_USD, 5),

  ingestOnStart: bool(process.env.PUMP_INGEST_ON_START, true),

  // --- peer sync (peer/) ---------------------------------------------------
  // Nodes behind the suppliers staked for pump-check share what never changes
  // and holder snapshots, each checked against the chain on arrival.
  peerEnabled: bool(process.env.PUMP_PEER, true),
  // Its own port, routed by Caddy at /pump-check-peer; never the relay port.
  peerPort: num(process.env.PUMP_PEER_PORT, 8090),
  // Extra peers by hand, for development: "n_<node key>@<url>, ...".
  peers: str(process.env.PUMP_PEERS, ""),
  // The Pocket networks whose pump-check suppliers are peers ("" for none).
  peerNetworks: str(process.env.PUMP_PEER_NETWORKS, "main,beta")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  peerDiscoveryIntervalMs: num(process.env.PUMP_PEER_DISCOVERY_INTERVAL_MS, 30 * 60000),
  peerSyncIntervalMs: num(process.env.PUMP_PEER_SYNC_INTERVAL_MS, 5 * 60000),
  peerTimeoutMs: num(process.env.PUMP_PEER_TIMEOUT_MS, 20000),
  peerTokensPerPull: num(process.env.PUMP_PEER_TOKENS_PER_PULL, 200),
  // A snapshot is asked for only when the backfill is this many blocks behind
  // (about 11 hours of Base), a few tokens per tick.
  peerSnapshotMinBlocks: num(process.env.PUMP_PEER_SNAPSHOT_MIN_BLOCKS, 20000),
  peerSnapshotsPerTick: num(process.env.PUMP_PEER_SNAPSHOTS_PER_TICK, 2),
  peerMaxHolders: num(process.env.PUMP_PEER_MAX_HOLDERS, 20000),
  peerAdoptWaitMs: num(process.env.PUMP_PEER_ADOPT_WAIT_MS, 5000),
});
