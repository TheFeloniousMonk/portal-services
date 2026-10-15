// Typosquat detection: is this name one edit away from a well-known package it
// is not? This is a local, network-free signal, so it is always available.
//
// The seed list is a small set of high-value impersonation targets per
// ecosystem — the names attackers actually squat on. It is intentionally short;
// an operator can extend it via TC_POPULAR_FILE (one "<ecosystem> <name>" per
// line) without a code change. A signal is advisory, never a confirmation.

import { readFileSync } from "node:fs";
import { canonicalEcosystem, normalizeName } from "./osv.js";

const SEED = {
  npm: [
    "react", "react-dom", "lodash", "axios", "express", "chalk", "commander",
    "debug", "webpack", "next", "vue", "typescript", "eslint", "dotenv",
    "colors", "request", "moment", "jquery", "babel-core", "node-fetch",
    "cross-env", "uuid", "yargs", "socket.io", "mongoose", "redux",
  ],
  PyPI: [
    "requests", "urllib3", "numpy", "pandas", "flask", "django", "setuptools",
    "pip", "wheel", "pytest", "boto3", "scipy", "matplotlib", "pyyaml",
    "beautifulsoup4", "cryptography", "pillow", "tensorflow", "torch",
    "colorama", "python-dateutil", "certifi",
  ],
  "crates.io": [
    "serde", "tokio", "rand", "clap", "syn", "regex", "libc", "log", "anyhow",
    "reqwest", "hyper", "serde_json", "futures", "bytes",
  ],
  Go: [],
};

function loadPopular() {
  const map = new Map(); // canonical eco -> Set of normalized names
  for (const [eco, names] of Object.entries(SEED)) {
    const set = new Set(names.map((n) => normalizeName(eco, n)));
    map.set(eco, set);
  }
  const file = process.env.TC_POPULAR_FILE;
  if (file) {
    try {
      for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
        const [rawEco, rawName] = line.trim().split(/\s+/);
        const eco = canonicalEcosystem(rawEco);
        if (eco && rawName) {
          if (!map.has(eco)) map.set(eco, new Set());
          map.get(eco).add(normalizeName(eco, rawName));
        }
      }
    } catch {
      // No extension file, or unreadable. The seed list still applies.
    }
  }
  return map;
}

const POPULAR = loadPopular();

// Distance up to a cap; bails out as soon as it is exceeded so long strings are
// cheap. Returns Infinity if the edit distance is above `max`.
export function boundedEditDistance(a, b, max = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return Infinity;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = i;
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = tmp;
      if (prev[j] < best) best = prev[j];
    }
    if (best > max) return Infinity;
  }
  return prev[b.length] <= max ? prev[b.length] : Infinity;
}

// Returns a signal object, or null if the name is a known-good name or not
// close enough to any target to be suspicious.
export function detectTyposquat(ecosystem, name) {
  const eco = canonicalEcosystem(ecosystem);
  if (!eco) return null;
  const set = POPULAR.get(eco);
  if (!set || !set.size) return null;
  const norm = normalizeName(eco, name);
  if (set.has(norm)) return null; // it *is* the popular package
  if (norm.length < 4) return null; // too short to judge by one edit
  for (const target of set) {
    if (boundedEditDistance(norm, target, 1) <= 1) {
      return {
        type: "typosquat",
        weight: "high",
        detail: "Name is one edit from '" + target + "', a well-known " + eco + " package",
      };
    }
  }
  return null;
}
