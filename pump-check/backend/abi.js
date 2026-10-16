// The small slice of the Ethereum ABI this service needs: static words in,
// words and the occasional dynamic value out. A general encoder would be
// larger than every call site put together.

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

export const keccakHex = (bytes) => "0x" + bytesToHex(keccak_256(bytes));
export const keccakText = (text) => keccakHex(new TextEncoder().encode(text));
export const selector = (signature) => keccakText(signature).slice(0, 10);

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const DEAD_ADDRESSES = new Set([
  ZERO_ADDRESS,
  "0x000000000000000000000000000000000000dead",
  "0xdead000000000000000042069420694206942069",
]);

const strip = (h) => (h.startsWith("0x") ? h.slice(2) : h);

export function word(value) {
  if (typeof value === "boolean") return value ? "1".padStart(64, "0") : "0".padStart(64, "0");
  if (typeof value === "string" && value.startsWith("0x")) return strip(value).toLowerCase().padStart(64, "0");
  let n = BigInt(value);
  if (n < 0n) n = (1n << 256n) + n;
  return n.toString(16).padStart(64, "0");
}

// selector plus static arguments, each one word.
export function encodeCall(sel, ...args) {
  return sel + args.map(word).join("");
}

export function words(hex) {
  const h = strip(hex || "");
  const out = [];
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64));
  return out;
}

export const wordToAddress = (w) => "0x" + w.slice(24).toLowerCase();
export const wordToBigInt = (w) => BigInt("0x" + w);
export function wordToSigned(w) {
  const n = BigInt("0x" + w);
  return n >= 1n << 255n ? n - (1n << 256n) : n;
}

export function decodeAddress(hex) {
  const w = words(hex);
  if (!w.length) return null;
  // A function that does not exist on a contract with a fallback can return
  // anything; an address has its upper 12 bytes clear.
  if (!/^0{24}/.test(w[0])) return null;
  return wordToAddress(w[0]);
}

export function decodeUint(hex) {
  const w = words(hex);
  return w.length ? wordToBigInt(w[0]) : null;
}

// A dynamic string return (name(), symbol()). Older tokens return bytes32.
export function decodeString(hex) {
  const h = strip(hex || "");
  if (h.length < 64) return null;
  if (h.length === 64) return bytes32ToText(h);
  const off = Number(BigInt("0x" + h.slice(0, 64))) * 2;
  if (off + 64 > h.length) return bytes32ToText(h.slice(0, 64));
  const len = Number(BigInt("0x" + h.slice(off, off + 64)));
  if (len > 4096 || off + 64 + len * 2 > h.length) return null;
  return Buffer.from(h.slice(off + 64, off + 64 + len * 2), "hex").toString("utf8");
}

function bytes32ToText(h) {
  const buf = Buffer.from(h, "hex");
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? 32 : end).toString("utf8");
}

// keccak256(abi.encode(...words)), for v4 pool ids and mapping slots.
export function hashWords(...values) {
  return keccakHex(Buffer.from(values.map(word).join(""), "hex"));
}

export const isEvmAddress = (s) => typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
