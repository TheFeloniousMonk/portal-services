// pump-check backend for Pocket Network: memecoin risk checks for agents on
// Solana, Base and Robinhood Chain.
//
// HTTP contract (every response is a JSON object, including errors; see the
// Skill's references/design-rules.md):
//   GET|HEAD /            -> {service, status}        RelayMiner reachability ping
//   GET  /healthz         -> {status}                 readiness
//   GET  /v1/version      -> {service, version}       identity probe
//   GET  /v1/capabilities -> chains, checks, limits, ingest, credits, RPC state
//   GET  /v1/openapi.json -> the OpenAPI document
//   POST /v1/check        -> results for 1 to 10 tokens
//   POST /v1/recent       -> the newest checked tokens on a chain, from the store
//
// Inputs arrive in the POST body, never the query string. Nothing here signs,
// prepares, or submits a transaction: the honeypot probe is an eth_call with
// state overrides, which exists only inside that call.

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config, CHAINS } from "./config.js";
import { Store } from "./store.js";
import { DexPaprika } from "./dexpaprika.js";
import { SolanaRpc, EvmRpc } from "./rpc.js";
import { EvmChain } from "./evm.js";
import { Blockscout } from "./blockscout.js";
import { Checker, validAddress } from "./checker.js";
import { Ingest } from "./ingest.js";
import { Worker } from "./worker.js";
import { HolderIndex } from "./holders.js";
import { CHECK_IDS } from "./verdict.js";

const SCHEMA_VERSION = "1";
const DISCLAIMER = "Facts about the token at the stated block. Not financial advice.";
const SOURCES = ["chain RPC (Pocket Network first)", "DexPaprika", "Blockscout"];
const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url));

// Gateways (SAGE) scan the first 2 KB of a body, raw and case-insensitive, for
// these phrases and treat a match as a failed relay, even inside a JSON string.
// Token names and revert reasons are third-party text ("timeout" is a real
// token name), so every occurrence is broken by writing one letter as a JSON
// \u escape: the client decodes the identical string, the scan no longer
// matches. See the Skill's references/design-rules.md, rule 6.
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

const bigintSafe = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

function sendJson(res, status, payload) {
  const body = Buffer.from(escapeGatewayPhrases(JSON.stringify(payload, bigintSafe)));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, message, details) {
  const error = details ? { code, message, details } : { code, message };
  sendJson(res, status, { service: config.service, schema_version: SCHEMA_VERSION, error });
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

// ---- wiring --------------------------------------------------------------------------

export function build({ store = new Store(config.dataDir), fetchImpl = globalThis.fetch, dexpaprikaOptions = {}, blockscoutOptions = {} } = {}) {
  const rpcOpts = {
    rpcDeadlineMs: config.rpcDeadlineMs,
    rpcMaxLag: config.rpcMaxLag,
    rpcMaxLagSlots: config.rpcMaxLagSlots,
    logPageBlocks: config.logPageBlocks,
    breakerFailures: config.breakerFailures,
    breakerCooldownMs: config.breakerCooldownMs,
  };
  const rpc = {
    solana: new SolanaRpc(config.rpc.solana, rpcOpts, fetchImpl),
    base: new EvmRpc("base", config.rpc.base, rpcOpts, fetchImpl),
    robinhood: new EvmRpc("robinhood", config.rpc.robinhood, rpcOpts, fetchImpl),
  };
  const blockscout = new Blockscout({ fetchImpl, ...blockscoutOptions });
  const evm = {
    base: new EvmChain("base", rpc.base, { blockscout, config }),
    robinhood: new EvmChain("robinhood", rpc.robinhood, { blockscout, config }),
  };
  const dexpaprika = new DexPaprika(store, { fetchImpl, ...dexpaprikaOptions });
  const holderIndex = new HolderIndex({ store, evm, config });
  const checker = new Checker({ store, dexpaprika, rpc, evm, config, holderIndex });
  const ingest = new Ingest({ store, dexpaprika, evm, config });
  const worker = new Worker({ store, checker, config });
  return { store, rpc, evm, blockscout, dexpaprika, checker, ingest, worker, holderIndex };
}

export function createServer(app) {
  const { store, rpc, checker, ingest, worker, dexpaprika, blockscout, holderIndex } = app;

  const chainUp = (c) => rpc[c].healthy;
  const anyChainUp = () => CHAINS.some(chainUp);
  const ready = () => ingest.fresh && anyChainUp();

  async function handleCheck(res, body) {
    const tokens = body.tokens;
    if (!Array.isArray(tokens) || tokens.length === 0) {
      sendError(res, 400, "invalid_request", "tokens must be a non-empty array of {chain, address}");
      return;
    }
    if (tokens.length > config.maxTokens) {
      sendError(res, 400, "too_many_tokens", `at most ${config.maxTokens} tokens per request`);
      return;
    }
    const detail = body.detail === undefined ? "standard" : body.detail;
    if (detail !== "standard" && detail !== "full") {
      sendError(res, 400, "invalid_request", "detail must be \"standard\" or \"full\"");
      return;
    }
    const problems = [];
    const wanted = tokens.map((t, i) => {
      if (!t || typeof t !== "object") {
        problems.push({ index: i, reason: "each token is an object {chain, address}" });
        return null;
      }
      const chain = String(t.chain || "").toLowerCase();
      if (!CHAINS.includes(chain)) {
        problems.push({ index: i, reason: `chain must be one of ${CHAINS.join(", ")}` });
        return null;
      }
      const address = chain === "solana" ? String(t.address || "") : String(t.address || "").toLowerCase();
      if (!validAddress(chain, address)) {
        problems.push({ index: i, reason: `not a valid ${chain} address` });
        return null;
      }
      return { chain, address };
    });
    if (problems.length) {
      sendError(res, 400, "invalid_request", "one or more tokens are invalid", { tokens: problems });
      return;
    }
    // Nothing at all can be answered: no ingest has ever completed and no RPC answers.
    if (!ingest.stats.last_ok_at && !anyChainUp()) {
      await Promise.all(CHAINS.map((c) => rpc[c].refreshHeads().catch(() => null)));
      if (!anyChainUp()) {
        sendError(res, 503, "warming", "No data source is reachable yet.");
        return;
      }
    }
    // Duplicates are checked once.
    const seen = new Map();
    const results = await Promise.all(
      wanted.map((t) => {
        const key = t.chain + ":" + t.address;
        if (!seen.has(key)) seen.set(key, checker.check(t.chain, t.address, detail));
        return seen.get(key);
      })
    );
    sendJson(res, 200, { service: config.service, schema_version: SCHEMA_VERSION, disclaimer: DISCLAIMER, results, errors: [] });
  }

  function handleRecent(res, body) {
    const chain = String(body.chain || "").toLowerCase();
    if (!CHAINS.includes(chain)) {
      sendError(res, 400, "invalid_request", `chain must be one of ${CHAINS.join(", ")}`);
      return;
    }
    const verdicts = body.verdict === undefined ? null : [].concat(body.verdict).map(String);
    if (verdicts && verdicts.some((v) => !["ok", "caution", "danger", "unknown"].includes(v))) {
      sendError(res, 400, "invalid_request", "verdict must be ok, caution, danger or unknown (or a list of them)");
      return;
    }
    const minLiq = body.min_liquidity_usd === undefined ? null : Number(body.min_liquidity_usd);
    if (minLiq !== null && !Number.isFinite(minLiq)) {
      sendError(res, 400, "invalid_request", "min_liquidity_usd must be a number");
      return;
    }
    const limit = Math.min(config.maxRecent, Math.max(1, Number(body.limit) || 20));
    // Answered from the store alone: a screening feed that costs nothing upstream.
    const out = [];
    for (const row of store.recent(chain, config.maxRecent * 5)) {
      const r = checker.shape(chain, row.address, null, "standard");
      if (!r.found) continue;
      if (verdicts && !verdicts.includes(r.verdict)) continue;
      if (minLiq !== null && !(r.market && r.market.liquidity_usd >= minLiq)) continue;
      out.push(r);
      if (out.length >= limit) break;
    }
    sendJson(res, 200, {
      service: config.service,
      schema_version: SCHEMA_VERSION,
      disclaimer: DISCLAIMER,
      note: "From the store: checks as of their stored time, without live re-reads. POST /v1/check for a live answer.",
      chain,
      results: out,
    });
  }

  return http.createServer(async (req, res) => {
    const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    const method = req.method || "GET";
    try {
      if (path === "/" && (method === "GET" || method === "HEAD")) {
        // The RelayMiner treats anything but a 2xx here as an unreachable backend.
        sendJson(res, 200, { service: config.service, status: "ok" });
        return;
      }
      if (path === "/healthz" && method === "GET") {
        if (!ready()) {
          sendJson(res, 503, { status: "warming", service: config.service, ingest_fresh: ingest.fresh, chains: Object.fromEntries(CHAINS.map((c) => [c, chainUp(c)])) });
          return;
        }
        sendJson(res, 200, { status: "ok", service: config.service, chains: Object.fromEntries(CHAINS.map((c) => [c, chainUp(c)])) });
        return;
      }
      if (path === "/v1/version" && method === "GET") {
        sendJson(res, 200, { service: config.service, version: config.version, schema_version: SCHEMA_VERSION, sources: SOURCES });
        return;
      }
      if (path === "/v1/capabilities" && method === "GET") {
        sendJson(res, 200, {
          service: config.service,
          version: config.version,
          schema_version: SCHEMA_VERSION,
          disclaimer: DISCLAIMER,
          chains: CHAINS,
          checks: { solana: CHECK_IDS.solana, base: CHECK_IDS.evm, robinhood: CHECK_IDS.evm },
          not_offered: { solana: ["holder_concentration", "snipers_bundles"] },
          thresholds: {
            sell_tax_critical_pct: config.sellTaxCritical,
            tax_warning_pct: config.taxWarning,
            min_liquidity_usd: config.minLiquidityUsd,
            top10_holders_warn_pct: config.topHoldersWarnPct,
            creator_holding_warn_pct: config.creatorHoldingWarnPct,
            sniper_warn_pct: config.sniperWarnPct,
            sniper_window_seconds: config.sniperWindowSeconds,
          },
          limits: { max_tokens: config.maxTokens, max_recent: config.maxRecent, max_body_bytes: config.maxBodyBytes, check_deadline_ms: config.checkDeadlineMs },
          ingest: ingest.status(),
          precompute: worker.status(),
          store: store.counts(),
          dexpaprika: dexpaprika.status(),
          blockscout: blockscout.status(),
          holder_index: holderIndex.status(),
          rpc: Object.fromEntries(CHAINS.map((c) => [c, rpc[c].status()])),
        });
        return;
      }
      if (path === "/v1/openapi.json" && method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": OPENAPI.length });
        res.end(OPENAPI);
        return;
      }
      if (path === "/v1/check" || path === "/v1/recent") {
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
        let body;
        try {
          body = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          sendError(res, 400, "invalid_json", "Request body must be a JSON object.");
          return;
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          sendError(res, 400, "invalid_request", "Request body must be a JSON object.");
          return;
        }
        if (path === "/v1/check") await handleCheck(res, body);
        else handleRecent(res, body);
        return;
      }
      sendError(res, 404, "not_found", "No such path: " + path);
    } catch (err) {
      console.error(JSON.stringify({ msg: "request failed", path, error: String(err && err.stack) }));
      // A 5xx marks the relay unpaid and penalises the supplier, so it is
      // reserved for a genuine backend fault.
      sendError(res, 500, "internal_error", "The backend could not complete this request.");
    }
  });
}

export async function main() {
  const app = build();
  const server = createServer(app);
  // Learn each endpoint's head once so the freshness guard and readiness work
  // before the first request.
  await Promise.all(CHAINS.map((c) => app.rpc[c].refreshHeads().catch(() => null)));
  const headTimer = setInterval(() => CHAINS.forEach((c) => app.rpc[c].refreshHeads().catch(() => null)), 60000);
  headTimer.unref();
  app.ingest.start(() => app.worker.kick());
  app.worker.start();
  app.holderIndex.start();
  const pruneTimer = setInterval(() => {
    try {
      const n = app.store.prune(config.retentionDays);
      if (n) console.log(JSON.stringify({ msg: "pruned inactive tokens", tokens: n }));
    } catch (e) {
      console.error(JSON.stringify({ msg: "prune failed", error: String(e && e.message) }));
    }
  }, 3600000);
  pruneTimer.unref();
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: "listening",
        service: config.service,
        version: config.version,
        port: config.port,
        dexpaprika_plan: config.plan,
        blockscout: app.blockscout.enabled,
        rpc: Object.fromEntries(CHAINS.map((c) => [c, config.rpc[c].map((e) => new URL(e.url).host)])),
      })
    );
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      app.ingest.stop();
      app.worker.stop();
      app.holderIndex.stop();
      server.close(() => {
        app.store.close();
        process.exit(0);
      });
    });
  }
  return { app, server };
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    console.error(JSON.stringify({ msg: "startup failed", error: String(err && err.stack) }));
    process.exit(1);
  });
}
