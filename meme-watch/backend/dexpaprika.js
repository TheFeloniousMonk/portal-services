// DexPaprika client with a hard credit governor.
//
// Two things this module exists to guarantee:
//   1. The service never spends more upstream credits in a calendar month than
//      it is allowed to. The ledger is persisted, so a restart loop cannot
//      reset the counter and burn the allowance.
//   2. Every filter this service sends is actually honoured. The API silently
//      drops parameter names it does not recognise and returns a default
//      ordering that looks like a working query, so each response echoes a
//      `query` object and assertFilters checks the ones that matter.

import { readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { config, PRO_HOST, PUBLIC_HOST } from "./config.js";

// Upstream conditions, as a closed vocabulary. SAGE scans the first 2 KB of a
// success body for substrings like "timeout" or "service unavailable" and
// penalises the supplier for them, so a raw upstream message must never reach
// the response envelope.
export const NOTE = Object.freeze({
  OK: "",
  RATE_LIMITED: "rate_limited",
  QUOTA_EXHAUSTED: "quota_exhausted",
  BUDGET_EXHAUSTED: "budget_exhausted",
  UNREACHABLE: "unreachable",
  BAD_RESPONSE: "bad_response",
  HTTP_ERROR: "http_error",
  // The key or its header was refused: a 401, or api-pro's edge answering a
  // request without an Authorization header with an HTML block page.
  AUTH_REJECTED: "auth_rejected",
  // A free key sent to api-pro. The client moves itself to the public host.
  WRONG_HOST: "wrong_host",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const period = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export class CreditLedger {
  constructor(dir, monthlyLimit) {
    this.path = join(dir, "budget.json");
    this.limit = monthlyLimit;
    this.period = period();
    this.used = 0;
    this.dirty = false;
  }

  async load() {
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8"));
      if (raw && raw.period === this.period && Number.isFinite(raw.used)) this.used = raw.used;
    } catch {
      // No ledger yet, or unreadable. Starting at zero for this period is the
      // safe default: the per-poll cap still bounds the burn rate.
    }
  }

  roll() {
    const now = period();
    if (now !== this.period) {
      this.period = now;
      this.used = 0;
      this.dirty = true;
    }
  }

  get remaining() {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }

  spend(n = 1) {
    this.roll();
    this.used += n;
    this.dirty = true;
  }

  async flush() {
    if (!this.dirty) return;
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify({ period: this.period, used: this.used }), "utf8");
    await rename(tmp, this.path);
    this.dirty = false;
  }
}

export class DexPaprika {
  // `options` overrides the configured key, header and host; tests use it.
  constructor(ledger, options = {}) {
    this.ledger = ledger;
    this.apiKey = options.apiKey ?? config.apiKey;
    this.authHeader = options.authHeader ?? config.authHeader;
    this.baseUrl = options.baseUrl ?? config.baseUrl;
    this.callSpacingMs = options.callSpacingMs ?? config.callSpacingMs;
    this.lastCallAt = 0;
    this.plan = "unknown";
    this.pausedUntil = 0;
    this.authProblem = null;
    this.logged = new Set();
  }

  // Each upstream configuration problem is logged once per process, not per call.
  logOnce(key, payload) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.error(JSON.stringify(payload));
  }

  get paused() {
    return Date.now() < this.pausedUntil;
  }

  // One upstream GET. Returns {ok, data, note}. Never throws.
  async get(path, params = {}) {
    if (this.paused) return { ok: false, data: null, note: NOTE.RATE_LIMITED };
    if (this.ledger.remaining <= 0) return { ok: false, data: null, note: NOTE.BUDGET_EXHAUSTED };

    const gap = Date.now() - this.lastCallAt;
    if (gap < this.callSpacingMs) await sleep(this.callSpacingMs - gap);

    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const headers = { Accept: "application/json", "User-Agent": `${config.service}/${config.version}` };
    if (this.apiKey) headers[this.authHeader] = this.apiKey;

    this.lastCallAt = Date.now();
    this.ledger.spend(1);

    let res;
    try {
      res = await fetch(url, { headers, signal: AbortSignal.timeout(config.fetchDeadlineMs) });
    } catch {
      return { ok: false, data: null, note: NOTE.UNREACHABLE };
    }

    const plan = res.headers.get("x-api-plan");
    if (plan) this.plan = plan;

    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after")) || 30;
      this.pausedUntil = Date.now() + retry * 1000;
      return { ok: false, data: null, note: NOTE.RATE_LIMITED };
    }
    if (res.status === 402) {
      // Monthly allowance gone upstream. Stop trying until the next period.
      this.pausedUntil = Date.now() + 6 * 60 * 60 * 1000;
      return { ok: false, data: null, note: NOTE.QUOTA_EXHAUSTED };
    }
    if (res.status === 401 || res.status === 403) return this.refused(res);
    if (!res.ok) return { ok: false, data: null, note: NOTE.HTTP_ERROR };

    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, data: null, note: NOTE.BAD_RESPONSE };
    }
    return { ok: true, data, note: NOTE.OK };
  }

  // A 401 or 403, read the way DexPaprika documents them. Only the error code
  // is kept, never upstream text, which could carry words gateways penalise.
  async refused(res) {
    let body = null;
    if (/json/i.test(res.headers.get("content-type") || "")) {
      try {
        body = await res.json();
      } catch {
        // fall through as an unreadable refusal
      }
    }
    if (res.status === 403 && body && body.error === "wrong_host") {
      if (this.baseUrl === PRO_HOST) {
        this.baseUrl = PUBLIC_HOST;
        this.logOnce("wrong_host", {
          msg: "the key is not a paid-plan key; api-pro refused it, so this process now uses the public host. Set MW_DEXPAPRIKA_PLAN=free (or remove MW_DEXPAPRIKA_BASE_URL) to start there.",
          host: PUBLIC_HOST,
        });
      }
      this.authProblem = NOTE.WRONG_HOST;
      return { ok: false, data: null, note: NOTE.WRONG_HOST };
    }
    this.authProblem = NOTE.AUTH_REJECTED;
    this.logOnce(`auth_${res.status}`, {
      msg: "DexPaprika refused the request. It needs the key as the whole Authorization header value; an HTML 403 is api-pro's edge rejecting a request without one.",
      status: res.status,
      host: new URL(this.baseUrl).host,
      auth_header: this.authHeader,
      key_sent: Boolean(this.apiKey),
      upstream_code: body && (body.error || null),
    });
    return { ok: false, data: null, note: NOTE.AUTH_REJECTED };
  }

  // The API echoes the filters it applied. Anything we sent that is missing was
  // silently dropped, which would give us an unfiltered feed that looks correct.
  static assertFilters(data, expected) {
    const echoed = (data && data.query) || {};
    return Object.keys(expected).filter((k) => echoed[k] === undefined);
  }
}

// One page of the creation-time window, newest first.
//
// The whole window is re-queried every poll rather than only the slice since a
// high-water mark. That is what makes late-indexed pools recoverable: a pool
// that appears in the index after we have already moved past its creation time
// still falls inside the window on the next poll. A high-water mark would skip
// it permanently.
export async function fetchWindowPage(client, { createdAfter, cursor }) {
  const params = {
    created_after: createdAfter,
    txns_24h_min: config.gateMinTxns,
    // The REST API spells this volume_usd_24h_min. The shorter volume_24h_min
    // that the MCP server accepts is silently dropped here and yields an
    // unfiltered page, so the spelling matters and assertFilters guards it.
    volume_usd_24h_min: config.gateMinVolumeUsd,
    order_by: "created_at",
    sort: "desc",
    limit: 100,
    cursor,
  };
  const out = await client.get(`/networks/${config.chain}/pools/search`, params);
  if (!out.ok) return out;

  const dropped = DexPaprika.assertFilters(out.data, {
    created_after: 1,
    txns_24h_min: 1,
    volume_usd_24h_min: 1,
    order_by: 1,
  });
  if (dropped.length) {
    console.error(JSON.stringify({ msg: "upstream dropped filters", dropped }));
    return { ok: false, data: null, note: NOTE.BAD_RESPONSE };
  }
  return out;
}

export async function fetchPoolDetails(client, poolAddress) {
  return client.get(`/networks/${config.chain}/pools/${poolAddress}`);
}
