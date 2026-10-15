// The local OSV index: the in-memory mirror a scan is answered from, plus the
// version-range logic that decides whether a pinned version is actually affected.
//
// Shape: a Map keyed by "<canonical ecosystem>\0<normalized name>" to an array
// of compact advisory entries. One OSV record can contribute several entries
// (one per affected package). Only the fields a scan needs are kept, so the
// snapshot on disk is a fraction of the raw OSV dumps.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

// Caller-facing ecosystem aliases -> canonical OSV ecosystem name.
const ECOSYSTEM_ALIASES = new Map([
  ["npm", "npm"],
  ["pypi", "PyPI"], ["pip", "PyPI"], ["python", "PyPI"],
  ["crates", "crates.io"], ["crates.io", "crates.io"], ["cargo", "crates.io"], ["rust", "crates.io"],
  ["go", "Go"], ["golang", "Go"],
]);

export const TRACKED_ECOSYSTEMS = ["npm", "PyPI", "crates.io", "Go"];

export function canonicalEcosystem(eco) {
  if (!eco) return null;
  const raw = String(eco).trim();
  return ECOSYSTEM_ALIASES.get(raw.toLowerCase()) || (TRACKED_ECOSYSTEMS.includes(raw) ? raw : null);
}

// Name normalization is per-ecosystem: PyPI folds case and runs of -_. to a
// single dash (PEP 503); npm and crates fold case; Go module paths are exact.
export function normalizeName(canonicalEco, name) {
  const n = String(name || "").trim();
  if (canonicalEco === "PyPI") return n.toLowerCase().replace(/[-_.]+/g, "-");
  if (canonicalEco === "npm" || canonicalEco === "crates.io") return n.toLowerCase();
  return n;
}

const keyOf = (eco, name) => eco + "\0" + normalizeName(eco, name);

// --- version comparison ----------------------------------------------------
// Semver for npm/crates/Go; a looser dotted comparison for PyPI (an honest
// approximation of PEP 440 that is correct for ordinary release versions and
// treats any segment with letters as a lower-precedence pre-release).

function splitSemver(v) {
  const s = String(v).trim().replace(/^v/, "");
  const [core, pre = ""] = s.split("+")[0].split("-");
  const nums = core.split(".").map((x) => parseInt(x, 10) || 0);
  return { nums, pre };
}

function cmpNums(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function compareSemver(a, b) {
  const A = splitSemver(a), B = splitSemver(b);
  const c = cmpNums(A.nums, B.nums);
  if (c) return c;
  if (!A.pre && B.pre) return 1; // a release outranks a pre-release
  if (A.pre && !B.pre) return -1;
  if (A.pre === B.pre) return 0;
  return A.pre < B.pre ? -1 : 1;
}

export function compareLoose(a, b) {
  const norm = (v) => String(v).trim().replace(/^v/, "").split("+")[0].split(/[._-]/).filter(Boolean);
  const A = norm(a), B = norm(b);
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i] ?? "0", y = B[i] ?? "0";
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d) return d < 0 ? -1 : 1;
    } else if (nx && !ny) return 1; // 1.0.0 > 1.0.0rc1
    else if (!nx && ny) return -1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function comparatorFor(rangeType, canonicalEco) {
  if (rangeType === "SEMVER") return compareSemver;
  // ECOSYSTEM ranges use the ecosystem's own ordering.
  return canonicalEco === "PyPI" ? compareLoose : compareSemver;
}

// OSV range events are a version-sorted sequence. Walking them left to right and
// toggling on introduced / fixed / last_affected is the algorithm from the OSV
// spec; "0" as an introduced value means "from the beginning".
function versionInRange(version, range, canonicalEco) {
  if (range.type === "GIT") return false;
  const cmp = comparatorFor(range.type, canonicalEco);
  let affected = false;
  for (const ev of range.events || []) {
    if (ev.introduced !== undefined) {
      if (ev.introduced === "0" || cmp(version, ev.introduced) >= 0) affected = true;
    }
    if (ev.fixed !== undefined && cmp(version, ev.fixed) >= 0) affected = false;
    if (ev.last_affected !== undefined && cmp(version, ev.last_affected) > 0) affected = false;
  }
  return affected;
}

// The smallest fixed version across an entry's ranges, for the upgrade hint.
function firstFixed(entry, canonicalEco) {
  const cmp = comparatorFor(entry.rangeType || "SEMVER", canonicalEco);
  let best = null;
  for (const range of entry.ranges || []) {
    for (const ev of range.events || []) {
      if (ev.fixed !== undefined && (best === null || cmp(ev.fixed, best) < 0)) best = ev.fixed;
    }
  }
  return best;
}

// --- severity --------------------------------------------------------------
// A MAL- record is confirmed malware and gets its own verdict, never a CVSS
// bucket. For ordinary advisories we read the database_specific severity label
// that GHSA-sourced records carry; a CVSS vector without a label stays
// "unknown" rather than guessing a score from the vector string.
const SEVERITY_RANK = { critical: 5, high: 4, moderate: 3, medium: 3, low: 2, unknown: 1 };
export function severityRank(label) {
  return SEVERITY_RANK[String(label || "unknown").toLowerCase()] ?? 1;
}

function severityOf(record) {
  const ds = record.database_specific || {};
  if (ds.severity && typeof ds.severity === "string") {
    const s = ds.severity.toLowerCase();
    if (s === "moderate") return "medium";
    return s;
  }
  return "unknown";
}

function bestReference(record) {
  const refs = Array.isArray(record.references) ? record.references : [];
  const advisory = refs.find((r) => r && (r.type === "ADVISORY" || r.type === "WEB") && r.url);
  return "https://osv.dev/vulnerability/" + record.id + (advisory ? "" : "");
}

export class OsvIndex {
  constructor(dir, snapshotName) {
    this.dir = dir;
    this.path = dir ? join(dir, snapshotName) : null;
    this.map = new Map();
    this.asOf = null;
    this.counts = {};
  }

  get size() {
    let n = 0;
    for (const arr of this.map.values()) n += arr.length;
    return n;
  }

  get keys() {
    return this.map.size;
  }

  clear() {
    this.map = new Map();
    this.counts = {};
  }

  // Fold one raw OSV record into the index. Silently skips affected entries for
  // ecosystems we do not track.
  addRecord(record) {
    if (!record || !record.id || record.withdrawn) return;
    const malicious = record.id.startsWith("MAL-");
    const severity = malicious ? "malicious" : severityOf(record);
    const summary = record.summary || (record.details ? String(record.details).slice(0, 200) : "");
    const reference = bestReference(record);

    for (const aff of record.affected || []) {
      const eco = aff.package && canonicalEcosystem(aff.package.ecosystem);
      if (!eco || !aff.package.name) continue;
      const entry = {
        id: record.id,
        malicious,
        severity,
        summary,
        published: record.published || null,
        modified: record.modified || null,
        reference,
        aliases: Array.isArray(record.aliases) ? record.aliases : [],
        versions: Array.isArray(aff.versions) ? aff.versions : [],
        ranges: Array.isArray(aff.ranges) ? aff.ranges : [],
        rangeType: (aff.ranges && aff.ranges[0] && aff.ranges[0].type) || "SEMVER",
      };
      const key = keyOf(eco, aff.package.name);
      const arr = this.map.get(key);
      if (arr) arr.push(entry);
      else this.map.set(key, [entry]);
      this.counts[eco] = (this.counts[eco] || 0) + 1;
    }
  }

  // Which advisories affect this exact (ecosystem, name, version)? Returns the
  // matched entries split into malicious and vulnerable, or null if the
  // ecosystem is not one we track.
  query(ecosystem, name, version) {
    const eco = canonicalEcosystem(ecosystem);
    if (!eco) return null;
    const arr = this.map.get(keyOf(eco, name)) || [];
    const malicious = [];
    const vulnerabilities = [];
    for (const entry of arr) {
      const hit =
        (entry.versions.length && entry.versions.includes(String(version))) ||
        entry.ranges.some((r) => versionInRange(String(version), r, eco));
      if (!hit) continue;
      const out = {
        id: entry.id,
        aliases: entry.aliases,
        summary: entry.summary,
        published: entry.published,
        modified: entry.modified,
        reference: entry.reference,
      };
      if (entry.malicious) {
        out.source = "ossf/malicious-packages";
        malicious.push(out);
      } else {
        out.severity = entry.severity;
        const fixed = firstFixed(entry, eco);
        if (fixed) out.fixed = fixed;
        vulnerabilities.push(out);
      }
    }
    return { malicious, vulnerabilities };
  }

  toSnapshot() {
    return { as_of: this.asOf, counts: this.counts, entries: Object.fromEntries(this.map) };
  }

  loadSnapshot(snap) {
    this.clear();
    this.asOf = snap.as_of || null;
    this.counts = snap.counts || {};
    for (const [k, v] of Object.entries(snap.entries || {})) this.map.set(k, v);
  }

  async load() {
    if (!this.path) return false;
    try {
      const snap = JSON.parse(await readFile(this.path, "utf8"));
      this.loadSnapshot(snap);
      return true;
    } catch {
      return false; // no snapshot yet; the first sync builds one
    }
  }

  async save() {
    if (!this.path) return;
    await mkdir(this.dir, { recursive: true });
    const tmp = this.path + ".tmp";
    await writeFile(tmp, JSON.stringify(this.toSnapshot()), "utf8");
    await rename(tmp, this.path);
  }
}
