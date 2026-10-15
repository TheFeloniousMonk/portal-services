// Registry metadata client for the two Tier-2 signals that need it:
//   - install_script: the version declares an npm install/pre/post script, a
//     classic poisoning vector;
//   - recent_publish: this exact version was published within the recency
//     window, when a compromised release is most likely still live.
//
// Every call is deadline-bounded and never throws; on any failure the signal is
// simply absent. Registry URLs are always built from (ecosystem, name) — never
// from anything in the caller's lockfile — so this stays a chosen-source lookup.

const UA = "taint-check/1.0 (+https://agentdata.network/taint-check)";

async function getJson(url, deadlineMs) {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": UA },
      signal: AbortSignal.timeout(deadlineMs),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function daysBetween(a, b) {
  return Math.abs(a - b) / (24 * 60 * 60 * 1000);
}

// Returns an array of signal objects for one component, possibly empty.
export async function registrySignals(component, opts) {
  const { deadlineMs, recencyDays, now = Date.now() } = opts;
  const { ecosystem, name, version } = component;
  const signals = [];

  if (ecosystem === "npm") {
    const doc = await getJson("https://registry.npmjs.org/" + encodeURIComponent(name).replace("%40", "@"), deadlineMs);
    if (!doc) return signals;
    const v = doc.versions && doc.versions[version];
    const scripts = v && v.scripts ? v.scripts : {};
    if (scripts.install || scripts.preinstall || scripts.postinstall) {
      signals.push({ type: "install_script", weight: "medium", detail: "Declares an npm install/pre/post script" });
    }
    const published = doc.time && doc.time[version] ? Date.parse(doc.time[version]) : null;
    if (published && daysBetween(now, published) <= recencyDays) {
      signals.push({ type: "recent_publish", weight: "low", detail: "This version was published within the last " + recencyDays + " days" });
    }
    return signals;
  }

  if (ecosystem === "PyPI") {
    const doc = await getJson("https://pypi.org/pypi/" + encodeURIComponent(name) + "/" + encodeURIComponent(version) + "/json", deadlineMs);
    if (!doc) return signals;
    const files = Array.isArray(doc.urls) ? doc.urls : [];
    const uploaded = files.map((f) => Date.parse(f.upload_time_iso_8601 || f.upload_time)).filter(Number.isFinite).sort();
    if (uploaded.length && daysBetween(now, uploaded[0]) <= recencyDays) {
      signals.push({ type: "recent_publish", weight: "low", detail: "This release was uploaded within the last " + recencyDays + " days" });
    }
    return signals;
  }

  if (ecosystem === "crates.io") {
    const doc = await getJson("https://crates.io/api/v1/crates/" + encodeURIComponent(name), deadlineMs);
    if (!doc || !Array.isArray(doc.versions)) return signals;
    const rec = doc.versions.find((x) => x && x.num === version);
    const created = rec && rec.created_at ? Date.parse(rec.created_at) : null;
    if (created && daysBetween(now, created) <= recencyDays) {
      signals.push({ type: "recent_publish", weight: "low", detail: "This version was published within the last " + recencyDays + " days" });
    }
    return signals;
  }

  if (ecosystem === "Go") {
    const doc = await getJson("https://proxy.golang.org/" + name.toLowerCase() + "/@v/" + version + ".info", deadlineMs);
    const t = doc && doc.Time ? Date.parse(doc.Time) : null;
    if (t && daysBetween(now, t) <= recencyDays) {
      signals.push({ type: "recent_publish", weight: "low", detail: "This version was published within the last " + recencyDays + " days" });
    }
    return signals;
  }

  return signals;
}
