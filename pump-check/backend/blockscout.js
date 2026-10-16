// Blockscout PRO API: token holders and the token's creator, for Base and
// Robinhood Chain. One key covers every chain (chain id in the path). The
// explorers themselves answer server requests with a Cloudflare challenge, so
// only this API is usable from a supplier.
//
// Without PUMP_BLOCKSCOUT_API_KEY the holder and deployer checks are
// "not_available" on that supplier, never "unknown", so a missing key cannot
// turn a verdict unknown.

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
    this.stats = { calls: 0, failures: 0, last_error: null, last_ok_at: null };
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
    if (!this.key) return null;
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

  // How many token contracts an address has created (a deployer's history).
  // Blockscout counts contracts created by the address in its counters.
  async deployedCount(chainId, address) {
    const body = await this.get(chainId, `addresses/${address}/counters`);
    if (!body) return null;
    const n = Number(body.contracts_count ?? body.created_contracts_count ?? NaN);
    return Number.isFinite(n) ? n : null;
  }

  status() {
    return { enabled: this.enabled, ...this.stats };
  }
}
