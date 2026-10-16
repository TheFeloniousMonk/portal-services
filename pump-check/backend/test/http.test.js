// HTTP tests against the real server, answering from a recorded live session
// (test/fixtures/session.json; see capture.mjs). Each token was chosen for
// one behaviour, and the assertions are the facts the chain gave on capture.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { build, createServer } from "../server.js";
import { Store } from "../store.js";
import { loadSession, replayFetch } from "./replay.js";

const session = loadSession();
const misses = [];
let server;
let base;

before(async () => {
  const app = build({ store: new Store(":memory:"), fetchImpl: replayFetch(session, { misses }), dexpaprikaOptions: { spacingMs: 0 } });
  // Tests start past warm-up: ingest is not what they exercise.
  app.ingest.stats.last_ok_at = new Date().toISOString();
  server = createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = async (path, body) => {
  const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) };
};
const get = async (path) => {
  const res = await fetch(base + path);
  return { status: res.status, json: await res.json() };
};

const results = {};
test("checks each recorded token, in the recorded order", async () => {
  for (const { chain, address } of session.tokens) {
    const r = await post("/v1/check", { tokens: [{ chain, address }], detail: "full" });
    assert.equal(r.status, 200);
    assert.equal(r.text[0], "{");
    assert.equal(r.json.service, "pump-check");
    assert.match(r.json.disclaimer, /Not financial advice/);
    results[address] = r.json.results[0];
  }
  assert.deepEqual(misses, [], "every chain question was in the recording");
});

const R = (addr) => results[addr];

test("USDC is a known asset: ok, its authorities reported as info", () => {
  const r = R("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  assert.equal(r.known_asset, true);
  assert.equal(r.verdict, "ok");
  assert.equal(r.checks.freeze_authority.value, "7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar"); // the card's functional probe
  assert.equal(r.checks.freeze_authority.result, "fail");
  assert.ok(r.flags.every((f) => f.severity === "info"));
  assert.equal(r.checks.holder_concentration.result, "not_available");
});

test("a migrated Pump.fun token: authorities renounced, LP burned", () => {
  const r = R("2FcRrTiT3i25mRb1emE9TA7jNj3VwLgUHi1pyo39pump");
  assert.equal(r.checks.mint_authority.result, "pass");
  assert.equal(r.checks.freeze_authority.result, "pass");
  assert.equal(r.checks.metadata_mutable.result, "pass");
  assert.equal(r.checks.lp_status.value.burned_pct, 100);
  assert.equal(r.token.launchpad, "pumpfun");
  assert.ok(["ok", "caution"].includes(r.verdict));
  assert.equal(r.checks.mint_authority.source, "live");
  assert.ok(r.checks.mint_authority.as_of.slot > 0);
});

test("a Pump.fun token on its curve", () => {
  const r = R("C3442L8JeNjUWuM3wqR65F8EY5RvGAwm9Cq5UsF5pump");
  assert.equal(r.checks.launch_state.result, "info");
  assert.equal(r.checks.launch_state.value.on_curve, true);
  assert.equal(r.checks.lp_status.value.held_by, "pumpfun_bonding_curve");
});

test("a sellable Uniswap v2 token with unburned LP is caution", () => {
  const r = R("0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14");
  assert.equal(r.checks.honeypot.result, "pass");
  assert.equal(r.checks.honeypot.value.can_sell, true);
  assert.equal(r.checks.sell_tax.result, "pass");
  assert.equal(r.checks.lp_status.result, "warn");
  assert.equal(r.verdict, "caution");
  assert.equal(r.checks.honeypot.evidence.venue.dex, "uniswap_v2");
});

test("the USDC-paired honeypot is danger: the sell reverts", () => {
  const r = R("0xd7da87d7dfe7524a72dc1b5930fc611836c39be2");
  assert.equal(r.verdict, "danger");
  assert.equal(r.checks.honeypot.result, "fail");
  assert.equal(r.checks.honeypot.value.can_buy, true);
  assert.equal(r.checks.honeypot.value.can_sell, false);
  assert.equal(r.flags[0].id, "honeypot");
  assert.equal(r.flags[0].severity, "critical");
});

test("an owner that has not renounced is a warning", () => {
  const r = R("0x90eb0e291e9d78a96bfe423b8e616a02c4838cf0");
  assert.equal(r.checks.owner.result, "warn");
  assert.ok(r.flags.some((f) => f.id === "owner" && f.severity === "warning"));
});

test("a Pons token on its curve: sellable, fees read from the curve", () => {
  const r = R("0xaed26758e1454cf9d2a0c103b3b3e54e425417b1");
  assert.equal(r.token.launchpad, "pons");
  assert.equal(r.checks.launch_state.value.launchpad, "pons");
  assert.equal(r.checks.launch_state.value.on_curve, true);
  assert.equal(r.checks.launch_state.value.fee_bps, 100);
  assert.equal(r.checks.honeypot.value.can_sell, true);
  assert.ok(r.checks.honeypot.value.round_trip_loss_pct > 0);
  assert.equal(r.checks.lp_status.value.held_by, "pons_bonding_curve");
});

test("a Robinhood v4 token simulates through the PoolManager", () => {
  const r = R("0x94fc9ed527fc12d3c25229c44922e210f7e9fef0");
  assert.equal(r.checks.honeypot.result, "pass");
  assert.equal(r.checks.honeypot.evidence.venue.dex, "uniswap_v4");
});

test("the copycat USDG is danger: the owner can still mint, blacklist or pause", () => {
  const r = R("0x5fc5a1f152a98ae93eb71cccf76ac0dc5f1ad168");
  assert.equal(r.known_asset, false);
  assert.equal(r.verdict, "danger");
  assert.equal(r.checks.privileged_functions.result, "fail");
  assert.equal(r.checks.privileged_functions.method, "heuristic");
});

test("standard detail drops evidence and endpoints", async () => {
  const r = await post("/v1/check", { tokens: [{ chain: "base", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14" }] });
  const c = r.json.results[0].checks.honeypot;
  assert.equal(c.evidence, undefined);
  assert.equal(c.endpoint, undefined);
  assert.equal(r.json.results[0].flags[0].evidence, undefined);
});

test("bad input is a 400 JSON object", async () => {
  for (const body of [
    "not json",
    {},
    { tokens: [] },
    { tokens: [{ chain: "ethereum", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14" }] },
    { tokens: [{ chain: "base", address: "So11111111111111111111111111111111111111112" }] },
    { tokens: [{ chain: "solana", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14" }] },
    { tokens: Array.from({ length: 11 }, () => ({ chain: "base", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14" })) },
    { tokens: [{ chain: "base", address: "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14" }], detail: "verbose" },
  ]) {
    const r = await post("/v1/check", body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.text[0], "{");
    assert.ok(r.json.error.code);
  }
  const g = await fetch(base + "/v1/check");
  assert.equal(g.status, 405);
});

test("recent answers from the store, filtered", async () => {
  const r = await post("/v1/recent", { chain: "base", verdict: "danger" });
  assert.equal(r.status, 200);
  assert.ok(r.json.results.every((x) => x.verdict === "danger"));
  assert.equal((await post("/v1/recent", { chain: "tron" })).status, 400);
});

test("identity, capabilities, openapi, ping", async () => {
  const v = await get("/v1/version");
  assert.equal(v.json.service, "pump-check");
  const c = await get("/v1/capabilities");
  assert.deepEqual(c.json.chains, ["solana", "base", "robinhood"]);
  assert.ok(c.json.rpc.base.endpoints[0].host.includes("pocket"));
  const o = await get("/v1/openapi.json");
  assert.equal(o.json.openapi, "3.1.0");
  assert.equal((await get("/")).json.status, "ok");
  assert.equal((await get("/nope")).status, 404);
});
