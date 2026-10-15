// Configuration for the infinifi backend. Every knob is an IF_* environment
// variable so an operator can tune the service without editing code.
//
// The service is a pass-through: every answer is read from the infiniFi
// protocol API at request time. The only state is a short in-memory cache for
// the protocol-wide reads, which are identical for every caller.

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (v, d) => (v === undefined || v === "" ? d : String(v));

export const config = Object.freeze({
  service: "infinifi",
  version: "1.0.0",
  port: num(process.env.PORT, 8080),

  // --- upstream ---------------------------------------------------------
  // api.infinifi.xyz is what app.infinifi.xyz itself calls; eth-api.infinifi.xyz
  // serves the same data. Only /api/* passes the Cloudflare challenge for a
  // non-browser client, so the base must end in /api.
  upstreamBase: str(process.env.IF_UPSTREAM_BASE, "https://api.infinifi.xyz/api").replace(/\/+$/, ""),
  // Links in responses are built against the app's origin.
  appBase: str(process.env.IF_APP_BASE, "https://app.infinifi.xyz").replace(/\/+$/, ""),
  // Well inside the gateways' relay deadline (10 to 30 s), so a slow upstream
  // fails cleanly instead of as a dropped relay.
  upstreamDeadlineMs: num(process.env.IF_UPSTREAM_DEADLINE_MS, 8000),

  // --- cache --------------------------------------------------------------
  // Protocol-wide reads are cached briefly and shared by every caller. Wallet
  // reads are never cached. When upstream fails, a cached copy younger than
  // staleMaxMs is served with stale: true rather than failing the relay.
  protocolTtlMs: num(process.env.IF_PROTOCOL_TTL_MS, 60_000),
  slowTtlMs: num(process.env.IF_SLOW_TTL_MS, 300_000),
  staleMaxMs: num(process.env.IF_STALE_MAX_MS, 15 * 60_000),
  // infiniFi has no "current epoch" endpoint; the value is learned from the
  // votes endpoint and held this long.
  epochTtlMs: num(process.env.IF_EPOCH_TTL_MS, 10 * 60_000),

  // --- shaping ------------------------------------------------------------
  // A lock tier holding less than this many iUSD is flagged empty: several tiers
  // hold only the ~1 iUSD placeholder deposit made when the tier was created.
  emptyTierIusd: num(process.env.IF_EMPTY_TIER_IUSD, 100),

  // --- request limits -----------------------------------------------------
  maxBodyBytes: num(process.env.IF_MAX_BODY_BYTES, 16 * 1024),
});
