// The scan itself: given the local index and a list of components, produce the
// per-dependency findings and the summary. This module is pure and async only
// because the optional registry heuristics are; with no registry injected it
// does no I/O, which is what the smoke test exercises.

import { severityRank } from "./osv.js";
import { detectTyposquat } from "./typosquat.js";

const VERDICT_RANK = { malicious: 100, vulnerable: 50, suspicious: 10, clean: 0 };

function newerThan(advisory, sinceMs) {
  const t = Date.parse(advisory.modified || advisory.published || "");
  return Number.isFinite(t) && t > sinceMs;
}

function recommend(verdict, malicious, vulns, signals) {
  if (verdict === "malicious") return "Remove immediately; this exact version is confirmed malware.";
  if (verdict === "vulnerable") {
    const fixed = vulns.map((v) => v.fixed).filter(Boolean).sort()[0];
    return fixed ? "Upgrade to >=" + fixed + "." : "A fix is not yet available; review the advisory.";
  }
  if (verdict === "suspicious") return "Verify this package is intended before trusting it; " + signals.map((s) => s.type).join(", ") + ".";
  return "No known advisory or risk signal for this version.";
}

// components: [{ ecosystem, name, version }]  (already normalized)
// opts: { since, minSeverity, categories, heuristics, includeClean,
//         registry, registryDeadlineMs, recencyDays, maxRegistryLookups, now }
export async function scan(index, components, opts = {}) {
  const sinceMs = opts.since ? Date.parse(opts.since) : null;
  const useSince = Number.isFinite(sinceMs);
  const floor = severityRank(opts.minSeverity || "unknown");
  const categories = new Set(opts.categories || ["malicious", "vulnerable", "suspicious"]);
  // Heuristics are point-in-time, not deltas, so they are suppressed in the
  // since/delta mode where a caller is asking only "what changed".
  const wantHeuristics = Boolean(opts.heuristics) && !useSince;
  const now = opts.now || Date.now();

  const findings = [];
  const unresolved = [];
  const registryQueue = [];

  for (const c of components) {
    const q = index.query(c.ecosystem, c.name, c.version);
    if (q === null) {
      unresolved.push({ entry: c.ecosystem + ":" + c.name + "@" + c.version, reason: "untracked ecosystem" });
      continue;
    }

    let malicious = q.malicious;
    let vulns = q.vulnerabilities.filter((v) => severityRank(v.severity) >= floor);
    if (useSince) {
      malicious = malicious.filter((a) => newerThan(a, sinceMs));
      vulns = vulns.filter((a) => newerThan(a, sinceMs));
    }

    const finding = {
      ecosystem: c.ecosystem,
      name: c.name,
      version: c.version,
      verdict: "clean",
      malicious,
      vulnerabilities: vulns,
      signals: [],
    };

    // Typosquat is local; queue registry work for a second pass so the network
    // calls can run in parallel rather than serially per component.
    if (wantHeuristics && !malicious.length) {
      const ts = detectTyposquat(c.ecosystem, c.name);
      if (ts) finding.signals.push(ts);
      if (opts.registry && registryQueue.length < (opts.maxRegistryLookups || 0)) {
        registryQueue.push(finding);
      }
    }

    findings.push(finding);
  }

  if (registryQueue.length && opts.registry) {
    const results = await Promise.all(
      registryQueue.map((f) =>
        opts
          .registry({ ecosystem: f.ecosystem, name: f.name, version: f.version }, {
            deadlineMs: opts.registryDeadlineMs,
            recencyDays: opts.recencyDays,
            now,
          })
          .catch(() => [])
      )
    );
    results.forEach((sigs, i) => {
      for (const s of sigs) registryQueue[i].signals.push(s);
    });
  }

  // Assign verdicts now that all signals are in.
  for (const f of findings) {
    if (f.malicious.length) f.verdict = "malicious";
    else if (f.vulnerabilities.length) f.verdict = "vulnerable";
    else if (f.signals.length) f.verdict = "suspicious";
    else f.verdict = "clean";
    f.recommendation = recommend(f.verdict, f.malicious, f.vulnerabilities, f.signals);
  }

  const summary = { malicious: 0, vulnerable: 0, suspicious: 0, clean: 0 };
  let highestRank = 0;
  let highest = "clean";
  for (const f of findings) {
    summary[f.verdict]++;
    let rank = VERDICT_RANK[f.verdict];
    let label = f.verdict;
    if (f.verdict === "vulnerable") {
      const top = f.vulnerabilities.reduce((m, v) => Math.max(m, severityRank(v.severity)), 0);
      rank = VERDICT_RANK.vulnerable + top;
      label = f.vulnerabilities.map((v) => v.severity).sort((a, b) => severityRank(b) - severityRank(a))[0] || "vulnerable";
    }
    if (rank > highestRank) {
      highestRank = rank;
      highest = f.verdict === "malicious" ? "malicious" : label;
    }
  }

  const visible = findings.filter((f) => {
    if (f.verdict === "clean") return Boolean(opts.includeClean);
    return categories.has(f.verdict);
  });

  return {
    summary: {
      ...summary,
      highest,
      action_required: summary.malicious > 0 || summary.vulnerable > 0,
    },
    findings: visible,
    unresolved,
    components_scanned: components.length,
    mode: useSince ? "delta" : "full",
  };
}
