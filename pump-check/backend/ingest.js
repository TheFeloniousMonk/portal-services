// Ingest: every PUMP_INGEST_INTERVAL_MS, read the newest pools per chain from
// DexPaprika's list endpoints (one credit a page, whatever the row count) and
// put every new token in the store, hottest first in the precompute queue.
//
// Credit plan at the defaults (2 + 1 + 1 pool pages every 2 minutes, plus one
// volume-ranked token page every 6 ticks, rotating across chains):
//   pools   4 x 21,600 ticks = 86,400 per 30 days
//   tokens  21,600 / 6      =  3,600 per 30 days
// The ledger stops all spending at PUMP_MONTHLY_CREDITS whatever happens.
//
// Pons launches on Robinhood Chain are read from the factory's TokenLaunched
// logs, which costs no credits and catches tokens still on their curve (a
// curve is not a DEX pool, so DexPaprika does not list it).

import { newestPools, NOTE } from "./dexpaprika.js";
import { SOLANA, SOLANA_LAUNCHPAD_DEXES, EVM_QUOTES, EVM } from "./chains.js";
import { TOPIC } from "./evm.js";
import { wordToAddress } from "./abi.js";

const TOKEN_PAGE_EVERY = 6;

export function quoteSet(chain) {
  return chain === "solana" ? SOLANA.quotes : EVM_QUOTES[chain];
}

const norm = (chain, a) => (chain === "solana" ? a : String(a).toLowerCase());

// The memecoin side(s) of a pool row: every token that is not a quote asset.
export function memeSides(chain, row) {
  const q = quoteSet(chain);
  const ids = (row.tokens || []).map((t) => norm(chain, typeof t === "string" ? t : t.id)).filter(Boolean);
  const memes = ids.filter((id) => !q.has(id));
  const quote = ids.find((id) => q.has(id)) || null;
  return { memes, quote };
}

// Liquidity, volume and trades summed over the token's known pools, and the
// token's creation time from its earliest pool. Price and FDV come only from a
// token row (see absorbTokens): a pool row's price belongs to whichever side
// DexPaprika treats as base, which is not always the memecoin.
export function refreshMarket(store, chain, token, now = Date.now()) {
  const pools = store.pools(chain, token);
  if (!pools.length) return;
  const prev = store.market(chain, token) || {};
  // null when no pool carries the figure, so an unknown is never reported as zero.
  const sum = (f) => (pools.some((p) => Number.isFinite(f(p))) ? pools.reduce((n, p) => n + (Number.isFinite(f(p)) ? f(p) : 0), 0) : null);
  store.putMarket(
    chain,
    token,
    {
      price_usd: prev.price_usd ?? null,
      fdv_usd: prev.fdv_usd ?? null,
      liquidity_usd: sum((p) => p.liquidity_usd),
      volume_usd_24h: sum((p) => p.volume_usd_24h),
      txns_24h: sum((p) => (p.extra ? p.extra.txns_24h : null)),
      price_at: prev.price_at ?? null,
    },
    now
  );
  const dated = pools.filter((p) => p.created_at).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
  if (dated) store.setIdentity(chain, token, { createdAt: dated.created_at, createdBlock: dated.created_block ?? null });
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export class Ingest {
  constructor({ store, dexpaprika, evm, config }) {
    this.store = store;
    this.dexpaprika = dexpaprika;
    this.evm = evm; // { robinhood: EvmChain } for Pons log ingest
    this.config = config;
    this.tick = 0;
    this.timer = null;
    this.running = false;
    this.stats = { last_ok_at: null, last_tick_at: null, ticks: 0, new_tokens: 0, notes: {}, per_chain: {} };
    const restored = store.meta("ingest");
    if (restored) {
      this.stats.last_ok_at = restored.last_ok_at || null;
      this.ponsFrom = restored.pons_from || null;
    }
  }

  start(onNew) {
    this.onNew = onNew;
    const loop = async () => {
      await this.runOnce().catch((e) => console.error(JSON.stringify({ msg: "ingest failed", error: String(e && e.message) })));
      this.timer = setTimeout(loop, this.config.ingestIntervalMs);
      this.timer.unref?.();
    };
    if (this.config.ingestOnStart) loop();
    else this.timer = setTimeout(loop, this.config.ingestIntervalMs);
  }

  stop() {
    clearTimeout(this.timer);
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    this.stats.last_tick_at = new Date(t0).toISOString();
    let anyOk = false;
    try {
      for (const chain of ["solana", "base", "robinhood"]) {
        const pages = this.config.pages[chain];
        let cursor;
        let ok = 0;
        let added = 0;
        for (let i = 0; i < pages; i++) {
          const out = await newestPools(this.dexpaprika, chain, cursor);
          if (!out.ok) {
            this.note(out.note);
            break;
          }
          ok++;
          added += this.absorbPools(chain, out.data.results || []);
          cursor = out.data.next_cursor;
          if (!out.data.has_next_page || !cursor) break;
        }
        if (ok) anyOk = true;
        this.stats.per_chain[chain] = { pages_ok: ok, new_tokens: added, at: new Date().toISOString() };
      }
      // One volume-ranked token page, rotating across chains, refreshes price,
      // FDV and activity for the tokens that are trading now.
      if (this.tick % TOKEN_PAGE_EVERY === 0) {
        const chain = ["solana", "base", "robinhood"][Math.floor(this.tick / TOKEN_PAGE_EVERY) % 3];
        const out = await this.dexpaprika.get(`/networks/${chain}/tokens/search`, { order_by: "volume_usd_24h", sort: "desc", limit: 100 });
        if (out.ok) this.absorbTokens(chain, out.data.results || []);
        else this.note(out.note);
      }
      if (this.config.ponsIngest && this.evm.robinhood) {
        await this.ponsLaunches().catch((e) => this.note("pons_logs_" + (e && e.kind ? e.kind : "error")));
      }
      if (anyOk) this.stats.last_ok_at = new Date().toISOString();
      this.tick++;
      this.stats.ticks++;
      this.store.setMeta("ingest", { last_ok_at: this.stats.last_ok_at, pons_from: this.ponsFrom || null });
    } finally {
      this.running = false;
    }
  }

  note(n) {
    if (!n) return;
    this.stats.notes[n] = (this.stats.notes[n] || 0) + 1;
  }

  absorbPools(chain, rows, now = Date.now()) {
    let added = 0;
    const touched = new Map();
    for (const row of rows) {
      const { memes, quote } = memeSides(chain, row);
      const dex = row.dex_id || null;
      for (const token of memes) {
        const existed = this.store.token(chain, token);
        const launchpad = chain === "solana" ? SOLANA_LAUNCHPAD_DEXES.get(dex) || null : null;
        this.store.seeToken(chain, token, {
          launchpad,
          createdAt: row.created_at || null,
          createdBlock: num(row.created_at_block_number),
          heat: num(row.volume_usd_24h) || 0,
          now,
        });
        this.store.upsertPool(
          chain,
          {
            address: norm(chain, row.id),
            token,
            dex,
            quote,
            createdBlock: num(row.created_at_block_number),
            createdAt: row.created_at || null,
            liquidityUsd: num(row.liquidity_usd),
            volumeUsd24h: num(row.volume_usd_24h),
            extra: { txns_24h: num(row.transactions_24h) },
          },
          now
        );
        touched.set(token, true);
        if (!existed) {
          added++;
          this.stats.new_tokens++;
        }
      }
    }
    for (const token of touched.keys()) this.refreshMarketFromPools(chain, token, now);
    if (added && this.onNew) this.onNew();
    return added;
  }

  refreshMarketFromPools(chain, token, now = Date.now()) {
    refreshMarket(this.store, chain, token, now);
  }

  absorbTokens(chain, rows, now = Date.now()) {
    for (const r of rows) {
      const token = norm(chain, r.address || r.id);
      if (!token || quoteSet(chain).has(token)) continue;
      if (!this.store.token(chain, token)) continue; // ranks only tokens we already track
      const prev = this.store.market(chain, token) || {};
      this.store.putMarket(
        chain,
        token,
        {
          ...prev,
          price_usd: num(r.price_usd),
          fdv_usd: num(r.fdv_usd),
          liquidity_usd: num(r.liquidity_usd) ?? prev.liquidity_usd ?? null,
          volume_usd_24h: num(r.volume_usd_24h) ?? prev.volume_usd_24h ?? null,
          txns_24h: num(r.txns_24h) ?? prev.txns_24h ?? null,
          price_at: new Date(now).toISOString(),
        },
        now
      );
      this.store.seeToken(chain, token, { heat: num(r.volume_usd_24h) || 0, now });
    }
  }

  // Pons V2 launches since the last block read, from the factory's events.
  async ponsLaunches() {
    const rh = this.evm.robinhood;
    const head = await rh.rpc.blockNumber({ failover: false });
    // About 2 minutes of Robinhood blocks on first start; afterwards, from the last read.
    const from = this.ponsFrom ? this.ponsFrom + 1 : head - 1200;
    if (from > head) return;
    const { result } = await rh.rpc.getLogs(
      { address: EVM.robinhood.ponsV2Factory, topics: [TOPIC.ponsLaunched], fromBlock: Math.max(from, head - 20000), toBlock: head },
      { failover: false }
    );
    let added = 0;
    for (const l of result) {
      const token = wordToAddress(l.topics[1].slice(2));
      const curve = wordToAddress(l.topics[2].slice(2));
      const pair = wordToAddress(l.data.slice(2, 66));
      const block = Number(BigInt(l.blockNumber));
      const existed = this.store.token("robinhood", token);
      this.store.seeToken("robinhood", token, { launchpad: "pons", createdBlock: block, heat: 0 });
      this.store.upsertPool("robinhood", { address: curve, token, dex: "pons_curve", quote: pair, createdBlock: block, liquidityUsd: null, volumeUsd24h: null });
      if (!existed) {
        added++;
        this.stats.new_tokens++;
      }
    }
    this.ponsFrom = head;
    this.stats.per_chain.pons = { launches: added, to_block: head, at: new Date().toISOString() };
    if (added && this.onNew) this.onNew();
  }

  status() {
    return {
      interval_seconds: Math.round(this.config.ingestIntervalMs / 1000),
      last_ok_at: this.stats.last_ok_at,
      last_tick_at: this.stats.last_tick_at,
      ticks: this.stats.ticks,
      new_tokens: this.stats.new_tokens,
      notes: this.stats.notes,
      per_chain: this.stats.per_chain,
    };
  }

  // Ready means an ingest completed in the last 10 minutes.
  get fresh() {
    return Boolean(this.stats.last_ok_at) && Date.now() - Date.parse(this.stats.last_ok_at) < 10 * 60000;
  }
}

export { NOTE };
