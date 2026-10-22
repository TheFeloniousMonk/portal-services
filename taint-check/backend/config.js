// Configuration for the taint-check backend. Every knob is a TC_* environment
// variable so an operator can tune the service without editing code.
//
// Unlike a rate-limited upstream, the binding constraint here is disk and the
// one-time cost of a mirror sync, not a per-request credit budget: once the OSV
// snapshot is local, a scan is a set of in-memory lookups that spends nothing
// upstream. The querybatch API is only a backstop for versions newer than the
// last sync, and it too is free and unlimited today.

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const str = (v, d) => (v === undefined || v === "" ? d : String(v));
const list = (v, d) => {
  const s = str(v, "");
  return s ? s.split(",").map((x) => x.trim()).filter(Boolean) : d;
};

export const config = Object.freeze({
  service: "taint-check",
  version: "1.1.1",
  port: num(process.env.PORT, 8080),

  // --- mirror -----------------------------------------------------------
  // The OSV bucket serves per-ecosystem all.zip archives over plain HTTPS with
  // no auth. These are the canonical OSV ecosystem names (case-sensitive), which
  // already include the OpenSSF Malicious Packages (MAL-) records.
  osvBucketUrl: str(process.env.TC_OSV_BUCKET_URL, "https://storage.googleapis.com/osv-vulnerabilities"),
  osvApiUrl: str(process.env.TC_OSV_API_URL, "https://api.osv.dev"),
  ecosystems: list(process.env.TC_ECOSYSTEMS, ["npm", "PyPI", "crates.io", "Go"]),
  syncIntervalMs: num(process.env.TC_SYNC_INTERVAL_MS, 6 * 60 * 60 * 1000),
  syncOnStart: bool(process.env.TC_SYNC_ON_START, true),
  fetchDeadlineMs: num(process.env.TC_FETCH_DEADLINE_MS, 120000),
  // The live querybatch backstop for versions newer than the last snapshot.
  // Off by default so a relay never waits on the network; an operator turns it
  // on once they have confirmed egress to api.osv.dev.
  useApiBackstop: bool(process.env.TC_USE_API_BACKSTOP, false),

  // --- store ------------------------------------------------------------
  dataDir: str(process.env.TC_DATA_DIR, "/data"),
  snapshotName: str(process.env.TC_SNAPSHOT_NAME, "osv-index.json"),

  // --- request limits ---------------------------------------------------
  // A lockfile is small; 4 MiB is a very large one. The component cap bounds
  // the per-relay cost so the flat CUPR price stays honest.
  maxBodyBytes: num(process.env.TC_MAX_BODY_BYTES, 4 * 1024 * 1024),
  maxComponents: num(process.env.TC_MAX_COMPONENTS, 5000),
  includeCleanDefault: bool(process.env.TC_INCLUDE_CLEAN, false),

  // --- lockfile.url ------------------------------------------------------
  // A caller may link to a manifest instead of pasting it. Only public code
  // hosts are fetched (fetcher.js holds the allowlist and the address checks).
  // The deadline sits well inside the gateways' relay timeout (10 to 30 s) so a
  // slow host fails the scan as a clean 4xx rather than as a timed-out relay.
  urlFetch: bool(process.env.TC_URL_FETCH, true),
  urlFetchDeadlineMs: num(process.env.TC_URL_FETCH_DEADLINE_MS, 8000),
  urlMaxBytes: num(process.env.TC_URL_MAX_BYTES, 4 * 1024 * 1024),

  // --- heuristics (Tier 2) ---------------------------------------------
  // Typosquat detection is local and always available. install-script and
  // recency signals need registry metadata, so they are only attempted when the
  // operator has enabled registry lookups and the caller passes heuristics:true.
  // Each registry call is deadline-bounded and degrades to "signal absent".
  heuristicsEnabled: bool(process.env.TC_HEURISTICS_ENABLED, true),
  registryLookups: bool(process.env.TC_REGISTRY_LOOKUPS, false),
  registryDeadlineMs: num(process.env.TC_REGISTRY_DEADLINE_MS, 4000),
  // Cap the registry calls a single scan may make, so one lockfile cannot fan
  // out into thousands of upstream requests.
  maxRegistryLookups: num(process.env.TC_MAX_REGISTRY_LOOKUPS, 25),
  recencyDays: num(process.env.TC_RECENCY_DAYS, 14),

  syncOnStartDelayMs: num(process.env.TC_SYNC_START_DELAY_MS, 0),
});
