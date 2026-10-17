// Precompute and check (SPEC sections 2 and 3).
//
// Precompute runs once per new token, from the ingest queue, on Pocket only
// (no failover): it stores everything that never changes, a first reading of
// what can flip, and the costlier results with their time. A check answers
// from the store plus a few live reads: everything that can flip is re-read
// at the request's block or slot, and the honeypot simulation is redone when
// the stored one is older than the shelf life.

import {
  readMint,
  mintChecks,
  metadataCheck,
  launchStateCheck,
  parseMetaplex,
  parsePumpCurve,
  parsePumpSwapPool,
  pumpSwapLp,
  pumpCurveAddress,
  metaplexAddress,
  associatedTokenAddress,
  pct,
  isSolanaAddress,
} from "./solana.js";
import { SOLANA, EVM_KNOWN_ASSETS, EVM_QUOTES, ZERO, BURN_ADDRESSES, EVM_LP_LOCKERS } from "./chains.js";
import { buildVerdict, CHECK_IDS, NOT_OFFERED } from "./verdict.js";
import { poolsOfToken } from "./dexpaprika.js";
import { memeSides, refreshMarket } from "./ingest.js";
import { selector, word, decodeAddress } from "./abi.js";
import { isEvmAddress } from "./abi.js";

const na = (reason) => ({ result: "not_applicable", reason, method: null, source: null });
const notOffered = (reason) => ({ result: "not_available", reason, method: null, source: null });
const unknown = (reason, extra = {}) => ({ result: "unknown", reason, method: null, source: null, ...extra });

// account data from a jsonParsed multi-read: parsed object, or base64 bytes.
function rawBytes(acct) {
  if (!acct || !acct.data) return null;
  if (Array.isArray(acct.data) && acct.data[1] === "base64") return Buffer.from(acct.data[0], "base64");
  return null;
}

function withDeadline(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => (t = setTimeout(() => rej(Object.assign(new Error("deadline"), { code: "deadline" })), ms)))]).finally(() =>
    clearTimeout(t)
  );
}

export function validAddress(chain, address) {
  return chain === "solana" ? isSolanaAddress(address) : isEvmAddress(address);
}

const renounced = (a) => a === null || BURN_ADDRESSES.has(a);

// is_contract, proxy, owner and privileged_functions from one structure read.
export function structureChecks(st, block, source) {
  const base = { method: "definitive", source, endpoint: st.endpoint, as_of: { block } };
  const checks = {};
  checks.is_contract = { result: st.isContract ? "pass" : "fail", value: { code_size: st.codeSize ?? 0 }, ...base };
  if (!st.isContract) return checks;
  const p = st.proxy;
  checks.proxy = !p.upgradeable
    ? { result: "pass", value: { upgradeable: false, kind: p.kind, implementation: p.implementation }, ...base }
    : { result: renounced(p.adminOwner) ? "pass" : "fail", value: { upgradeable: true, kind: p.kind, implementation: p.implementation, admin: p.admin, admin_owner: p.adminOwner }, ...base };
  const ownerLive = st.ownerFn !== null;
  checks.owner = ownerLive
    ? { result: renounced(st.owner) ? "pass" : "warn", value: { owner: st.owner, function: st.ownerFn }, ...base }
    : { result: "pass", value: { owner: null, function: null }, reason: "no owner() or getOwner() function", ...base, method: "heuristic" };
  const danger = ["mint", "blacklist", "pause"].filter((cat) => st.privileged[cat]);
  const ownerHolds = ownerLive && !renounced(st.owner);
  checks.privileged_functions = {
    result: danger.length && ownerHolds ? "fail" : Object.keys(st.privileged).length && ownerHolds ? "warn" : "pass",
    value: { found: st.privileged, owner_renounced: !ownerHolds },
    reason: danger.length && ownerHolds ? `the owner can still ${danger.join(", ")}` : null,
    ...base,
    method: "heuristic",
  };
  return checks;
}

export class Checker {
  constructor({ store, dexpaprika, rpc, evm, config, holderIndex = null }) {
    this.holderIndex = holderIndex;
    this.store = store;
    this.dexpaprika = dexpaprika;
    this.rpc = rpc; // {solana, base, robinhood}
    this.evm = evm; // {base, robinhood}: EvmChain
    this.config = config;
  }

  knownAsset(chain, address) {
    return chain === "solana" ? SOLANA.knownAssets.get(address) || null : EVM_KNOWN_ASSETS[chain].get(address) || null;
  }

  // ======================= precompute =======================

  async precompute(chain, address, opts = { failover: false }) {
    return chain === "solana" ? this.precomputeSolana(address, opts) : this.precomputeEvm(chain, address, opts);
  }

  async precomputeSolana(mintAddr, opts) {
    const sol = this.rpc.solana;
    const curvePda = pumpCurveAddress(mintAddr);
    const mpx = metaplexAddress(mintAddr);
    const { values, slot, endpoint } = await sol.accounts([mintAddr, mpx, curvePda], "jsonParsed", opts);
    const mint = readMint(values[0]);
    if (!mint) {
      this.store.putCheck("solana", mintAddr, "_found", { found: false, slot });
      return { found: false };
    }
    const metaplex = parseMetaplex(rawBytes(values[1]));
    const curve = values[2] && values[2].owner === SOLANA.pumpfunProgram ? parsePumpCurve(rawBytes(values[2])) : null;
    const meta = metadataCheck(mint, metaplex, slot, endpoint);
    const stored = this.store.token("solana", mintAddr);
    this.store.setIdentity("solana", mintAddr, {
      name: meta.name,
      symbol: meta.symbol,
      decimals: mint.decimals,
      supply: mint.supply,
      launchpad: curve ? "pumpfun" : stored && stored.launchpad,
    });

    // PumpSwap pools (Pump.fun migrations): LP burn, reserves and the coin creator.
    const pools = this.store.pools("solana", mintAddr);
    const swaps = pools.filter((p) => p.dex === "pumpswap").slice(0, 3);
    let swapInfo = [];
    if (swaps.length) {
      const r = await sol.accounts(swaps.map((p) => p.address), "base64", opts);
      swapInfo = r.values.map((v, i) => ({ address: swaps[i].address, pool: v ? parsePumpSwapPool(Buffer.from(v.data[0], "base64")) : null })).filter((s) => s.pool);
      if (swapInfo.length) {
        const lp = await sol.accounts(swapInfo.map((s) => s.pool.lpMint), "jsonParsed", opts);
        swapInfo.forEach((s, i) => {
          const m = readMint(lp.values[i]);
          s.lp = pumpSwapLp(s.pool, m ? m.supply : null);
          this.store.upsertPool("solana", { address: s.address, token: mintAddr, extra: { lpMint: s.pool.lpMint, baseVault: s.pool.baseVault, quoteVault: s.pool.quoteVault, txns_24h: (pools.find((p) => p.address === s.address) || {}).extra?.txns_24h ?? null } });
        });
      }
    }

    // Creator holding: the Pump.fun creator (curve or PumpSwap coin creator).
    const creator = (curve && curve.creator) || (swapInfo[0] && swapInfo[0].pool.coinCreator) || null;
    let creatorCheck = na("no launchpad creator recorded for this token");
    if (creator) {
      const ata = associatedTokenAddress(creator, mintAddr, mint.program);
      const r = await sol.account(ata, "jsonParsed", opts);
      const amount = r.value && r.value.data && r.value.data.parsed ? BigInt(r.value.data.parsed.info.tokenAmount.amount) : 0n;
      const share = pct(amount, mint.supply);
      creatorCheck = {
        result: share !== null && share > this.config.creatorHoldingWarnPct ? "warn" : "pass",
        value: { creator, pct: share },
        method: "definitive",
        source: "stored",
        as_of: { slot: r.slot },
      };
      this.store.setIdentity("solana", mintAddr, { deployer: creator });
    }

    // LP status.
    let lp;
    if (curve && !curve.complete) {
      lp = { result: "pass", value: { held_by: "pumpfun_bonding_curve" }, reason: "liquidity sits in the Pump.fun bonding curve, which has no withdrawal path", method: "definitive", source: "stored", as_of: { slot } };
    } else if (swapInfo.some((s) => s.lp && s.lp.burnedPct !== null)) {
      const best = swapInfo.find((s) => s.lp && s.lp.burnedPct !== null);
      lp = {
        result: best.lp.burnedPct >= 95 ? "pass" : "warn",
        value: { pool: best.address, burned_pct: best.lp.burnedPct },
        method: "definitive",
        source: "stored",
        as_of: { slot },
      };
    } else {
      lp = { result: "unknown", reason: "LP state is read for Pump.fun curves and PumpSwap pools only", method: "heuristic", source: "stored" };
    }

    const now = Date.now();
    const put = (id, v) => this.store.putCheck("solana", mintAddr, id, v, now);
    put("_found", { found: true, slot });
    put("_mint_program", { program: mint.program });
    put("metadata_mutable", meta.check);
    put("launch_state", launchStateCheck(curve, slot, endpoint));
    put("creator_holding", creatorCheck);
    put("lp_status", lp);
    for (const [id, v] of Object.entries(mintChecks(mint, slot, endpoint))) put(id, v);
    return { found: true };
  }

  async precomputeEvm(chain, token, opts) {
    const ev = this.evm[chain];
    const block = await ev.rpc.blockNumber(opts);
    const st = await ev.structure(token, block, opts);
    if (!st.isContract) {
      this.store.putCheck(chain, token, "_found", { found: false, block });
      return { found: false };
    }
    const [id, pons] = await Promise.all([
      ev.identity(token, block, opts),
      chain === "robinhood" ? ev.pons(token, block, opts).catch(() => null) : null,
    ]);
    const stored = this.store.token(chain, token) || {};
    // The launchpad and deployer come from the Pons factory here; for other
    // tokens, from Blockscout's creator in the enrichment queue (enrichEvm).
    const launchpad = pons ? "pons" : stored.launchpad || null;
    const deployer = pons ? pons.deployer : null;
    this.store.setIdentity(chain, token, { name: id.name, symbol: id.symbol, decimals: id.decimals, supply: id.supply, launchpad, deployer });

    const pools = await ev.preparePools(token, this.store.pools(chain, token), pons, block, opts, { launchBlock: stored.created_block || null });
    for (const p of pools) if (p.poolKey && !(p.extra && p.extra.poolKey)) this.store.upsertPool(chain, { address: p.address, token, extra: { ...(p.extra || {}), poolKey: p.poolKey } });

    const now = Date.now();
    const put = (cid, v) => this.store.putCheck(chain, token, cid, v, now);
    put("_found", { found: true, block });
    put("_structure", { proxy: st.proxy, owner: st.owner, ownerFn: st.ownerFn, privileged: st.privileged, block });
    for (const [cid, v] of Object.entries(structureChecks(st, block, "stored"))) put(cid, v);
    if (pons) put("_pons", { ...pons, graduationThreshold: pons.graduationThreshold.toString() });

    const first = pools.filter((p) => p.kind && p.createdBlock).sort((a, b) => a.createdBlock - b.createdBlock)[0];
    const [hp, lp, snipers] = await Promise.all([
      ev.honeypot(token, pools, block, opts).catch((e) => unknown("simulation could not run: " + (e.kind || "error"))),
      ev.lpStatus(token, pools, launchpad, pons, block, opts).catch(() => unknown("LP state could not be read")),
      // Snipers and bundles: once, from the pool's first seconds of swaps.
      first ? ev.snipers(token, first, id.supply, opts).catch((e) => unknown("sniper analysis failed: " + (e.kind || e.message))) : unknown("no pool with a known creation block"),
    ]);
    put("honeypot", hp);
    put("lp_status", lp);
    put("snipers_bundles", snipers);

    // Holders and the deployer come from Blockscout, which answers in 3 to 10
    // seconds, so they are filled in by the enrichment queue and never block
    // a check. Until then they say so.
    const pending = (what) => ({ result: "unknown", reason: what, method: null, source: null });
    if (!(this.holderIndex && this.holderIndex.indexes(chain))) {
      const why = ev.blockscoutUnavailable();
      put("holder_concentration", why ? notOffered(why) : pending("the holder list is queued for Blockscout; ask again in a minute"));
    }
    if (deployer) await this.putDeployer(chain, token, deployer, launchpad, id.supply, block, opts);
    else {
      put("creator_holding", pending("the deployer is being looked up on chain; ask again in a minute"));
      put("deployer", pending("the deployer is being looked up on chain; ask again in a minute"));
    }
    return { found: true };
  }

  // The deployer, and what it still holds at `block`.
  async putDeployer(chain, token, deployer, launchpad, supply, block, opts, { through = null, method = "definitive" } = {}) {
    const ev = this.evm[chain];
    const bal = await ev.balanceOf(token, deployer, block, opts).catch(() => null);
    const share = bal !== null && supply ? pct(bal, supply) : null;
    const now = Date.now();
    this.store.putCheck(
      chain,
      token,
      "creator_holding",
      {
        result: share === null ? "unknown" : share > this.config.creatorHoldingWarnPct ? "warn" : "pass",
        value: { deployer, pct: share },
        method: "definitive",
        source: "stored",
        as_of: { block },
      },
      now
    );
    const value = { deployer, launchpad };
    // A token made through a factory or a CREATE2 deployer names that contract.
    if (through) value.created_through = through;
    this.store.putCheck(chain, token, "deployer", { result: "pass", value, method, source: "stored", as_of: { block } }, now);
  }

  // Background enrichment for one EVM token, never in a check's path:
  //   - its creation block and deployer, from chain data (EvmChain.creation);
  //   - on an indexed chain, enrolment in the holder index from that block;
  //   - elsewhere, holder concentration from Blockscout.
  async enrichEvm(chain, token) {
    const ev = this.evm[chain];
    const opts = { failover: false };
    const tok = this.store.token(chain, token);
    if (!tok) return;
    const stored = this.store.checks(chain, token);
    const supply = tok.supply ? BigInt(tok.supply) : null;
    const pons = stored._pons || null;
    const head = await ev.rpc.blockNumber(opts);

    // Creation block and deployer (Pons already named the deployer, but the
    // creation block is still needed for the holder index).
    // Stored only once the deployer is known: a node that answered an old
    // log query with nothing should not settle the question for good.
    let creation = stored._creation || null;
    if (!creation) {
      creation = await ev.creation(token, head, opts);
      if (creation && creation.deployer) this.store.putCheck(chain, token, "_creation", creation);
    }
    const retry = Boolean(!pons && (!creation || !creation.deployer));
    if (creation && !pons) {
      if (creation.deployer) {
        const through = creation.through;
        const launchpad = ev.launchpadOf(through) || tok.launchpad || null;
        this.store.setIdentity(chain, token, { deployer: creation.deployer, launchpad });
        await this.putDeployer(chain, token, creation.deployer, launchpad, supply, head, opts, { through, method: creation.method });
      } else {
        const v = unknown("no mint transfer near the creation block, so the deployer could not be read");
        this.store.putCheck(chain, token, "deployer", { ...v, value: { creation_block: creation.block } });
        this.store.putCheck(chain, token, "creator_holding", v);
      }
    } else if (!creation && !pons) {
      const v = unknown("the creation block could not be found");
      this.store.putCheck(chain, token, "deployer", v);
      this.store.putCheck(chain, token, "creator_holding", v);
    }

    // Holders.
    if (this.holderIndex && this.holderIndex.indexes(chain)) {
      if (creation) this.holderIndex.enroll(chain, token, creation.block);
      return { retry };
    }
    const why = ev.blockscoutUnavailable();
    if (why) {
      this.store.putCheck(chain, token, "holder_concentration", notOffered(why));
      return { retry };
    }
    this.store.putCheck(chain, token, "holder_concentration", await ev.holders(token, supply, this.holderExclusions(chain, token)).catch(() => unknown("holders could not be read")));
    return { retry };
  }

  // Addresses that hold tokens without owning them: pools, the v4 PoolManager,
  // the Pons curve, known lockers. Burn addresses are excluded where counted.
  holderExclusions(chain, token) {
    const ev = this.evm[chain];
    const ex = new Set([...this.store.pools(chain, token).map((p) => p.address), ev.addr.uniV4PoolManager, ...EVM_LP_LOCKERS[chain].keys()]);
    const pons = this.store.checks(chain, token)._pons;
    if (pons) ex.add(pons.curve);
    return ex;
  }

  // ======================= check =======================

  // One token, answered from the store plus live reads. Never throws.
  async check(chain, address, detail = "standard") {
    const t0 = Date.now();
    let stored = this.store.token(chain, address);
    let precomputed = stored && stored.precomputed_at;
    const base = { chain, address };
    try {
      if (!precomputed) {
        // Not in the store: run the pipeline now, with failover, under a deadline.
        await withDeadline(this.discover(chain, address), this.config.checkDeadlineMs * 0.45).catch(() => null);
        // A precompute that outlives its share of the deadline keeps running and
        // stores its results; this answer goes out with what is stored by then,
        // and the queue finishes the token if this run does not.
        const done = await withDeadline(this.precompute(chain, address, { failover: true }), this.config.checkDeadlineMs * 0.55)
          .then(() => true)
          .catch((e) => {
            if (e && e.code === "deadline") return false;
            throw e;
          });
        if (done) this.store.markPrecomputed(chain, address);
        stored = this.store.token(chain, address);
      }
      if (chain !== "solana") this.store.markRequested(chain, address);
      const remaining = Math.max(1500, this.config.checkDeadlineMs - (Date.now() - t0));
      const live = await withDeadline(chain === "solana" ? this.liveSolana(address) : this.liveEvm(chain, address), remaining).catch((e) => ({
        error: e.code === "deadline" ? "live reads did not finish in time" : "live reads failed",
      }));
      return this.shape(chain, address, live, detail);
    } catch (e) {
      return { ...base, found: null, verdict: "unknown", error: e && e.code === "deadline" ? "the token could not be checked in time" : "the token could not be checked", flags: [], checks: {} };
    }
  }

  // Finds pools for a token the store has never seen: on chain where that is
  // cheap, DexPaprika (under the hourly fallback cap) otherwise.
  async discover(chain, address) {
    this.store.seeToken(chain, address, {});
    // On chain (EVM factories) and DexPaprika in parallel; each stores what it finds.
    await Promise.all([
      chain === "solana" ? null : this.discoverEvmPools(chain, address).catch(() => 0),
      this.discoverDexPaprika(chain, address).catch(() => null),
    ]);
    refreshMarket(this.store, chain, address);
  }

  async discoverDexPaprika(chain, address) {
    const out = await poolsOfToken(this.dexpaprika, chain, address);
    if (!out.ok) return;
    const own = chain === "solana" ? address : address.toLowerCase();
    for (const row of out.data.results || []) {
      const { memes, quote } = memeSides(chain, row);
      if (!memes.includes(own)) continue;
      this.store.upsertPool(chain, {
        address: chain === "solana" ? row.id : String(row.id).toLowerCase(),
        token: address,
        dex: row.dex_id,
        quote,
        createdBlock: row.created_at_block_number ?? null,
        createdAt: row.created_at ?? null,
        liquidityUsd: row.liquidity_usd ?? null,
        volumeUsd24h: row.volume_usd_24h ?? null,
        extra: { txns_24h: row.transactions_24h ?? null },
      });
    }
  }

  // Uniswap v2 and v3 pools against wrapped native, found through the factories.
  async discoverEvmPools(chain, token) {
    const ev = this.evm[chain];
    const quotes = [ev.addr.weth, chain === "base" ? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" : "0x5fc5360d0400a0fd4f2af552add042d716f1d168"];
    const calls = [];
    for (const q of quotes) {
      calls.push({ dex: "uniswap_v2", quote: q, to: ev.addr.uniV2Factory, data: selector("getPair(address,address)") + word(token) + word(q) });
      for (const fee of [500, 3000, 10000]) {
        calls.push({ dex: "uniswap_v3", quote: q, to: ev.addr.uniV3Factory, data: selector("getPool(address,address,uint24)") + word(token) + word(q) + word(fee) });
      }
    }
    const found = await Promise.all(calls.map((c) => ev.rpc.ethCall({ to: c.to, data: c.data }).then((r) => decodeAddress(r.result)).catch(() => null)));
    let n = 0;
    found.forEach((p, i) => {
      if (p && p !== ZERO) {
        this.store.upsertPool(chain, { address: p, token, dex: calls[i].dex, quote: calls[i].quote });
        n++;
      }
    });
    return n;
  }

  async liveSolana(mintAddr) {
    const sol = this.rpc.solana;
    const swaps = this.store.pools("solana", mintAddr).filter((p) => p.dex === "pumpswap" && p.extra && p.extra.lpMint).slice(0, 1);
    const addrs = [mintAddr, metaplexAddress(mintAddr), pumpCurveAddress(mintAddr)];
    if (swaps.length) addrs.push(swaps[0].address, swaps[0].extra.lpMint);
    const { values, slot, endpoint } = await sol.accounts(addrs, "jsonParsed", { failover: true });
    const mint = readMint(values[0]);
    if (!mint) return { found: false, slot };
    const metaplex = parseMetaplex(rawBytes(values[1]));
    const curve = values[2] && values[2].owner === SOLANA.pumpfunProgram ? parsePumpCurve(rawBytes(values[2])) : null;
    const checks = {
      ...mintChecks(mint, slot, endpoint, { knownAsset: Boolean(this.knownAsset("solana", mintAddr)) }),
      metadata_mutable: metadataCheck(mint, metaplex, slot, endpoint).check,
      launch_state: launchStateCheck(curve, slot, endpoint),
    };
    if (curve && !curve.complete) {
      checks.lp_status = { result: "pass", value: { held_by: "pumpfun_bonding_curve" }, reason: "liquidity sits in the Pump.fun bonding curve, which has no withdrawal path", method: "definitive", source: "live", endpoint, as_of: { slot } };
    } else if (swaps.length && values[3] && values[4]) {
      const pool = parsePumpSwapPool(rawBytes(values[3]));
      const lpMint = readMint(values[4]);
      const lp = pool && lpMint ? pumpSwapLp(pool, lpMint.supply) : { burnedPct: null };
      if (lp.burnedPct !== null) {
        checks.lp_status = { result: lp.burnedPct >= 95 ? "pass" : "warn", value: { pool: swaps[0].address, burned_pct: lp.burnedPct }, method: "definitive", source: "live", endpoint, as_of: { slot } };
      }
    }
    return { found: true, slot, endpoint, checks, supply: mint.supply, decimals: mint.decimals };
  }

  async liveEvm(chain, token) {
    const ev = this.evm[chain];
    const block = await ev.rpc.blockNumber({ failover: true });
    const opts = { failover: true };
    const stored = this.store.checks(chain, token);
    const s = stored._structure;
    if (!stored._found || !stored._found.found || !s) return { found: stored._found ? stored._found.found : null, block };
    // Re-read what can flip: owner, and the proxy's implementation and admin.
    const st = await ev.structure(token, block, opts);
    const checks = structureChecks(st, block, "live");
    if (!st.isContract) return { found: false, block, checks };

    // The honeypot simulation moves with every trade: redo it when stale.
    let hp = stored.honeypot;
    if (!hp || Date.now() - hp.computed_at > this.config.shelfLifeMs || hp.result === "unknown") {
      const pons = stored._pons && stored._pons.graduated === false ? await ev.pons(token, block, opts).catch(() => null) : stored._pons ? { ...stored._pons, graduationThreshold: BigInt(stored._pons.graduationThreshold) } : null;
      const tokenRow = this.store.token(chain, token) || {};
      const pools = await ev.preparePools(token, this.store.pools(chain, token), pons, block, opts, { launchBlock: tokenRow.created_block || null });
      hp = await ev.honeypot(token, pools, block, opts).catch((e) => unknown("simulation could not run: " + (e.kind || "error")));
      hp.source = "live";
      this.store.putCheck(chain, token, "honeypot", hp);
      if (pons) checks._pons = pons;
    } else {
      hp = { ...hp, source: "stored", age_ms: Date.now() - hp.computed_at };
    }
    checks.honeypot = hp;
    return { found: true, block, checks };
  }

  // ======================= response =======================

  shape(chain, address, live, detail) {
    const kind = chain === "solana" ? "solana" : "evm";
    const tok = this.store.token(chain, address) || {};
    const stored = this.store.checks(chain, address);
    const knownSym = this.knownAsset(chain, address);
    if (live && live.found === false) {
      return { chain, address, found: false, known_asset: Boolean(knownSym), verdict: "unknown", flags: [], reason: chain === "solana" ? "no mint account at this address" : "no contract at this address", checks: {} };
    }
    const checks = {};
    for (const id of CHECK_IDS[kind]) {
      const c = (live && live.checks && live.checks[id]) || stored[id];
      checks[id] = c ? { ...c } : NOT_OFFERED[kind] && NOT_OFFERED[kind][id] ? notOffered(NOT_OFFERED[kind][id]) : unknown(live && live.error ? live.error : "not computed yet");
    }
    if (kind === "solana") {
      for (const [id, why] of Object.entries(NOT_OFFERED.solana)) checks[id] = notOffered(why);
    }
    if (kind === "evm" && this.holderIndex && this.holderIndex.indexes(chain)) {
      const supplyNow = tok.supply ? BigInt(tok.supply) : null;
      checks.holder_concentration = this.holderIndex.holderCheck(chain, address, supplyNow, this.holderExclusions(chain, address), this.config.topHoldersWarnPct);
    }
    // Taxes come out of the simulation.
    if (kind === "evm") {
      const hv = checks.honeypot && checks.honeypot.value;
      const taxCheck = (pctVal, label) => {
        if (!hv || pctVal === null || pctVal === undefined) return unknown(hv ? "the simulation did not measure a " + label + " tax" : "no simulation");
        const r = pctVal >= this.config.sellTaxCritical ? "fail" : pctVal >= this.config.taxWarning ? "warn" : "pass";
        return { result: r, value: { pct: pctVal }, reason: r === "pass" ? null : `${label} tax ${pctVal}%`, method: checks.honeypot.method, source: checks.honeypot.source, as_of: checks.honeypot.as_of };
      };
      checks.buy_tax = taxCheck(hv && hv.buy_tax_pct, "buy");
      checks.sell_tax = taxCheck(hv && hv.sell_tax_pct, "sell");
      const pons = (live && live.checks && live.checks._pons) || stored._pons;
      checks.launch_state = pons
        ? {
            result: pons.graduated ? "pass" : "info",
            value: {
              launchpad: "pons",
              on_curve: !pons.graduated,
              phase: pons.phase,
              curve: pons.curve,
              fee_bps: pons.feeBps,
              creator_tax_bps: pons.creatorTaxBps,
              snipe_tax_start_bps: pons.snipeTaxStartBps,
              snipe_tax_seconds: pons.snipeTaxSeconds,
              sells_paused_for_graduation: pons.readyToGraduate || undefined,
            },
            reason: pons.readyToGraduate ? "the curve is full and waiting to graduate; sells revert until the pool is created" : null,
            method: "definitive",
            source: live && live.checks && live.checks._pons ? "live" : "stored",
          }
        : { result: "not_applicable", reason: tok.launchpad ? `launched on ${tok.launchpad}, which has no bonding curve state to read` : "not a recognized launchpad token", method: null, source: null, value: tok.launchpad ? { launchpad: tok.launchpad } : null };
    }
    // Liquidity, from the store's pool rows.
    const market = this.store.market(chain, address);
    const pools = this.store.pools(chain, address);
    const liq = market && market.liquidity_usd !== null ? market.liquidity_usd : null;
    checks.liquidity =
      liq === null
        ? unknown("no liquidity figure for this token")
        : { result: liq < this.config.minLiquidityUsd ? "warn" : "pass", value: { total_usd: liq, pools: pools.length }, reason: liq < this.config.minLiquidityUsd ? `total liquidity is $${Math.round(liq).toLocaleString("en-US")}` : null, method: "definitive", source: "stored", as_of: { fetched_at: market.fetched_at } };
    // Age.
    const created = tok.created_at ? Date.parse(tok.created_at) : null;
    checks.age = created
      ? { result: Date.now() - created < 3600000 ? "info" : "pass", value: { created_at: tok.created_at, minutes: Math.round((Date.now() - created) / 60000) }, method: "definitive", source: "stored" }
      : unknown("creation time not known");

    if (knownSym) {
      for (const id of ["lp_status", "liquidity", "age", "creator_holding", "snipers_bundles"]) {
        if (checks[id] && ["unknown", "not_available"].includes(checks[id].result)) checks[id] = na("a known asset (" + knownSym + "): not screened as a launch");
      }
      for (const c of Object.values(checks)) c.known_asset = true;
    }
    const { verdict, flags } = buildVerdict(chain, checks, { knownAsset: Boolean(knownSym) });

    // Standard detail drops raw evidence and endpoints; full keeps them.
    const publicChecks = {};
    for (const [id, c] of Object.entries(checks)) {
      const { computed_at, evidence, endpoint, ...rest } = c;
      publicChecks[id] = detail === "full" ? { ...rest, endpoint: endpoint ?? null, evidence: evidence ?? null } : rest;
      if (computed_at && !publicChecks[id].as_of) publicChecks[id].computed_at = new Date(computed_at).toISOString();
    }
    const supply = tok.supply ? BigInt(tok.supply) : null;
    const decimals = tok.decimals ?? null;
    return {
      chain,
      address,
      found: true,
      known_asset: Boolean(knownSym),
      verdict,
      flags: flags.map((f) => (detail === "full" ? f : { id: f.id, severity: f.severity, method: f.method, reason: f.reason })),
      token: {
        name: tok.name ?? null,
        symbol: tok.symbol ?? knownSym ?? null,
        decimals,
        supply: supply !== null && decimals !== null ? Number(supply) / 10 ** decimals : null,
        created_at: tok.created_at ?? null,
        launchpad: tok.launchpad ?? null,
        deployer: tok.deployer ?? null,
      },
      market: market
        ? {
            price_usd: market.price_usd ?? null,
            liquidity_usd: market.liquidity_usd ?? null,
            fdv_usd: market.fdv_usd ?? null,
            volume_usd_24h: market.volume_usd_24h ?? null,
            txns_24h: market.txns_24h ?? null,
            pools: pools.slice(0, 10).map((p) => ({ address: p.address, dex: p.dex, quote: p.quote, liquidity_usd: p.liquidity_usd })),
            source: "stored",
            fetched_at: market.fetched_at,
          }
        : null,
      checks: publicChecks,
    };
  }
}

export { EVM_QUOTES };
