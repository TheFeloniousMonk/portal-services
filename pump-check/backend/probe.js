// Builds and reads the honeypot probe call (see ../probe/Probe.sol).
//
// The probe never exists on chain. Its runtime code is placed at PROBE_ADDRESS
// with an eth_call state override, the caller is given a balance with
// another, and one eth_call buys a little of the token through its pool and
// sells it all back. What each leg received is the evidence; the tax and
// "can it be sold" results are computed from it here.

import { readFileSync } from "node:fs";
import { selector, word, words, wordToBigInt, hashWords, ZERO_ADDRESS } from "./abi.js";

const ARTIFACT = JSON.parse(readFileSync(new URL("./probe-artifact.json", import.meta.url), "utf8"));
export const PROBE_RUNTIME = ARTIFACT.runtime;

// Arbitrary addresses with no code or history on any chain, so the token
// sees an ordinary first-time buyer.
export const PROBE_ADDRESS = "0x9c0b3e00000000000000000000000000000c0b3e";
export const PROBE_CALLER = "0x9c0b3e00000000000000000000000000000ca11e";

export const KIND = Object.freeze({ univ2: 1, solidly: 2, univ3: 3, univ4: 4, pons_curve: 5 });

const PROBE_SELECTOR = selector(
  "probe((uint8,address,address,address,address,uint256,(address,address,uint24,int24,address)))"
);

// r: {kind, pool, token, quote, weth, amountIn, key?}
export function encodeProbe(r) {
  const key = r.key || { currency0: ZERO_ADDRESS, currency1: ZERO_ADDRESS, fee: 0, tickSpacing: 0, hooks: ZERO_ADDRESS };
  return (
    PROBE_SELECTOR +
    [
      KIND[r.kind] ?? r.kind,
      r.pool,
      r.token,
      r.quote,
      r.weth || ZERO_ADDRESS,
      r.amountIn,
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]
      .map(word)
      .join("")
  );
}

// The eth_call transaction and the state overrides that make it run.
// `quoteSlot` overrides an ERC-20 quote's balance for the probe when the quote
// is neither native nor wrapped native (see findBalanceSlot).
//
// A sell-only run (amountIn 0) instead gives the probe `sellAmount` of the
// token through `tokenSlot`, so a holder's sell is tested without a buy in the
// same block.
export function buildProbeCall(r, { quoteSlot = null, tokenSlot = null, sellAmount = 0n } = {}) {
  const native = r.quote === ZERO_ADDRESS || r.quote === r.weth;
  if (BigInt(r.amountIn) === 0n) {
    if (!tokenSlot) throw new Error("a sell-only probe needs the token's balance slot");
    return {
      tx: { from: PROBE_CALLER, to: PROBE_ADDRESS, data: encodeProbe(r), gas: "0x1c9c380" },
      overrides: {
        [PROBE_ADDRESS]: { code: PROBE_RUNTIME },
        [PROBE_CALLER]: { balance: "0x" + (10n ** 18n).toString(16) },
        [r.token]: { stateDiff: { [tokenSlot.slotFor(PROBE_ADDRESS)]: "0x" + word(sellAmount) } },
      },
    };
  }
  const tx = {
    from: PROBE_CALLER,
    to: PROBE_ADDRESS,
    data: encodeProbe(r),
    gas: "0x1c9c380", // 30M; the probe uses a few hundred thousand
  };
  if (native) tx.value = "0x" + BigInt(r.amountIn).toString(16);
  const overrides = {
    [PROBE_ADDRESS]: { code: PROBE_RUNTIME },
    [PROBE_CALLER]: { balance: "0x" + (BigInt(r.amountIn) * 4n + 10n ** 18n).toString(16) },
  };
  if (!native && quoteSlot) {
    overrides[r.quote] = { stateDiff: { [quoteSlot.slotFor(PROBE_ADDRESS)]: "0x" + word(BigInt(r.amountIn) * 2n) } };
  }
  return { tx, overrides };
}

// Two Leg structs, each with a dynamic `err`, so the return is two offsets
// followed by the tuples.
export function decodeProbe(hex) {
  const w = words(hex);
  if (w.length < 2) return null;
  const leg = (offsetWords) => {
    const base = offsetWords;
    const f = (i) => wordToBigInt(w[base + i]);
    const errOffset = Number(f(5)) / 32;
    const errLen = Number(wordToBigInt(w[base + errOffset]));
    const errHex = w.slice(base + errOffset + 1, base + errOffset + 1 + Math.ceil(errLen / 32)).join("").slice(0, errLen * 2);
    return {
      ok: f(0) === 1n,
      expected: f(1),
      received: f(2),
      sent: f(3),
      arrived: f(4),
      err: errLen ? "0x" + errHex : null,
    };
  };
  return { buy: leg(Number(wordToBigInt(w[0])) / 32), sell: leg(Number(wordToBigInt(w[1])) / 32) };
}

const bpsLoss = (expected, received) => {
  if (expected <= 0n) return null;
  if (received >= expected) return 0;
  return Number(((expected - received) * 10000n) / expected) / 100;
};

// Turns the two legs into the check results. Percentages are of the amount
// the pool sent (buy) or should have paid for what arrived (sell), so the
// pool's own swap fee is not counted as a token tax.
export function interpretProbe(p) {
  if (!p) return { can_sell: null, reason: "probe returned nothing" };
  if (!p.buy.ok) return { can_buy: false, can_sell: null, buy_error: revertReason(p.buy.err), reason: "the probe buy reverted" };
  // The pool paid nothing: no usable liquidity at this size, not a tax.
  if (p.buy.expected === 0n) return { can_buy: null, can_sell: null, reason: "the pool paid out nothing for the probe's buy (no usable liquidity)" };
  if (p.buy.received === 0n) return { can_buy: true, can_sell: null, buy_tax_pct: 100, reason: "the pool sent tokens but none arrived (a 100% buy tax)" };
  const buyTax = bpsLoss(p.buy.expected, p.buy.received);
  if (!p.sell.ok) {
    return { can_buy: true, can_sell: false, buy_tax_pct: buyTax, sell_error: revertReason(p.sell.err), reason: "selling the tokens just bought reverted" };
  }
  // Tax taken in transit (fee-on-transfer) shows as tokens that never reached
  // the pool; tax taken on the way out shows as quote that never arrived.
  const transitLoss = p.sell.sent > 0n ? bpsLoss(p.sell.sent, p.sell.arrived) : 0;
  const payoutLoss = bpsLoss(p.sell.expected, p.sell.received);
  const sellTax = Math.min(100, Math.round(((1 - (1 - transitLoss / 100) * (1 - payoutLoss / 100)) * 100) * 100) / 100);
  return {
    can_buy: true,
    can_sell: p.sell.received > 0n,
    buy_tax_pct: buyTax,
    sell_tax_pct: sellTax,
    amounts: {
      buy_expected: p.buy.expected.toString(),
      buy_received: p.buy.received.toString(),
      sell_sent: p.sell.sent.toString(),
      sell_arrived: p.sell.arrived.toString(),
      sell_expected: p.sell.expected.toString(),
      sell_received: p.sell.received.toString(),
    },
  };
}

// Error(string) and Panic(uint256) decoded; anything else as its selector.
// The text is third-party, so the response escaping still applies to it.
export function revertReason(errHex) {
  if (!errHex || errHex === "0x") return "reverted without a reason";
  if (errHex.startsWith("0x08c379a0")) {
    const body = errHex.slice(10);
    const len = Number(BigInt("0x" + body.slice(64, 128)));
    return Buffer.from(body.slice(128, 128 + len * 2), "hex").toString("utf8").slice(0, 200);
  }
  if (errHex.startsWith("0x4e487b71")) return "panic 0x" + BigInt("0x" + errHex.slice(10, 74)).toString(16);
  return "custom error " + errHex.slice(0, 10);
}

// ERC-20 balances live in a mapping at a slot that varies by implementation.
// Each candidate slot is tried by overriding it and reading balanceOf back;
// the first one that moves is the token's balance slot. Solidity mappings
// hash (holder, slot); Vyper and some others hash (slot, holder).
export async function findBalanceSlot(evmCall, token, { maxSlot = 12 } = {}) {
  const probeHolder = PROBE_ADDRESS;
  const marker = 0x1234567890n;
  const data = selector("balanceOf(address)") + word(probeHolder);
  const candidates = [];
  for (let slot = 0; slot <= maxSlot; slot++) for (const order of ["solidity", "vyper"]) candidates.push({ slot, order });
  // All candidates at once; the lowest matching slot wins.
  const hits = await Promise.all(
    candidates.map(async ({ slot, order }) => {
      const key = order === "solidity" ? hashWords(probeHolder, slot) : hashWords(slot, probeHolder);
      const res = await evmCall({ to: token, data }, { [token]: { stateDiff: { [key]: "0x" + word(marker) } } }).catch(() => null);
      return Boolean(res) && BigInt(res) === marker;
    })
  );
  const i = hits.indexOf(true);
  if (i === -1) return null;
  const { slot, order } = candidates[i];
  return { slot, order, slotFor: (holder) => (order === "solidity" ? hashWords(holder, slot) : hashWords(slot, holder)) };
}
