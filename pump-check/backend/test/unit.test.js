// Unit tests: pure functions and the components that guard budgets and
// failover. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeCall, selector, decodeString, decodeAddress, hashWords, word } from "../abi.js";
import { decodeProbe, interpretProbe, encodeProbe, revertReason } from "../probe.js";
import { pushedSelectors } from "../evm.js";
import { pumpCurveAddress, associatedTokenAddress, parsePumpCurve, parsePumpSwapPool, pumpSwapLp, mintChecks, readMint, isSolanaAddress, b58decode, b58encode } from "../solana.js";
import { ChainRpc } from "../rpc.js";
import { Store } from "../store.js";
import { DexPaprika, NOTE } from "../dexpaprika.js";
import { buildVerdict } from "../verdict.js";
import { escapeGatewayPhrases } from "../server.js";
import { memeSides } from "../ingest.js";

// ---- ABI ----

test("selectors and string decoding", () => {
  assert.equal(selector("transfer(address,uint256)"), "0xa9059cbb");
  assert.equal(encodeCall("0x70a08231", "0x00000000000000000000000000000000000000aa").length, 10 + 64);
  // dynamic string "PUMP"
  const s = "0x" + word(32) + word(4) + Buffer.from("PUMP").toString("hex").padEnd(64, "0");
  assert.equal(decodeString(s), "PUMP");
  // bytes32 symbol (old tokens)
  assert.equal(decodeString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0")), "MKR");
  // an "address" with dirty upper bytes is not an address
  assert.equal(decodeAddress("0x" + "f".repeat(64)), null);
});

test("v4 pool id is keccak of the encoded key", () => {
  // Pons graduated pool key layout; a stable vector computed once.
  const id = hashWords("0x0000000000000000000000000000000000000000", "0x94fc9ed527fc12d3c25229c44922e210f7e9fef0", 0, 60, "0x0000000000000000000000000000000000000000");
  assert.equal(id, "0x991c425a46b4d2d3f614c61676eb7a527e7d39f9486afe0ead0d85ab4579452c");
});

// ---- probe ----

function legsHex(buy, sell) {
  const leg = (l) => [l.ok ? 1 : 0, l.expected, l.received, l.sent || 0, l.arrived || 0, 6 * 32, 0].map(word).join("");
  const b = leg(buy);
  return "0x" + word(64) + word(64 + b.length / 2) + b + leg(sell);
}

test("probe decoding and interpretation", () => {
  const ok = decodeProbe(legsHex({ ok: true, expected: 1000n, received: 1000n }, { ok: true, expected: 50n, received: 50n, sent: 1000n, arrived: 1000n }));
  assert.deepEqual(interpretProbe(ok).can_sell, true);
  assert.equal(interpretProbe(ok).sell_tax_pct, 0);

  // 10% taken in transit, 10% more on the payout: 19% overall.
  const taxed = decodeProbe(legsHex({ ok: true, expected: 1000n, received: 950n }, { ok: true, expected: 100n, received: 90n, sent: 950n, arrived: 855n }));
  const r = interpretProbe(taxed);
  assert.equal(r.buy_tax_pct, 5);
  assert.equal(r.sell_tax_pct, 19);

  const blocked = decodeProbe(legsHex({ ok: true, expected: 1000n, received: 1000n }, { ok: false, expected: 0n, received: 0n }));
  assert.equal(interpretProbe(blocked).can_sell, false);

  // An empty pool pays nothing: unknown, not a 100% tax.
  const empty = decodeProbe(legsHex({ ok: true, expected: 0n, received: 0n }, { ok: false, expected: 0n, received: 0n }));
  assert.equal(interpretProbe(empty).can_buy, null);
  assert.equal(interpretProbe(empty).buy_tax_pct, undefined);
});

test("probe request encoding is fully static", () => {
  const hex = encodeProbe({ kind: "univ2", pool: "0x" + "11".repeat(20), token: "0x" + "22".repeat(20), quote: "0x" + "33".repeat(20), amountIn: 5n });
  assert.equal((hex.length - 10) / 64, 11);
});

test("revert reasons", () => {
  const err = "0x08c379a0" + word(32) + word(15) + Buffer.from("transfer failed").toString("hex").padEnd(64, "0");
  assert.equal(revertReason(err), "transfer failed");
  assert.equal(revertReason("0xe450d38c" + word(1)), "custom error 0xe450d38c");
});

test("privileged selectors are read from PUSH4 only", () => {
  const mint = selector("mint(address,uint256)").slice(2);
  // PUSH4 mint ; PUSH1 0x63 (data byte that looks like PUSH4 must be skipped)
  assert.ok(pushedSelectors("0x63" + mint + "6063").has(mint));
  assert.equal(pushedSelectors("0x60" + "63" + mint).has(mint), false);
});

// ---- Solana ----

test("program-derived addresses match live accounts", () => {
  assert.equal(pumpCurveAddress("5M9zRx61okfjBVqkuTRUJvxvAzCj2w3xRQxd8vHLpump"), "4zYD5oxHRjiq5MTn1HErm1x26bmfD9SFRWhBwehc8wer");
  assert.equal(
    associatedTokenAddress("GZByQPgsC6hqdX3z7izvHKkzxCcZAFyRN6eyV1nXzsYH", "2FcRrTiT3i25mRb1emE9TA7jNj3VwLgUHi1pyo39pump", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    "7wct6m2NjtDCiU3pgqgv1yaUrJ64szhi6r3fT6E3ZuVT"
  );
  const pk = "So11111111111111111111111111111111111111112";
  assert.equal(b58encode(b58decode(pk)), pk);
  assert.ok(isSolanaAddress(pk));
  assert.ok(!isSolanaAddress("0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14"));
});

test("Pump.fun curve and PumpSwap pool layouts", () => {
  const curve = Buffer.from(
    "17b7f83760d8ac600010d847e3cf030008ac23fc060000000078c5fb51d1020008000000000000000080c6a47e8d030000c524009a94b254cc599e1d8f0f186048475e636e9923235e16baf954d33f2c3101",
    "hex"
  );
  const c = parsePumpCurve(Buffer.concat([curve, Buffer.alloc(85)]));
  assert.equal(c.virtualTokenReserves, 1073000000000000n);
  assert.equal(c.tokenTotalSupply, 1000000000000000n);
  assert.equal(c.complete, false);
  assert.equal(c.creator, "EGZA7aU16g4Fgmgsgyuk4jRDRXaWu9krgnrxVH7NnJfS");

  const pool = Buffer.alloc(301);
  pool.writeBigUInt64LE(4193388286354n, 203);
  const p = parsePumpSwapPool(pool);
  assert.equal(pumpSwapLp(p, 0n).burnedPct, 100);
  assert.equal(pumpSwapLp(p, 4193388286354n).burnedPct, 0);
});

test("Token-2022 extensions that can stop a sale fail", () => {
  const mint = readMint({
    owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    data: {
      parsed: {
        type: "mint",
        info: {
          decimals: 6,
          supply: "100",
          mintAuthority: null,
          freezeAuthority: null,
          extensions: [
            { extension: "permanentDelegate", state: { delegate: "Dele11111111111111111111111111111111111111" } },
            { extension: "transferHook", state: { programId: "Hook1111111111111111111111111111111111111", authority: null } },
            { extension: "transferFeeConfig", state: { newerTransferFee: { transferFeeBasisPoints: 300 }, transferFeeConfigAuthority: null } },
          ],
        },
      },
    },
  });
  const c = mintChecks(mint, 1, "x");
  assert.equal(c.mint_authority.result, "pass");
  assert.equal(c.token2022_extensions.result, "fail");
  assert.equal(c.transfer_hook.result, "fail");
});

// ---- RPC failover ----

const rpcOpts = { rpcDeadlineMs: 500, rpcMaxLag: 20, rpcMaxLagSlots: 50, logPageBlocks: 1000, breakerFailures: 2, breakerCooldownMs: 60000 };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

test("a 429 moves to the next endpoint; a revert is the answer", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(new URL(url).host);
    const body = JSON.parse(init.body);
    if (url.includes("a.test")) return json({}, 429);
    if (body.method === "eth_call") return json({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted", data: "0x" } });
    return json({ jsonrpc: "2.0", id: 1, result: "0x10" });
  };
  const rpc = new ChainRpc("base", "evm", [{ url: "https://a.test" }, { url: "https://b.test" }], rpcOpts, fetchImpl);
  const r = await rpc.call("eth_blockNumber", []);
  assert.equal(r.result, "0x10");
  assert.equal(r.endpoint, "b.test");
  // the revert from b.test is not retried elsewhere
  seen.length = 0;
  await assert.rejects(rpc.call("eth_call", [{}, "latest"]), (e) => e.kind === "rejected");
  assert.ok(!seen.includes("c.test"));
});

test("precompute calls do not fail over", async () => {
  const fetchImpl = async (url) => (url.includes("a.test") ? json({}, 503) : json({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  const rpc = new ChainRpc("base", "evm", [{ url: "https://a.test" }, { url: "https://b.test" }], rpcOpts, fetchImpl);
  await assert.rejects(rpc.call("eth_blockNumber", [], { failover: false }), (e) => e.kind === "unavailable");
});

test("the breaker skips an endpoint after consecutive failures", async () => {
  const hits = { a: 0, b: 0 };
  const fetchImpl = async (url) => {
    if (url.includes("a.test")) {
      hits.a++;
      throw new TypeError("down");
    }
    hits.b++;
    return json({ jsonrpc: "2.0", id: 1, result: "0x1" });
  };
  const rpc = new ChainRpc("base", "evm", [{ url: "https://a.test" }, { url: "https://b.test" }], rpcOpts, fetchImpl);
  for (let i = 0; i < 5; i++) await rpc.call("eth_blockNumber", []);
  assert.equal(hits.a, 2); // opened after 2 failures, then skipped
  assert.equal(hits.b, 5);
  assert.equal(rpc.endpoints[0].status().state, "open");
});

// ---- DexPaprika ledger ----

test("the ledger counts a rolling 30 days, not a calendar month", () => {
  const store = new Store(":memory:");
  const H = 3600000;
  const now = Date.UTC(2026, 9, 31, 23);
  store.spendCredits(500, now - 29 * 24 * H); // 29 days ago: inside the window
  store.spendCredits(300, now - 31 * 24 * H); // 31 days ago: outside
  store.spendCredits(100, now);
  assert.equal(store.creditsSpent({ now }), 600);
  // across the month boundary the earlier spend still counts
  assert.equal(store.creditsSpent({ now: now + 2 * H }), 600);
});

test("spending stops at the ceiling and the fallback cap", async () => {
  const store = new Store(":memory:");
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const dp = new DexPaprika(store, { fetchImpl, spacingMs: 0, monthlyCredits: 3, fallbackPerHour: 1, apiKey: "" });
  assert.equal((await dp.get("/x", {}, { fallback: true })).ok, true);
  assert.equal((await dp.get("/x", {}, { fallback: true })).note, NOTE.FALLBACK_CAP);
  await dp.get("/x");
  await dp.get("/x");
  assert.equal((await dp.get("/x")).note, NOTE.BUDGET_EXHAUSTED);
  assert.equal(calls, 3);
});

// ---- verdict ----

test("verdict rules", () => {
  const pass = { result: "pass", method: "definitive" };
  const evm = { honeypot: pass, proxy: pass, privileged_functions: pass, sell_tax: pass };
  assert.equal(buildVerdict("base", evm).verdict, "ok");
  assert.equal(buildVerdict("base", { ...evm, lp_status: { result: "warn" } }).verdict, "caution");
  assert.equal(buildVerdict("base", { ...evm, honeypot: { result: "unknown" } }).verdict, "unknown");
  assert.equal(buildVerdict("base", { ...evm, honeypot: { result: "unknown" }, proxy: { result: "fail" } }).verdict, "danger");
  // not_available never makes a verdict unknown
  assert.equal(buildVerdict("base", { ...evm, holder_concentration: { result: "not_available" } }).verdict, "ok");
  // a known asset is ok and its flags are info
  const sol = { mint_authority: { result: "fail" }, freeze_authority: { result: "fail" }, token2022_extensions: pass, transfer_hook: pass };
  const k = buildVerdict("solana", sol, { knownAsset: true });
  assert.equal(k.verdict, "ok");
  assert.ok(k.flags.every((f) => f.severity === "info"));
  assert.equal(buildVerdict("solana", sol).verdict, "danger");
});

// ---- response safety ----

test("gateway phrases in token names are escaped but decode unchanged", () => {
  const body = escapeGatewayPhrases(JSON.stringify({ name: "Timeout Inu", symbol: "BAD GATEWAY" }));
  assert.ok(!/timeout/i.test(body) && !/bad gateway/i.test(body));
  assert.deepEqual(JSON.parse(body), { name: "Timeout Inu", symbol: "BAD GATEWAY" });
});

test("the memecoin side of a pool row", () => {
  const row = { tokens: [{ id: "So11111111111111111111111111111111111111112" }, { id: "Abc111pump" }] };
  assert.deepEqual(memeSides("solana", row), { memes: ["Abc111pump"], quote: "So11111111111111111111111111111111111111112" });
  const evmRow = { tokens: [{ id: "0x4200000000000000000000000000000000000006" }, { id: "0xABCDEF0000000000000000000000000000000001" }] };
  assert.deepEqual(memeSides("base", evmRow).memes, ["0xabcdef0000000000000000000000000000000001"]);
});
