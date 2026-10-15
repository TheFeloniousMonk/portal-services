// infinifi backend for Pocket Network: a read-only pass-through to the infiniFi
// protocol API (api.infinifi.xyz), reshaped for agents.
//
// HTTP contract (every response is a JSON object, including errors; see the
// Skill's references/design-rules.md):
//   GET|HEAD /            -> {service, status}       RelayMiner reachability ping
//   GET  /healthz         -> {status}                readiness (ok while upstream answers)
//   GET  /v1/version      -> {service, version}      identity probe
//   GET  /v1/capabilities -> endpoints, limits, cache, upstream state
//   GET  /v1/openapi.json -> the OpenAPI document
//   POST /v1/<endpoint>   -> one data endpoint per ENDPOINTS entry below
//
// Inputs arrive in the POST body, never the query string. Endpoints that take
// no required input also answer GET with their defaults. Nothing here signs,
// prepares, or submits a transaction; links are infiniFi's own pages.

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { Upstream, UpstreamError } from "./upstream.js";
import * as shape from "./shape.js";

const SCHEMA_VERSION = "1";
const SOURCE = "infiniFi protocol API";
const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url));

export const upstream = new Upstream({
  base: config.upstreamBase,
  deadlineMs: config.upstreamDeadlineMs,
  staleMaxMs: config.staleMaxMs,
  epochTtlMs: config.epochTtlMs,
  userAgent: config.service + "/" + config.version + " (Pocket Network service)",
});

// Gateways (SAGE) scan the first 2 KB of a body, raw and case-insensitive, for
// these phrases and treat a match as a failed relay, even inside a JSON string.
// Farm descriptions are upstream prose, so every occurrence is broken by writing
// one letter as a JSON \u escape: the client decodes the identical string, the
// scan no longer matches. See the Skill's references/design-rules.md, rule 6.
const GATEWAY_PHRASES = [
  "offchain rate limit hit by relayer proxy", "session relay limit reached", "claimable portion fully consumed",
  "missing trie node", "node is unhealthy", "block not found", "header not found", "state not available",
  "pruned state", "metadata is not found", "historical state", "state has been pruned", "block has been pruned",
  "is pruned", "height is not available", "lowest height is", "haven't been fully indexed", "not been fully indexed",
  "lite fullnode", "api is not supported", "excluded from account secondary indexes",
  "connection refused", "connection reset", "timeout", "bad gateway", "service unavailable", "gateway timeout",
];
const PHRASE_RES = GATEWAY_PHRASES.map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));

// Only ever applied to JSON.stringify output, where these phrases can occur only
// inside string values (no key or literal contains one), so the escape is valid.
export function escapeGatewayPhrases(json) {
  let out = json;
  for (const re of PHRASE_RES) {
    out = out.replace(re, (m) => m[0] + "\\u" + m.charCodeAt(1).toString(16).padStart(4, "0") + m.slice(2));
  }
  return out;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(escapeGatewayPhrases(JSON.stringify(payload)));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const bad = (message) => new HttpError(400, "invalid_request", message);

function sendError(res, err) {
  const error = { code: err.code, message: err.message };
  if (err.details) error.details = err.details;
  sendJson(res, err.status, { service: config.service, schema_version: SCHEMA_VERSION, error });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // The RelayMiner forwards bodies with Transfer-Encoding: chunked and no
    // Content-Length, so the size is only known as the stream arrives.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "body_too_large", "Request body exceeds " + limit + " bytes."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// --- input validation -------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function address(b) {
  if (typeof b.address !== "string" || !ADDRESS_RE.test(b.address.trim())) {
    throw bad("address must be a 0x-prefixed 40-hex-character wallet address");
  }
  return b.address.trim();
}

function optNumber(b, key, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw bad(key + " must be " + (integer ? "an integer" : "a number") + (Number.isFinite(min) ? " from " + min : "") + (Number.isFinite(max) ? " to " + max : ""));
  }
  return n;
}

function optBool(b, key, dflt) {
  const v = b[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw bad(key + " must be true or false");
  return v;
}

function optEnum(b, key, values) {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).toLowerCase();
  if (!values.includes(s)) throw bad(key + " must be one of: " + values.join(", "));
  return s;
}

function optString(b, key, maxLen = 100) {
  const v = b[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > maxLen) throw bad(key + " must be a string of at most " + maxLen + " characters");
  return v.trim();
}

const CHAINS = ["ethereum", "mainnet", "base", "monad"];
const optChain = (b) => shape.chainFilter(optEnum(b, "chain", CHAINS));

// history `days`: infiniFi accepts 0, 7, 30, 90, 365, where 0 means the
// wallet's full history (a weekly series), not today.
const DAYS = { 7: 7, 30: 30, 90: 90, 365: 365, all: 0 };
function days(b) {
  const v = b.days === undefined || b.days === null ? 30 : b.days;
  const key = String(v).toLowerCase();
  if (!(key in DAYS)) throw bad("days must be one of 7, 30, 90, 365, or \"all\"");
  return { label: key === "all" ? "all" : Number(key), upstream: DAYS[key] };
}

async function epochFrom(b) {
  const e = optNumber(b, "epoch", { min: 0, integer: true });
  return e === null ? upstream.currentEpoch() : e;
}

// An epoch infiniFi refuses gets a message naming the epochs it accepts.
async function votesFor(path, epoch, ttlMs) {
  try {
    return await upstream.get(path, ttlMs);
  } catch (err) {
    if (err instanceof UpstreamError && /^ERR_EPOCH_IN_(PAST|FUTURE)$/.test(err.upstreamCode || "")) {
      const now = await upstream.currentEpoch().catch(() => null);
      const range = now === null ? "" : "; infiniFi accepts " + (now - 1) + " to " + (now + 1) + " (current " + now + ")";
      throw new HttpError(422, "epoch_out_of_range", "epoch " + epoch + " is out of range" + range, { upstream_code: err.upstreamCode });
    }
    throw err;
  }
}

// --- upstream helpers ---------------------------------------------------------

const protocolData = () => upstream.get("/protocol/data", config.protocolTtlMs);
const wallet = (path, addr) => upstream.get(path.replace("{addr}", addr));

// Fold one or more upstream results into the envelope fields: the oldest
// fetch time, and stale if any part was served from cache after a failure.
function meta(...results) {
  const ok = results.filter(Boolean);
  const oldest = ok.reduce((m, r) => Math.min(m, r.fetchedAt), Infinity);
  return {
    source: SOURCE,
    fetched_at: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    stale: ok.some((r) => r.stale),
  };
}

// --- endpoints -------------------------------------------------------------------
// `get: true` means the endpoint has no required input and also answers GET.

const ENDPOINTS = {
  "/v1/overview": {
    get: true,
    summary: "Protocol headline: TVL and its liquid/illiquid split, iUSD and siUSD supply and rates, APYs, lock-tier and farm counts.",
    async run() {
      const pd = await protocolData();
      return { ...meta(pd), ...shape.overview(pd.data, config.emptyTierIusd) };
    },
  },
  "/v1/yields": {
    get: true,
    summary: "siUSD and every liUSD lock tier: exchange rate, 1/7/30-day APY, amount locked, and an empty flag. Filters: min_weeks, max_weeks, include_empty.",
    async run(b) {
      const opts = {
        minWeeks: optNumber(b, "min_weeks", { min: 0, max: 52, integer: true }),
        maxWeeks: optNumber(b, "max_weeks", { min: 0, max: 52, integer: true }),
        includeEmpty: optBool(b, "include_empty", true),
      };
      const pd = await protocolData();
      return { ...meta(pd), empty_tier_threshold_iusd: config.emptyTierIusd, ...shape.yields(pd.data, opts, config.emptyTierIusd) };
    },
  },
  "/v1/farms": {
    get: true,
    summary: "Where infiniFi's USDC is deployed. Filters: chain, type (liquid, illiquid, protocol), include_paused, min_apy; sort: apy or assets.",
    async run(b) {
      const opts = {
        chain: optChain(b),
        type: optEnum(b, "type", ["liquid", "illiquid", "protocol"]),
        includePaused: optBool(b, "include_paused", false),
        minApy: optNumber(b, "min_apy", { min: 0, max: 10 }),
        sort: optEnum(b, "sort", ["apy", "assets"]),
      };
      const pd = await protocolData();
      return { ...meta(pd), ...shape.farms(pd.data, opts) };
    },
  },
  "/v1/farm": {
    summary: "One farm by address, or by name (exact match first, then substring). Returns every match: a name can exist on more than one chain.",
    async run(b) {
      const addr = optString(b, "address", 42);
      const name = optString(b, "name", 100);
      if (!addr && !name) throw bad("provide address or name");
      if (addr && !ADDRESS_RE.test(addr)) throw bad("address must be a 0x-prefixed 40-hex-character address");
      const pd = await protocolData();
      const matches = shape.findFarms(pd.data, { address: addr, name });
      if (!matches.length) throw new HttpError(422, "farm_not_found", "No farm matches " + (addr || JSON.stringify(name)) + "; POST /v1/farms lists them all.");
      return { ...meta(pd), count: matches.length, farms: matches };
    },
  },
  "/v1/params": {
    get: true,
    summary: "Protocol parameters: reserve ratio, illiquid target, return multipliers, per-week bucket multipliers.",
    async run() {
      const pd = await protocolData();
      return { ...meta(pd), ...shape.params(pd.data) };
    },
  },
  "/v1/redemption-queue": {
    get: true,
    summary: "The global iUSD redemption queue: amount waiting, when it is fully funded, tickets.",
    async run() {
      const r = await upstream.get("/protocol/redemptions/", config.protocolTtlMs);
      return { ...meta(r), ...shape.redemptionQueue(r.data) };
    },
  },
  "/v1/redemption-quote": {
    summary: "Whether redeeming amount_iusd now pays out USDC directly or joins the queue, and how much.",
    async run(b) {
      const raw = b.amount_iusd;
      if (raw === undefined || raw === null || raw === "") throw bad("amount_iusd is required (iUSD, as a number or decimal string)");
      const units = shape.toUnits(raw, 18);
      if (units === null || units === "0") throw bad("amount_iusd must be a positive number");
      if (BigInt(units) > 10n ** 36n) throw bad("amount_iusd is too large");
      const r = await upstream.get("/simulate/redemptions?amount=" + units);
      return { ...meta(r), ...shape.redemptionQuote(r.data, Number(shape.fromUnits(units, 18))) };
    },
  },
  "/v1/allocation-votes": {
    get: true,
    summary: "How votes split funds across farms for an epoch (default: current). infiniFi accepts only the current epoch and its neighbours.",
    async run(b) {
      const epoch = await epochFrom(b);
      const [v, pd] = await Promise.all([votesFor("/protocol/votes/" + epoch, epoch, config.slowTtlMs), protocolData().catch(() => null)]);
      return { ...meta(v, pd), ...shape.votes(v.data, shape.farmLabels(pd && pd.data)) };
    },
  },
  "/v1/opportunities": {
    get: true,
    summary: "Partner yield opportunities for infiniFi tokens with APY, TVL, points multipliers, dates, and infiniFi's own link. Filters: chain, protocol, asset.",
    async run(b) {
      const opts = { chain: optChain(b), protocol: optString(b, "protocol", 60), asset: optString(b, "asset", 60) };
      const r = await upstream.get("/points/integrations", config.slowTtlMs);
      const list = [...((r.data && r.data.passiveTasks) || []), ...((r.data && r.data.activeTasks) || [])];
      return { ...meta(r), ...shape.opportunities(list, opts, config.appBase) };
    },
  },

  "/v1/wallet": {
    summary: "One-call wallet summary: current value, profit, unwinding, redemptions, points. Parts infiniFi could not answer are null and named in missing.",
    async run(b) {
      const addr = address(b);
      const parts = {
        value: wallet("/protocol/user-history/tvl/{addr}?daysAgo=7", addr),
        pnl: wallet("/protocol/pnl/{addr}", addr),
        unwinding: wallet("/protocol/unwinding/{addr}", addr),
        redemptions: wallet("/protocol/redemptions/{addr}", addr),
        points: wallet("/points/v2/user/{addr}", addr),
      };
      const keys = Object.keys(parts);
      const settled = await Promise.allSettled(Object.values(parts));
      const got = {};
      const missing = [];
      settled.forEach((s, i) => {
        if (s.status === "fulfilled") got[keys[i]] = s.value;
        else if (s.reason instanceof UpstreamError && s.reason.kind === "rejected") throw s.reason;
        else missing.push(keys[i]);
      });
      if (missing.length === keys.length) throw settled[0].reason;
      const h = got.value && shape.history(got.value.data, { kind: "tvl", days: 7, byChain: false });
      const p = got.pnl && shape.pnl(got.pnl.data);
      const pts = got.points && shape.points(got.points.data, { detail: false });
      return {
        ...meta(...Object.values(got)),
        address: addr,
        value_usd: h && h.latest ? h.latest.value : h ? 0 : null,
        value_at: h && h.latest ? h.latest.at : null,
        pnl_iusd: p ? { total: p.total, staked: p.staked, locked: p.locked_total, unwinding: p.unwinding } : null,
        unwinding: got.unwinding ? shape.unwinding(got.unwinding.data) : null,
        redemptions: got.redemptions ? shape.walletRedemptions(got.redemptions.data) : null,
        points: pts ? { rank: pts.rank, total_finalized_points: pts.total_finalized_points, current: pts.current } : null,
        missing,
      };
    },
  },
  "/v1/wallet/pnl": {
    summary: "Profit in iUSD from staked, locked (per tier), and unwinding positions, overall and by chain.",
    async run(b) {
      const addr = address(b);
      const r = await wallet("/protocol/pnl/{addr}", addr);
      return { ...meta(r), address: addr, ...shape.pnl(r.data) };
    },
  },
  "/v1/wallet/history": {
    summary: "Wallet value (kind: tvl) or profit (kind: pnl) over 7, 30, 90, 365 days or \"all\" (default 30), in USD; by_chain adds per-chain series.",
    async run(b) {
      const addr = address(b);
      const kind = optEnum(b, "kind", ["tvl", "pnl"]) || "tvl";
      const d = days(b);
      const byChain = optBool(b, "by_chain", false);
      const r = await wallet("/protocol/user-history/" + kind + "/{addr}?daysAgo=" + d.upstream, addr);
      return { ...meta(r), address: addr, ...shape.history(r.data, { kind, days: d.label, byChain }) };
    },
  },
  "/v1/wallet/unwinding": {
    summary: "The wallet's positions currently unlocking.",
    async run(b) {
      const addr = address(b);
      const r = await wallet("/protocol/unwinding/{addr}", addr);
      return { ...meta(r), address: addr, ...shape.unwinding(r.data) };
    },
  },
  "/v1/wallet/redemptions": {
    summary: "The wallet's place in the redemption queue and USDC it can claim.",
    async run(b) {
      const addr = address(b);
      const r = await wallet("/protocol/redemptions/{addr}", addr);
      return { ...meta(r), address: addr, ...shape.walletRedemptions(r.data) };
    },
  },
  "/v1/wallet/votes": {
    summary: "The wallet's allocation votes for an epoch (default: current).",
    async run(b) {
      const addr = address(b);
      const epoch = await epochFrom(b);
      const [v, pd] = await Promise.all([votesFor("/protocol/votes/" + epoch + "/" + addr, epoch, 0), protocolData().catch(() => null)]);
      return { ...meta(v, pd), address: addr, ...shape.votes(v.data, shape.farmLabels(pd && pd.data)) };
    },
  },
  "/v1/wallet/points": {
    summary: "Points rank, finalized total, current episode and chapter, multipliers, per-chapter points; detail: true adds per-source points.",
    async run(b) {
      const addr = address(b);
      const detail = optBool(b, "detail", false);
      const r = await wallet("/points/v2/user/{addr}", addr);
      return { ...meta(r), address: addr, ...shape.points(r.data, { detail }) };
    },
  },
};

export const ENDPOINT_PATHS = Object.keys(ENDPOINTS);

async function handleEndpoint(req, res, path, method) {
  const ep = ENDPOINTS[path];
  let body = {};
  if (method === "POST") {
    const raw = await readBody(req, config.maxBodyBytes);
    const text = raw.toString("utf8").trim();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
      }
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_request", "Request body must be a JSON object.");
  } else if (!(method === "GET" && ep.get)) {
    throw new HttpError(405, "method_not_allowed", ep.get ? "Use GET, or POST with a JSON body." : "Use POST with a JSON body.");
  }

  try {
    const result = await ep.run(body);
    sendJson(res, 200, { service: config.service, schema_version: SCHEMA_VERSION, ...result });
  } catch (err) {
    if (err instanceof UpstreamError) {
      // A rejection is the caller's input as judged by infiniFi (an epoch out of
      // range, say): a 4xx, delivered and paid. Only a genuine upstream outage
      // with no cached copy to fall back on is a 5xx.
      if (err.kind === "rejected") throw new HttpError(422, "upstream_rejected", err.message, { upstream_code: err.upstreamCode });
      throw new HttpError(503, "upstream_unavailable", err.message);
    }
    throw err;
  }
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  try {
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      // The RelayMiner treats anything but a 2xx here as an unreachable backend
      // and refuses to start, so this stays cheap and never calls upstream.
      sendJson(res, 200, { service: config.service, status: "ok" });
      return;
    }

    if (path === "/healthz" && method === "GET") {
      // Ready while the protocol data can be served, fresh or a recent cached
      // copy. The relayer polls this every few seconds; the cache bounds that to
      // one upstream call per protocolTtlMs.
      try {
        const pd = await protocolData();
        sendJson(res, 200, { status: "ok", service: config.service, fetched_at: new Date(pd.fetchedAt).toISOString(), stale: pd.stale });
      } catch {
        sendJson(res, 503, { status: "upstream_down", service: config.service, last_ok_at: upstream.stats.last_ok_at });
      }
      return;
    }

    if (path === "/v1/version" && method === "GET") {
      sendJson(res, 200, { service: config.service, version: config.version, schema_version: SCHEMA_VERSION, source: SOURCE });
      return;
    }

    if (path === "/v1/capabilities" && method === "GET") {
      sendJson(res, 200, {
        service: config.service,
        version: config.version,
        schema_version: SCHEMA_VERSION,
        source: SOURCE,
        upstream: {
          base: config.upstreamBase,
          deadline_ms: config.upstreamDeadlineMs,
          calls: upstream.stats.calls,
          failures: upstream.stats.failures,
          last_ok_at: upstream.stats.last_ok_at,
        },
        cache: {
          protocol_ms: config.protocolTtlMs,
          votes_and_opportunities_ms: config.slowTtlMs,
          stale_max_ms: config.staleMaxMs,
          wallet: "never cached",
        },
        limits: { max_body_bytes: config.maxBodyBytes },
        endpoints: Object.entries(ENDPOINTS).map(([p, e]) => ({ path: p, methods: e.get ? ["POST", "GET"] : ["POST"], summary: e.summary })),
        notes: [
          "Read-only. The service never signs, prepares, or submits a transaction.",
          "APYs are fractions (0.062 = 6.2%). Token amounts are in whole tokens, not base units.",
          "Prefilled action links are not available: app.infinifi.xyz does not read amounts from its URL.",
        ],
      });
      return;
    }

    if (path === "/v1/openapi.json" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": OPENAPI.length });
      res.end(OPENAPI);
      return;
    }

    if (ENDPOINTS[path]) {
      await handleEndpoint(req, res, path, method);
      return;
    }

    throw new HttpError(404, "not_found", "No such path: " + path + ". GET /v1/capabilities lists the endpoints.");
  } catch (err) {
    if (err instanceof HttpError) {
      sendError(res, err);
      return;
    }
    console.error(JSON.stringify({ msg: "request failed", path, error: String(err && err.stack) }));
    // A 5xx marks the relay unpaid and penalises the supplier, so it is reserved
    // for a genuine backend fault.
    sendError(res, new HttpError(500, "internal_error", "The backend could not complete this request."));
  }
});

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
  server.listen(config.port, () => {
    console.log(JSON.stringify({ msg: "listening", service: config.service, version: config.version, port: config.port, upstream: config.upstreamBase }));
  });
}

export { server };
