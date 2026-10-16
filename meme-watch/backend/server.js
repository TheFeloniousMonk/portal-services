// meme-watch backend for Pocket Network.
//
// HTTP contract (every response is a JSON object, including errors; see the
// Skill's references/design-rules.md):
//   GET|HEAD /              -> {service, status}              RelayMiner reachability ping
//   GET  /healthz           -> {status: "ok"}                  readiness probe
//   GET  /v1/version        -> {service, version, chain}       identity probe
//   GET  /v1/capabilities   -> window, gate, limits, upstream plan
//   GET  /v1/openapi.json   -> the OpenAPI document
//   POST /v1/launches       -> {as_of, window_minutes, count, launches | csv}
//
// Inputs arrive in the POST body, never the query string: SAGE forwards a
// query string but PATH dropped it, and no caller header survives the relay.
// Requests are served entirely from the in-memory window, so a relay never
// waits on the upstream API.

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config, KNOWN_DEXES } from "./config.js";
import { CreditLedger, DexPaprika } from "./dexpaprika.js";
import { LaunchTable, toCsv, COLUMNS } from "./store.js";
import { Poller } from "./poller.js";

const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url));

const SORTS = Object.freeze({
  created_at: (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
  volume_usd: (a, b) => (b.volume_usd || 0) - (a.volume_usd || 0),
  txns: (a, b) => (b.txns || 0) - (a.txns || 0),
  vol_per_txn: (a, b) => (b.vol_per_txn || 0) - (a.vol_per_txn || 0),
  price_change_5m: (a, b) => (b.price_change_5m || 0) - (a.price_change_5m || 0),
});

const ledger = new CreditLedger(config.dataDir, config.monthlyCredits);
const client = new DexPaprika(ledger);
const table = new LaunchTable(config.dataDir, config.csvName, config.windowMinutes);
const poller = new Poller(client, ledger, table);

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // The RelayMiner forwards bodies with Transfer-Encoding: chunked and no
    // Content-Length, so the length is only known once the stream ends.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function asPositiveNumber(value, name, errors) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    errors.push(name + " must be a number of zero or more");
    return null;
  }
  return n;
}

function parseQuery(raw) {
  const errors = [];
  const q = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  let dexes = null;
  if (q.dex !== undefined && q.dex !== null && q.dex !== "") {
    const list = Array.isArray(q.dex) ? q.dex : [q.dex];
    const cleaned = list.map((d) => String(d).trim().toLowerCase()).filter(Boolean);
    if (!cleaned.length) errors.push("dex must be a string or a list of strings");
    else dexes = new Set(cleaned);
  }

  let limit = config.defaultLimit;
  if (q.limit !== undefined && q.limit !== null) {
    const n = Number(q.limit);
    if (!Number.isInteger(n) || n < 0) errors.push("limit must be a whole number of zero or more");
    else limit = Math.min(n, config.maxLimit);
  }

  let maxAge = config.windowMinutes;
  if (q.max_age_minutes !== undefined && q.max_age_minutes !== null) {
    const n = Number(q.max_age_minutes);
    if (!Number.isFinite(n) || n <= 0) errors.push("max_age_minutes must be a number above zero");
    else maxAge = Math.min(n, config.windowMinutes);
  }

  const sort = q.sort === undefined || q.sort === null ? "created_at" : String(q.sort);
  if (!Object.hasOwn(SORTS, sort)) {
    errors.push("sort must be one of " + Object.keys(SORTS).join(", "));
  }

  const format = q.format === undefined || q.format === null ? "json" : String(q.format);
  if (format !== "json" && format !== "csv") errors.push("format must be json or csv");

  return {
    errors,
    dexes,
    limit,
    maxAge,
    sort,
    format,
    minTxns: asPositiveNumber(q.min_txns, "min_txns", errors),
    minVolume: asPositiveNumber(q.min_volume_usd, "min_volume_usd", errors),
    minLiquidity: asPositiveNumber(q.min_liquidity_usd, "min_liquidity_usd", errors),
    namedOnly: q.named_only === true,
  };
}

function envelope(now) {
  const lastPoll = poller.stats.last_poll_at ? Date.parse(poller.stats.last_poll_at) : null;
  return {
    service: config.service,
    version: config.version,
    chain: config.chain,
    source: "dexpaprika",
    as_of: poller.stats.last_poll_at,
    cache_age_seconds: lastPoll ? Math.round((now - lastPoll) / 1000) : null,
    window_minutes: config.windowMinutes,
    // Launches after this instant may still be arriving in the upstream index.
    complete_before: poller.completeBefore(now),
    upstream_ok: poller.stats.last_poll_ok,
    // A closed vocabulary. A raw upstream message here could contain wording
    // that a gateway scans for and penalises the supplier over.
    upstream_note: poller.stats.upstream_note,
    window_truncated: poller.stats.window_truncated,
  };
}

function handleLaunches(res, raw) {
  const q = parseQuery(raw);
  if (q.errors.length) {
    sendError(res, 400, "invalid_request", q.errors.join("; "));
    return;
  }

  const now = Date.now();
  const all = table.all();
  const ageCutoff = now - q.maxAge * 60 * 1000;

  const matched = all.filter((row) => {
    const created = Date.parse(row.created_at);
    if (!Number.isFinite(created) || created < ageCutoff) return false;
    if (q.dexes && !q.dexes.has(String(row.dex_id).toLowerCase())) return false;
    if (q.minTxns !== null && (row.txns || 0) < q.minTxns) return false;
    if (q.minVolume !== null && (row.volume_usd || 0) < q.minVolume) return false;
    if (q.minLiquidity !== null && (row.liquidity_usd || 0) < q.minLiquidity) return false;
    if (q.namedOnly && !row.symbol) return false;
    return true;
  });

  matched.sort(SORTS[q.sort]);
  const page = matched.slice(0, q.limit);

  const body = {
    ...envelope(now),
    sort: q.sort,
    count: page.length,
    matched: matched.length,
    total_in_window: all.length,
    pending_identity: poller.pending.size,
  };

  if (q.format === "csv") {
    // Short metadata first, the large string last.
    body.format = "csv";
    body.columns = COLUMNS;
    body.csv = toCsv(page);
  } else {
    body.format = "json";
    body.launches = page.map((row) => ({
      ...row,
      age_minutes: Number(((now - Date.parse(row.created_at)) / 60000).toFixed(2)),
    }));
  }

  sendJson(res, 200, body);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  try {
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      // The RelayMiner treats anything but a 2xx here as an unreachable
      // backend and refuses to start, so this stays cheap and always available.
      sendJson(res, 200, { service: config.service, status: "ok" });
      return;
    }

    if (path === "/healthz" && method === "GET") {
      if (!poller.stats.ready) {
        sendJson(res, 503, { status: "warming", service: config.service });
        return;
      }
      sendJson(res, 200, { status: "ok", service: config.service, rows: table.size });
      return;
    }

    if (path === "/v1/version" && method === "GET") {
      sendJson(res, 200, {
        service: config.service,
        version: config.version,
        chain: config.chain,
        source: "dexpaprika",
      });
      return;
    }

    if (path === "/v1/capabilities" && method === "GET") {
      sendJson(res, 200, {
        service: config.service,
        version: config.version,
        chain: config.chain,
        source: "dexpaprika",
        window_minutes: config.windowMinutes,
        poll_interval_seconds: Math.round(config.pollIntervalMs / 1000),
        index_lag_seconds: config.indexLagSeconds,
        dexes_known: KNOWN_DEXES,
        gate: {
          min_txns: config.gateMinTxns,
          min_volume_usd: config.gateMinVolumeUsd,
        },
        limits: {
          default_limit: config.defaultLimit,
          max_limit: config.maxLimit,
          max_body_bytes: config.maxBodyBytes,
        },
        sorts: Object.keys(SORTS),
        formats: ["json", "csv"],
        columns: COLUMNS,
        upstream: {
          // Reported by the API itself. If a key is configured and this still
          // says keyless, the key is not reaching it: check auth_header.
          plan: client.plan,
          configured_plan: config.plan,
          host: new URL(client.baseUrl).host,
          auth_header: config.authHeader,
          // auth_rejected or wrong_host once DexPaprika has refused the key.
          auth_problem: client.authProblem,
          keyed: config.hasKey,
          monthly_credit_budget: config.monthlyCredits,
          credits_remaining: ledger.remaining,
        },
        rows: table.size,
        pending_identity: poller.pending.size,
        stats: poller.stats,
      });
      return;
    }

    if (path === "/v1/openapi.json" && method === "GET") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": OPENAPI.length,
      });
      res.end(OPENAPI);
      return;
    }

    if (path === "/v1/launches") {
      if (method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Use POST with a JSON body.");
        return;
      }
      let raw;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (err) {
        if (err && err.code === "body_too_large") {
          sendError(res, 413, "body_too_large", "Request body exceeds " + config.maxBodyBytes + " bytes.");
          return;
        }
        sendError(res, 400, "invalid_request", "Could not read the request body.");
        return;
      }
      let parsed = {};
      if (raw.length) {
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          sendError(res, 400, "invalid_json", "Request body must be a JSON object.");
          return;
        }
      }
      handleLaunches(res, parsed);
      return;
    }

    sendError(res, 404, "not_found", "No such path: " + path);
  } catch (err) {
    console.error(JSON.stringify({ msg: "request failed", path, error: String(err && err.message) }));
    // 5xx marks the relay unpaid and penalises the supplier, so it is reserved
    // for a genuine backend fault rather than anything upstream did.
    sendError(res, 500, "internal_error", "The backend could not complete this request.");
  }
});

async function main() {
  await ledger.load();
  await table.load();
  if (!config.hasKey) {
    console.error(
      JSON.stringify({
        msg: "no upstream key configured; running on the keyless tier with a reduced credit budget",
        monthly_credit_budget: config.monthlyCredits,
      })
    );
  }
  if (config.planSettingUnknown) {
    console.error(
      JSON.stringify({
        msg: "MW_DEXPAPRIKA_PLAN is not free or paid; treating the key as free",
        value: config.planSettingUnknown,
      })
    );
  }
  poller.start();
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: "listening",
        service: config.service,
        version: config.version,
        port: config.port,
        window_minutes: config.windowMinutes,
        poll_interval_seconds: Math.round(config.pollIntervalMs / 1000),
        rows_restored: table.size,
        upstream_plan: config.plan,
        upstream_host: new URL(client.baseUrl).host,
        auth_header: config.authHeader,
      })
    );
  });
}

// Only start when run directly, so the test suite can import the pure parts
// without opening a socket or beginning to spend upstream credits.
const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      poller.stop();
      server.close(() => {
        Promise.allSettled([table.save(), ledger.flush()]).then(() => process.exit(0));
      });
    });
  }

  main().catch((err) => {
    console.error(JSON.stringify({ msg: "startup failed", error: String(err && err.stack) }));
    process.exit(1);
  });
}

export { server, parseQuery, SORTS, main };
