// Checking what a peer sends against the chain before storing it. Each
// verifier returns the value to store, recomputed from chain reads where it
// can be, or a { reject } saying what did not match. A failed read throws:
// the item is skipped this time and the peer is not blamed.
//
// Reads go through Pocket only ({ failover: false }), like precompute.

import { selector, word, decodeAddress, decodeUint, isEvmAddress } from "../abi.js";
import { SELECTORS as S, TOPIC } from "../evm.js";

const OPTS = { failover: false };
const ZERO_TOPIC = "0x" + "0".repeat(64);
const lc = (a) => (a ? String(a).toLowerCase() : null);
const reject = (why) => ({ reject: why });

// Pools whose identity the chain itself vouches for: the canonical Uniswap
// factories, and v4 pools by their Initialize event. Others are left to this
// node's own ingest: a pool a peer made up could steer the honeypot probe.
export const PEER_POOL_DEXES = new Set(["uniswap_v2", "uniswap_v3", "uniswap_v4"]);

const GET_PAIR = selector("getPair(address,address)");
const GET_POOL = selector("getPool(address,address,uint24)");
const FEE = selector("fee()");

async function hasCode(ev, address, block) {
  const { result } = await ev.rpc.getCode(address, block, OPTS);
  return Boolean(result && result !== "0x");
}

// The block a contract appeared in, if `block` is it.
async function createdAt(ev, address, block) {
  if (!Number.isSafeInteger(block) || block < 1) return false;
  return !(await hasCode(ev, address, block - 1)) && (await hasCode(ev, address, block));
}

// p: { address, dex, quote, created_block, pool_key? } for `token` on `ev`'s chain.
export async function verifyPool(ev, token, p) {
  if (!p || !PEER_POOL_DEXES.has(p.dex) || typeof p.address !== "string") return reject("pool kind not accepted");
  const address = lc(p.address);
  const createdBlock = p.created_block == null ? null : Number(p.created_block);
  if (p.dex === "uniswap_v4") {
    // The pool id is not a contract: its Initialize event at the claimed block names the key.
    if (!/^0x[0-9a-f]{64}$/.test(address)) return reject("v4 pool id malformed");
    if (!Number.isSafeInteger(createdBlock)) return reject("v4 pool without a creation block");
    const key = await ev.v4PoolKey(address, createdBlock, OPTS);
    if (!key || (key.currency0 !== token && key.currency1 !== token)) return reject("no v4 pool for this token at that block");
    return { pool: { address, token, dex: "uniswap_v4", quote: key.currency0 === token ? key.currency1 : key.currency0, createdBlock, extra: { poolKey: key } } };
  }
  if (!isEvmAddress(address) || !isEvmAddress(p.quote)) return reject("pool malformed");
  const quote = lc(p.quote);
  let found;
  if (p.dex === "uniswap_v2") {
    found = decodeAddress(await ev.call(ev.addr.uniV2Factory, GET_PAIR + word(token) + word(quote), "latest", OPTS));
  } else {
    const fee = await ev.call(address, FEE, "latest", OPTS);
    if (!fee) return reject("not a v3 pool");
    found = decodeAddress(await ev.call(ev.addr.uniV3Factory, GET_POOL + word(token) + word(quote) + word(Number(decodeUint(fee))), "latest", OPTS));
  }
  if (lc(found) !== address) return reject("the factory does not name this pool");
  // A wrong creation block would move the sniper window: kept only if true.
  const block = createdBlock !== null && (await createdAt(ev, address, createdBlock)) ? createdBlock : null;
  return { pool: { address, token, dex: p.dex, quote, createdBlock: block } };
}

// c: { block, deployer, through, tx } as EvmChain.creation found it. The
// method is recomputed, not taken.
export async function verifyCreation(ev, token, c) {
  if (!c || !Number.isSafeInteger(c.block) || c.block < 1 || !isEvmAddress(c.deployer) || !/^0x[0-9a-fA-F]{64}$/.test(String(c.tx || ""))) {
    return reject("creation malformed");
  }
  if (c.through !== null && c.through !== undefined && !isEvmAddress(c.through)) return reject("creation malformed");
  if (!(await createdAt(ev, token, c.block))) return reject("the token was not created at that block");
  const { result: tx } = await ev.rpc.call("eth_getTransactionByHash", [c.tx], OPTS);
  if (!tx) throw Object.assign(new Error("transaction not found"), { kind: "unavailable" });
  const txBlock = Number(BigInt(tx.blockNumber));
  const window = ev.chain === "robinhood" ? 3000 : 300;
  if (lc(tx.from) !== lc(c.deployer) || lc(tx.to) !== lc(c.through || null)) return reject("the transaction does not match the deployer");
  if (txBlock < c.block || txBlock > c.block + window) return reject("the transaction is outside the creation window");
  const { result: rc } = await ev.rpc.call("eth_getTransactionReceipt", [c.tx], OPTS);
  if (!rc) throw Object.assign(new Error("receipt not found"), { kind: "unavailable" });
  const creates = lc(rc.contractAddress) === token;
  const mints = (rc.logs || []).some((l) => lc(l.address) === token && l.topics && l.topics[0] === TOPIC.transfer && l.topics[1] === ZERO_TOPIC);
  if (!creates && !mints) return reject("the transaction neither creates nor mints the token");
  // The first mint, as creation() takes it: none earlier in the window.
  if (!creates && txBlock > c.block) {
    const { result } = await ev.rpc.getLogs({ address: token, topics: [TOPIC.transfer, ZERO_TOPIC], fromBlock: c.block, toBlock: txBlock - 1 }, { ...OPTS, pageBlocks: window + 1 });
    if (result.length) return reject("an earlier mint exists");
  }
  return { creation: { block: c.block, deployer: lc(tx.from), through: tx.to ? lc(tx.to) : null, method: txBlock === c.block ? "definitive" : "heuristic", tx: c.tx } };
}

// holders: [[holder, balance string]] at `block`. The balances must add up to
// the supply at that block exactly, and the largest `top` plus `sample` random
// holders must match balanceOf at that block. A sum that is off is refused
// without blame (a rebasing token on an honest peer); a balance that is off is not.
//
// What this cannot catch for certain: a holder left out, its balance spread
// over enough small holders that none reaches the top and the random sample
// misses all of them. Moving a large balance that way takes many altered rows,
// each a chance to be sampled; a peer caught once is banned.
export async function verifySnapshot(ev, token, block, holders, { top = 15, sample = 20, max = 20000, random = Math.random } = {}) {
  if (!Number.isSafeInteger(block) || block < 1 || !Array.isArray(holders) || holders.length > max) return reject("snapshot malformed");
  const seen = new Set();
  const rows = [];
  let total = 0n;
  for (const h of holders) {
    if (!Array.isArray(h) || h.length !== 2 || !isEvmAddress(h[0]) || typeof h[1] !== "string" || !/^[1-9][0-9]{0,77}$/.test(h[1])) return reject("snapshot malformed");
    const holder = lc(h[0]);
    if (seen.has(holder) || holder === "0x0000000000000000000000000000000000000000") return reject("snapshot malformed");
    seen.add(holder);
    const balance = BigInt(h[1]);
    rows.push([holder, balance]);
    total += balance;
  }
  const supplyHex = await ev.call(token, S.totalSupply, block, OPTS);
  if (!supplyHex) throw Object.assign(new Error("totalSupply did not answer"), { kind: "unavailable" });
  if (decodeUint(supplyHex) !== total) return { skip: "the balances do not add up to the supply" };
  rows.sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
  const picks = rows.slice(0, top);
  const rest = rows.slice(top);
  for (let i = 0; i < sample && rest.length; i++) picks.push(rest.splice(Math.floor(random() * rest.length), 1)[0]);
  const reads = await Promise.all(picks.map(([holder]) => ev.call(token, S.balanceOf + word(holder), block, OPTS)));
  for (let i = 0; i < picks.length; i++) {
    if (!reads[i]) throw Object.assign(new Error("balanceOf did not answer"), { kind: "unavailable" });
    if (decodeUint(reads[i]) !== picks[i][1]) return reject("a balance does not match the chain");
  }
  return { holders: rows };
}
