// The peer set and request signing between nodes (after Meadow's peers.js).
//
// Peers are found from the chain (discovery.js); PUMP_PEERS adds more, for
// development. A node answers peer requests only from nodes in its set. A
// peer whose data fails verification is scored down and banned for a while:
// an hour, doubling with each further ban, at most a day.

import { b64u, canonicalize, fromB64u, nodeKey, shortId, signBytes, verifyBytes } from "./crypto.js";

export const AUTH_WINDOW_MS = 120000;
export const BAN_THRESHOLD = 20;
export const BAN_MS = 3600000;
export const BAN_MAX_MS = 24 * 3600000;

export class Peers {
  constructor(list = [], { log = console, now = Date.now } = {}) {
    this.map = new Map();
    this.log = log;
    this.now = now;
    for (const p of list) this.add(p);
  }

  // "n_…@https://host/pump-check-peer, n_…@http://127.0.0.1:8090"
  static parse(spec = "") {
    return String(spec)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf("@");
        const id = entry.slice(0, at);
        const url = entry.slice(at + 1).replace(/\/+$/, "");
        if (at < 0 || !nodeKey(id) || !/^https?:\/\//.test(url)) throw new Error(`bad peer "${entry}": expected n_<node key>@<url>`);
        return { id, url };
      });
  }

  // Adding a known peer updates its URL and keeps its score.
  add({ id, url, source = "config" }) {
    const known = this.map.get(id);
    if (known) Object.assign(known, { url, source });
    else this.map.set(id, { id, url, source, penalty: 0, banned: false, bannedUntil: null, bans: 0, lastPenalty: null, lastOk: null, lastError: null, failures: 0 });
  }

  remove(id) {
    this.map.delete(id);
  }

  refresh(p) {
    if (p && p.banned && this.now() >= p.bannedUntil) {
      Object.assign(p, { banned: false, bannedUntil: null, penalty: 0 });
      this.log.log?.(JSON.stringify({ msg: "peer ban expired", peer: shortId(p.id) }));
    }
    return p;
  }

  get(id) {
    return this.refresh(this.map.get(id)) || null;
  }

  all() {
    return [...this.map.values()].map((p) => this.refresh(p));
  }

  active() {
    return this.all().filter((p) => !p.banned);
  }

  penalize(id, points, reason) {
    const p = this.get(id);
    if (!p || p.banned) return;
    p.penalty += points;
    p.lastPenalty = { reason, at: this.now() };
    this.log.warn?.(JSON.stringify({ msg: "peer penalty", peer: shortId(id), points, reason, total: p.penalty }));
    if (p.penalty >= BAN_THRESHOLD) {
      p.bans++;
      const ms = Math.min(BAN_MS * 2 ** (p.bans - 1), BAN_MAX_MS);
      Object.assign(p, { banned: true, bannedUntil: this.now() + ms });
      this.log.warn?.(JSON.stringify({ msg: "peer banned", peer: shortId(id), minutes: Math.round(ms / 60000), last: reason }));
    }
  }

  noteOk(id) {
    const p = this.map.get(id);
    if (p) Object.assign(p, { lastOk: this.now(), failures: 0 });
  }

  noteFail(id, err) {
    const p = this.map.get(id);
    if (!p) return;
    p.failures++;
    p.lastError = { text: String((err && err.message) || err).slice(0, 200), at: this.now() };
  }

  status() {
    return this.all().map((p) => ({
      node: shortId(p.id),
      url: p.url,
      source: p.source,
      banned: p.banned,
      penalty: p.penalty,
      last_ok: p.lastOk ? new Date(p.lastOk).toISOString() : null,
      last_error: p.lastError ? p.lastError.text : null,
    }));
  }
}

// Body with auth {node, ts, sig}; sig signs JCS(body without auth.sig).
export function signPeer(node, fields, now = Date.now()) {
  const body = { ...fields, auth: { node: node.id, ts: now } };
  body.auth.sig = b64u(signBytes(node.privateKey, Buffer.from(canonicalize(body), "utf8")));
  return body;
}

// { node } or { error }. A valid signature from a node not in the set comes
// back as `signed`, so discovery can run early; the answer is still a refusal.
export function verifyPeer(body, peers, now = Date.now()) {
  const auth = body && body.auth;
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) return { error: "auth_missing" };
  const key = nodeKey(auth.node);
  const sig = fromB64u(auth.sig);
  if (Object.keys(auth).some((k) => !["node", "ts", "sig"].includes(k)) || !key || !Number.isSafeInteger(auth.ts) || !sig || sig.length !== 64) {
    return { error: "auth_malformed" };
  }
  const peer = peers.get(auth.node);
  if (peer && peer.banned) return { error: "unknown_peer" };
  if (Math.abs(now - auth.ts) > AUTH_WINDOW_MS) return { error: peer ? "auth_expired" : "unknown_peer" };
  let signed;
  try {
    signed = canonicalize({ ...body, auth: { node: auth.node, ts: auth.ts } });
  } catch {
    return { error: peer ? "auth_malformed" : "unknown_peer" };
  }
  const valid = verifyBytes(key, Buffer.from(signed, "utf8"), sig);
  if (!peer) return valid ? { error: "unknown_peer", signed: auth.node } : { error: "unknown_peer" };
  if (!valid) return { error: "auth_invalid" };
  return { node: auth.node };
}
