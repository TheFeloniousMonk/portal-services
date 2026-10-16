// The precompute worker: drains the store's queue, hottest token first, a few
// at a time. It reads through Pocket only. When Pocket fails, the token waits
// and is retried later; ingest volume never spills onto the backup endpoints.

export class Worker {
  constructor({ store, checker, config }) {
    this.store = store;
    this.checker = checker;
    this.config = config;
    this.active = 0;
    this.retryAt = new Map(); // "chain:address" -> time
    this.timer = null;
    this.stopped = false;
    this.stats = { done: 0, not_found: 0, failed: 0, last_error: null, last_done_at: null };
  }

  start() {
    this.stopped = false;
    this.kick();
    this.timer = setInterval(() => this.kick(), 5000);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }

  kick() {
    if (this.stopped) return;
    const free = this.config.precomputeConcurrency - this.active;
    if (free <= 0) return;
    const now = Date.now();
    const busy = this.inFlight || (this.inFlight = new Set());
    const picks = this.store
      .pending(free * 4 + busy.size)
      .filter((t) => !busy.has(t.chain + ":" + t.address) && (this.retryAt.get(t.chain + ":" + t.address) || 0) <= now)
      .slice(0, free);
    for (const t of picks) this.run(t.chain, t.address);
  }

  async run(chain, address) {
    const key = chain + ":" + address;
    this.active++;
    this.inFlight.add(key);
    try {
      const out = await this.checker.precompute(chain, address, { failover: false });
      this.store.markPrecomputed(chain, address);
      this.retryAt.delete(key);
      if (out && out.found === false) this.stats.not_found++;
      else this.stats.done++;
      this.stats.last_done_at = new Date().toISOString();
    } catch (e) {
      this.stats.failed++;
      this.stats.last_error = (e && (e.kind || e.code || e.message)) || "error";
      this.retryAt.set(key, Date.now() + this.config.precomputeRetryMs);
      // Keep the retry map bounded; the store remains the queue of record.
      if (this.retryAt.size > 20000) this.retryAt.clear();
    } finally {
      this.active--;
      this.inFlight.delete(key);
      if (!this.stopped) setImmediate(() => this.kick());
    }
  }

  status() {
    return { concurrency: this.config.precomputeConcurrency, active: this.active, pending: this.store.pendingCount(), ...this.stats };
  }
}
