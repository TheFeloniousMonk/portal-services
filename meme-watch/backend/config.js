// Configuration for the meme-watch backend. Every knob is an MW_* environment
// variable so an operator can tune the service without editing code.
//
// The upstream credit budget is the binding constraint on this service, not CPU
// or memory. A DexPaprika free key allows 100,000 credits a month. A 120 s poll
// is 21,600 polls a month, which leaves ~4.6 upstream calls per poll. The
// governor in dexpaprika.js enforces that ceiling; these defaults sit under it.

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const str = (v, d) => (v === undefined || v === "" ? d : String(v));

const apiKey = str(process.env.MW_DEXPAPRIKA_API_KEY, "");
const hasKey = apiKey.length > 0;

export const config = Object.freeze({
  service: "meme-watch",
  version: "1.0.0",
  port: num(process.env.PORT, 8080),

  // --- upstream ---------------------------------------------------------
  apiKey,
  hasKey,
  // The spec documents an authenticated host but not the header name. Both are
  // configurable, and /v1/capabilities reports the plan the API says it applied
  // (its X-Api-Plan response header) so a wrong header shows up on first run
  // instead of silently degrading to the keyless tier.
  baseUrl: str(process.env.MW_DEXPAPRIKA_BASE_URL, hasKey ? "https://api-pro.dexpaprika.com" : "https://api.dexpaprika.com"),
  authHeader: str(process.env.MW_DEXPAPRIKA_AUTH_HEADER, "X-Api-Key"),
  chain: str(process.env.MW_CHAIN, "solana"),
  fetchDeadlineMs: num(process.env.MW_FETCH_DEADLINE_MS, 10000),
  callSpacingMs: num(process.env.MW_CALL_SPACING_MS, 300),

  // --- window and cadence ----------------------------------------------
  windowMinutes: num(process.env.MW_WINDOW_MINUTES, 60),
  pollIntervalMs: num(process.env.MW_POLL_INTERVAL_MS, 120000),
  // How far behind live the upstream index is assumed to run. Rows newer than
  // this are reported but the window is only declared complete up to it, so a
  // consumer can tell "nothing launched" apart from "not indexed yet".
  indexLagSeconds: num(process.env.MW_INDEX_LAG_SECONDS, 120),

  // --- budget governor --------------------------------------------------
  maxCallsPerPoll: num(process.env.MW_MAX_CALLS_PER_POLL, 4),
  maxListPages: num(process.env.MW_MAX_LIST_PAGES, 2),
  // 5% under the published allowance so a miscount never spends into an overage.
  monthlyCredits: num(process.env.MW_MONTHLY_CREDITS, hasKey ? 95000 : 28000),

  // A cold start finds a full hour of launches at once and can only name a few
  // per poll, so the window would take hours to fill on the steady-state rate.
  // This is a one-time pool of extra enrichment calls, spent only while the
  // backlog is draining. At 60 calls it is well under 0.1% of the month.
  coldStartExtraCalls: num(process.env.MW_COLDSTART_EXTRA_CALLS, 60),
  coldStartPerPoll: num(process.env.MW_COLDSTART_PER_POLL, 10),

  // --- upstream traction gate ------------------------------------------
  // Applied at the API, and the real editorial decision in this service. The
  // budget allows roughly three enrichments per poll, so about 90 new launches
  // an hour can be named. The gate has to admit fewer than that or the pending
  // queue grows until entries age out unseen.
  //
  // Measured on Solana on 2026-09-20 over a 60-minute window:
  //   volume >= $5k / $10k / $20k   over 100 launches an hour, more pages
  //   volume >= $50k + 100 txns     61 launches an hour, one page
  //
  // So $50k is the point where arrivals fit both the page budget and the
  // enrichment budget. Lowering it needs a paid upstream key, not just a
  // config change; raising it narrows the feed to the strongest launches.
  gateMinTxns: num(process.env.MW_GATE_MIN_TXNS, 100),
  gateMinVolumeUsd: num(process.env.MW_GATE_MIN_VOLUME_USD, 50000),

  // --- store ------------------------------------------------------------
  dataDir: str(process.env.MW_DATA_DIR, "/data"),
  csvName: str(process.env.MW_CSV_NAME, "launches.csv"),

  // --- request limits ---------------------------------------------------
  maxBodyBytes: num(process.env.MW_MAX_BODY_BYTES, 64 * 1024),
  defaultLimit: num(process.env.MW_DEFAULT_LIMIT, 100),
  maxLimit: num(process.env.MW_MAX_LIMIT, 500),

  pollOnStart: bool(process.env.MW_POLL_ON_START, true),
});

export const KNOWN_DEXES = Object.freeze([
  "pumpfun",
  "pumpswap",
  "meteora_daam_v2",
  "meteora_dbc",
  "meteora",
  "raydium",
  "raydium_clmm",
  "orca",
  "manifest",
]);
