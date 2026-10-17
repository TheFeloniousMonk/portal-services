// The peer API, on its own port (PUMP_PEER_PORT, 8090). The supplier's Caddy
// routes /pump-check-peer/* to it with the prefix stripped (deploy/routes.json);
// the relayer knows only port 8080, so no relay can reach these routes, and
// nothing here is paid for.
//
//   POST /v1/hello      -> {service, node, version}         no auth
//   POST /v1/tokens     {after, limit} -> {tokens, next}    tokens this node precomputed, with pools a peer can verify
//   POST /v1/creations  {after, limit} -> {creations, next} creation block and deployer per EVM token
//   POST /v1/holders    {chain, token} -> {block, holders} or {available: false}
//
// Every route but hello needs a body signed by a known peer (peers.js).
// Cursors are {ts, key}; key is "chain:address", the start is {ts: 0, key: ""}.

import http from "node:http";
import { verifyPeer } from "./peers.js";
import { PEER_POOL_DEXES } from "./verify.js";

const MAX_BODY = 16 * 1024;
const PAGE = 200;

function send(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
}

const error = (code, message) => ({ service: "pump-check", error: { code, message } });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function parseCursor(after) {
  if (after === undefined || after === null) return { ts: 0, key: "" };
  if (typeof after !== "object" || !Number.isSafeInteger(after.ts) || typeof after.key !== "string" || after.key.length > 120) return null;
  return { ts: after.ts, key: after.key };
}

const limitOf = (body) => Math.min(PAGE, Math.max(1, Number.isSafeInteger(body.limit) ? body.limit : PAGE));

export function peerRoutes({ store, holderIndex, node, config }) {
  return {
    "/v1/hello": { auth: false, handle: () => ({ service: "pump-check", node: node.id, version: config.version }) },
    "/v1/tokens": {
      handle: (body) => {
        const after = parseCursor(body.after);
        if (!after) return { status: 400, payload: error("invalid_request", "after must be {ts, key}") };
        const rows = store.peerTokens(after, limitOf(body));
        const tokens = rows.map((r) => ({
          chain: r.chain,
          address: r.address,
          pools:
            r.chain === "solana"
              ? []
              : store
                  .pools(r.chain, r.address)
                  .filter((p) => PEER_POOL_DEXES.has(p.dex))
                  .slice(0, 4)
                  .map((p) => ({ address: p.address, dex: p.dex, quote: p.quote, created_block: p.created_block })),
        }));
        const last = rows[rows.length - 1];
        return { tokens, next: last ? { ts: last.first_seen, key: last.chain + ":" + last.address } : after };
      },
    },
    "/v1/creations": {
      handle: (body) => {
        const after = parseCursor(body.after);
        if (!after) return { status: 400, payload: error("invalid_request", "after must be {ts, key}") };
        const rows = store.peerCreations(after, limitOf(body));
        const creations = rows
          .filter((r) => r.creation && r.creation.deployer && r.creation.tx)
          .map((r) => ({ chain: r.chain, token: r.token, creation: { block: r.creation.block, deployer: r.creation.deployer, through: r.creation.through || null, tx: r.creation.tx } }));
        const last = rows[rows.length - 1];
        return { creations, next: last ? { ts: last.ts, key: last.chain + ":" + last.token } : after };
      },
    },
    "/v1/holders": {
      handle: (body) => {
        const chain = String(body.chain || "");
        const token = String(body.token || "").toLowerCase();
        if (!holderIndex || !holderIndex.indexes(chain)) return { available: false, reason: "chain not indexed here" };
        const snap = store.holderSnapshot(chain, token, config.peerMaxHolders);
        return snap ? { chain, token, ...snap } : { available: false, reason: "not live here, or too many holders" };
      },
    },
  };
}

// opts.onUnknownPeer(nodeId): a valid signature from a node not known yet.
export function createPeerServer({ store, holderIndex, node, peers, config, onUnknownPeer = null }) {
  const table = peerRoutes({ store, holderIndex, node, config });
  const server = http.createServer(async (req, res) => {
    const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
    try {
      if (path === "/" && (req.method === "GET" || req.method === "HEAD")) return send(res, 200, { service: "pump-check", node: node.id });
      const route = table[path];
      if (!route) return send(res, 404, error("not_found", "No such path: " + path));
      if (req.method !== "POST") return send(res, 405, error("method_not_allowed", "Use POST with a JSON body."));
      let body;
      try {
        body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      } catch (e) {
        return send(res, e && e.code === "body_too_large" ? 413 : 400, error("invalid_request", "Body must be a JSON object under 16 KB."));
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(res, 400, error("invalid_request", "Body must be a JSON object."));
      if (route.auth !== false) {
        const who = verifyPeer(body, peers);
        if (who.error) {
          if (who.signed && onUnknownPeer) onUnknownPeer(who.signed);
          return send(res, who.error === "unknown_peer" ? 403 : 401, error(who.error, "peer authentication failed"));
        }
        peers.noteOk(who.node);
      }
      const out = route.handle(body);
      if (out && out.status) return send(res, out.status, out.payload);
      return send(res, 200, out);
    } catch (err) {
      console.error(JSON.stringify({ msg: "peer request failed", path, error: String(err && err.stack) }));
      return send(res, 500, error("internal_error", "The peer request could not be completed."));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  return server;
}
