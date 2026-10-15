// Smoke test. No network access: the OSV index is built from hand-written
// fixtures, written to a snapshot, and the server is started with syncing
// disabled so it serves entirely from that snapshot.
//
// Run with: npm test

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { OsvIndex, compareSemver, compareLoose, canonicalEcosystem } from "../osv.js";
import { parseLockfile } from "../parsers.js";
import { detectTyposquat, boundedEditDistance } from "../typosquat.js";
import { scan } from "../scan.js";
import { iterZipEntries } from "../unzip.js";
import { resolveSourceUrl, isPublicAddress, formatFromFilename, fetchManifest } from "../fetcher.js";
import { buildRequest, escapeGatewayPhrases } from "../server.js";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (err && err.message));
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log("  ok   " + name);
  } catch (err) {
    failures++;
    console.log("  FAIL " + name + "\n       " + (err && err.message));
  }
}

// --- fixtures --------------------------------------------------------------

const MINIMIST = {
  id: "GHSA-vh95-rmgr-6w4m",
  aliases: ["CVE-2021-44906"],
  summary: "Prototype pollution in minimist",
  published: "2022-03-17T00:00:00Z",
  modified: "2023-01-01T00:00:00Z",
  database_specific: { severity: "CRITICAL" },
  affected: [{ package: { ecosystem: "npm", name: "minimist" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.6" }] }] }],
  references: [{ type: "ADVISORY", url: "https://github.com/advisories/GHSA-vh95-rmgr-6w4m" }],
};
const EVIL = {
  id: "MAL-2024-0001",
  summary: "Malicious code in evil-pkg",
  published: "2024-06-01T00:00:00Z",
  modified: "2024-06-01T00:00:00Z",
  affected: [{ package: { ecosystem: "npm", name: "evil-pkg" }, versions: ["2.4.1"] }],
};

// Real OSV wording: a summary that carries a phrase gateways treat as a failure.
const VM2 = {
  id: "GHSA-test-vm2",
  summary: "vm2 sandbox allows Timeout bypass and Connection Reset of the host",
  published: "2023-01-01T00:00:00Z",
  modified: "2023-01-01T00:00:00Z",
  database_specific: { severity: "HIGH" },
  affected: [{ package: { ecosystem: "npm", name: "vm2" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "3.9.18" }] }] }],
};

function buildIndex() {
  const idx = new OsvIndex(null, null);
  idx.addRecord(MINIMIST);
  idx.addRecord(EVIL);
  idx.addRecord(VM2);
  idx.asOf = "2026-09-20T06:00:00Z";
  return idx;
}

// --- version comparison ----------------------------------------------------

console.log("versions");
test("semver orders release and pre-release", () => {
  assert.ok(compareSemver("1.2.0", "1.2.6") < 0);
  assert.equal(compareSemver("1.2.6", "1.2.6"), 0);
  assert.ok(compareSemver("2.0.0", "1.9.9") > 0);
  assert.ok(compareSemver("1.0.0-rc1", "1.0.0") < 0);
  assert.ok(compareSemver("v1.2.3", "1.2.3") === 0);
});
test("loose PyPI comparison ranks a release above its pre-release", () => {
  assert.ok(compareLoose("2.0.0", "2.0.0rc1") > 0);
  assert.ok(compareLoose("1.9.0", "1.10.0") < 0);
});
test("ecosystem aliases canonicalize", () => {
  assert.equal(canonicalEcosystem("pypi"), "PyPI");
  assert.equal(canonicalEcosystem("crates"), "crates.io");
  assert.equal(canonicalEcosystem("golang"), "Go");
  assert.equal(canonicalEcosystem("nope"), null);
});

// --- index -----------------------------------------------------------------

console.log("index");
test("a version inside the range is vulnerable and reports the fix", () => {
  const q = buildIndex().query("npm", "minimist", "1.2.0");
  assert.equal(q.vulnerabilities.length, 1);
  assert.equal(q.vulnerabilities[0].severity, "critical");
  assert.equal(q.vulnerabilities[0].fixed, "1.2.6");
});
test("the fixed version is not vulnerable", () => {
  assert.equal(buildIndex().query("npm", "minimist", "1.2.6").vulnerabilities.length, 0);
});
test("an exact malicious version matches and outranks severity", () => {
  const q = buildIndex().query("npm", "evil-pkg", "2.4.1");
  assert.equal(q.malicious.length, 1);
  assert.equal(q.malicious[0].id, "MAL-2024-0001");
  assert.equal(buildIndex().query("npm", "evil-pkg", "2.4.0").malicious.length, 0);
});
test("an untracked ecosystem returns null", () => {
  assert.equal(buildIndex().query("Maven", "org.x:y", "1.0"), null);
});
test("a snapshot round-trips", () => {
  const a = buildIndex();
  const b = new OsvIndex(null, null);
  b.loadSnapshot(a.toSnapshot());
  assert.equal(b.query("npm", "minimist", "1.2.0").vulnerabilities.length, 1);
  assert.equal(b.asOf, a.asOf);
});

// --- parsers ---------------------------------------------------------------

console.log("parsers");
test("package-lock v3 packages map", () => {
  const text = JSON.stringify({
    lockfileVersion: 3,
    packages: { "": { name: "root" }, "node_modules/minimist": { version: "1.2.0" }, "node_modules/evil-pkg": { version: "2.4.1" } },
  });
  const { components, ecosystem } = parseLockfile("package-lock.json", text);
  assert.equal(ecosystem, "npm");
  const names = components.map((c) => c.name + "@" + c.version).sort();
  assert.deepEqual(names, ["evil-pkg@2.4.1", "minimist@1.2.0"]);
});
test("requirements.txt keeps == pins and flags the rest", () => {
  const { components, unresolved } = parseLockfile("requirements.txt", "requests==2.31.0\n# c\nflask==2.0.1\nunpinned\n-r other.txt\n");
  assert.deepEqual(components.map((c) => c.name).sort(), ["flask", "requests"]);
  assert.equal(unresolved.length, 2);
});
test("go.sum dedupes the go.mod line", () => {
  const { components } = parseLockfile("go.sum", "github.com/foo/bar v1.2.3 h1:aaa=\ngithub.com/foo/bar v1.2.3/go.mod h1:bbb=\n");
  assert.equal(components.length, 1);
  assert.equal(components[0].name, "github.com/foo/bar");
  assert.equal(components[0].version, "v1.2.3");
});
test("Cargo.lock TOML package blocks", () => {
  const { components, ecosystem } = parseLockfile("Cargo.lock", '[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "tokio"\nversion = "1.35.1"\n');
  assert.equal(ecosystem, "crates.io");
  assert.deepEqual(components.map((c) => c.name).sort(), ["serde", "tokio"]);
});
test("an unsupported format throws a coded error", () => {
  assert.throws(() => parseLockfile("Gemfile.lock", "x"), (e) => e.code === "unsupported_format");
});
test("package.json scans exact pins and lists ranges as unresolved", () => {
  const text = JSON.stringify({
    dependencies: { minimist: "1.2.0", express: "^4.18.2", local: "file:../x" },
    devDependencies: { "evil-pkg": "=2.4.1", jest: "~29.0.0" },
    peerDependencies: { react: "18.2.0" },
  });
  const { components, unresolved, ecosystem } = parseLockfile("package.json", text);
  assert.equal(ecosystem, "npm");
  assert.deepEqual(components.map((c) => c.name + "@" + c.version).sort(), ["evil-pkg@2.4.1", "minimist@1.2.0"]);
  assert.deepEqual(unresolved.map((u) => u.entry).sort(), ["express@^4.18.2", "jest@~29.0.0", "local@file:../x"]);
  assert.match(unresolved[0].reason, /package-lock\.json/);
});

// --- gateway phrases -------------------------------------------------------

console.log("gateway phrases");
test("phrases are broken in the raw JSON and decode back unchanged", () => {
  const value = { s: "A TIMEOUT, a gateway timeout, Connection reset; block not found. Plain text stays." };
  const raw = escapeGatewayPhrases(JSON.stringify(value));
  for (const p of ["timeout", "gateway timeout", "connection reset", "block not found"]) {
    assert.ok(!raw.toLowerCase().includes(p), "raw still contains " + p);
  }
  assert.deepEqual(JSON.parse(raw), value);
});

// --- lockfile.url ----------------------------------------------------------

console.log("lockfile.url");
const refused = (input) => {
  try {
    resolveSourceUrl(input);
  } catch (e) {
    return e.code;
  }
  return "accepted";
};
test("a github.com blob link is rewritten to the raw file", () => {
  const r = resolveSourceUrl("https://github.com/acme/app/blob/main/web/package-lock.json#L10");
  assert.equal(r.url, "https://raw.githubusercontent.com/acme/app/main/web/package-lock.json");
  assert.equal(r.filename, "package-lock.json");
});
test("gitlab and bitbucket page links are rewritten to raw", () => {
  assert.equal(resolveSourceUrl("https://gitlab.com/g/sub/p/-/blob/main/go.sum").url, "https://gitlab.com/g/sub/p/-/raw/main/go.sum");
  assert.equal(resolveSourceUrl("https://bitbucket.org/w/r/src/main/Cargo.lock").url, "https://bitbucket.org/w/r/raw/main/Cargo.lock");
});
test("raw and gist links are accepted as they are", () => {
  assert.equal(refused("https://raw.githubusercontent.com/acme/app/main/package.json"), "accepted");
  assert.equal(refused("https://gist.githubusercontent.com/u/abc123/raw/def/requirements.txt"), "accepted");
});
test("anything off the allowlist is refused before a socket opens", () => {
  for (const bad of [
    "http://raw.githubusercontent.com/a/b/main/package.json", // not https
    "https://example.com/package.json",
    "https://raw.githubusercontent.com.evil.example/a/b/main/package.json",
    "https://127.0.0.1/a/b/main/package.json",
    "https://localhost/package.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/package.json",
    "https://user:pw@raw.githubusercontent.com/a/b/main/package.json",
    "https://raw.githubusercontent.com:8443/a/b/main/package.json",
    "https://github.com/acme/app", // a repo page, not a file
    "https://gitlab.com/g/p/-/tree/main", // a directory listing
    "file:///etc/passwd",
    "not a url",
  ]) {
    assert.equal(refused(bad), "url_not_allowed", bad);
  }
});
test("private, loopback, link-local and mapped addresses are not public", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.5", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "ff02::1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["185.199.108.133", "8.8.8.8", "2606:50c0:8000::154", "::ffff:185.199.108.133"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});
test("the format is inferred from the filename", () => {
  assert.equal(formatFromFilename("package-lock.json"), "package-lock.json");
  assert.equal(formatFromFilename("npm-shrinkwrap.json"), "package-lock.json");
  assert.equal(formatFromFilename("Cargo.lock"), "cargo.lock");
  assert.equal(formatFromFilename("requirements-dev.txt"), "requirements.txt");
  assert.equal(formatFromFilename("Gemfile.lock"), null);
});
const fakeFetch = (content, filename) => async () => ({ content, url: "https://raw.githubusercontent.com/a/b/main/" + filename, filename });
await testAsync("a linked lockfile is fetched, its format inferred, and parsed", async () => {
  const lock = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/minimist": { version: "1.2.0" } } });
  const r = await buildRequest({ lockfile: { url: "https://github.com/a/b/blob/main/package-lock.json" } }, fakeFetch(lock, "package-lock.json"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.format, "package-lock.json");
  assert.equal(r.source.filename, "package-lock.json");
  assert.equal(r.components[0].name, "minimist");
});
await testAsync("a fetch failure keeps its code for the status mapping", async () => {
  const failing = async () => {
    throw Object.assign(new Error("the link returned HTTP 404"), { code: "source_not_found" });
  };
  const r = await buildRequest({ lockfile: { url: "https://github.com/a/b/blob/main/go.sum" } }, failing);
  assert.equal(r.code, "source_not_found");
});
await testAsync("an unknown filename without a format is refused", async () => {
  const r = await buildRequest({ lockfile: { url: "https://github.com/a/b/blob/main/deps.txt" } }, fakeFetch("x", "deps.txt"));
  assert.equal(r.code, "unsupported_format");
});

// --- typosquat -------------------------------------------------------------

console.log("typosquat");
test("bounded edit distance bails past the cap", () => {
  assert.equal(boundedEditDistance("colars", "colors", 1), 1);
  assert.equal(boundedEditDistance("abcdef", "uvwxyz", 1), Infinity);
});
test("a one-edit name near a popular package is flagged, the real one is not", () => {
  assert.ok(detectTyposquat("npm", "colars"));
  assert.equal(detectTyposquat("npm", "colors"), null);
  assert.equal(detectTyposquat("npm", "my-unique-app-xyz"), null);
});

// --- scan ------------------------------------------------------------------

console.log("scan");
await testAsync("a vulnerable component is graded vulnerable", async () => {
  const r = await scan(buildIndex(), [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], {});
  assert.equal(r.summary.vulnerable, 1);
  assert.equal(r.findings[0].verdict, "vulnerable");
  assert.equal(r.summary.action_required, true);
});
await testAsync("a malicious component outranks everything", async () => {
  const r = await scan(buildIndex(), [{ ecosystem: "npm", name: "evil-pkg", version: "2.4.1" }], {});
  assert.equal(r.summary.malicious, 1);
  assert.equal(r.summary.highest, "malicious");
});
await testAsync("typosquat alone is suspicious, only with heuristics on", async () => {
  const clean = await scan(buildIndex(), [{ ecosystem: "npm", name: "colars", version: "1.0.0" }], {});
  assert.equal(clean.findings.length, 0); // clean is hidden by default
  const heur = await scan(buildIndex(), [{ ecosystem: "npm", name: "colars", version: "1.0.0" }], { heuristics: true });
  assert.equal(heur.findings[0].verdict, "suspicious");
  assert.equal(heur.findings[0].signals[0].type, "typosquat");
});
await testAsync("clean components appear only when asked for", async () => {
  const r = await scan(buildIndex(), [{ ecosystem: "npm", name: "lodash", version: "4.17.21" }], { includeClean: true });
  assert.equal(r.summary.clean, 1);
  assert.equal(r.findings[0].verdict, "clean");
});
await testAsync("since delta mode filters advisories by modified time", async () => {
  const before = await scan(buildIndex(), [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], { since: "2022-01-01T00:00:00Z" });
  assert.equal(before.mode, "delta");
  assert.equal(before.summary.vulnerable, 1);
  const after = await scan(buildIndex(), [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], { since: "2024-01-01T00:00:00Z" });
  assert.equal(after.summary.vulnerable, 0);
});
await testAsync("min_severity filters below the floor", async () => {
  const r = await scan(buildIndex(), [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], { minSeverity: "critical" });
  assert.equal(r.summary.vulnerable, 1); // CRITICAL passes a critical floor
  const none = await scan(buildIndex(), [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], { minSeverity: "critical", includeClean: true });
  assert.equal(none.findings[0].verdict, "vulnerable");
});

// --- unzip -----------------------------------------------------------------

console.log("unzip");
test("reads a stored-method zip the way the OSV dumps are laid out", () => {
  const buf = buildStoredZip([{ name: "MAL-2024-0001.json", data: Buffer.from(JSON.stringify(EVIL)) }]);
  const entries = [...iterZipEntries(buf)];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "MAL-2024-0001.json");
  assert.equal(JSON.parse(entries[0].data.toString("utf8")).id, "MAL-2024-0001");
});

// A minimal stored (uncompressed) ZIP writer, only for the test. The reader
// does not verify CRCs, so they are left zero.
function buildStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const data = f.data;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const local = Buffer.concat([lh, name, data]);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10); // stored
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([cd, name]));

    locals.push(local);
    offset += local.length;
  }
  const cdBuf = Buffer.concat(centrals);
  const localBuf = Buffer.concat(locals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, cdBuf, eocd]);
}

// --- HTTP contract ---------------------------------------------------------

async function withServer(fn) {
  const dir = await mkdtemp(join(tmpdir(), "taint-check-"));
  const snap = buildIndex().toSnapshot();
  await writeFile(join(dir, "osv-index.json"), JSON.stringify(snap), "utf8");
  const port = 8200 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    env: { ...process.env, PORT: String(port), TC_DATA_DIR: dir, TC_SYNC_ON_START: "false", TC_REGISTRY_LOOKUPS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("server did not start in 10s")), 10000);
      child.stdout.on("data", (buf) => {
        if (String(buf).includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error("server exited early with code " + code));
      });
    });
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

console.log("http");
await withServer(async (base) => {
  const seen = [];
  const call = async (path, init) => {
    const res = await fetch(base + path, init);
    const text = await res.text();
    seen.push({ path, text });
    return { res, text, json: JSON.parse(text) };
  };
  const post = (body) => call("/v1/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  await testAsync("root ping answers 2xx for the RelayMiner", async () => {
    const { res, json } = await call("/");
    assert.equal(res.status, 200);
    assert.equal(json.service, "taint-check");
  });
  await testAsync("HEAD on the root is accepted", async () => {
    const res = await fetch(base + "/", { method: "HEAD" });
    assert.equal(res.status, 200);
  });
  await testAsync("identity probe pins the service id", async () => {
    const { json } = await call("/v1/version");
    assert.match(json.service, /^taint-check$/);
  });
  await testAsync("readiness is ok because a snapshot is loaded", async () => {
    const { res, json } = await call("/healthz");
    assert.equal(res.status, 200);
    assert.equal(json.status, "ok");
    assert.ok(json.entries > 0);
  });
  await testAsync("capabilities lists the supported formats and limits", async () => {
    const { json } = await call("/v1/capabilities");
    assert.ok(json.formats.includes("package-lock.json"));
    assert.ok(json.formats.includes("package.json"));
    assert.ok(json.limits.max_components > 0);
    assert.equal(json.ecosystems.includes("npm"), true);
    assert.equal(json.url.enabled, true);
    assert.ok(json.url.hosts.includes("raw.githubusercontent.com"));
  });
  await testAsync("a link off the allowlist is a 400, never fetched", async () => {
    const { res, json } = await post({ lockfile: { url: "https://169.254.169.254/latest/meta-data" } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "url_not_allowed");
  });
  await testAsync("a url and pasted content together is a 400", async () => {
    const { res } = await post({ lockfile: { url: "https://github.com/a/b/blob/main/go.sum", content: "x", format: "go.sum" } });
    assert.equal(res.status, 400);
  });
  await testAsync("a top-level url is a 400 that says where the link goes", async () => {
    const { res, json } = await post({ url: "https://github.com/a/b/blob/main/go.sum" });
    assert.equal(res.status, 400);
    assert.match(json.error.message, /lockfile/);
  });
  await testAsync("an empty components array is a 400, not an empty 200", async () => {
    const { res, json } = await post({ components: [] });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "nothing_to_scan");
  });
  await testAsync("a package.json of ranges only is a 400 that lists why", async () => {
    const content = JSON.stringify({ dependencies: { express: "^4.18.2", lodash: "~4.17.0" } });
    const { res, json } = await post({ lockfile: { format: "package.json", content } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "nothing_to_scan");
    assert.equal(json.error.details.unresolved_total, 2);
  });
  await testAsync("the functional probe returns a vulnerable verdict for minimist 1.2.0", async () => {
    const { res, json } = await post({ components: [{ ecosystem: "npm", name: "minimist", version: "1.2.0" }], options: { heuristics: false } });
    assert.equal(res.status, 200);
    assert.equal(json.findings[0].verdict, "vulnerable");
    assert.equal(typeof json.data_as_of, "string");
  });
  await testAsync("a lockfile upload is parsed and scanned", async () => {
    const content = JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/minimist": { version: "1.2.0" }, "node_modules/evil-pkg": { version: "2.4.1" } } });
    const { json } = await post({ lockfile: { format: "package-lock.json", content } });
    assert.equal(json.request.format, "package-lock.json");
    assert.equal(json.summary.malicious, 1);
    assert.equal(json.summary.vulnerable, 1);
    assert.equal(json.summary.highest, "malicious");
  });
  await testAsync("an advisory summary with a gateway phrase reaches the client intact but not raw", async () => {
    const { res, text, json } = await post({ components: [{ ecosystem: "npm", name: "vm2", version: "3.9.0" }] });
    assert.equal(res.status, 200);
    assert.ok(!text.slice(0, 2048).toLowerCase().includes("timeout"), "raw body carries 'timeout'");
    assert.ok(!text.toLowerCase().includes("connection reset"), "raw body carries 'connection reset'");
    assert.equal(json.findings[0].vulnerabilities[0].summary, VM2.summary);
  });
  await testAsync("an unsupported lockfile format is a coded 400", async () => {
    const { res, json } = await post({ lockfile: { format: "Gemfile.lock", content: "x" } });
    assert.equal(res.status, 400);
    assert.equal(json.error.code, "unsupported_format");
  });
  await testAsync("a GET on the scan path is refused as JSON", async () => {
    const { res, json } = await call("/v1/scan");
    assert.equal(res.status, 405);
    assert.ok(json.error);
  });
  await testAsync("an unknown path is a JSON 404", async () => {
    const { res, json } = await call("/v1/nope");
    assert.equal(res.status, 404);
    assert.equal(json.error.code, "not_found");
  });
  await testAsync("every body starts with a brace and none is empty", async () => {
    for (const { path, text } of seen) {
      assert.ok(text.length > 0, path + " empty");
      assert.equal(text[0], "{", path + " did not start with a brace");
    }
  });
});

// Opt-in: one real fetch from GitHub, to confirm the network path end to end.
// Off by default so the suite stays offline.
if (process.env.TC_LIVE_FETCH === "1") {
  console.log("live fetch");
  await testAsync("a real github.com blob link fetches the raw package.json", async () => {
    const out = await fetchManifest("https://github.com/npm/cli/blob/latest/package.json", {
      maxBytes: 4 * 1024 * 1024,
      deadlineMs: 10000,
      userAgent: "taint-check-test",
    });
    assert.equal(out.filename, "package.json");
    assert.equal(JSON.parse(out.content).name, "npm");
  });
}

console.log(failures ? `\n${failures} test(s) failed` : "\nall tests passed");
process.exit(failures ? 1 : 0);
