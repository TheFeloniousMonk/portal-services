// The infiniFi protocol API client: one GET per upstream path, a deadline on
// every call, and a short shared cache for protocol-wide reads.
//
// Every upstream body is {"code": "OK", "data": ...} on success and
// {"code": "ERR_..."} otherwise. Two failure kinds leave this module:
//   rejected     upstream answered 4xx: the caller's input was wrong (bad
//                address, epoch out of range). The relay is answered with a 4xx.
//   unavailable  network error, deadline, 5xx, or a body that is not the
//                expected envelope. The relay fails unless a stale copy exists.

export class UpstreamError extends Error {
  constructor(kind, message, { status = 0, code = null } = {}) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.upstreamCode = code;
  }
}

export class Upstream {
  constructor({ base, deadlineMs, staleMaxMs, epochTtlMs, userAgent, fetchImpl = globalThis.fetch, now = Date.now }) {
    this.base = base;
    this.deadlineMs = deadlineMs;
    this.staleMaxMs = staleMaxMs;
    this.epochTtlMs = epochTtlMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.cache = new Map(); // path -> {data, fetchedAt}
    this.inflight = new Map(); // path -> Promise
    this.epoch = null; // {value, fetchedAt}
    this.stats = { calls: 0, failures: 0, last_ok_at: null, last_error: null };
  }

  // One raw upstream call. Resolves {status, body} or throws unavailable.
  async request(path) {
    this.stats.calls++;
    let res;
    let text;
    try {
      res = await this.fetchImpl(this.base + path, {
        headers: { Accept: "application/json", "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(this.deadlineMs),
      });
      text = await res.text();
    } catch (e) {
      this.stats.failures++;
      const why = e && e.name === "TimeoutError" ? "no answer within " + this.deadlineMs + " ms" : "network error";
      this.stats.last_error = why;
      throw new UpstreamError("unavailable", "infiniFi API: " + why);
    }
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Cloudflare's challenge page and Express's 404 page are both HTML.
    }
    return { status: res.status, body };
  }

  // GET a path and return {data, fetchedAt, stale}. ttlMs > 0 caches the
  // result and shares one in-flight request among concurrent callers.
  async get(path, ttlMs = 0) {
    const t = this.now();
    const hit = this.cache.get(path);
    if (ttlMs > 0 && hit && t - hit.fetchedAt < ttlMs) return { ...hit, stale: false };
    if (ttlMs > 0 && this.inflight.has(path)) return this.inflight.get(path);

    const p = this.fetchFresh(path, ttlMs).catch((err) => {
      // Serve a recent copy rather than fail the relay when upstream is down.
      if (err.kind === "unavailable" && hit && t - hit.fetchedAt < this.staleMaxMs) {
        return { ...hit, stale: true };
      }
      throw err;
    });
    if (ttlMs > 0) {
      this.inflight.set(path, p);
      p.finally(() => this.inflight.delete(path)).catch(() => {});
    }
    return p;
  }

  async fetchFresh(path, ttlMs) {
    const { status, body } = await this.request(path);
    const code = body && typeof body === "object" ? body.code : null;
    if (status >= 400 && status < 500 && code) {
      throw new UpstreamError("rejected", upstreamMessage(body) || "infiniFi API rejected the request", { status, code });
    }
    if (status !== 200 || code !== "OK" || !("data" in body)) {
      this.stats.failures++;
      this.stats.last_error = "unexpected answer (HTTP " + status + ")";
      throw new UpstreamError("unavailable", "infiniFi API returned an unexpected answer (HTTP " + status + ")", { status, code });
    }
    const entry = { data: body.data, fetchedAt: this.now() };
    this.stats.last_ok_at = new Date(entry.fetchedAt).toISOString();
    if (ttlMs > 0) this.cache.set(path, entry);
    return { ...entry, stale: false };
  }

  // infiniFi has no endpoint that names the current allocation-voting epoch.
  // The votes endpoint accepts only the current epoch and its neighbours, and
  // its out-of-range error states the current one, so ask for an epoch far in
  // the future and read the number from the message.
  async currentEpoch() {
    const t = this.now();
    if (this.epoch && t - this.epoch.fetchedAt < this.epochTtlMs) return this.epoch.value;
    let found = null;
    try {
      const { body } = await this.request("/protocol/votes/999999999");
      const m = /current epoch:\s*(\d+)/i.exec(upstreamMessage(body) || "");
      if (m) found = Number(m[1]);
    } catch (e) {
      if (!this.epoch) throw e;
    }
    if (found === null) {
      if (this.epoch) return this.epoch.value;
      throw new UpstreamError("unavailable", "infiniFi API did not report the current epoch");
    }
    this.epoch = { value: found, fetchedAt: t };
    return found;
  }
}

function upstreamMessage(body) {
  if (!body || typeof body !== "object") return null;
  if (body.data && typeof body.data === "object" && typeof body.data.message === "string") return body.data.message;
  if (typeof body.message === "string") return body.message;
  return null;
}
