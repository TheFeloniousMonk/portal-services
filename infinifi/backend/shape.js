// Pure functions that turn infiniFi API payloads into this service's responses.
// No upstream data is invented here. The changes are: snake_case names, decimal
// numbers instead of fixed-point strings, chain names instead of upstream enums,
// ISO timestamps instead of epoch milliseconds, a numeric APY where upstream
// sometimes sends a string, and absolute links where upstream sends app paths.

const CHAINS = { MAINNET: "ethereum", ETHEREUM: "ethereum", BASE: "base", MONAD: "monad" };

export const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const chainName = (c) => (c ? CHAINS[String(c).toUpperCase()] || String(c).toLowerCase() : null);

export const iso = (ms) => {
  const n = num(ms);
  return n && n > 0 ? new Date(n).toISOString() : null;
};

// Normalize a caller's chain filter: "ethereum", "mainnet", "Base", "MONAD".
export function chainFilter(v) {
  if (v === undefined || v === null || v === "") return null;
  return chainName(v);
}

// Fixed-point integer string at `decimals` -> Number, for upstream values that
// carry no pre-normalized twin.
export function fromUnits(s, decimals = 18) {
  if (s === null || s === undefined || s === "") return null;
  try {
    const v = BigInt(String(s));
    const neg = v < 0n;
    const a = neg ? -v : v;
    const base = 10n ** BigInt(decimals);
    const whole = a / base;
    const frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    const n = Number(whole.toString() + (frac ? "." + frac : ""));
    return neg ? -n : n;
  } catch {
    return num(s);
  }
}

// Decimal string or number -> fixed-point integer string, exact (no float).
export function toUnits(v, decimals = 18) {
  const s = typeof v === "number" ? v.toFixed(decimals) : String(v).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] || "").slice(0, decimals).padEnd(decimals, "0");
  const units = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return units.toString();
}

const apyBlock = (o) => ({
  d1: num(o.average1dAPY),
  d7: num(o.average7dAPY),
  d30: num(o.average30dAPY),
  last_week: num(o.lastWeekAPY),
});

// --- protocol -------------------------------------------------------------

export function lockTiers(stats, emptyTierIusd) {
  return Object.values(stats.locked || {})
    .map((t) => {
      const locked = num(t.totalLockedNormalized);
      return {
        weeks: num(t.bucketMaturity),
        token: t.name,
        address: t.address,
        exchange_rate: num(t.exchangeRateNormalized),
        supply: num(t.totalSupplyNormalized),
        total_locked_iusd: locked,
        apy: apyBlock(t),
        empty: locked === null || locked < emptyTierIusd,
      };
    })
    .sort((a, b) => a.weeks - b.weeks);
}

export function overview(pd, emptyTierIusd) {
  const { asset: a, receipt: r, staked: s } = pd.stats;
  const tvl = num(a.totalTVLAssetNormalized);
  const liquid = num(a.totalLiquidAssetNormalized);
  const tiers = lockTiers(pd.stats, emptyTierIusd);
  const active = tiers.filter((t) => !t.empty);
  const best = active.reduce((b, t) => (t.apy.d7 !== null && (!b || t.apy.d7 > b.apy.d7) ? t : b), null);
  const farms = pd.farms || [];
  return {
    asset: {
      symbol: a.name,
      address: a.address,
      decimals: a.decimals,
      tvl,
      liquid,
      illiquid: num(a.totalIlliquidAssetNormalized),
      liquid_ratio: tvl ? liquid / tvl : null,
      pending_redemptions: num(a.pendingRedemptionsAssetNormalized),
    },
    iusd: {
      token: r.name,
      address: r.address,
      supply: num(r.totalSupplyNormalized),
      staked: num(r.totalStakedNormalized),
      locked: num(r.totalLockedNormalized),
      unwinding: num(r.totalUnwindingNormalized),
      exchange_rate: num(r.receiptExchangeRateNormalized),
      total_yield: num(r.totalYieldNormalized),
    },
    siusd: {
      token: s.name,
      address: s.address,
      supply: num(s.totalSupplyNormalized),
      exchange_rate: num(s.exchangeRateNormalized),
      apy: apyBlock(s),
    },
    lock_tiers: {
      count: tiers.length,
      active: active.length,
      best_by_apy_7d: best ? { weeks: best.weeks, token: best.token, apy_7d: best.apy.d7 } : null,
    },
    farms: {
      count: farms.length,
      active: farms.filter((f) => !f.isPaused).length,
      chains: [...new Set(farms.map((f) => chainName(f.chain)))],
    },
  };
}

export function yields(pd, { minWeeks, maxWeeks, includeEmpty }, emptyTierIusd) {
  const s = pd.stats.staked;
  let tiers = lockTiers(pd.stats, emptyTierIusd);
  if (minWeeks !== null) tiers = tiers.filter((t) => t.weeks >= minWeeks);
  if (maxWeeks !== null) tiers = tiers.filter((t) => t.weeks <= maxWeeks);
  if (!includeEmpty) tiers = tiers.filter((t) => !t.empty);
  return {
    staked: {
      token: s.name,
      address: s.address,
      exchange_rate: num(s.exchangeRateNormalized),
      supply: num(s.totalSupplyNormalized),
      apy: apyBlock(s),
    },
    locked: tiers,
  };
}

export function farm(f) {
  const tooltip = (t) => (t && !/^(no apy|this is a protocol farm earning no yield)$/i.test(t) ? t : null);
  return {
    name: f.label,
    id: f.name,
    address: f.address,
    chain: chainName(f.chain),
    type: f.type ? String(f.type).toLowerCase() : null,
    paused: Boolean(f.isPaused),
    apy: num(f.APY),
    apy_base: num(f.apyBase),
    apy_rewards: num(f.apyRewards),
    avg_apy: num(f.avgApy),
    exit_apy: num(f.exitApy),
    apy_note: tooltip(f.apyTooltip),
    assets_usdc: num(f.assetsNormalized),
    bucket_weeks: num(f.bucket),
    maturity: iso(f.maturityTimestampMs),
    underlying: f.underlyingAssetSymbol || f.underlyingAssetAddress
      ? { symbol: f.underlyingAssetSymbol || null, address: f.underlyingAssetAddress || null }
      : null,
    l2_liquidity: Boolean(f.isL2LiquidityFarm),
    description: f.description || null,
  };
}

export function farms(pd, { chain, type, includePaused, minApy, sort }) {
  let list = (pd.farms || []).map(farm);
  if (chain) list = list.filter((f) => f.chain === chain);
  if (type) list = list.filter((f) => f.type === type);
  if (!includePaused) list = list.filter((f) => !f.paused);
  if (minApy !== null) list = list.filter((f) => f.apy !== null && f.apy >= minApy);
  const key = sort === "assets" ? "assets_usdc" : sort === "apy" ? "apy" : null;
  if (key) list.sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity));
  return { count: list.length, farms: list };
}

export function findFarms(pd, { address, name }) {
  const list = (pd.farms || []).map(farm);
  if (address) return list.filter((f) => f.address.toLowerCase() === address.toLowerCase());
  const q = name.toLowerCase();
  const exact = list.filter((f) => f.name.toLowerCase() === q || f.id.toLowerCase() === q);
  return exact.length ? exact : list.filter((f) => f.name.toLowerCase().includes(q));
}

export function params(pd) {
  const p = pd.params || {};
  return {
    reserve_ratio: num(p.reserveRatio),
    illiquid_target_ratio: num(p.illiquidTargetRatio),
    liquid_return_multiplier: num(p.liquidReturnMultiplier),
    illiquid_return_multiplier: num(p.illiquidReturnMultiplier),
    locked_multiplier: num(p.lockedMultiplier),
    unwinding_multiplier: num(p.unwindingMultiplier),
    smoother_rate: num(p.smootherRate),
    bucket_multipliers: (p.bucketMultipliers || []).map((m, i) => ({ weeks: i + 1, multiplier: num(m) })),
  };
}

export function redemptionQueue(d) {
  return {
    total_enqueued_iusd: num(d.totalReceiptEnqueuedNormalized),
    fully_funded_at: d.fullyFundedTimestampUTC || iso(d.fullyFundedTimestampMs),
    updated_at: d.lastUpdateTimestampUTC || iso(d.lastUpdateTimestampMs),
    tickets: d.tickets || [],
  };
}

export function redemptionQuote(d, amountIusd) {
  return {
    amount_iusd: amountIusd,
    directly_redeemable: Boolean(d.isDirectlyRedeemable),
    usdc_redeemable_now: num(d.amountAssetDirectlyRedeemableNormalized),
    iusd_enqueued: num(d.amountReceiptEnqueuedNormalized),
    usdc_missing: num(d.amountAssetMissingNormalized),
    fully_funded_at: d.fullyFundedTimestampUTC || iso(d.fullyFundedTimestampMs),
  };
}

function voteSide(side, labels) {
  if (!side) return null;
  return {
    total: fromUnits(side.total),
    votes: (side.votes || []).map((v) => ({
      farm_address: v.farmAddress,
      farm: labels.get(String(v.farmAddress).toLowerCase()) || null,
      votes: fromUnits(v.votes),
    })),
  };
}

// Farm names come from the protocol data payload, so a vote reads as
// "Aave USDC" rather than a bare address.
export function farmLabels(pd) {
  const m = new Map();
  for (const f of (pd && pd.farms) || []) m.set(String(f.address).toLowerCase(), f.label);
  return m;
}

export function votes(d, labels) {
  return {
    epoch: d.epoch,
    liquid: voteSide(d.liquid, labels),
    illiquid: voteSide(d.illiquid, labels),
    locked_token_votes: d.lockedTokenVotes || {},
  };
}

const absolute = (href, appBase) => (!href ? null : /^https?:\/\//i.test(href) ? href : appBase + (href.startsWith("/") ? "" : "/") + href);

export function opportunities(list, { chain, protocol, asset }, appBase) {
  let out = (list || []).map((t) => ({
    rank: num(t.rank),
    id: t.taskId || null,
    title: t.taskTitle || t.title || null,
    type: t.taskType || null,
    protocol: t.protocolSlug || null,
    chains: Array.isArray(t.chainSlug) ? t.chainSlug : [],
    assets: Array.isArray(t.assets) ? t.assets : [],
    apy: num(t.apy),
    tvl_usd: num(t.tvlUsd),
    rewards: Object.entries(t.rewards || {}).map(([k, r]) => ({ program: k, multiplier: num(r && r.multiplier) })),
    action: { label: t.actionLabel || null, url: absolute(t.actionHref, appBase) },
    lp_url: t.LPUrl || null,
    starts_at: t.startDate || null,
    ends_at: t.endDate || null,
  }));
  if (chain) out = out.filter((o) => o.chains.some((c) => chainName(c) === chain));
  if (protocol) out = out.filter((o) => (o.protocol || "").toLowerCase() === protocol.toLowerCase());
  if (asset) out = out.filter((o) => o.assets.some((a) => a.toLowerCase() === asset.toLowerCase()));
  out.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return { count: out.length, opportunities: out };
}

// --- wallet ---------------------------------------------------------------

function pnlBlock(p) {
  const locked = Object.entries(p.lockedProfitNormalized || {})
    .map(([w, v]) => ({ weeks: Number(w), profit: num(v) }))
    .sort((a, b) => a.weeks - b.weeks);
  const staked = num(p.stakedProfitNormalized) || 0;
  const unwinding = num(p.unwindingProfitNormalized) || 0;
  const lockedTotal = locked.reduce((s, l) => s + (l.profit || 0), 0);
  return { total: staked + lockedTotal + unwinding, staked, locked_total: lockedTotal, locked, unwinding };
}

export function pnl(d) {
  const byChain = {};
  for (const [c, p] of Object.entries(d.pnlByChain || {})) byChain[chainName(c)] = pnlBlock(p);
  return { unit: "iUSD", ...pnlBlock(d), by_chain: byChain };
}

const series = (pts) => (pts || []).map((p) => ({ at: iso(p.time), value: num(p.value) }));

export function history(d, { kind, days, byChain }) {
  const points = series(d.dataPoints);
  const out = {
    kind,
    days,
    unit: "USD",
    latest: points.length ? points[points.length - 1] : null,
    points,
  };
  if (byChain) {
    out.by_chain = {};
    for (const [c, pts] of Object.entries(d.chainDataPoints || {})) out.by_chain[chainName(c)] = series(pts);
  }
  return out;
}

export function unwinding(list) {
  const positions = Array.isArray(list) ? list : [];
  return { count: positions.length, positions };
}

export function walletRedemptions(d) {
  return {
    claimable_usdc: num(d.claimableAssetNormalized),
    enqueued_iusd: num(d.totalEnqueuedReceiptNormalized),
    fully_funded_at: d.fullyFundedTimestampUTC || iso(d.fullyFundedTimestampMs),
    tickets: d.redemptionTickets || d.tickets || [],
  };
}

export function points(d, { detail }) {
  const chapters = (d.v2Points || []).map((c) => {
    const row = { episode: c.episode, chapter: c.chapter, points: num(c.points), finalized: Boolean(c.isFinalized) };
    if (detail) row.sources = (c.details || []).map((s) => ({ source: s.source, points: num(s.points) }));
    return row;
  });
  return {
    rank: num(d.rank),
    total_finalized_points: num(d.totalFinalizedPoints),
    referral_points: num(d.referralPoints),
    v1_points: num(d.v1Points),
    current: { episode: d.currentEpisode ?? null, chapter: d.currentChapter ?? null },
    updated_at: iso(num(d.lastUpdateTimestampSec) * 1000),
    program: d.stats
      ? { total_finalized_points: num(d.stats.totalFinalizedPoints), total_users: num(d.stats.totalUsers) }
      : null,
    multipliers: d.lastMultipliers || [],
    chapters,
  };
}
