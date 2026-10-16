// Smoke test. No network access and no upstream credits are spent: the server
// is started with polling disabled and every fixture is a recorded response.
//
// Run with: npm test

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import {
  memeTokenOf,
  tractionFrom,
  enrichmentFrom,
  toCsv,
  parseCsv,
  LaunchTable,
  COLUMNS,
  guardSplit,
} from "../store.js";
import { DexPaprika } from "../dexpaprika.js";

const WSOL = "So11111111111111111111111111111111111111112";
let failures = 0;

function test(name, fn) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name);
    console.log("       " + (err && err.message));
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name);
    console.log("       " + (err && err.message));
  }
}

// Recorded from the live API on 2026-09-20.
const LIST_ROW = {
  id: "ER2QrAJa3Rw1wXfWrJ9PuoVBBb9sGgNuVA1NXeHzW3wS",
  dex_id: "pumpfun",
  chain: "solana",
  volume_usd_24h: 9789.171957105846,
  created_at: "2026-09-20T10:50:45Z",
  transactions_24h: 342,
  price_usd: 0.0000032697432553045953,
  price_change_percentage_5m: -56.98516045994477,
  price_change_percentage_24h: 0,
  liquidity_usd: 4490.585153781271,
  tokens: [
    { id: WSOL, chain: "solana", has_image: true },
    { id: "5c7dFoif6LhcQqbBF9qSSXQvSywWQoDCjWdhvNLMpump", chain: "solana", has_image: true },
  ],
};

const POOL_DETAILS = {
  id: "ER2QrAJa3Rw1wXfWrJ9PuoVBBb9sGgNuVA1NXeHzW3wS",
  dex_id: "pumpfun",
  base_token_id: "5c7dFoif6LhcQqbBF9qSSXQvSywWQoDCjWdhvNLMpump",
  quote_token_id: WSOL,
  created_at: "2026-09-20T10:50:45Z",
  tokens: [
    { id: WSOL, name: "Wrapped SOL", symbol: "SOL", decimals: 9, has_image: true, fdv: 1052502882.6 },
    {
      id: "5c7dFoif6LhcQqbBF9qSSXQvSywWQoDCjWdhvNLMpump",
      name: "PermanentlyEmploylessPumpEnjoyer",
      symbol: "PEPE",
      decimals: 6,
      total_supply: 1000000000000000,
      website: "https://otcdesks.cash/coin/5c7dFoif",
      has_image: true,
      fdv: 4764.584966188878,
    },
  ],
  token_reserves: [
    { token_id: WSOL, reserve: 256387859, reserve_usd: 27.736259038316255 },
    { token_id: "5c7dFoif6LhcQqbBF9qSSXQvSywWQoDCjWdhvNLMpump", reserve: 784007571989091, reserve_usd: 3735.47 },
  ],
  liquidity_usd: 2586.1332229521972,
  last_price_usd: 0.000004764584966188878,
  price_stats: { high_24h: null, low_24h: null, ath: 0.000007599976195315843, ath_date: "2026-09-20T10:51:00Z" },
  twitter: "https://x.com/UltraGigaDeploy/status/2101625050637947346",
  "24h": { volume_usd: 9889.91, buy_usd: 5448.03, sell_usd: 4441.87, sells: 177, buys: 169, txns: 346 },
};

console.log("store");

test("picks the memecoin, not the quote asset", () => {
  assert.equal(memeTokenOf(LIST_ROW.tokens), "5c7dFoif6LhcQqbBF9qSSXQvSywWQoDCjWdhvNLMpump");
});

test("traction carries since-launch totals and derives volume per transaction", () => {
  const t = tractionFrom(LIST_ROW);
  assert.equal(t.txns, 342);
  assert.equal(t.volume_usd, 9789.171957105846);
  // Stored to four decimal places, so compare at that precision.
  assert.equal(t.vol_per_txn, Number((9789.171957105846 / 342).toFixed(4)));
  assert.equal(t.price_change_5m, -56.9852);
  assert.equal(t.dex_id, "pumpfun");
});

test("enrichment takes identity, the buy and sell split, and the true reserve", () => {
  const e = enrichmentFrom(POOL_DETAILS);
  assert.equal(e.name, "PermanentlyEmploylessPumpEnjoyer");
  assert.equal(e.symbol, "PEPE");
  assert.equal(e.buys, 169);
  assert.equal(e.sells, 177);
  // The quote-side reserve, not the headline liquidity_usd of 2586.
  assert.equal(e.quote_reserve_usd, 27.736259038316255);
  assert.ok(e.twitter.startsWith("https://x.com/"));
});

// The real split DexPaprika reported for PumpSwap pool EVumYL4z... on
// 2026-10-16: every trade booked as a sell while the price rose 48% in an hour.
const ONE_SIDED = { volume_usd: 198065.87, buy_usd: 0, sell_usd: 198065.87, sells: 1275, buys: 0, txns: 1275 };

test("a one-sided split over many trades is withheld and flagged", () => {
  const e = enrichmentFrom({ ...POOL_DETAILS, "24h": ONE_SIDED });
  assert.equal(e.split_unreliable, true);
  assert.equal(e.buys, null);
  assert.equal(e.sells, null);
  assert.equal(e.buy_usd, null);
  assert.equal(e.sell_usd, null);
  // Identity is untouched.
  assert.equal(e.symbol, "PEPE");
});

test("a normal split passes through and is marked reliable", () => {
  const e = enrichmentFrom(POOL_DETAILS);
  assert.equal(e.split_unreliable, false);
  assert.equal(e.buys, 169);
  assert.equal(e.sell_usd, 4441.87);
});

test("a one-sided split under the threshold is believable and kept", () => {
  const few = { buys: 0, sells: 7, buy_usd: 0, sell_usd: 120, txns: 7 };
  const e = enrichmentFrom({ ...POOL_DETAILS, "24h": few });
  assert.equal(e.split_unreliable, false);
  assert.equal(e.sells, 7);
  // The threshold is configurable.
  assert.equal(guardSplit(few, 5).split_unreliable, true);
});

test("a missing split is left alone, not flagged", () => {
  const e = enrichmentFrom({ ...POOL_DETAILS, "24h": {} });
  assert.equal(e.buys, null);
  assert.equal(e.split_unreliable, false);
});

await testAsync("rows saved before the guard are cleaned when the csv is loaded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "meme-watch-guard-"));
  try {
    // A CSV in the 1.0.1 layout: no split_unreliable column, a one-sided split.
    const now = new Date().toISOString();
    const old = [
      "pool_address,dex_id,created_at,first_seen,buys,sells,buy_usd,sell_usd,txns",
      `BAD1,pumpswap,${now},${now},0,1275,0,198065.87,1275`,
      `GOOD1,pumpswap,${now},${now},169,177,5448.03,4441.87,346`,
    ].join("\n");
    await writeFile(join(dir, "launches.csv"), old, "utf8");
    const table = new LaunchTable(dir, "launches.csv", 60);
    await table.load();
    const bad = table.rows.get("BAD1");
    const good = table.rows.get("GOOD1");
    assert.equal(bad.split_unreliable, true);
    assert.equal(bad.sells, null);
    assert.equal(good.split_unreliable, false);
    assert.equal(good.buys, 169);
    // And the flag survives the next save and load.
    const back = parseCsv(toCsv([bad, good]));
    assert.equal(back[0].split_unreliable, true);
    assert.equal(back[1].split_unreliable, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("total supply is scaled out of base units so price times supply is the fdv", () => {
  const e = enrichmentFrom(POOL_DETAILS);
  assert.equal(e.decimals, 6);
  assert.equal(e.total_supply, 1000000000);
  const implied = e.total_supply * 0.000004764584966188878;
  assert.ok(Math.abs(implied - e.fdv_usd) < 1e-6);
});

test("drawdown from the all-time high is computed", () => {
  const e = enrichmentFrom(POOL_DETAILS);
  assert.ok(e.drawdown_from_ath_pct < -36 && e.drawdown_from_ath_pct > -38);
});

test("csv survives a round trip, including commas and quotes in a name", () => {
  const rows = [
    { ...tractionFrom(LIST_ROW), ...enrichmentFrom(POOL_DETAILS), pool_address: LIST_ROW.id, first_seen: "2026-09-20T10:52:00Z" },
    { ...tractionFrom(LIST_ROW), pool_address: "X2", first_seen: "2026-09-20T10:52:00Z", name: 'He said "buy", loudly', symbol: "A,B" },
  ];
  const parsed = parseCsv(toCsv(rows));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].symbol, "PEPE");
  assert.equal(parsed[0].txns, 342);
  assert.equal(parsed[1].name, 'He said "buy", loudly');
  assert.equal(parsed[1].symbol, "A,B");
});

test("csv header matches the declared columns", () => {
  assert.equal(toCsv([]).trim(), COLUMNS.join(","));
});

console.log("window");

test("prune drops rows past the window and keeps the rest", async () => {
  const table = new LaunchTable(tmpdir(), "unused.csv", 60);
  const now = Date.parse("2026-09-20T12:00:00Z");
  table.insert("fresh", { created_at: "2026-09-20T11:30:00Z" }, { symbol: "A" });
  table.insert("old", { created_at: "2026-09-20T10:30:00Z" }, { symbol: "B" });
  table.insert("broken", { created_at: "" }, { symbol: "C" });
  const dropped = table.prune(now);
  assert.equal(dropped, 2);
  assert.equal(table.size, 1);
  assert.ok(table.has("fresh"));
});

test("refresh updates a held row and reports an unknown one", () => {
  const table = new LaunchTable(tmpdir(), "unused.csv", 60);
  table.insert("p1", tractionFrom(LIST_ROW), enrichmentFrom(POOL_DETAILS));
  assert.equal(table.refresh("p1", { volume_usd: 12345, txns: 400 }), true);
  assert.equal(table.all()[0].volume_usd, 12345);
  // Identity survives a traction refresh.
  assert.equal(table.all()[0].symbol, "PEPE");
  assert.equal(table.refresh("nope", { volume_usd: 1 }), false);
});

console.log("upstream guards");

test("a dropped filter is detected from the echoed query", () => {
  const good = { query: { created_after: 1, txns_24h_min: 1, volume_usd_24h_min: 1 } };
  assert.deepEqual(DexPaprika.assertFilters(good, { created_after: 1, volume_usd_24h_min: 1 }), []);
  // volume_24h_min is the spelling the REST API silently ignores.
  const bad = { query: { created_after: 1, txns_24h_min: 1 } };
  assert.deepEqual(DexPaprika.assertFilters(bad, { volume_usd_24h_min: 1 }), ["volume_usd_24h_min"]);
});

// The config is read from the environment at import, so each case runs in its
// own process. The key here is a dummy string, never a real one.
function configWith(env) {
  const code = 'import("./config.js").then(({config:c})=>console.log(JSON.stringify({plan:c.plan,baseUrl:c.baseUrl,authHeader:c.authHeader,monthlyCredits:c.monthlyCredits,unknown:c.planSettingUnknown})))';
  const clean = { ...process.env };
  for (const k of Object.keys(clean)) if (k.startsWith("MW_")) delete clean[k];
  const out = spawnSync(process.execPath, ["-e", code], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  return JSON.parse(out.stdout.trim());
}

test("no key: public host, keyless budget under the 10,000-credit allowance", () => {
  const c = configWith({});
  assert.equal(c.plan, "keyless");
  assert.equal(c.baseUrl, "https://api.dexpaprika.com");
  assert.equal(c.monthlyCredits, 9500);
});

test("a key defaults to the free plan: public host, Authorization header", () => {
  const c = configWith({ MW_DEXPAPRIKA_API_KEY: "api_dummy" });
  assert.equal(c.plan, "free");
  assert.equal(c.baseUrl, "https://api.dexpaprika.com");
  assert.equal(c.authHeader, "Authorization");
  assert.equal(c.monthlyCredits, 95000);
});

test("a paid key goes to api-pro", () => {
  const c = configWith({ MW_DEXPAPRIKA_API_KEY: "api_dummy", MW_DEXPAPRIKA_PLAN: "PAID" });
  assert.equal(c.plan, "paid");
  assert.equal(c.baseUrl, "https://api-pro.dexpaprika.com");
});

test("an unknown plan value is treated as free and reported", () => {
  const c = configWith({ MW_DEXPAPRIKA_API_KEY: "api_dummy", MW_DEXPAPRIKA_PLAN: "pro" });
  assert.equal(c.plan, "free");
  assert.equal(c.unknown, "pro");
});

test("an explicit base URL still wins", () => {
  const c = configWith({ MW_DEXPAPRIKA_API_KEY: "api_dummy", MW_DEXPAPRIKA_BASE_URL: "https://example.test" });
  assert.equal(c.baseUrl, "https://example.test");
});

// The client against a stubbed fetch, one documented DexPaprika answer each
// (docs.dexpaprika.com/api-pro/introduction, "If your request just failed").
const ledgerStub = () => ({ remaining: 100, spent: 0, spend(n = 1) { this.spent += n; } });
async function withFetch(responder, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return responder(String(url), init);
  };
  const quiet = console.error;
  console.error = () => {};
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
    console.error = quiet;
  }
}
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

await testAsync("the key travels as the whole Authorization header value", async () => {
  await withFetch(() => json(200, { ok: 1 }, { "x-api-plan": "free" }), async (calls) => {
    const c = new DexPaprika(ledgerStub(), { apiKey: "api_dummy", authHeader: "Authorization", baseUrl: "https://api.dexpaprika.com", callSpacingMs: 0 });
    const out = await c.get("/networks");
    assert.equal(out.ok, true);
    assert.equal(calls[0].headers.Authorization, "api_dummy");
    assert.equal(calls[0].headers["X-Api-Key"], undefined);
    assert.equal(c.plan, "free");
  });
});

await testAsync("api-pro's HTML block page is reported as auth_rejected, not http_error", async () => {
  await withFetch(
    () => new Response("<!DOCTYPE html><title>Attention Required! | Cloudflare</title>", { status: 403, headers: { "content-type": "text/html" } }),
    async () => {
      const c = new DexPaprika(ledgerStub(), { apiKey: "api_dummy", authHeader: "X-Api-Key", baseUrl: "https://api-pro.dexpaprika.com", callSpacingMs: 0 });
      const out = await c.get("/networks/solana/pools/search");
      assert.equal(out.note, "auth_rejected");
      assert.equal(c.authProblem, "auth_rejected");
    }
  );
});

await testAsync("an unrecognised key (401) is auth_rejected", async () => {
  await withFetch(() => json(401, { message: "api key verification has failed" }), async () => {
    const c = new DexPaprika(ledgerStub(), { apiKey: "api_wrong", authHeader: "Authorization", baseUrl: "https://api-pro.dexpaprika.com", callSpacingMs: 0 });
    assert.equal((await c.get("/networks")).note, "auth_rejected");
  });
});

await testAsync("a free key on api-pro moves the client to the public host", async () => {
  await withFetch(
    (url) => (url.startsWith("https://api-pro.") ? json(403, { error: "wrong_host" }) : json(200, { ok: 1 }, { "x-api-plan": "free" })),
    async (calls) => {
      const c = new DexPaprika(ledgerStub(), { apiKey: "api_dummy", authHeader: "Authorization", baseUrl: "https://api-pro.dexpaprika.com", callSpacingMs: 0 });
      assert.equal((await c.get("/networks")).note, "wrong_host");
      assert.equal(c.baseUrl, "https://api.dexpaprika.com");
      const again = await c.get("/networks");
      assert.equal(again.ok, true);
      assert.ok(calls[1].url.startsWith("https://api.dexpaprika.com/"));
    }
  );
});

// ---------------------------------------------------------------------------
// HTTP contract

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "meme-watch-"));
  const port = 8100 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), MW_DATA_DIR: dir, MW_POLL_ON_START: "false", MW_DEXPAPRIKA_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in 10s")), 10000);
      child.stdout.on("data", (buf) => {
        if (String(buf).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("server exited early with code " + code));
      });
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("http");

await withServer(async (base) => {
  const seen = [];

  const call = async (path, init) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    seen.push({ path, text });
    return { res, text, json: JSON.parse(text) };
  };

  await testAsync("the root ping answers 2xx for the RelayMiner", async () => {
    const { res, json } = await call("/");
    assert.equal(res.status, 200);
    assert.equal(json.service, "meme-watch");
  });

  await testAsync("HEAD on the root is accepted", async () => {
    const res = await fetch(base + "/", { method: "HEAD" });
    assert.equal(res.status, 200);
  });

  await testAsync("the identity probe pins the service id", async () => {
    const { res, json } = await call("/v1/version");
    assert.equal(res.status, 200);
    assert.match(json.service, /^meme-watch$/);
  });

  await testAsync("readiness reports warming before the first poll", async () => {
    const { res, json } = await call("/healthz");
    assert.equal(res.status, 503);
    assert.equal(json.status, "warming");
  });

  await testAsync("capabilities reports the window and the upstream budget", async () => {
    const { json } = await call("/v1/capabilities");
    assert.equal(json.window_minutes, 60);
    assert.equal(json.poll_interval_seconds, 120);
    assert.ok(json.upstream.monthly_credit_budget > 0);
    assert.deepEqual(json.formats, ["json", "csv"]);
  });

  await testAsync("the functional probe returns the window with an empty body", async () => {
    const { res, json } = await call("/v1/launches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    assert.equal(json.window_minutes, 60);
    assert.equal(json.count, 0);
    assert.ok(Array.isArray(json.launches));
    assert.ok(typeof json.complete_before === "string");
  });

  await testAsync("csv format rides in a string field", async () => {
    const { json } = await call("/v1/launches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "csv" }),
    });
    assert.equal(json.format, "csv");
    assert.equal(typeof json.csv, "string");
    assert.ok(json.csv.startsWith("pool_address,"));
  });

  await testAsync("an unknown sort is a 400 with a JSON error", async () => {
    const { res, json } = await call("/v1/launches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sort: "nope" }),
    });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "invalid_request");
  });

  await testAsync("a GET on the query path is refused, as a JSON object", async () => {
    const { res, json } = await call("/v1/launches");
    assert.equal(res.status, 405);
    assert.ok(json.error);
  });

  await testAsync("an unknown path is a JSON 404", async () => {
    const { res, json } = await call("/v1/nope");
    assert.equal(res.status, 404);
    assert.equal(json.error.code, "not_found");
  });

  await testAsync("every body starts with a brace and none is empty", async () => {
    for (const { path, text } of seen) {
      assert.ok(text.length > 0, path + " returned an empty body");
      assert.equal(text[0], "{", path + " did not start with a brace");
    }
  });

  await testAsync("no success body carries wording a gateway penalises", async () => {
    const banned = [
      "timeout",
      "connection refused",
      "connection reset",
      "bad gateway",
      "service unavailable",
      "gateway timeout",
    ];
    for (const { path, text } of seen) {
      const head = text.slice(0, 2048).toLowerCase();
      for (const word of banned) {
        assert.ok(!head.includes(word), path + " contains " + word + " in the first 2 KB");
      }
    }
  });
});

console.log(failures ? `\n${failures} test(s) failed` : "\nall tests passed");
process.exit(failures ? 1 : 0);
