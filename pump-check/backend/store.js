// The token store: SQLite in the data directory, WAL mode, using Node's
// built-in driver (no native module in the image).
//
// tokens   one row per (chain, address): identity, launchpad, first and last seen
// pools    every pool a token trades in, with its venue and quote
// checks   one row per (token, check id): the stored result and when it was read
// market   the latest DexPaprika snapshot per token
// ledger   DexPaprika credits spent per hour, for the rolling 30-day window
// balances every holder's balance per indexed token, from Transfer events
// index_tokens  each indexed token's state: backfill, live or too_busy

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT, symbol TEXT, decimals INTEGER, supply TEXT,
  launchpad TEXT, deployer TEXT, created_at TEXT, created_block INTEGER,
  first_seen INTEGER NOT NULL, last_active INTEGER NOT NULL,
  heat REAL NOT NULL DEFAULT 0,
  precomputed_at INTEGER, precompute_error TEXT,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS tokens_recent ON tokens (chain, first_seen DESC);
CREATE INDEX IF NOT EXISTS tokens_pending ON tokens (precomputed_at, heat DESC);
CREATE TABLE IF NOT EXISTS pools (
  chain TEXT NOT NULL, address TEXT NOT NULL, token TEXT NOT NULL,
  dex TEXT, quote TEXT, created_block INTEGER, created_at TEXT,
  liquidity_usd REAL, volume_usd_24h REAL, extra TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS pools_token ON pools (chain, token);
CREATE TABLE IF NOT EXISTS checks (
  chain TEXT NOT NULL, token TEXT NOT NULL, id TEXT NOT NULL,
  result TEXT NOT NULL, computed_at INTEGER NOT NULL,
  PRIMARY KEY (chain, token, id)
);
CREATE TABLE IF NOT EXISTS market (
  chain TEXT NOT NULL, token TEXT NOT NULL, data TEXT NOT NULL, fetched_at INTEGER NOT NULL,
  PRIMARY KEY (chain, token)
);
CREATE TABLE IF NOT EXISTS ledger (hour INTEGER PRIMARY KEY, credits INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS balances (
  chain TEXT NOT NULL, token TEXT NOT NULL, holder TEXT NOT NULL,
  balance TEXT NOT NULL, approx REAL NOT NULL,
  PRIMARY KEY (chain, token, holder)
);
CREATE INDEX IF NOT EXISTS balances_top ON balances (chain, token, approx DESC);
CREATE TABLE IF NOT EXISTS index_tokens (
  chain TEXT NOT NULL, token TEXT NOT NULL,
  status TEXT NOT NULL, start_block INTEGER NOT NULL, indexed_to INTEGER NOT NULL,
  transfers INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (chain, token)
);
CREATE INDEX IF NOT EXISTS index_tokens_status ON index_tokens (chain, status);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const HOUR = 3600000;

export class Store {
  constructor(dir, name = "pump-check.db") {
    if (dir !== ":memory:") mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dir === ":memory:" ? ":memory:" : join(dir, name));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    // Added after the first build: stores created before it gain the column.
    const cols = this.db.prepare("PRAGMA table_info(tokens)").all().map((r) => r.name);
    if (!cols.includes("enriched_at")) this.db.exec("ALTER TABLE tokens ADD COLUMN enriched_at INTEGER");
    if (!cols.includes("requested_at")) this.db.exec("ALTER TABLE tokens ADD COLUMN requested_at INTEGER");
    this.q = {
      upsertToken: this.db.prepare(`
        INSERT INTO tokens (chain, address, launchpad, created_at, created_block, first_seen, last_active, heat)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain, address) DO UPDATE SET
          last_active = excluded.last_active,
          heat = MAX(tokens.heat, excluded.heat),
          launchpad = COALESCE(tokens.launchpad, excluded.launchpad),
          created_at = COALESCE(tokens.created_at, excluded.created_at),
          created_block = COALESCE(tokens.created_block, excluded.created_block)`),
      identity: this.db.prepare(`
        UPDATE tokens SET name = COALESCE(?, name), symbol = COALESCE(?, symbol), decimals = COALESCE(?, decimals),
          supply = COALESCE(?, supply), launchpad = COALESCE(?, launchpad), deployer = COALESCE(?, deployer),
          created_at = COALESCE(?, created_at), created_block = COALESCE(?, created_block)
        WHERE chain = ? AND address = ?`),
      getToken: this.db.prepare("SELECT * FROM tokens WHERE chain = ? AND address = ?"),
      upsertPool: this.db.prepare(`
        INSERT INTO pools (chain, address, token, dex, quote, created_block, created_at, liquidity_usd, volume_usd_24h, extra, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chain, address) DO UPDATE SET
          liquidity_usd = COALESCE(excluded.liquidity_usd, pools.liquidity_usd), volume_usd_24h = COALESCE(excluded.volume_usd_24h, pools.volume_usd_24h),
          dex = COALESCE(excluded.dex, pools.dex), quote = COALESCE(excluded.quote, pools.quote),
          created_block = COALESCE(pools.created_block, excluded.created_block),
          created_at = COALESCE(pools.created_at, excluded.created_at),
          extra = COALESCE(excluded.extra, pools.extra), updated_at = excluded.updated_at`),
      pools: this.db.prepare("SELECT * FROM pools WHERE chain = ? AND token = ? ORDER BY liquidity_usd DESC"),
      putCheck: this.db.prepare(`
        INSERT INTO checks (chain, token, id, result, computed_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (chain, token, id) DO UPDATE SET result = excluded.result, computed_at = excluded.computed_at`),
      checks: this.db.prepare("SELECT id, result, computed_at FROM checks WHERE chain = ? AND token = ?"),
      putMarket: this.db.prepare(`
        INSERT INTO market (chain, token, data, fetched_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (chain, token) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`),
      market: this.db.prepare("SELECT data, fetched_at FROM market WHERE chain = ? AND token = ?"),
      pending: this.db.prepare(
        "SELECT chain, address FROM tokens WHERE precomputed_at IS NULL ORDER BY heat DESC, first_seen DESC LIMIT ?"
      ),
      pendingCount: this.db.prepare("SELECT COUNT(*) AS n FROM tokens WHERE precomputed_at IS NULL"),
      markPrecomputed: this.db.prepare("UPDATE tokens SET precomputed_at = ?, precompute_error = ? WHERE chain = ? AND address = ?"),
      pendingEnrich: this.db.prepare(
        "SELECT chain, address FROM tokens WHERE chain != 'solana' AND precomputed_at IS NOT NULL AND enriched_at IS NULL ORDER BY (requested_at IS NULL), requested_at DESC, heat DESC, first_seen DESC LIMIT ?"
      ),
      pendingEnrichCount: this.db.prepare(
        "SELECT COUNT(*) AS n FROM tokens WHERE chain != 'solana' AND precomputed_at IS NOT NULL AND enriched_at IS NULL"
      ),
      markRequested: this.db.prepare("UPDATE tokens SET requested_at = ? WHERE chain = ? AND address = ?"),
      deferEnrich: this.db.prepare("UPDATE tokens SET requested_at = NULL, heat = -1 WHERE chain = ? AND address = ?"),
      markEnriched: this.db.prepare("UPDATE tokens SET enriched_at = ? WHERE chain = ? AND address = ?"),
      recent: this.db.prepare(
        "SELECT * FROM tokens WHERE chain = ? AND precomputed_at IS NOT NULL ORDER BY first_seen DESC LIMIT ?"
      ),
      counts: this.db.prepare(
        "SELECT chain, COUNT(*) AS tokens, SUM(precomputed_at IS NOT NULL) AS precomputed FROM tokens GROUP BY chain"
      ),
      spend: this.db.prepare(
        "INSERT INTO ledger (hour, credits) VALUES (?, ?) ON CONFLICT (hour) DO UPDATE SET credits = credits + excluded.credits"
      ),
      spentSince: this.db.prepare("SELECT COALESCE(SUM(credits), 0) AS n FROM ledger WHERE hour >= ?"),
      pruneLedger: this.db.prepare("DELETE FROM ledger WHERE hour < ?"),
      getBalance: this.db.prepare("SELECT balance FROM balances WHERE chain = ? AND token = ? AND holder = ?"),
      putBalance: this.db.prepare(
        "INSERT INTO balances (chain, token, holder, balance, approx) VALUES (?, ?, ?, ?, ?) ON CONFLICT (chain, token, holder) DO UPDATE SET balance = excluded.balance, approx = excluded.approx"
      ),
      delBalance: this.db.prepare("DELETE FROM balances WHERE chain = ? AND token = ? AND holder = ?"),
      delBalances: this.db.prepare("DELETE FROM balances WHERE chain = ? AND token = ?"),
      topBalances: this.db.prepare("SELECT holder, balance FROM balances WHERE chain = ? AND token = ? ORDER BY approx DESC LIMIT ?"),
      allBalances: this.db.prepare("SELECT balance FROM balances WHERE chain = ? AND token = ?"),
      holderCount: this.db.prepare("SELECT COUNT(*) AS n FROM balances WHERE chain = ? AND token = ?"),
      enrollIndex: this.db.prepare(
        "INSERT INTO index_tokens (chain, token, status, start_block, indexed_to, updated_at) VALUES (?, ?, 'backfill', ?, ?, ?) ON CONFLICT (chain, token) DO NOTHING"
      ),
      indexTokens: this.db.prepare(
        "SELECT i.token, i.indexed_to, i.transfers, i.pages FROM index_tokens i LEFT JOIN tokens t ON t.chain = i.chain AND t.address = i.token WHERE i.chain = ? AND i.status = ? ORDER BY (t.requested_at IS NULL), t.requested_at DESC, i.updated_at"
      ),
      indexState: this.db.prepare("SELECT * FROM index_tokens WHERE chain = ? AND token = ?"),
      setIndexStatus: this.db.prepare("UPDATE index_tokens SET status = ?, updated_at = ? WHERE chain = ? AND token = ?"),
      advanceIndex: this.db.prepare(
        "UPDATE index_tokens SET indexed_to = ?, transfers = transfers + ?, pages = pages + 1, updated_at = ? WHERE chain = ? AND token = ?"
      ),
      indexCounts: this.db.prepare("SELECT status, COUNT(*) AS n FROM index_tokens WHERE chain = ? GROUP BY status"),
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),
      setMeta: this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value"),
      inactive: this.db.prepare("SELECT chain, address FROM tokens WHERE last_active < ?"),
      // Peer feeds: ordered by time, then chain and address, so a cursor resumes exactly.
      peerTokens: this.db.prepare(
        "SELECT chain, address, first_seen FROM tokens WHERE precomputed_at IS NOT NULL AND (first_seen > ? OR (first_seen = ? AND chain || ':' || address > ?)) ORDER BY first_seen, chain, address LIMIT ?"
      ),
      peerCreations: this.db.prepare(
        "SELECT chain, token, result, computed_at FROM checks WHERE id = '_creation' AND (computed_at > ? OR (computed_at = ? AND chain || ':' || token > ?)) ORDER BY computed_at, chain, token LIMIT ?"
      ),
      reEnrich: this.db.prepare("UPDATE tokens SET enriched_at = NULL, requested_at = NULL WHERE chain = ? AND address = ?"),
    };
  }

  // ---- tokens and pools ----

  seeToken(chain, address, { launchpad = null, createdAt = null, createdBlock = null, heat = 0, now = Date.now() } = {}) {
    this.q.upsertToken.run(chain, address, launchpad, createdAt, createdBlock, now, now, heat);
  }

  setIdentity(chain, address, id) {
    this.q.identity.run(
      id.name ?? null,
      id.symbol ?? null,
      id.decimals ?? null,
      id.supply != null ? String(id.supply) : null,
      id.launchpad ?? null,
      id.deployer ?? null,
      id.createdAt ?? null,
      id.createdBlock ?? null,
      chain,
      address
    );
  }

  token(chain, address) {
    return this.q.getToken.get(chain, address) || null;
  }

  upsertPool(chain, p, now = Date.now()) {
    this.q.upsertPool.run(
      chain,
      p.address,
      p.token,
      p.dex ?? null,
      p.quote ?? null,
      p.createdBlock ?? null,
      p.createdAt ?? null,
      p.liquidityUsd ?? null,
      p.volumeUsd24h ?? null,
      p.extra ? JSON.stringify(p.extra) : null,
      now
    );
  }

  pools(chain, token) {
    return this.q.pools.all(chain, token).map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null }));
  }

  // ---- checks ----

  putCheck(chain, token, id, result, now = Date.now()) {
    this.q.putCheck.run(chain, token, id, JSON.stringify(result), now);
  }

  checks(chain, token) {
    const out = {};
    for (const r of this.q.checks.all(chain, token)) out[r.id] = { ...JSON.parse(r.result), computed_at: r.computed_at };
    return out;
  }

  // ---- market ----

  putMarket(chain, token, data, now = Date.now()) {
    this.q.putMarket.run(chain, token, JSON.stringify(data), now);
  }

  market(chain, token) {
    const r = this.q.market.get(chain, token);
    return r ? { ...JSON.parse(r.data), fetched_at: new Date(r.fetched_at).toISOString() } : null;
  }

  // ---- precompute queue ----

  pending(limit) {
    return this.q.pending.all(limit);
  }

  pendingCount() {
    return this.q.pendingCount.get().n;
  }

  markPrecomputed(chain, address, error = null, now = Date.now()) {
    this.q.markPrecomputed.run(error ? null : now, error, chain, address);
  }

  pendingEnrich(limit) {
    return this.q.pendingEnrich.all(limit);
  }

  pendingEnrichCount() {
    return this.q.pendingEnrichCount.get().n;
  }

  // A caller asked about this token: its Blockscout enrichment goes first.
  markRequested(chain, address, now = Date.now()) {
    this.q.markRequested.run(now, chain, address);
  }

  deferEnrich(chain, address) {
    this.q.deferEnrich.run(chain, address);
  }

  markEnriched(chain, address, now = Date.now()) {
    this.q.markEnriched.run(now, chain, address);
  }

  recent(chain, limit) {
    return this.q.recent.all(chain, limit);
  }

  counts() {
    return this.q.counts.all();
  }

  // ---- DexPaprika ledger: credits per hour, summed over a rolling 30 days ----

  spendCredits(n, now = Date.now()) {
    this.q.spend.run(Math.floor(now / HOUR), n);
  }

  creditsSpent({ hours = 720, now = Date.now() } = {}) {
    return this.q.spentSince.get(Math.floor(now / HOUR) - hours + 1).n;
  }

  // ---- holder index ----

  indexCursor(chain) {
    return this.meta("index_cursor:" + chain);
  }

  setIndexCursor(chain, block) {
    this.setMeta("index_cursor:" + chain, block);
  }

  enrollIndex(chain, token, creationBlock, now = Date.now()) {
    this.q.enrollIndex.run(chain, token, creationBlock, creationBlock - 1, now);
  }

  indexTokens(chain, status) {
    return this.q.indexTokens.all(chain, status).map((r) => ({ ...r }));
  }

  indexState(chain, token) {
    return this.q.indexState.get(chain, token) || null;
  }

  setIndexStatus(chain, token, status, now = Date.now()) {
    this.q.setIndexStatus.run(status, now, chain, token);
  }

  // Stops indexing a token and drops its partial balances.
  dropIndex(chain, token, status, now = Date.now()) {
    this.db.exec("BEGIN");
    try {
      this.q.delBalances.run(chain, token);
      this.q.setIndexStatus.run(status, now, chain, token);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // deltas: Map(token -> Map(holder -> bigint change)). With `cursor`, the
  // chain's follow cursor moves in the same transaction; with `token`, that
  // token's backfill position does.
  applyBalances(chain, deltas, { cursor = null, token = null, indexedTo = null, transfers = 0 } = {}, now = Date.now()) {
    this.db.exec("BEGIN");
    try {
      for (const [t, m] of deltas) {
        for (const [holder, d] of m) {
          if (d === 0n) continue;
          const row = this.q.getBalance.get(chain, t, holder);
          const next = (row ? BigInt(row.balance) : 0n) + d;
          if (next <= 0n) this.q.delBalance.run(chain, t, holder);
          else this.q.putBalance.run(chain, t, holder, next.toString(), Number(next));
        }
      }
      if (token !== null) this.q.advanceIndex.run(indexedTo, transfers, now, chain, token);
      if (cursor !== null) this.q.setMeta.run("index_cursor:" + chain, JSON.stringify(cursor));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // Starts a token's backfill over from its creation block.
  resetIndex(chain, token, now = Date.now()) {
    const st = this.indexState(chain, token);
    if (!st) return;
    this.db.exec("BEGIN");
    try {
      this.q.delBalances.run(chain, token);
      this.db.prepare("UPDATE index_tokens SET status = 'backfill', indexed_to = start_block - 1, transfers = 0, pages = 0, updated_at = ? WHERE chain = ? AND token = ?").run(now, chain, token);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  topBalances(chain, token, n) {
    return this.q.topBalances.all(chain, token, n).map((r) => ({ holder: r.holder, balance: r.balance }));
  }

  balanceTotal(chain, token) {
    return this.q.allBalances.all(chain, token).reduce((n, r) => n + BigInt(r.balance), 0n);
  }

  holderCount(chain, token) {
    return this.q.holderCount.get(chain, token).n;
  }

  indexCounts(chain) {
    return Object.fromEntries(this.q.indexCounts.all(chain).map((r) => [r.status, r.n]));
  }

  // ---- peer sync ----

  // This node's Ed25519 seed, made on first use and kept with the data.
  nodeSeed(make) {
    let seed = this.meta("node_key_seed");
    if (!seed) {
      seed = make();
      this.setMeta("node_key_seed", seed);
    }
    return seed;
  }

  // after: { ts, key } where key is "chain:address"; the start is { ts: 0, key: "" }.
  peerTokens(after, limit) {
    return this.q.peerTokens.all(after.ts, after.ts, after.key, limit).map((r) => ({ ...r }));
  }

  peerCreations(after, limit) {
    return this.q.peerCreations.all(after.ts, after.ts, after.key, limit).map((r) => ({ chain: r.chain, token: r.token, creation: JSON.parse(r.result), ts: r.computed_at }));
  }

  // A peer gave this token's creation: enrichment runs again, on the cheap path.
  reEnrich(chain, address) {
    this.q.reEnrich.run(chain, address);
  }

  // A live token's balances, read in one statement so they belong to one
  // cursor: the follower applies each page in a transaction. Null when the
  // token is not live here or has more holders than `max`.
  holderSnapshot(chain, token, max) {
    const st = this.indexState(chain, token);
    if (!st || st.status !== "live") return null;
    if (this.holderCount(chain, token) > max) return null;
    const block = this.indexCursor(chain);
    const holders = this.db.prepare("SELECT holder, balance FROM balances WHERE chain = ? AND token = ?").all(chain, token).map((r) => [r.holder, r.balance]);
    return { block, holders };
  }

  // A verified snapshot at `block` replaces a backfilling token's balances;
  // the backfill goes on from block + 1.
  adoptSnapshot(chain, token, block, holders, now = Date.now()) {
    this.db.exec("BEGIN");
    try {
      this.q.delBalances.run(chain, token);
      for (const [holder, balance] of holders) this.q.putBalance.run(chain, token, holder, balance.toString(), Number(balance));
      this.db.prepare("UPDATE index_tokens SET indexed_to = ?, updated_at = ? WHERE chain = ? AND token = ? AND status = 'backfill'").run(block, now, chain, token);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---- meta and retention ----

  meta(key) {
    const r = this.q.getMeta.get(key);
    return r ? JSON.parse(r.value) : null;
  }

  setMeta(key, value) {
    this.q.setMeta.run(key, JSON.stringify(value));
  }

  // Tokens with no ingest activity for `days` go, with everything stored about them.
  prune(days, now = Date.now()) {
    const cutoff = now - days * 86400000;
    const gone = this.q.inactive.all(cutoff);
    if (!gone.length) return 0;
    this.db.exec("BEGIN");
    try {
      const del = ["tokens", "pools", "checks", "market", "balances", "index_tokens"].map((t) =>
        this.db.prepare(`DELETE FROM ${t} WHERE chain = ? AND ${t === "tokens" ? "address" : "token"} = ?`)
      );
      for (const g of gone) for (const d of del) d.run(g.chain, g.address);
      this.q.pruneLedger.run(Math.floor(now / HOUR) - 24 * 31);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return gone.length;
  }

  close() {
    this.db.close();
  }
}
