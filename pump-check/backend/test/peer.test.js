// Peer sync: signing, the peer API, discovery, and two nodes pulling from
// each other with every item checked against a fake chain. No network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../store.js";
import { HolderIndex } from "../holders.js";
import { selector, word } from "../abi.js";
import { nodeFromSeed, newSeed } from "../peer/crypto.js";
import { Peers, signPeer, verifyPeer } from "../peer/peers.js";
import { createPeerServer } from "../peer/api.js";
import { PeerSync } from "../peer/sync.js";
import { Discovery } from "../peer/discovery.js";
import { verifySnapshot } from "../peer/verify.js";

const quiet = { log() {}, warn() {} };
const TOKEN = "0x" + "a1".repeat(20);
const TOKEN2 = "0x" + "a2".repeat(20);
const WETH = "0x4200000000000000000000000000000000000006";
const PAIR = "0x" + "b1".repeat(20);
const DEPLOYER = "0x" + "d1".repeat(20);
const TX = "0x" + "e1".repeat(32);
const hex = (n) => "0x" + word(n);

const config = {
  version: "1.1.0",
  peerMaxHolders: 20000,
  peerTimeoutMs: 5000,
  peerTokensPerPull: 200,
  peerSnapshotMinBlocks: 1000,
  peerSnapshotsPerTick: 2,
  peerAdoptWaitMs: 5,
  peerSyncIntervalMs: 60000,
  indexChains: ["base"],
  indexIntervalMs: 60000,
};

// A chain with one token created at block 100 by DEPLOYER, one v2 pair, and
// balances as given.
function fakeChain({ balances = new Map(), supply = null, pair = PAIR } = {}) {
  const sup = () => (supply !== null ? supply : [...balances.values()].reduce((a, b) => a + b, 0n));
  const ev = {
    chain: "base",
    addr: { uniV2Factory: "0xf2", uniV3Factory: "0xf3" },
    rpc: {
      async getCode(address, block) {
        const born = address === TOKEN ? 100 : address === PAIR ? 150 : null;
        return { result: born !== null && block >= born ? "0x6080" : "0x" };
      },
      async call(method, params) {
        if (method === "eth_getTransactionByHash") return { result: params[0] === TX ? { from: DEPLOYER, to: null, blockNumber: "0x64" } : null };
        if (method === "eth_getTransactionReceipt") return { result: { contractAddress: TOKEN, logs: [] } };
        throw new Error("unexpected " + method);
      },
      async getLogs() {
        return { result: [] };
      },
    },
    async call(to, data) {
      if (to === ev.addr.uniV2Factory && data.startsWith(selector("getPair(address,address)"))) return "0x" + word(pair);
      if (data === selector("totalSupply()")) return hex(sup());
      if (data.startsWith(selector("balanceOf(address)"))) {
        const who = "0x" + data.slice(-40);
        return hex(balances.get(who) || 0n);
      }
      return null;
    },
    async v4PoolKey() {
      return null;
    },
  };
  return ev;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return "http://127.0.0.1:" + server.address().port;
}

function makeNode() {
  const store = new Store(":memory:");
  const node = nodeFromSeed(newSeed());
  const peers = new Peers([], { log: quiet });
  return { store, node, peers };
}

// ---- signing ----

test("signed peer bodies verify; tampering, age and strangers do not", () => {
  const a = nodeFromSeed(newSeed());
  const peers = new Peers([{ id: a.id, url: "http://a" }], { log: quiet });
  const body = signPeer(a, { after: { ts: 1, key: "" }, limit: 5 });
  assert.deepEqual(verifyPeer(body, peers), { node: a.id });
  assert.equal(verifyPeer({ ...body, limit: 6 }, peers).error, "auth_invalid");
  assert.equal(verifyPeer(signPeer(a, {}, Date.now() - 300000), peers).error, "auth_expired");
  assert.equal(verifyPeer({}, peers).error, "auth_missing");
  const b = nodeFromSeed(newSeed());
  const r = verifyPeer(signPeer(b, {}), peers);
  assert.equal(r.error, "unknown_peer");
  assert.equal(r.signed, b.id);
});

test("a peer that keeps sending bad data is banned, then let back", () => {
  let now = 0;
  const peers = new Peers([{ id: "n_" + "A".repeat(43), url: "http://a" }], { log: quiet, now: () => now });
  const id = "n_" + "A".repeat(43);
  for (let i = 0; i < 4; i++) peers.penalize(id, 5, "bad");
  assert.equal(peers.get(id).banned, true);
  assert.equal(peers.active().length, 0);
  now += 3600001;
  assert.equal(peers.get(id).banned, false);
});

// ---- the API ----

test("the peer API answers hello openly and refuses unsigned or unknown callers", async () => {
  const a = makeNode();
  const server = createPeerServer({ store: a.store, holderIndex: null, node: a.node, peers: a.peers, config });
  const url = await listen(server);
  try {
    const hello = await (await fetch(url + "/v1/hello", { method: "POST", body: "{}" })).json();
    assert.equal(hello.node, a.node.id);
    assert.equal(hello.service, "pump-check");
    assert.equal((await fetch(url + "/v1/tokens", { method: "POST", body: "{}" })).status, 401);
    let nudged = null;
    server.close();
    const s2 = createPeerServer({ store: a.store, holderIndex: null, node: a.node, peers: a.peers, config, onUnknownPeer: (id) => (nudged = id) });
    const url2 = await listen(s2);
    const stranger = nodeFromSeed(newSeed());
    const res = await fetch(url2 + "/v1/tokens", { method: "POST", body: JSON.stringify(signPeer(stranger, {})) });
    assert.equal(res.status, 403);
    assert.equal(nudged, stranger.id);
    assert.equal((await fetch(url2 + "/v1/tokens", { method: "GET" })).status, 405);
    s2.close();
  } finally {
    server.close();
  }
});

// ---- two nodes ----

async function pair({ chainA = fakeChain(), chainB = fakeChain(), holderIndexB = null } = {}) {
  const a = makeNode();
  const b = makeNode();
  const server = createPeerServer({ store: a.store, holderIndex: a.holderIndex || new HolderIndex({ store: a.store, evm: { base: chainA }, config }), node: a.node, peers: a.peers, config });
  const url = await listen(server);
  a.peers.add({ id: b.node.id, url: "http://unused" });
  b.peers.add({ id: a.node.id, url });
  const hi = holderIndexB || new HolderIndex({ store: b.store, evm: { base: chainB }, config });
  const sync = new PeerSync({ store: b.store, evm: { base: chainB, robinhood: chainB }, holderIndex: hi, peers: b.peers, node: b.node, config, log: quiet });
  return { a, b, server, sync, hi };
}

function seedA(store) {
  store.seeToken("base", TOKEN, { now: 1000 });
  store.markPrecomputed("base", TOKEN, null, 2000);
  store.upsertPool("base", { address: PAIR, token: TOKEN, dex: "uniswap_v2", quote: WETH, createdBlock: 150 });
  store.upsertPool("base", { address: "0x" + "c1".repeat(20), token: TOKEN, dex: "aerodrome", quote: WETH });
  store.putCheck("base", TOKEN, "_creation", { block: 100, deployer: DEPLOYER, through: null, method: "definitive", tx: TX }, 3000);
  store.putCheck("base", TOKEN, "honeypot", { result: "pass" });
  store.seeToken("base", TOKEN2, { now: 1500 }); // not precomputed: not shared
}

test("tokens, verifiable pools and creations move from one node to the other, once", async () => {
  const { a, b, server, sync } = await pair();
  try {
    seedA(a.store);
    await sync.tick();
    const tok = b.store.token("base", TOKEN);
    assert.ok(tok, "the token arrived");
    assert.equal(tok.heat, 0);
    assert.equal(tok.precomputed_at, null, "it is precomputed here, not taken");
    assert.equal(b.store.token("base", TOKEN2), null);
    const pools = b.store.pools("base", TOKEN);
    assert.deepEqual(pools.map((p) => [p.address, p.dex, p.created_block]), [[PAIR, "uniswap_v2", 150]]);
    const checks = b.store.checks("base", TOKEN);
    assert.equal(checks._creation.deployer, DEPLOYER);
    assert.equal(checks._creation.method, "definitive");
    assert.equal(checks.honeypot, undefined, "what can flip is never shared");
    assert.equal(sync.stats.tokens, 1);
    assert.equal(sync.stats.creations, 1);
    // The cursors moved: a second pull adds nothing.
    await sync.tick();
    assert.equal(sync.stats.tokens, 1);
    assert.equal(sync.stats.creations, 1);
    assert.equal(b.peers.get(a.node.id).penalty, 0);
  } finally {
    server.close();
  }
});

test("a pool the factory does not name, or a false creation, is refused and costs the peer", async () => {
  const { a, b, server, sync } = await pair({ chainB: fakeChain({ pair: "0x" + "99".repeat(20) }) });
  try {
    seedA(a.store);
    a.store.putCheck("base", TOKEN, "_creation", { block: 101, deployer: DEPLOYER, through: null, method: "definitive", tx: TX }, 3000);
    await sync.tick();
    assert.ok(b.store.token("base", TOKEN), "the token itself is still queued for precompute");
    assert.equal(b.store.pools("base", TOKEN).length, 0);
    assert.equal(b.store.checks("base", TOKEN)._creation, undefined);
    assert.ok(b.peers.get(a.node.id).penalty >= 3);
  } finally {
    server.close();
  }
});

// ---- holder snapshots ----

function liveOnA(store, balances, cursor) {
  store.seeToken("base", TOKEN, {});
  store.enrollIndex("base", TOKEN, 100);
  store.setIndexCursor("base", cursor);
  store.applyBalances("base", new Map([[TOKEN, balances]]), { token: TOKEN, indexedTo: cursor });
  store.setIndexStatus("base", TOKEN, "live");
}

function backfillingOnB(store, cursor) {
  store.seeToken("base", TOKEN, {});
  store.enrollIndex("base", TOKEN, 100);
  store.setIndexCursor("base", cursor);
}

const holders = () =>
  new Map(Array.from({ length: 30 }, (_, i) => ["0x" + (i + 1).toString(16).padStart(40, "0"), BigInt((i + 1) * 1000)]));

test("a verified snapshot replaces a far-behind backfill, which goes on from its block", async () => {
  const bal = holders();
  const { a, b, server, sync } = await pair({ chainB: fakeChain({ balances: bal }) });
  try {
    liveOnA(a.store, bal, 50000);
    backfillingOnB(b.store, 50010);
    await sync.tick();
    assert.equal(sync.stats.snapshots, 1);
    const st = b.store.indexState("base", TOKEN);
    assert.equal(st.status, "backfill");
    assert.equal(st.indexed_to, 50000);
    assert.equal(b.store.holderCount("base", TOKEN), 30);
    assert.equal(b.store.balanceTotal("base", TOKEN), [...bal.values()].reduce((x, y) => x + y, 0n));
  } finally {
    server.close();
  }
});

test("a snapshot with a wrong balance is refused with blame; one that does not add up, without", async () => {
  const bal = holders();
  const lie = new Map(bal);
  // The largest holder hidden, its balance moved to a small one so the sum still matches.
  lie.set("0x" + (30).toString(16).padStart(40, "0"), 1n);
  lie.set("0x" + (1).toString(16).padStart(40, "0"), 1000n + 29999n);
  const chainB = fakeChain({ balances: bal });
  const { a, b, server, sync } = await pair({ chainB });
  try {
    liveOnA(a.store, lie, 50000);
    backfillingOnB(b.store, 50010);
    await sync.tick();
    assert.equal(sync.stats.snapshots, 0);
    assert.equal(b.store.indexState("base", TOKEN).indexed_to, 99);
    assert.ok(b.peers.get(a.node.id).penalty >= 5);
  } finally {
    server.close();
  }
  const r = await verifySnapshot(fakeChain({ balances: bal, supply: 1n }), TOKEN, 50000, [...bal].map(([h, v]) => [h, v.toString()]));
  assert.ok(r.skip, "a sum that is off is skipped, not blamed");
});

test("a snapshot ahead of this node's cursor waits for it, and is not adopted past it", async () => {
  const bal = holders();
  const { a, b, server, sync, hi } = await pair({ chainB: fakeChain({ balances: bal }) });
  try {
    liveOnA(a.store, bal, 50000);
    backfillingOnB(b.store, 49000);
    setTimeout(() => b.store.setIndexCursor("base", 50005), 20);
    await sync.tick();
    assert.equal(sync.stats.snapshots, 1, "adopted once the cursor caught up");
    assert.equal(hi.adopt("base", TOKEN, 60000, []), "ahead_of_cursor");
    hi.busy.add("base");
    assert.equal(hi.adopt("base", TOKEN, 50001, []), "busy");
  } finally {
    server.close();
  }
});

test("a node shares only live snapshots within its holder limit", () => {
  const s = new Store(":memory:");
  const bal = holders();
  liveOnA(s, bal, 777);
  assert.equal(s.holderSnapshot("base", TOKEN, 100).block, 777);
  assert.equal(s.holderSnapshot("base", TOKEN, 100).holders.length, 30);
  assert.equal(s.holderSnapshot("base", TOKEN, 10), null);
  s.setIndexStatus("base", TOKEN, "backfill");
  assert.equal(s.holderSnapshot("base", TOKEN, 100), null);
});

// ---- discovery ----

test("discovery finds nodes behind staked suppliers on both networks, skips itself, drops the gone", async () => {
  const me = nodeFromSeed(newSeed());
  const other = nodeFromSeed(newSeed());
  const peers = new Peers([], { log: quiet });
  let listing = {
    main: [{ operator: "pokt1a", urls: ["https://a.example/"] }, { operator: "pokt1me", urls: ["https://me.example"] }],
    beta: [{ operator: "pokt1b", urls: ["https://a-beta.example"] }, { operator: "pokt1x", urls: ["https://nothing.example"] }],
  };
  const answers = { "https://a.example": other.id, "https://a-beta.example": other.id, "https://me.example": me.id };
  const fakeFetch = async (url) => {
    const origin = new URL(url).origin;
    if (!answers[origin]) throw new Error("unreachable");
    assert.ok(url.endsWith("/pump-check-peer/v1/hello"));
    return new Response(JSON.stringify({ service: "pump-check", node: answers[origin] }), { status: 200 });
  };
  const d = new Discovery(me, peers, { fetch: fakeFetch, log: quiet, listSuppliers: async (n) => ({ suppliers: listing[n] }) });
  const found = await d.run();
  assert.deepEqual(found.map((f) => f.id), [other.id]);
  assert.equal(peers.all().length, 1);
  assert.equal(peers.get(other.id).url, "https://a-beta.example/pump-check-peer");
  listing = { main: [], beta: [] };
  await d.run();
  assert.equal(peers.all().length, 0);
});

test("discovery keeps its peers when a network's listing fails", async () => {
  const me = nodeFromSeed(newSeed());
  const other = nodeFromSeed(newSeed());
  const peers = new Peers([], { log: quiet });
  peers.add({ id: other.id, url: "https://a.example/pump-check-peer", source: "chain" });
  const d = new Discovery(me, peers, {
    fetch: async () => new Response("{}", { status: 404 }),
    log: quiet,
    listSuppliers: async (n) => {
      if (n === "main") throw new Error("down");
      return { suppliers: [] };
    },
  });
  await d.run();
  assert.equal(peers.all().length, 1);
});
