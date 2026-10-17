// Pulling from peers. Each tick, from each peer in good standing, in turn:
//   tokens     tokens it has precomputed that this node lacks; each joins the
//              precompute queue at heat 0, with the pools the chain confirms
//   creations  creation block and deployer per EVM token, checked in a few
//              reads instead of a binary search; enrichment then reruns
//   holders    for tokens this node is still backfilling far behind, the
//              peer's live balances at its cursor, checked against the supply
//              and balanceOf at that block, then adopted by the holder index
// Never pulled: anything that can flip (owner, proxy, honeypot, LP, market),
// the DexPaprika ledger, heat, and sniper analysis (its check is the analysis).
//
// Cursors are kept per peer in the store's meta table. A definite mismatch
// costs the peer penalty points; a failed read on this side costs nothing.

import { signPeer } from "./peers.js";
import { REPLY_LIMITS, readJson } from "./read.js";
import { shortId } from "./crypto.js";
import { verifyPool, verifyCreation, verifySnapshot } from "./verify.js";
import { CHAINS } from "../config.js";
import { validAddress } from "../checker.js";

const RETRY_SNAPSHOT_MS = 30 * 60000;

export class PeerSync {
  constructor({ store, evm, holderIndex, peers, node, config, fetch = globalThis.fetch, log = console }) {
    this.store = store;
    this.evm = evm;
    this.holderIndex = holderIndex;
    this.peers = peers;
    this.node = node;
    this.config = config;
    this.fetch = fetch;
    this.log = log;
    this.timer = null;
    this.running = null;
    this.asked = new Map(); // "peer chain:token" -> time a snapshot was last asked for
    this.stats = { ticks: 0, tokens: 0, pools: 0, creations: 0, snapshots: 0, rejected: 0, last_error: null, last_ok_at: null };
  }

  start() {
    const tick = () => this.runOnce();
    // The first pull waits for discovery to find someone.
    const first = setTimeout(tick, 30000);
    first.unref?.();
    this.timer = setInterval(tick, this.config.peerSyncIntervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  runOnce() {
    if (this.running) return this.running;
    this.running = this.tick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async tick() {
    this.stats.ticks++;
    for (const peer of this.peers.active()) {
      try {
        await this.pullTokens(peer);
        await this.pullCreations(peer);
        await this.pullSnapshots(peer);
        this.peers.noteOk(peer.id);
        this.stats.last_ok_at = new Date().toISOString();
      } catch (e) {
        this.peers.noteFail(peer.id, e);
        this.stats.last_error = shortId(peer.id) + ": " + ((e && (e.kind || e.code || e.message)) || "error");
      }
    }
  }

  async post(peer, path, fields) {
    const res = await this.fetch(peer.url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signPeer(this.node, fields)),
      signal: AbortSignal.timeout(this.config.peerTimeoutMs),
    });
    let body;
    try {
      body = await readJson(res, REPLY_LIMITS.peer);
    } catch (e) {
      if (e && e.limit) this.peers.penalize(peer.id, 5, "reply_too_large");
      throw e;
    }
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status} ${(body && body.error && body.error.code) || ""}`.trim()), { code: "peer_" + res.status });
    if (!body || typeof body !== "object") throw new Error(`${path}: not an object`);
    return body;
  }

  cursor(peer, feed) {
    return this.store.meta(`peer:${peer.id}:${feed}`) || { ts: 0, key: "" };
  }

  setCursor(peer, feed, next) {
    if (next && Number.isSafeInteger(next.ts) && typeof next.key === "string") this.store.setMeta(`peer:${peer.id}:${feed}`, { ts: next.ts, key: next.key });
  }

  blame(peer, points, why) {
    this.stats.rejected++;
    this.peers.penalize(peer.id, points, why);
  }

  async pullTokens(peer) {
    const reply = await this.post(peer, "/v1/tokens", { after: this.cursor(peer, "tokens"), limit: this.config.peerTokensPerPull });
    if (!Array.isArray(reply.tokens)) throw new Error("/v1/tokens: no tokens list");
    for (const t of reply.tokens) {
      const chain = t && String(t.chain);
      if (!CHAINS.includes(chain) || !validAddress(chain, t.address) || (chain !== "solana" && t.address !== t.address.toLowerCase())) {
        this.blame(peer, 1, "token malformed");
        continue;
      }
      if (this.store.token(chain, t.address)) continue;
      const pools = [];
      for (const p of (Array.isArray(t.pools) ? t.pools : []).slice(0, 4)) {
        if (chain === "solana") break;
        try {
          const v = await verifyPool(this.evm[chain], t.address, p);
          if (v.pool) pools.push(v.pool);
          else this.blame(peer, 1, "pool: " + v.reject);
        } catch {
          // A read failed here: the pool is left to this node's own ingest.
        }
      }
      this.store.seeToken(chain, t.address, { heat: 0 });
      for (const p of pools) this.store.upsertPool(chain, p);
      this.stats.tokens++;
      this.stats.pools += pools.length;
    }
    this.setCursor(peer, "tokens", reply.next);
  }

  async pullCreations(peer) {
    const reply = await this.post(peer, "/v1/creations", { after: this.cursor(peer, "creations"), limit: this.config.peerTokensPerPull });
    if (!Array.isArray(reply.creations)) throw new Error("/v1/creations: no creations list");
    for (const c of reply.creations) {
      const chain = c && String(c.chain);
      if (!this.evm[chain] || !validAddress(chain, c.token) || c.token !== c.token.toLowerCase()) {
        this.blame(peer, 1, "creation malformed");
        continue;
      }
      if (!this.store.token(chain, c.token) || this.store.checks(chain, c.token)._creation) continue;
      let v;
      try {
        v = await verifyCreation(this.evm[chain], c.token, c.creation);
      } catch {
        continue;
      }
      if (v.reject) {
        this.blame(peer, 2, "creation: " + v.reject);
        continue;
      }
      this.store.putCheck(chain, c.token, "_creation", v.creation);
      this.store.reEnrich(chain, c.token);
      this.stats.creations++;
    }
    this.setCursor(peer, "creations", reply.next);
  }

  async pullSnapshots(peer) {
    if (!this.holderIndex) return;
    const now = Date.now();
    for (const chain of this.holderIndex.chains) {
      const cursor = this.store.indexCursor(chain);
      if (cursor === null) continue;
      const far = this.store
        .indexTokens(chain, "backfill")
        .filter((r) => cursor - r.indexed_to >= this.config.peerSnapshotMinBlocks && now - (this.asked.get(peer.id + " " + chain + ":" + r.token) || 0) >= RETRY_SNAPSHOT_MS)
        .slice(0, this.config.peerSnapshotsPerTick);
      for (const row of far) {
        this.asked.set(peer.id + " " + chain + ":" + row.token, now);
        const reply = await this.post(peer, "/v1/holders", { chain, token: row.token });
        if (reply.available === false) continue;
        let v;
        try {
          v = await verifySnapshot(this.evm[chain], row.token, reply.block, reply.holders, { max: this.config.peerMaxHolders });
        } catch {
          continue;
        }
        if (v.reject) {
          this.blame(peer, 5, "snapshot: " + v.reject);
          continue;
        }
        if (v.skip) continue;
        // The peer's cursor is usually a few blocks ahead of this node's, and
        // a tick may be running: wait for both, up to a minute.
        let why = this.holderIndex.adopt(chain, row.token, reply.block, v.holders);
        for (let i = 0; i < 12 && (why === "busy" || why === "ahead_of_cursor"); i++) {
          await new Promise((r) => setTimeout(r, this.config.peerAdoptWaitMs));
          why = this.holderIndex.adopt(chain, row.token, reply.block, v.holders);
        }
        if (why) continue;
        this.stats.snapshots++;
        this.log.log?.(JSON.stringify({ msg: "holder snapshot adopted", chain, token: row.token, block: reply.block, holders: v.holders.length, peer: shortId(peer.id) }));
      }
    }
    if (this.asked.size > 20000) this.asked.clear();
  }

  status() {
    return this.stats;
  }
}
