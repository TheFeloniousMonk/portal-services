// DexPaprika client with a hard credit governor (pattern from Meme Watch 1.0.2).
//
// The ledger counts credits per hour in the store and sums the last 30 days,
// which is how DexPaprika counts a free or keyless allowance. A calendar-month
// reset would let a busy end of one month and start of the next overlap
// inside a single rolling window and overspend it.
//
// List endpoints cost one credit per request whatever the row count, so ingest
// reads pages, never per-token details.

import { config, PRO_HOST, PUBLIC_HOST } from "./config.js";

// Upstream conditions as a closed vocabulary. Raw upstream text never reaches
// a response: gateways penalise some words in a body.
export const NOTE = Object.freeze({
  OK: "",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXHAUSTED: "quota_exhausted",
  BUDGET_EXHAUSTED: "budget_exhausted",
  FALLBACK_CAP: "fallback_cap",
  UNREACHABLE: "unreachable",
  BAD_RESPONSE: "bad_response",
  HTTP_ERROR: "http_error",
  NOT_FOUND: "not_found",
  AUTH_REJECTED: "auth_rejected",
  WRONG_HOST: "wrong_host",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600000;

export class DexPaprika {
  constructor(store, options = {}) {
    this.store = store;
    this.apiKey = options.apiKey ?? config.dexpaprikaKey;
    this.baseUrl = options.baseUrl ?? config.dexpaprikaBase;
    this.spacingMs = options.spacingMs ?? config.dexpaprikaSpacingMs;
    this.limit = options.monthlyCredits ?? config.monthlyCredits;
    this.fallbackPerHour = options.fallbackPerHour ?? config.fallbackCreditsPerHour;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.lastCallAt = 0;
    this.queue = Promise.resolve();
    this.plan = "unknown";
    this.pausedUntil = 0;
    this.authProblem = null;
    this.fallbackSpent = { hour: -1, n: 0 };
    this.logged = new Set();
    this.stats = { calls: 0, failures: 0, last_note: null };
  }

  logOnce(key, payload) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.error(JSON.stringify(payload));
  }

  get remaining() {
    return Math.max(0, this.limit - this.store.creditsSpent());
  }

  // On-demand lookups for tokens not in the store draw on a small hourly cap so
  // request traffic can never eat the ingest budget.
  takeFallbackCredit(now = Date.now()) {
    const hour = Math.floor(now / HOUR);
    if (this.fallbackSpent.hour !== hour) this.fallbackSpent = { hour, n: 0 };
    if (this.fallbackSpent.n >= this.fallbackPerHour) return false;
    this.fallbackSpent.n++;
    return true;
  }

  // One upstream GET, serialized and spaced under the per-minute limit.
  // Returns {ok, data, note}. Never throws.
  get(path, params = {}, { fallback = false } = {}) {
    const run = this.queue.then(() => this.#get(path, params, fallback));
    this.queue = run.catch(() => {});
    return run;
  }

  async #get(path, params, fallback) {
    if (Date.now() < this.pausedUntil) return { ok: false, data: null, note: NOTE.RATE_LIMITED };
    if (this.remaining <= 0) return { ok: false, data: null, note: NOTE.BUDGET_EXHAUSTED };
    if (fallback && !this.takeFallbackCredit()) return { ok: false, data: null, note: NOTE.FALLBACK_CAP };

    const gap = Date.now() - this.lastCallAt;
    if (gap < this.spacingMs) await sleep(this.spacingMs - gap);

    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    const headers = { Accept: "application/json", "User-Agent": `${config.service}/${config.version}` };
    // The key is the whole Authorization value, with no scheme word.
    if (this.apiKey) headers.Authorization = this.apiKey;

    this.lastCallAt = Date.now();
    this.store.spendCredits(1);
    this.stats.calls++;

    let res;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(config.dexpaprikaDeadlineMs) });
    } catch {
      return this.#fail(NOTE.UNREACHABLE);
    }
    const plan = res.headers.get("x-api-plan");
    if (plan) this.plan = plan;

    if (res.status === 429) {
      this.pausedUntil = Date.now() + (Number(res.headers.get("retry-after")) || 30) * 1000;
      return this.#fail(NOTE.RATE_LIMITED);
    }
    if (res.status === 402) {
      this.pausedUntil = Date.now() + 6 * HOUR;
      return this.#fail(NOTE.QUOTA_EXHAUSTED);
    }
    if (res.status === 404) return { ok: false, data: null, note: NOTE.NOT_FOUND };
    if (res.status === 401 || res.status === 403) return this.#refused(res);
    if (!res.ok) return this.#fail(NOTE.HTTP_ERROR);
    try {
      return { ok: true, data: await res.json(), note: NOTE.OK };
    } catch {
      return this.#fail(NOTE.BAD_RESPONSE);
    }
  }

  #fail(note) {
    this.stats.failures++;
    this.stats.last_note = note;
    return { ok: false, data: null, note };
  }

  async #refused(res) {
    let body = null;
    if (/json/i.test(res.headers.get("content-type") || "")) {
      try {
        body = await res.json();
      } catch {
        // an unreadable refusal
      }
    }
    if (res.status === 403 && body && body.error === "wrong_host") {
      if (this.baseUrl === PRO_HOST) {
        this.baseUrl = PUBLIC_HOST;
        this.logOnce("wrong_host", {
          msg: "the key is not a paid-plan key; api-pro refused it, so this process now uses the public host. Set PUMP_DEXPAPRIKA_PLAN=free to start there.",
        });
      }
      this.authProblem = NOTE.WRONG_HOST;
      return this.#fail(NOTE.WRONG_HOST);
    }
    this.authProblem = NOTE.AUTH_REJECTED;
    this.logOnce("auth_" + res.status, {
      msg: "DexPaprika refused the request. It takes the key as the whole Authorization header value.",
      status: res.status,
      key_sent: Boolean(this.apiKey),
      upstream_code: body && (body.error || null),
    });
    return this.#fail(NOTE.AUTH_REJECTED);
  }

  status() {
    return {
      plan_configured: config.plan,
      plan_reported: this.plan,
      credits_used_30d: this.store.creditsSpent(),
      credits_limit_30d: this.limit,
      credits_remaining_30d: this.remaining,
      fallback_credits_per_hour: this.fallbackPerHour,
      paused: Date.now() < this.pausedUntil,
      auth_problem: this.authProblem,
      calls: this.stats.calls,
      failures: this.stats.failures,
      last_note: this.stats.last_note,
    };
  }
}

// Newest pools on a chain, one page (one credit).
export function newestPools(client, chain, cursor) {
  return client.get(`/networks/${chain}/pools/search`, { order_by: "created_at", sort: "desc", limit: 100, cursor });
}

// Every pool a token trades in, busiest first. Used on demand for a token the
// store has never seen.
export function poolsOfToken(client, chain, token) {
  return client.get(`/networks/${chain}/pools/search`, { token_address: token, order_by: "volume_usd_24h", sort: "desc", limit: 20 }, { fallback: true });
}
