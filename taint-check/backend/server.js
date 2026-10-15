// taint-check backend for Pocket Network.
//
// HTTP contract (every response is a JSON object, including errors; see the
// Skill's references/design-rules.md):
//   GET|HEAD /            -> {service, status}          RelayMiner reachability ping
//   GET  /healthz         -> {status}                   readiness (ok once a snapshot is loaded)
//   GET  /v1/version      -> {service, version}         identity probe
//   GET  /v1/capabilities -> formats, limits, sync, heuristics
//   GET  /v1/openapi.json -> the OpenAPI document
//   POST /v1/scan         -> {summary, findings, unresolved, data_as_of, ...}
//
// Inputs arrive in the POST body, never the query string. Every scan is answered
// from the local OSV index. A relay waits on the network only to fetch a
// lockfile.url (public code hosts only; see fetcher.js), or when the operator
// has enabled the optional registry heuristics or the API backstop.

import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { config } from "./config.js";
import { OsvIndex, canonicalEcosystem, TRACKED_ECOSYSTEMS } from "./osv.js";
import { Syncer } from "./syncer.js";
import { registrySignals } from "./registry.js";
import { parseLockfile, SUPPORTED_FORMATS } from "./parsers.js";
import { fetchManifest, formatFromFilename, ALLOWED_HOSTS } from "./fetcher.js";
import { scan } from "./scan.js";

const SCHEMA_VERSION = "1";
const SOURCES = ["osv.dev", "ossf/malicious-packages"];
const OPENAPI = readFileSync(new URL("./openapi.json", import.meta.url));

const index = new OsvIndex(config.dataDir, config.snapshotName);
const syncer = new Syncer(index);

// Gateways (SAGE) scan the first 2 KB of a body, raw and case-insensitive, for
// these phrases and treat a match as a failed relay, even inside a JSON string.
// Advisory summaries from OSV are upstream text and some contain them ("timeout
// bypass in vm2"), so every occurrence is broken by writing one letter as a JSON
// \u escape: the client decodes the identical string, the scan no longer
// matches. See the Skill's references/design-rules.md, rule 6.
const GATEWAY_PHRASES = [
  "offchain rate limit hit by relayer proxy", "session relay limit reached", "claimable portion fully consumed",
  "missing trie node", "node is unhealthy", "block not found", "header not found", "state not available",
  "pruned state", "metadata is not found", "historical state", "state has been pruned", "block has been pruned",
  "is pruned", "height is not available", "lowest height is", "haven't been fully indexed", "not been fully indexed",
  "lite fullnode", "api is not supported", "excluded from account secondary indexes",
  "connection refused", "connection reset", "timeout", "bad gateway", "service unavailable", "gateway timeout",
];
const PHRASE_RES = GATEWAY_PHRASES.map((p) => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"));

// Only ever applied to JSON.stringify output, where these phrases can occur only
// inside string values (no key or literal contains one), so the escape is valid.
export function escapeGatewayPhrases(json) {
  let out = json;
  for (const re of PHRASE_RES) {
    out = out.replace(re, (m) => m[0] + "\\u" + m.charCodeAt(1).toString(16).padStart(4, "0") + m.slice(2));
  }
  return out;
}

function sendJson(res, status, payload) {
  const body = Buffer.from(escapeGatewayPhrases(JSON.stringify(payload)));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, message, details) {
  const error = details ? { code, message, details } : { code, message };
  sendJson(res, status, { service: config.service, schema_version: SCHEMA_VERSION, error });
}

// Every fetch failure is a 4xx: the link is the caller's input, and a 5xx would
// leave the relay unpaid and penalise the supplier for someone else's file.
const FETCH_ERROR_STATUS = {
  url_not_allowed: 400,
  url_fetch_disabled: 400,
  source_not_found: 422,
  source_unavailable: 422,
  source_deadline: 422,
  source_too_large: 413,
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    // The RelayMiner forwards bodies with Transfer-Encoding: chunked and no
    // Content-Length, so the size is only known as the stream arrives.
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("body too large"), { code: "body_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const ready = () => index.size > 0;

// Validate and normalize the request into a component list plus request meta.
// A lockfile arrives either pasted (lockfile.content) or linked (lockfile.url).
async function buildRequest(parsed, fetchLinked = fetchManifest) {
  const errors = [];
  let components = [];
  let unresolved = [];
  let format = null;
  let ecosystems;
  let source = null;

  if (parsed.lockfile && typeof parsed.lockfile === "object") {
    const { format: fmt, content, encoding, url } = parsed.lockfile;
    const hasContent = typeof content === "string" && content.length > 0;
    const hasUrl = typeof url === "string" && url.length > 0;
    if (hasContent && hasUrl) return { errors: ["send either lockfile.content or lockfile.url, not both"] };
    if (!hasContent && !hasUrl) return { errors: ["lockfile needs a url (a link to the file) or content (the file pasted as a string)"] };
    if (fmt !== undefined && typeof fmt !== "string") return { errors: ["lockfile.format must be a string"] };

    let text;
    let fileFormat = fmt;
    if (hasUrl) {
      if (!config.urlFetch) {
        return { errors: ["this supplier does not fetch links; send lockfile.content instead"], code: "url_fetch_disabled" };
      }
      let fetched;
      try {
        fetched = await fetchLinked(url, {
          maxBytes: config.urlMaxBytes,
          deadlineMs: config.urlFetchDeadlineMs,
          userAgent: config.service + "/" + config.version,
        });
      } catch (e) {
        return { errors: [e.message], code: e.code || "source_unavailable" };
      }
      text = fetched.content;
      source = { url: fetched.url, filename: fetched.filename };
      if (!fileFormat) fileFormat = formatFromFilename(fetched.filename);
      if (!fileFormat) {
        return { errors: ["cannot tell the format from the filename '" + fetched.filename + "'; set lockfile.format"], code: "unsupported_format" };
      }
    } else {
      if (!fileFormat) return { errors: ["lockfile.format is required with lockfile.content"] };
      text = content;
      if (encoding === "base64") {
        try {
          text = Buffer.from(content, "base64").toString("utf8");
        } catch {
          return { errors: ["lockfile.content is not valid base64"] };
        }
      }
    }
    let out;
    try {
      out = parseLockfile(fileFormat, text);
    } catch (e) {
      return { errors: [e.message], code: e.code };
    }
    format = fileFormat;
    components = out.components;
    unresolved = out.unresolved;
    ecosystems = [out.ecosystem];
  } else if (Array.isArray(parsed.components)) {
    const ecoSet = new Set();
    for (const c of parsed.components) {
      if (!c || typeof c !== "object" || !c.ecosystem || !c.name || c.version === undefined) {
        unresolved.push({ entry: JSON.stringify(c), reason: "component needs ecosystem, name, and version" });
        continue;
      }
      const eco = canonicalEcosystem(c.ecosystem);
      components.push({ ecosystem: eco || String(c.ecosystem), name: String(c.name), version: String(c.version) });
      if (eco) ecoSet.add(eco);
    }
    ecosystems = [...ecoSet];
  } else if (typeof parsed.url === "string") {
    errors.push("put the link inside the lockfile object: {\"lockfile\": {\"url\": \"...\"}}");
  } else {
    errors.push("provide either a lockfile object (url or content) or a components array");
  }

  if (!errors.length && components.length > config.maxComponents) {
    errors.push("too many components (" + components.length + " > " + config.maxComponents + "); split the manifest across relays");
  }
  return { errors, components, unresolved, format, ecosystems, source };
}

function parseOptions(raw) {
  const errors = [];
  const o = raw && typeof raw === "object" ? raw : {};
  let since = null;
  if (o.since !== undefined && o.since !== null) {
    const t = Date.parse(o.since);
    if (!Number.isFinite(t)) errors.push("since must be an ISO-8601 timestamp");
    else since = new Date(t).toISOString();
  }
  let categories = ["malicious", "vulnerable", "suspicious"];
  if (o.categories !== undefined) {
    if (!Array.isArray(o.categories)) errors.push("categories must be an array");
    else categories = o.categories.map(String);
  }
  return {
    errors,
    since,
    categories,
    minSeverity: o.min_severity ? String(o.min_severity) : "unknown",
    heuristics: o.heuristics === true && config.heuristicsEnabled,
    includeClean: o.include_clean === undefined ? config.includeCleanDefault : o.include_clean === true,
  };
}

async function handleScan(res, parsed) {
  const req = await buildRequest(parsed);
  if (req.errors && req.errors.length) {
    sendError(res, FETCH_ERROR_STATUS[req.code] || 400, req.code || "invalid_request", req.errors.join("; "));
    return;
  }
  // Nothing scannable is the caller's problem to see, not a successful result:
  // a 200 with zero components reads as "all clean" and is billed as a delivery.
  if (!req.components.length) {
    const why = req.unresolved.length
      ? "no pinned package versions in the input; " + req.unresolved.length + " entries could not be scanned (see details)"
      : "no packages found in the input";
    sendError(res, 400, "nothing_to_scan", why, { unresolved: req.unresolved.slice(0, 50), unresolved_total: req.unresolved.length });
    return;
  }
  const opts = parseOptions(parsed.options);
  if (opts.errors.length) {
    sendError(res, 400, "invalid_request", opts.errors.join("; "));
    return;
  }

  const useRegistry = opts.heuristics && config.registryLookups;
  const result = await scan(index, req.components, {
    since: opts.since,
    minSeverity: opts.minSeverity,
    categories: opts.categories,
    heuristics: opts.heuristics,
    includeClean: opts.includeClean,
    registry: useRegistry ? registrySignals : null,
    registryDeadlineMs: config.registryDeadlineMs,
    recencyDays: config.recencyDays,
    maxRegistryLookups: config.maxRegistryLookups,
  });

  sendJson(res, 200, {
    service: config.service,
    schema_version: SCHEMA_VERSION,
    data_as_of: index.asOf,
    sources: SOURCES,
    request: {
      format: req.format,
      source: req.source,
      ecosystems: req.ecosystems,
      components_scanned: result.components_scanned,
      mode: result.mode,
      heuristics: opts.heuristics,
    },
    summary: result.summary,
    findings: result.findings,
    unresolved: [...req.unresolved, ...result.unresolved],
  });
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  try {
    if (path === "/" && (method === "GET" || method === "HEAD")) {
      // The RelayMiner treats anything but a 2xx here as an unreachable backend
      // and refuses to start, so this stays cheap and always available.
      sendJson(res, 200, { service: config.service, status: "ok" });
      return;
    }

    if (path === "/healthz" && method === "GET") {
      if (!ready()) {
        sendJson(res, 503, { status: "warming", service: config.service });
        return;
      }
      sendJson(res, 200, { status: "ok", service: config.service, data_as_of: index.asOf, entries: index.size });
      return;
    }

    if (path === "/v1/version" && method === "GET") {
      sendJson(res, 200, { service: config.service, version: config.version, schema_version: SCHEMA_VERSION, sources: SOURCES });
      return;
    }

    if (path === "/v1/capabilities" && method === "GET") {
      sendJson(res, 200, {
        service: config.service,
        version: config.version,
        schema_version: SCHEMA_VERSION,
        sources: SOURCES,
        data_as_of: index.asOf,
        ecosystems: TRACKED_ECOSYSTEMS,
        formats: SUPPORTED_FORMATS,
        limits: {
          max_body_bytes: config.maxBodyBytes,
          max_components: config.maxComponents,
        },
        url: {
          enabled: config.urlFetch,
          hosts: ALLOWED_HOSTS,
          max_bytes: config.urlMaxBytes,
          deadline_ms: config.urlFetchDeadlineMs,
        },
        heuristics: {
          enabled: config.heuristicsEnabled,
          registry_lookups: config.registryLookups,
          signals: ["typosquat"].concat(config.registryLookups ? ["install_script", "recent_publish"] : []),
        },
        sync: {
          interval_seconds: Math.round(config.syncIntervalMs / 1000),
          last_sync_at: syncer.stats.last_sync_at,
          last_sync_ok: syncer.stats.last_sync_ok,
          note: syncer.stats.note,
          ecosystems: syncer.stats.ecosystems,
          entries: index.size,
          keys: index.keys,
          ready: ready(),
        },
      });
      return;
    }

    if (path === "/v1/openapi.json" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": OPENAPI.length });
      res.end(OPENAPI);
      return;
    }

    if (path === "/v1/scan") {
      if (method !== "POST") {
        sendError(res, 405, "method_not_allowed", "Use POST with a JSON body.");
        return;
      }
      if (!ready()) {
        sendError(res, 503, "warming", "The OSV snapshot is not loaded yet.");
        return;
      }
      let raw;
      try {
        raw = await readBody(req, config.maxBodyBytes);
      } catch (err) {
        if (err && err.code === "body_too_large") {
          sendError(res, 413, "body_too_large", "Request body exceeds " + config.maxBodyBytes + " bytes.");
          return;
        }
        sendError(res, 400, "invalid_request", "Could not read the request body.");
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        sendError(res, 400, "invalid_json", "Request body must be a JSON object.");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendError(res, 400, "invalid_request", "Request body must be a JSON object.");
        return;
      }
      await handleScan(res, parsed);
      return;
    }

    sendError(res, 404, "not_found", "No such path: " + path);
  } catch (err) {
    console.error(JSON.stringify({ msg: "request failed", path, error: String(err && err.message) }));
    // A 5xx marks the relay unpaid and penalises the supplier, so it is reserved
    // for a genuine backend fault.
    sendError(res, 500, "internal_error", "The backend could not complete this request.");
  }
});

async function main() {
  const loaded = await index.load();
  if (loaded && index.size > 0) {
    syncer.stats.ready = true;
    console.error(JSON.stringify({ msg: "snapshot restored", entries: index.size, keys: index.keys, as_of: index.asOf }));
  }
  syncer.start();
  server.listen(config.port, () => {
    console.log(
      JSON.stringify({
        msg: "listening",
        service: config.service,
        version: config.version,
        port: config.port,
        ecosystems: config.ecosystems,
        entries_restored: index.size,
        sync_on_start: config.syncOnStart,
      })
    );
  });
}

const isEntryPoint = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      syncer.stop();
      server.close(() => process.exit(0));
    });
  }
  main().catch((err) => {
    console.error(JSON.stringify({ msg: "startup failed", error: String(err && err.stack) }));
    process.exit(1);
  });
}

export { server, buildRequest, parseOptions, main };
