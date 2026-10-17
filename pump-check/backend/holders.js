// The holder indexer: every token's balances, rebuilt from its Transfer
// events and kept current, in the store. It runs on its own schedule and
// never in a check's path; a check reads the balances table.
//
// Two jobs per chain, each tick:
//   follow    one cursor for the chain. Every "live" token's Transfer events
//             from the cursor to the head, many addresses per eth_getLogs,
//             applied in one transaction. Then the cursor moves.
//   backfill  a token joins at its creation block (found on chain by
//             EvmChain.creation) and is read page by page, alone, until it
//             reaches the follower's cursor; then it is live.
// A token whose history passes PUMP_INDEX_MAX_TRANSFERS or
// PUMP_INDEX_MAX_PAGES is marked too_busy and its partial balances dropped:
// its holder check says why rather than report a wrong share.
//
// Through Pocket only (no failover), like precompute: indexing volume never
// lands on the free backup endpoints. Blockscout's free plan does not cover
// Base, which is why this exists; any chain can be indexed (PUMP_INDEX_CHAINS).

import { TOPIC } from "./evm.js";
import { wordToAddress, wordToBigInt, ZERO_ADDRESS } from "./abi.js";

const ZERO = ZERO_ADDRESS;

export class HolderIndex {
  constructor({ store, evm, config }) {
    this.store = store;
    this.evm = evm;
    this.config = config;
    this.chains = config.indexChains.filter((c) => evm[c]);
    this.timers = [];
    this.busy = new Set();
    this.stats = Object.fromEntries(this.chains.map((c) => [c, { ticks: 0, follow_logs: 0, backfilled: 0, last_error: null, last_ok_at: null }]));
  }

  indexes(chain) {
    return this.chains.includes(chain);
  }

  start() {
    for (const chain of this.chains) {
      const tick = async () => {
        if (this.busy.has(chain)) return;
        this.busy.add(chain);
        try {
          await this.tick(chain);
          this.stats[chain].last_ok_at = new Date().toISOString();
        } catch (e) {
          this.stats[chain].last_error = (e && (e.kind || e.code || e.message)) || "error";
        } finally {
          this.busy.delete(chain);
        }
      };
      const t = setInterval(tick, this.config.indexIntervalMs);
      t.unref?.();
      this.timers.push(t);
      tick();
    }
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  async tick(chain) {
    const ev = this.evm[chain];
    const opts = { failover: false };
    const head = await ev.rpc.blockNumber(opts);
    let cursor = this.store.indexCursor(chain);
    if (cursor === null) {
      cursor = head;
      this.store.setIndexCursor(chain, cursor);
    }
    this.stats[chain].ticks++;
    await this.follow(chain, ev, cursor, head, opts);
    await this.backfill(chain, ev, opts);
  }

  // Every live token, from the cursor to the head, a page at a time.
  async follow(chain, ev, cursor, head, opts) {
    const live = this.store.indexTokens(chain, "live").map((r) => r.token);
    let from = cursor + 1;
    const page = this.config.logPageBlocks;
    // Bounded per tick so a long outage catches up over several ticks.
    for (let n = 0; from <= head && n < this.config.indexFollowPagesPerTick; n++) {
      const to = Math.min(head, from + page - 1);
      if (live.length) {
        const logs = [];
        for (let i = 0; i < live.length; i += this.config.indexBatch) {
          const { result } = await ev.rpc.getLogs({ address: live.slice(i, i + this.config.indexBatch), topics: [TOPIC.transfer], fromBlock: from, toBlock: to }, { ...opts, pageBlocks: page });
          for (const l of result) logs.push(l);
        }
        this.apply(chain, logs, { cursor: to });
        this.stats[chain].follow_logs += logs.length;
      } else {
        this.store.setIndexCursor(chain, to);
      }
      from = to + 1;
    }
  }

  // Tokens catching up from their creation block, a few pages each per tick.
  // A page doubles while it comes back sparse (a quiet old token costs a few
  // dozen calls, not one per 1,000 blocks) and the RPC layer splits any page
  // a node refuses.
  async backfill(chain, ev, opts) {
    const base = this.config.logPageBlocks;
    for (const row of this.store.indexTokens(chain, "backfill").slice(0, this.config.indexBackfillTokensPerTick)) {
      // One token's failed read leaves the rest of the tick running.
      try {
        await this.backfillOne(chain, ev, row, base, opts);
      } catch (e) {
        this.stats[chain].last_error = (e && (e.kind || e.code || e.message)) || "error";
      }
    }
  }

  async backfillOne(chain, ev, row, base, opts) {
    {
      let pages = 0;
      let span = base;
      while (pages < this.config.indexBackfillPagesPerTick) {
        const cursor = this.store.indexCursor(chain);
        const from = row.indexed_to + 1;
        if (from > cursor) {
          // A node that wrongly answers an old range with no logs leaves the
          // balances short of the supply. Re-read once; a token that still
          // does not add up rebases or reflects, and its check says so.
          const tok = this.store.token(chain, row.token);
          const supply = tok && tok.supply ? BigInt(tok.supply) : null;
          const total = this.store.balanceTotal(chain, row.token);
          const off = supply && supply > 0n ? Math.abs(1 - Number((total * 10000n) / supply) / 10000) >= 0.01 : false;
          const key = "reindexed:" + chain + ":" + row.token;
          if (off && !this.store.meta(key)) {
            this.store.setMeta(key, true);
            this.store.resetIndex(chain, row.token);
            this.stats[chain].reindexed = (this.stats[chain].reindexed || 0) + 1;
            break;
          }
          this.store.setIndexStatus(chain, row.token, "live");
          this.stats[chain].backfilled++;
          break;
        }
        const to = Math.min(cursor, from + span - 1);
        const { result } = await ev.rpc.getLogs({ address: row.token, topics: [TOPIC.transfer], fromBlock: from, toBlock: to }, { ...opts, pageBlocks: span });
        span = result.length < 2000 ? Math.min(span * 2, this.config.indexMaxSpan) : Math.max(base, Math.floor(span / 2));
        this.apply(chain, result, { token: row.token, indexedTo: to });
        row.indexed_to = to;
        row.transfers += result.length;
        row.pages += 1;
        pages++;
        if (row.transfers > this.config.indexMaxTransfers || row.pages > this.config.indexMaxPages) {
          this.store.dropIndex(chain, row.token, "too_busy");
          break;
        }
      }
    }
  }

  // Applies Transfer logs to balances in one transaction. ERC-721 transfers
  // (the same topic with four topics) are skipped. Balances that reach zero
  // are deleted, so the table holds holders only.
  apply(chain, logs, { cursor = null, token = null, indexedTo = null }) {
    const deltas = new Map(); // token -> Map(holder -> bigint)
    for (const l of logs) {
      if (!l.topics || l.topics.length !== 3 || l.removed) continue;
      const t = String(l.address).toLowerCase();
      const from = wordToAddress(l.topics[1].slice(2));
      const to = wordToAddress(l.topics[2].slice(2));
      const v = l.data && l.data.length >= 66 ? wordToBigInt(l.data.slice(2, 66)) : 0n;
      if (v === 0n) continue;
      if (!deltas.has(t)) deltas.set(t, new Map());
      const m = deltas.get(t);
      if (from !== ZERO) m.set(from, (m.get(from) || 0n) - v);
      if (to !== ZERO) m.set(to, (m.get(to) || 0n) + v);
    }
    this.store.applyBalances(chain, deltas, { cursor, token, indexedTo, transfers: logs.length });
  }

  // Enrolls a token once its creation block is known.
  enroll(chain, token, creationBlock) {
    if (!this.indexes(chain)) return;
    this.store.enrollIndex(chain, token, creationBlock);
  }

  // The holder check for an indexed chain, from the balances table.
  holderCheck(chain, token, supply, exclude, topHoldersWarnPct) {
    const st = this.store.indexState(chain, token);
    if (!st) return { result: "unknown", reason: "the holder index has not reached this token yet", method: null, source: null };
    if (st.status === "too_busy") {
      return {
        result: "unknown",
        reason: `too many transfers to index on chain (over ${this.config.indexMaxTransfers.toLocaleString("en-US")} or ${this.config.indexMaxPages} pages of history)`,
        method: null,
        source: null,
      };
    }
    if (st.status !== "live") return { result: "unknown", reason: "the holder index is reading this token's history; ask again in a minute", method: null, source: null };
    const cursor = this.store.indexCursor(chain);
    const rows = this.store.topBalances(chain, token, 10 + exclude.size + 3);
    const counted = rows.filter((r) => !exclude.has(r.holder));
    const top = counted.slice(0, 10);
    const sum = top.reduce((n, r) => n + BigInt(r.balance), 0n);
    const total = this.store.balanceTotal(chain, token);
    const pct = (a, b) => (b > 0n ? Number((a * 10000n) / b) / 100 : null);
    const share = supply ? pct(sum, supply) : null;
    // Balances built from Transfer events miss rebases and reflections; when
    // they do not add up to the supply the result is only a signal.
    const reconciled = supply && total > 0n ? Math.abs(1 - Number((total * 10000n) / supply) / 10000) < 0.01 : false;
    return {
      result: share === null ? "unknown" : share > topHoldersWarnPct ? "warn" : "pass",
      value: { top10_pct: share, excluded: rows.length - counted.length, holders: this.store.holderCount(chain, token), reconciled },
      reason: reconciled ? null : "balances from Transfer events do not add up to the supply (a rebasing or reflection token); shares are approximate",
      method: reconciled ? "definitive" : "heuristic",
      source: "stored",
      as_of: { block: cursor, indexer: "pump-check" },
      evidence: { holders: top.map((r) => ({ address: r.holder, pct: supply ? pct(BigInt(r.balance), supply) : null })) },
    };
  }

  status() {
    return Object.fromEntries(
      this.chains.map((c) => [c, { cursor: this.store.indexCursor(c), tokens: this.store.indexCounts(c), ...this.stats[c] }])
    );
  }
}
