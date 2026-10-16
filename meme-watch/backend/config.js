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

export const PUBLIC_HOST = "https://api.dexpaprika.com";
export const PRO_HOST = "https://api-pro.dexpaprika.com";

// Which DexPaprika plan the key belongs to, because the plan decides the host
// (docs.dexpaprika.com/api-pro/introduction):
//   keyless  no key: the public host, 10,000 credits per 30 days per IP.
//   free     a free key: still the public host, where the key raises the
//            allowance to 100,000 credits. api-pro refuses a free key with a
//            403 `wrong_host`.
//   paid     Dev, Pro or Enterprise: api-pro. Set MW_MONTHLY_CREDITS to the
//            plan's allowance; the default stays at the free-key ceiling.
const planSetting = str(process.env.MW_DEXPAPRIKA_PLAN, "free").toLowerCase();
const plan = !hasKey ? "keyless" : planSetting === "paid" ? "paid" : "free";

export const config = Object.freeze({
  service: "meme-watch",
  version: "1.0.1",
  port: num(process.env.PORT, 8080),

  // --- upstream ---------------------------------------------------------
  apiKey,
  hasKey,
  plan,
  // Set but not one of the known values; reported at startup.
  planSettingUnknown: hasKey && !["free", "paid"].includes(planSetting) ? planSetting : null,
  baseUrl: str(process.env.MW_DEXPAPRIKA_BASE_URL, plan === "paid" ? PRO_HOST : PUBLIC_HOST),
  // DexPaprika takes the key as the whole Authorization header value, with no
  // scheme word. 1.0.0 sent X-Api-Key, which both hosts ignore: api-pro answered
  // with a Cloudflare block page and the public host served the keyless tier.
  // /v1/capabilities reports the plan the API says it applied (its X-Api-Plan
  // response header), so a header problem shows up there on first run.
  authHeader: str(process.env.MW_DEXPAPRIKA_AUTH_HEADER, "Authorization"),
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
  // 5% under the published allowance so a miscount never spends into an overage:
  // 100,000 with a key, 10,000 per 30 days per IP without one.
  monthlyCredits: num(process.env.MW_MONTHLY_CREDITS, hasKey ? 95000 : 9500),

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
