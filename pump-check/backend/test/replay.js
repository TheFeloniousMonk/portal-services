// Replays test/fixtures/session.json (recorded by capture.mjs) as a fetch
// implementation: every request is answered from the recording, keyed by its
// JSON-RPC method and parameters or its HTTP path and query. Answers to the
// same question are served in the order they were recorded. A request that
// was not recorded fails like a network error, so a code change that asks the
// chain something new shows up as an unknown result in the tests.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const keyOf = (kind, a, b) => createHash("sha256").update(kind + "\n" + a + "\n" + b).digest("hex").slice(0, 32);

export function loadSession() {
  return JSON.parse(readFileSync(new URL("./fixtures/session.json", import.meta.url), "utf8"));
}

export function replayFetch(session, { misses = [] } = {}) {
  const served = new Map();
  return async (url, init = {}) => {
    const u = new URL(String(url));
    let key;
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      key = keyOf("rpc", body.method, JSON.stringify(body.params));
    } else {
      u.searchParams.delete("apikey");
      key = keyOf("http", u.pathname, u.searchParams.toString());
    }
    const list = session.answers[key];
    let hit = null;
    if (list) {
      // In recorded order; the last answer repeats once the list runs out.
      const i = served.get(key) || 0;
      hit = list[Math.min(i, list.length - 1)];
      served.set(key, i + 1);
    }
    if (!hit) {
      misses.push(init.method === "POST" ? JSON.parse(init.body).method : u.pathname);
      throw new TypeError("not recorded");
    }
    return new Response(hit.body, { status: hit.status, headers: hit.headers });
  };
}
