// Fetch a manifest from a link the caller supplies (lockfile.url).
//
// This is NOT a general fetcher. A link is accepted only when it points at a
// file on a public code host on the allowlist below; anything else is refused
// before a socket is opened. The checks, in order:
//
//   1. https only, default port, no credentials in the URL.
//   2. The host must be on the allowlist. A "blob" page link (github.com,
//      gitlab.com, bitbucket.org) is rewritten to the host's raw-file URL, so
//      the caller can paste the address they see in the browser.
//   3. DNS is resolved here and every address used must be public; the
//      connection is pinned to the vetted address (the `lookup` hook), so a
//      hostname that re-resolves to a private address between the check and the
//      connect (DNS rebinding) cannot reach the private network.
//   4. Redirects are followed only to another allowlisted URL, re-checked from
//      step 1, at most MAX_REDIRECTS times.
//   5. The response is capped in size and time, and an HTML page is refused.
//
// No caller header, cookie, or credential is ever forwarded upstream.

import https from "node:https";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;

// Hosts whose files may be fetched, each with the path shape that is a raw file.
// A link on a page host is rewritten to its raw form first (rewriteToRaw).
const RAW_HOSTS = {
  "raw.githubusercontent.com": (p) => p.split("/").length >= 5, // /owner/repo/ref/path
  "gist.githubusercontent.com": (p) => p.includes("/raw/"),
  "gitlab.com": (p) => p.includes("/-/raw/"),
  "bitbucket.org": (p) => /^\/[^/]+\/[^/]+\/raw\//.test(p),
};

export const ALLOWED_HOSTS = ["github.com", ...Object.keys(RAW_HOSTS)];

// The filename decides the format when the caller does not name one.
const FILENAME_FORMATS = {
  "package.json": "package.json",
  "package-lock.json": "package-lock.json",
  "npm-shrinkwrap.json": "package-lock.json",
  "pnpm-lock.yaml": "pnpm-lock.yaml",
  "yarn.lock": "yarn.lock",
  "requirements.txt": "requirements.txt",
  "poetry.lock": "poetry.lock",
  "uv.lock": "uv.lock",
  "pipfile.lock": "pipfile.lock",
  "cargo.lock": "cargo.lock",
  "go.sum": "go.sum",
};

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

export function formatFromFilename(filename) {
  const name = String(filename || "").toLowerCase();
  if (FILENAME_FORMATS[name]) return FILENAME_FORMATS[name];
  // requirements-dev.txt, requirements.prod.txt and the like
  if (/^requirements[\w.-]*\.txt$/.test(name)) return "requirements.txt";
  return null;
}

// Rewrite a browser link to the raw file it shows. Returns a URL object.
function rewriteToRaw(u) {
  const parts = u.pathname.split("/");
  if (u.hostname === "github.com") {
    // /owner/repo/blob/ref/path  or  /owner/repo/raw/ref/path
    if (parts.length >= 6 && (parts[3] === "blob" || parts[3] === "raw")) {
      const raw = new URL("https://raw.githubusercontent.com/");
      raw.pathname = [parts[1], parts[2], ...parts.slice(4)].join("/");
      return raw;
    }
    throw fail("url_not_allowed", "a github.com link must point at a file (.../blob/<ref>/<path>)");
  }
  if (u.hostname === "gitlab.com" && u.pathname.includes("/-/blob/")) {
    const raw = new URL(u.href);
    raw.pathname = u.pathname.replace("/-/blob/", "/-/raw/");
    return raw;
  }
  if (u.hostname === "bitbucket.org" && /^\/[^/]+\/[^/]+\/src\//.test(u.pathname)) {
    const raw = new URL(u.href);
    raw.pathname = u.pathname.replace(/^(\/[^/]+\/[^/]+)\/src\//, "$1/raw/");
    return raw;
  }
  return u;
}

// Validate a caller-supplied link and turn it into the raw URL to fetch.
export function resolveSourceUrl(input) {
  let u;
  try {
    u = new URL(String(input));
  } catch {
    throw fail("url_not_allowed", "lockfile.url is not a valid URL");
  }
  if (u.protocol !== "https:") throw fail("url_not_allowed", "lockfile.url must use https");
  if (u.username || u.password) throw fail("url_not_allowed", "lockfile.url must not carry credentials");
  if (u.port && u.port !== "443") throw fail("url_not_allowed", "lockfile.url must use the default https port");
  u.hash = "";
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.includes(host)) {
    throw fail("url_not_allowed", "lockfile.url host must be one of: " + ALLOWED_HOSTS.join(", "));
  }
  const raw = rewriteToRaw(u);
  const check = RAW_HOSTS[raw.hostname];
  if (!check || !check(raw.pathname)) {
    throw fail("url_not_allowed", "lockfile.url must point at a single file on " + raw.hostname);
  }
  let filename = raw.pathname.split("/").pop() || "";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // keep the encoded name; it only feeds format inference
  }
  return { url: raw.href, host: raw.hostname, filename };
}

// --- address checks ----------------------------------------------------------

function v4ToInt(ip) {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}

const V4_BLOCKED = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
].map(([base, bits]) => [v4ToInt(base), (~0 << (32 - bits)) >>> 0]);

function isPublicV4(ip) {
  const n = v4ToInt(ip);
  return !V4_BLOCKED.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

// Expand an IPv6 address to its eight 16-bit groups.
function v6Groups(ip) {
  let s = ip.toLowerCase().split("%")[0];
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = v4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + (n >>> 16).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const hasGap = s.includes("::");
  const [head, tail] = hasGap ? s.split("::") : [s, ""];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = hasGap ? Array(Math.max(0, 8 - h.length - t.length)).fill("0") : [];
  return [...h, ...fill, ...t].map((g) => parseInt(g || "0", 16));
}

function isPublicV6(ip) {
  const g = v6Groups(ip);
  if (g.length !== 8 || g.some((x) => !Number.isFinite(x))) return false;
  const embeddedV4 = () => [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join(".");
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(embeddedV4()); // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(embeddedV4()); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((g[0] & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard-only
  return true;
}

export function isPublicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) return isPublicV4(ip);
  if (v === 6) return isPublicV6(ip);
  return false;
}

// A dns lookup that only ever hands the socket a public address. Node may call
// it with options.all (happy eyeballs), so both callback shapes are honoured.
export function publicLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    const ok = addresses.filter((a) => isPublicAddress(a.address));
    if (!ok.length) {
      return callback(fail("url_not_allowed", hostname + " does not resolve to a public address"));
    }
    if (options && options.all) return callback(null, ok);
    callback(null, ok[0].address, ok[0].family);
  });
}

// --- fetch ---------------------------------------------------------------------

function getOnce(url, { maxBytes, deadlineAt, userAgent }) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return reject(fail("source_deadline", "the link did not answer in time"));
    let settled = false;
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const req = https.get(
      url,
      {
        lookup: publicLookup,
        headers: { "User-Agent": userAgent, Accept: "*/*", "Accept-Encoding": "identity" },
      },
      (res) => {
        const status = res.statusCode || 0;
        const stop = (err) => {
          res.destroy();
          done(reject, err);
        };
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return done(resolve, { redirect: new URL(res.headers.location, url).href });
        }
        if (status === 404 || status === 410) {
          return stop(fail("source_not_found", "the link returned HTTP " + status + "; check the path and that the repository is public"));
        }
        if (status === 401 || status === 403) {
          return stop(fail("source_not_found", "the link returned HTTP " + status + "; only public files can be fetched"));
        }
        if (status < 200 || status >= 300) {
          return stop(fail("source_unavailable", "the link returned HTTP " + status));
        }
        const declared = Number(res.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBytes) {
          return stop(fail("source_too_large", "the linked file is larger than " + maxBytes + " bytes"));
        }
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > maxBytes) return stop(fail("source_too_large", "the linked file is larger than " + maxBytes + " bytes"));
          chunks.push(c);
        });
        res.on("end", () => done(resolve, { body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", (e) => done(reject, fail("source_unavailable", "the link could not be read: " + e.message)));
      }
    );
    // One deadline for the whole exchange: connect, headers and body.
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, fail("source_deadline", "the link did not answer in time"));
    }, remaining);
    req.on("error", (e) => {
      if (e && e.code === "url_not_allowed") return done(reject, e);
      done(reject, fail("source_unavailable", "the link could not be fetched (" + (e && e.code ? e.code : "network error") + ")"));
    });
  });
}

// Fetch the manifest a caller linked to. Returns { content, url, filename }.
export async function fetchManifest(input, { maxBytes, deadlineMs, userAgent }) {
  let target = resolveSourceUrl(input);
  const deadlineAt = Date.now() + deadlineMs;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const out = await getOnce(target.url, { maxBytes, deadlineAt, userAgent });
    if (out.redirect) {
      if (hop === MAX_REDIRECTS) break;
      target = resolveSourceUrl(out.redirect); // re-checked against the allowlist
      continue;
    }
    if (/^\s*<(!doctype|html)/i.test(out.body)) {
      throw fail("source_unavailable", "the link returned an HTML page, not the raw file");
    }
    return { content: out.body, url: target.url, filename: target.filename };
  }
  throw fail("source_unavailable", "the link redirected too many times");
}
