// Smoke test. No network access: a mock upstream serves real infiniFi payloads
// captured on 2026-10-15 (test/fixtures/), and the backend is pointed at it.
//
// Run with: npm test

import http from "node:http";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const FIX = (name) => readFileSync(new URL("./fixtures/" + name + ".json", import.meta.url), "utf8");
const WALLET = "0x46a83dc1a264bff133db887023d2884167094837";

let failures = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (err && err.message));
  }
}

// --- mock upstream ------------------------------------------------------------

let upstreamDown = false;
const seen = [];
const ROUTES = [
  [/^\/api\/protocol\/data$/, "protocol-data"],
  [/^\/api\/protocol\/redemptions\/$/, "redemptions"],
  [/^\/api\/simulate\/redemptions\?amount=\d+$/, "simulate"],
  [/^\/api\/protocol\/votes\/2962$/, "votes"],
  [/^\/api\/protocol\/votes\/2962\/0x[0-9a-f]{40}$/i, "wallet-votes"],
  [/^\/api\/points\/integrations$/, "integrations"],
  [/^\/api\/protocol\/pnl\/0x[0-9a-f]{40}$/i, "pnl"],
  [/^\/api\/protocol\/user-history\/(tvl|pnl)\/0x[0-9a-f]{40}\?daysAgo=(0|7|30|90|365)$/i, "history-tvl-7"],
  [/^\/api\/protocol\/unwinding\/0x[0-9a-f]{40}$/i, "unwinding"],
  [/^\/api\/protocol\/redemptions\/0x[0-9a-f]{40}$/i, "wallet-redemptions"],
  [/^\/api\/points\/v2\/user\/0x[0-9a-f]{40}$/i, "points"],
];

const mock = http.createServer((req, res) => {
  seen.push(req.url);
  if (upstreamDown) {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html>cloudflare</html>");
    return;
  }
  const votes = /^\/api\/protocol\/votes\/(\d+)/.exec(req.url);
  if (votes && Number(votes[1]) !== 2962) {
    const n = Number(votes[1]);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(n > 2963 ? FIX("votes-future") : JSON.stringify({ code: "ERR_EPOCH_IN_PAST" }));
    return;
  }
  for (const [re, name] of ROUTES) {
    if (re.test(req.url)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(FIX(name));
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/html" });
  res.end("<pre>Cannot GET</pre>");
});
await new Promise((r) => mock.listen(0, "127.0.0.1", r));

process.env.IF_UPSTREAM_BASE = "http://127.0.0.1:" + mock.address().port + "/api";
process.env.IF_PROTOCOL_TTL_MS = "50";
process.env.IF_SLOW_TTL_MS = "50";
const { server, escapeGatewayPhrases, ENDPOINT_PATHS } = await import("../server.js");
const shape = await import("../shape.js");
const { Upstream } = await import("../upstream.js");
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = "http://127.0.0.1:" + server.address().port;

async function call(path, body, method = body === undefined ? "GET" : "POST") {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

// --- unit -----------------------------------------------------------------------

console.log("unit");
await test("toUnits is exact for decimals and integers", () => {
  assert.equal(shape.toUnits("2500.5"), "2500500000000000000000");
  assert.equal(shape.toUnits(1), "1000000000000000000");
  assert.equal(shape.toUnits("0.000000000000000001"), "1");
  assert.equal(shape.toUnits("-4"), null);
  assert.equal(shape.toUnits("1e5"), null);
});
await test("fromUnits round-trips and handles negatives", () => {
  assert.equal(shape.fromUnits("5000000000000000000"), 5);
  assert.equal(shape.fromUnits("-15", 18), -1.5e-17);
});
await test("num turns upstream string APYs into numbers", () => {
  assert.equal(shape.num("0.04"), 0.04);
  assert.equal(shape.num(""), null);
  assert.equal(shape.num("x"), null);
});
await test("gateway phrases are escaped, JSON still parses to the same text", () => {
  const s = JSON.stringify({ d: "redemption timeout window" });
  const e = escapeGatewayPhrases(s);
  assert.ok(!/timeout/i.test(e));
  assert.equal(JSON.parse(e).d, "redemption timeout window");
});
await test("upstream serves a stale copy when it goes down, then fails past staleMaxMs", async () => {
  let t = 1_000_000;
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new TypeError("fetch failed");
    return new Response(JSON.stringify({ code: "OK", data: { x: 1 } }));
  };
  const u = new Upstream({ base: "http://x", deadlineMs: 1000, staleMaxMs: 10_000, epochTtlMs: 1, userAgent: "t", fetchImpl, now: () => t });
  assert.equal((await u.get("/p", 100)).stale, false);
  fail = true;
  t += 500;
  const s = await u.get("/p", 100);
  assert.equal(s.stale, true);
  assert.equal(s.data.x, 1);
  t += 20_000;
  await assert.rejects(u.get("/p", 100), (e) => e.kind === "unavailable");
});
await test("upstream 4xx with an error code is a rejection, HTML is unavailable", async () => {
  const mk = (status, body) => new Upstream({ base: "http://x", deadlineMs: 1000, staleMaxMs: 1, epochTtlMs: 1, userAgent: "t", fetchImpl: async () => new Response(body, { status }) });
  await assert.rejects(mk(404, '{"code":"ERR_NOT_FOUND"}').get("/p"), (e) => e.kind === "rejected" && e.upstreamCode === "ERR_NOT_FOUND");
  await assert.rejects(mk(403, "<html>Just a moment...</html>").get("/p"), (e) => e.kind === "unavailable");
});

// --- http -----------------------------------------------------------------------

console.log("http");
await test("probe endpoints", async () => {
  assert.equal((await call("/")).json.status, "ok");
  assert.equal((await call("/v1/version")).json.service, "infinifi");
  const h = await call("/healthz");
  assert.equal(h.status, 200);
  assert.equal(h.json.status, "ok");
  const c = await call("/v1/capabilities");
  assert.equal(c.json.endpoints.length, ENDPOINT_PATHS.length);
  const o = await call("/v1/openapi.json");
  assert.equal(o.status, 200);
  for (const p of ENDPOINT_PATHS) assert.ok(o.json.paths[p], "openapi.json is missing " + p);
});
await test("HEAD / answers 2xx", async () => {
  const r = await fetch(BASE + "/", { method: "HEAD" });
  assert.equal(r.status, 200);
});
await test("overview", async () => {
  const r = await call("/v1/overview", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.asset.symbol, "USDC");
  assert.equal(r.json.siusd.token, "siUSD");
  assert.equal(typeof r.json.siusd.apy.d7, "number");
  assert.equal(r.json.lock_tiers.count, 13);
  assert.ok(r.json.fetched_at);
});
await test("yields: card's functional probe and filters", async () => {
  const r = await call("/v1/yields", {});
  assert.equal(r.json.staked.token, "siUSD");
  assert.equal(r.json.locked.length, 13);
  assert.deepEqual(r.json.locked.map((t) => t.weeks), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  const f = await call("/v1/yields", { min_weeks: 4, max_weeks: 8, include_empty: false });
  assert.ok(f.json.locked.every((t) => t.weeks >= 4 && t.weeks <= 8 && !t.empty));
  assert.ok(f.json.locked.length > 0);
});
await test("farms: numeric APY, filters, sort", async () => {
  const all = await call("/v1/farms", { include_paused: true });
  assert.equal(all.json.count, 24);
  assert.ok(all.json.farms.every((f) => f.apy === null || typeof f.apy === "number"));
  const ill = await call("/v1/farms", { type: "illiquid", chain: "ethereum", sort: "apy" });
  assert.ok(ill.json.farms.every((f) => f.type === "illiquid" && f.chain === "ethereum" && !f.paused));
  for (let i = 1; i < ill.json.farms.length; i++) assert.ok(ill.json.farms[i - 1].apy >= ill.json.farms[i].apy);
  const monad = await call("/v1/farms", { chain: "MONAD" });
  assert.ok(monad.json.count > 0 && monad.json.farms.every((f) => f.chain === "monad"));
});
await test("farm by name returns every chain's match; unknown is 422", async () => {
  const r = await call("/v1/farm", { name: "Aave USDC" });
  assert.equal(r.status, 200);
  assert.ok(r.json.count >= 2);
  const a = await call("/v1/farm", { address: r.json.farms[0].address.toLowerCase() });
  assert.equal(a.json.count, 1);
  assert.equal((await call("/v1/farm", { name: "no such farm" })).status, 422);
  assert.equal((await call("/v1/farm", {})).status, 400);
});
await test("params", async () => {
  const r = await call("/v1/params", {});
  assert.equal(r.json.bucket_multipliers.length, 13);
  assert.equal(r.json.bucket_multipliers[0].weeks, 1);
});
await test("redemption queue and quote", async () => {
  assert.equal((await call("/v1/redemption-queue", {})).json.total_enqueued_iusd, 0);
  const q = await call("/v1/redemption-quote", { amount_iusd: "2500.5" });
  assert.equal(q.status, 200);
  assert.equal(q.json.amount_iusd, 2500.5);
  assert.ok(seen.some((u) => u.endsWith("amount=2500500000000000000000")), "amount not sent in 18-decimal units");
  assert.equal((await call("/v1/redemption-quote", {})).status, 400);
  assert.equal((await call("/v1/redemption-quote", { amount_iusd: 0 })).status, 400);
});
await test("allocation votes resolve the current epoch and name farms", async () => {
  const r = await call("/v1/allocation-votes", {});
  assert.equal(r.status, 200);
  assert.equal(r.json.epoch, 2962);
  assert.ok(r.json.liquid.votes.some((v) => v.farm === "Aave USDC"));
  const old = await call("/v1/allocation-votes", { epoch: 5 });
  assert.equal(old.status, 422);
  assert.equal(old.json.error.code, "epoch_out_of_range");
  assert.match(old.json.error.message, /2961 to 2963/);
});
await test("opportunities: absolute links and filters", async () => {
  const r = await call("/v1/opportunities", {});
  assert.ok(r.json.count > 0);
  assert.ok(r.json.opportunities.every((o) => !o.action.url || /^https:\/\//.test(o.action.url)));
  const p = await call("/v1/opportunities", { protocol: "PENDLE" });
  assert.ok(p.json.count > 0 && p.json.opportunities.every((o) => o.protocol === "pendle"));
});
await test("wallet summary", async () => {
  const r = await call("/v1/wallet", { address: WALLET });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.missing, []);
  assert.equal(typeof r.json.value_usd, "number");
  assert.equal(typeof r.json.pnl_iusd.total, "number");
  assert.equal(r.json.points.rank, 10);
});
await test("wallet sub-endpoints", async () => {
  const pnl = await call("/v1/wallet/pnl", { address: WALLET });
  assert.deepEqual(pnl.json.locked.map((l) => l.weeks), [4, 8, 13]);
  assert.ok(pnl.json.by_chain.ethereum);
  const h = await call("/v1/wallet/history", { address: WALLET, days: "all", by_chain: true });
  assert.equal(h.json.days, "all");
  assert.ok(seen.some((u) => u.includes("daysAgo=0")), "days:all must map to daysAgo=0");
  assert.ok(h.json.points.length > 0 && h.json.by_chain.ethereum);
  assert.equal((await call("/v1/wallet/unwinding", { address: WALLET })).json.count, 0);
  assert.equal((await call("/v1/wallet/redemptions", { address: WALLET })).json.claimable_usdc, 0);
  assert.equal((await call("/v1/wallet/votes", { address: WALLET })).json.epoch, 2962);
  const pts = await call("/v1/wallet/points", { address: WALLET, detail: true });
  assert.ok(pts.json.chapters.length > 0 && Array.isArray(pts.json.chapters[0].sources));
});
await test("bad input is a 4xx JSON error", async () => {
  for (const [p, b] of [
    ["/v1/wallet", { address: "0x123" }],
    ["/v1/wallet/history", { address: WALLET, days: 3 }],
    ["/v1/wallet/history", { address: WALLET, kind: "apy" }],
    ["/v1/farms", { chain: "solana" }],
    ["/v1/farms", { include_paused: "yes" }],
    ["/v1/overview", "not json"],
    ["/v1/overview", "[1,2]"],
  ]) {
    const r = await call(p, b);
    assert.ok(r.status >= 400 && r.status < 500, p + " gave " + r.status);
    assert.ok(r.json.error && r.json.error.code, p + " has no error object");
  }
  assert.equal((await call("/v1/wallet")).status, 405);
  assert.equal((await call("/v1/nope", {})).status, 404);
});
await test("upstream outage: cached data served stale, wallet calls 503", async () => {
  await call("/v1/overview", {});
  upstreamDown = true;
  await new Promise((r) => setTimeout(r, 80)); // past the 50 ms TTL
  const o = await call("/v1/overview", {});
  assert.equal(o.status, 200);
  assert.equal(o.json.stale, true);
  const w = await call("/v1/wallet/pnl", { address: WALLET });
  assert.equal(w.status, 503);
  assert.equal(w.json.error.code, "upstream_unavailable");
  upstreamDown = false;
});
await test("every body starts with { and carries no gateway phrase in its first 2 KB", async () => {
  for (const p of ENDPOINT_PATHS) {
    const r = await call(p, p.startsWith("/v1/wallet") ? { address: WALLET } : p === "/v1/redemption-quote" ? { amount_iusd: 1 } : p === "/v1/farm" ? { name: "aave" } : {});
    assert.equal(r.text[0], "{", p);
    assert.ok(!/timeout|bad gateway|service unavailable|connection re(fused|set)/i.test(r.text.slice(0, 2048)), p);
  }
});

server.close();
mock.close();
console.log(failures ? failures + " failed" : "all passed");
process.exit(failures ? 1 : 0);
