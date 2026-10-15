// Lockfile parsers: turn a raw manifest into a flat list of pinned components,
// { ecosystem, name, version }. Only pinned versions are scanned; an unpinned or
// unparseable line goes to `unresolved` with a reason rather than being dropped
// silently, so a caller can see coverage gaps.
//
// These parsers are deliberately format-specific and line-oriented where the
// format is not JSON. They read only names and versions; they never follow or
// fetch any URL, path, or VCS reference embedded in the manifest. That is what
// keeps the service a chosen-source monitor with no request forgery surface.

const FORMAT_ECOSYSTEM = {
  "package.json": "npm",
  "package-lock.json": "npm",
  "pnpm-lock.yaml": "npm",
  "yarn.lock": "npm",
  "requirements.txt": "PyPI",
  "poetry.lock": "PyPI",
  "uv.lock": "PyPI",
  "pipfile.lock": "PyPI",
  "cargo.lock": "crates.io",
  "go.sum": "Go",
};

export const SUPPORTED_FORMATS = Object.keys(FORMAT_ECOSYSTEM);

export function ecosystemForFormat(format) {
  return FORMAT_ECOSYSTEM[String(format || "").toLowerCase()] || null;
}

function dedupe(components) {
  const seen = new Set();
  const out = [];
  for (const c of components) {
    if (!c.name || !c.version) continue;
    const k = c.ecosystem + "\0" + c.name + "\0" + c.version;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

// --- npm -------------------------------------------------------------------

// package.json names what a project accepts, usually as ranges ("^1.2.0"), not
// what is installed. Only an exact version is scanned; a range would have to be
// guessed down to one version, and scanning its lower bound reports advisories
// the installed copy may already be past. Ranges go to `unresolved`, pointing
// the caller at the lockfile, which records the versions actually installed.
const EXACT_NPM_VERSION = /^[=v]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;

function parsePackageJson(text, eco) {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a package.json object");
  const components = [];
  const unresolved = [];
  for (const section of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const deps = doc[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps)) {
      const m = typeof spec === "string" ? spec.trim().match(EXACT_NPM_VERSION) : null;
      if (m) components.push({ ecosystem: eco, name, version: m[1] });
      else unresolved.push({ entry: name + "@" + spec, reason: "version range in package.json; link the package-lock.json to scan installed versions" });
    }
  }
  return { components, unresolved };
}

function parsePackageLock(text, eco) {
  const doc = JSON.parse(text);
  const components = [];
  const unresolved = [];
  // v2/v3: a flat "packages" map keyed by install path.
  if (doc.packages && typeof doc.packages === "object") {
    for (const [path, info] of Object.entries(doc.packages)) {
      if (!path) continue; // "" is the root project
      const name = path.split("node_modules/").pop();
      if (info && info.version) components.push({ ecosystem: eco, name, version: info.version });
      else unresolved.push({ entry: path, reason: "no pinned version" });
    }
  }
  // v1 (or as a fallback): a nested "dependencies" tree.
  if (!components.length && doc.dependencies) {
    const walk = (deps) => {
      for (const [name, info] of Object.entries(deps)) {
        if (info && info.version) components.push({ ecosystem: eco, name, version: info.version });
        if (info && info.dependencies) walk(info.dependencies);
      }
    };
    walk(doc.dependencies);
  }
  return { components, unresolved };
}

function parseYarnLock(text, eco) {
  const components = [];
  const unresolved = [];
  const blocks = text.split(/\n(?=\S)/); // each block starts at column 0
  for (const block of blocks) {
    const header = block.split("\n")[0];
    if (!header || header.startsWith("#") || header.startsWith("__metadata")) continue;
    const vMatch = block.match(/\n\s+version:?\s+"?([^"\n]+)"?/);
    if (!vMatch) continue;
    // The header is one or more comma-separated specifiers like "foo@^1.0.0".
    const first = header.split(",")[0].trim().replace(/:$/, "").replace(/^"|"$/g, "");
    const at = first.lastIndexOf("@");
    const name = at > 0 ? first.slice(0, at) : first;
    if (name) components.push({ ecosystem: eco, name, version: vMatch[1].trim() });
  }
  return { components, unresolved };
}

function parsePnpmLock(text, eco) {
  const components = [];
  const unresolved = [];
  // pnpm keys look like "/foo@1.2.3:" (v6) or "foo@1.2.3:" (v9), sometimes with
  // a peer-suffix in parentheses. Match the name@version prefix on package keys.
  const re = /^\s{2,4}\/?((?:@[^/@\s]+\/)?[^@/\s()]+)@([0-9][^:\s(]*)[:(]/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    components.push({ ecosystem: eco, name: m[1], version: m[2] });
  }
  return { components, unresolved };
}

// --- PyPI ------------------------------------------------------------------

function parseRequirements(text, eco) {
  const components = [];
  const unresolved = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("-")) {
      unresolved.push({ entry: line, reason: "option or include line" });
      continue;
    }
    // name[extras]==1.2.3 ; marker  -> only "==" pins a version to scan.
    const spec = line.split(";")[0].trim();
    const m = spec.match(/^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*==\s*([^\s]+)$/);
    if (m) components.push({ ecosystem: eco, name: m[1], version: m[2] });
    else unresolved.push({ entry: line, reason: "not pinned with ==" });
  }
  return { components, unresolved };
}

function parsePipfileLock(text, eco) {
  const doc = JSON.parse(text);
  const components = [];
  const unresolved = [];
  for (const section of ["default", "develop"]) {
    const deps = doc[section] || {};
    for (const [name, info] of Object.entries(deps)) {
      const v = info && typeof info.version === "string" ? info.version.replace(/^==/, "") : null;
      if (v) components.push({ ecosystem: eco, name, version: v });
      else unresolved.push({ entry: name, reason: "no == pin" });
    }
  }
  return { components, unresolved };
}

// TOML [[package]] blocks (poetry.lock, uv.lock, Cargo.lock share this shape).
function parseTomlPackages(text, eco) {
  const components = [];
  const unresolved = [];
  const blocks = text.split(/\[\[package\]\]/).slice(1);
  for (const block of blocks) {
    const head = block.split(/\n\[/)[0]; // stop at the next table header
    const name = head.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const version = head.match(/^\s*version\s*=\s*"([^"]+)"/m);
    if (name && version) components.push({ ecosystem: eco, name: name[1], version: version[1] });
    else if (name) unresolved.push({ entry: name[1], reason: "no version in package block" });
  }
  return { components, unresolved };
}

// --- Go --------------------------------------------------------------------

function parseGoSum(text, eco) {
  const components = [];
  const unresolved = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[0];
    // Each module appears twice: "v1.2.3" and "v1.2.3/go.mod". Keep the module
    // line, drop the /go.mod duplicate; dedupe handles the rest.
    let version = parts[1];
    if (version.endsWith("/go.mod")) version = version.slice(0, -"/go.mod".length);
    if (name && version.startsWith("v")) components.push({ ecosystem: eco, name, version });
  }
  return { components, unresolved };
}

const PARSERS = {
  "package.json": parsePackageJson,
  "package-lock.json": parsePackageLock,
  "yarn.lock": parseYarnLock,
  "pnpm-lock.yaml": parsePnpmLock,
  "requirements.txt": parseRequirements,
  "pipfile.lock": parsePipfileLock,
  "poetry.lock": parseTomlPackages,
  "uv.lock": parseTomlPackages,
  "cargo.lock": parseTomlPackages,
  "go.sum": parseGoSum,
};

export function parseLockfile(format, content) {
  const key = String(format || "").toLowerCase();
  const parser = PARSERS[key];
  const eco = FORMAT_ECOSYSTEM[key];
  if (!parser || !eco) {
    const err = new Error("unsupported format: " + format);
    err.code = "unsupported_format";
    throw err;
  }
  let out;
  try {
    out = parser(content, eco);
  } catch (e) {
    const err = new Error("could not parse " + format + " content");
    err.code = "unparseable_lockfile";
    throw err;
  }
  return { ecosystem: eco, components: dedupe(out.components), unresolved: out.unresolved };
}
