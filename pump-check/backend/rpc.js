// JSON-RPC with ordered failover (SPEC section 7).
//
// Each chain has a list of endpoints, Pocket's public gateway first. A call
// moves to the next endpoint on a network error, a deadline, HTTP 429 or 5xx,
// or a JSON-RPC error meaning "this endpoint will not do that". An error about
// the request itself (a revert, an unknown account) is the answer and is never
// retried elsewhere. Precompute calls pass {failover: false}: they wait for
// Pocket rather than push ingest volume onto the free backups.

export class RpcError extends Error {
  // kind: "unavailable" (no endpoint answered) or "rejected" (the request was refused)
  constructor(kind, message, { code = null, data = null, endpoint = null } = {}) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.data = data;
    this.endpoint = endpoint;
  }
}

// Messages that mean "not here, try elsewhere": unsupported methods, range or
// result-size limits, and node-side capacity errors.
const ENDPOINT_FAULT =
  /not (supported|available|allowed|found: method)|unsupported|method not found|does not exist|excluded from account secondary indexes|block range|range (is )?too (large|wide)|too many|exceed|limit|query returned more than|timeout|timed out|unavailable|busy|overloaded|missing trie node|header not found|state not available|pruned|internal error/i;
const ENDPOINT_FAULT_CODES = new Set([-32601, -32005, -32603, -32001, -32004, 429]);

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export class Endpoint {
  constructor({ url, maxLogRange }, opts) {
    this.url = url;
    this.host = hostOf(url);
    this.maxLogRange = maxLogRange;
    this.failures = 0;
    this.openUntil = 0;
    this.head = null; // latest block or slot this endpoint reported
    this.headAt = 0;
    this.stats = { calls: 0, failures: 0, last_error: null, last_ok_at: null };
    this.opts = opts;
  }

  get open() {
    return Date.now() < this.openUntil;
  }

  ok() {
    this.failures = 0;
    this.openUntil = 0;
    this.stats.last_ok_at = new Date().toISOString();
  }

  fail(why) {
    this.failures++;
    this.stats.failures++;
    this.stats.last_error = why;
    // After N consecutive failures the endpoint is skipped for a cooldown,
    // then tried again with one call.
    if (this.failures >= this.opts.breakerFailures) this.openUntil = Date.now() + this.opts.breakerCooldownMs;
  }

  status() {
    return {
      host: this.host,
      state: this.open ? "open" : this.failures ? "degraded" : "ok",
      consecutive_failures: this.failures,
      head: this.head,
      max_log_range: this.maxLogRange,
      calls: this.stats.calls,
      failures: this.stats.failures,
      last_error: this.stats.last_error,
      last_ok_at: this.stats.last_ok_at,
    };
  }
}

export class ChainRpc {
  // kind: "evm" or "solana". fetchImpl lets tests answer without a network.
  constructor(chain, kind, endpoints, opts, fetchImpl = globalThis.fetch) {
    this.chain = chain;
    this.kind = kind;
    this.opts = opts;
    this.fetchImpl = fetchImpl;
    this.endpoints = endpoints.map((e) => new Endpoint(e, opts));
    this.bestHead = null;
    this.headTtlMs = opts.headTtlMs ?? 15000;
  }

  get primary() {
    return this.endpoints[0];
  }

  maxLag() {
    return this.kind === "solana" ? this.opts.rpcMaxLagSlots : this.opts.rpcMaxLag;
  }

  // An endpoint whose head is well behind the best one seen is treated as down.
  stale(ep) {
    return ep.head !== null && this.bestHead !== null && this.bestHead - ep.head > this.maxLag();
  }

  async raw(ep, method, params) {
    ep.stats.calls++;
    let res;
    let text;
    try {
      res = await this.fetchImpl(ep.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(this.opts.rpcDeadlineMs),
      });
      text = await res.text();
    } catch (e) {
      return { fault: e && e.name === "TimeoutError" ? "deadline" : "network" };
    }
    if (res.status === 429) return { fault: "http_429" };
    if (res.status >= 500) return { fault: "http_" + res.status };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { fault: "bad_response" };
    }
    if (body && body.error) {
      const msg = String(body.error.message || "");
      if (ENDPOINT_FAULT_CODES.has(body.error.code) || ENDPOINT_FAULT.test(msg)) {
        // A revert can say "limit" or "exceed" in its own text; code 3 and
        // revert data mean the contract answered, so it is not an endpoint fault.
        if (!(body.error.code === 3 || /revert/i.test(msg))) return { fault: "rpc_" + body.error.code };
      }
      return { error: body.error };
    }
    if (!res.ok) return { fault: "http_" + res.status };
    if (!body || !("result" in body)) return { fault: "bad_response" };
    return { result: body.result };
  }

  // One call. Returns {result, endpoint}. Throws RpcError.
  async call(method, params = [], { failover = true, minHead = null } = {}) {
    const candidates = failover ? this.endpoints : [this.primary];
    let lastFault = "no endpoint";
    for (const ep of candidates) {
      if (failover && (ep.open || this.stale(ep)) && ep !== candidates[candidates.length - 1]) continue;
      if (minHead !== null && ep.head !== null && ep.head < minHead && failover && ep !== candidates[candidates.length - 1]) continue;
      const out = await this.raw(ep, method, params);
      if (out.fault) {
        ep.fail(out.fault);
        lastFault = ep.host + ": " + out.fault;
        continue;
      }
      ep.ok();
      if (out.error) {
        throw new RpcError("rejected", String(out.error.message || "rejected").slice(0, 300), {
          code: out.error.code ?? null,
          data: out.error.data ?? null,
          endpoint: ep.host,
        });
      }
      return { result: out.result, endpoint: ep.host };
    }
    throw new RpcError("unavailable", lastFault);
  }

  // Latest block (EVM) or slot (Solana) on one endpoint, cached briefly.
  async headOf(ep) {
    if (ep.head !== null && Date.now() - ep.headAt < this.headTtlMs) return ep.head;
    const method = this.kind === "solana" ? "getSlot" : "eth_blockNumber";
    const params = this.kind === "solana" ? [{ commitment: "confirmed" }] : [];
    const out = await this.raw(ep, method, params);
    if (out.fault || out.error) {
      if (out.fault) ep.fail(out.fault);
      return ep.head;
    }
    ep.ok();
    ep.head = typeof out.result === "string" ? Number(BigInt(out.result)) : Number(out.result);
    ep.headAt = Date.now();
    if (this.bestHead === null || ep.head > this.bestHead) this.bestHead = ep.head;
    return ep.head;
  }

  // Refresh every endpoint's head; used by the freshness guard and /healthz.
  async refreshHeads() {
    await Promise.all(this.endpoints.map((ep) => this.headOf(ep).catch(() => null)));
    return this.bestHead;
  }

  // The chain answers if any endpoint answered recently.
  get healthy() {
    return this.endpoints.some((ep) => !ep.open && ep.stats.last_ok_at && Date.now() - Date.parse(ep.stats.last_ok_at) < 5 * 60000);
  }

  status() {
    return { chain: this.chain, healthy: this.healthy, best_head: this.bestHead, endpoints: this.endpoints.map((e) => e.status()) };
  }
}

// ---- EVM conveniences ---------------------------------------------------------

export class EvmRpc extends ChainRpc {
  constructor(chain, endpoints, opts, fetchImpl) {
    super(chain, "evm", endpoints, opts, fetchImpl);
  }

  async blockNumber(opts) {
    const { result } = await this.call("eth_blockNumber", [], opts);
    return Number(BigInt(result));
  }

  // eth_call pinned to a block. Returns {result, endpoint, reverted, revertData}.
  async ethCall(tx, block = "latest", overrides = null, opts = {}) {
    const blockTag = typeof block === "number" ? "0x" + block.toString(16) : block;
    const params = overrides ? [tx, blockTag, overrides] : [tx, blockTag];
    try {
      const { result, endpoint } = await this.call("eth_call", params, opts);
      return { result, endpoint, reverted: false };
    } catch (e) {
      if (e instanceof RpcError && e.kind === "rejected") {
        return { result: null, endpoint: e.endpoint, reverted: true, revertData: e.data, message: e.message };
      }
      throw e;
    }
  }

  async getCode(address, block = "latest", opts) {
    const tag = typeof block === "number" ? "0x" + block.toString(16) : block;
    return this.call("eth_getCode", [address, tag], opts);
  }

  async getStorageAt(address, slot, block = "latest", opts) {
    const tag = typeof block === "number" ? "0x" + block.toString(16) : block;
    return this.call("eth_getStorageAt", [address, slot, tag], opts);
  }

  // eth_getLogs paged to each endpoint's allowed range (PUMP_LOG_PAGE_BLOCKS
  // by default, smaller where an endpoint declares less).
  async getLogs({ address, topics, fromBlock, toBlock }, opts = {}) {
    const logs = [];
    const page = Math.max(1, opts.pageBlocks || this.opts.logPageBlocks);
    let start = fromBlock;
    let endpoint = null;
    while (start <= toBlock) {
      const ep = opts.failover === false ? this.primary : this.endpoints.find((e) => !e.open && !this.stale(e)) || this.primary;
      const span = Math.min(page, ep.maxLogRange || page);
      const end = Math.min(toBlock, start + span - 1);
      const filter = { fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16), topics };
      if (address) filter.address = address;
      const out = await this.call("eth_getLogs", [filter], opts);
      endpoint = out.endpoint;
      logs.push(...out.result);
      start = end + 1;
    }
    return { result: logs, endpoint };
  }
}

// ---- Solana conveniences -------------------------------------------------------

export class SolanaRpc extends ChainRpc {
  constructor(endpoints, opts, fetchImpl) {
    super("solana", "solana", endpoints, opts, fetchImpl);
  }

  // One account; encoding "jsonParsed" or "base64". Returns {value, slot, endpoint}.
  async account(address, encoding = "base64", opts = {}) {
    const cfg = { encoding, commitment: "confirmed" };
    if (opts.minContextSlot) cfg.minContextSlot = opts.minContextSlot;
    const { result, endpoint } = await this.call("getAccountInfo", [address, cfg], opts);
    return { value: result.value, slot: result.context.slot, endpoint };
  }

  async accounts(addresses, encoding = "base64", opts = {}) {
    const cfg = { encoding, commitment: "confirmed" };
    if (opts.minContextSlot) cfg.minContextSlot = opts.minContextSlot;
    const { result, endpoint } = await this.call("getMultipleAccounts", [addresses, cfg], opts);
    return { values: result.value, slot: result.context.slot, endpoint };
  }
}
