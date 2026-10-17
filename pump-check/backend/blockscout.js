// Blockscout PRO API: token holders and the token's creator, for Base and
// Robinhood Chain. One key covers every chain (chain id in the path). The
// explorers themselves answer server requests with a Cloudflare challenge, so
// only this API is usable from a supplier.
//
// Without PUMP_BLOCKSCOUT_API_KEY the holder and deployer checks are
// "not_available" on that supplier, never "unknown", so a missing key cannot
// turn a verdict unknown. The same holds for a chain the key's plan does not
// cover: since 2026-10-01 the free plan excludes Base (a 402 naming the plans
// that include it), so on a free key Base reads not_available.
//
// Measured on 2026-10-17 from the x-credits-remaining header: a holder list
// costs 20 credits and an address lookup costs none, against 100,000 a day
// on the free plan. Calls stop when fewer than PUMP_BLOCKSCOUT_RESERVE remain.

import { config } from "./config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Blockscout {
  constructor(options = {}) {
    this.key = options.key ?? config.blockscoutKey;
    this.base = options.base ?? config.blockscoutBase;
    this.spacingMs = options.spacingMs ?? config.blockscoutSpacingMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.queue = Promise.resolve();
    this.lastCallAt = 0;
    this.reserve = options.reserve ?? config.blockscoutReserve;
    this.creditsRemaining = null;
    this.creditsAt = 0;
    this.planExcludes = new Map(); // chainId -> the plans Blockscout says the chain needs
    this.stats = { calls: 0, failures: 0, last_error: null, last_ok_at: null };
  }

  // Why this supplier cannot read a chain, or null.
  unavailable(chainId) {
    if (!this.key) return "this supplier has no Blockscout key";
    if (this.planExcludes.has(chainId)) return "this supplier's Blockscout plan does not cover this chain (" + this.planExcludes.get(chainId) + ")";
    return null;
  }

  // Daily credits are nearly spent: wait for the next day's allowance.
  get exhausted() {
    return this.creditsRemaining !== null && this.creditsRemaining < this.reserve && Date.now() - this.creditsAt < 3600000;
  }

  get enabled() {
    return Boolean(this.key);
  }

  // GET /{chainId}/api/v2/{path}. Returns parsed JSON, or null on any failure.
  get(chainId, path, params = {}) {
    const run = this.queue.then(() => this.#get(chainId, path, params));
    this.queue = run.catch(() => {});
    return run;
  }

  async #get(chainId, path, params) {
    if (!this.key || this.planExcludes.has(chainId) || this.exhausted) return null;
    const gap = Date.now() - this.lastCallAt;
    if (gap < this.spacingMs) await sleep(this.spacingMs - gap);
    this.lastCallAt = Date.now();
    this.stats.calls++;
    const url = new URL(`/${chainId}/api/v2/${path}`, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    url.searchParams.set("apikey", this.key);
    try {
      const res = await this.fetchImpl(url, {
        headers: { Accept: "application/json", "User-Agent": `${config.service}/${config.version}` },
        signal: AbortSignal.timeout(config.blockscoutDeadlineMs),
      });
      const left = Number(res.headers.get("x-credits-remaining"));
      if (Number.isFinite(left) && res.headers.get("x-credits-remaining") !== null) {
        this.creditsRemaining = left;
        this.creditsAt = Date.now();
      }
      if (res.status === 402) {
        // "Featured chain 8453 requires one of the following plans: ..." is a
        // standing answer for this key, not a transient fault.
        let msg = "";
        try {
          msg = String((await res.json()).error || "");
        } catch {
          // no body
        }
        const m = /requires one of the following plans:\s*([A-Za-z ,]+)/i.exec(msg);
        if (m) this.planExcludes.set(chainId, m[1].trim() + " plan");
        this.stats.failures++;
        this.stats.last_error = m ? "plan_excludes_chain_" + chainId : "http_402";
        return null;
      }
      if (!res.ok) {
        this.stats.failures++;
        this.stats.last_error = "http_" + res.status;
        return null;
      }
      const body = await res.json();
      this.stats.last_ok_at = new Date().toISOString();
      return body;
    } catch (e) {
      this.stats.failures++;
      this.stats.last_error = e && e.name === "TimeoutError" ? "deadline" : "network";
      return null;
    }
  }

  // The first page of holders, largest first: [{address, value, isContract}].
  async holders(chainId, token) {
    const body = await this.get(chainId, `tokens/${token}/holders`);
    if (!body || !Array.isArray(body.items)) return null;
    return body.items
      .map((h) => ({
        address: String((h.address && h.address.hash) || "").toLowerCase(),
        isContract: Boolean(h.address && h.address.is_contract),
        name: (h.address && h.address.name) || null,
        value: BigInt(h.value || 0),
      }))
      .filter((h) => h.address);
  }

  // The token contract's creator and creation transaction.
  async creator(chainId, token) {
    const body = await this.get(chainId, `addresses/${token}`);
    if (!body) return null;
    const creator = body.creator_address_hash || null;
    return {
      creator: creator ? creator.toLowerCase() : null,
      creationTx: body.creation_transaction_hash || body.creation_tx_hash || null,
    };
  }

  status() {
    return {
      enabled: this.enabled,
      credits_remaining_today: this.creditsRemaining,
      reserve: this.reserve,
      chains_not_in_plan: Object.fromEntries(this.planExcludes),
      ...this.stats,
    };
  }
}
