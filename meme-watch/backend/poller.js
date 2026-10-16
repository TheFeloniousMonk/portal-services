// The poll cycle.
//
// One cycle, in order:
//   1. Re-read the whole creation-time window, newest first, within the page
//      budget. The whole window rather than only what is new since last time:
//      the upstream index lags reality by up to a minute, so a pool can appear
//      after we have already moved past its creation time. A high-water mark
//      would step over it permanently; re-reading the window picks it up on the
//      next cycle.
//   2. Refresh the traction fields of rows already held.
//   3. Enrich pools we have not seen before, hottest first, within whatever
//      call budget is left, and only then add them to the table. A launch is
//      never published without its identity.
//   4. Prune anything that has aged out, then rewrite the CSV atomically.

import { config } from "./config.js";
import { fetchWindowPage, fetchPoolDetails, NOTE } from "./dexpaprika.js";
import { tractionFrom, enrichmentFrom } from "./store.js";

export class Poller {
  constructor(client, ledger, table) {
    this.client = client;
    this.ledger = ledger;
    this.table = table;
    // Discovered but not yet named: pool_address -> traction. Held in memory
    // only. These are deliberately absent from the CSV until enrichment lands.
    this.pending = new Map();
    this.timer = null;
    this.running = false;
    // One-time extra enrichment calls, to fill the window after a cold start
    // instead of converging on it over several hours.
    this.coldStartRemaining = config.coldStartExtraCalls;

    this.stats = {
      last_poll_at: null,
      last_poll_ok: false,
      upstream_note: NOTE.OK,
      polls: 0,
      calls_last_poll: 0,
      window_truncated: false,
      refreshed_last_poll: 0,
      added_last_poll: 0,
      ready: false,
    };
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      this.cycle().catch((err) => {
        console.error(JSON.stringify({ msg: "poll cycle failed", error: String(err && err.message) }));
      });
    };
    if (config.pollOnStart) tick();
    this.timer = setInterval(tick, config.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  windowStartSeconds(now = Date.now()) {
    return Math.floor((now - config.windowMinutes * 60 * 1000) / 1000);
  }

  // Everything at or before this instant is assumed fully indexed upstream.
  // Rows newer than it are still reported, but a consumer can use this to tell
  // "nothing launched" apart from "not indexed yet".
  completeBefore(now = Date.now()) {
    return new Date(now - config.indexLagSeconds * 1000).toISOString();
  }

  async cycle() {
    if (this.running) return;
    this.running = true;
    const startedAt = Date.now();
    let budget = Math.min(config.maxCallsPerPoll, this.ledger.remaining);
    // Top up from the cold-start pool while a backlog is waiting to be named.
    const coldStartTopUp = Math.min(
      this.coldStartRemaining,
      config.coldStartPerPoll,
      Math.max(0, this.ledger.remaining - budget)
    );
    budget += coldStartTopUp;

    const startBudget = budget;
    let note = NOTE.OK;
    let refreshed = 0;
    let added = 0;
    let truncated = false;
    const spent = () => startBudget - budget;

    try {
      if (budget <= 0) {
        note = NOTE.BUDGET_EXHAUSTED;
        return;
      }

      // --- 1. read the window ------------------------------------------
      const createdAfter = this.windowStartSeconds(startedAt);
      const seen = new Map();
      let cursor;
      let pages = 0;

      while (pages < config.maxListPages && budget > 0) {
        const res = await fetchWindowPage(this.client, { createdAfter, cursor });
        budget--;
        if (!res.ok) {
          note = res.note;
          break;
        }
        pages++;
        const results = Array.isArray(res.data.results) ? res.data.results : [];
        for (const row of results) {
          if (row && row.id) seen.set(row.id, tractionFrom(row));
        }
        if (!res.data.has_next_page) break;
        cursor = res.data.next_cursor;
        if (pages >= config.maxListPages) truncated = true;
      }

      // --- 2. refresh what we already hold, queue what we do not --------
      for (const [address, traction] of seen) {
        if (this.table.refresh(address, traction)) {
          refreshed++;
        } else {
          // Overwrites any previous pending entry, so a queued launch keeps
          // current traction and is ranked fairly against newer arrivals.
          this.pending.set(address, traction);
        }
      }

      // --- 3. enrich, hottest first, then publish -----------------------
      const queue = [...this.pending.entries()].sort(
        (a, b) => (b[1].volume_usd || 0) - (a[1].volume_usd || 0)
      );
      for (const [address, traction] of queue) {
        if (budget <= 0) break;
        const res = await fetchPoolDetails(this.client, address);
        budget--;
        if (!res.ok) {
          note = res.note;
          break;
        }
        const identity = enrichmentFrom(res.data, { splitMinTxns: config.splitMinTxns });
        if (identity) {
          this.table.insert(address, traction, identity);
          added++;
        }
        // Dropped from the queue either way. A pool whose detail call returns
        // nothing usable would otherwise be retried every cycle forever.
        this.pending.delete(address);
      }

      // --- 4. age out ---------------------------------------------------
      const cutoff = startedAt - config.windowMinutes * 60 * 1000;
      for (const [address, traction] of this.pending) {
        const t = Date.parse(traction.created_at);
        if (!Number.isFinite(t) || t < cutoff) this.pending.delete(address);
      }
      this.table.prune(startedAt);
      await this.table.save();
      this.stats.ready = true;
    } finally {
      // Anything spent above the standing per-poll cap came from the
      // cold-start pool, which is never replenished.
      this.coldStartRemaining = Math.max(0, this.coldStartRemaining - Math.max(0, spent() - config.maxCallsPerPoll));
      await this.ledger.flush().catch(() => {});
      this.stats.last_poll_at = new Date(startedAt).toISOString();
      this.stats.last_poll_ok = note === NOTE.OK;
      this.stats.upstream_note = note;
      this.stats.polls++;
      this.stats.calls_last_poll = spent();
      this.stats.window_truncated = truncated;
      this.stats.refreshed_last_poll = refreshed;
      this.stats.added_last_poll = added;
      this.running = false;
      console.log(
        JSON.stringify({
          msg: "poll",
          calls: spent(),
          refreshed,
          added,
          rows: this.table.size,
          pending: this.pending.size,
          truncated,
          note,
          cold_start_left: this.coldStartRemaining,
          credits_left: this.ledger.remaining,
        })
      );
    }
  }
}
