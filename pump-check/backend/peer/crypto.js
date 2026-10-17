// Node keys and request signing between PumpCheck nodes, as Meadow does it:
// an Ed25519 key per node (not the supplier's operator key), its id "n_" plus
// the base64url public key, and request bodies signed as JCS (RFC 8785).

import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";

export const b64u = (bytes) => Buffer.from(bytes).toString("base64url");

// Strict: only the canonical unpadded encoding of some byte string.
export function fromB64u(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const bytes = Buffer.from(s, "base64url");
  return b64u(bytes) === s ? bytes : null;
}

// JCS. Peer messages carry integers only, so numbers reduce to safe integers.
export function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("JCS: only safe integers are allowed");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(value[k])).join(",") + "}";
  }
  throw new TypeError(`JCS: unsupported type ${typeof value}`);
}

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function nodeFromSeed(seed) {
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const spki = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(spki.subarray(SPKI_PREFIX.length));
  return { id: "n_" + b64u(publicKey), privateKey, publicKey };
}

export const newSeed = () => randomBytes(32);

const NODE_ID = /^n_[A-Za-z0-9_-]{43}$/;

export function nodeKey(id) {
  if (typeof id !== "string" || !NODE_ID.test(id)) return null;
  const key = fromB64u(id.slice(2));
  return key && key.length === 32 ? key : null;
}

export const shortId = (id) => (typeof id === "string" ? id.slice(0, 10) + "…" : String(id));

export const signBytes = (privateKey, data) => sign(null, data, privateKey);

export function verifyBytes(publicKey, data, sig) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, publicKey]), format: "der", type: "spki" });
    return verify(null, data, key, sig);
  } catch {
    return false;
  }
}
