// Can Pocket's Base RPC rebuild holders and the deployer from chain data?
import { keccakText } from "./abi.js";
const R = "https://base.api.pocket.network";
const rpc = async (method, params) => { const t = Date.now(); const r = await fetch(R, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json()); r.ms = Date.now() - t; return r; };
const TRANSFER = keccakText("Transfer(address,address,uint256)");
const token = "0x4ef531e3dfbe63205e13b2b943630a53e6ac1c14"; // Temo, Uniswap v2
const head = Number(BigInt((await rpc("eth_blockNumber", [])).result));
// 1. archive: code at an old block (needed to binary-search the creation block)
for (const back of [100000, 5000000, 20000000]) {
  const r = await rpc("eth_getCode", [token, "0x" + (head - back).toString(16)]);
  console.log("getCode", back, "blocks back:", r.error ? "error " + r.error.message.slice(0, 80) : (r.result.length > 2 ? "has code" : "no code"), r.ms + "ms");
}
// 2. binary search the creation block
let lo = 0, hi = head, calls = 0;
while (lo < hi) { const mid = Math.floor((lo + hi) / 2); calls++; const r = await rpc("eth_getCode", [token, "0x" + mid.toString(16)]); if (r.result && r.result.length > 2) hi = mid; else lo = mid + 1; }
console.log("creation block", lo, "found in", calls, "calls");
// 3. the mint log in the creation block -> its transaction sender
const logs = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: "0x" + lo.toString(16), toBlock: "0x" + (lo + 5).toString(16) }]);
const mint = (logs.result || []).find((l) => l.topics[1] === "0x" + "0".repeat(64));
console.log("mint log:", Boolean(mint), "tx", mint && mint.transactionHash);
if (mint) { const tx = await rpc("eth_getTransactionByHash", [mint.transactionHash]); console.log("deployer (mint tx sender):", tx.result.from, "to:", tx.result.to); }
// 4. how many Transfer events since creation (cost of rebuilding holders)
let n = 0, pages = 0, t0 = Date.now();
for (let s = lo; s <= head && pages < 60; s += 1000, pages++) {
  const r = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: "0x" + s.toString(16), toBlock: "0x" + Math.min(head, s + 999).toString(16) }]);
  if (r.error) { console.log("getLogs error", r.error.message.slice(0, 80)); break; }
  n += r.result.length;
}
console.log("token age blocks", head - lo, "~", Math.round((head - lo) * 2 / 3600), "h; first", pages, "pages:", n, "transfers in", Date.now() - t0, "ms");
