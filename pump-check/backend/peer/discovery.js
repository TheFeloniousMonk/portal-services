// Peer discovery from the chain (after Meadow's discovery.js). The suppliers
// staked for pump-check publish their endpoint URLs on chain. Each supplier's
// node answers at <endpoint origin>/pump-check-peer, where the supplier's
// Caddy routes that path to the node's peer port. Asking that URL who is
// there (/v1/hello) yields the node key; TLS on the supplier's own staked
// hostname vouches for it, so only nodes behind staked suppliers become peers.
//
// A hostname is asked again when it is new, when it did not answer last time,
// and otherwise once a day.

import { REPLY_LIMITS, readJson } from "./read.js";
import { shortId } from "./crypto.js";

export const PEER_PATH = "/pump-check-peer";
export const EARLY_MIN_MS = 5 * 60000;
export const HELLO_RECHECK_MS = 24 * 3600000;

export class Discovery {
  // opts.listSuppliers(network) -> { suppliers: [{ operator, urls }], fallback? }
  constructor(node, peers, opts) {
    this.node = node;
    this.peers = peers;
    this.opts = { networks: ["main", "beta"], peerPath: PEER_PATH, intervalMs: 30 * 60000, timeoutMs: 10000, fetch: globalThis.fetch, log: console, ...opts };
    this.timer = null;
    this.running = null;
    this.earlyAt = 0;
    this.hellos = new Map(); // origin -> { node, ok, at }
    this.status = { last_run: null, suppliers: null, found: null, last_error: null };
  }

  start() {
    if (!this.opts.networks.length) return this;
    this.runOnce();
    if (this.opts.intervalMs > 0) {
      this.timer = setInterval(() => this.runOnce(), this.opts.intervalMs);
      this.timer.unref?.();
    }
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  runOnce() {
    if (this.running) return this.running;
    this.running = this.run()
      .catch((err) => {
        this.status.last_error = err.message;
        this.opts.log.warn?.(JSON.stringify({ msg: "peer discovery failed", error: err.message }));
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  // A correctly signed request from a node this one does not know: look at the
  // chain now, at most once every 5 minutes. A signature alone never makes a peer.
  nudge(nodeId, now = Date.now()) {
    if (!this.opts.networks.length || this.running || now - this.earlyAt < EARLY_MIN_MS) return false;
    this.earlyAt = now;
    this.opts.log.log?.(JSON.stringify({ msg: "peer discovery early", from: shortId(nodeId) }));
    this.runOnce();
    return true;
  }

  async hello(origin, now) {
    let entry = { node: null, ok: false, at: now };
    try {
      const res = await this.opts.fetch(origin + this.opts.peerPath + "/v1/hello", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      const hello = await readJson(res, REPLY_LIMITS.hello);
      if (res.ok && hello && hello.service === "pump-check" && typeof hello.node === "string") entry = { node: hello.node, ok: true, at: now };
    } catch {
      // No PumpCheck node there, or not reachable.
    }
    this.hellos.set(origin, entry);
  }

  // One pass: returns the peers found. Chain-found peers no longer listed, or
  // whose hostname stopped answering, are dropped; configured ones stay.
  async run() {
    const now = Date.now();
    const origins = new Set();
    let suppliers = 0;
    let listed = 0;
    for (const network of this.opts.networks) {
      let r;
      try {
        r = await this.opts.listSuppliers(network);
      } catch (err) {
        this.opts.log.warn?.(JSON.stringify({ msg: "peer discovery: supplier listing failed", network, error: err.message }));
        continue;
      }
      listed++;
      if (r.fallback) this.opts.log.warn?.(JSON.stringify({ msg: "peer discovery: indexer unavailable, read the chain API", network, why: r.fallback }));
      suppliers += r.suppliers.length;
      for (const s of r.suppliers) {
        for (const u of s.urls) {
          try {
            const url = new URL(u);
            if (url.protocol === "https:" || url.protocol === "http:") origins.add(url.origin);
          } catch {
            // not a URL
          }
        }
      }
    }
    // With no listing at all, keep the peers there are rather than drop them all.
    if (!listed) throw new Error("no network's suppliers could be listed");
    for (const o of this.hellos.keys()) if (!origins.has(o)) this.hellos.delete(o);
    const due = [...origins].filter((o) => {
      const h = this.hellos.get(o);
      return !h || !h.ok || now - h.at >= HELLO_RECHECK_MS;
    });
    for (let i = 0; i < due.length; i += 8) await Promise.all(due.slice(i, i + 8).map((o) => this.hello(o, now)));

    // One node may answer on several hostnames (a server staked on both networks).
    const found = new Map();
    for (const o of [...origins].sort()) {
      const h = this.hellos.get(o);
      if (h && h.ok && h.node !== this.node.id && !found.has(h.node)) found.set(h.node, o + this.opts.peerPath);
    }
    for (const [id, url] of found) {
      const known = this.peers.get(id);
      if (!known || known.url !== url) this.opts.log.log?.(JSON.stringify({ msg: "peer found", peer: shortId(id), url }));
      this.peers.add({ id, url, source: "chain" });
    }
    // A network whose listing failed this run may hold peers not seen: drop none then.
    for (const p of listed === this.opts.networks.length ? this.peers.all() : []) {
      if (p.source === "chain" && !found.has(p.id)) {
        this.opts.log.log?.(JSON.stringify({ msg: "peer dropped", peer: shortId(p.id), url: p.url }));
        this.peers.remove(p.id);
      }
    }
    this.status = { last_run: new Date(now).toISOString(), suppliers, found: found.size, last_error: null };
    return [...found].map(([id, url]) => ({ id, url }));
  }
}
