// The rolling window of launches, held in memory and mirrored to a CSV file.
//
// Fields are split by whether they can change:
//   - identity (name, symbol, socials, supply) is fetched once per pool and
//     never refetched, because it does not change;
//   - traction (price, volume, transactions, liquidity) is refreshed on every
//     poll from the same list call that discovers new pools, which costs
//     nothing extra and stops rows from freezing at their discovery values.
//
// The CSV is the durable copy. It is rewritten whole, to a temp file and then
// renamed, so a request can never read a half-written file, and it is reloaded
// on boot so a restart does not lose the window.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const QUOTE_ASSETS = new Set([
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
]);

export const COLUMNS = Object.freeze([
  "pool_address", "dex_id", "created_at", "first_seen", "token_address",
  "name", "symbol", "decimals", "total_supply", "website", "twitter", "has_image",
  "price_usd", "fdv_usd", "liquidity_usd", "quote_reserve_usd",
  "volume_usd", "txns", "buys", "sells", "buy_usd", "sell_usd", "split_unreliable",
  "vol_per_txn", "price_change_5m", "ath_usd", "ath_at", "drawdown_from_ath_pct",
  "updated_at",
]);

const NUMERIC_COLUMNS = new Set([
  "decimals", "total_supply", "price_usd", "fdv_usd", "liquidity_usd", "quote_reserve_usd",
  "volume_usd", "txns", "buys", "sells", "buy_usd", "sell_usd", "vol_per_txn",
  "price_change_5m", "ath_usd", "drawdown_from_ath_pct",
]);

const BOOLEAN_COLUMNS = new Set(["has_image", "split_unreliable"]);

const DQUOTE = String.fromCharCode(34);

// The buy and sell split is DexPaprika's, and on some PumpSwap pools it books
// every trade as a sell (seen 2026-10-16: 23 of 34 PumpSwap pools in the window,
// 1,275 sells and 0 buys while the price rose 48% in an hour). A real pool with
// this many trades always has both sides, so a one-sided split above the
// threshold is withheld: the four split fields become null and split_unreliable
// says why, rather than telling an agent that nobody is buying.
export const SPLIT_GUARD_MIN_TXNS = 20;

export function guardSplit(fields, minTxns = SPLIT_GUARD_MIN_TXNS) {
  const buys = numOrNull(fields.buys);
  const sells = numOrNull(fields.sells);
  const oneSided = buys !== null && sells !== null && (buys === 0 || sells === 0) && buys + sells >= minTxns;
  if (!oneSided) return { ...fields, split_unreliable: false };
  return { ...fields, buys: null, sells: null, buy_usd: null, sell_usd: null, split_unreliable: true };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round(v, dp) {
  return v === null || v === undefined ? null : Number(v.toFixed(dp));
}

export function memeTokenOf(tokens = []) {
  const ids = tokens
    .map((t) => (typeof t === "string" ? t : t && t.id))
    .filter(Boolean);
  const meme = ids.find((id) => !QUOTE_ASSETS.has(id));
  return meme || ids[1] || ids[0] || null;
}

// Mutable metrics from one list row. For a pool younger than an hour the
// "24h" totals are really since-launch totals, which is exactly what a launch
// feed wants. The 5m change is the only price window worth reading this early;
// the 6h and 24h figures read zero until the pool is older than they are.
export function tractionFrom(listRow) {
  const volume = numOrNull(listRow.volume_usd_24h) ?? 0;
  const txns = numOrNull(listRow.transactions_24h) ?? 0;
  return {
    dex_id: listRow.dex_id || "",
    created_at: listRow.created_at || "",
    token_address: memeTokenOf(listRow.tokens),
    price_usd: numOrNull(listRow.price_usd),
    liquidity_usd: numOrNull(listRow.liquidity_usd),
    volume_usd: volume,
    txns,
    vol_per_txn: txns > 0 ? round(volume / txns, 4) : null,
    price_change_5m: round(numOrNull(listRow.price_change_percentage_5m), 4),
    updated_at: new Date().toISOString(),
  };
}

// Identity plus the figures only the detail call carries: the buy and sell
// split, the true quote-side reserve, and the all-time high.
export function enrichmentFrom(details, { splitMinTxns = SPLIT_GUARD_MIN_TXNS } = {}) {
  if (!details) return null;
  const tokens = Array.isArray(details.tokens) ? details.tokens : [];
  const memeId =
    details.base_token_id && !QUOTE_ASSETS.has(details.base_token_id)
      ? details.base_token_id
      : memeTokenOf(tokens);
  const meme = tokens.find((t) => t && t.id === memeId) || {};
  const reserves = Array.isArray(details.token_reserves) ? details.token_reserves : [];
  const quoteReserve = reserves.find((r) => r && QUOTE_ASSETS.has(r.token_id));
  const window24 = details["24h"] || {};

  const price = numOrNull(details.last_price_usd);
  const ath = numOrNull(details.price_stats && details.price_stats.ath);

  // Upstream reports supply in base units here. Scaling by decimals makes it
  // the whole-token figure, so price multiplied by supply reconciles with fdv.
  const decimals = numOrNull(meme.decimals);
  const rawSupply = numOrNull(meme.total_supply);
  const supply =
    rawSupply !== null && decimals !== null && decimals >= 0 ? rawSupply / 10 ** decimals : rawSupply;

  return guardSplit({
    token_address: memeId || "",
    name: meme.name || "",
    symbol: meme.symbol || "",
    decimals,
    total_supply: supply,
    website: meme.website || "",
    twitter: details.twitter || meme.twitter || "",
    has_image: meme.has_image === true,
    fdv_usd: numOrNull(meme.fdv),
    // liquidity_usd does not reconcile with the reserves on a bonding-curve
    // pool. The quote-side reserve is the honest measure of money in the pool.
    quote_reserve_usd: numOrNull(quoteReserve && quoteReserve.reserve_usd),
    buys: numOrNull(window24.buys),
    sells: numOrNull(window24.sells),
    buy_usd: numOrNull(window24.buy_usd),
    sell_usd: numOrNull(window24.sell_usd),
    ath_usd: ath,
    ath_at: (details.price_stats && details.price_stats.ath_date) || "",
    drawdown_from_ath_pct:
      ath && price !== null && ath > 0 ? round(((price - ath) / ath) * 100, 4) : null,
  }, splitMinTxns);
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes(DQUOTE) || s.includes("\n") || s.includes("\r")) {
    return DQUOTE + s.split(DQUOTE).join(DQUOTE + DQUOTE) + DQUOTE;
  }
  return s;
}

export function toCsv(rows, columns = COLUMNS) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(","));
  return lines.join("\n") + "\n";
}

function splitCsvLine(line) {
  const out = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === DQUOTE && line[i + 1] === DQUOTE) {
        cell += DQUOTE;
        i++;
      } else if (ch === DQUOTE) {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === DQUOTE) {
      quoted = true;
    } else if (ch === ",") {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

export function parseCsv(text) {
  const lines = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === DQUOTE) {
      quoted = !quoted;
      cur += ch;
    } else if (ch === "\n" && !quoted) {
      lines.push(cur);
      cur = "";
    } else if (ch === "\r" && !quoted) {
      continue;
    } else {
      cur += ch;
    }
  }
  if (cur.length) lines.push(cur);
  if (!lines.length) return [];

  const header = splitCsvLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].length) continue;
    const cells = splitCsvLine(lines[i]);
    const row = {};
    header.forEach((h, j) => {
      const raw = cells[j] === undefined ? "" : cells[j];
      if (BOOLEAN_COLUMNS.has(h)) row[h] = raw === "true";
      else if (NUMERIC_COLUMNS.has(h)) row[h] = raw === "" ? null : Number(raw);
      else row[h] = raw;
    });
    rows.push(row);
  }
  return rows;
}

export class LaunchTable {
  constructor(dir, csvName, windowMinutes, { splitMinTxns = SPLIT_GUARD_MIN_TXNS } = {}) {
    this.dir = dir;
    this.path = join(dir, csvName);
    this.windowMinutes = windowMinutes;
    this.splitMinTxns = splitMinTxns;
    this.rows = new Map();
  }

  async load() {
    try {
      const text = await readFile(this.path, "utf8");
      for (const row of parseCsv(text)) {
        // Rows saved before the split guard existed get it applied here, since
        // the split is identity and is never refetched.
        if (row.pool_address) this.rows.set(row.pool_address, guardSplit(row, this.splitMinTxns));
      }
      this.prune();
    } catch {
      // No file yet. The first poll backfills the window.
    }
  }

  has(poolAddress) {
    return this.rows.has(poolAddress);
  }

  // Refresh the mutable half of a row we already hold. Returns false if unknown.
  refresh(poolAddress, traction) {
    const row = this.rows.get(poolAddress);
    if (!row) return false;
    Object.assign(row, traction);
    return true;
  }

  // Add a fully enriched launch. Identity is written once and never rewritten.
  insert(poolAddress, traction, identity) {
    const row = {
      pool_address: poolAddress,
      first_seen: new Date().toISOString(),
      ...traction,
      ...identity,
    };
    for (const c of COLUMNS) if (row[c] === undefined) row[c] = null;
    this.rows.set(poolAddress, row);
    return row;
  }

  prune(now = Date.now()) {
    const cutoff = now - this.windowMinutes * 60 * 1000;
    let dropped = 0;
    for (const [addr, row] of this.rows) {
      const t = Date.parse(row.created_at);
      // A row with an unreadable creation time is dropped rather than kept
      // forever; it would otherwise never age out of the window.
      if (!Number.isFinite(t) || t < cutoff) {
        this.rows.delete(addr);
        dropped++;
      }
    }
    return dropped;
  }

  // Newest launch first.
  all() {
    return [...this.rows.values()].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)
    );
  }

  get size() {
    return this.rows.size;
  }

  async save() {
    await mkdir(this.dir, { recursive: true });
    const tmp = this.path + ".tmp";
    await writeFile(tmp, toCsv(this.all()), "utf8");
    await rename(tmp, this.path);
  }
}
