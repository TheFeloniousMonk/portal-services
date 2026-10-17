// Base and Robinhood Chain: identity, contract checks, the honeypot probe,
// liquidity, LP status, holders and sniper analysis (SPEC section 4).
//
// Reads are pinned to one block so a check's results agree with each other.
// Every check records the block it used and which endpoint answered.

import { selector, encodeCall, decodeAddress, decodeUint, decodeString, words, wordToAddress, wordToBigInt, wordToSigned, keccakText, hashWords, word } from "./abi.js";
import {
  EVM,
  EVM_QUOTES,
  EVM_KNOWN_ASSETS,
  EVM_LAUNCHPADS,
  LOCKING_LAUNCHPADS,
  EVM_LP_LOCKERS,
  EVM_KNOWN_HOOKS,
  EVM_DEX_KIND,
  BURN_ADDRESSES,
  ZERO,
} from "./chains.js";
import { buildProbeCall, decodeProbe, interpretProbe, findBalanceSlot } from "./probe.js";

const S = Object.fromEntries(
  Object.entries({
    name: "name()",
    symbol: "symbol()",
    decimals: "decimals()",
    totalSupply: "totalSupply()",
    balanceOf: "balanceOf(address)",
    owner: "owner()",
    getOwner: "getOwner()",
    implementation: "implementation()",
    token0: "token0()",
    token1: "token1()",
    getReserves: "getReserves()",
    getLaunchedToken: "getLaunchedToken(address)",
    graduated: "graduated()",
    readyToGraduate: "readyToGraduate()",
    feeBps: "feeBps()",
    creatorTaxBps: "creatorTaxBps()",
    snipeTaxStartBps: "snipeTaxStartBps()",
    snipeTaxSeconds: "snipeTaxSeconds()",
    launchedAt: "launchedAt()",
    curveGetReserves: "getReserves()",
  }).map(([k, sig]) => [k, selector(sig)])
);

// EIP-1967 and EIP-1822 storage slots.
const SLOT = {
  impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  uups: "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7",
};

// Owner-only functions that can stop or tax a holder, by category. Found as
// PUSH4 constants in the runtime bytecode, so no verified source is needed;
// a match is a strong signal, not proof (method "heuristic").
const PRIVILEGED = {
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "issue(uint256)"],
  blacklist: [
    "blacklist(address)",
    "blacklist(address,bool)",
    "addToBlacklist(address)",
    "setBlacklist(address,bool)",
    "setBlacklisted(address,bool)",
    "updateBlacklist(address,bool)",
    "blacklistAddress(address,bool)",
    "addBot(address)",
    "addBots(address[])",
    "setBots(address[],bool)",
    "blockBots(address[])",
    "setBot(address,bool)",
    "setSniper(address,bool)",
  ],
  pause: ["pause()", "setPaused(bool)", "pauseTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "enableTrading(bool)", "toggleTrading()"],
  fee: [
    "setFee(uint256)",
    "setFees(uint256,uint256)",
    "setTaxes(uint256,uint256)",
    "setBuyFee(uint256)",
    "setSellFee(uint256)",
    "setTax(uint256)",
    "setTaxes(uint256,uint256,uint256)",
    "updateFees(uint256,uint256)",
    "setSellTax(uint256)",
    "setBuyTax(uint256)",
    "setTaxFeePercent(uint256)",
    "updateBuyFees(uint256,uint256,uint256)",
    "updateSellFees(uint256,uint256,uint256)",
    "setFeePercent(uint256)",
  ],
  max_transaction: [
    "setMaxTxAmount(uint256)",
    "setMaxWalletSize(uint256)",
    "setMaxWallet(uint256)",
    "updateMaxTxnAmount(uint256)",
    "updateMaxWalletAmount(uint256)",
    "setMaxTxPercent(uint256)",
    "setMaxTransactionAmount(uint256)",
  ],
};
const PRIVILEGED_SELECTORS = new Map();
for (const [cat, sigs] of Object.entries(PRIVILEGED)) for (const sig of sigs) PRIVILEGED_SELECTORS.set(selector(sig).slice(2), { cat, sig });

// Swap events, per venue.
export const TOPIC = {
  v2Swap: keccakText("Swap(address,uint256,uint256,uint256,uint256,address)"),
  solidlySwap: keccakText("Swap(address,address,uint256,uint256,uint256,uint256)"),
  v3Swap: keccakText("Swap(address,address,int256,int256,uint160,uint128,int24)"),
  v4Swap: keccakText("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"),
  v4Initialize: keccakText("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"),
  ponsCurveBuy: keccakText("CurveBuy(address,address,uint256,uint256,uint256,uint256)"),
  ponsLaunched: keccakText("TokenLaunched(address,address,address,address,uint256,uint256)"),
  transfer: keccakText("Transfer(address,address,uint256)"),
};

const lc = (a) => (a ? String(a).toLowerCase() : a);
const pctOf = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) / 100 : null);

// PUSH4 operands in runtime bytecode, skipping other PUSH data.
export function pushedSelectors(code) {
  const hex = (code || "0x").slice(2);
  const out = new Set();
  for (let i = 0; i < hex.length; ) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    if (op === 0x63) out.add(hex.slice(i + 2, i + 10).toLowerCase());
    i += 2 + (op >= 0x60 && op <= 0x7f ? (op - 0x5f) * 2 : 0);
  }
  return out;
}

const MINIMAL_PROXY = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i;

export class EvmChain {
  constructor(chain, rpc, { blockscout = null, config }) {
    this.chain = chain;
    this.rpc = rpc;
    this.blockscout = blockscout;
    this.config = config;
    this.addr = EVM[chain];
    this.quotes = EVM_QUOTES[chain];
    this.knownAssets = EVM_KNOWN_ASSETS[chain];
    this.blockTimeMs = null;
    this.slotCache = new Map(); // token -> balance slot, or null
    this.decimalsCache = new Map();
  }

  async call(to, data, block, opts) {
    const r = await this.rpc.ethCall({ to, data }, block, null, opts);
    return r.reverted ? null : r.result;
  }

  // ---- identity ----

  async identity(token, block, opts) {
    const [name, symbol, decimals, supply] = await Promise.all([
      this.call(token, S.name, block, opts),
      this.call(token, S.symbol, block, opts),
      this.call(token, S.decimals, block, opts),
      this.call(token, S.totalSupply, block, opts),
    ]);
    return {
      name: name ? decodeString(name) : null,
      symbol: symbol ? decodeString(symbol) : null,
      decimals: decimals ? Number(decodeUint(decimals)) : null,
      supply: supply ? decodeUint(supply) : null,
    };
  }

  async decimalsOf(token) {
    if (token === ZERO) return 18;
    if (this.decimalsCache.has(token)) return this.decimalsCache.get(token);
    const d = await this.call(token, S.decimals, "latest");
    const n = d ? Number(decodeUint(d)) : 18;
    this.decimalsCache.set(token, n);
    return n;
  }

  // ---- contract structure: code, proxy, owner, privileged functions ----

  async structure(token, block, opts) {
    const { result: code, endpoint } = await this.rpc.getCode(token, block, opts);
    const as_of = { block };
    if (!code || code === "0x") return { isContract: false, endpoint, as_of };

    let proxy = { upgradeable: false, kind: null, implementation: null, admin: null };
    const clone = MINIMAL_PROXY.exec(code);
    if (clone) {
      proxy = { upgradeable: false, kind: "minimal_proxy", implementation: "0x" + clone[1].toLowerCase(), admin: null };
    } else {
      const [impl, admin, beacon, uups] = await Promise.all(
        [SLOT.impl, SLOT.admin, SLOT.beacon, SLOT.uups].map((s) => this.rpc.getStorageAt(token, s, block, opts).then((r) => r.result))
      );
      const addrOf = (w) => (w && BigInt(w) !== 0n ? wordToAddress(words(w)[0]) : null);
      const implAddr = addrOf(impl) || addrOf(uups);
      const beaconAddr = addrOf(beacon);
      if (beaconAddr) {
        const bi = decodeAddress(await this.call(beaconAddr, S.implementation, block, opts));
        const bo = decodeAddress(await this.call(beaconAddr, S.owner, block, opts));
        proxy = { upgradeable: true, kind: "beacon", implementation: bi, admin: beaconAddr, adminOwner: bo };
      } else if (implAddr) {
        const adminAddr = addrOf(admin);
        let adminOwner = null;
        if (adminAddr) {
          const { result: adminCode } = await this.rpc.getCode(adminAddr, block, opts);
          // A ProxyAdmin contract is controlled by its owner; an EOA admin is the controller.
          adminOwner = adminCode && adminCode !== "0x" ? decodeAddress(await this.call(adminAddr, S.owner, block, opts)) : adminAddr;
        }
        proxy = { upgradeable: true, kind: adminAddr ? "transparent" : "uups", implementation: implAddr, admin: adminAddr, adminOwner };
      }
    }

    let owner = decodeAddress(await this.call(token, S.owner, block, opts));
    let ownerFn = "owner()";
    if (owner === null) {
      owner = decodeAddress(await this.call(token, S.getOwner, block, opts));
      ownerFn = owner === null ? null : "getOwner()";
    }
    // UUPS upgrades are authorized in the implementation, almost always by owner().
    if (proxy.kind === "uups") proxy.adminOwner = owner;

    let runtime = code;
    if (proxy.implementation) {
      const r = await this.rpc.getCode(proxy.implementation, block, opts);
      if (r.result && r.result !== "0x") runtime = r.result;
    }
    const found = {};
    for (const sel of pushedSelectors(runtime)) {
      const hit = PRIVILEGED_SELECTORS.get(sel);
      if (hit) (found[hit.cat] = found[hit.cat] || []).push(hit.sig);
    }
    return { isContract: true, endpoint, as_of, proxy, owner, ownerFn, privileged: found, codeSize: (code.length - 2) / 2 };
  }

  // ---- Pons (Robinhood Chain) ----

  async pons(token, block, opts) {
    if (!this.addr.ponsV2Factory) return null;
    const out = await this.call(this.addr.ponsV2Factory, S.getLaunchedToken + word(token), block, opts);
    const w = words(out);
    if (w.length < 15 || wordToBigInt(w[14]) !== 1n) return null;
    const rec = {
      curve: wordToAddress(w[1]),
      deployer: wordToAddress(w[2]),
      pairToken: wordToAddress(w[4]),
      graduationThreshold: wordToBigInt(w[5]),
      poolFee: Number(wordToBigInt(w[6])),
      tickSpacing: Number(wordToSigned(w[7])),
      creatorTaxBps: Number(wordToBigInt(w[8])),
      phase: ["not_graduated", "swept", "pool_created", "rescued"][Number(wordToBigInt(w[10]))] || "unknown",
    };
    const reads = await Promise.all(
      [S.graduated, S.readyToGraduate, S.feeBps, S.snipeTaxStartBps, S.snipeTaxSeconds, S.launchedAt].map((s) =>
        this.call(rec.curve, s, block, opts)
      )
    );
    const n = (h) => (h ? decodeUint(h) : null);
    rec.graduated = n(reads[0]) === 1n;
    rec.readyToGraduate = n(reads[1]) === 1n;
    rec.feeBps = reads[2] ? Number(n(reads[2])) : null;
    rec.snipeTaxStartBps = reads[3] ? Number(n(reads[3])) : null;
    rec.snipeTaxSeconds = reads[4] ? Number(n(reads[4])) : null;
    rec.launchedAt = reads[5] ? Number(n(reads[5])) : null;
    // The graduated pool: Uniswap v4 with the Pons meme hook, its key fixed at launch.
    const [c0, c1] = BigInt(token) < BigInt(rec.pairToken) ? [token, rec.pairToken] : [rec.pairToken, token];
    rec.poolKey = { currency0: c0, currency1: c1, fee: rec.poolFee, tickSpacing: rec.tickSpacing, hooks: this.addr.ponsV2Hook };
    rec.poolId = hashWords(c0, c1, rec.poolFee, rec.tickSpacing, this.addr.ponsV2Hook);
    return rec;
  }

  // The v4 PoolKey for a pool id, from its Initialize event (one block).
  async v4PoolKey(poolId, createdBlock, opts) {
    if (!createdBlock) return null;
    const { result } = await this.rpc.getLogs(
      { address: this.addr.uniV4PoolManager, topics: [TOPIC.v4Initialize, poolId], fromBlock: createdBlock, toBlock: createdBlock },
      opts
    );
    const l = result[0];
    if (!l) return null;
    const d = words(l.data);
    return {
      currency0: wordToAddress(l.topics[2].slice(2)),
      currency1: wordToAddress(l.topics[3].slice(2)),
      fee: Number(wordToBigInt(d[0])),
      tickSpacing: Number(wordToSigned(d[1])),
      hooks: wordToAddress(d[2]),
    };
  }

  // ---- honeypot and tax simulation ----

  // A sensible probe size for the quote asset: about PUMP_PROBE_USD, and never
  // more than 1% of what the pool holds of it.
  async probeAmount(quote, pool) {
    const dec = await this.decimalsOf(quote);
    const sym = this.knownAssets.get(quote) || (quote === ZERO ? "ETH" : null);
    const usd = this.config.probeUsd;
    let units;
    if (sym === "ETH" || sym === "WETH" || sym === "cbETH" || sym === "wstETH") units = usd / 2500;
    else if (sym === "cbBTC") units = usd / 60000;
    else if (["USDC", "USDbC", "USDT", "DAI", "USDG"].includes(sym)) units = usd;
    else units = null; // a stock token or an unpriced quote: sized from the pool
    let amount = units === null ? null : BigInt(Math.max(1, Math.round(units * 10 ** Math.min(dec, 12)))) * 10n ** BigInt(Math.max(0, dec - 12));
    if (pool.quoteReserve) {
      const cap = pool.quoteReserve / 100n;
      if (amount === null || amount > cap) amount = cap;
    }
    return amount && amount > 0n ? amount : null;
  }

  async quoteSlot(quote) {
    if (quote === ZERO || quote === this.addr.weth) return null;
    if (!this.slotCache.has(quote)) {
      const ec = async (tx, ov) => (await this.rpc.ethCall(tx, "latest", ov)).result;
      this.slotCache.set(quote, await findBalanceSlot(ec, quote));
    }
    return this.slotCache.get(quote);
  }

  // Simulates a buy and a sell through the best supported pool, moving to the
  // next one when a pool has no usable liquidity.
  async honeypot(token, pools, block, opts) {
    const usable = pools.filter((p) => p.kind).sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
    if (!usable.length) return { result: "unknown", reason: "no pool on a venue the probe supports", method: "definitive", source: "live", as_of: { block } };
    let last = null;
    for (const pool of usable.slice(0, 3)) {
      last = await this.probePool(token, pool, block, opts);
      if (last.result !== "unknown") return last;
    }
    return last;
  }

  async probePool(token, pool, block, opts) {
    const r = { kind: pool.kind, pool: pool.target, token, quote: pool.quote, weth: this.addr.weth, key: pool.poolKey };
    const amountIn = await this.probeAmount(pool.quote, pool);
    if (!amountIn) return { result: "unknown", reason: "could not size the probe for this quote asset", method: "definitive", source: "live", as_of: { block } };
    r.amountIn = amountIn;
    let quoteSlot = null;
    if (pool.quote !== ZERO && pool.quote !== this.addr.weth) {
      quoteSlot = await this.quoteSlot(pool.quote);
      if (!quoteSlot) return { result: "unknown", reason: "could not fund the probe in this quote asset", method: "definitive", source: "live", as_of: { block } };
    }
    const { tx, overrides } = buildProbeCall(r, { quoteSlot });
    const out = await this.rpc.ethCall(tx, block, overrides, opts);
    if (out.reverted) return { result: "unknown", reason: "the probe call itself failed", method: "definitive", source: "live", endpoint: out.endpoint, as_of: { block } };
    const decoded = decodeProbe(out.result);
    const res = interpretProbe(decoded);
    const venue = { pool: pool.address, dex: pool.dex, quote: pool.quote, amount_in: amountIn.toString() };

    // A sell that fails right after the buy may be a same-block cooldown
    // rather than a honeypot. Re-run as a holder selling an existing balance.
    let sameBlockOnly = false;
    if (res.can_buy && res.can_sell === false) {
      const tokenSlot = await findBalanceSlot(async (t, ov) => (await this.rpc.ethCall(t, block, ov)).result, token);
      if (tokenSlot) {
        const again = buildProbeCall({ ...r, amountIn: 0n }, { tokenSlot, sellAmount: decoded.buy.received || 1n });
        const o2 = await this.rpc.ethCall(again.tx, block, again.overrides, opts);
        const r2 = o2.reverted ? null : interpretProbe(decodeProbe(o2.result));
        if (r2 && r2.can_sell) {
          sameBlockOnly = true;
          res.sell_tax_pct = r2.sell_tax_pct;
        }
      }
    }
    const roundTrip =
      res.can_sell && decoded.sell.received >= 0n ? Math.max(0, Number(((amountIn - decoded.sell.received) * 10000n) / amountIn) / 100) : null;
    return {
      result:
        res.can_buy === false || (res.buy_tax_pct === 100 && res.can_sell === null)
          ? "fail"
          : res.can_buy === null || (res.can_sell === null && !sameBlockOnly)
            ? "unknown"
            : res.can_sell === false && !sameBlockOnly
              ? "fail"
              : sameBlockOnly
                ? "warn"
                : "pass",
      value: {
        can_buy: res.can_buy,
        can_sell: sameBlockOnly ? true : res.can_sell,
        sell_blocked_in_buy_block: sameBlockOnly || undefined,
        buy_tax_pct: res.buy_tax_pct ?? null,
        sell_tax_pct: res.sell_tax_pct ?? null,
        round_trip_loss_pct: roundTrip,
        error: res.sell_error || res.buy_error || undefined,
      },
      reason: res.reason || (sameBlockOnly ? "selling in the same block as the buy reverted; a later sell from a holder went through" : undefined),
      method: sameBlockOnly ? "heuristic" : "definitive",
      source: "live",
      endpoint: out.endpoint,
      as_of: { block },
      evidence: { venue, amounts: res.amounts || null },
    };
  }

  // ---- pools: what the probe can use, liquidity and LP ----

  // Store rows plus the Pons curve or graduated pool, annotated for the probe.
  async preparePools(token, storePools, pons, block, opts, { launchBlock = null } = {}) {
    const out = [];
    for (const p of storePools) {
      // A graduated Pons curve no longer trades; the v4 pool is added below.
      if (p.dex === "pons_curve" && (!pons || pons.graduated)) continue;
      const kind = EVM_DEX_KIND.get(p.dex) || null;
      const row = { address: p.address, dex: p.dex, quote: p.quote, liquidityUsd: p.liquidity_usd, kind, target: p.address, extra: p.extra || {}, createdBlock: p.created_block || null };
      if (kind === "univ4") {
        row.target = this.addr.uniV4PoolManager;
        row.poolKey = p.extra && p.extra.poolKey ? p.extra.poolKey : await this.v4PoolKey(p.address, p.created_block, opts).catch(() => null);
        if (!row.poolKey) row.kind = null;
        else row.quote = row.poolKey.currency0 === token ? row.poolKey.currency1 : row.poolKey.currency0;
      }
      out.push(row);
    }
    for (const p of out) if (p.dex === "pons_curve") {
      p.liquidityUsd = Number.MAX_SAFE_INTEGER;
      p.createdBlock = p.createdBlock || launchBlock;
    }
    if (pons) {
      if (!pons.graduated && !out.some((p) => p.address === pons.curve)) {
        out.unshift({ address: pons.curve, dex: "pons_curve", quote: pons.pairToken, liquidityUsd: Number.MAX_SAFE_INTEGER, kind: "pons_curve", target: pons.curve, extra: {}, createdBlock: launchBlock });
      } else if (!out.some((p) => p.address === pons.poolId)) {
        out.push({ address: pons.poolId, dex: "uniswap_v4", quote: pons.pairToken, liquidityUsd: 0, kind: "univ4", target: this.addr.uniV4PoolManager, poolKey: pons.poolKey, extra: { poolKey: pons.poolKey } });
      }
    }
    // Quote reserves for v2/v3/curve pools size the probe and report liquidity.
    await Promise.all(
      out.map(async (p) => {
        if (p.kind === "univ4") {
          if (p.poolKey) p.token0 = p.poolKey.currency0;
          return;
        }
        if (p.kind === "univ2" || p.kind === "solidly" || p.kind === "univ3") {
          p.token0 = decodeAddress(await this.call(p.address, S.token0, block, opts));
        }
        if (p.kind === "pons_curve") {
          const r = words(await this.call(p.address, S.curveGetReserves, block, opts));
          if (r.length >= 2) p.quoteReserve = wordToBigInt(r[0]);
          return;
        }
        if (!p.quote) return;
        if (p.quote === ZERO) return;
        const bal = await this.call(p.quote, S.balanceOf + word(p.address), block, opts);
        if (bal) p.quoteReserve = decodeUint(bal);
      })
    );
    return out;
  }

  // v2-style pairs: share of LP tokens burned or held by a known locker.
  async lpStatus(token, pools, launchpad, pons, block, opts) {
    const as_of = { block };
    if (pons && !pons.graduated) {
      return { result: "pass", value: { held_by: "pons_bonding_curve" }, reason: "liquidity sits in the Pons bonding curve, which has no withdrawal path", method: "definitive", source: "live", as_of };
    }
    if (pons && pons.graduated && pons.phase === "pool_created") {
      return { result: "pass", value: { held_by: "pons_v2_launch_locker", pool: pons.poolId }, reason: "Pons locks the graduated v4 position permanently in its launch locker", method: "definitive", source: "live", as_of };
    }
    const v2 = pools.filter((p) => p.kind === "univ2" || p.kind === "solidly");
    const lockers = EVM_LP_LOCKERS[this.chain];
    for (const p of v2.sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0)).slice(0, 1)) {
      const supply = decodeUint(await this.call(p.address, S.totalSupply, block, opts));
      if (!supply) break;
      let burned = 0n;
      let locked = 0n;
      const holders = [...BURN_ADDRESSES, ...lockers.keys()];
      const bals = await Promise.all(holders.map((h) => this.call(p.address, S.balanceOf + word(h), block, opts)));
      holders.forEach((h, i) => {
        const v = bals[i] ? decodeUint(bals[i]) : 0n;
        if (BURN_ADDRESSES.has(h)) burned += v;
        else locked += v;
      });
      const share = pctOf(burned + locked, supply);
      return {
        result: share !== null && share >= 95 ? "pass" : "warn",
        value: { pool: p.address, burned_pct: pctOf(burned, supply), locked_pct: pctOf(locked, supply) },
        reason: share !== null && share >= 95 ? null : "most of the pool's LP tokens are neither burned nor in a known locker",
        method: "definitive",
        source: "live",
        as_of,
      };
    }
    if (launchpad && LOCKING_LAUNCHPADS.has(launchpad)) {
      return { result: "pass", value: { launchpad }, reason: "this launchpad locks pool liquidity permanently by design", method: "heuristic", source: "live", as_of };
    }
    return { result: "unknown", reason: "v3 and v4 positions are NFTs whose owners are not read in v1", method: "heuristic", source: "live", as_of };
  }

  // ---- holders (Blockscout) ----

  async holders(token, supply, exclude) {
    const why = this.blockscout ? this.blockscout.unavailable(this.addr.chainId) : "this supplier has no Blockscout key";
    if (why) return { result: "not_available", reason: why, method: null, source: null };
    const list = await this.blockscout.holders(this.addr.chainId, token);
    if (!list) {
      // The first call on a chain is where a plan exclusion shows up.
      const now = this.blockscout.unavailable(this.addr.chainId);
      if (now) return { result: "not_available", reason: now, method: null, source: null };
      return { result: "unknown", reason: this.blockscout.exhausted ? "Blockscout's daily credits are used up" : "Blockscout did not answer", method: "definitive", source: "live" };
    }
    const counted = list.filter((h) => !exclude.has(h.address) && !BURN_ADDRESSES.has(h.address));
    const top = counted.slice(0, 10);
    const sum = top.reduce((n, h) => n + h.value, 0n);
    const share = supply ? pctOf(sum, supply) : null;
    return {
      result: share === null ? "unknown" : share > this.config.topHoldersWarnPct ? "warn" : "pass",
      value: { top10_pct: share, excluded: list.length - counted.length },
      method: "definitive",
      source: "live",
      as_of: { indexer: "blockscout", at: new Date().toISOString() },
      evidence: { holders: top.map((h) => ({ address: h.address, pct: supply ? pctOf(h.value, supply) : null, contract: h.isContract })) },
    };
  }

  async creator(token) {
    if (!this.blockscout || this.blockscout.unavailable(this.addr.chainId)) return null;
    return this.blockscout.creator(this.addr.chainId, token);
  }

  // Why holders and the deployer cannot be read on this chain, or null.
  blockscoutUnavailable() {
    return this.blockscout ? this.blockscout.unavailable(this.addr.chainId) : "this supplier has no Blockscout key";
  }

  // ---- snipers and bundles (computed once, at ingest) ----

  async blockTime() {
    if (this.blockTimeMs) return this.blockTimeMs;
    const head = await this.rpc.blockNumber({ failover: false });
    const span = 1000;
    const [a, b] = await Promise.all(
      [head - span, head].map((n) => this.rpc.call("eth_getBlockByNumber", ["0x" + n.toString(16), false], { failover: false }).then((r) => r.result))
    );
    this.blockTimeMs = Math.max(50, ((Number(BigInt(b.timestamp)) - Number(BigInt(a.timestamp))) * 1000) / span);
    return this.blockTimeMs;
  }

  // Buys in the first PUMP_SNIPER_WINDOW_SECONDS after the pool opened: who
  // bought (the transaction sender, not the router) and what share of supply.
  async snipers(token, pool, supply, opts = { failover: false }) {
    const createdBlock = pool.createdBlock;
    if (!createdBlock || !supply) return { result: "unknown", reason: "pool creation block not known", method: "definitive", source: "live" };
    const bt = await this.blockTime();
    const n = Math.max(1, Math.ceil((this.config.sniperWindowSeconds * 1000) / bt));
    const to = createdBlock + n;
    let topics;
    let address = pool.address;
    if (pool.kind === "univ2") topics = [TOPIC.v2Swap];
    else if (pool.kind === "solidly") topics = [TOPIC.solidlySwap];
    else if (pool.kind === "univ3") topics = [TOPIC.v3Swap];
    else if (pool.kind === "univ4") {
      topics = [TOPIC.v4Swap, pool.address];
      address = this.addr.uniV4PoolManager;
    } else if (pool.kind === "pons_curve") topics = [TOPIC.ponsCurveBuy];
    else return { result: "unknown", reason: "venue not supported for sniper analysis", method: "definitive", source: "live" };

    const { result: logs } = await this.rpc.getLogs({ address, topics, fromBlock: createdBlock, toBlock: to }, opts);
    const tokenIs0 = pool.token0 ? pool.token0 === token : null;
    const buys = [];
    for (const l of logs) {
      const d = words(l.data);
      let bought = 0n;
      if (pool.kind === "pons_curve") bought = wordToBigInt(d[1]);
      else if (pool.kind === "univ2" || pool.kind === "solidly") {
        const [a0in, a1in, a0out, a1out] = d.slice(0, 4).map(wordToBigInt);
        bought = tokenIs0 ? a0out : a1out;
        if ((tokenIs0 ? a0in : a1in) > 0n) bought = 0n;
      } else {
        const a0 = wordToSigned(d[0]);
        const a1 = wordToSigned(d[1]);
        const t = tokenIs0 ? a0 : a1;
        // v3: negative is paid out of the pool (a buy). v4 deltas are from the
        // swapper's side: positive is received.
        bought = pool.kind === "univ4" ? (t > 0n ? t : 0n) : t < 0n ? -t : 0n;
      }
      if (bought > 0n) buys.push({ tx: l.transactionHash, block: Number(BigInt(l.blockNumber)), bought });
    }
    // Resolve each transaction's sender once (routers hide the real buyer).
    const txs = [...new Set(buys.map((b) => b.tx))].slice(0, 60);
    const senders = new Map();
    await Promise.all(
      txs.map(async (h) => {
        const r = await this.rpc.call("eth_getTransactionByHash", [h], opts).catch(() => null);
        if (r && r.result) senders.set(h, lc(r.result.from));
      })
    );
    const byBuyer = new Map();
    const perBlock = new Map();
    for (const b of buys) {
      const who = senders.get(b.tx) || "unresolved";
      byBuyer.set(who, (byBuyer.get(who) || 0n) + b.bought);
      if (!perBlock.has(b.block)) perBlock.set(b.block, new Set());
      perBlock.get(b.block).add(who);
    }
    const total = [...byBuyer.values()].reduce((a, v) => a + v, 0n);
    const share = pctOf(total, supply);
    const crowded = [...perBlock.entries()].filter(([, s]) => s.size >= 3);
    const flagged = share !== null && share > this.config.sniperWarnPct;
    return {
      result: flagged ? "warn" : "pass",
      value: {
        window_seconds: this.config.sniperWindowSeconds,
        window_blocks: n,
        buyers: byBuyer.size,
        bought_pct: share,
        crowded_blocks: crowded.length,
      },
      reason: flagged ? `buyers in the first ${this.config.sniperWindowSeconds} s took ${share}% of supply` : null,
      method: "definitive",
      bundle_method: "heuristic",
      source: "stored",
      as_of: { block: to },
      evidence: {
        top_buyers: [...byBuyer.entries()]
          .sort((a, b) => (b[1] > a[1] ? 1 : -1))
          .slice(0, 10)
          .map(([address, v]) => ({ address, pct: pctOf(v, supply) })),
      },
    };
  }

  // ---- creation block and deployer, from chain data alone ----

  // The block the token's code appeared in, by binary search on eth_getCode
  // (both chains' Pocket nodes keep full history), then the sender of the
  // first mint in that block. About 27 calls, no indexer. `hi` is any block
  // where the code already exists (a pool's creation block narrows nothing
  // below it, so the search runs over [0, hi]).
  async creation(token, hi, opts = { failover: false }) {
    let lo = 0;
    let top = hi;
    const has = async (b) => {
      const { result } = await this.rpc.getCode(token, b, opts);
      return Boolean(result && result !== "0x");
    };
    if (!(await has(top))) return null;
    while (lo < top) {
      const mid = Math.floor((lo + top) / 2);
      if (await has(mid)) top = mid;
      else lo = mid + 1;
    }
    const block = lo;
    // The first mint (Transfer from the zero address) from that block on.
    // Robinhood Chain makes about ten blocks a second, so the window is in blocks.
    const window = this.chain === "robinhood" ? 3000 : 300;
    const zeroTopic = "0x" + "0".repeat(64);
    // Pocket's Base nodes do not all answer old log queries alike: on
    // 2026-10-17 one returned no logs for a block where another returned the
    // mint. So an empty or refused answer is asked again once.
    const mintsOnce = () =>
      this.rpc
        .getLogs({ address: token, topics: [TOPIC.transfer, zeroTopic], fromBlock: block, toBlock: block + window }, { ...opts, pageBlocks: window + 1 })
        .then((r) => r.result)
        .catch(() => []);
    let mints = await mintsOnce();
    if (!mints.length) mints = await mintsOnce();
    const first = mints[0];
    if (!first) {
      // No mint found: the creation block's own contract-creation transaction.
      const direct = await this.creatorFromBlock(token, block, opts).catch(() => null);
      if (direct) return { block, deployer: direct.from, through: null, method: "definitive", tx: direct.hash };
      return { block, deployer: null, through: null, method: null };
    }
    const { result: tx } = await this.rpc.call("eth_getTransactionByHash", [first.transactionHash], opts);
    if (!tx) return { block, deployer: null, through: null, method: null };
    return {
      block,
      deployer: lc(tx.from),
      // A token made by a factory or a CREATE2 deployer names it here; a direct
      // deployment has no "to".
      through: tx.to ? lc(tx.to) : null,
      // The mint in the creation block is the creation transaction itself.
      method: Number(BigInt(first.blockNumber)) === block ? "definitive" : "heuristic",
      tx: first.transactionHash,
    };
  }

  // A token deployed directly by a wallet: the transaction in its creation
  // block with no "to" whose receipt names the token as the contract created.
  async creatorFromBlock(token, block, opts) {
    const { result: blk } = await this.rpc.call("eth_getBlockByNumber", ["0x" + block.toString(16), true], opts);
    if (!blk || !Array.isArray(blk.transactions)) return null;
    for (const t of blk.transactions.filter((x) => x && x.to === null).slice(0, 20)) {
      const { result: rc } = await this.rpc.call("eth_getTransactionReceipt", [t.hash], opts);
      if (rc && lc(rc.contractAddress) === token) return { from: lc(t.from), hash: t.hash };
    }
    return null;
  }

  async balanceOf(token, holder, block, opts) {
    const r = await this.call(token, S.balanceOf + word(holder), block, opts);
    return r ? decodeUint(r) : null;
  }

  launchpadOf(creator) {
    return creator ? EVM_LAUNCHPADS[this.chain].get(creator) || null : null;
  }

  knownHook(hook) {
    return EVM_KNOWN_HOOKS[this.chain].get(lc(hook)) || null;
  }
}

export { S as SELECTORS, encodeCall };
