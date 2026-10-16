// Records a live session into test/fixtures/session.json for the offline tests.
// Not part of `npm test`; run by hand when the fixtures need refreshing:
//
//   node test/capture.mjs
//
// Every request this backend makes (JSON-RPC and DexPaprika) is keyed by a
// hash of its method and parameters and stored with the answer, so the tests
// replay real chain data without a network. Run it without API keys set:
// keys would be recorded in request URLs.

import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "../server.js";
import { Store } from "../store.js";
import { TOKENS } from "./tokens.js";

if (process.env.PUMP_DEXPAPRIKA_API_KEY || process.env.PUMP_BLOCKSCOUT_API_KEY) {
  console.error("unset PUMP_DEXPAPRIKA_API_KEY and PUMP_BLOCKSCOUT_API_KEY before capturing");
  process.exit(1);
}

export const keyOf = (kind, a, b) => createHash("sha256").update(kind + "\n" + a + "\n" + b).digest("hex").slice(0, 32);

const session = {};
const realFetch = globalThis.fetch;
async function recording(url, init = {}) {
  const res = await realFetch(url, init);
  const text = await res.text();
  const u = new URL(String(url));
  let key;
  if (init.method === "POST") {
    const body = JSON.parse(init.body);
    key = keyOf("rpc", body.method, JSON.stringify(body.params));
  } else {
    u.searchParams.delete("apikey");
    key = keyOf("http", u.pathname, u.searchParams.toString());
  }
  // Answers in arrival order: the same question (eth_blockNumber) has a
  // different answer as the chain moves, and replay serves them in order.
  (session[key] = session[key] || []).push({ status: res.status, headers: { "content-type": res.headers.get("content-type") || "", "x-api-plan": res.headers.get("x-api-plan") || "" }, body: text });
  return new Response(text, { status: res.status, headers: res.headers });
}

const app = build({ store: new Store(":memory:"), fetchImpl: recording });
for (const t of TOKENS) {
  const r = await app.checker.check(t.chain, t.address, "full");
  console.log(t.chain, t.label, r.verdict, (r.flags || []).map((f) => f.id).join(","));
}
mkdirSync(new URL("./fixtures/", import.meta.url), { recursive: true });
writeFileSync(new URL("./fixtures/session.json", import.meta.url), JSON.stringify({ captured_at: new Date().toISOString(), tokens: TOKENS, answers: session }));
console.log("recorded", Object.keys(session).length, "answers");
process.exit(0);
